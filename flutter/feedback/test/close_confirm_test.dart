import 'dart:async';
import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 关闭前确认（2026-11-23）：0.14.0 起关闭面板即放弃本次未提交的反馈，
/// 所以用户**亲手写 / 加**的内容（正文、手动图片、手动日志）在关闭前先问一句；
/// 自动截图与自动采集的日志不触发确认；宿主的 `controller.close()` 不弹窗。
void main() {
  // 1x1 PNG（合法图片字节）。
  final Uint8List png = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

  Future<void> pumpHost(
    WidgetTester tester,
    FeedbackController controller, {
    FeedbackCaptureMode captureMode = FeedbackCaptureMode.off,
    FeedbackImagePicker? imagePicker,
  }) async {
    await tester.binding.setSurfaceSize(const Size(900, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.test',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: captureMode,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: captureMockClient(),
        imagePicker: imagePicker,
        child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
      ),
    ));
    await tester.pump();
  }

  Finder input() => find.byKey(const Key('feedback-input'));
  Finder dialog() => find.byKey(const Key('feedback-discard-confirm'));

  Future<FeedbackPanelState> openPanel(
      WidgetTester tester, FeedbackController controller) async {
    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    return tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
  }

  testWidgets('只有自动截图：关闭不弹确认，直接关闭（自动内容不算用户草稿）',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller,
        captureMode: FeedbackCaptureMode.viewport);

    await tester.tap(find.byKey(const Key('feedback-orb')));
    await tester.pump();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    expect(panel.hasAbandonableWork, isFalse);

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(dialog(), findsNothing, reason: '自动截图不触发确认');
    expect(controller.isOpen, isFalse);
  });

  testWidgets('有正文：关闭先确认；继续编辑保留内容，放弃才关闭并清空',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    await tester.enterText(input(), '这段草稿不能丢');
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(dialog(), findsOneWidget, reason: '有正文时关闭先问一句');

    // 「继续编辑」：留在面板，草稿原样保留。
    await tester.tap(find.byKey(const Key('feedback-discard-cancel')));
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(tester.widget<TextField>(input()).controller!.text, '这段草稿不能丢');
    expect(panel.hasDraft, isTrue);

    // 对话框里按 Esc 同样是「继续编辑」。
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(dialog(), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(dialog(), findsNothing);
    expect(controller.isOpen, isTrue);

    // 「放弃」：关闭并按 0.14.0 语义丢弃，重开是空白撰写页。
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-discard-ok')));
    await tester.pump();
    expect(controller.isOpen, isFalse);
    await openPanel(tester, controller);
    expect(tester.widget<TextField>(input()).controller!.text, isEmpty);
  });

  testWidgets('Esc 与遮罩关闭同样先确认', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await openPanel(tester, controller);
    await tester.enterText(input(), 'Esc 也要确认');
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(dialog(), findsOneWidget, reason: 'Esc 关闭也要先确认');
    await tester.tap(find.byKey(const Key('feedback-discard-ok')));
    await tester.pump();
    expect(controller.isOpen, isFalse);
  });

  testWidgets('宿主 controller.close() 不弹窗，立即关闭', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await openPanel(tester, controller);
    await tester.enterText(input(), '程序化关闭不做确认');
    await tester.pump();

    controller.close();
    await tester.pump();
    expect(dialog(), findsNothing);
    expect(controller.isOpen, isFalse);
  });

  testWidgets('手动添加的日志会触发确认（自动采集的不算）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    expect(panel.hasAbandonableWork, isFalse);
    panel.addLog(FeedbackLogFile(
      filename: 'manual.log',
      bytes: Uint8List.fromList(<int>[104, 105]),
      source: 'manual',
    ));
    await tester.pump();
    expect(panel.hasAbandonableWork, isTrue);

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(dialog(), findsOneWidget);
    await tester.tap(find.byKey(const Key('feedback-discard-cancel')));
    await tester.pump();
    expect(controller.isOpen, isTrue);
  });

  testWidgets('手动添加的图片会触发确认', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller,
        imagePicker: () => <FeedbackImageFile>[
              FeedbackImageFile(
                id: 'manual-1',
                filename: 'manual.png',
                bytes: png,
                mime: 'image/png',
              ),
            ]);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
    await pumpUntil(tester, () => panel.imageCount == 1);
    await tester.pump();
    expect(panel.hasAbandonableWork, isTrue);

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(dialog(), findsOneWidget);
    await tester.tap(find.byKey(const Key('feedback-discard-cancel')));
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(panel.imageCount, 1);
  });

  testWidgets('安卓返回手势：面板打开且有正文时先确认，不弹回宿主页面',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await openPanel(tester, controller);
    await tester.enterText(input(), '返回键要保住的内容');
    await tester.pump();

    unawaited(tester.binding.handlePopRoute());
    await tester.pump();
    await tester.pump();
    expect(dialog(), findsOneWidget, reason: '返回手势先问一句');

    await tester.tap(find.byKey(const Key('feedback-discard-cancel')));
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(
        tester.widget<TextField>(input()).controller!.text, '返回键要保住的内容');

    unawaited(tester.binding.handlePopRoute());
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-discard-ok')));
    await tester.pump();
    expect(controller.isOpen, isFalse);
  });
}