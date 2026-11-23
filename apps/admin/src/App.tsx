import { Button, Group, Input, NavLink, Paper, Text, Title } from "@mantine/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// 导入即自动注册 <feedback-widget> 自定义元素（副作用）。
import "@feedback/web";
import type { FeedbackWidget } from "@feedback/web";
import { ApiError, api, type SessionUser } from "./api.ts";
import { recordDiagnostic } from "./diagnostics.ts";
import { bindFeedbackDiagnostics, startFeedbackHostSession } from "./feedback-host.ts";

import { type EditState, PageEditsContext } from "./page-edits.ts";
import { ThemeSelect, useThemePreference } from "./theme.tsx";
import { ConfirmDialog, Field, Icon, InlineError, Modal, ToastProvider } from "./ui.tsx";
import { useHistoryEditGuard, useUrlState } from "./url.ts";
import AccountsView from "./views/AccountsView.tsx";
import AppsView from "./views/AppsView.tsx";
import ChangelogView from "./views/ChangelogView.tsx";
import ConnectionsView from "./views/ConnectionsView.tsx";
import FeedbacksView from "./views/FeedbacksView.tsx";
import SessionsView from "./views/SessionsView.tsx";
import SettingsView from "./views/SettingsView.tsx";
import SystemUpdateView from "./views/SystemUpdateView.tsx";

type Page = "feedbacks" | "changelog" | "apps" | "accounts" | "connections" | "sessions" | "settings" | "system-update";

const NAV_GROUPS: { label: string; items: { id: Page; label: string; icon: string }[] }[] = [
  {
    label: "工作台",
    items: [
      { id: "feedbacks", label: "反馈", icon: "feedback" },
      { id: "changelog", label: "更新日志", icon: "file" },
    ],
  },
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

function Brand({ caption = false }: { caption?: boolean }) {
  return (
    <span className="shell-brand">
      <span className="brand-mark">
        <Icon name="brand" size={23} />
      </span>
      <span>Feedback{caption && <span className="brand-caption">反馈管理工作台</span>}</span>
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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ user: SessionUser }>("/api/auth/login", { username, password });
      if (result.user.role !== "admin") {
        setError("这个账号可以提交反馈。请使用管理员账号登录工作台。");
        setPassword("");
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-stage">
      <Group justify="space-between" mb="md">
        <Brand caption />
        <ThemeSelect />
      </Group>
      <Paper component="form" className="login-form" onSubmit={submit} withBorder p="xl" shadow="xs">
        <div className="login-card-head">
          <Title order={1} size="h2">
            管理登录
          </Title>
        </div>
        <p className="login-purpose">使用管理员账号登录反馈工作台。</p>
        {notice && (
          <p className="ok-text login-notice" role="status">
            {notice}
          </p>
        )}
        <Field id="u" label="用户名">
          {(ctl) => (
            <Input
              error={ctl["aria-invalid"]}
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
            <div className="password-control">
              <Input
                error={ctl["aria-invalid"]}
                {...ctl}
                type={showPassword ? "text" : "password"}
                data-feedback-capture-mask=""
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="输入密码"
                required
              />
              <Button
                variant="subtle"
                size="xs"
                type="button"
                className="btn sm ghost"
                aria-pressed={showPassword}
                aria-label="显示密码"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? "隐藏" : "显示"}
              </Button>
            </div>
          )}
        </Field>
        <Button
          variant="filled"
          className="btn primary login-submit"
          type="submit"
          disabled={busy}
          aria-busy={busy}
          title={busy ? "正在登录…" : error ? "修正信息后可原地重试" : undefined}
        >
          {busy ? "登录中…" : error ? "重试登录" : "登录"}
        </Button>
      </Paper>
      <Text c="dimmed" size="xs" ta="center" mt="md">
        服务地址　{window.location.origin}
      </Text>
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
            <NavLink
              component="button"
              type="button"
              key={it.id}
              className={`nav-item${page === it.id ? " active" : ""}`}
              aria-current={page === it.id ? "page" : undefined}
              active={page === it.id}
              label={it.label}
              leftSection={<Icon name={it.icon} size={17} />}
              onClick={() => onNav(it.id)}
            />
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
  const [edits] = useState(() => new Set<{ state: EditState }>());
  const [pendingDestination, setPendingDestination] = useState<Page | "logout" | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  useHistoryEditGuard(edits, setNavError);

  useEffect(() => {
    document.title = `${authed ? pageLabelOf(page) : "管理登录"} · Feedback`;
    setMenuOpen(false);
  }, [page, authed]);

  const [themePref] = useThemePreference();

  const check = useCallback(async () => {
    setSessionError(null);
    try {
      const s = await api.get<{ user: SessionUser }>("/api/auth/session");
      if (s.user.role !== "admin") {
        setSessionUser(null);
        setLoginNotice("当前登录的是普通账号，请使用管理员账号。");
        setAuthed(false);
        return;
      }
      setSessionUser(s.user);
      setAuthed(true);
      // 会话确认留痕（新会话起点标记；同账号续登也记录，缓冲有界）。
      recordDiagnostic({ level: "info", event: "auth_session", code: "ok" });
    } catch (err) {
      setSessionUser(null);
      if (err instanceof ApiError && err.status === 401) setAuthed(false);
      else {
        setAuthed(null);
        setSessionError("暂时无法连接管理服务，请重试。");
      }
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
    setLoggingOut(true);
    setNavError(null);
    try {
      await api.post("/api/auth/logout");
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setNavError("退出失败，当前页面已保留。请重试退出。");
        return;
      }
    } finally {
      setLoggingOut(false);
    }
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

  function navigate(destination: Page | "logout") {
    if (loggingOut) return;
    setMenuOpen(false);
    setNavError(null);
    if (destination === page) return;
    if ([...edits].some((edit) => edit.state === "saving")) {
      setNavError("操作正在提交，请稍后再离开。");
    } else if (edits.size > 0) {
      setPendingDestination(destination);
    } else if (destination === "logout") {
      void logout();
    } else {
      nav(destination);
    }
  }

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
        <Paper withBorder p="lg" className="card boot-card" role="status" aria-live="polite">
          {sessionError ? (
            <InlineError message={sessionError} onRetry={() => void check()} />
          ) : (
            <>
              <div className="skeleton" style={{ height: 24, width: "55%" }} />
              <div className="skeleton" style={{ height: 14, width: "80%" }} />
              <div className="skeleton" style={{ height: 36, width: "100%" }} />
              <p className="muted small" style={{ margin: 0 }}>
                正在检查登录状态…
              </p>
            </>
          )}
        </Paper>
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
        <PageEditsContext.Provider value={edits}>
          <a className="skip-link" href="#feedback-main">
            跳到主要内容
          </a>
          <div className="shell">
            {/* 顶部菜单：仅 <1200px 显示 */}
            <div className="shell-top">
              <Button
                type="button"
                className="btn mobile-menu-toggle"
                aria-label="打开管理菜单"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
              >
                <span className="brand-mark">
                  <Icon name="brand" size={20} />
                </span>
                <span>{pageLabelOf(page)}</span>
                <Icon name="chevronDown" size={13} />
              </Button>
              <Brand />
              <nav className="nav-scroll" aria-label="管理导航">
                <NavItems page={page} onNav={navigate} />
              </nav>
              <ThemeSelect />
              <Button
                size="xs"
                type="button"
                className="btn sm"
                disabled={loggingOut}
                onClick={() => navigate("logout")}
              >
                退出
              </Button>
            </div>
            {/* 侧边导航：≥1200px */}
            <nav className="shell-nav" aria-label="管理导航">
              <Brand caption />
              <div className="shell-nav-links">
                <NavItems page={page} onNav={navigate} />
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
                  <Button type="button" className="btn" disabled={loggingOut} onClick={() => navigate("logout")}>
                    <Icon name="logout" size={15} />
                    退出登录
                  </Button>
                </div>
              </div>
            </nav>
            {/* 面包屑：分组 / 当前页（纯文本导航上下文，不引入额外焦点项） */}
            <main className="shell-body" id="feedback-main" tabIndex={-1}>
              <nav className="crumbs" aria-label="面包屑">
                <Icon name="apps" size={14} />
                <span>{groupLabelOf(page)}</span>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <span aria-current="page">{pageLabelOf(page)}</span>
              </nav>
              {navError && <InlineError message={navError} />}
              {renderPage(page, handleCredentialsUpdated)}
            </main>
          </div>
          {menuOpen && (
            <Modal
              title="管理菜单"
              onClose={() => setMenuOpen(false)}
              actions={
                <Button type="button" className="btn" onClick={() => setMenuOpen(false)}>
                  关闭菜单
                </Button>
              }
            >
              <nav className="mobile-nav" aria-label="管理导航">
                <NavItems page={page} onNav={navigate} />
              </nav>
            </Modal>
          )}
          {pendingDestination && (
            <ConfirmDialog
              title="离开当前页面？"
              body={<p>当前页还有未保存的修改。取消可以继续编辑。</p>}
              confirmLabel="放弃修改并离开"
              danger
              onClose={() => setPendingDestination(null)}
              onConfirm={() => {
                const destination = pendingDestination;
                setPendingDestination(null);
                if (destination === "logout") void logout();
                else nav(destination);
              }}
            />
          )}
        </PageEditsContext.Provider>
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
          // 管理页刻意固定灵感球 + 视口截图，不跟随 0.10 的 beam 默认值：
          // 桌面管理端需要常驻入口，且工作台内的圈选会与表格交互冲突。
          launcher-mode="orb"
          launcher-bottom="24px"
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
    case "changelog":
      return <ChangelogView />;
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
