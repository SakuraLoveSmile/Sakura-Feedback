import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  CONFIDENCE_LABELS,
  type FeedbackDetail,
  type FeedbackDiagnostics,
  type FeedbackListItem,
  type FeedbackLogMeta,
  LOG_ARCHIVE_STATE_LABELS,
  LOG_SOURCE_LABELS,
  type LogEvidenceItem,
  type LogSpeculationItem,
  STATUS_LABELS,
} from "../api.ts";

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
    setDetail(await api.get<FeedbackDetail>(`/api/admin/feedback/${id}`));
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
      {error && <p className="err">{error}</p>}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>软件</th>
              <th>标题 / 摘要</th>
              <th>日志</th>
              <th>状态</th>
              <th>Kaneo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} data-testid="feedback-row" data-feedback-id={it.id}>
                <td className="muted">{new Date(it.createdAt).toLocaleString()}</td>
                <td>{it.appId}</td>
                <td>{it.title ?? <span className="muted">{(it.errorSummary ?? "—").slice(0, 60)}</span>}</td>
                <td>
                  <span
                    className={it.logCount ? "log-count has-logs" : "log-count muted"}
                    data-testid="log-count"
                    data-log-count={String(it.logCount ?? 0)}
                  >
                    {(it.logCount ?? 0) > 0 ? `${it.logCount} 份` : "0 份"}
                  </span>
                </td>
                <td>
                  <span
                    className={`tag ${it.status}`}
                    data-testid="feedback-row-status"
                    data-status={it.status}
                    data-archive-complete={it.status === "archived" ? "true" : "false"}
                  >
                    {STATUS_LABELS[it.status] ?? it.status}
                  </span>
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
      {detail && <DetailPane detail={detail} onClose={() => setDetail(null)} onAction={action} />}
    </div>
  );
}

function DetailPane({
  detail,
  onClose,
  onAction,
}: {
  detail: FeedbackDetail;
  onClose: () => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [preview, setPreview] = useState<LogPreview | null>(null);
  /** 契约保证 `logs` 恒为数组；这里仍做读取侧兜底，旧响应/半升级服务端也不得报错。 */
  const logs = detail.logs ?? [];

  /**
   * 预览：页面内请求管理端日志接口（cookie 会话），响应体按纯文本渲染。
   * 绝不使用 innerHTML；绝不把响应体写入控制台或任何运行日志。
   */
  async function togglePreview(logId: string) {
    if (preview?.logId === logId) {
      setPreview(null);
      return;
    }
    setPreview({ logId, status: "loading", text: "", error: "" });
    try {
      const res = await fetch(`/api/admin/feedback/${detail.id}/logs/${logId}`, { credentials: "same-origin" });
      const body = await res.text();
      if (!res.ok) {
        setPreview({ logId, status: "error", text: "", error: errorCodeOf(body, res.status) });
        return;
      }
      setPreview({ logId, status: "ok", text: body, error: "" });
    } catch {
      setPreview({ logId, status: "error", text: "", error: "网络错误（未取到响应）" });
    }
  }

  return (
    <aside className="detail-pane" role="dialog" aria-label="反馈详情" aria-modal="true">
      <div className="row spread">
        <h1 style={{ margin: 0 }}>反馈详情</h1>
        <button type="button" onClick={onClose} aria-label="关闭">
          关闭 ✕
        </button>
      </div>
      <div className="kv" style={{ margin: "14px 0" }}>
        <span>状态</span>
        <span
          className={`tag ${detail.status}`}
          data-testid="feedback-status"
          data-status={detail.status}
          data-archive-complete={detail.status === "archived" ? "true" : "false"}
        >
          {STATUS_LABELS[detail.status] ?? detail.status}
        </span>
        <span>反馈 ID</span>
        <code>{detail.id}</code>
        <span>软件</span>
        <span>{detail.appId}</span>
        <span>提交时间</span>
        <span>{new Date(detail.createdAt).toLocaleString()}</span>
        <span>处理轮次</span>
        <span>{detail.attemptCount}</span>
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
        <section data-testid="feedback-logs" aria-label="日志列表" style={{ margin: "14px 0" }}>
          <h3 style={{ marginBottom: 4 }}>日志（{logs.length} 份）</h3>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
            日志会参与 AI 分析并归档到 Kaneo；已提交的完整字节始终保留，可在此预览与下载。
          </p>
          <ul data-testid="log-list" className="log-list">
            {logs.map((log) => {
              const open = preview?.logId === log.id;
              return (
                <li key={log.id} data-testid="log-item" {...logDataAttrs(log)}>
                  <div className="log-head">
                    <code className="log-seq">#{log.seq}</code>
                    <b className="log-name">{log.filename}</b>
                    <span className="log-source">{LOG_SOURCE_LABELS[log.source] ?? log.source}</span>
                    {archiveBadge(log)}
                  </div>
                  <div className="muted log-meta">
                    大小 {formatBytes(log.byteSize)}（{log.byteSize} 字节） · SHA-256{" "}
                    {typeof log.sha256 === "string" && log.sha256 !== "" ? (
                      <code title={log.sha256}>{log.sha256.slice(0, 12)}…</code>
                    ) : (
                      "—"
                    )}
                    {typeof log.totalCodepoints === "number" && log.totalCodepoints >= 0 && (
                      <> · {log.totalCodepoints} 码点</>
                    )}
                  </div>
                  <div className="log-meta">{truncationNote(log)}</div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      type="button"
                      data-testid="log-preview"
                      aria-label={`预览日志 ${log.filename}`}
                      aria-expanded={open}
                      onClick={() => void togglePreview(log.id)}
                    >
                      {open ? "收起预览" : "预览"}
                    </button>
                    <a
                      data-testid="log-download"
                      aria-label={`下载日志 ${log.filename}`}
                      href={`/api/admin/feedback/${detail.id}/logs/${log.id}?download=1`}
                    >
                      下载
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
          {preview && (
            <div className="log-preview">
              <div className="row spread">
                <span className="muted" style={{ fontSize: 12 }}>
                  预览（纯文本原样呈现，不执行、不渲染 HTML）
                </span>
                <button type="button" onClick={() => setPreview(null)}>
                  关闭预览
                </button>
              </div>
              {preview.status === "loading" && <p className="muted">加载中…</p>}
              {preview.status === "error" && <p className="err">预览失败：{preview.error}</p>}
              {preview.status === "ok" && (
                <pre data-testid="log-preview-body" data-log-id={preview.logId}>
                  {preview.text}
                </pre>
              )}
            </div>
          )}
        </section>
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
          <DiagnosticsBlock diagnostics={detail.processed.diagnostics} />
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
          const label =
            action === "retry"
              ? "重试处理"
              : action === "recheck"
                ? "重新核对"
                : action === "force-create"
                  ? "确认缺失，再次创建"
                  : action === "retry_comment"
                    ? "重试截图评论"
                    : action === "replace_upload"
                      ? "替换截图上传"
                      : action;
          const confirmText =
            action === "force-create"
              ? "确认 Kaneo 中不存在对应任务且无任何已知附件状态？将再次创建，可能产生重复。"
              : action === "replace_upload"
                ? "将按同一任务重新申请上传地址并替换截图资产；旧对象不会被自动删除。继续？"
                : action === "retry_comment"
                  ? "重发评论会先查重，只有未命中才发送一次；但远端列表与写入之间存在竞态，仍可能产生重复评论。确认重发？"
                  : null;
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
                void onAction(() =>
                  action === "retry"
                    ? api.post(`/api/feedback/${detail.id}/retry`, { expectedRevision: rev })
                    : action === "recheck" || action === "force-create"
                      ? api.post(`/api/feedback/${detail.id}/resolve`, { action, expectedRevision: rev })
                      : api.post(`/api/feedback/${detail.id}/recover`, { action, expectedRevision: rev }),
                );
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
        </p>
      )}
    </aside>
  );
}

function sectionLabel(k: string): ReactNode {
  return { experience: "使用体验", problems: "问题", suggestions: "建议", questions: "待确认" }[k] ?? k;
}

/** 详情内的日志预览状态（同时只预览一份）。 */
interface LogPreview {
  logId: string;
  status: "loading" | "ok" | "error";
  text: string;
  error: string;
}

/** 只取错误码用于提示；绝不把响应体（可能含日志内容）写入控制台或任何运行日志。 */
function errorCodeOf(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      const e = (parsed as { error?: unknown }).error;
      if (e !== null && typeof e === "object" && "code" in e) {
        const code = (e as { code?: unknown }).code;
        if (typeof code === "string" && code !== "") return code;
      }
    }
  } catch {
    /* 非 JSON：不读取正文 */
  }
  return `http_${status}`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const LOG_ARCHIVE_STATES: readonly string[] = ["not_started", "partial", "confirmed"];

/**
 * 日志条目的数据属性：值一律逐字取自服务端 `LogMeta`，UI 不做推导。
 * 字段缺失（旧响应 / 未落地）时省略该属性并在界面上显示「不可用」，不猜测、不写 false。
 */
function logDataAttrs(log: FeedbackLogMeta): Record<string, string> {
  const attrs: Record<string, string> = {
    "data-log-id": log.id,
    "data-log-seq": String(log.seq),
    "data-log-filename": log.filename,
    "data-log-source": log.source,
    "data-log-bytesize": String(log.byteSize),
    "data-log-size": formatBytes(log.byteSize),
  };
  if (typeof log.truncated === "boolean") attrs["data-log-truncated"] = log.truncated ? "true" : "false";
  if (typeof log.totalCodepoints === "number" && Number.isFinite(log.totalCodepoints)) {
    attrs["data-log-codepoints"] = String(log.totalCodepoints);
  }
  if (typeof log.archiveState === "string" && LOG_ARCHIVE_STATES.includes(log.archiveState)) {
    attrs["data-log-archive-state"] = log.archiveState;
    attrs["data-log-archive-label"] = LOG_ARCHIVE_STATE_LABELS[log.archiveState] ?? log.archiveState;
  }
  return attrs;
}

/** 该份日志的归档确认进度（只反映这一份，不构成「全部归档完成」的结论）。 */
function archiveBadge(log: FeedbackLogMeta): ReactNode {
  if (typeof log.archiveState !== "string" || !LOG_ARCHIVE_STATES.includes(log.archiveState)) {
    return <span className="log-note muted">归档进度不可用</span>;
  }
  return (
    <span className={`log-archive-state ${log.archiveState}`}>
      {LOG_ARCHIVE_STATE_LABELS[log.archiveState] ?? log.archiveState}
    </span>
  );
}

/** 截取说明只陈述确定事实：单份上限 8000 码点、送 AI 只取末尾；完整字节仍可下载。 */
function truncationNote(log: FeedbackLogMeta): ReactNode {
  if (log.truncated === true) {
    return (
      <span className="log-note warn">
        该文件超过单份上限（8000 码点），送 AI 时只取末尾 8000 码点；已提交的完整字节仍原样保留，可下载。
      </span>
    );
  }
  if (log.truncated === false) {
    return <span className="log-note muted">未超过单份上限（8000 码点）</span>;
  }
  return <span className="log-note muted">截取状态不可用</span>;
}

/**
 * AI 诊断展示：证据（未逐字校验）与可能原因（推测，未证实）分区块、
 * 不同视觉；推测显式标注「不确定」与置信度。无任何合法条目时整块不渲染（无空壳）。
 */
function DiagnosticsBlock({ diagnostics }: { diagnostics?: FeedbackDiagnostics | null }) {
  const evidence = normalizeEvidence(diagnostics);
  const causes = normalizeCauses(diagnostics);
  if (evidence.length === 0 && causes.length === 0) return null;
  return (
    <div data-testid="diagnostics" style={{ marginTop: 12 }}>
      <h3 style={{ marginBottom: 4 }}>日志分析（附加）</h3>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
        以下内容只作排查参考，不改变上面的整理结果，也不改写用户原话。
      </p>
      {evidence.length > 0 && (
        <div data-testid="diag-evidence" className="diag diag-evidence">
          <div className="diag-title">日志证据（模型摘录自日志原文，未逐字校验）</div>
          <ul className="diag-list">
            {evidence.map((item) => (
              <li
                key={`${item.seq ?? "x"}|${item.filename}|${item.quote}`}
                data-testid="evidence-item"
                data-log-seq={typeof item.seq === "number" ? String(item.seq) : undefined}
              >
                <code>
                  {typeof item.seq === "number" ? `[seq=${item.seq}] ` : ""}
                  {item.filename}
                </code>
                <blockquote>{item.quote}</blockquote>
              </li>
            ))}
          </ul>
        </div>
      )}
      {causes.length > 0 && (
        <div data-testid="diag-causes" className="diag diag-causes">
          <div className="diag-title">可能原因（推测，未证实）</div>
          <ul className="diag-list">
            {causes.map((item) => (
              <li
                key={`${item.confidence}|${item.hypothesis}|${item.basedOn ?? ""}`}
                data-testid="cause-item"
                data-confidence={item.confidence}
              >
                <span className="uncertain-badge">不确定</span>
                <span className="cause-text">{item.hypothesis}</span>
                <span className="muted">（置信度：{CONFIDENCE_LABELS[item.confidence] ?? item.confidence}）</span>
                {item.basedOn && <div className="muted cause-basis">依据：{item.basedOn}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 读取侧防御：旧记录或非法条目一律丢弃，绝不让展示层报错。 */
function normalizeEvidence(diagnostics?: FeedbackDiagnostics | null): LogEvidenceItem[] {
  const raw = diagnostics?.logEvidence;
  if (!Array.isArray(raw)) return [];
  const out: LogEvidenceItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const quote = typeof rec.quote === "string" ? rec.quote.trim() : "";
    const filename = typeof rec.filename === "string" ? rec.filename.trim() : "";
    if (quote === "" || filename === "") continue;
    const seq = typeof rec.seq === "number" && Number.isInteger(rec.seq) ? rec.seq : undefined;
    const key = `${seq ?? "x"}|${filename}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seq === undefined ? { filename, quote } : { seq, filename, quote });
  }
  return out;
}

function normalizeCauses(diagnostics?: FeedbackDiagnostics | null): LogSpeculationItem[] {
  const raw = diagnostics?.possibleCauses;
  if (!Array.isArray(raw)) return [];
  const out: LogSpeculationItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const hypothesis = typeof rec.hypothesis === "string" ? rec.hypothesis.trim() : "";
    if (hypothesis === "") continue;
    const confidence: "low" | "medium" = rec.confidence === "medium" ? "medium" : "low";
    const basedOn = typeof rec.basedOn === "string" && rec.basedOn.trim() !== "" ? rec.basedOn.trim() : undefined;
    const key = `${confidence}|${hypothesis}|${basedOn ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(basedOn === undefined ? { hypothesis, confidence } : { hypothesis, confidence, basedOn });
  }
  return out;
}
