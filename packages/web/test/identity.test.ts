/**
 * P1「服务身份与凭据隔离」回归测试（Web 组件）：
 * - `api-base` / `app-id` 变化 → 服务身份世代（epoch）递增，旧身份的迟到异步结果一律丢弃
 *   （提交响应、轮询记录、捕获会话、登录握手回调）；
 * - `api-base` 变化 = 完整身份切换：停轮询 + 清令牌 / 任务态 / 草稿，新服务必须重新登录；
 * - `app-id` 变化 = 同服务内切换：草稿 / 捕获 / 结果 / 握手作废，令牌保留；
 * - `page-label` / `app-version` / `theme` 变化绝不清空草稿、令牌、截图与任务态；
 * - 服务端已接收但后台处理失败：只提供「刷新状态 / 复制标识 / 再记一条」，绝不再次
 *   POST /api/feedback；「重试提交」只属于「提交未到达服务」的分支。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import {
  API_BASE,
  cleanup,
  completeLogin,
  installAuthFetch,
  httpResponse,
  loginResponse,
  mount,
  setTextarea,
  submitLoginForm,
  type Mounted,
} from './helpers';

const API_BASE_B = 'http://api-b.test:9999';
const OTHER_APP_ID = 'com.other.app';
const PNG = (tag: string): Blob => new Blob([tag], { type: 'image/png' });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RawCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch 桩（比 recordFetch 多保留 FormData 字节与任意响应形态）。 */
function stubFetch(impl: (call: RawCall) => unknown | Promise<unknown>): {
  calls: RawCall[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const calls: RawCall[] = [];
  const fetchMock = vi.fn(
    async (
      input: unknown,
      init?: { method?: string; headers?: Record<string, string>; body?: unknown },
    ) => {
      const call: RawCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: init?.body,
      };
      calls.push(call);
      return impl(call);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** 排出微任务链（伪定时器下同样可用）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

function posts(calls: RawCall[]): RawCall[] {
  return calls.filter((c) => c.method === 'POST');
}

function gets(calls: RawCall[]): RawCall[] {
  return calls.filter((c) => c.method === 'GET');
}

function jsonBody(call: RawCall): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function formMetadata(call: RawCall): Record<string, unknown> {
  return JSON.parse((call.body as FormData).get('metadata') as string) as Record<string, unknown>;
}

async function formScreenshot(call: RawCall): Promise<string> {
  const blob = (call.body as FormData).get('screenshot') as Blob | null;
  if (!blob) return '';
  return new TextDecoder().decode(await blob.arrayBuffer());
}

function feedbackRecord(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fb-1',
    status,
    createdAt: '2025-09-08T00:00:00Z',
    updatedAt: '2025-09-08T00:00:00Z',
    errorSummary: null,
    kaneoUrl: null,
    ...extra,
  };
}

function cardButton(m: Mounted, selector: string): HTMLButtonElement | null {
  return m.errorRegion.querySelector<HTMLButtonElement>(selector);
}

/** 安装/移除 navigator.clipboard（undefined 模拟剪贴板 API 不可用）。 */
function installClipboard(value?: { writeText: (text: string) => Promise<void> }): ReturnType<typeof vi.fn> | null {
  const writeText = value ? vi.fn(value.writeText) : null;
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
  return writeText;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (b: Blob | MediaSource) => `blob:mock-${(b as Blob).size ?? 0}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('服务身份隔离：api-base 切换 = 完整身份切换', () => {
  it('在途 submit 的迟到响应被丢弃：不清草稿、不改相位、不派发事件、不轮询', async () => {
    const m = mount();
    const pending = deferred<unknown>();
    const { calls } = stubFetch(() => pending.promise);
    await completeLogin(m);
    const events: CustomEvent[] = [];
    m.widget.addEventListener('feedback-submitted', (ev) => events.push(ev as CustomEvent));

    setTextarea(m, '给 A 的反馈');
    m.submitBtn.click();
    await flush();
    expect(posts(calls)).toHaveLength(1); // A 的请求已上路

    // 服务身份切换：A 的响应还在路上
    m.widget.setAttribute('api-base', API_BASE_B);
    setTextarea(m, '给 B 的草稿');

    pending.resolve(httpResponse(201, { feedbackId: 'fb-a', status: 'received' }));
    await flush();
    await vi.advanceTimersByTimeAsync(30000); // 若旧响应启动了轮询，这里会发出 GET

    expect(events).toHaveLength(0); // 不派发 feedback-submitted
    expect(m.textarea.value).toBe('给 B 的草稿'); // 不清空新身份的草稿
    expect(m.textarea.disabled).toBe(false); // 不把新身份锁在 submitting
    expect(m.statusRegion.textContent).not.toContain('已保存');
    expect(gets(calls)).toHaveLength(0); // 不为旧服务的记录启动轮询
    expect(m.panel.querySelector('.fb-login')).not.toBeNull(); // 新服务仍要求登录
  });

  it('在途 pollTick 的迟到记录不写入新身份（不更新 lastRecord / phase）', async () => {
    const m = mount();
    const pendingGet = deferred<unknown>();
    const { calls } = stubFetch((call) =>
      call.method === 'POST' ? httpResponse(201, { feedbackId: 'fb-1', status: 'received' }) : pendingGet.promise,
    );
    await completeLogin(m);
    setTextarea(m, '轮询中的反馈');
    m.submitBtn.click();
    await flush();
    await vi.advanceTimersByTimeAsync(2000); // 第一次 GET 发出并挂起
    expect(gets(calls)).toHaveLength(1);

    m.widget.setAttribute('api-base', API_BASE_B);
    pendingGet.resolve(httpResponse(200, feedbackRecord('archived', { kaneoUrl: 'https://kaneo.test/task/7' })));
    await flush();
    await vi.advanceTimersByTimeAsync(30000);

    expect(m.errorRegion.textContent).not.toContain('已归档');
    expect(m.errorRegion.querySelector('a.fb-task-link')).toBeNull();
    expect(m.submitBtn.textContent).not.toBe('已归档');
    expect(m.statusRegion.textContent).not.toContain('已归档');
    expect(gets(calls)).toHaveLength(1); // 切换后旧服务的轮询不再继续
  });

  it('切换时清空令牌 / 任务态 / 草稿，并停止旧服务的轮询', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('shot'), width: 100, height: 100 }));
    const { calls } = stubFetch((call) =>
      call.method === 'POST'
        ? httpResponse(201, { feedbackId: 'fb-1', status: 'received' })
        : httpResponse(200, feedbackRecord('processing')),
    );
    await completeLogin(m);
    setTextarea(m, '切换前的反馈');
    m.submitBtn.click();
    await flush();
    expect(m.statusRegion.textContent).toContain('已保存，正在整理'); // 已接收 → 轮询中
    await m.widget.captureAndOpen(); // 切换前的新草稿（含截图）
    setTextarea(m, '切换前的草稿');
    expect(m.screenshotWrap.hidden).toBe(false);

    const before = calls.length;
    m.widget.setAttribute('api-base', API_BASE_B);
    await flush();
    await vi.advanceTimersByTimeAsync(60000); // 旧服务的轮询定时器必须已被清除

    expect(calls.length).toBe(before); // 不再向旧服务轮询
    expect(m.textarea.value).toBe(''); // 草稿清空
    expect(m.textarea.disabled).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true); // 截图一并废弃
    expect(m.panel.querySelector('.fb-login')).not.toBeNull(); // 令牌已清 → 需重新登录
    expect(m.submitBtn.textContent).toBe('登录并提交');
    expect(m.errorRegion.hidden).toBe(true); // 旧服务的任务态卡片不再存活
    expect(m.statusRegion.textContent).not.toContain('已保存');
  });

  it('新服务绝不收到旧服务的 Authorization：切换后必须重新登录，请求只带新令牌', async () => {
    const m = mount();
    const { calls } = stubFetch(() => httpResponse(201, { feedbackId: 'fb-b', status: 'received' }));
    await completeLogin(m); // A 登录成功：令牌 test-access-token
    expect(m.panel.querySelector('.fb-login')).toBeNull();

    m.widget.setAttribute('api-base', API_BASE_B);
    expect(m.panel.querySelector('.fb-login')).not.toBeNull(); // A 的令牌不适用于 B

    setTextarea(m, '给 B 的反馈');
    m.submitBtn.click();
    await flush();
    // 未登录 B → 不发送任何请求：尤其不存在携带 A 的 Authorization 的请求
    expect(calls).toHaveLength(0);
    expect(m.root.querySelector<HTMLDivElement>('.fb-login-panel')?.hidden).toBe(false); // 面板内登录表单已展开

    // 完成 B 的登录（表单在当前面板内）：自动续交
    installAuthFetch('b-token');
    submitLoginForm(m);
    await flush();

    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${API_BASE_B}/api/feedback`);
    expect(sent[0]?.headers['Authorization']).toBe('Bearer b-token');
    expect(calls.some((c) => c.headers['Authorization'] === 'Bearer test-access-token')).toBe(false);
  });

  it('丢弃旧服务迟到的登录结果（登录响应绑定身份世代）', async () => {
    const m = mount();
    const { calls } = stubFetch(() => httpResponse(201, { feedbackId: 'fb-x', status: 'received' }));
    const pendingLogin = deferred<unknown>();
    const inner = globalThis.fetch as unknown;
    vi.stubGlobal('fetch', async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.includes('/api/auth/login')) return pendingLogin.promise;
      if (url.includes('/api/auth/session')) return httpResponse(200, {});
      return (inner as (i: unknown, n?: unknown) => Promise<unknown>)(input, init);
    });

    setTextarea(m, 'A 的反馈');
    m.submitBtn.click();
    await flush();
    submitLoginForm(m); // A 的登录请求挂起
    await flush();

    m.widget.setAttribute('api-base', API_BASE_B); // 切换身份
    pendingLogin.resolve(loginResponse('a-token')); // A 迟到返回
    await flush();

    setTextarea(m, 'B 的反馈');
    m.submitBtn.click();
    await flush();
    expect(posts(calls)).toHaveLength(0); // 旧服务的令牌不得用于新服务
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();
  });

  it('清空「结果未知的原请求」等旧服务状态', async () => {
    const m = mount();
    stubFetch(() => {
      throw new Error('network down');
    });
    await completeLogin(m);
    setTextarea(m, '第一次');
    m.submitBtn.click();
    await flush();
    setTextarea(m, '第二次修改后的内容');
    m.submitBtn.click();
    await flush();
    expect(m.errorRegion.textContent).toContain('结果未知的原请求');

    m.widget.setAttribute('api-base', API_BASE_B);
    await flush();
    expect(m.errorRegion.hidden).toBe(true);
    expect(m.errorRegion.textContent).not.toContain('结果未知的原请求');
  });

  it('失效旧服务的捕获会话：迟到截图不写入新身份', async () => {
    const m = mount();
    const pendingShot = deferred<{ blob: Blob; width: number; height: number }>();
    m.widget.captureProvider = vi.fn(() => pendingShot.promise);
    const p = m.widget.captureAndOpen();
    setTextarea(m, '旧服务草稿');

    m.widget.setAttribute('api-base', API_BASE_B);
    pendingShot.resolve({ blob: PNG('late!'), width: 100, height: 100 });
    await p;

    expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.textarea.value).toBe('');
  });
});

describe('服务身份隔离：app-id 切换（同服务）', () => {
  it('使在途 submit 结果失效：不写新身份状态、不锁死编辑', async () => {
    const m = mount();
    const pending = deferred<unknown>();
    const { calls } = stubFetch(() => pending.promise);
    await completeLogin(m);
    const events: CustomEvent[] = [];
    m.widget.addEventListener('feedback-submitted', (ev) => events.push(ev as CustomEvent));

    setTextarea(m, '旧身份内容');
    m.submitBtn.click();
    await flush();
    expect(posts(calls)).toHaveLength(1);

    m.widget.setAttribute('app-id', OTHER_APP_ID);
    expect(m.textarea.disabled).toBe(false); // 新身份可继续编辑（相位必须复位）
    setTextarea(m, '新身份内容');

    pending.resolve(httpResponse(201, { feedbackId: 'fb-old', status: 'received' }));
    await flush();
    await vi.advanceTimersByTimeAsync(30000);

    expect(events).toHaveLength(0); // 旧提交结果失效：不派发事件
    expect(m.textarea.value).toBe('新身份内容'); // 不清空新身份草稿
    expect(m.statusRegion.textContent).not.toContain('已保存');
    expect(m.errorRegion.hidden).toBe(true); // 旧身份的已接收结果不再存活
    expect(gets(calls)).toHaveLength(0); // 不为旧身份的记录启动轮询
    expect(posts(calls)).toHaveLength(1);
  });

  it('重置任务态与轮询，但保留令牌（同一服务）', async () => {
    const m = mount();
    const { calls } = stubFetch((call) =>
      call.method === 'POST'
        ? httpResponse(201, { feedbackId: 'fb-1', status: 'received' })
        : httpResponse(200, feedbackRecord('processing')),
    );
    await completeLogin(m);
    setTextarea(m, '旧应用的反馈');
    m.submitBtn.click();
    await flush();
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');

    const before = calls.length;
    m.widget.setAttribute('app-id', OTHER_APP_ID);
    await flush();
    await vi.advanceTimersByTimeAsync(60000);

    expect(calls.length).toBe(before); // 旧身份的轮询已停止
    expect(m.errorRegion.hidden).toBe(true); // 旧身份的已接收结果不再存活
    expect(m.statusRegion.textContent).not.toContain('已保存');
    expect(m.textarea.value).toBe('');
    // 令牌保留：同一服务下无需重新登录即可继续提交
    expect(m.panel.querySelector('.fb-login')).toBeNull();
    setTextarea(m, '新应用的内容');
    m.submitBtn.click();
    await flush();
    const sent = posts(calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.url).toBe(`${API_BASE}/api/feedback`);
    expect(sent[1]?.headers['Authorization']).toBe('Bearer test-access-token');
    expect(jsonBody(sent[1] as RawCall).appId).toBe(OTHER_APP_ID);
  });

  it('旧身份的登录结果不被接受（登录响应绑定身份世代）', async () => {
    const m = mount();
    const { calls } = stubFetch(() => httpResponse(201, { feedbackId: 'fb-x', status: 'received' }));
    const pendingLogin = deferred<unknown>();
    const inner = globalThis.fetch as unknown;
    vi.stubGlobal('fetch', async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.includes('/api/auth/login')) return pendingLogin.promise;
      if (url.includes('/api/auth/session')) return httpResponse(200, {});
      return (inner as (i: unknown, n?: unknown) => Promise<unknown>)(input, init);
    });

    setTextarea(m, '旧应用的内容');
    m.submitBtn.click();
    await flush();
    submitLoginForm(m); // 旧 appId 的登录请求挂起
    await flush();

    m.widget.setAttribute('app-id', OTHER_APP_ID);
    pendingLogin.resolve(loginResponse('stale-token')); // 旧身份迟到返回
    await flush();

    setTextarea(m, '新应用的内容');
    m.submitBtn.click();
    await flush();
    expect(posts(calls)).toHaveLength(0); // 旧身份的令牌不得用于新身份
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();
  });
});

describe('非身份属性的变化不销毁草稿', () => {
  it('page-label / app-version / theme 变化保留草稿、令牌、截图与头部信息刷新', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('keep'), width: 100, height: 100 }));
    stubFetch(() => httpResponse(201, { feedbackId: 'fb-1', status: 'received' }));
    await completeLogin(m);
    await m.widget.captureAndOpen();
    setTextarea(m, '不该被清空的草稿');
    const shotSrc = m.screenshotThumb.src;
    expect(m.screenshotWrap.hidden).toBe(false);

    m.widget.setAttribute('page-label', 'other/page');
    m.widget.setAttribute('app-version', '9.9.9');
    m.widget.setAttribute('theme', 'dark');
    await flush();

    expect(m.textarea.value).toBe('不该被清空的草稿');
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.screenshotThumb.src).toBe(shotSrc);
    expect(m.panel.querySelector('.fb-login')).toBeNull(); // 令牌保留
    expect(m.root.querySelector('.fb-header-meta')?.textContent).toBe('v9.9.9 · other/page');
  });

  it('page-label / app-version / theme 变化不打断进行中的轮询与任务态', async () => {
    const m = mount();
    const { calls } = stubFetch((call) =>
      call.method === 'POST'
        ? httpResponse(201, { feedbackId: 'fb-1', status: 'received' })
        : httpResponse(200, feedbackRecord('processing')),
    );
    await completeLogin(m);
    setTextarea(m, '进行中的反馈');
    m.submitBtn.click();
    await flush();

    m.widget.setAttribute('page-label', 'other/page');
    m.widget.setAttribute('app-version', '9.9.9');
    m.widget.setAttribute('theme', 'dark');
    expect(m.statusRegion.textContent).toContain('已保存，正在整理'); // 任务态保留
    expect(m.errorRegion.hidden).toBe(false);

    const before = gets(calls).length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(gets(calls).length).toBe(before + 1); // 轮询继续
  });

  it('page-label 变化不改变已冻结快照的字节与元数据（重试同 key 同字节）', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('image1'), width: 100, height: 100 }));
    let first = true;
    const { calls } = stubFetch(() => {
      if (first) {
        first = false;
        return httpResponse(500, { error: { code: 'server_error', message: 'boom' } });
      }
      return httpResponse(201, { feedbackId: 'fb-2', status: 'received' });
    });
    await completeLogin(m);
    await m.widget.captureAndOpen();
    setTextarea(m, '冻结期间的来源变化');
    m.submitBtn.click();
    await flush();
    expect(posts(calls)).toHaveLength(1);

    // 快照冻结后修改来源元数据：本次请求与重试都不得改变字节
    m.widget.pageLabel = 'other/page';
    cardButton(m, '.fb-retry')?.click();
    await flush();

    const sent = posts(calls);
    expect(sent).toHaveLength(2);
    const meta0 = formMetadata(sent[0] as RawCall);
    const meta1 = formMetadata(sent[1] as RawCall);
    expect(meta1.idempotencyKey).toBe(meta0.idempotencyKey);
    expect(meta1.context).toEqual({ appVersion: '1.2.3', pageLabel: 'settings/account' });
    expect((sent[0] as RawCall).body).toBeInstanceOf(FormData);
    expect(formMetadata(sent[0] as RawCall)).toEqual(meta1); // 同 key 同字节
    expect(await formScreenshot(sent[1] as RawCall)).toBe(await formScreenshot(sent[0] as RawCall));
  });
});

describe('失败路径：服务端已接收 vs 提交未到达', () => {
  /** 提交成功 → 轮询拿到 failed（服务端已接收、后台处理失败）。 */
  async function serverReceivedFailure(): Promise<{
    m: Mounted;
    calls: RawCall[];
  }> {
    const m = mount();
    const { calls } = stubFetch((call) =>
      call.method === 'POST'
        ? httpResponse(201, { feedbackId: 'fb-1', status: 'received' })
        : httpResponse(200, feedbackRecord('failed', { errorSummary: 'AI 整理失败' })),
    );
    await completeLogin(m);
    setTextarea(m, '会失败的反馈');
    m.submitBtn.click();
    await flush();
    await vi.advanceTimersByTimeAsync(2000); // 第一次 GET → failed
    return { m, calls };
  }

  it('提供刷新状态与复制标识与找回提示，且绝不再次 POST /api/feedback', async () => {
    const { m, calls } = await serverReceivedFailure();

    expect(m.errorRegion.textContent).toContain('原话已保存');
    expect(m.errorRegion.textContent).toContain('管理页'); // 找回提示
    expect(m.errorRegion.textContent).toContain('fb-1'); // 展示反馈标识
    expect(cardButton(m, '.fb-retry')).toBeNull(); // 不提供"重试提交"（原话已在服务端）
    const refreshBtn = cardButton(m, '.fb-refresh-btn');
    const copyBtn = cardButton(m, '.fb-copy-id-btn');
    expect(refreshBtn).not.toBeNull();
    expect(copyBtn).not.toBeNull();

    // 复制标识：走 navigator.clipboard.writeText
    const writeText = installClipboard({ writeText: async () => {} });
    copyBtn?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('fb-1');

    // 刷新状态：只读 GET，绝不重复提交
    const beforeGet = gets(calls).length;
    refreshBtn?.click();
    await flush();
    const sent = gets(calls);
    expect(sent.length).toBe(beforeGet + 1);
    expect(sent[sent.length - 1]?.url).toBe(`${API_BASE}/api/feedback/fb-1`);
    expect(sent[sent.length - 1]?.headers['Authorization']).toBe('Bearer test-access-token');
    expect(posts(calls)).toHaveLength(1); // 全程只有最初那一次 POST
    expect(m.errorRegion.textContent).toContain('原话已保存');
  });

  it('刷新到 archived 后展示任务链接，仍不重复提交', async () => {
    const m = mount();
    let getCount = 0;
    const { calls } = stubFetch((call) => {
      if (call.method === 'POST') return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      getCount += 1;
      if (getCount === 1) return httpResponse(200, feedbackRecord('failed', { errorSummary: 'AI 整理失败' }));
      return httpResponse(200, feedbackRecord('archived', { kaneoUrl: 'https://kaneo.test/task/42' }));
    });
    await completeLogin(m);
    setTextarea(m, '稍后归档的反馈');
    m.submitBtn.click();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(m.errorRegion.textContent).toContain('原话已保存');

    cardButton(m, '.fb-refresh-btn')?.click();
    await flush();

    expect(m.errorRegion.querySelector<HTMLAnchorElement>('a.fb-task-link')?.href).toBe(
      'https://kaneo.test/task/42',
    );
    expect(m.statusRegion.textContent).toContain('已归档');
    expect(posts(calls)).toHaveLength(1);
    expect(gets(calls)).toHaveLength(2);
  });

  it('剪贴板 API 不可用时复制标识静默降级，不抛错也不发请求', async () => {
    const { m, calls } = await serverReceivedFailure();
    installClipboard(undefined);
    const copyBtn = cardButton(m, '.fb-copy-id-btn');
    expect(copyBtn).not.toBeNull();
    expect(() => copyBtn?.click()).not.toThrow();
    await flush();
    expect(posts(calls)).toHaveLength(1);
    expect(gets(calls)).toHaveLength(1);
  });

  it('提交未到达服务：只提供重试提交，重试复用同一幂等键与同一字节', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('image1'), width: 100, height: 100 }));
    let first = true;
    const { calls } = stubFetch(() => {
      if (first) {
        first = false;
        throw new Error('network down');
      }
      return httpResponse(201, { feedbackId: 'fb-net', status: 'received' });
    });
    await completeLogin(m);
    await m.widget.captureAndOpen();
    setTextarea(m, '未到达服务的内容');
    m.submitBtn.click();
    await flush();

    expect(m.errorRegion.textContent).toContain('尚未确认保存');
    expect(cardButton(m, '.fb-refresh-btn')).toBeNull(); // 未接收 → 无记录可刷新
    expect(cardButton(m, '.fb-copy-id-btn')).toBeNull();
    const retry = cardButton(m, '.fb-retry');
    expect(retry).not.toBeNull();

    retry?.click();
    await flush();

    const sent = posts(calls);
    expect(sent).toHaveLength(2);
    const meta0 = formMetadata(sent[0] as RawCall);
    const meta1 = formMetadata(sent[1] as RawCall);
    expect(meta1.idempotencyKey).toBe(meta0.idempotencyKey); // 同 key
    expect(formMetadata(sent[0] as RawCall)).toEqual(meta1); // 同字节（含 sources 元数据）
    expect(await formScreenshot(sent[0] as RawCall)).toBe('image1');
    expect(await formScreenshot(sent[1] as RawCall)).toBe('image1');
  });
});
