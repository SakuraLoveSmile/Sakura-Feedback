import 'dart:async';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

void main() {
  testWidgets('宿主身份变化会使进行中的截图失效', (tester) async {
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(captureHost(
      controller: controller,
      child: const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
    ));

    // 在首个 endOfFrame 放行前切换 appId，模拟宿主重建配置的时序窗口。
    unawaited(controller.captureAndOpen());
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.changed',
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
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();

    expect(controller.isOpen, isFalse);
    expect(find.byType(FeedbackPanel), findsNothing);
  });
}
