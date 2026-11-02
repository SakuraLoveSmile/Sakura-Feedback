import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'capture_test_utils.dart';

final Finder liquidOrb = find.byKey(const Key('feedback-orb'));
final Finder liquidBody = find.byKey(const Key('feedback-orb-body'));
final Finder liquidLens = find.byKey(const Key('feedback-orb-lens'));

typedef LiquidPaintState = ({double scale, double deform, double wobble});

/// Read the actual neutral material, rather than R2's removed brand halo.
LiquidPaintState liquidPaintState(WidgetTester tester) {
  final List<CustomPainter?> painters = tester
      .widgetList<CustomPaint>(
          find.descendant(of: liquidBody, matching: find.byType(CustomPaint)))
      .map((CustomPaint paint) => paint.painter)
      .toList();
  expect(painters.whereType<OrbPainter>(), isEmpty,
      reason: 'R3 has no legacy brand halo, sweep or breathing layer');
  final CustomPainter painter = painters
      .where((p) => p is OrbLiquidOutlinePainter || p is OrbLiquidLensPainter)
      .single!;
  final (double radius, double deform, double wobble) = switch (painter) {
    OrbLiquidOutlinePainter p => (p.radius, p.deform, p.wobble),
    OrbLiquidLensPainter p => (p.radius, p.deform, p.wobble),
    _ => throw StateError('Unexpected liquid material'),
  };
  return (
    scale: radius / (tester.getSize(liquidBody).width / 2),
    deform: deform,
    wobble: wobble
  );
}

/// Local mock only; no production account, AI, or Kaneo access.
class LiquidHarness {
  final ValueNotifier<int> revision = ValueNotifier<int>(0);
  final GlobalKey feedbackKey = GlobalKey();
  FeedbackController controller = FeedbackController();
  final List<FeedbackController> _oldControllers = <FeedbackController>[];
  final http.Client client = captureMockClient();
  final MemoryTokenStore tokens = MemoryTokenStore('tok');
  final MemoryServerPrefStore preferences = MemoryServerPrefStore();
  String appId = 'com.example.liquid';
  String? pageLabel;
  bool reduced = false;
  ThemeData? theme;
  bool showLauncher = true;
  FeedbackSide side = FeedbackSide.right;
  FeedbackCaptureMode captureMode = FeedbackCaptureMode.off;
  FeedbackLauncherMode launcherMode = FeedbackLauncherMode.orb;
  double dpr = 2;
  EdgeInsets padding = EdgeInsets.zero;
  bool reparent = false;
  Widget content = const SizedBox.expand(child: ColoredBox(color: Colors.blue));

  void rebuild() => revision.value++;
  void replaceController() {
    _oldControllers.add(controller);
    controller = FeedbackController();
    rebuild();
  }

  Future<void> mount(WidgetTester tester,
      {Size size = const Size(800, 600)}) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
        theme: theme,
        home: ValueListenableBuilder<int>(
            valueListenable: revision,
            builder: (BuildContext context, int value, Widget? child) {
              final Widget feedback = FeedbackWidget(
                  key: feedbackKey,
                  config: FeedbackConfig('https://svc.test', appId,
                      pageLabel: pageLabel,
                      showLauncher: showLauncher,
                      launcherMode: launcherMode,
                      captureMode: captureMode,
                      side: side),
                  controller: controller,
                  tokenStore: tokens,
                  serverPrefStore: preferences,
                  httpClient: client,
                  child: content);
              return MediaQuery(
                  data: MediaQuery.of(context).copyWith(
                      disableAnimations: reduced, devicePixelRatio: dpr),
                  child: Padding(
                      padding: padding,
                      child: reparent
                          ? KeyedSubtree(
                              key: const Key('reparented-host'),
                              child: feedback)
                          : feedback));
            })));
    await tester.pump();
  }

  Future<Offset> select(WidgetTester tester,
      {Offset delta = const Offset(-120, -80)}) async {
    final Offset start = tester.getCenter(liquidOrb);
    final TestGesture gesture = await tester.startGesture(start);
    await gesture.moveBy(delta);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.up();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 550));
    // Flutter's interpolation simulation retires its ticker on the first
    // frame after the exact duration, although its end value is already 1.
    await tester.pump(const Duration(milliseconds: 16));
    return start + delta;
  }

  FeedbackPanelState panel(WidgetTester tester) =>
      tester.state<FeedbackPanelState>(
          find.byType(FeedbackPanel, skipOffstage: false));

  Future<void> waitScreenshot(WidgetTester tester,
      {bool complete = true}) async {
    await pumpUntil(
        tester,
        () =>
            find.byType(FeedbackPanel).evaluate().isNotEmpty &&
            panel(tester).hasScreenshot);
    // One post-layout pass measures the actual capture thumbnail.
    await tester.pump();
    await tester.pump();
    if (complete) {
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
    }
  }

  void dispose() {
    revision.dispose();
    controller.dispose();
    for (final FeedbackController controller in _oldControllers) {
      controller.dispose();
    }
    client.close();
  }
}
