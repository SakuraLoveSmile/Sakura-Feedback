import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type FeedbackApp } from "../src/app.ts";
import type { ServerConfig } from "../src/env.ts";
import { DEFAULT_UPDATE_MANIFEST_URL, loadConfig } from "../src/env.ts";
import {
  candidatePackageJsonPaths,
  compareSemver,
  createSystemUpdateService,
  deriveReleasePageUrl,
  parseManifest,
  readPackageVersion,
  UNKNOWN_VERSION,
} from "../src/routes/system-update.ts";
import { jsonReq, loginAsAdmin, makeConfig, makeMockAi, makeMockKaneo } from "./helpers.ts";

/**
 * 「检查更新」测试（v0.5.1 起只检查不安装）。
 *
 * 服务端直接拉取 GitHub Release 的 release-manifest.json；本文件用进程内 fetch 桩
 * 替代真实网络，覆盖：成功检查、最新版本判断、各类失败、持久化、限流与守卫。
 * 旧的 updater 执行器链路（发起更新 / 任务进度 / 暂停写入）已整体移除。
 */

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const MANIFEST_URL = "https://github.com/sakura/repo/releases/latest/download/release-manifest.json";

/** 进程内 fetch 桩：记录请求，按队列返回响应，不触网。 */
function createFetchStub(responses: { status: number; body?: unknown; raw?: string }[] | Error) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    if (responses instanceof Error) throw responses;
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) return new Response("{}", { status: 404 });
    return new Response(next.raw ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    version: "99.0.0",
    commit: "abc1234",
    tag: "v99.0.0",
    channel: "stable",
    services: {
      feedback: { image: "ghcr.io/sakura/feedback", digest: DIGEST_A },
    },
    platform: "linux/amd64",
    dbSchemaVersion: 10,
    publishedAt: "2026-09-18T00:00:00.000Z",
    releaseNotes: "修复若干问题",
    ...overrides,
  };
}

interface Harness {
  feedbackApp: FeedbackApp;
  config: ServerConfig;
  cookie: string;
  calls: { url: string; method: string }[];
  stateFile: string;
  kaneo: ReturnType<typeof makeMockKaneo>;
  ai: ReturnType<typeof makeMockAi>;
}

const apps: FeedbackApp[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.close();
    app.db.close();
  }
});

async function makeHarness(
  options: {
    responses?: Parameters<typeof createFetchStub>[0];
    manifestUrl?: string | null;
    checkIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const config = makeConfig();
  config.updateManifestUrl = options.manifestUrl === undefined ? MANIFEST_URL : options.manifestUrl;
  config.updateCheckIntervalMs = options.checkIntervalMs ?? 0;
  const { calls, fetchImpl } = createFetchStub(options.responses ?? [{ status: 200, body: manifest() }]);
  const kaneo = makeMockKaneo();
  const ai = makeMockAi();
  const feedbackApp = createApp(config, {
    ai,
    kaneo,
    workerSleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    updateFetch: fetchImpl,
  });
  apps.push(feedbackApp);
  const cookie = await loginAsAdmin(feedbackApp);
  return {
    feedbackApp,
    config,
    cookie,
    calls,
    stateFile: path.join(config.dataDir, "update-check.json"),
    kaneo,
    ai,
  };
}

describe("检查更新：清单解析与版本比较", () => {
  it("合法清单 → 解析出全部展示字段（不再需要 updater 服务）", () => {
    const m = parseManifest(manifest());
    expect(m).not.toBeNull();
    expect(m!.version).toBe("99.0.0");
    expect(m!.tag).toBe("v99.0.0");
    expect(m!.channel).toBe("stable");
    expect(m!.services.feedback).toEqual({ image: "ghcr.io/sakura/feedback", digest: DIGEST_A });
    expect(m!.dbSchemaVersion).toBe(10);
    expect(m!.notes).toBe("修复若干问题");
  });

  it("各类非法清单一律拒绝（不判半截清单为新版本）", () => {
    const cases: [string, unknown][] = [
      ["非对象", "not-an-object"],
      ["manifestVersion 缺失", { ...manifest(), manifestVersion: undefined }],
      ["manifestVersion != 1", manifest({ manifestVersion: 2 })],
      ["version 非 semver", manifest({ version: "latest" })],
      ["channel 缺失", manifest({ channel: "" })],
      ["services 缺失", manifest({ services: undefined })],
      ["feedback 缺失", manifest({ services: {} })],
      ["digest 非法", manifest({ services: { feedback: { image: "x", digest: "sha256:abc" } } })],
      ["digest 大写 hex", manifest({ services: { feedback: { image: "x", digest: `sha256:${"A".repeat(64)}` } } })],
    ];
    for (const [name, raw] of cases) {
      expect(parseManifest(raw), name).toBeNull();
    }
  });

  it("compareSemver：大小于 / 相等 / 预发布核心段", () => {
    expect(compareSemver("0.5.1", "0.5.0")).toBe(1);
    expect(compareSemver("0.5.0", "0.5.1")).toBe(-1);
    expect(compareSemver("0.5.0", "0.5.0")).toBe(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(0); // 只比较核心段
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1); // 数值比较，非字典序
  });

  it("deriveReleasePageUrl：清单地址 → Release 页面", () => {
    expect(deriveReleasePageUrl(MANIFEST_URL, "v0.5.1")).toBe("https://github.com/sakura/repo/releases/tag/v0.5.1");
    expect(deriveReleasePageUrl(MANIFEST_URL, null)).toBe("https://github.com/sakura/repo/releases/latest");
    expect(deriveReleasePageUrl("https://example.com/m.json", "v1")).toBe("https://example.com/m.json");
  });
});

describe("检查更新：API 行为", () => {
  it("GET /api/admin/system/update：当前版本 + 检查配置 + 未检查状态", async () => {
    const h = await makeHarness();
    const res = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(res.status).toBe(200);
    expect(res.data.current.version).not.toBe(UNKNOWN_VERSION);
    expect(res.data.config.manifestUrl).toBe(MANIFEST_URL);
    expect(res.data.check.state).toBe("never");
    expect(res.data.check.latest).toBeNull();
    // 尚未检查：不应发起任何外部请求
    expect(h.calls).toHaveLength(0);
  });

  it("POST /update/check：清单版本更高 → ok，latest 带版本/tag/说明/digest/发布页", async () => {
    const h = await makeHarness();
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.status).toBe(200);
    const check = res.data.check;
    expect(check.state).toBe("ok");
    expect(check.source).toBe(MANIFEST_URL);
    expect(check.latest.version).toBe("99.0.0");
    expect(check.latest.tag).toBe("v99.0.0");
    expect(check.latest.notes).toBe("修复若干问题");
    expect(check.latest.digest).toBe(DIGEST_A);
    expect(check.latest.image).toBe("ghcr.io/sakura/feedback");
    expect(check.latest.releaseUrl).toBe("https://github.com/sakura/repo/releases/tag/v99.0.0");
    // 检查是只读操作：不触网以外的副作用（零 Kaneo 写入、零 AI 调用）
    expect(h.calls).toEqual([{ url: MANIFEST_URL, method: "GET" }]);
    expect(h.kaneo.remoteWrites).toBe(0);
  });

  it("清单版本 ≤ 当前版本 → up_to_date", async () => {
    const h = await makeHarness({ responses: [{ status: 200, body: manifest({ version: "0.0.1" }) }] });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.data.check.state).toBe("up_to_date");
    expect(res.data.check.latest.version).toBe("0.0.1");
  });

  it("检查后的 GET /update 复用缓存结果（不重复请求清单）", async () => {
    const h = await makeHarness();
    await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    const res = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", { cookie: h.cookie });
    expect(res.data.check.state).toBe("ok");
    expect(h.calls).toHaveLength(1); // 只请求过一次
  });

  it("网络失败 → failed / manifest_unreachable（不是 500，服务不受影响）", async () => {
    const h = await makeHarness({ responses: new Error("connection refused") });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.status).toBe(200);
    expect(res.data.check.state).toBe("failed");
    expect(res.data.check.failedCode).toBe("manifest_unreachable");
    expect(res.data.check.failedMessage).toContain("connection refused");
    // 服务仍健康
    const health = await jsonReq(h.feedbackApp.app, "GET", "/healthz");
    expect(health.data.ok).toBe(true);
  });

  it("HTTP 非 200（Release 不存在等）→ failed / manifest_http_error", async () => {
    const h = await makeHarness({ responses: [{ status: 404, body: {} }] });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.data.check.state).toBe("failed");
    expect(res.data.check.failedCode).toBe("manifest_http_error");
    expect(res.data.check.failedMessage).toContain("404");
  });

  it("响应非 JSON → failed / manifest_bad_response", async () => {
    const h = await makeHarness({ responses: [{ status: 200, raw: "<html>not found</html>" }] });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.data.check.state).toBe("failed");
    expect(res.data.check.failedCode).toBe("manifest_bad_response");
  });

  it("清单字段缺失（无 digest）→ failed / manifest_bad_response", async () => {
    const bad = manifest({ services: { feedback: { image: "ghcr.io/x/y" } } });
    const h = await makeHarness({ responses: [{ status: 200, body: bad }] });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.data.check.state).toBe("failed");
    expect(res.data.check.failedCode).toBe("manifest_bad_response");
  });

  it("清单地址显式关闭（off → null）→ failed / manifest_not_configured，不发起请求", async () => {
    const h = await makeHarness({ manifestUrl: null });
    const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    expect(res.status).toBe(200);
    expect(res.data.check.state).toBe("failed");
    expect(res.data.check.failedCode).toBe("manifest_not_configured");
    expect(h.calls).toHaveLength(0);
  });

  it("检查结果持久化到数据目录，新实例可复用（重启后仍显示上次检查）", async () => {
    const h = await makeHarness();
    await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
    const persisted = JSON.parse(readFileSync(h.stateFile, "utf8")) as { view: { state: string } };
    expect(persisted.view.state).toBe("ok");

    const { fetchImpl } = createFetchStub([{ status: 200, body: manifest() }]);
    const service = createSystemUpdateService({
      currentVersion: "0.5.0",
      manifestUrl: MANIFEST_URL,
      checkIntervalMs: 0,
      stateFile: h.stateFile,
      fetchImpl,
    });
    try {
      expect(service.status().check.state).toBe("ok");
      expect(service.status().check.latest?.version).toBe("99.0.0");
    } finally {
      service.close();
    }
  });

  it("状态文件不可写 → 退化为内存缓存，检查与状态不受影响", async () => {
    // 用一个「普通文件」冒充状态文件父目录：mkdir/write 会立刻 ENOTDIR 失败
    const root = mkdtempSync(path.join(tmpdir(), "update-check-ro-"));
    const blocker = path.join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const service = createSystemUpdateService({
      currentVersion: "0.5.0",
      manifestUrl: MANIFEST_URL,
      checkIntervalMs: 0,
      stateFile: path.join(blocker, "update-check.json"),
      fetchImpl: createFetchStub([{ status: 200, body: manifest() }]).fetchImpl,
    });
    try {
      const check = await service.check();
      expect(check.state).toBe("ok");
      expect(service.status().check.state).toBe("ok");
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runAutoCheck 按间隔节流（只检查不安装）", async () => {
    const { calls, fetchImpl } = createFetchStub([{ status: 200, body: manifest() }]);
    const root = mkdtempSync(path.join(tmpdir(), "update-check-auto-"));
    const service = createSystemUpdateService({
      currentVersion: "0.5.0",
      manifestUrl: MANIFEST_URL,
      checkIntervalMs: 60_000,
      stateFile: path.join(root, "update-check.json"),
      fetchImpl,
      setTimer: () => ({}), // 不真正调度，手动驱动 runAutoCheck
    });
    try {
      expect(await service.runAutoCheck()).toBe(true); // 首次必查
      expect(await service.runAutoCheck()).toBe(false); // 间隔内跳过
      expect(calls).toHaveLength(1);
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("更新/任务接口已移除：POST /update 与 GET /update/:id 一律 404", async () => {
    const h = await makeHarness();
    const post = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update", {
      cookie: h.cookie,
      body: { requestId: "r1", version: "99.0.0", digest: DIGEST_A },
    });
    expect(post.status).toBe(404);
    const get = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update/op-1", { cookie: h.cookie });
    expect(get.status).toBe(404);
    // 确认没有因为「发起更新」产生任何外部调用
    expect(h.calls).toHaveLength(0);
  });

  it("手动检查限流：超过 30 次 / 15 分钟 → 429", async () => {
    const h = await makeHarness();
    for (let i = 0; i < 30; i += 1) {
      const res = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", { cookie: h.cookie });
      expect(res.status).toBe(200);
    }
    const limited = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", {
      cookie: h.cookie,
    });
    expect(limited.status).toBe(429);
    expect(limited.data.error.code).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("守卫：无凭据 401，跨源 Origin 403（检查状态不外泄）", async () => {
    const h = await makeHarness();
    const anon = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update");
    expect(anon.status).toBe(401);
    const cross = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/system/update", {
      cookie: h.cookie,
      origin: "https://evil.example",
    });
    expect(cross.status).toBe(403);
    expect(cross.data.error.code).toBe("origin_mismatch");
    const crossPost = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/system/update/check", {
      cookie: h.cookie,
      origin: "https://evil.example",
    });
    expect(crossPost.status).toBe(403);
    expect(h.calls).toHaveLength(0); // 跨站请求绝不能触发清单拉取
  });
});

describe("检查更新：环境变量解析", () => {
  const BASE_ENV = {
    FEEDBACK_MASTER_KEY: "test-master-key-0123456789abcdef",
    FEEDBACK_DATA_DIR: mkdtempSync(path.join(tmpdir(), "update-env-")),
  };

  it("未设置 → 默认稳定渠道清单地址", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.updateManifestUrl).toBe(DEFAULT_UPDATE_MANIFEST_URL);
    expect(config.updateManifestUrl).toContain("/releases/latest/download/release-manifest.json");
  });

  it("off / none / disabled（大小写不敏感）→ 显式关闭", () => {
    for (const off of ["off", "NONE", "Disabled"]) {
      const config = loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_MANIFEST_URL: off });
      expect(config.updateManifestUrl, off).toBeNull();
    }
  });

  it("自定义地址（自建发布渠道）→ 原样采纳", () => {
    const config = loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_MANIFEST_URL: "https://mirror.example/m.json" });
    expect(config.updateManifestUrl).toBe("https://mirror.example/m.json");
  });

  it("空字符串视为未设置（回退默认，不会把地址解析成空串）", () => {
    const config = loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_MANIFEST_URL: "   " });
    expect(config.updateManifestUrl).toBe(DEFAULT_UPDATE_MANIFEST_URL);
  });

  it("检查间隔：合法值采纳，非法值回退默认", () => {
    expect(loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_CHECK_INTERVAL_MS: "60000" }).updateCheckIntervalMs).toBe(60_000);
    expect(loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_CHECK_INTERVAL_MS: "-5" }).updateCheckIntervalMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(loadConfig({ ...BASE_ENV, FEEDBACK_UPDATE_CHECK_INTERVAL_MS: "abc" }).updateCheckIntervalMs).toBe(
      24 * 60 * 60 * 1000,
    );
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
