// T2 验收：图片编辑器「调整选区 → 应用裁剪 → 保存图片」。
//
// 覆盖：
// 1. 裁剪松手后选区仍可见、不自动裁剪；移动 / 八点缩放 / 重新框选 / 取消；
// 2. 存在未应用选区时禁止保存（禁用并说明原因）；
// 3. 拖动选区同步更新「裁剪结果」预览与输出尺寸，预览与导出共用同一
//    编辑结果；
// 4. 裁剪保留实色遮挡（不透明 rgb(110,110,115) 色块）——像素级断言；
// 5. 辅助边框 / 网格 / 控制点 / 暗化遮罩不写入图片；
// 6. 宽屏右侧 280px 预览、窄屏上下 160px + 底部固定确认按钮。

import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/src/image_editor.dart';
import 'package:feedback_widget/src/images.dart' show decodeImage;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';

/// 最近一次保存结果（onDone 回调写入）。
Uint8List? lastSaved;

/// 生成 160×160 纯色 PNG（真实编码，供编辑器测试）。
Future<Uint8List> makeColorPng(WidgetTester tester,
    {Color color = Colors.green}) async {
  final Uint8List? result = await tester.runAsync<Uint8List>(() async {
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    canvas.drawRect(const Rect.fromLTWH(0, 0, 160, 160), Paint()..color = color);
    final ui.Picture picture = recorder.endRecording();
    final ui.Image img = await picture.toImage(160, 160);
    picture.dispose();
    final ByteData? data =
        await img.toByteData(format: ui.ImageByteFormat.png);
    img.dispose();
    return data!.buffer.asUint8List();
  });
  return result!;
}

/// 挂载编辑器（onDone 收集保存结果）。
Future<FeedbackImageEditorState> pumpEditor(
  WidgetTester tester, {
  Size surface = const Size(800, 600),
}) async {
  lastSaved = null;
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final Uint8List png = await makeColorPng(tester);
  final ui.Image image = (await tester.runAsync(() => decodeImage(png)))!;
  await tester.pumpWidget(MaterialApp(
    home: FeedbackImageEditor(
      image: image,
      filename: 'shot.png',
      onDone: (Uint8List? result) => lastSaved = result,
    ),
  ));
  await tester.pump();
  return tester.state<FeedbackImageEditorState>(
      find.byType(FeedbackImageEditor));
}

/// 在画布上按固定步数拖动（多次位移事件，保证手势被识别为拖动）。
Future<void> dragOnCanvas(
  WidgetTester tester,
  Offset from,
  Offset to, {
  int steps = 6,
}) async {
  final TestGesture gesture = await tester.startGesture(from);
  final Offset delta = (to - from) / steps.toDouble();
  for (int i = 0; i < steps; i++) {
    await gesture.moveBy(delta);
    await tester.pump(const Duration(milliseconds: 16));
  }
  await gesture.up();
  await tester.pump();
}

/// 等待保存回调返回字节。
Future<Uint8List> waitSaved(WidgetTester tester) async {
  await pumpUntil(tester, () => lastSaved != null);
  await tester.pump();
  return lastSaved!;
}

void main() {
  testWidgets(
      '裁剪松手进入待确认态：选区持续可见、不自动裁剪；移动/缩放/重新框选/取消/应用',
      (tester) async {
    final FeedbackImageEditorState state = await pumpEditor(tester);
    final Offset c =
        tester.getCenter(find.byKey(const Key('feedback-editor-canvas')));

    await tester.tap(find.byKey(const Key('feedback-editor-crop')));
    await tester.pump();

    // 拖选 → 松手：进入待确认态（不自动裁剪）。
    await dragOnCanvas(tester, c - const Offset(60, 60), c + const Offset(60, 60));
    await tester.pump();
    expect(state.hasPendingCrop, isTrue, reason: '松手进入待确认态');
    expect(state.baseSize, const Size(160, 160),
        reason: '松手不得自动裁剪（基准图不变）');
    expect(find.byKey(const Key('feedback-editor-crop-apply')), findsOneWidget,
        reason: '选区边框与确认操作持续显示');
    expect(find.byKey(const Key('feedback-editor-crop-cancel')), findsOneWidget);
    expect(find.byKey(const Key('feedback-editor-crop-handle-0-0')),
        findsOneWidget,
        reason: '八个缩放控制点显示');

    // 保存被禁用并说明原因。
    final TextButton save =
        tester.widget<TextButton>(find.byKey(const Key('feedback-editor-save')));
    expect(save.onPressed, isNull, reason: '存在未应用选区时禁止保存');
    expect(find.byTooltip('请先应用或取消裁剪选区'), findsOneWidget,
        reason: '禁用必须说明原因');

    // 预览同步显示输出尺寸（未应用即可见结果）。
    final Rect pendingBefore = state.pendingCrop!;
    expect(
        find.text(
            '输出尺寸 ${pendingBefore.width.round()}×${pendingBefore.height.round()}'),
        findsOneWidget,
        reason: '拖动选区同步更新裁剪结果预览与输出尺寸');

    // ① 移动选区：尺寸不变、位置改变（第 1 步跨过 pan slop，第 2 步生效）。
    await dragOnCanvas(tester, c, c + const Offset(40, 20), steps: 2);
    final Rect moved = state.pendingCrop!;
    expect(moved.width, pendingBefore.width, reason: '移动不改变尺寸');
    expect(moved.topLeft, isNot(pendingBefore.topLeft),
        reason: '移动改变了位置');

    // ② 控制点缩放：拖右下角（锚点 (1,1) → key 2-2）。
    final Rect beforeResize = state.pendingCrop!;
    final Offset handleCenter = tester
        .getCenter(find.byKey(const Key('feedback-editor-crop-handle-2-2')));
    await dragOnCanvas(tester, handleCenter, handleCenter - const Offset(40, 40),
        steps: 2);
    final Rect resized = state.pendingCrop!;
    expect(resized.width, lessThan(beforeResize.width),
        reason: '控制点缩放改变选区');
    expect(resized.width, greaterThanOrEqualTo(8));
    expect(resized.height, greaterThanOrEqualTo(8));

    // ③ 重新框选：在选区外拖出新选区。
    await dragOnCanvas(tester, c - const Offset(70, 70), c - const Offset(10, 10));
    final Rect reframed = state.pendingCrop!;
    expect(reframed, isNot(resized), reason: '重新框选替换旧选区');

    // ④ 取消裁剪：选区丢弃、基准图不变、保存恢复可用。
    await tester.tap(find.byKey(const Key('feedback-editor-crop-cancel')));
    await tester.pump();
    expect(state.hasPendingCrop, isFalse);
    expect(state.baseSize, const Size(160, 160));
    expect(
        tester
            .widget<TextButton>(find.byKey(const Key('feedback-editor-save')))
            .onPressed,
        isNotNull,
        reason: '取消后保存恢复可用');

    // ⑤ 再次框选并应用：基准图变更为选区尺寸，主画布展示完整结果。
    await dragOnCanvas(tester, c - const Offset(50, 40), c + const Offset(50, 40));
    final Rect toApply = state.pendingCrop!;
    await tester.tap(find.byKey(const Key('feedback-editor-crop-apply')));
    await pumpUntil(tester, () => !state.hasPendingCrop);
    await tester.pump();
    expect(state.baseSize,
        Size(toApply.width.round().toDouble(), toApply.height.round().toDouble()),
        reason: '应用裁剪后主画布展示完整裁剪结果');
    expect(
        find.text(
            '输出尺寸 ${state.baseSize.width.toInt()}×${state.baseSize.height.toInt()}'),
        findsOneWidget,
        reason: '应用后预览输出尺寸与结果一致');

    // 保存可用并产出字节。
    await tester.tap(find.byKey(const Key('feedback-editor-save')));
    final Uint8List saved = await waitSaved(tester);
    final DecodedPng out = await decodePng(saved, tester);
    expect(out.width, state.baseSize.width.toInt());
    expect(out.height, state.baseSize.height.toInt());

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('裁剪保留实色遮挡：像素断言 + 预览与导出同一结果 + 辅助元素不入图',
      (tester) async {
    const List<int> kGray = <int>[0x6E, 0x6E, 0x73, 255];
    const List<int> kGreen = <int>[76, 175, 80, 255]; // Colors.green 0xFF4CAF50
    final FeedbackImageEditorState state = await pumpEditor(tester);
    final Offset c =
        tester.getCenter(find.byKey(const Key('feedback-editor-canvas')));

    // ① 先加一块不透明遮挡（实色块）。
    await tester.tap(find.byKey(const Key('feedback-editor-mask')));
    await tester.pump();
    await dragOnCanvas(tester, c - const Offset(30, 30), c + const Offset(30, 30));
    expect(state.editOps, hasLength(1));
    expect(state.editOps.single.mask, isTrue, reason: '提交的是遮挡操作');

    // ② 框选覆盖遮挡区域 → 待确认（不自动裁剪）。
    await tester.tap(find.byKey(const Key('feedback-editor-crop')));
    await tester.pump();
    await dragOnCanvas(tester, c - const Offset(80, 80), c + const Offset(80, 80));
    expect(state.hasPendingCrop, isTrue);
    final Rect pending = state.pendingCrop!;
    final Rect maskRect = state.editOps.single.rect;
    expect(pending.contains(maskRect.topLeft), isTrue,
        reason: '选区覆盖遮挡左上');
    expect(pending.contains(maskRect.bottomRight), isTrue,
        reason: '选区覆盖遮挡右下');

    // 未应用时保存禁用（辅助选区元素不会先于应用进入导出）。
    expect(
        tester
            .widget<TextButton>(find.byKey(const Key('feedback-editor-save')))
            .onPressed,
        isNull);

    // ③ 应用裁剪 → 遮挡类型保留（仍是遮挡，不是描边）。
    final int outW = pending.width.round();
    final int outH = pending.height.round();
    await tester.tap(find.byKey(const Key('feedback-editor-crop-apply')));
    await pumpUntil(tester, () => !state.hasPendingCrop);
    await tester.pump();
    expect(state.editOps, hasLength(1), reason: '裁剪后遮挡仍在操作列表');
    expect(state.editOps.single.mask, isTrue,
        reason: '裁剪必须保留遮挡类型（不得退化成矩形描边）');
    expect(state.baseSize,
        Size(outW.toDouble(), outH.toDouble()));

    // ④ 保存 → 与预览同一结果（输出尺寸一致），像素断言。
    await tester.tap(find.byKey(const Key('feedback-editor-save')));
    final Uint8List saved = await waitSaved(tester);
    final DecodedPng out = await decodePng(saved, tester);
    expect(out.width, outW, reason: '导出尺寸 = 预览输出尺寸（同一编辑结果）');
    expect(out.height, outH);

    // 遮挡中心：不透明实色 rgb(110,110,115)（裁剪前遮挡中心在图像坐标）。
    final int maskCx = (maskRect.center.dx - pending.left).round();
    final int maskCy = (maskRect.center.dy - pending.top).round();
    expectPixel(out.pixelAt(maskCx, maskCy), kGray,
        '裁剪后遮挡仍是不透明实色块 rgb(110,110,115)');

    // 遮挡外、选区内：保持基准绿色（描边式退化会让中心露底 → 本断言即回归点）。
    final int outsideX = (maskRect.right + 6 - pending.left).round().clamp(0, outW - 1);
    final int outsideY = (maskRect.center.dy - pending.top).round();
    expectPixel(out.pixelAt(outsideX, outsideY), kGreen,
        '遮挡外应保持基准底色（遮挡是实色块而非全图覆盖）');

    // 辅助元素不入图：四角应为纯基准色（无暗化遮罩 / 白边框 / 网格线）。
    expectPixel(out.pixelAt(2, 2), kGreen, '左上角不得混入覆盖层元素');
    expectPixel(out.pixelAt(outW - 3, 2), kGreen, '右上角不得混入覆盖层元素');
    expectPixel(out.pixelAt(2, outH - 3), kGreen, '左下角不得混入覆盖层元素');
    expectPixel(out.pixelAt(outW - 3, outH - 3), kGreen,
        '右下角不得混入覆盖层元素');

    // ⑤ 应用后可继续标注、遮挡、撤销。
    await tester.tap(find.byKey(const Key('feedback-editor-rect')));
    await tester.pump();
    final Offset c2 =
        tester.getCenter(find.byKey(const Key('feedback-editor-canvas')));
    await dragOnCanvas(tester, c2 - const Offset(60, 60), c2 - const Offset(5, 5));
    expect(state.editOps, hasLength(2), reason: '应用后可继续标注');
    await tester.tap(find.byKey(const Key('feedback-editor-undo')));
    await tester.pump();
    expect(state.editOps, hasLength(1), reason: '可撤销');
    expect(state.editOps.single.mask, isTrue, reason: '撤销后遮挡仍在');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('布局：宽屏左侧编辑 + 右侧 280px 结果预览', (tester) async {
    final FeedbackImageEditorState state =
        await pumpEditor(tester, surface: const Size(1000, 800));
    expect(state, isNotNull);
    final Rect preview =
        tester.getRect(find.byKey(const Key('feedback-editor-crop-preview')));
    expect(preview.width, 280, reason: '宽屏结果预览固定 280px');
    final Rect canvas =
        tester.getRect(find.byKey(const Key('feedback-editor-canvas')));
    expect(canvas.right, moreOrLessEquals(preview.left, epsilon: 1),
        reason: '左侧为编辑画布');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('布局：窄屏上下排列，结果区高 160px，底部固定确认按钮', (tester) async {
    final FeedbackImageEditorState state =
        await pumpEditor(tester, surface: const Size(560, 900));
    expect(state, isNotNull);
    final Rect preview =
        tester.getRect(find.byKey(const Key('feedback-editor-crop-preview')));
    expect(preview.height, 160, reason: '窄屏结果区高 160px');

    final Rect bar =
        tester.getRect(find.byKey(const Key('feedback-editor-confirm-bar')));
    final Rect scaffold = tester.getRect(find.byType(Scaffold));
    expect(bar.bottom, moreOrLessEquals(scaffold.bottom, epsilon: 1),
        reason: '确认按钮固定在底部');
    expect(find.byKey(const Key('feedback-editor-crop-hint')), findsOneWidget,
        reason: '无选区时给出下一步提示');

    // 有选区时底部确认按钮出现（应用 / 取消）。
    final Offset c =
        tester.getCenter(find.byKey(const Key('feedback-editor-canvas')));
    await tester.tap(find.byKey(const Key('feedback-editor-crop')));
    await tester.pump();
    await dragOnCanvas(tester, c - const Offset(50, 50), c + const Offset(50, 50));
    expect(find.byKey(const Key('feedback-editor-crop-apply')), findsOneWidget);
    expect(find.byKey(const Key('feedback-editor-crop-cancel')), findsOneWidget);
    final Rect apply =
        tester.getRect(find.byKey(const Key('feedback-editor-crop-apply')));
    expect(apply.bottom, lessThanOrEqualTo(scaffold.bottom + 1),
        reason: '确认按钮位于底部固定区');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 2));
  });
}
