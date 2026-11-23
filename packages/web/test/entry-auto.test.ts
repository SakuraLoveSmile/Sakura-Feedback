/**
 * 0.13 默认入口（launcher-mode=auto）：
 * - 精细指针给贴边入口，只有触屏时保持光束手势；显式模式不受影响；
 * - 首用提示只出现一次；
 * - 设置项与无障碍文案按输入能力分叉；
 * - auto 贴边标签下快捷键仍可用，并在宿主已处理组合键时让路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { APP_ID, cleanup, mountRaw, type Mounted } from './helpers';

const ENTRY_HINT_KEY = 'feedback:entry-hint:v1:' + encodeURIComponent(APP_ID);

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

function mode(m: Mounted): string | undefined {
  return m.widget.dataset.fbMode;
}

function hint(m: Mounted): HTMLElement {
  return m.root.querySelector<HTMLElement>('.fb-entry-hint')!;
}

function openSettings(m: Mounted): void {
  m.widget.open();
  m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: 0 });
});

describe('默认入口按输入能力解析', () => {
  it('精细指针（桌面）默认给贴边标签入口', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    expect(m.widget.launcherMode).toBe('auto');
    expect(mode(m)).toBe('tab');
  });

  it('只有触屏时保持光束唤醒', () => {
    stubInput(false, true);
    const m = mountRaw();
    expect(mode(m)).toBe('beam');
  });

  it('触屏笔记本仍给可见入口，同时保留触摸能力', () => {
    stubInput(true, true);
    const m = mountRaw();
    expect(mode(m)).toBe('tab');
  });

  it('显式 beam / tab / orb 不被能力探测覆盖', () => {
    stubInput(true);
    expect(mode(mountRaw({ 'launcher-mode': 'beam' }))).toBe('beam');
    expect(mode(mountRaw({ 'launcher-mode': 'tab' }))).toBe('tab');
    expect(mode(mountRaw({ 'launcher-mode': 'orb' }))).toBe('orb');
  });

  it('贴边入口点击即可打开面板', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    m.fab.click();
    expect(m.panel.hidden).toBe(false);
  });
});

describe('首次使用提示', () => {
  it('桌面出现一次并记住，再次加载不再出现', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    expect(hint(m).hidden).toBe(true);
    vi.advanceTimersByTime(900);
    expect(hint(m).hidden).toBe(false);
    expect(hint(m).textContent).toContain('Ctrl+Shift+F');
    expect(localStorage.getItem(ENTRY_HINT_KEY)).toBe('seen');

    const again = mountRaw({ 'capture-mode': 'off' });
    vi.advanceTimersByTime(2000);
    expect(hint(again).hidden).toBe(true);
  });

  it('光束模式（没有常驻入口）不提示', () => {
    stubInput(false, true);
    const m = mountRaw();
    vi.advanceTimersByTime(2000);
    expect(hint(m).hidden).toBe(true);
  });

  it('wake-shortcut=off 时提示不出现（没有可见快捷键）', () => {
    stubInput(true);
    localStorage.setItem(ENTRY_HINT_KEY, '');
    const m = mountRaw({ 'capture-mode': 'off', 'wake-shortcut': 'off' });
    vi.advanceTimersByTime(900);
    // 入口仍存在，提示照常出现，只是不写快捷键。
    expect(hint(m).hidden).toBe(false);
    expect(hint(m).textContent).not.toContain('Ctrl');
  });
});

describe('设置与无障碍文案按输入能力分叉', () => {
  it('桌面：入口样式给贴边标签，唤醒方式给鼠标与快捷键', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    openSettings(m);

    const tab = m.root.querySelector<HTMLInputElement>('[data-launcher-style="tab"]')!;
    const beam = m.root.querySelector<HTMLInputElement>('[data-launcher-style="beam"]')!;
    const orb = m.root.querySelector<HTMLInputElement>('[data-launcher-style="orb"]')!;
    expect(tab.checked).toBe(true);
    expect(tab.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(false);
    expect(orb.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(false);
    // 没有触摸输入时不提供光束选项。
    expect(beam.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(true);

    const desktop = m.root.querySelector<HTMLElement>('.fb-wake-desktop')!;
    expect(desktop.hidden).toBe(false);
    expect(desktop.textContent).toContain('按住 Alt 拖拽');
    expect(desktop.textContent).toContain('Ctrl+Shift+F');

    const gesture = m.root.querySelector<HTMLElement>('[data-wake-gesture="two-finger-hold"]')!;
    expect(gesture.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(true);
  });

  it('触屏：手势选项可见，鼠标说明隐藏', () => {
    stubInput(false, true);
    const m = mountRaw();
    openSettings(m);
    const gesture = m.root.querySelector<HTMLElement>('[data-wake-gesture="two-finger-hold"]')!;
    expect(gesture.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(false);
    expect(m.root.querySelector<HTMLElement>('.fb-wake-desktop')?.hidden).toBe(true);
    const beam = m.root.querySelector<HTMLInputElement>('[data-launcher-style="beam"]')!;
    expect(beam.closest<HTMLElement>('.fb-wake-option')?.hidden).toBe(false);
  });

  it('无障碍入口说明不再对桌面用户念「双指长按」', () => {
    stubInput(true);
    const desktop = mountRaw();
    const desktopLabel = desktop.root.querySelector('.fb-beam-a11y')?.getAttribute('aria-label') ?? '';
    expect(desktopLabel).toContain('Alt 拖拽');
    expect(desktopLabel).toContain('Ctrl+Shift+F');
    expect(desktopLabel).not.toContain('双指长按');
    cleanup();
    stubInput(false, true);
    const touch = mountRaw();
    const touchLabel = touch.root.querySelector('.fb-beam-a11y')?.getAttribute('aria-label') ?? '';
    expect(touchLabel).toContain('双指长按');
  });
});

describe('快捷键在 auto 贴边标签下仍可用', () => {
  function pressPremium(prevented = false): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    if (prevented) ev.preventDefault();
    document.dispatchEvent(ev);
    return ev;
  }

  it('未被宿主处理的组合键打开面板', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    pressPremium();
    expect(m.panel.hidden).toBe(false);
  });

  it('灵感球入口下快捷键同样可用（与点击入口同义）', () => {
    stubInput(true);
    const m = mountRaw({ 'launcher-mode': 'orb', 'capture-mode': 'off' });
    pressPremium();
    expect(m.panel.hidden).toBe(false);
  });

  it('宿主已 preventDefault 时让路', () => {
    stubInput(true);
    const m = mountRaw({ 'capture-mode': 'off' });
    pressPremium(true);
    expect(m.panel.hidden).toBe(true);
  });
});
