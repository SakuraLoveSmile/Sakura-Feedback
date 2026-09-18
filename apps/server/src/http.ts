import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { RateLimiter } from "./auth/ratelimit.ts";
import { type Db, findActiveSessionByToken, getUserById, type SessionRow, type UserRow } from "./db/repos.ts";
import type { ServerConfig } from "./env.ts";

export const COOKIE_NAME = "fb_session";
export const MAX_BODY_BYTES = 64 * 1024;

declare module "hono" {
  interface ContextVariableMap {
    /**
     * 跨源组件请求标记（由 app.ts 的组件端点中间件设置）。
     * 置位后 Cookie **一律不参与鉴权**：浏览器组件只使用 Bearer + `credentials: omit`，
     * 跨源页面绝不允许借后台 Cookie 提升权限。
     */
    crossOriginNoCookie?: boolean;
  }
}

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

/** 解析请求方会话（Bearer 优先；跨源请求不允许回退到后台 Cookie），无效返回 null。 */
export function resolveSession(db: Db, c: Context): SessionRow | null {
  const bearer = readBearer(c);
  const cookie = c.get("crossOriginNoCookie") ? null : getCookie(c, COOKIE_NAME);
  const token = bearer ?? cookie;
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
 * 请求是否来自**跨源**页面：携带 Origin 且与服务自身 origin 不一致。
 * 组件端点据此启用「只认 Bearer、不认 Cookie」的鉴权口径。
 * Origin 头本身非法（无法解析）也按跨源处理——宁可要求 Bearer，也不放宽 Cookie。
 */
export function isCrossOriginRequest(c: Context, config: ServerConfig): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    return true;
  }
  const expected = expectedOrigin(c, config);
  return expected === null || actual !== expected;
}

/** 规范化 Origin 头（仅接受 http/https）；非法返回 null。 */
export function normalizeRequestOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
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
