// T1 验收：拖动灵感球 → 冻结已遮挡画面 → 调整选区 → 确认 → 填写反馈。
//
// 覆盖：
// 1. 初始选区计算（中央 / 四角 / 靠边 / 安全区 / 最小 48×48）；
// 2. 选区移动、八点缩放、重新框选的边界钳制；
// 3. `capture.region` 归一化（0..1、相对原始捕获视口、x+width≤1）与
//    提交 metadata 透传、整窗省略、旧提交（无 region）兼容；
// 4. 5 张上限先提示整理附件、取消（含 Esc）、回车确认、失败可重试且绝不
//    静默回退整屏截图、会话/身份失效作废进行中流程、已有草稿不丢失。

import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_selection.dart';
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
  final TestGesture gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const Key('feedback-orb'))));
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
  await tester.pump();
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
  return tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
}

/// 解析 multipart 请求正文中的 `metadata` 字段。
Map<String, Object?> _multipartMetadata(http.Request req) {
  final String contentType = req.headers['content-type'] ?? '';
  final String boundary =
      RegExp(r'boundary=([^;]+)').firstMatch(contentType)!.group(1)!;
  final List<String> parts = latin1.decode(req.bodyBytes).split('--$boundary');
  final String metaPart = parts
      .firstWhere((String p) => p.contains('name="metadata"'));
  final String raw =
      metaPart.substring(metaPart.indexOf('\r\n\r\n') + 4).trim();
  return jsonDecode(utf8.decode(latin1.encode(raw))) as Map<String, Object?>;
}

void main() {
  group('T1-1：初始选区与钳制（纯函数）', () {
    test('中央：min(400, 屏宽×80%) × min(260, 屏高×40%)，中心为松手点', () {
      final Rect r = initialCaptureSelection(
        viewport: const Size(800, 600),
        center: const Offset(400, 300),
      );
      expect(r, const Rect.fromLTWH(200, 180, 400, 240));
    });

    test('超大视口取上限 400×260', () {
      final Rect r = initialCaptureSelection(
        viewport: const Size(2000, 1600),
        center: const Offset(1000, 800),
      );
      expect(r.width, 400);
      expect(r.height, 260);
    });

    test('四角与靠边：整体移回可见区域（不越界）', () {
      const Size v = Size(800, 600);
      final Rect topLeft =
          initialCaptureSelection(viewport: v, center: Offset.zero);
      expect(topLeft.left, 0);
      expect(topLeft.top, 0);

      final Rect bottomRight =
          initialCaptureSelection(viewport: v, center: const Offset(800, 600));
      expect(bottomRight.right, 800);
      expect(bottomRight.bottom, 600);

      final Rect leftEdge =
          initialCaptureSelection(viewport: v, center: const Offset(10, 300));
      expect(leftEdge.left, 0);
      expect(leftEdge.right, 400);

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
      }
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
        region: FeedbackCaptureRegion(
            x: 0.1, y: 0.2, width: 0.3, height: 0.4),
      );
      expect(
          withRegion.toJson()['region'],
          <String, Object?>{
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

  testWidgets('灵感球视觉：静止 56dp、拖动中 84dp、松手回停靠位', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    final Finder orb = find.byKey(const Key('feedback-orb'));
    final Rect docked = tester.getRect(orb);
    expect(tester.getSize(orb), const Size(56, 56), reason: 'spec 3.1：静止直径 56dp');

    final TestGesture gesture = await tester.startGesture(tester.getCenter(orb));
    await gesture.moveBy(const Offset(-40, -40)); // 跨过 pan slop（被接受）
    await gesture.moveBy(const Offset(-10, -10)); // 有效更新 → 拖动态（>8dp）
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300)); // 动效 220ms 完成
    expect(tester.getSize(orb), const Size(84, 84), reason: 'spec 3.1：拖动直径 84dp');

    await gesture.up();
    await tester.pump();
    // spec 3.1/5：松手回弹改为 460ms，500ms 后断言精确归位。
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.getSize(orb), const Size(56, 56), reason: 'spec 7.1：松手复位 56dp');
    expect(tester.getRect(orb), docked,
        reason: '截图定位绝不更改停靠位置（位移归零）');
    // 拖动松手 → 进入选区流程（而不是直接写草稿）。
    expect(
        find.byKey(const Key('feedback-capture-selection-overlay')),
        findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('系统减少动态效果：拖动取消缩放（恒 56dp），选区流程不受影响',
      (tester) async {
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

    final TestGesture gesture = await tester.startGesture(tester.getCenter(orb));
    await gesture.moveBy(const Offset(-40, -40));
    await gesture.moveBy(const Offset(-10, -10));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.getSize(orb), const Size(56, 56),
        reason: 'spec 8.2：拖动也保持 56dp（不展开 84dp）');

    await gesture.up();
    await tester.pump();
    await pumpUntilOverlay(tester);
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsOneWidget,
        reason: '减少动态效果只取消动效，选区流程照常');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('拖到中央：初始选区居中于松手点（800×600 → 400×240，靠边整体移回）',
      (tester) async {
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
    // (632,302)±(200,120) → (432,182)-(832,422)，向左钳回32px。
    expect(overlay.selection, const Rect.fromLTWH(400, 182, 400, 240));
    expect(
        tester.getRect(find.byKey(const Key('feedback-capture-selection'))),
        const Rect.fromLTWH(400, 182, 400, 240),
        reason: '右侧钳回到800，top=302-120=182；实际渲染与计算一致');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('拖到右下角：初始选区整体移回可见区域', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    // 球停靠在右下，向右下小步移动（贴边松手）。
    final TestGesture gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('feedback-orb'))));
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
    expect(sel.width, 400);
    expect(sel.height, 240);
    expect(sel.left, greaterThanOrEqualTo(0));
    expect(sel.top, greaterThanOrEqualTo(0));
    expect(sel.right, 800, reason: '靠右 → 整体移回贴住右边界');
    expect(sel.bottom, lessThanOrEqualTo(600));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('选区交互：拖动移动、控制点缩放、背景重新框选，均不越界不小于最小值',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final Rect initial = overlay.selection;

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
    final TestGesture resize = await tester.startGesture(tester
        .getCenter(find.byKey(const Key('feedback-capture-handle-2-2'))));
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

  testWidgets('确认「使用此区域」：只提交选区内容，region 归一化，落点不变；灵感球不入图',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester); // (752,422)-3×(40,40)=(632,302)
    await pumpUntilOverlay(tester);

    final CaptureSelectionOverlayState overlay =
        tester.state<CaptureSelectionOverlayState>(
            find.byType(CaptureSelectionOverlay));
    final Rect sel = overlay.selection;
    expect(sel, const Rect.fromLTWH(400, 182, 400, 240),
        reason: '松手点(632,302)，400×240选区右侧钳回；top=302-120');

    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    final FeedbackPanelState panel = await _waitScreenshot(tester);

    final FeedbackCaptureInfo info = panel.captureInfo!;
    // viewport 语义不变（原始捕获视口），pixel 为选区裁剪后的最终输出。
    expect(info.viewportWidth, 800);
    expect(info.viewportHeight, 600);
    expect(info.pixelWidth, 800, reason: '400 逻辑宽 × scale 2');
    expect(info.pixelHeight, 480, reason: '240 逻辑高 × scale 2');
    // 落点仍相对原始捕获视口 0..1。
    expect(info.releasePoint, const Offset(0.79, 302 / 600),
        reason: '(632/800,302/600)，仍相对原始捕获视口');
    // region 归一化。
    final FeedbackCaptureRegion region = info.region!;
    expect(region.x, closeTo(400 / 800, 1e-9));
    expect(region.y, closeTo(182 / 600, 1e-9),
        reason: '新选区top=182，归一化分母仍为原始视口高600');
    expect(region.width, closeTo(0.5, 1e-9));
    expect(region.height, closeTo(0.4, 1e-9));
    expect(region.x + region.width, lessThanOrEqualTo(1.0));
    expect(region.y + region.height, lessThanOrEqualTo(1.0));

    // 输出位图 = 选区内容（800×480）；工具栏/选区边框/灵感球均不入图。
    final DecodedPng img = await decodePng(panel.screenshotBytes!, tester);
    expect(img.width, 800);
    expect(img.height, 480);
    expectPixel(img.pixelAt(10, 10), const <int>[33, 150, 243, 255],
        '选区内应为宿主背景');
    // 球心(752,422)，选区左上(400,182)：保留球心上方10dp取样，输出倍率2。
    expectPixel(img.pixelAt((752 - 400) * 2, (422 - 182 - 10) * 2),
        const <int>[33, 150, 243, 255], '灵感球不在冻结位图内');

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
    expectPixel(img.pixelAt(10, 10), const <int>[33, 150, 243, 255],
        '整窗内容正常');

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

  testWidgets('键盘：回车确认（焦点在「使用此区域」）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpOrbHost(tester, controller);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);

    final FilledButton confirm = tester
        .widget<FilledButton>(find.byKey(const Key('feedback-capture-use-region')));
    expect(confirm.autofocus, isTrue, reason: '确认按钮自动聚焦（焦点清晰）');

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

  testWidgets('捕获失败：提示可重试、绝不静默回退整屏截图；修复后重试成功且草稿不丢',
      (tester) async {
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
    expect(
        find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasScreenshot, isFalse,
        reason: '失败绝不静默回退成整屏截图');
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

  testWidgets('会话 / 身份失效：进行中的选区流程作废（冻结位图立即销毁）',
      (tester) async {
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

  testWidgets('提交透传：metadata.capture 携带 region（0..1、相对原始捕获视口）',
      (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('POST /api/feedback',
        <String, Object?>{'feedbackId': 'f-region', 'status': 'received'}, 201);
    await pumpOrbHost(tester, controller, httpClient: server.client);

    await dragOrbAndRelease(tester);
    await pumpUntilOverlay(tester);
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await _waitScreenshot(tester);

    await tester.enterText(
        find.byKey(const Key('feedback-input')), '带局部截图的反馈');
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
    expect(capture['pixelWidth'], 800);
    expect(capture['pixelHeight'], 480);
    final Map<String, Object?> release =
        capture['releasePoint'] as Map<String, Object?>;
    expect(release['x'], 0.79, reason: '新松手点632 / 原始视口宽800');
    expect(release['y'], 302 / 600, reason: '新松手点302 / 原始视口高600');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });
}
