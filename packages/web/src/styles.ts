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

/* ---- 灵感球 (Inspiration Orb) ----
   T2b：按官方帧实测绘制径向白环、真实透光与单轴双向色散。
   渐变光效只允许出现在灵感球上。 */
/* 下面七条 @property 在 Shadow DOM 内不生效（实测），真正的注册在 element.ts 的
   registerOrbProperties()；保留声明是为了样式表被放进 light DOM 时也能自描述。 */
@property --fb-orb-breath {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

/* 状态缩放与呼吸权重是两个独立的 registered number，只有它们参与 transition；
   最终 scale = 状态因子 × (1 + 0.02 × 实时 breath × 呼吸权重)，
   因此 5.4s breath 始终是实时相位，不会被状态过渡低通成滞后曲线。
   权重与状态因子同时过渡，状态边界才不会出现 2% 的跳变。 */
@property --fb-orb-state-scale {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --fb-orb-breath-weight {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --fb-orb-drag-angle {
  syntax: "<angle>";
  inherits: true;
  initial-value: 0rad;
}

@property --fb-orb-stretch-along {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --fb-orb-glow-x {
  syntax: "<length>";
  inherits: true;
  initial-value: 0px;
}

@property --fb-orb-glow-y {
  syntax: "<length>";
  inherits: true;
  initial-value: 0px;
}

.fb-orb {
  --fb-orb-breath: 0;
  --fb-orb-breath-bloom-gain: 0.08;
  /* idle：状态因子 1、呼吸权重 1，最终 scale = 1 + 0.02 × breath。 */
  --fb-orb-state-scale: 1;
  --fb-orb-breath-weight: 1;
  --fb-orb-drag-angle: 0rad;
  --fb-orb-stretch-along: 1;
  --fb-orb-glow-x: 0px;
  --fb-orb-glow-y: 0px;
  --fb-orb-state-duration: 220ms;
  /* 现有实现曲线（第 3 节只给了时长），不是官方时序参数。 */
  --fb-orb-state-easing: cubic-bezier(0.16, 1, 0.3, 1);
  --fb-orb-release-duration: 460ms;
  --fb-orb-release-easing: cubic-bezier(0.2, 1.35, 0.32, 1);
  --fb-orb-cyan: rgba(120, 200, 255, 0.70);
  --fb-orb-warm: rgba(255, 190, 120, 0.58);
  --fb-orb-dispersion-opacity: 1;
  --fb-orb-bloom-white: rgba(255, 255, 255, 0.45);
  --fb-orb-bloom-white-alpha: 0.45;
  --fb-orb-sweep-white: rgba(255, 255, 255, 0.80);
  position: fixed;
  z-index: var(--fb-z-index, var(--fb-z-index-default));
  bottom: clamp(16px, var(--fb-launcher-bottom, 25%), calc(100vh - 64px));
  right: 20px;
  left: auto;
  width: 56px;
  height: 56px;
  min-width: 56px;
  min-height: 56px;
  box-sizing: border-box;
  border: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  overflow: visible;
  background: transparent;
  color: var(--fb-text);
  cursor: grab;
  box-shadow: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  animation: fb-orb-breath 5.4s ease-in-out infinite alternate;
  /* transform 过渡只服务于松手回停靠；状态缩放走两个 registered number，
     breath 本身不在列表里，所以设置后下一帧即到位。 */
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1),
              --fb-orb-state-scale var(--fb-orb-state-duration) var(--fb-orb-state-easing),
              --fb-orb-breath-weight var(--fb-orb-state-duration) var(--fb-orb-state-easing);
}

.fb-orb.fb-orb-properties-unavailable {
  --fb-orb-breath: 0;
  --fb-orb-breath-bloom-gain: 0;
  animation: none;
  transition: none;
}

:host([side="left"]) .fb-orb {
  right: auto;
  left: 20px;
}

/* 状态缩放只改视觉组变量，root 不再 scale 整棵 DOM（badge 必须保持 1:1）。
   选择器互斥即构成优先级：dragging > releasing > pressed > hover > idle。 */

/* 球体同时带 .fb-launcher 类，必须挡掉贴边标签的 hover / active 位移与填充：
   root 的 transform 只留给 1:1 指针平移，球心必须保持清玻璃。 */
.fb-orb:hover,
.fb-orb:active,
:host([side="left"]) .fb-orb:hover,
:host([side="left"]) .fb-orb:active {
  transform: none;
  background: transparent;
}

.fb-orb:hover:not(:active):not(.is-pressed):not(.is-dragging):not(.is-releasing) {
  --fb-orb-state-scale: 1.04;
  --fb-orb-breath-weight: 0;
}

.fb-orb:active:not(.is-dragging):not(.is-releasing),
.fb-orb.is-pressed:not(.is-dragging):not(.is-releasing) {
  --fb-orb-state-scale: 0.94;
  --fb-orb-breath-weight: 0;
  --fb-orb-state-duration: 140ms;
  --fb-orb-state-easing: ease-out;
}

/* pressed 退出窗口：JS 在松手 / cancel 时挂上，140ms 后摘掉，
   让退出也走 140ms ease-out（CSS 无法表达「刚才是 pressed」）。 */
.fb-orb.is-unpressing:not(.is-dragging):not(.is-releasing) {
  --fb-orb-state-duration: 140ms;
  --fb-orb-state-easing: ease-out;
}

/* 56px 基础球 × 1.5 = 84px；缩放由四个视觉层承担，root 只做 1:1 指针平移。 */
.fb-orb.is-dragging {
  --fb-orb-state-scale: 1.5;
  --fb-orb-breath-weight: 0;
  cursor: grabbing;
  /* 指针平移必须 1:1，故此处不含 transform；状态缩放仍走 220ms。
     官方帧无可测投影（spec 12.8），拖动态不再加阴影。 */
  transition: --fb-orb-state-scale var(--fb-orb-state-duration) var(--fb-orb-state-easing),
              --fb-orb-breath-weight var(--fb-orb-state-duration) var(--fb-orb-state-easing);
}

.fb-orb.is-releasing {
  transition: transform var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-state-scale var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-breath-weight var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-drag-angle var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-stretch-along var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-glow-x var(--fb-orb-release-duration) var(--fb-orb-release-easing),
              --fb-orb-glow-y var(--fb-orb-release-duration) var(--fb-orb-release-easing);
}

.fb-orb.fb-orb-properties-unavailable.is-dragging,
.fb-orb.fb-orb-properties-unavailable.is-releasing {
  transition: none;
}

/* 焦点环是独立绝对定位层：外径 = 当前视觉直径 + 8（每侧 2px 间隙 + 2px 环宽）。
   它不进随 --fb-orb-state-scale 缩放 / 方向拉伸的视觉组，否则 +8 会被一起放大。 */
.fb-orb-focus-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 4;
  translate: -50% -50%;
  box-sizing: border-box;
  width: calc(56px * var(--fb-orb-state-scale) + 8px);
  height: calc(56px * var(--fb-orb-state-scale) + 8px);
  border: 2px solid var(--fb-accent);
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
}

/* 环改由 .fb-orb-focus-ring 绘制，关掉 UA / 旧规则的外描边以免出现双环。 */
.fb-orb:focus-visible {
  outline: none;
}

.fb-orb:focus-visible .fb-orb-focus-ring {
  opacity: 1;
}

.fb-orb-bloom,
.fb-orb-glow,
.fb-orb-sweep,
.fb-orb-core {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  transform-origin: 50% 50%;
  scale: calc(
    var(--fb-orb-state-scale) *
    (1 + var(--fb-orb-breath) * 0.02 * var(--fb-orb-breath-weight))
  );
  transform: rotate(var(--fb-orb-drag-angle))
    scaleX(var(--fb-orb-stretch-along))
    rotate(calc(0rad - var(--fb-orb-drag-angle)));
}

.fb-orb-bloom {
  inset: -3px;
  z-index: 0;
  filter: blur(4px);
}

.fb-orb-bloom::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(
    circle closest-side,
    transparent 0%,
    transparent 78%,
    rgb(255 255 255 / 58%) 88%,
    rgb(255 255 255 / 100%) 96%,
    transparent 100%
  );
  opacity: calc(var(--fb-orb-bloom-white-alpha) * (1 + var(--fb-orb-breath) * var(--fb-orb-breath-bloom-gain)));
  pointer-events: none;
}

.fb-orb-glow {
  inset: -14px;
  z-index: 1;
  opacity: var(--fb-orb-dispersion-opacity);
  translate: var(--fb-orb-glow-x) var(--fb-orb-glow-y);
  /* mask 在父层：模糊先完成，再把 0.95R 以内整块挖空，不染清玻璃心。 */
  -webkit-mask: radial-gradient(
    circle closest-side,
    rgb(0 0 0 / 0%) 0%,
    rgb(0 0 0 / 0%) 63%,
    rgb(0 0 0 / 100%) 69%,
    rgb(0 0 0 / 100%) 75%,
    rgb(0 0 0 / 55%) 83%,
    rgb(0 0 0 / 6%) 100%
  );
  mask: radial-gradient(
    circle closest-side,
    rgb(0 0 0 / 0%) 0%,
    rgb(0 0 0 / 0%) 63%,
    rgb(0 0 0 / 100%) 69%,
    rgb(0 0 0 / 100%) 75%,
    rgb(0 0 0 / 55%) 83%,
    rgb(0 0 0 / 6%) 100%
  );
}

.fb-orb-glow::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  /* from 37.5deg：暖心落在 conic 135deg，冷心落在 conic 300deg，过渡段透明。 */
  background: conic-gradient(
    from 37.5deg at 50% 50%,
    transparent 0deg,
    var(--fb-orb-warm) 97.5deg,
    transparent 180deg,
    var(--fb-orb-cyan) 262.5deg,
    transparent 360deg
  );
  filter: blur(8px);
  pointer-events: none;
}

.fb-orb-sweep {
  inset: 0;
  z-index: 2;
}

.fb-orb-sweep::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from -20deg at 50% 50%,
    transparent 0deg,
    var(--fb-orb-sweep-white) 20deg,
    transparent 40deg,
    transparent 360deg
  );
  -webkit-mask: radial-gradient(
    circle closest-side,
    transparent 0%,
    transparent 82%,
    #000 88%,
    #000 100%
  );
  mask: radial-gradient(
    circle closest-side,
    transparent 0%,
    transparent 82%,
    #000 88%,
    #000 100%
  );
  animation: fb-orb-sweep 10s linear infinite;
  pointer-events: none;
}

.fb-orb-core {
  inset: 0;
  z-index: 3;
  box-sizing: border-box;
  overflow: hidden;
  background: radial-gradient(
    circle closest-side at 50% 50%,
    rgb(255 255 255 / 0%) 0%,
    rgb(255 255 255 / 11%) 26%,
    rgb(255 255 255 / 9%) 44%,
    rgb(255 255 255 / 17%) 53%,
    rgb(255 255 255 / 22%) 62%,
    rgb(255 255 255 / 35%) 70%,
    rgb(255 255 255 / 43%) 75%,
    rgb(255 255 255 / 54%) 79%,
    rgb(255 255 255 / 67%) 84%,
    rgb(255 255 255 / 81%) 88%,
    rgb(255 255 255 / 94%) 92%,
    rgb(255 255 255 / 98%) 95%,
    rgb(255 255 255 / 98%) 100%
  );
  box-shadow: none;
}

.fb-orb .fb-launcher-badge {
  z-index: 5;
  transform: none;
  rotate: 0deg;
  scale: 1;
}

@keyframes fb-orb-breath {
  from { --fb-orb-breath: 0; }
  to { --fb-orb-breath: 1; }
}

@keyframes fb-orb-sweep {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

:host([theme="dark"]) .fb-orb {
  /* 色散色亮度对齐深色衬底，色环只贡献色差不贡献亮度（实测 1.12R 贡献 -0.62 灰阶）。 */
  --fb-orb-warm: rgba(200, 24, 0, 0.43);
  --fb-orb-cyan: rgba(0, 76, 255, 0.33);
  --fb-orb-bloom-white: rgba(255, 255, 255, 0.55);
  --fb-orb-bloom-white-alpha: 0.55;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) .fb-orb {
    --fb-orb-warm: rgba(200, 24, 0, 0.43);
    --fb-orb-cyan: rgba(0, 76, 255, 0.33);
    --fb-orb-bloom-white: rgba(255, 255, 255, 0.55);
    --fb-orb-bloom-white-alpha: 0.55;
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

/* ---- 桌面圆角浮层面板（无遮罩、不挤压布局、不锁滚动） ----
   冻结规格：桌面宽 440px，最大高 min(720px, 视口高−32px)；768px 以下全屏。 */
.fb-panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  left: auto;
  top: auto;
  z-index: var(--fb-z-index, var(--fb-z-index-default));
  width: min(440px, calc(100vw - 32px));
  max-height: min(720px, calc(100dvh - 32px));
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
  font-size: 11px;
  color: var(--fb-text-tertiary);
  margin-left: 4px;
}

.fb-close {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
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

/* 命中区扩到 ≥44px（不改变视觉尺寸，相邻按钮间距按 16px 排布避免重叠） */
.fb-close::after,
.fb-icon-btn::after {
  content: "";
  position: absolute;
  inset: -6px;
}

.fb-close:focus-visible,
.fb-submit:focus-visible,
.fb-btn-secondary:focus-visible,
.fb-task-link:focus-visible,
.fb-retry-btn:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

/* ---- 面板主体 ----
   顺序（T2.6）：反馈描述 → 图片证据 → 可折叠日志 → 状态 → 固定提交区。 */
.fb-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 0;
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
  min-height: 44px;
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.fb-btn-secondary:hover {
  background: var(--fb-bg-subtle-hover);
}

/* ---- 底部操作区（固定提交区）：滚动时始终贴在面板底部 ---- */
.fb-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: auto;
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--fb-bg);
  border-top: 1px solid var(--fb-border);
  padding: 10px 0 16px;
}

.fb-submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 44px;
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
  font-size: 11px;
  color: var(--fb-text-tertiary);
  text-align: center;
  line-height: 1.4;
}

/* ---- 额度与面板内登录 ----
   技术 / 账户信息弱化展示（T2.6）：更小字号、三级文字色，不与主内容争焦点。 */
.fb-quota {
  font-size: 11px;
  color: var(--fb-text-tertiary);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.fb-quota-blocked {
  margin: 0;
  font-size: 12px;
  color: var(--fb-status-warn-text);
  text-align: center;
  line-height: 1.4;
}

.fb-login-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fb-border);
  border-radius: 10px;
  background: var(--fb-bg-subtle);
}

.fb-login-row {
  display: flex;
  gap: 8px;
}

.fb-login-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--fb-border-strong);
  border-radius: 8px;
  background: var(--fb-bg);
  color: var(--fb-text);
  font: inherit;
  font-size: 13px;
}

.fb-login-input:focus {
  outline: none;
  border-color: var(--fb-accent);
  box-shadow: 0 0 0 3px var(--fb-focus-ring);
}

.fb-login-input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.fb-login-error {
  margin: 0;
  font-size: 12px;
  color: var(--fb-status-error-text);
  line-height: 1.4;
}

.fb-login-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
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

/* ---- 截图缩略图与操作（v12：两列 120px 缩略图网格；T2.5） ----
   图片完整显示（contain，禁止 cover 二次裁切）；角标标「局部截图 / 已编辑」，
   尺寸读数显示输出像素；编辑、删除按钮在图片**下方**，不得遮住图片内容。 */
.fb-screenshot-wrap {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.fb-screenshot-thumb-box {
  position: relative;
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--fb-border);
  background: var(--fb-bg-subtle);
  overflow: hidden;
  cursor: zoom-in;
  display: flex;
  flex-direction: column;
}

.fb-thumb-frame {
  position: relative;
  height: 116px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--fb-bg-subtle);
}

/* 编辑 / 删除行（图片下方）：触控目标 ≥44px，绝不覆盖图片内容。 */
.fb-thumb-actions {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--fb-border);
  background: var(--fb-bg);
}

.fb-thumb-edit,
.fb-thumb-remove {
  flex: 1;
  min-width: 44px;
  min-height: 44px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1;
  border: 1px solid var(--fb-border-strong);
  border-radius: 8px;
  background: var(--fb-bg);
  color: var(--fb-text);
  cursor: pointer;
}

.fb-thumb-remove {
  color: var(--fb-status-error-text);
  border-color: var(--fb-status-error-border);
}

.fb-thumb-edit:disabled,
.fb-thumb-remove:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fb-thumb-edit:focus-visible,
.fb-thumb-remove:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 1px;
}

.fb-screenshot-thumb {
  width: 100%;
  height: 100%;
  object-fit: contain; /* 完整显示，禁止 cover 二次裁切 */
  display: block;
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

/* 尺寸读数（输出像素）：与角标同层的轻量标记 */
.fb-screenshot-size {
  position: absolute;
  bottom: 8px;
  left: 8px;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 10px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
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
  min-height: 44px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
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
.fb-btn-remove,
.fb-btn-add-image {
  min-height: 44px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid var(--fb-border-strong);
  background: var(--fb-bg);
  color: var(--fb-text);
  cursor: pointer;
  transition: background 0.15s;
}

.fb-btn-retake:hover:not(:disabled),
.fb-btn-remove:hover:not(:disabled),
.fb-btn-add-image:hover:not(:disabled) {
  background: var(--fb-bg-subtle-hover);
}

.fb-btn-retake:disabled,
.fb-btn-remove:disabled,
.fb-btn-add-image:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 预览旁提示与图片错误（v12：部分内容未入图 / 服务端单图降级 / 仍超限） */
.fb-shot-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fb-status-warn-text);
  background: var(--fb-status-warn-bg);
  border: 1px solid var(--fb-status-warn-border);
  border-radius: 8px;
  padding: 6px 10px;
}

.fb-shot-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fb-status-error-text);
  background: var(--fb-status-error-bg);
  border: 1px solid var(--fb-status-error-border);
  border-radius: 8px;
  padding: 6px 10px;
}

/* 拖入图片时的目标态 */
.fb-body.is-dragover {
  outline: 2px dashed var(--fb-accent);
  outline-offset: -4px;
  border-radius: 8px;
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

/* ---- 日志附件区（T4 可折叠）：默认只显示简短摘要行 ---- */
.fb-logs-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-logs-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 12px;
  border: 1px solid var(--fb-border);
  border-radius: 10px;
  background: var(--fb-bg-subtle);
  color: var(--fb-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.fb-logs-toggle:hover {
  background: var(--fb-bg-subtle-hover);
}

.fb-logs-toggle:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

.fb-logs-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-logs-chevron {
  flex-shrink: 0;
  transition: transform 0.18s ease;
}

.fb-logs-toggle[aria-expanded="true"] .fb-logs-chevron {
  transform: rotate(90deg);
}

.fb-logs-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--fb-text-secondary);
}

.fb-logs-list {
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
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--fb-bg-subtle);
  border: 1px solid var(--fb-border);
  font-size: 12px;
  gap: 8px;
}

.fb-log-info {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.fb-log-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-log-badge {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  background: var(--fb-bg-subtle-hover);
  color: var(--fb-text-secondary);
}

.fb-log-size {
  color: var(--fb-text-tertiary);
  font-size: 11px;
}

.fb-log-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fb-log-btn-preview,
.fb-log-btn-remove,
.fb-btn-add-log {
  min-height: 44px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid var(--fb-border-strong);
  background: var(--fb-bg);
  color: var(--fb-text);
  cursor: pointer;
  transition: background 0.15s;
}

.fb-log-btn-preview:hover,
.fb-log-btn-remove:hover,
.fb-btn-add-log:hover {
  background: var(--fb-bg-subtle-hover);
}

.fb-log-btn-remove {
  color: var(--fb-status-error-text);
  border-color: var(--fb-status-error-border);
}

.fb-log-status {
  font-size: 12px;
  color: var(--fb-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.fb-log-error {
  font-size: 12px;
  color: var(--fb-status-error-text);
  background: var(--fb-status-error-bg);
  border: 1px solid var(--fb-status-error-border);
  padding: 4px 8px;
  border-radius: 4px;
}

.fb-log-preview-modal {
  position: fixed;
  inset: 0;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 25);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.2s;
}

.fb-log-preview-modal.is-open {
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
}

.fb-log-preview-card {
  background: var(--fb-bg);
  color: var(--fb-text);
  border-radius: 12px;
  padding: 16px;
  max-width: 680px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--fb-shadow);
  border: 1px solid var(--fb-border);
}

.fb-log-preview-body {
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--fb-bg-subtle);
  padding: 12px;
  border-radius: 6px;
  margin: 12px 0;
  flex: 1;
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

/* ---- 头部右侧动作组与服务器设置视图（T6） ---- */
.fb-header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.fb-icon-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--fb-text-secondary);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.fb-icon-btn:hover {
  background: var(--fb-bg-subtle-hover);
  color: var(--fb-text);
}

.fb-icon-btn:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

.fb-settings {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  gap: 10px;
}

.fb-settings-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fb-text);
}

.fb-settings-line {
  margin: 0;
  font-size: 12px;
  color: var(--fb-text-secondary);
  display: flex;
  gap: 4px;
  min-width: 0;
}

.fb-settings-label {
  flex-shrink: 0;
}

.fb-settings-value {
  color: var(--fb-text);
  overflow-wrap: anywhere;
  word-break: break-all;
}

.fb-server-input {
  width: 100%;
}

.fb-settings-error {
  margin: 0;
  font-size: 12px;
  color: var(--fb-status-error-text);
  line-height: 1.4;
}

.fb-settings-hint {
  margin: 0;
  font-size: 12px;
  color: var(--fb-status-warn-text);
  line-height: 1.4;
}

.fb-settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fb-settings-confirm {
  border: 1px solid var(--fb-status-warn-border);
  background: var(--fb-status-warn-bg);
  color: var(--fb-status-warn-text);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}

.fb-settings-confirm-text {
  margin: 0;
  line-height: 1.5;
}

/* ---- v11 对话与历史视图 ---- */
.fb-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #d70015;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.fb-launcher-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}

.fb-nav-tabs {
  display: flex;
  gap: 8px;
  align-items: center;
}

.fb-nav-btn {
  background: transparent;
  border: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--fb-text-secondary);
  cursor: pointer;
  min-height: 44px;
  padding: 4px 12px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.fb-nav-btn:hover {
  background: var(--fb-bg-subtle-hover);
  color: var(--fb-text);
}

.fb-nav-btn.active {
  color: var(--fb-accent);
  font-weight: 600;
  background: var(--fb-bg-subtle);
}

.fb-history-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  gap: 8px;
  padding: 12px 0;
}

.fb-history-item {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  background: var(--fb-bg-subtle);
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  text-decoration: none;
  color: inherit;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.fb-history-item:hover {
  background: var(--fb-bg-subtle-hover);
  border-color: var(--fb-border);
}

/*
 * v13 说明：曾有 .fb-history-item-header（标题 + 标签行的两端对齐包裹层），
 * renderHistoryIssueRow 改用 .fb-history-row 后该类名在 src/ 与 test/ 中已无任何生产者，
 * 故删除旧规则，避免留下不可达样式。
 */

.fb-history-title {
  font-weight: 600;
  font-size: 13px;
  overflow-wrap: anywhere;
  white-space: normal;
  line-height: 1.5;
}

.fb-history-tags {
  display: flex;
  gap: 4px;
  align-items: center;
}

.fb-tag {
  display: inline-flex;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--fb-border);
  color: var(--fb-text-secondary);
}

.fb-tag.waiting-admin {
  background: var(--fb-status-warn-bg);
  color: var(--fb-status-warn-text);
}

.fb-tag.waiting-user {
  background: var(--fb-status-success-bg);
  color: var(--fb-status-success-text);
}

.fb-tag.resolved {
  background: var(--fb-bg-subtle-hover);
  color: var(--fb-text-secondary);
}

.fb-dialogue-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.fb-dialogue-header {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 12px;
  border-bottom: 1px solid var(--fb-border);
}

.fb-dialogue-messages {
  flex: 1;
  min-height: 80px;
  overscroll-behavior: contain;
  overflow-y: auto;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fb-dialogue-msg {
  position: relative;
  margin-left: 20px;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  flex-shrink: 0;
}

.fb-dialogue-msg::before { content: ''; position: absolute; left: -17px; top: 0; height: calc(100% + 10px); border-left: 2px solid var(--fb-border); }
.fb-dialogue-msg:last-child::before { height: 100%; }
.fb-dialogue-msg::after { content: ''; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; border: 2px solid var(--fb-accent); border-radius: 50%; background: var(--fb-bg); }
.fb-dialogue-msg.system::after { border-color: var(--fb-status-warn-text); }

.fb-dialogue-msg.user {
  background: var(--fb-bg-subtle);
  border-left: 3px solid var(--fb-accent);
}

.fb-dialogue-msg.admin {
  background: var(--fb-bg-subtle);
  border-left: 3px solid var(--fb-accent);
}

.fb-dialogue-msg.system {
  background: var(--fb-status-warn-bg);
  border-left: 3px solid var(--fb-status-warn-text);
}

.fb-dialogue-msg-meta {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--fb-text-secondary);
  margin-bottom: 6px;
}

.fb-dialogue-reply-box {
  flex-shrink: 0;
  max-height: 48%;
  overflow-y: auto;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--fb-border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-history-item { flex-shrink: 0; min-height: 44px; }
.fb-history-item:focus-visible { outline: 2px solid var(--fb-focus-ring); outline-offset: -2px; }
.fb-history-preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.5; }
.fb-history-date { overflow-wrap: anywhere; line-height: 1.5; }
.fb-dialogue-toolbar { display: flex; justify-content: space-between; gap: 8px; flex-shrink: 0; padding: 8px 0; border-bottom: 1px solid var(--fb-border); }
.fb-dialogue-toolbar .fb-btn-secondary, .fb-dialogue-reply-box .fb-btn-secondary, .fb-history-filter-row .fb-btn-secondary { min-height: 44px; padding: 8px 12px; font-size: 12px; }
.fb-dialogue-title { margin: 0; font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; }
.fb-dialogue-identity { margin: 0; font-size: 11px; line-height: 1.5; color: var(--fb-text-secondary); overflow-wrap: anywhere; }
.fb-dialogue-next-step { margin: 0; color: var(--fb-text-secondary); font-size: 12px; line-height: 1.5; }
.fb-dialogue-header, .fb-dialogue-messages > .fb-resolution-note { flex-shrink: 0; }
.fb-reply-label { font-size: 12px; font-weight: 600; }
.fb-dialogue-reply-box .fb-textarea { min-height: 64px; max-height: 120px; }
.fb-dialogue-reply-box .fb-submit, .fb-view-progress { min-height: 44px; flex-shrink: 0; }
.fb-dialogue-reply-box .fb-submit { position: sticky; bottom: 0; z-index: 1; }
.fb-reply-log { max-width: 100%; overflow-wrap: anywhere; text-align: left; }
.fb-submission-receipt { margin-bottom: 10px; overflow-wrap: anywhere; }
.fb-receipt-title { font-weight: 600; }
.fb-submission-receipt .fb-view-progress { margin-top: 8px; width: 100%; }

/* 键盘或横屏占去大部分高度时，让整个详情可滚动，避免固定区把补充操作裁掉。 */
@media (max-width: 767.98px) and (max-height: 400px) {
  .fb-dialogue-view { overflow-y: auto; overscroll-behavior: contain; }
  .fb-dialogue-toolbar { position: sticky; top: 0; z-index: 2; background: var(--fb-bg); }
  .fb-dialogue-messages { flex: 0 0 auto; min-height: 0; overflow: visible; }
  .fb-dialogue-reply-box { max-height: none; overflow: visible; }
  .fb-dialogue-reply-box .fb-submit { position: static; }
}
.fb-submission-receipt .fb-receipt-new { margin-top: 8px; width: 100%; min-height: 44px; }
.fb-body.has-submitted-feedback > .fb-prompt,
.fb-body.has-submitted-feedback > .fb-textarea-wrap,
.fb-body.has-submitted-feedback > .fb-shot-area,
.fb-body.has-submitted-feedback > .fb-logs-area,
.fb-body.has-submitted-feedback > .fb-footer { display: none; }

/* 窄屏（移动端全屏面板）：设置操作按钮给到触屏可点的高度 */
@media (max-width: 767.98px) {
  .fb-settings-actions .fb-btn-secondary {
    padding: 8px 14px;
    font-size: 13px;
  }
}

/* ---- 尊重 prefers-reduced-motion ----
   灵感球：取消光晕流动与缩放（拖动平移是功能反馈，保留）。 */
@media (prefers-reduced-motion: reduce) {
  .fb-launcher,
  .fb-panel,
  .fb-submit,
  .fb-close {
    transition: none !important;
  }
  .fb-tab-launcher:hover,
  .fb-tab-launcher:active,
  .fb-submit:active {
    transform: none !important;
  }
  .fb-orb {
    --fb-orb-breath: 0;
    /* 基础直径恒为 56，焦点环因此恒为 64；热区与 1:1 平移不受影响。 */
    --fb-orb-state-scale: 1 !important;
    --fb-orb-drag-angle: 0rad !important;
    --fb-orb-stretch-along: 1 !important;
    --fb-orb-glow-x: 0px !important;
    --fb-orb-glow-y: 0px !important;
    animation: none !important;
    transition: none !important;
  }
  /* 视觉组不缩放或方向拉伸，但 root 的 1:1 指针平移保留——那是功能反馈。 */
  .fb-orb-bloom,
  .fb-orb-glow,
  .fb-orb-sweep,
  .fb-orb-core {
    scale: 1 !important;
    transform: none !important;
  }
  .fb-orb-glow {
    translate: 0px 0px !important;
    animation: none !important;
  }
  .fb-orb-sweep::before {
    transform: rotate(0deg) !important;
    animation: none !important;
  }
}

/* ---- v12 全屏图片编辑器 ----
   覆盖在面板与放大预览之上；深色工作台以保证任何截图内容都有可比性。 */
.fb-editor {
  position: fixed;
  inset: 0;
  z-index: 2147483200;
  display: flex;
  flex-direction: column;
  background: #1c1c1e;
  color: #f5f5f7;
}

.fb-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  flex-wrap: wrap;
}

.fb-editor-tools {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.fb-editor-tool {
  min-height: 44px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: transparent;
  color: #f5f5f7;
  cursor: pointer;
  transition: background 0.15s;
}

.fb-editor-tool:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.fb-editor-tool.is-active {
  background: var(--fb-accent);
  border-color: var(--fb-accent);
  color: #fff;
}

.fb-editor-tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fb-editor-tool:focus-visible,
.fb-editor-btn:focus-visible {
  outline: 2px solid var(--fb-focus-ring);
  outline-offset: 2px;
}

.fb-editor-actions {
  display: flex;
  gap: 8px;
}

.fb-editor-btn {
  min-height: 44px;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: transparent;
  color: #f5f5f7;
  cursor: pointer;
}

.fb-editor-btn.is-primary {
  background: var(--fb-accent);
  border-color: var(--fb-accent);
  color: #fff;
}

.fb-editor-btn.is-primary:hover:not(:disabled) {
  background: var(--fb-accent-hover);
}

.fb-editor-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fb-editor-main {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 16px;
  min-height: 0;
  container-type: inline-size;
}

.fb-editor-stage {
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

/* T2：独立的「裁剪结果」预览 + 输出尺寸（桌面右侧 280px） */
.fb-editor-result {
  flex: 0 0 280px;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  background: #2c2c2e;
  overflow: hidden;
}

.fb-editor-result-title {
  font-size: 12px;
  color: #98989d;
}

.fb-editor-preview {
  flex: 1 1 auto;
  min-height: 0;
  max-width: 100%;
  max-height: 100%;
  align-self: center;
  background:
    repeating-conic-gradient(#3a3a3c 0% 25%, #2c2c2e 0% 50%) 0 / 16px 16px;
  border-radius: 8px;
}

.fb-editor-result-size {
  font-size: 12px;
  color: #c7c7cc;
  font-variant-numeric: tabular-nums;
}

/* 窄屏（768px 以下）或容器过窄：上下排列，结果区高 160px */
@container (max-width: 767px) {
  .fb-editor-stage {
    flex: 1 1 100%;
  }
  .fb-editor-result {
    flex: 1 1 100%;
    min-width: 0;
    height: 160px;
  }
}

@media (max-width: 767.98px) {
  .fb-editor-stage {
    flex: 1 1 100%;
  }
  .fb-editor-result {
    flex: 1 1 100%;
    min-width: 0;
    height: 160px;
  }
}

.fb-editor-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background:
    repeating-conic-gradient(#3a3a3c 0% 25%, #2c2c2e 0% 50%) 0 / 16px 16px;
  border-radius: 4px;
  cursor: crosshair;
  touch-action: none; /* 指针绘制不被手势滚动抢占 */
}

.fb-editor-cropbar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  background: #1c1c1e;
}

/* 存在未应用选区时禁用「保存」的原因说明 */
.fb-editor-save-hint {
  font-size: 12px;
  color: #ff9f0a;
  line-height: 1.3;
  max-width: 240px;
}

.fb-editor-crop-hint {
  font-size: 12px;
  color: #98989d;
}

.fb-editor-hint {
  margin: 0;
  padding: 8px 16px 12px;
  font-size: 11px;
  color: #98989d;
  text-align: center;
}

/* ---- v12 我的反馈：筛选与分页 ---- */
.fb-history-filter-row {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 8px 0;
}

.fb-history-filter {
  flex: 1;
  min-height: 44px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  color: var(--fb-text);
  background: var(--fb-bg);
  border: 1px solid var(--fb-border-strong);
  border-radius: 8px;
}

.fb-history-filter:focus-visible {
  outline: 2px solid var(--fb-focus-ring);
  outline-offset: 1px;
}

.fb-history-items {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overscroll-behavior: contain;
  overflow-y: auto;
}

.fb-history-pager {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 0;
}

.fb-history-pager .fb-btn-secondary {
  min-height: 44px;
  padding: 6px 14px;
  font-size: 12px;
}

.fb-history-page-info {
  font-size: 12px;
  color: var(--fb-text-secondary);
}

/* ---- v12 处理说明 ---- */
.fb-resolution-note {
  margin: 6px 0 0;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fb-status-success-text);
  background: var(--fb-status-success-bg);
  border: 1px solid var(--fb-status-success-border);
  border-radius: 8px;
  white-space: pre-wrap;
}

/* ---- v12 对话附件与回复图片 ---- */
.fb-dialogue-attachment-img {
  max-height: 100px;
  border-radius: 4px;
  border: 1px solid var(--fb-border);
}

.fb-reply-images {
  margin-top: 2px;
}

.fb-reply-thumb {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.fb-reply-thumb-img {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: 6px;
  border: 1px solid var(--fb-border);
  cursor: zoom-in;
}
/* ---- T1 局部选区覆盖层（冻结画面 + 可调整选区 + 三个操作） ---- */
.fb-region-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 30);
  overflow: hidden;
  background: #000;
  cursor: crosshair;
}

.fb-region-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill; /* 冻结位图铺满覆盖层：与 0..1 归一化坐标一一对应 */
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.fb-region-frame {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.95);
  /* 外部暗化遮罩（覆盖层 overflow:hidden 限制在视口内） */
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
  cursor: move;
}

.fb-region-frame:focus-visible {
  outline: 2px solid var(--fb-accent);
  outline-offset: 2px;
}

.fb-region-handle {
  position: absolute;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.55);
  border-radius: 3px;
}

/* 命中区扩到 ~34px（键盘等价操作：Shift+方向键缩放） */
.fb-region-handle::after {
  content: "";
  position: absolute;
  inset: -10px;
}

.fb-region-handle[data-handle="nw"] { left: -7px; top: -7px; cursor: nwse-resize; }
.fb-region-handle[data-handle="n"] { left: 50%; top: -7px; margin-left: -7px; cursor: ns-resize; }
.fb-region-handle[data-handle="ne"] { right: -7px; top: -7px; cursor: nesw-resize; }
.fb-region-handle[data-handle="e"] { right: -7px; top: 50%; margin-top: -7px; cursor: ew-resize; }
.fb-region-handle[data-handle="se"] { right: -7px; bottom: -7px; cursor: nwse-resize; }
.fb-region-handle[data-handle="s"] { left: 50%; bottom: -7px; margin-left: -7px; cursor: ns-resize; }
.fb-region-handle[data-handle="sw"] { left: -7px; bottom: -7px; cursor: nesw-resize; }
.fb-region-handle[data-handle="w"] { left: -7px; top: 50%; margin-top: -7px; cursor: ew-resize; }

.fb-region-toolbar {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  max-width: calc(100vw - 32px);
  padding: 12px 16px;
  border-radius: 16px;
  background: rgba(28, 28, 30, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  cursor: default;
}

.fb-region-size {
  font-size: 12px;
  color: #c7c7cc;
  font-variant-numeric: tabular-nums;
}

.fb-region-btn {
  min-height: 44px;
  padding: 0 16px;
  border-radius: 980px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: transparent;
  color: #f5f5f7;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.fb-region-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.fb-region-use {
  background: var(--fb-accent);
  border-color: var(--fb-accent);
  color: #fff;
}

.fb-region-use:hover {
  background: var(--fb-accent-hover);
}

.fb-region-btn:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.fb-region-error {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 2;
  margin: 0;
  max-width: calc(100vw - 32px);
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: #ff453a;
  background: rgba(255, 69, 58, 0.16);
  border: 1px solid rgba(255, 69, 58, 0.4);
}

/* ---- v13 我的反馈：简易 issue 行式列表 + 项目分组 ---- */

/*
 * 「待处理（open）」此前没有 chip 样式（只有 waiting-admin / waiting-user / resolved），
 * 行左边框也需要一个独立色，因此新增 info 令牌。
 * --fb-accent 等既有令牌**未做任何修改**，这里只是新增变量并在两套主题下各给一值；
 * chip 前景对叠加后的背景实测对比度：浅色 5.54:1、深色 5.17:1（均 ≥ WCAG AA 4.5:1）。
 */
:host {
  --fb-status-info-bg: rgba(0, 113, 227, 0.12);
  --fb-status-info-text: #0057ad;
}

:host([theme="dark"]) {
  --fb-status-info-bg: rgba(0, 113, 227, 0.22);
  --fb-status-info-text: #6cb2ff;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) {
    --fb-status-info-bg: rgba(0, 113, 227, 0.22);
    --fb-status-info-text: #6cb2ff;
  }
}

/* 行左边框 = 工单状态色（与同状态 chip 用同一组令牌，视觉一致） */
.fb-history-item.fb-issue-row {
  gap: 2px;
  border-left: 3px solid var(--fb-border);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.fb-history-item.fb-issue-row.fb-issue--open { border-left-color: var(--fb-status-info-text); }
.fb-history-item.fb-issue-row.fb-issue--waiting_user { border-left-color: var(--fb-status-success-text); }
.fb-history-item.fb-issue-row.fb-issue--waiting_admin { border-left-color: var(--fb-status-warn-text); }
.fb-history-item.fb-issue-row.fb-issue--resolved { border-left-color: var(--fb-text-tertiary); }

/* open 状态 chip 补修饰类（原来 open 落到 .fb-tag 默认灰，与其他状态不可辨） */
.fb-tag.open {
  background: var(--fb-status-info-bg);
  color: var(--fb-status-info-text);
}

/* 第一行：#编号 + 标题（省略号）+ 标签区，横向紧凑排布，440px 面板内不溢出 */
.fb-history-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fb-history-id {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--fb-text-tertiary);
}

/* 用复合选择器提高特异性，不改写既有 .fb-history-title 规则 */
.fb-issue-row .fb-history-title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fb-issue-row .fb-history-tags { flex: 0 0 auto; }

/* 预览与时间行：原先写在 JS 内联样式里，迁到类上 */
.fb-issue-row .fb-history-preview {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--fb-text-secondary);
}

.fb-issue-row .fb-history-date {
  font-size: 11px;
  color: var(--fb-text-tertiary);
}

.fb-history-meta,
.fb-history-time {
  font-size: 11px;
  color: var(--fb-text-tertiary);
}

/* 项目身份：色点 + 展示名。色值由 JS 按 appId 哈希写入 --fb-project-* 变量，
   前景仍取主题令牌，所以深浅两套主题都成立（chip 背景只是同色 16% 叠加）。 */
.fb-tag.fb-project-tag {
  align-items: center;
  gap: 4px;
  max-width: 140px;
  min-width: 0;
  background: var(--fb-project-chip-bg, var(--fb-border));
  color: var(--fb-text);
}

.fb-project-dot {
  flex: 0 0 auto;
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fb-project-color, var(--fb-text-tertiary));
  /* 深色主题下纯色点与背景边界靠内描边保持可辨 */
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.24);
}

.fb-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 分组：仅当前页内出现多个项目时渲染 */
.fb-history-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 与同列表内 .fb-history-item 的 flex-shrink: 0 保持一致：
     .fb-history-items 是 overflow-y:auto 的列向 flex 容器，缺这句时分组容器可能被压缩，
     sticky 分组头的可粘范围（= 本分组内容盒）也会跟着变短。 */
  flex-shrink: 0;
}

.fb-history-group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 2px;
  background: var(--fb-bg);
  border-bottom: 1px solid var(--fb-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--fb-text);
}

.fb-history-group-head .fb-history-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-history-group-head .fb-history-group-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--fb-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .fb-history-item.fb-issue-row,
  .fb-history-group-head,
  .fb-tag.fb-project-tag,
  .fb-tag.open {
    transition: none !important;
    animation: none !important;
  }
}
`;
