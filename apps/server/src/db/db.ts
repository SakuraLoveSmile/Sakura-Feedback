import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * feedbacks 表 DDL 生成器：全新库（SCHEMA）与迁移重建（feedbacks_v6）共用同一份定义，
 * 避免新库与升级库结构漂移。分类字段与归档授权字段在 v6 引入；
 * 观察到来源、自动授权与自动归档阻塞/退避字段在 v7 引入。
 */
function feedbacksTableDdl(table: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id               TEXT PRIMARY KEY,
  app_row_id       TEXT NOT NULL REFERENCES apps(id),
  app_id           TEXT NOT NULL,
  user_id          TEXT NOT NULL DEFAULT '',
  text             TEXT NOT NULL,
  context_json     TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('received','processing','needs_info','ready_to_archive','archiving','needs_review','archived','failed')),
  title            TEXT,
  processed_json   TEXT,
  kaneo_task_id    TEXT,
  kaneo_task_url   TEXT,
  archive_stage    TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete')),
  archive_data_json TEXT,
  classify_project_id    TEXT,
  classify_column_id     TEXT,
  classify_column_slug   TEXT,
  classify_labels_json   TEXT NOT NULL DEFAULT '[]',
  classify_assignee_id   TEXT,
  classify_assignee_name TEXT,
  classify_version       INTEGER NOT NULL DEFAULT 0,
  classify_updated_at    TEXT,
  classify_updated_by    TEXT,
  archive_authorized_at  TEXT,
  archive_authorized_by  TEXT,
  archive_operation_id   TEXT,
  archive_authorized_kind TEXT CHECK (archive_authorized_kind IN ('manual','auto')),
  archive_rule_version   INTEGER,
  source_origin          TEXT NOT NULL DEFAULT '',
  auto_blocked_kind      TEXT CHECK (auto_blocked_kind IN ('retryable','config')),
  auto_blocked_reason    TEXT,
  auto_attempts          INTEGER NOT NULL DEFAULT 0,
  auto_next_attempt_at   TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  error_summary    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);`;
}

/** 操作审计：分类保存 / 归档授权 / 恢复动作等管理操作留痕（详情页可查）。 */
const FEEDBACK_AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS feedback_audit (
  id              TEXT PRIMARY KEY,
  feedback_id     TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  at              TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL DEFAULT '',
  actor_username  TEXT NOT NULL DEFAULT '',
  action          TEXT NOT NULL,
  detail_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_audit_feedback ON feedback_audit(feedback_id, at);
`;

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
  -- ---- v7：先接收后配置（自动发现软件 / 自动归档规则） ----
  name_source       TEXT NOT NULL DEFAULT 'client' CHECK (name_source IN ('client','admin')),
  config_status     TEXT NOT NULL DEFAULT 'pending' CHECK (config_status IN ('pending','configured')),
  archive_mode      TEXT NOT NULL DEFAULT 'manual' CHECK (archive_mode IN ('manual','automatic')),
  rule_version      INTEGER NOT NULL DEFAULT 0,
  kaneo_column_id   TEXT NOT NULL DEFAULT '',
  kaneo_label_ids   TEXT NOT NULL DEFAULT '[]',
  kaneo_assignee_id   TEXT,
  kaneo_assignee_name TEXT,
  auto_enabled_at   TEXT,
  auto_enabled_by   TEXT,
  auto_operation_id TEXT,
  first_seen_at     TEXT,
  last_seen_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- 软件来源：浏览器按请求 Origin 逐条记录，无 Origin 的原生客户端单独一条。
-- 待确认来源不会获得自动归档授权；确认后由扫描补处理。
CREATE TABLE IF NOT EXISTS app_sources (
  id            TEXT PRIMARY KEY,
  app_row_id    TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('browser','native')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  confirmed_at  TEXT,
  confirmed_by  TEXT,
  confirm_operation_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sources_unique ON app_sources(app_row_id, origin);
CREATE INDEX IF NOT EXISTS idx_app_sources_status ON app_sources(app_row_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

${feedbacksTableDdl("feedbacks")}
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_app ON feedbacks(app_row_id, created_at);

${FEEDBACK_AUDIT_DDL}

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

  if (v < 6) {
    // 迁移 6（人工分类归档改造）：
    // - feedbacks 重建以扩展 status CHECK（needs_info / ready_to_archive）并加入
    //   分类字段（项目/列/标签/负责人/分类版本）与归档授权字段；
    // - 新增操作审计表；
    // - 旧数据接管：**未发生远端写入**的 received/processing 接入人工流程（→ needs_info），
    //   failed / needs_review / archiving / archived 一律原样保留（不自动重跑、不重定向）；
    // - 附件（feedback_screenshots / feedback_logs）、任务链接与归档恢复数据原样保留。
    // 迁移在事务内完成：任一步失败即回滚，版本号不前进（下次启动重试）。
    // 注意：node:sqlite 默认开启外键（PRAGMA foreign_keys=1），而重建表需要 DROP 旧表；
    // 外键开启时 DROP 会触发 ON DELETE CASCADE 连带删除附件，因此必须在事务外先关闭外键，
    // 迁移结束后恢复原值。
    const fkWasOn =
      ((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys ?? 0) === 1;
    if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      const fbCols = columns(db, "feedbacks");
      if (!fbCols.includes("classify_project_id")) {
        db.exec(feedbacksTableDdl("feedbacks_v6"));
        db.exec(`
          INSERT INTO feedbacks_v6 (
            id, app_row_id, app_id, user_id, text, context_json, idempotency_key, content_hash,
            status, title, processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json,
            classify_labels_json, classify_version, attempt_count, last_error, error_summary, created_at, updated_at
          )
          SELECT
            id, app_row_id, app_id, user_id, text, context_json, idempotency_key, content_hash,
            status, title, processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json,
            '[]', 0, attempt_count, last_error, error_summary, created_at, updated_at
          FROM feedbacks;
        `);
        db.exec("DROP TABLE feedbacks;");
        db.exec("ALTER TABLE feedbacks_v6 RENAME TO feedbacks;");
      }
      db.exec(FEEDBACK_AUDIT_DDL);
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_app ON feedbacks(app_row_id, created_at)");

      // 旧数据接管：received/processing 从未产生远端写入（任务创建前状态必为 archiving），
      // 因此直接接到人工分类流程；恢复数据（若有）原样保留。
      const moved = db
        .prepare(
          `UPDATE feedbacks SET status = 'needs_info', updated_at = ?
           WHERE status IN ('received','processing') AND kaneo_task_id IS NULL`,
        )
        .run(nowIso());

      db.exec("PRAGMA user_version = 6;");
      db.exec("COMMIT");
      if (Number(moved.changes) > 0) {
        console.info(`[migration_v6] 已将 ${Number(moved.changes)} 条未发生远端写入的历史反馈接入人工分类流程`);
      }
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
    }
  }

  if (v < 7) {
    // 迁移 7（先接收、后配置、自动归档）：
    // - apps 增加配置状态 / 归档模式 / 规则版本 / 默认项目-列-标签-负责人 / 发现与启用留痕；
    // - 新增 app_sources（逐条来源的待确认/已确认状态）；
    // - feedbacks 增加“服务端观察到的来源”、自动授权留痕与自动归档阻塞/退避字段；
    // - 旧数据接管（保守口径）：
    //   · 旧软件一律保留**人工模式**，配置状态记为已配置（历史上由管理员显式登记）；
    //   · 既有 allowedOrigins 逐条迁为**已确认**来源；
    //   · 历史反馈的来源无法可靠确定，一律留空 —— 不参与任何自动补归档。
    // 仅新增列与表，不重建 feedbacks，因此无需关闭外键。
    // 注：本块内每条 DDL 都是完整字面量，不做任何字符串拼接或插值。
    db.exec("BEGIN");
    try {
      const appCols = columns(db, "apps");
      if (!appCols.includes("name_source")) {
        db.exec(
          "ALTER TABLE apps ADD COLUMN name_source TEXT NOT NULL DEFAULT 'admin' CHECK (name_source IN ('client','admin'))",
        );
      }
      if (!appCols.includes("config_status")) {
        db.exec(
          "ALTER TABLE apps ADD COLUMN config_status TEXT NOT NULL DEFAULT 'configured' CHECK (config_status IN ('pending','configured'))",
        );
      }
      if (!appCols.includes("archive_mode")) {
        db.exec(
          "ALTER TABLE apps ADD COLUMN archive_mode TEXT NOT NULL DEFAULT 'manual' CHECK (archive_mode IN ('manual','automatic'))",
        );
      }
      if (!appCols.includes("rule_version")) {
        db.exec("ALTER TABLE apps ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 0");
      }
      if (!appCols.includes("kaneo_column_id")) {
        db.exec("ALTER TABLE apps ADD COLUMN kaneo_column_id TEXT NOT NULL DEFAULT ''");
      }
      if (!appCols.includes("kaneo_label_ids")) {
        db.exec("ALTER TABLE apps ADD COLUMN kaneo_label_ids TEXT NOT NULL DEFAULT '[]'");
      }
      if (!appCols.includes("kaneo_assignee_id")) {
        db.exec("ALTER TABLE apps ADD COLUMN kaneo_assignee_id TEXT");
      }
      if (!appCols.includes("kaneo_assignee_name")) {
        db.exec("ALTER TABLE apps ADD COLUMN kaneo_assignee_name TEXT");
      }
      if (!appCols.includes("auto_enabled_at")) {
        db.exec("ALTER TABLE apps ADD COLUMN auto_enabled_at TEXT");
      }
      if (!appCols.includes("auto_enabled_by")) {
        db.exec("ALTER TABLE apps ADD COLUMN auto_enabled_by TEXT");
      }
      if (!appCols.includes("auto_operation_id")) {
        db.exec("ALTER TABLE apps ADD COLUMN auto_operation_id TEXT");
      }
      if (!appCols.includes("first_seen_at")) {
        db.exec("ALTER TABLE apps ADD COLUMN first_seen_at TEXT");
      }
      if (!appCols.includes("last_seen_at")) {
        db.exec("ALTER TABLE apps ADD COLUMN last_seen_at TEXT");
      }
      // 旧库的 apps 行在旧 schema 下创建时没有发现时间：按创建时间回填。
      db.exec("UPDATE apps SET first_seen_at = created_at WHERE first_seen_at IS NULL");
      db.exec("UPDATE apps SET last_seen_at = updated_at WHERE last_seen_at IS NULL");

      db.exec(
        "CREATE TABLE IF NOT EXISTS app_sources (id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, origin TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('browser','native')), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')), first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, confirmed_at TEXT, confirmed_by TEXT, confirm_operation_id TEXT)",
      );
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sources_unique ON app_sources(app_row_id, origin)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_app_sources_status ON app_sources(app_row_id, status)");

      const fbCols = columns(db, "feedbacks");
      if (!fbCols.includes("source_origin")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN source_origin TEXT NOT NULL DEFAULT ''");
      }
      if (!fbCols.includes("archive_authorized_kind")) {
        db.exec(
          "ALTER TABLE feedbacks ADD COLUMN archive_authorized_kind TEXT CHECK (archive_authorized_kind IN ('manual','auto'))",
        );
      }
      if (!fbCols.includes("archive_rule_version")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN archive_rule_version INTEGER");
      }
      if (!fbCols.includes("auto_blocked_kind")) {
        db.exec(
          "ALTER TABLE feedbacks ADD COLUMN auto_blocked_kind TEXT CHECK (auto_blocked_kind IN ('retryable','config'))",
        );
      }
      if (!fbCols.includes("auto_blocked_reason")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN auto_blocked_reason TEXT");
      }
      if (!fbCols.includes("auto_attempts")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN auto_attempts INTEGER NOT NULL DEFAULT 0");
      }
      if (!fbCols.includes("auto_next_attempt_at")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN auto_next_attempt_at TEXT");
      }

      // 既有允许来源：逐条迁为已确认来源（当年由管理员显式登记，绑定关系可靠）。
      const legacyApps = db.prepare("SELECT id, allowed_origins, created_at, updated_at FROM apps").all() as {
        id: string;
        allowed_origins: string;
        created_at: string;
        updated_at: string;
      }[];
      const insertSource = db.prepare(
        "INSERT OR IGNORE INTO app_sources (id, app_row_id, origin, kind, status, first_seen_at, last_seen_at, confirmed_at, confirmed_by, confirm_operation_id) VALUES (?, ?, ?, 'browser', 'confirmed', ?, ?, ?, NULL, NULL)",
      );
      let migratedSources = 0;
      for (const app of legacyApps) {
        let origins: unknown = [];
        try {
          origins = JSON.parse(app.allowed_origins);
        } catch {
          origins = [];
        }
        if (!Array.isArray(origins)) continue;
        for (const origin of origins) {
          if (typeof origin !== "string" || origin.trim() === "") continue;
          const r = insertSource.run(
            randomUUID(),
            app.id,
            origin.trim(),
            app.created_at,
            app.updated_at,
            app.updated_at,
          );
          migratedSources += Number(r.changes);
        }
      }

      db.exec("PRAGMA user_version = 7;");
      db.exec("COMMIT");
      if (migratedSources > 0) {
        console.info(`[migration_v7] 已将 ${migratedSources} 条既有允许来源迁为已确认来源（旧软件保持人工模式）`);
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
