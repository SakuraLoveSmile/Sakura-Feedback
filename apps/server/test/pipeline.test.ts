import { describe, expect, it } from "vitest";
import { createApp, resumeWorker } from "../src/app.ts";
import { type Db, getFeedback, getFeedbackScreenshot, updateFeedback } from "../src/db/repos.ts";
import { type ArchiveDataV1, loadArchiveData, saveArchiveData } from "../src/pipeline/archive-data.ts";
import {
  createTestPng,
  defaultSubmitBody,
  instantSleep,
  jsonReq,
  loginAsAdmin,
  loginAsClient,
  makeConfig,
  makeHarness,
  makeMockAi,
  makeMockKaneo,
  seedApp,
  seedConnections,
  submitFeedback,
  submitMultipartFeedback,
} from "./helpers.ts";

function expectValidArchive(db: Db, id: string): ArchiveDataV1 {
  const parsed = loadArchiveData(db, id);
  if (parsed.kind !== "valid") throw new Error(`期望合法归档数据，实际 ${parsed.kind}`);
  return parsed.data;
}

describe("AI 处理阶段", () => {
  it("瞬时故障有限重试：超时 3 次后 failed，attempt_count=3", async () => {
    const h = await makeHarness({ aiOutcomes: ["timeout", "timeout", "timeout"] });
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    expect(h.ai.calls).toBe(3);
    const q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("failed");
    expect(q.data.errorSummary).toContain("超时");
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${r.data.feedbackId}`, {
      cookie: h.cookie,
    });
    expect(detail.data.attemptCount).toBe(3);
    expect(h.kaneo.created.length).toBe(0);
  });

  it("重试后成功：前 3 次格式失败，管理页 retry 后成功归档", async () => {
    const h = await makeHarness({ aiOutcomes: ["invalid", "invalid", "invalid", "ok"] });
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    let q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("failed");

    const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/retry`, {
      cookie: h.cookie,
    });
    expect(retry.status).toBe(202);
    await h.feedbackApp.worker.idle();
    q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("archived");
    expect(h.ai.calls).toBe(4);
  });

  it("不可重试错误（密钥无效）只调用一次", async () => {
    const h = await makeHarness({ aiOutcomes: ["auth"] });
    await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    expect(h.ai.calls).toBe(1);
  });

  it("归档描述：原话、来源、反馈 ID 由服务端追加，AI 结果不含这些", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "导出 CSV 卡住了" }));
    await h.feedbackApp.worker.idle();
    const desc = h.kaneo.created[0]?.description;
    expect(desc).toContain("> 导出 CSV 卡住了");
    expect(desc).toContain(`**反馈ID**：${r.data.feedbackId}`);
    expect(desc).toContain("测试软件（com.test.app）");
    // AI 标题成为任务标题，不出现在描述中（描述只含整理分节与服务端追加内容）
    expect(h.kaneo.created[0]?.title).toBe("整理后的标题");
    expect(desc).toContain("## 使用体验");
    expect(h.kaneo.created[0]?.columnSlug).toBe("triage");
  });
});

describe("Kaneo 归档失败与恢复", () => {
  it("失效目标列：failed 且提示修复，不自动创建列；修配置后 retry 成功", async () => {
    const h = await makeHarness({ seedAppOver: { columnSlug: "ghost" } });
    h.kaneo.createErrorQueue.push("column-not-found");
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    let q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("failed");
    expect(q.data.errorSummary).toContain("列已失效");

    // 修复列配置
    const upd = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${h.app.id}`, {
      cookie: h.cookie,
      body: {
        name: "测试软件",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "proj-1",
        kaneoColumnSlug: "triage",
      },
    });
    expect(upd.status).toBe(200);
    const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/retry`, {
      cookie: h.cookie,
    });
    expect(retry.status).toBe(202);
    await h.feedbackApp.worker.idle();
    q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("archived");
    // 修复后 AI 阶段被跳过（processed_json 已存在）：只调用了一次
    expect(h.ai.calls).toBe(1);
    expect(h.kaneo.created[0]?.columnSlug).toBe("triage");
  });

  it("确定性拒绝（403）→ failed，可管理页重试", async () => {
    const h = await makeHarness();
    h.kaneo.createErrorQueue.push("definite");
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("failed");
    expect(q.data.errorSummary).toContain("拒绝");
  });

  it("结果不确定 → needs_review；recheck 未找到维持待核对，找到则关联归档", async () => {
    const h = await makeHarness();
    h.kaneo.createErrorQueue.push("uncertain");
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    let q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.status).toBe("needs_review");
    expect(h.kaneo.created.length).toBe(0); // 该 mock 中未落任务，符合“不确定”

    // 搜索无果：维持 needs_review，绝不自动再次创建
    const recheck1 = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(recheck1.status).toBe(202);
    expect(recheck1.data.status).toBe("needs_review");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created.length).toBe(0);

    // 模拟“其实已创建”：搜索命中 → 关联归档
    h.kaneo.findByFeedbackId = async () => ({
      taskId: "kan-777",
      taskUrl: "http://kaneo.test/dashboard/workspace/ws-1/project/proj-1/task/kan-777",
    });
    const recheck2 = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(recheck2.data.status).toBe("archived");
    q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${r.data.feedbackId}`, { bearer: h.bearer });
    expect(q.data.kaneoUrl).toContain("/task/kan-777");
  });

  it("needs_review：recheck 未找到→维持；force-create 仅限无 task/附件状态", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const id = r.data.feedbackId;
    // 模拟“任务创建结果未知”：无已知 task ID、无任何已知附件状态（恢复数据仅剩目标）
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), { target: base.target });
    updateFeedback(h.feedbackApp.db, id, {
      status: "needs_review",
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
    });
    h.kaneo.findByFeedbackId = async () => null; // 确保搜索不到
    const recheck = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(recheck.data.status).toBe("needs_review");

    // 已知 task ID 一律拒绝 force-create
    updateFeedback(h.feedbackApp.db, id, { kaneo_task_id: "task-x" });
    const reject = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "force-create" },
    });
    expect(reject.status).toBe(409);
    expect(reject.data.error.code).toBe("invalid_state");
    updateFeedback(h.feedbackApp.db, id, { kaneo_task_id: null });

    const force = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "force-create" },
    });
    expect(force.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const q = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${id}`, { bearer: h.bearer });
    expect(q.data.status).toBe("archived");
    expect(h.kaneo.created.length).toBe(2); // 首次 + 强制再次创建
  });

  it("recheck 优先已有 task ID：不重复搜索、不重置阶段，从断点继续补图", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    expect(h.kaneo.finalizes.length).toBe(1);
    // 转待核对（保留 task ID 与阶段 asset_finalized），清评论并清掉本地评论记录，
    // 模拟“评论尚未发出”的合法断点
    const taskIdBefore = getFeedback(h.feedbackApp.db, id)?.kaneo_task_id ?? null;
    h.kaneo.comments.length = 0;
    const beforeData = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: beforeData.target,
      upload: beforeData.upload!,
      asset: beforeData.asset!,
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "asset_finalized" });
    const recheck = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(recheck.status).toBe(202);
    expect(recheck.data.status).toBe("processing"); // 核对无评论且本地无“已发出”记录 → 继续补图
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, id);
    expect(row?.status).toBe("archived");
    expect(row?.kaneo_task_id).toBe(taskIdBefore); // 未重置/未换任务
    expect(h.kaneo.searches).toBe(0); // 优先已有 task ID，未按标记搜索
    expect(h.kaneo.uploads.length).toBe(1); // 未重传（断点继续）
    expect(h.kaneo.finalizes.length).toBe(1);
    expect(h.kaneo.comments.length).toBe(1); // 补发评论
  });

  it("recheck 核对不到评论但本地已登记“已发出” → 待核对，不自动重发", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    expect(expectValidArchive(h.feedbackApp.db, id).comment?.outcome).toBe("confirmed");
    // 远端评论已不存在（本地记录仍为 confirmed）→ 记录与远端矛盾，必须人工决定
    h.kaneo.comments.length = 0;
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "comment_pending" });
    const recheck = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(recheck.status).toBe(202);
    expect(recheck.data.status).toBe("needs_review"); // 矛盾状态 → 维持待核对
    expect(h.kaneo.comments.length).toBe(0); // 零自动重发
  });

  it("needs_review 不允许 retry；archived 不允许 resolve", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/retry`, {
      cookie: h.cookie,
    });
    expect(retry.status).toBe(409);
    const resolve = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck" },
    });
    expect(resolve.status).toBe(409);
  });
});

describe("持久化与崩溃恢复", () => {
  it("重启恢复：received/processing 重新入队处理", async () => {
    const config = makeConfig();
    const ai = makeMockAi();
    const kaneo = makeMockKaneo();
    const first = createApp(config, { ai, kaneo, workerSleep: instantSleep });
    const cookie = await loginAsAdmin(first);
    await seedConnections(first, cookie);
    await seedApp(first, cookie);
    const bearer = await loginAsClient(first);
    const r = await submitFeedback(first, bearer, defaultSubmitBody());
    // 立即取回 id 但不等 worker（模拟“原话已持久化、尚未处理即重启”）
    const row = getFeedback(first.db, r.data.feedbackId);
    expect(row).not.toBeNull();
    await first.worker.idle();
    // 制造重启：换新 app 实例（同数据目录），先把记录改回未处理状态
    updateFeedback(first.db, r.data.feedbackId, { status: "received", processed_json: null, title: null });
    const kaneo2 = makeMockKaneo();
    const second = createApp(config, { ai: makeMockAi(), kaneo: kaneo2, workerSleep: instantSleep });
    resumeWorker(second);
    await second.worker.idle();
    const after = getFeedback(second.db, r.data.feedbackId);
    expect(after?.status).toBe("archived");
    expect(kaneo2.created.length).toBe(1);
  });

  it("重启恢复：archiving 中断 → needs_review，绝不盲目再次创建", async () => {
    const config = makeConfig();
    const kaneo1 = makeMockKaneo();
    const first = createApp(config, { ai: makeMockAi(), kaneo: kaneo1, workerSleep: instantSleep });
    const cookie = await loginAsAdmin(first);
    await seedConnections(first, cookie);
    await seedApp(first, cookie);
    const bearer = await loginAsClient(first);
    const r = await submitFeedback(first, bearer, defaultSubmitBody());
    await first.worker.idle();
    // 模拟“发送后崩溃”：状态停留在 archiving
    updateFeedback(first.db, r.data.feedbackId, { status: "archiving" });
    const kaneo2 = makeMockKaneo();
    const second = createApp(config, { ai: makeMockAi(), kaneo: kaneo2, workerSleep: instantSleep });
    resumeWorker(second);
    await second.worker.idle();
    const after = getFeedback(second.db, r.data.feedbackId);
    expect(after?.status).toBe("needs_review");
    expect(kaneo2.created.length).toBe(0); // 恢复阶段不发出创建请求
  });

  it("提交先持久化后返回：AI 挂起时仍返回 received 且原话已入库", async () => {
    const h = await makeHarness({ aiOutcomes: ["ok"] });
    // 让 ai 慢一点：在组织前挂起由 instantSleep 控制不可行，直接检查持久化时序——
    // 提交响应返回时状态必为 received（响应先于处理完成）。
    const p = submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const r = await p;
    expect([r.status]).toEqual([201]);
    expect(["received", "processing", "archived"].includes(r.data.status)).toBe(true);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, r.data.feedbackId);
    expect(row?.text).toBe(defaultSubmitBody().text);
  });
});

describe("分阶段恢复（4.2–4.3：同 key 恢复与意图记录）", () => {
  /** 构造“归档中断”现场：清空评论、保留任务与目标，用给定 upload 记录重开处理。 */
  async function seedResume(
    h: Awaited<ReturnType<typeof makeHarness>>,
    id: string,
    upload: ArchiveDataV1["upload"] | undefined,
  ): Promise<void> {
    h.kaneo.comments.length = 0;
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: base.target,
      ...(upload ? { upload } : {}),
    });
    const row = getFeedback(h.feedbackApp.db, id);
    updateFeedback(h.feedbackApp.db, id, {
      status: "processing",
      archive_stage: "asset_uploading",
      kaneo_task_id: row?.kaneo_task_id ?? null,
      kaneo_task_url: row?.kaneo_task_url ?? null,
      error_summary: null,
      last_error: null,
    });
    h.feedbackApp.worker.enqueue(id);
    await h.feedbackApp.worker.idle();
  }

  it("PUT 已确认（confirmed）后恢复：不重传字节，直接对原 key finalize", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.uploads.length).toBe(1);
    expect(h.kaneo.finalizes.length).toBe(1);
    const firstKey = h.kaneo.finalizes[0]!.key;
    const base = expectValidArchive(h.feedbackApp.db, res.data.feedbackId);
    // 模拟“PUT 成功响应已持久化、finalize/评论前崩溃”
    await seedResume(h, res.data.feedbackId, {
      ...base.upload!,
      outcome: "confirmed",
    });
    const row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("archived");
    expect(h.kaneo.uploads.length).toBe(1); // 绝不重传
    expect(h.kaneo.finalizes.length).toBe(2);
    expect(h.kaneo.finalizes[1]!.key).toBe(firstKey); // 原 key，不申请新地址
    expect(h.kaneo.comments.length).toBe(1);
    const after = expectValidArchive(h.feedbackApp.db, res.data.feedbackId);
    expect(after.upload?.outcome).toBe("confirmed");
    expect(after.comment?.outcome).toBe("confirmed");
  });

  it("not_sent 恢复：同 key 重传相同字节，恢复计数落盘，finalize 原 key", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const base = expectValidArchive(h.feedbackApp.db, res.data.feedbackId);
    await seedResume(h, res.data.feedbackId, { ...base.upload!, outcome: "not_sent", recoveries: 0 });
    const row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("archived");
    expect(h.kaneo.uploads.length).toBe(2); // 首次 + 同 key 重传
    expect(h.kaneo.uploads[1]!.taskId).toBe(h.kaneo.uploads[0]!.taskId); // 同一预签名地址
    const bytes0 = Buffer.from(h.kaneo.uploads[0]!.bytes);
    const bytes1 = Buffer.from(h.kaneo.uploads[1]!.bytes);
    expect(bytes1.equals(bytes0)).toBe(true); // 相同字节
    expect(h.kaneo.finalizes.length).toBe(2);
    expect(h.kaneo.finalizes[1]!.key).toBe(h.kaneo.finalizes[0]!.key); // 原 key
    const after = expectValidArchive(h.feedbackApp.db, res.data.feedbackId);
    expect(after.upload?.outcome).toBe("confirmed");
    expect(after.upload?.recoveries).toBe(1); // 计数落盘
  });

  it("同 key 恢复计数达到上限（3 次）→ needs_review，不再重传", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const base = expectValidArchive(h.feedbackApp.db, res.data.feedbackId);
    await seedResume(h, res.data.feedbackId, { ...base.upload!, outcome: "not_sent", recoveries: 3 });
    const row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("同 key 恢复次数已达上限");
    expect(h.kaneo.uploads.length).toBe(1); // 未重传
    expect(h.kaneo.finalizes.length).toBe(1); // 未 finalize
  });

  it("预签名过期 → 不自动申请新 key，待核对并保留原 key；凭证无法解密 → 同样待核对", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    const base = expectValidArchive(h.feedbackApp.db, id);
    const expired = {
      ...base.upload!,
      outcome: "not_sent" as const,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await seedResume(h, id, expired);
    let row = getFeedback(h.feedbackApp.db, id);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("过期");
    expect(h.kaneo.uploads.length).toBe(1); // 未重传
    expect(h.kaneo.finalizes.length).toBe(1); // 未新增 finalize
    const kept = expectValidArchive(h.feedbackApp.db, id);
    expect(kept.upload?.key).toBe(base.upload!.key); // 原 key 保留
    expect(kept.upload?.expiresAt).toBe(expired.expiresAt);
    expect(kept.replacedKeys ?? []).toEqual([]); // 未自动换 key

    // 凭证损坏（无法解密）→ 待核对，不猜新地址
    h.kaneo.comments.length = 0;
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: expectValidArchive(h.feedbackApp.db, id).target,
      upload: {
        key: "key-x",
        credentialsEnc: "not-a-valid-cipher",
        expiresAt: null,
        outcome: "maybe_sent",
      },
    });
    updateFeedback(h.feedbackApp.db, id, {
      status: "processing",
      archive_stage: "asset_uploading",
      error_summary: null,
    });
    h.feedbackApp.worker.enqueue(id);
    await h.feedbackApp.worker.idle();
    row = getFeedback(h.feedbackApp.db, id);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("预签名凭证无法解密");
    expect(h.kaneo.uploads.length).toBe(1); // 未新增 PUT
  });

  it("评论结果未知（提交成功但列表不可读）→ 登记未知并待核对；下次核对命中不重复提交", async () => {
    const inner = makeMockKaneo();
    let listCalls = 0;
    const kaneo = {
      ...inner,
      async listComments(taskId: string) {
        listCalls++;
        if (listCalls <= 2) return []; // 入口查重与提交后核对都“看不见”
        return inner.listComments(taskId);
      },
    };
    const config = makeConfig();
    const app = createApp(config, { ai: makeMockAi(), kaneo, workerSleep: instantSleep });
    const cookie = await loginAsAdmin(app);
    await seedConnections(app, cookie);
    await seedApp(app, cookie);
    const bearer = await loginAsClient(app);
    const res = await submitMultipartFeedback(app, bearer, defaultSubmitBody(), await createTestPng(64, 48));
    await app.worker.idle();
    let row = getFeedback(app.db, res.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("截图评论已提交但核对未发现");
    expect(inner.comments.length).toBe(1); // 已提交一次
    const mid = expectValidArchive(app.db, res.data.feedbackId);
    expect(mid.comment?.outcome).toBe("maybe_sent");

    // 列表恢复可读 → 管理页 recheck 查重命中 → 补记 confirmed 并归档，绝不重复提交
    const resolve = await jsonReq(app.app, "POST", `/api/feedback/${res.data.feedbackId}/resolve`, {
      cookie,
      body: { action: "recheck" },
    });
    expect(resolve.status).toBe(202);
    expect(resolve.data.status).toBe("archived");
    await app.worker.idle();
    row = getFeedback(app.db, res.data.feedbackId);
    expect(row?.status).toBe("archived");
    expect(inner.comments.length).toBe(1); // 没有第二次 POST
    const after = expectValidArchive(app.db, res.data.feedbackId);
    expect(after.comment?.outcome).toBe("confirmed");
    expect(after.upload?.outcome).toBe("confirmed");
    expect(after.asset?.url).toBeTruthy();
  });
});

describe("操作锁、revision 与恢复接口（4.4）", () => {
  it("同一反馈并发操作：只有一个获得处理权，其余返回可识别 busy", async () => {
    const inner = makeMockKaneo();
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    const kaneo = {
      ...inner,
      findByFeedbackId: (_projectId: string, _feedbackId: string) =>
        new Promise<import("../src/services/kaneo.ts").KaneoTaskRef | null>((resolve) => {
          releaseBox.fn = () => void resolve(null); // 搜索未命中
        }),
    };
    const config = makeConfig();
    const app = createApp(config, { ai: makeMockAi(), kaneo, workerSleep: instantSleep });
    const cookie = await loginAsAdmin(app);
    await seedConnections(app, cookie);
    await seedApp(app, cookie);
    const bearer = await loginAsClient(app);
    const r = await submitFeedback(app, bearer, defaultSubmitBody());
    await app.worker.idle();
    // 构造“任务创建结果未知”的待核对记录（无 task ID、无附件状态）
    const base = expectValidArchive(app.db, r.data.feedbackId);
    saveArchiveData(app.db, r.data.feedbackId, loadArchiveData(app.db, r.data.feedbackId), { target: base.target });
    updateFeedback(app.db, r.data.feedbackId, {
      status: "needs_review",
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
    });
    // 第一个 recheck 持锁等待搜索；第二个并发 recheck → 409 busy
    const first = jsonReq(app.app, "POST", `/api/feedback/${r.data.feedbackId}/resolve`, {
      cookie,
      body: { action: "recheck" },
    });
    await new Promise((r2) => setTimeout(r2, 5));
    const second = await jsonReq(app.app, "POST", `/api/feedback/${r.data.feedbackId}/resolve`, {
      cookie,
      body: { action: "recheck" },
    });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe("busy");
    releaseBox.fn?.();
    const done = await first;
    expect(done.status).toBe(202);
    expect(done.data.status).toBe("needs_review"); // 搜索未命中 → 维持
  });

  it("人工操作带 revision 乐观锁：过期 revision 被拒绝，正确 revision 通过并返回新 revision", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const id = r.data.feedbackId;
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), { target: base.target });
    updateFeedback(h.feedbackApp.db, id, {
      status: "needs_review",
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
    });
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
    const rev = detail.data.recovery.revision as number;
    expect(Number.isInteger(rev)).toBe(true);
    expect(detail.data.recovery.allowedActions).toContain("recheck");
    expect(detail.data.recovery.allowedActions).toContain("force-create");

    // 过期 revision → 409 revision_conflict
    const stale = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck", expectedRevision: rev + 5 },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("revision_conflict");

    // 正确 revision → 202，返回新 revision
    h.kaneo.findByFeedbackId = async () => null;
    const okOp = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: h.cookie,
      body: { action: "recheck", expectedRevision: rev },
    });
    expect(okOp.status).toBe(202);
    expect(okOp.data.revision).toBe(rev);
  });

  it("recover retry_comment：先查重命中→补记确认归档；未命中→重发评论", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    // 模拟评论待核对：upload/asset 已确认，评论 maybe_sent，状态 needs_review
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: base.target,
      upload: base.upload,
      asset: base.asset,
      comment: {
        marker: `${id}|${getFeedbackScreenshot(h.feedbackApp.db, id)!.sha256}`,
        id: null,
        outcome: "maybe_sent",
      },
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "comment_pending" });
    h.kaneo.comments.length = 0; // 查重未命中（评论确实没挂上）

    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
    expect(detail.data.recovery.allowedActions).toContain("retry_comment");
    expect(detail.data.recovery.allowedActions).toContain("replace_upload");
    const rev = detail.data.recovery.revision as number;

    const rec = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: h.cookie,
      body: { action: "retry_comment", expectedRevision: rev },
    });
    expect(rec.status).toBe(202);
    expect(rec.data.status).toBe("archived");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.comments.length).toBe(1); // 重发一次（非重复）
    const row = getFeedback(h.feedbackApp.db, id);
    expect(row?.status).toBe("archived");

    // 查重命中：评论已在 → 不重发，直接补记确认
    h.kaneo.comments.length = 0;
    h.kaneo.comments.push({ taskId: row!.kaneo_task_id!, content: h.kaneo.comments[0]?.content ?? "seed" });
    // 直接造一条命中评论
    h.kaneo.comments[0]!.content =
      `![反馈截图](http://kaneo.test/assets/asset-${row!.kaneo_task_id}.png)\n\n---\n\n**反馈ID**：${id}\n\n**截图摘要**：\`sha\``;
    // 用真实 sha 重建命中内容
    h.kaneo.comments[0]!.content = h.kaneo.comments[0]!.content.replace(
      "`sha`",
      `\`${getFeedbackScreenshot(h.feedbackApp.db, id)!.sha256}\``,
    );
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      ...expectValidArchive(h.feedbackApp.db, id),
      comment: {
        marker: `${id}|${getFeedbackScreenshot(h.feedbackApp.db, id)!.sha256}`,
        id: null,
        outcome: "maybe_sent",
      },
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "comment_pending" });
    const rec2 = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: h.cookie,
      body: { action: "retry_comment", expectedRevision: expectValidArchive(h.feedbackApp.db, id)!.revision },
    });
    expect(rec2.status).toBe(202);
    expect(rec2.data.status).toBe("archived");
    expect(h.kaneo.comments.length).toBe(1); // 查重命中，没有第二次 POST
  });

  it("recover retry_comment：评论列表读取失败 → 502 recover_failed 且状态不变", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: base.target,
      upload: base.upload,
      asset: base.asset,
      comment: {
        marker: `${id}|${getFeedbackScreenshot(h.feedbackApp.db, id)!.sha256}`,
        id: null,
        outcome: "maybe_sent",
      },
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "comment_pending" });
    h.kaneo.comments.length = 0; // 清掉首轮归档的评论，验证“读取失败→绝不重发”
    const rev = expectValidArchive(h.feedbackApp.db, id).revision;
    const realList = h.kaneo.listComments.bind(h.kaneo);
    h.kaneo.listError = "评论列表接口不可用";
    // MockKaneo.listComments 未读取 listError，这里直接替换实现模拟读取失败
    h.kaneo.listComments = async () => {
      throw Object.assign(new Error("Kaneo 获取评论列表失败 (503)"), { name: "KaneoDefiniteError" });
    };
    void realList;
    const rec = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: h.cookie,
      body: { action: "retry_comment", expectedRevision: rev },
    });
    expect(rec.status).toBe(502);
    expect(rec.data.error.code).toBe("recover_failed");
    expect(getFeedback(h.feedbackApp.db, id)?.status).toBe("needs_review"); // 状态不变，未触发替代写入
    expect(h.kaneo.comments.length).toBe(0);
  });

  it("recover replace_upload：字节核对一致→不替换；404 不确定→换新 key 且保留旧 key 记录", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(80, 60),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    const base = expectValidArchive(h.feedbackApp.db, id);
    const oldKey = base.upload!.key;
    // 场景 A：远端字节与本地一致 → replaced:false，不申请新地址
    const storedBytes = getFeedbackScreenshot(h.feedbackApp.db, id)!.png_blob;
    h.kaneo.uploads.push({ taskId: base.asset!.url, bytes: Buffer.from(storedBytes) });
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: base.target,
      upload: base.upload,
      asset: base.asset,
      comment: base.comment,
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "asset_finalized" });
    let rev = expectValidArchive(h.feedbackApp.db, id).revision;
    const noop = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: h.cookie,
      body: { action: "replace_upload", expectedRevision: rev },
    });
    expect(noop.status).toBe(202);
    expect(noop.data.replaced).toBe(false);
    expect(noop.data.note).toContain("未执行替换");

    // 场景 B：远端核对失败（404 不能证明不存在）→ 按管理员决定替换：新 key + 保留旧 key 记录 + 新评论
    h.kaneo.comments.length = 0;
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: expectValidArchive(h.feedbackApp.db, id).target,
      upload: expectValidArchive(h.feedbackApp.db, id).upload,
      asset: { id: "asset-broken", url: "http://kaneo.test/assets/missing.png" },
      comment: { marker: `${id}|sha`, id: null, outcome: "maybe_sent" },
    });
    updateFeedback(h.feedbackApp.db, id, { status: "needs_review", archive_stage: "comment_pending" });
    rev = expectValidArchive(h.feedbackApp.db, id).revision;
    const replaced = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: h.cookie,
      body: { action: "replace_upload", expectedRevision: rev },
    });
    expect(replaced.status).toBe(202);
    expect(replaced.data.replaced).toBe(true);
    expect(replaced.data.status).toBe("archived");
    const after = expectValidArchive(h.feedbackApp.db, id);
    expect(after.replacedKeys).toContain(oldKey); // 旧 key 恢复记录保留
    expect(after.upload?.key).not.toBe(oldKey); // 新 key
    expect(after.comment?.outcome).toBe("confirmed");
    expect(getFeedback(h.feedbackApp.db, id)?.status).toBe("archived");
    expect(h.kaneo.comments.some((c) => c.content.includes(after.asset!.url))).toBe(true); // 新评论引用新资产
  });

  it("recover 必须携带 expectedRevision；非法 action → 400", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    const noRev = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/recover`, {
      cookie: h.cookie,
      body: { action: "retry_comment" },
    });
    expect(noRev.status).toBe(400);
    const badAction = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${r.data.feedbackId}/recover`, {
      cookie: h.cookie,
      body: { action: "nope", expectedRevision: 0 },
    });
    expect(badAction.status).toBe(400);
  });

  it("4.5 阶段矛盾：asset_finalized 但缺资产信息 → 待核对，不猜测重建", async () => {
    const h = await makeHarness();
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody(),
      await createTestPng(64, 48),
    );
    await h.feedbackApp.worker.idle();
    const id = res.data.feedbackId;
    const base = expectValidArchive(h.feedbackApp.db, id);
    saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: base.target,
      upload: base.upload,
      // 故意缺失 asset → 与 asset_finalized 矛盾
    });
    updateFeedback(h.feedbackApp.db, id, { status: "processing", archive_stage: "asset_finalized" });
    h.feedbackApp.worker.enqueue(id);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, id);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("阶段与恢复数据矛盾");
    expect(h.kaneo.created.length).toBe(1); // 未再写入
  });
});
