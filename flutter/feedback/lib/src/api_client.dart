import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data' show Uint8List;
import 'dart:ui' show Offset, Rect, Size;

import 'package:crypto/crypto.dart' as crypto;
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
///
/// 双形态契约：管理员账号为不限形态（[unlimited] = true，[dailyLimit] /
/// [remaining] 为 null，不受每日次数限制）；普通账号为数值形态。
class Quota {
  /// 构造额度。
  const Quota({
    this.unlimited = false,
    this.dailyLimit,
    required this.used,
    this.remaining,
    this.resetAt,
  });

  /// 是否不限次数（管理员账号）。
  final bool unlimited;

  /// 每日上限（仅数值形态有值）。
  final int? dailyLimit;

  /// 当日已用。
  final int used;

  /// 剩余次数（不为负；仅数值形态有值）。
  final int? remaining;

  /// 下次刷新时间（服务端生成）。
  final DateTime? resetAt;

  /// 从 JSON 宽松解析；缺失或无法识别时返回 null（调用方据此隐藏额度显示）。
  static Quota? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (raw['unlimited'] == true) {
      final Object? used = raw['used'];
      if (used is! num) return null;
      final Object? reset = raw['resetAt'];
      return Quota(
        unlimited: true,
        used: used.toInt(),
        resetAt: reset is String ? DateTime.tryParse(reset) : null,
      );
    }
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

/// 局部截图选区（T1）：0..1 归一化坐标，**相对原始捕获视口**
/// （[FeedbackCaptureInfo.viewportWidth]/[viewportHeight] 描述的边界尺寸）。
///
/// 约束：`0 ≤ x,y`、`width,height > 0`、`x + width ≤ 1`、`y + height ≤ 1`。
/// 「截取整个窗口」时 [FeedbackCaptureInfo.region] 省略（字段不下发）。
class FeedbackCaptureRegion {
  /// 构造归一化选区。
  const FeedbackCaptureRegion({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  /// 由视口逻辑坐标矩形派生归一化选区：**先按视口尺寸归一化**，再钳到
  /// 0..1（压制浮点误差），保证 `x + width ≤ 1`、`y + height ≤ 1`
  /// （少取不越界，不多取不溢出）。
  factory FeedbackCaptureRegion.fromRect(Rect rect, Size viewport) {
    final double vw = viewport.width <= 0 ? 1.0 : viewport.width;
    final double vh = viewport.height <= 0 ? 1.0 : viewport.height;
    double left = (rect.left / vw).clamp(0.0, 1.0);
    double top = (rect.top / vh).clamp(0.0, 1.0);
    double right = (rect.right / vw).clamp(left, 1.0);
    double bottom = (rect.bottom / vh).clamp(top, 1.0);
    double width = right - left;
    double height = bottom - top;
    // 退化（零宽/零高，或整块落在视口外）：给出至少 1 输出像素的正尺寸。
    if (width <= 0) width = math.min(1.0, 1.0 / vw);
    if (height <= 0) height = math.min(1.0, 1.0 / vh);
    if (left + width > 1.0) left = 1.0 - width;
    if (top + height > 1.0) top = 1.0 - height;
    width = math.min(width, 1.0 - left);
    height = math.min(height, 1.0 - top);
    return FeedbackCaptureRegion(
      x: left,
      y: top,
      width: width,
      height: height,
    );
  }

  /// 选区左边（0..1，相对原始捕获视口）。
  final double x;

  /// 选区上边（0..1）。
  final double y;

  /// 选区宽度（0..1，`x + width ≤ 1`）。
  final double width;

  /// 选区高度（0..1，`y + height ≤ 1`）。
  final double height;

  /// 序列化为 JSON Map（`capture.region`）。
  Map<String, Object?> toJson() => <String, Object?>{
        'x': x,
        'y': y,
        'width': width,
        'height': height,
      };
}

/// 截图捕获元数据。
///
/// [viewportWidth]/[viewportHeight] 为截图边界的**逻辑**视口尺寸；
/// [pixelWidth]/[pixelHeight] 为最终 PNG 的**输出像素**尺寸——整窗捕获时为
/// 整图输出像素，局部选区裁剪时为**选区裁剪后的最终输出像素**（受两端统一的
/// 最长边/总像素/字节限制缩放后，与逻辑尺寸不再相等）。
/// [region] 为局部选区（T1 新增）：相对**原始捕获视口**归一化，整窗捕获省略。
class FeedbackCaptureInfo {
  /// 构造截图元数据。
  const FeedbackCaptureInfo({
    this.viewportWidth,
    this.viewportHeight,
    this.pixelWidth,
    this.pixelHeight,
    this.capturedAt,
    this.releasePoint,
    this.region,
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

  /// 灵感球落点相对归一化坐标（0.0 ~ 1.0，始终相对**原始捕获视口**）。
  final Offset? releasePoint;

  /// 局部截图选区（T1：0..1 归一化，相对原始捕获视口；整窗捕获为 null）。
  final FeedbackCaptureRegion? region;

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
        // T1 新增：局部选区；整窗捕获省略（不下发该字段）。
        if (region != null) 'region': region!.toJson(),
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

/// 一张待上传的图片附件（v12：初始提交与回复共用的有序图片列表条目）。
///
/// [id] 为客户端生成的稳定 ID（同一次提交内唯一；编辑保存替换附件内容时
/// 可复用同一 id）；[source] 为 `capture`（自动截图）、`manual`（手动添加）
/// 或 `edited`（经编辑器保存）；[mime] 仅限 `image/png` / `image/jpeg` /
/// `image/webp`，服务端按魔数校验一致性。
class FeedbackImageFile {
  /// 构造图片附件。[sha256] 未提供时提交前由客户端计算。
  const FeedbackImageFile({
    required this.id,
    required this.filename,
    required this.bytes,
    required this.mime,
    this.source = 'manual',
    this.sha256,
  });

  /// 稳定 ID（1..64 字符，同次提交唯一）。
  final String id;

  /// 文件名（仅基名），扩展名 `.png` / `.jpg` / `.jpeg` / `.webp`。
  final String filename;

  /// 图片二进制内容。
  final Uint8List bytes;

  /// 声明格式（`image/png` / `image/jpeg` / `image/webp`）。
  final String mime;

  /// 来源：`capture` / `manual` / `edited`。
  final String source;

  /// 内容 SHA-256（64 位小写十六进制）；未提供时由客户端在提交时计算。
  final String? sha256;

  /// 字节大小。
  int get byteSize => bytes.length;

  /// 生成一个内容替换后的副本（编辑保存 / 重拍替换字节；默认复用 [id]）。
  FeedbackImageFile copyWith({
    String? id,
    String? filename,
    Uint8List? bytes,
    String? mime,
    String? source,
    String? sha256,
  }) {
    return FeedbackImageFile(
      id: id ?? this.id,
      filename: filename ?? this.filename,
      bytes: bytes ?? this.bytes,
      mime: mime ?? this.mime,
      source: source ?? this.source,
      sha256: sha256, // 内容变化后旧摘要一律作废。
    );
  }

  /// `metadata.images` 描述符。
  Map<String, Object?> toDescriptor(String sha256Hex) => <String, Object?>{
        'id': id,
        'source': source,
        'filename': filename,
        'sha256': sha256Hex,
        'mime': mime,
      };
}

/// 手动图片选择器（v12）。
///
/// 默认实现走 `file_selector`；宿主可通过 [FeedbackConfig.imagePicker]
/// 覆盖（如接入相册 / 拍照）。返回 `null` 或空列表表示用户取消。
typedef FeedbackImagePicker = FutureOr<List<FeedbackImageFile>?> Function();

/// 服务端能力探测结果（`GET /api/features` 或 session `capabilities`）。
///
/// [images] 为最大图片数；旧服务无此字段时为 `null` —— 组件保持**单图
/// 模式**并提示「升级服务端以支持多图」，不得静默丢弃其余图片。
class FeedbackCapabilities {
  /// 构造能力集。
  const FeedbackCapabilities({this.dialogue = false, this.images});

  /// 对话（我的反馈跟进）能力。
  final bool dialogue;

  /// 最大图片数（v12）；旧服务端缺失时为 null。
  final int? images;

  /// 从 JSON 宽松解析；无法识别时返回 null。
  static FeedbackCapabilities? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? images = raw['images'];
    return FeedbackCapabilities(
      dialogue: raw['dialogue'] == true,
      images: images is num ? images.toInt() : null,
    );
  }
}

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

/// 工单沟通状态。
enum IssueStatus {
  /// 新反馈。
  open,

  /// 待用户补充。
  waitingUser,

  /// 待管理处理。
  waitingAdmin,

  /// 已解决。
  resolved;

  /// 转为协议字段串。
  String toWire() {
    switch (this) {
      case IssueStatus.open:
        return 'open';
      case IssueStatus.waitingUser:
        return 'waiting_user';
      case IssueStatus.waitingAdmin:
        return 'waiting_admin';
      case IssueStatus.resolved:
        return 'resolved';
    }
  }

  /// 人类可读标签（v12 用户端统一文案：open→待处理、waiting_user→待补充、
  /// waiting_admin→待管理员回复、resolved→已解决）。
  String get label {
    switch (this) {
      case IssueStatus.open:
        return '待处理';
      case IssueStatus.waitingUser:
        return '待补充';
      case IssueStatus.waitingAdmin:
        return '待管理员回复';
      case IssueStatus.resolved:
        return '已解决';
    }
  }

  /// 从字符串解析。
  static IssueStatus fromWire(String? wire) {
    switch (wire) {
      case 'waiting_user':
        return IssueStatus.waitingUser;
      case 'waiting_admin':
        return IssueStatus.waitingAdmin;
      case 'resolved':
        return IssueStatus.resolved;
      case 'open':
      default:
        return IssueStatus.open;
    }
  }
}

/// 消息附件。
class FeedbackMessageAttachment {
  /// 构造消息附件。
  const FeedbackMessageAttachment({
    required this.id,
    required this.kind,
    required this.filename,
    required this.byteSize,
    required this.sha256,
    this.mime,
    this.width,
    this.height,
    required this.createdAt,
  });

  final String id;

  /// 附件类型：'screenshot' / 'log' / 'image'（v12）。
  final String kind;
  final String filename;
  final int byteSize;
  final String sha256;

  /// 图片附件的声明格式（kind == 'image' 时带值）。
  final String? mime;
  final int? width;
  final int? height;
  final DateTime createdAt;

  /// 是否按图片渲染（screenshot 与 v12 image 都走 Bearer 下载 + Image.memory）。
  bool get isImage => kind == 'image' || kind == 'screenshot';

  factory FeedbackMessageAttachment.fromJson(Map<String, Object?> json) =>
      FeedbackMessageAttachment(
        id: json['id'] as String? ?? '',
        kind: json['kind'] as String? ?? 'screenshot',
        filename: json['filename'] as String? ?? '',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
        sha256: json['sha256'] as String? ?? '',
        mime: json['mime'] as String?,
        width: (json['width'] as num?)?.toInt(),
        height: (json['height'] as num?)?.toInt(),
        createdAt: DateTime.tryParse(json['createdAt']?.toString() ?? '') ??
            DateTime.now(),
      );
}

/// 对话消息条目。
class FeedbackMessageItem {
  /// 构造对话消息。
  const FeedbackMessageItem({
    required this.id,
    required this.seq,
    required this.senderType,
    required this.senderId,
    required this.senderName,
    required this.text,
    required this.createdAt,
    this.attachments = const <FeedbackMessageAttachment>[],
    this.resolutionNote,
  });

  final String id;
  final int seq;
  final String senderType; // 'user' | 'admin' | 'system'
  final String senderId;
  final String senderName;
  final String text;
  final DateTime createdAt;
  final List<FeedbackMessageAttachment> attachments;

  /// 处理说明（v12）：管理员标记解决时必填，随该状态变更消息对用户可见。
  final String? resolutionNote;

  factory FeedbackMessageItem.fromJson(Map<String, Object?> json) {
    final List<Object?> rawAtts = (json['attachments'] as List<Object?>?) ?? <Object?>[];
    return FeedbackMessageItem(
      id: json['id'] as String? ?? '',
      seq: (json['seq'] as num?)?.toInt() ?? 0,
      senderType: json['senderType'] as String? ?? 'user',
      senderId: json['senderId'] as String? ?? '',
      senderName: json['senderName'] as String? ?? '',
      text: json['text'] as String? ?? '',
      createdAt: DateTime.tryParse(json['createdAt']?.toString() ?? '') ??
          DateTime.now(),
      attachments: rawAtts
          .whereType<Map<String, Object?>>()
          .map(FeedbackMessageAttachment.fromJson)
          .toList(),
      resolutionNote: json['resolutionNote'] as String?,
    );
  }
}

/// 用户历史反馈列表单条。
class UserFeedbackListItem {
  const UserFeedbackListItem({
    required this.id,
    required this.appId,
    this.title,
    required this.text,
    required this.status,
    required this.issueStatus,
    required this.dialogueVersion,
    required this.archiveRound,
    required this.lastActivityAt,
    required this.createdAt,
    required this.unread,
    required this.messageCount,
    this.latestMessageText,
    this.latestMessageSender,
  });

  final String id;
  final String appId;
  final String? title;
  final String text;
  final String status;
  final IssueStatus issueStatus;
  final int dialogueVersion;
  final int archiveRound;
  final DateTime lastActivityAt;
  final DateTime createdAt;
  final bool unread;
  final int messageCount;
  final String? latestMessageText;
  final String? latestMessageSender;

  factory UserFeedbackListItem.fromJson(Map<String, Object?> json) {
    final Map<String, Object?>? lm =
        json['latestMessage'] as Map<String, Object?>?;
    return UserFeedbackListItem(
      id: json['id'] as String? ?? '',
      appId: json['appId'] as String? ?? '',
      title: json['title'] as String?,
      text: json['text'] as String? ?? '',
      status: json['status'] as String? ?? 'received',
      issueStatus: IssueStatus.fromWire(json['issueStatus'] as String?),
      dialogueVersion: (json['dialogueVersion'] as num?)?.toInt() ?? 1,
      archiveRound: (json['archiveRound'] as num?)?.toInt() ?? 1,
      lastActivityAt:
          DateTime.tryParse(json['lastActivityAt']?.toString() ?? '') ??
              DateTime.now(),
      createdAt: DateTime.tryParse(json['createdAt']?.toString() ?? '') ??
          DateTime.now(),
      unread: json['unread'] == true,
      messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
      latestMessageText: lm?['text'] as String?,
      latestMessageSender: lm?['senderType'] as String?,
    );
  }
}

/// 用户历史反馈分页结果。
class UserFeedbackListResponse {
  const UserFeedbackListResponse({
    required this.items,
    required this.total,
    required this.page,
    required this.limit,
    required this.unreadTotal,
  });

  final List<UserFeedbackListItem> items;
  final int total;
  final int page;
  final int limit;
  final int unreadTotal;

  factory UserFeedbackListResponse.fromJson(Map<String, Object?> json) {
    final List<Object?> rawItems = (json['items'] as List<Object?>?) ?? <Object?>[];
    return UserFeedbackListResponse(
      items: rawItems
          .whereType<Map<String, Object?>>()
          .map(UserFeedbackListItem.fromJson)
          .toList(),
      total: (json['total'] as num?)?.toInt() ?? 0,
      page: (json['page'] as num?)?.toInt() ?? 1,
      limit: (json['limit'] as num?)?.toInt() ?? 20,
      unreadTotal: (json['unreadTotal'] as num?)?.toInt() ?? 0,
    );
  }
}

/// 未读消息摘要。
class UnreadSummaryResponse {
  const UnreadSummaryResponse({
    required this.unreadFeedbacksCount,
    required this.totalUnreadMessages,
  });

  final int unreadFeedbacksCount;
  final int totalUnreadMessages;

  factory UnreadSummaryResponse.fromJson(Map<String, Object?> json) =>
      UnreadSummaryResponse(
        unreadFeedbacksCount:
            (json['unreadFeedbacksCount'] as num?)?.toInt() ?? 0,
        totalUnreadMessages:
            (json['totalUnreadMessages'] as num?)?.toInt() ?? 0,
      );
}

/// 某条反馈的完整对话。
class FeedbackDialogueResponse {
  const FeedbackDialogueResponse({
    required this.feedbackId,
    required this.appId,
    this.title,
    required this.text,
    required this.status,
    required this.issueStatus,
    required this.dialogueVersion,
    required this.archiveRound,
    required this.mgmtState,
    required this.createdAt,
    required this.updatedAt,
    required this.lastActivityAt,
    this.screenshot,
    this.images = const <FeedbackImageView>[],
    this.logs = const <FeedbackLogAttachmentView>[],
    required this.messages,
    required this.lastReadSeq,
    this.resolutionNote,
  });

  final String feedbackId;
  final String appId;
  final String? title;
  final String text;
  final String status;
  final IssueStatus issueStatus;
  final int dialogueVersion;
  final int archiveRound;
  final String mgmtState;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime lastActivityAt;
  final FeedbackScreenshotView? screenshot;

  /// v12：初始反馈的有序图片列表（历史单图记录经兼容读取进入同一列表）。
  final List<FeedbackImageView> images;
  final List<FeedbackLogAttachmentView> logs;
  final List<FeedbackMessageItem> messages;
  final int lastReadSeq;

  /// 处理说明（v12）：feedback 级别字段，标记已解决时必填并对用户可见。
  final String? resolutionNote;

  factory FeedbackDialogueResponse.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> fb =
        (json['feedback'] as Map<String, Object?>?) ?? <String, Object?>{};
    final List<Object?> rawMsgs =
        (json['messages'] as List<Object?>?) ?? <Object?>[];
    final List<Object?> rawLogs = (fb['logs'] as List<Object?>?) ?? <Object?>[];
    return FeedbackDialogueResponse(
      feedbackId: fb['id'] as String? ?? '',
      appId: fb['appId'] as String? ?? '',
      title: fb['title'] as String?,
      text: fb['text'] as String? ?? '',
      status: fb['status'] as String? ?? 'received',
      issueStatus: IssueStatus.fromWire(fb['issueStatus'] as String?),
      dialogueVersion: (fb['dialogueVersion'] as num?)?.toInt() ?? 1,
      archiveRound: (fb['archiveRound'] as num?)?.toInt() ?? 1,
      mgmtState: fb['mgmtState'] as String? ?? 'inbox',
      createdAt: DateTime.tryParse(fb['createdAt']?.toString() ?? '') ??
          DateTime.now(),
      updatedAt: DateTime.tryParse(fb['updatedAt']?.toString() ?? '') ??
          DateTime.now(),
      lastActivityAt:
          DateTime.tryParse(fb['lastActivityAt']?.toString() ?? '') ??
              DateTime.now(),
      screenshot: fb['screenshot'] is Map<String, Object?>
          ? FeedbackScreenshotView.fromJson(
              fb['screenshot'] as Map<String, Object?>)
          : null,
      images: ((fb['images'] as List<Object?>?) ?? const <Object?>[])
          .whereType<Map<String, Object?>>()
          .map(FeedbackImageView.fromJson)
          .toList(),
      logs: rawLogs
          .whereType<Map<String, Object?>>()
          .map(FeedbackLogAttachmentView.fromJson)
          .toList(),
      messages: rawMsgs
          .whereType<Map<String, Object?>>()
          .map(FeedbackMessageItem.fromJson)
          .toList(),
      lastReadSeq: (json['lastReadSeq'] as num?)?.toInt() ?? 0,
      resolutionNote: fb['resolutionNote'] as String?,
    );
  }
}

/// 初始反馈的有序图片元数据（v12 `feedback.images` 条目）。
class FeedbackImageView {
  /// 构造图片元数据。
  const FeedbackImageView({
    required this.id,
    required this.sort,
    required this.source,
    required this.mime,
    required this.filename,
    required this.byteSize,
    required this.sha256,
    this.width,
    this.height,
    this.createdAt,
  });

  /// 图片稳定 ID（下载路径参数）。
  final String id;

  /// 有序序号（保序）。
  final int sort;

  /// 来源：capture / manual / edited。
  final String source;

  /// 声明格式（image/png | image/jpeg | image/webp）。
  final String mime;
  final String filename;
  final int byteSize;
  final String sha256;
  final int? width;
  final int? height;
  final DateTime? createdAt;

  /// 从 JSON 宽松解析。
  factory FeedbackImageView.fromJson(Map<String, Object?> json) =>
      FeedbackImageView(
        id: json['id'] as String? ?? '',
        sort: (json['sort'] as num?)?.toInt() ?? 0,
        source: json['source'] as String? ?? 'manual',
        mime: json['mime'] as String? ?? 'image/png',
        filename: json['filename'] as String? ?? '',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
        sha256: json['sha256'] as String? ?? '',
        width: (json['width'] as num?)?.toInt(),
        height: (json['height'] as num?)?.toInt(),
        createdAt:
            DateTime.tryParse(json['createdAt']?.toString() ?? ''),
      );
}

/// 截图查看数据结构。
class FeedbackScreenshotView {
  const FeedbackScreenshotView({
    required this.width,
    required this.height,
    required this.byteSize,
  });

  final int width;
  final int height;
  final int byteSize;

  factory FeedbackScreenshotView.fromJson(Map<String, Object?> json) =>
      FeedbackScreenshotView(
        width: (json['width'] as num?)?.toInt() ?? 0,
        height: (json['height'] as num?)?.toInt() ?? 0,
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
      );
}

/// 日志附件查看数据结构。
class FeedbackLogAttachmentView {
  const FeedbackLogAttachmentView({
    required this.id,
    required this.filename,
    required this.byteSize,
    required this.source,
  });

  final String id;
  final String filename;
  final int byteSize;
  final String source;

  factory FeedbackLogAttachmentView.fromJson(Map<String, Object?> json) =>
      FeedbackLogAttachmentView(
        id: json['id'] as String? ?? '',
        filename: json['filename'] as String? ?? '',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
        source: json['source'] as String? ?? 'manual',
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
  const SessionInfo({this.user, this.quota, this.capabilities});

  /// 当前账号。
  final AuthUser? user;

  /// 当前额度。
  final Quota? quota;

  /// 服务端能力（v12：`{dialogue, images}`）；旧服务端缺省为 null。
  final FeedbackCapabilities? capabilities;

  /// 从 JSON 宽松解析。
  factory SessionInfo.fromJson(Map<String, Object?> json) => SessionInfo(
        user: AuthUser.fromJson(json['user']),
        quota: Quota.fromJson(json['quota']),
        capabilities: FeedbackCapabilities.fromJson(json['capabilities']),
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
      // v12：统一规范大小写（HTTP 头部大小写不敏感，两端保持一致写法）。
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }

  /// multipart 请求统一附加 Bearer（v12：大小写统一为规范 `Authorization`；
  /// 空令牌不携带头部，匿名提交保持可行）。
  void _attachAuth(http.MultipartRequest req, String? token) {
    if (token != null && token.isNotEmpty) {
      req.headers['Authorization'] = 'Bearer $token';
    }
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
    List<FeedbackImageFile>? images,
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
    final bool hasImages = images != null && images.isNotEmpty;
    try {
      if (screenshotBytes != null || hasImages || hasLogs) {
        final http.MultipartRequest req =
            http.MultipartRequest('POST', _uri('/api/feedback'));
        _attachAuth(req, lease.token);
        req.headers['accept'] = 'application/json';

        // v12：images 与 screenshot 互斥——调用方保证不混传；
        // metadata.images 描述符与 images 部件按顺序一一对应。
        final List<String> imageDigests = <String>[
          if (hasImages)
            for (final FeedbackImageFile img in images)
              img.sha256 ??
                  crypto.sha256.convert(img.bytes).toString(),
        ];
        final Map<String, Object?> metadata = <String, Object?>{
          'idempotencyKey': idempotencyKey,
          'appId': config.appId,
          // 可选上报软件名称：服务端只在管理员尚未设置名称时采用。
          if (config.appName != null) 'appName': config.appName,
          'text': text,
          if (context.isNotEmpty) 'context': context,
          if (captureInfo != null) 'capture': captureInfo.toJson(),
          if (hasImages)
            'images': <Map<String, Object?>>[
              for (int i = 0; i < images.length; i++)
                images[i].toDescriptor(imageDigests[i]),
            ],
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
        if (hasImages) {
          for (final FeedbackImageFile img in images) {
            req.files.add(
              http.MultipartFile.fromBytes(
                'images',
                img.bytes,
                filename: img.filename,
                contentType: http.MediaType.parse(img.mime),
              ),
            );
          }
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

  /// 查询未读消息摘要：`GET /api/feedback/unread-summary`。
  Future<UnreadSummaryResponse> fetchUnreadSummary({String? appId}) async {
    final TokenLease lease = await _tokens.lease();
    final Map<String, String> q = <String, String>{};
    if (appId != null && appId.isNotEmpty) q['appId'] = appId;
    final Uri uri = _uri('/api/feedback/unread-summary').replace(
      queryParameters: q.isEmpty ? null : q,
    );
    final http.Response response = await _client
        .get(uri, headers: _headers(token: lease.token))
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return UnreadSummaryResponse.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 查询用户历史反馈：`GET /api/feedback/mine`。
  Future<UserFeedbackListResponse> fetchMyFeedbacks({
    int? page,
    int? limit,
    String? appId,
    String? issueStatus,
  }) async {
    final TokenLease lease = await _tokens.lease();
    final Map<String, String> q = <String, String>{};
    if (page != null) q['page'] = page.toString();
    if (limit != null) q['limit'] = limit.toString();
    if (appId != null && appId.isNotEmpty) q['appId'] = appId;
    if (issueStatus != null && issueStatus.isNotEmpty) {
      q['issueStatus'] = issueStatus;
    }
    final Uri uri = _uri('/api/feedback/mine').replace(
      queryParameters: q.isEmpty ? null : q,
    );
    final http.Response response = await _client
        .get(uri, headers: _headers(token: lease.token))
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return UserFeedbackListResponse.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 查询特定反馈的完整对话：`GET /api/feedback/:id/dialogue`。
  Future<FeedbackDialogueResponse> fetchFeedbackDialogue(
      String feedbackId) async {
    final TokenLease lease = await _tokens.lease();
    final http.Response response = await _client
        .get(
          _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}/dialogue'),
          headers: _headers(token: lease.token),
        )
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return FeedbackDialogueResponse.fromJson(_decode(response));
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 上报已读：`POST /api/feedback/:id/read`。
  Future<void> markFeedbackRead(String feedbackId, int lastReadSeq) async {
    final TokenLease lease = await _tokens.lease();
    final http.Response response = await _client
        .post(
          _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}/read'),
          headers: _headers(token: lease.token),
          body: jsonEncode(<String, Object?>{'lastReadSeq': lastReadSeq}),
        )
        .timeout(_requestTimeout);
    if (response.statusCode == 200) return;
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 发送回复：`POST /api/feedback/:id/messages`。
  ///
  /// v12：携带 [images]（≤5 张）时走 `metadata`（JSON：`{text,
  /// idempotencyKey?, images}`）+ `images` 部件的 multipart 变体；旧
  /// `screenshot`/`logs` 字段继续接受（与 `images` 互斥）。
  Future<FeedbackMessageItem> sendFeedbackReply(
    String feedbackId, {
    required String text,
    Uint8List? screenshotBytes,
    List<FeedbackImageFile>? images,
    List<FeedbackLogFile>? logs,
    String? idempotencyKey,
  }) async {
    final TokenLease lease = await _tokens.lease();
    final bool hasImages = images != null && images.isNotEmpty;
    final bool hasAttachments =
        screenshotBytes != null || hasImages || (logs != null && logs.isNotEmpty);
    final http.Response response;

    if (hasAttachments) {
      final http.MultipartRequest req = http.MultipartRequest(
        'POST',
        _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}/messages'),
      );
      _attachAuth(req, lease.token);
      if (hasImages) {
        // v12 多图变体：metadata JSON + images 部件。
        final Map<String, Object?> metadata = <String, Object?>{
          'text': text,
          if (idempotencyKey != null && idempotencyKey.isNotEmpty)
            'idempotencyKey': idempotencyKey,
          'images': <Map<String, Object?>>[
            for (final FeedbackImageFile img in images)
              img.toDescriptor(
                  img.sha256 ?? crypto.sha256.convert(img.bytes).toString()),
          ],
        };
        req.fields['metadata'] = jsonEncode(metadata);
      } else {
        req.fields['text'] = text;
        if (idempotencyKey != null && idempotencyKey.isNotEmpty) {
          req.fields['idempotencyKey'] = idempotencyKey;
        }
      }
      if (screenshotBytes != null) {
        req.files.add(
          http.MultipartFile.fromBytes(
            'screenshot',
            screenshotBytes,
            filename: 'screenshot.png',
          ),
        );
      }
      if (hasImages) {
        for (final FeedbackImageFile img in images) {
          req.files.add(
            http.MultipartFile.fromBytes(
              'images',
              img.bytes,
              filename: img.filename,
              contentType: http.MediaType.parse(img.mime),
            ),
          );
        }
      }
      if (logs != null) {
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
            _uri('/api/feedback/${Uri.encodeComponent(feedbackId)}/messages'),
            headers: _headers(token: lease.token),
            body: jsonEncode(<String, Object?>{
              'text': text,
              if (idempotencyKey != null && idempotencyKey.isNotEmpty)
                'idempotencyKey': idempotencyKey,
            }),
          )
          .timeout(_requestTimeout);
    }

    if (response.statusCode == 201 || response.statusCode == 200) {
      final Map<String, Object?> body = _decode(response);
      final Map<String, Object?>? msg =
          body['message'] as Map<String, Object?>?;
      if (msg != null) {
        return FeedbackMessageItem.fromJson(msg);
      }
      return FeedbackMessageItem(
        id: '',
        seq: 0,
        senderType: 'user',
        senderId: '',
        senderName: '',
        text: text,
        createdAt: DateTime.now(),
      );
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 带 Bearer 的二进制下载（v12 附件统一取图要求）：附件 URL 不携带凭据，
  /// 组件一律主动 `Authorization` 取回字节后由调用方渲染
  /// （Flutter `Image.memory`），绝不把 URL 直接交给 `Image.network`。
  Future<Uint8List> _fetchBytes(String path) async {
    final TokenLease lease = await _tokens.lease();
    final http.Response response = await _client
        .get(_uri(path), headers: _headers(token: lease.token))
        .timeout(_requestTimeout);
    if (response.statusCode == 200) {
      return response.bodyBytes;
    }
    if (response.statusCode == 401) {
      await _handleUnauthorized(lease);
    }
    _throwApiError(response);
  }

  /// 下载消息附件字节：`GET /api/feedback/messages/attachments/:id`。
  Future<Uint8List> fetchMessageAttachment(String attachmentId) =>
      _fetchBytes(
          '/api/feedback/messages/attachments/${Uri.encodeComponent(attachmentId)}');

  /// 下载初始反馈某张图片字节：`GET /api/feedback/:id/images/:imageId`（v12）。
  Future<Uint8List> fetchFeedbackImage(String feedbackId, String imageId) =>
      _fetchBytes(
          '/api/feedback/${Uri.encodeComponent(feedbackId)}/images/${Uri.encodeComponent(imageId)}');

  /// 下载本人反馈的日志附件：`GET /api/feedback/:id/logs/:logId/download`（v12）。
  Future<Uint8List> fetchFeedbackLog(String feedbackId, String logId) =>
      _fetchBytes(
          '/api/feedback/${Uri.encodeComponent(feedbackId)}/logs/${Uri.encodeComponent(logId)}/download');

  /// 兼容单图下载：`GET /api/feedback/:id/screenshot`（旧记录/旧服务）。
  Future<Uint8List> fetchFeedbackScreenshot(String feedbackId) => _fetchBytes(
      '/api/feedback/${Uri.encodeComponent(feedbackId)}/screenshot');

  /// 能力探测：`GET /api/features`（无需登录）。
  ///
  /// 网络异常 / 非 2xx / 旧服务无此端点均返回 null——调用方按
  /// `capabilities.images` 缺失处理（保持单图模式并提示升级）。
  Future<FeedbackCapabilities?> fetchCapabilities() async {
    try {
      final http.Response response = await _client
          .get(_uri('/api/features'), headers: _headers(withAuth: false))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        return FeedbackCapabilities.fromJson(_decode(response));
      }
    } catch (_) {
      // 探测失败按旧服务处理（单图模式 + 升级提示）。
    }
    return null;
  }
}
