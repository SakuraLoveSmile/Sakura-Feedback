import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/capture_mask.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  late MemoryTokenStore store;
  late List<http.Request> requests;
  late MockClient client;

  setUp(() {
    store = MemoryTokenStore('tok');
    requests = <http.Request>[];
    client = MockClient((request) async {
      requests.add(request);
      final path = Uri.parse(request.url.toString()).path;
      if (path == '/api/feedback' && request.method == 'POST') {
        return http.Response(
            jsonEncode({'feedbackId': 'f1', 'status': 'received'}), 201);
      }
      if (path.startsWith('/api/feedback/')) {
        return http.Response(
            jsonEncode({'id': 'f1', 'status': 'received'}), 200);
      }
      return http.Response('{}', 404);
    });
  });

  Future<FeedbackController> pumpHost(
    WidgetTester tester, {
    required Size surface,
    FeedbackSide side = FeedbackSide.right,
    FeedbackLauncherMode launcherMode = FeedbackLauncherMode.tab,
    FeedbackCaptureMode captureMode = FeedbackCaptureMode.off,
    Widget? hostChild,
  }) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FeedbackController();
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          side: side,
          launcherMode: launcherMode,
          captureMode: captureMode,
        ),
        controller: controller,
        tokenStore: store,
        httpClient: client,
        child: hostChild ?? const Placeholder(),
      ),
    ));
    await tester.pump();
    addTearDown(() {
      controller.dispose();
    });
    return controller;
  }

  testWidgets('悬浮按钮存在且带「反馈」语义、点击呼出面板', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(1000, 800));
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget);

    final SemanticsHandle handle = tester.ensureSemantics();
    await tester.pump();
    expect(find.byTooltip('反馈'), findsOneWidget);
    expect(find.bySemanticsLabel('反馈'), findsWidgets);
    handle.dispose();

    expect(controller.isOpen, isFalse);
    await tester.tap(find.byKey(const Key('feedback-fab')));
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('FeedbackController.open/close 主动呼出与收起', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(1000, 800));
    controller.open();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
    expect(find.byKey(const Key('feedback-fab')), findsNothing);

    controller.close();
    await tester.pump();
    // 面板收起后按钮恢复。
    expect(find.byKey(const Key('feedback-fab')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('宽屏为侧边抽屉（约 400px）+ 遮罩；随 side 停靠', (tester) async {
    final controller =
        await pumpHost(tester, surface: const Size(1200, 800));
    controller.open();
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('feedback-scrim')), findsOneWidget);
    final panelRect = tester.getRect(find.byType(FeedbackPanel));
    expect(panelRect.width, 400);
    // 默认右侧停靠。
    expect(panelRect.right, closeTo(1200, 1));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('窄屏为全屏页面式面板', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(500, 800));
    controller.open();
    await tester.pump();
    await tester.pump();

    // 窄屏不需要遮罩。
    expect(find.byKey(const Key('feedback-scrim')), findsNothing);
    final panelRect = tester.getRect(find.byType(FeedbackPanel));
    expect(panelRect.width, 500);
    expect(panelRect.height, 800);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('Esc 关闭面板', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(1000, 800));
    controller.open();
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);

    // 确保焦点在面板子树内（请求焦点到输入框）。
    await tester.tap(find.byKey(const Key('feedback-input')));
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(controller.isOpen, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('关闭后重开保留草稿（面板状态常驻）', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(1000, 800));
    controller.open();
    await tester.pump();
    await tester.pump();

    await tester.enterText(find.byKey(const Key('feedback-input')), '未写完的草稿');
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(controller.isOpen, isFalse);

    controller.open();
    await tester.pump();
    expect(
        tester.widget<TextField>(find.byKey(const Key('feedback-input')))
            .controller!
            .text,
        '未写完的草稿');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('点击遮罩关闭面板', (tester) async {
    final controller = await pumpHost(tester, surface: const Size(1200, 800));
    controller.open();
    await tester.pump();
    await tester.pump();

    await tester.tapAt(const Offset(10, 400)); // 遮罩区域（面板外）
    await tester.pump();
    expect(controller.isOpen, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('灵感球（orb 模式）渲染、具有语义且点击可呼出面板', (tester) async {
    final controller = await pumpHost(
      tester,
      surface: const Size(1000, 800),
      launcherMode: FeedbackLauncherMode.orb,
    );
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);
    expect(find.byKey(const Key('feedback-fab')), findsNothing);

    expect(controller.isOpen, isFalse);
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await tester.pump();
    await tester.pump();
    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('灵感球拖动超过 8dp 记录落点并触发截图与呼出', (tester) async {
    final controller = await pumpHost(
      tester,
      surface: const Size(1000, 800),
      launcherMode: FeedbackLauncherMode.orb,
      captureMode: FeedbackCaptureMode.viewport,
      hostChild: Container(
        color: Colors.blue,
        child: const Center(child: Text('App Content')),
      ),
    );

    final orbFinder = find.byKey(const Key('feedback-orb'));
    expect(orbFinder, findsOneWidget);

    // 模拟拖拽灵感球：从初始位置拖动 100px
    final TestGesture gesture = await tester.startGesture(tester.getCenter(orbFinder));
    await gesture.moveBy(const Offset(-100, -100));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump();
    // 先截图后开面板：捕获完成后才挂载面板，post-frame 交付截图需再等一帧。
    await tester.pump();

    expect(controller.isOpen, isTrue);
    expect(find.byKey(const Key('feedback-input')), findsOneWidget);
    // 应当展示截图缩略图包装容器
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);

    // 点击移除截图按钮
    await tester.tap(find.byKey(const Key('feedback-remove-screenshot-btn')));
    await tester.pump();
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('FeedbackCaptureMask 注册到最近截图作用域，销毁时注销', (tester) async {
    late BuildContext maskContext;
    await tester.pumpWidget(MaterialApp(
      home: FeedbackWidget(
        config: FeedbackConfig('https://svc.test', 'com.example.app'),
        child: Builder(
          builder: (BuildContext context) {
            maskContext = context;
            return FeedbackCaptureMask(child: const Text('敏感内容'));
          },
        ),
      ),
    ));
    await tester.pump();

    final FeedbackCaptureScope? scope =
        FeedbackCaptureScope.maybeOf(maskContext);
    expect(scope, isNotNull);
    expect(scope!.records.length, 1);
    expect(FeedbackCaptureScope.maybeOf(tester.element(
        find.widgetWithText(FeedbackCaptureMask, '敏感内容'))),
        same(scope));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(scope.records, isEmpty);
  });

  testWidgets('遮挡层在两个组件实例间移动时重新注册，且互不影响', (tester) async {
    // GlobalKey 重挂父级：同一 State 在两个组件实例之间移动。
    final GlobalKey maskKey = GlobalKey();
    final Widget maskInside = FeedbackCaptureMask(
      key: maskKey,
      child: const Text('敏感内容'),
    );

    // 两个独立 FeedbackWidget 实例：A 直接包含遮挡层，B 为空宿主。
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(
          children: <Widget>[
            SizedBox(
              height: 300,
              child: FeedbackWidget(
                config: FeedbackConfig('https://svc.test', 'com.example.a'),
                child: maskInside,
              ),
            ),
            SizedBox(
              height: 300,
              child: FeedbackWidget(
                config: FeedbackConfig('https://svc.test', 'com.example.b'),
                child: const KeyedSubtree(
                  key: Key('scope-b-probe'),
                  child: SizedBox(),
                ),
              ),
            ),
          ],
        ),
      ),
    ));
    await tester.pump();

    final FeedbackCaptureScope? scopeA = FeedbackCaptureScope.maybeOf(
        tester.element(find.byType(FeedbackCaptureMask)));
    final FeedbackCaptureScope? scopeB = FeedbackCaptureScope.maybeOf(
        tester.element(find.byKey(const Key('scope-b-probe'))));
    expect(scopeA, isNotNull);
    expect(scopeB, isNotNull);
    expect(scopeA, isNot(same(scopeB)));
    expect(scopeA!.records.length, 1);
    expect(scopeB!.records, isEmpty);

    // 把遮挡层移动到另一个组件实例：应重新注册到 B 的作用域。
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(
          children: <Widget>[
            SizedBox(
              height: 300,
              child: FeedbackWidget(
                config: FeedbackConfig('https://svc.test', 'com.example.a'),
                child: const SizedBox(),
              ),
            ),
            SizedBox(
              height: 300,
              child: FeedbackWidget(
                config: FeedbackConfig('https://svc.test', 'com.example.b'),
                child: maskInside,
              ),
            ),
          ],
        ),
      ),
    ));
    await tester.pump();
    expect(scopeA.records, isEmpty);
    expect(scopeB.records.length, 1);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(scopeA.records, isEmpty);
    expect(scopeB.records, isEmpty);
  });
}
