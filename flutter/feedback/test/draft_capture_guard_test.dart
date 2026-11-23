import 'dart:async';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 草稿守卫与「关闭即放弃」回归：
/// 1. 关闭面板 = 放弃本次未提交的反馈（2026-11-24 裁决）：再次呼出重新截图、
///    正文 / 图片 / 日志都不回到面板——手机端截图后手动关闭反馈页，再次唤醒
///    灵感球必须开始新的反馈，而不是回到刚才那条；
/// 2. 面板仍打开时宿主主动要截图（[FeedbackController.captureAndOpen]）不得
///    覆盖正在编辑的草稿；拖动灵感球在关闭后是明确重截；
/// 3. 非关闭的中断（重拍失败 / 重拍取消）不得清掉草稿文本与旧截图。
void main() {
  Future<void> pumpGuardHost(
    WidgetTester tester,
    FeedbackController controller, {
    FeedbackLauncherMode launcherMode = FeedbackLauncherMode.tab,
    Color hostColor = Colors.blue,
  }) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      launcherMode: launcherMode,
      child: SizedBox.expand(child: ColoredBox(color: hostColor)),
    ));
    await tester.pump();
  }

  /// 给（可能存在的）捕获流程足够时间跑完：避免把"还没跑完"误判成"没重拍"。
  Future<void> allowCaptureToFinish(WidgetTester tester) async {
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
    }
  }

  /// 等待重拍流程收敛（面板重新可见即捕获会话已结束）。
  Future<void> pumpUntilPanelRestored(WidgetTester tester) async {
    for (int i = 0; i < 100; i++) {
      await tester.pump(const Duration(milliseconds: 20));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 15));
      });
      if (find
          .byKey(const Key('feedback-screenshot-wrap'))
          .evaluate()
          .isNotEmpty) {
        return;
      }
    }
    fail('等待重拍流程结束超时（面板未恢复可见）');
  }

  String draftText(WidgetTester tester) => tester
      .widget<TextField>(find.byKey(const Key('feedback-input')))
      .controller!
      .text;

  testWidgets('面板打开且有草稿：captureAndOpen 不重拍，草稿与截图原样保留', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;

    await tester.enterText(find.byKey(const Key('feedback-input')), '这段草稿不能丢');
    await tester.pump();

    // 面板仍打开且已有草稿：宿主再要一次截图也不得覆盖正在编辑的内容。
    unawaited(controller.captureAndOpen(releasePoint: const Offset(0.9, 0.9)));
    expect(controller.isOpen, isTrue,
        reason: '面板已打开且有草稿：captureAndOpen 不进入捕获流程');
    await tester.pump();
    await tester.pump();
    await allowCaptureToFinish(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '已有草稿：captureAndOpen 不得重新截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue,
        reason: '已有草稿：旧截图字节必须原样保留');
    expect(panel.captureInfo!.releasePoint, isNull);
    expect(draftText(tester), '这段草稿不能丢');
  });

  testWidgets('关闭面板即放弃：再次点击灵感球重新截图，旧截图不再回来', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller,
        launcherMode: FeedbackLauncherMode.orb);

    final FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    expect(panel.hasDraft, isFalse);

    // 截图后没有提交，用户手动关闭反馈页。
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(controller.isOpen, isFalse);
    expect(panel.hasImages, isFalse, reason: '关闭面板即放弃本次截图');
    expect(panel.hasScreenshot, isFalse);

    // 关掉之后宿主换了一屏内容：再一次截图必须拍到现在这一屏。
    await pumpGuardHost(tester, controller,
        launcherMode: FeedbackLauncherMode.orb, hostColor: Colors.red);
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await tester.pump();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    await pumpUntil(tester, () => panel.hasScreenshot);
    await tester.pump();

    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isFalse,
        reason: '关闭后再次点击灵感球必须重新截图，而不是恢复刚才那条旧图');
    expect(panel.captureInfo!.capturedAt, isNotNull);
    expect(panel.hasDraft, isFalse);
  });

  testWidgets('关闭面板即放弃：已写正文也一起清空', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    await tester.enterText(find.byKey(const Key('feedback-input')), '这次不提交');
    await tester.pump();
    expect(draftText(tester), '这次不提交');

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    // 关闭即丢弃：先确认「放弃这次反馈？」。
    expect(find.byKey(const Key('feedback-discard-confirm')), findsOneWidget);
    await confirmDiscardIfAsked(tester);
    expect(controller.isOpen, isFalse);
    expect(panel.hasDraft, isFalse, reason: '关闭面板即放弃本次正文');
    expect(panel.hasImages, isFalse, reason: '关闭面板即放弃本次截图');

    // 再次呼出：重新截图、空白正文，不会回到刚才那条反馈。
    await pumpGuardHost(tester, controller, hostColor: Colors.red);
    await tester.tap(find.byKey(const Key('feedback-fab')));
    await tester.pump();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    await tester.pump();

    expect(draftText(tester), isEmpty, reason: '重开后是空白正文');
    expect(panel.hasScreenshot, isTrue, reason: '重开时按 captureMode 重新截图');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('关闭后拖动灵感球：明确重截，进入选区流程而不是恢复旧草稿', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller,
        launcherMode: FeedbackLauncherMode.orb);

    final FeedbackPanelState panel = await captureAndWait(tester, controller);
    await tester.enterText(find.byKey(const Key('feedback-input')), '拖动前写下的草稿');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    await confirmDiscardIfAsked(tester);
    expect(panel.hasDraft, isFalse, reason: '关闭面板即放弃本次草稿');

    // 关闭后草稿已放弃：拖动超过 8dp 松手是明确重截，进入局部选区流程。
    final TestGesture gesture = await tester
        .startGesture(tester.getCenter(find.byKey(const Key('feedback-orb'))));
    for (int i = 0; i < 3; i++) {
      await gesture.moveBy(const Offset(-40, -40));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump();
    await tester.pump();
    await pumpUntil(
        tester,
        () => find
            .byKey(const Key('feedback-capture-selection-overlay'))
            .evaluate()
            .isNotEmpty);
    await tester.pump(const Duration(milliseconds: 550));
    expect(controller.isOpen, isFalse);
    expect(find.byKey(const Key('feedback-capture-cancel')), findsOneWidget);

    // 取消选区不产出新截图，也不会把刚才那条旧草稿带回来。
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    expect(panel.hasScreenshot, isFalse);
    expect(panel.captureInfo, isNull);
    expect(panel.hasDraft, isFalse);
  });

  testWidgets('没有草稿与截图时照常截图（守卫不误伤正常呼出）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    await tester.tap(find.byKey(const Key('feedback-fab')));
    await tester.pump();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);

    expect(panel.hasScreenshot, isTrue);
    expect(panel.captureInfo!.capturedAt, isNotNull);
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('重拍取消：草稿文本与旧截图都原样保留', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;
    await tester.enterText(find.byKey(const Key('feedback-input')), '取消重拍也要保留');
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await tester.pump();
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsNothing,
        reason: '重拍进行中：反馈 UI 临时隐藏');

    controller.cancelCapture();
    await pumpUntilPanelRestored(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt, reason: '取消重拍不得替换截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(draftText(tester), '取消重拍也要保留');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('重拍中关闭面板：本次草稿放弃，重新打开后是空白撰写页', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    await tester.enterText(find.byKey(const Key('feedback-input')), '关闭重拍也要保留');
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await tester.pump();
    controller.close();
    await allowCaptureToFinish(tester);
    expect(panel.hasDraft, isFalse, reason: '关闭面板即放弃本次草稿');

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '重拍中途关闭后重新打开：面板必须恢复可见（覆盖层隐藏状态需复位）');

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasScreenshot, isFalse, reason: '关闭时放弃的截图不再回来');
    expect(panel.hasDraft, isFalse);
  });

  testWidgets('重拍失败（几何失效）：草稿文本与旧截图都原样保留', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;
    await tester.enterText(find.byKey(const Key('feedback-input')), '重拍失败也要保留');
    await tester.pump();

    // 宿主重建：必需遮挡区域几何失效 → 重拍必须中止（不产出新图）。
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const Center(
        child: FeedbackCaptureMask(
          child: ThrowingTransform(child: SizedBox(width: 50, height: 50)),
        ),
      ),
    ));
    await tester.pump();
    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await pumpUntilPanelRestored(tester);

    expect(panel.captureInfo!.capturedAt, oldCapturedAt, reason: '重拍失败不得替换旧截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(draftText(tester), '重拍失败也要保留');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });
}