import { execFile } from "node:child_process";
import type { UpdaterConfig } from "./config.ts";
import type { Logger } from "./log.ts";

export type DockerFailureKind = "missing_binary" | "non_zero" | "invalid_output" | "timeout" | "forbidden_command";

export class DockerError extends Error {
  readonly kind: DockerFailureKind;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    options: { kind: DockerFailureKind; args?: readonly string[]; exitCode?: number | null; stderr?: string },
  ) {
    super(message);
    this.name = "DockerError";
    this.kind = options.kind;
    this.args = options.args ?? [];
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SpawnImpl = (binary: string, args: readonly string[], options: SpawnOptions) => Promise<SpawnResult>;

export interface ImageInfo {
  id: string;
  digests: string[];
  labels: Record<string, string>;
}

export interface ContainerMount {
  type: string;
  name: string | null;
  destination: string;
  rw: boolean;
}

export interface ContainerInfo {
  id: string;
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  imageId: string;
  imageRef: string;
  labels: Record<string, string>;
  env: string[];
  exposedPorts: string[];
  health: string | null;
  mounts: ContainerMount[];
  composeProject: string | null;
  composeService: string | null;
}

export interface VolumeInfo {
  exists: boolean;
  name: string | null;
}

/**
 * 执行器唯一允许触碰的 docker 能力集合：服务名与项目名来自进程环境（预配置），
 * 调用方（阶段机）无法传入任何服务名、compose 路径、镜像或卷名。
 */
export interface DockerPort {
  pullImage(ref: string): Promise<void>;
  imageInfo(ref: string): Promise<ImageInfo>;
  serviceContainerId(): Promise<string | null>;
  stopFeedback(graceSeconds: number): Promise<void>;
  startFeedback(): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInfo>;
  createVolume(name: string): Promise<void>;
  volumeInfo(name: string): Promise<VolumeInfo>;
  volumeEntries(volume: string, helperImage: string): Promise<string[]>;
  volumeSizeKb(volume: string, helperImage: string): Promise<number>;
  volumeAvailableKb(volume: string, helperImage: string): Promise<number>;
  copyVolume(from: string, to: string, helperImage: string): Promise<void>;
  execNode(containerId: string, script: string, env: Record<string, string>): Promise<string>;
}

export interface DockerCliOptions {
  binary?: string;
  spawn?: SpawnImpl;
  log?: Logger;
  pullTimeoutMs?: number;
  composeTimeoutMs?: number;
  helperTimeoutMs?: number;
  maxBufferBytes?: number;
}

const DEFAULT_PULL_TIMEOUT_MS = 900_000;
const DEFAULT_COMPOSE_TIMEOUT_MS = 180_000;
const DEFAULT_HELPER_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

function defaultSpawn(binary: string, args: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        shell: false,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(
              new DockerError(`docker 可执行文件不存在（${binary}），执行器无法继续`, {
                kind: "missing_binary",
                args: [...args],
                stderr: err,
              }),
            );
            return;
          }
          if (error.killed || code === "ETIMEDOUT") {
            reject(
              new DockerError(`docker 命令超时（${options.timeoutMs}ms）`, {
                kind: "timeout",
                args: [...args],
                stderr: err,
              }),
            );
            return;
          }
          resolve({ stdout: out, stderr: err, exitCode: typeof code === "number" ? code : 1 });
          return;
        }
        resolve({ stdout: out, stderr: err, exitCode: 0 });
      },
    );
  });
}

function parseInspectJson(stdout: string, label: string, args: readonly string[]): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) {
    throw new DockerError(`docker ${label} 输出为空，无法判定实际状态`, { kind: "invalid_output", args: [...args] });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DockerError(`docker ${label} 输出不是合法 JSON`, { kind: "invalid_output", args: [...args] });
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== "object") {
    throw new DockerError(`docker ${label} 输出结构异常`, { kind: "invalid_output", args: [...args] });
  }
  return record as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** 明确禁止的破坏性命令：执行器绝不清理镜像、卷或系统资源。 */
const FORBIDDEN_COMMANDS = new Set(["prune", "rmi", "rm"]);

export function assertNotDestructive(args: readonly string[]): void {
  const [command, subcommand] = args;
  if (command && FORBIDDEN_COMMANDS.has(command)) {
    throw new DockerError(`执行器禁止执行破坏性 docker 命令：${command}`, {
      kind: "forbidden_command",
      args: [...args],
    });
  }
  if (command === "volume" && subcommand === "rm") {
    throw new DockerError("执行器禁止删除卷（备份卷/旧卷都保留用于诊断与恢复）", {
      kind: "forbidden_command",
      args: [...args],
    });
  }
  if (command === "image" && subcommand === "rmi") {
    throw new DockerError("执行器禁止删除镜像（旧镜像必须保留用于回退）", {
      kind: "forbidden_command",
      args: [...args],
    });
  }
  if (command === "system" && subcommand === "prune") {
    throw new DockerError("执行器禁止执行 docker system prune", { kind: "forbidden_command", args: [...args] });
  }
}

export class DockerCli implements DockerPort {
  private readonly config: UpdaterConfig;
  private readonly binary: string;
  private readonly spawn: SpawnImpl;
  private readonly log: Logger | undefined;
  private readonly pullTimeoutMs: number;
  private readonly composeTimeoutMs: number;
  private readonly helperTimeoutMs: number;
  private readonly maxBuffer: number;

  constructor(config: UpdaterConfig, options: DockerCliOptions = {}) {
    this.config = config;
    this.binary = options.binary ?? "docker";
    this.spawn = options.spawn ?? defaultSpawn;
    this.log = options.log;
    this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
    this.composeTimeoutMs = options.composeTimeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS;
    this.helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    this.maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  /** compose 全局参数：项目名、compose 文件、环境文件全部来自进程环境，不接受调用方输入。 */
  private composeArgs(subArgs: readonly string[]): string[] {
    return [
      "compose",
      "--env-file",
      this.config.envFile,
      "-f",
      this.config.composeFile,
      "--project-name",
      this.config.composeProject,
      ...subArgs,
    ];
  }

  private helperArgs(volume: string, helperImage: string, command: readonly string[]): string[] {
    const [entrypoint, ...rest] = command;
    if (!entrypoint) throw new DockerError("辅助容器命令缺失", { kind: "invalid_output" });
    return [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      entrypoint,
      "-v",
      `${volume}:/from:ro`,
      helperImage,
      ...rest,
    ];
  }

  private async run(
    args: readonly string[],
    options: { label: string; timeoutMs?: number; allowFailure?: boolean; failKind?: DockerFailureKind },
  ): Promise<CommandResult> {
    assertNotDestructive(args);
    const timeoutMs = options.timeoutMs ?? this.composeTimeoutMs;
    const started = Date.now();
    const result = await this.spawn(this.binary, args, { timeoutMs, maxBuffer: this.maxBuffer, shell: false });
    const durationMs = Date.now() - started;
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (options.allowFailure) {
        this.log?.warn("docker 命令返回非零（按预期处理）", {
          label: options.label,
          exitCode: result.exitCode,
          durationMs,
        });
        return result;
      }
      throw new DockerError(`docker ${options.label} 失败（exit ${result.exitCode}）: ${detail}`, {
        kind: options.failKind ?? "non_zero",
        args: [...args],
        exitCode: result.exitCode,
        stderr: detail,
      });
    }
    this.log?.info("docker 命令完成", { label: options.label, durationMs });
    return result;
  }

  async pullImage(ref: string): Promise<void> {
    await this.run(["pull", ref], {
      label: "pull",
      timeoutMs: this.pullTimeoutMs,
      failKind: "non_zero",
    });
  }

  async imageInfo(ref: string): Promise<ImageInfo> {
    const args = ["image", "inspect", "--format", "{{json .}}", ref];
    const result = await this.run(args, { label: "image-inspect" });
    const record = parseInspectJson(result.stdout, "image inspect", args);
    const id = record.Id;
    if (typeof id !== "string" || id.length === 0) {
      throw new DockerError("docker image inspect 未返回镜像 ID", { kind: "invalid_output", args });
    }
    return { id, digests: asStringList(record.RepoDigests), labels: asStringMap(asRecord(record.Config).Labels) };
  }

  /** 只按预配置项目 + 服务标签定位容器，不依赖客户端输入，也不受容器是否运行影响。 */
  async serviceContainerId(): Promise<string | null> {
    const args = [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${this.config.composeProject}`,
      "--filter",
      `label=com.docker.compose.service=${this.config.service}`,
      "--format",
      "{{.ID}}",
    ];
    const result = await this.run(args, { label: "ps" });
    const ids = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return ids[0] ?? null;
  }

  async stopFeedback(graceSeconds: number): Promise<void> {
    await this.run(this.composeArgs(["stop", "-t", String(graceSeconds), this.config.service]), {
      label: "compose-stop",
      timeoutMs: this.composeTimeoutMs + graceSeconds * 1000,
    });
  }

  async startFeedback(): Promise<void> {
    await this.run(
      this.composeArgs(["up", "-d", "--force-recreate", "--no-deps", "--pull", "never", this.config.service]),
      { label: "compose-up", timeoutMs: this.composeTimeoutMs + 120_000 },
    );
  }

  async inspectContainer(id: string): Promise<ContainerInfo> {
    const args = ["inspect", "--format", "{{json .}}", id];
    const result = await this.run(args, { label: "inspect" });
    const record = parseInspectJson(result.stdout, "inspect", args);
    const state = asRecord(record.State);
    const config = asRecord(record.Config);
    const health = asRecord(state.Health);
    const mounts = Array.isArray(record.Mounts) ? record.Mounts : [];
    return {
      id: typeof record.Id === "string" ? record.Id : id,
      running: state.Running === true,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      oomKilled: state.OOMKilled === true,
      startedAt: typeof state.StartedAt === "string" ? state.StartedAt : null,
      imageId: typeof record.Image === "string" ? record.Image : "",
      imageRef: typeof config.Image === "string" ? config.Image : "",
      labels: asStringMap(config.Labels),
      env: asStringList(config.Env),
      exposedPorts: Object.keys(asRecord(config.ExposedPorts)),
      health: typeof health.Status === "string" ? health.Status : null,
      mounts: mounts.map((entry) => {
        const mount = asRecord(entry);
        return {
          type: typeof mount.Type === "string" ? mount.Type : "",
          name: typeof mount.Name === "string" ? mount.Name : null,
          destination: typeof mount.Destination === "string" ? mount.Destination : "",
          rw: mount.RW === true,
        };
      }),
      composeProject: asStringMap(config.Labels)["com.docker.compose.project"] ?? null,
      composeService: asStringMap(config.Labels)["com.docker.compose.service"] ?? null,
    };
  }

  async createVolume(name: string): Promise<void> {
    await this.run(["volume", "create", name], { label: "volume-create" });
  }

  async volumeInfo(name: string): Promise<VolumeInfo> {
    const args = ["volume", "inspect", "--format", "{{json .}}", name];
    const result = await this.run(args, { label: "volume-inspect", allowFailure: true });
    if (result.exitCode !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (detail.includes("no such volume") || detail.includes("not found")) return { exists: false, name: null };
      throw new DockerError(`docker volume inspect 失败（exit ${result.exitCode}）: ${result.stderr.trim()}`, {
        kind: "non_zero",
        args,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    const record = parseInspectJson(result.stdout, "volume inspect", args);
    return { exists: true, name: typeof record.Name === "string" ? record.Name : name };
  }

  async volumeEntries(volume: string, helperImage: string): Promise<string[]> {
    const args = this.helperArgs(volume, helperImage, ["ls", "-A", "/from"]);
    const result = await this.run(args, { label: "volume-ls", timeoutMs: this.helperTimeoutMs });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  }

  async volumeSizeKb(volume: string, helperImage: string): Promise<number> {
    const args = this.helperArgs(volume, helperImage, ["du", "-sk", "/from"]);
    const result = await this.run(args, { label: "volume-du", timeoutMs: this.helperTimeoutMs });
    return parseFirstInteger(result.stdout, "du", args);
  }

  async volumeAvailableKb(volume: string, helperImage: string): Promise<number> {
    const args = this.helperArgs(volume, helperImage, ["df", "-kP", "/from"]);
    const result = await this.run(args, { label: "volume-df", timeoutMs: this.helperTimeoutMs });
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    if (!last) {
      throw new DockerError("docker df 输出为空，无法判定可用空间", { kind: "invalid_output", args });
    }
    const columns = last.split(/\s+/);
    const available = Number(columns[3]);
    if (!Number.isFinite(available)) {
      throw new DockerError(`docker df 输出无法解析：${last}`, { kind: "invalid_output", args });
    }
    return available;
  }

  async copyVolume(from: string, to: string, helperImage: string): Promise<void> {
    const args = [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "cp",
      "-v",
      `${from}:/from:ro`,
      "-v",
      `${to}:/to`,
      helperImage,
      "-a",
      "/from/.",
      "/to/",
    ];
    await this.run(args, { label: "volume-copy", timeoutMs: this.helperTimeoutMs });
  }

  async execNode(containerId: string, script: string, env: Record<string, string>): Promise<string> {
    const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const args = ["exec", ...envArgs, containerId, "node", "-e", script];
    const result = await this.run(args, { label: "exec-node", timeoutMs: this.helperTimeoutMs });
    return result.stdout;
  }
}

function parseFirstInteger(stdout: string, label: string, args: readonly string[]): number {
  const text = stdout.trim();
  const match = /^(\d+)/.exec(text);
  if (!match) {
    throw new DockerError(`docker ${label} 输出无法解析：${text.slice(0, 200)}`, {
      kind: "invalid_output",
      args: [...args],
    });
  }
  return Number(match[1]);
}
