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

/** 本地管理区域（与处理状态 status 完全分离）。 */
export type MgmtView = "inbox" | "archived" | "trash";
/** 生命周期动作（服务端同一入口处理单条与批量）。 */
export type LifecycleAction = "archive" | "unarchive" | "trash" | "restore" | "resume_processing" | "purge";

export interface FeedbackListItem {
  id: string;
  appId: string;
  /** 软件显示名（已删除软件仍返回名称）。 */
  appName?: string | null;
  /** 该反馈关联的软件记录已被删除（历史数据仍保留，仅配置失效）。 */
  appDeleted?: boolean;
  username?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  /** 正文摘要（标题缺失时的回退展示，不含错误信息）。 */
  textPreview?: string | null;
  kaneoUrl?: string | null;
  errorSummary?: string | null;
  hasScreenshot?: boolean;
  logCount?: number;
  /** 该反馈当前卡在哪一步（等待配置 / 等待来源确认 / 等待人工分类 / 已排队）。 */
  collectionState?: CollectionState;
  sourceOrigin?: string;
  archiveAuthorized?: boolean;
  archiveAuthorizedKind?: "manual" | "auto" | null;
  autoBlockedKind?: "retryable" | "config" | null;
  autoBlockedReason?: string | null;
  autoNextAttemptAt?: string | null;
  /** ---- 本地管理生命周期 ---- */
  mgmtState: MgmtView;
  lifecycleVersion: number;
  resumePaused?: boolean;
  archivedAt?: string | null;
  trashedAt?: string | null;
  /** 当前可用的生命周期动作（服务端口径）。 */
  availableActions?: LifecycleAction[];
}

export interface LifecycleItemResult {
  id: string;
  ok: boolean;
  code?: string;
  message?: string;
  mgmtState?: MgmtView;
  lifecycleVersion?: number;
  purged?: boolean;
  alreadyPurged?: boolean;
}

export interface LifecycleBatchResponse {
  ok: boolean;
  action: LifecycleAction;
  results: LifecycleItemResult[];
}

export interface FeedbackCounts {
  inbox: number;
  archived: number;
  trash: number;
}

export interface FeedbackAppOption {
  appId: string;
  name: string;
  deleted: boolean;
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

/** 人工分类（T1/T2）：项目、目标列、工作区标签、可选负责人与分类版本。 */
export interface FeedbackClassification {
  projectId: string | null;
  columnId: string | null;
  columnSlug: string | null;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FeedbackAuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown> | null;
}

/** Kaneo 分类选项（GET /api/admin/feedback/options）。 */
export interface ClassifyOptions {
  project: { id: string; name: string; workspaceId: string };
  columns: { id: string; slug: string; name: string }[];
  /** 只有工作区级标签才会返回（避免移动其他任务的标签）。 */
  labels: { id: string; name: string; color: string }[];
  members: { id: string; name: string; email: string; role: string }[];
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
  classification?: FeedbackClassification | null;
  classificationLocked?: boolean;
  archiveAuthorized?: boolean;
  archiveAuthorizedAt?: string | null;
  archiveOperationId?: string | null;
  /** 回收站记录为只读（禁止分类、同步、重试与附件重传）。 */
  readOnly?: boolean;
  audit?: FeedbackAuditEntry[] | null;
  /** 该反馈的收集状态（等待配置 / 等待来源确认 / 等待人工归档 / 已排队）。 */
  collectionState?: CollectionState;
  /** 服务端观察到的来源；空表示历史数据来源无法确定。 */
  sourceOrigin?: string;
  archiveAuthorizedKind?: "manual" | "auto" | null;
  archiveRuleVersion?: number | null;
  /** 自动归档阻塞：retryable=可恢复（有退避重试），config=配置问题（等待管理员修正）。 */
  autoBlockedKind?: "retryable" | "config" | null;
  autoBlockedReason?: string | null;
  autoAttempts?: number;
  autoNextAttemptAt?: string | null;
  app?: {
    id: string;
    appId: string;
    name: string;
    configStatus: "pending" | "configured";
    archiveMode: "manual" | "automatic";
    ruleVersion: number;
    /** 非空表示关联的软件记录已软删除（配置失效，历史数据保留）。 */
    deletedAt?: string | null;
  } | null;
}

/** 软件默认归档目标（自动归档规则的来源）。 */
export interface AppDefaults {
  projectId: string;
  columnId: string;
  columnSlug: string;
  labelIds: string[];
  assigneeId: string | null;
  assigneeName: string | null;
}

export interface AppItem {
  id: string;
  appId: string;
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
  /** ---- 先接收后配置 / 自动归档 ---- */
  /** admin=管理员设置的名称（客户端不可覆盖），client=组件上报。 */
  nameSource: "client" | "admin";
  /** pending=自动发现后待配置；configured=管理员已配置。 */
  configStatus: "pending" | "configured";
  archiveMode: "manual" | "automatic";
  /** 规则版本：默认目标或归档模式变化时自增（并发与页面过期检查）。 */
  ruleVersion: number;
  defaults: AppDefaults;
  /** 规则是否完整（项目 + 目标列 + ≥1 工作区标签）。 */
  ruleComplete: boolean;
  autoEnabledAt: string | null;
  autoEnabledBy: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  pendingSources: number;
  confirmedSources: number;
  /** 尚未获得归档授权、也尚无远端任务的反馈条数。 */
  waitingFeedbacks: number;
}

/** 软件来源：服务端观察到的浏览器 Origin，或无 Origin 原生客户端的 native。 */
export interface AppSourceItem {
  origin: string;
  kind: "browser" | "native";
  status: "pending" | "confirmed";
  firstSeenAt: string;
  lastSeenAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

export interface AppDetail {
  app: AppItem;
  sources: AppSourceItem[];
}

/** 组件侧展示的收集状态（管理页据此解释“为什么还没归档”）。 */
export type CollectionState =
  | "waiting_configuration"
  | "waiting_source_confirmation"
  | "waiting_manual_archive"
  | "queued";

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

// ---------- 后台「检查更新」（v0.5.1 起只检查不安装） ----------

/** 检查状态：ok=有新版本 / up_to_date=已是最新 / failed=检查失败 / never=尚未检查 */
export type UpdateCheckState = "ok" | "up_to_date" | "failed" | "never";

export interface UpdateCheckView {
  state: UpdateCheckState;
  checkedAt: string | null;
  /** 检查来源（版本清单地址）。 */
  source: string | null;
  latest: {
    version: string;
    tag: string | null;
    notes: string | null;
    publishedAt: string | null;
    digest: string | null;
    image: string | null;
    /** 该版本的 Release 页面链接（服务端按清单地址推导）。 */
    releaseUrl: string | null;
  } | null;
  failedCode: string | null;
  failedMessage: string | null;
}

export interface SystemUpdateStatus {
  current: { version: string };
  config: {
    /** 版本清单地址；null 表示检查功能被显式关闭。 */
    manifestUrl: string | null;
    checkIntervalMs: number;
  };
  check: UpdateCheckView;
}

export const STATUS_LABELS: Record<string, string> = {
  received: "已接收",
  processing: "处理中",
  needs_info: "待人工分类",
  ready_to_archive: "待同步",
  archiving: "同步中",
  needs_review: "待核对",
  archived: "已同步",
  failed: "失败",
};

/** 管理区域文案（与处理状态分离：归档指本地整理动作）。 */
export const VIEW_LABELS: Record<MgmtView, string> = {
  inbox: "收件箱",
  archived: "已归档",
  trash: "回收站",
};

/** 审计动作文案（详情页展示）。 */
export const AUDIT_LABELS: Record<string, string> = {
  classify_save: "保存分类",
  archive_authorize: "同步授权",
  archive_enqueued: "入队同步",
  retry: "重试处理",
  recheck: "重新核对",
  force_create: "确认缺失后再次创建",
  retry_comment: "重试截图评论",
  replace_upload: "替换截图上传",
  retry_log: "重试日志上传",
  mgmt_archive: "归档",
  mgmt_unarchive: "恢复到收件箱",
  mgmt_trash: "移入回收站",
  mgmt_restore: "从回收站恢复",
  mgmt_resume: "恢复处理",
  mgmt_purge: "彻底删除",
};
