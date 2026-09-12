/** Apple 风格设计规范与 Shadow DOM 全隔离样式。 */
export const STYLES = /* css */ `
:host {
  --fb-z-index-default: 2147483000;
  --fb-accent: #0071e3;
  --fb-accent-hover: #0077ed;
  --fb-accent-active: #006edb;
  --fb-accent-disabled: #a0c7f5;
  --fb-focus-ring: rgba(0, 113, 227, 0.28);

  /* 默认浅色变量 */
  --fb-bg: #ffffff;
  --fb-bg-subtle: #f5f5f7;
  --fb-bg-subtle-hover: #e8e8ed;
  --fb-text: #1d1d1f;
  --fb-text-secondary: #86868b;
  --fb-text-tertiary: #a1a1a6;
  --fb-border: rgba(0, 0, 0, 0.08);
  --fb-border-strong: rgba(0, 0, 0, 0.16);
  --fb-shadow: 0 12px 32px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
  --fb-tab-shadow: 0 4px 14px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);

  --fb-status-error-bg: #fff2f4;
  --fb-status-error-border: #ffccd5;
  --fb-status-error-text: #d70015;

  --fb-status-success-bg: #f0fdf4;
  --fb-status-success-border: #bbf7d0;
  --fb-status-success-text: #15803d;

  --fb-status-warn-bg: #fff9eb;
  --fb-status-warn-border: #fde68a;
  --fb-status-warn-text: #b45309;

  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fb-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/*
 * [hidden] 全局兜底（必须保留）。
 *
 * 浏览器默认样式表里的 [hidden] { display: none } 是 **UA 规则**，会被本文件的
 * 任何作者规则压掉 —— 例如 .fb-screenshot-wrap { display: flex } 会让
 * element.hidden = true 完全失效：元素照旧占据版面。
 *
 * 已发生过的真实故障（宿主未声明 capture-mode，即默认 off 的绝大多数宿主）：
 * 面板显示一个空的「当前截图 / 点击放大」区，缩略图 src 为空 → 破图占位，
 * 点击也无法放大（无截图时 openZoomModal 直接返回）。「移除截图」看起来也毫无反应。
 *
 * 因此这里统一恢复 hidden 语义，避免每加一个设置 display 的组件规则就重新踩一次。
 * 依赖它的元素不止截图层：面板、截图预览区与
 * 「截取当前页面 / 重新截图 / 移除截图」三件套（按状态互斥显示）同样靠它兜底。
 * 回归覆盖：e2e/run_browser.py 的 P5a / P5b / P6（只有真实浏览器有样式级联）。
 */
[hidden] {
  display: none !important;
}

/* 显式深色或系统深色模式 */
:host([theme="dark"]) {
  --fb-accent-disabled: #1d4677;
  --fb-bg: #1c1c1e;
  --fb-bg-subtle: #2c2c2e;
  --fb-bg-subtle-hover: #3a3a3c;
  --fb-text: #f5f5f7;
  --fb-text-secondary: #98989d;
  --fb-text-tertiary: #636366;
  --fb-border: rgba(255, 255, 255, 0.12);
  --fb-border-strong: rgba(255, 255, 255, 0.24);
  --fb-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  --fb-tab-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);

  --fb-status-error-bg: rgba(255, 69, 58, 0.15);
  --fb-status-error-border: rgba(255, 69, 58, 0.3);
  --fb-status-error-text: #ff453a;

  --fb-status-success-bg: rgba(48, 209, 88, 0.15);
  --fb-status-success-border: rgba(48, 209, 88, 0.3);
  --fb-status-success-text: #30d158;

  --fb-status-warn-bg: rgba(255, 159, 10, 0.15);
  --fb-status-warn-border: rgba(255, 159, 10, 0.3);
  --fb-status-warn-text: #ff9f0a;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) {
    --fb-accent-disabled: #1d4677;
    --fb-bg: #1c1c1e;
    --fb-bg-subtle: #2c2c2e;
    --fb-bg-subtle-hover: #3a3a3c;
    --fb-text: #f5f5f7;
    --fb-text-secondary: #98989d;
    --fb-text-tertiary: #636366;
    --fb-border: rgba(255, 255, 255, 0.12);
    --fb-border-strong: rgba(255, 255, 255, 0.24);
    --fb-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
    --fb-tab-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);

    --fb-status-error-bg: rgba(255, 69, 58, 0.15);
    --fb-status-error-border: rgba(255, 69, 58, 0.3);
    --fb-status-error-text: #ff453a;

    --fb-status-success-bg: rgba(48, 209, 88, 0.15);
    --fb-status-success-border: rgba(48, 209, 88, 0.3);
    --fb-status-success-text: #30d158;

    --fb-status-warn-bg: rgba(255, 159, 10, 0.15);
    --fb-status-warn-border: rgba(255, 159, 10, 0.3);
    --fb-status-warn-text: #ff9f0a;
  }
}

/* 隐藏宿主控制 */
:host([show-launcher="false"]) .fb-launcher {
  display: none !important;
}

/* ---- 侧边贴边入口标签 ---- */
.fb-launcher {
  position: fixed;
  z-index: var(--fb-z-index, var(--fb-z-index-default));
  bottom: clamp(16px, var(--fb-launcher-bottom, 25%), calc(100vh - 64px));
  right: 0;
  left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  min-width: 44px;
  padding: 8px 12px 8px 10px;
  border: 1px solid var(--fb-border);
  border-right: none;
  border-radius: 12px 0 0 12px;
  background: var(--fb-bg);
  color: var(--fb-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--fb-tab-shadow);
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1),
              background 0.18s ease,
              opacity 0.18s ease;
  user-select: none;
  -webkit-user-select: none;
}

.fb-launcher:hover {
  transform: translateX(-3px);
  background: var(--fb-bg-subtle);
}

.fb-launcher:active {
  transform: translateX(-1px);
}

.fb-launcher:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 1px;
}

.fb-launcher-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: currentColor;
  color: var(--fb-accent);
}

:host([side="left"]) .fb-launcher {
  right: auto;
  left: 0;
  padding: 8px 10px 8px 12px;
  border-left: none;
  border-right: 1px solid var(--fb-border);
  border-radius: 0 12px 12px 0;
}

:host([side="left"]) .fb-launcher:hover {
  transform: translateX(3px);
}

:host([side="left"]) .fb-launcher:active {
  transform: translateX(1px);
}

/* ---- 灵感球 (Inspiration Orb) ---- */
.fb-orb {
  position: fixed;
  z-index: var(--fb-z-index, var(--fb-z-index-default));
  bottom: clamp(16px, var(--fb-launcher-bottom, 25%), calc(100vh - 64px));
  right: 20px;
  left: auto;
  width: 48px;
  height: 48px;
  min-width: 48px;
  min-height: 48px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  color: var(--fb-text);
  cursor: grab;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06), inset 0 0 0 0.5px rgba(255, 255, 255, 0.8);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.2s ease,
              background 0.2s ease;
}

:host([side="left"]) .fb-orb {
  right: auto;
  left: 20px;
}

.fb-orb:hover {
  transform: scale(1.06);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.08);
}

.fb-orb:active,
.fb-orb.is-dragging {
  cursor: grabbing;
  transform: scale(1.1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 3px 8px rgba(0, 0, 0, 0.1);
}

.fb-orb.is-dragging {
  transition: none !important;
}

.fb-orb:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

.fb-orb-icon {
  width: 22px;
  height: 22px;
  color: var(--fb-accent);
  pointer-events: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:host([theme="dark"]) .fb-orb {
  background: rgba(44, 44, 46, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45), inset 0 0 0 0.5px rgba(255, 255, 255, 0.15);
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) .fb-orb {
    background: rgba(44, 44, 46, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45), inset 0 0 0 0.5px rgba(255, 255, 255, 0.15);
  }
}

/* 控制 launcher 模式显示/隐藏 */
:host(:not([launcher-mode="orb"])) .fb-orb {
  display: none !important;
}

:host([launcher-mode="orb"]) .fb-tab-launcher {
  display: none !important;
}

/* 面板打开时隐藏标签 */
.fb-launcher.is-hidden {
  display: none !important;
}

/* ---- 桌面圆角浮层面板（无遮罩、不挤压布局、不锁滚动） ---- */
.fb-panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  left: auto;
  top: auto;
  z-index: var(--fb-z-index, var(--fb-z-index-default));
  width: min(400px, calc(100vw - 32px));
  max-height: min(620px, calc(100dvh - 32px));
  height: auto;
  box-sizing: border-box;
  background: var(--fb-bg);
  border: 1px solid var(--fb-border);
  border-radius: 16px;
  box-shadow: var(--fb-shadow);
  display: flex;
  flex-direction: column;
  opacity: 0;
  transform: scale(0.96) translateY(8px);
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              visibility 0.2s;
  overflow: hidden;
}

.fb-panel.is-open {
  opacity: 1;
  transform: scale(1) translateY(0);
  pointer-events: auto;
  visibility: visible;
}

:host([side="left"]) .fb-panel {
  right: auto;
  left: 16px;
}

/* ---- 移动端全屏布局（断点 768px） ---- */
@media (max-width: 767.98px) {
  .fb-panel {
    bottom: 0;
    top: 0;
    left: 0;
    right: 0;
    width: 100vw;
    max-height: 100dvh;
    height: 100dvh;
    border-radius: 0;
    border: none;
    box-shadow: none;
    transform: translateY(100%);
    padding-top: env(safe-area-inset-top, 0);
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .fb-panel.is-open {
    transform: translateY(0);
  }
}

/* ---- 面板头部 ---- */
.fb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--fb-border);
  flex-shrink: 0;
}

.fb-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fb-header-icon {
  width: 18px;
  height: 18px;
  fill: currentColor;
  color: var(--fb-accent);
  flex-shrink: 0;
}

.fb-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--fb-text);
  letter-spacing: -0.01em;
}

.fb-header-meta {
  font-size: 12px;
  color: var(--fb-text-tertiary);
  margin-left: 4px;
}

.fb-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: var(--fb-bg-subtle);
  color: var(--fb-text-secondary);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.fb-close:hover {
  background: var(--fb-bg-subtle-hover);
  color: var(--fb-text);
}

.fb-close:focus-visible,
.fb-submit:focus-visible,
.fb-btn-secondary:focus-visible,
.fb-task-link:focus-visible,
.fb-retry-btn:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

/* ---- 面板主体 ---- */
.fb-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  gap: 12px;
}

.fb-prompt {
  font-size: 13px;
  font-weight: 500;
  color: var(--fb-text-secondary);
  margin: 0;
}

.fb-textarea-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-height: 150px;
}

.fb-textarea {
  width: 100%;
  box-sizing: border-box;
  flex: 1;
  min-height: 150px;
  resize: none;
  padding: 12px 14px;
  border: 1px solid var(--fb-border);
  border-radius: 10px;
  background: var(--fb-bg-subtle);
  font: inherit;
  font-size: 14px;
  color: var(--fb-text);
  line-height: 1.5;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}

.fb-textarea:focus {
  outline: none;
  background: var(--fb-bg);
  border-color: var(--fb-accent);
  box-shadow: 0 0 0 3px var(--fb-focus-ring);
}

.fb-textarea:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.fb-counter-row {
  display: flex;
  justify-content: flex-end;
}

.fb-counter {
  color: var(--fb-text-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.fb-counter.is-over {
  color: var(--fb-status-error-text);
  font-weight: 600;
}

/* ---- 状态区与卡片 ---- */
.fb-status-region {
  min-height: 1.4em;
  font-size: 13px;
  color: var(--fb-text-secondary);
}

.fb-status-card {
  border-radius: 10px;
  padding: 12px 14px;
  border: 1px solid;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.fb-status-card p {
  margin: 0;
  line-height: 1.45;
}

.fb-status-card.is-error {
  background: var(--fb-status-error-bg);
  border-color: var(--fb-status-error-border);
  color: var(--fb-status-error-text);
}

.fb-status-card.is-success {
  background: var(--fb-status-success-bg);
  border-color: var(--fb-status-success-border);
  color: var(--fb-status-success-text);
}

.fb-status-card.is-warn {
  background: var(--fb-status-warn-bg);
  border-color: var(--fb-status-warn-border);
  color: var(--fb-status-warn-text);
}

.fb-card-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.fb-task-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fb-accent);
  font-weight: 500;
  text-decoration: none;
}

.fb-task-link:hover {
  text-decoration: underline;
}

.fb-btn-secondary {
  border: 1px solid var(--fb-border-strong);
  background: var(--fb-bg);
  color: var(--fb-text);
  border-radius: 8px;
  padding: 6px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.fb-btn-secondary:hover {
  background: var(--fb-bg-subtle-hover);
}

/* ---- 底部操作区 ---- */
.fb-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: auto;
}

.fb-submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  padding: 0 18px;
  border: none;
  border-radius: 980px;
  background: var(--fb-accent);
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}

.fb-submit:hover:not(:disabled) {
  background: var(--fb-accent-hover);
}

.fb-submit:active:not(:disabled) {
  background: var(--fb-accent-active);
  transform: scale(0.99);
}

.fb-submit:disabled {
  background: var(--fb-accent-disabled);
  cursor: not-allowed;
}

.fb-footnote {
  margin: 0;
  font-size: 12px;
  color: var(--fb-text-tertiary);
  text-align: center;
  line-height: 1.4;
}

/* ---- 截图区：预览与操作分离 ----
   预览（.fb-screenshot-wrap）只在真的有可渲染的截图 URL 时可见；
   操作区（.fb-screenshot-actions）始终在面板里：没有截图时它是「截取当前页面」。
   这条分工是刻意的——**无截图时整个截图区一起隐藏**会让默认 capture-mode=off
   （不自动截图）的宿主没有任何首次截图 / 补拍入口，而 hidden 的按钮三件套
   （截取当前页面 / 重新截图 / 移除截图）又必须真的不占版面。 */
.fb-shot-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ---- 截图缩略图与操作 ---- */
.fb-screenshot-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-screenshot-thumb-box {
  position: relative;
  width: 100%;
  height: 130px;
  max-height: 140px;
  border-radius: 10px;
  border: 1px solid var(--fb-border);
  background: var(--fb-bg-subtle);
  overflow: hidden;
  cursor: zoom-in;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fb-screenshot-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.2s ease;
}

.fb-screenshot-thumb-box:hover .fb-screenshot-thumb {
  transform: scale(1.02);
}

.fb-screenshot-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  pointer-events: none;
}

.fb-screenshot-zoom-hint {
  position: absolute;
  bottom: 8px;
  right: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.fb-screenshot-thumb-box:hover .fb-screenshot-zoom-hint {
  opacity: 1;
}

.fb-screenshot-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* 首个截图入口：默认 capture-mode=off 的宿主里它是**唯一**的截图方式，
   因此比「重新截图 / 移除截图」更显眼（主色填充），但不与「提交」争主次。 */
.fb-btn-capture {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--fb-accent);
  background: var(--fb-accent);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
}

.fb-btn-capture:hover:not(:disabled) {
  background: var(--fb-accent-hover);
}

.fb-btn-capture:disabled {
  background: var(--fb-accent-disabled);
  border-color: var(--fb-accent-disabled);
  cursor: not-allowed;
}

/* 捕获中：面板在此期间整体 visibility:hidden（截图里不含组件自身 UI），
   所以这个加载态只可能被会话结束后的用户与辅助技术看到。 */
.fb-shot-area.is-capturing .fb-btn-capture {
  cursor: progress;
}

.fb-btn-retake,
.fb-btn-remove {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--fb-border-strong);
  background: var(--fb-bg);
  color: var(--fb-text);
  cursor: pointer;
  transition: background 0.15s;
}

.fb-btn-retake:hover,
.fb-btn-remove:hover {
  background: var(--fb-bg-subtle-hover);
}

.fb-btn-remove {
  color: var(--fb-status-error-text);
  border-color: var(--fb-status-error-border);
}

.fb-btn-capture:focus-visible,
.fb-btn-retake:focus-visible,
.fb-btn-remove:focus-visible,
.fb-zoom-close:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

/* 窄屏（移动端全屏面板）：截图操作按钮给到触屏可点的高度，并允许换行 */
@media (max-width: 767.98px) {
  .fb-screenshot-actions {
    gap: 10px;
  }

  .fb-btn-capture,
  .fb-btn-retake,
  .fb-btn-remove {
    padding: 7px 12px;
    font-size: 13px;
  }
}

/* ---- 日志区（docs/logs-plan.md §4.5 / §4.6）----
   与截图区并列的附件区：始终可见（未配置 logProvider 时就是「手动添加日志」入口）。
   列表逐条展示 文件名 / 大小 / 来源，并提供只读预览与移除；状态行承载
   「正在获取日志…」「日志获取失败 + 重试 / 不带日志继续提交」与被拒文件的明确原因。 */
.fb-log-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fb-border);
  border-radius: 10px;
  background: var(--fb-bg-subtle);
}

.fb-log-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fb-log-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fb-text);
}

.fb-log-note {
  font-size: 11px;
  line-height: 1.45;
  color: var(--fb-text-secondary);
}

.fb-log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.fb-log-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--fb-bg);
  border: 1px solid var(--fb-border);
}

.fb-log-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fb-log-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--fb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-log-meta {
  font-size: 11px;
  color: var(--fb-text-secondary);
}

.fb-log-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.fb-log-preview-btn,
.fb-log-remove-btn,
.fb-log-retry,
.fb-log-skip,
.fb-log-add {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--fb-border-strong);
  background: var(--fb-bg);
  color: var(--fb-text);
  cursor: pointer;
  transition: background 0.15s;
}

.fb-log-preview-btn:hover,
.fb-log-retry:hover,
.fb-log-skip:hover,
.fb-log-add:hover {
  background: var(--fb-bg-subtle-hover);
}

.fb-log-remove-btn {
  color: var(--fb-status-error-text);
  border-color: var(--fb-status-error-border);
}

.fb-log-remove-btn:hover:not(:disabled) {
  background: var(--fb-status-error-bg);
}

.fb-log-remove-btn:disabled,
.fb-log-retry:disabled,
.fb-log-skip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fb-log-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  user-select: none;
}

.fb-log-add.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 原生 input[type=file][multiple][accept=".log,.txt,.json,.jsonl"]：
   视觉上隐藏但仍可通过键盘聚焦（label 的 accessible name 就是「添加日志」）。 */
.fb-log-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
  opacity: 0;
}

.fb-log-input:focus-visible + .fb-log-add {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

.fb-log-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.fb-log-status {
  font-size: 11px;
  line-height: 1.45;
  color: var(--fb-text-secondary);
}

.fb-log-status.is-error {
  color: var(--fb-status-error-text);
}

.fb-log-status.is-warn {
  color: var(--fb-status-warn-text);
}

.fb-log-preview {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--fb-border);
  background: var(--fb-bg);
  color: var(--fb-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.fb-log-preview-btn:focus-visible,
.fb-log-remove-btn:focus-visible,
.fb-log-retry:focus-visible,
.fb-log-skip:focus-visible,
.fb-log-add:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

@media (max-width: 767.98px) {
  .fb-log-preview-btn,
  .fb-log-remove-btn,
  .fb-log-retry,
  .fb-log-skip,
  .fb-log-add {
    padding: 7px 12px;
    font-size: 13px;
  }
}

/* ---- 截图大图弹窗 (Zoom Modal) ---- */
.fb-zoom-modal {
  position: fixed;
  inset: 0;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 20);
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  box-sizing: border-box;
  cursor: zoom-out;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.2s;
}

.fb-zoom-modal.is-open {
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
}

.fb-zoom-modal img {
  max-width: 92vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}

.fb-zoom-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.fb-zoom-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* ---- 尊重 prefers-reduced-motion ---- */
@media (prefers-reduced-motion: reduce) {
  .fb-launcher,
  .fb-panel,
  .fb-submit,
  .fb-close {
    transition: none !important;
  }
  .fb-launcher:hover,
  .fb-launcher:active,
  .fb-submit:active {
    transform: none !important;
  }
}
`;

