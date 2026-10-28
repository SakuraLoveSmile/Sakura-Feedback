import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackWidget } from '../src/element';
import { STYLES } from '../src/styles';

const ORB_PROPERTIES = [
  { name: '--fb-orb-breath', syntax: '<number>', inherits: true, initialValue: '0' },
  { name: '--fb-orb-state-scale', syntax: '<number>', inherits: true, initialValue: '1' },
  { name: '--fb-orb-breath-weight', syntax: '<number>', inherits: true, initialValue: '1' },
  { name: '--fb-orb-drag-angle', syntax: '<angle>', inherits: true, initialValue: '0rad' },
  { name: '--fb-orb-stretch-along', syntax: '<number>', inherits: true, initialValue: '1' },
  { name: '--fb-orb-glow-x', syntax: '<length>', inherits: true, initialValue: '0px' },
  { name: '--fb-orb-glow-y', syntax: '<length>', inherits: true, initialValue: '0px' },
] as const;

let tagSequence = 0;

interface OrbMount {
  widget: FeedbackWidget;
  orb: HTMLButtonElement;
  root: ShadowRoot;
}

function installRegisteredProperties(
  implementation: (definition: {
    name: string;
    syntax: string;
    inherits: boolean;
    initialValue: string;
  }) => void = () => {},
): ReturnType<typeof vi.fn> {
  const registerProperty = vi.fn(implementation);
  vi.stubGlobal('CSS', { registerProperty });
  return registerProperty;
}

async function mountFresh(): Promise<OrbMount> {
  vi.resetModules();
  const { FeedbackWidget: FreshFeedbackWidget } = await import('../src/element');
  const tag = `feedback-orb-motion-${++tagSequence}`;
  customElements.define(tag, FreshFeedbackWidget);
  const widget = document.createElement(tag) as FeedbackWidget;
  widget.setAttribute('launcher-mode', 'orb');
  widget.setAttribute('api-base', 'http://api.test:8787');
  widget.setAttribute('app-id', 'com.example.orb-motion');
  document.body.appendChild(widget);
  const root = widget.shadowRoot;
  if (!root) throw new Error('测试实例缺少 open shadow root');
  const orb = root.querySelector<HTMLButtonElement>('.fb-orb');
  if (!orb) throw new Error('测试实例缺少灵感球');
  return { widget, orb, root };
}

function dispatchPointer(
  orb: HTMLButtonElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId = 1,
): boolean {
  return orb.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
}

function drag(orb: HTMLButtonElement, dx: number, dy: number, pointerId = 1): void {
  dispatchPointer(orb, 'pointerdown', 0, 0, pointerId);
  dispatchPointer(orb, 'pointermove', dx, dy, pointerId);
}

function inlineNumber(orb: HTMLButtonElement, property: string): number {
  return Number.parseFloat(orb.style.getPropertyValue(property));
}

function inlineTranslation(orb: HTMLButtonElement): [number, number] {
  const match = /^translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\)$/.exec(orb.style.transform);
  if (!match) throw new Error(`无法解析灵感球平移：${orb.style.transform}`);
  return [Number(match[1]), Number(match[2])];
}

function expectDragInlineCleared(orb: HTMLButtonElement): void {
  expect(orb.style.transform).toBe('');
  expect(orb.style.getPropertyValue('--fb-orb-drag-angle')).toBe('');
  expect(orb.style.getPropertyValue('--fb-orb-stretch-along')).toBe('');
  expect(orb.style.getPropertyValue('--fb-orb-glow-x')).toBe('');
  expect(orb.style.getPropertyValue('--fb-orb-glow-y')).toBe('');
}

function installManualAnimationFrames(): {
  frames: Map<number, FrameRequestCallback>;
  runAll: () => void;
} {
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    frames,
    runAll: () => {
      const current = [...frames.values()];
      frames.clear();
      for (const callback of current) callback(performance.now());
    },
  };
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })) as typeof window.matchMedia,
  );
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('灵感球拖动阈值与向量', () => {
  it('严格 r > 8：8px 不进入拖动且不写 inline，8.01px 才进入', async () => {
    installRegisteredProperties();
    const { orb } = await mountFresh();

    dispatchPointer(orb, 'pointerdown', 10, 10);
    dispatchPointer(orb, 'pointermove', 18, 10);
    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(orb.classList.contains('is-pressed')).toBe(true);
    expectDragInlineCleared(orb);

    dispatchPointer(orb, 'pointermove', 18.01, 10);
    expect(orb.classList.contains('is-dragging')).toBe(true);
    expect(orb.classList.contains('is-pressed')).toBe(false);
    const [inlineX, inlineY] = inlineTranslation(orb);
    expect(inlineX).toBeCloseTo(8.01, 12);
    expect(inlineY).toBeCloseTo(0, 12);
    expect(inlineNumber(orb, '--fb-orb-drag-angle')).toBeCloseTo(0, 12);
  });

  it.each([
    { vector: [80, 0] as const, angle: 0, stretch: 1.04, glow: [-4, 0] as const },
    { vector: [0, 80] as const, angle: Math.PI / 2, stretch: 1.04, glow: [0, -4] as const },
    {
      vector: [60, 80] as const,
      angle: Math.atan2(80, 60),
      stretch: 1.04,
      glow: [-2.4, -3.2] as const,
    },
    { vector: [160, 0] as const, angle: 0, stretch: 1.04, glow: [-4, 0] as const },
  ])(
    '固定向量 ($vector.0,$vector.1) 独立实例写入方向、饱和拉伸与反向 glow',
    async ({ vector, angle, stretch, glow }) => {
      installRegisteredProperties();
      const { orb, widget } = await mountFresh();
      const [dx, dy] = vector;
      const [glowX, glowY] = glow;

      drag(orb, dx, dy);

      expect(orb.classList.contains('is-dragging')).toBe(true);
      expect(orb.style.transform).toBe(`translate3d(${dx}px, ${dy}px, 0)`);
      expect(inlineNumber(orb, '--fb-orb-drag-angle')).toBeCloseTo(angle, 12);
      expect(inlineNumber(orb, '--fb-orb-stretch-along')).toBeCloseTo(stretch, 12);
      expect(inlineNumber(orb, '--fb-orb-glow-x')).toBeCloseTo(glowX, 12);
      expect(inlineNumber(orb, '--fb-orb-glow-y')).toBeCloseTo(glowY, 12);

      widget.remove();
    },
  );
});

describe('灵感球 release 时序', () => {
  it('pointercancel 不捕获：rAF 开始复位，460ms 后移除 release class', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const { widget, orb } = await mountFresh();
    const captureProvider = vi.fn(async () => ({
      blob: new Blob(['unused'], { type: 'image/png' }),
      width: 1,
      height: 1,
    }));
    widget.captureProvider = captureProvider;

    drag(orb, 80, 0);
    dispatchPointer(orb, 'pointercancel', 80, 0);

    expect(captureProvider).not.toHaveBeenCalled();
    expect(orb.classList.contains('is-releasing')).toBe(true);
    expect(orb.classList.contains('is-dragging')).toBe(true);
    expect(orb.style.transform).toBe('translate3d(80px, 0px, 0)');
    expect(raf.frames.size).toBe(1);

    raf.runAll();
    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(orb.classList.contains('is-releasing')).toBe(true);
    expectDragInlineCleared(orb);

    vi.advanceTimersByTime(459);
    expect(orb.classList.contains('is-releasing')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(orb.classList.contains('is-releasing')).toBe(false);
  });

  it('release 后 50ms 重新 pointerdown 会废弃旧回调，不清新 pressed', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const { orb } = await mountFresh();

    drag(orb, 80, 0);
    dispatchPointer(orb, 'pointercancel', 80, 0);
    raf.runAll();
    vi.advanceTimersByTime(50);

    dispatchPointer(orb, 'pointerdown', 20, 20, 2);
    expect(orb.classList.contains('is-pressed')).toBe(true);
    expect(orb.classList.contains('is-releasing')).toBe(false);

    vi.advanceTimersByTime(500);
    expect(orb.classList.contains('is-pressed')).toBe(true);
    expect(orb.classList.contains('is-releasing')).toBe(false);
  });

  it('8px 点击路径只保留 140ms unpress，不进入 release', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const { orb } = await mountFresh();

    dispatchPointer(orb, 'pointerdown', 0, 0);
    dispatchPointer(orb, 'pointermove', 8, 0);
    dispatchPointer(orb, 'pointerup', 8, 0);

    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expect(orb.classList.contains('is-unpressing')).toBe(true);
    expect(raf.frames.size).toBe(0);
    expectDragInlineCleared(orb);

    vi.advanceTimersByTime(139);
    expect(orb.classList.contains('is-unpressing')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(orb.classList.contains('is-unpressing')).toBe(false);
  });

  it('pointerup 同步调用 captureProvider，落点精确四位且隐藏捕获优先清 release', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    const { widget, orb } = await mountFresh();
    const captureProvider = vi.fn(
      (_context: { releasePoint?: { x: number; y: number } }) => new Promise<never>(() => {}),
    );
    widget.captureProvider = captureProvider;

    drag(orb, 80, 0);
    const dispatched = dispatchPointer(orb, 'pointerup', 123.456, 654.321);

    expect(dispatched).toBe(true);
    expect(captureProvider).toHaveBeenCalledTimes(1);
    expect(captureProvider.mock.calls[0]?.[0]?.releasePoint).toEqual({ x: 0.1235, y: 0.8179 });
    expect(orb.style.visibility).toBe('hidden');
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expect(raf.frames.size).toBe(0);
    expectDragInlineCleared(orb);
  });
});

describe('灵感球清理与结构', () => {
  it('cancelCapture 清除待执行 rAF、release timer、class 与 inline', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const { widget, orb } = await mountFresh();

    drag(orb, 80, 0);
    dispatchPointer(orb, 'pointercancel', 80, 0);
    expect(raf.frames.size).toBe(1);
    widget.cancelCapture();
    expect(raf.frames.size).toBe(0);
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(orb);

    drag(orb, 0, 80, 2);
    dispatchPointer(orb, 'pointercancel', 0, 80, 2);
    raf.runAll();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    widget.cancelCapture();
    expect(vi.getTimerCount()).toBe(0);
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(orb);
  });

  it('disconnectedCallback 清除待执行 rAF 或 timer、class 与 inline', async () => {
    vi.useFakeTimers();
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const first = await mountFresh();

    drag(first.orb, 80, 0);
    dispatchPointer(first.orb, 'pointercancel', 80, 0);
    expect(raf.frames.size).toBe(1);
    first.widget.remove();
    expect(raf.frames.size).toBe(0);
    expect(first.orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(first.orb);

    const second = await mountFresh();
    drag(second.orb, 80, 0, 2);
    dispatchPointer(second.orb, 'pointercancel', 80, 0, 2);
    raf.runAll();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    second.widget.remove();
    expect(vi.getTimerCount()).toBe(0);
    expect(second.orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(second.orb);
  });

  it('四层视觉装饰均 aria-hidden，badge 是独立直系子节点', async () => {
    installRegisteredProperties();
    const { orb } = await mountFresh();
    const layerSelectors = ['.fb-orb-bloom', '.fb-orb-glow', '.fb-orb-sweep', '.fb-orb-core'];

    for (const selector of layerSelectors) {
      const layer = orb.querySelector<HTMLElement>(selector);
      expect(layer?.getAttribute('aria-hidden')).toBe('true');
      expect(layer?.parentElement).toBe(orb);
    }
    const badge = orb.querySelector<HTMLElement>('.fb-launcher-badge');
    expect(badge?.parentElement).toBe(orb);
    expect(badge?.getAttribute('aria-hidden')).toBeNull();
    expect(orb.lastElementChild).toBe(badge);
  });
});

describe('焦点环几何', () => {
  it('环节点是独立装饰层：aria-hidden、默认不可见、不吃指针', async () => {
    installRegisteredProperties();
    const { orb } = await mountFresh();
    const ring = orb.querySelector<HTMLElement>('.fb-orb-focus-ring');

    expect(ring).not.toBeNull();
    expect(ring?.parentElement).toBe(orb);
    expect(ring?.getAttribute('aria-hidden')).toBe('true');
    expect(orb.lastElementChild?.classList.contains('fb-launcher-badge')).toBe(true);

    const style = window.getComputedStyle(ring!);
    expect(style.opacity).toBe('0');
    expect(style.pointerEvents).toBe('none');
  });

  it('环不进入随 state scale 缩放 / 方向拉伸的视觉组', async () => {
    installRegisteredProperties();
    const { orb } = await mountFresh();
    const ring = orb.querySelector<HTMLElement>('.fb-orb-focus-ring')!;

    for (const selector of ['.fb-orb-bloom', '.fb-orb-glow', '.fb-orb-sweep', '.fb-orb-core']) {
      expect(ring.matches(selector)).toBe(false);
    }
  });

  it('外径 = 视觉直径 + 8，且 :focus-visible 点亮、不再叠加 outline', () => {
    expect(STYLES).toContain('width: calc(56px * var(--fb-orb-state-scale) + 8px);');
    expect(STYLES).toContain('height: calc(56px * var(--fb-orb-state-scale) + 8px);');
    expect(STYLES).toMatch(/\.fb-orb-focus-ring \{[\s\S]*?box-sizing: border-box;/);
    expect(STYLES).toMatch(/\.fb-orb-focus-ring \{[\s\S]*?border: 2px solid var\(--fb-accent\);/);
    expect(STYLES).toMatch(/\.fb-orb:focus-visible \.fb-orb-focus-ring \{\s*opacity: 1;/);
    expect(STYLES).toMatch(/\.fb-orb:focus-visible \{\s*outline: none;/);
    expect(STYLES).not.toMatch(/\.fb-orb:focus-visible \{\s*outline: 2px/);
    expect(STYLES).not.toMatch(/\.fb-orb-focus-ring \{[^}]*transition:/);
  });
});

describe('模块级 @property 注册与降级', () => {
  it('fresh import 精确注册七项 name/syntax/inherits/initialValue', async () => {
    const registerProperty = installRegisteredProperties();
    vi.resetModules();

    await import('../src/element');

    expect(registerProperty).toHaveBeenCalledTimes(7);
    expect(registerProperty.mock.calls.map(([definition]) => definition)).toEqual(ORB_PROPERTIES);
  });

  it('每次 registerProperty 抛错仍可构建非 fallback 实例', async () => {
    const registerProperty = installRegisteredProperties(() => {
      throw new DOMException('already registered', 'InvalidModificationError');
    });
    const { orb } = await mountFresh();

    expect(registerProperty).toHaveBeenCalledTimes(7);
    expect(orb.classList.contains('fb-orb-properties-unavailable')).toBe(false);
  });

  it('CSS.registerProperty 不可用时挂 fallback；拖动仍 1:1，释放立即清理', async () => {
    vi.stubGlobal('CSS', {});
    const { orb } = await mountFresh();

    expect(orb.classList.contains('fb-orb-properties-unavailable')).toBe(true);
    drag(orb, 80, 0);
    expect(orb.style.transform).toBe('translate3d(80px, 0px, 0)');
    dispatchPointer(orb, 'pointercancel', 80, 0);
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(orb);
  });

  it('reduced-motion 下拖动仍 1:1，释放立即清理且无 release', async () => {
    installRegisteredProperties();
    stubReducedMotion(true);
    const { orb } = await mountFresh();

    drag(orb, 80, 0);
    expect(orb.style.transform).toBe('translate3d(80px, 0px, 0)');
    dispatchPointer(orb, 'pointercancel', 80, 0);
    expect(orb.classList.contains('is-releasing')).toBe(false);
    expectDragInlineCleared(orb);
  });
});
