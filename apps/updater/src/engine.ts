import path from "node:path";
import type { UpdaterConfig } from "./config.ts";
import type { ControlPort, PauseMarker, ReleaseMarker } from "./control.ts";
import { compareDbProbes, DB_PROBE_SCRIPT, type DbProbeResult, parseDbProbeOutput } from "./db-probe.ts";
import { type ContainerInfo, DockerError, type DockerPort } from "./docker.ts";
import {
  type DeployEnvFile,
  ENV_DATA_VOLUME_KEY,
  ENV_IMAGE_KEY,
  hasSecureMode,
  readDeployEnvFile,
  renderUpdatedEnvFile,
} from "./envfile.ts";
import { copyFileWithMode, ensureDir, readTextFileIfExists, writeFileAtomic, writeJsonAtomic } from "./fsx.ts";
import type { Logger } from "./log.ts";
import { checkProtocolCompat, type ManifestPort, type ReleaseManifest } from "./manifest.ts";
import { addEvidence, type PhaseId, type TaskOutcome, type TaskRecord, type TaskStorePort, touch } from "./state.ts";

/** 阶段机遇到不可继续的错误时抛出；错误本身携带阶段归属与是否已改动部署。 */
export class UpdateAbort extends Error {
  readonly phase: PhaseId;
  readonly code: string;
  readonly noChanges: boolean;
  readonly releaseStarted: boolean;

  constructor(
    phase: PhaseId,
    code: string,
    message: string,
    options: { noChanges?: boolean; releaseStarted?: boolean } = {},
  ) {
    super(message);
    this.name = "UpdateAbort";
    this.phase = phase;
    this.code = code;
    this.noChanges = options.noChanges ?? false;
    this.releaseStarted = options.releaseStarted ?? false;
  }
}

export interface HttpProbeResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export type HttpProbe = (url: string, timeoutMs: number) => Promise<HttpProbeResult>;

export const defaultHttpProbe: HttpProbe = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

export interface EngineOptions {
  config: UpdaterConfig;
  docker: DockerPort;
  store: TaskStorePort;
  control: ControlPort;
  manifest: ManifestPort;
  log: Logger;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  releaseTimeoutMs?: number;
  stopGraceSeconds?: number;
  pollIntervalMs?: number;
  httpProbe?: HttpProbe;
}

interface Ctx {
  record: TaskRecord;
  env: DeployEnvFile | null;
  manifest: ReleaseManifest | null;
  before: DbProbeResult | null;
  newImageRef: string | null;
  newVolume: string | null;
  pulledImageId: string | null;
  previousImage: string;
  previousVolume: string;
  previousContainerId: string;
  envModified: boolean;
  releaseStarted: boolean;
  releaseWritten: boolean;
}

interface CheckResult {
  ok: boolean;
  reason: string;
  detail: string;
}

const VERIFY_TIMEOUT_MS = 120_000;
const RELEASE_TIMEOUT_MS = 120_000;
const STOP_GRACE_SECONDS = 30;
const POLL_INTERVAL_MS = 2_000;
const ACCEPTABLE_EXIT_CODES = new Set([0, 143]);

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sanitizeVolumeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export function buildVolumeName(service: string, version: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return sanitizeVolumeToken(`${service}-data-${version}-${stamp}`);
}

export function pickImageRef(manifest: ReleaseManifest, imageName: string, digest: string): string {
  const candidate = manifest.services.feedback.image;
  if (candidate.endsWith(`@${digest}`) && /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/.test(candidate))
    return candidate;
  return `${imageName}@${digest}`;
}

export class UpdateEngine {
  private readonly config: UpdaterConfig;
  private readonly docker: DockerPort;
  private readonly store: TaskStorePort;
  private readonly control: ControlPort;
  private readonly manifest: ManifestPort;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyTimeoutMs: number;
  private readonly releaseTimeoutMs: number;
  private readonly stopGraceSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly httpProbe: HttpProbe;
  private active: Promise<TaskRecord> | null = null;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.docker = options.docker;
    this.store = options.store;
    this.control = options.control;
    this.manifest = options.manifest;
    this.log = options.log;
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? sleepDefault;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
    this.stopGraceSeconds = options.stopGraceSeconds ?? STOP_GRACE_SECONDS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.httpProbe = options.httpProbe ?? defaultHttpProbe;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /** 串行执行：进程内同时只允许一个更新任务。 */
  async run(record: TaskRecord): Promise<TaskRecord> {
    if (this.active) {
      this.log.warn("已有任务在执行，拒绝并发启动", { operationId: record.operationId });
      return record;
    }
    const promise = this.execute(record).finally(() => {
      this.active = null;
    });
    this.active = promise;
    return promise;
  }

  private now(): Date {
    return this.clock();
  }

  private async save(record: TaskRecord): Promise<void> {
    await this.store.save(record);
  }

  /** 阶段边界落盘：先把阶段写进任务文件，再执行该阶段的工作。 */
  private async enter(record: TaskRecord, phase: PhaseId, message: string): Promise<void> {
    touch(record, this.now(), phase, message);
    await this.save(record);
    this.log.info("进入阶段", { operationId: record.operationId, phase, message });
  }

  private async note(record: TaskRecord, phase: PhaseId, step: string, ok: boolean, detail?: string): Promise<void> {
    addEvidence(record, this.now(), phase, step, ok, detail);
    if (ok) this.log.info(`阶段步骤：${step}`, { operationId: record.operationId, phase, detail });
    else this.log.warn(`阶段步骤失败：${step}`, { operationId: record.operationId, phase, detail });
  }

  /** 只更新可读消息（不改阶段归属），用于恢复流程中的进度展示。 */
  private async setMessage(record: TaskRecord, message: string): Promise<void> {
    record.message = message;
    record.updatedAt = this.now().toISOString();
    await this.save(record);
  }

  private pauseMarker(record: TaskRecord, phase: PhaseId, message: string): PauseMarker {
    const now = this.now().toISOString();
    return {
      operationId: record.operationId,
      requestId: record.requestId,
      version: record.version,
      digest: record.digest,
      phase,
      message,
      startedAt: record.startedAt ?? now,
      updatedAt: now,
    };
  }

  private async execute(record: TaskRecord): Promise<TaskRecord> {
    record.startedAt = this.now().toISOString();
    const ctx: Ctx = {
      record,
      env: null,
      manifest: null,
      before: null,
      newImageRef: null,
      newVolume: null,
      pulledImageId: null,
      previousImage: "",
      previousVolume: "",
      previousContainerId: "",
      envModified: false,
      releaseStarted: false,
      releaseWritten: false,
    };
    try {
      await this.phasePreflight(ctx);
      await this.phasePauseStop(ctx);
      await this.phaseBackupCopy(ctx);
      await this.phaseStartPaused(ctx);
      await this.phaseVerifyNew(ctx);
      await this.phaseRelease(ctx);
      return await this.finish(ctx, "succeeded", "succeeded", `更新完成，已放行 v${record.version}`);
    } catch (err) {
      try {
        return await this.handleFailure(ctx, err);
      } catch (nested) {
        return await this.finalizeUnexpected(ctx, nested);
      }
    }
  }

  /**
   * 兜底收尾：恢复流程本身出错时也必须留下终态，绝不让任务停留在 running，
   * 也不做任何额外的自动回退动作。
   */
  private async finalizeUnexpected(ctx: Ctx, err: unknown): Promise<TaskRecord> {
    const { record } = ctx;
    const message = `恢复流程异常：${(err as Error).message ?? String(err)}`;
    const now = this.now().toISOString();
    record.status = "needs_attention";
    record.outcome = "needs_attention";
    record.phase = "done";
    record.phaseLabel = "完成";
    record.message = message;
    record.failure = record.failure ?? { phase: record.phase, code: "recovery_error", message };
    record.recoveryHint =
      record.recoveryHint ??
      `${message}。所有镜像与数据卷均保留（执行器未执行 prune/rmi/卷删除），请人工核对服务与数据后按 docs/deployment.md 处理。`;
    record.updatedAt = now;
    record.finishedAt = now;
    try {
      await this.save(record);
    } catch (saveErr) {
      this.log.error("兜底收尾落盘失败", { operationId: record.operationId, error: (saveErr as Error).message });
    }
    this.log.error("任务需要人工处理", { operationId: record.operationId, message, hint: record.recoveryHint });
    return record;
  }

  // ---------------------------------------------------------------- ① 预检并拉取

  private async phasePreflight(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    await this.enter(record, "preflight_pull", "①预检并拉取：读取部署环境文件与版本清单");

    let env: DeployEnvFile;
    try {
      env = await readDeployEnvFile(this.config.envFile);
    } catch (err) {
      throw new UpdateAbort("preflight_pull", "env_file_unreadable", (err as Error).message, { noChanges: true });
    }
    ctx.env = env;
    if (!hasSecureMode(env.mode)) {
      record.warnings.push(`部署环境文件权限过宽（0${env.mode.toString(8)}），建议 chmod 600`);
    }
    const previousImage = env.values.get(ENV_IMAGE_KEY);
    const previousVolume = env.values.get(ENV_DATA_VOLUME_KEY);
    if (!previousImage) {
      throw new UpdateAbort(
        "preflight_pull",
        "env_file_incomplete",
        `部署环境文件缺少 ${ENV_IMAGE_KEY}；请先执行 deploy/install-updater.sh 完成首次安装登记`,
        { noChanges: true },
      );
    }
    if (!previousVolume) {
      throw new UpdateAbort(
        "preflight_pull",
        "env_file_incomplete",
        `部署环境文件缺少 ${ENV_DATA_VOLUME_KEY}；请先执行 deploy/install-updater.sh 完成首次安装登记`,
        { noChanges: true },
      );
    }
    ctx.previousImage = previousImage;
    ctx.previousVolume = previousVolume;
    record.previousImage = previousImage;
    record.previousVolume = previousVolume;

    const outcome = await this.manifest.load("stable");
    if (outcome.kind !== "ok") {
      const detail =
        outcome.kind === "invalid"
          ? `版本清单非法（${outcome.location}）：${outcome.error}`
          : outcome.kind === "unreachable"
            ? `版本清单不可达（${outcome.url}）：${outcome.error}`
            : "未找到版本清单（release-manifest.json）";
      throw new UpdateAbort("preflight_pull", `manifest_${outcome.kind}`, detail, { noChanges: true });
    }
    const compat = checkProtocolCompat(outcome.manifest, this.config.protocolVersion);
    if (!compat.compatible) {
      throw new UpdateAbort("preflight_pull", "updater_protocol_incompatible", compat.guidance ?? "协议不兼容", {
        noChanges: true,
      });
    }
    ctx.manifest = outcome.manifest;
    await this.note(
      record,
      "preflight_pull",
      "读取版本清单",
      true,
      `来源 ${outcome.source}（${outcome.location}），版本 ${outcome.manifest.version}，协议 v${compat.required}`,
    );
    if (outcome.note) record.warnings.push(outcome.note);

    if (outcome.manifest.version !== record.version) {
      throw new UpdateAbort(
        "preflight_pull",
        "version_mismatch",
        `请求版本 ${record.version} 与清单版本 ${outcome.manifest.version} 不一致`,
        { noChanges: true },
      );
    }
    if (outcome.manifest.services.feedback.digest !== record.digest) {
      throw new UpdateAbort(
        "preflight_pull",
        "digest_mismatch",
        `请求 digest ${record.digest} 与清单 digest ${outcome.manifest.services.feedback.digest} 不一致`,
        { noChanges: true },
      );
    }
    const newImageRef = pickImageRef(outcome.manifest, this.config.imageName, record.digest);
    ctx.newImageRef = newImageRef;
    record.newImageRef = newImageRef;

    const containerId = await this.dockerCall(
      "preflight_pull",
      "feedback_container_missing",
      "查找 feedback 服务容器",
      true,
      () => this.docker.serviceContainerId(),
    );
    if (!containerId) {
      throw new UpdateAbort(
        "preflight_pull",
        "feedback_container_missing",
        `未找到项目 ${this.config.composeProject} 中服务 ${this.config.service} 的容器，拒绝更新`,
        { noChanges: true },
      );
    }
    ctx.previousContainerId = containerId;
    record.previousContainerId = containerId;
    const container = await this.dockerCall("preflight_pull", "inspect_failed", "读取旧容器状态", true, () =>
      this.docker.inspectContainer(containerId),
    );
    await this.note(
      record,
      "preflight_pull",
      "记录旧容器状态",
      true,
      `容器 ${container.id.slice(0, 12)} 运行中=${container.running} 镜像=${container.imageRef}`,
    );
    if (!container.running) record.warnings.push("更新开始时旧服务容器未在运行");
    const dataDir = dataDirOf(container);
    const mountedVolume = dataVolumeMountOf(container, dataDir);
    if (mountedVolume && mountedVolume !== previousVolume) {
      record.warnings.push(`运行中容器挂载的数据卷 ${mountedVolume} 与部署环境文件登记值 ${previousVolume} 不一致`);
    }
    if (container.imageRef && container.imageRef !== previousImage) {
      record.warnings.push(`运行中容器镜像 ${container.imageRef} 与部署环境文件登记值 ${previousImage} 不一致`);
    }
    await this.save(record);

    ctx.before = await this.probeContainer(containerId, dataDir);
    const baselineVerdict = compareDbProbes(ctx.before, {
      dbSchemaVersion: ctx.before.userVersion,
      before: null,
    });
    await this.note(
      record,
      "preflight_pull",
      "更新前数据基线",
      baselineVerdict.ok,
      baselineVerdict.ok ? baselineVerdict.summary : baselineVerdict.problems.join("；"),
    );
    if (!baselineVerdict.ok) {
      throw new UpdateAbort("preflight_pull", "baseline_probe_failed", baselineVerdict.problems.join("；"), {
        noChanges: true,
      });
    }

    await this.dockerCall("preflight_pull", "pull_failed", `拉取镜像 ${newImageRef}`, true, () =>
      this.docker.pullImage(newImageRef),
    );
    await this.note(
      record,
      "preflight_pull",
      "拉取新镜像",
      true,
      `已拉取 ${newImageRef}（旧镜像 ${previousImage} 保留）`,
    );

    const imageInfo = await this.dockerCall("preflight_pull", "image_inspect_failed", "校验拉取结果", true, () =>
      this.docker.imageInfo(newImageRef),
    );
    ctx.pulledImageId = imageInfo.id;
    if (!imageInfo.digests.some((entry) => entry.endsWith(`@${record.digest}`))) {
      throw new UpdateAbort(
        "preflight_pull",
        "digest_mismatch",
        `拉取到的镜像 digest 与请求不一致：${imageInfo.digests.join(", ") || imageInfo.id}`,
        { noChanges: true },
      );
    }
    await this.note(record, "preflight_pull", "校验镜像 digest", true, record.digest);

    const sizeKb = await this.dockerCall("preflight_pull", "space_check_failed", "读取数据卷大小", true, () =>
      this.docker.volumeSizeKb(previousVolume, previousImage),
    );
    const freeKb = await this.dockerCall("preflight_pull", "space_check_failed", "读取磁盘可用空间", true, () =>
      this.docker.volumeAvailableKb(previousVolume, previousImage),
    );
    const requiredKb = Math.ceil((sizeKb * 12) / 10);
    if (freeKb < requiredKb) {
      throw new UpdateAbort(
        "preflight_pull",
        "insufficient_space",
        `数据卷所在磁盘可用空间不足：需要 ≥ ${requiredKb}KB（数据 ${sizeKb}KB 的 1.2 倍），实际 ${freeKb}KB`,
        { noChanges: true },
      );
    }
    await this.note(
      record,
      "preflight_pull",
      "空间检查",
      true,
      `数据 ${sizeKb}KB，需要 ≥ ${requiredKb}KB，可用 ${freeKb}KB`,
    );
    await this.save(record);
  }

  // ---------------------------------------------------------------- ② 暂停并停服

  private async phasePauseStop(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    await this.enter(record, "pause_stop", "②暂停并停服：写入暂停标记后优雅停止服务");
    await this.control.writePaused(this.pauseMarker(record, "pause_stop", "更新进行中，写入已暂停"));
    await this.note(record, "pause_stop", "写入暂停标记", true, this.config.pausedFile);

    await this.dockerCall("pause_stop", "stop_failed", "停止 feedback 服务", false, () =>
      this.docker.stopFeedback(this.stopGraceSeconds),
    );

    const container = await this.dockerCall("pause_stop", "inspect_failed", "停服后确认容器状态", false, () =>
      this.docker.inspectContainer(ctx.previousContainerId),
    );
    if (container.running) {
      throw new UpdateAbort("pause_stop", "stop_failed", "stop 返回成功但容器仍在运行，中止升级", {});
    }
    if (container.oomKilled) {
      throw new UpdateAbort("pause_stop", "stop_oom_killed", "容器被 OOM 终止，退出状态不可信，中止升级", {});
    }
    const exitCode = container.exitCode;
    if (exitCode === null || !ACCEPTABLE_EXIT_CODES.has(exitCode)) {
      throw new UpdateAbort(
        "pause_stop",
        "stop_abnormal_exit",
        `容器退出码异常（${exitCode ?? "未知"}，仅接受 0/143）：已停止服务但拒绝继续，避免把不一致数据当作完整备份`,
        {},
      );
    }
    await this.note(record, "pause_stop", "确认服务已退出", true, `退出码 ${exitCode}（30s 优雅退出预算）`);
    await this.save(record);
  }

  // ---------------------------------------------------------------- ③ 保留备份并复制

  private async phaseBackupCopy(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    await this.enter(record, "backup_copy", "③保留备份并复制：配置受限副本 + 完整复制数据卷");
    const backupDir = path.join(this.config.backupsDir, record.operationId);
    await ensureDir(backupDir, 0o700);
    await copyFileWithMode(this.config.composeFile, path.join(backupDir, "compose.yml"), 0o600);
    await copyFileWithMode(this.config.envFile, path.join(backupDir, ".env.prod"), 0o600);
    await writeJsonAtomic(
      path.join(backupDir, "restore.json"),
      {
        operationId: record.operationId,
        requestId: record.requestId,
        version: record.version,
        digest: record.digest,
        previousImage: ctx.previousImage,
        previousVolume: ctx.previousVolume,
        newImageRef: ctx.newImageRef,
        createdAt: this.now().toISOString(),
      },
      0o600,
    );
    record.backupDir = backupDir;
    await this.note(record, "backup_copy", "配置与主密钥环境文件另存受限副本", true, `${backupDir}（600）`);

    const newVolume = buildVolumeName(this.config.service, record.version, this.now());
    ctx.newVolume = newVolume;
    record.newVolume = newVolume;
    await this.save(record);

    const existing = await this.dockerCall("backup_copy", "volume_inspect_failed", "检查目标数据卷", false, () =>
      this.docker.volumeInfo(newVolume),
    );
    if (existing.exists) {
      throw new UpdateAbort("backup_copy", "volume_exists", `目标数据卷 ${newVolume} 已存在，拒绝覆盖`, {});
    }
    await this.dockerCall("backup_copy", "volume_create_failed", `创建新数据卷 ${newVolume}`, false, () =>
      this.docker.createVolume(newVolume),
    );
    await this.note(
      record,
      "backup_copy",
      "创建独立新数据卷",
      true,
      `${newVolume}（原卷 ${ctx.previousVolume} 保留为完整备份）`,
    );
    await this.save(record);

    await this.dockerCall("backup_copy", "copy_failed", "复制数据卷", false, () =>
      this.docker.copyVolume(ctx.previousVolume, newVolume, ctx.previousImage),
    );
    await this.note(record, "backup_copy", "复制原卷到新卷", true, `${ctx.previousVolume} → ${newVolume}`);

    const fromEntries = await this.dockerCall("backup_copy", "copy_verify_failed", "核对复制结果", false, () =>
      this.docker.volumeEntries(ctx.previousVolume, ctx.previousImage),
    );
    const toEntries = await this.dockerCall("backup_copy", "copy_verify_failed", "核对复制结果", false, () =>
      this.docker.volumeEntries(newVolume, ctx.previousImage),
    );
    const missing = fromEntries.filter((entry) => !toEntries.includes(entry));
    if (missing.length > 0) {
      throw new UpdateAbort(
        "backup_copy",
        "copy_verify_failed",
        `复制结果缺少条目：${missing.join(", ")}（含 WAL 文件，必须完整）`,
        {},
      );
    }
    const fromSizeKb = await this.dockerCall("backup_copy", "copy_verify_failed", "核对复制大小", false, () =>
      this.docker.volumeSizeKb(ctx.previousVolume, ctx.previousImage),
    );
    const toSizeKb = await this.dockerCall("backup_copy", "copy_verify_failed", "核对复制大小", false, () =>
      this.docker.volumeSizeKb(newVolume, ctx.previousImage),
    );
    if (toSizeKb < fromSizeKb) {
      throw new UpdateAbort(
        "backup_copy",
        "copy_verify_failed",
        `复制结果偏小：原卷 ${fromSizeKb}KB，新卷 ${toSizeKb}KB`,
        {},
      );
    }
    await this.note(
      record,
      "backup_copy",
      "验证复制结果",
      true,
      `${toEntries.length} 个条目，原卷 ${fromSizeKb}KB / 新卷 ${toSizeKb}KB`,
    );
    await this.save(record);
  }

  // ---------------------------------------------------------------- ④ 启动验证

  private async phaseStartPaused(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    await this.enter(record, "start_paused", "④启动验证：原子更新环境文件后只重建 feedback 服务");
    const env = ctx.env;
    const newImageRef = ctx.newImageRef;
    const newVolume = ctx.newVolume;
    if (!env || !newImageRef || !newVolume) {
      throw new UpdateAbort("start_paused", "internal_state_missing", "启动前的阶段状态不完整，中止升级", {});
    }
    const current = await this.dockerCall("start_paused", "env_file_read_failed", "重新读取部署环境文件", false, () =>
      readDeployEnvFile(this.config.envFile),
    );
    if (current.content !== env.content) {
      throw new UpdateAbort("start_paused", "env_file_changed", "部署环境文件在更新期间被外部修改，拒绝覆盖", {});
    }
    let rendered: string;
    try {
      rendered = renderUpdatedEnvFile(current.content, {
        [ENV_IMAGE_KEY]: newImageRef,
        [ENV_DATA_VOLUME_KEY]: newVolume,
      });
    } catch (err) {
      throw new UpdateAbort("start_paused", "env_file_incomplete", (err as Error).message, {});
    }
    await this.dockerCall("start_paused", "env_file_write_failed", "写入部署环境文件", false, async () => {
      await writeFileAtomic(this.config.envFile, rendered, current.mode);
      const written = await readDeployEnvFile(this.config.envFile);
      if (written.values.get(ENV_IMAGE_KEY) !== newImageRef || written.values.get(ENV_DATA_VOLUME_KEY) !== newVolume) {
        throw new Error("写入后校验失败：镜像或数据卷引用未生效");
      }
    });
    ctx.envModified = true;
    await this.note(
      record,
      "start_paused",
      "原子更新环境文件",
      true,
      `${ENV_IMAGE_KEY}=${newImageRef} ${ENV_DATA_VOLUME_KEY}=${newVolume}（其它字段不变，权限 0${current.mode.toString(8)}）`,
    );

    await this.control.writePaused(this.pauseMarker(record, "start_paused", "新版已启动，等待核验，写入仍暂停"));
    await this.dockerCall("start_paused", "compose_up_failed", "重建 feedback 服务", false, () =>
      this.docker.startFeedback(),
    );
    await this.note(
      record,
      "start_paused",
      "只重建 feedback 服务",
      true,
      "已重建（新版在暂停模式启动，执行器自身未被重建）",
    );
    await this.save(record);
  }

  // ---------------------------------------------------------------- ⑤ 核验新版

  private async phaseVerifyNew(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    await this.enter(record, "verify_new", "⑤核验新版：实际 digest、版本、提交、数据库与数据保留（限时 120s）");
    const verdict = await this.waitFor(() => this.evaluateRunningVersion(ctx), this.verifyTimeoutMs, "verify_timeout");
    if (!verdict.ok) {
      throw new UpdateAbort("verify_new", verdict.reason, `新版核验未通过：${verdict.detail}`, {});
    }
    await this.note(record, "verify_new", "核验新版", true, verdict.detail);
    await this.save(record);
  }

  // ---------------------------------------------------------------- ⑥ 放行

  private async phaseRelease(ctx: Ctx): Promise<void> {
    const { record } = ctx;
    ctx.releaseStarted = true;
    await this.enter(record, "release", "⑥放行：持久记录放行意图后原子解除暂停");
    const newImageRef = ctx.newImageRef ?? record.newImageRef ?? "";
    const marker: ReleaseMarker = {
      operationId: record.operationId,
      requestId: record.requestId,
      version: record.version,
      digest: record.digest,
      imageRef: newImageRef,
      volume: ctx.newVolume,
      releasedAt: this.now().toISOString(),
    };
    await this.control.writeRelease(marker);
    ctx.releaseWritten = true;
    await this.note(record, "release", "持久记录放行", true, `${this.config.releaseFile}`);
    await this.control.clearPaused();
    await this.note(record, "release", "原子解除暂停", true, `已删除 ${this.config.pausedFile}`);

    const ack = await this.waitFor(() => this.evaluateReleaseAck(ctx), this.releaseTimeoutMs, "release_ack_failed");
    if (!ack.ok) {
      throw new UpdateAbort("release", ack.reason, `放行确认未通过：${ack.detail}`, { releaseStarted: true });
    }
    await this.note(record, "release", "确认放行应答", true, ack.detail);
    await this.save(record);
  }

  // ---------------------------------------------------------------- 核验与等待

  private async waitFor(
    check: () => Promise<CheckResult>,
    timeoutMs: number,
    failureCode: string,
  ): Promise<CheckResult> {
    const deadline = this.now().getTime() + timeoutMs;
    let last = await this.runCheck(check);
    while (!last.ok && this.now().getTime() < deadline) {
      await this.sleep(this.pollIntervalMs);
      last = await this.runCheck(check);
    }
    if (!last.ok) return { ok: false, reason: failureCode, detail: last.detail || last.reason };
    return last;
  }

  private async runCheck(check: () => Promise<CheckResult>): Promise<CheckResult> {
    try {
      return await check();
    } catch (err) {
      return { ok: false, reason: "check_error", detail: `核验过程出错：${(err as Error).message}` };
    }
  }

  /** 统一核验：容器运行、镜像 digest、数据卷挂载、数据库与数据保留、健康状态。 */
  private async evaluateRunningVersion(ctx: Ctx): Promise<CheckResult> {
    const { record } = ctx;
    const containerId = await this.docker.serviceContainerId();
    if (!containerId) return { ok: false, reason: "container_missing", detail: "未找到 feedback 服务容器" };
    let container: ContainerInfo;
    try {
      container = await this.docker.inspectContainer(containerId);
    } catch (err) {
      return { ok: false, reason: "inspect_failed", detail: (err as Error).message };
    }
    if (!container.running) {
      return {
        ok: false,
        reason: "container_not_running",
        detail: `容器未运行（exit ${container.exitCode ?? "?"}）`,
      };
    }
    const imageCheck = await this.verifyContainerImage(ctx, container);
    if (!imageCheck.ok) return imageCheck;

    const dataDir = dataDirOf(container);
    const mountedVolume = dataVolumeMountOf(container, dataDir);
    if (!ctx.newVolume || mountedVolume !== ctx.newVolume) {
      return {
        ok: false,
        reason: "volume_mismatch",
        detail: `数据卷挂载不符：期望 ${ctx.newVolume ?? "?"}，实际 ${mountedVolume ?? "未挂载"}`,
      };
    }
    if (container.health === "unhealthy") {
      return { ok: false, reason: "unhealthy", detail: "容器健康检查为 unhealthy" };
    }
    if (container.health === "starting") {
      return { ok: false, reason: "starting", detail: "容器健康检查仍在 starting" };
    }

    const probe = await this.probeContainer(containerId, dataDir);
    const verdict = compareDbProbes(probe, {
      dbSchemaVersion: ctx.manifest?.dbSchemaVersion ?? null,
      before: ctx.before,
    });
    for (const warning of verdict.warnings) {
      if (!record.warnings.includes(warning)) record.warnings.push(warning);
    }
    if (!verdict.ok) {
      return { ok: false, reason: "db_verify_failed", detail: verdict.problems.join("；") };
    }
    return {
      ok: true,
      reason: "ok",
      detail: `${imageCheck.detail}；数据卷 ${mountedVolume}；${verdict.summary}`,
    };
  }

  private async evaluateReleaseAck(ctx: Ctx): Promise<CheckResult> {
    const paused = await this.control.readPaused();
    if (paused.state !== "absent") {
      return { ok: false, reason: "pause_marker_present", detail: "暂停标记尚未解除" };
    }
    const release = await this.control.readRelease();
    if (release.state !== "ok") {
      return { ok: false, reason: "release_marker_missing", detail: "放行标记缺失或不可解析" };
    }
    const base = await this.evaluateRunningVersion(ctx);
    if (!base.ok) return base;
    const live = await this.probeLiveness(base.detail);
    return { ok: true, reason: "ok", detail: `${base.detail}；放行应答 ${live}` };
  }

  /** 放行后的存活信号：容器健康、内网 HTTP /healthz 或容器内数据库探针（已通过）至少一项为正。 */
  private async probeLiveness(detail: string): Promise<string> {
    const port = await this.internalPort();
    if (port === null) return `容器未声明端口，依据容器状态与数据库探针：${detail.slice(0, 120)}`;
    const url = `http://${this.config.service}:${port}/healthz`;
    const result = await this.httpProbe(url, 3000);
    if (result.ok) return `HTTP ${result.status} ${url}`;
    return `HTTP 不可达（${result.error ?? "未知"}），依据容器状态与数据库探针：${detail.slice(0, 120)}`;
  }

  private async internalPort(): Promise<number | null> {
    const container = await this.runningContainer();
    if (!container) return null;
    for (const entry of container.exposedPorts) {
      const match = /^(\d+)\//.exec(entry);
      if (match?.[1]) return Number(match[1]);
    }
    return null;
  }

  private async verifyContainerImage(ctx: Ctx, container: ContainerInfo): Promise<CheckResult> {
    let info: { id: string; digests: string[]; labels: Record<string, string> };
    try {
      info = await this.docker.imageInfo(container.imageId);
    } catch (err) {
      return { ok: false, reason: "image_inspect_failed", detail: (err as Error).message };
    }
    const wanted = `@${ctx.record.digest}`;
    let digestDetail: string;
    if (info.digests.some((entry) => entry.endsWith(wanted))) {
      digestDetail = `镜像 digest ${ctx.record.digest} 已确认`;
    } else if (info.digests.length === 0 && ctx.pulledImageId && info.id === ctx.pulledImageId) {
      digestDetail = `镜像无 RepoDigest（本地构建），已用镜像 ID ${info.id.slice(0, 19)} 与拉取结果比对`;
    } else {
      return {
        ok: false,
        reason: "digest_mismatch",
        detail: `实际镜像 digest 与请求不一致：${info.digests.join(", ") || info.id}`,
      };
    }

    const versionLabel = info.labels["org.opencontainers.image.version"];
    if (versionLabel && versionLabel !== ctx.record.version) {
      return {
        ok: false,
        reason: "version_mismatch",
        detail: `镜像版本标签 ${versionLabel} 与请求版本 ${ctx.record.version} 不一致`,
      };
    }
    const commitLabel = info.labels["org.opencontainers.image.revision"];
    const expectedCommit = ctx.manifest?.commit;
    if (commitLabel && expectedCommit && commitLabel !== expectedCommit) {
      return {
        ok: false,
        reason: "commit_mismatch",
        detail: `镜像提交标签 ${commitLabel} 与清单提交 ${expectedCommit} 不一致`,
      };
    }
    const extras: string[] = [];
    if (!versionLabel) extras.push("镜像缺少版本标签（digest 已锁定，按警告处理）");
    if (commitLabel && expectedCommit && commitLabel === expectedCommit) extras.push(`提交 ${commitLabel}`);
    for (const extra of extras) {
      if (extra.includes("缺少") && !ctx.record.warnings.includes(extra)) ctx.record.warnings.push(extra);
    }
    return { ok: true, reason: "ok", detail: `${digestDetail}${extras.length ? `；${extras.join("；")}` : ""}` };
  }

  private async probeContainer(containerId: string, dataDir: string): Promise<DbProbeResult> {
    try {
      const stdout = await this.docker.execNode(containerId, DB_PROBE_SCRIPT, {
        DB_PATH: path.posix.join(dataDir, "feedback.db"),
      });
      return parseDbProbeOutput(stdout);
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        integrity: null,
        userVersion: null,
        tableNames: [],
        counts: {},
        settings: {},
        attachmentsPresent: false,
      };
    }
  }

  // ---------------------------------------------------------------- 失败与恢复

  private async handleFailure(ctx: Ctx, err: unknown): Promise<TaskRecord> {
    const { record } = ctx;
    const abort =
      err instanceof UpdateAbort
        ? err
        : new UpdateAbort(
            record.phase,
            "unexpected_error",
            `执行器内部错误：${(err as Error).message ?? String(err)}`,
            {},
          );
    record.failure = { phase: abort.phase, code: abort.code, message: abort.message };
    await this.note(record, abort.phase, `失败：${abort.code}`, false, abort.message);

    if (abort.releaseStarted || ctx.releaseStarted || record.phase === "release") {
      return await this.needsAttention(ctx, abort, "放行已开始，绝不自动恢复原卷");
    }
    if (abort.noChanges) {
      return await this.finish(
        ctx,
        "failed",
        "failed_no_changes",
        `更新失败（未改动部署，旧服务保持运行）：${abort.message}`,
      );
    }
    return await this.restoreOldVersion(ctx, abort);
  }

  private async needsAttention(ctx: Ctx, abort: UpdateAbort, note: string): Promise<TaskRecord> {
    const { record } = ctx;
    if (ctx.releaseWritten) {
      // 放行标记已落盘：解除暂停，让新版继续提供服务，仅标记需要人工确认。
      const cleared = await this.control.clearPaused();
      await this.note(record, record.phase, "放行标记已落盘，保持解除暂停", true, `paused 清除=${cleared}`);
    }
    record.recoveryHint =
      `${note}。新版数据卷 ${ctx.newVolume ?? record.newVolume ?? "<未知>"}，旧数据卷 ` +
      `${ctx.previousVolume || record.previousVolume || "<未知>"} 与旧镜像 ${ctx.previousImage || record.previousImage || "<未知>"} ` +
      `均完整保留、未被删除，执行器未执行任何 prune/rmi/卷删除。请人工确认服务状态后按 docs/deployment.md「升级与回退」处理；` +
      `任务证据见 ${path.join(this.config.tasksDir, `${record.operationId}.json`)}。`;
    await this.note(record, record.phase, "标记为需要处理", false, record.recoveryHint);
    return await this.finish(ctx, "needs_attention", "needs_attention", `需要人工处理：${abort.message}`);
  }

  /**
   * 验证阶段失败（尚未开始放行）时恢复旧版本：
   * 还原环境文件 → 启动旧镜像 + 未修改的原卷 → 旧服务通过检查后才标记「已恢复旧版本」。
   */
  private async restoreOldVersion(ctx: Ctx, abort: UpdateAbort): Promise<TaskRecord> {
    const { record } = ctx;
    record.restore = { attempted: true, confirmed: false, note: abort.message };
    await this.setMessage(record, `恢复旧版本：${abort.message}`);
    await this.note(record, record.phase, "开始恢复旧版本", true, "停止新版、切回旧镜像与未修改的原卷");

    if (ctx.envModified && ctx.env) {
      try {
        await writeFileAtomic(this.config.envFile, ctx.env.content, ctx.env.mode);
        await this.note(record, record.phase, "还原部署环境文件", true, `${ENV_IMAGE_KEY}/${ENV_DATA_VOLUME_KEY} 还原`);
      } catch (err) {
        return await this.needsAttention(ctx, abort, `还原部署环境文件失败：${(err as Error).message}`);
      }
    }

    const running = await this.runningContainer();
    const alreadyOld =
      running?.running === true &&
      (await this.containerMatchesOld(ctx, running)) &&
      (await this.containerVolumeIs(running, ctx.previousVolume));
    if (!alreadyOld) {
      try {
        await this.docker.stopFeedback(this.stopGraceSeconds);
      } catch {
        // 已经停止时 stop 可能返回非零；继续尝试用旧配置启动
      }
      try {
        await this.docker.startFeedback();
      } catch (err) {
        return await this.needsAttention(ctx, abort, `启动旧版本失败：${(err as Error).message}`);
      }
      await this.note(
        record,
        record.phase,
        "用旧配置重建服务",
        true,
        `镜像 ${ctx.previousImage}，数据卷 ${ctx.previousVolume}`,
      );
    }

    const verdict = await this.waitFor(
      () => this.evaluateOldVersion(ctx),
      Math.min(this.verifyTimeoutMs, 60_000),
      "restore_timeout",
    );
    if (!verdict.ok) {
      return await this.needsAttention(ctx, abort, `旧版本未通过检查：${verdict.detail}`);
    }
    record.restore = { attempted: true, confirmed: true, note: abort.message };
    await this.control.clearPaused();
    await this.note(record, record.phase, "确认旧服务可用", true, verdict.detail);
    return await this.finish(ctx, "failed", "failed_restored", `更新失败，已恢复旧版本：${abort.message}`);
  }

  private async evaluateOldVersion(ctx: Ctx): Promise<CheckResult> {
    const container = await this.runningContainer();
    if (!container) return { ok: false, reason: "container_missing", detail: "未找到旧服务容器" };
    if (!container.running) return { ok: false, reason: "container_not_running", detail: "旧服务容器未运行" };
    if (!(await this.containerMatchesOld(ctx, container))) {
      return { ok: false, reason: "image_mismatch", detail: `旧服务镜像与登记值 ${ctx.previousImage} 不一致` };
    }
    if (!(await this.containerVolumeIs(container, ctx.previousVolume))) {
      return { ok: false, reason: "volume_mismatch", detail: `旧服务未挂载登记的数据卷 ${ctx.previousVolume}` };
    }
    const dataDir = dataDirOf(container);
    const probe = await this.probeContainer(container.id, dataDir);
    if (!probe.ok || probe.integrity !== "ok") {
      return {
        ok: false,
        reason: "db_verify_failed",
        detail: `旧服务数据库探针未通过：${probe.error ?? probe.integrity}`,
      };
    }
    return {
      ok: true,
      reason: "ok",
      detail: `旧版本已恢复：镜像 ${ctx.previousImage}，数据卷 ${ctx.previousVolume}，integrity=${probe.integrity}`,
    };
  }

  private async runningContainer(): Promise<ContainerInfo | null> {
    try {
      const id = await this.docker.serviceContainerId();
      if (!id) return null;
      return await this.docker.inspectContainer(id);
    } catch {
      return null;
    }
  }

  private async containerMatchesOld(ctx: Ctx, container: ContainerInfo): Promise<boolean> {
    if (container.imageRef === ctx.previousImage) return true;
    try {
      const wanted = await this.docker.imageInfo(ctx.previousImage);
      return wanted.id === container.imageId;
    } catch {
      return false;
    }
  }

  private async containerVolumeIs(container: ContainerInfo, volume: string): Promise<boolean> {
    return dataVolumeMountOf(container, dataDirOf(container)) === volume;
  }

  private async finish(
    ctx: Ctx,
    status: TaskRecord["status"],
    outcome: TaskOutcome,
    message: string,
  ): Promise<TaskRecord> {
    const { record } = ctx;
    record.status = status;
    record.outcome = outcome;
    record.phase = "done";
    record.phaseLabel = "完成";
    record.message = message;
    record.updatedAt = this.now().toISOString();
    record.finishedAt = record.updatedAt;
    await this.save(record);
    this.log.info("任务结束", {
      operationId: record.operationId,
      status,
      outcome,
      message,
    });
    return record;
  }

  private async dockerCall<T>(
    phase: PhaseId,
    code: string,
    label: string,
    noChanges: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UpdateAbort) throw err;
      if (err instanceof DockerError) {
        throw new UpdateAbort(phase, code, `docker 调用失败（${label}）：${err.message}`, { noChanges });
      }
      throw new UpdateAbort(phase, code, `${label} 失败：${(err as Error).message}`, { noChanges });
    }
  }
}

function dataDirOf(container: ContainerInfo): string {
  for (const entry of container.env) {
    const match = /^FEEDBACK_DATA_DIR=(.*)$/.exec(entry);
    if (match?.[1]) return match[1];
  }
  return "/data";
}

function dataVolumeMountOf(container: ContainerInfo, dataDir: string): string | null {
  const mount = container.mounts.find((entry) => entry.destination === dataDir);
  return mount?.name ?? null;
}

/** 读取磁盘上的原始暂停标记内容（重启核对使用）。 */
export async function readPausedRaw(config: UpdaterConfig): Promise<string | null> {
  return readTextFileIfExists(config.pausedFile);
}
