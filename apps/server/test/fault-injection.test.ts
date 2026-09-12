import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getFeedback, getFeedbackScreenshot, updateFeedback } from "../src/db/repos.ts";
import {
  type ArchiveData,
  type ArchiveUpload,
  loadArchiveData,
  saveArchiveData,
} from "../src/pipeline/archive-data.ts";
import { KaneoUncertainError } from "../src/services/kaneo.ts";
import {
  createTestPng,
  defaultSubmitBody,
  instantSleep,
  jsonReq,
  loginAsAdmin,
  loginAsClient,
  type MockKaneo,
  makeConfig,
  makeMockAi,
  makeMockKaneo,
  seedApp,
  seedConnections,
  submitFeedback,
  submitMultipartFeedback,
} from "./helpers.ts";

/**
 * 归档中断故障注入回归（计划 5.1 / 任务 t10）。
 *
 * 隔离方式：每个用例使用独立临时数据库目录（makeConfig → mkdtemp）；
 * HTTP 通过进程内 Hono app.request 直连（不绑定任何端口，端口隔离天然成立）。
 * 每个用例断言：远端调用次数、上传 key、任务 ID、评论数量/内容。
 */

interface Rig {
  app: ReturnType<typeof createApp> & { config: typeof configPlaceholder };
  inner: MockKaneo;
  cookie: string;
  bearer: string;
}
const configPlaceholder = null as unknown as { dataDir: string };

async function buildRig(wrap?: (inner: MockKaneo) => MockKaneo | object): Promise<Rig> {
  const config = makeConfig();
  const inner = makeMockKaneo();
  const kaneo = wrap ? (wrap(inner) as MockKaneo) : inner;
  const app = createApp(config, { ai: makeMockAi(), kaneo, workerSleep: instantSleep });
  const cookie = await loginAsAdmin(app);
  await seedConnections(app, cookie);
  await seedApp(app, cookie);
  const bearer = await loginAsClient(app);
  return { app: app as unknown as Rig["app"], inner, cookie, bearer };
}

function validArchive(rig: Rig, id: string): ArchiveData {
  const parsed = loadArchiveData(rig.app.db, id);
  if (parsed.kind !== "valid") throw new Error(`期望合法归档数据，实际 ${parsed.kind}`);
  return parsed.data;
}

async function submitScreenshot(rig: Rig, size = 80): Promise<{ id: string; png: Buffer }> {
  const png = await createTestPng(size, size);
  const res = await submitMultipartFeedback(rig.app, bearerOf(rig), defaultSubmitBody(), png);
  expect(res.status).toBe(201);
  await rig.app.worker.idle();
  return { id: res.data.feedbackId, png };
}

function bearerOf(rig: Rig): string {
  return rig.bearer;
}

describe("故障注入：预签名/上传阶段中断", () => {
  it("presign 返回后、本地落盘前中断 → 零字节传输；恢复后复用任务 ID、重新申请地址并完成", async () => {
    const rig = await buildRig((inner) => ({
      ...inner,
      createImageUpload(taskId: string, input: Parameters<MockKaneo["createImageUpload"]>[1]) {
        rig.app.db.close(); // 拿到地址后、落盘前数据库不可写
        return inner.createImageUpload(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(rig.inner.created.length).toBe(1);
    expect(rig.inner.uploads.length).toBe(0);
    expect(rig.inner.finalizes.length).toBe(0);
    expect(rig.inner.comments.length).toBe(0);
    const taskIdFirst = "task-1";

    // 重启恢复：新 app 实例（同一数据目录）→ 处理中断记录
    const inner2 = makeMockKaneo();
    const config2 = makeConfig();
    config2.dataDir = (rig.app as unknown as { config: { dataDir: string } }).config.dataDir;
    const app2 = createApp(config2, { ai: makeMockAi(), kaneo: inner2, workerSleep: instantSleep });
    const shot = getFeedbackScreenshot(app2.db, id)!;
    updateFeedback(app2.db, id, { status: "processing", error_summary: null, last_error: null });
    app2.worker.enqueue(id);
    await app2.worker.idle();
    const row = getFeedback(app2.db, id);
    expect(row?.status).toBe("archived");
    expect(row?.kaneo_task_id).toBe(taskIdFirst); // 任务 ID 复用，绝不重建
    expect(inner2.created.length).toBe(0); // 恢复轮零任务创建
    expect(inner2.uploads.length).toBe(1); // 重新申请地址后单次上传
    expect(inner2.finalizes.length).toBe(1);
    expect(inner2.finalizes[0]!.key).toBe(`key-${taskIdFirst}`); // 原 key（首个序号）
    expect(inner2.comments.length).toBe(1);
    expect(inner2.comments[0]!.content).toContain(shot.sha256);
    void shot;
  });

  it("PUT 成功响应丢失（结果不确定）→ maybe_sent；恢复向同一 key 重传相同字节", async () => {
    let putCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async uploadImageToPresigned(url: string, headers: Record<string, string>, bytes: Uint8Array) {
        putCalls++;
        if (putCalls === 1) throw new KaneoUncertainError("存储连接中断，PUT 结果未知");
        return inner.uploadImageToPresigned(url, headers, bytes);
      },
    }));
    const { id, png } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    let state = validArchive(rig, id);
    expect(state.upload?.outcome).toBe("maybe_sent");
    expect(state.upload?.key).toBe("key-task-1");

    // 恢复：同 key 重传
    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(putCalls).toBe(2); // 首次未知 + 同 key 重传一次
    expect(rig.inner.uploads.length).toBe(1); // 仅第二次真正落库
    expect(rig.inner.uploads[0]!.taskId).toBe("http://kaneo.test/upload/task-1");
    state = validArchive(rig, id);
    expect(state.upload?.outcome).toBe("confirmed");
    expect(state.upload?.recoveries).toBe(1);
    expect(state.upload?.key).toBe("key-task-1"); // 原 key
    expect(rig.inner.finalizes.length).toBe(1);
    expect(rig.inner.finalizes[0]!.key).toBe("key-task-1");
    expect(rig.inner.comments.length).toBe(1);
    void png;
  });

  it("finalize 5xx（登记结果不确定）→ 不再远端写入；恢复时对原 key finalize 且不重传", async () => {
    let finalizeCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async finalizeImageUpload(taskId: string, input: Parameters<MockKaneo["finalizeImageUpload"]>[1]) {
        finalizeCalls++;
        if (finalizeCalls === 1) throw new KaneoUncertainError("Kaneo 返回 502，登记结果不确定");
        return inner.finalizeImageUpload(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    const state = validArchive(rig, id);
    expect(state.upload?.outcome).toBe("confirmed"); // PUT 已确认并持久化
    expect(rig.inner.uploads.length).toBe(1);

    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(rig.inner.uploads.length).toBe(1); // 绝不重传
    expect(finalizeCalls).toBe(2); // 首次 5xx + 恢复成功
    expect(rig.inner.finalizes.length).toBe(1); // 失败那次未登记
    expect(rig.inner.finalizes[0]!.key).toBe("key-task-1"); // 原 key
    expect(rig.inner.comments.length).toBe(1);
  });

  it("finalize 4xx（明确拒绝）→ failed 保留恢复状态；retry 后原 key finalize 成功", async () => {
    let finalizeCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async finalizeImageUpload(taskId: string, input: Parameters<MockKaneo["finalizeImageUpload"]>[1]) {
        finalizeCalls++;
        if (finalizeCalls === 1) throw Object.assign(new Error("Kaneo 登记图片资产失败 (404)"), { name: "Error" });
        return inner.finalizeImageUpload(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("failed");
    const state = validArchive(rig, id);
    expect(state.upload?.outcome).toBe("confirmed"); // 恢复状态未被清除
    const retry = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/retry`, { cookie: rig.cookie });
    expect(retry.status).toBe(202);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(rig.inner.uploads.length).toBe(1); // 不重传
    expect(finalizeCalls).toBe(2);
    expect(rig.inner.finalizes.length).toBe(1);
    expect(rig.inner.finalizes[0]!.key).toBe("key-task-1"); // 原 key
    expect(rig.inner.comments.length).toBe(1);
  });
});

describe("故障注入：评论阶段中断与列表不可读", () => {
  it("评论 POST 网络中断（结果不确定）→ 发出前已登记 maybe_sent；自动路径不重发，显式 retry_comment 才发送一次", async () => {
    let commentCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async createComment(taskId: string, input: { content: string }) {
        commentCalls++;
        if (commentCalls === 1) throw new KaneoUncertainError("评论连接中断，结果不确定");
        return inner.createComment(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    const state = validArchive(rig, id);
    // P1：意图在请求发出**之前**落盘 → 结果未知记为 maybe_sent，绝不降级为 not_sent
    expect(state.comment?.outcome).toBe("maybe_sent");
    expect(rig.inner.comments.length).toBe(0);

    // 自动恢复：即使查重未命中，也不得自动重发
    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(getFeedback(rig.app.db, id)?.error_summary).toContain("结果未知");
    expect(commentCalls).toBe(1);
    expect(rig.inner.comments.length).toBe(0);

    // 显式 retry_comment（先查重，未命中 → 允许一次发送）
    const recover = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "retry_comment", expectedRevision: validArchive(rig, id).revision },
    });
    expect(recover.status).toBe(202);
    expect(recover.data.status).toBe("archived");
    expect(commentCalls).toBe(2);
    expect(rig.inner.comments.length).toBe(1); // 恰好一条，无重复
    expect(rig.inner.comments[0]!.content).toContain(`**反馈ID**：${id}`);
    expect(rig.inner.finalizes.length).toBe(1); // 上传/finalize 未重复
    expect(rig.inner.uploads.length).toBe(1);
  });

  it("评论提交成功但列表不可读（maybe_sent）→ 恢复查重命中，绝不重复提交", async () => {
    let listCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async listComments(taskId: string) {
        listCalls++;
        // 入口查重与提交后核对都“看不见”，之后恢复可读
        return listCalls <= 2 ? [] : inner.listComments(taskId);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(validArchive(rig, id).comment?.outcome).toBe("maybe_sent");
    const commentsAfterPost = rig.inner.comments.length;
    expect(commentsAfterPost).toBe(1);

    // 列表恢复可读：管理页 recheck → 查重命中 → 归档
    const resolve = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: rig.cookie,
      body: { action: "recheck" },
    });
    expect(resolve.status).toBe(202);
    expect(resolve.data.status).toBe("archived");
    expect(rig.inner.comments.length).toBe(commentsAfterPost); // 无第二次 POST
    expect(validArchive(rig, id).comment?.outcome).toBe("confirmed");
    // F1 集成断言：恢复后 comment.id 记录的是远端真实评论 id（mock listComments 命名 comm-N）
    expect(validArchive(rig, id).comment?.id).toBe("comm-0");
  });

  it("多条匹配评论（多候选）→ 仍视为已挂载，绝不重复提交", async () => {
    const rig = await buildRig();
    const { id, png } = await submitScreenshot(rig);
    // 制造重复评论（同资产引用，均命中反馈 ID + 摘要）
    const sha = getFeedbackScreenshot(rig.app.db, id)!.sha256;
    const assetUrl = validArchive(rig, id).asset!.url;
    rig.inner.comments.push({
      taskId: "task-1",
      content: `![反馈截图](${assetUrl})\n\n---\n\n**反馈ID**：${id}\n\n**截图摘要**：\`${sha}\``,
    });
    // 重开归档流程（清 asset/comment 但保留上传记录）：入口查重应命中（多候选 ≥1 即存在）
    const base = validArchive(rig, id);
    saveArchiveData(rig.app.db, id, loadArchiveData(rig.app.db, id), { target: base.target, upload: base.upload });
    updateFeedback(rig.app.db, id, {
      status: "processing",
      archive_stage: "asset_uploading",
      error_summary: null,
      last_error: null,
    });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(rig.inner.comments.length).toBe(2); // 不新增评论
    expect(validArchive(rig, id).comment?.outcome).toBe("confirmed");
    void png;
  });
});

describe("故障注入：签名到期与凭证", () => {
  it("未知到期（expiresAt 未知）→ 允许同 key 重传；主密钥无法解密 → 待核对不猜新地址", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const base = validArchive(rig, id);
    // mock 预签名 URL 无签名参数 → expiresAt 应为 null（未知）
    expect(base.upload?.expiresAt).toBeNull();

    // not_sent + 未知到期 → 恢复仍允许同 key 重传
    resetToUploadResume(rig, id, { ...base.upload!, outcome: "not_sent", recoveries: 0 });
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(rig.inner.uploads.length).toBe(2);
    expect(rig.inner.uploads[1]!.taskId).toBe(rig.inner.uploads[0]!.taskId); // 同 key
    expect(rig.inner.finalizes.length).toBe(2);
    expect(rig.inner.finalizes[1]!.key).toBe(rig.inner.finalizes[0]!.key);

    // 主密钥无法解密：注入非法密文 → 待核对，零远端写入
    resetToUploadResume(rig, id, {
      key: "key-x",
      credentialsEnc: "not-a-cipher",
      expiresAt: null,
      outcome: "maybe_sent",
    });
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(rig.inner.uploads.length).toBe(2); // 未新增 PUT
    expect(rig.inner.finalizes.length).toBe(2);
  });

  it("签名过期 → 绝不自动申请新 key：转待核对、保留原 key，仅 replace_upload 可替换", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const base = validArchive(rig, id);
    resetToUploadResume(rig, id, {
      ...base.upload!,
      outcome: "not_sent",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await rig.app.worker.idle();
    const row = getFeedback(rig.app.db, id);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("过期");
    expect(rig.inner.uploads.length).toBe(1); // 未重传
    expect(rig.inner.finalizes.length).toBe(1); // 未新增 finalize
    const kept = validArchive(rig, id);
    expect(kept.upload?.key).toBe(base.upload!.key); // 原 key 保留
    expect(kept.replacedKeys ?? []).toEqual([]); // 未自动换 key

    // 管理页只把 replace_upload 作为替换入口
    const detail = await jsonReq(rig.app.app, "GET", `/api/admin/feedback/${id}`, { cookie: rig.cookie });
    expect(detail.data.recovery.allowedActions).toContain("replace_upload");

    // 显式 replace_upload：复用原任务、申请新 key、保留旧 key 记录并归档
    const replaced = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "replace_upload", expectedRevision: kept.revision },
    });
    expect(replaced.status).toBe(202);
    expect(replaced.data.replaced).toBe(true);
    const after = validArchive(rig, id);
    expect(after.replacedKeys).toContain(base.upload!.key);
    expect(after.upload?.key).not.toBe(base.upload!.key);
    expect(getFeedback(rig.app.db, id)?.kaneo_task_id).toBe(row?.kaneo_task_id); // 任务未变
  });
});

describe("故障注入：归档中目标改变与数据异常", () => {
  it("恢复前修改项目映射 → 目标改变待核对且零远端写入；改回后成功", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    // 模拟恢复：清评论、保留任务，重开流程
    hReset(rig, id);
    // 归档中（恢复时）修改项目映射
    const apps = (await jsonReq(rig.app.app, "GET", "/api/admin/apps", { cookie: rig.cookie })).data.apps as Array<{
      id: string;
    }>;
    const change = await jsonReq(rig.app.app, "PUT", `/api/admin/apps/${apps[0]!.id}`, {
      cookie: rig.cookie,
      body: {
        name: "测试软件",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "proj-2",
        kaneoColumnSlug: "triage",
      },
    });
    expect(change.status).toBe(200);
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(getFeedback(rig.app.db, id)?.error_summary).toContain("归档恢复目标已改变（projectId）");
    expect(rig.inner.created.length).toBe(1); // 零远端写入
    expect(rig.inner.uploads.length).toBe(1);

    // 改回原项目 → 恢复成功
    const revert = await jsonReq(rig.app.app, "PUT", `/api/admin/apps/${apps[0]!.id}`, {
      cookie: rig.cookie,
      body: {
        name: "测试软件",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "proj-1",
        kaneoColumnSlug: "triage",
      },
    });
    expect(revert.status).toBe(200);
    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(rig.inner.created.length).toBe(1); // 仍未重建任务
  });

  it("旧格式资产字节不匹配 → 待核对且不改写；下载 404 同样待核对", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const stored = getFeedbackScreenshot(rig.app.db, id)!.png_blob;
    // 字节不匹配：旧资产链接指向不同字节
    rig.inner.uploads.push({ taskId: "http://kaneo.test/assets/wrong.png", bytes: Buffer.from([1, 2, 3]) });
    updateFeedback(rig.app.db, id, {
      status: "processing",
      archive_stage: "asset_finalized",
      archive_data_json: JSON.stringify({ assetUrl: "http://kaneo.test/assets/wrong.png" }),
    });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(loadArchiveData(rig.app.db, id).kind).toBe("legacy"); // 未改写

    // 下载 404：不能证明文件不存在，同样待核对
    updateFeedback(rig.app.db, id, {
      status: "processing",
      archive_stage: "asset_finalized",
      archive_data_json: JSON.stringify({ assetUrl: "http://kaneo.test/assets/ghost.png" }),
    });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(rig.inner.comments.length).toBe(1); // 未追加评论
    void stored;
  });
});

/** 将记录重置为“带指定 upload 记录的恢复起点”（清评论、保留任务）。 */
function resetToUploadResume(rig: Rig, id: string, upload: ArchiveUpload): void {
  rig.inner.comments.length = 0;
  const base = validArchive(rig, id);
  saveArchiveData(rig.app.db, id, loadArchiveData(rig.app.db, id), {
    target: base.target,
    upload,
  });
  updateFeedback(rig.app.db, id, {
    status: "processing",
    archive_stage: "asset_uploading",
    error_summary: null,
    last_error: null,
  });
  rig.app.worker.enqueue(id);
}

/** 将已归档记录重置为“任务已创建、资产缺失”的恢复起点（清评论）。 */
function hReset(rig: Rig, id: string): void {
  rig.inner.comments.length = 0;
  const base = validArchive(rig, id);
  saveArchiveData(rig.app.db, id, loadArchiveData(rig.app.db, id), {
    target: base.target,
    upload: base.upload,
  });
  updateFeedback(rig.app.db, id, {
    status: "processing",
    archive_stage: "asset_uploading",
    error_summary: null,
    last_error: null,
  });
}

describe("故障注入：错误评论响应与并发人工操作", () => {
  it("评论 2xx 但响应不可解析（错误评论响应）→ 发出前即登记 maybe_sent；自动路径不重发", async () => {
    let commentCalls = 0;
    const rig = await buildRig((inner) => ({
      ...inner,
      async createComment(taskId: string, input: { content: string }) {
        commentCalls++;
        if (commentCalls === 1) {
          // 2xx 但响应体不可解析（客户端契约测试已覆盖分类，这里注入同等故障）
          throw new KaneoUncertainError("Kaneo 评论响应不可解析，评论结果不确定");
        }
        return inner.createComment(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    // 意图先落盘且未被误标成功
    expect(validArchive(rig, id).comment?.outcome).toBe("maybe_sent");

    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    // 结果未知 → 自动路径不得重发
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(commentCalls).toBe(1);
    expect(rig.inner.comments.length).toBe(0);

    // 显式 retry_comment 才重发一次，并确认归档
    const recover = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "retry_comment", expectedRevision: validArchive(rig, id).revision },
    });
    expect(recover.status).toBe(202);
    expect(commentCalls).toBe(2);
    expect(rig.inner.comments.length).toBe(1); // 无重复
    expect(validArchive(rig, id).comment?.outcome).toBe("confirmed");
  });

  it("并发强制恢复/重试：锁占用 → 409 busy；空闲后过期 revision → 409 revision_conflict", async () => {
    const inner = makeMockKaneo();
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    const kaneo = {
      ...inner,
      findByFeedbackId: () =>
        new Promise<null>((resolve) => {
          releaseBox.fn = () => void resolve(null); // 搜索挂起，持锁
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
    const id = r.data.feedbackId;
    // 构造“任务创建结果未知”的待核对记录（无 task ID、无附件状态）
    const parsed = loadArchiveData(app.db, id);
    if (parsed.kind !== "valid") throw new Error("期望合法归档数据");
    saveArchiveData(app.db, id, loadArchiveData(app.db, id), { target: parsed.data.target });
    updateFeedback(app.db, id, {
      status: "needs_review",
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
    });

    // recheck 持锁挂起：并发 force-create 与 retry → 均为 409 busy
    const first = jsonReq(app.app, "POST", `/api/feedback/${id}/resolve`, { cookie, body: { action: "recheck" } });
    await new Promise((r2) => setTimeout(r2, 5));
    const forceWhileBusy = await jsonReq(app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie,
      body: { action: "force-create", expectedRevision: 1 },
    });
    expect(forceWhileBusy.status).toBe(409);
    expect(forceWhileBusy.data.error.code).toBe("busy");
    const retryWhileBusy = await jsonReq(app.app, "POST", `/api/feedback/${id}/retry`, {
      cookie,
      body: { expectedRevision: 1 },
    });
    expect(retryWhileBusy.status).toBe(409);
    expect(retryWhileBusy.data.error.code).toBe("busy");
    releaseBox.fn?.();
    const done = await first;
    expect(done.status).toBe(202);
    expect(done.data.status).toBe("needs_review"); // 搜索未命中 → 维持

    // 空闲后：过期 revision → 409 revision_conflict（过期页面不能覆盖新状态）
    const detail = await jsonReq(app.app, "GET", `/api/admin/feedback/${id}`, { cookie });
    const rev = detail.data.recovery.revision as number;
    const staleForce = await jsonReq(app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie,
      body: { action: "force-create", expectedRevision: rev + 1 },
    });
    expect(staleForce.status).toBe(409);
    expect(staleForce.data.error.code).toBe("revision_conflict");
    const staleRetry = await jsonReq(app.app, "POST", `/api/feedback/${id}/retry`, {
      cookie,
      body: { expectedRevision: rev + 1 },
    });
    expect(staleRetry.status).toBe(409);
    expect(staleRetry.data.error.code).toBe("revision_conflict");
  });
});
