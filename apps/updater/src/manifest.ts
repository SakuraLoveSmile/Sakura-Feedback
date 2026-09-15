import type { UpdaterConfig } from "./config.ts";
import { readTextFileIfExists, writeJsonAtomic } from "./fsx.ts";
import type { Logger } from "./log.ts";

export interface ManifestServiceRef {
  image: string;
  digest: string;
}

export interface ReleaseManifest {
  manifestVersion: number;
  version: string;
  commit: string;
  tag: string | null;
  channel: string;
  services: {
    feedback: ManifestServiceRef;
    updater: ManifestServiceRef | null;
  };
  platform: string | null;
  dbSchemaVersion: number | null;
  requiredUpdaterProtocol: number;
  publishedAt: string | null;
}

export class ManifestError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ManifestError";
    this.field = field;
  }
}

export type ManifestOutcome =
  | { kind: "ok"; manifest: ReleaseManifest; source: "local" | "remote" | "cache"; location: string; note?: string }
  | { kind: "missing" }
  | { kind: "invalid"; error: string; location: string }
  | { kind: "unreachable"; error: string; url: string };

export interface ManifestPort {
  load(channel: string): Promise<ManifestOutcome>;
}

export interface ProtocolCompat {
  compatible: boolean;
  required: number;
  supported: number;
  guidance: string | null;
}

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSemver(value: string): boolean {
  return value.length <= 80 && SEMVER_PATTERN.test(value);
}

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}
const MANIFEST_VERSION = 1;

function requireString(raw: Record<string, unknown>, field: string, maxLength = 200): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestError(field, `清单字段 ${field} 缺失或不是非空字符串`);
  }
  if (value.length > maxLength) throw new ManifestError(field, `清单字段 ${field} 过长`);
  return value.trim();
}

function optionalString(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ManifestError(field, `清单字段 ${field} 必须是字符串`);
  return value.trim() || null;
}

function requireServiceRef(raw: unknown, field: string): ManifestServiceRef {
  if (!raw || typeof raw !== "object") throw new ManifestError(field, `清单字段 ${field} 缺失或不是对象`);
  const record = raw as Record<string, unknown>;
  const image = requireString(record, "image", 400);
  const digest = requireString(record, "digest", 100);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new ManifestError(`${field}.digest`, `清单字段 ${field}.digest 必须是 sha256:<64 位小写十六进制>`);
  }
  return { image, digest };
}

export function parseManifest(raw: unknown, expectedChannel = "stable"): ReleaseManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("root", "清单不是 JSON 对象");
  }
  const record = raw as Record<string, unknown>;
  const manifestVersion = record.manifestVersion;
  if (manifestVersion !== MANIFEST_VERSION) {
    throw new ManifestError(
      "manifestVersion",
      `清单版本不受支持（期望 ${MANIFEST_VERSION}，实际 ${JSON.stringify(manifestVersion)}）`,
    );
  }
  const version = requireString(record, "version", 80);
  if (!SEMVER_PATTERN.test(version)) {
    throw new ManifestError("version", `清单 version 不是 semver：${version}`);
  }
  const channel = requireString(record, "channel", 40);
  if (channel !== expectedChannel) {
    throw new ManifestError("channel", `清单渠道为 ${channel}，与请求的 ${expectedChannel} 不一致`);
  }
  const commit = requireString(record, "commit", 80);
  const servicesRaw = record.services;
  if (!servicesRaw || typeof servicesRaw !== "object") {
    throw new ManifestError("services", "清单字段 services 缺失");
  }
  const servicesRecord = servicesRaw as Record<string, unknown>;
  const feedback = requireServiceRef(servicesRecord.feedback, "services.feedback");
  const updater =
    servicesRecord.updater === undefined || servicesRecord.updater === null
      ? null
      : requireServiceRef(servicesRecord.updater, "services.updater");

  const requiredRaw = record.requiredUpdaterProtocol;
  if (!Number.isInteger(requiredRaw) || (requiredRaw as number) < 1) {
    throw new ManifestError("requiredUpdaterProtocol", "清单字段 requiredUpdaterProtocol 必须是 ≥1 的整数");
  }
  const dbSchemaRaw = record.dbSchemaVersion;
  let dbSchemaVersion: number | null = null;
  if (dbSchemaRaw !== undefined && dbSchemaRaw !== null) {
    if (!Number.isInteger(dbSchemaRaw) || (dbSchemaRaw as number) < 0) {
      throw new ManifestError("dbSchemaVersion", "清单字段 dbSchemaVersion 必须是非负整数");
    }
    dbSchemaVersion = dbSchemaRaw as number;
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    version,
    commit,
    tag: optionalString(record, "tag"),
    channel,
    services: { feedback, updater },
    platform: optionalString(record, "platform"),
    dbSchemaVersion,
    requiredUpdaterProtocol: requiredRaw as number,
    publishedAt: optionalString(record, "publishedAt"),
  };
}

export function checkProtocolCompat(manifest: ReleaseManifest, supported: number): ProtocolCompat {
  const required = manifest.requiredUpdaterProtocol;
  if (required > supported) {
    return {
      compatible: false,
      required,
      supported,
      guidance:
        `清单要求更新执行器协议 v${required}，本执行器仅实现 v${supported}（updater 0.1.0）。` +
        "请先在服务器上按 docs/deployment.md 手工升级 updater 容器（执行器不会重建自己），再重试更新。",
    };
  }
  return { compatible: true, required, supported, guidance: null };
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: "follow" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ManifestSourceOptions {
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: Logger;
  timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

interface ManifestCache {
  fetchedAt: string;
  url: string;
  channel: string;
  manifest: unknown;
}

/**
 * 清单来源优先级：部署目录内的 release-manifest.json（人工/离线安装与本地验证）→
 * GitHub Releases 远端清单（由 U1-3 流水线发布）→ 上次成功拉取的本地缓存。
 * 远端地址由 UPDATER_IMAGE_NAME 推导（ghcr.io/<owner>/<repo> → Releases latest）。
 */
export class ManifestSource implements ManifestPort {
  private readonly config: UpdaterConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly log: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(config: UpdaterConfig, options: ManifestSourceOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async load(channel: string): Promise<ManifestOutcome> {
    for (const file of this.config.manifestLocalFiles) {
      const raw = await readTextFileIfExists(file);
      if (raw === null) continue;
      try {
        const manifest = parseManifest(JSON.parse(raw), channel);
        return { kind: "ok", manifest, source: "local", location: file };
      } catch (err) {
        return { kind: "invalid", error: (err as Error).message, location: file };
      }
    }

    const url = this.config.manifestRemoteUrl;
    if (!url) return { kind: "missing" };

    try {
      const text = await this.fetchWithTimeout(url);
      const manifest = parseManifest(JSON.parse(text), channel);
      const cache: ManifestCache = { fetchedAt: this.now().toISOString(), url, channel, manifest };
      await writeJsonAtomic(this.config.manifestCacheFile, cache, 0o600);
      return { kind: "ok", manifest, source: "remote", location: url };
    } catch (err) {
      const message = (err as Error).message;
      this.log?.warn("远端版本清单不可用，尝试本地缓存", { url, error: message });
      const cached = await this.readCache(channel);
      if (cached) {
        return {
          kind: "ok",
          manifest: cached,
          source: "cache",
          location: this.config.manifestCacheFile,
          note: `远端清单不可用（${message}），使用上次缓存`,
        };
      }
      return { kind: "unreachable", error: message, url };
    }
  }

  private async readCache(channel: string): Promise<ReleaseManifest | null> {
    const raw = await readTextFileIfExists(this.config.manifestCacheFile);
    if (raw === null) return null;
    try {
      const cache = JSON.parse(raw) as ManifestCache;
      if (cache.channel !== channel) return null;
      return parseManifest(cache.manifest, channel);
    } catch {
      return null;
    }
  }

  private async fetchWithTimeout(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
