# FB-HOST-011 · Flutter 宿主托管反馈设置

MediaPlayer 希望在自己的设置页管理反馈外观与手势，反馈面板仅保留服务器设置。Flutter API、逐项托管语义和最小示例见 [接入指南 §4.2.1](../integration.md#421-flutter-宿主托管反馈设置可选)。

- 基线为 `099faf3`，任务分支 `feat/20261123-fb-host-011-flutter-host-settings`，工作树位于项目登记目录下的 `20261123-feat-fb-host-011-flutter-host-settings`，合入目标为 `main`。
- 旧宿主沿用 v0.10.0 默认值。新增三个值和回调、设置分组开关及四个公开类型。包在 MaterialApp 外层时，下拉选项使用组件已有的 Overlay；有 Navigator 时沿用原下拉框。
- 用户选定走仓库正式 `v0.11.0` Release。Web、admin、server 与根包同步版本元数据，发布标准产物；生产部署另行安排。
- 本机 Flutter 3.41.3 / Dart 3.11.1。组件 analyze 通过，全部 704 项测试通过。组件测试使用内存存储与 mock HTTP；新增用例覆盖只给值、回调后等待宿主回传、取消托管后恢复本机选择、光束和球体实际动效、自定义快捷键以及整页隐藏。
- Chrome 实际运行 Flutter Web 测试宿主，将组件挂在 MaterialApp 外层。只传三个值并开启 hideSettings 时，设置页仅含服务器地址、保存与恢复默认。开启入场回调后，选择「取景成球」成功回传并显示新值。
- 宿主体验状态为待体验。MediaPlayer 工程由宿主方按升级示例接入。

## 发布核验

- 功能提交 `a6c940c` 已合入 `main`，远端标签 `v0.11.0` 指向同一提交。主线 CI 的六项检查全部通过，覆盖 Flutter 示例和三档安全存储依赖。[主线 CI](https://github.com/SakuraLoveSmile/Sakura-Feedback/actions/runs/45104066495)
- 正式 Release 已公开并标记为 Latest。已下载七份资产，核对 SHA-256、来源提交、镜像 digest 与发布清单；Release 正文与 CHANGELOG 的 0.11.0 段落一致。[Release](https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/tag/v0.11.0) · [发布流水线](https://github.com/SakuraLoveSmile/Sakura-Feedback/actions/runs/45104510029)
- 干净 Flutter 宿主按公开 Git URL、标签和子目录执行 `flutter pub get`，锁文件解析为 0.11.0 / `a6c940c`。仅从包入口导入四个新公开类型的宿主示例通过 `flutter analyze`。
- 本任务工作树及已合入的临时本地分支已清理。生产环境未部署，MediaPlayer 内体验待宿主升级验证。

## 后续（2026-11-23）

接入清单（[`docs/integration.md`](../integration.md) §1.2）在宿主填完 `api-base` / `app-id` 后新增一步「宿主设置托管」，官方 [`examples/flutter`](../examples/flutter) 同步演示托管用法。

- 清单新增第 6 步：宿主若统一管理反馈外观与手势，按 §4.2.1 传入 `launcherStyle` / `wakeVisual` / `orbEntrance`（以及 `orbIdleStyle` / `wakeGestures`）并设 `hideSettings: true`；通过信号是面板设置页只剩服务器设置、宿主设置页改选后立即生效。§4.2.1 开头补了推荐口径（集中管理设置的宿主应在接入时接管这五项）。
- 示例：应用根 State 持有 `launcherStyle` / `wakeVisual` / `orbEntrance`（默认 `beam` / `ripple` / `bead`），挂载 `FeedbackWidget` 时传这三个值并设 `hideSettings: true`；首页新增「宿主设置」入口，底部弹层改选后 `setState` 重建组件即生效（[`lib/host_settings.dart`](../../examples/flutter/lib/host_settings.dart)）。`MaterialApp` 结构与控制器生命周期未改。
- 验证（分支 `docs/20261123-fb-host-011-integration-reminder`，本机 Flutter 3.41.3 / Dart 3.11.1）：`examples/flutter` 的 `flutter pub get` 成功、`flutter analyze` 输出 `No issues found!`、`flutter test` 40 个用例全过（原 38 项 + 新增 [`test/host_settings_test.dart`](../../examples/flutter/test/host_settings_test.dart) 2 项，覆盖改选后组件收到新值与入口样式切换为灵感球）；`flutter/feedback` 的 `flutter analyze` 同样 `No issues found!`（组件代码未改）。
- 本次只改文档与示例：未改 `flutter/feedback/lib`，未升版本，未发 Release。推送与合入 `main` 结果见提交 `docs(integration): 接入清单增加宿主设置托管，示例演示托管用法`。
