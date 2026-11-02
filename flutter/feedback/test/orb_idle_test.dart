import 'dart:async';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb_idle.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:feedback_widget/src/wake_gestures.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

final Finder collapsed = find.byKey(const Key('feedback-orb-collapsed'));

class _GatedStore extends MemoryServerPrefStore {
  final Completer<String?> readGate = Completer<String?>();
  final List<Completer<void>> writes = <Completer<void>>[];
  final List<String> values = <String>[];
  bool gateReads = true;
  bool fail = false;
  @override
  Future<String?> read(String key) =>
      gateReads ? readGate.future : super.read(key);
  @override
  Future<void> write(String key, String value) async {
    values.add(value);
    final Completer<void> gate = Completer<void>();
    writes.add(gate);
    await gate.future;
    if (fail) throw StateError('local storage unavailable');
    await super.write(key, value);
  }
}

void main() {
  test(
      'idle codec is versioned, app isolated and independent of wake preferences',
      () {
    expect(
        orbIdleStorageKey('a/b 空'), 'feedback:orb-idle:v1:a%2Fb%20%E7%A9%BA');
    expect(orbIdleStorageKey('a'), isNot(orbIdleStorageKey('b')));
    expect(orbIdleStorageKey('a'), isNot(wakeGestureStorageKey('a')));
    for (final String? raw in <String?>[
      null,
      '',
      'edge',
      '{}',
      '{"version":0,"style":"edge"}',
      '{"version":1,"style":"unknown"}'
    ]) {
      expect(decodeOrbIdleStyle(raw), FeedbackOrbIdleStyle.handle);
    }
    for (final FeedbackOrbIdleStyle style in FeedbackOrbIdleStyle.values) {
      expect(decodeOrbIdleStyle(encodeOrbIdleStyle(style)), style);
    }
    // v0.8.2 第三种待机样式：hidden 可编解码；旧版本只写入 handle / edge，
    // 读取时都仍然有效（未知值已在上面断言回退 handle）。
    expect(encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden),
        '{"version":1,"style":"hidden"}');
    expect(decodeOrbIdleStyle(encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden)),
        FeedbackOrbIdleStyle.hidden);
  });

  test('new choice beats late read and writes finish in selection order',
      () async {
    final _GatedStore store = _GatedStore();
    final FeedbackOrbIdlePreferences prefs =
        FeedbackOrbIdlePreferences(appId: 'a', store: store);
    addTearDown(prefs.dispose);
    final Future<void> load = prefs.load();
    prefs.select(FeedbackOrbIdleStyle.edge);
    prefs.select(FeedbackOrbIdleStyle.handle);
    await Future<void>.delayed(Duration.zero);
    expect(
        store.values, <String>[encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge)]);
    store.readGate.complete(encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    await load;
    expect(prefs.style, FeedbackOrbIdleStyle.handle);
    store.writes[0].complete();
    await Future<void>.delayed(Duration.zero);
    expect(store.values.length, 2);
    store.writes[1].complete();
    await Future<void>.delayed(Duration.zero);
    store.gateReads = false;
    expect(await store.read(orbIdleStorageKey('a')),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.handle));
    expect(prefs.sessionOnly, isFalse);
  });

  test(
      'identity invalidates old reads and queued writes; failure keeps current choice',
      () async {
    final _GatedStore old = _GatedStore();
    final MemoryServerPrefStore next = MemoryServerPrefStore();
    await next.write(
        orbIdleStorageKey('b'), encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    final FeedbackOrbIdlePreferences prefs =
        FeedbackOrbIdlePreferences(appId: 'a', store: old);
    addTearDown(prefs.dispose);
    final Future<void> load = prefs.load();
    prefs.select(FeedbackOrbIdleStyle.edge);
    prefs.select(FeedbackOrbIdleStyle.handle);
    await Future<void>.delayed(Duration.zero);
    prefs.rebind(appId: 'b', store: next);
    await Future<void>.delayed(Duration.zero);
    old.readGate.complete(encodeOrbIdleStyle(FeedbackOrbIdleStyle.handle));
    old.writes.single.complete();
    await load;
    await Future<void>.delayed(Duration.zero);
    expect(prefs.style, FeedbackOrbIdleStyle.edge);
    expect(old.values.length, 1,
        reason: 'old queued write cannot run for a new identity');
    final _GatedStore failing = _GatedStore()
      ..gateReads = false
      ..fail = true;
    prefs.rebind(appId: 'b', store: failing);
    await Future<void>.delayed(Duration.zero);
    prefs.select(FeedbackOrbIdleStyle.edge);
    await Future<void>.delayed(Duration.zero);
    failing.writes.single.complete();
    await Future<void>.delayed(Duration.zero);
    expect(prefs.style, FeedbackOrbIdleStyle.edge);
    expect(prefs.sessionOnly, isTrue);
  });

  test(
      'returning A waits for its in-flight write; a different store does not wait',
      () async {
    final _GatedStore store = _GatedStore()..gateReads = false;
    final FeedbackOrbIdlePreferences prefs =
        FeedbackOrbIdlePreferences(appId: 'a', store: store);
    addTearDown(prefs.dispose);
    await prefs.load();
    prefs.select(FeedbackOrbIdleStyle.edge);
    await Future<void>.delayed(Duration.zero);
    expect(store.writes.length, 1);
    prefs.rebind(appId: 'b', store: store);
    prefs.rebind(appId: 'a', store: store);
    await Future<void>.delayed(Duration.zero);
    store.writes.single.complete();
    await Future<void>.delayed(Duration.zero);
    expect(prefs.style, FeedbackOrbIdleStyle.edge,
        reason:
            'current UI must agree with A after the earlier A write completes');

    prefs.select(FeedbackOrbIdleStyle.handle);
    await Future<void>.delayed(Duration.zero);
    final MemoryServerPrefStore other = MemoryServerPrefStore();
    await other.write(
        orbIdleStorageKey('a'), encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    prefs.rebind(appId: 'a', store: other);
    await Future<void>.delayed(Duration.zero);
    expect(prefs.style, FeedbackOrbIdleStyle.edge,
        reason:
            'same key in another backend must not wait for the old backend');
    prefs.select(FeedbackOrbIdleStyle.handle);
    await Future<void>.delayed(Duration.zero);
    expect(await other.read(orbIdleStorageKey('a')),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.handle));
    store.writes.last.complete();
    await Future<void>.delayed(Duration.zero);
  });

  late LiquidHarness host;
  setUp(() {
    host = LiquidHarness();
    debugDisableOrbLensCapture = true;
  });
  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
  });

  Future<void> idle(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
  }

  // hidden 没有收起几何形状（入口整体不渲染），五秒收起与命中区断言只覆盖
  // handle / edge；hidden 的入口显隐、controller.open() 与设置切换见文件末尾。
  for (final FeedbackOrbIdleStyle style in <FeedbackOrbIdleStyle>[
    FeedbackOrbIdleStyle.handle,
    FeedbackOrbIdleStyle.edge,
  ]) {
    for (final FeedbackSide side in FeedbackSide.values) {
      testWidgets(
          '${style.name} on ${side.name}: five seconds, exact target and wake without click-through',
          (tester) async {
        host.side = side;
        await host.preferences
            .write(orbIdleStorageKey(host.appId), encodeOrbIdleStyle(style));
        int hostTaps = 0;
        host.content = GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => hostTaps++,
            child: const SizedBox.expand());
        await host.mount(tester);
        final Rect original = tester.getRect(liquidOrb);
        expect(original.size, const Size(56, 56));
        expect(find.byIcon(Icons.chat_bubble_outline_rounded), findsNothing);
        await tester.pump(const Duration(milliseconds: 4999));
        expect(collapsed, findsNothing);
        await tester.pump(const Duration(milliseconds: 1));
        expect(collapsed, findsOneWidget);
        await tester.pump(const Duration(milliseconds: 420));
        final Rect target = tester.getRect(collapsed);
        expect(target.size, const Size(44, 56));
        expect(target.center.dy, original.center.dy);
        expect(side == FeedbackSide.left ? target.left : target.right,
            side == FeedbackSide.left ? 0 : 800);
        final Finder visual =
            find.byKey(Key('feedback-orb-idle-${style.name}'));
        final Rect visible = tester.getRect(visual).intersect(target);
        expect(
            visible.size,
            style == FeedbackOrbIdleStyle.handle
                ? const Size(12, 56)
                : const Size(28, 56));
        expect(liquidOrb, findsNothing, reason: 'no old orb hit box remains');
        await tester.tapAt(original.center);
        await tester.pump();
        expect(hostTaps, 1,
            reason: 'old orb location belongs to the host again');
        expect(collapsed, findsOneWidget);
        await tester.tap(collapsed);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 420));
        expect(hostTaps, 1);
        expect(host.controller.isOpen, isFalse);
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        expect(tester.getRect(liquidOrb), original);
        await tester.pump(const Duration(milliseconds: 4999));
        expect(liquidOrb, findsOneWidget);
        await tester.pump(const Duration(milliseconds: 1));
        expect(collapsed, findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }
  }

  testWidgets('enabling reduced motion mid-morph snaps to the complete capsule',
      (tester) async {
    await host.mount(tester);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final Finder face = find.byKey(const Key('feedback-orb-idle-handle'));
    expect(tester.getSize(face).width, greaterThan(12));
    host.reduced = true;
    host.rebuild();
    await tester.pump();
    expect(tester.getSize(face), const Size(12, 56));
    expect(tester.binding.transientCallbackCount, 0);
    await tester.tap(collapsed);
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    expect(tester.binding.transientCallbackCount, 0);
    expect(host.controller.isOpen, isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final FeedbackSide side in FeedbackSide.values) {
    testWidgets(
        'R11 ${side.name}: dark 10 by 48 handle keeps the 44 by 56 hit target and updates with theme',
        (tester) async {
      host.side = side;
      host.theme = ThemeData(brightness: Brightness.dark);
      await host.mount(tester);
      final Rect dock = tester.getRect(liquidOrb);
      await idle(tester);
      final Finder face = find.byKey(const Key('feedback-orb-idle-handle'));
      final Rect darkFace = tester.getRect(face);
      expect(darkFace.size, const Size(10, 48));
      expect(darkFace.center.dy, dock.center.dy);
      expect(
          side == FeedbackSide.left ? darkFace.left : 800 - darkFace.right, 10);
      expect(tester.getSize(collapsed), const Size(44, 56));
      host.theme = ThemeData(brightness: Brightness.light);
      await host.mount(tester);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.getSize(face), const Size(12, 56));
      expect(tester.getSize(collapsed), const Size(44, 56));
      host.theme = ThemeData(brightness: Brightness.dark);
      await host.mount(tester);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.getRect(face), darkFace);
      await tester.tapAt(darkFace.center);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 420));
      expect(tester.getRect(liquidOrb), dock);
      expect(host.controller.isOpen, isFalse,
          reason: 'the smaller visual still wakes without activating feedback');
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets(
      'R11 dark high contrast retains the original capsule and wake target',
      (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(highContrast: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    host.theme = ThemeData(brightness: Brightness.dark);
    await host.mount(tester);
    final Rect dock = tester.getRect(liquidOrb);
    await idle(tester);
    final Rect face =
        tester.getRect(find.byKey(const Key('feedback-orb-idle-handle')));
    expect(face.size, const Size(12, 56));
    expect(800 - face.right, 3);
    expect(face.center.dy, dock.center.dy);
    expect(tester.getSize(collapsed), const Size(44, 56));
    await tester.tapAt(face.center);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 420));
    expect(tester.getRect(liquidOrb), dock);
    expect(host.controller.isOpen, isFalse,
        reason: 'high contrast keeps the original wake-only interaction');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('press, drag, keyboard focus and hover suspend the timer',
      (tester) async {
    await host.mount(tester);
    final TestGesture press =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await tester.pump();
    await idle(tester);
    expect(liquidOrb, findsOneWidget);
    await press.moveBy(const Offset(-80, -30));
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    expect(find.byKey(const Key('feedback-orb-idle-clarity')), findsNothing);
    await press.cancel();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: tester.getCenter(liquidOrb));
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    await mouse.moveTo(const Offset(10, 10));
    await mouse.removePointer();
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
      'business hiding, background, page and app changes invalidate timers and restore a full orb',
      (tester) async {
    await host.mount(tester);
    await tester.pump(const Duration(seconds: 4));
    host.showLauncher = false;
    host.rebuild();
    await tester.pump();
    await idle(tester);
    expect(liquidOrb, findsNothing);
    expect(collapsed, findsNothing);
    host.showLauncher = true;
    host.rebuild();
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    host.launcherMode = FeedbackLauncherMode.tab;
    host.rebuild();
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    host.launcherMode = FeedbackLauncherMode.orb;
    host.rebuild();
    await tester.pump();
    host.controller.open();
    await tester.pump();
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    await idle(tester);
    expect(collapsed, findsNothing);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    host.pageLabel = 'other';
    host.rebuild();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(collapsed, findsNothing);
    host.appId = 'another';
    host.rebuild();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 4));
    expect(collapsed, findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    await idle(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'reduced motion and Tab wake are immediate; Enter remains a separate activation',
      (tester) async {
    host.reduced = true;
    await host.mount(tester);
    await tester.pump(const Duration(seconds: 5));
    expect(collapsed, findsOneWidget);
    expect(tester.binding.transientCallbackCount, 0);
    final SemanticsHandle semantics = tester.ensureSemantics();
    expect(find.bySemanticsLabel('唤醒灵感球'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.pump();
    expect(liquidOrb, findsOneWidget);
    expect(host.controller.isOpen, isFalse);
    await idle(tester);
    expect(collapsed, findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
    semantics.dispose();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Tab keeps focus and its ring throughout the 420ms glass wake',
      (tester) async {
    final FocusHighlightStrategy previous =
        FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
    addTearDown(() => FocusManager.instance.highlightStrategy = previous);
    await host.mount(tester);
    await idle(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(collapsed, findsOneWidget);
    await tester.pump(const Duration(milliseconds: 210));
    expect(collapsed, findsOneWidget);
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsOneWidget);
    expect(host.controller.isOpen, isFalse);
    await tester.pump(const Duration(milliseconds: 210));
    expect(liquidOrb, findsOneWidget);
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsOneWidget);
    await idle(tester);
    expect(collapsed, findsNothing, reason: 'keyboard focus suspends idle');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final FeedbackWakeGesture type in FeedbackWakeGesture.values) {
    testWidgets('${type.id} only wakes at dock, retaining draft and attachment',
        (tester) async {
      host.reduced = true;
      host.captureMode = FeedbackCaptureMode.viewport;
      await host.preferences.write(wakeGestureStorageKey(host.appId),
          encodeWakeGestures(<FeedbackWakeGesture>{type}));
      await host.mount(tester);
      final FeedbackPanelState panel =
          await captureAndWait(tester, host.controller);
      await tester.enterText(find.byKey(const Key('feedback-input')), '保留草稿');
      final Object bytes = panel.screenshotBytes!;
      final String id = panel.captureImageId!;
      host.controller.close();
      await tester.pump();
      await tester.pump();
      final Rect dock = tester.getRect(liquidOrb);
      await idle(tester);
      expect(collapsed, findsOneWidget);
      Future<List<TestGesture>> down(int count) async {
        final List<TestGesture> fingers = <TestGesture>[];
        for (int i = 0; i < count; i++) {
          fingers.add(await tester.startGesture(Offset(160.0 + i * 60, 300)));
        }
        return fingers;
      }

      Future<void> up(List<TestGesture> fingers) async {
        for (final TestGesture finger in fingers) {
          await finger.up();
        }
      }

      final List<TestGesture> fingers =
          await down(type == FeedbackWakeGesture.threeFingerSwipeUp ? 3 : 2);
      switch (type) {
        case FeedbackWakeGesture.twoFingerHold:
          await tester.pump(const Duration(milliseconds: 700));
        case FeedbackWakeGesture.threeFingerSwipeUp:
          for (final TestGesture finger in fingers) {
            await finger.moveBy(const Offset(0, -72));
          }
        case FeedbackWakeGesture.twoFingerDoubleTap:
          await up(fingers);
          await tester.pump(const Duration(milliseconds: 100));
          final List<TestGesture> second = await down(2);
          await second.first.up();
          expect(collapsed, findsOneWidget);
          await second.last.up();
      }
      if (type != FeedbackWakeGesture.twoFingerDoubleTap) {
        expect(collapsed, findsOneWidget,
            reason: 'wait for every finger to lift');
        await fingers.first.up();
        expect(collapsed, findsOneWidget);
        await up(fingers.skip(1).toList());
      }
      await tester.pump();
      expect(collapsed, findsNothing);
      expect(tester.getRect(liquidOrb), dock);
      expect(host.controller.isOpen, isFalse);
      expect(find.byType(CaptureSelectionOverlay), findsNothing);
      expect(panel.screenshotBytes, same(bytes));
      expect(panel.captureImageId, id);
      host.controller.open();
      await tester.pump();
      await tester.pump();
      expect(
          tester
              .widget<TextField>(find.byKey(const Key('feedback-input')))
              .controller!
              .text,
          '保留草稿');
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets(
      'settings persist idle independently and root restores before panel mounts',
      (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    final String wake = encodeWakeGestures(
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    await host.preferences.write(wakeGestureStorageKey(host.appId), wake);
    await host.mount(tester);
    await idle(tester);
    expect(find.byKey(const Key('feedback-orb-idle-edge')), findsOneWidget);
    host.controller.open();
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-settings')));
    await tester.pump();
    final Finder option = find.byKey(const Key('feedback-orb-idle-handle'));
    await tester.ensureVisible(option);
    await tester.tap(option);
    await tester.pump();
    expect(await host.preferences.read(orbIdleStorageKey(host.appId)),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.handle));
    expect(
        await host.preferences.read(wakeGestureStorageKey(host.appId)), wake);
    host.controller.close();
    await tester.pumpWidget(const SizedBox.shrink());
    await host.mount(tester);
    await idle(tester);
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
      'hidden renders no launcher slot, persists, and host open() still opens the panel',
      (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden));
    await host.mount(tester);
    await idle(tester);
    expect(liquidOrb, findsNothing, reason: '完整球入口不渲染');
    expect(collapsed, findsNothing, reason: '收起把手也不渲染');
    expect(find.byKey(const Key('feedback-launcher-slot')), findsNothing);
    expect(await host.preferences.read(orbIdleStorageKey(host.appId)),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden),
        reason: '读取偏好不得回写默认值');

    host.controller.open();
    await tester.pump();
    await tester.pump();
    expect(host.controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '隐藏入口后仍可由宿主 controller.open() 打开面板');
    expect(find.byKey(const Key('feedback-close')), findsOneWidget);

    await tester.tap(find.byKey(const Key('feedback-settings')));
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-idle-hidden')), findsOneWidget);
    expect(find.text('隐藏'), findsOneWidget);
    final Finder handle = find.byKey(const Key('feedback-orb-idle-handle'));
    await tester.ensureVisible(handle);
    await tester.tap(handle);
    await tester.pump();
    expect(await host.preferences.read(orbIdleStorageKey(host.appId)),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.handle));

    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(liquidOrb, findsOneWidget, reason: '改回小把手后入口立即恢复');
    await idle(tester);
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget,
        reason: '恢复后重新开始闲置计时');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
      'choosing hidden in settings removes the entry immediately and survives remount',
      (tester) async {
    await host.mount(tester);
    await idle(tester);
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget,
        reason: '默认小把手在闲置后收起');
    host.controller.open();
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-settings')));
    await tester.pump();
    final Finder hidden = find.byKey(const Key('feedback-orb-idle-hidden'));
    await tester.ensureVisible(hidden);
    await tester.tap(hidden);
    await tester.pump();
    expect(await host.preferences.read(orbIdleStorageKey(host.appId)),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden));

    host.controller.close();
    await tester.pump();
    await tester.pump();
    expect(liquidOrb, findsNothing);
    expect(collapsed, findsNothing);
    await idle(tester);
    expect(collapsed, findsNothing, reason: '隐藏样式不得重新出现收起把手');

    // 持久化：重新挂载后仍是隐藏，且宿主仍可 open()。
    await tester.pumpWidget(const SizedBox.shrink());
    await host.mount(tester);
    await idle(tester);
    expect(find.byKey(const Key('feedback-launcher-slot')), findsNothing);
    host.controller.open();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
      'hidden only hides the inspiration orb entry; tab-mode FAB keeps working',
      (tester) async {
    // 「隐藏」是灵感球待机样式：tab 模式的悬浮按钮不属于灵感球，不能被该偏好
    // 一起隐藏（与 Web 端 canUseOrbLauncher 只影响 orb 入口的语义一致）。
    host.launcherMode = FeedbackLauncherMode.tab;
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.hidden));
    await host.mount(tester);
    await idle(tester);
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget,
        reason: 'tab 模式入口由宿主配置决定，不受灵感球隐藏偏好影响');
    expect(find.byKey(const Key('feedback-launcher-slot')), findsOneWidget);
    expect(liquidOrb, findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
