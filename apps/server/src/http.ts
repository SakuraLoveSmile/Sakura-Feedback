import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { RateLimiter } from "./auth/ratelimit.ts";
import { type Db, findActiveSessionByToken, getUserById, type SessionRow, type UserRow } from "./db/repos.ts";
import type { ServerConfig } from "./env.ts";
import { type ControlPlane, PAUSE_DEFAULT_MESSAGE, PAUSE_ERROR_CODE } from "./routes/system-update.ts";

export const COOKIE_NAME = "fb_session";
export const MAX_BODY_BYTES = 64 * 1024;

export interface Err {
  code: string;
  message: string;
  status: number;
}

export function fail(c: Context, e: Err): Response {
  return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
}

export function err(code: string, message: string, status: number): Err {
  return { code, message, status };
}

export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function readBearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return null;
}

/** 解析请求方会话（Cookie 或 Bearer 均可），无效返回 null。 */
export function resolveSession(db: Db, c: Context): SessionRow | null {
  const token = readBearer(c) ?? getCookie(c, COOKIE_NAME);
  if (!token) return null;
  return findActiveSessionByToken(db, token);
}

export function requireSession(db: Db, c: Context, kinds: SessionRow["kind"][]): SessionRow | Err {
  const session = resolveSession(db, c);
  if (!session) return err("unauthorized", "需要登录", 401);
  if (!kinds.includes(session.kind)) return err("unauthorized", "凭据类型不允许此操作", 403);
  return session;
}

/** 会话对应的账号（禁用账号的会话已在 resolveSession 阶段失效）。 */
export function sessionUser(db: Db, session: SessionRow): UserRow | null {
  return getUserById(db, session.user_id);
}

/**
 * 管理员守卫：Cookie 会话 + 同源检查 + **管理员角色**。
 * 普通账号即便持有 Cookie 也不能管理服务；账号角色每次请求都重新读取。
 */
export function requireAdminCookie(db: Db, c: Context, config: ServerConfig): SessionRow | Err {
  const s = requireSession(db, c, ["cookie"]);
  if (isErr(s)) return s;
  const o = checkSameOrigin(c, s, config);
  if (o) return o;
  const user = getUserById(db, s.user_id);
  if (user?.enabled !== 1) return err("unauthorized", "需要登录", 401);
  if (user.role !== "admin") return err("forbidden", "需要管理员权限", 403);
  return s;
}

/**
 * 同源校验比对的期望 origin。
 * 配置了 FEEDBACK_PUBLIC_URL 时以公网地址为准（反向代理会改写内部请求 URL）；
 * 未配置时回退到请求 URL，保留本地/直连行为。不接受转发头推导。
 */
export function expectedOrigin(c: Context, config: ServerConfig): string | null {
  if (config.publicUrl) {
    try {
      return new URL(config.publicUrl).origin;
    } catch {
      return null;
    }
  }
  try {
    return new URL(c.req.url).origin;
  } catch {
    return null;
  }
}

/** Cookie 会话的写操作要求同源（防 CSRF 基础层）。原生客户端不带 Origin 时放行。 */
export function checkSameOrigin(c: Context, session: SessionRow, config: ServerConfig): Err | null {
  if (session.kind !== "cookie") return null;
  const method = c.req.method;
  if (method === "GET" || method === "HEAD") return null;
  return checkOriginHeader(c, config);
}

/**
 * U1-4：**读操作也校验 Origin** 的严格同源检查。
 * 系统更新状态包含部署版本与任务证据，不能让跨站页面读取；
 * 不带 Origin（原生客户端 / 服务端调用）仍放行，保持既有调用约定。
 */
export function checkStrictSameOrigin(c: Context, config: ServerConfig): Err | null {
  return checkOriginHeader(c, config);
}

/** 公共实现：比对本请求 Origin 与期望 origin（不读取转发头）。 */
function checkOriginHeader(c: Context, config: ServerConfig): Err | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  const expected = expectedOrigin(c, config);
  if (!expected) {
    return err("origin_mismatch", "无法确定服务地址", 403);
  }
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    return err("origin_mismatch", "请求来源不合法", 403);
  }
  if (actual !== expected) {
    return err("origin_mismatch", "请求来源与服务地址不一致", 403);
  }
  return null;
}

export function setSessionCookie(c: Context, config: ServerConfig, token: string, expiresAt: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: config.cookieSecure,
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export function checkLimiter(limiter: RateLimiter, key: string): Err | null {
  const retryAfter = limiter.check(key);
  if (retryAfter !== null) {
    const e = err("rate_limited", "尝试过于频繁，请稍后再试", 429);
    (e as Err & { retryAfter?: number }).retryAfter = retryAfter;
    return e;
  }
  return null;
}

/** 读取 JSON body，超过上限返回 413。 */
export async function readJson<T>(c: Context): Promise<T | Err> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return err("too_large", "请求体超过 64KB 上限", 413);
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return err("invalid_request", "无法读取请求体", 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return err("too_large", "请求体超过 64KB 上限", 413);
  }
  try {
    return JSON.parse(raw === "" ? "{}" : raw) as T;
  } catch {
    return err("invalid_request", "请求体不是合法 JSON", 400);
  }
}

export function isErr(v: unknown): v is Err {
  return typeof v === "object" && v !== null && "code" in v && "status" in v;
}

// ---------- U1-4：更新期间暂停业务写入 ----------

/** 业务写入方法（GET/HEAD/OPTIONS 一律放行：后台读进度必须始终可用）。 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 暂停闸门守卫：updater 写入共享控制目录的 `paused` 标记存在时，
 * 拒绝新的业务写入并给出明确错误码与可读提示。
 *
 * 这是一道**纯拦截**闸门（不进入任何路由处理）：暂停期间不会触发 worker 入队、
 * 不会调用 Kaneo/AI，因此「更新期间零归档调用」由它保证。
 * 控制面读取失败（文件缺失/损坏）一律按「未暂停」处理，绝不因控制面异常阻断业务。
 */
export function requireWritesAllowed(control: Pick<ControlPlane, "readPause">) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    if (WRITE_METHODS.has(c.req.method)) {
      const pause = control.readPause();
      if (pause.paused) {
        const message = pause.marker?.message ?? PAUSE_DEFAULT_MESSAGE;
        const phase = pause.marker?.phaseLabel;
        return fail(c, err(PAUSE_ERROR_CODE, `${message}${phase ? `（当前阶段：${phase}）` : ""}`, 503));
      }
    }
    await next();
    return undefined;
  };
}

/** 服务端内部调用（如 worker 自检）判断当前是否处于更新暂停。 */
export function writePaused(control: Pick<ControlPlane, "isWritePaused">): boolean {
  try {
    return control.isWritePaused();
  } catch {
    return false;
  }
}
