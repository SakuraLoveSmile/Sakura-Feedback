// v12 能力协商的乐观语义回归：
// - 探测失败（features 404 / 网络异常 / 非 200）只是「没探到」，不得据此判定
//   为「已确认的单图服务端」：界面继续按契约上限（5 张）乐观放行；
// - 只有真的拿到 capabilities 对象才确认能力（无 images 数值 → 单图 + 升级提示）；
// - session 后续响应缺 capabilities（null）不得把已确认的数值降级；
// - 单图模式（images = 1）语义不变：单图降级提交 + 升级提示。

import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';
import 'panel_harness.dart';

/// 1x1 PNG（合法编码，Image.memory 可解码）。
final Uint8List kPng = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

/// 会话响应体：可选携带 capabilities 对象。
Map<String, Object?> sessionWithCaps([Map<String, Object?>? caps]) =>
    <String, Object?>{
      'authenticated': true,
      'kind': 'client',
      'user': userJson(),
      'quota': quotaJson(),
      if (caps != null) 'capabilities': caps,
    };

/// 单个图片文件的选择器返回值。
List<FeedbackImageFile> oneImage(String id) => <FeedbackImageFile>[
      FeedbackImageFile(
        id: id,
        filename: '$id.png',
        bytes: kPng,
        mime: 'image/png',
      ),
    ];

/// 注入图片选择器的面板（[pumpPanel] 不暴露 imagePicker，经 config 传入）。
Future<void> pumpCapPanel(
  WidgetTester tester, {
  required PanelServer server,
  required List<FeedbackImageFile> Function() pick,
  bool? visible,
}) =>
    pumpPanel(
      tester,
      server: server,
      tokenStore: MemoryTokenStore('tok'),
      visible: visible,
      config: FeedbackConfig(
        'https://svc.test',
        'com.example.app',
        appVersion: '9.9.9',
        pageLabel: 'home',
        imagePicker: pick,
      ),
    );

/// 当前图片数量文案（「图片附件 (n/limit)」）。
String countLabel(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('feedback-images-count'))).data!;

/// 解析 multipart 部件名（MockClient 会把 MultipartRequest 物化成 http.Request，
/// 因此按 boundary 切分正文读部件名，与 multi_image_test 的既有解析一致）。
List<String> partNames(http.Request request) {
  final String contentType = request.headers['content-type'] ?? '';
  expect(contentType, contains('multipart/form-data'),
      reason: '携带图片必须走 multipart');
  final RegExpMatch? match =
      RegExp(r'boundary=([^;]+)').firstMatch(contentType);
  expect(match, isNotNull, reason: 'multipart 请求必须携带 boundary');
  final String boundary = match!.group(1)!;
  return latin1
      .decode(request.bodyBytes)
      .split('--$boundary')
      .map(
          (String part) => RegExp(r'name="([^"]+)"').firstMatch(part)?.group(1))
      .whereType<String>()
      .toList();
}

/// 解析 multipart 内的 metadata JSON。
Map<String, Object?> partMetadata(http.Request request) {
  final String contentType = request.headers['content-type'] ?? '';
  final RegExpMatch? match =
      RegExp(r'boundary=([^;]+)').firstMatch(contentType);
  final String boundary = match!.group(1)!;
  final List<String> parts =
      latin1.decode(request.bodyBytes).split('--$boundary');
  final String raw =
      parts.where((String p) => p.contains('name="metadata"')).single;
  final String json = raw.substring(raw.indexOf('\r\n\r\n') + 4).trim();
  return jsonDecode(utf8.decode(latin1.encode(json))) as Map<String, Object?>;
}

void main() {
  group('v12 能力探测：失败不降级（乐观多图）', () {
    testWidgets('已有 1 张自动截图且能力未探测：仍渲染「添加图片」并可加第 2 张', (tester) async {
      final PanelServer server = PanelServer();
      // session 不带 capabilities；features 未编排（404 = 探测失败）。
      server.respond('GET /api/auth/session', sessionWithCaps());
      int picks = 0;
      await pumpCapPanel(
        tester,
        server: server,
        pick: () {
          picks++;
          return oneImage('m$picks');
        },
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      panel.setScreenshot(
        kPng,
        const FeedbackCaptureInfo(
          viewportWidth: 1000,
          viewportHeight: 800,
          pixelWidth: 1,
          pixelHeight: 1,
          capturedAt: 't',
        ),
      );
      await tester.pump();

      expect(panel.imageCount, 1, reason: '自动截图已入列表');
      expect(panel.singleImageMode, isFalse, reason: '探测失败不等于已确认单图服务端');
      expect(panel.captureImageLimit, kFeedbackMaxImages,
          reason: '能力未确认时按契约上限乐观放行');
      expect(find.byKey(const Key('feedback-btn-add-image')), findsOneWidget,
          reason: '1/5 未达上限，添加图片必须可用');
      expect(find.byKey(const Key('feedback-single-image-hint')), findsNothing);
      expect(countLabel(tester), '图片附件 (1/5)', reason: '未知能力按契约上限展示，不得显示 1/1');

      // 第 2 张：先探测（features 404 → 保持未确认），选择器仍被调用。
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 2);
      await tester.pump();
      expect(picks, 1);
      expect(panel.imageCount, 2);
      expect(panel.singleImageMode, isFalse);
      expect(find.byKey(const Key('feedback-single-image-hint')), findsNothing);
      expect(find.byKey(const Key('feedback-btn-add-image')), findsOneWidget);
      expect(countLabel(tester), '图片附件 (2/5)');

      await teardownPanel(tester);
    });

    testWidgets('features 探测 404 后：可加第 2 张，提交走 images（非单图截图字段）',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionWithCaps());
      server.respond(
          'GET /api/features',
          <String, Object?>{
            'error': <String, Object?>{'code': 'not_found'}
          },
          404);
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);
      int picks = 0;
      await pumpCapPanel(
        tester,
        server: server,
        pick: () {
          picks++;
          return oneImage('m$picks');
        },
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await tester.enterText(find.byKey(const Key('feedback-input')), '两张图');
      await tester.pump();

      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump();
      expect(panel.singleImageMode, isFalse, reason: '404 探测失败 → 保持乐观');
      expect(find.byKey(const Key('feedback-single-image-hint')), findsNothing);

      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 2);
      await tester.pump();
      expect(panel.imageCount, 2, reason: '探测失败不得把上限压成 1 张');
      expect(panel.singleImageMode, isFalse);
      expect(find.byKey(const Key('feedback-single-image-hint')), findsNothing);

      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(panel.stage, FeedbackStage.accepted);

      final http.Request request =
          server.lastMatching('POST /api/feedback') as http.Request;
      final List<String> parts = partNames(request);
      final Map<String, Object?> metadata = partMetadata(request);
      final List<Object?> images = metadata['images']! as List<Object?>;
      expect(images, hasLength(2), reason: '乐观路径按 images 有序列表提交');
      expect(parts.where((String n) => n == 'images'), hasLength(2));
      expect(parts.where((String n) => n == 'screenshot'), isEmpty,
          reason: '未确认单图服务端不得降级成 screenshot 字段');

      await teardownPanel(tester);
    });

    testWidgets('features 返回 capabilities 但缺 images：确认单图服务端（仍单图 + 提示）',
        (tester) async {
      final PanelServer server = PanelServer();
      // 旧服务端：session 无 capabilities，features 有对象但无 images 数值。
      server.respond('GET /api/auth/session', sessionWithCaps());
      server.respond('GET /api/features', <String, Object?>{'dialogue': true});
      int picks = 0;
      await pumpCapPanel(
        tester,
        server: server,
        pick: () {
          picks++;
          return oneImage('m$picks');
        },
      );
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump();

      expect(panel.singleImageMode, isTrue,
          reason: '拿到 capabilities 对象且缺 images → 已确认单图');
      expect(
          find.byKey(const Key('feedback-single-image-hint')), findsOneWidget);
      expect(find.byKey(const Key('feedback-btn-add-image')), findsNothing,
          reason: '单图模式已持图：不能再加');
      expect(picks, 1);
      expect(countLabel(tester), '图片附件 (1/1)');

      await teardownPanel(tester);
    });
  });

  group('v12 能力确认：已确认数值不被覆盖', () {
    testWidgets('images=5 后 session 返回 capabilities 为 null：不降级',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session',
          sessionWithCaps(<String, Object?>{'dialogue': true, 'images': 5}));
      // 之后的会话响应不再携带 capabilities 对象（旧服务/降级部署）。
      server.respond('GET /api/auth/session', sessionWithCaps());
      server.respond('GET /api/features',
          <String, Object?>{'dialogue': true, 'images': 5});
      await pumpCapPanel(tester, server: server, pick: () => oneImage('m1'));
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await pumpUntil(
          tester, () => panel.captureImageLimit == kFeedbackMaxImages);
      await tester.pump();
      // 挂载初期能力未知 → features 可能已探测过一次（与 session 并发）；
      // 「不再探测」以此刻为基线判断。
      final int featuresProbes = server.count('GET /api/features');

      expect(panel.singleImageMode, isFalse);
      expect(countLabel(tester), '图片附件 (0/5)');
      expect(find.byKey(const Key('feedback-btn-add-image')), findsOneWidget);

      // 关→开面板触发第二次会话刷新（响应无 capabilities）。
      await pumpCapPanel(tester,
          server: server, pick: () => oneImage('m1'), visible: false);
      await tester.pump();
      await pumpCapPanel(tester,
          server: server, pick: () => oneImage('m1'), visible: true);
      await pumpUntil(tester, () => server.count('GET /api/auth/session') == 2);
      await tester.pump();
      await tester.pump();

      expect(panel.singleImageMode, isFalse,
          reason: 'capabilities 缺失不得把已确认的 images=5 降级成单图');
      expect(panel.captureImageLimit, kFeedbackMaxImages);
      expect(countLabel(tester), '图片附件 (0/5)');
      expect(find.byKey(const Key('feedback-single-image-hint')), findsNothing);
      expect(server.count('GET /api/features'), featuresProbes,
          reason: '能力已确认后不再重复探测 features');

      await teardownPanel(tester);
    });

    testWidgets('images=1：保持单图模式 + 升级提示，单图降级提交', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session',
          sessionWithCaps(<String, Object?>{'dialogue': true, 'images': 1}));
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f2', 'status': 'received'}, 201);
      await pumpCapPanel(tester, server: server, pick: () => oneImage('m1'));
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await pumpUntil(tester, () => panel.captureImageLimit == 1);
      await tester.pump();

      expect(panel.singleImageMode, isTrue);
      expect(
          find.byKey(const Key('feedback-single-image-hint')), findsOneWidget);
      expect(countLabel(tester), '图片附件 (0/1)');

      await tester.enterText(find.byKey(const Key('feedback-input')), '单图服务端');
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-btn-add-image')));
      await pumpUntil(tester, () => panel.imageCount == 1);
      await tester.pump();
      expect(panel.imageCount, 1);
      expect(find.byKey(const Key('feedback-btn-add-image')), findsNothing);

      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.pump();
      expect(panel.stage, FeedbackStage.accepted);

      final http.Request request =
          server.lastMatching('POST /api/feedback') as http.Request;
      final List<String> parts = partNames(request);
      expect(parts.where((String n) => n == 'screenshot'), hasLength(1),
          reason: '单图服务端走旧 screenshot 字段');
      expect(parts.where((String n) => n == 'images'), isEmpty);

      await teardownPanel(tester);
    });
  });
}
