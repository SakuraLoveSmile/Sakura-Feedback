import { describe, expect, it } from "vitest";
import { resumeWorker } from "../src/app.ts";
import {
  getFeedback,
  getFeedbackLogs,
  getFeedbackScreenshot,
  listFeedbackAudit,
  updateFeedback,
} from "../src/db/repos.ts";
import { loadArchiveData, parseArchiveData, saveArchiveData } from "../src/pipeline/archive-data.ts";
import {
  appRuleVersion,
  authorizeArchive,
  createTestPng,
  defaultSubmitBody,
  jsonReq,
  makeHarness,
  submitFeedback,
  submitMultipartFeedback,
} from "./helpers.ts";

/** 提交 → AI 整理完成（不授权归档）。 */
async function submitOnly(h: Awaited<ReturnType<typeof makeHarness>>, body: Record<string, unknown> = {}) {
  const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(body));
  if (r.status !== 201) throw new Error(`提交失败 ${r.status}: ${r.text}`);
  await h.feedbackApp.worker.idle();
  return r.data.feedbackId as string;
}

describe("T1/T3：提交只做 AI 整理，远端归档需要人工授权", () => {
  it("提交成功只进入 needs_info，零远端写入；附件与内容摘要完整保存", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    expect(r.status).toBe(201);
    await h.feedbackApp.worker.idle();

    const id = r.data.feedbackId as string;
    const row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("needs_info");
    expect(row.archive_authorized_at).toBeNull();
    expect(row.classify_version).toBe(0);
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);
    // AI 整理结果已保存（内容整理不受影响）
    expect(row.processed_json).toBeTruthy();
  });

  it("带截图的提交：附件持久化，未授权前不产生远端写入", async () => {
    const h = await makeHarness();
    const png = await createTestPng(60, 40);
    const sub = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { ...defaultSubmitBody(), capture: { viewportWidth: 800, viewportHeight: 600 } },
      png,
    );
    expect(sub.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const id = sub.data.feedbackId as string;
    expect(getFeedbackScreenshot(h.feedbackApp.db, id)).not.toBeNull();
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("needs_info");
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("AI 失败：保留原文并使用原文标题/描述回退，不判 failed，也不授权归档", async () => {
    const h = await makeHarness({ aiOutcomes: ["timeout", "timeout", "timeout"] });
    const id = await submitOnly(h, { text: "导出 CSV 卡住了\n第二行说明" });
    const row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("needs_info");
    expect(row.processed_json).toBeNull();
    expect(row.title).toBe("导出 CSV 卡住了");
    expect(row.error_summary).toContain("原文标题/描述");
    expect(h.kaneo.remoteWrites).toBe(0);

    // AI 回退记录可人工重试 AI（重试绝不触发未授权归档）
    const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/retry`, { cookie: h.cookie });
    expect(retry.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("needs_info");
  });
});

describe("T2：管理接口的分类保存与归档授权", () => {
  it("暂存允许缺项；完整暂存仅变为待归档且零远端写入", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);

    const empty = await authorizeArchive(h, id, {
      action: "save",
      projectId: null,
      columnId: null,
      columnSlug: null,
      labelIds: [],
    });
    expect(empty.status).toBe(200);
    expect(empty.data.status).toBe("needs_info");
    expect(h.kaneo.remoteWrites).toBe(0);

    const partial = await authorizeArchive(h, id, { action: "save", columnId: null, columnSlug: null });
    expect(partial.data.status).toBe("needs_info");

    const complete = await authorizeArchive(h, id, { action: "save" });
    expect(complete.status).toBe(200);
    expect(complete.data.status).toBe("ready_to_archive");
    expect(complete.data.classifyVersion).toBe(3);
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("不完整归档被服务端拒绝（422）且零远端写入", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const res = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body: { action: "archive", classifyVersion: 0, projectId: "proj-1", columnId: "col-db-id", labelIds: [] },
    });
    expect(res.status).toBe(422);
    expect(res.data.error.code).toBe("incomplete_classification");
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("needs_info");
  });

  it("分类版本冲突 → 409 且不写库、不写远端", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const ok = await authorizeArchive(h, id, { action: "save" });
    expect(ok.status).toBe(200);
    const stale = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body: { action: "save", classifyVersion: 0, projectId: "proj-1", columnId: "col-db-id", labelIds: ["label-bug"] },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("version_conflict");
    expect(getFeedback(h.feedbackApp.db, id)!.classify_version).toBe(1);
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("所选列不在项目中 / 标签不是工作区级 → 422，零远端写入", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const badCol = await authorizeArchive(h, id, { columnId: "col-does-not-exist" });
    expect(badCol.status).toBe(422);
    expect(badCol.data.error.code).toBe("invalid_classification");
    const badLabel = await authorizeArchive(h, id, { labelIds: ["label-ghost"] });
    expect(badLabel.status).toBe(422);
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("归档接口重新读取 Kaneo 选项：授权后修改软件配置不得重定向本次任务", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const auth = await authorizeArchive(h, id);
    expect(auth.status).toBe(202);

    // 管理员在入队后修改软件默认目标列
    const upd = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${h.app.id}`, {
      cookie: h.cookie,
      body: {
        expectedRuleVersion: await appRuleVersion(h),
        name: "测试软件",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "proj-other",
        kaneoColumnSlug: "done",
      },
    });
    expect(upd.status).toBe(200);

    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
    // 快照固定：仍然创建在授权时选择的项目与列
    expect(h.kaneo.created[0]?.projectId).toBe("proj-1");
    expect(h.kaneo.created[0]?.columnSlug).toBe("triage");
  });

  it("可选负责人：选择后创建任务携带 userId；未选择时省略 userId", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const auth = await authorizeArchive(h, id, { assigneeId: "user-1", assigneeName: "负责人甲" });
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created[0]?.userId).toBe("user-1");

    const h2 = await makeHarness();
    const id2 = await submitOnly(h2);
    await authorizeArchive(h2, id2);
    await h2.feedbackApp.worker.idle();
    expect(h2.kaneo.created[0]?.userId).toBeUndefined();
    expect(h2.kaneo.created[0]).not.toHaveProperty("userId");
  });

  it("归档授权后分类锁定：再次编辑 → 409 classification_locked", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    await authorizeArchive(h, id);
    const locked = await authorizeArchive(h, id, { action: "save", labelIds: ["label-bug", "label-other"] });
    expect(locked.status).toBe(409);
    expect(locked.data.error.code).toBe("classification_locked");
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
    const again = await authorizeArchive(h, id);
    expect(again.status).toBe(409);
  });

  it("重复点击与请求重放：同 operationId 幂等，不同 operationId → 409，只创建一个任务", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const body = {
      action: "archive" as const,
      classifyVersion: 0,
      projectId: "proj-1",
      columnId: "col-db-id",
      columnSlug: "triage",
      labelIds: ["label-bug"],
      operationId: "op-fixed-1",
    };
    const first = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body,
    });
    expect(first.status).toBe(202);
    const replay = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body,
    });
    expect(replay.status).toBe(202);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.archiveQueued).toBe(false);

    const different = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body: { ...body, operationId: "op-fixed-2" },
    });
    expect(different.status).toBe(409);
    expect(different.data.error.code).toBe("already_authorized");

    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
  });

  it("并发授权：两个请求同时到达只产生一次归档授权与一个任务", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const mk = (op: string) =>
      jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
        cookie: h.cookie,
        body: {
          action: "archive",
          classifyVersion: 0,
          projectId: "proj-1",
          columnId: "col-db-id",
          columnSlug: "triage",
          labelIds: ["label-bug"],
          operationId: op,
        },
      });
    const [a, b] = await Promise.all([mk("op-a"), mk("op-b")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
  });

  it("详情返回分类、授权状态与操作审计", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    await authorizeArchive(h, id, { action: "save" });
    await authorizeArchive(h, id);
    await h.feedbackApp.worker.idle();

    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
    expect(detail.data.classification.labelIds).toEqual(["label-bug"]);
    expect(detail.data.archiveAuthorized).toBe(true);
    expect(detail.data.classificationLocked).toBe(true);
    const actions = (detail.data.audit ?? []).map((a: { action: string }) => a.action);
    expect(actions).toContain("classify_save");
    expect(actions).toContain("archive_authorize");

    const dbAudit = listFeedbackAudit(h.feedbackApp.db, id);
    expect(dbAudit.every((a) => a.actor_username === "admin")).toBe(true);
  });

  it("Kaneo 选项接口只返回工作区级标签与成员", async () => {
    const h = await makeHarness();
    const res = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback/options?projectId=proj-1", {
      cookie: h.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.data.columns[0]).toMatchObject({ id: "col-db-id", slug: "triage" });
    expect(res.data.labels).toEqual([{ id: "label-bug", name: "bug", color: "#e11d48" }]);
    expect(res.data.members[0].id).toBe("user-1");
  });
});

describe("T3：标签、快照与安全恢复", () => {
  it("标签关联成功后读回核对，任务/标签全部确认才标记已归档", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    await authorizeArchive(h, id);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("archived");
    expect(h.kaneo.labelAttaches).toEqual([{ labelId: "label-bug", taskId: row.kaneo_task_id }]);
    const parsed = loadArchiveData(h.feedbackApp.db, id);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind === "valid") {
      const v3 = parsed.data as { version: number; labels: Record<string, { outcome: string; taskLabelId?: string }> };
      expect(v3.version).toBe(3);
      expect(v3.labels["label-bug"]?.outcome).toBe("confirmed");
      expect(v3.labels["label-bug"]?.taskLabelId).toContain("tasklabel-");
    }
  });

  it("标签关联结果不确定 → needs_review（任务已创建，绝不重复建任务）", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    h.kaneo.labelErrorQueue.push("uncertain");
    await authorizeArchive(h, id);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("needs_review");
    expect(row.error_summary).toContain("标签");
    expect(h.kaneo.created).toHaveLength(1);
    const parsed = loadArchiveData(h.feedbackApp.db, id);
    if (parsed.kind === "valid") {
      expect((parsed.data as { labels: Record<string, { outcome: string }> }).labels["label-bug"]?.outcome).toBe(
        "maybe_sent",
      );
    }
  });

  it("标签确定失败 → failed，可人工重试", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    h.kaneo.labelErrorQueue.push("definite");
    await authorizeArchive(h, id);
    await h.feedbackApp.worker.idle();
    let row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("failed");
    expect(row.error_summary).toContain("关联标签失败");

    const retry = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/${id}/retry`, { cookie: h.cookie });
    expect(retry.status).toBe(202);
    await h.feedbackApp.worker.idle();
    row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("archived");
    expect(h.kaneo.created).toHaveLength(1); // 复用已有任务，不重建
  });

  it("标签在授权后被删除 → 确定失败并提示重选，不关联其他任务的标签", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    // 用测试夹具直接构造“已授权”的记录（避免与后台 worker 抢时序）
    const saved = saveArchiveData(h.feedbackApp.db, id, loadArchiveData(h.feedbackApp.db, id), {
      target: {
        apiBase: "http://kaneo.test/api",
        projectId: "proj-1",
        workspaceId: "ws-1",
        columnId: "col-db-id",
        columnSlug: "triage",
        labelIds: ["label-bug"],
        assigneeId: null,
      },
      labels: { "label-bug": { id: "label-bug", name: "bug", outcome: "not_sent" } },
      attachments: {},
    });
    expect(saved.version).toBe(3);
    updateFeedback(h.feedbackApp.db, id, {
      status: "ready_to_archive",
      classify_project_id: "proj-1",
      classify_column_id: "col-db-id",
      classify_column_slug: "triage",
      classify_labels_json: JSON.stringify(["label-bug"]),
      archive_authorized_at: new Date().toISOString(),
      archive_authorized_by: "user-1",
      archive_operation_id: "op-fixture",
    });

    // 授权后工作区标签被删除：worker 必须确定失败，而不是关联别的标签
    h.kaneo.setWorkspaceLabels([]);
    h.feedbackApp.worker.enqueue(id);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, id)!;
    expect(row.status).toBe("failed");
    expect(row.error_summary).toContain("工作区标签已不存在");
    expect(h.kaneo.labelAttaches).toHaveLength(0);
  });

  it("重启扫描不绕过授权门槛：未授权的 ready_to_archive 不会被归档", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    // 直接构造“分类完整但未授权”的记录（模拟仅暂存后重启）
    updateFeedback(h.feedbackApp.db, id, {
      status: "ready_to_archive",
      classify_project_id: "proj-1",
      classify_column_id: "col-db-id",
      classify_column_slug: "triage",
      classify_labels_json: JSON.stringify(["label-bug"]),
    });
    resumeWorker(h.feedbackApp);
    await h.feedbackApp.worker.idle();
    // 重启扫描根本不入队未授权记录
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("ready_to_archive");

    // 即便有人把它塞进队列，worker 也拒绝远端写入并退回待补充信息
    h.feedbackApp.worker.enqueue(id);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("needs_info");
  });

  it("重启扫描恢复已授权的待归档记录（快照不丢，继续归档）", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    const auth = await authorizeArchive(h, id);
    expect(auth.status).toBe(202);
    // 重启前不处理，直接模拟服务重启扫描
    resumeWorker(h.feedbackApp);
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
    expect(h.kaneo.created).toHaveLength(1);
    expect(
      (loadArchiveData(h.feedbackApp.db, id) as { data: { target: { projectId: string } } }).data.target.projectId,
    ).toBe("proj-1");
  });

  it("归档快照固定连接/项目/工作区/列/标签/负责人，版本化恢复数据可回读", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    await authorizeArchive(h, id, { assigneeId: "user-1", assigneeName: "负责人甲" });
    const parsed = parseArchiveData(getFeedback(h.feedbackApp.db, id)!.archive_data_json);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind === "valid") {
      expect(parsed.data.version).toBe(3);
      expect(parsed.data.target).toMatchObject({
        apiBase: "http://kaneo.test/api",
        projectId: "proj-1",
        workspaceId: "ws-1",
        columnId: "col-db-id",
        columnSlug: "triage",
        labelIds: ["label-bug"],
        assigneeId: "user-1",
      });
    }
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
  });

  it("普通保存不写远端：暂存任意次都不产生 Kaneo 调用（写）", async () => {
    const h = await makeHarness();
    const id = await submitOnly(h);
    for (let i = 0; i < 3; i++) {
      const r = await authorizeArchive(h, id, { action: "save" });
      expect(r.status).toBe(200);
    }
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("ready_to_archive");
  });
});
