import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionUser } from "../api.ts";
import { FormSection, InlineError, PageHeader } from "../ui.tsx";

/**
 * T2-A「管理员设置」：修改当前登录管理员自己的用户名与密码。
 * 只作用于当前会话账号；保存成功后服务端撤销该账号全部会话（含当前），
 * 由 App 回到登录页并预填新用户名。
 * 口令只存在于组件内存中：不写入 localStorage / sessionStorage / URL。
 */
export default function SettingsView({ onCredentialsUpdated }: { onCredentialsUpdated: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ user: SessionUser }>("/api/auth/session");
      setUsername(r.user.username);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载当前账号失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const nextUsername = username.trim();
    // 两次新密码不一致：前端拦截，不发请求。
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      setConfirmPassword("");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patch("/api/admin/me", {
        currentPassword,
        ...(nextUsername !== "" ? { username: nextUsername } : {}),
        ...(newPassword !== "" ? { newPassword } : {}),
      });
      onCredentialsUpdated(nextUsername === "" ? username : nextUsername);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
      // 失败时清空密码字段、保留用户名草稿（便于只修正密码重试）。
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-form">
      <PageHeader title="管理员设置" sub="修改当前登录管理员自己的用户名与密码。" />
      <form className="card" onSubmit={submit}>
        <FormSection title="管理员身份">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="me-username">用户名</label>
            <input
              id="me-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
            <p className="field-help">1–100 字符。</p>
          </div>
        </FormSection>
        <FormSection title="修改密码" desc="留空新密码则只修改用户名。">
          <div className="field">
            <label htmlFor="me-current">当前密码</label>
            <input
              id="me-current"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="me-new">新密码</label>
            <input
              id="me-new"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="field-help">8–200 字符，首尾空格也算字符。</p>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="me-confirm">确认新密码</label>
            <input
              id="me-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </FormSection>
        <div className="form-section" style={{ paddingBottom: 0 }}>
          {error && <InlineError message={error} />}
          <p className="muted small" style={{ marginTop: 0 }}>
            保存后需要重新登录：该账号全部会话（含当前）立即失效。
          </p>
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存并重新登录"}
          </button>
        </div>
      </form>
    </div>
  );
}
