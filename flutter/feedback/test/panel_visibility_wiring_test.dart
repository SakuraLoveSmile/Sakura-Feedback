import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'capture_test_utils.dart';

/// T1 补修回归（宿主接线）：[FeedbackWidget] 必须把**真实开关状态**传给常驻
/// 面板——关闭 → 停止额度轮询，重新打开 → 立即刷新，而**截图期间暂时隐藏
/// 不算用户关闭**（不得据此取消登录接续或清除状态）。
void main() {
  late List<http.Request> requests;

  http.Client client() => MockClient((request) async {
        requests.add(request);
        final String path = Uri.parse(request.url.toString()).path;
        if (path == '/api/auth/session') {
          return http.Response(
            jsonEncode(<String, Object?>{
              'authenticated': true,
              'user': <String, Object?>{
                'id': 'u1',
                'username': 'admin',
                'role': 'user',
              },
              'quota': <String, Object?>{
                'dailyLimit': 3,
                'used': 0,
                'remaining': 3,
                'resetAt': '2030-01-01T16:00:00Z',
              },
            }),
            200,
            headers: const <String, String>{'content-type': 'application/json'},
          );
        }
        return http.Response('{}', 404);
      });

  int sessions() =>
      requests.where((r) => r.url.path == '/api/auth/session').length;

  Future<FeedbackController> pumpHost(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          captureMode: FeedbackCaptureMode.viewport,
        ),
        controller: controller,
        tokenStore: MemoryTokenStore('tok'),
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: client(),
        child: const SizedBox.expand(
          child: ColoredBox(color: Colors.blue),
        ),
      ),
    ));
    await tester.pump();
    return controller;
  }

  // 面板常驻（Visibility + maintainState）：关闭 / 截图期间隐藏时也留在树上，
  // 因此查找必须包含 offstage 子树。
  FeedbackPanel panelWidget(WidgetTester tester) =>
      tester.widget<FeedbackPanel>(find.byType(FeedbackPanel, skipOffstage: false));

  bool hiddenByVisibility(WidgetTester tester) {
    final Element panelEl =
        tester.element(find.byType(FeedbackPanel, skipOffstage: false));
    bool hidden = false;
    panelEl.visitAncestorElements((Element ancestor) {
      final Widget w = ancestor.widget;
      if (w is Visibility && !w.visible) {
        hidden = true;
        return false;
      }
      return true;
    });
    return hidden;
  }

  setUp(() {
    requests = <http.Request>[];
  });

  testWidgets('面板开关状态被真实传递：打开 → visible=true，关闭 → visible=false', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    expect(find.byType(FeedbackPanel), findsNothing); // 未打开过：尚未挂载

    controller.open();
    await tester.pump();
    expect(panelWidget(tester).visible, isTrue);

    controller.close();
    await tester.pump();
    expect(panelWidget(tester).visible, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('关闭面板不轮询额度；重新打开立即刷新（不是只请求输入焦点）', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    controller.open();
    await tester.pump();
    await tester.pump();
    expect(sessions(), 1); // 首次打开即刷新额度

    controller.close();
    await tester.pump();
    // 关闭期间即使面板仍挂着（常驻子树）也不得再发额度请求。
    for (int i = 0; i < 5; i++) {
      await tester.pump(const Duration(seconds: 30));
    }
    expect(sessions(), 1);

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(sessions(), 2); // 重新打开：真的重新查询了额度

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('截图期间暂时隐藏不算用户关闭：panel.visible 仍为 true', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    await captureAndWait(tester, controller);
    expect(panelWidget(tester).visible, isTrue);

    // 重拍：面板被 Offstage/Visibility 暂时隐藏，但控制器仍是打开状态。
    await tester.tap(find.byKey(const Key('feedback-retake-btn')));
    await tester.pump();

    expect(hiddenByVisibility(tester), isTrue, reason: '重拍期间面板应被暂时隐藏');
    expect(panelWidget(tester).visible, isTrue,
        reason: '截图期间暂时隐藏不是用户关闭，不得让面板认为已关闭');
    // 等待重拍收敛后清理。
    for (int i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 40));
  });
}
