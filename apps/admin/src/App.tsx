import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// 导入即自动注册 <feedback-widget> 自定义元素（副作用）。
import "@feedback/web";
import type { FeedbackWidget } from "@feedback/web";
import { ApiError, api } from "./api.ts";
import { startFeedbackHostSession } from "./feedback-host.ts";
import { ThemeSelect, useThemePreference, useThemeSync } from "./theme.tsx";
import { Field, Icon, ToastProvider } from "./ui.tsx";
import { useUrlState } from "./url.ts";
import AccountsView from "./views/AccountsView.tsx";
import AppsView from "./views/AppsView.tsx";
import ConnectionsView from "./views/ConnectionsView.tsx";
import FeedbacksView from "./views/FeedbacksView.tsx";
import SessionsView from "./views/SessionsView.tsx";
import SettingsView from "./views/SettingsView.tsx";
import SystemUpdateView from "./views/SystemUpdateView.tsx";

type Page = "feedbacks" | "apps" | "accounts" | "connections" | "sessions" | "settings" | "system-update";

const NAV_GROUPS: { label: string; items: { id: Page; label: string; icon: string }[] }[] = [
  { label: "工作台", items: [{ id: "feedbacks", label: "反馈", icon: "feedback" }] },
  {
    label: "管理",
    items: [
      { id: "apps", label: "软件配置", icon: "apps" },
      { id: "accounts", label: "账号", icon: "users" },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "connections", label: "连接配置", icon: "link" },
      { id: "sessions", label: "会话", icon: "clock" },
      { id: "settings", label: "管理员设置", icon: "key" },
      { id: "system-update", label: "系统更新", icon: "update" },
    ],
  },
];

const PAGE_IDS = new Set<string>(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)));

function pageOf(params: URLSearchParams): Page {
  const p = params.get("page") ?? "feedbacks";
  return (PAGE_IDS.has(p) ? p : "feedbacks") as Page;
}

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
    <div className="login-wrap">
      <form className="card" onSubmit={submit}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--sp-3)",
            marginBottom: "var(--sp-4)",
          }}
        >
          <h1>Feedback 管理登录</h1>
          <ThemeSelect />
        </div>
        {notice && <p className="ok-text">{notice}</p>}
        <Field id="u" label="用户名">
          {(ctl) => (
            <input
              {...ctl}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          )}
        </Field>
        <Field id="p" label="密码" error={error}>
          {(ctl) => (
            <input
              {...ctl}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

function NavItems({ page, onNav }: { page: Page; onNav: (p: Page) => void }) {
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <div key={g.label}>
          <div className="nav-group-label">{g.label}</div>
          {g.items.map((it) => (
            <button
              type="button"
              key={it.id}
              className={`nav-item${page === it.id ? " active" : ""}`}
              aria-current={page === it.id ? "page" : undefined}
              onClick={() => onNav(it.id)}
            >
              <Icon name={it.icon} />
              {it.label}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [params, setParams] = useUrlState();
  const page = pageOf(params);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  // 主题：把偏好同步到 <html>，仅 "system" 时跟随系统变化（监听注册/清理由 hook 内部处理）。
  useThemeSync();
  const [themePref] = useThemePreference();

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

  // 内嵌反馈组件复用管理员会话：登录后以 Cookie 换握手令牌注入并按寿命续注；
  // 退出登录由清理函数 dropSession 回到组件自登录态。
  const widgetRef = useRef<FeedbackWidget | null>(null);
  useEffect(() => {
    const el = widgetRef.current;
    if (!authed || !el) return;
    return startFeedbackHostSession(el);
  }, [authed]);

  async function logout() {
    await api.post("/api/auth/logout").catch(() => undefined);
    setAuthed(false);
  }

  const nav = useCallback(
    (p: Page) => {
      // 切换导航页：清理反馈页的详情/筛选参数，避免跨页串状态。
      setParams(
        p === "feedbacks"
          ? { page: p }
          : { page: p, view: null, q: null, status: null, appId: null, from: null, to: null, id: null },
      );
    },
    [setParams],
  );

  /** 管理员设置保存成功：会话已在服务端撤销，回到登录页并预填新用户名。 */
  function handleCredentialsUpdated(username: string) {
    setLoginUsername(username);
    setLoginNotice("凭据已更新，请重新登录");
    setAuthed(false);
  }

  let content: ReactNode;
  if (authed === null) {
    content = (
      <p className="muted" style={{ padding: 40 }}>
        正在检查登录状态…
      </p>
    );
  } else if (!authed) {
    content = (
      <LoginView
        onSuccess={() => {
          setAuthed(true);
          // 凭据更新提示只服务一次重登；成功后清掉，避免后续普通退出时残留误导。
          setLoginNotice(null);
          setLoginUsername("");
        }}
        initialUsername={loginUsername}
        notice={loginNotice}
      />
    );
  } else {
    content = (
      <ToastProvider>
        <div className="shell">
          {/* 顶部菜单：仅 <1200px 显示 */}
          <div className="shell-top">
            <span className="shell-brand" style={{ padding: 0 }}>
              Feedback 管理
            </span>
            <nav className="nav-scroll" aria-label="管理导航">
              <NavItems page={page} onNav={nav} />
            </nav>
            <ThemeSelect />
            <button type="button" className="btn sm" onClick={logout}>
              退出
            </button>
          </div>
          {/* 侧边导航：≥1200px */}
          <nav className="shell-nav" aria-label="管理导航">
            <div className="shell-brand">
              <Icon name="feedback" size={20} />
              Feedback 管理
            </div>
            <NavItems page={page} onNav={nav} />
            <div style={{ marginTop: "var(--sp-6)", padding: "0 var(--sp-3)" }}>
              <div style={{ marginBottom: "var(--sp-3)" }}>
                <ThemeSelect />
              </div>
              <button type="button" className="btn" style={{ width: "100%" }} onClick={logout}>
                退出登录
              </button>
            </div>
          </nav>
          <main className="shell-body">{renderPage(page, handleCredentialsUpdated)}</main>
        </div>
      </ToastProvider>
    );
  }

  return (
    <>
      {content}
      {/* 管理后台自身也是反馈组件宿主：提交进入本服务的反馈收件箱；com.feedback.admin
          软件与握手令牌由 feedback-host 编排（管理员 Cookie 会话，免组件内二次登录）。
          密码输入由组件自动遮罩（input[type=password] 与 [data-feedback-capture-mask]）。 */}
      {createPortal(
        <feedback-widget
          ref={widgetRef}
          api-base={window.location.origin}
          app-id="com.feedback.admin"
          app-version={__ADMIN_VERSION__}
          page-label={authed ? `admin:${page}` : "admin:login"}
          side="right"
          theme={themePref}
          launcher-mode="orb"
          capture-mode="viewport"
        />,
        document.body,
      )}
    </>
  );
}

function renderPage(page: Page, onCredentialsUpdated: (username: string) => void): ReactNode {
  switch (page) {
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
