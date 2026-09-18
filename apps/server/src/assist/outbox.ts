import { randomBytes } from "node:crypto";
import { type Db, nowIso } from "../db/db.ts";

/**
 * Assist 接入（contracts/feedback-integration.md）事务内 outbox 写入。
 *
 * 启用与否按数据库句柄绑定（WeakMap）：未绑定即「接入关闭」，
 * 所有 enqueue 入口均为 no-op，业务行为零变化。
 * 调用方负责在业务事务内调用这些函数——outbox 行与业务写入同生共死，
 * 绝不出现「业务没落库但事件已发」或相反。
 */

/** 故障状态集合（契约 §3）：进入即 open/update fault，离开即 resolve。needs_info 不算故障。 */
const FAULT_STATUSES = new Set(["failed", "needs_review"]);

/** 事件标题上限（字符，按 codepoint 截断）。 */
const TITLE_MAX = 200;
/** 事件正文上限（字符）。 */
const BODY_MAX = 20_000;

/** 投递循环容量等运行时配置（由 createApp 在启用接入时绑定）。 */
export interface AssistRuntime {
  /** pending 事件上限；超出时丢弃最旧 pending 并补发 queue_overflow 汇总事件。 */
  queueMax: number;
}

const runtimes = new WeakMap<Db, AssistRuntime>();

/** 绑定/解绑某个数据库句柄的接入运行时配置。 */
export function bindAssistRuntime(db: Db, rt: AssistRuntime | null): void {
  if (rt) {
    runtimes.set(db, rt);
  } else {
    runtimes.delete(db);
  }
}

/** 当前句柄是否启用接入；未启用时全部 enqueue 均为 no-op。 */
export function assistRuntimeFor(db: Db): AssistRuntime | null {
  return runtimes.get(db) ?? null;
}

// ---------- eventId：fb_<ULID>（时间序 + 随机段，无需时钟回拨处理） ----------

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(at: number = Date.now()): string {
  let time = BigInt(Math.max(0, Math.floor(at)));
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ULID_CHARS[Number(time % 32n)]! + out;
    time /= 32n;
  }
  let rand = BigInt(`0x${randomBytes(10).toString("hex")}`);
  for (let i = 0; i < 16; i++) {
    out = ULID_CHARS[Number(rand % 32n)]! + out;
    rand /= 32n;
  }
  return out;
}

// ---------- 事件结构 ----------

export interface AssistAttachment {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  byteSize: number;
  sha256: string | null;
}

/** 单事件结构（api-v1 §2 事件对象；未适用字段为 null）。 */
export interface AssistEventInput {
  kind: string;
  severity: "info" | "warning" | "critical";
  faultKey: string | null;
  incidentAction: "open" | "update" | "resolve" | null;
  title: string;
  body: string | null;
  ref: Record<string, unknown> | null;
  attachments: AssistAttachment[] | null;
  occurredAt: string;
}

/** 按 codepoint 截断（标题/正文上限）。 */
function clipChars(s: string, max: number): string {
  const arr = Array.from(s);
  return arr.length <= max ? s : arr.slice(0, max).join("");
}

/** 取正文首行（去空白）；空文本返回空串。 */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** 日志附件 MIME（与 pipeline/worker 归档时的类型推断一致）。 */
function logAttachmentMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-jsonlines";
  return "text/plain";
}

// ---------- 事务内低层写入 ----------

/** 同事务内分配单调递增事件序号（assist_outbox_seq 单行计数器）。 */
function nextOutboxSeq(db: Db): number {
  db.prepare("INSERT INTO assist_outbox_seq (id, value) VALUES (1, 0) ON CONFLICT(id) DO NOTHING").run();
  db.prepare("UPDATE assist_outbox_seq SET value = value + 1 WHERE id = 1").run();
  const row = db.prepare("SELECT value FROM assist_outbox_seq WHERE id = 1").get() as { value: number | bigint };
  return Number(row.value);
}

/**
 * 事务内追加一条 pending outbox 事件（不做容量检查——queue_overflow
 * 标记自身也用此路径，避免连锁删除）。
 */
function insertAssistEventInTx(db: Db, ev: AssistEventInput): void {
  const id = `fb_${ulid()}`;
  const seq = nextOutboxSeq(db);
  const payload = {
    eventId: id,
    seq,
    kind: ev.kind,
    occurredAt: ev.occurredAt,
    severity: ev.severity,
    faultKey: ev.faultKey,
    incidentAction: ev.incidentAction,
    title: clipChars(ev.title, TITLE_MAX),
    body: ev.body === null ? null : clipChars(ev.body, BODY_MAX),
    ref: ev.ref,
    attachments: ev.attachments,
  };
  db.prepare(
    `INSERT INTO assist_outbox (id, seq, kind, payload_json, state, attempts, next_attempt_at, created_at, sent_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, NULL)`,
  ).run(id, seq, ev.kind, JSON.stringify(payload), nowIso());
}

/**
 * pending 容量上限（契约 §4）：新事件照常入队，超出部分丢弃最旧 pending，
 * 每删一批补发一条 queue_overflow 汇总事件（不计入本次上限检查）。
 */
function enforceOutboxCapInTx(db: Db, rt: AssistRuntime): void {
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM assist_outbox WHERE state = 'pending'").get() as
    | { n: number | bigint }
    | undefined;
  const pending = Number(countRow?.n ?? 0);
  const excess = pending - rt.queueMax;
  if (excess <= 0) return;
  const olds = db
    .prepare("SELECT seq, created_at FROM assist_outbox WHERE state = 'pending' ORDER BY seq ASC LIMIT ?")
    .all(excess) as { seq: number | bigint; created_at: string }[];
  if (olds.length === 0) return;
  const del = db.prepare("DELETE FROM assist_outbox WHERE seq = ?");
  for (const o of olds) del.run(o.seq);
  insertAssistEventInTx(db, {
    kind: "queue_overflow",
    severity: "warning",
    faultKey: null,
    incidentAction: null,
    title: `本地事件队列溢出：丢弃 ${olds.length} 条最旧待投递事件`,
    body: `队列上限 ${rt.queueMax}，本次丢弃 ${olds.length} 条（时间窗 ${olds[0]!.created_at} → ${
      olds[olds.length - 1]!.created_at
    }）`,
    ref: null,
    attachments: null,
    occurredAt: nowIso(),
  });
}

/** 通用入口：绑定运行时则追加事件并执行容量检查；未绑定则完全 no-op。 */
export function enqueueAssistEventInTx(db: Db, ev: AssistEventInput): void {
  const rt = assistRuntimeFor(db);
  if (!rt) return;
  insertAssistEventInTx(db, ev);
  enforceOutboxCapInTx(db, rt);
}

// ---------- 业务事件构造 ----------

export interface CreatedEventInput {
  id: string;
  appId: string;
  text: string;
  occurredAt: string;
  screenshot: { byteSize: number; sha256: string } | null;
  logs: { id: string; filename: string; byteSize: number; sha256: string }[];
}

/**
 * 反馈首次落库事件（契约 §3）：
 * severity=info，title=新反馈：<首行截断>，body=text（≤20000），
 * ref.feedbackId=id；截图/日志以附件描述符随事件上报（id 与回连下载路由一一对应）。
 */
export function enqueueFeedbackCreatedInTx(db: Db, input: CreatedEventInput): void {
  const rt = assistRuntimeFor(db);
  if (!rt) return;
  const attachments: AssistAttachment[] = [];
  if (input.screenshot) {
    attachments.push({
      id: "screenshot",
      kind: "screenshot",
      filename: "screenshot.png",
      mime: "image/png",
      byteSize: input.screenshot.byteSize,
      sha256: input.screenshot.sha256,
    });
  }
  for (const l of input.logs) {
    attachments.push({
      id: `logs/${l.id}`,
      kind: "log",
      filename: l.filename,
      mime: logAttachmentMime(l.filename),
      byteSize: l.byteSize,
      sha256: l.sha256,
    });
  }
  const summary = firstLine(input.text) || input.appId || input.id;
  enqueueAssistEventInTx(db, {
    kind: "feedback_created",
    severity: "info",
    faultKey: null,
    incidentAction: null,
    title: `新反馈：${summary}`,
    body: input.text,
    ref: { feedbackId: input.id },
    attachments: attachments.length > 0 ? attachments : null,
    occurredAt: input.occurredAt,
  });
}

/** 状态迁移事件需要的最小反馈快照（FeedbackRow 结构兼容）。 */
export interface TransitionSnapshot {
  id: string;
  status: string;
  title: string | null;
  text: string;
  error_summary: string | null;
  last_error: string | null;
}

/**
 * 状态迁移事件（契约 §3）：
 * - 非故障 → 故障：feedback_fault / open（新 faultKey 周期）
 * - 故障 → 故障（含故障期间再次恶化、仅错误字段更新）：feedback_fault / update
 * - 故障 → 非故障：feedback_recovered / resolve（retry 重新入队、resolve/recover、归档成功）
 * - 非故障 → 非故障：无事件
 */
export function enqueueStatusTransitionInTx(db: Db, prevStatus: string | null, after: TransitionSnapshot): void {
  const prevFault = prevStatus !== null && FAULT_STATUSES.has(prevStatus);
  const nowFault = FAULT_STATUSES.has(after.status);
  const short = after.title ?? firstLine(after.text) ?? after.id;
  if (nowFault) {
    const es = after.error_summary ?? "";
    const le = after.last_error ?? "";
    enqueueAssistEventInTx(db, {
      kind: "feedback_fault",
      severity: "warning",
      faultKey: `feedback:${after.id}`,
      incidentAction: prevFault ? "update" : "open",
      title: `反馈处理异常（${after.status}）：${es || short}`,
      body: `error_summary: ${es}\nlast_error: ${le}`,
      ref: { feedbackId: after.id },
      attachments: null,
      occurredAt: nowIso(),
    });
    return;
  }
  if (prevFault) {
    enqueueAssistEventInTx(db, {
      kind: "feedback_recovered",
      severity: "info",
      faultKey: `feedback:${after.id}`,
      incidentAction: "resolve",
      title: `反馈已恢复（${after.status}）：${short}`,
      body: `从 ${prevStatus} 恢复到 ${after.status}`,
      ref: { feedbackId: after.id },
      attachments: null,
      occurredAt: nowIso(),
    });
  }
}
