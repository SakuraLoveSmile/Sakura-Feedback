import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  daily_limit   INTEGER NOT NULL DEFAULT 3,
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
  user_id          TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id   TEXT NOT NULL REFERENCES users(id),
  day       TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  reset_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

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
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('auto','manual')),
  bytes        BLOB NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, sort_order);

`;

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
}

export function migrate(db: DatabaseSync): void {
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
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
    const cols = columns(db, "feedbacks");
    if (!cols.includes("archive_stage")) {
      db.exec(
        "ALTER TABLE feedbacks ADD COLUMN archive_stage TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete'))",
      );
    }
    if (!cols.includes("archive_data_json")) {
      db.exec("ALTER TABLE feedbacks ADD COLUMN archive_data_json TEXT");
    }
    db.exec("PRAGMA user_version = 2;");
  }

  if (v < 3) {
    // 角色 / 启用状态 / 每日额度、反馈归属与每日用量。
    // 迁移在事务内完成：任一步失败即回滚，版本号不前进（下次启动重试）。
    db.exec("BEGIN");
    try {
      const userCols = columns(db, "users");
      if (!userCols.includes("role")) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user'))");
      }
      if (!userCols.includes("enabled")) {
        db.exec("ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
      }
      if (!userCols.includes("daily_limit")) {
        db.exec("ALTER TABLE users ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 3");
      }
      const fbCols = columns(db, "feedbacks");
      if (!fbCols.includes("user_id")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id, created_at)");
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_usage (
          user_id   TEXT NOT NULL REFERENCES users(id),
          day       TEXT NOT NULL,
          used      INTEGER NOT NULL DEFAULT 0,
          reset_at  TEXT NOT NULL,
          PRIMARY KEY (user_id, day)
        );
      `);
      // 原有账号全部升为管理员（含部署初始账号）；历史反馈归属最早的初始账号。
      db.exec("UPDATE users SET role = 'admin' WHERE role = 'user'");
      db.exec("UPDATE feedbacks SET user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1) WHERE user_id = ''");
      db.exec("PRAGMA user_version = 3;");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  if (v < 4) {
    // 附件日志：feedback_logs 表与索引。
    // 迁移在事务内完成：任一步失败即回滚，版本号不前进。
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_logs (
          id           TEXT PRIMARY KEY,
          feedback_id  TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
          sort_order   INTEGER NOT NULL,
          filename     TEXT NOT NULL,
          source       TEXT NOT NULL CHECK (source IN ('auto','manual')),
          bytes        BLOB NOT NULL,
          byte_size    INTEGER NOT NULL,
          sha256       TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, sort_order);
      `);
      db.exec("PRAGMA user_version = 4;");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  if (v < 5) {
    // 迁移 5（L3 / U1）：修正历史误标记录。
    // 将“含日志但无完整日志归档证据”的 archived 记录转为 needs_review，
    // 保留任务 ID、文件和旧恢复数据，不自动向 Kaneo 重发。
    db.exec("BEGIN");
    try {
      const candidates = db
        .prepare(
          "SELECT id, archive_data_json FROM feedbacks WHERE status = 'archived' AND id IN (SELECT DISTINCT feedback_id FROM feedback_logs)",
        )
        .all() as { id: string; archive_data_json: string | null }[];

      let affected = 0;
      const stmt = db.prepare(
        "UPDATE feedbacks SET status = 'needs_review', error_summary = ?, last_error = ? WHERE id = ?",
      );
      for (const row of candidates) {
        let fullyArchived = false;
        if (row.archive_data_json) {
          try {
            const parsed = JSON.parse(row.archive_data_json);
            if (parsed && (parsed.version === 2 || parsed.attachments) && parsed.attachments) {
              const logs = db.prepare("SELECT id FROM feedback_logs WHERE feedback_id = ?").all(row.id) as {
                id: string;
              }[];
              fullyArchived =
                logs.length > 0 &&
                logs.every((l) => {
                  const att = parsed.attachments[l.id];
                  return att?.asset?.url && att.comment?.outcome === "confirmed";
                });
            }
          } catch {
            fullyArchived = false;
          }
        }
        if (!fullyArchived) {
          stmt.run(
            "历史记录误标归档：含日志附件但缺少完整日志归档证据，待核对后补传",
            "migration_v5: 日志附件未完成归档，已转待核对",
            row.id,
          );
          affected++;
        }
      }
      db.exec("PRAGMA user_version = 5;");
      db.exec("COMMIT");
      if (affected > 0) {
        console.info(`[migration_v5] 已修正 ${affected} 条未归档日志的历史误标记录为 needs_review`);
      }
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
