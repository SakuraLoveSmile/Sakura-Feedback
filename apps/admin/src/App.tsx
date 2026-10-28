import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// 导入即自动注册 <feedback-widget> 自定义元素（副作用）。
import "@feedback/web";
import type { FeedbackWidget } from "@feedback/web";
import { ApiError, api, type SessionUser } from "./api.ts";
import { recordDiagnostic } from "./diagnostics.ts";
import { bindFeedbackDiagnostics, startFeedbackHostSession } from "./feedback-host.ts";
import { ThemeSelect, useThemePreference, useThemeSync } from "./theme.tsx";
import { Field, Icon, Modal, ToastProvider } from "./ui.tsx";
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

/** 当前页所属导航分组（面包屑第一级）。 */
function groupLabelOf(page: Page): string {
  return NAV_GROUPS.find((g) => g.items.some((i) => i.id === page))?.label ?? "";
}

/** 当前页菜单名（面包屑第二级，与侧栏/顶栏文案一致）。 */
function pageLabelOf(page: Page): string {
  for (const g of NAV_GROUPS) {
    const hit = g.items.find((i) => i.id === page);
    if (hit) return hit.label;
  }
  return "";
}

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
      {/* 单一登录卡片：页头（标题 + 主题）→ 用途 → 服务身份 → 表单 → 提交。
          错误经 Field 渲染在密码框正下方（贴近表单、role=alert、aria 关联），
          出错后提交按钮变「重试登录」，原地重试即可。 */}
      <form className="card" onSubmit={submit}>
        <div className="login-brand">
          <Icon name="feedback" size={24} />
          <span>Feedback</span>
        </div>
        <div className="login-card-head">
          <h1>Feedback 管理登录</h1>
          <ThemeSelect />
        </div>
        <p className="login-purpose">集中查看反馈、跟进问题，管理软件与账号。</p>
        <div className="login-server">
          <span>服务地址</span>
          <code>{window.location.origin}</code>
        </div>
        {notice && (
          <p className="ok-text login-notice" role="status">
            {notice}
          </p>
        )}
        <Field id="u" label="用户名">
          {(ctl) => (
            <input
              {...ctl}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="输入管理员用户名"
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
              placeholder="输入密码"
              required
            />
          )}
        </Field>
        <button
          className="btn primary login-submit"
          type="submit"
          disabled={busy}
          aria-busy={busy}
          title={busy ? "正在登录…" : error ? "修正信息后可原地重试" : undefined}
        >
          {busy ? "登录中…" : error ? "重试登录" : "登录"}
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
  // 当前会话身份：key 化 <feedback-widget>——退出/换账号时重建组件实例，
  // 旧实例的诊断附件与草稿不进入新会话（诊断缓冲随卸载清空换代）。
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [params, setParams] = useUrlState();
  const page = pageOf(params);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.title = `${authed ? pageLabelOf(page) : "管理登录"} · Feedback`;
    setMenuOpen(false);
  }, [page, authed]);

  // 主题：把偏好同步到 <html>，仅 "system" 时跟随系统变化（监听注册/清理由 hook 内部处理）。
  useThemeSync();
  const [themePref] = useThemePreference();

  const check = useCallback(async () => {
    try {
      const s = await api.get<{ user?: SessionUser }>("/api/auth/session");
      setSessionUser(s.user ?? null);
      setAuthed(true);
      // 会话确认留痕（新会话起点标记；同账号续登也记录，缓冲有界）。
      recordDiagnostic({ level: "info", event: "auth_session", code: "ok" });
    } catch {
      setSessionUser(null);
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // 内嵌反馈组件复用管理员会话：登录后以 Cookie 换握手令牌注入并按寿命续注；
  // 诊断 provider 与会话同生命周期绑定。卸载/退出/换身份（组件 key 变化重建）时：
  // 先解绑诊断（清空缓冲、世代+1，旧会话迟到写入被丢弃）再 dropSession。
  const widgetRef = useRef<FeedbackWidget | null>(null);
  const sessionUserId = sessionUser?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId 仅作重绑触发——身份变化时组件已 key 化重建，需对新实例重新绑定
  useEffect(() => {
    const el = widgetRef.current;
    if (!authed || !el) return;
    const unbindDiagnostics = bindFeedbackDiagnostics(el);
    const stopSession = startFeedbackHostSession(el);
    return () => {
      unbindDiagnostics();
      stopSession();
    };
  }, [authed, sessionUserId]);

  async function logout() {
    await api.post("/api/auth/logout").catch(() => undefined);
    setSessionUser(null);
    setAuthed(false);
  }

  const nav = useCallback(
    (p: Page) => {
      setMenuOpen(false);
      if (p === page) return;
      // 切换导航页：清理反馈页的详情/筛选参数，避免跨页串状态。
      setParams(
        p === "feedbacks"
          ? { page: p }
          : {
              page: p,
              view: null,
              q: null,
              status: null,
              issueStatus: null,
              appId: null,
              from: null,
              to: null,
              id: null,
            },
      );
    },
    [page, setParams],
  );

  /** 管理员设置保存成功：会话已在服务端撤销，回到登录页并预填新用户名。 */
  function handleCredentialsUpdated(username: string) {
    setLoginUsername(username);
    setLoginNotice("凭据已更新，请重新登录");
    setSessionUser(null);
    setAuthed(false);
  }

  let content: ReactNode;
  if (authed === null) {
    // 会话检查中：骨架加载态（复用登录卡片位置），比纯文案更明确地表达「进行中」。
    content = (
      <div className="login-wrap">
        <div className="card boot-card" role="status" aria-live="polite">
          <div className="skeleton" style={{ height: 24, width: "55%" }} />
          <div className="skeleton" style={{ height: 14, width: "80%" }} />
          <div className="skeleton" style={{ height: 36, width: "100%" }} />
          <p className="muted small" style={{ margin: 0 }}>
            正在检查登录状态…
          </p>
        </div>
      </div>
    );
  } else if (!authed) {
    content = (
      <LoginView
        onSuccess={() => {
          // 重新走会话检查拿身份（决定组件 key）；凭据更新提示只服务一次重登。
          void check();
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
        <a className="skip-link" href="#feedback-main">
          跳到主要内容
        </a>
        <div className="shell">
          {/* 顶部菜单：仅 <1200px 显示 */}
          <div className="shell-top">
            <button
              type="button"
              className="btn mobile-menu-toggle"
              aria-label="打开管理菜单"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="apps" size={18} />
              <span>{pageLabelOf(page)}</span>
            </button>
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
              <span className="brand-mark">
                <Icon name="feedback" size={20} />
              </span>
              <div>
                Feedback<span className="brand-caption">反馈管理工作台</span>
              </div>
            </div>
            <div className="shell-nav-links">
              <NavItems page={page} onNav={nav} />
            </div>
            <div className="shell-nav-footer">
              <div className="session-identity">
                <span className="session-avatar">
                  <Icon name="users" size={16} />
                </span>
                <div>
                  <strong>{sessionUser?.username ?? "管理员"}</strong>
                  <span className="small muted session-role">管理员</span>
                </div>
              </div>
              <div className="shell-preferences">
                <ThemeSelect />
              </div>
              <button type="button" className="btn" style={{ width: "100%" }} onClick={logout}>
                退出登录
              </button>
            </div>
          </nav>
          {/* 面包屑：分组 / 当前页（纯文本导航上下文，不引入额外焦点项） */}
          <main className="shell-body" id="feedback-main" tabIndex={-1}>
            <nav className="crumbs" aria-label="面包屑">
              <span>{groupLabelOf(page)}</span>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              <span aria-current="page">{pageLabelOf(page)}</span>
            </nav>
            {renderPage(page, handleCredentialsUpdated)}
          </main>
        </div>
        {menuOpen && (
          <Modal
            title="管理菜单"
            onClose={() => setMenuOpen(false)}
            actions={
              <button type="button" className="btn" onClick={() => setMenuOpen(false)}>
                关闭菜单
              </button>
            }
          >
            <nav className="mobile-nav" aria-label="管理导航">
              <NavItems page={page} onNav={nav} />
            </nav>
          </Modal>
        )}
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
          key={sessionUser?.id ?? "anon"}
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
