import 'dart:ui' as ui;

import 'package:feedback_widget/src/beam_aurora.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/wake_visual.dart';
import 'package:feedback_widget/src/water_ripple.dart';
import 'package:flutter/material.dart';
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
  await tester.pumpWidget(MaterialApp(
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
  ));
}

void main() {
  testWidgets('ripple refracts the frozen image, then a loop becomes a frame',
      (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    const EdgeInsets insets = EdgeInsets.only(bottom: 24);
    await _pumpOverlay(tester, image: image, safeInsets: insets);
    expect(find.byKey(const Key('feedback-capture-lasso')), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-selection')), findsNothing);
    expect(find.text('画个圈，只需圈出问题位置'), findsNothing);

    await tester.pump(kBeamAuroraDuration * 0.4);
    final CustomPaint ripple = tester.widget<CustomPaint>(
        find.byWidgetPredicate((Widget w) =>
            w is CustomPaint && w.painter is WaterRipplePainter));
    // 默认水波纹以按压点（归一化 .25/.5）为中心扩散，而不是从屏幕角落扫入。
    final painter = ripple.painter! as WaterRipplePainter;
    expect(painter.origin, const Offset(100, 150));
    expect(painter.image, same(image));

    await tester.pump(kBeamAuroraDuration * 0.7);
    expect(find.text('画个圈，只需圈出问题位置'), findsOneWidget);
    final water = find.byWidgetPredicate((Widget w) =>
        w is CustomPaint && w.painter is WaterRipplePainter);
    expect(water, findsOneWidget);
    final Rect hint = tester.getRect(find.text('画个圈，只需圈出问题位置'));
    final double windowHeight =
        tester.view.physicalSize.height / tester.view.devicePixelRatio;
    expect(hint.top, greaterThanOrEqualTo(0));
    expect(hint.bottom, lessThanOrEqualTo(windowHeight - insets.bottom - 40));

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
    expect(find.text('画个圈，只需圈出问题位置'), findsNothing);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('使用此区域'), findsOneWidget);
    expect(find.byKey(const Key('feedback-capture-cancel')), findsOneWidget);
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

  testWidgets('reduced motion arms immediately; Escape cancels the surface',
      (WidgetTester tester) async {
    final ui.Image image = await _image(tester);
    bool cancelled = false;
    await _pumpOverlay(tester,
        image: image, reduce: true, onCancel: () => cancelled = true);
    expect(find.text('画个圈，只需圈出问题位置'), findsOneWidget);
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
