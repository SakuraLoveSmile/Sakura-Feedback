import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assistRuntimeFor, enqueueFeedbackCreatedInTx, enqueueStatusTransitionInTx } from "../assist/outbox.ts";
import type { Db } from "./db.ts";

export type { Db };

import { nowIso } from "./db.ts";

export type FeedbackStatus =
  | "received"
  | "processing"
  | "needs_info"
  | "ready_to_archive"
  | "archiving"
  | "needs_review"
  | "archived"
  | "failed";

/** 全部状态（管理页筛选与参数校验的唯一来源）。 */
export const FEEDBACK_STATUSES: FeedbackStatus[] = [
  "received",
  "processing",
  "needs_info",
  "ready_to_archive",
  "archiving",
  "needs_review",
  "archived",
  "failed",
];

export type ArchiveStage =
  | "task_pending"
  | "task_created"
  | "asset_uploading"
  | "asset_finalized"
  | "comment_pending"
  | "complete";

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  pass_hash: string;
  role: UserRole;
  enabled: number; // 0/1
  daily_limit: number;
  created_at: string;
}

/** 每日提交额度（响应契约统一结构）。 */
export interface Quota {
  dailyLimit: number;
  used: number;
  remaining: number;
  /** 下次额度刷新时间（北京时间次日零点，ISO-8601 UTC）。 */
  resetAt: string;
}

export const DEFAULT_DAILY_LIMIT = 3;

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 北京时间日期（YYYY-MM-DD）。服务端唯一时钟来源，不使用客户端时间。 */
export function beijingDay(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间某日零点对应的 UTC 毫秒。 */
function beijingDayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map((n) => Number(n));
  // Date.UTC 得到 UTC 零点，减去 8 小时即为北京当日零点。
  return Date.UTC(y as number, (m as number) - 1, d as number) - BEIJING_OFFSET_MS;
}

/** 下一次额度刷新时刻：北京时间次日零点，ISO-8601 UTC。 */
export function beijingResetAt(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(beijingDayStartMs(beijingDay(ms)) + DAY_MS).toISOString();
}

/** 由上限与已用量构造统一额度结构（remaining 不为负）。 */
export function makeQuota(dailyLimit: number, used: number, resetAt: string): Quota {
  const remaining = Math.max(0, dailyLimit - used);
  return { dailyLimit, used, remaining, resetAt };
}

export interface SessionRow {
  id: string;
  user_id: string;
  kind: "cookie" | "client" | "handshake";
  client_label: string | null;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export interface AppRow {
  id: string;
  app_id: string;
  name: string;
  allowed_origins: string; // JSON array
  kaneo_project_id: string;
  kaneo_column_slug: string;
  /** ---- v7：先接收后配置 ---- */
  name_source: "client" | "admin";
  config_status: "pending" | "configured";
  archive_mode: "manual" | "automatic";
  rule_version: number;
  kaneo_column_id: string;
  kaneo_label_ids: string; // JSON array
  kaneo_assignee_id: string | null;
  kaneo_assignee_name: string | null;
  auto_enabled_at: string | null;
  auto_enabled_by: string | null;
  auto_operation_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** ---- v8：软删除标记；非空表示已从管理面删除（历史数据保留）。 ---- */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AppSourceKind = "browser" | "native";
export type AppSourceStatus = "pending" | "confirmed";

/**
 * 无 Origin 的原生客户端来源标识。
 * 浏览器来源一律是规范化后的 `scheme://host[:port]`，不可能与该字面量冲突。
 */
export const NATIVE_SOURCE = "native";

export interface AppSourceRow {
  id: string;
  app_row_id: string;
  origin: string;
  kind: AppSourceKind;
  status: AppSourceStatus;
  first_seen_at: string;
  last_seen_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirm_operation_id: string | null;
}

export interface AppSourceView {
  origin: string;
  kind: AppSourceKind;
  status: AppSourceStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

/**
 * 该条反馈在组件侧需要显示的“等待/排队”状态（T4）。
 * 客户端据此显示“已保存，等待…”，绝不把等待归档显示为提交失败。
 */
export type CollectionState =
  | "waiting_configuration"
  | "waiting_source_confirmation"
  | "waiting_manual_archive"
  | "queued";

export interface FeedbackRow {
  id: string;
  app_row_id: string;
  app_id: string;
  user_id: string;
  text: string;
  context_json: string | null;
  idempotency_key: string;
  content_hash: string;
  status: FeedbackStatus;
  title: string | null;
  processed_json: string | null;
  kaneo_task_id: string | null;
  kaneo_task_url: string | null;
  archive_stage: ArchiveStage | null;
  archive_data_json: string | null;
  /** ---- 人工分类（T1/T2）---- */
  classify_project_id: string | null;
  classify_column_id: string | null;
  classify_column_slug: string | null;
  /** JSON 数组：工作区级标签 ID。 */
  classify_labels_json: string;
  classify_assignee_id: string | null;
  classify_assignee_name: string | null;
  classify_version: number;
  classify_updated_at: string | null;
  classify_updated_by: string | null;
  /** ---- 人工归档授权（T2/T3）---- */
  archive_authorized_at: string | null;
  archive_authorized_by: string | null;
  archive_operation_id: string | null;
  /** ---- v7：先接收后配置 / 自动归档 ---- */
  /** 授权来源：manual=管理员逐条授权，auto=自动规则授权（含启用者与规则版本）。 */
  archive_authorized_kind: "manual" | "auto" | null;
  /** 自动授权时固定的规则版本；后续改规则不重定向已授权记录。 */
  archive_rule_version: number | null;
  /** 服务端观察到的来源（浏览器 Origin，或 native）；空表示来源不可确定。 */
  source_origin: string;
  auto_blocked_kind: "retryable" | "config" | null;
  auto_blocked_reason: string | null;
  auto_attempts: number;
  auto_next_attempt_at: string | null;
  attempt_count: number;
  last_error: string | null;
  error_summary: string | null;
  /** ---- v9：本地管理生命周期（与处理状态 status 完全分离）---- */
  /** 管理区域：inbox=收件箱（默认）/ archived=已归档（本地整理）/ trash=回收站。 */
  mgmt_state: MgmtState;
  mgmt_archived_at: string | null;
  mgmt_archived_by: string | null;
  mgmt_trashed_at: string | null;
  mgmt_trashed_by: string | null;
  /** 生命周期乐观版本：管理动作逐项携带期望值，与附件恢复 revision 互不混用。 */
  lifecycle_version: number;
  /** 恢复后暂停标记（0/1）：回收站恢复出的未完成记录保持暂停，显式恢复处理后才继续。 */
  resume_paused: number;
  created_at: string;
  updated_at: string;
}

/** 本地管理区域（v9）。`view=all` 是查询口径（inbox+archived），不是存储值。 */
export type MgmtState = "inbox" | "archived" | "trash";

/** 管理生命周期动作（单条与批量共用同一业务入口）。 */
export type LifecycleAction = "archive" | "unarchive" | "trash" | "restore" | "resume_processing" | "purge";

export const LIFECYCLE_ACTIONS: LifecycleAction[] = [
  "archive",
  "unarchive",
  "trash",
  "restore",
  "resume_processing",
  "purge",
];

/** 详情/列表用的人工分类视图。 */
export interface ClassificationView {
  projectId: string | null;
  columnId: string | null;
  columnSlug: string | null;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FeedbackAuditRow {
  id: string;
  feedback_id: string;
  at: string;
  actor_user_id: string;
  actor_username: string;
  action: string;
  detail_json: string | null;
}

export interface ScreenshotRow {
  feedback_id: string;
  png_blob: Uint8Array;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  capture_json: string | null;
  created_at: string;
}

export interface ScreenshotMeta {
  feedback_id: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  capture: {
    /** 逻辑 CSS 像素视口。 */
    viewportWidth?: number;
    viewportHeight?: number;
    capturedAt?: string;
    releasePoint?: { x: number; y: number };
    /** 最终 PNG 实际输出像素（线格式定稿命名）；旧记录可缺省。 */
    pixelWidth?: number;
    pixelHeight?: number;
  } | null;
  created_at: string;
}

export interface FeedbackLogRow {
  id: string;
  feedback_id: string;
  sort_order: number;
  filename: string;
  source: "auto" | "manual";
  bytes: Uint8Array;
  byte_size: number;
  sha256: string;
  created_at: string;
}

export interface FeedbackLogMeta {
  id: string;
  feedback_id: string;
  sort_order: number;
  filename: string;
  source: "auto" | "manual";
  byte_size: number;
  sha256: string;
  created_at: string;
}

export interface LogInput {
  id?: string;
  filename: string;
  source: "auto" | "manual";
  bytes: Uint8Array;
  byteSize: number;
  sha256: string;
}

/**
 * 从 capture 元数据解析输出像素尺寸（线格式定稿：pixelWidth/pixelHeight）。
 * 缺省 → undefined（旧记录兼容；AI 提示回退逻辑视口）。
 */
export function resolveOutputPixels(
  capture: Pick<ScreenshotMeta["capture"] & Record<string, unknown>, "pixelWidth" | "pixelHeight"> | null | undefined,
): { width: number; height: number } | undefined {
  if (!capture) return undefined;
  if (typeof capture.pixelWidth === "number" && typeof capture.pixelHeight === "number") {
    return { width: capture.pixelWidth, height: capture.pixelHeight };
  }
  return undefined;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function contentHash(
  appId: string,
  text: string,
  context: unknown,
  screenshot?: { sha256: string; releasePoint?: { x: number; y: number } } | null,
  logs?: Array<{ filename: string; sha256: string; source: "auto" | "manual" }> | null,
): string {
  const payload: Record<string, unknown> = { appId, text, context: context ?? null };
  if (screenshot) {
    payload.screenshotSha256 = screenshot.sha256;
    if (screenshot.releasePoint) {
      payload.releasePoint = screenshot.releasePoint;
    }
  }
  if (logs && logs.length > 0) {
    payload.logs = logs.map((l) => ({
      filename: l.filename,
      sha256: l.sha256,
      source: l.source,
    }));
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------- users ----------

/** 最早的账号（部署初始账号，兼容旧调用点）。 */
export function getUser(db: Db): UserRow | null {
  return (db.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get() as unknown as UserRow) ?? null;
}

export function getUserById(db: Db, id: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow) ?? null;
}

export function getUserByUsername(db: Db, username: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE username = ?").get(username) as unknown as UserRow) ?? null;
}

/** 普通账号列表（账号页面只管理普通账号，管理员保留）。 */
export function listOrdinaryUsers(db: Db): UserRow[] {
  return db.prepare("SELECT * FROM users WHERE role = 'user' ORDER BY created_at").all() as unknown as UserRow[];
}

export function createUser(
  db: Db,
  username: string,
  passHash: string,
  opts: { role?: UserRole; dailyLimit?: number } = {},
): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    username,
    pass_hash: passHash,
    role: opts.role ?? "user",
    enabled: 1,
    daily_limit: opts.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    created_at: nowIso(),
  };
  db.prepare(
    "INSERT INTO users (id, username, pass_hash, role, enabled, daily_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.username, row.pass_hash, row.role, row.enabled, row.daily_limit, row.created_at);
  return row;
}

/** 更新启用状态 / 每日额度（仅普通账号由路由层限定）。返回是否命中。 */
export function updateUser(db: Db, id: string, patch: { enabled?: number; dailyLimit?: number }): boolean {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled);
  }
  if (patch.dailyLimit !== undefined) {
    sets.push("daily_limit = ?");
    values.push(patch.dailyLimit);
  }
  if (sets.length === 0) return false;
  const r = db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return Number(r.changes) > 0;
}

export function setUserPassword(db: Db, id: string, passHash: string): boolean {
  return Number(db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(passHash, id).changes) > 0;
}

/** 撤销某账号全部会话（禁用 / 重置密码时）。 */
export function revokeUserSessions(db: Db, userId: string): number {
  return Number(
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(nowIso(), userId)
      .changes,
  );
}

/** 管理员改自己凭据的结果：命中 / 账号已不存在 / 新用户名被占用。 */
export type UpdateAdminCredentialsOutcome = "updated" | "not_found" | "username_conflict";

/**
 * T2-A：管理员在同一个显式事务内改自己的用户名与密码，并撤销该账号全部会话。
 * 事务内重新读取账号（会话可能在进入路由后被撤销、禁用或删除）并复查用户名唯一性；
 * 任一步失败整体 ROLLBACK，用户名与密码都保持原值。
 * 口令哈希与校验由调用方在事务外完成（scrypt 是 CPU 密集的同步计算，不放进事务）。
 */
export function updateAdminCredentialsInTx(
  db: Db,
  input: { userId: string; newUsername?: string; newPassHash?: string },
): UpdateAdminCredentialsOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const user = getUserById(db, input.userId);
    if (!user) {
      db.exec("ROLLBACK");
      return "not_found";
    }
    if (input.newUsername !== undefined && input.newUsername !== user.username) {
      const taken = getUserByUsername(db, input.newUsername);
      if (taken && taken.id !== user.id) {
        db.exec("ROLLBACK");
        return "username_conflict";
      }
    }
    if (input.newUsername !== undefined) {
      db.prepare("UPDATE users SET username = ? WHERE id = ?").run(input.newUsername, user.id);
    }
    if (input.newPassHash !== undefined) {
      db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(input.newPassHash, user.id);
    }
    revokeUserSessions(db, user.id); // 改凭据即撤销该账号全部会话（含当前会话）
    db.exec("COMMIT");
    return "updated";
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- daily usage ----------

export function getDailyUsed(db: Db, userId: string, day: string): number {
  const row = db.prepare("SELECT used FROM daily_usage WHERE user_id = ? AND day = ?").get(userId, day) as
    | { used: number }
    | undefined;
  return row?.used ?? 0;
}

/** 读取账号当前额度（含服务端生成的北京时间日期与 resetAt）。 */
export function getQuota(db: Db, user: Pick<UserRow, "id" | "daily_limit">, at: Date | number = Date.now()): Quota {
  const day = beijingDay(at);
  return makeQuota(user.daily_limit, getDailyUsed(db, user.id, day), beijingResetAt(at));
}

// ---------- sessions ----------

export function createSession(
  db: Db,
  userId: string,
  kind: SessionRow["kind"],
  ttlMs: number,
  clientLabel?: string,
): { row: SessionRow; token: string } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const row: SessionRow = {
    id: randomUUID(),
    user_id: userId,
    kind,
    client_label: clientLabel ?? null,
    token_hash: hashToken(token),
    created_at: new Date(now).toISOString(),
    last_used_at: null,
    expires_at: new Date(now + ttlMs).toISOString(),
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO sessions (id, user_id, kind, client_label, token_hash, created_at, last_used_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(row.id, row.user_id, row.kind, row.client_label, row.token_hash, row.created_at, row.expires_at);
  return { row, token };
}

/**
 * 按令牌解析有效会话。**每次鉴权都联查账号启用状态**：
 * 账号被禁用后其既有会话立即失效（无需等会话过期）。
 */
export function findActiveSessionByToken(db: Db, token: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.enabled = 1`,
    )
    .get(hashToken(token), nowIso()) as SessionRow | undefined;
  if (row) {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
  }
  return row ?? null;
}

export function listSessions(db: Db): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .all(nowIso()) as unknown as SessionRow[];
}

export function revokeSession(db: Db, id: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
}

export function revokeSessionsByIds(db: Db, ids: string[]): number {
  const stmt = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
  let n = 0;
  for (const id of ids) {
    n += Number(stmt.run(nowIso(), id).changes);
  }
  return n;
}

// ---------- apps ----------

/** 管理面软件列表：只展示活跃记录（软删除的软件不出现在软件管理列表）。 */
export function listApps(db: Db): AppRow[] {
  return db.prepare("SELECT * FROM apps WHERE deleted_at IS NULL ORDER BY created_at").all() as unknown as AppRow[];
}

export interface AppStats {
  pendingSources: number;
  confirmedSources: number;
  /** 尚未获得归档授权、也尚无远端任务的反馈条数（等待管理员处理）。 */
  waitingFeedbacks: number;
}

/** 软件列表所需的统计（一次聚合查询，避免逐条 N+1）。 */
export function listAppsWithStats(db: Db): Map<string, AppStats> {
  const stats = new Map<string, AppStats>();
  const put = (id: string): AppStats => {
    const existing = stats.get(id);
    if (existing) return existing;
    const fresh: AppStats = { pendingSources: 0, confirmedSources: 0, waitingFeedbacks: 0 };
    stats.set(id, fresh);
    return fresh;
  };
  const sourceRows = db
    .prepare("SELECT app_row_id, status, COUNT(*) AS n FROM app_sources GROUP BY app_row_id, status")
    .all() as { app_row_id: string; status: string; n: number }[];
  for (const r of sourceRows) {
    const s = put(r.app_row_id);
    if (r.status === "confirmed") s.confirmedSources += Number(r.n);
    else s.pendingSources += Number(r.n);
  }
  const waitingRows = db
    .prepare(
      `SELECT app_row_id, COUNT(*) AS n FROM feedbacks
       WHERE archive_authorized_at IS NULL AND kaneo_task_id IS NULL AND mgmt_state = 'inbox'
       GROUP BY app_row_id`,
    )
    .all() as { app_row_id: string; n: number }[];
  for (const r of waitingRows) {
    put(r.app_row_id).waitingFeedbacks = Number(r.n);
  }
  return stats;
}

/**
 * 按外部 appId 查**活跃**软件：软删除记录不再用于提交自动发现、
 * 登录握手目标校验或后台重复登记检查；历史反馈仍按内部 id 经 `getApp` 读取。
 */
export function getAppByAppId(db: Db, appId: string): AppRow | null {
  return (
    (db.prepare("SELECT * FROM apps WHERE app_id = ? AND deleted_at IS NULL").get(appId) as unknown as AppRow) ?? null
  );
}

export function getApp(db: Db, id: string): AppRow | null {
  return (db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as unknown as AppRow) ?? null;
}

export function insertApp(
  db: Db,
  input: {
    appId: string;
    name: string;
    allowedOrigins: string[];
    kaneoProjectId: string;
    kaneoColumnSlug: string;
    /**
     * 配置状态：管理员在后台显式登记 → configured（默认）；
     * 首次提交自动发现 → pending（先接收后配置）。
     */
    configStatus?: "pending" | "configured";
    /** 名称来源：管理员登记 → admin（默认）；组件上报 → client。 */
    nameSource?: "client" | "admin";
    /** 自动发现来源（有则同时登记为待确认/已确认来源）。 */
    sources?: Array<{ origin: string; kind: AppSourceKind; status: AppSourceStatus; at?: string }>;
  },
): AppRow {
  const now = nowIso();
  const row: AppRow = {
    id: randomUUID(),
    app_id: input.appId,
    name: input.name,
    allowed_origins: JSON.stringify(input.allowedOrigins),
    kaneo_project_id: input.kaneoProjectId,
    kaneo_column_slug: input.kaneoColumnSlug,
    name_source: input.nameSource ?? "admin",
    config_status: input.configStatus ?? "configured",
    archive_mode: "manual",
    rule_version: 0,
    kaneo_column_id: "",
    kaneo_label_ids: "[]",
    kaneo_assignee_id: null,
    kaneo_assignee_name: null,
    auto_enabled_at: null,
    auto_enabled_by: null,
    auto_operation_id: null,
    first_seen_at: now,
    last_seen_at: now,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
       name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
       kaneo_assignee_id, kaneo_assignee_name, auto_enabled_at, auto_enabled_by, auto_operation_id,
       first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.app_id,
    row.name,
    row.allowed_origins,
    row.kaneo_project_id,
    row.kaneo_column_slug,
    row.name_source,
    row.config_status,
    row.archive_mode,
    row.rule_version,
    row.kaneo_column_id,
    row.kaneo_label_ids,
    row.kaneo_assignee_id,
    row.kaneo_assignee_name,
    row.auto_enabled_at,
    row.auto_enabled_by,
    row.auto_operation_id,
    row.first_seen_at,
    row.last_seen_at,
    now,
    now,
  );
  for (const s of input.sources ?? []) {
    upsertAppSourceInTx(db, row.id, s.origin, s.kind, s.status, s.at ?? now);
  }
  return row;
}

export interface AppDefaultsPatch {
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
  kaneoColumnId: string;
  kaneoLabelIds: string[];
  kaneoAssigneeId: string | null;
  kaneoAssigneeName: string | null;
}

export type AppSaveOutcome =
  | { kind: "saved"; app: AppRow; targetChanged: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; ruleVersion: number };

/**
 * 管理员保存软件配置（普通保存）。
 * **绝不触发归档**、绝不改变归档模式：只写默认目标与名称。
 * T2 版本契约：必须带页面读取到的 `expectedRuleVersion`；不一致 → `version_conflict`，
 * 一个字节都不写（避免两个管理页面互相覆盖配置）。保存成功即推进规则版本。
 * 管理员保存即视作“已配置”，并接管名称（客户端不再能覆盖）。
 */
export function updateApp(
  db: Db,
  id: string,
  input: AppDefaultsPatch,
  expectedRuleVersion: number | null = null,
): AppSaveOutcome {
  const existing = getApp(db, id);
  // 已软删除的记录拒绝配置修改（路由层同样按不存在处理）。
  if (!existing || existing.deleted_at) return { kind: "not_found" };
  if (expectedRuleVersion !== null && existing.rule_version !== expectedRuleVersion) {
    return { kind: "version_conflict", ruleVersion: existing.rule_version };
  }
  const targetChanged =
    existing.kaneo_project_id !== input.kaneoProjectId ||
    existing.kaneo_column_id !== input.kaneoColumnId ||
    existing.kaneo_column_slug !== input.kaneoColumnSlug ||
    existing.kaneo_assignee_id !== input.kaneoAssigneeId ||
    existing.kaneo_label_ids !== JSON.stringify(input.kaneoLabelIds);
  db.prepare(
    `UPDATE apps SET name = ?, name_source = 'admin', allowed_origins = ?, kaneo_project_id = ?,
       kaneo_column_slug = ?, kaneo_column_id = ?, kaneo_label_ids = ?, kaneo_assignee_id = ?,
       kaneo_assignee_name = ?, config_status = 'configured', rule_version = ?, last_seen_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name,
    JSON.stringify(input.allowedOrigins),
    input.kaneoProjectId,
    input.kaneoColumnSlug,
    input.kaneoColumnId,
    JSON.stringify(input.kaneoLabelIds),
    input.kaneoAssigneeId,
    input.kaneoAssigneeName,
    existing.rule_version + 1, // T2：每次配置保存都推进版本，使旧页面写入必然冲突
    existing.last_seen_at ?? nowIso(),
    nowIso(),
    id,
  );
  return { kind: "saved", app: getApp(db, id)!, targetChanged };
}

export type AppDeleteOutcome = "deleted" | "already_deleted" | "not_found";

/**
 * 软删除软件（T4）：事务内写 `deleted_at`、退回人工归档模式、清空自动归档操作键并推进规则版本。
 * 只标记配置本体：历史反馈、截图、日志与审计全部保留（feedbacks.app_row_id 外键仍指向本行），
 * 已授权的归档任务保留固定快照与恢复信息继续执行。删除后该记录不再参与登录握手、
 * 来源放行或任何新的自动归档授权；同 appId 的后续有效提交会创建全新的内部记录。
 * 重复删除幂等：已删除 → already_deleted（路由层同样返回 204）。
 */
export function softDeleteAppInTx(db: Db, id: string): AppDeleteOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const app = getApp(db, id);
    if (!app) {
      db.exec("ROLLBACK");
      return "not_found";
    }
    if (app.deleted_at) {
      db.exec("ROLLBACK");
      return "already_deleted";
    }
    const at = nowIso();
    db.prepare(
      `UPDATE apps SET deleted_at = ?, archive_mode = 'manual', auto_operation_id = NULL,
         rule_version = rule_version + 1, updated_at = ? WHERE id = ?`,
    ).run(at, at, id);
    db.exec("COMMIT");
    return "deleted";
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- 软件的来源（T2：待确认 / 已确认） ----------

export function listAppSources(db: Db, appRowId: string): AppSourceRow[] {
  return db
    .prepare("SELECT * FROM app_sources WHERE app_row_id = ? ORDER BY first_seen_at ASC, origin ASC")
    .all(appRowId) as unknown as AppSourceRow[];
}

export function getAppSource(db: Db, appRowId: string, origin: string): AppSourceRow | null {
  return (
    (db.prepare("SELECT * FROM app_sources WHERE app_row_id = ? AND origin = ?").get(appRowId, origin) as unknown as
      | AppSourceRow
      | undefined) ?? null
  );
}

export function toAppSourceView(r: AppSourceRow): AppSourceView {
  return {
    origin: r.origin,
    kind: r.kind,
    status: r.status,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
  };
}

/**
 * 事务内登记来源：不存在则新建（默认待确认），存在则只更新 last_seen_at。
 * 返回登记后的来源行。绝不因来源变化改动归档模式或已有授权。
 */
export function upsertAppSourceInTx(
  db: Db,
  appRowId: string,
  origin: string,
  kind: AppSourceKind,
  status: AppSourceStatus,
  at: string = nowIso(),
): AppSourceRow {
  const existing = getAppSource(db, appRowId, origin);
  if (existing) {
    db.prepare("UPDATE app_sources SET last_seen_at = ? WHERE id = ?").run(at, existing.id);
    return { ...existing, last_seen_at: at };
  }
  const row: AppSourceRow = {
    id: randomUUID(),
    app_row_id: appRowId,
    origin,
    kind,
    status,
    first_seen_at: at,
    last_seen_at: at,
    confirmed_at: status === "confirmed" ? at : null,
    confirmed_by: null,
    confirm_operation_id: null,
  };
  db.prepare(
    `INSERT INTO app_sources (id, app_row_id, origin, kind, status, first_seen_at, last_seen_at, confirmed_at, confirmed_by, confirm_operation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.app_row_id,
    row.origin,
    row.kind,
    row.status,
    row.first_seen_at,
    row.last_seen_at,
    row.confirmed_at,
    row.confirmed_by,
    row.confirm_operation_id,
  );
  return row;
}

export type SourceConfirmOutcome =
  | { kind: "confirmed"; source: AppSourceRow; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "already_confirmed"; source: AppSourceRow }
  | { kind: "version_conflict"; ruleVersion: number };

/**
 * 确认来源（管理员显式动作，带操作幂等键 + 规则版本检查，T2）：
 * - **同一 operationId 的成功重放最先判定** → 幂等返回（不重复触发补处理，也不因版本推进而误判冲突）；
 * - 软件规则版本与页面看到的不一致 → `version_conflict`：不确认来源、不触发归档；
 * - 已确认但来自其他操作 → `already_confirmed`（页面刷新即可）；
 * - 只改来源状态，**绝不修改规则版本**，也不触碰任何已授权的归档任务。
 */
export function confirmAppSourceInTx(
  db: Db,
  appRowId: string,
  origin: string,
  input: { operationId: string; expectedRuleVersion: number; actor: { id: string; username: string } },
): SourceConfirmOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = getAppSource(db, appRowId, origin);
    const app = getApp(db, appRowId);
    // 已软删除的软件拒绝一切配置修改（含来源确认）。
    if (!source || !app || app.deleted_at) {
      db.exec("ROLLBACK");
      return { kind: "not_found" };
    }
    if (source.status === "confirmed" && source.confirm_operation_id === input.operationId) {
      db.exec("ROLLBACK");
      return { kind: "confirmed", source, replayed: true };
    }
    if (app.rule_version !== input.expectedRuleVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", ruleVersion: app.rule_version };
    }
    if (source.status === "confirmed") {
      db.exec("ROLLBACK");
      return { kind: "already_confirmed", source };
    }
    const at = nowIso();
    db.prepare(
      "UPDATE app_sources SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, confirm_operation_id = ? WHERE id = ?",
    ).run(at, input.actor.id, input.operationId, source.id);
    db.exec("COMMIT");
    return {
      kind: "confirmed",
      source: {
        ...source,
        status: "confirmed",
        confirmed_at: at,
        confirmed_by: input.actor.id,
        confirm_operation_id: input.operationId,
      },
      replayed: false,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 解析软件默认标签（JSON 损坏按空数组处理）。 */
export function parseAppLabelIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 自动归档规则是否完整有效（项目 + 目标列 + 至少一个工作区标签；负责人可选）。 */
export function isAppRuleComplete(
  app: Pick<AppRow, "kaneo_project_id" | "kaneo_column_id" | "kaneo_label_ids">,
): boolean {
  return Boolean(app.kaneo_project_id && app.kaneo_column_id && parseAppLabelIds(app.kaneo_label_ids).length > 0);
}

/**
 * 管理员显式登记/放行的来源（软件配置里的允许来源）：直接记为**已确认**。
 * 已存在的来源一律不改状态——确认过一次就不会因为再次保存配置被回退。
 */
export function registerConfirmedSources(db: Db, appRowId: string, origins: string[]): number {
  let added = 0;
  for (const origin of origins) {
    if (!origin) continue;
    if (getAppSource(db, appRowId, origin)) continue;
    upsertAppSourceInTx(db, appRowId, origin, "browser", "confirmed");
    added++;
  }
  return added;
}

export type AutoArchiveToggleOutcome =
  | { kind: "ok"; app: AppRow; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; ruleVersion: number }
  | { kind: "incomplete" };

/**
 * 启用自动归档（管理员显式点击“启用自动归档并处理积压”）：
 * - 要求默认规则完整（项目 + 列 + ≥1 标签），否则 `incomplete`（不做任何写入）；
 * - 事务内比较规则版本（并发点击 / 页面过期 → version_conflict）；
 * - 同 operationId 重放 → 幂等返回，**不重复触发**补处理扫描；
 * - 只改模式与留痕；已授权的记录不受影响（关闭时同理）。
 */
export function enableAutoArchiveInTx(
  db: Db,
  appRowId: string,
  input: { expectedRuleVersion: number | null; operationId: string; actor: { id: string; username: string } },
): AutoArchiveToggleOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const app = getApp(db, appRowId);
    if (!app || app.deleted_at) {
      db.exec("ROLLBACK");
      return { kind: "not_found" };
    }
    if (app.auto_operation_id && app.auto_operation_id === input.operationId && app.archive_mode === "automatic") {
      db.exec("ROLLBACK");
      return { kind: "ok", app, replayed: true };
    }
    if (input.expectedRuleVersion !== null && app.rule_version !== input.expectedRuleVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", ruleVersion: app.rule_version };
    }
    if (!isAppRuleComplete(app)) {
      db.exec("ROLLBACK");
      return { kind: "incomplete" };
    }
    const at = nowIso();
    db.prepare(
      `UPDATE apps SET archive_mode = 'automatic', auto_enabled_at = ?, auto_enabled_by = ?,
         auto_operation_id = ?, rule_version = rule_version + 1, updated_at = ? WHERE id = ?`,
    ).run(at, input.actor.id, input.operationId, at, appRowId);
    db.exec("COMMIT");
    return { kind: "ok", app: getApp(db, appRowId)!, replayed: false };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 关闭自动归档：只阻止**新的**授权，已获授权的任务继续执行。 */
export function disableAutoArchiveInTx(
  db: Db,
  appRowId: string,
  input: { expectedRuleVersion: number | null; operationId: string },
): AutoArchiveToggleOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const app = getApp(db, appRowId);
    if (!app || app.deleted_at) {
      db.exec("ROLLBACK");
      return { kind: "not_found" };
    }
    if (app.archive_mode === "manual" && app.auto_operation_id && app.auto_operation_id === input.operationId) {
      db.exec("ROLLBACK");
      return { kind: "ok", app, replayed: true };
    }
    if (input.expectedRuleVersion !== null && app.rule_version !== input.expectedRuleVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", ruleVersion: app.rule_version };
    }
    const at = nowIso();
    db.prepare(
      "UPDATE apps SET archive_mode = 'manual', auto_operation_id = ?, rule_version = rule_version + 1, updated_at = ? WHERE id = ?",
    ).run(input.operationId, at, appRowId);
    db.exec("COMMIT");
    return { kind: "ok", app: getApp(db, appRowId)!, replayed: false };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- settings ----------

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---------- feedbacks ----------

export function insertFeedbackWithScreenshot(
  db: Db,
  input: {
    appId: string;
    appRowId: string;
    userId?: string;
    text: string;
    contextJson: string | null;
    idempotencyKey: string;
    contentHash: string;
  },
  screenshot?: {
    pngBlob: Uint8Array;
    width: number;
    height: number;
    byteSize: number;
    sha256: string;
    captureJson: string | null;
  } | null,
  logs?: LogInput[] | null,
): FeedbackRow {
  const now = nowIso();
  const row: FeedbackRow = {
    id: randomUUID(),
    app_row_id: input.appRowId,
    app_id: input.appId,
    user_id: input.userId ?? "",
    text: input.text,
    context_json: input.contextJson,
    idempotency_key: input.idempotencyKey,
    content_hash: input.contentHash,
    status: "received",
    title: null,
    processed_json: null,
    kaneo_task_id: null,
    kaneo_task_url: null,
    archive_stage: "task_pending",
    archive_data_json: null,
    classify_project_id: null,
    classify_column_id: null,
    classify_column_slug: null,
    classify_labels_json: "[]",
    classify_assignee_id: null,
    classify_assignee_name: null,
    classify_version: 0,
    classify_updated_at: null,
    classify_updated_by: null,
    archive_authorized_at: null,
    archive_authorized_by: null,
    archive_operation_id: null,
    archive_authorized_kind: null,
    archive_rule_version: null,
    source_origin: "",
    auto_blocked_kind: null,
    auto_blocked_reason: null,
    auto_attempts: 0,
    auto_next_attempt_at: null,
    attempt_count: 0,
    last_error: null,
    error_summary: null,
    mgmt_state: "inbox",
    mgmt_archived_at: null,
    mgmt_archived_by: null,
    mgmt_trashed_at: null,
    mgmt_trashed_by: null,
    lifecycle_version: 0,
    resume_paused: 0,
    created_at: now,
    updated_at: now,
  };

  db.exec("BEGIN");
  try {
    insertFeedbackRow(db, row, screenshot ?? null, now);
    const insertedLogs = logs && logs.length > 0 ? insertFeedbackLogs(db, row.id, logs, now) : [];
    // Assist：反馈首次落库事件与业务写入同事务（未接入时为 no-op）。
    enqueueFeedbackCreatedInTx(db, {
      id: row.id,
      appId: row.app_id,
      text: row.text,
      occurredAt: now,
      screenshot: screenshot ? { byteSize: screenshot.byteSize, sha256: screenshot.sha256 } : null,
      logs: insertedLogs,
    });
    db.exec("COMMIT");
    return row;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 事务内插入日志附件（供原子提交函数复用）；返回实际落库的日志描述（含生成的 id）。 */
function insertFeedbackLogs(
  db: Db,
  feedbackId: string,
  logs: LogInput[],
  now: string,
): { id: string; filename: string; source: "auto" | "manual"; byteSize: number; sha256: string }[] {
  const stmt = db.prepare(
    `INSERT INTO feedback_logs (id, feedback_id, sort_order, filename, source, bytes, byte_size, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const inserted: { id: string; filename: string; source: "auto" | "manual"; byteSize: number; sha256: string }[] = [];
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i]!;
    const id = l.id ?? randomUUID();
    stmt.run(id, feedbackId, i, l.filename, l.source, l.bytes, l.byteSize, l.sha256, now);
    inserted.push({ id, filename: l.filename, source: l.source, byteSize: l.byteSize, sha256: l.sha256 });
  }
  return inserted;
}

/** 事务内插入反馈与截图（不含 BEGIN/COMMIT，供原子提交函数复用）。 */
function insertFeedbackRow(
  db: Db,
  row: FeedbackRow,
  screenshot: {
    pngBlob: Uint8Array;
    width: number;
    height: number;
    byteSize: number;
    sha256: string;
    captureJson: string | null;
  } | null,
  now: string,
): void {
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, context_json, idempotency_key, content_hash,
       status, title, processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json,
       source_origin, attempt_count, last_error, error_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, NULL, NULL, 'task_pending', NULL, ?, 0, NULL, NULL, ?, ?)`,
  ).run(
    row.id,
    row.app_row_id,
    row.app_id,
    row.user_id,
    row.text,
    row.context_json,
    row.idempotency_key,
    row.content_hash,
    row.source_origin,
    now,
    now,
  );

  if (screenshot) {
    db.prepare(
      `INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, capture_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      screenshot.pngBlob,
      screenshot.width,
      screenshot.height,
      screenshot.byteSize,
      screenshot.sha256,
      screenshot.captureJson,
      now,
    );
  }
}

/** 原子提交结果（区分「已创建」「幂等重放」「冲突」「账号失效」「额度用尽」「已彻底删除」）。 */
export type SubmitOutcome =
  | { kind: "created"; row: FeedbackRow; quota: Quota }
  | { kind: "replayed"; row: FeedbackRow; quota: Quota }
  | { kind: "conflict" }
  | { kind: "account_invalid" }
  | { kind: "quota_exceeded"; quota: Quota }
  | { kind: "purged" };

/**
 * 首次有效提交时自动发现软件（T1）：
 * - 无**活跃**记录则在本事务内创建一条待配置软件（默认人工模式、零归档规则、来源待确认）；
 *   已软删除的同 appId 历史记录不算命中——重新发现产生全新内部 id，旧反馈仍关联原记录，
 *   新记录不继承旧配置/规则/来源授权（避免新配置误处理旧积压）；
 * - 已存在活跃记录则只刷新最后出现时间，并在名称仍由客户端提供时允许用 `appName` 补全；
 *   管理员设置过的名称、规则与来源确认一律不被覆盖；
 * - 无论新旧都登记本次观察到的来源（新建默认待确认）。
 *
 * 并发提交同一 appId：外层事务为 BEGIN IMMEDIATE（写锁串行）+ 活跃 appId 部分唯一索引，
 * 因此只会产生一条**活跃**软件记录；与软删除行不冲突（部分索引不覆盖它们）。
 */
function ensureAppForSubmissionInTx(
  db: Db,
  input: { appId: string; appName: string | null; sourceOrigin: string; sourceKind: AppSourceKind; at: string },
): AppRow {
  const now = input.at;
  let app = getAppByAppId(db, input.appId);
  if (!app) {
    const name = input.appName?.trim() || input.appId;
    db.prepare(
      `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
         name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
         kaneo_assignee_id, kaneo_assignee_name, auto_enabled_at, auto_enabled_by, auto_operation_id,
         first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '', 'client', 'pending', 'manual', 0, '', '[]', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(app_id) WHERE deleted_at IS NULL DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(randomUUID(), input.appId, name, now, now, now, now);
    app = getAppByAppId(db, input.appId);
    if (!app) throw new Error("自动发现软件失败");
  } else {
    db.prepare("UPDATE apps SET last_seen_at = ? WHERE id = ?").run(now, app.id);
    // 仅当名称仍由客户端提供时才允许组件上报的名称生效（管理员设置后不可覆盖）。
    if (input.appName && app.name_source === "client" && input.appName !== app.name) {
      db.prepare("UPDATE apps SET name = ? WHERE id = ? AND name_source = 'client'").run(input.appName, app.id);
    }
    app = getApp(db, app.id) ?? app;
  }
  upsertAppSourceInTx(db, app.id, input.sourceOrigin, input.sourceKind, "pending", now);
  return app;
}

/**
 * 在单个事务内完成：重新核验账号有效性 → 检查幂等记录 → 检查当日额度 →
 * （首次有效提交时）自动发现软件并登记来源 → 保存反馈、截图与日志 → 增加用量 → 提交。
 * 事务中不执行任何异步 / 网络 / 图片处理（图片校验必须在调用前完成）。
 *
 * 幂等与失败语义（T1）：
 * - 同账号、同键、同内容 → 返回原记录，不扣次数（额度已满也允许重放），**不创建软件**；
 * - 同键被其他账号占用，或同键不同内容 → 统一 conflict（不透露原记录）；
 * - 额度用尽 / 账号失效 → 保持未接收：不扣费、**不产生空软件**。
 */
export function submitFeedbackAtomic(
  db: Db,
  input: {
    userId: string;
    appId: string;
    /** 组件可选上报的软件名称；未提供时显示 appId（绝不覆盖管理员已设置的名称）。 */
    appName?: string | null;
    /** 服务端观察到的来源：浏览器 Origin 或 NATIVE_SOURCE（无 Origin 的原生客户端）。 */
    sourceOrigin: string;
    /** 来源类型（由路由按是否携带 Origin 判定）。 */
    sourceKind: AppSourceKind;
    text: string;
    contextJson: string | null;
    idempotencyKey: string;
    contentHash: string;
  },
  screenshot?: {
    pngBlob: Uint8Array;
    width: number;
    height: number;
    byteSize: number;
    sha256: string;
    captureJson: string | null;
  } | null,
  logs?: LogInput[] | null,
  /** 可控时钟（测试注入；生产默认系统时钟）。 */
  clock: () => number = Date.now,
): SubmitOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. 重新核验账号有效性（禁用 / 不存在都不接收新反馈）
    const user = getUserById(db, input.userId);
    if (user?.enabled !== 1) {
      db.exec("ROLLBACK");
      return { kind: "account_invalid" };
    }

    // 2. 幂等记录（先于额度检查与软件创建：额度已满也必须允许重放原结果，
    //    重放也不得凭空产生一条空软件记录）
    const existing = getFeedbackByKey(db, input.idempotencyKey);
    if (existing) {
      if (existing.user_id !== input.userId || existing.content_hash !== input.contentHash) {
        db.exec("ROLLBACK");
        return { kind: "conflict" };
      }
      const quota = getQuota(db, user, clock());
      db.exec("COMMIT");
      return { kind: "replayed", row: existing, quota };
    }

    // 2.5 彻底删除凭据（v9）：提交键已被一条已彻底删除的反馈占用 → 键永久作废。
    // 所属用户得到明确的 purged（路由映射 410）；其他用户统一 conflict，不透露记录存在过。
    const receipt = getDeletionReceiptByKeyHash(db, hashToken(input.idempotencyKey));
    if (receipt) {
      db.exec("ROLLBACK");
      return receipt.user_id === input.userId ? { kind: "purged" } : { kind: "conflict" };
    }

    // 3. 当日额度（日期与 resetAt 均由服务端时钟产生）
    const at = clock();
    const day = beijingDay(at);
    const quota = makeQuota(user.daily_limit, getDailyUsed(db, user.id, day), beijingResetAt(at));
    if (quota.remaining <= 0) {
      db.exec("ROLLBACK");
      return { kind: "quota_exceeded", quota };
    }

    // 4. 自动发现软件 + 登记来源（首次有效提交才创建；重放/失败都不会走到这里）
    const now = new Date(at).toISOString();
    const app = ensureAppForSubmissionInTx(db, {
      appId: input.appId,
      appName: input.appName ?? null,
      sourceOrigin: input.sourceOrigin,
      sourceKind: input.sourceKind,
      at: now,
    });

    // 5. 保存反馈、截图与日志
    const row: FeedbackRow = {
      id: randomUUID(),
      app_row_id: app.id,
      app_id: app.app_id,
      user_id: input.userId,
      text: input.text,
      context_json: input.contextJson,
      idempotency_key: input.idempotencyKey,
      content_hash: input.contentHash,
      status: "received",
      title: null,
      processed_json: null,
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
      archive_data_json: null,
      classify_project_id: null,
      classify_column_id: null,
      classify_column_slug: null,
      classify_labels_json: "[]",
      classify_assignee_id: null,
      classify_assignee_name: null,
      classify_version: 0,
      classify_updated_at: null,
      classify_updated_by: null,
      archive_authorized_at: null,
      archive_authorized_by: null,
      archive_operation_id: null,
      archive_authorized_kind: null,
      archive_rule_version: null,
      source_origin: input.sourceOrigin,
      auto_blocked_kind: null,
      auto_blocked_reason: null,
      auto_attempts: 0,
      auto_next_attempt_at: null,
      attempt_count: 0,
      last_error: null,
      error_summary: null,
      mgmt_state: "inbox",
      mgmt_archived_at: null,
      mgmt_archived_by: null,
      mgmt_trashed_at: null,
      mgmt_trashed_by: null,
      lifecycle_version: 0,
      resume_paused: 0,
      created_at: now,
      updated_at: now,
    };
    insertFeedbackRow(db, row, screenshot ?? null, now);
    const insertedLogs = logs && logs.length > 0 ? insertFeedbackLogs(db, row.id, logs, now) : [];

    // 6. 增加用量（同日 upsert）
    db.prepare(
      `INSERT INTO daily_usage (user_id, day, used, reset_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET used = used + 1`,
    ).run(user.id, day, quota.resetAt);

    // Assist：反馈首次落库事件与业务写入同事务（未接入时为 no-op）。
    enqueueFeedbackCreatedInTx(db, {
      id: row.id,
      appId: row.app_id,
      text: row.text,
      occurredAt: now,
      screenshot: screenshot ? { byteSize: screenshot.byteSize, sha256: screenshot.sha256 } : null,
      logs: insertedLogs,
    });

    db.exec("COMMIT");
    return { kind: "created", row, quota: makeQuota(user.daily_limit, quota.used + 1, quota.resetAt) };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertFeedback(
  db: Db,
  input: {
    appId: string;
    appRowId: string;
    userId?: string;
    text: string;
    contextJson: string | null;
    idempotencyKey: string;
    contentHash: string;
  },
): FeedbackRow {
  return insertFeedbackWithScreenshot(db, input, null);
}

export function getFeedback(db: Db, id: string): FeedbackRow | null {
  return (db.prepare("SELECT * FROM feedbacks WHERE id = ?").get(id) as unknown as FeedbackRow) ?? null;
}

export function getFeedbackByKey(db: Db, idempotencyKey: string): FeedbackRow | null {
  return (
    (db.prepare("SELECT * FROM feedbacks WHERE idempotency_key = ?").get(idempotencyKey) as unknown as FeedbackRow) ??
    null
  );
}

export function getFeedbackScreenshot(db: Db, feedbackId: string): ScreenshotRow | null {
  const row = db.prepare("SELECT * FROM feedback_screenshots WHERE feedback_id = ?").get(feedbackId) as
    | ScreenshotRow
    | undefined;
  return row ?? null;
}

export function getFeedbackScreenshotMeta(db: Db, feedbackId: string): ScreenshotMeta | null {
  const row = db
    .prepare(
      "SELECT feedback_id, width, height, byte_size, sha256, capture_json, created_at FROM feedback_screenshots WHERE feedback_id = ?",
    )
    .get(feedbackId) as
    | {
        feedback_id: string;
        width: number;
        height: number;
        byte_size: number;
        sha256: string;
        capture_json: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  let capture = null;
  if (row.capture_json) {
    try {
      capture = JSON.parse(row.capture_json);
    } catch {
      capture = null;
    }
  }
  return {
    feedback_id: row.feedback_id,
    width: row.width,
    height: row.height,
    byte_size: row.byte_size,
    sha256: row.sha256,
    capture,
    created_at: row.created_at,
  };
}

export function getFeedbackLogs(db: Db, feedbackId: string): FeedbackLogRow[] {
  return db
    .prepare("SELECT * FROM feedback_logs WHERE feedback_id = ? ORDER BY sort_order ASC")
    .all(feedbackId) as unknown as FeedbackLogRow[];
}

export function getFeedbackLogsMeta(db: Db, feedbackId: string): FeedbackLogMeta[] {
  return db
    .prepare(
      "SELECT id, feedback_id, sort_order, filename, source, byte_size, sha256, created_at FROM feedback_logs WHERE feedback_id = ? ORDER BY sort_order ASC",
    )
    .all(feedbackId) as unknown as FeedbackLogMeta[];
}

export function getFeedbackLog(db: Db, feedbackId: string, logId: string): FeedbackLogRow | null {
  const row = db.prepare("SELECT * FROM feedback_logs WHERE feedback_id = ? AND id = ?").get(feedbackId, logId) as
    | FeedbackLogRow
    | undefined;
  return row ?? null;
}

export function updateFeedback(
  db: Db,
  id: string,
  patch: Partial<
    Pick<
      FeedbackRow,
      | "status"
      | "title"
      | "processed_json"
      | "kaneo_task_id"
      | "kaneo_task_url"
      | "archive_stage"
      | "archive_data_json"
      | "classify_project_id"
      | "classify_column_id"
      | "classify_column_slug"
      | "classify_labels_json"
      | "classify_assignee_id"
      | "classify_assignee_name"
      | "classify_version"
      | "classify_updated_at"
      | "classify_updated_by"
      | "archive_authorized_at"
      | "archive_authorized_by"
      | "archive_operation_id"
      | "archive_authorized_kind"
      | "archive_rule_version"
      | "auto_blocked_kind"
      | "auto_blocked_reason"
      | "auto_attempts"
      | "auto_next_attempt_at"
      | "attempt_count"
      | "last_error"
      | "error_summary"
      | "resume_paused"
    >
  >,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]) as import("node:sqlite").SQLInputValue[];
  // Assist：status / error 字段变化可能对应故障开启·恶化·恢复事件。
  // 事件与业务更新同事务落库；未接入时走原有单语句路径，行为零变化。
  const tracked = patch.status !== undefined || patch.error_summary !== undefined || patch.last_error !== undefined;
  const rt = tracked ? assistRuntimeFor(db) : null;
  if (!rt) {
    db.prepare(`UPDATE feedbacks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    return;
  }
  const write = () => {
    const prev = getFeedback(db, id);
    db.prepare(`UPDATE feedbacks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    const after = getFeedback(db, id);
    if (prev && after) enqueueStatusTransitionInTx(db, prev.status, after);
  };
  // 已在业务事务内（分类保存/归档授权等）则追加到当前事务；否则自包事务保证「读前值+更新+事件」原子。
  if (db.isTransaction) {
    write();
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    write();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- 人工分类 / 归档授权 / 操作审计（T1-T3） ----------
/**
 * AI 整理阶段收尾（T2）：写入标题与整理结果，并把状态推进到 needs_info（等待人工分类）。
 * 状态更新带条件：若管理员已抢先完成分类，则不覆盖其状态（绝不把 ready_to_archive 打回）。
 * AI 失败时 processedJson 传 null 保留原值、标题使用原文回退值。
 */
export function finishAiOrganization(
  db: Db,
  id: string,
  input: { title: string; processedJson: string | null; errorSummary: string | null; lastError: string | null },
): void {
  db.prepare(
    `UPDATE feedbacks SET title = ?, processed_json = COALESCE(?, processed_json),
       error_summary = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(input.title, input.processedJson, input.errorSummary, input.lastError, nowIso(), id);
  db.prepare(
    `UPDATE feedbacks SET status = 'needs_info', updated_at = ?
     WHERE id = ? AND status IN ('received','processing')`,
  ).run(nowIso(), id);
}

/** 管理员提交的分类选择（保存与归档共用同一结构；缺项以 null/空数组表示）。 */
export interface ClassificationPatch {
  projectId: string | null;
  columnId: string | null;
  columnSlug: string | null;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
}

/** 解析行内分类字段（JSON 损坏按空数组处理，不抛出）。 */
export function parseClassification(
  row: Pick<
    FeedbackRow,
    | "classify_project_id"
    | "classify_column_id"
    | "classify_column_slug"
    | "classify_labels_json"
    | "classify_assignee_id"
    | "classify_assignee_name"
    | "classify_version"
    | "classify_updated_at"
    | "classify_updated_by"
  >,
): ClassificationView {
  let labelIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.classify_labels_json || "[]");
    if (Array.isArray(parsed)) labelIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    labelIds = [];
  }
  return {
    projectId: row.classify_project_id,
    columnId: row.classify_column_id,
    columnSlug: row.classify_column_slug,
    labelIds,
    assigneeId: row.classify_assignee_id,
    assigneeName: row.classify_assignee_name,
    version: row.classify_version,
    updatedAt: row.classify_updated_at,
    updatedBy: row.classify_updated_by,
  };
}

/** 分类是否完整：项目 + 目标列 + 至少一个工作区标签（负责人可选）。 */
export function isClassificationComplete(c: ClassificationView): boolean {
  return Boolean(c.projectId && c.columnId && c.columnSlug && c.labelIds.length > 0);
}

/**
 * 分类是否已锁定：已进入归档队列（已授权）、已归档、归档中，或已存在远端任务。
 * 锁定后只能沿既有恢复入口继续，不得通过分类编辑另建任务。
 */
export function classificationLocked(row: FeedbackRow): boolean {
  if (row.archive_authorized_at) return true;
  if (row.kaneo_task_id) return true;
  return row.status === "archiving" || row.status === "archived";
}

/**
 * 是否已进入**人工处理**（T3 人工保护，不新增数据库字段）：
 * - `classify_version > 0`：管理员保存过分类（含缺项暂存、清空后保存）；
 * - `classify_updated_at / classify_updated_by` 有留痕：同样视为人工编辑过。
 *
 * 自动授权写版本只发生在**授权成功之后**，因此未授权记录上的这些痕迹只可能来自人工保存；
 * 已授权记录不参与该判定（它们按固定快照继续，不需要保护）。
 */
export function isManuallyHandled(row: {
  classify_version?: number | null;
  classify_updated_at?: string | null;
  classify_updated_by?: string | null;
  archive_authorized_at?: string | null;
}): boolean {
  if (row.archive_authorized_at) return false;
  return (row.classify_version ?? 0) > 0 || Boolean(row.classify_updated_at) || Boolean(row.classify_updated_by);
}

export type ClassificationSaveOutcome =
  | { kind: "saved"; classification: ClassificationView; status: FeedbackStatus }
  | { kind: "not_found" }
  | { kind: "in_trash" }
  | { kind: "locked"; status: FeedbackStatus }
  | { kind: "version_conflict"; version: number };

/**
 * 事务内保存分类（暂存语义）：
 * - 锁定记录拒绝（locked）；
 * - classification_version 必须与调用方看到的一致（否则 version_conflict，不写入）；
 * - 完整分类 → ready_to_archive；缺项 → needs_info（暂存允许缺项）。
 */
export function saveClassificationInTx(
  db: Db,
  id: string,
  input: {
    expectedVersion: number;
    patch: ClassificationPatch;
    actor: { id: string; username: string };
  },
): ClassificationSaveOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getFeedback(db, id);
    if (!row) {
      db.exec("ROLLBACK");
      return { kind: "not_found" };
    }
    // 回收站记录为只读：分类保存不产生任何写入（与生命周期动作的竞争窗口在这里兜底）。
    if (row.mgmt_state === "trash") {
      db.exec("ROLLBACK");
      return { kind: "in_trash" };
    }
    if (classificationLocked(row)) {
      db.exec("ROLLBACK");
      return { kind: "locked", status: row.status };
    }
    if (row.classify_version !== input.expectedVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", version: row.classify_version };
    }
    const next = applyClassification(db, row, input.patch, input.actor, row.classify_version + 1);
    insertFeedbackAuditInTx(db, {
      feedbackId: id,
      actor: input.actor,
      action: "classify_save",
      detail: {
        projectId: next.classification.projectId,
        columnId: next.classification.columnId,
        columnSlug: next.classification.columnSlug,
        labelIds: next.classification.labelIds,
        assigneeId: next.classification.assigneeId,
        version: next.classification.version,
        status: next.status,
      },
    });
    db.exec("COMMIT");
    return { kind: "saved", classification: next.classification, status: next.status };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 事务内写分类字段并把状态推进到 ready_to_archive / needs_info。 */
function applyClassification(
  db: Db,
  row: FeedbackRow,
  patch: ClassificationPatch,
  actor: { id: string; username: string },
  version: number,
): { classification: ClassificationView; status: FeedbackStatus } {
  const view: ClassificationView = {
    projectId: patch.projectId,
    columnId: patch.columnId,
    columnSlug: patch.columnSlug,
    labelIds: patch.labelIds,
    assigneeId: patch.assigneeId,
    assigneeName: patch.assigneeName,
    version,
    updatedAt: nowIso(),
    updatedBy: actor.id,
  };
  const status: FeedbackStatus = isClassificationComplete(view) ? "ready_to_archive" : "needs_info";
  updateFeedback(db, row.id, {
    classify_project_id: view.projectId,
    classify_column_id: view.columnId,
    classify_column_slug: view.columnSlug,
    classify_labels_json: JSON.stringify(view.labelIds),
    classify_assignee_id: view.assigneeId,
    classify_assignee_name: view.assigneeName,
    classify_version: version,
    classify_updated_at: view.updatedAt,
    classify_updated_by: actor.id,
    status,
  });
  return { classification: view, status };
}

export type ArchiveAuthorizeOutcome =
  | {
      kind: "authorized";
      classification: ClassificationView;
      status: FeedbackStatus;
      archiveDataJson: string;
      replayed: boolean;
    }
  | { kind: "not_found" }
  | { kind: "in_trash" }
  | { kind: "locked"; status: FeedbackStatus }
  | { kind: "version_conflict"; version: number }
  | { kind: "operation_conflict"; operationId: string }
  | { kind: "incomplete" }
  | { kind: "manual_protected" }
  | { kind: "rule_changed"; reason: string };

/**
 * 事务内完成归档授权（T2/T3，人工与自动共用同一入口）：
 * - 锁定记录 / 已授权（不同操作标识）拒绝；
 * - classification_version 不一致 → version_conflict（不写任何内容、无远端写入）；
 * - 同操作标识重放 → 幂等返回既有授权状态（不重复入队、不重复写远端）；
 * - 自动授权额外在**事务内**复核“自动模式已启用 + 规则版本未变 + 来源已确认”，
 *   任一不成立即 `rule_changed`（停用/改规则/来源回退的竞争窗口一律不授权）；
 * - 完整校验由调用方（路由 / 扫描）在读取 Kaneo 有效选项后完成；此处只做完整性兜底；
 * - 事务内固定归档快照（含连接/项目/工作区/列/标签/负责人），记录操作者、授权来源与规则版本。
 */
export function authorizeArchiveInTx(
  db: Db,
  id: string,
  input: {
    expectedVersion: number;
    operationId: string;
    patch: ClassificationPatch;
    actor: { id: string; username: string };
    /** 授权来源（默认人工）。自动授权会写入规则版本，供审计与“改规则不重定向”追溯。 */
    kind?: "manual" | "auto";
    /** 自动授权的竞争护栏：事务内复核启用状态、规则版本与来源确认。 */
    autoGuard?: { appRowId: string; ruleVersion: number; sourceOrigin: string };
    /** 事务内基于既有恢复数据生成 V3 快照 JSON（调用方需保证连接/项目/工作区已核对）。 */
    buildSnapshot: (existingRaw: string | null, target: { projectId: string; columnSlug: string }) => string;
  },
): ArchiveAuthorizeOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getFeedback(db, id);
    if (!row) {
      db.exec("ROLLBACK");
      return { kind: "not_found" };
    }
    // 回收站记录为只读：绝不产生归档授权（也不参与自动授权）。
    if (row.mgmt_state === "trash") {
      db.exec("ROLLBACK");
      return { kind: "in_trash" };
    }
    if (row.archive_authorized_at) {
      // 同一操作标识重放：幂等返回，不产生第二次远端写入。
      // 关闭自动归档只阻止**新的**授权，因此重放检查必须早于自动护栏。
      if (row.archive_operation_id && row.archive_operation_id === input.operationId) {
        const replay = parseClassification(row);
        db.exec("COMMIT");
        return {
          kind: "authorized",
          classification: replay,
          status: row.status,
          archiveDataJson: row.archive_data_json ?? "",
          replayed: true,
        };
      }
      db.exec("ROLLBACK");
      return { kind: "operation_conflict", operationId: row.archive_operation_id ?? "" };
    }
    if (input.autoGuard) {
      const guard = input.autoGuard;
      const app = getApp(db, guard.appRowId);
      // 软删除记录在扫描取候选到事务授权之间的窗口内同样拒绝授权。
      if (!app || app.deleted_at) {
        db.exec("ROLLBACK");
        return { kind: "rule_changed", reason: "软件配置不存在或已删除" };
      }
      if (app.archive_mode !== "automatic") {
        db.exec("ROLLBACK");
        return { kind: "rule_changed", reason: "自动归档已关闭" };
      }
      if (app.rule_version !== guard.ruleVersion) {
        db.exec("ROLLBACK");
        return { kind: "rule_changed", reason: "归档规则已变更" };
      }
      const source = getAppSource(db, app.id, guard.sourceOrigin);
      if (!source || source.status !== "confirmed") {
        db.exec("ROLLBACK");
        return { kind: "rule_changed", reason: "来源尚未确认" };
      }
    }
    if (classificationLocked(row)) {
      db.exec("ROLLBACK");
      return { kind: "locked", status: row.status };
    }
    // T3 人工保护（事务内）：扫描取到候选之后管理员才保存分类的竞争窗口，
    // 在这里以同一份行快照复查；命中即拒绝自动授权，绝不覆盖人工内容。
    if (input.autoGuard && isManuallyHandled(row)) {
      db.exec("ROLLBACK");
      return { kind: "manual_protected" };
    }
    if (row.classify_version !== input.expectedVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", version: row.classify_version };
    }
    const view: ClassificationView = {
      ...input.patch,
      version: row.classify_version + 1,
      updatedAt: null,
      updatedBy: null,
    };
    view.updatedAt = nowIso();
    view.updatedBy = input.actor.id;
    if (!isClassificationComplete(view)) {
      db.exec("ROLLBACK");
      return { kind: "incomplete" };
    }
    const saved = applyClassification(db, row, input.patch, input.actor, view.version);
    const snapshotJson = input.buildSnapshot(row.archive_data_json, {
      projectId: view.projectId!,
      columnSlug: view.columnSlug!,
    });
    const at = nowIso();
    updateFeedback(db, id, {
      archive_data_json: snapshotJson,
      archive_authorized_at: at,
      archive_authorized_by: input.actor.id,
      archive_operation_id: input.operationId,
      archive_authorized_kind: input.kind ?? "manual",
      archive_rule_version: input.kind === "auto" ? (input.autoGuard?.ruleVersion ?? null) : null,
      auto_blocked_kind: null,
      auto_blocked_reason: null,
      status: "ready_to_archive",
      error_summary: null,
      // 显式“保存并同步到 Kaneo”本身就是恢复处理：解除恢复后暂停标记。
      resume_paused: 0,
    });
    insertFeedbackAuditInTx(db, {
      feedbackId: id,
      actor: input.actor,
      action: input.kind === "auto" ? "archive_auto_authorize" : "archive_authorize",
      detail: {
        operationId: input.operationId,
        projectId: view.projectId,
        columnId: view.columnId,
        columnSlug: view.columnSlug,
        labelIds: view.labelIds,
        assigneeId: view.assigneeId,
        version: saved.classification.version,
        ...(input.kind === "auto"
          ? { ruleVersion: input.autoGuard?.ruleVersion ?? null, source: input.autoGuard?.sourceOrigin ?? "" }
          : {}),
      },
    });
    db.exec("COMMIT");
    return {
      kind: "authorized",
      classification: saved.classification,
      status: "ready_to_archive",
      archiveDataJson: snapshotJson,
      replayed: false,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface FeedbackAuditInput {
  feedbackId: string;
  actor: { id: string; username: string };
  action: string;
  detail?: Record<string, unknown>;
  at?: string;
}

/** 事务外写入一条审计记录（用于重试/恢复类动作）。 */
export function insertFeedbackAudit(db: Db, input: FeedbackAuditInput): void {
  insertFeedbackAuditInTx(db, input);
}

function insertFeedbackAuditInTx(db: Db, input: FeedbackAuditInput): void {
  db.prepare(
    `INSERT INTO feedback_audit (id, feedback_id, at, actor_user_id, actor_username, action, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.feedbackId,
    input.at ?? nowIso(),
    input.actor.id,
    input.actor.username,
    input.action,
    input.detail ? JSON.stringify(input.detail) : null,
  );
}

/** 详情页审计记录（按时间正序）。 */
export function listFeedbackAudit(db: Db, feedbackId: string, limit = 100): FeedbackAuditRow[] {
  return db
    .prepare("SELECT * FROM feedback_audit WHERE feedback_id = ? ORDER BY at ASC, id ASC LIMIT ?")
    .all(feedbackId, limit) as unknown as FeedbackAuditRow[];
}

/** 管理列表筛选（v9）：view=管理区域，q=关键词（标题/原文/反馈 ID），from/to=创建时间 UTC 半开区间。 */
export interface FeedbackListFilter {
  /** 管理区域：默认 inbox；all 表示 inbox+archived（兼容旧查询，**不含回收站**）。 */
  view?: MgmtState | "all";
  status?: FeedbackStatus;
  appId?: string;
  q?: string;
  /** ISO-8601 UTC；created_at >= from（含边界）。 */
  from?: string;
  /** ISO-8601 UTC；created_at < to（不含边界，调用方传入本地日期末端的下一刻）。 */
  to?: string;
  cursor?: string;
  limit: number;
}

/** LIKE 通配符按字面处理：搜索词中的 % _ \ 一律转义，绝不当作模式字符。 */
function escapeLikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 列表与区域计数共用的过滤条件。`skipView` 用于跨区域计数（不按管理区域过滤）。 */
function feedbackFilterWhere(
  filter: Omit<FeedbackListFilter, "cursor" | "limit">,
  opts: { skipView?: boolean } = {},
): {
  where: string[];
  params: (string | number)[];
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.skipView) {
    const view = filter.view ?? "inbox";
    if (view === "all") {
      where.push("f.mgmt_state IN ('inbox','archived')");
    } else {
      where.push("f.mgmt_state = ?");
      params.push(view);
    }
  }
  if (filter.status) {
    where.push("f.status = ?");
    params.push(filter.status);
  }
  if (filter.appId) {
    where.push("f.app_id = ?");
    params.push(filter.appId);
  }
  if (filter.q) {
    const pat = `%${escapeLikeLiteral(filter.q)}%`;
    where.push("(f.title LIKE ? ESCAPE '\\' OR f.text LIKE ? ESCAPE '\\' OR f.id LIKE ? ESCAPE '\\')");
    params.push(pat, pat, pat);
  }
  if (filter.from) {
    where.push("f.created_at >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    where.push("f.created_at < ?");
    params.push(filter.to);
  }
  return { where, params };
}

export function listFeedbacks(
  db: Db,
  filter: FeedbackListFilter,
): {
  items: AdminFeedbackRow[];
  nextCursor: string | null;
} {
  const { where, params } = feedbackFilterWhere(filter);
  if (filter.cursor) {
    const [createdAt, id] = filter.cursor.split("|");
    if (createdAt && id) {
      where.push("(f.created_at < ? OR (f.created_at = ? AND f.id < ?))");
      params.push(createdAt, createdAt, id);
    } else {
      where.push("f.created_at < ?");
      params.push(filter.cursor);
    }
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT f.*, u.username AS username,
              a.name AS app_name,
              a.config_status AS app_config_status, a.archive_mode AS app_archive_mode,
              a.deleted_at AS app_deleted_at,
              s.status AS source_status,
              SUBSTR(f.text, 1, 240) AS text_preview,
              (SELECT 1 FROM feedback_screenshots sc WHERE sc.feedback_id = f.id) AS has_screenshot,
              (SELECT COUNT(*) FROM feedback_logs l WHERE l.feedback_id = f.id) AS log_count
       FROM feedbacks f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN apps a ON a.id = f.app_row_id
       LEFT JOIN app_sources s ON s.app_row_id = a.id AND s.origin = f.source_origin
       ${w}
       ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    )
    .all(...params, filter.limit + 1) as unknown as AdminFeedbackRow[];
  const hasMore = rows.length > filter.limit;
  const items = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null };
}

/** 三个管理区域的数量（共用当前搜索与筛选条件；回收站永远单独计数）。 */
export function countFeedbacksByMgmt(
  db: Db,
  filter: Omit<FeedbackListFilter, "cursor" | "limit" | "view">,
): { inbox: number; archived: number; trash: number } {
  const { where, params } = feedbackFilterWhere(filter, { skipView: true });
  const counts = { inbox: 0, archived: 0, trash: 0 };
  const rows = db
    .prepare(
      `SELECT f.mgmt_state AS mgmt, COUNT(*) AS n FROM feedbacks f
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY f.mgmt_state`,
    )
    .all(...params) as { mgmt: string; n: number }[];
  for (const r of rows) {
    if (r.mgmt === "inbox") counts.inbox = Number(r.n);
    else if (r.mgmt === "archived") counts.archived = Number(r.n);
    else if (r.mgmt === "trash") counts.trash = Number(r.n);
  }
  return counts;
}

/**
 * 反馈筛选用的软件选项：按 app_id 聚合（含已删除软件的历史反馈）。
 * 同 appId 有多行（软删除 + 重新发现）时取最新一条反馈对应软件的名称。
 */
export function listFeedbackAppOptions(db: Db): { appId: string; name: string; deleted: boolean }[] {
  const rows = db
    .prepare(
      `SELECT f.app_id AS app_id, a.name AS name, a.deleted_at AS deleted_at, MAX(f.created_at) AS latest
       FROM feedbacks f LEFT JOIN apps a ON a.id = f.app_row_id
       GROUP BY f.app_id ORDER BY latest DESC`,
    )
    .all() as { app_id: string; name: string | null; deleted_at: string | null; latest: string }[];
  return rows.map((r) => ({ appId: r.app_id, name: r.name ?? r.app_id, deleted: r.deleted_at != null }));
}

/** 崩溃恢复：需要重新入队的记录。received/processing 只做 AI 整理（零远端写入）；
 *  ready_to_archive 仅在**已持久化人工归档授权**时重新入队；archiving 视为结果不确定。
 *  v9：回收站与恢复后暂停的记录一律不重新入队（mgmt_state/resume_paused 过滤）；
 *  `archiving → needs_review` 只是本地状态修正（不产生任何远端写入），不受区域过滤。 */
export function findResumable(db: Db): {
  requeue: FeedbackRow[];
  uncertain: FeedbackRow[];
  authorized: FeedbackRow[];
} {
  const requeue = db
    .prepare(
      "SELECT * FROM feedbacks WHERE status IN ('received','processing') AND mgmt_state = 'inbox' AND resume_paused = 0 ORDER BY created_at",
    )
    .all() as unknown as FeedbackRow[];
  const uncertain = db
    .prepare("SELECT * FROM feedbacks WHERE status = 'archiving' ORDER BY created_at")
    .all() as unknown as FeedbackRow[];
  // 重启扫描绝不绕过人工授权门槛：只有已写入授权时间与操作标识的记录才会被重新入队。
  const authorized = db
    .prepare(
      `SELECT * FROM feedbacks
       WHERE status = 'ready_to_archive'
         AND archive_authorized_at IS NOT NULL
         AND archive_operation_id IS NOT NULL
         AND mgmt_state = 'inbox'
         AND resume_paused = 0
       ORDER BY created_at`,
    )
    .all() as unknown as FeedbackRow[];
  return { requeue, uncertain, authorized };
}

/** 当前行可用的生命周期动作（服务端口径；worker 持锁的瞬态竞争由动作接口另行返回 busy）。 */
export function lifecycleAvailableActions(
  r: Pick<FeedbackRow, "status" | "mgmt_state" | "resume_paused">,
): LifecycleAction[] {
  if (r.mgmt_state === "trash") return ["restore", "purge"];
  if (r.mgmt_state === "archived") return ["unarchive", "trash"];
  const actions: LifecycleAction[] = [];
  if (r.status === "archived") actions.push("archive"); // 只有完整同步到 Kaneo 的反馈可本地归档
  if (r.resume_paused) actions.push("resume_processing");
  actions.push("trash");
  return actions;
}

/** 管理列表用的轻量字段。 */
export function toAdminListItem(r: AdminFeedbackRow) {
  const classification = parseClassification(r);
  return {
    id: r.id,
    appId: r.app_id,
    appName: r.app_name ?? null,
    username: r.username ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    title: r.title,
    textPreview: r.text_preview ?? null,
    kaneoUrl: r.kaneo_task_url,
    errorSummary: r.error_summary,
    archiveStage: r.archive_stage,
    hasScreenshot: Boolean(r.has_screenshot),
    logCount: r.log_count ?? 0,
    classification,
    archiveAuthorized: Boolean(r.archive_authorized_at),
    classificationLocked: classificationLocked(r),
    /** 所属软件是否已被软删除（历史反馈仍保留，供列表/详情标记）。 */
    appDeleted: r.app_deleted_at != null,
    /** ---- v7：来源、自动归档进度与阻塞原因 ---- */
    sourceOrigin: r.source_origin,
    collectionState: collectionStateOf(r),
    archiveAuthorizedKind: r.archive_authorized_kind,
    archiveRuleVersion: r.archive_rule_version,
    autoBlockedKind: r.auto_blocked_kind,
    autoBlockedReason: r.auto_blocked_reason,
    autoAttempts: r.auto_attempts,
    autoNextAttemptAt: r.auto_next_attempt_at,
    /** ---- v9：本地管理生命周期 ---- */
    mgmtState: r.mgmt_state,
    lifecycleVersion: r.lifecycle_version,
    resumePaused: Boolean(r.resume_paused),
    archivedAt: r.mgmt_archived_at,
    trashedAt: r.mgmt_trashed_at,
    availableActions: lifecycleAvailableActions(r),
  };
}

/** 管理列表行（含 apps / app_sources 的联表字段）。 */
export type AdminFeedbackRow = FeedbackRow & {
  has_screenshot?: number;
  username?: string | null;
  log_count?: number;
  app_name?: string | null;
  text_preview?: string | null;
  app_config_status?: string | null;
  app_archive_mode?: string | null;
  app_deleted_at?: string | null;
  source_status?: string | null;
};

/**
 * 组件侧展示的收集状态（T4）。
 * 优先级：已进入归档流程 → 软件待配置 → 自动模式下来源待确认 → 自动模式下的配置阻塞
 * → 人工已编辑（等待人工归档）→ 自动排队中（整理中 / 等待自动重试）。
 *
 * `queued` 表示「会自动处理，继续跟踪」；`waiting_manual_archive` 只用于**确实需要管理员
 * 逐条处理**的记录（人工模式，或自动模式但已被人工编辑过，含未授权的 `ready_to_archive`）。
 * 已授权 / 已产生远端任务的记录一律 `queued`：等待配置绝不能覆盖“已经在处理”。
 */
export function collectionStateFor(
  row: Pick<FeedbackRow, "status" | "archive_authorized_at" | "kaneo_task_id"> &
    Partial<
      Pick<FeedbackRow, "classify_version" | "classify_updated_at" | "classify_updated_by" | "auto_blocked_kind">
    >,
  app: { config_status: string; archive_mode: string } | null | undefined,
  sourceStatus: string | null | undefined,
): CollectionState {
  if (row.archive_authorized_at || row.kaneo_task_id) return "queued";
  if (row.status === "archiving" || row.status === "archived" || row.status === "needs_review") {
    return "queued";
  }
  if (!app || app.config_status !== "configured") return "waiting_configuration";
  if (app.archive_mode === "automatic") {
    if (sourceStatus !== "confirmed") return "waiting_source_confirmation";
    // 配置类阻塞（规则不完整 / 目标失效）：需要管理员修正配置，等待而不是排队。
    if (row.auto_blocked_kind === "config") return "waiting_configuration";
    // 人工已经编辑过（含缺项暂存、清空后保存、完整暂存）：继续由管理员处理，
    // 绝不谎报自动排队（`ready_to_archive` 未授权同样属于等待人工授权）。
    return isManuallyHandled(row) ? "waiting_manual_archive" : "queued";
  }
  return "waiting_manual_archive";
}

/** 列表行上的收集状态（联表字段缺省时按“未配置”处理，宁可提示等待也不谎报排队）。 */
export function collectionStateOf(r: AdminFeedbackRow): CollectionState {
  const app =
    r.app_config_status == null
      ? null
      : { config_status: r.app_config_status, archive_mode: r.app_archive_mode ?? "manual" };
  return collectionStateFor(r, app, r.source_status ?? null);
}

/** 单条反馈的收集状态（组件接口用：按行内的软件与来源现算，不依赖联表字段）。 */
export function collectionStateForFeedback(db: Db, row: FeedbackRow): CollectionState {
  const app = getApp(db, row.app_row_id);
  const source = row.source_origin ? getAppSource(db, row.app_row_id, row.source_origin) : null;
  return collectionStateFor(row, app, source?.status ?? null);
}

export type AutoBlockedKind = "retryable" | "config";

/** 可恢复故障的退避上限（毫秒）：1 分钟起指数增长，最多 30 分钟。 */
export const AUTO_BACKOFF_BASE_MS = 60_000;
export const AUTO_BACKOFF_MAX_MS = 30 * 60_000;

/** 第 n 次失败后的下次尝试时间（有上限的指数退避）。 */
export function autoBackoffUntil(attempts: number, at: Date | number = Date.now()): string {
  const exp = Math.max(1, Math.min(attempts, 5));
  const delay = Math.min(AUTO_BACKOFF_BASE_MS * 2 ** (exp - 1), AUTO_BACKOFF_MAX_MS);
  return new Date(new Date(at).getTime() + delay).toISOString();
}

/**
 * 自动归档待补处理候选（配置有效、来源已确认、尚未授权、未写入远端）。
 * T3 人工保护：已进入人工处理（`classify_version > 0` 或有人工编辑留痕）的记录**不参与**
 * 自动候选，避免扫描覆盖管理员刚保存（含清空）的分类。
 * 排除项同时覆盖：未到重试时间的可恢复退避、配置类阻塞、已授权/已有远端任务的记录。
 */
export function findAutoArchiveCandidates(db: Db, at: Date | number = Date.now(), limit = 50): FeedbackRow[] {
  const now = new Date(at).toISOString();
  return db
    .prepare(
      `SELECT f.* FROM feedbacks f
       JOIN apps a ON a.id = f.app_row_id
       JOIN app_sources s ON s.app_row_id = a.id AND s.origin = f.source_origin
       WHERE a.archive_mode = 'automatic'
         AND a.config_status = 'configured'
         AND a.deleted_at IS NULL
         AND s.status = 'confirmed'
         AND f.status = 'needs_info'
         AND f.archive_authorized_at IS NULL
         AND f.kaneo_task_id IS NULL
         AND f.source_origin <> ''
         AND f.classify_version = 0
         AND f.classify_updated_at IS NULL
         AND f.classify_updated_by IS NULL
         AND f.mgmt_state = 'inbox'
         AND f.resume_paused = 0
         AND (f.auto_blocked_kind IS NULL OR f.auto_blocked_kind = 'retryable')
         AND (f.auto_next_attempt_at IS NULL OR f.auto_next_attempt_at <= ?)
       ORDER BY f.created_at ASC, f.id ASC
       LIMIT ?`,
    )
    .all(now, limit) as unknown as FeedbackRow[];
}

/**
 * 最早到期的可恢复退避时间（毫秒时间戳），没有则返回 null。
 * 与 `findAutoArchiveCandidates` 使用同一套候选条件（只把“已到点”换成“尚未到点”），
 * 保证调度器只为真正会自动重试的记录安排定时器。
 */
export function findNextAutoRetryAt(db: Db): number | null {
  const row = db
    .prepare(
      `SELECT MIN(f.auto_next_attempt_at) AS next FROM feedbacks f
       JOIN apps a ON a.id = f.app_row_id
       JOIN app_sources s ON s.app_row_id = a.id AND s.origin = f.source_origin
       WHERE a.archive_mode = 'automatic'
         AND a.config_status = 'configured'
         AND a.deleted_at IS NULL
         AND s.status = 'confirmed'
         AND f.status = 'needs_info'
         AND f.archive_authorized_at IS NULL
         AND f.kaneo_task_id IS NULL
         AND f.source_origin <> ''
         AND f.classify_version = 0
         AND f.classify_updated_at IS NULL
         AND f.classify_updated_by IS NULL
         AND f.mgmt_state = 'inbox'
         AND f.resume_paused = 0
         AND f.auto_blocked_kind = 'retryable'
         AND f.auto_next_attempt_at IS NOT NULL`,
    )
    .get() as { next: string | null } | undefined;
  const next = row?.next ?? null;
  if (!next) return null;
  const ms = new Date(next).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 尚未完成 AI 整理的记录（AI 完成同样触发可恢复扫描）。回收站与暂停记录不参与。 */
export function findAiPendingCandidates(db: Db, limit = 50): FeedbackRow[] {
  return db
    .prepare(
      "SELECT * FROM feedbacks WHERE status IN ('received','processing') AND mgmt_state = 'inbox' AND resume_paused = 0 ORDER BY created_at ASC LIMIT ?",
    )
    .all(limit) as unknown as FeedbackRow[];
}

/** 清除自动归档阻塞标记（来源确认 / 规则修正后重新参与扫描）。 */
export function clearAutoBlocked(db: Db, feedbackId: string): void {
  db.prepare(
    "UPDATE feedbacks SET auto_blocked_kind = NULL, auto_blocked_reason = NULL, auto_attempts = 0, auto_next_attempt_at = NULL WHERE id = ?",
  ).run(feedbackId);
}

/**
 * 清除某软件下的“配置类”阻塞（不触碰可恢复故障的退避记录）：
 * - 确认来源后按来源清除；
 * - 管理员修正规则 / 重新保存配置后按软件清除。
 * 清完后由扫描 `findAutoArchiveCandidates` 重新拾起这些积压记录。
 */
export function clearAppConfigBlocks(db: Db, appRowId: string, opts: { origin?: string } = {}): number {
  if (opts.origin !== undefined) {
    return Number(
      db
        .prepare(
          "UPDATE feedbacks SET auto_blocked_kind = NULL, auto_blocked_reason = NULL, auto_attempts = 0, auto_next_attempt_at = NULL WHERE app_row_id = ? AND source_origin = ? AND auto_blocked_kind = 'config'",
        )
        .run(appRowId, opts.origin).changes,
    );
  }
  return Number(
    db
      .prepare(
        "UPDATE feedbacks SET auto_blocked_kind = NULL, auto_blocked_reason = NULL, auto_attempts = 0, auto_next_attempt_at = NULL WHERE app_row_id = ? AND auto_blocked_kind = 'config'",
      )
      .run(appRowId).changes,
  );
}

/** 记录一次自动归档阻塞（可恢复故障 → 退避；配置问题 → 等待管理员修正）。 */
export function markAutoBlocked(
  db: Db,
  feedbackId: string,
  kind: AutoBlockedKind,
  reason: string,
  attempts: number,
  at: Date | number = Date.now(),
): void {
  db.prepare(
    `UPDATE feedbacks SET auto_blocked_kind = ?, auto_blocked_reason = ?, auto_attempts = ?,
       auto_next_attempt_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    kind,
    reason.slice(0, 300),
    attempts,
    kind === "retryable" ? autoBackoffUntil(attempts, at) : null,
    new Date(at).toISOString(),
    feedbackId,
  );
}

// ---------- v9：彻底删除凭据与本地管理生命周期 ----------

/**
 * 彻底删除凭据：只保留防重放所需的最小信息（提交键摘要 + 内容摘要 + 所属用户 + 原反馈 ID + 删除时间）。
 * 不含正文、附件内容、远端 URL——已彻底删除的内容无法通过该表还原。
 */
export interface DeletionReceiptRow {
  id: string;
  feedback_id: string;
  idempotency_key_hash: string;
  content_hash: string;
  user_id: string;
  deleted_at: string;
}

/** 按原反馈 ID 查删除凭据（410 判定：所属用户/管理员可见，其他用户不泄露存在性）。 */
export function getDeletionReceiptByFeedbackId(db: Db, feedbackId: string): DeletionReceiptRow | null {
  return (
    (db
      .prepare("SELECT * FROM feedback_deletion_receipts WHERE feedback_id = ?")
      .get(feedbackId) as unknown as DeletionReceiptRow) ?? null
  );
}

/** 按提交键摘要查删除凭据（提交防重放：同一键再次出现不得新建反馈）。 */
export function getDeletionReceiptByKeyHash(db: Db, keyHash: string): DeletionReceiptRow | null {
  return (
    (db
      .prepare("SELECT * FROM feedback_deletion_receipts WHERE idempotency_key_hash = ?")
      .get(keyHash) as unknown as DeletionReceiptRow) ?? null
  );
}

export type LifecycleOutcome =
  | {
      kind: "ok";
      mgmtState: MgmtState;
      lifecycleVersion: number;
      /** resume_processing 成功后由调用方在锁外入队（避免与队列处理争锁）。 */
      enqueue: boolean;
    }
  | { kind: "purged" }
  /** 反馈行已不存在且删除凭据已存在：重复彻底删除按成功幂等处理。 */
  | { kind: "already_purged" }
  | { kind: "not_found" }
  | { kind: "version_conflict"; lifecycleVersion: number }
  | { kind: "invalid_state"; reason: string };

/**
 * 本地管理生命周期动作的事务入口（v9）。单条与批量共用：
 * 调用方逐条调用本函数，每项自带预期生命周期版本（lifecycle_version），
 * 版本不一致 → version_conflict（不写任何内容）。
 *
 * 固定规则：
 * - archive 仅允许 status='archived'（完整同步到 Kaneo）；仅存在任务 ID 不够；
 * - trash 可从 inbox/archived 进入；非终态记录同时置 resume_paused（停止自动处理）；
 * - restore 统一返回 inbox；未完成记录保持 resume_paused（不自动重发）；
 * - resume_processing 只清除暂停标记（由调用方在锁外入队，按既有状态与授权规则继续）；
 * - purge 仅限回收站记录：事务内写最小删除凭据并删除反馈及关联 BLOB/审计；
 *   不返还额度、不触碰 Kaneo、不做远端删除调用。
 *
 * 调用方负责在进入本函数前持有反馈级互斥锁（与 worker 同一套），
 * 保证“正在执行的反馈”不会被删除/移动打断。
 */
export function applyLifecycleInTx(
  db: Db,
  id: string,
  input: { action: LifecycleAction; expectedVersion: number; actor: { id: string; username: string } },
): LifecycleOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getFeedback(db, id);
    if (!row) {
      const receipt = getDeletionReceiptByFeedbackId(db, id);
      db.exec("ROLLBACK");
      // 重复彻底删除幂等成功；其他动作对不存在/已清除记录按 not_found 处理。
      if (receipt) return input.action === "purge" ? { kind: "already_purged" } : { kind: "not_found" };
      return { kind: "not_found" };
    }
    if (row.lifecycle_version !== input.expectedVersion) {
      db.exec("ROLLBACK");
      return { kind: "version_conflict", lifecycleVersion: row.lifecycle_version };
    }
    const at = nowIso();
    const nextVersion = row.lifecycle_version + 1;
    const failState = (reason: string): LifecycleOutcome => {
      db.exec("ROLLBACK");
      return { kind: "invalid_state", reason };
    };
    const ok = (mgmtState: MgmtState, enqueue = false): LifecycleOutcome => ({
      kind: "ok",
      mgmtState,
      lifecycleVersion: nextVersion,
      enqueue,
    });
    const audit = (action: string, detail?: Record<string, unknown>): void => {
      insertFeedbackAuditInTx(db, {
        feedbackId: id,
        actor: input.actor,
        action,
        detail: { expectedVersion: input.expectedVersion, lifecycleVersion: nextVersion, ...detail },
      });
    };

    switch (input.action) {
      case "archive": {
        if (row.mgmt_state !== "inbox") return failState("仅收件箱中的记录可归档");
        if (row.status !== "archived") return failState("只有完整同步到 Kaneo 的反馈才能归档");
        db.prepare(
          `UPDATE feedbacks SET mgmt_state = 'archived', mgmt_archived_at = ?, mgmt_archived_by = ?,
             resume_paused = 0, lifecycle_version = ?, updated_at = ? WHERE id = ?`,
        ).run(at, input.actor.id, nextVersion, at, id);
        audit("mgmt_archive");
        db.exec("COMMIT");
        return ok("archived");
      }
      case "unarchive": {
        if (row.mgmt_state !== "archived") return failState("仅已归档区域的记录可恢复到收件箱");
        db.prepare(
          `UPDATE feedbacks SET mgmt_state = 'inbox', mgmt_archived_at = NULL, mgmt_archived_by = NULL,
             lifecycle_version = ?, updated_at = ? WHERE id = ?`,
        ).run(nextVersion, at, id);
        audit("mgmt_unarchive");
        db.exec("COMMIT");
        return ok("inbox");
      }
      case "trash": {
        if (row.mgmt_state === "trash") return failState("该记录已在回收站");
        // 未完成记录移入回收站即暂停：不进入任何扫描与队列处理（恢复后仍保持暂停，需显式恢复）。
        const paused = row.status === "archived" ? 0 : 1;
        db.prepare(
          `UPDATE feedbacks SET mgmt_state = 'trash', mgmt_trashed_at = ?, mgmt_trashed_by = ?,
             mgmt_archived_at = NULL, mgmt_archived_by = NULL,
             resume_paused = ?, lifecycle_version = ?, updated_at = ? WHERE id = ?`,
        ).run(at, input.actor.id, paused, nextVersion, at, id);
        audit("mgmt_trash", { paused });
        db.exec("COMMIT");
        return ok("trash");
      }
      case "restore": {
        if (row.mgmt_state !== "trash") return failState("仅回收站中的记录可恢复");
        // 统一返回收件箱；未完成记录保持暂停，不自动发送。
        const paused = row.status === "archived" ? 0 : 1;
        db.prepare(
          `UPDATE feedbacks SET mgmt_state = 'inbox', mgmt_trashed_at = NULL, mgmt_trashed_by = NULL,
             mgmt_archived_at = NULL, mgmt_archived_by = NULL,
             resume_paused = ?, lifecycle_version = ?, updated_at = ? WHERE id = ?`,
        ).run(paused, nextVersion, at, id);
        audit("mgmt_restore", { paused });
        db.exec("COMMIT");
        return ok("inbox");
      }
      case "resume_processing": {
        if (row.mgmt_state !== "inbox") return failState("仅收件箱中的记录可恢复处理");
        if (row.resume_paused !== 1) return failState("该记录未处于暂停状态");
        db.prepare("UPDATE feedbacks SET resume_paused = 0, lifecycle_version = ?, updated_at = ? WHERE id = ?").run(
          nextVersion,
          at,
          id,
        );
        audit("mgmt_resume");
        db.exec("COMMIT");
        return ok("inbox", true);
      }
      case "purge": {
        if (row.mgmt_state !== "trash") return failState("仅回收站中的记录可彻底删除");
        // 事务内：最小防重放凭据 + 反馈与关联 BLOB/审计一并清除。
        // 截图/日志/审计带 ON DELETE CASCADE，这里仍显式删除（不依赖外键开关状态）。
        db.prepare(
          `INSERT INTO feedback_deletion_receipts
             (id, feedback_id, idempotency_key_hash, content_hash, user_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), row.id, hashToken(row.idempotency_key), row.content_hash, row.user_id, at);
        db.prepare("DELETE FROM feedback_screenshots WHERE feedback_id = ?").run(id);
        db.prepare("DELETE FROM feedback_logs WHERE feedback_id = ?").run(id);
        db.prepare("DELETE FROM feedback_audit WHERE feedback_id = ?").run(id);
        // 删除本地 outbox 中该反馈的正文副本；已发出的事件仅删除本地记录，
        // 不尝试撤回中枢已收到的事件。
        db.prepare(
          "DELETE FROM assist_outbox WHERE json_valid(payload_json) AND json_extract(payload_json, '$.ref.feedbackId') = ?",
        ).run(id);
        db.prepare("DELETE FROM feedbacks WHERE id = ?").run(id);
        db.exec("COMMIT");
        return { kind: "purged" };
      }
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
