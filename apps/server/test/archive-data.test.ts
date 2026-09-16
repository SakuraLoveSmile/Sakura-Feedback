import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { encryptSecret } from "../src/crypto/secret.ts";
import { type Db, openDb } from "../src/db/db.ts";
import { getFeedback, getFeedbackScreenshot, insertApp, insertFeedback, updateFeedback } from "../src/db/repos.ts";

import {
  type ArchiveDataV1,
  ArchivePersistenceError,
  type ArchiveTarget,
  ArchiveVersionConflictError,
  buildUploadRecord,
  checkArchiveTarget,
  commentMarker,
  decryptUploadCredentials,
  encryptUploadCredentials,
  loadArchiveData,
  parseArchiveData,
  parsePresignedExpiry,
  saveArchiveData,
  serializeArchiveData,
} from "../src/pipeline/archive-data.ts";
import { normalizeKaneoApiBase } from "../src/services/kaneo-http.ts";
import {
  authorizeArchive,
  createTestPng,
  defaultSubmitBody,
  type Harness,
  instantSleep,
  jsonReq,
  loginAsAdmin,
  loginAsClient,
  makeConfig,
  makeHarness,
  makeMockAi,
  makeMockKaneo,
  seedApp,
  seedConnections,
  submitFeedback,
  submitMultipartFeedback,
} from "./helpers.ts";

/** 每个用例独立临时数据库（openDb 接收目录并在其中创建 feedback.db）。 */
function newDb(): Db {
  return openDb(mkdtempSync(path.join(tmpdir(), "fb-archive-")));
}

/**
 * 用自行 createApp 的实例构造 authorizeArchive 需要的 Harness 形状。
 * 契约变更后归档必须先经管理接口授权；这些用例需要自定义 kaneo mock，无法走 makeHarness。
 */
function asHarness(feedbackApp: Harness["feedbackApp"], cookie: string): Harness {
  return { feedbackApp, cookie } as unknown as Harness;
}

const MASTER_KEY = Buffer.alloc(32, 9);

function validNext(over: Partial<ArchiveDataV1> = {}): Omit<ArchiveDataV1, "version" | "revision"> {
  const base = {
    target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
  };
  return { ...base, ...over } as Omit<ArchiveDataV1, "version" | "revision">;
}

function seedFeedbackRow(db: Db): string {
  const app = insertApp(db, {
    appId: "com.test.app",
    name: "测试软件",
    allowedOrigins: ["http://host.test"],
    kaneoProjectId: "proj-1",
    kaneoColumnSlug: "triage",
  });
  const row = insertFeedback(db, {
    appId: "com.test.app",
    appRowId: app.id,
    text: "t",
    contextJson: null,
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    contentHash: "h",
  });
  return row.id;
}

describe("ArchiveDataV1 严格解析", () => {
  it("空值与旧格式", () => {
    expect(parseArchiveData(null)).toEqual({ kind: "empty" });
    expect(parseArchiveData("  ")).toEqual({ kind: "empty" });
    expect(parseArchiveData("{}")).toEqual({ kind: "legacy" });
    expect(parseArchiveData('{"assetUrl":"http://a/b.png"}')).toEqual({
      kind: "legacy",
      assetUrl: "http://a/b.png",
    });
    // 旧格式带未知字段 → 损坏，不猜测
    expect(parseArchiveData('{"assetUrl":"http://a/b.png","x":1}').kind).toBe("corrupt");
    expect(parseArchiveData('{"assetUrl":42}').kind).toBe("corrupt");
  });

  it("合法 v1 全结构可解析且字段逐项校验", () => {
    const raw = JSON.stringify({
      version: 1,
      revision: 3,
      target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
      upload: {
        key: "k1",
        credentialsEnc: "v1:iv:tag:ct",
        expiresAt: "2025-01-01T00:00:00.000Z",
        outcome: "not_sent",
      },
      asset: { id: "a1", url: "http://kaneo.test/assets/a1.png" },
      comment: { marker: "fb|sha", id: "c1", outcome: "confirmed" },
    });
    const parsed = parseArchiveData(raw);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.data.revision).toBe(3);
    expect(parsed.data.upload?.outcome).toBe("not_sent");
    expect(parsed.data.asset?.id).toBe("a1");
    expect(parsed.data.comment?.id).toBe("c1");
  });

  it("结构违规一律归类为损坏", () => {
    const good = JSON.parse(
      JSON.stringify({
        version: 1,
        revision: 1,
        target: { apiBase: "http://kaneo.test/api", projectId: "p", workspaceId: "w" },
      }),
    ) as Record<string, unknown>;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["未知顶层字段", { ...good, extra: 1 }],
      ["revision 非整数", { ...good, revision: 1.5 }],
      ["revision 缺失", { version: 1, target: good.target }],
      ["target 缺 workspaceId", { ...good, target: { apiBase: "http://a", projectId: "p" } }],
      ["target 含未知字段", { ...good, target: { ...(good.target as Record<string, unknown>), junk: "x" } }],
      ["apiBase 非 http", { ...good, target: { apiBase: "ftp://a", projectId: "p", workspaceId: "w" } }],
      ["outcome 非法", { ...good, upload: { key: "k", credentialsEnc: "c", expiresAt: null, outcome: "sent" } }],
      [
        "expiresAt 非法",
        { ...good, upload: { key: "k", credentialsEnc: "c", expiresAt: "not-a-date", outcome: "not_sent" } },
      ],
      ["asset 缺 url", { ...good, asset: { id: "a" } }],
      ["comment id 类型错误", { ...good, comment: { marker: "m", id: 5, outcome: "confirmed" } }],
      ["upload 缺 credentialsEnc", { ...good, upload: { key: "k", expiresAt: null, outcome: "not_sent" } }],
    ];
    for (const [name, v] of bad) {
      const parsed = parseArchiveData(JSON.stringify(v));
      expect(parsed.kind, name).toBe("corrupt");
    }
  });

  it("未知版本 → unsupported；损坏 JSON → corrupt", () => {
    // v3 已是受支持版本（含人工授权快照）；未知版本用 v4 表示。
    expect(
      parseArchiveData('{"version":4,"revision":1,"target":{"apiBase":"http://a","projectId":"p","workspaceId":"w"}}'),
    ).toEqual({
      kind: "unsupported",
      version: 4,
    });
    expect(parseArchiveData("{not json").kind).toBe("corrupt");
    expect(parseArchiveData('{"version":"1"}').kind).toBe("corrupt");
    expect(parseArchiveData("[1,2]")).toEqual({ kind: "corrupt", reason: "不是 JSON 对象" });
  });
});

describe("ArchiveDataV1 序列化与 revision 持久化", () => {
  it("序列化输出规范化结构并可回读", () => {
    const json = serializeArchiveData(
      {
        target: { workspaceId: "ws-1", projectId: "proj-1", apiBase: "http://kaneo.test/api" },
        upload: { key: "k1", credentialsEnc: "v1:a:b:c", expiresAt: null, outcome: "not_sent" },
      },
      4,
    );
    const parsed = parseArchiveData(json);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.data.version).toBe(3);
    expect(parsed.data.revision).toBe(4);
    expect(parsed.data.upload?.expiresAt).toBeNull();
    // 键序固定，version/revision 在前
    expect(json.startsWith('{"version":3,"revision":4,"target":{"apiBase"')).toBe(true);
  });

  it("revision 单调递增；并发基准过期时拒绝覆盖", () => {
    const db = newDb();
    const id = seedFeedbackRow(db);
    const first = saveArchiveData(db, id, { kind: "empty" }, validNext());
    expect(first.revision).toBe(1);
    const second = saveArchiveData(db, id, loadArchiveData(db, id), validNext());
    expect(second.revision).toBe(2);
    // 用过期的基准（revision 1）保存 → 冲突
    expect(() => saveArchiveData(db, id, { kind: "valid", data: first }, validNext())).toThrow(
      ArchiveVersionConflictError,
    );
  });

  it("损坏 / 未知版本之上拒绝写入；legacy 之上允许单记录首写", () => {
    const db = newDb();
    const id = seedFeedbackRow(db);
    updateFeedback(db, id, { archive_data_json: "{broken" });
    expect(() => saveArchiveData(db, id, loadArchiveData(db, id), validNext())).toThrow(ArchiveVersionConflictError);
    updateFeedback(db, id, {
      archive_data_json: '{"version":4,"revision":1,"target":{"apiBase":"http://a","projectId":"p","workspaceId":"w"}}',
    });
    expect(() => saveArchiveData(db, id, loadArchiveData(db, id), validNext())).toThrow(ArchiveVersionConflictError);
    // legacy 之上允许首写（单记录迁移，非批量改写）
    updateFeedback(db, id, { archive_data_json: '{"assetUrl":"http://a/b.png"}' });
    const saved = saveArchiveData(db, id, loadArchiveData(db, id), validNext());
    expect(saved.revision).toBe(1);
    expect(getFeedback(db, id)?.archive_data_json).toContain('"version":3');
  });

  it("SQLite 写入失败 → ArchivePersistenceError", () => {
    const db = newDb();
    const id = seedFeedbackRow(db);
    db.close();
    expect(() => saveArchiveData(db, id, { kind: "empty" }, validNext())).toThrow(ArchivePersistenceError);
  });
});

describe("恢复目标固定与变更检测", () => {
  const target: ArchiveTarget = { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" };

  it("fresh / same / changed 判定", () => {
    expect(checkArchiveTarget(null, target)).toEqual({ status: "fresh" });
    const data = { version: 1, revision: 1, target } as ArchiveDataV1;
    expect(checkArchiveTarget(data, target)).toEqual({ status: "same" });
    expect(checkArchiveTarget(data, { ...target, apiBase: "http://other.test/api" })).toEqual({
      status: "changed",
      field: "apiBase",
    });
    expect(checkArchiveTarget(data, { ...target, projectId: "proj-2" })).toEqual({
      status: "changed",
      field: "projectId",
    });
    expect(checkArchiveTarget(data, { ...target, workspaceId: "ws-2" })).toEqual({
      status: "changed",
      field: "workspaceId",
    });
  });

  it("normalizeKaneoApiBase 与 HTTP 客户端规则一致", () => {
    expect(normalizeKaneoApiBase("http://kaneo.test")).toBe("http://kaneo.test/api");
    expect(normalizeKaneoApiBase("http://kaneo.test/")).toBe("http://kaneo.test/api");
    expect(normalizeKaneoApiBase("http://kaneo.test/api/")).toBe("http://kaneo.test/api");
  });
});

describe("预签名凭证加密与到期解析", () => {
  it("凭证加密往返，解密校验结构", () => {
    const creds = {
      uploadUrl: "https://s3.test/bucket/k1?X-Amz-Algorithm=AWS4-HMAC-SHA256",
      headers: { "content-type": "image/png", "x-amz-meta-a": "b" },
    };
    const enc = encryptUploadCredentials(MASTER_KEY, creds);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("s3.test");
    const dec = decryptUploadCredentials(MASTER_KEY, enc);
    expect(dec.uploadUrl).toBe(creds.uploadUrl);
    expect(dec.headers).toEqual(creds.headers);
    // 篡改密文 → 解密失败
    const tampered = `${enc.slice(0, -2)}xx`;
    expect(() => decryptUploadCredentials(MASTER_KEY, tampered)).toThrow();
    // 明文不是凭证 JSON → 拒绝
    const notCreds = encryptSecret(MASTER_KEY, "hello");
    expect(() => decryptUploadCredentials(MASTER_KEY, notCreds)).toThrow(/不是 JSON/);
    // 主密钥不匹配 → 拒绝
    expect(() => decryptUploadCredentials(Buffer.alloc(32, 1), enc)).toThrow(/解密失败/);
  });

  it("到期时间从签名参数可靠解析，无法解析记为未知", () => {
    // AWS SigV4：X-Amz-Date + X-Amz-Expires
    const sigV4 = "https://s3.test/b/k?X-Amz-Date=20250102T030405Z&X-Amz-Expires=900";
    expect(parsePresignedExpiry(sigV4)).toBe("2025-01-02T03:19:05.000Z");
    // v2：Expires = epoch 秒
    expect(parsePresignedExpiry("https://s3.test/b/k?Expires=1735689600")).toBe("2025-01-01T00:00:00.000Z");
    // 缺参数 / 非法值 / 超出合理范围 → 未知
    expect(parsePresignedExpiry("https://s3.test/b/k")).toBeNull();
    expect(parsePresignedExpiry("https://s3.test/b/k?X-Amz-Date=20250102T030405Z")).toBeNull();
    expect(parsePresignedExpiry("https://s3.test/b/k?X-Amz-Date=bad&X-Amz-Expires=900")).toBeNull();
    expect(parsePresignedExpiry("https://s3.test/b/k?X-Amz-Date=20250102T030405Z&X-Amz-Expires=abc")).toBeNull();
    expect(parsePresignedExpiry("https://s3.test/b/k?X-Amz-Date=20250102T030405Z&X-Amz-Expires=999999999")).toBeNull();
    expect(parsePresignedExpiry("https://s3.test/b/k?Expires=abc")).toBeNull();
    expect(parsePresignedExpiry("not a url")).toBeNull();
  });

  it("buildUploadRecord：凭证加密、到期解析、outcome 透传", () => {
    const rec = buildUploadRecord(
      MASTER_KEY,
      {
        key: "obj-key",
        uploadUrl: "https://s3.test/b/k?X-Amz-Date=20250102T030405Z&X-Amz-Expires=60",
        headers: { "content-type": "image/png" },
      },
      "not_sent",
    );
    expect(rec.key).toBe("obj-key");
    expect(rec.outcome).toBe("not_sent");
    expect(rec.expiresAt).toBe("2025-01-02T03:05:05.000Z");
    expect(rec.credentialsEnc).not.toContain("s3.test");
    expect(decryptUploadCredentials(MASTER_KEY, rec.credentialsEnc).uploadUrl).toBe(
      "https://s3.test/b/k?X-Amz-Date=20250102T030405Z&X-Amz-Expires=60",
    );
  });

  it("commentMarker 由反馈 ID 与图片摘要构成", () => {
    expect(commentMarker("fb-1", "sha-1")).toBe("fb-1|sha-1");
  });
});

describe("worker 集成：目标固定、凭证落盘门禁与损坏数据停止", () => {
  it("图文反馈归档后 archive_data_json 为合法 v3：目标固定、凭证加密、上传/资产/评论结果完整", async () => {
    const h = await makeHarness();
    const png = await createTestPng(80, 60);
    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), png);
    expect(res.status).toBe(201);
    await h.feedbackApp.worker.idle();
    // 契约变更：提交只做 AI 整理，远端归档必须由管理员在管理接口显式授权
    const auth = await authorizeArchive(h, res.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("archived");
    const shot = getFeedbackScreenshot(h.feedbackApp.db, res.data.feedbackId);
    expect(shot).not.toBeNull();

    const parsed = parseArchiveData(row?.archive_data_json ?? null);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.data.version).toBe(3);
    expect(parsed.data.revision).toBeGreaterThanOrEqual(1);
    // 目标以人工授权快照为准（含列 / 标签 / 负责人），不再只固定 apiBase/项目/工作区
    expect(parsed.data.target).toEqual({
      apiBase: "http://kaneo.test/api",
      projectId: "proj-1",
      workspaceId: "ws-1",
      columnId: "col-db-id",
      columnSlug: "triage",
      labelIds: ["label-bug"],
      assigneeId: null,
    });
    expect(parsed.data.upload?.outcome).toBe("confirmed");
    expect(parsed.data.upload?.key).toContain("task-");
    expect(parsed.data.upload?.expiresAt).toBeNull(); // mock 预签名无签名参数 → 未知
    expect(parsed.data.asset).toEqual({
      id: `asset-${row?.kaneo_task_id}`,
      url: `http://kaneo.test/assets/asset-${row?.kaneo_task_id}.png`,
    });
    expect(parsed.data.comment?.outcome).toBe("confirmed");
    expect(parsed.data.comment?.marker).toBe(commentMarker(row!.id, shot!.sha256));
    // 凭证不落明文、不回传管理页
    const raw = row?.archive_data_json ?? "";
    expect(raw).not.toContain("http://kaneo.test/upload/");
    const detail = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/feedback/${res.data.feedbackId}`, {
      cookie: h.cookie,
    });
    expect(detail.text).not.toContain("http://kaneo.test/upload/");
    expect(detail.text).not.toContain("credentialsEnc");
    // 用主密钥可解密还原预签名 URL 与请求头
    const creds = decryptUploadCredentials(h.feedbackApp.config.masterKey, parsed.data.upload?.credentialsEnc ?? "");
    expect(creds.uploadUrl).toBe(`http://kaneo.test/upload/${row?.kaneo_task_id}`);
    expect(creds.headers).toEqual({ "content-type": "image/png" });
  });

  it("archive_data_json 损坏或版本未知 → needs_review，零远端写入", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle(); // AI 整理
    // 契约变更：先经管理员显式授权完成首轮归档，供后续损坏数据对照“零新增远端写入”
    const auth = await authorizeArchive(h, r.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, r.data.feedbackId)?.status).toBe("archived");

    // 损坏数据 → 重开流程转入待核对，不再创建任务/上传
    updateFeedback(h.feedbackApp.db, r.data.feedbackId, {
      status: "received",
      archive_stage: "task_pending",
      archive_data_json: "{broken-json",
    });
    h.feedbackApp.worker.enqueue(r.data.feedbackId);
    await h.feedbackApp.worker.idle();
    let row = getFeedback(h.feedbackApp.db, r.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("归档恢复数据损坏");
    expect(h.kaneo.created.length).toBe(1);
    expect(h.kaneo.uploads.length).toBe(0);

    // 未知版本（v3 已受支持，用未来版本 v4 表示）→ 同样待核对
    updateFeedback(h.feedbackApp.db, r.data.feedbackId, {
      status: "received",
      archive_stage: "task_pending",
      archive_data_json: JSON.stringify({
        version: 4,
        revision: 1,
        target: { apiBase: "http://kaneo.test/api", projectId: "proj-1", workspaceId: "ws-1" },
      }),
    });
    h.feedbackApp.worker.enqueue(r.data.feedbackId);
    await h.feedbackApp.worker.idle();
    row = getFeedback(h.feedbackApp.db, r.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("v4 不受支持");
    expect(h.kaneo.created.length).toBe(1);
    expect(h.kaneo.uploads.length).toBe(0);
  });

  it("归档目标改变（apiBase）→ 停止待核对，不发出远端写入", async () => {
    const h = await makeHarness();
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    // 契约变更：先按当前连接授权并完成首轮归档，随后再注入“已固定到另一个实例”的恢复数据
    const auth = await authorizeArchive(h, r.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, r.data.feedbackId)?.status).toBe("archived");
    // 重开流程并预置已固定到另一个 Kaneo 实例的恢复数据
    updateFeedback(h.feedbackApp.db, r.data.feedbackId, {
      status: "received",
      kaneo_task_id: null,
      kaneo_task_url: null,
      archive_stage: "task_pending",
      archive_data_json: JSON.stringify({
        version: 1,
        revision: 1,
        target: { apiBase: "http://elsewhere.test/api", projectId: "proj-1", workspaceId: "ws-1" },
      }),
    });
    h.feedbackApp.worker.enqueue(r.data.feedbackId);
    await h.feedbackApp.worker.idle();
    const row = getFeedback(h.feedbackApp.db, r.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("归档恢复目标已改变");
    expect(h.kaneo.created.length).toBe(1); // 仍只有首次归档的创建，重开流程未再创建
    expect(h.kaneo.uploads.length).toBe(0);
  });

  it("同一目标密钥轮换允许继续归档", async () => {
    const h = await makeHarness();
    // 轮换 Kaneo API Key（目标 apiBase/项目/工作区不变）
    const rot = await jsonReq(h.feedbackApp.app, "PUT", "/api/admin/connection/kaneo", {
      cookie: h.cookie,
      body: { baseUrl: "http://kaneo.test/api", apiKey: "rotated-key" },
    });
    expect(rot.status).toBe(200);
    const r = await submitFeedback(h.feedbackApp, h.bearer, defaultSubmitBody());
    await h.feedbackApp.worker.idle();
    // 契约变更：密钥轮换后仍需管理员显式授权；授权快照在轮换后的当前设置下创建
    const auth = await authorizeArchive(h, r.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    expect(getFeedback(h.feedbackApp.db, r.data.feedbackId)?.status).toBe("archived");
    expect(h.kaneo.created.length).toBe(1);
  });

  it("持久化失败（凭证落盘时数据库不可写）→ 不向存储发送字节、不 finalize", async () => {
    const config = makeConfig();
    const inner = makeMockKaneo();
    let appDb: Db | null = null;
    const kaneo = {
      ...inner,
      async createImageUpload(taskId: string, input: Parameters<typeof inner.createImageUpload>[1]) {
        appDb?.close(); // 模拟磁盘故障：拿到地址后本地写入即刻不可用
        return inner.createImageUpload(taskId, input);
      },
    };
    const app = createApp(config, { ai: makeMockAi(), kaneo, workerSleep: instantSleep });
    appDb = app.db;
    const cookie = await loginAsAdmin(app);
    await seedConnections(app, cookie);
    await seedApp(app, cookie);
    const bearer = await loginAsClient(app);
    const res = await submitMultipartFeedback(app, bearer, defaultSubmitBody(), await createTestPng(40, 40));
    expect(res.status).toBe(201);
    await app.worker.idle();
    // 契约变更：归档需管理员显式授权（该用例的 kaneo mock 自定义，无法用 makeHarness）
    const auth = await authorizeArchive(asHarness(app, cookie), res.data.feedbackId);
    expect(auth.status).toBe(202);
    await app.worker.idle();
    // 目标已固定、任务已创建（此前的写入都成功）；凭证落盘失败后绝不传字节、不 finalize
    expect(inner.created.length).toBe(1);
    expect(inner.uploads.length).toBe(0);
    expect(inner.finalizes.length).toBe(0);
  });

  it("旧格式 assetUrl 记录恢复：先核对字节再迁移为 asset.url，不重复上传；核对失败→待核对", async () => {
    const h = await makeHarness();
    const png = await createTestPng(64, 48);
    const res = await submitMultipartFeedback(h.feedbackApp, h.bearer, defaultSubmitBody(), png);
    await h.feedbackApp.worker.idle();
    // 契约变更：先经管理员显式授权完成首轮归档，后续恢复沿用已固定目标
    const auth = await authorizeArchive(h, res.data.feedbackId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();
    const rowBefore = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(rowBefore?.status).toBe("archived");
    const legacyUrl = "http://kaneo.test/assets/legacy.png";
    // 让旧资产链接指向可核对的字节（与本地 PNG 完全一致，模拟“资产其实完好”）
    const stored = getFeedbackScreenshot(h.feedbackApp.db, res.data.feedbackId)!;
    h.kaneo.uploads.push({ taskId: legacyUrl, bytes: Buffer.from(stored.png_blob) });
    // 模拟旧版本服务端遗留：旧格式 archive_data + 已有任务 + 资产已登记但评论丢失
    h.kaneo.comments.length = 0;
    updateFeedback(h.feedbackApp.db, res.data.feedbackId, {
      status: "processing",
      kaneo_task_id: rowBefore?.kaneo_task_id ?? null,
      kaneo_task_url: rowBefore?.kaneo_task_url ?? null,
      archive_stage: "asset_finalized",
      archive_data_json: JSON.stringify({ assetUrl: legacyUrl }),
    });
    h.feedbackApp.worker.enqueue(res.data.feedbackId);
    await h.feedbackApp.worker.idle();
    let row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("archived");
    expect(h.kaneo.uploads.length).toBe(2); // 预置的可核对字节 + 首轮归档的上传，恢复未重传
    expect(h.kaneo.finalizes.length).toBe(1);
    expect(h.kaneo.comments.length).toBe(1);
    expect(h.kaneo.comments[0]?.content).toContain(legacyUrl);
    let parsed = parseArchiveData(row?.archive_data_json ?? null);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.data.asset?.url).toBe(legacyUrl);
    expect(parsed.data.asset?.id).toBe(""); // 旧格式无 id → 未知
    expect(parsed.data.comment?.outcome).toBe("confirmed");

    // 核对失败（404，不能证明文件不存在但也不能沿用）→ 待核对，不猜测重建
    h.kaneo.comments.length = 0;
    updateFeedback(h.feedbackApp.db, res.data.feedbackId, {
      status: "processing",
      archive_stage: "asset_finalized",
      archive_data_json: JSON.stringify({ assetUrl: "http://kaneo.test/assets/ghost.png" }),
    });
    h.feedbackApp.worker.enqueue(res.data.feedbackId);
    await h.feedbackApp.worker.idle();
    row = getFeedback(h.feedbackApp.db, res.data.feedbackId);
    expect(row?.status).toBe("needs_review");
    expect(row?.error_summary).toContain("旧格式记录资产核对失败");
    parsed = parseArchiveData(row?.archive_data_json ?? null);
    expect(parsed.kind).toBe("legacy"); // 未被改写
  });
});
