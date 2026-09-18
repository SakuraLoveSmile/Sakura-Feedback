import type { Db } from "../db/db.ts";
import { nowIso } from "../db/db.ts";

/**
 * Assist 接入投递 worker（contracts/feedback-integration.md §4）。
 *
 * 与业务请求、pipeline worker 完全独立：每周期从 assist_outbox 取
 * ≤50 条到期 pending 事件（seq 升序）POST 到中枢 ingest 接口；
 * 失败按持久化退避重试，401 停发并周期探测；绝不阻塞业务。
 * 与业务事务不在同一事务——投递失败只影响自身重试。
 */

export interface AssistWorkerDeps {
  db: Db;
  /** 中枢基地址（自动去尾部斜杠）。 */
  hubUrl: string;
  /** 事件上报 Bearer（FEEDBACK_ASSIST_SOURCE_KEY）。 */
  sourceKey: string;
  /** 空闲休眠毫秒（无到期事件时的轮询间隔）。 */
  flushMs: number;
  /** 可注入（测试用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 可注入时钟（毫秒）；默认 Date.now。 */
  now?: () => number;
  /** 单批最大条数，默认 50（契约上限）。 */
  batchSize?: number;
  /** 401 后的探测间隔毫秒，默认 5 分钟。 */
  authPauseMs?: number;
  /** rejected 事件被连续拒绝达到此次数 → 标 dead（不再投递），默认 10。 */
  deadAfterAttempts?: number;
  /** 终态行保留毫秒，默认 7 天（sent 按 sent_at、dead 按 created_at）。 */
  retentionMs?: number;
  /** 终态清理间隔毫秒，默认 24 小时（worker 启动时总会先跑一次）。 */
  cleanupIntervalMs?: number;
  /** 单批 HTTP 请求（含响应体读取）的整体超时毫秒，默认 30 秒。 */
  requestTimeoutMs?: number;
}

export interface AssistWorker {
  /** 停止调度新工作（在途批次会跑完）；幂等。 */
  stop(): void;
  /** 等待循环完全退出（含在途批次）；配合 stop() 使用。 */
  idle(): Promise<void>;
}

/** 契约退避阶梯：1s → 2s → 5s → 30s → 5min（封顶）。 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 30_000, 300_000] as const;

interface OutboxRow {
  id: string;
  seq: number | bigint;
  payload_json: string;
  attempts: number | bigint;
}

export function createAssistWorker(deps: AssistWorkerDeps): AssistWorker {
  const db = deps.db;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const batchSize = deps.batchSize ?? 50;
  const authPauseMs = deps.authPauseMs ?? 5 * 60 * 1000;
  const deadAfter = deps.deadAfterAttempts ?? 10;
  const retentionMs = deps.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const cleanupIntervalMs = deps.cleanupIntervalMs ?? 24 * 60 * 60 * 1000;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 30_000;
  const hub = deps.hubUrl.replace(/\/+$/, "");
  let stopped = false;
  /** 401 停发截止（毫秒时间戳）；期间不再发起任何请求。 */
  let authPausedUntil = 0;
  let wake: (() => void) | null = null;
  let activeAbort: AbortController | null = null;

  /** 可中断休眠（stop() 提前唤醒）。 */
  function wait(ms: number): Promise<void> {
    if (ms <= 0 || stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      t.unref?.();
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }

  /** 新尝试次数对应的退避毫秒（attempts 从 1 起）。 */
  function backoffMs(attempts: number): number {
    const idx = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
    return BACKOFF_MS[idx]!;
  }

  /** 到期 pending 批次：next_attempt_at 为空或已到点，seq 升序，≤batchSize。 */
  function dueBatch(nowStr: string): OutboxRow[] {
    return db
      .prepare(
        `SELECT id, seq, payload_json, attempts FROM assist_outbox
         WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(nowStr, batchSize) as unknown as OutboxRow[];
  }

  /** 最近的 pending 到期时间（毫秒）；无则 null。 */
  function nextDueMs(): number | null {
    const row = db
      .prepare(
        "SELECT MIN(next_attempt_at) AS nxt FROM assist_outbox WHERE state = 'pending' AND next_attempt_at IS NOT NULL",
      )
      .get() as { nxt: string | null } | undefined;
    if (!row?.nxt) return null;
    const ms = new Date(row.nxt).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * 持久化标记：送达行置 sent（sent_at 落库）；重试行 attempts+1 并写
   * 下次到期时间——崩溃重启后不会重复投递也不会丢重试。
   * `allowDead` 的重试行达到 deadAfter 次仍未被接受 → 标 dead（行保留可查、记日志，
   * 绝不静默丢弃；传输类故障不适用——中枢不可达的事件永不被判死）。
   */
  function applyMarks(sent: { id: string }[], retries: { id: string; attempts: number; allowDead: boolean }[]): void {
    const run = () => {
      const sentAt = nowIso();
      const sentStmt = db.prepare("UPDATE assist_outbox SET state = 'sent', sent_at = ? WHERE id = ?");
      for (const r of sent) sentStmt.run(sentAt, r.id);
      const retryStmt = db.prepare("UPDATE assist_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?");
      const deadStmt = db.prepare(
        "UPDATE assist_outbox SET state = 'dead', attempts = ?, next_attempt_at = NULL WHERE id = ?",
      );
      let deadCount = 0;
      for (const r of retries) {
        const attempts = r.attempts + 1;
        if (r.allowDead && attempts >= deadAfter) {
          deadStmt.run(attempts, r.id);
          deadCount++;
        } else {
          retryStmt.run(attempts, new Date(now() + backoffMs(attempts)).toISOString(), r.id);
        }
      }
      if (deadCount > 0) {
        console.warn(`[assist] ${deadCount} 条事件被中枢拒绝达到 ${deadAfter} 次，标记 dead（行保留可查）`);
      }
    };
    if (db.isTransaction) {
      run();
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 整批退避（网络错误 / 5xx / 403 / 异常响应体）；传输类失败永远留在 pending，不判死。 */
  function backoffAll(rows: OutboxRow[]): void {
    try {
      applyMarks(
        [],
        rows.map((r) => ({ id: r.id, attempts: Number(r.attempts), allowDead: false })),
      );
    } catch (err) {
      console.warn(`[assist] 退避标记写入失败: ${(err as Error).message?.slice(0, 200)}`);
    }
  }

  /** 终态行清理（契约 §2）：sent 按 sent_at、dead 按 created_at 超期删除，outbox 不无限增长。 */
  function cleanupTerminalRows(): void {
    try {
      const cutoff = new Date(now() - retentionMs).toISOString();
      const sent = db
        .prepare("DELETE FROM assist_outbox WHERE state = 'sent' AND sent_at IS NOT NULL AND sent_at < ?")
        .run(cutoff);
      const dead = db.prepare("DELETE FROM assist_outbox WHERE state = 'dead' AND created_at < ?").run(cutoff);
      const n = Number(sent.changes) + Number(dead.changes);
      if (n > 0) console.info(`[assist] 已清理 ${n} 条超期终态 outbox 行`);
    } catch (err) {
      console.warn(`[assist] 终态清理失败: ${(err as Error).message?.slice(0, 200)}`);
    }
  }

  /** 单批投递：组包 → POST → 按 accepted/duplicates/rejected 分别落标记。 */
  async function deliver(rows: OutboxRow[]): Promise<void> {
    const events: unknown[] = [];
    const deliverable: OutboxRow[] = [];
    const broken: OutboxRow[] = [];
    for (const r of rows) {
      // purge 可能在取批次后提交；发送前重新确认行仍是 pending，避免已删除正文进入新请求。
      const current = db.prepare("SELECT state FROM assist_outbox WHERE id = ?").get(r.id) as
        | { state: string }
        | undefined;
      if (current?.state !== "pending") continue;
      try {
        events.push(JSON.parse(r.payload_json));
        deliverable.push(r);
      } catch {
        // payload 损坏不可投递：置 sent 防止毒行永久堵队列。
        broken.push(r);
      }
    }
    if (broken.length > 0) {
      console.warn(`[assist] ${broken.length} 条 outbox 事件 payload 损坏，按已送达丢弃`);
      try {
        applyMarks(
          broken.map((r) => ({ id: r.id })),
          [],
        );
      } catch (err) {
        console.warn(`[assist] 损坏行标记失败: ${(err as Error).message?.slice(0, 200)}`);
      }
    }
    if (deliverable.length === 0) return;

    let res: Response;
    const abort = new AbortController();
    activeAbort = abort;
    const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
    try {
      const request = fetchImpl(`${hub}/api/v1/ingest/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.sourceKey}`,
        },
        body: JSON.stringify({ sentAt: new Date(now()).toISOString(), events }),
        signal: abort.signal,
      });
      res = await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(new Error("assist request aborted"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
        request.then(
          (value) => {
            abort.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error) => {
            abort.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } catch {
      clearTimeout(timeout);
      activeAbort = null;
      // stop() 取消在途请求时不增加 attempts；超时/网络错误仍持久化退避。
      if (!stopped) backoffAll(deliverable);
      return;
    }
    const clearRequest = () => {
      clearTimeout(timeout);
      if (activeAbort === abort) activeAbort = null;
    };

    if (res.status === 401) {
      abort.abort();
      clearRequest();
      // 来源密钥失效：停发并周期探测（事件保留 pending，不消耗退避次数）。
      authPausedUntil = now() + authPauseMs;
      console.warn(`[assist] 中枢返回 401（来源密钥失效），${Math.round(authPauseMs / 1000)}s 后探测恢复`);
      return;
    }
    if (res.status === 403 || res.status >= 500 || !res.ok) {
      abort.abort();
      clearRequest();
      // 契约：5xx 与 403 按退避重试；其余 4xx 无定义，保守同样退避。
      backoffAll(deliverable);
      return;
    }

    let data: { accepted?: unknown; duplicates?: unknown; rejected?: unknown };
    try {
      data = await new Promise<typeof data>((resolve, reject) => {
        const onAbort = () => reject(new Error("assist response aborted"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
        res.json().then(
          (value) => {
            abort.signal.removeEventListener("abort", onAbort);
            resolve(value as typeof data);
          },
          (error) => {
            abort.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } catch {
      clearRequest();
      if (stopped) return;
      backoffAll(deliverable);
      return;
    }
    clearRequest();
    const accepted = new Set(Array.isArray(data.accepted) ? data.accepted : []);
    const duplicates = new Set(Array.isArray(data.duplicates) ? data.duplicates : []);
    const sent: { id: string }[] = [];
    const retries: { id: string; attempts: number; allowDead: boolean }[] = [];
    for (const r of deliverable) {
      if (accepted.has(r.id) || duplicates.has(r.id)) {
        sent.push({ id: r.id });
      } else {
        // rejected（含响应中未提及的行）：契约要求单独标记重试，不拖垮整批；
        // 达到 deadAfter 次仍未被接受 → dead（行保留可查）。
        retries.push({ id: r.id, attempts: Number(r.attempts), allowDead: true });
      }
    }
    applyMarks(sent, retries);
  }

  const loopPromise = (async () => {
    let lastCleanup = 0;
    while (!stopped) {
      try {
        const nowMs = now();
        // 终态清理：启动即跑一次，此后每 cleanupIntervalMs（默认 24h）一次。
        if (nowMs - lastCleanup >= cleanupIntervalMs) {
          cleanupTerminalRows();
          lastCleanup = nowMs;
        }
        if (nowMs < authPausedUntil) {
          // 401 停发窗口内不再发起请求，到点探测一次。
          await wait(Math.min(authPausedUntil - nowMs, authPauseMs));
          continue;
        }
        const rows = dueBatch(new Date(nowMs).toISOString());
        if (rows.length === 0) {
          const nxt = nextDueMs();
          const waitMs = nxt === null ? deps.flushMs : Math.max(0, Math.min(deps.flushMs, nxt - nowMs));
          await wait(waitMs);
          continue;
        }
        await deliver(rows);
      } catch (err) {
        console.warn(`[assist] 投递循环异常: ${(err as Error).message?.slice(0, 200)}`);
        await wait(deps.flushMs);
      }
    }
  })();
  // 循环逐迭代已兜底；这里再兜底防未处理 rejection。
  loopPromise.catch(() => undefined);

  return {
    stop() {
      stopped = true;
      activeAbort?.abort();
      wake?.();
    },
    async idle() {
      await loopPromise.catch(() => undefined);
    },
  };
}
