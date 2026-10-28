/** HTTP 契约客户端（docs/api.md v1）。运行时零依赖，仅使用 fetch。 */

export type FeedbackStatus =
  | 'received'
  | 'processing'
  | 'archiving'
  | 'archived'
  | 'needs_review'
  | 'failed';

export interface FeedbackContext {
  appVersion?: string;
  pageLabel?: string;
}

/**
 * T1 局部截图选区：0..1 归一化，**相对原始捕获视口**（即 viewportWidth/Height
 * 描述的那个视口），恒有 x+width≤1、y+height≤1。
 * 整窗截图省略该字段（与旧客户端一致）；`pixelWidth/Height` 表示选区裁剪后的
 * 最终输出像素，`viewportWidth/Height` 仍为原始捕获视口语义。
 */
export interface FeedbackCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FeedbackCaptureInfo {
  /** 逻辑视口尺寸（CSS 像素）。 */
  viewportWidth?: number;
  viewportHeight?: number;
  /** 截图输出位图尺寸（物理像素），与逻辑视口区分（实施计划 2.3；两端统一字段名）。 */
  pixelWidth?: number;
  pixelHeight?: number;
  capturedAt?: string;
  releasePoint?: { x: number; y: number };
  /** 局部截图时的归一化选区；整窗截图省略。 */
  region?: FeedbackCaptureRegion;
}

export interface FeedbackLogAttachment {
  filename: string;
  source: 'auto' | 'manual';
  blob: Blob;
  byteSize?: number;
  sha256?: string;
}

/** v12 图片来源（写入 metadata.images[].source）。 */
export type FeedbackImageSource = 'capture' | 'manual' | 'edited';

/** v12 有序图片描述符：与 multipart `images` 部件按顺序一一对应。 */
export interface FeedbackImageDescriptor {
  /** 客户端生成的稳定 ID（1..64 字符，同一次提交内唯一）；编辑替换内容时 ID 可复用。 */
  id: string;
  source: FeedbackImageSource;
  filename: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** 待提交图片（描述符之外的二进制内容）。 */
export interface FeedbackImageInput {
  id: string;
  source: FeedbackImageSource;
  filename: string;
  blob: Blob;
}

export interface FeedbackSubmitPayload {
  idempotencyKey: string;
  appId: string;
  /** 可选：组件上报的软件名称（服务端仅在管理员未设置名称时采用）。 */
  appName?: string;
  text: string;
  context?: FeedbackContext;
  capture?: FeedbackCaptureInfo;
  screenshot?: Blob;
  /** v12：有序图片列表（≤5，与 `screenshot` 互斥）。 */
  images?: FeedbackImageInput[];
  logs?: FeedbackLogAttachment[];
}

export interface FeedbackSubmitResponse {
  feedbackId: string;
  status: FeedbackStatus;
  replayed?: boolean;
  user?: AuthUser;
  quota?: Quota;
  /** T4：反馈已保存，等待管理员配置 / 确认来源 / 人工归档，或已进入归档流程。 */
  collectionState?: CollectionState;
}

/**
 * 组件侧「已保存、等待什么」状态（旧服务端不返回该字段，缺省即可忽略）。
 * 等待态不是失败：组件应提示已保存，并停止无意义的轮询。
 */
export type CollectionState =
  | 'waiting_configuration'
  | 'waiting_source_confirmation'
  | 'waiting_manual_archive'
  | 'queued';

/** 等待态的中文提示（queued 与未知状态返回 null，按原有“整理中”展示）。 */
export function collectionWaitingText(state?: CollectionState): string | null {
  switch (state) {
    case 'waiting_configuration':
      return '反馈已保存，等待管理员配置该软件。';
    case 'waiting_source_confirmation':
      return '反馈已保存，等待管理员确认来源。';
    case 'waiting_manual_archive':
      return '反馈已保存，等待管理员归档。';
    default:
      return null;
  }
}

/** 已登录账号的最小信息（服务端不返回密码或哈希）。 */
export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/** 普通账号的每日提交额度（数值形态；unlimited 缺省即 false）。 */
export interface LimitedQuota {
  unlimited?: false;
  dailyLimit: number;
  used: number;
  remaining: number;
  /** 下次额度刷新时间（北京时间次日零点，ISO-8601 UTC）。 */
  resetAt: string;
}

/** 管理员账号的每日提交额度：不受次数限制（不返回 dailyLimit / remaining 数值）。 */
export interface UnlimitedQuota {
  unlimited: true;
  used: number;
  /** 下次额度刷新时间（北京时间次日零点，ISO-8601 UTC）。 */
  resetAt: string;
}

/** 每日提交额度（服务端按北京时间日切分）：管理员为不限形态，普通账号为数值形态。 */
export type Quota = LimitedQuota | UnlimitedQuota;

export interface LoginResponse {
  ok: boolean;
  token: string;
  expiresAt: string;
  user: AuthUser;
  /** 额度（双形态之一）；无法解析的形态归一为缺省——组件据此隐藏额度行。 */
  quota?: Quota;
  /** v12：服务端能力声明（如 `{ dialogue: true, images: 5 }`）。 */
  capabilities?: FeedbackCapabilities;
}

/**
 * v12 服务端能力：`images` 为多图附件上限（≤5 之外的值按服务端声明取信）；
 * 旧服务端无此字段（或不返回 `capabilities`）→ `undefined`，组件保持单图模式并提示升级。
 */
export interface FeedbackCapabilities {
  dialogue?: boolean;
  images?: number;
}

export interface SessionResponse {
  authenticated: boolean;
  kind?: string;
  clientLabel?: string | null;
  expiresAt: string;
  user: AuthUser;
  /** 额度（双形态之一）；无法解析的形态归一为缺省——组件据此隐藏额度行。 */
  quota?: Quota;
  /** v12：服务端能力声明（如 `{ dialogue: true, images: 5 }`）。 */
  capabilities?: FeedbackCapabilities;
}

export interface FeedbackRecord {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  errorSummary?: string | null;
  kaneoUrl?: string | null;
  /** T4：等待配置 / 等待来源确认 / 等待人工归档 / 已排队；旧服务端可能不返回。 */
  collectionState?: CollectionState;
}

/** 契约统一错误：`{ error: { code, message } }`；message 可安全展示。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 429 daily_quota_exceeded 等错误体携带的同结构额度（若有）。 */
  readonly quota?: Quota;
  constructor(status: number, code: string, message: string, quota?: Quota) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.quota = quota;
  }
}

export function joinApi(apiBase: string, path: string): string {
  const base = apiBase.replace(/\/+$/, '');
  return `${base}${path}`;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 客户端生成的幂等键（UUID v4 形态，≤200 字符）。 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const h = randomHex(16).split('');
  h[12] = '4'; // version
  const v = parseInt(h[16] ?? '0', 16);
  h[16] = (((v & 0b0011) | 0b1000)).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** 握手 nonce：32 hex 字符。 */
export function randomNonce(): string {
  return randomHex(16);
}

/** 宽松解析 capabilities.images：正整数取信（封顶 5），其余形态一律视为「缺失」。 */
export function parseCapabilities(raw: unknown): FeedbackCapabilities | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const out: FeedbackCapabilities = {};
  if (c.dialogue === true) out.dialogue = true;
  if (typeof c.images === 'number' && Number.isFinite(c.images) && c.images >= 1) {
    out.images = Math.min(5, Math.floor(c.images));
  }
  return out;
}

/** Blob 内容的 SHA-256（小写十六进制，64 字符）。 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseQuota(raw: unknown): Quota | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const q = raw as Record<string, unknown>;
  if (q.unlimited === true) {
    if (typeof q.used !== 'number' || typeof q.resetAt !== 'string') return undefined;
    return { unlimited: true, used: q.used, resetAt: q.resetAt };
  }
  if (
    typeof q.dailyLimit !== 'number' ||
    typeof q.used !== 'number' ||
    typeof q.remaining !== 'number' ||
    typeof q.resetAt !== 'string'
  ) {
    return undefined;
  }
  return { dailyLimit: q.dailyLimit, used: q.used, remaining: q.remaining, resetAt: q.resetAt };
}

function throwFromResponse(status: number, data: unknown): never {
  const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
  throw new ApiError(
    status,
    err?.code ?? `http_${status}`,
    err?.message ?? `HTTP ${status}`,
    parseQuota((data as { quota?: unknown } | null)?.quota),
  );
}

/** 会话查询超时（与 Flutter 端 `_requestTimeout` 一致）；仅用于会话查询。 */
const SESSION_TIMEOUT_MS = 20_000;

/** 与 DOM fetch 兼容的最小签名（见 diagnostics.wrapFetch）。 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function request<T>(
  apiBase: string,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  // 仅会话查询带超时（T1-B2）：超时 abort 使请求以 AbortError reject，
  // 调用方按既有失败规则处理（释放占用 + 30 秒重试）。提交 / 轮询不带。
  const controller = typeof options.timeoutMs === 'number' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs as number)
    : null;
  try {
    const res = await (options.fetchFn ?? fetch)(joinApi(apiBase, path), {
      method,
      headers,
      body,
      credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throwFromResponse(res.status, data);
    return data as T;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 组件在宿主面板内登录：`POST /api/auth/login`（令牌模式）。
 * 显式携带 clientLabel 与 appId，由服务端按该应用允许来源校验浏览器 Origin；
 * 令牌仅存内存，密码不持久化。响应含 user 与 quota。
 */
export async function login(
  apiBase: string,
  input: { username: string; password: string; clientLabel: string; appId: string },
  opts: { fetchFn?: FetchLike } = {},
): Promise<LoginResponse> {
  const res = await request<LoginResponse>(apiBase, 'POST', '/api/auth/login', { body: input, fetchFn: opts.fetchFn });
  return { ...res, quota: parseQuota(res.quota) };
}

/** 查询会话（用于刷新额度 / 校验令牌），使用 Bearer，不依赖跨站 Cookie。20 秒超时。 */
export async function getSession(
  apiBase: string,
  token: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<SessionResponse> {
  const res = await request<SessionResponse>(apiBase, 'GET', '/api/auth/session', {
    token,
    timeoutMs: SESSION_TIMEOUT_MS,
    fetchFn: opts.fetchFn,
  });
  return { ...res, quota: parseQuota(res.quota) };
}

export function logout(apiBase: string, token: string, opts: { fetchFn?: FetchLike } = {}): Promise<void> {
  return request<void>(apiBase, 'POST', '/api/auth/logout', { token, fetchFn: opts.fetchFn });
}

/** v12 能力探测：`GET /api/features`（无需登录，跨源放行）。响应体不含 images 时 `images` 为 undefined。 */
export async function getFeatures(
  apiBase: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<FeedbackCapabilities> {
  const res = await request<FeedbackCapabilities>(apiBase, 'GET', '/api/features', {
    fetchFn: opts.fetchFn,
  });
  return parseCapabilities(res) ?? {};
}

/** 图片部件名（multipart 字段 `images`，按描述符顺序追加）。 */
function imageMimeOf(blob: Blob): 'image/png' | 'image/jpeg' | 'image/webp' {
  const t = (blob.type || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/webp') return t;
  return 'image/png';
}

/** 为有序图片列表生成描述符（逐图 sha256；幂等重试复用同一快照，结果稳定）。 */
async function buildImageDescriptors(images: FeedbackImageInput[]): Promise<FeedbackImageDescriptor[]> {
  const out: FeedbackImageDescriptor[] = [];
  for (const img of images) {
    out.push({
      id: img.id,
      source: img.source,
      filename: img.filename,
      sha256: await sha256Hex(img.blob),
      mime: imageMimeOf(img.blob),
    });
  }
  return out;
}

export async function submitFeedback(
  apiBase: string,
  token: string,
  payload: FeedbackSubmitPayload,
  opts: { fetchFn?: FetchLike } = {},
): Promise<FeedbackSubmitResponse> {
  const hasLogs = Array.isArray(payload.logs) && payload.logs.length > 0;
  const hasImages = Array.isArray(payload.images) && payload.images.length > 0;
  // v12：`images` 与旧字段 `screenshot` 互斥；同时出现按契约拒绝（不发送歧义请求）。
  if (hasImages && payload.screenshot) {
    throw new ApiError(0, 'invalid_request', 'images 与 screenshot 不能同时提交');
  }
  if (payload.screenshot || hasLogs || hasImages) {
    const formData = new FormData();
    const metadata: Record<string, unknown> = {
      idempotencyKey: payload.idempotencyKey,
      appId: payload.appId,
      text: payload.text,
    };
    if (payload.appName) metadata.appName = payload.appName;
    if (payload.context) metadata.context = payload.context;
    if (payload.capture) metadata.capture = payload.capture;
    if (hasLogs && payload.logs) {
      metadata.logs = payload.logs.map((l) => ({
        filename: l.filename,
        source: l.source,
        ...(l.sha256 ? { sha256: l.sha256 } : {}),
      }));
    }
    const descriptors = hasImages && payload.images ? await buildImageDescriptors(payload.images) : [];
    if (descriptors.length > 0) metadata.images = descriptors;

    formData.append('metadata', JSON.stringify(metadata));
    if (payload.screenshot) {
      formData.append('screenshot', payload.screenshot, 'screenshot.png');
    }
    if (hasImages && payload.images) {
      for (let i = 0; i < payload.images.length; i++) {
        const img = payload.images[i]!;
        formData.append('images', img.blob, img.filename || `image-${i + 1}.png`);
      }
    }
    if (hasLogs && payload.logs) {
      for (const log of payload.logs) {
        formData.append('logs', log.blob, log.filename);
      }
    }

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await (opts.fetchFn ?? fetch)(joinApi(apiBase, '/api/feedback'), {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'omit',
    });
    if (res.status === 204) return undefined as unknown as FeedbackSubmitResponse;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throwFromResponse(res.status, data);
    const parsed = data as FeedbackSubmitResponse;
    return { ...parsed, quota: parseQuota(parsed.quota) };
  }
  const res = await request<FeedbackSubmitResponse>(apiBase, 'POST', '/api/feedback', {
    body: payload,
    token,
    fetchFn: opts.fetchFn,
  });
  return { ...res, quota: parseQuota(res.quota) };
}

export type IssueStatus = 'open' | 'waiting_user' | 'waiting_admin' | 'resolved';

export interface FeedbackMessageAttachment {
  id: string;
  /** v12 新增 `image`（带 mime/width/height）。 */
  kind: 'screenshot' | 'log' | 'image';
  filename: string;
  byteSize: number;
  sha256: string;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  createdAt: string;
}

export interface FeedbackMessageItem {
  id: string;
  seq: number;
  senderType: 'user' | 'admin' | 'system';
  senderId: string;
  senderName: string;
  text: string;
  /** v12：管理员解决/请求补充时的处理说明（随状态变更持久化，对用户可见）。 */
  resolutionNote?: string | null;
  createdAt: string;
  attachments: FeedbackMessageAttachment[];
}

/**
 * `GET /api/feedback/mine` 的单条记录。
 *
 * 字段以服务端 `listUserFeedbacks()` 实际投影为准（apps/server/src/db/repos.ts）：
 * - 必定返回：id、appId、title、text、issueStatus、createdAt、updatedAt、lastActivityAt、
 *   unread、messageCount、latestMessage（可为 null）；
 * - v13 新增、**渐进发布期为可选**（旧服务端不返回，UI 一律走兜底渲染，不显示 undefined/NaN）：
 *   appName、imageCount、logCount；
 * - 带「漂移」注释的字段是历史遗留声明：服务端当前**并不返回**（或投影为别的字段）。
 *   保留声明以免破坏旧调用方，但类型改为可选，UI 侧的兜底分支因此是必要代码而非死分支。
 */
export interface UserFeedbackListItem {
  id: string;
  appId: string;
  title: string | null;
  text: string;
  /** 漂移：/mine 投影的是 mgmtState，没有 status；UI 不依赖。 */
  status?: FeedbackStatus;
  issueStatus: IssueStatus;
  /** 当前服务端会返回 mgmtState，但旧版本没有 → 保持可选，UI 不依赖。 */
  mgmtState?: string;
  /** 漂移：/mine 不返回该字段（仅 /dialogue 有），故为可选，UI 不得依赖。 */
  dialogueVersion?: number;
  /** 漂移：/mine 不返回该字段（仅 /dialogue 有），故为可选，UI 不得依赖。 */
  archiveRound?: number;
  lastActivityAt: string;
  createdAt: string;
  unread: boolean;
  messageCount: number;
  /** v13：所属项目显示名；服务端无对应 apps 行或已软删时为 null → UI 回退展示 appId。 */
  appName?: string | null;
  /** v13：图片附件数（feedback_images + feedback_screenshots）；旧服务端缺失 → UI 不显示。 */
  imageCount?: number;
  /** v13：日志附件数（feedback_logs）；旧服务端缺失 → UI 不显示。 */
  logCount?: number;
  latestMessage: {
    seq: number;
    senderType: string;
    /** 漂移：/mine 的 latestMessage 不含 senderName（列表只用 senderType 翻译角色文案），UI 不依赖。 */
    senderName?: string;
    text: string;
    createdAt: string;
  } | null;
}

export interface UserFeedbackListResponse {
  items: UserFeedbackListItem[];
  total: number;
  page: number;
  limit: number;
  unreadTotal: number;
}

export interface UnreadSummaryResponse {
  unreadFeedbacksCount: number;
  totalUnreadMessages: number;
}

export interface FeedbackDialogueResponse {
  feedback: {
    id: string;
    appId: string;
    title: string | null;
    text: string;
    status: FeedbackStatus;
    issueStatus: IssueStatus;
    dialogueVersion: number;
    archiveRound: number;
    mgmtState: string;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
    kaneoTaskId?: string | null;
    kaneoTaskUrl?: string | null;
    context?: Record<string, string> | null;
    screenshot?: { width: number; height: number; byteSize: number; sha256: string } | null;
    logs?: Array<{ id: string; filename: string; byteSize: number; sha256?: string; source: string }> | null;
    /** v12：初始反馈的有序图片列表（历史单图记录经兼容读取进入同一列表）。 */
    images?: Array<{
      id: string;
      sort: number;
      source: string;
      mime: string;
      filename: string;
      byteSize: number;
      sha256: string;
      width?: number | null;
      height?: number | null;
      createdAt?: string;
    }> | null;
    /** v12：最近一次处理说明（管理员标记解决时必填）。 */
    resolutionNote?: string | null;
  };
  messages: FeedbackMessageItem[];
  lastReadSeq: number;
}

export interface ReplyPayload {
  text: string;
  idempotencyKey?: string;
  screenshot?: Blob;
  /** v12：回复图片（≤5，与 `screenshot` 互斥）。 */
  images?: FeedbackImageInput[];
  logs?: File[];
}

export function getFeedback(
  apiBase: string,
  token: string,
  id: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<FeedbackRecord> {
  return request<FeedbackRecord>(apiBase, 'GET', `/api/feedback/${encodeURIComponent(id)}`, {
    token,
    fetchFn: opts.fetchFn,
  });
}

export function getUnreadSummary(
  apiBase: string,
  token: string,
  appId?: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<UnreadSummaryResponse> {
  const p = appId ? `?appId=${encodeURIComponent(appId)}` : '';
  return request<UnreadSummaryResponse>(apiBase, 'GET', `/api/feedback/unread-summary${p}`, {
    token,
    fetchFn: opts.fetchFn,
  });
}

export function listMyFeedbacks(
  apiBase: string,
  token: string,
  opts: { page?: number; limit?: number; appId?: string; issueStatus?: IssueStatus; fetchFn?: FetchLike } = {},
): Promise<UserFeedbackListResponse> {
  const p = new URLSearchParams();
  if (opts.page) p.set('page', String(opts.page));
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.appId) p.set('appId', opts.appId);
  if (opts.issueStatus) p.set('issueStatus', opts.issueStatus);
  return request<UserFeedbackListResponse>(apiBase, 'GET', `/api/feedback/mine?${p.toString()}`, {
    token,
    fetchFn: opts.fetchFn,
  });
}

export function getFeedbackDialogue(
  apiBase: string,
  token: string,
  feedbackId: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<FeedbackDialogueResponse> {
  return request<FeedbackDialogueResponse>(
    apiBase,
    'GET',
    `/api/feedback/${encodeURIComponent(feedbackId)}/dialogue`,
    { token, fetchFn: opts.fetchFn },
  );
}

export async function sendFeedbackReply(
  apiBase: string,
  token: string,
  feedbackId: string,
  payload: ReplyPayload,
  opts: { fetchFn?: FetchLike } = {},
): Promise<{ ok: boolean; message: FeedbackMessageItem; dialogueVersion: number; issueStatus: IssueStatus }> {
  const hasImages = Array.isArray(payload.images) && payload.images.length > 0;
  const hasAttachments = Boolean(
    payload.screenshot || hasImages || (payload.logs && payload.logs.length > 0),
  );
  // v12：`images` 与旧字段 `screenshot` 互斥。
  if (hasImages && payload.screenshot) {
    throw new ApiError(0, 'invalid_request', 'images 与 screenshot 不能同时提交');
  }
  if (hasAttachments) {
    const formData = new FormData();
    if (hasImages && payload.images) {
      // v12 multipart 变体：metadata JSON（text/idempotencyKey/images 描述符）+ images 部件。
      const metadata: Record<string, unknown> = { text: payload.text };
      if (payload.idempotencyKey) metadata.idempotencyKey = payload.idempotencyKey;
      metadata.images = await buildImageDescriptors(payload.images);
      formData.append('metadata', JSON.stringify(metadata));
      for (let i = 0; i < payload.images.length; i++) {
        const img = payload.images[i]!;
        formData.append('images', img.blob, img.filename || `image-${i + 1}.png`);
      }
    } else {
      formData.append('text', payload.text);
      if (payload.idempotencyKey) formData.append('idempotencyKey', payload.idempotencyKey);
      if (payload.screenshot) formData.append('screenshot', payload.screenshot, 'screenshot.png');
    }
    if (payload.logs) {
      for (const log of payload.logs) {
        formData.append('logs', log, log.name || 'log.txt');
      }
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const res = await (opts.fetchFn ?? fetch)(
      joinApi(apiBase, `/api/feedback/${encodeURIComponent(feedbackId)}/messages`),
      {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'omit',
      },
    );
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throwFromResponse(res.status, data);
    return data as { ok: boolean; message: FeedbackMessageItem; dialogueVersion: number; issueStatus: IssueStatus };
  }

  return request(
    apiBase,
    'POST',
    `/api/feedback/${encodeURIComponent(feedbackId)}/messages`,
    {
      token,
      fetchFn: opts.fetchFn,
      body: {
        text: payload.text,
        idempotencyKey: payload.idempotencyKey,
      },
    },
  );
}

export function markFeedbackRead(
  apiBase: string,
  token: string,
  feedbackId: string,
  lastReadSeq: number,
  opts: { fetchFn?: FetchLike } = {},
): Promise<{ ok: boolean; lastReadSeq: number }> {
  return request(
    apiBase,
    'POST',
    `/api/feedback/${encodeURIComponent(feedbackId)}/read`,
    {
      token,
      fetchFn: opts.fetchFn,
      body: { lastReadSeq },
    },
  );
}

/**
 * v12 附件取回：图片/日志 URL 不携带凭据，一律以 Bearer `fetch` 取回二进制
 * 后转对象 URL 渲染或触发下载——绝不把 URL 直接挂到 <img>/<a>（跨源下必然 401）。
 * 返回 Blob（调用方负责 `URL.createObjectURL` / `URL.revokeObjectURL`）。
 */
export async function fetchAttachmentBlob(
  apiBase: string,
  token: string,
  path: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<Blob> {
  const res = await (opts.fetchFn ?? fetch)(joinApi(apiBase, path), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    throwFromResponse(res.status, data);
  }
  return res.blob();
}

/** 按 Unicode 码点统计长度（契约要求 1..10000 码点）。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export const MAX_TEXT = 10000;
