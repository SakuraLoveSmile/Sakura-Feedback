// T1 验收：拖动灵感球 → 冻结已遮挡画面 → 调整选区 → 确认 → 填写反馈。
//
// 覆盖：
// 1. 初始选区计算（中央 / 四角 / 靠边 / 安全区 / 最小 48×48）；
// 2. 选区移动、四角缩放、重新框选的边界钳制；
// 3. `capture.region` 归一化（0..1、相对原始捕获视口、x+width≤1）与
//    提交 metadata 透传、整窗省略、旧提交（无 region）兼容；
// 4. 5 张上限先提示整理附件、取消（含 Esc）、回车确认、失败可重试且绝不
//    静默回退整屏截图、会话/身份失效作废进行中流程、已有草稿不丢失。

import 'dart:convert';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:feedback_widget/src/wake_gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';
import 'panel_harness.dart';

/// 1x1 PNG（合法图片字节）。
final Uint8List kTinyPngBytes = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

/// 触发一次真实拖拽（多次位移事件，累计超过 8dp）并松手。
Future<TestGesture> dragOrbAndRelease(
  WidgetTester tester, {
  Offset step = const Offset(-40, -40),
  int times = 3,
}) async {
  final TestGesture gesture = await tester
      .startGesture(tester.getCenter(find.byKey(const Key('feedback-orb'))));
  for (int i = 0; i < times; i++) {
    await gesture.moveBy(step);
    await tester.pump(const Duration(milliseconds: 16));
  }
  await gesture.up();
  await tester.pump();
  return gesture;
}

/// 等待选区覆盖层挂载（冻结捕获为真实异步 toImage/编码）。
Future<void> pumpUntilOverlay(WidgetTester tester) async {
  await pumpUntil(
      tester,
      () => find
          .byKey(const Key('feedback-capture-selection-overlay'))
          .evaluate()
          .isNotEmpty);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 550));
}

/// 带 orb + viewport 捕获的宿主（默认 mock 服务）。
Future<void> pumpOrbHost(
  WidgetTester tester,
  FeedbackController controller, {
  http.Client? httpClient,
  FeedbackImagePicker? imagePicker,
}) async {
  await tester.binding.setSurfaceSize(const Size(800, 600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    home: FeedbackWidget(
      config: FeedbackConfig(
        'https://svc.test',
        'com.example.test',
        launcherMode: FeedbackLauncherMode.orb,
        captureMode: FeedbackCaptureMode.viewport,
      ),
      controller: controller,
      tokenStore: MemoryTokenStore('tok'),
      serverPrefStore: MemoryServerPrefStore(),
      httpClient: httpClient ?? captureMockClient(),
      imagePicker: imagePicker,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ),
  ));
  await tester.pump();
}

/// 等待选区确认后的截图交付进面板。
Future<FeedbackPanelState> _waitScreenshot(WidgetTester tester) async {
  await pumpUntil(tester, () {
    if (find.byType(FeedbackPanel).evaluate().isEmpty) return false;
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    return panel.hasScreenshot;
  });
  await tester.pump();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 1500));
  await tester.pump();
  return tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
}

/// 解析 multipart 请求正文中的 `metadata` 字段。
Map<String, Object?> _multipartMetadata(http.Request req) {
  final String contentType = req.headers['content-type'] ?? '';
  final String boundary =
      RegExp(r'boundary=([^;]+)').firstMatch(contentType)!.group(1)!;
  final List<String> parts = latin1.decode(req.bodyBytes).split('--$boundary');
  final String metaPart =
      parts.firstWhere((String p) => p.contains('name="metadata"'));
  final String raw =
      metaPart.substring(metaPart.indexOf('\r\n\r\n') + 4).trim();
  return jsonDecode(utf8.decode(latin1.encode(raw))) as Map<String, Object?>;
}

void main() {
  for (final entry in <({
    String name,
    EdgeInsets host,
    bool safeArea,
    EdgeInsets viewPadding,
    Rect boundary,
    Rect area
  })>[
    (
      name: 'full view',
      host: EdgeInsets.zero,
      safeArea: false,
      viewPadding: const EdgeInsets.only(top: 24, bottom: 34),
      boundary: const Rect.fromLTWH(0, 0, 800, 600),
      area: const Rect.fromLTWH(0, 24, 800, 542)
    ),
    (
      name: 'embedded already safe',
      host: const EdgeInsets.fromLTRB(80, 60, 120, 40),
      safeArea: false,
      viewPadding: const EdgeInsets.only(top: 24, bottom: 34),
      boundary: const Rect.fromLTWH(80, 60, 600, 500),
      area: const Rect.fromLTWH(0, 0, 600, 500)
    ),
    (
      name: 'partial overlap',
      host: const EdgeInsets.fromLTRB(80, 10, 120, 10),
      safeArea: false,
      viewPadding: const EdgeInsets.only(top: 24, bottom: 34),
      boundary: const Rect.fromLTWH(80, 10, 600, 580),
      area: const Rect.fromLTWH(0, 14, 600, 542)
    ),
    (
      name: 'SafeArea already consumed',
      host: EdgeInsets.zero,
      safeArea: true,
      viewPadding: const EdgeInsets.only(top: 24, bottom: 34),
      boundary: const Rect.fromLTWH(0, 24, 800, 542),
      area: const Rect.fromLTWH(0, 0, 800, 542)
    ),
    (
      name: 'four partially overlapping edges',
      host: const EdgeInsets.all(10),
      safeArea: false,
      viewPadding: const EdgeInsets.fromLTRB(18, 24, 30, 34),
      boundary: const Rect.fromLTWH(10, 10, 780, 580),
      area: const Rect.fromLTWH(8, 14, 752, 542)
    ),
  ]) {
    for (final bool dragged in <bool>[false, true]) {
      testWidgets(
          'local safe rect: ${entry.name} / ${dragged ? 'orbCenter' : 'wake then drag'}',
          (tester) async {
        final double dpr = entry.name == 'partial overlap' ? 2 : 1;
        tester.view.devicePixelRatio = dpr;
        tester.view.physicalSize = Size(800 * dpr, 600 * dpr);
        final FakeViewPadding padding = FakeViewPadding(
            left: entry.viewPadding.left * dpr,
            top: entry.viewPadding.top * dpr,
            right: entry.viewPadding.right * dpr,
            bottom: entry.viewPadding.bottom * dpr);
        tester.view.padding = padding;
        tester.view.viewPadding = padding;
        debugDisableOrbLensCapture = true;
        addTearDown(() {
          tester.view.resetPadding();
          tester.view.resetViewPadding();
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
          debugDisableOrbLensCapture = false;
        });
        final FeedbackController controller = FeedbackController();
        addTearDown(controller.dispose);
        final MemoryServerPrefStore preferences = MemoryServerPrefStore();
        await preferences.write(
            wakeGestureStorageKey('com.example.safe-local'),
            encodeWakeGestures(
                <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold}));
        Widget host = FeedbackWidget(
            config: FeedbackConfig('https://svc.test', 'com.example.safe-local',
                launcherMode: FeedbackLauncherMode.orb,
                captureMode: FeedbackCaptureMode.viewport),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: preferences,
            httpClient: captureMockClient(),
            child:
                const SizedBox.expand(child: ColoredBox(color: Colors.blue)));
        if (entry.safeArea) host = SafeArea(child: host);
        await tester.pumpWidget(
            MaterialApp(home: Padding(padding: entry.host, child: host)));
        await tester.pump();
        expect(tester.getRect(find.byKey(const Key('feedback-host-slot'))),
            entry.boundary);
        final Offset releaseLocal = Offset(220, entry.boundary.height - 8);
        final Offset releaseGlobal = entry.boundary.topLeft + releaseLocal;
        Offset? visibleLocal;
        if (!dragged) {
          final TestGesture first =
              await tester.startGesture(releaseGlobal - const Offset(20, 0));
          final TestGesture second =
              await tester.startGesture(releaseGlobal + const Offset(20, 0));
          await tester.pump(const Duration(milliseconds: 700));
          await first.up();
          await second.up();
          await tester.pump();
          expect(find.byType(CaptureSelectionOverlay), findsNothing,
              reason:
                  'R5 wake never captures; the subsequent drag is explicit');
        }
        final TestGesture finger = await tester.startGesture(
            tester.getCenter(find.byKey(const Key('feedback-orb'))));
        await finger.moveTo(releaseGlobal);
        for (int i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        visibleLocal =
            tester.getCenter(find.byKey(const Key('feedback-orb-lens'))) -
                entry.boundary.topLeft;
        await finger.up();
        await tester.pump();
        await pumpUntilOverlay(tester);
        final CaptureSelectionOverlay overlay =
            tester.widget(find.byType(CaptureSelectionOverlay));
        final CaptureSelectionOverlayState state =
            tester.state(find.byType(CaptureSelectionOverlay));
        expect(overlay.viewport, entry.boundary.size);
        expect(
            overlay.releasePoint,
            Offset(releaseLocal.dx / entry.boundary.width,
                releaseLocal.dy / entry.boundary.height));
        expect(overlay.orbCenter,
            offsetMoreOrLessEquals(visibleLocal, epsilon: 1e-9));
        final Offset center = visibleLocal;
        expect(
            state.selection,
            rectMoreOrLessEquals(
                Rect.fromLTWH(
                    (center.dx - 72)
                        .clamp(entry.area.left, entry.area.right - 144),
                    (center.dy - 72)
                        .clamp(entry.area.top, entry.area.bottom - 144),
                    144,
                    144),
                epsilon: 1e-9));
        expect(
            tester.getRect(find.byKey(const Key('feedback-capture-selection'))),
            rectMoreOrLessEquals(state.selection.shift(entry.boundary.topLeft),
                epsilon: 1e-9));

        // Exercise actual move and resize callbacks, using the same local area.
        final TestGesture move = await tester
            .startGesture(entry.boundary.topLeft + state.selection.center);
        await move.moveBy(const Offset(-40, -40));
        await move.moveBy(const Offset(-1000, -1000));
        await move.up();
        await tester.pump();
        expect(state.selection.topLeft, entry.area.topLeft);
        final TestGesture grow = await tester.startGesture(tester
            .getCenter(find.byKey(const Key('feedback-capture-handle-2-2'))));
        await grow.moveBy(const Offset(40, 40));
        await grow.moveBy(const Offset(1000, 1000));
        await grow.up();
        await tester.pump();
        expect(state.selection, entry.area);
        final TestGesture shrink = await tester.startGesture(tester
            .getCenter(find.byKey(const Key('feedback-capture-handle-0-0'))));
        await shrink.moveBy(const Offset(40, 40));
        await shrink.moveBy(const Offset(1000, 1000));
        await shrink.up();
        await tester.pump();
        expect(state.selection.size, const Size(48, 48));
        expect(state.selection.bottomRight, entry.area.bottomRight);
        await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
        await tester.pump();
        expect(controller.isOpen, isFalse);
        expect(find.byType(CaptureSelectionOverlay), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(seconds: 1));
      });
    }
  }

  group('T1-1：初始选区与钳制（纯函数）', () {
    test('中央：144×144，中心为指定球心或落点', () {
      final Rect r = initialCaptureSelection(
        viewport: const Size(800, 600),
        center: const Offset(400, 300),
      );
      expect(r, const Rect.fromLTWH(328, 228, 144, 144));
    });

    test('超大视口仍为144×144', () {
      final Rect r = initialCaptureSelection(
        viewport: const Size(2000, 1600),
        center: const Offset(1000, 800),
      );
      expect(r.size, const Size(144, 144));
    });

    test('四角与靠边：整体移回可见区域（不越界）', () {
      const Size v = Size(800, 600);
      final Rect topLeft =
          initialCaptureSelection(viewport: v, center: Offset.zero);
      expect(topLeft.left, 0);
      expect(topLeft.top, 0);
      expect(topLeft.size, const Size(144, 144));

      expect(initialCaptureSelection(viewport: v, center: const Offset(800, 0)),
          const Rect.fromLTWH(656, 0, 144, 144));
      expect(initialCaptureSelection(viewport: v, center: const Offset(0, 600)),
          const Rect.fromLTWH(0, 456, 144, 144));

      final Rect bottomRight =
          initialCaptureSelection(viewport: v, center: const Offset(800, 600));
      expect(bottomRight.right, 800);
      expect(bottomRight.bottom, 600);
      expect(bottomRight.size, const Size(144, 144));

      final Rect leftEdge =
          initialCaptureSelection(viewport: v, center: const Offset(10, 300));
      expect(leftEdge.left, 0);
      expect(leftEdge.right, 144);

      final Rect rightEdge =
          initialCaptureSelection(viewport: v, center: const Offset(790, 300));
      expect(rightEdge.right, 800);
    });

    test('安全区：选区完整落在扣安全区后的可用区域内', () {
      const Size v = Size(800, 600);
      const EdgeInsets insets = EdgeInsets.fromLTRB(40, 60, 40, 80);
      final Rect area = captureSelectionArea(v, insets);
      for (final Offset center in <Offset>[
        Offset.zero,
        const Offset(800, 600),
        const Offset(60, 80),
        const Offset(700, 500),
        const Offset(400, 300),
      ]) {
        final Rect r = initialCaptureSelection(
            viewport: v, center: center, safeInsets: insets);
        expect(r.left, greaterThanOrEqualTo(area.left - 1e-9));
        expect(r.top, greaterThanOrEqualTo(area.top - 1e-9));
        expect(r.right, lessThanOrEqualTo(area.right + 1e-9));
        expect(r.bottom, lessThanOrEqualTo(area.bottom + 1e-9));
        expect(r.size, const Size(144, 144));
      }
    });

    test('小视口或安全区不足144时按可用宽高收缩，允许不足48', () {
      for (final Offset center in <Offset>[
        Offset.zero,
        const Offset(50, 40),
        const Offset(100, 80)
      ]) {
        expect(
            initialCaptureSelection(
                viewport: const Size(100, 80), center: center),
            const Rect.fromLTWH(0, 0, 100, 80));
        expect(
            initialCaptureSelection(
                viewport: const Size(100, 80),
                center: center,
                safeInsets: const EdgeInsets.fromLTRB(30, 20, 40, 25)),
            const Rect.fromLTWH(30, 20, 30, 35));
      }
      expect(
          initialCaptureSelection(
              viewport: const Size(200, 160),
              center: const Offset(200, 160),
              safeInsets: const EdgeInsets.fromLTRB(30, 10, 40, 20)),
          const Rect.fromLTWH(30, 10, 130, 130));
    });

    test('最小 48×48：缩放、框选、平移都不低于最小值且移回可用区', () {
      const Size v = Size(800, 600);
      const Rect sel = Rect.fromLTWH(200, 200, 100, 100);

      // 缩放：向内拖过头 → 停在 48。
      final Rect shrunk = resizeCaptureSelection(
          sel, CaptureHandleAnchor.topLeft, const Offset(500, 0), v);
      expect(shrunk.width, kCaptureSelectionMinSize);

      final Rect shrunkY = resizeCaptureSelection(
          sel, CaptureHandleAnchor.bottomRight, const Offset(-500, -500), v);
      expect(shrunkY.width, kCaptureSelectionMinSize);
      expect(shrunkY.height, kCaptureSelectionMinSize);

      // 框选：极小拖动 → 至少 48×48。
      final Rect framed = frameCaptureSelection(
          const Offset(100, 100), const Offset(104, 103), v);
      expect(framed.width, greaterThanOrEqualTo(kCaptureSelectionMinSize));
      expect(framed.height, greaterThanOrEqualTo(kCaptureSelectionMinSize));

      // 平移：越界整体移回。
      final Rect moved = moveCaptureSelection(sel, const Offset(-500, -500), v);
      expect(moved.left, 0);
      expect(moved.top, 0);
      expect(moved.size, const Size(100, 100));
    });
  });

  for (final ({String label, Offset? orb, Offset? release, Offset center}) entry
      in <({String label, Offset? orb, Offset? release, Offset center})>[
    (
      label: '球心优先于不同的手指落点',
      orb: const Offset(320, 240),
      release: const Offset(.75, .7),
      center: const Offset(320, 240)
    ),
    (
      label: '无球快照使用归一化落点',
      orb: null,
      release: const Offset(.75, .7),
      center: const Offset(600, 420)
    ),
    (
      label: '无球快照和落点使用视口中央',
      orb: null,
      release: null,
      center: const Offset(400, 300)
    )
  ]) {
    testWidgets('400ms从104px向外展开至144px：${entry.label}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final ui.PictureRecorder recorder = ui.PictureRecorder();
      Canvas(recorder).drawColor(Colors.blue, BlendMode.src);
      final ui.Picture picture = recorder.endRecording();
      final ui.Image image = picture.toImageSync(800, 600);
      picture.dispose();
      addTearDown(image.dispose);
      await tester.pumpWidget(MaterialApp(
          home: CaptureSelectionOverlay(
              image: image,
              viewport: const Size(800, 600),
              orbCenter: entry.orb,
              releasePoint: entry.release,
              onUseRegion: (_) {},
              onCaptureWhole: () {},
              onCancel: () {})));
      final CaptureSelectionOverlayState state =
          tester.state(find.byType(CaptureSelectionOverlay));
      expect(state.selection,
          Rect.fromCenter(center: entry.center, width: 144, height: 144));
      final Finder frame = find.byKey(const Key('feedback-capture-selection'));
      expect(tester.getRect(frame),
          Rect.fromCenter(center: entry.center, width: 104, height: 104));
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.getRect(frame),
          Rect.fromCenter(center: entry.center, width: 124, height: 124));
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.getRect(frame), state.selection,
          reason: '保持原400ms展开时长，不再向48px收缩或跳向手指');
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  for (final ({
    String label,
    Size viewport,
    EdgeInsets insets,
    Rect expected
  }) entry
      in <({String label, Size viewport, EdgeInsets insets, Rect expected})>[
    (
      label: '安全区小于144',
      viewport: const Size(200, 160),
      insets: const EdgeInsets.fromLTRB(30, 10, 40, 20),
      expected: const Rect.fromLTWH(30, 10, 130, 130)
    ),
    (
      label: '小视口不足144',
      viewport: const Size(130, 130),
      insets: EdgeInsets.zero,
      expected: const Rect.fromLTWH(0, 0, 130, 130)
    )
  ]) {
    testWidgets('实际覆盖层：${entry.label}，缩到可用区域且键盘不能移出', (tester) async {
      await tester.binding.setSurfaceSize(entry.viewport);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final ui.PictureRecorder recorder = ui.PictureRecorder();
      Canvas(recorder).drawColor(Colors.blue, BlendMode.src);
      final ui.Picture picture = recorder.endRecording();
      final ui.Image image = picture.toImageSync(200, 160);
      picture.dispose();
      addTearDown(image.dispose);
      await tester.pumpWidget(MaterialApp(
          home: MediaQuery(
              data: MediaQueryData(size: entry.viewport, padding: entry.insets),
              child: CaptureSelectionOverlay(
                  image: image,
                  viewport: entry.viewport,
                  safeInsets: entry.insets,
                  releasePoint: const Offset(1, 1),
                  onUseRegion: (_) {},
                  onCaptureWhole: () {},
                  onCancel: () {}))));
      final CaptureSelectionOverlayState state =
          tester.state(find.byType(CaptureSelectionOverlay));
      expect(state.selection, entry.expected);
      await tester.pump(const Duration(milliseconds: 550));
      expect(
          tester.getRect(find.byKey(const Key('feedback-capture-selection'))),
          entry.expected);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pump();
      expect(state.selection, entry.expected);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pump();
      expect(state.selection.topLeft, entry.expected.topLeft);
      expect(state.selection.width, entry.expected.width - 6);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  group('T1-5：capture.region 归一化与序列化', () {
    test('相对原始捕获视口 0..1，x+width≤1、y+height≤1', () {
      const Size v = Size(800, 600);
      final FeedbackCaptureRegion r = FeedbackCaptureRegion.fromRect(
          const Rect.fromLTWH(400, 186, 400, 240), v);
      expect(r.x, 0.5);
      expect(r.y, closeTo(0.31, 1e-9));
      expect(r.width, 0.5);
      expect(r.height, closeTo(0.4, 1e-9));
      expect(r.x + r.width, lessThanOrEqualTo(1.0));
      expect(r.y + r.height, lessThanOrEqualTo(1.0));

      // 越界矩形钳到视口内。
      final FeedbackCaptureRegion overflow = FeedbackCaptureRegion.fromRect(
          const Rect.fromLTWH(700, 500, 300, 200), v);
      expect(overflow.x + overflow.width, lessThanOrEqualTo(1.0));
      expect(overflow.y + overflow.height, lessThanOrEqualTo(1.0));
      expect(overflow.x + overflow.width, closeTo(1.0, 1e-9));

      // 负坐标钳到 0。
      final FeedbackCaptureRegion negative = FeedbackCaptureRegion.fromRect(
          const Rect.fromLTWH(-50, -50, 100, 100), v);
      expect(negative.x, 0);
      expect(negative.y, 0);
      expect(negative.x + negative.width, lessThanOrEqualTo(1.0));
    });

    test('toJson：带 region 输出 {x,y,width,height}；旧提交无 region 省略字段', () {
      const FeedbackCaptureInfo withRegion = FeedbackCaptureInfo(
        viewportWidth: 800,
        viewportHeight: 600,
        pixelWidth: 800,
        pixelHeight: 480,
        capturedAt: 't',
        region: FeedbackCaptureRegion(x: 0.1, y: 0.2, width: 0.3, height: 0.4),
      );
      expect(withRegion.toJson()['region'], <String, Object?>{
        'x': 0.1,
        'y': 0.2,
        'width': 0.3,
        'height': 0.4,
      });

      // 旧提交（不带 region）：字段省略、其余语义不变——兼容。
      const FeedbackCaptureInfo legacy = FeedbackCaptureInfo(
        viewportWidth: 800,
        viewportHeight: 600,
        pixelWidth: 1600,
        pixelHeight: 1200,
        capturedAt: 't',
        releasePoint: Offset(0.5, 0.5),
      );
      final Map<String, Object?> json = legacy.toJson();
      expect(json.containsKey('region'), isFalse);
      expect(json['viewportWidth'], 800);
      expect(json['releasePoint'], <String, Object?>{'x': 0.5, 'y': 0.5});
    });
  });

  testWidgets('灵感球视觉：静止 56dp、拖动中 104dp、松手回停靠位', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    final Finder orb = find.byKey(const Key('feedback-orb'));
    final Rect docked = tester.getRect(orb);
    expect(tester.getSize(orb), const Size(56, 56),
        reason: 'spec 3.1：静止直径 56dp');

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(orb));
    await gesture.moveBy(const Offset(-40, -40)); // 跨过 pan slop（被接受）
    await gesture.moveBy(const Offset(-10, -10)); // 有效更新 → 拖动态（>8dp）
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300)); // 动效 220ms 完成
    expect(tester.getSize(orb), const Size(104, 104),
        reason: 'spec 3.1：拖动直径 104dp');

    await gesture.up();
    await tester.pump();
    await pumpUntilOverlay(tester);
    expect(orb, findsNothing, reason: '捕获和选区期间球隐藏');
    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.getSize(orb), const Size(56, 56));
    expect(tester.getRect(orb), docked, reason: '取消不改变停靠位置');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('系统减少动态效果：直接进入104dp拖动态，选区流程不受影响', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(Builder(builder: (BuildContext ctx) {
      return MediaQuery(
        data: MediaQuery.of(ctx).copyWith(disableAnimations: true),
        child: MaterialApp(
          home: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.test',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.viewport,
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: captureMockClient(),
            child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
          ),
        ),
      );
    }));
    await tester.pump();

    final Finder orb = find.byKey(const Key('feedback-orb'));
    expect(tester.getSize(orb), const Size(56, 56),
        reason: 'spec 8.2：减少动态效果的基础直径为 56dp');

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(orb));
    await gesture.moveBy(const Offset(-40, -40));
    await gesture.moveBy(const Offset(-10, -10));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.getSize(orb), const Size(104, 104),
        reason: '减少动态效果直接进入活动态，不禁用截图');

    await gesture.up();
    await tester.pump();
    await pumpUntilOverlay(tester);
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsOneWidget,
        reason: '减少动态效果只取消动效，选区流程照常');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('指针拖向中央：144×144初始选区围绕可见球心并整体钳回边界', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    // 800×600、right20、bottom25%、直径56：球心 (800-20-28,600-150-28)。
    expect(tester.getCenter(find.byKey(const Key('feedback-orb'))),
        const Offset(752, 422));

    await dragOrbAndRelease(tester); // 3×(-40,-40) → 松手点 (632, 302)
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final CaptureSelectionOverlay widget =
        tester.widget(find.byType(CaptureSelectionOverlay));
    expect(widget.orbCenter, isNotNull);
    expect(widget.releasePoint, const Offset(632 / 800, 302 / 600));
    final Rect expected = Rect.fromCenter(
        center: Offset(widget.orbCenter!.dx.clamp(72, 728),
            widget.orbCenter!.dy.clamp(72, 528)),
        width: 144,
        height: 144);
    expect(overlay.selection, expected);
    expect(tester.getRect(find.byKey(const Key('feedback-capture-selection'))),
        expected,
        reason: '实际渲染与以可见球心展开的144px初始选区一致');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('拖到右下角：初始选区整体移回可见区域', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    // 球停靠在右下，向右下小步移动（贴边松手）。
    final TestGesture gesture = await tester
        .startGesture(tester.getCenter(find.byKey(const Key('feedback-orb'))));
    for (int i = 0; i < 6; i++) {
      await gesture.moveBy(const Offset(20, 20));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump();
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final Rect sel = overlay.selection;
    expect(sel.size, const Size(144, 144));
    expect(sel.left, greaterThanOrEqualTo(0));
    expect(sel.top, greaterThanOrEqualTo(0));
    expect(sel.right, 800, reason: '靠右 → 整体移回贴住右边界');
    expect(sel.bottom, lessThanOrEqualTo(600));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('选区交互：拖动移动、控制点缩放、背景重新框选，均不越界不小于最小值', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final TestGesture enlarge = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('feedback-capture-handle-2-2'))));
    await enlarge.moveBy(const Offset(55, 55));
    await enlarge.moveBy(const Offset(55, 55));
    await enlarge.up();
    await tester.pump();
    final Rect initial = overlay.selection;
    expect(initial.width, greaterThan(48));

    // ① 移动：在选区内拖动（多次位移事件）。
    final TestGesture move = await tester.startGesture(initial.center);
    // 步长需让手势在第 2 步被接受（pan slop 36），第 3 步作为有效更新。
    for (int i = 0; i < 3; i++) {
      await move.moveBy(const Offset(-20, -15));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await move.up();
    await tester.pump();
    final Rect moved = overlay.selection;
    expect(moved.size, initial.size, reason: '移动不改变尺寸');
    expect(moved.topLeft, isNot(initial.topLeft), reason: '移动改变了位置');

    // ② 缩放：拖右下控制点（锚点 (1,1) → key dx+1,dy+1 = 2-2）。
    final TestGesture resize = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('feedback-capture-handle-2-2'))));
    for (int i = 0; i < 3; i++) {
      await resize.moveBy(const Offset(-40, -40));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await resize.up();
    await tester.pump();
    final Rect resized = overlay.selection;
    expect(resized.width, lessThan(moved.width), reason: '缩放改变了尺寸');
    expect(resized.width, greaterThanOrEqualTo(kCaptureSelectionMinSize));
    expect(resized.height, greaterThanOrEqualTo(kCaptureSelectionMinSize));
    expect(resized.topLeft, moved.topLeft, reason: '对侧边缘固定');

    // ③ 重新框选：在选区外拖出一个新矩形。
    final TestGesture reframe = await tester.startGesture(const Offset(30, 60));
    for (int i = 0; i < 5; i++) {
      await reframe.moveBy(const Offset(40, 40));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await reframe.up();
    await tester.pump();
    final Rect reframed = overlay.selection;
    expect(reframed, isNot(resized), reason: '重新框选替换了选区');
    expect(reframed.width, greaterThanOrEqualTo(kCaptureSelectionMinSize));
    expect(reframed.height, greaterThanOrEqualTo(kCaptureSelectionMinSize));
    expect(reframed.left, greaterThanOrEqualTo(0));
    expect(reframed.top, greaterThanOrEqualTo(0));
    expect(reframed.right, lessThanOrEqualTo(800));
    expect(reframed.bottom, lessThanOrEqualTo(600));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('确认「使用此区域」：只提交选区内容，region 归一化，落点不变；灵感球不入图', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester); // (752,422)-3×(40,40)=(632,302)
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final Rect sel = overlay.selection;
    final CaptureSelectionOverlay widget =
        tester.widget(find.byType(CaptureSelectionOverlay));
    expect(
        sel,
        Rect.fromCenter(
            center: Offset(widget.orbCenter!.dx.clamp(72, 728),
                widget.orbCenter!.dy.clamp(72, 528)),
            width: 144,
            height: 144),
        reason: '初始选区以最后可见球心展开，元数据仍保留真实落点');

    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    final FeedbackPanelState panel = await _waitScreenshot(tester);

    final FeedbackCaptureInfo info = panel.captureInfo!;
    // viewport 语义不变（原始捕获视口），pixel 为选区裁剪后的最终输出。
    expect(info.viewportWidth, 800);
    expect(info.viewportHeight, 600);
    // 原有floor/ceil外扩保持：惯性球心带小数时输出可能多1px。
    final int pixelWidth = (sel.right * 2).ceil() - (sel.left * 2).floor();
    final int pixelHeight = (sel.bottom * 2).ceil() - (sel.top * 2).floor();
    expect(info.pixelWidth, pixelWidth, reason: '144逻辑宽 × scale 2，像素边界向外取整');
    expect(info.pixelHeight, pixelHeight, reason: '144逻辑高 × scale 2，像素边界向外取整');
    // 落点仍相对原始捕获视口 0..1。
    expect(info.releasePoint, const Offset(0.79, 302 / 600),
        reason: '(632/800,302/600)，仍相对原始捕获视口');
    // region 归一化。
    final FeedbackCaptureRegion region = info.region!;
    expect(region.x, closeTo(sel.left / 800, 1e-9));
    expect(region.y, closeTo(sel.top / 600, 1e-9), reason: '球心选区位置按原始视口归一化');
    expect(region.width, closeTo(144 / 800, 1e-9));
    expect(region.height, closeTo(144 / 600, 1e-9));
    expect(region.x + region.width, lessThanOrEqualTo(1.0));
    expect(region.y + region.height, lessThanOrEqualTo(1.0));

    // 输出位图仅为选区内容；工具栏/选区边框/灵感球均不入图。
    final DecodedPng img = await decodePng(panel.screenshotBytes!, tester);
    expect(img.width, pixelWidth);
    expect(img.height, pixelHeight);
    expectPixel(
        img.pixelAt(10, 10), const <int>[33, 150, 243, 255], '选区内应为宿主背景');
    // 选区输出倍率2，冻结图中的宿主蓝底保持不变。
    expectPixel(
        img.pixelAt(144, 144), const <int>[33, 150, 243, 255], '灵感球不在冻结位图内');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('确认「截取整个窗口」：整张冻结位图，region 省略', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    await tester.tap(find.byKey(const Key('feedback-capture-whole-window')));
    final FeedbackPanelState panel = await _waitScreenshot(tester);

    final FeedbackCaptureInfo info = panel.captureInfo!;
    expect(info.region, isNull, reason: '整窗捕获省略 region');
    expect(info.viewportWidth, 800);
    expect(info.viewportHeight, 600);
    expect(info.pixelWidth, 1600);
    expect(info.pixelHeight, 1200);
    final DecodedPng img = await decodePng(panel.screenshotBytes!, tester);
    expect(img.width, 1600);
    expect(img.height, 1200);
    expectPixel(img.pixelAt(10, 10), const <int>[33, 150, 243, 255], '整窗内容正常');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('取消：丢弃冻结画面、不打开面板、不写截图、不报失败', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    await tester.tap(find.byKey(const Key('feedback-capture-cancel')));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing,
        reason: '取消后覆盖层恢复');
    expect(controller.isOpen, isFalse, reason: '取消不打开面板（不报失败）');
    expect(find.byType(FeedbackPanel), findsNothing);
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsNothing);

    // 取消后组件仍可用：普通点击照常呼出（整窗截图）。
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    expect(panel.captureInfo?.region, isNull, reason: '普通点击为整窗截图');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('键盘：选区框获得焦点并可回车确认', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    expect(FocusManager.instance.primaryFocus?.debugLabel,
        'feedback-capture-frame',
        reason: '方向键与回车由选区框处理');

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    final FeedbackPanelState panel = await _waitScreenshot(tester);
    expect(panel.hasScreenshot, isTrue, reason: '回车应确认选区');
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('键盘：Esc 取消选区流程', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);
    expect(controller.isOpen, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('图片已达 5 张且无可替换截图：先提示整理附件，不发起捕获', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', <String, Object?>{
      'authenticated': true,
      'kind': 'client',
      'user': userJson(),
      'quota': quotaJson(),
      'capabilities': <String, Object?>{'dialogue': true, 'images': 5},
    });
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.test',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: FeedbackCaptureMode.viewport,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: server.client,
        imagePicker: () => List<FeedbackImageFile>.generate(
          5,
          (int i) => FeedbackImageFile(
            id: 'cap$i',
            filename: 'cap$i.png',
            bytes: kTinyPngBytes,
            mime: 'image/png',
          ),
        ),
        child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
      ),
    ));
    await tester.pump();

    // 打开面板并加满 5 张手动图片（无 capture 槽位）。
    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
    await pumpUntil(tester, () => panel.imageCount == 5);
    await tester.pump();
    expect(panel.canAcceptCapture, isFalse);
    controller.close();
    await tester.pump();

    // 拖动灵感球：不发起捕获（覆盖层不出现），打开面板并提示整理附件。
    await dragOrbAndRelease(tester);
    for (int i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing,
        reason: '达到上限不得发起捕获');
    expect(controller.isOpen, isTrue);
    expect(find.textContaining('图片附件已达 5 张上限'), findsOneWidget,
        reason: '先提示整理附件');
    expect(panel.hasScreenshot, isFalse);
    expect(panel.imageCount, 5, reason: '已有图片不受影响');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('捕获失败：提示可重试、绝不静默回退整屏截图；修复后重试成功且草稿不丢', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    Widget host({required bool broken}) => MaterialApp(
          home: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.test',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.viewport,
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: captureMockClient(),
            child: Stack(
              children: <Widget>[
                const Positioned.fill(child: ColoredBox(color: Colors.blue)),
                Positioned(
                  left: 100,
                  top: 100,
                  child: SizedBox(
                    width: 200,
                    height: 150,
                    child: FeedbackCaptureMask(
                      maskColor: const Color(0xFFFF0000),
                      child: broken
                          ? const ThrowingTransform(
                              child: SizedBox.expand(
                                  child: ColoredBox(color: Colors.red)))
                          : const ColoredBox(color: Colors.red),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
    await tester.pumpWidget(host(broken: true));
    await tester.pump();

    // 第一次拖动：遮挡几何失效 → 冻结捕获中止。
    await dragOrbAndRelease(tester);
    await pumpUntil(tester, () => controller.isOpen);
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasScreenshot, isFalse, reason: '失败绝不静默回退成整屏截图');
    expect(find.textContaining('截图失败'), findsOneWidget);
    controller.close();
    await tester.pump();

    // 修复几何后重试：同一流程可成功（会话可重试）。
    await tester.pumpWidget(host(broken: false));
    await tester.pump();
    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await _waitScreenshot(tester);
    expect(panel.hasScreenshot, isTrue, reason: '修复后重试成功');

    // 草稿在失败与重试之后仍可写、可保留。
    await tester.enterText(find.byKey(const Key('feedback-input')), '失败重试后的草稿');
    await tester.pump();
    expect(panel.hasDraft, isTrue);
    controller.close();
    await tester.pump();
    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '失败重试后的草稿',
        reason: '已有草稿不丢失');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('会话 / 身份失效：进行中的选区流程作废（冻结位图立即销毁）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsOneWidget);

    // 宿主身份（appId）变化 → 进行中流程作废。
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.other',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: FeedbackCaptureMode.viewport,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: captureMockClient(),
        child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
      ),
    ));
    await tester.pump();
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing,
        reason: '身份切换必须作废进行中的选区流程');
    expect(controller.isOpen, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('提交透传：metadata.capture 携带 region（0..1、相对原始捕获视口）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('POST /api/feedback',
        <String, Object?>{'feedbackId': 'f-region', 'status': 'received'}, 201);
    await pumpOrbHost(tester, controller, httpClient: server.client);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);
    final Rect selection = tester
        .state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay))
        .selection;
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await _waitScreenshot(tester);

    await tester.enterText(find.byKey(const Key('feedback-input')), '带局部截图的反馈');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await pumpUntil(tester, () => server.count('POST /api/feedback') == 1);

    final http.Request req =
        server.lastMatching('POST /api/feedback') as http.Request;
    final Map<String, Object?> meta = _multipartMetadata(req);
    final Map<String, Object?> capture =
        meta['capture'] as Map<String, Object?>;
    final Map<String, Object?> region =
        capture['region'] as Map<String, Object?>;
    expect(region.keys.toSet(), <String>{'x', 'y', 'width', 'height'});
    expect((region['x']! as double) + (region['width']! as double),
        lessThanOrEqualTo(1.0));
    expect((region['y']! as double) + (region['height']! as double),
        lessThanOrEqualTo(1.0));
    expect(capture['viewportWidth'], 800);
    expect(capture['viewportHeight'], 600);
    expect(capture['pixelWidth'],
        (selection.right * 2).ceil() - (selection.left * 2).floor());
    expect(capture['pixelHeight'],
        (selection.bottom * 2).ceil() - (selection.top * 2).floor());
    expect(region['x'], closeTo(selection.left / 800, 1e-9));
    expect(region['y'], closeTo(selection.top / 600, 1e-9));
    expect(region['width'], closeTo(144 / 800, 1e-9));
    expect(region['height'], closeTo(144 / 600, 1e-9));
    final Map<String, Object?> release =
        capture['releasePoint'] as Map<String, Object?>;
    expect(release['x'], 0.79, reason: '新松手点632 / 原始视口宽800');
    expect(release['y'], 302 / 600, reason: '新松手点302 / 原始视口高600');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });
}
