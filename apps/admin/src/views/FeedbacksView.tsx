import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api, type FeedbackDetail, type FeedbackListItem, STATUS_LABELS } from "../api.ts";

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
              <th>状态</th>
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
                <td colSpan={6} className="muted" style={{ padding: 20 }}>
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
        <span className={`tag ${detail.status}`}>{STATUS_LABELS[detail.status] ?? detail.status}</span>
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
