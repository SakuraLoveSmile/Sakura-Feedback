import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type SessionUser } from "../api.ts";

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
    <div>
      {error && <p className="err">{error}</p>}
      <p className="muted" style={{ marginTop: 0 }}>
        这里只能修改当前登录管理员自己的用户名与密码。保存成功后该账号全部会话（含当前）立即失效，需要重新登录。
      </p>
      <form className="card" style={{ maxWidth: 420 }} onSubmit={submit}>
        <div className="field">
          <label htmlFor="me-username">用户名</label>
          <input
            id="me-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
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
          <label htmlFor="me-new">新密码（留空表示只改用户名）</label>
          <input
            id="me-new"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label htmlFor="me-confirm">确认新密码</label>
          <input
            id="me-confirm"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          新密码 8..200 字符，首尾空格也算字符；用户名 1..100 字符。
        </p>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </form>
    </div>
  );
}
