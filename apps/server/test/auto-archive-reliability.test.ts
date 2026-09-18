import { describe, expect, it, vi } from "vitest";
import { resumeWorker } from "../src/app.ts";
import { getFeedback } from "../src/db/repos.ts";
import {
  appRuleVersion,
  confirmSource,
  createUserBearer,
  defaultSubmitBody,
  disableAutoArchive,
  enableAutoArchive,
  getAppDetail,
  getFeedbackDetail,
  type Harness,
  jsonReq,
  makeFakeClock,
  makeHarness,
  prepareAutoArchive,
  saveAppDefaults,
  submitFeedback,
} from "./helpers.ts";

/**
 * T3/T2 验收用例（自动归档可靠性 + 版本契约）。
 *
 * 覆盖计划的通过标准：
 * 1. 人工保护矩阵（不完整 / 完整 / 清空后暂存）+「扫描后人工保存」事务内保护；
 * 2. 51 / 121 条积压一次启用后全部归档且各一次；混入人工、配置阻塞、未到期记录互不影响；
 * 3. 注入可恢复故障 + 推进时钟：到期前不重试、到期自动恢复、重启重排、重复触发、退出后零数据库访问；
 * 4. 两个页面共用同一版本时的来源确认 / 规则保存冲突，以及同一操作重放不重复授权。
 */
async function submitOnly(h: Harness, bearer: string, text: string): Promise<string> {
  const r = await submitFeedback(h.feedbackApp, bearer, defaultSubmitBody({ text }));
  if (r.status !== 201) throw new Error(`提交失败 ${r.status}: ${r.text}`);
  return r.data.feedbackId as string;
}

/** 人工暂存分类（action=save：只写分类与状态，绝不授权、绝不写远端）。 */
async function saveClassification(
  h: Harness,
  feedbackId: string,
  over: {
    projectId?: string | null;
    columnId?: string | null;
    columnSlug?: string | null;
    labelIds?: string[];
  } = {},
) {
  const detail = await getFeedbackDetail(h, feedbackId);
  const version = detail.data.classification.version as number;
  return jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${feedbackId}/classify`, {
    cookie: h.cookie,
    body: {
      action: "save",
      classifyVersion: version,
      projectId: over.projectId === undefined ? "proj-1" : over.projectId,
      columnId: over.columnId === undefined ? "col-db-id" : over.columnId,
      columnSlug: over.columnSlug === undefined ? "triage" : over.columnSlug,
      labelIds: over.labelIds ?? ["label-bug"],
    },
  });
}

/** 直接写入一条“先接收后配置”的积压记录（来源已确认、自动模式可处理）。 */
function insertBacklogRow(h: Harness, appRowId: string, id: string, text: string, count = 1): void {
  const stmt = h.feedbackApp.db.prepare(
    `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
       source_origin, archive_stage, classify_version, attempt_count, created_at, updated_at)
     VALUES (?, ?, 'com.test.app', '', ?, ?, ?, 'needs_info', 'http://localhost', 'task_pending', 0, 0, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    const rowId = count > 1 ? `${id}-${i}` : id;
    const rowText = count > 1 ? `${text} ${i}` : text;
    const at = new Date(Date.now() + i).toISOString();
    stmt.run(rowId, appRowId, rowText, `key-${rowId}`, `hash-${rowId}`, at, at);
  }
}

/** 直接写入一条“管理员已暂存过（缺项）”的记录：classify_version > 0，人工保护对象。 */
function insertManualRow(h: Harness, appRowId: string, id: string, text: string): void {
  const at = new Date().toISOString();
  h.feedbackApp.db
    .prepare(
      `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
         source_origin, archive_stage, classify_project_id, classify_labels_json, classify_version,
         classify_updated_at, classify_updated_by, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'com.test.app', '', ?, ?, ?, 'needs_info', 'http://localhost', 'task_pending',
         'proj-1', '[]', 1, ?, 'admin', 0, ?, ?)`,
    )
    .run(id, appRowId, text, `key-${id}`, `hash-${id}`, at, at, at);
}

describe("T3 人工保护：绝不自动覆盖人工内容", () => {
  it("不完整 / 完整 / 清空后暂存：启用自动归档后人工内容保留且零自动远端写入", async () => {
    const h = await makeHarness();
    const incomplete = await submitOnly(h, h.bearer, "不完整暂存");
    const complete = await submitOnly(h, h.bearer, "完整暂存");
    const cleared = await submitOnly(h, h.bearer, "清空暂存");
    await h.feedbackApp.worker.idle();

    // 1) 缺项暂存：只给项目
    const r1 = await saveClassification(h, incomplete, { columnId: null, columnSlug: null, labelIds: [] });
    expect(r1.status).toBe(200);
    // 2) 完整暂存（action=save 不授权）
    const r2 = await saveClassification(h, complete);
    expect(r2.status).toBe(200);
    // 3) 完整暂存后清空
    const r3 = await saveClassification(h, cleared);
    expect(r3.status).toBe(200);
    const r4 = await saveClassification(h, cleared, { columnId: null, columnSlug: null, labelIds: [] });
    expect(r4.status).toBe(200);

    // 管理员启用自动归档并处理积压
    await prepareAutoArchive(h);
    await h.feedbackApp.worker.idle();

    // 三条人工记录都没被自动授权、也没有任何远端写入
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);

    const inc = await getFeedbackDetail(h, incomplete);
    expect(inc.data.status).toBe("needs_info");
    expect(inc.data.archiveAuthorized).toBe(false);
    expect(inc.data.classification.projectId).toBe("proj-1");
    expect(inc.data.classification.labelIds).toEqual([]);
    expect(inc.data.collectionState).toBe("waiting_manual_archive");

    const comp = await getFeedbackDetail(h, complete);
    expect(comp.data.status).toBe("ready_to_archive");
    expect(comp.data.archiveAuthorized).toBe(false);
    expect(comp.data.classification.labelIds).toEqual(["label-bug"]);
    expect(comp.data.collectionState).toBe("waiting_manual_archive");

    const clr = await getFeedbackDetail(h, cleared);
    expect(clr.data.status).toBe("needs_info");
    expect(clr.data.archiveAuthorized).toBe(false);
    expect(clr.data.classification.columnId).toBeNull();
    expect(clr.data.classification.labelIds).toEqual([]);
    expect(clr.data.collectionState).toBe("waiting_manual_archive");
  });

  it("扫描取到候选后人工保存（可控异步屏障）：事务内保护生效，人工内容不被覆盖", async () => {
    const h = await makeHarness();
    // 规则完整 + 自动模式已启用；此后提交的反馈会进入自动授权路径。
    await prepareAutoArchive(h);

    // 可控异步屏障：第一次读取项目时挂起，让测试在“扫描已取到候选”之后保存分类。
    let reachedResolve!: () => void;
    const reached = new Promise<void>((r) => {
      reachedResolve = r;
    });
    let releaseResolve!: () => void;
    const released = new Promise<void>((r) => {
      releaseResolve = r;
    });
    let blocked = 0;
    const original = h.kaneo.getProjectInfo.bind(h.kaneo);
    h.kaneo.getProjectInfo = async (projectId: string) => {
      if (blocked++ === 0) {
        reachedResolve();
        await released;
      }
      return original(projectId);
    };

    const raced = await submitOnly(h, h.bearer, "扫描与人工保存竞争");
    await reached; // worker 已走到授权前的目标核对，人工保存插入到这个窗口

    const saved = await saveClassification(h, raced, { columnId: null, columnSlug: null, labelIds: [] });
    expect(saved.status).toBe(200);

    releaseResolve();
    await h.feedbackApp.worker.idle();

    // 事务内保护：既不授权也不写入远端，人工保存的内容原样保留。
    expect(h.kaneo.remoteWrites).toBe(0);
    expect(h.kaneo.created).toHaveLength(0);
    const detail = await getFeedbackDetail(h, raced);
    expect(detail.data.archiveAuthorized).toBe(false);
    expect(detail.data.archiveAuthorizedKind).toBeNull();
    expect(detail.data.status).toBe("needs_info");
    expect(detail.data.classification.projectId).toBe("proj-1");
    expect(detail.data.classification.columnId).toBeNull();
    expect(detail.data.classification.labelIds).toEqual([]);
    expect(detail.data.collectionState).toBe("waiting_manual_archive");
  });

  it("同批混入人工已编辑记录：其他积压照常自动归档，人工记录零写入", async () => {
    const h = await makeHarness();
    const appRowId = h.app.id as string;
    insertBacklogRow(h, appRowId, "auto-batch", "自动积压", 3);
    insertManualRow(h, appRowId, "fb-manual-edit", "人工已编辑");

    await prepareAutoArchive(h);
    await h.feedbackApp.worker.idle();

    // 同一批里的三条可执行积压全部归档
    expect(h.kaneo.created).toHaveLength(3);
    expect(h.feedbackApp.db.prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'archived'").get()).toEqual({
      n: 3,
    });
    // 人工记录：不授权、不写远端、状态为等待人工归档
    expect(h.kaneo.created.some((c) => c.description.includes("fb-manual-edit"))).toBe(false);
    const manualDetail = await getFeedbackDetail(h, "fb-manual-edit");
    expect(manualDetail.data.archiveAuthorized).toBe(false);
    expect(manualDetail.data.status).toBe("needs_info");
    expect(manualDetail.data.collectionState).toBe("waiting_manual_archive");

    // 重复扫描仍不触碰人工记录
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(3);
    expect((await getFeedbackDetail(h, "fb-manual-edit")).data.archiveAuthorized).toBe(false);
  });
});

describe("T3 连续处理全部积压", () => {
  it("51 条积压：一次启用后全部归档且每条恰好一次", async () => {
    const h = await makeHarness();
    const bearer = await createUserBearer(h, { username: "backlog-51", dailyLimit: 200 });
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await submitOnly(h, bearer, `积压反馈 ${i}`));
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    await prepareAutoArchive(h);
    await h.feedbackApp.worker.idle();

    expect(h.kaneo.created).toHaveLength(51);
    const archived = h.feedbackApp.db
      .prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'archived'")
      .get() as { n: number };
    expect(archived.n).toBe(51);
    // 每条只产生一个任务（任务描述里带反馈 ID）
    const taskIds = new Set(h.kaneo.created.map((c) => c.description.match(/\*\*反馈ID\*\*：([^\s*]+)/)?.[1]));
    expect(taskIds.size).toBe(51);
    for (const id of ids) expect(taskIds.has(id)).toBe(true);

    // 再次触发扫描不重复处理
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(51);
  });

  it("121 条积压：跨多批继续处理直到没有可执行候选", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    // 直接落库 121 条积压（真实接收路径的限流不适合制造大批量；接收能力由 T1 用例覆盖）
    insertBacklogRow(h, h.app.id as string, "backlog121", "积压反馈", 121);
    await h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();

    expect(h.kaneo.created).toHaveLength(121);
    const archived = h.feedbackApp.db
      .prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'archived'")
      .get() as { n: number };
    expect(archived.n).toBe(121);
    // 每条恰好一个任务
    const marked = h.kaneo.created.map((c) => c.description.match(/\*\*反馈ID\*\*：([^\s*]+)/)?.[1]);
    expect(marked.every(Boolean)).toBe(true);
    expect(new Set(marked).size).toBe(121);

    // 再次触发不重复建任务
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(121);
  });

  it("混入人工记录 / 配置阻塞 / 未到期重试：新积压照常归档，特殊记录不受阻也不误写", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    const appRowId = h.app.id as string;
    const bearer = await createUserBearer(h, { username: "backlog-mixed", dailyLimit: 50 });

    // 可执行积压 3 条（真实提交路径）
    for (let i = 0; i < 3; i++) await submitOnly(h, bearer, `可执行 ${i}`);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(3);

    // 人工已编辑（直接构造“管理员已暂存”的记录：classify_version > 0）
    insertManualRow(h, appRowId, "fb-manual-edit", "人工记录");

    // 配置阻塞：录一条后让目标列失效
    insertBacklogRow(h, appRowId, "fb-config-blocked", "配置阻塞", 1);
    const goodListColumns = h.kaneo.listColumns.bind(h.kaneo);
    h.kaneo.listColumns = async () => [];
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    h.kaneo.listColumns = goodListColumns;
    expect(getFeedback(h.feedbackApp.db, "fb-config-blocked")!.auto_blocked_kind).toBe("config");

    // 未到期的可恢复重试：录一条后注入可恢复故障
    insertBacklogRow(h, appRowId, "fb-retry-later", "等待重试", 1);
    h.kaneo.readError = { kind: "uncertain", message: "暂时不可达" };
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    h.kaneo.readError = null;
    const retryRow = getFeedback(h.feedbackApp.db, "fb-retry-later")!;
    expect(retryRow.auto_blocked_kind).toBe("retryable");
    expect(retryRow.auto_next_attempt_at).toBeTruthy();

    // 新的可执行积压不受三条特殊记录影响：立即归档
    const extra = await submitOnly(h, bearer, "新积压");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(4);
    expect((await getFeedbackDetail(h, extra)).data.status).toBe("archived");

    // 三条特殊记录既不被误写，也不误报状态
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(4);
    const manualDetail = await getFeedbackDetail(h, "fb-manual-edit");
    expect(manualDetail.data.archiveAuthorized).toBe(false);
    expect(manualDetail.data.collectionState).toBe("waiting_manual_archive");
    expect((await getFeedbackDetail(h, "fb-config-blocked")).data.collectionState).toBe("waiting_configuration");
    const retryDetail = await getFeedbackDetail(h, "fb-retry-later");
    expect(retryDetail.data.autoBlockedKind).toBe("retryable");
    expect(retryDetail.data.collectionState).toBe("queued"); // 等待自动重试，不是等待人工
  });
});

describe("T3 到期自动重试与生命周期", () => {
  it("到期前不重试；到期后无需任何管理操作自动归档", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    h.kaneo.readError = { kind: "uncertain", message: "连接中断" };

    const id = await submitOnly(h, h.bearer, "可恢复故障");
    await h.feedbackApp.worker.idle();
    const blocked = await getFeedbackDetail(h, id);
    expect(blocked.data.autoBlockedKind).toBe("retryable");
    expect(h.kaneo.created).toHaveLength(0);

    h.kaneo.readError = null;

    // 退避未到期：推进 59 秒仍然不重试（手动扫描也不能绕过）
    await clock.advance(59_000);
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    // 到期：定时器自动查库并处理
    await clock.advance(1_000);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    const done = await getFeedbackDetail(h, id);
    expect(done.data.status).toBe("archived");
    expect(done.data.autoBlockedKind).toBeNull();
  });

  it("重启恢复：恢复立即可执行任务并重新安排未到期的重试", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    h.kaneo.readError = { kind: "uncertain", message: "服务停机中" };
    const id = await submitOnly(h, h.bearer, "停机期间积压");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    // 模拟重启：新进程按库内状态恢复（不手动清退避、不手动调用扫描）
    h.kaneo.readError = null;
    resumeWorker(h.feedbackApp);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0); // 未到期不得提前重试

    await clock.advance(60_000);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect((await getFeedbackDetail(h, id)).data.status).toBe("archived");
  });

  it("重复触发扫描不会重复建任务", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    h.kaneo.readError = { kind: "uncertain", message: "连接中断" };
    await submitOnly(h, h.bearer, "重复触发");
    await h.feedbackApp.worker.idle();

    h.kaneo.readError = null;
    h.feedbackApp.worker.scanAutoArchive();
    h.feedbackApp.worker.scanAutoArchive();
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    await clock.advance(60_000);
    await h.feedbackApp.worker.idle();
    h.feedbackApp.worker.scanAutoArchive();
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
  });

  it("退出后不再有任何定时器回调访问数据库", async () => {
    const clock = makeFakeClock();
    const h = await makeHarness({ clock });
    await prepareAutoArchive(h);
    h.kaneo.readError = { kind: "uncertain", message: "连接中断" };
    await submitOnly(h, h.bearer, "退出前积压");
    await h.feedbackApp.worker.idle();
    expect(clock.pending()).toBeGreaterThan(0);

    h.feedbackApp.worker.stop();
    expect(clock.pending()).toBe(0);
    h.feedbackApp.close();
    // 关闭数据库后再推进时间：任何残留定时器访问数据库都会抛错
    h.feedbackApp.db.close();
    await expect(clock.advance(30 * 60_000)).resolves.toBeUndefined();
    expect(clock.pending()).toBe(0);
  });
});

describe("T2 版本契约与幂等", () => {
  it("两个页面共用同一版本：另一页面保存规则后，旧页面确认来源必须冲突且不触发归档", async () => {
    const h = await makeHarness({ seedAppOver: { origins: ["http://localhost", "http://host.test"] } });
    await prepareAutoArchive(h);
    // 新来源先提交，形成“等待来源确认”的积压
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), {
      origin: "https://stale-page.example",
    });
    const id = sub.data.feedbackId as string;
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    // 页面 A 读到的版本
    const staleVersion = await appRuleVersion(h);
    // 页面 B 修改了规则（版本推进）
    const saved = await saveAppDefaults(h, { columnId: "col-db-id", columnSlug: "triage" });
    expect(saved.status).toBe(200);
    expect(Number(saved.data.ruleVersion)).toBeGreaterThan(staleVersion);

    // 页面 A 用旧版本确认来源 → 409，不确认、不补处理
    const stale = await confirmSource(h, "https://stale-page.example", { expectedRuleVersion: staleVersion });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("version_conflict");
    const detail = await getAppDetail(h);
    const source = (detail.data.sources as Array<{ origin: string; status: string }>).find(
      (s) => s.origin === "https://stale-page.example",
    );
    expect(source?.status).toBe("pending");
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    // 刷新后（当前版本）确认成功并补归档
    const ok = await confirmSource(h, "https://stale-page.example");
    expect(ok.status).toBe(200);
    expect(ok.data.backlogDispatched).toBe(true);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived");
  });

  it("两个页面共用同一版本：旧页面保存规则必须冲突，且一个字节都不写", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const staleVersion = await appRuleVersion(h);

    // 另一页面先修改
    const first = await saveAppDefaults(h, { name: "页面A改名" });
    expect(first.status).toBe(200);
    const afterFirst = await getAppDetail(h);

    // 旧页面写入 → 409，配置保持页面 A 的结果
    const stale = await saveAppDefaults(h, { expectedRuleVersion: staleVersion, name: "旧页面改名" });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("version_conflict");
    const after = await getAppDetail(h);
    expect(after.data.app.name).toBe("页面A改名");
    expect(after.data.app.ruleVersion).toBe(afterFirst.data.app.ruleVersion);
  });

  it("缺少 expectedRuleVersion 一律拒绝（来源确认 / 规则保存 / 启停）", async () => {
    const h = await makeHarness();
    const confirm = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${h.app.id}/sources/confirm`, {
      cookie: h.cookie,
      body: { origin: "http://host.test", operationId: "op-no-version" },
    });
    expect(confirm.status).toBe(400);

    const save = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${h.app.id}`, {
      cookie: h.cookie,
      body: { name: "测试软件", allowedOrigins: ["http://host.test"] },
    });
    expect(save.status).toBe(400);

    const enable = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${h.app.id}/auto-archive/enable`, {
      cookie: h.cookie,
      body: {},
    });
    expect(enable.status).toBe(400);

    const disable = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${h.app.id}/auto-archive/disable`, {
      cookie: h.cookie,
      body: {},
    });
    expect(disable.status).toBe(400);

    const noOpId = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${h.app.id}/sources/confirm`, {
      cookie: h.cookie,
      body: { origin: "http://host.test", expectedRuleVersion: await appRuleVersion(h) },
    });
    expect(noOpId.status).toBe(400);
  });

  it("同一已成功操作重放：即使规则版本已推进也幂等返回，不重复授权", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const sub = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), {
      origin: "https://replay.example",
    });
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(0);

    const first = await confirmSource(h, "https://replay.example", { operationId: "confirm-stable" });
    expect(first.status).toBe(200);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);

    // 版本被推进后再重放同一操作键：仍然幂等（先判重放，再判版本）
    await saveAppDefaults(h, { name: "版本推进" });
    const replay = await confirmSource(h, "https://replay.example", {
      operationId: "confirm-stable",
      expectedRuleVersion: 0,
    });
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.created).toHaveLength(1);
    expect(getFeedback(h.feedbackApp.db, sub.data.feedbackId as string)!.status).toBe("archived");
  });

  it("人工模式下确认来源只登记确认，不承诺补归档", async () => {
    const h = await makeHarness();
    await saveAppDefaults(h); // 普通保存：仍是人工模式
    const r = await confirmSource(h, "http://host.test", { operationId: "confirm-manual" });
    expect(r.status).toBe(200);
    expect(r.data.autoArchiveEnabled).toBe(false);
    expect(r.data.backlogDispatched).toBe(false);
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("停用后旧版本页面再次启用必须冲突（页面过期不静默生效）", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const staleVersion = await appRuleVersion(h);
    const off = await disableAutoArchive(h);
    expect(off.status).toBe(200);

    const staleEnable = await enableAutoArchive(h, { expectedRuleVersion: staleVersion });
    expect(staleEnable.status).toBe(409);
    const detail = await getAppDetail(h);
    expect(detail.data.app.archiveMode).toBe("manual");

    const freshEnable = await enableAutoArchive(h);
    expect(freshEnable.status).toBe(200);
  });

  it("已归档记录的人工保存仍被锁定（人工保护不放松既有锁定语义）", async () => {
    const h = await makeHarness();
    await prepareAutoArchive(h);
    const id = await submitOnly(h, h.bearer, "竞态记录");
    await h.feedbackApp.worker.idle();
    expect((await getFeedbackDetail(h, id)).data.status).toBe("archived");

    // 已归档记录不允许再被人工改写（锁定），确认保护不破坏既有锁定语义
    const locked = await saveClassification(h, id, { columnId: null, columnSlug: null, labelIds: [] });
    expect(locked.status).toBe(409);
    expect(locked.data.error.code).toBe("classification_locked");
    await vi.waitFor(() => expect(getFeedback(h.feedbackApp.db, id)!.status).toBe("archived"));
  });
});
