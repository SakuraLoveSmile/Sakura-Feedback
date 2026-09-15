import { scryptSync } from "node:crypto";
import path from "node:path";

/** 反馈服务实现的更新执行器协议版本（与 apps/updater 的 UPDATER_PROTOCOL_VERSION 对齐）。 */
export const SUPPORTED_UPDATER_PROTOCOL = 1;

/** 后台「系统更新」默认检查间隔：24 小时（只检查，绝不自动安装）。 */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** updater 执行器内网地址默认值（与 deploy/compose.prod.yml 的默认值一致）。 */
export const DEFAULT_UPDATE_URL = "http://updater:8790";

/**
 * U1-4：updater 执行器地址的**规范环境变量名**。
 * 必须与 `deploy/compose.prod.yml` 注入的名字一致，否则真实部署里「注入生效但被静默忽略」。
 */
export const UPDATE_URL_ENV = "FEEDBACK_UPDATER_URL";
/**
 * 兼容别名（v0.3.0 之前的文档与本仓测试曾用名）。
 * 规范名优先；仅在规范名未设置时才回退到别名。docs/api.md 里已标注哪个是规范名。
 */
export const UPDATE_URL_ENV_ALIAS = "FEEDBACK_UPDATE_URL";

export interface ServerConfig {
  port: number;
  dataDir: string;
  masterKey: Buffer; // 32 bytes
  adminUser: string;
  adminPassword: string; // initial only, may be empty when db already has user
  cookieSecure: boolean;
  publicUrl: string | null;
  adminDist: string | null;
  sessionTtlMs: number; // cookie sessions
  clientTokenTtlMs: number; // flutter long-lived bearer
  handshakeTtlMs: number; // short-lived bearer for web component
  /**
   * U1-4：updater 执行器内网地址；`null` 表示未接入（更新入口整体不可用）。
   * 可选：仅 `loadConfig` 与更新相关测试需要显式提供，其它构造点缺省即「未接入」。
   */
  updateUrl?: string | null;
  /** U1-4：共享令牌文件（600 权限），仅由部署脚本生成。 */
  updateTokenFile?: string | null;
  /** U1-4：与执行器共享的控制目录（只读挂载）：paused 标记与 state/tasks 进度。 */
  updateControlDir?: string | null;
  /** U1-4：自动检查间隔（毫秒）；0 表示只允许手动检查。 */
  updateCheckIntervalMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;

function deriveMasterKey(raw: string): Buffer {
  // base64 编码的 32 字节密钥优先；否则按口令 scrypt 派生
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32 && buf.toString("base64") === raw.trim()) return buf;
  return scryptSync(raw, "feedback-master-key-salt-v1", 32);
}

function optionalText(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return value === "" ? null : value;
}

/** 检查间隔：非负安全整数；非法值回退默认（配置笔误不得把服务卡死或变成高频轮询）。 */
function parseCheckInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  return value;
}

/**
 * 解析 updater 地址：规范名 `FEEDBACK_UPDATER_URL`（compose 注入名）优先，
 * 未设置时才回退到旧别名 `FEEDBACK_UPDATE_URL`，都没有则用默认值。
 * 三种来源都为空 → 默认值，保证 compose 默认形态下仍指向内网 updater。
 */
function parseUpdateUrl(env: NodeJS.ProcessEnv): string | null {
  return optionalText(env[UPDATE_URL_ENV]) ?? optionalText(env[UPDATE_URL_ENV_ALIAS]) ?? DEFAULT_UPDATE_URL;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.FEEDBACK_DATA_DIR ?? path.resolve("data");
  const masterRaw = env.FEEDBACK_MASTER_KEY;
  if (!masterRaw || masterRaw.length < 16) {
    throw new Error("环境变量 FEEDBACK_MASTER_KEY 缺失或过短（建议 base64 的 32 字节随机密钥）");
  }
  return {
    port: Number(env.FEEDBACK_PORT ?? 8787),
    dataDir,
    masterKey: deriveMasterKey(masterRaw),
    adminUser: env.FEEDBACK_ADMIN_USER ?? "admin",
    adminPassword: env.FEEDBACK_ADMIN_PASSWORD ?? "",
    cookieSecure: env.FEEDBACK_COOKIE_SECURE === "1" || env.FEEDBACK_COOKIE_SECURE === "true",
    publicUrl: env.FEEDBACK_PUBLIC_URL ?? null,
    adminDist: env.FEEDBACK_ADMIN_DIST ?? null,
    sessionTtlMs: Number(env.FEEDBACK_SESSION_TTL_MS ?? 14 * DAY),
    clientTokenTtlMs: Number(env.FEEDBACK_CLIENT_TOKEN_TTL_MS ?? 90 * DAY),
    handshakeTtlMs: Number(env.FEEDBACK_HANDSHAKE_TTL_MS ?? 15 * 60 * 1000),
    updateUrl: parseUpdateUrl(env),
    updateTokenFile: optionalText(env.FEEDBACK_UPDATE_TOKEN_FILE),
    updateControlDir: optionalText(env.FEEDBACK_UPDATE_CONTROL_DIR),
    updateCheckIntervalMs: parseCheckInterval(env.FEEDBACK_UPDATE_CHECK_INTERVAL_MS),
  };
}
