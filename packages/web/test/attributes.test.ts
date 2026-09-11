import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import { cleanup, mount } from './helpers';

afterEach(cleanup);

describe('属性/attributes 反射', () => {
  it('attribute → property', () => {
    const { widget } = mount({ side: 'left' });
    expect(widget.apiBase).toBe('http://api.test:8787');
    expect(widget.appId).toBe('com.example.app');
    expect(widget.appVersion).toBe('1.2.3');
    expect(widget.pageLabel).toBe('settings/account');
    expect(widget.side).toBe('left');
  });

  it('property → attribute', () => {
    const { widget } = mount();
    widget.pageLabel = 'home';
    expect(widget.getAttribute('page-label')).toBe('home');
    widget.side = 'left';
    expect(widget.getAttribute('side')).toBe('left');
    widget.side = 'right';
    expect(widget.getAttribute('side')).toBe('right');
  });

  it('side 默认 right；非法值按 right 处理', () => {
    const { widget } = mount();
    expect(widget.side).toBe('right');
    widget.setAttribute('side', 'top');
    expect(widget.side).toBe('right');
  });

  it('property 置 null 移除 attribute', () => {
    const { widget } = mount();
    widget.pageLabel = null;
    expect(widget.hasAttribute('page-label')).toBe(false);
    expect(widget.pageLabel).toBeNull();
  });

  it('theme 属性与反射：默认 system，支持 light/dark', () => {
    const { widget } = mount();
    expect(widget.theme).toBe('system');
    widget.theme = 'dark';
    expect(widget.getAttribute('theme')).toBe('dark');
    expect(widget.theme).toBe('dark');
    widget.theme = 'light';
    expect(widget.getAttribute('theme')).toBe('light');
    widget.theme = 'system';
    expect(widget.hasAttribute('theme')).toBe(false);
    expect(widget.theme).toBe('system');
  });

  it('showLauncher 属性与反射：默认 true，设 false 隐藏入口', () => {
    const { widget } = mount();
    expect(widget.showLauncher).toBe(true);
    widget.showLauncher = false;
    expect(widget.getAttribute('show-launcher')).toBe('false');
    expect(widget.showLauncher).toBe(false);
    widget.showLauncher = true;
    expect(widget.hasAttribute('show-launcher')).toBe(false);
    expect(widget.showLauncher).toBe(true);
  });

  it('launcherBottom 属性与 CSS 变量设置：默认 25%', () => {
    const { widget } = mount();
    expect(widget.launcherBottom).toBe('25%');
    widget.launcherBottom = '120px';
    expect(widget.getAttribute('launcher-bottom')).toBe('120px');
    expect(widget.style.getPropertyValue('--fb-launcher-bottom')).toBe('120px');
  });
});

