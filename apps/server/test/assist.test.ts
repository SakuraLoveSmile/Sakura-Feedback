import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { bindAssistRuntime, enqueueAssistEventInTx, enqueueFeedbackCreatedInTx } from "../src/assist/outbox.ts";
import { createAssistWorker } from "../src/assist/worker.ts";
import { type Db, openDb } from "../src/db/db.ts";
import { applyLifecycleInTx, contentHash, createUser, submitFeedbackAtomic, updateFeedback } from "../src/db/repos.ts";
import { instantSleep, jsonReq, makeConfig, makeMockAi, makeMockKaneo, makeTestApp } from "./helpers.ts";

/**
 * Assist 接入（contracts/feedback-integration.md）测试：
 * 迁移、同事务原子性、事件构造、投递循环、只读路由、接入关闭零变化。
 * 不调用 AI / Kaneo 真实功能（全部 mock），不写任何「测试反馈」到远端。
 */

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "feedback-assist-"));
}

interface OutboxRow {
  id: string;
  seq: number;
  kind: string;
  payload_json: string;
  state: string;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
}

function outboxRows(db: Db): OutboxRow[] {
  return db.prepare("SELECT * FROM assist_outbox ORDER BY seq ASC").all() as unknown as OutboxRow[];
}

function outboxPayloads(db: Db, kind?: string): any[] {
  return outboxRows(db)
    .filter((r) => kind === undefined || r.kind === kind)
    .map((r) => JSON.parse(r.payload_json));
}

/** 建一个账号 + 一条带截图/日志的反馈（最小落库路径，不经 HTTP）。 */
function seedFeedback(
  db: Db,
  over: { text?: string; screenshot?: boolean; logs?: { filename: string; bytes: Uint8Array }[] } = {},
) {
  const user = createUser(db, `u-${Math.random().toString(36).slice(2)}`, "hash", { dailyLimit: 50 });
  const text = over.text ?? "导出 CSV 卡住了，希望支持后台导出";
  const logs = (over.logs ?? []).map((l) => {
    const bytes = l.bytes;
    return {
      filename: l.filename,
      source: "auto" as const,
      bytes,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const screenshot = over.screenshot
    ? {
        pngBlob: png,
        width: 10,
        height: 10,
        byteSize: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
        captureJson: null,
      }
    : null;
  const outcome = submitFeedbackAtomic(
    db,
    {
      userId: user.id,
      appId: "com.test.app",
      sourceOrigin: "http://host.test",
      sourceKind: "browser",
      text,
      contextJson: null,
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      contentHash: contentHash("com.test.app", text, null, screenshot ? { sha256: screenshot.sha256 } : null, logs),
    },
    screenshot,
    logs,
  );
  if (outcome.kind !== "created") throw new Error(`反馈落库失败: ${outcome.kind}`);
  return outcome.row;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 全部事件都 accepted 的 mock 中枢。 */
function acceptAllHub(calls: { url: string; body: any }[] = []): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify({
        accepted: (body.events ?? []).map((e: { eventId: string }) => e.eventId),
        duplicates: [],
        rejected: [],
        lastSeq: 0,
        serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("迁移 v10：assist_outbox 表结构", () => {
  it("全新库创建 assist_outbox / assist_outbox_seq / 索引，user_version=10", () => {
    const db = openDb(tmpDir());
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'assist_%'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name).sort()).toEqual(["assist_outbox", "assist_outbox_seq"]);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assist_outbox_pending'")
      .get();
    expect(idx).toBeTruthy();
    // state CHECK 含 dead；非法值被拒绝
    db.prepare("INSERT INTO assist_outbox_seq (id, value) VALUES (1, 0)").run();
    db.prepare(
      "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at) VALUES ('x1', 1, 'k', '{}', 'dead', '2026-01-01T00:00:00Z')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at) VALUES ('x2', 2, 'k', '{}', 'bogus', '2026-01-01T00:00:00Z')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("同事务 outbox 写入", () => {
  it("反馈首次落库 → feedback_created 与业务行同事务提交", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const row = seedFeedback(db);
    const events = outboxPayloads(db, "feedback_created");
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("info");
    expect(events[0].incidentAction).toBeNull();
    expect(events[0].faultKey).toBeNull();
    expect(events[0].ref).toEqual({ feedbackId: row.id });
    expect(events[0].title).toContain("新反馈：");
    expect(events[0].body).toBe(row.text);
    expect(events[0].seq).toBe(1);
    db.close();
  });

  it("幂等重放不产生第二条事件；seq 单调递增", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const user = createUser(db, "u1", "hash", { dailyLimit: 50 });
    const input = {
      userId: user.id,
      appId: "com.test.app",
      sourceOrigin: "http://host.test",
      sourceKind: "browser" as const,
      text: "重复提交测试",
      contextJson: null,
      idempotencyKey: "same-key",
      contentHash: contentHash("com.test.app", "重复提交测试", null),
    };
    const first = submitFeedbackAtomic(db, input, null, []);
    expect(first.kind).toBe("created");
    const replay = submitFeedbackAtomic(db, input, null, []);
    expect(replay.kind).toBe("replayed");
    const rows = outboxRows(db);
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("业务事务回滚 → outbox 行一并回滚", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    db.exec("BEGIN");
    enqueueFeedbackCreatedInTx(db, {
      id: "fb-1",
      appId: "com.test.app",
      text: "将被回滚",
      occurredAt: new Date().toISOString(),
      screenshot: null,
      logs: [],
    });
    expect(outboxRows(db)).toHaveLength(1); // 事务内可见
    db.exec("ROLLBACK");
    expect(outboxRows(db)).toHaveLength(0); // 回滚后无残留
    db.close();
  });

  it("未绑定运行时（接入关闭）→ 所有写入点 no-op", () => {
    const db = openDb(tmpDir());
    const row = seedFeedback(db); // 不 bind
    updateFeedback(db, row.id, { status: "failed", error_summary: "x" });
    expect(outboxRows(db)).toHaveLength(0);
    db.close();
  });
});

describe("事件构造", () => {
  it("feedback_created 附件描述符：截图 + 日志元数据齐全", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const row = seedFeedback(db, {
      screenshot: true,
      logs: [
        { filename: "app.log", bytes: Buffer.from("log-a") },
        { filename: "extra.json", bytes: Buffer.from("{}") },
      ],
    });
    const ev = outboxPayloads(db, "feedback_created")[0];
    const shot = db.prepare("SELECT sha256, byte_size FROM feedback_screenshots WHERE feedback_id = ?").get(row.id) as {
      sha256: string;
      byte_size: number;
    };
    const logs = db
      .prepare("SELECT id, filename, byte_size, sha256 FROM feedback_logs WHERE feedback_id = ? ORDER BY sort_order")
      .all(row.id) as { id: string; filename: string; byte_size: number; sha256: string }[];
    expect(ev.attachments).toHaveLength(3);
    expect(ev.attachments[0]).toEqual({
      id: "screenshot",
      kind: "screenshot",
      filename: "screenshot.png",
      mime: "image/png",
      byteSize: shot.byte_size,
      sha256: shot.sha256,
    });
    expect(ev.attachments[1]).toMatchObject({
      id: `logs/${logs[0]!.id}`,
      kind: "log",
      filename: "app.log",
      mime: "text/plain",
      byteSize: logs[0]!.byte_size,
      sha256: logs[0]!.sha256,
    });
    expect(ev.attachments[2].mime).toBe("application/json");
    db.close();
  });

  it("feedback_created 标题取首行、正文超 20000 截断", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const long = `首行标题\n${"x".repeat(30000)}`;
    const row = seedFeedback(db, { text: long });
    const ev = outboxPayloads(db, "feedback_created")[0];
    expect(ev.title).toBe("新反馈：首行标题");
    expect(ev.body.length).toBe(20000);
    expect(ev.ref.feedbackId).toBe(row.id);
    db.close();
  });

  it("状态迁移：failed → open；继续恶化 → update；恢复 → resolve", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const row = seedFeedback(db);
    // 首次进入 failed → feedback_fault / open
    updateFeedback(db, row.id, { status: "failed", error_summary: "Kaneo 连接中断", last_error: "ECONNRESET" });
    let faults = outboxPayloads(db, "feedback_fault");
    expect(faults).toHaveLength(1);
    expect(faults[0].incidentAction).toBe("open");
    expect(faults[0].faultKey).toBe(`feedback:${row.id}`);
    expect(faults[0].severity).toBe("warning");
    expect(faults[0].body).toContain("Kaneo 连接中断");
    expect(faults[0].body).toContain("ECONNRESET");
    // 故障期间仅错误字段恶化 → update
    updateFeedback(db, row.id, { error_summary: "再次失败" });
    faults = outboxPayloads(db, "feedback_fault");
    expect(faults).toHaveLength(2);
    expect(faults[1].incidentAction).toBe("update");
    // failed → needs_review 仍属故障 → update
    updateFeedback(db, row.id, { status: "needs_review", error_summary: "待核对" });
    faults = outboxPayloads(db, "feedback_fault");
    expect(faults).toHaveLength(3);
    expect(faults[2].incidentAction).toBe("update");
    // 恢复到正常路径 → feedback_recovered / resolve
    updateFeedback(db, row.id, { status: "processing", error_summary: null });
    const recovered = outboxPayloads(db, "feedback_recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].incidentAction).toBe("resolve");
    expect(recovered[0].faultKey).toBe(`feedback:${row.id}`);
    expect(recovered[0].severity).toBe("info");
    db.close();
  });

  it("非故障状态间迁移不产生事件；needs_info 不算故障", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const row = seedFeedback(db);
    updateFeedback(db, row.id, { status: "processing" });
    updateFeedback(db, row.id, { status: "needs_info" });
    updateFeedback(db, row.id, { status: "ready_to_archive" });
    updateFeedback(db, row.id, { status: "archived" });
    expect(outboxPayloads(db, "feedback_fault")).toHaveLength(0);
    expect(outboxPayloads(db, "feedback_recovered")).toHaveLength(0);
    db.close();
  });

  it("错误态直接归档成功 → resolve（archived 属恢复路径）", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    const row = seedFeedback(db);
    updateFeedback(db, row.id, { status: "needs_review", error_summary: "待核对" });
    updateFeedback(db, row.id, { status: "archived", archive_stage: "complete", error_summary: null });
    const recovered = outboxPayloads(db, "feedback_recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].incidentAction).toBe("resolve");
    db.close();
  });

  it("溢出：pending 超上限丢弃最旧并补 queue_overflow 汇总事件", () => {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 3 });
    for (let i = 0; i < 6; i++) {
      enqueueAssistEventInTx(db, {
        kind: "feedback_created",
        severity: "info",
        faultKey: null,
        incidentAction: null,
        title: `ev-${i}`,
        body: null,
        ref: null,
        attachments: null,
        occurredAt: new Date().toISOString(),
      });
    }
    const rows = outboxRows(db);
    const pending = rows.filter((r) => r.state === "pending");
    // 丢弃最旧业务事件（ev-0..ev-3 被挤出），overflow 汇总事件保留
    expect(pending.filter((r) => r.kind === "queue_overflow").length).toBeGreaterThan(0);
    const titles = pending.map((r) => (JSON.parse(r.payload_json) as { title: string }).title);
    expect(titles).not.toContain("ev-0");
    expect(titles).not.toContain("ev-1");
    expect(titles).toContain("ev-5");
    expect(pending.length).toBeLessThanOrEqual(4); // queueMax + overflow 标记
    const overflow = outboxPayloads(db, "queue_overflow")[0];
    expect(overflow.severity).toBe("warning");
    expect(overflow.body).toContain("丢弃");
    db.close();
  });
});

describe("投递 worker", () => {
  function setupDb(): Db {
    const db = openDb(tmpDir());
    bindAssistRuntime(db, { queueMax: 100 });
    return db;
  }

  function addEvent(db: Db, title = "ev"): string {
    enqueueAssistEventInTx(db, {
      kind: "feedback_created",
      severity: "info",
      faultKey: null,
      incidentAction: null,
      title,
      body: null,
      ref: null,
      attachments: null,
      occurredAt: new Date().toISOString(),
    });
    const row = db.prepare("SELECT id FROM assist_outbox ORDER BY seq DESC LIMIT 1").get() as { id: string };
    return row.id;
  }

  it("accepted → sent（含 sent_at）；duplicates 同样送达", async () => {
    const db = setupDb();
    const a = addEvent(db, "a");
    const b = addEvent(db, "b");
    const calls: { url: string; body: any }[] = [];
    // 同批内一条 accepted、一条 duplicates：两种都算送达。
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), body });
      const ids = (body.events as { eventId: string }[]).map((e) => e.eventId);
      return new Response(JSON.stringify({ accepted: ids.slice(0, 1), duplicates: ids.slice(1), rejected: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const worker = createAssistWorker({ db, hubUrl: "http://hub.test", sourceKey: "ask_x", flushMs: 5, fetchImpl });
    await waitFor(() => outboxRows(db).every((r) => r.state === "sent"));
    worker.stop();
    await worker.idle();
    const rows = outboxRows(db);
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);
    expect(calls[0]!.url).toBe("http://hub.test/api/v1/ingest/events");
    db.close();
  });

  it("网络错误 / 5xx / 403 → pending + 持久化退避（attempts+1、next_attempt_at）", async () => {
    for (const respond of ["throw", 500, 403] as const) {
      const db = setupDb();
      const nowMs = Date.UTC(2026, 0, 1);
      addEvent(db);
      const fetchImpl = (async () => {
        if (respond === "throw") throw new Error("connect refused");
        return new Response("x", { status: respond });
      }) as unknown as typeof fetch;
      const worker = createAssistWorker({
        db,
        hubUrl: "http://hub.test",
        sourceKey: "k",
        flushMs: 5,
        fetchImpl,
        now: () => nowMs,
      });
      await waitFor(() => Number(outboxRows(db)[0]!.attempts) >= 1);
      worker.stop();
      await worker.idle();
      const row = outboxRows(db)[0]!;
      expect(row.state).toBe("pending");
      expect(Number(row.attempts)).toBe(1);
      // 退避阶梯第一档 1s
      expect(new Date(row.next_attempt_at!).getTime()).toBe(nowMs + 1000);
      db.close();
    }
  });

  it("rejected 单条退避重试，不影响同批其他事件；达到 deadAfter 标 dead", async () => {
    const db = setupDb();
    let nowMs = Date.UTC(2026, 0, 1);
    const good = addEvent(db, "good");
    const bad = addEvent(db, "bad");
    const fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const ids = (body.events as { eventId: string }[]).map((e) => e.eventId);
      return new Response(
        JSON.stringify({
          accepted: ids.filter((i) => i === good),
          duplicates: [],
          rejected: ids.filter((i) => i !== good).map((i) => ({ eventId: i, code: "invalid_request", message: "bad" })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const worker = createAssistWorker({
      db,
      hubUrl: "http://hub.test",
      sourceKey: "k",
      flushMs: 5,
      fetchImpl,
      now: () => nowMs,
      deadAfterAttempts: 2,
    });
    await waitFor(() => outboxRows(db).find((r) => r.id === good)?.state === "sent");
    // 第一次 rejected：pending + attempts=1
    await waitFor(() => Number(outboxRows(db).find((r) => r.id === bad)!.attempts) >= 1);
    nowMs += 60_000; // 越过退避 → 再次投递仍被拒 → 达到 deadAfter=2 → dead
    await waitFor(() => outboxRows(db).find((r) => r.id === bad)?.state === "dead");
    worker.stop();
    await worker.idle();
    const bad2 = outboxRows(db).find((r) => r.id === bad)!;
    expect(bad2.state).toBe("dead");
    expect(bad2.next_attempt_at).toBeNull();
    db.close();
  });

  it("401 → 停发并周期探测；密钥恢复后继续投递", async () => {
    const db = setupDb();
    let nowMs = Date.UTC(2026, 0, 1);
    addEvent(db);
    const calls: number[] = [];
    let accept = false;
    const fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => {
      calls.push(nowMs);
      if (!accept) return new Response("{}", { status: 401 });
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          accepted: (body.events as { eventId: string }[]).map((e) => e.eventId),
          duplicates: [],
          rejected: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const worker = createAssistWorker({
      db,
      hubUrl: "http://hub.test",
      sourceKey: "k",
      flushMs: 5,
      fetchImpl,
      now: () => nowMs,
      authPauseMs: 100,
    });
    await waitFor(() => calls.length === 1);
    // 停发窗口内不再发起请求（真实等待 < authPauseMs 期间应无新调用）
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(1);
    // 探测时间到：推进时钟 + 放行 → 恢复投递
    accept = true;
    nowMs += 200;
    await waitFor(() => outboxRows(db)[0]!.state === "sent");
    worker.stop();
    await worker.idle();
    db.close();
  });

  it("终态清理：启动即删超期 sent/dead 行，pending 不动", async () => {
    const db = setupDb();
    const old = "2020-01-01T00:00:00.000Z";
    db.prepare("INSERT INTO assist_outbox_seq (id, value) VALUES (1, 0)").run();
    db.prepare(
      "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at, sent_at) VALUES ('old-sent', 1, 'k', '{}', 'sent', ?, ?)",
    ).run(old, old);
    db.prepare(
      "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at) VALUES ('old-dead', 2, 'k', '{}', 'dead', ?)",
    ).run(old);
    addEvent(db, "keep");
    db.prepare("UPDATE assist_outbox SET next_attempt_at = ? WHERE state = 'pending'").run("2999-01-01T00:00:00.000Z");
    const worker = createAssistWorker({
      db,
      hubUrl: "http://hub.test",
      sourceKey: "k",
      flushMs: 20,
      fetchImpl: acceptAllHub(),
    });
    await waitFor(
      () =>
        (db.prepare("SELECT COUNT(*) n FROM assist_outbox WHERE state != 'pending'").get() as { n: number }).n === 0,
    );
    expect((db.prepare("SELECT COUNT(*) n FROM assist_outbox").get() as { n: number }).n).toBe(1);
    worker.stop();
    await worker.idle();
    db.close();
  });

  it("请求整体超时（含响应体读取）→ pending 持久化退避", async () => {
    const db = setupDb();
    addEvent(db, "timeout");
    const fetchImpl = (async () =>
      ({
        status: 200,
        ok: true,
        json: () => new Promise<unknown>(() => undefined),
      }) as Response) as typeof fetch;
    const worker = createAssistWorker({
      db,
      hubUrl: "http://hub.test",
      sourceKey: "k",
      flushMs: 5,
      requestTimeoutMs: 15,
      fetchImpl,
    });
    await waitFor(() => Number(outboxRows(db)[0]!.attempts) >= 1);
    expect(outboxRows(db)[0]!.state).toBe("pending");
    worker.stop();
    await worker.idle();
    db.close();
  });

  it("stop() 取消响应体读取并及时退出，不虚增 attempts", async () => {
    const db = setupDb();
    addEvent(db, "stop");
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return {
        status: 200,
        ok: true,
        json: () => new Promise<unknown>(() => undefined),
      } as Response;
    }) as typeof fetch;
    const worker = createAssistWorker({
      db,
      hubUrl: "http://hub.test",
      sourceKey: "k",
      flushMs: 5,
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);
    worker.stop();
    await worker.idle();
    expect(Number(outboxRows(db)[0]!.attempts)).toBe(0);
    expect(outboxRows(db)[0]!.state).toBe("pending");
    db.close();
  });

  it("非 2xx 慢响应在 stop() 时 abort，不等待响应体", async () => {
    const db = setupDb();
    addEvent(db, "slow-error");
    let calls = 0;
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      signal = init?.signal as AbortSignal;
      return { status: 500, ok: false, json: () => new Promise<unknown>(() => undefined) } as Response;
    }) as typeof fetch;
    const worker = createAssistWorker({ db, hubUrl: "http://hub.test", sourceKey: "k", flushMs: 5, fetchImpl });
    await waitFor(() => calls === 1);
    worker.stop();
    await worker.idle();
    expect(signal?.aborted).toBe(true);
    expect(Number(outboxRows(db)[0]!.attempts)).toBe(1);
    db.close();
  });
});

describe("只读回连路由", () => {
  function makeAssistApp(over: { assistReadKey?: string | null; assistSourceKey?: string | null } = {}) {
    const calls: { url: string; body: any }[] = [];
    const config = {
      ...makeConfig(),
      assistHubUrl: "http://hub.test",
      assistSourceKey: "ask_src",
      assistReadKey: "ask_read",
      assistFlushMs: 5,
      ...over,
    };
    const feedbackApp = createApp(config, {
      ai: makeMockAi(),
      kaneo: makeMockKaneo(),
      workerSleep: instantSleep,
      assistFetch: acceptAllHub(calls),
    });
    return { feedbackApp, config, calls };
  }

  it("无密钥/错误密钥 → 统一 401；正确密钥 → 200 详情结构", async () => {
    const { feedbackApp } = makeAssistApp();
    const row = seedFeedback(feedbackApp.db, {
      screenshot: true,
      logs: [{ filename: "a.log", bytes: Buffer.from("x") }],
    });
    const base = `/api/assist/feedback/${row.id}`;
    expect((await jsonReq(feedbackApp.app, "GET", base)).status).toBe(401);
    expect((await jsonReq(feedbackApp.app, "GET", base, { bearer: "wrong" })).status).toBe(401);
    const ok = await jsonReq(feedbackApp.app, "GET", base, { bearer: "ask_read" });
    expect(ok.status).toBe(200);
    expect(ok.data.id).toBe(row.id);
    expect(ok.data.appId).toBe("com.test.app");
    expect(ok.data.status).toBe(row.status);
    expect(ok.data.text).toBe(row.text);
    expect(ok.data.hasScreenshot).toBe(true);
    expect(ok.data.logs).toHaveLength(1);
    expect(ok.data.logs[0].filename).toBe("a.log");
    expect(ok.data.logs[0].source).toBe("auto");
    feedbackApp.close();
  });

  it("SOURCE_KEY 可作 READ_KEY 回退", async () => {
    const { feedbackApp } = makeAssistApp({ assistReadKey: null });
    const row = seedFeedback(feedbackApp.db);
    const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: "ask_src" });
    expect(r.status).toBe(200);
    feedbackApp.close();
  });

  it("截图：image/png + Content-Length + ETag；无截图 404", async () => {
    const { feedbackApp } = makeAssistApp();
    const withShot = seedFeedback(feedbackApp.db, { screenshot: true });
    const without = seedFeedback(feedbackApp.db);
    const r = await feedbackApp.app.request(`/api/assist/feedback/${withShot.id}/attachments/screenshot`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    const shot = feedbackApp.db
      .prepare("SELECT sha256, byte_size FROM feedback_screenshots WHERE feedback_id = ?")
      .get(withShot.id) as { sha256: string; byte_size: number };
    expect(r.headers.get("etag")).toBe(`"${shot.sha256}"`);
    expect(Number(r.headers.get("content-length"))).toBe(shot.byte_size);
    const missing = await feedbackApp.app.request(`/api/assist/feedback/${without.id}/attachments/screenshot`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(missing.status).toBe(404);
    feedbackApp.close();
  });

  it("日志：octet-stream + Content-Disposition；他人/缺失 404", async () => {
    const { feedbackApp } = makeAssistApp();
    const row = seedFeedback(feedbackApp.db, { logs: [{ filename: "app.log", bytes: Buffer.from("body") }] });
    const other = seedFeedback(feedbackApp.db);
    const logMeta = feedbackApp.db
      .prepare("SELECT id, byte_size FROM feedback_logs WHERE feedback_id = ?")
      .get(row.id) as { id: string; byte_size: number };
    const r = await feedbackApp.app.request(`/api/assist/feedback/${row.id}/attachments/logs/${logMeta.id}`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-disposition")).toContain("app.log");
    // 不属于该反馈的 logId → 404
    const wrong = await feedbackApp.app.request(`/api/assist/feedback/${other.id}/attachments/logs/${logMeta.id}`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(wrong.status).toBe(404);
    const missing = await feedbackApp.app.request(`/api/assist/feedback/${row.id}/attachments/logs/no-such`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(missing.status).toBe(404);
    feedbackApp.close();
  });

  it("彻底删除（purge）后统一 404", async () => {
    const { feedbackApp } = makeAssistApp();
    const row = seedFeedback(feedbackApp.db);
    const payload = JSON.stringify({ eventId: "fb_old", ref: { feedbackId: row.id }, body: row.text });
    feedbackApp.db
      .prepare(
        "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at, sent_at) VALUES (?, ?, 'feedback_created', ?, ?, ?, ?)",
      )
      .run("purge-pending", 10001, payload, "pending", new Date().toISOString(), null);
    feedbackApp.db
      .prepare(
        "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at, sent_at) VALUES (?, ?, 'feedback_created', ?, ?, ?, ?)",
      )
      .run("purge-sent", 10002, payload, "sent", new Date().toISOString(), new Date().toISOString());
    feedbackApp.db
      .prepare(
        "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at, sent_at) VALUES (?, ?, 'feedback_created', ?, ?, ?, ?)",
      )
      .run("purge-dead", 10003, payload, "dead", new Date().toISOString(), null);
    feedbackApp.db
      .prepare(
        "INSERT INTO assist_outbox (id, seq, kind, payload_json, state, created_at, sent_at) VALUES (?, ?, 'feedback_created', ?, ?, ?, ?)",
      )
      .run("purge-corrupt", 10004, "{not-json", "pending", new Date().toISOString(), null);
    const actor = { id: "admin", username: "admin" };
    expect(applyLifecycleInTx(feedbackApp.db, row.id, { action: "trash", expectedVersion: 0, actor }).kind).toBe("ok");
    expect(applyLifecycleInTx(feedbackApp.db, row.id, { action: "purge", expectedVersion: 1, actor }).kind).toBe(
      "purged",
    );
    expect(
      feedbackApp.db
        .prepare(
          "SELECT COUNT(*) AS n FROM assist_outbox WHERE json_valid(payload_json) AND json_extract(payload_json, '$.ref.feedbackId') = ?",
        )
        .get(row.id),
    ).toEqual({ n: 0 });
    const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: "ask_read" });
    expect(r.status).toBe(404);
    const s = await feedbackApp.app.request(`/api/assist/feedback/${row.id}/attachments/screenshot`, {
      headers: { authorization: "Bearer ask_read" },
    });
    expect(s.status).toBe(404);
    feedbackApp.close();
  });

  it("限流：60 次/分后 → 429", async () => {
    const { feedbackApp } = makeAssistApp();
    const row = seedFeedback(feedbackApp.db);
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: "ask_read" });
      last = r.status;
    }
    expect(last).toBe(429);
    feedbackApp.close();
  });
});

describe("接入关闭（未配置 FEEDBACK_ASSIST_HUB_URL）零行为变化", () => {
  it("不建 worker、不挂路由、不写 outbox", async () => {
    const feedbackApp = makeTestApp(); // 无 assist 配置
    expect(feedbackApp.assist).toBeNull();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, { status: "failed", error_summary: "x" });
    expect(feedbackApp.db.prepare("SELECT COUNT(*) n FROM assist_outbox").get()).toEqual({ n: 0 });
    const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: "any" });
    expect(r.status).toBe(404); // 路由组未挂载 → 统一 404
    feedbackApp.close();
  });
});
