import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 测试共用：宿主 MockClient（面板不做真实网络请求）。
http.Client captureMockClient() => MockClient((request) async {
      return http.Response('{}', 404);
    });

/// 测试共用：默认带 viewport 捕获模式的宿主。
Widget captureHost({
  required FeedbackController controller,
  required Widget child,
  http.Client? httpClient,
  FeedbackLauncherMode launcherMode = FeedbackLauncherMode.tab,
  FeedbackCaptureMode captureMode = FeedbackCaptureMode.viewport,
}) {
  return MaterialApp(
    home: FeedbackWidget(
      config: FeedbackConfig(
        'https://svc.test',
        'com.example.test',
        launcherMode: launcherMode,
        captureMode: captureMode,
      ),
      controller: controller,
      tokenStore: MemoryTokenStore('tok'),
      httpClient: httpClient ?? captureMockClient(),
      child: child,
    ),
  );
}

/// 等待条件成立：pump 前进帧 + runAsync 给真实异步（toImage/编码）时间。
Future<void> pumpUntil(WidgetTester tester, bool Function() cond) async {
  for (int i = 0; i < 200; i++) {
    if (cond()) return;
    await tester.pump(const Duration(milliseconds: 16));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
  }
  fail('pumpUntil 等待超时');
}

/// 纯 runAsync 等待（不 pump 帧）：用于在捕获完成后、post-frame 交付前
/// 断言临时资源计数，避免帧绘制的图片噪声。
Future<void> pollPure(WidgetTester tester, bool Function() cond) async {
  for (int i = 0; i < 200; i++) {
    if (cond()) return;
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });
  }
  fail('pollPure 等待超时');
}

/// 触发一次截图并等待交付完成（先截图后开面板：等待期间面板不展开）。
Future<FeedbackPanelState> captureAndWait(
  WidgetTester tester,
  FeedbackController controller, {
  Offset? releasePoint,
}) async {
  unawaited(controller.captureAndOpen(releasePoint: releasePoint));
  // 同步断言（无泵、无真实异步）：captureAndOpen 同步执行到首个 await
  // （等待 paint），此时面板必然尚未展开——先截图后开面板。
  expect(controller.isOpen, isFalse, reason: '先截图后开面板：捕获期间面板未展开');
  await tester.pump();
  await pumpUntil(tester, () => controller.isOpen);
  // 面板挂载 + post-frame 截图交付各需一帧。
  await tester.pump();
  await tester.pump();
  final FeedbackPanelState panel =
      tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
  await pumpUntil(tester, () => panel.hasScreenshot);
  await tester.pump();
  return panel;
}

/// 解码 PNG 为原始 RGBA 像素（供像素级断言）。
class DecodedPng {
  DecodedPng(this.width, this.height, this.rgba);

  final int width;
  final int height;
  final Uint8List rgba;

  /// 返回 [x, y] 处的 [r, g, b, a]。
  List<int> pixelAt(int x, int y) {
    final int o = (y * width + x) * 4;
    return <int>[rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
  }
}

Future<DecodedPng> decodePng(Uint8List png, WidgetTester tester) async {
  ui.Codec? codec;
  ui.Image? image;
  ByteData? data;
  int width = 0, height = 0;
  await tester.runAsync(() async {
    codec = await ui.instantiateImageCodec(png);
    final ui.FrameInfo frame = await codec!.getNextFrame();
    image = frame.image;
    width = image!.width;
    height = image!.height;
    data = await image!.toByteData(format: ui.ImageByteFormat.rawRgba);
  });
  image?.dispose();
  codec?.dispose();
  return DecodedPng(width, height, data!.buffer.asUint8List());
}

/// 几何失效的渲染框：已附着、已布局，但 `getTransformTo` 永远抛出——
/// 模拟"已注册且可能可见的遮挡区域计算失败"，必须中止截图。
class ThrowingTransform extends SingleChildRenderObjectWidget {
  const ThrowingTransform({super.key, required super.child});

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderThrowingTransform();
}

class _RenderThrowingTransform extends RenderProxyBox {
  @override
  Matrix4 getTransformTo(RenderObject? ancestor) {
    throw StateError('模拟遮挡几何失效');
  }
}

/// 便捷断言：rgba 相等。
void expectPixel(List<int> actual, List<int> expected, String why) {
  expect(actual, expected, reason: why);
}
