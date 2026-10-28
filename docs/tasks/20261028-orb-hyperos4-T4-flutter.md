# T4 · 灵感球 HyperOS 4 的 Flutter 实现与回归（T4-1 – T4-6 + T7–T10 收口）

- 记录时间：2026-10-28（+08:00），记录人：规划者
- 仓库：`Sakura-Feedback`（本地工作区），分支 `main`，HEAD `ccd99b7`
- 设计契约：[docs/orb-spec.md](../orb-spec.md)（T1 产出；第 12 节官方实测优先级高于第 3 节）
- 基线快照：[20261027-orb-hyperos4-T0-baseline.md](20261027-orb-hyperos4-T0-baseline.md)（HEAD `ccd99b7`，89 tracked 修改 + 965 未跟踪文件）
- 范围：`flutter/feedback` 灵感球视觉与动效、相关测试、本记录与 Flutter README 的对应段落。T7g 起追加 Web 侧焦点环几何与截图夹具（`packages/web/src`、`e2e/`），T10 追加两端 README 与 spec；不含面板、截图选区、上报流程。
- 全程未提交：本任务的所有改动均为工作区未跟踪 / 未暂存状态，与既有 WIP 混存于同一工作区，禁止以 `stash` / `checkout` / `reset` / `clean` 区分。

## 1 任务状态

| 卡 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| T4-1 | 令牌与纯函数：`lib/src/orb.dart` 常量、`OrbPalette`、`orbBreath` / `orbPull` / `orbDragAngle` / `orbStretch` / `orbGlowOffset` / `orbShouldRunFlow` | 已验收 | `test/orb_geometry_test.dart`；2026-10-28 用户对照官方帧确认 |
| T4-2 | painter 材质四层（bloom / glow / sweep / core）、径向白环、清玻璃心、双极静态色散、40° 白环扫光；无投影 / 无 sheen / 无紫色 | 已验收 | `test/orb_painter_test.dart`；T8 20 张 + 官方帧对照 |
| T4-3 | 单一 10s 控制器、flow→breath 公式、post-frame 归零、可见性五输入、`AnimatedBuilder` 只重绘球体；`debugForceOrbAnimation` 测试缝 | 已验收 | `test/orb_animation_test.dart`；T7 优先级 / hidden 补强 |
| T4-4 | 尺寸与七态：56 / 84dp、220ms、hover 1.04、pressed 0.94（140ms）、连续 `stateScale`、删除 `BoxShadow`、badge 不缩放 | 已验收 | `test/orb_state_test.dart`；spec 7.4 已修订 |
| T4-5 | 拉伸 / 回弹：`dragAngle` / `pull` / `glowOffset` 接入、阈值 `> 8`、460ms `Cubic(0.2, 1.35, 0.32, 1)`、pull clamp、`pointercancel` 不捕获、reduced-motion 当帧归位 | 已验收 | `test/orb_drag_test.dart`；`test/orb_painter_test.dart`（拉伸轮廓比） |
| T4-6 | 回归断言与文档收尾（README 尺寸与材质描述、注解矛盾、本记录、spec 复核、全量验证） | 已验收 | §2 改动、§5.2；T10 文档收口见 §9 |

状态口径：未开始 / 实现中 / 待体验 / 已验收。T4-1 – T4-6 的仓库内自动断言与命令行验证已通过，2026-10-28 用户对照官网「找同款 2.50s」「记日程 2.50s」帧确认视觉后，按项目约定升级为「已验收」。T7–T10 的状态、证据与残余项见 §9。

## 2 T4-6 改动明细

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `flutter/feedback/README.md` | 修改 | 灵感球描述：`48dp / 72dp` → `56dp / 84dp`；删除「青/紫/暖橙光晕」，改为「清玻璃核心 + 向外连续增强的径向白环 + 双极暖冷色散 + 白环扫光」，并显式标注扫光 / 呼吸 / 方向拉伸 / 回弹曲线为**设计推断**；下文「静态光晕」改为「静态帧」，「72dp 展开」改为「84dp 展开」 |
| `flutter/feedback/lib/src/test_env.dart` | 修改 `+2 / −3` | 删除 `@visibleForTesting` 注解与随之无用的 `package:flutter/foundation.dart` import（含相邻空行），在文档注释补「公共开关、非宿主配置项、生产不开启常驻 Ticker」约定 |
| `flutter/feedback/lib/src/widget.dart` | 修改 `+0 / −1` | 删除生产侧 `// ignore: invalid_use_of_visible_for_testing_member`（T4-6 第 2 项），判断逻辑逐字不变；analyze 仍 0 issue |
| `docs/tasks/20261028-orb-hyperos4-T4-flutter.md` | 新增 | 本记录 |
| `docs/orb-spec.md` | 只读复核 | 本卡未改动；第 4 项发现的不一致见 §4.1，后由 T10 修订（§9.5） |

README 中 `青/紫/暖橙光晕` 的原描述与第 12.6.1–12.6.2 节（暖冷双极、过渡透明、无紫色）冲突，改为实测结论 + 设计推断标注，不把扫光 / 呼吸 / 拉伸 / 回弹写成官方依据（依据 spec 第 1 节末条与 12.7）。

行数口径：`README.md` 本次替换 1 行、新增 4 行（该文件相对 HEAD 另有 121 增 / 21 删的既有 WIP 改动，不在本卡范围）；`test_env.dart` +2 / −3；`widget.dart` +0 / −1。

## 3 三处行为变化与依据（T4-6 第 3 项）

### 3.1 reduced-motion 运行中切换：控制器停止 + 归零，而非 dispose

- 实现：`didChangeDependencies` 把 `MediaQuery.disableAnimationsOf(context)` 写入 `_orbGlowReduced`；`_syncOrbFlow` 在 `orbShouldRunFlow` 为 false 时 `stop()`，并在 post-frame 把 `value` 置 0（`widget.dart` 的 `_syncOrbFlow`）。控制器本身只在首次需要时创建，不因 reduce 而 `dispose`。
- 依据：spec 8.1 只要求「已存在的控制器停止」，8.2–8.3 要求静态帧 `flow = 0`、`breath = 0`；7.2 要求「只创建一个 10s 控制器」。若在此处 dispose，恢复 reduce 后必须重建，违反单控制器约定，也会让 `AnimatedBuilder` 持有的引用失效。
- 可观测：运行中切 reduce 后 `transientCallbackCount == 0` 且 painter 的 `flow == 0`、`breath == 0`；切回后 0.1s 内 `flow ∈ (0, 0.03]`（用例「运行中切换 reduced-motion 再恢复复用单一控制器」）。
- 与 Web 的差异：Web 无「控制器」概念，靠自定义属性 transition 停用；Flutter 用同一实例 stop/repeat，语义等价。

### 3.2 回弹过冲会短暂越过 56dp / 停靠位（同 Web cubic）

- 实现：`kFeedbackOrbReleaseCurve = Cubic(0.2, 1.35, 0.32, 1.0)`；尺寸（`AnimatedContainer`）、状态缩放（`TweenAnimationBuilder<double>`）与位移（`TweenAnimationBuilder<Offset>`）在 `_orbReleasing` 时统一使用该曲线。
- 依据：spec 3.1 的 `--fb-orb-release-easing` 与 `kFeedbackOrbReleaseCurve` 即此曲线；两个控制点的 y 分量为 1.35 和 1，插值必然 > 1，Web 端 `cubic-bezier` 同样过冲。契约 5 节 releasing 行的目标值为「当前 breathScale」与停靠位，过冲是曲线本身的性质，不是实现偏离。
- 已处理：`pull` 在回弹路径上 clamp 到 `0..1`（`safePull`），否则过冲的负 `pull` 会让 `orbStretch` < 1、`orbGlowOffset` 反向，产生方向的瞬时倒卷。
- 未处理（有意）：尺寸与位移的过冲未钳到目标值。钳制会改变与 Web 的观感一致性；若用户认为 56dp 被短暂突破不可接受，需先修订 spec 3.1 曲线，再两端同步。

### 3.3 回弹结束瞬间 `breathWeight` 0 → 1，bloom 呼吸有轻微阶跃（遗留）

- 实现：`OrbPainter.breathWeight` 在 `_isDragging || _orbPressed || _orbHovered || _orbReleasing` 时为 `0`，否则为 `1`；bloom alpha 为 `bloomWhiteAlpha × (1 + 0.08 × breath × breathWeight)`。回弹 `onEnd` 把 `_orbReleasing` 置 false，同一帧 `breathWeight` 由 0 跳到 1。
- 影响上界：bloom 白色 alpha 的最大跳变是 `bloomWhiteAlpha × 0.08 × breath`，即浅色 0.45 × 0.08 ≈ 0.036、深色 0.55 × 0.08 ≈ 0.044 的 alpha 阶跃，肉眼表现为呼吸亮度的轻微顿挫。
- 依据与差距：spec 5 的 breath 公式未包含权重项，7.4 只要求「任意入参变化都重绘」，因此当前实现不违反契约；Web 用 `--fb-orb-breath-weight` 加 transition 平滑，Flutter 没有对应过渡，属**两端已知差异**，记为遗留。若要消除，需新增一个权重过渡（例如对 `breathWeight` 做短时长 `TweenAnimationBuilder`），并在 spec 7 增加对应说明——本卡不做。

## 4 spec 与实现一致性复核（T4-6 第 4 项）

| 复核项 | 契约表述 | 实现 | 结论 |
| --- | --- | --- | --- |
| spec 7.4 `stateScale` | `double`，`0.94..1.04`；「布尔 pressed 无法表达 140ms 过渡，Flutter 用连续 stateScale 承载」 | `_orbTargetStateScale` 返回 `1.0`（idle/releasing/dragging）/ `1.04`（hover）/ `0.94`（pressed），由 `TweenAnimationBuilder` 以 220ms state curve、140ms press curve 过渡 | 一致 |
| spec 10.1 字段变异断言 | 「对每个 painter 绘制字段（flow、breath、stateScale、dragAngle、pull 及其余字段）分别做单字段变异测试；全部不变时不重绘」 | painter 共 9 个绘制字段：`flow`、`breath`、`breathWeight`、`stateScale`（0.94 与 1.04 各一）、`dragAngle`、`pull`、`glowOffset`、`brightness`、`dispersionOpacity`；`shouldRepaint` 逐项比较，测试逐字段单变量 + 全等负例 | 一致 |
| spec 3.1 `kFeedbackOrbStateCurve` | `cubic-bezier(0.16, 1, 0.3, 1)` | `Cubic(0.16, 1.0, 0.3, 1.0)` | 一致；同表 220ms / 460ms / 140ms、release `Cubic(0.2, 1.35, 0.32, 1.0)` 亦一致 |

### 4.1 复核中发现的不一致（T10 已修订）

> 下列两项已由 T10 修订，此处保留 2026-10-28 当时的复核记录。

- **spec 3.3 `--fb-orb-glow-inset` 仍写 `-2px` / `-2.0`**，而第 4 节图层表与 12.6.1 要求「外扩 14px = 0.5R」；实现 `kFeedbackOrbGlowInset = -14.0` 与第 4 节一致。3.3 是 T1 修订时漏改的残留行，建议单独一行改为 `-14px` / `-14.0` 并注明依据 12.6.1。本次未改，因该行不在 T4-6 列举的三处复核锚点内。**T10 已改为 `-14px` / `-14.0`，见 §9.5。**
- **色散 split 的自动断言阈值低于实测**：`test/orb_painter_test.dart` 断言 `split ≥ 40`，12.6.1 实测 `≈ 123`。测试注释已说明「峰值角度比较与 12.6.1 的 split 口径冲突」，属 T4-2 的既有决策，本卡不动；**T10 已在 spec 12.6.1 写清「下限 smoke ≠ 峰值」，见 §9.5。**

## 5 验证记录

### 5.1 改动前基线（2026-10-28，HEAD `ccd99b7`）

| 命令 | 原始结果 |
| --- | --- |
| `flutter --version` | `Flutter 3.47.7 • channel stable`，Dart 3.13.5（`~/devsdk/flutter/bin/flutter`） |
| `flutter analyze --no-pub` | `No issues found! (ran in 3.4s)` |
| `flutter test --no-pub` | `00:15 +330: All tests passed!` |
| `git status --short \| wc -l` | `259` 条（未跟踪目录折叠计），与 T0 的 89 tracked + 965 未跟踪一致 |

### 5.2 改动后（2026-10-28，全部 T4-6 改动落地）

| 命令 | 原始结果 |
| --- | --- |
| `flutter analyze --no-pub` | `No issues found! (ran in 2.8s)` |
| `flutter test --no-pub` | `00:14 +328` … `00:14 +329` … `00:15 +330: All tests passed!`（330 例） |
| `git status --short flutter/feedback \| wc -l` | `37` 条；条目集合与改动前一致（本卡未新增状态条目） |

本卡相关 `git status` 条目：

```text
 M flutter/feedback/README.md
 M flutter/feedback/lib/src/widget.dart
?? flutter/feedback/lib/src/test_env.dart          （改动前即未跟踪）
?? docs/tasks/20261028-orb-hyperos4-T4-flutter.md  （新增）
```

两次独立执行（前端分包与规划者复核）的 analyze / test 结果一致；未改动任何测试用例、未提交、未触碰其他 WIP。

## 6 未验证与遗留

未验证（一律不得写成「已通过」）：

- ~~视觉观感~~：2026-10-28 已由用户对照官网「找同款 2.50s」「记日程 2.50s」帧确认（清玻璃透字、径向白环、双极色散、无投影、七态截图与拖动放大均通过）。官方只有浅色背景，**深色观感仍是推导值**，见 §9.5。
- Web 端（T2）与 Flutter 的同帧一致性：T8 已用相同夹具各出 10 张，T10 用径向指纹做了数值对照（环 alpha 最大差 0.003、split 最大差 4）；未做逐像素 diff。
- 真实设备（iOS / Android / Web 宿主）上的动画帧率与 Ticker 行为：本次只在 `flutter test` 的 flutter_tester 与 Chrome 156 中运行。

遗留（本卡不处理）：

1. 84dp 拖动时命中区是否同步扩大（当前 `AnimatedContainer` 尺寸变化会带动命中区，需产品裁决）。
2. 是否绘制内侧 1px hairline（spec 3.3 保留 `kFeedbackOrbHairlineWidth`，实现未绘制）。
3. 深色色散观感（12.6.2 的深色 RGB 是设计推导值，非官方数据）。
4. 回弹结束的 `breathWeight` 阶跃（§3.3），需要新增权重过渡。
5. ~~spec 3.3 `glow-inset` 残留 `-2px` 与色散 split 断言口径~~：T10 已修订，见 §9.4。
6. T7 / T8 / T9 / T10 已完成收口；残余可选项见 §9.5。

## 7 T7–T10 计划与已定决策

### 7.1 focus-visible 采用方案 A（用户 2026-10-28 确认）

只读核对结论：Flutter 侧 `focus-visible` **完全未实现**——`lib/src/` 的灵感球路径没有 `Focus` / `FocusableActionDetector` / `onKeyEvent`，`kFeedbackOrbFocusWidth = 2.0` 与 `kFeedbackOrbFocusOffset = 2.0` 只有声明、无任何引用，灵感球也无法用键盘激活。因此 spec 5 的焦点环无法靠「补测试」完成，需先补实现（卡 T7a）。

T7a 实现约束（避免与既有测试冲突）：

- 只在 `widget.dart` 的 orb 段与 `orb.dart`（如需）改动；**不给 `OrbPainter` 新增字段**，保持现有 9 个绘制字段与 `orb_painter_test` 的单字段变异集不变。
- 焦点环几何等价 CSS `outline: 2px solid; outline-offset: 2px`，即覆盖 `R+2 … R+4`；颜色取 `Theme.of(context).colorScheme.primary`（spec 的 `--fb-accent` 在 Flutter 无独立令牌）。
- 仅在 keyboard 模式（`FocusHighlightMode.traditional`）显示；鼠标悬停 / 点击不显示；无过渡动画。
- 环随 pressed / dragging 保留，hidden 时随球一起移除；reduced-motion 下仍显示（spec 8.5）。
- 布局尺寸仍为 56（拖动 84），环不得扩大命中区；环在窗口边缘被裁切接受为现状。
- 自带 `test/orb_focus_test.dart`：键盘聚焦出现环、鼠标不出现、pressed / dragging 保留、hidden 移除、Space 与 Enter 各触发一次点按等价行为。

状态：已完成（T7a，证据见 §9.2）；本节保留实现约束的历史记录。

### 7.2 T7 优先级矩阵的 6 条缺口

现有 `orb_state_test` / `orb_drag_test` / `orb_animation_test` 已覆盖 idle、hover、pressed、dragging、releasing、220/140/460ms、pointercancel、回弹中再按下、释放中 hover、面板打开 / showLauncher / tab / occluded 的停止与归零。仍需补：

1. hover → pressed 的 0.94 抢占与松开回 1.04（单条优先级断言）。
2. hover 中拖动过阈值 → 84 / `stateScale` 1.0 / `breathWeight` 0。
3. pressed 未过阈值松手 → 不进入 releasing（不出现 460ms 回弹）。
4. releasing 中按下 → 取消回弹、`stateScale` 0.94。
5. releasing 中 `controller.open()` → hidden 抢占，关闭后 56 / 1.0 / `flow = 0` 起算。
6. **hidden 期间 `transientCallbackCount == 0`**——现有用例只断言「恢复后从 0 起算」，未断言 hidden 当期 Ticker 确实停止。

焦点环优先级断言已并入（T7b/T7c，见 §9.2）。

### 7.3 T8 前置风险：Web 令牌命名与 spec 3.1 不一致

`packages/web/src/styles.ts` 中 `--fb-orb-*` 共 18 个，但不含 `--fb-orb-size`、`--fb-orb-drag-size`、`--fb-orb-drag-scale`、`--fb-orb-edge`、`--fb-orb-sweep-arc`、`--fb-orb-bloom-inset`。spec 3.1 的「Web CSS 变量 ↔ Flutter 常量」对照表在 Web 侧并未按名字落地。出图前须先确认 56 / 84 与 40° 扫光弧宽在 Web 侧是硬编码还是另有来源，否则「两端 10 + 10 张一致」缺少可追溯依据。`e2e/run_orb_motion_browser.py` 已存在，Web 侧 orb 代码与 `registerProperty` 均在。

**收口结论（T10）**：Web 侧 56 / 1.5 / 40deg 确认为字面量，未按 token 命名；差异已记录在 spec 3.1，不影响出图与两端一致性判断。

### 7.4 派发通道记录

| 时间（+08:00） | 目标 | 结果 |
| --- | --- | --- |
| 15:59 | 前端（T4-6） | 成功 |
| 16:0x | 测试（T7，两次同一幂等 ID） | `Collaboration request failed (http)` |
| 16:3x | 前端（T7a） | `Collaboration request failed (http)` |
| 16:3x | 测试（T7，新幂等 ID） | `Collaboration request failed (http)` |
| 2026-10-28 晚 | 前端 / 测试 / 审查（项目工作区监管会话） | T7d–T9 完成并回执；T10 由规划者在项目工作区落地文档与注释 |

每次失败后均回读消息列表核对：**没有任何消息落库**（最新仍为 seq 5 的 T4-6 回执），因此重试不产生重复派发。按用户约束未改用本地子 Agent（额度已用尽），也未由规划者本人代写测试。

**追加证据（同日 16:5x）**：

- 正式派发卡（约 2.5KB）失败；**60 字短探针**同样失败 → 排除请求体积 / 超时。
- 同一会话内 `query_discussion` 读接口连续成功 → 读通写不通。
- 用户反馈「新会话里写接口可用」→ 故障**按会话隔离**，高度指向本会话的写绑定（Runtime Token / agent-message 会话绑定）失效，而非账号、网络或服务整体不可用。
- 系统层当前仍为 fake-IP + `utun4` 路由（`qoder.com → 198.18.0.130`），与「只加 DIRECT 出站规则」的表现一致，不能据此判断用户是否改过配置。

## 8 交接（给新会话或本地执行者）

> 本节是 2026-10-28 下午的交接预案；T7 / T8 / T9 已于当日晚完成，T10 已收口。当前状态、证据与残余项以 §9 为准，本节仅作历史记录。

若本会话写接口持续不可用，按以下顺序继续，无需重新调研：

1. **T7a（前端）**：`widget.dart` orb 段加 `FocusableActionDetector`（`autofocus: false`，hidden 时不参与遍历），焦点环用 `Stack` + `Positioned(-4)` + 圆形 `BoxDecoration` 边框（2px，覆盖 `R+2…R+4`，颜色 `colorScheme.primary`，无过渡，仅在 `FocusHighlightMode.traditional` 显示），Space / Enter 复用 `_handleLauncherTap()`；**不给 `OrbPainter` 加字段**；新增 `test/orb_focus_test.dart` 六条（聚焦出现 / 鼠标不出现 / pressed 保留 / dragging 保留且 badge 不变形 / hidden 移除 / 空格与回车各一次 open）。
2. **T7（测试）**：新增 `test/orb_priority_test.dart` 覆盖 §7.2 的六条缺口，外加焦点环优先级；用例开 `debugForceOrbAnimation` 时禁用 `pumpAndSettle`。
3. **T8（前端 + 测试）**：先确认 Web 侧 56/84 与 40° 弧宽的来源（§7.3），再按 spec 10.2 出 20 张图，夹具 `flow = 0.25`、`breath = 0.5`。
4. **T9（审查）**：只读审 `orb.dart`、`widget.dart` 的 orb 段与 T7 新增测试，按严重级别列问题。
5. **T10（前端）**：README 与交付文档收尾，必须写明「方向拉伸、glow lag、回弹曲线、呼吸、扫光均为设计推断，非官方已验证」。

每张卡的验收口径不变：`analyze --no-pub` 为 `No issues found!`、全量 `test --no-pub` 为 `All tests passed!` 且用例数只增不减、不 commit、不动列表外文件。

## 9 T7 收口记录（2026-10-28）

### 9.1 验收事件

用户对照官网 PC 帧「找同款 2.50s」「记日程 2.50s」与 T8 的 20 张截图后，于 2026-10-28 明确回复「验收通过，按 T7 收口」。据此：

- T4-1 – T4-6、T7a – T7i、T8 升级为「已验收」；
- T9 审查结论保留（无 Blocker；发现的 Major 均已修复，回归见 T7f / T7g）；
- 深色主题仍无官方帧，继续标为推导值，不计入「官方已验证」。

### 9.2 卡片与证据

| 卡 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| T7a | Flutter 焦点可见环 + 键盘激活（Space / Enter / numpadEnter） | 已验收 | `test/orb_focus_test.dart` |
| T7b | 七态优先级 6 条缺口 | 已验收 | `test/orb_priority_test.dart` |
| T7c | 焦点环与 pressed / dragging / hidden 的优先级组合 | 已验收 | `test/orb_priority_test.dart` |
| T7d | hidden 抢占 releasing，关闭后从 0 起算 | 已验收 | `test/orb_priority_test.dart`（优先级 8–10） |
| T7e | hidden 时 hover / releasing 残留清理 | 已验收 | `test/orb_hover_hidden_test.dart` |
| T7f | 覆盖层键盘防误触、关闭焦点回归、numpadEnter、控制器热替换 | 已验收 | `test/orb_keyboard_capture_test.dart`；`lib/src/capture_selection.dart` |
| T7g | Web 焦点环几何 = 当前视觉直径 + 8 | 已验收 | `packages/web/src/styles.ts`、`element.ts`、`test/orb-motion.test.ts`、`e2e/run_orb_motion_browser.py` |
| T7h | 测试硬化（自动焦点策略、空断言、变异校验） | 已验收 | `test/orb_highlight_mode_test.dart` + focus / priority 修订 |
| T7i | 输入模态门：指针关闭不点亮环、抑制一次 | 已验收 | `test/orb_keyboard_capture_test.dart` |
| T8 | 20 张截图矩阵 + manifest | 已验收 | `flutter/feedback/test/orb_shots_test.dart`、`e2e/run_orb_shots_web.py`、`e2e/shots/orb-hyperos4/{flutter,web}/` |
| T9 | 只读审查：无 Blocker；发现的 Major 均已修复，相关回归见 T7f / T7g | 已验收 | 审查回执；残余 Minor 见 §9.5 |
| T10 | 文档与注释收口 | 已验收 | 本节；spec、两个 README、本记录、`widget.dart` 3 处注释 |

### 9.3 收口复跑（2026-10-28 20:50–20:52，+08:00）

| 命令 | 原始结果 |
| --- | --- |
| `flutter analyze --no-pub` | `No issues found! (ran in 2.9s)` |
| `flutter test --no-pub` | `00:18 +360: All tests passed!` |
| `pnpm --filter @feedback/web test` | `Test Files 28 passed`、`Tests 359 passed` |
| `uv run --with playwright python e2e/run_orb_motion_browser.py` | `PASS=50 FAIL=0 TOTAL=50`（Chrome 156） |
| T8 截图夹具 | 10 + 10 PNG + 2 manifest；T8 运行时 171 项断言通过。本轮未重跑截图，避免改动 manifest 时间戳；Web 两次出图 hash 一致的结论沿用 T8 记录 |

### 9.4 官方帧对照（验收依据）

- 白色环 alpha（0.84 / 0.88 / 0.92 / 0.97R）：官方 `0.667 / 0.809 / 0.935 / 0.981`；Flutter `0.682 / 0.810 / 0.921 / 0.982`；Web `0.682 / 0.809 / 0.919 / 0.980`。最大差 `0.016`。
- 色散 split（冷−暖 B−R，1.05 / 1.12 / 1.25 / 1.50R）：官方 `131 / 118 / 78 / 0`；Flutter `124 / 129 / 69 / 1`；Web `124 / 125 / 65 / 5`。官方两帧自身在 1.25R 相差 38，实现落在其帧间波动内。
- 清玻璃：两边文字压球时字形保留、被白纱压淡，无磨砂；实现无 backdrop-filter，只对 bloom / glow 层做 blur。
- 对比度保持率（spec 12.3.1 的 `≥ 0.85`）：Web 侧在自建文字背景、273px 球的整页渲染上，按 `|dy| < 0.45R`、球内 `r < 0.55R` vs 球外 `1.6R–3.2R` 实测 **1.066**（球内 std 42.68 / 球外 40.02）。两侧文字布局不同，p5 不能直接对比；Flutter 未单独复测，该指标尚未固化为 CI 用例（见 §9.5）。
- 无 UI 投影：官方球下方的压暗来自场景物体（紫色卡片 / 机身），不是球体阴影；实现保持无投影。
- 方法边界：官方帧局部背景并非严格均匀（球周约 201–207），径向 alpha 按球周背景归一；纯色台架仍以 12.6.3 的 L≈201 口径为准。

### 9.5 T10 文档改动与残余项

已改（仅文档与注释，未改行为）：

- spec 3.3：`glow-inset` `-2` → `-14`；`core-backdrop-blur` 标记作废（实现无核心 blur）；
- spec 3.1：增补 Web 侧 56 / 1.5 / 40deg 仍为字面量、未按 token 命名的记录；
- spec 5：增补键盘激活、焦点回归与输入模态、环色映射与 `forced-colors` 风险、hidden 清理；
- spec 10.2：记录 2026-10-28 验收、Playwright / uv 运行方式；
- spec 12.6.1：记录 `split ≥ 40` 是下限 smoke，不是峰值验收值；
- spec 12.6.3：补充官方帧球周背景的方向差异（201–206，下方受物体影响可低至 196），明确纯色台架口径不变；
- spec 12.2 / 12.5：把已修复的旧实现描述标为「T4-2 前」，避免被读成当前行为；
- 本记录 §1 / §4.1 / §6 / §7.1–§7.3 / §9；`flutter/feedback/README.md` 与 `packages/web/README.md` 的灵感球描述；
- `flutter/feedback/lib/src/widget.dart` 3 处注释（`_orbFocusVisible`、build 内 hidden 清理、`onShowFocusHighlight`），行为零改动。

残余（未做，非本轮阻塞）：

1. 12.3.1 的对比度保持率 `≥ 0.85` 尚未固化为自动用例：Web 侧人工实测 `1.066`（§9.4），Flutter 未单独复测。若要长期防回归，应补一张两端共用的“文字背景截图 + 区域 std 断言”测试卡。
2. 多指 / 非主键过滤：drag / press 未显式过滤 `buttons` 与多指（T9 Minor，既有行为）。
3. `forced-colors` / 高对比度下焦点环可见性：Web 移除 outline 后改用自绘层，尚未验证强制颜色模式（T9 Minor）。
4. 深色色散观感：无官方帧，仍是设计推导值。
5. 84dp 命中区与内侧 1px hairline：T4 遗留，需产品裁决。

文件边界：本轮只改 `docs/orb-spec.md`、本记录、两个 README 与 `widget.dart` 的三处注释；未提交，未使用 stash / checkout / reset / clean，未触碰其他 WIP。
