import { vi } from 'vitest';
import type { FeedbackWidget } from '../src/element';

export const API_BASE = 'http://api.test:8787';
export const APP_ID = 'com.example.app';
export const TEST_TOKEN = 'test-access-token';

export interface Mounted {
  widget: FeedbackWidget;
  root: ShadowRoot;
  fab: HTMLButtonElement;
  orb: HTMLButtonElement;
  panel: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  submitBtn: HTMLButtonElement;
  counter: HTMLSpanElement;
  statusRegion: HTMLDivElement;
  errorRegion: HTMLDivElement;
  screenshotWrap: HTMLDivElement;
  screenshotThumb: HTMLImageElement;
  shotArea: HTMLDivElement;
  captureBtn: HTMLButtonElement;
  retakeBtn: HTMLButtonElement;
  removeBtn: HTMLButtonElement;
  zoomModal: HTMLDivElement;
}

export function mount(attrs: Record<string, string> = {}): Mounted {
  const widget = document.createElement('feedback-widget') as FeedbackWidget;
  widget.setAttribute('api-base', API_BASE);
  widget.setAttribute('app-id', APP_ID);
  widget.setAttribute('app-version', '1.2.3');
  widget.setAttribute('page-label', 'settings/account');
  for (const [k, v] of Object.entries(attrs)) widget.setAttribute(k, v);
  document.body.appendChild(widget);
  const root = widget.shadowRoot as ShadowRoot;
  const m: Mounted = {
    widget,
    root,
    fab: root.querySelector<HTMLButtonElement>('.fb-fab') as HTMLButtonElement,
    orb: root.querySelector<HTMLButtonElement>('.fb-orb') as HTMLButtonElement,
    panel: root.querySelector<HTMLDivElement>('.fb-panel') as HTMLDivElement,
    textarea: root.querySelector<HTMLTextAreaElement>('.fb-textarea') as HTMLTextAreaElement,
    submitBtn: root.querySelector<HTMLButtonElement>('.fb-submit') as HTMLButtonElement,
    counter: root.querySelector<HTMLSpanElement>('.fb-counter') as HTMLSpanElement,
    statusRegion: root.querySelector<HTMLDivElement>('.fb-status') as HTMLDivElement,
    errorRegion: root.querySelector<HTMLDivElement>('.fb-error') as HTMLDivElement,
    screenshotWrap: root.querySelector<HTMLDivElement>('.fb-screenshot-wrap') as HTMLDivElement,
    screenshotThumb: root.querySelector<HTMLImageElement>('.fb-screenshot-thumb') as HTMLImageElement,
    shotArea: root.querySelector<HTMLDivElement>('.fb-shot-area') as HTMLDivElement,
    captureBtn: root.querySelector<HTMLButtonElement>('.fb-btn-capture') as HTMLButtonElement,
    retakeBtn: root.querySelector<HTMLButtonElement>('.fb-btn-retake') as HTMLButtonElement,
    removeBtn: root.querySelector<HTMLButtonElement>('.fb-btn-remove') as HTMLButtonElement,
    zoomModal: root.querySelector<HTMLDivElement>('.fb-zoom-modal') as HTMLDivElement,
  };
  // 模块级草稿跨用例存活：每次 mount 先清空。
  setTextarea(m, '');
  return m;
}

export function setTextarea(m: Mounted, text: string): void {
  m.textarea.value = text;
  m.textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 最小 fetch Response 桩（组件用 status/ok/json）。 */
export function httpResponse(status: number, body: unknown): {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
} {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

export function apiError(status: number, code: string, message: string, extra?: Record<string, unknown>): unknown {
  return { error: { code, message }, ...(extra ?? {}) };
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function authUser(): { id: string; username: string; role: 'admin' } {
  return { id: 'user-1', username: 'admin', role: 'admin' };
}

/**
 * 额度桩：`resetAt` 用固定未来时间（而非 `Date.now()` 相对值），
 * 使「登录 / 会话响应里带的额度」可以按字面比较，不受用例执行毫秒差影响。
 */
export function quota(over: Partial<{ dailyLimit: number; used: number; remaining: number; resetAt: string }> = {}) {
  return { dailyLimit: 3, used: 0, remaining: 3, resetAt: '2030-01-01T16:00:00.000Z', ...over };
}

export function loginResponse(token = TEST_TOKEN) {
  return httpResponse(200, {
    ok: true,
    token,
    expiresAt: futureIso(3_600_000),
    user: authUser(),
    quota: quota(),
  });
}

export function sessionResponse() {
  return httpResponse(200, {
    authenticated: true,
    kind: 'client',
    expiresAt: futureIso(3_600_000),
    user: authUser(),
    quota: quota(),
  });
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  rawBody?: unknown;
}

/**
 * 记录业务请求的 fetch 桩。
 * 认证端点（/api/auth/login、/api/auth/session）由桩直接应答且**不计入 calls**：
 * 打开面板会刷新额度、重新登录会发起会话请求，这些噪声不应干扰业务断言。
 */
export function recordFetch(
  impl: (url: string, init: { method?: string; body?: unknown }) => Promise<unknown>,
  opts: { token?: string } = {},
): { calls: FetchCall[]; authCalls: string[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const authCalls: string[] = [];
  const fetchMock = vi.fn(
    async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      const url = String(input);
      if (url.includes('/api/auth/login')) {
        authCalls.push(url);
        return loginResponse(opts.token);
      }
      if (url.includes('/api/auth/session')) {
        authCalls.push(url);
        return sessionResponse();
      }
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      } else if (init?.body && typeof (init.body as { get?: (k: string) => unknown }).get === 'function') {
        const metaStr = (init.body as { get: (k: string) => unknown }).get('metadata');
        if (typeof metaStr === 'string') {
          try {
            body = JSON.parse(metaStr) as Record<string, unknown>;
          } catch {
            body = undefined;
          }
        }
      }
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body, rawBody: init?.body });
      return impl(url, { method: init?.method, body: init?.body });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls, authCalls, fetchMock };
}

/** 等待链式 promise 完成（登录 -> 状态同步）。使用微任务，兼容 fake timers。 */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/**
 * 安装“认证感知”的 fetch 包装：登录 / 会话查询由包装直接应答（不计入业务请求），
 * 其余请求委托给当前 fetch 桩（保留记录与故障注入）。
 */
export function installAuthFetch(token = TEST_TOKEN): void {
  const inner = globalThis.fetch as unknown;
  vi.stubGlobal('fetch', async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.includes('/api/auth/login')) return loginResponse(token);
    if (url.includes('/api/auth/session')) return sessionResponse();
    if (inner) return (inner as (i: unknown, n?: unknown) => Promise<unknown>)(input, init);
    throw new Error(`unexpected fetch ${url}`);
  });
}

/**
 * 通过面板内登录表单完成登录（不打开新窗口）：
 * 展开表单 → 填入账号密码 → 点击「登录并提交」→ 等待令牌写入。
 */
export async function completeLogin(m: Mounted, token = TEST_TOKEN): Promise<void> {
  installAuthFetch(token);
  m.widget.startLogin();
  const username = m.root.querySelector<HTMLInputElement>('.fb-login-username');
  const password = m.root.querySelector<HTMLInputElement>('.fb-login-password');
  const confirm = m.root.querySelector<HTMLButtonElement>('.fb-login-confirm');
  if (!username || !password || !confirm) throw new Error('面板内登录表单未渲染');
  username.value = 'admin';
  password.value = 'secret';
  confirm.click();
  await flushPromises();
}

/** 在登录表单中输入凭据并确认（用于重新登录 / 自动续交场景）。 */
export function submitLoginForm(m: Mounted, username = 'admin', password = 'secret'): void {
  const u = m.root.querySelector<HTMLInputElement>('.fb-login-username');
  const p = m.root.querySelector<HTMLInputElement>('.fb-login-password');
  const confirm = m.root.querySelector<HTMLButtonElement>('.fb-login-confirm');
  if (!u || !p || !confirm) throw new Error('面板内登录表单未渲染');
  u.value = username;
  p.value = password;
  confirm.click();
}

export function cleanup(): void {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
