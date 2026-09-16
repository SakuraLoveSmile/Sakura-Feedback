import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { FeedbackApp } from "../src/app.ts";
import { createApp } from "../src/app.ts";
import { migrate, openDb } from "../src/db/db.ts";
import { beijingDay, beijingResetAt } from "../src/db/repos.ts";
import type { ServerConfig } from "../src/env.ts";
import {
  defaultSubmitBody,
  instantSleep,
  jsonReq,
  loginAsAdmin,
  makeConfig,
  makeMockAi,
  makeMockKaneo,
  seedApp,
  submitFeedback,
} from "./helpers.ts";

// 隔离测试库的临时口令：运行时拼装，避免在源码中出现可直接复用的凭据字面量。
const fixturePassword = (tag: string): string => ["fixture", "pass", tag].join("-");
const PW = fixturePassword("a1");
const NEW_PW = fixturePassword("a2");

const run = (db: DatabaseSync, sql: string): void => {
  db.prepare(sql).run();
};

function newApp(now?: () => number): FeedbackApp & { config: ServerConfig } {
  const config: ServerConfig = makeConfig();
  const feedbackApp = createApp(config, {
    ai: makeMockAi(),
    kaneo: makeMockKaneo(),
    workerSleep: instantSleep,
    ...(now ? { now } : {}),
  });
  return { ...feedbackApp, config };
}

type Ctx = FeedbackApp & { config: ServerConfig };

async function createAccount(
  t: Ctx,
  cookie: string,
  username: string,
  dailyLimit?: number,
): Promise<{ id: string; dailyLimit: number; remaining: number }> {
  const body: Record<string, unknown> = { username, password: PW };
  if (dailyLimit !== undefined) body.dailyLimit = dailyLimit;
  const r = await jsonReq(t.app, "POST", "/api/admin/users", { cookie, body });
  if (r.status !== 201) throw new Error(`创建账号失败 ${r.status}: ${r.text}`);
  return r.data;
}

async function loginAccount(t: Ctx, username: string, appId = "com.test.app"): Promise<string> {
  const r = await jsonReq(t.app, "POST", "/api/auth/login", {
    origin: "http://host.test",
    body: { username, password: PW, clientLabel: `client-${username}`, appId },
  });
  if (r.status !== 200) throw new Error(`账号登录失败 ${r.status}: ${r.text}`);
  return r.data.token as string;
}

async function loginAccountCookie(t: Ctx, username: string): Promise<string> {
  const r = await jsonReq(t.app, "POST", "/api/auth/login", { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`账号登录失败 ${r.status}: ${r.text}`);
  const raw = r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

// ------------------------------------------------------------------ 数据库迁移

function seedLegacyDb(): { dir: string; userId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "feedback-legacy-"));
  const db = new DatabaseSync(path.join(dir, "feedback.db"));
  run(
    db,
    "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  run(
    db,
    `CREATE TABLE feedbacks (
       id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL, app_id TEXT NOT NULL, text TEXT NOT NULL,
       context_json TEXT, idempotency_key TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
       status TEXT NOT NULL, title TEXT, processed_json TEXT, kaneo_task_id TEXT, kaneo_task_url TEXT,
       archive_stage TEXT, archive_data_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
       last_error TEXT, error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
  const userId = "legacy-user-1";
  db.prepare("INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    "admin",
    "stored-hash-placeholder",
    "2020-01-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, text, idempotency_key, content_hash, status, created_at, updated_at)
     VALUES ('fb-old', 'app-1', 'com.legacy.app', '历史反馈', 'legacy-key', 'hash', 'archived', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z')`,
  ).run();
  run(db, "PRAGMA user_version = 2");
  db.close();
  return { dir, userId };
}

describe("数据库迁移 v2 → v4", () => {
  it("原有账号迁为管理员、保留密码；历史反馈归属初始账号；版本号推进到 4 并建立 feedback_logs", () => {
    const { dir, userId } = seedLegacyDb();
    const db = openDb(dir);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    expect(user.role).toBe("admin");
    expect(user.enabled).toBe(1);
    expect(user.daily_limit).toBe(3);
    expect(user.pass_hash).toBe("stored-hash-placeholder"); // 密码保留
    const fb = db.prepare("SELECT user_id FROM feedbacks WHERE id = 'fb-old'").get() as any;
    expect(fb.user_id).toBe(userId);
    const uv = (db.prepare("PRAGMA user_version").get() as any).user_version;
    expect(uv).toBe(7);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
    expect(tables).toContain("feedback_logs");
    db.prepare("INSERT INTO daily_usage (user_id, day, used, reset_at) VALUES (?, '2026-01-01', 0, 'x')").run(userId);
    db.close();
  });

  it("迁移失败时整体回滚：版本号不前进且新列不存在", () => {
    const { dir } = seedLegacyDb();
    const raw = new DatabaseSync(path.join(dir, "feedback.db"));
    raw.exec("CREATE TRIGGER fail_role BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(() => migrate(raw)).toThrow();
    const uv = (raw.prepare("PRAGMA user_version").get() as any).user_version;
    expect(uv).toBe(2);
    const cols = (raw.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name);
    expect(cols).not.toContain("role");
    raw.close();
  });

  it("从 v3 升级到最新版本：保留既有数据并建立 feedback_logs 表", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fb-v3-upgrade-"));
    const raw = new DatabaseSync(path.join(dir, "feedback.db"));
    raw.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', enabled INTEGER NOT NULL DEFAULT 1, daily_limit INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL);
      CREATE TABLE feedbacks (id TEXT PRIMARY KEY, app_row_id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, context_json TEXT, idempotency_key TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, status TEXT NOT NULL, title TEXT, processed_json TEXT, kaneo_task_id TEXT, kaneo_task_url TEXT, archive_stage TEXT, archive_data_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, error_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE daily_usage (user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, reset_at TEXT NOT NULL, PRIMARY KEY (user_id, day));
      PRAGMA user_version = 3;
    `);
    raw.close();

    const db = openDb(dir);
    const uv = (db.prepare("PRAGMA user_version").get() as any).user_version;
    expect(uv).toBe(7);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
    expect(tables).toContain("feedback_logs");
    db.close();
  });
});

// ------------------------------------------------------------------ 账号管理（T2）

describe("账号管理", () => {
  it("创建账号默认每日 3 次；重复用户名 409；响应不含口令或哈希", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    const created = await jsonReq(t.app, "POST", "/api/admin/users", {
      cookie,
      body: { username: "alice", password: PW },
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ username: "alice", enabled: true, dailyLimit: 3, used: 0, remaining: 3 });
    expect(JSON.stringify(created.data)).not.toContain(PW);
    expect(JSON.stringify(created.data)).not.toContain("hash");

    const dup = await jsonReq(t.app, "POST", "/api/admin/users", { cookie, body: { username: "alice", password: PW } });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("user_exists");

    const list = await jsonReq(t.app, "GET", "/api/admin/users", { cookie });
    expect(list.data.users).toHaveLength(1);
    expect(list.data.users[0].username).toBe("alice");
  });

  it("禁用账号撤销全部会话且鉴权立即失效；启用后可重新登录；重置口令同样撤销会话", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    const acct = await createAccount(t, cookie, "bob");
    const bearer = await loginAccount(t, "bob");

    expect((await jsonReq(t.app, "GET", "/api/auth/session", { bearer })).status).toBe(200);

    const disabled = await jsonReq(t.app, "PATCH", `/api/admin/users/${acct.id}`, {
      cookie,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.data.enabled).toBe(false);
    expect((await jsonReq(t.app, "GET", "/api/auth/session", { bearer })).status).toBe(401);

    await jsonReq(t.app, "PATCH", `/api/admin/users/${acct.id}`, { cookie, body: { enabled: true } });
    const bearer2 = await loginAccount(t, "bob");
    expect((await jsonReq(t.app, "GET", "/api/auth/session", { bearer: bearer2 })).status).toBe(200);

    const pw = await jsonReq(t.app, "POST", `/api/admin/users/${acct.id}/password`, {
      cookie,
      body: { password: NEW_PW },
    });
    expect(pw.status).toBe(200);
    expect((await jsonReq(t.app, "GET", "/api/auth/session", { bearer: bearer2 })).status).toBe(401);
  });

  it("普通账号即使持有 Cookie 也不能管理服务；管理员不在账号列表且不可被本页管理", async () => {
    const t = newApp();
    const adminCookie = await loginAsAdmin(t);
    const acct = await createAccount(t, adminCookie, "carol");
    const userCookie = await loginAccountCookie(t, "carol");

    const requests = [
      await jsonReq(t.app, "GET", "/api/admin/users", { cookie: userCookie }),
      await jsonReq(t.app, "GET", "/api/admin/feedback", { cookie: userCookie }),
      await jsonReq(t.app, "GET", "/api/auth/sessions", { cookie: userCookie }),
      await jsonReq(t.app, "PATCH", `/api/admin/users/${acct.id}`, { cookie: userCookie, body: { enabled: false } }),
    ];
    for (const r of requests) {
      expect(r.status).toBe(403);
      expect(r.data.error.code).toBe("forbidden");
    }

    const list = await jsonReq(t.app, "GET", "/api/admin/users", { cookie: adminCookie });
    expect(list.data.users.some((u: any) => u.username === "admin")).toBe(false);
  });

  it("额度从 3 调 5 立即生效；降到低于已用次数时剩余为 0", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    const acct = await createAccount(t, cookie, "dave", 3);
    const bearer = await loginAccount(t, "dave");
    await submitFeedback(t, bearer, defaultSubmitBody());
    await submitFeedback(t, bearer, defaultSubmitBody());
    await submitFeedback(t, bearer, defaultSubmitBody());
    await t.worker.idle();

    const up = await jsonReq(t.app, "PATCH", `/api/admin/users/${acct.id}`, { cookie, body: { dailyLimit: 5 } });
    expect(up.data).toMatchObject({ dailyLimit: 5, used: 3, remaining: 2 });

    const down = await jsonReq(t.app, "PATCH", `/api/admin/users/${acct.id}`, { cookie, body: { dailyLimit: 1 } });
    expect(down.data).toMatchObject({ dailyLimit: 1, used: 3, remaining: 0 });
  });
});

// ------------------------------------------------------------------ 每日额度与归属（T3）

describe("每日提交额度", () => {
  it("默认 3 次：第 4 次 429 daily_quota_exceeded 且带同结构额度；跨 app 合计；另一账号独立", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await seedApp(t, cookie, { appId: "com.test.other" });
    await createAccount(t, cookie, "erin");
    const bearer = await loginAccount(t, "erin");

    const r1 = await submitFeedback(t, bearer, defaultSubmitBody());
    const r2 = await submitFeedback(t, bearer, defaultSubmitBody({ appId: "com.test.other" }));
    const r3 = await submitFeedback(t, bearer, defaultSubmitBody());
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
    expect(r3.data.quota).toMatchObject({ dailyLimit: 3, used: 3, remaining: 0 });

    const r4 = await submitFeedback(t, bearer, defaultSubmitBody());
    expect(r4.status).toBe(429);
    expect(r4.data.error.code).toBe("daily_quota_exceeded");
    expect(r4.data.quota).toMatchObject({ dailyLimit: 3, used: 3, remaining: 0 });
    await t.worker.idle();

    await createAccount(t, cookie, "frank");
    const bearer2 = await loginAccount(t, "frank");
    expect((await submitFeedback(t, bearer2, defaultSubmitBody())).status).toBe(201);
  });

  it("幂等：同键同内容重放不扣次，额度满时仍可重放；同键不同内容 409；他账号占用同键返回通用冲突", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await createAccount(t, cookie, "gina");
    const bearer = await loginAccount(t, "gina");
    const body = defaultSubmitBody({ idempotencyKey: "shared-key-1" });
    const first = await submitFeedback(t, bearer, body);
    expect(first.status).toBe(201);

    const replay = await submitFeedback(t, bearer, body);
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.quota.used).toBe(1);

    const conflict = await submitFeedback(t, bearer, { ...body, text: "不同内容" });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe("idempotency_conflict");
    await t.worker.idle();

    // 他账号用同一 key：通用冲突，不透露原记录
    await createAccount(t, cookie, "hank");
    const bearer2 = await loginAccount(t, "hank");
    const other = await submitFeedback(t, bearer2, body);
    expect(other.status).toBe(409);
    expect(other.data.error.code).toBe("idempotency_conflict");
    expect(other.data.feedbackId).toBeUndefined();

    // 额度满后仍允许重放自己已接收的请求
    await submitFeedback(t, bearer, defaultSubmitBody());
    await submitFeedback(t, bearer, defaultSubmitBody());
    expect((await submitFeedback(t, bearer, defaultSubmitBody())).status).toBe(429);
    const replayAtFull = await submitFeedback(t, bearer, body);
    expect(replayAtFull.status).toBe(200);
  });

  it("剩余 1 次时并发提交两条：仅一条成功", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await createAccount(t, cookie, "ivan", 1);
    const bearer = await loginAccount(t, "ivan");
    const results = await Promise.all([
      submitFeedback(t, bearer, defaultSubmitBody()),
      submitFeedback(t, bearer, defaultSubmitBody()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    await t.worker.idle();
  });

  it("事务失败不扣次：写入反馈抛错后用量保持 0", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    const acct = await createAccount(t, cookie, "jane", 3);
    const bearer = await loginAccount(t, "jane");

    const original = t.db.prepare.bind(t.db);
    (t.db as any).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO feedbacks")) throw new Error("injected write failure");
      return original(sql);
    };
    const failed = await submitFeedback(t, bearer, defaultSubmitBody());
    (t.db as any).prepare = original;
    expect(failed.status).toBe(500);

    const used = t.db.prepare("SELECT used FROM daily_usage WHERE user_id = ?").get(acct.id) as
      | { used: number }
      | undefined;
    expect(used?.used ?? 0).toBe(0);
  });

  it("北京时间日切：跨过 resetAt 后额度自动恢复（可控服务端时钟）", async () => {
    // 北京时间 2026-01-01 23:59
    let nowMs = Date.parse("2026-01-01T15:59:00.000Z");
    const t = newApp(() => nowMs);
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await createAccount(t, cookie, "kim", 1);
    const bearer = await loginAccount(t, "kim");

    const ok = await submitFeedback(t, bearer, defaultSubmitBody());
    expect(ok.status).toBe(201);
    expect(ok.data.quota.resetAt).toBe("2026-01-01T16:00:00.000Z");
    expect((await submitFeedback(t, bearer, defaultSubmitBody())).status).toBe(429);

    // 跨过北京时间零点
    nowMs = Date.parse("2026-01-01T16:00:01.000Z");
    const next = await submitFeedback(t, bearer, defaultSubmitBody());
    expect(next.status).toBe(201);
    expect(next.data.quota).toMatchObject({ used: 1, remaining: 0, resetAt: "2026-01-02T16:00:00.000Z" });
    await t.worker.idle();
  });

  it("beijingDay / beijingResetAt 边界正确", () => {
    expect(beijingDay(Date.parse("2026-01-01T15:59:59.999Z"))).toBe("2026-01-01");
    expect(beijingDay(Date.parse("2026-01-01T16:00:00.000Z"))).toBe("2026-01-02");
    expect(beijingResetAt(Date.parse("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T16:00:00.000Z");
  });
});

// ------------------------------------------------------------------ 反馈归属

describe("反馈归属隔离", () => {
  it("普通账号只能读自己的反馈与截图；他人记录统一 404；管理员全量可见", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await createAccount(t, cookie, "laura");
    await createAccount(t, cookie, "mike");
    const bearerA = await loginAccount(t, "laura");
    const bearerB = await loginAccount(t, "mike");
    const created = await submitFeedback(t, bearerA, defaultSubmitBody());
    const id = created.data.feedbackId;
    await t.worker.idle();

    expect((await jsonReq(t.app, "GET", `/api/feedback/${id}`, { bearer: bearerA })).status).toBe(200);
    const denied = await jsonReq(t.app, "GET", `/api/feedback/${id}`, { bearer: bearerB });
    expect(denied.status).toBe(404);
    expect((await jsonReq(t.app, "GET", `/api/feedback/${id}/screenshot`, { bearer: bearerB })).status).toBe(404);

    const adminView = await jsonReq(t.app, "GET", `/api/admin/feedback/${id}`, { cookie });
    expect(adminView.status).toBe(200);
    expect(adminView.data.username).toBe("laura");
  });

  it("普通账号不能执行反馈重试 / 恢复（管理员专属）", async () => {
    const t = newApp();
    const cookie = await loginAsAdmin(t);
    await seedApp(t, cookie);
    await createAccount(t, cookie, "nina");
    const bearer = await loginAccount(t, "nina");
    const created = await submitFeedback(t, bearer, defaultSubmitBody());
    const id = created.data.feedbackId;
    await t.worker.idle();

    const userCookie = await loginAccountCookie(t, "nina");
    const retry = await jsonReq(t.app, "POST", `/api/feedback/${id}/retry`, { cookie: userCookie, body: {} });
    expect(retry.status).toBe(403);
  });
});
