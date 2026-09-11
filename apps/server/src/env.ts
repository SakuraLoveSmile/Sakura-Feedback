import { scryptSync } from "node:crypto";
import path from "node:path";

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
}

const DAY = 24 * 60 * 60 * 1000;

function deriveMasterKey(raw: string): Buffer {
  // base64 编码的 32 字节密钥优先；否则按口令 scrypt 派生
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32 && buf.toString("base64") === raw.trim()) return buf;
  return scryptSync(raw, "feedback-master-key-salt-v1", 32);
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
  };
}
