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

export interface FeedbackCaptureInfo {
  /** 逻辑视口尺寸（CSS 像素）。 */
  viewportWidth?: number;
  viewportHeight?: number;
  /** 截图输出位图尺寸（物理像素），与逻辑视口区分（实施计划 2.3；两端统一字段名）。 */
  pixelWidth?: number;
  pixelHeight?: number;
  capturedAt?: string;
  releasePoint?: { x: number; y: number };
}

export interface FeedbackSubmitPayload {
  idempotencyKey: string;
  appId: string;
  text: string;
  context?: FeedbackContext;
  capture?: FeedbackCaptureInfo;
  screenshot?: Blob;
}

export interface FeedbackSubmitResponse {
  feedbackId: string;
  status: FeedbackStatus;
  replayed?: boolean;
  user?: AuthUser;
  quota?: Quota;
}

/** 已登录账号的最小信息（服务端不返回密码或哈希）。 */
export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/** 每日提交额度（服务端按北京时间日切分；resetAt 为 ISO-8601 UTC）。 */
export interface Quota {
  dailyLimit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface LoginResponse {
  ok: boolean;
  token: string;
  expiresAt: string;
  user: AuthUser;
  quota: Quota;
}

export interface SessionResponse {
  authenticated: boolean;
  kind?: string;
  clientLabel?: string | null;
  expiresAt: string;
  user: AuthUser;
  quota: Quota;
}

export interface FeedbackRecord {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  errorSummary?: string | null;
  kaneoUrl?: string | null;
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

function parseQuota(raw: unknown): Quota | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const q = raw as Record<string, unknown>;
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

async function request<T>(
  apiBase: string,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; timeoutMs?: number } = {},
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
    const res = await fetch(joinApi(apiBase, path), {
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
export function login(
  apiBase: string,
  input: { username: string; password: string; clientLabel: string; appId: string },
): Promise<LoginResponse> {
  return request<LoginResponse>(apiBase, 'POST', '/api/auth/login', { body: input });
}

/** 查询会话（用于刷新额度 / 校验令牌），使用 Bearer，不依赖跨站 Cookie。20 秒超时。 */
export function getSession(apiBase: string, token: string): Promise<SessionResponse> {
  return request<SessionResponse>(apiBase, 'GET', '/api/auth/session', {
    token,
    timeoutMs: SESSION_TIMEOUT_MS,
  });
}

export function logout(apiBase: string, token: string): Promise<void> {
  return request<void>(apiBase, 'POST', '/api/auth/logout', { token });
}

export async function submitFeedback(
  apiBase: string,
  token: string,
  payload: FeedbackSubmitPayload,
): Promise<FeedbackSubmitResponse> {
  if (payload.screenshot) {
    const formData = new FormData();
    const metadata: Record<string, unknown> = {
      idempotencyKey: payload.idempotencyKey,
      appId: payload.appId,
      text: payload.text,
    };
    if (payload.context) metadata.context = payload.context;
    if (payload.capture) metadata.capture = payload.capture;

    formData.append('metadata', JSON.stringify(metadata));
    formData.append('screenshot', payload.screenshot, 'screenshot.png');

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(joinApi(apiBase, '/api/feedback'), {
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
    return data as FeedbackSubmitResponse;
  }
  return request<FeedbackSubmitResponse>(apiBase, 'POST', '/api/feedback', { body: payload, token });
}

export function getFeedback(apiBase: string, token: string, id: string): Promise<FeedbackRecord> {
  return request<FeedbackRecord>(apiBase, 'GET', `/api/feedback/${encodeURIComponent(id)}`, { token });
}

/** 按 Unicode 码点统计长度（契约要求 1..10000 码点）。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export const MAX_TEXT = 10000;
