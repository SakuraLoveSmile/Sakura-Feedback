import { useEffect, useState } from 'react';
// 导入即自动注册 <feedback-widget> Custom Element（副作用）。
import type { FeedbackWidget, FeedbackSubmittedDetail } from '@feedback/web';
import '@feedback/web';

export function App() {
  // 用回调 ref 把真实 DOM 元素提到 state：事件订阅的 effect 依赖"元素身份"
  // 而不是挂载时机，StrictMode 的双调用（setup → cleanup → setup）以及
  // ref 的 detach/reattach 都能正确对应 add/removeListener。
  // 元素本身不会被 React 重建，草稿与登录令牌等状态一直活在元素实例上，
  // 因此重挂 effect 不会让用户丢失已输入内容。
  const [widget, setWidget] = useState<FeedbackWidget | null>(null);
  const [last, setLast] = useState<string | null>(null);

  useEffect(() => {
    if (!widget) return;
    const onSubmit = (ev: Event): void => {
      const detail = (ev as CustomEvent<FeedbackSubmittedDetail>).detail;
      setLast(`feedbackId=${detail.feedbackId} status=${detail.status}`);
    };
    widget.addEventListener('feedback-submitted', onSubmit);
    // 清理成对：严格模式下 effect 会 mount → unmount → mount，
    // 结束后页面上仍然只有一个监听器，不会重复触发 setLast。
    return () => widget.removeEventListener('feedback-submitted', onSubmit);
  }, [widget]);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 40 }}>
      <h1>React × @feedback/web 示例</h1>
      <p>右下角为灵感球（可拖动到界面任意位置指出问题并截图）：</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        <button onClick={() => widget?.open()}>纯文本打开（不截图）</button>
        <button onClick={() => widget?.captureAndOpen()}>截图并打开</button>
      </div>
      <p style={{ margin: '0 0 20px 0', fontSize: 13, color: '#64748b' }}>
        下面显式写了 <code>launcher-mode=&quot;orb&quot;</code> 与{' '}
        <code>capture-mode=&quot;viewport&quot;</code>：
        组件自身的默认值是 <code>tab</code> / <code>off</code>（升级不改变旧宿主行为），
        所以要灵感球与自动截图必须显式声明。截图范围是**当前应用视口**，拖拽落点只标记问题位置。
      </p>

      <div
        data-feedback-capture-mask
        style={{
          border: '1px solid #e2e8f0',
          padding: 16,
          borderRadius: 8,
          maxWidth: 400,
          background: '#f8fafc',
          marginBottom: 20,
        }}
      >
        <h3 style={{ margin: '0 0 8px 0' }}>敏感数据保护演示区</h3>
        <p style={{ margin: '0 0 8px 0', fontSize: 13, color: '#64748b' }}>
          带有 <code>data-feedback-capture-mask</code> 属性的区域在截图时会被中性遮罩覆盖：
        </p>
        <div>密钥：<code>sk-live-sensitive-api-token-999</code></div>
      </div>

      <p style={{ color: '#059669' }}>{last ? `最近提交：${last}` : ''}</p>

      {/* launcher-mode / capture-mode 的组件默认值是 tab / off（升级不改变旧宿主
          行为），所以这里显式覆盖成灵感球 + 呼出时截取当前应用视口。 */}
      <feedback-widget
        ref={setWidget}
        api-base="http://localhost:8787"
        app-id="com.example.demo-react"
        app-version="1.0.0"
        page-label="home"
        side="right"
        launcher-mode="orb"
        capture-mode="viewport"
      />
    </main>
  );
}
