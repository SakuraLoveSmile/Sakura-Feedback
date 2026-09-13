import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type AccountItem, ApiError, api } from "../api.ts";

interface Draft {
  username: string;
  password: string;
  dailyLimit: string; // 留空 = 服务端默认（每日 3 次）
}

const empty: Draft = { username: "", password: "", dailyLimit: "" };

export default function AccountsView() {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [limitEdits, setLimitEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get<{ users: AccountItem[] }>("/api/admin/users");
    setAccounts(r.users);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [load]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      setNotice(okMsg);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const dailyLimit = draft.dailyLimit.trim();
    await run(async () => {
      await api.post("/api/admin/users", {
        username: draft.username.trim(),
        password: draft.password,
        ...(dailyLimit === "" ? {} : { dailyLimit: Number(dailyLimit) }),
      });
      setDraft(empty);
    }, "账号已创建");
  }

  async function toggleEnabled(a: AccountItem) {
    setLimitEdits((m) => ({ ...m, [a.id]: m[a.id] ?? String(a.dailyLimit) }));
    await run(
      () => api.patch(`/api/admin/users/${a.id}`, { enabled: !a.enabled }),
      a.enabled ? "账号已禁用，其全部会话已撤销" : "账号已启用",
    );
  }

  async function saveLimit(a: AccountItem) {
    const raw = (limitEdits[a.id] ?? String(a.dailyLimit)).trim();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      setError("每日上限必须是不小于 0 的整数（0 表示禁止新提交）");
      return;
    }
    await run(() => api.patch(`/api/admin/users/${a.id}`, { dailyLimit: value }), "每日上限已更新");
  }

  async function resetPassword(a: AccountItem) {
    const password = window.prompt(`为「${a.username}」设置新密码（不会显示在列表中）：`);
    if (password === null) return;
    if (password === "") {
      setError("新密码不能为空");
      return;
    }
    await run(
      () => api.post(`/api/admin/users/${a.id}/password`, { password }),
      "密码已重置，该账号的旧会话已全部撤销",
    );
  }

  return (
    <div>
      {error && <p className="err">{error}</p>}
      {notice && <p className="ok-text">{notice}</p>}
      <p className="muted" style={{ marginTop: 0 }}>
        账号由后台创建并分发，不开放注册。所有接入项目与设备共用同一每日额度，按北京时间每天零点刷新。
      </p>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>状态</th>
              <th>每日上限</th>
              <th>今日已用</th>
              <th>剩余次数</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <code>{a.username}</code>
                </td>
                <td>{statusTag(a.enabled)}</td>
                <td>
                  <input
                    aria-label={`${a.username} 每日上限`}
                    style={{ width: 80 }}
                    value={limitEdits[a.id] ?? String(a.dailyLimit)}
                    onChange={(e) => setLimitEdits((m) => ({ ...m, [a.id]: e.target.value }))}
                  />
                  <button type="button" disabled={busy} onClick={() => saveLimit(a)} style={{ marginLeft: 6 }}>
                    保存
                  </button>
                </td>
                <td className="muted">{a.used}</td>
                <td>
                  <b>{a.remaining}</b>
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                    （{resetLabel(a.resetAt)}刷新）
                  </span>
                </td>
                <td className="row">
                  <button type="button" disabled={busy} onClick={() => toggleEnabled(a)}>
                    {a.enabled ? "禁用" : "启用"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => resetPassword(a)}>
                    重置密码
                  </button>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 16 }}>
                  还没有普通账号，用下方表单创建
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h1>新建账号</h1>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="un">用户名</label>
            <input id="un" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="up">密码</label>
            <input
              id="up"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="ul">每日上限（留空默认 3）</label>
            <input
              id="ul"
              inputMode="numeric"
              value={draft.dailyLimit}
              onChange={(e) => setDraft({ ...draft, dailyLimit: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={busy || !draft.username.trim() || !draft.password}
            onClick={create}
          >
            创建账号
          </button>
        </div>
      </div>
    </div>
  );
}

function statusTag(enabled: boolean): ReactNode {
  return enabled ? <span className="tag archived">启用</span> : <span className="tag failed">已禁用</span>;
}

function resetLabel(resetAt: string): string {
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleString()} `;
}
