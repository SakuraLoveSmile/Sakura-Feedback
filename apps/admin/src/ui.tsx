/**
 * 共享 UI 组件：图标、状态标签、弹窗、抽屉、通知、空状态、骨架屏。
 * 全站同一套交互：焦点约束、Escape 关闭、关闭后焦点恢复、背景不可交互。
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ---------- 图标（单色线性 SVG，18px / 线宽 1.75） ----------

const PATHS: Record<string, ReactNode> = {
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  restore: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M21 12a9 9 0 1 1-9 9" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  external: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  file: (
    <>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <path d="M14 2v6h6" />
    </>
  ),
  play: <path d="m6 3 14 9-14 9V3z" />,
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  feedback: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </>
  ),
  apps: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  update: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  edit: (
    <>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1-1.3-1.3Z" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

/** 中文完整日期时间：固定 zh-CN + 24 小时制，不随浏览器语言变化。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------- 焦点约束（弹窗/抽屉共用） ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 焦点约束 + Escape 关闭 + 关闭后焦点恢复（弹窗 / 抽屉 / 移动菜单共用）。 */
export function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onEscape?: () => void) {
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables()[0];
    (first ?? el).focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = list[0]!;
      const lastEl = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [active, ref, onEscape]);
}

// ---------- 弹窗 ----------

export function Modal({
  title,
  children,
  actions,
  onClose,
  wide = false,
}: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, onClose);
  const labelId = useId();
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景遮罩点击关闭是弹窗标准交互，键盘走 Escape
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        style={wide ? { width: "min(720px, 100%)" } : undefined}
      >
        <h2 id={labelId}>{title}</h2>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** 确认弹窗；requireText 非空时须输入指定文本（如「删除」）才可确认。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "确认",
  danger = false,
  requireText,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const need = requireText ?? null;
  const ok = need === null || text === need;
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className={`btn ${danger ? "danger" : "primary"}`} disabled={!ok} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
      {need !== null && (
        <div className="field" style={{ marginTop: "var(--sp-3)", marginBottom: 0 }}>
          <label htmlFor="confirm-text">输入「{need}」以确认</label>
          <input
            id="confirm-text"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
}

/** 文本输入弹窗（替代 window.prompt）。 */
export function PromptDialog({
  title,
  body,
  label,
  placeholder,
  confirmLabel = "确定",
  onSubmit,
  onClose,
}: {
  title: ReactNode;
  body?: ReactNode;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={value.trim() === ""} onClick={() => onSubmit(value)}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
      <div className="field" style={{ marginTop: "var(--sp-3)", marginBottom: 0 }}>
        <label htmlFor="prompt-input">{label}</label>
        <input
          id="prompt-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
      </div>
    </Modal>
  );
}

// ---------- 抽屉 ----------

export function Drawer({
  title,
  headerMeta,
  children,
  footer,
  onClose,
  narrow = false,
}: {
  title: ReactNode;
  /** 标题下方的状态/区域等元信息行。 */
  headerMeta?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** 配置类抽屉使用 640px；默认反馈详情 680px。 */
  narrow?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(true, ref, onClose);
  const labelId = useId();
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 背景遮罩点击关闭是抽屉标准交互，键盘走 Escape */}
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside
        ref={ref}
        className={`drawer${narrow ? " narrow" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <div className="drawer-head-main">
            <h2 id={labelId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
          {headerMeta && <div className="drawer-head-meta">{headerMeta}</div>}
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

// ---------- 通知 ----------

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => undefined);

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span className="toast-text">{t.text}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭通知"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ---------- 空状态 / 骨架 ----------

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)", padding: "var(--sp-4)" }}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 骨架行为静态占位，无顺序变化
        <div key={i} className="skeleton" style={{ height: 44 }} />
      ))}
    </div>
  );
}

/** 加载失败的内联提示（保留已有内容，提供重试）。 */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <Icon name="alert" />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

// ---------- 页面骨架与表单分区 ----------

/** 页头：左侧标题＋一句用途说明；右侧最多一个主操作与一个次操作。 */
export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

/** 表单/内容分区：分区标题＋可选说明＋内容（面板内分段）。 */
export function FormSection({
  title,
  desc,
  children,
  danger = false,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className={`form-section${danger ? " danger" : ""}`}>
      <h3 className="form-section-title">{title}</h3>
      {desc && <p className="form-section-desc">{desc}</p>}
      {children}
    </section>
  );
}

/** 状态标签：浅色底＋色点＋文字（状态不只靠颜色区分）。 */
export function StatusBadge({
  tone,
  children,
  className = "",
}: {
  /** 语义色：ok / warn / err / info / neutral；或直接传处理状态名（archived/failed/…）。 */
  tone: "ok" | "warn" | "err" | "info" | "neutral" | string;
  children: ReactNode;
  className?: string;
}) {
  const toneClass = ["ok", "warn", "err", "info", "neutral"].includes(tone) ? `tone-${tone}` : tone;
  return (
    <span className={`tag ${toneClass} ${className}`.trim()}>
      <span className="tag-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** 已选筛选条件标签：可关闭的小胶囊。 */
export function FilterChip({ label, onClear }: { label: ReactNode; onClear: () => void }) {
  return (
    <span className="chip">
      {label}
      <button
        type="button"
        className="chip-x"
        aria-label={`清除筛选：${typeof label === "string" ? label : ""}`}
        onClick={onClear}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** 附件行：图标＋名称＋元信息＋操作（日志文件、截图条目共用）。 */
export function AttachmentItem({
  icon,
  name,
  meta,
  actions,
}: {
  icon: keyof typeof PATHS | string;
  name: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="attach-item">
      <Icon name={icon} />
      <div className="attach-item-main">
        <div className="wrap-anywhere">{name}</div>
        {meta && <div className="muted small">{meta}</div>}
      </div>
      {actions && <div className="attach-item-actions">{actions}</div>}
    </div>
  );
}

// ---------- 更多操作菜单 ----------

export function MoreMenu({
  items,
  label = "更多操作",
}: {
  items: { label: string; danger?: boolean; onClick: () => void }[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="more-menu" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <span className="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? "danger" : ""}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
