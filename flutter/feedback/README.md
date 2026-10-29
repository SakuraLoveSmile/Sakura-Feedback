# feedback_widget

个人反馈组件：把 Feedback 服务的反馈悬浮按钮与面板嵌入 Flutter 应用。
对接 `docs/api.md` 定义的 HTTP 契约（v1）。

> 📘 **完整接入指南：[`docs/integration.md`](../../docs/integration.md)**
> —— 从服务端配置、依赖安装（path / 固定 Git commit）、悬浮球挂载到登录/截图/反馈/归档的端到端步骤。
> 本 README 是 Flutter 端 API 与遮挡语义的**权威参考**。

## 支持平台

web、android、ios、windows、macos、linux（平台差异经条件导入隔离）。

## 依赖版本兼容（flutter_secure_storage 9 / 10 / 11）

依赖约束是 **`flutter_secure_storage: '>=9.2.2 <12.0.0'`**（`pubspec.yaml`），
组件只使用三版共有的 `read` / `write` / `delete`（`lib/src/platform_io.dart`），
因此同一份组件代码可被固定在 9.2.2 / 10.3.1 / 11.0.0 的宿主使用；
接口、存储键（`feedbackTokenStorageKey`）与「写入失败不回退内存/明文」的语义不变。

三档隔离矩阵实测（同一份组件测试源码，每档 analyze + test 全绿）：

| 固定版本 | `darwin` | `macos` | `windows` | `platform_interface` |
| --- | --- | --- | --- | --- |
| 9.2.2 | 无 | 3.1.3（走 `_macos`） | 3.1.2 | 1.1.2 |
| 10.3.1 | 0.3.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |
| 11.0.0 | 0.4.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |

**`darwin` 取代 `_macos`、`windows` 3.x→4.x 是从 10.x 档就发生，不是 11 才发生。**

平台要求分两半：**本包不抬高自己的下限**（仍是 `sdk: ^3.6.0` / `flutter: ">=3.27.0"`）；
**使用 11 的宿主必须自行满足** Dart `>=3.8.0`、Android `minSdk 24`、`compileSdk 37`。
放宽范围**不会自动迁移数据**，也不能从 9 直接跳到 11。

📄 完整的版本矩阵、平台要求、迁移步骤与边界、验证范围与证据追溯：
[`docs/flutter-storage-compat.md`](../../docs/flutter-storage-compat.md)（权威记录见 `VERIFICATION.md`）。

## 使用

```dart
import 'package:feedback_widget/feedback_widget.dart';

final controller = FeedbackController();

// 推荐：组件包在 MaterialApp 外侧——rootNavigator 弹窗在截图边界内可入图。
// （旧写法经 builder 挂载仍可用，但 rootNavigator 弹窗不入图。）
FeedbackWidget(
  config: FeedbackConfig(
    'https://fb.example.com', // apiBase
    'com.example.app',        // appId（服务端已登记）
    appVersion: '1.2.3',      // 仅显式传入才上报
    pageLabel: 'settings',    // 仅显式传入才上报
    side: FeedbackSide.right,
    // imagePicker: ...        // 可选：自定义图片选择器（默认 file_selector）
  ),
  controller: controller,
  child: MaterialApp(
    home: MyHomePage(),
  ),
)
```

- 悬浮圆形按钮（`Material`，Semantics「反馈」）或灵感球（`launcherMode:
  FeedbackLauncherMode.orb`，静止 56dp、拖动中 84dp；材质为清玻璃核心 +
  向外连续增强的径向白环 + 双极暖冷色散 + 白环扫光，并且球体是**真实放大镜**——
  默认在球首次可见/拖动开始时对宿主内容做**一次本地内存捕获**，交给
  `shaders/orb_lens.frag` 做径向折射近似（中心 1.70×、球缘压到 0.87×）；
  捕获失败、首帧未就绪或着色器不可用时立即退回单层矩阵均匀放大 1.70×。
  捕获只存本地内存、不上传、不写盘、绝不周期捕获。扫光、呼吸、方向
  拉伸与回弹曲线均为本项目的设计推断，不是官方逐项参数；拖拽松手进入
  **局部选区截图**流程）呼出面板；
  `controller.open()` / `controller.close()` 可主动呼出。
  扫光与呼吸是**常驻循环动画**：系统「减少动态效果」时渲染为静态帧且球体
  不缩放；Flutter 测试环境（`flutter test` 注入 `FLUTTER_TEST=1`）不启动该
  Ticker（同样为静态帧，84dp 展开等缩放动效不受影响）——宿主/示例测试
  里的 `pumpAndSettle` 不会被灵感球挂起，真实应用动画效果不降低。
- 灵感球可键盘聚焦：Space / Enter / 小键盘 Enter 触发与点按等价的行为；焦点环只在键盘模式下显示，面板关闭后焦点回到球（指针关闭不点亮环），选区覆盖层期间球退出焦点链。
- 按集成文档推荐把组件挂在 `MaterialApp` **外侧**（无 `Overlay`/`Navigator`
  祖先）时，组件自备兜底 `Overlay`（`_FallbackOverlay`：State 持有唯一
  entry，父级 `setState` 后 `markNeedsBuild` 刷新子树，**不会冻结在首帧**）。
  面板内对话框、放大预览与图片编辑器在无 `Navigator` 宿主下都经该兜底
  Overlay 的插入路径打开（编辑器即 `FeedbackImageEditor.openAsOverlay`）；
  有 `Navigator` 时编辑器照常走全屏 `MaterialPageRoute(fullscreenDialog)`，
  宽度取视口、与面板宽无关。
- 宽屏（≥768px）面板为侧边抽屉：宽 `min(440, 视口宽 − 32)`、最大高
  `min(720, 视口高 − 32)`（垂直居中，上下各留 ≥16px 余量，可点遮罩关闭），
  与 Web 端 `min(440px, calc(100vw − 32px))` / `min(720px, calc(100dvh − 32px))`
  规格一致；`<768` 为全屏页面式（宽高用满）。`Esc` 关闭面板。
- 撰写面板组件顺序：**标题与页签 → 反馈描述 → 图片证据 → 可折叠日志 →
  固定提交区**；技术信息（日志详情）与账户信息（额度 / 用户名）弱化展示，
  点击目标不小于 48dp，动效 160–220ms。

## 自定义服务器（面板内设置）

面板头部「服务器设置」入口（未登录也可进入）：地址输入 + 保存 + 恢复默认 + 当前有效地址；保存后探测 `GET /healthz` 提示连通性（不回切）。

- 覆盖仅保存在**本机**：原生走 `flutter_secure_storage`、Flutter Web 走
  `localStorage`；按「宿主存储空间 + `appId` + 规范化默认地址」分槽位隔离；
  恢复默认只删本机覆盖，不改写 `FeedbackConfig.apiBase`。
- 地址规范化：去空白与末尾斜杠、去默认端口、保留部署路径前缀；仅
  `http(s)`、要求主机非空、拒绝内嵌凭据 / 查询参数 / `#` 片段；
  Flutter Web 部署在 HTTPS 页面时拒绝 HTTP 地址（混合内容）。
- 相同规范化地址保存不重置状态；异址且有草稿 / 截图 / 日志 / 未确认提交时
  需确认后清空，存在结果未确认的提交时提示「旧服务器可能已接收」。
- 切换后身份完全隔离：API 客户端与令牌仓库按「有效地址 + `appId`」重建，
  旧令牌绝不发往新地址，迟到响应一律丢弃；偏好写入失败时本次会话仍生效
  并提示「仅本次生效」。偏好加载完成前不启动任何依赖服务器的请求。
- 宿主可通过 `controller.effectiveApiBase` 读取当前实际使用的服务地址
  （只读；未覆盖时等于 `config.apiBase`）。

## 键盘避让（Android / 小屏）

- **只扣除未被宿主避让的重叠**：组件在布局层计算「面板底边 vs 键盘上沿」
  的实际重叠——宿主已随键盘收缩（`Scaffold.resizeToAvoidBottomInset`，
  此时 `viewInsets` 通常也被消费归零）或面板底边本就在键盘之上时不再
  额外留白；根部挂载等未避让场景自动抬升面板底部。
- **内容有界可滚 + 固定提交区**：撰写（含截图 / 日志 / 登录表单）放在
  有界滚动区内——高度充足时主输入区照旧占满剩余空间；高度不足（键盘 /
  横屏 / 放大字体）时整体可滚；提交按钮、字数计数与账户信息位于**底部
  固定提交区**，始终可见可达，不再溢出裁剪。面板标题与关闭入口保持在顶部可见。
- **焦点链**：账号框 `下一步` → 密码框；密码框 `完成` → 沿用登录流程；
  服务器地址框 `完成` → 保存。字段获得焦点或键盘尺寸变化（开合 /
  旋转）后，布局完成时自动把聚焦字段滚回可见区域。
- 键盘展开、收起与旋转不清空输入、不丢草稿、不触发重复提交。

## 截图与遮挡

- **截图范围只限宿主视口，拖拽后可截取局部**：捕获的是 `FeedbackWidget`
  包住的宿主子树（`RepaintBoundary` 边界）当前完整视口，**不做系统截图、
  不做自动长截图**；**不包含系统悬浮窗 / 状态栏等系统 UI**，也**无法跨应用
  截图**；反馈组件自身的 UI（灵感球、选区边框、遮罩、工具栏）位于截图边界
  之外，不入图。
- **拖动灵感球 → 定位并截取局部（T1）**：交互固定为
  **拖球 → 松手 → 调整选区并查看结果 → 确认 → 填写反馈**。
  1. 松手后**不再直接写草稿**：先完成与整窗截图**完全相同**的遮挡捕获
     （`RepaintBoundary` → 登记遮挡几何 → `toImage` → 位图级不透明遮挡；
     PNG 编码与限额重试在用户确认时对冻结位图执行），得到一张**已遮挡的
     冻结位图**与元数据；
  2. 在冻结画面上显示选区覆盖层，初始选区宽 `min(400dp, 屏宽×80%)`、
     高 `min(260dp, 屏高×40%)`，中心为松手位置，靠边时整体移回可见区域
     （含安全区），最小 **48×48 逻辑像素**；
  3. 选区支持拖动移动、八个缩放控制点、背景拖动重新框选；
  4. 工具栏提供**「使用此区域」「截取整个窗口」「取消」**——回车确认、
     `Esc` 取消，确认按钮自动聚焦（键盘 / 无障碍可确认与取消）；
  5. 「使用此区域」把冻结位图按选区裁剪（逻辑坐标 × 捕获比例换算到像素）
     **只提交选区内容**；「截取整个窗口」用整张冻结位图并**省略 `region`**；
  6. 「取消」丢弃冻结画面恢复 UI，**不覆盖原草稿、不报失败**；
  7. 捕获失败打开面板提示可重试，保留旧草稿旧图，**绝不静默回退成整屏
     截图**；图片已达 5 张且无可替换截图时**先提示整理附件**、不发起捕获；
     会话 / 身份失效时进行中的选区流程立即作废（冻结位图销毁）。
- **`capture.region`（T1 新增接口字段）**：`{ x, y, width, height }`，
  0..1 归一化，**相对原始捕获视口**（`viewportWidth/Height` 描述的边界尺寸），
  满足 `x + width ≤ 1`、`y + height ≤ 1`；写入 `FeedbackCaptureInfo.region`
  并随提交 metadata 的 `capture` 透传。`viewportWidth/Height` 语义不变；
  `pixelWidth/Height` 为**选区裁剪后的最终输出像素**；整窗捕获省略 `region`；
  `releasePoint` 仍相对原始捕获视口 0..1。旧提交（不带 `region`）完全兼容。
- **呼出前先查草稿（统一守卫）**：三个入口——普通点击（悬浮按钮 / 灵感球点按）、
  灵感球拖动释放（进入选区流程前先检查）、`FeedbackController.captureAndOpen()`——
  全部汇入同一处，先检查图片上限（5 张且无可替换截图 → 提示整理附件），
  再读面板的只读 `hasDraft`（去空白后的正文非空）与 `hasScreenshot`：
  - 面板已持有草稿文本**或**截图 → **不截图**，直接打开面板，原有的文字与
    截图字节原样恢复（避免新图覆盖用户正在编辑的内容；`captureAndOpen()`
    此时同步展开，不进入捕获流程）；
  - 都没有 → 普通点击 / 控制器入口照常「先截图后开面板」（整窗截图），
    拖动释放进入上述局部选区流程，确认后才挂载面板交付截图。
  面板只在首次呼出后挂载，未挂载即无草稿可言，照常捕获。
- **先截图后开面板**（普通点击与 `controller.captureAndOpen()` 路径）：
  呼出时保持宿主当前布局等待 paint 完成 → 捕获宿主边界（遮挡 + 编码）→
  校验捕获会话 → 挂载面板并交付截图 → 最后聚焦输入框。**灵感球拖拽路径
  则为「先冻结画面 → 调整选区 → 确认 → 再开面板交付」**。反馈 UI 位于
  截图边界之外，不入图。
- **统一图片限制（两端一致，公式同 Web 端）**：
  `scale = min(devicePixelRatio, 2, 2048 / 最长逻辑边, sqrt(4000000 / 逻辑面积))`，
  一次性按最终尺寸渲染；PNG 超过 5MiB 按 ×0.8 缩小重编码最多 3 次，
  仍超限则本次截图失败（不返回超大图，旧草稿旧截图保留，可重试或继续
  文字反馈）。元数据区分逻辑视口尺寸（`viewportWidth/Height`）与输出
  像素尺寸（`pixelWidth/pixelHeight`）。
- **`FeedbackCaptureMask` 遮挡**：包裹敏感区域，截图时以 `maskColor`
  覆盖（仅取其 RGB 分量并**强制不透明**，默认中性灰 #6E6E73）。
  - 注册到**最近的 `FeedbackWidget` 实例**的私有作用域：跨实例移动
    （GlobalKey 重挂父级）自动重新注册，销毁注销；两个组件实例的遮挡
    注册互不影响，各自截图只应用各自作用域。
  - 几何处理：对遮挡子树内每个渲染框用 `getTransformTo(截图边界)` 变换
    四角取轴对齐包围盒并集——旋转 / 缩放 / 嵌套变换下允许多遮、不允许
    少遮；映射到输出像素时向外取整并外扩 1 输出像素。
  - 标准 `obscureText` 输入区域自动纳入保护，无需手动包裹。
  - 已注册且可能可见的遮挡区域几何计算失败时**中止整次截图**
    （不生成无遮挡图），面板无新预览、旧截图保留。
- **捕获会话**：组件内维护捕获序号与当前请求；取消
  （`controller.cancelCapture()`）、关闭（含宿主直接 `close()`）、销毁、
  控制器替换或新会话开始都会使旧会话失效，过期结果直接丢弃
  （含 post-frame 交付前的序号校验）；用户取消静默不报错；
  普通呼出（`open()`）与进行中的捕获合并。
- **重拍**：面板内「重新截图」走内部明确入口，复用同一会话化流程；
  只有重拍成功才替换旧图。重拍**失败 / 取消 / 中途关闭面板**都保持草稿
  文本与旧截图字节不变（`setScreenshot` 仅在成功时调用），重拍中途关闭后
  再次呼出面板恢复可见。
- **不可绘制区域检测**：宿主包含 PlatformView / Texture（相机、地图、
  WebView、视频等渲染器）时截图**照常产出**，预览旁提示「部分内容可能
  未入图（系统级画面），可手动添加图片补充」——不把缺失内容当作完整截图。
- **多图附件（v12 / T2）**：撰写页与对话回复都支持最多 5 张图片（截图与手动
  选择共存），仅 PNG / JPEG / 静态 WebP，超过 2048px / 400 万像素 / 5MiB
  自动等比缩小。缩略图**完整显示**（`BoxFit.contain`，禁止二次裁切），带
  「局部截图 / 已编辑 / 截图」标记与输出尺寸，**编辑、删除放在图片下方**
  （≥48dp）不遮挡内容。逐图编辑器统一为
  **「调整选区 → 应用裁剪 → 保存图片」**：
  - 裁剪**松手不自动裁剪**——进入待确认态，选区边框与外部暗化遮罩持续显示，
    支持移动、八个控制点缩放、重新框选；底部固定「应用裁剪 / 取消裁剪」；
  - 拖动选区同步更新右侧（宽屏 280px）/ 下方（窄屏 160px）的「裁剪结果」
    预览与**输出尺寸**，预览与最终导出**共用同一编辑结果**；
  - **裁剪保留实色遮挡**（不透明 `rgb(110,110,115)` 色块，类型不退化成
    描边），应用后主画布展示完整结果，可继续标注 / 遮挡 / 撤销；
    辅助边框、网格、控制点只画在覆盖层，**不写入图片**；
  - **存在未应用选区时禁止保存**（禁用并说明原因）；
  - 图片选择器可经 `FeedbackConfig.imagePicker` 覆盖（默认 file_selector）。
  服务端未声明 `capabilities.images` 时自动降级为单图模式（走旧
  `screenshot` 字段）并提示升级服务端。
- **我的反馈**：历史列表支持分页（10 条/页）与状态筛选
  （待处理 / 待补充 / 待管理员回复 / 已解决）；列表项点击进入对话详情
  （原话 / 处理状态 / `resolutionNote` / 图片与日志附件经 Bearer 鉴权
  下载渲染）。面板关闭期间 30s 轮询未读摘要，详情打开时 10s 轮询对话增量；
  轮询不重置回复草稿、不强制滚动跳位。
- **诊断日志（T4）**：`FeedbackDiagnosticsRecorder` 环形缓冲
  （200 条 / 256KiB，白名单字段，世代清除）；`FeedbackHttpClient` 包装
  宿主 `http.Client` 自动记录请求事件；`FeedbackExceptionCapture.install`
  记录 Flutter/平台异常并保留宿主原处理（可卸载）。`logProvider` 透传
  `provide()` 结果即可随反馈一起上传日志文件。面板默认只显示
  「**已附诊断日志 / 暂无日志**」摘要，展开后可查看文件、预览、移除、
  **重新采集**；采集失败仍可提交（失败仅提示、可重试）。

## 草稿与提交

- `FeedbackPanelState` 是草稿的单一所有者（长期常驻）；父组件只暂存
  捕获结果，通过只读 `hasDraft` / `hasScreenshot` / `captureInfo`
  判断行为（呼出守卫即依赖它们）。草稿恢复（重开面板）不重拍；移除截图
  会同时移除落点与捕获时间。
- 正文 10000 码点（runes）上限；提交体携带自制 uuid 幂等键、
  `appId`、`text` 与显式 `context`。
- **两条失败路径严格区分，服务端已接收的反馈绝不重发**：
  - **Class A —— 服务端从未收到（未送达）**：网络异常 / 超时、未拿到任何
    HTTP 响应（`notSent` 阶段，撰写视图内显示「网络异常，提交失败…」，
    提交按钮变成「重试提交」）。重试**复用同一幂等键与同一字节**（正文 +
    截图字节 + 截图元数据）。只有在冻结快照**变化**时才换新 key——包括
    改文案、**重拍得到新截图**、**移除截图**（同 key 不同字节违反服务契约，
    会被判 409）。重试若拿到服务端响应（如 400），说明请求已送达，退出
    `notSent` 回到普通撰写视图，但快照未变时仍复用同一 key。
  - **Class B —— 服务端已接收但后台处理失败**（服务端状态
    `failed` / `needs_review`，`FeedbackStage.failed`）：该反馈已有
    feedbackId，**绝不再次 `POST /api/feedback`**（重发只会产生重复工单）。
    面板保留原 feedbackId 并提供：**刷新状态**（只重新查询
    `GET /api/feedback/:id` 并回写阶段 / 详情 / 归档链接）、**复制反馈 ID**
    （`Clipboard.setData`，剪贴板不可用时降级为面板内可读提示且不抛出）、
    以及「该反馈已被服务接收，请勿重复提交；管理员可在管理页按此 ID 恢复
    原始记录」的提示；「返回编辑」会恢复原话并清除 feedbackId 与幂等键，
    之后用户主动提交的是**全新反馈（新 key）**，不是重发旧工单。
- 提交期间冻结快照（正文 + 截图字节 + 元数据）；`409
  idempotency_conflict` 提示「该反馈已提交」且不自动换 key。
- 状态视图：提交中 → 已接收 / 处理中（轮询 `GET /api/feedback/:id`，
  2s→5s 退避）→ 已归档（可打开/复制 Kaneo 链接）；失败视图见上（刷新 /
  复制 ID / 返回编辑）。成功接收后才清空草稿与截图。

## 登录

- **Web 与原生统一**：未登录也可在面板内编辑反馈；点击主按钮「登录并提交」
  就地展开用户名/密码表单（**不打开任何窗口**）→ `POST /api/auth/login`
  （携带 `clientLabel`，形如 `flutter-macos-<iso 时间>`，以及 `appId`）。
  成功后立即提交一次；取消只收起表单，草稿与截图保留。密码不写日志、不留存 UI。
- **令牌存储**：原生端存入 flutter_secure_storage；Web 端**仅存内存**
  （刷新后重新登录）。后续请求带 `Authorization: Bearer`。401 按**请求发出时
  捕获的令牌与认证世代**做条件清除（内部协调层串行化登录写入与条件清除）：
  只有确认请求仍属于当前认证世代才清除令牌并回到未登录面板，草稿保留——
  重新登录后，旧请求迟到的 401 不会把新登录的账号退出；确已失效的会话照常
  回到登录视图。
- **安全存储写入失败**：登录成功但令牌无法持久化（如 macOS Keychain 缺少
  entitlement）时，面板提示「无法保存登录状态，请检查应用的安全存储配置」，
  保留草稿、清空密码、不自动提交；不回退内存 / 明文存储。
- **每日额度**：普通账号默认每天 3 次（北京时间零点刷新，跨项目/设备共用），
  `quota` 为数值形态 `{ dailyLimit, used, remaining, resetAt }`；撰写区显示「今日剩余 N 次」，
  额度用尽时提交按钮禁用并提示，草稿保留。管理员账号 `quota` 为
  `{ unlimited: true, used, resetAt }`（不含 `dailyLimit` / `remaining`），撰写区显示「不限次数」，
  不受每日额度阻断，也不会收到 `daily_quota_exceeded`。
  刷新调度：额度用尽每 30 秒重查，其余状态按服务端 `resetAt` 定时单次查询；
  打开面板 / 回到前台的刷新被在途查询或忙碌挡下时登记「待立即刷新」，
  旧查询结束或忙碌结束后立即补发一次（多次登记合并为一次；关闭 / 退后台 /
  401 清除意图）。
- **令牌存储键按服务身份隔离**：原生键由 `apiBase` + `appId` 派生
  （`feedbackTokenStorageKey(config)` →
  `feedback_widget.bearer_token.<base64url(apiBase + "\u0000" + appId)>`，
  去掉 `=` 填充）。
  同一台设备上不同 Feedback 服务、或同一服务的不同 `appId` 各占一个槽位，
  读取时用同一派生键，因此**换服务读不到旧服务的令牌（返回 null），不会
  跨服务复用凭据**；键确定性、且只含平台存储后端安全字符
  （`A–Z a–z 0–9 - _ .`）。`SecureFeedbackTokenStore(config: ...)` 需要
  传入 `FeedbackConfig`（`createDefaultTokenStore(config)` 同样如此）。

## 开发与验证

```sh
flutter analyze
flutter test
```

当前实测：`flutter analyze` 无问题、`flutter test` **220/220 通过**。
依赖三档（9.2.2 / 10.3.1 / 11.0.0）在上面的隔离矩阵里各跑一遍同一批用例
（`bash tools/flutter-storage-matrix/run.sh`）。

回归测试覆盖：像素级遮挡（敏感区不透明覆盖、周围布局、变换 AABB 多遮、
透明遮挡色、obscureText、双实例隔离、几何失效中止、统一图片限制边界）与
异步生命周期（先截图后开面板、A/B 交错、取消/关闭/销毁/控制器替换、
过期交付丢弃、草稿恢复不重拍、临时 ui.Image/ui.Picture 全路径释放），
见 `test/capture_mask_pixel_test.dart`、`test/capture_lifecycle_test.dart`。

T1/T2 本轮新增：拖动灵感球的局部选区流程与 `capture.region`
（初始选区中央/四角/靠边/安全区/最小 48×48、移动与八点缩放、重新框选、
回车确认 / Esc 取消、整窗省略 region、5 张上限提示、失败重试不回退整屏、
身份切换作废、region 归一化与提交透传、无 region 旧提交兼容）——
`test/capture_region_selection_test.dart`；编辑器裁剪待确认态与实色遮挡
像素回归（松手不自动裁剪、未应用禁用保存、预览=导出、辅助元素不入图、
宽/窄屏布局）——`test/image_editor_crop_test.dart`；面板顺序、缩略图完整
显示与标记、日志折叠摘要与 48dp 点击目标——`test/panel_compose_layout_test.dart`。
无 `Overlay`/`Navigator` 祖先（组件包在 `MaterialApp` 外侧）的挂法回归——
`test/hostless_overlay_test.dart`：点击灵感球捕获后面板挂载可交互、关闭
后重开、拖拽选区覆盖层重建与确认交付，以及测试环境探测（`FLUTTER_TEST`
下扫光与呼吸不启动常驻 Ticker、`pumpAndSettle` 不挂起）。

另有两类新增回归：统一草稿守卫与重拍保留
（`test/draft_capture_guard_test.dart`：三个入口都不重拍、重拍失败/取消/
中途关闭保留文案与旧图）与两类失败路径 + 服务隔离存储键
（`test/submit_failure_class_test.dart`：Class A 同 key 同字节 / 换图换 key、
Class B 零重发 + 刷新 + 复制 ID；`test/token_store_scope_test.dart`：
不同服务 / 不同 appId 键不同、读不到别家令牌）。

安全存储兼容新增：`test/token_store_scope_test.dart` 补了令牌读 / 写 / 删除往返与重复删除幂等；
`test/host_credential_coexistence_test.dart` 用 4 例证明组件的清除不越界
（宿主模拟的音乐服务器密码与第三方令牌在清理 / 登出 / 重登 / 默认仓库下始终可读）。

示例应用见仓库 `examples/flutter`（含像素遮挡演示区）。
