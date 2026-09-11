import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import {
  contentHash,
  getFeedback,
  getFeedbackScreenshot,
  insertApp,
  insertFeedbackWithScreenshot,
  listFeedbackLogs,
} from "../src/db/repos.ts";

/**
 * DB v3 增量迁移（docs/api.md L5）：
 * - feedback_logs 表 + 索引；新库直接建好；
 * - v2 旧库（含旧截图与 legacy/v1 archive_data_json）可升级，不重建 feedbacks；
 * - 重复启动幂等；迁移事务失败回滚且 user_version 不前进；
 * - 反馈 + 截图 + 日志同一事务，任一失败全部回滚。
 */

function newDir(): string {
  return mkdtempSync(path.join(tmpdir(), "fb-v3-"));
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** 手工构造 v2 旧库：只含老版本就存在的对象，绝不含 feedback_logs。 */
const V2_SCHEMA = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE sessions (
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
CREATE TABLE apps (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  allowed_origins   TEXT NOT NULL DEFAULT '[]',
  kaneo_project_id  TEXT NOT NULL DEFAULT '',
  kaneo_column_slug TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
CREATE TABLE feedbacks (
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
CREATE INDEX idx_feedbacks_status ON feedbacks(status);
CREATE INDEX idx_feedbacks_app ON feedbacks(app_row_id, created_at);
CREATE TABLE feedback_screenshots (
  feedback_id   TEXT PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
  png_blob      BLOB NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  capture_json  TEXT,
  created_at    TEXT NOT NULL
);
PRAGMA user_version = 2;
`;

/** 建一个带数据的 v2 旧库（旧截图 + legacy 仅 assetUrl + v1 归档存档数据）。 */
function makeV2Fixture(): { dir: string; legacyId: string; v1Id: string } {
  const dir = newDir();
  const db = new DatabaseSync(path.join(dir, "feedback.db"));
  db.exec(V2_SCHEMA);
  db.prepare(
    "INSERT INTO apps (id, app_id, name, allowed_origins, kaneo_project_id, kaneo_column_slug, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "app-1",
    "com.test.app",
    "测试软件",
    "[]",
    "proj-1",
    "triage",
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
  );
  const insert = db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, text, context_json, idempotency_key, content_hash, status, title,
       processed_json, kaneo_task_id, kaneo_task_url, archive_stage, archive_data_json, attempt_count, last_error,
       error_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'archived', NULL, NULL, 'task-1', 'http://kaneo.test/t/1', 'complete', ?, 0, NULL, NULL, ?, ?)`,
  );
  const now = "2025-02-01T00:00:00.000Z";
  insert.run(
    "fb-legacy",
    "app-1",
    "com.test.app",
    "旧记录 A",
    "key-legacy",
    "h1",
    JSON.stringify({ assetUrl: "http://kaneo.test/assets/old.png" }),
    now,
    now,
  );
  insert.run(
    "fb-v1",
    "app-1",
    "com.test.app",
    "旧记录 B",
    "key-v1",
    "h2",
    JSON.stringify({
      version: 1,
      revision: 2,
      target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
      upload: { key: "old-key", credentialsEnc: "v1:a:b:c", expiresAt: null, outcome: "confirmed", recoveries: 0 },
      asset: { id: "asset-1", url: "http://kaneo.test/assets/old-v1.png" },
      comment: { marker: "fb-v1|sha-old", id: "c-1", outcome: "confirmed" },
    }),
    now,
    now,
  );
  db.prepare(
    "INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, capture_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("fb-v1", new Uint8Array([1, 2, 3, 4]), 10, 8, 4, "sha-old", JSON.stringify({ viewportWidth: 800 }), now);
  db.close();
  return { dir, legacyId: "fb-legacy", v1Id: "fb-v1" };
}

describe("feedback_logs 表与 v3 迁移", () => {
  it("新库直接具备 feedback_logs（列与契约一致）且重复打开幂等", () => {
    const dir = newDir();
    const db1 = openDb(dir);
    expect(userVersion(db1)).toBe(3);
    expect(tableExists(db1, "feedback_logs")).toBe(true);
    expect(columnNames(db1, "feedback_logs")).toEqual([
      "id",
      "feedback_id",
      "seq",
      "filename",
      "source",
      "log_blob",
      "byte_size",
      "sha256",
      "created_at",
    ]);
    const feedbackCols = columnNames(db1, "feedbacks");
    expect(feedbackCols).toContain("archive_data_json");
    db1.close();

    // 重复启动幂等：再次打开不报错、版本不变、表与数据仍在
    const db2 = openDb(dir);
    expect(userVersion(db2)).toBe(3);
    expect(tableExists(db2, "feedback_logs")).toBe(true);
    expect(columnNames(db2, "feedbacks")).toEqual(feedbackCols);
    db2.close();
  });

  it("v2 旧库（旧截图 + legacy + v1 归档存档数据）升级到 v3，不重建 feedbacks", () => {
    const { dir, legacyId, v1Id } = makeV2Fixture();
    const db = openDb(dir);
    try {
      expect(userVersion(db)).toBe(3);
      expect(tableExists(db, "feedback_logs")).toBe(true);
      // 不重建：旧表中的行与列原样保留
      expect(getFeedback(db, legacyId)?.text).toBe("旧记录 A");
      expect(getFeedback(db, v1Id)?.archive_data_json).toContain('"version":1');
      const shot = getFeedbackScreenshot(db, v1Id);
      expect(shot?.sha256).toBe("sha-old");
      expect(shot?.byte_size).toBe(4);
      // 旧记录（无日志）在新表下查询为空
      expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_logs").get()).toEqual({ n: 0 });
      expect(columnNames(db, "feedbacks")).not.toContain("feedback_logs");
    } finally {
      db.close();
    }
  });

  it("migrate 自身即可为 v2 库建表并写 user_version（不依赖 SCHEMA 预建）", async () => {
    const { dir } = makeV2Fixture();
    const db = new DatabaseSync(path.join(dir, "feedback.db"));
    try {
      const { migrate } = (await import("../src/db/db.ts")) as unknown as {
        migrate?: (d: DatabaseSync) => void;
      };
      expect(typeof migrate).toBe("function");
      migrate!(db);
      expect(userVersion(db)).toBe(3);
      expect(tableExists(db, "feedback_logs")).toBe(true);
      // 再跑一次：幂等
      migrate!(db);
      expect(userVersion(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it("feedback_logs 的 DDL 在 SCHEMA 与 migrate 的 v<3 分支中逐字一致", async () => {
    const src = readFileSync(new URL("../src/db/db.ts", import.meta.url), "utf8");
    const blocks = src.split("CREATE TABLE IF NOT EXISTS feedback_logs (");
    // SCHEMA 一份 + FEEDBACK_LOGS_DDL 一份
    expect(blocks).toHaveLength(3);
    const normalize = (t: string) => t.slice(0, t.indexOf("`")).replace(/\s+$/u, "");
    expect(normalize(blocks[1]!)).toBe(normalize(blocks[2]!));
    // 索引 DDL 同样两处一致
    const indexes = src.split(
      "CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, seq);",
    );
    expect(indexes).toHaveLength(3);
  });

  it("删除反馈时 feedback_logs 级联删除（测试连接显式开启外键）", () => {
    const db = openDb(newDir());
    // 生产连接不开启 PRAGMA foreign_keys；级联行为在测试里显式开启后断言
    db.exec("PRAGMA foreign_keys = ON");
    const app = insertApp(db, {
      appId: "com.test.app",
      name: "测试软件",
      allowedOrigins: ["http://host.test"],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: "triage",
    });
    const row = insertFeedbackWithScreenshot(
      db,
      {
        appId: app.app_id,
        appRowId: app.id,
        text: "文字",
        contextJson: null,
        idempotencyKey: "k-cascade",
        contentHash: "h-cascade",
      },
      null,
      [
        { filename: "a.log", source: "auto", blob: new Uint8Array([0x61]), sha256: "a".repeat(64) },
        { filename: "b.log", source: "manual", blob: new Uint8Array([0x62]), sha256: "b".repeat(64) },
      ],
    );
    const id = row.id;
    expect(listFeedbackLogs(db, id)).toHaveLength(2);
    db.prepare("DELETE FROM feedbacks WHERE id = ?").run(id);
    expect(listFeedbackLogs(db, id)).toHaveLength(0);
    db.close();
  });

  it("迁移失败 → 回滚且 user_version 不前进", async () => {
    const dir = newDir();
    const db = new DatabaseSync(path.join(dir, "feedback.db"));
    try {
      db.exec("CREATE TABLE feedbacks (id TEXT PRIMARY KEY)");
      // 用一个同名表占位索引名，使 CREATE INDEX 必然失败（且发生在 CREATE TABLE 之后）
      db.exec("CREATE TABLE idx_feedback_logs_feedback (x TEXT)");
      db.exec("PRAGMA user_version = 2");
      const { migrate } = (await import("../src/db/db.ts")) as unknown as {
        migrate: (d: DatabaseSync) => void;
      };
      expect(() => migrate(db)).toThrow();
      expect(userVersion(db)).toBe(2);
      // 事务回滚：本次迁移创建的表不得残留
      expect(tableExists(db, "feedback_logs")).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("反馈 + 截图 + 日志同一事务", () => {
  function seedAppRow(db: ReturnType<typeof openDb>) {
    return insertApp(db, {
      appId: "com.test.app",
      name: "测试软件",
      allowedOrigins: ["http://host.test"],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: "triage",
    });
  }

  it("任一写入失败全部回滚：无 feedbacks、无 feedback_screenshots、无 feedback_logs 残留", () => {
    const db = openDb(newDir());
    const app = seedAppRow(db);
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO feedback_logs")) throw new Error("injected log write failure");
      return original(sql);
    };
    expect(() =>
      insertFeedbackWithScreenshot(
        db,
        {
          appId: app.app_id,
          appRowId: app.id,
          text: "带截图与日志",
          contextJson: null,
          idempotencyKey: "tx-key",
          contentHash: "hash",
        },
        {
          pngBlob: new Uint8Array([1, 2, 3]),
          width: 10,
          height: 10,
          byteSize: 3,
          sha256: "png-sha",
          captureJson: null,
        },
        [{ filename: "app.log", source: "auto", blob: new TextEncoder().encode("hello"), sha256: "log-sha" }],
      ),
    ).toThrow(/injected log write failure/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedbacks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_screenshots").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_logs").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("contentHash 幂等摘要兼容", () => {
  const appId = "com.test.app";
  const text = "导出 CSV 卡住了";
  const context = { appVersion: "1.2.3", pageLabel: "export" };

  function legacyHash(
    ctx: unknown,
    screenshot?: { sha256: string; releasePoint?: { x: number; y: number } } | null,
  ): string {
    const payload: Record<string, unknown> = { appId, text, context: ctx ?? null };
    if (screenshot) {
      payload.screenshotSha256 = screenshot.sha256;
      if (screenshot.releasePoint) payload.releasePoint = screenshot.releasePoint;
    }
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  it("无日志（缺省 / null / 空数组）输出与旧算法逐字节相同", () => {
    expect(contentHash(appId, text, context)).toBe(legacyHash(context));
    expect(contentHash(appId, text, context, null)).toBe(legacyHash(context));
    expect(contentHash(appId, text, context, null, null)).toBe(legacyHash(context));
    expect(contentHash(appId, text, context, null, [])).toBe(legacyHash(context));
    const shot = { sha256: "png-sha", releasePoint: { x: 0.25, y: 0.5 } };
    expect(contentHash(appId, text, context, shot)).toBe(legacyHash(context, shot));
    expect(contentHash(appId, text, context, shot, [])).toBe(legacyHash(context, shot));
  });

  it("有日志时 logs 键追加在最末，且文件名/来源不参与", () => {
    const logs = [
      { sha256: "a".repeat(64), byteSize: 10 },
      { sha256: "b".repeat(64), byteSize: 20 },
    ];
    const expected = createHash("sha256").update(JSON.stringify({ appId, text, context, logs })).digest("hex");
    expect(contentHash(appId, text, context, null, logs)).toBe(expected);
    // 顺序不同 → 不同摘要
    expect(contentHash(appId, text, context, null, [...logs].reverse())).not.toBe(expected);
  });
});
