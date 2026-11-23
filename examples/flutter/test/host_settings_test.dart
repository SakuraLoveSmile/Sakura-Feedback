import 'package:feedback_example/main.dart';
import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 宿主托管（v0.11.0）的示例链路：宿主设置页改选 → 应用根 setState →
/// FeedbackWidget 按新值重建，三项值与 hideSettings 都传到组件上。
void main() {
  FeedbackWidget widget(WidgetTester tester) =>
      tester.widget<FeedbackWidget>(find.byType(FeedbackWidget));

  testWidgets('宿主托管：改选唤醒动效与灵感球入场后，组件收到新值', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();

    // 默认值来自应用根 State：光束 / 水波涟漪 / 小珠浮现。
    expect(widget(tester).launcherStyle, FeedbackLauncherStyle.beam);
    expect(widget(tester).wakeVisual, FeedbackWakeVisual.ripple);
    expect(widget(tester).orbEntrance, FeedbackOrbEntrance.bead);
    expect(widget(tester).hideSettings, isTrue, reason: '宿主托管时面板设置页只留服务器设置');

    // 首页入口打开宿主设置页。
    await tester.tap(find.text('宿主设置'));
    await tester.pumpAndSettle();
    expect(find.text('反馈外观设置'), findsOneWidget, reason: '首页按钮打开宿主设置页');
    expect(
      find.text('反馈外观与动效由宿主统一管理：改选后组件按新值重建，反馈面板里只保留服务器设置。'),
      findsOneWidget,
    );

    // 改选两项：每次改选都应立刻回传并重建组件。
    await tester.tap(find.text('极光'));
    await tester.pumpAndSettle();
    expect(
      widget(tester).wakeVisual,
      FeedbackWakeVisual.aurora,
      reason: '改选唤醒动效后组件按新值重建',
    );

    await tester.tap(find.text('取景成球'));
    await tester.pumpAndSettle();
    expect(
      widget(tester).orbEntrance,
      FeedbackOrbEntrance.corners,
      reason: '改选灵感球入场后组件按新值重建',
    );

    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();
    expect(find.text('反馈外观设置'), findsNothing, reason: '完成会关闭宿主设置页');
  });

  testWidgets('宿主托管：改选入口样式为灵感球后，入口按新值出现', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FeedbackExampleApp());
    await tester.pump();
    expect(
      find.byKey(const Key('feedback-orb')),
      findsNothing,
      reason: '默认光束唤醒没有常驻入口',
    );

    await tester.tap(find.text('宿主设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('灵感球'));
    // 灵感球有持续动效，不能用 pumpAndSettle：固定推进几帧即可。
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(widget(tester).launcherStyle, FeedbackLauncherStyle.orb);

    // 卸载整棵树并越过组件的定时兜底，避免残留 Timer。
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
    expect(tester.takeException(), isNull);
  });
}
