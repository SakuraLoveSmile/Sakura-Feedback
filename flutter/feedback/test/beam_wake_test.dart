import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Widget _host(FeedbackController controller,
        {FeedbackCaptureMode capture = FeedbackCaptureMode.off}) =>
    MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          captureMode: capture,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: MockClient((http.Request request) async =>
            http.Response('{}', 404)),
        child: const Placeholder(),
      ),
    );

void main() {
  testWidgets('beam mode renders no persistent launcher and opens from the shortcut',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final FeedbackController controller = FeedbackController();
    await tester.pumpWidget(_host(controller));
    await tester.pump();
    expect(find.byKey(const Key('feedback-beam-a11y-slot')), findsOneWidget);
    expect(find.byKey(const Key('feedback-launcher-slot')), findsNothing);
    expect(find.byKey(const Key('feedback-capture-selection-overlay')),
        findsNothing);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
  });

  testWidgets('two-finger hold opens the plain panel when capture is off',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final FeedbackController controller = FeedbackController();
    await tester.pumpWidget(_host(controller));
    await tester.pump();

    final TestGesture first = await tester.startGesture(const Offset(140, 300));
    final TestGesture second = await tester.startGesture(const Offset(240, 300));
    await tester.pump(const Duration(milliseconds: 700));
    await first.up();
    await second.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
  });
}
