import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRateLimiter } from "./auth/ratelimit.ts";
import { decryptSecret } from "./crypto/secret.ts";
import { type Db, openDb } from "./db/db.ts";
import { findResumable, getSetting } from "./db/repos.ts";
import type { ServerConfig } from "./env.ts";
import { requireWritesAllowed } from "./http.ts";
import { loginPageHtml } from "./pages/login.ts";
import { createWorker, type Worker } from "./pipeline/worker.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes, ensureInitialUser } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import {
  createControlPlane,
  createSystemUpdateService,
  createUpdaterClient,
  SERVER_VERSION,
  type SystemUpdateService,
  systemUpdateRoutes,
  type UpdaterClient,
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
  /** 测试注入：updater 客户端（默认按 FEEDBACK_UPDATE_* 配置创建）。 */
  updaterClient?: UpdaterClient;
  /** 测试注入：控制目录读取缓存时长（毫秒）；0 表示每次读盘。 */
  controlTtlMs?: number;
}

export interface FeedbackApp {
  app: Hono;
  db: Db;
  config: ServerConfig;
  worker: Worker;
  /** U1-4：系统更新聚合（检查/更新代理/暂停状态）。 */
  system: SystemUpdateService;
  /** 释放后台定时器（不影响数据库连接的生命周期）。 */
  close: () => void;
}

export function createApp(config: ServerConfig, deps: AppDeps = {}): FeedbackApp {
  const db = openDb(config.dataDir);
  ensureInitialUser(db, config);

  // U1-4：控制目录（只读挂载）→ 暂停标记与任务进度；令牌只在请求上游时按需从文件读取。
  const control = createControlPlane({
    controlDir: config.updateControlDir ?? null,
    ...(deps.controlTtlMs !== undefined ? { ttlMs: deps.controlTtlMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const updaterClient =
    deps.updaterClient ??
    createUpdaterClient({ baseUrl: config.updateUrl ?? null, tokenFile: config.updateTokenFile ?? null });
  const system = createSystemUpdateService({
    currentVersion: SERVER_VERSION,
    control,
    client: updaterClient,
    checkIntervalMs: config.updateCheckIntervalMs ?? 0,
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
    writesPaused: () => control.isWritePaused(),
    ...(deps.workerSleep ? { sleep: deps.workerSleep } : {}),
  });

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // U1-4：更新暂停闸门。paused 标记存在时拒绝业务写入（503 update_paused），
  // 纯拦截、不进入路由处理：更新期间不会触发任何 worker 入队或远端归档调用。
  // GET/HEAD 一律放行（后台读进度），/api/admin/system/update* 的检查与放行也显式豁免。
  const pauseGate = requireWritesAllowed(control);
  app.use("/api/feedback", pauseGate);
  app.use("/api/feedback/*", pauseGate);
  // 管理写入同样先拦截（只放行读方法）；系统更新自己的检查/放行入口必须始终可用，
  // 因此对 /api/admin/system/update* 显式豁免——否则一旦暂停标记残留，后台将无法自愈。
  app.use("/api/admin", pauseGate);
  app.use("/api/admin/*", async (c, next) => {
    // 挂载点内的路径可能带尾斜杠（/api/admin/system/update/），统一规范化后再判断。
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    if (path === "/api/admin/system/update" || path.startsWith("/api/admin/system/update/")) {
      return next();
    }
    return pauseGate(c, next);
  });

  // 宿主应用与反馈服务通常跨源：/api/feedback* 使用 Bearer（非 Cookie）鉴权，
  // 仅对已在任一软件配置中登记的 allowedOrigins 回显 CORS。
  app.use("/api/feedback*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      let normalized: string | null = null;
      try {
        normalized = new URL(origin).origin;
      } catch {
        normalized = null;
      }
      if (normalized && isRegisteredOrigin(db, normalized)) {
        c.header("access-control-allow-origin", normalized);
        c.header("access-control-allow-methods", "GET, POST, OPTIONS");
        c.header("access-control-allow-headers", "authorization, content-type");
        c.header("access-control-max-age", "300");
        if (c.req.method === "OPTIONS") return c.body(null, 204);
      }
    }
    await next();
  });

  // 组件在宿主页面内登录：登录 / 会话查询 / 退出支持跨源 Bearer（不依赖跨站 Cookie）。
  app.use("/api/auth/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      let normalized: string | null = null;
      try {
        normalized = new URL(origin).origin;
      } catch {
        normalized = null;
      }
      if (normalized && isRegisteredOrigin(db, normalized)) {
        c.header("access-control-allow-origin", normalized);
        c.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
        c.header("access-control-allow-headers", "authorization, content-type");
        c.header("access-control-max-age", "300");
        if (c.req.method === "OPTIONS") return c.body(null, 204);
      }
    }
    await next();
  });

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
  app.route("/api/admin", adminRoutes({ db, masterKey: config.masterKey, config, kaneo, ai }));
  // U1-4：系统更新接口（同样是 /api/admin 下的管理员守卫路由）。
  app.route("/api/admin/system", systemUpdateRoutes({ db, config, system }));

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

  return { app, db, config, worker, system, close: () => system.close() };
}

/** origin 是否已在任一软件配置中登记（用于跨源反馈接口的 CORS 回显）。 */
function isRegisteredOrigin(db: Db, origin: string): boolean {
  const rows = db.prepare("SELECT allowed_origins FROM apps").all() as Array<{ allowed_origins: string }>;
  for (const r of rows) {
    try {
      const list: unknown = JSON.parse(r.allowed_origins);
      if (Array.isArray(list) && list.includes(origin)) return true;
    } catch {
      /* 损坏条目跳过 */
    }
  }
  return false;
}

/** 服务重启恢复：received/processing 重新入队，archiving 转待核对。 */
export function resumeWorker(feedbackApp: FeedbackApp): void {
  const { requeue, uncertain } = findResumable(feedbackApp.db);
  feedbackApp.worker.resume(requeue, uncertain);
  if (requeue.length || uncertain.length) {
    console.log(`[server] 恢复处理：重新入队 ${requeue.length} 条，待核对 ${uncertain.length} 条`);
  }
}
