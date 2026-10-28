import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'panel_harness.dart';

/// 1x1 PNG（合法魔数）。
final Uint8List kTinyPng = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

void main() {
  FeedbackConfig cfg() =>
      FeedbackConfig('https://svc.test', 'com.example.app');

  group('ApiClient v12：多图附件', () {
    test('submitFeedback 带 images：metadata 描述符与 images 部件一一对应', () async {
      late http.MultipartRequest captured;
      // MockClient.streaming 保留原始 MultipartRequest（普通 MockClient
      // 会物化为 http.Request，丢失 fields/files）。
      final http.Client mock =
          MockClient.streaming((http.BaseRequest req, http.ByteStream body) async {
        captured = req as http.MultipartRequest;
        // 排空流，模拟服务端读取完整请求体。
        await body.toBytes();
        return http.StreamedResponse(
          Stream<List<int>>.value(utf8.encode(jsonEncode(
              <String, Object?>{'feedbackId': 'f1', 'status': 'received'}))),
          201,
        );
      });
      final ApiClient api = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('tok'),
        httpClient: mock,
      );
      await api.submitFeedback(
        idempotencyKey: 'k1',
        text: '多图',
        images: <FeedbackImageFile>[
          FeedbackImageFile(
            id: 'img-1',
            filename: 'a.png',
            bytes: kTinyPng,
            mime: 'image/png',
            source: 'capture',
          ),
          FeedbackImageFile(
            id: 'img-2',
            filename: 'b.jpg',
            bytes: kTinyPng,
            mime: 'image/jpeg',
            source: 'manual',
          ),
        ],
      );
      expect(captured.headers['Authorization'], 'Bearer tok');
      final Map<String, Object?> meta =
          jsonDecode(captured.fields['metadata']!) as Map<String, Object?>;
      final List<Object?> images = meta['images'] as List<Object?>;
      expect(images.length, 2);
      final Map<String, Object?> d0 = images[0] as Map<String, Object?>;
      expect(d0['id'], 'img-1');
      expect(d0['source'], 'capture');
      expect(d0['mime'], 'image/png');
      expect((d0['sha256'] as String).length, 64);
      final List<http.MultipartFile> imageParts = captured.files
          .where((http.MultipartFile f) => f.field == 'images')
          .toList();
      expect(imageParts.length, 2);
      expect(imageParts[0].filename, 'a.png');
      expect(imageParts[1].filename, 'b.jpg');
      // images 与 screenshot 互斥：没有 screenshot 部件。
      expect(
          captured.files
              .where((http.MultipartFile f) => f.field == 'screenshot'),
          isEmpty);
      api.dispose();
    });

    test('sendFeedbackReply 带 images：metadata JSON + images 部件', () async {
      late http.MultipartRequest captured;
      final http.Client mock =
          MockClient.streaming((http.BaseRequest req, http.ByteStream body) async {
        captured = req as http.MultipartRequest;
        await body.toBytes();
        return http.StreamedResponse(
          Stream<List<int>>.value(utf8.encode(jsonEncode(<String, Object?>{
            'message': <String, Object?>{
              'id': 'm1',
              'seq': 2,
              'senderType': 'user',
              'text': '回',
              'createdAt': '2024-01-01T00:00:00Z',
            }
          }))),
          200,
        );
      });
      final ApiClient api = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('tok'),
        httpClient: mock,
      );
      await api.sendFeedbackReply(
        'fb-1',
        text: '回复带图',
        images: <FeedbackImageFile>[
          FeedbackImageFile(
            id: 'r1',
            filename: 'r.png',
            bytes: kTinyPng,
            mime: 'image/png',
          ),
        ],
      );
      expect(captured.headers['Authorization'], 'Bearer tok');
      final Map<String, Object?> meta =
          jsonDecode(captured.fields['metadata']!) as Map<String, Object?>;
      expect(meta['text'], '回复带图');
      expect((meta['images'] as List<Object?>).length, 1);
      expect(
          captured.files
              .where((http.MultipartFile f) => f.field == 'images')
              .length,
          1);
      api.dispose();
    });

    test('附件下载端点：Bearer 取回字节', () async {
      final List<String> hits = <String>[];
      final MockClient mock = MockClient((http.BaseRequest req) async {
        hits.add('${req.method} ${req.url.path}');
        expect(req.headers['Authorization'], 'Bearer tok');
        return http.Response.bytes(<int>[1, 2, 3], 200);
      });
      final ApiClient api = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('tok'),
        httpClient: mock,
      );
      await api.fetchFeedbackImage('fb-1', 'img-9');
      await api.fetchFeedbackLog('fb-1', 'log-2');
      await api.fetchMessageAttachment('att-7');
      await api.fetchFeedbackScreenshot('fb-1');
      expect(hits, <String>[
        'GET /api/feedback/fb-1/images/img-9',
        'GET /api/feedback/fb-1/logs/log-2/download',
        'GET /api/feedback/messages/attachments/att-7',
        'GET /api/feedback/fb-1/screenshot',
      ]);
      api.dispose();
    });

    test('fetchCapabilities：解析 images 能力；旧服务无字段为 null', () async {
      final ApiClient api = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('t'),
        httpClient: MockClient((http.BaseRequest req) async => jsonResponse(
            <String, Object?>{'dialogue': true, 'images': 5})),
      );
      final FeedbackCapabilities? caps = await api.fetchCapabilities();
      expect(caps?.images, 5);
      expect(caps?.dialogue, isTrue);

      final ApiClient api2 = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('t'),
        httpClient: MockClient((http.BaseRequest req) async =>
            jsonResponse(<String, Object?>{'dialogue': true})),
      );
      expect((await api2.fetchCapabilities())?.images, isNull);

      // 404 / 旧服务无此端点 → null（单图模式）。
      final ApiClient api3 = ApiClient(
        config: cfg(),
        tokenStore: MemoryTokenStore('t'),
        httpClient: MockClient((http.BaseRequest req) async =>
            jsonResponse(<String, Object?>{'error': 'nf'}, 404)),
      );
      expect(await api3.fetchCapabilities(), isNull);
      api.dispose();
      api2.dispose();
      api3.dispose();
    });
  });

  group('FeedbackCapabilities / 模型', () {
    test('FeedbackImageFile 描述符结构', () {
      final FeedbackImageFile img = FeedbackImageFile(
        id: 'i',
        filename: 'x.png',
        bytes: Uint8List(0),
        mime: 'image/png',
        source: 'edited',
      );
      final Map<String, Object?> d = img.toDescriptor('a' * 64);
      expect(d['id'], 'i');
      expect(d['source'], 'edited');
      expect(d['sha256'], 'a' * 64);
      expect(d['mime'], 'image/png');
    });

    test('IssueStatus 标签为 v12 用户端文案', () {
      expect(IssueStatus.open.label, '待处理');
      expect(IssueStatus.waitingUser.label, '待补充');
      expect(IssueStatus.waitingAdmin.label, '待管理员回复');
      expect(IssueStatus.resolved.label, '已解决');
    });
  });
}
