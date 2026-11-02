/**
 * Kaneo 完成状态回读（v13+，反馈 0.8.0）：
 *
 * Kaneo 任务所在项目里由 `isFinal` 标记的列即「完成列」。反馈已归档、且任务进入
 * 该列时，把 Issue 问题状态置为 `resolved`，并写入一条用户可见的系统处理说明
 * （与「标记已解决」一致：计入未读、用户端对话时间线可见）。
 *
 * 边界（刻意保守）：
 * - 自动扫描只处理 `issue_status = open`、非回收站、已归档且有任务 ID 的反馈；
 *   已进入人工对话（waiting_user / waiting_admin）的记录不自动关闭，避免吞掉
 *   管理员与用户的进行中沟通。管理端单条入口由管理员显式触发，可覆盖非 open 状态。
 * - 只认 Kaneo 明确的 `isFinal === true`；旧版 Kaneo 缺字段时不做任何推断。
 * - 任务不在完成列、Kaneo 不可达、项目没有完成列均只记录结果，绝不改本地状态。
 * - 同步只在状态确实变化时写入；已是 resolved 的反馈不会重复产生消息。
 */

import { type Db, nowIso } from "../db/db.ts";
import { type FeedbackRow, getApp, getFeedback, listKaneoSyncCandidates, updateIssueStatusInTx } from "../db/repos.ts";
import {
  type KaneoClient,
  type KaneoColumn,
  KaneoDefiniteError,
  type KaneoTaskRef,
  KaneoUncertainError,
} from "./kaneo.ts";

/** 系统同步写入用户对话的固定处理说明（用户可见）。 */
export const KANEO_SYNC_RESOLUTION_NOTE = "任务看板中的对应任务已完成，问题已标记为已解决。";

/** 审计动作：与人工「标记已解决」（issue_status_change）区分。 */
export const KANEO_SYNC_AUDIT_ACTION = "kaneo_status_sync";

/** 自动扫描默认单批上限；避免一次扫描对 Kaneo 发出过多只读请求。 */
export const KANEO_SYNC_DEFAULT_BATCH = 50;

/** 系统同步的审计操作者（真实用户 ID 为空，管理端审计显示为系统）。 */
const SYNC_ACTOR = { id: "", username: "系统（Kaneo 同步）" } as const;

export type KaneoSyncOutcomeKind =
  | "resolved"
  | "already_resolved"
  | "no_task"
  | "task_missing"
  | "task_state_missing"
  | "no_final_column"
  | "not_final"
  | "skipped_status"
  | "kaneo_unavailable"
  | "version_conflict"
  | "not_found"
  | "trash";

export type KaneoSyncOutcome =
  | {
      kind: "resolved";
      message: string;
      issueStatus: "resolved";
      dialogueVersion: number;
      resolutionNote: string;
      taskId: string;
      columnSlug: string;
      columnName: string;
    }
  | {
      kind: "not_final";
      message: string;
      currentStatus: string;
      finalColumnSlug: string;
      finalColumnName: string;
    }
  | { kind: "skipped_status"; message: string; issueStatus: string }
  | { kind: Exclude<KaneoSyncOutcomeKind, "resolved" | "not_final" | "skipped_status">; message: string };

export interface KaneoSyncDeps {
  db: Db;
  kaneo: KaneoClient;
}

export interface SyncFeedbackOptions {
  /**
   * 允许同步非 open 状态（管理端单条显式触发时为 true）。
   * 自动扫描必须保持 false，避免自动关闭进行中的人工对话。
   */
  allowNonOpen?: boolean;
  /** 批量扫描内复用列列表，减少重复 Kaneo 只读请求。 */
  columnsCache?: Map<string, KaneoColumn[]>;
}

/** Kaneo 只读故障 → 稳定的结果文案（不泄露密钥；长度截断）。 */
function kaneoFailure(err: unknown): { kind: "kaneo_unavailable"; message: string } {
  const raw =
    err instanceof KaneoDefiniteError || err instanceof KaneoUncertainError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { kind: "kaneo_unavailable", message: `Kaneo 读取失败：${raw.slice(0, 240)}` };
}

/** 任务所属项目：优先 Kaneo 响应，其次人工分类目标，最后软件默认项目。 */
function resolveProjectId(db: Db, row: FeedbackRow, task: KaneoTaskRef): string | null {
  if (task.projectId) return task.projectId;
  if (row.classify_project_id) return row.classify_project_id;
  const app = getApp(db, row.app_row_id);
  return app?.kaneo_project_id || null;
}

/**
 * 同步单条反馈：读取 Kaneo 任务当前列，命中完成列时置为已解决并写入系统说明。
 * 只读 Kaneo；本地只在满足条件时写入一次。不会抛出 Kaneo 故障（转为结果）。
 */
export async function syncFeedbackFromKaneo(
  deps: KaneoSyncDeps,
  feedbackId: string,
  opts: SyncFeedbackOptions = {},
): Promise<KaneoSyncOutcome> {
  const row = getFeedback(deps.db, feedbackId);
  if (!row) return { kind: "not_found", message: "反馈不存在" };
  if (row.mgmt_state === "trash") return { kind: "trash", message: "回收站中的反馈只读，无法同步" };

  const taskId = (row.kaneo_task_id ?? "").trim();
  if (!taskId) return { kind: "no_task", message: "该反馈没有关联的任务，无法同步" };
  if (row.issue_status === "resolved") {
    return { kind: "already_resolved", message: "该问题已是已解决状态" };
  }
  if (!opts.allowNonOpen && row.issue_status !== "open") {
    return {
      kind: "skipped_status",
      message: "问题已进入人工处理流程，自动同步已跳过",
      issueStatus: row.issue_status,
    };
  }

  let task: KaneoTaskRef | null;
  try {
    task = await deps.kaneo.getTask(taskId);
  } catch (err) {
    return kaneoFailure(err);
  }
  if (!task) return { kind: "task_missing", message: "Kaneo 中找不到对应任务" };
  if (!task.status) {
    return { kind: "task_state_missing", message: "Kaneo 任务响应缺少当前列状态，无法判断是否完成" };
  }

  const projectId = resolveProjectId(deps.db, row, task);
  if (!projectId) {
    return { kind: "task_state_missing", message: "无法确定任务所属项目，无法判断完成列" };
  }

  let columns = opts.columnsCache?.get(projectId);
  if (!columns) {
    try {
      columns = await deps.kaneo.listColumns(projectId);
    } catch (err) {
      return kaneoFailure(err);
    }
    opts.columnsCache?.set(projectId, columns);
  }
  const finalColumn = columns.find((c) => c.isFinal === true);
  if (!finalColumn) {
    return { kind: "no_final_column", message: "任务所属项目没有标记为完成（isFinal）的列" };
  }

  if (task.status !== finalColumn.slug) {
    const currentName = columns.find((c) => c.slug === task.status)?.name ?? task.status;
    return {
      kind: "not_final",
      message: `任务尚未完成（当前列：${currentName}）`,
      currentStatus: task.status,
      finalColumnSlug: finalColumn.slug,
      finalColumnName: finalColumn.name,
    };
  }

  const updated = updateIssueStatusInTx(
    deps.db,
    feedbackId,
    "resolved",
    SYNC_ACTOR,
    row.dialogue_version,
    KANEO_SYNC_RESOLUTION_NOTE,
    {
      action: KANEO_SYNC_AUDIT_ACTION,
      detail: {
        source: "kaneo",
        taskId,
        columnSlug: finalColumn.slug,
        columnName: finalColumn.name,
        syncedAt: nowIso(),
      },
    },
  );
  if (!updated.ok) {
    if (updated.error === "version_conflict") {
      return { kind: "version_conflict", message: "对话已被其他人更新，请稍后重试" };
    }
    if (updated.error === "not_found") return { kind: "not_found", message: "反馈不存在" };
    return { kind: "skipped_status", message: "问题状态已变化，未自动同步", issueStatus: row.issue_status };
  }

  return {
    kind: "resolved",
    message: "已同步为已解决，并已通知提交者",
    issueStatus: "resolved",
    dialogueVersion: updated.dialogueVersion,
    resolutionNote: KANEO_SYNC_RESOLUTION_NOTE,
    taskId,
    columnSlug: finalColumn.slug,
    columnName: finalColumn.name,
  };
}

export interface KaneoSyncBatchReport {
  checked: number;
  resolved: number;
  skipped: number;
  failed: number;
  results: Array<{ id: string; kind: KaneoSyncOutcomeKind; message: string }>;
}

function classifyOutcome(kind: KaneoSyncOutcomeKind): "resolved" | "skipped" | "failed" {
  if (kind === "resolved") return "resolved";
  if (kind === "kaneo_unavailable" || kind === "version_conflict" || kind === "task_state_missing") return "failed";
  return "skipped";
}

/**
 * 批量同步候选反馈（自动扫描与管理端批量入口共用）：
 * 只取自动候选（open + 已归档 + 有任务），逐条同步并汇总结果。
 */
export async function syncOpenArchivedFeedbacks(
  deps: KaneoSyncDeps,
  opts: { limit?: number } = {},
): Promise<KaneoSyncBatchReport> {
  const ids = listKaneoSyncCandidates(deps.db, opts.limit ?? KANEO_SYNC_DEFAULT_BATCH);
  const columnsCache = new Map<string, KaneoColumn[]>();
  const report: KaneoSyncBatchReport = { checked: 0, resolved: 0, skipped: 0, failed: 0, results: [] };
  for (const id of ids) {
    report.checked++;
    let outcome: KaneoSyncOutcome;
    try {
      outcome = await syncFeedbackFromKaneo(deps, id, { columnsCache });
    } catch (err) {
      outcome = {
        kind: "kaneo_unavailable",
        message: `同步失败：${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`,
      };
    }
    const bucket = classifyOutcome(outcome.kind);
    report[bucket]++;
    report.results.push({ id, kind: outcome.kind, message: outcome.message });
  }
  return report;
}

export interface KaneoIssueSyncServiceOptions {
  db: Db;
  kaneo: KaneoClient;
  /** 自动扫描间隔（毫秒）；<= 0 关闭自动扫描（管理端仍可手动触发）。 */
  intervalMs?: number;
  /** 每次自动扫描的条数上限。 */
  batch?: number;
  /** 首次自动扫描延迟（默认 60s，给部署后的健康检查留出窗口）。 */
  initialDelayMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface KaneoIssueSyncService {
  /** 立即执行一轮自动候选同步（测试 / 管理端可复用）。 */
  runOnce(): Promise<KaneoSyncBatchReport>;
  start(): void;
  stop(): void;
}

/**
 * 后台自动同步服务：定时扫描已归档且仍为 open 的反馈，任务完成即标记已解决。
 * `intervalMs <= 0` 时不启动定时器（测试/关闭自动同步场景）。
 */
export function createKaneoIssueSync(opts: KaneoIssueSyncServiceOptions): KaneoIssueSyncService {
  const logger = opts.logger ?? console;
  const intervalMs = opts.intervalMs ?? 0;
  const batch = opts.batch ?? KANEO_SYNC_DEFAULT_BATCH;
  const initialDelayMs = Math.max(0, opts.initialDelayMs ?? 60_000);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  // 串行化：定时器与管理端手动触发可能同时发生，避免同一反馈被并发读取/写入。
  let chain: Promise<unknown> = Promise.resolve();

  function schedule(delayMs: number): void {
    if (stopped || intervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      void runAndReschedule();
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  async function runAndReschedule(): Promise<void> {
    if (stopped) return;
    try {
      const report = await service.runOnce();
      if (report.checked > 0) {
        logger.info(
          `[kaneo-sync] 检查 ${report.checked} 条：已解决 ${report.resolved}，跳过 ${report.skipped}，失败 ${report.failed}`,
        );
      }
    } catch (err) {
      logger.warn(`[kaneo-sync] 自动同步失败：${(err as Error).message ?? String(err)}`);
    }
    schedule(intervalMs);
  }

  const service: KaneoIssueSyncService = {
    runOnce(): Promise<KaneoSyncBatchReport> {
      const next = chain.then(() => syncOpenArchivedFeedbacks({ db: opts.db, kaneo: opts.kaneo }, { limit: batch }));
      chain = next.catch(() => undefined);
      return next;
    },
    start(): void {
      if (intervalMs <= 0) return;
      stopped = false;
      if (timer) return;
      schedule(Math.min(initialDelayMs, intervalMs));
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
  return service;
}
