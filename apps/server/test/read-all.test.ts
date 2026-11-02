import { describe, expect, it } from "vitest";
import { getFeedback, getReadCursor, getUserByUsername } from "../src/db/repos.ts";
import { createUserBearer, defaultSubmitBody, jsonReq, makeHarness, submitFeedback } from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** 第二个应用：用于验证 appId 作用域（缺省清全部 / 指定只清该应用）。 */
const SECOND_APP = "com.test.app2";

interface ReadAllResponse {
  ok?: boolean;
  markedFeedbacks?: number;
  markedMessages?: number;
  error?: { code: string; message: string };
}

interface UnreadSummary {
  unreadFeedbacksCount: number;
  totalUnreadMessages: number;
}

function appQuery(appId?: string): string {
  return appId ? `?appId=${encodeURIComponent(appId)}` : "";
}

/** 与 unread-summary 的 appId 语义一致。 */
async function unreadSummary(h: Harness, token: string, appId?: string): Promise<UnreadSummary> {
  const r = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/unread-summary${appQuery(appId)}`, {
    bearer: token,
  });
  expect(r.status).toBe(200);
  return r.data as UnreadSummary;
}

async function readAll(h: Harness, token?: string, appId?: string) {
  const r = await jsonReq(h.feedbackApp.app, "POST", `/api/feedback/read-all${appQuery(appId)}`, {
    ...(token ? { bearer: token } : {}),
  });
  return { status: r.status, data: r.data as ReadAllResponse };
}

/** 提交一条反馈并等待后台处理稳定；返回 feedbackId。 */
async function submitFeedbackForTest(h: Harness, token: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await submitFeedback(h.feedbackApp, token, defaultSubmitBody(over));
  expect(r.status).toBe(201);
  await h.feedbackApp.worker.idle();
  return r.data.feedbackId as string;
}

/** 管理员向反馈发送一条普通回复（对用户端为未读 admin 消息）；返回消息 seq。 */
async function adminMessage(h: Harness, feedbackId: string, text = "管理员补充说明"): Promise<number> {
  const r = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${feedbackId}/messages`, {
    cookie: h.cookie,
    body: { text, issueStatusAction: "reply" },
  });
  expect(r.status).toBe(201);
  return r.data.message.seq as number;
}

/** 通过管理端生命周期接口把反馈移入回收站 / 从回收站恢复。 */
async function lifecycle(h: Harness, action: "trash" | "restore", feedbackId: string): Promise<void> {
  const row = getFeedback(h.feedbackApp.db, feedbackId);
  const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/lifecycle", {
    cookie: h.cookie,
    body: { action, items: [{ id: feedbackId, expectedVersion: row?.lifecycle_version ?? 0 }] },
  });
  expect(r.status).toBe(200);
}

function userId(h: Harness, username: string): string {
  const user = getUserByUsername(h.feedbackApp.db, username);
  if (!user) throw new Error(`测试账号不存在: ${username}`);
  return user.id;
}

describe("v0.8.2 一键已读 POST /api/feedback/read-all", () => {
  it("未登录返回 401 unauthorized", async () => {
    const h = await makeHarness();
    try {
      const r = await readAll(h);
      expect(r.status).toBe(401);
      expect(r.data.error?.code).toBe("unauthorized");
    } finally {
      h.feedbackApp.close();
    }
  });

  it("跨源组件调用：返回 CORS 头，按 Bearer 鉴权（不依赖后台 Cookie）", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-cors";
      const token = await createUserBearer(h, { username });
      const fb = await submitFeedbackForTest(h, token, { text: "跨源一键已读" });
      expect(await adminMessage(h, fb)).toBe(1);

      const r = await jsonReq(h.feedbackApp.app, "POST", "/api/feedback/read-all", {
        bearer: token,
        origin: "http://host.test",
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("http://host.test");
      expect(r.data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
    } finally {
      h.feedbackApp.close();
    }
  });

  it("有未读时一键已读：summary 归零、游标推进、反馈数与消息数准确", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-basic";
      const token = await createUserBearer(h, { username });
      const uid = userId(h, username);

      const fb1 = await submitFeedbackForTest(h, token, { text: "问题一" });
      const fb2 = await submitFeedbackForTest(h, token, { text: "问题二" });
      expect(await adminMessage(h, fb1, "第一条回复")).toBe(1);
      expect(await adminMessage(h, fb1, "第二条回复")).toBe(2);
      expect(await adminMessage(h, fb2, "另一条回复")).toBe(1);

      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 2, totalUnreadMessages: 3 });

      const r = await readAll(h, token);
      expect(r.status).toBe(200);
      expect(r.data).toEqual({ ok: true, markedFeedbacks: 2, markedMessages: 3 });

      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      // 游标推进到各反馈 admin/system 消息的最大 seq。
      expect(getReadCursor(h.feedbackApp.db, uid, fb1)).toBe(2);
      expect(getReadCursor(h.feedbackApp.db, uid, fb2)).toBe(1);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("幂等：没有未读时再次调用返回 0，且不会回退既有游标", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-idempotent";
      const token = await createUserBearer(h, { username });
      const uid = userId(h, username);

      const fb = await submitFeedbackForTest(h, token, { text: "一次已读" });
      expect(await adminMessage(h, fb)).toBe(1);

      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });

      const again = await readAll(h, token);
      expect(again.status).toBe(200);
      expect(again.data).toEqual({ ok: true, markedFeedbacks: 0, markedMessages: 0 });
      expect(getReadCursor(h.feedbackApp.db, uid, fb)).toBe(1);
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
    } finally {
      h.feedbackApp.close();
    }
  });

  it("appId 作用域：指定 appId 只清该应用未读，缺省清全部", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-scope";
      const token = await createUserBearer(h, { username });
      const uid = userId(h, username);

      const fbA = await submitFeedbackForTest(h, token, { appId: h.app.appId, text: "应用 A 的问题" });
      const fbB = await submitFeedbackForTest(h, token, { appId: SECOND_APP, text: "应用 B 的问题" });
      expect(await adminMessage(h, fbA)).toBe(1);
      expect(await adminMessage(h, fbB)).toBe(1);

      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 2, totalUnreadMessages: 2 });
      expect(await unreadSummary(h, token, h.app.appId)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });

      // 指定应用 A：只清 A。
      expect((await readAll(h, token, h.app.appId)).data).toEqual({
        ok: true,
        markedFeedbacks: 1,
        markedMessages: 1,
      });
      expect(await unreadSummary(h, token, h.app.appId)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });
      expect(getReadCursor(h.feedbackApp.db, uid, fbA)).toBe(1);
      expect(getReadCursor(h.feedbackApp.db, uid, fbB)).toBe(0);

      // 无反馈的 appId：安全返回 0。
      expect((await readAll(h, token, "com.test.unknown")).data).toEqual({
        ok: true,
        markedFeedbacks: 0,
        markedMessages: 0,
      });

      // 缺省 appId：清剩余全部。
      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(getReadCursor(h.feedbackApp.db, uid, fbB)).toBe(1);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("账号隔离：只清本人未读，他人反馈与游标不受影响", async () => {
    const h = await makeHarness();
    try {
      const tokenA = await createUserBearer(h, { username: "user-readall-a" });
      const tokenB = await createUserBearer(h, { username: "user-readall-b" });
      const uidA = userId(h, "user-readall-a");
      const uidB = userId(h, "user-readall-b");

      const fbA = await submitFeedbackForTest(h, tokenA, { text: "A 的问题" });
      const fbB = await submitFeedbackForTest(h, tokenB, { text: "B 的问题" });
      expect(await adminMessage(h, fbA)).toBe(1);
      expect(await adminMessage(h, fbB)).toBe(1);

      expect((await readAll(h, tokenA)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(await unreadSummary(h, tokenA)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(await unreadSummary(h, tokenB)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });
      expect(getReadCursor(h.feedbackApp.db, uidA, fbA)).toBe(1);
      expect(getReadCursor(h.feedbackApp.db, uidB, fbB)).toBe(0);

      // B 自己的一键已读同样只影响 B。
      expect((await readAll(h, tokenB)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(await unreadSummary(h, tokenB)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(await unreadSummary(h, tokenA)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(getReadCursor(h.feedbackApp.db, uidB, fbB)).toBe(1);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("清除后管理员再发消息会重新计为未读，可再次一键已读", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-newmsg";
      const token = await createUserBearer(h, { username });
      const uid = userId(h, username);

      const fb = await submitFeedbackForTest(h, token, { text: "后续消息" });
      expect(await adminMessage(h, fb)).toBe(1);
      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });

      expect(await adminMessage(h, fb, "清除后的新消息")).toBe(2);
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });

      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      expect(getReadCursor(h.feedbackApp.db, uid, fb)).toBe(2);
    } finally {
      h.feedbackApp.close();
    }
  });

  it("回收站反馈不计入（与 unread-summary 同口径），恢复后重新计入", async () => {
    const h = await makeHarness();
    try {
      const username = "user-readall-trash";
      const token = await createUserBearer(h, { username });
      const uid = userId(h, username);

      const fbTrashed = await submitFeedbackForTest(h, token, { text: "将被移入回收站" });
      const fbActive = await submitFeedbackForTest(h, token, { text: "正常反馈" });
      expect(await adminMessage(h, fbTrashed)).toBe(1);
      expect(await adminMessage(h, fbActive)).toBe(1);

      await lifecycle(h, "trash", fbTrashed);

      // unread-summary 与 read-all 都排除回收站：只清正常反馈。
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });
      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(getReadCursor(h.feedbackApp.db, uid, fbActive)).toBe(1);
      expect(getReadCursor(h.feedbackApp.db, uid, fbTrashed)).toBe(0);
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });

      // 恢复后仍在回收站期间未被清除的未读重新计入，并可再次一键已读。
      await lifecycle(h, "restore", fbTrashed);
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 1, totalUnreadMessages: 1 });
      expect((await readAll(h, token)).data).toEqual({ ok: true, markedFeedbacks: 1, markedMessages: 1 });
      expect(getReadCursor(h.feedbackApp.db, uid, fbTrashed)).toBe(1);
      expect(await unreadSummary(h, token)).toEqual({ unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
    } finally {
      h.feedbackApp.close();
    }
  });
});
