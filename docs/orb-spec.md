# 灵感球 HyperOS 4 跨端设计契约

任务：T1，2026-10-27 官方参考修订版。适用端：`packages/web` 与 `flutter/feedback`。后续 T2/T4 按本文实现；若实现需要偏离数值，必须先修订本文并说明原因。

## 1. 范围、单位与契约边界

- 仅定义灵感球入口的视觉、动效、状态与验收方式，不改变组件业务行为。
- Web 尺寸单位为 CSS px，Flutter 尺寸单位为 logical pixel；本文用 `px` 表达两端对应值。
- 静止基础直径为 56，拖动基础直径为 84；Web 使用 `56 × 1.5 = 84`，Flutter 直接使用 84，不再保留上一版的拖动尺寸与缩放因子。
- 动画时间从对应状态提交后开始计时，不用任意 `sleep` 作为状态已经生效的证据。
- 下文 `--fb-orb-*` 是组件内部设计令牌，不构成新的宿主配置项；Flutter 的 `Light` / `Dark` 常量分别取浅色 / 深色列。
- 官方视频只证明所展示片段中的形态与交互；idle 呼吸和白色扫光均属于设计推断，不作为官方直接观察结论。保留与强度已于 2026-10-28 随 T8 截图矩阵由用户确认；仍属设计推断。
- **第 12 节为 2026-10-27 从官方站素材实测得到的数值，优先级高于第 3 节。** 两处冲突时按第 12 节实现：主白环不是等宽描边，球体内部没有独立高光点。

## 2. 官方参考

- 来源：小米官方宣传素材，B 站账号「小爱同学」，视频 [BV1u5tJ6kEof](https://www.bilibili.com/video/BV1u5tJ6kEof/)。
- 发布时间：2026-09-02；视频时长 19 秒，画面尺寸 1080 × 1920。
- 抽帧核对时间点：**1.50s、2.00s、2.50s、3.00s、3.50s、4.00s**。其中 3.50s 用于核对透明中心，4.00s 用于核对文字透过球体可见。
- 视频与截图不得提交进仓库；本文只引用公开 URL 与时间戳，实现期参考文件保留在仓库外。

以下七条只记录官方片段中观察到的内容，不推测未展示的机制：

1. 球体呈白珍珠 / 清玻璃透镜形态，不是高饱和彩色跑马灯。3.50s 与 4.00s 可见中心内容；结合第 12.3.1 节量化，中心没有可测磨砂，白感来自向外增强的径向环。
2. 边缘为厚而亮的白色光环，厚度约为直径的 6–8%，外沿柔化；不是 1px 细边。
3. 色散克制：一侧偏暖金、另一侧偏青蓝柔光；没有明显的紫色 / 橙色整圈。
4. 外发光为范围较小的柔白 bloom，青蓝仅出现在一侧。
5. 拖动时球体相对屏幕明显放大约 1.4–1.6 倍，形状基本保持圆形，没有夸张液态拉伸。
6. 松手后没有出现“收成胶囊”的过渡，直接进入识别 / 选区结果；本规格继续禁止变岛过渡。
7. 视频没有展示长时间静止 idle，因此无法从该片段直接确认呼吸或扫光；本文的 5.4s 呼吸与 10s 白色扫光均为设计推断。

## 3. 设计令牌

### 3.1 尺寸与动效令牌

| Web CSS 变量 | Flutter 常量 | 契约值 |
| --- | --- | --- |
| `--fb-orb-size` | `kFeedbackOrbIdleDiameter` | `56px` / `56.0` |
| `--fb-orb-drag-scale` | `kFeedbackOrbDragScale` | `1.5` |
| `--fb-orb-drag-size` | `kFeedbackOrbDraggingDiameter` | `84px` / `84.0`；Web 由 `56 × 1.5` 得到 |
| `--fb-orb-drag-stretch-max` | `kFeedbackOrbDragStretchMax` | `0.04`；沿拖动方向最多增加 4%，垂直方向不压缩 |
| `--fb-orb-hover-scale` | `kFeedbackOrbHoverScale` | `1.04` |
| `--fb-orb-pressed-scale` | `kFeedbackOrbPressedScale` | `0.94` |
| `--fb-orb-size-duration` | `kFeedbackOrbSizeDuration` | `220ms` / `Duration(milliseconds: 220)` |
| `--fb-orb-state-easing` | `kFeedbackOrbStateCurve` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--fb-orb-release-duration` | `kFeedbackOrbReleaseDuration` | `460ms` / `Duration(milliseconds: 460)` |
| `--fb-orb-release-easing` | `kFeedbackOrbReleaseCurve` | `cubic-bezier(0.2, 1.35, 0.32, 1)` / `Cubic(0.2, 1.35, 0.32, 1.0)` |
| `--fb-orb-press-duration` | `kFeedbackOrbPressDuration` | `140ms` / `Duration(milliseconds: 140)` |
| `--fb-orb-press-easing` | `kFeedbackOrbPressCurve` | `ease-out` / `Curves.easeOut` |
| `--fb-orb-sweep-duration` | `kFeedbackOrbSweepDuration` | `10s` / `Duration(seconds: 10)`；白色镜面扫光，设计推断 |
| `--fb-orb-sweep-easing` | `kFeedbackOrbSweepCurve` | `linear` / `Curves.linear` |
| `--fb-orb-sweep-arc` | `kFeedbackOrbSweepArc` | `40deg` / `40 × π / 180`；仅作用于白环，设计推断 |
| `--fb-orb-breath-duration` | `kFeedbackOrbBreathDuration` | `5.4s` / `Duration(milliseconds: 5400)`；设计推断 |
| `--fb-orb-breath-easing` | `kFeedbackOrbBreathCurve` | `ease-in-out alternate`；Flutter 由第 7 节公式产生往复值，不另建控制器 |
| `--fb-orb-breath-scale-min` | `kFeedbackOrbBreathScaleMin` | `1` / `1.0` |
| `--fb-orb-breath-scale-max` | `kFeedbackOrbBreathScaleMax` | `1.02` |
| `--fb-orb-breath-bloom-gain` | `kFeedbackOrbBreathBloomGain` | `0.08`，即呼吸峰值时外发光强度相对增加 8% |
| `--fb-orb-drag-threshold` | `kFeedbackOrbDragThreshold` | `8px` / `8.0` |
| `--fb-orb-pull-distance` | `kFeedbackOrbPullDistance` | `80px` / `80.0` |
| `--fb-orb-glow-counter-travel` | `kFeedbackOrbGlowCounterTravel` | `4px` / `4.0` |
| `--fb-orb-sheen-width` | `kFeedbackOrbSheenWidth` | **已废止**，见第 12.4 节：官方帧内部无独立高光，不再绘制椭圆高光 |
| `--fb-orb-sheen-height` | `kFeedbackOrbSheenHeight` | **已废止**，见第 12.4 节 |
| `--fb-orb-sheen-dot-size` | `kFeedbackOrbSheenDotDiameter` | **已废止**，见第 12.4 节 |

> **Web 令牌落地事实（2026-10-28，T10 记录）**：`--fb-orb-size`、`--fb-orb-drag-scale`、`--fb-orb-drag-size`、`--fb-orb-sweep-arc` 等名字尚未在 `packages/web/src/styles.ts` 中作为 CSS 变量存在——56px、拖动 `--fb-orb-state-scale: 1.5`、扫光 `40deg` 仍是字面量。改动这些值必须同时改字面量与两端测试；Flutter 侧常量已按本表命名。此差异只影响内部实现的可追溯性，不改公开 API。

### 3.2 浅色 / 深色令牌

色散令牌以第 12.6.1–12.6.2 节为准：浅 / 深主题使用不同 RGB / alpha，以同时满足色分裂与亮度中性；暖冷之间透明，不增加第三或第四色。Flutter 的 double opacity 断言不得用 8 位 alpha 取整值替代。

| Web CSS 变量 | Flutter 常量（Light / Dark） | 浅色 | 深色 |
| --- | --- | --- | --- |
| `--fb-orb-veil` | `kFeedbackOrbVeilLight` / `kFeedbackOrbVeilDark` | **已作废**（T10）：核心不使用独立 veil 层，白色径向渐变由 core 自身绘制（第 4 节图层 4）；实现无此常量 / 变量 |
| `--fb-orb-cyan` | `kFeedbackOrbCyanLight` / `kFeedbackOrbCyanDark` | **见 12.6.1**：`rgb(120, 200, 255)`，有效 alpha ≈ `0.49` | 同浅色 |
| `--fb-orb-warm` | `kFeedbackOrbWarmLight` / `kFeedbackOrbWarmDark` | **见 12.6.1**：`rgb(255, 190, 120)`，有效 alpha ≈ `0.41` | 同浅色 |
| `--fb-orb-pale-purple` | — | **已作废**，见 12.6.1：暖冷过渡段实测接近中性，应为透明 |
| `--fb-orb-dispersion-opacity` | `kFeedbackOrbDispersionOpacityLight` / `kFeedbackOrbDispersionOpacityDark` | **原 `0.55` 上限已作废**（自拟值，非实测）；以 12.6.1 的有效 alpha 为准 |
| `--fb-orb-edge` | `kFeedbackOrbEdgeLight` / `kFeedbackOrbEdgeDark` | `rgba(255, 255, 255, 0.95)` | `rgba(255, 255, 255, 0.85)` |
| ~~`--fb-orb-hairline`~~ | ~~`kFeedbackOrbHairlineLight` / `kFeedbackOrbHairlineDark`~~ | **已作废**（2026-10-29 裁决）：hairline 决定不画，`OrbPalette.hairline` 死字段已删除 | 同左 |
| `--fb-orb-bloom-white` | `kFeedbackOrbBloomWhiteLight` / `kFeedbackOrbBloomWhiteDark` | `rgba(255, 255, 255, 0.45)` | `rgba(255, 255, 255, 0.55)` |
| `--fb-orb-bloom-cyan-tint` | `kFeedbackOrbBloomCyanTintLight` / `kFeedbackOrbBloomCyanTintDark` | **已作废**（T10）：bloom 不承载青 tint（第 4 节图层 1、第 5 节）；实现无对应常量 / 变量 |
| `--fb-orb-sweep-white` | `kFeedbackOrbSweepWhiteLight` / `kFeedbackOrbSweepWhiteDark` | `rgba(255, 255, 255, 0.80)` | `rgba(255, 255, 255, 0.80)`；设计推断 |
| `--fb-orb-shadow` | — | **已作废**，见 12.8：两帧球沿外均无可测压暗，idle 两端无投影 |

~~Flutter 阴影映射必须保持 `spreadRadius = 0`~~ —— 该段随 `--fb-orb-shadow` 一并作废，见 12.8。`.fb-orb.is-dragging` 不使用投影（2026-10-28 随 T8 拖动截图验收确认）；该决定仍属设计推断。

### 3.3 图层几何令牌

| Web CSS 变量 | Flutter 常量 | 契约值 |
| --- | --- | --- |
| `--fb-orb-bloom-inset` | `kFeedbackOrbBloomInset` | **修订为 `-3px` / `-3.0`**，见第 12.5 节；原 `-12px` 约为实测外发光范围的 4 倍 |
| `--fb-orb-bloom-blur` | `kFeedbackOrbBloomBlur` | **修订为 `4px` / `4.0`**，见第 12.5 节 |
| `--fb-orb-glow-inset` | `kFeedbackOrbGlowInset` | **`-14px` / `-14.0`**（T10 修订）：色散环外扩 `0.5R`，见 12.6.1 与第 4 节图层 2；原 `-2px` 为 T1 残留 |
| `--fb-orb-glow-blur` | `kFeedbackOrbGlowBlur` | `8px` / `8.0` |
| `--fb-orb-edge-width` | `kFeedbackOrbEdgeWidth` | **已废止等宽描边**；主白环改为第 12.2 节的径向渐变，半高宽约 `0.22R`（56px 球体约 6px），峰值位于 `0.95R`–`1.00R` |
| `--fb-orb-edge-outer-blur` | `kFeedbackOrbEdgeOuterBlur` | `0.5px` / `0.5`，只柔化主白环外沿 |
| `--fb-orb-core-backdrop-blur` | `kFeedbackOrbCoreBackdropSigma` | **已作废**（T10）：清玻璃核心不做 backdrop blur，见第 4 节图层 4 与 12.3.1；实现只对 bloom / glow 层做 blur |
| ~~`--fb-orb-hairline-width`~~ | ~~`kFeedbackOrbHairlineWidth`~~ | **已作废**（2026-10-29 裁决）：内侧 1px hairline 决定不画，令牌与配色字段一并删除，见第 4 节图层 4 与 12.2 |
| `--fb-orb-focus-width` | `kFeedbackOrbFocusWidth` | `2px` / `2.0` |
| `--fb-orb-focus-offset` | `kFeedbackOrbFocusOffset` | `2px` / `2.0` |

## 4. 图层栈与绘制约束

图层顺序固定为外 → 内；不得让 badge 参与球体缩放、扫光旋转或方向拉伸。**本节已按第 12 节实测结果重写；旧的 4px 描边、磨砂 blur、三段含紫色散和 sheen 全部作废。**

| 顺序 | 图层 | 可测绘制契约 |
| --- | --- | --- |
| 1 | `.fb-orb-bloom` | 只负责柔白外发光；56px 球上 `inset: -3px`、`blur(4px)`，中心在 78% 内完全透明。白色 alpha 浅 `0.45`、深 `0.55`，呼吸峰值只增加 8%。不承载青 tint，不承担色散。 |
| 2 | `.fb-orb-glow` | 静态双极色散环，暖心 conic `135°`、冷心 `300°`，两者之间透明；56px 球上外扩 `14px = 0.5R`。子层先 `blur(8px)`，父层再 mask：`0.95R` 内完全挖空，约 `1.50R` 收口。浅色暖 `rgba(255,190,120,0.58)`、冷 `rgba(120,200,255,0.70)`；深色暖 `rgba(200,24,0,0.43)`、冷 `rgba(0,76,255,0.33)`。自身不旋转，拖动时只叠加第 6 节反向位移。 |
| 3 | `.fb-orb-sweep` | 白色镜面扫光，仅作用于白环；40deg 局部弧带，峰值 `rgba(255,255,255,0.80)`，其余透明；`10s linear infinite`。不得驱动色散一起旋转。时间、角宽与峰值属于设计推断。 |
| 4 | `.fb-orb-core` | 清玻璃透镜，无 `backdrop-filter`、无额外 veil、无 border / hairline。用第 12.2 节径向 alpha stops 绘制从球心到 `0.95R–1.00R` 平台的连续白环；不得退回等宽描边。 |
| 5 | badge | 位于最内层 / 最上方；可随球整体平移，但不随扫光旋转，不随 hover、pressed、dragging、release、breath 或方向拉伸变形；保留既有数值与语义。 |

`.fb-orb-sheen` 已废止，DOM 与 CSS 都不得创建该层；官方帧内部无独立高光，见 12.4。

补充约束：

1. `packages/web` 全面不使用 `backdrop-filter`。Flutter 端只允许**透镜采样层**使用 `BackdropFilter(ImageFilter.matrix)`（A 路线）或“捕获 + 片元着色器”（C 路线），两者都不得带 blur；平台口径与约束见 13.4 / 13.5。两端带文字背景的对比度保持率都必须满足 12.3.1。
2. 色散是双极染色环，不增加紫色或第四色；浅 / 深令牌与亮度中性验收见 12.6.1–12.6.2。
3. 白色扫光的单周期色标为 `transparent 0deg`、`--fb-orb-sweep-white 20deg`、`transparent 40deg`，40–360deg 均透明；旋转只改变白环局部高光。扫光属于设计推断，不是视频观察值。
4. 所有装饰层在 Web 设置 `aria-hidden="true"` 与 `pointer-events: none`；Flutter 对应装饰绘制不增加 Semantics。负 inset 不得扩大按钮命中区域或改变布局。
5. Web 的 orb 复用 `.fb-launcher` 基类，但**任何主题、side、hover、active、pressed 状态下 root background 都必须保持透明**，不得继承标签入口的背景填充；root transform 只允许业务停靠与 1:1 指针平移，不得继承 `.fb-launcher:hover/:active` 的横移。显式 `side="left"` 时同样必须满足，不能依赖源码顺序偶然覆盖。
6. badge 可以随球体整体平移以保持既有相对位置，但其自身 `scale = 1`、旋转角为 0、方向拉伸为 1。
7. 56 → 84 时，core、bloom、glow、sweep 作为同一视觉组按 1.5 缩放；badge 除外。
8. 方向拉伸只作用于上述视觉组，沿拖动轴最大 1.04、垂直轴保持 1；不得做液态形变、非圆形胶囊或路径形变。该拉伸、glow lag、press scale、回弹曲线都是本项目的**核心动效设计推断**，并非官方时序参数。

## 5. 七态契约

主视觉状态优先级为 `hidden > dragging > releasing > pressed > hover > focus-visible > idle`。`focus-visible` 焦点环是附加状态：只要焦点仍符合 `:focus-visible`，即使同时 pressed 或 dragging 也不得移除；hidden 除外。

**焦点环几何（2026-10-28 修订，T7g）**：焦点环始终贴合**当前视觉直径**——每侧在球沿外留 2px 间隙，再画 2px `--fb-accent` 环宽，因此 `环外径 = 当前视觉直径 + 8`。56 直径对应外径 64，drag 的 84 直径对应外径 92；环与球同心、始终为正圆，不参与方向拉伸、badge 变换或扫光旋转。idle 呼吸的 ±2% 不叠加到环，避免静止态环随呼吸抖动。两端同一契约（Flutter 拖动时环随 84 布局盒外扩到 92，Web 由独立焦点环层按 `--fb-orb-state-scale` 换算）。焦点环自身不新增过渡：显隐瞬时切换；球体尺寸过渡期间环按同一实时视觉直径跟随，不另加缓动。

**焦点环颜色（T10 记录）**：Web 取 `--fb-accent`；Flutter 取 `Theme.of(context).colorScheme.primary`，不新增独立 Flutter 令牌。两者都是入口强调色，不改变主题 API；若宿主主题让两者不一致，以各自平台既有强调色为准。Web 用独立 `.fb-orb-focus-ring` 层绘制，不再使用 `outline`。

**`forced-colors` 行为（2026-10-29 实测定稿）**：强制调色模式下**不需要任何额外规则**，环照旧可见。自绘层用的是 `border-color`，UA 会把它强制映射成系统前景色 `CanvasText`，Chrome 实测与 `Canvas` 背景 **21:1**；而 `CanvasText` / `Canvas` 是规范保证成对的对比色，比自行挑 `Highlight`（与 `Canvas` 并非保证成对）更稳，所以**不得**为此改成 `Highlight` 或加宽环。真正的禁止项是**不许关掉这条映射**：环及其祖先一律不得声明 `forced-color-adjust: none` 或 `-ms-high-contrast-adjust: none`，否则环停在 `--fb-accent`，在高对比深色主题下只有 2.9:1，低于 WCAG 非文本的 3:1。该契约由 `e2e/run_orb_forced_colors_web.py` 守卫（计算样式 + 像素对比度 + 源码扫描三层，已做变异验证）。

Flutter 侧无对应模式：Flutter 没有 forced-colors 概念，`MediaQueryData.highContrast` 只在 iOS / macOS 由系统「增强对比度」提供，且不会改写应用颜色。因此 Flutter 环色仍由宿主主题的 `colorScheme.primary` 决定，本项不做平台改动——这是平台能力差异，不是契约差异。

**键盘激活与焦点回归（2026-10-28 T7 定稿）**：球可获得键盘焦点；Space / Enter / 小键盘 Enter 各触发一次与点按等价的 `_handleLauncherTap()`，忽略长按重复（`includeRepeats: false`）。Web 使用原生 `:focus-visible` 与按钮激活；Flutter 3.47.7 的 `FocusableActionDetector` 不带默认快捷键，故在球局部映射这三个键，不改宿主全局快捷键——这是平台差异，不是契约差异。面板 open → closed（含 `controller.close()` 与程序化开合）一律把焦点还给球；焦点环只在**最近一次输入是键盘**时点亮。指针关闭会抑制下一次环显示，随后任意按键 / Tab 重新点亮。选区覆盖层打开期间球退出焦点链（`enabled: false`），Space / Enter 不再落回球。焦点环使用 `IgnorePointer`，不改变 56 / 84 布局与命中区；hidden 时随入口移除，并同步清除锁存的环与 releasing / hover / pressed 残留。

### 5.1 命中区契约（2026-10-29 裁决）

**不为任何状态新增独立热区；命中区永远不大于该状态的视觉轮廓。**

- **基准命中区 = 静止态 56dp**，已高于 Material 的 48dp 与 Apple 的 44pt 最小可点尺寸，不需要靠放大来保证可达性。
- **视觉缩放一律不改命中区**：hover `1.04`、pressed `0.94`、呼吸 `±2%`、方向拉伸都只作用于绘制，不改变可点区域。两端现状已满足（Flutter 的 `stateScale` 只进 painter，Web 的 `--fb-orb-state-scale` 只进 `pointer-events: none` 的视觉层）。
- **`dragging` 的 84dp 是视觉直径**。两端实现路径不同：Flutter 用 `AnimatedContainer` 的布局尺寸实现放大，所以拖动期间命中盒恰好也是 84；Web 的 `.fb-orb` 根元素恒为 56 且 `transform` 只留给 1:1 指针平移，放大由四个视觉层承担，所以命中区恒为 56。**这不构成可观察差异**：进入 `dragging` 的前提是已越过 8px 阈值、指针已被 pan 手势捕获，更大的命中盒对该指针不起任何作用。
- 唯一能观察到上述差异的路径是**第二根手指落在 56–84 环带**。已由 §5.2 的第二指过滤收口：Flutter 命中但被忽略，Web 根本不命中，两端结果一致（都是「无反应」），差异不再可观察。
- 因此**不做改动**：不给 Flutter 加固定 56 命中盒（会与第 7 节 56/84 布局契约和既有断言冲突，换不到可观察收益），也不给 Web 根元素加放大（会破坏 1:1 指针平移与 badge 的 1:1 要求）。
- 装饰层的负 inset 同样不得扩大命中区（见第 4 节图层约束第 4 条）；`hidden` 时整棵入口不可命中（见下表）。
- **拖动期间命中盒不随 1:1 平移移动**（2026-10-29 实测记录）：Flutter 把业务位移的 `Transform` 放在手势盒内部，所以视觉已偏移时命中盒仍停在停靠位。同样**不可观察**——该指针已被 pan 捕获，第二指按 §5.2 一律忽略，松手后 `releasing` 把位移归零。记录在此是为了说明测试里第二指取点必须按命中盒（`feedback-orb`）而不是视觉（`feedback-orb-body`）。

### 5.2 指针准入契约（2026-10-29 加固）

**同一时刻只接受一根指针、只接受主键。**

- **只认主键**：Web 为 `ev.button !== 0` 直接返回；Flutter 为 `event.buttons != kPrimaryButton` 直接返回。右键 / 中键 / 侧键按下不进入 `pressed`、不起拖动；鼠标停在球上的 `hover` 不受影响（右键按下时仍是 `1.04`，不是 `0.94`）。
- **只认首指**：首次被接受的指针 id 锁存（Web 的 `orbPointerId`、Flutter 的 `_orbPointer`）；在它释放前，任何其他指针的按下一律忽略。后续 `up` / `cancel` 也只认同一 id，避免第二指抬起提前结束首指的按压语义。
  - 不过滤时 Flutter 会在第二指按下时把 `_dragOffset` 清零，正在拖动的球**瞬间跳回停靠位**——这是该项加固的实际收益，不只是整洁。
- **活跃指针的释放**只走 `up` / `cancel`。入口在按下期间变 `hidden` 不需要额外补偿：Flutter 按指针保留按下时的命中路径，抬起仍会派发到已 detach 的 `Listener`。**不要**在 `build` 里按 hidden 条件清空活跃指针（不可达的防御代码），也不要在手势取消回调里清空（pan 输掉竞争时指针仍按着，清空会放第二指进来）。
- **手势取消的状态提交必须按调度相位分流**：入口在拖动中被隐藏时，`RawGestureDetectorState.dispose` 会在**锁定的 widget 树**里 reject 手势并回调 `onPanCancel`，此刻裸 `setState` 抛 `widget tree was locked`。idle 相位走同步 `setState` 保持同帧语义，帧内被回调则先落字段、推迟一帧再通知。

呼吸计算统一为：

```text
breathScale = 1 + 0.02 × breath
bloomWhiteAlpha = themeBloomWhiteAlpha × (1 + 0.08 × breath)
// 色散环不随 breath 改变；不再存在 bloom cyan tint
```

其中 `breath ∈ [0, 1]`。未开启减少动态效果时，flow（白色扫光相位）与 breath 在所有可见状态继续计时；状态表中的“固定 scale”表示不叠加 breathScale，bloom 仍按上式呼吸。双极色散的 alpha 不随 breath 增加。

**Web 运行时前置条件**：`--fb-orb-breath`、`--fb-orb-state-scale`、`--fb-orb-breath-weight` 必须通过模块级 `CSS.registerProperty()` 注册为 `inherits: true` 的 `<number>`。Chrome 156 实测，Shadow DOM 样式表中的 `@property` 不会完成 document 级注册；仅保留 `@property` 字符串会让 breath / transition 退化为离散方波。模块级注册须带 `CSS` / API 存在性守卫，并容忍同一 document 多实例 / 重复 bundle 的重复注册。若 API 不可用，必须退化为**无 breath、无自定义属性 transition 的静态状态**，不得保留 0↔1 方波。

| 状态 | 进入条件 | 尺寸、scale 与视觉 | 时间 / 退出 |
| --- | --- | --- | --- |
| `idle` | 无 hover、press、drag、release，入口可见 | 基础直径 56；`scale = breathScale`，范围 1–1.02；白色扫光与 bloom 呼吸运行 | 进入 hover / pressed 按对应状态计时 |
| `hover` | 指针悬停且未按压 | 基础直径 56；固定 `scale = 1.04`；扫光与 bloom 呼吸运行 | 进入和退出均 220ms；退出目标为当前 `breathScale` |
| `focus-visible` | 键盘等输入触发 `:focus-visible`，且无更高优先级主状态 | 基础直径 56；`scale = breathScale`；2px `--fb-accent` 焦点环贴合当前视觉直径（每侧 2px 间隙 + 2px 环宽，外径 = 视觉直径 + 8：56 → 64，拖动 84 → 92；呼吸 ±2% 不改变环半径），与球同心；扫光与 bloom 呼吸运行 | 焦点环不做自身过渡：显隐瞬时，尺寸随视觉直径同步（拖动按同一 220ms 状态过渡跟随）；失焦立即移除；pressed / dragging 时保留，hidden 时随整棵入口消失 |
| `pressed` | 指针或键盘按下，累计位移尚未超过拖动阈值 | 基础直径 56；固定 `scale = 0.94`；焦点环按上述规则保留 | 进入和退出均 140ms `ease-out`；退出到 hover 或当前 `breathScale` |
| `dragging` | 同一指针累计位移 `hypot(dx, dy) > 8px` | 基础直径 84；Web 固定基础 `scale = 1.5`，Flutter 直接 diameter 84；沿拖动轴 `stretch = 1 + 0.04 × pull`，垂直轴为 1；位置 1:1 跟随；更新 glow 反向位移 | 跨过阈值后的尺寸进入为 220ms；指针平移、pull、glow 位移和 stretch 不加延迟或平滑 |
| `releasing` | 拖动松手或拖动取消后的视觉复位阶段 | 基础 scale 从 1.5 过渡到当前 `breathScale`；呼吸权重同步从 0 回到 1（不是结束瞬间接上）；方向拉伸回到 1；平移回到既有停靠位置；glow 反向位移回到 0 | 统一 460ms `cubic-bezier(0.2, 1.35, 0.32, 1)`；结束后进入 idle / hover / focus-visible |
| `hidden` | 既有 launcher-mode、面板或捕获遮挡规则要求隐藏 | 整棵入口（含 badge）不可见、不可命中；扫光与 breath 停止；不得仅将 opacity 设为 0 后继续运行动画 | 立即生效；恢复可见时从 `flow = 0`、`breath = 0` 开始，不补算隐藏期间相位 |

`releasing` 只描述视觉复位，不推迟、替换或取消既有点击 / 拖动松手业务流程。若同一时刻业务规则要求 hidden，hidden 优先，不输出可见回弹，也不增加胶囊中间态。

## 6. 拖拽光晕滞后与近圆形拉伸映射

`dx`、`dy` 是同一次指针拖动从起点到当前点的累计位移，不是单帧 delta；坐标系为屏幕坐标，右为 +x、下为 +y。

```text
r = hypot(dx, dy)
angle = r == 0 ? 0 : atan2(dy, dx)       // 弧度
pull = min(1, r / 80)                    // 0..1

glowOffset = (
  -4 × pull × cos(angle),
  -4 × pull × sin(angle)
)                                         // px

stretchAlong = 1 + 0.04 × pull            // 1..1.04
stretchAcross = 1
```

- 只有 `r > 8` 才进入 dragging；`r == 8` 不进入。阈值判断与点击 / 拖动业务分流保持现状。
- 方向拉伸矩阵为 `R(angle) × Scale(stretchAlong, 1) × R(-angle)`，作用于视觉组且不作用于 badge；84px 基础球体在 pull 1 时沿拖动轴为 `84 × 1.04 = 87.36px`，垂直轴仍为 84px。
- `pull` 达到 1 后不再随距离增大；反向位移最大为 4px，方向始终与拖动方向相反，用于表达光晕滞后。
- Web 将 `angle / pull` 写入内部绘制状态；Flutter 使用同名 painter 入参。两者均不得修改 `releasePoint` 的计算。
- 已废止全部 pointer-follow highlight / sheen 计算；不得以「拖动反馈」为由重新创建固定高光。

固定测试向量：

| 输入 `(dx, dy)` | 预期 |
| --- | --- |
| `(0, 0)` | `angle = 0`、`pull = 0`、`glowOffset = (0, 0)`、`stretchAlong = 1` |
| `(8, 0)` | 不进入 dragging；如单独计算公式，`pull = 0.1`、`stretchAlong = 1.004` |
| `(80, 0)` | dragging；`angle = 0`、`pull = 1`、`glowOffset = (-4, 0)`、`stretchAlong = 1.04` |
| `(0, 80)` | dragging；`angle = π/2`、`pull = 1`、`glowOffset ≈ (0, -4)`、`stretchAlong = 1.04` |
| `(60, 80)` | dragging；`r = 100`、`pull = 1`、`glowOffset = (-2.4, -3.2)`、`stretchAlong = 1.04` |
| `(160, 0)` | dragging；`pull` 仍为 1，`glowOffset` 仍为 `(-4, 0)`，`stretchAlong` 仍为 1.04 |

## 7. Flutter 映射与 Ticker 约束

### 7.1 绘制映射

- diameter 只取 `56.0` 或 `84.0`；不通过 `Transform.scale` 改变布局尺寸。视觉组内部几何按 `diameter / 56.0` 等比换算，方向拉伸作为绘制变换另算，badge 不缩放、不拉伸。
- 使用既有 `CustomPainter` 绘制 bloom、glow、sweep、core；不绘制 sheen，不引入图片、WebGL 或第三方动画库。透镜采样是**独立于 painter 的一层**（见 13.5）：A 路线用 `BackdropFilter`，C 路线用单次捕获 + `shaders/orb_lens.frag`；两者都不得带 blur。
- `rotation = 2π × flow` 只驱动白色扫光；双极色散保持静态，角度原点与方向按第 4 节对齐 Web。
- pressed、dragging、releasing 的尺寸 / 曲线使用第 3 节令牌，不复用截图选区的动画时长。

### 7.2 单一控制器与呼吸公式

真实运行且允许动画时，只创建一个周期为 10s 的 `AnimationController`，线性 repeat；不得为 breath 再创建第二个控制器或 Timer。

```text
flow = controller.value                         // 0..1，10s 完成一次白色扫光
rotation = 2π × flow                           // 只用于白色扫光
breath = 0.5 - 0.5 × cos(flow × 2π × (10 / 5.4))
breathScale = 1 + 0.02 × breath
bloomWhiteAlpha = themeBloomWhiteAlpha × (1 + 0.08 × breath)
// 色散环不随 breath 改变；不再存在 bloom cyan tint
```

控制器只在 orb 可见且允许动画时运行；hidden 或 dispose 时停止并正确释放。不得在 build 中创建控制器。

### 7.3 测试环境

- `FLUTTER_TEST=true` 时，不创建上述 10s `AnimationController`，也不创建或启动它的 Ticker。
- 测试环境静态绘制使用 `flow = 0`、`breath = 0`；没有常驻动画，不依赖 `pumpAndSettle` 等待扫光。
- `FLUTTER_TEST` 不等于用户开启 reduced-motion；不得据此改变公开交互语义或跳过 pressed / drag / release 的状态断言。

### 7.4 Painter 入参与重绘

| 入参 | 类型与范围 |
| --- | --- |
| `flow` | `double`，0..1；只表示白色扫光相位 |
| `breath` | `double`，0..1 |
| `breathWeight` | `double`，0..1（回弹曲线过冲时可短暂略超 1）；呼吸幅度权重，见下 |
| `stateScale` | `double`，0.94..1.04；hover/pressed/idle/releasing 的连续视觉缩放 |
| `dragAngle` | `double`，弧度；无位移时为 0 |
| `pull` | `double`，0..1 |

布尔 pressed 无法表达 140ms 过渡，Flutter 用连续 stateScale 承载，七态语义不变，对应 Web 的 `--fb-orb-state-scale`。

**呼吸权重过渡（2026-10-29 加固）**：`breathWeight` 对应 Web 的 `--fb-orb-breath-weight`，目标值 hover / pressed / dragging 为 0、其余为 1，`releasing` **不压 0**（Web 的 `.is-releasing` 不设该变量、回落到基值 1，hover 规则带 `:not(.is-releasing)`）。它必须与 `stateScale` **共用同一时长与曲线**——状态切换 220ms、pressed 进出 140ms、回弹 460ms——不得作为布尔阶跃传入，否则 hover / press 切换与回弹结束会出现 ±2% 呼吸的整段跳变。Flutter 用一层 `TweenAnimationBuilder<double>` 承载，不新增控制器或 Timer（§7.2 约束不变）。回弹曲线会过冲，两端都不钳制权重：`0.02 × 过冲量` 只让呼吸幅度短暂略超 ±2%。

`shouldRepaint` 必须逐项覆盖上述全部入参：任意一项变化都返回 true；上表各项均不变且没有其他绘制字段变化时返回 false。实现若另加主题、透明度或其他绘制字段，也必须纳入 `shouldRepaint`，不得以“字段表已列完”为由漏比较。

## 8. Reduced-motion 独立契约

触发来源：Web `@media (prefers-reduced-motion: reduce)`；Flutter 沿用组件现有 reduced-motion 判断并包含 `MediaQuery.disableAnimationsOf(context)`。运行中切换时必须当帧同步。

1. 停止扫光与 breath，静态值固定为 `flow = 0`、`breath = 0`；Flutter 不创建常驻 Ticker，已存在的控制器停止。
2. 取消装饰性缩放：idle / hover / focus-visible / pressed / dragging 均保持基础直径 56，Web scale 与 Flutter 缩放因子均为 1；`stretchAlong = stretchAcross = 1`。
3. 尺寸、按压和回弹时长均变为 0ms；releasing 直接回到停靠位置与 idle 静态帧，不执行 460ms 回弹。
4. 保留拖动阈值 8px、球体位置 1:1 平移、点击 / 拖动分流及捕获语义；这些是功能反馈，不得禁用。
5. 关闭装饰性的 glow 反向位移，glowOffset 固定 `(0, 0)`；焦点环、badge、清玻璃核心、径向白环和主题颜色保留。
6. hidden 规则不变；恢复可见后仍保持静态，不补算动画相位。

## 9. 非目标

- 不做“收成胶囊再展开”的变岛过渡，也不设计任何 Dynamic Island 形态。
- 不改 `launcher-mode` 默认值或既有模式切换语义。
- 不改 `releasePoint`、`capture.region` 的坐标、精度、时序或字段含义。
- 不改公开 API、网络 API 或 DB。
- 不新增依赖，不引入 WebGL、第三方动画库或图片资源。
- 不把官方视频、抽帧、裁剪图或其他宣传素材提交进仓库。
- 不借本任务调整面板、截图选区、上报流程或其他入口样式。

## 10. 验收与截图矩阵

### 10.1 自动断言

- 分别断言浅 / 深两套径向白环、bloom 与双极色散；idle 无投影。56 / 84、1.5、方向拉伸上限 1.04、10s / 5.4s / 220ms / 460ms / 140ms、回弹曲线必须与第 3 节一致。
- 主白环按第 12.2 节的径向 alpha stops 断言；不得回退为等宽 4px / 6px 或 1px 描边。alpha 取样遵循 12.6.3 的均匀背景口径。
- `packages/web` 断言无 `backdrop-filter`；Flutter 断言 `BackdropFilter` / `FragmentShader` 只出现在透镜层，且滤镜不含 blur。两端无额外 veil、无 sheen / highlight；带文字背景对比度保持率按 12.3.1。
- 双极色散的角度、浅 / 深令牌、内孔、外扩半径与亮度中性必须按 12.6.1–12.6.2；中心不得铺色，色散层不得旋转。白色扫光单独断言 10s、40deg 和只作用于白环。
- 覆盖七态及 reduced-motion；状态优先级、焦点环保留、hidden 停止动画必须有独立断言。
- Web 不得只断言 `styles.ts` 含 `@property` 字符串：浏览器集成测试必须在模块加载后验证 `documentElement` 上三个属性可读到 initial-value（`0 / 1 / 1`），并采样 breath 至少 5 个中间帧证明连续插值；另模拟 `CSS.registerProperty` 不可用，确认退化为静态而不是方波。
- 使用第 6 节固定向量覆盖阈值、角度、pull 饱和、反向位移和 1.04 拉伸上限；浮点比较容差为 `1e-6`。
- Flutter 对每个 painter 绘制字段（flow、breath、stateScale、dragAngle、pull 及其余字段）分别做单字段变异测试，证明每项都会触发 repaint；另测全部绘制字段不变时不重绘。
- Web 装饰层全部 `aria-hidden`；badge 的变换矩阵无旋转、scale 为 1、方向拉伸为 1；两端命中区域和公开手势语义无回归。

### 10.2 截图规则

Web 与 Flutter 各输出 `浅色 / 深色 × idle / hover / pressed / dragging / releasing`，每端 10 张，共 20 张。文件路径统一为：

```text
e2e/shots/orb-hyperos4/<web|flutter>/<light|dark>-<idle|hover|pressed|dragging|releasing>.png
```

为避免随机相位造成伪差异，视觉测试夹具统一固定 `flow = 0.25`、`breath = 0.5`；测试夹具不得新增公开属性或改变业务 capture 时序。

| 状态 | 截图前置条件与断言点 |
| --- | --- |
| idle | 无指针交互；基础直径 56；固定相位下 `breathScale = 1.01`，bloom 白色 alpha 为浅 `0.468`、深 `0.572` |
| hover | 指针位于球心，进入后 220ms 截图；scale 1.04；badge scale 与 stretch 仍为 1 |
| pressed | 指针按下且不移动，140ms 后、松手前截图；scale 0.94；不得触发 dragging |
| dragging | 从球心拖动到 `(dx, dy) = (80, 0)` 并保持，尺寸进入 220ms 后截图；基础直径 84，水平轮廓 87.36px、垂直轮廓 84px；pull 1、glowOffset `(-4, 0)` |
| releasing | 在组件视觉测试夹具中触发 releasing，于 460ms 的中点 230ms 截图；验证回弹中间帧和方向拉伸复位。真实业务 E2E 另行验证松手后的捕获流程，不得为截图推迟或改写捕获 |

Web 端出图与动效回归使用 Playwright；系统 `python3` 不自带该包，统一用 `uv run --with playwright python e2e/run_orb_shots_web.py`（动效为 `e2e/run_orb_motion_browser.py`，`forced-colors` 焦点环为 `e2e/run_orb_forced_colors_web.py`，12.3.1 对比度保持率为 `e2e/run_orb_contrast_web.py`，后两者还需 `--with pillow --with numpy` 做像素统计）。脚本只读 `packages/web/dist`，不改源码；Chrome 156 实测。

另需保留 focus-visible、hidden、reduced-motion 的行为断言；它们不替代上述 20 张必交截图。**2026-10-28 用户已对照官网「找同款 2.50s」「记日程 2.50s」完成视觉确认**（清玻璃透字、径向白环、双极色散、无投影、七态截图均通过）。官方四段演示只有浅色背景；深色主题的色散 RGB 仍为按亮度中性原理推导、非官方数据。idle 呼吸、扫光、方向拉伸、glow lag 与回弹曲线仍不得标记为“官方已验证”。

## 11. 变更影响

只影响入口视觉与动效，不改公开属性、手势语义、上报字段与截图排除规则。内部 CSS 变量、Flutter 常量和 painter 入参不属于新增宿主配置能力；不得借此改变 launcher-mode 默认值、releasePoint / capture.region、公开 API、网络 API 或 DB。

## 12. 官方帧实测（2026-10-27，优先级高于第 3 节）

### 12.1 取样方法与可复核性

- 素材来源：`hyperos.mi.com` 官方站点自带的产品演示视频（PC 版 880 × 1920、30fps），经官方站 Next.js chunk 中的资源解析逻辑还原原始 CDN 直链后下载。素材与抽帧**不提交进仓库**，实现期副本在仓库外。
- 取样帧两张，互相独立、背景不同，用于区分「球体自身颜色」与「透过球体的背景」：

  | 代号 | 帧 | 球心（像素） | 实测半径 R | 球外背景亮度 |
  | --- | --- | --- | --- | --- |
  | FIND-SAME | 「找同款」t = 2.50s | (459, 835) | 136.5px | ≈ 201，近似均匀 |
  | SCHEDULE | 「记日程」t = 2.50s | (525, 989) | 132.0px | ≈ 190，不均匀 |

- 亮度为 `L = 0.299R + 0.587G + 0.114B`；径向剖面按每像素半径、72 个角度取均值；角向取样在 `1.12R` 处每 30° 取 3 个半径均值。
- R 由「峰值后最陡下降沿」定位：FIND-SAME 在 r = 136 → 137 处单像素下降 26.2，判为真实球沿；SCHEDULE 的外沿是缓降，见 12.5。
- **半径归一化后的 alpha 推导只用 FIND-SAME**，因为它球外背景近似均匀（1.00R–1.30R 恒在 199–202），可按「白色图层叠加在 201 背景上」解出 `alpha = (L − 201) / (255 − 201)`。SCHEDULE 背景不均匀，只用于交叉验证趋势，不参与 alpha 定值。

### 12.2 主白环是径向渐变，不是等宽描边

FIND-SAME 实测白色叠加 alpha 随归一化半径变化（峰值在 `0.95R`–`1.00R` 形成平台，向内连续衰减，球沿处 2px 内硬切）：

| r / R | 实测 L | 推导 alpha |
| --- | --- | --- |
| 0.00 | 201 | 0.00 |
| 0.26 | 207 | 0.11 |
| 0.44 | 206 | 0.09 |
| 0.53 | 210 | 0.17 |
| 0.62 | 213 | 0.22 |
| 0.70 | 220 | 0.35 |
| 0.75 | 224 | 0.43 |
| 0.79 | 230 | 0.54 |
| 0.84 | 237 | 0.67 |
| 0.88 | 245 | 0.81 |
| 0.92 | 252 | 0.94 |
| 0.95–1.00 | 254 | 0.98（平台） |
| > 1.00 | 199–202 | 0（球外背景） |

结论与约束：

- alpha 半高点（0.49）落在约 `0.775R`，即视觉白带半高宽约 `0.22R`；56px 球体对应约 6px，但**不是 6px 实色描边**——它必须带一直延伸到球心方向的连续内衰减。
- T4-2 前的实现用 `border: 4px solid`，同时错在两处：等宽、且在 `0.86R` 以内直接归零；T4-2 已改为径向渐变。
- 峰值平台顶到球沿都保持 `alpha ≈ 0.98`，球沿是硬边（2px 抗锯齿），不得用模糊把球沿糊开。
- SCHEDULE 交叉验证一致：峰值 251.6 在 r = 131（0.99R），内侧同向连续衰减。

### 12.3 球心是真实透光，不是灰色磨砂

- FIND-SAME 球心 L = 201.2，球外背景 L ≈ 201 —— 球心与背景亮度差 < 0.3，推导 alpha ≈ 0。
- SCHEDULE 球心 L = 70.0，因为该处背景是深色文字 —— 同一元素在不同背景下球心亮度相差 131 个灰阶。
- 因此：球心**透传背景**，`0.45R` 以内白色叠加 alpha 上限 `0.11`，且实测无任何压暗。当前渲染出的灰心不是契约要求，属实现缺陷。
- 仅用均匀背景不能反推模糊半径；结合 12.3.1 的带文字背景后，确认核心接近清玻璃。`packages/web` 不使用 `backdrop-filter`；Flutter 透镜层读取的是**未模糊**的 backdrop（A）或**原始捕获图**（C），不引入模糊，见 13.5。浅色主题下球心区域不得比同位置背景更暗。

### 12.3.1 对比度保持率：核心必须接近清玻璃（2026-10-27 追加）

12.3 原先把 `backdrop-filter` 的 sigma 留作「实现自选」，理由是均匀背景无法反推模糊半径。**这个判断是错的**：均匀背景确实测不出模糊，但带文字的背景可以，而 SCHEDULE 帧正好是球压在深色文字上。

取球心水平带 `|dy| < 0.45R`，比较球内 `r < 0.55R` 与球外 `1.6R–3.2R` 的亮度标准差，定义 `对比度保持率 = std_in / std_out`：

| 对象 | 球内 std | 球外 std | 保持率 | 球内 p5 | 球外 p5 |
| --- | --- | --- | --- | --- | --- |
| 官方 SCHEDULE t=2.50s | 37.9 | 36.5 | **1.038** | 97 | 99 |
| 本项目 light-static（3px blur） | 27.4 | 54.2 | **0.505** | 137 | 79 |

- 官方保持率 `1.038`，球内外 p5 仅差 2 个灰阶 —— **官方核心实质上是清玻璃，没有可测的磨砂**。
- 本项目保持率 `0.505`，丢掉一半对比度，球内 p5 比球外高 58 个灰阶 —— 文字被糊白。
- 局限：官方球内外落在不同字形上，std 不是完全受控对比；但 2 倍差距远超字形差异可解释的范围，且 p5 的一致性（97 对 99）与之互证。官方球内 min 59 对球外 min 15 说明极暗笔画仍有衰减，故结论是「接近清玻璃」，不是「完全无衰减」。
- **硬性验收指标（取代 12.3 原先的「实现自选」）**：在带文字背景的截图上，`对比度保持率 ≥ 0.85`。同时保留 12.3 的亮度约束（球心不得比同位置背景更暗）——亮度与对比度两项必须同时满足，只测亮度会漏掉纯模糊造成的缺陷。
- 两端一致：Flutter 侧 `ImageFilter.blur` 的 sigma 受同一指标约束，不得各自取值。

**自动化与实测值（2026-10-29）**：该指标已固化为两端共用口径的回归用例，不再只有人工测量。

| 端 | 载体 | light 保持率 | dark 保持率 | 球外 std |
| --- | --- | --- | --- | --- |
| Flutter | `flutter/feedback/test/orb_contrast_test.dart`（普通 `flutter test`，走 `OrbPainter` 直绘） | **0.8991** | **0.8990** | 76.50 / 92.00 |
| Web | `e2e/run_orb_contrast_web.py`（Playwright，`uv run --with playwright --with pillow --with numpy`） | **0.8997** | **0.8988** | 76.50 / 92.00 |

- 两端差 < 0.001，采样数完全相同（球内 2738、球外 9206 设备像素）。浅色亮度约束同时满足（球内均值 137.8 对背景 124.5，更亮不更暗）。
- `0.899 ≈ 1 − 0.10` 与第 4 节图层 4 的「`0.45R` 以内白色叠加 alpha 上限 `0.11`」互相印证：清玻璃核心的保持率上限由该 alpha 决定，不是由模糊决定。
- **背景用周期性竖条纹，不用真实文字**：本节上面已写明官方测量的局限是「球内外落在不同字形上，std 不是完全受控对比」。条纹（周期 8 设备像素、50% 占空比、关于球心对称）把这个变量消掉，球内外的理论 std 相同；用例先自检 `fixtureRatio`（只有背景时球内外 std 之比，实测 1.0000），再算保持率，并另算一条受控保持率（同区域「有球 / 只有背景」之比）。这比用真实文字更严，不是更松。
- 变异验证：Flutter 把核心白 alpha 从 `0.11` 提到 `0.30` → 0.832 / 0.834 转红；Web 给 `.fb-orb-core` 加 `backdrop-filter: blur(3px)` → 0.055 / 0.045 转红。
- 条纹夹具的数字与官方帧的 `1.038` 不可直接比（背景构造不同）；官方帧那一行仍是唯一的官方参照，不得用条纹实测值替换它。


### 12.4 内部没有独立高光点

- 在 `r < 0.80R` 的球内区域统计：FIND-SAME 37473 像素、SCHEDULE 35037 像素，**两帧中 L ≥ 245 的像素数均为 0**；而同帧白环平台为 251–254。
- 两帧球内最亮点分别为 239（偏移 `+0.65R, −0.45R`）与 241（`+0.58R, −0.54R`），量级与白环内侧衰减段一致，不构成独立高光。
- 球内四象限均值由背景决定而非固定高光：FIND-SAME 上半更亮（220.9 / 217.2 对 202.7 / 207.0），SCHEDULE 下半更亮（221.5 / 223.1 对 207.2 / 205.3），方向相反。
- 结论：废止 `18 × 10` 椭圆高光与 `4px` 亮点。球内任意位置亮度不得达到白环平台量级，也不得出现与背景无关的固定亮斑。

### 12.5 外发光范围远小于当时的实现（T4-2 前）

- FIND-SAME：球沿外是硬切，1.00R 外 2px 内即回到背景，**无可测外发光**。
- SCHEDULE：球沿外为缓降，r = 132（251）降到 r = 146（197）后持平，外扩约 `0.11R`。
- 取两帧上界：外发光 ≤ `0.11R`，56px 球体约 3px。当时实现的 `inset: -12px` 相当于 `0.43R`，约为实测上界的 4 倍；T4-2 已改为 `inset: -3px` + `blur(4px)`。
- **重要限定（2026-10-27 追加）**：本节的 `0.11R` 只约束**白色（亮度）外发光**。球外还存在一圈**几乎不贡献净亮度的彩色环**，径向范围远大于 `0.11R`，见 12.6。不得用本节的 `0.11R` 去裁掉色散层。

### 12.6 色散是单轴双向，有确定角度

`1.12R` 处 `B − R` 的角向分布（图像角：0° = 正右，顺时针递增，因屏幕 y 轴向下）：

| 图像角 | FIND-SAME `B−R` | SCHEDULE `B−R` |
| --- | --- | --- |
| 0° | −30.3 | −24.0 |
| 30° | **−57.0** | **−53.7** |
| 60° | −45.0 | **−83.0** |
| 90° | −20.3 | −23.3 |
| 120° | +4.7 | +6.0 |
| 150° | +27.7 | +29.0 |
| 180° | +45.3 | +52.3 |
| 210° | **+65.3** | **+73.0** |
| 240° | +54.7 | +60.3 |
| 270° | +36.7 | +153.7（受背景蓝色元素污染，不采信） |
| 300° | +17.3 | +17.7 |
| 330° | −3.0 | −4.7 |

- 暖向（`B−R` 负）集中在图像角 `30°–60°`，冷向（`B−R` 正）集中在 `180°–240°`，两帧独立一致。
- 轴向约为图像角 `45°（暖）↔ 210°（冷）`，近似对穿，**不是四色等权整圈**。
- 转换到 CSS `conic-gradient`（`0deg` = 12 点、顺时针）：`conic = 图像角 + 90°`，故**暖色心位于 conic `135°`，冷色心位于 conic `300°`**。Flutter `SweepGradient` 的 0 弧度同样在正右方向，用图像角直接取值。
- 幅度上界：`|B−R|` 最大约 65–83，对应中等强度染色，不得做成高饱和彩环。

### 12.6.1 色散是球外附着环：径向范围与所需强度（2026-10-27 追加）

12.6 原先只在 `1.12R` 单一半径取样，无法排除「那里本来就是彩色背景」。现已沿同一角度做径向追踪，取 `split = (B−R)@210° − (B−R)@30°`：

| r/R | FIND-SAME split | SCHEDULE split |
| --- | --- | --- |
| 1.04 | +140.3 | +59.3（210° 读数疑似截断，不采信） |
| 1.12 | +123.0 | +135.0 |
| 1.25 | +84.3 | +102.0 |
| 1.50 | +4.3 | +20.3 |
| 1.80 | 0.0 | 0.0 |
| 2.20 及以外 | 0.0 | 页面内容干扰，不采信 |

- split 从球沿向外**单调衰减并在 `1.8R` 精确归零**，两帧一致 → **这是附着在球上的色散环，不是页面背景**。12.6 的结论成立。
- **自动断言口径（T10 记录）**：`flutter/feedback/test/orb_painter_test.dart` 的 `split ≥ 40` 只是「色散存在」的下限 smoke，不是峰值验收值；峰值按本表 `1.12R` 的 `123 / 135` 量级判定。2026-10-28 复核实现为 Flutter `129` / Web `125`（`1.12R`），`1.25R` 为 `69 / 65`，均在两帧自身波动内。
- 径向范围：从球沿起，峰值在 `1.04R`–`1.12R`，到 `1.50R` 基本耗尽，`1.80R` 为零。即色散环外扩约 `0.5R`（56px 球约 14px），**远大于 12.5 的白色外发光 `0.11R`**。
- 净亮度贡献接近零：FIND-SAME 在 `1.12R`、30° 的 RGB 为 `(224.7, 199.3, 167.7)`，亮度 203.3，而局部背景 ≈201 —— 只改色、几乎不改亮度。所以它必须实现为**染色环**，不是白色 bloom。

所需有效 alpha（按普通合成在灰 201 背景上反解）：

- 暖侧，用 `rgb(255, 190, 120)`：`B = 201 − 81α = 167.7` → **α ≈ 0.41**；回代 `R = 201 + 54α = 223.2`（实测 224.7）、`G = 196.5`（实测 199.3），吻合。**暖色 RGB 原值正确，缺的是 alpha。**
- 冷侧，`1.12R`、210° 实测 `(161.0, 198.3, 226.3)`。用 `rgb(120, 220, 255)`：`R = 201 − 81α = 161` → **α ≈ 0.49**；`B = 227.7`（实测 226.3）吻合，但 `G = 210.4` 比实测 198.3 高 12。改用 `rgb(120, 200, 255)` 后 `G ≈ 200.5`，更贴合。
- 当时实现（T4-2 前）的有效 alpha 仅 `0.22 × 0.55 ≈ 0.12`，约为所需值的 **1/4**，这是「色散几乎看不见」的真正原因；T4-2 已按本节重做。第 3.2 节的 `0.55` 上限是自拟值，不是实测约束，**据此作废**。
- 暖冷之间的过渡区实测接近中性（`120°` 为 `+5`、`330°` 为 `−3`），因此过渡段应为**透明**，不是第三种颜色。**`--fb-orb-pale-purple` 作废**，不再引入紫色填充。

### 12.6.2 色散必须对局部背景亮度中性：深色不得沿用浅色 RGB（2026-10-27 追加）

12.6.1 的 alpha 是在**浅色灰 201 背景**上反解的，而 3.2 节当时写「深色同浅色」。这是错的：固定 RGB `rgb(255,190,120)`（L≈200）与 `rgb(120,200,255)`（L≈190）在深色背景（L≈32–62）上远比背景亮，色散环会退化成**发光光环**。

深色实测（本项目 `dark-static.png`，环上 `1.12R`）：

| 量 | 浅色 | 深色 |
| --- | --- | --- |
| 环上亮度 L@1.12R | 206.59 | 106.90 |
| 远场背景 L | 219.98 | 32.15 |
| 差值 | −13.40 | **+74.74** |

浅色在同半径无球对照下净差仅 `+0.35`（远场差值 −13.4 受页面自身渐变污染，不作判据）；深色即便对 `1.35R/1.50R` 的局部背景（61.8）也有约 `+45`。视觉上深色球已读成灯泡，不是玻璃透镜。

**契约修正**：色散由两个量共同定义，**不是由固定 RGB 定义**：

1. **色分裂**：峰值半径处 `split = (B−R)@冷 − (B−R)@暖 ≈ 123`（12.6.1）。
2. **色散层亮度中性**：同一画面、同一半径、同一主题下，以 `ΔL_glow = L(glow 开启) − L(glow 关闭)` 隔离色散层贡献；`1.04R–1.25R` 范围内 `|ΔL_glow| ≤ 8` 个灰阶，两个主题都必须满足。

不得把「总画面相对无球背景的亮度差」用于色散层验收：`1.12R` 仍落在白色 bloom 内。深色分层实测证明，即使整层关闭 glow，bloom 单层仍贡献 `+27.57`；把总差要求为 `≤ 8` 等价于要求色散层主动压暗抵消白环，会迫使 alpha 变为 1 的不透明补偿色，违背「透明染色环」模型。白色 bloom 的径向衰减独立验收：`1.35R` 处总差 `≤ 8`、`1.60R` 处回到 0（当前实测分别 `+4.35`、`0`）。

深色令牌按**bloom 合成后的实际衬底**而非裸背景求解：`--fb-orb-warm: rgba(200, 24, 0, 0.43)`、`--fb-orb-cyan: rgba(0, 76, 255, 0.33)`。实测 `ΔL_glow = −0.62`、split `123.82`；浅色 `ΔL_glow = −4.83`，两端均满足。早期按裸背景手算的 `rgb(100,17,0)` / `rgb(0,46,115)` 仅为诊断起点，**作废，不得实现**。

**深色 RGB 是按浅色实测原理推导的设计值，不是官方数据** —— 官方四段演示均为浅背景，无深色帧。可引用的官方依据只有「色散是染色、净亮度接近零」这一条原理；具体深色观感已于 2026-10-28 随 T8 深色截图由用户确认，仍非官方数据。

### 12.6.3 径向剖面的验收必须在均匀背景上进行（2026-10-27 追加）

12.2 的 alpha 表是在 FIND-SAME 的**近似均匀背景**（1.00R–1.30R 恒为 199–202）上反解的。在带文字 / 带渐变的测试页上，「背景」取哪个半径会直接改变反解结果。同一张 `light-static.png` 的 `0.84R`：

| 背景取法 | 背景 L | 反解 alpha |
| --- | --- | --- |
| `1.35R / 1.50R` 均值 | 198.0 | **+0.693** |
| 远场 `2.4R / 2.8R` | 220.0 | +0.501 |
| `1.80R` | 209.8 | +0.614 |

同一张图摆动 0.19，而契约容差只有 ±0.03 —— **原验收口径无效，责任在规格**。

**修正**：12.2 的径向 alpha 验收只在**均匀背景**台架上进行（即 T2b 已搭的 L≈201 均匀背景），此时背景无歧义。带文字截图仅用于 12.3.1 的对比度保持率与 12.4 的亮斑检查，不用于反解径向 alpha。

**2026-10-28 复核补充**：FIND-SAME 的球周背景并非严格均匀——按扇区实测约 `201`（左）、`203–204`（右）、`205–206`（上），下方受场景物体影响可低至 `196`；上表 `199–202` 是当时沿固定方向的读数。结论不变：径向 alpha 只在纯色 L≈201 台架上验收；官方帧仅用于量级对照，归一化时取球周干净扇区的局部背景。

### 12.8 没有可测的投影（2026-10-27 追加）

按远场背景检查球沿外是否存在低于背景的暗环：

| r/R | FIND-SAME Δ vs 远场 bg(179.7) | SCHEDULE Δ vs 远场 bg(180.7) |
| --- | --- | --- |
| 1.02 | +19.3 | +59.6 |
| 1.10 | +20.8 | +23.6 |
| 1.25 | +22.6 | +5.5 |
| 1.40 | +21.6 | −3.4 |
| 1.60 | +16.5 | −4.7 |

- 两帧在球沿外都**没有出现有意义的压暗**：FIND-SAME 全程高于远场背景；SCHEDULE 最深只有 `−4.7` 个灰阶，量级与页面内容波动相当。
- 结论：**官方帧中不存在投影**。可能存在的投影强度上界约 5 个灰阶，而原 `--fb-orb-shadow`（浅色 `rgba(0,0,0,0.14)` / 20px）会产生 20–30 灰阶的压暗，与实测矛盾。
- **第 3.2 节的 `--fb-orb-shadow` / `kFeedbackOrbShadow*` 及 3.2 节末尾的 Flutter 阴影映射段落全部作废。** idle 态两端均为无投影。
- 拖动态未被取样帧覆盖（两帧都是静止悬浮态），因此 `.fb-orb.is-dragging` 的投影属于**设计推断**：当前实现不使用投影，2026-10-28 随 T8 拖动截图验收确认；该决定仍为推断，不得写成官方依据。

### 12.7 本节未能证明的内容

- idle 呼吸、白色扫光：取样帧为交互进行中的片段，无法观察长时间静止态，第 3.1 节的 `5.4s` 呼吸与 `10s` / `40deg` / `0.80` 扫光仍为设计推断。
- 官方站明确标注演示画面可能经过剪辑或倍速处理，因此**不得用视频时长反推系统动画时长**。
- `4px 白环`、`blur 3px`、`10s 扫光` 是本项目自拟实现参数，不是官方数据；本节已用实测值取代前两项。

## 13. 官方实现参数（超级小爱 8.3.30.4420，2026-10-16）

### 13.1 来源、取证边界与优先级

- 2026-10-29 从用户提供的官方安装包（超级小爱 8.3.30.4420，2026-10-16）解压目录只读取证。包体、反编译代码与任何提取资源**均不进入仓库**，公开文档不记录本地路径。
- 与灵感球直接相关的资源：`intentional_ball_v2_main_frag`（折射/PBR 主体）、`intentional_ball_v2_glow_frag`（外发光/背景合成）、`_burst_frag`、`_bg_frag`、`intentional_ball_vert`；三态小球的 Lottie 在 `assets/float_orb/`（listening / thinking / executing，80×80、60fps）。
- 主体采样 `samplerExternalOES uBg` + `uBgTransform`：官方读取的是**整屏背景纹理**。这解释了参考帧中“球外图标出现在球缘”：它是折射采样，不是均匀放大，也不是后置鱼眼滤镜。
- 优先级：**光学结构与默认值以本节为准；像素级 alpha / 亮度目标仍以第 12 节的官方视频实测为准**。两者冲突时在任务记录中逐项写明取舍，不得静默覆盖。
- 本节数值是该版本**混淆参数类的构造默认值**；设备、场景与运行时状态可能覆盖，不写成“所有机型固定值”。

### 13.2 光学核心默认值

| 参数 | 默认值 | 含义 / 用途 | 本项目采用 |
| --- | --- | --- | --- |
| `IOR` | `5.17` | 折射率；着色器钳制在 `1.001–8.0`。远高于真实玻璃（≈1.5），属风格化强折射 | 作为 Flutter 透镜目标值；Web 不适用 |
| `Refraction` | `1.31` | 折射位移强度 | 目标值 |
| `Dispersion` | `0.61` | 色散强度，着色器钳制 `0–2.5`；是乘数，不是 CSS alpha | 强度目标，不直接替换 §12.6 的 alpha |
| `EdgeWidth` | `1.73` | 边缘宽度权重 | 目标值 |
| `Reflection` | `0.02` | 反射强度 | 目标值 |
| `Highlight` | 构造未赋值（默认 `0`） | 高光；运行时可能被覆盖 | 待复核 |
| `Glow` | `0.4` | 外发光 | 目标值 |
| `Flow` | `1.32` | 流动强度，钳制 `0–1.8` | 设计推断，是否引入见 §13.4 |
| `LensConcave` | `0.81` | 透镜凹面程度 | 目标值 |
| `OuterLayerMix` | `1.07` | 外层混合 | 目标值 |
| `OuterLayerConcaveMix` | 构造未赋值（默认 `0`） | 凹面外层混合 | 待复核 |
| `ColorIntensity` | `0.32` | 颜色强度，钳制 `0–2.2` | 目标值 |
| `Fusion` | `1.14` | 与背景的融合 | 目标值 |
| `Caustic` | `0.52` | 焦散 | 目标值 |
| `Background` | `0.85` | 背景权重 | 目标值 |
| `Radius` | `0.08` | 球半径 = `0.08 × 视口高`，钳制 `0.02–0.34` | 仅作参考，见 §13.3 |
| `V2MainBackground` | `0.83` | v2 背景权重 | 目标值 |
| `V2Iridescence` | 构造未赋值（默认 `0`） | 虹彩；运行时可能被覆盖 | 待复核 |
| `V2GlowTint` | `1.15` | 发光着色 | 目标值 |
| `V2ColorEnergy` | `0.936` | 颜色能量 | 目标值 |
| `V2OuterGlowStrength` | `1.46` | 外发光强度 | 目标值 |
| `V2UnclippedGlow` | `1.0` | 外发光不被裁切 | 目标值 |
| `V2FullBackPlateSdf` | `1.0` | 全背板 SDF | 目标值 |
| `BackPlateStrength` | `0.24` | 背板强度 | 目标值 |
| `BackPlateBlur` | `1.1` | 背板模糊 | 目标值 |
| `BackPlateOffset` | `(0, +0.073)` | 背板偏移（代码对 Y 取负） | 目标值 |
| `V2CoolGlowColor` | `(0.733, 0.827, 0.886)` | 冷侧发光，线性 RGB | 色相目标 |
| `V2WarmGlowColor` | `(1.0, 0.68, 0.34)` | 暖侧发光，线性 RGB | 色相目标 |
| `V2BaseShadowColor` | `(0.99, 0.95, 0.94)` | 基础阴影色 | 参考 |
| `V2ContactShadowColor` | `(0.98, 0.945, 0.935)` | 接触阴影色 | 参考 |

补充：

- 官方主着色器的折射使用 `refract(viewDir, normal, 1/IOR)`，并用 `LensConcave` / `OuterLayerMix` / `OuterLayerConcaveMix` 混合内外层；色散是对 RGB 分别采样。它不是“把背景整体放大 N 倍”的单一矩阵。
- 官方有 `uPresence`、`uSpawn`、`uExit`、`uBurst` 等生命周期参数；其默认值由运行时设置，不属于本节静态表。

### 13.3 几何与尺寸

- `Radius = 0.08` → 球半径 = 视口高的 8%，直径 = 16%。GIF 参考帧 640×1387 对应直径 ≈ `222px`，实测球径约 `220px`，吻合。
- 这解释了参考帧中球体很大：它是系统级悬浮球，不是 56px 的入口。**本项目仍保持 56 / 84，不按官方尺寸调整**；官方尺寸只用于解释参考帧与换算折射区域。
- 56px 球体在 `lensScale = s` 时的源区约为 `56 / s`；具体 `s` 与折射近似方式由 T-L1 裁决。

### 13.4 与既有条款的关系（必须一起读）

| 既有条款 | 官方实现 | 本节处理 |
| --- | --- | --- |
| §4.1 / §7.1 / §10.1 / §12.3：两端不使用 `BackdropFilter` | 官方用整屏纹理做折射 | **Web 仍全面禁止 `backdrop-filter`**。Flutter 按 T-L1 裁决：默认 **C**（捕获 `ui.Image` + 自定义片元着色器，不读 backdrop；新增一个 `.frag` 资产，无第三方依赖），退化 **A**（单层 `BackdropFilter` + `ImageFilter.matrix`，无 blur）；**B 的多层 backdrop 不采用**。C 只允许单次捕获、本地内存，约束见 §13.7 |
| §12.8：无可测投影 | `ContactShadow = 1.16` 默认开启；`ContactShadowGain ≈ 0.205`（另一运行时分支 `0.164`），`Blur = 1.83` | 参考帧未测到明显压暗，**本次保留“无投影”**；接触阴影列入 T-L1 对照项，默认不实现 |
| §3 / §6：刚体、无胶囊形变、无侧边停靠 | `DeformStretch/Neck/Slosh = 1.26 / 1.18 / 1.62`；`SideMode` / `SideEdgeWidth = 1.35` / `SideStretch = 1.28` / `SideBridgeLength = 0.4` / `SideFilmDistance = 1.0` / `SideRadiusShrink = 0.2` / `SideShrinkComplete = 0.8` / `SideExitTailDistance = 0.6` | 本次范围是“球体光学”，**不做形变与侧边停靠**；它们是官方行为，但不是本次交付，另议 |
| §12.6：静态双极色散、实测 alpha | `Dispersion = 0.61` 是着色器乘数；发光为线性 RGB，且带有 `Flow` 动态 | 不把 `0.61` 直接写成透明度，也不逐值替换 §12.6.1 的 sRGB 实测值；只取强度与色相作为目标。动态虹彩本次不做 |

### 13.5 平台能力矩阵

| 能力 | Flutter | Web |
| --- | --- | --- |
| 读取宿主背景纹理 | 组件无法直接读取；需 `RepaintBoundary` 捕获，或使用 `BackdropFilter` 固定滤镜 | 不支持（Chrome 实测 `backdrop-filter: url(#f)` 解析但无渲染） |
| 真实折射 | 默认 **C**：单次捕获 + 自定义片元着色器（近似折射，非官方 shader 复刻）；退化 **A**：单层矩阵；**B 不采用** | 不做；CSS 近似 |
| 捕获频率 | 只允许单次（出现 / 拖动开始 / 内容失效），禁止每 N 帧 | 不适用 |
| 首帧 | C 首图未就绪时显示 A 或上一帧；首捕获失败有界重试，仍失败保持 A | 不适用 |
| 快照陈旧 | C 的已知代价：宿主滚动/动画期间会陈旧或错位 | 不适用 |
| 官方光学参数 | 作为目标值（`IOR` / `Refraction` / `Dispersion` / `EdgeWidth` / `LensConcave` …） | 作为颜色/边缘/发光目标，不承诺折射 |
| 尺寸 | 56 / 84 不变 | 56 / 84 不变 |
| 接触阴影 | 官方默认开；本次不做 | 不做 |
| 形变 / 侧边停靠 | 本次不做 | 本次不做 |

**实现落点（T-L3，2026-10-29）**：

- Flutter 组件包已按本节落地：A 路线用 `RepaintBoundary → ClipPath → BackdropFilter(ImageFilter.matrix)`（`G·S(1.70)·G⁻¹`，无 blur）；C 路线用宿主 `RepaintBoundary` 单次 `toImage` + 新增 `shaders/orb_lens.frag`（七点径向表、`r/M(r)` 采样、`r>1` 透明），失败/首帧/不可用时退回 A。
- 以上“Flutter”包含 Flutter Web 构建；**`packages/web` 的 TS 组件仍全面禁止 `backdrop-filter`**，两条实现互不影响。
- C 的观测边界（已记录，属已知代价）：快照在宿主滚动/动画期间会陈旧；捕获失败只重试 2 次；一秒闸门内不补拍；拖动拉伸用椭圆掩膜对齐（`uStretch`/`uAngle`）。

### 13.6 对 T-L1 的输入

T-L1 已于 2026-10-29 完成裁决，结果见 §13.7；本节参数仍是后续实现的目标值。任何路线都不得把“近似”写成“官方复刻”。

### 13.7 T-L1 裁决（2026-10-29）

**结论**：Flutter 默认 **C（单次捕获 + 片元着色器）**，退化 **A（单层矩阵）**；**B 不采用**；Web 不做真实透镜，仍用 CSS 近似。

| 路线 | 保真度 | 成本 | 平台 | 结论 |
| --- | --- | --- | --- | --- |
| A 单层矩阵 | 中低：清晰均匀放大 | 最低 | macOS / Android / Web / test 均可采样 | 退化路线 |
| B 多层 backdrop | 中：硬环有径向变化 | 4 次 backdrop | 硬环可运行；软径向遮罩在 test 中使中心退化到 1.0× | 不采用 |
| C 捕获 + shader | 最高：中心放大、边缘压缩、RGB 分采样 | 单次捕获成本波动 | 三端单次均可；test 可采样 | 默认路线（待产品化验证） |

**尖刺报告值（待产品化复测，不作为验收结论）**：

- A：中心条纹 `1.667–1.833×`；叠加 `stateScale + breath + 方向拉伸` 约 `1.75×`，正立、清晰。
- C：径向表观倍率 `1.700 / 1.698 / 1.671 / 1.577 / 1.401 / 1.173 / 0.866`（`r/R = 0 / 0.25 / 0.50 / 0.70 / 0.85 / 0.95 / 1.0`），球缘源采样约 `1.156R`。**产品化口径（T-L2 裁决）**：源点一律按 `r / M(r)` 推导，`1 / 0.866 = 1.1547`，与报告里四舍五入的 `1.156` 相差 `1.3e-3`（属测量/取整噪声）；保留测得的表值 `0.866`，不给源点单独造常量，T-L3 以函数结果为准。
- 公共球沿壳层：`split` `1.04R = 71.6`、`1.12R = 113.4`、`1.25R = 68.2`、`1.50R = 13.8`、`1.80R = 0.4`；半高点约 `0.775R`。壳层三路线相同，不作为内核色散能力证明。
- 持续帧 P95：macOS `A 1.387 / B 1.707 / C 1.616` ms；Android 16 模拟器 `A 22.871 / B 22.779 / C 24.289` ms；Flutter Web `A 2.300 / B 2.500 / C 2.401` ms。
- 首次捕获：macOS `97.853ms`（预热后 4.6–10.4ms）；Android 一次成功运行 `158.249ms`，另一次报 `Invalid image dimensions`；Web 单次 `25.3ms`。

**C 的落地约束**：

1. 只在球出现、拖动开始或宿主内容失效时捕获一次；**不做每 N 帧捕获**。
2. 新图未就绪时显示 A 或上一帧；首捕获失败有界重试，仍失败保持 A。
3. 快照期间宿主滚动/动画会造成陈旧或错位，这是单次方案的主要视觉代价。
4. `ui.Image` 仅存在本地内存；不上传、不写原始捕获文件。

**未验证 / 明确不能声称**：

- **Android 模拟器三路线均未满足 16.7ms**，不能声称帧预算已验收；未外推真机。
- Android 首捕获有波动；有界重试、设备端拖动开始捕获尚未验证。
- Web 周期捕获会丢失宿主背景，**视觉不通过**；只有单次捕获可用。
- 对比度保持率 12.3.1、七态、命中区、badge 未在尖刺中覆盖，留给 T-L3 / T-L7。
- C 是独立近似，不是官方 shader 复刻；B 的软遮罩失败是否只存在于测试渲染器，未定性。
- **2026-10-29 用户裁决**：接受 C 作为默认、A 作为退化；允许一次本地单次捕获（不上传、不写盘）；禁止周期捕获。T-L2 起进入产品化。
- **2026-10-29 T-L2 完成**：上述径向表与滚动角已固化为 `flutter/feedback/lib/src/orb.dart` 的常量与顶层纯函数（commit `5b561f8`，`orb_lens_test.dart` 17 例、全量 384 例通过）；源点口径取 `1 / M(1) = 1.1547`，未单独造常量。详见任务记录 §9.1。


### 13.8 实现状态与平台差异（2026-10-29）

**Flutter 组件包已实现**（分支 `feat/20261029-orb-lens-replica`）：

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| 真实放大 | A：单层 `BackdropFilter(ImageFilter.matrix)`，中心 `1.70×` | 条纹拟合 `1.7000`、中心偏移 `0.25px` |
| 径向折射 | C：宿主 `RepaintBoundary` 单次捕获 + `shaders/orb_lens.frag`，`1.700 → 0.866` | 球心 `1.6875`、球缘 `<1.0` |
| 拖动拉伸 | A 用 `G·S·G⁻¹`；C 用 `uStretch`/`uAngle` 椭圆掩膜 | 长轴 208 点无透明缝隙 |
| 透镜色散 | C 分通道采样，`B−R = 0.05R`（观感收敛值） | 球缘 `9.71px`（理论 9.60） |
| 退化 | 首帧/捕获失败/着色器不可用 → A | 失败注入用例 |
| 触发 | 首次可见一次、拖动开始一次、单在途、≥1000ms | `orb_lens_shader_test.dart` |

**平台差异（不得混淆）**：

- `packages/web`（TS 自定义元素）：**不放大**、不使用 `backdrop-filter`，只保留清玻璃核心 + 径向白环 + 双极色散 + 扫光；Web 的“放大”在当前 CSS 能力下不可实现（`backdrop-filter: url(#f)` 解析但无渲染）。
- Flutter（含 Flutter Web 构建）：真实放大与折射近似；C 依赖本地单次捕获。
- 两端都不实现：月牙/固定高光（§12.4）、接触阴影、液态形变、侧边停靠、动态虹彩。

**已知代价与未验证**：

- C 的快照在宿主滚动/动画期间会陈旧；一秒闸门内不补拍；捕获成本 macOS 首次约 98ms、Android 约 158ms。
- 色散幅度 `0.05R` 是观感裁决值，不是官方帧实测；球缘 `1.12R/1.25R` 的壳层 split 仍低于 §12.6.1 目标量级。
- 测试渲染器为软件光栅；Impeller 与 Skia 的滤镜差异、真机帧时间、拖动锚点滞后需在真机验收（任务记录 T-L7）。
- **Impeller GLES 的捕获纹理方向**：3.47 之前 GLES 后端把渲染目标纹理自下而上存放，C 路线采样时必须在 `IMPELLER_TARGET_OPENGLES && !IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED` 下翻转 `uv.y`；Skia/Metal/Vulkan 不翻转。该分支已在 `orb_lens.frag` 的 `sampleLens()` 内实现，并用非对称夹具回归（上下翻转会红）。
