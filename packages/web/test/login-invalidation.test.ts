import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import {
  API_BASE,
  apiError,
  cleanup,
  flushPromises,
  httpResponse,
  loginResponse,
  mount,
  sessionResponse,
  setTextarea,
  submitLoginForm,
} from './helpers';

afterEach(cleanup);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 登录请求挂起时执行 [whilePending]，随后再交付登录响应。
 * 用于验证「关闭 / 卸载 / 取消后迟到的登录结果一律失效」。
 */
async function withPendingLogin(
  m: ReturnType<typeof mount>,
  run: (resolveLogin: (body: unknown) => void) => Promise<void>,
): Promise<{ posts: string[]; loginAttempts: () => number }> {
  const pending = deferred<unknown>();
  const posts: string[] = [];
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/auth/login')) {
        attempts += 1;
        if (attempts === 1) return pending.promise;
        return loginResponse('tok-new');
      }
      if (url.includes('/api/auth/session')) return sessionResponse();
      posts.push(url);
      return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
    }),
  );


  setTextarea(m, '登录期间离开');
  m.submitBtn.click(); // 展开面板内登录表单（pendingSubmit=true）
  await flushPromises();
  submitLoginForm(m, 'old', 'pw'); // 发起登录（挂起）
  await flushPromises();

  await run((body) => pending.resolve(body));
  return { posts, loginAttempts: () => attempts };
}

/** 点击「取消」：登录进行中仍可用，用于中止挂起的登录（使其迟到结果失效）。 */
function clickCancel(m: ReturnType<typeof mount>): void {
  m.root.querySelector<HTMLButtonElement>('.fb-login-cancel')?.click();
}

describe('T1-A 登录操作失效（关闭 / 卸载 / 取消 / 身份变化）', () => {
  it('登录期间关闭面板：迟到的成功不写令牌、不自动提交，草稿保留', async () => {
    const m = mount();
    const { posts } = await withPendingLogin(m, async (resolveLogin) => {
      m.widget.close();
      resolveLogin(loginResponse('tok-old'));
      await flushPromises();
    });

    expect(posts).toHaveLength(0); // 迟到成功不得触发自动提交
    expect(m.submitBtn.className).toContain('fb-login'); // 未进入已登录态
    expect(m.textarea.value).toBe('登录期间离开'); // 草稿保留
    expect(
      m.root.querySelector<HTMLInputElement>('.fb-login-password')?.value,
    ).toBe(''); // 密码清除
  });

  it('重新打开后可以继续编辑并重新登录：新登录只提交一次', async () => {
    const m = mount();
    const { posts } = await withPendingLogin(m, async (resolveLogin) => {
      m.widget.close();
      resolveLogin(loginResponse('tok-old'));
      await flushPromises();
    });

    m.widget.open();
    await flushPromises();
    expect(m.textarea.value).toBe('登录期间离开');

    m.submitBtn.click(); // 重新展开登录表单
    await flushPromises();
    submitLoginForm(m, 'new', 'pw');
    await flushPromises();

    expect(posts).toHaveLength(1); // 新登录只提交一次
    expect(posts[0]).toBe(`${API_BASE}/api/feedback`);
    expect(m.textarea.value).toBe('');
  });

  it('登录期间组件被卸载：迟到的成功不触发提交', async () => {
    const m = mount();
    const { posts } = await withPendingLogin(m, async (resolveLogin) => {
      m.widget.remove(); // 卸载 → 在途登录失效
      resolveLogin(loginResponse('tok-old'));
      await flushPromises();
    });

    expect(posts).toHaveLength(0);
  });

  it('取消登录后：迟到的成功不写令牌、不自动提交', async () => {
    const m = mount();
    const { posts } = await withPendingLogin(m, async (resolveLogin) => {
      clickCancel(m);
      await flushPromises();
      resolveLogin(loginResponse('tok-old'));
      await flushPromises();
    });

    expect(posts).toHaveLength(0);
    expect(m.submitBtn.className).toContain('fb-login');
    expect(m.textarea.value).toBe('登录期间离开');
  });

  it('旧登录失效后发起新登录：旧的失败迟到不覆盖新登录状态', async () => {
    const m = mount();
    const pendingOld = deferred<unknown>();
    const posts: string[] = [];
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          attempts += 1;
          if (attempts === 1) return pendingOld.promise;
          return loginResponse('tok-new');
        }
        if (url.includes('/api/auth/session')) return sessionResponse();
        posts.push(url);
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }),
    );

    setTextarea(m, '草稿不丢');
    m.submitBtn.click();
    await flushPromises();
    submitLoginForm(m, 'old', 'pw'); // 旧登录挂起
    await flushPromises();

    clickCancel(m); // 旧登录失效
    await flushPromises();

    m.submitBtn.click(); // 重新展开
    await flushPromises();
    submitLoginForm(m, 'new', 'pw'); // 新登录成功
    await flushPromises();
    expect(m.submitBtn.className).not.toContain('fb-login');
    expect(posts).toHaveLength(1);

    // 旧登录迟到的失败：不得覆盖新登录状态、不得显示旧错误。
    pendingOld.resolve(
      httpResponse(401, apiError(401, 'invalid_credentials', '用户名或密码错误')),
    );
    await flushPromises();

    expect(m.submitBtn.className).not.toContain('fb-login');
    expect(m.root.querySelector<HTMLParagraphElement>('.fb-login-error')?.hidden).toBe(true);
    expect(posts).toHaveLength(1); // 不重复提交
  });
});

describe('T1-A 旧请求 401 不得清除新登录（提交 / 轮询 / 手动刷新）', () => {
  /** 已登录（tok-1）并挂起一个用旧令牌发出的请求，随后换新令牌（tok-2）。 */
  async function withStaleRequest(
    m: ReturnType<typeof mount>,
    options: { submitBody: () => unknown; afterLogin1: (m: ReturnType<typeof mount>) => Promise<void> },
  ): Promise<void> {
    let loginAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          loginAttempts += 1;
          return loginResponse(loginAttempts === 1 ? 'tok-1' : 'tok-2');
        }
        if (url.includes('/api/auth/session')) return sessionResponse();
        return await options.submitBody();
      }),
    );

    setTextarea(m, '旧令牌请求');
    m.submitBtn.click(); // 展开登录表单（pendingSubmit=true）
    await flushPromises();
    submitLoginForm(m, 'admin', 'pw'); // 登录 #1 → tok-1 → 自动续交
    await flushPromises();
    await options.afterLogin1(m);

    // 旧请求在途时重新登录：保存 tok-2。
    m.widget.startLogin();
    await flushPromises();
    submitLoginForm(m, 'admin', 'pw');
    await flushPromises();
  }

  it('旧提交的 401 到达：不清除新登录令牌、不进入需要登录态', async () => {
    const m = mount();
    const pendingSubmit = deferred<unknown>();
    await withStaleRequest(m, {
      submitBody: () => pendingSubmit.promise,
      afterLogin1: async () => {
        await flushPromises(); // 自动续交已发出（挂起）
      },
    });

    // 旧提交返回 401：tok-2 必须保留，不得把界面切到需要登录。
    pendingSubmit.resolve(httpResponse(401, apiError(401, 'unauthorized', '登录已过期')));
    await flushPromises();

    expect(m.submitBtn.className).not.toContain('fb-login'); // 仍处于已登录 UI
    expect(m.textarea.value).toBe('旧令牌请求'); // 草稿保留
  });

  it('旧轮询的 401 到达：不清除新登录令牌，轮询以新令牌继续', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      const pendingPoll = deferred<unknown>();
      let feedbackCalls = 0;
      await withStaleRequest(m, {
        submitBody: () => {
          feedbackCalls += 1;
          if (feedbackCalls === 1) return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
          if (feedbackCalls === 2) return pendingPoll.promise; // 第一次轮询挂起（tok-1）
          return httpResponse(200, {
            id: 'fb-1',
            status: 'archived',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            errorSummary: null,
            kaneoUrl: null,
          });
        },
        afterLogin1: async () => {
          // 提交成功后开始轮询；推进到第一次轮询 tick（挂起，tok-1）。
          await vi.advanceTimersByTimeAsync(2_000);
        },
      });

      // 旧轮询返回 401：不得清 tok-2、不得停止轮询任务。
      pendingPoll.resolve(httpResponse(401, apiError(401, 'unauthorized', '登录已过期')));
      await flushPromises();
      expect(m.submitBtn.className).not.toContain('fb-login');

      // 退避后的下一次轮询以 tok-2 发出并成功 → 归档终态。
      await vi.advanceTimersByTimeAsync(5_000);
      await flushPromises();
      expect(m.statusRegion.textContent).toContain('已归档');
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动刷新的 401 到达：不清除新登录令牌', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      const pendingRefresh = deferred<unknown>();
      let feedbackCalls = 0;
      await withStaleRequest(m, {
        submitBody: () => {
          feedbackCalls += 1;
          if (feedbackCalls === 1) {
            // 服务端已接收但处理失败（Class B）。
            return httpResponse(201, { feedbackId: 'fb-1', status: 'failed' });
          }
          if (feedbackCalls === 2) {
            // 第一次轮询确认 failed 终态 → failed 视图。
            return httpResponse(200, {
              id: 'fb-1',
              status: 'failed',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              errorSummary: '后台整理失败',
              kaneoUrl: null,
            });
          }
          return pendingRefresh.promise; // 手动刷新挂起（tok-1）
        },
        afterLogin1: async (mounted) => {
          // 推进到第一次轮询：确认 failed 终态后出现「刷新状态」。
          await vi.advanceTimersByTimeAsync(2_000);
          await flushPromises();
          const refreshBtn = mounted.root.querySelector<HTMLButtonElement>('.fb-refresh-btn');
          expect(refreshBtn).not.toBeNull();
          refreshBtn!.click();
          await flushPromises();
        },
      });

      // 旧手动刷新返回 401：tok-2 保留，界面不进入需要登录态。
      pendingRefresh.resolve(httpResponse(401, apiError(401, 'unauthorized', '登录已过期')));
      await flushPromises();

      expect(m.submitBtn.className).not.toContain('fb-login');
    } finally {
      vi.useRealTimers();
    }
  });
});
