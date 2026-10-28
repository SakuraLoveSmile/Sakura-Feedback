import 'dart:io' show Platform;

/// 是否运行在 Flutter 官方测试环境（`flutter test` / flutter_tester——
/// flutter 工具链启动测试进程时注入 `FLUTTER_TEST=1`）。
///
/// 用途：灵感球光晕是**常驻循环动画**，在测试环境启动 Ticker 会挂起任何
/// `pumpAndSettle`。测试环境下不启动该 Ticker（光晕渲染为静态、缩放动效
/// 不受影响），**真实应用与 Web 恒不受影响**（不降低真实动画效果）。
final bool kFeedbackInFlutterTest =
    Platform.environment.containsKey('FLUTTER_TEST');
