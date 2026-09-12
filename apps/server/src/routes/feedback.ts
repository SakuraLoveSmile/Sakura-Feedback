import { Hono } from "hono";
import type { RateLimiter } from "../auth/ratelimit.ts";
import type { Db, FeedbackLogInput, FeedbackRow, FeedbackStatus, SessionRow } from "../db/repos.ts";
import {
  contentHash,
  getAppByAppId,
  getFeedback,
  getFeedbackByKey,
  getFeedbackLog,
  getFeedbackScreenshot,
  insertFeedbackWithScreenshot,
} from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import { checkLimiter, checkSameOrigin, type Err, err, fail, isErr, readJson, requireSession } from "../http.ts";
import type { Worker, WorkerOpResult } from "../pipeline/worker.ts";
import { ImageValidationError, type SanitizedImage, validateAndSanitizePng } from "../services/image.ts";
import { type LogPart, LogValidationError, validateLogAttachments } from "../services/logs.ts";

const MAX_TEXT_CODEPOINTS = 10_000;
/** 请求体上限：截图 5MiB + 3 份日志各 1MiB + 表单开销，留出余量到 9MiB。 */
const MAX_MULTIPART_BYTES = 9 * 1024 * 1024; // 9MiB

export interface FeedbackDeps {
  db: Db;
  config: ServerConfig;
  worker: Worker;
  submitLimiter: RateLimiter;
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
    let logsMetaInput: unknown = null;
    let screenshotBuffer: Buffer | null = null;
    let logParts: LogPart[] = [];

    if (contentType.includes("multipart/form-data")) {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_MULTIPART_BYTES) {
        return fail(c, err("too_large", "请求体超过 9MiB 上限", 413));
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
          return fail(c, err("too_large", "请求体超过 9MiB 上限", 413));
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
      logsMetaInput = metaParsed.logs;

      const fileField = formData.get("screenshot");
      if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField) {
        const ab = await (fileField as Blob).arrayBuffer();
        if (ab.byteLength > 0) {
          screenshotBuffer = Buffer.from(ab);
        }
      }

      // 重复的 `logs` 部件按出现顺序收集（getAll 保留插入顺序），与 metadata.logs 下标一一对应。
      const collected: LogPart[] = [];
      for (const part of formData.getAll("logs")) {
        if (typeof part !== "object" || part === null || !("arrayBuffer" in part)) {
          return fail(c, err("invalid_log", "logs 部件不是文件", 400));
        }
        const blob = part as File;
        const ab = await blob.arrayBuffer();
        collected.push({
          filename: typeof blob.name === "string" && blob.name !== "" ? blob.name : null,
          bytes: Buffer.from(ab),
        });
      }
      logParts = collected;
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

    // 日志：数量、扩展名、大小、实际 UTF-8 内容与 metadata 逐项核对；任何不符整单拒绝。
    // 放在截图校验之后，保证截图错误码优先级不变。
    let logs: FeedbackLogInput[] = [];
    if (logParts.length > 0 || (logsMetaInput !== undefined && logsMetaInput !== null)) {
      const validated = validateLogAttachments(logParts, logsMetaInput);
      if (!validated.ok) {
        const e = validated.error;
        if (!(e instanceof LogValidationError)) throw e;
        return fail(c, err(e.code, e.message, e.code === "too_large" ? 413 : 400));
      }
      logs = validated.logs;
    }

    const app = getAppByAppId(db, appId);
    if (!app) return fail(c, err("unknown_app", "appId 未在服务端配置", 404));

    const hash = contentHash(
      appId,
      text,
      context,
      sanitizedImage ? { sha256: sanitizedImage.sha256, releasePoint: capture?.releasePoint } : null,
      logs.map((l) => ({ name: l.name, sha256: l.sha256 })),
    );

    const existing = getFeedbackByKey(db, idempotencyKey);
    if (existing) {
      if (existing.content_hash !== hash) {
        return fail(c, err("idempotency_conflict", "同一提交标识对应了不同内容", 409));
      }
      return c.json({ feedbackId: existing.id, status: existing.status, replayed: true });
    }

    let row: FeedbackRow;
    try {
      row = insertFeedbackWithScreenshot(
        db,
        {
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
        logs,
      );
    } catch (insertErr) {
      // 并发下的 UNIQUE 冲突兜底
      const raced = getFeedbackByKey(db, idempotencyKey);
      if (raced) {
        if (raced.content_hash !== hash) {
          return fail(c, err("idempotency_conflict", "同一提交标识对应了不同内容", 409));
        }
        return c.json({ feedbackId: raced.id, status: raced.status, replayed: true });
      }
      throw insertErr;
    }

    worker.enqueue(row.id); // 先持久化已接收，再后台处理
    return c.json({ feedbackId: row.id, status: "received" }, 201);
  });

  routes.get("/:id", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const row = getFeedback(db, c.req.param("id"));
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));
    return c.json(publicStatus(row));
  });

  routes.get("/:id/screenshot", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const screenshot = getFeedbackScreenshot(db, c.req.param("id"));
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

  // —— 管理操作：仅 cookie 会话 ——
  const cookieGuard = (c: Parameters<typeof requireSession>[1]): SessionRow | Response => {
    const s = requireSession(db, c, ["cookie"]);
    if (isErr(s)) return fail(c, s);
    const o = checkSameOrigin(c, s, config);
    if (o) return fail(c, o);
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

  // 4.4 恢复接口：针对图片/日志/评论的分阶段人工恢复
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
    // logId 缺省 = 原有截图行为（兼容旧管理页）；提供时必须是该反馈下真实存在的日志
    let logId: string | undefined;
    if (body.logId !== undefined && body.logId !== null) {
      if (typeof body.logId !== "string" || body.logId.trim() === "" || body.logId.length > 200) {
        return fail(c, err("invalid_request", "logId 必须是非空字符串", 400));
      }
      logId = body.logId.trim();
      if (!getFeedbackLog(db, id, logId)) {
        return fail(c, err("invalid_request", "logId 对应的日志不属于该反馈", 400));
      }
    }
    let r: WorkerOpResult;
    try {
      if (body.action === "retry_comment") {
        r = await worker.recoverRetryComment(id, rev, logId);
      } else if (body.action === "replace_upload") {
        r = await worker.recoverReplaceUpload(id, rev, logId);
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
