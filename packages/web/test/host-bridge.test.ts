import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import {
  openFeedback,
  type FeedbackSessionStore,
} from '../src/index';
import {
  apiError,
  cleanup,
  flushPromises,
  httpResponse,
  mount,
  recordFetch,
  sessionResponse,
  setTextarea,
  submitLoginForm,
  type Mounted,
} from './helpers';
import {
  blobToPng,
  encodePng,
  createState,
  stubCreateElementCanvas,
} from './pixel-fixture';

afterEach(cleanup);

const ORANGE: [number, number, number, number] = [200, 100, 50, 255];

function accessTokenOf(widget: Mounted['widget']): string | null {
  return (widget as unknown as { accessToken: string | null }).accessToken;
}

function uniformPng(size: number, rgba: [number, number, number, number]): File {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = rgba[0];
    px[i + 1] = rgba[1];
    px[i + 2] = rgba[2];
    px[i + 3] = rgba[3];
  }
  return new File([encodePng(size, size, px)], 'img.png', { type: 'image/png' });
}

async function settled(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('宿主接口与返回键支持（hostBridge / sessionStore / handleBackPressed）', () => {
  describe('sessionStore 会话管理', () => {
    it('挂载/初始化时调用 loadSession()，有效会话自动调用 adoptSession 并拉取凭据', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue({
          accessToken: 'tok-host-stored',
          expiresAt: Date.now() + 3600_000,
        }),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      const { authCalls } = recordFetch(async () => httpResponse(200, { user: { id: 'u1' } }));
      m.widget.sessionStore = mockStore;
      await flushPromises();

      expect(mockStore.loadSession).toHaveBeenCalledTimes(1);
      expect(accessTokenOf(m.widget)).toBe('tok-host-stored');
      expect(m.statusRegion.textContent).toContain('已登录');
      expect(authCalls.some((u) => u.includes('/api/auth/session'))).toBe(true);
    });

    it('支持通过 hostBridge.sessionStore 配置并正常生效', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockReturnValue({
          accessToken: 'tok-bridge-sync',
          expiresAt: new Date(Date.now() + 1800_000).toISOString(),
        }),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      recordFetch(async () => httpResponse(200, { user: { id: 'u2' } }));
      m.widget.hostBridge = { sessionStore: mockStore };
      await flushPromises();

      expect(mockStore.loadSession).toHaveBeenCalledTimes(1);
      expect(m.widget.sessionStore).toBe(mockStore);
      expect(accessTokenOf(m.widget)).toBe('tok-bridge-sync');
      expect(m.statusRegion.textContent).toContain('已登录');
    });

    it('loadSession() 返回过期会话时拒绝使用并调用 clearSession()', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue({
          accessToken: 'tok-expired',
          expiresAt: Date.now() - 5_000,
        }),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      m.widget.sessionStore = mockStore;
      await flushPromises();

      expect(mockStore.loadSession).toHaveBeenCalledTimes(1);
      expect(mockStore.clearSession).toHaveBeenCalledTimes(1);
      expect(accessTokenOf(m.widget)).toBeNull();
      expect(m.statusRegion.textContent).not.toContain('已登录');
    });

    it('loadSession() 返回 null 时静默保持未登录态', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      m.widget.sessionStore = mockStore;
      await flushPromises();

      expect(mockStore.loadSession).toHaveBeenCalledTimes(1);
      expect(mockStore.clearSession).not.toHaveBeenCalled();
      expect(accessTokenOf(m.widget)).toBeNull();
    });

    it('登录成功时调用 sessionStore.saveSession(res.token, res.expiresAt)', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      m.widget.sessionStore = mockStore;
      await flushPromises();

      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/login')) {
            return httpResponse(200, {
              token: 'tok-new-login',
              expiresAt: futureDate,
              user: { id: 'u1', username: 'tester', displayName: 'Tester' },
              capabilities: { maxImages: 3 },
            });
          }
          return sessionResponse();
        }),
      );

      setTextarea(m, '需登录后保存');
      m.submitBtn.click();
      await flushPromises();
      submitLoginForm(m, 'tester', 'password123');
      await flushPromises();

      expect(mockStore.saveSession).toHaveBeenCalledWith({
        accessToken: 'tok-new-login',
        expiresAt: futureDate,
      });
      expect(accessTokenOf(m.widget)).toBe('tok-new-login');
    });

    it('注销 / dropSession() 时调用 sessionStore.clearSession()', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      m.widget.sessionStore = mockStore;
      recordFetch(async () => sessionResponse());
      m.widget.adoptSession({ accessToken: 'tok-current', expiresAt: Date.now() + 600_000 });
      await flushPromises();

      m.widget.dropSession();
      await flushPromises();

      expect(mockStore.clearSession).toHaveBeenCalledTimes(1);
      expect(accessTokenOf(m.widget)).toBeNull();
      expect(m.statusRegion.textContent).toContain('需要登录');
    });

    it('提交遇到 401 令牌失效时调用 sessionStore.clearSession()', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      const m = mount();
      m.widget.sessionStore = mockStore;
      recordFetch(async (url) => {
        if (url.includes('/api/feedback')) return httpResponse(401, apiError(401, 'unauthorized', 'Token invalid'));
        return sessionResponse();
      });

      m.widget.adoptSession({ accessToken: 'tok-stale', expiresAt: Date.now() + 600_000 });
      await flushPromises();

      setTextarea(m, '401 清除会话测试');
      m.submitBtn.click();
      await flushPromises();

      expect(mockStore.clearSession).toHaveBeenCalledTimes(1);
      expect(accessTokenOf(m.widget)).toBeNull();
      expect(m.statusRegion.textContent).toContain('需要登录');
    });

    it('额度刷新遇到 401 令牌失效时调用 sessionStore.clearSession()', async () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockResolvedValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/auth/session')) {
            return httpResponse(401, apiError(401, 'unauthorized', 'Session expired'));
          }
          return httpResponse(200, {});
        }),
      );
      const m = mount();
      m.widget.sessionStore = mockStore;
      m.widget.adoptSession({ accessToken: 'tok-refresh-401', expiresAt: Date.now() + 600_000 });
      await flushPromises();

      expect(mockStore.clearSession).toHaveBeenCalledTimes(1);
      expect(accessTokenOf(m.widget)).toBeNull();
      expect(m.statusRegion.textContent).toContain('登录已过期');
    });
  });

  describe('面板打开 / 关闭事件与宿主回调', () => {
    it('打开面板触发 feedback-panel-open 事件与 hostBridge.onPanelOpen 回调', async () => {
      const m = mount({ 'page-label': 'settings/security' });
      const onPanelOpen = vi.fn();
      const onPanelClose = vi.fn();
      m.widget.hostBridge = { onPanelOpen, onPanelClose };

      let eventDetail: unknown = null;
      m.widget.addEventListener('feedback-panel-open', (ev) => {
        eventDetail = (ev as CustomEvent).detail;
      });

      expect(m.widget.isOpen).toBe(false);
      m.widget.open();

      expect(m.widget.isOpen).toBe(true);
      expect(onPanelOpen).toHaveBeenCalledTimes(1);
      expect(onPanelOpen).toHaveBeenCalledWith({ page: 'settings/security' });
      expect(eventDetail).toEqual({ page: 'settings/security' });

      // 重复调用 open 为幂等 no-op，不再二次触发
      m.widget.open();
      expect(onPanelOpen).toHaveBeenCalledTimes(1);
    });

    it('关闭面板触发 feedback-panel-close 事件与 hostBridge.onPanelClose 回调', async () => {
      const m = mount();
      const onPanelOpen = vi.fn();
      const onPanelClose = vi.fn();
      m.widget.hostBridge = { onPanelOpen, onPanelClose };

      let closeEventFired = false;
      m.widget.addEventListener('feedback-panel-close', () => {
        closeEventFired = true;
      });

      m.widget.open();
      expect(m.widget.isOpen).toBe(true);

      m.widget.close();
      expect(m.widget.isOpen).toBe(false);
      expect(onPanelClose).toHaveBeenCalledTimes(1);
      expect(closeEventFired).toBe(true);

      // 重复调用 close 为幂等 no-op，不再二次触发
      m.widget.close();
      expect(onPanelClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleBackPressed() 层级退出', () => {
    beforeEach(() => {
      stubCreateElementCanvas(createState());
      vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        const png = await blobToPng(blob);
        return {
          width: png.width,
          height: png.height,
          data: png.data,
          close: () => {},
          getContext: () => null,
        };
      });
      vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => `blob:mock-${(b as Blob).size}`);
    });

    it('无编辑器时：面板打开按返回键关闭面板并返回 true；再次返回返回 false', () => {
      const m = mount();
      m.widget.open();
      expect(m.widget.isOpen).toBe(true);

      const res1 = m.widget.handleBackPressed();
      expect(res1).toBe(true);
      expect(m.widget.isOpen).toBe(false);

      const res2 = m.widget.handleBackPressed();
      expect(res2).toBe(false);
    });

    it('三级层级退出：图片编辑器打开 -> 仅关闭编辑器返回 true (面板保持打开) -> 关闭面板返回 true -> 返回 false', async () => {
      const m = mount();
      m.widget.open();
      expect(m.widget.isOpen).toBe(true);

      // 模拟添加图片并打开编辑器
      const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
      Object.defineProperty(input, 'files', { value: [uniformPng(32, ORANGE)], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settled();

      const editBtn = m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!;
      editBtn.click();
      await settled();

      // 验证编辑器当前处于打开状态
      const editor = m.root.querySelector<HTMLElement>('.fb-editor');
      expect(editor).not.toBeNull();

      // 第 1 次返回：关闭图片编辑器，面板仍保持打开，返回 true
      const back1 = m.widget.handleBackPressed();
      expect(back1).toBe(true);
      expect(m.root.querySelector<HTMLElement>('.fb-editor')).toBeNull();
      expect(m.widget.isOpen).toBe(true);

      // 第 2 次返回：关闭反馈面板，返回 true
      const back2 = m.widget.handleBackPressed();
      expect(back2).toBe(true);
      expect(m.widget.isOpen).toBe(false);

      // 第 3 次返回：均已关闭，返回 false
      const back3 = m.widget.handleBackPressed();
      expect(back3).toBe(false);
    });
  });

  describe('附件保存与外部链接处理', () => {
    it('保存附件触发 feedback-save-attachment 事件与 hostBridge.onSaveAttachment 回调', async () => {
      const m = mount();
      const onSaveAttachment = vi.fn();
      m.widget.hostBridge = { onSaveAttachment };

      let eventReceived: unknown = null;
      m.widget.addEventListener('feedback-save-attachment', (ev) => {
        eventReceived = (ev as CustomEvent).detail;
      });

      const fileInfo = {
        name: 'test-log.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;base64,aGVsbG8=',
      };
      await m.widget.saveAttachment(fileInfo);

      expect(onSaveAttachment).toHaveBeenCalledWith(fileInfo);
      expect(eventReceived).toEqual(fileInfo);
    });

    it('配置 onOpenExternal 时优先调用宿主打开外部链接', () => {
      const m = mount();
      const onOpenExternal = vi.fn();
      m.widget.hostBridge = { onOpenExternal };

      m.widget.openExternal('https://example.com/help');
      expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/help');
    });

    it('未配置 onOpenExternal 时外部链接回退至 window.open', () => {
      const m = mount();
      const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      m.widget.openExternal('https://example.com/privacy');
      expect(windowOpenSpy).toHaveBeenCalledWith('https://example.com/privacy', '_blank', 'noopener,noreferrer');
      windowOpenSpy.mockRestore();
    });
  });

  describe('openFeedback(options) 便捷方法', () => {
    it('openFeedback 支持注入 sessionStore 和 hostBridge', () => {
      const mockStore: FeedbackSessionStore = {
        loadSession: vi.fn().mockReturnValue(null),
        saveSession: vi.fn(),
        clearSession: vi.fn(),
      };
      const onPanelOpen = vi.fn();
      const onPanelClose = vi.fn();

      const widget = openFeedback({
        apiBase: 'http://api.demo:9000',
        appId: 'com.demo.app',
        pageLabel: 'home',
        sessionStore: mockStore,
        hostBridge: { onPanelOpen, onPanelClose },
      });

      expect(widget.sessionStore).toBe(mockStore);
      expect(widget.hostBridge?.onPanelClose).toBe(onPanelClose);
      expect(widget.isOpen).toBe(true);
      expect(onPanelOpen).toHaveBeenCalledWith({ page: 'home' });

      widget.remove();
    });
  });
});
