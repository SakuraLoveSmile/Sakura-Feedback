import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

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

Uint8List bytes(String text) => Uint8List.fromList(utf8.encode(text));

/// 1×1 透明 PNG：仅用于让撰写视图进入「有截图」布局分支（像素内容无关）。
final Uint8List kTransparentPngBytes = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA'
  'hKmMIQAAAABJRU5ErkJggg==',
);

FeedbackLogFile file(String name, String text) =>
    FeedbackLogFile(name: name, bytes: bytes(text));

bool isMultipart(http.Request request) =>
    request.headers['content-type']?.contains('multipart/form-data') ?? false;

/// 从（JSON 或 multipart 的）提交请求中取出 metadata。
Map<String, Object?> requestMetadata(http.Request request) {
  if (!isMultipart(request)) {
    return jsonDecode(request.body) as Map<String, Object?>;
  }
  final String body = utf8.decode(request.bodyBytes, allowMalformed: true);
  final int field = body.indexOf('name="metadata"');
  final int start = body.indexOf('\r\n\r\n', field) + 4;
  final int end = body.indexOf('\r\n--', start);
  return jsonDecode(body.substring(start, end)) as Map<String, Object?>;
}

String requestBody(http.Request request) => isMultipart(request)
    ? utf8.decode(request.bodyBytes, allowMalformed: true)
    : request.body;

/// 可编程 mock 服务：记录全部请求，POST /api/feedback 可注入脚本。
class _Server {
  final List<http.Request> requests = <http.Request>[];
  final List<Future<http.Response> Function(http.Request)> _post =
      <Future<http.Response> Function(http.Request)>[];

  int postCalls = 0;

  /// 追加一次 POST /api/feedback 的响应脚本（多个按顺序弹出，最后一个常驻）。
  void onPost(Future<http.Response> Function(http.Request) handler) =>
      _post.add(handler);

  void respondPost(Object body, [int status = 201]) =>
      onPost((http.Request request) async => jsonResponse(body, status));

  void respondGet(String id, Object body, [int status = 200]) =>
      _get[id] = body;

  final Map<String, Object> _get = <String, Object>{};

  http.Client get client => MockClient((http.Request request) async {
        requests.add(request);
        final String path = request.url.path;
        if (request.method == 'POST' && path == '/api/feedback') {
          postCalls++;
          final int index = postCalls - 1;
          if (_post.isEmpty) {
            return jsonResponse(
                {'feedbackId': 'f1', 'status': 'received'}, 201);
          }
          final handler = index < _post.length ? _post[index] : _post.last;
          return handler(request);
        }
        if (request.method == 'GET' && path.startsWith('/api/feedback/')) {
          final String id = path.substring('/api/feedback/'.length);
          final Object? body = _get[id];
          if (body == null) {
            return jsonResponse(
                {'error': {'code': 'not_found', 'message': 'mock 未编排'}}, 404);
          }
          return jsonResponse(body);
        }
        return jsonResponse(
            {'error': {'code': 'not_found', 'message': 'mock 未编排: $path'}},
            404);
      });
}

/// 等待条件成立（仅推进帧）。
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() cond, {
  String reason = 'pumpUntil 等待超时',
}) async {
  for (int i = 0; i < 200; i++) {
    if (cond()) {
      // 条件成立说明状态刚刚变化：再泵一帧把它渲染出来，断言才看得见。
      await tester.pump();
      return;
    }
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail(reason);
}

void main() {
  const addKey = Key('feedback-log-add');

  late _Server server;
  late MemoryTokenStore store;

  setUp(() {
    server = _Server();
    store = MemoryTokenStore('tok-log');
  });

  /// 组件宿主：可注入 logProvider / 手动选择器 / 身份（appId）。
  Widget host({
    required FeedbackController controller,
    FeedbackLogProvider? logProvider,
    FeedbackLogFilePicker? picker,
    String appId = 'com.example.app',
  }) {
    return MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          appId,
          logProvider: logProvider,
        ),
        controller: controller,
        tokenStore: store,
        httpClient: server.client,
        pickLogFiles: picker,
        child: const Placeholder(),
      ),
    );
  }

  Future<FeedbackController> pumpHost(
    WidgetTester tester, {
    FeedbackLogProvider? logProvider,
    FeedbackLogFilePicker? picker,
    Size surface = const Size(1000, 900),
  }) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final FeedbackController controller = FeedbackController();
    await tester.pumpWidget(host(
      controller: controller,
      logProvider: logProvider,
      picker: picker,
    ));
    await tester.pump();
    addTearDown(controller.dispose);
    return controller;
  }

  Future<void> openPanel(WidgetTester tester, FeedbackController controller) async {
    await tester.tap(find.byKey(const Key('feedback-fab')));
    await pumpUntil(
      tester,
      () => find.byKey(const Key('feedback-input')).evaluate().isNotEmpty,
      reason: '面板未挂载',
    );
  }

  Future<void> closePanel(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
  }

  FeedbackPanelState panelOf(WidgetTester tester) =>
      tester.state<FeedbackPanelState>(
          find.byType(FeedbackPanel, skipOffstage: false));

  /// 已附加的日志数量（面板尚未挂载时按 0 处理）。
  int logCount(WidgetTester tester) {
    final Finder finder = find.byType(FeedbackPanel, skipOffstage: false);
    if (finder.evaluate().isEmpty) return 0;
    return tester.state<FeedbackPanelState>(finder).logs.length;
  }

  /// 结束测试时卸载组件并冲掉遗留定时器。
  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 30));
  }

  group('自动采集（契约 §4.1 / §4.2）', () {
    testWidgets('新草稿首次打开：自动采集一次并展示文件名、大小、来源', (tester) async {
      int calls = 0;
      await pumpHost(
        tester,
        logProvider: () async {
          calls++;
          return <FeedbackLogFile>[
            file('app.log', 'hello world\n'), // 12 B
            file('network.jsonl', '{"status":200}\n'), // 15 B
          ];
        },
      );

      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 2);

      expect(calls, 1, reason: '新草稿首次打开采集一次');
      expect(find.text('app.log'), findsOneWidget);
      expect(find.text('network.jsonl'), findsOneWidget);
      expect(find.text('12 B'), findsOneWidget);
      expect(find.text('15 B'), findsOneWidget);
      expect(find.text('自动'), findsNWidgets(2));
      expect(find.byKey(const Key('feedback-log-notice')), findsOneWidget);
      expect(find.textContaining('AI 分析'), findsOneWidget);

      // 关闭再打开（已有草稿）：不重新采集，日志仍在。
      await closePanel(tester);
      await openPanel(tester, controller);
      await tester.pump();
      expect(calls, 1, reason: '重新打开已有草稿不重新采集');
      expect(find.text('app.log'), findsOneWidget);
      expect(panelOf(tester).logs.length, 2);

      await teardown(tester);
    });

    testWidgets('自动采集同样受上限约束：一次返回 4 个整批拒绝并提示', (tester) async {
      await pumpHost(
        tester,
        logProvider: () async => <FeedbackLogFile>[
          for (int i = 0; i < 4; i++) file('auto$i.log', 'line $i\n'),
        ],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('超过 3 个上限'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty, reason: '自动采集超限同样整批拒绝');

      await teardown(tester);
    });

    testWidgets('窄而矮的视口：截图 + 3 份日志也不溢出（布局自适应）', (tester) async {
      await pumpHost(
        tester,
        surface: const Size(400, 480),
        logProvider: () async => <FeedbackLogFile>[
          for (int i = 0; i < 3; i++) file('auto$i.log', 'line $i\n'),
        ],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 3);

      // 再附一张截图：撰写视图固定块变高，仍不得出现 RenderFlex 溢出。
      panelOf(tester).setScreenshot(
        Uint8List.fromList(kTransparentPngBytes),
        const FeedbackCaptureInfo(viewportWidth: 400, viewportHeight: 400),
      );
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('feedback-logs-area')), findsOneWidget);
      expect(panelOf(tester).logs.length, 3);
      expect(tester.takeException(), isNull, reason: '自适应布局不得溢出');

      await teardown(tester);
    });

    testWidgets('只有日志时仍可重新截图（日志不算草稿内容，也不被清掉）', (tester) async {
      int calls = 0;
      await tester.binding.setSurfaceSize(const Size(800, 600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final FeedbackController controller = FeedbackController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(MaterialApp(
        home: FeedbackWidget(
          config: FeedbackConfig(
            'https://svc.test',
            'com.example.app',
            captureMode: FeedbackCaptureMode.viewport,
            logProvider: () async {
              calls++;
              return <FeedbackLogFile>[file('auto.log', 'line\n')];
            },
          ),
          controller: controller,
          tokenStore: store,
          httpClient: server.client,
          child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
        ),
      ));
      await tester.pump();

      // 普通呼出（不截图）：仅日志，没有文字与截图。
      controller.open();
      await pumpUntil(tester, () => logCount(tester) == 1);
      expect(panelOf(tester).hasDraft, isFalse);
      expect(panelOf(tester).hasScreenshot, isFalse);

      controller.close();
      await tester.pump();
      // 拖拽 / 主动截图入口必须照常截图：日志不构成「已有草稿」。
      unawaited(controller.captureAndOpen(releasePoint: const Offset(0.5, 0.5)));
      for (int i = 0; i < 200 && !panelOf(tester).hasScreenshot; i++) {
        await tester.pump(const Duration(milliseconds: 16));
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
      }
      expect(panelOf(tester).hasScreenshot, isTrue, reason: '日志不阻碍截图');
      expect(panelOf(tester).logs.length, 1, reason: '重新截图不得清掉已附加的日志');
      expect(calls, 1, reason: '已有草稿重开不重新采集');

      await teardown(tester);
    });

    testWidgets('未配置 logProvider：只显示手动添加入口，没有任何自动采集 UI', (tester) async {
      final FeedbackController controller = await pumpHost(tester);
      await openPanel(tester, controller);

      expect(find.byKey(addKey), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-empty')), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-status')), findsNothing);
      expect(find.byKey(const Key('feedback-log-retry')), findsNothing);
      expect(panelOf(tester).logs, isEmpty);

      await teardown(tester);
    });

    testWidgets('3 秒超时：提示「日志获取失败」+ 重试 + 不带日志继续提交，且不阻塞提交', (tester) async {
      final Completer<List<FeedbackLogFile>> pending =
          Completer<List<FeedbackLogFile>>();
      int calls = 0;
      await pumpHost(tester, logProvider: () {
        calls++;
        return pending.future;
      });
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;

      await openPanel(tester, controller);
      await tester.pump();
      expect(find.text('正在获取运行日志…'), findsOneWidget);

      // 未到 3 秒：仍在采集。
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('正在获取运行日志…'), findsOneWidget);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('日志获取失败'), findsOneWidget);
      expect(find.text('请求超过 3 秒未返回'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-retry')), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-continue')), findsOneWidget);

      // 失败不阻塞截图与描述提交：直接提交成功，且请求不含日志（JSON 路径）。
      await tester.enterText(find.byKey(const Key('feedback-input')), '超时也要能提交');
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(find.text('已接收'), findsOneWidget);
      final http.Request posted = server.requests
          .lastWhere((http.Request r) => r.method == 'POST' && r.url.path == '/api/feedback');
      expect(isMultipart(posted), isFalse);
      expect(requestMetadata(posted).containsKey('logs'), isFalse);

      // 超时后的迟到结果同样不得写回。
      pending.complete(<FeedbackLogFile>[file('late.log', 'late\n')]);
      await tester.pump();
      expect(calls, 1);
      await teardown(tester);
    });

    testWidgets('宿主回调抛错：提示失败，「重试」成功后展示日志', (tester) async {
      int calls = 0;
      await pumpHost(tester, logProvider: () async {
        calls++;
        if (calls == 1) throw StateError('导出日志失败');
        return <FeedbackLogFile>[file('retry.log', 'retried\n')];
      });
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;

      await openPanel(tester, controller);
      await tester.pump();
      await tester.pump();
      expect(find.text('日志获取失败'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-retry')), findsOneWidget);

      await tester.tap(find.byKey(const Key('feedback-log-retry')));
      await tester.pump();
      await tester.pump();
      expect(calls, 2);
      expect(find.text('retry.log'), findsOneWidget);
      expect(find.text('自动'), findsOneWidget);
      expect(find.text('日志获取失败'), findsNothing);

      await teardown(tester);
    });

    testWidgets('「不带日志继续提交」收起提示，重试入口仍可达', (tester) async {
      await pumpHost(tester, logProvider: () async => throw StateError('boom'));
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await tester.pump();
      await tester.pump();
      expect(find.text('日志获取失败'), findsOneWidget);

      await tester.tap(find.byKey(const Key('feedback-log-continue')));
      await tester.pump();
      expect(find.text('日志获取失败'), findsNothing);
      expect(find.text('重试获取日志'), findsOneWidget);

      await teardown(tester);
    });

    testWidgets('迟到结果不写回：关闭面板后完成的采集被丢弃，且不自动补回', (tester) async {
      final Completer<List<FeedbackLogFile>> pending =
          Completer<List<FeedbackLogFile>>();
      int calls = 0;
      await pumpHost(tester, logProvider: () {
        calls++;
        return pending.future;
      });
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;

      await openPanel(tester, controller);
      await tester.pump();
      expect(panelOf(tester).isCollectingLogs, isTrue);

      await closePanel(tester);
      pending.complete(<FeedbackLogFile>[file('late.log', 'late\n')]);
      await tester.pump();
      await tester.pump();
      expect(panelOf(tester).logs, isEmpty, reason: '面板关闭后迟到的采集结果不得写回');

      // 重新打开：不重新采集（本份草稿已采集过一次），也不自动补回。
      await openPanel(tester, controller);
      await tester.pump();
      expect(calls, 1);
      expect(find.text('late.log'), findsNothing);
      expect(find.byKey(const Key('feedback-log-empty')), findsOneWidget);

      await teardown(tester);
    });

    testWidgets('迟到结果不写回：组件 dispose 后完成采集不抛异常', (tester) async {
      final Completer<List<FeedbackLogFile>> pending =
          Completer<List<FeedbackLogFile>>();
      int calls = 0;
      await pumpHost(tester, logProvider: () {
        calls++;
        return pending.future;
      });
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await tester.pump();
      expect(panelOf(tester).isCollectingLogs, isTrue);

      await tester.pumpWidget(const SizedBox.shrink());
      pending.complete(<FeedbackLogFile>[file('late.log', 'late\n')]);
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(calls, 1);
    });

    testWidgets('切换 appId：旧身份迟到结果不写回，新草稿重新采集', (tester) async {
      final Completer<List<FeedbackLogFile>> oldPending =
          Completer<List<FeedbackLogFile>>();
      int oldCalls = 0;
      int newCalls = 0;
      final FeedbackController controller = FeedbackController();
      addTearDown(controller.dispose);
      await tester.binding.setSurfaceSize(const Size(1000, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(host(
        controller: controller,
        logProvider: () {
          oldCalls++;
          return oldPending.future;
        },
        picker: () async => <FeedbackLogFile>[file('old-manual.log', 'old\n')],
      ));
      await tester.pump();
      await openPanel(tester, controller);
      await tester.pump();
      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(panelOf(tester).logs.length, 1, reason: '旧身份草稿已有一份手动日志');

      // 身份切换（apiBase / appId 变化）→ 面板状态整体重建。
      await tester.pumpWidget(host(
        controller: controller,
        appId: 'com.example.other',
        logProvider: () async {
          newCalls++;
          return <FeedbackLogFile>[file('new-auto.log', 'new\n')];
        },
      ));
      await tester.pump();
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);

      expect(panelOf(tester).logs.single.name, 'new-auto.log');
      expect(find.text('old-manual.log'), findsNothing,
          reason: '旧身份的日志不得污染新草稿');
      expect(newCalls, 1);

      // 旧身份的迟到结果仍然不得写回。
      oldPending.complete(<FeedbackLogFile>[file('old-late.log', 'late\n')]);
      await tester.pump();
      await tester.pump();
      expect(oldCalls, 1);
      expect(find.text('old-late.log'), findsNothing);
      expect(panelOf(tester).logs.single.name, 'new-auto.log');

      await teardown(tester);
    });
  });

  group('手动添加与限制（契约 §4.4 / §4.5 / §4.6）', () {
    testWidgets('手动添加：来源为「手动」，可预览纯文本、可移除且不自动补回', (tester) async {
      int calls = 0;
      await pumpHost(
        tester,
        logProvider: () async {
          calls++;
          return <FeedbackLogFile>[file('auto.log', 'auto line\n')];
        },
        picker: () async => <FeedbackLogFile>[file('manual.txt', '第一行\n第二行\n')],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);

      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(panelOf(tester).logs.length, 2);
      expect(find.text('manual.txt'), findsOneWidget);
      expect(find.text('手动'), findsOneWidget);
      expect(find.text('自动'), findsOneWidget);

      // 纯文本预览。
      await tester.tap(find.byKey(const Key('feedback-log-preview-1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-log-preview-dialog')), findsOneWidget);
      expect(find.textContaining('第一行'), findsOneWidget);
      await tester.tap(find.byKey(const Key('feedback-log-preview-close')));
      await tester.pumpAndSettle();

      // 移除：列表少一项，且不自动补回（自动采集只发生一次）。
      await tester.tap(find.byKey(const Key('feedback-log-remove-0')));
      await tester.pump();
      expect(find.text('auto.log'), findsNothing);
      expect(panelOf(tester).logs.length, 1);
      expect(calls, 1);

      // 关闭重开：草稿里的日志仍在，不重新采集。
      await closePanel(tester);
      await openPanel(tester, controller);
      await tester.pump();
      expect(find.text('manual.txt'), findsOneWidget);
      expect(find.text('auto.log'), findsNothing);
      expect(calls, 1);

      await teardown(tester);
    });

    testWidgets('扩展名非法：整批拒绝并给出明确提示（不静默丢弃）', (tester) async {
      await pumpHost(
        tester,
        picker: () async => <FeedbackLogFile>[
          file('ok.log', 'ok\n'),
          file('notes.md', '# 不是日志\n'),
        ],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);

      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('必须是 .log/.txt/.json/.jsonl'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty, reason: '整批校验：不做部分添加');
      expect(find.text('ok.log'), findsNothing);

      await teardown(tester);
    });

    testWidgets('超过单文件 1MiB 与空文件：明确提示且不截断', (tester) async {
      Uint8List? nextBytes;
      String nextName = 'big.log';
      await pumpHost(
        tester,
        picker: () async =>
            <FeedbackLogFile>[FeedbackLogFile(name: nextName, bytes: nextBytes!)],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);

      nextBytes = Uint8List(kFeedbackMaxLogBytes + 1);
      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('超过 1MiB 上限'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty);

      nextName = 'empty.log';
      nextBytes = Uint8List(0);
      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('不能为空'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty);

      await teardown(tester);
    });

    testWidgets('二进制 / 非 UTF-8 内容拒绝', (tester) async {
      await pumpHost(
        tester,
        picker: () async => <FeedbackLogFile>[
          FeedbackLogFile(
            name: 'binary.log',
            bytes: Uint8List.fromList(<int>[0x00, 0xFF, 0xFE, 0x01]),
          ),
        ],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);

      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('不是有效 UTF-8'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty);

      await teardown(tester);
    });

    testWidgets('数量上限 3：一次选 4 个整批拒绝；已有 3 个时添加入口禁用', (tester) async {
      List<FeedbackLogFile> next = <FeedbackLogFile>[];
      await pumpHost(tester, picker: () async => next);
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);

      next = <FeedbackLogFile>[
        for (int i = 0; i < 4; i++) file('log$i.log', 'line $i\n'),
      ];
      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('超过 3 个上限'), findsOneWidget);
      expect(panelOf(tester).logs, isEmpty);

      next = <FeedbackLogFile>[
        for (int i = 0; i < 3; i++) file('ok$i.log', 'line $i\n'),
      ];
      await tester.tap(find.byKey(addKey));
      await tester.pump();
      await tester.pump();
      expect(panelOf(tester).logs.length, 3);
      final TextButton button =
          tester.widget<TextButton>(find.byKey(addKey));
      expect(button.onPressed, isNull, reason: '已达上限：添加入口禁用');

      await teardown(tester);
    });
  });

  group('提交与轮询（契约 §4.8 / §1）', () {
    testWidgets('提交：multipart 携带日志；失败保留快照；改日志换新幂等键', (tester) async {
      int calls = 0;
      server.onPost((http.Request request) async {
        calls++;
        if (calls <= 2) throw Exception('模拟网络断开（结果未知）');
        return jsonResponse({'feedbackId': 'f-logs', 'status': 'received'}, 201);
      });
      await pumpHost(
        tester,
        logProvider: () async => <FeedbackLogFile>[file('app.log', 'line\n')],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);
      await tester.enterText(find.byKey(const Key('feedback-input')), '日志一起提交');
      await tester.pump();

      // 第一次提交：网络异常（结果未知）→ 快照与日志保留。
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(find.text('网络异常，提交失败。您的输入已保留，请重试'), findsOneWidget);
      expect(find.text('app.log'), findsOneWidget, reason: '提交失败保留原快照（含日志）');
      final http.Request first = server.requests.last;
      expect(isMultipart(first), isTrue, reason: '有日志必须走 multipart');
      final Map<String, Object?> meta1 = requestMetadata(first);
      expect(meta1['logs'], <Object?>[
        <String, Object?>{'name': 'app.log', 'source': 'auto', 'byteSize': 5},
      ]);
      expect(requestBody(first).contains('filename="app.log"'), isTrue);
      final String key1 = meta1['idempotencyKey']! as String;

      // 未修改直接重试：同 key 同字节。
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      final String key2 =
          requestMetadata(server.requests.last)['idempotencyKey']! as String;
      expect(key2, key1, reason: '快照未变：重试必须复用同一幂等键');

      // 移除日志（修改附件）→ 新快照必须换新 key，且退化为原 JSON 路径。
      await tester.tap(find.byKey(const Key('feedback-log-remove-0')));
      await tester.pump();
      expect(panelOf(tester).logs, isEmpty);
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(find.text('已接收'), findsOneWidget);
      final http.Request third = server.requests.last;
      expect(isMultipart(third), isFalse, reason: '无日志无截图回到原 JSON 路径');
      final Map<String, Object?> meta3 = requestMetadata(third);
      expect(meta3['idempotencyKey'], isNot(key1),
          reason: '修改附件后必须生成新的幂等键');
      expect(meta3.containsKey('logs'), isFalse);

      await teardown(tester);
    });

    testWidgets('提交与轮询期间锁定附件修改（日志入口不可达）', (tester) async {
      final Completer<http.Response> gate = Completer<http.Response>();
      server.onPost((http.Request request) => gate.future);
      server.respondGet('f-lock', <String, Object>{
        'id': 'f-lock',
        'status': 'processing',
      });
      await pumpHost(
        tester,
        logProvider: () async => <FeedbackLogFile>[file('app.log', 'line\n')],
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);
      await tester.enterText(find.byKey(const Key('feedback-input')), '提交中锁定附件');
      await tester.pump();

      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(find.text('提交中…'), findsOneWidget);
      expect(find.byKey(addKey), findsNothing,
          reason: '提交中：附件（含日志）不可修改');
      expect(panelOf(tester).logs.length, 1, reason: '提交期间日志快照保留');

      gate.complete(jsonResponse(
          <String, Object>{'feedbackId': 'f-lock', 'status': 'received'}, 201));
      await tester.pump();
      await tester.pump();
      expect(find.text('已接收'), findsOneWidget);
      expect(find.byKey(addKey), findsNothing,
          reason: '轮询期间同样锁定附件修改');

      await teardown(tester);
    });

    testWidgets('提交成功后日志清空（随反馈归档），新草稿重新采集', (tester) async {
      int calls = 0;
      server.respondPost(<String, Object>{
        'feedbackId': 'f-archived',
        'status': 'received',
      });
      server.respondGet('f-archived', <String, Object>{
        'id': 'f-archived',
        'status': 'archived',
      });
      await pumpHost(
        tester,
        logProvider: () async {
          calls++;
          return <FeedbackLogFile>[file('draft$calls.log', 'line\n')];
        },
      );
      final FeedbackController controller =
          tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);
      expect(panelOf(tester).logs.single.name, 'draft1.log');

      await tester.enterText(find.byKey(const Key('feedback-input')), '第一条反馈');
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(panelOf(tester).logs, isEmpty,
          reason: '提交成功后日志随反馈归档，草稿不再持有');

      // 「继续反馈」开新草稿：关闭重开后重新采集一次。
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('已归档'), findsOneWidget);
      await tester.tap(find.byKey(const Key('feedback-continue')));
      await tester.pump();
      expect(panelOf(tester).logs, isEmpty);

      await closePanel(tester);
      await openPanel(tester, controller);
      await pumpUntil(tester, () => panelOf(tester).logs.length == 1);
      expect(calls, 2, reason: '新草稿首次打开重新采集一次');
      expect(find.text('draft2.log'), findsOneWidget);

      await teardown(tester);
    });
  });
}
