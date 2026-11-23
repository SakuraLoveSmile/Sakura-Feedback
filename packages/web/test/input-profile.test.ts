import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoLauncherMode,
  detectInputProfile,
  formatWakeShortcut,
  primaryModifierLabel,
} from '../src/input-profile';

interface ProbeOptions {
  fine?: boolean;
  coarse?: boolean;
  touchPoints?: number;
  platform?: string;
  matchMedia?: boolean;
}

function stubInput(options: ProbeOptions = {}): void {
  const { fine = false, coarse = false, touchPoints = 0, platform = 'Win32', matchMedia = true } = options;
  if (matchMedia) {
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: (media === '(pointer: fine)' && fine) || (media === '(pointer: coarse)' && coarse) ||
        (media === '(any-pointer: coarse)' && coarse),
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  } else {
    vi.stubGlobal('matchMedia', undefined);
  }
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: touchPoints });
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: 0 });
});

describe('输入能力探测', () => {
  it('有精细指针、没有触摸：桌面入口', () => {
    stubInput({ fine: true });
    const profile = detectInputProfile(window);
    expect(profile).toEqual({ fine: true, touch: false });
    expect(autoLauncherMode(profile)).toBe('tab');
  });

  it('只有粗指针与多点触控：沿用光束手势', () => {
    stubInput({ coarse: true, touchPoints: 5 });
    const profile = detectInputProfile(window);
    expect(profile).toEqual({ fine: false, touch: true });
    expect(autoLauncherMode(profile)).toBe('beam');
  });

  it('触屏笔记本（精细指针 + 触摸）仍给可见入口，同时保留手势能力', () => {
    stubInput({ fine: true, coarse: true, touchPoints: 10 });
    const profile = detectInputProfile(window);
    expect(profile).toEqual({ fine: true, touch: true });
    expect(autoLauncherMode(profile)).toBe('tab');
  });

  it('没有 matchMedia 的环境不改变已发布默认（beam）', () => {
    stubInput({ matchMedia: false, touchPoints: 0 });
    const profile = detectInputProfile(window);
    expect(profile).toEqual({ fine: false, touch: false });
    expect(autoLauncherMode(profile)).toBe('beam');
  });
});

describe('快捷键文案', () => {
  it('按平台渲染主修饰键', () => {
    stubInput({ platform: 'MacIntel' });
    expect(primaryModifierLabel(window)).toBe('⌘');
    expect(formatWakeShortcut('primary+shift+f', window)).toBe('⌘+Shift+F');
    stubInput({ platform: 'Win32' });
    expect(primaryModifierLabel(window)).toBe('Ctrl');
    expect(formatWakeShortcut('primary+shift+f', window)).toBe('Ctrl+Shift+F');
  });

  it('未配置时按默认组合显示，off 与非法组合不产生提示文案', () => {
    stubInput({ platform: 'Win32' });
    expect(formatWakeShortcut('', window)).toBe('Ctrl+Shift+F');
    expect(formatWakeShortcut('off', window)).toBeNull();
    expect(formatWakeShortcut('primary+shift', window)).toBeNull();
    expect(formatWakeShortcut('hyper+f', window)).toBeNull();
  });

  it('自定义组合按字面渲染', () => {
    stubInput({ platform: 'Win32' });
    expect(formatWakeShortcut('ctrl+alt+k', window)).toBe('Ctrl+Alt+K');
  });
});
