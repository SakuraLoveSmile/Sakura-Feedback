import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import { getAppByAppId, softDeleteAppInTx } from "../src/db/repos.ts";

/**
 * 迁移 8（软件软删除 / 同 appId 重新发现）历史数据库验证。
 *
 * 在隔离临时目录中构造 v7 结构的历史库副本（app_id 列级 UNIQUE、无 deleted_at），
 * 验证升级后：全部内部 id 与业务行保留、外键完整、活跃唯一索引生效、
 * 失败整体回滚且重启可重试。绝不触碰真实数据库。
 */

const NOW = "2026-01-01T00:00:00.000Z";

/** v7 终态结构：apps 带列级 UNIQUE、全部 v7 列、无 deleted_at。 */
function historicalSchemaV7(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      enabled INTEGER NOT NULL DEFAULT 1, daily_limit INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL
    );
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '[]', kaneo_project_id TEXT NOT NULL DEFAULT '',
      kaneo_column_slug TEXT NOT NULL DEFAULT '',
      name_source TEXT NOT NULL DEFAULT 'client' CHECK (name_source IN ('client','admin')),
      config_status TEXT NOT NULL DEFAULT 'pending' CHECK (config_status IN ('pending','configured')),
      archive_mode TEXT NOT NULL DEFAULT 'manual' CHECK (archive_mode IN ('manual','automatic')),
      rule_version INTEGER NOT NULL DEFAULT 0,
      kaneo_column_id TEXT NOT NULL DEFAULT '', kaneo_label_ids TEXT NOT NULL DEFAULT '[]',
      kaneo_assignee_id TEXT, kaneo_assignee_name TEXT,
      auto_enabled_at TEXT, auto_enabled_by TEXT, auto_operation_id TEXT,
      first_seen_at TEXT, last_seen_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE app_sources (
      id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      origin TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('browser','native')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      confirmed_at TEXT, confirmed_by TEXT, confirm_operation_id TEXT
    );
    CREATE UNIQUE INDEX idx_app_sources_unique ON app_sources(app_row_id, origin);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE feedbacks (
      id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL REFERENCES apps(id), app_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, context_json TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received','processing','needs_info','ready_to_archive','archiving','needs_review','archived','failed')),
      title TEXT, processed_json TEXT, kaneo_task_id TEXT, kaneo_task_url TEXT,
      archive_stage TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete')),
      archive_data_json TEXT,
      classify_project_id TEXT, classify_column_id TEXT, classify_column_slug TEXT,
      classify_labels_json TEXT NOT NULL DEFAULT '[]', classify_assignee_id TEXT, classify_assignee_name TEXT,
      classify_version INTEGER NOT NULL DEFAULT 0, classify_updated_at TEXT, classify_updated_by TEXT,
      archive_authorized_at TEXT, archive_authorized_by TEXT, archive_operation_id TEXT,
      archive_authorized_kind TEXT CHECK (archive_authorized_kind IN ('manual','auto')),
      archive_rule_version INTEGER,
      source_origin TEXT NOT NULL DEFAULT '',
      auto_blocked_kind TEXT CHECK (auto_blocked_kind IN ('retryable','config')),
      auto_blocked_reason TEXT, auto_attempts INTEGER NOT NULL DEFAULT 0, auto_next_attempt_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, error_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE feedback_audit (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      at TEXT NOT NULL, actor_user_id TEXT NOT NULL DEFAULT '', actor_username TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, detail_json TEXT
    );
    CREATE TABLE daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, reset_at TEXT NOT NULL, PRIMARY KEY (user_id, day)
    );
    CREATE TABLE feedback_screenshots (
      feedback_id TEXT PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
      png_blob BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, capture_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE feedback_logs (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL, filename TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('auto','manual')), bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version = 7;
  `);
}

/** 造一份有完整历史（反馈 + 截图 + 日志 + 审计 + 已确认来源）的 v7 库。 */
function seedV7(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO users (id, username, pass_hash, role, enabled, daily_limit, created_at) VALUES ('user-1','admin','hash','admin',1,3,?)",
  ).run(NOW);
  db.prepare(
    `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
       name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
       auto_enabled_at, auto_enabled_by, auto_operation_id, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES ('app-1','com.test.app','测试软件','["http://host.test"]','proj-1','triage',
       'admin','configured','automatic',3,'col-1','["label-bug"]',?,?, 'op-1', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
       name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
       first_seen_at, last_seen_at, created_at, updated_at)
     VALUES ('app-2','com.other.app','另一软件','[]','','', 'client','pending','manual',0,'','[]', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO app_sources (id, app_row_id, origin, kind, status, first_seen_at, last_seen_at, confirmed_at, confirmed_by)
     VALUES ('src-1','app-1','http://host.test','browser','confirmed',?,?,?,'user-1')`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       title, kaneo_task_id, kaneo_task_url, archive_stage, source_origin, archive_authorized_at,
       archive_authorized_by, archive_operation_id, archive_authorized_kind, archive_rule_version,
       created_at, updated_at)
     VALUES ('fb-1','app-1','com.test.app','user-1','历史反馈','key-1','hash-1','archived',
       '旧标题','task-9','http://kaneo.test/t/9','complete','http://host.test',?, 'user-1','op-arch','manual',3,?,?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       source_origin, created_at, updated_at)
     VALUES ('fb-2','app-1','com.test.app','user-1','待处理反馈','key-2','hash-2','needs_info','http://host.test',?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, created_at)
     VALUES ('fb-1', ?, 10, 10, 3, 'sha-fb1', ?)`,
  ).run(Buffer.from([1, 2, 3]), NOW);
  db.prepare(
    `INSERT INTO feedback_logs (id, feedback_id, sort_order, filename, source, bytes, byte_size, sha256, created_at)
     VALUES ('log-1','fb-1',0,'app.log','auto',?,2,'logsha',?)`,
  ).run(Buffer.from([9, 9]), NOW);
  db.prepare(
    `INSERT INTO feedback_audit (id, feedback_id, at, actor_user_id, actor_username, action, detail_json)
     VALUES ('audit-1','fb-1',?,'user-1','admin','archive_authorize','{}')`,
  ).run(NOW);
}

function makeV7Db(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v8-"));
  const raw = new DatabaseSync(path.join(dir, "feedback.db"));
  historicalSchemaV7(raw);
  seedV7(raw);
  raw.close();
  return dir;
}

describe("迁移 8：软件软删除", () => {
  it("v7 → v8：全部内部 id 与业务行保留、deleted_at 就位、活跃唯一索引生效、外键完整", () => {
    const dir = makeV7Db();
    const db = openDb(dir);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

    // 列级 UNIQUE 已移除、部分唯一索引已建立且为 UNIQUE
    const cols = (db.prepare("PRAGMA table_info(apps)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("deleted_at");
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_apps_active_appid'")
      .get() as { name: string; sql: string } | undefined;
    expect(idx?.sql).toContain("UNIQUE");
    expect(idx?.sql).toContain("deleted_at IS NULL");
    // 列级 UNIQUE 对应的 autoindex（origin='u'）不应残留；主键 autoindex（origin='pk'）正常保留
    const idxList = db.prepare("PRAGMA index_list(apps)").all() as { name: string; origin: string }[];
    expect(idxList.some((i) => i.origin === "u")).toBe(false);
    expect(idxList.some((i) => i.name === "idx_apps_active_appid")).toBe(true);

    // 业务行原样保留（含软删除目标行的全部字段）
    const app1 = db.prepare("SELECT * FROM apps WHERE id = 'app-1'").get() as Record<string, unknown>;
    expect(app1.app_id).toBe("com.test.app");
    expect(app1.archive_mode).toBe("automatic");
    expect(app1.rule_version).toBe(3);
    expect(app1.auto_operation_id).toBe("op-1");
    expect(app1.deleted_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM feedbacks").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_screenshots").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_logs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_audit").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM app_sources").get()).toEqual({ n: 1 });

    // 历史反馈仍指向原 app 行（FK 有效）
    const fb = db.prepare("SELECT app_row_id FROM feedbacks WHERE id = 'fb-1'").get() as { app_row_id: string };
    expect(fb.app_row_id).toBe("app-1");
    db.close();
  });

  it("软删除后可同 appId 重新发现；活跃唯一约束仍然强制", () => {
    const dir = makeV7Db();
    const db = openDb(dir);

    expect(softDeleteAppInTx(db, "app-1")).toBe("deleted");
    // getAppByAppId 只看活跃记录
    expect(getAppByAppId(db, "com.test.app")).toBeNull();
    // 历史行仍在
    const gone = db.prepare("SELECT deleted_at, archive_mode, auto_operation_id FROM apps WHERE id='app-1'").get() as {
      deleted_at: string | null;
      archive_mode: string;
      auto_operation_id: string | null;
    };
    expect(gone.deleted_at).toBeTruthy();
    expect(gone.archive_mode).toBe("manual"); // 删除即退回人工模式
    expect(gone.auto_operation_id).toBeNull();

    // 同 appId 新活跃记录可以插入（重新发现）
    db.prepare(
      `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
         name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
         first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('app-new','com.test.app','测试软件','[]','','', 'client','pending','manual',0,'','[]', ?, ?, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    expect(getAppByAppId(db, "com.test.app")?.id).toBe("app-new");

    // 第二条活跃同 appId 仍被唯一索引拒绝
    expect(() =>
      db
        .prepare(
          `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
             name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
             first_seen_at, last_seen_at, created_at, updated_at)
           VALUES ('app-dup','com.test.app','x','[]','','', 'client','pending','manual',0,'','[]', ?, ?, ?, ?)`,
        )
        .run(NOW, NOW, NOW, NOW),
    ).toThrow(/UNIQUE/i);

    // 再次软删除新记录后还能再发现（多代共存）
    expect(softDeleteAppInTx(db, "app-new")).toBe("deleted");
    expect(softDeleteAppInTx(db, "app-new")).toBe("already_deleted");
    expect(softDeleteAppInTx(db, "no-such")).toBe("not_found");
    db.close();
  });

  it("迁移失败整体回滚：版本号不前进、原表与数据原样保留，修复后重启可完成迁移", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v8-fail-"));
    const file = path.join(dir, "feedback.db");
    const raw = new DatabaseSync(file);
    historicalSchemaV7(raw);
    seedV7(raw);
    // 注入失败：残留的异构 apps_v8 表让重建阶段的 INSERT 必然失败
    raw.exec("CREATE TABLE apps_v8 (junk TEXT)");
    raw.close();

    expect(() => openDb(dir)).toThrow();
    const check = new DatabaseSync(file);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    // 原 apps 表完好：列级 UNIQUE 仍在、数据未丢
    const cols = (check.prepare("PRAGMA table_info(apps)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("deleted_at");
    expect(check.prepare("SELECT COUNT(*) n FROM apps").get()).toEqual({ n: 2 });
    expect(check.prepare("SELECT COUNT(*) n FROM feedbacks").get()).toEqual({ n: 2 });
    check.close();

    // 清掉残留后重开：迁移幂等完成
    const fix = new DatabaseSync(file);
    fix.exec("DROP TABLE apps_v8");
    fix.close();
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM apps").get()).toEqual({ n: 2 });
    db.close();
  });

  it("重启（再次 openDb）幂等：结构与数据均不变", () => {
    const dir = makeV7Db();
    const first = openDb(dir);
    const digest = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT * FROM apps ORDER BY id").all());
    const snapshot = digest(first);
    first.close();

    const second = openDb(dir);
    expect((second.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(digest(second)).toBe(snapshot);
    expect(second.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    second.close();
  });

  it("全新库直接带 deleted_at 与活跃唯一索引", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v8-fresh-"));
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    const cols = (db.prepare("PRAGMA table_info(apps)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("deleted_at");
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_apps_active_appid'").get() as
      | { sql: string }
      | undefined;
    expect(idx?.sql).toContain("UNIQUE");
    db.close();
  });
});
