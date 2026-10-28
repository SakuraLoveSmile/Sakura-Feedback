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

OrbPainter _painter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
        find.descendant(of: _body, matching: find.byType(CustomPaint)))
    .map((CustomPaint paint) => paint.painter)
    .whereType<OrbPainter>()
    .single;

// 只记录点击分流，不真的展开面板：入口保持在树上，便于断言「环没有出现」。
class _VisualController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
  }
}

// 真实展开，并记录 open 调用次数（验证一次按键只触发一次）。
class _RecordingController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
    super.open();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FocusHighlightStrategy savedStrategy;

  setUp(() {
    savedStrategy = FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
  });

  tearDown(() {
    FocusManager.instance.highlightStrategy = savedStrategy;
  });

  Future<void> pumpHost(WidgetTester tester, FeedbackController controller,
      {Size surface = const Size(800, 600),
      Widget? hostChild,
      bool reducedMotion = false}) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final http.Client client = captureMockClient();
    addTearDown(client.close);
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (BuildContext context) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(disableAnimations: reducedMotion),
          child: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-focus',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.off,
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: client,
            child: hostChild ??
                const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
          ),
        ),
      ),
    ));
    await tester.pump();
  }

  Future<void> focusOrb(WidgetTester tester) async {
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
  }

  Future<TestGesture> dragBeyondThreshold(WidgetTester tester) async {
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(_orb));
    await gesture.moveBy(const Offset(-40, -40));
    await gesture.moveBy(const Offset(-40, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    return gesture;
  }

  testWidgets('T7a-1 键盘 Tab 聚焦出现焦点环：宽 2、色 primary、覆盖 R+2…R+4',
      (WidgetTester tester) async {
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    // 一个不可 Tab 到达、但可编程聚焦的宿主节点：用于把焦点移走。
    final FocusNode elsewhere = FocusNode(debugLabel: 'elsewhere');
    addTearDown(elsewhere.dispose);
    await pumpHost(tester, controller,
        hostChild: Stack(
          children: <Widget>[
            const Positioned.fill(child: ColoredBox(color: Colors.blue)),
            Positioned(
              left: 0,
              top: 0,
              child: Focus(
                skipTraversal: true,
                focusNode: elsewhere,
                child: const SizedBox(width: 1, height: 1),
              ),
            ),
          ],
        ));

    expect(_ring, findsNothing, reason: '未聚焦时不得有环');
    await focusOrb(tester);
    expect(_ring, findsOneWidget);

    final Rect body = tester.getRect(_body);
    final Rect ring = tester.getRect(_ring);
    expect(tester.getSize(_body), const Size(56, 56));
    expect(tester.getSize(_orb), const Size(56, 56), reason: '环不改变布局尺寸');
    expect(ring.center, body.center);
    expect(ring.width, 64.0, reason: '外径 56 + 2×(offset 2 + 环宽 2)');
    expect(ring.height, 64.0);
    expect(ring.left, body.left - 4);
    expect(ring.top, body.top - 4);

    final BoxDecoration decoration =
        tester.widget<DecoratedBox>(_ring).decoration as BoxDecoration;
    expect(decoration.shape, BoxShape.circle);
    final Border border = decoration.border! as Border;
    expect(border.top.style, BorderStyle.solid);
    expect(border.top.width, kFeedbackOrbFocusWidth);
    expect(border.top.width, 2.0);
    expect(border.top.color,
        Theme.of(tester.element(_ring)).colorScheme.primary);

    // 用户可见契约：取样点必须真的落在「可见环带」内、且在球体 56 命中盒
    // 之外；环本身不参与命中。否则「点了没反应」只是点在了空白处。
    final Offset bandPoint = body.center + const Offset(30, 0);
    expect(tester.getRect(_ring).contains(bandPoint), isTrue,
        reason: '取样点必须落在 ring Rect 内（外径 32 > 30 > 球半径 28）');
    expect(tester.getRect(_orb).contains(bandPoint), isFalse,
        reason: '取样点必须在球体 56 命中盒之外');
    // 最近祖先才是环自己的守卫；find.ancestor(...).first 取到的是外层
    // IgnorePointer（ignoring=false），断言会空转（T7h 变异自检发现）。
    final IgnorePointer? ringGuard = tester
        .element(_ring)
        .findAncestorWidgetOfExactType<IgnorePointer>();
    expect(ringGuard, isNotNull, reason: '环必须包在 IgnorePointer 内');
    expect(ringGuard!.ignoring, isTrue, reason: '环的 IgnorePointer 必须生效');
    final RenderObject ringRender = tester.renderObject<RenderObject>(_ring);
    final HitTestResult hit = tester.hitTestOnBinding(bandPoint);
    expect(hit.path.any((HitTestEntry entry) => entry.target == ringRender),
        isFalse, reason: '环的 render object 不得进入该点的命中路径');
    await tester.tapAt(bandPoint);
    await tester.pump();
    expect(controller.openRequests, 0, reason: '点击环带不得触发入口');
    expect(tester.getSize(_orb), const Size(56, 56),
        reason: '环不扩大入口命中盒 / 布局尺寸');
    debugPrint('T7h RING bandPoint=$bandPoint ring=${tester.getRect(_ring)} '
        'ringHit=false opens=${controller.openRequests}');

    // 失焦立即移除，不做过渡。
    elsewhere.requestFocus();
    await tester.pump();
    expect(FocusManager.instance.primaryFocus, elsewhere);
    await tester.pump();
    expect(_ring, findsNothing, reason: '焦点移走后立即移除焦点环');

    debugPrint('T7a FOCUS body=$body ring=$ring '
        'border=${border.top.width}/${border.top.color}');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-2 鼠标点击不出现焦点环，键盘聚焦才出现',
      (WidgetTester tester) async {
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);

    final TestGesture mouse =
        await tester.startGesture(tester.getCenter(_orb), kind: PointerDeviceKind.mouse);
    await tester.pump();
    await mouse.up();
    await tester.pump();
    expect(controller.openRequests, 1, reason: '点击分流仍走 _handleLauncherTap');
    expect(_orb, findsOneWidget, reason: '该控制器不展开面板，入口仍在树上');
    expect(_ring, findsNothing, reason: '鼠标点击不得点亮焦点环');

    await mouse.removePointer();
    await focusOrb(tester);
    expect(_ring, findsOneWidget, reason: '同一用例键盘聚焦必须点亮');

    debugPrint('T7a MOUSE opens=${controller.openRequests} '
        'ringAfterClick=false ringAfterTab=true');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-3 键盘聚焦后按下 140ms：stateScale 0.94，焦点环保留',
      (WidgetTester tester) async {
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    await focusOrb(tester);
    expect(_ring, findsOneWidget);

    final TestGesture press =
        await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 140));
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    expect(_ring, findsOneWidget, reason: 'pressed 不得移除焦点环（spec 5）');
    expect(tester.getSize(_body), const Size(56, 56));

    debugPrint('T7a PRESS stateScale=${_painter(tester).stateScale} ring=true');
    await press.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-4 键盘聚焦后拖动 >8px：球 84、环随外扩、badge 不变形',
      (WidgetTester tester) async {
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);
    controller.setUnreadCount(1);
    await tester.pump();
    final Finder badge = find.text('1');
    expect(badge, findsOneWidget);

    // 对照组：无焦点拖动，记录 badge 几何。
    TestGesture gesture = await dragBeyondThreshold(tester);
    expect(_ring, findsNothing, reason: '未聚焦拖动不得出现环');
    expect(tester.getSize(_body), const Size(84, 84));
    final Rect idleBadge = tester.getRect(badge);
    final Rect idleBody = tester.getRect(_body);
    await gesture.cancel();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();

    // 键盘聚焦后同样拖动。
    await focusOrb(tester);
    expect(_ring, findsOneWidget);
    gesture = await dragBeyondThreshold(tester);
    expect(tester.getSize(_body), const Size(84, 84));
    expect(_ring, findsOneWidget, reason: 'dragging 不得移除焦点环');
    final Rect ring = tester.getRect(_ring);
    expect(ring.width, 92.0, reason: '环随 84 球体外扩 8');
    expect(ring.height, 92.0);
    expect(ring.center, tester.getRect(_body).center);
    expect(tester.getRect(badge), idleBadge, reason: 'badge 不随焦点环改变');
    expect(tester.getRect(_body), idleBody, reason: '球体几何不受环影响');

    debugPrint('T7a DRAG body=84 ring=$ring badge=${tester.getRect(badge)}');
    await gesture.cancel();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-5 hidden：打开面板后环与球一起移除，关闭后球回来焦点回归',
      (WidgetTester tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);

    await focusOrb(tester);
    expect(_orb, findsOneWidget);
    expect(_ring, findsOneWidget);

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(_orb, findsNothing, reason: '面板打开时入口整体 hidden');
    expect(_ring, findsNothing);

    // T7f：关闭后焦点回到入口（本体用例的旧契约「无环」已被焦点回归取代）。
    controller.close();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    expect(_orb, findsOneWidget);
    expect(Focus.of(tester.element(_orb)).hasPrimaryFocus, isTrue,
        reason: '关闭后焦点回到入口');
    expect(_ring, findsOneWidget, reason: '键盘关闭 → 焦点环随焦点可见');

    debugPrint('T7a HIDDEN open: orb=false ring=false; close: orb=true '
        'focus=orb ring=true');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-6 Space 与 Enter 各触发一次打开，不进入选区流程',
      (WidgetTester tester) async {
    final _RecordingController controller = _RecordingController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller);

    await focusOrb(tester);
    expect(_ring, findsOneWidget);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.space);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.space);
    await tester.pump();
    expect(controller.openRequests, 1, reason: '一次 keyDown 只触发一次');
    expect(controller.isOpen, isTrue);
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(_ring, findsNothing, reason: '面板打开后入口 hidden');

    controller.close();
    await tester.pump();
    await tester.pump();
    FocusManager.instance.primaryFocus
        ?.unfocus(disposition: UnfocusDisposition.scope);
    await tester.pump();

    await focusOrb(tester);
    expect(_ring, findsOneWidget);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(controller.openRequests, 2, reason: 'Enter 与 Space 走同一 ActivateIntent');
    expect(controller.isOpen, isTrue);
    expect(find.byType(CaptureSelectionOverlay), findsNothing);

    debugPrint('T7a KEY opens=${controller.openRequests} '
        'space=true enter=true overlay=false');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('T7a-7 reduced-motion 下焦点环照常显示（spec 8.5.5）',
      (WidgetTester tester) async {
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    await pumpHost(tester, controller, reducedMotion: true);

    expect(_ring, findsNothing);
    await focusOrb(tester);
    expect(_ring, findsOneWidget, reason: 'reduced-motion 保留焦点环');
    expect(tester.getSize(_body), const Size(56, 56));
    expect(tester.getRect(_ring).width, 64.0);

    debugPrint('T7a REDUCED ring=true size=${tester.getSize(_body)} '
        'ringWidth=${tester.getRect(_ring).width}');
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
