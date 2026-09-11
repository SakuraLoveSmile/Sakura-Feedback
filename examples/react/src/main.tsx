import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// StrictMode 在开发环境会刻意双调用渲染与 effect（mount → unmount → mount）。
// 对本示例是安全的：<feedback-widget> 是真实的 DOM 元素，未被 React 重建，
// 其草稿、登录令牌等状态活在元素实例上；App 中监听事件的 effect 每次都成对
// add/removeListener，双调用结束后恰好保留一个监听器（见 src/App.tsx）。
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
