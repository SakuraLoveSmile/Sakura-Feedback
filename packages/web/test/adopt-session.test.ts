import { afterEach, describe, expect, it } from 'vitest';
import '../src/index';
import {
  cleanup,
  flushPromises,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
} from './helpers';

const futureIso = (ms: number) => new Date(Date.now() + ms).toISOString();

afterEach(cleanup);

describe('宿主注入会话（adoptSession / dropSession）', () => {
  it('注入有效令牌即视为已登录：自动拉取会话身份与额度，可直接提交', async () => {
    const m = mount();
    const { calls, authCalls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-1', status: 'received' }),
    );
    m.widget.adoptSession({ accessToken: 'tok-host', expiresAt: futureIso(600_000) });
    await flushPromises();

    expect(authCalls.some((u) => u.includes('/api/auth/session'))).toBe(true);
    expect(m.statusRegion.textContent).toContain('已登录');

    setTextarea(m, '来自宿主的反馈');
    m.submitBtn.click();
    await flushPromises();

    const submit = calls.find((c) => c.url.includes('/api/feedback'));
    expect(submit).toBeTruthy();
    expect(submit?.headers['Authorization']).toBe('Bearer tok-host');
  });

  it('expiresAt 接受 epoch 毫秒数值', async () => {
    const m = mount();
    const { authCalls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-1', status: 'received' }),
    );
    m.widget.adoptSession({ accessToken: 'tok-num', expiresAt: Date.now() + 600_000 });
    await flushPromises();
    expect(authCalls.some((u) => u.includes('/api/auth/session'))).toBe(true);
  });

  it('非法注入按 no-op 处理：空令牌 / 过期时刻不可解析 / 已过期', async () => {
    const m = mount();
    const { authCalls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-1', status: 'received' }),
    );
    m.widget.adoptSession({ accessToken: '', expiresAt: futureIso(600_000) });
    m.widget.adoptSession({ accessToken: 'tok-bad', expiresAt: 'not-a-date' });
    m.widget.adoptSession({ accessToken: 'tok-old', expiresAt: Date.now() - 1_000 });
    // @ts-expect-error 运行期防御：宿主可能传入非对象
    m.widget.adoptSession(null);
    await flushPromises();

    expect(authCalls).toHaveLength(0);
    setTextarea(m, '仍未登录');
    m.submitBtn.click();
    await flushPromises();
    expect(m.statusRegion.textContent).toContain('需要登录');
  });

  it('续注新令牌后请求使用新令牌', async () => {
    const m = mount();
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-1', status: 'received' }),
    );
    m.widget.adoptSession({ accessToken: 'tok-v1', expiresAt: futureIso(600_000) });
    await flushPromises();
    m.widget.adoptSession({ accessToken: 'tok-v2', expiresAt: futureIso(600_000) });
    await flushPromises();

    setTextarea(m, '续注后的提交');
    m.submitBtn.click();
    await flushPromises();

    const submit = calls.find((c) => c.url.includes('/api/feedback'));
    expect(submit?.headers['Authorization']).toBe('Bearer tok-v2');
  });

  it('dropSession 回到需要登录态，草稿保留', async () => {
    const m = mount();
    recordFetch(async () => httpResponse(201, { feedbackId: 'fb-1', status: 'received' }));
    m.widget.adoptSession({ accessToken: 'tok-host', expiresAt: futureIso(600_000) });
    await flushPromises();

    setTextarea(m, '退出宿主后草稿仍在');
    m.widget.dropSession();
    await flushPromises();

    expect(m.textarea.value).toBe('退出宿主后草稿仍在');
    m.submitBtn.click();
    await flushPromises();
    expect(m.statusRegion.textContent).toContain('需要登录');
    expect(m.root.querySelector<HTMLDivElement>('.fb-login-panel')?.hidden).toBe(false);
  });

  it('未注入时令牌为空：dropSession 为幂等 no-op', async () => {
    const m = mount();
    m.widget.dropSession();
    await flushPromises();
    setTextarea(m, '普通未登录流程');
    m.submitBtn.click();
    await flushPromises();
    expect(m.statusRegion.textContent).toContain('需要登录');
  });
});
