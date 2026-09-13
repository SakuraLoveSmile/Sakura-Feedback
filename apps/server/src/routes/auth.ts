import { Hono } from "hono";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import type { RateLimiter } from "../auth/ratelimit.ts";
import {
  createSession,
  createUser,
  type Db,
  getAppByAppId,
  getQuota,
  getUser,
  getUserByUsername,
  listSessions,
  revokeSession,
  revokeSessionsByIds,
  type SessionRow,
  type UserRow,
} from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import {
  checkLimiter,
  checkSameOrigin,
  clearSessionCookie,
  clientIp,
  type Err,
  err,
  fail,
  isErr,
  readJson,
  requireAdminCookie,
  requireSession,
  sessionUser,
  setSessionCookie,
} from "../http.ts";

export interface AuthDeps {
  db: Db;
  config: ServerConfig;
  loginLimiter: RateLimiter;
}

/** 对外暴露的最小账号信息（绝不返回密码或哈希）。 */
export function publicUser(u: Pick<UserRow, "id" | "username" | "role">) {
  return { id: u.id, username: u.username, role: u.role };
}

/** 初始账号由部署配置建立，不开放注册。返回是否新建。 */
export function ensureInitialUser(db: Db, config: ServerConfig): boolean {
  if (getUser(db)) return false;
  if (!config.adminUser || !config.adminPassword) return false;
  createUser(db, config.adminUser, hashPassword(config.adminPassword), { role: "admin" });
  return true;
}

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin; // 精确到 scheme://host:port
  } catch {
    return null;
  }
}

function validateHandshakeTarget(db: Db, appId: string, origin: string): Err | null {
  const app = getAppByAppId(db, appId);
  if (!app) return err("unknown_app", "appId 未配置", 404);
  const normalized = normalizeOrigin(origin);
  if (!normalized) return err("origin_not_allowed", "来源不合法", 400);
  let list: unknown;
  try {
    list = JSON.parse(app.allowed_origins);
  } catch {
    list = [];
  }
  const allowed = Array.isArray(list) ? (list as string[]) : [];
  if (!allowed.includes(normalized)) return err("origin_not_allowed", "该来源未被允许接收登录令牌", 403);
  return null;
}

/** 客户端令牌登录的来源校验：按目标应用的允许来源校验浏览器 Origin。 */
function validateClientOrigin(db: Db, appId: string, originHeader: string | undefined): Err | null {
  const app = getAppByAppId(db, appId);
  if (!app) return err("unknown_app", "appId 未配置", 404);
  if (!originHeader) return null; // 原生客户端不携带 Origin
  const normalized = normalizeOrigin(originHeader);
  if (!normalized) return err("origin_not_allowed", "来源不合法", 400);
  let list: unknown;
  try {
    list = JSON.parse(app.allowed_origins);
  } catch {
    list = [];
  }
  const allowed = Array.isArray(list) ? (list as string[]) : [];
  if (!allowed.includes(normalized)) return err("origin_not_allowed", "该来源未被允许登录", 403);
  return null;
}

/** 后台/会话管理守卫：Cookie 会话 + 管理员角色 + 同源检查。 */
function cookieAdmin(deps: AuthDeps, c: Parameters<typeof requireSession>[1]): SessionRow | Response {
  const s = requireAdminCookie(deps.db, c, deps.config);
  if (isErr(s)) return fail(c, s);
  return s;
}

export function authRoutes(deps: AuthDeps): Hono {
  const { db, config } = deps;
  const routes = new Hono();

  routes.post("/login", async (c) => {
    const body = await readJson<{
      username?: string;
      password?: string;
      clientLabel?: string;
      appId?: string;
    }>(c);
    if (isErr(body)) return fail(c, body);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const clientLabel =
      typeof body.clientLabel === "string" && body.clientLabel.trim() !== ""
        ? body.clientLabel.trim().slice(0, 100)
        : null;
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";

    const limited = checkLimiter(deps.loginLimiter, `${clientIp(c)}|${username}`);
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }

    const user = getUserByUsername(db, username);
    if (user?.enabled !== 1 || password === "" || !verifyPassword(password, user.pass_hash)) {
      return fail(c, err("invalid_credentials", "用户名或密码错误", 401));
    }

    // 令牌登录（Web / Flutter）：必须声明 appId，浏览器来源按该应用允许来源校验。
    if (clientLabel) {
      if (!appId) return fail(c, err("invalid_request", "令牌登录必须携带 appId", 400));
      const originErr = validateClientOrigin(db, appId, c.req.header("origin"));
      if (originErr) return fail(c, originErr);
    }

    const kind: SessionRow["kind"] = clientLabel ? "client" : "cookie";
    const ttl = clientLabel ? config.clientTokenTtlMs : config.sessionTtlMs;
    const { row, token } = createSession(db, user.id, kind, ttl, clientLabel ?? undefined);
    if (!clientLabel) setSessionCookie(c, config, token, row.expires_at);

    const quota = getQuota(db, user);
    return c.json({
      ok: true,
      ...(clientLabel ? { token } : {}),
      expiresAt: row.expires_at,
      user: publicUser(user),
      quota,
    });
  });

  routes.post("/logout", (c) => {
    const s = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(s)) return fail(c, s);
    revokeSession(db, s.id);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  routes.get("/session", (c) => {
    const s = requireSession(db, c, ["cookie", "client", "handshake"]);
    if (isErr(s)) return fail(c, s);
    const user = sessionUser(db, s);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    return c.json({
      authenticated: true,
      kind: s.kind,
      clientLabel: s.client_label,
      expiresAt: s.expires_at,
      user: publicUser(user),
      quota: getQuota(db, user),
    });
  });

  // 登录页签发握手令牌前的预检（签发时服务端仍会再次校验）
  routes.get("/handshake/validate", (c) => {
    const s = requireSession(db, c, ["cookie"]);
    if (isErr(s)) return fail(c, s);
    const check = validateHandshakeTarget(db, c.req.query("appId") ?? "", c.req.query("origin") ?? "");
    if (check) return fail(c, check);
    return c.json({ ok: true });
  });

  routes.post("/handshake", async (c) => {
    const s = requireSession(db, c, ["cookie"]);
    if (isErr(s)) return fail(c, s);
    const originErr = checkSameOrigin(c, s, config);
    if (originErr) return fail(c, originErr);
    const body = await readJson<{ appId?: string; origin?: string }>(c);
    if (isErr(body)) return fail(c, body);
    const check = validateHandshakeTarget(db, body.appId ?? "", body.origin ?? "");
    if (check) return fail(c, check);
    // 旧握手签发必须绑定当前登录用户（而非数据库首个账号）。
    const user = sessionUser(db, s);
    if (!user) return fail(c, err("unauthorized", "需要登录", 401));
    const { row, token } = createSession(db, user.id, "handshake", config.handshakeTtlMs, `web:${body.appId}`);
    return c.json({
      accessToken: token,
      expiresIn: Math.floor(config.handshakeTtlMs / 1000),
      expiresAt: row.expires_at,
    });
  });

  // ---- 会话管理（仅 cookie 会话，管理页用） ----
  routes.get("/sessions", (c) => {
    const s = cookieAdmin(deps, c);
    if (s instanceof Response) return s;
    return c.json({
      sessions: listSessions(db).map((r) => ({
        id: r.id,
        kind: r.kind,
        clientLabel: r.client_label,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
        current: r.id === s.id,
      })),
    });
  });

  routes.delete("/sessions/:id", (c) => {
    const s = cookieAdmin(deps, c);
    if (s instanceof Response) return s;
    const id = c.req.param("id");
    if (!listSessions(db).some((r) => r.id === id)) return fail(c, err("not_found", "会话不存在", 404));
    revokeSession(db, id);
    if (id === s.id) clearSessionCookie(c);
    return c.body(null, 204);
  });

  routes.post("/sessions/revoke-all", (c) => {
    const s = cookieAdmin(deps, c);
    if (s instanceof Response) return s;
    const ids = listSessions(db)
      .filter((r) => r.id !== s.id)
      .map((r) => r.id);
    return c.json({ revoked: revokeSessionsByIds(db, ids) });
  });

  return routes;
}
