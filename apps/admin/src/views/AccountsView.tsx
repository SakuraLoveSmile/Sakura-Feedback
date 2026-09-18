import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type AccountItem, ApiError, api } from "../api.ts";
import { EmptyState, Field, InlineError, PromptDialog, useToast } from "../ui.tsx";

interface Draft {
  username: string;
  password: string;
  dailyLimit: string; // 留空 = 服务端默认（每日 3 次）
}

const empty: Draft = { username: "", password: "", dailyLimit: "" };

export default function AccountsView() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<AccountItem[] | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [limitEdits, setLimitEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwTarget, setPwTarget] = useState<AccountItem | null>(null);

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
    try {
      await fn();
      await load();
      toast("ok", okMsg);
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

  async function resetPassword(a: AccountItem, password: string) {
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
      <div className="page-header">
        <div>
          <h1>账号</h1>
          <div className="sub">
            账号由后台创建并分发，不开放注册。所有接入项目与设备共用同一每日额度，按北京时间每天零点刷新。
          </div>
        </div>
      </div>
      {error && <InlineError message={error} />}

      <div className="table-wrap">
        {accounts === null ? (
          <p className="muted" style={{ padding: "var(--sp-4)" }}>
            加载中…
          </p>
        ) : accounts.length === 0 ? (
          <EmptyState title="还没有普通账号" hint="使用下方表单创建第一个账号。" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>状态</th>
                <th>每日上限</th>
                <th>今日已用</th>
                <th>剩余次数</th>
                <th>操作</th>
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
                    <div className="row" style={{ gap: "var(--sp-2)" }}>
                      <input
                        aria-label={`${a.username} 每日上限`}
                        style={{ width: 80 }}
                        value={limitEdits[a.id] ?? String(a.dailyLimit)}
                        onChange={(e) => setLimitEdits((m) => ({ ...m, [a.id]: e.target.value }))}
                      />
                      <button type="button" className="btn sm" disabled={busy} onClick={() => saveLimit(a)}>
                        保存
                      </button>
                    </div>
                  </td>
                  <td className="muted">{a.used}</td>
                  <td>
                    <b>{a.remaining}</b>
                    <span className="muted small" style={{ marginLeft: 6 }}>
                      （{resetLabel(a.resetAt)}刷新）
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ gap: "var(--sp-2)" }}>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => toggleEnabled(a)}>
                        {a.enabled ? "禁用" : "启用"}
                      </button>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => setPwTarget(a)}>
                        重置密码
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>新建账号</h2>
        <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field id="un" label="用户名">
              {(ctl) => (
                <input
                  {...ctl}
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field id="up" label="密码">
              {(ctl) => (
                <input
                  {...ctl}
                  type="password"
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field id="ul" label="每日上限（留空默认 3）">
              {(ctl) => (
                <input
                  {...ctl}
                  inputMode="numeric"
                  value={draft.dailyLimit}
                  onChange={(e) => setDraft({ ...draft, dailyLimit: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn primary"
            disabled={busy || !draft.username.trim() || !draft.password}
            onClick={create}
          >
            创建账号
          </button>
        </div>
      </div>

      {pwTarget && (
        <PromptDialog
          title={`重置「${pwTarget.username}」的密码`}
          body={<p>新密码不会显示在列表中；重置后该账号的旧会话将全部撤销。</p>}
          label="新密码"
          confirmLabel="重置密码"
          onClose={() => setPwTarget(null)}
          onSubmit={(v) => {
            const t = pwTarget;
            setPwTarget(null);
            void resetPassword(t, v);
          }}
        />
      )}
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
