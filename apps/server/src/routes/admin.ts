import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { createRateLimiter } from "../auth/ratelimit.ts";
import { encryptSecret } from "../crypto/secret.ts";
import {
  type AdminFeedbackRow,
  type AppRow,
  type AppSourceRow,
  authorizeArchiveInTx,
  type ClassificationPatch,
  classificationLocked,
  clearAppConfigBlocks,
  confirmAppSourceInTx,
  createUser,
  type Db,
  deleteApp,
  disableAutoArchiveInTx,
  enableAutoArchiveInTx,
  FEEDBACK_STATUSES,
  type FeedbackRow,
  type FeedbackStatus,
  getApp,
  getAppByAppId,
  getAppSource,
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
  insertFeedbackAudit,
  isAppRuleComplete,
  listAppSources,
  listApps,
  listAppsWithStats,
  listFeedbackAudit,
  listFeedbacks,
  listOrdinaryUsers,
  parseAppLabelIds,
  parseClassification,
  registerConfirmedSources,
  revokeUserSessions,
  saveClassificationInTx,
  setSetting,
  setUserPassword,
  toAdminListItem,
  toAppSourceView,
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
import {
  type ArchiveDataNext,
  type ArchiveLabelRecord,
  ArchiveVersionConflictError,
  loadArchiveData,
  normalizeToV3,
  parseArchiveData,
  saveArchiveData,
  writeArchiveSnapshot,
} from "../pipeline/archive-data.ts";
import type { Worker } from "../pipeline/worker.ts";
import type { AiClient } from "../services/ai.ts";
import { ArchiveTargetInvalidError, resolveArchiveTarget } from "../services/archive-target.ts";
import type { KaneoClient } from "../services/kaneo.ts";
import { normalizeKaneoApiBase } from "../services/kaneo-http.ts";
import type { PublicApp } from "../types.ts";

export interface AdminDeps {
  db: Db;
  masterKey: Buffer;
  config: ServerConfig;
  kaneo: KaneoClient;
  ai: AiClient;
  /** 归档授权后入队：worker 是唯一的远端写入驱动者。 */
  worker: Worker;
}

function publicApp(
  r: AppRow,
  stats?: { pendingSources: number; confirmedSources: number; waitingFeedbacks: number },
): PublicApp {
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
    /** ---- v7：先接收后配置 / 自动归档 ---- */
    nameSource: r.name_source,
    configStatus: r.config_status,
    archiveMode: r.archive_mode,
    ruleVersion: r.rule_version,
    defaults: {
      projectId: r.kaneo_project_id,
      columnId: r.kaneo_column_id,
      columnSlug: r.kaneo_column_slug,
      labelIds: parseAppLabelIds(r.kaneo_label_ids),
      assigneeId: r.kaneo_assignee_id,
      assigneeName: r.kaneo_assignee_name,
    },
    ruleComplete: isAppRuleComplete(r),
    autoEnabledAt: r.auto_enabled_at,
    autoEnabledBy: r.auto_enabled_by,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    pendingSources: stats?.pendingSources ?? 0,
    confirmedSources: stats?.confirmedSources ?? 0,
    waitingFeedbacks: stats?.waitingFeedbacks ?? 0,
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

  /** 当前管理员操作者（管理动作留痕用）；非管理员返回可直接返回的响应。 */
  function adminActor(
    db: Db,
    c: Parameters<typeof requireAdminCookie>[1],
  ): { id: string; username: string } | Response {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const user = sessionUser(db, s);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    return { id: user.id, username: user.username };
  }

  /** 触发一次可恢复的自动归档扫描（启用规则 / 确认来源 / 修正规则后补处理积压）。 */
  function workerRescan(): void {
    try {
      deps.worker.scanAutoArchive();
    } catch {
      /* 扫描失败不影响本次管理动作：下次触发或重启会重新扫描 */
    }
  }

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
  routes.get("/apps", (c) => {
    const stats = listAppsWithStats(db);
    return c.json({ apps: listApps(db).map((a) => publicApp(a, stats.get(a.id))) });
  });

  routes.post("/apps", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const v = validateAppInput(body, true);
    if ("status" in v) return fail(c, v);
    if (getAppByAppId(db, v.appId)) return fail(c, err("app_exists", "该 appId 已存在", 409));
    // 管理员显式填写的允许来源直接登记为**已确认**来源（管理员已确认过这些来源）。
    const row = insertApp(db, {
      ...v,
      sources: v.allowedOrigins.map((origin) => ({
        origin,
        kind: "browser" as const,
        status: "confirmed" as const,
      })),
    });
    return c.json(publicApp(row), 201);
  });

  /** 软件详情：配置 + 逐条来源 + 待处理数量（T2 后台需要看到“待配置/待确认来源”）。 */
  routes.get("/apps/:id", (c) => {
    const app = getApp(db, c.req.param("id"));
    if (!app) return fail(c, err("not_found", "软件配置不存在", 404));
    const stats = listAppsWithStats(db).get(app.id);
    return c.json({
      app: publicApp(app, stats),
      sources: listAppSources(db, app.id).map(toAppSourceView),
    });
  });

  /**
   * 保存软件配置（普通保存）：写名称 / 允许来源 / 默认目标（项目、列、工作区标签、负责人）。
   * **普通保存绝不触发归档**，也不改变归档模式。
   * T2 版本契约：必须带页面读到的 `expectedRuleVersion`；不一致 → `409 version_conflict`，
   * 一个字节都不写（两个管理页面不会互相覆盖配置）。保存成功推进一次规则版本。
   */
  routes.put("/apps/:id", async (c) => {
    const existing = getApp(db, c.req.param("id"));
    if (!existing) return fail(c, err("not_found", "软件配置不存在", 404));
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const expectedRuleVersion = parseExpectedRuleVersion(body.expectedRuleVersion);
    if (typeof expectedRuleVersion !== "number") return fail(c, expectedRuleVersion);
    const v = validateAppInput({ ...body, appId: existing.app_id }, false); // appId 不可改
    if ("status" in v) return fail(c, v);
    const defaults = validateAppDefaults(body);
    if ("status" in defaults) return fail(c, defaults);
    const saved = updateApp(
      db,
      existing.id,
      {
        name: v.name,
        allowedOrigins: v.allowedOrigins,
        kaneoProjectId: defaults.projectId,
        kaneoColumnSlug: defaults.columnSlug,
        kaneoColumnId: defaults.columnId,
        kaneoLabelIds: defaults.labelIds,
        kaneoAssigneeId: defaults.assigneeId,
        kaneoAssigneeName: defaults.assigneeName,
      },
      expectedRuleVersion,
    );
    if (saved.kind === "not_found") return fail(c, err("not_found", "软件配置不存在", 404));
    if (saved.kind === "version_conflict") {
      return fail(c, err("version_conflict", `规则已被修改（当前版本 ${saved.ruleVersion}），请刷新后重试`, 409));
    }
    const updated = saved.app;
    // 管理员显式放行的来源登记为已确认（既有来源状态不回退）。
    registerConfirmedSources(db, existing.id, v.allowedOrigins);
    // 规则修正后清除“规则不完整/目标失效”类阻塞，让积压重新参与扫描。
    clearAppConfigBlocks(db, existing.id);
    workerRescan();
    return c.json(publicApp(updated, listAppsWithStats(db).get(updated.id)));
  });

  routes.delete("/apps/:id", (c) => {
    const id = c.req.param("id");
    if (!listApps(db).some((a) => a.id === id)) return fail(c, err("not_found", "软件配置不存在", 404));
    deleteApp(db, id); // 历史反馈保留
    return c.body(null, 204);
  });

  // ---------- 来源确认（T2） ----------

  /**
   * `POST /api/admin/apps/:id/sources/confirm` body `{ origin, operationId, expectedRuleVersion }`：
   * 把服务端观察到的某个来源标记为「已确认」。确认后自动补处理该来源的积压反馈。
   * 两个字段都必填：
   * - `operationId` 是**一次操作的稳定幂等键**（页面为同一次点击保留同一个值，网络重试不换键）；
   * - `expectedRuleVersion` 是页面读到的规则版本，与库内不一致 → `409 version_conflict`，
   *   不确认来源、不触发任何归档（避免两个管理页面互相覆盖配置）。
   */
  routes.post("/apps/:id/sources/confirm", async (c) => {
    const app = getApp(db, c.req.param("id"));
    if (!app) return fail(c, err("not_found", "软件配置不存在", 404));
    const actor = adminActor(db, c);
    if (actor instanceof Response) return actor;
    const body = await readJson<{ origin?: unknown; operationId?: unknown; expectedRuleVersion?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const origin = typeof body.origin === "string" ? body.origin.trim() : "";
    if (!origin || origin.length > 200) {
      return fail(c, err("invalid_request", "origin 必填且不超过 200 字符", 400));
    }
    const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
    if (!operationId || operationId.length > 200) {
      return fail(c, err("invalid_request", "operationId 必填且不超过 200 字符", 400));
    }
    const expectedRuleVersion = parseExpectedRuleVersion(body.expectedRuleVersion);
    if (typeof expectedRuleVersion !== "number") return fail(c, expectedRuleVersion);

    const outcome = confirmAppSourceInTx(db, app.id, origin, { operationId, expectedRuleVersion, actor });
    if (outcome.kind === "not_found") return fail(c, err("not_found", "该来源不存在", 404));
    if (outcome.kind === "version_conflict") {
      return fail(c, err("version_conflict", `规则已被修改（当前版本 ${outcome.ruleVersion}），请刷新后重试`, 409));
    }
    if (outcome.kind === "already_confirmed") {
      return c.json({
        ok: true,
        alreadyConfirmed: true,
        source: toAppSourceView(outcome.source),
        autoArchiveEnabled: app.archive_mode === "automatic",
        backlogDispatched: false,
      });
    }
    if (!outcome.replayed) {
      // 启用/确认动作的留痕记录在 app_sources.confirmed_by / apps.auto_enabled_by 上，
      // 逐条反馈的自动授权审计由 authorizeArchiveInTx 写入 feedback_audit。
      // 该来源的“等待确认”阻塞随确认一并清除，随后由扫描补处理。
      clearAppConfigBlocks(db, app.id, { origin });
      workerRescan();
    }
    const autoArchiveEnabled = app.archive_mode === "automatic";
    return c.json({
      ok: true,
      replayed: outcome.replayed,
      source: toAppSourceView(outcome.source),
      autoArchiveEnabled,
      // 只有自动模式下的首次确认才会真的补处理积压；人工模式只登记确认。
      backlogDispatched: autoArchiveEnabled && !outcome.replayed,
    });
  });

  // ---------- 自动归档规则（T2/T3） ----------

  /**
   * `POST /api/admin/apps/:id/auto-archive/enable` body `{ expectedRuleVersion, operationId? }`：
   * 明确点击“启用自动归档并处理积压”。启用前实时核对默认目标是否仍然有效；
   * 规则不完整 / 目标失效 → 422（不写任何东西）；版本不一致 → 409；
   * 同 operationId 重放 → 幂等，不重复触发补处理。
   */
  routes.post("/apps/:id/auto-archive/enable", async (c) => {
    const app = getApp(db, c.req.param("id"));
    if (!app) return fail(c, err("not_found", "软件配置不存在", 404));
    const actor = adminActor(db, c);
    if (actor instanceof Response) return actor;
    const body = await readJson<{ operationId?: unknown; expectedRuleVersion?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const parsed = parseToggleBody(body);
    if ("status" in parsed) return fail(c, parsed);

    if (!isAppRuleComplete(app)) {
      return fail(c, err("incomplete_rule", "自动归档规则不完整：请先选择项目、目标列与至少一个工作区标签", 422));
    }
    // 启用前实时核对 Kaneo 目标（只读，不产生任何远端写入）。
    const checked = await checkRuleAgainstKaneo(db, deps.kaneo, app);
    if (checked) return fail(c, checked.err);

    const outcome = enableAutoArchiveInTx(db, app.id, {
      expectedRuleVersion: parsed.expectedRuleVersion,
      operationId: parsed.operationId,
      actor,
    });
    if (outcome.kind === "not_found") return fail(c, err("not_found", "软件配置不存在", 404));
    if (outcome.kind === "version_conflict") {
      return fail(c, err("version_conflict", `规则已被修改（当前版本 ${outcome.ruleVersion}），请刷新后重试`, 409));
    }
    if (outcome.kind === "incomplete") {
      return fail(c, err("incomplete_rule", "自动归档规则不完整，无法启用", 422));
    }
    if (!outcome.replayed) {
      workerRescan(); // 首次启用规则 → 立即补处理积压
    }
    return c.json({ ok: true, replayed: outcome.replayed, app: publicApp(outcome.app) });
  });

  /**
   * `POST /api/admin/apps/:id/auto-archive/disable` body `{ expectedRuleVersion, operationId? }`：
   * 关闭自动归档只**阻止新的授权**，已获授权的任务继续执行（不撤销任何已固定快照）。
   */
  routes.post("/apps/:id/auto-archive/disable", async (c) => {
    const app = getApp(db, c.req.param("id"));
    if (!app) return fail(c, err("not_found", "软件配置不存在", 404));
    const actor = adminActor(db, c);
    if (actor instanceof Response) return actor;
    const body = await readJson<{ operationId?: unknown; expectedRuleVersion?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const parsed = parseToggleBody(body);
    if ("status" in parsed) return fail(c, parsed);

    const outcome = disableAutoArchiveInTx(db, app.id, {
      expectedRuleVersion: parsed.expectedRuleVersion,
      operationId: parsed.operationId,
    });
    if (outcome.kind === "not_found") return fail(c, err("not_found", "软件配置不存在", 404));
    if (outcome.kind === "version_conflict") {
      return fail(c, err("version_conflict", `规则已被修改（当前版本 ${outcome.ruleVersion}），请刷新后重试`, 409));
    }
    if (outcome.kind === "incomplete") {
      // 关闭自动归档与规则完整性无关：走到这里说明状态不一致，保守拒绝而不是静默改写。
      return fail(c, err("invalid_state", "软件状态异常，请刷新后重试", 409));
    }
    return c.json({ ok: true, replayed: outcome.replayed, app: publicApp(outcome.app) });
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

  // ---------- 人工分类与归档授权（T2/T3） ----------

  /**
   * `GET /api/admin/feedback/options?projectId=<id>`：
   * 从 Kaneo 实时读取分类所需的有效选项（项目列 / 工作区级标签 / 成员）。
   * 只返回**工作区级**标签（taskId === null），避免把其他任务上的标签搬走。
   */
  routes.get("/feedback/options", async (c) => {
    const projectId = (c.req.query("projectId") ?? "").trim();
    if (!projectId || projectId.length > 200) {
      return fail(c, err("invalid_request", "projectId 必填且不超过 200 字符", 400));
    }
    try {
      const project = await deps.kaneo.getProjectInfo(projectId);
      const [columns, labels, members] = await Promise.all([
        deps.kaneo.listColumns(project.id),
        deps.kaneo.listWorkspaceLabels(project.workspaceId),
        deps.kaneo.listWorkspaceMembers(project.workspaceId),
      ]);
      return c.json({
        project: { id: project.id, name: project.name, workspaceId: project.workspaceId },
        columns: columns.map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
        labels: labels.filter((l) => l.taskId === null).map((l) => ({ id: l.id, name: l.name, color: l.color })),
        members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
      });
    } catch (errObj) {
      return c.json(
        {
          error: {
            code: "kaneo_unavailable",
            message: `读取 Kaneo 选项失败：${(errObj as Error).message.slice(0, 200)}`,
          },
        },
        502,
      );
    }
  });

  /**
   * `POST /api/admin/feedback/:id/classify`：
   * - `action=sava`（暂存）：允许缺项；完整暂存仅把状态推进到 `ready_to_archive`，绝不写远端；
   * - `action=archive`：重新读取 Kaneo 有效选项并校验项目/列/工作区标签/负责人 →
   *   事务内比较分类版本、固定归档快照、记录管理员与操作时间并入队。
   *   - 分类不完整 → `422 incomplete_classification`（无远端写入）；
   *   - 版本冲突 → `409 version_conflict`；记录已锁定/已授权 → `409 classification_locked` / `already_authorized`。
   */
  routes.post("/feedback/:id/classify", async (c) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const actorUser = sessionUser(db, s);
    if (!actorUser) return fail(c, err("unauthorized", "需要登录", 401));
    const actor = { id: actorUser.id, username: actorUser.username };

    const id = c.req.param("id");
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const parsed = parseClassifyBody(body);
    if ("status" in parsed) return fail(c, parsed);

    const row = getFeedback(db, id);
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));

    if (parsed.action === "save") {
      const outcome = saveClassificationInTx(db, id, {
        expectedVersion: parsed.version,
        patch: {
          projectId: parsed.projectId,
          columnId: parsed.columnId,
          columnSlug: parsed.columnSlug,
          labelIds: parsed.labelIds,
          assigneeId: parsed.assigneeId,
          assigneeName: parsed.assigneeName,
        },
        actor,
      });
      return classifySaveResponse(c, outcome);
    }

    // ---- action=archive：先做完整性检查，再实时核对 Kaneo 选项 ----
    if (!parsed.projectId || !parsed.columnId || parsed.labelIds.length === 0) {
      return fail(c, err("incomplete_classification", "归档前必须选择项目、目标列与至少一个工作区标签", 422));
    }
    const baseUrl = getSetting(db, "kaneo.baseUrl");
    if (!baseUrl) return fail(c, err("kaneo_unavailable", "Kaneo 连接未配置", 502));

    // 与自动归档共用同一份“实时核对目标”实现：项目 / 列 / 工作区标签 / 负责人。
    const resolved = await resolveArchiveTarget(deps.kaneo, {
      projectId: parsed.projectId,
      columnId: parsed.columnId,
      labelIds: parsed.labelIds,
      assigneeId: parsed.assigneeId,
    });
    if (!resolved.ok) {
      if (resolved.kind === "retryable") {
        return c.json(
          { error: { code: "kaneo_unavailable", message: `归档前无法核对 Kaneo 选项：${resolved.reason}` } },
          502,
        );
      }
      return fail(c, err("invalid_classification", resolved.reason, 422));
    }
    const target = resolved.target;

    const patch: ClassificationPatch = {
      projectId: target.project.id,
      columnId: target.column.id,
      columnSlug: target.column.slug,
      labelIds: target.labels.map((l) => l.id),
      assigneeId: target.assigneeId,
      assigneeName: target.assigneeName,
    };
    const apiBase = normalizeKaneoApiBase(baseUrl);

    let outcome: ReturnType<typeof authorizeArchiveInTx>;
    try {
      outcome = authorizeArchiveInTx(db, id, {
        expectedVersion: parsed.version,
        operationId: parsed.operationId,
        patch,
        actor,
        buildSnapshot: (existingRaw) => {
          const base = parseArchiveData(existingRaw);
          if (base.kind === "corrupt") {
            throw new ArchiveVersionConflictError(`归档恢复数据损坏，拒绝覆盖: ${base.reason}`);
          }
          if (base.kind === "unsupported") {
            throw new ArchiveVersionConflictError(`归档恢复数据版本 v${base.version} 不受支持，拒绝覆盖`);
          }
          return writeArchiveSnapshot(db, id, base, {
            apiBase,
            project: { id: target.project.id, workspaceId: target.project.workspaceId },
            column: { id: target.column.id, slug: target.column.slug },
            labels: target.labels,
            assigneeId: target.assigneeId,
          });
        },
      });
    } catch (errObj) {
      if (errObj instanceof ArchiveVersionConflictError) {
        return fail(c, err("persist_failed", `归档快照写入被拒绝：${errObj.message.slice(0, 200)}`, 409));
      }
      throw errObj;
    }

    if (outcome.kind === "not_found") return fail(c, err("not_found", "反馈不存在", 404));
    if (outcome.kind === "locked") {
      return fail(c, err("classification_locked", "该记录已进入归档流程或已归档，分类已锁定", 409));
    }
    if (outcome.kind === "version_conflict") {
      return fail(c, err("version_conflict", `页面数据已过期（当前分类版本 ${outcome.version}），请刷新后重试`, 409));
    }
    if (outcome.kind === "operation_conflict") {
      return fail(c, err("already_authorized", "该记录已完成归档授权，请刷新后查看", 409));
    }
    if (outcome.kind === "incomplete") {
      return fail(c, err("incomplete_classification", "分类不完整，无法归档", 422));
    }
    if (outcome.kind === "rule_changed") {
      // 人工归档不携带自动护栏，理论上不可达；保守返回冲突而不是静默继续。
      return fail(c, err("invalid_state", `归档授权被拒绝：${outcome.reason}`, 409));
    }
    if (outcome.kind === "manual_protected") {
      // 人工保护只作用于自动授权；人工入口理论上不可达，保守拒绝。
      return fail(c, err("invalid_state", "该记录已由人工处理，请刷新后重试", 409));
    }

    if (!outcome.replayed) {
      insertFeedbackAudit(db, {
        feedbackId: id,
        actor,
        action: "archive_enqueued",
        detail: { operationId: parsed.operationId, projectId: target.project.id, columnId: target.column.id },
      });
      deps.worker.enqueue(id);
    }
    const snapshotParsed = parseArchiveData(outcome.archiveDataJson);
    const revision = snapshotParsed.kind === "valid" ? snapshotParsed.data.revision : 0;
    return c.json(
      {
        ok: true,
        status: outcome.status,
        classifyVersion: outcome.classification.version,
        classification: outcome.classification,
        revision,
        archiveQueued: !outcome.replayed,
        replayed: outcome.replayed,
      },
      202,
    );
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
    const app = getApp(db, row.app_row_id);
    const listItem = toAdminListItem(adminRowWithApp(db, row));
    return c.json({
      ...listItem,
      username: submitter?.username ?? null,
      text: row.text,
      context,
      processed,
      kaneoTaskId: row.kaneo_task_id,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      recovery: recoveryInfo(db, row),
      classification: parseClassification(row),
      classificationLocked: classificationLocked(row),
      archiveAuthorized: Boolean(row.archive_authorized_at),
      archiveAuthorizedAt: row.archive_authorized_at,
      archiveOperationId: row.archive_operation_id,
      collectionState: listItem.collectionState,
      app: app
        ? {
            id: app.id,
            appId: app.app_id,
            name: app.name,
            configStatus: app.config_status,
            archiveMode: app.archive_mode,
            ruleVersion: app.rule_version,
          }
        : null,
      audit: listFeedbackAudit(db, row.id).map((a) => ({
        id: a.id,
        at: a.at,
        actor: a.actor_username,
        action: a.action,
        detail: a.detail_json ? safeParse(a.detail_json) : null,
      })),
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

interface AppDefaultsInput {
  projectId: string;
  columnId: string;
  columnSlug: string;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
}

/**
 * 解析软件默认归档目标（普通保存用）。字段缺失一律按“清空”处理（与表单行为一致），
 * 但类型非法直接拒绝——绝不把非法值写进规则。
 */
function validateAppDefaults(body: Record<string, unknown>): AppDefaultsInput | Err {
  const projectId = optionalText(body.kaneoProjectId ?? body.defaultProjectId, 200);
  const columnId = optionalText(body.kaneoColumnId ?? body.defaultColumnId, 200);
  const columnSlug = optionalText(body.kaneoColumnSlug ?? body.defaultColumnSlug, 200);
  const assigneeId = optionalText(body.kaneoAssigneeId ?? body.defaultAssigneeId, 200);
  const assigneeName = optionalText(body.kaneoAssigneeName ?? body.defaultAssigneeName, 200);
  if (!projectId.ok || !columnId.ok || !columnSlug.ok || !assigneeId.ok || !assigneeName.ok) {
    return err("invalid_request", "默认归档目标字段类型或长度非法", 400);
  }
  const rawLabels = body.kaneoLabelIds ?? body.defaultLabelIds ?? [];
  if (!Array.isArray(rawLabels)) return err("invalid_request", "标签必须是字符串数组", 400);
  const labelIds: string[] = [];
  const seen = new Set<string>();
  for (const v of rawLabels) {
    if (typeof v !== "string" || v.trim() === "" || v.length > 200) {
      return err("invalid_request", "标签含非法条目", 400);
    }
    if (!seen.has(v.trim())) {
      seen.add(v.trim());
      labelIds.push(v.trim());
    }
  }
  return {
    projectId: projectId.value ?? "",
    columnId: columnId.value ?? "",
    columnSlug: columnSlug.value ?? "",
    labelIds,
    assigneeId: assigneeId.value,
    assigneeName: assigneeName.value,
  };
}

interface ToggleBody {
  operationId: string;
  expectedRuleVersion: number;
}

/** 必填的期望规则版本（T2：旧页面写入必须显式声明它看到的版本）。 */
function parseExpectedRuleVersion(raw: unknown): number | Err {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return err("invalid_request", "expectedRuleVersion 必填，且为 ≥0 的整数（页面版本过期请刷新后重试）", 400);
  }
  return raw;
}

/** 解析规则启停请求体（操作幂等键 + 必填期望规则版本）。 */
function parseToggleBody(body: Record<string, unknown>): ToggleBody | Err {
  let operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  if (operationId.length > 200) return err("invalid_request", "operationId 过长", 400);
  if (operationId === "") operationId = randomUUID();
  const expectedRuleVersion = parseExpectedRuleVersion(body.expectedRuleVersion);
  if (typeof expectedRuleVersion !== "number") return expectedRuleVersion;
  return { operationId, expectedRuleVersion };
}

/**
 * 启用/保存规则前用 Kaneo 实时核对默认目标是否有效。
 * 只读请求；返回 null 表示有效，否则返回可返回给调用方的错误。
 */
async function checkRuleAgainstKaneo(db: Db, kaneo: KaneoClient, app: AppRow): Promise<{ err: Err } | null> {
  if (!getSetting(db, "kaneo.baseUrl")) {
    return { err: err("kaneo_unavailable", "Kaneo 连接未配置，无法启用自动归档", 502) };
  }
  const resolved = await resolveArchiveTarget(kaneo, {
    projectId: app.kaneo_project_id,
    columnId: app.kaneo_column_id,
    labelIds: parseAppLabelIds(app.kaneo_label_ids),
    assigneeId: app.kaneo_assignee_id,
  });
  if (resolved.ok) return null;
  if (resolved.kind === "retryable") {
    return { err: err("kaneo_unavailable", `无法核对 Kaneo 目标：${resolved.reason}`, 502) };
  }
  return { err: err("invalid_rule", resolved.reason, 422) };
}

/** 反馈详情用的行视图：补上软件配置与来源状态，才能算出正确的 collectionState。 */
function adminRowWithApp(db: Db, row: FeedbackRow): AdminFeedbackRow {
  const app = getApp(db, row.app_row_id);
  const source = row.source_origin ? getAppSource(db, row.app_row_id, row.source_origin) : null;
  return {
    ...row,
    app_config_status: app?.config_status ?? null,
    app_archive_mode: app?.archive_mode ?? null,
    source_status: source?.status ?? null,
  };
}

const STATUSES: string[] = FEEDBACK_STATUSES;

/** 可选字符串字段：undefined/null/空串 → null；非字符串或超长 → null 并标记非法。 */
function optionalText(v: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  if (t.length > max) return { ok: false };
  return { ok: true, value: t };
}

interface ClassifyBody {
  action: "save" | "archive";
  version: number;
  operationId: string;
  projectId: string | null;
  columnId: string | null;
  columnSlug: string | null;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
}

/** 解析分类请求体（严格校验；任何非法字段都不进入数据库）。 */
function parseClassifyBody(body: Record<string, unknown>): ClassifyBody | Err {
  const action = body.action === "archive" ? "archive" : body.action === "save" ? "save" : null;
  if (!action) return err("invalid_request", 'action 必须为 "save" 或 "archive"', 400);
  const version = body.classifyVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return err("invalid_request", "classifyVersion 必须是 ≥0 的整数", 400);
  }
  const projectId = optionalText(body.projectId, 200);
  const columnId = optionalText(body.columnId, 200);
  const columnSlug = optionalText(body.columnSlug, 200);
  const assigneeId = optionalText(body.assigneeId, 200);
  const assigneeName = optionalText(body.assigneeName, 200);
  if (!projectId.ok || !columnId.ok || !columnSlug.ok || !assigneeId.ok || !assigneeName.ok) {
    return err("invalid_request", "分类字段类型或长度非法", 400);
  }
  let labelIds: string[] = [];
  if (body.labelIds !== undefined && body.labelIds !== null) {
    if (!Array.isArray(body.labelIds)) return err("invalid_request", "labelIds 必须是字符串数组", 400);
    const seen = new Set<string>();
    for (const v of body.labelIds) {
      if (typeof v !== "string" || v.trim() === "" || v.length > 200) {
        return err("invalid_request", "labelIds 含非法条目", 400);
      }
      seen.add(v.trim());
    }
    labelIds = [...seen];
  }
  let operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  if (operationId.length > 200) return err("invalid_request", "operationId 过长", 400);
  if (action === "archive" && operationId === "") operationId = randomUUID();
  return {
    action,
    version,
    operationId,
    projectId: projectId.value,
    columnId: columnId.value,
    columnSlug: columnSlug.value,
    labelIds,
    assigneeId: assigneeId.value,
    assigneeName: assigneeName.value,
  };
}

/** 暂存保存的统一响应（缺项时状态为 needs_info，完整时仅变为 ready_to_archive）。 */
function classifySaveResponse(
  c: Parameters<typeof fail>[0],
  outcome: ReturnType<typeof saveClassificationInTx>,
): Response {
  if (outcome.kind === "not_found") return fail(c, err("not_found", "反馈不存在", 404));
  if (outcome.kind === "locked") {
    return fail(c, err("classification_locked", "该记录已进入归档流程或已归档，分类已锁定", 409));
  }
  if (outcome.kind === "version_conflict") {
    return fail(c, err("version_conflict", `页面数据已过期（当前分类版本 ${outcome.version}），请刷新后重试`, 409));
  }
  return c.json({
    ok: true,
    status: outcome.status,
    classifyVersion: outcome.classification.version,
    classification: outcome.classification,
    archiveQueued: false,
  });
}

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
    // force-create 会创建新任务（首次远端写入）：必须已有持久化的人工归档授权。
    if (!hasKnownTask && !knownAttachment && row.archive_authorized_at) allowedActions.push("force-create");
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

/** 审计 detail 的 JSON 解析（损坏时按 null 返回，绝不抛错）。 */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deleteSetting(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
