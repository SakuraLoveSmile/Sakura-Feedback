import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { RateLimiter } from "../auth/ratelimit.ts";
import { createRateLimiter } from "../auth/ratelimit.ts";
import type { AppSourceKind, Db, FeedbackStatus, IssueStatus, LogInput, SessionRow } from "../db/repos.ts";
import {
  addFeedbackMessageAtomic,
  collectionStateForFeedback,
  contentHash,
  getDeletionReceiptByFeedbackId,
  getFeedback,
  getFeedbackLog,
  getFeedbackLogs,
  getFeedbackScreenshot,
  getMessageAttachment,
  getReadCursor,
  getUnifiedFeedbackImage,
  getUnreadSummaryForUser,
  insertFeedbackAudit,
  listFeedbackMessages,
  listUnifiedFeedbackImages,
  listUserFeedbacks,
  markReadCursor,
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
import {
  ImageValidationError,
  type RawImagePart,
  type SanitizedImage,
  type ValidatedImage,
  validateAllImages,
  validateAndSanitizePng,
} from "../services/image.ts";
import { LogValidationError, type RawLogPart, validateAllLogs } from "../services/log-validator.ts";
import { publicUser } from "./auth.ts";

const MAX_TEXT_CODEPOINTS = 10_000;
/** 旧单图 multipart 变体（无 images）的总请求体上限。 */
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024; // 10MiB
/** v12：携带 images 部件的多图变体总请求体上限。 */
const MAX_MULTIPART_BYTES_IMAGES = 32 * 1024 * 1024; // 32MiB

/** ImageValidationError → 契约错误码与 HTTP 状态。 */
function imageError(e: ImageValidationError): Err {
  if (e.code === "too_large") return err("too_large", e.message, 413);
  if (e.code === "invalid_request") return err("invalid_request", e.message, 400);
  return err("invalid_image", e.message, 400);
}

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
    const rawImageParts: RawImagePart[] = [];
    let logsDescRaw: unknown;
    let imagesDescRaw: unknown;
    /** multipart 请求体的实际字节数（变体判定前的总大小，用于旧变体 10MiB 上限）。 */
    let totalMultipartBytes = 0;

    if (contentType.includes("multipart/form-data")) {
      // v12：携带 images 部件的多图变体上限 32MiB；旧单图变体保持 10MiB。
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_MULTIPART_BYTES_IMAGES) {
        return fail(c, err("too_large", "请求体超过 32MiB 上限", 413));
      }

      const reader = c.req.raw.body?.getReader();
      if (!reader) return fail(c, err("invalid_request", "无法读取请求体", 400));
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_MULTIPART_BYTES_IMAGES) {
          return fail(c, err("too_large", "请求体超过 32MiB 上限", 413));
        }
        chunks.push(value);
      }
      totalMultipartBytes = totalBytes;
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
        // 无法解析时无从判断变体：超过旧变体 10MiB 上限的按 too_large 拒绝（契约语义），其余按非法请求。
        if (totalBytes > MAX_MULTIPART_BYTES) {
          return fail(c, err("too_large", "请求体超过 10MiB 上限", 413));
        }
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
      imagesDescRaw = metaParsed.images;

      const fileField = formData.get("screenshot");
      if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField) {
        const ab = await (fileField as Blob).arrayBuffer();
        if (ab.byteLength > 0) {
          screenshotBuffer = Buffer.from(ab);
        }
      }

      // v12：多图部件（按表单顺序与 metadata.images 描述符一一对应）。
      const imageEntries = formData.getAll("images");
      for (const entry of imageEntries) {
        if (entry && typeof entry === "object" && "arrayBuffer" in entry) {
          const ab = await (entry as Blob).arrayBuffer();
          rawImageParts.push({ bytes: Buffer.from(ab), filename: (entry as { name?: string }).name });
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
        images?: unknown;
      }>(c);
      if (isErr(body)) return fail(c, body);
      if (body.logs !== undefined) {
        return fail(c, err("invalid_request", "日志附件必须通过 multipart 表单上传", 400));
      }
      if (body.images !== undefined) {
        return fail(c, err("invalid_request", "图片附件必须通过 multipart 表单上传", 400));
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
      /** 局部截图区域：0..1 归一化，相对原始捕获视口；缺省表示整个视口。 */
      region?: { x: number; y: number; width: number; height: number };
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
      // 局部截图区域：出现即必须完整合法，非法一律 400（绝不静默丢弃或回退成整窗）。
      let region: { x: number; y: number; width: number; height: number } | undefined;
      if (cap.region !== undefined) {
        if (typeof cap.region !== "object" || cap.region === null) {
          return fail(c, err("invalid_request", "capture.region 必须是 {x,y,width,height} 对象", 400));
        }
        const rg = cap.region as Record<string, unknown>;
        const nums = [rg.x, rg.y, rg.width, rg.height];
        if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) {
          return fail(c, err("invalid_request", "capture.region 的 x/y/width/height 必须是有限数字", 400));
        }
        const { x, y, width, height } = rg as unknown as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        const EPS = 1e-6; // 客户端由整数像素裁剪换算比值的浮点误差余量
        if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 + EPS || y + height > 1 + EPS) {
          return fail(c, err("invalid_request", "capture.region 必须落在 0..1 视口范围内且宽高为正", 400));
        }
        region = {
          x,
          y,
          width: Math.min(width, 1 - x),
          height: Math.min(height, 1 - y),
        };
      }
      if (vw !== undefined || vh !== undefined || cat !== undefined || rp !== undefined || pixelPair || region) {
        capture = {
          viewportWidth: vw,
          viewportHeight: vh,
          capturedAt: cat,
          releasePoint: rp,
          ...(pixelPair ? { pixelWidth: pw as number, pixelHeight: ph as number } : {}),
          ...(region ? { region } : {}),
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

    // v12：images 与 screenshot 互斥（同时出现一律 invalid_request）。
    const imagesVariant = rawImageParts.length > 0 || (imagesDescRaw !== undefined && imagesDescRaw !== null);
    if (imagesVariant && screenshotBuffer) {
      return fail(c, err("invalid_request", "images 与 screenshot 不能同时出现", 400));
    }

    let validatedImages: ValidatedImage[] = [];
    try {
      validatedImages = await validateAllImages(rawImageParts, imagesDescRaw);
    } catch (errObj) {
      if (errObj instanceof ImageValidationError) {
        return fail(c, imageError(errObj));
      }
      return fail(c, err("invalid_image", (errObj as Error).message, 400));
    }
    // 旧单图变体（无 images）保持 10MiB 上限；多图变体已按 32MiB 放行。
    if (validatedImages.length === 0 && rawImageParts.length === 0 && totalMultipartBytes > MAX_MULTIPART_BYTES) {
      return fail(c, err("too_large", "请求体超过 10MiB 上限", 413));
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
      // v12：有序图片摘要纳入内容哈希（无 images 时与旧算法一致）。
      validatedImages.length > 0 ? validatedImages : null,
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
      validatedImages.length > 0
        ? (() => {
            // capture 元数据挂到首张来源为 capture 的图（缺省回退第一张），语义与旧单图一致。
            const captureIdx = validatedImages.findIndex((x) => x.source === "capture");
            const target = captureIdx >= 0 ? captureIdx : 0;
            return validatedImages.map((img, i) => ({
              id: img.id,
              mime: img.mime,
              filename: img.filename,
              byteSize: img.byteSize,
              sha256: img.sha256,
              bytes: img.bytes,
              width: img.width,
              height: img.height,
              captureJson: capture && i === target ? JSON.stringify(capture) : null,
              source: img.source,
            }));
          })()
        : null,
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

  // ========================================================================= v11: 用户端对话与闭环 API
  const replyLimiter = createRateLimiter(15, 60 * 1000); // 15次/分/用户回复限流

  routes.get("/mine", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const appId = c.req.query("appId") || undefined;
    const page = c.req.query("page") ? parseInt(c.req.query("page")!, 10) : 1;
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;
    const issueStatus = (c.req.query("issueStatus") as IssueStatus) || undefined;

    const data = listUserFeedbacks(db, user.id, { appId, page, limit, issueStatus });
    return c.json(data);
  });

  routes.get("/unread-summary", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const appId = c.req.query("appId") || undefined;
    const summary = getUnreadSummaryForUser(db, user.id, appId);
    return c.json(summary);
  });

  routes.get("/messages/attachments/:id", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const attachmentId = c.req.param("id");
    const att = getMessageAttachment(db, attachmentId);
    if (!att) return fail(c, err("not_found", "附件不存在", 404));

    const fb = getFeedback(db, att.feedback_id);
    if (!fb || (user.role !== "admin" && fb.user_id !== user.id)) {
      return fail(c, err("not_found", "附件不存在", 404));
    }

    // v12：kind='image' 按入库 mime 返回；screenshot 为 PNG；log 为纯文本。
    const contentType =
      att.kind === "image" && att.mime
        ? att.mime
        : att.kind === "screenshot"
          ? "image/png"
          : "text/plain; charset=utf-8";
    return new Response(att.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(att.byte_size),
        "cache-control": "no-store",
        "content-disposition": `inline; filename="${encodeURIComponent(att.filename)}"`,
      },
    });
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

  routes.get("/:id/dialogue", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const id = c.req.param("id");
    const fb = getFeedback(db, id);
    if (!fb) {
      const receipt = getDeletionReceiptByFeedbackId(db, id);
      if (receipt && (receipt.user_id === user.id || user.role === "admin")) {
        return fail(c, err("feedback_purged", "该反馈已被彻底删除", 410));
      }
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    if (user.role !== "admin" && fb.user_id !== user.id) {
      return fail(c, err("not_found", "反馈不存在", 404));
    }

    const messages = listFeedbackMessages(db, id);
    const lastReadSeq = getReadCursor(db, user.id, id);

    // 附带初始反馈的元数据
    const logs = getFeedbackLogs(db, id);
    // v12：统一有序图片列表（新图片表 + 旧截图兼容行 id="screenshot"）。
    const unifiedImages = listUnifiedFeedbackImages(db, id);

    return c.json({
      feedback: {
        id: fb.id,
        appId: fb.app_id,
        title: fb.title,
        text: fb.text,
        status: fb.status,
        issueStatus: fb.issue_status,
        dialogueVersion: fb.dialogue_version,
        archiveRound: fb.archive_round,
        mgmtState: fb.mgmt_state,
        createdAt: fb.created_at,
        updatedAt: fb.updated_at,
        lastActivityAt: fb.last_activity_at || fb.created_at,
        hasScreenshot: unifiedImages.length > 0,
        images: unifiedImages,
        logCount: logs.length,
        logs: logs.map((l) => ({
          id: l.id,
          filename: l.filename,
          byteSize: l.byte_size,
          sha256: l.sha256,
          source: l.source,
          createdAt: l.created_at,
        })),
      },
      messages: messages.map((m) => ({
        id: m.id,
        seq: m.seq,
        senderType: m.sender_type,
        senderId: m.sender_id,
        senderName: m.sender_name,
        text: m.text,
        // v12：处理说明（resolved 时携带；对用户可见）。
        resolutionNote: m.resolution_note,
        createdAt: m.created_at,
        attachments: m.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          mime: a.mime,
          filename: a.filename,
          byteSize: a.byte_size,
          sha256: a.sha256,
          width: a.width,
          height: a.height,
          createdAt: a.created_at,
        })),
      })),
      lastReadSeq,
    });
  });

  routes.post("/:id/messages", async (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const id = c.req.param("id");
    const fb = getFeedback(db, id);
    if (!fb || (user.role !== "admin" && fb.user_id !== user.id)) {
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    if (fb.mgmt_state === "trash") {
      return fail(c, err("readonly_trashed", "回收站中的反馈只读，无法发送回复", 403));
    }

    const limited = checkLimiter(replyLimiter, `reply|${user.id}`);
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }

    let text = "";
    let idempotencyKey: string | null = null;
    const attachments: Array<{
      kind: "screenshot" | "log" | "image";
      filename: string;
      mime?: string | null;
      byteSize: number;
      sha256: string;
      bytes: Uint8Array | Buffer;
      width?: number | null;
      height?: number | null;
    }> = [];

    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      // v12：回复 multipart 增加 metadata（{text, idempotencyKey?, images?: [...] }）与 images 部件；
      // 旧式平铺字段继续接受。回复总请求体上限 32MiB。
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > MAX_MULTIPART_BYTES_IMAGES) {
        return fail(c, err("too_large", "请求体超过 32MiB 上限", 413));
      }
      const reader = c.req.raw.body?.getReader();
      if (!reader) return fail(c, err("invalid_request", "无法读取请求体", 400));
      const chunks: Uint8Array[] = [];
      let replyBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        replyBytes += value.byteLength;
        if (replyBytes > MAX_MULTIPART_BYTES_IMAGES) {
          return fail(c, err("too_large", "请求体超过 32MiB 上限", 413));
        }
        chunks.push(value);
      }
      const fullBody = Buffer.concat(chunks);
      let form: FormData;
      try {
        const fakeReq = new Request(c.req.url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: fullBody,
        });
        form = await fakeReq.formData();
      } catch (errObj) {
        return fail(c, err("invalid_request", `无法解析 multipart 表单: ${(errObj as Error).message}`, 400));
      }

      // metadata（v12 可选）：优先从中取 text/idempotencyKey/images 描述符；缺省回退平铺字段。
      let imagesDescRaw: unknown;
      const metaRaw = form.get("metadata");
      if (metaRaw !== null) {
        if (typeof metaRaw !== "string" || !metaRaw.trim()) {
          return fail(c, err("invalid_request", "metadata 必须是 JSON 字符串", 400));
        }
        let metaParsed: Record<string, unknown>;
        try {
          metaParsed = JSON.parse(metaRaw);
        } catch {
          return fail(c, err("invalid_request", "metadata 不是有效 JSON", 400));
        }
        text = typeof metaParsed.text === "string" ? metaParsed.text.trim() : text;
        if (typeof metaParsed.idempotencyKey === "string" && metaParsed.idempotencyKey.trim()) {
          idempotencyKey = metaParsed.idempotencyKey.trim();
        }
        imagesDescRaw = metaParsed.images;
      }
      if (!text) text = String(form.get("text") ?? "").trim();
      if (!idempotencyKey && form.get("idempotencyKey")) {
        idempotencyKey = String(form.get("idempotencyKey")).trim() || null;
      }

      const screenshotFile = form.get("screenshot");
      let replyScreenshotBuf: Buffer | null = null;
      if (screenshotFile && typeof screenshotFile === "object" && "arrayBuffer" in screenshotFile) {
        const file = screenshotFile as File;
        const buf = Buffer.from(await file.arrayBuffer());
        if (buf.byteLength > 0) replyScreenshotBuf = buf;
      }

      // v12：回复图片部件（按序与 metadata.images 描述符一一对应）。
      const replyImageParts: RawImagePart[] = [];
      for (const entry of form.getAll("images")) {
        if (entry && typeof entry === "object" && "arrayBuffer" in entry) {
          const ab = await (entry as Blob).arrayBuffer();
          replyImageParts.push({ bytes: Buffer.from(ab), filename: (entry as { name?: string }).name });
        }
      }
      // images 与 screenshot 互斥（同首次提交语义）。
      if (
        (replyImageParts.length > 0 || (imagesDescRaw !== undefined && imagesDescRaw !== null)) &&
        replyScreenshotBuf
      ) {
        return fail(c, err("invalid_request", "images 与 screenshot 不能同时出现", 400));
      }
      try {
        const replyImages = await validateAllImages(replyImageParts, imagesDescRaw);
        for (const img of replyImages) {
          attachments.push({
            kind: "image",
            filename: img.filename,
            mime: img.mime,
            byteSize: img.byteSize,
            sha256: img.sha256,
            bytes: img.bytes,
            width: img.width,
            height: img.height,
          });
        }
      } catch (errObj) {
        if (errObj instanceof ImageValidationError) return fail(c, imageError(errObj));
        return fail(c, err("invalid_image", (errObj as Error).message, 400));
      }

      if (replyScreenshotBuf) {
        try {
          const sanitizedImg = await validateAndSanitizePng(replyScreenshotBuf);
          attachments.push({
            kind: "screenshot",
            filename: (screenshotFile as File).name || "screenshot.png",
            byteSize: sanitizedImg.sanitizedBuffer.byteLength,
            sha256: sanitizedImg.sha256,
            bytes: sanitizedImg.sanitizedBuffer,
            width: sanitizedImg.width,
            height: sanitizedImg.height,
          });
        } catch (errObj) {
          if (errObj instanceof ImageValidationError) {
            const status = errObj.code === "too_large" ? 413 : 400;
            return fail(c, err(errObj.code, errObj.message, status));
          }
          return fail(c, err("invalid_image", (errObj as Error).message, 400));
        }
      }

      const logFiles = form.getAll("logs");
      if (logFiles.length > 3) {
        return fail(c, err("too_many_logs", "单次回复最多附加 3 份日志", 400));
      }
      for (const item of logFiles) {
        if (item && typeof item === "object" && "arrayBuffer" in item) {
          const file = item as File;
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.byteLength === 0) return fail(c, err("empty_log", "日志文件不得为空", 400));
          if (bytes.byteLength > 1024 * 1024) return fail(c, err("log_too_large", "单份日志不得超过 1MiB", 413));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          attachments.push({
            kind: "log",
            filename: file.name || "log.txt",
            byteSize: bytes.byteLength,
            sha256,
            bytes,
          });
        }
      }
    } else {
      const json = await readJson<{ text?: string; idempotencyKey?: string }>(c);
      if (isErr(json)) return fail(c, json);
      text = String(json.text ?? "").trim();
      idempotencyKey = json.idempotencyKey ? String(json.idempotencyKey).trim() : null;
    }

    if (!text && attachments.length === 0) {
      return fail(c, err("invalid_request", "回复内容或附件不可全为空", 400));
    }
    if (textCodepointLen(text) > MAX_TEXT_CODEPOINTS) {
      return fail(c, err("text_too_long", `回复文本不能超过 ${MAX_TEXT_CODEPOINTS} 字`, 400));
    }

    const outcome = addFeedbackMessageAtomic(db, {
      feedbackId: id,
      senderType: "user",
      senderId: user.id,
      senderName: user.username,
      text,
      idempotencyKey,
      attachments,
    });

    if (outcome.kind === "archive_in_progress") {
      return fail(c, err("busy", "该反馈正在同步到 Kaneo，请稍后重试回复", 409));
    }
    if (outcome.kind === "readonly_trashed") {
      return fail(c, err("readonly_trashed", "回收站中的反馈只读，无法发送回复", 403));
    }
    if (outcome.kind === "conflict") {
      return fail(c, err("idempotency_conflict", outcome.reason, 409));
    }
    if (outcome.kind === "not_found") {
      return fail(c, err("not_found", "反馈不存在", 404));
    }
    if (outcome.kind === "version_conflict") {
      return fail(c, err("version_conflict", "版本冲突", 409));
    }

    const resStatus = outcome.kind === "replayed" ? 200 : 201;
    return c.json(
      {
        ok: true,
        replayed: outcome.kind === "replayed",
        message: {
          id: outcome.message.id,
          seq: outcome.message.seq,
          senderType: outcome.message.sender_type,
          senderId: outcome.message.sender_id,
          senderName: outcome.message.sender_name,
          text: outcome.message.text,
          createdAt: outcome.message.created_at,
          attachments: outcome.attachments.map((a) => ({
            id: a.id,
            kind: a.kind,
            filename: a.filename,
            byteSize: a.byte_size,
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            createdAt: a.created_at,
          })),
        },
        dialogueVersion: outcome.dialogueVersion,
        issueStatus: outcome.issueStatus,
      },
      resStatus,
    );
  });

  routes.post("/:id/read", async (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));

    const id = c.req.param("id");
    const fb = getFeedback(db, id);
    if (!fb || (user.role !== "admin" && fb.user_id !== user.id)) {
      return fail(c, err("not_found", "反馈不存在", 404));
    }

    const body = await readJson<{ lastReadSeq?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const lastReadSeq = typeof body.lastReadSeq === "number" ? Math.floor(body.lastReadSeq) : 0;
    if (lastReadSeq < 0) return fail(c, err("invalid_request", "lastReadSeq 必须为非负整数", 400));

    const recorded = markReadCursor(db, user.id, id, lastReadSeq);
    return c.json({ ok: true, lastReadSeq: recorded });
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

  /** v12：统一图片字节读取（限本人+管理员；旧截图以 id="screenshot" 兼容命中）。 */
  routes.get("/:id/images/:imageId", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    if (!row || (user.role !== "admin" && row.user_id !== user.id)) {
      return fail(c, err("not_found", "图片不存在", 404));
    }
    const img = getUnifiedFeedbackImage(db, row.id, c.req.param("imageId"));
    if (!img) return fail(c, err("not_found", "图片不存在", 404));
    return new Response(img.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": img.mime,
        "cache-control": "no-store",
        "content-length": String(img.byteSize),
        "content-disposition": `inline; filename="${encodeURIComponent(img.filename)}"`,
      },
    });
  });

  /** v12：用户下载本人反馈的日志附件（限本人+管理员）。 */
  routes.get("/:id/logs/:logId/download", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    if (!row || (user.role !== "admin" && row.user_id !== user.id)) {
      return fail(c, err("not_found", "日志附件不存在", 404));
    }
    const log = getFeedbackLog(db, row.id, c.req.param("logId"));
    if (!log) return fail(c, err("not_found", "日志附件不存在", 404));
    const safeFilename = encodeURIComponent(log.filename).replace(/['()]/g, escape);
    return new Response(log.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${log.filename}"; filename*=UTF-8''${safeFilename}`,
        "cache-control": "no-store",
        "content-length": String(log.byte_size),
      },
    });
  });

  /** v12：用户预览本人反馈的纯文本日志（限本人+管理员）。 */
  routes.get("/:id/logs/:logId/preview", (c) => {
    const session = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(session)) return fail(c, session);
    const user = sessionUser(db, session);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const row = getFeedback(db, c.req.param("id"));
    if (!row || (user.role !== "admin" && row.user_id !== user.id)) {
      return fail(c, err("not_found", "日志附件不存在", 404));
    }
    const log = getFeedbackLog(db, row.id, c.req.param("logId"));
    if (!log) return fail(c, err("not_found", "日志附件不存在", 404));
    return new Response(log.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "inline",
        "cache-control": "no-store",
        "content-length": String(log.byte_size),
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
