import 'dart:async';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:feedback_widget/src/wake_gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'capture_test_utils.dart';
import 'panel_harness.dart';

class _WakeHost {
  final GlobalKey key = GlobalKey();
  final ValueNotifier<int> revision = ValueNotifier<int>(0);
  FeedbackController controller = FeedbackController();
  final List<FeedbackController> previousControllers = <FeedbackController>[];
  http.Client client = captureMockClient();
  FeedbackServerPrefStore prefs = MemoryServerPrefStore();
  String appId = 'com.example.wake';
  String apiBase = 'https://svc.test';
  String? pageLabel;
  FeedbackCaptureMode captureMode = FeedbackCaptureMode.viewport;
  EdgeInsets padding = EdgeInsets.zero;
  double dpr = 1;
  Widget child = const SizedBox.expand(child: ColoredBox(color: Colors.blue));
  bool scopedHalf = false;

  Future<void> enable(Set<FeedbackWakeGesture> gestures) =>
      prefs.write(wakeGestureStorageKey(appId), encodeWakeGestures(gestures));
  void rebuild() => revision.value++;
  Future<void> mount(WidgetTester tester,
      {Size size = const Size(800, 600)}) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
        home: ValueListenableBuilder<int>(
      valueListenable: revision,
      builder: (BuildContext context, int _, Widget? child) {
        final Widget feedback = FeedbackWidget(
          key: key,
          config: FeedbackConfig(apiBase, appId,
              pageLabel: pageLabel,
              captureMode: captureMode,
              launcherMode: FeedbackLauncherMode.orb),
          controller: controller,
          tokenStore: MemoryTokenStore('tok'),
          serverPrefStore: prefs,
          httpClient: client,
          child: this.child,
        );
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(devicePixelRatio: dpr),
          child: Padding(
              padding: padding,
              child: scopedHalf
                  ? Row(children: <Widget>[
                      Expanded(child: feedback),
                      const Expanded(child: ColoredBox(color: Colors.red))
                    ])
                  : feedback),
        );
      },
    )));
    await tester.pump();
  }

  Future<void> settings(WidgetTester tester) async {
    controller.open();
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-settings')));
    await tester.pump();
  }

  FeedbackPanelState panel(WidgetTester tester) =>
      tester.state<FeedbackPanelState>(
          find.byType(FeedbackPanel, skipOffstage: false));
  Future<CaptureSelectionOverlay> selection(WidgetTester tester) async {
    // R5: a gesture only wakes; capture requires a separate, explicit orb drag.
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(controller.isOpen, isFalse);
    expect(find.byKey(const Key('feedback-orb-collapsed')), findsNothing);
    final Finder orb = find.byKey(const Key('feedback-orb'));
    expect(orb, findsOneWidget);
    final TestGesture drag = await tester.startGesture(tester.getCenter(orb));
    await drag.moveBy(const Offset(-110, -80));
    await tester.pump(const Duration(milliseconds: 16));
    await drag.up();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
    return tester
        .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay));
  }

  void dispose() {
    revision.dispose();
    controller.dispose();
    for (final FeedbackController controller in previousControllers) {
      controller.dispose();
    }
    client.close();
  }
}

Future<List<TestGesture>> _down(WidgetTester tester, int count,
    {Offset origin = const Offset(160, 300)}) async {
  final List<TestGesture> fingers = <TestGesture>[];
  for (int i = 0; i < count; i++) {
    fingers.add(await tester.startGesture(origin + Offset(i * 60, 0)));
  }
  return fingers;
}

Future<void> _up(List<TestGesture> fingers) async {
  for (final TestGesture finger in fingers) {
    await finger.up();
  }
}

Future<void> _hold(WidgetTester tester) async {
  final List<TestGesture> fingers = await _down(tester, 2);
  await tester.pump(const Duration(milliseconds: 700));
  await _up(fingers);
}

class _ReadGateStore extends MemoryServerPrefStore {
  final Completer<String?> readGate = Completer<String?>();
  @override
  Future<String?> read(String key) => key.startsWith('feedback:wake-gestures:')
      ? readGate.future
      : super.read(key);
}

class _FailingStore extends MemoryServerPrefStore {
  @override
  Future<String?> read(String key) async {
    if (key.startsWith('feedback:wake-gestures:')) {
      throw StateError('read failed');
    }
    return super.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    if (key.startsWith('feedback:wake-gestures:')) {
      throw StateError('write failed');
    }
    return super.write(key, value);
  }
}

void main() {
  late _WakeHost host;
  setUp(() {
    host = _WakeHost();
    debugDisableOrbLensCapture = true;
  });
  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
  });

  for (final FeedbackWakeGesture gesture in FeedbackWakeGesture.values) {
    testWidgets(
        '${gesture.id} restores at root before first panel, then selects and delivers real attachment',
        (tester) async {
      await host.enable(<FeedbackWakeGesture>{gesture});
      host.padding = const EdgeInsets.fromLTRB(80, 60, 120, 40);
      // Mask encloses the entire host. Neither the hint nor unmasked pixels may
      // appear in the frozen image delivered after confirmation.
      host.child = const FeedbackCaptureMask(
        maskColor: Color(0xFF36A164),
        child: SizedBox.expand(child: ColoredBox(color: Colors.red)),
      );
      await host.mount(tester);
      expect(find.byType(FeedbackPanel, skipOffstage: false), findsNothing);
      if (gesture == FeedbackWakeGesture.twoFingerHold) {
        final List<TestGesture> fingers = await _down(tester, 2);
        await tester.pump(const Duration(milliseconds: 700));
        expect(find.byKey(const Key('feedback-wake-release-hint')),
            findsOneWidget);
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        await fingers[0].up();
        await tester.pump();
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        await fingers[1].up();
      } else if (gesture == FeedbackWakeGesture.threeFingerSwipeUp) {
        final List<TestGesture> fingers = await _down(tester, 3);
        for (final TestGesture finger in fingers) {
          await finger.moveBy(const Offset(0, -80));
        }
        await tester.pump();
        expect(find.byKey(const Key('feedback-wake-release-hint')),
            findsOneWidget);
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        await _up(fingers);
      } else {
        await _up(await _down(tester, 2));
        await tester.pump(const Duration(milliseconds: 100));
        await _up(await _down(tester, 2));
      }
      await tester.pump();
      final CaptureSelectionOverlay overlay = await host.selection(tester);
      expect(host.controller.isOpen, isFalse);
      expect(overlay.orbCenter, isNotNull,
          reason: 'only the subsequent explicit drag creates an orb snapshot');
      expect(overlay.releasePoint, isNotNull);
      expect(find.byKey(const Key('feedback-wake-release-hint')), findsNothing);
      await tester.pump(const Duration(milliseconds: 566));
      final CaptureSelectionOverlayState selection =
          tester.state(find.byType(CaptureSelectionOverlay));
      expect(selection.selection.size, const Size(144, 144));
      final Rect expected = initialCaptureSelection(
          viewport: overlay.viewport,
          center: overlay.orbCenter!,
          safeInsets: overlay.safeInsets);
      expect(selection.selection, expected);
      overlay.onUseRegion(selection.selection);
      overlay.onUseRegion(selection.selection);
      await pumpUntil(
          tester,
          () =>
              host.controller.isOpen &&
              find.byType(FeedbackPanel).evaluate().isNotEmpty &&
              host.panel(tester).hasScreenshot);
      await tester.pump();
      await tester.pump();
      expect(host.panel(tester).imageCount, 1);
      expect(
          host.panel(tester).captureInfo!.releasePoint, overlay.releasePoint);
      expect(host.panel(tester).captureInfo!.region, isNotNull);
      final FeedbackCaptureInfo info = host.panel(tester).captureInfo!;
      final int pixelWidth =
          selection.selection.right.ceil() - selection.selection.left.floor();
      final int pixelHeight =
          selection.selection.bottom.ceil() - selection.selection.top.floor();
      expect(info.pixelWidth, pixelWidth);
      expect(info.pixelHeight, pixelHeight);
      expect(
          info.region!.toJson(),
          normalizeCaptureRegion(selection.selection, overlay.viewport)
              .toJson());
      final DecodedPng pixels =
          await decodePng(host.panel(tester).screenshotBytes!, tester);
      expect(pixels.width, pixelWidth);
      expect(pixels.height, pixelHeight);
      expect(pixels.pixelAt(pixels.width ~/ 2, pixels.height ~/ 2),
          <int>[54, 161, 100, 255]);
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      expect(host.panel(tester).draftFocused, isTrue);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'settings select multiple gestures immediately and independently of server save, persist and reload',
      (tester) async {
    await host.mount(tester, size: const Size(320, 780));
    await host.settings(tester);
    expect(find.byTooltip('设置'), findsOneWidget);
    expect(find.text('唤醒方式'), findsOneWidget);
    expect(find.text('可同时开启，仅在当前应用内生效；悬浮入口仍可使用。'), findsOneWidget);
    for (final FeedbackWakeGesture gesture in FeedbackWakeGesture.values) {
      final Finder row = find.byKey(Key('feedback-wake-${gesture.id}'));
      await tester.ensureVisible(row);
      expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
      await tester.tap(row);
      await tester.pump();
      expect(tester.widget<CheckboxListTile>(row).value, isTrue);
    }
    await tester.pump();
    expect(
        decodeWakeGestures(
            await host.prefs.read(wakeGestureStorageKey(host.appId))),
        FeedbackWakeGesture.values.toSet());
    expect(
        await host.prefs.read(serverOverrideStorageKey(
            appId: host.appId, defaultApiBase: host.apiBase)),
        isNull);
    host.controller.close();
    await tester.pump();
    await _hold(tester);
    await tester.pump();
    await host.selection(tester);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await host.mount(tester, size: const Size(320, 780));
    await _hold(tester);
    await tester.pump();
    await host.selection(tester);
    expect(tester.takeException(), isNull);
  });

  for (final bool fullWindow in <bool>[false, true]) {
    testWidgets(
        'confirmed drag after wake ${fullWindow ? 'window' : 'region'} leaves closed settings for compose and preserves the draft',
        (tester) async {
      await host.mount(tester);
      final FeedbackPanelState panel =
          await captureAndWait(tester, host.controller);
      final Object original = panel.screenshotBytes!;
      final String captureId = panel.captureImageId!;
      await tester.enterText(find.byKey(const Key('feedback-input')), '设置前的草稿');
      await host.settings(tester);
      for (final FeedbackWakeGesture gesture in FeedbackWakeGesture.values) {
        final Finder row = find.byKey(Key('feedback-wake-${gesture.id}'));
        await tester.ensureVisible(row);
        await tester.tap(row);
        await tester.pump();
        expect(tester.widget<CheckboxListTile>(row).value, isTrue);
      }
      await tester.tap(find.byKey(const Key('feedback-close')));
      await tester.pump();
      expect(host.controller.isOpen, isFalse);
      expect(panel.settingsOpen, isTrue);
      await _hold(tester);
      await tester.pump();
      await host.selection(tester);
      await tester.pump(const Duration(milliseconds: 566));
      expect(panel.settingsOpen, isTrue,
          reason: 'capture and an unconfirmed selection must not navigate');
      expect(panel.screenshotBytes, same(original));
      await tester.tap(find.byKey(Key(fullWindow
          ? 'feedback-capture-whole-window'
          : 'feedback-capture-use-region')));
      await pumpUntil(tester,
          () => host.controller.isOpen && panel.screenshotBytes != original);
      await tester.pump();
      await tester.pump();
      expect(panel.settingsOpen, isFalse);
      expect(panel.draftFocused, isFalse,
          reason: 'focus waits for the confirmed handoff to finish');
      expect(find.byKey(const Key('feedback-input')), findsOneWidget);
      expect(
          find.byKey(const Key('feedback-screenshot-thumb')), findsOneWidget);
      expect(panel.captureThumbnailRect, isNotNull);
      expect(panel.captureInfo!.region, fullWindow ? isNull : isNotNull);
      expect(panel.captureImageId, captureId);
      expect(panel.imageCount, 1);
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      final Finder input = find.byKey(const Key('feedback-input'));
      expect(input.hitTestable(), findsOneWidget);
      expect(find.byKey(const Key('feedback-screenshot-thumb')).hitTestable(),
          findsOneWidget);
      expect(tester.widget<TextField>(input).controller!.text, '设置前的草稿');
      expect(panel.draftFocused, isTrue);
      final TextButton compose =
          tester.widget(find.byKey(const Key('tab-compose')));
      expect(compose.style!.textStyle!.resolve(<WidgetState>{})!.fontWeight,
          FontWeight.w600);
      expect(tester.takeException(), isNull);
    });
  }

  for (final bool detail in <bool>[false, true]) {
    testWidgets(
        'confirmed drag after wake from ${detail ? 'dialogue' : 'history'} composes while cancellation preserves the page and reply draft',
        (tester) async {
      final PanelServer server = PanelServer();
      final Map<String, Object?> item = <String, Object?>{
        'id': 'previous',
        'appId': host.appId,
        'title': '之前的反馈',
        'text': '原来的说明',
        'status': 'archived',
        'issueStatus': 'open',
        'createdAt': '2026-11-01T01:00:00Z',
        'lastActivityAt': '2026-11-01T01:00:00Z',
        'messageCount': 0,
        'unread': false,
      };
      server.respond('GET /api/auth/session', <String, Object?>{
        ...sessionJson(quotaJson()),
        'capabilities': <String, Object?>{'dialogue': true, 'images': 5},
      });
      server.respond('GET /api/feedback/unread-summary', <String, Object?>{
        'unreadFeedbacksCount': 0,
        'totalUnreadMessages': 0,
      });
      server.respond('GET /api/feedback/mine', <String, Object?>{
        'items': <Object?>[item],
        'total': 1,
        'page': 1,
        'limit': 10,
        'unreadTotal': 0,
      });
      server.respond('GET /api/feedback/previous/dialogue', <String, Object?>{
        'feedback': <String, Object?>{
          ...item,
          'updatedAt': '2026-11-01T01:00:00Z',
          'mgmtState': 'inbox',
        },
        'messages': <Object?>[],
        'lastReadSeq': 0,
      });
      host.client.close();
      host.client = server.client;
      await host
          .enable(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
      await host.mount(tester);
      final FeedbackPanelState panel =
          await captureAndWait(tester, host.controller);
      final Object original = panel.screenshotBytes!;
      final String captureId = panel.captureImageId!;
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('feedback-input')), '保留新建草稿');
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pumpAndSettle();
      if (detail) {
        await tester.tap(find.byKey(const Key('feedback-item-previous')));
        await tester.pumpAndSettle();
        await tester
            .ensureVisible(find.byKey(const Key('feedback-reply-input')));
        await tester.enterText(
            find.byKey(const Key('feedback-reply-input')), '保留回复草稿');
      }
      await tester.tap(find.byKey(const Key('feedback-close')));
      await tester.pump();
      await _hold(tester);
      await tester.pump();
      final CaptureSelectionOverlay overlay = await host.selection(tester);
      expect(panel.screenshotBytes, same(original));
      overlay.onCancel();
      await tester.pump();
      host.controller.open();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-input')), findsNothing);
      expect(panel.screenshotBytes, same(original));
      if (detail) {
        expect(
            tester
                .widget<TextField>(
                    find.byKey(const Key('feedback-reply-input')))
                .controller!
                .text,
            '保留回复草稿');
      } else {
        expect(find.byKey(const Key('feedback-item-previous')), findsOneWidget);
      }
      await tester.tap(find.byKey(const Key('feedback-close')));
      await tester.pump();
      await _hold(tester);
      await tester.pump();
      await host.selection(tester);
      await tester.pump(const Duration(milliseconds: 566));
      await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
      await pumpUntil(tester,
          () => host.controller.isOpen && panel.screenshotBytes != original);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('feedback-input')), findsOneWidget);
      expect(panel.settingsOpen, isFalse);
      expect(panel.captureThumbnailRect, isNotNull);
      expect(panel.captureImageId, captureId);
      expect(panel.imageCount, 1);
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      final Finder input = find.byKey(const Key('feedback-input'));
      expect(input.hitTestable(), findsOneWidget);
      expect(tester.widget<TextField>(input).controller!.text, '保留新建草稿');
      expect(find.byKey(const Key('feedback-screenshot-thumb')).hitTestable(),
          findsOneWidget);
      expect(panel.draftFocused, isTrue);
      if (detail) {
        await tester.tap(find.byKey(const Key('tab-history')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('feedback-item-previous')));
        await tester.pumpAndSettle();
        expect(
            tester
                .widget<TextField>(
                    find.byKey(const Key('feedback-reply-input')))
                .controller!
                .text,
            '保留回复草稿');
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'capture-off settings are disabled and stored choices never override host authorization',
      (tester) async {
    await host.enable(FeedbackWakeGesture.values.toSet());
    host.captureMode = FeedbackCaptureMode.off;
    await host.mount(tester);
    await _hold(tester);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    await host.settings(tester);
    expect(find.text('应用未开启截图，手势暂不可用'), findsOneWidget);
    for (final FeedbackWakeGesture gesture in FeedbackWakeGesture.values) {
      final CheckboxListTile row =
          tester.widget(find.byKey(Key('feedback-wake-${gesture.id}')));
      expect(row.onChanged, isNull);
    }
  });

  testWidgets(
      'late root preference read cannot overwrite user choice; failures show session-only',
      (tester) async {
    final _ReadGateStore store = _ReadGateStore();
    host.prefs = store;
    await host.mount(tester);
    await host.settings(tester);
    final Finder hold = find.byKey(const Key('feedback-wake-two-finger-hold'));
    await tester.ensureVisible(hold);
    await tester.tap(hold);
    await tester.pump();
    store.readGate.complete(encodeWakeGestures(
        <FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp}));
    await tester.pump();
    expect(tester.widget<CheckboxListTile>(hold).value, isTrue);
    expect(
        tester
            .widget<CheckboxListTile>(
                find.byKey(const Key('feedback-wake-three-finger-swipe-up')))
            .value,
        isFalse);
    host.prefs = _FailingStore();
    host.rebuild();
    await tester.pump();
    await tester.pump();
    await tester.ensureVisible(hold);
    await tester.tap(hold);
    await tester.pump();
    expect(find.text('仅本次生效'), findsOneWidget);
    expect(tester.widget<CheckboxListTile>(hold).value, isTrue);
    host.controller.close();
    await tester.pump();
    await _hold(tester);
    await tester.pump();
    await host.selection(tester);
  });

  testWidgets(
      'server address changes preserve gesture preferences, app changes restore another key',
      (tester) async {
    await host.enable(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    await host.mount(tester);
    host.apiBase = 'https://different.test';
    host.rebuild();
    await tester.pump();
    await _hold(tester);
    await tester.pump();
    await host.selection(tester);
    host.controller.cancelCapture();
    await tester.pump();
    host.appId = 'com.example.other';
    host.rebuild();
    await tester.pump();
    await tester.pump();
    await _hold(tester);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    host.appId = 'com.example.wake';
    host.rebuild();
    await tester.pump();
    await tester.pump();
    await _hold(tester);
    await tester.pump();
    await host.selection(tester);
  });

  for (final String change in <String>[
    'app',
    'page',
    'controller',
    'viewport',
    'dpr',
    'capture-off',
    'panel',
    'background',
    'dispose'
  ]) {
    testWidgets(
        'latched wake is canceled by root $change change and never delivers late',
        (tester) async {
      await host
          .enable(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
      await host.mount(tester);
      final List<TestGesture> fingers = await _down(tester, 2);
      await tester.pump(const Duration(milliseconds: 700));
      expect(
          find.byKey(const Key('feedback-wake-release-hint')), findsOneWidget);
      switch (change) {
        case 'app':
          host.appId = 'other';
          host.rebuild();
        case 'page':
          host.pageLabel = 'other';
          host.rebuild();
        case 'controller':
          host.previousControllers.add(host.controller);
          host.controller = FeedbackController();
          host.rebuild();
        case 'viewport':
          host.padding = const EdgeInsets.all(12);
          host.rebuild();
        case 'dpr':
          host.dpr = 2;
          host.rebuild();
        case 'capture-off':
          host.captureMode = FeedbackCaptureMode.off;
          host.rebuild();
        case 'panel':
          host.controller.open();
        case 'background':
          tester.binding
              .handleAppLifecycleStateChanged(AppLifecycleState.paused);
        case 'dispose':
          await tester.pumpWidget(const SizedBox.shrink());
      }
      await tester.pump();
      await _up(fingers);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(CaptureSelectionOverlay), findsNothing);
      if (change == 'background') {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();
      }
      expect(find.byKey(const Key('feedback-wake-release-hint')), findsNothing);
      if (find
          .byType(FeedbackPanel, skipOffstage: false)
          .evaluate()
          .isNotEmpty) {
        expect(host.panel(tester).hasScreenshot, isFalse);
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'local recognizer cannot see other half of view or Feedback internal UI',
      (tester) async {
    await host.enable(FeedbackWakeGesture.values.toSet());
    host.scopedHalf = true;
    await host.mount(tester);
    final List<TestGesture> outside =
        await _down(tester, 2, origin: const Offset(520, 300));
    await tester.pump(const Duration(milliseconds: 750));
    await _up(outside);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    await host.settings(tester);
    final List<TestGesture> panel = await _down(tester, 2);
    await tester.pump(const Duration(milliseconds: 750));
    await _up(panel);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(find.byKey(const Key('feedback-wake-release-hint')), findsNothing);
  });

  for (final bool settings in <bool>[false, true]) {
    testWidgets(
        'cancel drag after wake preserves ${settings ? 'settings' : 'compose'}, existing draft and attachment',
        (tester) async {
      await host
          .enable(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
      await host.mount(tester);
      await captureAndWait(tester, host.controller);
      final FeedbackPanelState panel = host.panel(tester);
      final List<int> original = List<int>.of(panel.screenshotBytes!);
      await tester.enterText(find.byKey(const Key('feedback-input')), '保留草稿');
      if (settings) await host.settings(tester);
      host.controller.close();
      await tester.pump();
      await _hold(tester);
      await tester.pump();
      final CaptureSelectionOverlay overlay = await host.selection(tester);
      overlay.onCancel();
      await tester.pump();
      host.controller.open();
      await tester.pump();
      await tester.pump();
      expect(panel.settingsOpen, settings);
      expect(panel.screenshotBytes, original);
      expect(panel.imageCount, 1);
      if (settings) {
        expect(find.byKey(const Key('feedback-input')), findsNothing);
        final Finder back = find.byKey(const Key('feedback-settings-back'));
        await tester.ensureVisible(back);
        await tester.tap(back);
        await tester.pump();
      }
      expect(
          tester
              .widget<TextField>(find.byKey(const Key('feedback-input')))
              .controller!
              .text,
          '保留草稿');
      expect(panel.screenshotBytes, original);
      expect(panel.imageCount, 1);
    });
  }
}
