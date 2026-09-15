import { describe, expect, it } from "vitest";
import { getUserById, getUserByUsername } from "../src/db/repos.ts";
import { jsonReq, loginAsAdmin, makeHarness, TEST_PASSWORD, type TestSetup } from "./helpers.ts";

const ME = "/api/admin/me";
const NEW_PASSWORD = "brand-new-password-42";
const NEW_USERNAME = "renamed-admin";
/** 事务写入失败注入：撤销会话的那条 UPDATE。 */
const REVOKE_SESSIONS_SQL = "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL";

/**
 * 每个用例的 PATCH /api/admin/me 请求次数都刻意压在限流窗口（10 次/15 分钟，按管理员 id 计时）
 * 之内：makeHarness 每次都重建 app 与限流器，超出窗口会让断言变成 429。
 */

/** 当前管理员行的原始快照（断言「不变」用）。 */
function adminRow(h: TestSetup) {
  return getUserByUsername(h.feedbackApp.db, "admin");
}

async function login(h: TestSetup, username: string, password: string) {
  return jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", { body: { username, password } });
}

/** 新建一个带凭据的普通账号，返回账号 id。 */
async function createOrdinaryUser(h: TestSetup, username: string, password: string): Promise<string> {
  const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/users", {
    cookie: h.cookie,
    body: { username, password },
  });
  expect(r.status).toBe(201);
  return r.data.id as string;
}

/** 登录并取出 Cookie 头（普通账号会话）。 */
async function userCookie(h: TestSetup, username: string, password: string): Promise<string> {
  const r = await login(h, username, password);
  expect(r.status).toBe(200);
  return (r.headers.getSetCookie?.()[0] ?? "").split(";")[0] as string;
}

describe("管理员设置：PATCH /api/admin/me", () => {
  it("守卫：Bearer 令牌、普通账号 Cookie、跨源 Origin、无凭据一律拒绝", async () => {
    const h = await makeHarness();
    const before = adminRow(h)!;

    // 1. 管理员 Bearer 令牌（client 会话）不能改凭据（守卫只接受 Cookie 会话）
    const bearer = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      bearer: h.bearer,
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(bearer.status).toBe(403);
    expect(bearer.data.error.code).toBe("unauthorized");

    // 2. 普通账号 Cookie 不能改凭据（守卫重新读取角色）
    await createOrdinaryUser(h, "normal-1", "normal-pass-1234");
    const normal = await userCookie(h, "normal-1", "normal-pass-1234");
    const asUser = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: normal,
      body: { currentPassword: "normal-pass-1234", newPassword: NEW_PASSWORD },
    });
    expect(asUser.status).toBe(403);
    expect(asUser.data.error.code).toBe("forbidden");

    // 3. 跨源 Origin（Cookie 写操作的 CSRF 基础层）
    const cross = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      origin: "http://evil.test",
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(cross.status).toBe(403);
    expect(cross.data.error.code).toBe("origin_mismatch");

    // 4. 无凭据
    const anon = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(anon.status).toBe(401);
    expect(anon.data.error.code).toBe("unauthorized");

    // 全被拒 → 管理员凭据与角色不变，会话也未被撤销
    expect(adminRow(h)!).toMatchObject({
      id: before.id,
      username: before.username,
      pass_hash: before.pass_hash,
      role: "admin",
    });
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie })).status).toBe(200);
    // 普通账号会话未受影响
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: normal })).status).toBe(200);
  });

  it("仅改用户名：{ok,reauthenticate}、清 Cookie、该管理员会话全失效、新用户名可登录", async () => {
    const h = await makeHarness();
    const adminId = adminRow(h)!.id;
    // 普通账号留一个活跃会话，用于断言「不受影响」
    await createOrdinaryUser(h, "normal-2", "normal-pass-1234");
    const normal = await userCookie(h, "normal-2", "normal-pass-1234");
    // 该管理员的第二个会话（client Bearer，不参与路由守卫）也必须被撤销
    const second = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
      origin: "http://host.test",
      body: { username: "admin", password: TEST_PASSWORD, clientLabel: "second", appId: "com.test.app" },
    });
    expect(second.status).toBe(200);

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: `  ${NEW_USERNAME}  ` }, // username 去首尾空格
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, reauthenticate: true });
    expect(r.headers.get("set-cookie") ?? "").toContain("fb_session=;");

    // 旧用户名不能再登录；新用户名 + 旧密码可以
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(401);
    expect((await login(h, NEW_USERNAME, TEST_PASSWORD)).status).toBe(200);

    const after = getUserById(h.feedbackApp.db, adminId)!;
    expect(after.username).toBe(NEW_USERNAME);
    expect(after).toMatchObject({ id: adminId, role: "admin", enabled: 1, daily_limit: 3 });
    expect(getUserByUsername(h.feedbackApp.db, "admin")).toBeNull();

    // 该管理员全部会话失效（当前 cookie + 第一个 client bearer + 第二个 client）
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie })).status).toBe(401);
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { bearer: h.bearer })).status).toBe(401);
    expect(
      (await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { bearer: second.data.token as string })).status,
    ).toBe(401);

    // 普通账号会话不受影响
    const unaffected = await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: normal });
    expect(unaffected.status).toBe(200);
    expect(unaffected.data.user.username).toBe("normal-2");
  });

  it("仅改密码：首尾空格保留、新密码可登录、旧密码失效、历史反馈归属不变", async () => {
    const h = await makeHarness();
    const adminId = adminRow(h)!.id;
    const submitted = "  spaced-password  "; // 首尾空格也是密码字符，服务端不去除
    const submit = await jsonReq(h.feedbackApp.app, "POST", "/api/feedback", {
      bearer: h.bearer,
      body: {
        idempotencyKey: "key-me-attribution",
        appId: "com.test.app",
        text: "改密码前提交的反馈，归属必须保持原账号",
      },
    });
    expect(submit.status).toBe(201);
    const feedbackId = submit.data.feedbackId as string;

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, newPassword: submitted },
    });
    expect(r.status).toBe(200);
    expect(r.data.reauthenticate).toBe(true);

    // 用户名没变
    expect(getUserById(h.feedbackApp.db, adminId)!.username).toBe("admin");
    // 原样提交（含空格）能登录；去空格或旧密码不能
    expect((await login(h, "admin", submitted)).status).toBe(200);
    expect((await login(h, "admin", submitted.trim())).status).toBe(401);
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(401);

    // 历史反馈归属不变（仍指向同一管理员 id）
    const fresh = await loginAsAdmin(h.feedbackApp, submitted);
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${feedbackId}`, { cookie: fresh });
    expect(detail.status).toBe(200);
    expect(detail.data.username).toBe("admin");
    expect(h.feedbackApp.db.prepare("SELECT user_id FROM feedbacks WHERE id = ?").get(feedbackId)).toEqual({
      user_id: adminId,
    });
  });

  it("同时改用户名与密码：一次请求同时生效，users 表与 user_version 不变", async () => {
    const h = await makeHarness();
    const adminId = adminRow(h)!.id;
    const versionBefore = h.feedbackApp.db.prepare("PRAGMA user_version").get();

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, reauthenticate: true });
    expect((await login(h, NEW_USERNAME, NEW_PASSWORD)).status).toBe(200);
    expect((await login(h, NEW_USERNAME, TEST_PASSWORD)).status).toBe(401);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);

    const after = getUserById(h.feedbackApp.db, adminId)!;
    expect(after).toMatchObject({ id: adminId, username: NEW_USERNAME, role: "admin", daily_limit: 3, enabled: 1 });
    const cols = (h.feedbackApp.db.prepare("PRAGMA table_info(users)").all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(["id", "username", "pass_hash", "role", "enabled", "daily_limit", "created_at"]);
    expect(h.feedbackApp.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
  });

  it("当前密码错误 → 403 invalid_current_password（凭据与会话都不变）", async () => {
    const h = await makeHarness();
    const before = adminRow(h)!;

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: "wrong-password", username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("invalid_current_password");

    expect(adminRow(h)!).toMatchObject({ id: before.id, username: before.username, pass_hash: before.pass_hash });
    expect(getUserByUsername(h.feedbackApp.db, NEW_USERNAME)).toBeNull();
    // 当前会话未被撤销
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie })).status).toBe(200);
  });

  it("新用户名与其他账号重复 → 409 user_exists（含事务内竞态复查）", async () => {
    const h = await makeHarness();
    const before = adminRow(h)!;
    await createOrdinaryUser(h, "occupied-name", "occupied-pass-1234");

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: "occupied-name" },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("user_exists");
    expect(adminRow(h)!).toMatchObject({ username: "admin", pass_hash: before.pass_hash });
    // 用户仍在
    expect((await login(h, "occupied-name", "occupied-pass-1234")).status).toBe(200);

    // 竞态兜底：路由校验通过后、事务提交前该用户名被占用 → 事务内复查 → 409 且整体回滚
    h.feedbackApp.db
      .prepare(
        `INSERT INTO users (id, username, pass_hash, role, enabled, daily_limit, created_at)
         VALUES ('racer-id', 'raced-name', ?, 'user', 1, 3, ?)`,
      )
      .run(before.pass_hash, new Date().toISOString());

    const raced = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: "raced-name", newPassword: NEW_PASSWORD },
    });
    expect(raced.status).toBe(409);
    expect(raced.data.error.code).toBe("user_exists");
    // 事务回滚：用户名与密码都保持原值
    expect(adminRow(h)!).toMatchObject({ username: "admin", pass_hash: before.pass_hash });
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);

    // 新用户名与「自己」当前用户名相同不算冲突（幂等重放）
    const sameName = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: "admin", newPassword: NEW_PASSWORD },
    });
    expect(sameName.status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(200);
  });

  it("非法输入 → 400 invalid_request（凭据不变）", async () => {
    const h = await makeHarness();
    const before = adminRow(h)!;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["两个可选字段都未提供", { currentPassword: TEST_PASSWORD }],
      ["username 与 newPassword 都是空白", { currentPassword: TEST_PASSWORD, username: "  ", newPassword: "" }],
      ["缺少 currentPassword", { username: NEW_USERNAME }],
      ["currentPassword 类型错误", { currentPassword: 123, newPassword: NEW_PASSWORD }],
      ["username 纯空白", { currentPassword: TEST_PASSWORD, username: "   " }],
      ["username 超长", { currentPassword: TEST_PASSWORD, username: "u".repeat(101) }],
      ["newPassword 太短", { currentPassword: TEST_PASSWORD, newPassword: "1234567" }],
      ["newPassword 仅空格不足 8 位", { currentPassword: TEST_PASSWORD, newPassword: "   1234" }],
      ["newPassword 超长", { currentPassword: TEST_PASSWORD, newPassword: "p".repeat(201) }],
    ];
    for (const [name, body] of cases) {
      const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, { cookie: h.cookie, body });
      expect(`${name} → ${r.status}/${r.data.error?.code}`).toBe(`${name} → 400/invalid_request`);
    }

    // 空 body（两个可选字段都缺失）
    const empty = await jsonReq(h.feedbackApp.app, "PATCH", ME, { cookie: h.cookie, body: {} });
    expect(empty.status).toBe(400);
    expect(empty.data.error.code).toBe("invalid_request");

    // 全是 400 → 凭据不变
    expect(adminRow(h)!).toMatchObject({ id: before.id, username: before.username, pass_hash: before.pass_hash });
  });

  it("多余字段被忽略：不能借字段指定他人账号", async () => {
    const h = await makeHarness();
    const victimId = await createOrdinaryUser(h, "victim", "victim-pass-1234");
    const victimBefore = getUserById(h.feedbackApp.db, victimId)!;

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, userId: victimId, id: victimId },
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, reauthenticate: true });

    // 只有当前会话账号被改；victim 原封不动
    expect(getUserById(h.feedbackApp.db, victimId)!).toMatchObject({
      username: victimBefore.username,
      pass_hash: victimBefore.pass_hash,
    });
    expect((await login(h, "victim", "victim-pass-1234")).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(200);
  });

  it("独立限流：按管理员 id 计数，第 11 次 429 rate_limited + Retry-After", async () => {
    const h = await makeHarness();
    // 前 10 次合法请求都被「当前密码错误」拒绝（403），但都计入限流窗口
    for (let i = 0; i < 10; i++) {
      const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
        cookie: h.cookie,
        body: { currentPassword: "wrong-password", newPassword: NEW_PASSWORD },
      });
      expect(r.status).toBe(403);
      expect(r.data.error.code).toBe("invalid_current_password");
    }
    const limited = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(limited.status).toBe(429);
    expect(limited.data.error.code).toBe("rate_limited");
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isSafeInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    // 限流不改变凭据
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);
  });

  it("事务失败整体回滚：写入与撤销一起回退，凭据与会话保持原值", async () => {
    const h = await makeHarness();
    const before = adminRow(h)!;
    const db = h.feedbackApp.db;

    // (1) 撤销会话一步失败 → 整体 ROLLBACK
    // StatementSync.run 有两个重载（匿名参数 / 具名参数），注入时用宽松签名即可。
    const originalPrepare = db.prepare.bind(db);
    const patchable = db as unknown as { prepare: (sql: string) => unknown };
    let armed = true;
    patchable.prepare = (sql: string) => {
      const stmt = originalPrepare(sql) as unknown as { run: (...args: unknown[]) => unknown };
      if (sql === REVOKE_SESSIONS_SQL) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          if (armed) {
            armed = false;
            throw new Error("注入失败：撤销会话写入失败");
          }
          return originalRun(...args);
        };
      }
      return stmt;
    };

    const failRevoke = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(failRevoke.status).toBe(500);
    expect(failRevoke.data.error.code).toBe("internal");
    expect(adminRow(h)!).toMatchObject({ username: before.username, pass_hash: before.pass_hash });
    expect(getUserByUsername(h.feedbackApp.db, NEW_USERNAME)).toBeNull();
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);
    // 撤销也回滚：当前会话仍有效
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie })).status).toBe(200);

    patchable.prepare = originalPrepare;

    // (2) COMMIT 失败 → 事务内已执行的写入（用户名/密码/撤销）整体回退
    const originalExec = db.exec.bind(db);
    let commitArmed = true;
    const patchableDb = db as unknown as { exec: (sql: string) => unknown };
    patchableDb.exec = (sql: string) => {
      if (commitArmed && /^COMMIT/i.test(sql.trim())) {
        commitArmed = false;
        throw new Error("注入失败：提交失败");
      }
      return originalExec(sql);
    };

    const failCommit = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(failCommit.status).toBe(500);
    expect(failCommit.data.error.code).toBe("internal");
    expect(adminRow(h)!).toMatchObject({ username: before.username, pass_hash: before.pass_hash });
    expect(getUserByUsername(h.feedbackApp.db, NEW_USERNAME)).toBeNull();
    expect((await login(h, "admin", TEST_PASSWORD)).status).toBe(200);
    expect((await login(h, "admin", NEW_PASSWORD)).status).toBe(401);
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie })).status).toBe(200);

    // 注入解除后仍能正常改（证明注入只影响故障那一次）
    patchableDb.exec = originalExec;
    const ok = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ ok: true, reauthenticate: true });
    expect((await login(h, NEW_USERNAME, NEW_PASSWORD)).status).toBe(200);
  });

  it("旧普通账号在管理员改自己凭据后不受影响（会话与登录均正常）", async () => {
    const h = await makeHarness();
    const userId = await createOrdinaryUser(h, "bystander", "bystander-pass-1234");
    const cookie = await userCookie(h, "bystander", "bystander-pass-1234");

    const r = await jsonReq(h.feedbackApp.app, "PATCH", ME, {
      cookie: h.cookie,
      body: { currentPassword: TEST_PASSWORD, username: NEW_USERNAME, newPassword: NEW_PASSWORD },
    });
    expect(r.status).toBe(200);

    const session = await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie });
    expect(session.status).toBe(200);
    expect(session.data.user.id).toBe(userId);
    expect((await login(h, "bystander", "bystander-pass-1234")).status).toBe(200);
    // 该普通账号的凭据未被改动
    expect(getUserById(h.feedbackApp.db, userId)!.username).toBe("bystander");
  });
});
