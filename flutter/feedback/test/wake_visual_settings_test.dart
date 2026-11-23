import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/wake_visual.dart';
import 'package:feedback_widget/src/orb_entrance.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Widget _host(FeedbackController controller, MemoryServerPrefStore store,
        {FeedbackLauncherMode launcherMode = FeedbackLauncherMode.beam}) =>
    MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          launcherMode: launcherMode,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: store,
        httpClient: MockClient(
            (http.Request request) async => http.Response('{}', 404)),
        child: const Placeholder(),
      ),
    );

Future<void> _openSettings(
    WidgetTester tester, FeedbackController controller) async {
  controller.open();
  await tester.pump();
  await tester.pump();
  await tester.tap(find.byKey(const Key('feedback-settings')));
  await tester.pump();
}

void main() {
  testWidgets('wake visual defaults to ripple and switching to aurora persists',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final MemoryServerPrefStore store = MemoryServerPrefStore();
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, store));
    await tester.pump();
    await _openSettings(tester, controller);

    final Finder ripple = find.byKey(const Key('feedback-wake-visual-ripple'));
    final Finder aurora = find.byKey(const Key('feedback-wake-visual-aurora'));
    await tester.ensureVisible(ripple);
    expect(ripple, findsOneWidget);
    expect(find.text('水波纹（默认）'), findsOneWidget);
    expect(aurora, findsOneWidget);

    await tester.ensureVisible(aurora);
    await tester.tap(aurora);
    await tester.pump();
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    expect(await store.read(wakeVisualStorageKey('com.example.app')), 'aurora',
        reason: '选择波光后写入按 appId 隔离的偏好');
  });

  testWidgets(
      'orb entrance offers all seven choices and restores the saved effect',
      (tester) async {
    final store = MemoryServerPrefStore();
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    Future<void> open() async {
      await tester.pumpWidget(
          _host(controller, store, launcherMode: FeedbackLauncherMode.orb));
      await tester.pump();
      await _openSettings(tester, controller);
    }

    await open();
    final picker = find.byKey(const Key('feedback-orb-entrance'));
    await tester.ensureVisible(picker);
    expect(tester.widget<DropdownButton<FeedbackOrbEntrance>>(picker).value,
        FeedbackOrbEntrance.bead);
    await tester.tap(picker);
    await tester.pumpAndSettle();
    for (final effect in FeedbackOrbEntrance.values) {
      expect(find.text(effect.label).hitTestable(), findsOneWidget);
    }
    await tester.tap(find.text('取景成球').hitTestable());
    await tester.pumpAndSettle();
    expect(
        await store.read(orbEntranceStorageKey('com.example.app')), 'corners');
    controller.close();
    await tester.pumpWidget(const SizedBox());
    await open();
    expect(tester.widget<DropdownButton<FeedbackOrbEntrance>>(picker).value,
        FeedbackOrbEntrance.corners);
  });

  testWidgets('the wake visual section is hidden when the host pins tab mode',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, MemoryServerPrefStore(),
        launcherMode: FeedbackLauncherMode.tab));
    await tester.pump();
    await _openSettings(tester, controller);
    expect(find.byKey(const Key('feedback-wake-visual-ripple')), findsNothing);
    expect(find.text('唤醒动效'), findsNothing);
  });
}
