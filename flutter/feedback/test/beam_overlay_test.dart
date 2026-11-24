import 'dart:ui' as ui;

import 'package:feedback_widget/src/beam_aurora.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/wake_visual.dart';
import 'package:feedback_widget/src/water_ripple.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<ui.Image> _image(WidgetTester tester) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  Canvas(recorder)
      .drawRect(const Rect.fromLTWH(0, 0, 400, 300), Paint()..color = Colors.grey);
  final ui.Image image = recorder.endRecording().toImageSync(400, 300);
  addTearDown(image.dispose);
  return image;
}

Future<void> _pumpOverlay(
  WidgetTester tester, {
  required ui.Image image,
  bool reduce = false,
  EdgeInsets safeInsets = EdgeInsets.zero,
  Offset? releasePoint = const Offset(.25, .5),
  List<Offset> wakeOrigins = const [],
  FeedbackWakeVisual wakeVisual = FeedbackWakeVisual.ripple,
  VoidCallback? onCancel,
  ValueChanged<Rect>? onUseRegion,
  VoidCallback? onCaptureWhole,
}) async {
  // 让测试表面与 widget.viewport 一致：真机上两者相同，
  // 否则把视口坐标误当安全区 inset 的定位错误会被窗口高度掩盖。
  tester.view.physicalSize = const Size(400, 300);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(RepaintBoundary(
    key: const Key('lasso-test-surface'),
    child: MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(size: const Size(400, 300), disableAnimations: reduce),
        child: CaptureSelectionOverlay(
          image: image,
          viewport: const Size(400, 300),
          releasePoint: releasePoint,
          wakeOrigins: wakeOrigins,
          safeInsets: safeInsets,
          lassoFirst: true,
          wakeVisual: wakeVisual,
          onUseRegion: onUseRegion ?? (_) {},
          onCaptureWhole: onCaptureWhole ?? () {},
          onCancel: onCancel ?? () {},
        ),
      ),
  )));
}

void main() {
  final guide = find.byKey(const Key('feedback-lasso-guide'));
  for (final visual in FeedbackWakeVisual.values) {
    testWidgets('$visual draws one small guide around the wake point after the wave', (tester) async {
      await _pumpOverlay(tester, image: await _image(tester), wakeVisual: visual,
          releasePoint: const Offset(.20, .70));
      final wake = visual == FeedbackWakeVisual.ripple ? kWaterRippleDuration : kBeamAuroraDuration;
      await tester.pump(wake - const Duration(milliseconds: 1));
      expect(guide, findsNothing);
      await tester.pump(const Duration(milliseconds: 16));
      expect(tester.getCenter(guide), const Offset(80, 210));
      expect(tester.getSize(guide), const Size(112, 80));
      await tester.pumpAndSettle();
      expect(guide, findsNothing);
      expect(find.text('圈出问题位置'), findsOneWidget);
      expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
    });
  }

  testWidgets('touch immediately dismisses the guide and the same drag makes the selection', (tester) async {
    await _pumpOverlay(tester, image: await _image(tester), wakeVisual: FeedbackWakeVisual.aurora);
    await tester.pump(kBeamAuroraDuration);
    await tester.pump(const Duration(milliseconds: 200));
    expect(guide, findsOneWidget);
    final gesture = await tester.startGesture(const Offset(60, 60));
    await tester.pump();
    expect(guide, findsNothing);
    for (final pt in const [Offset(115, 60), Offset(165, 100), Offset(80, 140)]) {
      await gesture.moveTo(pt);
      await tester.pump();
    }
    await gesture.up();
    await tester.pumpAndSettle();
    await tester.tap(find.text('重画'));
    await tester.pump();
    expect(guide, findsNothing);
    expect(find.text('圈出问题位置'), findsOneWidget);
  });

  testWidgets('ripple refracts the frozen image, then a loop becomes a frame',
      (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    const EdgeInsets insets = EdgeInsets.only(bottom: 24);
    await _pumpOverlay(tester, image: image, safeInsets: insets);
    expect(find.byKey(const Key('feedback-capture-lasso')), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
    expect(find.text('圈出问题位置'), findsNothing);

    await tester.pump(kBeamAuroraDuration * 0.4);
    final CustomPaint ripple = tester.widget<CustomPaint>(
        find.byWidgetPredicate((Widget w) =>
            w is CustomPaint && w.painter is WaterRipplePainter));
    // 默认水波纹以按压点（归一化 .25/.5）为中心扩散，而不是从屏幕角落扫入。
    final painter = ripple.painter! as WaterRipplePainter;
    expect(painter.origin, const Offset(100, 150));
    expect(painter.image, same(image));

    final dim = find.byWidgetPredicate((w) =>
        w is ColoredBox && w.color.withValues(alpha: 1) == kBeamDimColor);
    expect(dim, findsNothing);
    await tester.pump(const Duration(milliseconds: 272)); // 560 ms
    expect(dim, findsNothing);
    await tester.pump(const Duration(milliseconds: 160));
    expect(dim, findsNothing);
    expect(find.text('圈出问题位置'), findsOneWidget);
    final water = find.byWidgetPredicate((Widget w) =>
        w is CustomPaint && w.painter is WaterRipplePainter);
    expect(water, findsOneWidget);
    final Rect hint = tester.getRect(find.text('圈出问题位置'));
    final double windowHeight =
        tester.view.physicalSize.height / tester.view.devicePixelRatio;
    expect(hint.top, greaterThanOrEqualTo(0));
    expect(hint.bottom, lessThanOrEqualTo(windowHeight - insets.bottom - 10));

    final Finder lasso = find.byKey(const Key('feedback-capture-lasso'));
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(lasso) - const Offset(60, 40));
    for (final Offset delta in const <Offset>[
      Offset(40, 10),
      Offset(40, 40),
      Offset(-40, 30),
      Offset(-40, -30),
    ]) {
      await gesture.moveBy(delta);
      await tester.pump();
    }
    expect(water, findsNothing);
    await gesture.up();
    await tester.pump();
    expect(find.byKey(const Key('feedback-capture-selection')), findsOneWidget);
    expect(find.text('圈出问题位置'), findsNothing);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('确认'), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-cancel')), findsOneWidget);
    await tester.tap(find.text('重画'));
    await tester.pump();
    expect(guide, findsNothing);
    expect(find.text('圈出问题位置'), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
    expect(water, findsNothing);
    expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(image));
  });

  for (final nearBottom in [false, true]) {
    testWidgets('committed toolbar preserves the scrim between buttons (nearBottom=$nearBottom)',
        (tester) async {
      await _pumpOverlay(tester, image: await _image(tester), reduce: true);
      final y = nearBottom ? 218.0 : 58.0;
      final stroke = await tester.startGesture(Offset(80, y));
      for (final point in [Offset(115, y), Offset(245, y + 30), Offset(120, y + 50)]) {
        await stroke.moveTo(point);
        await tester.pump();
      }
      await stroke.up();
      await tester.pumpAndSettle();

      final confirm = tester.getRect(find.byKey(const Key('feedback-capture-use-region')));
      expect(confirm.center.dy < 150, nearBottom);
      final whole = tester.getRect(find.byKey(const Key('feedback-capture-whole-window')));
      final gapX = ((whole.right + confirm.left) / 2).floor();
      expect(gapX, greaterThan(whole.right));
      final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(const Key('lasso-test-surface')));
      await tester.runAsync(() async {
        final frame = await boundary.toImage();
        try {
          final bytes = (await frame.toByteData(format: ui.ImageByteFormat.rawRgba))!;
          int rgbaAt(int x, int y) => bytes.getUint32(4 * (frame.width * y + x));
          final outside = rgbaAt(2, 150);
          expect(rgbaAt(2, nearBottom ? 1 : 298), outside);
          expect(rgbaAt(gapX, confirm.center.dy.floor()), outside);
        } finally {
          frame.dispose();
        }
      });
    });
  }

  testWidgets('the drawn loop reveals original pixels and cancel restores the hint',
      (WidgetTester tester) async {
    await _pumpOverlay(tester, image: await _image(tester), reduce: true);
    final gesture = await tester.startGesture(const Offset(40, 50));
    for (final point in const [Offset(80, 50), Offset(240, 50), Offset(240, 170), Offset(80, 170)]) {
      await gesture.moveTo(point);
      await tester.pump();
    }
    expect(find.text('圈出问题位置'), findsNothing);
    expect(find.byKey(const Key('feedback-capture-cancel')), findsNothing);
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(const Key('lasso-test-surface')));
    await tester.runAsync(() async {
      final frame = await boundary.toImage();
      try {
        final bytes = (await frame.toByteData(format: ui.ImageByteFormat.rawRgba))!;
        int pixel(int x, int y) => bytes.getUint32(4 * (frame.width * y + x));
        expect(pixel(160, 110), 0x9e9e9eff); // Original Colors.grey.
        expect(pixel(290, 110), 0x9e9e9eff);
        expect(pixel(160, 50), isNot(0x9e9e9eff)); // Visible stroke over the original.
      } finally {
        frame.dispose();
      }
    });
    await gesture.cancel();
    await tester.pump();
    expect(find.text('圈出问题位置'), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
  });

  testWidgets('aurora keeps both fingertips and the selection midpoint',
      (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    await _pumpOverlay(tester,
        image: image, wakeVisual: FeedbackWakeVisual.aurora,
        wakeOrigins: const [Offset(76, 145), Offset(124, 155)]);
    await tester.pump(kBeamAuroraDuration * 0.4);
    final CustomPaint aurora = tester.widget<CustomPaint>(
        find.byWidgetPredicate((Widget w) =>
            w is CustomPaint && w.painter is BeamAuroraPainter));
    final painter = aurora.painter! as BeamAuroraPainter;
    expect(painter.origin, const Offset(100, 150));
    expect(painter.fingertips, const [Offset(76, 145), Offset(124, 155)]);
    expect(find.byWidgetPredicate((Widget w) =>
        w is CustomPaint && w.painter is WaterRipplePainter), findsNothing);
  });

  testWidgets('aurora colors light and dark pixels and leaves the idle hint background clear',
      (WidgetTester tester) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    canvas.drawColor(Colors.black, BlendMode.src);
    canvas.drawRect(const Rect.fromLTWH(200, 0, 200, 300), Paint()..color = Colors.white);
    final picture = recorder.endRecording();
    final image = picture.toImageSync(400, 300);
    picture.dispose();
    addTearDown(image.dispose);
    await _pumpOverlay(tester, image: image, wakeVisual: FeedbackWakeVisual.aurora,
        releasePoint: const Offset(.5, .5));
    final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(const Key('lasso-test-surface')));
    await tester.pump(kBeamAuroraDuration * .35);
    await tester.runAsync(() async {
      final frame = await boundary.toImage();
      try {
        final pixels = (await frame.toByteData(format: ui.ImageByteFormat.rawRgba))!;
        final left = (150 * 400 + 68) * 4;
        final right = (150 * 400 + 332) * 4;
        expect(pixels.getUint8(left + 2) - pixels.getUint8(left), greaterThan(20));
        expect(pixels.getUint8(right) - pixels.getUint8(right + 2), greaterThan(30));
      } finally {
        frame.dispose();
      }
    });
    await tester.pumpAndSettle();
    expect(find.text('圈出问题位置'), findsOneWidget);
    await tester.runAsync(() async {
      final frame = await boundary.toImage();
      try {
        final pixels = (await frame.toByteData(format: ui.ImageByteFormat.rawRgba))!;
        for (final y in [251, 280, 299]) {
          expect(pixels.getUint32((y * 400 + 12) * 4), 0x000000ff);
          expect(pixels.getUint32((y * 400 + 388) * 4), 0xffffffff);
        }
      } finally {
        frame.dispose();
      }
    });
  });

  testWidgets('reduced motion arms immediately; Escape cancels the surface',
      (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    bool cancelled = false;
    await _pumpOverlay(tester,
        image: image, reduce: true, onCancel: () => cancelled = true);
    expect(guide, findsNothing);
    expect(find.text('圈出问题位置'), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(cancelled, isTrue);
  });

  testWidgets('Enter before drawing uses the whole window', (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    bool whole = false;
    await _pumpOverlay(tester,
        image: image, reduce: true, onCaptureWhole: () => whole = true);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(whole, isTrue);
  });
}
