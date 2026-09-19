import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * feedbacks 表 DDL 生成器：全新库（SCHEMA）与迁移重建（feedbacks_v6）共用同一份定义，
 * 避免新库与升级库结构漂移。分类字段与归档授权字段在 v6 引入；
 * 观察到来源、自动授权与自动归档阻塞/退避字段在 v7 引入；
 * 本地管理生命周期字段（收件箱/已归档/回收站）在 v9 引入。
 */
/**
 * apps 表 DDL 生成器：全新库（SCHEMA）与迁移重建（apps_v8）共用同一份定义，
 * 避免新库与升级库结构漂移。
 * v8 起 `app_id` 不再使用列级 UNIQUE：唯一性由「仅活跃记录」部分唯一索引
 * `idx_apps_active_appid` 承担，软删除行可与同名 appId 的新活跃记录共存。
 */
function appsTableDdl(table: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL,
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
  -- ---- v8：软删除（历史反馈/截图/日志全部保留，活跃 appId 才可重新发现） ----
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);`;
}

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
  -- ---- v9：本地管理生命周期（收件箱/已归档/回收站），与处理状态 status 完全分离 ----
  mgmt_state         TEXT NOT NULL DEFAULT 'inbox' CHECK (mgmt_state IN ('inbox','archived','trash')),
  mgmt_archived_at   TEXT,
  mgmt_archived_by   TEXT,
  mgmt_trashed_at    TEXT,
  mgmt_trashed_by    TEXT,
  lifecycle_version  INTEGER NOT NULL DEFAULT 0,
  resume_paused      INTEGER NOT NULL DEFAULT 0,
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

/**
 * 彻底删除凭据（v9）：反馈被手动彻底删除后保留的最小防重放信息。
 * 只含提交键摘要（非原文）、内容摘要、所属用户、原反馈 ID 与删除时间；
 * 不含正文、附件内容或远端 URL。同一提交键摘要再次出现不得新建反馈。
 */
const FEEDBACK_DELETION_RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS feedback_deletion_receipts (
  id                   TEXT PRIMARY KEY,
  feedback_id          TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  deleted_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fdr_key ON feedback_deletion_receipts(idempotency_key_hash);
CREATE INDEX IF NOT EXISTS idx_fdr_feedback ON feedback_deletion_receipts(feedback_id);
`;

/**
 * Assist 接入 outbox（v10，contracts/feedback-integration.md §2）：
 * 业务事务内追加的事件行，由独立投递 worker 按 seq 升序可靠上报中枢。
 * seq 由 assist_outbox_seq 单行计数器在同事务内分配（写事务串行，无并发问题）。
 */
const ASSIST_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS assist_outbox (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_assist_outbox_pending ON assist_outbox(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS assist_outbox_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
`;

/**
 * Assist 管理面幂等请求表（v12，contracts/feedback-integration.md §4.2）：
 * - request_id 为中枢下发的客户端幂等键（每次操作唯一）；
 * - http_status = 0 表示「运行中」标记，>0 为已完成请求的 HTTP 状态；
 * - outcome_json 保存该请求的参数与响应体（供同 requestId 回放 / 参数冲突判定），
 *   只含操作结果字段，不含正文/附件字节；
 * - 完成行保留 30 天，由操作路径顺带惰性清理；运行中标记超过 10 分钟视为崩溃残留，
 *   惰性终结为 outcome_uncertain。
 * 迁移号按契约冻结为 v12（v11 预留给 Issue 对话特性，允许跳号）。
 */
const ASSIST_MGMT_REQUESTS_DDL = `
CREATE TABLE IF NOT EXISTS assist_mgmt_requests (
  request_id   TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL,
  action       TEXT NOT NULL,
  http_status  INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amr_feedback ON assist_mgmt_requests(feedback_id);
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

${appsTableDdl("apps")}
-- 活跃唯一索引 idx_apps_active_appid 由迁移 v8 统一创建（新库与升级库同一入口），
-- 不能在此建：老库的 apps 尚无 deleted_at 列，SCHEMA 在每次启动都会执行。

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

${FEEDBACK_DELETION_RECEIPTS_DDL}

${ASSIST_OUTBOX_DDL}

${ASSIST_MGMT_REQUESTS_DDL}
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

  if (v < 8) {
    // 迁移 8（软件软删除 / 同 appId 重新发现）：
    // - apps 增加 deleted_at；app_id 由列级 UNIQUE 改为「仅活跃记录唯一」的部分唯一索引；
    // - 列级 UNIQUE 无法 ALTER 移除，必须重建 apps：全部内部 id 与既有行原样搬运；
    // - 历史反馈 / 截图 / 日志 / 审计不做任何改动，app_row_id 外键继续指向原行；
    // - 与 v6 同理：重建期间关闭外键（feedbacks / app_sources 引用 apps(id)，
    //   且 app_sources 带 ON DELETE CASCADE，外键开启时 DROP 会连带删除），事务内执行、
    //   任一步失败整体回滚、版本号不前进，重启后按幂等步骤重试。
    const fkWasOn =
      ((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys ?? 0) === 1;
    if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      const appCols = columns(db, "apps");
      if (appCols.length === 0) {
        // 极端情况：库内没有 apps 表（正常路径下 SCHEMA 已建），按最新结构补齐。
        db.exec(appsTableDdl("apps"));
      } else if (!appCols.includes("deleted_at")) {
        db.exec(appsTableDdl("apps_v8"));
        db.exec(`
          INSERT INTO apps_v8 (
            id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
            name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
            kaneo_assignee_id, kaneo_assignee_name, auto_enabled_at, auto_enabled_by, auto_operation_id,
            first_seen_at, last_seen_at, created_at, updated_at
          )
          SELECT
            id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
            name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
            kaneo_assignee_id, kaneo_assignee_name, auto_enabled_at, auto_enabled_by, auto_operation_id,
            first_seen_at, last_seen_at, created_at, updated_at
          FROM apps;
        `);
        // 搬运完整性自检：行数不一致（如残留同构 apps_v8 混入历史行）立即失败回滚。
        const before = db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number };
        const after = db.prepare("SELECT COUNT(*) AS n FROM apps_v8").get() as { n: number };
        if (Number(after.n) !== Number(before.n)) {
          throw new Error(`apps_v8 行数 ${after.n} 与 apps ${before.n} 不一致，放弃迁移`);
        }
        db.exec("DROP TABLE apps;");
        db.exec("ALTER TABLE apps_v8 RENAME TO apps;");
      }
      // 活跃唯一索引：不用 IF NOT EXISTS——同名但定义不符的对象必须让迁移失败回滚，
      // 而不是被静默沿用（v8 的库内不应存在任何名为 idx_apps_active_appid 的对象）。
      db.exec("CREATE UNIQUE INDEX idx_apps_active_appid ON apps(app_id) WHERE deleted_at IS NULL");
      db.exec("PRAGMA user_version = 8;");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
    }
  }

  if (v < 9) {
    // 迁移 9（反馈本地管理生命周期：收件箱 / 已归档 / 回收站 + 彻底删除凭据）：
    // - feedbacks 增加 mgmt_state（与处理状态 status 分离）、归档/删除时间与操作者、
    //   乐观生命周期版本 lifecycle_version 与恢复后暂停标记 resume_paused；
    // - 历史记录一律落 inbox（列默认值），不自动迁入已归档，不改变既有处理状态、
    //   远端关联、附件与恢复证据，不触发 worker 重发；
    // - 新建 feedback_deletion_receipts：彻底删除后仅保留提交键摘要、内容摘要、
    //   所属用户、原反馈 ID 与删除时间，用于防旧提交重放与重复删除；
    // - 纯加列/加表（经 feedbacks_v6 重建路径升级的库已带新列，列守卫自动跳过），
    //   事务内执行、任一步失败回滚、版本号不前进。
    db.exec("BEGIN");
    try {
      const fbCols = columns(db, "feedbacks");
      if (!fbCols.includes("mgmt_state")) {
        db.exec(
          "ALTER TABLE feedbacks ADD COLUMN mgmt_state TEXT NOT NULL DEFAULT 'inbox' CHECK (mgmt_state IN ('inbox','archived','trash'))",
        );
      }
      if (!fbCols.includes("mgmt_archived_at")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN mgmt_archived_at TEXT");
      }
      if (!fbCols.includes("mgmt_archived_by")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN mgmt_archived_by TEXT");
      }
      if (!fbCols.includes("mgmt_trashed_at")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN mgmt_trashed_at TEXT");
      }
      if (!fbCols.includes("mgmt_trashed_by")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN mgmt_trashed_by TEXT");
      }
      if (!fbCols.includes("lifecycle_version")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0");
      }
      if (!fbCols.includes("resume_paused")) {
        db.exec("ALTER TABLE feedbacks ADD COLUMN resume_paused INTEGER NOT NULL DEFAULT 0");
      }
      // 区域列表索引：不能在 SCHEMA 建（老库尚无 mgmt_state 列，SCHEMA 每次启动都会执行）。
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_mgmt ON feedbacks(mgmt_state, created_at)");
      db.exec(FEEDBACK_DELETION_RECEIPTS_DDL);
      db.exec("PRAGMA user_version = 9;");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  if (v < 10) {
    // 迁移 10（Assist 接入 outbox）：
    // - 新增 assist_outbox（pending/sent 事件行，payload_json 为契约单事件结构）
    //   与 assist_outbox_seq（单行事件序号计数器）；
    // - 纯加表（SCHEMA 已含同构定义，IF NOT EXISTS 幂等），不改任何既有表与状态机；
    // - 事务内执行、任一步失败回滚、版本号不前进。
    db.exec("BEGIN");
    try {
      db.exec(ASSIST_OUTBOX_DDL);
      db.exec("PRAGMA user_version = 10;");
      db.exec("COMMIT");
      console.info("[migration_v10] 已创建 Assist 接入 outbox 表");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  if (v < 12) {
    // 迁移 12（Assist 管理面幂等请求表，契约 v1.1 §4.2）：
    // - 新增 assist_mgmt_requests（request_id 幂等键 + 运行中/完成标记 + 结果快照）；
    // - 纯加表（SCHEMA 已含同构定义，IF NOT EXISTS 幂等），不改任何既有表与状态机；
    // - v11 预留给 Issue 对话特性（契约冻结本表为 v12），user_version 允许跳号；
    // - 事务内执行、任一步失败回滚、版本号不前进。
    db.exec("BEGIN");
    try {
      db.exec(ASSIST_MGMT_REQUESTS_DDL);
      db.exec("PRAGMA user_version = 12;");
      db.exec("COMMIT");
      console.info("[migration_v12] 已创建 Assist 管理面幂等请求表");
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
