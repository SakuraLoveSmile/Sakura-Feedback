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

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(e?.code ?? `http_${res.status}`, e?.message ?? text.slice(0, 200), res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body?: unknown) => req<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => req<T>("PUT", url, body ?? {}),
  del: <T>(url: string) => req<T>("DELETE", url),
};

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
  /** 该反馈的日志份数（服务端列表项提供；无日志为 0）。 */
  logCount?: number;
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
}

export interface FeedbackDetail extends FeedbackListItem {
  text: string;
  context: { appVersion?: string; pageLabel?: string } | null;
  processed: {
    title: string;
    sections: { experience: string; problems: string; suggestions: string; questions: string };
    /** 日志诊断（可选）：旧记录与未参与日志整理的记录缺省，展示层必须兼容缺省。 */
    diagnostics?: FeedbackDiagnostics | null;
  } | null;
  kaneoTaskId: string | null;
  attemptCount: number;
  lastError: string | null;
  recovery?: FeedbackRecovery | null;
  screenshot?: FeedbackScreenshotMeta | null;
  /** 日志份数（恒存在；无日志为 0）。 */
  logCount: number;
  /** 日志元数据（按 `seq` 升序；无日志为 `[]`）。 */
  logs: FeedbackLogMeta[];
}

/** 日志来源：`auto` = 宿主回调自动采集；`manual` = 用户在面板手动补充。 */
export type FeedbackLogSource = "auto" | "manual";

/** 单份日志的归档确认进度（`allAttachmentsConfirmed` 按日志拆开的展示投影）。 */
export type FeedbackLogArchiveState = "not_started" | "partial" | "confirmed";

/** `GET /api/admin/feedback/:id` 的 `logs[]` 项（绝不包含任何公开链接）。 */
export interface FeedbackLogMeta {
  id: string;
  feedbackId: string;
  /** 0 起序号，等于提交顺序与归档顺序。 */
  seq: number;
  /** 服务端清洗后的安全文件名。 */
  filename: string;
  source: FeedbackLogSource;
  byteSize: number;
  sha256: string;
  createdAt: string;
  /** 按「末尾 8000 码点」规则该份日志送 AI 时是否会被截取（与是否真送过 AI 无关）。 */
  truncated: boolean;
  /** 该份日志按解码规则得到的总 Unicode 码点数。 */
  totalCodepoints: number;
  /** 该份日志在归档存档数据中的附件确认进度。 */
  archiveState: FeedbackLogArchiveState;
}

/** 模型摘录的日志证据：提示词要求逐字摘录，但服务端不逐字校验。 */
export interface LogEvidenceItem {
  /** 归属用的 0 起日志序号（同名日志据此区分）；`filename` 仅作展示。 */
  seq?: number;
  filename: string;
  quote: string;
}

/** 未证实的可能原因：必须带 confidence（只允许 low / medium）。 */
export interface LogSpeculationItem {
  hypothesis: string;
  confidence: "low" | "medium";
  basedOn?: string;
}

/**
 * 日志诊断。`logEvidence` 与 `possibleCauses` 分属两个字段，展示层必须视觉分开。
 * 两个数组在读取侧都按可选处理：旧记录（或字段非法被丢弃的记录）不得导致渲染报错。
 */
export interface FeedbackDiagnostics {
  logEvidence?: LogEvidenceItem[] | null;
  possibleCauses?: LogSpeculationItem[] | null;
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

/** 日志来源展示串（数据属性里始终保留原始值 auto / manual）。 */
export const LOG_SOURCE_LABELS: Record<string, string> = {
  auto: "自动采集",
  manual: "手动补充",
};

/** 单份日志归档进度展示串（数据属性里始终保留原始值 not_started / partial / confirmed）。 */
export const LOG_ARCHIVE_STATE_LABELS: Record<string, string> = {
  not_started: "未开始",
  partial: "进行中",
  confirmed: "已完成",
};

/** 推测置信度展示串（只允许 low / medium）。 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
};
