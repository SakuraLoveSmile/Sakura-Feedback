import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionItem } from "../api.ts";
import {
  ConfirmDialog,
  EmptyState,
  Icon,
  InlineError,
  PageHeader,
  SkeletonRows,
  StatusBadge,
  useToast,
} from "../ui.tsx";

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

  return (
    <div className="page-config">
      <PageHeader
        title="会话"
        sub="当前登录的浏览器会话与客户端令牌；撤销后对应客户端需重新登录。"
        actions={
          <>
            <button type="button" className="btn" onClick={() => setRevokeAllAsk(true)}>
              撤销其他会话
            </button>
            <button type="button" className="btn" onClick={() => void load()} aria-label="刷新会话列表">
              <Icon name="refresh" size={16} />
            </button>
          </>
        }
      />
      {error && <InlineError message={error} onRetry={() => void load()} />}

      {sessions === null ? (
        <div className="table-wrap">
          <SkeletonRows rows={4} />
        </div>
      ) : sessions.length === 0 ? (
        <div className="table-wrap">
          <EmptyState title="没有会话" />
        </div>
      ) : (
        <>
          {/* 桌面表格（≥768px） */}
          <div className="table-wrap">
            <table className="kv-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>标签</th>
                  <th>创建时间</th>
                  <th>最近使用</th>
                  <th>过期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {kindLabel(s.kind)}
                      {s.current && (
                        <>
                          {" "}
                          <StatusBadge tone="info">当前会话</StatusBadge>
                        </>
                      )}
                    </td>
                    <td>{s.clientLabel ?? "—"}</td>
                    <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="muted">{s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}</td>
                    <td className="muted">{new Date(s.expiresAt).toLocaleString()}</td>
                    <td>
                      {s.current ? (
                        <span className="muted">—</span>
                      ) : (
                        <button type="button" className="btn sm" onClick={() => setRevokeTarget(s.id)}>
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 移动键值卡片（<768px） */}
          <div className="kv-cards">
            {sessions.map((s) => (
              <div key={s.id} className="kv-card">
                <div className="kv-card-row">
                  <span>类型</span>
                  <span>
                    {kindLabel(s.kind)}
                    {s.current && (
                      <>
                        {" "}
                        <StatusBadge tone="info">当前会话</StatusBadge>
                      </>
                    )}
                  </span>
                </div>
                <div className="kv-card-row">
                  <span>标签</span>
                  <span>{s.clientLabel ?? "—"}</span>
                </div>
                <div className="kv-card-row">
                  <span>创建时间</span>
                  <span>{new Date(s.createdAt).toLocaleString()}</span>
                </div>
                <div className="kv-card-row">
                  <span>最近使用</span>
                  <span>{s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}</span>
                </div>
                <div className="kv-card-row">
                  <span>过期时间</span>
                  <span>{new Date(s.expiresAt).toLocaleString()}</span>
                </div>
                {!s.current && (
                  <div style={{ marginTop: "var(--sp-2)", textAlign: "right" }}>
                    <button type="button" className="btn sm" onClick={() => setRevokeTarget(s.id)}>
                      撤销
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {revokeAllAsk && (
        <ConfirmDialog
          title="撤销其他全部会话？"
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
