import { describe, expect, it } from "vitest";
import { getFeedback } from "../src/db/repos.ts";
import { KANEO_SYNC_RESOLUTION_NOTE, syncFeedbackFromKaneo } from "../src/services/kaneo-issue-sync.ts";
import {
  authorizeArchive,
  createUserBearer,
  defaultSubmitBody,
  jsonReq,
  makeHarness,
  submitAndArchive,
  submitFeedback,
} from "./helpers.ts";

/** 默认完成列 fixture：triage 为归档目标列，done 为 isFinal 完成列。 */
const COLUMNS = [
  { id: "col-db-id", slug: "triage", name: "待筛选", isFinal: false },
  { id: "col-progress", slug: "in-progress", name: "In Progress", isFinal: false },
  { id: "col-review", slug: "in-review", name: "In Review", isFinal: false },
  { id: "col-done", slug: "done", name: "Done", isFinal: true },
];

async function archiveOne(h: Awaited<ReturnType<typeof makeHarness>>, body: Record<string, unknown> = {}) {
  const id = await submitAndArchive(h, body);
  const row = getFeedback(h.feedbackApp.db, id);
  if (!row?.kaneo_task_id) throw new Error("归档后缺少 kaneo_task_id");
  return { id, taskId: row.kaneo_task_id };
}

describe("Kaneo 完成状态回读（Issue 自动/手动置为已解决）", () => {
  it("批量同步：任务进入 isFinal 列 → 置为已解决、写入用户可见系统说明并产生未读", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const { id, taskId } = await archiveOne(h);
      h.kaneo.setTaskState(taskId, { status: "done", projectId: "proj-1" });

      const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/sync-kaneo", {
        cookie: h.cookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.data.checked).toBe(1);
      expect(res.data.resolved).toBe(1);
      expect(res.data.skipped).toBe(0);
      expect(res.data.failed).toBe(0);

      const row = getFeedback(h.feedbackApp.db, id);
      expect(row?.issue_status).toBe("resolved");

      // 用户端可见：系统处理说明 + 未读摘要。
      const unread = await jsonReq(h.feedbackApp.app, "GET", "/api/feedback/unread-summary?appId=com.test.app", {
        bearer: h.bearer,
      });
      expect(unread.status).toBe(200);
      expect(unread.data.unreadFeedbacksCount).toBe(1);

      const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${id}/dialogue`, { bearer: h.bearer });
      expect(detail.status).toBe(200);
      const systemMessage = (
        detail.data.messages as Array<{ senderType: string; text: string; resolutionNote: string | null }>
      ).find((m) => m.senderType === "system");
      expect(systemMessage?.text).toBe(KANEO_SYNC_RESOLUTION_NOTE);
      expect(systemMessage?.resolutionNote).toBe(KANEO_SYNC_RESOLUTION_NOTE);
      expect(detail.data.feedback.issueStatus).toBe("resolved");

      // 审计：动作与人工「标记已解决」区分。
      const adminDetail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${id}`, { cookie: h.cookie });
      const syncAudit = (adminDetail.data.audit as Array<{ action: string; actor: string }>).find(
        (a) => a.action === "kaneo_status_sync",
      );
      expect(syncAudit).toBeTruthy();
      expect(syncAudit?.actor).toContain("系统");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("任务未进入完成列：不改状态、不写消息；单条接口返回 not_final", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const { id, taskId } = await archiveOne(h);
      h.kaneo.setTaskState(taskId, { status: "in-review", projectId: "proj-1" });

      const res = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/sync-kaneo`, {
        cookie: h.cookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.data.result.kind).toBe("not_final");
      expect(res.data.result.message).toContain("任务尚未完成");
      expect(getFeedback(h.feedbackApp.db, id)?.issue_status).toBe("open");

      const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${id}/dialogue`, { bearer: h.bearer });
      expect(detail.data.feedback.issueStatus).toBe("open");
      expect(
        (detail.data.messages as Array<{ senderType: string }>).filter((m) => m.senderType === "system"),
      ).toHaveLength(0);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("已是已解决 / 没有关联任务 / 找不到任务 / 没有完成列：给出明确结果且不重复写入", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      // 已是已解决：先人工标记，再同步。
      const first = await archiveOne(h);
      h.kaneo.setTaskState(first.taskId, { status: "done", projectId: "proj-1" });
      const manual = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${first.id}/issue-status`, {
        cookie: h.cookie,
        body: { issueStatus: "resolved", resolutionNote: "人工处理说明" },
      });
      expect(manual.status).toBe(200);
      const again = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${first.id}/sync-kaneo`, {
        cookie: h.cookie,
        body: {},
      });
      expect(again.data.result.kind).toBe("already_resolved");

      // 没有任务：直接提交未归档反馈。
      const second = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "未归档反馈" }));
      const secondId = second.data.feedbackId as string;
      const noTask = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${secondId}/sync-kaneo`, {
        cookie: h.cookie,
        body: {},
      });
      expect(noTask.data.result.kind).toBe("no_task");
    } finally {
      h.feedbackApp.close();
    }

    // 没有 isFinal 列：独立 harness（列列表不含完成列）。
    const noFinal = await makeHarness({
      kaneo: { columns: [{ id: "col-db-id", slug: "triage", name: "待筛选", isFinal: false }] },
    });
    try {
      const { id, taskId } = await archiveOne(noFinal);
      noFinal.kaneo.setTaskState(taskId, { status: "triage", projectId: "proj-1" });
      const outcome = await syncFeedbackFromKaneo({ db: noFinal.feedbackApp.db, kaneo: noFinal.kaneo }, id, {
        allowNonOpen: true,
      });
      expect(outcome.kind).toBe("no_final_column");
      expect(getFeedback(noFinal.feedbackApp.db, id)?.issue_status).toBe("open");
    } finally {
      noFinal.feedbackApp.close();
    }
  });

  it("自动扫描只处理 open 候选：waiting_user 的人工对话记录不会被自动关闭", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const { id, taskId } = await archiveOne(h);
      h.kaneo.setTaskState(taskId, { status: "done", projectId: "proj-1" });
      // 制造进行中的人工对话：管理员请求补充 → waiting_user。
      const reply = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/messages`, {
        cookie: h.cookie,
        body: { text: "请补充信息", issueStatusAction: "request_info" },
      });
      expect(reply.status).toBe(201);

      const report = await h.feedbackApp.kaneoSync.runOnce();
      expect(report.checked).toBe(0);
      expect(getFeedback(h.feedbackApp.db, id)?.issue_status).toBe("waiting_user");

      // 自动路径拒绝非 open；管理端显式单条同步仍可处理。
      const auto = await syncFeedbackFromKaneo({ db: h.feedbackApp.db, kaneo: h.kaneo }, id);
      expect(auto.kind).toBe("skipped_status");
      const manual = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/sync-kaneo`, {
        cookie: h.cookie,
        body: {},
      });
      expect(manual.data.result.kind).toBe("resolved");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("Kaneo 不可达：批量计入失败、本地状态不变", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const { id, taskId } = await archiveOne(h);
      h.kaneo.setTaskState(taskId, { status: "done", projectId: "proj-1" });
      h.kaneo.taskReadError = { kind: "uncertain", message: "连接超时" };

      const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/sync-kaneo", {
        cookie: h.cookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.data.failed).toBe(1);
      expect(getFeedback(h.feedbackApp.db, id)?.issue_status).toBe("open");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("任务响应缺少当前列状态：不在候选批量中被误判完成", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const { id, taskId } = await archiveOne(h);
      // 未 setTaskState → mock getTask 返回无 status。
      h.kaneo.setTaskState(taskId, { status: "" });
      const report = await h.feedbackApp.kaneoSync.runOnce();
      expect(report.checked).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.results[0]?.kind).toBe("task_state_missing");
      expect(getFeedback(h.feedbackApp.db, id)?.issue_status).toBe("open");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("管理端接口要求管理员登录；批量 limit 参数按 1..200 截断", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const unauth = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/sync-kaneo", { body: {} });
      expect(unauth.status).toBe(401);
      const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/sync-kaneo", {
        cookie: h.cookie,
        body: { limit: 9999 },
      });
      expect(res.status).toBe(200);
      expect(res.data.checked).toBe(0);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("一个普通用户的历史反馈也能被系统同步通知（非管理员本人提交）", async () => {
    const h = await makeHarness({ kaneo: { columns: COLUMNS } });
    try {
      const userToken = await createUserBearer(h, { username: "user-kaneo-sync" });
      const submitted = await submitFeedback(h.feedbackApp, userToken, defaultSubmitBody({ text: "用户反馈" }));
      const id = submitted.data.feedbackId as string;
      await h.feedbackApp.worker.idle();
      const auth = await authorizeArchive(h, id);
      expect(auth.status).toBe(202);
      await h.feedbackApp.worker.idle();
      const row = getFeedback(h.feedbackApp.db, id);
      h.kaneo.setTaskState(row!.kaneo_task_id!, { status: "done", projectId: "proj-1" });

      const report = await h.feedbackApp.kaneoSync.runOnce();
      expect(report.resolved).toBe(1);
      const unread = await jsonReq(h.feedbackApp.app, "GET", "/api/feedback/unread-summary?appId=com.test.app", {
        bearer: userToken,
      });
      expect(unread.data.unreadFeedbacksCount).toBe(1);
    } finally {
      h.feedbackApp.close();
    }
  });
});
