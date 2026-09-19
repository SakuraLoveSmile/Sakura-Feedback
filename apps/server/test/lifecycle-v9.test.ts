import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import {
  applyLifecycleInTx,
  findAutoArchiveCandidates,
  findResumable,
  getDeletionReceiptByFeedbackId,
  getFeedback,
  insertFeedbackWithScreenshot,
} from "../src/db/repos.ts";
import {
  createTestPng,
  createUserBearer,
  defaultSubmitBody,
  getFeedbackDetail,
  type Harness,
  jsonReq,
  loginAsClient,
  makeHarness,
  submitAndArchive,
  submitFeedback,
} from "./helpers.ts";

/**
 * v9：反馈本地管理生命周期（收件箱 / 已归档 / 回收站 / 彻底删除）。
 *
 * 覆盖：历史库迁移与回滚、归档资格（仅完整同步）、回收站/恢复/彻底删除、
 * 乐观版本冲突、批量部分失败、worker 队列保护、410 语义与提交键防重放。
 */

const NOW = "2026-01-01T00:00:00.000Z";

/** v8 终态结构：apps 带 deleted_at + 活跃部分唯一索引，feedbacks 无 v9 生命周期列。 */
function historicalSchemaV8(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      enabled INTEGER NOT NULL DEFAULT 1, daily_limit INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('cookie','client','handshake')), client_label TEXT,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT,
      expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '[]', kaneo_project_id TEXT NOT NULL DEFAULT '',
      kaneo_column_slug TEXT NOT NULL DEFAULT '',
      name_source TEXT NOT NULL DEFAULT 'client' CHECK (name_source IN ('client','admin')),
      config_status TEXT NOT NULL DEFAULT 'pending' CHECK (config_status IN ('pending','configured')),
      archive_mode TEXT NOT NULL DEFAULT 'manual' CHECK (archive_mode IN ('manual','automatic')),
      rule_version INTEGER NOT NULL DEFAULT 0,
      kaneo_column_id TEXT NOT NULL DEFAULT '', kaneo_label_ids TEXT NOT NULL DEFAULT '[]',
      kaneo_assignee_id TEXT, kaneo_assignee_name TEXT,
      auto_enabled_at TEXT, auto_enabled_by TEXT, auto_operation_id TEXT,
      first_seen_at TEXT, last_seen_at TEXT, deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_apps_active_appid ON apps(app_id) WHERE deleted_at IS NULL;
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
    PRAGMA user_version = 8;
  `);
}

/** 造一份带完整历史（反馈 + 截图 + 日志 + 审计 + 远端关联）的 v8 库。 */
function seedV8(db: DatabaseSync): void {
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
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       title, kaneo_task_id, kaneo_task_url, archive_stage, source_origin, archive_authorized_at,
       archive_authorized_by, archive_operation_id, archive_authorized_kind, archive_rule_version,
       created_at, updated_at)
     VALUES ('fb-archived','app-1','com.test.app','user-1','已同步历史反馈','key-1','hash-1','archived',
       '旧标题','task-9','http://kaneo.test/t/9','complete','http://host.test',?, 'user-1','op-arch','manual',3,?,?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       source_origin, created_at, updated_at)
     VALUES ('fb-pending','app-1','com.test.app','user-1','待处理反馈','key-2','hash-2','needs_info','http://host.test',?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, created_at)
     VALUES ('fb-archived', ?, 10, 10, 3, 'sha-fb1', ?)`,
  ).run(Buffer.from([1, 2, 3]), NOW);
  db.prepare(
    `INSERT INTO feedback_logs (id, feedback_id, sort_order, filename, source, bytes, byte_size, sha256, created_at)
     VALUES ('log-1','fb-archived',0,'app.log','auto',?,2,'logsha',?)`,
  ).run(Buffer.from([9, 9]), NOW);
  db.prepare(
    `INSERT INTO feedback_audit (id, feedback_id, at, actor_user_id, actor_username, action, detail_json)
     VALUES ('audit-1','fb-archived',?,'user-1','admin','archive_authorize','{}')`,
  ).run(NOW);
}

function makeV8Db(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v9-"));
  const raw = new DatabaseSync(path.join(dir, "feedback.db"));
  historicalSchemaV8(raw);
  seedV8(raw);
  raw.close();
  return dir;
}

const fbCols = (db: DatabaseSync) =>
  (db.prepare("PRAGMA table_info(feedbacks)").all() as { name: string }[]).map((c) => c.name);

describe("迁移 9：反馈本地管理生命周期", () => {
  it("全新库直接带生命周期列、回收站索引与删除凭据表", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v9-fresh-"));
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    const cols = fbCols(db);
    for (const c of [
      "mgmt_state",
      "mgmt_archived_at",
      "mgmt_archived_by",
      "mgmt_trashed_at",
      "mgmt_trashed_by",
      "lifecycle_version",
      "resume_paused",
    ]) {
      expect(cols).toContain(c);
    }
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toContain("feedback_deletion_receipts");
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_feedbacks_mgmt'").get() as
      | { sql: string }
      | undefined;
    expect(idx?.sql).toContain("mgmt_state");
    db.close();
  });

  it("v8 → v9：历史记录一律落收件箱，远端关联/附件/审计/授权证据全部保留", () => {
    const dir = makeV8Db();
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

    // 历史记录全部进入收件箱（包括已同步的 archived 处理状态），不自动迁入已归档区。
    const fb1 = db.prepare("SELECT * FROM feedbacks WHERE id = 'fb-archived'").get() as Record<string, unknown>;
    expect(fb1.status).toBe("archived");
    expect(fb1.mgmt_state).toBe("inbox");
    expect(fb1.kaneo_task_id).toBe("task-9");
    expect(fb1.archive_operation_id).toBe("op-arch");
    expect(fb1.lifecycle_version).toBe(0);
    expect(fb1.resume_paused).toBe(0);
    const fb2 = db.prepare("SELECT mgmt_state FROM feedbacks WHERE id = 'fb-pending'").get() as {
      mgmt_state: string;
    };
    expect(fb2.mgmt_state).toBe("inbox");

    // 附件与审计原样保留。
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_screenshots").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_logs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_audit").get()).toEqual({ n: 1 });
    db.close();
  });

  it("重启（再次 openDb）幂等：结构与数据均不变", () => {
    const dir = makeV8Db();
    const first = openDb(dir);
    const digest = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT * FROM feedbacks ORDER BY id").all());
    const snapshot = digest(first);
    first.close();

    const second = openDb(dir);
    expect((second.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(digest(second)).toBe(snapshot);
    expect(second.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    second.close();
  });

  it("迁移失败整体回滚：版本号不前进、新列不存在，修复后重启可完成迁移", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-v9-fail-"));
    const file = path.join(dir, "feedback.db");
    const raw = new DatabaseSync(file);
    historicalSchemaV8(raw);
    seedV8(raw);
    // 注入失败：残留的异构凭据表让索引创建必然失败
    raw.exec("CREATE TABLE feedback_deletion_receipts (junk TEXT)");
    raw.close();

    expect(() => openDb(dir)).toThrow();
    const check = new DatabaseSync(file);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
    expect(fbCols(check)).not.toContain("mgmt_state");
    expect(check.prepare("SELECT COUNT(*) n FROM feedbacks").get()).toEqual({ n: 2 });
    check.close();

    // 清掉残留后重开：迁移幂等完成
    const fix = new DatabaseSync(file);
    fix.exec("DROP TABLE feedback_deletion_receipts");
    fix.close();
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(db.prepare("SELECT COUNT(*) n FROM feedbacks").get()).toEqual({ n: 2 });
    db.close();
  });
});

// ------------------------------------------------------------------ 生命周期动作（API + 数据层）

const actor = { id: "admin-1", username: "admin" };

/** 调生命周期接口。 */
async function lifecycle(h: Harness, action: string, items: Array<{ id: string; expectedVersion: number }>) {
  return jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/lifecycle", {
    cookie: h.cookie,
    body: { action, items },
  });
}

/** 读当前生命周期版本（列表项返回）。 */
async function lifecycleVersion(h: Harness, id: string): Promise<number> {
  const d = await getFeedbackDetail(h, id);
  if (d.status !== 200) throw new Error(`读取详情失败 ${d.status}: ${d.text}`);
  return d.data.lifecycleVersion as number;
}

describe("生命周期动作", () => {
  it("新提交进入收件箱；同步成功后仍在收件箱，不自动归档", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h); // 走完 AI + 授权 + 远端同步 → status=archived
      const detail = await getFeedbackDetail(h, id);
      expect(detail.data.status).toBe("archived");
      expect(detail.data.mgmtState).toBe("inbox"); // 同步成功不自动归档
      expect(detail.data.lifecycleVersion).toBe(0);

      const inbox = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?view=inbox", {
        cookie: h.cookie,
      });
      expect(inbox.data.items.map((i: { id: string }) => i.id)).toContain(id);
      const archived = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?view=archived", {
        cookie: h.cookie,
      });
      expect(archived.data.items.map((i: { id: string }) => i.id)).not.toContain(id);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("归档资格：仅完整同步（status=archived）可归档；其他状态 409", async () => {
    const h = await makeHarness();
    try {
      // needs_info（未同步）记录不可归档
      const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
      const id = r.data.feedbackId as string;
      await h.feedbackApp.worker.idle(); // AI 整理 → needs_info
      const v = await lifecycleVersion(h, id);
      const denied = await lifecycle(h, "archive", [{ id, expectedVersion: v }]);
      expect(denied.status).toBe(409);
      expect(denied.data.error.code).toBe("invalid_state");
      expect(getFeedback(h.feedbackApp.db, id)?.mgmt_state).toBe("inbox");

      // 完整同步后可归档
      const synced = await submitAndArchive(h, { idempotencyKey: "key-sync-1" });
      const v2 = await lifecycleVersion(h, synced);
      const ok = await lifecycle(h, "archive", [{ id: synced, expectedVersion: v2 }]);
      expect(ok.status).toBe(200);
      expect(ok.data.results[0].ok).toBe(true);
      expect(ok.data.results[0].mgmtState).toBe("archived");
      const row = getFeedback(h.feedbackApp.db, synced)!;
      expect(row.mgmt_state).toBe("archived");
      expect(row.mgmt_archived_by).toBeTruthy();
      expect(row.lifecycle_version).toBe(v2 + 1);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("乐观版本冲突：expectedVersion 过期 → 409 version_conflict，不写任何内容", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h);
      const v = await lifecycleVersion(h, id);
      const ok = await lifecycle(h, "archive", [{ id, expectedVersion: v }]);
      expect(ok.status).toBe(200);
      // 用旧版本重复归档 → 冲突（幂等重放被拒绝，不悄悄再写）
      const stale = await lifecycle(h, "archive", [{ id, expectedVersion: v }]);
      expect(stale.status).toBe(409);
      expect(stale.data.error.code).toBe("version_conflict");
      expect(getFeedback(h.feedbackApp.db, id)!.lifecycle_version).toBe(v + 1);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("回收站：移入保留全部数据与远端关联；详情只读；分类被拒绝", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h);
      const v = await lifecycleVersion(h, id);
      const t = await lifecycle(h, "trash", [{ id, expectedVersion: v }]);
      expect(t.status).toBe(200);

      const row = getFeedback(h.feedbackApp.db, id)!;
      expect(row.mgmt_state).toBe("trash");
      expect(row.kaneo_task_id).toBeTruthy(); // 远端关联保留
      expect(row.archive_authorized_at).toBeTruthy(); // 授权证据保留
      expect(row.text).toContain("CSV");

      const detail = await getFeedbackDetail(h, id);
      expect(detail.status).toBe(200);
      expect(detail.data.readOnly).toBe(true);
      expect(detail.data.mgmtState).toBe("trash");
      expect(detail.data.availableActions).toEqual(["restore", "purge"]);

      // 回收站记录分类被拒（409 feedback_in_trash）
      const classify = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
        cookie: h.cookie,
        body: {
          action: "save",
          classifyVersion: detail.data.classification.version,
          projectId: "proj-1",
        },
      });
      expect(classify.status).toBe(409);
      expect(classify.data.error.code).toBe("feedback_in_trash");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("恢复：统一返回收件箱；未完成记录保持暂停，不自动重发", async () => {
    const h = await makeHarness();
    try {
      // 未完成的 needs_info 记录：移入回收站 → 恢复 → 仍暂停，不自动处理
      const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
      const id = r.data.feedbackId as string;
      await h.feedbackApp.worker.idle();
      const aiCallsBefore = h.ai.calls;

      const v = await lifecycleVersion(h, id);
      await lifecycle(h, "trash", [{ id, expectedVersion: v }]);
      expect(getFeedback(h.feedbackApp.db, id)!.resume_paused).toBe(1);

      const v2 = await lifecycleVersion(h, id);
      const restored = await lifecycle(h, "restore", [{ id, expectedVersion: v2 }]);
      expect(restored.status).toBe(200);
      const row = getFeedback(h.feedbackApp.db, id)!;
      expect(row.mgmt_state).toBe("inbox");
      expect(row.resume_paused).toBe(1); // 未完成记录恢复后仍暂停

      await h.feedbackApp.worker.idle();
      await h.feedbackApp.worker.scanAutoArchive();
      await h.feedbackApp.worker.idle();
      // 恢复后不自动重发：AI 调用数不变（记录仍暂停）
      expect(h.ai.calls).toBe(aiCallsBefore);

      // 显式恢复处理后才会继续
      const v3 = await lifecycleVersion(h, id);
      const resumed = await lifecycle(h, "resume_processing", [{ id, expectedVersion: v3 }]);
      expect(resumed.status).toBe(200);
      expect(getFeedback(h.feedbackApp.db, id)!.resume_paused).toBe(0);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("彻底删除：仅回收站可执行；清 BLOB/审计、留最小凭据；重复删除幂等；详情 410", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h, {
        idempotencyKey: "purge-key-1",
        text: "待删除的反馈正文内容",
      });
      const v = await lifecycleVersion(h, id);
      await lifecycle(h, "trash", [{ id, expectedVersion: v }]);
      const v2 = await lifecycleVersion(h, id);

      const purged = await lifecycle(h, "purge", [{ id, expectedVersion: v2 }]);
      expect(purged.status).toBe(200);
      expect(purged.data.results[0].purged).toBe(true);

      // 反馈、截图、日志、审计全部删除
      expect(getFeedback(h.feedbackApp.db, id)).toBeNull();
      expect(
        h.feedbackApp.db.prepare("SELECT COUNT(*) n FROM feedback_screenshots WHERE feedback_id = ?").get(id),
      ).toEqual({ n: 0 });
      expect(h.feedbackApp.db.prepare("SELECT COUNT(*) n FROM feedback_logs WHERE feedback_id = ?").get(id)).toEqual({
        n: 0,
      });
      expect(h.feedbackApp.db.prepare("SELECT COUNT(*) n FROM feedback_audit WHERE feedback_id = ?").get(id)).toEqual({
        n: 0,
      });

      // 最小凭据保留（不含正文）
      const receipt = getDeletionReceiptByFeedbackId(h.feedbackApp.db, id)!;
      expect(receipt).toBeTruthy();
      expect(receipt.user_id).toBeTruthy();
      expect(receipt.idempotency_key_hash).toBeTruthy();
      expect(receipt.idempotency_key_hash).not.toContain("purge-key-1");

      // 详情 → 410（区别于普通 404）
      const detail = await getFeedbackDetail(h, id);
      expect(detail.status).toBe(410);
      expect(detail.data.error.code).toBe("feedback_purged");

      // 重复彻底删除幂等成功
      const again = await lifecycle(h, "purge", [{ id, expectedVersion: v2 }]);
      expect(again.status).toBe(200);
      expect(again.data.results[0].alreadyPurged).toBe(true);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("提交键防重放：彻底删除后同一幂等键返回 410，不新建记录", async () => {
    const h = await makeHarness();
    try {
      const key = "purged-replay-key";
      const id = await submitAndArchive(h, { idempotencyKey: key });
      const v = await lifecycleVersion(h, id);
      await lifecycle(h, "trash", [{ id, expectedVersion: v }]);
      const v2 = await lifecycleVersion(h, id);
      await lifecycle(h, "purge", [{ id, expectedVersion: v2 }]);

      // 同账号同键重放 → 410
      const replay = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: key }));
      expect(replay.status).toBe(410);
      expect(replay.data.error.code).toBe("feedback_purged");
      expect(h.feedbackApp.db.prepare("SELECT COUNT(*) n FROM feedbacks").get()).toEqual({ n: 0 });
    } finally {
      h.feedbackApp.close();
    }
  });

  it("批量：部分失败不回滚成功项；逐项返回原因", async () => {
    const h = await makeHarness();
    try {
      const ok1 = await submitAndArchive(h, { idempotencyKey: "batch-1" });
      const ok2 = await submitAndArchive(h, { idempotencyKey: "batch-2" });
      const notSynced = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "batch-3" }));
      const badId = notSynced.data.feedbackId as string;
      await h.feedbackApp.worker.idle(); // needs_info，不可归档

      const [v1, v2, v3] = await Promise.all([
        lifecycleVersion(h, ok1),
        lifecycleVersion(h, ok2),
        lifecycleVersion(h, badId),
      ]);
      const res = await lifecycle(h, "archive", [
        { id: ok1, expectedVersion: v1 },
        { id: "fb-nonexistent", expectedVersion: 0 },
        { id: ok2, expectedVersion: v2 + 99 }, // 版本冲突
        { id: badId, expectedVersion: v3 }, // 状态不可归档
      ]);
      expect(res.status).toBe(200);
      const results = res.data.results as Array<{ id: string; ok: boolean; code?: string }>;
      expect(results[0]).toMatchObject({ id: ok1, ok: true, mgmtState: "archived" });
      expect(results[1]).toMatchObject({ id: "fb-nonexistent", ok: false, code: "not_found" });
      expect(results[2]).toMatchObject({ id: ok2, ok: false, code: "version_conflict" });
      expect(results[3]).toMatchObject({ id: badId, ok: false, code: "invalid_state" });

      // 成功项已生效，失败项原样
      expect(getFeedback(h.feedbackApp.db, ok1)!.mgmt_state).toBe("archived");
      expect(getFeedback(h.feedbackApp.db, ok2)!.mgmt_state).toBe("inbox");
      expect(getFeedback(h.feedbackApp.db, badId)!.mgmt_state).toBe("inbox");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("非法输入整体拒绝：未知 action / 空 items / 超 100 条 / 非整数版本", async () => {
    const h = await makeHarness();
    try {
      const bad1 = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/lifecycle", {
        cookie: h.cookie,
        body: { action: "nope", items: [{ id: "x", expectedVersion: 0 }] },
      });
      expect(bad1.status).toBe(400);
      const bad2 = await lifecycle(h, "archive", []);
      expect(bad2.status).toBe(400);
      const bad3 = await lifecycle(h, "archive", [{ id: "x", expectedVersion: -1 }]);
      expect(bad3.status).toBe(400);
      const bad4 = await lifecycle(
        h,
        "archive",
        Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, expectedVersion: 0 })),
      );
      expect(bad4.status).toBe(400);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("普通账号无管理权限：生命周期接口 401/403", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h);
      const userBearer = await createUserBearer(h, { username: "plain-user" });
      const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/lifecycle", {
        bearer: userBearer,
        body: { action: "trash", items: [{ id, expectedVersion: 0 }] },
      });
      expect([401, 403]).toContain(r.status);
    } finally {
      h.feedbackApp.close();
    }
  });
});

// ------------------------------------------------------------------ 列表 / 计数 / 筛选

describe("列表视图与筛选", () => {
  it("三个区域计数按当前筛选计算；view=all 兼容查询含收件箱+已归档、不含回收站", async () => {
    const h = await makeHarness();
    try {
      const a = await submitAndArchive(h, { idempotencyKey: "view-a", text: "归档候选甲" });
      const b = await submitAndArchive(h, { idempotencyKey: "view-b", text: "归档候选乙" });
      const c = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "view-c" }));
      const cid = c.data.feedbackId as string;
      await h.feedbackApp.worker.idle();

      const va = await lifecycleVersion(h, a);
      await lifecycle(h, "archive", [{ id: a, expectedVersion: va }]);
      const vc = await lifecycleVersion(h, cid);
      await lifecycle(h, "trash", [{ id: cid, expectedVersion: vc }]);

      const counts = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback/counts", { cookie: h.cookie });
      expect(counts.data).toMatchObject({ inbox: 1, archived: 1, trash: 1 });

      const all = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?view=all", { cookie: h.cookie });
      const ids = all.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(b);
      expect(ids).toContain(a); // all = inbox + archived
      expect(ids).not.toContain(cid); // 不含回收站

      const trash = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?view=trash", { cookie: h.cookie });
      expect(trash.data.items.map((i: { id: string }) => i.id)).toEqual([cid]);
      expect(trash.data.items[0].availableActions).toEqual(["restore", "purge"]);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("关键词搜索命中标题/原文/反馈 ID；通配符按字面处理；日期半开区间；稳定分页", async () => {
    const h = await makeHarness();
    try {
      await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "s1", text: "导出报表很卡" }));
      await submitFeedback(
        h.feedbackApp,
        h.bearer,
        defaultSubmitBody({ idempotencyKey: "s2", text: "希望支持 100% 缩放" }),
      );
      await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "s3", text: "夜间模式建议" }));
      await h.feedbackApp.worker.idle();

      const byText = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?q=${encodeURIComponent("报表")}`, {
        cookie: h.cookie,
      });
      expect(byText.data.items).toHaveLength(1);
      expect(byText.data.items[0].textPreview).toContain("报表");

      // 通配符 % 按字面处理：只命中包含「100%」的原文
      const literal = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?q=${encodeURIComponent("100%")}`, {
        cookie: h.cookie,
      });
      expect(literal.data.items).toHaveLength(1);

      // 按 ID 搜索
      const first = byText.data.items[0].id as string;
      const byId = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?q=${first}`, { cookie: h.cookie });
      expect(byId.data.items.map((i: { id: string }) => i.id)).toEqual([first]);

      // 日期边界：from/to 为 UTC 半开区间
      const future = new Date(Date.now() + 86400_000).toISOString();
      const ranged = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?from=${encodeURIComponent(future)}`, {
        cookie: h.cookie,
      });
      expect(ranged.data.items).toHaveLength(0);
      const past = await jsonReq(
        h.feedbackApp.app,
        "GET",
        `/api/admin/feedback?to=${encodeURIComponent(new Date(Date.now() - 86400_000).toISOString())}`,
        { cookie: h.cookie },
      );
      expect(past.data.items).toHaveLength(0);

      // 稳定分页：limit=2 翻页取第三条
      const p1 = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?limit=2", { cookie: h.cookie });
      expect(p1.data.items).toHaveLength(2);
      expect(p1.data.nextCursor).toBeTruthy();
      const p2 = await jsonReq(
        h.feedbackApp.app,
        "GET",
        `/api/admin/feedback?limit=2&cursor=${encodeURIComponent(p1.data.nextCursor)}`,
        { cookie: h.cookie },
      );
      expect(p2.data.items).toHaveLength(1);
      const allIds = [...p1.data.items, ...p2.data.items].map((i: { id: string }) => i.id);
      expect(new Set(allIds).size).toBe(3); // 无重复
    } finally {
      h.feedbackApp.close();
    }
  });

  it("软件选项含已删除软件的历史反馈；appId 过滤生效", async () => {
    const h = await makeHarness();
    try {
      await submitAndArchive(h, { idempotencyKey: "opt-1" });
      // 软删除软件后其历史反馈仍应出现在选项中
      const del = await jsonReq(h.feedbackApp.app, "DELETE", `/api/admin/apps/${h.app.id}`, { cookie: h.cookie });
      expect(del.status).toBe(204);

      const opts = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback/app-options", {
        cookie: h.cookie,
      });
      const found = (opts.data.items as Array<{ appId: string; deleted: boolean }>).find(
        (o) => o.appId === "com.test.app",
      );
      expect(found).toBeTruthy();
      expect(found!.deleted).toBe(true);

      const filtered = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?appId=com.test.app", {
        cookie: h.cookie,
      });
      expect(filtered.data.items.length).toBeGreaterThan(0);
      const none = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?appId=com.missing", {
        cookie: h.cookie,
      });
      expect(none.data.items).toHaveLength(0);
    } finally {
      h.feedbackApp.close();
    }
  });
});

// ------------------------------------------------------------------ worker 保护

describe("worker 队列保护", () => {
  it("排队但未执行的记录移入回收站后不再发起 AI/Kaneo 处理", async () => {
    const h = await makeHarness();
    try {
      // 直接落库两条 received 记录（不经由提交路由的自动入队）：
      // A 先入队开始处理（在 AI await 处让出），B 排在队列中等待。
      const appRow = h.feedbackApp.db.prepare("SELECT id FROM apps WHERE app_id = 'com.test.app'").get() as {
        id: string;
      };
      const mk = (key: string) =>
        insertFeedbackWithScreenshot(h.feedbackApp.db, {
          appId: "com.test.app",
          appRowId: appRow.id,
          userId: "",
          text: `排队记录 ${key}`,
          contextJson: null,
          idempotencyKey: key,
          contentHash: key,
        });
      const a = mk("queued-a");
      const b = mk("queued-then-trash");
      const aiBefore = h.ai.calls;
      const kaneoBefore = h.kaneo.remoteCalls;

      // B 排队期间被移入回收站：drain 轮到它时 processLocked 重读管理状态并拦下。
      h.feedbackApp.worker.enqueue(a.id);
      h.feedbackApp.worker.enqueue(b.id);
      applyLifecycleInTx(h.feedbackApp.db, b.id, { action: "trash", expectedVersion: 0, actor });
      await h.feedbackApp.worker.idle();

      // A 正常完成（needs_info），B 从未进入 AI/Kaneo 处理。
      expect(h.ai.calls).toBe(aiBefore + 1);
      expect(h.kaneo.remoteCalls).toBe(kaneoBefore);
      const bRow = getFeedback(h.feedbackApp.db, b.id)!;
      expect(bRow.status).toBe("received");
      expect(bRow.mgmt_state).toBe("trash");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("重启恢复扫描排除回收站与暂停记录", async () => {
    const h = await makeHarness();
    try {
      const appRow = h.feedbackApp.db.prepare("SELECT id FROM apps WHERE app_id = 'com.test.app'").get() as {
        id: string;
      };
      const mk = (key: string) =>
        insertFeedbackWithScreenshot(h.feedbackApp.db, {
          appId: "com.test.app",
          appRowId: appRow.id,
          userId: "",
          text: `记录 ${key}`,
          contextJson: null,
          idempotencyKey: key,
          contentHash: key,
        });
      const trashed = mk("scan-trashed");
      const paused = mk("scan-paused");
      const normal = mk("scan-normal");

      applyLifecycleInTx(h.feedbackApp.db, trashed.id, { action: "trash", expectedVersion: 0, actor });
      h.feedbackApp.db.prepare("UPDATE feedbacks SET resume_paused = 1 WHERE id = ?").run(paused.id);

      const { requeue } = findResumable(h.feedbackApp.db);
      const ids = requeue.map((r) => r.id);
      expect(ids).not.toContain(trashed.id);
      expect(ids).not.toContain(paused.id);
      expect(ids).toContain(normal.id);

      // 自动归档扫描同样排除
      const candidates = findAutoArchiveCandidates(h.feedbackApp.db).map((r) => r.id);
      expect(candidates).not.toContain(trashed.id);
      expect(candidates).not.toContain(paused.id);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("回收站记录的人工恢复动作一律拒绝（retry/recheck/recover → 409）", async () => {
    const h = await makeHarness();
    try {
      const id = await submitAndArchive(h);
      const v = await lifecycleVersion(h, id);
      await lifecycle(h, "trash", [{ id, expectedVersion: v }]);

      const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/retry`, {
        cookie: h.cookie,
        body: {},
      });
      expect(retry.status).toBe(409);
      const resolve = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
        cookie: h.cookie,
        body: { action: "recheck" },
      });
      expect(resolve.status).toBe(409);
      const recover = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
        cookie: h.cookie,
        body: { action: "retry_comment", expectedRevision: 0 },
      });
      expect(recover.status).toBe(409);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("所属用户读取已彻底删除记录返回 410；其他用户 404 不泄露存在性", async () => {
    const h = await makeHarness();
    try {
      // 用普通账号提交，确保 user_id 是该账号
      const userBearer = await createUserBearer(h, { username: "owner-user" });
      const sub = await submitFeedback(h.feedbackApp, userBearer, defaultSubmitBody({ idempotencyKey: "own-1" }));
      const id = sub.data.feedbackId as string;
      await h.feedbackApp.worker.idle();

      const v = await lifecycleVersion(h, id);
      await lifecycle(h, "trash", [{ id, expectedVersion: v }]);
      const v2 = await lifecycleVersion(h, id);
      await lifecycle(h, "purge", [{ id, expectedVersion: v2 }]);

      // 所属用户 → 410
      const own = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${id}`, { bearer: userBearer });
      expect(own.status).toBe(410);
      expect(own.data.error.code).toBe("feedback_purged");

      // 其他普通用户 → 404（不透露记录存在过）
      const otherBearer = await createUserBearer(h, { username: "other-user" });
      const other = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${id}`, { bearer: otherBearer });
      expect(other.status).toBe(404);
    } finally {
      h.feedbackApp.close();
    }
  });
});
