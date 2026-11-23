/**
 * 0.13 桌面唤醒：⌥/Alt + 拖拽直接框出选区，Alt+点击按普通唤醒处理。
 * 覆盖：选区几何等于拖拽矩形（视口换算 + 48px 最小边）、精细指针门槛、
 * wake-shortcut=off 的连带关闭、交互起点排除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { cleanup, mountRaw, type Mounted } from './helpers';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

const CAP_VP = { width: 400, height: 300 };

function patternPng(W = 400, H = 300): Blob {
  const px = new Uint8ClampedArray(W * H * 4);
  px.fill(180);
  return new Blob([encodePng(W, H, px)], { type: 'image/png' });
}

function stubInput(fine: boolean, touch = false): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(pointer: fine)'
      ? fine
      : media === '(prefers-reduced-motion: reduce)'
        ? true
        : media === '(any-pointer: coarse)'
          ? touch && !fine
          : false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: touch ? 5 : 0 });
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Win32' });
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ authenticated: false, capabilities: {} }),
    text: async () => '',
    blob: async () => new Blob(),
  })));
}

function installProvider(m: Mounted) {
  const provider = vi.fn(async () => ({
    blob: patternPng(),
    width: CAP_VP.width,
    height: CAP_VP.height,
    viewport: CAP_VP,
  }));
  m.widget.captureProvider = provider;
  return provider;
}

function altPointer(target: EventTarget, type: string, x: number, y: number): PointerEvent {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    altKey: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(ev);
  return ev;
}

function overlay(m: Mounted): HTMLElement {
  return m.root.querySelector<HTMLElement>('.fb-region-overlay')!;
}

function selectionSize(m: Mounted): string {
  return m.root.querySelector<HTMLElement>('.fb-region-frame')?.dataset.size ?? '';
}

beforeEach(() => {
  stubFetch();
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob);
    return { width: png.width, height: png.height, data: png.data, close: () => {}, getContext: () => null };
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:alt-drag');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: 0 });
});

describe('⌥/Alt + 拖拽', () => {
  it('拖出矩形后直接得到该选区（视口换算，含 48px 最小边）', async () => {
    stubInput(true);
    const host = document.createElement('div');
    host.textContent = '宿主页面内容';
    document.body.append(host);
    const m = mountRaw({ 'capture-mode': 'viewport' });
    const provider = installProvider(m);

    altPointer(host, 'pointerdown', 100, 100);
    altPointer(document, 'pointermove', 300, 240);
    altPointer(document, 'pointerup', 300, 240);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(overlay(m).hidden).toBe(false);
    // 200×140 客户端像素 → 视口 400×300：78×55（四舍五入）。
    const parts = selectionSize(m).split('×').map(Number);
    const w = parts[0] ?? 0;
    const h = parts[1] ?? 0;
    expect(Math.abs(w - 78)).toBeLessThanOrEqual(1);
    expect(Math.abs(h - 55)).toBeLessThanOrEqual(1);
  });

  it('拖动不足 8px 视为 Alt+点击：在该点进入圈选', async () => {
    stubInput(true);
    const host = document.createElement('div');
    document.body.append(host);
    const m = mountRaw({ 'capture-mode': 'viewport' });
    const provider = installProvider(m);

    altPointer(host, 'pointerdown', 200, 150);
    altPointer(document, 'pointerup', 201, 151);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(overlay(m).hidden).toBe(false);
    // 减少动态效果下直接进入圈选待命：提示出现、不等画圈。
    const lassoHint = m.root.querySelector<HTMLElement>('.fb-lasso-hint')!;
    expect(lassoHint.hidden).toBe(false);
  });

  it('没有精细指针（纯触屏）时不接管 Alt 拖拽', async () => {
    stubInput(false, true);
    const host = document.createElement('div');
    document.body.append(host);
    const m = mountRaw();
    const provider = installProvider(m);

    altPointer(host, 'pointerdown', 100, 100);
    altPointer(document, 'pointerup', 300, 240);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(provider).not.toHaveBeenCalled();
    expect(overlay(m).hidden).toBe(true);
  });

  it('wake-shortcut=off 同时关闭 Alt 拖拽（宿主自己接管入口）', async () => {
    stubInput(true);
    const host = document.createElement('div');
    document.body.append(host);
    const m = mountRaw({ 'capture-mode': 'viewport', 'wake-shortcut': 'off' });
    const provider = installProvider(m);

    altPointer(host, 'pointerdown', 100, 100);
    altPointer(document, 'pointerup', 300, 240);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(provider).not.toHaveBeenCalled();
  });

  it('capture-mode=off 时不冻结画面，Alt+拖拽只打开面板', async () => {
    stubInput(true);
    const host = document.createElement('div');
    document.body.append(host);
    const m = mountRaw({ 'capture-mode': 'off' });
    const provider = installProvider(m);

    altPointer(host, 'pointerdown', 100, 100);
    altPointer(document, 'pointermove', 300, 240);
    altPointer(document, 'pointerup', 300, 240);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(provider).not.toHaveBeenCalled();
    expect(m.panel.hidden).toBe(false);
    expect(overlay(m).hidden).toBe(true);
  });

  it('从按钮等交互元素起手不接管（避免抢宿主操作）', async () => {
    stubInput(true);
    const button = document.createElement('button');
    button.textContent = '提交';
    document.body.append(button);
    const m = mountRaw({ 'capture-mode': 'viewport' });
    const provider = installProvider(m);

    const down = altPointer(button, 'pointerdown', 100, 100);
    altPointer(document, 'pointerup', 300, 240);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(down.defaultPrevented).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });
});
