import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'panel_harness.dart';

/// 用户历史列表条目（未读 / 已读两种形态）。
Map<String, Object?> _item({required bool unread}) => <String, Object?>{
      'id': 'fb-1',
      'appId': 'com.example.app',
      'title': '闪退问题',
      'text': '进入设置界面时闪退',
      'status': 'received',
      'issueStatus': 'open',
      'dialogueVersion': 1,
      'archiveRound': 1,
      'lastActivityAt': '2026-11-02T10:00:00Z',
      'createdAt': '2026-11-02T09:00:00Z',
      'unread': unread,
      'messageCount': 1,
    };

Map<String, Object?> _mine({required int unreadTotal, required bool unread}) =>
    <String, Object?>{
      'items': <Object?>[_item(unread: unread)],
      'total': 1,
      'page': 1,
      'limit': 10,
      'unreadTotal': unreadTotal,
    };

/// 进入「我的反馈」并等待首次列表加载完成。
Future<void> _openHistory(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('tab-history')));
  await tester.pumpAndSettle();
}

Finder get _readAllFinder => find.byKey(const Key('feedback-history-read-all'));

TextButton _readAllButton(WidgetTester tester) =>
    tester.widget<TextButton>(_readAllFinder);

void main() {
  test('markAllRead 发送带 appId 的 POST 并解析 ok/marked 计数', () async {
    late http.Request captured;
    final http.Client client = MockClient((http.Request request) async {
      captured = request;
      return jsonResponse(<String, Object?>{
        'ok': true,
        'markedFeedbacks': 3,
        'markedMessages': 5,
      });
    });
    final ApiClient api = ApiClient(
      config: FeedbackConfig('https://fb.example.com', 'com.example.app'),
      tokenStore: MemoryTokenStore('tok'),
      httpClient: client,
    );
    final MarkAllReadResult result =
        await api.markAllRead(appId: 'com.example.app');
    expect(captured.method, 'POST');
    expect(captured.url.path, '/api/feedback/read-all');
    expect(captured.url.queryParameters['appId'], 'com.example.app');
    expect(captured.headers['authorization'], 'Bearer tok');
    expect(result.ok, isTrue);
    expect(result.markedFeedbacks, 3);
    expect(result.markedMessages, 5);

    // 省略 appId 时不携带查询参数（服务端按会话范围处理）。
    await api.markAllRead();
    expect(captured.url.path, '/api/feedback/read-all');
    expect(captured.url.queryParameters, isEmpty);
    api.dispose();
  });

  testWidgets('一键已读：请求带 appId，成功后提示、清零并刷新列表', (tester) async {
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('GET /api/feedback/unread-summary',
        <String, Object?>{'unreadFeedbacksCount': 1, 'totalUnreadMessages': 2});
    // 第一次列表：1 条未读；一键已读后的刷新：全部已读。
    server.on(
        'GET /api/feedback/mine',
        (http.BaseRequest request) async =>
            jsonResponse(_mine(unreadTotal: 2, unread: true)));
    server.on(
        'GET /api/feedback/mine',
        (http.BaseRequest request) async =>
            jsonResponse(_mine(unreadTotal: 0, unread: false)));
    server.respond('POST /api/feedback/read-all', <String, Object?>{
      'ok': true,
      'markedFeedbacks': 1,
      'markedMessages': 2,
    });

    // 窄屏（390）验证工具栏加入「一键已读」后不溢出，Tab 也不再显示数字角标。
    await pumpPanel(tester,
        server: server,
        tokenStore: RecordingTokenStore('valid-token'),
        surface: const Size(390, 720));
    await tester.pumpAndSettle();
    await _openHistory(tester);
    expect(find.byType(Badge), findsNothing,
        reason: 'v0.8.2：我的反馈 Tab 不再绘制未读数字角标');
    expect(tester.takeException(), isNull);
    expect(find.text('未读'), findsOneWidget);
    expect(find.text('一键已读'), findsOneWidget);
    expect(_readAllButton(tester).onPressed, isNotNull);

    await tester.tap(_readAllFinder);
    await tester.pump();
    expect(_readAllButton(tester).onPressed, isNull, reason: '请求中禁用，防止重复提交');
    await tester.pumpAndSettle();

    expect(server.count('POST /api/feedback/read-all'), 1);
    final Uri request = Uri.parse(
        server.lastMatching('POST /api/feedback/read-all').url.toString());
    expect(request.path, '/api/feedback/read-all');
    expect(request.queryParameters['appId'], 'com.example.app');
    expect(find.text('已全部标记为已读'), findsOneWidget);
    expect(server.count('GET /api/feedback/mine'), 2, reason: '成功后刷新列表');
    expect(find.text('未读'), findsNothing, reason: '行内未读标签随本地清零消失');
    expect(_readAllButton(tester).onPressed, isNull, reason: '无未读时保持禁用');
    await teardownPanel(tester);
  });

  testWidgets('一键已读：无未读时按钮禁用且不发出请求', (tester) async {
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('GET /api/feedback/unread-summary',
        <String, Object?>{'unreadFeedbacksCount': 0, 'totalUnreadMessages': 0});
    server.respond(
        'GET /api/feedback/mine', _mine(unreadTotal: 0, unread: false));

    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('valid-token'));
    await tester.pumpAndSettle();
    await _openHistory(tester);

    expect(find.text('一键已读'), findsOneWidget);
    expect(_readAllButton(tester).onPressed, isNull);
    expect(find.text('未读'), findsNothing);
    await tester.tap(_readAllFinder, warnIfMissed: false);
    await tester.pump();
    expect(server.count('POST /api/feedback/read-all'), 0);
    await teardownPanel(tester);
  });

  testWidgets('一键已读：失败时显示错误、保留未读并恢复可点', (tester) async {
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('GET /api/feedback/unread-summary',
        <String, Object?>{'unreadFeedbacksCount': 1, 'totalUnreadMessages': 1});
    server.respond(
        'GET /api/feedback/mine', _mine(unreadTotal: 1, unread: true));
    server.respond(
        'POST /api/feedback/read-all',
        <String, Object?>{
          'error': <String, Object?>{'code': 'internal', 'message': '服务器开小差'}
        },
        500);

    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('valid-token'));
    await tester.pumpAndSettle();
    await _openHistory(tester);
    expect(_readAllButton(tester).onPressed, isNotNull);

    await tester.tap(_readAllFinder);
    await tester.pumpAndSettle();

    expect(server.count('POST /api/feedback/read-all'), 1);
    // SnackBar 与工具栏下方行内文本都会展示错误。
    expect(find.text('服务器开小差'), findsWidgets);
    expect(find.byKey(const Key('feedback-history-read-all-error')),
        findsOneWidget);
    expect(find.text('一键已读'), findsOneWidget, reason: '失败后工具栏仍可见');
    expect(find.text('未读'), findsOneWidget, reason: '失败不得本地清零');
    expect(_readAllButton(tester).onPressed, isNotNull, reason: '失败后恢复可点');
    expect(server.count('GET /api/feedback/mine'), 1, reason: '失败不触发列表刷新');
    await teardownPanel(tester);
  });
}
