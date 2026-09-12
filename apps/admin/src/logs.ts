/**
 * 日志附件相关的纯函数：展示格式化、预览截断、诊断内容归一化、日志级恢复状态解析。
 * 所有解析都对「服务端字段缺失/结构不符」保持安全降级（并行开发期契约可能暂未就绪）。
 */

import type { FeedbackLogMeta, FeedbackRecovery } from "./api.ts";

/** 预览最多渲染的 Unicode 码点数；超出部分只提示不渲染。 */
export const LOG_PREVIEW_MAX_CHARS = 20000;

/** 只有这两个动作支持按 logId 下发（契约 §3.4）。 */
const LOG_SCOPED_ACTIONS = new Set(["retry_comment", "replace_upload"]);

export type RecoveryScope = "screenshot" | "log";

/** 归一化后的单份日志恢复状态。 */
export interface LogRecoveryState {
  logId: string;
  revision?: number;
  stage: string | null;
  uploadOutcome: string | null;
  commentOutcome: string | null;
  assetKnown?: boolean;
  allowedActions: string[];
  actionTargets: Record<string, string>;
  actionNotes: Record<string, string>;
}

/** 归一化后的诊断文本；三个字段都可能为空字符串。 */
export interface DiagnosticTexts {
  logEvidence: string;
  possibleCauses: string;
  speculation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function toRecordOfStrings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// ---------- 展示格式化 ----------

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** sha256 截断展示（完整值放到 title 里）。 */
export function shortSha(sha: string | null | undefined, head = 12): string {
  if (typeof sha !== "string" || sha.length === 0) return "—";
  return sha.length <= head ? sha : `${sha.slice(0, head)}…`;
}

export function logSourceLabel(source: string | null | undefined): string {
  if (source === "auto") return "自动采集";
  if (source === "manual") return "手动添加";
  return source ? source : "来源未知";
}

/** 展示顺序：ordinal 升序，缺失 ordinal 的排在后面，保持稳定。 */
export function sortLogs(logs: FeedbackLogMeta[] | null | undefined): FeedbackLogMeta[] {
  if (!Array.isArray(logs)) return [];
  return [...logs].sort((a, b) => {
    const ao = typeof a?.ordinal === "number" ? a.ordinal : Number.MAX_SAFE_INTEGER;
    const bo = typeof b?.ordinal === "number" ? b.ordinal : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
}

/** 按码点截断预览文本，避免把代理对切两半。 */
export function truncateLogText(
  text: string,
  max = LOG_PREVIEW_MAX_CHARS,
): { text: string; totalChars: number; truncated: boolean; omitted: number } {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return { text, totalChars: chars.length, truncated: false, omitted: 0 };
  }
  return {
    text: chars.slice(0, max).join(""),
    totalChars: chars.length,
    truncated: true,
    omitted: chars.length - max,
  };
}

// ---------- AI 诊断 ----------

/** 读取 processed.diagnostics；旧结果缺失、结构不符或三个字段全空时返回 null。 */
export function readDiagnostics(processed: { diagnostics?: unknown } | null | undefined): DiagnosticTexts | null {
  if (!isRecord(processed)) return null;
  const raw = processed.diagnostics;
  if (!isRecord(raw)) return null;
  const texts: DiagnosticTexts = {
    logEvidence: (toStringOrNull(raw.logEvidence) ?? "").trim(),
    possibleCauses: (toStringOrNull(raw.possibleCauses) ?? "").trim(),
    speculation: (toStringOrNull(raw.speculation) ?? "").trim(),
  };
  if (!texts.logEvidence && !texts.possibleCauses && !texts.speculation) return null;
  return texts;
}

// ---------- 日志级恢复状态（服务端字段待定，防御式解析） ----------

function toLogRecoveryState(raw: unknown, fallbackId: string): LogRecoveryState | null {
  if (!isRecord(raw)) return null;
  const logId = toStringOrNull(raw.logId) ?? toStringOrNull(raw.id) ?? fallbackId;
  if (!logId) return null;
  return {
    logId,
    revision: typeof raw.revision === "number" ? raw.revision : undefined,
    stage: toStringOrNull(raw.stage),
    uploadOutcome: toStringOrNull(raw.uploadOutcome),
    commentOutcome: toStringOrNull(raw.commentOutcome),
    assetKnown: typeof raw.assetKnown === "boolean" ? raw.assetKnown : undefined,
    allowedActions: toStringArray(raw.allowedActions),
    actionTargets: toRecordOfStrings(raw.actionTargets),
    actionNotes: toRecordOfStrings(raw.actionNotes),
  };
}

/**
 * 从 recovery 里取出某份日志的恢复状态。
 * 兼容：数组（元素含 logId/id）或按 logId 索引的对象；字段名 logs / logStates 都接受。
 * 解析不到时返回 null —— 管理页据此不渲染日志级恢复按钮，截图恢复完全不受影响。
 */
export function pickLogRecovery(recovery: FeedbackRecovery | null | undefined, logId: string): LogRecoveryState | null {
  if (!recovery || typeof recovery !== "object" || !logId) return null;
  for (const candidate of [recovery.logs, recovery.logStates]) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const state = toLogRecoveryState(item, "");
        if (state && state.logId === logId) return state;
      }
    } else if (isRecord(candidate)) {
      const state = toLogRecoveryState(candidate[logId], logId);
      if (state) return state;
    }
  }
  return null;
}

/** 只保留可按 logId 下发的动作；没有可用动作时不渲染按钮。 */
export function logScopedActions(state: LogRecoveryState | null | undefined): string[] {
  if (!state) return [];
  return state.allowedActions.filter((a) => LOG_SCOPED_ACTIONS.has(a));
}

/** 日志级状态摘要（只在字段存在时展示）。 */
export function logRecoverySummary(state: LogRecoveryState): string {
  const parts: string[] = [];
  if (state.stage) parts.push(`阶段 ${state.stage}`);
  if (state.uploadOutcome) parts.push(`上传 ${state.uploadOutcome}`);
  if (state.commentOutcome) parts.push(`评论 ${state.commentOutcome}`);
  if (typeof state.assetKnown === "boolean") parts.push(`资产${state.assetKnown ? "已知" : "未知"}`);
  return parts.join(" · ");
}

// ---------- 恢复动作文案（截图 / 日志共用同一风格） ----------

export function recoveryActionLabel(action: string, scope: RecoveryScope = "screenshot"): string {
  switch (action) {
    case "retry":
      return "重试处理";
    case "recheck":
      return "重新核对";
    case "force-create":
      return "确认缺失，再次创建";
    case "retry_comment":
      return scope === "log" ? "重试日志评论" : "重试截图评论";
    case "replace_upload":
      return scope === "log" ? "替换日志上传" : "替换截图上传";
    default:
      return action;
  }
}

/**
 * 点击前的确认文案。
 * 截图（scope="screenshot"）逐字沿用旧管理页文案，不改动既有确认弹窗；
 * 日志（scope="log"）只把对象换成「该日志附件」，风险说明保持一致。
 */
export function recoveryActionConfirm(action: string, scope: RecoveryScope = "screenshot"): string | null {
  const logScope = scope === "log";
  switch (action) {
    case "force-create":
      return "确认 Kaneo 中不存在对应任务且无任何已知附件状态？将再次创建，可能产生重复。";
    case "replace_upload":
      return logScope
        ? "将按同一任务重新申请上传地址并替换该日志附件资产；旧对象不会被自动删除。继续？"
        : "将按同一任务重新申请上传地址并替换截图资产；旧对象不会被自动删除。继续？";
    case "retry_comment":
      return logScope
        ? "重发该日志附件评论会先查重，只有未命中才发送一次；但远端列表与写入之间存在竞态，仍可能产生重复评论。确认重发？"
        : "重发评论会先查重，只有未命中才发送一次；但远端列表与写入之间存在竞态，仍可能产生重复评论。确认重发？";
    default:
      return null;
  }
}

// ---------- 恢复请求构造 ----------

/**
 * 构造恢复/重试请求（契约 §3.4）。
 * - 截图恢复：不传 logId（与旧管理页兼容）。
 * - 日志级恢复：额外带 logId，只影响那一份日志附件。
 */
export function recoveryRequest(
  feedbackId: string,
  action: string,
  expectedRevision: number,
  logId?: string,
): { url: string; body: Record<string, unknown> } {
  const id = encodeURIComponent(feedbackId);
  if (action === "retry") {
    return { url: `/api/feedback/${id}/retry`, body: { expectedRevision } };
  }
  const body: Record<string, unknown> = { action, expectedRevision };
  if (logId) body.logId = logId;
  if (action === "recheck" || action === "force-create") {
    return { url: `/api/feedback/${id}/resolve`, body };
  }
  return { url: `/api/feedback/${id}/recover`, body };
}
