import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { UpdaterConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { checkProtocolCompat, isDigest, isSemver, type ManifestPort } from "./manifest.ts";
import { createTaskRecord, type TaskRecord, type TaskStorePort } from "./state.ts";
import { type TokenSet, tokenMatches } from "./token.ts";
import { UPDATER_PROTOCOL_VERSION, UPDATER_VERSION } from "./version.ts";

export interface TaskRunner {
  run(task: TaskRecord): Promise<TaskRecord>;
  isBusy(): boolean;
}

export interface HttpDeps {
  config: UpdaterConfig;
  tokens: TokenSet;
  store: TaskStorePort;
  manifest: ManifestPort;
  engine: TaskRunner;
  log: Logger;
  clock?: () => Date;
  randomId?: () => string;
  /** 后台启动任务的钩子（默认 setImmediate）。 */
  schedule?: (task: () => void) => void;
  bodyLimitBytes?: number;
}

export interface UpdaterServer {
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SUPPORTED_CHANNELS = new Set(["stable"]);
const ALLOWED_TASK_FIELDS = new Set(["requestId", "version", "digest"]);

export interface TaskRequest {
  requestId: string;
  version: string;
  digest: string;
}

export type ValidationResult = { ok: true; value: TaskRequest } | { ok: false; error: string; field: string | null };

/**
 * 客户端只允许提交 requestId/version/digest 三个字段。
 * compose 路径、命令、镜像名或卷名一律拒绝，执行器不做任何推测性解析。
 */
export function validateTaskRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "请求体必须是 JSON 对象", field: null };
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !ALLOWED_TASK_FIELDS.has(key));
  if (extra.length > 0) {
    return {
      ok: false,
      error: `不接受字段：${extra.join(", ")}；只允许 requestId/version/digest，执行器只按预配置的项目、compose 文件、镜像与卷执行`,
      field: extra[0] ?? null,
    };
  }
  const requestId = record.requestId;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, error: "requestId 必须是 1..128 位的 [A-Za-z0-9._:-]", field: "requestId" };
  }
  const version = record.version;
  if (typeof version !== "string" || !isSemver(version)) {
    return { ok: false, error: "version 必须是 semver（例如 0.3.0）", field: "version" };
  }
  const digest = record.digest;
  if (typeof digest !== "string" || !isDigest(digest)) {
    return { ok: false, error: "digest 必须是 sha256:<64 位小写十六进制>", field: "digest" };
  }
  return { ok: true, value: { requestId, version, digest } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) {
      req.resume();
      return { ok: false, error: `请求体超过 ${limit} 字节` };
    }
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export function createUpdaterHttp(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, tokens, store, manifest, engine, log } = deps;
  const now = deps.clock ?? (() => new Date());
  const randomId = deps.randomId ?? (() => randomBytes(4).toString("hex"));
  const schedule = deps.schedule ?? ((task: () => void) => setImmediate(task));
  const bodyLimit = deps.bodyLimitBytes ?? MAX_BODY_BYTES;
  const startedAt = Date.now();

  const authorize = (req: IncomingMessage): boolean => {
    const header = req.headers["x-updater-token"];
    const candidate = Array.isArray(header) ? header[0] : header;
    return tokenMatches(tokens, candidate);
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";
    let status = 500;
    try {
      const parsed = new URL(rawUrl, "http://updater.local");
      const pathname = parsed.pathname;

      if (pathname === "/healthz") {
        if (method !== "GET" && method !== "HEAD") {
          status = 405;
          sendJson(res, status, { error: "method_not_allowed" });
          return;
        }
        status = 200;
        sendJson(res, status, {
          ok: true,
          version: UPDATER_VERSION,
          protocolVersion: UPDATER_PROTOCOL_VERSION,
          busy: engine.isBusy(),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
        return;
      }

      if (!authorize(req)) {
        status = 401;
        sendJson(res, status, { error: "unauthorized", hint: "需要请求头 x-updater-token（共享令牌来自控制目录）" });
        return;
      }

      if (pathname === "/tasks" && method === "POST") {
        status = await handleCreateTask(req, res);
        return;
      }
      if (pathname === "/tasks" && method !== "POST") {
        status = 405;
        sendJson(res, status, { error: "method_not_allowed", allow: "POST" });
        return;
      }
      const taskMatch = /^\/tasks\/([^/]+)$/.exec(pathname);
      if (taskMatch?.[1]) {
        if (method !== "GET") {
          status = 405;
          sendJson(res, status, { error: "method_not_allowed", allow: "GET" });
          return;
        }
        const operationId = taskMatch[1];
        if (!OPERATION_ID_PATTERN.test(operationId)) {
          status = 400;
          sendJson(res, status, { error: "invalid_request", message: "operationId 非法" });
          return;
        }
        const record = await store.get(operationId);
        if (!record) {
          status = 404;
          sendJson(res, status, { error: "not_found", operationId });
          return;
        }
        status = 200;
        sendJson(res, status, record);
        return;
      }
      if (pathname === "/manifest") {
        if (method !== "GET") {
          status = 405;
          sendJson(res, status, { error: "method_not_allowed", allow: "GET" });
          return;
        }
        const channel = parsed.searchParams.get("channel") ?? "stable";
        if (!SUPPORTED_CHANNELS.has(channel)) {
          status = 400;
          sendJson(res, status, { error: "unsupported_channel", channel, supported: [...SUPPORTED_CHANNELS] });
          return;
        }
        const outcome = await manifest.load(channel);
        if (outcome.kind === "ok") {
          status = 200;
          sendJson(res, status, outcome.manifest);
          return;
        }
        status = 502;
        sendJson(res, status, {
          error: `manifest_${outcome.kind}`,
          message:
            outcome.kind === "invalid"
              ? `${outcome.location}: ${outcome.error}`
              : outcome.kind === "unreachable"
                ? `${outcome.url}: ${outcome.error}`
                : "未找到 release-manifest.json（部署目录或控制目录）",
        });
        return;
      }

      status = 404;
      sendJson(res, status, { error: "not_found", path: pathname });
    } catch (err) {
      status = 500;
      log.error("请求处理失败", { error: (err as Error).message });
      if (!res.headersSent) sendJson(res, status, { error: "internal_error" });
    } finally {
      log.info("http", { method, path: rawUrl.split("?")[0], status, durationMs: Date.now() - started });
    }
  };

  async function handleCreateTask(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const body = await readBody(req, bodyLimit);
    if (!body.ok) {
      sendJson(res, 400, { error: "invalid_request", message: body.error });
      return 400;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      sendJson(res, 400, { error: "invalid_request", message: "请求体不是合法 JSON" });
      return 400;
    }
    const validation = validateTaskRequest(parsed);
    if (!validation.ok) {
      log.warn("拒绝非法更新请求", { field: validation.field });
      sendJson(res, 400, { error: "invalid_request", message: validation.error, field: validation.field });
      return 400;
    }
    const request = validation.value;

    const existing = await store.findByRequestId(request.requestId);
    if (existing) {
      sendJson(res, 202, {
        operationId: existing.operationId,
        status: existing.status,
        deduplicated: true,
      });
      return 202;
    }
    const running = await store.findRunning();
    if (running) {
      sendJson(res, 409, {
        error: "conflict",
        message: "已有更新任务在执行，拒绝并发更新",
        operationId: running.operationId,
        phase: running.phase,
      });
      return 409;
    }

    const outcome = await manifest.load("stable");
    if (outcome.kind !== "ok") {
      const message =
        outcome.kind === "invalid"
          ? `版本清单非法（${outcome.location}）：${outcome.error}`
          : outcome.kind === "unreachable"
            ? `版本清单不可达（${outcome.url}）：${outcome.error}`
            : "未找到版本清单 release-manifest.json，拒绝更新";
      sendJson(res, 409, { error: `manifest_${outcome.kind}`, message });
      return 409;
    }
    const compat = checkProtocolCompat(outcome.manifest, config.protocolVersion);
    if (!compat.compatible) {
      log.warn("拒绝更新：协议不兼容", { required: compat.required, supported: compat.supported });
      sendJson(res, 409, {
        error: "updater_protocol_incompatible",
        message: compat.guidance,
        required: compat.required,
        supported: compat.supported,
      });
      return 409;
    }

    const created = now();
    const stamp = created
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const operationId = `op-${stamp}-${randomId()}`;
    const record = createTaskRecord({
      operationId,
      requestId: request.requestId,
      version: request.version,
      digest: request.digest,
      now: created,
    });
    // 先落盘再返回 202：进程随后崩溃也能被重启核对看到
    await store.create(record);
    log.info("受理更新任务", {
      operationId,
      requestId: request.requestId,
      version: request.version,
      digest: request.digest,
      manifestSource: outcome.source,
    });
    sendJson(res, 202, { operationId, status: record.status, phase: record.phase });
    schedule(() => {
      void engine.run(record).catch((err: unknown) => {
        log.error("任务执行异常", { operationId, error: (err as Error).message });
      });
    });
    return 202;
  }
}

export function startUpdaterServer(deps: HttpDeps): Promise<UpdaterServer> {
  const handler = createUpdaterHttp(deps);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      deps.log.error("请求处理异常", { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal_error"}\n');
      }
    });
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  const { listenHost, listenPort } = deps.config;
  return new Promise<UpdaterServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
