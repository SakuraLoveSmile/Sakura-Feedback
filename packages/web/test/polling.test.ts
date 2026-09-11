import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import { API_BASE, apiError, cleanup, completeLogin, httpResponse, mount, recordFetch, setTextarea, stubWindowOpen } from './helpers';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function feedbackRecord(status: string, extra: Record<string, unknown> = {}) {
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

describe('轮询 GET /api/feedback/:id', () => {
  it('2s 起指数退避（封顶 5s），archived 后展示任务链接并停止轮询', async () => {
    vi.useFakeTimers();
    stubWindowOpen({ closed: false });
    const m = mount();
    const statuses = ['processing', 'archived'];
    let gets = 0;
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback') && !url.match(/\/api\/feedback\/.+/)) {
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }
      const s = statuses[Math.min(gets, statuses.length - 1)] as string;
      gets += 1;
      return httpResponse(
        200,
        feedbackRecord(s, s === 'archived' ? { kaneoUrl: 'https://kaneo.test/task/42' } : {}),
      );
    });

    completeLogin(m);
    setTextarea(m, '轮询我');
    m.submitBtn.click();
    await vi.advanceTimersByTimeAsync(0); // POST 落地

    expect(m.statusRegion.textContent).toContain('已保存，正在整理');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0); // 第一次 GET 不早于 2s
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(calls[1]?.url).toBe(`${API_BASE}/api/feedback/fb-1`);
    expect(calls[1]?.headers['Authorization']).toBe('Bearer test-access-token');
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');

    await vi.advanceTimersByTimeAsync(4000); // 第二次间隔 4s（指数退避）
    const archived = m.errorRegion.querySelector<HTMLAnchorElement>('a.fb-task-link');
    expect(archived?.href).toBe('https://kaneo.test/task/42');
    expect(archived?.target).toBe('_blank');

    const before = calls.length;
    await vi.advanceTimersByTimeAsync(120000); // 终态后不再轮询
    expect(calls.length).toBe(before);
  });

  it('轮询到 failed：说明原话已保存，引导管理页处理，不把原话作为新反馈再次提交', async () => {
    vi.useFakeTimers();
    stubWindowOpen({ closed: false });
    const m = mount();
    let firstPost = true;
    recordFetch(async (url, init) => {
      if (init.method === 'POST') {
        const id = firstPost ? 'fb-1' : 'fb-2';
        firstPost = false;
        return httpResponse(201, { feedbackId: id, status: 'received' });
      }
      if (url.endsWith('/fb-1')) {
        return httpResponse(200, feedbackRecord('failed', { errorSummary: 'AI 整理失败' }));
      }
      return httpResponse(201, { feedbackId: 'fb-2', status: 'received' });
    });

    completeLogin(m);
    setTextarea(m, '会失败的反馈');
    m.submitBtn.click();
    await vi.advanceTimersByTimeAsync(2000);

    // 已在服务端保存的工单处理失败：原话已在服务端，不回填为未提交草稿，说明引导管理页处理
    expect(m.errorRegion.textContent).toContain('原话已保存');
    expect(m.errorRegion.textContent).toContain('管理页');
    expect(m.errorRegion.textContent).toContain('AI 整理失败');

    // 严禁提供把原话作为新反馈重复提交的按钮
    expect(m.errorRegion.querySelector('.fb-retry')).toBeNull();

    // 提供“再记一条”按钮
    const newBtn = Array.from(m.errorRegion.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '再记一条',
    );
    expect(newBtn).not.toBeNull();

    newBtn?.click();
    expect(m.textarea.value).toBe('');
    expect(m.submitBtn.textContent).toBe('提交');
  });

  it('needs_review 显示归档结果待确认，不提供重复创建提交按钮；轮询超时不呈现为归档失败', async () => {
    vi.useFakeTimers();
    stubWindowOpen({ closed: false });
    const m = mount();
    recordFetch(async (url, init) => {
      if (init.method === 'POST') return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      if (url.endsWith('/fb-1')) return httpResponse(200, feedbackRecord('needs_review'));
      return httpResponse(401, apiError(401, 'unauthorized', 'expired'));
    });
    completeLogin(m);
    setTextarea(m, '待核对');
    m.submitBtn.click();
    await vi.advanceTimersByTimeAsync(2000);

    // 待核对状态
    expect(m.errorRegion.textContent).toContain('归档结果待确认');
    expect(m.errorRegion.querySelector('.fb-retry')).toBeNull();

    const newBtn = Array.from(m.errorRegion.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '再记一条',
    );
    expect(newBtn).not.toBeNull();
  });

  it('轮询时间较长超时停止，不被呈现为归档失败', async () => {
    vi.useFakeTimers();
    stubWindowOpen({ closed: false });
    const m = mount();
    recordFetch(async (url, init) => {
      if (init.method === 'POST') return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      return httpResponse(200, feedbackRecord('processing'));
    });
    completeLogin(m);
    setTextarea(m, '处理较长的反馈');
    m.submitBtn.click();
    await vi.advanceTimersByTimeAsync(130000);

    // 轮询超时提示处理中，不作为失败展示
    expect(m.statusRegion.textContent).toContain('后台正在整理中');
    expect(m.errorRegion.textContent).not.toContain('失败');
  });
});

