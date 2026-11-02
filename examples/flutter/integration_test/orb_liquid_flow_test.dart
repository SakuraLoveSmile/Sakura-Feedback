import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:feedback_example/orb_preview.dart' as preview;

void main() {
  final IntegrationTestWidgetsFlutterBinding binding =
      IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('液态球真机：倒影、选区、真实附件与草稿保留', (tester) async {
    Future<void> frames(int milliseconds) async {
      for (int elapsed = 0; elapsed < milliseconds; elapsed += 16) {
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    Future<void> until(Finder finder) async {
      for (int i = 0; i < 100 && finder.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(finder, findsOneWidget);
    }

    await SystemChrome.setPreferredOrientations(<DeviceOrientation>[
      DeviceOrientation.portraitUp,
    ]);
    addTearDown(
      () => SystemChrome.setPreferredOrientations(<DeviceOrientation>[]),
    );
    final FeedbackController previewController = FeedbackController();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      previewController.dispose();
    });
    runApp(
      FeedbackWidget(
        controller: previewController,
        tokenStore: MemoryTokenStore(),
        serverPrefStore: MemoryServerPrefStore(),
        config: preview.orbPreviewConfig,
        child: const preview.OrbPreviewPage(),
      ),
    );
    await frames(1400);
    await binding.convertFlutterSurfaceToImage();
    await tester.pump();
    final Finder orb = find.byKey(const Key('feedback-orb'));
    expect(orb, findsOneWidget);
    await until(find.byKey(const Key('feedback-orb-lens-shader')));
    await binding.takeScreenshot('android-orb-idle');

    final TestGesture drag = await tester.startGesture(tester.getCenter(orb));
    final Rect sample = tester.getRect(find.text('Aa Bb 0123456789\n灵感，从这里开始'));
    final Offset target = Offset(
      sample.left + sample.width * .55,
      sample.top + 18,
    );
    await drag.moveTo(target);
    await frames(280);
    await binding.takeScreenshot('android-orb-over-text');
    await drag.moveBy(const Offset(-95, 40));
    await frames(48);
    await binding.takeScreenshot('android-orb-liquid-turn');
    await drag.moveTo(tester.getCenter(find.byType(FeedbackCaptureMask)));
    await frames(500);
    await binding.takeScreenshot('android-orb-over-mask');
    await drag.moveTo(target);
    await frames(500);
    await drag.up();

    final Finder selection = find.byKey(
      const Key('feedback-capture-selection'),
    );
    await until(selection);
    await frames(650);
    expect(tester.getSize(selection).width, closeTo(144, .5));
    expect(tester.getSize(selection).height, closeTo(144, .5));
    await binding.takeScreenshot('android-selection-seed');
    final Finder corner = find.byKey(const Key('feedback-capture-handle-2-2'));
    expect(corner, findsOneWidget);
    await tester.drag(corner, const Offset(90, 70));
    await frames(150);
    expect(tester.getSize(selection).width, greaterThan(144));
    expect(tester.getSize(selection).height, greaterThan(144));
    await binding.takeScreenshot('android-selection-adjusted');
    await tester.tap(find.byKey(const Key('feedback-capture-use-region')));
    await frames(720);
    await binding.takeScreenshot('android-feedback-handoff');
    await frames(1100);

    final Finder input = find.byKey(const Key('feedback-input'));
    await until(input);
    expect(find.byKey(const Key('feedback-screenshot-thumb')), findsOneWidget);
    final FeedbackPanelState state = tester.state<FeedbackPanelState>(
      find.byType(FeedbackPanel),
    );
    final List<int> screenshot = List<int>.of(state.screenshotBytes!);
    await tester.enterText(input, '真机液态球与截图交接验证');
    await frames(100);
    await binding.takeScreenshot('android-feedback-ready');
    await tester.tap(find.byKey(const Key('feedback-close')));
    await frames(300);
    await until(find.byKey(const Key('feedback-orb-lens-shader')));
    await tester.tap(orb);
    await frames(400);
    expect(find.text('真机液态球与截图交接验证'), findsOneWidget);
    expect(state.screenshotBytes, orderedEquals(screenshot));
    await tester.ensureVisible(find.byKey(const Key('feedback-submit')));
    await tester.tap(find.byKey(const Key('feedback-submit')));
    final Finder username = find.byKey(const Key('feedback-login-username'));
    await until(username);
    await tester.enterText(username, 'orb-test');
    await tester.enterText(
      find.byKey(const Key('feedback-login-password')),
      'orb-local-test-20261101',
    );
    await tester.ensureVisible(find.byKey(const Key('feedback-login-submit')));
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await until(find.byKey(const Key('feedback-ticket-id')));
    await frames(250);
    await binding.takeScreenshot('android-local-submitted');
    expect(tester.takeException(), isNull);
    binding.reportData = <String, dynamic>{
      ...?binding.reportData,
      'deviceFlow':
          'drag, real shader, mask, selection, handoff, draft, local submit',
    };
  });
}
