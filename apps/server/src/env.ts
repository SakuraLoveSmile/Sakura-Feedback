import { scryptSync } from "node:crypto";
import path from "node:path";

/** 后台「检查更新」默认检查间隔：24 小时（只检查，绝不自动安装）。 */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 「检查更新」的版本清单地址默认值：稳定渠道 Release 的 release-manifest.json。
 * 服务端直接拉取（仓库公开、可匿名访问）；自建发布渠道可用 FEEDBACK_UPDATE_MANIFEST_URL 覆盖。
 */
export const DEFAULT_UPDATE_MANIFEST_URL =
  "https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/latest/download/release-manifest.json";

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
   * 「检查更新」的版本清单地址（GitHub Release 资产 URL）。
   * `null` 表示检查功能被显式关闭（`FEEDBACK_UPDATE_MANIFEST_URL=off`）。
   */
  updateManifestUrl?: string | null;
  /** 自动检查间隔（毫秒）；0 表示只允许手动检查。 */
  updateCheckIntervalMs?: number;
  /**
   * Assist 接入（contracts/feedback-integration.md §1，全部可选）。
   * `assistHubUrl` 缺省 = 整体关闭接入（零行为变化：不写 outbox、不建投递 worker、不挂只读路由）。
   */
  assistHubUrl?: string | null;
  /** 中枢签发的来源密钥 `ask_…`（事件上报 Bearer）。 */
  assistSourceKey?: string | null;
  /** 附件只读接口凭证；缺省回退 `assistSourceKey`，两者都未配置则路由组不挂载。 */
  assistReadKey?: string | null;
  /** outbox pending 上限，默认 1000。 */
  assistQueueMax?: number;
  /** 投递循环空闲休眠毫秒，默认 2000。 */
  assistFlushMs?: number;
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

/** Assist 接入数值项：正整数；缺省/非法值回退默认（配置笔误不得把服务卡死）。 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

/**
 * 解析版本清单地址：显式 `off`/`none`/`disabled` → 关闭检查功能（返回 null）；
 * 未设置 → 默认稳定渠道清单；其它非空值 → 视为自定义清单 URL（自建发布渠道用）。
 */
function parseUpdateManifestUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = optionalText(env.FEEDBACK_UPDATE_MANIFEST_URL);
  if (raw === null) return DEFAULT_UPDATE_MANIFEST_URL;
  if (["off", "none", "disabled"].includes(raw.toLowerCase())) return null;
  return raw;
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
    updateManifestUrl: parseUpdateManifestUrl(env),
    updateCheckIntervalMs: parseCheckInterval(env.FEEDBACK_UPDATE_CHECK_INTERVAL_MS),
    // Assist 接入：全部可选；assistHubUrl 缺省 = 整体关闭（零行为变化）。
    assistHubUrl: optionalText(env.FEEDBACK_ASSIST_HUB_URL),
    assistSourceKey: optionalText(env.FEEDBACK_ASSIST_SOURCE_KEY),
    assistReadKey: optionalText(env.FEEDBACK_ASSIST_READ_KEY),
    assistQueueMax: parsePositiveInt(env.FEEDBACK_ASSIST_QUEUE_MAX, 1000),
    assistFlushMs: parsePositiveInt(env.FEEDBACK_ASSIST_FLUSH_MS, 2000),
  };
}
