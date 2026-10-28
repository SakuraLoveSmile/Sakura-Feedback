import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

// T7：docs/orb-spec.md 第 5 节状态优先级 hidden > dragging > releasing >
// pressed > hover > focus-visible > idle 的六条缺口（T4 记录 §7.2）。
// 只做观测，不改生产实现；开 debugForceOrbAnimation 的用例禁止
// pumpAndSettle（10s 常驻 Ticker）。

final Finder _body = find.byKey(const Key('feedback-orb-body'));
final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _ring = find.byKey(const Key('feedback-orb-focus-ring'));
final Finder _overlay =
    find.byKey(const Key('feedback-capture-selection-overlay'));

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

// 只隔离点击后的业务 hidden：open() 只计数，球保持可见，保留真实
// Listener、手势分流与缩放过渡。
class _VisualController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
  }
}

void main() {
  late FeedbackController controller;
  late http.Client client;

  setUp(() {
    controller = _VisualController();
    client = captureMockClient();
  });

  tearDown(() {
    controller.dispose();
    client.close();
  });

  _VisualController visual() => controller as _VisualController;

  Future<void> pumpHost(WidgetTester tester,
      {bool showLauncher = true,
      FeedbackLauncherMode launcherMode = FeedbackLauncherMode.orb,
      FeedbackCaptureMode captureMode = FeedbackCaptureMode.off}) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: Builder(builder: (BuildContext context) {
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: false),
          child: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-priority',
              launcherMode: launcherMode,
              captureMode: captureMode,
              showLauncher: showLauncher,
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

  Future<TestGesture> hoverOrb(WidgetTester tester) async {
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    return mouse;
  }

  // 位移协议与既有 orb_drag_test 相同：第一次 moveBy 只用于跨越 pan slop
  // （onPanStart），第二次起才累计业务位移。
  Future<TestGesture> startPanTo(WidgetTester tester, Offset vector) async {
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(_orb));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump();
    await gesture.moveBy(vector);
    await tester.pump();
    return gesture;
  }

  testWidgets('优先级1：hover 被 pressed 抢占为 0.94，松开回 1.04',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse = await hoverOrb(tester);
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6));
    final Offset center = tester.getCenter(_body);
    await mouse.down(center);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 70));
    final double pressing = _painter(tester).stateScale;
    expect(pressing, inExclusiveRange(0.94, 1.04));
    expect(pressing, isNot(closeTo(1.04, 1e-6)));
    await tester.pump(const Duration(milliseconds: 90));
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    expect(tester.getSize(_body), const Size(56, 56));
    await mouse.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 70));
    final double exiting = _painter(tester).stateScale;
    expect(exiting, inExclusiveRange(0.94, 1.04));
    await tester.pump(const Duration(milliseconds: 90));
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6),
        reason: '鼠标仍在球上，pressed 退出目标应为 hover 1.04');
    expect(visual().openRequests, 1);
    await mouse.moveTo(Offset.zero);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 220));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6));
    debugPrint('T7-C1 hover>press: @70ms=$pressing, pressed=0.94, '
        'exit@70ms=$exiting, exit@160ms=1.04, leave@220ms=1.0, '
        'openRequests=${visual().openRequests}');
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级2：hover 中拖动过阈值 → 84/stateScale1.0/breathWeight0',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture mouse = await hoverOrb(tester);
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6));
    await mouse.down(tester.getCenter(_body));
    await tester.pump();
    await mouse.moveBy(const Offset(-40, -40));
    await tester.pump();
    await mouse.moveBy(const Offset(-40, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    const Offset vector = Offset(-40, -40);
    final OrbPainter painter = _painter(tester);
    expect(tester.getSize(_body), const Size(84, 84));
    expect(painter.stateScale, closeTo(1.0, 1e-6));
    expect(painter.breathWeight, 0.0);
    expect(painter.pull, closeTo(orbPull(vector), 1e-6));
    expect(painter.dragAngle, closeTo(orbDragAngle(vector), 1e-6));
    _expectOffset(painter.glowOffset,
        orbGlowOffset(orbPull(vector), orbDragAngle(vector)));
    debugPrint('T7-C2 hover>drag: size=${tester.getSize(_body)}, '
        'stateScale=${painter.stateScale}, breathWeight=${painter.breathWeight}, '
        'pull=${painter.pull}, angle=${painter.dragAngle}, '
        'glow=(${painter.glowOffset.dx},${painter.glowOffset.dy})');
    await mouse.cancel();
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级3：pressed 未过阈值松手不进入 releasing（无 460ms 回弹）',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 140));
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    await gesture.up();
    await tester.pump();
    final List<int> durations = <int>[];
    for (int index = 0; index < 4; index++) {
      durations.add(_translation(tester).duration.inMilliseconds);
      expect(_translation(tester).duration, Duration.zero,
          reason: '未过阈值的松手不得出现 460ms 回弹（@${index * 40}ms）');
      expect(tester.getSize(_body), const Size(56, 56));
      await tester.pump(const Duration(milliseconds: 40));
    }
    expect(_translation(tester).duration, Duration.zero,
        reason: '退出过程中不得出现 460ms 回弹（@160ms）');
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6),
        reason: 'press 退出 140ms，@160ms 应回到 idle 1.0');
    expect(visual().openRequests, 1);
    debugPrint('T7-C3 pressed-no-drag: translationDurations=$durations, '
        'size=56, exit@160ms=${_painter(tester).stateScale}, '
        'openRequests=${visual().openRequests}');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级4：releasing 中按下取消回弹，stateScale 归 0.94',
      (WidgetTester tester) async {
    await pumpHost(tester);
    final TestGesture first = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await first.cancel();
    await tester.pump();
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    await tester.pump(const Duration(milliseconds: 100));
    final TestGesture second =
        await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    expect(_translation(tester).duration, Duration.zero,
        reason: '按下当帧必须终止 460ms 回弹');
    _expectOffset(_offset(tester), Offset.zero);
    expect(_painter(tester).pull, 0.0);
    await tester.pump(const Duration(milliseconds: 160));
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    expect(_painter(tester).breathWeight, 0.0);
    debugPrint('T7-C4 release>press: translation=0, offset=0, pull=0, '
        'stateScale=${_painter(tester).stateScale}, '
        'breathWeight=${_painter(tester).breathWeight}');
    await second.cancel();
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级5：releasing 中 open() 由 hidden 抢占，关闭后回到静态起点',
      (WidgetTester tester) async {
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    controller.dispose();
    controller = FeedbackController();
    await pumpHost(tester);
    final TestGesture gesture = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final double flowBeforeOpen = _painter(tester).flow;
    final int tickersBeforeOpen = tester.binding.transientCallbackCount;
    expect(tickersBeforeOpen, greaterThan(0),
        reason: '回弹中应有隐式动画 ticker，ticker 归零断言才有意义');
    controller.open();
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    // 面板首次构建会挂载加载 spinner，spinner 与内容切换自带重复 Ticker
    // （与球体无关）。先等这些面板动画自然结束，再断言 hidden 期间无残留：
    // 球体扫光是 10s 常驻 Ticker，若 hidden 未停止，2s 内不可能归零，
    // 更不可能在随后 1s 内保持为 0。
    int settleMs = 0;
    for (; settleMs < 2000; settleMs += 50) {
      if (tester.binding.transientCallbackCount == 0) break;
      await tester.pump(const Duration(milliseconds: 50));
    }
    final int tickersHidden = tester.binding.transientCallbackCount;
    expect(tickersHidden, 0,
        reason: 'hidden 期间球体的 10s 常驻 Ticker 必须停止（面板动画应已结束）');
    await tester.pump(const Duration(seconds: 1));
    expect(tester.binding.transientCallbackCount, 0);
    controller.close();
    await tester.pump();
    await tester.pump();
    expect(_orb, findsOneWidget);
    final Size size = tester.getSize(_body);
    final OrbPainter painter = _painter(tester);
    final Offset offset = _offset(tester);
    debugPrint('T7-C5 hidden-preempt: flowBeforeOpen=$flowBeforeOpen, '
        'tickersBeforeOpen=$tickersBeforeOpen, panelSettleMs=$settleMs, '
        'tickersHidden=$tickersHidden, '
        'restored size=$size, stateScale=${painter.stateScale}, '
        'breathWeight=${painter.breathWeight}, dragAngle=${painter.dragAngle}, '
        'pull=${painter.pull}, offset=(${offset.dx},${offset.dy}), '
        'flow=${painter.flow}, translationDuration='
        '${_translation(tester).duration.inMilliseconds}ms');
    expect(size, const Size(56, 56));
    expect(painter.stateScale, closeTo(1.0, 1e-6));
    expect(painter.breathWeight, 1.0);
    expect(painter.dragAngle, closeTo(0.0, 1e-6));
    expect(painter.pull, 0.0);
    _expectOffset(offset, Offset.zero);
    expect(painter.flow, 0.0);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级6：hidden 当期 Ticker 归零，恢复后从零重新计时',
      (WidgetTester tester) async {
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    await pumpHost(tester);
    await tester.pump(const Duration(seconds: 5));
    expect(_painter(tester).flow, inInclusiveRange(0.49, 0.51));
    expect(tester.binding.transientCallbackCount, greaterThan(0),
        reason: '可见时扫光 Ticker 应在运行');
    await pumpHost(tester, showLauncher: false);
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    await tester.pump();
    final int tickersHiddenNow = tester.binding.transientCallbackCount;
    expect(tickersHiddenNow, 0, reason: 'hidden 当期必须停止 Ticker');
    await tester.pump(const Duration(seconds: 1));
    expect(tester.binding.transientCallbackCount, 0);
    await pumpHost(tester, showLauncher: true);
    await tester.pump();
    await tester.pump();
    expect(_painter(tester).flow, 0.0);
    await tester.pump(const Duration(milliseconds: 100));
    final double after = _painter(tester).flow;
    expect(after, greaterThan(0.0));
    expect(after, lessThanOrEqualTo(0.03));
    debugPrint('T7-C6 hidden ticker: tickersHidden=$tickersHiddenNow, '
        'hidden+1s=0, restored flow=0, +100ms=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  // spec 5：focus-visible 是附加状态——只要焦点仍符合，pressed / dragging
  // 都不得移除焦点环；hidden 除外。T7a 已单测各态，这里只测「组合优先级」。
  testWidgets('优先级7：焦点环保留在 pressed 与 dragging 之上',
      (WidgetTester tester) async {
    final FocusHighlightStrategy saved =
        FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
    addTearDown(() => FocusManager.instance.highlightStrategy = saved);
    await pumpHost(tester);

    expect(_ring, findsNothing, reason: '未聚焦不得有环');
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(_ring, findsOneWidget);
    final Rect idleRing = tester.getRect(_ring);
    expect(idleRing.width, 64.0, reason: '56 + 2×(offset 2 + 环宽 2)');
    expect(tester.getSize(_body), const Size(56, 56));

    // 同一入口上按下不移动：pressed 抢占 hover/idle，但不得抢走焦点环。
    final TestGesture mouse = await tester.startGesture(
        tester.getCenter(_orb),
        kind: PointerDeviceKind.mouse);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 140));
    final double pressedScale = _painter(tester).stateScale;
    expect(pressedScale, closeTo(0.94, 1e-6));
    expect(tester.getSize(_body), const Size(56, 56));
    expect(_ring, findsOneWidget, reason: 'pressed 不得移除焦点环（spec 5）');
    expect(tester.getRect(_ring), idleRing);

    // 继续累计位移越过阈值：dragging（84）同样保留环，且环随球体外扩。
    await mouse.moveBy(const Offset(-40, -40));
    await tester.pump();
    await mouse.moveBy(const Offset(-40, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final Size dragSize = tester.getSize(_body);
    final Rect dragRing = tester.getRect(_ring);
    expect(dragSize, const Size(84, 84));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6),
        reason: 'dragging 目标 scale 为 1.0');
    expect(_ring, findsOneWidget, reason: 'dragging 不得移除焦点环（spec 5）');
    expect(dragRing.width, 92.0, reason: '84 + 2×(offset 2 + 环宽 2)');
    expect(dragRing.height, 92.0);
    expect(dragRing.center, tester.getRect(_body).center,
        reason: '环不得偏离球心');
    debugPrint('T7-C7 focus+press+drag: idleRing=${idleRing.size}, '
        'pressedScale=$pressedScale, dragSize=$dragSize, '
        'dragRing=${dragRing.size}, centerMatch='
        '${dragRing.center == tester.getRect(_body).center}');
    await mouse.cancel();
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级8：hidden 同时抢占焦点环与回弹，恢复后无环且静态',
      (WidgetTester tester) async {
    final FocusHighlightStrategy saved =
        FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
    addTearDown(() => FocusManager.instance.highlightStrategy = saved);
    // 开扫光控制器，hidden 的 Ticker 归零与恢复后 flow=0 才不是同义反复。
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    controller.dispose();
    controller = FeedbackController();
    await pumpHost(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(_ring, findsOneWidget);
    final TestGesture gesture = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    expect(_ring, findsOneWidget, reason: 'dragging + focus-visible');
    await gesture.cancel();
    await tester.pump();
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    expect(_ring, findsOneWidget, reason: 'releasing + focus-visible');
    await tester.pump(const Duration(milliseconds: 100));
    final int tickersBeforeOpen = tester.binding.transientCallbackCount;
    expect(tickersBeforeOpen, greaterThan(0),
        reason: '回弹与扫光应各有 Ticker，归零断言才有意义');

    controller.open();
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    expect(_ring, findsNothing, reason: 'hidden 时环与球一起移除（spec 5）');
    // 面板首次构建的加载 spinner / 内容切换自带面板侧 Ticker；等它们
    // 自然结束再断言，球体扫光是 10s 常驻 Ticker，若未停止不可能归零。
    int settleMs = 0;
    for (; settleMs < 2000; settleMs += 50) {
      if (tester.binding.transientCallbackCount == 0) break;
      await tester.pump(const Duration(milliseconds: 50));
    }
    final int tickersHidden = tester.binding.transientCallbackCount;
    final bool spinnerStillThere =
        find.byType(CircularProgressIndicator).evaluate().isNotEmpty;
    expect(tickersHidden, 0,
        reason: spinnerStillThere
            ? '面板动画：加载 spinner 在 2s 内未结束'
            : '球体 Ticker：面板加载态已结束，hidden 期间仍残留 Ticker');
    // 面板动画结束后的两个 1s 采样：此时若有 Ticker，只能是球体侧残留
    // （10s 扫光在跑则两次采样必然 >0）。
    for (final int second in <int>[1, 2]) {
      await tester.pump(const Duration(seconds: 1));
      expect(tester.binding.transientCallbackCount, 0,
          reason: '球体 Ticker：hidden 第 $second 秒仍不得有 Ticker');
      expect(find.byKey(const Key('feedback-orb'), skipOffstage: false),
          findsNothing,
          reason: '球体 Ticker：hidden 期间入口必须整体卸载，不得只隐藏后继续运行');
    }

    controller.close();
    await tester.pump();
    await tester.pump();
    expect(_orb, findsOneWidget);
    // T7f/T7i：指针关闭同样把焦点还给入口，但环由「最近输入为指针」抑制。
    // 必须同时断言「焦点已回球」与「环不亮」，否则「无环」可能只是焦点
    // 还没回来造成的时序巧合。
    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isTrue,
        reason: '指针关闭后焦点回到入口（T7f）');
    expect(_ring, findsNothing, reason: '指针模态关闭不得点亮焦点环（T7i）');
    final Size size = tester.getSize(_body);
    final OrbPainter painter = _painter(tester);
    final Offset offset = _offset(tester);
    debugPrint('T7-C8 hidden focus+release: tickersBeforeOpen='
        '$tickersBeforeOpen, panelSettleMs=$settleMs, '
        'tickersHidden=$tickersHidden, restored size=$size, '
        'stateScale=${painter.stateScale}, '
        'breathWeight=${painter.breathWeight}, '
        'dragAngle=${painter.dragAngle}, pull=${painter.pull}, '
        'offset=(${offset.dx},${offset.dy}), flow=${painter.flow}, '
        'translationDuration=${_translation(tester).duration.inMilliseconds}ms');
    expect(size, const Size(56, 56));
    expect(painter.stateScale, closeTo(1.0, 1e-6));
    expect(painter.breathWeight, 1.0);
    expect(painter.dragAngle, closeTo(0.0, 1e-6));
    expect(painter.pull, 0.0);
    _expectOffset(offset, Offset.zero);
    expect(painter.flow, 0.0,
        reason: '球体 Ticker：恢复后 flow 必须为 0（hidden 期间不得累计扫光相位）');

    // T7i：焦点已在球上（被抑制），下一次键盘输入补点亮环。
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(_ring, findsOneWidget, reason: '下一次键盘输入必须补点亮焦点环');
    debugPrint('T7-C8 refocus: ring=true');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级9：config hidden（showLauncher:false）抢占回弹，恢复后静态起点',
      (WidgetTester tester) async {
    // 开扫光控制器：恢复后的 flow=0 才不是同义反复。
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    await pumpHost(tester);
    // 标定：可见期扫光确实在跑，否则「恢复后 flow=0」是同义反复。
    await tester.pump(const Duration(milliseconds: 500));
    final double visibleFlow = _painter(tester).flow;
    expect(visibleFlow, greaterThan(0.0), reason: '前提：可见期扫光在运行');
    expect(tester.binding.transientCallbackCount, greaterThan(0),
        reason: '前提：可见期有扫光 Ticker');
    final TestGesture gesture = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.cancel();
    await tester.pump();
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    await tester.pump(const Duration(milliseconds: 100));
    final double midReleasePull = _painter(tester).pull;
    expect(midReleasePull, inExclusiveRange(0.0, 1.0),
        reason: '前提：回弹进行中');

    await pumpHost(tester, showLauncher: false);
    expect(_orb, findsNothing, reason: '入口关闭即 hidden（didUpdateWidget 抢占）');
    await tester.pump(const Duration(seconds: 1));

    await pumpHost(tester, showLauncher: true);
    await tester.pump();
    await tester.pump();
    final Size size = tester.getSize(_body);
    final OrbPainter painter = _painter(tester);
    final Offset offset = _offset(tester);
    debugPrint('T7-C9 config showLauncher: visibleFlow=$visibleFlow, '
        'midPull=$midReleasePull, '
        'restored size=$size, stateScale=${painter.stateScale}, '
        'breathWeight=${painter.breathWeight}, '
        'dragAngle=${painter.dragAngle}, pull=${painter.pull}, '
        'offset=(${offset.dx},${offset.dy}), flow=${painter.flow}, '
        'translationDuration=${_translation(tester).duration.inMilliseconds}ms');
    expect(size, const Size(56, 56));
    expect(painter.stateScale, closeTo(1.0, 1e-6));
    expect(painter.breathWeight, 1.0);
    expect(painter.dragAngle, closeTo(0.0, 1e-6));
    expect(painter.pull, 0.0);
    _expectOffset(offset, Offset.zero);
    expect(_translation(tester).duration, Duration.zero,
        reason: '恢复后不得残留 460ms 回弹配置');
    expect(painter.flow, 0.0, reason: '恢复后扫光从 0 起算');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级10：launcherMode orb→tab 抢占回弹，切回后静态起点',
      (WidgetTester tester) async {
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    await pumpHost(tester);
    // 标定：可见期扫光确实在跑，否则「恢复后 flow=0」是同义反复。
    await tester.pump(const Duration(milliseconds: 500));
    final double visibleFlow = _painter(tester).flow;
    expect(visibleFlow, greaterThan(0.0), reason: '前提：可见期扫光在运行');
    expect(tester.binding.transientCallbackCount, greaterThan(0),
        reason: '前提：可见期有扫光 Ticker');
    final TestGesture gesture = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.cancel();
    await tester.pump();
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration);
    await tester.pump(const Duration(milliseconds: 100));
    final double midReleasePull = _painter(tester).pull;
    expect(midReleasePull, inExclusiveRange(0.0, 1.0),
        reason: '前提：回弹进行中');

    await pumpHost(tester, launcherMode: FeedbackLauncherMode.tab);
    expect(_orb, findsNothing, reason: '离开 orb 模式即 hidden');
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));

    await pumpHost(tester);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-fab')), findsNothing);
    final Size size = tester.getSize(_body);
    final OrbPainter painter = _painter(tester);
    final Offset offset = _offset(tester);
    debugPrint('T7-C10 launcherMode orb→tab: visibleFlow=$visibleFlow, '
        'midPull=$midReleasePull, '
        'restored size=$size, stateScale=${painter.stateScale}, '
        'breathWeight=${painter.breathWeight}, '
        'dragAngle=${painter.dragAngle}, pull=${painter.pull}, '
        'offset=(${offset.dx},${offset.dy}), flow=${painter.flow}, '
        'translationDuration=${_translation(tester).duration.inMilliseconds}ms');
    expect(size, const Size(56, 56));
    expect(painter.stateScale, closeTo(1.0, 1e-6));
    expect(painter.breathWeight, 1.0);
    expect(painter.dragAngle, closeTo(0.0, 1e-6));
    expect(painter.pull, 0.0);
    _expectOffset(offset, Offset.zero);
    expect(_translation(tester).duration, Duration.zero,
        reason: '恢复后不得残留 460ms 回弹配置');
    expect(painter.flow, 0.0, reason: '恢复后扫光从 0 起算');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('优先级11：hidden（选区遮挡）球体扫光两次 1s 采样恒 0',
      (WidgetTester tester) async {
    // 遮挡型 hidden 下球体仍挂载，可以直接观测 painter 自身；面板型 hidden
    // 会卸载球体，只能用全局 Ticker 计数（见「优先级8」）。
    debugForceOrbAnimation = true;
    addTearDown(() => debugForceOrbAnimation = false);
    await pumpHost(tester, captureMode: FeedbackCaptureMode.viewport);
    // 标定：遮挡前扫光确实在跑（否则两次 1s 的 flow=0 是同义反复）。
    await tester.pump(const Duration(milliseconds: 500));
    final double visibleFlow = _painter(tester).flow;
    expect(visibleFlow, greaterThan(0.0), reason: '前提：可见期扫光在运行');
    final TestGesture gesture = await startPanTo(tester, const Offset(-80, 0));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.up();
    await tester.pump();
    await pumpUntil(tester, () => _overlay.evaluate().isNotEmpty);
    await tester.pump();
    await tester.pump();
    expect(_overlay, findsOneWidget);
    expect(_orb, findsOneWidget, reason: '遮挡期间球体仍挂载，painter 可观测');

    for (final int second in <int>[1, 2]) {
      await tester.pump(const Duration(seconds: 1));
      final OrbPainter painter = _painter(tester);
      expect(painter.flow, 0.0,
          reason: '球体 Ticker：遮挡 hidden 第 $second 秒 flow 必须恒 0');
      expect(painter.breath, 0.0,
          reason: '球体 Ticker：遮挡 hidden 第 $second 秒 breath 必须恒 0');
      expect(tester.binding.transientCallbackCount, 0,
          reason: '球体 Ticker：遮挡 hidden 第 $second 秒不得有 Ticker');
    }

    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    await tester.pump();
    expect(_overlay, findsNothing);
    expect(_painter(tester).flow, 0.0, reason: '取消遮挡后从 0 起算');
    await tester.pump(const Duration(milliseconds: 100));
    final double after = _painter(tester).flow;
    expect(after, greaterThan(0.0));
    expect(after, lessThanOrEqualTo(0.03));
    debugPrint('T7-C11 occluded ticker: visibleFlow=$visibleFlow, '
        'flow@1s=0, flow@2s=0, cancel+100ms=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
