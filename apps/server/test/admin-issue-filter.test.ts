import { describe, expect, it } from "vitest";
import {
  defaultSubmitBody,
  getFeedbackDetail,
  type Harness,
  jsonReq,
  makeHarness,
  submitAndArchive,
  submitFeedback,
} from "./helpers.ts";

/** 管理端设置工单状态（issue-status 路由）。 */
async function setIssueStatus(h: Harness, id: string, issueStatus: string, resolutionNote?: string) {
  const r = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/issue-status`, {
    cookie: h.cookie,
    body: resolutionNote === undefined ? { issueStatus } : { issueStatus, resolutionNote },
  });
  if (r.status !== 200) throw new Error(`设置工单状态失败 ${id} → ${issueStatus}: ${r.status} ${r.text}`);
}

/** 管理区域迁移（lifecycle 路由），自动读取当前 lifecycleVersion。 */
async function lifecycle(h: Harness, action: string, id: string) {
  const detail = await getFeedbackDetail(h, id);
  const v = detail.data.lifecycleVersion as number;
  const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/feedback/lifecycle", {
    cookie: h.cookie,
    body: { action, items: [{ id, expectedVersion: v }] },
  });
  if (r.status !== 200 || r.data.results?.[0]?.ok !== true) {
    throw new Error(`生命周期 ${action} 失败 ${id}: ${r.status} ${r.text}`);
  }
}

/** 同一筛选条件下三个区域的列表条数（trash 含在 all 之外的独立区域）。 */
async function listCount(h: Harness, query: string, view: string): Promise<number> {
  const r = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?view=${view}&limit=100&${query}`, {
    cookie: h.cookie,
  });
  if (r.status !== 200) throw new Error(`列表请求失败 view=${view} ${query}: ${r.status} ${r.text}`);
  return (r.data.items as unknown[]).length;
}

/** 断言：counts 与逐区域列表长度一致。 */
async function expectCountsMatchList(h: Harness, query: string) {
  const counts = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/counts?${query}`, {
    cookie: h.cookie,
  });
  expect(counts.status).toBe(200);
  for (const view of ["inbox", "archived", "trash"] as const) {
    expect(await listCount(h, query, view), `${query} @ ${view}`).toBe(counts.data[view]);
  }
  return counts.data as { inbox: number; archived: number; trash: number };
}

/** 全部 id 列表（view 下不分页，便于集合断言）。 */
async function listIds(h: Harness, query: string, view: string): Promise<string[]> {
  const r = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback?view=${view}&limit=100&${query}`, {
    cookie: h.cookie,
  });
  return (r.data.items as Array<{ id: string }>).map((it) => it.id);
}

describe("T4: 工单状态筛选 counts 与列表一致", () => {
  it("混合工单状态下各区域计数 == 同条件列表；清空筛选恢复全量", async () => {
    const h = await makeHarness();
    try {
      // inbox：open（A 新提交，默认 open）、waiting_user（B）
      const a = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "按钮点击无反应" }));
      const b = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "导出功能报错" }));
      const A = a.data.feedbackId as string;
      const B = b.data.feedbackId as string;
      // archived：waiting_admin（C，完整归档后移入已归档区域）
      const C = await submitAndArchive(h, { text: "归档后仍需跟进的问题" });
      await lifecycle(h, "archive", C);
      // trash：resolved（D，先置状态再移回收站——回收站记录拒绝改状态）
      const d = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "重复反馈作废" }));
      const D = d.data.feedbackId as string;
      await setIssueStatus(h, D, "resolved", "重复反馈，合并处理");
      await lifecycle(h, "trash", D);

      await setIssueStatus(h, B, "waiting_user");
      await setIssueStatus(h, C, "waiting_admin");

      // 无筛选：四个反馈各居其区域，counts 与列表一致
      expect(await expectCountsMatchList(h, "")).toEqual({ inbox: 2, archived: 1, trash: 1 });

      // issueStatus=open：只有 A（inbox）
      expect(await expectCountsMatchList(h, "issueStatus=open")).toEqual({ inbox: 1, archived: 0, trash: 0 });
      expect(await listIds(h, "issueStatus=open", "inbox")).toEqual([A]);

      // issueStatus=waiting_user：只有 B（inbox）
      expect(await expectCountsMatchList(h, "issueStatus=waiting_user")).toEqual({
        inbox: 1,
        archived: 0,
        trash: 0,
      });
      expect(await listIds(h, "issueStatus=waiting_user", "inbox")).toEqual([B]);

      // issueStatus=waiting_admin：只有 C（archived 区域）
      expect(await expectCountsMatchList(h, "issueStatus=waiting_admin")).toEqual({
        inbox: 0,
        archived: 1,
        trash: 0,
      });
      expect(await listIds(h, "issueStatus=waiting_admin", "archived")).toEqual([C]);

      // issueStatus=resolved：只有 D（trash 区域）
      expect(await expectCountsMatchList(h, "issueStatus=resolved")).toEqual({
        inbox: 0,
        archived: 0,
        trash: 1,
      });
      expect(await listIds(h, "issueStatus=resolved", "trash")).toEqual([D]);

      // 与其他筛选组合：issueStatus + 关键词
      expect(await expectCountsMatchList(h, `issueStatus=open&q=${encodeURIComponent("按钮")}`)).toEqual({
        inbox: 1,
        archived: 0,
        trash: 0,
      });
      expect(await expectCountsMatchList(h, `issueStatus=open&q=${encodeURIComponent("不存在")}`)).toEqual({
        inbox: 0,
        archived: 0,
        trash: 0,
      });

      // 清空筛选（显式空值与省略一致）：恢复全量
      expect(await expectCountsMatchList(h, "issueStatus=")).toEqual({ inbox: 2, archived: 1, trash: 1 });
      expect(await expectCountsMatchList(h, "")).toEqual({ inbox: 2, archived: 1, trash: 1 });
    } finally {
      h.feedbackApp.close();
    }
  });

  it("非法 issueStatus 对列表与 counts 均返回 400", async () => {
    const h = await makeHarness();
    try {
      for (const bad of ["bogus", "OPEN", "deleted", "resolved1", " open"]) {
        const list = await jsonReq(
          h.feedbackApp.app,
          "GET",
          `/api/admin/feedback?issueStatus=${encodeURIComponent(bad)}`,
          { cookie: h.cookie },
        );
        expect(list.status, `list issueStatus=${bad}`).toBe(400);
        expect(list.data.error.code).toBe("invalid_request");

        const counts = await jsonReq(
          h.feedbackApp.app,
          "GET",
          `/api/admin/feedback/counts?issueStatus=${encodeURIComponent(bad)}`,
          { cookie: h.cookie },
        );
        expect(counts.status, `counts issueStatus=${bad}`).toBe(400);
        expect(counts.data.error.code).toBe("invalid_request");
      }

      // 非法参数不影响合法筛选继续工作
      const ok = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback?issueStatus=open", {
        cookie: h.cookie,
      });
      expect(ok.status).toBe(200);
      const okCounts = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback/counts?issueStatus=open", {
        cookie: h.cookie,
      });
      expect(okCounts.status).toBe(200);
    } finally {
      h.feedbackApp.close();
    }
  });
});
