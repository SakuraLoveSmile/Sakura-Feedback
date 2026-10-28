import { describe, expect, it } from "vitest";
import {
  appRuleVersion,
  defaultSubmitBody,
  getAppDetail,
  getFeedbackDetail,
  type Harness,
  jsonReq,
  makeHarness,
  saveAppDefaults,
  submitFeedback,
} from "./helpers.ts";

/**
 * Feedback-3 / T1：规则保存状态可信 —— 创建与保存的回读契约。
 *
 * 覆盖点：
 * - POST 创建必须写入完整默认目标（修复前：只写项目/列 slug，丢 columnId/labelIds/assignee，
 *   回读 ruleComplete=false 误报缺项）；字段缺失按清空、类型非法按 400（与 PUT 相同语义）。
 * - PUT 普通保存回读一致、版本推进；过期 expectedRuleVersion → 409 且一个字节都不写。
 * - 规则缺项可区分（缺 columnId / 缺 labelIds → ruleComplete=false 且 defaults 字段指明缺什么）。
 * - 普通保存零副作用：不改 archiveMode、零远端写入、不产生归档授权。
 */

/** POST /api/admin/apps 创建软件（测试文件内局部 helper；helpers.ts 的 seedApp 不带规则字段）。 */
function createAppReq(h: Harness, body: Record<string, unknown>) {
  return jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", { cookie: h.cookie, body });
}

const FULL_RULE = {
  kaneoProjectId: "proj-1",
  kaneoColumnId: "col-db-id",
  kaneoColumnSlug: "triage",
  kaneoLabelIds: ["label-bug"],
  kaneoAssigneeId: "user-1",
  kaneoAssigneeName: "负责人甲",
} as const;

const FULL_DEFAULTS = {
  projectId: "proj-1",
  columnId: "col-db-id",
  columnSlug: "triage",
  labelIds: ["label-bug"],
  assigneeId: "user-1",
  assigneeName: "负责人甲",
} as const;

describe("POST 创建：完整规则字段必须落库", () => {
  it("带完整默认目标创建 → 响应与 GET 回读一致且 ruleComplete=true", async () => {
    const h = await makeHarness();
    const created = await createAppReq(h, {
      appId: "com.full.create",
      name: "完整创建",
      allowedOrigins: ["http://full.test"],
      ...FULL_RULE,
    });
    expect(created.status).toBe(201);
    // 创建响应即服务端已存行的序列化
    expect(created.data.ruleComplete).toBe(true);
    expect(created.data.defaults).toMatchObject(FULL_DEFAULTS);
    expect(created.data.archiveMode).toBe("manual");

    // GET 回读确认：defaults 各 ID/labelIds 与所存字段一致
    const detail = await getAppDetail(h, created.data.id);
    expect(detail.status).toBe(200);
    expect(detail.data.app.ruleComplete).toBe(true);
    expect(detail.data.app.defaults).toMatchObject(FULL_DEFAULTS);
    // 管理员显式登记的允许来源直接是已确认来源
    expect(detail.data.sources).toContainEqual(
      expect.objectContaining({ origin: "http://full.test", status: "confirmed" }),
    );
  });

  it("创建时规则字段缺失按清空处理（与 PUT 相同语义）", async () => {
    const h = await makeHarness();
    const created = await createAppReq(h, {
      appId: "com.empty.create",
      name: "缺项创建",
      allowedOrigins: [],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: "triage",
      // kaneoColumnId / kaneoLabelIds / kaneoAssignee* 全部缺省 → 清空
    });
    expect(created.status).toBe(201);
    expect(created.data.ruleComplete).toBe(false);
    expect(created.data.defaults).toMatchObject({
      projectId: "proj-1",
      columnId: "",
      columnSlug: "triage",
      labelIds: [],
      assigneeId: null,
      assigneeName: null,
    });

    const detail = await getAppDetail(h, created.data.id);
    expect(detail.data.app.ruleComplete).toBe(false);
    expect(detail.data.app.defaults.columnId).toBe("");
    expect(detail.data.app.defaults.labelIds).toEqual([]);
  });

  it("创建时规则字段类型非法 → 400 且不产生记录", async () => {
    const h = await makeHarness();
    const badLabels = await createAppReq(h, {
      appId: "com.bad.labels",
      name: "非法标签",
      allowedOrigins: [],
      kaneoLabelIds: "not-an-array",
    });
    expect(badLabels.status).toBe(400);
    expect(badLabels.data.error.code).toBe("invalid_request");

    const badColumn = await createAppReq(h, {
      appId: "com.bad.column",
      name: "非法列",
      allowedOrigins: [],
      kaneoColumnId: 123,
    });
    expect(badColumn.status).toBe(400);

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const ids = (apps.data.apps as Array<{ appId: string }>).map((a) => a.appId);
    expect(ids).not.toContain("com.bad.labels");
    expect(ids).not.toContain("com.bad.column");
  });
});

describe("PUT 普通保存：回读一致与版本契约", () => {
  it("保存完整规则 → GET 回读 ID/标签一致、ruleComplete=true、版本推进", async () => {
    const h = await makeHarness();
    const before = await appRuleVersion(h);
    const saved = await saveAppDefaults(h);
    expect(saved.status).toBe(200);
    expect(saved.data.ruleComplete).toBe(true);
    expect(saved.data.ruleVersion).toBe(before + 1);

    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleComplete).toBe(true);
    expect(detail.data.app.defaults).toMatchObject({
      projectId: "proj-1",
      columnId: "col-db-id",
      columnSlug: "triage",
      labelIds: ["label-bug"],
    });
  });

  it("只存 columnSlug 缺 columnId → ruleComplete=false 且回读能区分缺的是列 ID", async () => {
    const h = await makeHarness();
    const saved = await saveAppDefaults(h, { columnId: "" });
    expect(saved.status).toBe(200);
    expect(saved.data.ruleComplete).toBe(false);

    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleComplete).toBe(false);
    // slug 存了但 ID 缺失 —— 页面可据此列出「缺目标列 ID」而非笼统「规则不完整」
    expect(detail.data.app.defaults.columnSlug).toBe("triage");
    expect(detail.data.app.defaults.columnId).toBe("");
    expect(detail.data.app.defaults.projectId).toBe("proj-1");
    expect(detail.data.app.defaults.labelIds).toEqual(["label-bug"]);
  });

  it("缺 labelIds → ruleComplete=false 且回读能区分缺的是工作区标签", async () => {
    const h = await makeHarness();
    const saved = await saveAppDefaults(h, { labelIds: [] });
    expect(saved.status).toBe(200);
    expect(saved.data.ruleComplete).toBe(false);

    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleComplete).toBe(false);
    expect(detail.data.app.defaults.labelIds).toEqual([]);
    // 其余字段不缺：缺项只有标签
    expect(detail.data.app.defaults.projectId).toBe("proj-1");
    expect(detail.data.app.defaults.columnId).toBe("col-db-id");
  });

  it("缺项目 → ruleComplete=false 且回读能区分缺的是 Kaneo 项目", async () => {
    const h = await makeHarness();
    const saved = await saveAppDefaults(h, { projectId: "" });
    expect(saved.status).toBe(200);
    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleComplete).toBe(false);
    expect(detail.data.app.defaults.projectId).toBe("");
    expect(detail.data.app.defaults.columnId).toBe("col-db-id");
    expect(detail.data.app.defaults.labelIds).toEqual(["label-bug"]);
  });

  it("过期 expectedRuleVersion → 409 version_conflict 且库内数据未变", async () => {
    const h = await makeHarness();
    const saved = await saveAppDefaults(h);
    expect(saved.status).toBe(200);
    const current = await appRuleVersion(h);

    const conflict = await saveAppDefaults(h, {
      name: "不应写入的名称",
      columnId: "col-should-not-write",
      expectedRuleVersion: current - 1,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe("version_conflict");

    // 冲突时一个字节都不写：版本、名称与目标保持原值
    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleVersion).toBe(current);
    expect(detail.data.app.name).toBe("测试软件");
    expect(detail.data.app.defaults.columnId).toBe("col-db-id");
  });

  it("两次连续 PUT 版本递增；持旧版本再写必 409", async () => {
    const h = await makeHarness();
    const v0 = await appRuleVersion(h);

    const s1 = await saveAppDefaults(h);
    expect(s1.status).toBe(200);
    expect(s1.data.ruleVersion).toBe(v0 + 1);

    const s2 = await saveAppDefaults(h);
    expect(s2.status).toBe(200);
    expect(s2.data.ruleVersion).toBe(v0 + 2);

    // 仍持第一版写入 → 冲突；持最初版本写入 → 也冲突
    const stale1 = await saveAppDefaults(h, { expectedRuleVersion: v0 + 1 });
    expect(stale1.status).toBe(409);
    expect(stale1.data.error.code).toBe("version_conflict");
    const stale0 = await saveAppDefaults(h, { expectedRuleVersion: v0 });
    expect(stale0.status).toBe(409);

    const detail = await getAppDetail(h);
    expect(detail.data.app.ruleVersion).toBe(v0 + 2);
  });
});

describe("普通保存零副作用", () => {
  it("保存后 archiveMode 仍 manual、零远端写入、反馈不产生授权", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    expect(sub.status).toBe(201);
    const feedbackId = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();

    const saved = await saveAppDefaults(h);
    expect(saved.status).toBe(200);
    expect(saved.data.archiveMode).toBe("manual"); // 普通保存不改归档模式

    // 保存触发的补处理扫描也不得在人工模式下授权
    await h.feedbackApp.worker.idle();

    const detail = await getAppDetail(h);
    expect(detail.data.app.archiveMode).toBe("manual");

    const feedback = await getFeedbackDetail(h, feedbackId);
    expect(feedback.data.archiveAuthorized).toBe(false);
    expect(feedback.data.collectionState).toBe("waiting_manual_archive");

    // 零远端写入：普通保存绝不写 Kaneo（创建任务/传资产/评论/标签都未发生）
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);
  });
});
