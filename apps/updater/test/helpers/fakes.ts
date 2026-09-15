import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type UpdaterConfig } from "../../src/config.ts";
import { ControlFiles, type ControlPort } from "../../src/control.ts";
import { LOGS_TABLE, REQUIRED_TABLES } from "../../src/db-probe.ts";
import { type ContainerInfo, DockerError, type DockerPort, type ImageInfo, type VolumeInfo } from "../../src/docker.ts";
import { parseEnvFile } from "../../src/envfile.ts";
import { createLogger, type Logger } from "../../src/log.ts";
import type { ManifestOutcome, ManifestPort, ReleaseManifest } from "../../src/manifest.ts";
import { FileTaskStore } from "../../src/state.ts";

export const DIGEST_A = `sha256:${"a".repeat(64)}`;
export const DIGEST_B = `sha256:${"b".repeat(64)}`;
export const VERSION = "0.3.0";

export function imageIdFor(ref: string): string {
  return `sha256:${createHash("sha1").update(ref).digest("hex")}`;
}

export interface Scaffold {
  root: string;
  deployDir: string;
  controlDir: string;
  stateDir: string;
  envFile: string;
  composeFile: string;
  tokenFile: string;
  token: string;
  config: UpdaterConfig;
}

export interface ScaffoldOptions {
  image?: string;
  dataVolume?: string;
  envExtra?: Record<string, string>;
  envMode?: number;
  token?: string;
  tokenMode?: number;
  imageName?: string;
  listen?: string;
}

/** 建一份最小可用的部署目录（compose + .env.prod + 控制目录 + 600 令牌）。 */
export async function scaffold(options: ScaffoldOptions = {}): Promise<Scaffold> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "updater-test-"));
  const deployDir = path.join(root, "deploy");
  const controlDir = path.join(deployDir, "update-control");
  const stateDir = path.join(controlDir, "state");
  await fs.mkdir(deployDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

  const composeFile = path.join(deployDir, "compose.yml");
  // 用拼接写出 compose 的变量占位，避免 lint 把字符串当成模板字符串
  const ph = "$";
  await fs.writeFile(
    composeFile,
    [
      "services:",
      "  feedback:",
      `    image: ${ph}{FEEDBACK_IMAGE}`,
      "    volumes:",
      "      - feedback-data:/data",
      "volumes:",
      "  feedback-data:",
      "    external: true",
      `    name: ${ph}{FEEDBACK_DATA_VOLUME}`,
      "",
    ].join("\n"),
  );

  const image = options.image ?? "feedback-service:local";
  const dataVolume = options.dataVolume ?? "feedback_feedback-data";
  const envFile = path.join(deployDir, ".env.prod");
  const envLines = [
    "# 测试用部署环境文件：注释与顺序必须被原样保留",
    "FEEDBACK_MASTER_KEY=test-master-key-0123456789",
    "FEEDBACK_ADMIN_USER=admin",
    `FEEDBACK_IMAGE=${image}`,
    `FEEDBACK_DATA_VOLUME=${dataVolume}`,
    "FEEDBACK_COOKIE_SECURE=true",
    "",
  ];
  await fs.writeFile(envFile, envLines.join("\n"), { mode: 0o600 });
  if (options.envMode !== undefined) await fs.chmod(envFile, options.envMode);

  const token = options.token ?? "test-shared-token-0123456789";
  const tokenFile = path.join(controlDir, "updater-token");
  await fs.writeFile(tokenFile, `${token}\n`, { mode: options.tokenMode ?? 0o600 });

  const config = loadConfig({
    UPDATER_DEPLOY_DIR: deployDir,
    UPDATER_CONTROL_DIR: controlDir,
    UPDATER_STATE_DIR: stateDir,
    UPDATER_TOKEN_FILE: tokenFile,
    UPDATER_IMAGE_NAME: options.imageName ?? "feedback-service:local",
    UPDATER_LISTEN: options.listen ?? "127.0.0.1:18790",
  });

  return { root, deployDir, controlDir, stateDir, envFile, composeFile, tokenFile, token, config };
}

export function makeManifest(
  overrides: Partial<ReleaseManifest> = {},
  imageName = "feedback-service:local",
): ReleaseManifest {
  const digest = overrides.services?.feedback.digest ?? DIGEST_A;
  return {
    manifestVersion: 1,
    version: VERSION,
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    tag: "v0.3.0",
    channel: "stable",
    services: {
      feedback: { image: `${imageName}@${digest}`, digest },
      updater: { image: "ghcr.io/sakuralovesmile/sakura-feedback-updater", digest: DIGEST_B },
    },
    platform: "linux/amd64",
    dbSchemaVersion: 4,
    requiredUpdaterProtocol: 1,
    publishedAt: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

/** 固定清单来源：可切换为 missing/invalid/unreachable。 */
export class FakeManifest implements ManifestPort {
  outcome: ManifestOutcome;
  loads = 0;

  constructor(outcome?: ManifestOutcome) {
    this.outcome = outcome ?? {
      kind: "ok",
      manifest: makeManifest(),
      source: "local",
      location: "/deploy/release-manifest.json",
    };
  }

  async load(): Promise<ManifestOutcome> {
    this.loads += 1;
    return this.outcome;
  }
}

export function probeJson(
  overrides: Partial<{
    ok: boolean;
    error: string | null;
    integrity: string | null;
    userVersion: number | null;
    tableNames: string[];
    counts: Record<string, number | null>;
    settings: Record<string, { present: boolean; bytes: number; shape: string }>;
  }> = {},
): string {
  const payload = {
    ok: true,
    error: null,
    integrity: "ok",
    userVersion: 4,
    tableNames: [...REQUIRED_TABLES, LOGS_TABLE],
    counts: { users: 2, feedbacks: 5, feedback_screenshots: 3, daily_usage: 7, feedback_logs: 0 },
    settings: {
      "ai.baseUrl": { present: true, bytes: 24, shape: "url" },
      "ai.apiKeyEnc": { present: true, bytes: 64, shape: "v1" },
    },
    attachments: {
      screenshots: [
        {
          feedbackId: "fb-screen-1",
          byteSize: 1,
          sha256: "a".repeat(64),
          storedByteSize: 1,
          storedSha256: "a".repeat(64),
          metadataValid: true,
        },
        {
          feedbackId: "fb-screen-2",
          byteSize: 2,
          sha256: "b".repeat(64),
          storedByteSize: 2,
          storedSha256: "b".repeat(64),
          metadataValid: true,
        },
        {
          feedbackId: "fb-screen-3",
          byteSize: 3,
          sha256: "c".repeat(64),
          storedByteSize: 3,
          storedSha256: "c".repeat(64),
          metadataValid: true,
        },
      ],
      logs: [],
    },
    ...overrides,
  };
  return `PROBE:${JSON.stringify(payload)}`;
}

export interface FakeDockerOptions {
  envFile: string;
  containerId?: string;
  imageRef?: string;
  dataVolume?: string | null;
  running?: boolean;
  health?: string | null;
  stopExitCode?: number;
  stopOomKilled?: boolean;
  availableKb?: number;
}

/**
 * 内存版 docker：模拟「compose 项目 + 服务 + 数据卷」的真实行为，
 * 并在每次调用时记录 argv，便于断言执行器只用了参数数组与受限命令。
 */
export class FakeDocker implements DockerPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly images = new Map<string, ImageInfo>();
  readonly volumes = new Map<string, string[]>();
  readonly sizes = new Map<string, number>();
  readonly failures = new Map<string, Error>();
  availableKb: number;
  probeOutputs: string[] = [];
  probeByContainerId = new Map<string, string>();
  startCount = 0;
  stopCount = 0;
  containerVersion = 0;
  private lastProbe: string | null = null;

  containerId: string;
  running: boolean;
  health: string | null;
  imageRef: string;
  imageId: string;
  dataVolume: string | null;
  exitCode: number | null = 0;
  oomKilled = false;
  exists = true;
  stopExitCode: number;
  stopOomKilled: boolean;
  private readonly envFile: string;

  constructor(options: FakeDockerOptions) {
    this.envFile = options.envFile;
    this.containerId = options.containerId ?? "container-old-1";
    this.running = options.running ?? true;
    this.health = options.health ?? "healthy";
    this.imageRef = options.imageRef ?? "feedback-service:local";
    this.imageId = imageIdFor(this.imageRef);
    this.dataVolume = options.dataVolume === undefined ? "feedback_feedback-data" : options.dataVolume;
    this.availableKb = options.availableKb ?? 10_000_000;
    this.stopExitCode = options.stopExitCode ?? 0;
    this.stopOomKilled = options.stopOomKilled ?? false;
    if (this.dataVolume) {
      this.volumes.set(this.dataVolume, ["feedback.db", "feedback.db-wal", "shots"]);
      this.sizes.set(this.dataVolume, 1000);
    }
    // 旧镜像本来就在本地（可能没有 RepoDigest，与本地构建的镜像一致）
    this.registerImage(this.imageRef);
  }

  private record(method: string, args: unknown[] = []): void {
    this.calls.push({ method, args });
  }

  private fail(method: string): void {
    const error = this.failures.get(method);
    if (error) throw error;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  registerImage(ref: string, labels: Record<string, string> = {}): ImageInfo {
    const info: ImageInfo = { id: imageIdFor(ref), digests: ref.includes("@") ? [ref] : [], labels };
    this.images.set(ref, info);
    return info;
  }

  async pullImage(ref: string): Promise<void> {
    this.record("pullImage", [ref]);
    this.fail("pullImage");
    this.registerImage(ref);
  }

  async imageInfo(ref: string): Promise<ImageInfo> {
    this.record("imageInfo", [ref]);
    this.fail("imageInfo");
    const direct = this.images.get(ref);
    if (direct) return direct;
    for (const info of this.images.values()) {
      if (info.id === ref) return info;
    }
    throw new DockerError("Error: No such image", { kind: "non_zero", exitCode: 1 });
  }

  async serviceContainerId(): Promise<string | null> {
    this.record("serviceContainerId");
    this.fail("serviceContainerId");
    return this.exists ? this.containerId : null;
  }

  async stopFeedback(graceSeconds: number): Promise<void> {
    this.record("stopFeedback", [graceSeconds]);
    this.stopCount += 1;
    this.fail("stopFeedback");
    this.running = false;
    this.exitCode = this.stopExitCode;
    this.oomKilled = this.stopOomKilled;
  }

  async startFeedback(): Promise<void> {
    this.record("startFeedback");
    this.startCount += 1;
    this.fail("startFeedback");
    const values = parseEnvFile(await fs.readFile(this.envFile, "utf8"));
    const image = values.get("FEEDBACK_IMAGE");
    const volume = values.get("FEEDBACK_DATA_VOLUME");
    if (image) this.imageRef = image;
    if (volume) this.dataVolume = volume;
    this.imageId = imageIdFor(this.imageRef);
    // compose up --force-recreate 会换一个新容器
    this.containerVersion += 1;
    this.containerId = `container-v${this.containerVersion}`;
    this.running = true;
    this.exitCode = null;
    this.oomKilled = false;
  }

  async inspectContainer(id: string): Promise<ContainerInfo> {
    this.record("inspectContainer", [id]);
    this.fail("inspectContainer");
    return {
      id: this.containerId,
      running: this.running,
      exitCode: this.exitCode,
      oomKilled: this.oomKilled,
      startedAt: "2026-09-14T00:00:00Z",
      imageId: this.imageId,
      imageRef: this.imageRef,
      labels: {
        "com.docker.compose.project": "feedback",
        "com.docker.compose.service": "feedback",
      },
      env: ["FEEDBACK_DATA_DIR=/data", "FEEDBACK_PORT=8787"],
      exposedPorts: ["8787/tcp"],
      health: this.health,
      mounts:
        this.dataVolume === null ? [] : [{ type: "volume", name: this.dataVolume, destination: "/data", rw: true }],
      composeProject: "feedback",
      composeService: "feedback",
    };
  }

  async createVolume(name: string): Promise<void> {
    this.record("createVolume", [name]);
    this.fail("createVolume");
    this.volumes.set(name, []);
    this.sizes.set(name, 0);
  }

  async volumeInfo(name: string): Promise<VolumeInfo> {
    this.record("volumeInfo", [name]);
    this.fail("volumeInfo");
    return this.volumes.has(name) ? { exists: true, name } : { exists: false, name: null };
  }

  async volumeEntries(volume: string, helperImage: string): Promise<string[]> {
    this.record("volumeEntries", [volume, helperImage]);
    this.fail("volumeEntries");
    const entries = this.volumes.get(volume);
    if (!entries) throw new DockerError(`Error: No such volume: ${volume}`, { kind: "non_zero", exitCode: 1 });
    return [...entries].sort();
  }

  async volumeSizeKb(volume: string, helperImage: string): Promise<number> {
    this.record("volumeSizeKb", [volume, helperImage]);
    this.fail("volumeSizeKb");
    return this.sizes.get(volume) ?? 0;
  }

  async volumeAvailableKb(volume: string, helperImage: string): Promise<number> {
    this.record("volumeAvailableKb", [volume, helperImage]);
    this.fail("volumeAvailableKb");
    return this.availableKb;
  }

  async copyVolume(from: string, to: string, helperImage: string): Promise<void> {
    this.record("copyVolume", [from, to, helperImage]);
    this.fail("copyVolume");
    const entries = this.volumes.get(from) ?? [];
    this.volumes.set(to, [...entries]);
    this.sizes.set(to, this.sizes.get(from) ?? 0);
  }

  async execNode(containerId: string, script: string, env: Record<string, string>): Promise<string> {
    this.record("execNode", [containerId, script.length, env]);
    this.fail("execNode");
    const pinned = this.probeByContainerId.get(containerId);
    if (pinned !== undefined) return pinned;
    const next = this.probeOutputs.shift();
    if (next !== undefined) this.lastProbe = next;
    return this.lastProbe ?? probeJson();
  }
}

export function captureLogger(redact: string[] = []): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), redact });
  return { log, lines };
}

export function makeClock(startIso = "2026-09-14T12:00:00.000Z", stepMs = 250): () => Date {
  let current = new Date(startIso).getTime();
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}

export interface Harness {
  scaffold: Scaffold;
  docker: FakeDocker;
  store: FileTaskStore;
  control: ControlPort;
  controlFiles: ControlFiles;
  manifest: FakeManifest;
  log: Logger;
  logLines: string[];
}

export async function makeHarness(
  options: ScaffoldOptions & { docker?: Partial<FakeDockerOptions>; manifest?: ManifestOutcome } = {},
): Promise<Harness> {
  const dirs = await scaffold(options);
  const docker = new FakeDocker({
    envFile: dirs.envFile,
    imageRef: options.image ?? "feedback-service:local",
    dataVolume: options.dataVolume ?? "feedback_feedback-data",
    ...options.docker,
  });
  const { log, lines } = captureLogger([options.token ?? dirs.token]);
  const store = new FileTaskStore({ stateDir: dirs.stateDir, log });
  await store.init();
  const controlFiles = new ControlFiles(dirs.config);
  const manifest = new FakeManifest(options.manifest);
  return { scaffold: dirs, docker, store, control: controlFiles, controlFiles, manifest, log, logLines: lines };
}

export async function readEnvValues(file: string): Promise<Map<string, string>> {
  return parseEnvFile(await fs.readFile(file, "utf8"));
}

export async function readRawEnv(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}
