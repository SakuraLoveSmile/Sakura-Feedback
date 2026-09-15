// T3 verifier 独立宿主契约测试。
//
// 两条断言线：
//  1) 解析线：本宿主用 path 依赖引用工作区 flutter/feedback，pubspec.yaml 里的
//     flutter_secure_storage 被 run_matrix.sh 固定成精确版本。这里直接读本目录的
//     pubspec.lock，断言实际解析出的复现家族形态与期望一致——证明工作区里
//     '>=9.2.2 <12.0.0' 这一约束在三档下都能解析成功。
//  2) 行为线：用包真实使用的存储类（platform_io.dart 的 SecureFeedbackTokenStore）
//     在插件自带的内存平台实现上跑 read/write/delete、槽位隔离与宿主凭据共存。
//
// 档位由 --dart-define=MATRIX_TIER=<版本> 注入（run_matrix.sh）。
// ignore_for_file: implementation_imports
import 'dart:io';

import 'package:feedback_matrix_host/feedback_matrix_host.dart';
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const String kTier = String.fromEnvironment('MATRIX_TIER', defaultValue: '');

/// 极简 pubspec.lock 解析：packages 段下 name -> version。
Map<String, String> parseLock(String path) {
  final Map<String, String> out = <String, String>{};
  String? section;
  String? name;
  for (final String raw in File(path).readAsLinesSync()) {
    if (raw.trim().isEmpty || raw.trimLeft().startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      section = raw.split(':').first.trim();
      continue;
    }
    if (section != 'packages') continue;
    final int indent = raw.length - raw.trimLeft().length;
    final String s = raw.trim();
    if (indent == 2 && s.endsWith(':')) {
      name = s.substring(0, s.length - 1);
    } else if (indent == 4 && s.startsWith('version:') && name != null) {
      out[name] = s.split(':')[1].trim().replaceAll('"', '');
    }
  }
  return out;
}

int majorOf(String? version) =>
    version == null ? -1 : int.tryParse(version.split('.').first) ?? -1;

void main() {
  final TierExpectation? exp = expectationFor(kTier);
  final Map<String, String> lock = parseLock('pubspec.lock');

  group('[$kTier] 解析线（path 依赖工作区 flutter/feedback + 本档精确固定）', () {
    test('档位注入有效且期望表覆盖', () {
      expect(kTier, isNotEmpty, reason: 'run_matrix.sh 必须注入 MATRIX_TIER');
      expect(exp, isNotNull, reason: '档位 $kTier 必须在期望表里');
    });

    test('flutter_secure_storage 精确解析到本档', () {
      expect(lock['flutter_secure_storage'], kTier);
    });

    test('复现家族形态与本档期望一致（darwin/macos/windows/platform_interface）', () {
      final bool hasDarwin = lock.containsKey('flutter_secure_storage_darwin');
      final bool hasMacos = lock.containsKey('flutter_secure_storage_macos');
      expect(hasDarwin, exp!.expectDarwin, reason: 'darwin 子包出现时机');
      expect(hasMacos, exp.expectMacos, reason: 'macos 子包出现时机');
      expect(hasDarwin && hasMacos, isFalse, reason: '两代 macos 实现不得同时出现');
      expect(majorOf(lock['flutter_secure_storage_windows']), exp.windowsMajor);
      expect(majorOf(lock['flutter_secure_storage_platform_interface']),
          exp.platformInterfaceMajor);
    });
  });

  group('[$kTier] 行为线（本档插件 API：read / write / delete）', () {
    late Map<String, String> backend;
    late SecureFeedbackTokenStore store;

    FeedbackConfig config() =>
        FeedbackConfig('https://feedback.matrix.test', 'com.example.matrix');

    setUp(() {
      backend = <String, String>{
        'music_subsonic_password': 'music-secret',
        'third_party.access_token': 'third-party-token',
      };
      FlutterSecureStorage.setMockInitialValues(backend);
      store = SecureFeedbackTokenStore(config: config());
    });

    test('三版共有的构造与 API 面：const 构造 + read/write/delete', () async {
      const FlutterSecureStorage storage = FlutterSecureStorage();
      const String probeKey = 'matrix.probe';
      expect(await storage.read(key: probeKey), isNull);
      await storage.write(key: probeKey, value: 'v');
      expect(await storage.read(key: probeKey), 'v');
      await storage.delete(key: probeKey);
      expect(await storage.read(key: probeKey), isNull);
      expect(backend.containsKey(probeKey), isFalse, reason: 'delete 必须真的移除键');
    });

    test('组件使用的存储路径：写后可读、删除后为 null、键不残留', () async {
      expect(await store.read(), isNull);
      await store.write('token-matrix');
      expect(await store.read(), 'token-matrix');
      expect(backend[store.storageKey], 'token-matrix');

      await store.clear();
      expect(await store.read(), isNull);
      expect(backend.containsKey(store.storageKey), isFalse);
    });

    test('重复删除幂等（登出 + 迟到 401 连续清理）', () async {
      await store.clear();
      await store.write('token-once');
      await store.clear();
      await expectLater(store.clear(), completes);
      expect(backend.keys, hasLength(2), reason: '只剩宿主自己的两个键');
    });

    test('跨服务 / 跨 appId 隔离：派生键不同、互不可见', () async {
      final SecureFeedbackTokenStore other = SecureFeedbackTokenStore(
        config: FeedbackConfig('https://feedback.matrix.test', 'com.example.other'),
      );
      await store.write('token-a');
      expect(await other.read(), isNull);
      expect(other.storageKey, isNot(store.storageKey));
      await other.write('token-b');
      expect(await store.read(), 'token-a');
      expect(await other.read(), 'token-b');
    });

    test('宿主凭据共存：Feedback 登出清理后音乐密码与第三方令牌仍可读', () async {
      await store.write('token-login');
      expect(appKeys(backend), hasLength(3), reason: '只新增自己的一格');

      await store.clear(); // 登出
      await store.clear(); // 迟到的 401 清理

      const FlutterSecureStorage storage = FlutterSecureStorage();
      expect(await storage.read(key: 'music_subsonic_password'), 'music-secret');
      expect(await storage.read(key: 'third_party.access_token'),
          'third-party-token');
      expect(appKeys(backend), unorderedEquals(
          <String>['music_subsonic_password', 'third_party.access_token']),
          reason: '清理后不得残留 Feedback 槽位，也不得误删宿主键');
    });

    test('默认原生仓库（createDefaultTokenStore）同样只碰自己的键', () async {
      final FeedbackTokenStore def = createDefaultTokenStore(config());
      await def.write('token-default');
      await def.clear();
      const FlutterSecureStorage storage = FlutterSecureStorage();
      expect(await storage.read(key: 'music_subsonic_password'), 'music-secret');
      expect(await storage.read(key: 'third_party.access_token'),
          'third-party-token');
      expect(backend.containsKey(feedbackTokenStorageKey(config())), isFalse);
    });

    test('存储键形态：稳定前缀 + 平台安全字符集', () {
      final String key = feedbackTokenStorageKey(config());
      expect(key, startsWith('feedback_widget.bearer_token.'));
      expect(RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(key), isTrue, reason: key);
      expect(key, isNot('feedback_widget.bearer_token'));
    });
  });
}

List<String> appKeys(Map<String, String> backend) => backend.keys.toList()..sort();
