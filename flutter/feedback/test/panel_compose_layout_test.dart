// 面板呈现（T2.7 / T2.6 / T4）与既有能力回归验收：
// - 组件顺序：标题与页签 → 反馈描述 → 图片证据 → 可折叠日志 → 固定提交区；
// - 缩略图完整显示（contain，禁止 cover 二次裁切）、标记与尺寸、操作在图下方；
// - 日志默认只显示摘要，展开后查看 / 预览 / 移除 / 重新采集（T4）；
// - 点击目标 ≥48dp。

import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_utils.dart';
import 'panel_harness.dart';

/// 16x16 生成 PNG（真实编码）。
Future<Uint8List> makePng(WidgetTester tester, {Color color = Colors.blue}) async {
  final Uint8List? result = await tester.runAsync<Uint8List>(() async {
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    canvas.drawRect(
        const Rect.fromLTWH(0, 0, 16, 16), Paint()..color = color);
    final ui.Picture picture = recorder.endRecording();
    final ui.Image img = await picture.toImage(16, 16);
    picture.dispose();
    final ByteData? data =
        await img.toByteData(format: ui.ImageByteFormat.png);
    img.dispose();
    return data!.buffer.asUint8List();
  });
  return result!;
}

void main() {
  group('T2.7：面板组件顺序（标题与页签 → 反馈描述 → 图片 → 日志 → 固定提交区）', () {
    testWidgets('纵向顺序断言', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      await pumpPanel(tester, server: server);
      await tester.pumpAndSettle();

      final double tabsTop =
          tester.getRect(find.byKey(const Key('tab-compose'))).top;
      final double inputTop =
          tester.getRect(find.byKey(const Key('feedback-input'))).top;
      final double imagesTop =
          tester.getRect(find.byKey(const Key('feedback-images-count'))).top;
      final double logsTop =
          tester.getRect(find.byKey(const Key('feedback-logs-count'))).top;
      final double submitTop =
          tester.getRect(find.byKey(const Key('feedback-submit'))).top;

      expect(tabsTop, lessThan(inputTop), reason: '标题与页签在最上');
      expect(inputTop, lessThan(imagesTop), reason: '反馈描述在图片证据之前');
      expect(imagesTop, lessThan(logsTop), reason: '图片证据在日志之前');
      expect(logsTop, lessThan(submitTop), reason: '日志在固定提交区之前');

      // 提交区固定在面板底部（不随内容滚动）。
      final Rect bar =
          tester.getRect(find.byKey(const Key('feedback-submit-bar')));
      final Rect panel = tester.getRect(find.byType(FeedbackPanel));
      expect(bar.bottom, moreOrLessEquals(panel.bottom, epsilon: 1),
          reason: '固定提交区贴面板底边');

      // 技术信息弱化：日志默认只显示摘要。
      expect(find.byKey(const Key('feedback-logs-summary')), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-item-0')), findsNothing);

      await teardownPanel(tester);
    });
  });

  group('T2.6：图片缩略图完整显示、标记与尺寸、操作不遮挡内容', () {
    testWidgets('局部截图标记 + contain 完整显示 + 尺寸标签 + 操作在图下方',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      await pumpPanel(tester, server: server);
      await tester.pumpAndSettle();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

      panel.setScreenshot(
        await makePng(tester),
        const FeedbackCaptureInfo(
          viewportWidth: 800,
          viewportHeight: 600,
          pixelWidth: 16,
          pixelHeight: 16,
          capturedAt: 't',
          region: FeedbackCaptureRegion(
              x: 0.1, y: 0.1, width: 0.5, height: 0.4),
        ),
      );
      await tester.pump();

      // 标记：局部截图。
      expect(find.byKey(const Key('feedback-screenshot-badge')), findsOneWidget);
      expect(find.text('局部截图'), findsOneWidget);

      // 完整显示：fit 必须是 contain（禁止 cover 二次裁切）。
      final Image thumb = tester.widget<Image>(find.descendant(
          of: find.byKey(const Key('feedback-screenshot-thumb')),
          matching: find.byType(Image)));
      expect(thumb.fit, BoxFit.contain, reason: '缩略图必须完整显示');

      // 尺寸标签（图像流解析后出现）。
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-image-size')).evaluate().isNotEmpty);
      expect(find.text('16×16'), findsOneWidget);

      // 编辑 / 删除在图片下方，不遮挡图片内容。
      final Rect imageArea = tester
          .getRect(find.byKey(const Key('feedback-screenshot-thumb')));
      final Rect edit =
          tester.getRect(find.byKey(const Key('feedback-image-edit-0')));
      final Rect remove = tester
          .getRect(find.byKey(const Key('feedback-remove-screenshot-btn')));
      expect(edit.top, greaterThanOrEqualTo(imageArea.bottom - 0.5),
          reason: '编辑按钮在图片下方');
      expect(remove.top, greaterThanOrEqualTo(imageArea.bottom - 0.5),
          reason: '删除按钮在图片下方');
      // 点击目标 ≥48dp。
      expect(edit.height, greaterThanOrEqualTo(48));
      expect(remove.height, greaterThanOrEqualTo(48));

      await teardownPanel(tester);
    });

    testWidgets('编辑保存后标记「已编辑」（原槽位替换）', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', <String, Object?>{
        'authenticated': true,
        'kind': 'client',
        'user': userJson(),
        'quota': quotaJson(),
        'capabilities': <String, Object?>{'dialogue': true, 'images': 5},
      });
      final Uint8List png = await makePng(tester);
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: FeedbackPanel(
            config: FeedbackConfig('https://svc.test', 'com.example.app'),
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: server.client,
            imagePicker: () => <FeedbackImageFile>[
              FeedbackImageFile(
                id: 'edit-me',
                filename: 'e.png',
                bytes: png,
                mime: 'image/png',
              ),
            ],
          ),
        ),
      ));
      await tester.pump();
      await tester.pumpAndSettle();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump();

      // 打开编辑器 → 保存（替换原槽位，source=edited）。
      await tester.tap(find.byKey(const Key('feedback-image-edit-0')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isNotEmpty);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('feedback-editor-save')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isEmpty);
      await tester.pumpAndSettle();

      expect(panel.imageCount, 1);
      expect(find.text('已编辑'), findsOneWidget, reason: '编辑后标记「已编辑」');

      await teardownPanel(tester);
    });
  });

  group('T4：诊断日志默认折叠摘要，展开可查看 / 预览 / 移除 / 重新采集', () {
    testWidgets('无日志默认「暂无日志」摘要；展开显示空态、重新采集入口',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      await pumpPanel(tester, server: server);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('feedback-logs-summary')), findsOneWidget);
      expect(find.text('暂无日志'), findsOneWidget);
      expect(find.byKey(const Key('feedback-logs-list')), findsNothing);
      expect(find.byKey(const Key('feedback-logs-empty')), findsNothing);

      await tester.tap(find.byKey(const Key('feedback-logs-expand')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-logs-empty')), findsOneWidget,
          reason: '展开后显示空态（有下一步）');
      expect(find.byKey(const Key('feedback-logs-recollect')), findsOneWidget,
          reason: '展开后可重新采集');

      // 再次点击收起。
      await tester.tap(find.byKey(const Key('feedback-logs-expand')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-logs-empty')), findsNothing);

      await teardownPanel(tester);
    });

    testWidgets('已附日志默认折叠显示摘要；展开后可预览与移除', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      await pumpPanel(
        tester,
        server: server,
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.app',
          logProvider: () async => <FeedbackLogFile>[
            FeedbackLogFile(
              filename: 'diagnostics.log',
              bytes: Uint8List.fromList(utf8.encode('diag line')),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('已附诊断日志'), findsOneWidget);
      expect(find.byKey(const Key('feedback-log-name-0')), findsNothing,
          reason: '默认只显示摘要');

      await tester.tap(find.byKey(const Key('feedback-logs-expand')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-log-name-0')), findsOneWidget);

      // 预览。
      await tester.tap(find.byKey(const Key('feedback-log-btn-preview-0')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback-log-preview-dialog')), findsOneWidget);
      await tester.tap(find.byKey(const Key('feedback-log-preview-close')));
      await tester.pumpAndSettle();

      // 移除 → 摘要回到暂无日志。
      await tester.tap(find.byKey(const Key('feedback-log-btn-remove-0')));
      await tester.pumpAndSettle();
      expect(find.text('暂无日志'), findsOneWidget);

      await teardownPanel(tester);
    });
  });

  group('点击目标 ≥48dp（冻结视觉规格抽查）', () {
    testWidgets('页签、日志操作、筛选、添加按钮均 ≥48', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      server.respond('GET /api/feedback/mine', <String, Object?>{
        'items': <Object?>[],
        'page': 1,
        'limit': 10,
        'total': 0,
        'unreadTotal': 0,
      });
      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
      );
      await tester.pumpAndSettle();

      for (final Key key in <Key>[
        const Key('tab-compose'),
        const Key('tab-history'),
        const Key('feedback-btn-add-log'),
        const Key('feedback-logs-expand'),
        const Key('feedback-settings'),
        const Key('feedback-close'),
      ]) {
        final Size size = tester.getSize(find.byKey(key));
        expect(size.height, greaterThanOrEqualTo(48),
            reason: '$key 点击目标高度 ${size.height} < 48');
        expect(size.width, greaterThanOrEqualTo(48),
            reason: '$key 点击目标宽度 ${size.width} < 48');
      }

      // 状态筛选行（历史页）。
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pumpAndSettle();
      final Size filter =
          tester.getSize(find.byKey(const Key('feedback-filter-all')));
      expect(filter.height, greaterThanOrEqualTo(48),
          reason: '状态筛选点击目标 ≥48dp');

      await teardownPanel(tester);
    });
  });
}
