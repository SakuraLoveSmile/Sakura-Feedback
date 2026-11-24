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

  /* 0.8.2 新增：waiting_admin（等待回复）用的紫色系令牌，与其它状态同一组三段式结构。 */
  --fb-status-accent-bg: #f5f3ff;
  --fb-status-accent-border: #ddd6fe;
  --fb-status-accent-text: #6d28d9;

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

  --fb-status-accent-bg: rgba(191, 90, 242, 0.16);
  --fb-status-accent-border: rgba(191, 90, 242, 0.4);
  --fb-status-accent-text: #d8a8ff;
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

    --fb-status-accent-bg: rgba(191, 90, 242, 0.16);
    --fb-status-accent-border: rgba(191, 90, 242, 0.4);
    --fb-status-accent-text: #d8a8ff;
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

/* 56px → 104px；真实轮廓由液态透镜层绘制。 */
.fb-orb.is-dragging {
  --fb-orb-state-scale: 1.8571428571;
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
  width: calc(var(--fb-orb-summoned-size, 56px * var(--fb-orb-state-scale)) + 8px);
  height: calc(var(--fb-orb-summoned-size, 56px * var(--fb-orb-state-scale)) + 8px);
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
  background: transparent;
  border: 1px solid rgba(255,255,255,.65);
  box-shadow: none;
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

/* 控制 launcher 模式显示/隐藏（生效模式写入宿主 data-fb-mode） */
:host([data-fb-mode="beam"]) .fb-orb,
:host([data-fb-mode="beam"]) .fb-tab-launcher {
  display: none !important;
}

:host([data-fb-mode="tab"]) .fb-orb {
  display: none !important;
}

:host([data-fb-mode="orb"]) .fb-tab-launcher {
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

/* ---- 截图缩略图与操作（R5：一列横向卡片，72px真实缩略图） ----
   图片完整显示（contain，禁止 cover 二次裁切）；角标标「局部截图 / 已编辑」，
   尺寸读数显示输出像素；编辑、删除按钮在相邻信息栏，不得遮住图片内容。 */
.fb-screenshot-wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
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
  width: 72px;
  height: 72px;
  flex: 0 0 72px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--fb-bg-subtle);
}

/* 编辑 / 删除行（信息栏内）：触控目标 ≥44px，绝不覆盖图片内容。 */
.fb-thumb-actions {
  display: flex;
  gap: 8px;
  padding: 0;
  background: transparent;
}

.fb-thumb-edit,
.fb-thumb-remove {
  flex: 1;
  min-width: 44px;
  min-height: 44px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1;
  border: 0;
  border-radius: 8px;
  background: transparent;
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

/*
 * 宿主未接入 logProvider 时的说明（对齐 Flutter feedback-logs-no-provider）：
 * 说明「没有自动采集」而不是让「重新采集」按钮无声消失。
 * 只作说明文本：不占命中区、不进 Tab 顺序，随 [hidden] 全局兜底一起隐藏。
 */
.fb-logs-no-provider {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fb-text-tertiary);
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

/* ---- 关闭前确认层（0.14.0：关闭即放弃本次未提交反馈的误触保护） ----
   遮罩层挂在 shadow root（与上面的日志预览 / 放大预览同级），覆盖整个面板；
   卡片样式沿用设置视图内联确认块的令牌与描边按钮，深浅主题自动跟随。 */
.fb-close-confirm {
  position: fixed;
  inset: 0;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 30);
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

.fb-close-confirm-card {
  background: var(--fb-bg);
  color: var(--fb-text);
  border: 1px solid var(--fb-border);
  border-radius: 14px;
  box-shadow: var(--fb-shadow);
  padding: 18px 20px 16px;
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-close-confirm-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}

.fb-close-confirm-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--fb-text-secondary);
}

.fb-close-confirm-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

/* 「放弃」用警告色文字 + 描边，与「继续编辑」区分开（不改按钮尺寸与命中区） */
.fb-close-confirm-discard {
  color: var(--fb-status-error-text);
  border-color: var(--fb-status-error-border);
}

.fb-close-confirm-discard:hover {
  background: var(--fb-status-error-bg);
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

.fb-wake-settings { display:flex; flex-direction:column; gap:8px; min-width:0; }
.fb-wake-option { display:flex; align-items:center; gap:10px; min-height:44px; font-size:13px; color:var(--fb-text); cursor:pointer; }
.fb-wake-option input { flex:0 0 auto; width:16px; height:16px; accent-color:var(--fb-accent); }
.fb-wake-option input:focus-visible { outline:2px solid var(--fb-accent); outline-offset:3px; }
.fb-wake-option:has(input:disabled) { opacity:.6; cursor:default; }
.fb-wake-option-text { display:flex; flex-direction:column; gap:3px; min-width:0; overflow-wrap:anywhere; }
.fb-wake-option .fb-footnote, .fb-wake-settings > .fb-footnote { margin:0; }
.fb-wake-option-title { font-size:13px; font-weight:500; color:var(--fb-text); }
.fb-wake-desktop { display:flex; flex-direction:column; gap:8px; min-width:0; }
/* 只作说明的入口方式行：不是开关，不占用命中区与 Tab 顺序。 */
.fb-wake-fact { cursor:default; }
.fb-wake-hint { position:fixed; bottom:32px; left:50%; transform:translateX(-50%); max-width:calc(100vw - 32px); padding:10px 16px; border-radius:10px; background:var(--fb-bg); color:var(--fb-text); border:1px solid var(--fb-border); font-size:13px; pointer-events:none; z-index:calc(var(--fb-z-index, var(--fb-z-index-default)) + 32); }
.fb-region-entrance { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }

/* ---- 首次使用入口提示（0.13；有可见入口时只出现一次） ---- */
.fb-entry-hint {
  position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:8px; max-width:min(360px, calc(100vw - 32px));
  padding:10px 8px 10px 14px; border:1px solid var(--fb-border); border-radius:12px;
  background:var(--fb-bg); color:var(--fb-text); box-shadow:var(--fb-shadow);
  font-size:13px; line-height:1.4;
  z-index:calc(var(--fb-z-index, var(--fb-z-index-default)) + 34);
}
.fb-entry-hint-text { min-width:0; overflow-wrap:anywhere; }
.fb-entry-hint-close {
  flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent;
  color:var(--fb-text-tertiary); font:inherit; font-size:16px; line-height:1; cursor:pointer;
}
.fb-entry-hint-close:hover { background:rgba(127,127,127,.14); color:var(--fb-text); }
.fb-entry-hint-close:focus-visible { outline:2px solid var(--fb-accent); outline-offset:2px; }

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
  flex: 0 0 auto;
  width: 100%;
}

.fb-settings-error {
  margin: 0;
  font-size: 12px;
  color: var(--fb-status-error-text);
  line-height: 1.4;
}

.fb-settings-hint, .fb-wake-availability, .fb-wake-pref-hint {
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
/*
 * 行内「未读」文本小标签（.fb-badge.fb-history-unread）的基底。
 * 0.8.2 起入口不再有未读数字角标（相关角标定位 / 兜底规则已整体删除），
 * .fb-badge 只服务历史列表行内的小标签。
 */
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
  background: var(--fb-status-accent-bg);
  color: var(--fb-status-accent-text);
  border: 1px solid var(--fb-status-accent-border);
}

.fb-tag.waiting-user {
  background: var(--fb-status-info-bg);
  color: var(--fb-status-info-text);
  border: 1px solid var(--fb-status-info-border);
}

/* 0.8.2：已解决从灰改为绿色（与行左边框 success 同源），不再与「无状态」混淆 */
.fb-tag.resolved {
  background: var(--fb-status-success-bg);
  color: var(--fb-status-success-text);
  border: 1px solid var(--fb-status-success-border);
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
  flex-wrap: wrap;
  align-items: center;
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

/*
 * v0.8.2 一键已读的 role=status 提示（默认 hidden；成功为 success 色，失败加 .is-error）。
 * 440px 面板里过滤行允许换行（见 .fb-history-filter-row 的 flex-wrap），提示占满一行，
 * 因此不会把「一键已读」按钮挤出可见区域。
 */
.fb-history-read-hint {
  margin: 0;
  padding: 0 0 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fb-status-success-text);
}

.fb-history-read-hint.is-error {
  color: var(--fb-status-error-text);
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
/* Liquid lens is a transparent premultiplied WebGL layer; never samples the live backdrop. */
.fb-orb-lens {
  position: fixed;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 31);
  pointer-events: none;
  user-select: none;
}
.fb-orb.has-lens { animation: none; --fb-orb-breath: 0; --fb-orb-breath-weight: 0; }
.fb-orb.has-lens .fb-orb-bloom,
.fb-orb.has-lens .fb-orb-glow,
.fb-orb.has-lens .fb-orb-sweep { display: none; }
.fb-orb.has-lens .fb-orb-core { opacity: 0; }
.fb-orb.is-dragging { animation: none; }
.fb-orb.is-dragging .fb-orb-bloom,
.fb-orb.is-dragging .fb-orb-glow,
.fb-orb.is-dragging .fb-orb-sweep { display: none; }
.fb-orb.is-dragging .fb-orb-core { scale: 1.8571428571; }
@media (prefers-reduced-motion: reduce) { .fb-orb.is-dragging .fb-orb-core { scale: 1.8571428571 !important; } }
.fb-region-overlay {
  --fb-selection-scrim:#161616;
  --fb-selection-surface:#242725;
  --fb-selection-mint:#b7f2d8;
  position: fixed;
  inset: 0;
  z-index: calc(var(--fb-z-index, var(--fb-z-index-default)) + 30);
  overflow: hidden;
  background: #000;
  cursor: crosshair;
  touch-action: none;
}
.fb-region-bg {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill;
  pointer-events: none; user-select: none; -webkit-user-drag: none;
}
.fb-region-dim { position:absolute; background:transparent; box-shadow:0 0 0 9999px var(--fb-selection-scrim); opacity:0; pointer-events:none; }
.fb-beam { position:absolute; inset:0; overflow:hidden; pointer-events:none; opacity:0; }
.fb-beam.is-water-fallback {
  --fb-water-arcs: repeating-conic-gradient(from var(--fb-water-angle, 0deg) at var(--fb-wake-origin), black 0deg, #000a 30.6deg, #fff5 68.4deg 111.6deg, #000a 149.4deg, black 180deg);
  -webkit-mask-image:var(--fb-water-arcs); mask-image:var(--fb-water-arcs);
}
.fb-wake-spectrum { mix-blend-mode:plus-lighter; }
.fb-wake-highlights { mix-blend-mode:darken; }
.fb-ripple-wave:first-child { filter:brightness(.965); }
.fb-ripple-wave:last-child { filter:contrast(.93) brightness(1.035); }
.fb-beam > canvas { display:block; width:100%; height:100%; }
.fb-beam > div { position:absolute; inset:0; -webkit-mask-image:var(--fb-wave-mask); mask-image:var(--fb-wave-mask); }
.fb-lasso-layer { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.fb-lasso-guide {
  display:none; fill:none; stroke-linecap:round; stroke-dasharray:1 1;
  --fb-guide-time:1120ms;
  --fb-guide-travel:fb-guide-travel var(--fb-guide-time) cubic-bezier(.32,0,.22,1) both;
}
.fb-lasso-guide.is-playing { display:block; animation:fb-guide-fade var(--fb-guide-time) ease-out both; }
.fb-lasso-guide.is-playing :is(.fb-guide-edge, .fb-guide-ink) { animation:var(--fb-guide-travel); }
.fb-guide-edge { stroke:#245c58; stroke-opacity:.58; stroke-width:3.8; }
.fb-guide-ink { stroke:url(#fb-lasso-guide-ink) #73cbb3; stroke-width:2.5; }
.fb-guide-halo, .fb-guide-tip {
  --fb-guide-from:0; --fb-guide-to:-.999; stroke-dasharray:.001 2;
}
.fb-lasso-guide.is-playing :is(.fb-guide-halo, .fb-guide-tip) {
  animation:var(--fb-guide-travel), fb-guide-lift var(--fb-guide-time) linear both;
}
.fb-guide-halo { stroke:#86e6c9; stroke-width:10; stroke-opacity:.3; }
.fb-guide-tip { stroke:#f0fff9; stroke-width:3.8; filter:drop-shadow(0 0 .9px #458e82); }
@keyframes fb-guide-travel {
  0%, 4% { stroke-dashoffset:var(--fb-guide-from,1); }
  74%, 100% { stroke-dashoffset:var(--fb-guide-to,0); }
}
@keyframes fb-guide-fade {
  0%, 100% { opacity:0; }
  6%, 82% { opacity:1; }
}
@keyframes fb-guide-lift {
  0%, 80%, 100% { opacity:0; }
  6%, 67% { opacity:1; }
}
.fb-lasso { stroke:white; stroke-width:2; filter:drop-shadow(0 0 1.4px #171717); stroke-linecap:round; stroke-linejoin:round; }
.fb-lasso-hint {
  position:absolute; inset:auto 0 0; z-index:2; display:flex; align-items:center; justify-content:center; gap:8px;
  padding:0 12px calc(14px + env(safe-area-inset-bottom,0px)); color:var(--fb-hint-ink,var(--fb-text));
  text-shadow:0 .7px 1.5px var(--fb-hint-edge,var(--fb-bg)),0 -.7px 1.5px var(--fb-hint-edge,var(--fb-bg));
  font-size:14px; font-weight:600; pointer-events:none;
}
.fb-lasso-hint[data-ink="light"] { --fb-hint-ink:white; --fb-hint-edge:#262628; }
.fb-lasso-hint[data-ink="dark"] { --fb-hint-ink:#252528; --fb-hint-edge:white; }
.fb-lasso-hint svg { filter:drop-shadow(0 0 1px var(--fb-hint-edge,var(--fb-bg))); flex:none; width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.fb-region-overlay.is-drawing .fb-region-cancel,
.fb-region-overlay.is-lasso-pending .fb-region-frame,
.fb-region-overlay.is-lasso-pending .fb-region-tools,
.fb-region-overlay.is-lasso-arming .fb-region-cancel { visibility:hidden; }
.fb-beam-a11y {
  position:fixed; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
  clip-path:inset(50%); white-space:nowrap; border:0;
}
@media (prefers-reduced-motion: reduce) { .fb-beam, .fb-lasso-guide.is-playing { display:none; } }
.fb-region-frame {
  position: absolute; box-sizing: border-box; border: 1px solid var(--fb-selection-mint);
  border-radius: 12px; cursor: move;
}
.fb-region-frame:focus-visible { outline: 2px solid var(--fb-selection-surface); outline-offset: 2px; }
.fb-region-handle { position:absolute; width:30px; height:30px; box-sizing:border-box; }
.fb-region-handle::after { content:""; position:absolute; inset:0; margin:auto; width:9px; height:9px; box-sizing:border-box; border:1.5px solid var(--fb-selection-surface); border-radius:50%; background:var(--fb-selection-mint); }
.fb-region-handle[data-handle="nw"] { left:-15px; top:-15px; cursor:nwse-resize; }
.fb-region-handle[data-handle="ne"] { right:-15px; top:-15px; cursor:nesw-resize; }
.fb-region-handle[data-handle="sw"] { left:-15px; bottom:-15px; cursor:nesw-resize; }
.fb-region-handle[data-handle="se"] { right:-15px; bottom:-15px; cursor:nwse-resize; }
.fb-region-handle[data-handle="nw"]::after { transform:translate(3px,3px); }
.fb-region-handle[data-handle="ne"]::after { transform:translate(-3px,3px); }
.fb-region-handle[data-handle="sw"]::after { transform:translate(3px,-3px); }
.fb-region-handle[data-handle="se"]::after { transform:translate(-3px,-3px); }
.fb-region-tools {
  position:absolute; z-index:2; cursor:default; display:flex; flex-direction:column;
  gap:8px; box-sizing:border-box; padding:8px; border-radius:26px;
  border:1px solid #ffffff38; background:var(--fb-selection-surface); color:#f5f7f6;
  box-shadow:0 4px 16px #0003; overflow:auto;
}
.fb-region-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.fb-region-btn { border:0; font:inherit; font-size:13px; cursor:pointer; }
.fb-region-use, .fb-region-all { flex:1 1 100px; min-width:0; min-height:44px; border-radius:22px; padding:10px; overflow-wrap:anywhere; }
.fb-region-use { background:var(--fb-selection-mint); color:#14372b; font-weight:600; }
.fb-region-use:hover { background:#cef8e6; }
.fb-region-use:disabled, .fb-region-all:disabled { opacity:.55; cursor:wait; }
.fb-region-all { color:#f5f7f6; background:transparent; }
.fb-region-cancel { position:absolute; right:max(16px,env(safe-area-inset-right,0px)); top:max(16px,env(safe-area-inset-top,0px)); z-index:3; width:44px; height:44px; border-radius:50%; border:1px solid #ffffff38; background:var(--fb-selection-surface); color:white; font-size:25px; box-shadow:var(--fb-tab-shadow); }
.fb-region-btn:focus-visible { outline:2px solid var(--fb-selection-mint); outline-offset:2px; }
.fb-region-error { position:absolute; z-index:3; left:16px; right:16px; bottom:max(16px,env(safe-area-inset-bottom,0px)); margin:0; padding:8px 12px; border-radius:8px; font-size:12px; color:var(--fb-status-error-text); background:var(--fb-status-error-bg); }
.fb-safe-insets { position:fixed; width:0; height:0; visibility:hidden; pointer-events:none; padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px); }
.is-editor .fb-region-frame { border-color:#ffffffe8; box-shadow:0 0 0 1px #0002; }
.is-editor.is-pointer-selection .fb-region-frame:focus-visible { outline:none; }
.is-editor .fb-region-handle { z-index:3; }
.is-editor .fb-region-handle::after {
  width:14px; height:14px; border:solid white; border-width:2.5px 0 0 2.5px; border-radius:2px 0 0 0;
  background:transparent; filter:drop-shadow(0 0 1px #0009); transform:translate(6px,6px);
}
.is-editor .fb-region-handle[data-handle="ne"]::after { transform:translate(-6px,6px) rotate(90deg); }
.is-editor .fb-region-handle[data-handle="sw"]::after { transform:translate(6px,-6px) rotate(-90deg); }
.is-editor .fb-region-handle[data-handle="se"]::after { transform:translate(-6px,-6px) rotate(180deg); }
.is-editor .fb-region-tools {
  inset:auto 0 0; width:100%; padding:0 max(12px,env(safe-area-inset-right,0px)) calc(10px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px));
  border:0; border-radius:0; box-shadow:none; background:transparent;
  pointer-events:none;
}
.is-editor.tools-at-top .fb-region-tools {
  inset:0 0 auto; padding-top:calc(10px + env(safe-area-inset-top,0px)); padding-bottom:0;
}
.is-editor.tools-floating .fb-region-tools { inset:auto; padding:0; }
.is-editor.tools-floating .fb-region-toolbar { pointer-events:auto; }
.is-editor .fb-region-toolbar { flex-wrap:nowrap; gap:6px; overflow:auto; }
.is-editor .fb-region-toolbar button {
  display:inline-flex; align-items:center; justify-content:center; gap:6px; flex:none; pointer-events:auto;
  min-height:44px; min-width:44px; padding:0 10px; color:white; background:#272727c4; border-radius:22px; font-size:14px; font-weight:600;
}
.is-editor .fb-region-toolbar svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.is-editor .fb-region-toolbar .fb-region-use { margin-left:auto; padding:0 18px; background:white; color:#202020; }
.is-editor .fb-region-redraw:disabled { opacity:.55; }
.is-editor .fb-region-cancel { background:#272727b3; box-shadow:none; }
.is-editor.tools-at-top .fb-region-cancel { top:auto; bottom:max(12px,env(safe-area-inset-bottom,0px)); }
.is-editor .fb-region-error { position:static; margin-inline:auto; pointer-events:auto; }
.is-editor .fb-region-btn:focus-visible { outline-color:currentColor; outline-offset:-4px; }
@media (min-width:720px) {
  .is-editor .fb-region-toolbar { width:min(100%,680px); margin:auto; }
}
.fb-region-overlay.is-handoff { cursor:default; pointer-events:none; }
.fb-region-overlay.is-handoff .fb-region-dim { inset:0 !important; width:100% !important; height:100% !important; border-radius:0 !important; background:var(--fb-selection-scrim); box-shadow:none; }
.fb-region-overlay.is-handoff .fb-region-frame,
.fb-region-overlay.is-handoff .fb-region-tools,
.fb-region-overlay.is-handoff .fb-region-cancel { display:none; }
.fb-panel.is-handoff { z-index:calc(var(--fb-z-index, var(--fb-z-index-default)) + 31); }
.fb-panel.is-handoff[inert] { pointer-events:none; }
.fb-panel .is-entering { opacity:var(--fb-attachment-opacity, 0); }
.fb-flying-shot { position:fixed; z-index:calc(var(--fb-z-index, var(--fb-z-index-default)) + 32); pointer-events:none; object-fit:fill; }
@media (pointer:coarse) {
  .fb-region-use, .fb-region-all { min-height:44px; }
  .fb-region-cancel { width:44px; height:44px; }
  .fb-region-handle { width:44px; height:44px; }
  .fb-region-handle[data-handle="nw"], .fb-region-handle[data-handle="ne"] { top:-22px; }
  .fb-region-handle[data-handle="sw"], .fb-region-handle[data-handle="se"] { bottom:-22px; }
  .fb-region-handle[data-handle="nw"], .fb-region-handle[data-handle="sw"] { left:-22px; }
  .fb-region-handle[data-handle="ne"], .fb-region-handle[data-handle="se"] { right:-22px; }
}
@media (forced-colors:active) {
  .fb-orb-lens { display:none !important; }
  .fb-orb .fb-orb-core { opacity:1; background:Canvas; border:2px solid ButtonText; forced-color-adjust:none; }
  .fb-orb-focus-ring { border-color:Highlight; }
  .fb-region-frame { border:2px solid Highlight; }
  .fb-region-frame:focus-visible { outline-color:Highlight; }
  .fb-region-handle::after { border-color:ButtonText; background:Highlight; }
  .fb-lasso { stroke:Highlight; }
  .fb-region-toolbar, .fb-region-cancel { background:Canvas; color:ButtonText; border:1px solid ButtonText; }
  .fb-region-use { background:Highlight; color:HighlightText; }
  .fb-region-all { background:Canvas; color:ButtonText; text-shadow:none; }
}

/* ---- v13 我的反馈：简易 issue 行式列表 + 项目分组 ---- */

/*
 * 0.8.2：四种问题状态各用一组独立令牌，chip 与行左边框同源（同色系浅底 + 同色文字 + 1px 同色边框）：
 *   open 待处理 = 琥珀（warn）／waiting_user 待补充 = 蓝（info）
 *   waiting_admin 等待回复 = 紫（accent）／resolved 已解决 = 绿（success）
 * info 令牌的 border 在 0.8.2 补齐（此前只有 bg/text）；accent 令牌在主令牌区按三套主题各给一值。
 * chip 前景对**合成后**背景的 WCAG 对比度（正文口径 ≥ 4.5:1）：
 *   浅色 open 4.78、waiting_user 6.00、waiting_admin 6.48、resolved 4.79；
 *   深色 open 6.24、waiting_user 6.17、waiting_admin 7.27、resolved 6.35（见交付报告计算过程）。
 */
:host {
  --fb-status-info-bg: rgba(0, 113, 227, 0.12);
  --fb-status-info-border: rgba(0, 113, 227, 0.32);
  --fb-status-info-text: #0057ad;
}

:host([theme="dark"]) {
  --fb-status-info-bg: rgba(0, 113, 227, 0.22);
  --fb-status-info-border: rgba(0, 113, 227, 0.5);
  --fb-status-info-text: #6cb2ff;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) {
    --fb-status-info-bg: rgba(0, 113, 227, 0.22);
    --fb-status-info-border: rgba(0, 113, 227, 0.5);
    --fb-status-info-text: #6cb2ff;
  }
}

/* 行左边框 = 工单状态色（与同状态 chip 用同一组令牌，视觉一致） */
.fb-history-item.fb-issue-row {
  gap: 2px;
  border-left: 3px solid var(--fb-border);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.fb-history-item.fb-issue-row.fb-issue--open { border-left-color: var(--fb-status-warn-text); }
.fb-history-item.fb-issue-row.fb-issue--waiting_user { border-left-color: var(--fb-status-info-text); }
.fb-history-item.fb-issue-row.fb-issue--waiting_admin { border-left-color: var(--fb-status-accent-text); }
.fb-history-item.fb-issue-row.fb-issue--resolved { border-left-color: var(--fb-status-success-text); }

/* 待处理 chip（open）：琥珀；其余三种在 v11 区块里同样补齐了 1px 同色边框 */
.fb-tag.open {
  background: var(--fb-status-warn-bg);
  color: var(--fb-status-warn-text);
  border: 1px solid var(--fb-status-warn-border);
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

/* R5: neutral standby, optional idle entry, and compact feedback surfaces. */
.fb-orb {
  /* Focus and hit surface sit above the independent glass canvas. */
  z-index:calc(var(--fb-z-index, var(--fb-z-index-default)) + 32);
  bottom:clamp(max(16px,env(safe-area-inset-bottom,0px)),var(--fb-launcher-bottom,25%),calc(100dvh - max(72px,env(safe-area-inset-top,0px) + 56px)));
  right:max(20px,env(safe-area-inset-right,0px));
}
:host([side="left"]) .fb-orb { left:max(20px,env(safe-area-inset-left,0px)); right:auto; border:0; border-radius:50%; }
.fb-orb, .fb-orb.fb-orb-properties-unavailable { transition:transform .18s ease; }
.fb-orb.is-unavailable { display:none !important; }
/* 0.8.5「隐藏」只隐藏待机（收起）状态：完整球与唤醒后的球仍可见；兄弟 canvas/outline 由 drawLiquid() 同步收起。 */
.fb-orb.is-idle-hidden { display:none !important; }
/* R7 geometry/material are drawn together from the safe texture, never CSS backdrop. */
.fb-orb-idle-mark, .fb-orb-idle-handle { display:none; pointer-events:none; }
.fb-orb-hit { position:absolute; top:0; right:0; bottom:0; left:0; display:block; border-radius:0; background:transparent; pointer-events:auto; }
.fb-orb.is-collapsed { height:56px; min-height:56px; overflow:visible; cursor:pointer; }
.fb-orb.is-collapsed .fb-orb-bloom, .fb-orb.is-collapsed .fb-orb-glow, .fb-orb.is-collapsed .fb-orb-sweep, .fb-orb.is-collapsed .fb-orb-core { display:none; }
.fb-orb-entrance { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.fb-orb-entrance select { min-height:44px; padding:0 12px; font:inherit; color:inherit; background:var(--fb-bg); border:1px solid var(--fb-border); border-radius:8px; }
.fb-orb-idle-settings { margin:0; padding:0; border:0; min-width:0; display:flex; flex-direction:column; gap:8px; }
.fb-orb-idle-options { display:flex; flex-wrap:wrap; gap:8px; }
.fb-orb-idle-option { flex:1 1 110px; min-height:44px; display:flex; gap:8px; align-items:center; padding:8px 10px; box-sizing:border-box; border:1px solid var(--fb-border); border-radius:12px; background:var(--fb-bg-subtle); cursor:pointer; }
.fb-orb-idle-option:has(input:checked) { border-color:var(--fb-accent); color:var(--fb-accent); }
.fb-orb-idle-option input { accent-color:var(--fb-accent); }
.fb-orb-idle-option input:focus-visible { outline:2px solid var(--fb-accent); outline-offset:3px; }
.fb-orb-idle-settings .fb-footnote, .fb-orb-entrance-hint, .fb-orb-idle-pref-hint { margin:0; font-size:12px; color:var(--fb-text-secondary); }
.fb-header { padding:10px 16px; gap:8px; border-bottom:0; }
.fb-title-group { min-width:0; flex-wrap:wrap; gap:2px 8px; }
.fb-header h2 { font-size:18px; font-weight:600; }
.fb-header-meta { width:100%; margin-left:26px; font-size:11px; overflow-wrap:anywhere; }
.fb-header-actions { gap:4px; }
.fb-close, .fb-icon-btn { width:44px; height:44px; box-sizing:border-box; border:4px solid transparent; background-clip:padding-box; }
.fb-close::after, .fb-icon-btn::after { inset:0; }
.fb-nav-tabs { margin:0 16px 8px; height:44px; flex-shrink:0; gap:0; border-radius:12px; background:var(--fb-bg-subtle); }
.fb-nav-btn { flex:1; min-width:0; min-height:44px; justify-content:center; border-radius:10px; }
.fb-nav-btn.active { background:var(--fb-bg); box-shadow:inset 0 0 0 1px var(--fb-border); }
.fb-body { min-height:0; padding:8px 16px 0; gap:8px; }
.fb-prompt { font-size:14px; }
.fb-textarea-wrap { flex:0 0 auto; min-height:0; gap:8px; }
.fb-textarea { flex:0 0 auto; height:clamp(132px,22dvh,200px); min-height:132px; max-height:200px; border-radius:14px; overflow-y:auto; }
.fb-textarea:focus { background:var(--fb-bg-subtle); border-width:1.5px; box-shadow:0 0 0 1px var(--fb-focus-ring); }
.fb-counter { font-size:11px; }
.fb-screenshot-thumb-box { width:100%; box-sizing:border-box; flex-direction:row; align-items:center; gap:8px; padding:8px; border-radius:12px; background:var(--fb-bg); }
.fb-thumb-info { display:flex; flex:1; min-width:0; flex-direction:column; gap:4px; }
.fb-thumb-meta { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; }
.fb-screenshot-badge, .fb-screenshot-size { position:static; padding:0; background:transparent; color:var(--fb-text-secondary); backdrop-filter:none; -webkit-backdrop-filter:none; font-size:12px; letter-spacing:normal; }
.fb-screenshot-size { font-size:11px; color:var(--fb-text-tertiary); }
.fb-thumb-actions { flex-wrap:wrap; justify-content:flex-start; }
.fb-thumb-edit, .fb-thumb-remove { flex:0 1 auto; min-width:44px; min-height:44px; border:0; background:transparent; padding:0 8px; }
.fb-thumb-edit { color:var(--fb-accent); }
.fb-screenshot-zoom-hint { display:none; }
.fb-history-view { padding:8px 0; gap:8px; }
.fb-history-item.fb-issue-row { padding:14px; border:1px solid var(--fb-border); border-radius:14px; gap:8px; background:var(--fb-bg); }
.fb-history-row { flex-wrap:wrap; align-items:flex-start; }
.fb-issue-row .fb-history-title { font-size:15px; white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.45; }
.fb-issue-row .fb-history-tags { flex:1 0 100%; flex-wrap:wrap; gap:6px; }
.fb-issue-row .fb-history-preview { font-size:13px; margin:0; }
.fb-issue-row .fb-history-date { font-size:11px; }
.fb-history-item .fb-tag { font-size:12px; border-radius:6px; }
.fb-history-item .fb-project-tag { font-size:11px; }
.fb-history-unread { display:inline-flex; align-items:center; gap:5px; background:transparent; color:var(--fb-accent); font-size:11px; }
.fb-history-unread::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--fb-accent); }
.fb-history-filter-row { overflow-x:auto; flex-shrink:0; }
.fb-history-filter { flex:1 0 120px; height:44px; min-height:44px; box-sizing:border-box; padding:0 8px; border-width:6px; border-color:var(--fb-bg); border-radius:12px; background:var(--fb-bg-subtle); }
.fb-dialogue-title { font-size:18px; font-weight:600; }
.fb-dialogue-msg { max-width:85%; box-sizing:border-box; margin-left:0; padding:10px 12px; border-radius:14px; border:1px solid var(--fb-border); align-self:flex-start; }
.fb-dialogue-msg.user { align-self:flex-end; border-left:1px solid var(--fb-border); }
.fb-dialogue-msg.admin, .fb-dialogue-msg.system { border-left:1px solid var(--fb-border); }
.fb-dialogue-msg::before, .fb-dialogue-msg::after { display:none; }
.fb-dialogue-msg-meta { color:var(--fb-text-tertiary); }
.fb-dialogue-reply-box .fb-textarea { height:80px; min-height:64px; max-height:120px; }
@media (prefers-reduced-motion:reduce) {
  .fb-orb { transition:none !important; }
}
@media (forced-colors:active) {
  svg.fb-orb-lens.is-fallback-visible { display:block !important; forced-color-adjust:none; }
  .fb-orb .fb-orb-core { display:none !important; }
  .fb-region-tools { background:Canvas; color:ButtonText; border-color:ButtonText; }
}

/* ---- v14 面板视觉精修 ----
   参考管理后台现有的卡片 / 控件层级：发丝分隔、白色输入面、12–14px 圆角、
   安静的次要操作，以及统一的 4/8/12/16 间距。只改样式，不改 DOM、文案与行为。 */
:host {
  --fb-input-bg: #ffffff;
  --fb-card-bg: #f6f7f9;
  --fb-segment-bg: #ffffff;
  --fb-segment-text: #0062c4;
  --fb-shadow-card: 0 1px 2px rgba(16, 24, 40, 0.05);
  --fb-shadow-raised: 0 10px 28px -18px rgba(16, 24, 40, 0.35);
  --fb-shadow: 0 24px 64px -28px rgba(16, 24, 40, 0.45), 0 2px 8px rgba(16, 24, 40, 0.06);
}

:host([theme="dark"]) {
  --fb-input-bg: #242426;
  --fb-card-bg: #242426;
  --fb-segment-bg: #3a3a3c;
  --fb-segment-text: #6cb2ff;
  --fb-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --fb-shadow-raised: 0 12px 32px -18px rgba(0, 0, 0, 0.8);
  --fb-shadow: 0 28px 72px -28px rgba(0, 0, 0, 0.85), 0 2px 10px rgba(0, 0, 0, 0.45);
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) {
    --fb-input-bg: #242426;
    --fb-card-bg: #242426;
    --fb-segment-bg: #3a3a3c;
    --fb-segment-text: #6cb2ff;
    --fb-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
    --fb-shadow-raised: 0 12px 32px -18px rgba(0, 0, 0, 0.8);
    --fb-shadow: 0 28px 72px -28px rgba(0, 0, 0, 0.85), 0 2px 10px rgba(0, 0, 0, 0.45);
  }
}

/* 头部：品牌块 + 单行标题 / 元信息；设置与关闭共用一套圆形控件。 */
.fb-header { padding: 12px 16px 10px; gap: 10px; }
.fb-title-group { flex-wrap: nowrap; align-items: baseline; gap: 8px; }
.fb-header-icon {
  align-self: center;
  width: 30px;
  height: 30px;
  padding: 6px;
  box-sizing: border-box;
  border-radius: 9px;
  background: var(--fb-accent);
  color: #fff;
  fill: currentColor;
}
.fb-title-group h2 { font-size: 18px; line-height: 26px; letter-spacing: -0.02em; white-space: nowrap; }
.fb-title-group .fb-header-meta {
  width: auto;
  margin-left: 0;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--fb-text-secondary);
}
.fb-header-actions { gap: 6px; }
.fb-icon-btn { background: var(--fb-bg-subtle); }
.fb-close:hover,
.fb-icon-btn:hover { background: var(--fb-bg-subtle-hover); color: var(--fb-text); }

/* 分段页签：容器发丝描边，选中项为抬起的白色胶囊。 */
.fb-nav-tabs {
  margin: 2px 16px 10px;
  border-radius: 12px;
  background: var(--fb-bg-subtle);
  box-shadow: inset 0 0 0 1px var(--fb-border);
}
.fb-nav-btn {
  font-size: 13px;
  font-weight: 500;
  border-radius: 10px;
  transition: background 0.15s ease, color 0.15s ease;
}
.fb-nav-btn:hover { background: var(--fb-bg-subtle-hover); }
.fb-nav-btn.active {
  background: var(--fb-segment-bg);
  color: var(--fb-segment-text);
  font-weight: 600;
  box-shadow: var(--fb-shadow-card), inset 0 0 0 1px var(--fb-border);
}

/* 主体：略松的节奏与更轻的滚动条。 */
.fb-body {
  padding: 12px 16px 0;
  gap: 12px;
  scrollbar-width: thin;
  scrollbar-color: var(--fb-border-strong) transparent;
}
.fb-body::-webkit-scrollbar { width: 8px; }
.fb-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: var(--fb-border-strong);
  background-clip: padding-box;
}
.fb-body::-webkit-scrollbar-track { background: transparent; }

.fb-prompt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fb-text);
}
.fb-prompt::before {
  content: "";
  flex: 0 0 auto;
  width: 3px;
  height: 14px;
  border-radius: 999px;
  background: var(--fb-accent);
}
.fb-textarea {
  padding: 12px 14px;
  background: var(--fb-input-bg);
  border-color: var(--fb-border);
  box-shadow: inset 0 1px 2px rgba(16, 24, 40, 0.03);
}
.fb-textarea::placeholder { color: var(--fb-text-tertiary); opacity: 1; }
.fb-textarea:hover:not(:disabled) { border-color: var(--fb-border-strong); }
.fb-textarea:focus {
  background: var(--fb-input-bg);
  border-width: 1px;
  border-color: var(--fb-accent);
  box-shadow: 0 0 0 3px var(--fb-focus-ring);
}
.fb-counter-row { padding: 0 2px; }

/* 图片证据：附件卡承载缩略图与轻量操作，悬停时抬起。 */
.fb-shot-area { gap: 10px; }
.fb-screenshot-thumb-box {
  background: var(--fb-card-bg);
  border-color: var(--fb-border);
  box-shadow: var(--fb-shadow-card);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.fb-screenshot-thumb-box:hover {
  border-color: var(--fb-border-strong);
  box-shadow: var(--fb-shadow-raised);
}
.fb-thumb-frame {
  box-sizing: border-box;
  border: 1px solid var(--fb-border);
  border-radius: 10px;
  background: var(--fb-bg);
}
.fb-thumb-info { gap: 6px; }
.fb-thumb-meta { gap: 2px 8px; }
.fb-screenshot-badge {
  padding: 2px 8px;
  border: 1px solid var(--fb-border);
  border-radius: 999px;
  background: var(--fb-bg);
  color: var(--fb-text-secondary);
  font-size: 11px;
  font-weight: 500;
}
.fb-screenshot-size { font-size: 11px; color: var(--fb-text-tertiary); }
.fb-thumb-actions { gap: 4px; margin-top: 2px; }
.fb-thumb-edit,
.fb-thumb-remove {
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
}
.fb-thumb-edit { color: var(--fb-segment-text); }
.fb-thumb-edit:hover:not(:disabled) { background: rgba(0, 113, 227, 0.08); }
.fb-thumb-remove { color: var(--fb-status-error-text); }
.fb-thumb-remove:hover:not(:disabled) { background: var(--fb-status-error-bg); }

/* 截图操作：主操作用实心强调色，移除与添加退到安静层级。 */
.fb-screenshot-actions { gap: 6px; }
.fb-btn-capture,
.fb-btn-retake,
.fb-btn-remove,
.fb-btn-add-image {
  flex: 1 1 96px;
  min-width: 0;
  padding: 0 10px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.fb-btn-capture:not(:disabled),
.fb-btn-retake:not(:disabled) {
  background: var(--fb-accent);
  border-color: var(--fb-accent);
  color: #fff;
}
.fb-btn-capture:hover:not(:disabled),
.fb-btn-retake:hover:not(:disabled) {
  background: var(--fb-accent-hover);
  border-color: var(--fb-accent-hover);
}
.fb-btn-remove {
  background: transparent;
  border-color: transparent;
  color: var(--fb-status-error-text);
}
.fb-btn-remove:hover:not(:disabled) { background: var(--fb-status-error-bg); }
.fb-btn-add-image {
  background: var(--fb-bg);
  border-color: var(--fb-border-strong);
  color: var(--fb-text);
}
.fb-btn-add-image:hover:not(:disabled) {
  background: var(--fb-bg-subtle);
  color: var(--fb-text);
}

/* 诊断日志：默认是一条安静的可展开卡片，展开后为独立内容卡。 */
.fb-logs-area { gap: 6px; }
.fb-logs-toggle {
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--fb-card-bg);
  box-shadow: var(--fb-shadow-card);
  font-size: 12px;
}
.fb-logs-toggle:hover { background: var(--fb-bg-subtle); }
.fb-logs-toggle[aria-expanded="true"] {
  background: var(--fb-bg-subtle);
  border-color: var(--fb-border-strong);
  box-shadow: none;
}
.fb-logs-summary { font-weight: 500; }
.fb-logs-chevron { color: var(--fb-text-tertiary); }
.fb-logs-body {
  padding: 10px;
  border: 1px solid var(--fb-border);
  border-radius: 12px;
  background: var(--fb-bg-subtle);
}
.fb-log-item { background: var(--fb-bg); border-color: var(--fb-border); }
.fb-btn-add-log { border-radius: 8px; }

/* 状态卡：左侧色条固定语义，圆角与信息卡一致。 */
.fb-status-region { min-height: 0; }
.fb-status-card { border-radius: 12px; border-left-width: 3px; }

/* 固定提交区：通栏发丝分隔，内容滚动时不露出侧边。 */
.fb-footer {
  margin: auto -16px 0;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--fb-border);
  background: var(--fb-bg);
}
.fb-submit {
  border-radius: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.fb-submit:not(:disabled) {
  box-shadow: 0 1px 2px rgba(0, 113, 227, 0.28), 0 8px 20px -14px rgba(0, 113, 227, 0.6);
}
.fb-submit:disabled {
  background: var(--fb-bg-subtle);
  color: var(--fb-text-secondary);
  box-shadow: none;
}
.fb-footnote { color: var(--fb-text-tertiary); }
.fb-quota {
  align-self: center;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--fb-bg-subtle);
  color: var(--fb-text-secondary);
}
.fb-login-panel {
  padding: 12px;
  border-color: var(--fb-border);
  border-radius: 12px;
}
.fb-login-input {
  min-height: 40px;
  border-color: var(--fb-border-strong);
  border-radius: 9px;
  background: var(--fb-input-bg);
}
.fb-login-confirm,
.fb-login-cancel { border-radius: 10px; }

/* 服务器设置：保存是唯一主操作，其余保持次要层级。 */
.fb-settings-save {
  background: var(--fb-accent);
  border-color: var(--fb-accent);
  color: #fff;
}
.fb-settings-save:hover:not(:disabled) {
  background: var(--fb-accent-hover);
  border-color: var(--fb-accent-hover);
}
.fb-settings-save:disabled { opacity: 0.55; cursor: not-allowed; }

/* 历史列表沿用同一层级：卡片轻投影，悬停抬起。 */
.fb-history-item.fb-issue-row { box-shadow: var(--fb-shadow-card); }
.fb-history-item.fb-issue-row:hover {
  border-color: var(--fb-border-strong);
  box-shadow: var(--fb-shadow-raised);
}

/* 设置视图与主体同一内边距节奏。 */
.fb-settings { padding: 12px 16px 16px; gap: 12px; }

`;
