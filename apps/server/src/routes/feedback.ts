import { Hono } from "hono";
import type { RateLimiter } from "../auth/ratelimit.ts";
import type { Db, FeedbackStatus, SessionRow } from "../db/repos.ts";
import { contentHash, getAppByAppId, getFeedback, getFeedbackScreenshot, submitFeedbackAtomic } from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import {
  checkLimiter,
  type Err,
  err,
  fail,
  isErr,
  readJson,
  requireAdminCookie,
  requireSession,
  sessionUser,
} from "../http.ts";
import type { Worker, WorkerOpResult } from "../pipeline/worker.ts";
import { ImageValidationError, type SanitizedImage, validateAndSanitizePng } from "../services/image.ts";
import { publicUser } from "./auth.ts";

const MAX_TEXT_CODEPOINTS = 10_000;
const MAX_MULTIPART_BYTES = 6 * 1024 * 1024; // 6MiB

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

function publicStatus(row: {
  id: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  error_summary: string | null;
  kaneo_task_url: string | null;
}) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorSummary: row.error_summary,
    kaneoUrl: row.kaneo_task_url,
  };
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
    let text = "";
    let contextInput: unknown = null;
    let captureInput: unknown = null;
    let screenshotBuffer: Buffer | null = null;

    if (contentType.includes("multipart/form-data")) {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_MULTIPART_BYTES) {
        return fail(c, err("too_large", "请求体超过 6MiB 上限", 413));
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
          return fail(c, err("too_large", "请求体超过 6MiB 上限", 413));
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
      text = typeof metaParsed.text === "string" ? metaParsed.text : "";
      contextInput = metaParsed.context;
      captureInput = metaParsed.capture;

      const fileField = formData.get("screenshot");
      if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField) {
        const ab = await (fileField as Blob).arrayBuffer();
        if (ab.byteLength > 0) {
          screenshotBuffer = Buffer.from(ab);
        }
      }
    } else {
      const body = await readJson<{
        idempotencyKey?: unknown;
        appId?: unknown;
        text?: unknown;
        context?: unknown;
      }>(c);
      if (isErr(body)) return fail(c, body);

      idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      appId = typeof body.appId === "string" ? body.appId.trim() : "";
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

    const app = getAppByAppId(db, appId);
    if (!app) return fail(c, err("unknown_app", "appId 未在服务端配置", 404));

    const hash = contentHash(
      appId,
      text,
      context,
      sanitizedImage ? { sha256: sanitizedImage.sha256, releasePoint: capture?.releasePoint } : null,
    );

    const outcome = submitFeedbackAtomic(
      db,
      {
        userId: user.id,
        appId: app.app_id,
        appRowId: app.id,
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
    if (outcome.kind === "replayed") {
      return c.json({
        feedbackId: outcome.row.id,
        status: outcome.row.status,
        replayed: true,
        user: publicUser(user),
        quota: outcome.quota,
      });
    }

    worker.enqueue(outcome.row.id); // 先持久化已接收，再后台处理
    return c.json(
      { feedbackId: outcome.row.id, status: "received", user: publicUser(user), quota: outcome.quota },
      201,
    );
  });

  routes.get("/:id", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    // 普通账号只能读取自己的记录；他人记录统一 404（不透露存在性）。
    if (!row || (user.role !== "admin" && row.user_id !== user.id)) {
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    return c.json(publicStatus(row));
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
    return opResponse(c, r);
  });

  // 4.4 恢复接口：针对图片/评论的分阶段人工恢复
  routes.post("/:id/recover", async (c) => {
    const g = cookieGuard(c);
    if (g instanceof Response) return g;
    const body = await readJson<{ action?: unknown; expectedRevision?: unknown }>(c);
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
      } else {
        return fail(c, err("invalid_request", 'action 必须为 "retry_comment" 或 "replace_upload"', 400));
      }
    } catch (errObj) {
      return fail(c, err("recover_failed", `恢复操作失败：${(errObj as Error).message.slice(0, 200)}`, 502));
    }
    return opResponse(c, r);
  });

  return routes;
}
