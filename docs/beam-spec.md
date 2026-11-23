# 光束唤醒与圈选规格（Beam Wake）

0.10 起的入口形态。Web 的最新默认改为 `launcher-mode=auto`（见
[CHANGELOG](../CHANGELOG.md)「未发布」段）：精细指针用贴边标签，只有触屏、或探测不到
`matchMedia` 的环境才解析成 `beam`；要固定无入口形态需显式写 `launcher-mode="beam"`。
Flutter 端默认仍是 `FeedbackLauncherMode.beam`。本文记录 Web（`packages/web`）与
Flutter（`flutter/feedback`）两端共同遵守的动效时序、颜色、圈选几何、降级与无障碍契约。
灵感球自身的视觉规格见 [orb-spec.md](orb-spec.md)。

## 1. 触发与落点

| 触发 | 行为 |
|---|---|
| 双指长按 700ms（默认开启） | 冻结当前视口 → 光束 → 压暗 → 圈选待命 |
| `wake-shortcut`（默认 `primary+shift+f`，macOS ⌘ / 其他 Ctrl） | 同上；输入框聚焦、面板打开、选区进行中不触发，宿主已 `preventDefault` 时让路。Web 的 `auto` 解析为贴边标签时同样可用 |
| Web 桌面 `⌥/Alt + 拖拽`（仅精细指针，`wake-shortcut` 不为 `off`） | 不播光束：松手后冻结视口，拖拽矩形直接成为初始选区（见 §3） |
| 宿主控制器 `open()` / `captureAndOpen()` | 不经过光束，按 API 语义直接打开 |

- 唤醒与截图解耦：`capture-mode=off`（Flutter `FeedbackCaptureMode.off`）时，
  手势/快捷键只打开纯表单面板，不冻结、不压暗、不圈选。
- 手势在生效入口为 `beam`（或灵感球模式的手势唤醒）时生效。Web 的 `auto` 解析成
  贴边标签时（触屏笔记本）手势同样可用；宿主显式 `launcher-mode="tab"` 时手势不可用。
- `beam` 形态下唤醒后不展开球体，也不渲染任何常驻入口；关闭覆盖层后焦点回到视觉隐藏的
  无障碍按钮，而不是已隐藏的球。

## 2. 唤醒动效时序与颜色

默认是**水波纹**（本机偏好 `feedback:wake-visual:v1:<appId>` 缺省 `ripple`），
可在面板「设置 → 唤醒动效」切换为**波光**（`aurora`）。两种动效均在 720ms 后进入圈选。双指触发水纹时，两指中间只起一圈，从接近零半径向四周传播。双指触发波光时，两个指尖分别发光；三指手势使用三指中点，快捷键与无障碍入口使用视口中心。

| 参数 | 水波纹（默认） | 波光（可选） |
|---|---|---|
| 形状 | 手势中点先起一圈细小的水波。波峰向外传播，两侧较亮的弧面随之转动 | 两道光带从指尖铺开，相交后合成连续的宽柔光，中央仍透出页面 |
| 尺寸 | 起始半径为零，传播距离按起点至最远屏幕角计算，波带随半径渐宽。两侧弧面每秒顺时针转约 60° | 每道光晕外缘从视口短边的 6% 扩展到手势中点至最远角距离的 160% |
| 质感 | 用同一张冻结截图逐像素采样。波峰前后的笔画向相反方向弯折，蓝色与暖金色的窄边跟着两段弧面转动，波心保持平静 | 左侧冰青、右侧奶黄、下方粉紫。两道光带共用视口色彩和一个透明度蒙版，重叠处的文字仍可辨认 |
| 收尾 | 前 130ms 建立波峰，约 550ms 后渐弱。720ms 起可以圈选，动笔即收起余波，空闲时约 1.8s 归于平静，2s 结束本轮播放 | 约 288ms 起在边缘渐留柔光，约 490ms 起整体淡出。进入圈选时余光消退 |
| 压暗 | 约 430ms 内渐入到 0.26 | 约 158ms 内渐入到 0.26 |

- WebGL 和 Flutter 的片元着色器共用 `water_field.glsl` 描述水波的折射和色散。WebGL 不可用、纹理未准备好或 Flutter 运行时着色器不可用时，使用蒙版近似绘制。两端均在 720ms 后进入圈选待命，保留 `#635D92`、透明度 0.26 的压暗层。
- 水纹的折射与圈选底图使用同一张已完成遮挡的截图。波光以用户录屏及本机小布识屏实录、原始场景独立播放为参考，双端使用自己的绘制实现。水纹的折射与转动弧光参考 PKG110 系统充电水波。传播范围以实际手势落点和当前视口确定。
- 偏好在会话开始时读取。设置里切换后，下次唤醒生效。

## 3. 圈选几何

两端共享常量：

| 常量 | 值 | 含义 |
|---|---|---|
| `LASSO_PAD` / `kLassoPad` | 8px（逻辑像素） | 轨迹包围盒外扩 |
| `LASSO_MIN` / `kLassoMinSize` | 64px | 最小选区边长，不足时按中心扩展 |
| `LASSO_SAMPLE` / `kLassoSampleDistance` | 4px | 轨迹采样最小间距，轨迹用 2px 白色半透明描边 |

算法（两端同一套测试用例）：

1. 采集指针轨迹（4px 采样），忽略重复点。
2. 松手时取轨迹包围盒 → 外扩 8px → 若宽/高不足 64px，以中心为基准扩到 64px。
3. 夹到视口范围；Flutter 另外避开安全区（`safeInsets`）。
4. 空轨迹/无移动：在起点生成 64×64 选区（夹到视口内）。
5. 轨迹淡出，包围盒动画成既有圆角选区框；之后沿用既有拖拽移动 / 四角缩放 /
   方向键微调 / Enter 确认 / Esc 取消与「使用此区域 / 整个窗口」工具条。

桌面 `⌥/Alt + 拖拽`（Web）走 `regionFromDrag`：由拖拽矩形直接得到选区，
**不套用**这里的 8px 外扩与 64px 最小边，只夹回视口并保证 48×48 最小
（`MIN_REGION_SIZE`）；拖动不足 8px 视为 `⌥/Alt+点击`，按普通唤醒在该点进入圈选。

实现位置：

- Web：`packages/web/src/region.ts`（`simplifyPath` / `lassoBoundingRect`）+
  `element.ts`（`commitLasso` / `renderLasso`）。
- Flutter：`flutter/feedback/lib/src/capture_selection.dart`
  （`lassoBoundingRect` / `_commitLasso`）。

## 4. 降级

- Web：`prefers-reduced-motion: reduce` 时 `.fb-beam` 直接 `display: none`，
  立即压暗 0.26 并进入圈选待命。
- Flutter：`MediaQuery.disableAnimations` 时跳过唤醒动效，直接进入圈选。
- 两端在降级路径下都保留圈选与全部键盘操作。

## 5. 无障碍

- Web：Shadow DOM 内新增 `tabindex=0` 的视觉隐藏按钮
  `.fb-beam-a11y`（1×1，`clip-path: inset(50%)`），Enter/Space 触发同一唤醒，
  覆盖层取消/面板关闭后焦点回到该按钮。aria-label 按输入能力生成：触屏仍念
  「打开反馈（双指长按屏幕或按 Ctrl+Shift+F）」，精细指针且无触摸时念
  「打开反馈（⌥ 拖拽圈选，按 ⌘+Shift+F）」——桌面不再出现双指语言。
- Flutter：`feedback-beam-a11y-slot` 内的 `Semantics(button)` +
  `Focus`（Enter/Space 触发 `_startBeam(null)`）；无可见入口。
- 圈选提示文案：Web 「画个圈，只需圈出问题位置」；Flutter
  「画个圈，只需圈出问题位置」。

## 6. 平台差异与未验证

- 安全区只在 Flutter 生效（`MediaQuery.padding`）；Web 以视口为界。
- PKG110 的 Android arm64 release 示例已用系统注入的双指双击验证。该机双指长按会唤起系统识屏。iOS、其他 Android 机型、Safari/Firefox 的 reduced-motion 及 Windows forced-colors 尚待验证。
- Web 默认入口按输入能力解析（`auto`），Flutter 仍是 `beam`：两端默认形态从此不一致，
  Web 宿主想保持无入口形态须显式 `launcher-mode="beam"`。
- 宿主侧迁移（旧宿主改为显式 tab/off 或接受新默认）由各宿主自行决定，
  见 CHANGELOG 0.10.0 的迁移片段。
