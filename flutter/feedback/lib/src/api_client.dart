import 'dart:async';
import 'dart:convert';
import 'dart:typed_data' show Uint8List;
import 'dart:ui' show Offset;

import 'package:http/http.dart' as http;

import 'config.dart';
import 'token_coordination.dart';
import 'token_store.dart';

/// 服务返回的 API 错误（契约统一错误体 `{error:{code,message}}`）。
class ApiException implements Exception {
  /// 构造异常。
  const ApiException({
    required this.statusCode,
    this.code,
    this.message,
    this.quota,
  });

  /// HTTP 状态码。
  final int statusCode;

  /// 契约中的 machine code（如 `invalid_credentials`）。
  final String? code;

  /// 可安全展示的人类可读消息。
  final String? message;

  /// 错误体携带的额度（`daily_quota_exceeded` 429 会返回同结构额度）。
  final Quota? quota;

  @override
  String toString() =>
      'ApiException($statusCode, code: $code, message: $message)';
}

/// 已登录账号的最小信息（服务端不返回密码或哈希）。
class AuthUser {
  /// 构造账号信息。
  const AuthUser({required this.id, required this.username, required this.role});

  /// 账号 id。
  final String id;

  /// 用户名。
  final String username;

  /// 角色（admin / user）。
  final String role;

  /// 从 JSON 宽松解析；缺失时返回 null。
  static AuthUser? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? id = raw['id'];
    final Object? username = raw['username'];
    if (id is! String || username is! String) return null;
    return AuthUser(
      id: id,
      username: username,
      role: raw['role']?.toString() ?? 'user',
    );
  }
}

/// 每日提交额度（服务端按北京时间日切分）。
class Quota {
  /// 构造额度。
  const Quota({
    required this.dailyLimit,
    required this.used,
    required this.remaining,
    this.resetAt,
  });

  /// 每日上限。
  final int dailyLimit;

  /// 当日已用。
  final int used;

  /// 剩余次数（不为负）。
  final int remaining;

  /// 下次刷新时间（服务端生成）。
  final DateTime? resetAt;

  /// 从 JSON 宽松解析；缺失时返回 null。
  static Quota? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? limit = raw['dailyLimit'];
    final Object? used = raw['used'];
    final Object? remaining = raw['remaining'];
    if (limit is! num || used is! num || remaining is! num) return null;
    final Object? reset = raw['resetAt'];
    return Quota(
      dailyLimit: limit.toInt(),
      used: used.toInt(),
      remaining: remaining.toInt(),
      resetAt: reset is String ? DateTime.tryParse(reset) : null,
    );
  }
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

/// 反馈附带的日志文件（契约 docs/api.md v1）。
class FeedbackLogFile {
  /// 构造日志文件。
  const FeedbackLogFile({
    required this.filename,
    required this.bytes,
    this.source = 'auto',
    this.sha256,
  });

  /// 文件名（如 `app.log`、`console.json`）。
  final String filename;

  /// 二进制内容（UTF-8 文本）。
  final Uint8List bytes;

  /// 采集来源：'auto'（自动采集）或 'manual'（手动附加）。
  final String source;

  /// 可选的客户端 SHA-256 摘要；若未提供则由服务端计算。
  final String? sha256;

  /// 字节大小。
  int get byteSize => bytes.length;

  /// 纯文本内容（UTF-8 解析，用于预览）。
  String get text => utf8.decode(bytes, allowMalformed: true);
}

/// 自动日志提供者。
typedef FeedbackLogProvider = FutureOr<List<FeedbackLogFile>?> Function();

/// 手动日志文件选择器。
typedef FeedbackFilePicker = FutureOr<List<FeedbackLogFile>?> Function();

/// 组件侧「已保存、等待什么」状态（T4；旧服务端不返回该字段，缺省即可忽略）。
///
/// 等待态**不是失败**：组件应提示已保存，并停止无意义的轮询。
enum FeedbackCollectionState {
  /// 软件尚未被管理员配置（首次提交自动发现的软件）。
  waitingConfiguration,

  /// 自动归档软件出现了新来源，等待管理员确认。
  waitingSourceConfirmation,

  /// 已配置但为人工归档模式，等待管理员逐条归档。
  waitingManualArchive,

  /// 已获得归档授权、正在归档流程中。
  queued,
}

/// 解析服务端返回的 collectionState；未知或缺失返回 null（按旧行为处理）。
FeedbackCollectionState? parseCollectionState(Object? raw) {
  switch (raw) {
    case 'waiting_configuration':
      return FeedbackCollectionState.waitingConfiguration;
    case 'waiting_source_confirmation':
      return FeedbackCollectionState.waitingSourceConfirmation;
    case 'waiting_manual_archive':
      return FeedbackCollectionState.waitingManualArchive;
    case 'queued':
      return FeedbackCollectionState.queued;
    default:
      return null;
  }
}

/// 等待态的用户提示；[FeedbackCollectionState.queued] 与 null 返回 null（按“整理中”展示）。
String? collectionWaitingText(FeedbackCollectionState? state) {
  switch (state) {
    case FeedbackCollectionState.waitingConfiguration:
      return '反馈已保存，等待管理员配置该软件。';
    case FeedbackCollectionState.waitingSourceConfirmation:
      return '反馈已保存，等待管理员确认来源。';
    case FeedbackCollectionState.waitingManualArchive:
      return '反馈已保存，等待管理员归档。';
    case FeedbackCollectionState.queued:
    case null:
      return null;
  }
}

/// `POST /api/feedback` 的解析结果。
class FeedbackSubmitResult {
  /// 构造结果。
  const FeedbackSubmitResult({
    required this.feedbackId,
    required this.status,
    this.replayed = false,
    this.quota,
    this.user,
    this.collectionState,
  });

  /// 反馈记录 id。
  final String feedbackId;

  /// 初始状态（契约：`received`）。
  final String status;

  /// 是否为幂等重放（同 key 同内容，`200 replayed:true`）。
  final bool replayed;

  /// 提交后的最新额度（若服务端返回）。
  final Quota? quota;

  /// 提交账号（若服务端返回）。
  final AuthUser? user;

  /// 当前收集状态（等待配置 / 等待确认来源 / 等待人工归档 / 已排队）。
  final FeedbackCollectionState? collectionState;

  /// 从 JSON 解析（宽松）。
  factory FeedbackSubmitResult.fromJson(Map<String, Object?> json) =>
      FeedbackSubmitResult(
        feedbackId: json['feedbackId'] as String? ?? '',
        status: json['status'] as String? ?? 'received',
        replayed: json['replayed'] == true,
        quota: Quota.fromJson(json['quota']),
        user: AuthUser.fromJson(json['user']),
        collectionState: parseCollectionState(json['collectionState']),
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
    this.collectionState,
  });

  /// 反馈记录 id。
  final String id;

  /// 状态机当前状态（received/processing/archiving/needs_review/archived/failed）。
  final String status;

  /// 失败摘要（若有）。
  final String? errorSummary;

  /// 归档后的 Kaneo 链接（若有）。
  final String? kaneoUrl;

  /// 当前收集状态（等待配置 / 等待确认来源 / 等待人工归档 / 已排队）。
  final FeedbackCollectionState? collectionState;

  /// 从 JSON 解析（宽松）。
  factory FeedbackRecord.fromJson(Map<String, Object?> json) => FeedbackRecord(
        id: json['id'] as String? ?? '',
        status: json['status'] as String? ?? 'received',
        errorSummary: json['errorSummary'] as String?,
        kaneoUrl: json['kaneoUrl'] as String?,
        collectionState: parseCollectionState(json['collectionState']),
      );
}

/// `POST /api/auth/login`（携带 clientLabel + appId）的解析结果。
class LoginResult {
  /// 构造结果。
  const LoginResult({required this.token, this.expiresAt, this.user, this.quota});

  /// 可撤销 Bearer 令牌（仅此一次明文返回）。
  final String token;

  /// 过期时间（若有）。
  final DateTime? expiresAt;

  /// 登录账号（若服务端返回）。
  final AuthUser? user;

  /// 登录后的额度（若服务端返回）。
  final Quota? quota;
}

/// `GET /api/auth/session` 的解析结果（用于刷新额度）。
class SessionInfo {
  /// 构造结果。
  const SessionInfo({this.user, this.quota});

  /// 当前账号。
  final AuthUser? user;

  /// 当前额度。
  final Quota? quota;

  /// 从 JSON 宽松解析。
  factory SessionInfo.fromJson(Map<String, Object?> json) => SessionInfo(
        user: AuthUser.fromJson(json['user']),
        quota: Quota.fromJson(json['quota']),
      );
}

/// 401 回调：调用方应清除令牌并回到登录视图。
typedef FeedbackUnauthorizedCallback = void Function();

/// Feedback 服务 HTTP 客户端。
///
/// [httpClient] 可注入以便测试；[tokenStore] 提供 Bearer 令牌来源。
/// 认证接口收到 401 时按「请求发出时捕获的令牌与认证世代」做条件清除
/// （T1-A）：仅当该请求仍属于当前认证世代才清除令牌并触发
/// [onUnauthorized]；期间已发生新登录的过期请求只向原调用者抛错，
/// 绝不退出当前登录。
///
/// 注意：本类绝不明文输出密码或令牌（不写日志）。
class ApiClient {
  /// 构造客户端。
  ApiClient({
    required this.config,
    required this.tokenStore,
    http.Client? httpClient,
    this.onUnauthorized,
  })  : _tokens = CoordinatedTokenStore.of(tokenStore),
        _client = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  /// 连接与上报配置。
  final FeedbackConfig config;

  /// 令牌仓库。
  final FeedbackTokenStore tokenStore;

  /// 401 处理回调（认证类接口之外）。
  FeedbackUnauthorizedCallback? onUnauthorized;

  /// 令牌协调器：与面板的登录写入共享同一操作队列与认证世代。
  final CoordinatedTokenStore _tokens;

  final http.Client _client;
  final bool _ownsClient;

  static const Duration _requestTimeout = Duration(seconds: 20);

  Uri _uri(String path) => Uri.parse('${config.apiBase}$path');

  /// 释放底层 HTTP 资源（仅当自行创建时）。
  void dispose() {
    if (_ownsClient) _client.close();
  }

  Map<String, String> _headers({bool withAuth = true, String? token}) {
    final Map<String, String> headers = <String, String>{
      'content-type': 'application/json',
      'accept': 'application/json',
    };
    if (withAuth && token != null && token.isNotEmpty) {
      headers['authorization'] = 'Bearer $token';
    }
    return headers;
  }

  /// 统一 401 入口（T1-A）：仅当请求仍属于当前认证世代且令牌未被更换时
  /// 清除对应令牌并通知界面；过期请求不进入此路径，继续向原调用者抛错。
  Future<void> _handleUnauthorized(TokenLease lease) async {
    if (!await _tokens.clearIfCurrent(lease)) return;
    onUnauthorized?.call();
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
      quota: Quota.fromJson(body['quota']),
    );
  }

  /// 登录：`POST /api/auth/login`，显式携带 [clientLabel] 与 [appId]。
  /// Web / 原生共用同一表单路径；401 表示凭据错误，不触发 [onUnauthorized]。
  Future<LoginResult> login({
    required String username,
    required String password,
    required String clientLabel,
    required String appId,
  }) async {
    final http.Response response = await _client
        .post(
          _uri('/api/auth/login'),
          headers: _headers(withAuth: false),
          body: jsonEncode(<String, Object?>{
            'username': username,
            'password': password,
            'clientLabel': clientLabel,
            'appId': appId,
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
      user: AuthUser.fromJson(body['user']),
      quota: Quota.fromJson(body['quota']),
    );
  }

  /// 查询会话（用于刷新额度 / 校验令牌）：`GET /api/auth/session`。
  /// 401 按认证世代条件清除令牌并触发 [onUnauthorized]。
  Future<SessionInfo> fetchSession() async {
    final TokenLease lease = await _tokens.lease(); // 请求发出前捕获令牌与世代
    final http.Response response = await _client
        .get(
          _uri('/api/auth/session'),
          headers: _headers(token: lease.token),
        )
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return SessionInfo.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
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
    List<FeedbackLogFile>? logs,
  }) async {
    final Map<String, Object?> context = <String, Object?>{};
    final String? appVersion = config.appVersion;
    if (appVersion != null) context['appVersion'] = appVersion;
    final String? pageLabel = config.pageLabel;
    if (pageLabel != null) context['pageLabel'] = pageLabel;

    final http.Response response;
    final TokenLease lease = await _tokens.lease(); // 请求发出前捕获令牌与世代
    final bool hasLogs = logs != null && logs.isNotEmpty;
    try {
      if (screenshotBytes != null || hasLogs) {
        final http.MultipartRequest req =
            http.MultipartRequest('POST', _uri('/api/feedback'));
        final String? token = lease.token;
        if (token != null && token.isNotEmpty) {
          req.headers['authorization'] = 'Bearer $token';
        }
        req.headers['accept'] = 'application/json';

        final Map<String, Object?> metadata = <String, Object?>{
          'idempotencyKey': idempotencyKey,
          'appId': config.appId,
          // 可选上报软件名称：服务端只在管理员尚未设置名称时采用。
          if (config.appName != null) 'appName': config.appName,
          'text': text,
          if (context.isNotEmpty) 'context': context,
          if (captureInfo != null) 'capture': captureInfo.toJson(),
          if (hasLogs)
            'logs': logs
                .map((FeedbackLogFile l) => <String, Object?>{
                      'filename': l.filename,
                      'source': l.source,
                      if (l.sha256 != null && l.sha256!.isNotEmpty)
                        'sha256': l.sha256,
                    })
                .toList(),
        };
        req.fields['metadata'] = jsonEncode(metadata);
        if (screenshotBytes != null) {
          req.files.add(
            http.MultipartFile.fromBytes(
              'screenshot',
              screenshotBytes,
              filename: 'screenshot.png',
            ),
          );
        }
        if (hasLogs) {
          for (final FeedbackLogFile log in logs) {
            req.files.add(
              http.MultipartFile.fromBytes(
                'logs',
                log.bytes,
                filename: log.filename,
              ),
            );
          }
        }
        final http.StreamedResponse streamed =
            await _client.send(req).timeout(_requestTimeout);
        response = await http.Response.fromStream(streamed);
      } else {
        response = await _client
            .post(
              _uri('/api/feedback'),
              headers: _headers(token: lease.token),
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
      await _handleUnauthorized(lease);
      _throwApiError(response);
    }
    _throwApiError(response);
  }

  /// 探测服务连通性：`GET /healthz`（不带令牌，不触发 401 清理）。
  ///
  /// 用于设置视图保存自定义服务器后的连通性提示：返回 true 表示拿到
  /// 2xx 响应；非 2xx / 超时 / 网络异常均返回 false（绝不抛出）。
  Future<bool> probeHealth() async {
    try {
      final http.Response response = await _client
          .get(
            _uri('/healthz'),
            headers: _headers(withAuth: false),
          )
          .timeout(const Duration(seconds: 5));
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// 查询反馈状态：`GET /api/feedback/:id`。
  Future<FeedbackRecord> fetchFeedback(String feedbackId) async {
    final TokenLease lease = await _tokens.lease(); // 请求发出前捕获令牌与世代
    final http.Response response = await _client
        .get(
          _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}'),
          headers: _headers(token: lease.token),
        )
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return FeedbackRecord.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }
}
