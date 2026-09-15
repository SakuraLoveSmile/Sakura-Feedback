import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPort, MarkerState, PauseMarker, ReleaseMarker } from "../src/control.ts";
import { ControlFiles } from "../src/control.ts";
import type { EngineOptions } from "../src/engine.ts";
import { UpdateEngine } from "../src/engine.ts";
import { ENV_DATA_VOLUME_KEY, ENV_IMAGE_KEY, parseEnvFile } from "../src/envfile.ts";
import type { ManifestOutcome } from "../src/manifest.ts";
import { createTaskRecord, FileTaskStore, type TaskRecord } from "../src/state.ts";
import {
  captureLogger,
  DIGEST_A,
  DIGEST_B,
  FakeDocker,
  type FakeDockerOptions,
  FakeManifest,
  imageIdFor,
  makeClock,
  makeManifest,
  probeJson,
  type Scaffold,
  type ScaffoldOptions,
  scaffold,
  VERSION,
} from "./helpers/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const ALLOWED_DOCKER_METHODS = new Set([
  "pullImage",
  "imageInfo",
  "serviceContainerId",
  "stopFeedback",
  "startFeedback",
  "inspectContainer",
  "createVolume",
  "volumeInfo",
  "volumeEntries",
  "volumeSizeKb",
  "volumeAvailableKb",
  "copyVolume",
  "execNode",
]);

interface SetupOptions {
  scaffold?: ScaffoldOptions;
  docker?: Partial<FakeDockerOptions>;
  manifest?: ManifestOutcome;
  dockerFactory?: (dirs: Scaffold, defaults: FakeDockerOptions) => FakeDocker;
  engine?: Partial<EngineOptions>;
  controlFactory?: (dirs: Scaffold, inner: ControlPort) => ControlPort;
  version?: string;
  digest?: string;
  mutate?: (dirs: Scaffold) => Promise<void>;
}

interface Setup {
  record: TaskRecord;
  dirs: Scaffold;
  docker: FakeDocker;
  store: FileTaskStore;
  control: ControlPort;
  engine: UpdateEngine;
  logLines: string[];
}

async function setupRun(options: SetupOptions = {}): Promise<Setup> {
  const dirs = await scaffold(options.scaffold);
  roots.push(dirs.root);
  if (options.mutate) await options.mutate(dirs);
  const defaults: FakeDockerOptions = {
    envFile: dirs.envFile,
    imageRef: options.scaffold?.image ?? "feedback-service:local",
    dataVolume: options.scaffold?.dataVolume ?? "feedback_feedback-data",
    ...options.docker,
  };
  const docker = options.dockerFactory ? options.dockerFactory(dirs, defaults) : new FakeDocker(defaults);
  const { log, lines } = captureLogger([dirs.token]);
  const store = new FileTaskStore({ stateDir: dirs.stateDir, log });
  await store.init();
  const inner = new ControlFiles(dirs.config);
  const control = options.controlFactory ? options.controlFactory(dirs, inner) : inner;
  const manifest = new FakeManifest(options.manifest);
  const engine = new UpdateEngine({
    config: dirs.config,
    docker,
    store,
    control,
    manifest,
    log,
    clock: makeClock(),
    sleep: async () => {},
    pollIntervalMs: 1,
    verifyTimeoutMs: 5_000,
    releaseTimeoutMs: 5_000,
    httpProbe: async () => ({ ok: true, status: 200, error: null }),
    ...options.engine,
  });
  const task = createTaskRecord({
    operationId: "op-t1",
    requestId: "req-1",
    version: options.version ?? VERSION,
    digest: options.digest ?? DIGEST_A,
    now: new Date("2026-09-14T12:00:00.000Z"),
  });
  await store.create(task);
  const record = await engine.run(task);
  return { record, dirs, docker, store, control, engine, logLines: lines };
}

async function envValues(file: string): Promise<Map<string, string>> {
  return parseEnvFile(await fs.readFile(file, "utf8"));
}

describe("更新成功路径", () => {
  it("按六阶段顺序执行、每阶段落盘、旧镜像与旧卷保留、最后放行", async () => {
    const setup = await setupRun();
    const { record, docker, dirs } = setup;

    expect(record.status).toBe("succeeded");
    expect(record.outcome).toBe("succeeded");
    expect(record.phase).toBe("done");
    expect(record.message).toContain("已放行 v0.3.0");

    const phases = record.evidence.map((entry) => entry.phase);
    const expectedOrder = ["preflight_pull", "pause_stop", "backup_copy", "start_paused", "verify_new", "release"];
    const firstIndexes = expectedOrder.map((phase) => phases.indexOf(phase as never));
    expect(firstIndexes.every((index) => index >= 0)).toBe(true);
    expect([...firstIndexes].sort((a, b) => a - b)).toEqual(firstIndexes);
    expect(record.evidence.every((entry) => entry.ok)).toBe(true);

    // 环境文件被原子替换为新镜像与新数据卷，其它字段不变
    const values = await envValues(dirs.envFile);
    expect(values.get(ENV_IMAGE_KEY)).toBe(`feedback-service:local@${DIGEST_A}`);
    expect(values.get(ENV_DATA_VOLUME_KEY)).toBe(record.newVolume);
    expect(values.get("FEEDBACK_MASTER_KEY")).toBe("test-master-key-0123456789");
    expect(values.get("FEEDBACK_COOKIE_SECURE")).toBe("true");
    const raw = await fs.readFile(dirs.envFile, "utf8");
    expect(raw).toContain("# 测试用部署环境文件：注释与顺序必须被原样保留");

    // 旧卷完整保留，新卷为独立副本
    expect(docker.volumes.get("feedback_feedback-data")).toEqual(["feedback.db", "feedback.db-wal", "shots"]);
    expect(
      docker.volumes
        .get(record.newVolume as string)
        ?.slice()
        .sort(),
    ).toEqual(["feedback.db", "feedback.db-wal", "shots"]);

    // 暂停标记已解除，放行标记与任务文件均已落盘
    expect((await setup.control.readPaused()).state).toBe("absent");
    const release = await setup.control.readRelease();
    expect(release.state).toBe("ok");
    if (release.state === "ok") expect(release.marker.volume).toBe(record.newVolume);
    const persisted = await setup.store.get("op-t1");
    expect(persisted?.status).toBe("succeeded");
    expect(path.isAbsolute(record.backupDir as string)).toBe(true);

    // 备份目录含受限副本
    const backupFiles = (await fs.readdir(record.backupDir as string)).sort();
    expect(backupFiles).toEqual([".env.prod", "compose.yml", "restore.json"]);
    for (const file of backupFiles) {
      const stat = await fs.stat(path.join(record.backupDir as string, file));
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // 只用了允许的 docker 能力，没有任何删除/清理动作
    expect(docker.methods().every((method) => ALLOWED_DOCKER_METHODS.has(method))).toBe(true);
    expect(docker.stopCount).toBe(1);
    expect(docker.startCount).toBe(1);
    expect(docker.calls.some((call) => call.method === "copyVolume")).toBe(true);
  });

  it("重启后读取落盘任务仍是终态，且日志里没有共享令牌", async () => {
    const setup = await setupRun();
    const reopened = new FileTaskStore({ stateDir: setup.dirs.stateDir });
    const record = await reopened.get("op-t1");
    expect(record?.status).toBe("succeeded");
    expect(setup.logLines.join("\n")).not.toContain(setup.dirs.token);
  });
});

describe("预检阶段失败（未改动部署）", () => {
  it("清单缺失时拒绝更新且不触碰服务", async () => {
    const setup = await setupRun({ manifest: { kind: "missing" } });
    expect(setup.record.status).toBe("failed");
    expect(setup.record.outcome).toBe("failed_no_changes");
    expect(setup.record.failure?.code).toBe("manifest_missing");
    expect(setup.docker.methods()).not.toContain("stopFeedback");
    expect((await setup.control.readPaused()).state).toBe("absent");
    const values = await envValues(setup.dirs.envFile);
    expect(values.get(ENV_IMAGE_KEY)).toBe("feedback-service:local");
  });

  it("清单协议不兼容时给出执行器升级指引并且不改动部署", async () => {
    const setup = await setupRun({
      manifest: {
        kind: "ok",
        manifest: makeManifest({ requiredUpdaterProtocol: 2 }),
        source: "local",
        location: "/deploy/release-manifest.json",
      },
    });
    expect(setup.record.status).toBe("failed");
    expect(setup.record.failure?.code).toBe("updater_protocol_incompatible");
    expect(setup.record.failure?.message).toContain("不会重建自己");
    expect(setup.docker.methods()).toEqual([]);
  });

  it("请求版本或 digest 与清单不一致时拒绝", async () => {
    const versionMismatch = await setupRun({ version: "0.2.9" });
    expect(versionMismatch.record.failure?.code).toBe("version_mismatch");
    expect(versionMismatch.record.outcome).toBe("failed_no_changes");

    const digestMismatch = await setupRun({
      manifest: {
        kind: "ok",
        manifest: makeManifest(),
        source: "local",
        location: "/deploy/release-manifest.json",
      },
      digest: DIGEST_B,
    });
    expect(digestMismatch.record.failure?.code).toBe("digest_mismatch");
    expect(digestMismatch.docker.methods()).not.toContain("pullImage");
  });

  it("拉取失败即中止，旧服务继续运行", async () => {
    const failing = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        docker.failures.set("pullImage", new Error("manifest unknown"));
        return docker;
      },
    });
    expect(failing.record.status).toBe("failed");
    expect(failing.record.outcome).toBe("failed_no_changes");
    expect(failing.record.failure?.code).toBe("pull_failed");
    expect(failing.record.failure?.message).toContain("manifest unknown");
    expect(failing.docker.methods()).not.toContain("stopFeedback");
    expect(failing.docker.methods()).not.toContain("createVolume");
  });

  it("部署环境文件未登记数据卷时拒绝更新", async () => {
    const setup = await setupRun({
      mutate: async (dirs) => {
        await fs.writeFile(dirs.envFile, "FEEDBACK_IMAGE=feedback-service:local\n", { mode: 0o600 });
      },
    });
    expect(setup.record.failure?.code).toBe("env_file_incomplete");
    expect(setup.record.failure?.message).toContain("install-updater.sh");
  });

  it("空间不足（1.2 倍边界）时保持旧服务运行并失败退出", async () => {
    const boundaryFail = await setupRun({ docker: { availableKb: 1199 } });
    expect(boundaryFail.record.failure?.code).toBe("insufficient_space");
    expect(boundaryFail.record.outcome).toBe("failed_no_changes");
    expect(boundaryFail.docker.methods()).not.toContain("stopFeedback");

    const boundaryPass = await setupRun({ docker: { availableKb: 1200 } });
    expect(boundaryPass.record.status).toBe("succeeded");
  });

  it("更新前附件基线不可靠时拒绝拉取并保持旧服务不变", async () => {
    const invalidBaseline = JSON.parse(probeJson().slice("PROBE:".length)) as {
      attachments: { screenshots: Array<{ metadataValid: boolean }> };
    };
    invalidBaseline.attachments.screenshots[0]!.metadataValid = false;
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        docker.probeOutputs.push(`PROBE:${JSON.stringify(invalidBaseline)}`);
        return docker;
      },
    });

    expect(setup.record.outcome).toBe("failed_no_changes");
    expect(setup.record.failure?.code).toBe("baseline_probe_failed");
    expect(setup.docker.methods()).not.toContain("pullImage");
    expect(setup.docker.stopCount).toBe(0);
    expect(setup.docker.startCount).toBe(0);
  });
});

describe("停服与复制阶段失败（恢复旧版本）", () => {
  it("强制终止（exit 137）时中止升级，不把不一致数据当作完整备份", async () => {
    const setup = await setupRun({ docker: { stopExitCode: 137 } });
    expect(setup.record.status).toBe("failed");
    expect(setup.record.outcome).toBe("failed_restored");
    expect(setup.record.failure?.code).toBe("stop_abnormal_exit");
    expect(setup.record.restore?.confirmed).toBe(true);
    expect(setup.record.message).toContain("已恢复旧版本");
    expect(setup.docker.methods()).not.toContain("createVolume");
    expect((await setup.control.readPaused()).state).toBe("absent");
    // 恢复后的旧服务用的是登记过的旧镜像与旧卷
    const container = await setup.docker.inspectContainer("container-v1");
    expect(container.running).toBe(true);
    expect(container.imageRef).toBe("feedback-service:local");
    expect(container.mounts[0]?.name).toBe("feedback_feedback-data");
  });

  it("stop 后容器仍在运行时中止升级", async () => {
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        const originalStop = docker.stopFeedback.bind(docker);
        docker.stopFeedback = async (grace: number) => {
          await originalStop(grace);
          docker.running = true;
        };
        return docker;
      },
    });
    expect(setup.record.failure?.code).toBe("stop_failed");
    expect(setup.record.outcome).toBe("failed_restored");
    expect(setup.docker.methods()).not.toContain("createVolume");
  });

  it("复制失败时恢复旧版本，新卷保留但不自动删除", async () => {
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        docker.failures.set("copyVolume", new Error("no space left on device"));
        return docker;
      },
    });
    expect(setup.record.failure?.code).toBe("copy_failed");
    expect(setup.record.outcome).toBe("failed_restored");
    expect(setup.record.newVolume).not.toBeNull();
    expect(setup.docker.volumes.has(setup.record.newVolume as string)).toBe(true);
    expect(setup.docker.methods()).not.toContain("volumeRemove");
    const values = await envValues(setup.dirs.envFile);
    expect(values.get(ENV_IMAGE_KEY)).toBe("feedback-service:local");
    expect(values.get(ENV_DATA_VOLUME_KEY)).toBe("feedback_feedback-data");
  });

  it("复制结果缺少条目时恢复旧版本", async () => {
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        const original = docker.copyVolume.bind(docker);
        docker.copyVolume = async (from: string, to: string, helper: string) => {
          await original(from, to, helper);
          docker.volumes.set(to, (docker.volumes.get(to) ?? []).slice(0, 1));
        };
        return docker;
      },
    });
    expect(setup.record.failure?.code).toBe("copy_verify_failed");
    expect(setup.record.failure?.message).toContain("feedback.db-wal");
    expect(setup.record.outcome).toBe("failed_restored");
  });
});

describe("验证阶段失败（确认未放行后恢复旧版本）", () => {
  it("健康检查始终未就绪 → 限时超时 → 恢复旧版本并保留新卷", async () => {
    const setup = await setupRun({
      docker: { health: "starting" },
      engine: { verifyTimeoutMs: 2_000 },
    });
    expect(setup.record.status).toBe("failed");
    expect(setup.record.outcome).toBe("failed_restored");
    expect(setup.record.failure?.phase).toBe("verify_new");
    expect(setup.record.failure?.code).toBe("verify_timeout");
    expect(setup.record.restore?.confirmed).toBe(true);
    const values = await envValues(setup.dirs.envFile);
    expect(values.get(ENV_IMAGE_KEY)).toBe("feedback-service:local");
    expect(values.get(ENV_DATA_VOLUME_KEY)).toBe("feedback_feedback-data");
    expect(setup.docker.volumes.has(setup.record.newVolume as string)).toBe(true);
    expect(setup.docker.volumes.get("feedback_feedback-data")).toEqual(["feedback.db", "feedback.db-wal", "shots"]);
    // 恢复后又重建一次（旧配置），共两次 up
    expect(setup.docker.startCount).toBe(2);
    expect((await setup.control.readRelease()).state).toBe("absent");
  });

  it("新版数据不完整（计数下降）时判失败并恢复旧版本", async () => {
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        docker.probeByContainerId.set(
          "container-v1",
          probeJson({ counts: { users: 2, feedbacks: 1, feedback_screenshots: 3, daily_usage: 7 } }),
        );
        return docker;
      },
    });
    expect(setup.record.failure?.code).toBe("verify_timeout");
    expect(setup.record.outcome).toBe("failed_restored");
    expect(setup.record.evidence.some((entry) => (entry.detail ?? "").includes("数据丢失"))).toBe(true);
  });

  it("新版 digest 与请求不一致时判失败并恢复旧版本", async () => {
    const setup = await setupRun({
      dockerFactory: (_dirs, defaults) => {
        const docker = new FakeDocker(defaults);
        const original = docker.startFeedback.bind(docker);
        let ups = 0;
        docker.startFeedback = async () => {
          await original();
          ups += 1;
          if (ups > 1) return;
          const wrongRef = `feedback-service:local@sha256:${"b".repeat(64)}`;
          docker.registerImage(wrongRef);
          docker.imageRef = wrongRef;
          docker.imageId = imageIdFor(wrongRef);
        };
        return docker;
      },
    });
    expect(setup.record.failure?.code).toBe("verify_timeout");
    expect(setup.record.evidence.some((entry) => (entry.detail ?? "").includes("digest"))).toBe(true);
    expect(setup.record.outcome).toBe("failed_restored");
  });
});

describe("放行阶段失败（绝不自动回退）", () => {
  class LosingReleaseControl implements ControlPort {
    constructor(private readonly inner: ControlPort) {}
    readPaused(): Promise<MarkerState<PauseMarker>> {
      return this.inner.readPaused();
    }
    writePaused(marker: PauseMarker): Promise<void> {
      return this.inner.writePaused(marker);
    }
    clearPaused(): Promise<boolean> {
      return this.inner.clearPaused();
    }
    readRelease(): Promise<MarkerState<ReleaseMarker>> {
      return Promise.resolve({ state: "absent" });
    }
    writeRelease(marker: ReleaseMarker): Promise<void> {
      return this.inner.writeRelease(marker);
    }
    clearRelease(): Promise<boolean> {
      return this.inner.clearRelease();
    }
  }

  it("放行应答无法确认时标记需要处理，且不回退数据卷", async () => {
    const setup = await setupRun({
      engine: { releaseTimeoutMs: 2_000 },
      controlFactory: (_dirs, inner) => new LosingReleaseControl(inner),
    });
    expect(setup.record.status).toBe("needs_attention");
    expect(setup.record.outcome).toBe("needs_attention");
    expect(setup.record.failure?.phase).toBe("release");
    expect(setup.record.recoveryHint).toContain("docs/deployment.md");
    expect(setup.record.recoveryHint).toContain("未被删除");
    // 数据仍在新卷上，绝不自动回退
    const values = await envValues(setup.dirs.envFile);
    expect(values.get(ENV_DATA_VOLUME_KEY)).toBe(setup.record.newVolume);
    expect(setup.docker.volumes.has(setup.record.newVolume as string)).toBe(true);
    expect(setup.docker.volumes.get("feedback_feedback-data")).toEqual(["feedback.db", "feedback.db-wal", "shots"]);
    // 只重建过一次（新版），没有第二次回退重建
    expect(setup.docker.startCount).toBe(1);
    expect(setup.logLines.join("\n")).toContain("需要人工处理");
  });
});

describe("状态机落盘", () => {
  it("每个阶段边界先写任务文件，崩溃后可从磁盘看出阶段归属", async () => {
    const originalSaves: string[] = [];
    const dirs = await scaffold();
    roots.push(dirs.root);
    const docker = new FakeDocker({ envFile: dirs.envFile });
    const { log } = captureLogger([dirs.token]);
    const store = new FileTaskStore({ stateDir: dirs.stateDir, log });
    await store.init();
    const inner = new ControlFiles(dirs.config);
    const spy: FileTaskStore = store;
    const originalSave = spy.save.bind(spy);
    spy.save = async (record: TaskRecord) => {
      originalSaves.push(record.phase);
      await originalSave(record);
    };
    const engine = new UpdateEngine({
      config: dirs.config,
      docker,
      store: spy,
      control: inner,
      manifest: new FakeManifest(),
      log,
      clock: makeClock(),
      sleep: async () => {},
      pollIntervalMs: 1,
      httpProbe: async () => ({ ok: true, status: 200, error: null }),
    });
    const task = createTaskRecord({
      operationId: "op-phases",
      requestId: "req-phases",
      version: VERSION,
      digest: DIGEST_A,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    await store.create(task);
    const record = await engine.run(task);
    expect(record.status).toBe("succeeded");
    for (const phase of ["preflight_pull", "pause_stop", "backup_copy", "start_paused", "verify_new", "release"]) {
      expect(originalSaves).toContain(phase);
    }
    expect(originalSaves[0]).toBe("preflight_pull");
    expect(originalSaves[originalSaves.length - 1]).toBe("done");
  });
});
