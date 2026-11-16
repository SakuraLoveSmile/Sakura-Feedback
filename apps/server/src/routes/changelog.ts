import type { Context } from "hono";
import { Hono } from "hono";
import {
  ChangelogError,
  changelogMarkdown,
  createRelease,
  getPublicChangelog,
  getRelease,
  listChangelogApps,
  listReleases,
  parseExpectedRevision,
  parseReleaseInput,
  setReleasePublished,
  updateRelease,
} from "../db/changelog.ts";
import type { Db } from "../db/db.ts";
import type { ServerConfig } from "../env.ts";
import { fail, isErr, readJson, requireAdminCookie } from "../http.ts";
import { changelogPageHtml } from "../pages/changelog.ts";

function respond(c: Context, operation: () => unknown, status: 200 | 201 = 200): Response {
  try {
    return c.json(operation(), status);
  } catch (error) {
    if (error instanceof ChangelogError) return fail(c, error);
    throw error;
  }
}

export function changelogAdminRoutes({ db, config }: { db: Db; config: ServerConfig }): Hono {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    const session = requireAdminCookie(db, c, config);
    if (isErr(session)) return fail(c, session);
    c.header("cache-control", "no-store");
    await next();
  });
  routes.get("/", (c) => respond(c, () => ({ items: listReleases(db, c.req.query("appId") ?? "") })));
  routes.post("/", async (c) => {
    const body = await readJson<unknown>(c);
    if (isErr(body)) return fail(c, body);
    return respond(c, () => createRelease(db, parseReleaseInput(body)), 201);
  });
  routes.get("/apps", (c) => respond(c, () => ({ items: listChangelogApps(db) })));
  routes.get("/:id", (c) => respond(c, () => getRelease(db, c.req.param("id"))));
  routes.put("/:id", async (c) => {
    const body = await readJson<unknown>(c);
    if (isErr(body)) return fail(c, body);
    return respond(c, () => updateRelease(db, c.req.param("id"), parseReleaseInput(body), parseExpectedRevision(body)));
  });
  for (const action of ["publish", "unpublish"] as const) {
    routes.post(`/:id/${action}`, async (c) => {
      const body = await readJson<unknown>(c);
      if (isErr(body)) return fail(c, body);
      return respond(c, () =>
        setReleasePublished(db, c.req.param("id"), action === "publish", parseExpectedRevision(body)),
      );
    });
  }
  return routes;
}

export function changelogPublicRoutes(db: Db): Hono {
  const routes = new Hono();
  // 单独的匿名只读 CORS：不开放 Cookie、Authorization 或任何写方法。
  routes.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("allow", "GET, HEAD, OPTIONS");
      return c.json({ error: { code: "method_not_allowed", message: "更新日志接口仅允许读取" } }, 405);
    }
    await next();
  });
  routes.get("/:appId", (c) => respond(c, () => getPublicChangelog(db, c.req.param("appId"))));
  routes.get("/:appId/markdown", (c) => {
    try {
      return c.text(changelogMarkdown(getPublicChangelog(db, c.req.param("appId"))));
    } catch (error) {
      if (error instanceof ChangelogError) return fail(c, error);
      throw error;
    }
  });
  return routes;
}

export function changelogPageRoutes(db: Db): Hono {
  const routes = new Hono();
  routes.get("/:appId", (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    c.header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    try {
      return c.html(changelogPageHtml(getPublicChangelog(db, c.req.param("appId"))));
    } catch (error) {
      if (error instanceof ChangelogError) return c.text(error.message, error.status);
      throw error;
    }
  });
  return routes;
}
