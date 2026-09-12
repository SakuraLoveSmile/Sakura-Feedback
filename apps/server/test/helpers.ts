import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type FeedbackApp } from "../src/app.ts";
import type { ServerConfig } from "../src/env.ts";
import type { AiClient } from "../src/services/ai.ts";
import {
  type KaneoClient,
  type KaneoColumn,
  KaneoColumnNotFound,
  KaneoDefiniteError,
  type KaneoSettings,
  type KaneoTaskRef,
  KaneoUncertainError,
} from "../src/services/kaneo.ts";
import type { ProcessedFeedback } from "../src/types.ts";

export const TEST_PASSWORD = "hunter2-correct-horse";

export interface MockAiBehavior {
  /** 每次调用返回 outcome；数组耗尽后重复最后一项。 */
  outcomes?: Array<"ok" | "timeout" | "invalid" | "auth">;
}

export function makeProcessed(title = "整理后的标题"): ProcessedFeedback {
  return {
    title,
    sections: {
      experience: "整体体验流畅",
      problems: "同步偶尔失败",
      suggestions: "增加离线模式",
      questions: "",
    },
  };
}

export function makeMockAi(behavior: MockAiBehavior = {}): AiClient & {
  calls: number;
  lastImage: Parameters<AiClient["organize"]>[1];
  lastLogs: Parameters<AiClient["organize"]>[2];
} {
  const outcomes = behavior.outcomes ?? ["ok"];
  const ai = {
    calls: 0,
    lastImage: null as Parameters<AiClient["organize"]>[1],
    lastLogs: null as Parameters<AiClient["organize"]>[2],
    async organize(
      _text: string,
      image?: Parameters<AiClient["organize"]>[1],
      logs?: Parameters<AiClient["organize"]>[2],
    ): Promise<ProcessedFeedback> {
      ai.lastImage = image ?? null;
      ai.lastLogs = logs ?? null;
      const outcome = outcomes[Math.min(ai.calls, outcomes.length - 1)] ?? "ok";
      ai.calls++;
      switch (outcome) {
        case "ok":
          return makeProcessed();
        case "timeout": {
          const { AiError } = await import("../src/services/ai.ts");
          throw new AiError("timeout", "AI 请求超时", true);
        }
        case "invalid": {
          const { AiError } = await import("../src/services/ai.ts");
          throw new AiError("invalid_output", "AI 输出格式校验失败", true);
        }
        case "auth": {
          const { AiError } = await import("../src/services/ai.ts");
          throw new AiError("auth", "AI 密钥无效", false);
        }
      }
    },
    async test() {
      return { ok: true, reply: "ping" };
    },
    async testVision() {
      return { ok: true, reply: "视觉连接测试成功" };
    },
  };
  return ai;
}

export interface MockKaneoOptions {
  columns?: KaneoColumn[];
  /** 搜索命中的预置任务。 */
  searchHit?: { taskId: string };
  existingTasks?: Array<{ taskId: string; description: string }>;
}

export type KaneoFail = "column-not-found" | "definite" | "uncertain" | "access-denied";

export interface MockKaneo extends KaneoClient {
  created: Array<{ projectId: string; columnSlug: string; title: string; description: string }>;
  comments: Array<{ taskId: string; content: string }>;
  uploads: Array<{ taskId: string; bytes: Buffer | Uint8Array }>;
  finalizes: Array<{ taskId: string; key: string }>;
  /** 每次 finalize 的完整入参（断言日志文件名/大小走上同一条资产链路）。 */
  finalizeInputs: Array<{ taskId: string; key: string; filename: string; contentType: string; size: number }>;
  /** 每 task 的预签名申请序号（生成唯一 key/地址）。 */
  presignSeq: Map<string, number>;
  /** findByFeedbackId 搜索调用次数（断言“优先已有 task ID 时不搜索”）。 */
  searches: number;
  /** 依次出队；空则成功。测试可 push/splice 控制后续行为。 */
  createErrorQueue: KaneoFail[];
  testError: string | null;
  listError: string | null;
  /** 每次 bind(settings) 的入参（断言“配置在操作开始时固定一次”）。 */
  boundSettings: KaneoSettings[];
  /** 全部远端调用次数（含只读请求）。 */
  remoteCalls: number;
  /** 远端**写入**调用次数（创建任务/申请地址/传字节/finalize/评论；断言“目标改变时零远端写入”）。 */
  remoteWrites: number;
}

export function makeMockKaneo(opts: MockKaneoOptions = {}): MockKaneo {
  const created: MockKaneo["created"] = [];
  const comments: MockKaneo["comments"] = [];
  const uploads: MockKaneo["uploads"] = [];
  const finalizes: MockKaneo["finalizes"] = [];
  const finalizeInputs: MockKaneo["finalizeInputs"] = [];
  /** assetUrl → uploadUrl：同一 task 上多份附件（截图/日志）各自独立。 */
  const assetUploadUrl = new Map<string, string>();
  const presignSeq = new Map<string, number>();
  let searches = 0;
  const columns = opts.columns ?? [{ id: "col-db-id", slug: "triage", name: "待筛选" }];
  let existing = opts.existingTasks ?? [];
  let remoteCalls = 0;
  let remoteWrites = 0;
  const count = (): void => {
    remoteCalls++;
  };
  const countWrite = (): void => {
    remoteCalls++;
    remoteWrites++;
  };
  const boundSettings: KaneoSettings[] = [];
  const mock: MockKaneo = {
    created,
    comments,
    uploads,
    finalizes,
    finalizeInputs,
    presignSeq,
    boundSettings,
    get remoteCalls() {
      return remoteCalls;
    },
    get remoteWrites() {
      return remoteWrites;
    },
    get searches() {
      return searches;
    },
    createErrorQueue: [],
    testError: null,
    listError: null,
    bind(settings: KaneoSettings) {
      boundSettings.push(settings);
      if (this !== null && typeof this === "object" && "created" in this) {
        return this as MockKaneo;
      }
      return mock;
    },
    async listProjects() {
      count();
      if (mock.listError !== null) throw new KaneoDefiniteError(mock.listError);
      return {
        workspaces: [{ id: "ws-1", name: "默认工作区" }],
        projects: [{ id: "proj-1", workspaceId: "ws-1", name: "测试项目", slug: "TST" }],
      };
    },
    async test(projectId: string) {
      count();
      if (mock.testError !== null) throw new KaneoDefiniteError(mock.testError);
      return {
        project: { id: projectId, name: "测试项目", workspaceId: "ws-1", slug: "TST" },
        columns,
      };
    },
    async getProjectInfo(projectId: string) {
      count();
      if (mock.testError !== null) throw new KaneoDefiniteError(mock.testError);
      return { id: projectId, workspaceId: "ws-1", name: "测试项目", slug: "TST" };
    },
    async createTask(input) {
      countWrite();
      const failKind = mock.createErrorQueue.shift() ?? null;
      if (failKind === "column-not-found") throw new KaneoColumnNotFound("列不存在");
      if (failKind === "definite") throw new KaneoDefiniteError("Kaneo 拒绝创建 (403)");
      if (failKind === "uncertain") throw new KaneoUncertainError("连接中断");
      if (failKind === "access-denied") throw new KaneoDefiniteError("认证失败 (401)");
      created.push(input);
      const taskId = `task-${created.length}`;
      existing = [...existing, { taskId, description: input.description }];
      return {
        taskId,
        taskUrl: `http://kaneo.test/dashboard/workspace/ws-1/project/${input.projectId}/task/${taskId}`,
      };
    },
    async findByFeedbackId(projectId: string, feedbackId: string): Promise<KaneoTaskRef | null> {
      count();
      searches++;
      if (opts.searchHit) {
        return {
          taskId: opts.searchHit.taskId,
          taskUrl: `http://kaneo.test/dashboard/workspace/ws-1/project/${projectId}/task/${opts.searchHit.taskId}`,
        };
      }
      const hit = existing.find((t) => t.description.includes(`**反馈ID**：${feedbackId}`));
      return hit
        ? {
            taskId: hit.taskId,
            taskUrl: `http://kaneo.test/dashboard/workspace/ws-1/project/${projectId}/task/${hit.taskId}`,
          }
        : null;
    },
    async createImageUpload(taskId, _input) {
      countWrite();
      // 同一任务多次申请预签名时生成不同 key/地址（用于“过期换新 key”恢复断言）
      const seq = (mock.presignSeq.get(taskId) ?? 0) + 1;
      mock.presignSeq.set(taskId, seq);
      const suffix = seq === 1 ? "" : `-${seq}`;
      return {
        key: `key-${taskId}${suffix}`,
        uploadUrl: `http://kaneo.test/upload/${taskId}${suffix}`,
        headers: { "content-type": "image/png" },
      };
    },
    async uploadImageToPresigned(uploadUrl, _headers, bytes) {
      countWrite();
      mock.uploads.push({ taskId: uploadUrl, bytes });
    },
    async finalizeImageUpload(taskId, input) {
      countWrite();
      finalizes.push({ taskId, key: input.key });
      finalizeInputs.push({
        taskId,
        key: input.key,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
      });
      // 首份附件保持历史命名（asset-<taskId>），后续附件按预签名序号区分，
      // 使同一 task 上的截图与多份日志各自拥有独立资产（可分别核对字节）。
      const suffix = input.key.replace(`key-${taskId}`, "");
      const assetUrl = `http://kaneo.test/assets/asset-${taskId}${suffix}.png`;
      assetUploadUrl.set(assetUrl, `http://kaneo.test/upload/${taskId}${suffix}`);
      return { id: `asset-${taskId}${suffix}`, url: assetUrl };
    },
    async createComment(taskId, input) {
      countWrite();
      mock.comments.push({ taskId, content: input.content });
      return { id: `comment-${mock.comments.length}` };
    },
    async listComments(taskId) {
      count();
      return mock.comments.filter((c) => c.taskId === taskId).map((c, i) => ({ id: `comm-${i}`, content: c.content }));
    },
    async downloadAsset(assetUrl: string): Promise<Uint8Array> {
      count();
      const uploadUrl = assetUploadUrl.get(assetUrl) ?? assetUrl;
      const hit = mock.uploads.find((u) => u.taskId === uploadUrl) ?? mock.uploads.find((u) => u.taskId === assetUrl);
      if (!hit) throw new KaneoDefiniteError("资产下载返回 404（不能直接证明文件不存在）");
      return new Uint8Array(hit.bytes);
    },
  };
  return mock;
}

export const instantSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 2)));

export interface TestSetup {
  feedbackApp: FeedbackApp;
  config: ServerConfig;
  cookie: string; // 登录后的 admin cookie，由 loginAsAdmin 填充
}

export function makeConfig(): ServerConfig {
  const dataDir = mkdtempSync(path.join(tmpdir(), "feedback-test-"));
  return {
    port: 0,
    dataDir,
    masterKey: Buffer.alloc(32, 7),
    adminUser: "admin",
    adminPassword: TEST_PASSWORD,
    cookieSecure: false,
    publicUrl: null,
    adminDist: null,
    sessionTtlMs: 3600_000,
    clientTokenTtlMs: 3600_000,
    handshakeTtlMs: 900_000,
  };
}

/** 创建带 mock 外部依赖的 app。 */
export function makeTestApp(
  overrides: { ai?: AiClient; kaneo?: KaneoClient; dataDir?: string } = {},
): FeedbackApp & { config: ServerConfig } {
  const config = makeConfig();
  if (overrides.dataDir) config.dataDir = overrides.dataDir;
  const feedbackApp = createApp(config, {
    ai: overrides.ai ?? makeMockAi(),
    kaneo: overrides.kaneo ?? makeMockKaneo(),
    workerSleep: instantSleep,
  });
  return { ...feedbackApp, config };
}

const BASE = "http://localhost";

export async function jsonReq(
  app: FeedbackApp["app"],
  method: string,
  url: string,
  init: { body?: unknown; cookie?: string; bearer?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: any; headers: Headers; text: string }> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  headers.origin = init.origin ?? BASE;
  const res = await app.request(`${BASE}${url}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, data, headers: res.headers, text };
}

/** 登录并返回 cookie 字符串。 */
export async function loginAsAdmin(feedbackApp: FeedbackApp, password = TEST_PASSWORD): Promise<string> {
  const r = await jsonReq(feedbackApp.app, "POST", "/api/auth/login", {
    body: { username: "admin", password },
  });
  if (r.status !== 200) throw new Error(`登录失败 ${r.status}: ${r.text}`);
  const raw = r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "";
  const cookie = raw.split(";")[0] ?? "";
  if (!cookie.startsWith("fb_session=")) throw new Error(`未获得会话 cookie: ${raw}`);
  return cookie;
}

/** 配置一个默认软件并返回其 public 对象。 */
export async function seedApp(
  feedbackApp: FeedbackApp,
  cookie: string,
  input: { appId?: string; origins?: string[] } = {},
): Promise<any> {
  const r = await jsonReq(feedbackApp.app, "POST", "/api/admin/apps", {
    cookie,
    body: {
      appId: input.appId ?? "com.test.app",
      name: "测试软件",
      allowedOrigins: input.origins ?? ["http://host.test"],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: "triage",
    },
  });
  if (r.status !== 201) throw new Error(`创建 app 失败 ${r.status}: ${r.text}`);
  return r.data;
}

/** 提交一条反馈并返回 { bearer }（通过 client 令牌）。 */
export async function loginAsClient(feedbackApp: FeedbackApp): Promise<string> {
  const r = await jsonReq(feedbackApp.app, "POST", "/api/auth/login", {
    body: { username: "admin", password: TEST_PASSWORD, clientLabel: "test-client" },
  });
  if (r.status !== 200) throw new Error(`client 登录失败 ${r.status}: ${r.text}`);
  return r.data.token as string;
}

export async function submitFeedback(feedbackApp: FeedbackApp, bearer: string, body: Record<string, unknown>) {
  return jsonReq(feedbackApp.app, "POST", "/api/feedback", { bearer, body });
}

export interface Harness {
  feedbackApp: FeedbackApp;
  config: ServerConfig;
  ai: ReturnType<typeof makeMockAi>;
  kaneo: MockKaneo;
  cookie: string;
  bearer: string;
  /** 建好默认软件 com.test.app（列 triage），返回其 public 对象。 */
  app: any;
}

export async function makeHarness(
  opts: {
    aiOutcomes?: MockAiBehavior["outcomes"];
    kaneo?: MockKaneoOptions;
    seedAppOver?: { appId?: string; origins?: string[]; columnSlug?: string };
  } = {},
): Promise<Harness> {
  const config = makeConfig();
  const ai = makeMockAi({ outcomes: opts.aiOutcomes ?? ["ok"] });
  const kaneo = makeMockKaneo(opts.kaneo);
  const feedbackApp = createApp(config, { ai, kaneo, workerSleep: instantSleep });
  const cookie = await loginAsAdmin(feedbackApp);
  await seedConnections(feedbackApp, cookie);
  const publicApp = await seedAppWithColumn(feedbackApp, cookie, opts.seedAppOver);
  const bearer = await loginAsClient(feedbackApp);
  return { feedbackApp, config, ai, kaneo, cookie, bearer, app: publicApp };
}

/** 写入 Kaneo/AI 连接配置（worker 归档前置检查依赖 settings 存在）。 */
export async function seedConnections(feedbackApp: FeedbackApp, cookie: string): Promise<void> {
  const k = await jsonReq(feedbackApp.app, "PUT", "/api/admin/connection/kaneo", {
    cookie,
    body: { baseUrl: "http://kaneo.test/api", apiKey: "test-key" },
  });
  if (k.status !== 200) throw new Error(`seed kaneo 失败 ${k.status}: ${k.text}`);
  const a = await jsonReq(feedbackApp.app, "PUT", "/api/admin/connection/ai", {
    cookie,
    body: { baseUrl: "https://ai.test/v1", model: "test", apiKey: "test-key" },
  });
  if (a.status !== 200) throw new Error(`seed ai 失败 ${a.status}: ${a.text}`);
}

async function seedAppWithColumn(
  feedbackApp: FeedbackApp,
  cookie: string,
  over: { appId?: string; origins?: string[]; columnSlug?: string } = {},
) {
  const r = await jsonReq(feedbackApp.app, "POST", "/api/admin/apps", {
    cookie,
    body: {
      appId: over.appId ?? "com.test.app",
      name: "测试软件",
      allowedOrigins: over.origins ?? ["http://host.test"],
      kaneoProjectId: "proj-1",
      kaneoColumnSlug: over.columnSlug ?? "triage",
    },
  });
  if (r.status !== 201) throw new Error(`创建 app 失败 ${r.status}: ${r.text}`);
  return r.data;
}

export function defaultSubmitBody(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    appId: "com.test.app",
    text: "导出 CSV 卡住了，希望支持后台导出",
    context: { appVersion: "1.2.3", pageLabel: "export" },
    ...over,
  };
}

export async function createTestPng(width = 100, height = 100): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 50, g: 100, b: 150, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

export interface MultipartLogPart {
  name: string;
  bytes: Buffer | Uint8Array | string;
  /** 覆盖 metadata.logs 里的 source（默认 auto；仅测试非法来源时改动）。 */
  source?: unknown;
  /** 覆盖 metadata.logs 里的 name（默认取 name）。 */
  metaName?: string;
  /** 覆盖部件 filename（默认取 name；传 null 表示不带 filename）。 */
  partFilename?: string | null;
  /** 覆盖 metadata.logs 里的 byteSize（默认按字节数；传 null 表示省略该字段）。 */
  metaByteSize?: number | null;
}

/**
 * 构造 multipart 提交。metadata.logs 在提供 logs 时自动生成，
 * 也可用 metadataLogsRaw 完全接管（用于构造数量/结构不匹配的非法请求）。
 */
export async function submitMultipartFeedback(
  feedbackApp: FeedbackApp,
  bearer: string,
  metadata: Record<string, unknown>,
  screenshotBuffer?: Buffer,
  logs?: MultipartLogPart[],
  metadataLogsRaw?: unknown,
) {
  const boundary = `----FeedbackTestBoundary${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  const meta: Record<string, unknown> = { ...metadata };
  if (logs) {
    meta.logs =
      metadataLogsRaw !== undefined
        ? metadataLogsRaw
        : logs.map((l) => {
            const entry: Record<string, unknown> = {
              name: l.metaName ?? l.name,
              source: l.source ?? "auto",
            };
            if (l.metaByteSize !== null) {
              entry.byteSize =
                l.metaByteSize ?? (typeof l.bytes === "string" ? Buffer.byteLength(l.bytes) : l.bytes.byteLength);
            }
            return entry;
          });
  } else if (metadataLogsRaw !== undefined) {
    meta.logs = metadataLogsRaw;
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
        meta,
      )}\r\n`,
    ),
  );

  if (screenshotBuffer) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(screenshotBuffer);
    parts.push(Buffer.from("\r\n"));
  }

  for (const log of logs ?? []) {
    const filename = log.partFilename === undefined ? log.name : log.partFilename;
    const disposition =
      filename === null
        ? `Content-Disposition: form-data; name="logs"`
        : `Content-Disposition: form-data; name="logs"; filename="${filename}"`;
    parts.push(Buffer.from(`--${boundary}\r\n${disposition}\r\nContent-Type: text/plain\r\n\r\n`));
    parts.push(typeof log.bytes === "string" ? Buffer.from(log.bytes, "utf8") : Buffer.from(log.bytes));
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const res = await feedbackApp.app.request("/api/feedback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}
