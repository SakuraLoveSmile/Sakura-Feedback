import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionItem } from "../api.ts";
import { ConfirmDialog, EmptyState, Icon, InlineError, SkeletonRows, useToast } from "../ui.tsx";

export default function SessionsView() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeAllAsk, setRevokeAllAsk] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ sessions: SessionItem[] }>("/api/auth/sessions");
      setSessions(r.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    try {
      await api.del(`/api/auth/sessions/${id}`);
      toast("ok", "会话已撤销");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "撤销失败");
    }
  }

  async function revokeAll() {
    try {
      const r = await api.post<{ revoked: number }>("/api/auth/sessions/revoke-all");
      setError(null);
      toast("ok", `已撤销 ${r.revoked} 个会话`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "撤销失败");
    }
  }

  const current = sessions?.find((s) => s.current) ?? null;

  return (
    <div className="sessions-page">
      <div className="page-header">
        <div>
          <h1>会话</h1>
          <div className="sub">当前登录的浏览器会话与客户端令牌；撤销后对应客户端需重新登录，当前会话始终保留。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            刷新
          </button>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void load()} />}

      <div className="sessions-grid">
        <div className="table-wrap">
          {sessions === null ? (
            <SkeletonRows rows={4} />
          ) : sessions.length === 0 ? (
            <EmptyState
              title="没有会话"
              hint="在其他浏览器或客户端登录后，会话会自动出现在这里。"
              action={
                <button type="button" className="btn sm" onClick={() => void load()}>
                  刷新
                </button>
              }
            />
          ) : (
            <table className="session-table">
              <thead>
                <tr>
                  <th>设备 / 标签</th>
                  <th>类型</th>
                  <th>最近使用</th>
                  <th>过期</th>
                  <th className="col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className={s.current ? "current" : undefined}>
                    <td>
                      <span className="session-name">
                        <span className={`session-icon tone-${s.kind}`} aria-hidden="true">
                          {kindIcon(s.kind)}
                        </span>
                        <span className="session-label">{s.clientLabel ?? "—"}</span>
                      </span>
                    </td>
                    <td>{kindLabel(s.kind)}</td>
                    <td className="muted tnum">
                      {s.lastUsedAt ? (
                        <time dateTime={s.lastUsedAt} title={new Date(s.lastUsedAt).toLocaleString()}>
                          {relTime(s.lastUsedAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="muted tnum">
                      <time dateTime={s.expiresAt} title={new Date(s.expiresAt).toLocaleString()}>
                        {relTime(s.expiresAt)}
                      </time>
                    </td>
                    <td className="col-action">
                      {s.current ? (
                        <span className="tag tone-info">当前</span>
                      ) : (
                        <button
                          type="button"
                          className="btn sm danger"
                          title="撤销该会话后，对应客户端需要重新登录"
                          onClick={() => setRevokeTarget(s.id)}
                        >
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="sessions-side">
          {current && (
            <div className="card session-current-card">
              <h2 className="session-current-title">当前会话</h2>
              <div className="session-name">
                <span className={`session-icon tone-${current.kind}`} aria-hidden="true">
                  {kindIcon(current.kind)}
                </span>
                <div className="session-current-text">
                  <b>{current.clientLabel ?? kindLabel(current.kind)}</b>
                  <div className="muted small">这是你正在使用的会话</div>
                </div>
              </div>
              <dl className="kv session-kv">
                <dt>创建时间</dt>
                <dd>{new Date(current.createdAt).toLocaleString()}</dd>
                <dt>最近使用</dt>
                <dd>{current.lastUsedAt ? new Date(current.lastUsedAt).toLocaleString() : "—"}</dd>
                <dt>过期时间</dt>
                <dd>{new Date(current.expiresAt).toLocaleString()}</dd>
              </dl>
            </div>
          )}

          {/* 危险操作独立分区：与常规列表/刷新分开，进入即知影响范围，执行仍走二次确认。 */}
          <div className="danger-zone">
            <div className="danger-zone-head">
              <h2>危险操作</h2>
              <span className="tag tone-err">需二次确认</span>
            </div>
            <p>
              撤销除当前会话外的全部浏览器会话与客户端令牌：相关客户端需重新登录，且此操作不可撤销。当前会话不受影响。
            </p>
            <button type="button" className="btn danger" onClick={() => setRevokeAllAsk(true)}>
              撤销其它全部会话
            </button>
          </div>
        </div>
      </div>

      {revokeAllAsk && (
        <ConfirmDialog
          title="撤销其它全部会话？"
          body={<p>除当前会话外，所有浏览器会话与客户端令牌将被撤销，相关客户端需重新登录。</p>}
          confirmLabel="全部撤销"
          danger
          onClose={() => setRevokeAllAsk(false)}
          onConfirm={() => {
            setRevokeAllAsk(false);
            void revokeAll();
          }}
        />
      )}
      {revokeTarget && (
        <ConfirmDialog
          title="撤销该会话？"
          body={<p>对应客户端需要重新登录。</p>}
          confirmLabel="撤销"
          danger
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => {
            const id = revokeTarget;
            setRevokeTarget(null);
            void revoke(id);
          }}
        />
      )}
    </div>
  );
}

function kindLabel(k: string): ReactNode {
  return { cookie: "浏览器会话", client: "客户端令牌", handshake: "Web 短期令牌" }[k] ?? k;
}

function kindIcon(k: string): ReactNode {
  if (k === "client") return <Icon name="key" size={16} />;
  if (k === "handshake") return <Icon name="clock" size={16} />;
  return <Icon name="link" size={16} />;
}

/** 相对时间：过去「N 前」、未来「N 后」；完整时间由 title 提供。 */
function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = d.getTime() - Date.now();
  if (Math.abs(diff) < 60_000) return diff >= 0 ? "1 分钟内" : "刚刚";
  const mins = Math.floor(Math.abs(diff) / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const text = days >= 1 ? `${days} 天` : hours >= 1 ? `${hours} 小时` : `${mins} 分钟`;
  return diff < 0 ? `${text}前` : `${text}后`;
}
