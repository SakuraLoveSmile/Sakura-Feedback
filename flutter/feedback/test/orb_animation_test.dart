// R7 permits the finite 420ms collapse, but no idle sweep/breath ticker.
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'orb_liquid_test_utils.dart';

void main() {
  late LiquidHarness host;
  setUp(() {
    host = LiquidHarness();
    debugForceOrbAnimation = true;
    debugDisableOrbLensCapture = true;
  });
  tearDown(() {
    host.dispose();
    debugForceOrbAnimation = false;
    debugDisableOrbLensCapture = false;
  });

  testWidgets('visible idle orb has no permanent ticker across ten seconds',
      (tester) async {
    await host.mount(tester);
    for (int i = 0; i < 10; i++) {
      await tester.pump(const Duration(seconds: 1));
      if (i == 4) {
        expect(tester.binding.transientCallbackCount, greaterThan(0),
            reason: 'R7 starts the finite collapse at five seconds');
        await tester.pump(const Duration(milliseconds: 421));
      }
      expect(tester.binding.transientCallbackCount, 0);
    }
    expect(liquidOrb, findsNothing);
    expect(find.byKey(const Key('feedback-orb-collapsed')), findsOneWidget);
  });

  testWidgets(
      'drag starts a ticker; cancel stops it and returns the original dock',
      (tester) async {
    await host.mount(tester);
    final Offset dock = tester.getCenter(liquidLens);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-160, -60));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.binding.transientCallbackCount, 0);
    expect(tester.getCenter(liquidLens), dock);
  });

  testWidgets('opening and closing the real panel never restarts stale motion',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -60));
    await tester.pump();
    host.controller.open();
    await tester.pump();
    await gesture.cancel();
    await tester.pump(const Duration(milliseconds: 300));
    expect(liquidOrb, findsNothing);
    host.controller.close();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(liquidOrb, findsOneWidget);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'hiding and restoring launcher stops active ticker without idle restart',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -60));
    await tester.pump();
    host.showLauncher = false;
    host.rebuild();
    await tester.pump();
    await gesture.up();
    host.showLauncher = true;
    host.rebuild();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.binding.transientCallbackCount, 0);
    expect(host.controller.isOpen, isFalse);
  });

  testWidgets('reducing motion while dragging immediately cancels ticker',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -60));
    await tester.pump();
    host.reduced = true;
    host.rebuild();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.binding.transientCallbackCount, 0);
    await gesture.cancel();
  });

  testWidgets('selection entrance is finite; cancel has no residual callbacks',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    expect(find.byType(CaptureSelectionOverlay), findsOneWidget);
    expect(liquidOrb, findsNothing);
    expect(tester.binding.transientCallbackCount, 0);
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(liquidOrb, findsOneWidget);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('dispose during motion removes all owned scheduling',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-160, -60));
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    await gesture.cancel();
    await tester.pump(const Duration(seconds: 2));
    expect(tester.takeException(), isNull);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'constant panel state survives liquid frames and selection round trips',
      (tester) async {
    await host.mount(tester);
    host.controller.open();
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel = host.panel(tester);
    host.controller.close();
    await tester.pump();
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    expect(host.panel(tester), same(panel));
    expect(tester.takeException(), isNull);
  });
}
