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
  // Give the layout-less DOM a real dock center. Reduced motion renders the last move at `to`.
  vi.spyOn(m.orb,'getBoundingClientRect').mockReturnValue(new DOMRect(72,172,56,56));
  m.orb.dispatchEvent(
    new PointerEvent('pointerdown', { isPrimary: true, clientX: 100, clientY: 200, button: 0, pointerId: 1, bubbles: true }),
  );
  m.orb.dispatchEvent(
    new PointerEvent('pointermove', { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true }),
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

/** 捕获视口 400×300（provider 上报），R4初始选区为144×144，minimum仍48。 */
const CAP_VP = { width: 400, height: 300 };
/** 松手位置（视口 0..1，按组件口径保留 4 位小数）。 */
const RELEASE = {
  x: Math.round((200 / 1024) * 10000) / 10000,
  y: Math.round((300 / 768) * 10000) / 10000,
};

let createdUrls: Blob[];

beforeEach(() => {
  // These existing business/crop tests use the supported reduced-motion path.
  // The full 400/1500ms timeline is covered independently below.
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(prefers-reduced-motion: reduce)', media, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
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
  it('松手后进入覆盖层：不写草稿、不开面板、停靠位置复位、144px初始选区以可见球心为中心', async () => {
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

    // R4 uses the visible center without the provider releasePoint's four-decimal rounding.
    const frame = m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    const kx = window.innerWidth / CAP_VP.width;
    const ky = window.innerHeight / CAP_VP.height;
    const left = parseFloat(frame.style.left);
    const top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width);
    const height = parseFloat(frame.style.height);
    expect(width).toBeCloseTo(144 * kx, 3);
    expect(height).toBeCloseTo(144 * ky, 3);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({releasePoint:RELEASE}));
    expect(left + width/2).toBeCloseTo(200,3);
    expect(left).toBeLessThanOrEqual(200);
    expect(left + width).toBeGreaterThanOrEqual(200);
    expect(top).toBeLessThanOrEqual(300);
    expect(top + height).toBeGreaterThanOrEqual(300);
    expect(top + height/2).toBeCloseTo(300,3);
    expect(m.root.querySelector('.fb-region-frame')?.getAttribute('data-size')).toBe('144×144');
    expect(m.root.querySelectorAll('.fb-region-handle')).toHaveLength(4);
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
    expect(frame.dataset.size).toBe('48×48');
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
    expect(parseFloat(frame.style.left)).toBeCloseTo(startLeft + 6 * kx, 3);

    const startWidth = parseFloat(frame.style.width);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(parseFloat(frame.style.width)).toBeCloseTo(startWidth + 6 * kx, 3);

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

    // R4 changes the seed to144px; metadata still describes the original capture viewport.
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(shown(regionOverlay(m))).toBe(false);
    const badge = m.root.querySelector('.fb-screenshot-badge')?.textContent ?? '';
    expect(badge).toContain('局部截图');
    // 可见球心(200,300)换算到400×300：选区(6.125,45.1875,144,144)。
    expect(m.root.querySelector('.fb-screenshot-size')?.textContent).toBe('144×144');

    // 裁剪像素：输出 (0,0) = 冻结位图 (6,45)
    const cropped = createdUrls[createdUrls.length - 1]!;
    const png = await blobToPng(cropped);
    expect(png.width).toBe(144);
    expect(png.height).toBe(144);
    const i = 0;
    expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([6, 45, 128]);

    setTextarea(m, '局部截图反馈');
    m.submitBtn.click();
    await settled(10);

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(post).toBeDefined();
    const meta = JSON.parse(String((post!.rawBody as FormData).get('metadata')));
    expect(meta.capture).toBeDefined();
    expect(meta.capture.region).toBeDefined();
    expect(meta.capture.region.x).toBeCloseTo(.015312, 6);
    expect(meta.capture.region.y).toBeCloseTo(.150625, 6);
    expect(meta.capture.region.width).toBeCloseTo(144/400, 6);
    expect(meta.capture.region.height).toBeCloseTo(144/300, 6);
    expect(meta.capture.region.x + meta.capture.region.width).toBeLessThanOrEqual(1);
    expect(meta.capture.region.y + meta.capture.region.height).toBeLessThanOrEqual(1);
    // viewport 保持原始捕获视口语义；pixel 为裁剪后的输出尺寸
    expect(meta.capture.viewportWidth).toBe(400);
    expect(meta.capture.viewportHeight).toBe(300);
    expect(meta.capture.pixelWidth).toBe(144);
    expect(meta.capture.pixelHeight).toBe(144);
    expect(meta.capture.releasePoint).toEqual({
      x: Math.round(RELEASE.x * 10000) / 10000,
      y: Math.round(RELEASE.y * 10000) / 10000,
    });

    // 提交的图就是裁剪结果
    const sent = (post!.rawBody as FormData).get('screenshot') as Blob;
    const sentPng = await blobToPng(sent);
    expect(sentPng.width).toBe(144);
    expect(sentPng.height).toBe(144);
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

function animationClock() {
  let now = 0, id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback => { frames.set(++id,callback); return id; });
  vi.spyOn(window,'cancelAnimationFrame').mockImplementation(key => { frames.delete(key); });
  vi.stubGlobal('matchMedia',(media:string) => ({matches:false,media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  return { frames, advance(time:number) { now=time; }, tick(time:number) { now=time; const batch=[...frames.values()]; frames.clear(); for (const callback of batch) callback(now); } };
}

interface AttachmentGeometry {
  panel: {x:number;y:number;width:number;height:number};
  body: {x:number;y:number;width:number;height:number};
  footer: {x:number;y:number;width:number;height:number};
  frame: {x:number;y:number;width:number;height:number};
  firstFrame?: {x:number;y:number;width:number;height:number};
}

function attachmentGeometry(overrides:Partial<AttachmentGeometry>={}) {
  const layout:AttachmentGeometry={
    panel:{x:0,y:0,width:400,height:300},
    body:{x:0,y:70,width:400,height:230},
    footer:{x:0,y:250,width:400,height:50},
    frame:{x:205,y:170,width:72,height:72},
    ...overrides,
  };
  const original=HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement) {
    let rect:AttachmentGeometry['frame']|undefined;
    if(this.matches('.fb-panel')) rect=layout.panel;
    else if(this.matches('.fb-body')) rect=layout.body;
    else if(this.matches('.fb-footer')) rect=layout.footer;
    else if(this.matches('.fb-thumb-frame')) rect=this.closest('.fb-image-cell') ? layout.frame : layout.firstFrame??layout.frame;
    if(!rect) return original.call(this);
    const panel=this.closest<HTMLElement>('.fb-panel');
    const percent=Number(panel?.style.transform.match(/^translateY\(([-\d.]+)%\)$/)?.[1]??0);
    return new DOMRect(rect.x,rect.y+percent/100*layout.panel.height,rect.width,rect.height);
  });
  return layout;
}

describe('液态选区与真实附件的完整时间线', () => {
  it('400ms球转框，1500ms飞入新增的实际附件格、1350ms解锁并最终聚焦', async () => {
    const clock=animationClock();
    vi.spyOn(window,'innerWidth','get').mockReturnValue(400);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(300);
    attachmentGeometry({firstFrame:{x:15,y:170,width:72,height:72}});
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    m.widget.open();
    const input=m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input,'files',{value:[pngFile()],configurable:true});
    input.dispatchEvent(new Event('change')); await settled(); m.widget.close();
    dragOrb(m,{x:200,y:150}); await settled();
    const frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    // No animation frame elapsed during this immediate drag: use the visible 56px ball, not a fabricated 104px snapshot.
    expect(parseFloat(frame.style.width)).toBe(56);
    expect(frame.style.borderRadius).toBe('28px');
    clock.tick(200); expect(parseFloat(frame.style.width)).toBeCloseTo(100,5);
    clock.tick(400); expect(parseFloat(frame.style.width)).toBe(144); expect(frame.style.borderRadius).toBe('12px');
    clock.tick(550);
    expect(m.root.querySelector<HTMLElement>('.fb-region-tools')!.style.opacity).toBe('1');
    m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.click(); await settled();
    expect(m.panel.inert).toBe(true);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box')).toHaveLength(2);
    const target=m.root.querySelector<HTMLElement>('.fb-image-cell')!;
    expect(target.classList.contains('is-entering')).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-screenshot-thumb-box')!.classList.contains('is-entering')).toBe(false);
    expect(m.root.activeElement).not.toBe(m.textarea);
    const fly=m.root.querySelector<HTMLImageElement>('.fb-flying-shot')!;
    const flyingUrl=fly.getAttribute('src');
    expect(fly.hidden).toBe(false);
    clock.tick(550+180); expect(parseFloat(fly.style.width)).toBe(144);
    clock.tick(550+1050); expect(m.panel.style.transform).toBe('translateY(0%)');
    clock.tick(550+1330);
    // R5's horizontal card is much wider: only the real72×72 thumbnail is the flight target.
    expect(parseFloat(fly.style.left)).toBe(205); expect(parseFloat(fly.style.top)).toBe(170);
    expect(parseFloat(fly.style.width)).toBe(72); expect(parseFloat(fly.style.height)).toBe(72);
    expect(m.panel.inert).toBe(true);
    clock.tick(550+1350); expect(m.panel.inert).toBe(false);
    clock.tick(550+1500);
    expect(m.root.activeElement).toBe(m.textarea);
    expect(regionOverlay(m).hidden).toBe(true);
    expect(fly.hasAttribute('src')).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(flyingUrl);
    expect(target.classList.contains('is-entering')).toBe(false);
    expect(clock.frames.size).toBe(0);
  });

  it('R4从最后可见惯性球心向外展开144px，overlay/capture缩放不改provider的真实指针坐标',async()=>{
    const clock=animationClock();
    vi.spyOn(window,'innerWidth','get').mockReturnValue(800);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(600);
    vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(2);
    const m=mount({'launcher-mode':'orb'});
    const provider=installProvider(m,()=>({blob:patternPng(800,600),width:800,height:600,viewport:CAP_VP}));
    vi.spyOn(m.orb,'getBoundingClientRect').mockReturnValue(new DOMRect(172,172,56,56));
    const send=(type:string,x:number,y:number)=>m.orb.dispatchEvent(new PointerEvent(type,{button:0,isPrimary:true,pointerId:9,bubbles:true,clientX:x,clientY:y}));
    send('pointerdown',200,200); send('pointermove',480,360);
    for(let t=16;t<=208;t+=16) clock.tick(t);
    const outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    const firstPoint=(path:string)=>path.match(/^M([\d.e+-]+),([\d.e+-]+)/)!.slice(1).map(Number);
    const before=firstPoint(outline.querySelector('path')!.getAttribute('d')!);
    const expected={x:before[0]!+parseFloat(outline.style.left),y:before[1]!+parseFloat(outline.style.top)};
    const radius=parseFloat(outline.style.width)/3.2;
    const center={x:parseFloat(outline.style.left)+radius*1.6,y:parseFloat(outline.style.top)+radius*1.6};
    expect(Math.hypot(center.x-480,center.y-360)).toBeGreaterThan(1);
    expect(radius).toBeGreaterThan(52); // R2 drag-radius response is carried into the snapshot.
    clock.advance(215); // Release between render frames: capture the last visible radius.
    send('pointerup',480,360); await settled();
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({releasePoint:{x:.6,y:.6}}));
    const entrance=m.root.querySelector('.fb-region-entrance')!;
    const actual=firstPoint(entrance.querySelector('path[stroke]')!.getAttribute('d')!);
    // CSS style serialization rounds subpixel coordinates; compare within 0.0001 logical px.
    expect(actual[0]).toBeCloseTo(expected.x,4); expect(actual[1]).toBeCloseTo(expected.y,4);
    const frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    expect(parseFloat(frame.style.width)).toBeCloseTo(radius*2,4);
    clock.tick(415); // halfway: grow outwards without moving away from the visible center
    expect(parseFloat(frame.style.width)).toBeGreaterThan(radius*2);
    expect(parseFloat(frame.style.width)).toBeLessThan(288);
    expect(parseFloat(frame.style.left)+parseFloat(frame.style.width)/2).toBeCloseTo(center.x,4);
    expect(parseFloat(frame.style.top)+parseFloat(frame.style.height)/2).toBeCloseTo(center.y,4);
    clock.tick(615); // 400ms after release
    expect(parseFloat(frame.style.width)).toBe(288); // 144 capture-logical px × overlay scale 2
    expect(parseFloat(frame.style.height)).toBe(288);
    expect(frame.dataset.size).toBe('144×144');
    expect(parseFloat(frame.style.left)).toBeCloseTo(center.x-144,4);
    expect(parseFloat(frame.style.top)).toBeCloseTo(center.y-144,4);
    m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.click(); await settled();
    const png=await blobToPng(createdUrls.at(-1)!);
    expect(png.width).toBe(288); expect(png.height).toBe(288);
    const x=Math.round((center.x/2-72)*2), y=Math.round((center.y/2-72)*2);
    expect([...png.data.slice(0,4)]).toEqual([x%256,y%256,128,255]);
  });

  it('慢裁剪期间只接收一次确认；选区锁定，取消或身份改变使解码结果失效', async () => {
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    dragOrb(m); await settled();
    let resolve!:(value:unknown)=>void;
    const bitmap=globalThis.createImageBitmap;
    const decode=vi.fn(() => new Promise<ImageBitmap>(r=>{resolve=r as (value:unknown)=>void;}));
    vi.stubGlobal('createImageBitmap',decode);
    const use=m.root.querySelector<HTMLButtonElement>('.fb-region-use')!;
    use.click(); use.dispatchEvent(new MouseEvent('click'));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(decode).toHaveBeenCalledTimes(1);
    expect(use.disabled).toBe(true);
    const frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    const before=frame.style.left;
    pointer(frame,'pointerdown',100,100); pointer(frame,'pointermove',200,200);
    expect(frame.style.left).toBe(before);
    m.widget.setAttribute('app-id','new-owner');
    const image=await bitmap(patternPng()); resolve(image); await settled();
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(regionOverlay(m).hidden).toBe(true);
  });

  it.each(['close','identity','detach','resize'] as const)('交接途中%s清理回调和视觉资源，已提交图片只归原身份', async action => {
    const clock=animationClock(); const m=mount({'launcher-mode':'orb'}); installProvider(m);
    dragOrb(m); await settled(); clock.tick(550);
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    const old=[...clock.frames.values()];
    expect(m.screenshotWrap.hidden).toBe(false);
    if (action==='close') m.widget.close();
    else if (action==='identity') m.widget.setAttribute('app-id','changed');
    else if (action==='detach') m.widget.remove();
    else { vi.spyOn(window,'innerWidth','get').mockReturnValue(window.innerWidth+1); window.dispatchEvent(new Event('resize')); }
    for (const callback of old) callback(2000); clock.tick(2000);
    expect(m.panel.classList.contains('is-handoff')).toBe(false);
    expect(m.panel.inert).toBe(false);
    expect(m.root.querySelector('.fb-flying-shot')!.hasAttribute('src')).toBe(false);
    expect(regionOverlay(m).hidden).toBe(true);
    expect(clock.frames.size).toBe(0);
    if (action==='identity') expect(m.screenshotWrap.hidden).toBe(true);
    else expect(m.screenshotWrap.hidden).toBe(false);
    if (action==='close' || action==='detach') expect(m.root.activeElement).not.toBe(m.textarea);
  });

  it('resize/DPR变化取消旧选区，滚动保持冻结证据与原草稿', async () => {
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    m.widget.open(); setTextarea(m,'已有草稿'); m.widget.close();
    dragOrb(m); await settled();
    const src=m.root.querySelector('.fb-region-bg')!.getAttribute('src');
    window.dispatchEvent(new Event('scroll'));
    expect(m.root.querySelector('.fb-region-bg')!.getAttribute('src')).toBe(src);
    expect(regionOverlay(m).hidden).toBe(false);
    vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(2);
    window.dispatchEvent(new Event('resize'));
    expect(regionOverlay(m).hidden).toBe(true);
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.textarea.value).toBe('已有草稿');
    expect(m.statusRegion.textContent).toContain('重新截图');
  });

  it('裁剪失败保留选区并解除确认锁，重试整窗成功且减弱动画立即聚焦', async () => {
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    dragOrb(m); await settled();
    // A real crop failure after decoding: the isolated canvas cannot supply a 2D context.
    const original=document.createElement.bind(document);
    vi.spyOn(document,'createElement').mockImplementation(((tag:string,options?:ElementCreationOptions) => {
      const node=original(tag,options);
      if(tag==='canvas') (node as HTMLCanvasElement).getContext=(()=>null) as HTMLCanvasElement['getContext'];
      return node;
    }) as typeof document.createElement);
    m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.click(); await settled();
    expect(regionOverlay(m).hidden).toBe(false);
    expect(m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.disabled).toBe(false);
    expect(m.root.querySelector<HTMLElement>('.fb-region-error')!.hidden).toBe(false);
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(m.root.activeElement).toBe(m.textarea);
  });
});

describe('草稿保全与重复开关',()=>{
  it('已有截图重新拖选后取消保留同一附件；确认重拍原位替换ID',async()=>{
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    await m.widget.retakeScreenshot(); await settled();
    const cell=m.root.querySelector<HTMLElement>('.fb-screenshot-thumb-box')!;
    const id=cell.dataset.imageId, src=m.screenshotThumb.src;
    m.widget.close(); dragOrb(m); await settled();
    m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
    expect(cell.dataset.imageId).toBe(id); expect(m.screenshotThumb.src).toBe(src);
    dragOrb(m); await settled();
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    expect(cell.dataset.imageId).toBe(id);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box')).toHaveLength(1);
  });

  it('连续10次进入/取消不累计RAF，冻结URL全部回收，旧回调不干扰新会话',async()=>{
    const clock=animationClock(),m=mount({'launcher-mode':'orb'}); installProvider(m);
    const old:FrameRequestCallback[]=[];
    for(let i=0;i<10;i++) {
      dragOrb(m); await settled();
      const url=m.root.querySelector('.fb-region-bg')!.getAttribute('src');
      old.push(...clock.frames.values());
      m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
      expect(clock.frames.size).toBe(0);
    }
    dragOrb(m); await settled();
    const active=[...clock.frames.keys()];
    for(const callback of old) callback(1000);
    expect([...clock.frames.keys()]).toEqual(active);
    m.widget.close(); expect(clock.frames.size).toBe(0);
    expect(m.screenshotWrap.hidden).toBe(true);
  });

  it('320px粗指针与高窄选区工具区不遮住四角或关闭按钮',async()=>{
    vi.spyOn(window,'innerWidth','get').mockReturnValue(320);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(300);
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(pointer: coarse)' || media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    const m=mount({'launcher-mode':'orb'}); installProvider(m); dragOrb(m); await settled();
    const overlay=regionOverlay(m),frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    pointer(overlay,'pointerdown',130,8); pointer(overlay,'pointermove',178,290); pointer(overlay,'pointerup',178,290);
    const tools=m.root.querySelector<HTMLElement>('.fb-region-tools')!;
    const x=parseFloat(tools.style.left), y=parseFloat(tools.style.top), width=parseFloat(tools.style.width);
    expect(x).toBeGreaterThanOrEqual(16); expect(x+width).toBeLessThanOrEqual(304);
    expect(['left','right']).toContain(tools.dataset.placement);
    const height=132; // Layout-less DOM fallback for this narrow wrapped tool card.
    const l=parseFloat(frame.style.left), t=parseFloat(frame.style.top), r=l+parseFloat(frame.style.width), b=t+parseFloat(frame.style.height);
    for(const corner of [{x:l,y:t},{x:r,y:t},{x:l,y:b},{x:r,y:b}]) {
      const overlaps=x<corner.x+22 && x+width>corner.x-22 && y<corner.y+22 && y+height>corner.y-22;
      expect(overlaps).toBe(false);
    }
    const closeOverlaps=x<304 && x+width>260 && y<60 && y+height>16;
    expect(closeOverlaps).toBe(false);
    expect(x<r && x+width>l && y<b && y+height>t).toBe(false);
  });

  it.each([{y:180,placement:'below'},{y:580,placement:'above'}])('R5工具卡优先$placement，使用主题与44px按钮且离视口至少16px',async({y,placement})=>{
    const m=mount({'launcher-mode':'orb'}); installProvider(m); dragOrb(m); await settled();
    const overlay=regionOverlay(m),frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    pointer(overlay,'pointerdown',450,y); pointer(overlay,'pointermove',594,y+144); pointer(overlay,'pointerup',594,y+144);
    const tools=m.root.querySelector<HTMLElement>('.fb-region-tools')!,css=getComputedStyle(tools);
    expect(tools.dataset.placement).toBe(placement); expect(parseFloat(tools.style.width)).toBe(320);
    expect(parseFloat(tools.style.left)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(tools.style.left)+parseFloat(tools.style.width)).toBeLessThanOrEqual(window.innerWidth-16);
    const cardTop=parseFloat(tools.style.top),selectionTop=parseFloat(frame.style.top),selectionBottom=selectionTop+parseFloat(frame.style.height);
    if(placement==='below') expect(cardTop).toBeGreaterThan(selectionBottom);
    else expect(cardTop+62).toBeLessThan(selectionTop);
    expect(css.padding).toBe('8px'); expect(css.borderRadius).toBe('16px');
    expect(tools.querySelector('.fb-region-size')).toBeNull();
    expect(frame.getAttribute('aria-description')).toBe('选区 56×56 px');
    for(const cls of ['.fb-region-all','.fb-region-use']) expect(getComputedStyle(tools.querySelector(cls)!).minHeight).toBe('44px');
    expect(tools.querySelector('.fb-region-all')!.textContent).toBe('整个窗口');
    expect(tools.querySelector('.fb-region-use')!.textContent).toBe('使用此区域');
  });

  it('R5工具卡尊重非零安全区且不改变R4选区几何',async()=>{
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    const probe=m.root.querySelector<HTMLElement>('.fb-safe-insets')!;
    Object.assign(probe.style,{paddingLeft:'32px',paddingRight:'40px',paddingTop:'48px',paddingBottom:'36px'});
    dragOrb(m,{x:990,y:730}); await settled();
    const tools=m.root.querySelector<HTMLElement>('.fb-region-tools')!,frame=m.root.querySelector<HTMLElement>('.fb-region-frame')!;
    expect(parseFloat(tools.style.left)).toBeGreaterThanOrEqual(32);
    expect(parseFloat(tools.style.left)+parseFloat(tools.style.width)).toBeLessThanOrEqual(984);
    expect(parseFloat(tools.style.top)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(tools.style.top)+62).toBeLessThanOrEqual(732);
    expect(frame.dataset.size).toBe('144×144');
  });

  it('320×120粗指针整屏选区的安全位置仍不遮角点和关闭，按钮保持可滚动到达',async()=>{
    vi.spyOn(window,'innerWidth','get').mockReturnValue(320); vi.spyOn(window,'innerHeight','get').mockReturnValue(120);
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(pointer: coarse)' || media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    const m=mount({'launcher-mode':'orb'}); installProvider(m); dragOrb(m); await settled();
    const overlay=regionOverlay(m); pointer(overlay,'pointerdown',0,0); pointer(overlay,'pointermove',320,120); pointer(overlay,'pointerup',320,120);
    const tools=m.root.querySelector<HTMLElement>('.fb-region-tools')!;
    const x=parseFloat(tools.style.left),y=parseFloat(tools.style.top),w=parseFloat(tools.style.width),h=Math.min(62,parseFloat(tools.style.maxHeight));
    for(const corner of [{x:0,y:0},{x:320,y:0},{x:0,y:120},{x:320,y:120}]) expect(x<corner.x+22 && x+w>corner.x-22 && y<corner.y+22 && y+h>corner.y-22).toBe(false);
    expect(x<304 && x+w>260 && y<60 && y+h>16).toBe(false);
    expect(y+h).toBeLessThanOrEqual(104); expect(getComputedStyle(tools).overflow).toBe('auto');
  });
});


describe('handoff attachment visibility in final compose layout',()=>{
  it.each([
    {name:'partially above the body under the heading',frame:{x:80,y:40,width:80,height:60}},
    {name:'partially behind the sticky footer',frame:{x:80,y:220,width:80,height:60}},
    {name:'outside the viewport',panel:{x:0,y:0,width:400,height:1000},body:{x:0,y:70,width:400,height:930},footer:{x:0,y:950,width:400,height:50},frame:{x:80,y:800,width:80,height:60}},
    {name:'partially outside the viewport',panel:{x:0,y:0,width:400,height:1000},body:{x:0,y:70,width:400,height:930},footer:{x:0,y:950,width:400,height:50},frame:{x:80,y:740,width:80,height:60}},
    {name:'an empty thumbnail rect',frame:{x:80,y:170,width:0,height:60}},
    {name:'an empty compose clipping rect',body:{x:0,y:70,width:400,height:0}},
  ])('$name cancels the flight and shows the committed real attachment',async geometry=>{
    const clock=animationClock(); attachmentGeometry(geometry);
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    dragOrb(m); await settled(); clock.tick(550);
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    const fly=m.root.querySelector<HTMLImageElement>('.fb-flying-shot')!;
    expect(m.screenshotWrap.hidden).toBe(false);
    expect(fly.hidden).toBe(true);
    expect(m.panel.style.getPropertyValue('--fb-attachment-opacity')).toBe('1');
    clock.tick(2050);
    expect(m.root.activeElement).toBe(m.textarea);
  });

  it('entry translation does not invalidate a visible destination; internal scrolling cancels a later clipped destination',async()=>{
    const clock=animationClock(),layout=attachmentGeometry();
    const m=mount({'launcher-mode':'orb'}); installProvider(m);
    dragOrb(m); await settled(); clock.tick(550);
    m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click();
    const fly=m.root.querySelector<HTMLImageElement>('.fb-flying-shot')!;
    expect(fly.hidden).toBe(false);
    // At this point the panel itself is translated 104% below its final position.
    clock.tick(730); expect(fly.hidden).toBe(false);
    layout.frame={...layout.frame,y:40};
    m.root.querySelector('.fb-body')!.dispatchEvent(new Event('scroll'));
    clock.tick(750);
    expect(fly.hidden).toBe(true);
    expect(m.panel.style.getPropertyValue('--fb-attachment-opacity')).toBe('1');
    layout.frame={...layout.frame,y:170}; clock.tick(1000);
    expect(fly.hidden).toBe(true); // A cancelled flight must not restart after scrolling back.
    clock.tick(2050); expect(m.root.activeElement).toBe(m.textarea);
  });
});
