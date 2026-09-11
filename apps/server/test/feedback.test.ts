import { describe, expect, it } from "vitest";
import { defaultSubmitBody, jsonReq, makeHarness, submitFeedback } from "./helpers.ts";

describe("反馈提交", () => {
  it("未认证 401；未知 appId 404", async () => {
    const h = await makeHarness();
    const noAuth = await jsonReq(h.feedbackApp.app, "POST", "/api/feedback", {
      body: defaultSubmitBody(),
    });
    expect(noAuth.status).toBe(401);
    const unknown = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.nope" }));
    expect(unknown.status).toBe(404);
    expect(unknown.data.error.code).toBe("unknown_app");
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
    const replay = await submitFeedback(h.feedbackApp, h.bearer, body);
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.feedbackId).toBe(first.data.feedbackId);
    const conflict = await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "stable-key", text: "不同的内容" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe("idempotency_conflict");
    // 重放不产生第二条流水线处理
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(1);
  });

  it("状态查询：仅认证后可见；未知 id 404", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
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
    await submitFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        text: "深色模式下图表颜色对比不足",
        context: { appVersion: "2.0.0", pageLabel: "dashboard", url: "https://secret", logs: "leak" },
      }),
    );
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(1);
    const desc = h.kaneo.created[0]?.description;
    expect(desc).toContain("版本 2.0.0");
    expect(desc).toContain("页面 dashboard");
    expect(desc).not.toContain("secret");
    expect(desc).not.toContain("leak");
  });
});
