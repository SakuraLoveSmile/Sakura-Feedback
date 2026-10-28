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

void _expectOffset(Offset actual, Offset expected, {String? reason}) {
  expect(actual.dx, closeTo(expected.dx, 1e-6), reason: reason);
  expect(actual.dy, closeTo(expected.dy, 1e-6), reason: reason);
}

/// 回弹第 `elapsedMs` 毫秒的曲线进度，用于按精确曲线断言中间帧。
double _releaseProgress(int elapsedMs) => kFeedbackOrbReleaseCurve
    .transform(elapsedMs / kFeedbackOrbReleaseDuration.inMilliseconds);

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

  group('spec 5.2 指针准入（2026-10-29 加固，对齐 Web 的 button/pointerId 守卫）', () {
    testWidgets('右键按下不进入 pressed，也不起拖动', (WidgetTester tester) async {
      await pumpHost(tester);
      final TestGesture mouse = await tester.createGesture(
          kind: PointerDeviceKind.mouse, buttons: kSecondaryButton);
      await mouse.addPointer(location: tester.getCenter(_orb));
      await mouse.down(tester.getCenter(_orb));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 160));

      // 鼠标指针停在球上会正常进入 hover 1.04；这里要的是「不进 pressed」。
      expect(_painter(tester).stateScale, closeTo(1.04, 1e-3),
          reason: '右键只应保留 hover，不得亮起 pressed 的 0.94');
      await mouse.moveBy(const Offset(-40, -40));
      await tester.pump();
      _expectOffset(_offset(tester), Offset.zero, reason: '右键不得起拖动');
      expect(_painter(tester).pull, 0.0);

      await mouse.up();
      await tester.pump();
      await mouse.removePointer();
      debugPrint('spec 5.2 secondary: stateScale=${_painter(tester).stateScale}, '
          'offset=${_offset(tester)}, pull=${_painter(tester).pull}');
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('拖动中第二指按下：不清零累计位移，球不跳回',
        (WidgetTester tester) async {
      await pumpHost(tester);
      final TestGesture first = await _startPan(tester);
      await first.moveBy(const Offset(-30, -20));
      await tester.pump();
      final Offset beforeSecond = _offset(tester);
      final double pullBefore = _painter(tester).pull;
      expect(beforeSecond, isNot(Offset.zero));

      // 第二指落在球上：过滤前这里会把 _dragOffset 清零，球瞬间跳回原位。
      // 按 _orb（命中盒）而不是 _body（视觉）取点：业务位移的 Transform 在手势盒
      // 内部，拖动中视觉已偏移、命中盒仍在停靠位，照视觉取点会落到宿主子树上。
      final TestGesture second =
          await tester.startGesture(tester.getCenter(_orb), pointer: 99);
      await tester.pump();

      _expectOffset(_offset(tester), beforeSecond,
          reason: '第二指按下不得清零第一指的累计位移');
      expect(_painter(tester).pull, closeTo(pullBefore, 1e-9));

      // 第二指抬起也不得提前结束第一指的按压语义。
      await second.up();
      await tester.pump();
      _expectOffset(_offset(tester), beforeSecond,
          reason: '第二指抬起不得影响第一指');

      debugPrint('spec 5.2 second finger: before=$beforeSecond, '
          'after=${_offset(tester)}, pull=${_painter(tester).pull}');
      await first.up();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 480));
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('按下期间入口被隐藏：恢复后仍可再次按下（活跃指针已释放）',
        (WidgetTester tester) async {
      await pumpHost(tester);
      final TestGesture gesture =
          await tester.startGesture(tester.getCenter(_orb));
      await tester.pump();

      // 面板打开 → 入口 hidden，Listener 随之卸载。Flutter 按指针保留按下时的
      // 命中路径，抬起仍会派发到已 detach 的 Listener，活跃指针靠这一下释放。
      controller.open();
      await tester.pump();
      await tester.pump();
      expect(_orb, findsNothing);
      await gesture.up();
      await tester.pump();

      controller.close();
      await tester.pump();
      await tester.pump();
      expect(_orb, findsOneWidget);

      // 若 _orbPointer 卡住非空，这一下会被当成「第二指」丢弃、pressed 不亮。
      final TestGesture again =
          await tester.startGesture(tester.getCenter(_orb));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 160));
      expect(_painter(tester).stateScale, closeTo(0.94, 1e-6),
          reason: 'hidden 打断按下后活跃指针必须随抬起释放，否则球永久点不动');

      debugPrint('spec 5.2 hidden release: stateScale='
          '${_painter(tester).stateScale}');
      await again.up();
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('拖动中入口被隐藏：恢复后仍可再次按下（活跃指针已释放）',
        (WidgetTester tester) async {
      await pumpHost(tester);
      // 与上一条的区别：pan 已经胜出。卸载时 RawGestureDetectorState.dispose 会在
      // 锁定的 widget 树里 reject 手势并回调 onPanCancel，裸 setState 会当场抛
      // `widget tree was locked`。
      final TestGesture gesture = await _startPan(tester);
      await gesture.moveBy(const Offset(-30, -20));
      await tester.pump();
      expect(_painter(tester).pull, greaterThan(0.0));

      controller.open();
      await tester.pump();
      await tester.pump();
      expect(_orb, findsNothing);
      await gesture.up();
      await tester.pump();

      controller.close();
      await tester.pump();
      await tester.pump();
      expect(_orb, findsOneWidget);

      final TestGesture again =
          await tester.startGesture(tester.getCenter(_orb));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 160));
      expect(_painter(tester).stateScale, closeTo(0.94, 1e-6),
          reason: '拖动被 hidden 打断后仍须回到可按下的干净状态');

      debugPrint('spec 5.2 drag hidden release: stateScale='
          '${_painter(tester).stateScale}');
      await again.up();
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

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
    // 呼吸权重按同一回弹曲线从 0 拉回 1（spec 7）：回弹不是「结束瞬间接上呼吸」，
    // 而是整段 460ms 内渐入，与 Web 的 `--fb-orb-breath-weight` transition 同口径。
    expect(_painter(tester).breathWeight,
        closeTo(_releaseProgress(55), 1e-6));
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
    // 权重与 scale 共用曲线，所以这里同样过冲到 >1（Web 的 registered number
    // 也不钳制）；0.02 × 过冲量只让呼吸幅度短暂略超 ±2%。
    expect(_painter(tester).breathWeight, closeTo(progress, 1e-6));
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
    // hover 不抢占回弹，呼吸权重也一样按回弹曲线渐入（Web 的 hover 规则带
    // `:not(.is-releasing)`，回弹期间权重回落到基值 1）。
    expect(_painter(tester).breathWeight, closeTo(_releaseProgress(55), 1e-6));
    final List<TweenAnimationBuilder<double>> stateTweens = tester
        .widgetList<TweenAnimationBuilder<double>>(find.descendant(
            of: _body,
            matching: find.byWidgetPredicate(
                (Widget widget) => widget is TweenAnimationBuilder<double>)))
        .toList();
    // 由外到内：呼吸权重、stateScale。两者共用回弹时长与曲线，目标同为 1。
    expect(stateTweens.length, greaterThanOrEqualTo(2));
    for (final TweenAnimationBuilder<double> tween in stateTweens.take(2)) {
      expect(tween.duration, kFeedbackOrbReleaseDuration);
      expect(tween.curve, kFeedbackOrbReleaseCurve);
      expect(tween.tween.end, 1.0);
    }
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
    final String source = readComponentSource('lib/src/widget.dart');
    expect(RegExp(r'AnimationController\(').allMatches(source).length, 1);
    expect(RegExp(r'\bTimer(?:\.periodic)?\(').allMatches(source), isEmpty);
    // 4 = 平移、呼吸权重、stateScale、pull。2026-10-29 从 3 改为 4：呼吸权重
    // 过渡是声明式 tween，不新增 Ticker 之外的计时资源，守卫的本意不变。
    expect(RegExp(r'TweenAnimationBuilder<').allMatches(source).length, 4);
    debugPrint(
        'T4-5 SOURCE AnimationController(=1 TweenAnimationBuilder=4 Timer=0');
  });
}
