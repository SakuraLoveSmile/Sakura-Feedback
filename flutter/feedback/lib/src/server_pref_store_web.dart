// Web 平台实现：服务器覆盖偏好持久化于 localStorage（按页面源隔离）。
import 'package:web/web.dart' as web;

import 'server_pref.dart';

/// 基于 localStorage 的 Web 偏好仓库。
class LocalStorageServerPrefStore implements FeedbackServerPrefStore {
  @override
  Future<String?> read(String key) async =>
      web.window.localStorage.getItem(key);

  @override
  Future<void> write(String key, String value) async {
    web.window.localStorage.setItem(key, value);
  }

  @override
  Future<void> delete(String key) async {
    web.window.localStorage.removeItem(key);
  }
}

/// Web 默认偏好仓库。
FeedbackServerPrefStore createDefaultServerPrefStore() =>
    LocalStorageServerPrefStore();
