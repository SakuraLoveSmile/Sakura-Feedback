// 原生平台实现：令牌持久化于 flutter_secure_storage；
// 登录走面板内用户名/密码表单（POST /api/auth/login + clientLabel）。
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'config.dart';
import 'token_store.dart';
import 'web_handshake.dart';

/// 基于 flutter_secure_storage 的原生令牌仓库。
///
/// 存储键由服务身份派生（见 [feedbackTokenStorageKey]）：不同服务 / 不同
/// appId 使用不同槽位，服务 B 读不到服务 A 的令牌。读取时使用同一派生键，
/// 因此换服务即读不到旧服务的凭据（返回 null），而不是复用旧令牌。
class SecureFeedbackTokenStore implements FeedbackTokenStore {
  /// [config] 提供服务身份（决定存储键）；[storage] 可注入以便测试。
  SecureFeedbackTokenStore({
    required this.config,
    FlutterSecureStorage? storage,
  })  : _storage = storage ?? const FlutterSecureStorage(),
        _key = feedbackTokenStorageKey(config);

  /// 用于派生存储键的服务与展示配置。
  final FeedbackConfig config;

  final FlutterSecureStorage _storage;
  final String _key;

  /// 本仓库实际使用的存储键（只读；测试与服务隔离诊断用）。
  String get storageKey => _key;

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String token) =>
      _storage.write(key: _key, value: token);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// 原生默认仓库（存储键按服务身份隔离）。
FeedbackTokenStore createDefaultTokenStore(FeedbackConfig config) =>
    SecureFeedbackTokenStore(config: config);

/// 原生平台不支持 Web 弹窗握手（应使用登录表单）。
Future<WebHandshakeResult> startWebLoginHandshake({
  required String apiBase,
  required String appId,
  Duration timeout = const Duration(minutes: 5),
}) async {
  return const WebHandshakeResult.fail('Web 登录握手仅在 Web 平台可用');
}
