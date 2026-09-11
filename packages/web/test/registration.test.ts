import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import { FeedbackWidget, defineFeedbackWidget, openFeedback } from '../src/index';
import { cleanup, mount } from './helpers';

afterEach(cleanup);

describe('元素注册', () => {
  it('导入即自动定义 <feedback-widget>', () => {
    expect(customElements.get('feedback-widget')).toBe(FeedbackWidget);
  });

  it('重复注册安全（幂等 define）', () => {
    expect(() => defineFeedbackWidget()).not.toThrow();
    expect(customElements.get('feedback-widget')).toBe(FeedbackWidget);
  });

  it('createElement 得到 FeedbackWidget 实例并具备 shadow DOM', () => {
    const { widget, root } = mount();
    expect(widget).toBeInstanceOf(FeedbackWidget);
    expect(root).not.toBeNull();
    expect(root.querySelector('.fb-panel')?.getAttribute('role')).toBe('dialog');
  });
});

describe('openFeedback 辅助函数', () => {
  it('页面无元素时动态创建并打开', () => {
    expect(document.querySelector('feedback-widget')).toBeNull();
    const w = openFeedback({ apiBase: 'http://api.test:8787', appId: 'com.example.app', side: 'left' });
    expect(document.querySelector('feedback-widget')).toBe(w);
    expect(w.getAttribute('api-base')).toBe('http://api.test:8787');
    expect(w.side).toBe('left');
    expect(w.shadowRoot?.querySelector('.fb-panel')?.classList.contains('is-open')).toBe(true);
  });

  it('已有元素时复用并打开', () => {
    const { widget } = mount();
    const again = openFeedback();
    expect(again).toBe(widget);
    expect(document.querySelectorAll('feedback-widget').length).toBe(1);
  });
});
