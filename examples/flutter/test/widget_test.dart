import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_example/details_page.dart';
import 'package:feedback_example/home_page.dart';
import 'package:feedback_example/host_dialog.dart';
import 'package:feedback_example/main.dart';
import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

/// 等待条件成立：pump 前进帧 + runAsync 给真实异步（图像栅格化与编码）时间。
Future<void> pumpUntil(WidgetTester tester, bool Function() cond) async {
  for (int i = 0; i < 200; i++) {
    if (cond()) return;
    await tester.pump(const Duration(milliseconds: 50));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });
  }
  fail('pumpUntil 等待超时');
}

/// [node] 是否是 [ancestor] 的后代元素（用于断言截图边界是否包含某子树）。
bool isDescendantOf(Element ancestor, Element node) {
  bool found = false;
  node.visitAncestorElements((Element element) {
    if (element == ancestor) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/// 宿主内容所在的截图边界：FeedbackWidget 内部的
/// `RepaintBoundary(child: 宿主内容)`（Stack 的第一个子树，先于面板与入口）。
/// 组件自己的捕获就是对该边界调用 `toImage()`，所以它等价于"截图实际拍到的子树"。
Finder hostBoundaryFinder() => find
    .descendant(
        of: find.byType(FeedbackWidget), matching: find.byType(RepaintBoundary))
    .first;

/// 统计原始 RGBA 像素中与 [color] 相近（容差 4）的像素数。
int countColor(ByteData rgba, int width, int height, Color color) {
  final Uint8List bytes = rgba.buffer.asUint8List();
  final int targetR = (color.r * 255).round();
  final int targetG = (color.g * 255).round();
  final int targetB = (color.b * 255).round();
  int count = 0;
  for (int i = 0; i + 3 < bytes.length; i += 4) {
    if ((bytes[i] - targetR).abs() <= 4 &&
        (bytes[i + 1] - targetG).abs() <= 4 &&
        (bytes[i + 2] - targetB).abs() <= 4) {
      count++;
    }
  }
  return count;
}

void main() {
  testWidgets('示例应用冒烟测试：灵感球呼出反馈面板（先截图后开面板）', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();

    // 示例使用灵感球（orb）模式：orb 渲染、fab 不渲染。
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);
    expect(find.byKey(const Key('feedback-fab')), findsNothing);

    // captureMode=viewport：呼出走"先截图后开面板"——截图完成后才挂载
    // 面板，需以轮询等待（真实异步的图像栅格化与编码）。
    await tester.tap(find.byKey(const Key('feedback-orb')));
    bool panelReady = false;
    for (int i = 0; i < 200 && !panelReady; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
      panelReady = find
          .byKey(const Key('feedback-login-username'))
          .evaluate()
          .isNotEmpty;
    }
    // 令牌仓库（flutter_secure_storage）在单测环境不可用：
    // 面板容错后应回落到登录表单视图。
    expect(panelReady, isTrue, reason: '截图完成后面板应挂载并回落到登录视图');
  });

  testWidgets('结构：组件挂在 Navigator 之上，切换路由不重建组件/控制器/面板', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();

    // 应用根持有的控制器实例。
    final FeedbackController controllerBefore =
        tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;
    final State<FeedbackWidget> widgetStateBefore =
        tester.state(find.byType(FeedbackWidget));

    // 先打开面板并挂载 FeedbackPanel，用于验证导航不重建面板状态。
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await pumpUntil(
      tester,
      () =>
          find.byKey(const Key('feedback-login-username')).evaluate().isNotEmpty,
    );
    final FeedbackPanelState panelBefore = tester.state<FeedbackPanelState>(
        find.byType(FeedbackPanel, skipOffstage: false));

    // 关闭面板，再切到第二个路由。
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump();
    expect(find.text('纯文本打开'), findsOneWidget);

    await tester.tap(find.text('打开第二个路由'));
    await tester.pumpAndSettle();
    expect(find.byType(DetailsPage), findsOneWidget);
    expect(find.byType(HomePage), findsNothing);

    // 关键断言：导航之后灵感球仍在场，且组件实例与控制器实例都没被重建。
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget,
        reason: '组件在 Navigator 之上，push 路由后入口仍在');
    expect(
        identical(
            widgetStateBefore, tester.state(find.byType(FeedbackWidget))),
        isTrue,
        reason: '导航不重建 FeedbackWidget（State 复用）');
    expect(
      identical(
          controllerBefore,
          tester
              .widget<FeedbackWidget>(find.byType(FeedbackWidget))
              .controller),
      isTrue,
      reason: '控制器由应用根持有，导航不换实例',
    );
    expect(
        identical(
            panelBefore,
            tester.state<FeedbackPanelState>(
                find.byType(FeedbackPanel, skipOffstage: false))),
        isTrue,
        reason: '面板状态随组件保留（草稿/截图不会因导航丢失）');

    // 返回第一页后入口也还在。
    await tester.tap(find.text('返回第一页'));
    await tester.pumpAndSettle();
    expect(find.byType(HomePage), findsOneWidget);
    expect(find.byKey(const Key('feedback-orb')), findsOneWidget);
  });

  testWidgets('截图范围：宿主对话框入图、反馈面板不入图（结构性 + 像素级）', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();

    // 打开宿主对话框（宿主 UI，理应出现在截图里）。
    await tester.tap(find.text('打开宿主对话框'));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const Key('feedback-example-dialog-swatch')), findsOneWidget);

    // 对话框打开时呼出灵感球：先截图后开面板。
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await pumpUntil(
        tester, () => find.byType(FeedbackPanel).evaluate().isNotEmpty);
    await tester.pump();
    await tester.pump();

    final FeedbackPanelState panel =
        tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
    await pumpUntil(tester, () => panel.hasScreenshot);
    expect(panel.hasScreenshot, isTrue, reason: '对话框打开时截图应成功并交付面板');

    // 结构性断言：截图边界包含对话框，但不包含反馈面板。
    final Element boundary = tester.element(hostBoundaryFinder());
    final Element dialog = tester.element(find.byType(AlertDialog));
    final Element feedbackPanel = tester.element(find.byType(FeedbackPanel));
    expect(isDescendantOf(boundary, dialog), isTrue,
        reason: '宿主对话框在截图边界（宿主内容）内');
    expect(isDescendantOf(boundary, feedbackPanel), isFalse,
        reason: '反馈面板在截图边界之外，不会拍到自己');

    // 像素级断言：对同一个截图边界调用 toImage()，
    // 对话框里那块唯一颜色的区域必须真的出现在位图里。
    // 期望下界由演示色区域的实际布局尺寸算出（位图与逻辑像素 1:1）。
    final Rect swatchRect =
        tester.getRect(find.byKey(const Key('feedback-example-dialog-swatch')));
    final int expectedPixels =
        (swatchRect.width * swatchRect.height * 0.9).floor();
    final RenderRepaintBoundary renderBoundary =
        tester.renderObject<RenderRepaintBoundary>(hostBoundaryFinder());
    late int matches;
    await tester.runAsync(() async {
      final ui.Image image = await renderBoundary.toImage();
      final ByteData pixels =
          (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
      matches =
          countColor(pixels, image.width, image.height, kHostDialogDemoColor);
      image.dispose();
    });
    expect(matches, greaterThan(expectedPixels),
        reason: '对话框演示色必须以实际布局面积出现在截取到的位图中'
            '（证明宿主对话框被拍进去了；期望 > $expectedPixels，实际 $matches）');
  });

  testWidgets('应用根释放控制器：整棵树卸载后控制器已 dispose', (tester) async {
    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();

    final FeedbackController controller =
        tester.widget<FeedbackWidget>(find.byType(FeedbackWidget)).controller!;

    // 卸载整棵树 → 根 State.dispose() → controller.dispose()。
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
    expect(tester.takeException(), isNull);

    // ChangeNotifier 释放后再使用会抛 FlutterError：说明确实被 dispose 了。
    expect(() => controller.addListener(() {}), throwsFlutterError);
  });
}
