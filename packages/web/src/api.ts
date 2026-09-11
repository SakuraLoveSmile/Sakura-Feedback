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
  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

async function request<T>(
  apiBase: string,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(joinApi(apiBase, path), { method, headers, body });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
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
    });
    if (res.status === 204) return undefined as unknown as FeedbackSubmitResponse;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `HTTP ${res.status}`);
    }
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
