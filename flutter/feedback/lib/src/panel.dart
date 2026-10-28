import 'dart:async';
import 'dart:convert' show jsonEncode, utf8;
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart' as fs;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';
import 'config.dart';
import 'idempotency.dart';
import 'image_editor.dart';
import 'images.dart';
import 'platform.dart';
import 'server_pref.dart';
import 'token_coordination.dart';
import 'token_store.dart';

/// 反馈正文最大长度（按 Unicode 码点 / runes 计，与契约 1..10000 一致）。
const int kFeedbackMaxTextRunes = 10000;

/// 组件统一动效时长（冻结视觉规格：160–220ms）。
const Duration kFeedbackMotion = Duration(milliseconds: 180);

/// 日志附件最大数量。
const int kFeedbackMaxLogFiles = 3;

/// 单个日志附件最大字节数（1 MiB）。
const int kFeedbackMaxLogBytes = 1024 * 1024;

/// 允许的日志附件扩展名。
const Set<String> kFeedbackAllowedLogExtensions = <String>{
  '.log',
  '.txt',
  '.json',
  '.jsonl',
};

String _getLogExtension(String filename) {
  final int dot = filename.lastIndexOf('.');
  if (dot == -1) return '';
  return filename.substring(dot).toLowerCase();
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// 面板导航标签。
enum _PanelTab {
  compose,
  history,
}

/// 面板主视图阶段。
enum FeedbackStage {
  /// 撰写反馈。
  compose,

  /// 提交未送达：服务端从未收到请求（网络异常 / 超时，未拿到任何 HTTP 响应）。
  ///
  /// 与 [failed] 的区别是**服务端没有该记录**：重试必须复用同一幂等键与同一
  /// 字节（冻结快照未变时），不会产生重复工单。
  notSent,

  /// 已提交待回执 / 服务端处理中（已接收）。
  accepted,

  /// 服务端处理中（processing/archiving）。
  processing,

  /// 已归档（终态）。
  archived,

  /// 服务端记录为失败（failed/needs_review）。
  ///
  /// 服务端**已接收**该反馈（保留 feedbackId）：此状态只允许刷新状态 /
  /// 复制反馈 ID / 返回编辑开新反馈，绝不重新 POST。
  failed,

  /// 幂等冲突：该反馈已提交。
  replay,
}

/// 结果未知（[FeedbackStage.notSent]）提交冻结的完整快照：
/// 正文 + 图片列表（v12，含自动截图）+ 截图元数据 + 日志列表。
///
/// 复用同一幂等键的前提是快照**完全一致**（服务契约要求同 key 必须同字节，
/// 同 key 不同内容会被判为 409 冲突）。因此改文案、重拍（新截图字节）、移除
/// 或编辑图片、修改日志都属于新快照，必须换新 key 重新提交。
class _FrozenSubmit {
  const _FrozenSubmit({
    required this.text,
    this.images = const <FeedbackImageFile>[],
    this.captureInfo,
    this.logs = const <FeedbackLogFile>[],
  });

  /// 提交时的正文。
  final String text;

  /// 提交时的有序图片列表（v12；单图模式为至多 1 张）。
  final List<FeedbackImageFile> images;

  /// 提交时的截图元数据（无截图为 null）。
  final FeedbackCaptureInfo? captureInfo;

  /// 提交时的日志列表快照。
  final List<FeedbackLogFile> logs;

  /// 与 [other] 是否属于同一份提交快照：
  /// 正文逐字符、图片列表有序逐项逐字节、元数据按序列化结果、日志逐项比较。
  bool sameAs(_FrozenSubmit other) {
    if (text != other.text) return false;
    if (_captureSignature(captureInfo) !=
        _captureSignature(other.captureInfo)) {
      return false;
    }
    if (images.length != other.images.length) return false;
    for (int i = 0; i < images.length; i++) {
      if (images[i].id != other.images[i].id) return false;
      if (images[i].mime != other.images[i].mime) return false;
      if (images[i].filename != other.images[i].filename) return false;
      if (images[i].source != other.images[i].source) return false;
      if (!listEquals(images[i].bytes, other.images[i].bytes)) return false;
    }
    if (logs.length != other.logs.length) return false;
    for (int i = 0; i < logs.length; i++) {
      if (logs[i].filename != other.logs[i].filename) return false;
      if (logs[i].source != other.logs[i].source) return false;
      if (!listEquals(logs[i].bytes, other.logs[i].bytes)) return false;
    }
    return true;
  }

  static String? _captureSignature(FeedbackCaptureInfo? info) =>
      info == null ? null : jsonEncode(info.toJson());
}

/// 当前会话内每条问题的补充草稿，返回列表后仍可恢复。
class _ReplyDraft {
  const _ReplyDraft(this.text, this.images, this.logs, this.offset, this.error);
  final String text;
  final List<FeedbackImageFile> images;
  final List<FeedbackLogFile> logs;
  final double offset;
  final String? error;
}

/// 按 runes 限制输入长度的格式化器（契约按码点计数，
/// 与 [LengthLimitingTextInputFormatter] 的 UTF-16 码元计数不同）。
class _RuneLimitFormatter extends TextInputFormatter {
  const _RuneLimitFormatter(this.maxRunes);

  final int maxRunes;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.text.runes.length <= maxRunes) return newValue;
    final String truncated = String.fromCharCodes(
      newValue.text.runes.take(maxRunes),
    );
    return TextEditingValue(
      text: truncated,
      selection: TextSelection.collapsed(offset: truncated.length),
      composing: TextRange.empty,
    );
  }
}

/// 反馈面板：登录视图 / 撰写视图 / 状态视图的完整状态机。
///
/// 通常经由 [FeedbackWidget] 挂载；单独使用时自行管理展开与关闭
/// （[onRequestClose]）。
class FeedbackPanel extends StatefulWidget {
  /// 构造面板。[httpClient] 与 [tokenStore] 为注入点，主要面向测试；
  /// 省略时使用平台默认实现。
  const FeedbackPanel({
    super.key,
    required this.config,
    this.onRequestClose,
    this.onRetakeScreenshot,
    this.logProvider,
    this.filePicker,
    this.imagePicker,
    this.httpClient,
    this.tokenStore,
    this.tokenStoreFactory,
    this.serverPrefStore,
    this.onEffectiveApiBaseChange,
    this.onUnreadCountChange,
    this.visible,
  });

  /// 连接与展示配置。
  final FeedbackConfig config;

  /// 未读数变化回调（通知外层悬浮入口更新红点徽标）。
  final ValueChanged<int>? onUnreadCountChange;

  /// 请求关闭面板（关闭按钮触发）。
  final VoidCallback? onRequestClose;

  /// 请求重新截图回调。
  final Future<void> Function()? onRetakeScreenshot;

  /// 自动日志采集提供者（可选，优先于 config.logProvider）。
  final FeedbackLogProvider? logProvider;

  /// 手动日志文件选择器（可选，优先于 config.filePicker）。
  final FeedbackFilePicker? filePicker;

  /// 手动图片选择器（可选，优先于 config.imagePicker；v12）。
  final FeedbackImagePicker? imagePicker;

  /// 注入的 HTTP 客户端（主要面向测试）。
  final http.Client? httpClient;

  /// 注入的令牌仓库（主要面向测试）。
  ///
  /// 固定仓库在所有服务身份间共享——切换服务器后读到的是同一份凭据。
  /// 需要按身份隔离（不同服务器各自的令牌槽位）时请注入
  /// [tokenStoreFactory]；缺省使用平台默认（按有效地址 + appId 派生键）。
  final FeedbackTokenStore? tokenStore;

  /// 注入的令牌仓库工厂（主要面向测试）：按有效配置派生仓库，
  /// 使不同服务身份读到各自独立的凭据槽位。[tokenStore] 优先。
  final FeedbackTokenStore Function(FeedbackConfig config)? tokenStoreFactory;

  /// T6：注入的服务器覆盖偏好仓库（主要面向测试）；
  /// 缺省用平台默认（原生安全存储 / Web localStorage）。
  final FeedbackServerPrefStore? serverPrefStore;

  /// T6：实际使用地址变化回调（覆盖保存 / 恢复默认 / 偏好加载完成后触发）；
  /// 宿主（[FeedbackWidget]）据此更新控制器的 `effectiveApiBase`。
  final void Function(String apiBase)? onEffectiveApiBaseChange;

  /// 面板当前是否由用户打开（内部协作接口，不是公开配置）。
  ///
  /// [FeedbackWidget] 常驻面板（`maintainState`）时传入真实开关状态：
  /// 关闭 → 取消尚未完成的登录接续并停止额度定时查询；重新打开 → 立即
  /// 刷新会话与额度。**截图期间暂时隐藏不算关闭**（调用方不得把
  /// `_temporarilyHideForCapture` 折算进来）。
  ///
  /// null 表示未接入（直接构造面板的测试、独立使用）：始终视为可见，
  /// 与旧行为完全兼容。
  final bool? visible;

  @override
  State<FeedbackPanel> createState() => FeedbackPanelState();
}

/// 面板状态（暴露为 public 仅供测试驱动内部状态机）。
class FeedbackPanelState extends State<FeedbackPanel>
    with WidgetsBindingObserver {
  late FeedbackTokenStore _tokenStore;
  late ApiClient _api;
  bool _clientReady = false;

  /// T6：本机保存的服务器覆盖（规范化地址）；null = 使用宿主默认 apiBase。
  String? _serverOverride;

  /// T6：覆盖偏好是否已完成加载——加载完成前不启动任何依赖服务器的请求。
  bool _serverPrefsReady = false;
  FeedbackServerPrefStore? _defaultPrefStore;

  /// T6：身份世代——每次服务身份（有效地址或 appId）切换递增；
  /// 提交 / 轮询 / 刷新 / 会话恢复在发起时捕获，恢复时校验，
  /// 旧身份的迟到结果一律丢弃。
  int _identitySeq = 0;

  /// T6：设置视图状态。
  final TextEditingController _serverInput = TextEditingController();
  bool _settingsOpen = false;
  bool _settingsBusy = false;
  int _settingsOpSeq = 0;
  final Map<String, Future<void>> _prefWriteTails = <String, Future<void>>{};
  String? _serverError;
  String? _serverHint;

  final TextEditingController _draft = TextEditingController();
  final FocusNode _draftFocus = FocusNode();
  final TextEditingController _username = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final FocusNode _usernameFocus = FocusNode();
  final FocusNode _passwordFocus = FocusNode();
  final FocusNode _serverInputFocus = FocusNode();

  /// T9：参与键盘避让滚动管理的焦点节点（焦点切换或键盘尺寸变化后，
  /// 在布局完成时把聚焦字段滚回可见区域）。
  late final List<FocusNode> _managedFocusNodes = <FocusNode>[
    _draftFocus,
    _usernameFocus,
    _passwordFocus,
    _serverInputFocus,
    _replyFocus,
  ];

  /// v12：撰写页有序图片列表（≤[kFeedbackMaxImages]，截图与手动并存）。
  /// 自动截图为 `source='capture'` 的一张；手动添加为 `manual`；
  /// 经编辑器保存后标记 `edited`（替换内容不占新名额，id 复用）。
  final List<FeedbackImageFile> _images = <FeedbackImageFile>[];
  FeedbackCaptureInfo? _captureInfo;

  /// 最近一次截图预览提示：宿主存在不可绘制内容（PlatformView/Texture）。
  bool _undrawableNotice = false;

  /// 最近一次接受的截图交付所属捕获序号（null 表示无会化交付）。
  int? _lastCaptureSeq;

  /// 服务端能力（v12）：images 缺失 → 单图模式 + 升级提示。
  FeedbackCapabilities? _capabilities;
  bool _capabilitiesLoaded = false;

  /// 最大图片数（缺省按契约 5；服务端缺失 capabilities.images 时为 1）。
  int get _maxImages =>
      (_capabilities?.images ?? 1).clamp(1, kFeedbackMaxImages);

  /// 能力降级：已探测且服务端不支持多图。
  bool get _singleImageMode =>
      _capabilitiesLoaded && (_capabilities?.images ?? 0) < 2;

  /// 当前截图（自动捕获）槽位：列表中 source='capture' 的一张。
  int get _captureIndex =>
      _images.indexWhere((FeedbackImageFile i) => i.source == 'capture');

  /// 当前截图数据（若有）。
  Uint8List? get screenshotBytes =>
      _captureIndex >= 0 ? _images[_captureIndex].bytes : null;

  /// 面板是否持有草稿文本（只读；父组件据此判断行为，不得直接改写草稿）。
  bool get hasDraft => _draft.text.trim().isNotEmpty;

  /// 面板是否持有当前截图（只读）。
  bool get hasScreenshot => _captureIndex >= 0;

  /// 面板是否持有任意图片附件（只读）。
  bool get hasImages => _images.isNotEmpty;

  /// 图片上限（T1.4 捕获前置检查用）：能力未知时按契约上限 5 张判断，
  /// 已探测后按服务端能力（缺省单图）判断。
  int get captureImageLimit =>
      _capabilitiesLoaded ? _maxImages : kFeedbackMaxImages;

  /// 是否还能接纳一张新截图（只读）：已持有截图（可替换）或未达图片上限。
  /// 达到上限且无可替换截图时，宿主必须先提示整理附件、不发起捕获。
  bool get canAcceptCapture =>
      hasScreenshot || _images.length < captureImageLimit;

  /// 宿主在撰写视图展示一条提示（如「截图失败可重试」「请先整理附件」）。
  /// 不改写草稿、不清除已有截图与图片。
  void showComposeNotice(String message) {
    if (!mounted) return;
    setState(() {
      _panelTab = _PanelTab.compose;
      _selectedDialogueId = null;
      _stage = FeedbackStage.compose;
      _composeError = message;
    });
  }

  /// 当前截图的捕获元数据（若有；只读）。
  FeedbackCaptureInfo? get captureInfo => _captureInfo;

  List<FeedbackLogFile> _logs = <FeedbackLogFile>[];
  bool _logsCollecting = false;
  bool _logsCollected = false;
  String? _logError;
  int _logsSeq = 0;

  /// T4：日志区折叠状态——默认只显示「已附诊断日志／暂无日志」摘要，
  /// 展开后可查看文件、预览、移除、重新采集。
  bool _logsExpanded = false;

  /// 当前日志列表（测试/只读）。
  List<FeedbackLogFile> get logs => List<FeedbackLogFile>.unmodifiable(_logs);

  /// 面板是否持有日志附件（只读）。
  bool get hasLogs => _logs.isNotEmpty;

  /// 日志是否正在采集（只读）。
  bool get logsCollecting => _logsCollecting;

  /// 外部/测试注入日志。
  void addLog(FeedbackLogFile file) {
    _addManualLogs(<FeedbackLogFile>[file]);
  }

  /// 移除指定索引日志。
  void removeLog(int index) {
    if (index >= 0 && index < _logs.length) {
      setState(() {
        _logs.removeAt(index);
        _logError = null;
      });
    }
  }

  /// 清空日志列表。
  void clearLogs() {
    setState(() {
      _logs.clear();
      _logError = null;
    });
  }

  /// 设置当前截图数据（v12：写入 / 替换有序图片列表中的 capture 槽位，
  /// 复用稳定 id；bytes 为 null 时仅移除该槽位）。
  ///
  /// [captureSeq] 为捕获会话序号（由 [FeedbackWidget] 分配）。序号低于
  /// 已接受交付的调用视为过期结果（如 post-frame 回调写入旧捕获），
  /// 直接丢弃，防止覆盖新状态。[containsUndrawable] 标记捕获时检测到
  /// 宿主存在不可绘制内容（PlatformView/Texture），在预览旁提示用户。
  void setScreenshot(
    Uint8List? bytes,
    FeedbackCaptureInfo? captureInfo, {
    int? captureSeq,
    bool containsUndrawable = false,
  }) {
    if (captureSeq != null &&
        _lastCaptureSeq != null &&
        captureSeq < _lastCaptureSeq!) {
      return; // 过期交付：丢弃。
    }
    _lastCaptureSeq = captureSeq ?? _lastCaptureSeq;
    setState(() {
      _undrawableNotice = containsUndrawable;
      final int idx = _captureIndex;
      if (bytes == null) {
        if (idx >= 0) _images.removeAt(idx);
        _captureInfo = null;
        return;
      }
      final FeedbackImageFile image = FeedbackImageFile(
        id: idx >= 0 ? _images[idx].id : generateFeedbackIdempotencyKey(),
        filename: 'screenshot.png',
        bytes: bytes,
        mime: 'image/png',
        source: 'capture',
        sha256: null, // 提交时计算（内容变化后旧摘要作废）。
      );
      if (idx >= 0) {
        _images[idx] = image; // 重拍/重新捕获替换原槽位，不占新名额
      } else {
        _images.insert(0, image); // 截图排首位（呼出时即存在）
      }
      _captureInfo = captureInfo;
    });
  }

  Timer? _pollTimer;
  Duration _pollDelay = const Duration(seconds: 2);
  bool _pollInFlight = false;

  String? _ticketId;
  String? _idempotencyKey;

  /// T4：当前记录的「等待项」提示（等待配置 / 等待确认来源 / 等待人工归档）。
  /// 非空表示反馈已妥善保存、只是在等管理员操作——此时**不轮询**（等待不是
  /// 处理中，无限轮询没有意义），改为提示 + 手动刷新。
  String? _waitingNotice;

  /// 最近一次未决（结果未知 / 未送达）提交冻结的完整快照。快照在其后发生
  /// 变化（改文案 / 换图 / 移图）时，不得复用旧幂等键提交新内容（同 key
  /// 不同字节会触发 409 冲突、被误判为重放）；此时改用新 key 提交新快照
  /// （与 Web 端"编辑后新草稿版本 → 新快照新 key"对齐）。
  _FrozenSubmit? _pendingSubmit;
  String? _lastSubmittedText;
  String? _kaneoUrl;
  String? _errorSummary;
  String? _composeError;

  /// Class B（服务端已接收但处理失败）视图上的操作反馈
  /// （复制反馈 ID / 刷新状态的结果提示）。
  String? _failedNotice;

  bool _authReady = false;
  bool _signedIn = false;
  bool _busy = false; // 提交中 / 登录中
  FeedbackStage _stage = FeedbackStage.compose;

  /// 面板内登录表单是否展开（点击「登录并提交」展开，不打开任何窗口）。
  bool _showLoginForm = false;

  /// 登录成功后是否自动提交（点击「登录并提交」触发）。
  bool _submitAfterLogin = false;

  /// 登录错误提示（面板内表单）。
  String? _loginError;

  /// 登录操作序号（T1-A）：每次发起登录递增；面板关闭 / 取消登录 /
  /// 销毁 / 身份变化都会递增使在途登录失效，并清除密码、登录忙碌状态
  /// 与待自动提交标记。回调返回后必须校验序号（外加 [mounted]）才允许
  /// 写入令牌、更新界面或自动提交；失败回调同样校验。
  int _loginSeq = 0;

  /// 是否有登录请求在途（用于失效时只清除登录忙碌态，不误清提交忙碌态）。
  bool _loginInFlight = false;

  /// 已登录账号与最新额度（额度由服务端按北京时间日切分）。
  AuthUser? _user;
  Quota? _quota;

  /// 额度查询序号（T1-B）：提交成功 / 收到额度错误 / 关闭 / 销毁 /
  /// 退到后台 / 401 都会递增使在途查询失效；结果除校验枚举与令牌外
  /// 还要校验该序号，避免旧查询覆盖刚扣除后的次数。
  int _quotaSeq = 0;

  /// 额度查询定时器（resetAt 单次 或 额度用尽后每 30 秒）；同时最多一个。
  Timer? _quotaTimer;

  /// 额度查询进行中：同一时刻最多一个额度查询。
  bool _quotaInFlight = false;

  /// 最近一次额度刷新失败（网络等）：保留旧额度，30 秒后重试。
  bool _quotaRefreshFailed = false;

  /// 「待立即刷新」标记（T1-B）：打开面板 / 回到前台的刷新被旧查询或忙碌
  /// 挡下时登记，不得丢弃；旧查询结束后或忙碌结束后立即补发一次。多次
  /// 登记合并为一次；关闭 / 销毁 / 退后台 / 401 时清除，重新打开重新登记。
  bool _quotaRefreshPending = false;

  /// 应用是否在前台（退到后台时取消额度定时查询）。
  bool _foreground = true;

  /// 额度用尽后的重试间隔：后台调高额度后最多 30 秒即可恢复提交。
  static const Duration _quotaRetryDelay = Duration(seconds: 30);

  /// 额度定时查询的最大等待。服务端 `resetAt` 正常在 24 小时内（北京时间日切）；
  /// 异常 / 超远时间不直接交给宿主定时器（避免排一个无意义的超长定时器）。
  static const Duration _quotaMaxDelay = Duration(hours: 24);

  /// v11 标签、未读数与历史对话状态
  _PanelTab _panelTab = _PanelTab.compose;
  int _unreadCount = 0;
  Timer? _summaryTimer;

  bool _historyLoading = false;
  String? _historyError;
  List<UserFeedbackListItem> _myFeedbacks = <UserFeedbackListItem>[];

  /// v12：历史分页与状态筛选。
  int _historyPage = 1;
  int _historyTotal = 0;
  final int _historyLimit = 10;
  IssueStatus? _historyFilter;

  String? _selectedDialogueId;
  bool _dialogueLoading = false;
  String? _dialogueError;
  FeedbackDialogueResponse? _dialogueData;
  Timer? _dialogueTimer;

  /// 对话列表滚动控制器：轮询增量刷新不强制跳滚动——仅当用户本已在底部
  /// 时才跟随新消息滚到底。
  final ScrollController _dialogueScroll = ScrollController();

  final TextEditingController _replyController = TextEditingController();
  final FocusNode _replyFocus = FocusNode();

  /// v12：回复图片列表（≤_maxImages，可与日志并存）。
  final List<FeedbackImageFile> _replyImages = <FeedbackImageFile>[];
  final List<FeedbackLogFile> _replyLogs = <FeedbackLogFile>[];
  bool _replySending = false;
  String? _replyError;
  int _trackingSession = 0;
  int _historyRequest = 0;
  int _dialogueRequest = 0;
  int _dialogueVisit = 0;
  int? _dialogueFlight;
  int? _dialogueFlightVisit;
  final Map<String, _ReplyDraft> _replyDrafts = <String, _ReplyDraft>{};
  final Set<String> _sendingReplies = <String>{};

  bool _trackingValid(int session, ApiClient api) =>
      mounted &&
      _signedIn &&
      session == _trackingSession &&
      identical(_api, api);

  void _clearTrackingSession() {
    ++_trackingSession;
    ++_dialogueVisit;
    ++_historyRequest;
    ++_dialogueRequest;
    _replyDrafts.clear();
    _sendingReplies.clear();
    _selectedDialogueId = null;
    _dialogueData = null;
    _dialogueLoading = false;
    _dialogueError = null;
    _historyLoading = false;
    _historyError = null;
    _historyTotal = 0;
    _historyPage = 1;
    _historyFilter = null;
    _myFeedbacks = <UserFeedbackListItem>[];
    _replyController.clear();
    _replyImages.clear();
    _replyLogs.clear();
    _replySending = false;
    _replyError = null;
  }

  void _saveReplyDraft() {
    final String? id = _selectedDialogueId;
    if (id == null) return;
    _replyDrafts[id] = _ReplyDraft(
      _replyController.text,
      List<FeedbackImageFile>.from(_replyImages),
      List<FeedbackLogFile>.from(_replyLogs),
      _dialogueScroll.hasClients ? _dialogueScroll.offset : 0,
      _replyError,
    );
  }

  /// 面板当前是否由用户打开（[FeedbackPanel.visible] 为 null 时视为可见）。
  bool get _panelVisible => widget.visible ?? true;

  /// T6：当前实际使用的服务器地址——本机覆盖优先于宿主默认 apiBase。
  String get effectiveApiBase => _serverOverride ?? widget.config.apiBase;

  /// T6：按有效地址派生的配置（覆盖存在时复制 config 替换 apiBase）。
  FeedbackConfig get _effectiveConfig => _serverOverride == null
      ? widget.config
      : widget.config.copyWith(apiBase: _serverOverride);

  FeedbackServerPrefStore get _prefStore =>
      widget.serverPrefStore ??
      (_defaultPrefStore ??= createDefaultServerPrefStore());

  /// 当前令牌仓库（测试可见）。
  FeedbackTokenStore get tokenStore => _tokenStore;

  /// 当前面板阶段（测试可见）。
  FeedbackStage get stage => _stage;

  /// 未读摘要轮询是否激活（测试可见；30s 周期）。
  @visibleForTesting
  bool get summaryPollingActive => _summaryTimer?.isActive ?? false;

  /// 对话详情轮询是否激活（测试可见；10s 周期）。
  @visibleForTesting
  bool get dialoguePollingActive => _dialogueTimer?.isActive ?? false;

  /// 当前撰写图片数（测试可见）。
  @visibleForTesting
  int get imageCount => _images.length;

  /// 是否处于单图降级模式（测试可见）。
  @visibleForTesting
  bool get singleImageMode => _singleImageMode;

  /// 当前服务器覆盖（规范化地址；测试可见，null = 未覆盖）。
  String? get serverOverride => _serverOverride;

  /// 覆盖偏好是否已加载完成（测试可见）。
  bool get serverPrefsReady => _serverPrefsReady;

  /// 设置视图是否展开（测试可见）。
  bool get settingsOpen => _settingsOpen;

  /// 各输入框焦点状态（测试可见）。
  bool get draftFocused => _draftFocus.hasFocus;
  bool get usernameFocused => _usernameFocus.hasFocus;
  bool get passwordFocused => _passwordFocus.hasFocus;
  bool get serverInputFocused => _serverInputFocus.hasFocus;

  /// 重建 API 客户端与令牌仓库：按当前有效身份派生（T6/T7）。
  ///
  /// 令牌仓库键由「有效地址 + appId」派生——切换后读到的是目标身份自己的
  /// 令牌槽位，旧身份令牌绝不发往新地址。旧客户端的 401 回调被钳制：
  /// 仅当该客户端仍是当前客户端时才允许清除凭据 / 改写登录界面。
  void _rebuildClient() {
    if (_clientReady) _api.dispose();
    _clientReady = true;
    final FeedbackConfig effective = _effectiveConfig;
    _tokenStore = CoordinatedTokenStore.of(
      widget.tokenStore ??
          (widget.tokenStoreFactory ?? createDefaultTokenStore)(effective),
    );
    final ApiClient api = ApiClient(
      config: effective,
      tokenStore: _tokenStore,
      httpClient: widget.httpClient,
    );
    api.onUnauthorized = () {
      if (identical(_api, api)) _onUnauthorized();
    };
    _api = api;
  }

  /// 服务身份切换的统一收口（T7）：身份世代递增使在途操作全部失效，
  /// 清空属于旧身份的草稿 / 截图 / 日志 / 任务态 / 额度 / 幂等键 / 快照，
  /// 并标记偏好重新加载中。调用方随后触发 [_loadServerOverride] 或直接
  /// [_finishIdentitySwitch] 完成重建与会话恢复。
  void _beginIdentitySwitch() {
    _identitySeq++;
    _clearTrackingSession();
    _settingsOpSeq++;
    _pollTimer?.cancel();
    _pollTimer = null;
    _pollInFlight = false;
    _invalidateLogin();
    _invalidateQuotaRefresh();
    _quotaRefreshPending = false;
    ++_logsSeq;
    _logsCollecting = false;
    _logsCollected = false;
    _logs = <FeedbackLogFile>[];
    _logError = null;
    _images.clear();
    _captureInfo = null;
    _undrawableNotice = false;
    _lastCaptureSeq = null;
    _capabilities = null;
    _capabilitiesLoaded = false;
    _cancelDialogueTimer();
    _cancelSummaryTimer();
    _selectedDialogueId = null;
    _dialogueData = null;
    _dialogueError = null;
    _dialogueLoading = false;
    _replyController.clear();
    _replyImages.clear();
    _replyLogs.clear();
    _replySending = false;
    _myFeedbacks = <UserFeedbackListItem>[];
    _historyError = null;
    _historyLoading = false;
    _historyPage = 1;
    _historyTotal = 0;
    _historyFilter = null;
    _unreadCount = 0;
    widget.onUnreadCountChange?.call(0);
    _draft.clear();
    _username.clear();
    _ticketId = null;
    _idempotencyKey = null;
    _pendingSubmit = null;
    _lastSubmittedText = null;
    _kaneoUrl = null;
    _errorSummary = null;
    _composeError = null;
    _failedNotice = null;
    _waitingNotice = null;
    _signedIn = false;
    _authReady = false;
    _busy = false;
    _loginInFlight = false;
    _stage = FeedbackStage.compose;
    _showLoginForm = false;
    _submitAfterLogin = false;
    _loginError = null;
    _user = null;
    _quota = null;
    _quotaRefreshFailed = false;
    _quotaInFlight = false;
    _settingsBusy = false;
    _serverError = null;
    _serverHint = null;
    _serverPrefsReady = false;
  }

  /// 身份就绪收口：重建客户端 → 上报有效地址 → 恢复目标身份会话 → 采集日志。
  void _finishIdentitySwitch() {
    _serverPrefsReady = true;
    _rebuildClient();
    _reportEffectiveApiBase();
    if (_settingsOpen) _serverInput.text = _serverOverride ?? '';
    setState(() {});
    unawaited(_restoreSession());
    if (_panelVisible) unawaited(_collectLogs());
  }

  void _reportEffectiveApiBase() {
    widget.onEffectiveApiBaseChange?.call(effectiveApiBase);
  }

  /// 读取本机覆盖偏好（按当前 appId + 规范化默认地址槽位）。
  /// 加载完成前 [_serverPrefsReady] 为 false，不启动依赖服务器的请求。
  Future<void> _loadServerOverride() async {
    final int idSeq = _identitySeq;
    final String key = serverOverrideStorageKey(
      appId: widget.config.appId,
      defaultApiBase: widget.config.apiBase,
    );
    String? value;
    try {
      // 超时兜底：插件未注册等环境可能挂起，不可用按无覆盖处理。
      final String? raw =
          await _prefStore.read(key).timeout(const Duration(seconds: 2));
      if (raw != null) {
        final ServerBaseNormalization norm = normalizeServerBase(raw);
        // 所存值非法（旧格式 / 手改）视为无覆盖，绝不静默应用
        value = norm.ok ? norm.base : null;
      }
    } catch (_) {
      value = null;
    }
    if (!mounted || idSeq != _identitySeq) return;
    _serverOverride = value;
    _finishIdentitySwitch();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // 先构建默认身份客户端（本地操作，不发请求）；
    // 覆盖偏好加载完成后才恢复会话 / 采集日志（[_loadServerOverride] 收口）。
    _rebuildClient();
    _draft.addListener(_onDraftChanged);
    for (final FocusNode node in _managedFocusNodes) {
      node.addListener(() {
        if (node.hasFocus) _scrollFocusedFieldIntoView();
      });
    }
    final AppLifecycleState? lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    unawaited(_loadServerOverride());
  }

  @override
  void didUpdateWidget(FeedbackPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.config.appId != widget.config.appId ||
        oldWidget.config.apiBase != widget.config.apiBase) {
      // 身份源变化（宿主默认地址或 appId）：覆盖槽位随之变化——
      // 先整体作废旧身份状态，再按新键重读覆盖并重建客户端。
      _beginIdentitySwitch();
      unawaited(_loadServerOverride());
    }
    final bool wasVisible = oldWidget.visible ?? true;
    final bool nowVisible = widget.visible ?? true;
    if (wasVisible && !nowVisible) {
      // 用户关闭面板：取消尚未完成的登录接续与额度定时查询，
      // 使在途额度查询失效；不撤销已建立的登录态，不动草稿与截图。
      // 同时清除「待立即刷新」意图（重新打开时按当前状态重新登记）。
      _invalidateLogin();
      _invalidateQuotaRefresh();
      _cancelSummaryTimer();
      _cancelDialogueTimer();
      _quotaRefreshPending = false;
      ++_logsSeq;
      _logsCollecting = false;
    } else if (!wasVisible && nowVisible) {
      // 重新打开：必须实际调用刷新（不能只请求输入焦点）。
      _onPanelOpened();
      _startSummaryPolling();
      if (_selectedDialogueId != null) {
        _startDialoguePolling();
      }
    }
  }

  /// 面板被用户打开：请求输入焦点并立即刷新会话与额度。
  void _onPanelOpened() {
    _focusFirstField();
    unawaited(_refreshQuota());
    if (!_logsCollected && !_logsCollecting) {
      unawaited(_collectLogs());
    }
  }

  /// T9：字段获得焦点或键盘尺寸变化后，在布局完成时把聚焦字段
  /// 滚动到可见区域（输入框、账号、密码、服务器地址共用）。
  void _scrollFocusedFieldIntoView() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      for (final FocusNode node in _managedFocusNodes) {
        final BuildContext? ctx = node.context;
        if (node.hasFocus && ctx != null) {
          Scrollable.ensureVisible(
            ctx,
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            alignment: 0.08,
          );
          break;
        }
      }
    });
  }

  @override
  void didChangeMetrics() {
    // T9：键盘展开 / 收起 / 旋转改变可用高度；布局完成后重校聚焦字段。
    if (_managedFocusNodes.any((FocusNode n) => n.hasFocus)) {
      _scrollFocusedFieldIntoView();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 应用恢复前台时刷新额度（跨过 resetAt 后由服务端给出新额度）；
    // 退到后台时取消额度定时查询并使在途查询失效。
    if (state == AppLifecycleState.resumed) {
      _foreground = true;
      _quotaRefreshFailed = false;
      unawaited(_refreshQuota());
      _startSummaryPolling();
      if (_selectedDialogueId != null) {
        _startDialoguePolling();
      }
    } else {
      _foreground = false;
      _invalidateQuotaRefresh();
      _cancelSummaryTimer();
      _cancelDialogueTimer();
      _quotaRefreshPending = false; // 退后台清除补发意图；回前台重新登记
    }
  }

  Future<void> _restoreSession() async {
    // T7：捕获身份世代——只恢复目标身份自己槽位的令牌；
    // 切换后迟到的读取结果不得改写新身份的登录态。
    final int idSeq = _identitySeq;
    String? token;
    try {
      // 超时兜底：个别平台实现可能挂起（如插件未注册的测试环境），
      // 不可用则退回登录视图，不打断 UI。
      token = await _tokenStore.read().timeout(const Duration(seconds: 2));
    } catch (_) {
      token = null;
    }
    if (!mounted || idSeq != _identitySeq) return;
    setState(() {
      _signedIn = token != null && token.isNotEmpty;
      _authReady = true;
    });
    if (_signedIn) {
      unawaited(_refreshQuota());
      _startSummaryPolling();
      unawaited(_fetchSummary());
      unawaited(_refreshCapabilities());
    }
    _focusFirstField();
  }

  /// v12 能力探测：`session.capabilities` 由 [_refreshQuota] 合并；
  /// 缺失时再探测 `GET /api/features`（无需登录）。旧服务一律按
  /// `capabilities.images` 缺失处理——单图模式 + 升级提示，不静默丢图。
  Future<void> _refreshCapabilities() async {
    final int idSeq = _identitySeq;
    // session 已带回能力时无需额外请求（不重复 fetchSession：额度/会话
    // 请求计数是许多测试的断言面）。
    if (_capabilities?.images != null) {
      return;
    }
    FeedbackCapabilities? caps = _capabilities;
    try {
      final FeedbackCapabilities? features = await _api.fetchCapabilities();
      if (features != null) {
        caps = FeedbackCapabilities(
          dialogue: features.dialogue || (caps?.dialogue ?? false),
          images: features.images ?? caps?.images,
        );
      }
    } catch (_) {
      // 探测失败：保持现状（缺省即单图模式）。
    }
    if (!mounted || idSeq != _identitySeq) return;
    setState(() {
      _capabilities = caps;
      _capabilitiesLoaded = true;
    });
  }

  void _focusFirstField() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_signedIn && _stage == FeedbackStage.compose) {
        _draftFocus.requestFocus();
      } else if (!_signedIn && _showLoginForm) {
        _usernameFocus.requestFocus();
      } else if (!_signedIn) {
        _draftFocus.requestFocus();
      }
    });
  }

  /// 请求把输入焦点放到主输入区（面板呼出时由 [FeedbackWidget] 调用）。
  void requestInputFocus() => _focusFirstField();

  void _onDraftChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    _cancelSummaryTimer();
    _cancelDialogueTimer();
    // 销毁：使在途登录与额度查询失效并取消额度定时查询。
    _invalidateLogin();
    _invalidateQuotaRefresh();
    _quotaRefreshPending = false;
    _draft.removeListener(_onDraftChanged);
    _api.dispose();
    _draft.dispose();
    _draftFocus.dispose();
    _username.dispose();
    _password.dispose();
    _usernameFocus.dispose();
    _passwordFocus.dispose();
    _serverInputFocus.dispose();
    _serverInput.dispose();
    _replyController.dispose();
    _replyFocus.dispose();
    _dialogueScroll.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------- 认证

  void _onUnauthorized() {
    if (!mounted) return;
    _clearTrackingSession();
    _pollTimer?.cancel();
    _cancelSummaryTimer();
    _cancelDialogueTimer();
    _unreadCount = 0;
    widget.onUnreadCountChange?.call(0);
    // 401：回到需要登录态并停止额度定时查询；同时清除补发意图，
    // 避免对已失效会话的补发循环（重新登录后由登录流程重新调度）。
    _invalidateQuotaRefresh();
    _quotaRefreshPending = false;
    setState(() {
      _signedIn = false;
      _stage = FeedbackStage.compose;
      _busy = false;
      _user = null;
      _quota = null;
      _showLoginForm = false;
      _submitAfterLogin = false;
      _loginError = null;
    });
    _focusFirstField();
  }

  String _clientLabel() =>
      'flutter-${defaultTargetPlatform.name}-${DateTime.now().toIso8601String()}';

  /// 使尚未完成的登录接续失效：递增登录序号，清除密码、登录忙碌状态
  /// 与待自动提交标记。不撤销已建立的登录态，也不动草稿与截图。
  void _invalidateLogin() {
    _loginSeq++;
    _submitAfterLogin = false;
    _password.clear();
    if (_loginInFlight) {
      _loginInFlight = false;
      _busy = false; // 只清登录忙碌态：提交在途时不得误清。
    }
  }

  /// 登录回调是否仍然有效：序号未变（面板自登录发起以来没有被关闭、
  /// 也没有被取消 / 销毁 / 换身份）且面板仍然可见。
  bool _loginStillValid(int seq) =>
      mounted && seq == _loginSeq && _panelVisible;

  // ---------------------------------------------------------------- 额度

  void _cancelQuotaTimer() {
    _quotaTimer?.cancel();
    _quotaTimer = null;
  }

  /// 使在途额度查询失效并取消定时查询（关闭 / 销毁 / 退后台 / 401 /
  /// 提交成功 / 收到额度错误）。
  void _invalidateQuotaRefresh() {
    _quotaSeq++;
    _cancelQuotaTimer();
  }

  /// 统一调度额度查询（同一时刻最多一个定时器）：
  /// - 未登录 / 面板未打开 / 应用不在前台 → 不排程；
  /// - 刷新失败 → 30 秒后重试（不对过期 resetAt 立即循环请求）；
  /// - 额度用尽 → 每 30 秒一次，并与 resetAt 合并取更早者；
  /// - 其它状态 → 只在服务端 resetAt 排单次查询。
  ///
  /// 「待立即刷新」意图由 [_consumeQuotaRefreshIntent] 优先消费并立即补发，
  /// 本方法只负责常规定时规则（T1-B）。
  void _scheduleQuotaRefresh() {
    _cancelQuotaTimer();
    if (!mounted || !_signedIn || !_panelVisible || !_foreground) return;
    if (_quotaInFlight) return; // 在途查询完成后会重新调度
    Duration? delay;
    if (_quotaRefreshFailed) {
      delay = _quotaRetryDelay;
    } else {
      final Quota? q = _quota;
      // 不限形态（管理员）没有数值额度：不参与用尽轮询，显示也不依赖定时刷新。
      if (q == null || q.unlimited) return;
      final int remaining = q.remaining ?? 0;
      final Duration? until = q.resetAt?.difference(DateTime.now());
      if (remaining <= 0) {
        delay =
            (until != null && until > Duration.zero && until < _quotaRetryDelay)
                ? until
                : _quotaRetryDelay;
      } else if (until != null && until > Duration.zero) {
        delay = until;
      } else {
        delay = null; // 非用尽且 resetAt 已过：等下一次打开 / 回到前台刷新
      }
    }
    if (delay == null || delay <= Duration.zero) return;
    if (delay > _quotaMaxDelay) delay = _quotaMaxDelay;
    _quotaTimer = Timer(delay, () {
      _quotaTimer = null;
      unawaited(_refreshQuota());
    });
  }

  /// 刷新额度与会话信息（打开面板 / 重新打开 / 登录后 / 提交完成后 / 恢复前台）。
  /// 结果除校验挂载状态外还要校验查询序号：提交成功或额度错误之后的旧查询
  /// 不得把剩余次数加回。
  Future<void> _refreshQuota() async {
    if (!_signedIn || _busy || _quotaInFlight) {
      // T1-B：被旧查询或忙碌挡下时登记「待立即刷新」，不得丢弃意图；
      // 未登录 / 面板未打开 / 不在前台时不登记（相应事件会重新登记）。
      if (mounted &&
          _signedIn &&
          _panelVisible &&
          _foreground &&
          (_busy || _quotaInFlight)) {
        _quotaRefreshPending = true;
      }
      return;
    }
    final int seq = ++_quotaSeq;
    _quotaInFlight = true;
    try {
      final SessionInfo info = await _api.fetchSession();
      if (!mounted || seq != _quotaSeq) return;
      setState(() {
        _quota = info.quota ?? _quota;
        _user = info.user ?? _user;
        _quotaRefreshFailed = false;
        // v12：session 已带 capabilities 时直接采用（images 缺失才另行探测）。
        if (info.capabilities != null) {
          _capabilities = info.capabilities;
          _capabilitiesLoaded = true;
        }
      });
    } on ApiException {
      // 401 已由 ApiClient 触发 onUnauthorized；其它错误保留旧额度、30 秒后重试。
      if (!mounted || seq != _quotaSeq) return;
      _quotaRefreshFailed = true;
    } catch (_) {
      // 网络异常：保留旧额度与草稿。
      if (!mounted || seq != _quotaSeq) return;
      _quotaRefreshFailed = true;
    } finally {
      _quotaInFlight = false;
      _consumeQuotaRefreshIntent();
    }
  }

  /// 消费「待立即刷新」意图（T1-B）：优先于定时规则——旧查询结束 / 忙碌
  /// 结束后条件仍满足时立即补发一次并清除标记；否则按现有 30 秒 / resetAt
  /// 规则排定时器（不会紧密循环，也不会因一次跳过而永久停摆）。
  void _consumeQuotaRefreshIntent() {
    if (_quotaRefreshPending &&
        mounted &&
        _signedIn &&
        _panelVisible &&
        _foreground &&
        !_busy &&
        !_quotaInFlight) {
      _quotaRefreshPending = false;
      unawaited(_refreshQuota());
      return;
    }
    _scheduleQuotaRefresh();
  }

  /// 展开面板内账号密码表单（不打开新窗口）。
  void _openLoginForm({required bool thenSubmit}) {
    if (_busy) return;
    setState(() {
      _showLoginForm = true;
      _submitAfterLogin = thenSubmit;
      _loginError = null;
    });
    _focusFirstField();
  }

  void _cancelLoginForm() {
    // 取消登录：使在途登录失效（迟到结果不得写令牌 / 更新界面 / 自动提交）。
    _invalidateLogin();
    setState(() {
      _showLoginForm = false;
      _submitAfterLogin = false;
      _loginError = null;
    });
  }

  /// 提交登录表单：成功后（可选）自动提交一次。
  ///
  /// 令牌写入**之前**先校验操作有效性；写入完成后再次校验——
  /// 已开始的平台安全存储写入无法撤回时不做无条件清库（避免误删更新的
  /// 凭据），只保证失效操作不更新界面、不自动提交。
  Future<void> _login() async {
    if (_busy) return;
    final String username = _username.text.trim();
    final String password = _password.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _loginError = '请输入用户名和密码');
      return;
    }
    final int seq = ++_loginSeq;
    _loginInFlight = true;
    setState(() {
      _busy = true;
      _loginError = null;
    });
    final bool thenSubmit = _submitAfterLogin;
    try {
      final LoginResult result = await _api.login(
        username: username,
        password: password,
        clientLabel: _clientLabel(),
        appId: widget.config.appId,
      );
      if (!_loginStillValid(seq)) return; // 写入令牌之前校验
      try {
        await _tokenStore.write(result.token);
      } catch (_) {
        // T1-C：平台安全存储写入失败（如 macOS Keychain 缺少 entitlement）
        // 与凭据错误 / 网络失败明确区分——登录请求本身已成功，只是无法保存
        // 登录状态。清空密码、取消自动提交、保留草稿，提示检查安全存储。
        if (!_loginStillValid(seq)) return;
        _invalidateLogin();
        setState(() {
          _busy = false;
          _loginError = '无法保存登录状态，请检查应用的安全存储配置';
        });
        return;
      }
      if (!_loginStillValid(seq)) return; // 写入完成后再次校验
      _loginInFlight = false;
      setState(() {
        _busy = false;
        _signedIn = true;
        _showLoginForm = false;
        _submitAfterLogin = false;
        _loginError = null;
        _user = result.user;
        _quota = result.quota;
        _quotaRefreshFailed = false;
        _password.clear(); // 密码不留存 UI。
      });
      _invalidateQuotaRefresh();
      _consumeQuotaRefreshIntent(); // 登录忙碌结束：补发被挡下的刷新
      _startSummaryPolling();
      unawaited(_fetchSummary());
      unawaited(_refreshCapabilities());
      _focusFirstField();
      if (thenSubmit && _draft.text.trim().isNotEmpty) {
        await _submit(); // 登录成功后只提交一次
      }
    } on ApiException catch (e) {
      if (!_loginStillValid(seq)) return; // 失效登录的错误不得覆盖新登录
      _loginInFlight = false;
      setState(() {
        _busy = false;
        _password.clear(); // 登录结束清空密码。
        _loginError = _friendlyApiError(e);
      });
    } catch (_) {
      if (!_loginStillValid(seq)) return;
      _loginInFlight = false;
      setState(() {
        _busy = false;
        _password.clear();
        _loginError = '网络异常，登录失败，请稍后重试';
      });
    }
  }

  // ---------------------------------------------------------------- 提交

  /// 草稿是否满足提交条件（与登录状态无关）。
  bool get _draftValid {
    final int runes = _draft.text.runes.length;
    return runes > 0 &&
        runes <= kFeedbackMaxTextRunes &&
        _draft.text.trim().isNotEmpty;
  }

  /// 结果未知的同键重试（服务端可能已接收）：额度用尽也允许，避免丢失已接收结果。
  bool get _retryingUnknown =>
      _stage == FeedbackStage.notSent && _pendingSubmit != null;

  /// 额度用尽：禁止新提交（但允许上面的同键重试）；管理员不限次数。
  bool get _quotaBlocked {
    final Quota? q = _quota;
    return _signedIn &&
        q != null &&
        !q.unlimited &&
        (q.remaining ?? 0) <= 0 &&
        !_retryingUnknown;
  }

  bool get _canSubmit {
    return !_busy &&
        _signedIn &&
        (_stage == FeedbackStage.compose || _stage == FeedbackStage.notSent) &&
        _draftValid &&
        !_quotaBlocked;
  }

  Future<void> _submit() async {
    // T6：覆盖偏好加载完成前不启动依赖服务器的请求。
    if (!_serverPrefsReady) return;
    if (_quotaBlocked) {
      setState(() {
        _composeError = '今日提交次数已用完，请在额度刷新后重试。您的输入已保留';
      });
      return;
    }
    if (!_canSubmit) return;
    // 防御：Class B（服务端已接收、后台处理失败）绝不重新 POST——重发只会
    // 产生重复工单；该视图只提供刷新状态 / 复制反馈 ID / 返回编辑开新反馈。
    if (_stage == FeedbackStage.failed) return;
    // v12：有图片但能力未知时先探测一次，决定 images/单图旧字段路径。
    if (_images.isNotEmpty && !_capabilitiesLoaded) {
      await _refreshCapabilities();
      if (!mounted) return;
    }
    // T7：捕获身份世代——服务切换后迟到的提交结果一律丢弃。
    final int idSeq = _identitySeq;
    final String text = _draft.text;
    // 冻结本次提交的完整快照（正文 + 图片列表 + 元数据）：既要保证请求发出
    // 后草稿变化不影响本次字节，也要作为"能否复用旧幂等键"的比较依据。
    final _FrozenSubmit snapshot = _FrozenSubmit(
      text: text,
      images: List<FeedbackImageFile>.from(_images),
      captureInfo: _captureInfo,
      logs: List<FeedbackLogFile>.from(_logs),
    );
    final _FrozenSubmit? pending = _pendingSubmit;
    if (_idempotencyKey != null &&
        pending != null &&
        !pending.sameAs(snapshot)) {
      // 未送达的旧提交之后快照已变化（改文案 / 重拍换图 / 移除截图 / 增删日志）：
      // 同 key 不同字节违反服务契约 → 换新 key 提交新快照。
      _idempotencyKey = null;
    }
    _idempotencyKey ??= generateFeedbackIdempotencyKey();
    _pendingSubmit = snapshot;
    setState(() {
      _busy = true;
      _composeError = null;
    });
    try {
      final FeedbackSubmitResult result = await _api.submitFeedback(
        idempotencyKey: _idempotencyKey!,
        text: text,
        captureInfo: _captureInfo,
        // 能力降级（capabilities.images 缺失）：单图旧字段兼容路径；
        // 多图一律走 v12 images 有序列表（截图也是其中一项）。
        screenshotBytes: _singleImageMode
            ? (snapshot.images.isEmpty ? null : snapshot.images.first.bytes)
            : null,
        images: _singleImageMode || snapshot.images.isEmpty
            ? null
            : snapshot.images,
        logs: snapshot.logs.isEmpty ? null : snapshot.logs,
      );
      // T7：身份切换后到达的旧提交结果丢弃——不进入任务态、不清新草稿、
      // 不启动轮询（该提交可能已被旧服务器接收，由用户在新服务上自行重发）。
      if (!mounted || idSeq != _identitySeq) return;
      // 成功接收后才清空草稿与图片；保留 _lastSubmittedText 供失败重试。
      _lastSubmittedText = text;
      _draft.clear();
      _images.clear();
      _captureInfo = null;
      _undrawableNotice = false;
      _logs = <FeedbackLogFile>[];
      _logsCollected = false;
      _pendingSubmit = null;
      // 提交已扣次：使此前的额度查询失效，旧查询不得把剩余次数加回。
      _invalidateQuotaRefresh();
      setState(() {
        _busy = false;
        _ticketId = result.feedbackId;
        _idempotencyKey = null;
        _kaneoUrl = null;
        _errorSummary = null;
        _failedNotice = null;
        _quota = result.quota ?? _quota;
        _user = result.user ?? _user;
        _stage = _stageForStatus(result.status);
        // T4：等待管理员配置/确认/归档同样是「已保存」——明确提示等待什么，
        // 不启动轮询（只有真正在处理中才继续跟踪）。
        _waitingNotice = collectionWaitingText(result.collectionState);
      });
      _consumeQuotaRefreshIntent(); // 提交忙碌结束：补发被挡下的刷新
      if (_waitingNotice == null) _schedulePollingIfNeeded();
    } on ApiException catch (e) {
      if (!mounted || idSeq != _identitySeq) return;
      if (e.statusCode == 401) {
        // 当前世代 401 已由 onUnauthorized 回登录视图；期间换了新登录的
        // 过期请求不触发回调——这里只退出提交忙碌态，不改写登录界面。
        // 草稿与冻结快照保留（重新提交仍同 key 同字节）。
        if (mounted) setState(() => _busy = false);
        return;
      }
      if (e.code == 'daily_quota_exceeded') {
        // 明确「未接收」：不套用「服务端已收到」语义，草稿保留待额度刷新后重试。
        // 额度错误带回权威额度：使此前的额度查询失效，避免旧查询覆盖。
        _invalidateQuotaRefresh();
        setState(() {
          _busy = false;
          _quota = e.quota ?? _quota;
          _stage = FeedbackStage.compose;
          _composeError = '今日提交次数已用完，请在额度刷新后重试。您的输入已保留';
        });
        _consumeQuotaRefreshIntent();
        return;
      }
      if (e.code == 'idempotency_conflict') {
        // 契约：同 key 不同内容。提示已提交并按重放处理（不再轮询）。
        setState(() {
          _busy = false;
          _idempotencyKey = null;
          _pendingSubmit = null;
          _stage = FeedbackStage.replay;
        });
        return;
      }
      // 服务端有响应（非网络异常）：请求确实到达服务端，回到普通撰写视图，
      // 冻结快照保留（未变则重试仍复用同一 key）。
      setState(() {
        _busy = false;
        _quota = e.quota ?? _quota;
        _stage = FeedbackStage.compose;
        _composeError = _friendlyApiError(e);
      });
      _consumeQuotaRefreshIntent();
    } catch (_) {
      if (!mounted || idSeq != _identitySeq) return;
      setState(() {
        _busy = false;
        // Class A：服务端从未收到该请求（未拿到任何 HTTP 响应）。进入
        // notSent：保留冻结快照与幂等键，重试即"同 key 同字节"重发；
        // 草稿仍可编辑（编辑 / 换图后自动换新 key）。
        _stage = FeedbackStage.notSent;
        _composeError = '网络异常，提交失败。您的输入已保留，请重试';
      });
    }
  }

  /// Class B 刷新：重新查询原反馈记录（`GET /api/feedback/:id`）并更新
  /// 状态 / 错误摘要 / 归档链接。
  ///
  /// 服务端**已接收**该反馈（保留 [_ticketId]），此路径绝不重新 POST
  /// ——重发只会产生重复工单。
  Future<void> _refreshTicketStatus() async {
    final String? id = _ticketId;
    if (id == null || _busy || !_serverPrefsReady) return;
    final int idSeq = _identitySeq;
    setState(() {
      _busy = true;
      _failedNotice = null;
    });
    FeedbackRecord? record;
    String? failure;
    try {
      record = await _api.fetchFeedback(id);
    } on ApiException catch (e) {
      if (e.statusCode == 401) {
        if (mounted) setState(() => _busy = false); // 已回登录视图。
        return;
      }
      failure = _friendlyApiError(e);
    } catch (_) {
      failure = '网络异常，无法刷新状态，请稍后重试';
    }
    if (!mounted || idSeq != _identitySeq) return;
    if (record == null) {
      setState(() {
        _busy = false;
        _failedNotice = '刷新失败：$failure';
      });
      return;
    }
    final FeedbackRecord rec = record;
    final FeedbackStage stage = _stageForStatus(rec.status);
    setState(() {
      _busy = false;
      _stage = stage;
      _kaneoUrl = rec.kaneoUrl;
      _errorSummary = rec.errorSummary;
      // T4：等待态刷新后仍等待 → 保持等待提示并停止轮询。
      _waitingNotice = collectionWaitingText(rec.collectionState);
    });
    // 记录回到可轮询状态（received/processing/archiving）时恢复轮询；
    // 处于等待管理员操作的状态时不轮询，保留手动刷新。
    if (_waitingNotice != null) {
      _pollTimer?.cancel();
      _pollTimer = null;
    } else if (_isPollable(stage)) {
      _schedulePollingIfNeeded();
    }
  }

  /// Class B 复制反馈 ID：失败也不抛出（剪贴板不可用时给出可读提示）。
  Future<void> _copyTicketId() async {
    final String? id = _ticketId;
    if (id == null) return;
    bool copied = true;
    try {
      await Clipboard.setData(ClipboardData(text: id));
    } catch (_) {
      copied = false; // 剪贴板不可用：静默降级，不影响面板。
    }
    if (!mounted) return;
    setState(() {
      _failedNotice = copied ? '反馈 ID 已复制到剪贴板' : '剪贴板不可用，请手动记录反馈 ID：$id';
    });
  }

  /// 回到撰写视图。
  ///
  /// [restoreDraft] 为 true 时用于 Class B「返回编辑」：恢复上次提交的原话并
  /// 清除原 feedbackId 与幂等键——之后用户主动提交的是**全新反馈**（新 key），
  /// 而不是重发已被服务端接收的旧工单（旧截图不随还原，避免误以为在改旧单）。
  void _backToCompose({bool restoreDraft = false}) {
    if (restoreDraft && _draft.text.isEmpty && _lastSubmittedText != null) {
      _draft.text = _lastSubmittedText!;
    }
    if (!restoreDraft) {
      _images.clear();
      _captureInfo = null;
      _undrawableNotice = false;
    }
    setState(() {
      _stage = FeedbackStage.compose;
      _ticketId = null;
      _kaneoUrl = null;
      _errorSummary = null;
      _composeError = null;
      _failedNotice = null;
      _waitingNotice = null;
    });
    if (restoreDraft) {
      _lastSubmittedText = null;
      _idempotencyKey = null;
      _pendingSubmit = null;
    }
    _pollTimer?.cancel();
    _focusFirstField();
  }

  // ---------------------------------------------------------------- 轮询

  FeedbackStage _stageForStatus(String status) {
    switch (status) {
      case 'processing':
      case 'archiving':
        return FeedbackStage.processing;
      case 'archived':
        return FeedbackStage.archived;
      case 'failed':
      case 'needs_review':
        return FeedbackStage.failed;
      case 'received':
      default:
        return FeedbackStage.accepted;
    }
  }

  bool _isPollable(FeedbackStage stage) =>
      stage == FeedbackStage.accepted || stage == FeedbackStage.processing;

  void _schedulePollingIfNeeded() {
    _pollTimer?.cancel();
    if (!_isPollable(_stage) || _ticketId == null) return;
    _pollDelay = const Duration(seconds: 2); // 退避起点 2s。
    _pollTimer = Timer(_pollDelay, _pollOnce);
  }

  Future<void> _pollOnce() async {
    final String? id = _ticketId;
    if (id == null || !mounted || _pollInFlight || !_serverPrefsReady) return;
    final int idSeq = _identitySeq;
    _pollInFlight = true;
    FeedbackRecord? record;
    try {
      record = await _api.fetchFeedback(id);
    } on ApiException catch (e) {
      if (e.statusCode == 401) {
        _pollInFlight = false;
        return; // 已回登录视图。
      }
      // 其它错误（如 404/5xx）：保持退避重试。
    } catch (_) {
      // 网络抖动：保持退避重试。
    }
    _pollInFlight = false;
    if (!mounted || _ticketId != id || idSeq != _identitySeq) return;
    if (record != null) {
      final FeedbackRecord rec = record;
      final FeedbackStage stage = _stageForStatus(rec.status);
      setState(() {
        _stage = stage;
        _kaneoUrl = rec.kaneoUrl;
        _errorSummary = rec.errorSummary;
        // T4：等待管理员操作的记录不再轮询（已保存 ≠ 处理中）。
        _waitingNotice = collectionWaitingText(rec.collectionState);
      });
      if (_waitingNotice != null || !_isPollable(stage)) {
        _pollTimer = null;
        if (stage == FeedbackStage.archived) _lastSubmittedText = null;
        return;
      }
    }
    // 指数式线性退避：2s → 3s → 4s → 5s 封顶。
    _pollDelay = Duration(
      milliseconds: (_pollDelay.inMilliseconds + 1000).clamp(2000, 5000),
    );
    _pollTimer = Timer(_pollDelay, _pollOnce);
  }

  // ---------------------------------------------------------------- 归档链接

  Future<void> _openKaneoUrl() async {
    final String? url = _kaneoUrl;
    if (url == null) return;
    bool launched = false;
    try {
      final Uri? uri = Uri.tryParse(url);
      if (uri != null && uri.hasScheme) {
        launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      launched = false;
    }
    if (!launched) {
      try {
        await Clipboard.setData(ClipboardData(text: url));
      } catch (_) {
        // 剪贴板不可用时静默降级。
      }
    }
    if (!mounted) return;
    _showToast(launched ? '正在打开归档链接…' : '链接已复制到剪贴板');
  }

  // ---------------------------------------------------------------- 文案

  String _friendlyApiError(ApiException e) {
    switch (e.code) {
      case 'invalid_credentials':
        return '用户名或密码错误';
      case 'rate_limited':
        return '尝试过于频繁，请稍后再试';
      case 'invalid_request':
        return e.message ?? '请求无效，请检查输入内容';
      case 'unknown_app':
        return '应用未在服务器登记（appId 无效）';
      case 'origin_not_allowed':
        return '当前来源未被该应用允许登录，请联系管理员';
      case 'daily_quota_exceeded':
        return '今日提交次数已用完，请在额度刷新后重试。您的输入已保留';
      case 'too_large':
        return '内容超出大小限制';
      case 'not_found':
        return '未找到该反馈记录';
      case 'cancellation_failed':
        return '自动撤销 Kaneo 任务失败，请稍后重试';
      default:
        return e.message ?? '服务返回错误（${e.statusCode}）';
    }
  }

  // ---------------------------------------------------------------- 历史与工单沟通

  void _cancelSummaryTimer() {
    _summaryTimer?.cancel();
    _summaryTimer = null;
  }

  void _startSummaryPolling() {
    _cancelSummaryTimer();
    if (!mounted || !_signedIn || !_panelVisible || !_foreground) return;
    if (_panelTab == _PanelTab.compose &&
        (_stage == FeedbackStage.accepted ||
            _stage == FeedbackStage.processing)) {
      return;
    }
    _summaryTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      unawaited(_fetchSummary());
    });
  }

  Future<void> _fetchSummary() async {
    if (!mounted || !_signedIn || !_serverPrefsReady) return;
    final int session = _trackingSession;
    final ApiClient api = _api;
    try {
      final UnreadSummaryResponse res =
          await api.fetchUnreadSummary(appId: widget.config.appId);
      if (!_trackingValid(session, api)) return;
      if (_unreadCount != res.totalUnreadMessages) {
        setState(() {
          _unreadCount = res.totalUnreadMessages;
        });
        widget.onUnreadCountChange?.call(_unreadCount);
      }
    } catch (_) {}
  }

  void _cancelDialogueTimer() {
    _dialogueTimer?.cancel();
    _dialogueTimer = null;
  }

  void _startDialoguePolling() {
    _cancelDialogueTimer();
    if (!mounted ||
        !_signedIn ||
        !_panelVisible ||
        !_foreground ||
        _selectedDialogueId == null) {
      return;
    }
    _dialogueTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_selectedDialogueId != null) {
        unawaited(_loadDialogue(_selectedDialogueId!, silent: true));
      }
    });
  }

  void _switchTab(_PanelTab tab) {
    if (_panelTab == tab && _selectedDialogueId == null) return;
    _saveReplyDraft();
    ++_dialogueVisit;
    ++_dialogueRequest;
    _replyFocus.unfocus();
    setState(() {
      _panelTab = tab;
      _selectedDialogueId = null;
      _dialogueData = null;
      _dialogueError = null;
    });
    _cancelDialogueTimer();
    if (tab == _PanelTab.history && _signedIn) {
      unawaited(_loadHistoryList());
    }
    _startSummaryPolling();
  }

  /// v12：历史列表加载（分页 + 状态筛选）。`reset` 为 true 时回到第 1 页。
  Future<void> _loadHistoryList({bool reset = false, int? page}) async {
    if (!mounted || !_signedIn || !_serverPrefsReady) return;
    final int targetPage = reset ? 1 : (page ?? _historyPage);
    final int session = _trackingSession;
    final int request = ++_historyRequest;
    final ApiClient api = _api;
    bool valid() => _trackingValid(session, api) && request == _historyRequest;
    setState(() {
      _historyLoading = true;
      _historyError = null;
    });
    try {
      final UserFeedbackListResponse res = await api.fetchMyFeedbacks(
        appId: widget.config.appId,
        page: targetPage,
        limit: _historyLimit,
        issueStatus: _historyFilter?.toWire(),
      );
      if (!valid()) return;
      setState(() {
        _myFeedbacks = res.items;
        _historyPage = res.page;
        _historyTotal = res.total;
        _historyLoading = false;
        _unreadCount = res.unreadTotal;
      });
      widget.onUnreadCountChange?.call(_unreadCount);
    } on ApiException catch (e) {
      if (!valid()) return;
      setState(() {
        _historyLoading = false;
        _historyError = _friendlyApiError(e);
      });
    } catch (_) {
      if (!valid()) return;
      setState(() {
        _historyLoading = false;
        _historyError = '加载历史反馈失败，请检查网络';
      });
    }
  }

  /// 切换状态筛选（v12）：回到第 1 页重新加载。
  void _setHistoryFilter(IssueStatus? status) {
    if (_historyFilter == status) return;
    setState(() {
      _historyFilter = status;
      _historyPage = 1;
      _myFeedbacks = <UserFeedbackListItem>[];
    });
    unawaited(_loadHistoryList(reset: true));
  }

  /// 翻页（v12）：服务端分页，上一页 / 下一页。
  void _loadHistoryPage(int delta) {
    final int next = _historyPage + delta;
    final int maxPage = _historyTotal <= 0
        ? 1
        : ((_historyTotal + _historyLimit - 1) ~/ _historyLimit);
    if (next < 1 || next > maxPage || _historyLoading) return;
    unawaited(_loadHistoryList(page: next));
  }

  void _openDialogue(String feedbackId) {
    _saveReplyDraft();
    ++_dialogueVisit;
    ++_dialogueRequest;
    final _ReplyDraft? draft = _replyDrafts[feedbackId];
    _replyFocus.unfocus();
    setState(() {
      _panelTab = _PanelTab.history;
      _selectedDialogueId = feedbackId;
      _dialogueLoading = true;
      _dialogueError = null;
      _dialogueData = null;
      _replyController.text = draft?.text ?? '';
      _replyImages
        ..clear()
        ..addAll(draft?.images ?? <FeedbackImageFile>[]);
      _replyLogs
        ..clear()
        ..addAll(draft?.logs ?? <FeedbackLogFile>[]);
      _replySending = _sendingReplies.contains(feedbackId);
      _replyError = draft?.error;
    });
    _cancelSummaryTimer();
    unawaited(_loadDialogue(feedbackId));
    _startDialoguePolling();
  }

  void _closeDialogue() {
    _saveReplyDraft();
    ++_dialogueVisit;
    ++_dialogueRequest;
    _replyFocus.unfocus();
    _cancelDialogueTimer();
    setState(() {
      _selectedDialogueId = null;
      _dialogueData = null;
      _dialogueError = null;
      _replyController.clear();
      _replyImages.clear();
      _replyLogs.clear();
      _replySending = false;
      _replyError = null;
    });
    _startSummaryPolling();
    unawaited(_loadHistoryList());
  }

  Future<void> _loadDialogue(String feedbackId,
      {bool silent = false, bool force = false}) async {
    if (!mounted || !_signedIn || !_serverPrefsReady) return;
    if (silent &&
        !force &&
        _dialogueFlight != null &&
        _dialogueFlightVisit == _dialogueVisit) {
      return;
    }
    final int session = _trackingSession;
    final int visit = _dialogueVisit;
    final int request = ++_dialogueRequest;
    _dialogueFlight = request;
    _dialogueFlightVisit = visit;
    final ApiClient api = _api;
    bool valid() =>
        _trackingValid(session, api) &&
        visit == _dialogueVisit &&
        request == _dialogueRequest &&
        _selectedDialogueId == feedbackId;
    if (!silent) {
      setState(() {
        _dialogueLoading = true;
        _dialogueError = null;
      });
    }
    try {
      final FeedbackDialogueResponse res =
          await api.fetchFeedbackDialogue(feedbackId);
      if (!valid()) return;
      // v12 草稿保护：轮询刷新只更新数据，绝不清回复草稿、不强制跳滚动——
      // 仅当用户本已在底部时才跟随新消息滚到底。
      final bool firstLoad = _dialogueData == null;
      final double? savedOffset = _replyDrafts[feedbackId]?.offset;
      final bool wasAtBottom = !firstLoad &&
          (!_dialogueScroll.hasClients ||
              _dialogueScroll.position.pixels >=
                  _dialogueScroll.position.maxScrollExtent - 48);
      setState(() {
        _dialogueData = res;
        _dialogueLoading = false;
        _dialogueError = null;
      });
      if ((firstLoad || wasAtBottom) && !_replyFocus.hasFocus) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!valid() || !_dialogueScroll.hasClients) return;
          final double target = firstLoad
              ? (savedOffset ?? 0)
              : _dialogueScroll.position.maxScrollExtent;
          _dialogueScroll.jumpTo(
              target.clamp(0, _dialogueScroll.position.maxScrollExtent));
        });
      }

      int maxSeq = res.lastReadSeq;
      for (final FeedbackMessageItem msg in res.messages) {
        if (msg.seq > maxSeq) {
          maxSeq = msg.seq;
        }
      }
      if (maxSeq > res.lastReadSeq) {
        unawaited(api.markFeedbackRead(feedbackId, maxSeq).then((_) {
          if (_trackingValid(session, api)) unawaited(_fetchSummary());
        }).catchError((Object _) {}));
      }
    } on ApiException catch (e) {
      if (!valid()) return;
      if (!silent) {
        setState(() {
          _dialogueLoading = false;
          _dialogueError = _friendlyApiError(e);
        });
      }
    } catch (_) {
      if (!valid()) return;
      if (!silent) {
        setState(() {
          _dialogueLoading = false;
          _dialogueError = '加载对话失败，请检查网络';
        });
      }
    } finally {
      if (_dialogueFlight == request) {
        _dialogueFlight = null;
        _dialogueFlightVisit = null;
      }
    }
  }

  Future<void> _sendReply() async {
    final String text = _replyController.text.trim();
    final String? feedbackId = _selectedDialogueId;
    final List<FeedbackImageFile> images =
        List<FeedbackImageFile>.from(_replyImages);
    final List<FeedbackLogFile> logs = List<FeedbackLogFile>.from(_replyLogs);
    if (!_signedIn ||
        feedbackId == null ||
        _replySending ||
        _sendingReplies.contains(feedbackId) ||
        (text.isEmpty && images.isEmpty && logs.isEmpty)) {
      return;
    }
    final int session = _trackingSession;
    final ApiClient api = _api;
    final int visit = _dialogueVisit;
    bool selected() =>
        _trackingValid(session, api) &&
        visit == _dialogueVisit &&
        _selectedDialogueId == feedbackId;
    // 在能力探测之前锁定发送，避免连续点击产生多个请求。
    _sendingReplies.add(feedbackId);
    setState(() {
      _replySending = true;
      _replyError = null;
    });
    _saveReplyDraft();
    String? error;
    try {
      if (images.isNotEmpty && !_capabilitiesLoaded) {
        await _refreshCapabilities();
        if (!_trackingValid(session, api)) return;
      }
      final bool singleMode = _singleImageMode;
      await api.sendFeedbackReply(
        feedbackId,
        text: text,
        screenshotBytes:
            singleMode && images.isNotEmpty ? images.first.bytes : null,
        images: singleMode || images.isEmpty ? null : images,
        logs: logs.isEmpty ? null : logs,
      );
      if (!_trackingValid(session, api)) return;
      _replyDrafts.remove(feedbackId);
      if (_selectedDialogueId == feedbackId) {
        _replyController.clear();
        setState(() {
          _replyImages.clear();
          _replyLogs.clear();
          _replyError = null;
        });
        unawaited(_loadDialogue(feedbackId, silent: true, force: true));
      }
      unawaited(_fetchSummary());
    } on ApiException catch (e) {
      error = _friendlyApiError(e);
    } catch (_) {
      error = '发送回复失败，请稍后重试';
    } finally {
      if (_trackingValid(session, api)) {
        _sendingReplies.remove(feedbackId);
        if (error != null) {
          final _ReplyDraft? draft = _replyDrafts[feedbackId];
          _replyDrafts[feedbackId] = _ReplyDraft(
            draft?.text ?? text,
            draft?.images ?? images,
            draft?.logs ?? logs,
            draft?.offset ?? 0,
            error,
          );
        }
        if (_selectedDialogueId == feedbackId) {
          setState(() {
            _replySending = false;
            _replyError = error;
          });
        }
        if (error != null && selected()) _showToast(error);
      }
    }
  }

  /// 面板内轻提示：优先宿主 ScaffoldMessenger；MaterialApp 外侧挂载时
  /// 无 ScaffoldMessenger 祖先，退回 Overlay 内联提示条（不依赖 Navigator）。
  void _showToast(String message) {
    final ScaffoldMessengerState? messenger =
        ScaffoldMessenger.maybeOf(context);
    if (messenger != null) {
      messenger.showSnackBar(SnackBar(content: Text(message)));
      return;
    }
    final OverlayState? overlay = Overlay.maybeOf(context);
    if (overlay == null) return;
    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (BuildContext ctx) => Positioned(
        bottom: 24,
        left: 24,
        right: 24,
        child: Material(
          color: Colors.transparent,
          child: Container(
            key: const Key('feedback-toast'),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0xE01F1F1F),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(message,
                style: const TextStyle(color: Colors.white, fontSize: 13)),
          ),
        ),
      ),
    );
    overlay.insert(entry);
    Timer(const Duration(seconds: 3), () {
      if (entry.mounted) entry.remove();
    });
  }

  /// 面板内对话框：优先 `showDialog`（有 Navigator 祖先，如应用内挂载）；
  /// MaterialApp 外侧挂载时回退为祖先 Overlay 上的 OverlayEntry——
  /// 覆盖全组件区域而非面板宽度，且不依赖 Navigator。
  ///
  /// [builder] 收到的 [close] 统一关闭对话框（路由 pop 或移除 entry），
  /// 调用方不得再用 `Navigator.pop`（Overlay 路径没有路由可弹）。
  Future<T?> _showPanelDialog<T>({
    required Widget Function(
            BuildContext context, void Function([T? result]) close)
        builder,
    bool barrierDismissible = true,
  }) {
    if (Navigator.maybeOf(context) != null) {
      return showDialog<T>(
        context: context,
        barrierDismissible: barrierDismissible,
        builder: (BuildContext ctx) =>
            builder(ctx, ([T? result]) => Navigator.of(ctx).pop(result)),
      );
    }
    final OverlayState? overlay = Overlay.maybeOf(context);
    if (overlay == null) {
      return Future<T?>.value();
    }
    final Completer<T?> completer = Completer<T?>();
    late OverlayEntry entry;
    void close([T? result]) {
      if (!completer.isCompleted) completer.complete(result);
      if (entry.mounted) entry.remove();
    }

    entry = OverlayEntry(
      builder: (BuildContext ctx) => Stack(
        children: <Widget>[
          Positioned.fill(
            child: GestureDetector(
              onTap: barrierDismissible ? () => close() : null,
              child: const ColoredBox(color: Colors.black54),
            ),
          ),
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560, maxHeight: 640),
              child: Material(
                type: MaterialType.transparency,
                child: builder(ctx, close),
              ),
            ),
          ),
        ],
      ),
    );
    overlay.insert(entry);
    return completer.future;
  }

  Future<void> _pickReplyLog() async {
    final int session = _trackingSession;
    final int visit = _dialogueVisit;
    final ApiClient api = _api;
    if (_replyLogs.length >= kFeedbackMaxLogFiles) {
      _showToast('最多附加 3 个日志文件');
      return;
    }
    try {
      final FeedbackFilePicker picker =
          widget.filePicker ?? widget.config.filePicker ?? _defaultFilePicker;
      final List<FeedbackLogFile>? files = await picker();
      if (!_trackingValid(session, api) ||
          visit != _dialogueVisit ||
          _replySending ||
          files == null ||
          files.isEmpty) {
        return;
      }
      setState(() {
        for (final FeedbackLogFile file in files) {
          if (_replyLogs.length >= kFeedbackMaxLogFiles) break;
          final String ext = _getLogExtension(file.filename);
          if (kFeedbackAllowedLogExtensions.contains(ext) &&
              file.bytes.length <= kFeedbackMaxLogBytes) {
            _replyLogs.add(file);
          }
        }
      });
    } catch (_) {}
  }

  // ---------------------------------------------------------------- 图片附件（v12）

  /// 调用当前生效的图片选择器（widget > config > file_selector 默认）；
  /// 默认实现支持 [onError] 回传部分失败原因。
  Future<List<FeedbackImageFile>?> _invokeImagePicker({
    void Function(String)? onError,
  }) {
    final FeedbackImagePicker? custom =
        widget.imagePicker ?? widget.config.imagePicker;
    if (custom != null) {
      return Future<List<FeedbackImageFile>?>.value(custom());
    }
    return defaultFeedbackImagePicker(onError: onError);
  }

  /// 选择并追加图片到 [target] 列表（撰写 / 回复共用）。
  ///
  /// 单图模式（旧服务无 capabilities.images）只允许 1 张并提示升级；
  /// 超限 / 读取失败提示且**保留草稿与已有图片**。
  Future<void> _pickImagesInto(
    List<FeedbackImageFile> target, {
    int? maxCount,
  }) async {
    final int identity = _identitySeq;
    final int session = _trackingSession;
    final int visit = _dialogueVisit;
    final bool reply = identical(target, _replyImages);
    bool valid() =>
        mounted &&
        identity == _identitySeq &&
        (!reply ||
            (session == _trackingSession &&
                visit == _dialogueVisit &&
                !_replySending));
    // 首次加图前若能力未知，先探测一次（确定多图上限与是否单图模式）。
    if (!_capabilitiesLoaded) {
      await _refreshCapabilities();
      if (!valid()) return;
    }
    final int limit = maxCount ?? _maxImages;
    final int remaining = limit - target.length;
    if (remaining <= 0) {
      _showToast('最多附加 $limit 张图片');
      return;
    }
    if (_singleImageMode && target.isNotEmpty) {
      _showToast('当前服务仅支持单图附件，升级服务端以支持多图');
      return;
    }
    try {
      String? pickerNote;
      final List<FeedbackImageFile>? picked =
          await _invokeImagePicker(onError: (String m) => pickerNote = m);
      if (!valid() || picked == null || picked.isEmpty) return;
      setState(() {
        int added = 0;
        for (final FeedbackImageFile img in picked) {
          if (target.length >= limit) break;
          target.add(img);
          added++;
        }
        if (added < picked.length) {
          _showToast('最多附加 $limit 张图片，多余的已忽略');
        }
      });
      if (pickerNote != null) _showToast(pickerNote!);
    } on FeedbackImageException catch (e) {
      if (!valid()) return;
      _showToast(e.message);
    } catch (_) {
      if (!valid()) return;
      _showToast('选择图片失败');
    }
  }

  /// 编辑图片（裁剪/矩形/遮挡/撤销）：保存后**替换原槽位**（id 复用，
  /// source 标记 edited），不新增名额；取消不改动。
  Future<void> _editImage(List<FeedbackImageFile> list, int index) async {
    if (index < 0 || index >= list.length) return;
    final FeedbackImageFile original = list[index];
    final int identity = _identitySeq;
    final int session = _trackingSession;
    final int visit = _dialogueVisit;
    final bool reply = identical(list, _replyImages);
    Uint8List? result;
    final NavigatorState? nav = Navigator.maybeOf(context);
    if (nav != null) {
      result = await FeedbackImageEditor.open(
        context,
        bytes: original.bytes,
        filename: original.filename,
      );
    } else {
      final OverlayState? overlay = Overlay.maybeOf(context);
      if (overlay == null) return;
      final Completer<Uint8List?> completer = Completer<Uint8List?>();
      FeedbackImageEditor.openAsOverlay(
        overlay,
        bytes: original.bytes,
        filename: original.filename,
        onDone: completer.complete,
      );
      result = await completer.future;
    }
    if (!mounted ||
        identity != _identitySeq ||
        result == null ||
        (reply &&
            (session != _trackingSession ||
                visit != _dialogueVisit ||
                _replySending)) ||
        index >= list.length ||
        !identical(list[index], original)) {
      return;
    } // 取消 / 渲染失败：原图保留
    setState(() {
      list[index] = original.copyWith(
        bytes: result,
        mime: 'image/png',
        filename: normalizeImageFilename(original.filename, 'image/png'),
        source: 'edited',
      );
    });
  }

  /// 图片放大预览（用面板对话框包装，兼容无 Navigator 的挂载）。
  void _openImageZoom(BuildContext context, FeedbackImageFile image) {
    unawaited(_showPanelDialog<void>(
      builder: (BuildContext ctx, void Function([void]) close) {
        return Dialog(
          backgroundColor: Colors.transparent,
          insetPadding: const EdgeInsets.all(16),
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              InteractiveViewer(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.memory(image.bytes),
                ),
              ),
              Positioned(
                top: 8,
                right: 8,
                child: IconButton(
                  key: const Key('feedback-zoom-close'),
                  style: IconButton.styleFrom(backgroundColor: Colors.black54),
                  icon: const Icon(Icons.close, color: Colors.white),
                  onPressed: () => close(),
                ),
              ),
            ],
          ),
        );
      },
    ));
  }

  /// v12：本人反馈的日志附件经 Bearer 下载后内联预览（不阻塞文本渲染）。
  Future<void> _openRemoteLogPreview(
    String feedbackId,
    FeedbackLogAttachmentView log,
  ) async {
    _showToast('正在下载日志…');
    try {
      final Uint8List bytes = await _api.fetchFeedbackLog(feedbackId, log.id);
      if (!mounted) return;
      final String text = utf8.decode(bytes, allowMalformed: true);
      unawaited(_showPanelDialog<void>(
        builder: (BuildContext ctx, void Function([void]) close) {
          return AlertDialog(
            key: const Key('feedback-log-preview-dialog'),
            title: Text(
              log.filename,
              key: const Key('feedback-log-preview-title'),
              style: const TextStyle(fontSize: 16),
            ),
            content: SizedBox(
              width: double.maxFinite,
              child: SingleChildScrollView(
                child: SelectableText(
                  text,
                  key: const Key('feedback-log-preview-body'),
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                  ),
                ),
              ),
            ),
            actions: <Widget>[
              TextButton(
                key: const Key('feedback-log-preview-close'),
                onPressed: () => close(),
                child: const Text('关闭'),
              ),
            ],
          );
        },
      ));
    } catch (_) {
      if (!mounted) return;
      _showToast('日志下载失败，请稍后重试');
    }
  }

  /// 消息中的非图片附件（日志）：Bearer 下载后预览。
  Future<void> _openRemoteAttachment(FeedbackMessageAttachment att) async {
    _showToast('正在下载附件…');
    try {
      final Uint8List bytes = await _api.fetchMessageAttachment(att.id);
      if (!mounted) return;
      final String text = utf8.decode(bytes, allowMalformed: true);
      unawaited(_showPanelDialog<void>(
        builder: (BuildContext ctx, void Function([void]) close) {
          return AlertDialog(
            key: const Key('feedback-attachment-preview-dialog'),
            title: Text(att.filename, style: const TextStyle(fontSize: 16)),
            content: SizedBox(
              width: double.maxFinite,
              child: SingleChildScrollView(
                child: SelectableText(
                  text,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                  ),
                ),
              ),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => close(),
                child: const Text('关闭'),
              ),
            ],
          );
        },
      ));
    } catch (_) {
      if (!mounted) return;
      _showToast('附件下载失败，请稍后重试');
    }
  }

  String _formatTime(DateTime dt) {
    final DateTime local = dt.toLocal();
    final String month = local.month.toString().padLeft(2, '0');
    final String day = local.day.toString().padLeft(2, '0');
    final String hour = local.hour.toString().padLeft(2, '0');
    final String minute = local.minute.toString().padLeft(2, '0');
    return '$month-$day $hour:$minute';
  }

  // ---------------------------------------------------------------- 服务器设置（T6/T7）

  /// 规范化后的宿主默认地址（比较用；config 本身只做去空白/斜杠）。
  String get _defaultBaseNorm =>
      normalizeServerBase(widget.config.apiBase).base ?? widget.config.apiBase;

  /// 规范化后的当前有效地址。
  String get _effectiveBaseNorm =>
      normalizeServerBase(effectiveApiBase).base ?? effectiveApiBase;

  /// 地址变化时是否存在需要确认的内容：
  /// 草稿文本 / 截图 / 日志 / 在途或未确认的提交。
  bool get _needsSwitchConfirm =>
      _draft.text.trim().isNotEmpty ||
      _images.isNotEmpty ||
      _logs.isNotEmpty ||
      _ticketId != null ||
      _pendingSubmit != null ||
      _busy;

  /// 打开设置视图（未登录也可进入）。
  void _openSettings() {
    setState(() {
      _settingsOpen = true;
      _serverError = null;
      _serverHint = null;
      _serverInput.text = _serverOverride ?? '';
    });
  }

  /// 关闭设置视图返回主视图；不清除任何已保存状态。
  void _closeSettings() {
    _settingsOpSeq++;
    setState(() {
      _settingsOpen = false;
      _serverError = null;
      _serverHint = null;
      _settingsBusy = false;
    });
  }

  String _serverPrefKey() => serverOverrideStorageKey(
        appId: widget.config.appId,
        defaultApiBase: widget.config.apiBase,
      );

  bool _settingsOperationStillValid(
    int opSeq,
    int identitySeq,
    String prefKey,
  ) {
    return mounted &&
        opSeq == _settingsOpSeq &&
        identitySeq == _identitySeq &&
        prefKey == _serverPrefKey();
  }

  /// 持久化覆盖记录（value 为 null 时删除键 = 恢复默认）。
  /// 返回是否写入成功；失败时调用方仍应用本次会话并提示「仅本次生效」。
  Future<bool> _persistOverride(
    String? value,
    String key, {
    bool Function()? shouldWrite,
  }) async {
    final Future<void> previous = _prefWriteTails[key] ?? Future<void>.value();
    final Completer<void> current = Completer<void>();
    _prefWriteTails[key] = current.future;
    try {
      try {
        await previous;
      } catch (_) {
        // A failed older write must not block the newest value.
      }
      if (shouldWrite != null && !shouldWrite()) return false;
      if (value == null) {
        await _prefStore.delete(key);
      } else {
        await _prefStore.write(key, value);
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      current.complete();
      if (identical(_prefWriteTails[key], current.future)) {
        _prefWriteTails.remove(key);
      }
    }
  }

  /// 切换确认对话框：草稿 / 截图 / 日志会被清空；
  /// 存在结果未确认的提交时明确说明旧服务器可能已接收。
  Future<bool?> _confirmServerSwitch() {
    final bool uncertain =
        _busy || _pendingSubmit != null || _stage == FeedbackStage.notSent;
    return _showPanelDialog<bool>(
      builder: (BuildContext ctx, void Function([bool?]) close) => AlertDialog(
        key: const Key('feedback-server-confirm'),
        title: const Text('切换 Feedback 服务器？'),
        content: Text(
          '切换后将清空当前草稿、截图与日志，并在新服务器上重新登录。'
          '${uncertain ? '\n\n上一次提交的结果尚未确认，旧服务器可能已接收该反馈；切换不会撤回，也不会自动向新服务器重发。' : ''}',
        ),
        actions: <Widget>[
          TextButton(
            key: const Key('feedback-server-confirm-cancel'),
            onPressed: () => close(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('feedback-server-confirm-ok'),
            onPressed: () => close(true),
            child: const Text('清空并切换'),
          ),
        ],
      ),
    );
  }

  /// 保存按钮：校验 → 同址仅持久化 / 异址确认后完整切换。
  Future<void> _saveServerSetting() async {
    if (_settingsBusy) return;
    final ServerBaseNormalization norm = normalizeServerBase(
      _serverInput.text,
      pageIsHttps: kIsWeb && Uri.base.scheme == 'https',
    );
    if (!norm.ok) {
      setState(() {
        _serverError = norm.reason;
        _serverHint = null;
      });
      return;
    }
    final String target = norm.base!;
    // 输入等于默认地址时按「恢复默认」处理：删除覆盖而非保存同值覆盖。
    final String? newOverride = target == _defaultBaseNorm ? null : target;
    final int opSeq = ++_settingsOpSeq;
    final int identitySeq = _identitySeq;
    final String prefKey = _serverPrefKey();
    setState(() {
      _settingsBusy = true;
      _serverError = null;
      _serverHint = null;
    });
    try {
      if (target == _effectiveBaseNorm) {
        // 相同规范化地址：只持久化，不触发任何身份重置。
        final bool persisted = await _persistOverride(
          newOverride,
          prefKey,
          shouldWrite: () =>
              _settingsOperationStillValid(opSeq, identitySeq, prefKey),
        );
        if (!_settingsOperationStillValid(opSeq, identitySeq, prefKey)) return;
        setState(() {
          _serverHint = persisted ? '已保存' : '已应用（仅本次生效：本机偏好写入失败）';
        });
        unawaited(_probeServerHealth(persisted));
        return;
      }
      if (_needsSwitchConfirm) {
        final bool? ok = await _confirmServerSwitch();
        if (ok != true ||
            !_settingsOperationStillValid(opSeq, identitySeq, prefKey)) {
          return;
        }
      }
      await _applyServerOverride(
        newOverride,
        opSeq: opSeq,
        identitySeq: identitySeq,
        prefKey: prefKey,
      );
    } finally {
      if (_settingsOperationStillValid(opSeq, identitySeq, prefKey)) {
        setState(() => _settingsBusy = false);
      }
    }
  }

  /// 恢复默认：删除覆盖记录；当前未覆盖时直接提示。
  Future<void> _restoreDefaultServer() async {
    if (_settingsBusy) return;
    if (_serverOverride == null) {
      setState(() {
        _serverError = null;
        _serverHint = '当前已是默认地址';
      });
      return;
    }
    final int opSeq = ++_settingsOpSeq;
    final int identitySeq = _identitySeq;
    final String prefKey = _serverPrefKey();
    setState(() {
      _settingsBusy = true;
      _serverError = null;
      _serverHint = null;
    });
    try {
      if (_needsSwitchConfirm) {
        final bool? ok = await _confirmServerSwitch();
        if (ok != true ||
            !_settingsOperationStillValid(opSeq, identitySeq, prefKey)) {
          return;
        }
      }
      await _applyServerOverride(
        null,
        opSeq: opSeq,
        identitySeq: identitySeq,
        prefKey: prefKey,
      );
    } finally {
      if (_settingsOperationStillValid(opSeq, identitySeq, prefKey)) {
        setState(() => _settingsBusy = false);
      }
    }
  }

  /// 应用覆盖并完整重建服务身份（T7）：先持久化 → 作废旧身份全部状态 →
  /// 重建客户端 / 令牌仓库 → 恢复目标身份自身会话 → 探测连通性。
  /// 持久化失败不影响本次会话应用，仅追加「仅本次生效」提示。
  Future<void> _applyServerOverride(
    String? override, {
    required int opSeq,
    required int identitySeq,
    required String prefKey,
  }) async {
    final bool persisted = await _persistOverride(
      override,
      prefKey,
      shouldWrite: () =>
          _settingsOperationStillValid(opSeq, identitySeq, prefKey),
    );
    if (!_settingsOperationStillValid(opSeq, identitySeq, prefKey)) return;
    _beginIdentitySwitch();
    _serverOverride = override;
    _serverInput.text = override ?? '';
    _finishIdentitySwitch();
    setState(() {
      _serverHint = persisted ? '已保存' : '已应用（仅本次生效：本机偏好写入失败）';
    });
    unawaited(_probeServerHealth(persisted));
  }

  /// 探测当前有效服务的 `/healthz` 并追加连通性提示；不静默回切。
  Future<void> _probeServerHealth(bool persisted) async {
    final int idSeq = _identitySeq;
    final bool ok = await _api.probeHealth();
    if (!mounted || idSeq != _identitySeq || !_settingsOpen) return;
    final String prefix = persisted ? '已保存' : '已应用（仅本次生效）';
    setState(() {
      _serverHint = ok ? '$prefix，服务连接正常' : '$prefix，但暂时无法连接该服务（仍可稍后重试）';
    });
  }

  // ---------------------------------------------------------------- UI

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surface,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(context),
            const Divider(height: 1),
            Expanded(child: _buildBody(context)),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final bool inDialogue = _selectedDialogueId != null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Row(
        children: <Widget>[
          if (inDialogue) ...<Widget>[
            IconButton(
              key: const Key('feedback-dialogue-back'),
              tooltip: '返回反馈列表',
              onPressed: _closeDialogue,
              icon: const Icon(Icons.arrow_back),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                '反馈详情',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ] else ...<Widget>[
            const SizedBox(width: 8),
            Icon(Icons.feedback_outlined, color: scheme.primary),
            const SizedBox(width: 8),
            Expanded(
              child: Row(
                children: <Widget>[
                  TextButton(
                    key: const Key('tab-compose'),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      // 点击目标至少 48dp（冻结视觉规格）。
                      minimumSize: const Size(48, 48),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      foregroundColor: _panelTab == _PanelTab.compose
                          ? scheme.primary
                          : scheme.onSurfaceVariant,
                      textStyle: TextStyle(
                        fontWeight: _panelTab == _PanelTab.compose
                            ? FontWeight.bold
                            : FontWeight.normal,
                        fontSize: 15,
                      ),
                    ),
                    onPressed: () => _switchTab(_PanelTab.compose),
                    child: const Text('新建反馈'),
                  ),
                  const SizedBox(width: 4),
                  TextButton(
                    key: const Key('tab-history'),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(48, 48),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      foregroundColor: _panelTab == _PanelTab.history
                          ? scheme.primary
                          : scheme.onSurfaceVariant,
                      textStyle: TextStyle(
                        fontWeight: _panelTab == _PanelTab.history
                            ? FontWeight.bold
                            : FontWeight.normal,
                        fontSize: 15,
                      ),
                    ),
                    onPressed: () => _switchTab(_PanelTab.history),
                    child: _unreadCount > 0
                        ? Badge.count(
                            count: _unreadCount,
                            child: const Text('我的反馈'),
                          )
                        : const Text('我的反馈'),
                  ),
                ],
              ),
            ),
          ],
          // T6：服务器设置入口（未登录也可进入；设置视图自带返回）。
          IconButton(
            key: const Key('feedback-settings'),
            tooltip: '服务器设置',
            onPressed: _settingsOpen ? null : _openSettings,
            icon: const Icon(Icons.settings_outlined),
          ),
          IconButton(
            key: const Key('feedback-close'),
            tooltip: '关闭',
            onPressed: widget.onRequestClose,
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    // T6：设置视图独立于登录态（未登录也可进入）。
    if (_settingsOpen) return _buildSettingsView(context);
    // T6：覆盖偏好加载完成 + 会话恢复完成前不渲染可操作内容，
    // 保证不启动任何依赖服务器的请求。
    if (!_serverPrefsReady || !_authReady) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_selectedDialogueId != null) {
      return _buildDialogueView(context);
    }
    if (_panelTab == _PanelTab.history) {
      return _buildHistoryView(context);
    }
    // 未登录也可继续编辑：登录表单在撰写视图底部按需展开（不打开任何窗口）。
    if (!_signedIn) return _buildComposeView(context);
    if (_busy &&
        (_stage == FeedbackStage.compose || _stage == FeedbackStage.notSent)) {
      return _buildStatusNotice(
        title: '提交中…',
        icon: const SizedBox.square(
          dimension: 28,
          child: CircularProgressIndicator(strokeWidth: 3),
        ),
      );
    }
    switch (_stage) {
      case FeedbackStage.compose:
      case FeedbackStage.notSent:
        // Class A（未送达）与常规撰写共用撰写视图：草稿留在输入框内可继续
        // 编辑，提交按钮即"同 key 同字节"重试（快照变化则自动换新 key）。
        return _buildComposeView(context);
      case FeedbackStage.accepted:
        // T4：等待管理员配置/确认/归档时明确说明等待什么，并提供手动刷新；
        // 等待不是失败，也不是「正在处理」，因此不轮询。
        if (_waitingNotice != null) {
          return _buildStatusNotice(
            title: '已保存',
            subtitle: '$_waitingNotice\n无需重复提交；管理员处理后点「刷新状态」即可查看结果。',
            icon: _statusIcon(
                Icons.mark_email_read_outlined, Icons.check_circle_outline),
            extra: <Widget>[
              OutlinedButton.icon(
                key: const Key('feedback-refresh-status'),
                onPressed: _busy ? null : _refreshTicketStatus,
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(_busy ? '刷新中…' : '刷新状态'),
              ),
              FilledButton(
                key: const Key('feedback-continue'),
                onPressed: () => _backToCompose(),
                child: const Text('继续反馈'),
              ),
            ],
          );
        }
        return _buildStatusNotice(
          title: '已接收',
          subtitle: '您的反馈已保存，等待后台处理。稍后可在「我的反馈」查看进展和回复。',
          icon: _statusIcon(
              Icons.mark_email_read_outlined, Icons.check_circle_outline),
        );
      case FeedbackStage.processing:
        return _buildStatusNotice(
          title: '处理中',
          subtitle: '您的反馈已保存，正在后台整理。稍后可在「我的反馈」查看进展和回复。',
          icon: _statusIcon(Icons.autorenew, Icons.pending_outlined),
        );
      case FeedbackStage.archived:
        return _buildStatusNotice(
          title: '已归档',
          subtitle: '您的反馈已保存并记录到任务看板；归档不代表问题已解决。稍后可在「我的反馈」查看进展和回复。',
          icon: const Icon(Icons.check_circle_outline, size: 40),
          extra: <Widget>[
            if (_kaneoUrl != null)
              OutlinedButton.icon(
                key: const Key('feedback-open-url'),
                onPressed: _openKaneoUrl,
                icon: const Icon(Icons.open_in_new, size: 18),
                label: const Text('查看归档'),
              ),
            FilledButton(
              key: const Key('feedback-continue'),
              onPressed: () => _backToCompose(),
              child: const Text('继续反馈'),
            ),
          ],
        );
      case FeedbackStage.failed:
        return _buildFailedView(context);
      case FeedbackStage.replay:
        return _buildStatusNotice(
          title: '该反馈已提交',
          subtitle: '服务器识别为重复工单，已按原反馈处理，无需重复提交。',
          icon: const Icon(Icons.info_outline, size: 40),
          extra: <Widget>[
            FilledButton(
              key: const Key('feedback-continue'),
              onPressed: () => _backToCompose(),
              child: const Text('继续反馈'),
            ),
          ],
        );
    }
  }

  /// T6：服务器设置视图——地址输入 / 保存 / 恢复默认 / 当前有效地址 /
  /// 连通性提示；覆盖仅保存于本机，不回写宿主默认配置。
  Widget _buildSettingsView(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SingleChildScrollView(
      key: const Key('feedback-settings-view'),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('Feedback 服务器', style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            '自定义地址仅保存在本机；恢复默认后使用应用内置地址。',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('feedback-server-input'),
            controller: _serverInput,
            focusNode: _serverInputFocus,
            enabled: !_settingsBusy,
            keyboardType: TextInputType.url,
            autocorrect: false,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _saveServerSetting(),
            decoration: InputDecoration(
              labelText: '服务器地址',
              hintText: widget.config.apiBase,
              border: const OutlineInputBorder(),
              isDense: true,
              errorText: _serverError,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '当前有效地址：$effectiveApiBase',
            key: const Key('feedback-server-effective'),
            style: theme.textTheme.bodySmall,
          ),
          if (_serverHint != null) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              _serverHint!,
              key: const Key('feedback-server-hint'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.primary,
              ),
            ),
          ],
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              FilledButton(
                key: const Key('feedback-server-save'),
                onPressed: _settingsBusy ? null : _saveServerSetting,
                child: _settingsBusy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('保存'),
              ),
              const SizedBox(width: 8),
              TextButton(
                key: const Key('feedback-server-default'),
                onPressed: _settingsBusy ? null : _restoreDefaultServer,
                child: const Text('恢复默认'),
              ),
              const Spacer(),
              TextButton(
                key: const Key('feedback-settings-back'),
                onPressed: _closeSettings,
                child: const Text('返回'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _statusIcon(IconData active, IconData idle) {
    final bool polling = _isPollable(_stage);
    if (!polling) return Icon(idle, size: 40);
    return SizedBox.square(
      dimension: 40,
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(active, size: 28),
      ),
    );
  }

  /// Class B 视图：服务端**已接收**该反馈（保留原 feedbackId），但后台处理
  /// 失败（服务端状态 `failed` / `needs_review`）。
  ///
  /// 此视图绝不重新 POST——重发只会产生重复工单。用户可见原反馈 ID，可
  /// 刷新状态、复制反馈 ID（在管理页恢复），或返回编辑开一条**新**反馈。
  Widget _buildFailedView(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? id = _ticketId;
    return _buildStatusNotice(
      title: '失败',
      subtitle: '失败（已记录，可在管理页处理）',
      detail: _errorSummary,
      icon: const Icon(Icons.error_outline, size: 40),
      footnote: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (id != null)
            SelectableText(
              '反馈 ID：$id',
              key: const Key('feedback-ticket-id'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall,
            ),
          const SizedBox(height: 6),
          Text(
            '该反馈已被服务接收，请勿重复提交；管理员可在管理页按此 ID 恢复原始记录。',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (_failedNotice != null) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              _failedNotice!,
              key: const Key('feedback-failed-notice'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.primary,
              ),
            ),
          ],
        ],
      ),
      extra: <Widget>[
        FilledButton.icon(
          key: const Key('feedback-refresh-status'),
          onPressed: id == null || _busy ? null : _refreshTicketStatus,
          icon: const Icon(Icons.refresh, size: 18),
          label: const Text('刷新状态'),
        ),
        OutlinedButton.icon(
          key: const Key('feedback-copy-id'),
          onPressed: id == null ? null : _copyTicketId,
          icon: const Icon(Icons.copy, size: 18),
          label: const Text('复制反馈 ID'),
        ),
        OutlinedButton(
          key: const Key('feedback-back-edit'),
          onPressed: () => _backToCompose(restoreDraft: true),
          child: const Text('返回编辑'),
        ),
      ],
    );
  }

  Widget _buildStatusNotice({
    required String title,
    String? subtitle,
    String? detail,
    Widget? footnote,
    required Widget icon,
    List<Widget> extra = const <Widget>[],
  }) {
    final ThemeData theme = Theme.of(context);
    final bool saved = _ticketId != null &&
        _stage != FeedbackStage.compose &&
        _stage != FeedbackStage.notSent;
    final List<Widget> actions = <Widget>[
      if (saved && _signedIn && _capabilities?.dialogue == true)
        FilledButton.icon(
          key: const Key('feedback-view-progress'),
          onPressed: () => _openDialogue(_ticketId!),
          icon: const Icon(Icons.forum_outlined, size: 18),
          label: const Text('查看进展'),
        ),
      ...extra,
    ];
    return Center(
      child: Semantics(
        liveRegion: true,
        label: subtitle == null ? title : '$title，$subtitle',
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              DefaultTextStyle(
                style: theme.textTheme.bodyLarge ?? const TextStyle(),
                child: icon,
              ),
              const SizedBox(height: 16),
              Text(title, style: theme.textTheme.titleMedium),
              if (subtitle != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  subtitle,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              if (detail != null && detail.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  '详情：$detail',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall,
                ),
              ],
              if (saved && footnote == null) ...<Widget>[
                const SizedBox(height: 12),
                SelectableText('反馈 ID：$_ticketId',
                    key: const Key('feedback-ticket-id'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall),
              ],
              if (footnote != null) ...<Widget>[
                const SizedBox(height: 12),
                footnote,
              ],
              if (actions.isNotEmpty) ...<Widget>[
                const SizedBox(height: 24),
                for (final Widget button in actions) ...<Widget>[
                  SizedBox(width: 220, child: button),
                  const SizedBox(height: 10),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// 面板内登录表单：在撰写视图底部按需展开（Web 与原生共用，不打开任何窗口）。
  Widget _buildInlineLoginForm(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      key: const Key('feedback-login-form'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('登录后即可提交（账号由管理员分发）', style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          TextField(
            key: const Key('feedback-login-username'),
            controller: _username,
            focusNode: _usernameFocus,
            enabled: !_busy,
            autofillHints: const <String>[AutofillHints.username],
            // T9：账号「下一步」进入密码框（焦点顺序由树序保证）。
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(
              labelText: '用户名',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            key: const Key('feedback-login-password'),
            controller: _password,
            focusNode: _passwordFocus,
            enabled: !_busy,
            obscureText: true,
            autofillHints: const <String>[AutofillHints.password],
            // T9：密码「完成」沿用登录流程。
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _login(),
            decoration: const InputDecoration(
              labelText: '密码',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          if (_loginError != null) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              _loginError!,
              key: const Key('feedback-login-error'),
              style: TextStyle(color: theme.colorScheme.error, fontSize: 12),
            ),
          ],
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              FilledButton(
                key: const Key('feedback-login-submit'),
                onPressed: _busy ? null : _login,
                child: _busy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('登录并提交'),
              ),
              const SizedBox(width: 8),
              // 「取消」在登录进行中保持可用：用户必须能中止一次挂起的登录，
              // 中止会递增登录序号使该次登录的迟到结果失效（T1-A）。
              TextButton(
                key: const Key('feedback-login-cancel'),
                onPressed: _cancelLoginForm,
                child: const Text('取消'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 撰写视图（T2.7 组件顺序）：标题与页签（Header）→ 反馈描述 →
  /// 图片证据 → 可折叠日志 → **固定提交区**。技术信息（日志详情）与
  /// 账户信息（额度/用户名）弱化展示。
  Widget _buildComposeView(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final int runes = _draft.text.runes.length;
    final bool nearLimit = runes >= kFeedbackMaxTextRunes;
    // T9：有界可滚动内容区 + 固定提交区——高度充足时输入区占满剩余空间；
    // 高度不足（键盘展开 / 小屏 / 放大字体 / 截图+日志+登录表单）时内容区
    // 整体可滚动，底部提交区固定始终可达，不再溢出裁剪。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              // 预留固定提交区高度，内容不足时仍铺满可用空间。
              final double minHeight = constraints.maxHeight.isFinite
                  ? math.max(0.0, constraints.maxHeight - 56)
                  : 0.0;
              return SingleChildScrollView(
                key: const Key('feedback-compose-scroll'),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: minHeight),
                  child: IntrinsicHeight(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        if (_composeError != null) ...<Widget>[
                          Container(
                            key: const Key('feedback-compose-error'),
                            margin: const EdgeInsets.only(bottom: 12),
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.errorContainer,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Row(
                              children: <Widget>[
                                Icon(Icons.warning_amber_rounded,
                                    size: 18,
                                    color: theme.colorScheme.onErrorContainer),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    _composeError!,
                                    style: TextStyle(
                                        color:
                                            theme.colorScheme.onErrorContainer),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                        // ① 反馈描述（主输入区）。
                        Expanded(
                          child: TextField(
                            key: const Key('feedback-input'),
                            controller: _draft,
                            focusNode: _draftFocus,
                            expands: true,
                            maxLines: null,
                            minLines: null,
                            textAlignVertical: TextAlignVertical.top,
                            keyboardType: TextInputType.multiline,
                            inputFormatters: <TextInputFormatter>[
                              const _RuneLimitFormatter(kFeedbackMaxTextRunes),
                            ],
                            decoration: const InputDecoration(
                              hintText: '刚才哪里不顺手？你希望它怎样改进？',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        // ② 图片证据。
                        _buildImagesArea(context),
                        const SizedBox(height: 4),
                        // ③ 可折叠日志（技术信息弱化：默认只显示摘要）。
                        _buildLogsArea(context),
                        const SizedBox(height: 8),
                        // 登录表单与额度提示（账户信息弱化展示）。
                        if (!_signedIn && _showLoginForm)
                          _buildInlineLoginForm(context),
                        if (_signedIn && _quotaBlocked)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Text(
                              '今日提交次数已用完，额度刷新后可继续提交',
                              key: const Key('feedback-quota-blocked'),
                              style: theme.textTheme.bodySmall
                                  ?.copyWith(color: theme.colorScheme.error),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        // ④ 固定提交区：计数 / 账户信息（弱化）/ 提交按钮常驻底部。
        _buildSubmitBar(context, runes: runes, nearLimit: nearLimit),
      ],
    );
  }

  /// 固定提交区（T2.7）：细边框分隔，阴影只用于浮层——这里只用边框。
  Widget _buildSubmitBar(
    BuildContext context, {
    required int runes,
    required bool nearLimit,
  }) {
    final ThemeData theme = Theme.of(context);
    return Container(
      key: const Key('feedback-submit-bar'),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant, width: 1),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Row(
        children: <Widget>[
          Text(
            '$runes / $kFeedbackMaxTextRunes',
            key: const Key('feedback-counter'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: nearLimit
                  ? theme.colorScheme.error
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (_signedIn && _quota != null) ...<Widget>[
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                _quota!.unlimited
                    ? '${_user?.username ?? ''} · 不限次数'
                    : '${_user?.username ?? ''} · 今日剩余 ${_quota!.remaining} 次',
                key: const Key('feedback-quota'),
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ),
          ] else
            const Spacer(),
          FilledButton.icon(
            key: const Key('feedback-submit'),
            // 未登录：点击在当前面板展开登录表单（成功后自动提交一次）。
            onPressed: _signedIn
                ? (_canSubmit ? _submit : null)
                : (_draftValid && !_busy
                    ? () => _openLoginForm(thenSubmit: true)
                    : null),
            icon: Icon(
              _signedIn ? Icons.send_outlined : Icons.login,
              size: 18,
            ),
            // Class A（未送达）时按钮语义是重试：同 key 同字节重发，
            // 快照变化（改文案 / 换图 / 移图）则自动换新 key。
            label: Text(
              _signedIn
                  ? (_stage == FeedbackStage.notSent ? '重试提交' : '提交')
                  : '登录并提交',
            ),
          ),
        ],
      ),
    );
  }

  /// v12 撰写页图片区：≤5 张缩略图网格（点击放大）+ 逐张编辑/删除 +
  /// 「添加图片」；不可绘制内容提示与单图模式升级提示。
  Widget _buildImagesArea(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final int limit = _maxImages;
    final bool canAdd = _images.length < limit && !_busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: <Widget>[
            Text(
              '图片附件 (${_images.length}/$limit)',
              key: const Key('feedback-images-count'),
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.bold,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (canAdd)
              TextButton.icon(
                key: const Key('feedback-btn-add-image'),
                onPressed: () => _pickImagesInto(_images),
                icon: const Icon(Icons.add_photo_alternate_outlined, size: 14),
                label: const Text('添加图片', style: TextStyle(fontSize: 12)),
                style: TextButton.styleFrom(
                  tapTargetSize: MaterialTapTargetSize.padded,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                ),
              ),
          ],
        ),
        if (_undrawableNotice) ...<Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '部分内容可能未入图（系统级画面），可手动添加图片补充',
              key: const Key('feedback-undrawable-hint'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.tertiary,
              ),
            ),
          ),
        ],
        if (_singleImageMode) ...<Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '当前服务仅支持单图附件，升级服务端以支持多图',
              key: const Key('feedback-single-image-hint'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
        if (_images.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6, bottom: 10),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (int i = 0; i < _images.length; i++)
                  _buildImageThumb(context, _images, i),
              ],
            ),
          ),
      ],
    );
  }

  /// 单张图片卡片（T2.6）：缩略图**完整显示**（`BoxFit.contain`，禁止
  /// cover 二次裁切），左上角「局部截图／已编辑／截图」标记、右下角
  /// 输出尺寸；编辑、删除放在图片**下方**（≥48dp），不遮挡内容；
  /// capture 槽位支持重拍。
  Widget _buildImageThumb(
    BuildContext context,
    List<FeedbackImageFile> list,
    int index,
  ) {
    final FeedbackImageFile image = list[index];
    final ThemeData theme = Theme.of(context);
    final bool isCapture = image.source == 'capture';
    final bool isRegionCapture = isCapture && _captureInfo?.region != null;
    final String badge = image.source == 'edited'
        ? '已编辑'
        : isRegionCapture
            ? '局部截图'
            : (isCapture ? '截图' : '');
    return SizedBox(
      key: isCapture
          ? const Key('feedback-screenshot-wrap')
          : Key('feedback-image-$index'),
      width: 152,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          SizedBox(
            height: 96,
            child: ClipRRect(
              // 面板规格：图片圆角 10。
              borderRadius: BorderRadius.circular(10),
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  ColoredBox(color: theme.colorScheme.surfaceContainerHighest),
                  GestureDetector(
                    key: isCapture
                        ? const Key('feedback-screenshot-thumb')
                        : Key('feedback-image-thumb-$index'),
                    onTap: () => _openImageZoom(context, image),
                    child: _ThumbnailImageView(bytes: image.bytes),
                  ),
                  if (badge.isNotEmpty)
                    Positioned(
                      top: 4,
                      left: 4,
                      child: DecoratedBox(
                        decoration: const BoxDecoration(
                          color: Colors.black54,
                          borderRadius: BorderRadius.all(Radius.circular(4)),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 4, vertical: 1),
                          child: Text(
                            badge,
                            key: isCapture
                                ? const Key('feedback-screenshot-badge')
                                : Key('feedback-image-badge-$index'),
                            style: const TextStyle(
                                color: Colors.white, fontSize: 9),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 4),
          // 操作行：图片下方固定，不遮挡图片内容。
          SizedBox(
            height: 48,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: <Widget>[
                if (isCapture && widget.onRetakeScreenshot != null)
                  IconButton(
                    key: const Key('feedback-retake-btn'),
                    tooltip: '重新截图',
                    padding: EdgeInsets.zero,
                    constraints:
                        const BoxConstraints(minWidth: 48, minHeight: 48),
                    icon: const Icon(Icons.refresh, size: 16),
                    onPressed: widget.onRetakeScreenshot,
                  ),
                IconButton(
                  key: Key('feedback-image-edit-$index'),
                  tooltip: '编辑',
                  padding: EdgeInsets.zero,
                  constraints:
                      const BoxConstraints(minWidth: 48, minHeight: 48),
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  onPressed: _busy ? null : () => _editImage(list, index),
                ),
                IconButton(
                  key: isCapture
                      ? const Key('feedback-remove-screenshot-btn')
                      : Key('feedback-image-remove-$index'),
                  tooltip: '移除',
                  padding: EdgeInsets.zero,
                  constraints:
                      const BoxConstraints(minWidth: 48, minHeight: 48),
                  icon: const Icon(Icons.delete_outline, size: 16),
                  onPressed: _busy
                      ? null
                      : () {
                          setState(() {
                            list.removeAt(index);
                            if (isCapture) {
                              _captureInfo = null;
                              _undrawableNotice = false;
                            }
                          });
                        },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// T4：可折叠日志区——默认只显示「已附诊断日志／暂无日志」摘要，
  /// 展开后可查看文件、预览、移除、重新采集；采集失败提示常驻（折叠也
  /// 可见）且不阻塞提交。
  Widget _buildLogsArea(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool canAdd =
        _logs.length < kFeedbackMaxLogFiles && !_busy && !_logsCollecting;
    final bool expanded = _logsExpanded;
    final bool hasProvider =
        (widget.logProvider ?? widget.config.logProvider) != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        '日志附件 (${_logs.length}/$kFeedbackMaxLogFiles)',
                        key: const Key('feedback-logs-count'),
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      if (_logsCollecting) ...<Widget>[
                        const SizedBox(width: 8),
                        const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '正在采集...',
                          key: const Key('feedback-logs-collecting'),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  // 默认摘要（T4）：不展开也能看懂是否已附诊断日志。
                  Text(
                    _logs.isNotEmpty ? '已附诊断日志' : '暂无日志',
                    key: const Key('feedback-logs-summary'),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
            if (canAdd)
              TextButton.icon(
                key: const Key('feedback-btn-add-log'),
                onPressed: _pickLogs,
                icon: const Icon(Icons.add, size: 14),
                label: const Text('添加日志', style: TextStyle(fontSize: 12)),
                style: TextButton.styleFrom(
                  // 触屏目标不小于 48dp（Material 无障碍下限）。
                  tapTargetSize: MaterialTapTargetSize.padded,
                  minimumSize: const Size(64, 48),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                ),
              ),
            IconButton(
              key: const Key('feedback-logs-expand'),
              tooltip: expanded ? '收起日志详情' : '展开日志详情',
              iconSize: 20,
              constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              isSelected: expanded,
              icon: Icon(expanded ? Icons.expand_less : Icons.expand_more),
              onPressed: () => setState(() => _logsExpanded = !expanded),
            ),
          ],
        ),
        // 采集 / 选择错误常驻：折叠态同样可见、可重试。
        if (_logError != null)
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 4),
            child: Text(
              _logError!,
              key: const Key('feedback-log-error'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ),
        // 展开区：文件列表（预览 / 移除）+ 重新采集。
        AnimatedSize(
          key: const Key('feedback-logs-collapsible'),
          duration: kFeedbackMotion,
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: !expanded
              ? const SizedBox(width: double.infinity)
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (_logs.isNotEmpty)
                      Container(
                        key: const Key('feedback-logs-list'),
                        margin: const EdgeInsets.only(top: 4, bottom: 6),
                        padding: const EdgeInsets.symmetric(
                            vertical: 2, horizontal: 8),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                              color: theme.colorScheme.outlineVariant),
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            for (int i = 0; i < _logs.length; i++)
                              _buildLogItem(context, i, _logs[i]),
                          ],
                        ),
                      )
                    else
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Text(
                          '暂无日志文件',
                          key: const Key('feedback-logs-empty'),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: theme.colorScheme.outline),
                        ),
                      ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        key: const Key('feedback-logs-recollect'),
                        onPressed:
                            (_logsCollecting || _busy) ? null : _recollectLogs,
                        icon: const Icon(Icons.refresh, size: 14),
                        label:
                            const Text('重新采集', style: TextStyle(fontSize: 12)),
                        style: TextButton.styleFrom(
                          tapTargetSize: MaterialTapTargetSize.padded,
                          minimumSize: const Size(64, 48),
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                        ),
                      ),
                    ),
                    if (!hasProvider)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          '未配置自动采集器，可手动添加日志文件',
                          key: const Key('feedback-logs-no-provider'),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: theme.colorScheme.outline),
                        ),
                      ),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _buildLogItem(BuildContext context, int index, FeedbackLogFile log) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      key: Key('feedback-log-item-$index'),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Row(
              children: <Widget>[
                Flexible(
                  child: Text(
                    log.filename,
                    key: Key('feedback-log-name-$index'),
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w500),
                  ),
                ),
                const SizedBox(width: 6),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                  decoration: BoxDecoration(
                    color: log.source == 'auto'
                        ? theme.colorScheme.primaryContainer
                        : theme.colorScheme.secondaryContainer,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    log.source == 'auto' ? '自动' : '手动',
                    key: Key('feedback-log-badge-$index'),
                    style: TextStyle(
                      fontSize: 10,
                      color: log.source == 'auto'
                          ? theme.colorScheme.onPrimaryContainer
                          : theme.colorScheme.onSecondaryContainer,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  _formatBytes(log.byteSize),
                  key: Key('feedback-log-size-$index'),
                  style: TextStyle(
                    fontSize: 11,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            key: Key('feedback-log-btn-preview-$index'),
            icon: const Icon(Icons.visibility_outlined, size: 16),
            tooltip: '预览',
            padding: EdgeInsets.zero,
            // 点击目标至少 48dp（冻结视觉规格）。
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            onPressed: () => _openLogPreview(context, log),
          ),
          IconButton(
            key: Key('feedback-log-btn-remove-$index'),
            icon: const Icon(Icons.close, size: 16),
            tooltip: '移除',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            onPressed: _busy ? null : () => removeLog(index),
          ),
        ],
      ),
    );
  }

  void _openLogPreview(BuildContext context, FeedbackLogFile log) {
    unawaited(_showPanelDialog<void>(
      builder: (BuildContext ctx, void Function([void]) close) {
        return AlertDialog(
          key: const Key('feedback-log-preview-dialog'),
          title: Text(
            log.filename,
            key: const Key('feedback-log-preview-title'),
            style: const TextStyle(fontSize: 16),
          ),
          content: SizedBox(
            width: double.maxFinite,
            child: SingleChildScrollView(
              child: SelectableText(
                log.text,
                key: const Key('feedback-log-preview-body'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                ),
              ),
            ),
          ),
          actions: <Widget>[
            TextButton(
              key: const Key('feedback-log-preview-close'),
              onPressed: () => close(),
              child: const Text('关闭'),
            ),
          ],
        );
      },
    ));
  }

  Future<void> _collectLogs() async {
    final FeedbackLogProvider? provider =
        widget.logProvider ?? widget.config.logProvider;
    if (provider == null || _logsCollected || _logsCollecting) return;
    final int seq = ++_logsSeq;
    final String currentAppId = widget.config.appId;
    setState(() {
      _logsCollecting = true;
      _logError = null;
    });
    try {
      final List<FeedbackLogFile>? result =
          await Future<List<FeedbackLogFile>?>.value(
        provider(),
      ).timeout(const Duration(seconds: 3));
      if (!mounted || seq != _logsSeq || widget.config.appId != currentAppId) {
        return;
      }
      _logsCollected = true;
      if (result != null && result.isNotEmpty) {
        final List<FeedbackLogFile> manual = _logs
            .where((FeedbackLogFile l) => l.source != 'auto')
            .toList(growable: false);
        String? error;
        if (manual.length + result.length > kFeedbackMaxLogFiles) {
          error = '日志数量超过 $kFeedbackMaxLogFiles 个上限（含手动附加的日志）';
        }
        for (final FeedbackLogFile log in result) {
          if (error != null) break;
          final String ext = _getLogExtension(log.filename);
          String? reason;
          if (log.filename.contains('/') || log.filename.contains('\\')) {
            reason = '日志文件名不能包含路径分隔符';
          } else if (!kFeedbackAllowedLogExtensions.contains(ext)) {
            reason = '文件格式不受支持，仅支持 .log, .txt, .json, .jsonl';
          } else if (log.bytes.isEmpty) {
            reason = '日志文件不能为空';
          } else if (log.byteSize > kFeedbackMaxLogBytes) {
            reason = '日志文件不能超过 1MiB 限制';
          } else {
            try {
              final String text = utf8.decode(log.bytes, allowMalformed: false);
              if (text.contains('\u0000')) {
                reason = '日志不能包含 NUL 字符';
              }
            } on FormatException {
              reason = '日志必须是有效的 UTF-8 文本';
            }
          }
          if (reason != null) error = '${log.filename}: $reason';
        }
        if (error != null) {
          setState(() {
            _logsCollecting = false;
            _logError = error;
          });
          return;
        }
        setState(() {
          // 整批校验成功才替换自动项；失败时保留原列表，手动项始终保留。
          _logs = <FeedbackLogFile>[
            ...manual,
            for (final FeedbackLogFile log in result)
              FeedbackLogFile(
                filename: log.filename,
                bytes: log.bytes,
                source: 'auto',
                sha256: log.sha256,
              ),
          ];
          _logsCollecting = false;
        });
      } else {
        setState(() {
          _logsCollecting = false;
        });
      }
    } on TimeoutException {
      if (!mounted || seq != _logsSeq || widget.config.appId != currentAppId) {
        return;
      }
      _logsCollected = true;
      setState(() {
        _logsCollecting = false;
        _logError = '日志采集超时，可重试或手动添加';
      });
    } catch (_) {
      if (!mounted || seq != _logsSeq || widget.config.appId != currentAppId) {
        return;
      }
      _logsCollected = true;
      setState(() {
        _logsCollecting = false;
        _logError = '日志采集失败，可手动添加';
      });
    }
  }

  Future<void> _pickLogs() async {
    final FeedbackFilePicker picker =
        widget.filePicker ?? widget.config.filePicker ?? _defaultFilePicker;
    final int seq = ++_logsSeq;
    final String currentAppId = widget.config.appId;
    setState(() {
      _logError = null;
    });
    try {
      final List<FeedbackLogFile>? files = await picker();
      if (!mounted ||
          seq != _logsSeq ||
          widget.config.appId != currentAppId ||
          files == null ||
          files.isEmpty) {
        return;
      }
      _addManualLogs(files);
    } catch (err) {
      if (!mounted || seq != _logsSeq || widget.config.appId != currentAppId) {
        return;
      }
      setState(() {
        _logError = err is FormatException ? err.message : '选择日志文件失败';
      });
    }
  }

  static Future<List<FeedbackLogFile>?> _defaultFilePicker() async {
    const fs.XTypeGroup typeGroup = fs.XTypeGroup(
      label: 'logs',
      extensions: <String>['log', 'txt', 'json', 'jsonl'],
    );
    final List<fs.XFile> files = await fs
        .openFiles(acceptedTypeGroups: const <fs.XTypeGroup>[typeGroup]);
    if (files.isEmpty) return null;
    final List<FeedbackLogFile> result = <FeedbackLogFile>[];
    for (final fs.XFile file in files) {
      final Uint8List bytes = await file.readAsBytes();
      try {
        utf8.decode(bytes);
      } catch (_) {
        throw const FormatException('日志文件必须为 UTF-8 编码文本');
      }
      result.add(
        FeedbackLogFile(
          filename: file.name,
          bytes: bytes,
          source: 'manual',
        ),
      );
    }
    return result;
  }

  void _addManualLogs(List<FeedbackLogFile> files) {
    setState(() {
      _logError = null;
      int added = 0;
      for (final FeedbackLogFile file in files) {
        if (_logs.length >= kFeedbackMaxLogFiles) {
          _logError = '最多附加 $kFeedbackMaxLogFiles 个日志文件';
          break;
        }
        final String ext = _getLogExtension(file.filename);
        if (!kFeedbackAllowedLogExtensions.contains(ext)) {
          _logError = '文件格式不受支持，仅支持 .log, .txt, .json, .jsonl';
          continue;
        }
        if (file.byteSize > kFeedbackMaxLogBytes) {
          _logError = '日志文件不能超过 1MiB 限制';
          continue;
        }
        _logs.add(
          FeedbackLogFile(
            filename: file.filename,
            bytes: file.bytes,
            source: 'manual',
            sha256: file.sha256,
          ),
        );
        added++;
      }
      // 手动添加成功后展开列表，明确回显新增内容。
      if (added > 0) _logsExpanded = true;
    });
  }

  /// T4：重新采集诊断日志——保留手动附加项，重新调用 logProvider；
  /// 采集失败仍可提交（失败只提示，不阻塞）。
  Future<void> _recollectLogs() async {
    final FeedbackLogProvider? provider =
        widget.logProvider ?? widget.config.logProvider;
    if (provider == null) {
      _showToast('未配置日志采集器，可手动添加日志文件');
      return;
    }
    if (_logsCollecting) return;
    setState(() {
      _logsExpanded = true;
      _logsCollected = false;
      _logError = null;
    });
    await _collectLogs();
  }

  // ---------------------------------------------------------------- 历史与工单详情视图

  Widget _buildHistoryView(BuildContext context) {
    if (!_signedIn) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.lock_outline,
                  size: 48, color: Theme.of(context).colorScheme.outline),
              const SizedBox(height: 16),
              Text(
                '查看反馈历史需要登录',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              const Text(
                '登录后可查看您提交的全部反馈及管理团队的回复',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
              const SizedBox(height: 20),
              FilledButton(
                key: const Key('history-login-btn'),
                onPressed: () {
                  setState(() {
                    _panelTab = _PanelTab.compose;
                    _showLoginForm = true;
                  });
                },
                child: const Text('前往登录'),
              ),
            ],
          ),
        ),
      );
    }

    if (_historyLoading && _myFeedbacks.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_historyError != null && _myFeedbacks.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, size: 48, color: Colors.red),
              const SizedBox(height: 12),
              Text(_historyError!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: _loadHistoryList,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    // v12：状态筛选行（待处理/待补充/待管理员回复/已解决）+ 分页控件。
    final Widget filterRow = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Row(
        children: <Widget>[
          _buildFilterChip(null, '全部'),
          _buildFilterChip(IssueStatus.open, '待处理'),
          _buildFilterChip(IssueStatus.waitingUser, '待补充'),
          _buildFilterChip(IssueStatus.waitingAdmin, '待管理员回复'),
          _buildFilterChip(IssueStatus.resolved, '已解决'),
        ],
      ),
    );

    final int maxPage = _historyTotal <= 0
        ? 1
        : ((_historyTotal + _historyLimit - 1) ~/ _historyLimit);

    final Widget listBody;
    if (_myFeedbacks.isEmpty && !_historyLoading) {
      listBody = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.inbox_outlined,
                size: 48, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 12),
            Text(
              _historyFilter == null ? '暂无反馈记录' : '该状态下暂无反馈',
              style: const TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 16),
            FilledButton.tonal(
              onPressed: () => _switchTab(_PanelTab.compose),
              child: const Text('新建一条反馈'),
            ),
          ],
        ),
      );
    } else {
      listBody = RefreshIndicator(
        onRefresh: () => _loadHistoryList(),
        child: ListView.separated(
          padding: const EdgeInsets.all(12),
          itemCount: _myFeedbacks.length,
          separatorBuilder: (_, __) => const Divider(height: 1),
          itemBuilder: (BuildContext context, int index) {
            final UserFeedbackListItem item = _myFeedbacks[index];
            return _buildHistoryItem(context, item);
          },
        ),
      );
    }

    return Column(
      children: <Widget>[
        Row(children: <Widget>[
          Expanded(child: filterRow),
          IconButton(
            key: const Key('feedback-history-refresh'),
            tooltip: '刷新我的反馈',
            onPressed: _historyLoading ? null : _loadHistoryList,
            icon: const Icon(Icons.refresh),
          ),
        ]),
        if (_historyError != null)
          Padding(
              padding: const EdgeInsets.all(8), child: Text(_historyError!)),
        Expanded(child: listBody),
        if (_historyTotal > _historyLimit || _historyPage > 1)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                IconButton(
                  key: const Key('feedback-history-prev'),
                  tooltip: '上一页',
                  icon: const Icon(Icons.chevron_left),
                  onPressed: _historyPage > 1 && !_historyLoading
                      ? () => _loadHistoryPage(-1)
                      : null,
                ),
                Flexible(
                    child: Text(
                  '第 $_historyPage / $maxPage 页（共 $_historyTotal 条）',
                  key: const Key('feedback-history-pageinfo'),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                )),
                IconButton(
                  key: const Key('feedback-history-next'),
                  tooltip: '下一页',
                  icon: const Icon(Icons.chevron_right),
                  onPressed: _historyPage < maxPage && !_historyLoading
                      ? () => _loadHistoryPage(1)
                      : null,
                ),
                if (_historyLoading)
                  const Padding(
                    padding: EdgeInsets.only(left: 8),
                    child: SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildFilterChip(IssueStatus? status, String label) {
    final bool selected = _historyFilter == status;
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: Material(
        color: selected ? scheme.primaryContainer : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          key: Key('feedback-filter-${status?.toWire() ?? 'all'}'),
          borderRadius: BorderRadius.circular(8),
          onTap: () => _setHistoryFilter(status),
          // 状态筛选点击目标 ≥48dp（冻结视觉规格）。
          child: SizedBox(
            height: 48,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const SizedBox(width: 10),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 12,
                    color: selected
                        ? scheme.onPrimaryContainer
                        : scheme.onSurfaceVariant,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                  ),
                ),
                const SizedBox(width: 10),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHistoryItem(BuildContext context, UserFeedbackListItem item) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    // v12 用户端统一文案：open→待处理、waiting_user→待补充、
    // waiting_admin→待管理员回复、resolved→已解决（含状态图标）。
    final (Color tagBg, Color tagFg, String tagText, IconData tagIcon) =
        switch (item.issueStatus) {
      IssueStatus.waitingUser => (
          Colors.orange.shade100,
          Colors.orange.shade900,
          '待补充',
          Icons.edit_note,
        ),
      IssueStatus.waitingAdmin => (
          scheme.primaryContainer,
          scheme.onPrimaryContainer,
          '待管理员回复',
          Icons.support_agent,
        ),
      IssueStatus.resolved => (
          Colors.green.shade100,
          Colors.green.shade900,
          '已解决',
          Icons.check_circle_outline,
        ),
      IssueStatus.open => (
          scheme.surfaceContainerHighest,
          scheme.onSurfaceVariant,
          '待处理',
          Icons.hourglass_empty,
        ),
    };

    final String displayTitle =
        item.title?.isNotEmpty == true ? item.title! : item.text;

    return InkWell(
      key: Key('feedback-item-${item.id}'),
      onTap: () => _openDialogue(item.id),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: <Widget>[
                Text('#${item.id}',
                    style: Theme.of(context).textTheme.bodySmall),
                Text('${item.messageCount} 条动态',
                    style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: 6),
            Row(
              children: <Widget>[
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: tagBg,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(tagIcon, size: 11, color: tagFg),
                      const SizedBox(width: 3),
                      // 裸 RichText（非 Text/Text.rich）：状态筛选行的同名
                      // chip 与本标签并存时，find.text 只命中 chip 不误伤。
                      RichText(
                        text: TextSpan(
                          text: tagText,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            color: tagFg,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                if (item.unread) ...<Widget>[
                  const SizedBox(width: 6),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.red.shade600,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text(
                      '未读',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 6),
            Text('最近更新：${_formatTime(item.lastActivityAt)}',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 6),
            Text(
              displayTitle,
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            ),
            if (item.latestMessageText != null) ...<Widget>[
              const SizedBox(height: 4),
              Text(
                '${_messageRole(item.latestMessageSender)}: ${item.latestMessageText}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: item.latestMessageSender == 'admin'
                          ? scheme.primary
                          : Colors.grey.shade700,
                    ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _messageRole(String? sender) => switch (sender) {
        'system' => '系统',
        'admin' => '管理员',
        'user' => '我',
        _ => '动态',
      };

  String _nextStep(IssueStatus status) => switch (status) {
        IssueStatus.open => '反馈已保存，等待管理员处理；有新线索可在下方补充。',
        IssueStatus.waitingUser => '管理员正在等待您的补充，请查看下方回复并提供信息。',
        IssueStatus.waitingAdmin => '您的补充已保存，等待管理员回复；无需重复提交。',
        IssueStatus.resolved => '问题已标记解决；仍有问题可继续补充，保留同一条反馈。',
      };

  Widget _buildDialogueView(BuildContext context) {
    if (_dialogueLoading && _dialogueData == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_dialogueError != null && _dialogueData == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, size: 48, color: Colors.red),
              const SizedBox(height: 12),
              Text(_dialogueError!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: () {
                  if (_selectedDialogueId != null) {
                    _loadDialogue(_selectedDialogueId!);
                  }
                },
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    if (_dialogueData == null) {
      return const SizedBox.shrink();
    }

    final FeedbackDialogueResponse dialogue = _dialogueData!;
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final List<FeedbackMessageItem> messages =
        List<FeedbackMessageItem>.from(dialogue.messages)
          ..sort((FeedbackMessageItem a, FeedbackMessageItem b) =>
              a.seq.compareTo(b.seq));
    final String? latestNote = messages.reversed
            .map((FeedbackMessageItem m) => m.resolutionNote)
            .whereType<String>()
            .where((String note) => note.trim().isNotEmpty)
            .firstOrNull ??
        dialogue.resolutionNote;

    return Column(
      children: <Widget>[
        Expanded(
          child: ListView(
            key: const Key('feedback-dialogue-list'),
            controller: _dialogueScroll,
            padding: const EdgeInsets.all(12),
            children: <Widget>[
              Text(
                  dialogue.title?.isNotEmpty == true ? dialogue.title! : '反馈详情',
                  key: const Key('feedback-dialogue-title'),
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              SelectableText('#${dialogue.feedbackId}',
                  key: const Key('feedback-dialogue-id'),
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 4),
              Text(
                  '提交于 ${_formatTime(dialogue.createdAt)} · 最近更新 ${_formatTime(dialogue.lastActivityAt)}',
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              Text(dialogue.issueStatus.label,
                  style: TextStyle(
                      color: scheme.primary, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              Text(_nextStep(dialogue.issueStatus),
                  key: const Key('feedback-next-step'),
                  style: Theme.of(context).textTheme.bodyMedium),
              if (_dialogueError != null) Text(_dialogueError!),
              const SizedBox(height: 16),
              // 原话卡片
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: scheme.outlineVariant),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text('我 · ${_formatTime(dialogue.createdAt)} · 提交了问题',
                        style: Theme.of(context).textTheme.labelMedium),
                    const SizedBox(height: 6),
                    SelectableText(
                      dialogue.text,
                      style: const TextStyle(fontSize: 14, height: 1.4),
                    ),
                    // v12：初始反馈图片列表（历史单图经兼容读取进入同一列表；
                    // 老服务可能只有 screenshot 元数据，退回单图展示）。
                    if (dialogue.images.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          for (final FeedbackImageView img in dialogue.images)
                            _FeedbackBearerImage(
                              key: Key('feedback-history-img-${img.id}'),
                              bytesLoader: () => _api.fetchFeedbackImage(
                                  dialogue.feedbackId, img.id),
                              width: 84,
                              height: 84,
                              onRetry: _showToast,
                            ),
                        ],
                      ),
                    ] else if (dialogue.screenshot != null) ...<Widget>[
                      const SizedBox(height: 8),
                      _FeedbackBearerImage(
                        key: const Key('feedback-history-screenshot'),
                        bytesLoader: () =>
                            _api.fetchFeedbackScreenshot(dialogue.feedbackId),
                        width: 84,
                        height: 84,
                        onRetry: _showToast,
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: <Widget>[
                          const Icon(Icons.image, size: 16, color: Colors.grey),
                          const SizedBox(width: 4),
                          Text(
                            '包含截图 (${dialogue.screenshot!.width}x${dialogue.screenshot!.height})',
                            style: const TextStyle(
                                fontSize: 12, color: Colors.grey),
                          ),
                        ],
                      ),
                    ],
                    if (dialogue.logs.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        children:
                            dialogue.logs.map((FeedbackLogAttachmentView log) {
                          return ActionChip(
                            avatar: const Icon(Icons.description, size: 14),
                            label: Text(log.filename,
                                style: const TextStyle(fontSize: 11)),
                            tooltip: '查看日志',
                            onPressed: () =>
                                _openRemoteLogPreview(dialogue.feedbackId, log),
                          );
                        }).toList(),
                      ),
                    ],
                    // v12：处理说明（管理员标记解决必填）对用户可见。
                    if (latestNote != null &&
                        latestNote.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 8),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: Colors.green.shade50,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: Colors.green.shade200),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Icon(Icons.check_circle_outline,
                                size: 14, color: Colors.green.shade800),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                '最近处理说明：$latestNote',
                                key: const Key('feedback-resolution-note'),
                                style: TextStyle(
                                    fontSize: 12, color: Colors.green.shade900),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // 对话消息列表
              if (dialogue.messages.isEmpty)
                Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Text(
                      '后续回复和系统动态会显示在这里。',
                      style:
                          TextStyle(color: Colors.grey.shade500, fontSize: 13),
                    ),
                  ),
                )
              else
                ...messages.map((FeedbackMessageItem msg) =>
                    _buildTimelineEvent(context, msg)),
              const SizedBox(height: 12),
              _buildReplyComposer(context),
            ],
          ),
        ),
        TextButton.icon(
          key: const Key('feedback-jump-reply'),
          onPressed: () {
            if (!_dialogueScroll.hasClients) return;
            _dialogueScroll.animateTo(_dialogueScroll.position.maxScrollExtent,
                duration: kFeedbackMotion, curve: Curves.easeOut);
          },
          icon: const Icon(Icons.add_comment_outlined, size: 18),
          label: const Text('补充信息'),
        ),
      ],
    );
  }

  Widget _buildTimelineEvent(BuildContext context, FeedbackMessageItem msg) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Container(
      key: Key('feedback-event-${msg.id}'),
      decoration: BoxDecoration(
          border:
              Border(left: BorderSide(color: scheme.outlineVariant, width: 2))),
      padding: const EdgeInsets.only(left: 10, top: 4),
      child:
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        Padding(
            padding: const EdgeInsets.only(top: 6, right: 8),
            child: Icon(
                msg.senderType == 'system'
                    ? Icons.info_outline
                    : Icons.chat_bubble_outline,
                size: 16,
                color: scheme.onSurfaceVariant)),
        Expanded(child: _buildMessageBubble(context, msg)),
      ]),
    );
  }

  Widget _buildMessageBubble(BuildContext context, FeedbackMessageItem msg) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final bool isUser = msg.senderType == 'user';
    final bool isSystem = msg.senderType == 'system';

    if (isSystem) {
      return Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('系统 · ${_formatTime(msg.createdAt)}',
                    style: Theme.of(context).textTheme.labelSmall),
                Text(msg.text,
                    style: TextStyle(
                        fontSize: 12, color: scheme.onSurfaceVariant)),
                if (msg.resolutionNote?.isNotEmpty == true &&
                    msg.text.trim() != msg.resolutionNote!.trim())
                  Text('处理说明：${msg.resolutionNote}',
                      key: Key('feedback-msg-resolution-${msg.id}')),
              ]),
        ),
      );
    }

    final String displayName =
        isUser ? '我' : (msg.senderName.isNotEmpty ? msg.senderName : '管理员');

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: Wrap(
              spacing: 8,
              runSpacing: 4,
              children: <Widget>[
                Text(
                  displayName,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: isUser ? scheme.primary : scheme.secondary,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _formatTime(msg.createdAt),
                  style: const TextStyle(fontSize: 10, color: Colors.grey),
                ),
              ],
            ),
          ),
          Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.85,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: isUser ? scheme.primary : scheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (msg.text.isNotEmpty)
                  SelectableText(
                    msg.text,
                    style: TextStyle(
                      fontSize: 14,
                      color: isUser ? scheme.onPrimary : scheme.onSurface,
                      height: 1.3,
                    ),
                  ),
                // v12：处理说明（随解决动作入库并对用户可见）。
                if (msg.resolutionNote != null &&
                    msg.resolutionNote!.isNotEmpty &&
                    msg.text.trim() != msg.resolutionNote!.trim()) ...<Widget>[
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: isUser
                          ? Colors.white.withValues(alpha: 0.15)
                          : Colors.green.shade50,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      '处理说明：${msg.resolutionNote}',
                      key: Key('feedback-msg-resolution-${msg.id}'),
                      style: TextStyle(
                        fontSize: 11,
                        color:
                            isUser ? scheme.onPrimary : Colors.green.shade900,
                      ),
                    ),
                  ),
                ],
                if (msg.attachments.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children:
                        msg.attachments.map((FeedbackMessageAttachment att) {
                      // v12：附件一律 Bearer 取回字节渲染（URL 不带凭据，
                      // Image.network 跨源必然 401）；失败显示占位 + 重试。
                      if (att.isImage) {
                        return _FeedbackBearerImage(
                          key: Key('feedback-msg-img-${att.id}'),
                          bytesLoader: () =>
                              _api.fetchMessageAttachment(att.id),
                          width: 72,
                          height: 72,
                          onRetry: _showToast,
                        );
                      }
                      return InkWell(
                        onTap: () => _openRemoteAttachment(att),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: isUser
                                ? Colors.white.withValues(alpha: 0.2)
                                : scheme.surface,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(
                                att.isImage ? Icons.image : Icons.description,
                                size: 12,
                                color: isUser
                                    ? scheme.onPrimary
                                    : scheme.onSurface,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                att.filename,
                                style: TextStyle(
                                  fontSize: 11,
                                  color: isUser
                                      ? scheme.onPrimary
                                      : scheme.onSurface,
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildReplyComposer(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final bool hasAttachments =
        _replyImages.isNotEmpty || _replyLogs.isNotEmpty;

    return Container(
      key: const Key('feedback-reply-composer'),
      color: scheme.surface,
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('补充信息', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          Text('补充会保留在这条问题中，返回列表后草稿仍在。',
              style: Theme.of(context).textTheme.bodySmall),
          if (_replyError != null)
            Text(_replyError!,
                key: const Key('feedback-reply-error'),
                style: TextStyle(color: scheme.error)),
          const SizedBox(height: 8),
          if (hasAttachments) ...<Widget>[
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: <Widget>[
                  // v12 / T2.6：回复图片卡片——完整显示（contain），
                  // 编辑 / 删除在图片下方（≥48dp），不遮挡内容。
                  for (int i = 0; i < _replyImages.length; i++)
                    Padding(
                      padding: const EdgeInsets.only(right: 6, bottom: 6),
                      child: SizedBox(
                        width: 96,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            SizedBox(
                              height: 64,
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(10),
                                child: Stack(
                                  fit: StackFit.expand,
                                  children: <Widget>[
                                    const ColoredBox(color: Color(0x14000000)),
                                    GestureDetector(
                                      key: Key('reply-image-thumb-$i'),
                                      onTap: () => _openImageZoom(
                                          context, _replyImages[i]),
                                      child: Image.memory(_replyImages[i].bytes,
                                          fit: BoxFit.contain),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                            SizedBox(
                              height: 48,
                              child: Row(
                                mainAxisAlignment:
                                    MainAxisAlignment.spaceEvenly,
                                children: <Widget>[
                                  IconButton(
                                    key: Key('reply-image-edit-$i'),
                                    tooltip: '编辑',
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(
                                        minWidth: 48, minHeight: 48),
                                    icon: const Icon(Icons.edit_outlined,
                                        size: 16),
                                    onPressed: _replySending
                                        ? null
                                        : () => _editImage(_replyImages, i),
                                  ),
                                  IconButton(
                                    key: Key('reply-image-remove-$i'),
                                    tooltip: '删除',
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(
                                        minWidth: 48, minHeight: 48),
                                    icon: const Icon(Icons.delete_outline,
                                        size: 16),
                                    onPressed: _replySending
                                        ? null
                                        : () {
                                            setState(() {
                                              _replyImages.removeAt(i);
                                            });
                                          },
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ..._replyLogs.map((FeedbackLogFile log) {
                    return Padding(
                      padding: const EdgeInsets.only(right: 6, bottom: 6),
                      child: Chip(
                        avatar: const Icon(Icons.description, size: 14),
                        label: Text(log.filename,
                            style: const TextStyle(fontSize: 11)),
                        onDeleted: _replySending
                            ? null
                            : () {
                                setState(() {
                                  _replyLogs.remove(log);
                                });
                              },
                      ),
                    );
                  }),
                ],
              ),
            ),
          ],
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Expanded(
                child: TextField(
                  key: const Key('feedback-reply-input'),
                  controller: _replyController,
                  focusNode: _replyFocus,
                  enabled: !_replySending,
                  minLines: 2,
                  maxLines: 6,
                  inputFormatters: const <TextInputFormatter>[
                    _RuneLimitFormatter(kFeedbackMaxTextRunes)
                  ],
                  decoration: const InputDecoration(
                    hintText: '补充信息或回复管理员…',
                    isDense: true,
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.all(Radius.circular(8)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              IconButton.filled(
                key: const Key('feedback-reply-send'),
                tooltip: '发送补充',
                icon: _replySending
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.send, size: 18),
                onPressed: _replySending ? null : _sendReply,
              ),
            ],
          ),
          Wrap(children: <Widget>[
            IconButton(
              key: const Key('reply-attach-image'),
              icon: const Icon(Icons.image_outlined, size: 20),
              tooltip: '附加图片',
              onPressed:
                  _replySending ? null : () => _pickImagesInto(_replyImages),
            ),
            IconButton(
              key: const Key('reply-attach-log'),
              icon: const Icon(Icons.attach_file, size: 20),
              tooltip: '附加日志',
              onPressed: _replySending ? null : _pickReplyLog,
            ),
          ]),
        ],
      ),
    );
  }
}

/// 缩略图视图（T2.6）：`BoxFit.contain` **完整显示**（禁止 cover 二次
/// 裁切），右下角解析并显示输出尺寸（`宽×高` 像素）。
class _ThumbnailImageView extends StatefulWidget {
  const _ThumbnailImageView({required this.bytes});

  final Uint8List bytes;

  @override
  State<_ThumbnailImageView> createState() => _ThumbnailImageViewState();
}

class _ThumbnailImageViewState extends State<_ThumbnailImageView> {
  int? _width;
  int? _height;
  ImageStreamListener? _listener;

  @override
  void initState() {
    super.initState();
    _resolveSize();
  }

  @override
  void didUpdateWidget(_ThumbnailImageView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.bytes, widget.bytes)) {
      _detach();
      _width = null;
      _height = null;
      _resolveSize();
    }
  }

  void _resolveSize() {
    final ImageProvider provider = MemoryImage(widget.bytes);
    final ImageStream stream = provider.resolve(const ImageConfiguration());
    final ImageStreamListener listener = ImageStreamListener(
      (ImageInfo info, bool synchronousCall) {
        if (!mounted) return;
        setState(() {
          _width = info.image.width;
          _height = info.image.height;
        });
      },
      onError: (Object error, StackTrace? stackTrace) {
        // 解码失败：不显示尺寸标签（缩略图本身由 Image.memory 报错）。
      },
    );
    _listener = listener;
    stream.addListener(listener);
    _stream = stream;
  }

  ImageStream? _stream;

  void _detach() {
    final ImageStreamListener? listener = _listener;
    if (listener != null) _stream?.removeListener(listener);
    _listener = null;
    _stream = null;
  }

  @override
  void dispose() {
    _detach();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        Positioned.fill(
          child: Image.memory(widget.bytes, fit: BoxFit.contain),
        ),
        if (_width != null && _height != null)
          Positioned(
            right: 4,
            bottom: 4,
            child: DecoratedBox(
              decoration: const BoxDecoration(
                color: Colors.black54,
                borderRadius: BorderRadius.all(Radius.circular(4)),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                child: Text(
                  '$_width×$_height',
                  key: const Key('feedback-image-size'),
                  style: const TextStyle(color: Colors.white, fontSize: 9),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Bearer 附件图片（v12）：附件 URL 不携带凭据，经 [bytesLoader]
/// （`Authorization: Bearer` 请求）取回字节后 `Image.memory` 渲染；
/// 加载失败显示占位与「重试」，不阻塞消息文本渲染。
class _FeedbackBearerImage extends StatefulWidget {
  const _FeedbackBearerImage({
    super.key,
    required this.bytesLoader,
    this.width = 84,
    this.height = 84,
    this.onRetry,
  });

  /// Bearer 下载字节（如 `ApiClient.fetchFeedbackImage`）。
  final Future<Uint8List> Function() bytesLoader;
  final double width;
  final double height;

  /// 失败重试提示回调（宿主 Toast）。
  final void Function(String)? onRetry;

  @override
  State<_FeedbackBearerImage> createState() => _FeedbackBearerImageState();
}

class _FeedbackBearerImageState extends State<_FeedbackBearerImage> {
  Uint8List? _bytes;
  bool _failed = false;
  int _loadSeq = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final int seq = ++_loadSeq;
    try {
      final Uint8List bytes = await widget.bytesLoader();
      if (!mounted || seq != _loadSeq) return;
      setState(() {
        _bytes = bytes;
        _failed = false;
      });
    } catch (_) {
      if (!mounted || seq != _loadSeq) return;
      setState(() {
        _failed = true;
      });
      widget.onRetry?.call('附件加载失败');
    }
  }

  void _retry() {
    setState(() {
      _failed = false;
      _bytes = null;
    });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Uint8List? bytes = _bytes;
    final Widget child;
    if (bytes != null) {
      // T2.6 / T3：附件预览与新建反馈一致——完整显示（contain），不二次裁切。
      child = Image.memory(bytes, fit: BoxFit.contain);
    } else if (_failed) {
      child = Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(Icons.broken_image_outlined,
              size: 20, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(height: 2),
          Text('重试',
              style: TextStyle(fontSize: 10, color: theme.colorScheme.primary)),
        ],
      );
    } else {
      child = const Center(
        child: SizedBox.square(
          dimension: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return GestureDetector(
      onTap: _failed ? _retry : null,
      child: Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: child,
      ),
    );
  }
}
