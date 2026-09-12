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

/** 日志来源：`auto` = 首次打开自动采集，`manual` = 用户手动添加（docs/logs-plan.md §1）。 */
export type FeedbackLogSource = 'auto' | 'manual';

/** 宿主提供的日志文件：文件名 + **原始字节**（组件按字节上传，不做文本转换）。 */
export interface FeedbackLogFile {
  name: string;
  bytes: Uint8Array;
}

/** 实际提交的日志部件：字节 + 来源（自动 / 手动），顺序即 `metadata.logs` 顺序。 */
export interface FeedbackLogPart extends FeedbackLogFile {
  source: FeedbackLogSource;
}

/**
 * 宿主日志回调（`FeedbackWidget.logProvider` / `openFeedback({ logProvider })`）：
 * 返回文件名 + **原始字节**；同步或异步、单个或数组、`null`（宿主本次没有日志）都接受。
 */
export type LogProvider = () =>
  | FeedbackLogFile
  | FeedbackLogFile[]
  | null
  | Promise<FeedbackLogFile | FeedbackLogFile[] | null>;

export interface FeedbackSubmitPayload {
  idempotencyKey: string;
  appId: string;
  text: string;
  context?: FeedbackContext;
  capture?: FeedbackCaptureInfo;
  screenshot?: Blob;
  logs?: FeedbackLogPart[];
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
  const logs = payload.logs ?? [];
  // 有截图**或**有日志 → multipart/form-data；都没有 → 保持原 JSON 请求（逐字节兼容）
  if (payload.screenshot || logs.length > 0) {
    const formData = new FormData();
    const metadata: Record<string, unknown> = {
      idempotencyKey: payload.idempotencyKey,
      appId: payload.appId,
      text: payload.text,
    };
    if (payload.context) metadata.context = payload.context;
    if (payload.capture) metadata.capture = payload.capture;
    // metadata.logs 与 logs 部件按下标一一对应（顺序敏感），byteSize 必须等于实际字节数
    if (logs.length > 0) {
      metadata.logs = logs.map((log) => ({
        name: log.name,
        source: log.source,
        byteSize: log.bytes.byteLength,
      }));
    }

    formData.append('metadata', JSON.stringify(metadata));
    if (payload.screenshot) formData.append('screenshot', payload.screenshot, 'screenshot.png');
    for (const log of logs) {
      // filename 用日志文件名、type 用 text/plain；
      // slice() → 独立的 ArrayBuffer 视图，Blob 字节不受宿主后续改动影响
      formData.append('logs', new File([log.bytes.slice()], log.name, { type: 'text/plain' }));
    }

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
  // 无附件：提交体必须与历史客户端逐字节一致（绝不出现空的 logs 字段）
  const { logs: _logs, ...rest } = payload;
  return request<FeedbackSubmitResponse>(apiBase, 'POST', '/api/feedback', { body: rest, token });
}

export function getFeedback(apiBase: string, token: string, id: string): Promise<FeedbackRecord> {
  return request<FeedbackRecord>(apiBase, 'GET', `/api/feedback/${encodeURIComponent(id)}`, { token });
}

/** 按 Unicode 码点统计长度（契约要求 1..10000 码点）。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export const MAX_TEXT = 10000;
