import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import {
  type AppRow,
  type FeedbackRow,
  getApp,
  getFeedback,
  getFeedbackLogs,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  resolveOutputPixels,
  updateFeedback,
} from "../db/repos.ts";
import { type AiClient, AiError, prepareLogEvidence } from "../services/ai.ts";
import {
  buildLogComment,
  buildScreenshotComment,
  buildTaskDescription,
  type KaneoClient,
  KaneoColumnNotFound,
  KaneoDefiniteError,
  type KaneoSettings,
  KaneoUncertainError,
} from "../services/kaneo.ts";
import { normalizeKaneoApiBase } from "../services/kaneo-http.ts";
import {
  type ArchiveAttachmentRecord,
  type ArchiveData,
  type ArchiveDataNext,
  type ArchiveDataV2,
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
  normalizeToV2,
  type ParsedArchiveData,
  saveArchiveData,
  type UploadCredentials,
} from "./archive-data.ts";

const MAX_ATTEMPTS = 3; // AI 调用（含格式失败/超时/限流）单轮最多 3 次

/**
 * 4.5 阶段矛盾检查：归档阶段 / 任务 ID / 恢复数据互相矛盾时返回描述（→待核对，不猜测重建）。
 * 只检查确定性矛盾；旧格式（legacy）记录不在 V1/V2 字段层面检查。
 */
function stageContradiction(row: FeedbackRow, parsed: ParsedArchiveData): string | null {
  const data = parsed.kind === "valid" ? parsed.data : null;
  if (row.archive_stage === "complete" && row.status !== "archived") {
    return `archive_stage=complete 但 status=${row.status}`;
  }
  const attachments = data && "attachments" in data ? (data as ArchiveDataV2).attachments : {};
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

function isFullyArchived(data: ArchiveDataV2 | null, hasScreenshot: boolean, logs: { id: string }[]): boolean {
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
  return true;
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
}

/**
 * 处理流水线的唯一驱动者。串行处理（并发 1），提交/恢复时入队。
 * 状态机见 docs/api.md。正常处理与人工操作共用同一反馈级操作锁（4.4）。
 */
export function createWorker(deps: WorkerDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const queue: string[] = [];
  let running = false;
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

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        // 更新暂停：不取队、不处理，等暂停解除后继续（绝不丢弃已入队的工作）。
        if (paused()) {
          await sleep(pausePollMs);
          continue;
        }
        const id = queue.shift()!;
        try {
          await processOne(id);
        } catch (err) {
          // processOne 内部已兜底；到这里说明是程序性 bug，标 failed 留痕
          safeFail(id, `worker 内部错误: ${(err as Error).message?.slice(0, 200) ?? String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * 等待队列排空（测试与优雅关闭用）。
   * U1-4：更新暂停期间立即返回——此时执行器正在等待本服务退出（`compose stop -t 30`），
   * 若在这里死等排空会让停机超时被 SIGKILL，WAL 留在盘上、升级中止。
   * 队列仍保留在内存（服务随后会被重建），解除暂停后由 drain 继续处理。
   * 注意：暂停期间调用方不应再写数据库（调用顺序见 index.ts 的优雅退出）。
   */
  async function idle(): Promise<void> {
    while (running || queue.length > 0) {
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
    if (!app?.kaneo_project_id) {
      return { ok: false, result: { ok: false, reason: "invalid_state", note: "应用未配置 Kaneo 目标项目" } };
    }
    if (!saved) return { ok: true, client: bound.client, apiBase: bound.apiBase };

    let resolved: ArchiveTarget;
    try {
      const proj = await bound.client.getProjectInfo(app.kaneo_project_id);
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
    if (row.status !== "received" && row.status !== "processing") return;

    const app = appOf(row);
    if (!app) {
      updateFeedback(db, feedbackId, { status: "failed", error_summary: "软件配置不存在或已删除" });
      return;
    }

    if (row.status === "received") {
      updateFeedback(db, feedbackId, { status: "processing", archive_stage: "task_pending", kaneo_task_id: null });
      row = getFeedback(db, feedbackId)!;
    }

    // ---- AI 整理（已有整理结果则跳过，支持从归档失败处重试） ----
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
          if (!aiErr.retryable || attempt === MAX_ATTEMPTS) {
            updateFeedback(db, feedbackId, {
              status: "failed",
              error_summary: aiErr.message.slice(0, 300),
              last_error: `AI 阶段（第 ${attempt} 次，kind=${aiErr.kind}）: ${aiErr.message}`.slice(0, 1000),
            });
            return;
          }
          await sleep(attempt * 1000);
        }
      }
      if (!processed) {
        updateFeedback(db, feedbackId, {
          status: "failed",
          error_summary: lastErr?.message.slice(0, 300) ?? "AI 处理失败",
        });
        return;
      }
      updateFeedback(db, feedbackId, {
        title: processed.title,
        processed_json: JSON.stringify(processed),
      });
      row = getFeedback(db, feedbackId)!;
    }

    // ---- 归档到 Kaneo ----
    await archive(row, app, processed);
  }

  async function archive(
    row: FeedbackRow,
    app: AppRow,
    processed: Parameters<typeof buildTaskDescription>[1],
  ): Promise<void> {
    const db = deps.db;
    if (!app.kaneo_project_id || !app.kaneo_column_slug) {
      updateFeedback(db, row.id, {
        status: "failed",
        error_summary: "未配置 Kaneo 目标项目或列",
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
    let cur: ArchiveDataV2 | null = parsedArchive.kind === "valid" ? normalizeToV2(parsedArchive.data) : null;

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

    // ---- 4.1 首次远端写入前固定恢复目标（Kaneo 实例 / 项目 / 工作区） ----
    const target: ArchiveTarget = {
      apiBase: normalizeKaneoApiBase(baseUrl),
      projectId: app.kaneo_project_id,
      workspaceId: "",
    };
    try {
      const proj = await kaneo.getProjectInfo(app.kaneo_project_id);
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
          attachments: cur?.attachments ?? {},
          ...(cur?.upload ? { upload: cur.upload } : {}),
          ...(legacyAssetUrl ? { asset: { id: "", url: legacyAssetUrl } } : cur?.asset ? { asset: cur.asset } : {}),
          ...(cur?.comment ? { comment: cur.comment } : {}),
        };
        const saved = saveArchiveData(db, row.id, loadArchiveData(db, row.id), next);
        cur = normalizeToV2(saved);
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
        cur = normalizeToV2(saved);
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
          projectId: app.kaneo_project_id,
          columnSlug: app.kaneo_column_slug,
          title: processed.title,
          description,
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
            const found = await kaneo.findByFeedbackId(app.kaneo_project_id, row.id);
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

    // 检查是否有附件（截图或日志）需要归档（已在阶段前置检查中读取）
    const logs = getFeedbackLogs(db, row.id);
    if (!screenshot && logs.length === 0) {
      // 纯文字反馈：任务创建完成即代表归档完成
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

      // 3. 所有附件（截图若存在 + 全部日志）全部确认后，才标记归档完成
      if (isFullyArchived(cur, Boolean(screenshot), logs)) {
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

  /** 管理页人工重试：failed → 从持久化断点继续（不清 task/key/asset）。 */
  function retry(feedbackId: string, expectedRevision?: number): WorkerOpResult {
    if (!tryAcquire(feedbackId)) return { ok: false, reason: "busy" };
    let result: WorkerOpResult;
    try {
      const row = getFeedback(deps.db, feedbackId);
      if (!row) return { ok: false, reason: "not_found" };
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "failed") return { ok: false, reason: "invalid_state", status: row.status };
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
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      const app = appOf(row);
      if (!app) return { ok: false, reason: "invalid_state", status: row.status };

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
        const ref = await client.findByFeedbackId(app.kaneo_project_id!, row.id);
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
      let curV2 = base.kind === "valid" ? normalizeToV2(base.data) : null;
      if (!curV2) {
        return { ok: false, reason: "invalid_state" };
      }

      let screenshotConfirmed = false;
      let hasUnconfirmedMaybeOrConfirmed = false;

      if (screenshot) {
        const assetRef = curV2.attachments?.screenshot?.asset?.url ?? curV2.asset?.url ?? null;
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
            ...(curV2.attachments?.screenshot ?? {}),
            id: "screenshot",
            kind: "screenshot" as const,
            filename: "screenshot.png",
            byteSize: screenshot.byte_size,
            sha256: screenshot.sha256,
            comment: commentRecord,
          };
          curV2 = {
            ...curV2,
            attachments: { ...curV2.attachments, screenshot: screenshotAtt },
            comment: commentRecord,
          };
        } else {
          const sOutcome = curV2.attachments?.screenshot?.comment?.outcome ?? curV2.comment?.outcome;
          if (sOutcome === "maybe_sent" || sOutcome === "confirmed") {
            hasUnconfirmedMaybeOrConfirmed = true;
          }
        }
      }

      let allLogsConfirmed = true;
      for (const log of logs) {
        const logAssetRef = curV2.attachments?.[log.id]?.asset?.url ?? null;
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
            ...(curV2.attachments?.[log.id] ?? {}),
            id: log.id,
            kind: "log" as const,
            filename: log.filename,
            byteSize: log.byte_size,
            sha256: log.sha256,
            comment: logCommentRecord,
          };
          curV2 = {
            ...curV2,
            attachments: { ...curV2.attachments, [log.id]: logAtt },
          };
        } else {
          allLogsConfirmed = false;
          const lOutcome = curV2.attachments?.[log.id]?.comment?.outcome;
          if (lOutcome === "maybe_sent" || lOutcome === "confirmed") {
            hasUnconfirmedMaybeOrConfirmed = true;
          }
        }
      }

      try {
        saveRecoveryState(feedbackId, curV2, "核对附件评论确认状态");
      } catch {
        /* 尽力而为 */
      }

      const allAttachmentsConfirmed = (!screenshot || screenshotConfirmed) && allLogsConfirmed;
      if (allAttachmentsConfirmed) {
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
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      if (!row.processed_json) return { ok: false, reason: "invalid_state", status: row.status };
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
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
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
        const freshV2 = normalizeToV2(saved);
        if (isFullyArchived(freshV2, true, logs)) {
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
      const freshV2Base = normalizeToV2(fresh.data);
      const confirmedComment = { marker, id: created.id || null, outcome: "confirmed" as const };
      const screenshotAtt = freshV2Base.attachments?.screenshot
        ? { ...freshV2Base.attachments.screenshot, comment: confirmedComment }
        : undefined;
      const confirmedData: ArchiveDataNext = {
        ...freshV2Base,
        comment: confirmedComment,
        ...(screenshotAtt ? { attachments: { ...freshV2Base.attachments, screenshot: screenshotAtt } } : {}),
      };
      let savedState: ArchiveData | null = null;
      try {
        savedState = saveRecoveryState(feedbackId, confirmedData, "登记评论成功");
      } catch {
        /* 尽力而为 */
      }
      const freshV2 = normalizeToV2(savedState ?? (confirmedData as ArchiveData));
      if (isFullyArchived(freshV2, true, logs)) {
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
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
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
      const freshV2Base = normalizeToV2(fresh.data);
      const confirmedComment = { marker, id: created.id || null, outcome: "confirmed" as const };
      const screenshotAtt = freshV2Base.attachments?.screenshot
        ? { ...freshV2Base.attachments.screenshot, comment: confirmedComment }
        : undefined;
      const confirmedData: ArchiveDataNext = {
        ...freshV2Base,
        comment: confirmedComment,
        ...(screenshotAtt ? { attachments: { ...freshV2Base.attachments, screenshot: screenshotAtt } } : {}),
      };
      let savedState: ArchiveData | null = null;
      try {
        savedState = saveRecoveryState(feedbackId, confirmedData, "登记评论成功");
      } catch {
        /* 尽力而为 */
      }
      const freshV2 = normalizeToV2(savedState ?? (confirmedData as ArchiveData));
      if (isFullyArchived(freshV2, true, logs)) {
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
      const revFail = checkRevision(feedbackId, expectedRevision);
      if (revFail) return revFail;
      if (row.status !== "needs_review") return { ok: false, reason: "invalid_state", status: row.status };
      const parsed = loadArchiveData(deps.db, feedbackId);
      if (parsed.kind !== "valid") return { ok: false, reason: "invalid_state", status: row.status };
      let data = normalizeToV2(parsed.data);
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
        data = normalizeToV2(saved);
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
          data = normalizeToV2(savedUpload);

          // maybe_sent
          logAtt = { ...logAtt, upload: { ...newUpload, outcome: "maybe_sent" } };
          const pendingUpload = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 上传已发出（结果未知）`,
          );
          if (!pendingUpload) return { ok: false, reason: "persist_failed" };
          data = normalizeToV2(pendingUpload);

          await client.uploadImageToPresigned(presigned.uploadUrl, presigned.headers, Buffer.from(log.bytes));

          logAtt = { ...logAtt, upload: { ...newUpload, outcome: "confirmed" } };
          const confirmedUpload = saveRecoveryState(
            feedbackId,
            { ...data, attachments: { ...data.attachments, [log.id]: logAtt } },
            `登记日志 ${log.filename} 上传成功`,
          );
          if (!confirmedUpload) return { ok: false, reason: "persist_failed" };
          data = normalizeToV2(confirmedUpload);

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
          data = normalizeToV2(savedAsset);
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
        data = normalizeToV2(pendingComment);

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
        data = normalizeToV2(savedComment);
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

  /** 服务重启恢复：received/processing 重新入队；archiving 转为待核对。 */
  function resume(requeue: FeedbackRow[], uncertain: FeedbackRow[]): void {
    const db = deps.db;
    for (const row of uncertain) {
      updateFeedback(db, row.id, {
        status: "needs_review",
        error_summary: "服务在处理中断，Kaneo 写入结果不确定，待核对。",
      });
    }
    for (const row of requeue) {
      enqueue(row.id);
    }
  }

  return {
    enqueue,
    idle,
    retry,
    recheck,
    forceCreate,
    recoverRetryComment,
    recoverReplaceUpload,
    recoverRetryLog,
    resume,
    processOne,
  };
}

export type Worker = ReturnType<typeof createWorker>;
