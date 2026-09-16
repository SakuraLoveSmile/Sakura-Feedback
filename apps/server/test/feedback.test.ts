import { describe, expect, it } from "vitest";
import { authorizeArchive, defaultSubmitBody, jsonReq, makeHarness, submitFeedback } from "./helpers.ts";

describe("反馈提交", () => {
  it("未认证 401；未登记 appId 也能成功提交（自动发现软件）", async () => {
    const h = await makeHarness();
    const noAuth = await jsonReq(h.feedbackApp.app, "POST", "/api/feedback", {
      body: defaultSubmitBody(),
    });
    expect(noAuth.status).toBe(401);
    // T1：移除“应用必须存在、来源必须登记”的登录/提交前置条件。
    const unknown = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.nope" }));
    expect(unknown.status).toBe(201);
    expect(unknown.data.status).toBe("received");
    expect(unknown.data.collectionState).toBe("waiting_configuration");
  });

  it("输入校验：空文本/超长文本/非法 idempotencyKey", async () => {
    const h = await makeHarness();
    expect((await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "   " }))).status).toBe(400);
    const tooLong = "字".repeat(10_001); // 10001 码点（UTF-8 字节 < 64KB 会被拒？30003 字节仍小于 65536）
    const long = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: tooLong }));
    expect(long.status).toBe(413);
    const astral = "🙂".repeat(10_001); // 代理对按码点计
    const a = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: astral }));
    expect(a.status).toBe(413);
    expect((await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "" }))).status).toBe(400);
  });

  it("请求体超过 64KB → 413", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "a".repeat(70_000) }));
    expect(r.status).toBe(413);
  });

  it("重复提交：同 key 同内容幂等重放；同 key 不同内容 409", async () => {
    const h = await makeHarness();
    const body = defaultSubmitBody({ idempotencyKey: "stable-key" });
    const first = await submitFeedback(h.feedbackApp, h.bearer, body);
    expect(first.status).toBe(201);
    // 新契约：提交只做 AI 整理，归档需显式授权；这里先完成一次授权以得到唯一的远端任务。
    await h.feedbackApp.worker.idle();
    const auth = await authorizeArchive(h, first.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(1);
    // 同 key 重放：返回 replayed，不产生第二条流水线处理
    const replay = await submitFeedback(h.feedbackApp, h.bearer, body);
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.feedbackId).toBe(first.data.feedbackId);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(1);
    const conflict = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "stable-key", text: "不同的内容" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe("idempotency_conflict");
  });

  it("状态查询：仅认证后可见；未知 id 404", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const auth = await authorizeArchive(h, r.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, {
      bearer: h.bearer,
    });
    expect(q.status).toBe(200);
    expect(q.data.status).toBe("archived");
    expect(q.data.kaneoUrl).toContain("/task/task-1");
    const anon = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`);
    expect(anon.status).toBe(401);
    const nf = await jsonReq(h.feedbackApp.app, "GET", "/api/feedback/nope", { bearer: h.bearer });
    expect(nf.status).toBe(404);
  });

  it("上下文白名单：仅显式 appVersion/pageLabel 进入归档描述，其余字段忽略", async () => {
    const h = await makeHarness();
    const submitted = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        text: "深色模式下图表颜色对比不足",
        context: { appVersion: "2.0.0", pageLabel: "dashboard", url: "https://secret", logs: "leak" },
      }),
    );
    expect(submitted.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const auth = await authorizeArchive(h, submitted.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(1);
    const desc = h.kaneo.created[0]?.description;
    expect(desc).toContain("版本 2.0.0");
    expect(desc).toContain("页面 dashboard");
    expect(desc).not.toContain("secret");
    expect(desc).not.toContain("leak");
  });
});
