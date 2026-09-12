/**
 * 日志附件规则与纯函数校验（docs/logs-plan.md §1.1 / §4，Web 与 Flutter 语义一致）。
 *
 * 客户端先按与服务端**同一套上限**校验，避免把注定被拒的请求发出去；
 * 但规则只有一处事实来源：常量都在这里，服务端仍会独立复核。
 * 任何超限都给出**明确原因**并整批拒绝该文件——**绝不静默删除或截断**。
 */
import type { FeedbackLogFile } from './api';

/** 自动 + 手动共用的文件数上限。 */
export const MAX_LOGS = 3;
/** 单文件字节上限（1 MiB）。 */
export const MAX_LOG_BYTES = 1048576;
/** 采集超时：3 秒未返回即「日志获取失败」（不阻塞截图与描述提交）。 */
export const LOG_COLLECT_TIMEOUT_MS = 3000;
/** 预览最多渲染的 Unicode 码点数（超出部分截断并显式说明）。 */
export const LOG_PREVIEW_MAX_CHARS = 4000;
/** `<input type="file">` 的 accept 值。 */
export const LOG_ACCEPT = '.log,.txt,.json,.jsonl';
/** 扩展名白名单（大小写不敏感）。 */
export const LOG_EXTENSIONS = ['.log', '.txt', '.json', '.jsonl'] as const;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** 取 basename（`name` 里的路径分隔符一律剥掉，避免把路径带进请求）。 */
export function logBasename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** 扩展名是否在白名单内（大小写不敏感）。 */
export function hasSupportedLogExtension(name: string): boolean {
  const lower = logBasename(name).toLowerCase();
  return LOG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 严格 UTF-8：`TextDecoder('utf-8', { fatal: true })` 解码失败（含替换字符来源）即拒绝；
 * `0x00` 视为二进制内容一并拒绝（与 §1.1 服务端规则一致）。
 */
export function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    utf8Strict.decode(bytes);
  } catch {
    return false;
  }
  return !bytes.includes(0);
}

/** 校验单个日志文件：通过返回 `null`，否则返回可直接展示给用户的原因。 */
export function validateLogFile(file: FeedbackLogFile): string | null {
  const name = logBasename(file.name);
  if (!name) return '缺少文件名';
  if (!hasSupportedLogExtension(name)) {
    return `不支持的文件类型（仅支持 ${LOG_EXTENSIONS.join(' / ')}）`;
  }
  if (!(file.bytes instanceof Uint8Array)) return '字节内容不是 Uint8Array';
  if (file.bytes.byteLength === 0) return '文件为空';
  if (file.bytes.byteLength > MAX_LOG_BYTES) {
    return `文件超过 ${formatBytes(MAX_LOG_BYTES)}（实测 ${formatBytes(file.bytes.byteLength)}）`;
  }
  if (!isUtf8Text(file.bytes)) return '不是有效的 UTF-8 文本（可能为二进制）';
  return null;
}

/**
 * 归一化宿主回调的返回值：单个对象、数组、`null` 都接受；
 * 出现结构不合法（缺 name / 非 Uint8Array 字节）则返回 `null`（整批失败并明确提示）。
 */
export function normalizeLogFiles(raw: unknown): FeedbackLogFile[] | null {
  if (raw === null || raw === undefined) return [];
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  const out: FeedbackLogFile[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) return null;
    const { name, bytes } = item as { name?: unknown; bytes?: unknown };
    if (typeof name !== 'string' || !(bytes instanceof Uint8Array)) return null;
    out.push({ name, bytes });
  }
  return out;
}

/** 人类可读的字节数（二进制单位）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MAX_LOG_BYTES) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / MAX_LOG_BYTES).toFixed(2)} MiB`;
}

export interface LogPreview {
  /** 预览文本（超过上限时已截断）。 */
  text: string;
  truncated: boolean;
  /** 原始文本的码点数（用于截断说明）。 */
  totalChars: number;
}

/** 纯文本预览：按码点截断到上限，并回报原始长度以便面板说明「已截断」。 */
export function logPreview(bytes: Uint8Array, max = LOG_PREVIEW_MAX_CHARS): LogPreview {
  let text = '';
  try {
    text = utf8Strict.decode(bytes);
  } catch {
    text = '';
  }
  const chars = Array.from(text);
  const truncated = chars.length > max;
  return {
    text: truncated ? chars.slice(0, max).join('') : text,
    truncated,
    totalChars: chars.length,
  };
}

/** 采集超时错误（3 秒未返回）。 */
export class LogTimeoutError extends Error {
  constructor() {
    super(`日志回调未在 ${LOG_COLLECT_TIMEOUT_MS}ms 内返回`);
    this.name = 'LogTimeoutError';
  }
}

/**
 * 采集超时包装：到点即 reject，**不打断**宿主回调本身
 * （迟到的返回值仍会被调用方的会话校验丢弃）。
 */
export function withLogTimeout(run: () => unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LogTimeoutError()), LOG_COLLECT_TIMEOUT_MS);
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/** 统一的错误文案提取。 */
export function logErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
