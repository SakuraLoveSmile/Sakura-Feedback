import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'panel_harness.dart';

void main() {
  group('L1-Flutter: 日志附件（自动采集、手动选择、预览、移除与冻结提交）', () {
    late PanelServer server;
    late RecordingTokenStore tokenStore;

    setUp(() {
      server = PanelServer();
      tokenStore = RecordingTokenStore('valid-token');
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    });

    testWidgets('logProvider 自动采集：打开面板时自动调用，列表渲染正确', (WidgetTester tester) async {
      final log1 = FeedbackLogFile(
        filename: 'app.log',
        bytes: Uint8List.fromList(utf8.encode('app log line 1\nline 2')),
      );
      final log2 = FeedbackLogFile(
        filename: 'info.txt',
        bytes: Uint8List.fromList(utf8.encode('info details')),
      );

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          logProvider: () async => [log1, log2],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-logs-count')), findsOneWidget);
      expect(find.text('日志附件 (2/3)'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-name-0')), findsOneWidget);
      expect(find.text('app.log'), findsOneWidget);
      expect(find.text('info.txt'), findsOneWidget);

      expect(find.byKey(const Key('feedback-log-badge-0')), findsOneWidget);
      expect(find.text('自动'), findsNWidgets(2));

      await teardownPanel(tester);
    });

    testWidgets('logProvider 超时保护：超过 3 秒抛错不阻塞面板，显示超时提示且用户可正常输入提交',
        (WidgetTester tester) async {
      final completer = Completer<List<FeedbackLogFile>?>();
      server.respond('POST /api/feedback', {
        'feedbackId': 'fb-timeout',
        'status': 'received',
      }, 201);

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          logProvider: () => completer.future,
        ),
      );
      // 快进 3.5 秒等待超时
      await tester.pump(const Duration(milliseconds: 3200));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-log-error')), findsOneWidget);
      expect(find.textContaining('超时'), findsOneWidget);

      // 用户正常输入并提交
      await tester.enterText(find.byKey(const Key('feedback-input')), '超时但正常提交');
      await tester.pump();
      await tester.tap(find.text('提交'));
      await tester.pumpAndSettle();

      expect(server.count('POST /api/feedback'), 1);

      await teardownPanel(tester);
    });

    testWidgets('手动选择日志文件：检查扩展名、大小限制与最多 3 个限制', (WidgetTester tester) async {
      List<FeedbackLogFile> pickedFiles = [];

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () => pickedFiles,
        ),
      );
      await tester.pumpAndSettle();

      // 1. 不支持的扩展名 (.png)
      pickedFiles = [
        FeedbackLogFile(
          filename: 'shot.png',
          bytes: Uint8List.fromList([1, 2, 3]),
          source: 'manual',
        ),
      ];
      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-log-error')), findsOneWidget);
      expect(find.textContaining('格式不受支持'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-0')), findsNothing);

      // 2. 超出 1MiB 限制
      final hugeBytes = Uint8List(1024 * 1024 + 10);
      pickedFiles = [
        FeedbackLogFile(
          filename: 'huge.log',
          bytes: hugeBytes,
          source: 'manual',
        ),
      ];
      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      expect(find.textContaining('超过 1MiB 限制'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-0')), findsNothing);

      // 3. 正常添加 3 个有效日志 (.log, .txt, .json)
      pickedFiles = [
        FeedbackLogFile(
          filename: 'client.log',
          bytes: Uint8List.fromList(utf8.encode('line 1')),
          source: 'manual',
        ),
        FeedbackLogFile(
          filename: 'system.txt',
          bytes: Uint8List.fromList(utf8.encode('info')),
          source: 'manual',
        ),
        FeedbackLogFile(
          filename: 'events.json',
          bytes: Uint8List.fromList(utf8.encode('{"ok":true}')),
          source: 'manual',
        ),
        FeedbackLogFile(
          filename: 'overflow.log',
          bytes: Uint8List.fromList(utf8.encode('extra')),
          source: 'manual',
        ),
      ];
      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-log-item-0')), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-1')), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-2')), findsOneWidget);
      expect(find.text('日志附件 (3/3)'), findsOneWidget);
      expect(find.textContaining('最多附加 3 个'), findsOneWidget);
      // 满 3 个后添加按钮不可见
      expect(find.byKey(const Key('feedback-btn-add-log')), findsNothing);

      await teardownPanel(tester);
    });

    testWidgets('文本预览与移除日志：支持纯文本弹窗查看，关闭退出，删除后更新列表与计数',
        (WidgetTester tester) async {
      final log = FeedbackLogFile(
        filename: 'debug.log',
        bytes: Uint8List.fromList(utf8.encode('Line A\nLine B')),
        source: 'manual',
      );

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () => [log],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      expect(find.text('日志附件 (1/3)'), findsOneWidget);

      // 预览日志
      await tester.tap(find.byKey(const Key('feedback-log-btn-preview-0')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-log-preview-dialog')), findsOneWidget);
      expect(find.text('Line A\nLine B'), findsOneWidget);

      // 关闭预览弹窗
      await tester.tap(find.byKey(const Key('feedback-log-preview-close')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-log-preview-dialog')), findsNothing);

      // 移除日志
      await tester.tap(find.byKey(const Key('feedback-log-btn-remove-0')));
      await tester.pumpAndSettle();

      expect(find.text('日志附件 (0/3)'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-0')), findsNothing);

      await teardownPanel(tester);
    });

    testWidgets('提交快照冻结与 multipart 契约：提交期间携带日志描述符与日志文件',
        (WidgetTester tester) async {
      server.respond('POST /api/feedback', {
        'feedbackId': 'fb-with-logs',
        'status': 'received',
      }, 201);

      final log1 = FeedbackLogFile(
        filename: 'crash.log',
        bytes: Uint8List.fromList(utf8.encode('crash detail')),
        source: 'manual',
      );

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () => [log1],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('feedback-input')), '带有日志的反馈');
      await tester.pump();
      await tester.tap(find.text('提交'));
      await tester.pumpAndSettle();

      expect(server.count('POST /api/feedback'), 1);
      final req = server.lastMatching('POST /api/feedback');
      expect(req.headers['content-type'], contains('multipart/form-data'));

      expect(req.body, contains('带有日志的反馈'));
      expect(req.body, contains('"filename":"crash.log"'));
      expect(req.body, contains('"source":"manual"'));
      expect(req.body, contains('crash detail'));

      // 提交成功后进入状态页，草稿与日志列表被清空
      expect(find.text('已接收'), findsOneWidget);
      final panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.logs.isEmpty, isTrue);

      await teardownPanel(tester);
    });

    testWidgets('提交失败重试：复用同一幂等键与日志快照；修改日志后生成新键', (WidgetTester tester) async {
      int postCount = 0;
      final keys = <String>[];

      server.on('POST /api/feedback', (req) async {
        postCount++;
        final match = RegExp(r'"idempotencyKey":"([^"]+)"').firstMatch(req.body);
        if (match != null) {
          keys.add(match.group(1)!);
        }

        if (postCount == 1) {
          throw http.ClientException('网络中断');
        }
        return jsonResponse({'feedbackId': 'fb-retry-ok', 'status': 'received'}, 201);
      });

      final log = FeedbackLogFile(
        filename: 'retry.log',
        bytes: Uint8List.fromList(utf8.encode('retry log')),
        source: 'manual',
      );

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () => [log],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('feedback-input')), '待重试反馈');
      await tester.pump();
      await tester.tap(find.text('提交'));
      await tester.pumpAndSettle();

      expect(postCount, 1);
      expect(find.text('重试提交'), findsOneWidget);
      // 日志仍然保留
      expect(find.text('日志附件 (1/3)'), findsOneWidget);

      // 直接重试，无任何修改 -> 复用相同幂等键
      await tester.tap(find.text('重试提交'));
      await tester.pumpAndSettle();

      expect(postCount, 2);
      expect(keys.length, 2);
      expect(keys[0], keys[1]);

      // 提交成功后进入已接收状态
      expect(find.text('已接收'), findsOneWidget);

      await teardownPanel(tester);
    });

    testWidgets('修改日志后重试：生成新幂等键并提交新快照', (WidgetTester tester) async {
      int postCount = 0;
      final keys = <String>[];

      server.on('POST /api/feedback', (req) async {
        postCount++;
        final match = RegExp(r'"idempotencyKey":"([^"]+)"').firstMatch(req.body);
        if (match != null) {
          keys.add(match.group(1)!);
        }

        if (postCount == 1) {
          throw http.ClientException('网络中断');
        }
        return jsonResponse({'feedbackId': 'fb-retry-changed', 'status': 'received'}, 201);
      });

      final log = FeedbackLogFile(
        filename: 'remove_me.log',
        bytes: Uint8List.fromList(utf8.encode('delete this')),
        source: 'manual',
      );

      await pumpPanel(
        tester,
        server: server,
        tokenStore: tokenStore,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () => [log],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('feedback-input')), '待修改重试');
      await tester.pump();
      await tester.tap(find.text('提交'));
      await tester.pumpAndSettle();

      expect(postCount, 1);
      expect(find.text('重试提交'), findsOneWidget);

      // 移除日志修改了快照
      await tester.tap(find.byKey(const Key('feedback-log-btn-remove-0')));
      await tester.pumpAndSettle();

      // 点击重试提交 -> 应生成新 key
      await tester.tap(find.text('重试提交'));
      await tester.pumpAndSettle();

      expect(postCount, 2);
      expect(keys.length, 2);
      expect(keys[0] != keys[1], isTrue);
      expect(find.text('已接收'), findsOneWidget);

      await teardownPanel(tester);
    });
  });
}
