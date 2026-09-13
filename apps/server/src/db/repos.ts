import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.ts";

export type { Db };

import { nowIso } from "./db.ts";

export type FeedbackStatus = "received" | "processing" | "archiving" | "needs_review" | "archived" | "failed";

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
  created_at: string;
  updated_at: string;
}

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
  attempt_count: number;
  last_error: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
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
): string {
  const payload: Record<string, unknown> = { appId, text, context: context ?? null };
  if (screenshot) {
    payload.screenshotSha256 = screenshot.sha256;
    if (screenshot.releasePoint) {
      payload.releasePoint = screenshot.releasePoint;
    }
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

export function listApps(db: Db): AppRow[] {
  return db.prepare("SELECT * FROM apps ORDER BY created_at").all() as unknown as AppRow[];
}

export function getAppByAppId(db: Db, appId: string): AppRow | null {
  return (db.prepare("SELECT * FROM apps WHERE app_id = ?").get(appId) as unknown as AppRow) ?? null;
}

export function getApp(db: Db, id: string): AppRow | null {
  return (db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as unknown as AppRow) ?? null;
}

export function insertApp(
  db: Db,
  input: { appId: string; name: string; allowedOrigins: string[]; kaneoProjectId: string; kaneoColumnSlug: string },
): AppRow {
  const now = nowIso();
  const row: AppRow = {
    id: randomUUID(),
    app_id: input.appId,
    name: input.name,
    allowed_origins: JSON.stringify(input.allowedOrigins),
    kaneo_project_id: input.kaneoProjectId,
    kaneo_column_slug: input.kaneoColumnSlug,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.app_id, row.name, row.allowed_origins, row.kaneo_project_id, row.kaneo_column_slug, now, now);
  return row;
}

export function updateApp(
  db: Db,
  id: string,
  input: { name: string; allowedOrigins: string[]; kaneoProjectId: string; kaneoColumnSlug: string },
): boolean {
  const r = db
    .prepare(
      `UPDATE apps SET name = ?, allowed_origins = ?, kaneo_project_id = ?, kaneo_column_slug = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.name, JSON.stringify(input.allowedOrigins), input.kaneoProjectId, input.kaneoColumnSlug, nowIso(), id);
  return Number(r.changes) > 0;
}

export function deleteApp(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM apps WHERE id = ?").run(id).changes) > 0;
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
    attempt_count: 0,
    last_error: null,
    error_summary: null,
    created_at: now,
    updated_at: now,
  };

  db.exec("BEGIN");
  try {
    insertFeedbackRow(db, row, screenshot ?? null, now);
    db.exec("COMMIT");
    return row;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
       attempt_count, last_error, error_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, NULL, NULL, 'task_pending', NULL, 0, NULL, NULL, ?, ?)`,
  ).run(
    row.id,
    row.app_row_id,
    row.app_id,
    row.user_id,
    row.text,
    row.context_json,
    row.idempotency_key,
    row.content_hash,
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

/** 原子提交结果（区分「已创建」「幂等重放」「冲突」「账号失效」「额度用尽」）。 */
export type SubmitOutcome =
  | { kind: "created"; row: FeedbackRow; quota: Quota }
  | { kind: "replayed"; row: FeedbackRow; quota: Quota }
  | { kind: "conflict" }
  | { kind: "account_invalid" }
  | { kind: "quota_exceeded"; quota: Quota };

/**
 * 在单个事务内完成：重新核验账号有效性 → 检查幂等记录 → 检查当日额度 →
 * 保存反馈与截图 → 增加用量 → 提交。事务中不执行任何异步 / 网络 / 图片处理
 * （图片校验必须在调用前完成）。
 *
 * 幂等语义（保留全局唯一键约束）：
 * - 同账号、同键、同内容 → 返回原记录，不扣次数（额度已满也允许重放）；
 * - 同键被其他账号占用，或同键不同内容 → 统一 conflict（不透露原记录）。
 */
export function submitFeedbackAtomic(
  db: Db,
  input: {
    userId: string;
    appId: string;
    appRowId: string;
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

    // 2. 幂等记录（先于额度检查：额度已满也必须允许重放原结果）
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

    // 3. 当日额度（日期与 resetAt 均由服务端时钟产生）
    const at = clock();
    const day = beijingDay(at);
    const quota = makeQuota(user.daily_limit, getDailyUsed(db, user.id, day), beijingResetAt(at));
    if (quota.remaining <= 0) {
      db.exec("ROLLBACK");
      return { kind: "quota_exceeded", quota };
    }

    // 4. 保存反馈与截图
    const now = new Date(at).toISOString();
    const row: FeedbackRow = {
      id: randomUUID(),
      app_row_id: input.appRowId,
      app_id: input.appId,
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
      attempt_count: 0,
      last_error: null,
      error_summary: null,
      created_at: now,
      updated_at: now,
    };
    insertFeedbackRow(db, row, screenshot ?? null, now);

    // 5. 增加用量（同日 upsert）
    db.prepare(
      `INSERT INTO daily_usage (user_id, day, used, reset_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET used = used + 1`,
    ).run(user.id, day, quota.resetAt);

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
      | "attempt_count"
      | "last_error"
      | "error_summary"
    >
  >,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]) as import("node:sqlite").SQLInputValue[];
  db.prepare(`UPDATE feedbacks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
}

export function listFeedbacks(
  db: Db,
  filter: { status?: FeedbackStatus; appId?: string; cursor?: string; limit: number },
): { items: (FeedbackRow & { has_screenshot?: number; username?: string | null })[]; nextCursor: string | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    where.push("f.status = ?");
    params.push(filter.status);
  }
  if (filter.appId) {
    where.push("f.app_id = ?");
    params.push(filter.appId);
  }
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
              (SELECT 1 FROM feedback_screenshots s WHERE s.feedback_id = f.id) AS has_screenshot
       FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id ${w}
       ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    )
    .all(...params, filter.limit + 1) as unknown as (FeedbackRow & {
    has_screenshot?: number;
    username?: string | null;
  })[];
  const hasMore = rows.length > filter.limit;
  const items = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null };
}

/** 崩溃恢复：需要重新入队的记录。processing/received 直接重跑；archiving 视为结果不确定。 */
export function findResumable(db: Db): { requeue: FeedbackRow[]; uncertain: FeedbackRow[] } {
  const requeue = db
    .prepare("SELECT * FROM feedbacks WHERE status IN ('received','processing') ORDER BY created_at")
    .all() as unknown as FeedbackRow[];
  const uncertain = db
    .prepare("SELECT * FROM feedbacks WHERE status = 'archiving' ORDER BY created_at")
    .all() as unknown as FeedbackRow[];
  return { requeue, uncertain };
}

/** 管理列表用的轻量字段。 */
export function toAdminListItem(r: FeedbackRow & { has_screenshot?: number; username?: string | null }) {
  return {
    id: r.id,
    appId: r.app_id,
    username: r.username ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    title: r.title,
    kaneoUrl: r.kaneo_task_url,
    errorSummary: r.error_summary,
    archiveStage: r.archive_stage,
    hasScreenshot: Boolean(r.has_screenshot),
  };
}
