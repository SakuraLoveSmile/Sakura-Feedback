// T7f：选区覆盖层期间的键盘可达性，以及面板关闭后的焦点回归。
//
// 覆盖：
// A. 覆盖层期间 Space 不再落到灵感球（不作废冻结选区、不重拍、不开面板）；
// B. 覆盖层期间 Esc 可取消（焦点已移入覆盖层）；
// C. 键盘开启 / Esc 关闭面板后，焦点回到入口并点亮焦点环；
// D. 鼠标关闭后焦点回到入口，但 touch 模式不点亮环；
// E. 小键盘 Enter 与 Enter 同语义，一次按键只打开一次；
// F. 热替换到已打开的新控制器时复位回弹状态，关闭后从静态起点恢复。
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _body = find.byKey(const Key('feedback-orb-body'));
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

class _RecordingController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
    super.open();
  }
}

void main() {
  late http.Client client;

  setUp(() {
    client = captureMockClient();
  });

  tearDown(() {
    client.close();
  });

  Widget host(
    FeedbackController controller, {
    FeedbackCaptureMode captureMode = FeedbackCaptureMode.off,
    Widget? hostChild,
  }) {
    return MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.orb-keys',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: captureMode,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: client,
        child: hostChild ??
            const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
      ),
    );
  }

  Future<void> pumpHost(
    WidgetTester tester,
    FeedbackController controller, {
    FeedbackCaptureMode captureMode = FeedbackCaptureMode.off,
    Widget? hostChild,
  }) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
        host(controller, captureMode: captureMode, hostChild: hostChild));
    await tester.pump();
  }

  /// Tab 聚焦入口（键盘模式），供 A/B 的拖动起点使用。
  Future<void> focusOrb(WidgetTester tester) async {
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(_ring, findsOneWidget);
  }

  /// 拖动入口 >8dp 并松手，等待冻结捕获挂上覆盖层。
  Future<void> dragIntoOverlay(WidgetTester tester) async {
    final TestGesture gesture = await tester.startGesture(tester.getCenter(_orb));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.up();
    await tester.pump();
    await pumpUntil(
        tester, () => _overlay.evaluate().isNotEmpty);
    await tester.pump();
    await tester.pump();
  }

  testWidgets('T7f-A 覆盖层期间 Space 不落到球上：不重拍、不开面板',
      (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller,
        captureMode: FeedbackCaptureMode.viewport);
    await focusOrb(tester);
    await dragIntoOverlay(tester);

    expect(FocusManager.instance.primaryFocus?.debugLabel,
        'feedback-capture-frame',
        reason: '焦点必须移入覆盖层，而不是停在球上');
    final CaptureSelectionOverlay overlayBefore =
        tester.widget<CaptureSelectionOverlay>(_overlay);
    final CaptureSelectionOverlayState stateBefore =
        tester.state<CaptureSelectionOverlayState>(_overlay);

    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    await tester.pump();

    expect(_overlay, findsOneWidget, reason: 'Space 不得作废冻结选区');
    final CaptureSelectionOverlay overlayAfter =
        tester.widget<CaptureSelectionOverlay>(_overlay);
    expect(identical(overlayAfter.image, overlayBefore.image), isTrue,
        reason: '不得重新捕获（同一冻结位图实例）');
    expect(identical(tester.state<CaptureSelectionOverlayState>(_overlay), stateBefore),
        isTrue,
        reason: '不得重建覆盖层');
    expect(controller.isOpen, isFalse, reason: '不得打开面板');
    expect(find.byType(FeedbackPanel), findsNothing);
    expect(Focus.of(tester.element(_orb)).canRequestFocus, isFalse,
        reason: '覆盖层期间入口退出焦点链（等效 ExcludeFocus）');
    debugPrint('T7f A: focus=feedback-capture-frame, overlay=true, '
        'sameImage=true, isOpen=${controller.isOpen}');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7f-B 覆盖层期间 Esc 取消，且守卫不拦截之后的正常点击',
      (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller,
        captureMode: FeedbackCaptureMode.viewport);
    await focusOrb(tester);
    await dragIntoOverlay(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();

    expect(_overlay, findsNothing, reason: '键盘取消可用');
    expect(controller.isOpen, isFalse);
    expect(find.byType(FeedbackPanel), findsNothing);
    expect(tester.takeException(), isNull);

    // 取消后入口仍可正常点击（守卫只作用于覆盖层 / 截图隐藏期间）。
    await tester.tap(_orb);
    await pumpUntil(tester, () => controller.isOpen);
    expect(controller.isOpen, isTrue);
    debugPrint('T7f B: esc closes overlay=true, next tap opens panel=true');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7f-C 键盘开面板、Esc 关闭：焦点回球且环可见',
      (WidgetTester tester) async {
    final _RecordingController controller = _RecordingController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await focusOrb(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    await tester.pump();
    expect(controller.openRequests, 1);
    expect(controller.isOpen, isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));

    expect(controller.isOpen, isFalse);
    final FocusNode node = Focus.of(tester.element(_orb));
    expect(node.hasPrimaryFocus, isTrue, reason: '焦点必须回到入口');
    expect(_ring, findsOneWidget, reason: '键盘关闭后焦点环应可见');
    debugPrint('T7f C: opens=${controller.openRequests}, primaryFocus=orb, '
        'ring=true');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7f-D 鼠标关闭：焦点回球但环不出现', (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);

    final TestGesture mouse =
        await tester.startGesture(tester.getCenter(_orb),
            kind: PointerDeviceKind.mouse);
    await tester.pump();
    await mouse.up();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    await mouse.removePointer();

    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));

    expect(controller.isOpen, isFalse);
    final FocusNode node = Focus.of(tester.element(_orb));
    expect(node.hasPrimaryFocus, isTrue, reason: '焦点仍回到入口');
    expect(_ring, findsNothing, reason: 'touch 模式不得点亮 focus-visible 锁存');
    debugPrint('T7f D: primaryFocus=orb, ring=false');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7f-E 小键盘 Enter 只打开一次', (WidgetTester tester) async {
    final _RecordingController controller = _RecordingController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await focusOrb(tester);

    // Web 默认把 Enter / numpadEnter 映射为 ButtonActivateIntent，
    // 本地映射是跨平台可用的前提，行为断言在本机 VM 上无法区分。
    final FocusableActionDetector detector = tester.widget<FocusableActionDetector>(
        find.ancestor(
            of: _orb, matching: find.byType(FocusableActionDetector)));
    expect(
      detector.shortcuts!.keys
          .whereType<SingleActivator>()
          .map((SingleActivator a) => a.trigger),
      containsAll(<LogicalKeyboardKey>[
        LogicalKeyboardKey.space,
        LogicalKeyboardKey.enter,
        LogicalKeyboardKey.numpadEnter,
      ]),
      reason: '局部快捷键必须自带 numpadEnter（Web 默认是 ButtonActivateIntent）',
    );

    await tester.sendKeyEvent(LogicalKeyboardKey.numpadEnter);
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(controller.openRequests, 1, reason: '一次 keyDown 只触发一次');
    expect(controller.isOpen, isTrue);
    debugPrint('T7f E: numpadEnter opens=${controller.openRequests}');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7f-F 热替换到已打开控制器：关闭后回到静态起点',
      (WidgetTester tester) async {
    final FeedbackController first = FeedbackController();
    final FeedbackController opened = FeedbackController()..open();
    addTearDown(first.dispose);
    addTearDown(opened.dispose);
    await pumpHost(tester, first);

    final TestGesture gesture = await tester.startGesture(tester.getCenter(_orb));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump();
    await gesture.moveBy(const Offset(-80, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 230));
    expect(tester.getSize(_body), const Size(84, 84));
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(_translation(tester).duration, kFeedbackOrbReleaseDuration,
        reason: '回弹进行中');

    // 换入已打开的新控制器：didUpdateWidget 侧必须抢占回弹。
    await tester.pumpWidget(host(opened));
    await tester.pump();
    expect(_orb, findsNothing, reason: '新控制器已打开 → hidden');
    expect(opened.isOpen, isTrue);

    opened.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));

    expect(tester.getSize(_body), const Size(56, 56));
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6));
    expect(_painter(tester).breathWeight, 1.0);
    expect(_translation(tester).duration, Duration.zero);
    debugPrint('T7f F: restored size=${tester.getSize(_body)}, '
        'stateScale=${_painter(tester).stateScale}, '
        'breathWeight=${_painter(tester).breathWeight}, '
        'translation=${_translation(tester).duration.inMilliseconds}ms');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  /// T7i：鼠标悬停 → 点击开面板 → 指针移开 → 控制器关闭（最近输入为指针）。
  Future<TestGesture> mouseOpenAndClose(
      WidgetTester tester, FeedbackController controller) async {
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_orb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    expect(_painter(tester).stateScale, closeTo(1.04, 1e-6),
        reason: '鼠标悬停为 1.04');
    await mouse.down(tester.getCenter(_orb));
    await tester.pump();
    await mouse.up();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue, reason: '点击打开面板');
    await mouse.moveTo(const Offset(20, 20));
    await tester.pump();
    return mouse;
  }

  testWidgets('T7i-A 鼠标开关面板：焦点回球但环不点亮，stateScale 回 1.0',
      (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    final TestGesture mouse = await mouseOpenAndClose(tester, controller);

    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));

    expect(controller.isOpen, isFalse);
    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isTrue,
        reason: '指针模态也回球（对齐 Web orb.focus()）');
    expect(_ring, findsNothing, reason: '指针模态不得点亮 focus-visible 环');
    expect(_painter(tester).stateScale, closeTo(1.0, 1e-6));
    debugPrint('T7i A: focus=orb, ring=false, '
        'stateScale=${_painter(tester).stateScale}');

    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('T7i-B 指针关闭的抑制只生效一次：Tab 来回聚焦重新点亮',
      (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(
      tester,
      controller,
      hostChild: Stack(
        children: <Widget>[
          const Positioned.fill(child: ColoredBox(color: Colors.blue)),
          Positioned(
            left: 8,
            top: 8,
            child: TextButton(onPressed: () {}, child: const Text('one')),
          ),
          Positioned(
            left: 120,
            top: 8,
            child: TextButton(onPressed: () {}, child: const Text('two')),
          ),
        ],
      ),
    );
    final TestGesture mouse = await mouseOpenAndClose(tester, controller);

    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    expect(_ring, findsNothing);
    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isTrue);

    // 任意按键即可恢复点亮（抑制已清理，球仍持有焦点）。
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.pump();
    expect(_ring, findsOneWidget, reason: '键盘输入补点亮 focus-visible');

    // Tab 离开球（one → two），第三次 Tab 回到球。
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isFalse,
        reason: '焦点已离开入口');
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));

    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isTrue);
    expect(_ring, findsOneWidget, reason: '键盘聚焦重新点亮，抑制已清理');
    debugPrint('T7i B: refocus=orb, ring=true');

    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });
}
