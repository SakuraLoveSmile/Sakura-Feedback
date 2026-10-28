import type { FeedbackLogFile } from "@feedback/web";

/**
 * 后台诊断日志缓冲（Feedback-3）：
 * 只记录白名单字段（level / event / code / status + 记录器生成的 ISO 时间），
 * 不采集密码、token、cookie、请求/响应体、URL、异常 message 等任意文本——
 * 函数签名从类型上就无法传入字符串内容。
 *
 * 内存环形缓冲，不持久化：最多 200 条、UTF-8 总字节 ≤256KiB、
 * 单条 JSONL 序列化 ≤1KiB；超限丢最旧，单条超长整条拒绝。
 *
 * 会话世代（epoch）：clearDiagnostics 递增；recordDiagnostic 传入的 epoch
 * 与当前世代不一致时整条丢弃——迟到的旧会话写入不污染新会话。
 *
 * 诊断自身故障绝不得改变业务请求结果：所有导出函数内部 try/catch 兜底，不抛异常。
 */

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticEvent = "api_request" | "auth_session" | "handshake" | "diagnostics";
export type DiagnosticCode =
  | "ok"
  | "version_conflict"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "app_exists"
  | "incomplete_rule"
  | "invalid_rule"
  | "invalid_state"
  | "kaneo_unavailable"
  | "daily_quota_exceeded"
  | "rate_limited"
  | "conflict"
  | "server_error"
  | "network"
  | "timeout"
  | "unknown";

export interface DiagnosticInput {
  level: DiagnosticLevel;
  event: DiagnosticEvent;
  code?: DiagnosticCode;
  /** 合法 HTTP 状态码（整数 100–599）。 */
  status?: number;
}

/** 缓冲条目：time 由记录器生成；只含白名单字段。 */
interface DiagnosticEntry {
  time: string;
  level: DiagnosticLevel;
  event: DiagnosticEvent;
  code?: DiagnosticCode;
  status?: number;
}

const LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error"]);
const EVENTS: ReadonlySet<string> = new Set(["api_request", "auth_session", "handshake", "diagnostics"]);
const CODES: ReadonlySet<string> = new Set([
  "ok",
  "version_conflict",
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "app_exists",
  "incomplete_rule",
  "invalid_rule",
  "invalid_state",
  "kaneo_unavailable",
  "daily_quota_exceeded",
  "rate_limited",
  "conflict",
  "server_error",
  "network",
  "timeout",
  "unknown",
]);

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_ENTRY_BYTES = 1024;
const LOG_FILENAME = "admin-diagnostics.jsonl";

/** 已序列化 JSONL 行 + 其 UTF-8 字节数（含换行），避免导出时重复序列化。 */
interface BufferedLine {
  line: string;
  bytes: number;
}

let currentEpoch = 0;
let buffer: BufferedLine[] = [];
let totalBytes = 0;
const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function isValidStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

/**
 * 写入一条诊断事件。任何字段非法则整条拒绝；epoch 传入且与当前世代
 * 不一致时整条丢弃。永不抛异常。
 */
export function recordDiagnostic(input: DiagnosticInput, epoch?: number): void {
  try {
    if (epoch !== undefined && epoch !== currentEpoch) return;
    if (!input || typeof input !== "object") return;
    if (!LEVELS.has(input.level)) return;
    if (!EVENTS.has(input.event)) return;
    if (input.code !== undefined && !CODES.has(input.code)) return;
    if (input.status !== undefined && !isValidStatus(input.status)) return;

    const entry: DiagnosticEntry = {
      time: new Date().toISOString(),
      level: input.level,
      event: input.event,
    };
    if (input.code !== undefined) entry.code = input.code;
    if (input.status !== undefined) entry.status = input.status;

    const line = JSON.stringify(entry);
    // +1：JSONL 行尾换行符。
    const bytes = utf8Bytes(line) + 1;
    if (bytes > MAX_ENTRY_BYTES) return;

    buffer.push({ line, bytes });
    totalBytes += bytes;
    while (buffer.length > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
      const dropped = buffer.shift();
      if (!dropped) break;
      totalBytes -= dropped.bytes;
    }
  } catch {
    /* 诊断自身故障不得影响业务请求 */
  }
}

/** 当前诊断会话世代：clearDiagnostics 后递增。 */
export function diagnosticsEpoch(): number {
  return currentEpoch;
}

/**
 * 导出缓冲为反馈日志附件：无事件返回 []；有事件返回单个
 * `admin-diagnostics.jsonl`（UTF-8 JSONL，每行一条 JSON）。序列化失败返回 []。
 */
export function provideFeedbackLogs(): FeedbackLogFile[] {
  try {
    if (buffer.length === 0) return [];
    const text = `${buffer.map((item) => item.line).join("\n")}\n`;
    return [{ filename: LOG_FILENAME, blob: new Blob([text], { type: "application/jsonl" }) }];
  } catch {
    return [];
  }
}

/** 清空缓冲并递增世代（旧 epoch 的迟到写入随后被丢弃）。 */
export function clearDiagnostics(): void {
  try {
    buffer = [];
    totalBytes = 0;
    currentEpoch++;
  } catch {
    /* 同上：绝不抛出 */
  }
}
