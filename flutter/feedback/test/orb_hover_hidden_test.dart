import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _body = find.byKey(const Key('feedback-orb-body'));
final Finder _ring = find.byKey(const Key('feedback-orb-focus-ring'));

LiquidPaintState _painter(WidgetTester tester) => liquidPaintState(tester);

void main() {
  late FeedbackController controller;
  late http.Client client;

  setUp(() {
    controller = FeedbackController();
    client = captureMockClient();
  });

  tearDown(() {
    controller.dispose();
    client.close();
  });

  Future<void> pumpHost(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.orb-hover-hidden',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: FeedbackCaptureMode.off,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: client,
        child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
      ),
    ));
    await tester.pump();
  }

  Future<TestGesture> hoverOrb(WidgetTester tester) async {
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    return mouse;
  }

  testWidgets('A 隐藏期间指针移开：恢复后回到 idle', (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse = await hoverOrb(tester);
    expect(_painter(tester).scale, closeTo(1.04, 1e-6));

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(_orb, findsNothing, reason: '面板打开即 hidden');

    await mouse.moveTo(const Offset(10, 10));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 220));
    await tester.pump();

    final LiquidPaintState painter = _painter(tester);
    expect(painter.scale, closeTo(1.0, 1e-6),
        reason: '指针已离开，恢复后不得残留 hover 1.04');
    expect(painter.wobble, 0.0, reason: 'R3 无旧光晕或常驻呼吸，静止时无回弹');
    expect(_ring, findsNothing);
    debugPrint('T7e A restored: stateScale=${painter.scale}, '
        'breathWeight=${painter.wobble}, ring=false');

    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('B 隐藏期间指针不动：恢复后回到 hover', (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse = await hoverOrb(tester);
    expect(_painter(tester).scale, closeTo(1.04, 1e-6));

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(_orb, findsNothing, reason: '面板打开即 hidden');

    // 指针静止等待，隐藏期间不发生任何鼠标事件。
    await tester.pump(const Duration(milliseconds: 300));

    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 220));
    await tester.pump();

    final LiquidPaintState painter = _painter(tester);
    expect(painter.scale, closeTo(1.04, 1e-6),
        reason: '指针仍在球上，恢复帧由 MouseTracker 补发 onEnter');
    expect(painter.wobble, 0.0, reason: 'hover 不叠加呼吸');
    debugPrint('T7e B restored: stateScale=${painter.scale}, '
        'breathWeight=${painter.wobble}, ring=false');

    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
