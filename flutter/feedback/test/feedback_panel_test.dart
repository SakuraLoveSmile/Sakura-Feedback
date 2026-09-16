import 'dart:async';
import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 返回 UTF-8 字节响应（`http.Response(String)` 对非 Latin-1 文本会抛错）。
http.Response jsonResponse(Object body, [int status = 200]) =>
    http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: const <String, String>{'content-type': 'application/json'},
    );

/// 可编程 mock 服务：按 `METHOD path` 匹配响应脚本，并记录全部请求。
class _MockServer {
  final List<http.Request> requests = <http.Request>[];
  final Map<String, List<Future<http.Response> Function(http.Request)>>
      _handlers =
      <String, List<Future<http.Response> Function(http.Request)>>{};

  http.Client get client => MockClient((request) async {
        requests.add(request);
        final key =
            '${request.method} ${Uri.parse(request.url.toString()).path}';
        final queue = _handlers[key];
        if (queue == null || queue.isEmpty) {
          return jsonResponse({
            'error': {'code': 'not_found', 'message': 'mock 未编排: $key'}
          }, 404);
        }
        final handler = queue.length > 1 ? queue.removeAt(0) : queue.first;
        return handler(request);
      });

  void on(String key, Future<http.Response> Function(http.Request) handler) {
    (_handlers[key] ??= <Future<http.Response> Function(http.Request)>[])
        .add(handler);
  }

  /// 编排一个固定响应；同 key 多个响应按注册顺序弹出，最后一个常驻。
  void respond(String key, Object body, [int status = 200]) {
    on(key, (request) async => jsonResponse(body, status));
  }

  http.Request lastMatching(String methodPath) => requests.lastWhere(
      (r) => '${r.method} ${Uri.parse(r.url.toString()).path}' == methodPath);
}

Future<void> _pumpPanel(
  WidgetTester tester, {
  required _MockServer server,
  required FeedbackTokenStore tokenStore,
  FeedbackConfig? config,
  Size surface = const Size(1000, 800),
}) async {
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    home: FeedbackPanel(
      config: config ??
          FeedbackConfig('https://svc.test', 'com.example.app',
              appVersion: '9.9.9', pageLabel: 'home'),
      tokenStore: tokenStore,
      httpClient: server.client,
    ),
  ));
  await tester.pump(); // _restoreSession 完成
}

void main() {
  const input = Key('feedback-input');
  const submit = Key('feedback-submit');

  late MemoryTokenStore store;
  late _MockServer server;

  setUp(() {
    store = MemoryTokenStore('bearer-token');
    server = _MockServer();
  });

  /// 结束测试时卸载面板，避免悬挂轮询 Timer。
  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 30));
  }

  testWidgets('未登录仍可编辑；点击「登录并提交」在当前面板展开表单，登录成功后自动提交', (tester) async {
    store = MemoryTokenStore();
    server.respond('POST /api/auth/login', {
      'ok': true,
      'token': 'fresh-token',
      'expiresAt': '2030-01-01T00:00:00Z',
      'user': {'id': 'u1', 'username': 'admin', 'role': 'user'},
      'quota': {
        'dailyLimit': 3,
        'used': 0,
        'remaining': 3,
        'resetAt': '2030-01-01T16:00:00Z'
      },
    });
    server.respond(
        'POST /api/feedback', {'feedbackId': 'f-login', 'status': 'received'}, 201);
    await _pumpPanel(tester, server: server, tokenStore: store);

    // 未登录：可直接编辑；登录表单尚未展开，也不打开任何窗口。
    expect(find.byKey(input), findsOneWidget);
    expect(find.byKey(const Key('feedback-login-username')), findsNothing);

    await tester.enterText(find.byKey(input), '未登录也能写');
    await tester.pump();
    await tester.tap(find.byKey(submit)); // 展开面板内登录表单
    await tester.pump();
    expect(find.byKey(const Key('feedback-login-username')), findsOneWidget);
    expect(find.byKey(const Key('feedback-login-password')), findsOneWidget);

    await tester.enterText(
        find.byKey(const Key('feedback-login-username')), 'admin');
    await tester.enterText(
        find.byKey(const Key('feedback-login-password')), 's3cret-pw');
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await tester.pump();
    await tester.pump();

    // 令牌入库；请求携带 clientLabel（平台名 + 时间）与 appId。
    expect(await store.read(), 'fresh-token');
    final body = jsonDecode(server.lastMatching('POST /api/auth/login').body)
        as Map<String, Object?>;
    expect(body['username'], 'admin');
    expect(body['password'], 's3cret-pw');
    expect(body['appId'], 'com.example.app');
    final label = body['clientLabel'] as String;
    expect(label, startsWith('flutter-'));
    expect(label, contains('20')); // ISO 时间
    // 登录成功后只自动提交一次（同内容不重复提交）。
    expect(server.requests.where((r) => r.url.path == '/api/feedback').length, 1);

    await teardown(tester);
  });

  testWidgets('登录凭据错误：401 显示错误、保留草稿、仍可编辑', (tester) async {
    store = MemoryTokenStore();
    server.respond(
        'POST /api/auth/login',
        {
          'error': {'code': 'invalid_credentials', 'message': '用户名或密码错误'}
        },
        401);
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '草稿不丢');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.enterText(
        find.byKey(const Key('feedback-login-username')), 'admin');
    await tester.enterText(
        find.byKey(const Key('feedback-login-password')), 'bad');
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('feedback-login-error')), findsOneWidget);
    expect(find.text('用户名或密码错误'), findsOneWidget);
    expect(find.byKey(input), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(input)).controller!.text, '草稿不丢');
    expect(await store.read(), isNull);
    expect(server.requests.where((r) => r.url.path == '/api/feedback'), isEmpty);

    await teardown(tester);
  });

  testWidgets('已登录显示今日剩余次数；额度用尽禁止新提交并提示', (tester) async {
    server.respond('GET /api/auth/session', {
      'authenticated': true,
      'user': {'id': 'u1', 'username': 'admin', 'role': 'user'},
      'quota': {
        'dailyLimit': 3,
        'used': 3,
        'remaining': 0,
        'resetAt': '2030-01-01T16:00:00Z'
      },
    });
    await _pumpPanel(tester, server: server, tokenStore: store);
    await tester.pump(); // 刷新额度完成

    expect(find.byKey(const Key('feedback-quota')), findsOneWidget);
    await tester.enterText(find.byKey(input), '额度用尽仍保留');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(submit)).onPressed, isNull);
    expect(find.byKey(const Key('feedback-quota-blocked')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(input)).controller!.text,
        '额度用尽仍保留');

    await teardown(tester);
  });

  testWidgets('输入限制按 runes 计：emoji 只占 1 个码点', (tester) async {
    await _pumpPanel(tester, server: server, tokenStore: store);

    // 9999 个 'a' + 1 个 emoji（UTF-16 里占 2 个码元）：共 10000 码点，应全部保留。
    await tester.enterText(find.byKey(input), '${'a' * 9999}😀');
    await tester.pump();
    expect(find.text('10000 / 10000'), findsOneWidget);
    final controllerText =
        tester.widget<TextField>(find.byKey(input)).controller!.text;
    expect(controllerText.runes.length, 10000);

    // 再输入一个字符应被截断。
    await tester.enterText(find.byKey(input), '${'a' * 10000}b');
    await tester.pump();
    final after = tester.widget<TextField>(find.byKey(input)).controller!.text;
    expect(after.runes.length, 10000);
    expect(after.endsWith('b'), isFalse);
    expect(find.byKey(const Key('feedback-counter')), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('提交成功：清空草稿、轮询状态流转至已归档并可查看归档链接', (tester) async {
    final postGate = Completer<http.Response>();
    server.on('POST /api/feedback', (request) => postGate.future);
    server
      ..respond('GET /api/feedback/f42', {'id': 'f42', 'status': 'processing'})
      ..respond('GET /api/feedback/f42', {
        'id': 'f42',
        'status': 'archived',
        'kaneoUrl': 'https://kaneo.test/t/1'
      });
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '界面很好用，但希望支持深色模式');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    // 提交中状态视图（响应被 gate 挂起）。
    expect(find.text('提交中…'), findsOneWidget);

    postGate.complete(
        jsonResponse({'feedbackId': 'f42', 'status': 'received'}, 201));
    await tester.pump();
    await tester.pump();

    // 已接收。
    expect(find.text('已接收'), findsOneWidget);

    final submitReq = server.lastMatching('POST /api/feedback');
    final body = jsonDecode(submitReq.body) as Map<String, Object?>;
    expect(body['appId'], 'com.example.app');
    expect(body['text'], '界面很好用，但希望支持深色模式');
    expect(body['context'],
        <String, Object?>{'appVersion': '9.9.9', 'pageLabel': 'home'});
    expect((body['idempotencyKey'] as String).length, 36);
    expect(submitReq.headers['authorization'], 'Bearer bearer-token');

    // 轮询退避：2s 后第一次 → 处理中。
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.text('处理中'), findsOneWidget);

    // 再退避 3s 后第二次 → 已归档 + 查看归档按钮。
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('已归档'), findsOneWidget);
    expect(find.byKey(const Key('feedback-open-url')), findsOneWidget);

    // 继续反馈：回到空白撰写视图（草稿已在成功接收时清空）。
    await tester.tap(find.byKey(const Key('feedback-continue')));
    await tester.pump();
    final field = tester.widget<TextField>(find.byKey(input));
    expect(field.controller!.text, isEmpty);
    expect(find.text('0 / 10000'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('提交失败：保留输入与幂等键并可重试', (tester) async {
    server
      ..respond(
          'POST /api/feedback',
          {
            'error': {'code': 'invalid_request', 'message': '内容无效'}
          },
          400)
      ..respond('POST /api/feedback',
          {'feedbackId': 'f7', 'status': 'received'}, 201);
    server.respond('GET /api/feedback/f7', {'id': 'f7', 'status': 'received'});
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '第一次会失败的提交');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    // 错误横幅展示，输入保留。
    expect(find.byKey(const Key('feedback-compose-error')), findsOneWidget);
    expect(find.text('内容无效'), findsOneWidget);
    final text = tester.widget<TextField>(find.byKey(input)).controller!.text;
    expect(text, '第一次会失败的提交');

    // 重试：复用同一幂等键。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(find.text('已接收'), findsOneWidget);
    final posts = server.requests
        .where((r) => Uri.parse(r.url.toString()).path == '/api/feedback')
        .toList();
    expect(posts.length, 2);
    final key1 =
        (jsonDecode(posts[0].body) as Map<String, Object?>)['idempotencyKey'];
    final key2 =
        (jsonDecode(posts[1].body) as Map<String, Object?>)['idempotencyKey'];
    expect(key1, key2);

    await teardown(tester);
  });

  testWidgets('轮询得到 failed：展示失败说明、只刷新不重发；返回编辑后是新反馈', (tester) async {
    // 服务端**已接收**该反馈（f8）但后台处理失败：面板只允许刷新状态 /
    // 复制 ID / 返回编辑开新反馈——绝不重新 POST（重发会产生重复工单）。
    int posts = 0;
    server.on('POST /api/feedback', (request) async {
      posts++;
      return jsonResponse(
          {'feedbackId': posts == 1 ? 'f8' : 'f9', 'status': 'received'}, 201);
    });
    server
      ..respond('GET /api/feedback/f8', {'id': 'f8', 'status': 'processing'})
      ..respond('GET /api/feedback/f8',
          {'id': 'f8', 'status': 'failed', 'errorSummary': 'AI 处理失败'})
      ..respond('GET /api/feedback/f9', {'id': 'f9', 'status': 'received'});
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '会被服务端处理失败的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();

    expect(find.text('失败'), findsOneWidget);
    expect(find.text('失败（已记录，可在管理页处理）'), findsOneWidget);
    expect(find.text('详情：AI 处理失败'), findsOneWidget);
    expect(find.text('反馈 ID：f8'), findsOneWidget);
    expect(posts, 1);

    // 刷新状态：只重新查询原记录，不产生第二次提交。
    final int getsBefore = server.requests
        .where((r) => r.method == 'GET')
        .length;
    await tester.tap(find.byKey(const Key('feedback-refresh-status')));
    await tester.pump();
    await tester.pump();
    expect(posts, 1, reason: '服务端已接收成功的反馈绝不重新 POST');
    expect(server.requests.where((r) => r.method == 'GET').length,
        greaterThan(getsBefore));
    expect(find.text('反馈 ID：f8'), findsOneWidget);

    // 返回编辑：恢复原话，不自动重发。
    await tester.tap(find.byKey(const Key('feedback-back-edit')));
    await tester.pump();
    await tester.pump();
    expect(posts, 1, reason: '返回编辑不得自动重新提交');
    expect(tester.widget<TextField>(find.byKey(input)).controller!.text,
        '会被服务端处理失败的原话');

    // 用户主动再次提交 = 全新反馈（新 key），而不是重发旧工单。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    final postsRequests = server.requests
        .where((r) =>
            r.method == 'POST' &&
            Uri.parse(r.url.toString()).path == '/api/feedback')
        .toList();
    expect(postsRequests.length, 2);
    final key1 = (jsonDecode(postsRequests[0].body)
        as Map<String, Object?>)['idempotencyKey'];
    final key2 = (jsonDecode(postsRequests[1].body)
        as Map<String, Object?>)['idempotencyKey'];
    expect(key1, isNot(key2), reason: '新反馈必须是新幂等键的新工单');
    final retriedText = (jsonDecode(postsRequests[1].body)
        as Map<String, Object?>)['text'] as String;
    expect(retriedText, '会被服务端处理失败的原话');
    expect(find.text('已接收'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('提交返回 409 幂等冲突：提示该反馈已提交', (tester) async {
    server.respond(
        'POST /api/feedback',
        {
          'error': {'code': 'idempotency_conflict', 'message': '同键不同内容'}
        },
        409);
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '重复内容');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    expect(find.text('该反馈已提交'), findsOneWidget);
    // 输入保留：继续反馈回到撰写视图，草稿仍是原话。
    await tester.tap(find.byKey(const Key('feedback-continue')));
    await tester.pump();
    expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text, '重复内容');

    await teardown(tester);
  });

  testWidgets('提交返回 401：清除令牌并回到未登录态，草稿保留', (tester) async {
    // 第一次提交 401（令牌失效）；重新登录后的自动续交成功。
    server.on('POST /api/feedback',
        (r) async => jsonResponse({'error': {'code': 'unauthorized', 'message': '令牌无效'}}, 401));
    server.on('POST /api/feedback',
        (r) async => jsonResponse({'feedbackId': 'f-re', 'status': 'received'}, 201));
    server.respond('POST /api/auth/login', {'ok': true, 'token': 're-token'});
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '令牌过期时的草稿');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    expect(await store.read(), isNull); // 401 清 token
    expect(find.byKey(input), findsOneWidget); // 仍可编辑
    expect(tester.widget<TextField>(find.byKey(input)).controller!.text,
        '令牌过期时的草稿');

    // 未登录：点击提交展开面板内表单，重新登录后草稿仍在并通过自动续交提交。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.enterText(
        find.byKey(const Key('feedback-login-username')), 'u');
    await tester.enterText(
        find.byKey(const Key('feedback-login-password')), 'p');
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await tester.pump();
    await tester.pump();

    expect(await store.read(), 're-token'); // 重新登录成功
    // 自动续交成功：进入已接收状态（草稿被服务端接收）。
    expect(find.text('已接收'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('轮询到 needs_review 按失败展示', (tester) async {
    server.respond(
        'POST /api/feedback', {'feedbackId': 'f5', 'status': 'received'}, 201);
    server.respond(
        'GET /api/feedback/f5', {'id': 'f5', 'status': 'needs_review'});
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '会进 needs_review 的原话');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(find.text('失败（已记录，可在管理页处理）'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('提交返回 waiting_configuration：提示等待配置、不轮询、保留手动刷新', (tester) async {
    server.respond(
        'POST /api/feedback',
        {
          'feedbackId': 'fw',
          'status': 'received',
          'collectionState': 'waiting_configuration',
        },
        201);
    server.respond('GET /api/feedback/fw', {
      'id': 'fw',
      'status': 'needs_info',
      'collectionState': 'waiting_configuration',
    });
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '未登记软件的反馈');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();

    // 等待不是失败：明确提示已保存 + 等待什么
    expect(find.text('已保存'), findsOneWidget);
    expect(find.textContaining('等待管理员配置该软件'), findsOneWidget);
    expect(find.textContaining('失败'), findsNothing);

    // 不轮询：等待期间不会发出 GET
    final int getsAfterSubmit = server.requests
        .where((r) => r.method == 'GET' && r.url.path == '/api/feedback/fw')
        .length;
    await tester.pump(const Duration(seconds: 30));
    await tester.pump();
    expect(
        server.requests
            .where((r) => r.method == 'GET' && r.url.path == '/api/feedback/fw')
            .length,
        getsAfterSubmit);

    // 手动刷新仍然可用
    await tester.tap(find.byKey(const Key('feedback-refresh-status')));
    await tester.pump();
    await tester.pump();
    expect(
        server.requests
            .where((r) => r.method == 'GET' && r.url.path == '/api/feedback/fw')
            .length,
        greaterThan(getsAfterSubmit));

    await teardown(tester);
  });

  testWidgets('轮询到 waiting_source_confirmation：停止轮询并提示等待确认来源', (tester) async {
    server.respond(
        'POST /api/feedback', {'feedbackId': 'fs', 'status': 'received'}, 201);
    server.respond('GET /api/feedback/fs', {
      'id': 'fs',
      'status': 'needs_info',
      'collectionState': 'waiting_source_confirmation',
    });
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '新来源的反馈');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(find.textContaining('等待管理员确认来源'), findsOneWidget);
    final int gets = server.requests
        .where((r) => r.method == 'GET' && r.url.path == '/api/feedback/fs')
        .length;
    await tester.pump(const Duration(seconds: 30));
    await tester.pump();
    expect(
        server.requests
            .where((r) => r.method == 'GET' && r.url.path == '/api/feedback/fs')
            .length,
        gets);

    await teardown(tester);
  });

  testWidgets('结果未知失败后：草稿未变重试同 key，草稿已编辑换新 key', (tester) async {
    // 与 Web 端"未知结果 + 修改 → 新快照新 key（不静默覆盖原请求）"对齐：
    // 草稿未变 → 同 key 同字节重试；草稿被编辑 → 新 key，避免同 key 不同
    // 内容触发 409 被误判为重放。
    int calls = 0;
    server.on('POST /api/feedback', (request) async {
      calls++;
      if (calls <= 2) {
        throw Exception('模拟网络断开（结果未知）');
      }
      return jsonResponse({'feedbackId': 'fk', 'status': 'received'}, 201);
    });
    await _pumpPanel(tester, server: server, tokenStore: store);

    await tester.enterText(find.byKey(input), '原话 v1');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(find.text('网络异常，提交失败。您的输入已保留，请重试'), findsOneWidget);
    final String key1 = (jsonDecode(server.requests.last.body)
        as Map<String, Object?>)['idempotencyKey'] as String;

    // 未编辑直接重试：同 key 同内容。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    expect(find.text('网络异常，提交失败。您的输入已保留，请重试'), findsOneWidget);
    final String key2 = (jsonDecode(server.requests.last.body)
        as Map<String, Object?>)['idempotencyKey'] as String;
    expect(key2, key1, reason: '结果未知的失败：草稿未变必须重试同 key');

    // 编辑草稿后再提交：新快照新 key（原 key 不复用、不静默覆盖原请求）。
    await tester.enterText(find.byKey(input), '原话 v2');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.pump();
    final Object? body3 =
        jsonDecode(server.requests.last.body) as Map<String, Object?>?;
    expect((body3! as Map<String, Object?>)['idempotencyKey'], isNot(key1),
        reason: '编辑后新草稿版本必须换新 key');
    expect((body3 as Map<String, Object?>)['text'], '原话 v2');

    await teardown(tester);
  });
}
