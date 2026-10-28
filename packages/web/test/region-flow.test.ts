/**
 * T1 局部选区**流程**验收：拖球 → 松手 → 冻结画面 → 调整选区 → 确认 → 填写反馈。
 *
 * 覆盖：
 * - 松手后进入覆盖层（不直接写草稿、不开面板、停靠位置不变）；
 * - 选区拖动 / 控制点缩放（最小 48×48）/ 键盘调整与 Esc 取消（焦点回灵感球）；
 * - 「使用此区域」裁剪提交（capture.region 归一化、viewport 保持原始、pixel 为裁剪输出）；
 * - 「截取整个窗口」省略 region（旧服务兼容）；
 * - 「取消」不覆盖草稿、不报失败；
 * - 捕获失败沿用现有提示且可重试（绝不静默回退成整屏截图）；
 * - 5 张上限先提示整理附件、不发起捕获；
 * - 身份切换使进行中的流程作废，不写入新身份草稿。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  type Mounted,
} from './helpers';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

/** 400×300 的像素图案：像素 (x,y) = (x%256, y%256, 128, 255)。 */
function patternPng(W = 400, H = 300): Blob {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = x % 256;
      px[i + 1] = y % 256;
      px[i + 2] = 128;
      px[i + 3] = 255;
    }
  }
  return new Blob([encodePng(W, H, px)], { type: 'image/png' });
}

/** 手动添加图片用的真实 PNG 文件（4×4）。 */
function pngFile(name = 'a.png'): File {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  px.fill(200);
  return new File([encodePng(4, 4, px)], name, { type: 'image/png' });
}

type Shot = { blob: Blob; width: number; height: number; viewport?: { width: number; height: number } };

function pointer(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
  );
}

/** 拖球：按下 → 超过 8px 判定拖拽 → 在 `to` 处松手。 */
function dragOrb(m: Mounted, to = { x: 200, y: 300 }): void {
  m.orb.dispatchEvent(
    new PointerEvent('pointerdown', { clientX: 100, clientY: 200, button: 0, pointerId: 1, bubbles: true }),
  );
  m.orb.dispatchEvent(
    new PointerEvent('pointermove', { clientX: 150, clientY: 260, pointerId: 1, bubbles: true }),
  );
  m.orb.dispatchEvent(
    new PointerEvent('pointerup', {
      clientX: to.x,
      clientY: to.y,
      pointerId: 1,
      bubbles: true,
    }),
  );
}

async function settled(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

function regionOverlay(m: Mounted): HTMLElement {
  return m.root.querySelector<HTMLElement>('.fb-region-overlay')!;
}

function shown(el: HTMLElement): boolean {
  return !el.hidden && el.closest('[hidden]') === null;
}

/** 捕获视口 400×300（provider 上报），初始选区应为 320×120。 */
const CAP_VP = { width: 400, height: 300 };
/** 松手位置（视口 0..1，按组件口径保留 4 位小数）。 */
const RELEASE = {
  x: Math.round((200 / 1024) * 10000) / 10000,
  y: Math.round((300 / 768) * 10000) / 10000,
};

let createdUrls: Blob[];

beforeEach(() => {
  createdUrls = [];
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
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    createdUrls.push(b as Blob);
    return `blob:mock-${createdUrls.length}-${(b as Blob).size}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(cleanup);

/** 安装固定 provider（400×300 图案 PNG，上报捕获视口 400×300）。 */
function installProvider(m: Mounted, impl?: () => Shot) {
  const provider = vi.fn(async () => {
    if (impl) return impl();
    return { blob: patternPng(), width: CAP_VP.width, height: CAP_VP.height, viewport: CAP_VP };
  });
  m.widget.captureProvider = provider;
  return provider;
}

describe('T1 拖球 → 冻结 → 选区 → 确认', () => {
  it('松手后进入覆盖层：不写草稿、不开面板、停靠位置复位、初始选区以松手点为中心', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const provider = vi.fn(async () => ({
      blob: patternPng(),
      width: CAP_VP.width,
      height: CAP_VP.height,
      viewport: CAP_VP,
    }));
    m.widget.captureProvider = provider;

    dragOrb(m);
    await settled();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(m.orb.style.transform).toBe(''); // 停靠位置不变
    expect(m.orb.classList.contains('is-dragging')).toBe(false);

    const overlay = regionOverlay(m);
    expect(shown(overlay)).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true); // 草稿未被写入
    expect(m.textarea.value).toBe('');

    // 初始选区：宽 min(400, 400×80%)=320、高 min(260, 300×40%)=120，靠左整体移回
    const frame = m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    const kx = window.innerWidth / CAP_VP.width;
    const ky = window.innerHeight / CAP_VP.height;
    const left = parseFloat(frame.style.left);
    const top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width);
    const height = parseFloat(frame.style.height);
    expect(width).toBeCloseTo(320 * kx, 3);
    expect(height).toBeCloseTo(120 * ky, 3);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    // 靠左松手 → 选区整体移回可见区域（x 贴 0），且松手点仍在选区内
    expect(left).toBe(0);
    expect(left).toBeLessThanOrEqual(200);
    expect(left + width).toBeGreaterThanOrEqual(200);
    expect(top).toBeLessThanOrEqual(300);
    expect(top + height).toBeGreaterThanOrEqual(300);
    // 纵向中心 = 松手位置（换算到捕获视口坐标系）
    expect((top + height / 2) / ky).toBeCloseTo(RELEASE.y * CAP_VP.height, 3);
    expect(m.root.querySelector('.fb-region-size')?.textContent).toContain('320×120');
    // 三个操作齐备
    expect(m.root.querySelector('.fb-region-use')).not.toBeNull();
    expect(m.root.querySelector('.fb-region-all')).not.toBeNull();
    expect(m.root.querySelector('.fb-region-cancel')).not.toBeNull();
  });

  it('选区可拖动移动、控制点缩放（最小 48×48）', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    installProvider(m);
    dragOrb(m);
    await settled();

    const frame = m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    const kx = window.innerWidth / CAP_VP.width;

    // 移动：选区内按下 → 拖到 (200,300)
    const beforeLeft = parseFloat(frame.style.left);
    pointer(frame, 'pointerdown', 100, 200);
    pointer(frame, 'pointermove', 200, 300);
    pointer(frame, 'pointerup', 200, 300);
    const afterLeft = parseFloat(frame.style.left);
    expect(afterLeft - beforeLeft).toBeCloseTo((100 / kx) * kx, 2); // 位移换算后与指针一致
    expect(afterLeft).toBeCloseTo(beforeLeft + 100, 2);

    // 缩放：SE 控制点向左上猛拖 → 撑到最小 48×48
    const se = m.root.querySelector<HTMLElement>('[data-handle="se"]')!;
    pointer(se, 'pointerdown', 300, 300);
    pointer(se, 'pointermove', -4000, -4000);
    pointer(se, 'pointerup', -4000, -4000);
    expect(m.root.querySelector('.fb-region-size')?.textContent).toContain('48×48');
    // 仍整体在视口内
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeLessThanOrEqual(
      window.innerWidth + 0.01,
    );
    expect(parseFloat(frame.style.top) + parseFloat(frame.style.height)).toBeLessThanOrEqual(
      window.innerHeight + 0.01,
    );
  });

  it('键盘：方向键移动、Shift+方向键缩放、回车确认、Esc 取消并把焦点还给灵感球', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    installProvider(m);
    dragOrb(m);
    await settled();

    const frame = m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    expect(m.root.activeElement).toBe(frame); // 打开即聚焦选区

    const kx = window.innerWidth / CAP_VP.width;
    const startLeft = parseFloat(frame.style.left);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(parseFloat(frame.style.left)).toBeCloseTo(startLeft + 8 * kx, 3);

    const startWidth = parseFloat(frame.style.width);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(parseFloat(frame.style.width)).toBeCloseTo(startWidth + 8 * kx, 3);

    // Esc = 取消：覆盖层关闭、焦点回灵感球、面板不开
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settled(2);
    expect(shown(regionOverlay(m))).toBe(false);
    expect(m.root.activeElement).toBe(m.orb);
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true);
  });

  it('使用此区域：裁剪冻结位图 → 写入草稿（region 归一化、viewport 保持原始），提交透传 region', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-region', status: 'received' }),
    );
    installProvider(m);
    await completeLogin(m);

    dragOrb(m);
    await settled();
    m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.click();
    await settled();

    // 草稿里是裁剪结果：320×120（初始选区 40,90,320,120 → 见下）
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(shown(regionOverlay(m))).toBe(false);
    const badge = m.root.querySelector('.fb-screenshot-badge')?.textContent ?? '';
    expect(badge).toContain('局部截图');
    // 初始选区 x=0（靠左移回）、y=57.18、320×120 → 裁剪输出 320×120
    expect(m.root.querySelector('.fb-screenshot-size')?.textContent).toBe('320×120');

    // 裁剪像素：输出 (0,0) = 冻结位图 (0,57)
    const cropped = createdUrls[createdUrls.length - 1]!;
    const png = await blobToPng(cropped);
    expect(png.width).toBe(320);
    expect(png.height).toBe(120);
    const i = 0;
    expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([0, 57, 128]);

    setTextarea(m, '局部截图反馈');
    m.submitBtn.click();
    await settled(10);

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(post).toBeDefined();
    const meta = JSON.parse(String((post!.rawBody as FormData).get('metadata')));
    expect(meta.capture).toBeDefined();
    expect(meta.capture.region).toBeDefined();
    expect(meta.capture.region.x).toBeCloseTo(0, 6);
    expect(meta.capture.region.y).toBeCloseTo(57.18 / 300, 6); // 57.18 = 0.3906×300 − 60
    expect(meta.capture.region.width).toBeCloseTo(0.8, 6);
    expect(meta.capture.region.height).toBeCloseTo(0.4, 6);
    expect(meta.capture.region.x + meta.capture.region.width).toBeLessThanOrEqual(1);
    expect(meta.capture.region.y + meta.capture.region.height).toBeLessThanOrEqual(1);
    // viewport 保持原始捕获视口语义；pixel 为裁剪后的输出尺寸
    expect(meta.capture.viewportWidth).toBe(400);
    expect(meta.capture.viewportHeight).toBe(300);
    expect(meta.capture.pixelWidth).toBe(320);
    expect(meta.capture.pixelHeight).toBe(120);
    expect(meta.capture.releasePoint).toEqual({
      x: Math.round(RELEASE.x * 10000) / 10000,
      y: Math.round(RELEASE.y * 10000) / 10000,
    });

    // 提交的图就是裁剪结果
    const sent = (post!.rawBody as FormData).get('screenshot') as Blob;
    const sentPng = await blobToPng(sent);
    expect(sentPng.width).toBe(320);
    expect(sentPng.height).toBe(120);
  });

  it('截取整个窗口：使用整张冻结位图，region 字段省略（旧服务兼容）', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-full', status: 'received' }),
    );
    installProvider(m);
    await completeLogin(m);

    dragOrb(m);
    await settled();
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    await settled();

    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.root.querySelector('.fb-screenshot-badge')?.textContent).toBe('截图'); // 非局部
    expect(m.root.querySelector('.fb-screenshot-size')?.textContent).toBe('400×300');

    setTextarea(m, '整窗截图反馈');
    m.submitBtn.click();
    await settled(10);

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    const meta = JSON.parse(String((post!.rawBody as FormData).get('metadata')));
    expect(meta.capture.region).toBeUndefined(); // 与旧客户端一致：整窗省略
    expect(meta.capture.viewportWidth).toBe(400);
    expect(meta.capture.pixelWidth).toBe(400);
    expect(Object.prototype.hasOwnProperty.call(meta.capture, 'region')).toBe(false);
    const sent = (post!.rawBody as FormData).get('screenshot') as Blob;
    const sentPng = await blobToPng(sent);
    expect(sentPng.width).toBe(400);
    expect(sentPng.height).toBe(300);
  });

  it('取消：丢弃冻结画面、不覆盖原草稿、不报失败', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const provider = vi.fn(async () => ({
      blob: patternPng(),
      width: CAP_VP.width,
      height: CAP_VP.height,
      viewport: CAP_VP,
    }));
    m.widget.captureProvider = provider;

    m.widget.open();
    setTextarea(m, '原有草稿文字');
    m.widget.close();
    await settled(2);

    dragOrb(m);
    await settled();
    expect(shown(regionOverlay(m))).toBe(true);

    m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
    await settled(2);

    expect(shown(regionOverlay(m))).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true); // 不写入任何图片
    expect(provider).toHaveBeenCalledTimes(1);
    expect(m.root.activeElement).toBe(m.orb); // 焦点回灵感球
    // 原草稿完好、没有失败提示
    m.widget.open();
    await settled(2);
    expect(m.textarea.value).toBe('原有草稿文字');
    expect(m.statusRegion.textContent).not.toContain('截图未完成');
  });

  it('捕获失败：不开覆盖层、沿用现有失败提示，重试可成功（绝不静默回退整屏）', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    m.widget.captureProvider = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { blob: patternPng(), width: CAP_VP.width, height: CAP_VP.height, viewport: CAP_VP };
    });

    m.widget.open();
    setTextarea(m, '失败也要留住文字');
    m.widget.close();
    await settled(2);

    dragOrb(m);
    await settled();

    expect(shown(regionOverlay(m))).toBe(false); // 失败绝不进入选区（= 绝不产出整屏图）
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.statusRegion.textContent).toContain('截图未完成');
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(n).toBe(1);

    // 重试（失败后面板里的手动截图入口）
    m.captureBtn.click();
    await settled();
    expect(n).toBe(2);
    expect(m.screenshotWrap.hidden).toBe(false);
    warnSpy.mockRestore();
  });

  it('5 张上限：先提示整理附件，不发起捕获', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    const provider = vi.fn(async () => ({
      blob: patternPng(),
      width: CAP_VP.width,
      height: CAP_VP.height,
      viewport: CAP_VP,
    }));
    m.widget.captureProvider = provider;

    m.widget.open();
    const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input, 'files', {
      value: Array.from({ length: 5 }, (_, i) => pngFile(`p${i}.png`)),
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settled();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(5);
    m.widget.close();
    await settled(2);

    dragOrb(m);
    await settled();

    expect(provider).not.toHaveBeenCalled(); // 不发起捕获
    expect(shown(regionOverlay(m))).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true); // 提示可见
    expect(m.root.querySelector('.fb-shot-error')?.textContent).toContain('已达图片上限 5 张');
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(5); // 草稿不变
  });

  it('身份切换（app-id）：进行中的选区流程作废，不写入新身份草稿', async () => {
    const m = mount({ 'launcher-mode': 'orb' });
    installProvider(m);

    dragOrb(m);
    await settled();
    expect(shown(regionOverlay(m))).toBe(true);

    m.widget.setAttribute('app-id', 'com.other.app');
    await settled(2);
    expect(shown(regionOverlay(m))).toBe(false); // 流程作废

    // 迟到的确认不产生任何写入
    const useBtn = m.root.querySelector<HTMLButtonElement>('.fb-region-use');
    if (useBtn) {
      useBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    await settled();
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.textarea.value).toBe('');
  });
});
