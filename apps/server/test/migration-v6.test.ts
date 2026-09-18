import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import { collectionStateFor } from "../src/db/repos.ts";

/**
 * 迁移 6（人工分类归档改造）历史数据库验证。
 *
 * 用**隔离目录中的历史版本数据库副本**验证升级：绝不直接启动新版服务迁移真实数据库。
 * 覆盖 v3 / v4 / v5 三种历史版本，以及各种历史恢复状态（legacy assetUrl / v1 / v2 /
 * 损坏 / 未知版本）与历史状态（received / processing / needs_review / failed / archiving / archived）。
 */

const NOW = "2026-01-01T00:00:00.000Z";

function historicalSchema(db: DatabaseSync, version: 3 | 4 | 5): void {
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
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '[]', kaneo_project_id TEXT NOT NULL DEFAULT '',
      kaneo_column_slug TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, reset_at TEXT NOT NULL, PRIMARY KEY (user_id, day)
    );
    CREATE TABLE feedbacks (
      id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL REFERENCES apps(id), app_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, context_json TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received','processing','archiving','needs_review','archived','failed')),
      title TEXT, processed_json TEXT, kaneo_task_id TEXT, kaneo_task_url TEXT,
      archive_stage TEXT CHECK (archive_stage IN ('task_pending','task_created','asset_uploading','asset_finalized','comment_pending','complete')),
      archive_data_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_feedbacks_status ON feedbacks(status);
    CREATE INDEX idx_feedbacks_app ON feedbacks(app_row_id, created_at);
    CREATE TABLE feedback_screenshots (
      feedback_id TEXT PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
      png_blob BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, capture_json TEXT, created_at TEXT NOT NULL
    );
  `);
  if (version >= 4) {
    db.exec(`
      CREATE TABLE feedback_logs (
        id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL, filename TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('auto','manual')), bytes BLOB NOT NULL,
        byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_feedback_logs_feedback ON feedback_logs(feedback_id, sort_order);
    `);
  }
  db.exec(`PRAGMA user_version = ${version};`);
}

interface SeedSpec {
  id: string;
  status: string;
  title?: string | null;
  archiveStage?: string | null;
  archiveData?: string | null;
  taskId?: string | null;
  withScreenshot?: boolean;
  logs?: Array<{ id: string; filename: string }>;
}

function seed(db: DatabaseSync, version: 3 | 4 | 5, specs: SeedSpec[]): void {
  db.prepare(
    "INSERT INTO users (id, username, pass_hash, role, enabled, daily_limit, created_at) VALUES (?, ?, ?, 'admin', 1, 3, ?)",
  ).run("user-1", "admin", "hash", NOW);
  db.prepare(
    "INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("app-1", "com.test.app", "测试软件", '["http://host.test"]', "proj-1", "triage", NOW, NOW);

  const ins = db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, context_json, idempotency_key, content_hash,
       status, title, processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json,
       attempt_count, last_error, error_summary, created_at, updated_at)
     VALUES (?, 'app-1', 'com.test.app', 'user-1', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
  );
  for (const s of specs) {
    ins.run(
      s.id,
      `反馈 ${s.id}`,
      `key-${s.id}`,
      `hash-${s.id}`,
      s.status,
      s.title ?? null,
      s.taskId ?? null,
      s.taskId ? `http://kaneo.test/task/${s.taskId}` : null,
      s.archiveStage ?? "task_pending",
      s.archiveData ?? null,
      NOW,
      NOW,
    );
    if (s.withScreenshot) {
      db.prepare(
        "INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, capture_json, created_at) VALUES (?, ?, 10, 10, 3, ?, NULL, ?)",
      ).run(s.id, Buffer.from([1, 2, 3]), `sha-${s.id}`, NOW);
    }
    if (version >= 4 && s.logs) {
      for (const [i, l] of s.logs.entries()) {
        db.prepare(
          "INSERT INTO feedback_logs (id, feedback_id, sort_order, filename, source, bytes, byte_size, sha256, created_at) VALUES (?, ?, ?, ?, 'auto', ?, 2, ?, ?)",
        ).run(l.id, s.id, i, l.filename, Buffer.from([9, 9]), `logsha-${l.id}`, NOW);
      }
    }
  }
}

const HISTORICAL_DATA = {
  legacyAssetUrl: JSON.stringify({ assetUrl: "http://kaneo.test/assets/old.png" }),
  v1: JSON.stringify({
    version: 1,
    revision: 2,
    target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
    asset: { id: "", url: "http://kaneo.test/assets/v1.png" },
  }),
  v2Partial: JSON.stringify({
    version: 2,
    revision: 3,
    target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
    attachments: {},
    upload: {
      key: "key-1",
      credentialsEnc: "v1:aa:bb:cc",
      expiresAt: null,
      outcome: "maybe_sent",
      recoveries: 0,
    },
  }),
  v2Complete: JSON.stringify({
    version: 2,
    revision: 4,
    target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
    attachments: {
      screenshot: {
        id: "screenshot",
        kind: "screenshot",
        filename: "screenshot.png",
        byteSize: 3,
        sha256: "sha-fb-archived",
        asset: { id: "asset-1", url: "http://kaneo.test/assets/a.png" },
        comment: { marker: "fb-archived|sha-fb-archived", id: "c-1", outcome: "confirmed" },
      },
    },
    asset: { id: "asset-1", url: "http://kaneo.test/assets/a.png" },
    comment: { marker: "fb-archived|sha-fb-archived", id: "c-1", outcome: "confirmed" },
  }),
  corrupt: "{not json",
  unsupported: JSON.stringify({ version: 99, revision: 1 }),
};

function runMigration(
  version: 3 | 4 | 5,
  specs: SeedSpec[],
): { dir: string; db: DatabaseSync; before: Record<string, { status: string; archiveData: string | null }> } {
  const dir = mkdtempSync(path.join(tmpdir(), `feedback-mig-v${version}-`));
  const file = path.join(dir, "feedback.db");
  const raw = new DatabaseSync(file);
  historicalSchema(raw, version);
  seed(raw, version, specs);
  const before: Record<string, { status: string; archiveData: string | null }> = {};
  for (const r of raw.prepare("SELECT id, status, archive_data_json FROM feedbacks").all() as {
    id: string;
    status: string;
    archive_data_json: string | null;
  }[]) {
    before[r.id] = { status: r.status, archiveData: r.archive_data_json };
  }
  raw.close();
  const db = openDb(dir);
  return { dir, db, before };
}

const SPECS: SeedSpec[] = [
  // 未发生远端写入的旧 received/processing → 接入人工流程
  { id: "fb-received", status: "received", withScreenshot: true },
  { id: "fb-processing", status: "processing", withScreenshot: true },
  // 已有 failed / needs_review 不自动重跑
  { id: "fb-failed", status: "failed" },
  { id: "fb-review", status: "needs_review", taskId: "task-9", archiveData: HISTORICAL_DATA.v2Partial },
  // 已开始远端写入：保留原目标与恢复上下文
  {
    id: "fb-archiving",
    status: "archiving",
    taskId: "task-10",
    archiveStage: "asset_uploading",
    archiveData: HISTORICAL_DATA.v1,
  },
  {
    id: "fb-archived",
    status: "archived",
    taskId: "task-11",
    archiveStage: "complete",
    archiveData: HISTORICAL_DATA.v2Complete,
    withScreenshot: true,
  },
  // 历史恢复状态
  { id: "fb-legacy", status: "needs_review", archiveData: HISTORICAL_DATA.legacyAssetUrl },
  { id: "fb-corrupt", status: "needs_review", archiveData: HISTORICAL_DATA.corrupt },
  { id: "fb-unsupported", status: "needs_review", taskId: "task-12", archiveData: HISTORICAL_DATA.unsupported },
];

describe("迁移 6：历史数据库升级", () => {
  for (const version of [3, 4, 5] as const) {
    it(`v${version} → 最新版本：状态接管、外键、内容摘要与附件全部保留`, () => {
      const { db, before } = runMigration(version, SPECS);

      // v6 引入人工分类归档；v7 叠加“先接收后配置 / 自动归档”；v8 软件软删除；v9 反馈生命周期，终态为 9。
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

      // 未发生远端写入的 received/processing 接入人工流程
      expect(db.prepare("SELECT status FROM feedbacks WHERE id = 'fb-received'").get()).toEqual({
        status: "needs_info",
      });
      expect(db.prepare("SELECT status FROM feedbacks WHERE id = 'fb-processing'").get()).toEqual({
        status: "needs_info",
      });
      // 其余历史状态原样保留
      for (const id of [
        "fb-failed",
        "fb-review",
        "fb-archiving",
        "fb-archived",
        "fb-legacy",
        "fb-corrupt",
        "fb-unsupported",
      ]) {
        const cur = db.prepare("SELECT status, archive_data_json FROM feedbacks WHERE id = ?").get(id) as {
          status: string;
          archive_data_json: string | null;
        };
        expect(cur.status).toBe(before[id]!.status);
        expect(cur.archive_data_json).toBe(before[id]!.archiveData);
      }

      // 新字段默认值
      const row = db
        .prepare(
          "SELECT classify_labels_json, classify_version, archive_authorized_at FROM feedbacks WHERE id = 'fb-received'",
        )
        .get() as {
        classify_labels_json: string;
        classify_version: number;
        archive_authorized_at: string | null;
      };
      expect(row).toEqual({ classify_labels_json: "[]", classify_version: 0, archive_authorized_at: null });

      // 附件保留
      expect(db.prepare("SELECT COUNT(*) n FROM feedback_screenshots").get()).toEqual({ n: 3 });
      if (version >= 4) {
        expect(db.prepare("SELECT COUNT(*) n FROM feedback_logs").get()).toEqual({ n: 0 });
      }
      // 外键仍指向 feedbacks（重建表后引用不失效）
      const fk = db.prepare("PRAGMA foreign_key_list(feedback_screenshots)").all() as { table: string }[];
      expect(fk.some((f) => f.table === "feedbacks")).toBe(true);
      db.close();
    });
  }

  it("v4 → v6：含日志但缺少完整日志归档证据的 archived 记录仍按 v5 规则转待核对", () => {
    const specs: SeedSpec[] = [
      {
        id: "fb-mislabeled",
        status: "archived",
        taskId: "task-1",
        archiveStage: "complete",
        archiveData: JSON.stringify({
          version: 2,
          revision: 5,
          target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
          attachments: {},
        }),
        logs: [{ id: "log-1", filename: "app.log" }],
      },
    ];
    const { db } = runMigration(4, specs);
    expect(db.prepare("SELECT status FROM feedbacks WHERE id = 'fb-mislabeled'").get()).toEqual({
      status: "needs_review",
    });
    // 日志附件与任务链接保留
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_logs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT kaneo_task_id FROM feedbacks WHERE id = 'fb-mislabeled'").get()).toEqual({
      kaneo_task_id: "task-1",
    });
    db.close();
  });

  it("重启（再次 openDb）幂等：版本、行数与内容不变", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-restart-"));
    const raw = new DatabaseSync(path.join(dir, "feedback.db"));
    historicalSchema(raw, 3);
    seed(raw, 3, SPECS);
    raw.close();

    const first = openDb(dir);
    const digest = (db: DatabaseSync) =>
      JSON.stringify(db.prepare("SELECT id, status, archive_data_json FROM feedbacks ORDER BY id").all());
    const snapshot = digest(first);
    first.close();

    const second = openDb(dir);
    expect((second.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(digest(second)).toBe(snapshot);
    expect(second.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    second.close();
  });

  it("全新空库直接建为最新版本（不触发重建），状态约束接受新状态", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-mig-fresh-"));
    const db = openDb(dir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(db.prepare("SELECT COUNT(*) n FROM feedback_audit").get()).toEqual({ n: 0 });
    db.close();
  });
});

/**
 * 迁移 7（先接收、后配置、自动归档）接在 v6 之后运行。
 * 用同一批历史库验证：旧软件保持人工模式、旧允许来源迁为已确认来源，
 * 且历史反馈的来源无法确定 → 不参与任何自动补归档。
 */
describe("迁移 7：先接收后配置（历史库上）", () => {
  it("旧软件保持人工模式与已配置状态；旧允许来源迁为已确认来源", () => {
    const { db } = runMigration(3, SPECS);
    const app = db.prepare("SELECT * FROM apps WHERE id = 'app-1'").get() as Record<string, unknown>;
    expect(app.archive_mode).toBe("manual");
    expect(app.config_status).toBe("configured");
    expect(app.name_source).toBe("admin");
    expect(app.rule_version).toBe(0);
    expect(app.kaneo_label_ids).toBe("[]");
    expect(app.first_seen_at).toBeTruthy();

    const sources = db
      .prepare("SELECT origin, status, kind FROM app_sources WHERE app_row_id = 'app-1' ORDER BY origin")
      .all() as { origin: string; status: string; kind: string }[];
    expect(sources).toEqual([{ origin: "http://host.test", status: "confirmed", kind: "browser" }]);
    db.close();
  });

  it("历史反馈来源为空：不会成为自动归档候选（即使后来开启自动模式）", () => {
    const { db } = runMigration(3, SPECS);
    expect(db.prepare("SELECT COUNT(*) n FROM feedbacks WHERE source_origin <> ''").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM feedbacks WHERE auto_attempts <> 0").get()).toEqual({ n: 0 });

    // 模拟管理员后来配置：自动模式 + 完整规则 + 来源已确认
    db.prepare(
      "UPDATE apps SET archive_mode = 'automatic', kaneo_column_id = 'col-db-id', kaneo_label_ids = '[\"label-bug\"]' WHERE id = 'app-1'",
    ).run();
    db.prepare("UPDATE app_sources SET status = 'confirmed' WHERE app_row_id = 'app-1'").run();

    // 与 findAutoArchiveCandidates 相同的候选条件：来源为空的历史记录被排除
    const candidates = (
      db
        .prepare(
          "SELECT f.id AS id FROM feedbacks f JOIN apps a ON a.id = f.app_row_id JOIN app_sources s ON s.app_row_id = a.id AND s.origin = f.source_origin WHERE a.archive_mode = 'automatic' AND a.config_status = 'configured' AND s.status = 'confirmed' AND f.status = 'needs_info' AND f.archive_authorized_at IS NULL AND f.kaneo_task_id IS NULL AND f.source_origin <> ''",
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    expect(candidates).toHaveLength(0);
    db.close();
  });

  it("收集状态口径：未配置 / 待确认来源 / 人工已编辑 / 自动排队 / 已排队", () => {
    const pending = { config_status: "pending", archive_mode: "manual" };
    const auto = { config_status: "configured", archive_mode: "automatic" };
    const manual = { config_status: "configured", archive_mode: "manual" };
    const waiting = { status: "needs_info" as const, archive_authorized_at: null, kaneo_task_id: null };
    // T3 人工保护：管理员保存过分类（classify_version > 0）的记录不参与自动候选。
    const edited = { ...waiting, classify_version: 1 };
    // 配置类阻塞（规则不完整 / 目标失效）：等待配置而不是排队。
    const configBlocked = { ...waiting, auto_blocked_kind: "config" as const };
    const queued = {
      status: "ready_to_archive" as const,
      archive_authorized_at: "2026-01-01T00:00:00.000Z",
      kaneo_task_id: null,
    };

    expect(collectionStateFor(waiting, pending, null)).toBe("waiting_configuration");
    expect(collectionStateFor(waiting, auto, "pending")).toBe("waiting_source_confirmation");
    // 自动模式 + 来源已确认 + 未人工编辑：满足自动处理条件 → queued（整理中 / 等待自动重试）
    expect(collectionStateFor(waiting, auto, "confirmed")).toBe("queued");
    expect(collectionStateFor(configBlocked, auto, "confirmed")).toBe("waiting_configuration");
    expect(collectionStateFor(edited, auto, "confirmed")).toBe("waiting_manual_archive");
    expect(collectionStateFor(waiting, manual, null)).toBe("waiting_manual_archive");
    expect(collectionStateFor(queued, pending, null)).toBe("queued");
  });
});
