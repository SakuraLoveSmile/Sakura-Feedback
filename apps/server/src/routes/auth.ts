import { Hono } from "hono";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import type { RateLimiter } from "../auth/ratelimit.ts";
import {
  createSession,
  createUser,
  type Db,
  getAppByAppId,
  getUser,
  listSessions,
  revokeSession,
  revokeSessionsByIds,
  type SessionRow,
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
  requireSession,
  setSessionCookie,
} from "../http.ts";

export interface AuthDeps {
  db: Db;
  config: ServerConfig;
  loginLimiter: RateLimiter;
}

/** 初始账号由部署配置建立，不开放注册。返回是否新建。 */
export function ensureInitialUser(db: Db, config: ServerConfig): boolean {
  if (getUser(db)) return false;
  if (!config.adminUser || !config.adminPassword) return false;
  createUser(db, config.adminUser, hashPassword(config.adminPassword));
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

/** 仅 Cookie 会话的管理守卫（含同源检查）。 */
function cookieAdmin(deps: AuthDeps, c: Parameters<typeof requireSession>[1]): SessionRow | Response {
  const s = requireSession(deps.db, c, ["cookie"]);
  if (isErr(s)) return fail(c, s);
  const o = checkSameOrigin(c, s, deps.config);
  if (o) return fail(c, o);
  return s;
}

export function authRoutes(deps: AuthDeps): Hono {
  const { db, config } = deps;
  const routes = new Hono();

  routes.post("/login", async (c) => {
    const body = await readJson<{ username?: string; password?: string; clientLabel?: string }>(c);
    if (isErr(body)) return fail(c, body);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const clientLabel =
      typeof body.clientLabel === "string" && body.clientLabel.trim() !== ""
        ? body.clientLabel.trim().slice(0, 100)
        : null;

    const limited = checkLimiter(deps.loginLimiter, `${clientIp(c)}|${username}`);
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }

    const user = getUser(db);
    if (!user || username !== user.username || password === "" || !verifyPassword(password, user.pass_hash)) {
      return fail(c, err("invalid_credentials", "用户名或密码错误", 401));
    }

    const kind: SessionRow["kind"] = clientLabel ? "client" : "cookie";
    const ttl = clientLabel ? config.clientTokenTtlMs : config.sessionTtlMs;
    const { row, token } = createSession(db, user.id, kind, ttl, clientLabel ?? undefined);
    setSessionCookie(c, config, token, row.expires_at);

    return c.json(
      clientLabel ? { ok: true, token, expiresAt: row.expires_at } : { ok: true, expiresAt: row.expires_at },
    );
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
    return c.json({
      authenticated: true,
      kind: s.kind,
      clientLabel: s.client_label,
      expiresAt: s.expires_at,
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
    const user = getUser(db)!;
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
