import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'panel_harness.dart';

const String _time = '2026-10-13T01:00:00Z';
const String _title = '手机上打开设置后反复闪退并且返回首页后输入的长篇内容全部消失，需要完整保留这个问题标题';

Map<String, Object?> _item(String id,
        {String status = 'open', String? sender}) =>
    {
      'id': id,
      'appId': 'com.example.app',
      'title': id == 'a' ? _title : '问题 $id',
      'text': '初次提交的说明',
      'status': 'archived',
      'issueStatus': status,
      'createdAt': _time,
      'lastActivityAt': _time,
      'messageCount': 3,
      'unread': true,
      if (sender != null)
        'latestMessage': {
          'senderType': sender,
          'text': '最新动态',
          'createdAt': _time
        },
    };

Map<String, Object?> _dialogue(String id,
        {String status = 'open',
        List<Map<String, Object?>> messages = const []}) =>
    {
      'feedback': {
        ..._item(id, status: status),
        'updatedAt': _time,
        'mgmtState': 'inbox'
      },
      'messages': messages,
      'lastReadSeq': 100,
    };

Map<String, Object?> _message(int seq,
        {String sender = 'admin', String? note}) =>
    {
      'id': 'm$seq',
      'seq': seq,
      'senderType': sender,
      'senderName': sender == 'admin' ? '支持人员' : '',
      'senderId': 'u',
      'text': '第 $seq 条动态',
      'createdAt': _time,
      'attachments': <Object?>[],
      if (note != null) 'resolutionNote': note,
    };

PanelServer _server(
    {bool dialogue = true,
    bool defaultDialogue = true,
    bool advertiseCapabilities = true}) {
  final PanelServer server = PanelServer();
  server.respond('GET /api/auth/session', {
    ...sessionJson(quotaJson()),
    if (advertiseCapabilities)
      'capabilities': {'dialogue': dialogue, 'images': 5}
  });
  server.respond('GET /api/feedback/unread-summary',
      {'unreadFeedbacksCount': 1, 'totalUnreadMessages': 3});
  server.respond('GET /api/feedback/mine', {
    'items': [_item('a', sender: 'system'), _item('b')],
    'total': 2,
    'page': 1,
    'limit': 10,
    'unreadTotal': 3
  });
  if (defaultDialogue) {
    server.respond('GET /api/feedback/a/dialogue', _dialogue('a'));
  }
  server.respond('GET /api/feedback/b/dialogue', _dialogue('b'));
  return server;
}

Future<void> _history(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('tab-history')));
  await tester.pumpAndSettle();
}

Future<void> _open(WidgetTester tester, [String id = 'a']) async {
  await tester.tap(find.byKey(Key('feedback-item-$id')));
  await tester.pumpAndSettle();
}

Future<void> _reply(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(const Key('feedback-jump-reply')));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.byKey(const Key('feedback-reply-input')));
  await tester.enterText(find.byKey(const Key('feedback-reply-input')), text);
  await tester.pumpAndSettle();
}

String _draft(WidgetTester tester) => tester
    .widget<TextField>(find.byKey(const Key('feedback-reply-input')))
    .controller!
    .text;

void main() {
  testWidgets('提交已保存后可直接查看原问题，归档不等于解决', (tester) async {
    final PanelServer server = _server();
    server.respond(
        'POST /api/feedback', {'feedbackId': 'a', 'status': 'archived'}, 201);
    await pumpPanel(tester,
        server: server,
        tokenStore: RecordingTokenStore('token'),
        surface: const Size(390, 720));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('feedback-input')), '提交说明');
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('feedback-submit')));
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pumpAndSettle();
    expect(find.textContaining('归档不代表问题已解决'), findsOneWidget);
    expect(find.text('反馈 ID：a'), findsOneWidget);
    expect(find.byKey(const Key('feedback-dialogue-id')), findsNothing);
    await tester.tap(find.byKey(const Key('feedback-view-progress')));
    await tester.pumpAndSettle();
    expect(find.text('#a'), findsOneWidget);
    expect(find.text('待处理'), findsOneWidget);
    expect(server.count('POST /api/feedback'), 1);
    await teardownPanel(tester);
  });

  testWidgets('旧服务不支持对话时保留提交回执与归档入口', (tester) async {
    final PanelServer server = _server(dialogue: false);
    server.respond(
        'POST /api/feedback', {'feedbackId': 'a', 'status': 'archived'}, 201);
    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('token'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('feedback-input')), '提交说明');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pumpAndSettle();
    expect(find.text('反馈 ID：a'), findsOneWidget);
    expect(find.byKey(const Key('feedback-view-progress')), findsNothing);
    expect(find.byKey(const Key('feedback-continue')), findsOneWidget);
    await teardownPanel(tester);
  });

  testWidgets('旧服务能力缺失时不增加不可用的进展入口', (tester) async {
    final PanelServer server = _server(advertiseCapabilities: false);
    server.respond(
        'POST /api/feedback', {'feedbackId': 'a', 'status': 'archived'}, 201);
    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('token'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('feedback-input')), '提交说明');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pumpAndSettle();
    expect(find.text('反馈 ID：a'), findsOneWidget);
    expect(find.byKey(const Key('feedback-view-progress')), findsNothing);
    expect(find.byKey(const Key('feedback-continue')), findsOneWidget);
    await teardownPanel(tester);
  });

  testWidgets('历史完整标题、动态计数、系统角色与刷新可达', (tester) async {
    final PanelServer server = _server();
    await pumpPanel(tester,
        server: server,
        tokenStore: RecordingTokenStore('token'),
        surface: const Size(390, 720));
    await tester.pumpAndSettle();
    await _history(tester);
    final Text title = tester.widget<Text>(find.text(_title));
    expect(title.maxLines, isNull);
    expect(find.text('系统: 最新动态'), findsOneWidget);
    expect(find.text('3 条动态'), findsNWidgets(2));
    expect(find.textContaining('最近更新：'), findsNWidgets(2));
    await tester.tap(find.byKey(const Key('feedback-history-refresh')));
    await tester.pumpAndSettle();
    expect(server.count('GET /api/feedback/mine'), 2);
    await teardownPanel(tester);
  });

  testWidgets('详情使用真实消息处理说明，已解决仍可继续同一问题', (tester) async {
    final PanelServer server = _server(defaultDialogue: false);
    bool replied = false;
    server.on(
        'GET /api/feedback/a/dialogue',
        (_) async => jsonResponse(_dialogue('a',
                status: replied ? 'waiting_admin' : 'resolved',
                messages: [
                  _message(1, sender: 'system', note: '旧说明'),
                  _message(2, note: '修复已发布'),
                ])));
    server.on('POST /api/feedback/a/messages', (_) async {
      replied = true;
      return jsonResponse({
        'ok': true,
        'message': _message(3, sender: 'user'),
        'issueStatus': 'waiting_admin',
        'dialogueVersion': 2
      }, 201);
    });
    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('token'));
    await tester.pumpAndSettle();
    await _history(tester);
    await _open(tester);
    expect(find.text(_title), findsOneWidget);
    expect(find.text('已解决'), findsOneWidget);
    expect(find.textContaining('仍有问题可继续补充'), findsOneWidget);
    expect(find.text('最近处理说明：修复已发布'), findsOneWidget);
    await _reply(tester, '仍会复现');
    await tester.ensureVisible(find.byKey(const Key('feedback-reply-send')));
    await tester.tap(find.byKey(const Key('feedback-reply-send')));
    await tester.pumpAndSettle();
    expect(server.count('POST /api/feedback/a/messages'), 1);
    expect(server.count('POST /api/feedback'), 0);
    await tester.drag(
        find.byKey(const Key('feedback-dialogue-list')), const Offset(0, 1000));
    await tester.pumpAndSettle();
    expect(find.text('待管理员回复'), findsOneWidget);
    await teardownPanel(tester);
  });

  testWidgets('返回列表恢复文字和日志草稿，轮询不清草稿或跳动位置', (tester) async {
    final PanelServer server = _server();
    final FeedbackConfig config =
        FeedbackConfig('https://svc.test', 'com.example.app',
            imagePicker: () async => [
                  FeedbackImageFile(
                      id: 'draft-image',
                      filename: 'draft.png',
                      mime: 'image/png',
                      source: 'manual',
                      bytes: base64Decode(
                          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
                ],
            filePicker: () async => [
                  FeedbackLogFile(
                      filename: 'draft.log',
                      bytes: Uint8List.fromList([65]),
                      source: 'manual'),
                ]);
    await pumpPanel(tester,
        server: server,
        tokenStore: RecordingTokenStore('token'),
        config: config,
        surface: const Size(390, 720));
    await tester.pumpAndSettle();
    await _history(tester);
    await _open(tester);
    await _reply(tester, '没有发出的补充');
    await tester.ensureVisible(find.byKey(const Key('reply-attach-image')));
    await tester.tap(find.byKey(const Key('reply-attach-image')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('reply-attach-log')));
    await tester.tap(find.byKey(const Key('reply-attach-log')));
    await tester.pumpAndSettle();
    final ScrollableState scroll = tester.state<ScrollableState>(find
        .descendant(
            of: find.byKey(const Key('feedback-dialogue-list')),
            matching: find.byType(Scrollable))
        .first);
    final double offset = scroll.position.pixels;
    await tester.pump(const Duration(seconds: 10));
    await tester.pumpAndSettle();
    expect(_draft(tester), '没有发出的补充');
    expect(scroll.position.pixels, closeTo(offset, 0.5));
    expect(find.text('draft.log'), findsOneWidget);
    expect(find.byKey(const Key('reply-image-thumb-0')), findsOneWidget);
    await tester.tap(find.byKey(const Key('feedback-dialogue-back')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-compose')));
    await tester.pumpAndSettle();
    await _history(tester);
    await _open(tester);
    await tester.tap(find.byKey(const Key('feedback-jump-reply')));
    await tester.pumpAndSettle();
    expect(_draft(tester), '没有发出的补充');
    expect(find.text('draft.log'), findsOneWidget);
    expect(find.byKey(const Key('reply-image-thumb-0')), findsOneWidget);
    expect(server.count('POST /api/feedback/a/messages'), 0);
    await teardownPanel(tester);
  });

  testWidgets('发送锁定防双击，离开后的迟到失败不改写另一问题草稿', (tester) async {
    final PanelServer server = _server();
    final Completer<http.Response> pending = Completer<http.Response>();
    int attempts = 0;
    server.on(
        'POST /api/feedback/a/messages',
        (_) => ++attempts == 1
            ? pending.future
            : Future.value(jsonResponse({
                'ok': true,
                'message': _message(1, sender: 'user'),
                'issueStatus': 'waiting_admin'
              }, 201)));
    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('token'));
    await tester.pumpAndSettle();
    await _history(tester);
    await _open(tester);
    await _reply(tester, '原问题补充');
    await tester.tap(find.byKey(const Key('feedback-reply-send')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-reply-send')));
    await tester.pump();
    expect(server.count('POST /api/feedback/a/messages'), 1);
    await tester.tap(find.byKey(const Key('feedback-dialogue-back')));
    await tester.pumpAndSettle();
    await _open(tester, 'b');
    await _reply(tester, '新问题草稿');
    pending.complete(jsonResponse({
      'error': {'code': 'failure', 'message': '原问题发送失败'}
    }, 500));
    await tester.pumpAndSettle();
    expect(_draft(tester), '新问题草稿');
    expect(find.byKey(const Key('feedback-reply-error')), findsNothing);
    await tester.tap(find.byKey(const Key('feedback-dialogue-back')));
    await tester.pumpAndSettle();
    await _open(tester);
    await tester.tap(find.byKey(const Key('feedback-jump-reply')));
    await tester.pumpAndSettle();
    expect(_draft(tester), '原问题补充');
    expect(find.byKey(const Key('feedback-reply-error')), findsOneWidget);
    expect(
        tester
            .widget<IconButton>(find.byKey(const Key('feedback-reply-send')))
            .onPressed,
        isNotNull);
    await tester.ensureVisible(find.byKey(const Key('feedback-reply-send')));
    await tester.tap(find.byKey(const Key('feedback-reply-send')));
    await tester.pumpAndSettle();
    expect(server.count('POST /api/feedback/a/messages'), 2);
    expect(_draft(tester), isEmpty);
    await teardownPanel(tester);
  });

  testWidgets('切换服务后迟到详情不会进入新身份', (tester) async {
    final PanelServer server = _server(defaultDialogue: false);
    final Completer<http.Response> pending = Completer<http.Response>();
    server.on('GET /api/feedback/a/dialogue', (_) => pending.future);
    final RecordingTokenStore token = RecordingTokenStore('token');
    await pumpPanel(tester, server: server, tokenStore: token);
    await tester.pumpAndSettle();
    await _history(tester);
    await tester.tap(find.byKey(const Key('feedback-item-a')));
    await tester.pump();
    await pumpPanel(tester,
        server: server,
        tokenStore: token,
        config: FeedbackConfig('https://other.test', 'other.app'));
    await tester.pumpAndSettle();
    pending.complete(jsonResponse(_dialogue('a')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('feedback-dialogue-title')), findsNothing);
    expect(find.byKey(const Key('feedback-dialogue-back')), findsNothing);
    expect(tester.takeException(), isNull);
    await teardownPanel(tester);
  });

  testWidgets('12秒详情请求跨过轮询间隔仍可显示，完成后下一轮可更新', (tester) async {
    final PanelServer server = _server(defaultDialogue: false);
    final Completer<http.Response> pending = Completer<http.Response>();
    server.on('GET /api/feedback/a/dialogue', (_) => pending.future);
    server.respond(
        'GET /api/feedback/a/dialogue', _dialogue('a', status: 'waiting_user'));
    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore('token'));
    await tester.pumpAndSettle();
    await _history(tester);
    await tester.tap(find.byKey(const Key('feedback-item-a')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    await tester.pump();
    expect(server.count('GET /api/feedback/a/dialogue'), 1);
    await tester.pump(const Duration(seconds: 2));
    pending.complete(jsonResponse(_dialogue('a')));
    await tester.pumpAndSettle();
    expect(find.text(_title), findsOneWidget);
    await tester.pump(const Duration(seconds: 8));
    await tester.pumpAndSettle();
    expect(server.count('GET /api/feedback/a/dialogue'), 2);
    expect(find.text('待补充'), findsOneWidget);
    await teardownPanel(tester);
  });

  testWidgets('手机高键盘下长时间线补充输入和发送可滚达', (tester) async {
    final PanelServer server = _server(defaultDialogue: false);
    server.on(
        'GET /api/feedback/a/dialogue',
        (_) async => jsonResponse(_dialogue('a',
            messages: List.generate(12, (i) => _message(i + 1)))));
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 720);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            resizeToAvoidBottomInset: false,
            body: FeedbackWidget(
              config: FeedbackConfig('https://svc.test', 'com.example.app'),
              controller: controller,
              tokenStore: RecordingTokenStore('token'),
              serverPrefStore: MemoryServerPrefStore(),
              httpClient: server.client,
              child: const Placeholder(),
            ))));
    await tester.pumpAndSettle();
    controller.open();
    await tester.pumpAndSettle();
    await _history(tester);
    await _open(tester);
    await _reply(tester, '键盘下不丢的补充');
    tester.view.viewInsets = const FakeViewPadding(bottom: 460);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('feedback-reply-send')));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(const Key('feedback-reply-send'))).bottom,
        lessThanOrEqualTo(260.5));
    expect(_draft(tester), '键盘下不丢的补充');
    expect(tester.takeException(), isNull);
    await teardownPanel(tester);
  });
  testWidgets('中文系统语言且位于 MaterialApp 外侧时可撰写并追踪反馈', (tester) async {
    final PanelServer server = _server();
    server.respond(
        'POST /api/feedback', {'feedbackId': 'a', 'status': 'archived'}, 201);
    tester.binding.platformDispatcher.localeTestValue =
        const Locale('zh', 'CN');
    addTearDown(tester.binding.platformDispatcher.clearLocaleTestValue);
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(390, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(FeedbackWidget(
      config: FeedbackConfig('https://svc.test', 'com.example.app',
          captureMode: FeedbackCaptureMode.off),
      controller: controller,
      tokenStore: RecordingTokenStore('token'),
      serverPrefStore: MemoryServerPrefStore(),
      httpClient: server.client,
      child: const MaterialApp(home: Scaffold(body: Text('中文宿主'))),
    ));
    await tester.pumpAndSettle();
    controller.open();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('feedback-input')), '中文宿主上的问题说明');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('feedback-view-progress')));
    await tester.pumpAndSettle();
    expect(find.text('#a'), findsOneWidget);
    await _reply(tester, '中文补充草稿');
    expect(_draft(tester), '中文补充草稿');
    expect(tester.takeException(), isNull);
    await teardownPanel(tester);
  });
}
