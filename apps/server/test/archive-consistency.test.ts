import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getFeedback, updateFeedback } from "../src/db/repos.ts";
import {
  type ArchiveData,
  type ArchiveUpload,
  loadArchiveData,
  saveArchiveData,
} from "../src/pipeline/archive-data.ts";
import { type KaneoSettings, KaneoUncertainError } from "../src/services/kaneo.ts";
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
  submitMultipartFeedback,
} from "./helpers.ts";

/**
 * 归档一致性回归（P1）：
 * 1. 所有归档与人工恢复入口统一检查已保存的 Kaneo 目标；
 * 2. 每次操作固定一份 Kaneo 客户端配置；
 * 3. 评论 POST / 图片 PUT 发出前先持久化 maybe_sent；
 * 4. 结果未知的评论写入不得自动重发（只有显式 retry_comment 才发送）；
 * 5. 上传地址过期 / 同 key 重试被拒绝时不自动申请新 key。
 *
 * 每个用例使用独立临时数据目录 + 进程内 HTTP，断言远端调用次数与恢复数据内容。
 */

interface Rig {
  app: ReturnType<typeof createApp> & { config: { dataDir: string } };
  inner: MockKaneo;
  cookie: string;
  bearer: string;
}

async function buildRig(wrap?: (inner: MockKaneo) => Partial<MockKaneo>): Promise<Rig> {
  const config = makeConfig();
  const inner = makeMockKaneo();
  const overrides = wrap ? wrap(inner) : {};
  // 包装层必须也是 bind() 的返回值，否则归档操作会在绑定后绕过测试注入的故障钩子。
  const client = Object.assign(Object.create(inner), overrides, {
    bind(settings: KaneoSettings) {
      inner.boundSettings.push(settings);
      return client;
    },
  }) as MockKaneo;
  const app = createApp(config, { ai: makeMockAi(), kaneo: client, workerSleep: instantSleep });
  const cookie = await loginAsAdmin(app);
  await seedConnections(app, cookie);
  await seedApp(app, cookie);
  const bearer = await loginAsClient(app);
  return { app: app as unknown as Rig["app"], inner, cookie, bearer };
}

function state(rig: Rig, id: string): ArchiveData {
  const parsed = loadArchiveData(rig.app.db, id);
  if (parsed.kind !== "valid") throw new Error(`期望合法归档数据，实际 ${parsed.kind}`);
  return parsed.data;
}

async function submitScreenshot(rig: Rig, size = 80): Promise<{ id: string; png: Buffer }> {
  const png = await createTestPng(size, size);
  const res = await submitMultipartFeedback(rig.app, rig.bearer, defaultSubmitBody(), png);
  expect(res.status).toBe(201);
  await rig.app.worker.idle();
  return { id: res.data.feedbackId, png };
}

/** 把已归档记录改回“待核对”，保留恢复数据（人工恢复入口的前置状态）。 */
function toNeedsReview(rig: Rig, id: string, patch: Record<string, unknown> = {}): void {
  updateFeedback(rig.app.db, id, { status: "needs_review", error_summary: null, last_error: null, ...patch });
}

/** 把应用的目标项目改成另一个（模拟管理员改了 Kaneo 目标）。 */
async function changeProject(rig: Rig, projectId: string): Promise<void> {
  const apps = (await jsonReq(rig.app.app, "GET", "/api/admin/apps", { cookie: rig.cookie })).data.apps as Array<{
    id: string;
  }>;
  const r = await jsonReq(rig.app.app, "PUT", `/api/admin/apps/${apps[0]!.id}`, {
    cookie: rig.cookie,
    body: {
      name: "测试软件",
      allowedOrigins: ["http://host.test"],
      kaneoProjectId: projectId,
      kaneoColumnSlug: "triage",
    },
  });
  expect(r.status).toBe(200);
}

function revisionOf(rig: Rig, id: string): number {
  return state(rig, id).revision;
}

describe("归档一致性：所有恢复入口统一检查已保存的 Kaneo 目标", () => {
  it("目标改变后 recheck / retry_comment / replace_upload 一律拒绝，零远端写入且恢复数据保留", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    const pinned = state(rig, id);
    expect(pinned.target.projectId).toBe("proj-1");

    toNeedsReview(rig, id);
    await changeProject(rig, "proj-2");

    const before = rig.inner.remoteWrites;
    const rev = revisionOf(rig, id);

    const recheck = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: rig.cookie,
      body: { action: "recheck", expectedRevision: rev },
    });
    expect(recheck.status).toBe(409);
    expect(recheck.data.error.code).toBe("target_changed");
    expect(recheck.data.error.message).toContain("目标");

    const retryComment = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "retry_comment", expectedRevision: rev },
    });
    expect(retryComment.status).toBe(409);
    expect(retryComment.data.error.code).toBe("target_changed");

    const replaceUpload = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "replace_upload", expectedRevision: rev },
    });
    expect(replaceUpload.status).toBe(409);
    expect(replaceUpload.data.error.code).toBe("target_changed");

    // 零远端写入 + 恢复数据原样保留（含旧 key / 资产线索 / 评论结果）
    expect(rig.inner.remoteWrites).toBe(before);
    const after = state(rig, id);
    expect(after.target).toEqual(pinned.target);
    expect(after.upload?.key).toBe(pinned.upload?.key);
    expect(after.asset).toEqual(pinned.asset);
    expect(after.comment).toEqual(pinned.comment);
    expect(getFeedback(rig.app.db, id)?.kaneo_task_id).toBe("task-1");
  });

  it("force-create 在目标改变时拒绝且不清空恢复数据；目标一致时仍可用", async () => {
    const rig = await buildRig();
    const res = await jsonReq(rig.app.app, "POST", "/api/feedback", {
      bearer: rig.bearer,
      body: defaultSubmitBody(),
    });
    expect(res.status).toBe(201);
    await rig.app.worker.idle();
    const id = res.data.feedbackId as string;
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    const pinned = state(rig, id);

    // 构造“任务创建结果未知”的待核对记录（无 task ID、无附件状态）
    saveArchiveData(rig.app.db, id, loadArchiveData(rig.app.db, id), { target: pinned.target });
    toNeedsReview(rig, id, { kaneo_task_id: null, kaneo_task_url: null, archive_stage: "task_pending" });
    await changeProject(rig, "proj-2");

    const before = rig.inner.remoteWrites;
    const rev = revisionOf(rig, id);
    const denied = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: rig.cookie,
      body: { action: "force-create", expectedRevision: rev },
    });
    expect(denied.status).toBe(409);
    expect(denied.data.error.code).toBe("target_changed");
    expect(rig.inner.remoteWrites).toBe(before); // 零远端写入
    expect(state(rig, id).target).toEqual(pinned.target); // 恢复数据未被清空
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");

    // 目标改回 → force-create 恢复正常
    await changeProject(rig, "proj-1");
    const ok = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: rig.cookie,
      body: { action: "force-create", expectedRevision: revisionOf(rig, id) },
    });
    expect(ok.status).toBe(202);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
  });
});

describe("归档一致性：操作内固定 Kaneo 客户端配置", () => {
  it("一次归档操作只固定一份配置；操作中途改配置不影响该次操作", async () => {
    let duringOperation: { baseUrl: string } | null = null;
    const rig = await buildRig((inner) => ({
      async createImageUpload(taskId: string, input: Parameters<MockKaneo["createImageUpload"]>[1]) {
        // 远端操作进行中：把全局 Kaneo 配置改到另一个地址（模拟管理员改配置）
        const { setSetting } = await import("../src/db/repos.ts");
        setSetting(rig.app.db, "kaneo.baseUrl", "http://other-kaneo.test/api");
        duringOperation = { baseUrl: "http://other-kaneo.test/api" };
        return inner.createImageUpload(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(duringOperation).not.toBeNull();

    // 该次操作只固定一次配置，且固定的是操作开始时的地址（不是中途改成的地址）
    expect(rig.inner.boundSettings.length).toBeGreaterThanOrEqual(1);
    const used = new Set(rig.inner.boundSettings.map((s) => s.baseUrl));
    expect([...used]).toEqual(["http://kaneo.test/api"]);
    // 恢复数据里固定的目标同样是旧地址
    expect(state(rig, id).target.apiBase).toBe("http://kaneo.test/api");
  });
});

describe("归档一致性：评论写入先落盘意图", () => {
  it("评论 POST 前先持久化 maybe_sent：持久化失败则绝不发出评论请求", async () => {
    let commentCalls = 0;
    const rig = await buildRig((inner) => ({
      async createComment(taskId: string, input: { content: string }) {
        commentCalls++;
        return inner.createComment(taskId, input);
      },
    }));
    // 精确定位：只让“评论意图”那次 archive_data_json 写入失败（上传已确认之后）。
    // 谓词直接查库，避免与后台流水线完成时序竞争。
    injectArchiveWriteFailure(rig, () => {
      const only = rig.app.db.prepare("SELECT id FROM feedbacks LIMIT 1").get() as { id: string } | undefined;
      if (!only) return false;
      const parsed = loadArchiveData(rig.app.db, only.id);
      return parsed.kind === "valid" && parsed.data.upload?.outcome === "confirmed";
    });

    const png = await createTestPng(80, 80);
    const res = await submitMultipartFeedback(rig.app, rig.bearer, defaultSubmitBody(), png);
    expect(res.status).toBe(201);
    const feedbackId = res.data.feedbackId as string;
    await rig.app.worker.idle();

    expect(commentCalls).toBe(0); // 意图落盘失败 → 零评论请求
    const row = getFeedback(rig.app.db, feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("持久化失败");
    // 上传结果已确认；评论完全没有留下“已发送”记录
    expect(state(rig, feedbackId).upload?.outcome).toBe("confirmed");
    expect(state(rig, feedbackId).comment).toBeUndefined();
  });

  it("评论结果未知 → 自动路径不得重发；显式 retry_comment 才发送一次", async () => {
    let commentCalls = 0;
    const rig = await buildRig((inner) => ({
      async createComment(taskId: string, input: { content: string }) {
        commentCalls++;
        if (commentCalls === 1) throw new KaneoUncertainError("评论连接中断，结果不确定");
        return inner.createComment(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(state(rig, id).comment?.outcome).toBe("maybe_sent"); // 发出前即登记未知，绝不降级为 not_sent
    expect(commentCalls).toBe(1);
    expect(rig.inner.comments.length).toBe(0);

    // 自动路径（retry 重新入队）核对未命中 → 不得自动重发
    updateFeedback(rig.app.db, id, { status: "processing", error_summary: null });
    rig.app.worker.enqueue(id);
    await rig.app.worker.idle();
    expect(commentCalls).toBe(1); // 关键：没有第二次 POST
    expect(rig.inner.comments.length).toBe(0);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(state(rig, id).comment?.outcome).toBe("maybe_sent");

    // 管理页 recheck 同样只核对，不重发
    const recheck = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/resolve`, {
      cookie: rig.cookie,
      body: { action: "recheck", expectedRevision: revisionOf(rig, id) },
    });
    expect([202, 409]).toContain(recheck.status);
    await rig.app.worker.idle();
    expect(commentCalls).toBe(1);
    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");

    // 显式 retry_comment：先查重未命中 → 允许一次发送
    const recover = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "retry_comment", expectedRevision: revisionOf(rig, id) },
    });
    expect(recover.status).toBe(202);
    expect(recover.data.status).toBe("archived");
    expect(commentCalls).toBe(2);
    expect(rig.inner.comments.length).toBe(1);
    expect(state(rig, id).comment?.outcome).toBe("confirmed");
  });

  it("明确被拒绝的评论（4xx）降级为 not_sent，自动恢复可再次发送", async () => {
    let commentCalls = 0;
    const rig = await buildRig((inner) => ({
      async createComment(taskId: string, input: { content: string }) {
        commentCalls++;
        if (commentCalls === 1) {
          const { KaneoDefiniteError } = await import("../src/services/kaneo.ts");
          throw new KaneoDefiniteError("Kaneo 添加评论失败 (400)：bad request");
        }
        return inner.createComment(taskId, input);
      },
    }));
    const { id } = await submitScreenshot(rig);
    expect(getFeedback(rig.app.db, id)?.status).toBe("failed");
    expect(state(rig, id).comment?.outcome).toBe("not_sent"); // 确定未创建，不是未知

    const retry = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/retry`, { cookie: rig.cookie });
    expect(retry.status).toBe(202);
    await rig.app.worker.idle();
    expect(getFeedback(rig.app.db, id)?.status).toBe("archived");
    expect(commentCalls).toBe(2);
    expect(rig.inner.comments.length).toBe(1);
  });
});

describe("归档一致性：上传 key 不自动更换", () => {
  it("上传地址过期 → 不自动申请新 key，转待核对并保留原 key", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const base = state(rig, id);
    const before = {
      finalizes: rig.inner.finalizes.length,
      presigns: [...rig.inner.presignSeq.values()],
    };
    const expired = {
      ...base.upload!,
      outcome: "not_sent" as const,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    resetToUploadResume(rig, id, expired);
    await rig.app.worker.idle();

    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(getFeedback(rig.app.db, id)?.error_summary).toContain("过期");
    expect(rig.inner.finalizes.length).toBe(before.finalizes); // 零新增 finalize
    // 未申请新地址、未发出评论（reset 已清空评论，这里断言没有新增）
    expect([...rig.inner.presignSeq.values()]).toEqual(before.presigns);
    expect(rig.inner.comments.length).toBe(0);
    const kept = state(rig, id);
    expect(kept.upload?.key).toBe(base.upload!.key); // 原 key 保留
    expect(kept.upload?.expiresAt).toBe(expired.expiresAt); // 过期信息原样保留
    expect(kept.replacedKeys ?? []).toEqual([]);
  });

  it("同 key 重传被业务拒绝 → 不自动申请新 key，转待核对并保留原 key", async () => {
    let putCalls = 0;
    const rig = await buildRig((inner) => ({
      async uploadImageToPresigned(...args: Parameters<MockKaneo["uploadImageToPresigned"]>) {
        putCalls++;
        if (putCalls === 2) {
          const { KaneoDefiniteError } = await import("../src/services/kaneo.ts");
          throw new KaneoDefiniteError("图片上传至存储服务失败 (403)");
        }
        return inner.uploadImageToPresigned(...args);
      },
    }));
    const { id } = await submitScreenshot(rig);
    const base = state(rig, id);
    expect(base.upload?.key).toBe("key-task-1");

    resetToUploadResume(rig, id, { ...base.upload!, outcome: "not_sent", recoveries: 0 });
    await rig.app.worker.idle();

    expect(getFeedback(rig.app.db, id)?.status).toBe("needs_review");
    expect(getFeedback(rig.app.db, id)?.error_summary).toContain("同 key");
    const kept = state(rig, id);
    expect(kept.upload?.key).toBe("key-task-1"); // 没有换新 key
    expect(kept.replacedKeys ?? []).toEqual([]);
    // 只申请过一次预签名地址（未自动申请新地址）
    expect([...rig.inner.presignSeq.values()]).toEqual([1]);
  });

  it("replace_upload 是唯一替换入口：复用原任务、保留旧 key、不删远端对象", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const base = state(rig, id);
    toNeedsReview(rig, id);
    if (base.asset?.url) {
      rig.inner.assetUrlToBytes.delete(base.asset.url);
    }

    const res = await jsonReq(rig.app.app, "POST", `/api/feedback/${id}/recover`, {
      cookie: rig.cookie,
      body: { action: "replace_upload", expectedRevision: revisionOf(rig, id) },
    });
    expect(res.status).toBe(202);
    expect(res.data.replaced).toBe(true);
    expect(rig.inner.created.length).toBe(1); // 复用原任务，绝不重建
    const after = state(rig, id);
    expect(after.upload?.key).not.toBe(base.upload!.key);
    expect(after.replacedKeys).toContain(base.upload!.key); // 旧 key 保留可追溯
    expect(after.target).toEqual(base.target);
    expect(after.asset).not.toBeNull();
    expect(after.comment?.outcome).toBe("confirmed");
  });

  it("资产未知但任务已知时仍提供 replace_upload（过期上传的唯一出路）", async () => {
    const rig = await buildRig();
    const { id } = await submitScreenshot(rig);
    const base = state(rig, id);
    toNeedsReview(rig, id);
    // 去掉资产线索，只留任务 + 上传记录（模拟过期/被拒绝的上传）
    saveArchiveData(rig.app.db, id, loadArchiveData(rig.app.db, id), {
      target: base.target,
      upload: { ...base.upload!, outcome: "maybe_sent", expiresAt: new Date(0).toISOString() },
    });
    const detail = await jsonReq(rig.app.app, "GET", `/api/admin/feedback/${id}`, { cookie: rig.cookie });
    expect(detail.status).toBe(200);
    expect(detail.data.recovery.allowedActions).toContain("replace_upload");
    expect(detail.data.recovery.actionNotes?.retry_comment).toContain("重复");
  });
});

/** 将记录重置为“带指定 upload 记录的恢复起点”（清评论、保留任务）。 */
function resetToUploadResume(rig: Rig, id: string, upload: ArchiveUpload): void {
  rig.inner.comments.length = 0;
  const base = state(rig, id);
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

/**
 * 注入 archive_data_json 写入失败（SQLite 层），用于验证“持久化失败则不发请求”。
 * 仅在 shouldFail() 为真时让对应语句抛错，其余读写正常。
 */
function injectArchiveWriteFailure(rig: Rig, shouldFail: () => boolean): void {
  const db = rig.app.db as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare.bind(db);
  db.prepare = (sql: string): unknown => {
    const stmt = original(sql) as {
      run: (...a: unknown[]) => unknown;
      get: (...a: unknown[]) => unknown;
      all: (...a: unknown[]) => unknown;
    };
    if (!sql.includes("archive_data_json")) return stmt;
    return {
      run: (...args: unknown[]) => {
        if (shouldFail()) throw new Error("injected sqlite write failure");
        return stmt.run(...args);
      },
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
    };
  };
}
