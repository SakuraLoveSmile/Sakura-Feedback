import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 返回 UTF-8 字节响应（`http.Response(String)` 对非 Latin-1 文本会抛错）。
http.Response jsonResponse(Object body, [int status = 200]) =>
    http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: const <String, String>{'content-type': 'application/json'},
    );

Uint8List bytes(String text) => Uint8List.fromList(utf8.encode(text));

/// multipart 请求体按文本读取（结构断言用；日志内容均为 UTF-8）。
String multipartBody(http.Request request) =>
    utf8.decode(request.bodyBytes, allowMalformed: true);

/// 取出 multipart 中的 `metadata` 字段并解析为 JSON。
Map<String, Object?> multipartMetadata(http.Request request) {
  final String body = multipartBody(request);
  final int field = body.indexOf('name="metadata"');
  expect(field, greaterThanOrEqualTo(0), reason: '缺少 metadata 字段');
  final int start = body.indexOf('\r\n\r\n', field) + 4;
  final int end = body.indexOf('\r\n--', start);
  expect(end, greaterThan(start), reason: 'metadata 字段没有结束边界');
  final Object? decoded = jsonDecode(body.substring(start, end));
  return decoded! as Map<String, Object?>;
}

/// 统计某个文件名部件在请求体中出现的位置（顺序断言用）。
int partIndex(http.Request request, String filename) =>
    multipartBody(request).indexOf('filename="$filename"');

void main() {
  FeedbackConfig buildConfig({String? version, String? page}) => FeedbackConfig(
        'https://fb.example.com',
        'com.example.app',
        appVersion: version,
        pageLabel: page,
      );

  group('日志附件校验（契约 §1.1）', () {
    test('合法文件：扩展名大小写不敏感、UTF-8 允许中文与 BOM', () {
      expect(validateFeedbackLogFile('app.log', bytes('hello')), isNull);
      expect(validateFeedbackLogFile('APP.LOG', bytes('hello')), isNull);
      expect(validateFeedbackLogFile('网络.jsonl', bytes('{"a":1}\n')), isNull);
      expect(validateFeedbackLogFile('trace.txt', bytes('中文日志\n')), isNull);
      expect(
        validateFeedbackLogFile(
          'with-bom.json',
          Uint8List.fromList(<int>[
            0xEF, 0xBB, 0xBF,
            ...utf8.encode('{"ok":true}'),
          ]),
        ),
        isNull,
      );
    });

    test('扩展名白名单：其它扩展名明确拒绝', () {
      expect(validateFeedbackLogFile('notes.md', bytes('x')),
          contains('必须是 .log/.txt/.json/.jsonl'));
      expect(validateFeedbackLogFile('app.log.gz', bytes('x')),
          contains('必须是 .log/.txt/.json/.jsonl'));
      expect(validateFeedbackLogFile('noext', bytes('x')),
          contains('必须是 .log/.txt/.json/.jsonl'));
    });

    test('文件名：空名 / 超长 / 含路径分隔符拒绝', () {
      expect(validateFeedbackLogFile('   ', bytes('x')), contains('1–255'));
      expect(validateFeedbackLogFile('${'a' * 256}.log', bytes('x')),
          contains('1–255'));
      expect(validateFeedbackLogFile('../etc/passwd.log', bytes('x')),
          contains('路径分隔符'));
      expect(validateFeedbackLogFile(r'dir\app.log', bytes('x')),
          contains('路径分隔符'));
    });

    test('大小与空文件：空文件、仅 BOM、超过 1MiB 都拒绝且不截断', () {
      expect(validateFeedbackLogFile('empty.log', Uint8List(0)),
          contains('不能为空'));
      expect(
        validateFeedbackLogFile(
          'bom.log',
          Uint8List.fromList(<int>[0xEF, 0xBB, 0xBF]),
        ),
        contains('仅含 BOM'),
      );
      expect(
        validateFeedbackLogFile('big.log', Uint8List(kFeedbackMaxLogBytes + 1)),
        contains('1MiB'),
      );
      expect(
        validateFeedbackLogFile(
          'edge.log',
          Uint8List.fromList(
            List<int>.filled(kFeedbackMaxLogBytes, 0x61), // 'a' × 1MiB
          ),
        ),
        isNull,
        reason: '恰好 1MiB 允许（上限含等号）',
      );
    });

    test('严格 UTF-8：非法字节与 NUL 拒绝', () {
      expect(
        validateFeedbackLogFile(
          'bin.log',
          Uint8List.fromList(<int>[0xFF, 0xFE, 0x41]),
        ),
        contains('不是有效 UTF-8'),
      );
      expect(
        validateFeedbackLogFile(
          'nul.log',
          Uint8List.fromList(<int>[0x41, 0x00, 0x42]),
        ),
        contains('NUL'),
      );
      // 截断的多字节序列（非完整 UTF-8）也必须拒绝。
      expect(
        validateFeedbackLogFile(
          'trunc.log',
          Uint8List.fromList(<int>[0xE4, 0xB8]),
        ),
        contains('不是有效 UTF-8'),
      );
    });

    test('常量与契约一致', () {
      expect(kFeedbackMaxLogs, 3);
      expect(kFeedbackMaxLogBytes, 1048576);
      expect(kFeedbackLogExtensions, <String>['log', 'txt', 'json', 'jsonl']);
    });
  });

  group('ApiClient 日志编码（契约 §1）', () {
    late List<http.Request> captured;

    ApiClient buildApi() {
      captured = <http.Request>[];
      return ApiClient(
        config: buildConfig(version: '1.2.3'),
        tokenStore: MemoryTokenStore('tok-log'),
        httpClient: MockClient((http.Request request) async {
          captured.add(request);
          return jsonResponse({'feedbackId': 'f-log', 'status': 'received'}, 201);
        }),
      );
    }

    test('有日志 → multipart；metadata.logs 与部件同序、byteSize 一致、text/plain', () async {
      final ApiClient api = buildApi();
      final Uint8List firstBytes = bytes('第一行\n第二行\n');
      final Uint8List secondBytes = bytes('{"status":200}\n');
      final List<FeedbackLogAttachment> logs = <FeedbackLogAttachment>[
        FeedbackLogAttachment(
          name: 'app.log',
          source: FeedbackLogSource.auto,
          bytes: firstBytes,
        ),
        FeedbackLogAttachment(
          name: 'network.jsonl',
          source: FeedbackLogSource.manual,
          bytes: secondBytes,
        ),
      ];

      final FeedbackSubmitResult result = await api.submitFeedback(
        idempotencyKey: 'k-log',
        text: '日志已附上',
        logs: logs,
      );
      expect(result.feedbackId, 'f-log');

      final http.Request request = captured.single;
      expect(request.url.path, '/api/feedback');
      expect(request.headers['content-type'], contains('multipart/form-data'));
      expect(request.headers['authorization'], 'Bearer tok-log');

      final Map<String, Object?> metadata = multipartMetadata(request);
      expect(metadata['idempotencyKey'], 'k-log');
      expect(metadata['appId'], 'com.example.app');
      expect(metadata['text'], '日志已附上');
      expect(metadata['logs'], <Object?>[
        <String, Object?>{
          'name': 'app.log',
          'source': 'auto',
          'byteSize': firstBytes.length,
        },
        <String, Object?>{
          'name': 'network.jsonl',
          'source': 'manual',
          'byteSize': secondBytes.length,
        },
      ]);
      // 线上 byteSize 必须与实际字节数一致（服务端会逐项核对）。
      expect(logs[0].byteSize, firstBytes.length);
      expect(logs[1].byteSize, secondBytes.length);

      final String body = multipartBody(request);
      expect(body.contains('filename="app.log"'), isTrue);
      expect(body.contains('filename="network.jsonl"'), isTrue);
      // 顺序：metadata 先，随后 logs 部件按 metadata 顺序 append。
      expect(partIndex(request, 'app.log'),
          lessThan(partIndex(request, 'network.jsonl')));
      expect(body.indexOf('name="logs"; filename="app.log"'),
          lessThan(body.indexOf('name="logs"; filename="network.jsonl"')));
      // 每个日志部件显式 text/plain（metadata 文本字段同类型，故按部件头精确断言）。
      expect(
        body.contains('content-type: text/plain\r\n'
            'content-disposition: form-data; name="logs"; filename="app.log"'),
        isTrue,
      );
      expect(
        body.contains('content-type: text/plain\r\n'
            'content-disposition: form-data; name="logs"; '
            'filename="network.jsonl"'),
        isTrue,
      );
      // 无截图时不产生 screenshot 部件。
      expect(body.contains('filename="screenshot.png"'), isFalse);
      // 原始字节按 UTF-8 原样进入部件（不重新编码、不截断）。
      expect(body.contains('第一行\n第二行\n'), isTrue);
      api.dispose();
    });

    test('日志 + 截图：截图部件在前，日志按序在后', () async {
      final ApiClient api = buildApi();
      await api.submitFeedback(
        idempotencyKey: 'k-both',
        text: '截图与日志',
        screenshotBytes: Uint8List.fromList(<int>[1, 2, 3]),
        captureInfo: const FeedbackCaptureInfo(viewportWidth: 100),
        logs: <FeedbackLogAttachment>[
          FeedbackLogAttachment(
            name: 'a.log',
            source: FeedbackLogSource.auto,
            bytes: bytes('a\n'),
          ),
        ],
      );
      final http.Request request = captured.single;
      final String body = multipartBody(request);
      expect(body.indexOf('filename="screenshot.png"'),
          lessThan(partIndex(request, 'a.log')));
      final Map<String, Object?> metadata = multipartMetadata(request);
      expect(metadata['logs'], hasLength(1));
      expect(metadata['capture'], <String, Object?>{'viewportWidth': 100});
      api.dispose();
    });

    test('无日志无截图 → 逐字节保持原 JSON 路径（不含 logs 键）', () async {
      final ApiClient api = buildApi();
      await api.submitFeedback(idempotencyKey: 'k-json', text: '只有文字');
      final http.Request request = captured.single;
      expect(request.headers['content-type'], contains('application/json'));
      expect(
        request.body,
        jsonEncode(<String, Object?>{
          'idempotencyKey': 'k-json',
          'appId': 'com.example.app',
          'text': '只有文字',
          'context': <String, Object?>{'appVersion': '1.2.3'},
        }),
        reason: '无日志时请求体必须与原实现逐字节一致（旧客户端兼容）',
      );
      api.dispose();
    });

    test('空日志列表 → 仍走原 JSON 路径', () async {
      final ApiClient api = buildApi();
      await api.submitFeedback(
        idempotencyKey: 'k-empty',
        text: '只有文字',
        logs: const <FeedbackLogAttachment>[],
      );
      final http.Request request = captured.single;
      expect(request.headers['content-type'], contains('application/json'));
      expect(request.body.contains('logs'), isFalse);
      api.dispose();
    });
  });
}
