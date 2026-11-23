import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/beam_aurora.dart';
import 'package:feedback_widget/src/water_ripple.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:integration_test/integration_test.dart';

Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() cond, {
  int tries = 400,
}) async {
  for (int i = 0; i < tries; i += 1) {
    if (cond()) return;
    await tester.pump(const Duration(milliseconds: 50));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail('等待超时');
}

Future<void> _wait(WidgetTester tester, Duration duration) async {
  await tester.runAsync(() => Future<void>.delayed(duration));
  await tester.pump();
}

Widget _host(FeedbackController controller, {MemoryServerPrefStore? store}) =>
    FeedbackWidget(
      config: FeedbackConfig(
        'http://localhost:8787',
        'com.example.beam-device',
      ),
      controller: controller,
      tokenStore: MemoryTokenStore('tok'),
      serverPrefStore: store ?? MemoryServerPrefStore(),
      httpClient: MockClient(
        (http.Request request) async => http.Response('{}', 404),
      ),
      child: MaterialApp(
        home: Scaffold(
          body: ListView(
            padding: const EdgeInsets.all(24),
            children: const <Widget>[
              SizedBox(height: 80),
              Text('光束唤醒真机验证', style: TextStyle(fontSize: 22)),
              SizedBox(height: 12),
              Text('页面上没有任何常驻反馈入口。'),
              SizedBox(height: 12),
              Text('双指长按 700ms 或 Ctrl+Shift+F 应唤出光束与圈选。'),
            ],
          ),
        ),
      ),
    );

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('真机：双指长按 → 光束 → 圈选成框 → 面板带截图', (tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller));
    await tester.pump();

    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    expect(find.byKey(const Key('feedback-fab')), findsNothing);
    expect(find.byKey(const Key('feedback-beam-a11y-slot')), findsOneWidget);

    final TestGesture first = await tester.startGesture(const Offset(120, 320));
    final TestGesture second = await tester.startGesture(const Offset(240, 320));
    await tester.pump(const Duration(milliseconds: 750));
    await first.up();
    await second.up();
    await tester.pump();

    await pumpUntil(
      tester,
      () => find.byKey(const Key('feedback-capture-lasso')).evaluate().isNotEmpty,
    );
    // 光束约 250ms 处留帧，再推进到压暗 + 圈选提示。
    for (int i = 0; i < 4; i += 1) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    debugPrint('FB_DEVICE_BEAM_MID');
    await _wait(tester, const Duration(seconds: 3));
    for (int i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 80));
    }
    debugPrint('FB_DEVICE_BEAM_READY');
    await _wait(tester, const Duration(seconds: 6));

    final TestGesture lasso = await tester.startGesture(const Offset(110, 400));
    for (final Offset point in <Offset>[
      const Offset(180, 360),
      const Offset(260, 400),
      const Offset(240, 500),
      const Offset(150, 520),
      const Offset(100, 440),
    ]) {
      await lasso.moveTo(point);
      await tester.pump(const Duration(milliseconds: 16));
    }
    await lasso.up();
    await tester.pump();
    await pumpUntil(
      tester,
      () =>
          find.byKey(const Key('feedback-capture-selection')).evaluate().isNotEmpty,
    );
    // 推进选区入场动画，避免录屏停在白色形变中间帧。
    for (int i = 0; i < 12; i += 1) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    debugPrint('FB_DEVICE_FRAME_READY');
    await _wait(tester, const Duration(seconds: 5));

    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await pumpUntil(
      tester,
      () => find.byType(FeedbackPanel).evaluate().isNotEmpty,
    );
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    expect(panel.hasScreenshot, isTrue);
    for (int i = 0; i < 12; i += 1) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    debugPrint('FB_DEVICE_PANEL_READY');
    await _wait(tester, const Duration(seconds: 5));
  });

  testWidgets('真机：预置波光偏好后使用可选极光动效', (tester) async {
    final MemoryServerPrefStore store = MemoryServerPrefStore();
    await store.write(
        'feedback:wake-visual:v1:com.example.beam-device', 'aurora');
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, store: store));
    await tester.pump();
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 120)));
    await tester.pump();

    final TestGesture first = await tester.startGesture(const Offset(120, 320));
    final TestGesture second = await tester.startGesture(const Offset(240, 320));
    await tester.pump(const Duration(milliseconds: 750));
    await first.up();
    await second.up();
    await tester.pump();

    await pumpUntil(
      tester,
      () => find.byKey(const Key('feedback-capture-lasso')).evaluate().isNotEmpty,
    );
    await tester.pump(const Duration(milliseconds: 60));
    expect(
        find.byWidgetPredicate(
            (Widget w) => w is CustomPaint && w.painter is BeamAuroraPainter),
        findsOneWidget);
    expect(
        find.byWidgetPredicate(
            (Widget w) => w is CustomPaint && w.painter is WaterRipplePainter),
        findsNothing);
    debugPrint('FB_DEVICE_AURORA_OPTION');
    await _wait(tester, const Duration(seconds: 3));

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      find.byKey(const Key('feedback-capture-selection-overlay')),
      findsNothing,
    );
  });

  testWidgets('真机：快捷键 Ctrl+Shift+F 进入同一圈选', (tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller));
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();

    await pumpUntil(
      tester,
      () => find.byKey(const Key('feedback-capture-lasso')).evaluate().isNotEmpty,
    );
    debugPrint('FB_DEVICE_SHORTCUT_READY');
    await _wait(tester, const Duration(seconds: 8));

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      find.byKey(const Key('feedback-capture-selection-overlay')),
      findsNothing,
    );
    expect(controller.isOpen, isFalse);
  });
}
