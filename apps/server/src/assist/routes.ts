import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createRateLimiter, type RateLimiter } from "../auth/ratelimit.ts";
import {
  type AdminFeedbackRow,
  collectionStateForFeedback,
  collectionStateOf,
  type Db,
  type FeedbackRow,
  getApp,
  getFeedback,
  getFeedbackLog,
  getFeedbackLogsMeta,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  lifecycleAvailableActions,
} from "../db/repos.ts";
import { checkLimiter, type Err, err, fail, readBearer } from "../http.ts";
import { parseArchiveData } from "../pipeline/archive-data.ts";

/**
 * Assist 接入只读回连路由（contracts/feedback-integration.md §5）。
 *
 * 仅 GET、仅中枢回连：Bearer 恒定时间校验 + 每密钥 60 次/分限流；
 * 全部鉴权失败统一 401，已彻底删除与不存在统一 404（读接口不区分 gone）。
 * 由挂载方保证「接入开启且存在可用密钥」才挂载本组。
 *
 * v1.1：详情响应新增管理面字段（mgmtState/lifecycleVersion/revision/issueStatus/
 * collectionState/resumePaused/archiveStage/kaneoTaskUrl/archivedAt/trashedAt/
 * allowedActions/capabilities），旧版中枢按缺席即「不支持管理」处理。
 */

/** Bearer 恒定时间比较（两侧先各自 sha256，避免长度差异泄露）。 */
function keyEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * 详情/操作响应用的完整管理动作集（契约 §3/§6）：
 * 生命周期动作按 `lifecycleAvailableActions` 口径去掉 `purge`（本面不提供彻底删除），
 * 再按状态并上 `retry`（failed，或 needs_info 且无 AI 整理结果——与 worker.retry 同口径）
 * 与 `recheck`（needs_review）。回收站记录为只读：retry/recheck 不开放（worker 同样拒绝）。
 */
export function assistAllowedActions(
  row: Pick<FeedbackRow, "status" | "mgmt_state" | "resume_paused" | "processed_json">,
): string[] {
  const actions: string[] = lifecycleAvailableActions(row).filter((a) => a !== "purge");
  if (row.mgmt_state !== "trash") {
    if (row.status === "failed" || (row.status === "needs_info" && !row.processed_json)) actions.push("retry");
    if (row.status === "needs_review") actions.push("recheck");
  }
  return actions;
}

/**
 * 列表项用的轻量动作集（契约 §4.1）：仅生命周期动作子集（去 purge），
 * 不含 retry/recheck——列表不解析归档恢复数据。
 */
export function assistListAllowedActions(row: Pick<FeedbackRow, "status" | "mgmt_state" | "resume_paused">): string[] {
  return lifecycleAvailableActions(row).filter((a) => a !== "purge");
}

/** 归档恢复数据 revision（无有效归档数据视为 0；retry/recheck 乐观锁维度）。 */
export function assistRevision(row: Pick<FeedbackRow, "archive_data_json">): number {
  const parsed = parseArchiveData(row.archive_data_json);
  return parsed.kind === "valid" ? parsed.data.revision : 0;
}

/**
 * Issue 状态：本版本尚无 Issue 对话特性（预留给 schema v11 的 issue_status 列），
 * 一律回退 "open"；若库表未来带列则自动读出真实值（结构与主仓 v11 口径一致）。
 */
function issueStatusOf(row: Pick<FeedbackRow, "id">): string {
  return (row as { issue_status?: string | null }).issue_status ?? "open";
}

/**
 * §3 详情对象（v1.1 完整形状）：只读详情与操作响应共用同一构造，
 * 保证「操作后快照 == 重新拉详情」。
 */
export function assistFeedbackDetail(db: Db, row: FeedbackRow, manageEnabled: boolean) {
  const logs = getFeedbackLogsMeta(db, row.id);
  const hasScreenshot = getFeedbackScreenshotMeta(db, row.id) !== null;
  const app = getApp(db, row.app_row_id);
  return {
    id: row.id,
    appId: row.app_id,
    appName: app?.name ?? null,
    status: row.status,
    title: row.title,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorSummary: row.error_summary,
    hasScreenshot,
    logs: logs.map((l) => ({
      id: l.id,
      filename: l.filename,
      byteSize: l.byte_size,
      sha256: l.sha256,
      source: l.source,
    })),
    // ---- v1.1 管理面扩展字段 ----
    mgmtState: row.mgmt_state,
    lifecycleVersion: row.lifecycle_version,
    revision: assistRevision(row),
    issueStatus: issueStatusOf(row),
    collectionState: collectionStateForFeedback(db, row),
    resumePaused: Boolean(row.resume_paused),
    archiveStage: row.archive_stage,
    kaneoTaskUrl: row.kaneo_task_url,
    archivedAt: row.mgmt_archived_at,
    trashedAt: row.mgmt_trashed_at,
    allowedActions: assistAllowedActions(row),
    capabilities: { manage: manageEnabled },
  };
}

/** §4.1 列表项投影（不含管理员专属字段；collectionState 用联表字段现算）。 */
export function assistListItem(r: AdminFeedbackRow) {
  return {
    id: r.id,
    appId: r.app_id,
    appName: r.app_name ?? null,
    status: r.status,
    issueStatus: issueStatusOf(r),
    mgmtState: r.mgmt_state,
    lifecycleVersion: r.lifecycle_version,
    title: r.title,
    textPreview: r.text_preview ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    errorSummary: r.error_summary,
    hasScreenshot: Boolean(r.has_screenshot),
    logCount: r.log_count ?? 0,
    collectionState: collectionStateOf(r),
    resumePaused: Boolean(r.resume_paused),
    allowedActions: assistListAllowedActions(r),
  };
}

export interface AssistRouteDeps {
  db: Db;
  /** 回连密钥：FEEDBACK_ASSIST_READ_KEY（缺省回退 SOURCE_KEY，由挂载方解析）。 */
  readKey: string;
  /** v1.1：管理组是否已挂载（详情 capabilities.manage 如实上报）。 */
  manageEnabled?: boolean;
  /** 测试可注入；默认 60 次/分。 */
  limiter?: RateLimiter;
}

export function assistRoutes(deps: AssistRouteDeps): Hono {
  const { db } = deps;
  const manageEnabled = deps.manageEnabled === true;
  const limiter = deps.limiter ?? createRateLimiter(60, 60 * 1000);
  const routes = new Hono();

  // 本组全部端点：恒定时间 Bearer 校验，然后限流；鉴权失败一律 401。
  routes.use("*", async (c, next) => {
    const token = readBearer(c);
    if (token === null || !keyEqual(token, deps.readKey)) {
      return fail(c, err("unauthorized", "需要认证", 401));
    }
    const limited = checkLimiter(limiter, "assist-read");
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }
    await next();
  });

  // 反馈详情：状态机当前值 + 附件元数据清单 + v1.1 管理面字段（实时口径）。
  routes.get("/feedback/:id", (c) => {
    const row = getFeedback(db, c.req.param("id"));
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));
    return c.json(assistFeedbackDetail(db, row, manageEnabled));
  });

  // 截图附件：image/png + Content-Length + ETag（sha256 即内容指纹）。
  routes.get("/feedback/:id/attachments/screenshot", (c) => {
    const shot = getFeedbackScreenshot(db, c.req.param("id"));
    if (!shot) return fail(c, err("not_found", "截图不存在", 404));
    return new Response(shot.png_blob as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(shot.byte_size),
        etag: `"${shot.sha256}"`,
        "cache-control": "no-store",
      },
    });
  });

  // 日志附件：octet-stream 下载（与既有管理端下载一致的 Content-Disposition）。
  // 不属于该反馈的日志同样 404，不区分「不存在」与「别人的」。
  routes.get("/feedback/:id/attachments/logs/:logId", (c) => {
    const log = getFeedbackLog(db, c.req.param("id"), c.req.param("logId"));
    if (!log) return fail(c, err("not_found", "日志附件不存在", 404));
    const safeFilename = encodeURIComponent(log.filename).replace(/['()]/g, escape);
    return new Response(log.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${log.filename}"; filename*=UTF-8''${safeFilename}`,
        "content-length": String(log.byte_size),
        "cache-control": "no-store",
      },
    });
  });

  return routes;
}
