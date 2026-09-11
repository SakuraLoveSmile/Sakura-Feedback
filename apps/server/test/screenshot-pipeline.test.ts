import { describe, expect, it } from "vitest";
import { getFeedback, getFeedbackScreenshot, getFeedbackScreenshotMeta } from "../src/db/repos.ts";
import { createTestPng, defaultSubmitBody, jsonReq, makeHarness, submitMultipartFeedback } from "./helpers.ts";

describe("图文反馈提交与图片处理", () => {
  it("multipart 提交：有效 PNG 截图入库并生成独立截图记录", async () => {
    const h = await makeHarness();
    const png = await createTestPng(200, 150);
    const metadata = {
      ...defaultSubmitBody(),
      capture: {
        viewportWidth: 1024,
        viewportHeight: 768,
        pixelWidth: 400,
        pixelHeight: 300,
        capturedAt: new Date().toISOString(),
        releasePoint: { x: 0.45, y: 0.65 },
      },
    };

    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, metadata, png);
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("received");
    const id = res.data.feedbackId;

    // 验证数据库事务原子性写入
    const fb = getFeedback(h.feedbackApp.db, id);
    expect(fb).not.toBeNull();
    expect(fb?.text).toBe(metadata.text);

    const shot = getFeedbackScreenshot(h.feedbackApp.db, id);
    expect(shot).not.toBeNull();
    expect(shot?.width).toBe(200);
    expect(shot?.height).toBe(150);
    expect(shot?.png_blob.byteLength).toBeGreaterThan(0);

    const meta = getFeedbackScreenshotMeta(h.feedbackApp.db, id);
    expect(meta?.capture?.releasePoint?.x).toBeCloseTo(0.45);
    expect(meta?.capture?.releasePoint?.y).toBeCloseTo(0.65);
    // 输出像素尺寸与逻辑视口并存持久化
    expect(meta?.capture?.pixelWidth).toBe(400);
    expect(meta?.capture?.pixelHeight).toBe(300);
    expect(meta?.capture?.viewportWidth).toBe(1024);
    expect(meta?.capture?.viewportHeight).toBe(768);

    // AI 提示输入同时拿到逻辑视口与输出像素
    await h.feedbackApp.worker.idle();
    expect(h.ai.lastImage?.outputPixels).toEqual({ width: 400, height: 300 });
    expect(h.ai.lastImage?.viewport).toEqual({ width: 1024, height: 768 });

    // 鉴权下载截图接口
    const dl = await h.feedbackApp.app.request(`/api/feedback/${id}/screenshot`, {
      headers: { authorization: `Bearer ${h.bearer}` },
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(dl.headers.get("cache-control")).toBe("no-store");
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    expect(dlBuf.byteLength).toBe(shot?.byte_size);
  });

  it("capture.pixelWidth/pixelHeight 非法值拒绝 400；缺省字段兼容旧客户端", async () => {
    const h = await makeHarness();
    const png = await createTestPng(100, 100);
    // 非整数 / 越界 / 类型错误 → 400
    for (const bad of [
      { pixelWidth: 0, pixelHeight: 100 },
      { pixelWidth: -5, pixelHeight: 100 },
      { pixelWidth: 1.5, pixelHeight: 100 },
      { pixelWidth: "800", pixelHeight: 100 },
      { pixelWidth: 70000, pixelHeight: 100 },
      { pixelWidth: 100 },
    ]) {
      const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ capture: bad }), png);
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("invalid_request");
    }
    // 完全缺省 pixel 字段（旧客户端）→ 正常入库且处理归档成功
    const ok = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ capture: { viewportWidth: 800, viewportHeight: 600 } }),
      png,
    );
    expect(ok.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const meta = getFeedbackScreenshotMeta(h.feedbackApp.db, ok.data.feedbackId);
    expect(meta?.capture?.pixelWidth).toBeUndefined();
    expect(meta?.capture?.pixelHeight).toBeUndefined();
    const fb = getFeedback(h.feedbackApp.db, ok.data.feedbackId);
    expect(fb?.status).toBe("archived");
  });

  it("输出像素定稿命名：pixelWidth/pixelHeight 接受并解析到 AI；output* 作废键按未知忽略", async () => {
    const h = await makeHarness();
    const png = await createTestPng(120, 90);

    // 定稿命名 → 接受、持久化、AI 解析到 outputPixels
    const ok = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ capture: { pixelWidth: 240, pixelHeight: 180 } }),
      png,
    );
    expect(ok.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const meta = getFeedbackScreenshotMeta(h.feedbackApp.db, ok.data.feedbackId);
    expect(meta?.capture?.pixelWidth).toBe(240);
    expect(meta?.capture?.pixelHeight).toBe(180);
    expect(h.ai.lastImage?.outputPixels).toEqual({ width: 240, height: 180 });

    // 半对（缺 pixelHeight）→ 400
    const half = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ capture: { pixelWidth: 240 } }),
      png,
    );
    expect(half.status).toBe(400);
    expect(half.data.error.code).toBe("invalid_request");

    // 已作废的 outputWidth/outputHeight：按未知字段忽略（不入 capture、不报错）
    const legacy = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ capture: { outputWidth: 240, outputHeight: 180 } }),
      png,
    );
    expect(legacy.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const legacyMeta = getFeedbackScreenshotMeta(h.feedbackApp.db, legacy.data.feedbackId);
    expect("outputWidth" in (legacyMeta?.capture ?? {})).toBe(false); // 作废键不入库
    expect(legacyMeta?.capture?.pixelWidth).toBeUndefined();
  });

  it("非法图片校验：伪造格式拒绝 400", async () => {
    const h = await makeHarness();
    const fake = Buffer.from("NOT_A_PNG_FILE_CONTENT");
    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), fake);
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_format");
  });

  it("尺寸超限校验：超过 2048px 拒绝 413", async () => {
    const h = await makeHarness();
    const large = await createTestPng(2050, 100);
    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), large);
    expect(res.status).toBe(413);
    expect(res.data.error.code).toBe("too_large");
  });

  it("体积极限校验：超过 6MiB 拒绝 413", async () => {
    const h = await makeHarness();
    // 超过 6MiB 的超大 Buffer
    const huge = Buffer.alloc(7 * 1024 * 1024, 0);
    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), huge);
    expect(res.status).toBe(413);
    expect(res.data.error.code).toBe("too_large");
  });

  it("幂等性：同内容同截图重放返回 200 replayed:true；不同截图冲突 409", async () => {
    const h = await makeHarness();
    const png1 = await createTestPng(100, 100);
    const key = `idemp-${Math.random().toString(36).slice(2)}`;
    const meta = defaultSubmitBody({ idempotencyKey: key });

    const r1 = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, png1);
    expect(r1.status).toBe(201);

    // 相同内容重放
    const r2 = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, png1);
    expect(r2.status).toBe(200);
    expect(r2.data.replayed).toBe(true);

    // 不同截图但相同 idempotencyKey
    const png2 = await createTestPng(120, 120);
    const r3 = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, png2);
    expect(r3.status).toBe(409);
    expect(r3.data.error.code).toBe("idempotency_conflict");
  });
});

describe("Kaneo 图文五步归档与阶段恢复", () => {
  it("完整流水线：任务创建 → 预签名申请 → 二进制上传 → Finalize → 评论挂载与核对", async () => {
    const h = await makeHarness();
    const png = await createTestPng(160, 120);
    const meta = {
      ...defaultSubmitBody(),
      capture: { releasePoint: { x: 0.5, y: 0.5 } },
    };

    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, png);
    expect(res.status).toBe(201);
    const id = res.data.feedbackId;

    await h.feedbackApp.worker.idle();

    // 验证状态
    const fb = getFeedback(h.feedbackApp.db, id);
    expect(fb?.status).toBe("archived");
    expect(fb?.archive_stage).toBe("complete");
    expect(fb?.kaneo_task_id).toBeTruthy();

    // 验证 Kaneo 创建了任务
    expect(h.kaneo.created.length).toBe(1);

    // 验证上传了图片至预签名地址
    expect(h.kaneo.uploads.length).toBe(1);

    // 验证创建了带图片的评论，且包含反馈ID与摘要
    expect(h.kaneo.comments.length).toBe(1);
    const comment = h.kaneo.comments[0]!;
    expect(comment.taskId).toBe(fb?.kaneo_task_id);
    expect(comment.content).toContain("![反馈截图]");
    expect(comment.content).toContain(`**反馈ID**：${id}`);
    expect(comment.content).toContain("160×120");

    // 管理端详情应能获取截图信息
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
    expect(detail.status).toBe(200);
    expect(detail.data.screenshot).not.toBeNull();
    expect(detail.data.screenshot.width).toBe(160);
    expect(detail.data.screenshot.height).toBe(120);

    // 管理端视觉连接测试接口
    const vTest = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/connection/ai/test-vision", {
      cookie: h.cookie,
    });
    expect(vTest.status).toBe(200);
    expect(vTest.data.ok).toBe(true);
  });
});
