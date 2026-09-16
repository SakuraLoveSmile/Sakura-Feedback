import { describe, expect, it } from "vitest";
import {
  authorizeArchive,
  defaultSubmitBody,
  jsonReq,
  loginAsAdmin,
  makeHarness,
  makeMockKaneo,
  makeTestApp,
  submitFeedback,
} from "./helpers.ts";

describe("软件配置管理", () => {
  it("CRUD 与 appId 不可变", async () => {
    const h = await makeHarness();
    const created = h.app;
    expect(created.appId).toBe("com.test.app");

    const dup = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
      cookie: h.cookie,
      body: { appId: "com.test.app", name: "x", allowedOrigins: [] },
    });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("app_exists");

    const upd = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${created.id}`, {
      cookie: h.cookie,
      body: {
        appId: "尝试篡改",
        expectedRuleVersion: created.ruleVersion,
        name: "改名",
        allowedOrigins: ["https://a.test", "https://b.test"],
        kaneoProjectId: "proj-2",
        kaneoColumnSlug: "triage",
      },
    });
    expect(upd.status).toBe(200);
    expect(upd.data.appId).toBe("com.test.app"); // appId 不可改
    expect(upd.data.name).toBe("改名");
    expect(upd.data.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);

    const bad = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
      cookie: h.cookie,
      body: { appId: "bad", name: "n", allowedOrigins: ["javascript:alert(1)"] },
    });
    expect(bad.status).toBe(400);

    const del = await jsonReq(h.feedbackApp.app, "DELETE", `/api/admin/apps/${created.id}`, { cookie: h.cookie });
    expect(del.status).toBe(204);
    // 删除后历史反馈仍可见（详情可读）
    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie });
    expect(list.status).toBe(200);
  });

  it("提交到未登记 appId：自动发现为待配置软件并成功接收", async () => {
    const h = await makeHarness();
    const key = "discover-key";
    const before = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ appId: "com.new.app", idempotencyKey: key }),
    );
    // T1：不再要求预先登记软件；首次有效提交即在事务内创建待配置软件。
    expect(before.status).toBe(201);
    expect(before.data.collectionState).toBe("waiting_configuration");

    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const discovered = (list.data.apps as Array<Record<string, unknown>>).find((a) => a.appId === "com.new.app");
    expect(discovered).toBeTruthy();
    expect(discovered?.configStatus).toBe("pending");
    expect(discovered?.archiveMode).toBe("manual");
    expect(discovered?.name).toBe("com.new.app"); // 未提供 appName 时显示 appId
    expect(discovered?.pendingSources).toBe(1); // 浏览器来源待确认

    // 幂等重放不产生第二条软件记录、也不重复扣费
    const replay = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ appId: "com.new.app", idempotencyKey: key }),
    );
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    const list2 = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    expect((list2.data.apps as Array<{ appId: string }>).filter((a) => a.appId === "com.new.app")).toHaveLength(1);
  });

  it("客户端上报的 appName 在管理员设置名称后不再覆盖", async () => {
    const h = await makeHarness();
    const first = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ appId: "com.named.app", appName: "客户端名称" }),
    );
    expect(first.status).toBe(201);
    let list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    let app = (list.data.apps as Array<Record<string, unknown>>).find((a) => a.appId === "com.named.app");
    expect(app?.name).toBe("客户端名称");
    expect(app?.nameSource).toBe("client");

    // 管理员保存名称后，客户端上报不再生效
    const appDetail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/apps/${app?.id}`, { cookie: h.cookie });
    await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${app?.id}`, {
      cookie: h.cookie,
      body: {
        expectedRuleVersion: appDetail.data.app?.ruleVersion ?? 0,
        name: "管理员名称",
        allowedOrigins: [],
      },
    });
    const second = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ appId: "com.named.app", appName: "客户端改名" }),
    );
    expect(second.status).toBe(201);
    list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    app = (list.data.apps as Array<Record<string, unknown>>).find((a) => a.appId === "com.named.app");
    expect(app?.name).toBe("管理员名称");
    expect(app?.nameSource).toBe("admin");
    expect(app?.configStatus).toBe("configured");
  });
});

describe("连接配置", () => {
  it("Kaneo/AI 密钥只写不回显（仅掩码状态），测试端点透传结果", async () => {
    const h = await makeHarness();
    const putKaneo = await jsonReq(h.feedbackApp.app, "PUT", "/api/admin/connection/kaneo", {
      cookie: h.cookie,
      body: { baseUrl: "http://kaneo.local:1337/api", apiKey: "sk-kaneo-secret-123" },
    });
    expect(putKaneo.status).toBe(200);
    const getKaneo = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/connection/kaneo", { cookie: h.cookie });
    expect(getKaneo.data.apiKeySet).toBe(true);
    expect(getKaneo.text).not.toContain("sk-kaneo-secret");

    const test = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/connection/kaneo/test", {
      cookie: h.cookie,
      body: { projectId: "proj-9" },
    });
    expect(test.status).toBe(200);
    expect(test.data.project.id).toBe("proj-9");
    expect(test.data.columns[0].slug).toBe("triage");

    const putAi = await jsonReq(h.feedbackApp.app, "PUT", "/api/admin/connection/ai", {
      cookie: h.cookie,
      body: { baseUrl: "https://api.openai.com/v1", model: "gpt-test", apiKey: "sk-ai-secret-456" },
    });
    expect(putAi.status).toBe(200);
    const getAi = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/connection/ai", { cookie: h.cookie });
    expect(getAi.data.model).toBe("gpt-test");
    expect(getAi.text).not.toContain("sk-ai-secret");
    const aiTest = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/connection/ai/test", {
      cookie: h.cookie,
      body: {},
    });
    expect(aiTest.status).toBe(200);
    expect(aiTest.data.ok).toBe(true);

    // apiKey 省略时保持原值
    const putAgain = await jsonReq(h.feedbackApp.app, "PUT", "/api/admin/connection/ai", {
      cookie: h.cookie,
      body: { baseUrl: "https://api.openai.com/v1", model: "gpt-new" },
    });
    expect(putAgain.status).toBe(200);
    const getAgain = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/connection/ai", { cookie: h.cookie });
    expect(getAgain.data.apiKeySet).toBe(true);
  });

  it("Kaneo 测试失败 → 502 ok:false reason", async () => {
    const kaneo = makeMockKaneo();
    kaneo.testError = "无法访问";
    const t = makeTestApp({ kaneo });
    const cookie = await loginAsAdmin(t);
    const r = await jsonReq(t.app, "POST", "/api/admin/connection/kaneo/test", {
      cookie,
      body: { projectId: "p" },
    });
    expect(r.status).toBe(502);
    expect(r.data.ok).toBe(false);
  });
});

describe("管理列表与鉴权边界", () => {
  it("Bearer client 令牌不能访问管理接口；Cookie 会话列表/详情可见", async () => {
    const h = await makeHarness();
    const viaBearer = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { bearer: h.bearer });
    expect(viaBearer.status).toBe(403);

    const submitted = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    expect(submitted.status).toBe(201);
    await h.feedbackApp.worker.idle();
    // 新契约：提交只完成 AI 整理（needs_info），远端归档需管理员显式授权后才入队。
    const detailId = submitted.data.feedbackId as string;
    const auth = await authorizeArchive(h, detailId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie });
    expect(list.data.items.length).toBe(1);
    expect(list.data.items[0].status).toBe("archived");
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${list.data.items[0].id}`, {
      cookie: h.cookie,
    });
    expect(detail.data.text).toContain("导出 CSV");
    expect(detail.data.processed.title).toBe("整理后的标题");

    const filtered = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?status=failed", {
      cookie: h.cookie,
    });
    expect(filtered.data.items.length).toBe(0);
  });

  it("分页 cursor 翻页", async () => {
    const h = await makeHarness();
    for (let i = 0; i < 3; i++) {
      await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: `第${i}条反馈内容` }));
    }
    await h.feedbackApp.worker.idle();
    const p1 = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?limit=2", { cookie: h.cookie });
    expect(p1.data.items.length).toBe(2);
    expect(p1.data.nextCursor).toBeTruthy();
    const p2 = await jsonReq(
      h.feedbackApp.app,
      "GET",
      `/api/admin/feedback?limit=2&cursor=${encodeURIComponent(p1.data.nextCursor)}`,
      { cookie: h.cookie },
    );
    expect(p2.data.items.length).toBe(1);
    const ids = new Set([...p1.data.items.map((x: any) => x.id), ...p2.data.items.map((x: any) => x.id)]);
    expect(ids.size).toBe(3);
  });
});
