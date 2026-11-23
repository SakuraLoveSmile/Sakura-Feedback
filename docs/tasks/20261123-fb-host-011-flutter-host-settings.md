# FB-HOST-011 · Flutter 宿主托管反馈设置

MediaPlayer 希望在自己的设置页管理反馈外观与手势，反馈面板仅保留服务器设置。Flutter API、逐项托管语义和最小示例见 [接入指南 §4.2.1](../integration.md#421-flutter-宿主托管反馈设置可选)。

- 基线为 `099faf3`，任务分支 `feat/20261123-fb-host-011-flutter-host-settings`，工作树位于项目登记目录下的 `20261123-feat-fb-host-011-flutter-host-settings`，合入目标为 `main`。
- 旧宿主沿用 v0.10.0 默认值。新增三个值和回调、设置分组开关及四个公开类型。包在 MaterialApp 外层时，下拉选项使用组件已有的 Overlay；有 Navigator 时沿用原下拉框。
- 用户选定走仓库正式 `v0.11.0` Release。Web、admin、server 与根包同步版本元数据，发布标准产物；生产部署另行安排。
- 本机 Flutter 3.41.3 / Dart 3.11.1。组件 analyze 通过，全部 704 项测试通过。组件测试使用内存存储与 mock HTTP；新增用例覆盖只给值、回调后等待宿主回传、取消托管后恢复本机选择、光束和球体实际动效、自定义快捷键以及整页隐藏。
- Chrome 实际运行 Flutter Web 测试宿主，将组件挂在 MaterialApp 外层。只传三个值并开启 hideSettings 时，设置页仅含服务器地址、保存与恢复默认。开启入场回调后，选择「取景成球」成功回传并显示新值。
- 宿主体验状态为待体验。MediaPlayer 工程由宿主方按升级示例接入。
