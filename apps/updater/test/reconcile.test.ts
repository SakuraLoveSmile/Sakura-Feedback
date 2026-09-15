import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ReleaseMarker } from "../src/control.ts";
import { ControlFiles } from "../src/control.ts";
import { parseEnvFile } from "../src/envfile.ts";
import { reconcileOnStartup } from "../src/reconcile.ts";
import { createTaskRecord, FileTaskStore, type TaskRecord } from "../src/state.ts";
import {
  captureLogger,
  DIGEST_A,
  FakeDocker,
  type FakeDockerOptions,
  makeClock,
  type Scaffold,
  type ScaffoldOptions,
  scaffold,
  VERSION,
} from "./helpers/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const NEW_IMAGE_REF = `feedback-service:local@${DIGEST_A}`;
const NEW_VOLUME = "feedback-data-0.3.0-test";

interface SetupOptions {
  scaffold?: ScaffoldOptions;
  docker?: Partial<FakeDockerOptions>;
  task?: Partial<TaskRecord> | null;
  mutate?: (dirs: Scaffold) => Promise<void>;
  before?: (ctx: Setup) => Promise<void>;
}

interface Setup {
  dirs: Scaffold;
  docker: FakeDocker;
  store: FileTaskStore;
  control: ControlFiles;
  logLines: string[];
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const dirs = await scaffold(options.scaffold);
  roots.push(dirs.root);
  if (options.mutate) await options.mutate(dirs);
  const docker = new FakeDocker({
    envFile: dirs.envFile,
    imageRef: options.scaffold?.image ?? "feedback-service:local",
    dataVolume: options.scaffold?.dataVolume ?? "feedback_feedback-data",
    ...options.docker,
  });
  const { log, lines } = captureLogger([dirs.token]);
  const store = new FileTaskStore({ stateDir: dirs.stateDir, log });
  await store.init();
  const control = new ControlFiles(dirs.config);
  if (options.task !== null) {
    const record = createTaskRecord({
      operationId: "op-r1",
      requestId: "req-r1",
      version: VERSION,
      digest: DIGEST_A,
      now: new Date("2026-09-14T12:00:00.000Z"),
    });
    Object.assign(record, options.task ?? {});
    record.status = "running";
    await store.create(record);
  }
  const ctx: Setup = { dirs, docker, store, control, logLines: lines };
  if (options.before) await options.before(ctx);
  return ctx;
}

async function runReconcile(ctx: Setup) {
  const { log } = captureLogger([ctx.dirs.token]);
  return reconcileOnStartup({
    config: ctx.dirs.config,
    store: ctx.store,
    control: ctx.control,
    docker: ctx.docker,
    log,
    clock: makeClock(),
    sleep: async () => {},
    confirmTimeoutMs: 1_000,
    pollIntervalMs: 1,
  });
}

const interruptedTask: Partial<TaskRecord> = {
  phase: "backup_copy",
  previousImage: "feedback-service:local",
  previousVolume: "feedback_feedback-data",
  newImageRef: NEW_IMAGE_REF,
  newVolume: NEW_VOLUME,
};

describe("reconcileOnStartup", () => {
  it("中断在复制阶段、环境文件仍是旧值时：确认旧服务并解除暂停", async () => {
    const ctx = await setup({
      docker: { running: false },
      task: interruptedTask,
      before: async ({ control }) => {
        await control.writePaused({
          operationId: "op-r1",
          requestId: "req-r1",
          version: VERSION,
          digest: DIGEST_A,
          phase: "backup_copy",
          message: "更新进行中",
          startedAt: "2026-09-14T11:59:00.000Z",
          updatedAt: "2026-09-14T11:59:00.000Z",
        });
      },
    });
    const report = await runReconcile(ctx);
    expect(report.restored).toEqual(["op-r1"]);
    expect(report.needsAttention).toEqual([]);
    expect(ctx.docker.startCount).toBe(1);
    expect((await ctx.control.readPaused()).state).toBe("absent");
    const record = await ctx.store.get("op-r1");
    expect(record?.status).toBe("failed");
    expect(record?.outcome).toBe("failed_restored");
    expect(record?.message).toContain("重启核对");
  });

  it("旧服务本来就还在运行时不需要重建", async () => {
    const ctx = await setup({ docker: { running: true }, task: interruptedTask });
    const report = await runReconcile(ctx);
    expect(report.restored).toEqual(["op-r1"]);
    expect(ctx.docker.startCount).toBe(0);
  });

  it("放行标记与运行中的 digest 一致时判定更新已完成", async () => {
    const ctx = await setup({
      scaffold: { image: NEW_IMAGE_REF, dataVolume: NEW_VOLUME },
      docker: { running: true, imageRef: NEW_IMAGE_REF, dataVolume: NEW_VOLUME },
      task: {
        phase: "release",
        previousImage: "feedback-service:local",
        previousVolume: "feedback_feedback-data",
        newImageRef: NEW_IMAGE_REF,
        newVolume: NEW_VOLUME,
      },
      before: async ({ docker, control }) => {
        await docker.pullImage(NEW_IMAGE_REF);
        const marker: ReleaseMarker = {
          operationId: "op-r1",
          requestId: "req-r1",
          version: VERSION,
          digest: DIGEST_A,
          imageRef: NEW_IMAGE_REF,
          volume: NEW_VOLUME,
          releasedAt: "2026-09-14T12:01:00.000Z",
        };
        await control.writeRelease(marker);
      },
    });
    const report = await runReconcile(ctx);
    expect(report.succeeded).toEqual(["op-r1"]);
    expect((await ctx.store.get("op-r1"))?.status).toBe("succeeded");
  });

  it("环境文件已切到新镜像时记为需要处理，且不自动回退", async () => {
    const ctx = await setup({
      scaffold: { image: NEW_IMAGE_REF, dataVolume: NEW_VOLUME },
      docker: { running: true, imageRef: NEW_IMAGE_REF, dataVolume: NEW_VOLUME },
      task: {
        phase: "verify_new",
        previousImage: "feedback-service:local",
        previousVolume: "feedback_feedback-data",
        newImageRef: NEW_IMAGE_REF,
        newVolume: NEW_VOLUME,
      },
    });
    const report = await runReconcile(ctx);
    expect(report.needsAttention).toEqual(["op-r1"]);
    expect(ctx.docker.methods()).not.toContain("startFeedback");
    expect(ctx.docker.methods()).not.toContain("stopFeedback");
    const record = await ctx.store.get("op-r1");
    expect(record?.status).toBe("needs_attention");
    expect(record?.recoveryHint).toContain("docs/deployment.md");
  });

  it("环境文件不可读时记为需要处理", async () => {
    const ctx = await setup({
      task: interruptedTask,
      mutate: async (dirs) => {
        await fs.rm(dirs.envFile);
      },
    });
    const report = await runReconcile(ctx);
    expect(report.needsAttention).toEqual(["op-r1"]);
    expect((await ctx.store.get("op-r1"))?.recoveryHint).toContain("部署环境文件");
    expect(ctx.docker.methods()).not.toContain("startFeedback");
  });

  it("清理过期暂停标记：终态安全的才清理，需要处理的保持不动", async () => {
    const safe = await setup({
      task: null,
      before: async ({ store, control }) => {
        const done = createTaskRecord({
          operationId: "op-safe",
          requestId: "req-safe",
          version: VERSION,
          digest: DIGEST_A,
          now: new Date("2026-09-14T11:00:00.000Z"),
        });
        done.status = "failed";
        done.outcome = "failed_restored";
        done.finishedAt = done.createdAt;
        await store.create(done);
        await control.writePaused({
          operationId: "op-safe",
          requestId: "req-safe",
          version: VERSION,
          digest: DIGEST_A,
          phase: "verify_new",
          message: "更新进行中",
          startedAt: done.createdAt,
          updatedAt: done.createdAt,
        });
      },
    });
    const safeReport = await runReconcile(safe);
    expect(safeReport.stalePauseCleared).toBe(true);
    expect((await safe.control.readPaused()).state).toBe("absent");

    const unsafe = await setup({
      task: null,
      before: async ({ store, control }) => {
        const stuck = createTaskRecord({
          operationId: "op-stuck",
          requestId: "req-stuck",
          version: VERSION,
          digest: DIGEST_A,
          now: new Date("2026-09-14T11:00:00.000Z"),
        });
        stuck.status = "needs_attention";
        stuck.outcome = "needs_attention";
        stuck.finishedAt = stuck.createdAt;
        await store.create(stuck);
        await control.writePaused({
          operationId: "op-stuck",
          requestId: "req-stuck",
          version: VERSION,
          digest: DIGEST_A,
          phase: "release",
          message: "更新进行中",
          startedAt: stuck.createdAt,
          updatedAt: stuck.createdAt,
        });
      },
    });
    const unsafeReport = await runReconcile(unsafe);
    expect(unsafeReport.stalePauseCleared).toBe(false);
    expect((await unsafe.control.readPaused()).state).toBe("ok");
  });

  it("损坏的任务文件只报告不阻塞，并且不会盲目动作", async () => {
    const ctx = await setup({ task: null });
    await fs.writeFile(`${ctx.dirs.stateDir}/tasks/broken.json`, "{oops", { mode: 0o600 });
    const report = await runReconcile(ctx);
    expect(report.corrupt).toEqual(["broken.json"]);
    expect(ctx.docker.methods()).toEqual([]);
  });

  it("环境文件与任务记录不一致时记为需要处理", async () => {
    const ctx = await setup({
      docker: { running: false },
      task: interruptedTask,
      mutate: async (dirs) => {
        await fs.writeFile(dirs.envFile, "FEEDBACK_IMAGE=someone-else:1\nFEEDBACK_DATA_VOLUME=other\n", {
          mode: 0o600,
        });
        const values = parseEnvFile(await fs.readFile(dirs.envFile, "utf8"));
        expect(values.get("FEEDBACK_IMAGE")).toBe("someone-else:1");
      },
    });
    const report = await runReconcile(ctx);
    expect(report.needsAttention).toEqual(["op-r1"]);
  });
});
