import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/launcher_style.dart'
    show launcherStyleStorageKey;
import 'package:feedback_widget/src/orb.dart' show OrbLiquidOutlinePainter;
import 'package:feedback_widget/src/test_env.dart';
import 'package:feedback_widget/src/wake_visual.dart' show wakeVisualStorageKey;
import 'package:feedback_widget/src/orb_entrance.dart'
    show orbEntranceStorageKey;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter/services.dart';
import 'capture_test_utils.dart' show pumpUntil;

Widget _host(FeedbackController controller, MemoryServerPrefStore store,
        {FeedbackLauncherMode launcherMode = FeedbackLauncherMode.beam,
        FeedbackLauncherStyle? launcherStyle,
        ValueChanged<FeedbackLauncherStyle>? onLauncherStyleChanged,
        FeedbackWakeVisual? wakeVisual,
        ValueChanged<FeedbackWakeVisual>? onWakeVisualChanged,
        FeedbackOrbEntrance? orbEntrance,
        ValueChanged<FeedbackOrbEntrance>? onOrbEntranceChanged,
        FeedbackWakeShortcut wakeShortcut = const FeedbackWakeShortcut(),
        bool hideSettings = false}) =>
    MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          launcherMode: launcherMode,
          wakeShortcut: wakeShortcut,
        ),
        controller: controller,
        launcherStyle: launcherStyle,
        onLauncherStyleChanged: onLauncherStyleChanged,
        wakeVisual: wakeVisual,
        onWakeVisualChanged: onWakeVisualChanged,
        orbEntrance: orbEntrance,
        onOrbEntranceChanged: onOrbEntranceChanged,
        hideSettings: hideSettings,
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
  testWidgets('host values override stored choices in the panel and on wake',
      (tester) async {
    debugDisableOrbLensCapture = true;
    addTearDown(() => debugDisableOrbLensCapture = false);
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final store = MemoryServerPrefStore();
    const app = 'com.example.app';
    await store.write(launcherStyleStorageKey(app), 'beam');
    await store.write(wakeVisualStorageKey(app), 'ripple');
    await store.write(orbEntranceStorageKey(app), 'bead');

    Future<void> mount(FeedbackLauncherStyle style) async {
      await tester.pumpWidget(_host(
        controller,
        store,
        launcherMode: FeedbackLauncherMode.tab,
        launcherStyle: style,
        wakeVisual: FeedbackWakeVisual.aurora,
        orbEntrance: FeedbackOrbEntrance.turn,
        wakeShortcut: const FeedbackWakeShortcut(
            primary: false, shift: false, key: LogicalKeyboardKey.f8),
      ));
      await tester.pump();
    }

    await mount(FeedbackLauncherStyle.orb);
    await tester.sendKeyEvent(LogicalKeyboardKey.f8);
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);
    final paint = tester.widget<CustomPaint>(find.byWidgetPredicate(
        (w) => w is CustomPaint && w.painter is OrbLiquidOutlinePainter));
    expect((paint.painter! as OrbLiquidOutlinePainter).entrance,
        FeedbackOrbEntrance.turn);

    await _openSettings(tester, controller);
    expect(find.text('快捷键：F8（输入框聚焦时不触发）'), findsOneWidget);
    expect(find.text('入口样式'), findsNothing);
    expect(find.text('唤醒动效'), findsNothing);
    expect(find.byKey(const Key('feedback-orb-entrance')), findsNothing);
    expect(find.text('唤醒方式'), findsOneWidget);
    await mount(FeedbackLauncherStyle.beam);
    expect(find.text('唤醒动效'), findsNothing);
    controller.close();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.f8);
    final overlay = find.byType(CaptureSelectionOverlay);
    await pumpUntil(tester, () => overlay.evaluate().isNotEmpty);
    expect(tester.widget<CaptureSelectionOverlay>(overlay).wakeVisual,
        FeedbackWakeVisual.aurora);
  });

  testWidgets(
      'host callbacks receive edits and only returned values take effect',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final store = MemoryServerPrefStore();
    final changes = <Object>[];
    Future<void> mount(FeedbackLauncherStyle style) async {
      await tester.pumpWidget(_host(
        controller,
        store,
        launcherStyle: style,
        onLauncherStyleChanged: changes.add,
        wakeVisual: FeedbackWakeVisual.ripple,
        onWakeVisualChanged: changes.add,
        orbEntrance: FeedbackOrbEntrance.bead,
        onOrbEntranceChanged: changes.add,
      ));
      await tester.pump();
    }

    Future<void> tap(Finder choice) async {
      await tester.ensureVisible(choice);
      await tester.tap(choice);
      await tester.pump();
    }

    await mount(FeedbackLauncherStyle.beam);
    await _openSettings(tester, controller);
    await tap(find.byKey(const Key('feedback-wake-visual-aurora')));
    await tap(find.byKey(const Key('feedback-launcher-style-orb')));
    FeedbackPanel panel() => tester.widget(find.byType(FeedbackPanel));
    expect(panel().wakeVisual, FeedbackWakeVisual.ripple);
    expect(panel().launcherMode, FeedbackLauncherMode.beam);
    await mount(FeedbackLauncherStyle.orb);
    expect(find.text('唤醒动效'), findsNothing);
    final picker = find.byKey(const Key('feedback-orb-entrance'));
    await tap(picker);
    await tester.pumpAndSettle();
    await tester
        .tap(find.text(FeedbackOrbEntrance.corners.label).hitTestable());
    await tester.pumpAndSettle();
    expect(panel().entrance, FeedbackOrbEntrance.bead);
    expect(changes, [
      FeedbackWakeVisual.aurora,
      FeedbackLauncherStyle.orb,
      FeedbackOrbEntrance.corners
    ]);
    const app = 'com.example.app';
    for (final key in [
      launcherStyleStorageKey(app),
      wakeVisualStorageKey(app),
      orbEntranceStorageKey(app)
    ]) {
      expect(await store.read(key), isNull, reason: key);
    }
  });

  testWidgets(
      'unmanaged launcher persists and resumes after host releases control',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final store = MemoryServerPrefStore();
    await tester.pumpWidget(_host(controller, store));
    await _openSettings(tester, controller);
    expect(find.text('唤醒动效'), findsOneWidget);
    final orb = find.byKey(const Key('feedback-launcher-style-orb'));
    await tester.ensureVisible(orb);
    await tester.tap(orb);
    await tester.pump();
    expect(await store.read(launcherStyleStorageKey('com.example.app')), 'orb');
    expect(find.byKey(const Key('feedback-orb-entrance')), findsOneWidget);
    await tester.pumpWidget(
        _host(controller, store, launcherStyle: FeedbackLauncherStyle.beam));
    expect(find.text('入口样式'), findsNothing);
    expect(find.text('唤醒动效'), findsOneWidget);
    await tester.pumpWidget(_host(controller, store));
    expect(find.text('入口样式'), findsOneWidget);
    expect(find.text('唤醒动效'), findsNothing);
    expect(find.byKey(const Key('feedback-orb-entrance')), findsOneWidget);
  });

  testWidgets('hideSettings leaves server controls in both launcher styles',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final store = MemoryServerPrefStore();
    await tester.pumpWidget(_host(controller, store, hideSettings: true));
    await _openSettings(tester, controller);
    expect(find.text('入口样式'), findsNothing);
    expect(find.text('唤醒动效'), findsNothing);
    for (final style in FeedbackLauncherStyle.values) {
      await tester.pumpWidget(_host(controller, store,
          launcherStyle: style,
          onLauncherStyleChanged: (_) => fail('settings hidden'),
          wakeVisual: FeedbackWakeVisual.aurora,
          onWakeVisualChanged: (_) => fail('settings hidden'),
          orbEntrance: FeedbackOrbEntrance.corners,
          onOrbEntranceChanged: (_) => fail('settings hidden'),
          hideSettings: true));
      expect(find.text('Feedback 服务器'), findsOneWidget);
      expect(find.byKey(const Key('feedback-server-save')), findsOneWidget);
      expect(find.text('入口样式'), findsNothing);
      expect(find.text('唤醒动效'), findsNothing);
      expect(find.byKey(const Key('feedback-orb-entrance')), findsNothing);
      expect(find.byKey(const Key('feedback-orb-idle-edge')), findsNothing);
      expect(find.text('唤醒方式'), findsNothing);
    }
  });

  testWidgets('host outside MaterialApp can change the orb entrance',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final changes = <FeedbackOrbEntrance>[];
    await tester.pumpWidget(FeedbackWidget(
      config: FeedbackConfig('https://svc.test', 'outer-host'),
      controller: controller,
      tokenStore: MemoryTokenStore('tok'),
      serverPrefStore: MemoryServerPrefStore(),
      httpClient: MockClient((request) async => http.Response('{}', 404)),
      launcherStyle: FeedbackLauncherStyle.orb,
      orbEntrance: FeedbackOrbEntrance.turn,
      onOrbEntranceChanged: changes.add,
      child: const MaterialApp(home: Placeholder()),
    ));
    await _openSettings(tester, controller);
    final picker = find.byKey(const Key('feedback-orb-entrance'));
    await tester.ensureVisible(picker);
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('取景成球').hitTestable());
    await tester.pumpAndSettle();
    expect(changes, [FeedbackOrbEntrance.corners]);
  });
}
