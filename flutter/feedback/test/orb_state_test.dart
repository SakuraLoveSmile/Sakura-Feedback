import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

final Finder _body = find.byKey(const Key('feedback-orb-body'));
final Finder _orb = find.byKey(const Key('feedback-orb'));

OrbPainter _painter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
        find.descendant(of: _body, matching: find.byType(CustomPaint)))
    .map((CustomPaint paint) => paint.painter)
    .whereType<OrbPainter>()
    .single;

// 只隔离点击后业务 hidden，保留真实 Listener、手势分流和缩放退出动画。
class _VisualController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
  }
}

void main() {
  late _VisualController controller;
  late http.Client client;

  setUp(() {
    controller = _VisualController();
    client = captureMockClient();
  });

  tearDown(() {
    controller.dispose();
    client.close();
  });

  Future<void> pumpHost(WidgetTester tester,
      {bool reducedMotion = false}) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: Builder(builder: (BuildContext context) {
        return MediaQuery(
          data:
              MediaQuery.of(context).copyWith(disableAnimations: reducedMotion),
          child: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-state',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.off,
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: client,
            child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
          ),
        );
      }),
    ));
    await tester.pump();
  }

  Future<TestGesture> hover(WidgetTester tester) async {
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    return mouse;
  }

  Future<TestGesture> drag(WidgetTester tester) async {
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(_orb));
    await gesture.moveBy(const Offset(-40, -40));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump();
    return gesture;
  }

  testWidgets('idle：基础直径56、stateScale为1', (WidgetTester tester) async {
    await pumpHost(tester);
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).stateScale, 1.0);
    expect(_painter(tester).breathWeight, 1.0);
    debugPrint(
        'T4-4 idle: size=${tester.getSize(_body)}, stateScale=${_painter(tester).stateScale}');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  // spec 5.1（2026-10-29 裁决）：命中区永远不大于该状态的视觉轮廓，不存在独立热区。
  // 其余用例只断言 56 盒的尺寸，不会发现有人在球外包一层带 padding 的热区。
  testWidgets('spec 5.1：静止态轮廓之外 1dp 不可点，轮廓之内可点',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final Rect body = tester.getRect(_body);
    expect(body.size, const Size(56, 56));

    await tester.tapAt(Offset(body.left - 1, body.center.dy));
    await tester.pump();
    expect(controller.openRequests, 0,
        reason: '球沿外 1dp 不得命中：56 轮廓之外不允许有热区');

    await tester.tapAt(body.center);
    await tester.pump();
    expect(controller.openRequests, 1, reason: '轮廓之内必须可点');

    debugPrint('spec 5.1 hit area: rect=$body, outsideTap=0, insideTap=1');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('dragging：基础直径84、不叠加按压与呼吸缩放', (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture = await drag(tester);
    await tester.pump(const Duration(milliseconds: 300));
    final OrbPainter painter = _painter(tester);
    expect(tester.getSize(_body), const Size(84, 84));
    expect(painter.stateScale, 1.0);
    expect(painter.breathWeight, 0.0);
    // spec 6 / T4-5：有效累计位移 (-40,-40) 直接驱动方向拉伸与 glow。
    expect(
        painter.dragAngle, closeTo(orbDragAngle(const Offset(-40, -40)), 1e-6));
    expect(painter.pull, closeTo(orbPull(const Offset(-40, -40)), 1e-6));
    expect(painter.glowOffset.dx, closeTo(2.0, 1e-6));
    expect(painter.glowOffset.dy, closeTo(2.0, 1e-6));
    debugPrint(
        'T4-4 dragging: size=${tester.getSize(_body)}, stateScale=${painter.stateScale}, breathWeight=${painter.breathWeight}, dragAngle=${painter.dragAngle}, pull=${painter.pull}, glowOffset=${painter.glowOffset}');
    await gesture.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('hover：连续到1.04再回1、布局始终56', (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse = await hover(tester);
    final double entered = _painter(tester).stateScale;
    expect(entered, closeTo(1.04, 1e-6));
    expect(_painter(tester).breathWeight, 0.0);
    expect(tester.getSize(_body), const Size(56, 56));
    await mouse.moveTo(Offset.zero);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 110));
    expect(_painter(tester).stateScale, inExclusiveRange(1.0, 1.04));
    // 呼吸权重与 stateScale 共用 220ms 过渡（spec 7）：退出 hover 时 ±2% 呼吸
    // 必须渐入，不能 0→1 阶跃。没有过渡时这一帧会直接读到 1.0。
    expect(_painter(tester).breathWeight, inExclusiveRange(0.0, 1.0));
    expect(tester.getSize(_body), const Size(56, 56));
    await tester.pump(const Duration(milliseconds: 150));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6));
    expect(_painter(tester).breathWeight, 1.0);
    expect(tester.getSize(_body), const Size(56, 56));
    debugPrint(
        'T4-4 hover: entered=$entered, exited=${_painter(tester).stateScale}, size=${tester.getSize(_body)}');
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('pressed：140ms进入及退出、不移动不进入dragging', (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 70));
    final double midway = _painter(tester).stateScale;
    expect(midway, inExclusiveRange(0.94, 1.0));
    expect(tester.getSize(_body), const Size(56, 56));
    await tester.pump(const Duration(milliseconds: 90));
    final double pressed = _painter(tester).stateScale;
    expect(pressed, closeTo(0.94, 1e-6));
    expect(_painter(tester).breathWeight, 0.0);
    expect(tester.getSize(_body), const Size(56, 56));
    await gesture.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 70));
    final double exiting = _painter(tester).stateScale;
    expect(exiting, inExclusiveRange(0.94, 1.0));
    await tester.pump(const Duration(milliseconds: 90));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6));
    expect(tester.getSize(_body), const Size(56, 56));
    expect(controller.openRequests, 1, reason: '真实点击分流仍请求打开面板');
    debugPrint(
        'T4-4 pressed: @70ms=$midway, @160ms=$pressed, exit@70ms=$exiting, exit@160ms=${_painter(tester).stateScale}, size=${tester.getSize(_body)}, openRequests=${controller.openRequests}');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reduced-motion：hover和拖动恒56、scale1、breath0',
      (WidgetTester tester) async {
    await pumpHost(tester, reducedMotion: true);
    final TestGesture mouse = await hover(tester);
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).stateScale, 1.0);
    expect(_painter(tester).breath, 0.0);
    final TestGesture gesture = await drag(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).stateScale, 1.0);
    expect(_painter(tester).breath, 0.0);
    expect(_painter(tester).flow, 0.0);
    expect(tester.binding.transientCallbackCount, 0);
    debugPrint(
        'T4-4 reduced-motion: size=${tester.getSize(_body)}, stateScale=${_painter(tester).stateScale}, breath=${_painter(tester).breath}, tickers=${tester.binding.transientCallbackCount}');
    await gesture.cancel();
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('无投影：球体AnimatedContainer无decoration',
      (WidgetTester tester) async {
    await pumpHost(tester);
    expect(tester.widget<AnimatedContainer>(_body).decoration, isNull);
    debugPrint(
        'T4-4 shadow: decoration=${tester.widget<AnimatedContainer>(_body).decoration}');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('badge隔离：hover及pressed不改变徽标和球体布局', (WidgetTester tester) async {
    await pumpHost(tester);
    controller.setUnreadCount(3);
    await tester.pump();
    final Finder badge = find.descendant(
      of: find.byType(Badge),
      matching: find.byWidgetPredicate((Widget widget) =>
          widget is Container && widget.decoration is ShapeDecoration),
    );
    expect(find.text('3'), findsOneWidget);
    expect(
        find.descendant(of: _body, matching: find.byType(Badge)), findsNothing);
    final Rect initialBadge = tester.getRect(badge);
    final Rect initialBody = tester.getRect(_body);
    final TestGesture mouse = await hover(tester);
    final Rect hoverBadge = tester.getRect(badge);
    final Rect hoverBody = tester.getRect(_body);
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6));
    expect(hoverBadge, initialBadge);
    expect(hoverBody, initialBody);
    final TestGesture press =
        await tester.startGesture(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 160));
    final Rect pressedBadge = tester.getRect(badge);
    final Rect pressedBody = tester.getRect(_body);
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    expect(pressedBadge, initialBadge);
    expect(pressedBody, initialBody);
    debugPrint(
        'T4-4 badge: idle=$initialBadge, hover=$hoverBadge, pressed=$pressedBadge; badgeWidth=${initialBadge.width.toStringAsPrecision(15)}, badgeHeight=${initialBadge.height}; body idle=$initialBody, hover=$hoverBody, pressed=$pressedBody');
    await press.up();
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('尺寸过渡：220ms曲线、110ms中间值、190ms未完成、230ms为84',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final AnimatedContainer body = tester.widget<AnimatedContainer>(_body);
    expect(body.duration, const Duration(milliseconds: 220));
    expect(body.curve, kFeedbackOrbStateCurve);
    final TestGesture gesture = await drag(tester);
    expect(tester.getSize(_body), const Size(56, 56));
    await tester.pump(const Duration(milliseconds: 110));
    final Size midway = tester.getSize(_body);
    expect(midway.width, inExclusiveRange(56.0, 84.0));
    expect(midway.height, midway.width);
    expect(midway.width,
        closeTo(56 + 28 * kFeedbackOrbStateCurve.transform(0.5), 1e-6));
    await tester.pump(const Duration(milliseconds: 80));
    final Size at190 = tester.getSize(_body);
    expect(at190.width, inExclusiveRange(midway.width, 84.0),
        reason: '排除旧180ms时长');
    await tester.pump(const Duration(milliseconds: 40));
    expect(tester.getSize(_body), const Size(84, 84));
    debugPrint(
        'T4-4 size: @0ms=56, @110ms=${midway.width.toStringAsPrecision(15)}, @190ms=${at190.width.toStringAsPrecision(15)}, @230ms=${tester.getSize(_body).width}, duration=${body.duration.inMilliseconds}ms');
    await gesture.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
