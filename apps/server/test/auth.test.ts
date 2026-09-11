import { describe, expect, it } from "vitest";
import { jsonReq, loginAsAdmin, makeTestApp, TEST_PASSWORD } from "./helpers.ts";

describe("认证", () => {
  it("初始账号可登录并建立 cookie 会话；错误密码 401", async () => {
    const t = makeTestApp();
    const bad = await jsonReq(t.app, "POST", "/api/auth/login", {
      body: { username: "admin", password: "wrong" },
    });
    expect(bad.status).toBe(401);
    expect(bad.data.error.code).toBe("invalid_credentials");

    const ok = await jsonReq(t.app, "POST", "/api/auth/login", {
      body: { username: "admin", password: TEST_PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.ok).toBe(true);
    expect(ok.data.token).toBeUndefined(); // 浏览器登录不发 bearer
    const cookie = await loginAsAdmin(t);
    const s = await jsonReq(t.app, "GET", "/api/auth/session", { cookie });
    expect(s.status).toBe(200);
    expect(s.data.kind).toBe("cookie");
  });

  it("clientLabel 登录返回长期可撤销 bearer 令牌", async () => {
    const t = makeTestApp();
    const r = await jsonReq(t.app, "POST", "/api/auth/login", {
      body: { username: "admin", password: TEST_PASSWORD, clientLabel: "flutter-android" },
    });
    expect(r.status).toBe(200);
    expect(typeof r.data.token).toBe("string");
    const s = await jsonReq(t.app, "GET", "/api/auth/session", { bearer: r.data.token });
    expect(s.data.kind).toBe("client");
    expect(s.data.clientLabel).toBe("flutter-android");
  });

  it("登录限流：窗口内多次失败后 429", async () => {
    const t = makeTestApp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await jsonReq(t.app, "POST", "/api/auth/login", {
        body: { username: "admin", password: `bad-${i}` },
      });
      last = r.status;
      if (r.status === 429) {
        expect(r.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("logout 撤销当前会话；撤销后 cookie 失效", async () => {
    const t = makeTestApp();
    const cookie = await loginAsAdmin(t);
    const out = await jsonReq(t.app, "POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(204);
    const s = await jsonReq(t.app, "GET", "/api/auth/session", { cookie });
    expect(s.status).toBe(401);
  });

  it("会话列表与撤销：revoke 指定会话后其 bearer 立即失效", async () => {
    const t = makeTestApp();
    const cookie = await loginAsAdmin(t);
    const cli = await jsonReq(t.app, "POST", "/api/auth/login", {
      body: { username: "admin", password: TEST_PASSWORD, clientLabel: "device-x" },
    });
    const list = await jsonReq(t.app, "GET", "/api/auth/sessions", { cookie });
    expect(list.status).toBe(200);
    const cookieEntry = list.data.sessions.find((x: any) => x.kind === "cookie");
    expect(cookieEntry.current).toBe(true);
    const clientEntry = list.data.sessions.find((x: any) => x.clientLabel === "device-x");
    expect(clientEntry).toBeTruthy();

    const del = await jsonReq(t.app, "DELETE", `/api/auth/sessions/${clientEntry.id}`, { cookie });
    expect(del.status).toBe(204);
    const after = await jsonReq(t.app, "GET", "/api/auth/session", { bearer: cli.data.token });
    expect(after.status).toBe(401);

    const all = await jsonReq(t.app, "POST", "/api/auth/sessions/revoke-all", { cookie });
    expect(all.status).toBe(200);
    expect(all.data.revoked).toBeGreaterThanOrEqual(0);
  });

  it("握手：仅允许配置的来源；签发短期令牌可用 Bearer 查询状态", async () => {
    const t = makeTestApp();
    const cookie = await loginAsAdmin(t);
    // 建一个允许 http://host.test 的 app
    await jsonReq(t.app, "POST", "/api/admin/apps", {
      cookie,
      body: {
        appId: "com.handshake.app",
        name: "hs",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "p1",
        kaneoColumnSlug: "triage",
      },
    });
    const bad = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      cookie,
      body: { appId: "com.handshake.app", origin: "http://evil.test" },
    });
    expect(bad.status).toBe(403);
    expect(bad.data.error.code).toBe("origin_not_allowed");

    const good = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      cookie,
      body: { appId: "com.handshake.app", origin: "http://host.test" },
    });
    expect(good.status).toBe(200);
    expect(typeof good.data.accessToken).toBe("string");
    expect(good.data.expiresIn).toBeGreaterThan(0);

    const s = await jsonReq(t.app, "GET", "/api/auth/session", { bearer: good.data.accessToken });
    expect(s.data.kind).toBe("handshake");
  });

  it("无握手 cookie 时 handshake 401", async () => {
    const t = makeTestApp();
    const r = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      body: { appId: "x", origin: "http://host.test" },
    });
    expect(r.status).toBe(401);
  });

  it("cookie 会话的写操作拒绝跨站 Origin（管理接口 CSRF 基础层）", async () => {
    const t = makeTestApp();
    const cookie = await loginAsAdmin(t);
    const r = await jsonReq(t.app, "POST", "/api/admin/apps", {
      cookie,
      origin: "http://evil.test",
      body: { appId: "a", name: "n", allowedOrigins: [], kaneoProjectId: "", kaneoColumnSlug: "" },
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("origin_mismatch");
  });

  it("配置 FEEDBACK_PUBLIC_URL 后，同源校验以公网 origin 为准（内部请求 URL 不再生效）", async () => {
    const t = makeTestApp();
    t.config.publicUrl = "https://feedback.example.com";
    const cookie = await loginAsAdmin(t);

    // 浏览器实际发送的公网 Origin：反向代理改写内部请求 URL 后仍应通过
    const ok = await jsonReq(t.app, "POST", "/api/admin/apps", {
      cookie,
      origin: "https://feedback.example.com",
      body: { appId: "pub", name: "n", allowedOrigins: [], kaneoProjectId: "", kaneoColumnSlug: "" },
    });
    expect(ok.status).toBe(201);

    // 内部/容器地址不再被当作期望来源
    const bad = await jsonReq(t.app, "POST", "/api/admin/apps", {
      cookie,
      origin: "http://localhost",
      body: { appId: "pub2", name: "n", allowedOrigins: [], kaneoProjectId: "", kaneoColumnSlug: "" },
    });
    expect(bad.status).toBe(403);
    expect(bad.data.error.code).toBe("origin_mismatch");
  });

  it("auth 握手接口的 cookie 写操作同样按公网 origin 校验", async () => {
    const t = makeTestApp();
    t.config.publicUrl = "https://feedback.example.com";
    const cookie = await loginAsAdmin(t);

    const bad = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      cookie,
      origin: "https://feedback.example.com.evil.test",
      body: { appId: "x", origin: "http://host.test" },
    });
    expect(bad.status).toBe(403);
    expect(bad.data.error.code).toBe("origin_mismatch");

    // 公网 origin 通过同源检查后，接下来的拒绝来自"目标来源未登记"，而不是同源检查
    await jsonReq(t.app, "POST", "/api/admin/apps", {
      cookie,
      origin: "https://feedback.example.com",
      body: {
        appId: "x",
        name: "n",
        allowedOrigins: ["http://other.test"],
        kaneoProjectId: "",
        kaneoColumnSlug: "",
      },
    });
    const ok = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      cookie,
      origin: "https://feedback.example.com",
      body: { appId: "x", origin: "http://host.test" },
    });
    expect(ok.data.error.code).toBe("origin_not_allowed");

    // 未登记的 appId 走 unknown_app（不是同源失败，也不是来源未允许）
    const unknown = await jsonReq(t.app, "POST", "/api/auth/handshake", {
      cookie,
      origin: "https://feedback.example.com",
      body: { appId: "nope", origin: "http://host.test" },
    });
    expect(unknown.data.error.code).toBe("unknown_app");
  });

  it("登录页可访问且带 CSP", async () => {
    const t = makeTestApp();
    const res = await t.app.request("http://localhost/login?appId=x&nonce=n&cb=http%3A%2F%2Fhost.test");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("nonce-");
    expect(await res.text()).toContain("Feedback 登录");
  });
});
