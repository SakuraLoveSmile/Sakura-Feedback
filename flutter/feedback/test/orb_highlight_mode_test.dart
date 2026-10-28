// T7h：真实 FocusHighlightStrategy.automatic 下的焦点环优先级。
//
// 口径（依赖 Flutter 3.47.7 的 FocusManager._HighlightModeManager）：
// - 初始无输入 → highlightMode == touch；
// - 任意键盘事件 → traditional（环形可见的前提）；
// - 只有 touch / stylus / invertedStylus 指针按下会翻回 touch；
//   鼠标（mouse/trackpad）按下 **不会** 翻转模式。
// 因此「鼠标按下环保留」在本机 VM 里不能证明锁存；锁存必须用 touch 按下
// （mode 翻为 touch，Focus 会派发 onShowFocusHighlight(false)）来验证。
import 'package:feedback_widget/feedback_widget.dart';
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

// open() 只计数，不真的展开面板：入口保持可见，便于持续观察环。
class _VisualController extends FeedbackController {
  int openRequests = 0;

  @override
  void open() {
    openRequests++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FocusHighlightStrategy savedStrategy;

  setUp(() {
    savedStrategy = FocusManager.instance.highlightStrategy;
    // 显式使用产品默认值：本文件不强制 alwaysTraditional。
    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.automatic;
  });

  tearDown(() {
    FocusManager.instance.highlightStrategy = savedStrategy;
  });

  Future<void> pumpHost(WidgetTester tester, FeedbackController controller,
      FocusNode elsewhere) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final http.Client client = captureMockClient();
    addTearDown(client.close);
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.orb-highlight-mode',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: FeedbackCaptureMode.off,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: client,
        child: Stack(
          children: <Widget>[
            const Positioned.fill(child: ColoredBox(color: Colors.blue)),
            // 不可 Tab 到达、但可编程聚焦：用于把焦点移走。
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
        ),
      ),
    ));
    await tester.pump();
  }

  testWidgets('T7h-HM automatic：Tab 点亮、touch 翻转模式后环仍锁存、失焦移除',
      (WidgetTester tester) async {
    expect(FocusManager.instance.highlightStrategy,
        FocusHighlightStrategy.automatic);
    final _VisualController controller = _VisualController();
    addTearDown(controller.dispose);
    final FocusNode elsewhere = FocusNode(debugLabel: 'elsewhere');
    addTearDown(elsewhere.dispose);

    // 初始无键盘输入：automatic 处于 touch 模式，无环。
    expect(FocusManager.instance.highlightMode, FocusHighlightMode.touch);
    await pumpHost(tester, controller, elsewhere);
    expect(_ring, findsNothing);

    // 真实键盘模态：Tab 先翻模式，再移动焦点。
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(FocusManager.instance.highlightMode,
        FocusHighlightMode.traditional,
        reason: '键盘事件必须把 automatic 模式翻到 traditional');
    expect(_ring, findsOneWidget, reason: 'traditional 聚焦必须点亮环');
    expect(tester.getSize(_orb), const Size(56, 56));

    // 鼠标按下：Flutter 只把 touch/stylus 视为 touch 模态，mouse 不翻模式，
    // 环保留属于预期（点击不请求焦点、不清锁存）。
    final TestGesture mouse = await tester.startGesture(
        tester.getCenter(_orb),
        kind: PointerDeviceKind.mouse);
    await tester.pump();
    expect(FocusManager.instance.highlightMode,
        FocusHighlightMode.traditional,
        reason: 'mouse down 不改变 highlightMode（见文件头口径）');
    expect(_ring, findsOneWidget, reason: '鼠标按下不得移除焦点环');
    await mouse.up();
    await tester.pump();
    expect(controller.openRequests, 1, reason: '点击分流照常');
    expect(_ring, findsOneWidget, reason: '鼠标点击后环仍锁存');
    expect(tester.getSize(_orb), const Size(56, 56),
        reason: '环不进入布局');
    await mouse.removePointer();
    await tester.pump();

    // 真正的模式翻转：touch 按下 → highlightMode=touch，Focus 会派发
    // onShowFocusHighlight(false)；锁存语义要求环仍然保留。
    final TestGesture touch = await tester.startGesture(tester.getCenter(_orb));
    await tester.pump();
    expect(FocusManager.instance.highlightMode, FocusHighlightMode.touch,
        reason: 'touch 按下必须翻回 touch 模式');
    expect(_ring, findsOneWidget,
        reason: 'mode 翻为 touch 的当帧，锁存不得被清除（spec 5）');
    await tester.pump(const Duration(milliseconds: 140));
    expect(_painter(tester).stateScale, closeTo(0.94, 1e-6));
    expect(_ring, findsOneWidget,
        reason: 'pressed 且 mode=touch 时焦点环仍须锁存（spec 5）');
    await touch.cancel();
    await tester.pump();
    expect(_ring, findsOneWidget, reason: '取消按压不清除焦点环锁存');

    // 失焦立即移除，不做过渡。
    elsewhere.requestFocus();
    await tester.pump();
    await tester.pump();
    expect(FocusManager.instance.primaryFocus, elsewhere);
    expect(_ring, findsNothing, reason: '焦点移走后立即移除焦点环');

    debugPrint('T7h HM: strategy=automatic, afterTab=touch→traditional, '
        'afterMouse=traditional/ring=true, afterTouch=touch/ring=true, '
        'afterBlur=ring=false, opens=${controller.openRequests}');
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
