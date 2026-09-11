import 'dart:async';
import 'dart:math' as math;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 计划 5.1 Flutter 像素级遮挡回归：
/// 截图 PNG 解码后逐像素断言——敏感区被**不透明**遮罩覆盖、周围布局正确；
/// 不是只断言"调用了遮挡函数"。
///
/// 测试表面 800x600（默认 dpr=3）：
/// scale = min(dpr, 2, 2048/最长逻辑边, sqrt(4000000/逻辑面积))
///       = min(3, 2, 2.56, 2.89) = 2 → 输出 1600x1200。
void main() {
  // Colors.blue = 0xFF2196F3 → RGBA [33, 150, 243, 255]
  const List<int> kBlueRgba = <int>[33, 150, 243, 255];
  const List<int> kRedRgba = <int>[255, 0, 0, 255];
  const List<int> kGreenRgba = <int>[0, 255, 0, 255];
  const List<int> kGrayRgba = <int>[0x6E, 0x6E, 0x73, 255];

  Future<void> pumpFullScreen(
    WidgetTester tester,
    FeedbackController controller,
    Widget child,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(controller: controller, child: child));
    await tester.pump();
  }

  testWidgets('矩形遮挡：遮罩不透明覆盖敏感区，周围布局正确、无泄漏', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpFullScreen(
      tester,
      controller,
      Stack(
        children: <Widget>[
          const Positioned.fill(child: ColoredBox(color: Colors.blue)),
          Positioned(
            left: 100,
            top: 100,
            child: SizedBox(
              width: 200,
              height: 150,
              child: FeedbackCaptureMask(
                // 半透明红：绘制取 RGB 并强制 alpha=0xFF → 纯红不透明。
                maskColor: const Color(0x80FF0000),
                child: Container(
                  color: Colors.red,
                  child: const Text('password: hunter2'),
                ),
              ),
            ),
          ),
        ],
      ),
    );

    final panel = await captureAndWait(tester, controller);
    final img = await decodePng(panel.screenshotBytes!, tester);
    expect(img.width, 1600);
    expect(img.height, 1200);

    // 遮挡内部：纯红（maskColor RGB）、alpha 255（强制不透明）。
    expectPixel(img.pixelAt(300, 350), kRedRgba, '遮挡中心应为不透明纯红');
    // 遮挡边界内圈（含向外取整 + 外扩 1px 的覆盖范围）：
    // 逻辑矩形 (100,100)-(300,250) → 输出 px [199,601]x[199,501]。
    expectPixel(img.pixelAt(205, 205), kRedRgba, '左上内圈应被覆盖');
    expectPixel(img.pixelAt(595, 495), kRedRgba, '右下内圈应被覆盖');
    // 周围布局正确：背景蓝、无遮罩泄漏、无敏感内容泄漏。
    expectPixel(img.pixelAt(50, 50), kBlueRgba, '遮挡外背景应保持蓝色');
    expectPixel(img.pixelAt(700, 350), kBlueRgba, '遮挡右侧紧邻处不应有红色');
    expectPixel(img.pixelAt(400, 1120), kBlueRgba, '遮挡下方不应有红色');
    expectPixel(img.pixelAt(1400, 600), kBlueRgba, '遮挡右侧远处不应有红色');
  });

  testWidgets('透明遮挡色（alpha=0）仍被强制为不透明绘制', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpFullScreen(
      tester,
      controller,
      Stack(
        children: <Widget>[
          const Positioned.fill(child: ColoredBox(color: Colors.blue)),
          Positioned(
            left: 100,
            top: 100,
            child: SizedBox(
              width: 200,
              height: 150,
              child: FeedbackCaptureMask(
                maskColor: const Color(0x0000FF00), // 全透明绿
                child: Container(color: Colors.green),
              ),
            ),
          ),
        ],
      ),
    );

    final panel = await captureAndWait(tester, controller);
    final img = await decodePng(panel.screenshotBytes!, tester);
    expectPixel(img.pixelAt(300, 350), kGreenRgba, '透明遮罩色应取 RGB 强制不透明');
    expectPixel(img.pixelAt(50, 50), kBlueRgba, '周围背景不受影响');
  });

  testWidgets('旋转/缩放/嵌套变换：轴对齐包围盒允许多遮、不允许少遮', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpFullScreen(
      tester,
      controller,
      ColoredBox(
        color: Colors.blue,
        child: Center(
          child: FeedbackCaptureMask(
            maskColor: const Color(0xFFFF0000),
            child: Transform.rotate(
              angle: math.pi / 4,
              child: Transform.scale(
                scale: 2.0,
                child: SizedBox(
                  width: 50,
                  height: 50,
                  child: Container(color: Colors.red),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    final panel = await captureAndWait(tester, controller);
    final img = await decodePng(panel.screenshotBytes!, tester);
    // 100x100 方块旋转 45°：外接 AABB 半径 70.71 逻辑像素 → 输出 px
    // AABB 半宽 ≈ 141.4 + 1 外扩。中心 (800,600)。
    expectPixel(img.pixelAt(800, 600), kRedRgba, '旋转方块中心应被覆盖');
    // (930,730)：位于 AABB 内（dx=dy=130 <= ~142）但旋转方块本身不覆盖
    // （|x|+|y|=260 > 141.4）→ 该点应被遮罩为红，证明"允许多遮"。
    expectPixel(img.pixelAt(930, 730), kRedRgba, 'AABB 内非方块区域也应被多遮覆盖');
    // AABB 外（dx=180 > 142.4+1）：不应有红色泄漏（少遮会在此露出红内容）。
    expectPixel(img.pixelAt(980, 600), kBlueRgba, 'AABB 外不应有红色内容泄漏');
    expectPixel(img.pixelAt(600, 600), kBlueRgba, 'AABB 左外侧不应有红色泄漏');
  });

  testWidgets('obscureText 输入区域被中性遮罩保护', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const ColoredBox(
        color: Colors.blue,
        child: Center(
          child: SizedBox(
            width: 300,
            height: 60,
            child: Material(
              child: TextField(
                key: Key('obscure-input'),
                obscureText: true,
                decoration: InputDecoration(
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(),
                ),
              ),
            ),
          ),
        ),
      ),
    ));
    // 输入敏感文本（标准 obscureText 输入）。
    await tester.enterText(
        find.byKey(const Key('obscure-input')), 'secret-password');
    await tester.pump();

    final panel = await captureAndWait(tester, controller);
    final img = await decodePng(panel.screenshotBytes!, tester);
    // 输入框中心应为默认中性灰 #6E6E73（不透明）。
    final Offset center =
        tester.getCenter(find.byKey(const Key('obscure-input')));
    expectPixel(
      img.pixelAt((center.dx * 2).round(), (center.dy * 2).round()),
      kGrayRgba,
      'obscureText 输入区中心应为不透明中性灰',
    );
    // 输入框外背景保持蓝色（保护范围不溢出）。
    expectPixel(img.pixelAt(400, 100), kBlueRgba, '输入框外背景应保持蓝色');
  });

  testWidgets('两个组件实例互不影响：各自截图只应用各自作用域的遮挡', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controllerA = FeedbackController();
    final controllerB = FeedbackController();
    addTearDown(controllerA.dispose);
    addTearDown(controllerB.dispose);
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 400,
              height: 600,
              child: captureHost(
                controller: controllerA,
                child: Stack(
                  children: <Widget>[
                    const Positioned.fill(
                        child: ColoredBox(color: Colors.blue)),
                    Positioned(
                      left: 50,
                      top: 50,
                      child: SizedBox(
                        width: 100,
                        height: 100,
                        child: FeedbackCaptureMask(
                          maskColor: const Color(0xFFFF0000),
                          child: Container(color: Colors.red),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(
              width: 400,
              height: 600,
              child: captureHost(
                controller: controllerB,
                child: const SizedBox.expand(
                    child: ColoredBox(color: Colors.blue)),
              ),
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    // 实例 A 截图：遮挡生效。
    final panelA = await captureAndWait(tester, controllerA);
    final imgA = await decodePng(panelA.screenshotBytes!, tester);
    expect(imgA.width, 800); // 400x600 @ scale 2
    expectPixel(imgA.pixelAt(200, 200), kRedRgba, '实例 A 的遮挡应生效');
    expectPixel(imgA.pixelAt(40, 40), kBlueRgba, '实例 A 遮挡外背景蓝色');

    // 实例 B 截图：同一逻辑位置不应出现 A 的红色遮挡（无跨实例泄漏）。
    // 先收起 A 的面板，避免干扰后续查找。
    controllerA.close();
    await tester.pump();
    final panelB = await captureAndWait(tester, controllerB);
    final imgB = await decodePng(panelB.screenshotBytes!, tester);
    expectPixel(imgB.pixelAt(200, 200), kBlueRgba, '实例 B 同位置不应被实例 A 的遮挡影响');
  });

  testWidgets('必需遮挡几何失效：中止截图、无新预览、旧截图保留', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpFullScreen(
      tester,
      controller,
      Stack(
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
                child: Container(color: Colors.red),
              ),
            ),
          ),
        ],
      ),
    );

    // 第一次截图成功。
    FeedbackPanelState panel = await captureAndWait(tester, controller);
    final Uint8List oldBytes = panel.screenshotBytes!;
    expect(oldBytes, isNotEmpty);

    // 重建宿主：遮挡渲染框 getTransformTo 永远抛出（几何失效）。
    await tester.pumpWidget(captureHost(
      controller: controller,
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
                child: ThrowingTransform(
                  child: Container(color: Colors.red),
                ),
              ),
            ),
          ),
        ],
      ),
    ));
    await tester.pump();
    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

    // 重拍：几何失效 → 必须中止截图，旧截图保留（失败不丢旧图）。
    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    for (int i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
      if (find
              .byKey(const Key('feedback-screenshot-wrap'))
              .evaluate()
              .isNotEmpty &&
          panel.hasScreenshot &&
          listEquals<int>(panel.screenshotBytes, oldBytes)) {
        break;
      }
    }
    expect(panel.hasScreenshot, isTrue, reason: '几何失效中止截图后旧截图必须保留');
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isTrue,
        reason: '重拍失败不得替换旧截图');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget,
        reason: '无新预览：面板仍展示旧截图');

    // 修好几何且布局变化（遮挡移位）后再重拍：成功替换为新内容。
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: Stack(
        children: <Widget>[
          const Positioned.fill(child: ColoredBox(color: Colors.blue)),
          Positioned(
            left: 500,
            top: 300,
            child: SizedBox(
              width: 200,
              height: 150,
              child: FeedbackCaptureMask(
                maskColor: const Color(0xFFFF0000),
                child: Container(color: Colors.red),
              ),
            ),
          ),
        ],
      ),
    ));
    await tester.pump();
    panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    final String before = panel.captureInfo?.capturedAt ?? '';
    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await pumpUntil(
        tester,
        () =>
            panel.captureInfo != null &&
            panel.captureInfo!.capturedAt != before);
    expect(listEquals<int>(panel.screenshotBytes, oldBytes), isFalse,
        reason: '几何恢复后重拍应成功替换旧截图');
    // 新截图按新布局渲染：新遮挡位置为不透明红，旧遮挡位置为蓝色。
    final imgNew = await decodePng(panel.screenshotBytes!, tester);
    expectPixel(imgNew.pixelAt(600 * 2, 375 * 2), kRedRgba, '新遮挡位置应被覆盖');
    expectPixel(imgNew.pixelAt(200 * 2, 175 * 2), kBlueRgba, '旧遮挡位置应为背景');
  });

  testWidgets('初始捕获即几何失效：面板打开但无截图预览', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const ColoredBox(
        color: Colors.blue,
        child: Center(
          child: FeedbackCaptureMask(
            child: ThrowingTransform(child: SizedBox(width: 50, height: 50)),
          ),
        ),
      ),
    ));
    await tester.pump();

    unawaited(controller.captureAndOpen());
    await tester.pump();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasScreenshot, isFalse, reason: '几何失效不得产出任何截图预览');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsNothing);
    // 文字反馈仍然可用（可输入草稿）。
    await tester.enterText(find.byKey(const Key('feedback-input')), '纯文字反馈');
    await tester.pump();
    expect(panel.hasDraft, isTrue);
  });

  testWidgets('统一图片限制边界：大视口按公式缩放到 2048 长边以内', (tester) async {
    // 1400x800：scale = min(3, 2, 2048/1400, sqrt(4M/1.12M)) = min(2, 1.463, 1.889) ≈ 1.4629
    // → 输出 ≈ 2048x1170（最长边恰为 2048 上限）。
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));
    await tester.pump();

    final panel = await captureAndWait(tester, controller);
    final info = panel.captureInfo!;
    expect(info.viewportWidth, 1400, reason: '元数据区分逻辑视口尺寸');
    expect(info.viewportHeight, 800);
    expect(info.pixelWidth, 2048, reason: '输出像素最长边恰为 2048 上限');
    expect(info.pixelHeight, closeTo(1170, 2), reason: '输出像素按同一 scale 等比缩放');
    final img = await decodePng(panel.screenshotBytes!, tester);
    expect(img.width, info.pixelWidth);
    expect(img.height, info.pixelHeight);
  });

  testWidgets('统一图片限制边界：超过 400 万总像素时按面积上限缩放', (tester) async {
    // 1400x1400：scale = min(2, 2048/1400≈1.463, sqrt(4M/1960000)≈1.4286) ≈ 1.4286
    // → 输出 2000x2000（200 万像素，面积约束生效）。
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(1400, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));
    await tester.pump();

    final panel = await captureAndWait(tester, controller);
    final info = panel.captureInfo!;
    expect(info.pixelWidth, 2000);
    expect(info.pixelHeight, 2000);
  });

  testWidgets('统一图片限制边界：dpr 上限 2（小视口也最多 2 倍输出）', (tester) async {
    // 500x400：scale = min(3, 2, 2048/500, sqrt(4M/200000)) = 2 → 1000x800。
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(500, 400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));
    await tester.pump();

    final panel = await captureAndWait(tester, controller);
    expect(panel.captureInfo!.pixelWidth, 1000);
    expect(panel.captureInfo!.pixelHeight, 800);
  });
}
