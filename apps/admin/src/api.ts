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
  patch: <T>(url: string, body?: unknown) => req<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => req<T>("DELETE", url),
};

// ---------- 类型 ----------

export interface FeedbackListItem {
  id: string;
  appId: string;
  username?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  kaneoUrl?: string | null;
  errorSummary?: string | null;
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
  /** 待处理的日志附件 ID 列表（供 retry_log 使用）。 */
  pendingLogIds?: string[];
}

export interface FeedbackLogMeta {
  id: string;
  feedbackId: string;
  sortOrder: number;
  filename: string;
  source: "auto" | "manual";
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface FeedbackDetail extends FeedbackListItem {
  text: string;
  context: { appVersion?: string; pageLabel?: string } | null;
  processed: {
    title: string;
    sections: { experience: string; problems: string; suggestions: string; questions: string };
  } | null;
  kaneoTaskId: string | null;
  attemptCount: number;
  lastError: string | null;
  recovery?: FeedbackRecovery | null;
  screenshot?: FeedbackScreenshotMeta | null;
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

/** 普通账号（账号页面只管理普通账号；响应绝不包含口令或哈希）。 */
export interface AccountItem {
  id: string;
  username: string;
  enabled: boolean;
  dailyLimit: number;
  used: number;
  remaining: number;
  resetAt: string;
  createdAt: string;
}

export interface KaneoTestResult {
  ok: boolean;
  project?: { id: string; name: string; workspaceId: string; slug: string };
  columns?: { id: string; slug: string; name: string }[];
  reason?: string;
}

/** 当前会话账号（GET /api/auth/session 的 user 字段；绝不包含口令或哈希）。 */
export interface SessionUser {
  id: string;
  username: string;
  role: string;
}

// ---------- U1-4：后台「系统更新」 ----------

/** 检查状态：ok=有新版本 / up_to_date=已是最新 / incompatible=执行器协议不兼容 / failed=检查失败 / never=尚未检查 */
export type UpdateCheckState = "ok" | "up_to_date" | "incompatible" | "failed" | "never";

export interface UpdateCheckView {
  state: UpdateCheckState;
  checkedAt: string | null;
  source: string | null;
  latest: {
    version: string;
    notes: string | null;
    publishedAt: string | null;
    digest: string | null;
    image: string | null;
    requiredUpdaterProtocol: number | null;
  } | null;
  compatible: boolean;
  requiredProtocol: number | null;
  supportedProtocol: number;
  guidance: string | null;
  failedCode: string | null;
  failedMessage: string | null;
  warnings: string[];
}

export interface UpdateOperationView {
  operationId: string;
  requestId: string | null;
  version: string | null;
  digest: string | null;
  status: string;
  outcome: string | null;
  /** 「更新失败，已恢复旧版本」/「需要处理」等终态文案（服务端给出）。 */
  outcomeLabel: string | null;
  phase: string;
  phaseLabel: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failure: { phase: string; code: string; message: string } | null;
  recoveryHint: string | null;
  warnings: string[];
  evidence: { at: string; phase: string; step: string; ok: boolean; detail?: string }[];
}

export interface UpdatePauseState {
  paused: boolean;
  since: string | null;
  marker: {
    phase: string | null;
    phaseLabel: string | null;
    message: string | null;
    operationId: string | null;
    version: string | null;
    updatedAt: string | null;
    parseError: string | null;
  } | null;
}

export interface SystemUpdateStatus {
  current: { version: string; protocol: number };
  config: {
    updateConfigured: boolean;
    updaterBaseUrl: string | null;
    tokenFile: string | null;
    controlDir: string | null;
    protocolSupported: number;
    checkIntervalMs: number;
  };
  pause: UpdatePauseState;
  check: UpdateCheckView;
  recentOperations: UpdateOperationView[];
}

/** 任务查询结果：unreachable **不等于** 失败（服务重启期间取不到进度属正常过程）。 */
export type UpdateOperationResult =
  | { status: "known"; fromControlDir: boolean; operation: UpdateOperationView }
  | { status: "unknown"; operationId: string }
  | { status: "unreachable"; operationId: string; error: { code: string; message: string } };

export const STATUS_LABELS: Record<string, string> = {
  received: "已接收",
  processing: "处理中",
  archiving: "归档中",
  needs_review: "待核对",
  archived: "已归档",
  failed: "失败",
};
