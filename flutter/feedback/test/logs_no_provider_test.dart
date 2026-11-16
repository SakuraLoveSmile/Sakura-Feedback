// Flutter 侧「宿主未接入日志采集」的可见提示。
//
// 缺口背景：`docs/integration.md` 5.6 要求宿主必须通过 `logProvider` 接入真实诊断
// 日志，但漏接时界面上原本没有任何痕迹——「重新采集」照样显示、摘要照样是「暂无日志」，
// 用户与接入者都看不出这台宿主根本没接自动采集。Web 侧对应 `.fb-logs-no-provider`。
//
// 这里锁三件事：
//  1. 未配置 `logProvider` → 展开日志区后出现 `feedback-logs-no-provider` 说明；
//  2. 配置了 `logProvider` → 不出现该说明；
//  3. 说明只是提示：未接入时仍可手动添加日志文件，不影响附件列表。
import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'panel_harness.dart';

FeedbackLogFile _log(String name) => FeedbackLogFile(
      filename: name,
      bytes: Uint8List.fromList(utf8.encode(name)),
      source: 'manual',
    );

void main() {
  group('日志采集未接入提示（5.6 强制接入的运行时信号）', () {
    late PanelServer server;

    setUp(() {
      server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    });

    testWidgets('未配置 logProvider：展开日志区后出现说明，收起时不渲染',
        (WidgetTester tester) async {
      await pumpPanel(tester, server: server);
      await tester.pumpAndSettle();

      // 折叠态：说明在详情区里，未展开不占版面。
      expect(find.byKey(const Key('feedback-logs-no-provider')), findsNothing);

      await tester.tap(find.byKey(const Key('feedback-logs-expand')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-logs-no-provider')), findsOneWidget);
      expect(find.text('未配置自动采集器，可手动添加日志文件'), findsOneWidget);

      await teardownPanel(tester);
    });

    testWidgets('配置了 logProvider：不出现未接入说明', (WidgetTester tester) async {
      await pumpPanel(
        tester,
        server: server,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          logProvider: () async => <FeedbackLogFile>[_log('host.log')],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-logs-expand')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-logs-no-provider')), findsNothing);
      expect(find.text('未配置自动采集器，可手动添加日志文件'), findsNothing);
      // 自动采集本身照常生效。
      expect(find.text('host.log'), findsOneWidget);

      await teardownPanel(tester);
    });

    testWidgets('未配置 logProvider：仍可手动添加日志，说明不阻断附件',
        (WidgetTester tester) async {
      await pumpPanel(
        tester,
        server: server,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          filePicker: () async => <FeedbackLogFile>[_log('manual.log')],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('feedback-btn-add-log')));
      await tester.pumpAndSettle();

      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.logs.map((FeedbackLogFile f) => f.filename), ['manual.log']);

      // 手动添加会顺带展开日志区（既有行为），因此这里不再点折叠按钮。
      expect(find.text('manual.log'), findsOneWidget);
      // 手动加进来之后，仍然提示「没有自动采集器」——这正是接入未完成的事实。
      expect(find.byKey(const Key('feedback-logs-no-provider')), findsOneWidget);

      await teardownPanel(tester);
    });
  });
}
