import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';
import 'panel_harness.dart';

/// 1x1 PNG。
final Uint8List kTinyPng = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

/// 生成 16x16 纯色 PNG（真实编码，供编辑器/缩放测试）。
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

/// 注入图片选择器的面板 harness。
Future<void> pumpPanelWithPicker(
  WidgetTester tester, {
  required PanelServer server,
  FeedbackImagePicker? pick,
  FeedbackTokenStore? tokenStore,
  FeedbackConfig? config,
}) async {
  await tester.binding.setSurfaceSize(const Size(1000, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: FeedbackPanel(
        config: config ??
            FeedbackConfig('https://svc.test', 'com.example.app',
                appVersion: '9.9.9', pageLabel: 'home'),
        tokenStore: tokenStore,
        serverPrefStore: MemoryServerPrefStore(),
        httpClient: server.client,
        imagePicker: pick,
      ),
    ),
  ));
  await tester.pump();
  await tester.pumpAndSettle();
}

Map<String, Object?> _sessionJson({int? images}) => <String, Object?>{
      'authenticated': true,
      'kind': 'client',
      'user': userJson(),
      'quota': quotaJson(),
      'capabilities': images == null
          ? <String, Object?>{'dialogue': true}
          : <String, Object?>{'dialogue': true, 'images': images},
    };

void main() {
  group('多图附件（v12）', () {
    testWidgets('手动添加 ≤5 张；第 6 张被拒并提示', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _sessionJson(images: 5));
      int calls = 0;
      await pumpPanelWithPicker(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
        pick: () {
          calls++;
          // 第 1 次返回 3 张、第 2 次返回 3 张（共 6 选 5 截断）。
          return List<FeedbackImageFile>.generate(
            3,
            (int j) => FeedbackImageFile(
              id: 'm$calls-$j',
              filename: 'm$calls-$j.png',
              bytes: kTinyPng,
              mime: 'image/png',
            ),
          );
        },
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 3);
      await tester.pump();

      // 第二次选择 3 张：只剩 2 个名额，第 6 张被截断并提示。
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 5);
      await tester.pump();
      expect(find.textContaining('最多附加 5 张图片'), findsWidgets);

      // 满额后「添加图片」隐藏。
      expect(find.byKey(const Key('feedback-btn-add-image')), findsNothing);
    });

    testWidgets('截图与手动图片并存；提交走 images multipart', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _sessionJson(images: 5));
      server.respond('GET /api/features',
          <String, Object?>{'dialogue': true, 'images': 5});
      server.respond(
          'POST /api/feedback', <String, Object?>{'feedbackId': 'f9', 'status': 'received'}, 201);
      await pumpPanelWithPicker(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
        pick: () => <FeedbackImageFile>[
          FeedbackImageFile(
            id: 'manual-1',
            filename: 'p.png',
            bytes: kTinyPng,
            mime: 'image/png',
          ),
        ],
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));

      // 截图槽位 + 手动图。
      panel.setScreenshot(kTinyPng, const FeedbackCaptureInfo(capturedAt: 't'));
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 2);
      await tester.pump();
      expect(find.byKey(const Key('feedback-screenshot-wrap')), findsOneWidget);
      expect(find.byKey(const Key('feedback-image-1')), findsOneWidget);

      // 提交。
      await tester.enterText(find.byKey(const Key('feedback-input')), '带图');
      await tester.pump(); // 草稿监听 setState 重建后按钮才启用
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await pumpUntil(tester,
          () => server.count('POST /api/feedback') == 1);

      // MockClient 会把 MultipartRequest 物化为 http.Request——按 boundary
      // 解析正文断言部件（与 submit_failure_class 既有解析一致）。
      final http.Request req =
          server.lastMatching('POST /api/feedback') as http.Request;
      final String contentType = req.headers['content-type'] ?? '';
      expect(contentType, contains('multipart/form-data'));
      final String boundary =
          RegExp(r'boundary=([^;]+)').firstMatch(contentType)!.group(1)!;
      final List<String> parts =
          latin1.decode(req.bodyBytes).split('--$boundary');
      final List<String> metaParts = parts
          .where((String p) => p.contains('name="metadata"'))
          .toList();
      expect(metaParts, hasLength(1));
      final String rawMeta =
          metaParts.single.substring(metaParts.single.indexOf('\r\n\r\n') + 4).trim();
      final Map<String, Object?> meta =
          jsonDecode(utf8.decode(latin1.encode(rawMeta)))
              as Map<String, Object?>;
      expect((meta['images'] as List<Object?>).length, 2);
      expect(
          parts.where((String p) => p.contains('name="images"')).length, 2);
      expect(
          parts.where((String p) => p.contains('name="screenshot"')),
          isEmpty);
    });

    testWidgets('能力缺失（旧服务）：单图模式 + 升级提示', (tester) async {
      final PanelServer server = PanelServer();
      // session 无 images 字段；features 也无（404）。
      server.respond('GET /api/auth/session', <String, Object?>{
        'authenticated': true,
        'kind': 'client',
        'user': userJson(),
        'quota': quotaJson(),
        // 无 capabilities。
      });
      int picks = 0;
      await pumpPanelWithPicker(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
        pick: () {
          picks++;
          return <FeedbackImageFile>[
            FeedbackImageFile(
              id: 'm$picks',
              filename: 'm.png',
              bytes: kTinyPng,
              mime: 'image/png',
            ),
          ];
        },
      );
      await tester.pump();
      // 先手动加一张：触发能力探测（features 404 → 单图模式）。
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump();
      expect(panel.singleImageMode, isTrue);
      expect(panel.imageCount, 1);
      // 升级提示可见。
      expect(find.byKey(const Key('feedback-single-image-hint')),
          findsOneWidget);
      // 单图模式已持图：「添加图片」隐藏（选择器不再被调用）。
      expect(find.byKey(const Key('feedback-btn-add-image')), findsNothing);
      expect(picks, 1);
    });

    testWidgets('编辑图片：裁剪后保存替换原槽位（不增名额）', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _sessionJson(images: 5));
      // 预生成 PNG（选择器回调内不能嵌 tester.runAsync）。
      final Uint8List png = await makePng(tester);
      await pumpPanelWithPicker(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
        pick: () => <FeedbackImageFile>[
          FeedbackImageFile(
            id: 'edit-me',
            filename: 'e.png',
            bytes: png,
            mime: 'image/png',
          ),
        ],
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump(); // pumpUntil 命中即返回，setState 的帧需再 pump 一次

      // 打开编辑器（解码走真实异步：runAsync 驱动）。
      await tester.tap(find.byKey(const Key('feedback-image-edit-0')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isNotEmpty);
      expect(find.byKey(const Key('feedback-editor-crop')), findsOneWidget);
      expect(find.byKey(const Key('feedback-editor-rect')), findsOneWidget);
      expect(find.byKey(const Key('feedback-editor-mask')), findsOneWidget);
      expect(find.byKey(const Key('feedback-editor-undo')), findsOneWidget);
      expect(find.byKey(const Key('feedback-editor-cancel')), findsOneWidget);

      // 取消：不改动。
      await tester.tap(find.byKey(const Key('feedback-editor-cancel')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isEmpty);
      await tester.pumpAndSettle(); // 等返回动画完全结束再点编辑
      expect(panel.imageCount, 1);

      // 再次打开并保存（无编辑也保存=替换为编码后的 PNG）。
      await tester.tap(find.byKey(const Key('feedback-image-edit-0')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isNotEmpty);
      await tester.pumpAndSettle(); // 等推入动画结束再点保存
      await tester.tap(find.byKey(const Key('feedback-editor-save')),
          warnIfMissed: false);
      await pumpUntil(tester,
          () => find.byKey(const Key('feedback-editor-save')).evaluate().isEmpty);
      await tester.pumpAndSettle();
      expect(panel.imageCount, 1, reason: '保存替换原槽位，不占新名额');
    });
  });

  group('normalizeFeedbackImage', () {
    test('PNG/JPEG/WebP 魔数识别与文件名规范化', () async {
      final FeedbackImageFile png = await normalizeFeedbackImage(
        kTinyPng,
        filename: 'shot.png',
      );
      expect(png.mime, 'image/png');
      expect(png.filename, 'shot.png');
      expect(png.sha256!.length, 64);

      // 扩展名与内容不符 → 按魔数规范为 .png。
      final FeedbackImageFile renamed = await normalizeFeedbackImage(
        kTinyPng,
        filename: 'wrong.jpg',
      );
      expect(renamed.filename, 'wrong.png');
    });

    test('非图片字节拒绝', () async {
      expect(
        () => normalizeFeedbackImage(Uint8List.fromList(<int>[0, 1, 2, 3])),
        throwsA(isA<FeedbackImageException>()),
      );
    });
  });
}
