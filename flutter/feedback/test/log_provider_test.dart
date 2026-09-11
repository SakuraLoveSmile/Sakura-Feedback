import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _MockLogServer {
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  final List<http.Request> standardRequests = <http.Request>[];
  final List<http.MultipartRequest> multipartRequests = <http.MultipartRequest>[];

  http.Client get client => MockClient.streaming((http.BaseRequest request, http.ByteStream body) async {
        requests.add(request);
        if (request is http.Request) {
          standardRequests.add(request);
        } else if (request is http.MultipartRequest) {
          multipartRequests.add(request);
        }
        final path = Uri.parse(request.url.toString()).path;
        if (path == '/api/feedback') {
          return http.StreamedResponse(
            Stream.value(utf8.encode(jsonEncode({'feedbackId': 'fb-test-123', 'status': 'received'}))),
            201,
            headers: const <String, String>{'content-type': 'application/json'},
          );
        }
        if (path.startsWith('/api/feedback/')) {
          return http.StreamedResponse(
            Stream.value(utf8.encode(jsonEncode({'id': 'fb-test-123', 'status': 'archived'}))),
            200,
            headers: const <String, String>{'content-type': 'application/json'},
          );
        }
        return http.StreamedResponse(
          Stream.value(utf8.encode(jsonEncode({'error': {'code': 'not_found'}}))),
          404,
          headers: const <String, String>{'content-type': 'application/json'},
        );
      });
}

Future<void> _pumpPanel(
  WidgetTester tester, {
  required _MockLogServer server,
  required FeedbackTokenStore tokenStore,
  required FeedbackConfig config,
  Size surface = const Size(1000, 800),
}) async {
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: FeedbackPanel(
        config: config,
        tokenStore: tokenStore,
        httpClient: server.client,
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  const inputKey = Key('feedback-input');
  const submitKey = Key('feedback-submit');
  const addLogBtnKey = Key('feedback-add-log-btn');

  late MemoryTokenStore tokenStore;
  late _MockLogServer server;

  setUp(() {
    tokenStore = MemoryTokenStore('test-token');
    server = _MockLogServer();
  });

  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  }

  testWidgets('未配置日志回调时：只显示手动添加入口，不自动采集', (WidgetTester tester) async {
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);

    expect(find.byKey(addLogBtnKey), findsOneWidget);
    expect(find.text('正在获取日志…'), findsNothing);
    expect(find.textContaining('日志附件 (0/3)'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('新草稿首次打开自动采集，正常展示文件名、大小、来源（自动）与归档说明', (WidgetTester tester) async {
    final logBytes = Uint8List.fromList(utf8.encode('2026-04-01 INFO test line\n'));
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'app.log', bytes: logBytes),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    expect(find.textContaining('app.log'), findsOneWidget);
    expect(find.text('自动'), findsOneWidget);
    expect(find.text('日志将附带提交并参与 AI 诊断与 Kaneo 归档。'), findsOneWidget);
    expect(find.textContaining('日志附件 (1/3)'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('超时（3秒）后显示「日志获取失败」，提供重试与不带日志继续提交', (WidgetTester tester) async {
    final completer = Completer<List<FeedbackLogPart>>();
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () => completer.future,
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    expect(find.text('正在获取日志…'), findsOneWidget);

    // 推进 3 秒触发超时
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(find.text('日志获取失败'), findsOneWidget);
    expect(find.byKey(const Key('feedback-retry-log-btn')), findsOneWidget);
    expect(find.byKey(const Key('feedback-ignore-log-btn')), findsOneWidget);

    // 点击「不带日志继续提交」
    await tester.tap(find.byKey(const Key('feedback-ignore-log-btn')));
    await tester.pumpAndSettle();

    expect(find.text('日志获取失败'), findsNothing);

    await teardown(tester);
  });

  testWidgets('迟到结果不写回：切换 apiBase 或 appId 后旧请求结果丢弃', (WidgetTester tester) async {
    final completer = Completer<List<FeedbackLogPart>>();
    final config1 = FeedbackConfig(
      'https://fb1.example.com',
      'com.example.app1',
      logProvider: () => completer.future,
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config1);
    expect(find.text('正在获取日志…'), findsOneWidget);

    // 切换为 config2
    final config2 = FeedbackConfig(
      'https://fb2.example.com',
      'com.example.app2',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'new.log', bytes: Uint8List.fromList(utf8.encode('new'))),
      ],
    );

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: FeedbackPanel(
          config: config2,
          tokenStore: tokenStore,
          httpClient: server.client,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    // 此时旧 completer 迟到返回
    completer.complete(<FeedbackLogPart>[
      FeedbackLogPart(name: 'late.log', bytes: Uint8List.fromList(utf8.encode('late'))),
    ]);
    await tester.pumpAndSettle();

    // 只应该有 new.log，没有 late.log
    expect(find.textContaining('new.log'), findsOneWidget);
    expect(find.textContaining('late.log'), findsNothing);

    await teardown(tester);
  });

  testWidgets('迟到结果不写回：销毁 (dispose) 后迟到结果不触发 setState', (WidgetTester tester) async {
    final completer = Completer<List<FeedbackLogPart>>();
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () => completer.future,
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    // 销毁面板
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    // 完成迟到 Future
    completer.complete(<FeedbackLogPart>[
      FeedbackLogPart(name: 'late.log', bytes: Uint8List.fromList(utf8.encode('late'))),
    ]);
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull);
  });

  testWidgets('3个文件上限、1 MiB单文件、扩展名与 UTF-8 边界校验（且不截断）', (tester) async {
    // 1. 扩展名白名单校验
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'test.exe',
        bytes: Uint8List.fromList(utf8.encode('abc')),
      ),
      contains('仅支持 .log / .txt / .json / .jsonl 文件'),
    );

    // 2. 空文件
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'empty.log',
        bytes: Uint8List(0),
      ),
      contains('日志文件不能为空'),
    );

    // 3. 超 1 MiB
    final largeBytes = Uint8List(FeedbackPanelState.kMaxLogBytes + 1);
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'large.txt',
        bytes: largeBytes,
      ),
      contains('不能超过 1 MiB'),
    );

    // 4. 含 NUL (U+0000)
    final nulBytes = Uint8List.fromList(<int>[0x68, 0x65, 0x00, 0x6c, 0x6f]);
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'nul.json',
        bytes: nulBytes,
      ),
      contains('不能包含 NUL 字符'),
    );

    // 5. 非有效 UTF-8
    final invalidUtf8 = Uint8List.fromList(<int>[0xFF, 0xFE, 0xFD]);
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'bad.log',
        bytes: invalidUtf8,
      ),
      contains('UTF-8'),
    );

    // 6. 正常合规文件
    expect(
      FeedbackPanelState.validateLogFile(
        name: 'ok.jsonl',
        bytes: Uint8List.fromList(utf8.encode('{"ok":true}')),
      ),
      isNull,
    );
  });

  testWidgets('移除日志后不自动补回；预览纯文本对话框功能', (WidgetTester tester) async {
    final logBytes = Uint8List.fromList(utf8.encode('LINE 1\nLINE 2\n'));
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'app.log', bytes: logBytes),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    expect(find.textContaining('app.log'), findsOneWidget);

    // 点击预览
    await tester.tap(find.byKey(const Key('feedback-preview-log-0')));
    await tester.pumpAndSettle();

    expect(find.textContaining('LINE 1'), findsOneWidget);
    // 关闭预览
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();

    // 点击移除
    await tester.tap(find.byKey(const Key('feedback-remove-log-0')));
    await tester.pumpAndSettle();

    expect(find.textContaining('app.log'), findsNothing);
    expect(find.textContaining('日志附件 (0/3)'), findsOneWidget);

    // 等待一段时间，确认不会自动补回
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('app.log'), findsNothing);

    await teardown(tester);
  });

  testWidgets('提交走 multipart：包含 logs 部件与 metadata.logs 来源记录，顺序严格一致', (WidgetTester tester) async {
    final log1 = Uint8List.fromList(utf8.encode('log 1 bytes'));
    final log2 = Uint8List.fromList(utf8.encode('log 2 bytes'));
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'app1.log', bytes: log1),
        FeedbackLogPart(name: 'app2.txt', bytes: log2),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    // 输入描述并提交
    await tester.enterText(find.byKey(inputKey), '反馈有日志的问题');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(submitKey));
    await tester.pumpAndSettle();

    expect(server.multipartRequests.length, 1);
    final req = server.multipartRequests.first;
    expect(req.fields.containsKey('metadata'), isTrue);

    final metadata = jsonDecode(req.fields['metadata']!) as Map<String, dynamic>;
    expect(metadata['text'], '反馈有日志的问题');
    final logsMeta = metadata['logs'] as List<dynamic>;
    expect(logsMeta.length, 2);
    expect(logsMeta[0]['name'], 'app1.log');
    expect(logsMeta[0]['source'], 'auto');
    expect(logsMeta[1]['name'], 'app2.txt');
    expect(logsMeta[1]['source'], 'auto');

    // 检查 multipart files
    final logFiles = req.files.where((f) => f.field == 'logs').toList();
    expect(logFiles.length, 2);
    expect(logFiles[0].filename, 'app1.log');
    expect(logFiles[0].contentType.mimeType, 'text/plain');
    expect(logFiles[1].filename, 'app2.txt');
    expect(logFiles[1].contentType.mimeType, 'text/plain');

    await teardown(tester);
  });

  testWidgets('无截图且无日志时：保持原 JSON 请求形态', (WidgetTester tester) async {
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(inputKey), '纯文本反馈');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(submitKey));
    await tester.pumpAndSettle();

    expect(server.standardRequests.length, 1);
    expect(server.multipartRequests.isEmpty, isTrue);

    final req = server.standardRequests.first;
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    expect(body['text'], '纯文本反馈');
    expect(body.containsKey('logs'), isFalse);

    await teardown(tester);
  });

  testWidgets('提交失败保留原快照，修改附件（移除/修改日志）后生成新幂等键，未修改时重发沿用同 key', (WidgetTester tester) async {
    final logBytes = Uint8List.fromList(utf8.encode('app log'));
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'app.log', bytes: logBytes),
      ],
    );

    final faultServer = MockClient((request) async {
      // 模拟网络故障异常
      throw http.ClientException('Simulated network error');
    });

    await tester.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: FeedbackPanel(
          config: config,
          tokenStore: tokenStore,
          httpClient: faultServer,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(inputKey), '第一次提交文本');
    await tester.pumpAndSettle();

    // 第一次提交 -> 网络错误进入 notSent
    await tester.tap(find.byKey(submitKey));
    await tester.pumpAndSettle();

    expect(find.text('重试提交'), findsOneWidget);
    final panelState = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

    // 记录当前的快照与 idempotencyKey
    final key1 = panelState.idempotencyKey;
    expect(key1, isNotNull);

    // 此时不修改任何附件与文本，再次点击重试提交
    await tester.tap(find.byKey(submitKey));
    await tester.pumpAndSettle();

    // 快照未变，仍沿用 key1
    expect(panelState.idempotencyKey, equals(key1));

    // 修改附件：移除日志
    await tester.tap(find.byKey(const Key('feedback-remove-log-0')));
    await tester.pumpAndSettle();

    // 再次提交
    await tester.tap(find.byKey(submitKey));
    await tester.pumpAndSettle();

    // 附件变动后生成了新幂等键
    final key2 = panelState.idempotencyKey;
    expect(key2, isNotNull);
    expect(key2, isNot(equals(key1)));

    await teardown(tester);
  });

  testWidgets('自动采集校验不静默丢弃 (a) 超 1MiB 文件：展示明确提示且不加入列表', (WidgetTester tester) async {
    final oversizedBytes = Uint8List(FeedbackPanelState.kMaxLogBytes + 10);
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'oversized.log', bytes: oversizedBytes),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    final panelState = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panelState.logs, isEmpty);
    expect(find.byKey(const Key('feedback-log-collect-error')), findsOneWidget);
    expect(find.textContaining('oversized.log: 单个日志文件不能超过 1 MiB'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('自动采集校验不静默丢弃 (b) 非 UTF-8 或含 NUL 文件：展示明确提示且不加入列表', (WidgetTester tester) async {
    // 包含 NUL 字符
    final nulBytes = Uint8List.fromList(<int>[0x61, 0x62, 0x00, 0x63]);
    final configNul = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'nul.json', bytes: nulBytes),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: configNul);
    await tester.pumpAndSettle();

    final panelStateNul = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panelStateNul.logs, isEmpty);
    expect(find.byKey(const Key('feedback-log-collect-error')), findsOneWidget);
    expect(find.textContaining('nul.json: 日志不能包含 NUL 字符'), findsOneWidget);

    await teardown(tester);

    // 非 UTF-8
    final invalidUtf8 = Uint8List.fromList(<int>[0xFF, 0xFE, 0xFD]);
    final configInvalidUtf8 = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'invalid.txt', bytes: invalidUtf8),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: configInvalidUtf8);
    await tester.pumpAndSettle();

    final panelStateUtf8 = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panelStateUtf8.logs, isEmpty);
    expect(find.byKey(const Key('feedback-log-collect-error')), findsOneWidget);
    expect(find.textContaining('invalid.txt: 日志必须是有效的 UTF-8 文本'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('自动采集校验不静默丢弃 (c) 4 个文件：超过 3 个上限明确提示且不静默截取', (WidgetTester tester) async {
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'log1.log', bytes: Uint8List.fromList(utf8.encode('1'))),
        FeedbackLogPart(name: 'log2.log', bytes: Uint8List.fromList(utf8.encode('2'))),
        FeedbackLogPart(name: 'log3.log', bytes: Uint8List.fromList(utf8.encode('3'))),
        FeedbackLogPart(name: 'log4.log', bytes: Uint8List.fromList(utf8.encode('4'))),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    final panelState = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panelState.logs, isEmpty);
    expect(find.byKey(const Key('feedback-log-collect-error')), findsOneWidget);
    expect(find.textContaining('日志数量超过 3 个上限'), findsOneWidget);

    await teardown(tester);
  });

  testWidgets('自动采集校验不静默丢弃 (d) 总量超 3MiB：明确提示且不加入列表', (WidgetTester tester) async {
    // 2 个文件，每个 1.6 MiB，总计 3.2 MiB (> 3 MiB)
    final chunk = Uint8List(1600000);
    final config = FeedbackConfig(
      'https://fb.example.com',
      'com.example.app',
      logProvider: () async => <FeedbackLogPart>[
        FeedbackLogPart(name: 'part1.log', bytes: chunk),
        FeedbackLogPart(name: 'part2.log', bytes: chunk),
      ],
    );

    await _pumpPanel(tester, server: server, tokenStore: tokenStore, config: config);
    await tester.pumpAndSettle();

    final panelState = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panelState.logs, isEmpty);
    expect(find.byKey(const Key('feedback-log-collect-error')), findsOneWidget);
    expect(find.textContaining('日志文件总大小不能超过 3 MiB'), findsOneWidget);

    await teardown(tester);
  });
}
