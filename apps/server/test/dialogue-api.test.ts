import { describe, expect, it } from "vitest";
import { getCancellationTask, getFeedback } from "../src/db/repos.ts";
import {
  createUserBearer,
  defaultSubmitBody,
  getFeedbackDetail,
  makeHarness,
  submitAndArchive,
  submitFeedback,
} from "./helpers.ts";

describe("v11 API: 对话时间线、状态流转与 Kaneo 撤销闭环", () => {
  it("能力探测接口：/api/features 与 /api/auth/session 返回 dialogue 支持", async () => {
    const h = await makeHarness();
    try {
      // /api/features
      const featRes = await h.feedbackApp.app.fetch(new Request("http://localhost/api/features"));
      expect(featRes.status).toBe(200);
      const featJson = await featRes.json();
      // v12：能力探测返回 dialogue 与多图上限 images: 5
      expect(featJson).toEqual({ dialogue: true, images: 5 });

      // /api/auth/session
      const token = await createUserBearer(h, { username: "user-caps" });
      const sessRes = await h.feedbackApp.app.fetch(
        new Request("http://localhost/api/auth/session", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(sessRes.status).toBe(200);
      const sessJson = await sessRes.json();
      expect(sessJson.capabilities?.dialogue).toBe(true);
      expect(sessJson.capabilities?.images).toBe(5);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("基础闭环：提交 → 管理员请求补充 → 用户未读 → 用户回复 → 管理员解决 → 用户回复重开", async () => {
    const h = await makeHarness();
    try {
      const token = await createUserBearer(h, { username: "user-dialogue-1" });
      const cookie = h.cookie;

      // 1. 用户提交反馈
      const subRes = await submitFeedback(h.feedbackApp, token, defaultSubmitBody({ text: "按钮点击无效" }));
      expect(subRes.status).toBe(201);
      const fbId = subRes.data.feedbackId;

      // 初始 issueStatus 应为 open
      const d1 = await getFeedbackDetail(h, fbId);
      expect(d1.data.issueStatus).toBe("open");
      expect(d1.data.dialogueVersion).toBe(0);

      // 用户查未读摘要：0
      const unread0 = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/unread-summary?appId=${h.app.appId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect((await unread0.json()).unreadFeedbacksCount).toBe(0);

      // 2. 管理员发送请求补充（issueStatusAction = request_info）
      const adminReplyRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/admin/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            text: "请提供手机型号和系统版本",
            issueStatusAction: "request_info",
          }),
        }),
      );
      expect(adminReplyRes.status).toBe(201);
      const adminReplyJson = await adminReplyRes.json();
      expect(adminReplyJson.issueStatus).toBe("waiting_user");
      expect(adminReplyJson.message.seq).toBe(1);

      // 3. 用户查看未读摘要：显示 1
      const unread1 = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/unread-summary?appId=${h.app.appId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect((await unread1.json()).unreadFeedbacksCount).toBe(1);

      // 用户获取 Issue 对话时间线
      const dlgRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/dialogue`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(dlgRes.status).toBe(200);
      const dlgJson = await dlgRes.json();
      expect(dlgJson.feedback.issueStatus).toBe("waiting_user");
      expect(dlgJson.messages).toHaveLength(1);
      expect(dlgJson.messages[0].text).toBe("请提供手机型号和系统版本");

      // 用户上报已读游标
      const readRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/read`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ lastReadSeq: 1 }),
        }),
      );
      expect(readRes.status).toBe(200);

      const unreadAfter = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/unread-summary?appId=${h.app.appId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect((await unreadAfter.json()).unreadFeedbacksCount).toBe(0);

      // 4. 用户回复补充信息：文字 + 幂等标识
      const userReplyRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: "机型是 iPhone 15 Pro, iOS 17.5",
            idempotencyKey: "reply-key-1",
          }),
        }),
      );
      expect(userReplyRes.status).toBe(201);
      const userReplyJson = await userReplyRes.json();
      expect(userReplyJson.issueStatus).toBe("waiting_admin"); // 用户回复自动变 waiting_admin
      expect(userReplyJson.message.seq).toBe(2);

      // 重复发送同一幂等键：返回 200 replayed: true
      const replayRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: "机型是 iPhone 15 Pro, iOS 17.5",
            idempotencyKey: "reply-key-1",
          }),
        }),
      );
      expect(replayRes.status).toBe(200);
      expect((await replayRes.json()).replayed).toBe(true);

      // 5. 管理员在后台看到未读更新并标记解决
      const adminListRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/admin/feedback?appId=${h.app.appId}`, {
          headers: { cookie },
        }),
      );
      const adminListJson = await adminListRes.json();
      const item = adminListJson.items.find((it: any) => it.id === fbId);
      expect(item.unread).toBe(true);
      expect(item.issueStatus).toBe("waiting_admin");

      // v12：标记已解决必须填写处理说明——缺省拒绝
      const noNoteRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/admin/feedback/${fbId}/issue-status`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ issueStatus: "resolved" }),
        }),
      );
      expect(noNoteRes.status).toBe(400);

      // 管理员修改状态为 resolved（携带处理说明，对用户可见）
      const resolveRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/admin/feedback/${fbId}/issue-status`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ issueStatus: "resolved", resolutionNote: "已在 v1.2 修复闪退，请更新验证" }),
        }),
      );
      expect(resolveRes.status).toBe(200);
      expect((await resolveRes.json()).issueStatus).toBe("resolved");

      // 用户端对话时间线可见处理说明（system 消息 + resolutionNote 字段）
      const dlg2 = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/dialogue`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const dlg2Json = await dlg2.json();
      const sysMsg = dlg2Json.messages.find((m: any) => m.senderType === "system");
      expect(sysMsg).toBeTruthy();
      expect(sysMsg.resolutionNote).toBe("已在 v1.2 修复闪退，请更新验证");
      expect(sysMsg.text).toContain("已在 v1.2 修复闪退");

      // 6. 已解决反馈收到用户回复后，自动重开并变 waiting_admin
      const reopenRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: "更新后还是偶现闪退",
            idempotencyKey: "reply-key-reopen",
          }),
        }),
      );
      expect(reopenRes.status).toBe(201);
      expect((await reopenRes.json()).issueStatus).toBe("waiting_admin");
      expect(getFeedback(h.feedbackApp.db, fbId)?.issue_status).toBe("waiting_admin");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("已同步反馈收到用户回复：回到收件箱、暂停自动归档但不再触发 Kaneo 任务撤销（v12）", async () => {
    const h = await makeHarness();
    try {
      const cookie = h.cookie;

      // 1. 提交并完整归档到 Kaneo（通过 submitAndArchive 辅助函数）
      const fbId = await submitAndArchive(h, {
        text: "已同步的问题",
      });

      const fbBefore = getFeedback(h.feedbackApp.db, fbId);
      expect(fbBefore?.status).toBe("archived");
      expect(fbBefore?.kaneo_task_id).toBeTruthy();
      const oldTaskId = fbBefore!.kaneo_task_id!;

      // 管理员将本地管理生命周期标记为 archived
      await h.feedbackApp.app.fetch(
        new Request("http://localhost/api/admin/feedback/lifecycle", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            action: "archive",
            items: [{ id: fbId, expectedVersion: 0 }],
          }),
        }),
      );
      expect(getFeedback(h.feedbackApp.db, fbId)?.mgmt_state).toBe("archived");

      // 2. 用户在此已同步且本地已归档的反馈下回复补充说明（使用 h.bearer，因为 submitAndArchive 默认用 h.bearer）
      const replyRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${h.bearer}` },
          body: JSON.stringify({
            text: "补充：昨天又复现了一次",
          }),
        }),
      );
      expect(replyRes.status).toBe(201);

      // 3. 验证本地状态变动：移回收件箱、暂停自动归档
      const fbAfter = getFeedback(h.feedbackApp.db, fbId);
      expect(fbAfter?.mgmt_state).toBe("inbox");
      expect(fbAfter?.resume_paused).toBe(1);

      // v12：不再登记撤销任务；原 Kaneo 任务与链接保持不变，round 不递增。
      const cancelTask = getCancellationTask(h.feedbackApp.db, fbId, 1);
      expect(cancelTask).toBeNull();

      // 4. 触发 Worker 扫描：无撤销派发，远端任务保留。
      h.feedbackApp.worker.scanAutoArchive();
      await h.feedbackApp.worker.idle();

      const fbAfterReply = getFeedback(h.feedbackApp.db, fbId);
      expect(fbAfterReply?.kaneo_task_id).toBe(oldTaskId);
      expect(fbAfterReply?.kaneo_task_url).toBeTruthy();
      expect(fbAfterReply?.archive_round).toBe(1);
      // 远端任务未被删除
      expect(h.kaneo.deleted).toHaveLength(0);

      // 5. 既有任务链接未删除，分类保持锁定（v12 重新归档仍以“旧任务确认已删除”为前提）。
      const rearchiveRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/admin/feedback/${fbId}/classify`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            action: "archive",
            classifyVersion: fbAfterReply?.classify_version,
            projectId: "proj-1",
            columnId: "col-db-id",
            columnSlug: "triage",
            labelIds: ["label-bug"],
            operationId: "op-rearchive-1",
          }),
        }),
      );
      expect(rearchiveRes.status).toBe(409);
      // 归档授权仍在（archive_authorized_at 未清除）→ already_authorized；重新归档仍以旧任务确认删除为前提。
      expect(((await rearchiveRes.json()) as { error: { code: string } }).error.code).toBe("already_authorized");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("不同账号归属隔离：用户 A 无法访问用户 B 的 Issue 对话", async () => {
    const h = await makeHarness();
    try {
      const tokenA = await createUserBearer(h, { username: "user-a" });
      const tokenB = await createUserBearer(h, { username: "user-b" });

      const subRes = await submitFeedback(h.feedbackApp, tokenA, defaultSubmitBody({ text: "隐私问题" }));
      const fbId = subRes.data.feedbackId;

      // 用户 B 尝试获取对话详情：返回 404
      const getRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/dialogue`, {
          headers: { authorization: `Bearer ${tokenB}` },
        }),
      );
      expect(getRes.status).toBe(404);

      // 用户 B 尝试回复：返回 404
      const replyRes = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${fbId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
          body: JSON.stringify({ text: "越权回复" }),
        }),
      );
      expect(replyRes.status).toBe(404);
    } finally {
      h.feedbackApp.close();
    }
  });
});
