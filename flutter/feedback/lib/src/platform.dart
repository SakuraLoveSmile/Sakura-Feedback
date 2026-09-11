/// 平台条件入口：按是否 Web 编译选择实现。
///
/// - 原生（android/ios/macos/windows/linux）：[createDefaultTokenStore]
///   返回基于 flutter_secure_storage 的持久化仓库；登录走用户名密码表单。
/// - Web：[createDefaultTokenStore] 返回仅内存仓库；登录走
///   [startWebLoginHandshake] 弹窗握手。
library;

export 'platform_io.dart' if (dart.library.js_interop) 'platform_web.dart';
