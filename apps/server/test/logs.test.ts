import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db/db.ts";
import {
  contentHash,
  getFeedbackLog,
  insertApp,
  insertFeedbackWithScreenshot,
  listFeedbackLogs,
  updateFeedback,
} from "../src/db/repos.ts";
import { MAX_LOG_BYTES, sanitizeLogName, validateLogAttachments } from "../src/services/logs.ts";
import { jsonReq, makeHarness, makeProcessed, submitMultipartFeedback } from "./helpers.ts";

const LOG_TEXT = [
  "2026-01-01T00:00:00.000Z INFO  app started",
  "2026-01-01T00:00:01.000Z WARN  导出任务超时 retry=1",
  "2026-01-01T00:00:02.000Z ERROR export failed: timeout after 30000ms",
  "",
].join("\n");

function okLogs(over: Record<string, unknown> = {}) {
  return [{ name: "app.log", bytes: LOG_TEXT, ...over }];
}

describe("日志校验（validateLogAttachments）", () => {
  it("接受合法日志并计算 sha256 / 安全文件名 / 来源", () => {
    const r = validateLogAttachments(
      [{ filename: "app.log", bytes: Buffer.from(LOG_TEXT) }],
      [{ name: "app.log", source: "auto", byteSize: Buffer.byteLength(LOG_TEXT) }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]!.source).toBe("auto");
    expect(r.logs[0]!.name).toBe("app.log");
    expect(r.logs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.logs[0]!.byteSize).toBe(Buffer.byteLength(LOG_TEXT));
  });

  it("metadata 与部件数量不一致 → invalid_log", () => {
    const r = validateLogAttachments([{ filename: "app.log", bytes: Buffer.from("a") }], []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalid_log");
  });

  it("数量超限 → too_large；单文件超 1MiB → too_large", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      filename: `f${i}.log`,
      bytes: Buffer.from("x"),
    }));
    const meta4 = four.map((_, i) => ({ name: `f${i}.log`, source: "manual" as const }));
    const r1 = validateLogAttachments(four, meta4);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("too_large");

    const big = Buffer.alloc(MAX_LOG_BYTES + 1, 0x61);
    const r2 = validateLogAttachments([{ filename: "big.log", bytes: big }], [{ name: "big.log", source: "auto" }]);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe("too_large");
      expect(r2.error.message).toContain("1MiB");
    }
  });

  it("扩展名、空文件、二进制、非 UTF-8、byteSize 不符、文件名不符一律拒绝", () => {
    const cases: { parts: { filename: string | null; bytes: Buffer }[]; meta: unknown; code: string }[] = [
      {
        parts: [{ filename: "app.zip", bytes: Buffer.from("x") }],
        meta: [{ name: "app.zip", source: "auto" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.alloc(0) }],
        meta: [{ name: "app.log", source: "auto" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.from([0x61, 0x00, 0x62]) }],
        meta: [{ name: "app.log", source: "auto" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.from([0xff, 0xfe, 0xfd]) }],
        meta: [{ name: "app.log", source: "auto" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.from("abc") }],
        meta: [{ name: "app.log", source: "auto", byteSize: 99 }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "other.log", bytes: Buffer.from("abc") }],
        meta: [{ name: "app.log", source: "auto" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.from("abc") }],
        meta: [{ name: "app.log", source: "system" }],
        code: "invalid_log",
      },
      {
        parts: [{ filename: "app.log", bytes: Buffer.from("abc") }],
        meta: "not-an-array",
        code: "invalid_log",
      },
    ];
    for (const c of cases) {
      const r = validateLogAttachments(c.parts, c.meta);
      expect(r.ok, JSON.stringify(c.meta)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(c.code);
    }
  });

  it("安全化文件名：去路径、去控制字符，拒绝 . / ..", () => {
    expect(sanitizeLogName("../../etc/passwd.log")).toBe("passwd.log");
    expect(sanitizeLogName("C:\\logs\\app.LOG")).toBe("app.LOG");
    expect(sanitizeLogName('a"b.log')).toBe("ab.log");
    expect(sanitizeLogName("..")).toBeNull();
    expect(sanitizeLogName("   ")).toBeNull();
  });
});

describe("POST /api/feedback 日志附件", () => {
  it("提交日志并落库，响应 201，管理详情可见日志元数据", async () => {
    const h = await makeHarness();
    const r = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-1", appId: "com.test.app", text: "导出失败" },
      undefined,
      okLogs(),
    );
    expect(r.status).toBe(201);
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${r.data.feedbackId}`, {
      cookie: h.cookie,
    });
    expect(detail.status).toBe(200);
    expect(detail.data.logs).toHaveLength(1);
    expect(detail.data.logs[0]).toMatchObject({ name: "app.log", source: "auto", ordinal: 0 });
    expect(detail.data.logs[0].byteSize).toBe(Buffer.byteLength(LOG_TEXT));
    expect(detail.data.logs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.data.logs[0].content).toBeUndefined();
  });

  it("列表带 logCount；同键同内容重放不重复创建，换日志 → 409", async () => {
    const h = await makeHarness();
    const meta = { idempotencyKey: "log-key-2", appId: "com.test.app", text: "导出失败" };
    const first = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, undefined, okLogs());
    expect(first.status).toBe(201);

    const replay = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, undefined, okLogs());
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.feedbackId).toBe(first.data.feedbackId);

    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie });
    expect(list.data.items).toHaveLength(1);
    expect(list.data.items[0].logCount).toBe(1);

    const changed = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, undefined, [
      { name: "app.log", bytes: `${LOG_TEXT}extra line\n` },
    ]);
    expect(changed.status).toBe(409);
    expect(changed.data.error.code).toBe("idempotency_conflict");
  });

  it("日志顺序与 metadata.logs 顺序一致（含手动来源）", async () => {
    const h = await makeHarness();
    const r = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-3", appId: "com.test.app", text: "多份日志" },
      undefined,
      [
        { name: "host.log", bytes: "first\n", source: "auto" },
        { name: "network.jsonl", bytes: '{"t":1}\n', source: "manual" },
        { name: "trace.txt", bytes: "third\n", source: "manual" },
      ],
    );
    expect(r.status).toBe(201);
    const logs = listFeedbackLogs(h.feedbackApp.db, r.data.feedbackId);
    expect(logs.map((l) => [l.ordinal, l.name, l.source])).toEqual([
      [0, "host.log", "auto"],
      [1, "network.jsonl", "manual"],
      [2, "trace.txt", "manual"],
    ]);
    expect(Buffer.from(logs[1]!.content).toString("utf8")).toBe('{"t":1}\n');
  });

  it("非法日志不落库：整单 400/413 且不创建反馈", async () => {
    const h = await makeHarness();
    const bad = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-4", appId: "com.test.app", text: "坏日志" },
      undefined,
      [{ name: "app.zip", bytes: "x" }],
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("invalid_log");

    const tooBig = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-5", appId: "com.test.app", text: "超大日志" },
      undefined,
      [{ name: "big.log", bytes: Buffer.alloc(MAX_LOG_BYTES + 1, 0x61) }],
    );
    expect(tooBig.status).toBe(413);
    expect(tooBig.data.error.code).toBe("too_large");

    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie });
    expect(list.data.items).toHaveLength(0);
  });

  it("截图错误优先级不变（坏截图 + 坏日志仍是截图错误码）", async () => {
    const h = await makeHarness();
    const r = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-6", appId: "com.test.app", text: "坏截图" },
      Buffer.from("not-a-png"),
      [{ name: "app.zip", bytes: "x" }],
    );
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_format");
  });

  it("无日志的旧 JSON 请求幂等摘要与旧算法一致", () => {
    const legacy = contentHash("com.test.app", "文本", { pageLabel: "p" }, null);
    expect(contentHash("com.test.app", "文本", { pageLabel: "p" }, null, [])).toBe(legacy);
    expect(contentHash("com.test.app", "文本", { pageLabel: "p" }, null, null)).toBe(legacy);
    const logged = contentHash("com.test.app", "文本", { pageLabel: "p" }, null, [
      { name: "app.log", sha256: "a".repeat(64) },
    ]);
    expect(logged).not.toBe(legacy);
  });
});

describe("管理端日志读取 / 下载", () => {
  it("默认 inline 纯文本，?download=1 变 attachment，均 no-store + nosniff；越权 404", async () => {
    const h = await makeHarness();
    const r = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-7", appId: "com.test.app", text: "下载" },
      undefined,
      okLogs({ name: "主机 日志.log" }),
    );
    const id = r.data.feedbackId as string;
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
    const logId = detail.data.logs[0].id as string;

    const res = await h.feedbackApp.app.request(`http://localhost/api/admin/feedback/${id}/logs/${logId}`, {
      headers: { cookie: h.cookie, origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(await res.text()).toBe(LOG_TEXT);

    const dl = await h.feedbackApp.app.request(`http://localhost/api/admin/feedback/${id}/logs/${logId}?download=1`, {
      headers: { cookie: h.cookie, origin: "http://localhost" },
    });
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("content-disposition")).toContain("UTF-8''");

    const other = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}/logs/nope`, {
      cookie: h.cookie,
    });
    expect(other.status).toBe(404);

    const anon = await h.feedbackApp.app.request(`http://localhost/api/admin/feedback/${id}/logs/${logId}`, {
      headers: { origin: "http://localhost" },
    });
    expect(anon.status).toBe(401);
  });
});

describe("数据库迁移 v2 → v3", () => {
  it("带旧截图与恢复记录的库可升级，重复启动幂等且数据不变", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-migrate-"));
    const db = openDb(dir);
    const app = insertApp(db, {
      appId: "com.test.app",
      name: "测试",
      allowedOrigins: [],
      kaneoProjectId: "p",
      kaneoColumnSlug: "triage",
    });
    const archiveJson = JSON.stringify({
      version: 1,
      revision: 2,
      target: { apiBase: "http://kaneo.test/api", projectId: "p", workspaceId: "w" },
      asset: { id: "asset-1", url: "http://kaneo.test/a.png" },
      comment: { marker: "x|y", id: "c1", outcome: "confirmed" },
    });
    const row = insertFeedbackWithScreenshot(
      db,
      {
        appId: app.app_id,
        appRowId: app.id,
        text: "旧记录",
        contextJson: null,
        idempotencyKey: "old-key",
        contentHash: "hash",
      },
      {
        pngBlob: Buffer.from([1, 2, 3]),
        width: 10,
        height: 10,
        byteSize: 3,
        sha256: "0".repeat(64),
        captureJson: null,
      },
    );
    updateFeedback(db, row.id, {
      status: "needs_review",
      archive_stage: "asset_finalized",
      archive_data_json: archiveJson,
    });
    // 模拟升级前（v2）的库：无日志表，版本号 2
    db.exec("DROP TABLE feedback_logs; PRAGMA user_version = 2;");
    db.close();

    const upgraded = openDb(dir);
    const version = (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBe(3);
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain("feedback_logs");
    const kept = upgraded.prepare("SELECT status, archive_data_json FROM feedbacks WHERE id = ?").get(row.id) as {
      status: string;
      archive_data_json: string;
    };
    expect(kept.status).toBe("needs_review");
    expect(JSON.parse(kept.archive_data_json).asset.id).toBe("asset-1");
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM feedback_screenshots").get()).toMatchObject({ n: 1 });
    upgraded.close();

    // 重复启动：版本与数据不变
    const again = openDb(dir);
    expect((again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect(again.prepare("SELECT COUNT(*) AS n FROM feedbacks").get()).toMatchObject({ n: 1 });
    again.close();
  });

  it("真实启动迁移失败也回滚日志表，修复冲突后可以再次启动", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-startup-migrate-fail-"));
    const seed = openDb(dir);
    seed.exec("DROP TABLE feedback_logs; PRAGMA user_version = 2;");
    seed.exec("CREATE VIEW idx_feedback_logs_feedback AS SELECT 1 AS x");
    seed.close();

    expect(() => openDb(dir)).toThrow();
    const raw = new DatabaseSync(path.join(dir, "feedback.db"));
    expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_logs'").get(),
    ).toBeUndefined();
    raw.exec("DROP VIEW idx_feedback_logs_feedback");
    raw.close();

    const recovered = openDb(dir);
    expect(recovered.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    expect(recovered.prepare("SELECT COUNT(*) AS n FROM feedback_logs").get()).toMatchObject({ n: 0 });
    recovered.close();
  });

  it("迁移失败回滚：版本号不推进，新建的日志表不存在", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-migrate-fail-"));
    const db = new DatabaseSync(path.join(dir, "feedback.db"));
    // 同名索引被视图占用 → CREATE INDEX 失败，触发整段迁移回滚
    db.exec("CREATE VIEW idx_feedback_logs_feedback AS SELECT 1 AS x");
    db.exec("PRAGMA user_version = 2");
    expect(() => migrate(db)).toThrow();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    const logsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_logs'")
      .get();
    expect(logsTable).toBeUndefined();
    db.close();
  });
});

describe("日志写入事务性", () => {
  it("日志写入失败时反馈、截图与已插入日志整体回滚", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feedback-txn-"));
    const db = openDb(dir);
    const app = insertApp(db, {
      appId: "com.test.app",
      name: "测试",
      allowedOrigins: [],
      kaneoProjectId: "p",
      kaneoColumnSlug: "triage",
    });
    const base = {
      appId: app.app_id,
      appRowId: app.id,
      text: "事务",
      contextJson: null,
      idempotencyKey: "txn-key",
      contentHash: "hash",
    };
    const screenshot = {
      pngBlob: Buffer.from([1]),
      width: 1,
      height: 1,
      byteSize: 1,
      sha256: "1".repeat(64),
      captureJson: null,
    };
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

    // 第二条日志的 content 不是合法 SQLite 值 → 绑定失败（第一条已插入）→ 必须整体回滚
    expect(() =>
      insertFeedbackWithScreenshot(db, base, screenshot, [
        { name: "a.log", source: "auto", content: Buffer.from("x"), byteSize: 1, sha256: "2".repeat(64) },
        {
          name: "b.log",
          source: "auto",
          content: { bogus: true } as unknown as Uint8Array,
          byteSize: 1,
          sha256: "3".repeat(64),
        },
      ]),
    ).toThrow();

    expect(count("SELECT COUNT(*) AS n FROM feedbacks")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM feedback_screenshots")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM feedback_logs")).toBe(0);

    // 回滚后同一幂等键仍可用（未被半截数据占用），且这次能完整落库
    const ok = insertFeedbackWithScreenshot(db, base, screenshot, [
      { name: "a.log", source: "auto", content: Buffer.from("x"), byteSize: 1, sha256: "2".repeat(64) },
    ]);
    expect(count("SELECT COUNT(*) AS n FROM feedbacks")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM feedback_logs")).toBe(1);
    expect(getFeedbackLog(db, ok.id, listFeedbackLogs(db, ok.id)[0]!.id)).not.toBeNull();
    db.close();
  });
});

describe("AI 整理结果（旧行为）不受日志改动影响", () => {
  it("mock AI 输出仍写入 processed_json", async () => {
    const h = await makeHarness();
    const r = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { idempotencyKey: "log-key-8", appId: "com.test.app", text: "AI" },
      undefined,
      okLogs(),
    );
    await h.feedbackApp.worker.idle();
    const row = h.feedbackApp.db
      .prepare("SELECT processed_json FROM feedbacks WHERE id = ?")
      .get(r.data.feedbackId) as {
      processed_json: string;
    };
    expect(JSON.parse(row.processed_json).title).toBe(makeProcessed().title);
  });
});
