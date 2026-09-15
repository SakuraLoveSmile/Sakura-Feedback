import { decryptSecret, encryptSecret } from "../crypto/secret.ts";
import type { Db } from "../db/db.ts";
import { getFeedback, updateFeedback } from "../db/repos.ts";

/**
 * 归档恢复数据（计划 4.1 / L3 升级为 V2）。
 *
 * 复用 feedbacks.archive_data_json 单列，不新增表；Kaneo 任务 ID 继续使用
 * kaneo_task_id / kaneo_task_url 现有字段。
 * V2 结构：按稳定附件 ID 保存截图与每个日志的上传、资产、摘要、评论及替换记录；
 * 兼容读取 V1，保留既有目标、加密信息和 revision 检查。
 */

export const ARCHIVE_DATA_VERSION = 2;

/** 远端写入结果分类：尚未发送 / 已发出但结果未知 / 已确认成功响应。 */
export type WriteOutcome = "not_sent" | "maybe_sent" | "confirmed";

/** 首次远端写入前固定的恢复目标：Kaneo 实例 API 基址 + 项目 + 工作区。 */
export interface ArchiveTarget {
  apiBase: string;
  projectId: string;
  workspaceId: string;
}

/** 预签名上传信息。credentialsEnc 为 AES-GCM 密文（含 uploadUrl 与必要请求头），绝不回传管理页、不写日志。 */
export interface ArchiveUpload {
  key: string;
  credentialsEnc: string;
  /** 从签名参数可靠解析的到期时间（ISO）；无法解析记为 null（未知）。 */
  expiresAt: string | null;
  outcome: WriteOutcome;
  /** 对同一 key 的安全恢复（重传相同字节）已执行次数；缺省视为 0，上限 3 次。 */
  recoveries?: number;
}

/** 同一 key 的安全恢复上限（计划 4.3：同 key 安全恢复最多三次）。 */
export const MAX_SAME_KEY_RECOVERIES = 3;

export interface ArchiveAsset {
  /** Kaneo 资产 id；由旧格式迁移而来且无法得知时为 ""（未知）。 */
  id: string;
  url: string;
}

export interface ArchiveComment {
  /** 评论定位标记：`<feedbackId>|<sha256>` 或 `<feedbackId>|<logId>|<sha256>`。 */
  marker: string;
  /** Kaneo 评论 id；响应缺失时为 null。 */
  id: string | null;
  outcome: WriteOutcome;
}

/** V2 单个附件恢复记录（按稳定附件 ID 存储）。 */
export interface ArchiveAttachmentRecord {
  id: string;
  kind: "screenshot" | "log";
  filename: string;
  byteSize: number;
  sha256: string;
  upload?: ArchiveUpload;
  asset?: ArchiveAsset;
  comment?: ArchiveComment;
  replacedKeys?: string[];
}

export interface ArchiveDataV1 {
  version: 1;
  revision: number;
  target: ArchiveTarget;
  upload?: ArchiveUpload;
  asset?: ArchiveAsset;
  comment?: ArchiveComment;
  replacedKeys?: string[];
}

export interface ArchiveDataV2 {
  version: 2;
  revision: number;
  target: ArchiveTarget;
  attachments: Record<string, ArchiveAttachmentRecord>;
  // 顶层兼容镜像字段（保留截图的既有访问契约）
  upload?: ArchiveUpload;
  asset?: ArchiveAsset;
  comment?: ArchiveComment;
  replacedKeys?: string[];
}

export type ArchiveData = ArchiveDataV1 | ArchiveDataV2;

/** 保存时输入的新数据（version/revision 由 saveArchiveData 统一设置）。 */
export interface ArchiveDataNext {
  target: ArchiveTarget;
  attachments?: Record<string, ArchiveAttachmentRecord>;
  upload?: ArchiveUpload;
  asset?: ArchiveAsset;
  comment?: ArchiveComment;
  replacedKeys?: string[];
}

export type ParsedArchiveData =
  | { kind: "empty" }
  | { kind: "legacy"; assetUrl?: string }
  | { kind: "valid"; data: ArchiveData }
  | { kind: "corrupt"; reason: string }
  | { kind: "unsupported"; version: number };

/** 持久化前版本检查失败（损坏 / 未知版本 / revision 冲突）：拒绝覆盖，调用方必须转入待核对。 */
export class ArchiveVersionConflictError extends Error {}

/** SQLite 写入失败：禁止继续下一步远端写入。 */
export class ArchivePersistenceError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isWriteOutcome(v: unknown): v is WriteOutcome {
  return v === "not_sent" || v === "maybe_sent" || v === "confirmed";
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function fail(reason: string): { kind: "corrupt"; reason: string } {
  return { kind: "corrupt", reason };
}

function validateUpload(u: unknown): ArchiveUpload | null {
  if (!isRecord(u)) return null;
  const uKeys = Object.keys(u);
  if (uKeys.length !== 4 && uKeys.length !== 5) return null;
  if (uKeys.length === 5 && !uKeys.includes("recoveries")) return null;
  if (typeof u.key !== "string" || !u.key || u.key.length > 1024) return null;
  if (typeof u.credentialsEnc !== "string" || !u.credentialsEnc || u.credentialsEnc.length > 64 * 1024) return null;
  if (
    u.expiresAt !== null &&
    (typeof u.expiresAt !== "string" || !u.expiresAt || Number.isNaN(Date.parse(u.expiresAt)))
  ) {
    return null;
  }
  if (!isWriteOutcome(u.outcome)) return null;
  if (
    u.recoveries !== undefined &&
    (typeof u.recoveries !== "number" || !Number.isInteger(u.recoveries) || u.recoveries < 0 || u.recoveries > 1000)
  ) {
    return null;
  }
  return {
    key: u.key,
    credentialsEnc: u.credentialsEnc,
    expiresAt: u.expiresAt as string | null,
    outcome: u.outcome,
    ...(u.recoveries !== undefined ? { recoveries: u.recoveries as number } : {}),
  };
}

function validateAsset(a: unknown): ArchiveAsset | null {
  if (!isRecord(a)) return null;
  if (Object.keys(a).length !== 2) return null;
  if (typeof a.id !== "string" || a.id.length > 200) return null;
  if (typeof a.url !== "string" || !a.url || !isHttpUrl(a.url) || a.url.length > 2048) return null;
  return { id: a.id, url: a.url };
}

function validateComment(c: unknown): ArchiveComment | null {
  if (!isRecord(c)) return null;
  if (Object.keys(c).length !== 3) return null;
  if (typeof c.marker !== "string" || !c.marker || c.marker.length > 400) return null;
  if (c.id !== null && (typeof c.id !== "string" || c.id.length > 200)) return null;
  if (!isWriteOutcome(c.outcome)) return null;
  return { marker: c.marker, id: c.id as string | null, outcome: c.outcome };
}

function validateReplacedKeys(r: unknown): string[] | null {
  if (!Array.isArray(r)) return null;
  if (r.length > 20) return null;
  for (const k of r) {
    if (typeof k !== "string" || !k || k.length > 1024) return null;
  }
  return r as string[];
}

function validateTarget(t: unknown): ArchiveTarget | null {
  if (!isRecord(t)) return null;
  if (Object.keys(t).length !== 3) return null;
  if (typeof t.apiBase !== "string" || !t.apiBase || !isHttpUrl(t.apiBase)) return null;
  if (typeof t.projectId !== "string" || !t.projectId || t.projectId.length > 200) return null;
  if (typeof t.workspaceId !== "string" || !t.workspaceId || t.workspaceId.length > 200) return null;
  return { apiBase: t.apiBase, projectId: t.projectId, workspaceId: t.workspaceId };
}

/** 严格校验一段 V1 结构；任何不符都返回 null。 */
function validateV1(v: Record<string, unknown>): ArchiveDataV1 | null {
  const allowed = new Set(["version", "revision", "target", "upload", "asset", "comment", "replacedKeys"]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return null;
  }
  if (v.version !== 1) return null;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) return null;

  const target = validateTarget(v.target);
  if (!target) return null;

  let upload: ArchiveUpload | undefined;
  if (v.upload !== undefined) {
    const u = validateUpload(v.upload);
    if (!u) return null;
    upload = u;
  }

  let asset: ArchiveAsset | undefined;
  if (v.asset !== undefined) {
    const a = validateAsset(v.asset);
    if (!a) return null;
    asset = a;
  }

  let comment: ArchiveComment | undefined;
  if (v.comment !== undefined) {
    const c = validateComment(v.comment);
    if (!c) return null;
    comment = c;
  }

  let replacedKeys: string[] | undefined;
  if (v.replacedKeys !== undefined) {
    const r = validateReplacedKeys(v.replacedKeys);
    if (!r) return null;
    replacedKeys = r;
  }

  return {
    version: 1,
    revision: v.revision as number,
    target,
    ...(upload ? { upload } : {}),
    ...(asset ? { asset } : {}),
    ...(comment ? { comment } : {}),
    ...(replacedKeys ? { replacedKeys } : {}),
  };
}

function validateAttachmentRecord(id: string, att: Record<string, unknown>): ArchiveAttachmentRecord | null {
  const allowed = new Set([
    "id",
    "kind",
    "filename",
    "byteSize",
    "sha256",
    "upload",
    "asset",
    "comment",
    "replacedKeys",
  ]);
  for (const k of Object.keys(att)) {
    if (!allowed.has(k)) return null;
  }
  if (att.id !== undefined && att.id !== id) return null;
  const kind = att.kind;
  if (kind !== "screenshot" && kind !== "log") return null;
  if (typeof att.filename !== "string" || !att.filename) return null;
  if (typeof att.byteSize !== "number" || !Number.isInteger(att.byteSize) || att.byteSize < 0) return null;
  if (typeof att.sha256 !== "string") return null;

  let upload: ArchiveUpload | undefined;
  if (att.upload !== undefined) {
    const u = validateUpload(att.upload);
    if (!u) return null;
    upload = u;
  }

  let asset: ArchiveAsset | undefined;
  if (att.asset !== undefined) {
    const a = validateAsset(att.asset);
    if (!a) return null;
    asset = a;
  }

  let comment: ArchiveComment | undefined;
  if (att.comment !== undefined) {
    const c = validateComment(att.comment);
    if (!c) return null;
    comment = c;
  }

  let replacedKeys: string[] | undefined;
  if (att.replacedKeys !== undefined) {
    const r = validateReplacedKeys(att.replacedKeys);
    if (!r) return null;
    replacedKeys = r;
  }

  return {
    id,
    kind,
    filename: att.filename,
    byteSize: att.byteSize,
    sha256: att.sha256,
    ...(upload ? { upload } : {}),
    ...(asset ? { asset } : {}),
    ...(comment ? { comment } : {}),
    ...(replacedKeys ? { replacedKeys } : {}),
  };
}

/** 严格校验一段 V2 结构；任何不符都返回 null。 */
function validateV2(v: Record<string, unknown>): ArchiveDataV2 | null {
  const allowed = new Set([
    "version",
    "revision",
    "target",
    "attachments",
    "upload",
    "asset",
    "comment",
    "replacedKeys",
  ]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return null;
  }
  if (v.version !== 2) return null;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) return null;

  const target = validateTarget(v.target);
  if (!target) return null;

  const attachments: Record<string, ArchiveAttachmentRecord> = {};
  if (v.attachments !== undefined) {
    if (!isRecord(v.attachments)) return null;
    for (const [attId, attVal] of Object.entries(v.attachments)) {
      if (!isRecord(attVal)) return null;
      const attRecord = validateAttachmentRecord(attId, attVal);
      if (!attRecord) return null;
      attachments[attId] = attRecord;
    }
  }

  let upload: ArchiveUpload | undefined;
  if (v.upload !== undefined) {
    const u = validateUpload(v.upload);
    if (!u) return null;
    upload = u;
  }

  let asset: ArchiveAsset | undefined;
  if (v.asset !== undefined) {
    const a = validateAsset(v.asset);
    if (!a) return null;
    asset = a;
  }

  let comment: ArchiveComment | undefined;
  if (v.comment !== undefined) {
    const c = validateComment(v.comment);
    if (!c) return null;
    comment = c;
  }

  let replacedKeys: string[] | undefined;
  if (v.replacedKeys !== undefined) {
    const r = validateReplacedKeys(v.replacedKeys);
    if (!r) return null;
    replacedKeys = r;
  }

  // 截图附件与顶层字段镜像同步
  if (attachments.screenshot) {
    if (!upload && attachments.screenshot.upload) upload = attachments.screenshot.upload;
    if (!asset && attachments.screenshot.asset) asset = attachments.screenshot.asset;
    if (!comment && attachments.screenshot.comment) comment = attachments.screenshot.comment;
    if (!replacedKeys && attachments.screenshot.replacedKeys) replacedKeys = attachments.screenshot.replacedKeys;
  } else if (upload || asset || comment || replacedKeys) {
    attachments.screenshot = {
      id: "screenshot",
      kind: "screenshot",
      filename: "screenshot.png",
      byteSize: 0,
      sha256: comment?.marker.split("|")[1] ?? "",
      ...(upload ? { upload } : {}),
      ...(asset ? { asset } : {}),
      ...(comment ? { comment } : {}),
      ...(replacedKeys ? { replacedKeys } : {}),
    };
  }

  return {
    version: 2,
    revision: v.revision as number,
    target,
    attachments,
    ...(upload ? { upload } : {}),
    ...(asset ? { asset } : {}),
    ...(comment ? { comment } : {}),
    ...(replacedKeys ? { replacedKeys } : {}),
  };
}

/** 将 V1 归档数据无损转为 V2 内存表示。 */
export function normalizeToV2(data: ArchiveData): ArchiveDataV2 {
  if (data.version === 2) return data;
  const attachments: Record<string, ArchiveAttachmentRecord> = {};
  if (data.upload || data.asset || data.comment || data.replacedKeys) {
    attachments.screenshot = {
      id: "screenshot",
      kind: "screenshot",
      filename: "screenshot.png",
      byteSize: 0,
      sha256: data.comment?.marker.split("|")[1] ?? "",
      ...(data.upload ? { upload: data.upload } : {}),
      ...(data.asset ? { asset: data.asset } : {}),
      ...(data.comment ? { comment: data.comment } : {}),
      ...(data.replacedKeys ? { replacedKeys: data.replacedKeys } : {}),
    };
  }
  return {
    version: 2,
    revision: data.revision,
    target: data.target,
    attachments,
    ...(data.upload ? { upload: data.upload } : {}),
    ...(data.asset ? { asset: data.asset } : {}),
    ...(data.comment ? { comment: data.comment } : {}),
    ...(data.replacedKeys ? { replacedKeys: data.replacedKeys } : {}),
  };
}

/**
 * 解析 archive_data_json：
 * - 空/空白 → empty；
 * - 旧格式（无 version，仅 { assetUrl? }）→ legacy（assetUrl 供迁移，不猜其他信息）；
 * - version:1 且合法 → valid (ArchiveDataV1)；
 * - version:2 且合法 → valid (ArchiveDataV2)；
 * - version 存在但不是 1 或 2 → unsupported（可能由未来版本的服务端写入，绝不覆盖）；
 * - 其余（JSON 损坏、类型不符、缺字段、未知字段）→ corrupt。
 */
export function parseArchiveData(raw: string | null | undefined): ParsedArchiveData {
  if (raw === null || raw === undefined || raw.trim() === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`JSON 解析失败: ${(err as Error).message?.slice(0, 120)}`);
  }
  if (!isRecord(parsed)) return fail("不是 JSON 对象");
  const version = parsed.version;
  if (version === undefined) {
    const keys = Object.keys(parsed);
    const legacyOk =
      keys.every((k) => k === "assetUrl") && (parsed.assetUrl === undefined || typeof parsed.assetUrl === "string");
    if (!legacyOk) return fail("缺少 version 且不符合旧格式（仅允许 assetUrl）");
    const assetUrl = typeof parsed.assetUrl === "string" ? parsed.assetUrl : undefined;
    return { kind: "legacy", ...(assetUrl !== undefined ? { assetUrl } : {}) };
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail(`version 不是整数: ${String(version)}`);
  }
  if (version === 1) {
    const data = validateV1(parsed);
    if (!data) return fail("v1 结构校验失败（字段缺失/类型不符/未知字段）");
    return { kind: "valid", data };
  }
  if (version === 2) {
    const data = validateV2(parsed);
    if (!data) return fail("v2 结构校验失败（字段缺失/类型不符/未知字段）");
    return { kind: "valid", data };
  }
  return { kind: "unsupported", version };
}

/** 固定键序序列化：先做写前严格校验，再输出规范化 JSON，保证落盘内容必然可回读（V2）。 */
export function serializeArchiveData(next: ArchiveDataNext, revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ArchiveVersionConflictError(`revision 非法: ${String(revision)}`);
  }
  const attachments: Record<string, ArchiveAttachmentRecord> = {};
  if (next.attachments) {
    for (const [k, v] of Object.entries(next.attachments)) {
      attachments[k] = v;
    }
  }
  let upload = next.upload;
  let asset = next.asset;
  let comment = next.comment;
  let replacedKeys = next.replacedKeys;

  if (attachments.screenshot) {
    if (!upload && attachments.screenshot.upload) upload = attachments.screenshot.upload;
    if (!asset && attachments.screenshot.asset) asset = attachments.screenshot.asset;
    if (!comment && attachments.screenshot.comment) comment = attachments.screenshot.comment;
    if (!replacedKeys && attachments.screenshot.replacedKeys) replacedKeys = attachments.screenshot.replacedKeys;
  } else if (upload || asset || comment || replacedKeys) {
    attachments.screenshot = {
      id: "screenshot",
      kind: "screenshot",
      filename: "screenshot.png",
      byteSize: 0,
      sha256: comment?.marker.split("|")[1] ?? "",
      ...(upload ? { upload } : {}),
      ...(asset ? { asset } : {}),
      ...(comment ? { comment } : {}),
      ...(replacedKeys ? { replacedKeys } : {}),
    };
  }

  const probe = validateV2({
    version: ARCHIVE_DATA_VERSION,
    revision,
    target: next.target,
    attachments,
    ...(upload !== undefined ? { upload } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(replacedKeys !== undefined ? { replacedKeys } : {}),
  });
  if (!probe) throw new ArchiveVersionConflictError("归档数据未通过写前严格校验，拒绝保存");
  return JSON.stringify(probe);
}

/** 从数据库读取并解析当前归档数据（每次保存前重新读取，作版本检查基准）。 */
export function loadArchiveData(db: Db, feedbackId: string): ParsedArchiveData {
  const row = getFeedback(db, feedbackId);
  return parseArchiveData(row?.archive_data_json ?? null);
}

/**
 * 保存下一版归档数据（4.1 持久化 / L3 升级为 V2）：
 * - 保存前重新读取磁盘数据做版本检查：损坏 / 未知版本 → 拒绝覆盖（ArchiveVersionConflictError）；
 * - 期间被并发修改（revision 与调用方基准不一致）→ 拒绝覆盖；
 * - 仅从 empty / legacy / 合法 v1 / 合法 v2 之上写入；revision 单调递增，落盘 version 恒为 2；
 * - SQLite 写入失败抛 ArchivePersistenceError，调用方不得继续下一步远端写入。
 */
export function saveArchiveData(
  db: Db,
  feedbackId: string,
  base: ParsedArchiveData,
  next: ArchiveDataNext,
): ArchiveDataV2 {
  if (base.kind === "corrupt") {
    throw new ArchiveVersionConflictError(`归档数据损坏，拒绝覆盖: ${base.reason}`);
  }
  if (base.kind === "unsupported") {
    throw new ArchiveVersionConflictError(`归档数据版本 v${base.version} 不受支持，拒绝覆盖`);
  }
  let fresh: ParsedArchiveData;
  try {
    fresh = loadArchiveData(db, feedbackId);
  } catch (err) {
    throw new ArchivePersistenceError(`归档恢复数据读取失败: ${(err as Error).message?.slice(0, 150)}`);
  }
  if (fresh.kind === "corrupt" || fresh.kind === "unsupported") {
    throw new ArchiveVersionConflictError(
      fresh.kind === "corrupt"
        ? `归档数据已损坏，拒绝覆盖: ${fresh.reason}`
        : `归档数据版本 v${fresh.version} 不受支持，拒绝覆盖`,
    );
  }
  const expectedRevision = fresh.kind === "valid" ? fresh.data.revision : 0;
  const baseRevision = base.kind === "valid" ? base.data.revision : 0;
  if (expectedRevision !== baseRevision) {
    throw new ArchiveVersionConflictError(`归档数据已被并发修改（磁盘 v${expectedRevision}，基准 v${baseRevision}）`);
  }
  const revision = expectedRevision + 1;
  let json: string;
  try {
    json = serializeArchiveData(next, revision);
  } catch (err) {
    if (err instanceof ArchiveVersionConflictError) throw err;
    throw new ArchivePersistenceError(`归档恢复数据序列化失败: ${(err as Error).message?.slice(0, 150)}`);
  }
  try {
    updateFeedback(db, feedbackId, { archive_data_json: json });
  } catch (err) {
    throw new ArchivePersistenceError(`归档恢复信息写入 SQLite 失败: ${(err as Error).message?.slice(0, 150)}`);
  }
  return JSON.parse(json) as ArchiveDataV2;
}

// ---------- 恢复目标固定与变更检测 ----------

export type TargetCheck =
  | { status: "fresh" }
  | { status: "same" }
  | { status: "changed"; field: "apiBase" | "projectId" | "workspaceId" };

/** 比较已固定目标与当前解析出的目标。 */
export function checkArchiveTarget(existing: ArchiveData | null, target: ArchiveTarget): TargetCheck {
  if (!existing) return { status: "fresh" };
  const pinned = existing.target;
  if (pinned.apiBase !== target.apiBase) return { status: "changed", field: "apiBase" };
  if (pinned.projectId !== target.projectId) return { status: "changed", field: "projectId" };
  if (pinned.workspaceId !== target.workspaceId) return { status: "changed", field: "workspaceId" };
  return { status: "same" };
}

// ---------- 预签名凭证加密与到期解析 ----------

export interface UploadCredentials {
  uploadUrl: string;
  headers: Record<string, string>;
}

export function encryptUploadCredentials(masterKey: Buffer, creds: UploadCredentials): string {
  return encryptSecret(masterKey, JSON.stringify(creds));
}

export function decryptUploadCredentials(masterKey: Buffer, credentialsEnc: string): UploadCredentials {
  let plain: string;
  try {
    plain = decryptSecret(masterKey, credentialsEnc);
  } catch (err) {
    throw new Error(`预签名凭证解密失败（主密钥不匹配或密文损坏）: ${(err as Error).message?.slice(0, 100)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error("预签名凭证明文不是 JSON");
  }
  if (!isRecord(parsed)) throw new Error("预签名凭证明文结构非法");
  if (typeof parsed.uploadUrl !== "string" || !parsed.uploadUrl || !isHttpUrl(parsed.uploadUrl)) {
    throw new Error("预签名凭证缺少合法 uploadUrl");
  }
  const headers: Record<string, string> = {};
  if (parsed.headers !== undefined) {
    if (!isRecord(parsed.headers)) throw new Error("预签名凭证 headers 结构非法");
    for (const [k, v] of Object.entries(parsed.headers)) {
      if (typeof v !== "string") throw new Error("预签名凭证 headers 含非字符串值");
      headers[k] = v;
    }
  }
  return { uploadUrl: parsed.uploadUrl, headers };
}

export function parsePresignedExpiry(uploadUrl: string): string | null {
  const MAX_EXPIRES_SECONDS = 30 * 24 * 3600;
  try {
    const u = new URL(uploadUrl);
    const amzDate = u.searchParams.get("X-Amz-Date");
    const amzExpires = u.searchParams.get("X-Amz-Expires");
    if (amzDate !== null || amzExpires !== null) {
      if (amzDate === null || amzExpires === null) return null;
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
      const secs = Number(amzExpires);
      if (!m || !Number.isInteger(secs) || secs < 0 || secs > MAX_EXPIRES_SECONDS) return null;
      const [, y, mo, d, h, mi, s] = m as unknown as string[];
      const start = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
      if (Number.isNaN(start)) return null;
      return new Date(start + secs * 1000).toISOString();
    }
    const legacy = u.searchParams.get("Expires");
    if (legacy !== null) {
      const t = Number(legacy);
      if (!Number.isInteger(t) || t <= 0) return null;
      return new Date(t * 1000).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

export function buildUploadRecord(
  masterKey: Buffer,
  presigned: { key: string; uploadUrl: string; headers: Record<string, string> },
  outcome: WriteOutcome,
): ArchiveUpload {
  return {
    key: presigned.key,
    credentialsEnc: encryptUploadCredentials(masterKey, { uploadUrl: presigned.uploadUrl, headers: presigned.headers }),
    expiresAt: parsePresignedExpiry(presigned.uploadUrl),
    outcome,
    recoveries: 0,
  };
}

export function commentMarker(feedbackId: string, screenshotSha256: string): string {
  return `${feedbackId}|${screenshotSha256}`;
}

/** 日志附件评论定位标记：`<feedbackId>|<logId>|<sha256>`。 */
export function logCommentMarker(feedbackId: string, logId: string, sha256: string): string {
  return `${feedbackId}|${logId}|${sha256}`;
}
