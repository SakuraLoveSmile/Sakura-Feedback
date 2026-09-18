/**
 * 共享 UI 组件：图标、状态标签、弹窗、抽屉、通知、空状态、骨架屏。
 * 全站同一套交互：焦点约束、Escape 关闭、关闭后焦点恢复、背景不可交互。
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

// ---------- 焦点约束（弹窗/抽屉共用） ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 叠加弹层栈：抽屉里再开弹窗/灯箱时，只有最上层的弹层响应 Esc 与 Tab 循环。
const trapStack: { el: HTMLElement }[] = [];

function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onEscape?: () => void) {
  const restoreRef = useRef<HTMLElement | null>(null);
  // onEscape 存 ref：父级重渲染导致回调身份变化时，不得重建陷阱把焦点重置回第一个元素。
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const ctx = { el };
    trapStack.push(ctx);
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (trapStack[trapStack.length - 1] !== ctx) return; // 非最上层弹层不响应
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscapeRef.current?.();
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
      const activeEl = document.activeElement;
      if (!el.contains(activeEl)) {
        // 焦点逸出到弹层外（如点到不可聚焦的遮罩、toast 按钮）：拉回弹层内。
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
      } else if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = trapStack.indexOf(ctx);
      if (i !== -1) trapStack.splice(i, 1);
      restoreRef.current?.focus?.();
    };
  }, [active, ref]);
}

// ---------- 表单字段 ----------

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
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
        <div style={{ marginTop: "var(--sp-3)" }}>
          <Field id="confirm-text" label={<>输入「{need}」以确认</>}>
            {(control) => (
              <input
                {...control}
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
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
      <div style={{ marginTop: "var(--sp-3)" }}>
        <Field id="prompt-input" label={label}>
          {(control) => (
            <input
              {...control}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

// ---------- 抽屉 ----------

export function Drawer({
  title,
  children,
  footer,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(true, ref, onClose);
  const labelId = useId();
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 背景遮罩点击关闭是抽屉标准交互，键盘走 Escape */}
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside ref={ref} className="drawer" role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1}>
        <div className="drawer-head">
          <h2 id={labelId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
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

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div style={{ marginTop: "var(--sp-3)" }}>{action}</div>}
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

// ---------- 更多操作菜单 ----------

export function MoreMenu({
  items,
  label = "更多操作",
}: {
  items: { label: string; danger?: boolean; onClick: () => void }[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** 按按钮视口位置放置菜单：右缘对齐，底部放不下时向上翻，四周留 8px 边距。 */
  const updatePos = useCallback(() => {
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let top = r.bottom + 4;
    let left = r.right - mw;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    if (left < 8) left = 8;
    else if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - mw);
    setPos({ top, left });
  }, []);

  // 打开即测量（layout effect 避免先闪到左上角）；菜单 portal 到 body，
  // 不受 .table-wrap 等 overflow 容器裁剪。
  useLayoutEffect(() => {
    if (open) updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    // 容器横向/纵向滚动时重新定位（capture 捕获所有祖先滚动），视口缩放同理。
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, updatePos]);

  if (items.length === 0) return null;
  return (
    <span className="more-menu">
      <button
        ref={btnRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="more-menu-pop"
            role="menu"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
          >
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
          </div>,
          document.body,
        )}
    </span>
  );
}
