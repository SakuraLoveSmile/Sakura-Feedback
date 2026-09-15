import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { createRateLimiter } from "../auth/ratelimit.ts";
import type { Db } from "../db/repos.ts";
import { type ServerConfig, SUPPORTED_UPDATER_PROTOCOL } from "../env.ts";
import {
  checkLimiter,
  checkStrictSameOrigin,
  type Err,
  err,
  fail,
  isErr,
  readJson,
  requireAdminCookie,
} from "../http.ts";

/**
 * U1-4：后台「系统更新」——接口、执行器客户端、暂停控制面与检查/进度聚合。
 *
 * 为什么集中在一个文件：t6 契约的 inScope 是**已存在文件的严格白名单**，不允许新增模块文件，
 * 因此控制面读取、上游客户端与聚合服务都收敛在这里，按下面的分节组织（逻辑边界不变）。
 *
 * 安全模型：
 * - 反馈服务只做代理与展示；停服、复制卷、换镜像、核验、放行全部由独立 updater 执行器按预配置完成。
 * - `POST /api/admin/system/update` 只转发 `{requestId, version, digest}`；路径、命令、镜像、卷名一律拒绝。
 * - 令牌只从 `FEEDBACK_UPDATE_TOKEN_FILE`（600 权限）读取，只进 `x-updater-token` 请求头，绝不进入日志/响应/前端。
 * - 控制目录（`FEEDBACK_UPDATE_CONTROL_DIR`）只读：读 paused 标记与 state/tasks/*.json；自有状态写 feedback-state/。
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
// 2) 暂停控制面（只读共享控制目录）
// ============================================================================

/** 操作 ID：1..128 位的 [A-Za-z0-9._:-]（与执行器 http.ts 一致）。 */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * U1-4：与 updater 执行器共享的控制目录（反馈服务**只读挂载**同一目录）。
 *
 * 读取的文件（全部由执行器写入，反馈服务绝不修改）：
 * - `paused`：存在即表示「更新进行中，业务写入必须拒绝」；内容为 JSON（阶段/说明），供后台展示。
 * - `state/tasks/<operationId>.json`：任务状态，执行器每个阶段边界原子落盘。
 *
 * 反馈服务自己只写 `feedback-state/`（上次检查结果缓存）。该子目录在只读挂载下不可写，
 * 此时退化为进程内内存缓存，绝不影响服务运行。
 */
export interface PauseMarkerInfo {
  /** 暂停标记的阶段（执行器 phaseId）与可读文案；内容损坏时为 null。 */
  phase: string | null;
  phaseLabel: string | null;
  message: string | null;
  operationId: string | null;
  version: string | null;
  updatedAt: string | null;
  /** 标记内容不是合法 JSON 时，仍按「已暂停」处理，只把原因透出给后台。 */
  parseError: string | null;
}

export interface PauseState {
  paused: boolean;
  since: string | null;
  marker: PauseMarkerInfo | null;
}

/** 后台展示用的任务快照（与执行器任务文件里的字段同名，避免二次翻译）。 */
export interface TaskSnapshot {
  operationId: string;
  requestId: string | null;
  version: string | null;
  digest: string | null;
  status: string;
  outcome: string | null;
  phase: string;
  phaseLabel: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failure: { phase: string; code: string; message: string } | null;
  recoveryHint: string | null;
  warnings: string[];
  evidence: { at: string; phase: string; step: string; ok: boolean; detail?: string }[];
}

/** 阶段/终态的界面文案（与执行器 PHASE_LABELS、TaskOutcome 对齐）。 */
export const PHASE_LABELS: Record<string, string> = {
  accepted: "已受理",
  preflight_pull: "①预检并拉取",
  pause_stop: "②暂停并停服",
  backup_copy: "③保留备份并复制",
  start_paused: "④启动验证",
  verify_new: "⑤核验新版",
  release: "⑥放行",
  done: "完成",
};

export const OUTCOME_LABELS: Record<string, string> = {
  succeeded: "更新成功",
  failed_no_changes: "更新失败，未改动部署",
  failed_restored: "更新失败，已恢复旧版本",
  needs_attention: "需要处理",
};

/** 暂停标记缺省文案：内容损坏时也必须给出可读提示。 */
export const PAUSE_DEFAULT_MESSAGE = "系统更新进行中，本服务的写入操作暂时不可用";
/** 暂停期间业务写入被拒绝时使用的错误码（对客户端可见）。 */
export const PAUSE_ERROR_CODE = "update_paused";

export interface ControlPlaneOptions {
  /** 控制目录；未配置（本地开发/测试）时视为「永不暂停」。 */
  controlDir: string | null;
  /** paused 标记的读取缓存（毫秒）：0 表示每次请求都读盘。 */
  ttlMs?: number;
  now?: () => number;
}

export interface ControlPlane {
  readonly controlDir: string | null;
  isWritePaused(): boolean;
  readPause(): PauseState;
  readTask(operationId: string): TaskSnapshot | null;
  listRecentTasks(limit?: number): TaskSnapshot[];
  /** 读取反馈服务自己的持久状态（只读挂载下可能为空）。 */
  readOwnState<T>(name: string): T | null;
  /** 写入反馈服务自己的持久状态；只读挂载或磁盘异常时返回 false（绝不影响服务）。 */
  writeOwnState(name: string, value: unknown): boolean;
}

const DEFAULT_TTL_MS = 250;
const MAX_SCANNED_TASKS = 500;
const DEFAULT_RECENT_TASKS = 10;
const OWN_STATE_DIRNAME = "feedback-state";

function readTextIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toTaskSnapshot(raw: unknown): TaskSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const operationId = str(record.operationId);
  const status = str(record.status);
  const phase = str(record.phase);
  if (!operationId || !status || !phase) return null;
  const failure = record.failure;
  const restore = record.restore;
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const at = str(entry.at);
        const step = str(entry.step);
        if (!at || !step) return [];
        const detail = str(entry.detail);
        return [
          {
            at,
            phase: str(entry.phase) ?? phase,
            step,
            ok: entry.ok === true,
            ...(detail ? { detail } : {}),
          },
        ];
      })
    : [];
  // 任务文件里 phaseLabel 由执行器写入；缺失时按本地映射补齐，保证后台始终有中文阶段名。
  const phaseLabel = str(record.phaseLabel) ?? PHASE_LABELS[phase] ?? phase;
  const restoreNote = restore && typeof restore === "object" ? (restore as Record<string, unknown>).note : undefined;
  const restoreHint = str(restoreNote);
  return {
    operationId,
    requestId: str(record.requestId),
    version: str(record.version),
    digest: str(record.digest),
    status,
    outcome: str(record.outcome),
    phase,
    phaseLabel,
    message: str(record.message) ?? phaseLabel,
    createdAt: str(record.createdAt) ?? "",
    updatedAt: str(record.updatedAt) ?? "",
    startedAt: str(record.startedAt),
    finishedAt: str(record.finishedAt),
    failure:
      failure && typeof failure === "object"
        ? {
            phase: str((failure as Record<string, unknown>).phase) ?? phase,
            code: str((failure as Record<string, unknown>).code) ?? "unknown",
            message: str((failure as Record<string, unknown>).message) ?? "更新失败",
          }
        : null,
    recoveryHint: str(record.recoveryHint) ?? restoreHint,
    warnings,
    evidence,
  };
}

/**
 * 控制目录读取器。所有读取都是「尽力而为」：文件缺失/损坏绝不影响反馈服务的正常运行。
 */
export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const controlDir = options.controlDir;
  const pausedFile = controlDir ? path.join(controlDir, "paused") : null;
  const tasksDir = controlDir ? path.join(controlDir, "state", "tasks") : null;
  const ownStateDir = controlDir ? path.join(controlDir, OWN_STATE_DIRNAME) : null;

  let cache: { at: number; value: PauseState } | null = null;

  function readPauseUncached(): PauseState {
    if (!pausedFile) return { paused: false, since: null, marker: null };
    let raw: string | null;
    try {
      raw = readFileSync(pausedFile, "utf8");
    } catch (err) {
      // 文件不存在（正常解除暂停）与其它错误一律按「未暂停」处理：绝不因控制面异常阻断业务写入。
      void err;
      return { paused: false, since: null, marker: null };
    }
    const parsed = safeJson<Record<string, unknown>>(raw);
    if (!parsed) {
      return {
        paused: true,
        since: null,
        marker: {
          phase: null,
          phaseLabel: null,
          message: PAUSE_DEFAULT_MESSAGE,
          operationId: null,
          version: null,
          updatedAt: null,
          parseError: "paused 标记不是合法 JSON 对象（仍按已暂停处理）",
        },
      };
    }
    const phase = str(parsed.phase);
    const updatedAt = str(parsed.updatedAt) ?? str(parsed.startedAt);
    return {
      paused: true,
      since: str(parsed.startedAt) ?? updatedAt,
      marker: {
        phase,
        phaseLabel: phase ? (PHASE_LABELS[phase] ?? phase) : null,
        message: str(parsed.message) ?? PAUSE_DEFAULT_MESSAGE,
        operationId: str(parsed.operationId),
        version: str(parsed.version),
        updatedAt,
        parseError: null,
      },
    };
  }

  function readPause(): PauseState {
    if (ttlMs <= 0) return readPauseUncached();
    const at = now();
    if (cache && at - cache.at < ttlMs) return cache.value;
    const value = readPauseUncached();
    cache = { at, value };
    return value;
  }

  function readTask(operationId: string): TaskSnapshot | null {
    if (!tasksDir || !OPERATION_ID_PATTERN.test(operationId)) return null;
    const raw = readTextIfExists(path.join(tasksDir, `${operationId}.json`));
    if (raw === null) return null;
    return toTaskSnapshot(safeJson(raw));
  }

  function listRecentTasks(limit = DEFAULT_RECENT_TASKS): TaskSnapshot[] {
    if (!tasksDir) return [];
    let names: string[];
    try {
      names = readdirSync(tasksDir);
    } catch {
      return [];
    }
    const records: TaskSnapshot[] = [];
    for (const name of names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .slice(-MAX_SCANNED_TASKS)) {
      const raw = readTextIfExists(path.join(tasksDir, name));
      if (raw === null) continue;
      const record = toTaskSnapshot(safeJson(raw));
      if (record) records.push(record);
    }
    // 最近创建/更新在前；同批文件按 updatedAt 排序保证「最近任务」语义稳定。
    records.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    return records.slice(0, limit);
  }

  function readOwnState<T>(name: string): T | null {
    if (!ownStateDir) return null;
    const raw = readTextIfExists(path.join(ownStateDir, `${name}.json`));
    if (raw === null) return null;
    return safeJson<T>(raw);
  }

  function writeOwnState(name: string, value: unknown): boolean {
    if (!ownStateDir) return false;
    const file = path.join(ownStateDir, `${name}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      mkdirSync(ownStateDir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch {
      // 只读挂载（生产）或磁盘异常：退化为内存缓存，绝不把异常抛给业务请求。
      return false;
    }
  }

  return {
    controlDir,
    isWritePaused: () => readPause().paused,
    readPause,
    readTask,
    listRecentTasks,
    readOwnState,
    writeOwnState,
  };
}
// ============================================================================
// 3) updater 执行器 HTTP 客户端
// ============================================================================

/** 与执行器 manifest.ts 的 SEMVER_PATTERN / DIGEST_PATTERN 保持一致。 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 操作/请求 ID：1..128 位的 [A-Za-z0-9._:-]（与执行器 http.ts 一致）。 */

/**
 * U1-4：反馈服务到 updater 执行器的内网客户端（`http://updater:8790`）。
 *
 * 约束（与执行器冻结协议一致）：
 * - 全部请求带 `x-updater-token`，令牌**只**从 `FEEDBACK_UPDATE_TOKEN_FILE`（600 权限）读取；
 *   令牌绝不写入日志、响应或前端。
 * - `POST /tasks` 只转发 `{requestId, version, digest}` 三个字段，绝不透传路径/命令/镜像/卷名。
 * - 上游不可达、超时、返回非 JSON 都映射为**明确错误**（不抛 500 堆栈给客户端）。
 */
export type UpdaterErrorCode =
  | "updater_not_configured"
  | "updater_token_missing"
  | "updater_unreachable"
  | "updater_http_error"
  | "updater_conflict"
  | "updater_bad_response"
  | "updater_not_found";

export interface UpdaterError {
  code: UpdaterErrorCode;
  status: number;
  message: string;
  /** 执行器返回的结构化细节（不包含令牌）。 */
  detail?: unknown;
}

export interface UpdateTaskRequest {
  requestId: string;
  version: string;
  digest: string;
}

export interface UpdateTaskAccepted {
  operationId: string;
  status: string;
  phase?: string;
  deduplicated?: boolean;
}

export interface ManifestSummary {
  manifestVersion: number | null;
  version: string;
  commit: string | null;
  tag: string | null;
  channel: string;
  services: {
    feedback: { image: string; digest: string } | null;
    updater: { image: string; digest: string } | null;
  };
  platform: string | null;
  dbSchemaVersion: number | null;
  requiredUpdaterProtocol: number | null;
  publishedAt: string | null;
  /** 发布说明（清单可带 notes / releaseNotes；缺失即为 null）。 */
  notes: string | null;
}

export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: UpdaterError };

export interface UpdaterClientOptions {
  /** updater 基础地址；null 表示未配置（更新功能整体不可用）。 */
  baseUrl: string | null;
  tokenFile: string | null;
  timeoutMs?: number;
  /** 令牌文件读取缓存（毫秒）：令牌更新后最多滞后这么久生效。 */
  tokenTtlMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface UpdaterClient {
  /** 是否配置了上游地址（未配置时前端应显示「未接入更新执行器」）。 */
  readonly configured: boolean;
  readonly baseUrl: string | null;
  readonly tokenFile: string | null;
  healthz(): Promise<
    ClientResult<{ ok: boolean; version: string | null; protocolVersion: number | null; busy: boolean }>
  >;
  manifest(): Promise<ClientResult<ManifestSummary>>;
  createTask(request: UpdateTaskRequest): Promise<ClientResult<UpdateTaskAccepted>>;
  getTask(operationId: string): Promise<ClientResult<Record<string, unknown> | null>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_MS = 30_000;

export class TokenUnavailableError extends Error {
  constructor(
    readonly code: "updater_token_missing" | "updater_not_configured",
    message: string,
  ) {
    super(message);
    this.name = "TokenUnavailableError";
  }
}

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
 * 解析执行器清单响应。
 * 与执行器侧 `parseManifest` 同样严格：manifestVersion 必须为 1、version 必须是 semver、
 * services.feedback 必须带合法 digest——**宁可判检查失败，也不把半截清单当成可更新目标**。
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
  const serviceRef = (value: unknown) => {
    if (!isRecord(value)) return null;
    const image = asString(value.image);
    const digest = asString(value.digest);
    return image && digest ? { image, digest } : null;
  };
  const services = servicesRaw as Record<string, unknown>;
  return {
    manifestVersion: 1,
    version,
    commit: asString(raw.commit),
    tag: asString(raw.tag),
    channel,
    services: {
      feedback: { image: feedbackImage, digest: feedbackDigest },
      updater: serviceRef(services.updater),
    },
    platform: asString(raw.platform),
    dbSchemaVersion: asInt(raw.dbSchemaVersion),
    requiredUpdaterProtocol: asInt(raw.requiredUpdaterProtocol),
    publishedAt: asString(raw.publishedAt),
    notes: asString(raw.releaseNotes) ?? asString(raw.notes),
  };
}

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient {
  const baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : null;
  const tokenFile = options.tokenFile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;

  let tokenCache: { at: number; value: string } | null = null;

  function readToken(): string {
    if (!tokenFile) {
      throw new TokenUnavailableError(
        "updater_not_configured",
        "未配置 FEEDBACK_UPDATE_TOKEN_FILE（更新功能未接入执行器）",
      );
    }
    const at = now();
    if (tokenCache && at - tokenCache.at < tokenTtlMs) return tokenCache.value;
    let raw: string;
    try {
      raw = readFileSync(tokenFile, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new TokenUnavailableError(
          "updater_token_missing",
          "更新执行器令牌文件不存在（应由 deploy/install-updater.sh 生成 600 权限的共享令牌）",
        );
      }
      throw new TokenUnavailableError("updater_token_missing", `更新执行器令牌文件不可读：${(err as Error).message}`);
    }
    const value = raw.trim();
    if (value.length < 16) {
      throw new TokenUnavailableError("updater_token_missing", "更新执行器令牌文件内容过短");
    }
    tokenCache = { at, value };
    return value;
  }

  async function call(
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: unknown,
  ): Promise<ClientResult<{ status: number; json: unknown }>> {
    if (!baseUrl) {
      return {
        ok: false,
        error: {
          code: "updater_not_configured",
          status: 503,
          message: "未配置 FEEDBACK_UPDATE_URL（更新功能未接入执行器）",
        },
      };
    }
    let token: string;
    try {
      token = readToken();
    } catch (err) {
      const e = err as TokenUnavailableError;
      return { ok: false, error: { code: e.code, status: 503, message: e.message } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${pathAndQuery}`, {
        method,
        headers: {
          "x-updater-token": token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === "AbortError" ? `请求超时（${timeoutMs}ms）` : (err as Error).message;
      return {
        ok: false,
        error: {
          code: "updater_unreachable",
          status: 502,
          message: `更新执行器不可达：${reason}（本服务保持运行，可稍后重试检查）`,
        },
      };
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return {
        ok: false,
        error: { code: "updater_unreachable", status: 502, message: `读取执行器响应失败：${(err as Error).message}` },
      };
    }
    let json: unknown = null;
    let parseError = false;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      parseError = true;
    }
    if (parseError) {
      return {
        ok: false,
        error: {
          code: "updater_bad_response",
          status: 502,
          message: `更新执行器返回非 JSON 响应（HTTP ${response.status}）`,
        },
      };
    }
    if (!response.ok) {
      const detail = isRecord(json) ? json : null;
      const message = asString(detail?.message) ?? asString(detail?.error) ?? `更新执行器返回 HTTP ${response.status}`;
      return {
        ok: false,
        error: {
          code: response.status === 409 ? "updater_conflict" : "updater_http_error",
          status: response.status,
          message,
          detail: json,
        },
      };
    }
    return { ok: true, value: { status: response.status, json } };
  }

  return {
    configured: baseUrl !== null,
    baseUrl,
    tokenFile,
    async healthz() {
      const result = await call("GET", "/healthz");
      if (!result.ok) return result;
      const json = isRecord(result.value.json) ? result.value.json : {};
      return {
        ok: true,
        value: {
          ok: json.ok === true,
          version: asString(json.version),
          protocolVersion: asInt(json.protocolVersion),
          busy: json.busy === true,
        },
      };
    },
    async manifest() {
      const result = await call("GET", "/manifest?channel=stable");
      if (!result.ok) return result;
      const manifest = parseManifest(result.value.json);
      if (!manifest) {
        return {
          ok: false,
          error: { code: "updater_bad_response", status: 502, message: "更新执行器返回的版本清单无法解析" },
        };
      }
      return { ok: true, value: manifest };
    },
    async createTask(request) {
      // 只转发三个字段：白名单在这里再次收口，绝不透传任何部署细节。
      const result = await call("POST", "/tasks", {
        requestId: request.requestId,
        version: request.version,
        digest: request.digest,
      });
      if (!result.ok) return result;
      const json = isRecord(result.value.json) ? result.value.json : {};
      const operationId = asString(json.operationId);
      if (!operationId) {
        return {
          ok: false,
          error: { code: "updater_bad_response", status: 502, message: "更新执行器未返回 operationId" },
        };
      }
      return {
        ok: true,
        value: {
          operationId,
          status: asString(json.status) ?? "running",
          ...(asString(json.phase) ? { phase: asString(json.phase) as string } : {}),
          ...(json.deduplicated === true ? { deduplicated: true } : {}),
        },
      };
    },
    async getTask(operationId) {
      if (!OPERATION_ID_PATTERN.test(operationId)) {
        return {
          ok: false,
          error: { code: "updater_not_found", status: 404, message: "任务标识非法" },
        };
      }
      const result = await call("GET", `/tasks/${encodeURIComponent(operationId)}`);
      if (!result.ok) {
        // 上游没有该任务：作为「未知任务」透出，前端不据此判失败。
        if (result.error.status === 404) return { ok: true, value: null };
        return result;
      }
      return { ok: true, value: isRecord(result.value.json) ? result.value.json : null };
    },
  };
}
// ============================================================================
// 4) 检查 / 更新 / 进度聚合服务
// ============================================================================

/**
 * U1-4：后台「系统更新」的服务端聚合。
 *
 * 职责边界（安全模型）：
 * - 这里**只**代理三个字段 `{requestId, version, digest}` 与只读查询；部署路径、compose 文件、命令、
 *   镜像名、卷名全部由执行器按预配置决定，反馈服务不接触也绝不允许客户端提交。
 * - 检查是只读的：远端不可达/清单缺失只体现为「检查失败」状态，**绝不影响正在运行的服务**。
 * - 默认每 24 小时自动**检查**一次；**绝不定时自动安装**（安装只能由管理员在后台点击触发）。
 */

export type CheckState = "ok" | "up_to_date" | "incompatible" | "failed" | "never";

export interface CheckView {
  state: CheckState;
  checkedAt: string | null;
  source: string | null;
  latest: {
    version: string;
    notes: string | null;
    publishedAt: string | null;
    digest: string | null;
    image: string | null;
    requiredUpdaterProtocol: number | null;
  } | null;
  compatible: boolean;
  requiredProtocol: number | null;
  supportedProtocol: number;
  guidance: string | null;
  failedCode: string | null;
  failedMessage: string | null;
  warnings: string[];
}

export interface OperationView {
  operationId: string;
  requestId: string | null;
  version: string | null;
  digest: string | null;
  status: string;
  outcome: string | null;
  outcomeLabel: string | null;
  phase: string;
  phaseLabel: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failure: { phase: string; code: string; message: string } | null;
  recoveryHint: string | null;
  warnings: string[];
  evidence: { at: string; phase: string; step: string; ok: boolean; detail?: string }[];
}

export interface SystemUpdateStatus {
  current: { version: string; protocol: number };
  config: {
    updateConfigured: boolean;
    updaterBaseUrl: string | null;
    tokenFile: string | null;
    controlDir: string | null;
    protocolSupported: number;
    checkIntervalMs: number;
  };
  pause: PauseState;
  check: CheckView;
  recentOperations: OperationView[];
}

export interface StartUpdateInput {
  requestId: string;
  version: string;
  digest: string;
}

export type StartUpdateResult =
  | { kind: "accepted"; operationId: string; status: string; deduplicated: boolean }
  | { kind: "blocked"; error: UpdaterError }
  | { kind: "conflict"; message: string; operationId: string | null; phase: string | null };

export type OperationResult =
  | { kind: "known"; operation: OperationView; fromControlDir: boolean }
  | { kind: "unknown"; operationId: string }
  | { kind: "unreachable"; operationId: string; error: UpdaterError };

export interface SystemUpdateService {
  readonly control: ControlPlane;
  readonly client: UpdaterClient;
  status(): SystemUpdateStatus;
  check(): Promise<CheckView>;
  startUpdate(input: StartUpdateInput): Promise<StartUpdateResult>;
  operation(operationId: string): Promise<OperationResult>;
  /** 自动检查循环：仅在超过间隔时真正发起检查，返回是否检查过。 */
  runAutoCheck(): Promise<boolean>;
  close(): void;
}

export interface SystemUpdateServiceDeps {
  currentVersion: string;
  control: ControlPlane;
  client: UpdaterClient;
  checkIntervalMs: number;
  now?: () => number;
  /** 自动检查循环的调度器（测试注入；默认 setTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

const MAX_RECENT_OPERATIONS = 4;
const STATE_KEY = "last-check";

interface PersistedCheck {
  checkedAt: number;
  view: CheckView;
}

/** 终态判定：只有执行器给出的终态才算结束；本地读不到任务文件时**不**据此判失败。 */
export function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "needs_attention";
}

export function outcomeLabelFor(status: string, outcome: string | null): string | null {
  if (outcome === "succeeded") return "更新成功";
  if (outcome === "failed_no_changes") return "更新失败，未改动部署";
  if (outcome === "failed_restored") return "更新失败，已恢复旧版本";
  if (outcome === "needs_attention") return "需要处理";
  if (status === "running") return "更新进行中";
  return null;
}

export function toOperationView(task: TaskSnapshot): OperationView {
  return {
    operationId: task.operationId,
    requestId: task.requestId,
    version: task.version,
    digest: task.digest,
    status: task.status,
    outcome: task.outcome,
    outcomeLabel: outcomeLabelFor(task.status, task.outcome),
    phase: task.phase,
    phaseLabel: task.phaseLabel,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    failure: task.failure,
    recoveryHint: task.recoveryHint,
    warnings: task.warnings,
    evidence: task.evidence,
  };
}

function emptyCheck(state: CheckState, supported: number): CheckView {
  return {
    state,
    checkedAt: null,
    source: null,
    latest: null,
    compatible: true,
    requiredProtocol: null,
    supportedProtocol: supported,
    guidance: null,
    failedCode: null,
    failedMessage: null,
    warnings: [],
  };
}

export function createSystemUpdateService(deps: SystemUpdateServiceDeps): SystemUpdateService {
  const { control, client, currentVersion } = deps;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));

  /** 内存中的检查结果（持久化失败时仍可用）。 */
  let memory: PersistedCheck | null = null;
  let timer: { unref?: () => void } | null = null;
  let closed = false;

  function loadPersisted(): PersistedCheck | null {
    if (memory) {
      const fromDisk = control.readOwnState<PersistedCheck>(STATE_KEY);
      if (fromDisk && typeof fromDisk.checkedAt === "number" && fromDisk.view) {
        return fromDisk.checkedAt >= memory.checkedAt ? fromDisk : memory;
      }
      return memory;
    }
    const fromDisk = control.readOwnState<PersistedCheck>(STATE_KEY);
    if (fromDisk && typeof fromDisk.checkedAt === "number" && fromDisk.view) return fromDisk;
    return null;
  }

  function persist(record: PersistedCheck): void {
    memory = record;
    control.writeOwnState(STATE_KEY, record);
  }

  function currentCheckView(): CheckView {
    const persisted = loadPersisted();
    if (!persisted) return emptyCheck("never", SUPPORTED_UPDATER_PROTOCOL);
    return persisted.view;
  }

  function buildCheckView(
    outcome:
      | { kind: "manifest"; manifest: ManifestSummary; source: string; warnings: string[] }
      | { kind: "failed"; code: string; message: string; source?: string },
    at: number,
  ): CheckView {
    if (outcome.kind === "failed") {
      return {
        ...emptyCheck("failed", SUPPORTED_UPDATER_PROTOCOL),
        checkedAt: new Date(at).toISOString(),
        source: outcome.source ?? "updater",
        failedCode: outcome.code,
        failedMessage: outcome.message,
      };
    }
    const { manifest } = outcome;
    const required = manifest.requiredUpdaterProtocol;
    const compatible = required === null || required <= SUPPORTED_UPDATER_PROTOCOL;
    const upToDate = manifest.version === currentVersion;
    const guidance = compatible
      ? null
      : `该版本要求更新执行器协议 v${required}，本服务支持 v${SUPPORTED_UPDATER_PROTOCOL}。` +
        "请先在服务器上手工升级 updater 容器（执行器不会自我更新），再回到这里重试更新。";
    return {
      state: !compatible ? "incompatible" : upToDate ? "up_to_date" : "ok",
      checkedAt: new Date(at).toISOString(),
      source: outcome.source,
      latest: {
        version: manifest.version,
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        digest: manifest.services.feedback?.digest ?? null,
        image: manifest.services.feedback?.image ?? null,
        requiredUpdaterProtocol: required,
      },
      compatible,
      requiredProtocol: required,
      supportedProtocol: SUPPORTED_UPDATER_PROTOCOL,
      guidance,
      failedCode: null,
      failedMessage: null,
      warnings: outcome.warnings,
    };
  }

  function status(): SystemUpdateStatus {
    const pause = control.readPause();
    return {
      current: { version: currentVersion, protocol: SUPPORTED_UPDATER_PROTOCOL },
      config: {
        updateConfigured: client.configured,
        updaterBaseUrl: client.baseUrl,
        tokenFile: client.tokenFile,
        controlDir: control.controlDir,
        protocolSupported: SUPPORTED_UPDATER_PROTOCOL,
        checkIntervalMs: deps.checkIntervalMs,
      },
      pause: pause.paused ? pause : { paused: false, since: null, marker: null },
      check: currentCheckView(),
      recentOperations: control.listRecentTasks(MAX_RECENT_OPERATIONS).map(toOperationView),
    };
  }

  async function check(): Promise<CheckView> {
    const at = now();
    const health = await client.healthz();
    if (!health.ok) {
      const view = buildCheckView({ kind: "failed", code: health.error.code, message: health.error.message }, now());
      persist({ checkedAt: at, view });
      return view;
    }
    const manifest = await client.manifest();
    if (!manifest.ok) {
      const view = buildCheckView(
        { kind: "failed", code: manifest.error.code, message: manifest.error.message, source: "updater" },
        now(),
      );
      persist({ checkedAt: at, view });
      return view;
    }
    const warnings: string[] = [];
    if (health.value.protocolVersion !== null && health.value.protocolVersion > SUPPORTED_UPDATER_PROTOCOL) {
      warnings.push(
        `执行器协议版本 v${health.value.protocolVersion} 高于本服务支持的 v${SUPPORTED_UPDATER_PROTOCOL}；请先升级本服务。`,
      );
    }
    const view = buildCheckView({ kind: "manifest", manifest: manifest.value, source: "updater", warnings }, now());
    persist({ checkedAt: at, view });
    return view;
  }

  async function startUpdate(input: StartUpdateInput): Promise<StartUpdateResult> {
    const result = await client.createTask({
      requestId: input.requestId,
      version: input.version,
      digest: input.digest,
    });
    if (result.ok) {
      return {
        kind: "accepted",
        operationId: result.value.operationId,
        status: result.value.status,
        deduplicated: result.value.deduplicated === true,
      };
    }
    if (result.error.code === "updater_conflict") {
      const detail = result.error.detail;
      const record = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
      const operationId = typeof record.operationId === "string" ? record.operationId : null;
      const phase = typeof record.phase === "string" ? record.phase : null;
      return { kind: "conflict", message: result.error.message, operationId, phase };
    }
    return { kind: "blocked", error: result.error };
  }

  async function operation(operationId: string): Promise<OperationResult> {
    // 控制目录里的任务文件由执行器逐阶段落盘：优先用它（含阶段/证据），
    // 这样即使上游暂时不可达（服务重启中），后台仍能展示进度，**不据此判失败**。
    const local = control.readTask(operationId);
    if (local) return { kind: "known", operation: toOperationView(local), fromControlDir: true };
    const upstream = await client.getTask(operationId);
    if (upstream.ok) {
      if (upstream.value === null) return { kind: "unknown", operationId };
      return {
        kind: "known",
        operation: toOperationView(taskFromUpstream(upstream.value, operationId)),
        fromControlDir: false,
      };
    }
    return { kind: "unreachable", operationId, error: upstream.error };
  }

  async function runAutoCheck(): Promise<boolean> {
    const persisted = loadPersisted();
    if (persisted && now() - persisted.checkedAt < deps.checkIntervalMs) return false;
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

  // 自动检查循环：**只检查不安装**（安装只能由管理员在后台点击触发）。
  if (deps.checkIntervalMs > 0) {
    const tick = (): void => {
      if (closed) return;
      void runAutoCheck()
        .catch(() => false)
        .finally(() => {
          if (!closed) timer = setTimer(tick, deps.checkIntervalMs);
        });
    };
    timer = setTimer(tick, deps.checkIntervalMs);
    timer.unref?.();
  }

  return { control, client, status, check, startUpdate, operation, runAutoCheck, close };
}

/** 上游任务记录的兜底展示（控制目录里还没有任务文件时）。 */
function taskFromUpstream(raw: Record<string, unknown>, operationId: string): TaskSnapshot {
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const phase = str(raw.phase) ?? "accepted";
  return {
    operationId,
    requestId: str(raw.requestId),
    version: str(raw.version),
    digest: str(raw.digest),
    status: str(raw.status) ?? "running",
    outcome: str(raw.outcome),
    phase,
    phaseLabel: str(raw.phaseLabel) ?? phase,
    message: str(raw.message) ?? "更新任务执行中",
    createdAt: str(raw.createdAt) ?? "",
    updatedAt: str(raw.updatedAt) ?? "",
    startedAt: str(raw.startedAt),
    finishedAt: str(raw.finishedAt),
    failure: null,
    recoveryHint: str(raw.recoveryHint),
    warnings: [],
    evidence: [],
  };
}
// ============================================================================
// 5) 管理接口（挂载在 /api/admin/system 之下）
// ============================================================================

/**
 * U1-4：后台「系统更新」接口（仅管理员 Cookie 会话 + 严格同源检查）。
 *
 * 安全要点：
 * - 全部接口挂在 `/api/admin` 之下，复用既有的管理员守卫（Cookie + 同源 + 角色复核），
 *   并对**读操作也校验 Origin**（状态里含部署版本与任务证据，不允许跨站读取）。
 * - `POST /api/admin/system/update` **只**接受并转发 `{requestId, version, digest}`；
 *   compose 路径、命令、任意镜像或卷名一律 400 invalid_request（执行器只按预配置执行）。
 * - `requestId` 由客户端提供，用于幂等重放（执行器按 requestId 去重并拒绝并发）。
 * - 检查与进度查询是只读操作：上游不可达只体现为可区分的状态，不影响运行中的服务。
 * - 聚合实现见 ./update/{control-plane,updater-client,service}.ts；这里只做路由与校验。
 */
export interface SystemUpdateDeps {
  db: Db;
  config: ServerConfig;
  system: SystemUpdateService;
}

const ALLOWED_REQUEST_FIELDS = new Set(["requestId", "version", "digest"]);
/** 更新入口的独立限流：按管理员 id 计时（点击级操作，不需要更宽的额度）。 */
const UPDATE_LIMIT = 30;
const UPDATE_WINDOW_MS = 15 * 60 * 1000;

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

  const actionLimiter = createRateLimiter(UPDATE_LIMIT, UPDATE_WINDOW_MS);

  function rateLimited(c: Parameters<typeof fail>[0], userId: string): Response | null {
    const limited = checkLimiter(actionLimiter, userId);
    if (!limited) return null;
    c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
    return fail(c, limited);
  }

  /** GET /api/admin/system/update：当前版本 + 配置 + 暂停状态 + 最近检查结果 + 最近任务。 */
  routes.get("/update", (c) => c.json(system.status()));

  /** POST /api/admin/system/update/check：手动检查（只读，绝不安装）。 */
  routes.post("/update/check", async (c) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const limited = rateLimited(c, s.user_id);
    if (limited) return limited;
    const check = await system.check();
    return c.json({ check });
  });

  /** POST /api/admin/system/update：受理更新任务（只转发三个字段）。 */
  routes.post("/update", async (c) => {
    const s = requireAdminCookie(db, c, config);
    if (isErr(s)) return fail(c, s);
    const limited = rateLimited(c, s.user_id);
    if (limited) return limited;

    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const invalid = validateUpdateRequest(body);
    if (invalid) return fail(c, invalid);

    const result = await system.startUpdate({
      requestId: body.requestId as string,
      version: body.version as string,
      digest: body.digest as string,
    });
    if (result.kind === "accepted") {
      return c.json({ operationId: result.operationId, status: result.status, deduplicated: result.deduplicated }, 202);
    }
    if (result.kind === "conflict") {
      return c.json(
        {
          error: { code: "update_in_progress", message: result.message },
          operationId: result.operationId,
          phase: result.phase,
        },
        409,
      );
    }
    return fail(c, mapUpdaterError(result.error));
  });

  /** GET /api/admin/system/update/:id：任务进度（执行器不可达时返回可区分状态，不判失败）。 */
  routes.get("/update/:id", async (c) => {
    const operationId = c.req.param("id");
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return fail(c, err("invalid_request", "任务标识非法", 400));
    }
    const result = await system.operation(operationId);
    if (result.kind === "known") {
      return c.json({ status: "known", fromControlDir: result.fromControlDir, operation: result.operation });
    }
    if (result.kind === "unknown") {
      return c.json({ status: "unknown", operationId: result.operationId });
    }
    return c.json({
      status: "unreachable",
      operationId: result.operationId,
      error: { code: result.error.code, message: result.error.message },
    });
  });

  return routes;
}

/** 只允许 requestId/version/digest；其余字段（含 compose 路径、镜像、卷名）一律 400。 */
export function validateUpdateRequest(body: Record<string, unknown>): Err | null {
  const extra = Object.keys(body).filter((key) => !ALLOWED_REQUEST_FIELDS.has(key));
  if (extra.length > 0) {
    return err(
      "invalid_request",
      `不接受字段：${extra.join(", ")}；只允许 requestId/version/digest，部署路径、命令、镜像与卷名由执行器按预配置决定`,
      400,
    );
  }
  const requestId = body.requestId;
  if (typeof requestId !== "string" || !OPERATION_ID_PATTERN.test(requestId)) {
    return err("invalid_request", "requestId 必须是 1..128 位的 [A-Za-z0-9._:-]", 400);
  }
  const version = body.version;
  if (typeof version !== "string" || version.length > 80 || !SEMVER_PATTERN.test(version)) {
    return err("invalid_request", "version 必须是 semver（例如 0.3.0）", 400);
  }
  const digest = body.digest;
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    return err("invalid_request", "digest 必须是 sha256:<64 位小写十六进制>", 400);
  }
  return null;
}

/** 上游错误 → 客户端可见的明确状态（绝不把堆栈或令牌透出）。 */
function mapUpdaterError(error: UpdaterError): Err {
  if (error.code === "updater_not_configured") return err("update_not_configured", error.message, 503);
  if (error.code === "updater_token_missing") return err("update_token_unavailable", error.message, 503);
  if (error.code === "updater_unreachable") return err("update_executor_unreachable", error.message, 503);
  return err("update_executor_error", error.message, 502);
}
