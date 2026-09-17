// T9：键盘避让——组件布局层计算面板与键盘的实际重叠（只扣未被宿主避让
// 的部分），撰写/登录/设置内容有界可滚，焦点切换与键盘尺寸变化后把聚焦
// 字段滚回可见区域；键盘开合与旋转不清输入、不重复提交。

import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'panel_harness.dart';

const Key input = Key('feedback-input');
const Key submit = Key('feedback-submit');
const Key settingsGear = Key('feedback-settings');
const Key serverInput = Key('feedback-server-input');
const Key serverSave = Key('feedback-server-save');
const Key loginUsername = Key('feedback-login-username');
const Key loginPassword = Key('feedback-login-password');
const Key loginSubmit = Key('feedback-login-submit');

void main() {
  late PanelServer server;

  setUp(() {
    server = PanelServer();
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
  });

  /// 挂载 FeedbackWidget（默认未避让宿主：组件占据整个视图）。
  ///
  /// [hostAvoidedBy] 模拟宿主已随键盘收缩的高度；[consumesInsets] 模拟
  /// Scaffold 式「收缩 + 消费 viewInsets」；只收缩不消费则覆盖
  /// 「自定义布局部分避让」场景。
  /// 用 view API 设置逻辑尺寸（dpr 固定 1 使物理=逻辑）：与
  /// `setSurfaceSize` 不同，这条路径同时更新布局约束与 MediaQuery
  /// 数据，键盘重叠计算依赖的 sizeOf/viewInsets 才一致。
  void setSurface(WidgetTester tester, Size size) {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = size;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
  }

  Future<FeedbackController> pumpHost(
    WidgetTester tester, {
    Size surface = const Size(390, 720),
    double hostAvoidedBy = 0,
    bool consumesInsets = false,
    TextScaler? textScaler,
    String? token = 'tok',
  }) async {
    setSurface(tester, surface);
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    Widget w = FeedbackWidget(
      config: FeedbackConfig('https://svc.test', 'com.example.app'),
      controller: controller,
      tokenStore: MemoryTokenStore(token),
      serverPrefStore: MemoryServerPrefStore(),
      httpClient: server.client,
      child: const Placeholder(),
    );
    if (hostAvoidedBy > 0) {
      w = Padding(
        padding: EdgeInsets.only(bottom: hostAvoidedBy),
        child: w,
      );
      if (consumesInsets) {
        final Widget inner = w;
        w = Builder(
          builder: (BuildContext ctx) => MediaQuery.removeViewInsets(
            context: ctx,
            removeBottom: true,
            child: inner,
          ),
        );
      }
    }
    if (textScaler != null) {
      final Widget inner = w;
      w = Builder(
        builder: (BuildContext ctx) => MediaQuery(
          data: MediaQuery.of(ctx).copyWith(textScaler: textScaler),
          child: inner,
        ),
      );
    }
    await tester.pumpWidget(MaterialApp(home: w));
    await tester.pump();
    return controller;
  }

  void setKeyboard(WidgetTester tester, double inset) {
    tester.view.viewInsets = FakeViewPadding(bottom: inset);
    addTearDown(tester.view.resetViewInsets);
  }

  Future<FeedbackPanelState> openPanel(
    WidgetTester tester,
    FeedbackController controller,
  ) async {
    controller.open();
    await tester.pump();
    await tester.pump();
    await tester.pump();
    return tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
  }

  Rect panelRect(WidgetTester tester) =>
      tester.getRect(find.byType(FeedbackPanel));

  testWidgets('未避让宿主：键盘展开时面板底部抬升到键盘上沿，按钮可滚达',
      (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    await openPanel(tester, controller);
    expect(find.byKey(input), findsOneWidget);
    expect(panelRect(tester).bottom, moreOrLessEquals(720, epsilon: 0.5));

    setKeyboard(tester, 300); // 键盘上沿 = 420
    await tester.pump();
    await tester.pump();
    expect(panelRect(tester).bottom, moreOrLessEquals(420, epsilon: 0.5),
        reason: '面板底边应抬升到键盘上沿（未避让部分被扣除）');

    await tester.enterText(find.byKey(input), '反馈内容');
    await tester.pump();
    await tester.ensureVisible(find.byKey(submit));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(submit)).bottom,
        lessThanOrEqualTo(420.5),
        reason: '提交按钮必须位于键盘上沿之上');

    await teardownPanel(tester);
  });

  testWidgets('不同键盘高度：200 与 500 都不遮挡底部操作区', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '内容');
    await tester.pump();

    for (final double inset in <double>[200, 500]) {
      setKeyboard(tester, inset);
      await tester.pump();
      await tester.pump();
      final double kbTop = 720 - inset;
      expect(panelRect(tester).bottom, moreOrLessEquals(kbTop, epsilon: 0.5),
          reason: 'inset=$inset 时面板底边应贴键盘上沿');
      await tester.ensureVisible(find.byKey(submit));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.byKey(submit)).bottom,
          lessThanOrEqualTo(kbTop + 0.5));
    }

    await teardownPanel(tester);
  });

  testWidgets('宿主已避让（收缩+消费 insets）：不双重留白', (tester) async {
    final FeedbackController controller =
        await pumpHost(tester, hostAvoidedBy: 300, consumesInsets: true);
    await openPanel(tester, controller);
    setKeyboard(tester, 300);
    await tester.pump();
    await tester.pump();
    // 组件盒子已被宿主收缩到 0..420：面板底边应贴盒子底（420），
    // 若再次扣除 insets 会错误地变成 120。
    expect(panelRect(tester).bottom, moreOrLessEquals(420, epsilon: 0.5),
        reason: '宿主已避让时不得再扣键盘高度');

    await teardownPanel(tester);
  });

  testWidgets('宿主收缩但未消费 insets：按实际重叠计算仍不遮挡',
      (tester) async {
    final FeedbackController controller =
        await pumpHost(tester, hostAvoidedBy: 300);
    await openPanel(tester, controller);
    setKeyboard(tester, 300); // 组件盒子底=420=键盘上沿 → 重叠 0
    await tester.pump();
    await tester.pump();
    expect(panelRect(tester).bottom, moreOrLessEquals(420, epsilon: 0.5));

    await teardownPanel(tester);
  });

  testWidgets('宿主部分避让（只收缩一半）：扣除剩余重叠', (tester) async {
    final FeedbackController controller =
        await pumpHost(tester, hostAvoidedBy: 150);
    await openPanel(tester, controller);
    setKeyboard(tester, 300); // 盒子底=570，键盘上沿=420 → 重叠 150
    await tester.pump();
    await tester.pump();
    expect(panelRect(tester).bottom, moreOrLessEquals(420, epsilon: 0.5),
        reason: '部分避让时只扣除尚未避让的 150');

    await teardownPanel(tester);
  });

  testWidgets('未登录：键盘下登录表单全部字段与按钮可达', (tester) async {
    final FeedbackController controller =
        await pumpHost(tester, token: null);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '要提交的草稿');
    await tester.pump();

    // 展开登录表单（「登录并提交」）。
    await tester.tap(find.byKey(submit));
    await tester.pump();
    expect(find.byKey(loginUsername), findsOneWidget);

    setKeyboard(tester, 460); // 可用高度只剩 260
    await tester.pump();
    await tester.pump();

    for (final Key key in <Key>[loginUsername, loginPassword, loginSubmit]) {
      await tester.ensureVisible(find.byKey(key));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.byKey(key)).bottom,
          lessThanOrEqualTo(260.5),
          reason: '$key 必须能滚动到键盘上沿（260）之上');
    }
    expect(panel.passwordFocused, isFalse);

    await teardownPanel(tester);
  });

  testWidgets('账号「下一步」进入密码，密码「完成」沿用登录流程', (tester) async {
    server.respond('POST /api/auth/login', {'ok': true, 'token': 't2'});
    server.respond('POST /api/feedback',
        {'feedbackId': 'f-kb', 'status': 'received'}, 201);
    final FeedbackController controller =
        await pumpHost(tester, token: null);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '草稿');
    await tester.pump();
    await tester.tap(find.byKey(submit)); // 展开登录表单
    await tester.pump();

    await tester.showKeyboard(find.byKey(loginUsername));
    await tester.pump();
    expect(panel.usernameFocused, isTrue);
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await tester.pump();
    expect(panel.passwordFocused, isTrue, reason: '「下一步」必须聚焦密码框');

    await tester.enterText(find.byKey(loginUsername), 'admin');
    await tester.enterText(find.byKey(loginPassword), 'pw');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.pump();
    expect(server.count('POST /api/auth/login'), 1,
        reason: '密码框「完成」必须沿用登录流程');

    await teardownPanel(tester);
  });

  testWidgets('焦点字段在键盘展开后滚回可见区域（聚焦+布局完成后滚动）',
      (tester) async {
    final FeedbackController controller =
        await pumpHost(tester, token: null);
    await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '草稿');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();

    await tester.showKeyboard(find.byKey(loginPassword));
    await tester.pump();
    setKeyboard(tester, 460);
    await tester.pump(); // 布局完成
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    expect(tester.getRect(find.byKey(loginPassword)).bottom,
        lessThanOrEqualTo(260.5),
        reason: '聚焦字段必须在布局完成后滚回键盘上沿（260）之上');

    await teardownPanel(tester);
  });

  testWidgets('键盘开合与旋转不清空输入、不重复提交', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '不能丢的草稿');
    await tester.pump();

    setKeyboard(tester, 320);
    await tester.pump();
    await tester.pump();
    setKeyboard(tester, 0);
    await tester.pump();
    // 旋转：竖屏 → 横屏 → 竖屏
    setSurface(tester, const Size(720, 390));
    setKeyboard(tester, 240);
    await tester.pump();
    await tester.pump();
    setSurface(tester, const Size(390, 720));
    setKeyboard(tester, 0);
    await tester.pump();
    await tester.pump();

    expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text,
        '不能丢的草稿',
        reason: '键盘开合/旋转不得清空草稿');
    expect(panel.hasDraft, isTrue);
    expect(server.count('POST /api/feedback'), 0,
        reason: '键盘与旋转不得触发任何提交');

    await teardownPanel(tester);
  });

  testWidgets('横屏 + 高键盘：小屏下登录按钮可滚达', (tester) async {
    final FeedbackController controller = await pumpHost(tester,
        surface: const Size(720, 390), token: null);
    await openPanel(tester, controller);
    await tester.enterText(find.byKey(input), '草稿');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();

    setKeyboard(tester, 260); // 横屏可用高度只剩 130
    await tester.pump();
    await tester.pump();
    expect(panelRect(tester).bottom, moreOrLessEquals(130, epsilon: 0.5));
    await tester.ensureVisible(find.byKey(loginSubmit));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(loginSubmit)).bottom,
        lessThanOrEqualTo(130.5),
        reason: '横屏小高度下登录按钮必须可滚动到达');

    await teardownPanel(tester);
  });

  testWidgets('放大字体 + 键盘：设置视图与登录按钮均可达', (tester) async {
    final FeedbackController controller = await pumpHost(tester,
        textScaler: const TextScaler.linear(1.5), token: null);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    setKeyboard(tester, 360); // 可用 360
    await tester.pump();
    await tester.pump();

    await tester.enterText(find.byKey(input), '草稿');
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    await tester.ensureVisible(find.byKey(loginSubmit));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(loginSubmit)).bottom,
        lessThanOrEqualTo(360.5),
        reason: '放大字体下登录按钮必须可达');

    // 设置视图同样受键盘避让：地址框与保存按钮可达。
    await tester.tap(find.byKey(settingsGear));
    await tester.pump();
    expect(panel.settingsOpen, isTrue);
    await tester.ensureVisible(find.byKey(serverInput));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(serverInput)).bottom,
        lessThanOrEqualTo(360.5));
    await tester.ensureVisible(find.byKey(serverSave));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(serverSave)).bottom,
        lessThanOrEqualTo(360.5));

    await teardownPanel(tester);
  });

  testWidgets('有截图与日志时底部按钮仍可滚达', (tester) async {
    final FeedbackController controller = await pumpHost(tester);
    final FeedbackPanelState panel = await openPanel(tester, controller);
    final Uint8List png = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    panel.setScreenshot(png, const FeedbackCaptureInfo(capturedAt: 't'));
    panel.addLog(FeedbackLogFile(
        filename: 'a.log',
        bytes: Uint8List.fromList(utf8.encode('log')),
        source: 'manual'));
    await tester.enterText(find.byKey(input), '带附件的反馈');
    await tester.pump();

    setKeyboard(tester, 460); // 可用 260
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
    await tester.ensureVisible(find.byKey(submit));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(submit)).bottom,
        lessThanOrEqualTo(260.5),
        reason: '截图+日志+键盘下提交按钮必须可滚达');

    await teardownPanel(tester);
  });
}
