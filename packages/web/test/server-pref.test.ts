import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import { normalizeServerBase, serverOverrideStorageKey } from '../src/server_pref';
import {
  API_BASE,
  APP_ID,
  TEST_TOKEN,
  cleanup,
  completeLogin,
  flushPromises,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  type Mounted,
} from './helpers';

afterEach(cleanup);

const BASE_B = 'http://api-b.test:8788';
const BASE_C = 'http://api-c.test:8788';
const OTHER_APP_ID = 'com.other.app';

interface SettingsDom {
  btn: HTMLButtonElement;
  view: HTMLDivElement;
  input: HTMLInputElement;
  current: HTMLSpanElement;
  defaultRow: HTMLParagraphElement;
  error: HTMLParagraphElement;
  hint: HTMLParagraphElement;
  save: HTMLButtonElement;
  restore: HTMLButtonElement;
  cancel: HTMLButtonElement;
  confirm: HTMLDivElement;
  confirmText: HTMLParagraphElement;
  confirmOk: HTMLButtonElement;
  confirmCancel: HTMLButtonElement;
}

function settings(m: Mounted): SettingsDom {
  const q = <T extends HTMLElement>(sel: string) => m.root.querySelector<T>(sel) as T;
  return {
    btn: q<HTMLButtonElement>('.fb-settings-btn'),
    view: q<HTMLDivElement>('.fb-settings'),
    input: q<HTMLInputElement>('.fb-server-input'),
    current: q<HTMLSpanElement>('.fb-settings .fb-settings-line .fb-settings-value'),
    defaultRow: q<HTMLParagraphElement>('.fb-settings .fb-settings-line:nth-of-type(2)'),
    error: q<HTMLParagraphElement>('.fb-settings-error'),
    hint: q<HTMLParagraphElement>('.fb-settings-hint'),
    save: q<HTMLButtonElement>('.fb-settings-save'),
    restore: q<HTMLButtonElement>('.fb-settings-restore'),
    cancel: q<HTMLButtonElement>('.fb-settings-cancel'),
    confirm: q<HTMLDivElement>('.fb-settings-confirm'),
    confirmText: q<HTMLParagraphElement>('.fb-settings-confirm-text'),
    confirmOk: q<HTMLButtonElement>('.fb-settings-confirm-ok'),
    confirmCancel: q<HTMLButtonElement>('.fb-settings-confirm-cancel'),
  };
}

function openSettings(m: Mounted): SettingsDom {
  const s = settings(m);
  s.btn.click();
  return s;
}

function key(appId = APP_ID, base = API_BASE): string {
  return serverOverrideStorageKey(appId, base);
}

describe('T6 normalizeServerBase 地址校验与规范化', () => {
  it('接受 http(s)、端口与部署路径前缀，去除空白与末尾斜杠', () => {
    expect(normalizeServerBase('  https://fb.example.com/  ')).toEqual({
      ok: true,
      base: 'https://fb.example.com',
    });
    expect(normalizeServerBase('http://127.0.0.1:8787/')).toEqual({
      ok: true,
      base: 'http://127.0.0.1:8787',
    });
    expect(normalizeServerBase('https://fb.example.com/fb/api/')).toEqual({
      ok: true,
      base: 'https://fb.example.com/fb/api',
    });
    expect(normalizeServerBase('https://fb.example.com:8443')).toEqual({
      ok: true,
      base: 'https://fb.example.com:8443',
    });
    // 默认端口与主机名大小写规范化
    expect(normalizeServerBase('HTTPS://FB.EXAMPLE.COM:443/')).toEqual({
      ok: true,
      base: 'https://fb.example.com',
    });
    expect(normalizeServerBase('http://fb.example.com:80')).toEqual({
      ok: true,
      base: 'http://fb.example.com',
    });
  });

  it('拒绝空值、缺协议、非 http(s)、缺主机、内嵌凭据、查询与片段', () => {
    expect(normalizeServerBase('').ok).toBe(false);
    expect(normalizeServerBase('   ').ok).toBe(false);
    expect(normalizeServerBase('fb.example.com').ok).toBe(false);
    expect(normalizeServerBase('ftp://fb.example.com').ok).toBe(false);
    expect(normalizeServerBase('https://').ok).toBe(false);
    expect(normalizeServerBase('https://user:pw@fb.example.com').ok).toBe(false);
    expect(normalizeServerBase('https://fb.example.com?x=1').ok).toBe(false);
    expect(normalizeServerBase('https://fb.example.com#frag').ok).toBe(false);
  });

  it('HTTPS 页面拒绝 HTTP 覆盖（混合内容）', () => {
    expect(normalizeServerBase('http://fb.example.com', { pageIsHttps: true }).ok).toBe(false);
    expect(normalizeServerBase('https://fb.example.com', { pageIsHttps: true })).toEqual({
      ok: true,
      base: 'https://fb.example.com',
    });
  });
});

describe('T6 设置视图与 effectiveApiBase', () => {
  it('无覆盖时 effectiveApiBase 等于宿主 api-base', () => {
    const m = mount();
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
  });

  it('头部提供设置入口；未登录也可进入设置视图', () => {
    const m = mount();
    m.widget.open();
    const s = openSettings(m);
    expect(s.view.hidden).toBe(false);
    expect(s.input.value).toBe(API_BASE);
    expect(s.current.textContent).toBe(API_BASE);
    // 主体被设置视图替换
    const body = m.root.querySelector<HTMLDivElement>('.fb-body') as HTMLDivElement;
    expect(body.hidden).toBe(true);
    // 未登录：登录表单 / 提交区不可见，但设置可用
    expect(m.root.querySelector('.fb-login-panel')).toBeTruthy();
  });

  it('构造前已存的覆盖在挂载时生效：effectiveApiBase 指向覆盖地址', () => {
    window.localStorage.setItem(key(), BASE_B);
    const m = mount();
    expect(m.widget.effectiveApiBase).toBe(BASE_B);
  });

  it('偏好按 appId 与规范化默认地址隔离：不同身份读不到其他槽位', () => {
    // 另一个 appId 的槽位有值，本 appId 读不到
    window.localStorage.setItem(key('other.app'), BASE_B);
    const m = mount();
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
    // 另一个默认地址的槽位有值，本默认地址读不到
    window.localStorage.setItem(key(APP_ID, 'https://else.example.com'), BASE_B);
    const m2 = mount();
    expect(m2.widget.effectiveApiBase).toBe(API_BASE);
  });

  it('非法输入被拒绝且不替换当前有效地址', () => {
    const m = mount();
    m.widget.open();
    const s = openSettings(m);
    s.input.value = 'ftp://bad';
    s.save.click();
    expect(s.error.hidden).toBe(false);
    expect(s.error.textContent).toContain('http');
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
  });

  it('相同规范化地址的保存不触发重置：草稿保留', () => {
    const m = mount();
    m.widget.open();
    setTextarea(m, 'draft stays');
    const s = openSettings(m);
    s.input.value = `${API_BASE}/`; // 末尾斜杠 → 规范化后同址
    s.save.click();
    expect(s.confirm.hidden).toBe(true); // 同址不需要确认
    expect(m.textarea.value).toBe('draft stays');
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
  });

  it('切换地址且有草稿时先确认；取消则原样保留', () => {
    const m = mount();
    m.widget.open();
    setTextarea(m, 'keep me');
    const s = openSettings(m);
    s.input.value = BASE_B;
    s.save.click();
    expect(s.confirm.hidden).toBe(false);
    expect(s.confirmText.textContent).toContain('清空');
    s.confirmCancel.click();
    expect(s.confirm.hidden).toBe(true);
    expect(m.textarea.value).toBe('keep me');
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
    expect(window.localStorage.getItem(key())).toBeNull();
  });

  it('确认切换后清空草稿并写入偏好；后续请求发往新地址', async () => {
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb1', status: 'received' }));
    const m = mount();
    m.widget.open();
    await completeLogin(m);
    setTextarea(m, '切换前的草稿');
    const s = openSettings(m);
    s.input.value = BASE_B;
    s.save.click();
    s.confirmOk.click();
    await flushPromises();
    expect(m.textarea.value).toBe(''); // 草稿已清空
    expect(m.widget.effectiveApiBase).toBe(BASE_B);
    expect(window.localStorage.getItem(key())).toBe(BASE_B);
    // 新地址上的登录：旧令牌不得复用 → 需要重新登录
    m.widget.startLogin();
    const username = m.root.querySelector<HTMLInputElement>('.fb-login-username') as HTMLInputElement;
    const password = m.root.querySelector<HTMLInputElement>('.fb-login-password') as HTMLInputElement;
    const confirm = m.root.querySelector<HTMLButtonElement>('.fb-login-confirm') as HTMLButtonElement;
    username.value = 'admin';
    password.value = 'secret';
    confirm.click();
    await flushPromises();
    setTextarea(m, '发往 B 的反馈');
    m.submitBtn.click();
    await flushPromises();
    expect(calls.some((c) => c.url.startsWith(BASE_B))).toBe(true);
    expect(calls.every((c) => !c.url.startsWith(API_BASE))).toBe(true);
  });

  it('appId 切换到不同 per-app 服务覆盖时清除旧 token', async () => {
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb1', status: 'received' }));
    window.localStorage.setItem(key(APP_ID, API_BASE), BASE_B);
    window.localStorage.setItem(key(OTHER_APP_ID, API_BASE), BASE_C);
    const m = mount();
    m.widget.open();
    await completeLogin(m);
    expect(m.widget.effectiveApiBase).toBe(BASE_B);

    m.widget.appId = OTHER_APP_ID;
    expect(m.widget.effectiveApiBase).toBe(BASE_C);
    expect(m.panel.querySelector('.fb-login')).not.toBeNull();

    setTextarea(m, '切换到另一个服务');
    m.submitBtn.click();
    await flushPromises();
    expect(calls).toHaveLength(0);
    expect(calls.every((call) => call.headers.Authorization !== `Bearer ${TEST_TOKEN}`)).toBe(true);
  });

  it('「恢复默认」清除覆盖并切回宿主地址；确认后清空草稿', async () => {
    recordFetch(async () => httpResponse(201, { feedbackId: 'fb1', status: 'received' }));
    window.localStorage.setItem(key(), BASE_B);
    const m = mount();
    m.widget.open();
    expect(m.widget.effectiveApiBase).toBe(BASE_B);
    const s = openSettings(m);
    expect(s.defaultRow.hidden).toBe(false);
    expect(s.restore.disabled).toBe(false);
    s.restore.click();
    // 无草稿也确认面板？restore 时无草稿 → 直接切换
    await flushPromises();
    expect(m.widget.effectiveApiBase).toBe(API_BASE);
    expect(window.localStorage.getItem(key())).toBeNull();
  });

  it('偏好写入失败时提示「仅本次生效」，地址仍在会话内生效', async () => {
    recordFetch(async () => httpResponse(200, { ok: true }));
    const m = mount();
    m.widget.open();
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    const s = openSettings(m);
    s.input.value = BASE_B;
    s.save.click(); // 无草稿 → 直接切换
    await flushPromises();
    expect(m.widget.effectiveApiBase).toBe(BASE_B);
    expect(s.hint.textContent).toContain('仅本次生效');
    setItem.mockRestore();
  });

  it('地址未变化时「恢复默认」不可点', () => {
    const m = mount();
    m.widget.open();
    const s = openSettings(m);
    expect(s.restore.disabled).toBe(true);
  });

  it('存在结果未确认提交时，确认文案说明旧服务器可能已接收', async () => {
    // 让提交卡在「结果未知」：第一次提交网络失败（fetch reject）
    const { fetchMock } = recordFetch(async () => {
      throw new Error('network down');
    });
    const m = mount();
    m.widget.open();
    await completeLogin(m);
    setTextarea(m, '可能已送达');
    m.submitBtn.click();
    await flushPromises();
    // 进入未确认态后再改文案 → unconfirmedRequest 产生
    setTextarea(m, '修改后的草稿');
    const s = openSettings(m);
    s.input.value = BASE_B;
    s.save.click();
    expect(s.confirm.hidden).toBe(false);
    expect(s.confirmText.textContent).toContain('可能已接收');
    s.confirmOk.click();
    await flushPromises();
    expect(m.widget.effectiveApiBase).toBe(BASE_B);
    expect(m.textarea.value).toBe('');
    void fetchMock;
  });
});
