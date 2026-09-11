import { decryptSecret, encryptSecret } from "../crypto/secret.ts";
import type { Db } from "../db/db.ts";
import { getFeedback, updateFeedback } from "../db/repos.ts";

/**
 * 归档恢复数据（计划 4.1）。
 *
 * 复用 feedbacks.archive_data_json 单列，不新增表；Kaneo 任务 ID 继续使用
 * kaneo_task_id / kaneo_task_url 现有字段。结构版本化（version:1）并严格校验：
 * 解析失败、缺字段、类型不符、未知字段、未知版本一律分类为待核对信号，
 * 绝不猜测重建，也绝不批量改写现有数据库。
 */

export const ARCHIVE_DATA_VERSION = 1;

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
  /** 评论定位标记：`<feedbackId>|<图片sha256>`。 */
  marker: string;
  /** Kaneo 评论 id；响应缺失时为 null。 */
  id: string | null;
  outcome: WriteOutcome;
}

export interface ArchiveDataV1 {
  version: 1;
  revision: number;
  target: ArchiveTarget;
  upload?: ArchiveUpload;
  asset?: ArchiveAsset;
  comment?: ArchiveComment;
  /**
   * 被替换掉的旧上传 key 列表（4.4 replace_upload：保留旧 key 恢复记录；
   * 远端对象不自动删除，此列表用于追溯哪些对象仍留在存储中）。
   */
  replacedKeys?: string[];
}

/** 保存时输入的新数据（version/revision 由 saveArchiveData 统一设置）。 */
export type ArchiveDataNext = Omit<ArchiveDataV1, "version" | "revision">;

export type ParsedArchiveData =
  | { kind: "empty" }
  | { kind: "legacy"; assetUrl?: string }
  | { kind: "valid"; data: ArchiveDataV1 }
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

/** 严格校验一段 V1 结构；任何不符都返回 null（由调用方归类为损坏）。 */
function validateV1(v: Record<string, unknown>): ArchiveDataV1 | null {
  const allowed = new Set(["version", "revision", "target", "upload", "asset", "comment", "replacedKeys"]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return null; // 未知字段：宁可当损坏也不静默丢弃
  }
  if (v.version !== ARCHIVE_DATA_VERSION) return null;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) return null;

  const t = v.target;
  if (!isRecord(t)) return null;
  if (Object.keys(t).length !== 3) return null;
  if (typeof t.apiBase !== "string" || !t.apiBase || !isHttpUrl(t.apiBase)) return null;
  if (typeof t.projectId !== "string" || !t.projectId || t.projectId.length > 200) return null;
  if (typeof t.workspaceId !== "string" || !t.workspaceId || t.workspaceId.length > 200) return null;

  let upload: ArchiveUpload | undefined;
  if (v.upload !== undefined) {
    const u = v.upload;
    if (!isRecord(u)) return null;
    const uKeys = Object.keys(u);
    // 4 键 = t3 之前写入的记录；5 键 = 带 recoveries 计数
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
    upload = {
      key: u.key,
      credentialsEnc: u.credentialsEnc,
      expiresAt: u.expiresAt as string | null,
      outcome: u.outcome,
      ...(u.recoveries !== undefined ? { recoveries: u.recoveries as number } : {}),
    };
  }

  let asset: ArchiveAsset | undefined;
  if (v.asset !== undefined) {
    const a = v.asset;
    if (!isRecord(a)) return null;
    if (Object.keys(a).length !== 2) return null;
    if (typeof a.id !== "string" || a.id.length > 200) return null;
    if (typeof a.url !== "string" || !a.url || !isHttpUrl(a.url) || a.url.length > 2048) return null;
    asset = { id: a.id, url: a.url };
  }

  let replacedKeys: string[] | undefined;
  if (v.replacedKeys !== undefined) {
    if (!Array.isArray(v.replacedKeys)) return null;
    if (v.replacedKeys.length > 20) return null;
    for (const k of v.replacedKeys) {
      if (typeof k !== "string" || !k || k.length > 1024) return null;
    }
    replacedKeys = v.replacedKeys as string[];
  }

  let comment: ArchiveComment | undefined;
  if (v.comment !== undefined) {
    const c = v.comment;
    if (!isRecord(c)) return null;
    if (Object.keys(c).length !== 3) return null;
    if (typeof c.marker !== "string" || !c.marker || c.marker.length > 400) return null;
    if (c.id !== null && (typeof c.id !== "string" || c.id.length > 200)) return null;
    if (!isWriteOutcome(c.outcome)) return null;
    comment = { marker: c.marker, id: c.id as string | null, outcome: c.outcome };
  }

  return {
    version: 1,
    revision: v.revision as number,
    target: { apiBase: t.apiBase, projectId: t.projectId, workspaceId: t.workspaceId },
    ...(upload ? { upload } : {}),
    ...(asset ? { asset } : {}),
    ...(comment ? { comment } : {}),
    ...(replacedKeys ? { replacedKeys } : {}),
  };
}

/**
 * 解析 archive_data_json：
 * - 空/空白 → empty；
 * - 旧格式（无 version，仅 { assetUrl? }）→ legacy（assetUrl 供迁移，不猜其他信息）；
 * - version:1 且严格合法 → valid；
 * - version 存在但不是 1 → unsupported（可能由更新版本的服务端写入，绝不覆盖）；
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
    // 旧格式仅允许 { assetUrl?: string }
    const keys = Object.keys(parsed);
    const legacyOk =
      keys.every((k) => k === "assetUrl") && (parsed.assetUrl === undefined || typeof parsed.assetUrl === "string");
    if (!legacyOk) return fail("缺少 version 且不符合旧格式（仅允许 assetUrl）");
    const assetUrl = typeof parsed.assetUrl === "string" ? parsed.assetUrl : undefined;
    return { kind: "legacy", ...(assetUrl !== undefined ? { assetUrl } : {}) };
  }
  if (version !== ARCHIVE_DATA_VERSION) {
    if (typeof version !== "number" || !Number.isInteger(version)) return fail(`version 不是整数: ${String(version)}`);
    return { kind: "unsupported", version };
  }
  const data = validateV1(parsed);
  if (!data) return fail("v1 结构校验失败（字段缺失/类型不符/未知字段）");
  return { kind: "valid", data };
}

/** 固定键序序列化：先做写前严格校验，再输出规范化 JSON，保证落盘内容必然可回读。 */
export function serializeArchiveData(next: ArchiveDataNext, revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ArchiveVersionConflictError(`revision 非法: ${String(revision)}`);
  }
  const probe = validateV1({
    version: ARCHIVE_DATA_VERSION,
    revision,
    target: next.target,
    ...(next.upload !== undefined ? { upload: next.upload } : {}),
    ...(next.asset !== undefined ? { asset: next.asset } : {}),
    ...(next.comment !== undefined ? { comment: next.comment } : {}),
    ...(next.replacedKeys !== undefined ? { replacedKeys: next.replacedKeys } : {}),
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
 * 保存下一版归档数据（4.1 持久化）：
 * - 保存前重新读取磁盘数据做版本检查：损坏 / 未知版本 → 拒绝覆盖（ArchiveVersionConflictError）；
 * - 期间被并发修改（revision 与调用方基准不一致）→ 拒绝覆盖；
 * - 仅从 empty / legacy / 合法 v1 之上写入；revision 单调递增，version 恒为 1；
 * - SQLite 写入失败抛 ArchivePersistenceError，调用方不得继续下一步远端写入。
 */
export function saveArchiveData(
  db: Db,
  feedbackId: string,
  base: ParsedArchiveData,
  next: ArchiveDataNext,
): ArchiveDataV1 {
  if (base.kind === "corrupt") {
    throw new ArchiveVersionConflictError(`归档数据损坏，拒绝覆盖: ${base.reason}`);
  }
  if (base.kind === "unsupported") {
    throw new ArchiveVersionConflictError(`归档数据版本 v${base.version} 不受支持，拒绝覆盖`);
  }
  // 保存前版本检查：以磁盘当前内容为准
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
  return JSON.parse(json) as ArchiveDataV1;
}

// ---------- 恢复目标固定与变更检测 ----------

export type TargetCheck =
  | { status: "fresh" } // 尚无目标，允许固定
  | { status: "same" } // 与已固定目标一致（密钥轮换不影响该判定）
  | { status: "changed"; field: "apiBase" | "projectId" | "workspaceId" };

/** 比较已固定目标与当前解析出的目标。 */
export function checkArchiveTarget(existing: ArchiveDataV1 | null, target: ArchiveTarget): TargetCheck {
  if (!existing) return { status: "fresh" };
  const pinned = existing.target;
  if (pinned.apiBase !== target.apiBase) return { status: "changed", field: "apiBase" };
  if (pinned.projectId !== target.projectId) return { status: "changed", field: "projectId" };
  if (pinned.workspaceId !== target.workspaceId) return { status: "changed", field: "workspaceId" };
  return { status: "same" };
}

// ---------- 预签名凭证加密与到期解析 ----------

/** 预签名上传凭证（明文形态，仅在服务端内存中存在）。 */
export interface UploadCredentials {
  uploadUrl: string;
  headers: Record<string, string>;
}

/** 用现有 AES-256-GCM 工具加密预签名 URL 与必要请求头。 */
export function encryptUploadCredentials(masterKey: Buffer, creds: UploadCredentials): string {
  return encryptSecret(masterKey, JSON.stringify(creds));
}

/** 解密预签名凭证；密文被篡改 / 主密钥不匹配 / 结构非法时抛错（由调用方转入待核对）。 */
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

/**
 * 从预签名 URL 的签名参数可靠解析到期时间（ISO 字符串）：
 * - AWS SigV4：X-Amz-Date（YYYYMMDDTHHMMSSZ）+ X-Amz-Expires（秒，≤30 天）；
 * - v2 签名：Expires（epoch 秒）；
 * - 参数缺失、非法或超出合理范围 → null（未知）。绝不抛错。
 */
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

/** 由预签名响应构造 upload 恢复记录（凭证加密，到期尽力解析，恢复计数从 0 起）。 */
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

/** 评论定位标记：反馈 ID + 图片摘要足以唯一确定截图评论。 */
export function commentMarker(feedbackId: string, screenshotSha256: string): string {
  return `${feedbackId}|${screenshotSha256}`;
}
