import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import {
  API_BASE,
  apiError,
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  submitLoginForm,
  type Mounted,
} from './helpers';

afterEach(cleanup);

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('提交流程', () => {
  async function ready(): Promise<{ m: Mounted; calls: ReturnType<typeof recordFetch>['calls'] }> {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-1', status: 'received' }));
    await completeLogin(m);
    return { m, calls };
  }

  it('POST /api/feedback：请求体字段、Bearer 头、成功后清空输入并派发事件', async () => {
    const { m, calls } = await ready();
    const events: CustomEvent[] = [];
    m.widget.addEventListener('feedback-submitted', (ev) => events.push(ev as CustomEvent));

    setTextarea(m, '页面偶发白屏');
    m.submitBtn.click();
    await settled();

    expect(calls).toHaveLength(1);
    const post = calls[0] as (typeof calls)[number];
    expect(post.url).toBe(`${API_BASE}/api/feedback`);
    expect(post.method).toBe('POST');
    expect(post.headers['Authorization']).toBe('Bearer test-access-token');
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.body?.text).toBe('页面偶发白屏');
    expect(post.body?.appId).toBe('com.example.app');
    expect(post.body?.context).toEqual({ appVersion: '1.2.3', pageLabel: 'settings/account' });
    // 幂等键：client-generated uuid，非空且稳定
    expect(String(post.body?.idempotencyKey)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // 201 之后才清空输入并显示“已保存，正在整理”
    expect(m.textarea.value).toBe('');
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ feedbackId: 'fb-1', status: 'received' });
  });

  it('网络/服务失败：保留输入文本，展示 errorSummary 与重试提交（复用幂等键）', async () => {
    const m = mount();
    let first = true;
    const { calls } = recordFetch(async () => {
      if (first) {
        first = false;
        return httpResponse(500, apiError(500, 'internal_error', '服务暂时不可用'));
      }
      return httpResponse(201, { feedbackId: 'fb-2', status: 'received' });
    });
    await completeLogin(m);
    setTextarea(m, '深色模式刺眼');
    m.submitBtn.click();
    await settled();

    expect(m.textarea.value).toBe('深色模式刺眼');
    expect(m.errorRegion.hidden).toBe(false);
    expect(m.errorRegion.textContent).toContain('服务暂时不可用');
    const retry = m.errorRegion.querySelector<HTMLButtonElement>('.fb-retry');
    expect(retry).not.toBeNull();
    retry?.click();
    await settled();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body?.idempotencyKey).toBe(calls[1]?.body?.idempotencyKey); // 幂等重放同 key
    expect(m.textarea.value).toBe('');
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');
  });

  it('无令牌：不提交，显示“需要登录”与登录按钮，草稿保留', async () => {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, {}));
    setTextarea(m, '未登录草稿');
    m.submitBtn.click();
    await settled();

    expect(calls).toHaveLength(0);
    expect(m.panel.textContent).toContain('需要登录');
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();
    expect(m.textarea.value).toBe('未登录草稿');
  });

  it('提交返回 401：保留草稿并回到需要登录态', async () => {
    const m = mount();
    recordFetch(async () => httpResponse(401, apiError(401, 'unauthorized', '登录已过期')));
    await completeLogin(m);
    setTextarea(m, '过期令牌');
    m.submitBtn.click();
    await settled();

    expect(m.textarea.value).toBe('过期令牌');
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();
    expect(m.statusRegion.textContent).toContain('需要登录');
  });

  it('点击登录并提交：在当前面板展开表单，登录成功后自动续交挂起的草稿', async () => {
    const m = mount();
    const { calls } = recordFetch(
      async () => httpResponse(201, { feedbackId: 'fb-9', status: 'received' }),
      { token: 'tok-2' },
    );
    setTextarea(m, '登录后续交');
    m.submitBtn.click(); // 无令牌 → 展开面板内登录表单，不打开新窗口
    await settled();
    expect(m.root.querySelector<HTMLDivElement>('.fb-login-panel')?.hidden).toBe(false);
    expect(m.root.querySelector<HTMLButtonElement>('.fb-login-confirm')?.textContent).toBe('登录并提交');

    submitLoginForm(m);
    await settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-2');
    expect(calls[0]?.body?.text).toBe('登录后续交');
  });

  it('超过 10000 码点禁止提交，字数统计正确', async () => {
    const m = mount();
    setTextarea(m, '汉'.repeat(10001)); // 码点计数而非 UTF-16 长度
    expect(m.counter.textContent).toBe('10001/10000');
    expect(m.submitBtn.disabled).toBe(true);
    setTextarea(m, '😀'.repeat(10000)); // 代理对按 1 码点
    expect(m.counter.textContent).toBe('10000/10000');
    expect(m.submitBtn.disabled).toBe(false);
  });

  it('草稿保存在组件实例内存：关面板不丢、实例间不共享，不用 localStorage', async () => {
    const m = mount();
    setTextarea(m, '会话草稿');
    m.widget.close();
    m.widget.open();
    expect(m.textarea.value).toBe('会话草稿');

    // 新实例拥有自己的草稿：不读取其它实例的草稿（草稿单一所有者）
    const w2 = document.createElement('feedback-widget');
    w2.setAttribute('api-base', API_BASE);
    w2.setAttribute('app-id', 'com.example.app');
    document.body.appendChild(w2);
    expect((w2.shadowRoot?.querySelector('.fb-textarea') as HTMLTextAreaElement | null)?.value).toBe('');
    w2.remove();

    // 确认未写 localStorage（环境无 localStorage 时同样通过）
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (store) expect(store.length).toBe(0);
  });
});
