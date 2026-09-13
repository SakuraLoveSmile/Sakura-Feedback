// T1-C1 验收依据自身测试：真实 HTTP 转发观察器与接收判定。
//
// 关键约束（与 VERIFICATION.md 第 10 轮机制表一致）：
// - 底层使用正常客户端，**不伪造响应、不主动提交、不替组件重试**；
// - 读取响应流后必须以**相同状态、头和字节**交还组件；
// - 只记录反馈 POST 的状态 / 反馈 ID / 重放标记，不记录凭据、请求头或正文；
// - 只有 201 + 非空 feedbackId + 非重放才算接收；拒绝 / 重放 / 缺 ID / 超时 /
//   多次提交一律 FAIL。
import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../integration_test/t1c_secure_storage_common.dart';

void main() {
  group('验收宿主配置（阶段测试的入口必须与示例一致）', () {
    testWidgets('runConfig 使用 orb 呼出入口：宿主里能找到 feedback-orb', (WidgetTester tester) async {
      // 回归：launcherMode 默认是 tab，未设成 orb 时阶段测试的
      // `tap(find.byKey(Key('feedback-orb')))` 会命中 0 个组件。
      final FeedbackConfig config = runConfig('http://127.0.0.1:1', 't1c-test');
      expect(config.launcherMode, FeedbackLauncherMode.orb,
          reason: '阶段测试点击 feedback-orb，入口必须是 orb 模式');

      final FeedbackController controller = FeedbackController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(buildHost(controller, config));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const Key('feedback-orb')), findsOneWidget,
          reason: 'orb 入口必须真实渲染，否则阶段 1/2 无法完成登录与提交');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  });

  group('AcceptanceObserver（真实转发观察器）', () {
    test('响应以相同状态、头与字节交还组件', () async {
      final List<int> payload = utf8.encode(jsonEncode(<String, Object?>{
        'feedbackId': 'fb-1',
        'status': 'received',
        'quota': <String, Object?>{'remaining': 1},
      }));
      final MockClient inner = MockClient((http.Request request) async {
        return http.Response.bytes(payload, 201, headers: <String, String>{
          'content-type': 'application/json',
          'x-trace': 'abc',
        });
      });
      final AcceptanceObserver observer = AcceptanceObserver(inner);
      addTearDown(observer.close);

      final http.StreamedResponse res = await observer.send(
        http.Request('POST', Uri.parse('http://127.0.0.1:1/api/feedback')),
      );
      expect(res.statusCode, 201);
      expect(res.headers['content-type'], 'application/json');
      expect(res.headers['x-trace'], 'abc');
      final List<int> body = await res.stream.toBytes();
      expect(body, payload, reason: '字节必须原样交还，不能被观察层改写');
    });

    test('请求原样转发：方法、URL、头与正文都不被观察器修改', () async {
      late http.Request seen;
      final MockClient inner = MockClient((http.Request request) async {
        seen = request;
        return http.Response('{"feedbackId":"fb-9"}', 201);
      });
      final AcceptanceObserver observer = AcceptanceObserver(inner);
      addTearDown(observer.close);

      final http.Request request =
          http.Request('POST', Uri.parse('http://127.0.0.1:1/api/feedback?x=1'))
            ..headers['authorization'] = 'Bearer secret-token'
            ..headers['content-type'] = 'application/json'
            ..body = '{"text":"hello"}';
      await observer.send(request);

      expect(seen.method, 'POST');
      expect(seen.url.toString(), 'http://127.0.0.1:1/api/feedback?x=1');
      expect(seen.headers['authorization'], 'Bearer secret-token');
      expect(seen.body, '{"text":"hello"}');
    });

    test('只记录接收结果，不记录凭据 / 请求头 / 正文', () async {
      final AcceptanceObserver observer = AcceptanceObserver(MockClient(
        (http.Request request) async =>
            http.Response('{"feedbackId":"fb-1"}', 201),
      ));
      addTearDown(observer.close);

      final http.Request request =
          http.Request('POST', Uri.parse('http://127.0.0.1:1/api/feedback'))
            ..headers['authorization'] = 'Bearer super-secret'
            ..body = '{"text":"不应被记录"}';
      await observer.send(request);

      final Map<String, Object?> recorded = observer.submissions.first.toJson();
      expect(recorded.keys.toSet(),
          <String>{'httpStatus', 'feedbackId', 'replayed'});
      final String blob = jsonEncode(recorded);
      expect(blob.contains('super-secret'), isFalse);
      expect(blob.contains('不应被记录'), isFalse);
    });

    test('非反馈 POST 不被记录', () async {
      final AcceptanceObserver observer = AcceptanceObserver(MockClient(
        (http.Request request) async => http.Response('{"ok":true}', 200),
      ));
      addTearDown(observer.close);
      await observer.send(
        http.Request('POST', Uri.parse('http://127.0.0.1:1/api/auth/login')));
      await observer.send(
        http.Request('GET', Uri.parse('http://127.0.0.1:1/api/feedback')));
      expect(observer.submissionCount, 0);
    });
  });

  group('classifyAcceptance（接收判定）', () {
    test('201 + 非空 ID + 非重放 → PASS', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 201, feedbackId: 'fb-1', replayed: false));
      expect(c.verdict, T1cVerdict.pass);
      expect(c.reason, contains('fb-1'));
    });

    test('被拒绝（非 201）→ FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 429, feedbackId: null, replayed: false));
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('429'));
    });

    test('幂等重放 → FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 200, feedbackId: 'fb-1', replayed: true));
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('重放'));
    });

    test('缺少 feedbackId → FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 201, feedbackId: null, replayed: false));
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('feedbackId'));
    });

    test('空 feedbackId → FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 201, feedbackId: '', replayed: false));
      expect(c.verdict, T1cVerdict.fail);
    });

    test('超时 → FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord.timeout(0));
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('超时'));
    });

    test('阶段内多次提交 → FAIL', () {
      final T1cCheck c = classifyAcceptance(const AcceptanceRecord(
        httpStatus: 201, feedbackId: 'fb-1', replayed: false, submissionCount: 2));
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('2 次'));
    });

    test('接收证据的线上形状只含三个字段', () {
      final Map<String, Object?> json = const AcceptanceRecord(
        httpStatus: 201, feedbackId: 'fb-1', replayed: false).toJson();
      expect(json['httpStatus'], 201);
      expect(json['feedbackId'], 'fb-1');
      expect(json['replayed'], false);
    });
  });
}
