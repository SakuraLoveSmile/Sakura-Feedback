import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api } from "./api.ts";
import { Icon, ToastProvider, useFocusTrap } from "./ui.tsx";
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

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <Icon name="feedback" size={18} />
    </span>
  );
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
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <BrandMark />
        </div>
        <h1 className="login-title">登录管理后台</h1>
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
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
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

/** 768–1199px 图标栏：只显示图标，悬停/键盘聚焦时浮出名称。
 * 名称提示经 portal 放到侧栏外，避免被可滚动的侧栏容器裁切。 */
function ShellRail({ page, onNav, onLogout }: { page: Page; onNav: (p: Page) => void; onLogout: () => void }) {
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const tipProps = (label: string) => ({
    onMouseEnter: (e: React.SyntheticEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
    },
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.SyntheticEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
    },
    onBlur: () => setTip(null),
  });
  return (
    <nav className="shell-rail" aria-label="管理导航" onScroll={() => setTip(null)}>
      <span className="brand-mark rail-brand" aria-hidden="true">
        <Icon name="feedback" size={18} />
      </span>
      {NAV_GROUPS.flatMap((g) => g.items).map((it) => (
        <button
          type="button"
          key={it.id}
          className={`rail-item${page === it.id ? " active" : ""}`}
          aria-current={page === it.id ? "page" : undefined}
          aria-label={it.label}
          onClick={() => onNav(it.id)}
          {...tipProps(it.label)}
        >
          <Icon name={it.icon} />
        </button>
      ))}
      <button
        type="button"
        className="rail-item rail-logout"
        aria-label="退出登录"
        onClick={onLogout}
        {...tipProps("退出登录")}
      >
        <Icon name="logout" />
      </button>
      {tip &&
        createPortal(
          <div className="rail-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
            {tip.label}
          </div>,
          document.body,
        )}
    </nav>
  );
}

/** <768px 顶部菜单抽屉：左侧滑出完整导航＋退出入口。 */
function MobileNavDrawer({
  page,
  onNav,
  onLogout,
  onClose,
}: {
  page: Page;
  onNav: (p: Page) => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(true, ref, onClose);
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 背景遮罩点击关闭是抽屉标准交互，键盘走 Escape */}
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside ref={ref} className="nav-drawer" role="dialog" aria-modal="true" aria-label="管理导航" tabIndex={-1}>
        <div className="shell-brand">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">Feedback</span>
            <span className="brand-sub">反馈管理</span>
          </span>
        </div>
        <NavItems
          page={page}
          onNav={(p) => {
            onClose();
            onNav(p);
          }}
        />
        <div className="nav-foot">
          <button type="button" className="nav-item" onClick={onLogout}>
            <Icon name="logout" />
            退出登录
          </button>
        </div>
      </aside>
    </>,
    document.body,
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [params, setParams] = useUrlState();
  const page = pageOf(params);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  if (authed === null)
    return (
      <p className="muted" style={{ padding: 40 }}>
        正在检查登录状态…
      </p>
    );
  if (!authed)
    return <LoginView onSuccess={() => setAuthed(true)} initialUsername={loginUsername} notice={loginNotice} />;

  return (
    <ToastProvider>
      <div className="shell">
        {/* 顶部标题栏：仅 <768px 显示，菜单走抽屉 */}
        <header className="shell-top">
          <button
            type="button"
            className="icon-btn"
            aria-label="打开导航菜单"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="shell-top-brand">
            <BrandMark />
            <span className="shell-top-title">Feedback</span>
          </div>
        </header>
        {menuOpen && <MobileNavDrawer page={page} onNav={nav} onLogout={logout} onClose={() => setMenuOpen(false)} />}
        {/* 完整侧栏：≥1200px */}
        <nav className="shell-nav" aria-label="管理导航">
          <div className="shell-brand">
            <BrandMark />
            <span className="brand-text">
              <span className="brand-name">Feedback</span>
              <span className="brand-sub">反馈管理</span>
            </span>
          </div>
          <NavItems page={page} onNav={nav} />
          <div className="nav-foot">
            <button type="button" className="nav-item" onClick={logout}>
              <Icon name="logout" />
              退出登录
            </button>
          </div>
        </nav>
        {/* 图标栏：768–1199px */}
        <ShellRail page={page} onNav={nav} onLogout={logout} />
        <main className="shell-body">{renderPage(page, handleCredentialsUpdated)}</main>
      </div>
    </ToastProvider>
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
