import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart'
    show FlutterError, FlutterErrorDetails, FlutterExceptionHandler;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('FeedbackDiagnosticsRecorder', () {
    test('白名单字段：只记录 time/level/event/code/status/durationMs/pageLabel',
        () {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      r.record(event: 'api_request', code: 'ok', status: 200, durationMs: 12);
      r.record(
          level: 'warn', event: 'auth_session', code: 'unauthorized',
          status: 401, pageLabel: 'home');
      final List<FeedbackLogFile> files = r.provide();
      expect(files.length, 1);
      expect(files.first.filename, 'feedback-diagnostics.jsonl');
      final List<String> lines =
          utf8.decode(files.first.bytes).trim().split('\n');
      expect(lines.length, 2);
      final Map<String, Object?> e0 =
          jsonDecode(lines[0]) as Map<String, Object?>;
      expect(e0['event'], 'api_request');
      expect(e0['status'], 200);
      expect(e0['durationMs'], 12);
      expect(e0.containsKey('time'), isTrue);
      expect(e0.containsKey('level'), isTrue);
      // 白名单之外无其他字段。
      const Set<String> whitelist = <String>{
        'time', 'level', 'event', 'code', 'status', 'durationMs',
        'pageLabel',
      };
      expect(e0.keys.every(whitelist.contains), isTrue);
      expect(e0['level'], 'info');
      final Map<String, Object?> e1 =
          jsonDecode(lines[1]) as Map<String, Object?>;
      expect(e1['level'], 'warn');
      expect(e1['pageLabel'], 'home');
    });

    test('非法字段整条拒绝（level/event/status 越界）', () {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      r.record(level: 'verbose', event: 'ok_event'); // level 非法
      r.record(event: 'bad event!', status: 200); // event 非法
      r.record(event: 'ok_event', status: 99); // status 非法
      r.record(event: 'ok_event', status: 600);
      r.record(event: 'ok_event', durationMs: -1);
      expect(r.provide(), isEmpty);
    });

    test('容量：超过 200 条丢最旧', () {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      for (int i = 0; i < 260; i++) {
        r.record(event: 'api_request', status: 200, code: 'ok');
      }
      expect(r.length, 200);
    });

    test('世代：clear 递增世代并拒绝旧世代写入', () {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      final int g0 = r.generation;
      r.record(event: 'api_request', generation: g0);
      expect(r.length, 1);
      r.clear();
      expect(r.length, 0);
      expect(r.generation, greaterThan(g0));
      // 旧世代迟到写入被丢弃。
      r.record(event: 'api_request', generation: g0);
      expect(r.length, 0);
      // 不携带世代：当前世代照常记录。
      r.record(event: 'api_request');
      expect(r.length, 1);
    });

    test('空缓冲 provide 返回空列表', () {
      expect(FeedbackDiagnosticsRecorder().provide(), isEmpty);
    });
  });

  group('FeedbackHttpClient', () {
    test('记录请求（状态码 + 耗时），响应原样返回', () async {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      final http.Client inner = MockClient((http.BaseRequest req) async {
        return http.Response('ok', 200);
      });
      final FeedbackHttpClient client =
          FeedbackHttpClient(inner, r, pageLabel: 'demo');
      final http.Response resp =
          await client.get(Uri.parse('https://svc.test/api/features?x=1'));
      expect(resp.statusCode, 200);
      expect(resp.body, 'ok');
      final List<FeedbackLogFile> files = r.provide();
      expect(files.length, 1);
      final Map<String, Object?> e =
          jsonDecode(utf8.decode(files.first.bytes).trim())
              as Map<String, Object?>;
      expect(e['event'], 'http.get_api_features');
      expect(e['status'], 200);
      expect(e['pageLabel'], 'demo');
      client.close();
    });

    test('网络异常记录 error 且原样抛出（不吞宿主错误）', () async {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      final http.Client inner = MockClient((http.BaseRequest req) async {
        throw http.ClientException('boom');
      });
      final FeedbackHttpClient client = FeedbackHttpClient(inner, r);
      await expectLater(client.get(Uri.parse('https://svc.test/x')),
          throwsA(isA<http.ClientException>()));
      final List<FeedbackLogFile> files = r.provide();
      expect(files.length, 1);
      final Map<String, Object?> e =
          jsonDecode(utf8.decode(files.first.bytes).trim())
              as Map<String, Object?>;
      expect(e['level'], 'error');
      expect(e['code'], 'network');
      client.close();
    });
  });

  group('FeedbackExceptionCapture', () {
    testWidgets('记录异常事件并保留宿主原处理；uninstall 恢复', (tester) async {
      final FeedbackDiagnosticsRecorder r = FeedbackDiagnosticsRecorder();
      bool hostCalled = false;
      final FlutterExceptionHandler? previous = FlutterError.onError;
      FlutterError.onError = (FlutterErrorDetails details) {
        hostCalled = true;
      };
      try {
        final FeedbackExceptionCapture cap =
            FeedbackExceptionCapture.install(r);
        expect(cap.installed, isTrue);
        FlutterError.onError?.call(FlutterErrorDetails(
          exception: StateError('x'),
          library: 'test',
        ));
        expect(hostCalled, isTrue); // 宿主处理保留
        expect(r.length, 1);
        cap.uninstall();
        expect(cap.installed, isFalse);
        cap.uninstall(); // 幂等
      } finally {
        FlutterError.onError = previous;
      }
    });
  });
}
