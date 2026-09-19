import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, type FeedbackApp } from "../src/app.ts";
import { type Db, openDb } from "../src/db/db.ts";
import {
  applyLifecycleInTx,
  contentHash,
  createUser,
  getFeedback,
  submitFeedbackAtomic,
  updateFeedback,
} from "../src/db/repos.ts";
import type { AiClient } from "../src/services/ai.ts";
import { instantSleep, jsonReq, makeConfig, makeMockAi, makeMockKaneo, makeProcessed } from "./helpers.ts";

/**
 * Assist 管理面（contracts/feedback-integration.md §4，v1.1）测试：
 * 挂载条件、凭证互斥、列表视图/分页/搜索、详情扩展字段、生命周期与恢复动作、
 * requestId 幂等（回放/冲突/运行中/崩溃残留）、busy 映射、purge 后统一 not_found。
 * 不调用 AI / Kaneo 真实功能（全部 mock），不写任何「测试反馈」到远端。
 */

const READ = "ask_read";
const SRC = "ask_src";
const MGMT = "amk_mgmt";
const ACTOR = { id: "assist", username: "Assistant" };

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "feedback-assist-mgmt-"));
}

interface MgmtRequestRow {
  request_id: string;
  feedback_id: string;
  action: string;
  http_status: number;
  outcome_json: string;
  created_at: string;
}

function mgmtRows(db: Db): MgmtRequestRow[] {
  return db.prepare("SELECT * FROM assist_mgmt_requests ORDER BY created_at").all() as unknown as MgmtRequestRow[];
}

function auditRows(db: Db, feedbackId: string, action?: string): { action: string; detail_json: string | null }[] {
  const sql = action
    ? "SELECT action, detail_json FROM feedback_audit WHERE feedback_id = ? AND action = ? ORDER BY at ASC, id ASC"
    : "SELECT action, detail_json FROM feedback_audit WHERE feedback_id = ? ORDER BY at ASC, id ASC";
  const args = action ? [feedbackId, action] : [feedbackId];
  return db.prepare(sql).all(...args) as { action: string; detail_json: string | null }[];
}

function outboxPayloads(db: Db, kind?: string): any[] {
  const rows = db.prepare("SELECT kind, payload_json FROM assist_outbox ORDER BY seq ASC").all() as {
    kind: string;
    payload_json: string;
  }[];
  return rows.filter((r) => kind === undefined || r.kind === kind).map((r) => JSON.parse(r.payload_json));
}

/** 与 assist.test.ts 相同的最小落库路径（不经 HTTP；自动发现软件 com.test.app）。 */
function seedFeedback(
  db: Db,
  over: { text?: string; screenshot?: boolean; logs?: { filename: string; bytes: Uint8Array }[] } = {},
) {
  const user = createUser(db, `u-${Math.random().toString(36).slice(2)}`, "hash", { dailyLimit: 50 });
  const text = over.text ?? "导出 CSV 卡住了，希望支持后台导出";
  const logs = (over.logs ?? []).map((l) => {
    const bytes = l.bytes;
    return {
      filename: l.filename,
      source: "auto" as const,
      bytes,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const screenshot = over.screenshot
    ? {
        pngBlob: png,
        width: 10,
        height: 10,
        byteSize: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
        captureJson: null,
      }
    : null;
  const outcome = submitFeedbackAtomic(
    db,
    {
      userId: user.id,
      appId: "com.test.app",
      sourceOrigin: "http://host.test",
      sourceKind: "browser",
      text,
      contextJson: null,
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      contentHash: contentHash("com.test.app", text, null, screenshot ? { sha256: screenshot.sha256 } : null, logs),
    },
    screenshot,
    logs,
  );
  if (outcome.kind !== "created") throw new Error(`反馈落库失败: ${outcome.kind}`);
  return outcome.row;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 全部事件都 accepted 的 mock 中枢（避免真实网络请求）。 */
function acceptAllHub(): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        accepted: (body.events ?? []).map((e: { eventId: string }) => e.eventId),
        duplicates: [],
        rejected: [],
        lastSeq: 0,
        serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

interface MgmtAppOptions {
  ai?: AiClient;
  assistHubUrl?: string | null;
  assistSourceKey?: string | null;
  assistReadKey?: string | null;
  assistMgmtKey?: string | null;
}

function makeMgmtApp(over: MgmtAppOptions = {}): { feedbackApp: FeedbackApp } {
  const config = {
    ...makeConfig(),
    assistHubUrl: "http://hub.test",
    assistSourceKey: SRC,
    assistReadKey: READ,
    assistMgmtKey: MGMT,
    assistFlushMs: 5,
    ...over,
  };
  const feedbackApp = createApp(config, {
    ai: over.ai ?? makeMockAi(),
    kaneo: makeMockKaneo(),
    workerSleep: instantSleep,
    assistFetch: acceptAllHub(),
  });
  return { feedbackApp };
}

function postAction(app: FeedbackApp["app"], feedbackId: string, body: Record<string, unknown>, bearer = MGMT) {
  return jsonReq(app, "POST", `/api/assist/manage/feedback/${feedbackId}/action`, { bearer, body });
}

/** 合法的 v3 归档恢复数据（revision 乐观锁测试用）。 */
function archiveDataJson(revision: number): string {
  return JSON.stringify({
    version: 3,
    revision,
    target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
    labels: {},
    attachments: {},
  });
}

describe("管理面挂载条件", () => {
  it("未配置 FEEDBACK_ASSIST_MGMT_KEY → 管理组不挂载（404），detail capabilities.manage=false", async () => {
    const { feedbackApp } = makeMgmtApp({ assistMgmtKey: null });
    const row = seedFeedback(feedbackApp.db);
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: MGMT });
    expect(r.status).toBe(404);
    const d = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: READ });
    expect(d.status).toBe(200);
    expect(d.data.capabilities.manage).toBe(false);
    feedbackApp.close();
  });

  it("MGMT_KEY 与生效只读凭证相同 → 拒绝挂载（404），只读组不受影响", async () => {
    const { feedbackApp } = makeMgmtApp({ assistMgmtKey: READ });
    const row = seedFeedback(feedbackApp.db);
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: READ });
    expect(r.status).toBe(404);
    const d = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: READ });
    expect(d.status).toBe(200);
    expect(d.data.capabilities.manage).toBe(false);
    feedbackApp.close();
  });

  it("MGMT_KEY 与 SOURCE_KEY 回退凭证相同 → 拒绝挂载", async () => {
    // 只读凭证生效值 = SOURCE_KEY（未单独配置 READ_KEY 时）
    const { feedbackApp } = makeMgmtApp({ assistReadKey: null, assistMgmtKey: SRC });
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: SRC });
    expect(r.status).toBe(404);
    feedbackApp.close();
  });

  it("未配置 HUB_URL → 两组都不挂载（接入整体关闭）", async () => {
    const { feedbackApp } = makeMgmtApp({ assistHubUrl: null });
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: MGMT });
    expect(r.status).toBe(404);
    feedbackApp.close();
  });

  it("MGMT_KEY 独立配置（只读凭证未配置）→ 管理组挂载，只读组不挂载", async () => {
    const { feedbackApp } = makeMgmtApp({ assistReadKey: null, assistSourceKey: null });
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: MGMT });
    expect(r.status).toBe(200);
    expect(r.data.items).toEqual([]);
    feedbackApp.close();
  });
});

describe("管理组认证（凭证互斥）", () => {
  it("无凭证/READ_KEY/SOURCE_KEY → 401；MGMT_KEY → 200", async () => {
    const { feedbackApp } = makeMgmtApp();
    const url = "/api/assist/manage/feedback";
    expect((await jsonReq(feedbackApp.app, "GET", url)).status).toBe(401);
    expect((await jsonReq(feedbackApp.app, "GET", url, { bearer: "wrong" })).status).toBe(401);
    expect((await jsonReq(feedbackApp.app, "GET", url, { bearer: READ })).status).toBe(401);
    expect((await jsonReq(feedbackApp.app, "GET", url, { bearer: SRC })).status).toBe(401);
    expect((await jsonReq(feedbackApp.app, "GET", url, { bearer: MGMT })).status).toBe(200);
    feedbackApp.close();
  });

  it("MGMT_KEY 不能读只读组（详情/附件 401）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db, { screenshot: true });
    const d = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: MGMT });
    expect(d.status).toBe(401);
    const s = await feedbackApp.app.request(`/api/assist/feedback/${row.id}/attachments/screenshot`, {
      headers: { authorization: `Bearer ${MGMT}` },
    });
    expect(s.status).toBe(401);
    feedbackApp.close();
  });
});

describe("GET /api/assist/manage/feedback", () => {
  function seedFour(db: Db) {
    const a = seedFeedback(db, { text: "收件箱-甲" });
    const b = seedFeedback(db, { text: "收件箱-乙" });
    updateFeedback(db, b.id, { status: "failed", error_summary: "boom" });
    const c = seedFeedback(db, { text: "归档区-丙" });
    updateFeedback(db, c.id, { status: "archived" });
    expect(applyLifecycleInTx(db, c.id, { action: "archive", expectedVersion: 0, actor: ACTOR }).kind).toBe("ok");
    const d = seedFeedback(db, { text: "回收站-丁" });
    expect(applyLifecycleInTx(db, d.id, { action: "trash", expectedVersion: 0, actor: ACTOR }).kind).toBe("ok");
    return { a, b, c, d };
  }

  it("默认 view=inbox；各视图过滤 + counts 三区计数（view 不计入）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const { a, b, c, d } = seedFour(feedbackApp.db);
    const list = (q = "") => jsonReq(feedbackApp.app, "GET", `/api/assist/manage/feedback${q}`, { bearer: MGMT });

    const inbox = await list();
    expect(inbox.status).toBe(200);
    expect(inbox.data.items.map((i: any) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(inbox.data.counts).toEqual({ inbox: 2, archived: 1, trash: 1 });

    const all = await list("?view=all");
    expect(all.data.items.map((i: any) => i.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(all.data.items.some((i: any) => i.id === d.id)).toBe(false); // all 不含回收站

    const archived = await list("?view=archived");
    expect(archived.data.items.map((i: any) => i.id)).toEqual([c.id]);
    expect(archived.data.items[0].mgmtState).toBe("archived");

    const trash = await list("?view=trash");
    expect(trash.data.items.map((i: any) => i.id)).toEqual([d.id]);
    expect(trash.data.counts).toEqual({ inbox: 2, archived: 1, trash: 1 });
    feedbackApp.close();
  });

  it("列表项契约字段投影 + 列表 allowedActions 仅生命周期子集（failed 不含 retry）", async () => {
    const { feedbackApp } = makeMgmtApp();
    seedFour(feedbackApp.db);
    const r = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback", { bearer: MGMT });
    const failed = r.data.items.find((i: any) => i.errorSummary === "boom");
    expect(failed).toBeTruthy();
    for (const key of [
      "id",
      "appId",
      "appName",
      "status",
      "issueStatus",
      "mgmtState",
      "lifecycleVersion",
      "title",
      "textPreview",
      "createdAt",
      "updatedAt",
      "errorSummary",
      "hasScreenshot",
      "logCount",
      "collectionState",
      "resumePaused",
      "allowedActions",
    ]) {
      expect(failed).toHaveProperty(key);
    }
    expect(failed.status).toBe("failed");
    expect(failed.appId).toBe("com.test.app");
    expect(failed.appName).toBe("com.test.app"); // 自动发现软件名默认回退 appId
    expect(failed.issueStatus).toBe("open");
    expect(failed.allowedActions).toEqual(["trash"]); // 列表不含 retry/recheck
    feedbackApp.close();
  });

  it("分页：limit + nextCursor 翻页不重不漏", async () => {
    const { feedbackApp } = makeMgmtApp();
    seedFour(feedbackApp.db);
    const page1 = await jsonReq(feedbackApp.app, "GET", "/api/assist/manage/feedback?view=all&limit=2", {
      bearer: MGMT,
    });
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.nextCursor).toBeTruthy();
    const page2 = await jsonReq(
      feedbackApp.app,
      "GET",
      `/api/assist/manage/feedback?view=all&limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`,
      { bearer: MGMT },
    );
    expect(page2.data.items).toHaveLength(1);
    const ids = [...page1.data.items, ...page2.data.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(page2.data.nextCursor).toBeNull();
    feedbackApp.close();
  });

  it("q 搜索命中 title/text/id；counts 同条件过滤", async () => {
    const { feedbackApp } = makeMgmtApp();
    seedFour(feedbackApp.db);
    const r = await jsonReq(
      feedbackApp.app,
      "GET",
      `/api/assist/manage/feedback?view=all&q=${encodeURIComponent("归档区")}`,
      {
        bearer: MGMT,
      },
    );
    expect(r.data.items).toHaveLength(1);
    expect(r.data.items[0].textPreview).toContain("归档区");
    expect(r.data.counts).toEqual({ inbox: 0, archived: 1, trash: 0 });
    const byId = await jsonReq(
      feedbackApp.app,
      "GET",
      `/api/assist/manage/feedback?q=${encodeURIComponent(r.data.items[0].id)}`,
      { bearer: MGMT },
    );
    expect(byId.data.items).toHaveLength(0); // id 命中但 view 默认 inbox，该条在 archived
    const byIdAll = await jsonReq(
      feedbackApp.app,
      "GET",
      `/api/assist/manage/feedback?view=all&q=${encodeURIComponent(r.data.items[0].id)}`,
      { bearer: MGMT },
    );
    expect(byIdAll.data.items).toHaveLength(1);
    feedbackApp.close();
  });

  it("非法 view / limit / q → invalid_request 400", async () => {
    const { feedbackApp } = makeMgmtApp();
    const bad = async (q: string) => {
      const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/manage/feedback${q}`, { bearer: MGMT });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe("invalid_request");
    };
    await bad("?view=bogus");
    await bad("?limit=0");
    await bad("?limit=101");
    await bad("?limit=abc");
    await bad(`?q=${"x".repeat(201)}`);
    feedbackApp.close();
  });
});

describe("GET /api/assist/feedback/:id v1.1 扩展字段", () => {
  it("详情含全部 v1.1 字段 + capabilities.manage=true", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db, {
      screenshot: true,
      logs: [{ filename: "a.log", bytes: Buffer.from("x") }],
    });
    const r = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: READ });
    expect(r.status).toBe(200);
    // v1.0 既有字段保持
    expect(r.data.id).toBe(row.id);
    expect(r.data.text).toBe(row.text);
    expect(r.data.logs).toHaveLength(1);
    // v1.1 扩展
    expect(r.data.appName).toBe("com.test.app");
    expect(r.data.mgmtState).toBe("inbox");
    expect(r.data.lifecycleVersion).toBe(0);
    expect(r.data.revision).toBe(0);
    expect(r.data.issueStatus).toBe("open");
    expect(r.data.collectionState).toBe("waiting_configuration"); // 自动发现软件待配置
    expect(r.data.resumePaused).toBe(false);
    expect(r.data.archiveStage).toBe("task_pending");
    expect(r.data.kaneoTaskUrl).toBeNull();
    expect(r.data.archivedAt).toBeNull();
    expect(r.data.trashedAt).toBeNull();
    expect(r.data.allowedActions).toEqual(["trash"]);
    expect(r.data.capabilities).toEqual({ manage: true });
    feedbackApp.close();
  });

  it("详情 allowedActions 按状态含 retry/recheck；回收站只读", async () => {
    const { feedbackApp } = makeMgmtApp();
    const failed = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, failed.id, { status: "failed", error_summary: "x" });
    const review = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, review.id, { status: "needs_review", error_summary: "待核对" });
    const d1 = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${failed.id}`, { bearer: READ });
    expect(d1.data.allowedActions.sort()).toEqual(["retry", "trash"]);
    const d2 = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${review.id}`, { bearer: READ });
    expect(d2.data.allowedActions.sort()).toEqual(["recheck", "trash"]);
    expect(
      applyLifecycleInTx(feedbackApp.db, review.id, { action: "trash", expectedVersion: 0, actor: ACTOR }).kind,
    ).toBe("ok");
    const d3 = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${review.id}`, { bearer: READ });
    expect(d3.data.allowedActions).toEqual(["restore"]); // 回收站只读：不含 purge/recheck
    feedbackApp.close();
  });
});

describe("POST /api/assist/manage/feedback/:id/action 参数校验", () => {
  it("缺 requestId / 非法 requestId / 非法 action / purge → invalid_request", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const bad = async (body: Record<string, unknown>) => {
      const r = await postAction(feedbackApp.app, row.id, body);
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe("invalid_request");
    };
    await bad({ action: "trash", expectedLifecycleVersion: 0 });
    await bad({ requestId: "bad space", action: "trash", expectedLifecycleVersion: 0 });
    await bad({ requestId: "r-1", action: "explode", expectedLifecycleVersion: 0 });
    await bad({ requestId: "r-1", action: "purge", expectedLifecycleVersion: 0 }); // purge 不在开放集
    await bad({ requestId: "r-1" }); // 缺 action
    feedbackApp.close();
  });

  it("生命周期动作缺 expectedLifecycleVersion / retry 缺 expectedRevision → invalid_request", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    for (const action of ["archive", "unarchive", "trash", "restore", "resume_processing"]) {
      const r = await postAction(feedbackApp.app, row.id, { requestId: `r-${action}`, action });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe("invalid_request");
    }
    for (const action of ["retry", "recheck"]) {
      const r = await postAction(feedbackApp.app, row.id, { requestId: `r-${action}`, action });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe("invalid_request");
    }
    const neg = await postAction(feedbackApp.app, row.id, {
      requestId: "r-neg",
      action: "trash",
      expectedLifecycleVersion: -1,
    });
    expect(neg.status).toBe(400);
    const float = await postAction(feedbackApp.app, row.id, {
      requestId: "r-float",
      action: "retry",
      expectedRevision: 1.5,
    });
    expect(float.status).toBe(400);
    feedbackApp.close();
  });
});

describe("生命周期动作全流程", () => {
  it("archive → unarchive → trash → restore：版本递增 + allowedActions 实时切换", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, { status: "archived" }); // 仅完整同步 Kaneo 的反馈可归档

    // status=archived + inbox → archive/trash
    const archive = await postAction(feedbackApp.app, row.id, {
      requestId: "r-archive",
      action: "archive",
      expectedLifecycleVersion: 0,
    });
    expect(archive.status).toBe(200);
    expect(archive.data.ok).toBe(true);
    expect(archive.data.action).toBe("archive");
    expect(archive.data.replayed).toBe(false);
    expect(archive.data.detail.mgmtState).toBe("archived");
    expect(archive.data.detail.lifecycleVersion).toBe(1);
    expect(archive.data.detail.archivedAt).toBeTruthy();
    expect(archive.data.detail.allowedActions.sort()).toEqual(["trash", "unarchive"]);

    const unarchive = await postAction(feedbackApp.app, row.id, {
      requestId: "r-unarchive",
      action: "unarchive",
      expectedLifecycleVersion: 1,
    });
    expect(unarchive.status).toBe(200);
    expect(unarchive.data.detail.mgmtState).toBe("inbox");
    expect(unarchive.data.detail.archivedAt).toBeNull();
    expect(unarchive.data.detail.lifecycleVersion).toBe(2);
    expect(unarchive.data.detail.allowedActions.sort()).toEqual(["archive", "trash"]);

    const trash = await postAction(feedbackApp.app, row.id, {
      requestId: "r-trash",
      action: "trash",
      expectedLifecycleVersion: 2,
    });
    expect(trash.status).toBe(200);
    expect(trash.data.detail.mgmtState).toBe("trash");
    expect(trash.data.detail.trashedAt).toBeTruthy();
    expect(trash.data.detail.allowedActions).toEqual(["restore"]);
    // 已完整同步记录移入回收站不暂停
    expect(trash.data.detail.resumePaused).toBe(false);

    const restore = await postAction(feedbackApp.app, row.id, {
      requestId: "r-restore",
      action: "restore",
      expectedLifecycleVersion: 3,
    });
    expect(restore.status).toBe(200);
    expect(restore.data.detail.mgmtState).toBe("inbox");
    expect(restore.data.detail.trashedAt).toBeNull();
    expect(restore.data.detail.allowedActions.sort()).toEqual(["archive", "trash"]);

    // 审计：四个生命周期动作各一条，actor 固定 assist
    const actions = auditRows(feedbackApp.db, row.id).map((a) => a.action);
    expect(actions).toEqual(["mgmt_archive", "mgmt_unarchive", "mgmt_trash", "mgmt_restore"]);
    const auditRow = feedbackApp.db
      .prepare("SELECT actor_user_id, actor_username FROM feedback_audit WHERE feedback_id = ? LIMIT 1")
      .get(row.id) as { actor_user_id: string; actor_username: string };
    expect(auditRow).toEqual({ actor_user_id: "assist", actor_username: "Assistant" });
    feedbackApp.close();
  });

  it("未完成记录 trash 暂停 → restore 保持暂停 → resume_processing 恢复并入队", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db); // status=received

    const trash = await postAction(feedbackApp.app, row.id, {
      requestId: "r-t",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(trash.status).toBe(200);
    expect(trash.data.detail.resumePaused).toBe(true); // 未完成记录移入回收站即暂停

    const restore = await postAction(feedbackApp.app, row.id, {
      requestId: "r-r",
      action: "restore",
      expectedLifecycleVersion: 1,
    });
    expect(restore.status).toBe(200);
    expect(restore.data.detail.resumePaused).toBe(true); // 恢复不自动重启处理
    expect(restore.data.detail.allowedActions.sort()).toEqual(["resume_processing", "trash"]);

    const resume = await postAction(feedbackApp.app, row.id, {
      requestId: "r-resume",
      action: "resume_processing",
      expectedLifecycleVersion: 2,
    });
    expect(resume.status).toBe(200);
    expect(resume.data.detail.resumePaused).toBe(false);
    expect(resume.data.detail.allowedActions).toEqual(["trash"]);

    // 锁外入队 → AI 整理完成落 needs_info
    await feedbackApp.worker.idle();
    expect(getFeedback(feedbackApp.db, row.id)!.status).toBe("needs_info");
    feedbackApp.close();
  });

  it("回收站记录拒绝 retry（invalid_state + detail 快照）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, { status: "failed", error_summary: "x" });
    expect(applyLifecycleInTx(feedbackApp.db, row.id, { action: "trash", expectedVersion: 0, actor: ACTOR }).kind).toBe(
      "ok",
    );
    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-rt",
      action: "retry",
      expectedRevision: 0,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("invalid_state");
    expect(r.data.detail.mgmtState).toBe("trash");
    feedbackApp.close();
  });

  it("version_conflict → 409 + lifecycleVersion + detail", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-vc",
      action: "trash",
      expectedLifecycleVersion: 5,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("version_conflict");
    expect(r.data.lifecycleVersion).toBe(0);
    expect(r.data.detail.lifecycleVersion).toBe(0);
    expect(r.data.detail.allowedActions).toContain("trash");
    feedbackApp.close();
  });
});

describe("retry / recheck", () => {
  it("failed + 正确 revision → 200：状态恢复 processing、outbox recovered 事件、assist 审计", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, { status: "failed", error_summary: "boom", last_error: "E1" });

    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-retry",
      action: "retry",
      expectedRevision: 0,
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.action).toBe("retry");
    expect(r.data.replayed).toBe(false);
    expect(r.data.detail.status).toBe("processing");

    await feedbackApp.worker.idle();
    expect(getFeedback(feedbackApp.db, row.id)!.status).toBe("needs_info"); // AI 整理完成

    const recovered = outboxPayloads(feedbackApp.db, "feedback_recovered").filter(
      (e) => e.faultKey === `feedback:${row.id}`,
    );
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered[0].incidentAction).toBe("resolve");

    const audit = auditRows(feedbackApp.db, row.id, "retry");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail_json!)).toMatchObject({
      requestId: "r-retry",
      expectedRevision: 0,
      via: "assist",
    });
    feedbackApp.close();
  });

  it("revision_conflict → 409 + revision + detail；正确 revision 成功", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, {
      status: "failed",
      error_summary: "x",
      archive_data_json: archiveDataJson(2),
    });
    const bad = await postAction(feedbackApp.app, row.id, {
      requestId: "r-rc",
      action: "retry",
      expectedRevision: 0,
    });
    expect(bad.status).toBe(409);
    expect(bad.data.error.code).toBe("revision_conflict");
    expect(bad.data.revision).toBe(2);
    expect(bad.data.detail.revision).toBe(2);

    const ok = await postAction(feedbackApp.app, row.id, {
      requestId: "r-rc2",
      action: "retry",
      expectedRevision: 2,
    });
    expect(ok.status).toBe(200);
    await feedbackApp.worker.idle();
    feedbackApp.close();
  });

  it("needs_review + recheck：Kaneo 未配置 → invalid_state（不崩溃）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    updateFeedback(feedbackApp.db, row.id, { status: "needs_review", error_summary: "待核对" });
    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-recheck",
      action: "recheck",
      expectedRevision: 0,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("invalid_state");
    expect(r.data.error.message).toContain("Kaneo");
    feedbackApp.close();
  });

  it("非允许状态 retry → invalid_state（received 不可 retry）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-rt2",
      action: "retry",
      expectedRevision: 0,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("invalid_state");
    feedbackApp.close();
  });
});

describe("幂等（assist_mgmt_requests）", () => {
  it("同 requestId 同参数 → replayed:true，不重复执行（审计仍一条）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const body = { requestId: "rop-replay", action: "trash", expectedLifecycleVersion: 0 };
    const r1 = await postAction(feedbackApp.app, row.id, body);
    expect(r1.status).toBe(200);
    expect(r1.data.replayed).toBe(false);
    expect(auditRows(feedbackApp.db, row.id, "mgmt_trash")).toHaveLength(1);

    const r2 = await postAction(feedbackApp.app, row.id, body);
    expect(r2.status).toBe(200);
    expect(r2.data.ok).toBe(true);
    expect(r2.data.replayed).toBe(true);
    expect(r2.data.detail.mgmtState).toBe("trash");
    expect(auditRows(feedbackApp.db, row.id, "mgmt_trash")).toHaveLength(1); // 不重复执行
    expect(mgmtRows(feedbackApp.db)).toHaveLength(1);
    expect(mgmtRows(feedbackApp.db)[0]!.http_status).toBe(200);
    feedbackApp.close();
  });

  it("同 requestId 不同参数/不同动作/不同目标 → request_id_conflict 409", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const other = seedFeedback(feedbackApp.db);
    await postAction(feedbackApp.app, row.id, {
      requestId: "rop-conflict",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    const diffParam = await postAction(feedbackApp.app, row.id, {
      requestId: "rop-conflict",
      action: "trash",
      expectedLifecycleVersion: 1,
    });
    expect(diffParam.status).toBe(409);
    expect(diffParam.data.error.code).toBe("request_id_conflict");
    const diffAction = await postAction(feedbackApp.app, row.id, {
      requestId: "rop-conflict",
      action: "archive",
      expectedLifecycleVersion: 0,
    });
    expect(diffAction.status).toBe(409);
    expect(diffAction.data.error.code).toBe("request_id_conflict");
    const diffTarget = await postAction(feedbackApp.app, other.id, {
      requestId: "rop-conflict",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(diffTarget.status).toBe(409);
    expect(diffTarget.data.error.code).toBe("request_id_conflict");
    feedbackApp.close();
  });

  it("运行中标记 <10min → request_in_flight；>10min → outcome_uncertain（惰性终结后可回放）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    const insertMarker = (requestId: string, createdAt: string) =>
      feedbackApp.db
        .prepare(
          "INSERT INTO assist_mgmt_requests (request_id, feedback_id, action, http_status, outcome_json, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        )
        .run(
          requestId,
          row.id,
          "trash",
          JSON.stringify({
            req: { action: "trash", expectedLifecycleVersion: 0, expectedRevision: null },
            res: null,
          }),
          createdAt,
        );

    insertMarker("rop-fresh", new Date().toISOString());
    const inflight = await postAction(feedbackApp.app, row.id, {
      requestId: "rop-fresh",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(inflight.status).toBe(409);
    expect(inflight.data.error.code).toBe("request_in_flight");

    insertMarker("rop-stale", new Date(Date.now() - 11 * 60 * 1000).toISOString());
    const stale = await postAction(feedbackApp.app, row.id, {
      requestId: "rop-stale",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe("outcome_uncertain");
    // 惰性终结：标记已转为完成行（http_status=409），同参数再来 → 回放已存结果
    const stored = mgmtRows(feedbackApp.db).find((r) => r.request_id === "rop-stale")!;
    expect(stored.http_status).toBe(409);
    const replay = await postAction(feedbackApp.app, row.id, {
      requestId: "rop-stale",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(replay.status).toBe(409);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.error.code).toBe("outcome_uncertain");
    feedbackApp.close();
  });

  it("purge 后 → 全部动作统一 not_found 404", async () => {
    const { feedbackApp } = makeMgmtApp();
    const row = seedFeedback(feedbackApp.db);
    expect(applyLifecycleInTx(feedbackApp.db, row.id, { action: "trash", expectedVersion: 0, actor: ACTOR }).kind).toBe(
      "ok",
    );
    expect(applyLifecycleInTx(feedbackApp.db, row.id, { action: "purge", expectedVersion: 1, actor: ACTOR }).kind).toBe(
      "purged",
    );
    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-p",
      action: "restore",
      expectedLifecycleVersion: 2,
    });
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe("not_found");
    const l = await jsonReq(feedbackApp.app, "GET", `/api/assist/feedback/${row.id}`, { bearer: READ });
    expect(l.status).toBe(404);
    feedbackApp.close();
  });

  it("不存在的 id → not_found 404（不落审计）", async () => {
    const { feedbackApp } = makeMgmtApp();
    const r = await postAction(feedbackApp.app, "no-such-id", {
      requestId: "r-nf",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe("not_found");
    expect(mgmtRows(feedbackApp.db)).toHaveLength(1); // 终态结果同样落库供回放
    feedbackApp.close();
  });
});

describe("busy 映射", () => {
  it("worker 持锁处理中 → 生命周期动作 409 busy", async () => {
    // AI organize 被闸住：反馈处于 processing 持锁中
    let aiEntered = false;
    let releaseAi: (() => void) | null = null;
    const ai: AiClient = {
      async organize() {
        aiEntered = true;
        await new Promise<void>((r) => {
          releaseAi = r;
        });
        return makeProcessed();
      },
      async test() {
        return { ok: true };
      },
      async testVision() {
        return { ok: true };
      },
    };
    const { feedbackApp } = makeMgmtApp({ ai });
    const row = seedFeedback(feedbackApp.db);
    feedbackApp.worker.enqueue(row.id);
    await waitFor(() => aiEntered);

    const r = await postAction(feedbackApp.app, row.id, {
      requestId: "r-busy",
      action: "trash",
      expectedLifecycleVersion: 0,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("busy");

    releaseAi!();
    await feedbackApp.worker.idle();
    expect(getFeedback(feedbackApp.db, row.id)!.status).toBe("needs_info");
    expect(getFeedback(feedbackApp.db, row.id)!.mgmt_state).toBe("inbox"); // busy 未生效
    feedbackApp.close();
  });
});

describe("迁移 v12：assist_mgmt_requests", () => {
  it("全新库建表 + 索引，user_version=12；http_status=0 运行中标记", () => {
    const db = openDb(tmpDir());
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    const cols = db.prepare("PRAGMA table_info(assist_mgmt_requests)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual([
      "request_id",
      "feedback_id",
      "action",
      "http_status",
      "outcome_json",
      "created_at",
    ]);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_amr_feedback'").get();
    expect(idx).toBeTruthy();
    db.close();
  });

  it("v10 旧库升级 → 仅新增 assist_mgmt_requests，不重排既有迁移", () => {
    const dir = tmpDir();
    const db = openDb(dir);
    // 模拟旧库：删掉本表并回退版本（SCHEMA 幂等重建，验证迁移块同样幂等）
    db.exec("DROP TABLE assist_mgmt_requests");
    db.exec("DROP INDEX IF EXISTS idx_amr_feedback");
    db.exec("PRAGMA user_version = 10");
    db.close();
    const db2 = openDb(dir);
    expect((db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    const t = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assist_mgmt_requests'").get();
    expect(t).toBeTruthy();
    db2.close();
  });
});
