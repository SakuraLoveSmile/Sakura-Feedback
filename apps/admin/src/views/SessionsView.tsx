import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionItem } from "../api.ts";

export default function SessionsView() {
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ sessions: SessionItem[] }>("/api/auth/sessions");
      setSessions(r.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    await api.del(`/api/auth/sessions/${id}`);
    await load();
  }

  async function revokeAll() {
    if (!window.confirm("撤销除当前外的全部会话？客户端需重新登录。")) return;
    const r = await api.post<{ revoked: number }>("/api/auth/sessions/revoke-all");
    setError(null);
    alert(`已撤销 ${r.revoked} 个会话`);
    await load();
  }

  if (!sessions) return <p className="muted">加载中…</p>;

  return (
    <div>
      {error && <p className="err">{error}</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" onClick={revokeAll}>
          撤销其它全部会话
        </button>
        <button type="button" onClick={load}>
          刷新
        </button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>标签</th>
              <th>创建</th>
              <th>最近使用</th>
              <th>过期</th>
              <th></th>
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
                    <span className="tag">当前</span>
                  ) : (
                    <button type="button" onClick={() => revoke(s.id)}>
                      撤销
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function kindLabel(k: string): ReactNode {
  return { cookie: "浏览器会话", client: "客户端令牌", handshake: "Web 短期令牌" }[k] ?? k;
}
