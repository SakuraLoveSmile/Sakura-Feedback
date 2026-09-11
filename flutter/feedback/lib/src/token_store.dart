import 'dart:convert';

import 'config.dart';

/// 反馈服务 Bearer 令牌的存储抽象。
///
/// - 原生平台默认实现基于 flutter_secure_storage（持久化、可撤销的长期令牌）。
/// - Web 平台默认实现仅存内存（握手交付的短期令牌，刷新后需重新握手）。
abstract class FeedbackTokenStore {
  /// 读取令牌；无令牌时返回 null。
  Future<String?> read();

  /// 写入令牌。
  Future<void> write(String token);

  /// 清除令牌（登出 / 401 失效时调用）。
  Future<void> clear();
}

/// 由服务身份（`apiBase` + `appId`）推导原生令牌存储键。
///
/// 同一台设备上，不同的 Feedback 服务（不同 `apiBase`）或同一服务的不同
/// `appId` 都是**不同的凭据身份**：存储键必须绑定二者，否则服务 B 会读到
/// 服务 A 的令牌（凭据跨服务复用）。
///
/// 键的形态为 `feedback_widget.bearer_token.<base64url(apiBase + NUL + appId)>`
/// （去掉 `=` 填充）：
/// - 确定性：同一配置永远得到同一键；
/// - 无碰撞：编码可逆，不同身份不会映射到同一键；
/// - 平台安全：只用 `A–Z a–z 0–9 - _ .`，不含 `/`、`+`、`=`、空格与换行，
///   可直接作为 Keychain account / EncryptedSharedPreferences 的键。
String feedbackTokenStorageKey(FeedbackConfig config) {
  final String identity = '${config.apiBase}\u0000${config.appId}';
  final String encoded =
      base64Url.encode(utf8.encode(identity)).replaceAll('=', '');
  return 'feedback_widget.bearer_token.$encoded';
}

/// 纯内存实现：Web 默认、测试注入均使用它。
class MemoryTokenStore implements FeedbackTokenStore {
  /// 创建一个内存令牌仓库。
  MemoryTokenStore([String? initial]) : _token = initial;

  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async => _token = token;

  @override
  Future<void> clear() async => _token = null;
}
