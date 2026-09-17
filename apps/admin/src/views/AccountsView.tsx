import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type AccountItem, ApiError, api } from "../api.ts";
import {
  EmptyState,
  Icon,
  InlineError,
  Modal,
  MoreMenu,
  PageHeader,
  PromptDialog,
  SkeletonRows,
  StatusBadge,
  useToast,
} from "../ui.tsx";

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
  const [createOpen, setCreateOpen] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState<AccountItem | null>(null);
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
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const dailyLimit = draft.dailyLimit.trim();
    const ok = await run(async () => {
      await api.post("/api/admin/users", {
        username: draft.username.trim(),
        password: draft.password,
        ...(dailyLimit === "" ? {} : { dailyLimit: Number(dailyLimit) }),
      });
    }, "账号已创建");
    if (ok) {
      setDraft(empty);
      setCreateOpen(false);
    }
  }

  async function toggleEnabled(a: AccountItem) {
    await run(
      () => api.patch(`/api/admin/users/${a.id}`, { enabled: !a.enabled }),
      a.enabled ? "账号已禁用，其全部会话已撤销" : "账号已启用",
    );
  }

  async function saveLimit(a: AccountItem, raw: string) {
    const value = Number(raw.trim());
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
    <div className="page-config">
      <PageHeader
        title="账号"
        sub="账号由后台创建并分发，不开放注册；按北京时间每天零点刷新额度。"
        actions={
          <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={16} />
            新建账号
          </button>
        }
      />
      {error && !createOpen && !quotaTarget && <InlineError message={error} />}

      <div className="table-wrap">
        {accounts === null ? (
          <SkeletonRows rows={4} />
        ) : accounts.length === 0 ? (
          <EmptyState title="还没有普通账号" hint="点右上角「新建账号」创建第一个账号。" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>状态</th>
                <th>今日使用</th>
                <th>剩余次数</th>
                <th style={{ width: 56 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <code>{a.username}</code>
                  </td>
                  <td>{statusTag(a.enabled)}</td>
                  <td className="usage-cell">
                    <span className="usage-num">
                      {a.used} /{" "}
                      <button
                        type="button"
                        className="quota-view"
                        title="点击修改每日上限"
                        onClick={() => setQuotaTarget(a)}
                      >
                        {a.dailyLimit}
                      </button>
                    </span>
                    <span className={`usage-bar${a.dailyLimit === 0 || a.used >= a.dailyLimit ? " full" : ""}`}>
                      <i style={{ width: `${usagePct(a)}%` }} />
                    </span>
                  </td>
                  <td>
                    <b>{a.remaining}</b>
                    <span className="muted small" style={{ marginLeft: 6 }}>
                      （{resetLabel(a.resetAt)}刷新）
                    </span>
                  </td>
                  <td>
                    <MoreMenu
                      items={[
                        { label: "修改每日上限", onClick: () => setQuotaTarget(a) },
                        { label: "重置密码", onClick: () => setPwTarget(a) },
                        {
                          label: a.enabled ? "禁用账号" : "启用账号",
                          danger: a.enabled,
                          onClick: () => void toggleEnabled(a),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <Modal
          title="新建账号"
          onClose={() => {
            setCreateOpen(false);
            setError(null);
          }}
          actions={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCreateOpen(false);
                  setError(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !draft.username.trim() || !draft.password}
                onClick={() => void create()}
              >
                创建账号
              </button>
            </>
          }
        >
          {error && <InlineError message={error} />}
          <div className="field">
            <label htmlFor="un">用户名</label>
            <input id="un" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="up">密码</label>
            <input
              id="up"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="ul">每日上限</label>
            <input
              id="ul"
              inputMode="numeric"
              value={draft.dailyLimit}
              onChange={(e) => setDraft({ ...draft, dailyLimit: e.target.value })}
            />
            <p className="field-help">留空使用默认值 3；0 表示禁止新提交。</p>
          </div>
        </Modal>
      )}

      {quotaTarget && (
        <PromptDialog
          title={`修改「${quotaTarget.username}」的每日上限`}
          body={<p>每日上限是不小于 0 的整数；0 表示禁止新提交。</p>}
          label="每日上限"
          placeholder={String(quotaTarget.dailyLimit)}
          confirmLabel="保存"
          onClose={() => setQuotaTarget(null)}
          onSubmit={(v) => {
            const t = quotaTarget;
            setQuotaTarget(null);
            void saveLimit(t, v);
          }}
        />
      )}

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
  return enabled ? <StatusBadge tone="ok">启用</StatusBadge> : <StatusBadge tone="err">已禁用</StatusBadge>;
}

function usagePct(a: AccountItem): number {
  if (a.dailyLimit <= 0) return 100;
  return Math.min(100, Math.round((a.used / a.dailyLimit) * 100));
}

function resetLabel(resetAt: string): string {
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleString()} `;
}
