/** 轻量 API 客户端：所有请求同源携带 cookie；错误抛出带 code/message 的 ApiError。 */

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把一次失败响应（JSON 错误体或纯文本）归一为带 code/message 的 ApiError。 */
function errorFrom(res: Response, data: unknown, text: string): ApiError {
  const e = (data as { error?: { code?: string; message?: string } })?.error;
  const message = e?.message ?? (text.slice(0, 200) || res.statusText || `HTTP ${res.status}`);
  return new ApiError(e?.code ?? `http_${res.status}`, message, res.status);
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = safeJson(text);
  if (!res.ok) throw errorFrom(res, data, text);
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body?: unknown) => req<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => req<T>("PUT", url, body ?? {}),
  del: <T>(url: string) => req<T>("DELETE", url),
};

// ---------- 日志附件读取/下载（契约 docs/logs-plan.md §3.3） ----------

/** 管理端日志读取地址；download=true 时带上 ?download=1（attachment）。 */
export function logUrl(feedbackId: string, logId: string, download = false): string {
  const base = `/api/admin/feedback/${encodeURIComponent(feedbackId)}/logs/${encodeURIComponent(logId)}`;
  return download ? `${base}?download=1` : base;
}

/** 从 content-disposition 里取文件名（兼容 filename* 形式）。 */
export function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (star?.[1]) {
    const raw = star[1]
      .trim()
      .replace(/^UTF-8''/i, "")
      .replace(/^"|"$/g, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(value);
  return (plain?.[2] ?? plain?.[3] ?? "").trim() || null;
}

/**
 * 读取日志原文用于预览。同源 cookie 鉴权；失败时抛 ApiError（绝不静默失败）。
 * 调用方必须把返回文本当作文本节点渲染。
 */
export async function fetchLogText(feedbackId: string, logId: string): Promise<string> {
  const res = await fetch(logUrl(feedbackId, logId), { credentials: "same-origin" });
  const text = await res.text();
  if (!res.ok) throw errorFrom(res, safeJson(text), text);
  return text;
}

/**
 * 下载日志附件：先经 fetch 校验响应，成功后才触发本地下载，
 * 这样 4xx/5xx 能走和其它操作一样的可读错误提示，而不是静默下载一个错误页。
 */
export async function downloadLog(feedbackId: string, log: { id: string; name: string }): Promise<void> {
  const res = await fetch(logUrl(feedbackId, log.id, true), { credentials: "same-origin" });
  if (!res.ok) {
    const text = await res.text();
    throw errorFrom(res, safeJson(text), text);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filenameFromDisposition(res.headers.get("content-disposition")) ?? log.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ---------- 类型 ----------

export interface FeedbackListItem {
  id: string;
  appId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  kaneoUrl?: string | null;
  errorSummary?: string | null;
  /** 该反馈的日志附件数量（契约 §3.1）；兼容尚未升级的服务端（可能缺失）。 */
  logCount?: number;
}

/** 单份日志附件的元数据（契约 §3.2）。 */
export interface FeedbackLogMeta {
  id: string;
  name: string;
  /** "auto"（首次打开自动采集）或 "manual"（用户手动添加）。 */
  source: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  ordinal: number;
}

/** AI 诊断（契约 §5.2）；旧结果没有该字段。 */
export interface FeedbackDiagnostics {
  logEvidence?: string | null;
  possibleCauses?: string | null;
  speculation?: string | null;
}

export interface FeedbackProcessed {
  title: string;
  sections: { experience: string; problems: string; suggestions: string; questions: string };
  /** 有日志时的诊断结果；旧结果缺失该字段。 */
  diagnostics?: FeedbackDiagnostics | null;
}

export interface FeedbackScreenshotMeta {
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  capture: {
    viewportWidth?: number;
    viewportHeight?: number;
    /** 最终 PNG 实际输出像素（线格式定稿命名）。 */
    pixelWidth?: number;
    pixelHeight?: number;
    capturedAt?: string;
    releasePoint?: { x: number; y: number };
  } | null;
  createdAt: string;
}

export interface FeedbackRecovery {
  revision: number;
  stage: string | null;
  uploadOutcome: string | null;
  assetKnown: boolean;
  commentOutcome: string | null;
  /** 该记录是否存有本地截图（replace_upload 据此在资产未知时也可用）。 */
  hasScreenshot: boolean;
  /** 当前允许的人工动作（管理页据此只渲染可用按钮）。 */
  allowedActions: string[];
  /** 动作目标说明（针对图片/评论/任务/流程）。 */
  actionTargets: Record<string, string>;
  /** 动作风险说明：点击前展示给操作人（如 retry_comment 仍可能产生重复评论）。 */
  actionNotes: Record<string, string>;
  /**
   * 日志级恢复状态。服务端字段尚未冻结（并行开发中，见 docs/logs-plan.md §3.4）：
   * 因此这里按 `unknown` 接收，管理页用 logs.ts 的 pickLogRecovery 做防御式解析；
   * 缺失或结构不符时安全降级为「不显示日志级恢复按钮」，不影响截图恢复。
   */
  logs?: unknown;
  /** 兼容另一种可能的命名（同样防御式解析）。 */
  logStates?: unknown;
}

export interface FeedbackDetail extends FeedbackListItem {
  text: string;
  context: { appVersion?: string; pageLabel?: string } | null;
  processed: FeedbackProcessed | null;
  kaneoTaskId: string | null;
  attemptCount: number;
  lastError: string | null;
  recovery?: FeedbackRecovery | null;
  screenshot?: FeedbackScreenshotMeta | null;
  /** 日志附件列表（契约 §3.2）；老服务端可能缺失。 */
  logs?: FeedbackLogMeta[] | null;
}

export interface AppItem {
  id: string;
  appId: string;
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
}

export interface SessionItem {
  id: string;
  kind: string;
  clientLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface KaneoTestResult {
  ok: boolean;
  project?: { id: string; name: string; workspaceId: string; slug: string };
  columns?: { id: string; slug: string; name: string }[];
  reason?: string;
}

export const STATUS_LABELS: Record<string, string> = {
  received: "已接收",
  processing: "处理中",
  archiving: "归档中",
  needs_review: "待核对",
  archived: "已归档",
  failed: "失败",
};
