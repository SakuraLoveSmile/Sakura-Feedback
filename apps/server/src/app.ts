import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { assistMgmtRoutes } from "./assist/manage_routes.ts";
import { bindAssistRuntime } from "./assist/outbox.ts";
import { assistRoutes } from "./assist/routes.ts";
import { type AssistWorker, createAssistWorker } from "./assist/worker.ts";
import { createRateLimiter } from "./auth/ratelimit.ts";
import { decryptSecret } from "./crypto/secret.ts";
import { type Db, openDb } from "./db/db.ts";
import { findResumable, getSetting } from "./db/repos.ts";
import type { ServerConfig } from "./env.ts";
import { isCrossOriginRequest, normalizeRequestOrigin } from "./http.ts";
import { loginPageHtml } from "./pages/login.ts";
import { createWorker, type Worker } from "./pipeline/worker.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes, ensureInitialUser } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import {
  createSystemUpdateService,
  SERVER_VERSION,
  type SystemUpdateService,
  systemUpdateRoutes,
} from "./routes/system-update.ts";
import { type AiClient, createAiClient } from "./services/ai.ts";
import type { KaneoClient } from "./services/kaneo.ts";
import { createKaneoHttpClient } from "./services/kaneo-http.ts";

export interface AppDeps {
  ai?: AiClient;
  kaneo?: KaneoClient;
  /** 测试注入：替代 worker 重试退避与 idle 轮询的真实等待。 */
  workerSleep?: (ms: number) => Promise<void>;
  /** 测试注入：可控服务端时钟（额度按北京时间日切分）。 */
  now?: () => number;
  /** 测试注入：worker 的定时器（默认 setTimeout，自动 unref）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 测试注入：单次自动归档扫描批量（默认 50）。 */
  scanBatch?: number;
  /** 测试注入：版本检查 fetch 实现（默认全局 fetch，直连 GitHub Release 清单）。 */
  updateFetch?: typeof fetch;
  /** 测试注入：Assist 投递 worker 的 fetch 实现（默认全局 fetch）。 */
  assistFetch?: typeof fetch;
}

export interface FeedbackApp {
  app: Hono;
  db: Db;
  config: ServerConfig;
  worker: Worker;
  /** 后台「检查更新」服务（只检查不安装）。 */
  system: SystemUpdateService;
  /** Assist 投递 worker（未配置 FEEDBACK_ASSIST_HUB_URL 时为 null）。 */
  assist: AssistWorker | null;
  /** 释放后台定时器（不影响数据库连接的生命周期）。 */
  close: () => void;
}
export function createApp(config: ServerConfig, deps: AppDeps = {}): FeedbackApp {
  const db = openDb(config.dataDir);
  ensureInitialUser(db, config);

  // 「检查更新」：服务端直连 GitHub Release 清单，结果缓存在数据目录，绝不安装。
  const system = createSystemUpdateService({
    currentVersion: SERVER_VERSION,
    manifestUrl: config.updateManifestUrl ?? null,
    checkIntervalMs: config.updateCheckIntervalMs ?? 0,
    stateFile: path.join(config.dataDir, "update-check.json"),
    ...(deps.updateFetch ? { fetchImpl: deps.updateFetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const ai = deps.ai ?? createAiClient(db, config.masterKey);
  /** 当前 Kaneo 连接配置（含解密密钥）。每次操作只读取一次，之后整轮固定（worker bind）。 */
  const snapshotKaneoSettings = () => {
    const baseUrl = getSetting(db, "kaneo.baseUrl");
    const keyEnc = getSetting(db, "kaneo.apiKeyEnc");
    if (!baseUrl || !keyEnc) return null;
    try {
      return {
        baseUrl,
        apiKey: decryptSecret(config.masterKey, keyEnc),
        clientUrl: getSetting(db, "kaneo.clientUrl") ?? "",
      };
    } catch {
      // 主密钥不匹配/密文损坏：按未配置处理，绝不发出远端写入
      return null;
    }
  };
  const kaneo = deps.kaneo ?? createKaneoHttpClient(snapshotKaneoSettings);
  const worker = createWorker({
    db,
    masterKey: config.masterKey,
    ai,
    kaneo,
    snapshotKaneoSettings,
    ...(deps.workerSleep ? { sleep: deps.workerSleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.scanBatch !== undefined ? { scanBatch: deps.scanBatch } : {}),
  });

  // Assist 接入（contracts/feedback-integration）：未配置 FEEDBACK_ASSIST_HUB_URL = 整体关闭
  // （不绑定运行时 → 全部 enqueue no-op，不建投递 worker，不挂只读路由，业务零变化）。
  let assist: AssistWorker | null = null;
  if (config.assistHubUrl) {
    bindAssistRuntime(db, { queueMax: config.assistQueueMax ?? 1000 });
    if (!config.assistSourceKey) {
      console.warn(
        "[assist] 已配置 FEEDBACK_ASSIST_HUB_URL 但缺少 FEEDBACK_ASSIST_SOURCE_KEY：事件照常入队但会一直 401 停发",
      );
    }
    assist = createAssistWorker({
      db,
      hubUrl: config.assistHubUrl,
      sourceKey: config.assistSourceKey ?? "",
      flushMs: config.assistFlushMs ?? 2000,
      ...(deps.assistFetch ? { fetchImpl: deps.assistFetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  const app = new Hono();

  /**
   * 组件端点的跨域处理（T1）。
   * 合法 http(s) Origin 一律回显，不带 credentials；跨源请求标记为“不认 Cookie”。
   */
  const componentCors = async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    const pathname = new URL(c.req.url).pathname.replace(/\/+$/, "") || "/";
    if (!isComponentEndpoint(pathname)) {
      await next();
      return undefined;
    }
    const origin = c.req.header("origin");
    if (origin) {
      const normalized = normalizeRequestOrigin(origin);
      if (normalized) {
        c.header("access-control-allow-origin", normalized);
        c.header("access-control-allow-methods", "GET, POST, OPTIONS");
        c.header("access-control-allow-headers", "authorization, content-type");
        c.header("access-control-max-age", "300");
        c.header("vary", "origin");
        if (c.req.method === "OPTIONS") return c.body(null, 204);
      }
    }
    // 跨源组件请求只认 Bearer：即使浏览器带上了后台 Cookie，也不会被当作用户身份。
    if (isCrossOriginRequest(c, config)) c.set("crossOriginNoCookie", true);
    await next();
    return undefined;
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  // 宿主应用与反馈服务通常跨源（T1：未登记软件也必须能用）：
  // - 组件端点允许**任意合法 http(s) Origin** 的无凭据跨域请求，按请求回显 Origin；
  // - 绝不回显 access-control-allow-credentials：浏览器端使用 Bearer + `credentials: omit`；
  // - 跨源请求一律**不认后台 Cookie**（crossOriginNoCookie），后台凭据无法被跨站借用；
  // - 只覆盖组件真正需要的端点；后台管理、会话管理与旧登录握手保持原有限制。
  app.use("/api/feedback*", componentCors);
  app.use("/api/auth/*", componentCors);

  // 登录窗口页面（Web 组件握手入口），CSP 只放行带 nonce 的内联脚本
  app.get("/login", (c) => {
    const nonce = randomBytes(16).toString("hex");
    const res = c.html(loginPageHtml(nonce));
    res.headers.set(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  });

  app.route("/api/auth", authRoutes({ db, config, loginLimiter: createRateLimiter(10, 15 * 60 * 1000) }));
  app.route(
    "/api/feedback",
    feedbackRoutes({
      db,
      config,
      worker,
      submitLimiter: createRateLimiter(60, 60 * 60 * 1000),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
  app.route("/api/admin", adminRoutes({ db, masterKey: config.masterKey, config, kaneo, ai, worker }));
  // 「检查更新」接口（同样是 /api/admin 下的管理员守卫路由；只检查不安装）。
  app.route("/api/admin/system", systemUpdateRoutes({ db, config, system }));
  // Assist 只读回连路由：接入开启且存在可用密钥才挂载（READ_KEY 缺省回退 SOURCE_KEY）。
  const assistReadKey = config.assistHubUrl ? (config.assistReadKey ?? config.assistSourceKey) : null;
  // v1.1 管理组：接入开启 + 已配置独立 MGMT_KEY，且必须与生效只读凭证不同
  // （防止只读凭证意外获得写权限；相同则拒绝挂载并记警告）。
  const assistMgmtKey = config.assistHubUrl ? (config.assistMgmtKey ?? null) : null;
  let assistManageEnabled = false;
  if (assistMgmtKey) {
    if (assistReadKey !== null && assistMgmtKey === assistReadKey) {
      console.warn(
        "[assist] FEEDBACK_ASSIST_MGMT_KEY 与生效的只读凭证相同，已拒绝挂载管理接口组（管理凭证必须独立配置）",
      );
    } else {
      app.route("/api/assist/manage", assistMgmtRoutes({ db, mgmtKey: assistMgmtKey, worker }));
      assistManageEnabled = true;
    }
  }
  if (!assistManageEnabled) {
    // 管理组未挂载 → /api/assist/manage/* 显式 404（契约：未配置即整组不挂载）。
    // 必须先于只读组注册，否则请求会被只读组认证中间件截获成 401。
    app.all("/api/assist/manage/*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));
  }
  if (assistReadKey) {
    app.route("/api/assist", assistRoutes({ db, readKey: assistReadKey, manageEnabled: assistManageEnabled }));
  }

  app.notFound((c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));
  app.onError((e, c) => {
    // 日志不记录请求体（可能含反馈原文/密码/令牌）
    let pathname = "/";
    try {
      pathname = new URL(c.req.url).pathname;
    } catch {
      /* ignore */
    }
    console.error(`[server] ${c.req.method} ${pathname} 内部错误:`, (e as Error).message);
    return c.json({ error: { code: "internal", message: "服务器内部错误" } }, 500);
  });

  // 管理页 SPA：/admin/* → dist 静态资源，缺失文件回退 index.html
  const adminDist = config.adminDist;
  if (adminDist && existsSync(adminDist)) {
    app.use("/admin/*", serveStatic({ root: adminDist, rewriteRequestPath: (p) => p.replace(/^\/admin/, "") || "/" }));
    app.get("/admin/*", (c) => {
      const index = path.join(adminDist, "index.html");
      if (existsSync(index)) return c.html(readFileSync(index, "utf8"));
      return c.text("管理页尚未构建", 503);
    });
  }
  app.get("/admin", (c) => c.redirect("/admin/"));

  return {
    app,
    db,
    config,
    worker,
    system,
    assist,
    // T3：先停调度与定时器（此后不再有任何回调访问数据库），再释放检查更新定时器。
    close: () => {
      worker.stop();
      assist?.stop();
      system.close();
    },
  };
}

/** 组件端点（允许无凭据跨域 + 只认 Bearer）的精确路径。 */
const COMPONENT_ENDPOINTS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/session", "/api/feedback"]);
/** 本人记录查询与截图：/api/feedback/{id} 与 /api/feedback/{id}/screenshot。 */
const COMPONENT_FEEDBACK_PATTERN = /^\/api\/feedback\/[^/]+(?:\/screenshot)?$/;

/**
 * 是否属于「组件需要用到的端点」：
 * 反馈提交、本人记录查询与截图、组件登录 / 会话 / 退出。
 * 后台管理、会话管理、旧握手与人工恢复端点**不在其列**，保持原有安全限制。
 */
export function isComponentEndpoint(pathname: string): boolean {
  return COMPONENT_ENDPOINTS.has(pathname) || COMPONENT_FEEDBACK_PATTERN.test(pathname);
}

/** 服务重启恢复：received/processing 重新入队（仅 AI 整理）；archiving 转待核对；
 *  ready_to_archive 只有在**已持久化人工归档授权**时才重新入队；
 *  随后触发一次可恢复的自动归档扫描（重启同样要补处理积压）。 */
export function resumeWorker(feedbackApp: FeedbackApp): void {
  const { requeue, uncertain, authorized } = findResumable(feedbackApp.db);
  feedbackApp.worker.resume(requeue, uncertain, authorized);
  if (requeue.length || uncertain.length || authorized.length) {
    console.log(
      `[server] 恢复处理：重新入队 ${requeue.length} 条，待核对 ${uncertain.length} 条，已授权归档 ${authorized.length} 条`,
    );
  }
  // 重启恢复：按库内状态重新扫描自动归档积压（不依赖一次性内存队列）。
  feedbackApp.worker.scanAutoArchive();
}
