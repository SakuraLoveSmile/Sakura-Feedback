import { Hono } from "hono";
import type { RateLimiter } from "../auth/ratelimit.ts";
import type { AppSourceKind, Db, FeedbackStatus, LogInput, SessionRow } from "../db/repos.ts";
import {
  collectionStateForFeedback,
  contentHash,
  getDeletionReceiptByFeedbackId,
  getFeedback,
  getFeedbackScreenshot,
  insertFeedbackAudit,
  NATIVE_SOURCE,
  submitFeedbackAtomic,
} from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import {
  checkLimiter,
  type Err,
  err,
  fail,
  isErr,
  normalizeRequestOrigin,
  readJson,
  requireAdminCookie,
  requireSession,
  sessionUser,
} from "../http.ts";
import type { Worker, WorkerOpResult } from "../pipeline/worker.ts";
import { ImageValidationError, type SanitizedImage, validateAndSanitizePng } from "../services/image.ts";
import { LogValidationError, type RawLogPart, validateAllLogs } from "../services/log-validator.ts";
import { publicUser } from "./auth.ts";

const MAX_TEXT_CODEPOINTS = 10_000;
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024; // 10MiB

export interface FeedbackDeps {
  db: Db;
  config: ServerConfig;
  worker: Worker;
  submitLimiter: RateLimiter;
  /** 可控时钟（测试注入；默认系统时钟）。 */
  now?: () => number;
}

function textCodepointLen(s: string): number {
  return Array.from(s).length;
}

function publicStatus(
  db: Db,
  row: {
    id: string;
    status: FeedbackStatus;
    created_at: string;
    updated_at: string;
    error_summary: string | null;
    kaneo_task_url: string | null;
  },
) {
  const full = getFeedback(db, row.id);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorSummary: row.error_summary,
    kaneoUrl: row.kaneo_task_url,
    // T4：等待配置 / 等待来源确认 / 等待人工归档 / 已排队。
    // 旧组件忽略该字段即可；新版组件据此显示“已保存，等待…”而不是提交失败。
    ...(full ? { collectionState: collectionStateForFeedback(db, full) } : {}),
  };
}

/**
 * 解析服务端**观察到**的来源（T1/T2）：
 * 浏览器取请求 Origin（规范化）；无 Origin 的原生客户端记为 `native` 单独确认。
 * 非法 Origin 直接拒绝——来源登记必须是可信值，绝不落库客户端自报的字符串。
 */
function observedSource(originHeader: string | undefined): { origin: string; kind: AppSourceKind } | Err {
  if (originHeader === undefined || originHeader === "") {
    return { origin: NATIVE_SOURCE, kind: "native" };
  }
  const normalized = normalizeRequestOrigin(originHeader);
  if (!normalized) return err("origin_not_allowed", "来源不合法", 400);
  return { origin: normalized, kind: "browser" };
}

/** 可选的组件上报名称：仅做长度与类型校验，不影响管理员已设置的名称。 */
function parseAppName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().slice(0, 100);
  return t === "" ? null : t;
}

export function feedbackRoutes(deps: FeedbackDeps): Hono {
  const { db, config, worker } = deps;
  const routes = new Hono();

  routes.post("/", async (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const limited = checkLimiter(deps.submitLimiter, session.id);
    if (limited) {
      c.header("retry-after", String((limited as typeof limited & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }

    const contentType = c.req.header("content-type") ?? "";
    let idempotencyKey = "";
    let appId = "";
    let appNameInput: unknown = null;
    let text = "";
    let contextInput: unknown = null;
    let captureInput: unknown = null;
    let screenshotBuffer: Buffer | null = null;
    const rawLogParts: RawLogPart[] = [];
    let logsDescRaw: unknown;

    if (contentType.includes("multipart/form-data")) {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_MULTIPART_BYTES) {
        return fail(c, err("too_large", "请求体超过 10MiB 上限", 413));
      }

      const reader = c.req.raw.body?.getReader();
      if (!reader) return fail(c, err("invalid_request", "无法读取请求体", 400));
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_MULTIPART_BYTES) {
          return fail(c, err("too_large", "请求体超过 10MiB 上限", 413));
        }
        chunks.push(value);
      }
      const fullBody = Buffer.concat(chunks);
      let formData: FormData;
      try {
        const fakeReq = new Request(c.req.url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: fullBody,
        });
        formData = await fakeReq.formData();
      } catch (errObj) {
        return fail(c, err("invalid_request", `无法解析 multipart 表单: ${(errObj as Error).message}`, 400));
      }

      const metaRaw = formData.get("metadata");
      if (typeof metaRaw !== "string" || !metaRaw.trim()) {
        return fail(c, err("invalid_request", "缺少 metadata 字段", 400));
      }
      let metaParsed: Record<string, unknown>;
      try {
        metaParsed = JSON.parse(metaRaw);
      } catch {
        return fail(c, err("invalid_request", "metadata 不是有效 JSON", 400));
      }

      idempotencyKey = typeof metaParsed.idempotencyKey === "string" ? metaParsed.idempotencyKey.trim() : "";
      appId = typeof metaParsed.appId === "string" ? metaParsed.appId.trim() : "";
      appNameInput = metaParsed.appName;
      text = typeof metaParsed.text === "string" ? metaParsed.text : "";
      contextInput = metaParsed.context;
      captureInput = metaParsed.capture;
      logsDescRaw = metaParsed.logs;

      const fileField = formData.get("screenshot");
      if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField) {
        const ab = await (fileField as Blob).arrayBuffer();
        if (ab.byteLength > 0) {
          screenshotBuffer = Buffer.from(ab);
        }
      }

      const logEntries = formData.getAll("logs");
      for (const entry of logEntries) {
        if (entry && typeof entry === "object" && "arrayBuffer" in entry) {
          const ab = await (entry as Blob).arrayBuffer();
          const filename = (entry as { name?: string }).name;
          rawLogParts.push({ bytes: Buffer.from(ab), filename });
        }
      }
    } else {
      const body = await readJson<{
        idempotencyKey?: unknown;
        appId?: unknown;
        appName?: unknown;
        text?: unknown;
        context?: unknown;
        logs?: unknown;
      }>(c);
      if (isErr(body)) return fail(c, body);
      if (body.logs !== undefined) {
        return fail(c, err("invalid_request", "日志附件必须通过 multipart 表单上传", 400));
      }

      idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      appId = typeof body.appId === "string" ? body.appId.trim() : "";
      appNameInput = body.appName;
      text = typeof body.text === "string" ? body.text : "";
      contextInput = body.context;
    }

    if (!idempotencyKey || idempotencyKey.length > 200) {
      return fail(c, err("invalid_request", "缺少或非法的 idempotencyKey", 400));
    }
    if (!appId || appId.length > 100) {
      return fail(c, err("invalid_request", "缺少或非法的 appId", 400));
    }
    if (text.trim() === "") return fail(c, err("invalid_request", "反馈内容不能为空", 400));
    if (textCodepointLen(text) > MAX_TEXT_CODEPOINTS) {
      return fail(c, err("too_large", `反馈文字超过 ${MAX_TEXT_CODEPOINTS} 字符上限`, 413));
    }

    // 上下文只接受显式白名单字段，值做长度截停
    let context: { appVersion?: string; pageLabel?: string } | null = null;
    if (typeof contextInput === "object" && contextInput !== null) {
      const ctx = contextInput as Record<string, unknown>;
      const appVersion = typeof ctx.appVersion === "string" ? ctx.appVersion.trim().slice(0, 50) : "";
      const pageLabel = typeof ctx.pageLabel === "string" ? ctx.pageLabel.trim().slice(0, 200) : "";
      if (appVersion || pageLabel)
        context = { ...(appVersion ? { appVersion } : {}), ...(pageLabel ? { pageLabel } : {}) };
    }

    // 截图捕获元数据（线格式已定稿：viewportWidth/Height=逻辑 CSS 像素，pixelWidth/Height=最终 PNG 输出像素）
    let capture: {
      viewportWidth?: number;
      viewportHeight?: number;
      capturedAt?: string;
      releasePoint?: { x: number; y: number };
      pixelWidth?: number;
      pixelHeight?: number;
    } | null = null;
    if (typeof captureInput === "object" && captureInput !== null) {
      const cap = captureInput as Record<string, unknown>;
      const vw = typeof cap.viewportWidth === "number" ? cap.viewportWidth : undefined;
      const vh = typeof cap.viewportHeight === "number" ? cap.viewportHeight : undefined;
      const cat = typeof cap.capturedAt === "string" ? cap.capturedAt.slice(0, 50) : undefined;
      let rp: { x: number; y: number } | undefined;
      if (typeof cap.releasePoint === "object" && cap.releasePoint !== null) {
        const p = cap.releasePoint as Record<string, unknown>;
        if (typeof p.x === "number" && typeof p.y === "number") {
          rp = { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) };
        }
      }
      // 输出像素尺寸：可选；成对出现且必须为 1..65535 整数；绝不静默丢弃非法值
      const pw = cap.pixelWidth;
      const ph = cap.pixelHeight;
      const validPixel = (v: unknown): v is number =>
        typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
      const pixelPair = pw !== undefined || ph !== undefined;
      if (pixelPair && (!validPixel(pw) || !validPixel(ph))) {
        return fail(c, err("invalid_request", "capture.pixelWidth/pixelHeight 必须是 1..65535 的整数", 400));
      }
      if (vw !== undefined || vh !== undefined || cat !== undefined || rp !== undefined || pixelPair) {
        capture = {
          viewportWidth: vw,
          viewportHeight: vh,
          capturedAt: cat,
          releasePoint: rp,
          ...(pixelPair ? { pixelWidth: pw as number, pixelHeight: ph as number } : {}),
        };
      }
    }

    let sanitizedImage: SanitizedImage | null = null;
    if (screenshotBuffer) {
      try {
        sanitizedImage = await validateAndSanitizePng(screenshotBuffer);
      } catch (errObj) {
        if (errObj instanceof ImageValidationError) {
          const status = errObj.code === "too_large" ? 413 : 400;
          return fail(c, err(errObj.code, errObj.message, status));
        }
        return fail(c, err("invalid_image", (errObj as Error).message, 400));
      }
    }

    let validatedLogs: LogInput[] = [];
    try {
      validatedLogs = validateAllLogs(rawLogParts, logsDescRaw);
    } catch (errObj) {
      if (errObj instanceof LogValidationError) {
        return fail(c, err(errObj.code, errObj.message, errObj.status));
      }
      return fail(c, err("invalid_log", (errObj as Error).message, 400));
    }

    // T1：不再要求软件已登记 —— 服务端按本次观察到的来源记录，软件在事务内按需自动发现。
    const source = observedSource(c.req.header("origin"));
    if (isErr(source)) return fail(c, source);

    const hash = contentHash(
      appId,
      text,
      context,
      sanitizedImage ? { sha256: sanitizedImage.sha256, releasePoint: capture?.releasePoint } : null,
      validatedLogs.length > 0 ? validatedLogs : null,
    );

    const outcome = submitFeedbackAtomic(
      db,
      {
        userId: user.id,
        appId,
        appName: parseAppName(appNameInput),
        sourceOrigin: source.origin,
        sourceKind: source.kind,
        text,
        contextJson: context ? JSON.stringify(context) : null,
        idempotencyKey,
        contentHash: hash,
      },
      sanitizedImage
        ? {
            pngBlob: sanitizedImage.sanitizedBuffer,
            width: sanitizedImage.width,
            height: sanitizedImage.height,
            byteSize: sanitizedImage.byteSize,
            sha256: sanitizedImage.sha256,
            captureJson: capture ? JSON.stringify(capture) : null,
          }
        : null,
      validatedLogs.length > 0 ? validatedLogs : null,
      deps.now,
    );

    if (outcome.kind === "conflict") {
      return fail(c, err("idempotency_conflict", "同一提交标识对应了不同内容", 409));
    }
    if (outcome.kind === "account_invalid") {
      return fail(c, err("unauthorized", "账号不可用，请重新登录", 401));
    }
    if (outcome.kind === "quota_exceeded") {
      // 明确「未接收」：不扣次数、不保存；同结构额度随 429 返回。
      return c.json(
        { error: { code: "daily_quota_exceeded", message: "今日提交次数已用完" }, quota: outcome.quota },
        429,
      );
    }
    if (outcome.kind === "purged") {
      // 提交键属于一条已彻底删除的反馈：键永久作废，不扣次数、不新建记录。
      return fail(c, err("feedback_purged", "该提交已被彻底删除；如需重新提交请使用新的提交标识", 410));
    }
    if (outcome.kind === "replayed") {
      const replayed = getFeedback(db, outcome.row.id) ?? outcome.row;
      return c.json({
        feedbackId: outcome.row.id,
        status: outcome.row.status,
        replayed: true,
        user: publicUser(user),
        quota: outcome.quota,
        collectionState: collectionStateForFeedback(db, replayed),
      });
    }

    worker.enqueue(outcome.row.id); // 先持久化已接收，再后台处理
    return c.json(
      {
        feedbackId: outcome.row.id,
        status: "received",
        user: publicUser(user),
        quota: outcome.quota,
        // T4：提交成功即明确告知“已接收 / 等待什么”，组件据此提示而不是显示失败。
        collectionState: collectionStateForFeedback(db, outcome.row),
      },
      201,
    );
  });

  routes.get("/:id", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    if (!row) {
      // 已彻底删除：所属用户（或管理员）得到明确 410；其他人统一 404 不透露存在性。
      const receipt = getDeletionReceiptByFeedbackId(db, c.req.param("id"));
      if (receipt && (receipt.user_id === user.id || user.role === "admin")) {
        return fail(c, err("feedback_purged", "该反馈已被彻底删除", 410));
      }
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    // 普通账号只能读取自己的记录；他人记录统一 404（不透露存在性）。
    if (user.role !== "admin" && row.user_id !== user.id) {
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    return c.json(publicStatus(db, row));
  });

  routes.get("/:id/screenshot", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    if (!row || (user.role !== "admin" && row.user_id !== user.id)) {
      return fail(c, err("not_found", "截图不存在", 404));
    }
    const screenshot = getFeedbackScreenshot(db, row.id);
    if (!screenshot) return fail(c, err("not_found", "截图不存在", 404));
    return new Response(screenshot.png_blob as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-length": String(screenshot.byte_size),
      },
    });
  });

  // —— 管理操作：仅管理员 Cookie 会话 + 同源 ——
  const cookieGuard = (c: Parameters<typeof requireSession>[1]): SessionRow | Response => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    return s;
  };

  /** 人工恢复动作的操作审计（T2：持久化审计记录，详情页可查看）。 */
  function auditAction(session: SessionRow, feedbackId: string, action: string, detail?: Record<string, unknown>) {
    const user = sessionUser(db, session);
    if (!user) return;
    try {
      insertFeedbackAudit(db, {
        feedbackId,
        actor: { id: user.id, username: user.username },
        action,
        ...(detail ? { detail } : {}),
      });
    } catch {
      /* 审计写入失败不影响恢复动作本身 */
    }
  }

  /** 解析可选的 expectedRevision（≥0 整数；缺省不校验，兼容旧管理页）。 */
  function parseExpectedRevision(v: unknown): number | undefined | Err {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return err("invalid_request", "expectedRevision 必须是 ≥0 的整数", 400);
    }
    return v;
  }

  /** 将 worker 操作结果映射为 HTTP 响应。 */
  function opResponse(c: Parameters<typeof fail>[0], r: WorkerOpResult): Response {
    if (r.ok)
      return c.json(
        {
          ok: true,
          status: r.status,
          revision: r.revision,
          ...(r.replaced !== undefined ? { replaced: r.replaced } : {}),
          ...(r.note ? { note: r.note } : {}),
        },
        202,
      );
    if (r.reason === "not_found") return fail(c, err("not_found", "反馈不存在", 404));
    if (r.reason === "busy") return fail(c, err("busy", "该反馈正在被其他操作处理，请稍后重试", 409));
    if (r.reason === "revision_conflict") {
      return fail(c, err("revision_conflict", "页面数据已过期（revision 冲突），请刷新后重试", 409));
    }
    if (r.reason === "persist_failed") return fail(c, err("persist_failed", "本地状态写入失败，已停止后续操作", 502));
    if (r.reason === "target_changed") {
      return fail(
        c,
        err(
          "target_changed",
          `归档目标与当前 Kaneo 配置不一致，已停止远端操作且未改动恢复数据。请先改回原目标或人工处理该记录。${r.note ? `（${r.note}）` : ""}`,
          409,
        ),
      );
    }
    return fail(
      c,
      err(
        "invalid_state",
        `当前状态不可执行该操作${r.note ? `（${r.note}）` : r.status ? `（${r.status}）` : ""}`,
        409,
      ),
    );
  }

  routes.post("/:id/retry", async (c) => {
    const g = cookieGuard(c);
    if (g instanceof Response) return g;
    const body = await readJson<{ expectedRevision?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const rev = parseExpectedRevision(body.expectedRevision);
    if (isErr(rev)) return fail(c, rev);
    const r = worker.retry(c.req.param("id"), rev);
    if (r.ok) auditAction(g, c.req.param("id"), "retry", { expectedRevision: rev ?? null });
    return opResponse(c, r);
  });

  routes.post("/:id/resolve", async (c) => {
    const g = cookieGuard(c);
    if (g instanceof Response) return g;
    const body = await readJson<{ action?: unknown; expectedRevision?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const action = body.action;
    const id = c.req.param("id");
    const rev = parseExpectedRevision(body.expectedRevision);
    if (isErr(rev)) return fail(c, rev);
    let r: WorkerOpResult;
    if (action === "recheck") {
      try {
        r = await worker.recheck(id, rev);
      } catch (errObj) {
        return fail(c, err("recheck_failed", `核对请求失败：${(errObj as Error).message.slice(0, 200)}`, 502));
      }
    } else if (action === "force-create") {
      r = await worker.forceCreate(id, rev);
    } else {
      return fail(c, err("invalid_request", 'action 必须为 "recheck" 或 "force-create"', 400));
    }
    if (r.ok) auditAction(g, id, action === "recheck" ? "recheck" : "force_create", { expectedRevision: rev ?? null });
    return opResponse(c, r);
  });

  // 4.4 恢复接口：针对图片/评论的分阶段人工恢复
  routes.post("/:id/recover", async (c) => {
    const g = cookieGuard(c);
    if (g instanceof Response) return g;
    const body = await readJson<{ action?: unknown; expectedRevision?: unknown; logId?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const id = c.req.param("id");
    const rev = parseExpectedRevision(body.expectedRevision);
    if (isErr(rev)) return fail(c, rev);
    if (rev === undefined) {
      return fail(c, err("invalid_request", "recover 操作必须携带 expectedRevision", 400));
    }
    let r: WorkerOpResult;
    try {
      if (body.action === "retry_comment") {
        r = await worker.recoverRetryComment(id, rev);
      } else if (body.action === "replace_upload") {
        r = await worker.recoverReplaceUpload(id, rev);
      } else if (body.action === "retry_log") {
        if (typeof body.logId !== "string" || !body.logId) {
          return fail(c, err("invalid_request", "retry_log 操作必须携带 logId", 400));
        }
        r = await worker.recoverRetryLog(id, rev, body.logId);
      } else {
        return fail(c, err("invalid_request", 'action 必须为 "retry_comment"、"replace_upload" 或 "retry_log"', 400));
      }
    } catch (errObj) {
      return fail(c, err("recover_failed", `恢复操作失败：${(errObj as Error).message.slice(0, 200)}`, 502));
    }
    if (r.ok) {
      auditAction(g, id, String(body.action), {
        expectedRevision: rev,
        ...(typeof body.logId === "string" ? { logId: body.logId } : {}),
      });
    }
    return opResponse(c, r);
  });

  return routes;
}
