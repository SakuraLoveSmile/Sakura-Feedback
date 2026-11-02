import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/orb_idle.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

final Finder _collapsed = find.byKey(const Key('feedback-orb-collapsed'));
final Finder _shader = find.byKey(const Key('feedback-orb-lens-shader'));

String _point(Offset point) =>
    '(${point.dx.toStringAsFixed(6)},${point.dy.toStringAsFixed(6)})';
String _rect(Rect rect) =>
    '${_point(rect.topLeft)}..${_point(rect.bottomRight)}';

void main() {
  late LiquidHarness host;
  late Duration oldGate;
  late int hostTaps;
  setUp(() {
    host = LiquidHarness();
    hostTaps = 0;
    host.content = GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => hostTaps++,
        child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)));
    debugDisableOrbLensCapture = false;
    oldGate = debugOrbLensGateDuration;
    debugOrbLensGateDuration = const Duration(days: 1);
  });
  tearDown(() {
    host.dispose();
    debugOrbLensGateDuration = oldGate;
  });

  Future<Rect> mount(WidgetTester tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    final OrbLiquidLensPainter paint =
        tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;
    expect(paint.mist, .74, reason: 'the real safe-texture glass is mounted');
    return tester.getRect(liquidOrb);
  }

  OrbLiquidLensPainter glass(WidgetTester tester) =>
      tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;

  Future<({Rect dock, Rect target})> configure(WidgetTester tester,
      FeedbackOrbIdleStyle style, FeedbackSide side, bool inset) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(800, 600);
    tester.view.padding = inset
        ? const FakeViewPadding(left: 32, top: 24, right: 48, bottom: 34)
        : const FakeViewPadding();
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    host.side = side;
    host.padding =
        inset ? const EdgeInsets.fromLTRB(24, 60, 40, 40) : EdgeInsets.zero;
    await host.preferences
        .write(orbIdleStorageKey(host.appId), encodeOrbIdleStyle(style));
    final Rect dock = await mount(tester);
    final double edge =
        side == FeedbackSide.left ? (inset ? 32 : 0) : (inset ? 752 : 800);
    final Rect target = Rect.fromLTWH(
        side == FeedbackSide.left ? edge : edge - 44, dock.top, 44, 56);
    return (dock: dock, target: target);
  }

  Offset visibleExterior(
      WidgetTester tester, FeedbackOrbIdleStyle style, FeedbackSide side) {
    final Rect face =
        tester.getRect(find.byKey(Key('feedback-orb-idle-${style.name}')));
    // A painted face point toward the viewport interior, away from the keyed
    // hit box's center. For edge the other half is clipped at the safe edge.
    return face.center +
        Offset(face.width * .35 * (side == FeedbackSide.left ? 1 : -1), 0);
  }

  Future<List<Offset>> opaqueSurfaceEnds(WidgetTester tester,
      {required bool inset}) async {
    final Finder layer = find
        .ancestor(of: _shader, matching: find.byType(RepaintBoundary))
        .first;
    final Rect box = tester.getRect(layer);
    final RenderRepaintBoundary boundary = tester.renderObject(layer);
    final ui.Image image = (await tester
        .runAsync<ui.Image>(() => boundary.toImage(pixelRatio: 2)))!;
    final int row = image.height ~/ 2;
    final int width = image.width;
    final bytes = (await tester.runAsync(() => image.toByteData()))!;
    image.dispose();
    final List<Offset> opaque = <Offset>[];
    for (int x = 0; x < width; x++) {
      final Offset point = box.topLeft + Offset((x + .5) / 2, (row + .5) / 2);
      if (point.dx < (inset ? 32 : 0) || point.dx >= (inset ? 752 : 800)) {
        continue;
      }
      if (bytes.getUint8((row * width + x) * 4 + 3) >= 250) {
        opaque.add(point);
      }
    }
    expect(opaque.length, greaterThan(8),
        reason: 'coordinates must come from the real mounted opaque glass');
    return <Offset>[opaque.first, opaque.last];
  }

  void expectGeometry(
      WidgetTester tester, Rect expected, FeedbackOrbIdleStyle style) {
    expect(tester.getRect(_collapsed),
        rectMoreOrLessEquals(expected, epsilon: 1e-8));
    final Rect face =
        tester.getRect(find.byKey(Key('feedback-orb-idle-${style.name}')));
    final Rect boundary =
        tester.getRect(find.byKey(const Key('feedback-host-slot')));
    expect(glass(tester).center,
        offsetMoreOrLessEquals(face.center - boundary.topLeft, epsilon: 1e-8),
        reason: 'moving hit layout must not move the actual sampler center');
  }

  for (final FeedbackOrbIdleStyle style in FeedbackOrbIdleStyle.values) {
    for (final FeedbackSide side in FeedbackSide.values) {
      for (final bool inset in <bool>[false, true]) {
        for (final bool expanding in <bool>[false, true]) {
          for (final int elapsed in <int>[42, 210, 378]) {
            testWidgets(
                '${style.name} ${side.name} safe=$inset '
                '${expanding ? 'expand' : 'collapse'} at ${elapsed}ms: '
                'visible exterior wakes and both stale spaces belong to host',
                (tester) async {
              final geometry = await configure(tester, style, side, inset);
              final OrbLiquidLensPainter original = glass(tester);
              await tester.pump(const Duration(seconds: 5));
              await tester.pump();
              if (expanding) {
                await tester.pump(const Duration(milliseconds: 421));
                expect(tester.getRect(_collapsed), geometry.target);
                await tester.tapAt(visibleExterior(tester, style, side));
                await tester.pump();
                expect(hostTaps, 0);
              }
              await tester.pump(Duration(milliseconds: elapsed));
              final double remaining =
                  expanding ? elapsed / 420 : 1 - elapsed / 420;
              final double progress = 1 - remaining * remaining * remaining;
              final Rect expected = tester.getRect(_collapsed);
              expect(expected.width, inInclusiveRange(44, 56));
              expect(expected.height, 56);
              expect(expected.top, geometry.dock.top);
              final Offset targetCenter = Offset(
                  side == FeedbackSide.left
                      ? geometry.target.left +
                          (style == FeedbackOrbIdleStyle.handle ? 9 : 0)
                      : geometry.target.right -
                          (style == FeedbackOrbIdleStyle.handle ? 9 : 0),
                  geometry.dock.center.dy);
              final Rect boundary =
                  tester.getRect(find.byKey(const Key('feedback-host-slot')));
              expect(
                  glass(tester).center,
                  offsetMoreOrLessEquals(
                      Offset.lerp(
                              geometry.dock.center, targetCenter, progress)! -
                          boundary.topLeft,
                      epsilon: 1e-8));
              expect(
                  glass(tester).handleMix,
                  closeTo(style == FeedbackOrbIdleStyle.handle ? progress : 0,
                      1e-8));
              expectGeometry(tester, expected, style);
              final bool left = side == FeedbackSide.left;
              final double edge =
                  left ? geometry.target.left : geometry.target.right;
              final double edgeGap =
                  left ? expected.left - edge : edge - expected.right;
              final Offset emptyEdge = Offset(
                  edgeGap > 1e-6
                      ? (left
                          ? (edge + expected.left) / 2
                          : (edge + expected.right) / 2)
                      : (left
                          ? (expected.right * 2 + geometry.dock.right) / 3
                          : (expected.left * 2 + geometry.dock.left) / 3),
                  expected.center.dy);
              final Offset staleDock = Offset(
                  left
                      ? (expected.right + geometry.dock.right) / 2
                      : (expected.left + geometry.dock.left) / 2,
                  expected.center.dy);
              final Offset painted = visibleExterior(tester, style, side);
              final List<Offset> actualSurface =
                  await opaqueSurfaceEnds(tester, inset: inset);
              debugPrint('R7_HIT_MATRIX style=${style.name} side=${side.name} '
                  'safe=$inset expanding=$expanding ms=$elapsed '
                  'actualHit=${_rect(tester.getRect(_collapsed))} '
                  'face=${_rect(tester.getRect(find.byKey(Key('feedback-orb-idle-${style.name}'))))} '
                  'painted=${_point(painted)} '
                  'opaqueEnds=${actualSurface.map(_point).join(',')} '
                  'emptyEdge=${_point(emptyEdge)} staleDock=${_point(staleDock)}');
              for (final Offset empty in <Offset>[emptyEdge, staleDock]) {
                expect(expected.contains(empty), isFalse);
                await tester.tapAt(empty);
                await tester.pump();
              }
              expect(hostTaps, 2,
                  reason: 'neither stale edge nor stale dock may wake the orb');
              expectGeometry(tester, expected, style);
              expect(glass(tester).image, same(original.image));
              expect(expected.contains(painted), isTrue);
              for (final Offset visible in actualSurface) {
                await tester.tapAt(visible);
                await tester.pump();
                expect(hostTaps, 2,
                    reason: 'actual opaque exterior glass pixel must wake');
                expectGeometry(tester, expected, style);
              }
              await tester.pump(const Duration(milliseconds: 421));
              expect(tester.getRect(liquidOrb), geometry.dock);
              expect(host.controller.isOpen, isFalse,
                  reason: 'the wake click must not activate the revealed orb');
              expect(find.byType(CaptureSelectionOverlay), findsNothing);
              expect(glass(tester).image, same(original.image));
              expect(tester.binding.transientCallbackCount, 0);
              await tester.pumpWidget(const SizedBox.shrink());
            });
          }
        }

        testWidgets(
            '${style.name} ${side.name} safe=$inset: interrupted collapse '
            'and repeated exterior wake have no layout or sampler jump',
            (tester) async {
          final geometry = await configure(tester, style, side, inset);
          final OrbLiquidLensPainter original = glass(tester);
          await tester.pump(const Duration(seconds: 5));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 126));
          final Rect first = tester.getRect(_collapsed);
          final Offset firstCenter = glass(tester).center;
          final Size? firstShape = glass(tester).halfSize;
          await tester.tapAt(visibleExterior(tester, style, side));
          await tester.pump();
          expect(tester.getRect(_collapsed), first);
          expect(glass(tester).center, firstCenter);
          expect(glass(tester).halfSize, firstShape);
          await tester.pump(const Duration(milliseconds: 63));
          final Rect second = tester.getRect(_collapsed);
          expect(second.width, greaterThan(first.width));
          final Offset secondCenter = glass(tester).center;
          await tester.tapAt(visibleExterior(tester, style, side));
          await tester.pump();
          expect(tester.getRect(_collapsed), second);
          expect(glass(tester).center, secondCenter);
          await tester.pump(const Duration(milliseconds: 64));
          expect(tester.getRect(liquidOrb), geometry.dock);
          expect(hostTaps, 0);
          expect(host.controller.isOpen, isFalse);
          expect(glass(tester).image, same(original.image));
          await tester.pump(const Duration(seconds: 5));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 126));
          expect(tester.getRect(_collapsed),
              rectMoreOrLessEquals(first, epsilon: 1e-8));
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump(const Duration(milliseconds: 500));
          expect(tester.binding.transientCallbackCount, 0);
          expect(tester.takeException(), isNull);
        });
      }
    }
  }

  testWidgets('first collapse frame: the real visible x60 sphere point wakes',
      (tester) async {
    host.side = FeedbackSide.left;
    final Rect dock = await mount(tester);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    final Rect face =
        tester.getRect(find.byKey(const Key('feedback-orb-idle-handle')));
    final Offset point = Offset(60, dock.center.dy);
    expect(face, dock);
    expect(face.contains(point), isTrue);
    debugPrint('R7_HIT_RED face=$face hit=${tester.getRect(_collapsed)} '
        'pointer=$point');
    await tester.tapAt(point);
    await tester.pump();
    expect(hostTaps, 0, reason: 'a visibly painted sphere point must wake it');
    await tester.pump(const Duration(milliseconds: 421));
    expect(tester.getRect(liquidOrb), dock);
    expect(host.controller.isOpen, isFalse);
  });

  testWidgets(
      'first collapse frame: the empty x10 safe-edge point reaches host',
      (tester) async {
    host.side = FeedbackSide.left;
    final Rect dock = await mount(tester);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    final Rect face =
        tester.getRect(find.byKey(const Key('feedback-orb-idle-handle')));
    final Offset point = Offset(10, dock.center.dy);
    expect(face.contains(point), isFalse);
    debugPrint('R7_HIT_RED face=$face hit=${tester.getRect(_collapsed)} '
        'pointer=$point');
    await tester.tapAt(point);
    await tester.pump();
    expect(hostTaps, 1, reason: 'the hit target must not jump to empty space');
    await tester.pump(const Duration(milliseconds: 421));
    expect(_collapsed, findsOneWidget);
  });
}
