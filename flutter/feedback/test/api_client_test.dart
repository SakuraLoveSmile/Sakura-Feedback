import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 返回 UTF-8 字节响应（`http.Response(String)` 对非 Latin-1 文本会抛错）。
http.Response jsonResponse(Object body, [int status = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: const <String, String>{'content-type': 'application/json'},
    );

void main() {
  FeedbackConfig buildConfig({String? version, String? page}) => FeedbackConfig(
        'https://fb.example.com',
        'com.example.app',
        appVersion: version,
        pageLabel: page,
      );

  group('idempotency key', () {
    test('RFC-4122 v4 形态且唯一', () {
      final keys = List.generate(50, (_) => generateFeedbackIdempotencyKey());
      final pattern = RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
      for (final key in keys) {
        expect(pattern.hasMatch(key), isTrue, reason: key);
        expect(key.length, lessThanOrEqualTo(200));
      }
      expect(keys.toSet().length, keys.length);
    });
  });

  group('ApiClient', () {
    test('submit 发送正确的体、头与显式 context', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return jsonResponse({'feedbackId': 'f1', 'status': 'received'}, 201);
      });
      final store = MemoryTokenStore('tok-1');
      final api = ApiClient(
          config: buildConfig(version: '1.2.3'),
          tokenStore: store,
          httpClient: client);

      final result =
          await api.submitFeedback(idempotencyKey: 'k1', text: '你好');

      expect(result.feedbackId, 'f1');
      expect(result.status, 'received');
      expect(captured.url.toString(), 'https://fb.example.com/api/feedback');
      expect(captured.method, 'POST');
      expect(captured.headers['content-type'], contains('application/json'));
      expect(captured.headers['authorization'], 'Bearer tok-1');
      final body = jsonDecode(captured.body) as Map<String, Object?>;
      expect(body['idempotencyKey'], 'k1');
      expect(body['appId'], 'com.example.app');
      expect(body['text'], '你好');
      expect(body['context'], <String, Object?>{'appVersion': '1.2.3'});
      api.dispose();
    });

    test('未显式配置 context 时不携带 context 键', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return jsonResponse({'feedbackId': 'f1', 'status': 'received'}, 201);
      });
      final api = ApiClient(
          config: buildConfig(),
          tokenStore: MemoryTokenStore('t'),
          httpClient: client);
      await api.submitFeedback(idempotencyKey: 'k', text: 'x');
      final body = jsonDecode(captured.body) as Map<String, Object?>;
      expect(body.containsKey('context'), isFalse);
      api.dispose();
    });

    test('幂等重放 200 replayed:true', () async {
      final client = MockClient((request) async => jsonResponse({
            'feedbackId': 'f9',
            'status': 'processing',
            'replayed': true
          }));
      final api = ApiClient(
          config: buildConfig(),
          tokenStore: MemoryTokenStore('t'),
          httpClient: client);
      final r = await api.submitFeedback(idempotencyKey: 'k', text: 'x');
      expect(r.replayed, isTrue);
      expect(r.feedbackId, 'f9');
      api.dispose();
    });

    test('submit 401 清除令牌并触发 onUnauthorized', () async {
      var unauthorizedCalls = 0;
      final store = MemoryTokenStore('tok');
      final client = MockClient((request) async => jsonResponse(
          {
            'error': {'code': 'unauthorized', 'message': '令牌无效'}
          },
          401));
      final api = ApiClient(
        config: buildConfig(),
        tokenStore: store,
        httpClient: client,
        onUnauthorized: () => unauthorizedCalls++,
      );
      await expectLater(
        api.submitFeedback(idempotencyKey: 'k', text: 'x'),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'statusCode', 401)),
      );
      expect(await store.read(), isNull);
      expect(unauthorizedCalls, 1);
      api.dispose();
    });

    test('login 401 不触发 onUnauthorized（凭据错误）', () async {
      var unauthorizedCalls = 0;
      final client = MockClient((request) async => jsonResponse(
          {
            'error': {'code': 'invalid_credentials', 'message': '用户名或密码错误'}
          },
          401));
      final api = ApiClient(
        config: buildConfig(),
        tokenStore: MemoryTokenStore(),
        httpClient: client,
        onUnauthorized: () => unauthorizedCalls++,
      );
      await expectLater(
        api.login(username: 'u', password: 'p', clientLabel: 'flutter-test'),
        throwsA(isA<ApiException>()
            .having((e) => e.code, 'code', 'invalid_credentials')),
      );
      expect(unauthorizedCalls, 0);
      api.dispose();
    });

    test('login 返回并解析长期令牌', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return jsonResponse({
          'ok': true,
          'token': 'long-lived',
          'expiresAt': '2030-01-01T00:00:00Z'
        });
      });
      final api = ApiClient(
          config: buildConfig(),
          tokenStore: MemoryTokenStore(),
          httpClient: client);
      final r = await api.login(
          username: 'u', password: 'p', clientLabel: 'flutter-macos-x');
      expect(r.token, 'long-lived');
      expect(r.expiresAt, isNotNull);
      final body = jsonDecode(captured.body) as Map<String, Object?>;
      expect(body['clientLabel'], 'flutter-macos-x');
      expect(body['username'], 'u');
      expect(body['password'], 'p');
      api.dispose();
    });

    test('fetchFeedback 解析状态与归档链接', () async {
      final client = MockClient((request) async => jsonResponse({
            'id': 'f1',
            'status': 'archived',
            'createdAt': '2026-01-01T00:00:00Z',
            'updatedAt': '2026-01-02T00:00:00Z',
            'errorSummary': null,
            'kaneoUrl': 'https://kaneo.example/t/123',
          }));
      final api = ApiClient(
          config: buildConfig(),
          tokenStore: MemoryTokenStore('t'),
          httpClient: client);
      final rec = await api.fetchFeedback('f1');
      expect(rec.status, 'archived');
      expect(rec.kaneoUrl, 'https://kaneo.example/t/123');
      api.dispose();
    });

    test('submitFeedback 携带截图与元数据时发送 multipart 请求', () async {
      late http.BaseRequest captured;
      final client = MockClient((request) async {
        captured = request;
        return jsonResponse({'feedbackId': 'f-multi', 'status': 'received'}, 201);
      });
      final store = MemoryTokenStore('tok-multi');
      final api = ApiClient(
        config: buildConfig(),
        tokenStore: store,
        httpClient: client,
      );

      final screenshot = Uint8List.fromList([1, 2, 3, 4]);
      final captureInfo = FeedbackCaptureInfo(
        viewportWidth: 1080,
        viewportHeight: 1920,
        releasePoint: const Offset(0.5, 0.75),
      );

      final result = await api.submitFeedback(
        idempotencyKey: 'multi-k',
        text: '界面卡顿',
        screenshotBytes: screenshot,
        captureInfo: captureInfo,
      );

      expect(result.feedbackId, 'f-multi');
      expect(captured.url.path, '/api/feedback');
      api.dispose();
    });

    test('FeedbackConfig 去除末尾斜杠', () {
      final c = FeedbackConfig('https://x.dev/', 'app');
      expect(c.apiBase, 'https://x.dev');
    });
  });
}
