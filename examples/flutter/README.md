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
# 先启动 Feedback 服务（默认 8787 端口）。默认值为下面这组地址和 appId。
flutter run -d chrome
flutter run -d macos

# 覆盖服务地址和服务端登记的 appId（编译时配置）：
flutter run -d chrome \
  --dart-define=FEEDBACK_API_BASE=http://localhost:8787 \
  --dart-define=FEEDBACK_APP_ID=com.example.demo

# Android 模拟器访问宿主电脑使用 10.0.2.2；真机使用电脑在同一局域网的 IP，
# 例如 http://192.168.1.20:8787。真机不能把 localhost 当作电脑。
flutter run -d android \
  --dart-define=FEEDBACK_API_BASE=http://10.0.2.2:8787 \
  --dart-define=FEEDBACK_APP_ID=com.example.demo
```

`FEEDBACK_API_BASE` 和 `FEEDBACK_APP_ID` 也适用于 `flutter build`。示例默认值保留为
`http://localhost:8787` 和 `com.example.demo`，没有传入 `--dart-define` 时无需额外配置。
Android 示例只在 debug 构建启用明文 HTTP（便于连接本地服务）；发布构建应使用 HTTPS。

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
