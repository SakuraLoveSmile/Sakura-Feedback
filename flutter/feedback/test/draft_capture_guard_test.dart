import 'dart:async';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 草稿守卫与截图保留回归：
/// 1. 三个呼出入口（普通点击 / 拖动释放 / controller.captureAndOpen）在面板
///    已有草稿文本或截图时必须**统一**跳过捕获，只打开面板并原样恢复草稿；
/// 2. 重拍失败 / 取消 / 中途关闭都不得清掉草稿文本与旧截图。
void main() {
  Future<void> pumpGuardHost(
    WidgetTester tester,
    FeedbackController controller, {
    FeedbackLauncherMode launcherMode = FeedbackLauncherMode.tab,
  }) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      launcherMode: launcherMode,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
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

  String draftText(WidgetTester tester) =>
      tester.widget<TextField>(find.byKey(const Key('feedback-input')))
          .controller!
          .text;

  testWidgets('普通点击入口：已有草稿时不重新截图，草稿与截图原样保留', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;

    await tester.enterText(find.byKey(const Key('feedback-input')), '这段草稿不能丢');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(controller.isOpen, isFalse);

    // 再次从普通入口呼出：面板已有草稿 → 只打开面板，不重新截图。
    await tester.tap(find.byKey(const Key('feedback-fab')));
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue, reason: '已有草稿时呼出应立即打开面板');
    await allowCaptureToFinish(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '已有草稿：再次呼出不得重新截图（截图元数据必须保持不变）');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue,
        reason: '已有草稿：旧截图字节必须原样保留');
    expect(draftText(tester), '这段草稿不能丢');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('普通点击入口：只有截图没有文字时同样不重新截图', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;
    expect(panel.hasDraft, isFalse);

    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-fab')));
    await tester.pump();
    await tester.pump();
    await allowCaptureToFinish(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '面板已持有截图：再次呼出不得用新截图覆盖');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('拖动释放入口：已有草稿时不截图，落点元数据不被改写', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller,
        launcherMode: FeedbackLauncherMode.orb);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;
    expect(panel.captureInfo!.releasePoint, isNull);

    await tester.enterText(find.byKey(const Key('feedback-input')), '拖动前写下的草稿');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();

    // 拖动灵感球超过 8dp 后释放：releasePoint 入口也必须先检查草稿。
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.byKey(const Key('feedback-orb'))));
    await gesture.moveBy(const Offset(-100, -100));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    await allowCaptureToFinish(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '已有草稿：拖动释放入口不得重新截图');
    expect(panel.captureInfo!.releasePoint, isNull,
        reason: '未重新截图：落点元数据保持首次截图的值');
    expect(draftText(tester), '拖动前写下的草稿');
  });

  testWidgets('controller.captureAndOpen：已有草稿时同步打开面板且不截图', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;

    await tester.enterText(find.byKey(const Key('feedback-input')), 'CAS 入口的草稿');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();

    unawaited(controller.captureAndOpen(releasePoint: const Offset(0.9, 0.9)));
    // 不截图：无需等待捕获，控制器同步即为展开状态。
    expect(controller.isOpen, isTrue,
        reason: '已有草稿：captureAndOpen 应直接打开面板而不进入捕获流程');
    await tester.pump();
    await tester.pump();
    await allowCaptureToFinish(tester);

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '已有草稿：captureAndOpen 不得重新截图');
    expect(panel.captureInfo!.releasePoint, isNull);
    expect(draftText(tester), 'CAS 入口的草稿');
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
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '取消重拍不得替换截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(draftText(tester), '取消重拍也要保留');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });

  testWidgets('重拍中关闭面板：草稿与旧截图保留，重新打开后仍可见', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpGuardHost(tester, controller);

    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = Uint8List.fromList(panel.screenshotBytes!);
    final String oldCapturedAt = panel.captureInfo!.capturedAt!;
    await tester.enterText(find.byKey(const Key('feedback-input')), '关闭重拍也要保留');
    await tester.pump();

    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await tester.pump();
    controller.close();
    await allowCaptureToFinish(tester);

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '重拍中途关闭后重新打开：面板必须恢复可见（覆盖层隐藏状态需复位）');

    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '关闭重拍不得替换截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(draftText(tester), '关闭重拍也要保留');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
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

    expect(panel.captureInfo!.capturedAt, oldCapturedAt,
        reason: '重拍失败不得替换旧截图');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue);
    expect(draftText(tester), '重拍失败也要保留');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
  });
}
