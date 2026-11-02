// FB-20261101: position is intentionally inertial; final capture uses the
// actual pointer, and cancellation resets shape energy instead of old ellipse bounce.
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

OrbLiquidOutlinePainter _liquid(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
        find.descendant(of: liquidLens, matching: find.byType(CustomPaint)))
    .map((CustomPaint p) => p.painter)
    .whereType<OrbLiquidOutlinePainter>()
    .single;

void main() {
  late LiquidHarness host;
  setUp(() {
    host = LiquidHarness();
    debugDisableOrbLensCapture = true;
  });
  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
  });

  testWidgets(
      'right button is ignored, primary click still opens the real panel',
      (tester) async {
    await host.mount(tester);
    final TestGesture right = await tester.startGesture(
        tester.getCenter(liquidOrb),
        kind: PointerDeviceKind.mouse,
        buttons: kSecondaryMouseButton);
    await right.moveBy(const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.getSize(liquidBody), const Size(56, 56));
    await right.up();
    await tester.pump();
    expect(host.controller.isOpen, isFalse);
    await tester.tap(liquidOrb);
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
  });

  testWidgets(
      'strict >8px primary threshold, preserved dock and 104px active body',
      (tester) async {
    await host.mount(tester);
    final Offset dock = tester.getCenter(liquidBody);
    final TestGesture gesture = await tester.startGesture(dock);
    await gesture.moveBy(const Offset(-8, 0));
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.getSize(liquidBody), const Size(56, 56));
    await gesture.moveBy(const Offset(-.01, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(liquidBody), const Size(104, 104));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.getCenter(liquidBody), dock);
    expect(tester.getCenter(liquidLens), dock);
    expect(_liquid(tester).deform, 0);
  });

  for (final Offset delta in <Offset>[
    const Offset(-150, 0),
    const Offset(0, -150),
    const Offset(-100, -100)
  ]) {
    testWidgets(
        'inertia and first-preview deformation for $delta; no legacy painter overlay',
        (tester) async {
      await host.mount(tester);
      final Offset dock = tester.getCenter(liquidLens);
      final TestGesture gesture = await tester.startGesture(dock);
      await gesture.moveBy(delta);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      final Offset visual = tester.getCenter(liquidLens) - dock;
      expect(visual.distance, inExclusiveRange(0, delta.distance));
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(_liquid(tester).deform, greaterThan(.001));
      expect((_liquid(tester).direction - delta / delta.distance).distance,
          lessThan(.001));
      expect(_liquid(tester).radius, inExclusiveRange(52, 54));
      expect(
          tester
              .widgetList<CustomPaint>(find.descendant(
                  of: liquidBody, matching: find.byType(CustomPaint)))
              .map((CustomPaint p) => p.painter)
              .whereType<OrbPainter>(),
          isEmpty);
      await gesture.cancel();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.binding.transientCallbackCount, 0);
    });
  }

  testWidgets(
      'second pointer cannot reset motion, change target or release the primary drag',
      (tester) async {
    await host.mount(tester);
    final Offset dock = tester.getCenter(liquidOrb);
    final TestGesture first = await tester.startGesture(dock, pointer: 1);
    await first.moveBy(const Offset(-100, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    final Offset before = tester.getCenter(liquidLens);
    final TestGesture second = await tester.startGesture(dock, pointer: 2);
    await tester.pump();
    expect(tester.getCenter(liquidLens), before);
    await second.moveBy(const Offset(200, 200));
    await second.up();
    await tester.pump();
    expect(host.controller.isOpen, isFalse);
    await first.moveBy(const Offset(-20, 0));
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.getCenter(liquidLens).dx, lessThan(before.dx));
    await first.cancel();
  });

  testWidgets(
      'release metadata uses the actual last pointer rather than the lagging center',
      (tester) async {
    await host.mount(tester);
    final Offset dock = tester.getCenter(liquidOrb);
    final TestGesture gesture = await tester.startGesture(dock);
    const Offset delta = Offset(-180, -80);
    await gesture.moveBy(delta);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    final Offset visible = tester.getCenter(liquidLens);
    expect((visible - (dock + delta)).distance, greaterThan(20));
    final OrbLiquidOutlinePainter shape = _liquid(tester);
    await gesture.up();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
    final CaptureSelectionOverlay overlay =
        tester.widget(find.byType(CaptureSelectionOverlay));
    expect(overlay.releasePoint,
        Offset((dock.dx + delta.dx) / 800, (dock.dy + delta.dy) / 600));
    expect((overlay.orbCenter! - visible).distance, lessThan(.001));
    expect(overlay.direction, shape.direction);
    expect(overlay.deform, shape.deform);
    expect(overlay.wobble, shape.wobble);
    expect(overlay.orbRadius, shape.radius);
    expect(host.controller.isOpen, isFalse);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final OrbLiquidOutlinePainter release = tester
        .widgetList<CustomPaint>(find.descendant(
            of: find.byType(CaptureSelectionOverlay),
            matching: find.byType(CustomPaint)))
        .map((CustomPaint paint) => paint.painter)
        .whereType<OrbLiquidOutlinePainter>()
        .single;
    expect(release.wobble, greaterThan(.2),
        reason: 'first-preview release wobble is visible during the morph');
    expect(release.direction, shape.direction);
    expect(release.deform, shape.deform);
  });

  testWidgets(
      'pointercancel performs no capture and clears residual deformation and scheduling',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-160, -70));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(host.controller.isOpen, isFalse);
    expect(_liquid(tester).deform, 0);
    expect(_liquid(tester).wobble, 0);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'hidden during a drag cannot reopen on its late pointer up; restored launcher works',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -50));
    await tester.pump();
    host.showLauncher = false;
    host.rebuild();
    await tester.pump();
    await gesture.up();
    await tester.pump();
    expect(host.controller.isOpen, isFalse);
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    host.showLauncher = true;
    host.rebuild();
    await tester.pump();
    await tester.tap(liquidOrb);
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
  });

  testWidgets(
      'reduced motion jumps to the same target without deformation; capture still works',
      (tester) async {
    host.reduced = true;
    await host.mount(tester, size: const Size(390, 844));
    final Offset dock = tester.getCenter(liquidLens);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    const Offset delta = Offset(-100, -40);
    await gesture.moveBy(delta);
    await tester.pump();
    expect(tester.getSize(liquidBody), const Size(104, 104));
    expect((tester.getCenter(liquidLens) - (dock + delta)).distance,
        lessThan(.001));
    expect(_liquid(tester).wobble, 0);
    expect(tester.binding.transientCallbackCount, 0);
    await gesture.up();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
    expect(find.byType(CaptureSelectionOverlay), findsOneWidget);
  });
}
