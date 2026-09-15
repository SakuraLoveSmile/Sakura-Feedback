import { Hono } from "hono";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { createRateLimiter } from "../auth/ratelimit.ts";
import { encryptSecret } from "../crypto/secret.ts";
import {
  type AppRow,
  createUser,
  type Db,
  deleteApp,
  type FeedbackRow,
  type FeedbackStatus,
  getAppByAppId,
  getFeedback,
  getFeedbackLog,
  getFeedbackLogsMeta,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  getQuota,
  getSetting,
  getUserById,
  getUserByUsername,
  insertApp,
  listApps,
  listFeedbacks,
  listOrdinaryUsers,
  revokeUserSessions,
  setSetting,
  setUserPassword,
  toAdminListItem,
  type UserRow,
  updateAdminCredentialsInTx,
  updateApp,
  updateUser,
} from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import {
  checkLimiter,
  clearSessionCookie,
  type Err,
  err,
  fail,
  isErr,
  readJson,
  requireAdminCookie,
  sessionUser,
} from "../http.ts";
import { parseArchiveData } from "../pipeline/archive-data.ts";
import type { AiClient } from "../services/ai.ts";
import type { KaneoClient } from "../services/kaneo.ts";
import type { PublicApp } from "../types.ts";

export interface AdminDeps {
  db: Db;
  masterKey: Buffer;
  config: ServerConfig;
  kaneo: KaneoClient;
  ai: AiClient;
}

function publicApp(r: AppRow): PublicApp {
  let origins: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.allowed_origins);
    if (Array.isArray(parsed)) origins = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* 数据损坏按空处理 */
  }
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    allowedOrigins: origins,
    kaneoProjectId: r.kaneo_project_id,
    kaneoColumnSlug: r.kaneo_column_slug,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeOriginList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    try {
      const u = new URL(item.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      out.push(u.origin);
    } catch {
      return null;
    }
  }
  return out;
}

interface AppInput {
  appId: string;
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
}

function validateAppInput(body: Record<string, unknown>, requireAppId: boolean): AppInput | Err {
  const appId = typeof body.appId === "string" ? body.appId.trim() : "";
  if (requireAppId && (!appId || appId.length > 100)) {
    return err("invalid_request", "appId 必填且不超过 100 字符", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return err("invalid_request", "name 必填且不超过 100 字符", 400);
  const origins = normalizeOriginList(body.allowedOrigins ?? []);
  if (origins === null) return err("invalid_request", "allowedOrigins 必须是 http(s) origin 数组", 400);
  const kaneoProjectId = typeof body.kaneoProjectId === "string" ? body.kaneoProjectId.trim().slice(0, 100) : "";
  const kaneoColumnSlug = typeof body.kaneoColumnSlug === "string" ? body.kaneoColumnSlug.trim().slice(0, 100) : "";
  return { appId, name, allowedOrigins: origins, kaneoProjectId, kaneoColumnSlug };
}

export function adminRoutes(deps: AdminDeps): Hono {
  const { db, masterKey, config } = deps;
  const routes = new Hono();

  // 全部管理接口：仅管理员 Cookie 会话 + 同源检查
  routes.use("*", async (c, next) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    await next();
  });

  /** 改自己凭据的独立限流：按管理员 id 计时（不复用登录限流，避免互相影响）。 */
  const meLimiter = createRateLimiter(10, 15 * 60 * 1000);

  // ---------- 管理员设置（T2-A：只能改当前会话账号自己的用户名与密码） ----------

  /**
   * `PATCH /api/admin/me` body `{ currentPassword, username?, newPassword? }`。
   * 目标恒为当前会话账号：不接受任何可指定他人的字段（多余字段一律忽略）。
   * 成功返回 `{ ok: true, reauthenticate: true }` 并清除会话 Cookie；
   * 该账号全部会话（含当前）已在事务内撤销，客户端必须重新登录。
   */
  routes.patch("/me", async (c) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);

    // 限流在任何写操作之前，且必须显式下发 Retry-After（checkLimiter 不代设）。
    const limited = checkLimiter(meLimiter, s.user_id);
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }

    const body = await readJson<{ currentPassword?: unknown; username?: unknown; newPassword?: unknown }>(c);
    if (isErr(body)) return fail(c, body);

    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (currentPassword === "") {
      return fail(c, err("invalid_request", "currentPassword 必填", 400));
    }

    // 两个可选字段都以「提供空白字符串」视作未提供：新密码不去除首尾空格。
    const usernameRaw = typeof body.username === "string" ? body.username.trim() : "";
    const newPasswordRaw = typeof body.newPassword === "string" ? body.newPassword : "";
    if (usernameRaw === "" && newPasswordRaw === "") {
      return fail(c, err("invalid_request", "至少提供 username 或 newPassword 之一", 400));
    }
    if (usernameRaw !== "" && usernameRaw.length > 100) {
      return fail(c, err("invalid_request", "username 须为 1..100 字符", 400));
    }
    if (newPasswordRaw !== "" && (newPasswordRaw.length < 8 || newPasswordRaw.length > 200)) {
      return fail(c, err("invalid_request", "newPassword 须为 8..200 字符", 400));
    }

    const user = sessionUser(db, s);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    if (!verifyPassword(currentPassword, user.pass_hash)) {
      return fail(c, err("invalid_current_password", "当前密码不正确", 403));
    }

    // scrypt 在事务外完成：事务内不做 CPU 密集计算。
    const outcome = updateAdminCredentialsInTx(db, {
      userId: user.id,
      ...(usernameRaw !== "" ? { newUsername: usernameRaw } : {}),
      ...(newPasswordRaw !== "" ? { newPassHash: hashPassword(newPasswordRaw) } : {}),
    });
    if (outcome === "not_found") return fail(c, err("unauthorized", "需要登录", 401));
    if (outcome === "username_conflict") return fail(c, err("user_exists", "该用户名已存在", 409));

    clearSessionCookie(c);
    return c.json({ ok: true, reauthenticate: true });
  });

  // ---------- 账号管理（只管理普通账号；管理员保留，不提供删除与角色修改） ----------

  function quotaUserView(u: UserRow) {
    const quota = getQuota(db, u);
    return {
      id: u.id,
      username: u.username,
      enabled: u.enabled === 1,
      dailyLimit: u.daily_limit,
      used: quota.used,
      remaining: quota.remaining,
      resetAt: quota.resetAt,
      createdAt: u.created_at,
    };
  }

  const MAX_DAILY_LIMIT = 1_000_000;

  /** 校验每日额度：非负安全整数（0 表示禁止新提交）。 */
  function parseDailyLimit(v: unknown): number | Err {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_DAILY_LIMIT) {
      return err("invalid_request", `dailyLimit 必须是 0..${MAX_DAILY_LIMIT} 的整数`, 400);
    }
    return v;
  }

  /** 目标必须是可管理的普通账号（管理员不在本页管理范围）。 */
  function ordinaryUserOr404(id: string): UserRow | Err {
    const u = getUserById(db, id);
    if (u?.role !== "user") return err("not_found", "账号不存在", 404);
    return u;
  }

  routes.get("/users", (c) => c.json({ users: listOrdinaryUsers(db).map(quotaUserView) }));

  routes.post("/users", async (c) => {
    const body = await readJson<{ username?: unknown; password?: unknown; dailyLimit?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || username.length > 100) {
      return fail(c, err("invalid_request", "username 必填且不超过 100 字符", 400));
    }
    if (!password || password.length > 200) {
      return fail(c, err("invalid_request", "password 必填且不超过 200 字符", 400));
    }
    let dailyLimit = 3;
    if (body.dailyLimit !== undefined) {
      const parsed = parseDailyLimit(body.dailyLimit);
      if (typeof parsed !== "number") return fail(c, parsed);
      dailyLimit = parsed;
    }
    if (getUserByUsername(db, username)) return fail(c, err("user_exists", "该用户名已存在", 409));
    const row = createUser(db, username, hashPassword(password), { role: "user", dailyLimit });
    return c.json(quotaUserView(row), 201);
  });

  routes.patch("/users/:id", async (c) => {
    const target = ordinaryUserOr404(c.req.param("id"));
    if ("status" in target) return fail(c, target);
    const body = await readJson<{ enabled?: unknown; dailyLimit?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const patch: { enabled?: number; dailyLimit?: number } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return fail(c, err("invalid_request", "enabled 必须是布尔值", 400));
      }
      patch.enabled = body.enabled ? 1 : 0;
    }
    if (body.dailyLimit !== undefined) {
      const parsed = parseDailyLimit(body.dailyLimit);
      if (typeof parsed !== "number") return fail(c, parsed);
      patch.dailyLimit = parsed; // 立即生效，不清除当天用量
    }
    if (Object.keys(patch).length === 0) {
      return fail(c, err("invalid_request", "没有可更新的字段", 400));
    }
    updateUser(db, target.id, patch);
    // 禁用账号立即撤销其全部会话（启用不重建会话）。
    if (patch.enabled === 0) revokeUserSessions(db, target.id);
    return c.json(quotaUserView(getUserById(db, target.id)!));
  });

  routes.post("/users/:id/password", async (c) => {
    const target = ordinaryUserOr404(c.req.param("id"));
    if ("status" in target) return fail(c, target);
    const body = await readJson<{ password?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length > 200) {
      return fail(c, err("invalid_request", "password 必填且不超过 200 字符", 400));
    }
    setUserPassword(db, target.id, hashPassword(password));
    revokeUserSessions(db, target.id); // 重置密码撤销旧会话
    return c.json({ ok: true });
  });

  // ---------- 软件配置 ----------
  routes.get("/apps", (c) => c.json({ apps: listApps(db).map(publicApp) }));

  routes.post("/apps", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const v = validateAppInput(body, true);
    if ("status" in v) return fail(c, v);
    if (getAppByAppId(db, v.appId)) return fail(c, err("app_exists", "该 appId 已存在", 409));
    const row = insertApp(db, v);
    return c.json(publicApp(row), 201);
  });

  routes.put("/apps/:id", async (c) => {
    const existing = listApps(db).find((a) => a.id === c.req.param("id"));
    if (!existing) return fail(c, err("not_found", "软件配置不存在", 404));
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const v = validateAppInput({ ...body, appId: existing.app_id }, false); // appId 不可改
    if ("status" in v) return fail(c, v);
    updateApp(db, existing.id, {
      name: v.name,
      allowedOrigins: v.allowedOrigins,
      kaneoProjectId: v.kaneoProjectId,
      kaneoColumnSlug: v.kaneoColumnSlug,
    });
    return c.json(publicApp(listApps(db).find((a) => a.id === existing.id)!));
  });

  routes.delete("/apps/:id", (c) => {
    const id = c.req.param("id");
    if (!listApps(db).some((a) => a.id === id)) return fail(c, err("not_found", "软件配置不存在", 404));
    deleteApp(db, id); // 历史反馈保留
    return c.body(null, 204);
  });

  // ---------- Kaneo 连接 ----------
  routes.get("/connection/kaneo", (c) => {
    return c.json({
      baseUrl: getSetting(db, "kaneo.baseUrl"),
      clientUrl: getSetting(db, "kaneo.clientUrl"),
      apiKeySet: getSetting(db, "kaneo.apiKeyEnc") !== null,
    });
  });

  routes.put("/connection/kaneo", async (c) => {
    const body = await readJson<{ baseUrl?: unknown; clientUrl?: unknown; apiKey?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!isHttpUrl(baseUrl)) return fail(c, err("invalid_request", "baseUrl 必须是 http(s) URL", 400));
    const clientUrlRaw = typeof body.clientUrl === "string" ? body.clientUrl.trim() : "";
    if (clientUrlRaw !== "" && !isHttpUrl(clientUrlRaw)) {
      return fail(c, err("invalid_request", "clientUrl 必须是 http(s) URL", 400));
    }
    setSetting(db, "kaneo.baseUrl", baseUrl);
    if (clientUrlRaw) setSetting(db, "kaneo.clientUrl", clientUrlRaw);
    else deleteSetting(db, "kaneo.clientUrl");
    if (typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
      setSetting(db, "kaneo.apiKeyEnc", encryptSecret(masterKey, body.apiKey.trim()));
    }
    return c.json({ ok: true, apiKeySet: getSetting(db, "kaneo.apiKeyEnc") !== null });
  });

  routes.post("/connection/kaneo/test", async (c) => {
    const body = await readJson<{ projectId?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) return fail(c, err("invalid_request", "projectId 必填", 400));
    try {
      const r = await deps.kaneo.test(projectId);
      return c.json({ ok: true, project: r.project, columns: r.columns });
    } catch (errObj) {
      return c.json({ ok: false, reason: (errObj as Error).message.slice(0, 300) }, 502);
    }
  });

  routes.get("/connection/kaneo/projects", async (c) => {
    try {
      const r = await deps.kaneo.listProjects();
      return c.json({ ok: true, ...r });
    } catch (errObj) {
      return c.json({ ok: false, reason: (errObj as Error).message.slice(0, 300) }, 502);
    }
  });

  // ---------- AI 连接 ----------
  routes.get("/connection/ai", (c) => {
    return c.json({
      baseUrl: getSetting(db, "ai.baseUrl"),
      model: getSetting(db, "ai.model"),
      apiKeySet: getSetting(db, "ai.apiKeyEnc") !== null,
    });
  });

  routes.put("/connection/ai", async (c) => {
    const body = await readJson<{ baseUrl?: unknown; model?: unknown; apiKey?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim().slice(0, 100) : "";
    if (!isHttpUrl(baseUrl)) return fail(c, err("invalid_request", "baseUrl 必须是 http(s) URL", 400));
    if (!model) return fail(c, err("invalid_request", "model 必填", 400));
    setSetting(db, "ai.baseUrl", baseUrl);
    setSetting(db, "ai.model", model);
    if (typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
      setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, body.apiKey.trim()));
    }
    return c.json({ ok: true, apiKeySet: getSetting(db, "ai.apiKeyEnc") !== null });
  });

  routes.post("/connection/ai/test", async (c) => {
    const r = await deps.ai.test();
    return r.ok ? c.json(r) : c.json(r, 502);
  });

  routes.post("/connection/ai/test-vision", async (c) => {
    const r = await deps.ai.testVision();
    return r.ok ? c.json(r) : c.json(r, 502);
  });

  // ---------- 反馈列表与详情 ----------
  routes.get("/feedback", (c) => {
    const statusQ = c.req.query("status");
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const r = listFeedbacks(db, {
      status: (STATUSES as string[]).includes(statusQ ?? "") ? (statusQ as FeedbackStatus) : undefined,
      appId: c.req.query("appId") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit,
    });
    return c.json({ items: r.items.map(toAdminListItem), nextCursor: r.nextCursor });
  });

  routes.get("/feedback/:id", (c) => {
    const row = getFeedback(db, c.req.param("id"));
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));
    let processed = null;
    if (row.processed_json) {
      try {
        processed = JSON.parse(row.processed_json);
      } catch {
        processed = null;
      }
    }
    let context = null;
    if (row.context_json) {
      try {
        context = JSON.parse(row.context_json);
      } catch {
        context = null;
      }
    }
    const screenshotMeta = getFeedbackScreenshotMeta(db, row.id);
    const submitter = row.user_id ? getUserById(db, row.user_id) : null;
    const logsMeta = getFeedbackLogsMeta(db, row.id);
    return c.json({
      ...toAdminListItem(row),
      username: submitter?.username ?? null,
      text: row.text,
      context,
      processed,
      kaneoTaskId: row.kaneo_task_id,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      recovery: recoveryInfo(db, row),
      screenshot: screenshotMeta
        ? {
            width: screenshotMeta.width,
            height: screenshotMeta.height,
            byteSize: screenshotMeta.byte_size,
            sha256: screenshotMeta.sha256,
            capture: screenshotMeta.capture,
            createdAt: screenshotMeta.created_at,
          }
        : null,
      logs: logsMeta.map((l) => ({
        id: l.id,
        feedbackId: l.feedback_id,
        sortOrder: l.sort_order,
        filename: l.filename,
        source: l.source,
        byteSize: l.byte_size,
        sha256: l.sha256,
        createdAt: l.created_at,
      })),
    });
  });

  routes.get("/feedback/:id/screenshot", (c) => {
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

  routes.get("/feedback/:id/logs/:logId/download", (c) => {
    const feedbackId = c.req.param("id");
    const logId = c.req.param("logId");
    const log = getFeedbackLog(db, feedbackId, logId);
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

  routes.get("/feedback/:id/logs/:logId/preview", (c) => {
    const feedbackId = c.req.param("id");
    const logId = c.req.param("logId");
    const log = getFeedbackLog(db, feedbackId, logId);
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

  routes.get("/feedback/:id/logs/:logId", (c) => {
    const feedbackId = c.req.param("id");
    const logId = c.req.param("logId");
    const log = getFeedbackLog(db, feedbackId, logId);
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

  return routes;
}

const STATUSES: string[] = ["received", "processing", "archiving", "needs_review", "archived", "failed"];

/** 动作的目标说明（管理页展示：针对图片还是评论）。 */
const ACTION_TARGETS: Record<string, string> = {
  retry: "处理流程",
  recheck: "任务核对",
  "force-create": "任务创建",
  retry_comment: "评论",
  replace_upload: "图片",
  retry_log: "日志",
};

/**
 * 动作风险说明。retry_comment 即使先查重也仍可能产生重复评论（远端列表与写入之间存在竞态），
 * 管理页必须把这一点明确展示给操作人。
 */
const ACTION_NOTES: Record<string, string> = {
  retry_comment:
    "重发前会先按反馈 ID + 截图摘要查重，只有未命中才会发送一次；但远端列表与写入之间存在竞态，仍可能产生重复评论，请在 Kaneo 中复核。",
  replace_upload: "会申请新上传地址并复用原任务替换图片；旧对象与旧 key 记录保留，不自动删除远端文件。",
  recheck: "只读取远端结果并确认，不会重发任何评论或图片。",
  "force-create": "仅在确认 Kaneo 中不存在对应任务时使用，可能产生重复任务。",
  retry_log: "针对指定日志文件重新执行上传、远端 SHA-256 摘要核对并补发评论。",
};

/**
 * 4.4：当前允许的人工动作（管理页据此只显示可用操作并说明目标）。
 * - failed → retry；
 * - needs_review → recheck 恒可用；已有 task ID 且资产已知 → retry_comment；
 *   已有 task ID 且有截图 → replace_upload（**过期/被拒绝的上传的唯一出路**，不要求资产已知）；
 *   仅当任务创建结果未知且无任何已知 task/附件状态 → force-create；
 *   已有 task ID 且含未确认日志 → retry_log。
 */
function recoveryInfo(db: Db, row: FeedbackRow) {
  const parsed = parseArchiveData(row.archive_data_json);
  const data = parsed.kind === "valid" ? parsed.data : null;
  const revision = data ? data.revision : 0;
  const uploadOutcome = data ? (data.upload?.outcome ?? null) : null;
  const assetKnown = data ? Boolean(data.asset?.url) : false;
  const commentOutcome = data ? (data.comment?.outcome ?? null) : null;
  const hasKnownTask = Boolean(row.kaneo_task_id);
  const attachments = data && "attachments" in data && data.attachments ? data.attachments : {};
  const knownAttachment =
    Boolean(data) && Boolean(data?.upload || data?.asset || data?.comment || Object.keys(attachments).length > 0);
  const hasScreenshot = getFeedbackScreenshotMeta(db, row.id) !== null;
  const logs = getFeedbackLogsMeta(db, row.id);
  const pendingLogIds = logs
    .filter((l) => {
      const att = attachments[l.id];
      return att?.comment?.outcome !== "confirmed";
    })
    .map((l) => l.id);

  const allowedActions: string[] = [];
  if (row.status === "failed") allowedActions.push("retry");
  if (row.status === "needs_review") {
    allowedActions.push("recheck");
    if (!hasKnownTask && !knownAttachment) allowedActions.push("force-create");
    if (hasKnownTask && assetKnown) allowedActions.push("retry_comment");
    if (hasKnownTask && hasScreenshot) allowedActions.push("replace_upload");
    if (hasKnownTask && pendingLogIds.length > 0) allowedActions.push("retry_log");
  }
  return {
    revision,
    stage: row.archive_stage,
    uploadOutcome,
    assetKnown,
    commentOutcome,
    hasScreenshot,
    allowedActions,
    actionTargets: ACTION_TARGETS,
    actionNotes: ACTION_NOTES,
    pendingLogIds,
  };
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function deleteSetting(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
