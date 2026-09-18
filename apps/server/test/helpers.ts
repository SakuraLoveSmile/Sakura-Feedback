import { mkdtempSync, rmSync } from "node:fs";
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
  /** 工作区级标签（fixture 默认提供一个，便于分类归档断言）。 */
  labels?: Array<{ id: string; name: string; color?: string }>;
  /** 工作区成员（可选负责人）。 */
  members?: Array<{ id: string; name: string; email?: string; role?: string }>;
}

export type KaneoFail = "column-not-found" | "definite" | "uncertain" | "access-denied";

export interface MockKaneo extends KaneoClient {
  created: Array<{ projectId: string; columnSlug: string; title: string; description: string; userId?: string }>;
  comments: Array<{ taskId: string; content: string }>;
  uploads: Array<{ taskId: string; bytes: Buffer | Uint8Array }>;
  finalizes: Array<{ taskId: string; key: string }>;
  assetUrlToBytes: Map<string, Buffer | Uint8Array>;
  /** 每 task 的预签名申请序号（生成唯一 key/地址）。 */
  presignSeq: Map<string, number>;
  /** findByFeedbackId 搜索调用次数（断言“优先已有 task ID 时不搜索”）。 */
  searches: number;
  /** 依次出队；空则成功。测试可 push/splice 控制后续行为。 */
  createErrorQueue: KaneoFail[];
  /** 标签关联失败队列（"definite" | "uncertain"）。 */
  labelErrorQueue: Array<"definite" | "uncertain">;
  /** 已成功后端关联的标签记录。 */
  labelAttaches: Array<{ labelId: string; taskId: string }>;
  /** 覆盖工作区级标签（模拟标签在授权后被删除/改名）。 */
  setWorkspaceLabels(labels: Array<{ id: string; name: string; color?: string }>): void;
  testError: string | null;
  listError: string | null;
  /**
   * 只读目标读取的故障注入（自动归档的阻塞原因分类用）：
   * `definite` = 业务拒绝（配置问题），`uncertain` = 连接类故障（可恢复，需退避）。
   */
  readError: { kind: "definite" | "uncertain"; message: string } | null;
  /** 每次 bind(settings) 的入参（断言“配置在操作开始时固定一次”）。 */
  boundSettings: KaneoSettings[];
  /** 全部远端调用次数（含只读请求）。 */
  remoteCalls: number;
  /** 远端**写入**调用次数（创建任务/申请地址/传字节/finalize/评论/标签；断言“目标改变时零远端写入”）。 */
  remoteWrites: number;
}

/** 按注入的故障类型抛出对应的 Kaneo 错误（区分“配置问题”与“可恢复故障”）。 */
function throwReadError(err: { kind: "definite" | "uncertain"; message: string }): never {
  if (err.kind === "uncertain") throw new KaneoUncertainError(err.message);
  throw new KaneoDefiniteError(err.message);
}

export function makeMockKaneo(opts: MockKaneoOptions = {}): MockKaneo {
  const created: MockKaneo["created"] = [];
  const comments: MockKaneo["comments"] = [];
  const uploads: MockKaneo["uploads"] = [];
  const finalizes: MockKaneo["finalizes"] = [];
  const labelAttaches: MockKaneo["labelAttaches"] = [];
  const presignSeq = new Map<string, number>();
  let searches = 0;
  const columns = opts.columns ?? [{ id: "col-db-id", slug: "triage", name: "待筛选" }];
  // 工作区级标签（taskId 为 null）：可选项来源；关联到任务时 Kaneo 会新建任务级标签行。
  const workspaceLabelDefs = (opts.labels ?? [{ id: "label-bug", name: "bug", color: "#e11d48" }]).map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color ?? "#888888",
  }));
  const workspaceMembers = (opts.members ?? [{ id: "user-1", name: "负责人甲", email: "a@test", role: "member" }]).map(
    (m) => ({ id: m.id, name: m.name, email: m.email ?? `${m.id}@test`, role: m.role ?? "member" }),
  );
  // taskId → 已关联的任务级标签（含从工作区级标签复制而来的新行）。
  const taskLabels = new Map<string, Array<{ id: string; name: string; color: string }>>();
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
    labelErrorQueue: [],
    labelAttaches,
    setWorkspaceLabels(labels) {
      workspaceLabelDefs.length = 0;
      for (const l of labels) workspaceLabelDefs.push({ id: l.id, name: l.name, color: l.color ?? "#888888" });
    },
    testError: null,
    listError: null,
    readError: null,
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
    async listColumns(projectId: string) {
      count();
      if (mock.testError !== null) throw new KaneoDefiniteError(mock.testError);
      if (mock.readError !== null) throwReadError(mock.readError);
      return columns.map((c) => ({ ...c }));
    },
    async listWorkspaceLabels() {
      count();
      if (mock.testError !== null) throw new KaneoDefiniteError(mock.testError);
      if (mock.readError !== null) throwReadError(mock.readError);
      return workspaceLabelDefs.map((l) => ({ ...l, taskId: null, workspaceId: "ws-1" }));
    },
    async listTaskLabels(taskId: string) {
      count();
      return (taskLabels.get(taskId) ?? []).map((l) => ({ ...l, taskId, workspaceId: "ws-1" }));
    },
    async attachLabelToTask(labelId: string, taskId: string) {
      countWrite();
      const failKind = mock.labelErrorQueue.shift() ?? null;
      if (failKind === "definite") throw new KaneoDefiniteError("Kaneo 拒绝关联标签 (400)");
      if (failKind === "uncertain") throw new KaneoUncertainError("标签关联连接中断");
      const def = workspaceLabelDefs.find((l) => l.id === labelId);
      if (!def) throw new KaneoDefiniteError(`标签 ${labelId} 不存在`);
      const current = taskLabels.get(taskId) ?? [];
      labelAttaches.push({ labelId, taskId });
      const existingLabel = current.find((l) => l.name === def.name);
      if (existingLabel) {
        // Kaneo 对 (taskId, name) 幂等：重复关联返回既有任务级标签，不产生第二行。
        return { ...existingLabel, taskId, workspaceId: "ws-1" };
      }
      const createdLabel = { id: `tasklabel-${taskId}-${def.name}`, name: def.name, color: def.color };
      taskLabels.set(taskId, [...current, createdLabel]);
      return { ...createdLabel, taskId, workspaceId: "ws-1" };
    },
    async listWorkspaceMembers() {
      count();
      if (mock.testError !== null) throw new KaneoDefiniteError(mock.testError);
      if (mock.readError !== null) throwReadError(mock.readError);
      return workspaceMembers.map((m) => ({ ...m }));
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
      if (mock.readError !== null) throwReadError(mock.readError);
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
    assetUrlToBytes: new Map<string, Buffer | Uint8Array>(),
    async createImageUpload(taskId, input) {
      countWrite();
      // 同一任务多次申请预签名时生成不同 key/地址（用于“过期换新 key”恢复断言）
      const seq = (mock.presignSeq.get(taskId) ?? 0) + 1;
      mock.presignSeq.set(taskId, seq);
      const suffix = seq === 1 ? "" : `-${seq}`;
      const namePart = input?.filename && input.filename !== "screenshot.png" ? `-${input.filename}` : "";
      return {
        key: `key-${taskId}${namePart}${suffix}`,
        uploadUrl: `http://kaneo.test/upload/${taskId}${namePart}${suffix}`,
        headers: { "content-type": input?.contentType ?? "image/png" },
      };
    },
    async uploadImageToPresigned(uploadUrl, _headers, bytes) {
      countWrite();
      mock.uploads.push({ taskId: uploadUrl, bytes });
    },
    async finalizeImageUpload(taskId, input) {
      countWrite();
      finalizes.push({ taskId, key: input.key });
      const isScreenshot = input.filename === "screenshot.png";
      const assetUrl = isScreenshot
        ? `http://kaneo.test/assets/asset-${taskId}.png`
        : `http://kaneo.test/assets/asset-${taskId}-${input.key}.png`;
      const id = isScreenshot ? `asset-${taskId}` : `asset-${taskId}-${input.key}`;
      const matchedUpload =
        mock.uploads.find((u) => u.taskId.includes(input.key)) || mock.uploads[mock.uploads.length - 1];
      if (matchedUpload) {
        mock.assetUrlToBytes.set(assetUrl, matchedUpload.bytes);
      }
      return { id, url: assetUrl };
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
      const hitBytes = mock.assetUrlToBytes.get(assetUrl) ?? mock.uploads.find((u) => u.taskId === assetUrl)?.bytes;
      if (!hitBytes) throw new KaneoDefiniteError("资产下载返回 404（不能直接证明文件不存在）");
      return new Uint8Array(hitBytes);
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

/** 用 client 令牌登录（令牌模式需携带 appId；浏览器来源按该应用允许来源校验）。 */
export async function loginAsClient(
  feedbackApp: FeedbackApp,
  opts: { appId?: string; origin?: string } = {},
): Promise<string> {
  const r = await jsonReq(feedbackApp.app, "POST", "/api/auth/login", {
    origin: opts.origin ?? "http://host.test",
    body: {
      username: "admin",
      password: TEST_PASSWORD,
      clientLabel: "test-client",
      appId: opts.appId ?? "com.test.app",
    },
  });
  if (r.status !== 200) throw new Error(`client 登录失败 ${r.status}: ${r.text}`);
  return r.data.token as string;
}

export async function submitFeedback(
  feedbackApp: FeedbackApp,
  bearer: string,
  body: Record<string, unknown>,
  init: { origin?: string } = {},
) {
  return jsonReq(feedbackApp.app, "POST", "/api/feedback", {
    bearer,
    body,
    ...(init.origin ? { origin: init.origin } : {}),
  });
}

/**
 * 建一个额度充足的普通账号并返回其令牌：
 * 额度按账号计算，并发/批量提交类测试不能用共享的管理员账号。
 */
export async function createUserBearer(
  h: Harness,
  input: { username: string; password?: string; dailyLimit?: number },
): Promise<string> {
  const created = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/users", {
    cookie: h.cookie,
    body: {
      username: input.username,
      password: input.password ?? TEST_PASSWORD,
      dailyLimit: input.dailyLimit ?? 50,
    },
  });
  if (created.status !== 201) throw new Error(`创建账号失败 ${created.status}: ${created.text}`);
  const login = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
    body: {
      username: input.username,
      password: input.password ?? TEST_PASSWORD,
      clientLabel: "test-client",
      appId: h.app?.appId ?? "com.test.app",
    },
  });
  if (login.status !== 200) throw new Error(`账号登录失败 ${login.status}: ${login.text}`);
  return login.data.token as string;
}

/**
 * 测试脚手架：通过管理接口完成「人工分类 + 归档授权」。
 *
 * 真实产品里这一步只能由管理员在管理页显式触发（T2/T3）；提交成功不再授权远端归档。
 * 测试用它替代旧版本“提交即自动归档”的假设，同时验证归档接口本身。
 */
export async function authorizeArchive(
  h: Harness,
  feedbackId: string,
  over: {
    projectId?: string | null;
    columnId?: string | null;
    columnSlug?: string | null;
    labelIds?: string[];
    assigneeId?: string | null;
    assigneeName?: string;
    action?: "save" | "archive";
  } = {},
) {
  const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${feedbackId}`, { cookie: h.cookie });
  const version = detail.data?.classification?.version ?? 0;
  // undefined = 用默认值；显式 null = 清空（测试“缺项暂存”用）。
  const pick = <T>(v: T | null | undefined, dflt: T): T | null => (v === undefined ? dflt : v);
  const assigneeId = pick(over.assigneeId, null);
  return jsonReq(h.feedbackApp.app, "POST", `/api/admin/feedback/${feedbackId}/classify`, {
    cookie: h.cookie,
    body: {
      action: over.action ?? "archive",
      classifyVersion: version,
      projectId: pick(over.projectId, "proj-1"),
      columnId: pick(over.columnId, "col-db-id"),
      columnSlug: pick(over.columnSlug, "triage"),
      labelIds: over.labelIds ?? ["label-bug"],
      assigneeId,
      ...(assigneeId ? { assigneeName: over.assigneeName ?? "负责人甲" } : {}),
    },
  });
}

/** 提交（JSON）→ AI 整理 → 人工归档授权 → 归档完成；返回 feedbackId。 */
export async function submitAndArchive(
  h: Harness,
  body: Record<string, unknown> = {},
  over: Parameters<typeof authorizeArchive>[2] = {},
): Promise<string> {
  const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(body));
  if (r.status !== 201) throw new Error(`提交失败 ${r.status}: ${r.text}`);
  const id = r.data.feedbackId as string;
  await h.feedbackApp.worker.idle();
  const auth = await authorizeArchive(h, id, over);
  if (auth.status !== 202) throw new Error(`归档授权失败 ${auth.status}: ${auth.text}`);
  await h.feedbackApp.worker.idle();
  return id;
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

// ---------- v7：先接收后配置 / 自动归档 ----------

/** 读取软件当前规则版本（T2：写操作必须带页面读到的版本）。 */
export async function appRuleVersion(h: Harness, appId?: string): Promise<number> {
  const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/apps/${appId ?? h.app.id}`, { cookie: h.cookie });
  if (detail.status !== 200) throw new Error(`读取软件详情失败 ${detail.status}: ${detail.text}`);
  return Number(detail.data.app?.ruleVersion ?? 0);
}

/** 保存软件默认归档目标（普通保存）：**不触发归档**，只写规则；默认带当前规则版本。 */
export async function saveAppDefaults(
  h: Harness,
  over: {
    appId?: string;
    name?: string;
    allowedOrigins?: string[];
    projectId?: string;
    columnId?: string;
    columnSlug?: string;
    labelIds?: string[];
    assigneeId?: string | null;
    assigneeName?: string;
    /** 覆盖期望规则版本（测试版本冲突用）；缺省读取当前版本。 */
    expectedRuleVersion?: number;
  } = {},
) {
  const assigneeId = over.assigneeId ?? null;
  const expectedRuleVersion = over.expectedRuleVersion ?? (await appRuleVersion(h, over.appId));
  return jsonReq(h.feedbackApp.app, "PUT", `/api/admin/apps/${over.appId ?? h.app.id}`, {
    cookie: h.cookie,
    body: {
      expectedRuleVersion,
      name: over.name ?? h.app.name ?? "测试软件",
      allowedOrigins: over.allowedOrigins ?? ["http://host.test"],
      kaneoProjectId: over.projectId ?? "proj-1",
      kaneoColumnId: over.columnId ?? "col-db-id",
      kaneoColumnSlug: over.columnSlug ?? "triage",
      kaneoLabelIds: over.labelIds ?? ["label-bug"],
      kaneoAssigneeId: assigneeId,
      ...(assigneeId ? { kaneoAssigneeName: over.assigneeName ?? "负责人甲" } : {}),
    },
  });
}

/** 启用自动归档（管理员显式点击“启用自动归档并处理积压”）。 */
export async function enableAutoArchive(
  h: Harness,
  over: { appId?: string; operationId?: string; expectedRuleVersion?: number | null } = {},
) {
  const expectedRuleVersion =
    over.expectedRuleVersion === undefined ? await appRuleVersion(h, over.appId) : over.expectedRuleVersion;
  return jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${over.appId ?? h.app.id}/auto-archive/enable`, {
    cookie: h.cookie,
    body: {
      ...(over.operationId ? { operationId: over.operationId } : {}),
      ...(expectedRuleVersion === null ? {} : { expectedRuleVersion }),
    },
  });
}

/** 关闭自动归档（只阻止新的授权）。 */
export async function disableAutoArchive(
  h: Harness,
  over: { appId?: string; operationId?: string; expectedRuleVersion?: number | null } = {},
) {
  const expectedRuleVersion =
    over.expectedRuleVersion === undefined ? await appRuleVersion(h, over.appId) : over.expectedRuleVersion;
  return jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${over.appId ?? h.app.id}/auto-archive/disable`, {
    cookie: h.cookie,
    body: {
      ...(over.operationId ? { operationId: over.operationId } : {}),
      ...(expectedRuleVersion === null ? {} : { expectedRuleVersion }),
    },
  });
}

/**
 * 确认某个来源（管理员显式动作）。
 * T2：`operationId`（一次操作的稳定幂等键）与 `expectedRuleVersion` 都是必填；
 * 缺省 operationId 自动生成一个（测试重放时显式传同一个值）。
 */
export async function confirmSource(
  h: Harness,
  origin: string,
  over: { appId?: string; operationId?: string; expectedRuleVersion?: number | null } = {},
) {
  const operationId = over.operationId ?? `confirm-${Math.random().toString(36).slice(2)}`;
  const expectedRuleVersion =
    over.expectedRuleVersion === undefined ? await appRuleVersion(h, over.appId) : over.expectedRuleVersion;
  return jsonReq(h.feedbackApp.app, "POST", `/api/admin/apps/${over.appId ?? h.app.id}/sources/confirm`, {
    cookie: h.cookie,
    body: {
      origin,
      operationId,
      ...(expectedRuleVersion === null ? {} : { expectedRuleVersion }),
    },
  });
}

/** 读取软件详情（含逐条来源）。 */
export async function getAppDetail(h: Harness, appId?: string) {
  return jsonReq(h.feedbackApp.app, "GET", `/api/admin/apps/${appId ?? h.app.id}`, { cookie: h.cookie });
}

/** 读取反馈详情。 */
export async function getFeedbackDetail(h: Harness, feedbackId: string) {
  return jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${feedbackId}`, { cookie: h.cookie });
}

/** 走完“保存规则 → 启用自动归档”的完整准备流程。 */
export async function prepareAutoArchive(h: Harness, over: Parameters<typeof saveAppDefaults>[1] = {}): Promise<void> {
  const saved = await saveAppDefaults(h, over);
  if (saved.status !== 200) throw new Error(`保存默认目标失败 ${saved.status}: ${saved.text}`);
  const enabled = await enableAutoArchive(h, { appId: over.appId ?? h.app.id });
  if (enabled.status !== 200) throw new Error(`启用自动归档失败 ${enabled.status}: ${enabled.text}`);
}

export async function makeHarness(
  opts: {
    aiOutcomes?: MockAiBehavior["outcomes"];
    kaneo?: MockKaneoOptions;
    seedAppOver?: { appId?: string; origins?: string[]; columnSlug?: string };
    /** T3：注入可控时钟与定时器，用推进时间观察真实调度。 */
    clock?: FakeClock;
    /** T3：收紧单次扫描批量，覆盖多轮补处理。 */
    scanBatch?: number;
  } = {},
): Promise<Harness> {
  const config = makeConfig();
  const ai = makeMockAi({ outcomes: opts.aiOutcomes ?? ["ok"] });
  const kaneo = makeMockKaneo(opts.kaneo);
  const feedbackApp = createApp(config, {
    ai,
    kaneo,
    workerSleep: instantSleep,
    ...(opts.clock ? { now: opts.clock.now, setTimer: opts.clock.setTimer, clearTimer: opts.clock.clearTimer } : {}),
    ...(opts.scanBatch !== undefined ? { scanBatch: opts.scanBatch } : {}),
  });
  const cookie = await loginAsAdmin(feedbackApp);
  await seedConnections(feedbackApp, cookie);
  const publicApp = await seedAppWithColumn(feedbackApp, cookie, opts.seedAppOver);
  const bearer = await loginAsClient(feedbackApp);
  return {
    feedbackApp,
    config,
    ai,
    kaneo,
    cookie,
    bearer,
    app: publicApp,
  };
}

/**
 * T3 测试用可控时钟 + 定时器：
 * `advance(ms)` 推进时间并同步触发所有到期定时器（含回调里新安排的任务），
 * 之后调用方仍需 `await worker.idle()` 等异步处理跑完——绝不手动清空退避字段。
 */
export interface FakeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: unknown): void;
  pending(): number;
  advance(ms: number): Promise<void>;
}

export function makeFakeClock(startAt = Date.UTC(2026, 0, 1, 0, 0, 0)): FakeClock {
  let current = startAt;
  let seq = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = seq++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(Number(handle));
    },
    pending: () => timers.size,
    async advance(ms: number): Promise<void> {
      current += ms;
      // 触发所有到期定时器；回调可能安排新的（0 延迟）定时器，因此循环处理。
      for (let guard = 0; guard < 500; guard++) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= current)
          .sort((a, b) => a[1].at - b[1].at)
          .map(([id]) => id);
        if (due.length === 0) return;
        for (const id of due) {
          const t = timers.get(id);
          if (!t) continue;
          timers.delete(id);
          t.fn();
        }
        await new Promise((r) => setImmediate(r));
      }
      throw new Error("fake clock advance 触发次数异常：疑似调度空转");
    },
  };
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
      allowedOrigins: over.origins ?? ["http://localhost", "http://host.test"],
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

export async function submitMultipartFeedback(
  feedbackApp: FeedbackApp,
  bearer: string,
  metadata: Record<string, unknown>,
  screenshotBuffer?: Buffer,
  logs?: Array<{ filename: string; buffer: Buffer; contentType?: string }>,
) {
  const boundary = `----FeedbackTestBoundary${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
        metadata,
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

  if (logs) {
    for (const log of logs) {
      const ct = log.contentType ?? "text/plain";
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="logs"; filename="${log.filename}"\r\nContent-Type: ${ct}\r\n\r\n`,
        ),
      );
      parts.push(log.buffer);
      parts.push(Buffer.from("\r\n"));
    }
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
  return { status: res.status, data, headers: res.headers };
}
