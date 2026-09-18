import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createRateLimiter, type RateLimiter } from "../auth/ratelimit.ts";
import {
  type Db,
  getFeedback,
  getFeedbackLog,
  getFeedbackLogsMeta,
  getFeedbackScreenshot,
  getFeedbackScreenshotMeta,
} from "../db/repos.ts";
import { checkLimiter, type Err, err, fail, readBearer } from "../http.ts";

/**
 * Assist 接入只读回连路由（contracts/feedback-integration.md §5）。
 *
 * 仅 GET、仅中枢回连：Bearer 恒定时间校验 + 每密钥 60 次/分限流；
 * 全部鉴权失败统一 401，已彻底删除与不存在统一 404（读接口不区分 gone）。
 * 由挂载方保证「接入开启且存在可用密钥」才挂载本组。
 */

/** Bearer 恒定时间比较（两侧先各自 sha256，避免长度差异泄露）。 */
function keyEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface AssistRouteDeps {
  db: Db;
  /** 回连密钥：FEEDBACK_ASSIST_READ_KEY（缺省回退 SOURCE_KEY，由挂载方解析）。 */
  readKey: string;
  /** 测试可注入；默认 60 次/分。 */
  limiter?: RateLimiter;
}

export function assistRoutes(deps: AssistRouteDeps): Hono {
  const { db } = deps;
  const limiter = deps.limiter ?? createRateLimiter(60, 60 * 1000);
  const routes = new Hono();

  // 本组全部端点：恒定时间 Bearer 校验，然后限流；鉴权失败一律 401。
  routes.use("*", async (c, next) => {
    const token = readBearer(c);
    if (token === null || !keyEqual(token, deps.readKey)) {
      return fail(c, err("unauthorized", "需要认证", 401));
    }
    const limited = checkLimiter(limiter, "assist-read");
    if (limited) {
      c.header("retry-after", String((limited as Err & { retryAfter?: number }).retryAfter ?? 60));
      return fail(c, limited);
    }
    await next();
  });

  // 反馈详情：状态机当前值 + 附件元数据清单（供中枢拉取附件前的探测）。
  routes.get("/feedback/:id", (c) => {
    const row = getFeedback(db, c.req.param("id"));
    if (!row) return fail(c, err("not_found", "反馈不存在", 404));
    const logs = getFeedbackLogsMeta(db, row.id);
    const hasScreenshot = getFeedbackScreenshotMeta(db, row.id) !== null;
    return c.json({
      id: row.id,
      appId: row.app_id,
      status: row.status,
      title: row.title,
      text: row.text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorSummary: row.error_summary,
      hasScreenshot,
      logs: logs.map((l) => ({
        id: l.id,
        filename: l.filename,
        byteSize: l.byte_size,
        sha256: l.sha256,
        source: l.source,
      })),
    });
  });

  // 截图附件：image/png + Content-Length + ETag（sha256 即内容指纹）。
  routes.get("/feedback/:id/attachments/screenshot", (c) => {
    const shot = getFeedbackScreenshot(db, c.req.param("id"));
    if (!shot) return fail(c, err("not_found", "截图不存在", 404));
    return new Response(shot.png_blob as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(shot.byte_size),
        etag: `"${shot.sha256}"`,
        "cache-control": "no-store",
      },
    });
  });

  // 日志附件：octet-stream 下载（与既有管理端下载一致的 Content-Disposition）。
  // 不属于该反馈的日志同样 404，不区分「不存在」与「别人的」。
  routes.get("/feedback/:id/attachments/logs/:logId", (c) => {
    const log = getFeedbackLog(db, c.req.param("id"), c.req.param("logId"));
    if (!log) return fail(c, err("not_found", "日志附件不存在", 404));
    const safeFilename = encodeURIComponent(log.filename).replace(/['()]/g, escape);
    return new Response(log.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${log.filename}"; filename*=UTF-8''${safeFilename}`,
        "content-length": String(log.byte_size),
        "cache-control": "no-store",
      },
    });
  });

  return routes;
}
