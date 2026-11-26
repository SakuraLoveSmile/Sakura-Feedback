// FB-LAYOUT-001：真实旋转、截图附件及系统键盘；HTTP/账号仅使用本地夹具。
import 'dart:async';
import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('手机横屏：全宽并列、实际旋转及登录设置操作', (tester) async {
    final controller = FeedbackController();
    int submissions = 0;
    final client = MockClient((request) async {
      Object body = <String, Object?>{};
      if (request.url.path == '/api/auth/session') {
        body = <String, Object?>{
          'authenticated': true,
          'kind': 'client',
          'user': {'id': 'layout', 'username': '横屏测试', 'role': 'user'},
          'quota': {
            'dailyLimit': 3,
            'used': 0,
            'remaining': 3,
            'resetAt': '2030-01-01T16:00:00Z',
          },
          'capabilities': {'dialogue': true, 'images': 5},
        };
      } else if (request.url.path == '/api/auth/login') {
        body = {'ok': true, 'token': 'device-history-token'};
      } else if (request.url.path == '/api/feedback/mine') {
        body = {'items': [], 'total': 0, 'page': 1, 'limit': 10};
      } else if (request.url.path == '/api/feedback/unread-summary') {
        body = {'unreadFeedbacksCount': 0, 'totalUnreadMessages': 0};
      } else if (request.method == 'POST' &&
          request.url.path == '/api/feedback') {
        submissions++;
      }
      return http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await SystemChrome.setPreferredOrientations(<DeviceOrientation>[]);
    });

    Future<void> settle() async {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 800)),
      );
      await tester.pumpAndSettle();
    }

    Future<void> rotate(DeviceOrientation orientation) async {
      await SystemChrome.setPreferredOrientations([orientation]);
      await settle();
    }

    Future<void> hideKeyboard() async {
      await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
      FocusManager.instance.primaryFocus?.unfocus();
      await settle();
    }

    void expectLoginImmediatelyVisible() {
      final bounds = tester.getRect(find.byType(FeedbackPanel));
      final scroll = tester.getRect(
        find.byKey(const Key('feedback-login-scroll')),
      );
      for (final name in [
        'feedback-login-username',
        'feedback-login-password',
        'feedback-login-submit',
        'feedback-login-cancel',
      ]) {
        final target = find.byKey(Key(name));
        expect(
          target.hitTestable(),
          findsOneWidget,
          reason: '$name 首次进入登录就必须可见，无需主动滚动',
        );
        final rect = tester.getRect(target);
        expect(rect.top, greaterThanOrEqualTo(bounds.top));
        expect(rect.bottom, lessThanOrEqualTo(bounds.bottom));
        if (name.endsWith('username') || name.endsWith('password')) {
          expect(rect.top, greaterThanOrEqualTo(scroll.top),
              reason: '$name 顶边完整可见：字段 $rect，可视区 $scroll');
          expect(rect.bottom, lessThanOrEqualTo(scroll.bottom),
              reason: '$name 底边完整可见：字段 $rect，可视区 $scroll');
        }
      }
      for (final label in ['用户名', '密码']) {
        final rect = tester.getRect(find.text(label));
        expect(rect.top, greaterThanOrEqualTo(scroll.top),
            reason: '登录标签「$label」应完整显示：$rect，可视区 $scroll');
      }
    }

    await rotate(DeviceOrientation.portraitUp);
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(colorSchemeSeed: const Color(0xFF0071E3)),
        home: FeedbackWidget(
          config: FeedbackConfig(
            'http://127.0.0.1:53947',
            'layout.device.test',
            appVersion: '0.17.0',
            pageLabel: '横屏验证',
            logProvider: () async => [
              FeedbackLogFile(
                filename: 'layout.log',
                bytes: Uint8List.fromList(utf8.encode('local layout fixture')),
              ),
            ],
          ),
          controller: controller,
          httpClient: client,
          tokenStore: MemoryTokenStore(),
          serverPrefStore: MemoryServerPrefStore(),
          child: const Scaffold(body: Center(child: Text('手机横屏截图验证'))),
        ),
      ),
    );
    await settle();
    // 截图等待 endOfFrame，必须继续泵帧，不能在 runAsync 里阻塞等待。
    unawaited(controller.captureAndOpen());
    for (int i = 0; i < 20 && !controller.isOpen; i++) {
      await settle();
    }
    expect(controller.isOpen, isTrue);
    await settle();
    final panel = tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    expect(panel.hasScreenshot, isTrue);
    final bytes = Uint8List.fromList(panel.screenshotBytes!);
    final input = find.byKey(const Key('feedback-input'));
    await tester.enterText(input, '横竖切换后仍可继续编辑的反馈');
    await hideKeyboard();
    await rotate(DeviceOrientation.landscapeLeft);
    final viewport = tester.view.physicalSize / tester.view.devicePixelRatio;
    expect(viewport.width, greaterThan(viewport.height));
    expect(
      tester.getSize(find.byType(FeedbackPanel)).width,
      closeTo(viewport.width, 1),
    );
    final fieldRect = tester.getRect(input);
    final thumb = find.byKey(const Key('feedback-screenshot-thumb'));
    expect(tester.getRect(thumb).right, lessThan(fieldRect.left));
    expect(thumb.hitTestable(), findsOneWidget);
    expect(
      find.byKey(const Key('feedback-close')).hitTestable(),
      findsOneWidget,
    );
    await binding.convertFlutterSurfaceToImage();
    await tester.pump();
    await binding.takeScreenshot('landscape-compose');

    await tester.tap(input);
    await settle();
    expect(panel.draftFocused, isTrue);
    final keyboardTop =
        (tester.view.physicalSize.height - tester.view.viewInsets.bottom) /
        tester.view.devicePixelRatio;
    expect(
      tester.getRect(find.byKey(const Key('feedback-submit'))).bottom,
      lessThanOrEqualTo(keyboardTop),
    );
    await binding.takeScreenshot('landscape-keyboard');
    await rotate(DeviceOrientation.portraitUp);
    expect(panel.draftFocused, isTrue);
    expect(tester.widget<TextField>(input).controller!.text, '横竖切换后仍可继续编辑的反馈');
    expect(panel.screenshotBytes, orderedEquals(bytes));
    await hideKeyboard();
    await binding.takeScreenshot('portrait-preserved');
    await rotate(DeviceOrientation.landscapeRight);
    expect(thumb.hitTestable(), findsOneWidget);
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await settle();
    expectLoginImmediatelyVisible();
    await binding.takeScreenshot('landscape-login-keyboard');
    await tester.enterText(
      find.byKey(const Key('feedback-login-username')),
      'layout-test',
    );
    await tester.enterText(
      find.byKey(const Key('feedback-login-password')),
      'local-layout-test',
    );
    await rotate(DeviceOrientation.portraitUp);
    expect(panel.passwordFocused, isTrue);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('feedback-login-username')))
          .controller!
          .text,
      'layout-test',
    );
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('feedback-login-password')))
          .controller!
          .text,
      'local-layout-test',
    );
    await hideKeyboard();
    await rotate(DeviceOrientation.landscapeLeft);
    expectLoginImmediatelyVisible();
    await binding.takeScreenshot('landscape-login');
    await tester.tap(find.byKey(const Key('feedback-login-cancel')));
    await settle();
    expect(tester.widget<TextField>(input).controller!.text, '横竖切换后仍可继续编辑的反馈');
    expect(panel.screenshotBytes, orderedEquals(bytes));
    await tester.tap(find.byKey(const Key('tab-history')));
    await settle();
    expectLoginImmediatelyVisible();
    expect(
      find.descendant(
        of: find.byKey(const Key('feedback-login-submit')),
        matching: find.text('登录'),
      ),
      findsOneWidget,
    );
    await binding.takeScreenshot('landscape-history-login-keyboard');
    await tester.enterText(
      find.byKey(const Key('feedback-login-username')),
      'layout-test',
    );
    await tester.enterText(
      find.byKey(const Key('feedback-login-password')),
      'local-layout-test',
    );
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await settle();
    expect(find.text('暂无反馈记录'), findsOneWidget);
    expect(submissions, 0);
    await binding.takeScreenshot('landscape-history');
    await hideKeyboard();
    await tester.tap(find.byKey(const Key('feedback-settings')));
    await settle();
    final serverInput = find.byKey(const Key('feedback-server-input'));
    await tester.ensureVisible(serverInput);
    await tester.tap(serverInput);
    await settle();
    expect(serverInput.hitTestable(), findsOneWidget);
    final save = find.byKey(const Key('feedback-server-save'));
    await tester.ensureVisible(save);
    await settle();
    expect(save.hitTestable(), findsOneWidget);
    await hideKeyboard();
    await binding.takeScreenshot('landscape-settings');
    expect(submissions, 0);
    expect(tester.takeException(), isNull);
  });
}
