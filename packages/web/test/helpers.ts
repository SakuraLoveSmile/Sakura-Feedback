import { vi, expect } from 'vitest';
import type { FeedbackWidget } from '../src/element';

export const API_BASE = 'http://api.test:8787';
export const APP_ID = 'com.example.app';

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
  /** 日志区（docs/logs-plan.md §4.5 / §4.6） */
  logArea: HTMLDivElement;
  logList: HTMLUListElement;
  logStatusLine: HTMLDivElement;
  logActions: HTMLDivElement;
  logRetryBtn: HTMLButtonElement;
  logSkipBtn: HTMLButtonElement;
  logInput: HTMLInputElement;
  logAddLabel: HTMLLabelElement;
  logPreview: HTMLPreElement;
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
    logArea: root.querySelector<HTMLDivElement>('.fb-log-area') as HTMLDivElement,
    logList: root.querySelector<HTMLUListElement>('.fb-log-list') as HTMLUListElement,
    logStatusLine: root.querySelector<HTMLDivElement>('.fb-log-status') as HTMLDivElement,
    logActions: root.querySelector<HTMLDivElement>('.fb-log-actions') as HTMLDivElement,
    logRetryBtn: root.querySelector<HTMLButtonElement>('.fb-log-retry') as HTMLButtonElement,
    logSkipBtn: root.querySelector<HTMLButtonElement>('.fb-log-skip') as HTMLButtonElement,
    logInput: root.querySelector<HTMLInputElement>('.fb-log-input') as HTMLInputElement,
    logAddLabel: root.querySelector<HTMLLabelElement>('.fb-log-add') as HTMLLabelElement,
    logPreview: root.querySelector<HTMLPreElement>('.fb-log-preview') as HTMLPreElement,
  };
  // 模块级草稿跨用例存活：每次 mount 先清空。
  setTextarea(m, '');
  return m;
}

export function setTextarea(m: Mounted, text: string): void {
  m.textarea.value = text;
  m.textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** `File` 字节（手写日志附件的真实读取路径与 `<input type="file">` 一致）。 */
export function logBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 宿主日志回调返回值（单个文件）。 */
export function logFile(name: string, text: string): { name: string; bytes: Uint8Array } {
  return { name, bytes: logBytes(text) };
}

/**
 * 模拟用户在 `<input type="file" multiple>` 里选中文件：
 * happy-dom 的 `files` 是只读访问器，这里在实例上定义同名属性再派发 change。
 */
export function pickLogFiles(m: Mounted, files: File[]): void {
  Object.defineProperty(m.logInput, 'files', { value: files, configurable: true });
  m.logInput.dispatchEvent(new Event('change'));
}

/** 当前面板里的日志条目（文件名 / 大小 / 来源）。 */
export function logItems(m: Mounted): HTMLLIElement[] {
  return Array.from(m.logList.querySelectorAll<HTMLLIElement>('.fb-log-item'));
}

/** 最小 fetch Response 桩（组件用 status/ok/json）。 */
export function httpResponse(status: number, body: unknown): {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
} {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

export function apiError(status: number, code: string, message: string): unknown {
  return { error: { code, message } };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export function recordFetch(
  impl: (url: string, init: { method?: string; body?: string }) => Promise<unknown>,
): { calls: FetchCall[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body });
    return impl(url, { method: init?.method, body: init?.body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** 拦截 window.open；returns=桩弹窗（null 模拟弹窗被拦截）。 */
export function stubWindowOpen(popup: { closed: boolean } | null) {
  const urls: string[] = [];
  const spy = vi.spyOn(window, 'open').mockImplementation(((url?: string | URL) => {
    urls.push(String(url ?? ''));
    return popup as unknown as Window | null;
  }) as unknown as typeof window.open);
  return { spy, urls };
}

/**
 * 完成一次登录握手：startLogin 弹窗（window.open 已打桩），
 * 从登录页 URL 提取 nonce 并按契约 postMessage 交付令牌。
 */
export function completeLogin(m: Mounted, token = 'test-access-token'): string {
  const loginUrl = m.widget.startLogin();
  expect(loginUrl).toContain('/login?');
  const nonce = new URL(loginUrl).searchParams.get('nonce') as string;
  deliverAuthMessage({ token, nonce });
  return loginUrl;
}

export function deliverAuthMessage(opts: {
  token?: string;
  nonce?: string;
  origin?: string;
  type?: string;
  expiresAt?: string;
}): void {
  const data: Record<string, unknown> = {
    type: opts.type ?? 'feedback:auth',
    nonce: opts.nonce,
    accessToken: opts.token,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  const ev = new MessageEvent('message', { origin: opts.origin ?? API_BASE, data });
  window.dispatchEvent(ev);
}

export function cleanup(): void {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
