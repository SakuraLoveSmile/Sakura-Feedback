import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

/// 可编程 mock 服务：按 `METHOD path` 匹配响应脚本，并记录全部请求。
class PanelServer {
  /// 全部收到的请求（按时间顺序）。
  final List<http.Request> requests = <http.Request>[];

  final Map<String, List<Future<http.Response> Function(http.Request)>>
      _handlers = <String, List<Future<http.Response> Function(http.Request)>>{};

  /// MockClient（注入 [FeedbackPanel.httpClient]）。
  http.Client get client => MockClient((request) async {
        requests.add(request);
        final key =
            '${request.method} ${Uri.parse(request.url.toString()).path}';
        final queue = _handlers[key];
        if (queue == null || queue.isEmpty) {
          return jsonResponse({
            'error': {'code': 'not_found', 'message': 'mock 未编排: $key'}
          }, 404);
        }
        final handler = queue.length > 1 ? queue.removeAt(0) : queue.first;
        return handler(request);
      });

  /// 追加一个处理器；同 key 多个响应按注册顺序弹出，最后一个常驻。
  void on(String key, Future<http.Response> Function(http.Request) handler) {
    (_handlers[key] ??= <Future<http.Response> Function(http.Request)>[])
        .add(handler);
  }

  /// 编排一个固定响应。
  void respond(String key, Object body, [int status = 200]) {
    on(key, (request) async => jsonResponse(body, status));
  }

  /// 命中指定 `METHOD path` 的请求数。
  int count(String methodPath) => requests
      .where((r) => '${r.method} ${Uri.parse(r.url.toString()).path}' == methodPath)
      .length;

  /// 最近一次命中指定 `METHOD path` 的请求。
  http.Request lastMatching(String methodPath) => requests.lastWhere(
      (r) => '${r.method} ${Uri.parse(r.url.toString()).path}' == methodPath);
}

/// 记录写入 / 清除次数的令牌仓库：验证「失效的登录不调用令牌写入」。
class RecordingTokenStore implements FeedbackTokenStore {
  /// 创建一个记录型仓库。
  RecordingTokenStore([this._token]);

  String? _token;

  /// `write` 调用次数。
  int writes = 0;

  /// `clear` 调用次数。
  int clears = 0;

  /// 当前令牌值。
  String? get value => _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async {
    writes++;
    _token = token;
  }

  @override
  Future<void> clear() async {
    clears++;
    _token = null;
  }
}

/// 写入必然失败的令牌仓库：模拟平台安全存储不可用
/// （如 macOS 无签名身份时 Keychain 返回 -34018 errSecMissingEntitlement）。
class FailingWriteTokenStore implements FeedbackTokenStore {
  /// 创建一个写入失败的仓库（读取/清除正常，便于驱动登录前置流程）。
  FailingWriteTokenStore([this._token]);

  String? _token;

  /// `write` 被调用次数（失败也算）。
  int writeAttempts = 0;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async {
    writeAttempts++;
    throw PlatformException(
      code: 'ss_write_failed',
      message: 'A required entitlement is not present. (-34018)',
    );
  }

  @override
  Future<void> clear() async {
    _token = null;
  }
}

/// 账号信息 JSON。
Map<String, Object?> userJson() =>
    <String, Object?>{'id': 'u1', 'username': 'admin', 'role': 'user'};

/// 额度 JSON。
Map<String, Object?> quotaJson({
  int dailyLimit = 3,
  int used = 0,
  int remaining = 3,
  String resetAt = '2030-01-01T16:00:00Z',
}) =>
    <String, Object?>{
      'dailyLimit': dailyLimit,
      'used': used,
      'remaining': remaining,
      'resetAt': resetAt,
    };

/// 会话响应体。
Map<String, Object?> sessionJson(Map<String, Object?> quota) =>
    <String, Object?>{
      'authenticated': true,
      'kind': 'client',
      'user': userJson(),
      'quota': quota,
    };

/// 挂载独立的 [FeedbackPanel]（直接构造，不经过宿主组件）。
///
/// [visible] 为面板的真实开关状态（内部协作接口）；null 表示未接入
/// （与旧测试完全兼容）。重复调用会更新同一棵面板子树。
Future<void> pumpPanel(
  WidgetTester tester, {
  required PanelServer server,
  required FeedbackTokenStore tokenStore,
  FeedbackConfig? config,
  bool? visible,
  Size surface = const Size(1000, 800),
}) async {
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    home: FeedbackPanel(
      config: config ??
          FeedbackConfig('https://svc.test', 'com.example.app',
              appVersion: '9.9.9', pageLabel: 'home'),
      tokenStore: tokenStore,
      httpClient: server.client,
      visible: visible,
    ),
  ));
  await tester.pump();
}

/// 结束测试时卸载面板，避免悬挂轮询 / 额度 Timer。
Future<void> teardownPanel(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(seconds: 40));
}
