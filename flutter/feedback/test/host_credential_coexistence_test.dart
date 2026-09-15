import 'package:feedback_widget/src/config.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// 宿主凭据共存：Feedback 的令牌与宿主**其它**凭据共用同一个平台安全存储
/// （Android EncryptedSharedPreferences / iOS·macOS Keychain）。
///
/// 场景来源：宿主应用（例如音乐客户端）本来就在同一个安全存储里保存自己的
/// 凭据——音乐服务器的密码、第三方服务令牌等。Feedback 的登出 / 401 失效清理
/// 只允许删除由 `apiBase` + `appId` 派生出来的那一个键：
/// - 不得 `deleteAll()` / 清库，否则会把宿主的其它凭据一起抹掉；
/// - 不得用固定全局键覆盖宿主的键。
///
/// 这一段由 tools/flutter-storage-matrix 在 flutter_secure_storage 9.2.2 /
/// 10.3.1 / 11.0.0 三档下逐档复跑。
void main() {
  const String apiBase = 'https://feedback.test';

  // 宿主自己的凭据（模拟真实的音乐客户端）：音乐服务器密码 + 第三方令牌。
  const String musicPasswordKey = 'music_subsonic_password';
  const String thirdPartyTokenKey = 'third_party.access_token';

  FeedbackConfig config() => FeedbackConfig(apiBase, 'com.example.musichost');

  late Map<String, String> backend;
  late SecureFeedbackTokenStore store;

  setUp(() {
    backend = <String, String>{
      musicPasswordKey: 'music-server-secret',
      thirdPartyTokenKey: 'third-party-token',
    };
    FlutterSecureStorage.setMockInitialValues(backend);
    store = SecureFeedbackTokenStore(config: config());
  });

  test('Feedback 清理令牌后，宿主的音乐密码与第三方令牌仍可读取', () async {
    await store.write('feedback-token');
    expect(backend, hasLength(3),
        reason: 'Feedback 登录只应新增自己的一格，而不是重建整库');

    await store.clear(); // 登出 / 401 失效清理

    const FlutterSecureStorage storage = FlutterSecureStorage();
    expect(await storage.read(key: musicPasswordKey), 'music-server-secret',
        reason: '清库会误删宿主的音乐服务器密码');
    expect(await storage.read(key: thirdPartyTokenKey), 'third-party-token',
        reason: '清库会误删宿主的第三方令牌');
    expect(await store.read(), isNull, reason: 'Feedback 令牌本身必须已清除');
    expect(
      backend.keys,
      unorderedEquals(<String>[musicPasswordKey, thirdPartyTokenKey]),
      reason: '清理后只剩宿主的凭据，Feedback 槽位不残留',
    );
  });

  test('登出路径重复清理也只影响 Feedback 自己的槽位', () async {
    await store.write('feedback-token');
    // 登出 + 迟到的 401 清理可能连续触发；重复清理必须幂等且不碰其它键。
    await store.clear();
    await store.clear();

    const FlutterSecureStorage storage = FlutterSecureStorage();
    expect(await storage.read(key: musicPasswordKey), 'music-server-secret');
    expect(await storage.read(key: thirdPartyTokenKey), 'third-party-token');
    expect(backend, hasLength(2));
  });

  test('Feedback 写入不覆盖宿主凭据（派生键与宿主键不冲突）', () async {
    final String feedbackKey = store.storageKey;
    expect(feedbackKey, isNot(musicPasswordKey));
    expect(feedbackKey, isNot(thirdPartyTokenKey));
    expect(feedbackKey, startsWith('feedback_widget.bearer_token.'));

    await store.write('feedback-token-a');
    await store.write('feedback-token-b'); // 重新登录覆盖自己的槽位

    const FlutterSecureStorage storage = FlutterSecureStorage();
    expect(await storage.read(key: musicPasswordKey), 'music-server-secret');
    expect(await storage.read(key: thirdPartyTokenKey), 'third-party-token');
    expect(await store.read(), 'feedback-token-b');
  });

  test('默认原生仓库（createDefaultTokenStore）同样不越界清理', () async {
    final store = createDefaultTokenStore(config());
    await store.write('feedback-token');
    await store.clear();

    const FlutterSecureStorage storage = FlutterSecureStorage();
    expect(await storage.read(key: musicPasswordKey), 'music-server-secret');
    expect(await storage.read(key: thirdPartyTokenKey), 'third-party-token');
  });
}
