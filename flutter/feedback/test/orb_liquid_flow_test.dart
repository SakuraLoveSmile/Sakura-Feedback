import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'capture_test_utils.dart';
import 'orb_liquid_test_utils.dart';

void main() {
  late LiquidHarness host;
  setUp(() {
    host = LiquidHarness();
    debugDisableOrbLensCapture = true;
  });
  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
  });

  testWidgets('full-height narrow frame keeps every corner hit target usable',
      (tester) async {
    host.theme = ThemeData.light().copyWith(platform: TargetPlatform.android);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await host.mount(tester, size: const Size(390, 844));
    await host.select(tester);
    final CaptureSelectionOverlayState state =
        tester.state(find.byType(CaptureSelectionOverlay));
    Future<void> reframe() async {
      // Start away from any old corner so this is a new frame gesture.
      await tester.dragFrom(const Offset(16, 100), const Offset(54, 54));
      await tester.pump();
      await tester.dragFrom(const Offset(123, 0), const Offset(144, 844));
      await tester.pump();
      expect(state.selection, const Rect.fromLTWH(123, 0, 144, 844));
    }

    await reframe();
    for (final String suffix in <String>['0-0', '2-0', '0-2', '2-2']) {
      final Rect tools =
          tester.getRect(find.byKey(const Key('feedback-capture-tools')));
      final Rect handle =
          tester.getRect(find.byKey(Key('feedback-capture-handle-$suffix')));
      expect(tools.overlaps(handle), isFalse,
          reason: 'tool card must not steal a corner gesture');
    }
    expect(
        tester.getRect(find.byKey(const Key('feedback-capture-tools'))).width,
        320);
    for (final String suffix in <String>['0-0', '2-0', '0-2', '2-2']) {
      final Rect before = state.selection;
      final Offset corner =
          tester.getCenter(find.byKey(Key('feedback-capture-handle-$suffix')));
      final Offset point = Offset(corner.dx, corner.dy.clamp(8, 836));
      await tester.dragFrom(
          point,
          Offset(suffix.startsWith('0') ? 24 : -24,
              suffix.endsWith('0') ? 32 : -32));
      await tester.pump();
      expect(state.selection, isNot(before),
          reason: 'real corner drag must resize the frame');
      await reframe();
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'non-origin boundary keeps visible orb center separate from actual release metadata',
      (tester) async {
    host.padding = const EdgeInsets.fromLTRB(80, 60, 120, 40);
    await host.mount(tester);
    final Offset start = tester.getCenter(liquidOrb) + const Offset(6, -4);
    const Offset delta = Offset(-180, -100);
    const Offset finalDelta = Offset(-100, -40);
    final TestGesture finger = await tester.startGesture(start);
    await finger.moveBy(delta);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await finger.moveBy(finalDelta);
    await tester.pump(const Duration(milliseconds: 16));
    final Offset visibleCenter = tester.getCenter(liquidLens);
    final Offset release = start + delta + finalDelta;
    expect((visibleCenter - release).distance, greaterThan(20),
        reason:
            'real inertia must distinguish the visible orb from the finger');
    await finger.up();
    await tester.pump();
    await pumpUntil(tester,
        () => find.byType(CaptureSelectionOverlay).evaluate().isNotEmpty);
    await tester.pump(const Duration(milliseconds: 566));
    final CaptureSelectionOverlay overlay =
        tester.widget(find.byType(CaptureSelectionOverlay));
    expect(overlay.viewport, const Size(600, 500));
    expect(overlay.releasePoint,
        Offset((release.dx - 80) / 600, (release.dy - 60) / 500));
    final CaptureSelectionOverlayState state =
        tester.state(find.byType(CaptureSelectionOverlay));
    expect(overlay.orbCenter, visibleCenter - const Offset(80, 60));
    expect(state.selection.size, const Size(144, 144));
    expect(state.selection.center, visibleCenter - const Offset(80, 60),
        reason:
            'orbCenter is already boundary local, with no second conversion');
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    expect(host.panel(tester).captureInfo!.releasePoint, overlay.releasePoint);
    expect(host.panel(tester).captureInfo!.viewportWidth, 600);
    expect(host.panel(tester).captureInfo!.viewportHeight, 500);
    final FeedbackCaptureInfo info = host.panel(tester).captureInfo!;
    // Existing crop contract expands fractional source edges outward.
    final int pixelWidth =
        (state.selection.right * 2).ceil() - (state.selection.left * 2).floor();
    final int pixelHeight =
        (state.selection.bottom * 2).ceil() - (state.selection.top * 2).floor();
    expect(info.pixelWidth, pixelWidth);
    expect(info.pixelHeight, pixelHeight);
    expect(info.region!.toJson(),
        normalizeCaptureRegion(state.selection, overlay.viewport).toJson());
    final DecodedPng image =
        await decodePng(host.panel(tester).screenshotBytes!, tester);
    expect(Size(image.width.toDouble(), image.height.toDouble()),
        Size(pixelWidth.toDouble(), pixelHeight.toDouble()));
  });

  testWidgets(
      'duplicate confirmation commits once, animates to actual thumbnail and focuses after 1500ms',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    final CaptureSelectionOverlay overlay =
        tester.widget(find.byType(CaptureSelectionOverlay));
    final CaptureSelectionOverlayState state =
        tester.state(find.byType(CaptureSelectionOverlay));
    overlay.onUseRegion(state.selection);
    overlay.onUseRegion(state.selection);
    await host.waitScreenshot(tester, complete: false);
    final FeedbackPanelState panel = host.panel(tester);
    expect(panel.imageCount, 1);
    final String id = panel.captureImageId!;
    final Rect actual = panel.captureThumbnailRect!;
    expect(actual.size, const Size(72, 72));
    expect(panel.draftFocused, isFalse);
    expect(
        find.byKey(const Key('feedback-handoff-flight-slot')), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1340));
    expect(panel.draftFocused, isFalse);
    final IgnorePointer lock = tester.widget<IgnorePointer>(find
        .ancestor(
            of: find.byType(FeedbackPanel),
            matching: find.byType(IgnorePointer))
        .first);
    expect(lock.ignoring, isTrue);
    await tester.pump(const Duration(milliseconds: 20));
    final IgnorePointer unlocked = tester.widget<IgnorePointer>(find
        .ancestor(
            of: find.byType(FeedbackPanel),
            matching: find.byType(IgnorePointer))
        .first);
    expect(unlocked.ignoring, isFalse);
    expect(panel.draftFocused, isFalse);
    await tester.pump(const Duration(milliseconds: 140));
    await tester.pump();
    expect(panel.draftFocused, isTrue);
    expect(panel.captureImageId!, id);
    expect(find.byKey(const Key('feedback-handoff-flight-slot')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'clipped capture slot cancels flight, reveals the real attachment and measures only when fully visible',
      (tester) async {
    await host.tokens.clear();
    await host.mount(tester, size: const Size(360, 300));
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester, complete: false);
    await tester.pump(); // render the measured missing-target fallback
    final FeedbackPanelState panel = host.panel(tester);
    final Finder thumb = find.byKey(const Key('feedback-screenshot-thumb'));
    final RenderBox box = tester.renderObject<RenderBox>(thumb);
    final RenderBox viewport = RenderAbstractViewport.of(box) as RenderBox;
    Rect visible() => viewport.localToGlobal(Offset.zero) & viewport.size;
    final Rect initial = tester.getRect(thumb);
    expect(initial.bottom, greaterThan(visible().bottom));
    expect(panel.captureThumbnailRect, isNull,
        reason: 'the fixed submit bar clips the compose scroll viewport');
    expect(
        find.descendant(
            of: find.byKey(const Key('feedback-handoff-flight-slot')),
            matching: find.byType(RawImage)),
        findsNothing,
        reason: 'the stable flight slot contains no flying bitmap');
    final Opacity opacity = tester.widget<Opacity>(
        find.ancestor(of: thumb, matching: find.byType(Opacity)).first);
    expect(opacity.opacity, 1,
        reason: 'missing flight target must not leave the actual slot hidden');
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump();
    expect(panel.hasScreenshot, isTrue);
    expect(panel.draftFocused, isTrue);
    await tester.ensureVisible(thumb);
    await tester.pump();
    expect(panel.captureThumbnailRect?.size, const Size(72, 72));

    final ScrollPosition position =
        Scrollable.of(tester.element(thumb)).position;
    // Returning to the actual top offset leaves the thumbnail partly behind
    // the submit bar; overlap alone is insufficient to accept a flight target.
    // R5 compact inputs put the thumbnail completely below a 300px host at
    // offset zero. Choose a real offset that exposes half the actual image.
    final double partial =
        tester.getRect(thumb).top - visible().bottom + 36 + position.pixels;
    position.jumpTo(
        partial.clamp(position.minScrollExtent, position.maxScrollExtent));
    await tester.pump();
    expect(tester.getRect(thumb).overlaps(visible()), isTrue);
    expect(tester.getRect(thumb).bottom, greaterThan(visible().bottom));
    expect(panel.captureThumbnailRect, isNull);
    // Expanding the existing inline login form gives a real layout where the
    // capture slot can scroll completely above the viewport as well.
    await tester.enterText(find.byKey(const Key('feedback-input')), '保留截图');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pump();
    expect(find.byKey(const Key('feedback-login-form')), findsOneWidget);
    await tester.binding.setSurfaceSize(const Size(360, 260));
    await tester.pump();
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();
    expect(tester.getRect(thumb).overlaps(visible()), isFalse);
    expect(panel.captureThumbnailRect, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'dark coarse-pointer selection keeps explicit readable local buttons',
      (tester) async {
    host.theme = ThemeData.dark().copyWith(platform: TargetPlatform.android);
    await host.mount(tester);
    await host.select(tester);
    final Finder primary = find.byKey(const Key('feedback-capture-use-region'));
    final Finder secondary =
        find.byKey(const Key('feedback-capture-whole-window'));
    final ButtonStyle primaryStyle =
        tester.widget<FilledButton>(primary).style!;
    final ButtonStyle secondaryStyle =
        tester.widget<TextButton>(secondary).style!;
    expect(primaryStyle.backgroundColor!.resolve(<WidgetState>{}),
        const Color(0xFF0071E3));
    expect(
        primaryStyle.foregroundColor!.resolve(<WidgetState>{}), Colors.white);
    final ColorScheme scheme = Theme.of(tester.element(secondary)).colorScheme;
    final Material card =
        tester.widget(find.byKey(const Key('feedback-capture-toolbar')));
    expect(card.color, scheme.surface);
    expect(secondaryStyle.foregroundColor!.resolve(<WidgetState>{}),
        scheme.onSurfaceVariant);
    expect(tester.getSize(primary).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(secondary).height, greaterThanOrEqualTo(44));
    final BuildContext label = tester.element(find.text('使用此区域'));
    expect(DefaultTextStyle.of(label).style.color, Colors.white);
    expect(DefaultTextStyle.of(tester.element(find.text('整个窗口'))).style.color,
        scheme.onSurfaceVariant);
  });

  for (final bool detach in <bool>[true, false]) {
    for (final bool cancel in <bool>[true, false]) {
      testWidgets(
          '${detach ? 'deactivate' : 'dispose'} while pressed ignores late move and ${cancel ? 'cancel' : 'up'}',
          (tester) async {
        await host.mount(tester);
        final TestGesture pointer =
            await tester.startGesture(tester.getCenter(liquidOrb));
        await tester.pump();
        if (detach) {
          host.reparent = true;
          host.rebuild();
          await tester.pump();
        } else {
          await tester.pumpWidget(const SizedBox.shrink());
        }
        await pointer.moveBy(const Offset(-150, -80));
        await tester.pump();
        if (cancel) {
          await pointer.cancel();
        } else {
          await pointer.up();
        }
        await tester.pump(const Duration(milliseconds: 300));
        expect(host.controller.isOpen, isFalse);
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        expect(tester.binding.transientCallbackCount, 0);
        expect(tester.takeException(), isNull);
        if (detach) {
          await tester.tap(liquidOrb);
          await tester.pump();
          expect(host.controller.isOpen, isTrue,
              reason: 'the reattached launcher accepts a new pointer');
        }
      });
    }
  }

  testWidgets(
      'retake selection cancel preserves text, screenshot bytes and attachment id',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    final FeedbackPanelState original = host.panel(tester);
    final String id = original.captureImageId!;
    final Object bytes = original.screenshotBytes!;
    await tester.enterText(find.byKey(const Key('feedback-input')), '保留草稿');
    host.controller.close();
    await tester.pump();
    await host.select(tester);
    expect(host.panel(tester), same(original));
    expect(original.screenshotBytes, same(bytes));
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    host.controller.open();
    await tester.pump();
    await tester.pump();
    expect(original.captureImageId!, id);
    expect(original.screenshotBytes, same(bytes));
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '保留草稿');
    host.controller.close();
    await tester.pump();
    await host.select(tester, delta: const Offset(-160, -100));
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    expect(original.imageCount, 1);
    expect(original.captureImageId!, id,
        reason: 'replace the actual stable capture slot');
  });

  testWidgets('failed crop preserves frozen selection and old draft for retry',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    final FeedbackPanelState original = host.panel(tester);
    final Object bytes = original.screenshotBytes!;
    final String id = original.captureImageId!;
    host.controller.close();
    await tester.pump();
    await host.select(tester);
    final CaptureSelectionOverlayState selection =
        tester.state(find.byType(CaptureSelectionOverlay));
    final Rect before = selection.selection;
    tester
        .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay))
        .onUseRegion(Rect.zero);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsOneWidget);
    expect(selection.selection, before);
    expect(find.byKey(const Key('feedback-capture-error')), findsOneWidget);
    expect(original.screenshotBytes, same(bytes));
    expect(host.controller.isOpen, isFalse);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    expect(original.imageCount, 1);
    expect(original.captureImageId, id);
    expect(original.screenshotBytes, isNot(same(bytes)));
    expect(tester.takeException(), isNull);
  });

  for (final Size size in <Size>[
    const Size(180, 360),
    const Size(240, 400),
    const Size(360, 592)
  ]) {
    testWidgets('tools stay in $size and avoid all four corner targets',
        (tester) async {
      await host.mount(tester, size: size);
      for (final Offset target in <Offset>[
        const Offset(12, 12),
        Offset(size.width - 12, 12),
        Offset(12, size.height - 12),
        Offset(size.width - 12, size.height - 12),
        size.center(Offset.zero)
      ]) {
        await host.select(tester, delta: target - tester.getCenter(liquidOrb));
        final Rect tools =
            tester.getRect(find.byKey(const Key('feedback-capture-tools')));
        expect(tools.left, greaterThanOrEqualTo(8));
        expect(tools.top, greaterThanOrEqualTo(8));
        expect(tools.right, lessThanOrEqualTo(size.width - 8));
        expect(tools.bottom, lessThanOrEqualTo(size.height - 8));
        for (final String suffix in <String>['0-0', '2-0', '0-2', '2-2']) {
          final Rect handle = tester
              .getRect(find.byKey(Key('feedback-capture-handle-$suffix')));
          expect(tools.overlaps(handle), isFalse);
        }
        final Rect close =
            tester.getRect(find.byKey(const Key('feedback-capture-cancel')));
        expect(tools.overlaps(close), isFalse);
        for (final String action in <String>[
          'feedback-capture-whole-window',
          'feedback-capture-use-region'
        ]) {
          final Finder button = find.byKey(Key(action));
          await tester.ensureVisible(button);
          await tester.pumpAndSettle();
          expect(tester.getSize(button).height, 44);
          expect(button.hitTestable(), findsOneWidget,
              reason:
                  'each action stays reachable even when the compact card scrolls');
        }
        await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
        await tester.pump();
        expect(tester.takeException(), isNull);
      }
    });
  }

  testWidgets(
      'GlobalKey detach invalidates an awaiting crop without late reopen',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    final CaptureSelectionOverlayState selection =
        tester.state(find.byType(CaptureSelectionOverlay));
    tester
        .widget<CaptureSelectionOverlay>(find.byType(CaptureSelectionOverlay))
        .onUseRegion(selection.selection);
    host.reparent = true;
    host.rebuild();
    await tester.pump();
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      });
    }
    expect(host.controller.isOpen, isFalse);
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(find.byKey(const Key('feedback-handoff-flight-slot')), findsNothing);
    await host.select(tester);
    expect(find.byType(CaptureSelectionOverlay), findsOneWidget,
        reason: 'reattached State supports a fresh capture session');
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  for (final String invalidation in <String>[
    'close',
    'identity',
    'controller',
    'page',
    'dispose'
  ]) {
    testWidgets(
        '$invalidation while crop is awaiting cannot deliver late pixels or reopen',
        (tester) async {
      await host.mount(tester);
      await host.select(tester);
      final CaptureSelectionOverlay overlay =
          tester.widget(find.byType(CaptureSelectionOverlay));
      final CaptureSelectionOverlayState state =
          tester.state(find.byType(CaptureSelectionOverlay));
      overlay.onUseRegion(state.selection);
      switch (invalidation) {
        case 'close':
          host.controller.close();
        case 'identity':
          host.appId = 'com.example.other';
          host.rebuild();
        case 'controller':
          host.replaceController();
        case 'page':
          host.pageLabel = 'other-page';
          host.rebuild();
        case 'dispose':
          await tester.pumpWidget(const SizedBox.shrink());
      }
      await tester.pump();
      for (int i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        });
      }
      expect(host.controller.isOpen, isFalse);
      expect(find.byType(CaptureSelectionOverlay), findsNothing);
      if (invalidation != 'dispose' &&
          find
              .byType(FeedbackPanel, skipOffstage: false)
              .evaluate()
              .isNotEmpty) {
        expect(host.panel(tester).hasScreenshot, isFalse);
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'close after commit keeps the adopted attachment but cancels animation and late focus',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester, complete: false);
    final FeedbackPanelState panel = host.panel(tester);
    expect(panel.hasScreenshot, isTrue);
    host.controller.close();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(host.controller.isOpen, isFalse);
    expect(panel.hasScreenshot, isTrue);
    expect(panel.draftFocused, isFalse);
    expect(find.byKey(const Key('feedback-handoff-flight-slot')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final bool changeDpr in <bool>[false, true]) {
    testWidgets(
        '${changeDpr ? 'DPR' : 'viewport'} change cancels the frozen session instead of stretching its region',
        (tester) async {
      await host.mount(tester);
      await host.select(tester);
      if (changeDpr) {
        host.dpr = 1;
        host.rebuild();
      } else {
        await tester.binding.setSurfaceSize(const Size(700, 550));
      }
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.byType(CaptureSelectionOverlay), findsNothing);
      expect(host.panel(tester).hasScreenshot, isFalse);
      expect(find.textContaining('重新截图'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'keyboard moves/scales 6px, Tab stays inside, Escape retains previous draft',
      (tester) async {
    await host.mount(tester);
    await host.select(tester);
    final CaptureSelectionOverlayState state =
        tester.state(find.byType(CaptureSelectionOverlay));
    final Rect initial = state.selection;
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(state.selection, initial.shift(const Offset(-6, 0)));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();
    expect(state.selection.width, initial.width + 6);
    final BuildContext overlayContext =
        tester.element(find.byType(CaptureSelectionOverlay));
    for (int i = 0; i < 9; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      bool inside = false;
      FocusManager.instance.primaryFocus?.context
          ?.visitAncestorElements((Element e) {
        if (identical(e, overlayContext)) inside = true;
        return true;
      });
      expect(inside, isTrue, reason: 'Tab cannot reach the host or launcher');
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(CaptureSelectionOverlay), findsNothing);
    expect(host.controller.isOpen, isFalse);
  });

  testWidgets(
      'reduced motion completes real attachment handoff and focus without a time delay',
      (tester) async {
    host.reduced = true;
    await host.mount(tester);
    await host.select(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester, complete: false);
    await tester.pump();
    await tester.pump();
    expect(host.panel(tester).hasScreenshot, isTrue);
    expect(host.panel(tester).draftFocused, isTrue);
    expect(find.byKey(const Key('feedback-handoff-flight-slot')), findsNothing);
    // The handoff and focus above complete immediately. Only Material's finite
    // input focus/border animations remain; let those finish before checking
    // that the flow owns no persistent ticker.
    await tester.pump(const Duration(milliseconds: 216));
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets(
      'ten open/cancel cycles retain one panel and no ticker/image-use exceptions',
      (tester) async {
    await host.mount(tester);
    host.controller.open();
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel = host.panel(tester);
    host.controller.close();
    await tester.pump();
    for (int i = 0; i < 10; i++) {
      await host.select(tester);
      host.controller.setUnreadCount(i + 1);
      await tester.pump();
      expect(find.byType(CaptureSelectionOverlay), findsOneWidget,
          reason: 'unread metadata changes do not act like a close');
      await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
      await tester.pump();
      await tester.pump();
      expect(host.panel(tester), same(panel));
      expect(tester.binding.transientCallbackCount, 0);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('masked lens stays opaque after bounded scroll refresh',
      (tester) async {
    debugDisableOrbLensCapture = false;
    debugOrbLensCaptureAttempts = 0;
    host.content = const Stack(children: <Widget>[
      Positioned.fill(child: ColoredBox(color: Colors.blue)),
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
    await pumpUntil(
        tester,
        () => find
            .byKey(const Key('feedback-orb-lens-shader'))
            .evaluate()
            .isNotEmpty);
    final OrbLiquidLensPainter painter = tester
        .widget<CustomPaint>(find.byKey(const Key('feedback-orb-lens-shader')))
        .painter! as OrbLiquidLensPainter;
    final Uint8List? bytes = await tester.runAsync<Uint8List?>(
        () async => (await painter.image.toByteData())?.buffer.asUint8List());
    final int index = ((120 * painter.scale).floor() * painter.image.width +
            (120 * painter.scale).floor()) *
        4;
    expect(bytes!.sublist(index, index + 4), <int>[110, 110, 115, 255]);
    final int captured = debugOrbLensCaptureAttempts;
    final BuildContext childContext =
        tester.element(find.byType(FeedbackCaptureMask));
    ScrollUpdateNotification(
            metrics: FixedScrollMetrics(
                minScrollExtent: 0,
                maxScrollExtent: 100,
                pixels: 10,
                viewportDimension: 600,
                axisDirection: AxisDirection.down,
                devicePixelRatio: 2),
            context: childContext)
        .dispatch(childContext);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-lens-shader')), findsNothing);
    await pumpUntil(
        tester,
        () => find
            .byKey(const Key('feedback-orb-lens-shader'))
            .evaluate()
            .isNotEmpty);
    final OrbLiquidLensPainter refreshed = tester
        .widget<CustomPaint>(find.byKey(const Key('feedback-orb-lens-shader')))
        .painter! as OrbLiquidLensPainter;
    expect(refreshed.image, isNot(same(painter.image)));
    final Uint8List? updated = await tester.runAsync<Uint8List?>(
        () async => (await refreshed.image.toByteData())?.buffer.asUint8List());
    final int refreshedIndex =
        ((120 * refreshed.scale).floor() * refreshed.image.width +
                (120 * refreshed.scale).floor()) *
            4;
    expect(updated!.sublist(refreshedIndex, refreshedIndex + 4),
        <int>[110, 110, 115, 255]);
    expect(debugOrbLensCaptureAttempts, captured + 1);
    expect(find.byType(BackdropFilter), findsNothing);
  });

  testWidgets('drag refresh obeys the bounded gate and remains single-flight',
      (tester) async {
    debugDisableOrbLensCapture = false;
    debugOrbLensCaptureAttempts = 0;
    expect(debugOrbLensGateDuration, const Duration(milliseconds: 250));
    final Duration originalGate = debugOrbLensGateDuration;
    addTearDown(() => debugOrbLensGateDuration = originalGate);
    // Use a large gate while testing the blocked branch so engine speed cannot
    // make the test cross the real-time boundary. Production uses 250ms.
    debugOrbLensGateDuration = const Duration(days: 1);
    await host.mount(tester);
    await pumpUntil(
        tester,
        () => find
            .byKey(const Key('feedback-orb-lens-shader'))
            .evaluate()
            .isNotEmpty);
    final int initial = debugOrbLensCaptureAttempts;
    final OrbLiquidLensPainter previous = tester
        .widget<CustomPaint>(find.byKey(const Key('feedback-orb-lens-shader')))
        .painter! as OrbLiquidLensPainter;
    final TestGesture gated =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gated.moveBy(const Offset(-80, -30));
    await tester.pump();
    expect(debugOrbLensCaptureAttempts, initial);
    await gated.cancel();
    await tester.pump(const Duration(milliseconds: 250));
    // Both drag triggers occur before the next frame can finish toImage. The
    // zero test gate permits a refresh but must never permit a second in flight.
    debugOrbLensGateDuration = Duration.zero;
    final TestGesture first =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await first.moveBy(const Offset(-80, -30));
    await first.cancel();
    final TestGesture second =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await second.moveBy(const Offset(-80, -30));
    // Keep this single-flight drag check isolated from automatic success
    // refreshes, which have their own production-cadence pixel tests.
    debugOrbLensGateDuration = const Duration(days: 1);
    await pumpUntil(tester, () {
      final Finder shader = find.byKey(const Key('feedback-orb-lens-shader'));
      if (shader.evaluate().isEmpty) return false;
      final OrbLiquidLensPainter painter =
          tester.widget<CustomPaint>(shader).painter! as OrbLiquidLensPainter;
      return !identical(painter.image, previous.image);
    });
    expect(debugOrbLensCaptureAttempts, initial + 1);
    await tester.pump(const Duration(seconds: 2));
    expect(debugOrbLensCaptureAttempts, initial + 1,
        reason:
            'holding a drag does not add per-frame work within the test gate');
    await second.cancel();
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'host scroll preserves the frozen selection and its original pixels',
      (tester) async {
    late BuildContext childContext;
    host.content = Builder(builder: (BuildContext context) {
      childContext = context;
      return const ColoredBox(color: Colors.blue);
    });
    await host.mount(tester);
    await host.select(tester);
    final CaptureSelectionOverlay overlay =
        tester.widget(find.byType(CaptureSelectionOverlay));
    final CaptureSelectionOverlayState state =
        tester.state(find.byType(CaptureSelectionOverlay));
    final Rect rect = state.selection;
    ScrollUpdateNotification(
            metrics: FixedScrollMetrics(
                minScrollExtent: 0,
                maxScrollExtent: 100,
                pixels: 10,
                viewportDimension: 600,
                axisDirection: AxisDirection.down,
                devicePixelRatio: 2),
            context: childContext)
        .dispatch(childContext);
    await tester.pump();
    expect(tester.state(find.byType(CaptureSelectionOverlay)), same(state));
    expect(
        tester
            .widget<CaptureSelectionOverlay>(
                find.byType(CaptureSelectionOverlay))
            .image,
        same(overlay.image));
    expect(state.selection, rect);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await host.waitScreenshot(tester);
    final DecodedPng image =
        await decodePng(host.panel(tester).screenshotBytes!, tester);
    expectPixel(image.pixelAt(10, 10), <int>[33, 150, 243, 255],
        'scroll does not recapture');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'shader or snapshot failure has no live unmasked fallback and no retry loop',
      (tester) async {
    debugDisableOrbLensCapture = false;
    debugFailOrbLensShader = true;
    addTearDown(() => debugFailOrbLensShader = false);
    await host.mount(tester);
    for (int i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(BackdropFilter), findsNothing);
    expect(find.byKey(const Key('feedback-orb-lens-shader')), findsNothing);
    expect(liquidLens, findsOneWidget);
    debugFailOrbLensShader = false;
    debugFailOrbLensCapture = true;
    debugOrbLensCaptureAttempts = 0;
    addTearDown(() => debugFailOrbLensCapture = false);
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(liquidOrb));
    await gesture.moveBy(const Offset(-80, -30));
    await tester.pump();
    for (int i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 20));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      });
    }
    expect(debugOrbLensCaptureAttempts, 1);
    expect(find.byType(BackdropFilter), findsNothing);
    await gesture.cancel();
    expect(tester.takeException(), isNull);
  });
}
