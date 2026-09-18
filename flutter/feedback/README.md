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

FeedbackWidget(
  config: FeedbackConfig(
    'https://fb.example.com', // apiBase
    'com.example.app',        // appId（服务端已登记）
    appVersion: '1.2.3',      // 仅显式传入才上报
    pageLabel: 'settings',    // 仅显式传入才上报
    side: FeedbackSide.right,
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
- **内容有界可滚**：撰写（含截图 / 日志 / 登录表单）与设置视图放在
  有界滚动区内——高度充足时主输入区照旧占满剩余空间；高度不足（键盘 /
  横屏 / 放大字体）时整体可滚，底部计数与「登录并提交 / 保存」等操作
  按钮始终可达，不再溢出裁剪。面板标题与关闭入口保持在顶部可见。
- **焦点链**：账号框 `下一步` → 密码框；密码框 `完成` → 沿用登录流程；
  服务器地址框 `完成` → 保存。字段获得焦点或键盘尺寸变化（开合 /
  旋转）后，布局完成时自动把聚焦字段滚回可见区域。
- 键盘展开、收起与旋转不清空输入、不丢草稿、不触发重复提交。

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
- **每日额度**：每个账号默认每天 3 次（北京时间零点刷新，跨项目/设备共用）。
  撰写区显示「今日剩余 N 次」；额度用尽时提交按钮禁用并提示，草稿保留。
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

当前实测：`flutter analyze` 无问题、`flutter test` **112/112 通过**。
依赖三档（9.2.2 / 10.3.1 / 11.0.0）在上面的隔离矩阵里各跑一遍同一批用例
（`bash tools/flutter-storage-matrix/run.sh`）。

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

安全存储兼容新增：`test/token_store_scope_test.dart` 补了令牌读 / 写 / 删除往返与重复删除幂等；
`test/host_credential_coexistence_test.dart` 用 4 例证明组件的清除不越界
（宿主模拟的音乐服务器密码与第三方令牌在清理 / 登出 / 重登 / 默认仓库下始终可读）。

示例应用见仓库 `examples/flutter`（含像素遮挡演示区）。
