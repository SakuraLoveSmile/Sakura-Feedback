// 原生平台实现：服务器覆盖偏好持久化于 flutter_secure_storage
// （应用私有存储区，天然按宿主隔离）。
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'server_pref.dart';

/// 基于 flutter_secure_storage 的原生偏好仓库。
///
/// 复用与令牌相同的平台安全存储：键由服务身份派生
/// （见 [serverOverrideStorageKey]），不同宿主配置 / appId / 默认地址
/// 使用不同槽位，互不串读。
class SecureServerPrefStore implements FeedbackServerPrefStore {
  /// [storage] 可注入以便测试。
  SecureServerPrefStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// 原生默认偏好仓库。
FeedbackServerPrefStore createDefaultServerPrefStore() =>
    SecureServerPrefStore();
