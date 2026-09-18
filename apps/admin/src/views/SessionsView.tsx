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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>会话</h1>
          <div className="sub">当前登录的浏览器会话与客户端令牌；撤销后对应客户端需重新登录。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setRevokeAllAsk(true)}>
            撤销其它全部会话
          </button>
          <button type="button" className="btn" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            刷新
          </button>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void load()} />}

      <div className="table-wrap">
        {sessions === null ? (
          <SkeletonRows rows={4} />
        ) : sessions.length === 0 ? (
          <EmptyState title="没有会话" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>标签</th>
                <th>创建</th>
                <th>最近使用</th>
                <th>过期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{kindLabel(s.kind)}</td>
                  <td>{s.clientLabel ?? "—"}</td>
                  <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="muted">{s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}</td>
                  <td className="muted">{new Date(s.expiresAt).toLocaleString()}</td>
                  <td>
                    {s.current ? (
                      <span className="tag tone-info">当前</span>
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
        )}
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
