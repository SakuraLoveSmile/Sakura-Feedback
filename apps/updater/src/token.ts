import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import type { UpdaterConfig } from "./config.ts";
import { fileExists } from "./fsx.ts";
import type { Logger } from "./log.ts";

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export interface TokenSource {
  path: string;
  value: string;
  mode: number | null;
}

export interface TokenSet {
  /** UPDATER_TOKEN_FILE 指向的共享令牌（主令牌）。 */
  primary: TokenSource;
  /** 控制目录内可选的 feedback-token；存在即一并接受，避免两侧文件不一致导致更新入口不可用。 */
  extras: TokenSource[];
  all: TokenSource[];
}

async function readTokenFile(path: string, label: string): Promise<TokenSource> {
  let raw: string;
  let mode: number | null = null;
  try {
    const stat = await fs.stat(path);
    mode = stat.mode & 0o777;
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TokenError(`${label} 不存在：${path}（应由 deploy/install-updater.sh 生成 600 权限的随机令牌）`);
    }
    throw err;
  }
  const value = raw.trim();
  if (value.length < 16) {
    throw new TokenError(`${label} 内容过短（至少 16 字符）：${path}`);
  }
  return { path, value, mode };
}

/**
 * 读取共享令牌。令牌文件必须由部署脚本生成并保持 600；权限过宽时只告警不改动文件，
 * 因为执行器没有、也不应有修改部署目录权限的职责。
 */
export async function loadTokenSet(config: UpdaterConfig, log?: Logger): Promise<TokenSet> {
  const primary = await readTokenFile(config.tokenFile, "UPDATER_TOKEN_FILE");
  const extras: TokenSource[] = [];
  if (config.feedbackTokenFile !== config.tokenFile && (await fileExists(config.feedbackTokenFile))) {
    const extra = await readTokenFile(config.feedbackTokenFile, "feedback-token");
    if (extra.value !== primary.value) extras.push(extra);
  }
  const all = [primary, ...extras];
  for (const source of all) {
    if (source.mode !== null && source.mode & 0o077) {
      log?.warn("令牌文件权限过宽，建议 chmod 600", { path: source.path, mode: `0${source.mode.toString(8)}` });
    }
  }
  log?.info("已加载共享令牌", { files: all.map((source) => source.path), count: all.length });
  return { primary, extras, all };
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 定长摘要后定时安全比较；令牌永不进入响应体或日志。 */
export function tokenMatches(tokens: TokenSet, candidate: string | undefined | null): boolean {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4096) return false;
  const candidateHash = hashToken(candidate);
  let matched = false;
  for (const source of tokens.all) {
    if (timingSafeEqual(candidateHash, hashToken(source.value))) matched = true;
  }
  return matched;
}
