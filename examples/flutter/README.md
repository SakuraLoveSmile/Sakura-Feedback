# feedback_example

`feedback_widget`（见仓库 `flutter/feedback`）的示例应用。
完整接入说明见 [`docs/integration.md`](../../docs/integration.md)。

## 这个示例演示什么

- **组件挂在 Navigator 之上**：`lib/main.dart` 里 `FeedbackWidget` 通过
  `MaterialApp.builder` 包裹**应用的 Navigator 子树**，而不是某个页面的 child。
  于是 push/pop 路由不会重建组件——灵感球在任何路由下都在场，草稿、截图与登录
  令牌也不会因为导航丢失（`test/widget_test.dart` 断言了组件 State、控制器实例
  与面板 State 在导航前后是同一个对象）。
- **控制器由应用根拥有**：`FeedbackController` 是根 `StatefulWidget` 的字段，
  只在根的 `dispose()` 里释放；页面只接收它，不创建也不释放。
- **第二个路由 + 宿主对话框**（`lib/details_page.dart`、`lib/host_dialog.dart`）：
  演示"导航不丢入口"，以及"截图拍到的是宿主内容"——对话框打开时截图**包含宿主
  对话框**，但**不包含反馈面板自己**。
- **`FeedbackCaptureMask`**（`lib/sensitive_card.dart`）：敏感区域在截图中被
  中性遮罩（#6E6E73）覆盖；卡片同时用在第二个路由上，说明遮罩"随页面走"。
- **pageLabel 跟随路由**：`pageLabel` 必须由宿主显式传入（组件绝不自动抓取页面
  信息）。示例用一个 `NavigatorObserver` 把当前命名路由同步进 `ValueNotifier`，
  再交给组件的 `FeedbackConfig.pageLabel`；匿名路由（对话框）不会改变它。
- **显式声明截图模式**：配置里写明了
  `launcherMode: FeedbackLauncherMode.orb` 与
  `captureMode: FeedbackCaptureMode.viewport`
  ——组件默认是 `FeedbackLauncherMode.tab` / `FeedbackCaptureMode.off`，
  升级不会改变旧宿主行为，要灵感球和自动截图必须显式写。
- **日志自动附带（`logProvider`）与手动补充**：
  配置中提供了 `logProvider` 回调返回 `FeedbackLogPart` 列表（最多 3 份文件、每份不超过 1 MiB、支持 `.log/.txt/.json/.jsonl`）。
  面板支持纯文本预览与移除，并支持通过 `file_selector` 手动补充日志文件。
  **重要安全提醒**：日志来自宿主已有系统，宿主负责在将日志交付给回调前去除令牌、密钥、密码或用户隐私等敏感数据。日志提交后会进入服务端落库、参与 AI 诊断并归档至 Kaneo。

### 日志接入（`logProvider` + `file_selector`）

`lib/main.dart` 里的写法（把宿主已有日志交给组件）：

```dart
FeedbackConfig(
  apiBase,
  appId,
  logProvider: () async {
    final String text = /* 宿主自己的日志来源，先脱敏 */ '';
    return <FeedbackLogPart>[
      FeedbackLogPart(name: 'app.log', bytes: Uint8List.fromList(utf8.encode(text))),
    ];
  },
)
```

- 类型：`typedef FeedbackLogProvider = FutureOr<List<FeedbackLogPart>> Function()`；`FeedbackLogPart(name, bytes)`，`bytes` 是 `Uint8List`。**不配置就完全不自动采集**。
- 时机与超时：每份新草稿**首次打开面板时调用一次**，超时 **3 秒**；失败/超时后面板可**重试**或**不带日志继续提交**（日志是附加排查素材，不该阻塞反馈）。
- 限制（自动 + 手动合计）：≤ **3** 个文件、单份 ≤ **1 MiB**、合计 ≤ **3 MiB**，仅 `.log`/`.txt`/`.json`/`.jsonl`，必须是有效 UTF-8 且不含 NUL。数量/大小超限 → `413 too_large`；其余 → `400 invalid_log`，**整单拒绝**（不会只丢一份、不会截断）。
- **手动补充走 `file_selector`**（依赖 `file_selector: ^1.1.0`）：`openFile(acceptedTypeGroups: [XTypeGroup(extensions: ['log','txt','json','jsonl'])])` → `await file.readAsBytes()` **按字节读取**（不先转字符串，避免大文件被整块转码/截断），再走与自动采集相同的校验。
- **未验证项（如实标注）**：原生系统文件选择器弹窗在本机自动化测试下**未验证**，需真机/桌面手动点一次确认。
- ⚠️ **脱敏在宿主侧**（组件不做过滤）：清除 Token/密钥/密码等凭据与个人数据；日志**会参与 AI 诊断并归档到 Kaneo 任务**（截图成功但某份日志未完成时，记录不会是「已归档」，而是 `failed` / `needs_review`）。
- 状态：本轮**已落地（待体验）**（依赖 t4 的 `flutter test` / `flutter analyze` 通过记录，本轮文档未复跑；尚未完成真实设备端到端验收）。细节见 [`docs/integration.md` 第 9 章](../../docs/integration.md#9-日志接入本轮新增) 与 [`flutter/feedback/README.md`](../../flutter/feedback/README.md)。

### 为什么 builder 里还套了一层外层 Navigator

面板里的 `TextField` 需要 `Overlay` 祖先才能建立选择浮层，截图放大预览用的
`showDialog()` 也需要 `Navigator`/`Overlay` 祖先（见 `flutter/feedback` 的
`FeedbackPanel`）。而应用自己的 Navigator 在组件**之下**，祖先查找只向上走，
所以示例在 `MaterialApp.builder` 里用一个只承载组件、不做任何跳转的外层
Navigator 提供这两个祖先。

由此带来一条**宿主注意事项**：这层外层 Navigator 就是 `rootNavigator`，
宿主自己 `showDialog(...)` 若用默认的 `useRootNavigator: true`，对话框会被推到
组件**上方**——既压住灵感球，也不会进入截图。所以 `lib/host_dialog.dart` 显式用
`useRootNavigator: false`，让对话框落在应用自己的 Navigator 里（= 宿主内容）。

## 运行

```sh
# 先启动 Feedback 服务（默认 8787 端口），或修改 lib/main.dart 中的 apiBase/appId
flutter run -d chrome
flutter run -d macos
```

本机 Flutter 不在 PATH 上时用绝对路径：`/Users/sakurasep/flutter/bin/flutter`。

平台目录已生成：web、android、ios、linux、macos、windows。
页面与反馈服务通常跨源：服务端只对**软件配置里登记的 `allowedOrigins`** 回显
CORS（`apps/server/src/app.ts`），记得把宿主 origin 加进去。

## 检查

```sh
cd examples/flutter
/Users/sakurasep/flutter/bin/flutter analyze   # 本机实测：No issues found!
/Users/sakurasep/flutter/bin/flutter test      # 本机实测：4 个用例全过
```

`test/widget_test.dart` 覆盖：

1. 冒烟：灵感球呼出面板（`captureMode: viewport` 的"先截图后开面板"）；
2. 结构：切换路由后入口仍在、组件/控制器/面板实例未被重建；
3. 截图范围：宿主对话框在截图边界内、反馈面板在边界外
   （结构断言 + 对截图边界 `toImage()` 的像素断言）；
4. 应用根卸载后控制器确实已被 `dispose()`。

令牌仓库 `flutter_secure_storage` 在单测环境不可用，面板会容错回落到登录视图
（测试依赖这一行为）。

## 构建备注（本机环境）

- **macOS**：`macos/Podfile` 已把 `MACOSX_DEPLOYMENT_TARGET` 抬到 12.0
  （`platform :osx, '12.0'` + post_install 统一处理 pod 目标），否则
  `flutter build macos` 会因 10.15 目标被本机 Xcode 27.0 拒绝。
- **Android**：需要 JDK 17+（本机在 `/opt/homebrew/opt/openjdk@17`，
  构建前把 `JAVA_HOME` 指过去即可）。本示例只验证了 `flutter analyze` /
  `flutter test`，未在本机跑 Android 构建。
