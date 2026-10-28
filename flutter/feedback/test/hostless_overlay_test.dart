// 宿主无 Overlay / Navigator 祖先（组件按集成文档与示例推荐、包在
// MaterialApp **外侧**）的回归：
//
// 1. 兜底 Overlay 不得把子树冻结在首帧——`Overlay.initialEntries` 只在首次
//    挂载生效，旧实现把子树闭包进 entry，父级 setState 后面板永远停在首帧
//    （点击灵感球捕获完成、`open=true`，但面板 / 选区覆盖层都不出现）。
// 2. 点击灵感球完成捕获后面板必须挂载并可交互；关闭后再次打开仍能挂载。
// 3. 拖拽进入选区覆盖层同样能重建（覆盖层与面板同在这棵子树上），确认后
//    正常交付截图。
// 4. 灵感球光晕是常驻循环动画：测试环境（FLUTTER_TEST）不得启动该 Ticker，
//    否则会挂起 `pumpAndSettle`（真实应用动画不受影响）。

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 按示例挂法构造：`FeedbackWidget` 在 `MaterialApp` **外侧**，
/// 组件没有任何 Overlay / Navigator 祖先。
Future<FeedbackController> pumpHostlessHost(
  WidgetTester tester, {
  FeedbackLauncherMode launcherMode = FeedbackLauncherMode.orb,
}) async {
  await tester.binding.setSurfaceSize(const Size(800, 600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final FeedbackController controller = FeedbackController();
  addTearDown(controller.dispose);
  await tester.pumpWidget(FeedbackWidget(
    config: FeedbackConfig(
      'https://svc.test',
      'com.example.test',
      launcherMode: launcherMode,
      captureMode: FeedbackCaptureMode.viewport,
    ),
    controller: controller,
    tokenStore: MemoryTokenStore('tok'),
    serverPrefStore: MemoryServerPrefStore(),
    httpClient: captureMockClient(),
    child: const MaterialApp(
      home: Scaffold(
        body: ColoredBox(color: Colors.blue),
      ),
    ),
  ));
  await tester.pump();
  return controller;
}

void main() {
  test('测试环境探测：flutter test 下 kFeedbackInFlutterTest 为 true', () {
    expect(
        kFeedbackInFlutterTest,
        isTrue,
        reason: 'flutter 工具链注入 FLUTTER_TEST=1；'
            '该值为 false 说明环境探测失效，光晕 Ticker 会挂起 pumpAndSettle');
  });

  testWidgets('无 Overlay 祖先：灵感球可见时 pumpAndSettle 不被光晕常驻动画挂起',
      (tester) async {
    await pumpHostlessHost(tester); // 面板未打开 → 灵感球在树上
    // 旧实现光晕 repeat() 空转时，这里会直接超时失败。
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('无 Overlay 祖先：点击灵感球完成捕获后面板挂载可交互；关闭后重开仍挂载',
      (tester) async {
    final FeedbackController controller = await pumpHostlessHost(tester);

    // 点击 = viewport 模式先截图后开面板（整棵树必须随 setState 重建出来）。
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byKey(const Key('feedback-input')).evaluate().isNotEmpty);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '兜底 Overlay 不得把面板冻结在首帧');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget,
        reason: '捕获交付也到达面板');

    // 可交互：输入草稿。
    await tester.enterText(
        find.byKey(const Key('feedback-input')), '无 Overlay 宿主的草稿');
    await tester.pump();

    // 关闭 → 再次打开：子树必须仍能重建。
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(controller.isOpen, isFalse);
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);

    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '关闭后重开仍能挂载');
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasDraft, isTrue, reason: '重开后草稿仍在（子树状态未被重建破坏）');
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '无 Overlay 宿主的草稿');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('无 Overlay 祖先：拖拽进入选区覆盖层可重建，确认后交付截图并继续交互',
      (tester) async {
    final FeedbackController controller = await pumpHostlessHost(tester);

    // 多段位移拖拽（>8dp）→ 松手进入选区流程。
    final TestGesture gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('feedback-orb'))));
    for (int i = 0; i < 3; i++) {
      await gesture.moveBy(const Offset(-40, -40));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump();

    // 选区覆盖层与面板同在兜底子树上：必须能从 setState 重建出来
    // （冻结缺陷下永远不出现）。
    await pumpUntil(
        tester,
        () => find
            .byKey(const Key('feedback-capture-selection-overlay'))
            .evaluate()
            .isNotEmpty);
    expect(
        find.byKey(const Key('feedback-capture-selection-overlay')),
        findsOneWidget);
    expect(controller.isOpen, isFalse, reason: '确认前面板未打开');

    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await pumpUntil(tester, () {
      if (find.byType(FeedbackPanel).evaluate().isEmpty) return false;
      return tester
          .state<FeedbackPanelState>(find.byType(FeedbackPanel))
          .hasScreenshot;
    });
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget,
        reason: '确认后覆盖层收起并交付选区截图');
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);

    // 交付后子树仍可继续重建（交互可用）。
    await tester.enterText(
        find.byKey(const Key('feedback-input')), '选区交付后的草稿');
    await tester.pump();
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '选区交付后的草稿');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });
}
