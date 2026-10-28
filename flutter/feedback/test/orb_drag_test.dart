import 'dart:io';
import 'dart:math' as math;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _body = find.byKey(const Key('feedback-orb-body'));

OrbPainter _painter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
        find.descendant(of: _body, matching: find.byType(CustomPaint)))
    .map((CustomPaint paint) => paint.painter)
    .whereType<OrbPainter>()
    .single;

TweenAnimationBuilder<Offset> _translation(WidgetTester tester) => tester
    .widgetList<TweenAnimationBuilder<Offset>>(find.descendant(
        of: _orb,
        matching: find.byWidgetPredicate(
            (Widget widget) => widget is TweenAnimationBuilder<Offset>)))
    .single;

Offset _offset(WidgetTester tester) {
  final Transform transform = tester.widget<Transform>(
      find.descendant(of: _orb, matching: find.byType(Transform)).first);
  return Offset(
      transform.transform.storage[12], transform.transform.storage[13]);
}

void _expectOffset(Offset actual, Offset expected) {
  expect(actual.dx, closeTo(expected.dx, 1e-6));
  expect(actual.dy, closeTo(expected.dy, 1e-6));
}

void _logFrame(WidgetTester tester, String label) {
  final OrbPainter painter = _painter(tester);
  final Offset offset = _offset(tester);
  debugPrint('T4-5 $label diameter=${tester.getSize(_body).width} '
      'angle=${painter.dragAngle} pull=${painter.pull} '
      'translate=(${offset.dx},${offset.dy}) '
      'glow=(${painter.glowOffset.dx},${painter.glowOffset.dy})');
}

Future<TestGesture> _startPan(WidgetTester tester) async {
  final TestGesture gesture = await tester.startGesture(tester.getCenter(_orb));
  // 保留既有 DragStartBehavior.start：先跨过 Flutter pan slop，再累计业务位移。
  await gesture.moveBy(const Offset(-40, -40));
  await tester.pump();
  return gesture;
}

void _expectDocked(WidgetTester tester) {
  expect(tester.getSize(_body), const Size(56, 56));
  expect(_painter(tester).pull, 0.0);
  expect(_painter(tester).dragAngle, 0.0);
  _expectOffset(_painter(tester).glowOffset, Offset.zero);
  _expectOffset(_offset(tester), Offset.zero);
}

Future<void> _overlayWithoutAdvancingTime(WidgetTester tester) async {
  for (int index = 0; index < 200; index++) {
    await tester.pump();
    if (find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty) return;
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
  }
  fail('冻结捕获未挂载选区覆盖层');
}

void main() {
  late FeedbackController controller;
  late http.Client client;
  late ValueNotifier<bool> reduced;

  setUp(() {
    controller = FeedbackController();
    client = captureMockClient();
    reduced = ValueNotifier<bool>(false);
  });

  tearDown(() {
    controller.dispose();
    client.close();
    reduced.dispose();
  });

  Future<void> pumpHost(WidgetTester tester,
      {bool reducedMotion = false, Size surface = const Size(800, 600)}) async {
    reduced.value = reducedMotion;
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: ValueListenableBuilder<bool>(
        valueListenable: reduced,
        builder: (BuildContext context, bool reduce, Widget? child) =>
            MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduce),
          child: child!,
        ),
        child: FeedbackWidget(
          config: FeedbackConfig(
            'https://svc.test',
            'com.example.orb-drag',
            launcherMode: FeedbackLauncherMode.orb,
            captureMode: FeedbackCaptureMode.viewport,
          ),
          controller: controller,
          tokenStore: MemoryTokenStore('tok'),
          serverPrefStore: MemoryServerPrefStore(),
          httpClient: client,
          child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
        ),
      ),
    ));
    await tester.pump();
  }

  for (final Offset vector in <Offset>[
    const Offset(80, 0),
    const Offset(0, 80),
    const Offset(60, 80),
    const Offset(160, 0),
  ]) {
    testWidgets('固定向量 $vector 同帧 angle/pull/glow', (WidgetTester tester) async {
      await pumpHost(tester);
      final TestGesture gesture = await _startPan(tester);
      await gesture.moveBy(vector);
      await tester.pump();
      final OrbPainter painter = _painter(tester);
      final double angle = vector.dx == 0
          ? math.pi / 2
          : (vector.dy == 0 ? 0 : math.atan2(80, 60));
      final Offset glow = vector.dx == 60
          ? const Offset(-2.4, -3.2)
          : (vector.dx == 0 ? const Offset(0, -4) : const Offset(-4, 0));
      expect(painter.dragAngle, closeTo(angle, 1e-6));
      expect(painter.pull, 1.0);
      _expectOffset(painter.glowOffset, glow);
      _expectOffset(_offset(tester), vector);
      expect(_translation(tester).duration, Duration.zero);
      _logFrame(tester, 'VECTOR input=(${vector.dx},${vector.dy}) same-frame');
      await gesture.cancel();
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('阈值严格 >8：8px 不拖动，8.01px pull=0.100125',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(8, 0));
    await tester.pump();
    expect(_painter(tester).pull, 0.0);
    expect(_painter(tester).dragAngle, 0.0);
    expect(tester.getSize(_body), const Size(56, 56));
    _logFrame(tester, 'THRESHOLD 8px');
    await gesture.moveBy(const Offset(0.01, 0));
    await tester.pump();
    expect(_painter(tester).pull, closeTo(0.100125, 1e-6));
    expect(_painter(tester).dragAngle, 0.0);
    expect(tester.widget<AnimatedContainer>(_body).constraints!.maxWidth, 84.0);
    _logFrame(tester, 'THRESHOLD 8.01px');
    await gesture.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('连续 moveBy 同帧 1:1，pull 和 translate 无平滑',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await _startPan(tester);
    Offset cumulative = Offset.zero;
    for (final Offset delta in <Offset>[
      const Offset(12, 0),
      const Offset(8, 6),
      const Offset(-5, 7),
      const Offset(10, -3),
    ]) {
      cumulative += delta;
      await gesture.moveBy(delta);
      await tester.pump();
      _expectOffset(_offset(tester), cumulative);
      expect(_painter(tester).pull, closeTo(cumulative.distance / 80, 1e-6));
      expect(_translation(tester).duration, Duration.zero);
      final Iterable<TweenAnimationBuilder<double>> tweens =
          tester.widgetList<TweenAnimationBuilder<double>>(find.descendant(
              of: _body,
              matching: find.byWidgetPredicate(
                  (Widget widget) => widget is TweenAnimationBuilder<double>)));
      expect(tweens.last.duration, Duration.zero);
      _logFrame(
          tester, 'FOLLOW accumulated=(${cumulative.dx},${cumulative.dy})');
    }
    await gesture.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('松手 0/55/230/480ms：连续回弹、过冲 clamp 与精确归位',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(80, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.up();
    await tester.pump();
    expect(tester.getSize(_body), const Size(84, 84));
    expect(_painter(tester).pull, 1.0);
    _expectOffset(_offset(tester), const Offset(80, 0));
    _expectOffset(_painter(tester).glowOffset, const Offset(-4, 0));
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    expect(_translation(tester).curve, kFeedbackOrbReleaseCurve);
    expect(_translation(tester).child, isNotNull,
        reason: '平移动画使用 child，避免每帧重建球体');
    expect(tester.widget<AnimatedContainer>(_body).duration,
        kFeedbackOrbReleaseDuration);
    expect(tester.widget<AnimatedContainer>(_body).curve,
        kFeedbackOrbReleaseCurve);
    _logFrame(tester, 'RELEASE @0ms');
    await tester.pump(const Duration(milliseconds: 55));
    expect(tester.getSize(_body).width, inExclusiveRange(56.0, 84.0));
    expect(_painter(tester).pull, inExclusiveRange(0.0, 1.0));
    expect(_offset(tester).dx, inExclusiveRange(0.0, 80.0));
    expect(_painter(tester).breathWeight, 0.0);
    _logFrame(tester, 'RELEASE @55ms');
    await tester.pump(const Duration(milliseconds: 175));
    // 指定 Cubic 在 230ms 已过冲；按精确曲线断言，不能伪造 (56,84)/(0,1)。
    final double progress = kFeedbackOrbReleaseCurve.transform(0.5);
    expect(progress, greaterThan(1.0));
    expect(tester.getSize(_body).width, closeTo(84 - 28 * progress, 1e-6));
    expect(_painter(tester).pull, 0.0);
    _expectOffset(_offset(tester), Offset(80 * (1 - progress), 0));
    _expectOffset(_painter(tester).glowOffset, Offset.zero);
    expect(_offset(tester).dx, isNot(0.0));
    expect(_painter(tester).breathWeight, 0.0);
    _logFrame(tester, 'RELEASE @230ms');
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump();
    _expectDocked(tester);
    expect(_painter(tester).stateScale, 1.0);
    expect(_painter(tester).breathWeight, 1.0);
    _logFrame(tester, 'RELEASE @480ms');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('releasePoint 在 460ms 尚未结束时交付选区，不随回弹位置改变',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final Offset start = tester.getCenter(_orb);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(-80, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    final Offset releaseGlobal = start + const Offset(-120, -80);
    await gesture.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 55));
    await _overlayWithoutAdvancingTime(tester);
    final CaptureSelectionOverlay overlay = tester
        .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay));
    final Offset expected =
        Offset(releaseGlobal.dx / 800, releaseGlobal.dy / 600);
    _expectOffset(overlay.releasePoint!, expected);
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    expect(_painter(tester).pull, inExclusiveRange(0.0, 1.0));
    expect(_painter(tester).dragAngle, closeTo(math.atan2(-40, -80), 1e-6));
    expect(controller.isOpen, isFalse);
    debugPrint(
        'T4-5 CAPTURE @55ms releaseGlobal=(${releaseGlobal.dx},${releaseGlobal.dy}) '
        'releasePoint=(${overlay.releasePoint!.dx},${overlay.releasePoint!.dy}) '
        'releaseDuration=${_translation(tester).duration.inMilliseconds}ms');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('pointercancel 不捕获，冻结方向并执行完整 460ms 回弹',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(60, 80));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    await gesture.cancel();
    await tester.pump();
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    expect(_painter(tester).dragAngle, closeTo(math.atan2(80, 60), 1e-6));
    _logFrame(tester, 'CANCEL @0ms');
    await tester.pump(const Duration(milliseconds: 55));
    expect(_painter(tester).pull, inExclusiveRange(0.0, 1.0));
    expect(_painter(tester).dragAngle, closeTo(math.atan2(80, 60), 1e-6));
    await tester.pump(const Duration(milliseconds: 175));
    _logFrame(tester, 'CANCEL @230ms');
    expect(_offset(tester).distance, greaterThan(0.0));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump();
    _expectDocked(tester);
    await tester.runAsync(() async {});
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(find.byType(FeedbackPanel), findsNothing);
    expect(controller.isOpen, isFalse);
    _logFrame(tester, 'CANCEL @480ms capture=none');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reduced-motion 松手当帧归位，1:1 位移与捕获照常', (WidgetTester tester) async {
    await pumpHost(tester, reducedMotion: true);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(-80, 0));
    await tester.pump();
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).pull, 0.0);
    expect(_painter(tester).dragAngle, 0.0);
    _expectOffset(_painter(tester).glowOffset, Offset.zero);
    _expectOffset(_offset(tester), const Offset(-80, 0));
    await gesture.up();
    await tester.pump();
    _expectDocked(tester);
    expect(_translation(tester).duration, Duration.zero);
    expect(tester.binding.transientCallbackCount, 0);
    _logFrame(tester, 'REDUCED @0ms');
    await _overlayWithoutAdvancingTime(tester);
    final CaptureSelectionOverlay overlay = tester
        .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay));
    _expectOffset(overlay.releasePoint!, const Offset(632 / 800, 382 / 600));
    debugPrint('T4-5 REDUCED capture=selection releasePoint='
        '(${overlay.releasePoint!.dx},${overlay.releasePoint!.dy})');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('回弹 @100ms 再按下立即清 release，重新移动按新累计位移 1:1',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture first = await _startPan(tester);
    await first.moveBy(const Offset(-80, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    await first.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    _logFrame(tester, 'REGRAB before pointerdown');
    debugPrint('T4-5 REGRAB hitbox=${tester.getRect(_orb)} body=${tester.getRect(_body)}');
    final TestGesture second =
        await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(_translation(tester).duration, Duration.zero);
    _expectOffset(_offset(tester), Offset.zero);
    expect(_painter(tester).pull, 0.0);
    await second.moveBy(const Offset(-40, -40));
    await second.moveBy(const Offset(24, 32));
    await tester.pump();
    _expectOffset(_offset(tester), const Offset(24, 32));
    expect(_painter(tester).pull, closeTo(0.5, 1e-6));
    expect(_painter(tester).dragAngle, closeTo(math.atan2(32, 24), 1e-6));
    _expectOffset(_painter(tester).glowOffset, const Offset(-1.2, -1.6));
    _logFrame(tester, 'REGRAB @100ms new=(24,32)');
    await second.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('运行中启用 reduced-motion 当帧取消回弹和全部装饰位移',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(-80, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 55));
    expect(_painter(tester).pull, greaterThan(0.0));
    reduced.value = true;
    await tester.pump();
    _expectDocked(tester);
    expect(_translation(tester).duration, Duration.zero);
    expect(tester.widget<AnimatedContainer>(_body).duration, Duration.zero);
    expect(_painter(tester).stateScale, 1.0);
    expect(tester.binding.transientCallbackCount, 0);
    _logFrame(tester, 'REDUCED switched @55ms same-frame');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('释放中 hover 不抢占 scale1；结束后恢复 hover1.04',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6));
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(-80, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    await gesture.cancel();
    await tester.pump();
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 55));
    expect(_painter(tester).stateScale, 1.0);
    expect(_painter(tester).breathWeight, 0.0);
    final TweenAnimationBuilder<double> scale = tester
        .widgetList<TweenAnimationBuilder<double>>(find.descendant(
            of: _body,
            matching: find.byWidgetPredicate(
                (Widget widget) => widget is TweenAnimationBuilder<double>)))
        .first;
    expect(scale.duration, kFeedbackOrbReleaseDuration);
    expect(scale.curve, kFeedbackOrbReleaseCurve);
    expect(scale.tween.end, 1.0);
    await tester.pump(const Duration(milliseconds: 425));
    await tester.pump();
    await mouse.moveTo(Offset.zero);
    await tester.pump();
    await mouse.moveTo(tester.getCenter(_orb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6));
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('窄屏 390x844 的拖动和取消归位无几何回归', (WidgetTester tester) async {
    await pumpHost(tester, surface: const Size(390, 844));
    final TestGesture gesture = await _startPan(tester);
    await gesture.moveBy(const Offset(-24, 32));
    await tester.pump();
    _expectOffset(_offset(tester), const Offset(-24, 32));
    expect(_painter(tester).pull, closeTo(0.5, 1e-6));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 480));
    await tester.pump();
    _expectDocked(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('源码守卫：只有一个 AnimationController，回弹不新增 Timer', () {
    final String source = File('${Directory.current.path}/lib/src/widget.dart')
        .readAsStringSync();
    expect(RegExp(r'AnimationController\(').allMatches(source).length, 1);
    expect(RegExp(r'\bTimer(?:\.periodic)?\(').allMatches(source), isEmpty);
    expect(RegExp(r'TweenAnimationBuilder<').allMatches(source).length, 3);
    debugPrint(
        'T4-5 SOURCE AnimationController(=1 TweenAnimationBuilder=3 Timer=0');
  });
}
