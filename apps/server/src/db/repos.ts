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

export interface UserRow {
  id: string;
  username: string;
  pass_hash: string;
  created_at: string;
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

/** feedback_logs 行（含字节，仅服务端内部使用；绝不进入管理接口 JSON）。 */
export interface FeedbackLogRow {
  id: string;
  feedback_id: string;
  seq: number;
  filename: string;
  source: "auto" | "manual";
  log_blob: Uint8Array;
  byte_size: number;
  sha256: string;
  created_at: string;
}

/** 待落库的一份日志（sha256 由调用方按原始字节计算；byte_size 由 blob 长度决定）。 */
export interface NewFeedbackLog {
  filename: string;
  source: "auto" | "manual";
  blob: Uint8Array;
  sha256: string;
}

/**
 * 管理接口的日志元数据形态（与 types.ts FeedbackLogMeta 对应）。
 * `truncated` / `totalCodepoints` 由调用方按 L7 从**已落库字节**计算；
 * `archiveState` 由 `archive_data_json` 派生（L6；唯一判定见 archive-data.ts）。
 */
export function toFeedbackLogMeta(
  row: FeedbackLogRow,
  extra: { truncated: boolean; totalCodepoints: number; archiveState: "not_started" | "partial" | "confirmed" },
) {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    seq: row.seq,
    filename: row.filename,
    source: row.source,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
    truncated: extra.truncated,
    totalCodepoints: extra.totalCodepoints,
    archiveState: extra.archiveState,
  };
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
  logs?: { sha256: string; byteSize: number }[] | null,
): string {
  const payload: Record<string, unknown> = { appId, text, context: context ?? null };
  if (screenshot) {
    payload.screenshotSha256 = screenshot.sha256;
    if (screenshot.releasePoint) {
      payload.releasePoint = screenshot.releasePoint;
    }
  }
  // 日志键只在非空时追加在最末：无日志时输出必须与旧算法逐字节相同（L4）。
  if (logs && logs.length > 0) {
    payload.logs = logs.map((l) => ({ sha256: l.sha256, byteSize: l.byteSize }));
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------- users ----------

export function getUser(db: Db): UserRow | null {
  return (db.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get() as unknown as UserRow) ?? null;
}

export function createUser(db: Db, username: string, passHash: string): UserRow {
  const row: UserRow = { id: randomUUID(), username, pass_hash: passHash, created_at: nowIso() };
  db.prepare("INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.username,
    row.pass_hash,
    row.created_at,
  );
  return row;
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

export function findActiveSessionByToken(db: Db, token: string): SessionRow | null {
  const row = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
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
  logs?: NewFeedbackLog[] | null,
): FeedbackRow {
  const now = nowIso();
  const row: FeedbackRow = {
    id: randomUUID(),
    app_row_id: input.appRowId,
    app_id: input.appId,
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
    db.prepare(
      `INSERT INTO feedbacks (id, app_row_id, app_id, text, context_json, idempotency_key, content_hash,
         status, title, processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json,
         attempt_count, last_error, error_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, NULL, NULL, 'task_pending', NULL, 0, NULL, NULL, ?, ?)`,
    ).run(
      row.id,
      row.app_row_id,
      row.app_id,
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

    // 日志与反馈、截图同事务：任一行失败全部回滚（L5.5），绝不残留半条记录。
    // 同一反馈的所有日志行使用同一时间戳。
    let seq = 0;
    for (const log of logs ?? []) {
      db.prepare(
        `INSERT INTO feedback_logs (id, feedback_id, seq, filename, source, log_blob, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), row.id, seq, log.filename, log.source, log.blob, log.blob.byteLength, log.sha256, now);
      seq += 1;
    }
    db.exec("COMMIT");
    return row;
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

/**
 * 按 seq 升序返回该反馈的全部日志（含字节）。
 * 读取方按需取字段：管理端只投影元数据；worker 需要字节构造 AI 输入。
 */
export function listFeedbackLogs(db: Db, feedbackId: string): FeedbackLogRow[] {
  return db
    .prepare("SELECT * FROM feedback_logs WHERE feedback_id = ? ORDER BY seq")
    .all(feedbackId) as unknown as FeedbackLogRow[];
}

/** 取单份日志（含字节）；logId 必须属于该反馈，否则返回 null（跨反馈引用一律 not_found）。 */
export function getFeedbackLog(db: Db, feedbackId: string, logId: string): FeedbackLogRow | null {
  return (
    (db.prepare("SELECT * FROM feedback_logs WHERE feedback_id = ? AND id = ?").get(feedbackId, logId) as unknown as
      | FeedbackLogRow
      | undefined) ?? null
  );
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
): { items: (FeedbackRow & { has_screenshot?: number; log_count?: number })[]; nextCursor: string | null } {
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
      `SELECT f.*,
              (SELECT 1 FROM feedback_screenshots s WHERE s.feedback_id = f.id) AS has_screenshot,
              (SELECT COUNT(*) FROM feedback_logs lg WHERE lg.feedback_id = f.id) AS log_count
       FROM feedbacks f ${w} ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    )
    .all(...params, filter.limit + 1) as unknown as (FeedbackRow & { has_screenshot?: number; log_count?: number })[];
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
export function toAdminListItem(r: FeedbackRow & { has_screenshot?: number; log_count?: number }) {
  return {
    id: r.id,
    appId: r.app_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    title: r.title,
    kaneoUrl: r.kaneo_task_url,
    errorSummary: r.error_summary,
    archiveStage: r.archive_stage,
    hasScreenshot: Boolean(r.has_screenshot),
    logCount: Number(r.log_count ?? 0),
  };
}
