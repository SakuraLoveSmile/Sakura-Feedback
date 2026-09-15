import { createHash } from "node:crypto";
import type { LogInput } from "../db/repos.ts";

export const MAX_LOG_FILES = 3;
export const MAX_SINGLE_LOG_BYTES = 1024 * 1024; // 1 MiB
export const ALLOWED_LOG_EXTENSIONS = [".log", ".txt", ".json", ".jsonl"] as const;

export class LogValidationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LogValidationError";
    this.code = code;
    this.status = status;
  }
}

export interface LogDescriptorInput {
  filename?: unknown;
  source?: unknown;
  sha256?: unknown;
  size?: unknown;
}

export interface RawLogPart {
  bytes: Buffer | Uint8Array;
  filename?: string;
}

/**
 * 校验单份日志附件：
 * - 来源：auto 或 manual
 * - 文件名：非空、去路径、扩展名为 .log/.txt/.json/.jsonl（大小写不敏感）
 * - 大小：1..1MiB（超限 413 too_large，空文件 400 invalid_log）
 * - 编码：严格 UTF-8
 * - 摘要：若客户端提供 sha256，校验必须一致
 */
export function validateLogAttachment(part: RawLogPart, descriptor: LogDescriptorInput, index: number): LogInput {
  // 1. 来源校验
  const source = descriptor.source;
  if (source !== "auto" && source !== "manual") {
    throw new LogValidationError("invalid_log", `第 ${index + 1} 个日志来源非法，仅支持 auto 或 manual`, 400);
  }

  // 2. 文件名校验（优先 descriptor.filename，或 fallback part.filename）
  let filename = typeof descriptor.filename === "string" ? descriptor.filename.trim() : "";
  if (!filename && typeof part.filename === "string") {
    filename = part.filename.trim();
  }
  if (!filename) {
    throw new LogValidationError("invalid_log", `第 ${index + 1} 个日志缺少文件名`, 400);
  }

  // 去除路径分隔符（仅允许纯文件名，防路径遍历）
  if (filename.includes("/") || filename.includes("\\")) {
    throw new LogValidationError("invalid_log", `日志文件名不能包含路径分隔符: ${filename}`, 400);
  }

  // 扩展名校验
  const lower = filename.toLowerCase();
  const hasValidExt = ALLOWED_LOG_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasValidExt) {
    throw new LogValidationError(
      "invalid_log",
      `日志文件名非法 (${filename})，仅支持 ${ALLOWED_LOG_EXTENSIONS.join(", ")} 格式`,
      400,
    );
  }

  // 3. 大小校验
  const bytes = Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes);
  const byteSize = bytes.byteLength;
  if (byteSize === 0) {
    throw new LogValidationError("invalid_log", `日志文件 ${filename} 内容为空`, 400);
  }
  if (byteSize > MAX_SINGLE_LOG_BYTES) {
    throw new LogValidationError("too_large", `日志文件 ${filename} 超过 1MiB 上限 (${byteSize} 字节)`, 413);
  }

  // 4. UTF-8 校验（严格模式，非法字节序列抛错）
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(bytes);
  } catch {
    throw new LogValidationError("invalid_log", `日志文件 ${filename} 不是合法的 UTF-8 编码文本`, 400);
  }

  // 5. 摘要校验
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (typeof descriptor.sha256 === "string" && descriptor.sha256.trim() !== "") {
    if (descriptor.sha256.trim().toLowerCase() !== sha256.toLowerCase()) {
      throw new LogValidationError("invalid_log", `日志文件 ${filename} 的 SHA-256 摘要与客户端提供的不一致`, 400);
    }
  }

  return {
    filename,
    source,
    bytes,
    byteSize,
    sha256,
  };
}

/**
 * 校验整个日志列表与表单部件的对应关系
 */
export function validateAllLogs(parts: RawLogPart[], descriptorsRaw: unknown): LogInput[] {
  if (descriptorsRaw === undefined || descriptorsRaw === null) {
    if (parts.length > 0) {
      throw new LogValidationError("invalid_log", "存在日志文件部件但缺少 metadata.logs 描述", 400);
    }
    return [];
  }

  if (!Array.isArray(descriptorsRaw)) {
    throw new LogValidationError("invalid_log", "metadata.logs 必须是数组", 400);
  }

  if (descriptorsRaw.length > MAX_LOG_FILES) {
    throw new LogValidationError("invalid_log", `日志附件数量超过上限，最多允许 ${MAX_LOG_FILES} 个`, 400);
  }

  if (parts.length !== descriptorsRaw.length) {
    throw new LogValidationError(
      "invalid_log",
      `日志文件数量与描述不一致：收到 ${parts.length} 个部件，描述了 ${descriptorsRaw.length} 个`,
      400,
    );
  }

  const result: LogInput[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const desc = descriptorsRaw[i];
    if (!desc || typeof desc !== "object") {
      throw new LogValidationError("invalid_log", `第 ${i + 1} 个日志描述必须为对象`, 400);
    }
    result.push(validateLogAttachment(part, desc as LogDescriptorInput, i));
  }

  return result;
}
