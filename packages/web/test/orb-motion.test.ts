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
  runAll: (milliseconds?: number) => void;
} {
  let nextId = 1;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
    runAll: (milliseconds = 16) => {
      now += milliseconds;
      const current = [...frames.values()];
      frames.clear();
      for (const callback of current) callback(now);
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

// The accepted liquid design replaces the old zero-lag/ellipse/460ms return assertions.
// Gesture cancellation now clears all dynamics; only a successful capture morphs into a selection.
describe('液态球拖动与会话', () => {
  it('严格 >8px 阈值，视觉中心随后以惯性追随，未写旧椭圆参数', async () => {
    installRegisteredProperties();
    const raf = installManualAnimationFrames();
    const { orb } = await mountFresh();
    dispatchPointer(orb,'pointerdown',10,10);
    dispatchPointer(orb,'pointermove',18,10);
    expect(orb.classList.contains('is-dragging')).toBe(false);
    expect(orb.classList.contains('is-pressed')).toBe(true);
    expectDragInlineCleared(orb);
    dispatchPointer(orb,'pointermove',90,10);
    expect(orb.classList.contains('is-dragging')).toBe(true);
    raf.runAll();
    const [x,y] = inlineTranslation(orb);
    expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(80); expect(y).toBe(0);
    expect(orb.style.getPropertyValue('--fb-orb-stretch-along')).toBe('');
    expect(raf.frames.size).toBe(1);
  });

  it('只接收主指针/主按钮，第二指针不能覆盖已在途手势', async () => {
    const { orb } = await mountFresh();
    orb.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:9,isPrimary:false}));
    dispatchPointer(orb,'pointermove',80,0,9);
    expect(orb.classList.contains('is-dragging')).toBe(false);
    orb.dispatchEvent(new PointerEvent('pointerdown',{button:2,pointerId:9,isPrimary:true}));
    expect(orb.classList.contains('is-pressed')).toBe(false);
    dispatchPointer(orb,'pointerdown',0,0,1);
    dispatchPointer(orb,'pointerdown',0,0,2);
    dispatchPointer(orb,'pointermove',80,0,2);
    expect(orb.classList.contains('is-dragging')).toBe(false);
    dispatchPointer(orb,'pointermove',80,0,1);
    expect(orb.classList.contains('is-dragging')).toBe(true);
  });

  it('pointerup 立即调用正式provider，落点来自实际指针而非滞后球心', async () => {
    const raf = installManualAnimationFrames();
    vi.spyOn(window,'innerWidth','get').mockReturnValue(1000);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(800);
    const { widget,orb } = await mountFresh();
    const provider = vi.fn((_ctx: {releasePoint?:{x:number;y:number}}) => new Promise<never>(()=>{}));
    widget.captureProvider = provider;
    drag(orb,80,0); raf.runAll();
    expect(inlineTranslation(orb)[0]).toBeLessThan(80);
    dispatchPointer(orb,'pointerup',123.456,654.321);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0].releasePoint).toEqual({x:.1235,y:.8179});
    expect(orb.style.visibility).toBe('hidden');
    expect(raf.frames.size).toBe(0);
    expectDragInlineCleared(orb);
  });

  it.each(['pointercancel','lostpointercapture','cancelCapture','disconnect','identity'] as const)('%s 清理积分与RAF，旧回调不能影响下一手势', async action => {
    const raf = installManualAnimationFrames();
    const { widget,orb } = await mountFresh();
    const provider = vi.fn(() => new Promise<never>(()=>{})); widget.captureProvider = provider;
    drag(orb,80,0); raf.runAll();
    const stale = [...raf.frames.values()];
    if (action === 'cancelCapture') widget.cancelCapture();
    else if (action === 'disconnect') widget.remove();
    else if (action === 'identity') widget.setAttribute('app-id','another');
    else orb.dispatchEvent(new PointerEvent(action,{pointerId:1,isPrimary:true}));
    expect(raf.frames.size).toBe(0);
    expect(orb.classList.contains('is-dragging')).toBe(false);
    expectDragInlineCleared(orb);
    expect(provider).not.toHaveBeenCalled();
    if (action !== 'disconnect') {
      dispatchPointer(orb,'pointerdown',20,20,2);
      for (const callback of stale) callback(performance.now()+16);
      expect(orb.classList.contains('is-pressed')).toBe(true);
      expectDragInlineCleared(orb);
    }
  });

  it('8px点击保留140ms unpress；不安排液态RAF', async () => {
    vi.useFakeTimers();
    const raf = installManualAnimationFrames();
    const { orb } = await mountFresh();
    drag(orb,8,0); dispatchPointer(orb,'pointerup',8,0);
    expect(orb.classList.contains('is-unpressing')).toBe(true);
    expect(raf.frames.size).toBe(0);
    vi.advanceTimersByTime(140);
    expect(orb.classList.contains('is-unpressing')).toBe(false);
  });

  it('渲染Canvas不抢焦点/指针，原badge与焦点环保留独立节点', async () => {
    const { orb,root } = await mountFresh();
    const canvas = root.querySelector('.fb-orb-lens');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.hasAttribute('tabindex')).toBe(false);
    for (const selector of ['.fb-orb-bloom','.fb-orb-glow','.fb-orb-sweep','.fb-orb-core','.fb-orb-focus-ring']) {
      expect(orb.querySelector(selector)?.getAttribute('aria-hidden')).toBe('true');
      expect(orb.querySelector(selector)?.parentElement).toBe(orb);
    }
    expect(orb.lastElementChild).toBe(orb.querySelector('.fb-launcher-badge'));
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

  it('CSS.registerProperty 不可用时仍保留液态惯性与取消能力', async () => {
    vi.stubGlobal('CSS', {});
    const raf = installManualAnimationFrames();
    const { orb } = await mountFresh();

    expect(orb.classList.contains('fb-orb-properties-unavailable')).toBe(true);
    drag(orb, 80, 0);
    raf.runAll();
    expect(inlineTranslation(orb)[0]).toBeGreaterThan(0);
    expect(inlineTranslation(orb)[0]).toBeLessThan(80);
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
