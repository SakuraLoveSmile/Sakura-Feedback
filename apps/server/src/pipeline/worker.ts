import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import {
  type AppRow,
  authorizeArchiveInTx,
  clearAutoBlocked,
  type FeedbackRow,
  findAiPendingCandidates,
  findAutoArchiveCandidates,
  findNextAutoRetryAt,
  finishAiOrganization,
  getApp,
  getAppSource,
  getFeedback,
  getFeedbackLogs,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  getUserById,
  isAppRuleComplete,
  isManuallyHandled,
  markAutoBlocked,
  parseAppLabelIds,
  resolveOutputPixels,
  updateFeedback,
} from "../db/repos.ts";
import { type AiClient, AiError, prepareLogEvidence } from "../services/ai.ts";
import { resolveArchiveTarget } from "../services/archive-target.ts";
import {
  buildLogComment,
  buildScreenshotComment,
  buildTaskDescription,
  type KaneoClient,
  KaneoColumnNotFound,
  KaneoDefiniteError,
  type KaneoLabel,
  type KaneoSettings,
  KaneoUncertainError,
} from "../services/kaneo.ts";
import { normalizeKaneoApiBase } from "../services/kaneo-http.ts";
import {
  type ArchiveAttachmentRecord,
  type ArchiveData,
  type ArchiveDataNext,
  type ArchiveDataV3,
  type ArchiveLabelRecord,
  ArchivePersistenceError,
  type ArchiveTarget,
  type ArchiveUpload,
  ArchiveVersionConflictError,
  buildUploadRecord,
  checkArchiveTarget,
  commentMarker,
  decryptUploadCredentials,
  loadArchiveData,
  logCommentMarker,
  MAX_SAME_KEY_RECOVERIES,
  normalizeToV3,
  type ParsedArchiveData,
  parseArchiveData,
  saveArchiveData,
  type UploadCredentials,
  writeArchiveSnapshot,
} from "./archive-data.ts";

const MAX_ATTEMPTS = 3; // AI 调用（含格式失败/超时/限流）单轮最多 3 次
/** 自动归档扫描的批大小：每次触发按批取候选，不依赖一次性内存队列。 */
const AUTO_SCAN_BATCH = 50;

/**
 * 4.5 阶段矛盾检查：归档阶段 / 任务 ID / 恢复数据互相矛盾时返回描述（→待核对，不猜测重建）。
 * 只检查确定性矛盾；旧格式（legacy）记录不在 V1/V2 字段层面检查。
 */
function stageContradiction(row: FeedbackRow, parsed: ParsedArchiveData): string | null {
  const data = parsed.kind === "valid" ? parsed.data : null;
  if (row.archive_stage === "complete" && row.status !== "archived") {
    return `archive_stage=complete 但 status=${row.status}`;
  }
  const attachments = data && "attachments" in data ? (data as ArchiveDataV3).attachments : {};
  const hasAnyAttachmentData = Boolean(
    data && (data.upload || data.asset || data.comment || (attachments && Object.keys(attachments).length > 0)),
  );
  if (hasAnyAttachmentData && !row.kaneo_task_id) {
    return "恢复数据含上传/资产/评论状态但缺少 Kaneo 任务 ID";
  }
  if (data?.asset && data.asset.id !== "" && !data.upload) {
    return "资产已登记（id 已知）但缺少上传记录";
  }
  if (row.archive_stage === "asset_finalized" && data && !data.asset) {
    return "archive_stage=asset_finalized 但恢复数据缺少资产信息";
  }
  if (row.archive_stage === "comment_pending" && data && !data.asset) {
    return "archive_stage=comment_pending 但恢复数据缺少资产信息";
  }
  return null;
}

function getLogContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-jsonlines";
  return "text/plain";
}

/** 归档完成判定：截图 + 全部日志 + 全部目标标签都已确认，缺一不可。 */
function isFullyArchived(
  data: ArchiveDataV3 | null,
  hasScreenshot: boolean,
  logs: { id: string }[],
  labelIds: string[] = [],
): boolean {
  if (!data) return false;
  if (hasScreenshot) {
    const s = data.attachments?.screenshot;
    const sConfirmed = s?.comment?.outcome === "confirmed" || data.comment?.outcome === "confirmed";
    if (!sConfirmed) return false;
  }
  for (const log of logs) {
    const l = data.attachments?.[log.id];
    if (l?.comment?.outcome !== "confirmed") return false;
  }
  for (const id of labelIds) {
    if (data.labels?.[id]?.outcome !== "confirmed") return false;
  }
  return true;
}

/**
 * 该记录是否已经开始远端写入（T3 门槛判定）：
 * 已知任务 ID，或恢复数据里存在任何“可能/已经发出”的上传、资产、评论痕迹。
 * 仅固定了目标（只读操作）不算远端写入。
 */
function hasRemoteWriteEvidence(row: FeedbackRow): boolean {
  if (row.kaneo_task_id) return true;
  const parsed = parseArchiveData(row.archive_data_json);
  if (parsed.kind !== "valid") return false;
  const d = parsed.data;
  if (d.upload && d.upload.outcome !== "not_sent") return true;
  if (d.asset || d.comment) return true;
  const attachments = "attachments" in d ? d.attachments : {};
  for (const att of Object.values(attachments)) {
    if (att.asset || att.comment) return true;
    if (att.upload && att.upload.outcome !== "not_sent") return true;
  }
  return false;
}

/**
 * AI 整理失败时使用原文回退（T2：AI 仅整理内容，失败保留原文）：
 * 标题取原文首个非空行，描述由 buildTaskDescription 用空分节 + 用户原话生成。
 */
function fallbackProcessed(text: string): Parameters<typeof buildTaskDescription>[1] {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const title =
    Array.from(firstLine ?? "用户反馈")
      .slice(0, 80)
      .join("") || "用户反馈";
  return { title, sections: { experience: "", problems: "", suggestions: "", questions: "" } };
}

/** 人工/自动操作的统一结果：ok=false 时 reason 由路由映射为明确的 HTTP 语义（busy/revision_conflict 等）。 */
export interface WorkerOpResult {
  ok: boolean;
  status?: string;
  revision?: number;
  reason?: "not_found" | "invalid_state" | "busy" | "revision_conflict" | "persist_failed" | "target_changed";
  replaced?: boolean;
  note?: string;
}

export interface WorkerDeps {
  db: Db;
  masterKey: Buffer;
  ai: AiClient;
  kaneo: KaneoClient;
  /**
   * 读取当前 Kaneo 连接配置（含解密后的密钥）：每次操作只调用一次，
   * 之后整个操作固定使用该份配置（bind），绝不在请求之间重新读取。
   */
  snapshotKaneoSettings: () => KaneoSettings | null;
  sleep?: (ms: number) => Promise<void>;
  /**
   * U1-4：更新暂停判定。返回 true 时 worker 既不取队也不处理——更新期间**零归档调用**
   * （不写 Kaneo、不调 AI、不改本地状态）。队列保留在内存中，解除暂停后自动继续。
   */
  writesPaused?: () => boolean;
  /** 暂停期间的轮询间隔（毫秒），默认 500。 */
  pausePollMs?: number;
  /**
   * T3 可注入时钟与定时器：默认用 `Date.now` / `setTimeout`（自动 unref，不阻止进程退出）。
   * 测试注入可控时钟并推进时间，观察真实调度（绝不靠手动清空退避字段或调用扫描代替）。
   */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 单次扫描批量（默认 50）；仅用于测试收紧批量以覆盖多轮补处理。 */
  scanBatch?: number;
}

/**
 * 处理流水线的唯一驱动者。串行处理（并发 1），提交/恢复时入队。
 * 状态机见 docs/api.md。正常处理与人工操作共用同一反馈级操作锁（4.4）。
 */
export function createWorker(deps: WorkerDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const scanBatch = deps.scanBatch ?? AUTO_SCAN_BATCH;
  const queue: string[] = [];
  /** 正在排空队列的 promise（并发调用共享同一次排空，绝不并行处理）。 */
  let drainPromise: Promise<void> | null = null;
  /** 当前正在处理的反馈（扫描时避免重复入队）。 */
  let activeId: string | null = null;
  /** T3 调度器：扫描请求合并 + 串行批次循环 + 可取消的到点重试定时器。 */
  let scanRequested = false;
  let scanRunning = false;
  let retryTimer: unknown = null;
  let stopped = false;
  // 反馈级操作锁：同一反馈并发操作只有一个获得处理权，其余返回可识别 busy。
  const busyFeedbacks = new Set<string>();
  const pausePollMs = deps.pausePollMs ?? 500;

  /** 当前是否处于更新暂停（控制面读取异常一律按未暂停处理，绝不因此卡死流水线）。 */
  function paused(): boolean {
    if (!deps.writesPaused) return false;
    try {
      return deps.writesPaused();
    } catch {
      return false;
    }
  }

  function enqueue(feedbackId: string): void {
    if (!queue.includes(feedbackId)) queue.push(feedbackId);
    void drain();
  }

  /**
   * 排空内存队列（并发调用共享同一次排空）。
   * 更新暂停：不取队、不处理，等暂停解除后继续（绝不丢弃已入队的工作）。
   */
  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    const p = (async () => {
      while (queue.length > 0) {
        if (paused()) {
          await sleep(pausePollMs);
          continue;
        }
        const id = queue.shift()!;
        activeId = id;
        try {
          await processOne(id);
        } catch (err) {
          // processOne 内部已兜底；到这里说明是程序性 bug，标 failed 留痕
          safeFail(id, `worker 内部错误: ${(err as Error).message?.slice(0, 200) ?? String(err)}`);
        } finally {
          activeId = null;
        }
      }
      // 非扫描路径（提交 / 人工操作直接入队）也可能产生“可恢复退避”记录：
      // 队列排空后按库内最早到期时间重新安排定时器（扫描循环进行中时由它统一安排）。
      if (!scanRunning) scheduleRetryTimer();
    })();
    // 排空异常已在内部逐条兜底；这里保证 drainPromise 永不 reject（调用方多为 fire-and-forget）。
    drainPromise = p
      .catch(() => undefined)
      .finally(() => {
        drainPromise = null;
      });
    return drainPromise;
  }

  /**
   * 等待队列排空（测试与优雅关闭用）。
   * U1-4：更新暂停期间立即返回——此时执行器正在等待本服务退出（`compose stop -t 30`），
   * 若在这里死等排空会让停机超时被 SIGKILL，WAL 留在盘上、升级中止。
   * 队列仍保留在内存（服务随后会被重建），解除暂停后由 drain 继续处理。
   * 注意：暂停期间调用方不应再写数据库（调用顺序见 index.ts 的优雅退出）。
   * T3：同时等待调度器当前这一轮扫描跑完，否则 `idle()` 可能在两批之间提前返回。
   */
  async function idle(): Promise<void> {
    while (drainPromise || queue.length > 0 || scanRunning) {
      if (paused()) return;
      await sleep(5);
    }
  }

  function safeFail(id: string, summary: string): void {
    try {
      updateFeedback(deps.db, id, {
        status: "failed",
        error_summary: summary.slice(0, 300),
        last_error: summary.slice(0, 1000),
      });
    } catch {
      /* db 已损坏时无可奈何 */
    }
  }

  /**
   * 4.1 持久化门禁：本地状态/恢复信息写入失败时转入待核对（尽力而为），调用方必须立即返回，
   * 绝不继续下一步远端写入。冲突类失败（损坏/未知版本/revision 变化）同样拒绝覆盖。
   */
  function stopForPersistenceFailure(feedbackId: string, what: string, err: unknown): void {
    const summary =
      err instanceof ArchiveVersionConflictError
        ? "归档恢复数据版本检查失败，已停止处理，待核对"
        : err instanceof ArchivePersistenceError
          ? `归档恢复信息持久化失败（${what}），已停止后续远端写入，待核对`
          : `本地状态写入失败（${what}），已停止后续远端写入，待核对`;
    try {
      updateFeedback(deps.db, feedbackId, {
        status: "needs_review",
        error_summary: summary.slice(0, 300),
        last_error: `${what}: ${(err as Error).message?.slice(0, 300)}`.slice(0, 1000),
      });
    } catch {
      /* 数据库不可写时连待核对也写不进：保留原状态，由重启恢复兜底 */
    }
  }

  /** 带持久化门禁的字段更新：成功返回 true；失败转待核对并返回 false（调用方须立即返回）。 */
  function gateUpdate(feedbackId: string, what: string, patch: Parameters<typeof updateFeedback>[2]): boolean {
    try {
      updateFeedback(deps.db, feedbackId, patch);
      return true;
    } catch (err) {
      stopForPersistenceFailure(feedbackId, what, err);
      return false;
    }
  }

  // ---------- 4.4 反馈级操作锁与 revision 乐观锁 ----------

  function tryAcquire(feedbackId: string): boolean {
    if (busyFeedbacks.has(feedbackId)) return false;
    busyFeedbacks.add(feedbackId);
    return true;
  }

  function release(feedbackId: string): void {
    busyFeedbacks.delete(feedbackId);
  }

  /**
   * v9：管理生命周期动作与 worker 共用同一反馈级互斥。
   * 管理端在执行归档/回收站/彻底删除等动作前必须先拿到同一把锁：
   * 锁被 worker 持有时返回 ok=false（界面显示“处理中，稍后重试”，绝不强行中断外部请求）。
   * fn 为同步函数（SQLite 事务是同步的）。
   */
  function withFeedbackLock<T>(feedbackId: string, fn: () => T): { ok: true; value: T } | { ok: false } {
    if (!tryAcquire(feedbackId)) return { ok: false };
    try {
      return { ok: true, value: fn() };
    } finally {
      release(feedbackId);
    }
  }

  /** 显式人工操作即“恢复处理”：解除恢复后暂停标记（暂停只挡自动扫描与出队，不挡人工动作）。 */
  function clearResumePause(feedbackId: string, row: FeedbackRow): void {
    if (row.resume_paused) updateFeedback(deps.db, feedbackId, { resume_paused: 0 });
  }

  /** 当前恢复数据 revision（无归档数据视为 0）。 */
  function currentRevision(feedbackId: string): number {
    const parsed = loadArchiveData(deps.db, feedbackId);
    return parsed.kind === "valid" ? parsed.data.revision : 0;
  }

  /** 人工操作 revision 校验：expectedRevision 缺省不校验（兼容旧调用），提供则必须与当前一致。 */
  function checkRevision(feedbackId: string, expectedRevision: number | undefined): WorkerOpResult | null {
    if (expectedRevision === undefined) return null;
    const cur = currentRevision(feedbackId);
    if (expectedRevision !== cur) {
      return { ok: false, reason: "revision_conflict", revision: cur };
    }
    return null;
  }

  /** 保存恢复数据（门禁语义）：失败时尽力转待核对并返回 null。 */
  function saveRecoveryState(feedbackId: string, next: ArchiveDataNext, what: string): ArchiveData | null {
    try {
      return saveArchiveData(deps.db, feedbackId, loadArchiveData(deps.db, feedbackId), next);
    } catch (err) {
      stopForPersistenceFailure(feedbackId, what, err);
      return null;
    }
  }

  function appOf(row: FeedbackRow): AppRow | null {
    return getApp(deps.db, row.app_row_id);
  }

  /**
   * 固定本次操作的 Kaneo 客户端与配置（P1）：
   * 整个操作（含其中全部远端步骤与重试）只用这一份配置与这个客户端实例，
   * 绝不读取之后被修改的全局配置，避免同一操作被拆到不同实例/项目上。
   */
  function bindKaneo(): { client: KaneoClient; settings: KaneoSettings; apiBase: string } | null {
    let settings: KaneoSettings | null;
    try {
      settings = deps.snapshotKaneoSettings();
    } catch {
      // 密钥无法解密等配置读取失败：按未配置处理，绝不发出远端写入
      settings = null;
    }
    if (!settings?.baseUrl || !settings.apiKey) return null;
    return {
      client: deps.kaneo.bind(settings),
      settings,
      apiBase: normalizeKaneoApiBase(settings.baseUrl),
    };
  }

  /**
   * 人工恢复入口的统一前置（P1）：固定一份配置 → 确认当前目标 → 与已保存目标比对。
   *
   * - 连接未配置 → invalid_state（绝不发出远端操作）；
   * - 已保存目标与当前目标不一致 → target_changed，**不发出任何远端写入**且恢复数据原样保留；
   * - 完整流程返回 `{ bound }` 供调用方使用同一个固定客户端。
   */
  async function prepareRecovery(
    row: FeedbackRow,
    saved: ArchiveData | null,
  ): Promise<{ ok: true; client: KaneoClient; apiBase: string } | { ok: false; result: WorkerOpResult }> {
    const bound = bindKaneo();
    if (!bound) {
      return { ok: false, result: { ok: false, reason: "invalid_state", note: "Kaneo 连接未配置" } };
    }
    const app = appOf(row);
    // T3：已固定快照优先（人工授权选择的目标），仅在完全没有快照时才回退到软件默认项目。
    const pinnedProjectId = saved?.target.projectId ?? app?.kaneo_project_id ?? "";
    if (!pinnedProjectId) {
      return { ok: false, result: { ok: false, reason: "invalid_state", note: "应用未配置 Kaneo 目标项目" } };
    }
    if (!saved) return { ok: true, client: bound.client, apiBase: bound.apiBase };

    let resolved: ArchiveTarget;
    try {
      const proj = await bound.client.getProjectInfo(pinnedProjectId);
      resolved = { apiBase: bound.apiBase, projectId: proj.id, workspaceId: proj.workspaceId };
    } catch (err) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "invalid_state",
          note: `无法确认当前 Kaneo 目标，已停止远端操作：${(err as Error).message?.slice(0, 150) ?? ""}`,
        },
      };
    }
    const check = checkArchiveTarget(saved, resolved);
    if (check.status === "changed") {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "target_changed",
          note: `已保存的归档目标与当前配置不一致（${check.field}），已停止远端操作，恢复数据原样保留`,
        },
      };
    }
    return { ok: true, client: bound.client, apiBase: bound.apiBase };
  }

  /**
   * 自动归档授权（T3）：仅在“自动模式已启用 + 来源已确认 + 规则完整有效 + Kaneo 目标有效”
   * 时调用同一套人工授权事务与快照逻辑；其余情况保持已接收状态并写明阻塞原因。
   *
   * 返回 true 表示该记录已（或有）归档授权，调用方可以继续归档阶段。
   * 返回 false 表示本记录暂不授权，调用方必须立即返回（不发起任何远端写入）。
   */
  async function autoAuthorizeIfEligible(feedbackId: string): Promise<boolean> {
    const db = deps.db;
    const row = getFeedback(db, feedbackId);
    if (!row) return false;
    if (row.archive_authorized_at) return true; // 已授权（人工或自动）
    if (row.status !== "needs_info") return false;
    // T3 人工保护（入口）：管理员已经保存过分类（含缺项暂存、清空后保存）的记录
    // 一律不自动授权、不写阻塞原因，交由管理员继续“保存并归档”或重新保存。
    if (isManuallyHandled(row)) return false;

    const app = appOf(row);
    // 已软删除的软件：历史记录保留可读，但绝不再发起新的自动归档授权
    // （已授权记录走固定快照继续，不经过这里）。
    if (!app || app.deleted_at) {
      markAutoBlocked(db, feedbackId, "config", "软件配置不存在或已删除", 0, now());
      return false;
    }
    if (app.archive_mode !== "automatic" || app.config_status !== "configured") return false;

    // 规则不完整 / 来源不明 / 来源待确认：属于**配置问题**，等待管理员处理，不做退避。
    if (!isAppRuleComplete(app)) {
      markAutoBlocked(
        db,
        feedbackId,
        "config",
        "自动归档规则不完整：需要选择项目、目标列与至少一个工作区标签",
        0,
        now(),
      );
      return false;
    }
    if (!row.source_origin) {
      markAutoBlocked(db, feedbackId, "config", "该记录来源无法确定（历史数据），不参与自动归档", 0, now());
      return false;
    }
    const source = getAppSource(db, app.id, row.source_origin);
    if (!source || source.status !== "confirmed") {
      markAutoBlocked(db, feedbackId, "config", "来源尚未确认，确认后会自动补处理", 0, now());
      return false;
    }

    const bound = bindKaneo();
    if (!bound) {
      markAutoBlocked(db, feedbackId, "config", "Kaneo 连接未配置，配置后会自动补处理", 0, now());
      return false;
    }
    const baseUrl = bound.settings.baseUrl;
    const labelIds = parseAppLabelIds(app.kaneo_label_ids);

    // 只读核对目标（列 / 工作区标签 / 负责人是否仍然有效）。
    const resolved = await resolveArchiveTarget(bound.client, {
      projectId: app.kaneo_project_id,
      columnId: app.kaneo_column_id,
      labelIds,
      assigneeId: app.kaneo_assignee_id,
    });
    if (!resolved.ok) {
      const attempts = row.auto_attempts + 1;
      markAutoBlocked(db, feedbackId, resolved.kind, resolved.reason, attempts, now());
      if (resolved.kind === "retryable") {
        // 可恢复故障：退避后由扫描重试；此处不等待、不阻塞队列。
        console.warn(`[worker] 自动归档暂缓（可恢复）：反馈 ${feedbackId} — ${resolved.reason}`);
      }
      return false;
    }
    const target = resolved.target;
    const apiBase = normalizeKaneoApiBase(baseUrl);

    // 授权者记为**启用该规则的管理员**（自动授权同样留痕到审计）。
    const enabler = app.auto_enabled_by ? getUserById(db, app.auto_enabled_by) : null;
    const actor = enabler
      ? { id: enabler.id, username: enabler.username }
      : { id: app.auto_enabled_by ?? "", username: "自动归档规则" };

    // 操作幂等键固定绑定“记录 + 规则版本”：重复扫描/并发 worker 只会授权一次。
    const operationId = `auto:${feedbackId}:${app.rule_version}`;
    let outcome: ReturnType<typeof authorizeArchiveInTx>;
    try {
      outcome = authorizeArchiveInTx(db, feedbackId, {
        expectedVersion: row.classify_version,
        operationId,
        patch: {
          projectId: target.project.id,
          columnId: target.column.id,
          columnSlug: target.column.slug,
          labelIds: target.labels.map((l) => l.id),
          assigneeId: target.assigneeId,
          assigneeName: target.assigneeName,
        },
        actor,
        kind: "auto",
        autoGuard: { appRowId: app.id, ruleVersion: app.rule_version, sourceOrigin: row.source_origin },
        buildSnapshot: (existingRaw) => {
          const base = parseArchiveData(existingRaw);
          return writeArchiveSnapshot(db, feedbackId, base, {
            apiBase,
            project: { id: target.project.id, workspaceId: target.project.workspaceId },
            column: { id: target.column.id, slug: target.column.slug },
            labels: target.labels,
            assigneeId: target.assigneeId,
          });
        },
      });
    } catch (err) {
      // 快照写入被拒（恢复数据损坏/并发修改）→ 保持等待，交给人工核对路径。
      markAutoBlocked(
        db,
        feedbackId,
        "config",
        `归档快照写入被拒绝：${(err as Error).message.slice(0, 200)}`,
        0,
        now(),
      );
      return false;
    }

    if (outcome.kind === "authorized") {
      clearAutoBlocked(db, feedbackId);
      return true;
    }
    if (outcome.kind === "manual_protected") {
      // 事务内发现管理员刚保存过分类：保持人工内容，不授权、不留阻塞原因。
      return false;
    }
    if (outcome.kind === "rule_changed") {
      // 停用 / 改规则 / 来源回退的竞争：不授权，交给扫描下一轮重新评估。
      return false;
    }
    if (outcome.kind === "version_conflict") {
      return false;
    }
    if (outcome.kind === "operation_conflict") {
      return true; // 已被其他操作授权：按已授权继续
    }
    markAutoBlocked(
      db,
      feedbackId,
      "config",
      outcome.kind === "locked" ? "该记录已进入归档流程，不再自动授权" : "自动归档规则不完整，无法授权",
      0,
      now(),
    );
    return false;
  }

  /** 当前可执行的候选（AI 待整理 + 自动归档待补处理），排除已在队列或正在处理的记录。 */
  function collectCandidates(): string[] {
    const ids: string[] = [];
    const push = (id: string): void => {
      if (queue.includes(id) || activeId === id) return;
      if (!ids.includes(id)) ids.push(id);
    };
    for (const row of findAiPendingCandidates(deps.db, scanBatch)) push(row.id);
    for (const row of findAutoArchiveCandidates(deps.db, now(), scanBatch)) push(row.id);
    return ids;
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  /** 按库内最早到期的可恢复退避安排一个**可取消**定时器：到点重新查库并处理。 */
  function scheduleRetryTimer(): void {
    try {
      clearRetryTimer();
      if (stopped) return;
      const next = findNextAutoRetryAt(deps.db);
      if (next === null) return;
      retryTimer = setTimer(
        () => {
          retryTimer = null;
          requestScan();
        },
        Math.max(0, next - now()),
      );
    } catch {
      // 读取 / 定时器失败都不影响既有队列：下一次触发会重新安排。
    }
  }

  /**
   * 请求一次可恢复扫描（T3 统一调度入口）。
   * - 请求合并：扫描进行中只置位标记，由当前这一轮接续处理；
   * - 串行调度：一次只有一个扫描循环，循环内一批 50 条处理完再取下一批，直到没有新候选；
   * - 每批处理过即记入 `attempted`，同一轮不重复尝试同一条，避免空转与饥饿；
   * - 扫描结束按库内最早到期的退避重新安排定时器（启用规则、确认来源、配置修正、
   *   AI 完成、服务恢复都走这里，不依赖管理员重复点击）。
   */
  function requestScan(): void {
    if (stopped) return;
    scanRequested = true;
    clearRetryTimer();
    if (!scanRunning) void runScanLoop();
  }

  async function runScanLoop(): Promise<void> {
    if (scanRunning) return;
    scanRunning = true;
    const attempted = new Set<string>();
    try {
      // 一批处理结束后继续查询，直到没有“尚未在本轮尝试过”的可执行候选：
      // 51 条 = 50 + 1，121 条 = 50 + 50 + 21，批次上限不限制总吞吐。
      while (!stopped) {
        scanRequested = false;
        let candidates: string[];
        try {
          candidates = collectCandidates();
        } catch (err) {
          // 扫描失败不影响既有队列：下一次触发会重新扫描。
          console.warn(`[worker] 自动归档扫描失败: ${(err as Error).message?.slice(0, 200)}`);
          return;
        }
        const fresh = candidates.filter((id) => !attempted.has(id));
        if (fresh.length === 0) break;
        for (const id of fresh) {
          attempted.add(id);
          enqueue(id);
        }
        console.log(`[worker] 自动归档扫描：入队 ${fresh.length} 条`);
        await drain();
      }
    } finally {
      scanRunning = false;
      if (scanRequested && !stopped) {
        void runScanLoop();
      } else {
        scheduleRetryTimer();
      }
    }
  }

  /**
   * 停止调度与定时器（优雅退出第一步）。
   * 只停止“安排新工作”：已入队的记录仍由 `idle()` 排空后再关闭数据库，
   * 停止后不再有任何定时器回调访问数据库。
   */
  function stop(): void {
    stopped = true;
    scanRequested = false;
    clearRetryTimer();
  }

  async function processOne(feedbackId: string): Promise<void> {
    // 更新暂停期间连单条处理入口也不放行（人工动作与 drain 都经过这里）。
    if (paused()) return;
    if (!tryAcquire(feedbackId)) return; // 该反馈正被其他操作处理；持锁方负责后续入队
    try {
      await processLocked(feedbackId);
    } finally {
      release(feedbackId);
    }
  }

  async function processLocked(feedbackId: string): Promise<void> {
    const db = deps.db;
    let row = getFeedback(db, feedbackId);
    if (!row) return;
    // v9：开始任何处理前重读管理状态——回收站与恢复后暂停的记录不进入 AI/归档/自动授权。
    // 排队期间被移入回收站的记录在这里被拦下（持锁期间管理动作不可能并发修改本记录）。
    if (row.mgmt_state !== "inbox" || row.resume_paused) return;
    const authorized = Boolean(row.archive_authorized_at && row.archive_operation_id);
    // “已开始远端写入”的既有记录（旧版本遗留）允许沿既有恢复入口继续；
    // 从未产生远端写入、也没有人工授权的记录绝不允许归档（必须先人工补齐并确认）。
    const resumable = authorized || hasRemoteWriteEvidence(row);
    const isAiPhase = (row.status === "received" || row.status === "processing") && !resumable;
    const isArchivePhase =
      row.status === "ready_to_archive" || ((row.status === "received" || row.status === "processing") && resumable);
    /**
     * T3 自动授权阶段：AI 已整理完成、尚未授权、也从未发生远端写入。
     * 只有满足“自动模式 + 来源已确认 + 规则完整有效”时才会真正授权（见 autoAuthorizeIfEligible）；
     * 已被管理员人工编辑的记录不进这个阶段（绝不覆盖人工内容）。
     */
    const isAutoAuthorizePhase =
      row.status === "needs_info" &&
      !row.archive_authorized_at &&
      !hasRemoteWriteEvidence(row) &&
      !isManuallyHandled(row);

    const app = appOf(row);
    if (!app) {
      updateFeedback(db, feedbackId, { status: "failed", error_summary: "软件配置不存在或已删除" });
      return;
    }

    if (isAutoAuthorizePhase) {
      if (!(await autoAuthorizeIfEligible(feedbackId))) return;
      row = getFeedback(db, feedbackId) ?? row;
    }

    if (!isAiPhase && !isArchivePhase && !isAutoAuthorizePhase) return;

    if (isAiPhase) {
      if (row.status === "received") {
        updateFeedback(db, feedbackId, { status: "processing", archive_stage: "task_pending", kaneo_task_id: null });
        row = getFeedback(db, feedbackId)!;
      }

      // ---- AI 整理（仅整理内容，绝不触发任何远端归档） ----
      let processed = row.processed_json
        ? (JSON.parse(row.processed_json) as Parameters<typeof buildTaskDescription>[1])
        : null;
      if (!processed) {
        updateFeedback(db, feedbackId, { status: "processing" });
        const screenshot = getFeedbackScreenshot(db, feedbackId);
        const screenshotMeta = screenshot ? getFeedbackScreenshotMeta(db, feedbackId) : null;
        const logs = getFeedbackLogs(db, feedbackId);
        const logEvidence = logs.length > 0 ? prepareLogEvidence(logs) : null;
        let lastErr: AiError | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          updateFeedback(db, feedbackId, { attempt_count: row.attempt_count + attempt });
          try {
            processed = await deps.ai.organize(
              row.text,
              screenshot
                ? {
                    pngBuffer: Buffer.from(screenshot.png_blob),
                    releasePoint: screenshotMeta?.capture?.releasePoint,
                    viewport: screenshotMeta?.capture
                      ? {
                          width: screenshotMeta.capture.viewportWidth,
                          height: screenshotMeta.capture.viewportHeight,
                        }
                      : undefined,
                    // 输出像素优先（pixelWidth/pixelHeight，兼容 outputWidth/outputHeight 别名）
                    outputPixels: resolveOutputPixels(screenshotMeta?.capture),
                  }
                : null,
              logEvidence,
            );
            break;
          } catch (err) {
            const aiErr =
              err instanceof AiError
                ? err
                : new AiError("network", `AI 未知错误: ${(err as Error).message?.slice(0, 150)}`, false);
            lastErr = aiErr;
            if (!aiErr.retryable || attempt === MAX_ATTEMPTS) break;
            await sleep(attempt * 1000);
          }
        }
        // AI 失败**不再把记录判为 failed**：保留原文，用原文标题/描述回退，等待人工分类。
        const fallback = fallbackProcessed(row.text);
        finishAiOrganization(db, feedbackId, {
          title: processed?.title ?? fallback.title,
          processedJson: processed ? JSON.stringify(processed) : null,
          errorSummary: processed
            ? null
            : `AI 整理失败，已使用原文标题/描述：${lastErr?.message.slice(0, 200) ?? "未知错误"}`,
          lastError: processed
            ? null
            : lastErr
              ? `AI 阶段失败（kind=${lastErr.kind}）: ${lastErr.message}`.slice(0, 1000)
              : "AI 阶段失败",
        });
      } else {
        finishAiOrganization(db, feedbackId, {
          title: processed.title,
          processedJson: JSON.stringify(processed),
          errorSummary: null,
          lastError: null,
        });
      }

      // 提交本身仍不授权归档（T2 门槛不变）；这里只把**已满足自动归档规则**的记录
      // 交给同一个授权事务与快照逻辑（T3）。不满足条件的记录保持 needs_info 等待配置。
      if (!(await autoAuthorizeIfEligible(feedbackId))) return;
      row = getFeedback(db, feedbackId) ?? row;
    }

    // ---- 归档阶段：必须有持久化的归档授权（人工或自动），或该记录在旧版本中已经开始远端写入 ----
    // 注意：AI 阶段结束后可能刚完成一次自动授权，因此这里必须读**最新**的行，
    // 不能用进入函数时的旧快照判断。
    if (!row.archive_authorized_at && !hasRemoteWriteEvidence(row)) {
      // 防御性返回：没有归档授权、也没有已开始的远端写入时绝不发起任何远端写入
      // （普通保存与重启扫描都走不到这里）。
      // T3 人工保护：管理员已保存过分类的记录保持原状（可能是 ready_to_archive 或
      // 缺项/清空后的 needs_info），绝不改写成“尚未授权”的失败态。
      if (isManuallyHandled(row)) return;
      updateFeedback(db, feedbackId, {
        status: "needs_info",
        error_summary: "尚未完成归档授权，已停止远端归档",
      });
      return;
    }
    const processed = row.processed_json
      ? (JSON.parse(row.processed_json) as Parameters<typeof buildTaskDescription>[1])
      : fallbackProcessed(row.text);
    await archive(row, app, processed);
  }

  async function archive(
    row: FeedbackRow,
    app: AppRow,
    processed: Parameters<typeof buildTaskDescription>[1],
  ): Promise<void> {
    const db = deps.db;
    // ---- T3 门槛：只有持久化的人工归档授权可以执行**首次**远端写入；旧版本中已开始远端写入的
    // 记录沿用既有恢复入口继续，但两者都不允许“普通保存 / 重启扫描”触发归档。 ----
    if (!row.archive_authorized_at && !hasRemoteWriteEvidence(row)) {
      updateFeedback(db, row.id, {
        status: "needs_info",
        error_summary: "尚未完成人工归档授权，已停止远端归档",
      });
      return;
    }
    const pinnedProject = row.classify_project_id ?? app.kaneo_project_id;
    const pinnedColumnSlug = row.classify_column_slug ?? app.kaneo_column_slug;
    if (!pinnedProject || !pinnedColumnSlug) {
      updateFeedback(db, row.id, {
        status: "failed",
        error_summary: "分类缺少目标项目或列，已停止归档",
      });
      return;
    }
    // P1：本次归档操作固定一份 Kaneo 客户端配置（含全部后续远端步骤），
    // 之后即使管理员改了连接配置也不影响本次操作。
    const bound = bindKaneo();
    if (!bound) {
      updateFeedback(db, row.id, { status: "failed", error_summary: "Kaneo 连接未配置" });
      return;
    }
    const kaneo = bound.client;
    const baseUrl = bound.settings.baseUrl;

    // ---- 4.1 恢复数据解析：损坏 / 未知版本 → 待核对，绝不猜测重建、绝不覆盖 ----
    const parsedArchive = loadArchiveData(db, row.id);
    if (parsedArchive.kind === "corrupt" || parsedArchive.kind === "unsupported") {
      try {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary:
            parsedArchive.kind === "corrupt"
              ? "归档恢复数据损坏，已停止处理，待核对"
              : `归档恢复数据版本 v${parsedArchive.version} 不受支持，已停止处理，待核对`,
          last_error:
            parsedArchive.kind === "corrupt"
              ? `archive_data_json: ${parsedArchive.reason}`.slice(0, 1000)
              : `archive_data_json: version=${parsedArchive.version}`,
        });
      } catch {
        /* 数据库不可写：保留原状态，由重启恢复兜底 */
      }
      return;
    }
    let cur: ArchiveDataV3 | null = parsedArchive.kind === "valid" ? normalizeToV3(parsedArchive.data) : null;

    // ---- 4.5 阶段矛盾检查：阶段/任务/附件状态互相矛盾 → 待核对，不猜测重建 ----
    const contradiction = stageContradiction(row, parsedArchive);
    if (contradiction) {
      try {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "归档阶段与恢复数据矛盾，已停止处理，待核对",
          last_error: contradiction.slice(0, 1000),
        });
      } catch {
        /* 数据库不可写：保留原状态 */
      }
      return;
    }

    const screenshot = getFeedbackScreenshot(db, row.id);

    // ---- 4.5 仅 assetUrl 的旧记录：先经鉴权下载核对真实字节，再补齐恢复信息（不猜测） ----
    if (parsedArchive.kind === "legacy" && parsedArchive.assetUrl) {
      if (!screenshot) {
        try {
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: "旧格式记录含资产链接但缺少本地截图，无法核对，待人工核对",
          });
        } catch {
          /* 同上 */
        }
        return;
      }
      try {
        const bytes = await kaneo.downloadAsset(parsedArchive.assetUrl);
        const sha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
        if (sha !== screenshot.sha256) {
          // 字节不匹配：不能默认沿用，也不能猜测重建 → 待核对
          try {
            updateFeedback(db, row.id, {
              status: "needs_review",
              error_summary: "旧格式记录资产字节与本地截图不一致，已停止处理，待核对",
            });
          } catch {
            /* 同上 */
          }
          return;
        }
      } catch (err) {
        // 下载失败（含 404）不能证明文件不存在 → 结果不确定 → 待核对
        try {
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: "旧格式记录资产核对失败（结果不确定），待人工核对",
            last_error: `downloadAsset: ${(err as Error).message.slice(0, 300)}`.slice(0, 1000),
          });
        } catch {
          /* 同上 */
        }
        return;
      }
    }

    // ---- 4.1 首次远端写入前固定恢复目标（Kaneo 实例 / 项目 / 工作区 / 列 / 标签 / 负责人） ----
    // T3：以**人工授权快照**为准。授权后即使软件配置或 Kaneo 选项变化，本次任务也不会被重定向；
    // 仅在没有任何恢复数据（理论上不可达）时才回退到软件默认目标。
    const pinned = cur?.target;
    const authorizedProjectId = pinned?.projectId ?? pinnedProject;
    const authorizedColumnSlug = pinned?.columnSlug ?? pinnedColumnSlug;
    const authorizedColumnId = pinned?.columnId ?? "";
    const authorizedLabelIds = pinned?.labelIds ?? [];
    const authorizedAssigneeId = pinned?.assigneeId ?? null;

    const target: ArchiveTarget = {
      apiBase: normalizeKaneoApiBase(baseUrl),
      projectId: authorizedProjectId,
      workspaceId: "",
      columnId: authorizedColumnId,
      columnSlug: authorizedColumnSlug,
      labelIds: authorizedLabelIds,
      assigneeId: authorizedAssigneeId,
    };
    try {
      const proj = await kaneo.getProjectInfo(authorizedProjectId);
      target.projectId = proj.id;
      target.workspaceId = proj.workspaceId;
    } catch (err) {
      // 目标无法确认时绝不发出任何写入
      const msg = err instanceof KaneoDefiniteError ? err.message : `Kaneo 错误: ${(err as Error).message}`;
      updateFeedback(db, row.id, {
        status: "failed",
        error_summary: `无法确认 Kaneo 目标工作区：${msg.slice(0, 250)}`,
        last_error: `固定恢复目标失败: ${msg}`.slice(0, 1000),
      });
      return;
    }
    const targetCheck = checkArchiveTarget(cur, target);
    if (targetCheck.status === "changed") {
      updateFeedback(db, row.id, {
        status: "needs_review",
        error_summary: `归档恢复目标已改变（${targetCheck.field}），停止处理，待核对`,
        last_error: `已固定目标 ${JSON.stringify(cur?.target ?? null)} 与当前目标 ${JSON.stringify(target)}`.slice(
          0,
          1000,
        ),
      });
      return;
    }
    if (targetCheck.status === "fresh") {
      // 固定目标；旧格式仅含 assetUrl 时迁移为 asset.url（id 未知记 ""），其余恢复信息原样保留
      try {
        const legacyAssetUrl = parsedArchive.kind === "legacy" ? parsedArchive.assetUrl : undefined;
        const next: ArchiveDataNext = {
          target,
          labels: cur?.labels ?? {},
          attachments: cur?.attachments ?? {},
          ...(cur?.upload ? { upload: cur.upload } : {}),
          ...(legacyAssetUrl ? { asset: { id: "", url: legacyAssetUrl } } : cur?.asset ? { asset: cur.asset } : {}),
          ...(cur?.comment ? { comment: cur.comment } : {}),
        };
        const saved = saveArchiveData(db, row.id, loadArchiveData(db, row.id), next);
        cur = normalizeToV3(saved);
      } catch (err) {
        stopForPersistenceFailure(row.id, "固定恢复目标", err);
        return;
      }
    }
    if (!cur) {
      // 防御：目标固定后恢复数据必然存在；不可达时按损坏处理
      try {
        updateFeedback(db, row.id, { status: "needs_review", error_summary: "归档恢复数据缺失，已停止处理，待核对" });
      } catch {
        /* 同上 */
      }
      return;
    }

    /** 4.1 持久化门禁：保存下一版恢复数据；失败（含版本检查失败）转待核对并返回 false。 */
    function persistArchive(next: ArchiveDataNext, what: string): boolean {
      try {
        const saved = saveArchiveData(db, row.id, loadArchiveData(db, row.id), next);
        cur = normalizeToV3(saved);
        return true;
      } catch (err) {
        stopForPersistenceFailure(row.id, what, err);
        return false;
      }
    }

    // 阶段 1：创建任务（若已有 taskId 且阶段已过 task_pending，则复用，不再创建）
    let taskId = row.archive_stage && row.archive_stage !== "task_pending" ? row.kaneo_task_id : null;
    let taskUrl = row.archive_stage && row.archive_stage !== "task_pending" ? row.kaneo_task_url : null;

    if (!taskId) {
      const context = row.context_json ? (JSON.parse(row.context_json) as Record<string, string>) : {};
      const logs = getFeedbackLogs(db, row.id);
      const description = buildTaskDescription(row.id, processed, {
        appName: app.name,
        appId: app.app_id,
        appVersion: context.appVersion,
        pageLabel: context.pageLabel,
        submittedAt: row.created_at,
        text: row.text,
        logs: logs.map((l) => ({
          filename: l.filename,
          source: l.source,
          byteSize: l.byte_size,
          sha256: l.sha256,
        })),
      });

      if (!gateUpdate(row.id, "标记 archiving", { status: "archiving", archive_stage: "task_pending" })) return;
      try {
        const ref = await kaneo.createTask({
          projectId: authorizedProjectId,
          columnSlug: authorizedColumnSlug,
          title: processed.title,
          description,
          // 未选负责人时**省略 userId**（不是传 null），保持 Kaneo 的“无负责人”默认。
          ...(authorizedAssigneeId ? { userId: authorizedAssigneeId } : {}),
        });
        taskId = ref.taskId;
        taskUrl = ref.taskUrl;
        if (
          !gateUpdate(row.id, "记录任务 ID", {
            kaneo_task_id: taskId,
            kaneo_task_url: taskUrl,
            archive_stage: "task_created",
          })
        ) {
          return;
        }
      } catch (err) {
        if (err instanceof KaneoColumnNotFound) {
          updateFeedback(db, row.id, {
            status: "failed",
            error_summary: "Kaneo 目标列已失效，停止归档。请在管理页修复列配置后重试。",
          });
          return;
        }
        if (err instanceof KaneoUncertainError) {
          // 写入结果不确定：先按反馈 ID 核对是否其实已创建
          try {
            const found = await kaneo.findByFeedbackId(authorizedProjectId, row.id);
            if (found) {
              taskId = found.taskId;
              taskUrl = found.taskUrl;
              if (
                !gateUpdate(row.id, "记录核对到的任务 ID", {
                  kaneo_task_id: taskId,
                  kaneo_task_url: taskUrl,
                  archive_stage: "task_created",
                })
              ) {
                return;
              }
            } else {
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: "Kaneo 写入结果不确定，已进入待核对队列。",
                last_error: String(err.message).slice(0, 1000),
              });
              return;
            }
          } catch {
            updateFeedback(db, row.id, {
              status: "needs_review",
              error_summary: "Kaneo 写入结果不确定，已进入待核对队列。",
              last_error: String(err.message).slice(0, 1000),
            });
            return;
          }
        } else {
          const msg = err instanceof KaneoDefiniteError ? err.message : `Kaneo 错误: ${(err as Error).message}`;
          updateFeedback(db, row.id, {
            status: "failed",
            error_summary: msg.slice(0, 300),
            last_error: msg.slice(0, 1000),
          });
          return;
        }
      }
    }

    // ---- 阶段 1.5：标签关联（T3，仅工作区级标签；按 (taskId,name) 幂等） ----
    // 只有工作区级标签（taskId === null）允许选择，避免把其他任务上的标签“搬走”。
    if ((target.labelIds ?? []).length > 0) {
      if (!target.workspaceId) {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "缺少工作区标识，无法核对标签归属，已停止处理，待核对",
        });
        return;
      }
      let workspaceLabels: KaneoLabel[];
      try {
        workspaceLabels = await kaneo.listWorkspaceLabels(target.workspaceId);
      } catch (err) {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "读取工作区标签失败（结果不确定），已停止处理，待核对",
          last_error: `listWorkspaceLabels: ${(err as Error).message}`.slice(0, 1000),
        });
        return;
      }
      const workspaceLevel = new Map(workspaceLabels.filter((l) => l.taskId === null).map((l) => [l.id, l] as const));
      for (const labelId of target.labelIds ?? []) {
        if (cur!.labels?.[labelId]?.outcome === "confirmed") continue;
        const label = workspaceLevel.get(labelId);
        if (!label) {
          // 标签已不再是本工作区的工作区级标签（被删除 / 变成任务标签）：确定失败，绝不关联他任务标签。
          updateFeedback(db, row.id, {
            status: "failed",
            error_summary: `工作区标签已不存在或不再可用（${labelId}），请重新选择标签后重试`,
            last_error: `label ${labelId} 不在工作区级标签列表中`,
          });
          return;
        }
        // 写入前先落盘 maybe_sent：确保“已发出”有据可查，任何中断都不会被当成“从未发送”。
        const pending: ArchiveLabelRecord = { id: labelId, name: label.name, outcome: "maybe_sent" };
        if (!persistArchive({ ...cur!, labels: { ...(cur!.labels ?? {}), [labelId]: pending } }, "标记标签关联"))
          return;
        try {
          await kaneo.attachLabelToTask(labelId, taskId!);
        } catch (err) {
          if (err instanceof KaneoDefiniteError) {
            updateFeedback(db, row.id, {
              status: "failed",
              error_summary: `关联标签失败：${err.message.slice(0, 250)}`,
              last_error: `attachLabel(${labelId}): ${err.message}`.slice(0, 1000),
            });
            return;
          }
          // 结果不确定：标签关联对 (taskId, name) 幂等，重试安全；绝不猜测，转入待核对。
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: "标签关联结果不确定，已进入待核对队列（重试安全，不会产生重复标签）",
            last_error: String((err as Error).message).slice(0, 1000),
          });
          return;
        }
        // 写入后读回核对（Kaneo 会为任务级标签生成新的 ID，以名称匹配）
        let confirmed: KaneoLabel | undefined;
        try {
          const taskLabels = await kaneo.listTaskLabels(taskId!);
          confirmed = taskLabels.find((l) => l.name === label.name) ?? taskLabels.find((l) => l.id === labelId);
        } catch {
          /* 读回失败保持 maybe_sent，由待核对入口处理 */
        }
        if (!confirmed) {
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: "标签已关联但读回核对未命中，已进入待核对队列",
            last_error: `label ${label.name} 未在任务标签列表中读回`,
          });
          return;
        }
        const record: ArchiveLabelRecord = {
          id: labelId,
          name: label.name,
          outcome: "confirmed",
          taskLabelId: confirmed.id,
        };
        if (!persistArchive({ ...cur!, labels: { ...(cur!.labels ?? {}), [labelId]: record } }, "确认标签关联")) return;
      }
    }

    // 检查是否有附件（截图或日志）需要归档（已在阶段前置检查中读取）
    const logs = getFeedbackLogs(db, row.id);
    if (!screenshot && logs.length === 0) {
      // 纯文字反馈：任务 + 标签全部确认后才代表归档完成
      if (!isFullyArchived(cur, false, [], target.labelIds ?? [])) {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "任务已创建但标签尚未全部确认，待核对",
          kaneo_task_id: taskId,
          kaneo_task_url: taskUrl,
        });
        return;
      }
      updateFeedback(db, row.id, {
        status: "archived",
        archive_stage: "complete",
        kaneo_task_id: taskId,
        kaneo_task_url: taskUrl,
        error_summary: null,
        last_error: null,
      });
      return;
    }

    // 阶段 2~5：附件归档（图片/日志上传与评论挂载）
    try {
      // 先核对该任务下已有的评论（幂等）
      const existingComments = await kaneo.listComments(taskId);

      // 1. 截图归档
      if (screenshot) {
        let screenshotAtt: ArchiveAttachmentRecord = cur.attachments?.screenshot ?? {
          id: "screenshot",
          kind: "screenshot",
          filename: "screenshot.png",
          byteSize: screenshot.byte_size,
          sha256: screenshot.sha256,
        };
        const currentAssetUrl: string | null = screenshotAtt.asset?.url ?? cur.asset?.url ?? null;
        const commentMatches = (c: { content: string }, assetRef?: string | null): boolean =>
          c.content.includes(row.id) &&
          c.content.includes(screenshot.sha256) &&
          (assetRef ? c.content.includes(assetRef) : true);
        const matchedComment = existingComments.find((c) => commentMatches(c, currentAssetUrl));
        if (matchedComment) {
          try {
            const commentRecord = {
              marker: commentMarker(row.id, screenshot.sha256),
              id: matchedComment.id,
              outcome: "confirmed" as const,
            };
            screenshotAtt = {
              ...screenshotAtt,
              id: "screenshot",
              kind: "screenshot",
              filename: "screenshot.png",
              byteSize: screenshot.byte_size,
              sha256: screenshot.sha256,
              comment: commentRecord,
            };
            persistArchive(
              {
                ...cur,
                attachments: { ...cur.attachments, screenshot: screenshotAtt },
                comment: commentRecord,
              },
              "补记已有截图评论",
            );
          } catch {
            /* 补记失败不影响既有归档事实 */
          }
        } else if (screenshotAtt?.comment?.outcome !== "confirmed" && cur.comment?.outcome !== "confirmed") {
          let assetUrl: string;
          if (screenshotAtt?.asset?.url ?? cur.asset?.url) {
            assetUrl = (screenshotAtt?.asset?.url ?? cur.asset?.url)!;
          } else {
            if (!gateUpdate(row.id, "标记 asset_uploading", { archive_stage: "asset_uploading" })) return;

            let uploadRecord = screenshotAtt?.upload ?? cur.upload;
            let uploadUrl = "";
            let uploadHeaders: Record<string, string> = {};
            let sameKeyRecovery = false;

            if (uploadRecord && uploadRecord.outcome === "confirmed") {
              const asset = await kaneo.finalizeImageUpload(taskId, {
                key: uploadRecord.key,
                filename: "screenshot.png",
                contentType: "image/png",
                size: screenshot.byte_size,
                surface: "comment",
              });
              const downloaded = await kaneo.downloadAsset(asset.url);
              const dlSha = createHash("sha256").update(Buffer.from(downloaded)).digest("hex");
              if (dlSha !== screenshot.sha256) {
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: "截图远端资产字节校验失败（SHA-256 不一致），已停止处理，待核对",
                  last_error: `sha mismatch: expected ${screenshot.sha256} got ${dlSha}`,
                });
                return;
              }
              assetUrl = asset.url;
              if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
              screenshotAtt = {
                ...screenshotAtt,
                id: "screenshot",
                kind: "screenshot",
                filename: "screenshot.png",
                byteSize: screenshot.byte_size,
                sha256: screenshot.sha256,
                asset: { id: asset.id, url: asset.url },
              };
              if (
                !persistArchive(
                  {
                    ...cur,
                    attachments: { ...cur.attachments, screenshot: screenshotAtt },
                    asset: { id: asset.id, url: asset.url },
                  },
                  "保存资产信息",
                )
              )
                return;
            } else {
              if (uploadRecord) {
                if ((uploadRecord.recoveries ?? 0) >= MAX_SAME_KEY_RECOVERIES) {
                  updateFeedback(db, row.id, {
                    status: "needs_review",
                    error_summary: "同 key 恢复次数已达上限（3 次），待人工核对远端对象",
                    last_error: `upload.key=${uploadRecord.key.slice(0, 80)} outcome=${uploadRecord.outcome}`,
                  });
                  return;
                }
                let creds: UploadCredentials;
                try {
                  creds = decryptUploadCredentials(deps.masterKey, uploadRecord.credentialsEnc);
                } catch (err) {
                  updateFeedback(db, row.id, {
                    status: "needs_review",
                    error_summary: "预签名凭证无法解密，无法同 key 恢复，待人工核对",
                    last_error: (err as Error).message.slice(0, 300),
                  });
                  return;
                }
                if (uploadRecord.expiresAt !== null && Date.parse(uploadRecord.expiresAt) <= Date.now()) {
                  updateFeedback(db, row.id, {
                    status: "needs_review",
                    error_summary:
                      "上传地址已过期，已停止同 key 恢复；请在管理页用“替换图片”重新上传（不自动申请新地址）",
                    last_error: `upload.key=${uploadRecord.key.slice(0, 80)} expiresAt=${uploadRecord.expiresAt} outcome=${uploadRecord.outcome}`,
                  });
                  return;
                }
                uploadUrl = creds.uploadUrl;
                uploadHeaders = creds.headers;
                sameKeyRecovery = true;
              } else {
                const presigned = await kaneo.createImageUpload(taskId, {
                  filename: "screenshot.png",
                  contentType: "image/png",
                  size: screenshot.byte_size,
                  surface: "comment",
                });
                uploadRecord = buildUploadRecord(deps.masterKey, presigned, "not_sent");
                uploadUrl = presigned.uploadUrl;
                uploadHeaders = presigned.headers;
                screenshotAtt = {
                  ...screenshotAtt,
                  id: "screenshot",
                  kind: "screenshot",
                  filename: "screenshot.png",
                  byteSize: screenshot.byte_size,
                  sha256: screenshot.sha256,
                  upload: uploadRecord,
                };
                if (
                  !persistArchive(
                    {
                      ...cur,
                      attachments: { ...cur.attachments, screenshot: screenshotAtt },
                      upload: uploadRecord,
                    },
                    "保存预签名上传凭证",
                  )
                )
                  return;
              }

              if (sameKeyRecovery) {
                const bumped: ArchiveUpload = { ...uploadRecord, recoveries: (uploadRecord.recoveries ?? 0) + 1 };
                screenshotAtt = { ...screenshotAtt, upload: bumped };
                if (
                  !persistArchive(
                    {
                      ...cur,
                      attachments: { ...cur.attachments, screenshot: screenshotAtt },
                      upload: bumped,
                    },
                    "登记同 key 重传意图",
                  )
                )
                  return;
                uploadRecord = bumped;
              }

              screenshotAtt = { ...screenshotAtt, upload: { ...uploadRecord, outcome: "maybe_sent" } };
              if (
                !persistArchive(
                  {
                    ...cur,
                    attachments: { ...cur.attachments, screenshot: screenshotAtt },
                    upload: { ...uploadRecord, outcome: "maybe_sent" },
                  },
                  "登记上传已发出（结果未知）",
                )
              )
                return;

              try {
                await kaneo.uploadImageToPresigned(uploadUrl, uploadHeaders, Buffer.from(screenshot.png_blob));
              } catch (err) {
                if (err instanceof KaneoUncertainError) throw err;
                if (!uploadRecord.recoveries || uploadRecord.recoveries <= 0) throw err;
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: "同 key 重传被拒绝，已停止处理；请在管理页用“替换图片”重新上传（不自动申请新地址）",
                  last_error:
                    `同 key 重传被拒绝（key=${uploadRecord.key.slice(0, 60)}）：${(err as Error).message.slice(0, 200)}`.slice(
                      0,
                      1000,
                    ),
                });
                return;
              }

              screenshotAtt = { ...screenshotAtt, upload: { ...uploadRecord, outcome: "confirmed" } };
              if (
                !persistArchive(
                  {
                    ...cur,
                    attachments: { ...cur.attachments, screenshot: screenshotAtt },
                    upload: { ...uploadRecord, outcome: "confirmed" },
                  },
                  "登记上传成功",
                )
              )
                return;

              const asset = await kaneo.finalizeImageUpload(taskId, {
                key: uploadRecord.key,
                filename: "screenshot.png",
                contentType: "image/png",
                size: screenshot.byte_size,
                surface: "comment",
              });

              const downloaded = await kaneo.downloadAsset(asset.url);
              const dlSha = createHash("sha256").update(Buffer.from(downloaded)).digest("hex");
              if (dlSha !== screenshot.sha256) {
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: "截图远端资产字节校验失败（SHA-256 不一致），已停止处理，待核对",
                  last_error: `sha mismatch: expected ${screenshot.sha256} got ${dlSha}`,
                });
                return;
              }

              assetUrl = asset.url;
              if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
              screenshotAtt = {
                ...screenshotAtt,
                id: "screenshot",
                kind: "screenshot",
                filename: "screenshot.png",
                byteSize: screenshot.byte_size,
                sha256: screenshot.sha256,
                asset: { id: asset.id, url: asset.url },
              };
              if (
                !persistArchive(
                  {
                    ...cur,
                    attachments: { ...cur.attachments, screenshot: screenshotAtt },
                    asset: { id: asset.id, url: asset.url },
                  },
                  "保存资产信息",
                )
              )
                return;
            }
          }

          if (!gateUpdate(row.id, "标记 comment_pending", { archive_stage: "comment_pending" })) return;
          const marker = commentMarker(row.id, screenshot.sha256);
          const commentContent = buildScreenshotComment({
            feedbackId: row.id,
            assetUrl,
            sha256: screenshot.sha256,
            width: screenshot.width,
            height: screenshot.height,
            logs: logs.map((l) => ({
              filename: l.filename,
              source: l.source,
              byteSize: l.byte_size,
              sha256: l.sha256,
            })),
          });

          const priorCommentOutcome = screenshotAtt?.comment?.outcome ?? cur.comment?.outcome ?? null;
          if (priorCommentOutcome === "maybe_sent" || priorCommentOutcome === "confirmed") {
            updateFeedback(db, row.id, {
              status: "needs_review",
              error_summary:
                priorCommentOutcome === "maybe_sent"
                  ? "截图评论写入结果未知且核对未命中，已停止自动处理；请在管理页重试评论或人工核对"
                  : "恢复数据记录评论已确认但核对未命中，已停止处理，待人工核对",
              last_error: `auto: comment.outcome=${priorCommentOutcome}，自动路径不重发评论`,
            });
            return;
          }

          screenshotAtt = { ...screenshotAtt, comment: { marker, id: null, outcome: "maybe_sent" } };
          if (
            !persistArchive(
              {
                ...cur,
                attachments: { ...cur.attachments, screenshot: screenshotAtt },
                comment: { marker, id: null, outcome: "maybe_sent" },
              },
              "登记评论已发出（结果未知）",
            )
          )
            return;

          let created: { id: string };
          try {
            created = await kaneo.createComment(taskId, { content: commentContent });
          } catch (err) {
            if (err instanceof KaneoDefiniteError) {
              screenshotAtt = { ...screenshotAtt, comment: { marker, id: null, outcome: "not_sent" } };
              persistArchive(
                {
                  ...cur,
                  attachments: { ...cur.attachments, screenshot: screenshotAtt },
                  comment: { marker, id: null, outcome: "not_sent" },
                },
                "登记评论被拒绝（未创建）",
              );
            }
            throw err;
          }

          const verifiedComments = await kaneo.listComments(taskId);
          const isConfirmed = verifiedComments.some((c) => commentMatches(c, assetUrl));
          if (!isConfirmed) {
            screenshotAtt = { ...screenshotAtt, comment: { marker, id: created.id || null, outcome: "maybe_sent" } };
            try {
              persistArchive(
                {
                  ...cur,
                  attachments: { ...cur.attachments, screenshot: screenshotAtt },
                  comment: { marker, id: created.id || null, outcome: "maybe_sent" },
                },
                "登记评论待核对",
              );
            } catch {}
            updateFeedback(db, row.id, {
              status: "needs_review",
              error_summary: "截图评论已提交但核对未发现，待人工核对",
            });
            return;
          }

          screenshotAtt = { ...screenshotAtt, comment: { marker, id: created.id || null, outcome: "confirmed" } };
          try {
            persistArchive(
              {
                ...cur,
                attachments: { ...cur.attachments, screenshot: screenshotAtt },
                comment: { marker, id: created.id || null, outcome: "confirmed" },
              },
              "登记评论成功",
            );
          } catch {}
        }
      }

      // 2. 日志附件归档
      for (const log of logs) {
        let logAtt: ArchiveAttachmentRecord = cur.attachments?.[log.id] ?? {
          id: log.id,
          kind: "log",
          filename: log.filename,
          byteSize: log.byte_size,
          sha256: log.sha256,
        };
        if (logAtt.comment?.outcome === "confirmed") {
          continue;
        }

        const logMarker = logCommentMarker(row.id, log.id, log.sha256);
        const currentLogAssetUrl = logAtt.asset?.url ?? null;
        const logCommentMatches = (c: { content: string }, assetRef?: string | null): boolean =>
          c.content.includes(row.id) &&
          c.content.includes(log.id) &&
          c.content.includes(log.sha256) &&
          (assetRef ? c.content.includes(assetRef) : true);

        const matchedLogComment = existingComments.find((c) => logCommentMatches(c, currentLogAssetUrl));
        if (matchedLogComment) {
          logAtt = {
            ...logAtt,
            id: log.id,
            kind: "log",
            filename: log.filename,
            byteSize: log.byte_size,
            sha256: log.sha256,
            comment: { marker: logMarker, id: matchedLogComment.id, outcome: "confirmed" },
          };
          try {
            persistArchive(
              { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
              `补记已有日志 ${log.filename} 评论`,
            );
          } catch {}
          continue;
        }

        let logAssetUrl: string;
        if (logAtt?.asset?.url) {
          logAssetUrl = logAtt.asset.url;
        } else {
          if (!gateUpdate(row.id, "标记 asset_uploading", { archive_stage: "asset_uploading" })) return;

          let uploadRecord = logAtt?.upload;
          let uploadUrl = "";
          let uploadHeaders: Record<string, string> = {};
          let sameKeyRecovery = false;

          if (uploadRecord && uploadRecord.outcome === "confirmed") {
            const asset = await kaneo.finalizeImageUpload(taskId, {
              key: uploadRecord.key,
              filename: log.filename,
              contentType: getLogContentType(log.filename),
              size: log.byte_size,
              surface: "comment",
            });
            const downloaded = await kaneo.downloadAsset(asset.url);
            const dlSha = createHash("sha256").update(Buffer.from(downloaded)).digest("hex");
            if (dlSha !== log.sha256) {
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: `日志 ${log.filename} 远端资产字节校验失败（SHA-256 不一致），待核对`,
                last_error: `log sha mismatch: expected ${log.sha256} got ${dlSha}`,
              });
              return;
            }
            logAssetUrl = asset.url;
            if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
            logAtt = {
              ...logAtt,
              id: log.id,
              kind: "log",
              filename: log.filename,
              byteSize: log.byte_size,
              sha256: log.sha256,
              asset: { id: asset.id, url: asset.url },
            };
            if (
              !persistArchive(
                { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                `保存日志 ${log.filename} 资产信息`,
              )
            )
              return;
          } else {
            if (uploadRecord) {
              if ((uploadRecord.recoveries ?? 0) >= MAX_SAME_KEY_RECOVERIES) {
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: `日志 ${log.filename} 同 key 恢复次数已达上限（3 次），待人工核对`,
                  last_error: `upload.key=${uploadRecord.key.slice(0, 80)} outcome=${uploadRecord.outcome}`,
                });
                return;
              }
              let creds: UploadCredentials;
              try {
                creds = decryptUploadCredentials(deps.masterKey, uploadRecord.credentialsEnc);
              } catch (err) {
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: `日志 ${log.filename} 预签名凭证无法解密，待人工核对`,
                  last_error: (err as Error).message.slice(0, 300),
                });
                return;
              }
              if (uploadRecord.expiresAt !== null && Date.parse(uploadRecord.expiresAt) <= Date.now()) {
                updateFeedback(db, row.id, {
                  status: "needs_review",
                  error_summary: `日志 ${log.filename} 上传地址已过期，已停止同 key 恢复；请在管理页重试`,
                  last_error: `upload.key=${uploadRecord.key.slice(0, 80)} expiresAt=${uploadRecord.expiresAt}`,
                });
                return;
              }
              uploadUrl = creds.uploadUrl;
              uploadHeaders = creds.headers;
              sameKeyRecovery = true;
            } else {
              const presigned = await kaneo.createImageUpload(taskId, {
                filename: log.filename,
                contentType: getLogContentType(log.filename),
                size: log.byte_size,
                surface: "comment",
              });
              uploadRecord = buildUploadRecord(deps.masterKey, presigned, "not_sent");
              uploadUrl = presigned.uploadUrl;
              uploadHeaders = presigned.headers;
              logAtt = {
                ...logAtt,
                id: log.id,
                kind: "log",
                filename: log.filename,
                byteSize: log.byte_size,
                sha256: log.sha256,
                upload: uploadRecord,
              };
              if (
                !persistArchive(
                  { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                  `保存日志 ${log.filename} 预签名凭证`,
                )
              )
                return;
            }

            if (sameKeyRecovery) {
              const bumped = { ...uploadRecord, recoveries: (uploadRecord.recoveries ?? 0) + 1 };
              logAtt = { ...logAtt, upload: bumped };
              if (
                !persistArchive(
                  { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                  `登记日志 ${log.filename} 同 key 重传意图`,
                )
              )
                return;
              uploadRecord = bumped;
            }

            logAtt = { ...logAtt, upload: { ...uploadRecord, outcome: "maybe_sent" } };
            if (
              !persistArchive(
                { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                `登记日志 ${log.filename} 上传已发出（结果未知）`,
              )
            )
              return;

            try {
              await kaneo.uploadImageToPresigned(uploadUrl, uploadHeaders, Buffer.from(log.bytes));
            } catch (err) {
              if (err instanceof KaneoUncertainError) throw err;
              if (!uploadRecord.recoveries || uploadRecord.recoveries <= 0) throw err;
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: `日志 ${log.filename} 同 key 重传被拒绝，待人工核对`,
                last_error:
                  `同 key 重传被拒绝（key=${uploadRecord.key.slice(0, 60)}）：${(err as Error).message.slice(0, 200)}`.slice(
                    0,
                    1000,
                  ),
              });
              return;
            }

            logAtt = { ...logAtt, upload: { ...uploadRecord, outcome: "confirmed" } };
            if (
              !persistArchive(
                { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                `登记日志 ${log.filename} 上传成功`,
              )
            )
              return;

            const asset = await kaneo.finalizeImageUpload(taskId, {
              key: uploadRecord.key,
              filename: log.filename,
              contentType: getLogContentType(log.filename),
              size: log.byte_size,
              surface: "comment",
            });

            const downloaded = await kaneo.downloadAsset(asset.url);
            const dlSha = createHash("sha256").update(Buffer.from(downloaded)).digest("hex");
            if (dlSha !== log.sha256) {
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: `日志 ${log.filename} 远端资产字节校验失败（SHA-256 不一致），待核对`,
                last_error: `log sha mismatch: expected ${log.sha256} got ${dlSha}`,
              });
              return;
            }

            logAssetUrl = asset.url;
            if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
            logAtt = {
              ...logAtt,
              id: log.id,
              kind: "log",
              filename: log.filename,
              byteSize: log.byte_size,
              sha256: log.sha256,
              asset: { id: asset.id, url: asset.url },
            };
            if (
              !persistArchive(
                { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
                `保存日志 ${log.filename} 资产信息`,
              )
            )
              return;
          }
        }

        if (!gateUpdate(row.id, "标记 comment_pending", { archive_stage: "comment_pending" })) return;
        const logCommentContent = buildLogComment({
          feedbackId: row.id,
          logId: log.id,
          filename: log.filename,
          assetUrl: logAssetUrl,
          sha256: log.sha256,
          byteSize: log.byte_size,
          source: log.source,
        });

        const priorLogCommentOutcome = logAtt?.comment?.outcome ?? null;
        if (priorLogCommentOutcome === "maybe_sent" || priorLogCommentOutcome === "confirmed") {
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: `日志 ${log.filename} 评论写入结果未知且核对未命中，已停止自动处理，待人工核对`,
            last_error: `auto: log ${log.id} comment.outcome=${priorLogCommentOutcome}`,
          });
          return;
        }

        logAtt = { ...logAtt, comment: { marker: logMarker, id: null, outcome: "maybe_sent" } };
        if (
          !persistArchive(
            { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 评论已发出（结果未知）`,
          )
        )
          return;

        let createdLogComment: { id: string };
        try {
          createdLogComment = await kaneo.createComment(taskId, { content: logCommentContent });
        } catch (err) {
          if (err instanceof KaneoDefiniteError) {
            logAtt = { ...logAtt, comment: { marker: logMarker, id: null, outcome: "not_sent" } };
            persistArchive(
              { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
              `登记日志 ${log.filename} 评论被拒绝`,
            );
          }
          throw err;
        }

        const verifiedLogComments = await kaneo.listComments(taskId);
        const isLogCommentConfirmed = verifiedLogComments.some((c) => logCommentMatches(c, logAssetUrl));
        if (!isLogCommentConfirmed) {
          logAtt = {
            ...logAtt,
            comment: { marker: logMarker, id: createdLogComment.id || null, outcome: "maybe_sent" },
          };
          try {
            persistArchive(
              { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
              `登记日志 ${log.filename} 评论待核对`,
            );
          } catch {}
          updateFeedback(db, row.id, {
            status: "needs_review",
            error_summary: `日志 ${log.filename} 评论已提交但核对未发现，待人工核对`,
          });
          return;
        }

        logAtt = { ...logAtt, comment: { marker: logMarker, id: createdLogComment.id || null, outcome: "confirmed" } };
        try {
          persistArchive(
            { ...cur, attachments: { ...cur.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 评论成功`,
          );
        } catch {}
      }

      // 3. 所有附件（截图若存在 + 全部日志）与全部标签都确认后，才标记归档完成
      if (isFullyArchived(cur, Boolean(screenshot), logs, target.labelIds ?? [])) {
        updateFeedback(db, row.id, {
          status: "archived",
          archive_stage: "complete",
          kaneo_task_id: taskId,
          kaneo_task_url: taskUrl,
          error_summary: null,
          last_error: null,
        });
      }
    } catch (err) {
      if (err instanceof KaneoUncertainError) {
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "Kaneo 附件或评论写入结果不确定，待核对",
          last_error: String(err.message).slice(0, 1000),
        });
      } else {
        const msg = err instanceof KaneoDefiniteError ? err.message : `Kaneo 附件阶段错误: ${(err as Error).message}`;
        updateFeedback(db, row.id, {
          status: "failed",
          error_summary: msg.slice(0, 300),
          last_error: msg.slice(0, 1000),
        });
      }
    }
  }

  /**
   * 管理页人工重试：
   * - `failed` → 从持久化断点继续（不清 task/key/asset）；
   * - `needs_info` 且尚无 AI 整理结果（AI 失败已回退原文）→ 重新尝试 AI 整理。
   *   重试绝不发起未经人工授权的远端归档。
   */
  function retry(feedbackId: string, expectedRevision?: number): WorkerOpResult {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    let result: WorkerOpResult;
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      const aiFallbackRetry = row.status === "needs_info" && !row.processed_json;
      if (row.status !== "failed" && !aiFallbackRetry) {
        return { ok: false, reason: "invalid_state", status: row.status };
      }
      clearResumePause(feedbackId, row);
      const next = row.processed_json ? "archiving" : "processing";
      if (!gateUpdate(feedbackId, "人工重试", { status: "processing", error_summary: null })) {
        return { ok: false, reason: "persist_failed" };
      }
      result = { ok: true, status: next, revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
    enqueue(feedbackId); // release 后入队，避免与队列处理争锁
    return result;
  }

  /**
   * needs_review + recheck（4.4）：
   * - 先固定一份 Kaneo 配置并确认已保存目标未改变（不一致 → 零远端写入 + target_changed）；
   * - 优先已有 task ID（不重置阶段、不重复搜索）；无 task ID 才按标记搜索；
   * - 核对命中评论 → 补记确认并归档；
   * - **评论写入结果未知且核对未命中 → 绝不自动重发**，维持待核对（只有显式 retry_comment 才发送）；
   * - 评论匹配含当前资产引用；列表读取失败会抛错（路由映射 502），绝不当“没有评论”。
   */
  async function recheck(feedbackId: string, expectedRevision?: number): Promise<WorkerOpResult> {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    let result: WorkerOpResult;
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      const app = appOf(row);
      if (!app) return { ok: false, reason: "invalid_state", status: row.status };
      clearResumePause(feedbackId, row);

      const parsed = loadArchiveData(deps.db, feedbackId);
      const saved = parsed.kind === "valid" ? parsed.data : null;

      // P1：固定配置 + 统一目标校验（不一致时零远端写入）
      const prep = await prepareRecovery(row, saved);
      if (!prep.ok) return prep.result;
      const client = prep.client;

      // 1. 优先已有 task ID（不重置阶段）；没有才按标记搜索
      let taskId = row.kaneo_task_id;
      let taskUrl = row.kaneo_task_url;
      if (!taskId) {
        const searchProjectId = saved?.target.projectId ?? app.kaneo_project_id!;
        const ref = await client.findByFeedbackId(searchProjectId, row.id);
        if (!ref) {
          return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
        }
        taskId = ref.taskId;
        taskUrl = ref.taskUrl;
        // 不重置阶段：仅当原本处于最初段时推进到 task_created
        const stage = row.archive_stage && row.archive_stage !== "task_pending" ? row.archive_stage : "task_created";
        if (
          !gateUpdate(feedbackId, "记录核对到的任务 ID", {
            kaneo_task_id: taskId,
            kaneo_task_url: taskUrl,
            archive_stage: stage,
          })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
      }

      // 2. 检查是否有截图与日志
      const screenshot = getFeedbackScreenshot(deps.db, feedbackId);
      const logs = getFeedbackLogs(deps.db, feedbackId);
      if (!screenshot && logs.length === 0) {
        // 纯文字反馈，确认有 task 即归档完成
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }

      // 3. 附件反馈：核对评论是否存在（含资产引用；读取失败会抛错，绝不当“没有评论”）
      const comments = await client.listComments(taskId);
      const base = loadArchiveData(deps.db, feedbackId);
      let curV3 = base.kind === "valid" ? normalizeToV3(base.data) : null;
      if (!curV3) {
        return { ok: false, reason: "invalid_state" };
      }

      let screenshotConfirmed = false;
      let hasUnconfirmedMaybeOrConfirmed = false;

      if (screenshot) {
        const assetRef = curV3.attachments?.screenshot?.asset?.url ?? curV3.asset?.url ?? null;
        const matched = comments.find(
          (c) =>
            c.content.includes(row.id) &&
            c.content.includes(screenshot.sha256) &&
            (assetRef ? c.content.includes(assetRef) : true),
        );
        if (matched) {
          screenshotConfirmed = true;
          const commentRecord = {
            marker: commentMarker(feedbackId, screenshot.sha256),
            id: matched.id,
            outcome: "confirmed" as const,
          };
          const screenshotAtt = {
            ...(curV3.attachments?.screenshot ?? {}),
            id: "screenshot",
            kind: "screenshot" as const,
            filename: "screenshot.png",
            byteSize: screenshot.byte_size,
            sha256: screenshot.sha256,
            comment: commentRecord,
          };
          curV3 = {
            ...curV3,
            attachments: { ...curV3.attachments, screenshot: screenshotAtt },
            comment: commentRecord,
          };
        } else {
          const sOutcome = curV3.attachments?.screenshot?.comment?.outcome ?? curV3.comment?.outcome;
          if (sOutcome === "maybe_sent" || sOutcome === "confirmed") {
            hasUnconfirmedMaybeOrConfirmed = true;
          }
        }
      }

      let allLogsConfirmed = true;
      for (const log of logs) {
        const logAssetRef = curV3.attachments?.[log.id]?.asset?.url ?? null;
        const matchedLog = comments.find(
          (c) =>
            c.content.includes(row.id) &&
            c.content.includes(log.id) &&
            c.content.includes(log.sha256) &&
            (logAssetRef ? c.content.includes(logAssetRef) : true),
        );
        if (matchedLog) {
          const logCommentRecord = {
            marker: logCommentMarker(feedbackId, log.id, log.sha256),
            id: matchedLog.id,
            outcome: "confirmed" as const,
          };
          const logAtt: ArchiveAttachmentRecord = {
            ...(curV3.attachments?.[log.id] ?? {}),
            id: log.id,
            kind: "log" as const,
            filename: log.filename,
            byteSize: log.byte_size,
            sha256: log.sha256,
            comment: logCommentRecord,
          };
          curV3 = {
            ...curV3,
            attachments: { ...curV3.attachments, [log.id]: logAtt },
          };
        } else {
          allLogsConfirmed = false;
          const lOutcome = curV3.attachments?.[log.id]?.comment?.outcome;
          if (lOutcome === "maybe_sent" || lOutcome === "confirmed") {
            hasUnconfirmedMaybeOrConfirmed = true;
          }
        }
      }

      try {
        saveRecoveryState(feedbackId, curV3, "核对附件评论确认状态");
      } catch {
        /* 尽力而为 */
      }

      // ---- T3 标签核对（只读）：按名称读回任务标签；读回失败绝不能当作“没有标签” ----
      const labelIds = curV3.target.labelIds ?? [];
      let allLabelsConfirmed = true;
      if (labelIds.length > 0) {
        let taskLabels: KaneoLabel[] | null = null;
        try {
          taskLabels = await client.listTaskLabels(taskId);
        } catch {
          taskLabels = null;
        }
        for (const labelId of labelIds) {
          const rec: ArchiveLabelRecord | undefined = curV3.labels?.[labelId];
          if (rec?.outcome === "confirmed") continue;
          const recName: string | undefined = rec?.name;
          const hit: KaneoLabel | undefined =
            taskLabels && recName ? taskLabels.find((l) => l.name === recName) : undefined;
          if (hit) {
            curV3 = {
              ...curV3,
              labels: {
                ...(curV3.labels ?? {}),
                [labelId]: {
                  id: labelId,
                  name: rec?.name ?? hit.name,
                  outcome: "confirmed",
                  taskLabelId: hit.id,
                },
              },
            };
          } else {
            allLabelsConfirmed = false;
            if (rec?.outcome === "maybe_sent") hasUnconfirmedMaybeOrConfirmed = true;
          }
        }
        try {
          saveRecoveryState(feedbackId, curV3, "核对标签确认状态");
        } catch {
          /* 尽力而为 */
        }
      }

      const allAttachmentsConfirmed = (!screenshot || screenshotConfirmed) && allLogsConfirmed;
      if (allAttachmentsConfirmed && allLabelsConfirmed) {
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }

      if (hasUnconfirmedMaybeOrConfirmed) {
        if (
          !gateUpdate(feedbackId, "核对未命中（不自动重发）", {
            error_summary: "附件评论写入结果未知且核对未命中，已停止自动处理；请在管理页重试或人工核对",
            last_error: "recheck: 附件评论核对未命中，自动路径不重发评论",
          })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
      }

      // 评论确认为“从未发送”：从断点继续处理，绝不立即标记已归档；阶段保持不回退
      if (
        !gateUpdate(feedbackId, "核对后续处理", {
          status: "processing",
          error_summary: null,
        })
      ) {
        return { ok: false, reason: "persist_failed" };
      }
      result = { ok: true, status: "processing", revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
    enqueue(feedbackId); // release 后入队
    return result;
  }

  /**
   * needs_review + force-create（4.4）：仅允许“任务创建结果未知且无任何已知 task/附件状态”的记录；
   * 已有 task ID 或已知上传/资产/评论状态一律拒绝（绝不重复创建、绝不丢弃恢复信息）。
   * P1：先统一校验已保存目标——目标改变时拒绝且不改动恢复数据。
   */
  async function forceCreate(feedbackId: string, expectedRevision?: number): Promise<WorkerOpResult> {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    let result: WorkerOpResult;
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      if (!row.processed_json) return { ok: false, reason: "invalid_state", status: row.status };
      clearResumePause(feedbackId, row);
      const parsed = loadArchiveData(deps.db, feedbackId);
      const data = parsed.kind === "valid" ? parsed.data : null;

      // P1：先固定配置并统一检查已保存目标——目标改变时不清空恢复数据、不发出任何远端操作
      const prep = await prepareRecovery(row, data);
      if (!prep.ok) return prep.result;

      if (row.kaneo_task_id) {
        return {
          ok: false,
          reason: "invalid_state",
          status: row.status,
          note: "已有已知 task ID，不允许 force-create",
        };
      }
      if (data && (data.upload || data.asset || data.comment)) {
        return {
          ok: false,
          reason: "invalid_state",
          status: row.status,
          note: "存在已知附件状态，不允许 force-create",
        };
      }
      // 保留已固定的恢复目标（同一目标的密钥轮换仍可继续），仅清空写入类状态
      if (data) {
        if (
          !saveRecoveryState(
            feedbackId,
            { target: data.target, ...(data.replacedKeys ? { replacedKeys: data.replacedKeys } : {}) },
            "force-create 清理写入状态",
          )
        ) {
          return { ok: false, reason: "persist_failed" };
        }
      }
      if (
        !gateUpdate(feedbackId, "强制重建", {
          status: "processing",
          kaneo_task_id: null,
          kaneo_task_url: null,
          archive_stage: "task_pending",
          error_summary: null,
        })
      ) {
        return { ok: false, reason: "persist_failed" };
      }
      result = { ok: true, status: "processing", revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
    enqueue(feedbackId); // release 后入队
    return result;
  }

  // ---------- 4.4 恢复接口：retry_comment / replace_upload ----------

  /**
   * recover: retry_comment——显式人工入口：执行前再次查重；未命中才允许一次发送。
   * 界面必须提示：即使先查重，仍可能存在重复评论风险。
   */
  async function recoverRetryComment(feedbackId: string, expectedRevision: number): Promise<WorkerOpResult> {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      clearResumePause(feedbackId, row);
      const parsed = loadArchiveData(deps.db, feedbackId);
      if (parsed.kind !== "valid") return { ok: false, reason: "invalid_state", status: row.status };
      const data = parsed.data;
      const assetUrl = data.asset?.url ?? null;
      const screenshot = getFeedbackScreenshot(deps.db, feedbackId);
      if (!row.kaneo_task_id || !assetUrl || !screenshot) {
        return { ok: false, reason: "invalid_state", status: row.status };
      }
      const taskId = row.kaneo_task_id;

      // P1：固定配置 + 统一目标校验（目标改变 → 零远端写入 + target_changed）
      const prep = await prepareRecovery(row, data);
      if (!prep.ok) return prep.result;
      const client = prep.client;

      // 再次查重（准确反馈 ID + 图片摘要 + 当前资产引用）；读取失败抛错 → 路由 502，绝不当没有评论
      const comments = await client.listComments(taskId);
      const matched = comments.find(
        (c) => c.content.includes(feedbackId) && c.content.includes(screenshot.sha256) && c.content.includes(assetUrl),
      );
      if (matched) {
        // 评论其实已挂载：补记确认并归档（无后续远端写入）
        const saved = saveRecoveryState(
          feedbackId,
          {
            ...data,
            comment: { marker: commentMarker(feedbackId, screenshot.sha256), id: matched.id, outcome: "confirmed" },
          },
          "补记评论确认",
        );
        if (!saved) return { ok: false, reason: "persist_failed" };
        const logs = getFeedbackLogs(deps.db, feedbackId);
        const freshV3 = normalizeToV3(saved);
        if (isFullyArchived(freshV3, true, logs)) {
          if (
            !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
          ) {
            return { ok: false, reason: "persist_failed" };
          }
          return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
        }
        return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
      }

      // 未命中 → 重发评论（发出前先落盘“结果未知”意图；持久化失败则绝不发出请求）
      if (!gateUpdate(feedbackId, "标记 comment_pending", { archive_stage: "comment_pending" })) {
        return { ok: false, reason: "persist_failed" };
      }
      const marker = commentMarker(feedbackId, screenshot.sha256);
      if (
        !saveRecoveryState(
          feedbackId,
          { ...data, comment: { marker, id: null, outcome: "maybe_sent" } },
          "登记评论已发出（结果未知）",
        )
      ) {
        return { ok: false, reason: "persist_failed" };
      }
      const logs = getFeedbackLogs(deps.db, feedbackId);
      const content = buildScreenshotComment({
        feedbackId,
        assetUrl,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
        logs: logs.map((l) => ({
          filename: l.filename,
          source: l.source,
          byteSize: l.byte_size,
          sha256: l.sha256,
        })),
      });
      let created: { id: string };
      try {
        created = await client.createComment(taskId, { content });
      } catch (err) {
        if (err instanceof KaneoDefiniteError) {
          // 明确被拒绝：评论未被创建 → 允许后续再次重试（记录为确定未发送）
          saveRecoveryState(
            feedbackId,
            { ...data, comment: { marker, id: null, outcome: "not_sent" } },
            "登记评论被拒绝（未创建）",
          );
        }
        throw err;
      }
      const verified = await client.listComments(taskId);
      const confirmed = verified.some(
        (c) => c.content.includes(feedbackId) && c.content.includes(screenshot.sha256) && c.content.includes(assetUrl),
      );
      const fresh = loadArchiveData(deps.db, feedbackId);
      if (fresh.kind !== "valid") return { ok: false, reason: "persist_failed" };
      if (!confirmed) {
        try {
          saveRecoveryState(
            feedbackId,
            { ...fresh.data, comment: { marker, id: created.id || null, outcome: "maybe_sent" } },
            "登记评论待核对",
          );
        } catch {
          /* 尽力而为 */
        }
        updateFeedback(deps.db, feedbackId, { error_summary: "retry_comment 重发后核对未发现，待人工核对" });
        return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
      }
      const freshV3Base = normalizeToV3(fresh.data);
      const confirmedComment = { marker, id: created.id || null, outcome: "confirmed" as const };
      const screenshotAtt = freshV3Base.attachments?.screenshot
        ? { ...freshV3Base.attachments.screenshot, comment: confirmedComment }
        : undefined;
      const confirmedData: ArchiveDataNext = {
        ...freshV3Base,
        comment: confirmedComment,
        ...(screenshotAtt ? { attachments: { ...freshV3Base.attachments, screenshot: screenshotAtt } } : {}),
      };
      let savedState: ArchiveData | null = null;
      try {
        savedState = saveRecoveryState(feedbackId, confirmedData, "登记评论成功");
      } catch {
        /* 尽力而为 */
      }
      const freshV3 = normalizeToV3(savedState ?? (confirmedData as ArchiveData));
      if (isFullyArchived(freshV3, true, logs)) {
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }
      return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
  }

  /**
   * recover: replace_upload——复用原 task；replace 前用 downloadAsset 做真实字节核对
   * （一致则不替换；404/失败不能证明文件不存在，按管理员决定继续替换）；
   * 保留旧 key 恢复记录（replacedKeys），不自动删远端对象。
   */
  async function recoverReplaceUpload(feedbackId: string, expectedRevision: number): Promise<WorkerOpResult> {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      clearResumePause(feedbackId, row);
      const parsed = loadArchiveData(deps.db, feedbackId);
      if (parsed.kind !== "valid") return { ok: false, reason: "invalid_state", status: row.status };
      let data = parsed.data;
      const screenshot = getFeedbackScreenshot(deps.db, feedbackId);
      if (!row.kaneo_task_id || !screenshot) {
        return { ok: false, reason: "invalid_state", status: row.status };
      }
      const taskId = row.kaneo_task_id;

      // P1：固定配置 + 统一目标校验（目标改变 → 零远端写入 + target_changed，恢复数据原样保留）
      const prep = await prepareRecovery(row, data);
      if (!prep.ok) return prep.result;
      const client = prep.client;

      // replace 前的真实字节核对（asset 已知时）：一致 → 无需替换
      const assetUrl = data.asset?.url ?? null;
      if (assetUrl) {
        try {
          const bytes = await client.downloadAsset(assetUrl);
          const sha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
          if (sha === screenshot.sha256) {
            return {
              ok: true,
              status: row.status,
              replaced: false,
              note: "远端资产字节核对一致，未执行替换",
              revision: currentRevision(feedbackId),
            };
          }
          try {
            updateFeedback(deps.db, feedbackId, {
              last_error: "replace 前核对：远端资产字节与本地截图不一致，按管理员决定继续替换".slice(0, 1000),
            });
          } catch {
            /* 尽力而为 */
          }
        } catch (err) {
          // 核对失败（404/网络）不能证明文件不存在 → 记录原因，按管理员决定继续替换
          try {
            updateFeedback(deps.db, feedbackId, {
              last_error:
                `replace 前核对未确认（不作为文件不存在的证明）：${(err as Error).message.slice(0, 200)}`.slice(
                  0,
                  1000,
                ),
            });
          } catch {
            /* 尽力而为 */
          }
        }
      }

      // 复用原 task，申请新地址（只分配地址）
      if (!gateUpdate(feedbackId, "标记 asset_uploading", { archive_stage: "asset_uploading" })) {
        return { ok: false, reason: "persist_failed" };
      }
      const presigned = await client.createImageUpload(taskId, {
        filename: "screenshot.png",
        contentType: "image/png",
        size: screenshot.byte_size,
        surface: "comment",
      });
      const newUpload = buildUploadRecord(deps.masterKey, presigned, "not_sent");
      // 保留旧 key 恢复记录；旧远端对象不自动删除
      const replacedKeys = [...(data.upload ? [data.upload.key] : []), ...(data.replacedKeys ?? [])].slice(0, 20);
      const savedUpload = saveRecoveryState(
        feedbackId,
        { ...data, upload: newUpload, replacedKeys },
        "保存替换用预签名凭证",
      );
      if (!savedUpload) return { ok: false, reason: "persist_failed" };
      data = savedUpload;

      // 发出前先落盘“结果未知”意图：持久化失败则绝不发送字节
      const pendingUpload = saveRecoveryState(
        feedbackId,
        { ...data, upload: { ...newUpload, outcome: "maybe_sent" } },
        "登记上传已发出（结果未知）",
      );
      if (!pendingUpload) return { ok: false, reason: "persist_failed" };
      data = pendingUpload;

      // 传字节（结果不确定 → 保持 maybe_sent 并按不确定上报）
      try {
        await client.uploadImageToPresigned(presigned.uploadUrl, presigned.headers, Buffer.from(screenshot.png_blob));
      } catch (err) {
        if (err instanceof KaneoUncertainError) {
          // 已在前置落盘登记为结果未知，无需重复写入；按不确定上报
        }
        throw err;
      }
      const confirmed = saveRecoveryState(
        feedbackId,
        { ...data, upload: { ...newUpload, outcome: "confirmed" } },
        "登记上传成功",
      );
      if (!confirmed) return { ok: false, reason: "persist_failed" };
      data = confirmed;

      // finalize 原 task + 新 key → 资产落盘 → 才发评论
      const asset = await client.finalizeImageUpload(taskId, {
        key: newUpload.key,
        filename: "screenshot.png",
        contentType: "image/png",
        size: screenshot.byte_size,
        surface: "comment",
      });
      if (!gateUpdate(feedbackId, "标记 asset_finalized", { archive_stage: "asset_finalized" })) {
        return { ok: false, reason: "persist_failed" };
      }
      const savedAsset = saveRecoveryState(
        feedbackId,
        { ...data, asset: { id: asset.id, url: asset.url } },
        "保存资产信息",
      );
      if (!savedAsset) return { ok: false, reason: "persist_failed" };
      data = savedAsset;

      // 旧评论（若有）引用旧资产；资产已换 → 发新评论
      if (!gateUpdate(feedbackId, "标记 comment_pending", { archive_stage: "comment_pending" })) {
        return { ok: false, reason: "persist_failed" };
      }
      const marker = commentMarker(feedbackId, screenshot.sha256);
      // 发出前先落盘“结果未知”意图：持久化失败则绝不发出评论请求
      const pendingComment = saveRecoveryState(
        feedbackId,
        { ...data, comment: { marker, id: null, outcome: "maybe_sent" } },
        "登记评论已发出（结果未知）",
      );
      if (!pendingComment) return { ok: false, reason: "persist_failed" };
      data = pendingComment;
      const logs = getFeedbackLogs(deps.db, feedbackId);
      const content = buildScreenshotComment({
        feedbackId,
        assetUrl: asset.url,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
        logs: logs.map((l) => ({
          filename: l.filename,
          source: l.source,
          byteSize: l.byte_size,
          sha256: l.sha256,
        })),
      });
      let created: { id: string };
      try {
        created = await client.createComment(taskId, { content });
      } catch (err) {
        if (err instanceof KaneoDefiniteError) {
          // 明确被拒绝：评论未被创建 → 记录为确定未发送，允许后续重试
          saveRecoveryState(
            feedbackId,
            { ...data, comment: { marker, id: null, outcome: "not_sent" } },
            "登记评论被拒绝（未创建）",
          );
        }
        throw err;
      }
      const verified = await client.listComments(taskId);
      const okComment = verified.some(
        (c) => c.content.includes(feedbackId) && c.content.includes(screenshot.sha256) && c.content.includes(asset.url),
      );
      const fresh = loadArchiveData(deps.db, feedbackId);
      if (fresh.kind !== "valid") return { ok: false, reason: "persist_failed" };
      if (!okComment) {
        try {
          saveRecoveryState(
            feedbackId,
            { ...fresh.data, comment: { marker, id: created.id || null, outcome: "maybe_sent" } },
            "登记评论待核对",
          );
        } catch {
          /* 尽力而为 */
        }
        updateFeedback(deps.db, feedbackId, { error_summary: "替换上传后评论核对未发现，待人工核对" });
        return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
      }
      const freshV3Base = normalizeToV3(fresh.data);
      const confirmedComment = { marker, id: created.id || null, outcome: "confirmed" as const };
      const screenshotAtt = freshV3Base.attachments?.screenshot
        ? { ...freshV3Base.attachments.screenshot, comment: confirmedComment }
        : undefined;
      const confirmedData: ArchiveDataNext = {
        ...freshV3Base,
        comment: confirmedComment,
        ...(screenshotAtt ? { attachments: { ...freshV3Base.attachments, screenshot: screenshotAtt } } : {}),
      };
      let savedState: ArchiveData | null = null;
      try {
        savedState = saveRecoveryState(feedbackId, confirmedData, "登记评论成功");
      } catch {
        /* 尽力而为 */
      }
      const freshV3 = normalizeToV3(savedState ?? (confirmedData as ArchiveData));
      if (isFullyArchived(freshV3, true, logs)) {
        if (
          !gateUpdate(feedbackId, "核对归档", {
            status: "archived",
            archive_stage: "complete",
            error_summary: null,
            last_error: null,
          })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", replaced: true, revision: currentRevision(feedbackId) };
      }
      return { ok: true, status: "needs_review", replaced: true, revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
  }

  /**
   * recover: retry_log——显式人工入口：针对指定日志文件重新执行上传、远端 SHA-256 摘要核对并补发评论。
   */
  async function recoverRetryLog(feedbackId: string, expectedRevision: number, logId: string): Promise<WorkerOpResult> {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.mgmt_state === "trash") {
        return { ok: false, reason: "invalid_state", status: row.status, note: "回收站中的记录为只读" };
      }
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      clearResumePause(feedbackId, row);
      const parsed = loadArchiveData(deps.db, feedbackId);
      if (parsed.kind !== "valid") return { ok: false, reason: "invalid_state", status: row.status };
      let data = normalizeToV3(parsed.data);
      const logs = getFeedbackLogs(deps.db, feedbackId);
      const log = logs.find((l) => l.id === logId);
      if (!log || !row.kaneo_task_id) {
        return { ok: false, reason: "invalid_state", status: row.status };
      }
      const taskId = row.kaneo_task_id;

      // P1：固定配置 + 统一目标校验
      const prep = await prepareRecovery(row, data);
      if (!prep.ok) return prep.result;
      const client = prep.client;

      let logAtt: ArchiveAttachmentRecord = data.attachments?.[log.id] ?? {
        id: log.id,
        kind: "log",
        filename: log.filename,
        byteSize: log.byte_size,
        sha256: log.sha256,
      };
      const logMarker = logCommentMarker(feedbackId, log.id, log.sha256);

      // 1. 查重
      const comments = await client.listComments(taskId);
      let logAssetUrl = logAtt?.asset?.url ?? null;
      const matched = comments.find(
        (c) =>
          c.content.includes(feedbackId) &&
          c.content.includes(log.id) &&
          c.content.includes(log.sha256) &&
          (logAssetUrl ? c.content.includes(logAssetUrl) : true),
      );

      if (matched) {
        logAtt = {
          ...logAtt,
          id: log.id,
          kind: "log",
          filename: log.filename,
          byteSize: log.byte_size,
          sha256: log.sha256,
          comment: { marker: logMarker, id: matched.id, outcome: "confirmed" },
        };
        const saved = saveRecoveryState(
          feedbackId,
          { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
          `补记日志 ${log.filename} 评论确认`,
        );
        if (!saved) return { ok: false, reason: "persist_failed" };
        data = normalizeToV3(saved);
      } else {
        // 2. 上传日志（申请新地址）
        if (!logAssetUrl) {
          const presigned = await client.createImageUpload(taskId, {
            filename: log.filename,
            contentType: getLogContentType(log.filename),
            size: log.byte_size,
            surface: "comment",
          });
          const newUpload = buildUploadRecord(deps.masterKey, presigned, "not_sent");
          const replacedKeys = [...(logAtt?.upload ? [logAtt.upload.key] : []), ...(logAtt?.replacedKeys ?? [])].slice(
            0,
            20,
          );
          logAtt = {
            ...logAtt,
            id: log.id,
            kind: "log",
            filename: log.filename,
            byteSize: log.byte_size,
            sha256: log.sha256,
            upload: newUpload,
            replacedKeys,
          };
          const savedUpload = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `保存重传日志 ${log.filename} 凭证`,
          );
          if (!savedUpload) return { ok: false, reason: "persist_failed" };
          data = normalizeToV3(savedUpload);

          // maybe_sent
          logAtt = { ...logAtt, upload: { ...newUpload, outcome: "maybe_sent" } };
          const pendingUpload = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 上传已发出（结果未知）`,
          );
          if (!pendingUpload) return { ok: false, reason: "persist_failed" };
          data = normalizeToV3(pendingUpload);

          await client.uploadImageToPresigned(presigned.uploadUrl, presigned.headers, Buffer.from(log.bytes));

          logAtt = { ...logAtt, upload: { ...newUpload, outcome: "confirmed" } };
          const confirmedUpload = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 上传成功`,
          );
          if (!confirmedUpload) return { ok: false, reason: "persist_failed" };
          data = normalizeToV3(confirmedUpload);

          const asset = await client.finalizeImageUpload(taskId, {
            key: newUpload.key,
            filename: log.filename,
            contentType: getLogContentType(log.filename),
            size: log.byte_size,
            surface: "comment",
          });

          // 下载并校验 SHA-256
          const downloaded = await client.downloadAsset(asset.url);
          const dlSha = createHash("sha256").update(Buffer.from(downloaded)).digest("hex");
          if (dlSha !== log.sha256) {
            updateFeedback(deps.db, feedbackId, {
              error_summary: `重传日志 ${log.filename} 远端校验失败（SHA-256 不一致），待核对`,
              last_error: `sha mismatch: expected ${log.sha256} got ${dlSha}`,
            });
            return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
          }

          logAssetUrl = asset.url;
          logAtt = {
            ...logAtt,
            asset: { id: asset.id, url: asset.url },
          };
          const savedAsset = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `保存重传日志 ${log.filename} 资产信息`,
          );
          if (!savedAsset) return { ok: false, reason: "persist_failed" };
          data = normalizeToV3(savedAsset);
        }

        // 3. 挂载日志评论
        const logContent = buildLogComment({
          feedbackId,
          logId: log.id,
          filename: log.filename,
          assetUrl: logAssetUrl,
          sha256: log.sha256,
          byteSize: log.byte_size,
          source: log.source,
        });

        logAtt = { ...logAtt, comment: { marker: logMarker, id: null, outcome: "maybe_sent" } };
        const pendingComment = saveRecoveryState(
          feedbackId,
          { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
          `登记日志 ${log.filename} 评论已发出（结果未知）`,
        );
        if (!pendingComment) return { ok: false, reason: "persist_failed" };
        data = normalizeToV3(pendingComment);

        let created: { id: string };
        try {
          created = await client.createComment(taskId, { content: logContent });
        } catch (err) {
          if (err instanceof KaneoDefiniteError) {
            logAtt = { ...logAtt, comment: { marker: logMarker, id: null, outcome: "not_sent" } };
            saveRecoveryState(
              feedbackId,
              { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
              `登记日志 ${log.filename} 评论被拒绝`,
            );
          }
          throw err;
        }

        const verified = await client.listComments(taskId);
        const isConfirmed = verified.some(
          (c) =>
            c.content.includes(feedbackId) &&
            c.content.includes(log.id) &&
            c.content.includes(log.sha256) &&
            c.content.includes(logAssetUrl!),
        );
        if (!isConfirmed) {
          logAtt = { ...logAtt, comment: { marker: logMarker, id: created.id || null, outcome: "maybe_sent" } };
          try {
            saveRecoveryState(
              feedbackId,
              { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
              `登记日志 ${log.filename} 评论待核对`,
            );
          } catch {}
          updateFeedback(deps.db, feedbackId, { error_summary: `重试日志 ${log.filename} 评论核对未发现，待人工核对` });
          return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
        }

        logAtt = { ...logAtt, comment: { marker: logMarker, id: created.id || null, outcome: "confirmed" } };
        const savedComment = saveRecoveryState(
          feedbackId,
          { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
          `登记日志 ${log.filename} 评论成功`,
        );
        if (!savedComment) return { ok: false, reason: "persist_failed" };
        data = normalizeToV3(savedComment);
      }

      const screenshot = getFeedbackScreenshot(deps.db, feedbackId);
      if (isFullyArchived(data, Boolean(screenshot), logs)) {
        if (
          !gateUpdate(feedbackId, "核对归档", {
            status: "archived",
            archive_stage: "complete",
            error_summary: null,
            last_error: null,
          })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }
      return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
    } finally {
      release(feedbackId);
    }
  }

  /**
   * 服务重启恢复：
   * - received/processing → 重新入队（只做 AI 整理，零远端写入）；
   * - archiving → 待核对（写入结果不确定）；
   * - ready_to_archive **且已持久化人工归档授权** → 重新入队。
   * 重启扫描绝不绕过人工授权门槛：没有授权的记录不会被重新入队归档。
   * T3：随后请求一次可恢复扫描（恢复立即可执行任务），并按库内最早到期的退避重新安排定时器。
   */
  function resume(requeue: FeedbackRow[], uncertain: FeedbackRow[], authorized: FeedbackRow[] = []): void {
    const db = deps.db;
    for (const row of uncertain) {
      updateFeedback(db, row.id, {
        status: "needs_review",
        error_summary: "服务在处理中断，Kaneo 写入结果不确定，待核对。",
      });
    }
    for (const row of [...requeue, ...authorized]) {
      enqueue(row.id);
    }
    // 重启后：立即扫描可执行积压，并重新安排尚未到期的重试（不依赖管理员再次点击）。
    requestScan();
  }

  return {
    enqueue,
    idle,
    stop,
    retry,
    recheck,
    forceCreate,
    recoverRetryComment,
    recoverReplaceUpload,
    recoverRetryLog,
    resume,
    scanAutoArchive: requestScan,
    processOne,
    withFeedbackLock,
  };
}

export type Worker = ReturnType<typeof createWorker>;
