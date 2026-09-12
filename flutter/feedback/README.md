# feedback_widget

个人反馈组件：把 Feedback 服务的反馈悬浮按钮与面板嵌入 Flutter 应用。
对接 `docs/api.md` 定义的 HTTP 契约（v1）。

> 📘 **完整接入指南：[`docs/integration.md`](../../docs/integration.md)**
> —— 从服务端配置、依赖安装（path / 固定 Git commit）、悬浮球挂载到登录/截图/反馈/归档的端到端步骤。
> 本 README 是 Flutter 端 API 与遮挡语义的**权威参考**。

## 支持平台

web、android、ios、windows、macos、linux（平台差异经条件导入隔离）。

## 使用

```dart
import 'package:feedback_widget/feedback_widget.dart';

final controller = FeedbackController();

FeedbackWidget(
  config: FeedbackConfig(
    'https://fb.example.com', // apiBase
    'com.example.app',        // appId（服务端已登记）
    appVersion: '1.2.3',      // 仅显式传入才上报
    pageLabel: 'settings',    // 仅显式传入才上报
    side: FeedbackSide.right,
    logProvider: myLogExporter, // 可选：宿主日志导出（见「日志附件」）
  ),
  controller: controller,
  child: MyHomePage(),
)
```

- 悬浮圆形按钮（`Material`，Semantics「反馈」）或灵感球（`launcherMode:
  FeedbackLauncherMode.orb`，支持拖拽落点截图）呼出面板；
  `controller.open()` / `controller.close()` 可主动呼出。
- 宽屏（≥768px）面板为侧边抽屉（约 400px，可点遮罩关闭）；
  窄屏为全屏页面式。`Esc` 关闭面板。

## 截图与遮挡

- **截图范围只限宿主视口**：捕获的是 `FeedbackWidget` 包住的宿主子树
  （`RepaintBoundary` 边界）当前完整视口，**不做局部裁剪**（灵感球落点只作为
  元数据 `releasePoint` 上报，不据此裁图），**不包含系统悬浮窗 / 状态栏等
  系统 UI**，也**无法跨应用截图**；反馈组件自身的 UI 位于截图边界之外，
  不入图。
- **呼出前先查草稿（统一守卫）**：三个入口——普通点击（悬浮按钮 / 灵感球点按）、
  灵感球拖动释放（带落点）、`FeedbackController.captureAndOpen()`——全部汇入
  同一处，先读面板的只读 `hasDraft`（去空白后的正文非空）与 `hasScreenshot`：
  - 面板已持有草稿文本**或**截图 → **不截图**，直接打开面板，原有的文字与
    截图字节原样恢复（避免新图覆盖用户正在编辑的内容；`captureAndOpen()`
    此时同步展开，不进入捕获流程）；
  - 两者都没有 → 照常「先截图后开面板」。
  面板只在首次呼出后挂载，未挂载即无草稿可言，照常捕获。
- **先截图后开面板**：呼出（含灵感球拖拽落点）时保持宿主当前布局等待
  paint 完成 → 捕获宿主边界（遮挡 + 编码）→ 校验捕获会话 → 挂载面板并
  交付截图 → 最后聚焦输入框。反馈 UI 位于截图边界之外，不入图。
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
- 提交期间冻结快照（正文 + 截图字节 + 元数据 + 日志）；`409
  idempotency_conflict` 提示「该反馈已提交」且不自动换 key。
- 状态视图：提交中 → 已接收 / 处理中（轮询 `GET /api/feedback/:id`，
  2s→5s 退避）→ 已归档（可打开/复制 Kaneo 链接）；失败视图见上（刷新 /
  复制 ID / 返回编辑）。成功接收后才清空草稿与截图。

## 日志附件

- `FeedbackConfig(logProvider: ...)` 让宿主把**已有日志系统**接进来：
  `typedef FeedbackLogProvider = Future<List<FeedbackLogFile>> Function();`
  （`FeedbackLogFile = { String name; Uint8List bytes }`）。未配置时面板只显示
  「添加文件」入口。宿主负责在交付前去除凭据等敏感内容。
- **采集时机**：新草稿**首次打开**面板时调用一次（3 秒超时）；重新打开已有
  草稿不重新采集，用户移除日志后不自动补回；提交成功后新草稿重新采集。
  采集中允许继续编辑描述与截图。
- **失败不阻塞**：超时或回调抛错 → 面板显示「日志获取失败」，提供「重试」与
  「不带日志继续提交」；截图与描述的提交不受影响。
- **限制（自动与手动共用，整批拒绝、不静默删除或截断）**：最多
  `kFeedbackMaxLogs`(3) 个、每个 ≤ `kFeedbackMaxLogBytes`(1 MiB)、扩展名
  ∈ `.log/.txt/.json/.jsonl`（大小写不敏感）、内容非空且**严格 UTF-8**
  （`utf8.decode(bytes, allowMalformed: false)`，无替换字符、无 NUL）。
- **面板**：展示文件名、大小与来源（自动 / 手动），支持纯文本预览（超过
  `kFeedbackLogPreviewMaxRunes` 码点只预览前 N 个，提交字节不变）与移除，
  并说明日志会参与 AI 分析并随反馈归档。
- **手动添加**：`file_selector.openFiles`（`XTypeGroup` 扩展名过滤）+
  `XFile.readAsBytes()` **按字节读取**，Web 与原生端一致；`pickLogFiles`
  可注入自定义选择器（测试 / 特殊平台）。
- **提交编码**：有截图**或**有日志 → `multipart/form-data`，
  `metadata.logs = [{ name, source, byteSize }]` 与重复的 `logs` 文件部件
  （filename = 日志名、contentType = `text/plain`）**同序**一一对应；
  都没有 → 保持原 JSON 请求（逐字节兼容旧客户端）。
- **迟到结果不写回**：面板关闭、组件销毁、切换 `apiBase` / `appId`
  （面板状态整体重建）后进行中的采集结果一律丢弃。
- 日志是提交快照的一部分（顺序敏感）：提交 / 轮询期间锁定附件修改，
  失败保留原快照；**增删或替换日志后生成新的幂等键**。

## 登录

- **原生端**：面板内用户名/密码表单 → `POST /api/auth/login`（携带
  `clientLabel`，形如 `flutter-macos-<iso 时间>`），返回的长期令牌存入
  flutter_secure_storage；后续请求带 `Authorization: Bearer`；
  401 时清除令牌并回到登录视图。密码不写日志。
- **令牌存储键按服务身份隔离**：原生键由 `apiBase` + `appId` 派生
  （`feedbackTokenStorageKey(config)` →
  `feedback_widget.bearer_token.<base64url(apiBase + "\u0000" + appId)>`，
  去掉 `=` 填充）。
  同一台设备上不同 Feedback 服务、或同一服务的不同 `appId` 各占一个槽位，
  读取时用同一派生键，因此**换服务读不到旧服务的令牌（返回 null），不会
  跨服务复用凭据**；键确定性、且只含平台存储后端安全字符
  （`A–Z a–z 0–9 - _ .`）。`SecureFeedbackTokenStore(config: ...)` 需要
  传入 `FeedbackConfig`（`createDefaultTokenStore(config)` 同样如此）。
- **Web 端**：`window.open("<apiBase>/login?appId=..&nonce=..&cb=..")`
  弹出登录窗口，监听 `postMessage` 并严格校验 `origin + type + nonce`，
  短期令牌**仅存内存**（不持久化，故无需服务隔离键）；弹窗被拦截时提供
  「打开登录窗口」按钮入口。

## 开发与验证

```sh
flutter analyze
flutter test
```

回归测试覆盖：像素级遮挡（敏感区不透明覆盖、周围布局、变换 AABB 多遮、
透明遮挡色、obscureText、双实例隔离、几何失效中止、统一图片限制边界）与
异步生命周期（先截图后开面板、A/B 交错、取消/关闭/销毁/控制器替换、
过期交付丢弃、草稿恢复不重拍、临时 ui.Image/ui.Picture 全路径释放），
见 `test/capture_mask_pixel_test.dart`、`test/capture_lifecycle_test.dart`。

另有两类新增回归：统一草稿守卫与重拍保留
（`test/draft_capture_guard_test.dart`：三个入口都不重拍、重拍失败/取消/
中途关闭保留文案与旧图）与两类失败路径 + 服务隔离存储键
（`test/submit_failure_class_test.dart`：Class A 同 key 同字节 / 换图换 key、
Class B 零重发 + 刷新 + 复制 ID；`test/token_store_scope_test.dart`：
不同服务 / 不同 appId 键不同、读不到别家令牌）。

日志附件的回归见 `test/logs_test.dart`（校验规则与 multipart 线格式：
`metadata.logs` 顺序 / `byteSize` / 部件 filename 与 `text/plain`、
无日志时 JSON 逐字节兼容）与 `test/logs_panel_test.dart`（自动采集一次、
超时与失败重试、手动添加、扩展名/大小/数量/UTF-8 超限提示、预览与移除、
不自动补回、重开不重采集、迟到结果不写回（关闭 / 销毁 / 切身份）、
提交与轮询期间锁定、改附件换新幂等键）。

示例应用见仓库 `examples/flutter`（含像素遮挡演示区与宿主日志环形缓冲 →
`logProvider` 接入演示）。
