import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import {
  API_BASE,
  cleanup,
  deliverAuthMessage,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  stubWindowOpen,
} from './helpers';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('Web 登录握手', () => {
  it('startLogin 按契约 URL 开窗：/login?appId=&nonce=&cb=宿主origin，nonce 随机', () => {
    const { spy, urls } = stubWindowOpen({ closed: false });
    const m = mount();
    m.widget.startLogin();
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = new URL(urls[0] as string);
    expect(parsed.origin + parsed.pathname).toBe(`${API_BASE}/login`);
    expect(parsed.searchParams.get('appId')).toBe('com.example.app');
    expect(parsed.searchParams.get('cb')).toBe(location.origin);
    const nonce = parsed.searchParams.get('nonce') as string;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // nonce 每次随机
    const url2 = m.widget.startLogin();
    expect(new URL(url2).searchParams.get('nonce')).not.toBe(nonce);
  });

  it('message 严格校验：拒绝错误 origin / 错误 nonce / 错误 type；只接受匹配项', async () => {
    stubWindowOpen({ closed: false });
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-x', status: 'received' }));

    const loginUrl = m.widget.startLogin();
    const nonce = new URL(loginUrl).searchParams.get('nonce') as string;

    // 错误 origin
    deliverAuthMessage({ token: 'evil', nonce, origin: 'http://evil.test' });
    // 错误 nonce
    deliverAuthMessage({ token: 'evil', nonce: 'deadbeef' });
    // 错误 type
    deliverAuthMessage({ token: 'evil', nonce, type: 'other:message' });
    // 非对象 payload
    window.dispatchEvent(new MessageEvent('message', { origin: API_BASE, data: 'feedback:auth' }));

    setTextarea(m, '握手后提交');
    m.submitBtn.click();
    await settled();
    expect(calls).toHaveLength(0); // 全部被拒绝 → 仍在需要登录态

    // 合法消息
    deliverAuthMessage({ token: 'good-token', nonce });
    m.submitBtn.click();
    await settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer good-token');
  });

  it('弹窗被拦截（window.open 返回 null）→ 降级显示 target=_blank 登录链接', () => {
    stubWindowOpen(null);
    const m = mount();
    const loginUrl = m.widget.startLogin();
    const link = m.panel.querySelector<HTMLAnchorElement>('a.fb-login-link');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('打开登录窗口');
    expect(link?.target).toBe('_blank');
    expect(link?.getAttribute('href')).toBe(loginUrl);
  });

  it('弹窗过早关闭 → 降级链接；链接窗口随后交付令牌仍有效', async () => {
    vi.useFakeTimers();
    const popup = { closed: false };
    stubWindowOpen(popup);
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-y', status: 'received' }));
    const loginUrl = m.widget.startLogin();
    const nonce = new URL(loginUrl).searchParams.get('nonce') as string;

    popup.closed = true; // 用户直接关掉了弹窗
    await vi.advanceTimersByTimeAsync(400);
    expect(m.panel.querySelector('a.fb-login-link')).not.toBeNull();

    // 通过降级链接在新标签完成登录后，message 仍被接受
    deliverAuthMessage({ token: 'late-token', nonce });
    setTextarea(m, '迟到的令牌');
    m.submitBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer late-token');
  });

  it('令牌过期后提交 401：保留草稿并回到登录态，重新握手后可继续', async () => {
    stubWindowOpen({ closed: false });
    const m = mount();
    let allow = false;
    recordFetch(async () => (allow ? httpResponse(201, { feedbackId: 'fb-z', status: 'received' }) : httpResponse(401, { error: { code: 'unauthorized', message: '令牌过期' } })));
    const url = m.widget.startLogin();
    const nonce = new URL(url).searchParams.get('nonce') as string;
    deliverAuthMessage({ token: 'expiring', nonce });

    setTextarea(m, '过期后保留');
    m.submitBtn.click(); // 401
    await settled();
    expect(m.textarea.value).toBe('过期后保留');
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();

    // 重新握手（模拟登录页 Cookie 静默完成）
    const url2 = m.widget.startLogin();
    deliverAuthMessage({ token: 'fresh', nonce: new URL(url2).searchParams.get('nonce') as string });
    allow = true;
    m.submitBtn.click();
    await settled();
    expect(m.textarea.value).toBe('');
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');
  });
});
