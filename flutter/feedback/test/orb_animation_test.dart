import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

OrbPainter orbPainter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(find.byType(CustomPaint))
    .map((CustomPaint paint) => paint.painter)
    .whereType<OrbPainter>()
    .single;

void main() {
  late FeedbackController controller;
  late MemoryTokenStore store;
  late MemoryServerPrefStore serverPrefStore;
  late http.Client client;

  setUp(() {
    debugForceOrbAnimation = true;
    controller = FeedbackController();
    store = MemoryTokenStore('tok');
    serverPrefStore = MemoryServerPrefStore();
    client = captureMockClient();
  });

  tearDown(() {
    debugForceOrbAnimation = false;
    controller.dispose();
    client.close();
  });

  Future<void> pumpHost(
    WidgetTester tester, {
    bool showLauncher = true,
    bool reducedMotion = false,
    FeedbackLauncherMode launcherMode = FeedbackLauncherMode.orb,
    FeedbackCaptureMode captureMode = FeedbackCaptureMode.off,
    Size surface = const Size(800, 600),
  }) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: Builder(builder: (BuildContext context) {
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(
            disableAnimations: reducedMotion,
          ),
          child: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-animation',
              launcherMode: launcherMode,
              captureMode: captureMode,
              showLauncher: showLauncher,
            ),
            controller: controller,
            tokenStore: store,
            serverPrefStore: serverPrefStore,
            httpClient: client,
            child: const SizedBox.expand(
              child: ColoredBox(color: Colors.blue),
            ),
          ),
        );
      }),
    ));
    await tester.pump();
  }

  testWidgets('10s 单一控制器周期', (WidgetTester tester) async {
    await pumpHost(tester);
    await tester.pump(const Duration(seconds: 5));
    final double at5 = orbPainter(tester).flow;
    expect(at5, inInclusiveRange(0.49, 0.51));
    await tester.pump(const Duration(milliseconds: 2500));
    final double at75 = orbPainter(tester).flow;
    expect(at75, inInclusiveRange(0.74, 0.76));
    await tester.pump(const Duration(milliseconds: 2500));
    final double at10 = orbPainter(tester).flow;
    expect(at10 < 0.02 || at10 > 0.98, isTrue);
    debugPrint('T4-3 cycle: flow@5s=$at5, @7.5s=$at75, @10s=$at10');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('连续呼吸八个 0.4s 采样', (WidgetTester tester) async {
    await pumpHost(tester);
    expect(orbPainter(tester).flow, 0.0);
    expect(orbPainter(tester).breath, 0.0);
    double previous = 0.0;
    bool hasIntermediate = false;
    for (int index = 1; index <= 8; index++) {
      await tester.pump(const Duration(milliseconds: 400));
      final OrbPainter painter = orbPainter(tester);
      final double difference = (painter.breath - previous).abs();
      expect(painter.breath, closeTo(orbBreath(painter.flow), 1e-9));
      expect(difference, lessThan(0.75));
      if (painter.breath > 0.01 && painter.breath < 0.99) {
        hasIntermediate = true;
      }
      debugPrint('T4-3 breath: t=${index * 0.4}, flow=${painter.flow}, '
          'breath=${painter.breath}, delta=$difference');
      previous = painter.breath;
    }
    expect(hasIntermediate, isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('面板打开停止，关闭后从零重新运行', (WidgetTester tester) async {
    await pumpHost(tester);
    await tester.pump(const Duration(seconds: 5));
    final double before = orbPainter(tester).flow;
    expect(before, inInclusiveRange(0.49, 0.51));
    controller.open();
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    await tester.pump(const Duration(seconds: 3));
    controller.close();
    await tester.pump();
    await tester.pump();
    expect(orbPainter(tester).flow, 0.0);
    await tester.pump(const Duration(milliseconds: 100));
    final double after = orbPainter(tester).flow;
    expect(after, greaterThan(0));
    expect(after, lessThanOrEqualTo(0.03));
    debugPrint('T4-3 open-close: before=$before, restart+0.1s=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('showLauncher 隐藏停止，恢复后从零重新运行', (WidgetTester tester) async {
    await pumpHost(tester);
    await tester.pump(const Duration(seconds: 5));
    final double before = orbPainter(tester).flow;
    expect(before, inInclusiveRange(0.49, 0.51));
    await pumpHost(tester, showLauncher: false);
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    await tester.pump(const Duration(seconds: 3));
    await pumpHost(tester, showLauncher: true);
    await tester.pump();
    await tester.pump();
    expect(orbPainter(tester).flow, 0.0);
    await tester.pump(const Duration(milliseconds: 100));
    final double after = orbPainter(tester).flow;
    expect(after, greaterThan(0));
    expect(after, lessThanOrEqualTo(0.03));
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);
    debugPrint('T4-3 showLauncher: before=$before, restart+0.1s=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('tab 模式没有灵感球或 OrbPainter', (WidgetTester tester) async {
    await pumpHost(tester, launcherMode: FeedbackLauncherMode.tab);
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget);
    expect(
      tester
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .map((CustomPaint paint) => paint.painter)
          .whereType<OrbPainter>(),
      isEmpty,
    );
    debugPrint('T4-3 tab: orb=0, fab=1, OrbPainter=0');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reduced-motion 静态且没有常驻 Ticker', (WidgetTester tester) async {
    await pumpHost(tester, reducedMotion: true);
    expect(orbPainter(tester).flow, 0.0);
    expect(orbPainter(tester).breath, 0.0);
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pump(const Duration(seconds: 1));
    expect(orbPainter(tester).flow, 0.0);
    expect(orbPainter(tester).breath, 0.0);
    expect(tester.binding.transientCallbackCount, 0);
    debugPrint('T4-3 reduced-motion: flow=0, breath=0, tickers=0 after 1s');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('选区全屏遮挡停止并归零，取消后重新运行', (WidgetTester tester) async {
    await pumpHost(tester, captureMode: FeedbackCaptureMode.viewport);
    await tester.pump(const Duration(seconds: 5));
    final double before = orbPainter(tester).flow;
    expect(before, inInclusiveRange(0.49, 0.51));
    final Finder orb = find.byKey(const Key('feedback-orb'));
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(orb));
    await gesture.moveBy(const Offset(-40, -40));
    await gesture.moveBy(const Offset(-10, -10));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await gesture.up();
    await tester.pump();
    final Finder overlay =
        find.byKey(const Key('feedback-capture-selection-overlay'));
    await pumpUntil(tester, () => overlay.evaluate().isNotEmpty);
    await tester.pump();
    await tester.pump();
    expect(overlay, findsOneWidget);
    expect(controller.isOpen, isFalse);
    await tester.pump(const Duration(milliseconds: 500));
    final OrbPainter occluded = orbPainter(tester);
    expect(occluded.flow, 0.0);
    expect(occluded.breath, 0.0);
    expect(tester.binding.transientCallbackCount, 0);
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    await tester.pump();
    expect(overlay, findsNothing);
    expect(orbPainter(tester).flow, 0.0);
    await tester.pump(const Duration(milliseconds: 100));
    final double after = orbPainter(tester).flow;
    expect(after, greaterThan(0));
    expect(after, lessThanOrEqualTo(0.03));
    debugPrint('T4-3 occluded: before=$before, overlay+0.5s='
        '${occluded.flow}, breath=${occluded.breath}, cancel+0.1s=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('默认测试环境没有 Ticker，pumpAndSettle 正常结束',
      (WidgetTester tester) async {
    debugForceOrbAnimation = false;
    expect(kFeedbackInFlutterTest, isTrue);
    await pumpHost(tester);
    final int pumps = await tester.pumpAndSettle();
    expect(orbPainter(tester).flow, 0.0);
    expect(orbPainter(tester).breath, 0.0);
    expect(tester.binding.transientCallbackCount, 0);
    debugPrint('T4-3 default: flow=0, breath=0, tickers=0, settlePumps=$pumps');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('源码只有一个 10s 控制器，没有呼吸 Timer', () {
    final String widgetSource = readComponentSource('lib/src/widget.dart');
    final String orbSource = readComponentSource('lib/src/orb.dart');
    expect(RegExp(r'AnimationController\(').allMatches(widgetSource).length, 1);
    expect(RegExp(r'AnimationController\(').allMatches(orbSource), isEmpty);
    expect(widgetSource, contains('duration: kFeedbackOrbSweepDuration'));
    expect(RegExp(r'\b2400\b').allMatches(widgetSource), isEmpty);
    expect(widgetSource, isNot(contains('_syncOrbGlow')));
    expect(widgetSource, isNot(contains('Timer(')));
    expect(orbSource, isNot(contains('Timer(')));
    debugPrint('T4-3 source: AnimationController=1, duration=token, Timer=0');
  });

  testWidgets('逐帧动画不重建常驻面板或 AnimatedContainer', (WidgetTester tester) async {
    await pumpHost(tester);
    controller.open();
    await tester.pump();
    await tester.pump();
    controller.close();
    await tester.pump();
    await tester.pump();
    final Finder panel = find.byType(FeedbackPanel, skipOffstage: false);
    final Widget originalPanel = tester.widget(panel);
    final Widget originalBody =
        tester.widget(find.byKey(const Key('feedback-orb-body')));
    await tester.pump(const Duration(seconds: 1));
    expect(orbPainter(tester).flow, inInclusiveRange(0.09, 0.11));
    expect(tester.widget(panel), same(originalPanel));
    expect(tester.widget(find.byKey(const Key('feedback-orb-body'))),
        same(originalBody));
    debugPrint('T4-3 repaint scope: flow=${orbPainter(tester).flow}, '
        'panel identity=true, container identity=true');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('运行中切换 reduced-motion 再恢复复用单一控制器', (WidgetTester tester) async {
    await pumpHost(tester, surface: const Size(400, 800));
    await tester.pump(const Duration(seconds: 5));
    expect(orbPainter(tester).flow, inInclusiveRange(0.49, 0.51));
    await pumpHost(tester, reducedMotion: true, surface: const Size(400, 800));
    expect(orbPainter(tester).flow, 0.0);
    expect(orbPainter(tester).breath, 0.0);
    await tester.pump(const Duration(seconds: 1));
    expect(tester.binding.transientCallbackCount, 0);
    await pumpHost(tester, surface: const Size(400, 800));
    await tester.pump(const Duration(milliseconds: 100));
    final double after = orbPainter(tester).flow;
    expect(after, greaterThan(0));
    expect(after, lessThanOrEqualTo(0.03));
    debugPrint('T4-3 reduced-motion toggle (400x800): restart+0.1s=$after');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('启动帧后回调重新检查面板状态，避免过期启动', (WidgetTester tester) async {
    tester.binding.addPostFrameCallback((_) => controller.open());
    await pumpHost(tester);
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-orb')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    controller.close();
    await tester.pump();
    await tester.pump();
    expect(orbPainter(tester).flow, 0.0);
    await tester.pump(const Duration(milliseconds: 100));
    expect(orbPainter(tester).flow, greaterThan(0));
    expect(orbPainter(tester).flow, lessThanOrEqualTo(0.03));
    debugPrint('T4-3 post-frame race: restart+0.1s=${orbPainter(tester).flow}');
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
