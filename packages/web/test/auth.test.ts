import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import {
  API_BASE,
  APP_ID,
  apiError,
  authUser,
  cleanup,
  completeLogin,
  flushPromises,
  httpResponse,
  loginResponse,
  mount,
  quota,
  recordFetch,
  sessionResponse,
  setTextarea,
  submitLoginForm,
  TEST_TOKEN,
} from './helpers';

afterEach(cleanup);

describe('面板内登录（不再打开登录窗口）', () => {
  it('未登录仍可编辑反馈；点击「登录并提交」在当前面板展开表单，不开窗口', async () => {
    const openSpy = vi.spyOn(window, 'open');
    const m = mount();
    setTextarea(m, '未登录也能写');
    expect(m.textarea.disabled).toBe(false);

    m.submitBtn.click();
    await flushPromises();

    expect(m.root.querySelector<HTMLDivElement>('.fb-login-panel')?.hidden).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(m.textarea.value).toBe('未登录也能写');
    expect(m.statusRegion.textContent).toContain('需要登录');
  });

  it('表单确认按钮写「登录并提交」；登录成功后只提交一次', async () => {
    const m = mount();
    const { calls } = recordFetch(
      async () => httpResponse(201, { feedbackId: 'fb-1', status: 'received' }),
      { token: 'tok-once' },
    );
    setTextarea(m, '只提交一次');
    m.submitBtn.click();
    await flushPromises();

    const confirm = m.root.querySelector<HTMLButtonElement>('.fb-login-confirm');
    expect(confirm?.textContent).toBe('登录并提交');
    submitLoginForm(m);
    await flushPromises();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/feedback`);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok-once');
    expect(calls[0]?.body?.text).toBe('只提交一次');
  });

  it('取消只收起登录区域，草稿与截图保留', async () => {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, {}));
    setTextarea(m, '取消也不丢');
    m.submitBtn.click();
    await flushPromises();

    m.root.querySelector<HTMLButtonElement>('.fb-login-cancel')?.click();
    await flushPromises();

    expect(m.root.querySelector<HTMLDivElement>('.fb-login-panel')?.hidden).toBe(true);
    expect(m.textarea.value).toBe('取消也不丢');
    expect(calls).toHaveLength(0);
  });

  it('登录请求显式携带 clientLabel / appId，且不依赖跨站 Cookie', async () => {
    const m = mount();
    let loginInit: { body?: string; credentials?: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string; credentials?: string }) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          loginInit = init;
          return loginResponse();
        }
        return sessionResponse();
      }),
    );
    setTextarea(m, '登录字段');
    m.submitBtn.click();
    await flushPromises();
    submitLoginForm(m, 'alice', 'secret-pw');
    await flushPromises();

    expect(loginInit?.credentials).toBe('omit'); // Bearer，不依赖跨站 Cookie
    const body = JSON.parse(loginInit?.body ?? '{}');
    expect(body).toMatchObject({ username: 'alice', password: 'secret-pw', appId: APP_ID });
    expect(body.clientLabel).toBe(`web:${APP_ID}`);
  });

  it('凭据错误：显示错误提示、清空密码、保留草稿', async () => {
    const m = mount();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('/api/auth/login')) {
          return httpResponse(401, apiError(401, 'invalid_credentials', '用户名或密码错误'));
        }
        return httpResponse(200, {});
      }),
    );
    setTextarea(m, '凭据错误草稿');
    m.submitBtn.click();
    await flushPromises();
    submitLoginForm(m, 'alice', 'wrong-pw');
    await flushPromises();

    const errEl = m.root.querySelector<HTMLParagraphElement>('.fb-login-error');
    expect(errEl?.hidden).toBe(false);
    expect(errEl?.textContent).toContain('用户名或密码错误');
    expect(m.root.querySelector<HTMLInputElement>('.fb-login-password')?.value).toBe('');
    expect(m.textarea.value).toBe('凭据错误草稿');
  });

  it('来源未被允许：提示明确且不进入已登录态', async () => {
    const m = mount();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('/api/auth/login')) {
          return httpResponse(403, apiError(403, 'origin_not_allowed', '该来源未被允许登录'));
        }
        return httpResponse(200, {});
      }),
    );
    setTextarea(m, '来源受限');
    m.submitBtn.click();
    await flushPromises();
    submitLoginForm(m);
    await flushPromises();

    expect(m.root.querySelector<HTMLParagraphElement>('.fb-login-error')?.textContent).toContain('来源');
    expect(m.submitBtn.className).toContain('fb-login'); // 仍未登录
  });
});

describe('额度与会话刷新', () => {
  it('登录成功后显示今日剩余次数，并带上 user/quota', async () => {
    const m = mount();
    recordFetch(async () => httpResponse(201, {}));
    await completeLogin(m);

    expect(m.root.querySelector<HTMLSpanElement>('.fb-quota')?.textContent).toContain('今日剩余 3 次');
    expect(m.submitBtn.className).not.toContain('fb-login');
  });

  it('打开面板时刷新额度（GET /api/auth/session）', async () => {
    const m = mount();
    const { authCalls } = recordFetch(async () => httpResponse(201, {}));
    m.widget.startLogin();
    await flushPromises();
    submitLoginForm(m);
    await flushPromises();
    authCalls.length = 0;

    m.widget.open();
    await flushPromises();

    expect(authCalls.some((u) => u.includes('/api/auth/session'))).toBe(true);
  });

  it('daily_quota_exceeded 429 视为「未接收」：保留草稿、显示额度用尽、禁用新提交', async () => {
    const m = mount();
    const limited = { dailyLimit: 3, used: 3, remaining: 0, resetAt: new Date(Date.now() + 3_600_000).toISOString() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) return loginResponse();
        if (url.includes('/api/auth/session')) return sessionResponse();
        return httpResponse(429, apiError(429, 'daily_quota_exceeded', '今日提交次数已用完', { quota: limited }));
      }),
    );
    await completeLogin(m);
    setTextarea(m, '额度用尽仍保留');
    m.submitBtn.click();
    await flushPromises();

    expect(m.textarea.value).toBe('额度用尽仍保留');
    expect(m.errorRegion.textContent).toContain('今日提交次数已用完');
    expect(m.root.querySelector<HTMLSpanElement>('.fb-quota')?.textContent).toContain('今日剩余 0 次');
    expect(m.root.querySelector<HTMLParagraphElement>('.fb-quota-blocked')?.textContent).toContain('今日提交次数已用完');
    // 未接收：不提供「结果未知」语义的重试按钮；新提交被禁用。
    expect(m.errorRegion.querySelector('.fb-retry')).toBeNull();
    expect(m.submitBtn.disabled).toBe(true);
  });

  it('令牌过期（401）：保留草稿并可重新登录后继续', async () => {
    const m = mount();
    let submits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) return loginResponse();
        if (url.includes('/api/auth/session')) return sessionResponse();
        submits += 1;
        if (submits === 1) return httpResponse(401, apiError(401, 'unauthorized', '登录已过期'));
        return httpResponse(201, { feedbackId: 'fb-continue', status: 'received' });
      }),
    );
    await completeLogin(m);
    setTextarea(m, '过期后重登');
    m.submitBtn.click();
    await flushPromises();

    expect(m.textarea.value).toBe('过期后重登');
    expect(m.submitBtn.className).toContain('fb-login');

    m.submitBtn.click(); // 重新展开登录表单
    await flushPromises();
    submitLoginForm(m);
    await flushPromises();

    expect(m.textarea.value).toBe('');
    expect(m.statusRegion.textContent).toContain('已保存');
  });

  it('登录响应不包含密码字段；令牌为唯一明文', async () => {
    const body = (await (loginResponse().json() as Promise<Record<string, unknown>>)) as Record<string, unknown>;
    expect(body).toMatchObject({ user: authUser(), quota: quota() });
    expect(JSON.stringify(body)).not.toContain('password');
    expect(String(body.token)).toBe(TEST_TOKEN);
  });
});
