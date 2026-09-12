import { createHash } from "node:crypto";
import type { FeedbackLogInput, LogSource } from "../db/repos.ts";

/** 日志附件限制（与 docs/logs-plan.md 第 1.1 节一致；客户端必须使用同一组常量）。 */
export const MAX_LOGS = 3;
export const MAX_LOG_BYTES = 1024 * 1024; // 每文件 1MiB
export const LOG_EXTENSIONS = [".log", ".txt", ".json", ".jsonl"] as const;

export type LogValidationCode = "invalid_log" | "too_large";

export class LogValidationError extends Error {
  constructor(
    public code: LogValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "LogValidationError";
  }
}

export interface LogPart {
  /** multipart 部件自带 filename（浏览器/移动端通常都会带；缺省时跳过一致性检查）。 */
  filename: string | null;
  bytes: Buffer;
}

export interface LogMetaEntry {
  name: string;
  source: LogSource;
  byteSize?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取 basename（兼容 Windows 与 POSIX 分隔符）。 */
function basename(raw: string): string {
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * 安全化日志文件名：只保留 basename，去掉控制字符与两端空白，限制 200 字符。
 * 返回 null 表示不可用（空、`.`、`..`）。绝不放行路径分隔符进入存储或响应头。
 */
export function sanitizeLogName(raw: string): string | null {
  // 逐码点剔除控制字符（不用正则，避免控制字符字面量带来的可读性与 lint 问题）
  const cleaned = Array.from(basename(raw))
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp > 0x1f && cp !== 0x7f;
    })
    .join("")
    .replace(/["\\]/g, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 200);
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return LOG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 解析 metadata.logs（客户端声明的顺序与来源）。 */
export function parseLogMetadata(raw: unknown): LogMetaEntry[] | LogValidationError {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return new LogValidationError("invalid_log", "metadata.logs 必须是数组");
  }
  const out: LogMetaEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      return new LogValidationError("invalid_log", `metadata.logs[${i}] 必须是对象`);
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > 500) {
      return new LogValidationError("invalid_log", `metadata.logs[${i}].name 缺失或过长`);
    }
    const source = item.source;
    if (source !== "auto" && source !== "manual") {
      return new LogValidationError("invalid_log", `metadata.logs[${i}].source 必须是 auto 或 manual`);
    }
    let byteSize: number | undefined;
    if (item.byteSize !== undefined && item.byteSize !== null) {
      if (typeof item.byteSize !== "number" || !Number.isInteger(item.byteSize) || item.byteSize < 0) {
        return new LogValidationError("invalid_log", `metadata.logs[${i}].byteSize 必须是非负整数`);
      }
      byteSize = item.byteSize;
    }
    out.push({ name, source, ...(byteSize !== undefined ? { byteSize } : {}) });
  }
  return out;
}

/**
 * 校验并归一化日志附件。
 *
 * 顺序即 `metadata.logs` 的下标顺序；数量、名称、大小、UTF-8 内容逐项核对：
 * 任何不符都返回 LogValidationError，绝不截断、绝不静默丢弃。
 */
export function validateLogAttachments(
  parts: LogPart[],
  rawMeta: unknown,
): { ok: true; logs: FeedbackLogInput[] } | { ok: false; error: LogValidationError } {
  const meta = parseLogMetadata(rawMeta);
  if (meta instanceof LogValidationError) return { ok: false, error: meta };

  if (meta.length !== parts.length) {
    return {
      ok: false,
      error: new LogValidationError(
        "invalid_log",
        `metadata.logs 数量（${meta.length}）与 logs 文件部件数量（${parts.length}）不一致`,
      ),
    };
  }
  if (parts.length > MAX_LOGS) {
    return {
      ok: false,
      error: new LogValidationError("too_large", `日志文件数量超过 ${MAX_LOGS} 个上限`),
    };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const logs: FeedbackLogInput[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const entry = meta[i]!;
    const name = sanitizeLogName(entry.name);
    if (!name) {
      return { ok: false, error: new LogValidationError("invalid_log", `第 ${i + 1} 个日志文件名非法`) };
    }
    if (!hasAllowedExtension(name)) {
      return {
        ok: false,
        error: new LogValidationError(
          "invalid_log",
          `第 ${i + 1} 个日志扩展名不受支持（仅支持 ${LOG_EXTENSIONS.join("、")}）：${name}`,
        ),
      };
    }
    // 部件 filename 与 metadata 顺序声称的文件必须一致（basename 比较，兼容整路径 filename）
    if (part.filename !== null && basename(part.filename) !== name) {
      return {
        ok: false,
        error: new LogValidationError(
          "invalid_log",
          `第 ${i + 1} 个日志的部件文件名（${basename(part.filename)}）与 metadata.logs 声明（${name}）不一致`,
        ),
      };
    }
    if (part.bytes.byteLength === 0) {
      return { ok: false, error: new LogValidationError("invalid_log", `第 ${i + 1} 个日志文件为空（${name}）`) };
    }
    if (part.bytes.byteLength > MAX_LOG_BYTES) {
      return {
        ok: false,
        error: new LogValidationError(
          "too_large",
          `第 ${i + 1} 个日志超过 ${MAX_LOG_BYTES / (1024 * 1024)}MiB 上限（${name}）`,
        ),
      };
    }
    if (entry.byteSize !== undefined && entry.byteSize !== part.bytes.byteLength) {
      return {
        ok: false,
        error: new LogValidationError(
          "invalid_log",
          `第 ${i + 1} 个日志字节数与 metadata.logs 声明不一致（声明 ${entry.byteSize}，实际 ${part.bytes.byteLength}）`,
        ),
      };
    }
    let text: string;
    try {
      text = decoder.decode(part.bytes);
    } catch {
      return {
        ok: false,
        error: new LogValidationError("invalid_log", `第 ${i + 1} 个日志不是合法的 UTF-8 文本（${name}）`),
      };
    }
    if (text.includes("\u0000")) {
      return {
        ok: false,
        error: new LogValidationError("invalid_log", `第 ${i + 1} 个日志包含二进制内容（NUL 字节）：${name}`),
      };
    }
    logs.push({
      name,
      source: entry.source,
      content: part.bytes,
      byteSize: part.bytes.byteLength,
      sha256: createHash("sha256").update(part.bytes).digest("hex"),
    });
  }
  return { ok: true, logs };
}
