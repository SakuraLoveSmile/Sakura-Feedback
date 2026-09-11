import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import {
  type AppRow,
  type FeedbackRow,
  getApp,
  getFeedback,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  getSetting,
  resolveOutputPixels,
  updateFeedback,
} from "../db/repos.ts";
import { type AiClient, AiError } from "../services/ai.ts";
import {
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
  type ArchiveDataNext,
  type ArchiveDataV1,
  ArchivePersistenceError,
  type ArchiveTarget,
  type ArchiveUpload,
  ArchiveVersionConflictError,
  buildUploadRecord,
  checkArchiveTarget,
  commentMarker,
  decryptUploadCredentials,
  loadArchiveData,
  MAX_SAME_KEY_RECOVERIES,
  type ParsedArchiveData,
  saveArchiveData,
  type UploadCredentials,
} from "./archive-data.ts";

const MAX_ATTEMPTS = 3; // AI 调用（含格式失败/超时/限流）单轮最多 3 次

/**
 * 4.5 阶段矛盾检查：归档阶段 / 任务 ID / 恢复数据互相矛盾时返回描述（→待核对，不猜测重建）。
 * 只检查确定性矛盾；旧格式（legacy）记录不在 V1 字段层面检查。
 */
function stageContradiction(row: FeedbackRow, parsed: ParsedArchiveData): string | null {
  const data = parsed.kind === "valid" ? parsed.data : null;
  if (row.archive_stage === "complete" && row.status !== "archived") {
    return `archive_stage=complete 但 status=${row.status}`;
  }
  if (data && (data.upload || data.asset || data.comment) && !row.kaneo_task_id) {
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

  function enqueue(feedbackId: string): void {
    if (!queue.includes(feedbackId)) queue.push(feedbackId);
    void drain();
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
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

  /** 等待队列排空（测试与优雅关闭用）。 */
  async function idle(): Promise<void> {
    while (running || queue.length > 0) {
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
  function saveRecoveryState(feedbackId: string, next: ArchiveDataNext, what: string): ArchiveDataV1 | null {
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
    saved: ArchiveDataV1 | null,
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
    let cur: ArchiveDataV1 | null = parsedArchive.kind === "valid" ? parsedArchive.data : null;

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
          ...(cur?.upload ? { upload: cur.upload } : {}),
          ...(legacyAssetUrl ? { asset: { id: "", url: legacyAssetUrl } } : cur?.asset ? { asset: cur.asset } : {}),
          ...(cur?.comment ? { comment: cur.comment } : {}),
        };
        cur = saveArchiveData(db, row.id, loadArchiveData(db, row.id), next);
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
        cur = saveArchiveData(db, row.id, loadArchiveData(db, row.id), next);
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
      const description = buildTaskDescription(row.id, processed, {
        appName: app.name,
        appId: app.app_id,
        appVersion: context.appVersion,
        pageLabel: context.pageLabel,
        submittedAt: row.created_at,
        text: row.text,
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

    // 检查是否有截图需要归档（已在阶段前置检查中读取）
    if (!screenshot) {
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

    // 阶段 2~5：图文归档（图片上传与评论挂载）
    try {
      // 先核对该任务下是否已有关于此 feedbackId 的截图评论（幂等）
      const existingComments = await kaneo.listComments(taskId);
      // 4.3：匹配用准确反馈 ID + 图片摘要 + 当前资产引用（资产已知时旧评论引用旧资产不算命中）
      const currentAssetUrl: string | null = cur.asset?.url ?? null;
      const commentMatches = (c: { content: string }, assetRef?: string | null): boolean =>
        c.content.includes(row.id) &&
        c.content.includes(screenshot.sha256) &&
        (assetRef ? c.content.includes(assetRef) : true);
      const matchedComment = existingComments.find((c) => commentMatches(c, currentAssetUrl));
      if (matchedComment) {
        // 已有评论：补记评论恢复信息（尽力而为，归档本身已完成，不因补记失败重开流程）
        try {
          persistArchive(
            {
              ...cur,
              comment: {
                marker: commentMarker(row.id, screenshot.sha256),
                id: matchedComment.id,
                outcome: "confirmed",
              },
            },
            "补记已有截图评论",
          );
        } catch {
          /* 补记失败不影响既有归档事实 */
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

      // 阶段 2~4：上传（已知资产则直接复用，含旧格式迁移的 assetUrl）
      let assetUrl: string;
      if (cur.asset?.url) {
        assetUrl = cur.asset.url;
      } else {
        if (!gateUpdate(row.id, "标记 asset_uploading", { archive_stage: "asset_uploading" })) return;

        let uploadRecord = cur.upload;
        let uploadUrl = "";
        let uploadHeaders: Record<string, string> = {};
        /** 本次是否复用已有 key 重传（决定是否递增恢复计数）。 */
        let sameKeyRecovery = false;

        if (uploadRecord && uploadRecord.outcome === "confirmed") {
          // 4.2：PUT 已收到成功响应并持久化 → 只对原 key finalize，绝不重传、不申请新地址
          const asset = await kaneo.finalizeImageUpload(taskId, {
            key: uploadRecord.key,
            filename: "screenshot.png",
            contentType: "image/png",
            size: screenshot.byte_size,
            surface: "comment",
          });
          assetUrl = asset.url;
          if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
          if (!persistArchive({ ...cur, asset: { id: asset.id, url: asset.url } }, "保存资产信息")) return;
        } else {
          // 恢复路径：not_sent / maybe_sent → 同 key 重传相同字节（安全恢复）。
          // 三条边界（P1）的区别在于「远端是否可能存在该次上传的对象」：
          //   · 地址已过期 → 同 key 重传不再可能，**绝不自动申请新 key**（旧 key 与其可能的
          //     远端对象必须保留线索），转待核对，由管理页 replace_upload 显式替换；
          //   · 同 key 重传被业务拒绝 → 同理，绝不自动换 key；
          //   · **完全没有 upload 记录** → 说明上传记录尚未落盘、字节从未发出（见下方 P1 注释：
          //     上传记录与 maybe_sent 都先落盘、之后才 PUT），远端不可能存在该次上传的对象，
          //     因此允许**重新申请地址**（被丢弃的只是一个未被使用的预签名地址，不会遗留
          //     未被追踪的已上传对象）。对应 fault-injection「presign 返回后、本地落盘前中断」。
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
              // 凭证无法解密（主密钥不匹配/损坏）：无法同 key 恢复，也不得猜新地址写入 → 待核对
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: "预签名凭证无法解密，无法同 key 恢复，待人工核对",
                last_error: (err as Error).message.slice(0, 300),
              });
              return;
            }
            if (uploadRecord.expiresAt !== null && Date.parse(uploadRecord.expiresAt) <= Date.now()) {
              // P1：地址已过期 → 同 key 重传不再可能，但绝不自动申请新 key
              //（自动换 key 会遗留未被追踪的旧对象且未经管理员确认）。保留原 key 与全部线索，转待核对。
              updateFeedback(db, row.id, {
                status: "needs_review",
                error_summary: "上传地址已过期，已停止同 key 恢复；请在管理页用“替换图片”重新上传（不自动申请新地址）",
                last_error: `upload.key=${uploadRecord.key.slice(0, 80)} expiresAt=${uploadRecord.expiresAt} outcome=${uploadRecord.outcome}`,
              });
              return;
            }
            uploadUrl = creds.uploadUrl;
            uploadHeaders = creds.headers;
            sameKeyRecovery = true;
          } else {
            // 4.2：首次申请上传地址只分配地址；拿到地址先落盘（凭证加密）再传字节
            const presigned = await kaneo.createImageUpload(taskId, {
              filename: "screenshot.png",
              contentType: "image/png",
              size: screenshot.byte_size,
              surface: "comment",
            });
            uploadRecord = buildUploadRecord(deps.masterKey, presigned, "not_sent");
            uploadUrl = presigned.uploadUrl;
            uploadHeaders = presigned.headers;
            if (!persistArchive({ ...cur, upload: uploadRecord }, "保存预签名上传凭证")) return;
          }

          if (sameKeyRecovery) {
            // 4.3：同 key 恢复——先持久化恢复计数（意图），再向同一 key 重传相同字节
            const bumped: ArchiveUpload = { ...uploadRecord, recoveries: (uploadRecord.recoveries ?? 0) + 1 };
            if (!persistArchive({ ...cur, upload: bumped }, "登记同 key 重传意图")) return;
            uploadRecord = bumped;
          }

          // P1：字节发出前先落盘“结果未知”意图。持久化失败则绝不发出请求
          //（崩溃/断连后恢复时不会把未知结果误判为“未发送”）。
          if (
            !persistArchive(
              { ...cur, upload: { ...uploadRecord, outcome: "maybe_sent" } },
              "登记上传已发出（结果未知）",
            )
          )
            return;

          // 阶段 3：二进制上传（仅使用 presigned 要求的 headers，绝不携带 Kaneo API Key）。
          try {
            await kaneo.uploadImageToPresigned(uploadUrl, uploadHeaders, Buffer.from(screenshot.png_blob));
          } catch (err) {
            if (err instanceof KaneoUncertainError) throw err; // 结果未知：已登记 maybe_sent，按不确定上报
            if (!uploadRecord.recoveries || uploadRecord.recoveries <= 0) throw err; // 全新申请被拒 → 明确失败
            // P1：同 key 重传被业务拒绝（签名失效/策略拒绝等）→ 绝不自动申请新 key，
            // 保留原 key、结果与资产线索，转待核对由 replace_upload 显式替换。
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

          // 阶段 3.5：收到成功 PUT 响应并持久化后，才允许 finalize 登记资产
          if (!persistArchive({ ...cur, upload: { ...uploadRecord, outcome: "confirmed" } }, "登记上传成功")) return;

          // 阶段 4：finalize 登记资产（仅登记，不校验存储文件）
          const asset = await kaneo.finalizeImageUpload(taskId, {
            key: uploadRecord.key,
            filename: "screenshot.png",
            contentType: "image/png",
            size: screenshot.byte_size,
            surface: "comment",
          });
          assetUrl = asset.url;
          if (!gateUpdate(row.id, "标记 asset_finalized", { archive_stage: "asset_finalized" })) return;
          if (!persistArchive({ ...cur, asset: { id: asset.id, url: asset.url } }, "保存资产信息")) return;
        }
      }

      // 阶段 5：添加截图评论
      if (!gateUpdate(row.id, "标记 comment_pending", { archive_stage: "comment_pending" })) return;
      const marker = commentMarker(row.id, screenshot.sha256);
      const commentContent = buildScreenshotComment({
        feedbackId: row.id,
        assetUrl,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
      });

      // P1：进入评论阶段前先判断既有评论写入结果。
      // 上方入口查重已确认评论**未命中**；若恢复数据显示评论结果未知（maybe_sent）
      // 或已确认（confirmed），说明自动路径无法证明评论不存在 → 绝不自动重发，
      // 保留全部线索转待核对，只有管理页显式 retry_comment 才允许一次发送。
      const priorCommentOutcome = cur.comment?.outcome ?? null;
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

      // 发出前先落盘“结果未知”意图：持久化失败则绝不发出评论请求
      if (
        !persistArchive({ ...cur, comment: { marker, id: null, outcome: "maybe_sent" } }, "登记评论已发出（结果未知）")
      )
        return;
      let created: { id: string };
      try {
        created = await kaneo.createComment(taskId, { content: commentContent });
      } catch (err) {
        if (err instanceof KaneoDefiniteError) {
          // 明确被拒绝：评论未被创建 → 记录为确定未发送，允许后续自动重试
          persistArchive({ ...cur, comment: { marker, id: null, outcome: "not_sent" } }, "登记评论被拒绝（未创建）");
        }
        throw err;
      }

      // 核对评论是否已成功挂载（含当前资产引用）
      const verifiedComments = await kaneo.listComments(taskId);
      const isConfirmed = verifiedComments.some((c) => commentMatches(c, assetUrl));
      if (!isConfirmed) {
        // 提交成功但列表核对未见：登记评论结果未知（尽力而为），保持待核对语义
        try {
          persistArchive(
            { ...cur, comment: { marker, id: created.id || null, outcome: "maybe_sent" } },
            "登记评论待核对",
          );
        } catch {
          /* 尽力而为 */
        }
        updateFeedback(db, row.id, {
          status: "needs_review",
          error_summary: "截图评论已提交但核对未发现，待人工核对",
        });
        return;
      }

      // 评论确认挂载：登记评论恢复信息后标记归档完成（此后无远端写入，登记失败不阻塞终态）
      try {
        persistArchive({ ...cur, comment: { marker, id: created.id || null, outcome: "confirmed" } }, "登记评论成功");
      } catch {
        /* 尽力而为 */
      }
      updateFeedback(db, row.id, {
        status: "archived",
        archive_stage: "complete",
        kaneo_task_id: taskId,
        kaneo_task_url: taskUrl,
        error_summary: null,
        last_error: null,
      });
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

      // 2. 检查是否有截图
      const screenshot = getFeedbackScreenshot(deps.db, feedbackId);
      if (!screenshot) {
        // 纯文字反馈，确认有 task 即归档完成
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }

      // 3. 图文反馈：核对评论是否存在（含资产引用；读取失败会抛错，绝不当“没有评论”）
      const assetRef = saved?.asset?.url ?? null;
      const comments = await client.listComments(taskId);
      const matched = comments.find(
        (c) =>
          c.content.includes(row.id) &&
          c.content.includes(screenshot.sha256) &&
          (assetRef ? c.content.includes(assetRef) : true),
      );
      if (matched) {
        // 4.2：核对命中 → 补记评论确认结果（尽力而为；此后无远端写入，不阻塞终态）
        try {
          const base = loadArchiveData(deps.db, feedbackId);
          if (base.kind === "valid") {
            saveArchiveData(deps.db, feedbackId, base, {
              ...base.data,
              comment: { marker: commentMarker(feedbackId, screenshot.sha256), id: matched.id, outcome: "confirmed" },
            });
          }
        } catch {
          /* 尽力而为 */
        }
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
      }

      // P1：核对未命中且评论结果未知（或已记录确认）→ 绝不自动重发，维持待核对。
      // 只有显式 retry_comment 才允许一次发送（且界面会提示仍可能存在重复风险）。
      const commentOutcome = saved?.comment?.outcome ?? null;
      if (commentOutcome === "maybe_sent" || commentOutcome === "confirmed") {
        if (
          !gateUpdate(feedbackId, "核对未命中（不自动重发）", {
            error_summary:
              commentOutcome === "maybe_sent"
                ? "截图评论写入结果未知且核对未命中，已停止自动处理；请在管理页重试评论或人工核对"
                : "恢复数据记录评论已确认但核对未命中，已停止处理，待人工核对",
            last_error: `recheck: comment.outcome=${commentOutcome}，自动路径不重发评论`,
          })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "needs_review", revision: currentRevision(feedbackId) };
      }

      // 评论确认为“从未发送”：从断点继续补图，绝不立即标记已归档；阶段保持不回退
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
        if (
          !gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })
        ) {
          return { ok: false, reason: "persist_failed" };
        }
        return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
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
      const content = buildScreenshotComment({
        feedbackId,
        assetUrl,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
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
      try {
        saveRecoveryState(
          feedbackId,
          { ...fresh.data, comment: { marker, id: created.id || null, outcome: "confirmed" } },
          "登记评论成功",
        );
      } catch {
        /* 尽力而为 */
      }
      if (!gateUpdate(feedbackId, "核对归档", { status: "archived", archive_stage: "complete", error_summary: null })) {
        return { ok: false, reason: "persist_failed" };
      }
      return { ok: true, status: "archived", revision: currentRevision(feedbackId) };
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
      const content = buildScreenshotComment({
        feedbackId,
        assetUrl: asset.url,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
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
      try {
        saveRecoveryState(
          feedbackId,
          { ...fresh.data, comment: { marker, id: created.id || null, outcome: "confirmed" } },
          "登记评论成功",
        );
      } catch {
        /* 尽力而为 */
      }
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

  return { enqueue, idle, retry, recheck, forceCreate, recoverRetryComment, recoverReplaceUpload, resume, processOne };
}

export type Worker = ReturnType<typeof createWorker>;
