import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type SystemUpdateStatus,
  type UpdateOperationResult,
  type UpdateOperationView,
  type UpdatePauseState,
} from "../api.ts";
import { InlineError, SkeletonRows } from "../ui.tsx";

/** 保留最近一次提交的任务 ID（刷新页面或重开标签后仍能恢复进度展示）。 */
const OPERATION_KEY = "feedback.systemUpdate.operationId";
const POLL_MS = 2000;

function readStoredOperationId(): string | null {
  try {
    return window.localStorage.getItem(OPERATION_KEY);
  } catch {
    return null;
  }
}

function storeOperationId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(OPERATION_KEY);
    else window.localStorage.setItem(OPERATION_KEY, id);
  } catch {
    /* 隐私模式等场景下退化为不记忆 */
  }
}

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return `web-${c.randomUUID()}`;
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function isTerminal(op: UpdateOperationView): boolean {
  return op.status === "succeeded" || op.status === "failed" || op.status === "needs_attention";
}

/**
 * U1-4「系统更新」：当前版本 / 最新稳定版与发布说明 / 检查 / 更新 / 任务进度。
 *
 * 前端职责边界：
 * - 只提交 `{requestId, version, digest}`（来自清单），绝不提交路径、命令、镜像或卷名。
 * - 更新中禁用重复提交；任务 ID 存在 localStorage，刷新或重开标签不取消任务。
 * - 取不到进度（服务重启期间的网络中断）显示「正在恢复连接」，**不判定为更新失败**。
 * - 不提供任何自动删除旧镜像/备份卷的入口（执行器同样不做）。
 */
export default function SystemUpdateView() {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [operation, setOperation] = useState<UpdateOperationView | null>(null);
  const [operationId, setOperationId] = useState<string | null>(() => readStoredOperationId());
  const [connectionState, setConnectionState] = useState<"idle" | "recovering" | "unknown">("idle");
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operationIdRef = useRef<string | null>(operationId);
  operationIdRef.current = operationId;

  const loadStatus = useCallback(async () => {
    const s = await api.get<SystemUpdateStatus>("/api/admin/system/update");
    setStatus(s);
    return s;
  }, []);

  const loadOperation = useCallback(async (id: string): Promise<UpdateOperationView | null> => {
    const r = await api.get<UpdateOperationResult>(`/api/admin/system/update/${id}`);
    if (r.status === "known") {
      setOperation(r.operation);
      setConnectionState("idle");
      return r.operation;
    }
    if (r.status === "unknown") {
      // 执行器与控制目录都没有该任务：不再跟踪，但也不宣称失败。
      setConnectionState("unknown");
      return null;
    }
    setConnectionState("recovering");
    setError(r.error.message);
    return null;
  }, []);

  useEffect(() => {
    void loadStatus().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [loadStatus]);

  // 有任务 ID 就轮询进度；终态停止轮询。刷新/重开标签会从持久结果恢复。
  useEffect(() => {
    if (!operationId) return;
    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      const op = await loadOperation(operationId).catch((e: unknown) => {
        setConnectionState("recovering");
        setError(e instanceof ApiError ? e.message : "读取任务进度失败");
        return null;
      });
      if (stopped) return;
      if (op && isTerminal(op)) {
        await loadStatus().catch(() => undefined);
        return; // 终态：停止轮询，保留持久结果
      }
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [operationId, loadOperation, loadStatus]);

  async function check() {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ check: SystemUpdateStatus["check"] }>("/api/admin/system/update/check");
      setStatus((prev) => (prev ? { ...prev, check: r.check } : prev));
      setNotice(
        r.check.state === "failed"
          ? "检查失败（不影响正在运行的服务，可稍后重试）"
          : r.check.state === "up_to_date"
            ? "当前已是最新稳定版"
            : r.check.state === "incompatible"
              ? "发现新版本，但更新执行器协议不兼容"
              : "已获取最新版本信息",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "检查失败");
    } finally {
      setChecking(false);
    }
  }

  async function startUpdate() {
    const latest = status?.check.latest;
    if (!latest?.digest) {
      setError("缺少可更新的版本信息，请先检查更新");
      return;
    }
    const requestId = newRequestId();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    setOperation(null);
    setConnectionState("idle");
    try {
      const r = await api.post<{ operationId: string; status: string; deduplicated: boolean }>(
        "/api/admin/system/update",
        { requestId, version: latest.version, digest: latest.digest },
      );
      storeOperationId(r.operationId);
      setOperationId(r.operationId);
      setNotice(r.deduplicated ? "该请求已受理过，继续跟踪原任务进度" : `更新任务已受理：${r.operationId}`);
      await loadStatus().catch(() => undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "提交更新失败");
    } finally {
      setSubmitting(false);
    }
  }

  function forgetOperation() {
    storeOperationId(null);
    setOperationId(null);
    setOperation(null);
    setConnectionState("idle");
    setNotice("已停止在本页跟踪该任务（任务本身不受影响）");
  }

  const checkView = status?.check;
  const running = operation !== null && !isTerminal(operation);
  const canUpdate = Boolean(checkView?.latest?.digest) && checkView?.compatible === true && !running && !submitting;

  if (!status) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>系统更新</h1>
            <div className="sub">当前版本、检查更新与更新任务进度。</div>
          </div>
        </div>
        <div className="card">
          <SkeletonRows rows={3} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>系统更新</h1>
          <div className="sub">只提交版本与摘要信息；更新执行器负责下载、校验与切换。</div>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void loadStatus().catch(() => undefined)} />}
      {notice && <p className="ok-text">{notice}</p>}
      {status.pause.paused && <PauseBanner pause={status.pause} />}

      <div className="card">
        <div className="kv">
          <span className="muted">当前版本</span>
          <span>
            <code>{status.current.version}</code>
            <span className="muted">（更新执行器协议 v{status.current.protocol}）</span>
          </span>
          <span className="muted">更新执行器</span>
          <span>
            {status.config.updateConfigured ? (
              <>
                已接入 <code className="wrap-anywhere">{status.config.updaterBaseUrl}</code>
                <span className="muted">（{status.config.controlDir ? "控制目录已挂载" : "未挂载控制目录"}）</span>
              </>
            ) : (
              <span className="muted">未接入（缺少 FEEDBACK_UPDATE_URL）</span>
            )}
          </span>
          <span className="muted">自动检查</span>
          <span className="muted">
            {status.config.checkIntervalMs > 0
              ? `每 ${Math.round(status.config.checkIntervalMs / 3600_000)} 小时检查一次（只检查，绝不自动安装）`
              : "已关闭自动检查（仅手动）"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row row-wrap spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>版本状态</h2>
          <div className="btn-row">
            <button type="button" className="btn" onClick={check} disabled={checking || submitting}>
              {checking ? "检查中…" : "检查更新"}
            </button>
            <button className="btn primary" type="button" onClick={startUpdate} disabled={!canUpdate}>
              {submitting ? "提交中…" : running ? "更新进行中…" : "更新到最新稳定版"}
            </button>
          </div>
        </div>
        <CheckSummary check={checkView} />
        {checkView?.guidance && (
          <p className="err" style={{ marginBottom: 0 }}>
            {checkView.guidance}
          </p>
        )}
        {checkView?.warnings.map((w: string) => (
          <p className="muted" key={w} style={{ marginBottom: 0 }}>
            ⚠ {w}
          </p>
        ))}
      </div>

      {operationId && (
        <OperationPanel
          operationId={operationId}
          operation={operation}
          connectionState={connectionState}
          onForget={forgetOperation}
        />
      )}

      <RecentOperations operations={status.recentOperations} />
    </div>
  );
}

function PauseBanner({ pause }: { pause: UpdatePauseState }) {
  const marker = pause.marker;
  return (
    <div className="card pause-banner">
      <strong>业务写入已暂停</strong>
      <p className="update-note">
        {marker?.message ?? "系统更新进行中，本服务的写入操作暂时不可用"}
        {marker?.phaseLabel ? `（当前阶段：${marker.phaseLabel}）` : ""}
      </p>
      <p className="muted update-note">
        开始于 {fmt(pause.since)}；更新完成后本服务会自动恢复写入，无需人工操作。
        {marker?.parseError ? `（${marker.parseError}）` : ""}
      </p>
    </div>
  );
}

function CheckSummary({ check }: { check: SystemUpdateStatus["check"] | undefined }) {
  if (!check) return <p className="muted">加载中…</p>;
  if (check.state === "never") return <p className="muted">尚未检查过。点击「检查更新」获取最新稳定版信息。</p>;
  if (check.state === "failed") {
    return (
      <>
        <p className="err">
          检查失败：{check.failedMessage ?? "未知原因"}
          {check.failedCode ? `（${check.failedCode}）` : ""}
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          检查失败不影响正在运行的服务。上次检查：{fmt(check.checkedAt)}。
        </p>
      </>
    );
  }
  const latest = check.latest;
  if (!latest) return <p className="muted">没有可用的版本信息。</p>;
  return (
    <>
      <div className="kv">
        <span className="muted">最新稳定版</span>
        <span>
          <code>{latest.version}</code>{" "}
          {check.state === "up_to_date" ? (
            <span className="tag archived">已是最新</span>
          ) : (
            <span className="tag received">可更新</span>
          )}
        </span>
        <span className="muted">发布时间</span>
        <span className="muted">{fmt(latest.publishedAt)}</span>
        <span className="muted">协议兼容</span>
        <span className={check.compatible ? "ok-text" : "err"}>
          {check.compatible
            ? `兼容（要求 v${check.requiredProtocol ?? check.supportedProtocol} / 本服务 v${check.supportedProtocol}）`
            : `不兼容（要求 v${check.requiredProtocol}，本服务支持 v${check.supportedProtocol}）`}
        </span>
        <span className="muted">本次检查</span>
        <span className="muted">
          {fmt(check.checkedAt)}
          {check.source ? `（来源：${check.source}）` : ""}
        </span>
      </div>
      {latest.notes ? (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 4 }}>
            发布说明
          </div>
          <blockquote className="quote">{latest.notes}</blockquote>
        </div>
      ) : (
        <p className="muted">该版本清单未包含发布说明。</p>
      )}
    </>
  );
}

function OperationPanel({
  operationId,
  operation,
  connectionState,
  onForget,
}: {
  operationId: string;
  operation: UpdateOperationView | null;
  connectionState: "idle" | "recovering" | "unknown";
  onForget: () => void;
}) {
  return (
    <div className="card">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>更新任务</h2>
        <button type="button" className="btn sm" onClick={onForget}>
          停止跟踪
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        任务 ID <code className="wrap-anywhere">{operationId}</code>（刷新页面或关闭标签都不会取消任务）
      </p>
      {operation && <OperationProgress operation={operation} />}
      {connectionState === "recovering" && (
        <p className="muted">
          正在恢复连接…（服务可能在更新期间重启；取不到进度<b>不算</b>更新失败，本页会自动重试）
        </p>
      )}
      {connectionState === "unknown" && <p className="muted">执行器与本机控制目录都没有该任务的记录，已停止跟踪。</p>}
    </div>
  );
}

function OperationProgress({ operation }: { operation: UpdateOperationView }) {
  const terminal = isTerminal(operation);
  const tone = operation.outcome === "needs_attention" ? "err" : operation.status === "succeeded" ? "ok-text" : "muted";
  return (
    <>
      <div className="kv">
        <span className="muted">状态</span>
        <span className={tone}>
          {operation.outcomeLabel ?? (terminal ? operation.status : "更新进行中")}
          {operation.status === "running" ? `（${operation.phaseLabel}）` : ""}
        </span>
        <span className="muted">目标版本</span>
        <span>
          <code>{operation.version ?? "—"}</code>
        </span>
        <span className="muted">阶段</span>
        <span>{operation.phaseLabel}</span>
        <span className="muted">说明</span>
        <span>{operation.message}</span>
        <span className="muted">更新时间</span>
        <span className="muted">{fmt(operation.updatedAt)}</span>
      </div>

      {operation.status === "running" && (
        <p className="muted" style={{ marginBottom: 0 }}>
          更新期间业务写入会被暂停（返回 <code>update_paused</code>），完成后自动恢复。
        </p>
      )}

      {operation.outcome === "failed_restored" && (
        <p className="muted" style={{ marginBottom: 0 }}>
          已确认恢复到旧版本运行；未修改的原数据卷与旧镜像都保留，不会自动删除。
        </p>
      )}
      {operation.outcome === "needs_attention" && (
        <div style={{ marginTop: 8 }}>
          <p className="err" style={{ marginBottom: 4 }}>
            需要人工处理：
            {operation.failure ? `${operation.failure.message}（${operation.failure.code}）` : operation.message}
          </p>
          {operation.recoveryHint && (
            <p className="muted" style={{ margin: 0 }}>
              恢复指引：{operation.recoveryHint}
            </p>
          )}
          <p className="muted" style={{ margin: "4px 0 0" }}>
            系统不会自动回退数据卷；请按任务证据与本机记录人工核对后再决定。
          </p>
        </div>
      )}

      {operation.evidence.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">任务证据（{operation.evidence.length} 条）</summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>阶段</th>
                  <th>步骤</th>
                  <th>结果</th>
                  <th>细节</th>
                </tr>
              </thead>
              <tbody>
                {operation.evidence.map((e) => (
                  // 证据条目按「时间+阶段+步骤」唯一（执行器每个阶段边界都会落盘一条）。
                  <tr key={`${e.at}|${e.phase}|${e.step}`}>
                    <td className="muted">{fmt(e.at)}</td>
                    <td>{e.phase}</td>
                    <td>{e.step}</td>
                    <td className={e.ok ? "ok-text" : "err"}>{e.ok ? "通过" : "失败"}</td>
                    <td className="muted">{e.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {operation.warnings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {operation.warnings.map((w) => (
            <p className="muted" key={w} style={{ margin: 0 }}>
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

function RecentOperations({ operations }: { operations: UpdateOperationView[] }) {
  if (operations.length === 0) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>目标版本</th>
            <th>状态</th>
            <th>阶段</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => (
            <tr key={op.operationId}>
              <td>
                <code className="wrap-anywhere">{op.operationId}</code>
              </td>
              <td>{op.version ?? "—"}</td>
              <td className={op.outcome === "needs_attention" ? "err" : undefined}>
                {op.outcomeLabel ?? (isTerminal(op) ? op.status : "进行中")}
              </td>
              <td className="muted">{op.phaseLabel}</td>
              <td className="muted">{fmt(op.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
