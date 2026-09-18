import { describe, expect, it } from "vitest";
import { getFeedback } from "../src/db/repos.ts";
import {
  authorizeArchive,
  confirmSource,
  createTestPng,
  defaultSubmitBody,
  disableAutoArchive,
  enableAutoArchive,
  getAppDetail,
  getFeedbackDetail,
  type Harness,
  jsonReq,
  loginAsClient,
  makeHarness,
  saveAppDefaults,
  submitFeedback,
  submitMultipartFeedback,
} from "./helpers.ts";

/**
 * T4：软件软删除与同 appId 重新发现。
 * 覆盖：DELETE 幂等语义、历史反馈/截图/日志/审计保留、配置端点拒绝已删除记录、
 * 握手校验拒绝已删除记录、同 appId 重新提交产生全新内部记录、幂等重放/非法/超额
 * 不产生软件记录、自动归档扫描跳过已删除软件、已授权任务按固定快照继续。
 */

async function listApps(h: Harness) {
  return jsonReq(h.feedbackApp.app, "GET", "/api/admin/apps", { cookie: h.cookie });
}

async function deleteApp(h: Harness, appId: string) {
  return jsonReq(h.feedbackApp.app, "DELETE", `/api/admin/apps/${appId}`, { cookie: h.cookie });
}

describe("软件软删除", () => {
  it("删除后软件从列表消失、详情与配置端点返回 404；重复删除 204、不存在 404", async () => {
    const h = await makeHarness();
    const appId = h.app.id;

    const del = await deleteApp(h, appId);
    expect(del.status).toBe(204);

    const apps = (await listApps(h)).data.apps as any[];
    expect(apps.some((a) => a.id === appId)).toBe(false);

    expect((await getAppDetail(h, appId)).status).toBe(404);
    // 显式传 expectedRuleVersion：helper 的自动读取会先走 404 的详情接口。
    expect((await saveAppDefaults(h, { appId, expectedRuleVersion: 0 })).status).toBe(404);
    expect((await enableAutoArchive(h, { appId, expectedRuleVersion: null })).status).toBe(404);
    expect((await disableAutoArchive(h, { appId, expectedRuleVersion: null })).status).toBe(404);
    expect((await confirmSource(h, "http://host.test", { appId, expectedRuleVersion: null })).status).toBe(404);

    // 幂等：重复删除仍 204；从未存在 → 404
    expect((await deleteApp(h, appId)).status).toBe(204);
    expect((await deleteApp(h, "no-such-app-row")).status).toBe(404);
  });

  it("删除保留历史反馈、截图、日志与审计；详情标记所属软件已删除", async () => {
    const h = await makeHarness();
    const png = await createTestPng(60, 40);
    const logBuf = Buffer.from("hello log\nstack line\n");
    const submitted = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ logs: [{ filename: "app.log", source: "manual" }] }),
      png,
      [{ filename: "app.log", buffer: logBuf }],
    );
    expect(submitted.status).toBe(201);
    const feedbackId = submitted.data.feedbackId as string;
    await h.feedbackApp.worker.idle();

    // 人工归档授权 → 产生审计记录（不必等远端流程完成）
    const auth = await authorizeArchive(h, feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();

    expect((await deleteApp(h, h.app.id)).status).toBe(204);

    // 反馈详情仍可读，附件与审计完整；所属软件标记已删除
    const detail = await getFeedbackDetail(h, feedbackId);
    expect(detail.status).toBe(200);
    expect(detail.data.app?.deletedAt).toBeTruthy();
    expect(detail.data.appDeleted).toBe(true);
    expect(detail.data.screenshot?.byteSize).toBeGreaterThan(0);
    expect(detail.data.logs).toHaveLength(1);
    expect((detail.data.audit as any[]).length).toBeGreaterThan(0);

    const shot = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${feedbackId}/screenshot`, {
      cookie: h.cookie,
    });
    expect(shot.status).toBe(200);
    const log = await jsonReq(
      h.feedbackApp.app,
      "GET",
      `/api/admin/feedback/${feedbackId}/logs/${detail.data.logs[0].id}/download`,
      { cookie: h.cookie },
    );
    expect(log.status).toBe(200);
    expect(log.text).toContain("hello log");

    // 数据库行全部保留：反馈指向原软件行，审计未级联删除
    const fb = getFeedback(h.feedbackApp.db, feedbackId)!;
    expect(fb.app_row_id).toBe(h.app.id);
    const audits = h.feedbackApp.db
      .prepare("SELECT COUNT(*) AS n FROM feedback_audit WHERE feedback_id = ?")
      .get(feedbackId) as { n: number };
    expect(Number(audits.n)).toBeGreaterThan(0);
  });

  it("删除后同 appId 有效提交重新发现为全新内部记录：不继承配置/规则/来源授权", async () => {
    const h = await makeHarness();
    const oldAppId = h.app.id;
    // 旧反馈（带截图 + 日志），让旧记录有历史
    const first = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-old-1" }));
    expect(first.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const oldFeedbackId = first.data.feedbackId as string;

    expect((await deleteApp(h, oldAppId)).status).toBe(204);

    const second = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-new-1" }));
    expect(second.status).toBe(201);

    const apps = (await listApps(h)).data.apps as any[];
    const rediscovered = apps.find((a) => a.appId === "com.test.app");
    expect(rediscovered).toBeTruthy();
    expect(rediscovered.id).not.toBe(oldAppId);
    expect(rediscovered.configStatus).toBe("pending");
    expect(rediscovered.archiveMode).toBe("manual");
    expect(rediscovered.ruleVersion).toBe(0);

    // 新反馈关联新内部 id；旧反馈仍关联旧（已删除）记录
    const newRow = getFeedback(h.feedbackApp.db, second.data.feedbackId as string)!;
    const oldRow = getFeedback(h.feedbackApp.db, oldFeedbackId)!;
    expect(newRow.app_row_id).toBe(rediscovered.id);
    expect(oldRow.app_row_id).toBe(oldAppId);

    // 新记录的来源是待确认（不继承旧来源确认）
    const detail = await getAppDetail(h, rediscovered.id);
    expect(detail.status).toBe(200);
    const srcs = detail.data.sources as any[];
    expect(srcs.every((s) => s.status === "pending")).toBe(true);
  });

  it("幂等重放、非法请求与额度不足都不重新发现软件", async () => {
    const h = await makeHarness();
    const first = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-idem" }));
    expect(first.status).toBe(201);
    await h.feedbackApp.worker.idle();
    expect((await deleteApp(h, h.app.id)).status).toBe(204);

    // 幂等重放同键同内容 → 返回原记录，不创建新软件
    const replay = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-idem" }));
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect((await listApps(h)).data.apps).toHaveLength(0);

    // 非法请求（空文本 / 缺 idempotencyKey）不产生软件
    expect(
      (await submitFeedback(h.feedbackApp, h.bearer, { idempotencyKey: "k-x", appId: "com.test.app", text: "" }))
        .status,
    ).toBe(400);
    expect((await submitFeedback(h.feedbackApp, h.bearer, { appId: "com.test.app", text: "hi" })).status).toBe(400);
    expect((await listApps(h)).data.apps).toHaveLength(0);

    // 额度耗尽：daily_limit=1 的账号第二次提交 429，不产生软件
    const lowQuota = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/users", {
      cookie: h.cookie,
      body: { username: "limited-user", password: "hunter2-correct-horse", dailyLimit: 1 },
    });
    expect(lowQuota.status).toBe(201);
    const login = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
      origin: "http://host.test",
      body: {
        username: "limited-user",
        password: "hunter2-correct-horse",
        clientLabel: "t",
        appId: "com.test.app",
      },
    });
    expect(login.status).toBe(200);
    const quotaBearer = login.data.token as string;
    const ok = await submitFeedback(h.feedbackApp, quotaBearer, defaultSubmitBody({ idempotencyKey: "k-q1" }));
    expect(ok.status).toBe(201);
    const over = await submitFeedback(h.feedbackApp, quotaBearer, defaultSubmitBody({ idempotencyKey: "k-q2" }));
    expect(over.status).toBe(429);
    // 只有一次有效提交 → 只重新发现一次软件
    expect((await listApps(h)).data.apps).toHaveLength(1);
  });

  it("活跃 appId 保持唯一：重复 POST /apps 仍 409；删除后管理员可重新登记为独立记录", async () => {
    const h = await makeHarness();
    const dup = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
      cookie: h.cookie,
      body: {
        appId: "com.test.app",
        name: "重复软件",
        allowedOrigins: [],
        kaneoProjectId: "",
        kaneoColumnSlug: "",
      },
    });
    expect(dup.status).toBe(409);

    expect((await deleteApp(h, h.app.id)).status).toBe(204);
    const reAdd = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
      cookie: h.cookie,
      body: {
        appId: "com.test.app",
        name: "重新登记",
        allowedOrigins: ["http://host.test"],
        kaneoProjectId: "proj-1",
        kaneoColumnSlug: "triage",
      },
    });
    expect(reAdd.status).toBe(201);
    expect(reAdd.data.id).not.toBe(h.app.id);
    // 与旧记录相互独立：再次重复登记仍 409
    expect(
      (
        await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
          cookie: h.cookie,
          body: {
            appId: "com.test.app",
            name: "又一条",
            allowedOrigins: [],
            kaneoProjectId: "",
            kaneoColumnSlug: "",
          },
        })
      ).status,
    ).toBe(409);
  });

  it("握手校验拒绝已删除软件；客户端登录不创建软件", async () => {
    const h = await makeHarness();
    // 删除前：握手校验通过
    const okCheck = await jsonReq(
      h.feedbackApp.app,
      "GET",
      "/api/auth/handshake/validate?appId=com.test.app&origin=http%3A%2F%2Fhost.test",
      { cookie: h.cookie },
    );
    expect(okCheck.status).toBe(200);

    expect((await deleteApp(h, h.app.id)).status).toBe(204);
    const check = await jsonReq(
      h.feedbackApp.app,
      "GET",
      "/api/auth/handshake/validate?appId=com.test.app&origin=http%3A%2F%2Fhost.test",
      { cookie: h.cookie },
    );
    expect(check.status).toBe(404);

    // 客户端登录本身不依赖软件登记，也不创建软件记录
    const bearer = await loginAsClient(h.feedbackApp, {});
    expect(bearer).toBeTruthy();
    expect((await listApps(h)).data.apps).toHaveLength(0);
  });

  it("已授权记录在软件删除后按固定快照完成归档（恢复信息保留）", async () => {
    const h = await makeHarness();
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-flight" }));
    expect(sub.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const flightId = sub.data.feedbackId as string;
    expect(getFeedback(h.feedbackApp.db, flightId)!.status).toBe("needs_info");

    // 授权后制造“任务创建结果未知”：记录转 needs_review，固定快照与恢复数据保留
    h.kaneo.createErrorQueue.push("uncertain");
    const auth = await authorizeArchive(h, flightId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const flight = getFeedback(h.feedbackApp.db, flightId)!;
    expect(flight.status).toBe("needs_review");
    expect(flight.archive_authorized_at).toBeTruthy();
    expect(flight.archive_data_json).toBeTruthy();

    expect((await deleteApp(h, h.app.id)).status).toBe(204);

    // 软件已删除：核对不重置状态（任务确实未创建），强制重建按固定快照完成归档
    const recheck = await h.feedbackApp.worker.recheck(flightId);
    expect(recheck.ok).toBe(true);
    expect(getFeedback(h.feedbackApp.db, flightId)!.status).toBe("needs_review");
    const fc = await h.feedbackApp.worker.forceCreate(flightId);
    expect(fc.ok).toBe(true);
    await h.feedbackApp.worker.idle();
    const done = getFeedback(h.feedbackApp.db, flightId)!;
    expect(done.status).toBe("archived");
    expect(done.kaneo_task_id).toBeTruthy();
    expect(h.kaneo.created).toHaveLength(1);
    expect(h.kaneo.created[0]!.projectId).toBe("proj-1"); // 固定快照目标
  });

  it("未授权的历史记录在软件删除后不再获得自动归档授权", async () => {
    const h = await makeHarness();
    // 自动归档已启用：证明活跃时确实会自动授权
    expect((await saveAppDefaults(h)).status).toBe(200);
    expect((await enableAutoArchive(h)).status).toBe(200);
    const auto = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-auto" }));
    expect(auto.status).toBe(201);
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, auto.data.feedbackId as string)!.status).toBe("archived");
    expect(h.kaneo.created).toHaveLength(1);

    // 关闭自动归档后再留一条 needs_info 积压（新提交在人工模式下不授权）
    expect((await disableAutoArchive(h)).status).toBe(200);
    const pend = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody({ idempotencyKey: "k-pend" }));
    expect(pend.status).toBe(201);
    await h.feedbackApp.worker.idle();
    const pendId = pend.data.feedbackId as string;
    expect(getFeedback(h.feedbackApp.db, pendId)!.status).toBe("needs_info");

    expect((await deleteApp(h, h.app.id)).status).toBe(204);

    // 删除后扫描与直接处理都不产生新授权/远端写入，记录标记为配置阻塞
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    await h.feedbackApp.worker.processOne(pendId);
    const after = getFeedback(h.feedbackApp.db, pendId)!;
    expect(after.status).toBe("needs_info");
    expect(after.archive_authorized_at).toBeNull();
    expect(after.auto_blocked_kind).toBe("config");
    expect(after.auto_blocked_reason).toContain("已删除");
    expect(h.kaneo.created).toHaveLength(1);
  });
});
