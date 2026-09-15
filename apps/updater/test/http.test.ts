import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startUpdaterServer, type UpdaterServer } from "../src/http.ts";
import type { ManifestOutcome } from "../src/manifest.ts";
import { createTaskRecord, FileTaskStore, type TaskRecord } from "../src/state.ts";
import { loadTokenSet } from "../src/token.ts";
import { captureLogger, DIGEST_A, FakeManifest, makeManifest, scaffold, VERSION } from "./helpers/fakes.ts";

const roots: string[] = [];
const servers: UpdaterServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class StubEngine {
  runs: TaskRecord[] = [];
  busy = false;
  async run(task: TaskRecord): Promise<TaskRecord> {
    this.runs.push(task);
    return task;
  }
  isBusy(): boolean {
    return this.busy;
  }
}

let portSeed = 20_000;

interface Started {
  port: number;
  token: string;
  dirs: Awaited<ReturnType<typeof scaffold>>;
  store: FileTaskStore;
  engine: StubEngine;
  manifest: FakeManifest;
  scheduled: Array<() => void>;
  logLines: string[];
}

async function startServer(
  options: { manifest?: ManifestOutcome; seed?: (store: FileTaskStore) => Promise<void> } = {},
): Promise<Started> {
  portSeed += 1 + Math.floor(Math.random() * 500);
  const dirs = await scaffold({ listen: `127.0.0.1:${portSeed}` });
  roots.push(dirs.root);
  const { log, lines } = captureLogger([dirs.token]);
  const store = new FileTaskStore({ stateDir: dirs.stateDir, log });
  await store.init();
  if (options.seed) await options.seed(store);
  const manifest = new FakeManifest(options.manifest);
  const tokens = await loadTokenSet(dirs.config, log);
  const engine = new StubEngine();
  const scheduled: Array<() => void> = [];
  const started = await startUpdaterServer({
    config: dirs.config,
    tokens,
    store,
    manifest,
    engine,
    log,
    schedule: (task) => scheduled.push(task),
  });
  servers.push(started);
  return { port: dirs.config.listenPort, token: dirs.token, dirs, store, engine, manifest, scheduled, logLines: lines };
}

interface Response {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

async function call(
  started: Started,
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? started.token : options.token;
  if (token !== null) headers["x-updater-token"] = token;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`http://127.0.0.1:${started.port}${path}`, { method, headers, body });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, text, json };
}

function taskBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: "req-1", version: VERSION, digest: DIGEST_A, ...overrides };
}

describe("updater HTTP 协议", () => {
  it("/healthz 无需令牌并暴露 updater 版本与协议版本", async () => {
    const started = await startServer();
    const response = await call(started, "GET", "/healthz", { token: null });
    expect(response.status).toBe(200);
    expect(response.json.version).toBe("0.1.0");
    expect(response.json.protocolVersion).toBe(1);
  });

  it("缺失或错误令牌一律 401，且响应与日志都不含令牌", async () => {
    const started = await startServer();
    const missing = await call(started, "POST", "/tasks", { token: null, body: taskBody() });
    expect(missing.status).toBe(401);
    const wrong = await call(started, "GET", "/manifest?channel=stable", { token: "not-the-token-123456" });
    expect(wrong.status).toBe(401);
    expect(wrong.text).not.toContain(started.token);
    expect(started.logLines.join("\n")).not.toContain(started.token);
    expect((await started.store.list()).length).toBe(0);
  });

  it("客户端提交 compose 路径、命令、镜像或卷名一律 400 invalid_request", async () => {
    const started = await startServer();
    for (const key of ["composeFile", "command", "image", "volumes", "service", "project"]) {
      const response = await call(started, "POST", "/tasks", { body: taskBody({ [key]: "whatever" }) });
      expect(response.status).toBe(400);
      expect(response.json.error).toBe("invalid_request");
      expect(response.json.field).toBe(key);
    }
    expect((await started.store.list()).length).toBe(0);
  });

  it("requestId/version/digest 非法时 400", async () => {
    const started = await startServer();
    expect((await call(started, "POST", "/tasks", { body: taskBody({ requestId: "" }) })).status).toBe(400);
    expect((await call(started, "POST", "/tasks", { body: taskBody({ version: "0.3" }) })).status).toBe(400);
    expect((await call(started, "POST", "/tasks", { body: taskBody({ digest: "sha256:short" }) })).status).toBe(400);
    expect((await call(started, "POST", "/tasks", { rawBody: "{oops" })).json.error).toBe("invalid_request");
    expect((await call(started, "POST", "/tasks", { rawBody: "[]" })).status).toBe(400);
  });

  it("受理任务时先落盘再返回 202，之后才在后台启动执行", async () => {
    const started = await startServer();
    const response = await call(started, "POST", "/tasks", { body: taskBody() });
    expect(response.status).toBe(202);
    expect(response.json.status).toBe("running");
    const operationId = String(response.json.operationId);
    // 响应返回时任务已在磁盘上，且执行尚未开始
    const persisted = await started.store.get(operationId);
    expect(persisted?.requestId).toBe("req-1");
    expect(persisted?.digest).toBe(DIGEST_A);
    expect(started.engine.runs.length).toBe(0);
    expect(started.scheduled.length).toBe(1);
    started.scheduled[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.engine.runs.length).toBe(1);
    expect(started.engine.runs[0]?.operationId).toBe(operationId);
  });

  it("同一 requestId 重发返回原任务；已有任务运行中收到其它 requestId 返回 409", async () => {
    const started = await startServer();
    const first = await call(started, "POST", "/tasks", { body: taskBody() });
    const replay = await call(started, "POST", "/tasks", { body: taskBody() });
    expect(replay.status).toBe(202);
    expect(replay.json.operationId).toBe(first.json.operationId);
    expect(replay.json.deduplicated).toBe(true);
    expect((await started.store.list()).length).toBe(1);

    const conflict = await call(started, "POST", "/tasks", { body: taskBody({ requestId: "req-2" }) });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe("conflict");
    expect(conflict.json.operationId).toBe(first.json.operationId);
    expect((await started.store.list()).length).toBe(1);
  });

  it("清单缺失或协议不兼容时 409 并给出执行器升级指引", async () => {
    const missing = await startServer({ manifest: { kind: "missing" } });
    const missingResponse = await call(missing, "POST", "/tasks", { body: taskBody() });
    expect(missingResponse.status).toBe(409);
    expect(missingResponse.json.error).toBe("manifest_missing");
    expect((await missing.store.list()).length).toBe(0);

    const incompatible = await startServer({
      manifest: {
        kind: "ok",
        manifest: makeManifest({ requiredUpdaterProtocol: 3 }),
        source: "local",
        location: "/deploy/release-manifest.json",
      },
    });
    const incompatibleResponse = await call(incompatible, "POST", "/tasks", { body: taskBody() });
    expect(incompatibleResponse.status).toBe(409);
    expect(incompatibleResponse.json.error).toBe("updater_protocol_incompatible");
    expect(incompatibleResponse.json.message).toContain("更新执行器协议 v3");
    expect(incompatibleResponse.json.message).toContain("不会重建自己");
  });

  it("GET /tasks/:id 返回任务，未知任务 404，非法 id 400", async () => {
    const started = await startServer();
    const created = await call(started, "POST", "/tasks", { body: taskBody() });
    const operationId = String(created.json.operationId);
    const found = await call(started, "GET", `/tasks/${operationId}`);
    expect(found.status).toBe(200);
    expect(found.json.operationId).toBe(operationId);
    expect((await call(started, "GET", "/tasks/op-does-not-exist")).status).toBe(404);
    expect((await call(started, "GET", "/tasks/bad id")).status).toBe(400);
    expect((await call(started, "PUT", `/tasks/${operationId}`)).status).toBe(405);
  });

  it("GET /manifest 读取清单，渠道不支持 400，清单缺失 502", async () => {
    const started = await startServer();
    const manifest = await call(started, "GET", "/manifest?channel=stable");
    expect(manifest.status).toBe(200);
    expect(manifest.json.version).toBe(VERSION);
    expect((manifest.json.services as { feedback: { digest: string } }).feedback.digest).toBe(DIGEST_A);
    expect((await call(started, "GET", "/manifest?channel=beta")).status).toBe(400);
    expect((await call(started, "GET", "/manifest")).status).toBe(200);

    const missing = await startServer({ manifest: { kind: "missing" } });
    const unavailable = await call(missing, "GET", "/manifest?channel=stable");
    expect(unavailable.status).toBe(502);
    expect(unavailable.json.error).toBe("manifest_missing");
  });

  it("未知路径 404、错误方法 405", async () => {
    const started = await startServer();
    expect((await call(started, "GET", "/nope")).status).toBe(404);
    expect((await call(started, "GET", "/tasks")).status).toBe(405);
    expect((await call(started, "POST", "/manifest?channel=stable", { body: {} })).status).toBe(405);
  });

  it("非运行中的历史任务不会阻塞新任务", async () => {
    const started = await startServer({
      seed: async (store) => {
        const done = createTaskRecord({
          operationId: "op-done",
          requestId: "req-done",
          version: VERSION,
          digest: DIGEST_A,
          now: new Date("2026-09-13T00:00:00.000Z"),
        });
        done.status = "failed";
        done.outcome = "failed_restored";
        done.finishedAt = done.createdAt;
        await store.create(done);
      },
    });
    const response = await call(started, "POST", "/tasks", { body: taskBody({ requestId: "req-new" }) });
    expect(response.status).toBe(202);
  });
});
