import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionUser } from "../api.ts";
import { Field, InlineError } from "../ui.tsx";

/**
 * T2-A「管理员设置」：修改当前登录管理员自己的用户名与密码。
 * 只作用于当前会话账号；保存成功后服务端撤销该账号全部会话（含当前），
 * 由 App 回到登录页并预填新用户名。
 * 口令只存在于组件内存中：不写入 localStorage / sessionStorage / URL。
 * 错误分级回显：加载失败在页级（可重试）、保存失败贴近提交按钮、
 * 两次新密码不一致贴近「确认新密码」字段。
 */
export default function SettingsView({ onCredentialsUpdated }: { onCredentialsUpdated: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  /** 页级：加载当前账号失败（带重试）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 表单级：保存失败——渲染在表单内、提交按钮上方，修正后直接重试。 */
  const [formError, setFormError] = useState<string | null>(null);
  /** 字段级：两次新密码不一致——贴近「确认新密码」输入框。 */
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api.get<{ user: SessionUser }>("/api/auth/session");
      setUsername(r.user.username);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "加载当前账号失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const nextUsername = username.trim();
    // 两次新密码不一致：前端拦截，不发请求；错误贴近确认字段。
    if (newPassword !== confirmPassword) {
      setConfirmError("两次输入的新密码不一致");
      setConfirmPassword("");
      return;
    }
    setSaving(true);
    setFormError(null);
    setConfirmError(null);
    try {
      await api.patch("/api/admin/me", {
        currentPassword,
        ...(nextUsername !== "" ? { username: nextUsername } : {}),
        ...(newPassword !== "" ? { newPassword } : {}),
      });
      onCredentialsUpdated(nextUsername === "" ? username : nextUsername);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "保存失败");
      // 失败时清空密码字段、保留用户名草稿（便于只修正密码重试）。
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>管理员设置</h1>
          <div className="sub">
            这里只能修改当前登录管理员自己的用户名与密码。保存成功后该账号全部会话（含当前）立即失效，需要重新登录。
            管理员提交反馈不限次数，因此没有管理员额度设置；普通账号的每日额度在「账号」页管理。
          </div>
        </div>
      </div>
      {loadError && <InlineError message={loadError} onRetry={() => void load()} />}

      <form className="card" style={{ maxWidth: 420 }} onSubmit={submit}>
        <div className="form-section">
          <h3 className="form-section-title">登录身份</h3>
          <p className="form-section-desc">
            修改后需用新用户名登录。当前密码用于确认本次修改；保存后全部会话失效，更换密码时旧密码也会失效。
          </p>
          <Field id="me-username" label="用户名" hint="1..100 字符。">
            {(ctl) => (
              <input
                {...ctl}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            )}
          </Field>
          <Field id="me-current" label="当前密码" hint="必须输入当前密码才能保存。">
            {(ctl) => (
              <input
                {...ctl}
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </Field>
        </div>

        <div className="form-section">
          <h3 className="form-section-title">更换密码</h3>
          <p className="form-section-desc">新密码 8..200 字符，首尾空格也算字符；两个字段都留空则只改用户名。</p>
          <Field id="me-new" label="新密码（留空表示只改用户名）">
            {(ctl) => (
              <input
                {...ctl}
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setConfirmError(null);
                }}
                autoComplete="new-password"
              />
            )}
          </Field>
          <Field id="me-confirm" label="确认新密码" error={confirmError}>
            {(ctl) => (
              <input
                {...ctl}
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setConfirmError(null);
                }}
                autoComplete="new-password"
              />
            )}
          </Field>
        </div>

        {/* 保存失败贴近提交按钮：修正后直接再点保存即重试 */}
        {formError && <InlineError message={formError} />}
        <div className="form-actions">
          <button
            className="btn primary"
            type="submit"
            disabled={saving}
            title={saving ? "正在保存…" : undefined}
            aria-busy={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <p className="save-hint">
            保存位置：写入本服务器的管理员账号；成功后该账号全部会话（含当前）立即失效，回到登录页重新登录。
          </p>
        </div>
      </form>
    </div>
  );
}
