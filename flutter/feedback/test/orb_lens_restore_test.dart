import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/orb_idle.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

final Finder _shader = find.byKey(const Key('feedback-orb-lens-shader'));

Future<OrbLiquidLensPainter> _waitLens(WidgetTester tester) async {
  await pumpUntil(tester, () => _shader.evaluate().isNotEmpty);
  return tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;
}

Future<void> _expectQuiet(WidgetTester tester, int attempts) async {
  for (int i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  expect(debugOrbLensCaptureAttempts, attempts,
      reason:
          'the explicit one-day test interval prevents unrelated refreshes');
  expect(tester.takeException(), isNull);
}

Future<TestGesture> _holdOldCapture(WidgetTester tester) async {
  debugOrbLensGateDuration = Duration.zero;
  final TestGesture pointer =
      await tester.startGesture(tester.getCenter(liquidOrb));
  await pointer.moveBy(const Offset(-80, -30));
  // Flush shader-cache futures without drawing the awaited capture frame.
  await tester.idle();
  expect(debugOrbLensCaptureAttempts, 2);
  debugOrbLensGateDuration = const Duration(days: 1);
  return pointer;
}

const Color _lightBackground = Color(0xFFF3F4FA);
const Color _darkBackground = Color(0xFF191B24);

class _ThemeBackground extends StatelessWidget {
  const _ThemeBackground();

  @override
  Widget build(BuildContext context) => Stack(children: <Widget>[
        Positioned.fill(
            child:
                ColoredBox(color: Theme.of(context).scaffoldBackgroundColor)),
        const Positioned(
            left: 100,
            top: 100,
            width: 120,
            height: 80,
            child: FeedbackCaptureMask(
                maskColor: Color(0x106E6E73),
                child: ColoredBox(color: Colors.red))),
      ]);
}

// MaterialApp's default AnimatedTheme is intentional: capturing just the first
// rebuilt frame would retain the old/interpolated host pixels, as in the demo.
class _ThemedHostApp extends StatelessWidget {
  const _ThemedHostApp({required this.mode, required this.child});
  final ThemeMode mode;
  final Widget child;

  @override
  Widget build(BuildContext context) => MaterialApp(
      theme:
          ThemeData.light().copyWith(scaffoldBackgroundColor: _lightBackground),
      darkTheme:
          ThemeData.dark().copyWith(scaffoldBackgroundColor: _darkBackground),
      themeMode: mode,
      home: child);
}

Future<void> _mountThemed(WidgetTester tester, LiquidHarness host,
    {required FeedbackThemeMode configTheme,
    required ThemeMode hostTheme,
    bool outsideApp = true}) async {
  Widget feedback(Widget child) => FeedbackWidget(
      key: host.feedbackKey,
      config: FeedbackConfig('https://svc.test', host.appId,
          theme: configTheme,
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: host.captureMode,
          showLauncher: host.showLauncher),
      controller: host.controller,
      tokenStore: host.tokens,
      serverPrefStore: host.preferences,
      httpClient: host.client,
      child: child);
  await tester.pumpWidget(outsideApp
      ? feedback(
          _ThemedHostApp(mode: hostTheme, child: const _ThemeBackground()))
      : _ThemedHostApp(
          mode: hostTheme, child: feedback(const _ThemeBackground())));
  await tester.pump();
}

Future<void> _expectTexture(
    WidgetTester tester, ui.Image image, double scale, Color background) async {
  final Uint8List pixels = (await tester.runAsync<ByteData?>(
          () => image.toByteData(format: ui.ImageByteFormat.rawRgba)))!
      .buffer
      .asUint8List();
  List<int> at(int x, int y) {
    final int i = ((y * scale).floor() * image.width + (x * scale).floor()) * 4;
    return pixels.sublist(i, i + 4);
  }

  final int argb = background.toARGB32();
  expect(
      at(20, 20), <int>[(argb >> 16) & 255, (argb >> 8) & 255, argb & 255, 255],
      reason: 'the safe sampler must contain the final host background pixels');
  expect(at(120, 120), <int>[110, 110, 115, 255],
      reason: 'even translucent requested masks stay opaque after refresh');
}

void main() {
  late LiquidHarness host;
  late Duration originalGate;
  setUp(() {
    host = LiquidHarness();
    debugDisableOrbLensCapture = false;
    debugOrbLensCaptureAttempts = 0;
    originalGate = debugOrbLensGateDuration;
    // A missing texture must restore immediately even inside the refresh gate.
    debugOrbLensGateDuration = const Duration(days: 1);
  });
  tearDown(() {
    host.dispose();
    debugOrbLensGateDuration = originalGate;
    debugFailOrbLensCapture = false;
  });

  for (final FeedbackSide side in FeedbackSide.values) {
    testWidgets(
        '${side.name} edge collapse retains the actual masked glass at the clipped visual center',
        (tester) async {
      host.side = side;
      host.content = const Stack(children: <Widget>[
        Positioned.fill(child: ColoredBox(color: Colors.blue)),
        Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            width: 60,
            child: FeedbackCaptureMask(
                maskColor: Color(0x106E6E73),
                child: ColoredBox(color: Colors.red))),
      ]);
      await host.preferences.write(orbIdleStorageKey(host.appId),
          encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
      host.padding = const EdgeInsets.fromLTRB(80, 60, 120, 40);
      await host.mount(tester);
      final OrbLiquidLensPainter original = await _waitLens(tester);
      await tester.pump(const Duration(seconds: 5));
      for (final Duration step in <Duration>[
        Duration.zero,
        const Duration(milliseconds: 210),
        const Duration(milliseconds: 210)
      ]) {
        await tester.pump(step);
        final OrbLiquidLensPainter paint = tester
            .widget<CustomPaint>(_shader)
            .painter! as OrbLiquidLensPainter;
        final Rect moving =
            tester.getRect(find.byKey(const Key('feedback-orb-idle-edge')));
        expect(paint.center, moving.center - const Offset(80, 60));
        expect(paint.image, same(original.image));
      }
      expect(find.byKey(const Key('feedback-orb-collapsed')), findsOneWidget);
      final OrbLiquidLensPainter edge =
          tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;
      expect(edge.image, same(original.image));
      expect(edge.radius, 28);
      final Rect face =
          tester.getRect(find.byKey(const Key('feedback-orb-idle-edge')));
      expect(edge.center, face.center - const Offset(80, 60));
      expect(
          edge.offset,
          offsetMoreOrLessEquals(edge.center - const Offset(44.8, 44.8),
              epsilon: 1e-9));
      expect(debugOrbLensCaptureAttempts, 1);
      final Uint8List? pixels = await tester.runAsync<Uint8List?>(
          () async => (await edge.image.toByteData())?.buffer.asUint8List());
      final int index = ((20 * edge.scale).floor() * edge.image.width +
              (590 * edge.scale).floor()) *
          4;
      expect(pixels!.sublist(index, index + 4), <int>[110, 110, 115, 255]);
      await tester.tap(find.byKey(const Key('feedback-orb-collapsed')));
      await tester.pump();
      expect((await _waitLens(tester)).image, same(original.image));
      expect(debugOrbLensCaptureAttempts, 1);
      expect(host.controller.isOpen, isFalse);
      expect(tester.takeException(), isNull);
    });
  }

  for (final FeedbackSide side in FeedbackSide.values) {
    testWidgets(
        '${side.name} R7 capsule stays inside local safe edges and reverses continuously',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(800, 600);
      tester.view.padding =
          const FakeViewPadding(left: 100, top: 24, right: 140, bottom: 34);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetPadding);
      host.side = side;
      host.padding = const EdgeInsets.fromLTRB(80, 60, 120, 40);
      await host.mount(tester);
      final OrbLiquidLensPainter original = await _waitLens(tester);
      expect(original.mist, .74);
      expect(original.idleMix, 1);
      OrbLiquidLensPainter painted() =>
          tester.widget<CustomPaint>(_shader).painter! as OrbLiquidLensPainter;
      final Finder face = find.byKey(const Key('feedback-orb-idle-handle'));
      final Finder hit = find.byKey(const Key('feedback-orb-collapsed'));
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      final OrbLiquidLensPainter start = painted();
      expect(start.center, original.center);
      expect(start.halfSize, const Size(28, 28));
      expect(start.handleMix, 0);
      await tester.pump(const Duration(milliseconds: 210));
      final OrbLiquidLensPainter halfway = painted();
      expect(halfway.halfSize!.width, closeTo(8.75, .001));
      expect(halfway.handleMix, closeTo(.875, .001));
      expect(
          halfway.center, tester.getRect(face).center - const Offset(80, 60));
      expect(halfway.image, same(original.image));
      await tester.tap(hit);
      await tester.pump();
      expect(painted().center, halfway.center,
          reason: 'waking mid-collapse starts at the currently painted center');
      expect(painted().handleMix, halfway.handleMix);
      await tester.pump(const Duration(milliseconds: 105));
      expect(painted().handleMix, lessThan(halfway.handleMix));
      await tester.pump(const Duration(milliseconds: 105));
      expect(liquidOrb, findsOneWidget);
      expect(painted().center, original.center);
      expect(host.controller.isOpen, isFalse);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 420));
      final Rect capsule = tester.getRect(face);
      final Rect target = tester.getRect(hit);
      expect(capsule.size, const Size(12, 56));
      expect(target.size, const Size(44, 56));
      expect(side == FeedbackSide.left ? capsule.left : capsule.right,
          side == FeedbackSide.left ? 103 : 657);
      expect(side == FeedbackSide.left ? target.left : target.right,
          side == FeedbackSide.left ? 100 : 660);
      expect(painted().center, capsule.center - const Offset(80, 60));
      expect(painted().halfSize, const Size(6, 28));
      expect(painted().handleMix, 1);
      expect(painted().image, same(original.image));
      expect(debugOrbLensCaptureAttempts, 1);
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(highContrast: true);
      addTearDown(
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await tester.pump();
      expect(_shader, findsNothing);
      final OrbLiquidOutlinePainter fallback = tester
          .widgetList<CustomPaint>(
              find.descendant(of: face, matching: find.byType(CustomPaint)))
          .map((CustomPaint p) => p.painter)
          .whereType<OrbLiquidOutlinePainter>()
          .single;
      expect(fallback.halfSize, const Size(6, 28));
      expect(fallback.handleMix, 1);
      expect(
          fallback.color, Theme.of(tester.element(face)).colorScheme.onSurface);
      tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
      await tester.pump();
      expect((await _waitLens(tester)).image, isNot(same(original.image)));
      expect(debugOrbLensCaptureAttempts, 2);
      // No perpetual material/morph ticker is left at rest.
      await tester.pump(const Duration(milliseconds: 1));
      expect(tester.binding.transientCallbackCount, 0);
      host.controller.setUnreadCount(4);
      await tester.pump();
      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(tester.getSemantics(hit).value, '4 条未读反馈');
      semantics.dispose();
      // A real hide during wake releases the old safe texture and cancels morph.
      await tester.tap(hit);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      host.showLauncher = false;
      host.rebuild();
      await tester.pump();
      await tester.pump();
      expect(_shader, findsNothing);
      expect(hit, findsNothing);
      await tester.pump(const Duration(seconds: 1));
      host.showLauncher = true;
      host.rebuild();
      await tester.pump();
      expect(liquidOrb, findsOneWidget);
      expect((await _waitLens(tester)).image, isNot(same(original.image)));
      expect(debugOrbLensCaptureAttempts, 3);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'handle retains the glass and waking reuses the same safe texture',
      (tester) async {
    await host.mount(tester);
    final OrbLiquidLensPainter original = await _waitLens(tester);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_shader, findsOneWidget);
    expect(debugOrbLensCaptureAttempts, 1);
    await tester.tap(find.byKey(const Key('feedback-orb-collapsed')));
    await tester.pump();
    expect((await _waitLens(tester)).image, same(original.image));
    await _expectQuiet(tester, 1);
  });

  testWidgets(
      'hidden idle releases the lens snapshot; the returning full orb captures a fresh one',
      (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden));
    await host.mount(tester);
    final OrbLiquidLensPainter original = await _waitLens(tester);
    expect(debugOrbLensCaptureAttempts, 1);
    // 待机隐藏后入口不在屏幕上，透镜快照随之释放（_lensVisible 为 false）。
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(liquidOrb, findsNothing);
    expect(_shader, findsNothing);
    // 完整球恢复（面板打开后关闭，与唤醒同一条「重新可见」路径）时按既有
    // 规则重新捕获，而不是复用隐藏前的安全纹理。
    host.controller.open();
    await tester.pump();
    await tester.pump();
    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    final OrbLiquidLensPainter restored = await _waitLens(tester);
    expect(restored.image, isNot(same(original.image)));
    expect(debugOrbLensCaptureAttempts, 2);
    await _expectQuiet(tester, 2);
  });

  testWidgets(
      'background while edge is visible releases it and resume restores once',
      (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    await host.mount(tester);
    final OrbLiquidLensPainter original = await _waitLens(tester);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_shader, findsOneWidget);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    await tester.pump();
    expect(_shader, findsNothing);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-collapsed')), findsNothing);
    expect((await _waitLens(tester)).image, isNot(same(original.image)));
    await _expectQuiet(tester, 2);
  });

  for (final FeedbackOrbIdleStyle? style in <FeedbackOrbIdleStyle?>[
    null,
    FeedbackOrbIdleStyle.handle,
    FeedbackOrbIdleStyle.edge,
  ]) {
    testWidgets(
        'theme refresh explicit ${style?.name ?? 'full'} uses final animated host pixels',
        (tester) async {
      if (style != null) {
        await host.preferences
            .write(orbIdleStorageKey(host.appId), encodeOrbIdleStyle(style));
      }
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
      final identity = tester.state(find.byKey(host.feedbackKey));
      OrbLiquidLensPainter previous = await _waitLens(tester);
      await _expectTexture(
          tester, previous.image, previous.scale, _lightBackground);
      if (style != null) {
        await tester.pump(const Duration(seconds: 5));
        await tester.pump(const Duration(milliseconds: 420));
      }
      int attempts = 1;
      for (final bool dark in <bool>[true, false]) {
        await _mountThemed(tester, host,
            configTheme:
                dark ? FeedbackThemeMode.dark : FeedbackThemeMode.light,
            hostTheme: dark ? ThemeMode.dark : ThemeMode.light);
        final bool staleVisible = _shader.evaluate().isNotEmpty;
        await tester.pump(const Duration(milliseconds: 350));
        final OrbLiquidLensPainter refreshed = await _waitLens(tester);
        await _expectTexture(tester, refreshed.image, refreshed.scale,
            dark ? _darkBackground : _lightBackground);
        expect(staleVisible, isFalse,
            reason: 'old-theme decoration clears immediately');
        expect(tester.state(find.byKey(host.feedbackKey)), same(identity));
        expect(refreshed.image, isNot(same(previous.image)));
        expect(refreshed.dark, dark);
        expect(find.byType(BackdropFilter), findsNothing);
        if (style == null) liquidPaintState(tester);
        await _expectQuiet(tester, ++attempts);
        previous = refreshed;
      }
      if (style != null) {
        final Finder collapsed =
            find.byKey(const Key('feedback-orb-collapsed'));
        expect(collapsed, findsOneWidget);
        await tester.tapAt(tester.getCenter(collapsed));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 420));
        expect((await _waitLens(tester)).image, same(previous.image));
        expect(host.controller.isOpen, isFalse);
        await _expectQuiet(tester, attempts);
      }
    });
  }

  for (final bool outsideApp in <bool>[false, true]) {
    testWidgets(
        'theme refresh system brightness ${outsideApp ? 'outside' : 'inside'} MaterialApp',
        (tester) async {
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.system,
          hostTheme: ThemeMode.system,
          outsideApp: outsideApp);
      final identity = tester.state(find.byKey(host.feedbackKey));
      final OrbLiquidLensPainter original = await _waitLens(tester);
      await _expectTexture(
          tester, original.image, original.scale, _lightBackground);
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 250));
      final OrbLiquidLensPainter refreshed = await _waitLens(tester);
      await _expectTexture(
          tester, refreshed.image, refreshed.scale, _darkBackground);
      expect(tester.state(find.byKey(host.feedbackKey)), same(identity));
      expect(refreshed.dark, isTrue);
      await _expectQuiet(tester, 2);
    });
  }

  testWidgets('theme refresh ancestor brightness with unchanged system config',
      (tester) async {
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.system,
        hostTheme: ThemeMode.light,
        outsideApp: false);
    final OrbLiquidLensPainter original = await _waitLens(tester);
    await _expectTexture(
        tester, original.image, original.scale, _lightBackground);
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.system,
        hostTheme: ThemeMode.dark,
        outsideApp: false);
    // ThemeData.lerp changes brightness halfway through the default animation.
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 250));
    final OrbLiquidLensPainter refreshed = await _waitLens(tester);
    await _expectTexture(
        tester, refreshed.image, refreshed.scale, _darkBackground);
    expect(refreshed.dark, isTrue);
    await _expectQuiet(tester, 2);
  });

  testWidgets(
      'theme refresh invalidates old in-flight capture and only publishes final pixels',
      (tester) async {
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
    await _waitLens(tester);
    final TestGesture pointer = await _holdOldCapture(tester);
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
    await tester.pump(const Duration(milliseconds: 100));
    expect(_shader, findsNothing);
    expect(debugOrbLensCaptureAttempts, 2);
    await tester.pump(const Duration(milliseconds: 250));
    final OrbLiquidLensPainter refreshed = await _waitLens(tester);
    await _expectTexture(
        tester, refreshed.image, refreshed.scale, _darkBackground);
    await pointer.cancel();
    await _expectQuiet(tester, 3);
  });

  testWidgets(
      'theme refresh during selection preserves frozen pixels and metadata until cancel',
      (tester) async {
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
    await _waitLens(tester);
    final Offset release = await host.select(tester);
    final CaptureSelectionOverlay frozen =
        tester.widget(find.byType(CaptureSelectionOverlay));
    await _expectTexture(tester, frozen.image, frozen.scale, _lightBackground);
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
    await tester.pump(const Duration(milliseconds: 350));
    final CaptureSelectionOverlay retained =
        tester.widget(find.byType(CaptureSelectionOverlay));
    expect(retained.image, same(frozen.image));
    expect(retained.viewport, frozen.viewport);
    expect(retained.releasePoint, frozen.releasePoint);
    expect(retained.orbCenter, frozen.orbCenter);
    expect(retained.releasePoint, Offset(release.dx / 800, release.dy / 600));
    await _expectTexture(
        tester, retained.image, retained.scale, _lightBackground);
    expect(_shader, findsNothing);
    expect(debugOrbLensCaptureAttempts, 1);
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    final OrbLiquidLensPainter restored = await _waitLens(tester);
    await _expectTexture(
        tester, restored.image, restored.scale, _darkBackground);
    await _expectQuiet(tester, 2);
  });

  testWidgets('theme refresh rapid switches coalesce into the latest sampler',
      (tester) async {
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
    await _waitLens(tester);
    for (final bool dark in <bool>[true, false, true]) {
      await _mountThemed(tester, host,
          configTheme: dark ? FeedbackThemeMode.dark : FeedbackThemeMode.light,
          hostTheme: dark ? ThemeMode.dark : ThemeMode.light);
      await tester.pump(const Duration(milliseconds: 80));
      expect(_shader, findsNothing);
      expect(debugOrbLensCaptureAttempts, 1);
    }
    await tester.pump(const Duration(milliseconds: 120));
    final OrbLiquidLensPainter refreshed = await _waitLens(tester);
    await _expectTexture(
        tester, refreshed.image, refreshed.scale, _darkBackground);
    await _expectQuiet(tester, 2);
    expect(tester.binding.transientCallbackCount, 0);
  });

  for (final String hidden in <String>['launcher', 'panel', 'background']) {
    testWidgets('theme refresh defers while $hidden hides decoration',
        (tester) async {
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
      await _waitLens(tester);
      if (hidden == 'panel') {
        host.controller.open();
      } else if (hidden == 'background') {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      } else {
        host.showLauncher = false;
      }
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
      if (hidden == 'panel') {
        await tester.enterText(
            find.byKey(const Key('feedback-input')), '主题切换保留草稿');
      }
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
      await tester.pump(const Duration(milliseconds: 350));
      expect(_shader, findsNothing);
      await _expectQuiet(tester, 1);
      if (hidden == 'panel') {
        expect(
            tester
                .widget<TextField>(find.byKey(const Key('feedback-input')))
                .controller!
                .text,
            '主题切换保留草稿');
        host.controller.close();
      } else if (hidden == 'background') {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      } else {
        host.showLauncher = true;
      }
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
      final OrbLiquidLensPainter restored = await _waitLens(tester);
      await _expectTexture(
          tester, restored.image, restored.scale, _darkBackground);
      await _expectQuiet(tester, 2);
    });
  }

  // hidden 不渲染收起形状，主题刷新连续性只对 handle / edge 有意义。
  for (final FeedbackOrbIdleStyle style in <FeedbackOrbIdleStyle>[
    FeedbackOrbIdleStyle.handle,
    FeedbackOrbIdleStyle.edge,
  ]) {
    testWidgets(
        'theme refresh keeps the ${style.name} morph geometry continuous',
        (tester) async {
      await host.preferences
          .write(orbIdleStorageKey(host.appId), encodeOrbIdleStyle(style));
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
      await _waitLens(tester);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(milliseconds: 100));
      final Finder collapsed = find.byKey(const Key('feedback-orb-collapsed'));
      final Rect during = tester.getRect(collapsed);
      await _mountThemed(tester, host,
          configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
      expect(tester.getRect(collapsed), during,
          reason: 'theme invalidation cannot restart or snap the 420ms morph');
      await tester.pump(const Duration(milliseconds: 320));
      final OrbLiquidLensPainter refreshed = await _waitLens(tester);
      await _expectTexture(
          tester, refreshed.image, refreshed.scale, _darkBackground);
      expect(tester.getSize(collapsed), const Size(44, 56));
      await _expectQuiet(tester, 2);
    });
  }

  testWidgets('theme refresh is canceled on dispose without late resources',
      (tester) async {
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.light, hostTheme: ThemeMode.light);
    await _waitLens(tester);
    await _mountThemed(tester, host,
        configTheme: FeedbackThemeMode.dark, hostTheme: ThemeMode.dark);
    await tester.pumpWidget(const SizedBox.shrink());
    await _expectQuiet(tester, 1);
    expect(_shader, findsNothing);
  });

  for (final Brightness brightness in Brightness.values) {
    testWidgets(
        '${brightness.name} high contrast uses the safe system outline and retains focus',
        (tester) async {
      final FocusHighlightStrategy highlight =
          FocusManager.instance.highlightStrategy;
      FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.alwaysTraditional;
      addTearDown(() {
        FocusManager.instance.highlightStrategy = highlight;
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
      });
      host.theme = ThemeData(brightness: brightness);
      await host.mount(tester);
      final OrbLiquidLensPainter live = await _waitLens(tester);
      host.controller.setUnreadCount(3);
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(highContrast: true);
      await tester.pump();
      expect(_shader, findsNothing);
      final OrbLiquidOutlinePainter outline = tester
          .widgetList<CustomPaint>(find.descendant(
              of: liquidBody, matching: find.byType(CustomPaint)))
          .map((CustomPaint p) => p.painter)
          .whereType<OrbLiquidOutlinePainter>()
          .single;
      expect(outline.color,
          Theme.of(tester.element(liquidLens)).colorScheme.onSurface);
      liquidPaintState(tester);
      // v0.8.2：未读数不再绘制数字角标（F1），高对比度下也不出现。
      expect(find.byType(Badge), findsNothing);
      expect(find.text('3'), findsNothing);
      expect(find.byType(BackdropFilter), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(find.byKey(const Key('feedback-orb-focus-ring')), findsOneWidget);
      tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
      await tester.pump();
      expect((await _waitLens(tester)).image, isNot(same(live.image)));
      expect(debugOrbLensCaptureAttempts, 2,
          reason:
              'high contrast suspends invisible sampling and restores fresh glass');
      expect(tester.takeException(), isNull);
    });

    testWidgets(
        '${brightness.name} live glass and frozen selection pass the same actual theme',
        (tester) async {
      host.theme = ThemeData(brightness: brightness);
      await host.mount(tester);
      final OrbLiquidLensPainter live = await _waitLens(tester);
      expect(live.dark, brightness == Brightness.dark);
      final TestGesture pointer =
          await tester.startGesture(tester.getCenter(liquidOrb));
      await pointer.moveBy(const Offset(-120, -80));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      await pointer.up();
      await tester.pump();
      await pumpUntil(tester,
          () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
      final OrbLiquidLensPainter frozen = tester
          .widgetList<CustomPaint>(find.descendant(
              of: find.byType(CaptureSelectionOverlay),
              matching: find.byType(CustomPaint)))
          .map((CustomPaint paint) => paint.painter)
          .whereType<OrbLiquidLensPainter>()
          .single;
      expect(frozen.dark, live.dark);
      expect(frozen.image, isNot(same(live.image)));
      tester
          .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay))
          .onCancel();
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('every panel close restores one actual shader without drag',
      (tester) async {
    await host.mount(tester);
    OrbLiquidLensPainter previous = await _waitLens(tester);
    expect(debugOrbLensCaptureAttempts, 1);
    for (int i = 0; i < 3; i++) {
      host.controller.open();
      await tester.pump();
      await tester.pump();
      expect(_shader, findsNothing);
      host.controller.close();
      await tester.pump();
      final OrbLiquidLensPainter restored = await _waitLens(tester);
      expect(restored.image, isNot(same(previous.image)));
      expect(debugOrbLensCaptureAttempts, i + 2);
      previous = restored;
    }
    await _expectQuiet(tester, 4);
  });

  testWidgets(
      'handoff, edit and close restores shader and keeps the real draft',
      (tester) async {
    await host.mount(tester);
    await _waitLens(tester);
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    final String id = host.panel(tester).captureImageId!;
    await tester.enterText(find.byKey(const Key('feedback-input')), '保留交接草稿');
    host.controller.close();
    await tester.pump();
    await _waitLens(tester);
    expect(debugOrbLensCaptureAttempts, 2);
    host.controller.open();
    await tester.pump();
    expect(host.panel(tester).captureImageId, id);
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '保留交接草稿');
    expect(tester.takeException(), isNull);
  });

  testWidgets('selection cancel restores a fresh masked shader exactly once',
      (tester) async {
    host.content = const Stack(children: <Widget>[
      Positioned.fill(child: ColoredBox(color: Color(0xFF112233))),
      Positioned(
          left: 100,
          top: 100,
          width: 120,
          height: 80,
          child: FeedbackCaptureMask(
              maskColor: Color(0x106E6E73),
              child: ColoredBox(color: Colors.red))),
    ]);
    await host.mount(tester);
    final OrbLiquidLensPainter previous = await _waitLens(tester);
    await host.select(tester);
    expect(_shader, findsNothing);
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    final OrbLiquidLensPainter restored = await _waitLens(tester);
    expect(restored.image, isNot(same(previous.image)));
    expect(debugOrbLensCaptureAttempts, 2);
    final Uint8List? pixels = await tester.runAsync<Uint8List?>(
        () async => (await restored.image.toByteData())?.buffer.asUint8List());
    final int index = ((120 * restored.scale).floor() * restored.image.width +
            (120 * restored.scale).floor()) *
        4;
    expect(pixels!.sublist(index, index + 4), <int>[110, 110, 115, 255]);
    expect(pixels.sublist(0, 4), <int>[17, 34, 51, 255]);
    await _expectQuiet(tester, 2);
  });

  for (final bool cancelSelection in <bool>[false, true]) {
    testWidgets(
        'return while old lens capture awaits a frame replays once after ${cancelSelection ? 'selection cancel' : 'panel close'}',
        (tester) async {
      await host.mount(tester);
      await _waitLens(tester);
      final TestGesture pointer = await _holdOldCapture(tester);
      if (cancelSelection) {
        await pointer.up();
        host.controller.cancelCapture();
      } else {
        host.controller.open();
        host.controller.close();
        await pointer.cancel();
      }
      // The returning visibility prefetch runs in post-frame before the old
      // endOfFrame continuation clears its in-flight flag.
      await tester.pump();
      await _waitLens(tester);
      expect(find.byType(CaptureSelectionOverlay), findsNothing);
      expect(host.controller.isOpen, isFalse);
      await _expectQuiet(tester, 3);
    });
  }

  testWidgets(
      'scroll invalidates a queued return and captures the painted scroll scene',
      (tester) async {
    host.content =
        Builder(builder: (_) => const ColoredBox(color: Colors.blue));
    await host.mount(tester);
    await _waitLens(tester);
    final TestGesture pointer = await _holdOldCapture(tester);
    host.controller.open();
    host.controller.close();
    await pointer.cancel();
    host.content = Builder(builder: (BuildContext context) {
      // The host builds after the widget has queued its visibility prefetch.
      // This notification runs after that request is marked pending, but before
      // the old endOfFrame continuation can replay it.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ScrollUpdateNotification(
                metrics: FixedScrollMetrics(
                    minScrollExtent: 0,
                    maxScrollExtent: 100,
                    pixels: 10,
                    viewportDimension: 600,
                    axisDirection: AxisDirection.down,
                    devicePixelRatio: 2),
                context: context)
            .dispatch(context);
      });
      return const ColoredBox(color: Color(0xFF00FF00));
    });
    // The held old request uses a one-day gate for isolation. This scroll
    // scenario now exercises the actual bounded refresh deadline instead.
    debugOrbLensGateDuration = const Duration(milliseconds: 250);
    host.rebuild();
    await tester.pump();
    await tester.idle();
    final OrbLiquidLensPainter refreshed = await _waitLens(tester);
    final Uint8List? pixels = await tester.runAsync<Uint8List?>(
        () async => (await refreshed.image.toByteData())?.buffer.asUint8List());
    expect(pixels!.sublist(0, 4), <int>[0, 255, 0, 255]);
    expect(debugOrbLensCaptureAttempts, 3);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed replay does not automatically retry its generation',
      (tester) async {
    await host.mount(tester);
    await _waitLens(tester);
    final TestGesture pointer = await _holdOldCapture(tester);
    host.controller.open();
    host.controller.close();
    await pointer.cancel();
    debugFailOrbLensCapture = true;
    await tester.pump();
    await tester.idle();
    expect(_shader, findsNothing);
    await _expectQuiet(tester, 3);
    debugFailOrbLensCapture = false;
    host.rebuild();
    await tester.pump();
    await _expectQuiet(tester, 3);
    // A subsequent real visibility period is a fresh, explicit opportunity.
    host.controller.open();
    await tester.pump();
    host.controller.close();
    await tester.pump();
    await _waitLens(tester);
    await _expectQuiet(tester, 4);
  });

  testWidgets(
      'dispose after pending replay cannot publish late shader resources',
      (tester) async {
    await host.mount(tester);
    await _waitLens(tester);
    final TestGesture pointer = await _holdOldCapture(tester);
    host.controller.open();
    host.controller.close();
    await pointer.cancel();
    await tester.pump();
    await tester.idle();
    expect(debugOrbLensCaptureAttempts, 3);
    await tester.pumpWidget(const SizedBox.shrink());
    await _expectQuiet(tester, 3);
    expect(_shader, findsNothing);
  });
}
