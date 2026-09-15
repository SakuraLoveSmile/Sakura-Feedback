import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import AccountsView from "./views/AccountsView.tsx";
import AppsView from "./views/AppsView.tsx";
import ConnectionsView from "./views/ConnectionsView.tsx";
import FeedbacksView from "./views/FeedbacksView.tsx";
import SessionsView from "./views/SessionsView.tsx";
import SettingsView from "./views/SettingsView.tsx";
import SystemUpdateView from "./views/SystemUpdateView.tsx";

type Tab = "feedbacks" | "apps" | "connections" | "accounts" | "sessions" | "settings" | "system-update";

const TABS: { id: Tab; label: string }[] = [
  { id: "feedbacks", label: "反馈" },
  { id: "apps", label: "软件配置" },
  { id: "connections", label: "连接配置" },
  { id: "accounts", label: "账号" },
  { id: "sessions", label: "会话" },
  { id: "settings", label: "管理员设置" },
  { id: "system-update", label: "系统更新" },
];

function LoginView({
  onSuccess,
  initialUsername = "",
  notice = null,
}: {
  onSuccess: () => void;
  initialUsername?: string;
  notice?: string | null;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { username, password });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "15vh auto" }}>
      <form className="card" onSubmit={submit}>
        <h1>Feedback 管理登录</h1>
        {notice && <p className="ok-text">{notice}</p>}
        <div className="field">
          <label htmlFor="u">用户名</label>
          <input
            id="u"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="p">密码</label>
          <input
            id="p"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <p className="err">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("feedbacks");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      await api.get("/api/auth/session");
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function logout() {
    await api.post("/api/auth/logout").catch(() => undefined);
    setAuthed(false);
  }

  /** 管理员设置保存成功：会话已在服务端撤销，回到登录页并预填新用户名。 */
  function handleCredentialsUpdated(username: string) {
    setLoginUsername(username);
    setLoginNotice("凭据已更新，请重新登录");
    setTab("feedbacks");
    setAuthed(false);
  }

  if (authed === null)
    return (
      <p className="muted" style={{ padding: 40 }}>
        正在检查登录状态…
      </p>
    );
  if (!authed)
    return <LoginView onSuccess={() => setAuthed(true)} initialUsername={loginUsername} notice={loginNotice} />;

  return (
    <div style={{ maxWidth: 1060, margin: "0 auto", padding: "24px 16px" }}>
      <header className="row spread" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Feedback 管理</h1>
        <button type="button" onClick={logout}>
          退出登录
        </button>
      </header>
      <nav className="tabs" aria-label="管理页标签">
        {TABS.map((t) => (
          <button type="button" key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main>{renderTab(tab, handleCredentialsUpdated)}</main>
    </div>
  );
}

function renderTab(tab: Tab, onCredentialsUpdated: (username: string) => void): ReactNode {
  switch (tab) {
    case "feedbacks":
      return <FeedbacksView />;
    case "apps":
      return <AppsView />;
    case "connections":
      return <ConnectionsView />;
    case "accounts":
      return <AccountsView />;
    case "sessions":
      return <SessionsView />;
    case "settings":
      // 保存成功后会话失效 → 由 App 回到登录页并预填新用户名。
      return <SettingsView onCredentialsUpdated={onCredentialsUpdated} />;
    case "system-update":
      return <SystemUpdateView />;
  }
}
