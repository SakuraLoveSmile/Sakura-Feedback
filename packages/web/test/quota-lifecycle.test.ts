import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import {
  apiError,
  authUser,
  cleanup,
  flushPromises,
  httpResponse,
  mount,
  setTextarea,
  submitLoginForm,
  type Mounted,
} from './helpers';

afterEach(cleanup);

const TOKEN = 'tok-quota';

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function quotaBody(over: Partial<{ dailyLimit: number; used: number; remaining: number; resetAt: string }> = {}) {
  return { dailyLimit: 3, used: 0, remaining: 3, resetAt: isoIn(3_600_000), ...over };
}

function loginBody(quota: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, token: TOKEN, expiresAt: isoIn(3_600_000), user: authUser(), quota };
}

function sessionBody(quota: Record<string, unknown>): Record<string, unknown> {
  return {
    authenticated: true,
    kind: 'client',
    expiresAt: isoIn(3_600_000),
    user: authUser(),
    quota,
  };
}

/** 通过面板内表单登录（不打开窗口）。 */
async function login(m: Mounted): Promise<void> {
  m.submitBtn.click();
  await flushPromises();
  submitLoginForm(m, 'admin', 'pw');
  await flushPromises();
}

function quotaText(m: Mounted): string {
  return m.root.querySelector<HTMLSpanElement>('.fb-quota')?.textContent ?? '';
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('T1-B 额度刷新与生命周期（Web）', () => {
  it('额度用尽：每 30 秒刷新一次，后台调高额度后无需重开面板即可恢复', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody({ used: 3, remaining: 0 })));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            // 后台把额度从 3 调到 5、当天已用 3：下一次刷新返回剩余 2。
            return httpResponse(200, sessionBody(quotaBody({ dailyLimit: 5, used: 3, remaining: 2 })));
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open(); // 未登录：打开面板不产生额度请求
      await flushPromises();
      await login(m);
      setTextarea(m, '额度恢复后可提交');

      expect(sessions).toBe(0);
      expect(quotaText(m)).toContain('今日剩余 0 次');
      expect(m.submitBtn.disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sessions).toBe(1);
      expect(quotaText(m)).toContain('今日剩余 2 次');
      expect(m.submitBtn.disabled).toBe(false); // 恢复提交（解除禁用）

      // 恢复后回到 resetAt 单次定时：不产生周期轮询。
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('剩余 0 跨过 resetAt：只触发一次有效刷新并恢复按钮', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T15:59:40Z')); // 北京 23:59:40
    try {
      const m = mount();
      const resetAt = '2026-01-01T16:00:00Z'; // 北京次日零点（20 秒后）
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody({ used: 3, remaining: 0, resetAt })));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            return httpResponse(
              200,
              sessionBody(quotaBody({ used: 0, remaining: 3, resetAt: '2026-01-02T16:00:00Z' })),
            );
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open();
      await flushPromises();
      await login(m);
      setTextarea(m, '跨零点后重试');
      expect(sessions).toBe(0);

      await vi.advanceTimersByTimeAsync(20_000); // 越过 resetAt
      expect(sessions).toBe(1); // 只触发一次有效刷新
      expect(quotaText(m)).toContain('今日剩余 3 次');

      await vi.advanceTimersByTimeAsync(300_000); // 不自行重置、不紧密循环
      expect(sessions).toBe(1);
      expect(quotaText(m)).toContain('今日剩余 3 次');
    } finally {
      vi.useRealTimers();
    }
  });

  it('额度刷新网络失败：保留旧额度，30 秒后重试且不紧密循环', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T15:59:40Z'));
    try {
      const m = mount();
      const resetAt = '2026-01-01T16:00:00Z';
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody({ used: 3, remaining: 0, resetAt })));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            if (sessions === 1) throw new Error('network down');
            return httpResponse(
              200,
              sessionBody(quotaBody({ used: 0, remaining: 3, resetAt: '2026-01-02T16:00:00Z' })),
            );
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open();
      await flushPromises();
      await login(m);
      setTextarea(m, '失败后保留');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sessions).toBe(1);
      expect(quotaText(m)).toContain('今日剩余 0 次'); // 失败保留旧额度
      expect(m.textarea.value).toBe('失败后保留'); // 草稿保留

      await vi.advanceTimersByTimeAsync(1_000); // 不得对过期 resetAt 立即循环
      expect(sessions).toBe(1);

      await vi.advanceTimersByTimeAsync(29_000); // 30 秒后再试
      expect(sessions).toBe(2);
      expect(quotaText(m)).toContain('今日剩余 3 次');
    } finally {
      vi.useRealTimers();
    }
  });

  it('旧额度查询迟到：不得把提交成功后的剩余次数加回', async () => {
    const m = mount();
    const pendingSession = deferred<unknown>();
    let sessions = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          return httpResponse(200, loginBody(quotaBody({ used: 0, remaining: 3 })));
        }
        if (url.includes('/api/auth/session')) {
          sessions += 1;
          return pendingSession.promise;
        }
        return httpResponse(201, {
          feedbackId: 'fb-1',
          status: 'received',
          quota: quotaBody({ used: 1, remaining: 2 }),
        });
      }),
    );

    m.widget.open();
    await flushPromises();
    await login(m);
    expect(quotaText(m)).toContain('今日剩余 3 次');

    // 应用回到前台：发出额度查询（挂起，尚未返回旧值）。
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(sessions).toBe(1);

    // 提交成功先返回：剩余 2。
    setTextarea(m, '提交后剩余 2');
    m.submitBtn.click();
    await flushPromises();
    expect(quotaText(m)).toContain('今日剩余 2 次');

    // 旧额度查询迟到（返回扣减前的剩余 3）：必须被丢弃。
    pendingSession.resolve(httpResponse(200, sessionBody(quotaBody({ used: 0, remaining: 3 }))));
    await flushPromises();
    expect(quotaText(m)).toContain('今日剩余 2 次');
  });

  it('关闭面板 / 退到后台：取消额度定时查询，重新打开或回到前台立即查询', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody({ used: 3, remaining: 0 })));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            return httpResponse(200, sessionBody(quotaBody({ used: 3, remaining: 0 })));
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open();
      await flushPromises();
      await login(m); // 用尽：已排 30 秒定时查询
      m.widget.close();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sessions).toBe(0); // 关闭后没有额度轮询

      m.widget.open(); // 重新打开：立即查询
      await flushPromises();
      expect(sessions).toBe(1);

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sessions).toBe(1); // 退到后台后没有额度轮询

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await flushPromises();
      expect(sessions).toBe(2); // 回到前台立即查询
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      vi.useRealTimers();
    }
  });

  it('resetAt 异常超远：不因宿主定时器溢出退化为紧密循环请求', async () => {
    // 用真实定时器：超过 2^31-1 ms 的延时会被宿主截断为立即触发，
    // 若不加安全上限就会变成对服务端的紧密循环请求。
    const m = mount();
    let sessions = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          return httpResponse(200, loginBody(quotaBody({ resetAt: '2999-01-01T00:00:00Z' })));
        }
        if (url.includes('/api/auth/session')) {
          sessions += 1;
          return httpResponse(200, sessionBody(quotaBody({ resetAt: '2999-01-01T00:00:00Z' })));
        }
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }),
    );

    m.widget.open();
    await flushPromises();
    await login(m);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();

    expect(sessions).toBe(0); // 不得立即触发额度查询
  });

  it('额度刷新 401：回到需要登录态并停止额度定时查询，草稿保留', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody({ used: 3, remaining: 0 })));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            return httpResponse(401, apiError(401, 'unauthorized', '登录已过期'));
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open();
      await flushPromises();
      await login(m);
      setTextarea(m, '过期草稿保留');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sessions).toBe(1);
      expect(m.submitBtn.className).toContain('fb-login'); // 回到需要登录
      expect(m.textarea.value).toBe('过期草稿保留');

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions).toBe(1); // 定时任务已停止
    } finally {
      vi.useRealTimers();
    }
  });

  it('查询在途时关闭再打开：旧结果丢弃，结束后立即补发一次', async () => {
    const m = mount();
    const pending = deferred<unknown>();
    let sessions = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          return httpResponse(200, loginBody(quotaBody()));
        }
        if (url.includes('/api/auth/session')) {
          sessions += 1;
          if (sessions === 1) return pending.promise; // 旧查询挂起
          return httpResponse(200, sessionBody(quotaBody({ remaining: 5 })));
        }
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }),
    );

    m.widget.open();
    await flushPromises();
    await login(m);

    // 关闭再打开：发出额度查询 A（挂起）。
    m.widget.close();
    m.widget.open();
    await flushPromises();
    expect(sessions).toBe(1);

    // A 在途时再次关闭 → 重开：不得并发，只能登记待补发。
    m.widget.close();
    m.widget.open();
    await flushPromises();
    expect(sessions).toBe(1);

    // 旧查询返回旧值：必须被丢弃，且立即补发一次（不等到 resetAt）。
    pending.resolve(httpResponse(200, sessionBody(quotaBody({ used: 0, remaining: 3 }))));
    await flushPromises();
    expect(sessions).toBe(2);
    expect(quotaText(m)).toContain('今日剩余 5 次'); // 补发结果生效（旧值被丢弃）
    expect(quotaText(m)).not.toContain('今日剩余 3 次');
  });

  it('连续重开与回前台：登记合并为一次补发', async () => {
    const m = mount();
    const pending = deferred<unknown>();
    let sessions = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          return httpResponse(200, loginBody(quotaBody()));
        }
        if (url.includes('/api/auth/session')) {
          sessions += 1;
          if (sessions === 1) return pending.promise;
          return httpResponse(200, sessionBody(quotaBody({ remaining: 5 })));
        }
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }),
    );

    m.widget.open();
    await flushPromises();
    await login(m);

    // A 在途：关闭 → 重开 → 回前台，多次登记只算一次意图，不并发。
    m.widget.close();
    m.widget.open();
    await flushPromises();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(sessions).toBe(1);

    pending.resolve(httpResponse(200, sessionBody(quotaBody({ used: 0, remaining: 3 }))));
    await flushPromises();
    expect(sessions).toBe(2); // 恰好一次补发
    expect(quotaText(m)).toContain('今日剩余 5 次');

    // 补发完成后回到 resetAt 定时规则：不重复补发。
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();
    expect(sessions).toBe(2);
  });

  it('登录忙碌导致查询暂缓：登录成功后立即补发一次', async () => {
    const m = mount();
    const pendingLogin = deferred<unknown>();
    let sessions = 0;
    let loginAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/auth/login')) {
          loginAttempts += 1;
          if (loginAttempts === 2) return pendingLogin.promise; // 重登录挂起（忙碌）
          return httpResponse(200, loginBody(quotaBody()));
        }
        if (url.includes('/api/auth/session')) {
          sessions += 1;
          return httpResponse(200, sessionBody(quotaBody({ remaining: 5 })));
        }
        return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
      }),
    );

    m.widget.open();
    await flushPromises();
    await login(m); // 第一次登录立即成功（tok-1），尚无会话查询
    expect(sessions).toBe(0);

    // 已登录状态下再次发起登录（挂起）：登录忙碌挡下额度查询。
    m.widget.startLogin();
    await flushPromises();
    submitLoginForm(m, 'admin', 'pw');
    document.dispatchEvent(new Event('visibilitychange')); // 回前台：被 loginBusy 挡下
    await flushPromises();
    expect(sessions).toBe(0); // 不并发，但意图已登记

    // 登录成功：忙碌结束，立即补发一次（不等到 resetAt / 30 秒）。
    pendingLogin.resolve(httpResponse(200, loginBody(quotaBody())));
    await flushPromises();
    expect(sessions).toBe(1);
    expect(quotaText(m)).toContain('今日剩余 5 次');
  });

  it('会话查询挂起 20 秒超时：释放占用并按 30 秒规则重试', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      let sessions = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: { signal?: AbortSignal }) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, loginBody(quotaBody()));
          }
          if (url.includes('/api/auth/session')) {
            sessions += 1;
            if (sessions === 1) {
              // 永不返回且感知 abort 的会话请求（模拟网络黑洞）。
              return new Promise<never>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('The operation was aborted.', 'AbortError')),
                );
              });
            }
            return httpResponse(200, sessionBody(quotaBody({ remaining: 5 })));
          }
          return httpResponse(201, { feedbackId: 'fb-1', status: 'received' });
        }),
      );

      m.widget.open();
      await flushPromises();
      await login(m);
      document.dispatchEvent(new Event('visibilitychange')); // 触发会话查询 A（挂起）
      await flushPromises();
      expect(sessions).toBe(1);

      await vi.advanceTimersByTimeAsync(20_000); // 超时：释放占用
      await flushPromises();
      expect(sessions).toBe(1); // 占用已释放，但按失败规则尚未重试

      await vi.advanceTimersByTimeAsync(30_000); // 30 秒失败重试
      expect(sessions).toBe(2);
      expect(quotaText(m)).toContain('今日剩余 5 次');
    } finally {
      vi.useRealTimers();
    }
  });
});
