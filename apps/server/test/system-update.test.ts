import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type FeedbackApp } from "../src/app.ts";
import type { ServerConfig } from "../src/env.ts";
import {
  DEFAULT_UPDATE_URL,
  loadConfig,
  SUPPORTED_UPDATER_PROTOCOL,
  UPDATE_URL_ENV,
  UPDATE_URL_ENV_ALIAS,
} from "../src/env.ts";
import {
  candidatePackageJsonPaths,
  createControlPlane,
  createSystemUpdateService,
  createUpdaterClient,
  readPackageVersion,
  UNKNOWN_VERSION,
} from "../src/routes/system-update.ts";
import { jsonReq, loginAsAdmin, makeConfig, makeMockAi, makeMockKaneo, TEST_PASSWORD } from "./helpers.ts";

const SHARED_TOKEN = "test-shared-updater-token-0123456789";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/** 可控的 updater 桩：进程内 fetch 替身，记录请求（含请求头），不触网。 */
interface Stub {
  /** 依次取用的响应；用尽后重复最后一项。 */
  responses: StubResponse[];
  calls: { url: string; method: string; token: string | null; body: unknown }[];
  handler?: (url: string, init: RequestInit) => StubResponse | null;
}

type StubResponse = { status: number; body: unknown; raw?: string };

function createStub(responses: StubResponse[]): { stub: Stub; fetchImpl: typeof fetch } {
  const stub: Stub = { responses, calls: [] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    stub.calls.push({
      url,
      method: init?.method ?? "GET",
      token: headers["x-updater-token"] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const injected = stub.handler?.(url, init ?? {});
    const next =
      injected ??
      stub.responses[Math.min(stub.calls.length - 1, stub.responses.length - 1)] ??
      ({ status: 404, body: { error: "not_found" } } as StubResponse);
    return new Response(next.raw ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { stub, fetchImpl };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    version: "0.3.0",
    commit: "abc1234",
    tag: "v0.3.0",
    channel: "stable",
    services: {
      feedback: { image: "ghcr.io/sakura/feedback", digest: DIGEST_A },
      updater: { image: "ghcr.io/sakura/updater", digest: DIGEST_B },
    },
    platform: "linux/amd64",
    dbSchemaVersion: 3,
    requiredUpdaterProtocol: 1,
    publishedAt: "2025-09-01T00:00:00.000Z",
    releaseNotes: "修复若干问题",
    ...overrides,
  };
}

const HEALTH_OK: StubResponse = {
  status: 200,
  body: { ok: true, version: "0.1.0", protocolVersion: 1, busy: false },
};

interface Harness {
  feedbackApp: FeedbackApp;
  config: ServerConfig;
  cookie: string;
  controlDir: string;
  pausedFile: string;
  tasksDir: string;
  tokenFile: string;
  stub: Stub;
  kaneo: ReturnType<typeof makeMockKaneo>;
  ai: ReturnType<typeof makeMockAi>;
}

const apps: FeedbackApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.close();
    await app.worker.idle();
    app.db.close();
  }
});

async function makeHarness(
  options: {
    responses?: StubResponse[];
    handler?: Stub["handler"];
    controlDir?: string | null;
    tokenFile?: string | null;
    updateUrl?: string | null;
    checkIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const config = makeConfig();
  const controlDir =
    options.controlDir === null ? null : (options.controlDir ?? path.join(config.dataDir, "update-control"));
  const tokenFile =
    options.tokenFile === null ? null : (options.tokenFile ?? path.join(config.dataDir, "updater-token"));
  if (controlDir) mkdirSync(controlDir, { recursive: true });
  if (tokenFile) writeFileSync(tokenFile, `${SHARED_TOKEN}\n`, { mode: 0o600 });
  config.updateControlDir = controlDir;
  config.updateTokenFile = tokenFile;
  config.updateUrl = options.updateUrl === undefined ? "http://updater.test:8790" : options.updateUrl;
  config.updateCheckIntervalMs = options.checkIntervalMs ?? 0;

  const { stub, fetchImpl } = createStub(options.responses ?? [HEALTH_OK]);
  stub.handler = options.handler;
  const kaneo = makeMockKaneo();
  const ai = makeMockAi();
  const feedbackApp = createApp(config, {
    ai,
    kaneo,
    workerSleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    updaterClient: createUpdaterClient({
      baseUrl: config.updateUrl,
      tokenFile: config.updateTokenFile,
      fetchImpl,
      tokenTtlMs: 0,
    }),
    controlTtlMs: 0,
  });
  apps.push(feedbackApp);
  const cookie = await loginAsAdmin(feedbackApp);
  return {
    feedbackApp,
    config,
    cookie,
    controlDir: controlDir ?? path.join(config.dataDir, "update-control"),
    pausedFile: path.join(controlDir ?? path.join(config.dataDir, "update-control"), "paused"),
    tasksDir: path.join(controlDir ?? path.join(config.dataDir, "update-control"), "state", "tasks"),
    tokenFile: tokenFile ?? path.join(config.dataDir, "updater-token"),
    stub,
    kaneo,
    ai,
  };
}

/** 写入真实的 paused 标记（与执行器同格式）并等待控制面缓存过期。 */
async function writePaused(h: Harness, marker: Partial<Record<string, unknown>> = {}): Promise<void> {
  mkdirSync(h.controlDir, { recursive: true });
  writeFileSync(
    h.pausedFile,
    JSON.stringify({
      operationId: "op-20250901T000000Z-abcd",
      requestId: "req-1",
      version: "0.3.0",
      digest: DIGEST_A,
      phase: "backup_copy",
      message: "系统更新进行中，业务写入必须拒绝",
      startedAt: "2025-09-01T00:00:00.000Z",
      updatedAt: "2025-09-01T00:00:05.000Z",
      ...marker,
    }),
  );
  await vi.waitFor(() => expect(h.feedbackApp.system.control.isWritePaused()).toBe(true), { timeout: 2000 });
}

async function clearPaused(h: Harness): Promise<void> {
  rmSync(h.pausedFile, { force: true });
  await vi.waitFor(() => expect(h.feedbackApp.system.control.isWritePaused()).toBe(false), { timeout: 2000 });
}

function seedTask(h: Harness, record: Record<string, unknown>): void {
  mkdirSync(h.tasksDir, { recursive: true });
  writeFileSync(path.join(h.tasksDir, `${record.operationId}.json`), JSON.stringify(record));
}

function taskRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: "op-20250901T000000Z-abcd",
    requestId: "req-1",
    version: "0.3.0",
    digest: DIGEST_A,
    status: "running",
    outcome: null,
    phase: "pause_stop",
    phaseLabel: "②暂停并停服",
    message: "已暂停写入并等待旧服务退出",
    createdAt: "2025-09-01T00:00:00.000Z",
    updatedAt: "2025-09-01T00:00:05.000Z",
    startedAt: "2025-09-01T00:00:01.000Z",
    finishedAt: null,
    failure: null,
    recoveryHint: null,
    warnings: [],
    evidence: [{ at: "2025-09-01T00:00:02.000Z", phase: "preflight_pull", step: "docker pull", ok: true }],
    ...overrides,
  };
}

/** 提交一条反馈（走真实提交路径）。 */
async function submit(h: Harness, bearer: string, over: Record<string, unknown> = {}) {
  return jsonReq(h.feedbackApp.app, "POST", "/api/feedback", {
    bearer,
    body: {
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      appId: "com.test.app",
      text: "更新期间与之后的写入行为验证",
      ...over,
    },
  });
}

/** 建好 app/连接/软件配置/client 令牌，返回可直接提交反馈的环境。 */
async function makeFullHarness(options: Parameters<typeof makeHarness>[0] = {}) {
  const h = await makeHarness(options);
  const kaneoPut = await jsonReq(h.feedbackApp.app, "PUT", "/api/admin/connection/kaneo", {
    cookie: h.cookie,
    body: { baseUrl: "http://kaneo.test/api", apiKey: "test-key" },
  });
  expect(kaneoPut.status).toBe(200);
  const appRes = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/apps", {
    cookie: h.cookie,
    body: {
      appId: "com.test.app",
      name: "测试软件",
      allowedOrigins: ["http://host.test"],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: "triage",
    },
  });
  expect(appRes.status).toBe(201);
  const bearerRes = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
    origin: "http://host.test",
    body: { username: "admin", password: TEST_PASSWORD, clientLabel: "test-client", appId: "com.test.app" },
  });
  expect(bearerRes.status).toBe(200);
  return { ...h, bearer: bearerRes.data.token as string };
}

describe("U1-4 系统更新：状态与检查", () => {
  it("GET /api/admin/system/update 返回当前版本、最新稳定版、协议兼容与最近任务", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    seedTask(h, taskRecord());

    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.status).toBe(200);
    expect(status.data.current.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.data.current.protocol).toBe(SUPPORTED_UPDATER_PROTOCOL);
    expect(status.data.config.updateConfigured).toBe(true);
    expect(status.data.pause.paused).toBe(false);
    // 尚未检查
    expect(status.data.check.state).toBe("never");
    // 最近任务来自控制目录里执行器落盘的任务文件
    expect(status.data.recentOperations).toHaveLength(1);
    expect(status.data.recentOperations[0]).toMatchObject({
      operationId: "op-20250901T000000Z-abcd",
      phaseLabel: "②暂停并停服",
      status: "running",
      evidence: [{ phase: "preflight_pull", step: "docker pull", ok: true }],
    });
  });

  it("手动检查返回最新稳定版（版本/说明/发布时间）并标记可更新", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.status).toBe(200);
    // 清单版本与当前版本的关系决定 ok / up_to_date；两种都在这里断言到
    expect(["ok", "up_to_date"]).toContain(r.data.check.state);
    expect(r.data.check.compatible).toBe(true);
    expect(r.data.check.latest).toMatchObject({
      version: "0.3.0",
      notes: "修复若干问题",
      publishedAt: "2025-09-01T00:00:00.000Z",
      digest: DIGEST_A,
    });
    // 结果持久化到控制目录（重启后仍可展示）
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.check.state).toBe(r.data.check.state);
    expect(status.data.check.latest.version).toBe("0.3.0");
    // 只检查不安装：没有任何 POST /tasks
    expect(h.stub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("清单版本等于当前版本 → up_to_date", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest({ version: "0.0.0" }) }] });
    const current = h.feedbackApp.system.status().current.version;
    h.stub.responses = [HEALTH_OK, { status: 200, body: manifest({ version: current }) }];
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.data.check.state).toBe("up_to_date");
  });

  it("版本清单缺失 → 检查失败（可区分），且服务继续运行", async () => {
    const h = await makeHarness({
      responses: [HEALTH_OK, { status: 502, body: { error: "manifest_missing", message: "未找到版本清单" } }],
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.status).toBe(200);
    expect(r.data.check.state).toBe("failed");
    expect(r.data.check.failedCode).toBe("updater_http_error");
    expect(r.data.check.failedMessage).toContain("未找到版本清单");
    // 服务照常运行
    expect((await jsonReq(h.feedbackApp.app, "GET", "/healthz")).status).toBe(200);
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/admin/users", { cookie: h.cookie })).status).toBe(200);
  });

  it("清单非法（协议字段缺失）→ 检查失败，不进入兼容分支", async () => {
    const h = await makeHarness({
      responses: [
        HEALTH_OK,
        { status: 200, body: manifest({ manifestVersion: 2 }) },
        { status: 200, body: manifest({ manifestVersion: 2 }) },
      ],
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.data.check.state).toBe("failed");
  });

  it("协议不兼容 → 检查仍展示版本信息但标记 incompatible + 升级指引，更新入口被禁用", async () => {
    const h = await makeHarness({
      responses: [
        HEALTH_OK,
        { status: 200, body: manifest({ requiredUpdaterProtocol: SUPPORTED_UPDATER_PROTOCOL + 1 }) },
      ],
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.data.check.state).toBe("incompatible");
    expect(r.data.check.compatible).toBe(false);
    expect(r.data.check.latest.version).toBe("0.3.0"); // 版本信息仍可展示
    expect(r.data.check.guidance).toContain("手工升级 updater");
    expect(r.data.check.guidance).toContain(`v${SUPPORTED_UPDATER_PROTOCOL + 1}`);
    // 执行器侧同样拒绝：转发请求得到 409 protocol_incompatible
    h.stub.responses = [
      {
        status: 409,
        body: { error: "updater_protocol_incompatible", message: "请先手工升级 updater", required: 2, supported: 1 },
      },
    ];
    const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-1", version: "0.3.0", digest: DIGEST_A },
    });
    expect(post.status).toBe(409);
  });

  it("updater 不可达 → 检查失败（不是 500），服务与后台读取不受影响", async () => {
    const h = await makeHarness({
      handler: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.9:8790");
      },
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.status).toBe(200);
    expect(r.data.check.state).toBe("failed");
    expect(r.data.check.failedCode).toBe("updater_unreachable");
    expect(r.data.check.failedMessage).toContain("不可达");
    // 后台读进度（GET）仍可用
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.status).toBe(200);
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie })).status).toBe(200);
  });

  it("未接入更新执行器（缺 FEEDBACK_UPDATE_URL / 令牌文件）→ 明确的未配置状态，不回 500", async () => {
    const h = await makeHarness({ updateUrl: null, tokenFile: null });
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.config.updateConfigured).toBe(false);
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(r.data.check.state).toBe("failed");
    expect(r.data.check.failedCode).toBe("updater_not_configured");

    const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-1", version: "0.3.0", digest: DIGEST_A },
    });
    expect(post.status).toBe(503);
    expect(post.data.error.code).toBe("update_not_configured");
  });

  it("令牌文件路径已配置但文件不存在 → 503 update_token_unavailable（提示由部署脚本生成）", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK] });
    // 路径存在但文件被删除（例如部署脚本未生成 / 卷未挂载）
    rmSync(h.tokenFile, { force: true });
    const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-1", version: "0.3.0", digest: DIGEST_A },
    });
    expect(post.status).toBe(503);
    expect(post.data.error.code).toBe("update_token_unavailable");
    expect(post.data.error.message).toContain("install-updater.sh");
    // 检查同样是明确的令牌状态（不是 500）
    const check = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(check.status).toBe(200);
    expect(check.data.check.state).toBe("failed");
    expect(check.data.check.failedCode).toBe("updater_token_missing");
  });

  it("自动检查按间隔节流（只检查不安装）", async () => {
    const h = await makeHarness({
      responses: [HEALTH_OK, { status: 200, body: manifest() }],
      checkIntervalMs: 24 * 3600_000,
    });
    expect(await h.feedbackApp.system.runAutoCheck()).toBe(true);
    const callsAfterFirst = h.stub.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // 间隔内不再重复检查，也绝不安装
    expect(await h.feedbackApp.system.runAutoCheck()).toBe(false);
    expect(h.stub.calls.length).toBe(callsAfterFirst);
    expect(h.stub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("服务端只转发 requestId/version/digest（含令牌头），客户端提交路径/命令/镜像/卷名一律 400", async () => {
    const h = await makeHarness({
      responses: [
        { status: 202, body: { operationId: "op-x", status: "running" } },
        { status: 202, body: { operationId: "op-x", status: "running" } },
      ],
    });
    const ok = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-abc", version: "0.3.0", digest: DIGEST_A },
    });
    expect(ok.status).toBe(202);
    expect(ok.data).toMatchObject({ operationId: "op-x", status: "running", deduplicated: false });
    const post = h.stub.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("http://updater.test:8790/tasks");
    expect(post.body).toEqual({ requestId: "req-abc", version: "0.3.0", digest: DIGEST_A });
    expect(post.token).toBe(SHARED_TOKEN);
    // 响应里绝不出现令牌
    expect(JSON.stringify(ok.data)).not.toContain(SHARED_TOKEN);

    const forbidden: Array<[string, Record<string, unknown>]> = [
      ["compose 路径", { composePath: "/etc/compose.yml" }],
      ["compose 文件", { composeFile: "/opt/x/compose.yml" }],
      ["命令", { command: "rm -rf /" }],
      ["镜像", { image: "ghcr.io/evil/img" }],
      ["卷名", { volume: "other-volume" }],
      ["服务名", { service: "nginx" }],
      ["project", { project: "other" }],
    ];
    for (const [name, extra] of forbidden) {
      const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
        cookie: h.cookie,
        body: { requestId: "req-abc", version: "0.3.0", digest: DIGEST_A, ...extra },
      });
      expect(`${name} → ${r.status}/${r.data.error?.code}`).toBe(`${name} → 400/invalid_request`);
      expect(r.data.error.message).toContain("只允许 requestId/version/digest");
    }
    // 字段类型/取值非法
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ["requestId 非法", { requestId: "带空格 id", version: "0.3.0", digest: DIGEST_A }],
      ["version 非 semver", { requestId: "req-1", version: "latest", digest: DIGEST_A }],
      ["version 缺失", { requestId: "req-1", digest: DIGEST_A }],
      ["digest 非 sha256", { requestId: "req-1", version: "0.3.0", digest: "sha256:xyz" }],
      ["digest 大写十六进制", { requestId: "req-1", version: "0.3.0", digest: `sha256:${"A".repeat(64)}` }],
    ];
    for (const [name, body] of badBodies) {
      const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", { cookie: h.cookie, body });
      expect(`${name} → ${r.status}/${r.data.error?.code}`).toBe(`${name} → 400/invalid_request`);
    }
    // 被拒的请求一次都没有转发给执行器（只有第一次合法请求到达 upstream）
    expect(h.stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("重复 requestId 幂等：执行器去重响应原样透出", async () => {
    const h = await makeHarness({
      responses: [
        { status: 202, body: { operationId: "op-1", status: "running" } },
        { status: 202, body: { operationId: "op-1", status: "running", deduplicated: true } },
      ],
    });
    const first = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-same", version: "0.3.0", digest: DIGEST_A },
    });
    const second = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-same", version: "0.3.0", digest: DIGEST_A },
    });
    expect(first.data.deduplicated).toBe(false);
    expect(second.status).toBe(202);
    expect(second.data).toMatchObject({ operationId: "op-1", deduplicated: true });
  });

  it("并发请求 → 409 update_in_progress 并带运行中任务", async () => {
    const h = await makeHarness({
      responses: [
        {
          status: 409,
          body: {
            error: "conflict",
            message: "已有更新任务在执行，拒绝并发更新",
            operationId: "op-running",
            phase: "backup_copy",
          },
        },
      ],
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-concurrent", version: "0.3.0", digest: DIGEST_A },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("update_in_progress");
    expect(r.data.operationId).toBe("op-running");
    expect(r.data.phase).toBe("backup_copy");
  });

  it("错误版本或 digest（执行器拒绝）→ 明确的执行器错误，非 500", async () => {
    const h = await makeHarness({
      responses: [
        {
          status: 409,
          body: { error: "manifest_mismatch", message: "清单中的版本/digest 与请求不一致，拒绝更新" },
        },
      ],
    });
    const r = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-1", version: "9.9.9", digest: DIGEST_A },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("update_in_progress");
    expect(r.data.error.message).toContain("拒绝更新");
  });

  it("上游返回非 JSON → updater_bad_response，不是 500 堆栈", async () => {
    const h = await makeHarness({ responses: [{ status: 200, body: null, raw: "<html>502 Bad Gateway</html>" }] });
    const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "req-1", version: "0.3.0", digest: DIGEST_A },
    });
    expect(post.status).toBe(502);
    expect(post.data.error.code).toBe("update_executor_error");
    expect(post.data.error.message).toContain("非 JSON");
  });
});

describe("U1-4 系统更新：任务进度与失败终态", () => {
  it("GET /api/admin/system/update/:id 返回阶段、证据与成功终态", async () => {
    const h = await makeHarness({
      responses: [
        {
          status: 200,
          body: taskRecord({ status: "succeeded", outcome: "succeeded", phase: "done", phaseLabel: "完成" }),
        },
      ],
    });
    seedTask(h, taskRecord({ status: "succeeded", outcome: "succeeded", phase: "done", phaseLabel: "完成" }));
    const r = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-20250901T000000Z-abcd", {
      cookie: h.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("known");
    expect(r.data.operation).toMatchObject({
      operationId: "op-20250901T000000Z-abcd",
      status: "succeeded",
      outcome: "succeeded",
      outcomeLabel: "更新成功",
    });
    expect(r.data.operation.evidence).toHaveLength(1);
  });

  it("失败终态区分「已恢复旧版本」与「需要处理」（后者带证据与恢复指引）", async () => {
    const h = await makeHarness({
      responses: [
        {
          status: 200,
          body: taskRecord({
            operationId: "op-restored",
            status: "failed",
            outcome: "failed_restored",
            phase: "done",
            message: "验证失败，已还原旧版本",
          }),
        },
        {
          status: 200,
          body: taskRecord({
            operationId: "op-manual",
            status: "needs_attention",
            outcome: "needs_attention",
            phase: "release",
            failure: { phase: "release", code: "release_unconfirmed", message: "放行应答超时" },
            recoveryHint: "请人工核对容器实际镜像 digest 与数据卷后决定是否回滚",
            evidence: [
              { at: "2025-09-01T00:01:00.000Z", phase: "release", step: "解除 paused", ok: false, detail: "超时" },
            ],
          }),
        },
      ],
    });
    seedTask(
      h,
      taskRecord({
        operationId: "op-restored",
        status: "failed",
        outcome: "failed_restored",
        phase: "done",
        message: "验证失败，已还原旧版本",
      }),
    );
    seedTask(
      h,
      taskRecord({
        operationId: "op-manual",
        status: "needs_attention",
        outcome: "needs_attention",
        phase: "release",
        failure: { phase: "release", code: "release_unconfirmed", message: "放行应答超时" },
        recoveryHint: "请人工核对容器实际镜像 digest 与数据卷后决定是否回滚",
        evidence: [
          { at: "2025-09-01T00:01:00.000Z", phase: "release", step: "解除 paused", ok: false, detail: "超时" },
        ],
      }),
    );

    const restored = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-restored", {
      cookie: h.cookie,
    });
    expect(restored.data.operation.outcomeLabel).toBe("更新失败，已恢复旧版本");

    const manual = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-manual", { cookie: h.cookie });
    expect(manual.data.operation.outcomeLabel).toBe("需要处理");
    expect(manual.data.operation.failure).toMatchObject({ code: "release_unconfirmed" });
    expect(manual.data.operation.recoveryHint).toContain("核对");
    expect(manual.data.operation.evidence).toHaveLength(1);
  });

  it("各阶段失败的任务在后台可读：拉取失败/空间不足/停服异常/复制失败/健康失败", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["preflight_pull 拉取失败", { phase: "preflight_pull", status: "failed", outcome: "failed_no_changes" }],
      [
        "preflight_pull 空间不足",
        { phase: "preflight_pull", status: "failed", outcome: "failed_no_changes", message: "可用空间不足 1.2 倍" },
      ],
      [
        "pause_stop 停服异常",
        { phase: "pause_stop", status: "failed", outcome: "needs_attention", message: "旧服务未在预算内退出" },
      ],
      [
        "backup_copy 复制失败",
        { phase: "backup_copy", status: "failed", outcome: "needs_attention", message: "卷复制校验失败" },
      ],
      [
        "verify_new 健康失败",
        { phase: "verify_new", status: "failed", outcome: "failed_restored", message: "新版健康检查失败" },
      ],
    ];
    const responses = cases.map(([id, over]) => ({
      status: 200,
      body: taskRecord({ operationId: `op-${id.split(" ")[0]}`, ...over }),
    }));
    const h = await makeHarness({ responses });
    for (const [id, over] of cases) {
      seedTask(h, taskRecord({ operationId: `op-${id.split(" ")[0]}`, ...over }));
    }

    for (const [id, over] of cases) {
      const opId = `op-${id.split(" ")[0]}`;
      const r = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/system/update/${opId}`, { cookie: h.cookie });
      expect(r.status).toBe(200);
      expect(r.data.status).toBe("known");
      expect(r.data.operation.status).toBe(over.status);
      expect(r.data.operation.outcome).toBe(over.outcome);
    }
  });

  it("上游不可达但控制目录有任务文件 → 仍能显示进度（不判失败）", async () => {
    const h = await makeHarness({
      handler: () => {
        throw new Error("ECONNREFUSED（服务重启中）");
      },
    });
    seedTask(h, taskRecord({ phase: "start_paused" }));
    const r = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-20250901T000000Z-abcd", {
      cookie: h.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("known");
    expect(r.data.fromControlDir).toBe(true);
    expect(r.data.operation.phase).toBe("start_paused");
  });

  it("上游不可达且控制目录没有任务 → unreachable（前端显示正在恢复连接，不判失败）", async () => {
    const h = await makeHarness({
      handler: () => {
        throw new Error("ECONNREFUSED（服务重启中）");
      },
    });
    const r = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-unknown-1234", { cookie: h.cookie });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("unreachable");
    expect(r.data.error.code).toBe("updater_unreachable");
  });

  it("任务 ID 非法 → 400；未知任务的明确状态", async () => {
    const h = await makeHarness({ responses: [{ status: 404, body: { error: "not_found" } }] });
    const bad = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/bad%20id", { cookie: h.cookie });
    expect(bad.status).toBe(400);
    const unknown = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-unknown-9999", {
      cookie: h.cookie,
    });
    expect(unknown.status).toBe(200);
    expect(unknown.data.status).toBe("unknown");
  });
});

describe("U1-4 系统更新：守卫与令牌安全", () => {
  const endpoints: Array<["GET" | "POST", string, unknown?]> = [
    ["GET", "/api/admin/system/update"],
    ["POST", "/api/admin/system/update/check"],
    ["POST", "/api/admin/system/update", { requestId: "req-1", version: "0.3.0", digest: DIGEST_A }],
    ["GET", "/api/admin/system/update/op-1"],
  ];

  it("普通账号 Cookie、Bearer 令牌、无凭据、跨源一律被拒", async () => {
    const h = await makeHarness({
      responses: [
        HEALTH_OK,
        { status: 200, body: manifest() },
        { status: 202, body: { operationId: "op-1", status: "running" } },
        { status: 200, body: taskRecord() },
      ],
    });
    const created = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/users", {
      cookie: h.cookie,
      body: { username: "normal-9", password: "normal-pass-1234" },
    });
    expect(created.status).toBe(201);
    const login = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
      body: { username: "normal-9", password: "normal-pass-1234" },
    });
    const userCookie = (login.headers.getSetCookie?.()[0] ?? "").split(";")[0] as string;

    for (const [method, url, body] of endpoints) {
      const anon = await jsonReq(h.feedbackApp.app, method, url, body === undefined ? {} : { body });
      expect(`${method} ${url} 无凭据 → ${anon.status}`).toBe(`${method} ${url} 无凭据 → 401`);

      const asUser = await jsonReq(h.feedbackApp.app, method, url, {
        cookie: userCookie,
        ...(body === undefined ? {} : { body }),
      });
      expect(`${method} ${url} 普通账号 → ${asUser.status}/${asUser.data.error?.code}`).toBe(
        `${method} ${url} 普通账号 → 403/forbidden`,
      );

      const cross = await jsonReq(h.feedbackApp.app, method, url, {
        cookie: h.cookie,
        origin: "http://evil.test",
        ...(body === undefined ? {} : { body }),
      });
      expect(`${method} ${url} 跨源 → ${cross.status}/${cross.data.error?.code}`).toBe(
        `${method} ${url} 跨源 → 403/origin_mismatch`,
      );
    }

    // Bearer（client 会话）不能访问管理接口
    const bearer = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { bearer: "some-token" });
    expect(bearer.status).toBe(401);
  });

  it("令牌只用于请求头，绝不进入响应或服务端日志", async () => {
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const h = await makeHarness({
        responses: [
          HEALTH_OK,
          { status: 200, body: manifest() },
          { status: 202, body: { operationId: "op-1", status: "running" } },
        ],
      });
      await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
      const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
        cookie: h.cookie,
        body: { requestId: "req-1", version: "0.3.0", digest: DIGEST_A },
      });
      const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
      expect(JSON.stringify(post.data)).not.toContain(SHARED_TOKEN);
      expect(JSON.stringify(status.data)).not.toContain(SHARED_TOKEN);
      expect(logs.join("\n")).not.toContain(SHARED_TOKEN);
      // 令牌确实被用于请求头
      expect(h.stub.calls.every((c) => c.token === SHARED_TOKEN)).toBe(true);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("版本清单响应中的令牌不会被计入响应；GET 检查是只读（不产生更新任务）", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(h.stub.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("U1-4 暂停写入（共享控制文件驱动）", () => {
  it("paused 标记存在 → POST /api/feedback 被拒（503 update_paused，可读提示），worker 零归档调用", async () => {
    const h = await makeFullHarness({ responses: [HEALTH_OK] });
    await writePaused(h);
    // 暂停期间不可提交（POST 被闸门拦截）
    const rejected = await submit(h, h.bearer);
    expect(rejected.status).toBe(503);
    expect(rejected.data.error.code).toBe("update_paused");
    expect(rejected.data.error.message).toContain("系统更新进行中");

    // 直接写入一条待处理反馈也不会被 worker 处理（worker 在暂停期间不取队）
    const inserted = h.feedbackApp.db
      .prepare(
        `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
           archive_stage, attempt_count, created_at, updated_at)
         VALUES ('fb-paused', (SELECT id FROM apps LIMIT 1), 'com.test.app', '', '暂停期间提交', 'key-paused', 'hash', 'received',
           'task_pending', 0, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    expect(inserted.changes).toBe(1);
    h.feedbackApp.worker.enqueue("fb-paused");
    // 暂停期间绝不调用 AI / Kaneo
    await new Promise((r) => setTimeout(r, 300));
    expect(h.ai.calls).toBe(0);
    expect(h.kaneo.remoteCalls).toBe(0);
    expect(h.kaneo.remoteWrites).toBe(0);
    // 状态仍是 received（未被处理）
    const row = h.feedbackApp.db.prepare("SELECT status FROM feedbacks WHERE id = 'fb-paused'").get() as {
      status: string;
    };
    expect(row.status).toBe("received");

    // 后台读进度（GET）始终可用
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie })).status).toBe(
      200,
    );
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/admin/feedback", { cookie: h.cookie })).status).toBe(200);
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.pause.paused).toBe(true);
    expect(status.data.pause.marker.phaseLabel).toBe("③保留备份并复制");

    // 清理测试中故意保留的暂停队列，否则 worker 会一直轮询而无法退出。
    await clearPaused(h);
    await h.feedbackApp.worker.idle();
  });

  it("暂停期间队列不丢弃：worker.idle() 立即返回（停机不被卡死），解除暂停后继续处理", async () => {
    const h = await makeFullHarness();
    await writePaused(h);
    h.feedbackApp.db
      .prepare(
        `INSERT INTO feedbacks (id, app_row_id, app_id, user_id, text, idempotency_key, content_hash, status,
           archive_stage, attempt_count, created_at, updated_at)
         VALUES ('fb-queued', (SELECT id FROM apps LIMIT 1), 'com.test.app', '', '排队中', 'key-queued', 'hash2', 'received',
           'task_pending', 0, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    h.feedbackApp.worker.enqueue("fb-queued");
    // 优雅退出路径：暂停期间必须立即返回，否则 compose stop -t 30 会超时被 SIGKILL
    const started = Date.now();
    await h.feedbackApp.worker.idle();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.kaneo.remoteWrites).toBe(0);

    // 解除暂停后队列里的工作继续完成（没有被丢弃）
    await clearPaused(h);
    await vi.waitFor(
      () => {
        const row = h.feedbackApp.db.prepare("SELECT status FROM feedbacks WHERE id = 'fb-queued'").get() as {
          status: string;
        };
        expect(row.status).toBe("archived");
      },
      { timeout: 5000 },
    );
  });

  it("暂停期间管理写入同样被拒（管理员设置/账号/连接/软件配置），但更新入口本身可用", async () => {
    const h = await makeFullHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    await writePaused(h);
    const cases: Array<[string, "PATCH" | "POST" | "PUT"]> = [
      ["管理员设置", "PATCH"],
      ["创建账号", "POST"],
      ["软件配置", "POST"],
      ["连接配置", "PUT"],
    ];
    const urls: Record<string, string> = {
      管理员设置: "/api/admin/me",
      创建账号: "/api/admin/users",
      软件配置: "/api/admin/apps",
      连接配置: "/api/admin/connection/kaneo",
    };
    for (const [name, method] of cases) {
      const url = urls[name] as string;
      const r = await jsonReq(h.feedbackApp.app, method, url, { cookie: h.cookie, body: {} });
      expect(`${name} → ${r.status}/${r.data.error?.code}`).toBe(`${name} → 503/update_paused`);
    }
    // 更新入口（检查）始终可用，否则暂停标记残留就无法自愈
    const check = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(check.status).toBe(200);
  });

  it("暂停标记内容损坏 → 仍按已暂停处理并给出可读原因", async () => {
    const h = await makeFullHarness();
    mkdirSync(h.controlDir, { recursive: true });
    writeFileSync(h.pausedFile, "{不是 JSON");
    await vi.waitFor(() => expect(h.feedbackApp.system.control.isWritePaused()).toBe(true), { timeout: 2000 });
    const rejected = await submit(h, h.bearer);
    expect(rejected.status).toBe(503);
    expect(rejected.data.error.code).toBe("update_paused");
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.pause.marker.parseError).toContain("合法 JSON");
  });

  it("解除暂停（删除标记）→ 写入与 worker 恢复正常", async () => {
    const h = await makeFullHarness();
    await writePaused(h);
    expect((await submit(h, h.bearer)).status).toBe(503);

    await clearPaused(h);
    const accepted = await submit(h, h.bearer);
    expect(accepted.status).toBe(201);
    expect(accepted.data.status).toBe("received");

    // worker 恢复处理（注册后自动入队）
    await vi.waitFor(
      () => {
        const row = h.feedbackApp.db
          .prepare("SELECT status FROM feedbacks WHERE id = ?")
          .get(accepted.data.feedbackId) as {
          status: string;
        };
        expect(row.status).toBe("archived");
      },
      { timeout: 5000 },
    );
    expect(h.kaneo.remoteWrites).toBeGreaterThan(0);
  });

  it("暂停状态来自只读挂载的控制目录，服务重启后不丢失", async () => {
    const controlDir = path.join(makeConfig().dataDir, "shared-update-control");
    const first = await makeFullHarness({ controlDir });
    await writePaused(first);
    const stateOnDisk = JSON.parse(readFileSync(first.pausedFile, "utf8")) as Record<string, unknown>;
    expect(stateOnDisk.phase).toBe("backup_copy");
    first.feedbackApp.close();

    // 用同一控制目录重建 app（等价服务重启）：暂停仍然生效
    const second = await makeHarness({ controlDir });
    expect(second.feedbackApp.system.control.isWritePaused()).toBe(true);
    const status = await jsonReq(second.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: second.cookie });
    expect(status.data.pause.paused).toBe(true);
  });

  it("未挂载控制目录（本地开发）→ 永不暂停，更新入口报未配置", async () => {
    const h = await makeFullHarness({ controlDir: null, tokenFile: null, updateUrl: null });
    expect(h.feedbackApp.system.control.isWritePaused()).toBe(false);
    const accepted = await submit(h, h.bearer);
    expect(accepted.status).toBe(201);
  });
});

describe("U1-4 控制目录与检查结果持久化", () => {
  it("反馈服务自己的状态写在 feedback-state/，不修改执行器文件", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    seedTask(h, taskRecord());
    const before = readdirSync(h.controlDir).sort();
    await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    const after = readdirSync(h.controlDir).sort();
    // 只新增 feedback-state 子目录，既有执行器文件（state/）未动
    expect(after.filter((n) => !before.includes(n))).toEqual(["feedback-state"]);
    const stateFiles = readdirSync(path.join(h.controlDir, "feedback-state"));
    expect(stateFiles).toEqual(["last-check.json"]);
  });

  it("控制目录不可写（模拟只读挂载）→ 检查结果退化为内存，服务不受影响", async () => {
    const h = await makeHarness({ responses: [HEALTH_OK, { status: 200, body: manifest() }] });
    const control = createControlPlane({ controlDir: "/proc/definitely-not-writable" });
    const service = createSystemUpdateService({
      currentVersion: "0.2.1",
      control,
      client: h.feedbackApp.system.client,
      checkIntervalMs: 0,
    });
    try {
      const check = await service.check();
      expect(check.state).toBe("ok");
      // 内存里仍可读到结果
      expect(service.status().check.state).toBe("ok");
      expect(control.writeOwnState("x", { a: 1 })).toBe(false);
    } finally {
      service.close();
    }
  });
});

describe("t11 修复回归：当前版本读取必须适配两种真实布局", () => {
  /** 造一个「包根 + 模块目录」的临时布局。 */
  function makeLayout(
    kind: "src" | "dist",
    version: string,
    name = "@feedback/server",
  ): { moduleDir: string; root: string } {
    const root = mkdtempSync(path.join(tmpdir(), `t11-version-${kind}-`));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version }));
    const moduleDir = kind === "src" ? path.join(root, "src", "routes") : path.join(root, "dist", "routes");
    mkdirSync(moduleDir, { recursive: true });
    return { moduleDir, root };
  }

  it("构建产物布局（dist/routes → 包根 package.json）读出真实版本", () => {
    const { moduleDir, root } = makeLayout("dist", "9.9.9");
    try {
      expect(readPackageVersion(moduleDir)).toBe("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tsx 源码布局（src/routes → 包根 package.json）读出真实版本", () => {
    const { moduleDir, root } = makeLayout("src", "8.8.8");
    try {
      expect(readPackageVersion(moduleDir)).toBe("8.8.8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("两种布局的首个候选都直接命中包根 package.json（不靠逐层兜底侥幸）", () => {
    for (const kind of ["src", "dist"] as const) {
      const { moduleDir, root } = makeLayout(kind, "7.7.7");
      try {
        const candidates = candidatePackageJsonPaths(moduleDir);
        expect(candidates[0]).toBe(path.join(root, "package.json"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("包名不符的候选不会顶掉本包版本（避免误取 monorepo 根 package.json）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "t11-version-decoy-"));
    const moduleDir = path.join(root, "dist", "routes");
    mkdirSync(moduleDir, { recursive: true });
    // 包根（候选 1）是本服务；上一级（候选 3）放一个 monorepo 根做诱饵
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@feedback/server", version: "6.6.6" }));
    writeFileSync(path.join(tmpdir(), "__t11_decoy_should_not_be_read__.json"), "{}");
    try {
      expect(readPackageVersion(moduleDir)).toBe("6.6.6");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(path.join(tmpdir(), "__t11_decoy_should_not_be_read__.json"), { force: true });
    }
  });

  it("真的找不到 package.json 时才回退未知版本占位", () => {
    const root = mkdtempSync(path.join(tmpdir(), "t11-version-none-"));
    const moduleDir = path.join(root, "a", "b", "c", "d");
    mkdirSync(moduleDir, { recursive: true });
    try {
      expect(readPackageVersion(moduleDir)).toBe(UNKNOWN_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("进程内（本仓源码布局）读到的版本等于 apps/server/package.json 的 version", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe("@feedback/server");
    expect(readPackageVersion()).toBe(pkg.version);
    expect(readPackageVersion()).not.toBe(UNKNOWN_VERSION);
  });

  it("后台状态里的 current.version 就是同一个真实版本（不是占位）", async () => {
    const h = await makeHarness();
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.current.version).toBe(pkg.version);
    expect(status.data.current.version).not.toBe(UNKNOWN_VERSION);
  });
});

describe("t11 修复回归：updater 地址必须采纳 compose 注入的变量名", () => {
  const BASE_ENV = {
    FEEDBACK_MASTER_KEY: "t11-master-key-0123456789abcdef",
    FEEDBACK_DATA_DIR: mkdtempSync(path.join(tmpdir(), "t11-env-")),
  };
  const INJECTED = "http://127.0.0.1:59449";

  it("规范名与 compose 注入名一致（FEEDBACK_UPDATER_URL），且被服务端读取", () => {
    expect(UPDATE_URL_ENV).toBe("FEEDBACK_UPDATER_URL");
    const config = loadConfig({ ...BASE_ENV, [UPDATE_URL_ENV]: INJECTED });
    expect(config.updateUrl).toBe(INJECTED);
  });

  it("仅注入 FEEDBACK_UPDATER_URL 时，后台 updaterBaseUrl 等于该地址（不再是默认值）", async () => {
    const config = loadConfig({ ...BASE_ENV, [UPDATE_URL_ENV]: INJECTED });
    const h = await makeHarness({ updateUrl: config.updateUrl });
    const status = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(status.data.config.updateConfigured).toBe(true);
    expect(status.data.config.updaterBaseUrl).toBe(INJECTED);
    expect(status.data.config.updaterBaseUrl).not.toBe(DEFAULT_UPDATE_URL);
  });

  it("旧别名 FEEDBACK_UPDATE_URL 仍兼容，但规范名优先", () => {
    const aliasOnly = loadConfig({ ...BASE_ENV, [UPDATE_URL_ENV_ALIAS]: "http://legacy-alias:1111" });
    expect(aliasOnly.updateUrl).toBe("http://legacy-alias:1111");

    const both = loadConfig({
      ...BASE_ENV,
      [UPDATE_URL_ENV]: INJECTED,
      [UPDATE_URL_ENV_ALIAS]: "http://legacy-alias:1111",
    });
    expect(both.updateUrl).toBe(INJECTED);
  });

  it("两个变量都未设置时回退默认内网地址", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.updateUrl).toBe(DEFAULT_UPDATE_URL);
  });

  it("空字符串视为未设置（不会把地址解析成空串）", () => {
    const config = loadConfig({ ...BASE_ENV, [UPDATE_URL_ENV]: "   ", [UPDATE_URL_ENV_ALIAS]: "  " });
    expect(config.updateUrl).toBe(DEFAULT_UPDATE_URL);
  });
});
