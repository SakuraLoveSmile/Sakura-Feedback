// 日志附件：契约（docs/logs-plan.md §1.1 / §4）在客户端的落点。
//
// 全部规则集中在此文件，自动采集与手动添加**共用**同一套校验：
// 数量 ≤ 3、单文件 ≤ 1 MiB、扩展名白名单、非空、严格 UTF-8（无替换字符、无 NUL）。
// 任何违规都返回明确的用户可读说明并**整批拒绝**，绝不静默删除或截断文件。
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';

import 'config.dart';

/// 单份反馈最多附加的日志文件数（契约 `MAX_LOGS`）。
const int kFeedbackMaxLogs = 3;

/// 单份日志文件的最大字节数（契约 `MAX_LOG_BYTES` = 1 MiB）。
const int kFeedbackMaxLogBytes = 1024 * 1024;

/// 允许的日志扩展名（小写、不含点；判定时大小写不敏感）。
const List<String> kFeedbackLogExtensions = <String>['log', 'txt', 'json', 'jsonl'];

/// 预览展示的最大码点数。
///
/// 仅影响**预览**（避免 1 MiB 文本拖垮渲染），提交字节始终是原始文件内容，
/// 超出时预览界面会明确标注。
const int kFeedbackLogPreviewMaxRunes = 20000;

/// 日志附件来源（契约 `source`）。
enum FeedbackLogSource {
  /// 面板首次打开时由 `logProvider` 自动采集。
  auto('auto'),

  /// 用户通过文件选择器手动添加。
  manual('manual');

  const FeedbackLogSource(this.wireValue);

  /// 提交线格式中的取值（`"auto"` / `"manual"`）。
  final String wireValue;

  /// 面板展示用的中文来源标签。
  String get label => this == FeedbackLogSource.auto ? '自动' : '手动';
}

/// 一份已通过校验、随反馈提交的日志附件。
class FeedbackLogAttachment {
  /// 构造附件。
  const FeedbackLogAttachment({
    required this.name,
    required this.source,
    required this.bytes,
  });

  /// 文件名（与 `logs` 部件的 filename 一致）。
  final String name;

  /// 来源（自动 / 手动）。
  final FeedbackLogSource source;

  /// 原始字节。
  final Uint8List bytes;

  /// 字节数（`metadata.logs[].byteSize`，必须与实际字节数一致）。
  int get byteSize => bytes.length;

  /// `metadata.logs` 中的单项。
  Map<String, Object?> toMetadataJson() => <String, Object?>{
        'name': name,
        'source': source.wireValue,
        'byteSize': bytes.length,
      };
}

/// 手动添加日志的文件选择器（可注入，主要面向测试）。
typedef FeedbackLogFilePicker = Future<List<FeedbackLogFile>> Function();

/// 去掉开头的 UTF-8 BOM（EF BB BF）。
Uint8List _stripUtf8Bom(Uint8List bytes) {
  if (bytes.length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) {
    return Uint8List.sublistView(bytes, 3);
  }
  return bytes;
}

/// 校验一份日志文件；合法返回 `null`，否则返回用户可读的错误说明。
///
/// 规则（契约 §1.1）：
/// - 文件名 1..255 字符、不含路径分隔符；
/// - 扩展名 ∈ `.log` / `.txt` / `.json` / `.jsonl`（大小写不敏感）；
/// - 非空、≤ 1 MiB；
/// - 严格 UTF-8 可解码（`allowMalformed: false`），且不含 NUL 字节。
String? validateFeedbackLogFile(String name, Uint8List bytes) {
  final String trimmed = name.trim();
  if (trimmed.isEmpty || trimmed.length > 255) {
    return '日志文件名长度需在 1–255 字符之间：$name';
  }
  if (trimmed.contains('/') || trimmed.contains('\\')) {
    return '日志文件名不能包含路径分隔符：$name';
  }
  final String lower = trimmed.toLowerCase();
  if (!kFeedbackLogExtensions.any((String ext) => lower.endsWith('.$ext'))) {
    return '日志文件名必须是 .log/.txt/.json/.jsonl：$name';
  }
  if (bytes.isEmpty) {
    return '日志文件不能为空：$trimmed';
  }
  if (bytes.length > kFeedbackMaxLogBytes) {
    final String mib = (bytes.length / 1024 / 1024).toStringAsFixed(2);
    return '日志文件超过 1MiB 上限（$trimmed：$mib MiB）';
  }
  final Uint8List body = _stripUtf8Bom(bytes);
  if (body.isEmpty) {
    return '日志文件为空或仅含 BOM：$trimmed';
  }
  final String text;
  try {
    text = utf8.decode(body, allowMalformed: false);
  } on FormatException {
    return '日志不是有效 UTF-8 文本：$trimmed';
  }
  if (text.isEmpty) {
    return '日志文件为空：$trimmed';
  }
  if (text.contains('\u0000')) {
    return '日志不是有效 UTF-8 文本（包含 NUL 字符）：$trimmed';
  }
  return null;
}

/// 把日志字节解码为可展示的纯文本（BOM 已去除；已通过严格校验）。
String feedbackLogPreviewText(Uint8List bytes) =>
    utf8.decode(_stripUtf8Bom(bytes), allowMalformed: true);

/// 用 `file_selector` 选择日志文件，并按**字节**读取（`XFile.readAsBytes()`）。
///
/// 使用 `XTypeGroup` 做扩展名过滤，Web 与原生端走同一条读取路径，
/// 不走文本解码，避免平台默认编码把字节改坏。
Future<List<FeedbackLogFile>> pickFeedbackLogFiles() async {
  const XTypeGroup group = XTypeGroup(
    label: '日志文件',
    extensions: kFeedbackLogExtensions,
  );
  final List<XFile> files =
      await openFiles(acceptedTypeGroups: <XTypeGroup>[group]);
  final List<FeedbackLogFile> picked = <FeedbackLogFile>[];
  for (final XFile file in files) {
    picked.add(FeedbackLogFile(name: file.name, bytes: await file.readAsBytes()));
  }
  return picked;
}
