import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import {
  mount,
  cleanup,
  setTextarea,
  completeLogin,
  httpResponse,
} from './helpers';

describe('灵感球与视口截图组件测试', () => {
  beforeEach(() => {
    // Mock URL.createObjectURL and revokeObjectURL in Happy-DOM
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => `blob:mock-${(blob as Blob).size ?? 0}`);
    } else {
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => `blob:mock-${(blob as Blob).size ?? 0}`);
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('launcherMode 与 captureMode 属性及默认值', () => {
    const m = mount();
    expect(m.widget.launcherMode).toBe('tab');
    expect(m.widget.captureMode).toBe('off');

    m.widget.launcherMode = 'orb';
    expect(m.widget.getAttribute('launcher-mode')).toBe('orb');
    expect(m.widget.launcherMode).toBe('orb');

    m.widget.captureMode = 'viewport';
    expect(m.widget.getAttribute('capture-mode')).toBe('viewport');
    expect(m.widget.captureMode).toBe('viewport');

    m.widget.launcherMode = 'tab';
    expect(m.widget.hasAttribute('launcher-mode')).toBe(false);

    m.widget.captureMode = 'off';
    expect(m.widget.hasAttribute('capture-mode')).toBe(false);
  });

  it('灵感球拖拽交互：移动超过 8px 判定为拖拽，松手记录 releasePoint 并执行截图', async () => {
    const m = mount({ 'launcher-mode': 'orb', 'capture-mode': 'viewport' });
    const mockBlob = new Blob(['mock-png-data'], { type: 'image/png' });
    let capturedReleasePoint: { x: number; y: number } | undefined;

    m.widget.captureProvider = vi.fn(async (ctx) => {
      capturedReleasePoint = ctx.releasePoint;
      return { blob: mockBlob, width: 800, height: 600 };
    });

    const orb = m.orb;
    expect(orb).not.toBeNull();

    // 1. Pointerdown
    orb.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 100,
        clientY: 200,
        button: 0,
        pointerId: 1,
        bubbles: true,
      }),
    );

    // 2. Pointermove 小于 8px：不触发拖拽
    orb.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 104,
        clientY: 203,
        pointerId: 1,
        bubbles: true,
      }),
    );
    expect(orb.classList.contains('is-dragging')).toBe(false);

    // 3. Pointermove 超过 8px：触发拖拽
    orb.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 150,
        clientY: 260,
        pointerId: 1,
        bubbles: true,
      }),
    );
    expect(orb.classList.contains('is-dragging')).toBe(true);

    // 4. Pointerup 松手：平滑复位并触发截图打开面板
    orb.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 200,
        clientY: 300,
        pointerId: 1,
        bubbles: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(m.widget.captureProvider).toHaveBeenCalledTimes(1);
    expect(capturedReleasePoint).toBeDefined();
    expect(capturedReleasePoint?.x).toBeGreaterThanOrEqual(0);
    expect(capturedReleasePoint?.y).toBeGreaterThanOrEqual(0);
    expect(m.panel.classList.contains('is-open')).toBe(true);
  });

  it('灵感球点击操作：无拖拽时正常呼出面板', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const orb = m.orb;

    orb.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
        bubbles: true,
      }),
    );
    orb.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        bubbles: true,
      }),
    );

    expect(m.panel.classList.contains('is-open')).toBe(true);
  });

  it('灵感球拖拽取消：pointercancel 或 cancelCapture 复位并不截图', () => {
    const m = mount({ 'launcher-mode': 'orb' });
    m.widget.captureProvider = vi.fn();
    const orb = m.orb;

    orb.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
        bubbles: true,
      }),
    );
    orb.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 150,
        clientY: 150,
        pointerId: 1,
        bubbles: true,
      }),
    );
    expect(orb.classList.contains('is-dragging')).toBe(true);

    orb.dispatchEvent(
      new PointerEvent('pointercancel', {
        pointerId: 1,
        bubbles: true,
      }),
    );
    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(m.widget.captureProvider).not.toHaveBeenCalled();
    expect(m.panel.classList.contains('is-open')).toBe(false);
  });

  it('截图缩略图预览、全屏弹窗、重截与移除', async () => {
    const m = mount();
    const mockBlob1 = new Blob(['png-1'], { type: 'image/png' });
    const mockBlob2 = new Blob(['png-2'], { type: 'image/png' });

    let callCount = 0;
    m.widget.captureProvider = vi.fn(async () => {
      callCount++;
      return { blob: callCount === 1 ? mockBlob1 : mockBlob2, width: 1000, height: 800 };
    });

    // 初始状态无截图
    expect(m.screenshotWrap.hidden).toBe(true);

    // 1. 触发截图
    await m.widget.captureAndOpen();
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.screenshotThumb.src).toContain('blob:mock-');

    // 2. 点击缩略图弹出全屏大图
    expect(m.zoomModal.classList.contains('is-open')).toBe(false);
    const thumbBox = m.root.querySelector<HTMLDivElement>('.fb-screenshot-thumb-box')!;
    thumbBox.click();
    expect(m.zoomModal.classList.contains('is-open')).toBe(true);

    // 按 Esc 关闭大图弹窗，面板保持开启
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.zoomModal.classList.contains('is-open')).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true);

    // 3. 重新截图：输入草稿文字后重截，验证文字得以保留
    setTextarea(m, '用户保留的草稿文字');
    m.retakeBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.textarea.value).toBe('用户保留的草稿文字');
    expect(callCount).toBe(2);

    // 4. 移除截图
    m.removeBtn.click();
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.textarea.value).toBe('用户保留的草稿文字');
  });

  it('带截图时采用 multipart/form-data 提交，成功后清空草稿与截图', async () => {
    let receivedBody: unknown = null;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      receivedBody = init?.body;
      return httpResponse(201, { feedbackId: 'fb-with-screenshot', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const m = mount();
    completeLogin(m);

    // 模拟截图
    const mockBlob = new Blob(['image-bytes-mock'], { type: 'image/png' });
    m.widget.captureProvider = vi.fn(async () => ({
      blob: mockBlob,
      width: 1200,
      height: 900,
    }));
    await m.widget.captureAndOpen();

    setTextarea(m, '这是带截图的反馈建议');

    // 点击提交
    m.submitBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedBody).toBeInstanceOf(FormData);
    const formData = receivedBody as FormData;
    expect(formData.has('metadata')).toBe(true);
    expect(formData.has('screenshot')).toBe(true);

    const meta = JSON.parse(formData.get('metadata') as string);
    expect(meta.text).toBe('这是带截图的反馈建议');
    expect(meta.appId).toBe('com.example.app');
    expect(meta.capture?.viewportWidth).toBe(1200);

    // 成功后草稿与截图均被清空
    expect(m.textarea.value).toBe('');
    expect(m.screenshotWrap.hidden).toBe(true);
  });

  it('带截图提交失败时保留草稿与截图', async () => {
    const fetchMock = vi.fn(async () => {
      return httpResponse(500, { error: { code: 'server_error', message: '服务器异常' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const m = mount();
    completeLogin(m);

    const mockBlob = new Blob(['image-bytes-mock'], { type: 'image/png' });
    m.widget.captureProvider = vi.fn(async () => ({
      blob: mockBlob,
      width: 1200,
      height: 900,
    }));
    await m.widget.captureAndOpen();

    setTextarea(m, '提交失败时保留内容');
    m.submitBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    // 失败保留草稿和截图
    expect(m.textarea.value).toBe('提交失败时保留内容');
    expect(m.screenshotWrap.hidden).toBe(false);
  });
});
