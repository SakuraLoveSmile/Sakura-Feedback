import 'dart:convert';
import 'dart:typed_data' show Uint8List;
import 'dart:ui' show Offset;

import 'package:http/http.dart' as http;

import 'config.dart';
import 'token_store.dart';

/// 服务返回的 API 错误（契约统一错误体 `{error:{code,message}}`）。
class ApiException implements Exception {
  /// 构造异常。
  const ApiException({
    required this.statusCode,
    this.code,
    this.message,
  });

  /// HTTP 状态码。
  final int statusCode;

  /// 契约中的 machine code（如 `invalid_credentials`）。
  final String? code;

  /// 可安全展示的人类可读消息。
  final String? message;

  @override
  String toString() =>
      'ApiException($statusCode, code: $code, message: $message)';
}

/// 截图捕获元数据。
///
/// [viewportWidth]/[viewportHeight] 为截图边界的**逻辑**视口尺寸；
/// [pixelWidth]/[pixelHeight] 为最终 PNG 的**输出像素**尺寸（受两端统一的
/// 最长边/总像素/字节限制缩放后，与逻辑尺寸不再相等）。
class FeedbackCaptureInfo {
  /// 构造截图元数据。
  const FeedbackCaptureInfo({
    this.viewportWidth,
    this.viewportHeight,
    this.pixelWidth,
    this.pixelHeight,
    this.capturedAt,
    this.releasePoint,
  });

  /// 视口宽度（逻辑像素）。
  final int? viewportWidth;

  /// 视口高度（逻辑像素）。
  final int? viewportHeight;

  /// 输出图片宽度（实际像素）。
  final int? pixelWidth;

  /// 输出图片高度（实际像素）。
  final int? pixelHeight;

  /// 捕获时间（ISO-8601）。
  final String? capturedAt;

  /// 灵感球落点相对归一化坐标（0.0 ~ 1.0）。
  final Offset? releasePoint;

  /// 序列化为 JSON Map。
  Map<String, Object?> toJson() => <String, Object?>{
        if (viewportWidth != null) 'viewportWidth': viewportWidth,
        if (viewportHeight != null) 'viewportHeight': viewportHeight,
        if (pixelWidth != null) 'pixelWidth': pixelWidth,
        if (pixelHeight != null) 'pixelHeight': pixelHeight,
        if (capturedAt != null) 'capturedAt': capturedAt,
        if (releasePoint != null)
          'releasePoint': <String, Object?>{
            'x': releasePoint!.dx,
            'y': releasePoint!.dy,
          },
      };
}

/// `POST /api/feedback` 的解析结果。
class FeedbackSubmitResult {
  /// 构造结果。
  const FeedbackSubmitResult({
    required this.feedbackId,
    required this.status,
    this.replayed = false,
  });

  /// 反馈记录 id。
  final String feedbackId;

  /// 初始状态（契约：`received`）。
  final String status;

  /// 是否为幂等重放（同 key 同内容，`200 replayed:true`）。
  final bool replayed;

  /// 从 JSON 解析（宽松）。
  factory FeedbackSubmitResult.fromJson(Map<String, Object?> json) =>
      FeedbackSubmitResult(
        feedbackId: json['feedbackId'] as String? ?? '',
        status: json['status'] as String? ?? 'received',
        replayed: json['replayed'] == true,
      );
}

/// `GET /api/feedback/:id` 的解析结果。
class FeedbackRecord {
  /// 构造记录。
  const FeedbackRecord({
    required this.id,
    required this.status,
    this.errorSummary,
    this.kaneoUrl,
  });

  /// 反馈记录 id。
  final String id;

  /// 状态机当前状态（received/processing/archiving/needs_review/archived/failed）。
  final String status;

  /// 失败摘要（若有）。
  final String? errorSummary;

  /// 归档后的 Kaneo 链接（若有）。
  final String? kaneoUrl;

  /// 从 JSON 解析（宽松）。
  factory FeedbackRecord.fromJson(Map<String, Object?> json) => FeedbackRecord(
        id: json['id'] as String? ?? '',
        status: json['status'] as String? ?? 'received',
        errorSummary: json['errorSummary'] as String?,
        kaneoUrl: json['kaneoUrl'] as String?,
      );
}

/// `POST /api/auth/login`（携带 clientLabel）的解析结果。
class LoginResult {
  /// 构造结果。
  const LoginResult({required this.token, this.expiresAt});

  /// 长期可撤销 Bearer 令牌（仅此一次明文返回）。
  final String token;

  /// 过期时间（若有）。
  final DateTime? expiresAt;
}

/// 401 回调：调用方应清除令牌并回到登录视图。
typedef FeedbackUnauthorizedCallback = void Function();

/// Feedback 服务 HTTP 客户端。
///
/// [httpClient] 可注入以便测试；[tokenStore] 提供 Bearer 令牌来源；
/// 认证接口收到 401 时清除令牌并触发 [onUnauthorized]。
///
/// 注意：本类绝不明文输出密码或令牌（不写日志）。
class ApiClient {
  /// 构造客户端。
  ApiClient({
    required this.config,
    required this.tokenStore,
    http.Client? httpClient,
    this.onUnauthorized,
  })  : _client = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  /// 连接与上报配置。
  final FeedbackConfig config;

  /// 令牌仓库。
  final FeedbackTokenStore tokenStore;

  /// 401 处理回调（认证类接口之外）。
  FeedbackUnauthorizedCallback? onUnauthorized;

  final http.Client _client;
  final bool _ownsClient;

  static const Duration _requestTimeout = Duration(seconds: 20);

  Uri _uri(String path) => Uri.parse('${config.apiBase}$path');

  /// 释放底层 HTTP 资源（仅当自行创建时）。
  void dispose() {
    if (_ownsClient) _client.close();
  }

  Future<Map<String, String>> _headers({bool withAuth = true}) async {
    final Map<String, String> headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
    };
    if (withAuth) {
      final String? token = await tokenStore.read();
      if (token != null && token.isNotEmpty) {
        headers['authorization'] = 'Bearer $token';
      }
    }
    return headers;
  }

  static Map<String, Object?> _decode(http.Response response) {
    try {
      final Object? body = jsonDecode(utf8.decode(response.bodyBytes));
      if (body is Map<String, Object?>) return body;
      if (body is Map) {
        return body
            .map((Object? k, Object? v) => MapEntry<String, Object?>('$k', v));
      }
    } on FormatException {
      // 非 JSON 响应：按空对象处理。
    }
    return const <String, Object?>{};
  }

  Never _throwApiError(http.Response response) {
    final Map<String, Object?> body = _decode(response);
    final Object? error = body['error'];
    String? code;
    String? message;
    if (error is Map) {
      code = error['code']?.toString();
      message = error['message']?.toString();
    }
    throw ApiException(
      statusCode: response.statusCode,
      code: code,
      message: message,
    );
  }

  /// 登录（原生端）：`POST /api/auth/login`，携带 [clientLabel]
  /// 换取长期可撤销令牌。401 表示凭据错误，不触发 [onUnauthorized]。
  Future<LoginResult> login({
    required String username,
    required String password,
    required String clientLabel,
  }) async {
    final http.Response response = await _client
        .post(
          _uri('/api/auth/login'),
          headers: await _headers(withAuth: false),
          body: jsonEncode(<String, Object?>{
            'username': username,
            'password': password,
            'clientLabel': clientLabel,
          }),
        )
        .timeout(_requestTimeout);
    if (response.statusCode != 200) _throwApiError(response);
    final Map<String, Object?> body = _decode(response);
    final Object? token = body['token'];
    if (token is! String || token.isEmpty) {
      // 服务端未返回令牌（可能未按 clientLabel 模式部署）。
      throw const ApiException(
        statusCode: 200,
        code: 'no_token',
        message: '服务未返回令牌',
      );
    }
    final Object? rawExpiry = body['expiresAt'];
    return LoginResult(
      token: token,
      expiresAt: rawExpiry is String ? DateTime.tryParse(rawExpiry) : null,
    );
  }

  /// 提交反馈：`POST /api/feedback`。
  ///
  /// context 仅携带显式配置的值（[FeedbackConfig.appVersion] /
  /// [FeedbackConfig.pageLabel]），绝不自动抓取。
  Future<FeedbackSubmitResult> submitFeedback({
    required String idempotencyKey,
    required String text,
    FeedbackCaptureInfo? captureInfo,
    Uint8List? screenshotBytes,
  }) async {
    final Map<String, Object?> context = <String, Object?>{};
    final String? appVersion = config.appVersion;
    if (appVersion != null) context['appVersion'] = appVersion;
    final String? pageLabel = config.pageLabel;
    if (pageLabel != null) context['pageLabel'] = pageLabel;

    final http.Response response;
    try {
      if (screenshotBytes != null) {
        final http.MultipartRequest req =
            http.MultipartRequest('POST', _uri('/api/feedback'));
        final String? token = await tokenStore.read();
        if (token != null && token.isNotEmpty) {
          req.headers['authorization'] = 'Bearer $token';
        }
        req.headers['accept'] = 'application/json';

        final Map<String, Object?> metadata = <String, Object?>{
          'idempotencyKey': idempotencyKey,
          'appId': config.appId,
          'text': text,
          if (context.isNotEmpty) 'context': context,
          if (captureInfo != null) 'capture': captureInfo.toJson(),
        };
        req.fields['metadata'] = jsonEncode(metadata);
        req.files.add(
          http.MultipartFile.fromBytes(
            'screenshot',
            screenshotBytes,
            filename: 'screenshot.png',
          ),
        );
        final http.StreamedResponse streamed =
            await _client.send(req).timeout(_requestTimeout);
        response = await http.Response.fromStream(streamed);
      } else {
        response = await _client
            .post(
              _uri('/api/feedback'),
              headers: await _headers(),
              body: jsonEncode(<String, Object?>{
                'idempotencyKey': idempotencyKey,
                'appId': config.appId,
                'text': text,
                if (context.isNotEmpty) 'context': context,
                if (captureInfo != null) 'capture': captureInfo.toJson(),
              }),
            )
            .timeout(_requestTimeout);
      }
    } on ApiException {
      rethrow;
    }
    if (response.statusCode == 201 || response.statusCode == 200) {
      final Map<String, Object?> body = _decode(response);
      final String feedbackId = body['feedbackId'] as String? ?? '';
      if (feedbackId.isEmpty) {
        throw const ApiException(
          statusCode: 500,
          code: 'invalid_response',
          message: '响应缺少 feedbackId',
        );
      }
      return FeedbackSubmitResult.fromJson(body);
    }
    if (response.statusCode == 401) {
      await tokenStore.clear();
      onUnauthorized?.call();
      _throwApiError(response);
    }
    _throwApiError(response);
  }

  /// 查询反馈状态：`GET /api/feedback/:id`。
  Future<FeedbackRecord> fetchFeedback(String feedbackId) async {
    final http.Response response = await _client
        .get(
          _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}'),
          headers: await _headers(),
        )
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return FeedbackRecord.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await tokenStore.clear();
      onUnauthorized?.call();
    }
    _throwApiError(response);
  }
}
