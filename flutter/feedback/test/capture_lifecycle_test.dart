import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'capture_test_utils.dart';

/// 计划 5.1 Flutter 生命周期回归：可控等待验证捕获会话——
/// 先截图后开面板、A/B 交错与过期结果丢弃、取消/关闭/销毁/控制器替换、
/// 普通呼出恢复草稿不重拍、重拍失败不丢旧图、临时资源全路径释放。
void main() {
  http.Client mockClient() => MockClient((request) async {
        return http.Response('{}', 404);
      });

  Future<void> pumpViewportHost(
    WidgetTester tester,
    FeedbackController controller,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      httpClient: mockClient(),
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));
    await tester.pump();
  }

  /// 等待计数稳定（纯 runAsync，不 pump 帧）。
  Future<void> waitCountersStable(
    WidgetTester tester,
    List<int Function()> getters,
  ) async {
    List<int> previous = getters.map((g) => g()).toList();
    int stableRounds = 0;
    for (int i = 0; i < 200 && stableRounds < 8; i++) {
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      final List<int> current = getters.map((g) => g()).toList();
      if (listEquals(current, previous)) {
        stableRounds++;
      } else {
        stableRounds = 0;
        previous = current;
      }
    }
  }

  testWidgets('先截图后开面板：触发即断言面板未展开，完成后才挂载并交付', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    unawaited(controller.captureAndOpen());
    // 同步断言：面板未展开（先截图后开面板）。
    expect(controller.isOpen, isFalse);
    expect(find.byType(FeedbackPanel), findsNothing);

    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    expect(panel.hasScreenshot, isTrue);
  });

  testWidgets('A/B 交错：B 使 A 失效，仅 B 交付（过期结果丢弃）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    unawaited(controller.captureAndOpen(releasePoint: const Offset(0.1, 0.1)));
    // 不等 A 完成，立即开始 B：B 的新会话使 A 失效。
    unawaited(controller.captureAndOpen(releasePoint: const Offset(0.9, 0.9)));
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);

    // 交付的是 B 的结果：落点为 B 的 releasePoint，A 的过期交付被丢弃。
    expect(panel.captureInfo?.releasePoint, const Offset(0.9, 0.9));
    // 只发生一次打开（A 失效后不再挂载面板）。
    expect(controller.isOpen, isTrue);
  });

  testWidgets('捕获中取消：静默失效，不报错、面板不展开，组件仍可用', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    unawaited(controller.captureAndOpen());
    await tester.pump(); // 捕获进行中。
    controller.cancelCapture(); // 用户取消：静默。
    await waitCountersStable(tester, <int Function()>[
      () => find.byType(FeedbackPanel).evaluate().length,
      () => controller.isOpen ? 1 : 0,
    ]);
    expect(controller.isOpen, isFalse, reason: '取消后捕获完成也不得挂载面板');
    expect(find.byType(FeedbackPanel), findsNothing);

    // 取消后组件仍可用。
    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
  });

  testWidgets('捕获中关闭面板：会话失效，捕获完成后不再打开', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    unawaited(controller.captureAndOpen());
    await tester.pump(); // 捕获进行中。
    controller.close(); // 宿主直接关闭（含 _onControllerChanged 兜底失效）。
    await waitCountersStable(tester, <int Function()>[
      () => controller.isOpen ? 1 : 0,
    ]);
    expect(controller.isOpen, isFalse);
    expect(find.byType(FeedbackPanel), findsNothing);
  });

  testWidgets('捕获中销毁组件：旧请求随销毁失效，无未处理异常', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    unawaited(controller.captureAndOpen());
    await tester.pump(); // 捕获进行中。
    await tester.pumpWidget(const SizedBox.shrink()); // 销毁组件。
    await waitCountersStable(tester, <int Function()>[
      () => controller.isOpen ? 1 : 0,
    ]);
    // 无异常即通过（测试框架会因未处理异常失败）。
  });

  testWidgets('控制器替换：旧控制器的进行中捕获失效，新控制器可用', (tester) async {
    final controllerA = FeedbackController();
    final controllerB = FeedbackController();
    addTearDown(controllerA.dispose);
    addTearDown(controllerB.dispose);
    await pumpViewportHost(tester, controllerA);

    unawaited(controllerA.captureAndOpen());
    await tester.pump(); // A 捕获进行中。
    await tester.pumpWidget(captureHost(
      controller: controllerB,
      httpClient: mockClient(),
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));
    await waitCountersStable(tester, <int Function()>[
      () => controllerA.isOpen ? 1 : 0,
      () => controllerB.isOpen ? 1 : 0,
    ]);
    expect(controllerA.isOpen, isFalse, reason: '旧捕获随控制器替换失效');
    expect(controllerB.isOpen, isFalse);
    expect(find.byType(FeedbackPanel), findsNothing);

    // 新控制器可用。
    controllerB.open();
    await pumpUntil(tester, () => controllerB.isOpen);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
  });

  testWidgets('普通呼出恢复草稿、不重拍（hasScreenshot 保持 false）', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await tester.enterText(find.byKey(const Key('feedback-input')), '未写完的草稿');
    await tester.pump();
    expect(panel.hasDraft, isTrue);

    controller.close();
    await tester.pump();
    controller.open();
    await pumpUntil(tester, () => controller.isOpen);
    await tester.pump();
    await tester.pump();
    // 草稿恢复，且不触发重拍：无截图交付。
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('feedback-input')))
          .controller!
          .text,
      '未写完的草稿',
    );
    expect(panel.hasScreenshot, isFalse, reason: '草稿恢复不得触发重拍');
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsNothing);
  });

  testWidgets('面板侧丢弃过期序号交付（防 post-frame 过期写入）', (tester) async {
    final GlobalKey<FeedbackPanelState> key = GlobalKey<FeedbackPanelState>();
    await tester.pumpWidget(MaterialApp(
      home: FeedbackPanel(
        key: key,
        config: FeedbackConfig('https://svc.test', 'com.example.test'),
        tokenStore: MemoryTokenStore('tok'),
        httpClient: mockClient(),
      ),
    ));
    await tester.pump(const Duration(seconds: 3));
    final FeedbackPanelState panel = key.currentState!;

    // 1x1 PNG（合法图片字节，避免 Image.memory 解码异常）。
    final Uint8List pngA = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    final Uint8List pngB = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

    panel.setScreenshot(
      pngA,
      const FeedbackCaptureInfo(capturedAt: 't5'),
      captureSeq: 5,
    );
    // 更低序号的交付视为过期：丢弃。
    panel.setScreenshot(
      pngB,
      const FeedbackCaptureInfo(capturedAt: 't4'),
      captureSeq: 4,
    );
    expect(listEquals<int>(panel.screenshotBytes, pngA), isTrue);
    expect(panel.captureInfo?.capturedAt, 't5');
    // 更高序号正常接受。
    panel.setScreenshot(
      pngB,
      const FeedbackCaptureInfo(capturedAt: 't6'),
      captureSeq: 6,
    );
    expect(listEquals<int>(panel.screenshotBytes, pngB), isTrue);
    expect(panel.captureInfo?.capturedAt, 't6');
    await tester.pump();
  });

  testWidgets('临时资源释放：成功捕获后 ui.Image/ui.Picture 全部释放', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    // 宿主带遮罩：捕获创建 source + 遮挡合成 composited 两张临时图像。
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      httpClient: mockClient(),
      child: Stack(
        children: <Widget>[
          const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
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
    ));
    await tester.pump();

    int imagesCreated = 0, imagesDisposed = 0;
    int picturesCreated = 0, picturesDisposed = 0;
    ui.Image.onCreate = (_) => imagesCreated++;
    ui.Image.onDispose = (_) => imagesDisposed++;
    ui.Picture.onCreate = (_) => picturesCreated++;
    ui.Picture.onDispose = (_) => picturesDisposed++;
    addTearDown(() {
      ui.Image.onCreate = null;
      ui.Image.onDispose = null;
      ui.Picture.onCreate = null;
      ui.Picture.onDispose = null;
    });

    // 基线：宿主已绘制一帧，先记基线再触发捕获。
    await tester.pump();
    final int baseImagesCreated = imagesCreated;
    final int baseImagesDisposed = imagesDisposed;
    final int basePicturesCreated = picturesCreated;
    final int basePicturesDisposed = picturesDisposed;

    unawaited(controller.captureAndOpen());
    await tester.pump(); // 等帧完成，捕获进入真实异步阶段。
    await pollPure(tester, () => controller.isOpen);

    // 捕获完成（source + 遮挡合成 composited）且 finally 已释放；
    // 此时 post-frame 交付尚未发生（无 Image.memory 解码噪声）。
    expect(imagesCreated - baseImagesCreated, greaterThanOrEqualTo(2),
        reason: '捕获应创建 source 与 composited 临时图像');
    expect(
        imagesDisposed - baseImagesDisposed, imagesCreated - baseImagesCreated,
        reason: '成功路径：所有临时 ui.Image 必须已释放');
    expect(picturesCreated - basePicturesCreated, greaterThanOrEqualTo(1),
        reason: '遮挡合成应创建 Picture');
    expect(picturesDisposed - basePicturesDisposed,
        picturesCreated - basePicturesCreated,
        reason: '成功路径：所有临时 ui.Picture 必须已释放');
  });

  testWidgets('临时资源释放：取消路径无泄漏', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await pumpViewportHost(tester, controller);

    int imagesCreated = 0, imagesDisposed = 0;
    int picturesCreated = 0, picturesDisposed = 0;
    ui.Image.onCreate = (_) => imagesCreated++;
    ui.Image.onDispose = (_) => imagesDisposed++;
    ui.Picture.onCreate = (_) => picturesCreated++;
    ui.Picture.onDispose = (_) => picturesDisposed++;
    addTearDown(() {
      ui.Image.onCreate = null;
      ui.Image.onDispose = null;
      ui.Picture.onCreate = null;
      ui.Picture.onDispose = null;
    });

    await tester.pump();
    final int baseImagesCreated = imagesCreated;
    final int baseImagesDisposed = imagesDisposed;
    final int basePicturesCreated = picturesCreated;
    final int basePicturesDisposed = picturesDisposed;

    unawaited(controller.captureAndOpen());
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();
    controller.cancelCapture();
    // 捕获自行中止：临时资源由 finally 释放。
    await waitCountersStable(tester, <int Function()>[
      () => imagesCreated,
      () => imagesDisposed,
      () => picturesCreated,
      () => picturesDisposed,
    ]);
    expect(
        imagesDisposed - baseImagesDisposed, imagesCreated - baseImagesCreated,
        reason: '取消路径：临时 ui.Image 必须全部释放');
    expect(picturesDisposed - basePicturesDisposed,
        picturesCreated - basePicturesCreated,
        reason: '取消路径：临时 ui.Picture 必须全部释放');
    expect(controller.isOpen, isFalse);
  });

  testWidgets('临时资源释放：几何失效中止路径无泄漏', (tester) async {
    final controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      httpClient: mockClient(),
      child: const Center(
        child: FeedbackCaptureMask(
          child: ThrowingTransform(child: SizedBox(width: 50, height: 50)),
        ),
      ),
    ));
    await tester.pump();

    int imagesCreated = 0, imagesDisposed = 0;
    int picturesCreated = 0, picturesDisposed = 0;
    ui.Image.onCreate = (_) => imagesCreated++;
    ui.Image.onDispose = (_) => imagesDisposed++;
    ui.Picture.onCreate = (_) => picturesCreated++;
    ui.Picture.onDispose = (_) => picturesDisposed++;
    addTearDown(() {
      ui.Image.onCreate = null;
      ui.Image.onDispose = null;
      ui.Picture.onCreate = null;
      ui.Picture.onDispose = null;
    });

    final int baseImagesCreated = imagesCreated;
    final int baseImagesDisposed = imagesDisposed;
    final int basePicturesCreated = picturesCreated;

    unawaited(controller.captureAndOpen());
    await tester.pump(); // 完成一帧：捕获进入几何收集并立即中止。
    await waitCountersStable(tester, <int Function()>[
      () => imagesCreated,
      () => imagesDisposed,
      () => picturesCreated,
      () => picturesDisposed,
      () => controller.isOpen ? 1 : 0,
    ]);
    // 中止发生在 toImage 之前：不创建任何临时图像 / Picture，也无泄漏。
    expect(imagesCreated - baseImagesCreated, 0,
        reason: '几何失效中止不得创建临时 ui.Image');
    expect(picturesCreated - basePicturesCreated, 0,
        reason: '几何失效中止不得创建临时 ui.Picture');
    expect(imagesDisposed - baseImagesDisposed, 0);
    expect(controller.isOpen, isTrue, reason: '面板仍打开，可继续文字反馈');
  });
}
