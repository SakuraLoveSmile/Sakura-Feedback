/**
 * E2E 用的模拟外部服务（仅本地测试，非生产代码）：
 *  - AI mock    :8899  OpenAI 兼容 POST /v1/chat/completions
 *  - Kaneo mock :8898  /api/project|column|task|search|comment|task/image-upload + /__mock/* 控制与查看
 *
 * 相对早期版本的改动（都属于 e2e 可观测性/测试替身完整性，不改产品行为）：
 *  1. 支持多模态 user content（截图上送后 content 是数组）：从中抽取 text 部分，
 *     否则摘录会变成 "[object Object]"；
 *  2. 记录每次 AI 请求（文本部分、是否带图）并用 GET /__mock/ai-calls 取回，
 *     用于断言「拖拽落点确实进入了归档提示」等端到端事实；
 *  3. 补齐**图文归档链路**（带截图反馈会走的那条路）：分配预签名地址 →
 *     预签名 PUT 上传 → finalize 登记资产 → 评论读写。缺这些端点时服务端会
 *     「Kaneo 获取评论列表失败 (404)」，反馈停在待核对、永远拿不到任务链接。
 *     预签名 PUT 若携带 Authorization 会被记录到 uploadAuthLeaks（服务端约定
 *     「绝不向存储地址携带 Kaneo API Key」，测试可据此断言未泄漏）。
 *  4. **精确阶段的故障注入**（`POST /__mock/fail`）：图文归档的每次远端写入都能单独
 *     打坏 —— `stage` ∈ task(创建任务) / presign(申请预签名地址) / put(二进制上传) /
 *     finalize(登记资产) / comment(发评论)，`mode` ∈ uncertain(掐断连接，客户端看到
 *     “结果未知”) / definite(403 明文拒绝) / hold(不回响应而把请求挂起，用于让容器
 *     在“请求在途”时被重启)。`once` 默认 true（只作用于该阶段的下一次请求），
 *     `afterWrite` 默认 true（先完成远端写入再挂起/丢失响应 → 模拟“远端已写入但结果
 *     未知”）。这是复现「每个远端写入阶段中途重启」的关键能力。
 *  5. **每阶段调用计数与请求明细**（`calls` / `presigns` / `putAttempts` /
 *     `finalizeAttempts` / `commentAttempts`）：测试据此断言「是否申请过第二个 key」
 *     「同 key 是否重传了相同字节」「评论是否只发了一条」，而不是只看服务端状态字段。
 *  6. **预签名地址过期模拟**（`POST /__mock/fail {stage:"presign", expire:true}`）：
 *     下一次预签名响应带已过期的 `Expires` 签名参数，服务端会解析出过去的
 *     `upload.expiresAt`，用于验证「过期不自动换 key」。
 *  7. `POST /__mock/release`：释放所有被 `hold` 挂起的响应（容器重启后清理在途请求）。
 *  8. **预签名/资产地址主机名可切换**（`POST /__mock/state {"publicBase": "..."}` 或环境变量
 *     `E2E_KANEO_PUBLIC_BASE`）：服务端跑在【容器】里时，mock 返回的
 *     `http://127.0.0.1:8898/...` 容器是连不上的（PUT 会直接 `fetch failed`），
 *     容器用例必须把基址设成 `http://host.docker.internal:8898`。
 */
import http from "node:http";
import { createHash } from "node:crypto";

/** 参与故障注入/计数的远端写入阶段（顺序即归档流水线顺序）。 */
const AI_PORT = Number(process.env.E2E_AI_PORT || 8899);
const KANEO_PORT = Number(process.env.E2E_KANEO_PORT || 8898);

const STAGES = ["task", "presign", "put", "finalize", "comment"];

function emptyCalls() {
  return { task: 0, presign: 0, put: 0, finalize: 0, comment: 0 };
}

const state = {
  aiFail: false,
  kaneoFail: null, // null | "uncertain" | "definite"（旧的任务创建阶段开关，保留兼容）
  tasks: [],
  taskSeq: 0,
  aiCalls: [],
  assets: new Map(), // key -> { bytes, contentType }
  comments: new Map(), // taskId -> [{ id, content }]
  // ---- 人工分类归档改造（T2/T3）：工作区级标签、任务标签、工作区成员 ----
  workspaceLabels: [
    { id: "label-bug", name: "bug", color: "#e11d48" },
    { id: "label-ui", name: "ui", color: "#0ea5e9" },
  ],
  taskLabels: new Map(), // taskId -> [{ id, name, color }]
  taskLabelSeq: 0,
  labelAttaches: [], // [{ labelId, taskId, created, at }]
  members: [
    { id: "user-e2e-1", name: "E2E 成员甲", email: "member-a@e2e.test", role: "member" },
    { id: "user-e2e-2", name: "E2E 成员乙", email: "member-b@e2e.test", role: "admin" },
  ],
  commentSeq: 0,
  assetSeq: 0,
  uploadAuthLeaks: [], // 预签名上传里出现 Authorization 的记录

  // ---- 精确阶段故障注入（见文件头 4/5/6/7）----
  fail: { stage: null, mode: null, once: true, afterWrite: true, fired: 0 },
  expireNextPresign: false,
  calls: emptyCalls(),
  presigns: [], // [{ seq, taskId, key, uploadUrl, expired, at }]
  putAttempts: [], // [{ seq, key, bytes, sha256, stored, mode, at }]
  finalizeAttempts: [], // [{ seq, taskId, key, registered, mode, at }]
  commentAttempts: [], // [{ seq, taskId, id, stored, mode, at }]
  held: [], // 挂起中的响应 [{ stage, detail, at, res }]
};

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    const done = () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    };
    req.on("data", (c) => (raw += c));
    req.on("end", done);
    req.on("error", done); // 客户端中断（容器重启）：不要悬挂
    req.on("aborted", done);
  });
}

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks));
    req.on("data", (c) => chunks.push(c));
    req.on("end", done);
    req.on("error", done);
    req.on("aborted", done);
  });
}

/** 多模态 content（数组）里取 text 部分；纯字符串直接返回。 */
function extractUserText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return String(content ?? "");
}

function hasImagePart(content) {
  return (
    Array.isArray(content) &&
    content.some((p) => p && (p.type === "image_url" || p.image_url))
  );
}

/**
 * 预签名上传地址 / 资产地址里使用的主机名基址。
 * 默认 127.0.0.1:8898（服务端跑在宿主时可用）；**容器内**的服务端必须换成
 * `http://host.docker.internal:8898`，否则容器根本连不上这个地址
 * （测试用 `POST /__mock/state {"publicBase": ...}` 设置，或用环境变量
 *  `E2E_KANEO_PUBLIC_BASE` 在启动时指定）。
 */
let kaneoBase = process.env.E2E_KANEO_PUBLIC_BASE || `http://127.0.0.1:${KANEO_PORT}`;

// ---------- 故障注入辅助 ----------

/**
 * 取出并（必要时）消费当前匹配该阶段的注入配置。
 * 返回 { mode, afterWrite } 或 null（无注入）。
 */
function takeInjection(stage) {
  const f = state.fail;
  if (!f.stage || !f.mode || f.stage !== stage) return null;
  const out = { mode: f.mode, afterWrite: f.afterWrite !== false };
  f.fired += 1;
  if (f.once !== false) {
    f.stage = null;
    f.mode = null;
  }
  return out;
}

/** 按注入模式结束一个请求：uncertain=掐断连接；definite=403 明文拒绝。 */
function rejectByInjection(req, res, mode) {
  if (mode === "uncertain") {
    // 模拟“请求可能已到达但结果不确定”：直接掐断连接
    req.destroy?.();
    res.destroy();
    return;
  }
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("forbidden by mock");
}

/** 挂起响应（永不结束）：容器在“请求在途”时被重启，用于中途重启用例。 */
function holdResponse(res, stage, detail) {
  const entry = { stage, detail, at: new Date().toISOString(), res };
  state.held.push(entry);
  const drop = () => {
    state.held = state.held.filter((h) => h !== entry);
  };
  res.on("close", drop);
  res.on("error", drop);
  // 故意不调用 res.end()
}

/** 释放所有挂起响应（容器已重启，连接通常已断）。 */
function releaseHeld() {
  const n = state.held.length;
  for (const h of state.held) {
    try {
      h.res.destroy();
    } catch {
      /* 连接已断 */
    }
  }
  state.held = [];
  return n;
}

function failState() {
  return { ...state.fail, expireNextPresign: state.expireNextPresign };
}

// ---------- AI mock ----------
http
  .createServer(async (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url, "http://ai");
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      if (state.aiFail) return json(res, 500, { error: "mock ai down" });
      const userContent = (body.messages ?? []).find((m) => m.role === "user")?.content ?? "";
      const userMsg = extractUserText(userContent);
      // 摘录取定界符内的原话本体（服务端会包裹提示注入防线）
      const inner = userMsg.match(/【反馈原话开始[^\n]*\n([\s\S]*?)\n【反馈原话结束】/);
      const excerpt = (inner ? inner[1] : userMsg).replace(/\s+/g, " ").slice(0, 18);
      state.aiCalls.push({
        at: new Date().toISOString(),
        model: body.model ?? null,
        userText: userMsg,
        hasImage: hasImagePart(userContent),
      });
      if (state.aiCalls.length > 50) state.aiCalls.shift();
      return json(res, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: `E2E整理：${excerpt}`,
                sections: {
                  experience: "（mock）使用体验整理",
                  problems: `（mock）问题摘录：${excerpt}`,
                  suggestions: "",
                  questions: "",
                },
              }),
            },
          },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/__mock/state") {
      const body = await readBody(req);
      if (typeof body.aiFail === "boolean") state.aiFail = body.aiFail;
      return json(res, 200, { aiFail: state.aiFail });
    }
    if (url.pathname === "/__mock/ai-calls") {
      return json(res, 200, { count: state.aiCalls.length, calls: state.aiCalls });
    }
    if (url.pathname === "/__mock/ai-last") {
      return json(res, 200, { last: state.aiCalls[state.aiCalls.length - 1] ?? null });
    }
    if (url.pathname === "/__mock/tasks") return json(res, 200, { tasks: [] });
    if (url.pathname === "/__health") return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  })
  .listen(AI_PORT, "127.0.0.1", () => console.log(`[mock-ai] :${AI_PORT}`));

// ---------- Kaneo mock ----------
http
  .createServer(async (req, res) => {
    // 容器重启会打断在途请求：挂起的 socket 报错时不要拖垮 mock 进程
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url, "http://kaneo");
    const p = url.pathname;
    if (p === "/__health") return json(res, 200, { ok: true });
    if (p === "/__mock/tasks") return json(res, 200, { tasks: state.tasks });
    if (p === "/__mock/labels")
      return json(res, 200, {
        workspaceLabels: state.workspaceLabels,
        taskLabels: Object.fromEntries(state.taskLabels),
        attaches: state.labelAttaches,
      });
    if (p === "/__mock/state" && req.method === "GET") {
      return json(res, 200, {
        kaneoFail: state.kaneoFail,
        tasks: state.tasks,
        comments: Object.fromEntries(state.comments),
        assetKeys: [...state.assets.keys()],
        uploadAuthLeaks: state.uploadAuthLeaks,
        // ---- 本轮新增（精确阶段观测 + 故障注入）----
        fail: failState(),
        calls: { ...state.calls },
        presigns: state.presigns,
        putAttempts: state.putAttempts,
        finalizeAttempts: state.finalizeAttempts,
        commentAttempts: state.commentAttempts,
        held: state.held.map((h) => ({ stage: h.stage, detail: h.detail, at: h.at })),
        heldCount: state.held.length,
        publicBase: kaneoBase,
      });
    }
    if (p === "/__mock/state" && req.method === "POST") {
      const body = await readBody(req);
      if ("kaneoFail" in body) state.kaneoFail = body.kaneoFail;
      // 容器场景：预签名/资产地址必须指向容器可达的主机名
      if (typeof body.publicBase === "string" && body.publicBase) {
        kaneoBase = body.publicBase.replace(/\/+$/, "");
      }
      return json(res, 200, { kaneoFail: state.kaneoFail, publicBase: kaneoBase });
    }
    // ---- 精确阶段故障注入（stage/mode/once/afterWrite/expire）----
    if (p === "/__mock/fail" && req.method === "POST") {
      const body = await readBody(req);
      if ("stage" in body) {
        if (body.stage !== null && !STAGES.includes(String(body.stage))) {
          return json(res, 400, { error: `stage 必须是 ${STAGES.join("|")} 或 null` });
        }
        state.fail.stage = body.stage === null ? null : String(body.stage);
      }
      if ("mode" in body) {
        const mode = body.mode === null ? null : String(body.mode);
        if (mode !== null && !["uncertain", "definite", "hold"].includes(mode)) {
          return json(res, 400, { error: 'mode 必须是 uncertain|definite|hold|null' });
        }
        state.fail.mode = mode;
      }
      if ("once" in body) state.fail.once = Boolean(body.once);
      if ("afterWrite" in body) state.fail.afterWrite = Boolean(body.afterWrite);
      if (body.mode === null || body.stage === null) state.fail.fired = 0;
      if ("expire" in body) state.expireNextPresign = Boolean(body.expire);
      return json(res, 200, failState());
    }
    if (p === "/__mock/release" && req.method === "POST") {
      return json(res, 200, { released: releaseHeld(), heldCount: state.held.length });
    }
    if (p === "/__mock/reset" && req.method === "POST") {
      state.tasks = [];
      state.taskSeq = 0;
      state.kaneoFail = null;
      state.aiFail = false;
      state.aiCalls = [];
      state.assets = new Map();
      state.comments = new Map();
      state.assetSeq = 0;
      state.commentSeq = 0;
      state.uploadAuthLeaks = [];
      // 标签 / 成员状态复位
      state.taskLabels = new Map();
      state.taskLabelSeq = 0;
      state.labelAttaches = [];
      // 新增状态一并复位
      state.fail = { stage: null, mode: null, once: true, afterWrite: true, fired: 0 };
      state.expireNextPresign = false;
      state.calls = emptyCalls();
      state.presigns = [];
      state.putAttempts = [];
      state.finalizeAttempts = [];
      state.commentAttempts = [];
      releaseHeld();
      return json(res, 200, { ok: true });
    }

    // ---- 预签名上传目标（存储服务替身）：只有预签名请求头，绝不能带 Authorization ----
    if (p.startsWith("/__mock/upload/") && req.method === "PUT") {
      const key = decodeURIComponent(p.slice("/__mock/upload/".length));
      state.calls.put += 1;
      if (req.headers.authorization) {
        state.uploadAuthLeaks.push({ key, authorization: req.headers.authorization });
      }
      const inj = takeInjection("put");
      if (inj && inj.mode !== "hold") {
        // 结果是确定失败/未知：本次不上传字节
        state.putAttempts.push({
          seq: state.putAttempts.length + 1,
          key,
          bytes: 0,
          sha256: null,
          stored: false,
          mode: inj.mode,
          at: new Date().toISOString(),
        });
        return rejectByInjection(req, res, inj.mode);
      }
      if (inj && inj.mode === "hold" && !inj.afterWrite) {
        state.putAttempts.push({
          seq: state.putAttempts.length + 1,
          key,
          bytes: 0,
          sha256: null,
          stored: false,
          mode: "hold-before-write",
          at: new Date().toISOString(),
        });
        return holdResponse(res, "put", { key, note: "hold-before-write" });
      }
      const bytes = await readRaw(req);
      state.assets.set(key, { bytes, contentType: req.headers["content-type"] ?? "image/png" });
      state.putAttempts.push({
        seq: state.putAttempts.length + 1,
        key,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        stored: true,
        mode: inj ? "hold-after-write" : null,
        at: new Date().toISOString(),
      });
      if (inj && inj.mode === "hold" && inj.afterWrite) {
        return holdResponse(res, "put", { key, bytes: bytes.length, note: "hold-after-write" });
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, key, size: bytes.length }));
    }
    // ---- 鉴权资产下载（服务端核对远端真实字节用）----
    if (p.startsWith("/__mock/asset/") && req.method === "GET") {
      const key = decodeURIComponent(p.slice("/__mock/asset/".length));
      const asset = state.assets.get(key);
      if (!asset) return json(res, 404, { error: "asset not found" });
      res.writeHead(200, { "content-type": asset.contentType });
      return res.end(asset.bytes);
    }
    // ---- 评论列表（读）----
    let m = p.match(/^\/api\/comment\/([^/]+)$/);
    if (m && req.method === "GET") {
      return json(res, 200, state.comments.get(m[1]) ?? []);
    }

    let match = p.match(/^\/api\/project\/([^/]+)$/);
    if (match) {
      return json(res, 200, {
        id: match[1],
        name: match[1] === "p-other" ? "另一个项目" : "E2E 测试项目",
        workspaceId: "ws-e2e",
        slug: match[1] === "p-other" ? "OTHER" : "E2E",
      });
    }
    // ---- 密钥可见的工作区与项目（管理页项目下拉）----
    if (p === "/api/auth/organization/list") {
      return json(res, 200, [{ id: "ws-e2e", name: "E2E 工作区" }]);
    }
    if (p === "/api/project" && req.method === "GET") {
      return json(res, 200, [
        { id: "p-e2e", workspaceId: "ws-e2e", name: "E2E 测试项目", slug: "E2E" },
        { id: "p-other", workspaceId: "ws-e2e", name: "另一个项目", slug: "OTHER" },
      ]);
    }
    match = p.match(/^\/api\/column\/([^/]+)$/);
    if (match) {
      // 不同项目返回不同列，便于浏览器验证「切换项目后丢弃迟到响应」。
      if (match[1] === "p-other") {
        // 故意延迟：制造“旧请求后到”的迟到响应（异步等待不会阻塞其它项目的请求）
        await new Promise((r) => setTimeout(r, 1500));
        return json(res, 200, [{ id: "col-x1", projectId: match[1], name: "已上线", slug: "done", position: 1 }]);
      }
      return json(res, 200, [
        { id: "col-1", projectId: match[1], name: "待筛选", slug: "triage", position: 1 },
        { id: "col-2", projectId: match[1], name: "进行中", slug: "doing", position: 2 },
      ]);
    }
    // ---- 工作区级标签（人工分类的可选项来源；taskId 为 null）----
    match = p.match(/^\/api\/label\/workspace\/([^/]+)$/);
    if (match) {
      return json(
        res,
        200,
        state.workspaceLabels.map((l) => ({ ...l, taskId: null, workspaceId: match[1] })),
      );
    }
    // ---- 任务已关联的标签（写入后读回核对）----
    match = p.match(/^\/api\/label\/task\/([^/]+)$/);
    if (match) {
      const taskId = match[1];
      return json(
        res,
        200,
        (state.taskLabels.get(taskId) ?? []).map((l) => ({ ...l, taskId, workspaceId: "ws-e2e" })),
      );
    }
    // ---- 关联工作区级标签到任务（Kaneo 语义：为任务新建一行，工作区标签保留）----
    match = p.match(/^\/api\/label\/([^/]+)\/task$/);
    if (match && req.method === "PUT") {
      const labelId = match[1];
      const body = await readBody(req);
      const taskId = String(body.taskId ?? "");
      const def = state.workspaceLabels.find((l) => l.id === labelId);
      if (!def) return json(res, 404, { error: "Label not found" });
      const current = state.taskLabels.get(taskId) ?? [];
      const existing = current.find((l) => l.name === def.name);
      if (existing) {
        state.labelAttaches.push({ labelId, taskId, created: false, at: new Date().toISOString() });
        return json(res, 200, { ...existing, taskId, workspaceId: "ws-e2e" });
      }
      const created = { id: `tasklabel-${++state.taskLabelSeq}-${def.name}`, name: def.name, color: def.color };
      state.taskLabels.set(taskId, [...current, created]);
      state.labelAttaches.push({ labelId, taskId, created: true, at: new Date().toISOString() });
      return json(res, 200, { ...created, taskId, workspaceId: "ws-e2e" });
    }
    // ---- 工作区成员（可选负责人）----
    match = p.match(/^\/api\/workspace\/([^/]+)\/members$/);
    if (match) {
      return json(res, 200, state.members);
    }
    // ---- 阶段 2：图片上传——分配预签名地址 ----
    match = p.match(/^\/api\/task\/image-upload\/([^/]+)$/);
    if (match && req.method === "PUT") {
      const taskId = match[1];
      state.calls.presign += 1;
      const body = await readBody(req);
      const inj = takeInjection("presign");
      if (inj && inj.mode !== "hold") {
        return rejectByInjection(req, res, inj.mode);
      }
      const key = `asset-${++state.assetSeq}-${req.headers["x-e2e-nonce"] ?? Date.now()}`;
      const expired = state.expireNextPresign;
      // 过期模拟：v2 风格 Expires 签名参数（服务端 parsePresignedExpiry 据此得出过去的 expiresAt）
      const query = expired ? `?Expires=${Math.floor(Date.now() / 1000) - 60}` : "";
      if (expired) state.expireNextPresign = false;
      const payload = {
        key,
        uploadUrl: `${kaneoBase}/__mock/upload/${encodeURIComponent(key)}${query}`,
        headers: { "content-type": "image/png" },
        received: { filename: body.filename, size: body.size, surface: body.surface },
      };
      state.presigns.push({
        seq: state.presigns.length + 1,
        taskId,
        key,
        uploadUrl: payload.uploadUrl,
        expired,
        at: new Date().toISOString(),
      });
      if (inj && inj.mode === "hold" && inj.afterWrite) {
        // 地址已在“远端”分配（key 已消耗），但不回响应 → 客户端拿不到 key
        return holdResponse(res, "presign", { taskId, key, note: "hold-after-write" });
      }
      return json(res, 200, payload);
    }
    // ---- 阶段 4：图片上传——finalize 登记资产 ----
    match = p.match(/^\/api\/task\/image-upload\/([^/]+)\/finalize$/);
    if (match && req.method === "POST") {
      const taskId = match[1];
      state.calls.finalize += 1;
      const body = await readBody(req);
      const key = String(body.key ?? "");
      const inj = takeInjection("finalize");
      if (inj && inj.mode !== "hold") {
        state.finalizeAttempts.push({
          seq: state.finalizeAttempts.length + 1,
          taskId,
          key,
          registered: false,
          mode: inj.mode,
          at: new Date().toISOString(),
        });
        return rejectByInjection(req, res, inj.mode);
      }
      if (inj && inj.mode === "hold" && !inj.afterWrite) {
        state.finalizeAttempts.push({
          seq: state.finalizeAttempts.length + 1,
          taskId,
          key,
          registered: false,
          mode: "hold-before-write",
          at: new Date().toISOString(),
        });
        return holdResponse(res, "finalize", { taskId, key, note: "hold-before-write" });
      }
      if (!state.assets.has(key)) {
        state.finalizeAttempts.push({
          seq: state.finalizeAttempts.length + 1,
          taskId,
          key,
          registered: false,
          mode: "object-missing",
          at: new Date().toISOString(),
        });
        return json(res, 409, { error: "object not uploaded" });
      }
      state.finalizeAttempts.push({
        seq: state.finalizeAttempts.length + 1,
        taskId,
        key,
        registered: true,
        mode: inj ? "hold-after-write" : null,
        at: new Date().toISOString(),
      });
      const payload = {
        id: `asset-id-${key}`,
        url: `${kaneoBase}/__mock/asset/${encodeURIComponent(key)}`,
      };
      if (inj && inj.mode === "hold" && inj.afterWrite) {
        return holdResponse(res, "finalize", { taskId, key, note: "hold-after-write" });
      }
      return json(res, 200, payload);
    }
    // ---- 评论读写（服务端据此核对截图评论是否已挂载）----
    match = p.match(/^\/api\/comment\/([^/]+)$/);
    if (match && req.method === "POST") {
      const taskId = match[1];
      state.calls.comment += 1;
      const body = await readBody(req);
      const inj = takeInjection("comment");
      if (inj && inj.mode !== "hold") {
        state.commentAttempts.push({
          seq: state.commentAttempts.length + 1,
          taskId,
          id: null,
          stored: false,
          mode: inj.mode,
          at: new Date().toISOString(),
        });
        return rejectByInjection(req, res, inj.mode);
      }
      if (inj && inj.mode === "hold" && !inj.afterWrite) {
        state.commentAttempts.push({
          seq: state.commentAttempts.length + 1,
          taskId,
          id: null,
          stored: false,
          mode: "hold-before-write",
          at: new Date().toISOString(),
        });
        return holdResponse(res, "comment", { taskId, note: "hold-before-write" });
      }
      const list = state.comments.get(taskId) ?? [];
      const id = `comment-${++state.commentSeq}`;
      list.push({ id, content: String(body.content ?? "") });
      state.comments.set(taskId, list);
      state.commentAttempts.push({
        seq: state.commentAttempts.length + 1,
        taskId,
        id,
        stored: true,
        mode: inj ? "hold-after-write" : null,
        at: new Date().toISOString(),
      });
      if (inj && inj.mode === "hold" && inj.afterWrite) {
        // 评论已落“远端”（与“结果未知但其实已写入”一致），但不回响应
        return holdResponse(res, "comment", { taskId, id, note: "hold-after-write" });
      }
      return json(res, 200, { id });
    }
    // ---- 阶段 1：创建任务 ----
    match = p.match(/^\/api\/task\/([^/]+)$/);
    if (match && req.method === "POST") {
      const taskId = match[1]; // 项目 id
      state.calls.task += 1;
      const body = await readBody(req);
      const inj = takeInjection("task");
      if (inj && inj.mode !== "hold") {
        if (inj.mode === "uncertain") {
          req.destroy?.();
          res.destroy();
          return;
        }
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("forbidden by mock");
      }
      if (inj && inj.mode === "hold" && !inj.afterWrite) {
        return holdResponse(res, "task", { projectId: taskId, note: "hold-before-write" });
      }
      if (state.kaneoFail === "uncertain") {
        // 旧开关（POST /__mock/state {kaneoFail}）：模拟“请求可能已到达但结果不确定”
        req.destroy?.();
        res.destroy();
        return;
      }
      if (state.kaneoFail === "definite") {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("forbidden by mock");
      }
      const id = `e2e-task-${++state.taskSeq}`;
      state.tasks.push({ id, projectId: taskId, number: state.taskSeq, ...body });
      if (inj && inj.mode === "hold" && inj.afterWrite) {
        // 任务已在“远端”创建，但不回响应
        return holdResponse(res, "task", { id, projectId: taskId, note: "hold-after-write" });
      }
      return json(res, 200, { id, number: state.taskSeq, ...body });
    }
    if (p === "/api/search/" || p === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const results = state.tasks
        .filter((t) => (t.description ?? "").includes(q))
        .map((t) => ({
          id: t.id,
          type: "tasks",
          title: t.title,
          description: t.description,
          projectId: t.projectId,
        }));
      return json(res, 200, { results, totalCount: results.length });
    }
    json(res, 404, { error: "not found" });
  })
  .listen(KANEO_PORT, "127.0.0.1", () => console.log(`[mock-kaneo] :${KANEO_PORT}`));
