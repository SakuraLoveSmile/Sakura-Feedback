import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createRateLimiter, type RateLimiter } from "../auth/ratelimit.ts";
import { nowIso } from "../db/db.ts";
import {
  applyLifecycleInTx,
  countFeedbacksByMgmt,
  type Db,
  getFeedback,
  insertFeedbackAudit,
  type LifecycleAction,
  listFeedbacks,
  type MgmtState,
} from "../db/repos.ts";
import { checkLimiter, type Err, err, fail, isErr, readBearer, readJson } from "../http.ts";
import type { Worker, WorkerOpResult } from "../pipeline/worker.ts";
import { assistAllowedActions, assistFeedbackDetail, assistListItem } from "./routes.ts";

/**
 * Assist 管理面路由组（contracts/feedback-integration.md §4，v1.1）。
 *
 * 仅中枢内网回连调用：`Authorization: Bearer <FEEDBACK_ASSIST_MGMT_KEY>`，
 * 恒定时间比较、统一 401、独立 60 次/分限流（与只读组各自计数）。
 * 凭证职责互斥：MGMT_KEY 只能读列表 + 执行本组动作，不能读附件字节、不能上报事件。
 *
 * 幂等（§4.2）：requestId 为客户端幂等键，落 `assist_mgmt_requests` 表——
 * 同 requestId+同目标+同动作回放已存结果；参数不同 → request_id_conflict；
 * 运行中标记 <10min → request_in_flight；>10min 视为崩溃残留惰性终结为 outcome_uncertain。
 */

/** Bearer 恒定时间比较（两侧先各自 sha256，避免长度差异泄露）。 */
function keyEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** §6 开放的管理动作全集（purge 不在其列——本面绝不提供彻底删除）。 */
const MGMT_ACTIONS = new Set([
  "archive",
  "unarchive",
  "trash",
  "restore",
  "resume_processing",
  "retry",
  "recheck",
] as const);

type MgmtAction = "archive" | "unarchive" | "trash" | "restore" | "resume_processing" | "retry" | "recheck";

const LIFECYCLE_MGMT_ACTIONS = new Set<MgmtAction>(["archive", "unarchive", "trash", "restore", "resume_processing"]);

/** 幂等键格式（契约 §4.2）。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** 运行中标记超过该时长视为崩溃残留（惰性终结为 outcome_uncertain）。 */
const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;
/** 完成行保留期（每次操作顺带惰性清理）。 */
const OUTCOME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 管理面操作的审计操作者（契约固定值）。 */
const ASSIST_ACTOR = { id: "assist", username: "Assistant" };

interface MgmtRequestRow {
  request_id: string;
  feedback_id: string;
  action: string;
  http_status: number;
  outcome_json: string;
  created_at: string;
}

/** assist_mgmt_requests.outcome_json 的存储结构：请求参数 + 响应体（运行中 res=null）。 */
interface StoredOutcome {
  req: {
    action: string;
    expectedLifecycleVersion: number | null;
    expectedRevision: number | null;
  };
  res: Record<string, unknown> | null;
}

/** 一次操作的终态结果（HTTP 状态 + 响应体），写入 outcome_json 供回放。 */
interface ActionOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface ActionParams {
  expectedLifecycleVersion: number | null;
  expectedRevision: number | null;
}

export interface AssistMgmtRouteDeps {
  db: Db;
  /** 管理接口凭证：FEEDBACK_ASSIST_MGMT_KEY（挂载方保证已配置且与只读凭证不同）。 */
  mgmtKey: string;
  worker: Worker;
  /** 测试可注入；默认 60 次/分。 */
  limiter?: RateLimiter;
}

/** ≥0 整数校验；undefined/null 视为未提供。 */
function parseExpected(v: unknown): number | undefined | Err {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    return err("invalid_request", "期望版本必须是 ≥0 的整数", 400);
  }
  return v;
}

export function assistMgmtRoutes(deps: AssistMgmtRouteDeps): Hono {
  const { db, worker } = deps;
  const limiter = deps.limiter ?? createRateLimiter(60, 60 * 1000);
  const routes = new Hono();

  // 本组全部端点：恒定时间 Bearer 校验（不接受 READ_KEY/SOURCE_KEY），然后限流。
  routes.use("*", async (c, next) => {
    const token = readBearer(c);
    if (token === null || !keyEqual(token, deps.mgmtKey)) {
      return fail(c, err("unauthorized", "需要认证", 401));
    }
    const limited = checkLimiter(limiter, "assist-mgmt");
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }
    await next();
  });

  // ---------- §4.1 列表 ----------
  routes.get("/feedback", (c) => {
    const rawView = c.req.query("view");
    let view: MgmtState | "all";
    if (rawView === undefined || rawView === "") {
      view = "inbox";
    } else if (rawView === "inbox" || rawView === "archived" || rawView === "trash" || rawView === "all") {
      view = rawView;
    } else {
      return fail(c, err("invalid_request", "view 参数非法，必须是 inbox / archived / trash / all", 400));
    }
    const q = c.req.query("q") || undefined;
    if (q !== undefined && q.length > 200) {
      return fail(c, err("invalid_request", "q 不能超过 200 字符", 400));
    }
    // limit 严格校验：缺省 50，提供时必须是 1..100 的整数（越界/非数字一律 invalid_request）。
    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return fail(c, err("invalid_request", "limit 必须是 1..100 的整数", 400));
      }
      limit = n;
    }
    const r = listFeedbacks(db, {
      view,
      q,
      cursor: c.req.query("cursor") || undefined,
      limit,
    });
    // 三区计数与列表同一套搜索条件（view 不计入）。
    const counts = countFeedbacksByMgmt(db, { q });
    return c.json({ items: r.items.map(assistListItem), nextCursor: r.nextCursor, counts });
  });

  // ---------- §4.2 单条操作 ----------
  routes.post("/feedback/:id/action", async (c) => {
    const feedbackId = c.req.param("id");
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);

    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return fail(c, err("invalid_request", "requestId 必填且须匹配 [A-Za-z0-9._:-]{1,128}", 400));
    }
    const actionRaw = typeof body.action === "string" ? body.action : "";
    if (!MGMT_ACTIONS.has(actionRaw as MgmtAction)) {
      return fail(
        c,
        err(
          "invalid_request",
          "action 必须是 archive / unarchive / trash / restore / resume_processing / retry / recheck 之一",
          400,
        ),
      );
    }
    const action = actionRaw as MgmtAction;
    const expectedLifecycleVersion = parseExpected(body.expectedLifecycleVersion);
    if (isErr(expectedLifecycleVersion)) return fail(c, expectedLifecycleVersion);
    const expectedRevision = parseExpected(body.expectedRevision);
    if (isErr(expectedRevision)) return fail(c, expectedRevision);
    const lifecycle = LIFECYCLE_MGMT_ACTIONS.has(action);
    if (lifecycle && expectedLifecycleVersion === undefined) {
      return fail(c, err("invalid_request", "生命周期动作必须携带 expectedLifecycleVersion（≥0 整数）", 400));
    }
    if (!lifecycle && expectedRevision === undefined) {
      return fail(c, err("invalid_request", "retry / recheck 必须携带 expectedRevision（≥0 整数）", 400));
    }

    const params: ActionParams = {
      expectedLifecycleVersion: expectedLifecycleVersion ?? null,
      expectedRevision: expectedRevision ?? null,
    };

    // ---- 幂等前置：清理过期完成行 + 查/插 requestId（同一事务，串行无并发问题） ----
    const begun = beginRequest(feedbackId, action, requestId, params);
    if (begun.kind === "replay") {
      const stored = safeParseOutcome(begun.row.outcome_json);
      const res = stored?.res ?? { error: { code: "outcome_uncertain", message: "该请求结果待确认" } };
      return c.json({ ...res, replayed: true }, begun.row.http_status as 200);
    }
    if (begun.kind === "conflict") {
      return fail(c, err("request_id_conflict", "requestId 已被不同参数的请求占用", 409));
    }
    if (begun.kind === "in_flight") {
      return fail(c, err("request_in_flight", "相同 requestId 的请求正在执行中，请拉取详情等待", 409));
    }
    if (begun.kind === "uncertain") {
      return fail(c, err("outcome_uncertain", "该请求先前执行结果待确认（可能已完成），请刷新详情核对", 409));
    }

    // ---- 执行（运行中标记已落库，期间同 requestId 到达 → request_in_flight） ----
    let outcome: ActionOutcome;
    try {
      outcome = await executeAction(feedbackId, action, params, requestId);
    } catch (e) {
      console.error(`[assist] 管理操作内部错误 ${action} ${feedbackId}: ${(e as Error).message?.slice(0, 200) ?? e}`);
      outcome = { status: 500, body: { error: { code: "internal", message: "服务器内部错误" } } };
    }
    finalizeRequest(requestId, action, params, outcome);
    return c.json(outcome.body, outcome.status as 200);
  });

  /**
   * 幂等请求前置（单事务）：惰性清理过期完成行 → 查 requestId →
   * 无记录则插入运行中标记（http_status=0）；崩溃残留（>10min）就地终结为 outcome_uncertain。
   */
  function beginRequest(
    feedbackId: string,
    action: MgmtAction,
    requestId: string,
    params: ActionParams,
  ):
    | { kind: "started" }
    | { kind: "replay"; row: MgmtRequestRow }
    | { kind: "conflict" }
    | { kind: "in_flight" }
    | { kind: "uncertain" } {
    db.exec("BEGIN IMMEDIATE");
    try {
      // 顺带惰性清理：完成行保留 30 天（契约 §4.2）。
      db.prepare("DELETE FROM assist_mgmt_requests WHERE http_status > 0 AND created_at < ?").run(
        new Date(Date.now() - OUTCOME_RETENTION_MS).toISOString(),
      );
      const row = db.prepare("SELECT * FROM assist_mgmt_requests WHERE request_id = ?").get(requestId) as
        | MgmtRequestRow
        | undefined;
      let result:
        | { kind: "started" }
        | { kind: "replay"; row: MgmtRequestRow }
        | { kind: "conflict" }
        | { kind: "in_flight" }
        | { kind: "uncertain" };
      if (!row) {
        const stored: StoredOutcome = {
          req: { action, ...params },
          res: null,
        };
        db.prepare(
          "INSERT INTO assist_mgmt_requests (request_id, feedback_id, action, http_status, outcome_json, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        ).run(requestId, feedbackId, action, JSON.stringify(stored), nowIso());
        result = { kind: "started" };
      } else if (row.http_status === 0) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (Number.isFinite(ageMs) && ageMs <= IN_FLIGHT_STALE_MS) {
          // 运行中：参数不同按冲突处理（requestId 已被别的请求占用）。
          result = sameParams(row, action, params) ? { kind: "in_flight" } : { kind: "conflict" };
        } else {
          // 崩溃残留：惰性终结为 outcome_uncertain（保留原参数，供原请求方回放核对）。
          const stored = safeParseOutcome(row.outcome_json);
          const finalBody = {
            ok: false,
            error: { code: "outcome_uncertain", message: "该请求先前执行结果待确认（可能已完成），请刷新详情核对" },
          };
          const finalized: StoredOutcome = {
            req: stored?.req ?? { action: row.action, expectedLifecycleVersion: null, expectedRevision: null },
            res: finalBody,
          };
          db.prepare("UPDATE assist_mgmt_requests SET http_status = 409, outcome_json = ? WHERE request_id = ?").run(
            JSON.stringify(finalized),
            requestId,
          );
          result = { kind: "uncertain" };
        }
      } else {
        result =
          row.feedback_id === feedbackId && sameParams(row, action, params)
            ? { kind: "replay", row }
            : { kind: "conflict" };
      }
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 完成请求：同一事务内把运行中标记更新为终态结果。 */
  function finalizeRequest(requestId: string, action: MgmtAction, params: ActionParams, outcome: ActionOutcome): void {
    const stored: StoredOutcome = { req: { action, ...params }, res: outcome.body };
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE assist_mgmt_requests SET http_status = ?, outcome_json = ? WHERE request_id = ?").run(
        outcome.status,
        JSON.stringify(stored),
        requestId,
      );
      db.exec("COMMIT");
    } catch (e) {
      // 终结失败 → 标记残留为运行中，10 分钟后惰性转 outcome_uncertain；本次响应照常返回。
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn(`[assist] 幂等结果写入失败 ${requestId}: ${(e as Error).message?.slice(0, 200) ?? e}`);
    }
  }

  function sameParams(row: MgmtRequestRow, action: MgmtAction, params: ActionParams): boolean {
    if (row.action !== action) return false;
    const stored = safeParseOutcome(row.outcome_json);
    if (!stored?.req) return false;
    return (
      stored.req.action === action &&
      stored.req.expectedLifecycleVersion === params.expectedLifecycleVersion &&
      stored.req.expectedRevision === params.expectedRevision
    );
  }

  /**
   * 执行动作（运行中标记已落库后调用）。先按实时 allowedActions 再确认动作开放
   * （防止 Detail 过期后被拒于更晚阶段——worker / applyLifecycleInTx 本身同样会拒绝）。
   */
  async function executeAction(
    feedbackId: string,
    action: MgmtAction,
    params: ActionParams,
    requestId: string,
  ): Promise<ActionOutcome> {
    const row = getFeedback(db, feedbackId);
    if (!row) {
      // 不存在与已彻底删除统一 not_found（读接口不区分 gone）。
      return { status: 404, body: { error: { code: "not_found", message: "反馈不存在" } } };
    }
    if (!assistAllowedActions(row).includes(action)) {
      return {
        status: 409,
        body: {
          error: { code: "invalid_state", message: `当前状态不允许执行 ${action}` },
          detail: assistFeedbackDetail(db, row, true),
        },
      };
    }
    if (action === "retry" || action === "recheck") {
      return runWorkerOp(feedbackId, action, params, requestId);
    }
    return runLifecycle(feedbackId, action, params, requestId);
  }

  /** 生命周期五动作：与 worker 共用同一反馈级互斥锁 + 事务 + 审计（actor 固定 assist）。 */
  function runLifecycle(
    feedbackId: string,
    action: LifecycleAction,
    params: ActionParams,
    _requestId: string,
  ): ActionOutcome {
    const locked = worker.withFeedbackLock(feedbackId, () =>
      applyLifecycleInTx(db, feedbackId, {
        action,
        expectedVersion: params.expectedLifecycleVersion ?? 0,
        actor: ASSIST_ACTOR,
      }),
    );
    if (!locked.ok) {
      return { status: 409, body: { error: { code: "busy", message: "该记录正在处理中，请稍后重试" } } };
    }
    const o = locked.value;
    if (o.kind === "ok") {
      // 锁已释放后才入队：resume_processing 显式恢复处理。
      if (o.enqueue) {
        try {
          worker.enqueue(feedbackId);
        } catch {
          /* 入队失败不影响已落库结果：重启恢复扫描会拾起 */
        }
      }
      const after = getFeedback(db, feedbackId);
      return {
        status: 200,
        body: {
          ok: true,
          action,
          replayed: false,
          detail: after ? assistFeedbackDetail(db, after, true) : null,
        },
      };
    }
    if (o.kind === "not_found" || o.kind === "purged" || o.kind === "already_purged") {
      // purge 不在本面动作集（校验阶段已拒绝）；这里作防御性 not_found。
      return { status: 404, body: { error: { code: "not_found", message: "反馈不存在" } } };
    }
    const after = getFeedback(db, feedbackId);
    const detail = after ? { detail: assistFeedbackDetail(db, after, true) } : {};
    if (o.kind === "version_conflict") {
      return {
        status: 409,
        body: {
          error: {
            code: "version_conflict",
            message: `记录已被其他操作修改（当前生命周期版本 ${o.lifecycleVersion}），请刷新后重试`,
          },
          lifecycleVersion: o.lifecycleVersion,
          ...detail,
        },
      };
    }
    return {
      status: 409,
      body: { error: { code: "invalid_state", message: o.reason }, ...detail },
    };
  }

  /** retry / recheck：走 worker 既有恢复入口（自带锁与 revision 校验）。 */
  async function runWorkerOp(
    feedbackId: string,
    action: "retry" | "recheck",
    params: ActionParams,
    requestId: string,
  ): Promise<ActionOutcome> {
    let r: WorkerOpResult;
    try {
      r =
        action === "retry"
          ? worker.retry(feedbackId, params.expectedRevision ?? undefined)
          : await worker.recheck(feedbackId, params.expectedRevision ?? undefined);
    } catch (e) {
      console.error(`[assist] ${action} 执行异常 ${feedbackId}: ${(e as Error).message?.slice(0, 200) ?? e}`);
      return { status: 500, body: { error: { code: "internal", message: "服务器内部错误" } } };
    }
    if (r.ok) {
      insertFeedbackAudit(db, {
        feedbackId,
        actor: ASSIST_ACTOR,
        action,
        detail: { requestId, expectedRevision: params.expectedRevision, via: "assist" },
      });
      const after = getFeedback(db, feedbackId);
      return {
        status: 200,
        body: {
          ok: true,
          action,
          replayed: false,
          detail: after ? assistFeedbackDetail(db, after, true) : null,
        },
      };
    }
    if (r.reason === "not_found") {
      return { status: 404, body: { error: { code: "not_found", message: "反馈不存在" } } };
    }
    if (r.reason === "busy") {
      return { status: 409, body: { error: { code: "busy", message: "该反馈正在被其他操作处理，请稍后重试" } } };
    }
    const after = getFeedback(db, feedbackId);
    const detail = after ? { detail: assistFeedbackDetail(db, after, true) } : {};
    if (r.reason === "revision_conflict") {
      return {
        status: 409,
        body: {
          error: { code: "revision_conflict", message: "数据已被并发修改（revision 冲突），请刷新后重试" },
          revision: r.revision ?? null,
          ...detail,
        },
      };
    }
    if (r.reason === "persist_failed") {
      return { status: 500, body: { error: { code: "internal", message: "本地状态写入失败，已停止后续操作" } } };
    }
    // invalid_state / target_changed 统一按 invalid_state 返回（reason 可展示）。
    const reasonText =
      r.reason === "target_changed"
        ? `归档目标与当前 Kaneo 配置不一致，已停止远端操作${r.note ? `（${r.note}）` : ""}`
        : `当前状态不可执行该操作${r.note ? `（${r.note}）` : r.status ? `（${r.status}）` : ""}`;
    return {
      status: 409,
      body: { error: { code: "invalid_state", message: reasonText }, ...detail },
    };
  }

  return routes;
}

function safeParseOutcome(raw: string): StoredOutcome | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as StoredOutcome;
    return null;
  } catch {
    return null;
  }
}
