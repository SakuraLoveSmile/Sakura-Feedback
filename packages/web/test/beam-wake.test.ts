import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { OrbLens } from '../src/orb-lens';
import { APP_ID, cleanup, mountBeam, type Mounted } from './helpers';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

let host: HTMLDivElement;

function provider(m: Mounted) {
  const capture = vi.fn(async () => ({
    blob: new Blob([encodePng(40, 30, new Uint8ClampedArray(40 * 30 * 4))], { type: 'image/png' }),
    width: 40,
    height: 30,
    viewport: { width: 1024, height: 768 },
  }));
  m.widget.captureProvider = capture;
  return capture;
}

function touch(type: string, active: Touch[], changed = active): void {
  host.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: active, changedTouches: changed }));
}
const points = () => [new Touch({ identifier: 1, target: host, clientX: 120, clientY: 200 }), new Touch({ identifier: 2, target: host, clientX: 160, clientY: 200 })];
function hold(): void {
  touch('touchstart', points());
  vi.advanceTimersByTime(700);
  touch('touchend', [], points());
}
const overlay = (m: Mounted) => m.root.querySelector<HTMLElement>('.fb-region-overlay')!;
const frame = (m: Mounted) => m.root.querySelector<HTMLElement>('.fb-region-frame')!;
function wakeOrigin(m: Mounted): number[] {
  return m.root.querySelector<HTMLElement>('.fb-beam')!.style
    .getPropertyValue('--fb-wake-origin').trim().split(/\s+/).map(value => Number.parseFloat(value));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(OrbLens, 'create').mockReturnValue(null);
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => ({ ...(await blobToPng(blob)), close: vi.fn() }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:beam-fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  host = document.createElement('div');
  host.textContent = '宿主页面';
  document.body.append(host);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('beam wake', () => {
  it('two-finger hold arms a frozen lasso surface with the default water ripple and no selection frame', async () => {
    const m = mountBeam();
    const capture = provider(m);
    vi.advanceTimersByTime(5000);
    hold();
    await settle();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(overlay(m).hidden).toBe(false);
    expect(m.root.querySelector('.fb-beam')).not.toBeNull();
    expect(wakeOrigin(m)).toEqual([140, 200]);
    const waves = [...m.root.querySelectorAll<HTMLElement>('.fb-ripple-wave')];
    expect(waves).toHaveLength(2);
    vi.advanceTimersByTime(200);
    const front = waves[1]!;
    const profile = () => front.style.getPropertyValue('--fb-wave-mask');
    const firstProfile = profile();
    const dim = m.root.querySelector<HTMLElement>('.fb-region-dim')!;
    expect(Number(dim.style.opacity)).toBe(0);
    expect(dim.previousElementSibling).toBe(front.parentElement);
    vi.advanceTimersByTime(80);
    expect(profile()).not.toBe(firstProfile);
    expect(Number(front.style.opacity)).toBeGreaterThan(Number(waves[0]!.style.opacity));
    expect(Number(waves[0]!.style.opacity)).toBeGreaterThan(0);
    expect(m.root.querySelector('.fb-wake-spectrum')).toBeNull();
    expect(m.root.querySelector<HTMLElement>('.fb-lasso-hint')!.hidden).toBe(true);
    vi.advanceTimersByTime(280);
    expect(Number(dim.style.opacity)).toBe(0);
    vi.advanceTimersByTime(480);
    expect(Number(dim.style.opacity)).toBe(0);
    expect(frame(m).style.opacity).toBe('0');
    expect(m.root.querySelector<HTMLElement>('.fb-lasso-hint')!.hidden).toBe(false);
    expect(overlay(m).classList.contains('is-lasso-arming')).toBe(false);
    expect(front.isConnected).toBe(true);
    vi.advanceTimersByTime(1150);
    expect(front.isConnected).toBe(false);
  });

  it('aurora grows from both fingertips and leaves a soft edge before lasso', async () => {
    localStorage.setItem(`feedback:wake-visual:v1:${encodeURIComponent(APP_ID)}`, 'aurora');
    const m = mountBeam();
    provider(m);
    vi.advanceTimersByTime(5000);
    hold();
    await settle();
    const halo = m.root.querySelector<HTMLElement>('.fb-wake-spectrum')!;
    expect(wakeOrigin(m)).toEqual([140, 200]);
    expect(m.root.querySelector('.fb-ripple-wave')).toBeNull();
    // 各波面沿原始触点扩张。合并蒙版后，屏幕边缘短暂留光。
    const mask = () => halo.style.getPropertyValue('--fb-wave-mask');
    const radius = () => Number.parseFloat(/circle ([\d.]+)px/.exec(mask())![1]!);
    vi.advanceTimersByTime(100);
    const first = radius();
    vi.advanceTimersByTime(150);
    expect(radius()).toBeGreaterThan(first);
    expect(mask()).toContain('transparent 0%');
    expect(Number(halo.style.opacity)).toBeGreaterThan(.8);
    expect(mask()).toContain('at 120px 200px');
    expect(mask()).toContain('at 160px 200px');
    vi.advanceTimersByTime(200);
    expect(mask()).toContain('ellipse 70% 70%');
    vi.advanceTimersByTime(300);
    expect(m.root.querySelector('.fb-wake-spectrum')).toBeNull();
    expect(m.root.querySelector<HTMLElement>('.fb-lasso-hint')!.hidden).toBe(false);
  });

  it('settings expose the wake visual choice and persist the selection', async () => {
    const m = mountBeam();
    const section = m.root.querySelector<HTMLElement>('section.fb-wake-visual')!;
    expect(section).not.toBeNull();
    expect(section.hidden).toBe(false);
    const aurora = m.root.querySelector<HTMLInputElement>('input[data-wake-visual="aurora"]')!;
    expect(aurora).not.toBeNull();
    aurora.checked = true;
    aurora.dispatchEvent(new Event('change'));
    expect(localStorage.getItem(`feedback:wake-visual:v1:${encodeURIComponent(APP_ID)}`)).toBe('aurora');
    const ripple = m.root.querySelector<HTMLInputElement>('input[data-wake-visual="ripple"]')!;
    expect(ripple.checked).toBe(false);
  });

  it('drawing a loop expands the bbox into a selection frame and hides the hint', async () => {
    const m = mountBeam();
    provider(m);
    vi.advanceTimersByTime(5000);
    hold();
    await settle();
    vi.advanceTimersByTime(760);
    const target = overlay(m);
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true, pointerId: 7, clientX: 100, clientY: 100 }));
    expect(m.root.querySelector('.fb-ripple-wave')).toBeNull();
    for (const [x, y] of [[140, 110], [180, 150], [150, 190], [100, 150]]) {
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, isPrimary: true, pointerId: 7, clientX: x, clientY: y }));
    }
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true, pointerId: 7, clientX: 100, clientY: 150 }));
    await settle();
    expect(frame(m).dataset.size).toBeDefined();
    expect(m.root.querySelector<HTMLElement>('.fb-lasso-hint')!.hidden).toBe(true);
    expect(m.root.querySelector('.fb-lasso')!.getAttribute('points')).toBe('');
    const frozen = m.root.querySelector<HTMLImageElement>('.fb-region-bg')!.src;
    const redraw = m.root.querySelector<HTMLButtonElement>('.fb-region-redraw')!;
    expect(redraw.hidden).toBe(false);
    redraw.click();
    expect(m.root.querySelector<HTMLImageElement>('.fb-region-bg')!.src).toBe(frozen);
    expect(target.classList.contains('is-lasso-pending')).toBe(true);
    expect(frame(m).dataset.size).toBeUndefined();
    expect(m.root.querySelector<HTMLElement>('.fb-lasso-hint')!.hidden).toBe(false);
    expect(m.root.querySelector('.fb-ripple-wave')).toBeNull();
  });

  it.each(['lostpointercapture', 'pointercancel'])('%s restores the undrawn selection surface', async (event) => {
    const m = mountBeam();
    provider(m);
    vi.advanceTimersByTime(5000);
    hold();
    await settle();
    vi.advanceTimersByTime(760);
    const target = overlay(m);
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true, pointerId: 9, clientX: 100, clientY: 100 }));
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, isPrimary: true, pointerId: 9, clientX: 160, clientY: 140 }));
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, clientX: 100, clientY: 180 }));
    const dim = m.root.querySelector<HTMLElement>('.fb-region-dim')!;
    const hint = m.root.querySelector<HTMLElement>('.fb-lasso-hint')!;
    expect(Number(dim.style.opacity)).toBe(0);
    expect(target.classList.contains('is-drawing')).toBe(true);
    expect(hint.hidden).toBe(true);
    target.dispatchEvent(new PointerEvent(event, { bubbles: true, pointerId: 9 }));
    expect(target.classList.contains('is-drawing')).toBe(false);
    expect(hint.hidden).toBe(false);
    await settle();
    expect(frame(m).dataset.size).toBeUndefined();
    expect(m.root.querySelector('.fb-lasso')!.getAttribute('points')).toBe('');
  });

  it('capture-mode=off opens the plain panel without the lasso surface', async () => {
    const m = mountBeam({ 'capture-mode': 'off' });
    const capture = provider(m);
    vi.advanceTimersByTime(5000);
    hold();
    await settle();
    expect(capture).not.toHaveBeenCalled();
    expect(overlay(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
  });

  it('the default primary+shift+F shortcut and the hidden a11y control both trigger the beam', async () => {
    localStorage.setItem(`feedback:wake-visual:v1:${encodeURIComponent(APP_ID)}`, 'aurora');
    const m = mountBeam();
    provider(m);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(overlay(m).hidden).toBe(false);
    const halo = m.root.querySelector<HTMLElement>('.fb-wake-spectrum')!;
    const mask = halo.style.getPropertyValue('--fb-wave-mask');
    expect(mask.match(/radial-gradient\(circle/g)).toHaveLength(1);
    expect(mask).toContain(`at ${window.innerWidth / 2}px ${window.innerHeight / 2}px`);
    m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
    await settle();
    m.root.querySelector<HTMLButtonElement>('.fb-beam-a11y')!.click();
    await settle();
    expect(overlay(m).hidden).toBe(false);
  });
});
