/** 轻量 API 客户端：所有请求同源携带 cookie；错误抛出带 code/message 的 ApiError。 */

import { type DiagnosticCode, diagnosticsEpoch, recordDiagnostic } from "./diagnostics.ts";

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

/**
 * 服务端错误码 → 诊断 code 的白名单映射（Feedback-3）。
 * 只映射已知 code；未列出的按 status 归 server_error/unknown。
 * 绝不把 ApiError.message、URL 或请求/响应正文记入诊断。
 */
const DIAG_CODE_MAP: Record<string, DiagnosticCode> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "not_found",
  unknown_app: "not_found",
  unknown_origin: "forbidden",
  invalid_request: "invalid_request",
  version_conflict: "version_conflict",
  conflict: "conflict",
  app_exists: "app_exists",
  incomplete_rule: "incomplete_rule",
  invalid_rule: "invalid_rule",
  invalid_state: "invalid_state",
  kaneo_unavailable: "kaneo_unavailable",
  daily_quota_exceeded: "daily_quota_exceeded",
  rate_limited: "rate_limited",
};

function diagCodeFor(err: ApiError): DiagnosticCode {
  const mapped = DIAG_CODE_MAP[err.code];
  if (mapped) return mapped;
  switch (err.status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return err.status >= 500 ? "server_error" : "unknown";
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  // 请求开始时固定诊断世代：响应到达时若已换代（退出/换账号），整条丢弃。
  const epoch = diagnosticsEpoch();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // fetch 层失败（断网/中止）：只记网络类事件，不记异常文本。
    recordDiagnostic({ level: "warn", event: "api_request", code: "network" }, epoch);
    throw e;
  }
  let data: unknown = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } })?.error;
    const err = new ApiError(e?.code ?? `http_${res.status}`, e?.message ?? text.slice(0, 200), res.status);
    recordDiagnostic({ level: "warn", event: "api_request", code: diagCodeFor(err), status: res.status }, epoch);
    throw err;
  }
  recordDiagnostic({ level: "info", event: "api_request", code: "ok", status: res.status }, epoch);
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
/** Issue 沟通状态 */
export type IssueStatus = "open" | "waiting_user" | "waiting_admin" | "resolved";

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
  /** ---- v11 对话与未读 ---- */
  issueStatus?: IssueStatus;
  dialogueVersion?: number;
  archiveRound?: number;
  lastActivityAt?: string;
  unread?: boolean;
  messageCount?: number;
  /** 最近一条消息摘要（服务端聚合字段，v11 起返回）。 */
  latestMessageText?: string | null;
  latestMessageAt?: string | null;
  /** ---- v12 ---- */
  /** 初始反馈图片张数（含历史单图兼容读取）；缺失时按 hasScreenshot 展示。 */
  imageCount?: number;
  /** 处理说明：标记已解决时必填并持久化（1..2000 字符），对用户可见。 */
  resolutionNote?: string | null;
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
  /** v12 起附带声明格式（旧记录缺省按 image/png 处理）。 */
  mime?: "image/png" | "image/jpeg" | "image/webp" | string;
  capture: {
    viewportWidth?: number;
    viewportHeight?: number;
    /** 最终 PNG 实际输出像素（线格式定稿命名）。 */
    pixelWidth?: number;
    pixelHeight?: number;
    capturedAt?: string;
    releasePoint?: { x: number; y: number };
    /** 局部截图区域：0..1 归一化，相对原始捕获视口；缺省表示整窗（服务端冻结契约）。 */
    region?: { x: number; y: number; width: number; height: number };
  } | null;
  createdAt: string;
}

/** v12 初始反馈图片元数据（feedback_images 子表；历史单图经兼容读取进入同一列表）。 */
export interface FeedbackImageMeta {
  id: string;
  /** 有序列表下标（保序展示）。 */
  sort: number;
  /**
   * 图片来源标记：服务端为 capture=自动截图 / manual=手动添加 / edited=已编辑；
   * 历史客户端值 auto/screenshot 兼容保留，历史单图记录为 null/缺省。
   */
  source?: "auto" | "manual" | string | null;
  mime: string;
  filename?: string | null;
  byteSize: number;
  sha256?: string;
  width?: number | null;
  height?: number | null;
  /**
   * v12 捕获元数据（服务端按需解析 capture_json，旧截图兼容行透传 screenshot.capture；
   * 解析失败只丢该字段，图片本体不受影响）。
   */
  capture?: {
    viewportWidth?: number;
    viewportHeight?: number;
    capturedAt?: string;
    releasePoint?: { x: number; y: number };
    pixelWidth?: number;
    pixelHeight?: number;
    /** 局部截图区域：0..1 归一化，相对原始捕获视口；缺省表示整窗。 */
    region?: { x: number; y: number; width: number; height: number };
  };
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
  /** v12：初始反馈有序图片列表（含历史单图兼容读取，sort 保序）。 */
  images?: FeedbackImageMeta[] | null;
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
  createdAt: string;
  /** 最近一次保存时间（规则版本摘要展示用）。 */
  updatedAt: string;
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

/** 服务端能力探测（GET /api/features 与 /api/auth/session 的 capabilities 字段）。 */
export interface ServerCapabilities {
  /** v11：Issue 对话闭环。 */
  dialogue?: boolean;
  /** v12：最大图片数；缺失（旧服务）时客户端保持单图模式并提示升级。 */
  images?: number;
}

/** GET /api/auth/session 响应包络。 */
export interface SessionResponse {
  authenticated?: boolean;
  kind?: string;
  expiresAt?: string;
  user?: SessionUser;
  quota?: unknown;
  capabilities?: ServerCapabilities;
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

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: "新反馈",
  waiting_user: "待用户补充",
  waiting_admin: "待管理处理",
  resolved: "已解决",
};

/** 工单状态主标签配色（列表与详情共用）：待管理处理=警示黄、已解决=成功绿，其余=信息蓝。 */
export function issueTone(s?: IssueStatus): string {
  if (s === "waiting_admin") return "tone-warn";
  if (s === "resolved") return "tone-ok";
  return "tone-info";
}

export interface FeedbackMessageAttachment {
  id: string;
  /** v12 新增 "image"：用户回复图片（带 mime/width/height）。 */
  kind: "screenshot" | "log" | "image";
  filename: string;
  byteSize: number;
  sha256: string;
  /** 附件内容类型（image 附件按 mime 返回 image/*；旧记录缺省）。 */
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  createdAt: string;
}

export interface FeedbackMessage {
  id: string;
  seq: number;
  senderType: "user" | "admin" | "system";
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
  attachments: FeedbackMessageAttachment[];
  /** v12：随状态变更/回复持久化的处理说明（标记已解决时必填，对用户可见）。 */
  resolutionNote?: string | null;
}

export interface KaneoCancellationTask {
  id: string;
  feedback_id: string;
  archive_round: number;
  kaneo_task_id: string;
  target_api_base?: string | null;
  /** v12：存量 pending/processing 任务经迁移标记 cancelled（停止派发，行与审计保留）。 */
  status: "pending" | "processing" | "confirmed" | "uncertain" | "failed" | "cancelled";
  attempts: number;
  last_error?: string | null;
  next_attempt_at?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackDialogueResponse {
  feedback: {
    id: string;
    appId: string;
    title?: string | null;
    text: string;
    status: string;
    issueStatus: IssueStatus;
    dialogueVersion: number;
    archiveRound: number;
    mgmtState: MgmtView;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
    kaneoTaskId?: string | null;
    kaneoTaskUrl?: string | null;
    /** v12：初始反馈有序图片列表（详情接口未返回时作兼容回退）。 */
    images?: FeedbackImageMeta[] | null;
    /** v12：处理说明（标记已解决时随状态变更持久化）。 */
    resolutionNote?: string | null;
  };
  messages: FeedbackMessage[];
  lastReadSeq: number;
  cancellation?: KaneoCancellationTask | null;
}

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
  issue_status_updated: "更新工单状态",
  issue_status_change: "更新工单状态",
  admin_message: "管理员回复",
  kaneo_cancellation_enqueued: "登记 Kaneo 撤销任务",
  kaneo_task_cancelled: "旧 Kaneo 任务已删除",
  kaneo_cancellation_cancelled: "v12 升级停止派发 Kaneo 撤销任务",
  kaneo_cancellation_manual_retry: "手动重试 Kaneo 撤销",
};
