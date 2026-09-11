import 'dart:async';
import 'dart:convert' show jsonEncode;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';
import 'config.dart';
import 'idempotency.dart';
import 'platform.dart';
import 'token_store.dart';

/// 反馈正文最大长度（按 Unicode 码点 / runes 计，与契约 1..10000 一致）。
const int kFeedbackMaxTextRunes = 10000;

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
/// 正文 + 截图字节 + 截图元数据。
///
/// 复用同一幂等键的前提是快照**完全一致**（服务契约要求同 key 必须同字节，
/// 同 key 不同内容会被判为 409 冲突）。因此改文案、重拍（新截图字节）或移除
/// 截图都属于新快照，必须换新 key 重新提交。
class _FrozenSubmit {
  const _FrozenSubmit({
    required this.text,
    this.screenshotBytes,
    this.captureInfo,
  });

  /// 提交时的正文。
  final String text;

  /// 提交时的截图字节（无截图为 null）。
  final Uint8List? screenshotBytes;

  /// 提交时的截图元数据（无截图为 null）。
  final FeedbackCaptureInfo? captureInfo;

  /// 与 [other] 是否属于同一份提交快照：
  /// 正文逐字符、截图逐字节、元数据按序列化结果比较。
  bool sameAs(_FrozenSubmit other) =>
      text == other.text &&
      listEquals(screenshotBytes, other.screenshotBytes) &&
      _captureSignature(captureInfo) == _captureSignature(other.captureInfo);

  static String? _captureSignature(FeedbackCaptureInfo? info) =>
      info == null ? null : jsonEncode(info.toJson());
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
    this.httpClient,
    this.tokenStore,
  });

  /// 连接与展示配置。
  final FeedbackConfig config;

  /// 请求关闭面板（关闭按钮触发）。
  final VoidCallback? onRequestClose;

  /// 请求重新截图回调。
  final Future<void> Function()? onRetakeScreenshot;

  /// 注入的 HTTP 客户端（主要面向测试）。
  final http.Client? httpClient;

  /// 注入的令牌仓库（主要面向测试）。
  final FeedbackTokenStore? tokenStore;

  @override
  State<FeedbackPanel> createState() => FeedbackPanelState();
}

/// 面板状态（暴露为 public 仅供测试驱动内部状态机）。
class FeedbackPanelState extends State<FeedbackPanel> {
  late final FeedbackTokenStore _tokenStore;
  late final ApiClient _api;

  final TextEditingController _draft = TextEditingController();
  final FocusNode _draftFocus = FocusNode();
  final TextEditingController _username = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final FocusNode _usernameFocus = FocusNode();

  Uint8List? _screenshotBytes;
  FeedbackCaptureInfo? _captureInfo;

  /// 最近一次接受的截图交付所属捕获序号（null 表示无会化交付）。
  int? _lastCaptureSeq;

  /// 当前截图数据（若有）。
  Uint8List? get screenshotBytes => _screenshotBytes;

  /// 面板是否持有草稿文本（只读；父组件据此判断行为，不得直接改写草稿）。
  bool get hasDraft => _draft.text.trim().isNotEmpty;

  /// 面板是否持有当前截图（只读）。
  bool get hasScreenshot => _screenshotBytes != null;

  /// 当前截图的捕获元数据（若有；只读）。
  FeedbackCaptureInfo? get captureInfo => _captureInfo;

  /// 设置当前截图数据。
  ///
  /// [captureSeq] 为捕获会话序号（由 [FeedbackWidget] 分配）。序号低于
  /// 已接受交付的调用视为过期结果（如 post-frame 回调写入旧捕获），
  /// 直接丢弃，防止覆盖新状态。
  void setScreenshot(
    Uint8List? bytes,
    FeedbackCaptureInfo? captureInfo, {
    int? captureSeq,
  }) {
    if (captureSeq != null &&
        _lastCaptureSeq != null &&
        captureSeq < _lastCaptureSeq!) {
      return; // 过期交付：丢弃。
    }
    _lastCaptureSeq = captureSeq ?? _lastCaptureSeq;
    setState(() {
      _screenshotBytes = bytes;
      _captureInfo = captureInfo;
    });
  }

  Timer? _pollTimer;
  Duration _pollDelay = const Duration(seconds: 2);
  bool _pollInFlight = false;

  String? _ticketId;
  String? _idempotencyKey;

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
  bool _busy = false; // 提交中 / 登录中 / 握手中
  FeedbackStage _stage = FeedbackStage.compose;

  // Web 握手辅助状态。
  bool _popupBlocked = false;
  String? _handshakeError;

  // 原生登录辅助状态。
  String? _loginError;

  /// 当前令牌仓库（测试可见）。
  FeedbackTokenStore get tokenStore => _tokenStore;

  /// 当前面板阶段（测试可见）。
  FeedbackStage get stage => _stage;

  @override
  void initState() {
    super.initState();
    _tokenStore = widget.tokenStore ?? createDefaultTokenStore(widget.config);
    _api = ApiClient(
      config: widget.config,
      tokenStore: _tokenStore,
      httpClient: widget.httpClient,
      onUnauthorized: _onUnauthorized,
    );
    _draft.addListener(_onDraftChanged);
    unawaited(_restoreSession());
  }

  Future<void> _restoreSession() async {
    String? token;
    try {
      // 超时兜底：个别平台实现可能挂起（如插件未注册的测试环境），
      // 不可用则退回登录视图，不打断 UI。
      token = await _tokenStore.read().timeout(const Duration(seconds: 2));
    } catch (_) {
      token = null;
    }
    if (!mounted) return;
    setState(() {
      _signedIn = token != null && token.isNotEmpty;
      _authReady = true;
    });
    _focusFirstField();
  }

  void _focusFirstField() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_signedIn && _stage == FeedbackStage.compose) {
        _draftFocus.requestFocus();
      } else if (!_signedIn && !kIsWeb) {
        _usernameFocus.requestFocus();
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
    _pollTimer?.cancel();
    _draft.removeListener(_onDraftChanged);
    _api.dispose();
    _draft.dispose();
    _draftFocus.dispose();
    _username.dispose();
    _password.dispose();
    _usernameFocus.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------- 认证

  void _onUnauthorized() {
    if (!mounted) return;
    _pollTimer?.cancel();
    setState(() {
      _signedIn = false;
      _stage = FeedbackStage.compose;
      _busy = false;
      _popupBlocked = false;
      _handshakeError = null;
    });
    _focusFirstField();
  }

  String _clientLabel() =>
      'flutter-${defaultTargetPlatform.name}-${DateTime.now().toIso8601String()}';

  Future<void> _nativeLogin() async {
    if (_busy) return;
    final String username = _username.text.trim();
    final String password = _password.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _loginError = '请输入用户名和密码');
      return;
    }
    setState(() {
      _busy = true;
      _loginError = null;
    });
    try {
      final LoginResult result = await _api.login(
        username: username,
        password: password,
        clientLabel: _clientLabel(),
      );
      await _tokenStore.write(result.token);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _signedIn = true;
        _password.clear(); // 密码不留存 UI。
      });
      _focusFirstField();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _loginError = _friendlyApiError(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _loginError = '网络异常，登录失败，请稍后重试';
      });
    }
  }

  Future<void> _webHandshake() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _handshakeError = null;
    });
    final result = await startWebLoginHandshake(
      apiBase: widget.config.apiBase,
      appId: widget.config.appId,
    );
    if (!mounted) return;
    if (result.success && result.accessToken != null) {
      await _tokenStore.write(result.accessToken!);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _signedIn = true;
        _popupBlocked = false;
      });
      _focusFirstField();
      return;
    }
    setState(() {
      _busy = false;
      _popupBlocked = result.popupBlocked;
      _handshakeError = result.popupBlocked
          ? '弹窗被浏览器拦截，请点击下方按钮手动打开登录窗口'
          : (result.error ?? '登录未完成，请重试');
    });
  }

  // ---------------------------------------------------------------- 提交

  bool get _canSubmit {
    final int runes = _draft.text.runes.length;
    return !_busy &&
        _signedIn &&
        (_stage == FeedbackStage.compose || _stage == FeedbackStage.notSent) &&
        runes > 0 &&
        runes <= kFeedbackMaxTextRunes &&
        _draft.text.trim().isNotEmpty;
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    // 防御：Class B（服务端已接收、后台处理失败）绝不重新 POST——重发只会
    // 产生重复工单；该视图只提供刷新状态 / 复制反馈 ID / 返回编辑开新反馈。
    if (_stage == FeedbackStage.failed) return;
    final String text = _draft.text;
    // 冻结本次提交的完整快照（正文 + 截图字节 + 元数据）：既要保证请求发出
    // 后草稿变化不影响本次字节，也要作为"能否复用旧幂等键"的比较依据。
    final _FrozenSubmit snapshot = _FrozenSubmit(
      text: text,
      screenshotBytes: _screenshotBytes,
      captureInfo: _captureInfo,
    );
    final _FrozenSubmit? pending = _pendingSubmit;
    if (_idempotencyKey != null &&
        pending != null &&
        !pending.sameAs(snapshot)) {
      // 未送达的旧提交之后快照已变化（改文案 / 重拍换图 / 移除截图）：
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
        screenshotBytes: _screenshotBytes,
      );
      if (!mounted) return;
      // 成功接收后才清空草稿与截图；保留 _lastSubmittedText 供失败重试。
      _lastSubmittedText = text;
      _draft.clear();
      _screenshotBytes = null;
      _captureInfo = null;
      _pendingSubmit = null;
      setState(() {
        _busy = false;
        _ticketId = result.feedbackId;
        _idempotencyKey = null;
        _kaneoUrl = null;
        _errorSummary = null;
        _failedNotice = null;
        _stage = _stageForStatus(result.status);
      });
      _schedulePollingIfNeeded();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 401) return; // 已回登录视图，草稿保留。
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
        _stage = FeedbackStage.compose;
        _composeError = _friendlyApiError(e);
      });
    } catch (_) {
      if (!mounted) return;
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
    if (id == null || _busy) return;
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
    if (!mounted) return;
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
    });
    // 记录回到可轮询状态（received/processing/archiving）时恢复轮询。
    if (_isPollable(stage)) _schedulePollingIfNeeded();
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
      _failedNotice = copied
          ? '反馈 ID 已复制到剪贴板'
          : '剪贴板不可用，请手动记录反馈 ID：$id';
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
      _screenshotBytes = null;
      _captureInfo = null;
    }
    setState(() {
      _stage = FeedbackStage.compose;
      _ticketId = null;
      _kaneoUrl = null;
      _errorSummary = null;
      _composeError = null;
      _failedNotice = null;
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
    if (id == null || !mounted || _pollInFlight) return;
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
    if (!mounted || _ticketId != id) return;
    if (record != null) {
      final FeedbackRecord rec = record;
      final FeedbackStage stage = _stageForStatus(rec.status);
      setState(() {
        _stage = stage;
        _kaneoUrl = rec.kaneoUrl;
        _errorSummary = rec.errorSummary;
      });
      if (!_isPollable(stage)) {
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
    final ScaffoldMessengerState? messenger =
        ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(
      content: Text(launched ? '正在打开归档链接…' : '链接已复制到剪贴板'),
      behavior: SnackBarBehavior.floating,
      width: 280,
    ));
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
      case 'too_large':
        return '内容超出大小限制';
      case 'not_found':
        return '未找到该反馈记录';
      default:
        return e.message ?? '服务返回错误（${e.statusCode}）';
    }
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      child: Row(
        children: <Widget>[
          Icon(Icons.feedback_outlined, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '反馈',
              style: Theme.of(context).textTheme.titleMedium,
            ),
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
    if (!_authReady) {
      return const Center(child: CircularProgressIndicator());
    }
    if (!_signedIn) return _buildLoginView(context);
    if (_busy &&
        (_stage == FeedbackStage.compose ||
            _stage == FeedbackStage.notSent)) {
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
        return _buildStatusNotice(
          title: '已接收',
          subtitle: '您的反馈已保存，等待后台处理…',
          icon: _statusIcon(
              Icons.mark_email_read_outlined, Icons.check_circle_outline),
        );
      case FeedbackStage.processing:
        return _buildStatusNotice(
          title: '处理中',
          subtitle: '正在整理您的反馈，请稍候…',
          icon: _statusIcon(Icons.autorenew, Icons.pending_outlined),
        );
      case FeedbackStage.archived:
        return _buildStatusNotice(
          title: '已归档',
          subtitle: '感谢您的反馈，已记录到任务看板。',
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
              if (footnote != null) ...<Widget>[
                const SizedBox(height: 12),
                footnote,
              ],
              if (extra.isNotEmpty) ...<Widget>[
                const SizedBox(height: 24),
                for (final Widget button in extra) ...<Widget>[
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

  Widget _buildLoginView(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text('登录后即可提交反馈', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 16),
            if (kIsWeb) ...<Widget>[
              Text(
                '将打开 Feedback 服务的登录窗口，授权完成后自动返回本面板。',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                key: const Key('feedback-web-login'),
                onPressed: _busy ? null : _webHandshake,
                icon: const Icon(Icons.login, size: 18),
                label: Text(_popupBlocked ? '打开登录窗口' : '登录'),
              ),
              if (_popupBlocked) ...<Widget>[
                const SizedBox(height: 12),
                Text(
                  _handshakeError ?? '',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ] else if (_handshakeError != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(
                  _handshakeError!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ],
            ] else ...<Widget>[
              TextField(
                key: const Key('feedback-login-username'),
                controller: _username,
                focusNode: _usernameFocus,
                enabled: !_busy,
                autofillHints: const <String>[AutofillHints.username],
                decoration: const InputDecoration(
                  labelText: '用户名',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('feedback-login-password'),
                controller: _password,
                enabled: !_busy,
                obscureText: true,
                autofillHints: const <String>[AutofillHints.password],
                onSubmitted: (_) => _nativeLogin(),
                decoration: const InputDecoration(
                  labelText: '密码',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              if (_loginError != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(
                  _loginError!,
                  key: const Key('feedback-login-error'),
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('feedback-login-submit'),
                onPressed: _busy ? null : _nativeLogin,
                child: _busy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('登录'),
              ),
              const SizedBox(height: 8),
              Text(
                '登录令牌将安全存储在本设备。',
                style: Theme.of(context).textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildComposeView(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final int runes = _draft.text.runes.length;
    final bool nearLimit = runes >= kFeedbackMaxTextRunes;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
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
                      size: 18, color: theme.colorScheme.onErrorContainer),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _composeError!,
                      style:
                          TextStyle(color: theme.colorScheme.onErrorContainer),
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (_screenshotBytes != null) ...<Widget>[
            Container(
              key: const Key('feedback-screenshot-wrap'),
              height: 120,
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              clipBehavior: Clip.antiAlias,
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  GestureDetector(
                    key: const Key('feedback-screenshot-thumb'),
                    onTap: () => _openZoomDialog(context),
                    child: Image.memory(
                      _screenshotBytes!,
                      fit: BoxFit.cover,
                    ),
                  ),
                  Positioned(
                    top: 6,
                    left: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.black54,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text(
                        '当前截图 (点击放大)',
                        style: TextStyle(color: Colors.white, fontSize: 10),
                      ),
                    ),
                  ),
                  Positioned(
                    bottom: 6,
                    right: 6,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        if (widget.onRetakeScreenshot != null)
                          IconButton.filledTonal(
                            key: const Key('feedback-retake-btn'),
                            visualDensity: VisualDensity.compact,
                            tooltip: '重新截图',
                            icon: const Icon(Icons.refresh, size: 16),
                            onPressed: widget.onRetakeScreenshot,
                          ),
                        const SizedBox(width: 4),
                        IconButton.filledTonal(
                          key: const Key('feedback-remove-screenshot-btn'),
                          visualDensity: VisualDensity.compact,
                          tooltip: '移除截图',
                          icon: const Icon(Icons.delete_outline, size: 16),
                          onPressed: () {
                            setState(() {
                              _screenshotBytes = null;
                              _captureInfo = null;
                            });
                          },
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
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
          const SizedBox(height: 10),
          Row(
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
              const Spacer(),
              FilledButton.icon(
                key: const Key('feedback-submit'),
                onPressed: _canSubmit ? _submit : null,
                icon: const Icon(Icons.send_outlined, size: 18),
                // Class A（未送达）时按钮语义是重试：同 key 同字节重发，
                // 快照变化（改文案 / 换图 / 移图）则自动换新 key。
                label: Text(
                  _stage == FeedbackStage.notSent ? '重试提交' : '提交',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _openZoomDialog(BuildContext context) {
    if (_screenshotBytes == null) return;
    showDialog<void>(
      context: context,
      builder: (BuildContext ctx) {
        return Dialog(
          backgroundColor: Colors.transparent,
          insetPadding: const EdgeInsets.all(16),
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              InteractiveViewer(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.memory(_screenshotBytes!),
                ),
              ),
              Positioned(
                top: 8,
                right: 8,
                child: IconButton(
                  key: const Key('feedback-zoom-close'),
                  style: IconButton.styleFrom(backgroundColor: Colors.black54),
                  icon: const Icon(Icons.close, color: Colors.white),
                  onPressed: () => Navigator.of(ctx).pop(),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
