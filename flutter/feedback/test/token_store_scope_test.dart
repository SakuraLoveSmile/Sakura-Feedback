import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// 服务隔离回归：原生令牌存储键必须由服务身份派生。
///
/// 同一台设备上，不同 Feedback 服务（不同 apiBase）或同一服务的不同 appId
/// 都是不同的凭据身份——读取时不得复用另一身份的令牌。
/// flutter_secure_storage 无法在单测里跑真实平台通道，这里用插件自带的
/// 内存平台实现（`setMockInitialValues`）驱动真实的 [FlutterSecureStorage]。
void main() {
  const String baseA = 'https://svc-a.test';
  const String baseB = 'https://svc-b.test';

  FeedbackConfig configA() => FeedbackConfig(baseA, 'com.example.a');
  FeedbackConfig configB() => FeedbackConfig(baseB, 'com.example.b');

  late Map<String, String> backend;

  setUp(() {
    backend = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(backend);
  });

  group('feedbackTokenStorageKey', () {
    test('同一配置确定性推导出同一键，不同服务 / 不同 appId 键不同', () {
      final String key = feedbackTokenStorageKey(configA());
      expect(feedbackTokenStorageKey(configA()), key, reason: '推导必须确定性');

      expect(feedbackTokenStorageKey(configB()), isNot(key),
          reason: '不同 apiBase 必须使用不同存储键');
      expect(feedbackTokenStorageKey(FeedbackConfig(baseA, 'com.example.b')),
          isNot(key),
          reason: '同一 apiBase 的不同 appId 也必须使用不同存储键');
    });

    test('存储键平台安全（无 / + = 空格与换行）且带稳定的命名前缀', () {
      final String key = feedbackTokenStorageKey(configA());
      expect(key, startsWith('feedback_widget.bearer_token.'));
      expect(RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(key), isTrue,
          reason: '键只能包含平台存储后端安全字符，实际为：$key');
      // 末尾斜杠的 apiBase 与规范化后的 apiBase 视为同一身份。
      expect(feedbackTokenStorageKey(FeedbackConfig('$baseA/', 'com.example.a')),
          key);
    });
  });

  group('SecureFeedbackTokenStore', () {
    test('不同服务（apiBase）不共享令牌', () async {
      final storeA = SecureFeedbackTokenStore(config: configA());
      await storeA.write('token-service-a');

      final storeB = SecureFeedbackTokenStore(config: configB());
      expect(await storeB.read(), isNull, reason: '服务 B 不得读到服务 A 的令牌');
      expect(await storeA.read(), 'token-service-a');
    });

    test('不再使用全局常量 feedback_widget.bearer_token 作为存储键', () async {
      final store = SecureFeedbackTokenStore(config: configA());
      await store.write('token');
      expect(backend.keys, isNot(contains('feedback_widget.bearer_token')),
          reason: '固定全局键会让不同服务共享同一凭据槽位');
      expect(backend, hasLength(1));
      expect(store.storageKey,
          feedbackTokenStorageKey(configA()));
    });

    test('clear 只清除本服务的槽位，不影响另一服务', () async {
      final storeA = SecureFeedbackTokenStore(config: configA());
      final storeB = SecureFeedbackTokenStore(config: configB());
      await storeA.write('token-a');
      await storeB.write('token-b');
      expect(backend, hasLength(2), reason: '两个服务必须各占一个槽位');

      await storeA.clear();
      expect(await storeA.read(), isNull);
      expect(await storeB.read(), 'token-b');
    });

    test('同一 apiBase 的不同 appId 也是不同凭据身份', () async {
      final storeA = SecureFeedbackTokenStore(config: configA());
      await storeA.write('token-app-a');

      final storeB = SecureFeedbackTokenStore(
          config: FeedbackConfig(baseA, 'com.example.b'));
      expect(await storeB.read(), isNull);
      expect(backend, hasLength(1));
    });

    test('默认仓库同样按服务身份隔离', () async {
      final storeA = createDefaultTokenStore(configA());
      await storeA.write('token-default-a');
      expect(await createDefaultTokenStore(configB()).read(), isNull,
          reason: '默认仓库（原生）也必须按服务身份隔离');
      expect(await createDefaultTokenStore(configA()).read(), 'token-default-a');
    });
  });
}
