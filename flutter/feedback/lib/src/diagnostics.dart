import 'dart:async';
import 'dart:convert' show jsonEncode, utf8;
import 'dart:typed_data' show Uint8List;
import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/foundation.dart'
    show FlutterError, FlutterErrorDetails, FlutterExceptionHandler;
import 'package:http/http.dart' as http;

import 'api_client.dart' show FeedbackLogFile;

/// 内存诊断记录器（v12）：供宿主把「自己的 API 请求 / 异常」汇聚成
/// `logProvider` 可直接产出的日志附件（`feedback-diagnostics.jsonl`）。
///
/// 白名单字段（其余一律拒绝写入）：`time`（记录器生成的 ISO-8601）、
/// `level`（info/warn/error）、`event`（自定义事件名，1..64 字符标识符）、
/// `code`（服务端错误码）、`status`（HTTP 状态码 100..599）、
/// `durationMs`（耗时毫秒）、`pageLabel`（宿主显式提供的页面标识）。
///
/// **绝不记录**请求正文、凭据、完整 URL、异常文本——API 签名只接受
/// 白名单标量，从类型上就无法传入自由文本。
///
/// 容量：至多 200 条 / UTF-8 总字节 ≤256KiB / 单条 ≤1KiB，超限丢最旧。
/// 世代（generation）：[clear] 递增；[record] 携带的 `generation` 与当前
/// 不一致时整条丢弃（账号 / 服务切换后旧会话的迟到写入不污染新会话）。
///
/// 诊断自身故障绝不影响业务：所有公开方法内部 try/catch 兜底，不抛异常。
class FeedbackDiagnosticsRecorder {
  /// 构造记录器（[filename] 为导出附件名）。
  FeedbackDiagnosticsRecorder({this.filename = 'feedback-diagnostics.jsonl'});

  /// 导出的日志附件文件名（仅基名）。
  final String filename;

  static const int _maxEntries = 200;
  static const int _maxTotalBytes = 256 * 1024;
  static const int _maxEntryBytes = 1024;

  static const Set<String> _levels = <String>{'info', 'warn', 'error'};
  static final RegExp _eventName = RegExp(r'^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$');

  final List<String> _lines = <String>[];
  int _totalBytes = 0;
  int _generation = 0;

  /// 当前世代（[clear] 后递增；调用方在切换前捕获、切换后拒绝旧值）。
  int get generation => _generation;

  /// 当前缓冲条数（测试可见）。
  int get length => _lines.length;

  bool _isValidStatus(int status) => status >= 100 && status <= 599;

  /// 写入一条白名单事件；任何字段非法则整条拒绝。永不抛异常。
  void record({
    String level = 'info',
    required String event,
    String? code,
    int? status,
    int? durationMs,
    String? pageLabel,
    int? generation,
  }) {
    try {
      if (generation != null && generation != _generation) return;
      if (!_levels.contains(level)) return;
      if (!_eventName.hasMatch(event)) return;
      if (code != null && (code.isEmpty || code.length > 64)) return;
      if (status != null && !_isValidStatus(status)) return;
      if (durationMs != null && (durationMs < 0 || durationMs > 86400000)) {
        return;
      }
      if (pageLabel != null && pageLabel.length > 200) return;

      final Map<String, Object?> entry = <String, Object?>{
        'time': DateTime.now().toUtc().toIso8601String(),
        'level': level,
        'event': event,
        if (code != null) 'code': code,
        if (status != null) 'status': status,
        if (durationMs != null) 'durationMs': durationMs,
        if (pageLabel != null) 'pageLabel': pageLabel,
      };
      final String line = jsonEncode(entry);
      final int bytes = utf8.encode(line).length + 1; // +1：JSONL 换行
      if (bytes > _maxEntryBytes) return;

      _lines.add(line);
      _totalBytes += bytes;
      while (_lines.length > _maxEntries || _totalBytes > _maxTotalBytes) {
        final String dropped = _lines.removeAt(0);
        _totalBytes -= utf8.encode(dropped).length + 1;
      }
    } catch (_) {
      // 诊断自身故障不得影响业务请求。
    }
  }

  /// 清空缓冲并递增世代（账号 / 服务身份切换时调用）。
  void clear() {
    try {
      _lines.clear();
      _totalBytes = 0;
      _generation++;
    } catch (_) {
      // 同上：绝不抛出。
    }
  }

  /// 导出缓冲为 logProvider 附件：无事件返回空列表；有事件返回单个
  /// `<filename>`（UTF-8 JSONL，每行一条 JSON）。永不抛异常。
  List<FeedbackLogFile> provide() {
    try {
      if (_lines.isEmpty) return <FeedbackLogFile>[];
      final String text = '${_lines.join('\n')}\n';
      return <FeedbackLogFile>[
        FeedbackLogFile(
          filename: filename,
          bytes: Uint8List.fromList(utf8.encode(text)),
          source: 'auto',
        ),
      ];
    } catch (_) {
      return <FeedbackLogFile>[];
    }
  }
}

/// `http.Client` 包装器（v12）：把每次请求的方法+路径白名单摘要、状态码与
/// 耗时写入 [recorder]，**不记录**请求体、凭据与完整 URL
/// （只记 `host + path` 之外的归一化路径段——为防 URL 携带敏感参数，
/// 实际只记录 path 部分）。
///
/// 不修改任何请求 / 响应；网络异常先按 `event:'http'`、`code:'network'`
/// 记录后**原样 rethrow**，宿主错误处理行为完全保留。
class FeedbackHttpClient extends http.BaseClient {
  /// 包装 [inner]（缺省 `http.Client()`），事件写入 [recorder]。
  FeedbackHttpClient(http.Client inner, this.recorder, {String? pageLabel})
      : _inner = inner,
        _pageLabel = pageLabel;

  final http.Client _inner;
  final FeedbackDiagnosticsRecorder recorder;
  final String? _pageLabel;

  /// 归一化路径：只保留 `/api/...` 的静态路径段，去掉可能的 id 段细节。
  static String _eventNameFor(http.BaseRequest request) {
    String path = request.url.path;
    if (path.length > 64) path = path.substring(0, 64);
    return 'http.${request.method.toLowerCase()}${_sanitizePath(path)}';
  }

  static String _sanitizePath(String path) {
    // 路径段转白名单形态：斜线与非字母数字一律替换为 '_'——事件名是
    // 纯标识符（不含 URL 结构，也不泄露 id/参数细节）。
    return path.replaceAll(RegExp(r'[^a-zA-Z0-9]'), '_');
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final int gen = recorder.generation;
    final Stopwatch sw = Stopwatch()..start();
    try {
      final http.StreamedResponse response = await _inner.send(request);
      recorder.record(
        event: _eventNameFor(request),
        status: response.statusCode,
        durationMs: sw.elapsedMilliseconds,
        pageLabel: _pageLabel,
        generation: gen,
        level: response.statusCode >= 400 ? 'warn' : 'info',
      );
      return response;
    } catch (e) {
      recorder.record(
        level: 'error',
        event: _eventNameFor(request),
        code: 'network',
        durationMs: sw.elapsedMilliseconds,
        pageLabel: _pageLabel,
        generation: gen,
      );
      rethrow;
    }
  }

  @override
  void close() {
    _inner.close();
    super.close();
  }
}

/// 显式启用的异常捕获适配（v12）：把 `FlutterError.onError` 与
/// `PlatformDispatcher.instance.onError` 的调用记录为诊断事件
/// （只记事件本身，不记异常文本），随后**原样转发给宿主原处理函数**——
/// 绝不吞掉、不替换宿主行为。
///
/// [uninstall] 恢复原处理链；重复调用幂等。
class FeedbackExceptionCapture {
  FeedbackExceptionCapture._(this._recorder);

  final FeedbackDiagnosticsRecorder _recorder;

  FlutterExceptionHandler? _previousFlutterError;
  bool Function(Object, StackTrace)? _previousPlatformError;
  bool _installed = false;

  /// 当前是否已安装（测试可见）。
  bool get installed => _installed;

  /// 安装捕获（重复调用只保留第一次安装的原处理链）。
  static FeedbackExceptionCapture install(
    FeedbackDiagnosticsRecorder recorder,
  ) {
    final FeedbackExceptionCapture capture = FeedbackExceptionCapture._(recorder);
    capture._install();
    return capture;
  }

  void _install() {
    if (_installed) return;
    _installed = true;
    _previousFlutterError = FlutterError.onError;
    FlutterError.onError = _flutterHandler;
    _previousPlatformError = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = _platformHandler;
  }

  /// 恢复原处理链（幂等）；若期间宿主又换过处理函数则不覆盖宿主的新值。
  void uninstall() {
    if (!_installed) return;
    _installed = false;
    if (identical(FlutterError.onError, _flutterHandler)) {
      FlutterError.onError = _previousFlutterError;
    }
    if (identical(PlatformDispatcher.instance.onError, _platformHandler)) {
      PlatformDispatcher.instance.onError = _previousPlatformError;
    }
    _previousFlutterError = null;
    _previousPlatformError = null;
  }

  // 稳定引用供 uninstall 做「仍指向我们」判断。
  void _flutterHandler(FlutterErrorDetails details) {
    _recorder.record(level: 'error', event: 'flutter_error');
    final FlutterExceptionHandler? previous = _previousFlutterError;
    if (previous != null) {
      previous(details);
    } else {
      FlutterError.presentError(details);
    }
  }

  bool _platformHandler(Object error, StackTrace stack) {
    _recorder.record(level: 'error', event: 'platform_error');
    final bool Function(Object, StackTrace)? previous = _previousPlatformError;
    if (previous != null) return previous(error, stack);
    return false;
  }
}
