import 'dart:convert';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/foundation.dart';

/// 宿主自带的**内存环形缓冲**日志系统（示例）。
///
/// 演示真实宿主如何把自己已有的日志接到反馈组件：
/// 1. 宿主照常在自己的代码里写日志（[info] / [warn] / [error]）；
/// 2. 把 [export] 交给 `FeedbackConfig.logProvider`；
/// 3. 组件在**新草稿首次打开面板**时调用一次，3 秒超时；
/// 4. 宿主在交付前自行脱敏（见 [redacted]）——契约 §0 明确要求宿主负责
///    在把日志交给组件之前去除凭据等敏感内容。
///
/// 缓冲只保留最近 [capacity] 行，超出后丢弃最旧的行（真实系统的常见做法，
/// 也避免一次导出过大被组件按 1 MiB 上限整批拒绝）。
class HostLogBuffer extends ChangeNotifier {
  /// 创建环形缓冲。[capacity] 为最多保留的行数。
  HostLogBuffer({this.capacity = 200});

  /// 最多保留的日志行数。
  final int capacity;

  final List<String> _lines = <String>[];

  /// 当前缓冲的行数。
  int get length => _lines.length;

  /// 当前缓冲内容（只读快照）。
  List<String> get lines => List<String>.unmodifiable(_lines);

  /// 追加一行 INFO 日志。
  void info(String message) => add('INFO', message);

  /// 追加一行 WARN 日志。
  void warn(String message) => add('WARN', message);

  /// 追加一行 ERROR 日志。
  void error(String message) => add('ERROR', message);

  /// 追加一行日志；超出 [capacity] 时丢弃最旧的行。
  void add(String level, String message) {
    _lines.add('${_timestamp()} [$level] $message');
    while (_lines.length > capacity) {
      _lines.removeAt(0);
    }
    notifyListeners();
  }

  /// 清空缓冲（演示用：便于重新观察一次「新草稿自动采集」）。
  void clear() {
    _lines.clear();
    notifyListeners();
  }

  /// 导出为反馈组件可用的日志文件。
  ///
  /// 永远返回**至少一行**（含说明头），避免空文件被组件按「内容非空」拒绝；
  /// 字节是严格 UTF-8 的纯文本，扩展名落在契约白名单内（`.log`）。
  Future<List<FeedbackLogFile>> export() async {
    final String text = redacted();
    return <FeedbackLogFile>[
      FeedbackLogFile(
        name: 'host-app.log',
        bytes: Uint8List.fromList(utf8.encode(text)),
      ),
    ];
  }

  /// 交付给组件前的宿主侧脱敏：把疑似凭据的值替换为 `***`。
  ///
  /// 这里只演示最朴素的一条规则；真实宿主应按自己的日志格式与合规要求处理
  /// （组件不会替宿主猜测哪些内容是敏感的）。
  String redacted() {
    final StringBuffer buffer = StringBuffer();
    buffer.writeln('# feedback_widget 示例宿主日志（内存环形缓冲，最多 $capacity 行）');
    if (_lines.isEmpty) {
      buffer.writeln('${_timestamp()} [INFO] （缓冲为空：尚未产生运行日志）');
    } else {
      for (final String line in _lines) {
        buffer.writeln(_redactSensitive(line));
      }
    }
    return buffer.toString();
  }

  static final RegExp _sensitive = RegExp(
    r'(password|passwd|token|secret|authorization|api[-_]?key)\s*[=:]\s*\S+',
    caseSensitive: false,
  );

  static String _redactSensitive(String line) =>
      line.replaceAllMapped(_sensitive, (Match m) => '${m.group(1)}=***');

  String _timestamp() => '[${DateTime.now().toIso8601String()}]';
}

/// 示例应用使用的宿主日志缓冲：全局单例，任何页面都能写。
final HostLogBuffer hostLogs = HostLogBuffer();
