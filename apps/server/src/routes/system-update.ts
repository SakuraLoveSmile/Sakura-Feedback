import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { createRateLimiter } from "../auth/ratelimit.ts";
import type { Db } from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import { checkLimiter, checkStrictSameOrigin, type Err, fail, isErr, requireAdminCookie } from "../http.ts";

/**
 * 后台「检查更新」——只做版本检查，**绝不安装**。
 *
 * v0.5.1 起移除了 updater 执行器链路（发起更新、任务进度、暂停写入全部取消）：
 * 检查 = 服务端直接拉取 GitHub Release 的 `release-manifest.json` 并与本机版本比较；
 * 更新动作回归人工（`deploy/update.sh` 或 `docker compose pull && up -d`）。
 *
 * 安全模型：
 * - 清单地址来自部署侧配置（`FEEDBACK_UPDATE_MANIFEST_URL`），客户端不能指定检查目标；
 * - 检查结果只读展示：远端不可达/清单缺失只体现为「检查失败」，绝不影响正在运行的服务；
 * - 结果缓存到 `FEEDBACK_DATA_DIR/update-check.json`（写不进去就退化为内存缓存），
 *   供后台页面与自动检查循环复用。
 */

// ============================================================================
// 1) 当前版本（从 package.json 读取；读不到只影响展示）
// ============================================================================

/** 未知版本占位（只在真的读不到 package.json 时使用）。 */
export const UNKNOWN_VERSION = "0.0.0-unknown";
/** 本包名：用于在多个候选 package.json 中挑出「本服务」的那一个。 */
const SERVER_PACKAGE_NAME = "@feedback/server";

/**
 * 由模块目录推导候选 package.json 路径。
 *
 * 两种真实布局都必须命中（均「向上两级」到包根，`..` 相对写法与部署绝对路径无关）：
 * - 构建产物：`/app/server/dist/routes/system-update.js` → `/app/server/package.json`
 *   （Dockerfile 里 `pnpm deploy → /app/server`，package.json 与 dist/ 同级）
 * - tsx 直跑源码：`apps/server/src/routes/system-update.ts` → `apps/server/package.json`
 *
 * 额外多探 `..` 与 `../../..` 作为容错（未来目录层级变化时不至于再次恒为未知版本）；
 * 候选按优先级排序，由调用方按包名择优选第一个可解析且有 version 的。
 */
export function candidatePackageJsonPaths(moduleDir: string): string[] {
  return [
    path.resolve(moduleDir, "..", "..", "package.json"),
    path.resolve(moduleDir, "..", "package.json"),
    path.resolve(moduleDir, "..", "..", "..", "package.json"),
  ];
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 文件不存在 / 非法 JSON：跳过该候选（只影响展示，绝不影响服务启动）。
  }
  return null;
}

/**
 * 读取本包 package.json 的 version。
 * 优先选包名等于 `@feedback/server` 的候选；否则退回第一个可解析出非空 version 的候选。
 * `moduleDir` 可注入（默认本模块目录），以便在测试里模拟两种真实布局。
 */
export function readPackageVersion(moduleDir: string = import.meta.dirname): string {
  let fallback: string | null = null;
  for (const candidate of candidatePackageJsonPaths(moduleDir)) {
    const parsed = readJsonObject(candidate);
    if (!parsed) continue;
    const version = parsed.version;
    if (typeof version !== "string" || version.trim() === "") continue;
    if (parsed.name === SERVER_PACKAGE_NAME) return version;
    fallback ??= version;
  }
  return fallback ?? UNKNOWN_VERSION;
}

/** 进程内只读一次。 */
export const SERVER_VERSION = readPackageVersion();

// ============================================================================
// 2) Release 清单（直连 GitHub Release 资产）
// ============================================================================

/** 与 release.yml 生成的 release-manifest.json 契约保持一致。 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface ManifestSummary {
  manifestVersion: number | null;
  version: string;
  commit: string | null;
  tag: string | null;
  channel: string;
  services: {
    feedback: { image: string; digest: string } | null;
  };
  platform: string | null;
  dbSchemaVersion: number | null;
  publishedAt: string | null;
  /** 发布说明（清单可带 notes / releaseNotes；缺失即为 null）。 */
  notes: string | null;
}

export interface ManifestError {
  code: "manifest_unreachable" | "manifest_http_error" | "manifest_bad_response" | "manifest_not_configured";
  message: string;
}

export type ManifestResult = { ok: true; value: ManifestSummary } | { ok: false; error: ManifestError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asInt(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

/**
 * 解析 Release 清单。
 * 严格程度与生成端契约一致：manifestVersion 必须为 1、version 必须是 semver、
 * services.feedback 必须带合法 digest——**宁可判检查失败，也不把半截清单当成新版本**。
 * （0.5.1 起清单不再带 services.updater / requiredUpdaterProtocol，解析器不依赖它们。）
 */
export function parseManifest(raw: unknown): ManifestSummary | null {
  if (!isRecord(raw)) return null;
  if (asInt(raw.manifestVersion) !== 1) return null;
  const version = asString(raw.version);
  if (!version || !SEMVER_PATTERN.test(version)) return null;
  const channel = asString(raw.channel);
  if (!channel) return null;
  const servicesRaw = isRecord(raw.services) ? raw.services : null;
  if (!servicesRaw) return null;
  const feedbackRaw = isRecord(servicesRaw.feedback) ? servicesRaw.feedback : null;
  if (!feedbackRaw) return null;
  const feedbackImage = asString(feedbackRaw.image);
  const feedbackDigest = asString(feedbackRaw.digest);
  if (!feedbackImage || !feedbackDigest || !DIGEST_PATTERN.test(feedbackDigest)) return null;
  return {
    manifestVersion: 1,
    version,
    commit: asString(raw.commit),
    tag: asString(raw.tag),
    channel,
    services: {
      feedback: { image: feedbackImage, digest: feedbackDigest },
    },
    platform: asString(raw.platform),
    dbSchemaVersion: asInt(raw.dbSchemaVersion),
    publishedAt: asString(raw.publishedAt),
    notes: asString(raw.releaseNotes) ?? asString(raw.notes),
  };
}

/** 拉取并解析清单；任何失败都映射为明确错误（不抛异常给调用方）。 */
export async function fetchManifest(
  manifestUrl: string | null,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ManifestResult> {
  if (!manifestUrl) {
    return {
      ok: false,
      error: { code: "manifest_not_configured", message: "未配置版本清单地址（FEEDBACK_UPDATE_MANIFEST_URL）" },
    };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let res: Response;
  try {
    res = await doFetch(manifestUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (e) {
    return {
      ok: false,
      error: { code: "manifest_unreachable", message: `版本清单不可达：${(e as Error).message}` },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: { code: "manifest_http_error", message: `版本清单请求失败：HTTP ${res.status}` },
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: { code: "manifest_bad_response", message: "版本清单不是合法 JSON" },
    };
  }
  const manifest = parseManifest(json);
  if (!manifest) {
    return {
      ok: false,
      error: { code: "manifest_bad_response", message: "版本清单无法解析（字段缺失或格式不符）" },
    };
  }
  return { ok: true, value: manifest };
}

/**
 * 由清单地址推导 Release 页面链接（管理页「查看该版本」入口）。
 * `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json`
 *   → `https://github.com/<owner>/<repo>/releases/tag/<tag>`（无 tag 时用 /releases/latest）。
 * 非 github.com 地址返回清单地址本身。
 */
export function deriveReleasePageUrl(manifestUrl: string, tag: string | null): string {
  const base = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//.exec(manifestUrl)?.[1] ?? null;
  if (!base) return manifestUrl;
  return tag ? `${base}/releases/tag/${tag}` : `${base}/releases/latest`;
}

/** semver 比较（只比较 X.Y.Z 核心段；任意一边不可解析时退回全等比较）。 */
export function compareSemver(a: string, b: string): number {
  const core = (v: string) => (v.split(/[-+]/)[0] ?? "").split(".").map(Number);
  const pa = core(a);
  const pb = core(b);
  if (pa.some((n) => !Number.isInteger(n)) || pb.some((n) => !Number.isInteger(n))) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ============================================================================
// 3) 检查服务（只检查，绝不安装）
// ============================================================================

export type CheckState = "ok" | "up_to_date" | "failed" | "never";

export interface CheckView {
  state: CheckState;
  checkedAt: string | null;
  source: string | null;
  latest: {
    version: string;
    tag: string | null;
    notes: string | null;
    publishedAt: string | null;
    digest: string | null;
    image: string | null;
    releaseUrl: string | null;
  } | null;
  failedCode: string | null;
  failedMessage: string | null;
}

export interface SystemUpdateStatus {
  current: { version: string };
  config: {
    /** 版本清单地址；null 表示检查功能被显式关闭（FEEDBACK_UPDATE_MANIFEST_URL=off）。 */
    manifestUrl: string | null;
    checkIntervalMs: number;
  };
  check: CheckView;
}

export interface SystemUpdateService {
  status(): SystemUpdateStatus;
  check(): Promise<CheckView>;
  /** 自动检查循环：仅在超过间隔时真正发起检查，返回是否检查过。 */
  runAutoCheck(): Promise<boolean>;
  close(): void;
}

export interface SystemUpdateServiceDeps {
  currentVersion: string;
  manifestUrl: string | null;
  checkIntervalMs: number;
  /** 检查结果缓存文件（通常位于 FEEDBACK_DATA_DIR 下）；不可写时退化为内存缓存。 */
  stateFile?: string | null;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  now?: () => number;
  /** 自动检查循环的调度器（测试注入；默认 setTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

interface PersistedCheck {
  checkedAt: number;
  view: CheckView;
}

function emptyCheck(state: CheckState): CheckView {
  return {
    state,
    checkedAt: null,
    source: null,
    latest: null,
    failedCode: null,
    failedMessage: null,
  };
}

/**
 * 检查结果缓存：写 `<stateFile>`（临时文件 + rename），读取容忍缺失/损坏。
 * 与数据目录同盘，权限继承目录；写失败绝不影响服务运行。
 */
function createCheckStore(stateFile: string | null) {
  function read(): PersistedCheck | null {
    if (!stateFile) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!isRecord(parsed) || typeof parsed.checkedAt !== "number" || !isRecord(parsed.view)) return null;
      return parsed as unknown as PersistedCheck;
    } catch {
      return null;
    }
  }
  function write(record: PersistedCheck): void {
    if (!stateFile) return;
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(record)}\n`, "utf8");
      renameSync(tmp, stateFile);
    } catch {
      // 缓存写不进去：内存里仍有一份，绝不因此报错
    }
  }
  return { read, write };
}

export function createSystemUpdateService(deps: SystemUpdateServiceDeps): SystemUpdateService {
  const { currentVersion, manifestUrl, checkIntervalMs } = deps;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const store = createCheckStore(deps.stateFile ?? null);

  /** 内存中的检查结果（持久化失败时仍可用）。 */
  let memory: PersistedCheck | null = null;
  let timer: { unref?: () => void } | null = null;
  let closed = false;

  function loadPersisted(): PersistedCheck | null {
    const fromDisk = store.read();
    if (memory && fromDisk) return fromDisk.checkedAt >= memory.checkedAt ? fromDisk : memory;
    return fromDisk ?? memory;
  }

  function persist(record: PersistedCheck): void {
    memory = record;
    store.write(record);
  }

  function currentCheckView(): CheckView {
    const persisted = loadPersisted();
    if (!persisted) return emptyCheck("never");
    return persisted.view;
  }

  function buildCheckView(outcome: ManifestResult, at: number): CheckView {
    if (!outcome.ok) {
      return {
        ...emptyCheck("failed"),
        checkedAt: new Date(at).toISOString(),
        source: manifestUrl,
        failedCode: outcome.error.code,
        failedMessage: outcome.error.message,
      };
    }
    const { value: manifest } = outcome;
    const upToDate = compareSemver(manifest.version, currentVersion) <= 0;
    return {
      state: upToDate ? "up_to_date" : "ok",
      checkedAt: new Date(at).toISOString(),
      source: manifestUrl,
      latest: {
        version: manifest.version,
        tag: manifest.tag,
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        digest: manifest.services.feedback?.digest ?? null,
        image: manifest.services.feedback?.image ?? null,
        releaseUrl: manifestUrl ? deriveReleasePageUrl(manifestUrl, manifest.tag) : null,
      },
      failedCode: null,
      failedMessage: null,
    };
  }

  function status(): SystemUpdateStatus {
    return {
      current: { version: currentVersion },
      config: { manifestUrl, checkIntervalMs },
      check: currentCheckView(),
    };
  }

  async function check(): Promise<CheckView> {
    const at = now();
    const result = await fetchManifest(manifestUrl, {
      fetchImpl: doFetch,
      ...(deps.fetchTimeoutMs !== undefined ? { timeoutMs: deps.fetchTimeoutMs } : {}),
    });
    const view = buildCheckView(result, at);
    persist({ checkedAt: at, view });
    return view;
  }

  async function runAutoCheck(): Promise<boolean> {
    const persisted = loadPersisted();
    if (persisted && now() - persisted.checkedAt < checkIntervalMs) return false;
    await check();
    return true;
  }

  function close(): void {
    closed = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  // 自动检查循环：**只检查不安装**（更新只能由管理员在服务器上手动执行）。
  if (checkIntervalMs > 0) {
    const tick = (): void => {
      if (closed) return;
      void runAutoCheck()
        .catch(() => false)
        .finally(() => {
          if (!closed) timer = setTimer(tick, checkIntervalMs);
        });
    };
    timer = setTimer(tick, checkIntervalMs);
    timer.unref?.();
  }

  return { status, check, runAutoCheck, close };
}

// ============================================================================
// 4) 路由
// ============================================================================

export interface SystemUpdateDeps {
  db: Db;
  config: ServerConfig;
  system: SystemUpdateService;
}

const CHECK_LIMIT = 30;
const CHECK_WINDOW_MS = 15 * 60 * 1000;

export function systemUpdateRoutes(deps: SystemUpdateDeps): Hono {
  const { db, config, system } = deps;
  const routes = new Hono();

  routes.use("*", async (c, next) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const originErr = checkStrictSameOrigin(c, config);
    if (originErr) return fail(c, originErr);
    await next();
  });

  const actionLimiter = createRateLimiter(CHECK_LIMIT, CHECK_WINDOW_MS);

  /** GET /api/admin/system/update：当前版本 + 检查配置 + 最近一次检查结果。 */
  routes.get("/update", (c) => c.json(system.status()));

  /** POST /api/admin/system/update/check：手动检查（只读，绝不安装）。 */
  routes.post("/update/check", async (c) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const limited = checkLimiter(actionLimiter, s.user_id);
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }
    const check = await system.check();
    return c.json({ check });
  });

  return routes;
}
