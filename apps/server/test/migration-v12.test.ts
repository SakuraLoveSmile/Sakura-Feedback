import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import { getUnifiedFeedbackImage, listUnifiedFeedbackImages } from "../src/db/repos.ts";

/**
 * 迁移 12（多图附件与撤销停止派发）历史数据库验证。
 *
 * 在隔离临时目录中构造 v11 终态结构（feedback_messages 无 resolution_note、
 * feedback_message_attachments 无 sort/mime 且 kind 只允许 screenshot/log、
 * kaneo_cancellation_tasks 无 cancelled 态），验证升级后：
 * - 新增 feedback_images 表；旧截图经统一图片视图兼容读入；
 * - 附件表重建并回填 sort/mime；
 * - 存量 pending/processing 撤销任务置为 cancelled 并补审计，uncertain/failed/confirmed 原样保留；
 * - 失败整体回滚、重启幂等。绝不触碰真实数据库。
 */

const NOW = "2026-01-01T00:00:00.000Z";

/** v11 终态的对话相关表结构（缺 resolution_note / sort / mime，撤销任务无 cancelled）。 */
function v11DialogueTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_messages (
      id               TEXT PRIMARY KEY,
      feedback_id      TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      seq              INTEGER NOT NULL,
      sender_type      TEXT NOT NULL CHECK (sender_type IN ('user','admin','system')),
      sender_id        TEXT NOT NULL DEFAULT '',
      sender_name      TEXT NOT NULL DEFAULT '',
      text             TEXT NOT NULL DEFAULT '',
      idempotency_key  TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_messages_seq ON feedback_messages(feedback_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_messages_idem ON feedback_messages(feedback_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feedback_messages_fb_created ON feedback_messages(feedback_id, created_at);

    CREATE TABLE IF NOT EXISTS feedback_message_attachments (
      id               TEXT PRIMARY KEY,
      message_id       TEXT NOT NULL REFERENCES feedback_messages(id) ON DELETE CASCADE,
      feedback_id      TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK (kind IN ('screenshot','log')),
      filename         TEXT NOT NULL,
      byte_size        INTEGER NOT NULL,
      sha256           TEXT NOT NULL,
      bytes            BLOB NOT NULL,
      width            INTEGER,
      height           INTEGER,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fma_message ON feedback_message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_fma_feedback ON feedback_message_attachments(feedback_id);

    CREATE TABLE IF NOT EXISTS feedback_read_cursors (
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feedback_id      TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      last_read_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (user_id, feedback_id)
    );
    CREATE INDEX IF NOT EXISTS idx_frc_feedback ON feedback_read_cursors(feedback_id);

    CREATE TABLE IF NOT EXISTS kaneo_cancellation_tasks (
      id                  TEXT PRIMARY KEY,
      feedback_id         TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
      archive_round       INTEGER NOT NULL,
      kaneo_task_id       TEXT NOT NULL,
      target_api_base     TEXT NOT NULL,
      target_project_id   TEXT NOT NULL,
      target_workspace_id TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','uncertain','failed','confirmed')),
      attempts            INTEGER NOT NULL DEFAULT 0,
      next_attempt_at     TEXT,
      last_error          TEXT,
      confirmed_at        TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kct_fb_round ON kaneo_cancellation_tasks(feedback_id, archive_round);
    CREATE INDEX IF NOT EXISTS idx_kct_pending ON kaneo_cancellation_tasks(status, next_attempt_at);
  `);
}

/**
 * 造一份 v11 结构的历史库：先经 openDb 得到全部基础表，再按 v11 形状重建对话相关表，
 * 最后把 user_version 置回 11，模拟「上一版本刚部署」的历史库。
 */
function makeV11Db(seed: (db: DatabaseSync) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v12-"));
  const file = path.join(dir, "feedback.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
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
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
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
        issue_status TEXT NOT NULL DEFAULT 'open' CHECK (issue_status IN ('open','waiting_user','waiting_admin','resolved')),
        dialogue_version INTEGER NOT NULL DEFAULT 0,
        archive_round INTEGER NOT NULL DEFAULT 1,
        last_activity_at TEXT NOT NULL DEFAULT '',
        mgmt_state TEXT NOT NULL DEFAULT 'inbox' CHECK (mgmt_state IN ('inbox','archived','trash')),
        resume_paused INTEGER NOT NULL DEFAULT 0,
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
    `);
    v11DialogueTables(db);
    seed(db);
    db.exec("PRAGMA user_version = 11;");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  db.close();
  return dir;
}

/** 基础种子：一个用户、一个软件、两条反馈（一条带旧截图 + 消息附件，一条带撤销任务）。 */
function seedV11(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO users (id, username, pass_hash, role, enabled, daily_limit, created_at) VALUES ('user-1','admin','hash','admin',1,3,?)",
  ).run(NOW);
  db.prepare(
    `INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug,
       name_source, config_status, archive_mode, rule_version, kaneo_column_id, kaneo_label_ids,
       first_seen_at, last_seen_at, created_at, updated_at)
     VALUES ('app-1','com.test.app','测试软件','["http://host.test"]','proj-1','triage',
       'admin','configured','automatic',3,'col-1','["label-bug"]', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW);

  // fb-1：带旧单图截图、一条带两种附件的消息
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       issue_status, archive_round, last_activity_at, mgmt_state, source_origin, created_at, updated_at)
     VALUES ('fb-1','app-1','com.test.app','user-1','历史反馈','key-1','hash-1','archived',
       'resolved',1,?, 'archived','http://host.test',?,?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, capture_json, created_at)
     VALUES ('fb-1', ?, 10, 10, 3, 'sha-fb1', '{"releasePoint":{"x":0.5,"y":0.5}}', ?)`,
  ).run(Buffer.from([0x89, 0x50, 0x4e]), NOW);
  db.prepare(
    `INSERT INTO feedback_messages (id, feedback_id, seq, sender_type, sender_id, sender_name, text, idempotency_key, created_at)
     VALUES ('msg-1','fb-1',1,'user','user-1','testuser','补充了截图与日志','idem-1',?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO feedback_message_attachments (id, message_id, feedback_id, kind, filename, byte_size, sha256, bytes, width, height, created_at)
     VALUES ('att-a','msg-1','fb-1','screenshot','a.png',3,'sha-a',?,10,10,?)`,
  ).run(Buffer.from([1, 2, 3]), NOW);
  db.prepare(
    `INSERT INTO feedback_message_attachments (id, message_id, feedback_id, kind, filename, byte_size, sha256, bytes, created_at)
     VALUES ('att-b','msg-1','fb-1','log','b.log',5,'sha-b',?,?)`,
  ).run(Buffer.from([9, 9, 9, 9, 9]), NOW);

  // fb-2：五个历史轮次各一条撤销任务（(feedback_id, archive_round) 唯一）。
  // pending/processing 是 v12 迁移要取消的存量；uncertain/failed 保留人工核对；confirmed 不重建。
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       issue_status, archive_round, last_activity_at, mgmt_state, source_origin, kaneo_task_id, kaneo_task_url, created_at, updated_at)
     VALUES ('fb-2','app-1','com.test.app','user-1','已同步反馈','key-2','hash-2','archived',
       'open',6,?, 'inbox','http://host.test','task-live','http://kaneo.test/t/live',?,?)`,
  ).run(NOW, NOW, NOW);
  const insTask = db.prepare(
    `INSERT INTO kaneo_cancellation_tasks
       (id, feedback_id, archive_round, kaneo_task_id, target_api_base, target_project_id, target_workspace_id,
        status, attempts, next_attempt_at, last_error, confirmed_at, created_at, updated_at)
     VALUES (?, 'fb-2', ?, ?, 'https://kaneo.example.com/api', 'proj-1', 'ws-1', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insTask.run("kct-confirmed", 1, "task-done", "confirmed", 1, null, null, NOW, NOW, NOW);
  insTask.run("kct-pending", 3, "task-pend", "pending", 0, NOW, null, null, NOW, NOW);
  insTask.run("kct-processing", 4, "task-proc", "processing", 1, NOW, null, null, NOW, NOW);
  insTask.run("kct-uncertain", 5, "task-unc", "uncertain", 2, NOW, "timeout", null, NOW, NOW);
  insTask.run("kct-failed", 6, "task-fail", "failed", 1, null, "403", null, NOW, NOW);
}

describe("迁移 12：多图附件与撤销停止派发", () => {
  it("v11 → v12：新增 feedback_images、消息 resolution_note、附件 sort/mime、撤销任务 cancelled 态与审计", () => {
    const dir = makeV11Db(seedV11);
    const db = openDb(dir);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

    // feedback_images 表已建（空表，可插入且按 (feedback_id, sort) 唯一）
    const imagesCols = (db.prepare("PRAGMA table_info(feedback_images)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of [
      "id",
      "feedback_id",
      "sort",
      "mime",
      "filename",
      "byte_size",
      "sha256",
      "bytes",
      "width",
      "height",
      "capture_json",
      "source",
      "created_at",
    ]) {
      expect(imagesCols).toContain(col);
    }
    db.prepare(
      `INSERT INTO feedback_images (id, feedback_id, sort, mime, filename, byte_size, sha256, bytes, created_at)
       VALUES ('img-x','fb-2',0,'image/png','x.png',3,'sha-x',?,?)`,
    ).run(Buffer.from([1]), NOW);
    expect(() =>
      db
        .prepare(
          `INSERT INTO feedback_images (id, feedback_id, sort, mime, filename, byte_size, sha256, bytes, created_at)
           VALUES ('img-y','fb-2',0,'image/png','y.png',3,'sha-y',?,?)`,
        )
        .run(Buffer.from([2]), NOW),
    ).toThrow(/UNIQUE/i);

    // feedback_messages 新增 resolution_note
    const msgCols = (db.prepare("PRAGMA table_info(feedback_messages)").all() as { name: string }[]).map((c) => c.name);
    expect(msgCols).toContain("resolution_note");

    // 附件表重建：sort 按消息内 rowid 序回填、mime 为 NULL、kind 现允许 'image'
    const attCols = (db.prepare("PRAGMA table_info(feedback_message_attachments)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(attCols).toContain("sort");
    expect(attCols).toContain("mime");
    const atts = db
      .prepare("SELECT id, sort, mime, kind FROM feedback_message_attachments WHERE message_id = 'msg-1' ORDER BY sort")
      .all() as { id: string; sort: number; mime: string | null; kind: string }[];
    expect(atts).toHaveLength(2);
    expect(atts[0]).toMatchObject({ id: "att-a", sort: 0, mime: null, kind: "screenshot" });
    expect(atts[1]).toMatchObject({ id: "att-b", sort: 1, mime: null, kind: "log" });
    // kind='image' 现在可插入
    db.prepare(
      `INSERT INTO feedback_message_attachments (id, message_id, feedback_id, sort, kind, filename, mime, byte_size, sha256, bytes, created_at)
       VALUES ('att-img','msg-1','fb-1',2,'image','c.png','image/png',3,'sha-c',?,?)`,
    ).run(Buffer.from([1]), NOW);

    // 撤销任务：pending/processing → cancelled（next_attempt_at 清空），其余保留
    const tasks = db.prepare("SELECT id, status, next_attempt_at FROM kaneo_cancellation_tasks ORDER BY id").all() as {
      id: string;
      status: string;
      next_attempt_at: string | null;
    }[];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(byId.get("kct-pending")).toMatchObject({ status: "cancelled", next_attempt_at: null });
    expect(byId.get("kct-processing")).toMatchObject({ status: "cancelled", next_attempt_at: null });
    expect(byId.get("kct-uncertain")?.status).toBe("uncertain");
    expect(byId.get("kct-failed")?.status).toBe("failed");
    expect(byId.get("kct-confirmed")?.status).toBe("confirmed");

    // 每条被取消任务补一条审计（actor=system）
    const audits = db
      .prepare(
        "SELECT actor_username, action, detail_json FROM feedback_audit WHERE action = 'kaneo_cancellation_cancelled' ORDER BY detail_json",
      )
      .all() as { actor_username: string; action: string; detail_json: string }[];
    expect(audits).toHaveLength(2);
    for (const a of audits) expect(a.actor_username).toBe("system");
    const taskIds = audits.map((a) => JSON.parse(a.detail_json).taskId).sort();
    expect(taskIds).toEqual(["task-pend", "task-proc"]);

    // 撤销任务表 CHECK 现在接受 'cancelled'（新插入不落该态，但重建后合法）
    const kctSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kaneo_cancellation_tasks'")
      .get() as { sql: string };
    expect(kctSql.sql).toContain("'cancelled'");

    // 旧截图经统一图片视图兼容读入（id='screenshot'，source='capture'）
    const unified = listUnifiedFeedbackImages(db, "fb-1");
    expect(unified).toHaveLength(1);
    expect(unified[0]).toMatchObject({
      id: "screenshot",
      sort: 0,
      mime: "image/png",
      source: "capture",
      sha256: "sha-fb1",
      byteSize: 3,
      width: 10,
      height: 10,
    });
    const shot = getUnifiedFeedbackImage(db, "fb-1", "screenshot");
    expect(shot?.mime).toBe("image/png");
    expect(Buffer.from(shot!.bytes)).toEqual(Buffer.from([0x89, 0x50, 0x4e]));
    // 不存在的 id → null
    expect(getUnifiedFeedbackImage(db, "fb-1", "no-such")).toBeNull();
    // 仅有新表图片的反馈（img-x 已插入 fb-2）→ 只返回新图
    const fb2Images = listUnifiedFeedbackImages(db, "fb-2");
    expect(fb2Images.map((i) => i.id)).toEqual(["img-x"]);

    db.close();
  });

  it("新图片表行与旧截图共存：统一列表先列新图，旧截图以 id='screenshot' 追加", () => {
    const dir = makeV11Db(seedV11);
    const db = openDb(dir);

    // fb-1 既有旧截图，又插入两张新图片（同一反馈多图）
    db.prepare(
      `INSERT INTO feedback_images (id, feedback_id, sort, mime, filename, byte_size, sha256, bytes, created_at)
       VALUES ('img-1','fb-1',0,'image/png','a.png',3,'sha-a',?,?), ('img-2','fb-1',1,'image/jpeg','b.jpg',3,'sha-b',?,?)`,
    ).run(Buffer.from([1]), NOW, Buffer.from([2]), NOW);
    const unified = listUnifiedFeedbackImages(db, "fb-1");
    expect(unified.map((i) => i.id)).toEqual(["img-1", "img-2", "screenshot"]);

    // 新表 id='screenshot' 优先于旧截图兼容行（同 id 冲突以新表为准）
    db.prepare(
      `INSERT INTO feedback_images (id, feedback_id, sort, mime, filename, byte_size, sha256, bytes, created_at)
       VALUES ('screenshot','fb-1',2,'image/png','real.png',4,'sha-real',?,?)`,
    ).run(Buffer.from([4, 4, 4, 4]), NOW);
    const shot = getUnifiedFeedbackImage(db, "fb-1", "screenshot");
    expect(shot?.filename).toBe("real.png");
    expect(Buffer.from(shot!.bytes)).toEqual(Buffer.from([4, 4, 4, 4]));

    db.close();
  });

  it("迁移失败整体回滚：版本号不前进、旧表与数据原样保留，修复后重启可完成迁移", () => {
    // 用完整 v11 库触发真实的撤销任务重建路径；残留的异构 _v12 中间表让重建 INSERT 必然失败
    const dir = makeV11Db(seedV11);
    const file = path.join(dir, "feedback.db");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE kaneo_cancellation_tasks_v12 (junk TEXT)");
    raw.close();

    expect(() => openDb(dir)).toThrow();
    const check = new DatabaseSync(file);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(11);
    // 撤销任务原样保留（附件表重建也已随同一事务回滚：sort/mime 仍不存在）
    const cols = (check.prepare("PRAGMA table_info(feedback_message_attachments)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("mime");
    const statuses = (
      check.prepare("SELECT id, status FROM kaneo_cancellation_tasks ORDER BY id").all() as {
        id: string;
        status: string;
      }[]
    ).map((t) => `${t.id}:${t.status}`);
    expect(statuses).toEqual([
      "kct-confirmed:confirmed",
      "kct-failed:failed",
      "kct-pending:pending",
      "kct-processing:processing",
      "kct-uncertain:uncertain",
    ]);
    check.close();

    // 清掉残留后重开：迁移幂等完成
    const fix = new DatabaseSync(file);
    fix.exec("DROP TABLE kaneo_cancellation_tasks_v12");
    fix.close();
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    // 重建完成后：pending/processing 已置 cancelled
    const after = db.prepare("SELECT status FROM kaneo_cancellation_tasks WHERE id = 'kct-pending'").get() as {
      status: string;
    };
    expect(after.status).toBe("cancelled");
    db.close();
  });

  it("重启（再次 openDb）幂等：结构与数据均不变", () => {
    const dir = makeV11Db(seedV11);
    const first = openDb(dir);
    const digest = (db: DatabaseSync) =>
      JSON.stringify({
        tasks: db.prepare("SELECT id, status, next_attempt_at FROM kaneo_cancellation_tasks ORDER BY id").all(),
        images: db.prepare("SELECT COUNT(*) AS n FROM feedback_images").get(),
        atts: db.prepare("SELECT id, sort, mime, kind FROM feedback_message_attachments ORDER BY id").all(),
      });
    const snapshot = digest(first);
    first.close();

    const second = openDb(dir);
    expect((second.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(digest(second)).toBe(snapshot);
    expect(second.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    second.close();
  });
});
