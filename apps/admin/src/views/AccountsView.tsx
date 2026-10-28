import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type AccountItem, ApiError, api } from "../api.ts";
import { EmptyState, Field, InlineError, PromptDialog, SkeletonRows, useToast } from "../ui.tsx";

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
  /** 页级错误：列表加载/行级操作失败——位于页头与列表之间，加载失败可原地重试。 */
  const [error, setError] = useState<string | null>(null);
  /** 新建表单错误：贴近新建表单（卡片内、提交按钮上方）。 */
  const [createError, setCreateError] = useState<string | null>(null);
  /** 每日上限错误：贴近对应行的输入框（按账号 id 分别留痕）。 */
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pwTarget, setPwTarget] = useState<AccountItem | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ users: AccountItem[] }>("/api/admin/users");
    setAccounts(r.users);
  }, []);

  /** 列表加载：失败留痕页级错误并提供重试。 */
  const reload = useCallback(async () => {
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 按账号 id 写/清上限字段错误（m=null 清除）。 */
  function setLimitErr(id: string, m: string | null) {
    setLimitErrors((prev) => {
      const next = { ...prev };
      if (m === null) delete next[id];
      else next[id] = m;
      return next;
    });
  }

  /**
   * 统一操作流：busy → 调用 → 回读列表 + 成功 toast；失败按 setErr 指定的位置回显
   * （缺省页级；新建表单与上限输入各自贴近对应字段）。
   */
  async function run(fn: () => Promise<unknown>, okMsg: string, setErr?: (m: string | null) => void) {
    setBusy(true);
    setError(null);
    if (setErr) setErr(null);
    try {
      await fn();
      await load();
      toast("ok", okMsg);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "操作失败";
      if (setErr) setErr(msg);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const dailyLimit = draft.dailyLimit.trim();
    await run(
      async () => {
        await api.post("/api/admin/users", {
          username: draft.username.trim(),
          password: draft.password,
          ...(dailyLimit === "" ? {} : { dailyLimit: Number(dailyLimit) }),
        });
        setDraft(empty);
      },
      "账号已创建",
      setCreateError,
    );
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
      setLimitErr(a.id, "每日上限必须是不小于 0 的整数（0 表示禁止新提交）");
      return;
    }
    await run(
      () => api.patch(`/api/admin/users/${a.id}`, { dailyLimit: value }),
      "每日上限已更新",
      (m) => setLimitErr(a.id, m),
    );
  }

  async function resetPassword(a: AccountItem, password: string) {
    if (password === "") {
      throw new Error("新密码不能为空");
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/users/${a.id}/password`, { password });
      // 重置已成功；回读失败独立留在页级，不能误导用户再次提交密码重置。
      await reload();
      // 先解除行按钮禁用，弹窗卸载时才能将焦点还给打开弹窗的按钮。
      setBusy(false);
      setPwTarget(null);
      toast("ok", "密码已重置，该账号的旧会话已全部撤销");
    } finally {
      setBusy(false);
    }
  }

  /** 禁用态的可见原因：busy 一律说明「进行中」，创建按钮还区分必填未完成。 */
  const busyTitle = busy ? "有操作进行中，稍候重试" : undefined;

  return (
    <div className="accounts-page">
      <div className="page-header">
        <div>
          <h1>账号</h1>
          <div className="sub">
            账号由后台创建并分发，不开放注册。这里只列出普通账号：默认每日 3 次，所有接入项目与设备共用同一每日额度，
            按北京时间每天零点刷新。管理员不在此列表——提交不限次数，无需额度配置。
          </div>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void reload()} />}

      <div className="accounts-sections">
        <div className="accounts-list-section">
          <div className="table-wrap">
            {accounts === null ? (
              /* 加载态：进度文案 + 骨架占位（结构高度与真实表格接近，减少跳版） */
              <div>
                <p className="muted" style={{ margin: 0, padding: "var(--sp-4) var(--sp-4) 0" }}>
                  加载中…
                </p>
                <SkeletonRows rows={3} />
              </div>
            ) : accounts.length === 0 ? (
              <EmptyState
                title="还没有普通账号"
                hint="使用下方表单创建第一个账号。"
                action={
                  <button type="button" className="btn sm" onClick={() => document.getElementById("un")?.focus()}>
                    前往新建账号表单
                  </button>
                }
              />
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
                            onChange={(e) => {
                              setLimitEdits((m) => ({ ...m, [a.id]: e.target.value }));
                              setLimitErr(a.id, null); // 修改即清除该字段上一轮的错误
                            }}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            title={busyTitle}
                            onClick={() => saveLimit(a)}
                          >
                            保存
                          </button>
                        </div>
                        {limitErrors[a.id] && (
                          <div className="field-error" role="alert">
                            {limitErrors[a.id]}
                          </div>
                        )}
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
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            title={busyTitle}
                            onClick={() => toggleEnabled(a)}
                          >
                            {a.enabled ? "禁用" : "启用"}
                          </button>
                          {/* 重置密码是破坏性操作：danger 视觉分级 + 弹窗二次确认（PromptDialog）。 */}
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={busy}
                            title={busyTitle}
                            onClick={() => setPwTarget(a)}
                          >
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
        </div>

        <div className="accounts-create-section">
          <div className="card">
            <h2>新建账号</h2>
            <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <Field id="un" label="用户名" hint="登录时使用的名称，由后台创建与分发。">
                  {(ctl) => (
                    <input
                      {...ctl}
                      value={draft.username}
                      onChange={(e) => {
                        setDraft({ ...draft, username: e.target.value });
                        setCreateError(null);
                      }}
                    />
                  )}
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field id="up" label="密码" hint="分发给使用者；遗忘时可在上方列表中重置。">
                  {(ctl) => (
                    <input
                      {...ctl}
                      type="password"
                      autoComplete="new-password"
                      value={draft.password}
                      onChange={(e) => {
                        setDraft({ ...draft, password: e.target.value });
                        setCreateError(null);
                      }}
                    />
                  )}
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field id="ul" label="每日上限" hint="留空使用服务端默认 3；0 表示禁止新提交。">
                  {(ctl) => (
                    <input
                      {...ctl}
                      inputMode="numeric"
                      value={draft.dailyLimit}
                      onChange={(e) => {
                        setDraft({ ...draft, dailyLimit: e.target.value });
                        setCreateError(null);
                      }}
                    />
                  )}
                </Field>
              </div>
            </div>
            {/* 表单级错误贴近提交按钮：修正后点「创建账号」即重试 */}
            {createError && <InlineError message={createError} />}
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy || !draft.username.trim() || !draft.password}
                title={
                  busy ? busyTitle : !draft.username.trim() || !draft.password ? "填写用户名与密码后可创建" : undefined
                }
                onClick={create}
              >
                创建账号
              </button>
            </div>
            <p className="save-hint">保存位置：写入本服务器的账号列表；创建后立即可用于登录。</p>
          </div>
        </div>
      </div>

      {pwTarget && (
        <PromptDialog
          title={`重置「${pwTarget.username}」的密码`}
          body={<p>新密码不会显示在列表中；重置后该账号的旧会话将全部撤销。</p>}
          label="新密码"
          inputType="password"
          autoComplete="new-password"
          confirmLabel="重置密码"
          danger
          onClose={() => setPwTarget(null)}
          onSubmit={(v) => resetPassword(pwTarget, v)}
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
