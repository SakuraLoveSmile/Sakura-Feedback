# 灵感球四项可选加固（2026-10-29）

## 1 目标与范围

承接 `20261028-orb-hyperos4-T4-flutter.md` §10.3 列出的四项可选加固。T4 已收尾，这四项各自独立、互不阻塞，按片交付：

| 片 | 内容 | T4 §10.3 编号 | 状态 |
| --- | --- | --- | --- |
| 1 | 多指 / 非主键过滤（Flutter 追平 Web） | 4 | 已完成 |
| 2 | 回弹结束的 `breathWeight` 过渡 | 6 | 已完成 |
| 3 | `forced-colors` 焦点环可见性 | 5 | 已完成（结论：无需改实现，补验证） |
| 4 | 对比度保持率 `≥ 0.85` 自动化 | 3 | 已完成 |

不在范围内：T4 §10.3「不是缺陷」一节的全部条目（深色色散等设计推导值）。

分支 `feat/20261029-orb-hardening`，worktree 独立，基线 `origin/main` = `b77cdeb`。合入目标 `main`，走分支 + PR。

## 2 片 1：指针准入（已完成）

### 2.1 契约

写入 `docs/orb-spec.md` §5.2「指针准入契约」。要点：只认主键、只认首指、活跃指针只由 `up` / `cancel` 释放、手势取消的状态提交按调度相位分流。

### 2.2 改动

`flutter/feedback/lib/src/widget.dart`：

- 新增 `int? _orbPointer` 锁存被接受的指针 id，对齐 Web `element.ts` 的 `orbPointerId`。
- `Listener.onPointerDown` 增加两道准入：`event.buttons != kPrimaryButton` 与 `_orbPointer != null` 均直接返回。
- `onPointerUp` / `onPointerCancel` 只认同一 id 并在此释放活跃指针。
- 新增 `_cleanUpOrbPan(VoidCallback)`，`onPanCancel` 改经由它提交状态。

### 2.3 顺带修掉的既有缺陷

**拖动中隐藏入口会抛 `setState() ... called when widget tree was locked`。** 入口被移除时 `RawGestureDetectorState.dispose` 在锁定的 widget 树里 reject 手势并回调 `onPanCancel`，原实现在该回调里裸 `setState`。

已证明是既有缺陷而非本轮引入：把 `widget.dart` 换回 `origin/main` 的版本，同一场景复现同一异常（报在其 1582 行）。修法是 `_cleanUpOrbPan` 按 `SchedulerBinding.instance.schedulerPhase` 分流——idle 走同步 `setState` 保持既有同帧语义，帧内被回调则先落字段、推迟一帧再通知。

### 2.4 被证伪的两个假设（记录下来避免重走）

1. **「入口隐藏后 `onPointerUp` / `onPointerCancel` 不会再来，活跃指针会永久卡住」——错。** Flutter 按指针保留按下时的命中路径，抬起仍会派发到已 detach 的 `Listener`（探针实测 `PROBE up pointer=1 active=1 mounted=true`）。因此一度加在 `build` 里的 `if (open || !config.showLauncher) _orbPointer = null;` 是不可达的防御代码，已删除。
2. **「手势取消时该释放活跃指针」——错。** `onPanCancel` 也会在 pan 输掉手势竞争时触发，此刻指针仍按着；在那里清空会放第二指进来。`_cleanUpOrbPan` 因此**不**碰 `_orbPointer`。

两条假设最初各自写了一份清理，互相掩盖，导致针对任一处的变异检查都不红。拆掉冗余后变异才真实。

### 2.5 验证

组件包 `flutter/feedback`，Flutter 3.41.3（仓库 CI 基准版本）：

- `flutter analyze`：`No issues found!`
- `flutter test`：**365 passed**（基线 361 + 新增 4）

新增用例在 `test/orb_drag_test.dart` 的 group「spec 5.2 指针准入」：

1. 右键按下不进入 pressed，也不起拖动（断言 `stateScale ≈ 1.04` 的 hover，而不是 0.94；鼠标停在球上进 hover 是正确行为）
2. 拖动中第二指按下：不清零累计位移，球不跳回
3. 按下期间入口被隐藏：恢复后仍可再次按下
4. 拖动中入口被隐藏：恢复后仍可再次按下（pan 已胜出，走 §2.3 的锁树路径）

**变异检查（4/4 红）**：

| 变异 | 结果 |
| --- | --- |
| 去掉 `buttons != kPrimaryButton` 过滤 | 红（用例 1） |
| 去掉 `_orbPointer != null` 过滤 | 红（用例 2） |
| `onPointerUp` 不释放活跃指针 | 红（用例 3、4） |
| `_cleanUpOrbPan(...)` 退回裸 `setState(...)` | 红（用例 4） |

**取点口径**：第二指必须按命中盒 `feedback-orb` 取点，不能按视觉 `feedback-orb-body`。业务位移的 `Transform` 在手势盒内部，拖动中视觉已偏移、命中盒仍在停靠位，照视觉取点会落到宿主子树上——这正是该用例最初假绿的原因（第二指的 `onPointerDown` 根本没触发）。该几何事实已记入 spec §5.1 末条。

### 2.6 未验证

- 真实多指硬件（触屏 / 触控板双指）未实机复核，仅 widget 测试覆盖。
- Web 侧未改动（`element.ts` 本来就有两道守卫），本片未重跑 Web 用例。

## 3 片 2：呼吸权重过渡（已完成）

### 3.1 契约

写入 `docs/orb-spec.md` §7.4「呼吸权重过渡」，并修正 §5 状态表 `releasing` 行。要点：`breathWeight` 与 `stateScale` 共用同一时长与曲线（220 / 140 / 460ms），`releasing` 的目标是 1 而不是 0。

### 3.2 改动（仅 Flutter，Web 本来就有 transition）

`flutter/feedback/lib/src/widget.dart`：

- 把 stateScale 的时长 / 曲线三元表达式提成局部 `stateDuration` / `stateCurve`，与呼吸权重共用。
- 新增局部 `breathWeightTarget`。**原实现把 `_orbReleasing` 也算进压 0 的条件，这是错的**：Web 的 `.is-releasing` 规则只把 `--fb-orb-breath-weight` 写进 transition 列表、不设值，所以它回落到 `.fb-orb` 基值 1；hover / pressed 规则又都带 `:not(.is-releasing)`。因此回弹是在 460ms 内把权重从 0 拉回 1，而不是结束瞬间阶跃接上呼吸——spec §5 表里「过渡到当前 `breathScale`」说的就是这件事。
- 外层加一层 `TweenAnimationBuilder<double>` 承载权重，`orbPainter` 改为接收 `breathWeight` 入参。未给 `OrbPainter` 新增字段，9 字段单字段变异集不受影响。

### 3.3 验证

Flutter 3.41.3，组件包：`flutter analyze` 干净；`flutter test` **365 passed**。

被改动的既有断言（都是在钉改前的分叉行为，不是放宽强度）：

| 位置 | 原断言 | 现断言与依据 |
| --- | --- | --- |
| `orb_drag_test` 回弹 @55ms / @230ms | `breathWeight == 0.0` | 按回弹曲线精确断言 `_releaseProgress(55)` 与 `progress`（@230ms 过冲 >1）。依据：权重在回弹期间渐入，原值钉的是改前的阶跃行为。 |
| `orb_drag_test` 释放中 hover | `breathWeight == 0.0`；取 `.first` 的 TweenAnimationBuilder 当 scale | 权重按 `_releaseProgress(55)`；改为对最外两层（权重、stateScale）各自断言共用回弹时长 / 曲线与目标 1.0。依据：新增一层后 `.first` 指向权重层，不改会把 scale 的断言悄悄挪到别的 widget 上。 |
| `orb_drag_test` 源码守卫 | `TweenAnimationBuilder<` 计 3 | 计 4。依据：守卫本意是「只有一个 `AnimationController`、不新增 Timer」，声明式 tween 不引入额外计时资源。 |

新增断言：`orb_state_test` 的 hover 退出 @110ms 加 `breathWeight ∈ (0, 1)`——回弹用例只覆盖 460ms 曲线，220ms 这条路径此前无人钉。

**变异检查（2/2 红）**：

| 变异 | 结果 |
| --- | --- |
| 权重过渡时长归零（等价阶跃） | 红（回弹 @55ms、释放中 hover、hover 退出 @110ms） |
| 回弹期间权重仍压 0（改前行为） | 红（回弹 @55ms / @230ms、释放中 hover） |

### 3.4 未验证

- 未做视觉复核：权重渐入的观感差异在 ±2% 幅度内，截图矩阵分辨不出，只有数值断言。
- Web 侧零改动，未重跑 Web 用例。

## 4 片 3：forced-colors 焦点环（已完成，结论是不改实现）

### 4.1 结论

**强制调色模式下焦点环本来就可见，不需要新增 CSS 规则。** 原担忧（「自绘层用作者颜色 `--fb-accent`，强制调色下环读不出来」）实测不成立：UA 会把 `border-color` 强制映射成系统前景色 `CanvasText`，Chrome 实测与 `Canvas` 背景 **21:1**。

我一度加了 `@media (forced-colors: active) { border-color: Highlight; }`，变异检查把它判了死刑——**去掉该规则后全部断言照旧全绿**，因为 UA 映射已经把事情做完了。进一步看，`Highlight` 与 `Canvas` 并非规范保证成对的对比色，而 `CanvasText` / `Canvas` 是；在自定义高对比主题下我那条规则可能**更差**。因此该 CSS 改动已回退，`packages/web/src/styles.ts` 零改动。

真正要守的回归是**别把映射关掉**：环及其祖先一律不得声明 `forced-color-adjust: none` / `-ms-high-contrast-adjust: none`，否则环停在 `--fb-accent`，在高对比深色主题下只有 2.9:1，低于 WCAG 非文本的 3:1。契约写入 `docs/orb-spec.md` §5 焦点环段。

Flutter 侧不做改动：Flutter 没有 forced-colors 概念，`MediaQueryData.highContrast` 只在 iOS / macOS 由系统「增强对比度」提供且不改写应用颜色。平台能力差异，不是契约差异。

### 4.2 交付物

新增 `e2e/run_orb_forced_colors_web.py`。跑法：

```
uv run --with playwright --with pillow --with numpy python e2e/run_orb_forced_colors_web.py
```

三层断言（Chrome，`forced_colors` 各跑 `none` / `active` 两遍）：

1. **计算样式**：Tab 后进入 `:focus-visible`、环 `opacity=1`、环宽 2px、外径 64 = 视觉直径 + 8、与球同心、两种模式都没有 UA outline（不出现双环）；
2. **实际像素**：从截图里取环所在圆环带算主色，强制调色下与紧邻球外背景的 WCAG 非文本对比度 ≥ 3:1。只看计算样式会漏掉「环被别的层盖住」；
3. **源码扫描**：`styles.ts` 里不得出现 `forced-color-adjust: none` / `-ms-high-contrast-adjust: none`。

### 4.3 验证

**21/21 PASS**（Chrome，Pillow 10.4.0 + numpy 2.2.6，bundle 由仓库钉住的 pnpm 11.23.0 + `--frozen-lockfile` 构建）。关键实测值：

| 模式 | 环声明色 | 环像素 | 紧邻背景 | 对比度 |
| --- | --- | --- | --- | --- |
| `none` | `rgb(0, 113, 227)` | `(0, 113, 227)` | `(204, 201, 198)` | 2.849:1（`[DATA]`，非门槛） |
| `active` | `rgb(0, 0, 0)` | `(0, 0, 0)` | `(255, 255, 255)` | **21.0:1** |

**变异检查（1 项，红）**：给 `.fb-orb-focus-ring` 加 `forced-color-adjust: none` → 两条断言转红（强制调色下环色仍是 `rgb(0, 113, 227)`；源码扫描命中）。

对比度 ≥3:1 只在强制调色下作门槛。非强制模式下环色是作者强调色，对比度取决于宿主背景，不是本卡能定的门槛，只打 `[DATA]`。

### 4.4 顺带发现（新遗留项）

**`--fb-accent` 焦点环在中性灰背景上只有 2.849:1，低于 WCAG 1.4.11 非文本的 3:1。** 实测于出图夹具的 `#c9c9c9` 背景（`rgb(0, 113, 227)` vs `(204, 201, 198)`）。

- 不在本卡处理：`--fb-accent` 是全组件强调色，改它影响面远超灵感球；而且是否达标取决于宿主页背景（白底上约 3.9:1，深底更高），需要产品裁决「焦点环是否该与背景解耦」。
- 可选解法（未实施、未裁决）：给焦点环加一圈对比描边（内浅外深的双色环），使其在任意背景上都达标；代价是改动 spec §5 钉住的 2px 环宽 + 2px 间隙几何。

### 4.5 未验证

- **真实 Windows 高对比主题未体验**：以上全部是 Chrome 的 `forced-colors` 模拟。模拟能证明 UA 映射与我们的 CSS 不打架，但证明不了各家系统主题的实际配色。真机复核需要局域网的 Win11 机器，**记为待体验，不是已验证**。
- 截图落在 `e2e/shots/orb-forced-colors/`，按既有规则**仅本地证据、不入库**。

## 5 片 4：对比度保持率自动化（已完成）

### 5.1 口径

完全按 spec 12.3.1：球心水平带 `|dy| < 0.45R`，球内 `r < 0.55R` 对球外 `1.6R–3.2R` 的亮度标准差之比，门槛 `≥ 0.85`；浅色主题另加 12.3 的亮度约束。亮度统一 `0.299R + 0.587G + 0.114B`。夹具相位与出图矩阵一致（`flow = 0.25`、`breath = 0.5`）。

**背景用周期性竖条纹，不用真实文字。** 12.3.1 自己写明官方测量的局限是「球内外落在不同字形上，std 不是完全受控对比」。条纹（周期 8 设备像素、50% 占空比、关于球心对称）把这个变量消掉，球内外的理论 std 相同。两份用例都先自检 `fixtureRatio`（只有背景时球内外 std 之比，必须 ≈1），再算保持率，并另算一条**受控保持率** = 同区域「有球 / 只有背景」之比。这比真实文字更严，不是更松。

### 5.2 交付物

| 端 | 文件 | 跑法 |
| --- | --- | --- |
| Flutter | `flutter/feedback/test/orb_contrast_test.dart` | 普通 `flutter test`，走 `OrbPainter` 直绘 + `picture.toImage`，不需要额外依赖 |
| Web | `e2e/run_orb_contrast_web.py` | `uv run --with playwright --with pillow --with numpy python e2e/run_orb_contrast_web.py` |

Flutter 侧按「普通单元测试」交付，没有新建 benchmark bin，也没有加设备腿。

### 5.3 验证

| 端 | light 保持率 | dark 保持率 | 球内 std | 球外 std | fixtureRatio |
| --- | --- | --- | --- | --- | --- |
| Flutter | **0.8991** | **0.8990** | 68.78 / 82.71 | 76.50 / 92.00 | 1.0000 |
| Web | **0.8997** | **0.8988** | 68.83 / 82.69 | 76.50 / 92.00 | 1.0000 |

- Flutter 2 passed；Web **17/17 PASS**。
- **两端差 < 0.001**，采样数完全相同（球内 2738、球外 9206 设备像素），球外 std 一致到小数点后两位。这是本片最有价值的产出：12.3.1「两端一致」此前只是文字要求，现在有可比数字。
- 浅色亮度约束同时满足：球内均值 137.8 对同位置背景 124.5，更亮不更暗。
- `0.899 ≈ 1 − 0.10` 与 spec 第 4 节图层 4 的「`0.45R` 以内白色叠加 alpha 上限 `0.11`」互相印证——清玻璃核心的保持率上限由该 alpha 决定，不是由模糊决定。

**变异检查（2/2 红）**：

| 变异 | 结果 |
| --- | --- |
| Flutter 核心白 alpha `0.11 → 0.30` | 红（0.832 / 0.834）。`0.11 → 0.16` 仍绿（0.880），符合门槛是 0.85 而非 0.89 |
| Web 给 `.fb-orb-core` 加 `backdrop-filter: blur(3px)` | 红（0.055 / 0.045） |

### 5.4 未验证 / 限定

- 条纹夹具的数字与官方帧的 `1.038` **不可直接比**（背景构造不同）。官方帧那一行仍是唯一的官方参照，没有被替换。
- 没有用真实文字背景再跑一遍对照。条纹是更严的受控替代，但「真实文字下也达标」属推论而非实测。
- Web 截图落在 `e2e/shots/orb-contrast/`，按既有规则仅本地证据、不入库。

## 6 遗留（本卡新增，需裁决）

1. **`--fb-accent` 焦点环在中性灰背景上只有 2.849:1**，低于 WCAG 1.4.11 非文本的 3:1。见 §4.4，需产品裁决是否让焦点环与宿主背景解耦。
2. **真实 Windows 高对比主题未体验**。见 §4.5，需局域网 Win11 机器。



