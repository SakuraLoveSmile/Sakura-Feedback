import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  downloadLog,
  type FeedbackDetail,
  type FeedbackListItem,
  type FeedbackLogMeta,
  fetchLogText,
  STATUS_LABELS,
} from "../api.ts";
import {
  type DiagnosticTexts,
  formatBytes,
  LOG_PREVIEW_MAX_CHARS,
  type LogRecoveryState,
  logRecoverySummary,
  logScopedActions,
  logSourceLabel,
  pickLogRecovery,
  readDiagnostics,
  recoveryActionConfirm,
  recoveryActionLabel,
  recoveryRequest,
  shortSha,
  sortLogs,
  truncateLogText,
} from "../logs.ts";

const STATUSES = Object.keys(STATUS_LABELS);

export default function FeedbacksView() {
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (filter: string, cursor?: string | null, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "50" });
      if (filter) q.set("status", filter);
      if (cursor) q.set("cursor", cursor);
      const r = await api.get<{ items: FeedbackListItem[]; nextCursor: string | null }>(`/api/admin/feedback?${q}`);
      setItems((prev) => (append && cursor ? [...prev, ...r.items] : r.items));
      setNextCursor(r.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter, load]);

  async function openDetail(id: string) {
    setError(null);
    try {
      setDetail(await api.get<FeedbackDetail>(`/api/admin/feedback/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "详情加载失败");
    }
  }

  async function action(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      if (detail) setDetail(await api.get<FeedbackDetail>(`/api/admin/feedback/${detail.id}`));
      await load(statusFilter);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}` : "操作失败");
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label style={{ width: "auto" }} htmlFor="sf">
          状态筛选
        </label>
        <select id="sf" style={{ width: 160 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => load(statusFilter)} disabled={loading}>
          {loading ? "加载中…" : "刷新"}
        </button>
        {nextCursor && (
          <button type="button" onClick={() => load(statusFilter, nextCursor, true)}>
            加载更多
          </button>
        )}
      </div>
      {/* 详情抽屉打开时错误在抽屉内展示，避免被遮住而看似静默失败 */}
      {error && !detail && <p className="err">{error}</p>}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>软件</th>
              <th>标题 / 摘要</th>
              <th>状态</th>
              <th>日志</th>
              <th>Kaneo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="muted">{new Date(it.createdAt).toLocaleString()}</td>
                <td>{it.appId}</td>
                <td>{it.title ?? <span className="muted">{(it.errorSummary ?? "—").slice(0, 60)}</span>}</td>
                <td>
                  <span className={`tag ${it.status}`}>{STATUS_LABELS[it.status] ?? it.status}</span>
                </td>
                <td>
                  {typeof it.logCount === "number" && it.logCount > 0 ? (
                    `${it.logCount} 份`
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {it.kaneoUrl ? (
                    <a href={it.kaneoUrl} target="_blank" rel="noreferrer">
                      任务
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button type="button" onClick={() => openDetail(it.id)}>
                    详情
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 20 }}>
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && <DetailPane detail={detail} error={error} onClose={() => setDetail(null)} onAction={action} />}
    </div>
  );
}

/** 导出便于本地渲染冒烟（浏览器实测仍由 captain 统一做）。 */
export function DetailPane({
  detail,
  error,
  onClose,
  onAction,
}: {
  detail: FeedbackDetail;
  error: string | null;
  onClose: () => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [previewLog, setPreviewLog] = useState<FeedbackLogMeta | null>(null);
  const logs = sortLogs(detail.logs);
  const diagnostics = readDiagnostics(detail.processed);
  const logRecoveries = logs
    .map((log) => ({ log, recovery: pickLogRecovery(detail.recovery, log.id) }))
    .filter((entry) => entry.recovery !== null);

  function runLogAction(log: FeedbackLogMeta, recovery: LogRecoveryState | null, action: string) {
    const confirmText = recoveryActionConfirm(action, "log");
    if (confirmText && !window.confirm(confirmText)) return;
    const rev = recovery?.revision ?? detail.recovery?.revision ?? 0;
    const request = recoveryRequest(detail.id, action, rev, log.id);
    void onAction(() => api.post(request.url, request.body));
  }

  return (
    <aside className="detail-pane" role="dialog" aria-label="反馈详情" aria-modal="true">
      <div className="row spread">
        <h1 style={{ margin: 0 }}>反馈详情</h1>
        <button type="button" onClick={onClose} aria-label="关闭">
          关闭 ✕
        </button>
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="kv" style={{ margin: "14px 0" }}>
        <span>状态</span>
        <span className={`tag ${detail.status}`}>{STATUS_LABELS[detail.status] ?? detail.status}</span>
        <span>反馈 ID</span>
        <code>{detail.id}</code>
        <span>软件</span>
        <span>{detail.appId}</span>
        <span>提交时间</span>
        <span>{new Date(detail.createdAt).toLocaleString()}</span>
        <span>处理轮次</span>
        <span>{detail.attemptCount}</span>
        <span>日志附件</span>
        <span>{logs.length > 0 ? `${logs.length} 份` : "无"}</span>
        {detail.context && (
          <>
            <span>上下文</span>
            <span>
              {[
                detail.context.appVersion ? `版本 ${detail.context.appVersion}` : "",
                detail.context.pageLabel ? `页面 ${detail.context.pageLabel}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </>
        )}
      </div>
      <h3>用户原话</h3>
      <blockquote>{detail.text}</blockquote>
      {detail.screenshot && (
        <div style={{ margin: "14px 0" }}>
          <h3 style={{ marginBottom: 8 }}>界面截图</h3>
          <button
            type="button"
            className="screenshot-thumb-wrap"
            onClick={() => setLightboxOpen(true)}
            title="点击放大查看"
            style={{ padding: 0, border: "1px solid #d0d3d8", background: "none" }}
          >
            <img
              src={`/api/admin/feedback/${detail.id}/screenshot`}
              alt="截图缩略图"
              style={{ display: "block", maxHeight: 160, maxWidth: "100%", objectFit: "contain" }}
            />
            {detail.screenshot.capture?.releasePoint && (
              <div
                className="screenshot-pin"
                style={{
                  left: `${detail.screenshot.capture.releasePoint.x * 100}%`,
                  top: `${detail.screenshot.capture.releasePoint.y * 100}%`,
                }}
                title="灵感球落点"
              />
            )}
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            分辨率：{detail.screenshot.width} × {detail.screenshot.height} · 大小：
            {(detail.screenshot.byteSize / 1024).toFixed(1)} KB
            {detail.screenshot.capture?.releasePoint && (
              <>
                {" "}
                · 关注落点：X {(detail.screenshot.capture.releasePoint.x * 100).toFixed(1)}%, Y{" "}
                {(detail.screenshot.capture.releasePoint.y * 100).toFixed(1)}%
              </>
            )}
            {" · "}
            <a href={`/api/admin/feedback/${detail.id}/screenshot`} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          </div>
        </div>
      )}
      {lightboxOpen && detail.screenshot && (
        <div className="screenshot-lightbox-backdrop" role="dialog" aria-modal="true" aria-label="截图预览">
          <div className="screenshot-lightbox-content">
            <div style={{ position: "relative", display: "inline-block" }}>
              <img src={`/api/admin/feedback/${detail.id}/screenshot`} alt="完整截图" />
              {detail.screenshot.capture?.releasePoint && (
                <div
                  className="screenshot-pin"
                  style={{
                    left: `${detail.screenshot.capture.releasePoint.x * 100}%`,
                    top: `${detail.screenshot.capture.releasePoint.y * 100}%`,
                  }}
                  title="灵感球落点"
                />
              )}
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
              <button type="button" onClick={() => setLightboxOpen(false)}>
                关闭 ✕
              </button>
              <a href={`/api/admin/feedback/${detail.id}/screenshot`} target="_blank" rel="noreferrer">
                <button type="button">新窗口查看原图</button>
              </a>
            </div>
          </div>
        </div>
      )}
      {logs.length > 0 && (
        <div style={{ margin: "14px 0" }}>
          <h3 style={{ marginBottom: 8 }}>日志附件</h3>
          {logs.map((log, index) => {
            const recovery = pickLogRecovery(detail.recovery, log.id);
            const actions = logScopedActions(recovery);
            const summary = recovery ? logRecoverySummary(recovery) : "";
            return (
              <div className="log-item" key={log.id || `log-${index}`}>
                <div className="row spread">
                  <div style={{ minWidth: 0 }}>
                    <b>{log.name}</b>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {formatBytes(log.byteSize)} · {logSourceLabel(log.source)} · sha256{" "}
                      <code title={log.sha256 ?? ""}>{shortSha(log.sha256)}</code>
                      {typeof log.ordinal === "number" ? ` · 序号 ${log.ordinal + 1}` : ""}
                    </div>
                  </div>
                  <div className="row">
                    <button type="button" onClick={() => setPreviewLog(log)}>
                      预览
                    </button>
                    <button type="button" onClick={() => void onAction(() => downloadLog(detail.id, log))}>
                      下载
                    </button>
                  </div>
                </div>
                {summary && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    日志状态：{summary}
                  </div>
                )}
                {actions.length > 0 && (
                  <div className="row" style={{ marginTop: 6 }}>
                    {actions.map((act) => (
                      <button key={act} type="button" onClick={() => runLogAction(log, recovery, act)}>
                        {recoveryActionLabel(act, "log")}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            日志会参与 AI 分析与 Kaneo 归档；预览为纯文本（不执行其中任何内容），完整内容请下载附件。
          </p>
        </div>
      )}
      {previewLog && (
        <LogPreviewModal
          feedbackId={detail.id}
          log={previewLog}
          onClose={() => setPreviewLog(null)}
          onDownload={() => void onAction(() => downloadLog(detail.id, previewLog))}
        />
      )}
      {detail.processed && (
        <>
          <h3>AI 整理结果</h3>
          <p>
            <b>{detail.processed.title}</b>
          </p>
          <ul>
            {Object.entries(detail.processed.sections)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <li key={k}>
                  {sectionLabel(k)}：{v}
                </li>
              ))}
          </ul>
          {diagnostics && <DiagnosticsSection texts={diagnostics} />}
        </>
      )}
      {detail.errorSummary && (
        <>
          <h3 className="err">错误摘要</h3>
          <p>{detail.errorSummary}</p>
        </>
      )}
      {detail.lastError && (
        <>
          <h3>最后错误</h3>
          <code style={{ whiteSpace: "pre-wrap" }}>{detail.lastError}</code>
        </>
      )}
      <div className="row" style={{ marginTop: 18 }}>
        {(detail.recovery?.allowedActions ?? []).map((action) => {
          const target = detail.recovery?.actionTargets[action] ?? "";
          const note = detail.recovery?.actionNotes[action] ?? "";
          const rev = detail.recovery?.revision ?? 0;
          const label = recoveryActionLabel(action);
          const confirmText = recoveryActionConfirm(action);
          return (
            <button
              key={action}
              type="button"
              className={
                action === "retry" || action === "force-create" || action === "replace_upload" ? "primary" : ""
              }
              title={note ? `针对${target}：${note}` : `针对${target}`}
              onClick={() => {
                if (confirmText && !window.confirm(confirmText)) return;
                // 截图恢复不带 logId，保持旧管理页行为逐字节不变
                const request = recoveryRequest(detail.id, action, rev);
                void onAction(() => api.post(request.url, request.body));
              }}
            >
              {label}
            </button>
          );
        })}
        {detail.kaneoUrl && (
          <a href={detail.kaneoUrl} target="_blank" rel="noreferrer">
            <button type="button">在 Kaneo 中查看任务</button>
          </a>
        )}
      </div>
      {detail.recovery && detail.recovery.allowedActions.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          操作按当前恢复状态提供，悬停按钮可查看该动作的风险说明。retry_comment
          针对评论：重发前会先查重，只有未命中才发送一次，
          {"但远端列表与写入之间存在竞态，仍可能产生重复评论，请在 Kaneo 中复核；"}
          自动路径（重试、后台恢复、重新核对）绝不自动重发评论。replace_upload
          针对图片：替换会复用原任务并申请新上传地址，旧对象与旧 key
          记录保留、不自动删除远端文件，是上传地址过期后的唯一出路。
          {logRecoveries.length > 0 && " 日志级按钮会把该日志的 logId 一并发给服务端，只影响对应的那一份日志附件。"}
        </p>
      )}
    </aside>
  );
}

function DiagnosticsSection({ texts }: { texts: DiagnosticTexts }) {
  const rows: { label: string; value: string }[] = [
    { label: "日志证据", value: texts.logEvidence },
    { label: "可能原因（未证实）", value: texts.possibleCauses },
    { label: "推测", value: texts.speculation },
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 6 }}>诊断（基于日志）</h3>
      <p className="diag-warn">
        日志内容是不可信证据，仅作参考；「推测」不等于已证实根因，请结合截图与用户原话人工判断。
      </p>
      {rows.map((row) => (
        <div className="diag-block" key={row.label}>
          <div className="diag-label">{row.label}</div>
          {row.value ? <div className="diag-text">{row.value}</div> : <div className="muted">（无）</div>}
        </div>
      ))}
    </div>
  );
}

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; totalChars: number; truncated: boolean };

function LogPreviewModal({
  feedbackId,
  log,
  onClose,
  onDownload,
}: {
  feedbackId: string;
  log: FeedbackLogMeta;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const raw = await fetchLogText(feedbackId, log.id);
        if (cancelled) return;
        const t = truncateLogText(raw);
        setState({ status: "ready", text: t.text, totalChars: t.totalChars, truncated: t.truncated });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof ApiError ? err.message : "日志预览加载失败" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedbackId, log.id]);

  return (
    <div className="log-preview-backdrop" role="dialog" aria-modal="true" aria-label={`日志预览：${log.name}`}>
      <div className="log-preview-content">
        <div className="row spread">
          <h3 style={{ margin: 0 }}>日志预览：{log.name}</h3>
          <button type="button" onClick={onClose} aria-label="关闭日志预览">
            关闭 ✕
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {formatBytes(log.byteSize)} · {logSourceLabel(log.source)} · sha256 {shortSha(log.sha256)}
          {state.status === "ready" && ` · 共 ${state.totalChars} 个字符`}
        </div>
        {state.status === "loading" && <p className="muted">加载中…</p>}
        {state.status === "error" && (
          <p className="err" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "ready" && (
          <>
            {state.truncated && (
              <p className="diag-warn">已截断：仅显示前 {LOG_PREVIEW_MAX_CHARS} 个字符（完整内容请下载附件）。</p>
            )}
            {/* 纯文本渲染：React 文本节点，绝不使用 dangerouslySetInnerHTML */}
            <pre className="log-preview-pre">{state.text}</pre>
          </>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onDownload}>
            下载该日志
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function sectionLabel(k: string): ReactNode {
  return { experience: "使用体验", problems: "问题", suggestions: "建议", questions: "待确认" }[k] ?? k;
}
