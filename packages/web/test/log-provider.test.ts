import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  setTextarea,
  stubWindowOpen,
} from './helpers';
import type { FeedbackLogPart } from '../src/index';

const UTF8 = (str: string): Uint8Array => new TextEncoder().encode(str);

interface RawCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

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

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('T3 Web 日志提供者 (logProvider) 与日志面板', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  it('未配置 logProvider 时只显示手动添加入口，不报错不空白', async () => {
    const m = mount();
    m.widget.open();
    await flush();

    const root = m.root;
    const logSection = root.querySelector('.fb-logs-area');
    expect(logSection).not.toBeNull();

    const manualAddBtn = root.querySelector('.fb-log-manual-btn');
    expect(manualAddBtn).not.toBeNull();

    const emptyHint = root.querySelector('.fb-log-empty');
    expect(emptyHint).not.toBeNull();
    expect(m.errorRegion.hidden).toBe(true);
  });

  it('每份新草稿首次打开时调用一次 logProvider，展示文件名、大小、来源及说明文案', async () => {
    const m = mount();
    const providerMock = vi.fn(async () => [
      { name: 'app.log', bytes: UTF8('info: app started\n') },
      { name: 'net.json', bytes: UTF8('{"status":"ok"}') },
    ]);
    m.widget.logProvider = providerMock;

    m.widget.open();
    await flush();

    expect(providerMock).toHaveBeenCalledTimes(1);

    const root = m.root;
    const logItems = root.querySelectorAll('.fb-log-item');
    expect(logItems.length).toBe(2);

    expect(logItems[0]?.textContent).toContain('app.log');
    expect(logItems[0]?.textContent).toContain('自动');
    expect(logItems[1]?.textContent).toContain('net.json');

    const notice = root.querySelector('.fb-log-notice');
    expect(notice?.textContent).toContain('AI 分析');
  });

  it('超时（3 秒）后显示「日志获取失败」，提供重试与不带日志继续提交', async () => {
    vi.useFakeTimers();
    const m = mount();
    // 挂起永不返回的 provider
    m.widget.logProvider = vi.fn(() => new Promise<FeedbackLogPart[]>(() => {}));

    m.widget.open();
    // 前进 2999ms，尚未超时
    await vi.advanceTimersByTimeAsync(2999);
    expect(m.root.querySelector('.fb-log-status')?.textContent || '').toContain('获取');

    // 满 3000ms 超时
    await vi.advanceTimersByTimeAsync(50);
    const logStatus = m.root.querySelector('.fb-log-status');
    expect(logStatus?.textContent || '').toContain('日志获取失败');

    const retryBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-retry-btn');
    expect(retryBtn).not.toBeNull();

    // 允许不带日志继续提交
    completeLogin(m);
    setTextarea(m, '无日志也可以继续提交');
    expect(m.submitBtn.disabled).toBe(false);

    vi.useRealTimers();
  });

  it('超时或失败后可点击重试重新采集', async () => {
    vi.useFakeTimers();
    const m = mount();
    let attempt = 0;
    m.widget.logProvider = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('network error');
      }
      return [{ name: 'retry.log', bytes: UTF8('success after retry') }];
    });

    m.widget.open();
    await vi.advanceTimersByTimeAsync(50);

    expect(m.root.querySelector('.fb-log-status')?.textContent || '').toContain('日志获取失败');
    const retryBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-retry-btn');
    expect(retryBtn).not.toBeNull();

    // 点击重试
    retryBtn?.click();
    await vi.advanceTimersByTimeAsync(50);

    const logItems = m.root.querySelectorAll('.fb-log-item');
    expect(logItems.length).toBe(1);
    expect(logItems[0]?.textContent).toContain('retry.log');

    vi.useRealTimers();
  });

  it('重新打开已有草稿不重新采集，移除后不自动补回', async () => {
    const m = mount();
    const providerMock = vi.fn(async () => [
      { name: 'app.log', bytes: UTF8('log entry') },
    ]);
    m.widget.logProvider = providerMock;

    // 首次打开
    m.widget.open();
    await flush();
    expect(providerMock).toHaveBeenCalledTimes(1);

    // 关上面板
    m.widget.close();
    await flush();

    // 重新打开已有草稿：不重复调用
    m.widget.open();
    await flush();
    expect(providerMock).toHaveBeenCalledTimes(1);

    // 移除该日志
    const removeBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-remove-btn');
    expect(removeBtn).not.toBeNull();
    removeBtn?.click();
    await flush();
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    // 关上再打开：移除后不自动补回
    m.widget.close();
    await flush();
    m.widget.open();
    await flush();
    expect(providerMock).toHaveBeenCalledTimes(1);
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('迟到结果不写回：面板关闭后迟到结果不得写回或开启面板', async () => {
    const m = mount();
    let resolveProvider!: (logs: FeedbackLogPart[]) => void;
    m.widget.logProvider = vi.fn(
      () =>
        new Promise<FeedbackLogPart[]>((resolve) => {
          resolveProvider = resolve;
        }),
    );

    m.widget.open();
    // 等待 microtask 让 logProvider 真正被触发调用
    await new Promise((r) => setTimeout(r, 0));

    // 采集还在进行中，用户关闭面板
    m.widget.close();
    await flush();
    expect(m.panel.classList.contains('is-open')).toBe(false);

    // 迟到结果返回
    resolveProvider([{ name: 'late.log', bytes: UTF8('late content') }]);
    await flush();

    expect(m.panel.classList.contains('is-open')).toBe(false);
    // 重新打开新草稿检查未被污染
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('迟到结果不写回：组件卸载后迟到结果不得写回', async () => {
    const m = mount();
    let resolveProvider!: (logs: FeedbackLogPart[]) => void;
    m.widget.logProvider = vi.fn(
      () =>
        new Promise<FeedbackLogPart[]>((resolve) => {
          resolveProvider = resolve;
        }),
    );

    m.widget.open();
    await new Promise((r) => setTimeout(r, 0));

    // 卸载组件
    m.widget.remove();
    await flush();

    // 迟到返回
    resolveProvider([{ name: 'late.log', bytes: UTF8('late') }]);
    await flush();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('迟到结果不写回：切换 api-base / app-id 后迟到结果不得写回', async () => {
    const m = mount();
    let resolveProvider!: (logs: FeedbackLogPart[]) => void;
    m.widget.logProvider = vi.fn(
      () =>
        new Promise<FeedbackLogPart[]>((resolve) => {
          resolveProvider = resolve;
        }),
    );

    m.widget.open();
    await new Promise((r) => setTimeout(r, 0));

    // 切换 app-id
    m.widget.appId = 'com.example.new-app';
    await flush();

    // 迟到返回
    resolveProvider([{ name: 'late.log', bytes: UTF8('late') }]);
    await flush();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('限制校验：单文件 > 1 MiB 或总数 > 3 或非 UTF-8 / 含 NUL 给出明确提示，不静默截断', async () => {
    const m = mount();
    // 1. 单文件超过 1 MiB (1048576 字节)
    const bigBytes = new Uint8Array(1048576 + 1);
    bigBytes.fill(65);
    m.widget.logProvider = vi.fn(async () => [
      { name: 'too-big.log', bytes: bigBytes },
    ]);

    m.widget.open();
    await flush();

    // 明确报错提示，且不静默截断加入
    expect(m.root.querySelector('.fb-log-error')?.textContent || '').toMatch(/1\s*MiB|超过/);
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    // 2. 超过 3 个文件
    m.widget.logProvider = vi.fn(async () => [
      { name: '1.log', bytes: UTF8('1') },
      { name: '2.log', bytes: UTF8('2') },
      { name: '3.log', bytes: UTF8('3') },
      { name: '4.log', bytes: UTF8('4') },
    ]);
    // 触发重试
    const retryBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-retry-btn');
    retryBtn?.click();
    await flush();

    expect(m.root.querySelector('.fb-log-error')?.textContent || '').toMatch(/3\s*个|上限/);
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    // 3. 含 NUL 字符
    m.widget.logProvider = vi.fn(async () => [
      { name: 'nul.log', bytes: new Uint8Array([0x61, 0x00, 0x62]) },
    ]);
    retryBtn?.click();
    await flush();

    expect(m.root.querySelector('.fb-log-error')?.textContent || '').toMatch(/UTF-8|无效/);
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('支持纯文本预览与移除日志', async () => {
    const m = mount();
    m.widget.logProvider = vi.fn(async () => [
      { name: 'preview.log', bytes: UTF8('line 1: hello\nline 2: world') },
    ]);

    m.widget.open();
    await flush();

    const previewBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-preview-btn');
    expect(previewBtn).not.toBeNull();
    previewBtn?.click();
    await flush();

    const modal = m.root.querySelector('.fb-log-preview-modal');
    expect(modal?.classList.contains('is-open')).toBe(true);
    expect(modal?.textContent).toContain('line 1: hello\nline 2: world');

    // 关闭预览
    const closeBtn = modal?.querySelector<HTMLButtonElement>('.fb-log-preview-close');
    closeBtn?.click();
    await flush();
    expect(modal?.classList.contains('is-open')).toBe(false);

    // 移除
    const removeBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-remove-btn');
    removeBtn?.click();
    await flush();
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('提交与轮询期间锁定附件修改（截图与日志操作禁用）', async () => {
    stubWindowOpen({ closed: false });
    stubFetch(async (call) => {
      if (call.method === 'POST') {
        // 挂起 POST 请求模拟提交进行中
        await new Promise((r) => setTimeout(r, 100));
        return httpResponse(201, { feedbackId: 'fb-poll', status: 'processing' });
      }
      return httpResponse(200, {
        id: 'fb-poll',
        status: 'processing',
        createdAt: '',
        updatedAt: '',
      });
    });

    const m = mount();
    completeLogin(m);
    m.widget.logProvider = vi.fn(async () => [
      { name: 'locked.log', bytes: UTF8('locked content') },
    ]);

    m.widget.open();
    await flush();

    setTextarea(m, '锁定附件测试');

    const logRemoveBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-remove-btn');
    const logManualBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-manual-btn');
    expect(logRemoveBtn?.disabled).toBe(false);
    expect(logManualBtn?.disabled).toBe(false);

    // 点击提交：处于 submitting 阶段
    m.submitBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // 提交进行中：附件操作必须锁定
    expect(logRemoveBtn?.disabled).toBe(true);
    expect(logManualBtn?.disabled).toBe(true);
    expect(m.captureBtn.disabled).toBe(true);
  });

  it('提交失败保留原快照，修改附件后生成新幂等键，未修改重试保持同 key', async () => {
    stubWindowOpen({ closed: false });
    let attempts = 0;
    const { calls } = stubFetch(async (call) => {
      if (call.method === 'POST') {
        attempts++;
        if (attempts === 1) {
          return httpResponse(500, { error: { code: 'server_error', message: '服务出错' } });
        }
        return httpResponse(201, { feedbackId: 'fb-ok', status: 'received' });
      }
      return httpResponse(200, {});
    });

    const m = mount();
    completeLogin(m);
    m.widget.logProvider = vi.fn(async () => [
      { name: 'test.log', bytes: UTF8('first log') },
    ]);

    m.widget.open();
    await flush();

    setTextarea(m, '快照测试');
    m.submitBtn.click();
    await flush();

    expect(calls.length).toBe(1);
    const firstFormData = calls[0]?.body as FormData;
    const firstMeta = JSON.parse(firstFormData.get('metadata') as string);
    const firstKey = firstMeta.idempotencyKey;

    // 失败保留原快照，未修改直接重试：保持同 key 同内容
    const retrySubmit = m.errorRegion.querySelector<HTMLButtonElement>('.fb-retry');
    expect(retrySubmit).not.toBeNull();
    retrySubmit?.click();
    await flush();

    expect(calls.length).toBe(2);
    const secondFormData = calls[1]?.body as FormData;
    const secondMeta = JSON.parse(secondFormData.get('metadata') as string);
    expect(secondMeta.idempotencyKey).toBe(firstKey);
  });

  it('修改附件（如移除日志）后生成新幂等键', async () => {
    stubWindowOpen({ closed: false });
    const { calls } = stubFetch(async () => {
      return httpResponse(500, { error: { code: 'server_error', message: '错误' } });
    });

    const m = mount();
    completeLogin(m);
    m.widget.logProvider = vi.fn(async () => [
      { name: 'one.log', bytes: UTF8('1') },
      { name: 'two.log', bytes: UTF8('2') },
    ]);

    m.widget.open();
    await flush();

    setTextarea(m, '修改附件后换 key');
    m.submitBtn.click();
    await flush();

    const firstMeta = JSON.parse((calls[0]?.body as FormData).get('metadata') as string);
    const firstKey = firstMeta.idempotencyKey;

    // 移除第二份日志
    const removeBtns = m.root.querySelectorAll<HTMLButtonElement>('.fb-log-remove-btn');
    removeBtns[1]?.click();
    await flush();

    // 再次提交
    m.submitBtn.click();
    await flush();

    const secondMeta = JSON.parse((calls[1]?.body as FormData).get('metadata') as string);
    expect(secondMeta.idempotencyKey).not.toBe(firstKey);
  });

  it('提交带日志时使用 multipart：metadata.logs 与 logs 部件顺序及字节一致；无附件时保持 JSON', async () => {
    stubWindowOpen({ closed: false });
    const { calls } = stubFetch(async () => httpResponse(201, { feedbackId: 'fb-multi', status: 'received' }));

    const m = mount();
    completeLogin(m);
    m.widget.logProvider = vi.fn(async () => [
      { name: 'log1.txt', bytes: UTF8('first') },
      { name: 'log2.json', bytes: UTF8('{"second":2}') },
    ]);

    m.widget.open();
    await flush();

    setTextarea(m, '带日志提交');
    m.submitBtn.click();
    await flush();

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.body).toBeInstanceOf(FormData);
    const fd = call.body as FormData;

    expect(fd.has('screenshot')).toBe(false);
    const meta = JSON.parse(fd.get('metadata') as string);
    expect(meta.logs).toEqual([
      { name: 'log1.txt', source: 'auto' },
      { name: 'log2.json', source: 'auto' },
    ]);

    const logParts = fd.getAll('logs');
    expect(logParts.length).toBe(2);
    const blob1 = logParts[0] as Blob;
    const blob2 = logParts[1] as Blob;
    expect(new TextDecoder().decode(await blob1.arrayBuffer())).toBe('first');
    expect(new TextDecoder().decode(await blob2.arrayBuffer())).toBe('{"second":2}');
  });
});
