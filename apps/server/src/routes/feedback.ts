import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { RateLimiter } from "../auth/ratelimit.ts";
import type { Db, FeedbackRow, FeedbackStatus, NewFeedbackLog, SessionRow } from "../db/repos.ts";
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
import { decodeLogStrict } from "../services/log-text.ts";

const MAX_TEXT_CODEPOINTS = 10_000;
const MAX_MULTIPART_BYTES = 9 * 1024 * 1024; // 9MiB（5MiB 截图 + 3MiB 日志 + 协议开销，见 docs/api.md L1）
const MAX_LOGS = 3;
const MAX_LOG_BYTES = 1024 * 1024; // 单份日志上限 1MiB
const MAX_LOGS_TOTAL_BYTES = 3 * 1024 * 1024; // 全部日志合计上限（派生上界，仍需显式校验）
const MAX_LOG_FILENAME_CHARS = 255;
const LOG_EXTENSIONS = [".log", ".txt", ".json", ".jsonl"];
const LOG_CONTENT_TYPES = [
  "text/plain",
  "application/json",
  "application/x-ndjson",
  "application/jsonl",
  "application/octet-stream",
];

/** 取小写扩展名（含点）；无扩展名返回 ""。 */
function logExtension(name: string): string {
  const base = basenameOf(name);
  const idx = base.lastIndexOf(".");
  return idx < 0 ? "" : base.slice(idx).toLowerCase();
}

/** 丢弃路径分隔符之前的部分（部件 filename 可能被客户端带上路径）。 */
function basenameOf(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/**
 * 统一清洗规则（L2，逐字；L6 下载名沿用同一字符集）：
 * `trim` → 删除全部 C0 控制字符（U+0000..U+001F、U+007F）→ 删除全部 `"` → 删除全部前导 `.` → 截断 ≤255。
 * 注意：扩展名白名单按**清洗前的 `trim` 结果**判定。
 */
function stripC0Controls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue; // C0 与 DEL
    out += ch;
  }
  return out;
}

function sanitizeLogFilename(trimmedName: string): string {
  return stripC0Controls(trimmedName.replaceAll('"', "")).replace(/^\.+/, "").slice(0, MAX_LOG_FILENAME_CHARS);
}

/**
 * 严格 UTF-8 解码（L3）：剥离开头单个 BOM 后 fatal 解码。
 * - 字节数 0，或剥离 BOM 后为 0 码点 → `日志文件为空`；
 * - fatal 解码失败，或解码后含 `U+0000`（NUL）→ `日志不是有效 UTF-8 文本`。
 */
function decodeLogText(bytes: Buffer): { text: string } | { error: string } {
  if (bytes.byteLength === 0) return { error: "日志文件为空" };
  const text = decodeLogStrict(bytes);
  if (text === null) return { error: "日志不是有效 UTF-8 文本" };
  if (text.length === 0) return { error: "日志文件为空" };
  if (text.includes("\u0000")) return { error: "日志不是有效 UTF-8 文本" };
  return { text };
}

function isFilePart(raw: unknown): raw is Blob {
  return typeof raw === "object" && raw !== null && "arrayBuffer" in (raw as Record<string, unknown>);
}

/**
 * 日志校验（L3，顺序固定，先命中先返回）：任一失败整单拒绝，绝不静默丢弃/截断。
 */
async function validateLogParts(rawParts: unknown[], metaInput: unknown): Promise<Err | { logs: NewFeedbackLog[] }> {
  // 1) 数量上限（413）——
  if (rawParts.length > MAX_LOGS) {
    return err("too_large", `日志数量超过 ${MAX_LOGS} 个上限`, 413);
  }
  // 2)/3) 单份与总量字节上限（413）。非文件部件留到结构性检查时再报错。
  const fileBytes: (Buffer | null)[] = [];
  let totalBytes = 0;
  for (const raw of rawParts) {
    if (!isFilePart(raw)) {
      fileBytes.push(null);
      continue;
    }
    const bytes = Buffer.from(await raw.arrayBuffer());
    fileBytes.push(bytes);
    totalBytes += bytes.byteLength;
  }
  for (const bytes of fileBytes) {
    if (bytes && bytes.byteLength > MAX_LOG_BYTES) {
      return err("too_large", "日志文件超过 1MiB 上限", 413);
    }
  }
  if (totalBytes > MAX_LOGS_TOTAL_BYTES) {
    return err("too_large", "日志总大小超过 3MiB 上限", 413);
  }

  // 5) metadata.logs 与部件数量一致（缺省 / null / [] 均等价于无日志）
  const metas: Record<string, unknown>[] = [];
  if (metaInput !== undefined && metaInput !== null) {
    if (!Array.isArray(metaInput)) return err("invalid_log", "metadata.logs 必须是数组", 400);
    for (const item of metaInput) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return err("invalid_log", "metadata.logs 条目必须是对象", 400);
      }
      metas.push(item as Record<string, unknown>);
    }
  }
  if (metas.length !== rawParts.length) {
    return err("invalid_log", "metadata.logs 数量与日志部件数量不一致", 400);
  }

  const logs: NewFeedbackLog[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const raw = rawParts[i];
    const meta = metas[i]!;
    // 6) 必须是文件部件
    if (!isFilePart(raw)) return err("invalid_log", "日志部件必须是文件部件", 400);
    // 7) metadata.logs[i].name：1..255、无路径分隔符、扩展名在白名单内
    const rawName = typeof meta.name === "string" ? meta.name : "";
    const trimmed = rawName.trim();
    if (
      trimmed.length < 1 ||
      trimmed.length > MAX_LOG_FILENAME_CHARS ||
      trimmed.includes("/") ||
      trimmed.includes("\\")
    ) {
      return err("invalid_log", "日志文件名必须是 .log/.txt/.json/.jsonl", 400);
    }
    // 扩展名白名单按清洗前的 trim 结果判定
    const ext = logExtension(trimmed);
    if (!LOG_EXTENSIONS.includes(ext)) {
      return err("invalid_log", "日志文件名必须是 .log/.txt/.json/.jsonl", 400);
    }
    const filename = sanitizeLogFilename(trimmed);
    if (filename === "") {
      return err("invalid_log", "日志文件名必须是 .log/.txt/.json/.jsonl", 400);
    }
    // 8) 部件 filename 必须存在且扩展名与 metadata 一致
    const partName = typeof (raw as File).name === "string" ? (raw as File).name : "";
    if (!partName || logExtension(partName) !== ext) {
      return err("invalid_log", "日志部件文件名缺失或与 metadata 不一致", 400);
    }
    // 9) Content-Type 白名单（忽略参数；缺省按 octet-stream）
    const declared = ((raw as File).type ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = declared === "" ? "application/octet-stream" : declared;
    if (!LOG_CONTENT_TYPES.includes(contentType)) {
      return err("invalid_log", "日志部件 Content-Type 不受支持", 400);
    }
    // 10) source 只允许 auto/manual
    if (meta.source !== "auto" && meta.source !== "manual") {
      return err("invalid_log", "日志来源必须是 auto 或 manual", 400);
    }
    // 11) 空文件；12) 严格 UTF-8 解码且不含 NUL
    const bytes = fileBytes[i]!;
    const decoded = decodeLogText(bytes);
    if ("error" in decoded) return err("invalid_log", decoded.error, 400);
    logs.push({
      filename,
      source: meta.source,
      blob: bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { logs };
}

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
    let screenshotBuffer: Buffer | null = null;
    let logsRawParts: unknown[] = [];
    let logsMetaInput: unknown;

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
      logsRawParts = formData.getAll("logs") as unknown[];

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

    // 日志校验（L3 第 5 步）：数量/大小 413（too_large），其余 invalid_log/400；整单拒绝
    const validatedLogs = await validateLogParts(logsRawParts, logsMetaInput);
    if (isErr(validatedLogs)) return fail(c, validatedLogs);
    const logs = validatedLogs.logs;

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
      logs.map((l) => ({ sha256: l.sha256, byteSize: l.blob.byteLength })),
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
    // 可选 logId（L10）：缺省/null → 既有截图行为；空串或非字符串 → 400；不存在 → 404
    let logId: string | undefined;
    if (body.logId !== undefined && body.logId !== null) {
      if (typeof body.logId !== "string" || body.logId.trim() === "") {
        return fail(c, err("invalid_request", "logId 必须是非空字符串", 400));
      }
      if (!getFeedbackLog(db, id, body.logId)) {
        return fail(c, err("not_found", "日志不存在", 404));
      }
      logId = body.logId;
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
