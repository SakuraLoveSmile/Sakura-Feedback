/// 测试环境探测（条件导出，形态与 [platform.dart] 一致）：
///
/// - 原生 / VM（含 `flutter test` 的 flutter_tester）：走 `test_env_io.dart`，
///   读取工具链注入的 `FLUTTER_TEST` 环境变量。
/// - Web（无 `dart:io`）：走 `test_env_stub.dart`，恒为 false。
library;

export 'test_env_stub.dart' if (dart.library.io) 'test_env_io.dart';

/// 仅在测试中强制创建灵感球常驻控制器。
///
/// 默认 false，保持 spec 7.3「flutter test 不创建 Ticker」的行为。
/// 该变量是给测试与调试用的公共开关，不是宿主配置项；生产构建里
/// kFeedbackInFlutterTest 恒为 false，正常运行时不会开启常驻 Ticker。
/// 开启后**禁止使用 `pumpAndSettle`**（常驻 Ticker 会挂起），
/// 用例必须使用有限次 `pump(Duration)`，并在 tearDown 中复位为 false。
bool debugForceOrbAnimation = false;
