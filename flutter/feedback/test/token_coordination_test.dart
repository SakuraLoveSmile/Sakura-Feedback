import 'dart:async';

import 'package:feedback_widget/src/config.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:feedback_widget/src/token_coordination.dart';
import 'package:feedback_widget/src/token_store.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// 可控延迟的仓库：用 Completer 控制各操作完成时机，验证队列串行性。
class GatedTokenStore implements FeedbackTokenStore {
  GatedTokenStore([this._token]);

  String? _token;
  final List<String> ops = <String>[];
  final Map<String, Completer<void>> gates = <String, Completer<void>>{};

  /// 挂起下一次 [method] 调用，直到 [release] 被调用。
  void gate(String method) => gates[method] = Completer<void>();

  void release(String method) => gates.remove(method)?.complete();

  @override
  Future<String?> read() async {
    ops.add('read');
    if (gates.containsKey('read')) await gates['read']!.future;
    return _token;
  }

  @override
  Future<void> write(String token) async {
    ops.add('write');
    if (gates.containsKey('write')) await gates['write']!.future;
    _token = token;
  }

  @override
  Future<void> clear() async {
    ops.add('clear');
    if (gates.containsKey('clear')) await gates['clear']!.future;
    _token = null;
  }
}

FeedbackConfig config(String apiBase) =>
    FeedbackConfig(apiBase, 'com.example.app');

void main() {
  group('CoordinatedTokenStore 认证世代与条件清除（T1-A）', () {
    test('write 成功后递增认证世代；世代不符的 401 不清除新令牌', () async {
      final store = CoordinatedTokenStore.of(MemoryTokenStore('tok-old'));
      final lease = await store.lease();
      expect(lease.token, 'tok-old');

      await store.write('tok-new'); // 新登录保存
      final cleared = await store.clearIfCurrent(lease); // 旧请求迟到 401

      expect(cleared, isFalse);
      expect(await store.read(), 'tok-new'); // 新令牌保留
    });

    test('世代未变且令牌未换：401 条件清除生效', () async {
      final store = CoordinatedTokenStore.of(MemoryTokenStore('tok'));
      final lease = await store.lease();
      expect(await store.clearIfCurrent(lease), isTrue);
      expect(await store.read(), isNull);
    });

    test('令牌被绕过协调器直接更换时：令牌值比对兜底，不误删', () async {
      final inner = MemoryTokenStore('tok-old');
      final store = CoordinatedTokenStore.of(inner);
      final lease = await store.lease();
      // 模拟另一实例 / 直写：协调器世代未变，但底层令牌已换。
      await inner.write('tok-new');
      expect(await store.clearIfCurrent(lease), isFalse);
      expect(await store.read(), 'tok-new');
    });

    test('队列串行：清除排在挂起的写入之后，看到新世代后不动新凭据', () async {
      final inner = GatedTokenStore('tok-old');
      final store = CoordinatedTokenStore.of(inner);
      final lease = await store.lease();
      expect(lease.token, 'tok-old');

      // 登录写入先入队但被挂起；401 条件清除随后入队。
      inner.gate('write');
      final Future<void> writing = store.write('tok-new');
      final Future<bool> clearing = store.clearIfCurrent(lease);
      await Future<void>.delayed(Duration.zero);
      expect(inner.ops, <String>['read', 'write']); // 清除尚未执行

      inner.release('write');
      await writing;
      expect(await clearing, isFalse); // 写入完成后才轮到清除：世代已变
      expect(await store.read(), 'tok-new');
      // 世代不符时短路返回：没有第二次底层读取，也没有底层清除。
      expect(inner.ops, <String>['read', 'write', 'read']);
    });

    test('of() 幂等：同一仓库永远返回同一协调器', () {
      final inner = MemoryTokenStore();
      expect(identical(CoordinatedTokenStore.of(inner),
          CoordinatedTokenStore.of(inner)), isTrue);
    });

    test('默认安全存储：相同服务身份共享协调状态（跨实例保护）', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final configA = config('https://svc-a.test');
      // 同一服务身份的两个仓库实例（如面板重建 / 多组件挂载）。
      final innerA = SecureFeedbackTokenStore(config: configA);
      final innerA2 = SecureFeedbackTokenStore(config: configA);
      final storeA = CoordinatedTokenStore.of(innerA);
      final storeA2 = CoordinatedTokenStore.of(innerA2);

      expect(identical(storeA, storeA2), isTrue,
          reason: '相同 storageKey 的仓库必须共享同一协调器');

      // 经实例 A 发出请求并捕获世代；经实例 B 保存新登录 → 世代共享递增，
      // 实例 A 的旧请求 401 不得清除新令牌。
      final lease = await storeA.lease();
      await storeA2.write('tok-new');
      expect(await storeA.clearIfCurrent(lease), isFalse);
      expect(await storeA.read(), 'tok-new');
    });

    test('不同服务身份使用不同协调器', () {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final a = CoordinatedTokenStore.of(
          SecureFeedbackTokenStore(config: config('https://svc-a.test')));
      final b = CoordinatedTokenStore.of(
          SecureFeedbackTokenStore(config: config('https://svc-b.test')));
      expect(identical(a, b), isFalse);
    });

    test('存储写入失败向上抛出且不递增世代、不破坏队列', () async {
      final inner = _ThrowingWriteStore();
      final store = CoordinatedTokenStore.of(inner);
      await expectLater(store.write('x'), throwsA(isA<PlatformException>()));
      // 队列仍然可用；世代未变 → 请求仍可正常条件清除。
      final lease = await store.lease();
      expect(lease.token, isNull);
      expect(await store.clearIfCurrent(lease), isTrue);
    });
  });
}

class _ThrowingWriteStore implements FeedbackTokenStore {
  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async {
    throw PlatformException(code: 'ss_write_failed');
  }

  @override
  Future<void> clear() async {
    _token = null;
  }
}
