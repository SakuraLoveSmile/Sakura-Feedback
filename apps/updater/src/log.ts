export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 派生子 logger：附加固定字段（例如 operationId）。 */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** 输出目标，默认 process.stdout（错误行写 process.stderr 由调用方决定）。 */
  write?: (line: string, level: LogLevel) => void;
  /** 需要从所有输出中抹除的秘密（共享令牌）。 */
  redact?: string[];
  now?: () => Date;
  base?: Record<string, unknown>;
}

const MAX_FIELD_LENGTH = 2000;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
}

function truncate(text: string): string {
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…[truncated]` : text;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = (options.redact ?? []).filter((secret) => secret.length > 0);
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string, level: LogLevel) => {
      if (level === "error") process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const redactLine = (line: string): string => {
    let out = line;
    for (const secret of secrets) out = out.split(secret).join("***");
    return out;
  };

  const build = (base: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      const payload: Record<string, unknown> = {
        ts: now().toISOString(),
        level,
        msg: message,
        ...base,
        ...(fields ?? {}),
      };
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string") payload[key] = truncate(value);
      }
      let line: string;
      try {
        line = JSON.stringify(payload);
      } catch {
        line = JSON.stringify({ ts: payload.ts, level, msg: message, note: "fields-unserializable" });
      }
      write(redactLine(line), level);
    };
    return {
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build(options.base ?? {});
}

export function stringifyForLog(value: unknown): string {
  return truncate(safeStringify(value));
}
