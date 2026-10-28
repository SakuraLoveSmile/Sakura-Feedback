# 灵感球四项可选加固（2026-10-29）

## 1 目标与范围

承接 `20261028-orb-hyperos4-T4-flutter.md` §10.3 列出的四项可选加固。T4 已收尾，这四项各自独立、互不阻塞，按片交付：

| 片 | 内容 | T4 §10.3 编号 | 状态 |
| --- | --- | --- | --- |
| 1 | 多指 / 非主键过滤（Flutter 追平 Web） | 4 | 已完成 |
| 2 | 回弹结束的 `breathWeight` 过渡 | 6 | 已完成 |
| 3 | `forced-colors` 焦点环可见性 | 5 | 未开始 |
| 4 | 对比度保持率 `≥ 0.85` 自动化 | 3 | 未开始 |

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

## 4 片 3–4

未开始。

