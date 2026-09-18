import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import { cleanup, mount, setTextarea } from './helpers';
import { STYLES } from '../src/styles';

afterEach(cleanup);

function pressKey(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
  // 真实浏览器 keydown 的 composed 为 true；happy-dom 需显式声明才会跨 shadow 边界传播。
  const ev = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(ev);
  return ev;
}

describe('无障碍与键盘', () => {
  it('面板 role=dialog，桌面 aria-modal=false，交互元素具备 aria 标签与可见提示标签', () => {
    const { panel, fab, textarea, submitBtn, root } = mount();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('记录体验');
    expect(fab.getAttribute('aria-label')).toBe('打开反馈面板');
    expect(fab.getAttribute('aria-expanded')).toBe('false');
    expect(textarea.getAttribute('aria-label')).toBe('反馈内容');
    expect(submitBtn.getAttribute('aria-label')).toBe('提交反馈');
    expect(root.querySelector('.fb-close')?.getAttribute('aria-label')).toBe('关闭反馈面板');
    expect(root.querySelector('.fb-status')?.getAttribute('role')).toBe('status');

    // 可见提示标签
    const prompt = root.querySelector<HTMLLabelElement>('label.fb-prompt');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toContain('哪里不顺手，或者有什么新想法？');
    expect(prompt?.getAttribute('for')).toBe('fb-textarea');
  });

  it('打开时焦点移到 textarea，fab 隐藏且 aria-expanded 更新', () => {
    const { fab, root, textarea } = mount();
    fab.click();
    expect(root.activeElement).toBe(textarea);
    expect(fab.getAttribute('aria-expanded')).toBe('true');
    expect(fab.classList.contains('is-hidden')).toBe(true);
    expect(textarea.getAttribute('placeholder')).toContain('刚才哪里不顺手');
  });

  it('Esc 仅在焦点位于组件内时关闭面板并恢复焦点到呼出按钮', () => {
    const { fab, root, panel } = mount();
    fab.click();
    // 焦点在 textarea（组件内）
    expect(root.activeElement).not.toBeNull();
    const ev = pressKey(panel, 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(fab.getAttribute('aria-expanded')).toBe('false');
    expect(root.activeElement).toBe(fab);
    expect(panel.classList.contains('is-open')).toBe(false);
  });

  it('桌面面板不设模态焦点锁：Tab 允许自然移出面板返回宿主', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, '测试输入');
    const { panel } = m;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href]'),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();

    // 桌面模式下，Tab 离开最后一个元素时不阻断默认行为（允许回到宿主页面）
    const ev = pressKey(panel, 'Tab');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('移动端模式（<=768px）启用模态焦点循环', () => {
    // 模拟移动端视口
    const origMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({
      matches: query.includes('max-width: 767.98px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList);

    const m = mount();
    m.fab.click();
    setTextarea(m, '移动端内容');
    const { panel, root } = m;
    // 与组件 focusables() 同一口径：含 input 与 tabindex=0，排除 [hidden] 祖先内的节点
    // （设置视图隐藏时其子元素不得进入焦点序列）。
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]',
      ),
    ).filter((n) => n.closest('[hidden]') === null);
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;

    last.focus();
    let ev = pressKey(panel, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);

    ev = pressKey(first, 'Tab', true);
    expect(ev.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(last);

    window.matchMedia = origMatchMedia;
  });

  it('桌面支持 ⌘/Ctrl + Enter 快捷键提交，中文输入法组词期间不触发', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, '快捷键测试');
    let submitted = false;
    m.widget.addEventListener('feedback-submitted', () => {
      submitted = true;
    });

    // 1. 中文输入法组词期间（isComposing = true）：不触发
    const composingEv = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(composingEv, 'isComposing', { value: true });
    m.textarea.dispatchEvent(composingEv);
    expect(composingEv.defaultPrevented).toBe(false);
    expect(submitted).toBe(false);

    // 2. keyCode 229（输入法组合键常用码）：不触发
    const imeCodeEv = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(imeCodeEv, 'keyCode', { value: 229 });
    m.textarea.dispatchEvent(imeCodeEv);
    expect(imeCodeEv.defaultPrevented).toBe(false);
    expect(submitted).toBe(false);

    // 3. 正常 ⌘ + Enter：被处理
    const normalEv = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    m.textarea.dispatchEvent(normalEv);
    expect(normalEv.defaultPrevented).toBe(true);
  });

  it('样式包含 prefers-reduced-motion 与可配置 z-index 变量；side=left 镜像', () => {
    expect(STYLES).toContain('prefers-reduced-motion');
    expect(STYLES).toContain('--fb-z-index');
    expect(STYLES).toContain(':host([side="left"])');
    const { widget } = mount({ side: 'left' });
    expect(widget.getAttribute('side')).toBe('left');
  });
});

