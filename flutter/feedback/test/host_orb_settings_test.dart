import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb_idle.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:feedback_widget/src/wake_gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// v0.8.4：宿主托管（host-controlled）的灵感球设置。
///
/// 宿主通过 [FeedbackWidget.orbIdleStyle] / [FeedbackWidget.wakeGestures]
/// 直接给出取值，组件不再写自己的偏好；面板内改选时回调宿主，由宿主保存后
/// 把新值回传。这里用内存偏好仓库断言「组件没有私自写入」。
final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _collapsed = find.byKey(const Key('feedback-orb-collapsed'));

class _HostOrbHarness {
  final GlobalKey feedbackKey = GlobalKey();
  final ValueNotifier<int> revision = ValueNotifier<int>(0);
  final FeedbackController controller = FeedbackController();
  final MemoryServerPrefStore preferences = MemoryServerPrefStore();
  final List<FeedbackOrbIdleStyle> styleChanges = <FeedbackOrbIdleStyle>[];
  final List<Set<FeedbackWakeGesture>> gestureChanges =
      <Set<FeedbackWakeGesture>>[];
  FeedbackOrbIdleStyle? style;
  Set<FeedbackWakeGesture>? gestures;
  bool reduced = true;
  bool applyStyleChanges = true;
  bool applyGestureChanges = true;
  bool withStyleCallback = true;
  bool withGestureCallback = true;
  String appId = 'com.example.host-orb';
  FeedbackCaptureMode captureMode = FeedbackCaptureMode.off;

  void rebuild() => revision.value++;

  Future<void> mount(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: ValueListenableBuilder<int>(
        valueListenable: revision,
        builder: (BuildContext context, int _, Widget? child) {
          return MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(disableAnimations: reduced, devicePixelRatio: 2),
            child: FeedbackWidget(
              key: feedbackKey,
              config: FeedbackConfig(
                'https://svc.test',
                appId,
                launcherMode: FeedbackLauncherMode.orb,
                captureMode: captureMode,
              ),
              controller: controller,
              tokenStore: MemoryTokenStore('tok'),
              serverPrefStore: preferences,
              httpClient: captureMockClient(),
              orbIdleStyle: style,
              onOrbIdleStyleChanged: withStyleCallback
                  ? (FeedbackOrbIdleStyle next) {
                      styleChanges.add(next);
                      if (applyStyleChanges) {
                        style = next;
                        rebuild();
                      }
                    }
                  : null,
              wakeGestures: gestures,
              onWakeGesturesChanged: withGestureCallback
                  ? (Set<FeedbackWakeGesture> next) {
                      gestureChanges.add(Set<FeedbackWakeGesture>.of(next));
                      if (applyGestureChanges) {
                        gestures = Set<FeedbackWakeGesture>.of(next);
                        rebuild();
                      }
                    }
                  : null,
              child:
                  const SizedBox.expand(child: ColoredBox(color: Colors.blue)),
            ),
          );
        },
      ),
    ));
    await tester.pump();
  }

  Future<void> openSettings(WidgetTester tester) async {
    controller.open();
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-settings')));
    await tester.pump();
  }

  Future<void> closePanel(WidgetTester tester) async {
    controller.close();
    await tester.pump();
    await tester.pump();
  }

  void dispose() {
    revision.dispose();
    controller.dispose();
  }
}

void main() {
  late _HostOrbHarness host;

  setUp(() {
    host = _HostOrbHarness();
    debugDisableOrbLensCapture = true;
  });

  tearDown(() {
    host.dispose();
    debugDisableOrbLensCapture = false;
  });

  testWidgets('宿主给出的 hidden 只隐藏待机态：完整球先显示，闲置后隐藏，面板仍可打开并改回',
      (tester) async {
    host.style = FeedbackOrbIdleStyle.hidden;
    await host.mount(tester);

    // v0.8.5：待机隐藏不等于入口开关。完整球初始仍显示并开始 5 秒计时，
    // 闲置后才进入待机隐藏（不渲染任何收起入口）。
    expect(_orb, findsOneWidget, reason: '完整球初始仍显示');
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsNothing, reason: '待机隐藏时不渲染灵感球');
    expect(_collapsed, findsNothing);
    expect(host.controller.isOpen, isFalse);

    await host.openSettings(tester);
    expect(find.byType(FeedbackPanel), findsOneWidget);
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget);

    await tester.tap(find.byKey(const Key('feedback-orb-idle-handle')));
    await tester.pump();
    expect(
        host.styleChanges,
        <FeedbackOrbIdleStyle>[
          FeedbackOrbIdleStyle.handle,
        ],
        reason: '宿主托管的改动必须回传宿主，而不是写组件自己的偏好');
    expect(host.style, FeedbackOrbIdleStyle.handle);

    await host.closePanel(tester);
    expect(_orb, findsOneWidget, reason: '宿主把新值回传后完整球恢复');
    expect(
      await host.preferences.read(orbIdleStorageKey(host.appId)),
      isNull,
      reason: '宿主托管时组件不得写自己的待机样式偏好',
    );
  });

  testWidgets('宿主给出的 edge 与 handle 分别驱动收起后的入口形状', (tester) async {
    host.style = FeedbackOrbIdleStyle.edge;
    await host.mount(tester);
    expect(_orb, findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_collapsed, findsOneWidget);
    expect(find.byKey(const Key('feedback-orb-idle-edge')), findsOneWidget);
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsNothing);

    host.style = FeedbackOrbIdleStyle.handle;
    host.rebuild();
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('宿主属性从 handle 改为 hidden 再改回：完整球保留，闲置后隐藏，改回后恢复',
      (tester) async {
    host.style = FeedbackOrbIdleStyle.handle;
    await host.mount(tester);
    expect(_orb, findsOneWidget);

    host.style = FeedbackOrbIdleStyle.hidden;
    host.rebuild();
    await tester.pump();
    expect(_orb, findsOneWidget, reason: '切到 hidden 先恢复完整球并重新计时');
    expect(_collapsed, findsNothing);

    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsNothing, reason: '宿主给出的 hidden 闲置后隐藏待机态');
    expect(_collapsed, findsNothing);

    host.style = FeedbackOrbIdleStyle.handle;
    host.rebuild();
    await tester.pump();
    expect(_orb, findsOneWidget, reason: '宿主改回 handle 后完整球立即恢复');
    expect(tester.takeException(), isNull);
  });

  testWidgets('宿主托管的 hidden 不妨碍已开启的唤醒手势，改回 handle 后恢复',
      (tester) async {
    host.captureMode = FeedbackCaptureMode.viewport;
    host.style = FeedbackOrbIdleStyle.hidden;
    host.gestures = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold};
    await host.mount(tester);
    final Rect dock = tester.getRect(_orb);
    expect(_orb, findsOneWidget);

    // 闲置 5 秒进入待机隐藏：不渲染任何收起入口，但唤醒能力仍在线。
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsNothing);
    expect(_collapsed, findsNothing);
    expect(host.controller.isOpen, isFalse);

    Future<void> holdAndLift() async {
      final TestGesture first =
          await tester.startGesture(const Offset(160, 300));
      final TestGesture second =
          await tester.startGesture(const Offset(220, 300));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.byKey(const Key('feedback-wake-release-hint')),
          findsOneWidget);
      await first.up();
      await second.up();
    }

    await holdAndLift();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsOneWidget,
        reason: '宿主托管的 hidden 不取消已开启的唤醒手势');
    expect(tester.getRect(_orb), dock, reason: '唤醒后完整球回到原停车位');
    expect(host.controller.isOpen, isFalse);
    expect(
      await host.preferences.read(wakeGestureStorageKey(host.appId)),
      isNull,
      reason: '宿主托管时组件不得写自己的唤醒手势偏好',
    );

    // 再次闲置后重新待机隐藏。
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsNothing);

    // 宿主改回 handle：完整球立即恢复，并按 handle 重新计时收起。
    host.style = FeedbackOrbIdleStyle.handle;
    host.rebuild();
    await tester.pump();
    expect(_orb, findsOneWidget, reason: '宿主改回 handle 后完整球恢复');
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(find.byKey(const Key('feedback-orb-idle-handle')), findsOneWidget,
        reason: '恢复后重新开始闲置计时');
    expect(tester.takeException(), isNull);
  });

  testWidgets('宿主托管唤醒手势：识别与回调都按宿主值执行', (tester) async {
    host.captureMode = FeedbackCaptureMode.viewport;
    host.gestures = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold};
    host.reduced = true;
    await host.mount(tester);
    expect(_orb, findsOneWidget);

    // 双指长按唤出完整球；只唤醒，不直接打开面板、不进入截图。
    final TestGesture first = await tester.startGesture(const Offset(160, 300));
    final TestGesture second =
        await tester.startGesture(const Offset(220, 300));
    await tester.pump(const Duration(milliseconds: 700));
    await first.up();
    await second.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 420));
    expect(_orb, findsOneWidget);
    expect(host.controller.isOpen, isFalse);

    // 面板内取消勾选会回调宿主；宿主回传空集合后不再识别。
    await host.openSettings(tester);
    await tester.tap(find.byKey(const Key('feedback-wake-two-finger-hold')));
    await tester.pump();
    expect(host.gestureChanges, hasLength(1));
    expect(host.gestureChanges.single, isEmpty);
    expect(host.gestures, isEmpty);
    expect(
      await host.preferences.read(wakeGestureStorageKey(host.appId)),
      isNull,
      reason: '宿主托管时组件不得写自己的唤醒手势偏好',
    );

    await host.closePanel(tester);
    final TestGesture third = await tester.startGesture(const Offset(160, 300));
    final TestGesture fourth =
        await tester.startGesture(const Offset(220, 300));
    await tester.pump(const Duration(milliseconds: 700));
    await third.up();
    await fourth.up();
    await tester.pump();
    expect(host.gestureChanges, hasLength(1), reason: '宿主回传空集合后手势不再触发');
  });

  testWidgets('宿主只给值不给回调时，面板隐藏对应设置区以免无效操作', (tester) async {
    host.style = FeedbackOrbIdleStyle.edge;
    host.withStyleCallback = false;
    host.gestures = <FeedbackWakeGesture>{};
    host.withGestureCallback = false;
    await host.mount(tester);
    await host.openSettings(tester);

    expect(find.text('灵感球'), findsNothing);
    expect(find.text('唤醒方式'), findsNothing);
    expect(find.byKey(const Key('feedback-orb-idle-edge')), findsNothing);
    // 只给值不给回调不会影响渲染本身：关闭面板后仍按宿主值显示入口。
    await host.closePanel(tester);
    expect(_orb, findsOneWidget);
  });

  testWidgets('宿主未提供时沿用组件自己的持久化偏好（向下兼容）', (tester) async {
    await host.preferences.write(orbIdleStorageKey(host.appId),
        encodeOrbIdleStyle(FeedbackOrbIdleStyle.edge));
    await host.mount(tester);
    await tester.pump();

    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 420));
    expect(find.byKey(const Key('feedback-orb-idle-edge')), findsOneWidget,
        reason: '没有宿主托管时必须保持 0.8.3 及更早的行为');
  });
}
