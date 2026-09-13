/// 平台条件入口：按是否 Web 编译选择令牌仓库实现。
///
/// - 原生（android/ios/macos/windows/linux）：[createDefaultTokenStore]
///   返回基于 flutter_secure_storage 的持久化仓库。
/// - Web：[createDefaultTokenStore] 返回仅内存仓库。
///
/// 两端登录都走面板内用户名/密码表单（不打开登录窗口）。
library;

export 'platform_io.dart' if (dart.library.js_interop) 'platform_web.dart';
