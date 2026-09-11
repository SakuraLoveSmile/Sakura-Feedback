import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('cookie','client','handshake')),
  client_label  TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE TABLE IF NOT EXISTS apps (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  allowed_origins   TEXT NOT NULL DEFAULT '[]',
  kaneo_project_id  TEXT NOT NULL DEFAULT '',
  kaneo_column_slug TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedbacks (
  id               TEXT PRIMARY KEY,
  app_row_id       TEXT NOT NULL REFERENCES apps(id),
  app_id           TEXT NOT NULL,
  text             TEXT NOT NULL,
  context_json     TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('received','processing','archiving','needs_review','archived','failed')),
  title            TEXT,
  processed_json   TEXT,
  kaneo_task_id    TEXT,
  kaneo_task_url   TEXT,
  archive_stage    TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete')),
  archive_data_json TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  error_summary    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_app ON feedbacks(app_row_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_screenshots (
  feedback_id   TEXT PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
  png_blob      BLOB NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  capture_json  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_logs (
  id          TEXT    PRIMARY KEY,
  feedback_id TEXT    NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  filename    TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('auto','manual')),
  log_blob    BLOB    NOT NULL,
  byte_size   INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE (feedback_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, seq);
`;

/** v3 迁移的 DDL：必须与 SCHEMA 中的 feedback_logs 段逐字一致（L5）。 */
const FEEDBACK_LOGS_DDL = `
CREATE TABLE IF NOT EXISTS feedback_logs (
  id          TEXT    PRIMARY KEY,
  feedback_id TEXT    NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  filename    TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('auto','manual')),
  log_blob    BLOB    NOT NULL,
  byte_size   INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE (feedback_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, seq);
`;

/**
 * 增量迁移：v2 → v3 只新增 feedback_logs（不重建 feedbacks、不改既有列）。
 * 迁移在事务内完成；任一步失败 → ROLLBACK，user_version 不前进（供测试直接调用）。
 */
export function migrate(db: DatabaseSync): void {
  let v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_screenshots (
        feedback_id   TEXT PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
        png_blob      BLOB NOT NULL,
        width         INTEGER NOT NULL,
        height        INTEGER NOT NULL,
        byte_size     INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        capture_json  TEXT,
        created_at    TEXT NOT NULL
      );
    `);
    const cols = (db.prepare("PRAGMA table_info(feedbacks)").all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes("archive_stage")) {
      db.exec(
        "ALTER TABLE feedbacks ADD COLUMN archive_stage TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete'))",
      );
    }
    if (!cols.includes("archive_data_json")) {
      db.exec("ALTER TABLE feedbacks ADD COLUMN archive_data_json TEXT");
    }
    db.exec("PRAGMA user_version = 2;");
    v = 2;
  }
  if (v < 3) {
    // CREATE TABLE IF NOT EXISTS 幂等；DDL 与 user_version 同事务，失败整体回滚
    db.exec("BEGIN");
    try {
      db.exec(FEEDBACK_LOGS_DDL);
      db.exec("PRAGMA user_version = 3;");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "feedback.db"));
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export type Db = DatabaseSync;

export function nowIso(): string {
  return new Date().toISOString();
}
