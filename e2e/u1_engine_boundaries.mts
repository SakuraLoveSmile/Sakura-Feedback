/**
 * U1 边界场景（进程内真实代码路径）—— 独立验证夹具。
 *
 * 直接驱动 apps/updater 的**真实** UpdateEngine（真实阶段机、真实任务落盘、
 * 真实 paused/release 标记、真实失败与恢复分支），只把 docker 端口换成可编程的
 * 假实现：夹具只模拟 docker 的观察结果与故障，**不代替执行器**做任何复制、换镜像
 * 或状态转换。
 *
 * 覆盖（容器级成本过高或不可构造，但必须走真实代码路径）：
 *   S1 磁盘空间：恰好 1.2 倍通过；少 1KB 即 insufficient_space（保持旧服务运行）
 *   S2 停服异常退出码（7）→ 中止且不备份
 *   S3 停服 OOM → 中止
 *   S4 复制失败 → 尝试恢复旧版本；新卷保留不删除
 *   S5 目标新卷已存在 → volume_exists
 *   S6 ①预检：清单协议不兼容 → failed_no_changes，旧服务不受影响
 *   S7 ⑤核验新版失败（容器不健康）→ failed_restored（旧镜像 + 未修改原卷）
 *   S8 ⑥放行确认失败 → needs_attention，绝不回退原卷，放行标记仍在
 *
 * 用法：npx tsx e2e/u1_engine_boundaries.mts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../apps/updater/src/config.ts";
import { ControlFiles } from "../apps/updater/src/control.ts";
import { UpdateEngine } from "../apps/updater/src/engine.ts";
import {
  type ContainerInfo,
  DockerError,
  type DockerPort,
  type ImageInfo,
  type VolumeInfo,
} from "../apps/updater/src/docker.ts";
import type { ManifestOutcome, ManifestPort, ReleaseManifest } from "../apps/updater/src/manifest.ts";
import { createLogger } from "../apps/updater/src/log.ts";
import { type TaskRecord, FileTaskStore, createTaskRecord } from "../apps/updater/src/state.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BAD_DIGEST = `sha256:${"c".repeat(64)}`;
const OLD_DIGEST = `sha256:${"d".repeat(64)}`;
const VERSION = "0.3.0";
const IMAGE_NAME = "u1v/feedback";
const OLD_IMAGE_REF = "u1v/feedback:old";
const NEW_IMAGE_ID = "sha256:newimage000000000000000000000000000000";
const OLD_IMAGE_ID = "sha256:oldimage000000000000000000000000000000";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title}`);
}

/** 只读探针输出（真实 db-probe 解析器消费的格式）。 */
function probeLine(counts: Record<string, number>, userVersion = 3): string {
  const tables = ["users", "sessions", "apps", "settings", "feedbacks", "feedback_screenshots", "daily_usage"];
  return `PROBE:${JSON.stringify({
    ok: true,
    error: null,
    integrity: "ok",
    userVersion,
    tableNames: tables,
    counts: { users: 1, feedbacks: 2, feedback_screenshots: 0, daily_usage: 1, ...counts },
    settings: { "ai.apiKeyEnc": { present: true, bytes: 96, shape: "v1" } },
    attachments: { screenshots: [], logs: [] },
  })}`;
}

interface Knobs {
  /** 数据卷大小（KB）。 */
  sizeKb: number;
  /** 可用空间（KB）。 */
  freeKb: number;
  volumeExists: boolean;
  copyThrows: boolean;
  copyMissesEntry: boolean;
  stopExitCode: number;
  oomKilled: boolean;
  containerRunningAfterUp: boolean;
  health: string | null;
  breakAfterRelease: boolean;
  labelVersion: string;
  digestsOk: boolean;
}

class FakeDocker implements DockerPort {
  knobs: Knobs = {
    sizeKb: 1000,
    freeKb: 100_000,
    volumeExists: false,
    copyThrows: false,
    copyMissesEntry: false,
    stopExitCode: 0,
    oomKilled: false,
    containerRunningAfterUp: true,
    health: "healthy",
    breakAfterRelease: false,
    labelVersion: VERSION,
    digestsOk: true,
  };

  volumes = new Set<string>(["u1v-old-volume"]);
  copied: Array<[string, string]> = [];
  pulled: string[] = [];
  deletedVolumes: string[] = [];
  releaseWritten = false;
  container: ContainerInfo;
  newImageRef = `${IMAGE_NAME}@${DIGEST}`;
  /** 部署环境文件：假 docker 像真 daemon 一样按它决定「compose up 之后跑的是哪个镜像/卷」。 */
  envFile: string;

  constructor(envFile: string) {
    this.envFile = envFile;
    this.container = this.containerInfo(OLD_IMAGE_REF, "u1v-old-volume");
  }

  containerInfo(imageRef: string, volume: string): ContainerInfo {
    const isNew = imageRef.includes(DIGEST);
    return {
      id: isNew ? "ctr-new" : "ctr-old",
      running: true,
      exitCode: null,
      oomKilled: false,
      startedAt: new Date().toISOString(),
      imageId: isNew ? NEW_IMAGE_ID : OLD_IMAGE_ID,
      imageRef,
      labels: {},
      env: ["FEEDBACK_DATA_DIR=/data"],
      exposedPorts: ["8787/tcp"],
      health: this.knobs.health,
      mounts: [{ type: "volume", name: volume, destination: "/data", rw: true }],
      composeProject: "u1v",
      composeService: "feedback",
    };
  }

  async pullImage(ref: string): Promise<void> {
    this.pulled.push(ref);
  }

  async imageInfo(ref: string): Promise<ImageInfo> {
    const isOld = ref === OLD_IMAGE_REF || ref === OLD_IMAGE_ID;
    const digests = isOld ? [`${IMAGE_NAME}@${OLD_DIGEST}`] : [this.newImageRef];
    return {
      id: isOld ? OLD_IMAGE_ID : NEW_IMAGE_ID,
      digests: this.knobs.digestsOk ? digests : [`${IMAGE_NAME}@${BAD_DIGEST}`],
      labels: { "org.opencontainers.image.version": isOld ? "0.1.0" : this.knobs.labelVersion },
    };
  }

  async serviceContainerId(): Promise<string | null> {
    return this.container.id;
  }

  async stopFeedback(): Promise<void> {
    this.container = {
      ...this.container,
      running: false,
      exitCode: this.knobs.stopExitCode,
      oomKilled: this.knobs.oomKilled,
    };
  }

  /** 真实 daemon 行为：compose up 依据当前 .env.prod 决定镜像与数据卷。 */
  async startFeedback(): Promise<void> {
    const raw = await fs.readFile(this.envFile, "utf8");
    const image = /^FEEDBACK_IMAGE=(.*)$/m.exec(raw)?.[1]?.trim() ?? OLD_IMAGE_REF;
    const volume = /^FEEDBACK_DATA_VOLUME=(.*)$/m.exec(raw)?.[1]?.trim() ?? "u1v-old-volume";
    this.container = this.containerInfo(image, volume);
    this.container.running = this.knobs.containerRunningAfterUp;
    this.container.health = this.knobs.health;
  }

  async inspectContainer(id: string): Promise<ContainerInfo> {
    if (this.releaseWritten && this.knobs.breakAfterRelease) {
      return { ...this.container, running: false, exitCode: 137 };
    }
    return { ...this.container, id };
  }

  async createVolume(name: string): Promise<void> {
    this.volumes.add(name);
  }

  async volumeInfo(name: string): Promise<VolumeInfo> {
    const exists = this.knobs.volumeExists || this.volumes.has(name);
    return { exists, name: exists ? name : null };
  }

  async volumeEntries(volume: string): Promise<string[]> {
    const all = ["feedback.db", "feedback.db-wal", "screenshots"];
    return this.knobs.copyMissesEntry && volume.includes("data-0.3.0") ? all.slice(0, 2) : all;
  }

  async volumeSizeKb(): Promise<number> {
    return this.knobs.sizeKb;
  }

  async volumeAvailableKb(): Promise<number> {
    return this.knobs.freeKb;
  }

  async copyVolume(from: string, to: string): Promise<void> {
    if (this.knobs.copyThrows) throw new DockerError("cp 失败（注入）", { kind: "non_zero" });
    this.copied.push([from, to]);
    this.volumes.add(to);
  }

  async execNode(): Promise<string> {
    return probeLine({});
  }
}

class FakeManifest implements ManifestPort {
  required = 1;
  version = VERSION;
  digest = DIGEST;

  async load(channel: string): Promise<ManifestOutcome> {
    const manifest: ReleaseManifest = {
      manifestVersion: 1,
      version: this.version,
      commit: "b".repeat(40),
      tag: `v${this.version}`,
      channel,
      services: {
        feedback: { image: `${IMAGE_NAME}@${this.digest}`, digest: this.digest },
        updater: { image: `${IMAGE_NAME}-updater`, digest: this.digest },
      },
      platform: "linux/amd64",
      dbSchemaVersion: 3,
      requiredUpdaterProtocol: this.required,
      publishedAt: new Date(0).toISOString(),
    };
    return { kind: "ok", manifest, source: "local", location: "fixture/release-manifest.json" };
  }
}

async function scaffoldEnv(): Promise<{ root: string; deployDir: string; controlDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "u1v-engine-"));
  const deployDir = path.join(root, "deploy");
  const controlDir = path.join(deployDir, "update-control");
  await fs.mkdir(path.join(controlDir, "state"), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(deployDir, "compose.yml"),
    [
      "services:",
      "  feedback:",
      "    image: ${FEEDBACK_IMAGE}",
      "    volumes:",
      '      - feedback-data:/data',
      "volumes:",
      "  feedback-data:",
      "    external: true",
      "    name: ${FEEDBACK_DATA_VOLUME}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(deployDir, ".env.prod"),
    [
      "# 边界夹具：注释与顺序必须被执行器原样保留",
      "FEEDBACK_MASTER_KEY=u1v-engine-master-key-0123456789",
      `FEEDBACK_IMAGE=${OLD_IMAGE_REF}`,
      `FEEDBACK_DATA_VOLUME=u1v-old-volume`,
      "FEEDBACK_COOKIE_SECURE=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, deployDir, controlDir };
}

interface RunResult {
  record: TaskRecord;
  docker: FakeDocker;
  manifest: FakeManifest;
  root: string;
}

async function runEngine(options: {
  knobs?: Partial<Knobs>;
  required?: number;
  version?: string;
  digest?: string;
}): Promise<RunResult> {
  const { root, deployDir, controlDir } = await scaffoldEnv();
  const config = loadConfig({
    UPDATER_IMAGE_NAME: IMAGE_NAME,
    UPDATER_DEPLOY_DIR: deployDir,
    UPDATER_CONTROL_DIR: controlDir,
    UPDATER_STATE_DIR: path.join(controlDir, "state"),
    UPDATER_TOKEN_FILE: path.join(controlDir, "updater-token"),
    UPDATER_COMPOSE_FILE: path.join(deployDir, "compose.yml"),
    UPDATER_COMPOSE_PROJECT: "u1v",
    UPDATER_SERVICE: "feedback",
  } as unknown as NodeJS.ProcessEnv);
  await fs.writeFile(config.tokenFile, "engine-fixture-token-0123456789\n", { mode: 0o600 });

  const docker = new FakeDocker(config.envFile);
  Object.assign(docker.knobs, options.knobs ?? {});
  const manifest = new FakeManifest();
  manifest.required = options.required ?? 1;
  manifest.version = options.version ?? VERSION;
  manifest.digest = options.digest ?? DIGEST;

  const log = createLogger({ redact: [] });
  const store = new FileTaskStore({ stateDir: config.stateDir });
  await store.init();
  const realControl = new ControlFiles(config);
  // 真实控制文件实现 + 一个只用于观测「放行标记已落盘」的壳（不改变行为）。
  const control = {
    readPaused: () => realControl.readPaused(),
    writePaused: (marker: Parameters<typeof realControl.writePaused>[0]) => realControl.writePaused(marker),
    clearPaused: () => realControl.clearPaused(),
    readRelease: () => realControl.readRelease(),
    writeRelease: async (marker: Parameters<typeof realControl.writeRelease>[0]) => {
      await realControl.writeRelease(marker);
      docker.releaseWritten = true;
    },
    clearRelease: () => realControl.clearRelease(),
  };
  const base = new Date("2026-09-14T00:00:00.000Z").getTime();
  let ticks = 0;
  // 时钟必须单调推进：固定时钟会让 waitFor 的 deadline 永不到达。
  const clock = () => new Date(base + ticks++ * 1000);
  const engine = new UpdateEngine({
    config,
    docker,
    store,
    control,
    manifest,
    log,
    clock,
    sleep: async () => {},
    verifyTimeoutMs: 50,
    releaseTimeoutMs: 50,
    pollIntervalMs: 1,
    httpProbe: async () => ({ ok: true, status: 200, error: null }),
  });

  const record = createTaskRecord({
    operationId: `op-${Math.random().toString(16).slice(2, 10)}`,
    requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
    version: options.version ?? VERSION,
    digest: options.digest ?? DIGEST,
    now: new Date("2026-09-14T00:00:00.000Z"),
  });
  await store.create(record);
  const result = await engine.run(record);
  return { record: result, docker, manifest, root };
}

function evidenceCodes(record: TaskRecord): string[] {
  return record.evidence.map((entry) => `${entry.phase}:${entry.step}:${entry.ok ? "ok" : "fail"}`);
}

async function s1SpaceBoundary(): Promise<void> {
  section("S1 磁盘空间 1.2 倍边界");
  const size = 1000;
  const exactly = Math.ceil((size * 12) / 10); // 1200

  // 恰好 1.2 倍：空间检查必须通过（随后在停服阶段被故意中断，只观察空间检查结论）
  const ok = await runEngine({ knobs: { sizeKb: size, freeKb: exactly, stopExitCode: 7 } });
  const okEvidence = ok.record.evidence.find((e) => e.step === "空间检查");
  check("S1a 可用空间恰好 1.2 倍时空间检查通过", okEvidence?.ok === true, JSON.stringify(okEvidence ?? null));
  check("S1a 后续失败不是空间原因", ok.record.failure?.code !== "insufficient_space", String(ok.record.failure?.code));

  // 少 1KB：必须 insufficient_space 且未改动部署
  const bad = await runEngine({ knobs: { sizeKb: size, freeKb: exactly - 1 } });
  check("S1b 少 1KB 即 insufficient_space", bad.record.failure?.code === "insufficient_space", String(bad.record.failure?.code));
  check("S1b 分类为 failed_no_changes", bad.record.outcome === "failed_no_changes", String(bad.record.outcome));
  check("S1b 未创建/复制新卷", bad.docker.copied.length === 0 && bad.docker.volumes.size === 1, JSON.stringify([...bad.docker.volumes]));
  await fs.rm(ok.root, { recursive: true, force: true });
  await fs.rm(bad.root, { recursive: true, force: true });
}

async function s2StopFailures(): Promise<void> {
  section("S2/S3 停服异常");
  const nonzero = await runEngine({ knobs: { stopExitCode: 7 } });
  check("S2 退出码 7 → stop_abnormal_exit", nonzero.record.failure?.code === "stop_abnormal_exit", String(nonzero.record.failure?.code));
  check("S2 中止后不做备份复制", nonzero.docker.copied.length === 0, JSON.stringify(nonzero.docker.copied));
  check("S2 尝试恢复旧版本并确认", nonzero.record.outcome === "failed_restored" && nonzero.record.restore?.confirmed === true, JSON.stringify(nonzero.record.restore));

  const oom = await runEngine({ knobs: { stopExitCode: 137, oomKilled: true } });
  check("S3 OOM → stop_oom_killed", oom.record.failure?.code === "stop_oom_killed", String(oom.record.failure?.code));
  check("S3 不做备份复制", oom.docker.copied.length === 0);
  await fs.rm(nonzero.root, { recursive: true, force: true });
  await fs.rm(oom.root, { recursive: true, force: true });
}

async function s4CopyFailure(): Promise<void> {
  section("S4 复制失败");
  const r = await runEngine({ knobs: { copyThrows: true } });
  check("S4 copy_failed", r.record.failure?.code === "copy_failed", String(r.record.failure?.code));
  check("S4 尝试恢复且确认旧版本", r.record.outcome === "failed_restored" && r.record.restore?.confirmed === true, JSON.stringify(r.record.restore));
  const newVolume = r.record.newVolume ?? "";
  check("S4 新卷未被删除（仍在卷集合中）", newVolume !== "" && r.docker.volumes.has(newVolume), newVolume);
  check("S4 执行器从未调用卷删除", r.docker.deletedVolumes.length === 0);

  const miss = await runEngine({ knobs: { copyMissesEntry: true } });
  check("S4b 复制条目缺失 → copy_verify_failed", miss.record.failure?.code === "copy_verify_failed", String(miss.record.failure?.code));
  await fs.rm(r.root, { recursive: true, force: true });
  await fs.rm(miss.root, { recursive: true, force: true });
}

async function s5VolumeExists(): Promise<void> {
  section("S5 目标新卷已存在");
  const r = await runEngine({ knobs: { volumeExists: true } });
  check("S5 volume_exists（拒绝覆盖）", r.record.failure?.code === "volume_exists", String(r.record.failure?.code));
  check("S5 未执行复制", r.docker.copied.length === 0);
  await fs.rm(r.root, { recursive: true, force: true });
}

async function s6Protocol(): Promise<void> {
  section("S6 清单协议不兼容（①预检）");
  const r = await runEngine({ required: 99 });
  check("S6 updater_protocol_incompatible", r.record.failure?.code === "updater_protocol_incompatible", String(r.record.failure?.code));
  check("S6 failed_no_changes（未改动部署）", r.record.outcome === "failed_no_changes", String(r.record.outcome));
  check("S6 未拉取镜像", r.docker.pulled.length === 0);
  await fs.rm(r.root, { recursive: true, force: true });
}

async function s7VerifyFailure(): Promise<void> {
  section("S7 ⑤核验新版失败 → 恢复旧版本");
  const r = await runEngine({ knobs: { health: "unhealthy" } });
  check("S7 失败阶段为 verify_new", r.record.failure?.phase === "verify_new", String(r.record.failure?.phase));
  check("S7 outcome = failed_restored", r.record.outcome === "failed_restored", String(r.record.outcome));
  check("S7 恢复已确认（旧镜像 + 未修改原卷）", r.record.restore?.confirmed === true, JSON.stringify(r.record.restore));
  check("S7 环境文件已还原为旧镜像", r.record.previousImage === OLD_IMAGE_REF, String(r.record.previousImage));
  const newVolume = r.record.newVolume ?? "";
  check("S7 新卷保留未删除", newVolume !== "" && r.docker.volumes.has(newVolume), newVolume);
  check("S7 paused 标记已解除", !(await fileExists(path.join(path.dirname(String(r.record.backupDir)), "..", "paused"))));
  await fs.rm(r.root, { recursive: true, force: true });
}

async function s8ReleaseFailure(): Promise<void> {
  section("S8 ⑥放行确认失败 → needs_attention（绝不回退原卷）");
  const r = await runEngine({ knobs: { breakAfterRelease: true } });
  check("S8 失败阶段为 release", r.record.failure?.phase === "release", String(r.record.failure?.phase));
  check("S8 outcome = needs_attention", r.record.outcome === "needs_attention", String(r.record.outcome));
  check("S8 未执行恢复（restore 为 null）", r.record.restore === null, JSON.stringify(r.record.restore));
  const newVolume = r.record.newVolume ?? "";
  check("S8 新卷仍存在（当前数据保留）", newVolume !== "" && r.docker.volumes.has(newVolume), newVolume);
  check("S8 旧卷仍在", r.docker.volumes.has("u1v-old-volume"));
  check("S8 放行阶段已开始（release 标记落盘）", r.docker.releaseWritten === true);
  check("S8 证据链包含放行阶段", evidenceCodes(r.record).some((c) => c.startsWith("release:")));
  await fs.rm(r.root, { recursive: true, force: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("=== U1 边界场景（真实 UpdateEngine + 可编程 docker 假实现）===");
  await s1SpaceBoundary();
  await s2StopFailures();
  await s4CopyFailure();
  await s5VolumeExists();
  await s6Protocol();
  await s7VerifyFailure();
  await s8ReleaseFailure();

  console.log(`\n=== 边界场景结果：${passed} 项通过，${failures.length} 项失败 ===`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
