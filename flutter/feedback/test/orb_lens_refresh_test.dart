import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/orb_idle.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

final Finder _shader = find.byKey(const Key('feedback-orb-lens-shader'));

OrbLiquidLensPainter _lens(WidgetTester tester) =>
    tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;

Widget _scene(Color background) => Stack(children: <Widget>[
      Positioned.fill(child: ColoredBox(color: background)),
      const Positioned(
          left: 100,
          top: 100,
          width: 120,
          height: 80,
          child: FeedbackCaptureMask(
              maskColor: Color(0x106E6E73),
              child: ColoredBox(color: Colors.red))),
    ]);

Future<void> _expectPixels(
    WidgetTester tester, OrbLiquidLensPainter lens, Color background) async {
  final ByteData? raw = await tester.runAsync<ByteData?>(
      () => lens.image.toByteData(format: ui.ImageByteFormat.rawRgba));
  final Uint8List pixels = raw!.buffer.asUint8List();
  List<int> at(int x, int y) {
    final int index = ((y * lens.scale).floor() * lens.image.width +
            (x * lens.scale).floor()) *
        4;
    return pixels.sublist(index, index + 4);
  }

  final int argb = background.toARGB32();
  expect(at(20, 20),
      <int>[(argb >> 16) & 255, (argb >> 8) & 255, argb & 255, 255]);
  expect(at(120, 120), <int>[110, 110, 115, 255],
      reason: 'every updated frame must keep sensitive pixels opaque');
}

Future<void> _waitForBackground(WidgetTester tester, Color background) async {
  final int argb = background.toARGB32();
  final List<int> expected = <int>[
    (argb >> 16) & 255,
    (argb >> 8) & 255,
    argb & 255,
    255
  ];
  // A capture already in flight at the scene change may still describe the
  // previous frame. The following serial sample must catch the new scene.
  for (int i = 0; i < 20; i++) {
    if (_shader.evaluate().isNotEmpty) {
      final OrbLiquidLensPainter paint = _lens(tester);
      final ByteData? raw = await tester.runAsync<ByteData?>(
          () => paint.image.toByteData(format: ui.ImageByteFormat.rawRgba));
      final int offset = ((20 * paint.scale).floor() * paint.image.width +
              (20 * paint.scale).floor()) *
          4;
      final List<int> pixel =
          raw!.buffer.asUint8List().sublist(offset, offset + 4);
      if (List<int>.generate(4, (int c) => pixel[c] - expected[c])
          .every((int delta) => delta == 0)) {
        return;
      }
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('visible glass did not follow the changed host pixels within 1s');
}

void main() {
  late LiquidHarness host;
  late Duration oldGate;
  setUp(() {
    host = LiquidHarness();
    oldGate = debugOrbLensGateDuration;
    debugOrbLensGateDuration = const Duration(milliseconds: 250);
    debugDisableOrbLensCapture = false;
    debugOrbLensCaptureAttempts = 0;
    host.content = _scene(const Color(0xFF0000FF));
  });
  tearDown(() {
    debugOrbLensGateDuration = oldGate;
    debugFailOrbLensCapture = false;
    debugOrbLensCaptureBarrier = null;
    debugCaptureEncodeBarrier = null;
    host.dispose();
  });

  testWidgets(
      'visible idle glass follows host pixels without a page identity change',
      (tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    await _expectPixels(tester, _lens(tester), const Color(0xFF0000FF));
    for (final Color color in <Color>[
      const Color(0xFF00FF00),
      const Color(0xFF2200CC),
    ]) {
      final ui.Image previous = _lens(tester).image;
      host.content = _scene(color);
      host.rebuild();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      await pumpUntil(
          tester,
          () =>
              _shader.evaluate().isNotEmpty &&
              !identical(_lens(tester).image, previous));
      await _expectPixels(tester, _lens(tester), color);
    }
    expect(debugOrbLensCaptureAttempts, 3);
    expect(tester.takeException(), isNull);
  });

  for (final FeedbackOrbIdleStyle style in <FeedbackOrbIdleStyle>[
    FeedbackOrbIdleStyle.edge,
    FeedbackOrbIdleStyle.handle,
  ]) {
    testWidgets(
        '${style.name} keeps refreshing while collapsed and wakes with current pixels',
        (tester) async {
      await host.preferences
          .write(orbIdleStorageKey(host.appId), encodeOrbIdleStyle(style));
      await host.mount(tester);
      await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
      final ui.Image initial = _lens(tester).image;
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(milliseconds: 450));
      await pumpUntil(
          tester,
          () =>
              _shader.evaluate().isNotEmpty &&
              !identical(_lens(tester).image, initial));
      expect(find.byKey(const Key('feedback-orb-collapsed')), findsOneWidget);
      host.content = _scene(const Color(0xFF00FF00));
      host.rebuild();
      await tester.pump();
      await _waitForBackground(tester, const Color(0xFF00FF00));
      await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
      await tester.tap(find.byKey(const Key('feedback-orb-collapsed')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 450));
      await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
      await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
      expect(find.byKey(const Key('feedback-orb-collapsed')), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'completion waits 250ms and a slow capture never queues timer work',
      (tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    final ui.Image previous = _lens(tester).image;
    final Completer<void> barrier = Completer<void>();
    debugOrbLensCaptureBarrier = () => barrier.future;
    expect(debugOrbLensCaptureAttempts, 1);
    // Painting the accepted image costs one 16ms pump after completion; use a
    // 200ms observation within the 250ms gap rather than mistaking that paint
    // delay for capture completion time.
    await tester.pump(const Duration(milliseconds: 200));
    expect(debugOrbLensCaptureAttempts, 1);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(debugOrbLensCaptureAttempts, 2);
    // Hold one real production capture before rasterization; advancing time
    // must not create a timer per elapsed interval while it is in flight.
    for (int i = 0; i < 4; i++) {
      host.rebuild();
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(debugOrbLensCaptureAttempts, 2);
    debugOrbLensCaptureBarrier = null;
    barrier.complete();
    await pumpUntil(tester, () => !identical(_lens(tester).image, previous));
    expect(debugOrbLensCaptureAttempts, 2);
    await tester.pump(const Duration(milliseconds: 200));
    expect(debugOrbLensCaptureAttempts, 2);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(debugOrbLensCaptureAttempts, 3);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    expect(_shader, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'a failed automatic refresh clears old pixels and stops until explicit recovery',
      (tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    debugFailOrbLensCapture = true;
    await tester.pump(const Duration(milliseconds: 250));
    await pumpUntil(tester, () => _shader.evaluate().isEmpty);
    expect(debugOrbLensCaptureAttempts, 2);
    debugFailOrbLensCapture = false;
    host.content = _scene(const Color(0xFF00FF00));
    host.rebuild();
    for (int i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(debugOrbLensCaptureAttempts, 2);
    expect(_shader, findsNothing);
    host.controller.open();
    await tester.pump();
    host.controller.close();
    await tester.pump();
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
    expect(debugOrbLensCaptureAttempts, 3);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'panel and app background stop updates and resume with fresh pixels',
      (tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    host.controller.open();
    await tester.pump();
    await tester.pump();
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(debugOrbLensCaptureAttempts, 1);
    expect(_shader, findsNothing);
    host.controller.close();
    await tester.pump();
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    expect(debugOrbLensCaptureAttempts, 2);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(debugOrbLensCaptureAttempts, 2);
    host.content = _scene(const Color(0xFF00FF00));
    host.rebuild();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
    expect(debugOrbLensCaptureAttempts, 3);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'hidden idle cancels the refresh timer and returns with current pixels',
      (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden));
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(_shader, findsNothing);
    final int attempts = debugOrbLensCaptureAttempts;
    host.content = _scene(const Color(0xFF00FF00));
    host.rebuild();
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(debugOrbLensCaptureAttempts, attempts);
    host.controller.open();
    await tester.pump();
    host.controller.close();
    await tester.pump();
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
    expect(debugOrbLensCaptureAttempts, attempts + 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'frequent host scroll invalidates immediately but resamples at a bounded cadence',
      (tester) async {
    await host.mount(tester);
    await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
    final int initial = debugOrbLensCaptureAttempts;
    host.content = _scene(const Color(0xFF00FF00));
    host.rebuild();
    await tester.pump();
    final BuildContext childContext =
        tester.element(find.byType(FeedbackCaptureMask));
    for (int i = 0; i < 20; i++) {
      ScrollUpdateNotification(
              metrics: FixedScrollMetrics(
                  minScrollExtent: 0,
                  maxScrollExtent: 100,
                  pixels: i.toDouble(),
                  viewportDimension: 600,
                  axisDirection: AxisDirection.down,
                  devicePixelRatio: 2),
              context: childContext)
          .dispatch(childContext);
      await tester.pump(const Duration(milliseconds: 16));
      if (i == 0) {
        await tester.pump();
        expect(_shader, findsNothing,
            reason: 'the known stale scene clears before waiting to resample');
      }
    }
    expect(debugOrbLensCaptureAttempts, lessThanOrEqualTo(initial + 2),
        reason: '20 notifications over 320ms must not start 20 full captures');
    await _waitForBackground(tester, const Color(0xFF00FF00));
    await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
    expect(tester.takeException(), isNull);
  });

  for (final bool cancel in <bool>[false, true]) {
    testWidgets(
        'formal PNG encoding stops decoration and ${cancel ? 'cancel' : 'close'} resumes fresh glass',
        (tester) async {
      host.captureMode = FeedbackCaptureMode.viewport;
      await host.mount(tester);
      await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
      final int initial = debugOrbLensCaptureAttempts;
      final Completer<void> encode = Completer<void>();
      bool encoding = false;
      debugCaptureEncodeBarrier = () {
        encoding = true;
        return encode.future;
      };
      final Future<void> capture = host.controller.captureAndOpen();
      await pumpUntil(tester, () => encoding);
      for (int i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 250));
      }
      expect(debugOrbLensCaptureAttempts, initial);
      expect(host.controller.isOpen, isFalse);
      host.content = _scene(const Color(0xFF00FF00));
      host.rebuild();
      if (cancel) host.controller.cancelCapture();
      debugCaptureEncodeBarrier = null;
      encode.complete();
      if (!cancel) {
        await pumpUntil(tester, () => host.controller.isOpen);
        await capture;
        expect(debugOrbLensCaptureAttempts, initial);
        host.controller.close();
      } else {
        await tester.runAsync(() => capture);
        expect(host.controller.isOpen, isFalse,
            reason:
                'the old formal capture must not reopen after cancellation');
      }
      await tester.pump();
      await _waitForBackground(tester, const Color(0xFF00FF00));
      await _expectPixels(tester, _lens(tester), const Color(0xFF00FF00));
      expect(debugOrbLensCaptureAttempts, initial + 1);
      expect(tester.takeException(), isNull);
    });
  }
}
