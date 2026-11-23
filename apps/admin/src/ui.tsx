import {
  ActionIcon,
  Alert,
  Button,
  CloseButton,
  Group,
  Input,
  Modal as LibraryModal,
  Menu,
  Notification,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
/**
 * 共享 UI 组件：图标、状态标签、弹窗、抽屉、通知、空状态、骨架屏。
 * 全站同一套交互：焦点约束、Escape 关闭、关闭后焦点恢复、背景不可交互。
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ---------- 图标（单色线性 SVG，18px / 线宽 1.75） ----------

const PATHS: Record<string, ReactNode> = {
  brand: (
    <>
      <path
        d="M3 5.5A2.5 2.5 0 0 1 5.5 3H16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-5.5 4v-4A2 2 0 0 1 3 10z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M21 8v7a2 2 0 0 1-2 2h-1v4l-4.5-4H10" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H5v16h5M9 12h12m-4-4 4 4-4 4" />
    </>
  ),
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
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.5 8a7 7 0 0 1 11.6-2L20 9M4 15l2.9 3A7 7 0 0 0 18.5 16" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
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

export function SectionIcon({ name }: { name: string }) {
  return (
    <span className="section-title-icon" aria-hidden="true">
      <Icon name={name} size={16} />
    </span>
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
    <Input.Wrapper
      className="field"
      id={id}
      label={label}
      description={hint}
      error={error}
      descriptionProps={{ id: `${id}-hint`, className: "field-hint" }}
      errorProps={{ id: `${id}-error`, role: "alert", className: "field-error" }}
      inputWrapperOrder={["label", "input", "description", "error"]}
    >
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
    </Input.Wrapper>
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
  return createPortal(
    <LibraryModal.Root
      opened
      onClose={onClose}
      centered
      size={wide ? "xl" : "md"}
      withinPortal={false}
      returnFocus={false}
      trapFocus={false}
      closeOnEscape={false}
      transitionProps={{ duration: 0 }}
      classNames={{ inner: "overlay" }}
    >
      <LibraryModal.Overlay />
      <LibraryModal.Content ref={ref} className="modal" tabIndex={-1}>
        <LibraryModal.Header>
          <LibraryModal.Title>{title}</LibraryModal.Title>
        </LibraryModal.Header>
        <LibraryModal.Body>
          <div className="modal-body">{children}</div>
          {actions && (
            <Group justify="flex-end" gap="xs" mt="lg">
              {actions}
            </Group>
          )}
        </LibraryModal.Body>
      </LibraryModal.Content>
    </LibraryModal.Root>,
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
          <Button type="button" className="btn" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="filled"
            color={danger ? "red" : "blue"}
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={!ok}
            title={ok ? undefined : `输入「${need}」后可确认`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      {need !== null && (
        <div className="dialog-field">
          <Field id="confirm-text" label={<>输入「{need}」以确认</>}>
            {(control) => (
              <Input
                error={control["aria-invalid"]}
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

/** 输入弹窗（替代 window.prompt）；异步提交失败保留输入并在字段下回显。 */
export function PromptDialog({
  title,
  body,
  label,
  placeholder,
  inputType = "text",
  autoComplete = "off",
  confirmLabel = "确定",
  danger = false,
  onSubmit,
  onClose,
}: {
  title: ReactNode;
  body?: ReactNode;
  label: string;
  placeholder?: string;
  inputType?: "text" | "password";
  autoComplete?: string;
  confirmLabel?: string;
  danger?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  // 密码按原文提交，空格也是密码的一部分；普通文本保留原有空白校验。
  const empty = inputType === "password" ? value === "" : value.trim() === "";

  function close() {
    if (!submittingRef.current) onClose();
  }

  async function submit() {
    if (empty || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={close}
      actions={
        <>
          <Button type="button" className="btn" disabled={submitting} onClick={close}>
            取消
          </Button>
          <Button
            variant="filled"
            color={danger ? "red" : "blue"}
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={empty || submitting}
            title={submitting ? "提交中，请稍候" : empty ? `填写${label}后可提交` : undefined}
            onClick={() => void submit()}
          >
            {submitting ? "提交中…" : confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      <div className="dialog-field">
        <Field id="prompt-input" label={label} error={error}>
          {(control) => (
            <Input
              error={control["aria-invalid"]}
              {...control}
              type={inputType}
              value={value}
              readOnly={submitting}
              aria-busy={submitting}
              placeholder={placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              autoComplete={autoComplete}
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
  inline = false,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** 宽屏分栏：在页面内静态渲染，不建遮罩、不做焦点陷阱；Esc 仍关闭（嵌套弹层优先）。 */
  inline?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  // 内联模式不是模态层：不抢焦点、不限制 Tab；关闭后的焦点恢复由父级列表负责。
  useFocusTrap(!inline, ref, onClose);
  const labelId = useId();

  useEffect(() => {
    if (!inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // 抽屉内的确认弹窗、图片灯箱或更多菜单打开时，Esc 先交给它们处理。
      if (document.querySelector(".overlay, .more-menu-pop")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inline, onClose]);

  const drawer = (
    <aside
      ref={ref}
      className={`drawer${inline ? " inline" : ""}`}
      role={inline ? "region" : "dialog"}
      {...(inline ? {} : { "aria-modal": true })}
      aria-labelledby={labelId}
      tabIndex={inline ? undefined : -1}
    >
      <div className="drawer-head">
        <h2 id={labelId}>{title}</h2>
        <ActionIcon
          variant="subtle"
          color="gray"
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" />
        </ActionIcon>
      </div>
      <div className="drawer-body">{children}</div>
      {footer && <div className="drawer-foot">{footer}</div>}
    </aside>
  );

  if (inline) return drawer;
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 背景遮罩点击关闭是抽屉标准交互，键盘走 Escape */}
      <div className="drawer-overlay" onMouseDown={onClose} />
      {drawer}
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
            <Notification
              key={t.id}
              className="toast"
              withBorder
              color={t.kind === "ok" ? "teal" : t.kind === "err" ? "red" : "blue"}
              closeButtonProps={{ "aria-label": "关闭通知" }}
              onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              {t.text}
            </Notification>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ---------- 空状态 / 骨架 ----------

/** 目录页共用搜索框。清除后焦点留在输入框，便于重新查找。 */
export function ListSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <TextInput
      className="list-search"
      type="search"
      leftSection={<Icon name="search" size={16} />}
      ref={input}
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rightSectionPointerEvents="all"
      rightSection={
        value && (
          <CloseButton
            size="sm"
            aria-label="清除搜索"
            onClick={() => {
              onChange("");
              input.current?.focus();
            }}
          />
        )
      }
    />
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <Stack align="center" gap="xs" py="xl" px="md" ta="center">
      <ThemeIcon variant="light" size="lg" radius="xl">
        <Icon name="inbox" />
      </ThemeIcon>
      <Text fw={600} size="sm">
        {title}
      </Text>
      {hint && (
        <Text c="dimmed" size="sm">
          {hint}
        </Text>
      )}
      {action}
    </Stack>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-rows">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 骨架行为静态占位，无顺序变化
        <Skeleton key={i} height={32} radius="sm" />
      ))}
    </div>
  );
}

/** 加载失败的内联提示（保留已有内容，提供重试）。 */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert color="red" role="alert" icon={<Icon name="alert" />}>
      <Group gap="xs" justify="space-between">
        <span>{message}</span>
        {onRetry && (
          <Button size="xs" type="button" className="btn sm" onClick={onRetry}>
            重试
          </Button>
        )}
      </Group>
    </Alert>
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
  const [opened, setOpened] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  return (
    <span className="more-menu">
      <Menu
        position="bottom-end"
        width={164}
        withinPortal
        loop
        opened={opened}
        onChange={setOpened}
        withInitialFocusPlaceholder={false}
        menuItemTabIndex={0}
        transitionProps={{ duration: 0 }}
      >
        <Menu.Target>
          <ActionIcon
            ref={trigger}
            className="icon-btn"
            variant="subtle"
            color="gray"
            aria-label={label}
            onKeyDown={(event) => {
              if (!opened && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setOpened(true);
              }
            }}
          >
            <Icon name="more" />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown
          className="more-menu-pop"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpened(false);
              trigger.current?.focus();
            }
          }}
        >
          {items.map((item) => (
            <Menu.Item
              key={item.label}
              color={item.danger ? "red" : undefined}
              onClick={() => {
                trigger.current?.focus();
                item.onClick();
              }}
            >
              {item.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </span>
  );
}
