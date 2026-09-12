import 'dart:convert';

import 'package:feedback_example/host_logs.dart';
import 'package:feedback_example/main.dart';
import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 等待条件成立（面板挂载 / 日志采集完成需要若干帧）。
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() cond, {
  String reason = 'pumpUntil 等待超时',
}) async {
  for (int i = 0; i < 200; i++) {
    if (cond()) {
      await tester.pump();
      return;
    }
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail(reason);
}

void main() {
  setUp(() => hostLogs.clear());

  group('宿主日志环形缓冲', () {
    test('超出容量丢弃最旧的行', () {
      final HostLogBuffer buffer = HostLogBuffer(capacity: 3);
      buffer.info('a');
      buffer.warn('b');
      buffer.error('c');
      buffer.info('d');

      expect(buffer.length, 3);
      expect(buffer.lines.first, contains('[WARN] b'));
      expect(buffer.lines.last, contains('[INFO] d'));
      expect(buffer.lines.any((String line) => line.endsWith('a')), isFalse);
    });

    test('导出为组件可直接接受的 .log 字节（非空 / 严格 UTF-8 / 已脱敏）', () async {
      final HostLogBuffer buffer = HostLogBuffer();
      buffer.info('登录 password=hunter2 成功');
      buffer.warn('token=abc123 即将过期');

      final List<FeedbackLogFile> files = await buffer.export();
      expect(files, hasLength(1));
      expect(files.single.name, 'host-app.log');

      final String text =
          utf8.decode(files.single.bytes, allowMalformed: false);
      expect(text, contains('password=***'));
      expect(text, contains('token=***'));
      expect(text, isNot(contains('hunter2')));
      expect(text, isNot(contains('abc123')));
      // 直接交给组件校验：合法（宿主负责脱敏，组件负责格式与上限）。
      expect(
        validateFeedbackLogFile(files.single.name, files.single.bytes),
        isNull,
      );
    });

    test('空缓冲导出仍非空，不会被组件按「内容非空」拒绝', () async {
      final HostLogBuffer buffer = HostLogBuffer();
      final List<FeedbackLogFile> files = await buffer.export();
      expect(
        validateFeedbackLogFile(files.single.name, files.single.bytes),
        isNull,
      );
    });
  });

  testWidgets('示例接入：打开面板自动采集宿主日志（来源自动）', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    hostLogs.info('冒烟测试写入的宿主日志');
    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();
    expect(find.byKey(const Key('feedback-example-log-summary')), findsOneWidget);

    final FeedbackController controller =
        tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
    // 普通呼出（不截图）：面板挂载即新草稿首次打开。
    controller.open();
    await pumpUntil(
      tester,
      () => find
          .byType(FeedbackPanel, skipOffstage: false)
          .evaluate()
          .isNotEmpty,
      reason: '面板未挂载',
    );
    final Finder panelFinder =
        find.byType(FeedbackPanel, skipOffstage: false);
    await pumpUntil(
      tester,
      () => tester
          .state<FeedbackPanelState>(panelFinder)
          .logs
          .isNotEmpty,
      reason: '示例未把 hostLogs.export 接到 logProvider',
    );

    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(panelFinder);
    expect(panel.logs, hasLength(1));
    expect(panel.logs.single.name, 'host-app.log');
    expect(panel.logs.single.source, FeedbackLogSource.auto);
    final String text =
        utf8.decode(panel.logs.single.bytes, allowMalformed: false);
    expect(text, contains('冒烟测试写入的宿主日志'));
    expect(text, contains('内存环形缓冲'));
    // 采集中允许编辑描述：输入框仍在（无论当前是否已登录）。
    expect(panel.hasCollectedLogs, isTrue);

    controller.close();
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('示例入口：写入一条运行日志会被下一次导出带上', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1000, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();
    final int before = hostLogs.length;

    await tester.tap(find.byKey(const Key('feedback-example-log-append')));
    await tester.pump();
    expect(hostLogs.length, before + 1);
    expect(hostLogs.lines.last, contains('手动写入一条演示日志'));

    // 清空入口：缓冲为空时导出仍可用（不会产出空文件）。
    await tester.tap(find.byKey(const Key('feedback-example-log-clear')));
    await tester.pump();
    expect(hostLogs.length, 0);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });
}
