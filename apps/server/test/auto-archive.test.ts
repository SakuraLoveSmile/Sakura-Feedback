import { describe, expect, it } from "vitest";
import {
  confirmSource,
  createUserBearer,
  defaultSubmitBody,
  disableAutoArchive,
  enableAutoArchive,
  getAppDetail,
  getFeedbackDetail,
  jsonReq,
  makeFakeClock,
  makeHarness,
  prepareAutoArchive,
  saveAppDefaults,
  submitFeedback,
} from "./helpers.ts";

/**
 * T1–T4：先接收、后配置、自动归档。
 *
 * 覆盖点：
 * - T1 未登记软件也能登录/提交；首次有效提交自动发现待配置软件；并发只建一条；失败与重放不产生空软件。
 * - T2 待确认来源；普通保存不触发归档；显式启用才处理积压；关闭只阻止新授权。
 * - T3 AI 完成后按规则自动授权（幂等、规则版本、可恢复扫描、阻塞与退避）。
 * - T4 collectionState 语义与来源隔离。
 */
describe("T1：未登记软件也能接收", () => {
  it("首次有效提交创建待配置软件并记录待确认来源，零远端写入", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.discovered.app" }));
    expect(r.status).toBe(201);
    expect(r.data.collectionState).toBe("waiting_configuration");

    const detail = await getAppDetail(h, h.app.id);
    expect(detail.status).toBe(200);

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const discovered = (apps.data.apps as Array<Record<string, unknown>>).find((a) => a.appId === "com.discovered.app");
    expect(discovered).toBeTruthy();
    expect(discovered?.configStatus).toBe("pending");
    expect(discovered?.archiveMode).toBe("manual");
    expect(discovered?.ruleComplete).toBe(false);
    expect(discovered?.pendingSources).toBe(1);
    expect(discovered?.waitingFeedbacks).toBe(1);

    const sources = await getAppDetail(h, String(discovered?.id));
    expect(sources.data.sources).toHaveLength(1);
    expect(sources.data.sources[0]).toMatchObject({ origin: "http://localhost", kind: "browser", status: "pending" });

    // 未配置软件时绝不发生任何远端写入
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("并发提交同一 appId 只创建一条软件记录", async () => {
    const h = await makeHarness();
    // 额度按账号计算：并发提交用额度充足的独立账号。
    const bearer = await createUserBearer(h, { username: "concurrent-user", dailyLimit: 50 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        submitFeedback(
          h.feedbackApp,
          bearer,
          defaultSubmitBody({ appId: "com.concurrent.app", idempotencyKey: `concurrent-${i}` }),
        ),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const matches = (apps.data.apps as Array<{ appId: string }>).filter((a) => a.appId === "com.concurrent.app");
    expect(matches).toHaveLength(1);
  });

  it("额度用尽与幂等重放都不产生空软件记录", async () => {
    const h = await makeHarness();
    // 管理员额度：默认 3 次/日。先用完额度。
    const used = [];
    for (let i = 0; i < 3; i++) {
      used.push(await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.quota.app" })));
    }
    expect(used.every((r) => r.status === 201)).toBe(true);

    const over = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.never.created" }));
    expect(over.status).toBe(429);
    expect(over.data.error.code).toBe("daily_quota_exceeded");

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    expect((apps.data.apps as Array<{ appId: string }>).some((a) => a.appId === "com.never.created")).toBe(false);
  });

  it("无 Origin 的原生客户端单独登记为 native 来源", async () => {
    const h = await makeHarness();
    const res = await h.feedbackApp.app.request("http://localhost/api/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${h.bearer}`, "content-type": "application/json" },
      body: JSON.stringify(defaultSubmitBody({ appId: "com.native.app" })),
    });
    expect(res.status).toBe(201);

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const app = (apps.data.apps as Array<{ id: string; appId: string }>).find((a) => a.appId === "com.native.app");
    const detail = await getAppDetail(h, app?.id);
    expect(detail.data.sources).toHaveLength(1);
    expect(detail.data.sources[0]).toMatchObject({ origin: "native", kind: "native", status: "pending" });
  });
});

describe("T1：组件端点的跨域策略", () => {
  it("预检允许任意合法来源且不带凭据；跨源请求不认后台 Cookie", async () => {
    const h = await makeHarness();
    const pre = await h.feedbackApp.app.request("http://localhost/api/feedback", {
      method: "OPTIONS",
      headers: { origin: "https://any-host.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://any-host.example");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

    // 跨源请求带上后台 Cookie：Cookie 一律不参与鉴权（只认 Bearer）
    const crossOriginWithCookie = await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", {
      cookie: h.cookie,
      origin: "https://evil.example",
    });
    expect(crossOriginWithCookie.status).toBe(401);

    // 同源 Cookie 仍然可用（后台管理页不受影响）
    const sameOrigin = await jsonReq(h.feedbackApp.app, "GET", "/api/auth/session", { cookie: h.cookie });
    expect(sameOrigin.status).toBe(200);

    // 非组件端点（人工恢复动作）不参与跨域放行
    const restorePre = await h.feedbackApp.app.request("http://localhost/api/feedback/abc/retry", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(restorePre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("T2：后台配置规则与确认来源", () => {
  it("普通保存不触发归档：反馈保持等待，Kaneo 零写入", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();

    const saved = await saveAppDefaults(h);
    expect(saved.status).toBe(200);
    expect(saved.data.ruleComplete).toBe(true);
    expect(saved.data.archiveMode).toBe("manual"); // 普通保存不改模式

    await h.feedbackApp.worker.idle();
    const detail = await getFeedbackDetail(h, id);
    expect(detail.data.archiveAuthorized).toBe(false);
    expect(detail.data.collectionState).toBe("waiting_manual_archive");
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("规则不完整时拒绝启用自动归档（422，且不写任何东西）", async () => {
    const h = await makeHarness();
    // 只给项目与列，不给标签
    const saved = await saveAppDefaults(h, { labelIds: [] });
    expect(saved.status).toBe(200);
    const enabled = await enableAutoArchive(h);
    expect(enabled.status).toBe(422);
    expect(enabled.data.error.code).toBe("incomplete_rule");

    const apps = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
    const app = (apps.data.apps as Array<{ id: string; archiveMode: string }>).find((a) => a.id === h.app.id);
    expect(app?.archiveMode).toBe("manual");
  });

  it("启用规则处理积压：历史与后续反馈各归档一次", async () => {
    const h = await makeHarness();
    const backlog = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "积压反馈" }));
    const backlogId = backlog.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    await prepareAutoArchive(h);
    await h.feedbackApp.worker.idle();

    // 积压被自动授权并归档一次
    expect(h.kaneo.created).toHaveLength(1);
    const detail = await getFeedbackDetail(h, backlogId);
    expect(detail.data.archiveAuthorized).toBe(true);
    expect(detail.data.archiveAuthorizedKind).toBe("auto");
    expect(detail.data.status).toBe("archived");
    expect(detail.data.collectionState).toBe("queued");

    // 后续反馈同样自动归档一次
    const later = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "后续反馈" }));
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(2);
    const laterDetail = await getFeedbackDetail(h, later.data.feedbackId as string);
    expect(laterDetail.data.status).toBe("archived");

    // 重复扫描不重复创建任务
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(2);
  });

  it("重复点击启用（同操作键）幂等且不重复补处理", async () => {
    const h = await makeHarness();
    await saveAppDefaults(h);
    const first = await enableAutoArchive(h, { operationId: "op-enable-1" });
    expect(first.status).toBe(200);
    await h.feedbackApp.worker.idle();
    const tasksAfterFirst = h.kaneo.created.length;

    const replay = await enableAutoArchive(h, { operationId: "op-enable-1" });
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(tasksAfterFirst);
  });

  it("规则版本不一致时拒绝启用（409）", async () => {
    const h = await makeHarness();
    await saveAppDefaults(h);
    const stale = await enableAutoArchive(h, { expectedRuleVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("version_conflict");
  });

  it("新来源默认待确认：自动模式下不授权，确认后补归档", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);

    // 新来源（另一站点）提交：先保存，不归档
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.test.app" }), {
      origin: "https://new-site.example",
    });
    const id = sub.data.feedbackId as string;
    expect(sub.status).toBe(201);
    expect(sub.data.collectionState).toBe("waiting_source_confirmation");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    const blocked = await getFeedbackDetail(h, id);
    expect(blocked.data.autoBlockedKind).toBe("config");
    expect(String(blocked.data.autoBlockedReason)).toContain("来源");

    // 管理员确认来源 → 自动补处理
    const confirmed = await confirmSource(h, "https://new-site.example");
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.source.status).toBe("confirmed");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const done = await getFeedbackDetail(h, id);
    expect(done.data.status).toBe("archived");
    expect(done.data.archiveAuthorizedKind).toBe("auto");
  });

  it("确认来源幂等：同操作键重复确认不重复补处理", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), { origin: "https://idem.example" });
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    const first = await confirmSource(h, "https://idem.example", { operationId: "confirm-1" });
    expect(first.status).toBe(200);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);

    const replay = await confirmSource(h, "https://idem.example", { operationId: "confirm-1" });
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
  });

  it("关闭自动归档只阻止新的授权：已授权任务继续，新反馈不再自动归档", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);

    const first = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "关闭前" }));
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const firstId = first.data.feedbackId as string;

    const off = await disableAutoArchive(h);
    expect(off.status).toBe(200);
    await h.feedbackApp.worker.idle();

    // 已授权的记录保持已归档（未被撤销）
    expect((await getFeedbackDetail(h, firstId)).data.status).toBe("archived");

    const second = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ text: "关闭后" }));
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1); // 未新增任务
    const secondDetail = await getFeedbackDetail(h, second.data.feedbackId as string);
    expect(secondDetail.data.archiveAuthorized).toBe(false);
    expect(secondDetail.data.collectionState).toBe("waiting_manual_archive");
  });

  it("自动授权后修改规则不会重定向已授权记录", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const authorizedDetail = await getFeedbackDetail(h, id);
    const pinnedColumn = authorizedDetail.data.classification.columnId as string;

    // 管理员把默认目标改到另一列（规则版本自增）
    const kaneo2 = h.kaneo;
    kaneo2.listColumns = async () => [
      { id: "col-db-id", slug: "triage", name: "待筛选" },
      { id: "col-other", slug: "other", name: "其他" },
    ];
    const saved = await saveAppDefaults(h, { columnId: "col-other", columnSlug: "other" });
    expect(saved.status).toBe(200);
    expect(Number(saved.data.ruleVersion)).toBeGreaterThan(Number(authorizedDetail.data.archiveRuleVersion));

    // 已授权记录的固定快照不变
    const after = await getFeedbackDetail(h, id);
    expect(after.data.classification.columnId).toBe(pinnedColumn);
    expect(after.data.status).toBe("archived");
  });
});

describe("T3：自动补归档的可靠性与阻塞", () => {
  it("Kaneo 读取出现可恢复故障：保留反馈并记录阻塞与退避时间", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    h.kaneo.readError = { kind: "uncertain", message: "连接中断" };

    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();

    const detail = await getFeedbackDetail(h, id);
    expect(detail.data.status).toBe("needs_info");
    expect(detail.data.archiveAuthorized).toBe(false);
    expect(detail.data.autoBlockedKind).toBe("retryable");
    expect(detail.data.autoNextAttemptAt).toBeTruthy();
    expect(h.kaneo.created).toHaveLength(0);
  });

  it("目标列失效属于配置问题：等待修正，不自动重试；修正后补处理", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    // 列被删除：只读核对失败（业务拒绝）
    h.kaneo.listColumns = async () => [];

    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    const detail = await getFeedbackDetail(h, id);
    expect(detail.data.autoBlockedKind).toBe("config");
    expect(String(detail.data.autoBlockedReason)).toContain("目标列");
    expect(detail.data.autoNextAttemptAt).toBeNull();
    expect(h.kaneo.created).toHaveLength(0);

    // 管理员修正规则指向新的有效列 → 保存后触发扫描补处理
    h.kaneo.listColumns = async () => [{ id: "col-2", slug: "triage-2", name: "新列" }];
    const saved = await saveAppDefaults(h, { columnId: "col-2", columnSlug: "triage-2" });
    expect(saved.status).toBe(200);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect((await getFeedbackDetail(h, id)).data.status).toBe("archived");
  });

  it("服务重启后的可恢复扫描补处理积压（推进时钟，不手动清退避）", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    // 让提交阶段无法完成归档（模拟服务在提交后、归档前停止）
    h.kaneo.readError = { kind: "uncertain", message: "服务停机中" };
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    // 重启：只依赖“重启恢复 + 到期定时器”这一入口
    h.kaneo.readError = null;
    const { resumeWorker } = await import("../src/app.ts");
    resumeWorker(h.feedbackApp);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0); // 退避未到期，重启不得提前重试
    await clock.advance(60_000);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect((await getFeedbackDetail(h, id)).data.status).toBe("archived");
  });

  it("人工已分类/已授权的记录不被自动补处理覆盖", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();

    // 管理员逐条人工授权
    const detail = await getFeedbackDetail(h, id);
    const auth = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${id}/classify`, {
      cookie: h.cookie,
      body: {
        action: "archive",
        classifyVersion: detail.data.classification.version,
        projectId: "proj-1",
        columnId: "col-db-id",
        columnSlug: "triage",
        labelIds: ["label-bug"],
      },
    });
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const manual = await getFeedbackDetail(h, id);
    expect(manual.data.archiveAuthorizedKind).toBe("manual");

    // 之后再启用自动归档：不产生第二个任务、也不改写人工授权
    await prepareAutoArchive(h);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const after = await getFeedbackDetail(h, id);
    expect(after.data.archiveAuthorizedKind).toBe("manual");
    expect(after.data.status).toBe("archived");
  });

  it("待配置软件的反馈在启用规则前一直等待且零远端写入", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ appId: "com.pending.app" }));
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();

    expect(h.kaneo.created).toHaveLength(0);
    const detail = await getFeedbackDetail(h, id);
    expect(detail.data.status).toBe("needs_info");
    expect(detail.data.collectionState).toBe("waiting_configuration");
  });
});

describe("T4：collectionState 契约", () => {
  it("提交与查询响应携带稳定的等待状态", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    expect(["waiting_manual_archive", "waiting_configuration", "queued"]).toContain(sub.data.collectionState);

    const status = await jsonReq(h.feedbackApp.app, "GET", `/api/feedback/${sub.data.feedbackId}`, {
      bearer: h.bearer,
    });
    expect(status.status).toBe(200);
    expect(typeof status.data.collectionState).toBe("string");
    // 旧字段保持不变，新版组件据此继续展示
    expect(status.data.id).toBe(sub.data.feedbackId);
    expect(status.data.status).toBeTruthy();
  });

  it("自动模式 + 待确认来源 → waiting_source_confirmation", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), { origin: "https://fresh.example" });
    expect(sub.data.collectionState).toBe("waiting_source_confirmation");
  });
});
