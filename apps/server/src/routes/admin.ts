import { Hono } from "hono";
import { encryptSecret } from "../crypto/secret.ts";
import {
  type AppRow,
  type Db,
  deleteApp,
  type FeedbackRow,
  type FeedbackStatus,
  getAppByAppId,
  getFeedback,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
  getSetting,
  insertApp,
  listApps,
  listFeedbacks,
  setSetting,
  toAdminListItem,
  updateApp,
} from "../db/repos.ts";
import type { ServerConfig } from "../env.ts";
import { checkSameOrigin, type Err, err, fail, isErr, readJson, requireSession } from "../http.ts";
import { parseArchiveData } from "../pipeline/archive-data.ts";
import type { AiClient } from "../services/ai.ts";
import type { KaneoClient } from "../services/kaneo.ts";
import type { PublicApp } from "../types.ts";

export interface AdminDeps {
  db: Db;
  masterKey: Buffer;
  config: ServerConfig;
  kaneo: KaneoClient;
  ai: AiClient;
}

function publicApp(r: AppRow): PublicApp {
  let origins: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.allowed_origins);
    if (Array.isArray(parsed)) origins = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* 数据损坏按空处理 */
  }
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    allowedOrigins: origins,
    kaneoProjectId: r.kaneo_project_id,
    kaneoColumnSlug: r.kaneo_column_slug,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeOriginList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    try {
      const u = new URL(item.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      out.push(u.origin);
    } catch {
      return null;
    }
  }
  return out;
}

interface AppInput {
  appId: string;
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
}

function validateAppInput(body: Record<string, unknown>, requireAppId: boolean): AppInput | Err {
  const appId = typeof body.appId === "string" ? body.appId.trim() : "";
  if (requireAppId && (!appId || appId.length > 100)) {
    return err("invalid_request", "appId 必填且不超过 100 字符", 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return err("invalid_request", "name 必填且不超过 100 字符", 400);
  const origins = normalizeOriginList(body.allowedOrigins ?? []);
  if (origins === null) return err("invalid_request", "allowedOrigins 必须是 http(s) origin 数组", 400);
  const kaneoProjectId = typeof body.kaneoProjectId === "string" ? body.kaneoProjectId.trim().slice(0, 100) : "";
  const kaneoColumnSlug = typeof body.kaneoColumnSlug === "string" ? body.kaneoColumnSlug.trim().slice(0, 100) : "";
  return { appId, name, allowedOrigins: origins, kaneoProjectId, kaneoColumnSlug };
}

export function adminRoutes(deps: AdminDeps): Hono {
  const { db, masterKey, config } = deps;
  const routes = new Hono();

  // 全部管理接口：仅 cookie 会话 + 同源检查
  routes.use("*", async (c, next) => {
    const s = requireSession(db, c, ["cookie"]);
    if (isErr(s)) return fail(c, s);
    const o = checkSameOrigin(c, s, config);
    if (o) return fail(c, o);
    await next();
  });

  // ---------- 软件配置 ----------
  routes.get("/apps", (c) => c.json({ apps: listApps(db).map(publicApp) }));

  routes.post("/apps", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const v = validateAppInput(body, true);
    if ("status" in v) return fail(c, v);
    if (getAppByAppId(db, v.appId)) return fail(c, err("app_exists", "该 appId 已存在", 409));
    const row = insertApp(db, v);
    return c.json(publicApp(row), 201);
  });

  routes.put("/apps/:id", async (c) => {
    const existing = listApps(db).find((a) => a.id === c.req.param("id"));
    if (!existing) return fail(c, err("not_found", "软件配置不存在", 404));
    const body = await readJson<Record<string, unknown>>(c);
    if (isErr(body)) return fail(c, body);
    const v = validateAppInput({ ...body, appId: existing.app_id }, false); // appId 不可改
    if ("status" in v) return fail(c, v);
    updateApp(db, existing.id, {
      name: v.name,
      allowedOrigins: v.allowedOrigins,
      kaneoProjectId: v.kaneoProjectId,
      kaneoColumnSlug: v.kaneoColumnSlug,
    });
    return c.json(publicApp(listApps(db).find((a) => a.id === existing.id)!));
  });

  routes.delete("/apps/:id", (c) => {
    const id = c.req.param("id");
    if (!listApps(db).some((a) => a.id === id)) return fail(c, err("not_found", "软件配置不存在", 404));
    deleteApp(db, id); // 历史反馈保留
    return c.body(null, 204);
  });

  // ---------- Kaneo 连接 ----------
  routes.get("/connection/kaneo", (c) => {
    return c.json({
      baseUrl: getSetting(db, "kaneo.baseUrl"),
      clientUrl: getSetting(db, "kaneo.clientUrl"),
      apiKeySet: getSetting(db, "kaneo.apiKeyEnc") !== null,
    });
  });

  routes.put("/connection/kaneo", async (c) => {
    const body = await readJson<{ baseUrl?: unknown; clientUrl?: unknown; apiKey?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!isHttpUrl(baseUrl)) return fail(c, err("invalid_request", "baseUrl 必须是 http(s) URL", 400));
    const clientUrlRaw = typeof body.clientUrl === "string" ? body.clientUrl.trim() : "";
    if (clientUrlRaw !== "" && !isHttpUrl(clientUrlRaw)) {
      return fail(c, err("invalid_request", "clientUrl 必须是 http(s) URL", 400));
    }
    setSetting(db, "kaneo.baseUrl", baseUrl);
    if (clientUrlRaw) setSetting(db, "kaneo.clientUrl", clientUrlRaw);
    else deleteSetting(db, "kaneo.clientUrl");
    if (typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
      setSetting(db, "kaneo.apiKeyEnc", encryptSecret(masterKey, body.apiKey.trim()));
    }
    return c.json({ ok: true, apiKeySet: getSetting(db, "kaneo.apiKeyEnc") !== null });
  });

  routes.post("/connection/kaneo/test", async (c) => {
    const body = await readJson<{ projectId?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) return fail(c, err("invalid_request", "projectId 必填", 400));
    try {
      const r = await deps.kaneo.test(projectId);
      return c.json({ ok: true, project: r.project, columns: r.columns });
    } catch (errObj) {
      return c.json({ ok: false, reason: (errObj as Error).message.slice(0, 300) }, 502);
    }
  });

  routes.get("/connection/kaneo/projects", async (c) => {
    try {
      const r = await deps.kaneo.listProjects();
      return c.json({ ok: true, ...r });
    } catch (errObj) {
      return c.json({ ok: false, reason: (errObj as Error).message.slice(0, 300) }, 502);
    }
  });

  // ---------- AI 连接 ----------
  routes.get("/connection/ai", (c) => {
    return c.json({
      baseUrl: getSetting(db, "ai.baseUrl"),
      model: getSetting(db, "ai.model"),
      apiKeySet: getSetting(db, "ai.apiKeyEnc") !== null,
    });
  });

  routes.put("/connection/ai", async (c) => {
    const body = await readJson<{ baseUrl?: unknown; model?: unknown; apiKey?: unknown }>(c);
    if (isErr(body)) return fail(c, body);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim().slice(0, 100) : "";
    if (!isHttpUrl(baseUrl)) return fail(c, err("invalid_request", "baseUrl 必须是 http(s) URL", 400));
    if (!model) return fail(c, err("invalid_request", "model 必填", 400));
    setSetting(db, "ai.baseUrl", baseUrl);
    setSetting(db, "ai.model", model);
    if (typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
      setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, body.apiKey.trim()));
    }
    return c.json({ ok: true, apiKeySet: getSetting(db, "ai.apiKeyEnc") !== null });
  });

  routes.post("/connection/ai/test", async (c) => {
    const r = await deps.ai.test();
    return r.ok ? c.json(r) : c.json(r, 502);
  });

  routes.post("/connection/ai/test-vision", async (c) => {
    const r = await deps.ai.testVision();
    return r.ok ? c.json(r) : c.json(r, 502);
  });

  // ---------- 反馈列表与详情 ----------
  routes.get("/feedback", (c) => {
    const statusQ = c.req.query("status");
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const r = listFeedbacks(db, {
      status: (STATUSES as string[]).includes(statusQ ?? "") ? (statusQ as FeedbackStatus) : undefined,
      appId: c.req.query("appId") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit,
    });
    return c.json({ items: r.items.map(toAdminListItem), nextCursor: r.nextCursor });
  });

  routes.get("/feedback/:id", (c) => {
    const row = getFeedback(db, c.req.param("id"));
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));
    let processed = null;
    if (row.processed_json) {
      try {
        processed = JSON.parse(row.processed_json);
      } catch {
        processed = null;
      }
    }
    let context = null;
    if (row.context_json) {
      try {
        context = JSON.parse(row.context_json);
      } catch {
        context = null;
      }
    }
    const screenshotMeta = getFeedbackScreenshotMeta(db, row.id);
    return c.json({
      ...toAdminListItem(row),
      text: row.text,
      context,
      processed,
      kaneoTaskId: row.kaneo_task_id,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      recovery: recoveryInfo(db, row),
      screenshot: screenshotMeta
        ? {
            width: screenshotMeta.width,
            height: screenshotMeta.height,
            byteSize: screenshotMeta.byte_size,
            sha256: screenshotMeta.sha256,
            capture: screenshotMeta.capture,
            createdAt: screenshotMeta.created_at,
          }
        : null,
    });
  });

  routes.get("/feedback/:id/screenshot", (c) => {
    const screenshot = getFeedbackScreenshot(db, c.req.param("id"));
    if (!screenshot) return fail(c, err("not_found", "截图不存在", 404));
    return new Response(screenshot.png_blob as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-length": String(screenshot.byte_size),
      },
    });
  });

  return routes;
}

const STATUSES: string[] = ["received", "processing", "archiving", "needs_review", "archived", "failed"];

/** 动作的目标说明（管理页展示：针对图片还是评论）。 */
const ACTION_TARGETS: Record<string, string> = {
  retry: "处理流程",
  recheck: "任务核对",
  "force-create": "任务创建",
  retry_comment: "评论",
  replace_upload: "图片",
};

/**
 * 动作风险说明。retry_comment 即使先查重也仍可能产生重复评论（远端列表与写入之间存在竞态），
 * 管理页必须把这一点明确展示给操作人。
 */
const ACTION_NOTES: Record<string, string> = {
  retry_comment:
    "重发前会先按反馈 ID + 截图摘要查重，只有未命中才会发送一次；但远端列表与写入之间存在竞态，仍可能产生重复评论，请在 Kaneo 中复核。",
  replace_upload: "会申请新上传地址并复用原任务替换图片；旧对象与旧 key 记录保留，不自动删除远端文件。",
  recheck: "只读取远端结果并确认，不会重发任何评论或图片。",
  "force-create": "仅在确认 Kaneo 中不存在对应任务时使用，可能产生重复任务。",
};

/**
 * 4.4：当前允许的人工动作（管理页据此只显示可用操作并说明目标）。
 * - failed → retry；
 * - needs_review → recheck 恒可用；已有 task ID 且资产已知 → retry_comment；
 *   已有 task ID 且有截图 → replace_upload（**过期/被拒绝的上传的唯一出路**，不要求资产已知）；
 *   仅当任务创建结果未知且无任何已知 task/附件状态 → force-create。
 */
function recoveryInfo(db: Db, row: FeedbackRow) {
  const parsed = parseArchiveData(row.archive_data_json);
  const revision = parsed.kind === "valid" ? parsed.data.revision : 0;
  const uploadOutcome = parsed.kind === "valid" ? (parsed.data.upload?.outcome ?? null) : null;
  const assetKnown = parsed.kind === "valid" ? Boolean(parsed.data.asset?.url) : false;
  const commentOutcome = parsed.kind === "valid" ? (parsed.data.comment?.outcome ?? null) : null;
  const hasKnownTask = Boolean(row.kaneo_task_id);
  const knownAttachment =
    parsed.kind === "valid" && Boolean(parsed.data.upload || parsed.data.asset || parsed.data.comment);
  const hasScreenshot = getFeedbackScreenshotMeta(db, row.id) !== null;

  const allowedActions: string[] = [];
  if (row.status === "failed") allowedActions.push("retry");
  if (row.status === "needs_review") {
    allowedActions.push("recheck");
    if (!hasKnownTask && !knownAttachment) allowedActions.push("force-create");
    if (hasKnownTask && assetKnown) allowedActions.push("retry_comment");
    if (hasKnownTask && hasScreenshot) allowedActions.push("replace_upload");
  }
  return {
    revision,
    stage: row.archive_stage,
    uploadOutcome,
    assetKnown,
    commentOutcome,
    hasScreenshot,
    allowedActions,
    actionTargets: ACTION_TARGETS,
    actionNotes: ACTION_NOTES,
  };
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function deleteSetting(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
