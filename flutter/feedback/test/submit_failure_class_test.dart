import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 两类提交失败的区分回归：
/// - Class A（服务端从未收到请求：网络异常 / 超时）：重试必须复用**同一**
///   幂等键与**同一**字节；只有冻结快照变化（改文字 / 换图 / 移图）才换新键。
/// - Class B（服务端已接收但后台处理失败 failed/needs_review）：**绝不**再次
///   POST，只能刷新状态 / 复制反馈 ID / 返回编辑开新反馈。
void main() {
  const input = Key('feedback-input');
  const submit = Key('feedback-submit');

  /// 返回 UTF-8 字节响应（`http.Response(String)` 对非 Latin-1 文本会抛错）。
  http.Response jsonResponse(Object body, [int status = 200]) =>
      http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        status,
        headers: const <String, String>{'content-type': 'application/json'},
      );

  /// 可编程 mock 服务：按 `METHOD path` 匹配响应脚本，并记录全部请求。
  final List<http.Request> requests = <http.Request>[];
  final Map<String, List<Future<http.Response> Function(http.Request)>>
      handlers = <String, List<Future<http.Response> Function(http.Request)>>{};

  setUp(() {
    requests.clear();
    handlers.clear();
  });

  http.Client buildClient() {
    return MockClient((http.Request request) async {
      requests.add(request);
      final String key =
          '${request.method} ${Uri.parse(request.url.toString()).path}';
      final List<Future<http.Response> Function(http.Request)>? queue =
          handlers[key];
      if (queue == null || queue.isEmpty) {
        return jsonResponse({
          'error': {'code': 'not_found', 'message': 'mock 未编排: $key'}
        }, 404);
      }
      final Future<http.Response> Function(http.Request) handler =
          queue.length > 1 ? queue.removeAt(0) : queue.first;
      return handler(request);
    });
  }

  void respond(String key, Object body, [int status = 200]) {
    (handlers[key] ??= <Future<http.Response> Function(http.Request)>[])
        .add((http.Request request) async => jsonResponse(body, status));
  }

  void on(
    String key,
    Future<http.Response> Function(http.Request) handler,
  ) {
    (handlers[key] ??= <Future<http.Response> Function(http.Request)>[])
        .add(handler);
  }

  /// 覆盖某个 key 的响应脚本（丢弃已编排的队列，只保留新响应）。
  void override(
    String key,
    Future<http.Response> Function(http.Request) handler,
  ) {
    handlers.remove(key);
    on(key, handler);
  }

  List<http.Request> postsToFeedback() => requests
      .where((http.Request r) =>
          r.method == 'POST' &&
          Uri.parse(r.url.toString()).path == '/api/feedback')
      .toList();

  List<http.Request> gets() => requests
      .where((http.Request r) => r.method == 'GET')
      .toList();

  /// 剥离 multipart 随机边界后的正文：用于逐字节比较两次提交的载荷
  /// （multipart 边界每次请求都不同，不能直接比较原始 body）。
  String submitPayload(http.Request request) {
    final String contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) return request.body;
    final RegExpMatch? match =
        RegExp(r'boundary=([^;]+)').firstMatch(contentType);
    if (match == null) return request.body;
    return latin1
        .decode(request.bodyBytes)
        .split('--${match.group(1)!}')
        .join('<boundary>');
  }

  /// 提交请求的 metadata（JSON 体，或 multipart 内的 metadata 部分）。
  Map<String, Object?> submitMetadata(http.Request request) {
    final String contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      return jsonDecode(request.body) as Map<String, Object?>;
    }
    final RegExpMatch? match =
        RegExp(r'boundary=([^;]+)').firstMatch(contentType);
    expect(match, isNotNull, reason: 'multipart 请求必须携带 boundary');
    final List<String> parts = latin1
        .decode(request.bodyBytes)
        .split('--${match!.group(1)!}')
        .where((String part) => part.contains('name="metadata"'))
        .toList();
    expect(parts, hasLength(1), reason: 'multipart 必须且仅有一个 metadata 部分');
    final int split = parts.single.indexOf('\r\n\r\n');
    // multipart 正文按字节（latin1）读取以保留二进制片段；metadata 是 UTF-8
    // 编码的 JSON，需先还原字节再按 UTF-8 解码。
    final String raw = parts.single.substring(split + 4).trim();
    return jsonDecode(utf8.decode(latin1.encode(raw)))
        as Map<String, Object?>;
  }

  String idempotencyKeyOf(http.Request request) =>
      submitMetadata(request)['idempotencyKey']! as String;

  Future<FeedbackPanelState> pumpPanel(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: FeedbackPanel(
        config: FeedbackConfig('https://svc.test', 'com.example.app'),
        tokenStore: MemoryTokenStore('bearer-token'),
        httpClient: buildClient(),
      ),
    ));
    await tester.pump(); // _restoreSession 完成
    return tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
  }

  /// 结束测试时卸载面板，避免悬挂轮询 Timer。
  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 30));
  }

  // 合法 1x1 PNG 字节（避免 Image.memory 解码异常），两张图内容不同。
  final Uint8List pngA = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  final Uint8List pngB = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

  testWidgets('Class A：网络异常重试沿用同一幂等键与同一提交字节（含截图）', (tester) async {
    on('POST /api/feedback',
        (http.Request request) async => throw Exception('模拟网络断开'));
    final FeedbackPanelState panel = await pumpPanel(tester);

    panel.setScreenshot(
      pngA,
      const FeedbackCaptureInfo(
        viewportWidth: 800,
        viewportHeight: 600,
        capturedAt: 't-a',
        releasePoint: Offset(0.25, 0.5),
      ),
    );
    await tester.pump();
    await tester.enterText(find.byKey(input), '结果未知的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(find.text('网络异常，提交失败。您的输入已保留，请重试'), findsOneWidget);
    expect(panel.stage, FeedbackStage.notSent,
        reason: 'Class A 必须进入可区分的 notSent 阶段（服务端从未收到请求）');
    expect(find.text('重试提交'), findsOneWidget);
    expect(find.byKey(const Key('feedback-refresh-status')), findsNothing,
        reason: 'Class A 没有 feedbackId，不提供「刷新状态」');

    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    final List<http.Request> posts = postsToFeedback();
    expect(posts, hasLength(2));
    expect(idempotencyKeyOf(posts[1]), idempotencyKeyOf(posts[0]),
        reason: 'Class A：快照未变必须复用同一幂等键');
    expect(submitPayload(posts[1]), submitPayload(posts[0]),
        reason: 'Class A：同 key 必须同字节（正文 + 截图 + 元数据完全一致）');

    await teardown(tester);
  });

  testWidgets('Class A：替换截图后重试必须换新幂等键（同 key 不同字节违反契约）', (tester) async {
    on('POST /api/feedback',
        (http.Request request) async => throw Exception('模拟网络断开'));
    final FeedbackPanelState panel = await pumpPanel(tester);

    panel.setScreenshot(
      pngA,
      const FeedbackCaptureInfo(
        capturedAt: 't-a',
        viewportWidth: 800,
        viewportHeight: 600,
      ),
    );
    await tester.pump();
    await tester.enterText(find.byKey(input), '同文案换了截图');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    final List<http.Request> posts = postsToFeedback();
    final String key1 = idempotencyKeyOf(posts.single);
    final String payload1 = submitPayload(posts.single);

    // 重拍得到新截图：文字未变但字节已变 → 必须换新 key。
    panel.setScreenshot(
      pngB,
      const FeedbackCaptureInfo(
        capturedAt: 't-b',
        viewportWidth: 800,
        viewportHeight: 600,
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    final List<http.Request> after = postsToFeedback();
    expect(after, hasLength(2));
    expect(submitMetadata(after[1])['text'], '同文案换了截图');
    expect(submitPayload(after[1]), isNot(payload1),
        reason: '换图后载荷字节必须变化');
    expect(idempotencyKeyOf(after[1]), isNot(key1),
        reason: 'Class A：新截图属于新快照，必须使用新幂等键');

    await teardown(tester);
  });

  testWidgets('Class A：移除截图后重试必须换新幂等键', (tester) async {
    on('POST /api/feedback',
        (http.Request request) async => throw Exception('模拟网络断开'));
    final FeedbackPanelState panel = await pumpPanel(tester);

    panel.setScreenshot(
      pngA,
      const FeedbackCaptureInfo(
        capturedAt: 't-a',
        viewportWidth: 800,
        viewportHeight: 600,
      ),
    );
    await tester.pump();
    await tester.enterText(find.byKey(input), '带着截图提交');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    final String key1 = idempotencyKeyOf(postsToFeedback().single);

    // 移除截图：文字未变但载荷已变成「纯 JSON」→ 必须换新 key。
    await tester.tap(find.byKey(const Key('feedback-remove-screenshot-btn')));
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    final List<http.Request> after = postsToFeedback();
    expect(after, hasLength(2));
    expect(after[1].headers['content-type'], contains('application/json'));
    expect(idempotencyKeyOf(after[1]), isNot(key1),
        reason: 'Class A：移除截图属于新快照，必须使用新幂等键');

    await teardown(tester);
  });

  testWidgets('Class B：服务端已接收但处理失败，绝不重新 POST，只刷新状态', (tester) async {
    respond('POST /api/feedback', {'feedbackId': 'f8', 'status': 'received'}, 201);
    respond('GET /api/feedback/f8', {'id': 'f8', 'status': 'processing'});
    respond('GET /api/feedback/f8',
        {'id': 'f8', 'status': 'failed', 'errorSummary': 'AI 处理失败'});
    final FeedbackPanelState panel = await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '服务端已接收的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();

    expect(panel.stage, FeedbackStage.failed);
    expect(find.text('失败（已记录，可在管理页处理）'), findsOneWidget);
    expect(find.text('详情：AI 处理失败'), findsOneWidget);
    // 保留原 feedbackId 与恢复提示。
    expect(find.text('反馈 ID：f8'), findsOneWidget);
    expect(find.textContaining('管理员可在管理页按此 ID 恢复'), findsOneWidget);
    expect(postsToFeedback(), hasLength(1));
    // Class B 不提供"重试提交"语义（提交按钮已不在视图内）。
    expect(find.byKey(submit), findsNothing);

    // 失败视图的动作必须是「刷新状态」而不是"再 POST 一次"。
    final int getsBefore = gets().length;
    // 之后的状态查询返回已归档 + 归档链接（覆盖既有脚本）。
    override('GET /api/feedback/f8',
        (http.Request request) async => jsonResponse({
              'id': 'f8',
              'status': 'archived',
              'kaneoUrl': 'https://kaneo.test/t/8',
            }));
    await tester.tap(find.byKey(const Key('feedback-refresh-status')));
    await tester.pump();
    await tester.pump();

    expect(postsToFeedback(), hasLength(1),
        reason: 'Class B：服务端已接收的反馈绝不重新 POST（会产生重复工单）');
    expect(gets().length, greaterThan(getsBefore),
        reason: 'Class B：失败视图的动作只应重新查询原反馈状态');
    expect(gets().last.url.path, '/api/feedback/f8',
        reason: '刷新必须查询原来那条记录的 ID');
    expect(panel.stage, FeedbackStage.archived,
        reason: '刷新到的状态必须回写面板');
    expect(find.text('已归档'), findsOneWidget);
    expect(find.byKey(const Key('feedback-open-url')), findsOneWidget,
        reason: '刷新到的归档链接必须可用');

    await teardown(tester);
  });

  testWidgets('Class B：复制反馈 ID 写入剪贴板并给出提示', (tester) async {
    respond('POST /api/feedback', {'feedbackId': 'f10', 'status': 'received'}, 201);
    respond('GET /api/feedback/f10',
        {'id': 'f10', 'status': 'failed', 'errorSummary': '整理未完成'});
    final List<MethodCall> clipboardCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (MethodCall call) async {
        if (call.method == 'Clipboard.setData') clipboardCalls.add(call);
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '需要复制 ID 的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-copy-id')));
    await tester.pump();
    await tester.pump();

    expect(clipboardCalls, hasLength(1));
    final Object? arguments = clipboardCalls.single.arguments;
    expect(arguments, isA<Map<Object?, Object?>>());
    expect((arguments! as Map<Object?, Object?>)['text'], 'f10',
        reason: '复制的必须是保留的原反馈 ID');
    expect(find.byKey(const Key('feedback-failed-notice')), findsOneWidget);
    expect(find.text('反馈 ID 已复制到剪贴板'), findsOneWidget);
    // 复制不会触发任何提交。
    expect(postsToFeedback(), hasLength(1));

    await teardown(tester);
  });

  testWidgets('Class B：剪贴板不可用时复制不抛出，降级提示可读', (tester) async {
    respond('POST /api/feedback', {'feedbackId': 'f11', 'status': 'received'}, 201);
    respond('GET /api/feedback/f11',
        {'id': 'f11', 'status': 'failed', 'errorSummary': '整理未完成'});
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (MethodCall call) async {
        if (call.method == 'Clipboard.setData') {
          throw PlatformException(code: 'clipboard_unavailable');
        }
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '剪贴板不可用时的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-copy-id')));
    await tester.pump();
    await tester.pump();

    // 无未处理异常即通过；面板给出可读的降级提示并保留 ID。
    expect(find.byKey(const Key('feedback-failed-notice')), findsOneWidget);
    expect(find.textContaining('剪贴板不可用'), findsOneWidget);
    expect(find.byKey(const Key('feedback-ticket-id')), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('Class B：刷新失败不改变原记录，只提示失败', (tester) async {
    respond('POST /api/feedback', {'feedbackId': 'f12', 'status': 'received'}, 201);
    respond('GET /api/feedback/f12',
        {'id': 'f12', 'status': 'failed', 'errorSummary': '整理未完成'});
    final FeedbackPanelState panel = await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '刷新会失败的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    // 刷新时网络断开：不得清掉 feedbackId，也不得回退成"可再次提交"。
    override('GET /api/feedback/f12',
        (http.Request request) async => throw Exception('模拟网络断开'));
    await tester.tap(find.byKey(const Key('feedback-refresh-status')));
    await tester.pump();
    await tester.pump();

    expect(panel.stage, FeedbackStage.failed);
    expect(find.text('反馈 ID：f12'), findsOneWidget);
    expect(find.textContaining('刷新失败'), findsOneWidget);
    expect(postsToFeedback(), hasLength(1));

    await teardown(tester);
  });

  testWidgets('Class A 重试收到服务端响应：退出 notSent 但仍复用同一幂等键', (tester) async {
    int calls = 0;
    on('POST /api/feedback', (http.Request request) async {
      calls++;
      if (calls == 1) throw Exception('模拟网络断开');
      return jsonResponse({
        'error': {'code': 'invalid_request', 'message': '内容无效'}
      }, 400);
    });
    final FeedbackPanelState panel = await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '第一次网络异常');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(panel.stage, FeedbackStage.notSent);

    // 第二次请求拿到了服务端响应（400）：请求确实送达，退出"未送达"状态，
    // 回到普通撰写视图（错误横幅展示）；快照未变 → 仍复用同一幂等键。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(panel.stage, FeedbackStage.compose,
        reason: '服务端已响应：不再是"未送达"的 notSent 状态');
    expect(find.text('内容无效'), findsOneWidget);
    expect(find.text('提交'), findsOneWidget);
    final List<http.Request> posts = postsToFeedback();
    expect(posts, hasLength(2));
    expect(idempotencyKeyOf(posts[1]), idempotencyKeyOf(posts[0]),
        reason: '快照未变：即使退出 notSent 也不得换 key');

    await teardown(tester);
  });

  testWidgets('Class B：返回编辑不自动重发，再次提交才是新反馈（新 key）', (tester) async {
    respond('POST /api/feedback', {'feedbackId': 'f9', 'status': 'received'}, 201);
    respond('GET /api/feedback/f9',
        {'id': 'f9', 'status': 'failed', 'errorSummary': '整理未完成'});
    await pumpPanel(tester);

    await tester.enterText(find.byKey(input), '要重新编辑的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.text('失败（已记录，可在管理页处理）'), findsOneWidget);

    // 返回编辑：只回到撰写视图并恢复原话，不自动重发。
    await tester.tap(find.byKey(const Key('feedback-back-edit')));
    await tester.pump();
    await tester.pump();
    expect(postsToFeedback(), hasLength(1), reason: '返回编辑不得自动重新提交');
    expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text, '要重新编辑的原话');

    // 用户主动再次提交：这是**全新的**反馈（新 key），不是重发旧工单。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    final List<http.Request> after = postsToFeedback();
    expect(after, hasLength(2));
    expect(idempotencyKeyOf(after[1]), isNot(idempotencyKeyOf(after[0])),
        reason: 'Class B 之后的新提交必须是新幂等键的新工单');

    await teardown(tester);
  });
}
