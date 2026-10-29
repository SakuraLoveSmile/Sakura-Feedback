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

/// 仅在测试中关闭 C 路线捕获，让灵感球固定走 A 路线透镜。
///
/// A 路线的像素证据（倍率、对比度、对齐）必须在没有捕获接管的条件下采集，
/// 否则首次可见的一次性捕获会把透镜换成 C。生产默认 false。
bool debugDisableOrbLensCapture = false;

/// 仅在测试中让 C 路线着色器加载必定失败，用于验证退化到 A。
bool debugFailOrbLensShader = false;

/// 仅在测试中让 C 路线的宿主捕获必定抛错，用于验证「首次 + 两次重试」上限。
bool debugFailOrbLensCapture = false;

/// C 路线两次捕获之间的最小间隔；测试可调小以免依赖真实等待。
///
/// 生产值保持 [Duration(seconds: 1)]，不随宿主配置变化。
Duration debugOrbLensGateDuration = const Duration(seconds: 1);

/// C 路线真正调用 `toImage` 的次数，供测试观测触发节奏与重试上限。
///
/// 只在通过前置检查、即将捕获时自增；shader 不可用或闸门拦截都不计。
int debugOrbLensCaptureAttempts = 0;
