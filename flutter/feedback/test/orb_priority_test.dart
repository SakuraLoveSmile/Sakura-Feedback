// Liquid priority replaces the old ellipse/release/sweep hierarchy while
// preserving primary input, hidden, hover/press, badge and keyboard focus.
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'orb_liquid_test_utils.dart';

LiquidPaintState _dock(WidgetTester tester) => liquidPaintState(tester);

void main() {
  late LiquidHarness host;
  late FocusHighlightStrategy highlight;
  setUp(() {
    host = LiquidHarness();
    debugDisableOrbLensCapture = true;
    highlight = FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
  });
  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
    FocusManager.instance.highlightStrategy = highlight;
  });

  Future<TestGesture> hover(WidgetTester tester) async {
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(liquidOrb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    return mouse;
  }

  testWidgets('pressed takes priority over hover without changing hit geometry',
      (tester) async {
    await host.mount(tester);
    final TestGesture mouse = await hover(tester);
    expect(_dock(tester).scale, closeTo(1.04, 1e-6));
    await mouse.down(tester.getCenter(liquidOrb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    expect(_dock(tester).scale, closeTo(.94, 1e-6));
    expect(tester.getSize(liquidBody), const Size(56, 56));
    await mouse.up();
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
    await mouse.removePointer();
  });

  testWidgets(
      'drag overrides hover and press; old sweep, breathing and ellipse are absent',
      (tester) async {
    await host.mount(tester);
    final TestGesture mouse = await hover(tester);
    await mouse.down(tester.getCenter(liquidOrb));
    await mouse.moveBy(const Offset(-100, -50));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(liquidBody), const Size(104, 104));
    expect(
        tester
            .widgetList<CustomPaint>(find.byType(CustomPaint))
            .map((CustomPaint p) => p.painter)
            .whereType<OrbPainter>(),
        isEmpty);
    await mouse.cancel();
    await mouse.removePointer();
  });

  testWidgets(
      'press below threshold is a single click and never starts liquid capture',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-8, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    expect(tester.getSize(liquidBody), const Size(56, 56));
    await gesture.up();
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);
  });

  testWidgets('new press after cancellation begins from zero energy',
      (tester) async {
    await host.mount(tester);
    TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-120, -50));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    gesture = await tester.startGesture(tester.getCenter(liquidOrb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    expect(_dock(tester).deform, 0);
    expect(_dock(tester).scale, closeTo(.94, 1e-6));
    await gesture.cancel();
  });

  testWidgets(
      'open immediately hides active motion; close restores a static dock',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-160, -60));
    await tester.pump();
    host.controller.open();
    await tester.pump();
    expect(liquidOrb, findsNothing);
    await gesture.cancel();
    host.controller.close();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(_dock(tester).wobble, 0);
    expect(_dock(tester).deform, 0);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('hidden and restored idle do not leave a repeating ticker',
      (tester) async {
    await host.mount(tester);
    await tester.pump(const Duration(seconds: 5));
    expect(tester.binding.transientCallbackCount, greaterThan(0),
        reason: 'R7 collapse is a finite 420ms transition');
    host.controller.open();
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-collapsed')), findsNothing,
        reason: 'the open panel removes the active collapse immediately');
    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(tester.binding.transientCallbackCount, 0);
    expect(liquidOrb, findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 421));
    expect(tester.binding.transientCallbackCount, 0);
    expect(find.byKey(const Key('feedback-orb-collapsed')), findsOneWidget);
  });

  testWidgets(
      'keyboard ring follows the moving 104px ball and leaves badge geometry intact',
      (tester) async {
    await host.mount(tester);
    host.controller.setUnreadCount(3);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final Finder ring = find.byKey(const Key('feedback-orb-focus-ring'));
    expect(ring, findsOneWidget);
    final Rect badgeBefore = tester.getRect(find.text('3'));
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -50));
    await tester.pump();
    for (int i = 0; i < 16; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(ring, findsOneWidget);
    expect(tester.getRect(ring).size, const Size(112, 112));
    expect((tester.getCenter(ring) - tester.getCenter(liquidLens)).distance,
        lessThan(.001));
    // Expansion changes the dock hit box, but the badge stays outside the
    // transformed optical subtree and is never stretched by liquid modes.
    expect(tester.getRect(find.text('3')).size, badgeBefore.size);
    await gesture.cancel();
  });

  testWidgets(
      'hidden removes focus ring; pointer-close restores focus without ring',
      (tester) async {
    await host.mount(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsOneWidget);
    await tester.tap(liquidOrb);
    await tester.pump();
    expect(liquidOrb, findsNothing);
    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(Focus.of(tester.element(liquidOrb)).hasPrimaryFocus, isTrue);
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsNothing);
  });

  testWidgets(
      'showLauncher false invalidates active decoration and restores no residual motion',
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
    expect(_dock(tester).deform, 0);
    expect(_dock(tester).wobble, 0);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'orb to tab stops liquid scheduling and preserves the normal launcher',
      (tester) async {
    await host.mount(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-100, -60));
    await tester.pump();
    host.launcherMode = FeedbackLauncherMode.tab;
    host.rebuild();
    await tester.pump();
    await gesture.up();
    expect(liquidOrb, findsNothing);
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget);
    host.launcherMode = FeedbackLauncherMode.orb;
    host.rebuild();
    await tester.pump();
    expect(_dock(tester).deform, 0);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'frozen selection hides the orb completely and cancelling restores keyboard operation',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    expect(liquidOrb, findsNothing);
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsNothing);
    expect(tester.binding.transientCallbackCount, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
  });
}
