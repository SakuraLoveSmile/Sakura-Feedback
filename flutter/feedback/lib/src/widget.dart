import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui
    show
        FragmentProgram,
        FragmentShader,
        Image,
        ImageByteFormat,
        ImageFilter,
        Picture,
        PictureRecorder;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart' show GestureBinding, kPrimaryButton;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart'
    show SchedulerBinding, SchedulerPhase, Ticker;
import 'package:flutter/rendering.dart'
    show Matrix4, MatrixUtils, RenderEditable, RenderRepaintBoundary;
import 'package:flutter/services.dart'
    show HardwareKeyboard, KeyDownEvent, LogicalKeyboardKey;
import 'package:http/http.dart' as http;

import 'api_client.dart'
    show
        FeedbackCaptureInfo,
        FeedbackFilePicker,
        FeedbackImagePicker,
        FeedbackLogProvider;
import 'capture_mask.dart';
import 'capture_selection.dart';
import 'config.dart';
import 'controller.dart';
import 'orb.dart';
import 'orb_liquid.dart';
import 'panel.dart';
import 'server_pref.dart';
import 'test_env.dart';
import 'token_store.dart';
import 'wake_gestures.dart';
import 'orb_idle.dart';

/// 宽屏断点：>= 此宽度时面板以侧边抽屉展开，否则全屏页面式。
const double kFeedbackWideBreakpoint = 768;

/// 宽屏侧边抽屉宽度（px，冻结视觉规格，与 Web 端一致）：
/// 实际取 `min(440, 视口宽 − 32)`。
const double kFeedbackPanelWidth = 440;

/// 宽屏侧边抽屉最大高度（px，冻结视觉规格，与 Web 端一致）：
/// 实际取 `min(720, 视口高 − 32)`，抽屉上下各留余量、不贴边不溢出；
/// `<768` 断点以下全屏（宽高用满），不受此上限约束。
const double kFeedbackPanelMaxHeight = 720;

/// 宽屏抽屉与视口边缘的最小留边（px）：宽 `视口宽 − 2×16`、
/// 高 `视口高 − 2×16`（对应两端统一的 32px 总留边）。
const double kFeedbackPanelViewportMargin = 16;

/// 两端统一图片限制：输出位图最长边（输出像素）。
const double kFeedbackCaptureMaxEdgePx = 2048;

/// 两端统一图片限制：输出位图总像素数上限。
const double kFeedbackCaptureMaxPixels = 4000000;

/// 两端统一图片限制：单次截图设备像素比上限。
const double kFeedbackCaptureMaxDevicePixelRatio = 2.0;

/// 两端统一图片限制：PNG 字节数上限（超过则按比例逐步缩小重试）。
const int kFeedbackCaptureMaxBytes = 5 * 1024 * 1024;

/// PNG 超限时逐次尝试的缩小步长（同 Web 端）。
const double kFeedbackCaptureRetryScaleStep = 0.8;

/// PNG 超限后的最多缩小重试次数（含首次共 1 + N 次编码，同 Web 端）。
const int kFeedbackCaptureRetryLimit = 3;

/// 遮挡区域映射到输出像素后向外扩张的边缘（输出像素），
/// 覆盖抗锯齿/亚像素边缘，允许多遮不允许少遮。
const double kFeedbackCaptureMaskOutsetPx = 1;

/// Esc 关闭面板意图（组件内部使用）。
class _CloseFeedbackIntent extends Intent {
  const _CloseFeedbackIntent();
}

/// 遮挡几何无法计算（已注册且可能可见的遮挡区域）时中止截图。
class _CaptureGeometryException implements Exception {
  const _CaptureGeometryException(this.message);
  final String message;

  @override
  String toString() => 'CaptureGeometryException: $message';
}

class _CaptureResult {
  const _CaptureResult(this.bytes, this.info,
      {this.containsUndrawable = false});
  final Uint8List bytes;
  final FeedbackCaptureInfo info;

  /// 捕获边界内检测到不可绘制内容（PlatformView/Texture 等）。
  final bool containsUndrawable;
}

/// 冻结捕获（T1）：RepaintBoundary → 遮挡几何登记 → `toImage` → 位图级
/// 不透明遮挡之后的**已遮挡冻结位图**与元数据。选区流程直接在这张位图上
/// 裁剪，灵感球 / 选区边框 / 遮罩 / 工具栏都不在其中（它们位于截图边界外）。
class _FrozenCapture {
  _FrozenCapture(
    this.image, {
    required this.scale,
    required this.viewport,
    required this.baseInfo,
    required this.containsUndrawable,
  });

  /// 已遮挡的冻结位图（调用方负责 [dispose]）。
  final ui.Image image;

  /// 捕获时的输出比例（逻辑像素 → 位图像素）。
  final double scale;

  /// 原始捕获视口（逻辑像素尺寸）。
  final Size viewport;

  /// 基础元数据（viewport / capturedAt / releasePoint，pixel 字段为 null）。
  final FeedbackCaptureInfo baseInfo;

  /// 捕获边界内存在不可绘制内容。
  final bool containsUndrawable;

  /// 释放冻结位图（幂等由调用方保证：只调用一次）。
  bool _released = false;
  void dispose() {
    if (_released) return;
    _released = true;
    image.dispose();
  }

  _FrozenCapture clone() => _FrozenCapture(image.clone(),
      scale: scale,
      viewport: viewport,
      baseInfo: baseInfo,
      containsUndrawable: containsUndrawable);
}

/// 截图边界坐标系（逻辑像素）下的遮挡区域。
class _LogicalMaskRegion {
  const _LogicalMaskRegion(this.rect, this.color);
  final Rect rect;
  final Color color;
}

/// 反馈组件入口：把宿主应用内容包在外层 Stack 中，
/// 提供悬浮按钮、灵感球、响应式面板与主动呼出接口。
///
/// ```dart
/// FeedbackWidget(
///   config: FeedbackConfig('https://fb.example.com', 'com.example.app'),
///   controller: controller,
///   child: MyAppHome(),
/// )
/// ```
class FeedbackWidget extends StatefulWidget {
  /// 构造组件。[controller] 省略时内部自动创建。
  const FeedbackWidget({
    super.key,
    required this.child,
    required this.config,
    this.controller,
    this.logProvider,
    this.filePicker,
    this.imagePicker,
    this.orbIdleStyle,
    this.onOrbIdleStyleChanged,
    this.wakeGestures,
    this.onWakeGesturesChanged,
    @visibleForTesting this.httpClient,
    @visibleForTesting this.tokenStore,
    @visibleForTesting this.tokenStoreFactory,
    @visibleForTesting this.serverPrefStore,
  });

  /// 被包裹的宿主内容。
  final Widget child;

  /// 连接与展示配置。
  final FeedbackConfig config;

  /// 主动呼出接口（`open()` / `close()` / `captureAndOpen()`）。
  final FeedbackController? controller;

  /// 自动日志采集提供者（可选，优先于 config.logProvider）。
  final FeedbackLogProvider? logProvider;

  /// 手动日志文件选择器（可选，优先于 config.filePicker）。
  final FeedbackFilePicker? filePicker;

  /// 手动图片选择器（可选，优先于 config.imagePicker；v12）。
  final FeedbackImagePicker? imagePicker;

  /// 宿主可控的灵感球待机样式（v0.8.4 新增，可选）。
  ///
  /// 提供时组件不再写入自己的待机样式偏好，直接按该值渲染；用户在内置设置里
  /// 改选时会回调 [onOrbIdleStyleChanged]，宿主保存后把新值回传即可。为 `null`
  /// 时保持旧行为：组件自行持久化，按宿主 `appId` 记忆。建议同时提供回调；
  /// 只提供值时面板内不显示灵感球设置项（由宿主 UI 负责改写）。
  final FeedbackOrbIdleStyle? orbIdleStyle;

  /// 宿主托管的待机样式变更回调（与 [orbIdleStyle] 配套）。
  final ValueChanged<FeedbackOrbIdleStyle>? onOrbIdleStyleChanged;

  /// 宿主可控的唤醒手势集合（v0.8.4 新增，可选）。
  ///
  /// 提供时组件不再写入自己的唤醒手势偏好，按该集合启用识别；用户在内置设置
  /// 里勾选时会回调 [onWakeGesturesChanged]。为 `null` 时保持旧行为。
  final Set<FeedbackWakeGesture>? wakeGestures;

  /// 宿主托管的唤醒手势变更回调（与 [wakeGestures] 配套）。
  final ValueChanged<Set<FeedbackWakeGesture>>? onWakeGesturesChanged;

  /// 测试注入的 HTTP 客户端。
  @visibleForTesting
  final http.Client? httpClient;

  /// 测试注入的令牌仓库。
  @visibleForTesting
  final FeedbackTokenStore? tokenStore;

  /// 测试注入的令牌仓库工厂（按有效配置派生，服务身份间隔离）。
  @visibleForTesting
  final FeedbackTokenStore Function(FeedbackConfig config)? tokenStoreFactory;

  /// 测试注入的服务器覆盖偏好仓库。
  @visibleForTesting
  final FeedbackServerPrefStore? serverPrefStore;

  @override
  State<FeedbackWidget> createState() => _FeedbackWidgetState();
}

class _FeedbackWidgetState extends State<FeedbackWidget>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  FeedbackController? _internalController;
  bool _everOpened = false;
  late FeedbackServerPrefStore _wakePrefStore;
  late final FeedbackWakePreferences _wakePreferences;
  late final FeedbackOrbIdlePreferences _idlePreferences;
  Timer? _orbIdleTimer;
  int _orbIdleGeneration = 0;
  bool _orbCollapsed = false;
  bool _orbWasAvailable = false;
  Offset _orbIdleDockCenter = Offset.zero;
  bool _snappingOrbMorph = false;
  late final AnimationController _orbMorph = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 420))
    ..addListener(() {
      if (mounted && !_disposed && !_snappingOrbMorph) setState(() {});
    });

  bool get _orbMorphVisible => _orbCollapsed || _orbMorph.value > 0;
  double get _orbMorphProgress =>
      1 - math.pow(1 - _orbMorph.value, 3).toDouble();
  void _snapOrbMorph(double value) {
    _snappingOrbMorph = true;
    _orbMorph.stop();
    _orbMorph.value = value;
    _snappingOrbMorph = false;
  }

  /// 生效的灵感球待机样式：宿主提供时以宿主值为准（v0.8.4），否则用组件
  /// 自己持久化的偏好。
  FeedbackOrbIdleStyle get _orbIdleStyle =>
      widget.orbIdleStyle ?? _idlePreferences.style;

  /// 生效的唤醒手势：宿主提供时以宿主值为准（v0.8.4）。
  Set<FeedbackWakeGesture> get _wakeGestures =>
      widget.wakeGestures ?? _wakePreferences.enabled;

  /// 「仅本次生效」只描述组件自身持久化失败；宿主托管时由宿主负责保存。
  bool get _orbIdleSessionOnly =>
      widget.orbIdleStyle == null && _idlePreferences.sessionOnly;

  bool get _wakeGesturesSessionOnly =>
      widget.wakeGestures == null && _wakePreferences.sessionOnly;

  /// 入口是否可见：只看宿主配置。
  ///
  /// 待机样式「隐藏」（v0.8.2 新增、v0.8.5 澄清语义）不是入口开关：入口可见性
  /// （唤醒手势可用性、透镜快照、面板关闭后的焦点回归等）必须与完整球状态一致，
  /// 否则选择「隐藏」会把唤醒能力一并禁用。待机隐藏只影响 build 时是否渲染
  /// launcher slot，见 [_orbIdleHidden]。
  bool get _launcherVisible => widget.config.showLauncher;

  /// 待机（收起）状态下不渲染入口：仅灵感球模式 + 待机样式「隐藏」+ 已收起 /
  /// 正在收起。完整球（初始、刚唤醒、面板关闭后）仍按 [_launcherVisible] 正常
  /// 渲染；`launcherMode == tab` 的悬浮按钮与灵感球无关，不受影响。
  bool get _orbIdleHidden =>
      widget.config.launcherMode == FeedbackLauncherMode.orb &&
      _orbIdleStyle == FeedbackOrbIdleStyle.hidden &&
      _orbMorphVisible;

  bool get _orbAvailable =>
      _appResumed &&
      _launcherVisible &&
      widget.config.launcherMode == FeedbackLauncherMode.orb &&
      !_controller.isOpen &&
      _selectionCapture == null &&
      !_temporarilyHideForCapture &&
      _capturePendingSeq == null &&
      _handoff == null;
  bool get _orbCanIdle =>
      _orbAvailable &&
      !_isDragging &&
      // Flutter retires an interpolation ticker one frame after its exact end.
      // Start the next idle interval at the visible full-orb endpoint instead.
      _orbMorph.value == 0 &&
      !_orbPressed &&
      _orbPointer == null &&
      !_orbHovered &&
      !(_orbFocusNode.hasFocus && _orbLastInputKeyboard);

  void _cancelOrbIdle() {
    _orbIdleTimer?.cancel();
    _orbIdleTimer = null;
    ++_orbIdleGeneration;
  }

  void _resetOrbIdle() {
    _cancelOrbIdle();
    _orbCollapsed = false;
    _snapOrbMorph(0);
    _orbWasAvailable = false;
  }

  void _syncOrbIdle() {
    final bool available = _orbAvailable;
    if (!available || !_orbWasAvailable) {
      _cancelOrbIdle();
      _orbCollapsed = false;
      _snapOrbMorph(0);
    }
    _orbWasAvailable = available;
    if (!_orbCanIdle) {
      _cancelOrbIdle();
      return;
    }
    if (_orbCollapsed || _orbIdleTimer != null) return;
    final int generation = _orbIdleGeneration;
    _orbIdleTimer = Timer(const Duration(seconds: 5), () {
      _orbIdleTimer = null;
      if (!mounted ||
          _disposed ||
          generation != _orbIdleGeneration ||
          !_orbCanIdle) {
        return;
      }
      setState(() => _orbCollapsed = true);
      if (_orbGlowReduced) {
        _snapOrbMorph(1);
      } else {
        _orbMorph.forward();
      }
    });
  }

  void _wakeOrb() {
    if (!_orbAvailable) return;
    _cancelOrbIdle();
    // 从待机隐藏唤醒时屏幕上看不到收起把手，展开动画没有可衔接的起点：
    // 直接把形变归零，完整球立即出现（与 reduced motion 的即时唤醒一致）。
    final bool fromIdleHidden = _orbIdleHidden;
    setState(() {
      _orbCollapsed = false;
      _orbWasAvailable = true;
    });
    if (_orbGlowReduced || fromIdleHidden) {
      _snapOrbMorph(0);
    } else {
      _orbMorph.reverse();
    }
  }

  void _idlePreferencesChanged() => _applyOrbIdleStyleChange();

  /// 生效的待机样式变化（组件偏好或宿主托管值）：无论切到「隐藏」还是改回
  /// 其他样式，都从完整球重新开始 5 秒计时（切到「隐藏」也不例外：先恢复
  /// 完整球，闲置后才进入待机隐藏）。唤醒能力由 [_wakeAvailable] 与手势识别
  /// 器的 `enabled` 决定，不随该偏好取消；这里只清理拖动 / 回弹 / 焦点残留，
  /// 避免样式切换时留下悬空状态。
  void _applyOrbIdleStyleChange() {
    if (!mounted || _disposed) return;
    // 只中止当前一轮识别（未完成的手势需要重新开始），不禁用识别器：否则
    // 待机隐藏后已开启的唤醒手势会失效。
    _wakeRecognizer?.cancel();
    setState(() {
      _orbFocusVisible = false;
      // 内含 _resetOrbIdle：从完整球重新开始 5 秒计时。
      _resetOrbReleaseState();
    });
  }

  FeedbackWakeGestureRecognizer? _wakeRecognizer;
  bool _wakeReleaseHint = false;
  bool _appResumed = true;
  int? _capturePendingSeq;

  /// 唤醒手势是否可用。待机样式「隐藏」只让入口在收起时不渲染，不影响这里：
  /// 否则隐藏待机后手势失效，用户再也无法呼出完整球（未开启手势时仍可由宿主
  /// `controller.open()` 打开面板改回）。
  bool get _wakeAvailable =>
      !_disposed &&
      mounted &&
      _appResumed &&
      _launcherVisible &&
      widget.config.launcherMode == FeedbackLauncherMode.orb &&
      widget.config.captureMode == FeedbackCaptureMode.viewport &&
      !_controller.isOpen &&
      _selectionCapture == null &&
      !_temporarilyHideForCapture &&
      _capturePendingSeq == null &&
      _handoff == null &&
      !_isDragging &&
      _orbPointer == null;

  void _setWakeReleaseHint(bool value) {
    if (_wakeReleaseHint == value || _disposed || !mounted) return;
    _wakeReleaseHint = value;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_disposed) setState(() {});
      });
    } else {
      setState(() {});
    }
  }

  void _wakePreferencesChanged() {
    if (!mounted || _disposed) return;
    _syncWakeRecognizer();
    setState(() {});
  }

  /// 把生效的唤醒手势同步给注册中的识别器（组件偏好与宿主托管共用）。
  void _syncWakeRecognizer() {
    if (!mounted || _disposed) return;
    _wakeRecognizer?.enabled = _wakeGestures;
  }

  void _onWake(Offset releaseGlobal) {
    if (!_wakeAvailable) return;
    _wakeOrb();
  }

  /// 上一次观察到的面板开关状态：只有 open→closed 的真实翻转才把焦点还给
  /// 入口；关闭期间的普通通知（未读数、地址）不得抢宿主焦点。
  bool _panelWasOpen = false;

  /// 最近一次输入的模态：true = 键盘，false = 指针（鼠标 / 触控 / 笔）。
  /// 关闭面板后的焦点回归按它决定是否点亮 focus-visible 环（spec 5：
  /// 鼠标聚焦不显示环）。初始为指针，键盘事件到达后才转为键盘。
  bool _orbLastInputKeyboard = false;

  /// 一次性抑制：指针模态的焦点回归只移动焦点、不点亮环。
  bool _orbSuppressRingOnce = false;

  /// 全局指针路由：新增 / 移除用同一引用，避免 tear-off 相等性依赖。
  late final void Function(PointerEvent) _globalPointerRoute =
      _handleGlobalPointerDown;
  bool _temporarilyHideForCapture = false;

  /// 捕获会话序号：每次开始新捕获会话自增。会话有效性以
  /// `seq == _captureSeq` 判断；取消 / 关闭 / 销毁 / 控制器替换 / 新会话
  /// 都会使旧会话失效，旧请求不得再交付结果或恢复新请求的 UI。
  int _captureSeq = 0;

  /// T1：拖动灵感球后的进行中局部选区流程（已冻结位图、等待用户确认）。
  /// 会话失效 / 取消 / 销毁时立即丢弃并释放位图。
  _FrozenCapture? _selectionCapture;

  /// 组件正在销毁（dispose 中）：禁止任何 setState。
  bool _disposed = false;

  /// 本组件实例私有的遮挡作用域：不同组件实例的遮挡注册互不影响。
  final FeedbackCaptureScope _captureScope = FeedbackCaptureScope();

  final GlobalKey _repaintBoundaryKey = GlobalKey();
  final GlobalKey<FeedbackPanelState> _panelKey =
      GlobalKey<FeedbackPanelState>();

  /// 球盒锚点：C 路线把捕获图像像素映射回球盒时，需要球盒的全局左上角。
  final GlobalKey _orbLensAnchorKey = GlobalKey();

  final ValueNotifier<_OrbLensSnapshot?> _lensSnapshot =
      ValueNotifier<_OrbLensSnapshot?>(null);
  ui.FragmentProgram? _lensProgramCache;
  ui.FragmentShader? _selectionShader;
  bool _lensProgramUnavailable = false;
  int? _lensCaptureGeneration;
  int? _lensPendingCaptureGeneration;
  bool get _lensCaptureInFlight => _lensCaptureGeneration != null;
  final Stopwatch _lensGate = Stopwatch();
  int _lensGeneration = 0;
  bool _lensPrefetchDone = false;
  bool _lensFirstCaptureScheduled = false;
  Timer? _lensThemeRefresh;
  Timer? _lensRefreshTimer;
  Brightness? _lensAncestorBrightness;
  Brightness _lensPlatformBrightness =
      WidgetsBinding.instance.platformDispatcher.platformBrightness;
  Size? _sessionViewport;
  double? _sessionDpr;
  Size? _lastViewport;
  double? _lastDpr;
  bool _viewportInvalidationScheduled = false;
  bool _selectionBusy = false;
  String? _selectionError;
  Offset? _selectionOrbCenter;
  Offset _selectionDirection = const Offset(1, 0);
  double _selectionDeform = 0;
  double _selectionWobble = 0;
  double _selectionRadius = 52;
  double _orbRenderedRadius = 28;
  final OrbLiquid _liquid = OrbLiquid();
  late final Ticker _liquidTicker = createTicker(_tickLiquid);
  Duration _liquidPrevious = Duration.zero;
  Offset? _orbDockGlobal;
  Offset? _orbPointerStart;
  _CaptureHandoff? _handoff;
  late final AnimationController _handoffAnimation = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1500))
    ..addListener(_tickHandoff);

  double get _dpr =>
      MediaQuery.maybeDevicePixelRatioOf(context) ??
      View.of(context).devicePixelRatio;

  bool _captureSessionValid(int seq) {
    if (_disposed || !mounted || seq != _captureSeq) return false;
    final RenderRepaintBoundary? boundary = _repaintBoundaryKey.currentContext
        ?.findRenderObject() as RenderRepaintBoundary?;
    return boundary != null &&
        boundary.attached &&
        (_sessionViewport == null ||
            (boundary.size == _sessionViewport &&
                (_lastViewport == null ||
                    _lastViewport == _sessionViewport))) &&
        (_sessionDpr == null || _dpr == _sessionDpr);
  }

  void _tickLiquid(Duration elapsed) {
    final double dt = (elapsed - _liquidPrevious).inMicroseconds / 1000000;
    _liquidPrevious = elapsed;
    _liquid.advance(dt, moving: _isDragging, reducedMotion: _orbGlowReduced);
    if (mounted && !_disposed) setState(() {});
    if (!_isDragging && _liquid.settled) _liquidTicker.stop();
  }

  void _kickLiquid() {
    if (_orbGlowReduced) {
      _snapOrbMorph(_orbCollapsed ? 1 : 0);
      _liquid.advance(0, moving: _isDragging, reducedMotion: true);
    } else if (!_liquidTicker.isActive) {
      _liquidPrevious = Duration.zero;
      _liquidTicker.start();
    }
  }

  void _resetLiquid() {
    _liquidTicker.stop();
    _liquid.reset();
    _orbPointerStart = null;
    _orbDockGlobal = null;
  }

  void _tickHandoff() {
    final _CaptureHandoff? flow = _handoff;
    if (flow == null || !_captureSessionValid(flow.seq)) return;
    final double ms = _handoffAnimation.value * 1500;
    _panelKey.currentState?.setCaptureHandoffProgress(
        flow.target == null ? 1 : orbSmoothstep(1220, 1350, ms));
    if (ms >= 1350) _panelKey.currentState?.endCaptureHandoff();
    if (ms >= 1500) {
      _finishHandoff(focus: true);
    } else if (mounted) {
      setState(() {});
    }
  }

  void _finishHandoff({bool focus = false}) {
    final _CaptureHandoff? flow = _handoff;
    _handoff = null;
    _handoffAnimation.stop();
    _panelKey.currentState?.endCaptureHandoff();
    if (flow != null) {
      _disposeAfterFrame(flow.image);
      _disposeAfterFrame(flow.background);
      if (focus && _captureSessionValid(flow.seq) && _controller.isOpen) {
        _panelKey.currentState?.requestDraftInputFocus(
            isCurrent: () =>
                _captureSessionValid(flow.seq) &&
                _controller.isOpen &&
                _handoff == null);
      }
    }
    if (flow != null && mounted && !_disposed) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appResumed = state == AppLifecycleState.resumed;
    _resetOrbIdle();
    if (_appResumed) {
      if (mounted) setState(() {});
      return;
    }
    _wakeRecognizer?.cancel();
    _invalidateCaptureSession();
    // A paused app may not draw another frame before resuming. Re-open the
    // visibility prefetch here rather than relying on a hidden build to do it.
    _releaseLensSnapshot(allowPrefetch: true);
    _resetOrbReleaseState();
    if (mounted) setState(() {});
  }

  @override
  void didChangePlatformBrightness() {
    final Brightness brightness =
        WidgetsBinding.instance.platformDispatcher.platformBrightness;
    if (brightness == _lensPlatformBrightness) return;
    _lensPlatformBrightness = brightness;
    _invalidateLensTheme();
    if (mounted && !_disposed) setState(() {});
  }

  // 灵感球拖拽状态
  bool _isDragging = false;
  bool _orbHovered = false;
  bool _orbPressed = false;
  bool _orbPressTransition = false;

  /// 当前被灵感球接受的指针 id；非空表示已有活跃指针，第二指一律忽略。
  /// 与 Web 的 `orbPointerId` 守卫同一口径（spec 5.2）。
  int? _orbPointer;

  /// 灵感球键盘焦点节点：由 Tab 聚焦，鼠标点击不请求焦点。
  final FocusNode _orbFocusNode = FocusNode(debugLabel: 'feedback-orb');

  /// 键盘聚焦后锁存的焦点环（spec 5）。pressed / dragging / hover 不清除；
  /// 清除来源为失焦、hidden，以及指针关闭后的单次抑制（T7i）。
  /// 环本身不参与布局与命中。
  bool _orbFocusVisible = false;

  double get _orbTargetStateScale {
    if (_isDragging) return 1.0;
    if (_orbPressed) return kFeedbackOrbPressedScale;
    if (_orbHovered) return kFeedbackOrbHoverScale;
    return 1.0;
  }

  void _setOrbPressed(bool pressed) {
    if (_orbPressed == pressed) return;
    setState(() {
      _orbPressTransition = true;
      _orbPressed = pressed;
    });
  }

  /// 拖动清理专用的状态提交。
  ///
  /// `onPanCancel` 有两条来源：正常的手势取消（指针事件路径，调度相位是 idle），
  /// 以及**入口在拖动中被隐藏**——此时 `RawGestureDetectorState.dispose` 会在
  /// 卸载过程中 reject 手势并回调过来，而那一刻 widget 树是锁定的，直接
  /// `setState` 会抛 `widget tree was locked`（球在拖动中打开面板即可复现）。
  /// 所以这里按调度相位分流：idle 走同步 setState 保持既有同帧语义，帧内被回调
  /// 则先落字段、推迟一帧再通知，状态结果一致。
  ///
  /// 这里**不**释放 `_orbPointer`：手势取消不等于指针抬起（pan 输掉竞争时指针
  /// 仍按着），清掉会让第二指被当成首指放进来。释放只走 `onPointerUp` /
  /// `onPointerCancel`——入口在按下期间被隐藏也不例外，Flutter 按指针保留按下时
  /// 的命中路径，抬起仍会派发到已 detach 的 `Listener`。
  void _cleanUpOrbPan(VoidCallback mutate) {
    if (_disposed || !mounted) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.idle) {
      setState(mutate);
      return;
    }
    mutate();
    final int seq = _captureSeq;
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted && !_disposed && seq == _captureSeq) setState(() {});
    });
  }

  /// hidden 抢占进行中的拖动 / 回弹 / 悬停时集中复位（spec 5）：球体卸载会让
  /// 回弹 tween 的 onEnd 永不触发，MouseRegion 在 detach 后也不再派发 onExit。
  /// 悬停无需手工恢复：恢复帧的 MouseTracker 会按指针实际位置重新补发
  /// onEnter。调用方负责触发重建。
  void _resetOrbReleaseState() {
    _resetOrbIdle();
    _resetLiquid();
    _orbPressTransition = false;

    _isDragging = false;
    _orbPressed = false;

    _orbHovered = false;
  }

  bool _orbGlowReduced = false;

  FeedbackController get _controller =>
      widget.controller ?? (_internalController ??= FeedbackController());

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _panelWasOpen = _controller.isOpen;
    _everOpened = _controller.isOpen;
    _appResumed = WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _wakePrefStore = widget.serverPrefStore ?? createDefaultServerPrefStore();
    _wakePreferences = FeedbackWakePreferences(
        appId: widget.config.appId, store: _wakePrefStore)
      ..addListener(_wakePreferencesChanged);
    unawaited(_wakePreferences.load());
    _idlePreferences = FeedbackOrbIdlePreferences(
        appId: widget.config.appId, store: _wakePrefStore)
      ..addListener(_idlePreferencesChanged);
    unawaited(_idlePreferences.load());
    HardwareKeyboard.instance.addHandler(_handleGlobalKeyEvent);
    GestureBinding.instance.pointerRouter.addGlobalRoute(_globalPointerRoute);
    _bindController(_controller);
  }

  /// 全应用键盘事件：记录模态并清理抑制，绝不消费（返回 false）。唯一例外
  /// 是「球已持有焦点但环被抑制」时按键补点亮，见下方分支。
  bool _handleGlobalKeyEvent(KeyEvent event) {
    if (event is KeyDownEvent) {
      _orbLastInputKeyboard = true;
      _orbSuppressRingOnce = false;
      // 指针模态回归后球已持有焦点：下一次键盘输入按 focus-visible 语义
      // 补点亮，避免抑制导致「焦点在球上却永远无环」。
      if (mounted && !_orbFocusVisible && _orbFocusNode.hasPrimaryFocus) {
        setState(() => _orbFocusVisible = true);
      }
    }
    return false;
  }

  /// 全应用指针按下（含面板按钮、遮罩、宿主区域）：最近输入转为指针模态，
  /// 并清掉悬空抑制，避免吞掉下一次键盘聚焦的环。
  void _handleGlobalPointerDown(PointerEvent event) {
    if (event is! PointerDownEvent) return;
    _orbLastInputKeyboard = false;
    _orbSuppressRingOnce = false;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final Brightness? brightness = Theme.maybeBrightnessOf(context);
    if (_lensAncestorBrightness != null &&
        brightness != _lensAncestorBrightness) {
      _invalidateLensTheme();
    }
    _lensAncestorBrightness = brightness;
    _orbGlowReduced = MediaQuery.disableAnimationsOf(context);
    if (_orbGlowReduced) {
      _snapOrbMorph(_orbCollapsed ? 1 : 0);
      _liquid.advance(0, moving: _isDragging, reducedMotion: true);
      _liquidTicker.stop();
      if (_handoff != null) {
        final int seq = _handoff!.seq;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_captureSessionValid(seq)) _finishHandoff(focus: true);
        });
      }
    }
  }

  // Neutral glass has no idle ticker or legacy brand/sweep/breathing layer.
  void _syncOrbFlow() {}

  /// 可见时持续串行更新已遮挡的背景；hidden 时释放快照并停止更新。
  ///
  /// 待机隐藏（收起且样式为「隐藏」）视同不可见：入口不在屏幕上，透镜采样
  /// 没有意义，快照随之释放；唤醒后按既有规则重新捕获。
  /// 每次成功完成后间隔 250ms 再捕获；失败停止，直到下次显式刷新。
  bool get _lensVisible =>
      _appResumed &&
      !_controller.isOpen &&
      _capturePendingSeq == null &&
      _selectionCapture == null &&
      !_temporarilyHideForCapture &&
      _handoff == null &&
      _launcherVisible &&
      !_orbIdleHidden &&
      !MediaQuery.highContrastOf(context) &&
      widget.config.launcherMode == FeedbackLauncherMode.orb;

  void _invalidateLensTheme() {
    // Decoration only: never invalidate the frozen selection, draft, release
    // geometry, or the in-progress morph. Old in-flight captures lose their
    // generation before another frame can publish them.
    _releaseLensSnapshot(allowPrefetch: true);
    _lensThemeRefresh?.cancel();
    // MaterialApp animates its host colors for this default duration. A bounded
    // trailing refresh also coalesces its halfway brightness change. The normal
    // masked capture still waits for paint; no transitional/old sampler is used.
    _lensThemeRefresh = Timer(kThemeAnimationDuration, () {
      _lensThemeRefresh = null;
      if (mounted && !_disposed && _lensVisible) setState(() {});
    });
  }

  void _syncOrbLensCapture(
      {required bool open, required FeedbackConfig config}) {
    if (!_lensVisible) {
      _cancelLensRefresh();
      _lensPrefetchDone = false;
      _lensPendingCaptureGeneration = null;
      if (_lensSnapshot.value != null || _lensCaptureInFlight) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !_disposed && !_lensVisible) {
            _releaseLensSnapshot(allowPrefetch: true);
          }
        });
      }
      return;
    }
    if (debugDisableOrbLensCapture ||
        _lensThemeRefresh != null ||
        _lensPrefetchDone ||
        _lensFirstCaptureScheduled) {
      return;
    }
    _lensFirstCaptureScheduled = true;
    final int generation = _lensGeneration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _disposed || generation != _lensGeneration) return;
      _lensFirstCaptureScheduled = false;
      if (!_lensVisible) return;
      _lensPrefetchDone = true;
      unawaited(_captureLensSnapshot());
    });
  }

  void _releaseLensSnapshot({bool allowPrefetch = false}) {
    _cancelLensRefresh();
    ++_lensGeneration;
    _lensPendingCaptureGeneration = null;
    _lensFirstCaptureScheduled = false;
    _lensPrefetchDone = !allowPrefetch;
    _clearLensImage();
  }

  void _clearLensImage() {
    final _OrbLensSnapshot? previous = _lensSnapshot.value;
    _lensSnapshot.value = null;
    if (previous != null) _disposeLensAfterFrame(previous);
  }

  void _disposeLensAfterFrame(_OrbLensSnapshot snapshot) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      snapshot.shader.dispose();
      snapshot.image.dispose();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  void _releaseSelectionShader() {
    final ui.FragmentShader? shader = _selectionShader;
    _selectionShader = null;
    if (shader == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => shader.dispose());
    WidgetsBinding.instance.scheduleFrame();
  }

  void _disposeAfterFrame(ui.Image image) {
    WidgetsBinding.instance.addPostFrameCallback((_) => image.dispose());
    WidgetsBinding.instance.scheduleFrame();
  }

  void _cancelLensRefresh() {
    _lensRefreshTimer?.cancel();
    _lensRefreshTimer = null;
  }

  void _scheduleLensRefresh(
      {bool allowMissing = false, bool keepExisting = false}) {
    if (!_lensVisible || (!allowMissing && _lensSnapshot.value == null)) return;
    if (keepExisting && _lensRefreshTimer != null) return;
    _cancelLensRefresh();
    _lensRefreshTimer = Timer(debugOrbLensGateDuration, () {
      _lensRefreshTimer = null;
      if (!mounted || _disposed) return;
      // Lifecycle/identity changes cancel this timer. Scroll keeps its deadline
      // but uses the latest generation, so repeated notifications neither fire
      // a full capture every frame nor postpone the final sample indefinitely.
      unawaited(_captureLensSnapshot(fromRefreshTimer: true));
    });
  }

  Future<void> _captureLensSnapshot({bool fromRefreshTimer = false}) async {
    if (debugDisableOrbLensCapture ||
        _lensThemeRefresh != null ||
        _disposed ||
        !mounted ||
        !_lensVisible) {
      return;
    }
    // Explicit drag requests share the same bounded cadence. A missing texture
    // may refresh immediately; the completion timer has already waited its gap.
    if (!fromRefreshTimer &&
        _lensSnapshot.value != null &&
        _lensGate.isRunning &&
        _lensGate.elapsed < debugOrbLensGateDuration) {
      return;
    }
    if (_lensCaptureInFlight) {
      // A return/identity change may request a new generation before the old
      // engine future finishes. Coalesce that request once; another trigger in
      // the current generation must not queue a retry of the same attempt.
      if (_lensCaptureGeneration != _lensGeneration) {
        _lensPendingCaptureGeneration = _lensGeneration;
      }
      return;
    }
    _cancelLensRefresh();
    final int generation = ++_lensGeneration;
    final RenderRepaintBoundary? boundary = _repaintBoundaryKey.currentContext
        ?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null || !boundary.attached || boundary.size.isEmpty) return;
    final Size size = boundary.size;
    final double dpr = _dpr;
    bool current() =>
        mounted &&
        !_disposed &&
        generation == _lensGeneration &&
        _lensVisible &&
        boundary.attached &&
        boundary.size == size &&
        _dpr == dpr;
    _lensCaptureGeneration = generation;
    ui.FragmentShader? shader;
    bool captured = false;
    try {
      shader = await _lensShaderOrNull();
      if (!current()) return;
      if (shader == null) {
        _releaseLensSnapshot();
        return;
      }
      debugOrbLensCaptureAttempts++;
      if (debugFailOrbLensCapture) throw StateError('debugFailOrbLensCapture');
      final Future<void> Function()? barrier = debugOrbLensCaptureBarrier;
      if (barrier != null) {
        await barrier();
        if (!current()) return;
      }
      final _FrozenCapture? frozen = await _captureFrozen(isCurrent: current);
      if (frozen == null) {
        if (current()) _releaseLensSnapshot();
        return;
      }
      if (!current() || frozen.containsUndrawable) {
        frozen.dispose();
        if (current()) _releaseLensSnapshot();
        return;
      }
      final _OrbLensSnapshot? previous = _lensSnapshot.value;
      _lensSnapshot.value = _OrbLensSnapshot(
          image: frozen.image, pixelRatio: frozen.scale, shader: shader);
      shader = null; // the snapshot now owns its sampler and image handle
      _lensGate
        ..reset()
        ..start();
      captured = true;
      if (previous != null) _disposeLensAfterFrame(previous);
    } catch (error) {
      if (current()) {
        debugPrint('反馈组件：透镜快照不可用（${error.runtimeType}）');
        _releaseLensSnapshot();
      }
    } finally {
      shader?.dispose();
      _lensCaptureGeneration = null;
      final int? pending = _lensPendingCaptureGeneration;
      _lensPendingCaptureGeneration = null;
      if (pending != null &&
          pending == _lensGeneration &&
          mounted &&
          !_disposed &&
          _lensVisible) {
        unawaited(_captureLensSnapshot());
      } else if (captured && current()) {
        _scheduleLensRefresh();
      }
    }
  }

  Future<ui.FragmentShader?> _lensShaderOrNull() async {
    if (debugFailOrbLensShader) return null;
    if (_lensProgramCache != null) return _lensProgramCache!.fragmentShader();
    if (_lensProgramUnavailable) return null;
    // 包被宿主引用时资源键带包前缀；先试前缀，组件包自己的测试/示例回退根键。
    for (final String key in const <String>[
      'packages/feedback_widget/shaders/orb_lens.frag',
      'shaders/orb_lens.frag',
    ]) {
      try {
        final ui.FragmentProgram program =
            await ui.FragmentProgram.fromAsset(key);
        // 加载期间组件可能已被移除：此时不要再创建/缓存 shader。
        if (_disposed) return null;
        _lensProgramCache = program;
        return program.fragmentShader();
      } catch (_) {
        continue;
      }
    }
    if (_disposed) return null;
    _lensProgramUnavailable = true;
    return null;
  }

  @override
  void didUpdateWidget(FeedbackWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.config.theme != widget.config.theme) {
      _invalidateLensTheme();
    }
    if (oldWidget.serverPrefStore != widget.serverPrefStore ||
        oldWidget.config.appId != widget.config.appId) {
      _wakeRecognizer?.cancel();
      if (oldWidget.serverPrefStore != widget.serverPrefStore) {
        _wakePrefStore =
            widget.serverPrefStore ?? createDefaultServerPrefStore();
      }
      _wakePreferences.rebind(
          appId: widget.config.appId, store: _wakePrefStore);
      _idlePreferences.rebind(
          appId: widget.config.appId, store: _wakePrefStore);
    }
    if (oldWidget.config.captureMode != widget.config.captureMode) {
      _invalidateCaptureSession();
    }
    if (oldWidget.orbIdleStyle != widget.orbIdleStyle) {
      _applyOrbIdleStyleChange();
    }
    if (!setEquals(oldWidget.wakeGestures, widget.wakeGestures)) {
      _syncWakeRecognizer();
    }
    if (oldWidget.config.appId != widget.config.appId ||
        oldWidget.config.apiBase != widget.config.apiBase) {
      // 宿主身份变化时，面板的偏好读取可能仍在等待；先使截图会话失效，
      // 防止旧身份的编码结果迟到后交付给新身份。
      _invalidateCaptureSession();
      _releaseLensSnapshot(allowPrefetch: true);
      _resetOrbReleaseState();
      if (mounted && _temporarilyHideForCapture) {
        setState(() => _temporarilyHideForCapture = false);
      }
    }
    if (oldWidget.config.pageLabel != widget.config.pageLabel ||
        oldWidget.child.key != widget.child.key ||
        oldWidget.child.runtimeType != widget.child.runtimeType) {
      _invalidateCaptureSession();
      _releaseLensSnapshot(allowPrefetch: true);
      _resetOrbReleaseState();
    }
    if (oldWidget.controller != widget.controller) {
      _releaseLensSnapshot(allowPrefetch: true);
      // 控制器替换：旧会话立即失效，旧请求不得再影响新控制器的 UI。
      _invalidateCaptureSession();
      _unbindController(oldWidget.controller ?? _internalController!);
      _bindController(_controller);
      _panelWasOpen = _controller.isOpen;
      if (_controller.isOpen) _everOpened = true;
      // 换入的控制器可能已打开：入口随即 hidden，抢占进行中的回弹。
      if (_controller.isOpen) _resetOrbReleaseState();
    }
    if ((oldWidget.config.showLauncher && !_launcherVisible) ||
        (oldWidget.config.launcherMode == FeedbackLauncherMode.orb &&
            widget.config.launcherMode != FeedbackLauncherMode.orb)) {
      // 入口变为 hidden（关闭入口或离开 orb 模式）：抢占进行中的回弹，恢复
      // 可见后从静态起点开始。本次 didUpdateWidget 后必然重建（待机样式变化
      // 另外由 _applyOrbIdleStyleChange 处理）。
      _resetOrbReleaseState();
    }
  }

  int _lastControllerUnread = 0;
  String? _lastControllerBase;

  void _bindController(FeedbackController controller) {
    _lastControllerUnread = controller.unreadCount;
    _lastControllerBase = controller.effectiveApiBase;
    controller.addListener(_onControllerChanged);
    controller.onCaptureAndOpen = _captureAndOpen;
    controller.onCancelCapture = _cancelCapture;
  }

  void _unbindController(FeedbackController controller) {
    controller.removeListener(_onControllerChanged);
    controller.onCaptureAndOpen = null;
    controller.onCancelCapture = null;
  }

  void _onControllerChanged() {
    if (!mounted) return;
    final bool wasOpen = _panelWasOpen;
    if (_controller.isOpen) _wakeRecognizer?.cancel();
    final bool metadataChanged =
        _lastControllerUnread != _controller.unreadCount ||
            _lastControllerBase != _controller.effectiveApiBase;
    _lastControllerUnread = _controller.unreadCount;
    _lastControllerBase = _controller.effectiveApiBase;
    final bool closedAction =
        !_controller.isOpen && (!metadataChanged || wasOpen);
    _panelWasOpen = _controller.isOpen;
    if (_controller.isOpen) {
      _everOpened = true;
      // 呼出时把焦点请求到输入区。
      final int seq = _captureSeq;
      if (!wasOpen) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_captureSessionValid(seq) ||
              !_controller.isOpen ||
              _handoff != null) {
            return;
          }
          _panelKey.currentState?.requestInputFocus();
        });
      }
    } else if (closedAction) {
      _releaseLensSnapshot(allowPrefetch: true);
      // 面板关闭（含宿主直接调用 controller.close()）：进行中的捕获会话
      // 一并失效，捕获完成后不再挂载 / 恢复面板 UI。
      _invalidateCaptureSession();
      if (wasOpen) {
        // 面板关闭后把焦点还给入口（仅 orb 模式且入口可见）。环是否点亮
        // 取决于最近输入模态：指针模态的回归只移动焦点（spec 5：鼠标
        // 聚焦不显示环），键盘模态照常点亮。
        final int seq = _captureSeq;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_captureSessionValid(seq) || _controller.isOpen) return;
          if (!_launcherVisible ||
              widget.config.launcherMode != FeedbackLauncherMode.orb) {
            return;
          }
          if (!_orbLastInputKeyboard) _orbSuppressRingOnce = true;
          _orbFocusNode.requestFocus();
        });
      }
    }
    setState(() {
      // 面板打开即 hidden：不再输出可见回弹，并清掉会悬空的回弹状态。
      if (_controller.isOpen) _resetOrbReleaseState();
      // 关闭时同时复位"截图期间隐藏覆盖层"状态：重拍中途关闭面板后再次
      // 呼出，面板必须恢复可见（否则会一直停留在隐藏状态）。
      if (closedAction) _temporarilyHideForCapture = false;
    });
  }

  /// 开始新的捕获会话：使所有旧会话失效，并统一恢复截图期间隐藏的覆盖层
  /// （宿主布局回到常规状态后再等待 paint / 捕获）。
  void _startCaptureSession() {
    _invalidateCaptureSession();
    // Formal capture owns rasterization/encoding until completion or cancel.
    // Stop decoration synchronously, before the next refresh timer can run.
    _releaseLensSnapshot(allowPrefetch: true);
    final RenderRepaintBoundary? boundary = _repaintBoundaryKey.currentContext
        ?.findRenderObject() as RenderRepaintBoundary?;
    _capturePendingSeq = _captureSeq;
    _sessionViewport = boundary?.size;
    _sessionDpr = _dpr;
    if (mounted && _temporarilyHideForCapture) {
      setState(() => _temporarilyHideForCapture = false);
    }
  }

  /// 使当前进行中的捕获会话全部失效（取消 / 关闭 / 身份切换）。
  /// 同时作废 T1 局部选区流程：丢弃冻结画面并恢复 UI。
  void _invalidateCaptureSession() {
    _wakeRecognizer?.cancel();
    _capturePendingSeq = null;
    _captureSeq++;
    _sessionViewport = null;
    _sessionDpr = null;
    _selectionBusy = false;
    _selectionError = null;
    _releaseSelectionShader();
    _finishHandoff();
    final _FrozenCapture? selection = _selectionCapture;
    if (selection != null) {
      _selectionCapture = null;
      _disposeAfterFrame(selection.image);
      if (mounted && !_disposed) setState(() {});
    }
  }

  void _cancelCapture() {
    // 用户取消：静默使旧会话失效（不报错），旧请求不得恢复新请求 UI
    // ——此时已无新请求，可安全统一恢复覆盖层与拖拽状态。
    _invalidateCaptureSession();
    _releaseLensSnapshot(allowPrefetch: true);
    _resetOrbReleaseState();
    if (mounted) {
      setState(() {
        _isDragging = false;
        _temporarilyHideForCapture = false;
      });
    }
  }

  @override
  void deactivate() {
    // A GlobalKey reparent can detach without disposing State. It still ends
    // this viewport's capture session; no old await may revive the overlay.
    _wakeRecognizer?.cancel();
    _capturePendingSeq = null;
    ++_captureSeq;
    _cancelLensRefresh();
    ++_lensGeneration;
    _lensPendingCaptureGeneration = null;
    _resetOrbReleaseState();
    _handoffAnimation.stop();
    final _CaptureHandoff? flow = _handoff;
    _handoff = null;
    if (flow != null) {
      _disposeAfterFrame(flow.image);
      _disposeAfterFrame(flow.background);
    }
    final _FrozenCapture? frozen = _selectionCapture;
    _selectionCapture = null;
    if (frozen != null) _disposeAfterFrame(frozen.image);
    _releaseSelectionShader();
    _selectionBusy = false;
    _selectionError = null;
    _temporarilyHideForCapture = false;
    _sessionViewport = null;
    _sessionDpr = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _disposed) return;
      _releaseLensSnapshot(allowPrefetch: true);
      _panelKey.currentState?.endCaptureHandoff();
      setState(() {});
    });
    super.deactivate();
  }

  @override
  void dispose() {
    _disposed = true;
    _lensThemeRefresh?.cancel();
    _cancelLensRefresh();
    _cancelOrbIdle();
    _idlePreferences.dispose();
    _wakeRecognizer?.cancel();
    _wakePreferences.dispose();
    _orbPointer = null;
    WidgetsBinding.instance.removeObserver(this);
    _lensGeneration++;
    _lensPendingCaptureGeneration = null;
    _orbMorph.dispose();
    _liquidTicker.dispose();
    _handoffAnimation.dispose();
    final _CaptureHandoff? flow = _handoff;
    _handoff = null;
    flow?.image.dispose();
    flow?.background.dispose();
    _captureSeq++;
    final _FrozenCapture? selection = _selectionCapture;
    _selectionCapture = null;
    selection?.dispose();
    _lensSnapshot.value?.shader.dispose();
    _lensSnapshot.value?.image.dispose();
    _lensSnapshot.dispose();
    _selectionShader?.dispose();
    _selectionShader = null;
    _lensProgramCache = null;
    GestureBinding.instance.pointerRouter
        .removeGlobalRoute(_globalPointerRoute);
    HardwareKeyboard.instance.removeHandler(_handleGlobalKeyEvent);
    _orbFocusNode.dispose();
    _unbindController(_controller);
    _internalController?.dispose();
    super.dispose();
  }

  /// 最近一次由面板上报的有效地址：仅在实际变化时使外层截图会话失效
  /// （初始上报与重复上报不中断进行中的捕获）。
  String? _lastReportedApiBase;

  void _onEffectiveApiBaseChange(String base) {
    final bool changed =
        _lastReportedApiBase != null && _lastReportedApiBase != base;
    _lastReportedApiBase = base;
    _controller.setEffectiveApiBase(base);
    if (changed) {
      // T7：服务身份切换——进行中的截图会话作废，隐藏覆盖层复位，
      // 旧会话的迟到交付不得写入新身份面板。
      _invalidateCaptureSession();
      _releaseLensSnapshot(allowPrefetch: true);
      _resetOrbReleaseState();
      if (_temporarilyHideForCapture) {
        setState(() => _temporarilyHideForCapture = false);
      }
    }
  }

  void _open() => _controller.open();

  void _close() {
    // 关闭面板使进行中的捕获会话失效：捕获完成后不再挂载 / 恢复面板 UI。
    _invalidateCaptureSession();
    _controller.close();
  }

  double _parseBottom(String val, double height) {
    final String trimmed = val.trim();
    if (trimmed.endsWith('%')) {
      final double? pct =
          double.tryParse(trimmed.substring(0, trimmed.length - 1));
      if (pct != null) return height * (pct / 100.0);
    }
    if (trimmed.endsWith('px')) {
      final double? px =
          double.tryParse(trimmed.substring(0, trimmed.length - 2));
      if (px != null) return px;
    }
    final double? num = double.tryParse(trimmed);
    if (num != null) return num;
    return height * 0.25;
  }

  /// 解析单个渲染框相对截图边界的轴对齐包围盒（逻辑像素）。
  ///
  /// 将渲染框 paintBounds 的四角通过 `getTransformTo(boundary)` 变换到截图
  /// 边界坐标后取轴对齐包围盒；旋转/缩放/嵌套变换下会**多遮**（外扩），
  /// 不允许少遮。计算失败时抛出 [_CaptureGeometryException]，由调用方
  /// 决定中止截图。
  Rect _axisAlignedBoundsInBoundary(RenderBox box, RenderObject boundary) {
    if (!box.attached || !box.hasSize) {
      throw _CaptureGeometryException('遮挡渲染框未完成布局（attached=${box.attached}）');
    }
    final Matrix4 transform;
    try {
      transform = box.getTransformTo(boundary);
    } catch (e) {
      throw _CaptureGeometryException('getTransformTo(boundary) 失败: $e');
    }
    final Rect bounds = box.paintBounds;
    final List<Offset> corners = <Offset>[
      MatrixUtils.transformPoint(transform, bounds.topLeft),
      MatrixUtils.transformPoint(transform, bounds.topRight),
      MatrixUtils.transformPoint(transform, bounds.bottomLeft),
      MatrixUtils.transformPoint(transform, bounds.bottomRight),
    ];
    double minX = double.infinity, minY = double.infinity;
    double maxX = double.negativeInfinity, maxY = double.negativeInfinity;
    for (final Offset p in corners) {
      if (!p.dx.isFinite || !p.dy.isFinite) {
        throw _CaptureGeometryException('遮挡区域变换结果非有限值: $p');
      }
      minX = math.min(minX, p.dx);
      minY = math.min(minY, p.dy);
      maxX = math.max(maxX, p.dx);
      maxY = math.max(maxY, p.dy);
    }
    return Rect.fromLTRB(minX, minY, maxX, maxY);
  }

  /// 计算遮挡子树相对截图边界的轴对齐包围盒并集（逻辑像素）。
  ///
  /// [RenderBox.paintBounds] 是**自身坐标系**下的矩形（如 [RenderTransform]
  /// 不重写 paintBounds，旋转/缩放不体现），因此对子树内每个 RenderBox
  /// 分别用其 `getTransformTo(boundary)`（含中间层自身变换）把 paintBounds
  /// 四角变换到截图边界坐标后取并集——旋转/缩放/嵌套变换下整体**多遮**
  /// （外扩），不允许少遮。任一 RenderBox 计算失败时抛出
  /// [_CaptureGeometryException]，由调用方中止截图。
  Rect _maskSubtreeBoundsInBoundary(RenderObject root, RenderObject boundary) {
    Rect? unionRect;
    void collect(RenderObject node) {
      if (node is RenderBox) {
        final Rect r = _axisAlignedBoundsInBoundary(node, boundary);
        unionRect = unionRect == null
            ? r
            : Rect.fromLTRB(
                math.min(unionRect!.left, r.left),
                math.min(unionRect!.top, r.top),
                math.max(unionRect!.right, r.right),
                math.max(unionRect!.bottom, r.bottom),
              );
      }
      node.visitChildren(collect);
    }

    collect(root);
    // root 必为 RenderBox（调用方已校验），并集不可能为空。
    return unionRect!;
  }

  /// 遍历渲染子树（含自身）。
  void _forEachRenderDescendant(
      RenderObject node, void Function(RenderObject) fn) {
    fn(node);
    node.visitChildren(
        (RenderObject child) => _forEachRenderDescendant(child, fn));
  }

  /// 遍历元素子树检测**不可绘制内容**（v12）：原生平台视图
  /// （`AndroidView`/`UiKitView`/`AppKitView`/`PlatformViewSurface`/
  /// `PlatformViewLink`/`AndroidViewSurface`）、`Texture` 与 Web 的
  /// `HtmlElementView` 无法可靠进入 `RepaintBoundary.toImage()` 位图。
  /// 命中即提示「部分内容可能未入图」，并允许用户手动添加图片补充——
  /// 不把缺失内容当作完整截图提交。
  bool _containsUndrawableContent() {
    final Element? root = _repaintBoundaryKey.currentContext as Element?;
    if (root == null) return false;
    bool found = false;
    void visit(Element element) {
      if (found) return;
      final Widget w = element.widget;
      if (w is Texture ||
          w is AndroidView ||
          w is UiKitView ||
          w is AppKitView ||
          w is PlatformViewSurface ||
          w is PlatformViewLink ||
          w is AndroidViewSurface ||
          w is HtmlElementView) {
        found = true;
        return;
      }
      element.visitChildren(visit);
    }

    root.visitChildren(visit);
    return found;
  }

  /// 在调用 `toImage()` 前同步收集遮挡几何（截图边界坐标系，逻辑像素）。
  ///
  /// 来源：
  /// 1. 本作用域注册的 [FeedbackCaptureMask] 区域（子树包围盒并集）；
  /// 2. 截图边界内所有标准 `obscureText` 输入区域（RenderEditable）。
  ///
  /// 已注册且可能可见（渲染对象已附着且变换后与截图边界相交）的遮挡区域
  /// 计算失败时抛出异常，中止整次截图——绝不静默跳过导致敏感信息泄露。
  List<_LogicalMaskRegion> _collectMaskRegions(RenderRepaintBoundary boundary) {
    final Rect boundaryRect = Offset.zero & boundary.size;
    final List<_LogicalMaskRegion> regions = <_LogicalMaskRegion>[];

    for (final FeedbackCaptureMaskRecord record in _captureScope.records) {
      final BuildContext ctx = record.context;
      // 已注销/未挂载的记录在注销路径上移除；此处仅防御性跳过。
      if (!ctx.mounted) continue;
      final RenderObject? renderObject = ctx.findRenderObject();
      if (renderObject == null ||
          renderObject is! RenderBox ||
          !renderObject.attached) {
        // 尚未布局或已从渲染树脱离：当前不可能可见。
        continue;
      }
      final Rect aabb = _maskSubtreeBoundsInBoundary(renderObject, boundary);
      if (aabb.isEmpty || !aabb.overlaps(boundaryRect)) continue;
      // 遮罩颜色取 RGB 并强制不透明。
      regions.add(_LogicalMaskRegion(
        aabb.intersect(boundaryRect),
        record.maskColor.withAlpha(0xFF),
      ));
    }

    _forEachRenderDescendant(boundary, (RenderObject node) {
      if (node is RenderEditable && node.obscureText) {
        final Rect aabb = _axisAlignedBoundsInBoundary(node, boundary);
        if (aabb.isEmpty || !aabb.overlaps(boundaryRect)) return;
        regions.add(_LogicalMaskRegion(
          aabb.intersect(boundaryRect),
          const Color(0xFF6E6E73),
        ));
      }
    });

    return regions;
  }

  /// 将逻辑区域映射为输出像素矩形：向外取整、外扩边缘、裁定到图片范围。
  Rect _maskRectInPixels(Rect logical, double scale, int imageW, int imageH) {
    final int left =
        ((logical.left * scale).floor() - kFeedbackCaptureMaskOutsetPx)
            .clamp(0, imageW)
            .toInt();
    final int top =
        ((logical.top * scale).floor() - kFeedbackCaptureMaskOutsetPx)
            .clamp(0, imageH)
            .toInt();
    final int right =
        ((logical.right * scale).ceil() + kFeedbackCaptureMaskOutsetPx)
            .clamp(0, imageW)
            .toInt();
    final int bottom =
        ((logical.bottom * scale).ceil() + kFeedbackCaptureMaskOutsetPx)
            .clamp(0, imageH)
            .toInt();
    return Rect.fromLTRB(
        left.toDouble(), top.toDouble(), right.toDouble(), bottom.toDouble());
  }

  /// 冻结捕获（T1 选区流程与整窗截图共用的前半段）：等待 paint →
  /// 同步登记遮挡几何 → `toImage` → 位图级不透明遮挡 → 得到**已遮挡的
  /// 冻结位图**与元数据。不在此处编码 PNG（编码/限额重试在确认或
  /// 交付时进行）。会话失效、几何失败、边界缺失一律返回 null（调用方
  /// 保留旧草稿旧图，绝不静默回退成整屏截图）。
  Future<_FrozenCapture?> _captureFrozen({
    int? seq,
    bool Function()? isCurrent,
    Offset? releasePoint,
  }) async {
    final bool Function() current =
        isCurrent ?? () => _captureSessionValid(seq!);
    // 等待一帧完成：确保 paint 状态与随后同步记录的几何一致。
    await WidgetsBinding.instance.endOfFrame;
    // 会话校验：等待 paint 期间会话被取消 / 关闭 / 新会话取代则中止。
    if (!mounted || !current()) return null;

    final RenderRepaintBoundary? boundary = _repaintBoundaryKey.currentContext
        ?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null || !boundary.attached) return null;

    ui.Image? source;
    ui.Picture? picture;
    ui.Image? composited;
    try {
      final Size size = boundary.size;
      final double dpr = MediaQuery.maybeOf(context)?.devicePixelRatio ??
          WidgetsBinding
              .instance.platformDispatcher.views.first.devicePixelRatio;
      // 两端统一限制（计划 2.3 完整公式）：边长与像素上限折入缩放因子，
      // 一次性按最终尺寸渲染——
      // scale = min(dpr, 2, 2048/最长逻辑边, sqrt(4000000/逻辑面积))。
      double scale = math.min(dpr, kFeedbackCaptureMaxDevicePixelRatio);
      final double maxEdge = math.max(size.width, size.height);
      if (maxEdge > 0) {
        scale = math.min(scale, kFeedbackCaptureMaxEdgePx / maxEdge);
      }
      if (size.width > 0 && size.height > 0) {
        scale = math.min(
          scale,
          math.sqrt(kFeedbackCaptureMaxPixels / (size.width * size.height)),
        );
      }
      if (!scale.isFinite || scale <= 0) scale = 1.0;

      // 在第一次 toImage() 前同步记录截图边界与遮挡几何（无异步间隔）。
      final List<_LogicalMaskRegion> regions = _collectMaskRegions(boundary);
      final List<Color> regionColors =
          regions.map((r) => r.color).toList(growable: false);

      final FeedbackCaptureInfo baseInfo = FeedbackCaptureInfo(
        viewportWidth: size.width.round(),
        viewportHeight: size.height.round(),
        capturedAt: DateTime.now().toUtc().toIso8601String(),
        releasePoint: releasePoint,
      );

      // v12：不可绘制内容检测（PlatformView/Texture 等不进位图）——
      // 截图照常产出，但预览旁提示用户可手动加图补充。
      final bool containsUndrawable = _containsUndrawableContent();

      // 异步步骤后校验会话：取消即中止，临时资源在 finally 释放。
      if (!current()) return null;
      source = await boundary.toImage(pixelRatio: scale);
      if (!current()) return null;
      // 遮挡几何映射到实际输出像素：向外取整、外扩边缘、裁定到图片范围。
      final List<Rect> pixelRects = regions
          .map((r) =>
              _maskRectInPixels(r.rect, scale, source!.width, source.height))
          .toList(growable: false);
      ui.Image result = source;
      if (pixelRects.isNotEmpty) {
        final ui.PictureRecorder recorder = ui.PictureRecorder();
        final Canvas canvas = Canvas(recorder);
        canvas.drawImage(source, Offset.zero, Paint());
        for (int i = 0; i < pixelRects.length; i++) {
          canvas.drawRect(
            pixelRects[i],
            Paint()..color = regionColors[i],
          );
        }
        picture = recorder.endRecording();
        composited = await picture.toImage(source.width, source.height);
        if (!current()) return null;
        result = composited;
      }
      final _FrozenCapture frozen = _FrozenCapture(
        result,
        scale: scale,
        viewport: size,
        baseInfo: baseInfo,
        containsUndrawable: containsUndrawable,
      );
      // 结果位图交给调用方：这里不再释放。
      source = identical(result, source) ? null : source;
      composited = identical(result, composited) ? null : composited;
      return frozen;
    } on _CaptureGeometryException catch (e) {
      // 已注册且可能可见的遮挡区域计算失败：中止截图（不生成无遮挡图）。
      debugPrint('Feedback screenshot capture aborted: $e');
    } catch (e) {
      debugPrint('Feedback screenshot capture error: $e');
    } finally {
      // 成功移交之外的路径都释放全部临时资源。
      picture?.dispose();
      composited?.dispose();
      source?.dispose();
    }
    return null;
  }

  /// 等比缩小重采样位图（PNG 字节超限的逐次重试用）。
  Future<ui.Image> _resampleImage(ui.Image source, double factor) async {
    final int w = math.max(1, (source.width * factor).round());
    final int h = math.max(1, (source.height * factor).round());
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    canvas.drawImageRect(
      source,
      Offset.zero & Size(source.width.toDouble(), source.height.toDouble()),
      Offset.zero & Size(w.toDouble(), h.toDouble()),
      Paint(),
    );
    final ui.Picture picture = recorder.endRecording();
    try {
      return await picture.toImage(w, h);
    } finally {
      picture.dispose();
    }
  }

  /// 把冻结位图编码为 PNG：超限（>5MiB）按 0.8 步长逐次缩小重编码
  /// （最多 1 + [kFeedbackCaptureRetryLimit] 次）。返回字节与最终输出像素；
  /// 重试耗尽仍超限返回 null（调用方保留旧草稿旧图，可重试）。
  Future<(Uint8List, int, int)?> _encodeCapturePng(ui.Image image) async {
    final Future<void> Function()? barrier = debugCaptureEncodeBarrier;
    if (barrier != null) await barrier();
    double factor = 1.0;
    for (int attempt = 0; attempt <= kFeedbackCaptureRetryLimit; attempt++) {
      ui.Image? current;
      try {
        current = factor >= 1.0 ? image : await _resampleImage(image, factor);
        final ByteData? byteData =
            await current.toByteData(format: ui.ImageByteFormat.png);
        if (byteData != null &&
            byteData.lengthInBytes <= kFeedbackCaptureMaxBytes) {
          final int length = byteData.lengthInBytes;
          return (
            byteData.buffer.asUint8List(byteData.offsetInBytes, length),
            current.width,
            current.height,
          );
        }
      } finally {
        if (!identical(current, image)) current?.dispose();
      }
      factor *= kFeedbackCaptureRetryScaleStep;
    }
    // 重试耗尽仍超限：本次截图失败（不返回超大图——服务端必回 413，
    // 静默降级只会把失败推迟到网络层）。保留旧草稿旧截图，可重试或
    // 继续文字反馈。
    debugPrint('Feedback screenshot capture failed: '
        'PNG 超出 $kFeedbackCaptureMaxBytes 字节且重试已用尽');
    return null;
  }

  /// 冻结位图按选区裁剪（T1.e）：逻辑选区 × 捕获比例换算到像素坐标
  /// （floor/ceil 外扩后裁定到位图范围），只保留选区内容——
  /// 灵感球、选区边框、遮罩、工具栏都不在冻结位图中，自然不入图。
  Future<ui.Image?> _cropFrozen(_FrozenCapture frozen, Rect selection) async {
    final double scale = frozen.scale;
    final int left =
        (selection.left * scale).floor().clamp(0, frozen.image.width);
    final int top =
        (selection.top * scale).floor().clamp(0, frozen.image.height);
    final int right =
        (selection.right * scale).ceil().clamp(left, frozen.image.width);
    final int bottom =
        (selection.bottom * scale).ceil().clamp(top, frozen.image.height);
    final int width = right - left;
    final int height = bottom - top;
    if (width <= 0 || height <= 0) return null;
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    canvas.drawImageRect(
      frozen.image,
      Rect.fromLTRB(
          left.toDouble(), top.toDouble(), right.toDouble(), bottom.toDouble()),
      Offset.zero & Size(width.toDouble(), height.toDouble()),
      Paint(),
    );
    final ui.Picture picture = recorder.endRecording();
    try {
      return await picture.toImage(width, height);
    } finally {
      picture.dispose();
    }
  }

  /// 整窗截图（控制器 / 点击入口 / 重拍共用）：冻结捕获 → PNG 编码
  /// （含限额重试）→ 交付元数据。失败返回 null（旧草稿旧图保留）。
  Future<_CaptureResult?> _capture({
    required int seq,
    Offset? releasePoint,
  }) async {
    final _FrozenCapture? frozen =
        await _captureFrozen(seq: seq, releasePoint: releasePoint);
    if (frozen == null) return null;
    try {
      if (!_captureSessionValid(seq)) return null;
      final (Uint8List, int, int)? encoded =
          await _encodeCapturePng(frozen.image);
      // 编码是异步步骤：完成后再次校验会话，过期结果直接丢弃。
      if (encoded == null || !_captureSessionValid(seq)) return null;
      final FeedbackCaptureInfo base = frozen.baseInfo;
      final FeedbackCaptureInfo info = FeedbackCaptureInfo(
        viewportWidth: base.viewportWidth,
        viewportHeight: base.viewportHeight,
        pixelWidth: encoded.$2,
        pixelHeight: encoded.$3,
        capturedAt: base.capturedAt,
        releasePoint: base.releasePoint,
      );
      return _CaptureResult(encoded.$1, info,
          containsUndrawable: frozen.containsUndrawable);
    } finally {
      frozen.dispose();
    }
  }

  /// 统一草稿守卫：面板已持有草稿文本或截图/图片时，任何呼出入口都不得
  /// 重新截图——否则新图会覆盖用户正在编辑的内容。
  ///
  /// 面板只在首次呼出（`_everOpened`）后挂载；未挂载（null）即无草稿可言，
  /// 照常捕获。`hasDraft` 按去空白后的正文判定。
  bool _panelHasDraftContent() {
    final FeedbackPanelState? panel = _panelKey.currentState;
    return panel != null &&
        (panel.hasDraft || panel.hasImages || panel.hasLogs);
  }

  /// 先截图后开面板：保持宿主当前布局等待 paint → 捕获宿主边界完成遮挡
  /// 编码 → 检查会话仍有效 → 挂载面板并交付截图 → 最后聚焦输入框。
  ///
  /// 反馈 UI 位于截图边界（RepaintBoundary 只包宿主 child）之外，无需
  /// 入图再擦除；普通呼出（open）不使进行中的捕获会话失效，二者合并。
  ///
  /// 三个入口（普通点击 / 拖动释放 / [FeedbackController.captureAndOpen]）全部
  /// 汇入此处，因此草稿守卫在**所有**入口上都生效。
  Future<void> _captureAndOpen({Offset? releasePoint}) async {
    // 1. 先查草稿：已有草稿文本或截图 → 不截图，直接呼出并原样恢复草稿
    //    （含文字与旧截图字节）。
    if (_panelHasDraftContent()) {
      _open();
      return;
    }
    final bool needCapture =
        widget.config.captureMode == FeedbackCaptureMode.viewport ||
            releasePoint != null;
    if (!needCapture) {
      _open();
      return;
    }
    _startCaptureSession();
    final int seq = _captureSeq;
    final _CaptureResult? result = await _capture(
      seq: seq,
      releasePoint: releasePoint,
    );
    // 捕获完成后校验会话：被取消 / 关闭 / 新会话取代则不再挂载面板。
    if (!_captureSessionValid(seq)) return;
    _capturePendingSeq = null;
    _open();
    // 面板可能尚未挂载（首次呼出）：等挂载后在 post-frame 交付，
    // 交付前再次校验捕获序号，防止 post-frame 回调写入过期结果。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_captureSessionValid(seq)) return;
      final FeedbackPanelState? panel = _panelKey.currentState;
      if (panel == null) return;
      if (result != null) {
        panel.setScreenshot(result.bytes, result.info,
            captureSeq: seq, containsUndrawable: result.containsUndrawable);
      }
      // 最后聚焦输入框。
      panel.requestInputFocus();
    });
  }

  /// T1：拖动灵感球松手 → 不再直接写草稿，改为进入局部选区流程：
  /// 先完成与整窗截图**完全相同**的遮挡捕获（冻结位图 + 元数据），
  /// 再挂载选区覆盖层，等用户「使用此区域 / 截取整个窗口 / 取消」。
  ///
  /// 边界（T1.4）：图片已达上限且无可替换截图 → 先提示整理附件、
  /// 不发起捕获；捕获失败 → 打开面板提示可重试（保留旧草稿旧图，
  /// 绝不静默回退成整屏截图）；会话 / 身份失效 → 进行中流程作废。
  Future<void> _captureForSelection({required Offset releaseGlobal}) async {
    // 落点相对**原始捕获视口**归一化（截图边界优先，退回屏幕尺寸）。
    final RenderRepaintBoundary? boundary = _repaintBoundaryKey.currentContext
        ?.findRenderObject() as RenderRepaintBoundary?;
    final Size reference = (boundary != null && boundary.attached)
        ? boundary.size
        : MediaQuery.sizeOf(context);
    final Offset local =
        boundary?.globalToLocal(releaseGlobal) ?? releaseGlobal;
    final double rx = reference.width > 0 ? local.dx / reference.width : .5;
    final double ry = reference.height > 0 ? local.dy / reference.height : .5;
    final Offset releasePoint = Offset(rx.clamp(0.0, 1.0), ry.clamp(0.0, 1.0));

    // 1) 图片上限：已达上限且无可替换截图（capture 槽位）→ 提示整理附件。
    final FeedbackPanelState? panel = _panelKey.currentState;
    if (panel != null && !panel.canAcceptCapture) {
      panel.showComposeNotice(
          '图片附件已达 ${panel.captureImageLimit} 张上限，请先整理附件后再截图');
      _open();
      return;
    }
    // Dragging is an explicit retake. Existing draft and attachment remain
    // untouched until a successful confirmation replaces the capture slot.
    // 3) 冻结捕获（与整窗截图同一遮挡管线）。
    _startCaptureSession();
    final int seq = _captureSeq;
    setState(() => _temporarilyHideForCapture = true);
    final _FrozenCapture? frozen =
        await _captureFrozen(seq: seq, releasePoint: releasePoint);
    if (!_captureSessionValid(seq)) {
      frozen?.dispose();
      return;
    }
    _temporarilyHideForCapture = false;
    _capturePendingSeq = null;
    if (frozen == null) {
      // 失败：保留旧草稿旧图并提示可重试；不产出任何截图、不回退整屏。
      _open();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_captureSessionValid(seq)) return;
        _panelKey.currentState?.showComposeNotice('截图失败，已保留原草稿与图片；可再次拖动灵感球重试');
      });
      return;
    }
    _releaseLensSnapshot();
    _selectionShader = _lensProgramCache?.fragmentShader();
    setState(() => _selectionCapture = frozen);
  }

  /// 选区流程确认：[selection] 为 null 表示「截取整个窗口」（region 省略），
  /// 非 null 表示把冻结位图裁到选区（`capture.region` 归一化透传）。
  Future<void> _deliverSelection({Rect? selection}) async {
    if (_selectionBusy || _selectionCapture == null) return;
    final int seq = _captureSeq;
    if (!_captureSessionValid(seq)) {
      _cancelSelection();
      return;
    }
    // The operation owns an independent handle: cancellation may release the
    // overlay while crop/encode is still awaiting the engine.
    final _FrozenCapture frozen = _selectionCapture!.clone();
    setState(() {
      _selectionBusy = true;
      _selectionError = null;
    });
    ui.Image? cropped;
    ui.Image? flight;
    try {
      final ui.Image? source = selection == null
          ? frozen.image
          : cropped = await _cropFrozen(frozen, selection);
      if (!_captureSessionValid(seq)) return;
      final (Uint8List, int, int)? encoded =
          source == null ? null : await _encodeCapturePng(source);
      if (!_captureSessionValid(seq)) return;
      if (encoded == null) throw StateError('capture encoding failed');
      flight = source!.clone();
      final FeedbackCaptureInfo base = frozen.baseInfo;
      final FeedbackCaptureInfo info = FeedbackCaptureInfo(
          viewportWidth: base.viewportWidth,
          viewportHeight: base.viewportHeight,
          pixelWidth: encoded.$2,
          pixelHeight: encoded.$3,
          capturedAt: base.capturedAt,
          releasePoint: base.releasePoint,
          region: selection == null
              ? null
              : normalizeCaptureRegion(selection, frozen.viewport));
      final _CaptureHandoff flow = _CaptureHandoff(
          seq: seq,
          image: flight,
          background: frozen.image.clone(),
          source: selection ?? Offset.zero & frozen.viewport);
      flight = null; // ownership transfers to the handoff until its final frame
      _handoff = flow;
      final _FrozenCapture? overlay = _selectionCapture;
      _selectionCapture = null;
      _releaseSelectionShader();
      if (overlay != null) _disposeAfterFrame(overlay.image);
      _selectionBusy = false;
      _handoffAnimation.value = 0;
      _everOpened = true;
      _open();
      setState(() {});
      // Mount the actual panel and commit exactly once, then measure its
      // untransformed final attachment layout in a second layout pass.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_captureSessionValid(seq) ||
            !identical(_handoff, flow) ||
            !_controller.isOpen) {
          return;
        }
        final FeedbackPanelState? panel = _panelKey.currentState;
        if (panel == null) {
          _finishHandoff();
          return;
        }
        panel.beginCaptureHandoff();
        panel.setScreenshot(encoded.$1, info,
            captureSeq: seq, containsUndrawable: frozen.containsUndrawable);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_captureSessionValid(seq) ||
              !identical(_handoff, flow) ||
              !_controller.isOpen) {
            return;
          }
          final Rect? global = panel.captureThumbnailRect;
          final RenderBox? host = context.findRenderObject() as RenderBox?;
          if (global != null && host != null && host.attached) {
            // Panel entrance uses FractionalTranslation (paint only). Its
            // layout is already final; subtract that known paint translation.
            final Offset translated = host.globalToLocal(global.topLeft);
            final double offsetY = _handoffPanelTranslation;
            final Rect local = (translated - Offset(0, offsetY)) & global.size;
            if ((Offset.zero & host.size).overlaps(local)) flow.target = local;
          }
          if (_orbGlowReduced) {
            _finishHandoff(focus: true);
            return;
          }
          if (flow.target == null) panel.setCaptureHandoffProgress(1);
          _handoffAnimation.forward(from: 0);
        });
      });
    } catch (_) {
      if (_captureSessionValid(seq)) {
        setState(() {
          _selectionBusy = false;
          _selectionError = '截图准备失败，已保留选区与原草稿，请重试';
        });
      }
    } finally {
      flight?.dispose();
      cropped?.dispose();
      frozen.dispose();
    }
  }

  double _handoffPanelTranslation = 0;

  /// 取消选区流程：丢弃冻结画面并恢复 UI；不覆盖原草稿、不报失败。
  void _cancelSelection() {
    _invalidateCaptureSession();
    _releaseLensSnapshot(allowPrefetch: true);
    if (mounted && !_disposed) {
      setState(() {
        _isDragging = false;
      });
    }
  }

  /// 重拍：复用与呼出相同的会话化捕获流程（先隐藏反馈 UI → 捕获 →
  /// 会话有效则替换截图 → finally 由会话统一恢复覆盖层）。
  ///
  /// 只有重拍成功才替换旧图；重拍失败（结果为空）保留旧图不丢失。
  Future<void> _retakeScreenshot() async {
    if (!mounted) return;
    // 只读状态判断行为：面板当前没有截图就没有"重拍"可言。
    if (_panelKey.currentState?.hasScreenshot != true) return;
    // 重拍是内部明确入口：新会话使旧捕获失效；先隐藏反馈覆盖层
    // （面板 / scrim 均在截图边界之外，仅作为"正在重拍"的视觉状态）。
    _startCaptureSession();
    setState(() {
      _temporarilyHideForCapture = true;
    });
    final int seq = _captureSeq;
    final _CaptureResult? result = await _capture(seq: seq);
    if (_captureSessionValid(seq) && result != null) {
      _panelKey.currentState?.setScreenshot(result.bytes, result.info,
          captureSeq: seq, containsUndrawable: result.containsUndrawable);
    }
    // 旧请求的 finally 不得恢复新请求的 UI：仅在会话仍有效时恢复；
    // 会话被取消时由 _cancelCapture 统一恢复，被新会话取代时由新会话管理。
    if (_captureSessionValid(seq)) {
      setState(() {
        _temporarilyHideForCapture = false;
      });
    }
  }

  void _handleLauncherTap() {
    // T7f：选区覆盖层或截图隐藏期间，入口不可被键盘 / 指针激活——否则会
    // 作废已冻结的选区并重新整窗捕获。所有激活路径（ActivateIntent、
    // onTap、onPanEnd 点击分支）都汇聚到这里。
    if (_selectionCapture != null || _temporarilyHideForCapture) return;
    if (widget.config.captureMode == FeedbackCaptureMode.viewport) {
      _captureAndOpen();
    } else {
      _open();
    }
  }

  void _observeViewport(Size viewport) {
    final double dpr = _dpr;
    final bool changed = (_lastViewport != null && _lastViewport != viewport) ||
        (_lastDpr != null && _lastDpr != dpr);
    _lastViewport = viewport;
    _lastDpr = dpr;
    if (!changed || _viewportInvalidationScheduled) return;
    _wakeRecognizer?.cancel();
    ++_lensGeneration; // invalidate awaiting captures before the next layout callback
    _viewportInvalidationScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _viewportInvalidationScheduled = false;
      if (!mounted || _disposed) return;
      final bool hadFlow = _selectionCapture != null || _handoff != null;
      _invalidateCaptureSession();
      _releaseLensSnapshot(allowPrefetch: true);
      _resetOrbReleaseState();
      _sessionViewport = null;
      _sessionDpr = null;
      _temporarilyHideForCapture = false;
      if (hadFlow) {
        _open();
        final int seq = _captureSeq;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_captureSessionValid(seq) && _controller.isOpen) {
            _panelKey.currentState?.showComposeNotice('窗口尺寸或显示比例已变化，请重新截图');
          }
        });
      }
      setState(() {});
    });
  }

  bool _onHostScroll(ScrollNotification notification) {
    _wakeRecognizer?.cancel();
    ++_lensGeneration;
    _lensPendingCaptureGeneration = null;
    _lensFirstCaptureScheduled = false;
    _lensPrefetchDone = true;
    final int generation = _lensGeneration;
    final _OrbLensSnapshot? previous = _lensSnapshot.value;
    // Scroll only invalidates decoration; a frozen selection keeps its
    // original pixels, geometry and capture metadata. Clear after the host's
    // new scroll position paints, then coalesce resampling at the bounded cadence.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _disposed) return;
      if (identical(previous, _lensSnapshot.value)) _clearLensImage();
      if (generation == _lensGeneration) {
        _scheduleLensRefresh(allowMissing: true, keepExisting: true);
      }
    });
    WidgetsBinding.instance.scheduleFrame();
    return false;
  }

  Widget _buildHandoffBackground(_CaptureHandoff flow) {
    final double ms = _handoffAnimation.value * 1500;
    return IgnorePointer(
        child: Stack(fit: StackFit.expand, children: <Widget>[
      ImageFiltered(
          imageFilter: ui.ImageFilter.blur(
              sigmaX: 3 * orbSmoothstep(0, 350, ms),
              sigmaY: 3 * orbSmoothstep(0, 350, ms)),
          child: RawImage(image: flow.background, fit: BoxFit.fill)),
      const ColoredBox(color: Color(0x42635D92)),
    ]));
  }

  Widget _buildHandoffFlight(_CaptureHandoff flow) {
    final Rect? target = flow.target;
    if (target == null) return const SizedBox.shrink();
    final double ms = _handoffAnimation.value * 1500;
    final double p = orbSmoothstep(180, 1330, ms);
    final double wave = math.sin(math.pi * p);
    final Rect rect =
        Rect.lerp(flow.source, target, p)!.shift(Offset(0, -12 * wave));
    return Positioned.fromRect(
        rect: rect,
        child: IgnorePointer(
            child: Opacity(
                opacity: 1 - orbSmoothstep(1220, 1350, ms),
                child: DecoratedBox(
                    decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12 - 2 * p),
                        boxShadow: <BoxShadow>[
                          BoxShadow(
                              color: const Color(0xFF1E193C)
                                  .withValues(alpha: .2 * (1 - p)),
                              offset: Offset(0, 16 * wave),
                              blurRadius: 30 * wave)
                        ]),
                    child: ClipRRect(
                        borderRadius: BorderRadius.circular(12 - 2 * p),
                        child: RawImage(
                            image: flow.image, fit: BoxFit.contain))))));
  }

  @override
  Widget build(BuildContext context) {
    final FeedbackConfig config = widget.config;
    final bool open = _controller.isOpen;
    // hidden（面板打开、入口关闭或待机隐藏）时清除焦点环锁存：
    // launcher slot 不渲染时保留 true 会让下次显示在没有焦点的情况下画出环；
    // 指针关闭路径也依赖这里抑制环（T7i），不是纯防御。build 内不能 setState。
    if (open || !_launcherVisible || _orbIdleHidden) _orbFocusVisible = false;
    _syncOrbFlow();
    _syncOrbIdle();
    _syncOrbLensCapture(open: open, config: config);
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final double height = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : MediaQuery.of(context).size.height;
        _observeViewport(Size(width, height));
        final bool wide = width >= kFeedbackWideBreakpoint;
        // 冻结视觉规格（与 Web 端 `min(440px, 100vw−32px)` /
        // `min(720px, 100dvh−32px)` 一致）：
        // 宽屏抽屉宽 min(440, 视口宽−32)、高 min(720, 视口高−32)，
        // 垂直居中（上下各留余量，不贴边不溢出）；<768 全屏（宽高用满）。
        final double panelWidth = wide
            ? math.min(
                kFeedbackPanelWidth, width - 2 * kFeedbackPanelViewportMargin)
            : width;
        final double panelHeight = wide
            ? math.min(
                kFeedbackPanelMaxHeight,
                math.max(0.0, height - 2 * kFeedbackPanelViewportMargin),
              )
            : height;
        final double panelTop = wide ? (height - panelHeight) / 2 : 0.0;
        final _CaptureHandoff? flow = _handoff;
        final double ms = flow == null || _orbGlowReduced
            ? 1500
            : _handoffAnimation.value * 1500;
        final double panelShift =
            flow == null ? 0 : 1.04 * (1 - orbSmoothstep(120, 1050, ms));
        final bool handoffLocked = flow != null && ms < 1350;
        final bool isLeft = config.side == FeedbackSide.left;

        final double bottom =
            config.position?.dy ?? _parseBottom(config.launcherBottom, height);
        final RenderObject? dockBoundary =
            _repaintBoundaryKey.currentContext?.findRenderObject();
        final EdgeInsets dockInsets =
            dockBoundary is RenderBox && dockBoundary.hasSize
                ? _captureSelectionSafeInsets()
                : MediaQuery.paddingOf(context);
        final double dockTop = (height - bottom - 56).clamp(dockInsets.top,
            math.max(dockInsets.top, height - dockInsets.bottom - 56));
        final double orbBottom = height - dockTop - 56;
        // T9：面板底部抬升键盘实际重叠量（未避让部分），避免输入框与
        // 操作按钮被软键盘覆盖；宿主已避让时为 0，不产生双重留白。
        final double keyboardOverlap = _keyboardOverlap(context);
        _handoffPanelTranslation = (panelHeight - keyboardOverlap) * panelShift;
        final double? left = isLeft ? (config.position?.dx ?? 20.0) : null;
        final double? right = isLeft ? null : (config.position?.dx ?? 20.0);
        _orbIdleDockCenter =
            Offset(isLeft ? left! + 28 : width - right! - 28, dockTop + 28);
        final _OrbMorphGeometry? orbMorph = _orbMorphVisible
            ? _OrbMorphGeometry(
                left: isLeft,
                handle: _orbIdleStyle == FeedbackOrbIdleStyle.handle,
                dark: !(MediaQuery.maybeOf(context)?.highContrast ??
                        View.of(context)
                            .platformDispatcher
                            .accessibilityFeatures
                            .highContrast) &&
                    (Theme.maybeBrightnessOf(context) ??
                            switch (config.theme) {
                              FeedbackThemeMode.light => Brightness.light,
                              FeedbackThemeMode.dark => Brightness.dark,
                              FeedbackThemeMode.system => View.of(context)
                                  .platformDispatcher
                                  .platformBrightness,
                            }) ==
                        Brightness.dark,
                progress: _orbMorphProgress,
                dockCenter: _orbIdleDockCenter,
                safeInsets: dockInsets,
                viewportWidth: width)
            : null;

        // 提供本实例私有的遮挡作用域：子树内的 FeedbackCaptureMask
        // 注册到最近的作用域（嵌套组件实例各归其主）。
        return FeedbackCaptureScopeWidget(
          scope: _captureScope,
          child: _FeedbackEnvironment(
            themeMode: config.theme,
            child: Stack(
              children: <Widget>[
                // 每个条件槽位都带稳定 key：Stack 对无 key 子节点按下标匹配，
                // 一旦遮罩出现/消失就会让后面的槽位整体位移，面板元素被丢弃后
                // 再经 _panelKey 重新收养（deactivate → activate）。那条路径会
                // 让面板内 EditableText 的 OverlayPortal 在 theater 尚未 attach
                // 时 markNeedsLayout，在 Flutter 3.41.x 上直接断言失败。
                Positioned.fill(
                  key: const Key('feedback-host-slot'),
                  child: RepaintBoundary(
                    key: _repaintBoundaryKey,
                    child: Listener(
                      onPointerUp: (PointerUpEvent event) =>
                          _wakeRecognizer?.preparePointerUp(event),
                      child: RawGestureDetector(
                        behavior: HitTestBehavior.translucent,
                        excludeFromSemantics: true,
                        gestures: <Type, GestureRecognizerFactory>{
                          FeedbackWakeGestureRecognizer:
                              GestureRecognizerFactoryWithHandlers<
                                  FeedbackWakeGestureRecognizer>(
                            () => _wakeRecognizer =
                                FeedbackWakeGestureRecognizer(debugOwner: this),
                            (FeedbackWakeGestureRecognizer recognizer) {
                              recognizer
                                ..isAvailable = (() => _wakeAvailable)
                                ..onReleaseHint = _setWakeReleaseHint
                                ..onWake = _onWake
                                ..enabled = _wakeGestures;
                            },
                          ),
                        },
                        child: NotificationListener<ScrollNotification>(
                            onNotification: _onHostScroll, child: widget.child),
                      ),
                    ),
                  ),
                ),
                Positioned.fill(
                    key: const Key('feedback-handoff-background-slot'),
                    child: flow == null
                        ? const SizedBox.shrink()
                        : _buildHandoffBackground(flow)),
                // 宽屏抽屉展开时压一层可点击遮罩；窄屏为全屏页面不需要。
                if (open && wide && !_temporarilyHideForCapture && flow == null)
                  Positioned.fill(
                    key: const Key('feedback-scrim-slot'),
                    child: GestureDetector(
                      key: const Key('feedback-scrim'),
                      behavior: HitTestBehavior.opaque,
                      onTap: _close,
                      child: const ColoredBox(color: Color(0x52000000)),
                    ),
                  ),
                // 面板常驻（打开过之后），以保留草稿与轮询状态。
                // 重拍期间用 Offstage 隐藏（SizedBox.shrink 会卸载面板子树，
                // 销毁 FeedbackPanelState 导致草稿与旧截图丢失）。
                Positioned(
                  key: const Key('feedback-panel-slot'),
                  // 宽屏抽屉：上下各留 ≥16px 余量（高 min(720, 视口高−32)）；
                  // 窄屏（<768）：top/bottom 均为 0，全屏页面式。
                  top: panelTop,
                  bottom: panelTop,
                  width: panelWidth,
                  left: isLeft ? 0 : null,
                  right: isLeft ? null : 0,
                  child: Padding(
                    padding: EdgeInsets.only(bottom: keyboardOverlap),
                    child: Builder(builder: (_) {
                      return !_everOpened
                          ? const SizedBox.shrink()
                          : Visibility(
                              visible: open && !_temporarilyHideForCapture,
                              maintainState: true,
                              // 传真实开关状态（用户是否打开面板）：截图期间暂时
                              // 隐藏不算关闭，不得据此取消登录接续或清除状态。
                              child: IgnorePointer(
                                  ignoring: handoffLocked,
                                  child: ExcludeFocus(
                                      excluding: handoffLocked,
                                      child: Opacity(
                                          opacity: flow == null
                                              ? 1
                                              : orbSmoothstep(60, 300, ms),
                                          child: FractionalTranslation(
                                              translation:
                                                  Offset(0, panelShift),
                                              child: _buildPanel(config,
                                                  visible: open))))),
                            );
                    }),
                  ),
                ),
                // 待机隐藏（灵感球已收起且样式为「隐藏」）不渲染 launcher slot：
                // 完整球初始、唤醒后与面板关闭后仍按 `_launcherVisible` 渲染；
                // tab 模式的 FAB 与灵感球待机样式无关。
                if (!open &&
                    _launcherVisible &&
                    !_orbIdleHidden &&
                    !_temporarilyHideForCapture &&
                    _selectionCapture == null)
                  Positioned(
                    key: const Key('feedback-launcher-slot'),
                    bottom: config.launcherMode == FeedbackLauncherMode.orb
                        ? orbBottom
                        : bottom,
                    left: isLeft && orbMorph != null ? orbMorph.hit.left : left,
                    right: !isLeft && orbMorph != null
                        ? width - orbMorph.hit.right
                        : right,
                    child: Builder(
                      builder: (BuildContext context) => config.launcherMode ==
                              FeedbackLauncherMode.orb
                          ? (orbMorph != null
                              ? _buildCollapsedOrb(context, config, orbMorph)
                              : _buildOrb(context, config))
                          : _buildFab(context, config),
                    ),
                  ),
                // T1：拖动灵感球后的局部选区覆盖层——置于最上层，
                // 冻结位图不透明铺满，灵感球 / 面板 / 启动入口都被其覆盖。
                if (_selectionCapture != null)
                  Positioned.fill(
                    key: const Key('feedback-capture-selection-slot'),
                    child: CaptureSelectionOverlay(
                      key: const Key('feedback-capture-selection-overlay'),
                      image: _selectionCapture!.image,
                      viewport: _selectionCapture!.viewport,
                      safeInsets: _captureSelectionSafeInsets(),
                      releasePoint: _selectionCapture!.baseInfo.releasePoint,
                      busy: _selectionBusy,
                      error: _selectionError,
                      orbCenter: _selectionOrbCenter,
                      orbShader: _selectionShader,
                      scale: _selectionCapture!.scale,
                      direction: _selectionDirection,
                      deform: _selectionDeform,
                      wobble: _selectionWobble,
                      orbRadius: _selectionRadius,
                      onUseRegion: (Rect region) {
                        unawaited(_deliverSelection(selection: region));
                      },
                      onCaptureWhole: () {
                        unawaited(_deliverSelection(selection: null));
                      },
                      onCancel: _cancelSelection,
                    ),
                  ),
                if (_wakeReleaseHint)
                  const Positioned(
                    key: Key('feedback-wake-release-hint'),
                    left: 16,
                    right: 16,
                    top: 24,
                    child: IgnorePointer(
                      child: Center(
                        child: Material(
                          borderRadius: BorderRadius.all(Radius.circular(12)),
                          color: Color(0xEE292633),
                          child: Padding(
                            padding: EdgeInsets.symmetric(
                                horizontal: 16, vertical: 12),
                            child: Text('松开手指唤醒灵感球',
                                style: TextStyle(color: Colors.white)),
                          ),
                        ),
                      ),
                    ),
                  ),
                if (flow != null)
                  KeyedSubtree(
                      key: const Key('feedback-handoff-flight-slot'),
                      child: _buildHandoffFlight(flow)),
              ],
            ),
          ),
        );
      },
    );
  }

  /// 先与真实view安全区相交，再换算为捕获boundary本地边距。
  /// 宿主SafeArea或局部布局已避让的空间不会再次扣除。
  EdgeInsets _captureSelectionSafeInsets() {
    final RenderBox boundary =
        _repaintBoundaryKey.currentContext!.findRenderObject()! as RenderBox;
    final view = View.of(context);
    final Rect viewSafe = captureSelectionArea(
        view.physicalSize / view.devicePixelRatio,
        EdgeInsets.fromViewPadding(view.padding, view.devicePixelRatio));
    final Matrix4 toGlobal = boundary.getTransformTo(null);
    final Rect globalBoundary =
        MatrixUtils.transformRect(toGlobal, Offset.zero & boundary.size);
    final Rect intersection = globalBoundary.intersect(viewSafe);
    // 完全在view外的边界把空交集压到最近边缘，不能反向变成可用区域。
    final Rect clipped = Rect.fromLTRB(
        intersection.left.clamp(globalBoundary.left, globalBoundary.right),
        intersection.top.clamp(globalBoundary.top, globalBoundary.bottom),
        intersection.right.clamp(globalBoundary.left, globalBoundary.right),
        intersection.bottom.clamp(globalBoundary.top, globalBoundary.bottom));
    final Rect localSafe =
        MatrixUtils.transformRect(Matrix4.inverted(toGlobal), clipped);
    return EdgeInsets.fromLTRB(
        localSafe.left.clamp(0, boundary.size.width),
        localSafe.top.clamp(0, boundary.size.height),
        (boundary.size.width - localSafe.right).clamp(0, boundary.size.width),
        (boundary.size.height - localSafe.bottom)
            .clamp(0, boundary.size.height));
  }

  /// T9：面板与键盘区域的实际重叠量——只扣除尚未被宿主布局避让的部分。
  /// 宿主已随键盘收缩组件（如 Scaffold resizeToAvoidBottomInset，此时
  /// viewInsets 通常也被消费归零）或面板底边已在键盘上沿之上时返回 0，
  /// 避免双重留白；宿主未避让（根部挂载）时返回键盘遮挡的高度。
  double _keyboardOverlap(BuildContext context) {
    final double inset = MediaQuery.viewInsetsOf(context).bottom;
    if (inset <= 0) return 0;
    final RenderObject? ro = context.findRenderObject();
    if (ro is! RenderBox || !ro.attached || !ro.hasSize) return inset;
    final double keyboardTop = MediaQuery.sizeOf(context).height - inset;
    final double bottom = ro.localToGlobal(Offset.zero).dy + ro.size.height;
    final double overlap = bottom - keyboardTop;
    return overlap > 0 ? overlap : 0.0;
  }

  Widget _buildFab(BuildContext context, FeedbackConfig config) {
    // F1：入口不再绘制未读数字角标；未读数仍通过 controller 与
    // onUnreadCountChange 提供给宿主自绘。
    return Semantics(
      button: true,
      label: '反馈',
      child: FloatingActionButton(
        key: const Key('feedback-fab'),
        heroTag: 'feedback-widget-fab',
        tooltip: '反馈',
        onPressed: _handleLauncherTap,
        child: const Icon(Icons.feedback_outlined),
      ),
    );
  }

  Widget _buildCollapsedOrb(
      BuildContext context, FeedbackConfig config, _OrbMorphGeometry geometry) {
    final bool left = config.side == FeedbackSide.left;
    final bool handle = _orbIdleStyle == FeedbackOrbIdleStyle.handle;
    final double t = geometry.progress;
    final double halfWidth = geometry.halfWidth;
    final double halfHeight = geometry.halfHeight;
    Widget art = IgnorePointer(
        child: ClipRect(
            clipper: const _OrbDockClipper(),
            child: Stack(clipBehavior: Clip.none, children: <Widget>[
              Positioned(
                  left: left ? geometry.paintInset : null,
                  right: left ? null : geometry.paintInset,
                  top: 28 - halfHeight,
                  width: halfWidth * 2,
                  height: halfHeight * 2,
                  child: SizedBox(
                      key: Key(
                          'feedback-orb-idle-${handle ? 'handle' : 'edge'}'),
                      child: Stack(clipBehavior: Clip.none, children: <Widget>[
                        Positioned(
                            left: halfWidth - 44.8,
                            top: halfHeight - 44.8,
                            width: 89.6,
                            height: 89.6,
                            child: _buildOrbLensLayer(28,
                                fixedCenter: geometry.center,
                                halfSize: Size(halfWidth, halfHeight),
                                handleMix: handle ? t : 0,
                                mist: .74,
                                idleMix: 1)),
                        if (_orbFocusVisible && _orbFocusNode.hasPrimaryFocus)
                          Positioned(
                              left: -4,
                              top: -4,
                              right: -4,
                              bottom: -4,
                              child: DecoratedBox(
                                  key: const Key('feedback-orb-focus-ring'),
                                  decoration: BoxDecoration(
                                      borderRadius:
                                          BorderRadius.circular(halfWidth + 4),
                                      border: Border.all(
                                          width: kFeedbackOrbFocusWidth,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .primary)))),
                      ]))),
            ])));
    return FocusableActionDetector(
        focusNode: _orbFocusNode,
        onFocusChange: (bool focused) {
          if (focused && _orbLastInputKeyboard) {
            _orbFocusVisible = true;
            _wakeOrb();
          } else if (!focused && _orbFocusVisible) {
            setState(() => _orbFocusVisible = false);
          }
        },
        shortcuts: const <ShortcutActivator, Intent>{
          SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.space): ActivateIntent(),
        },
        actions: <Type, Action<Intent>>{
          ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
            _wakeOrb();
            return null;
          })
        },
        child: Semantics(
            button: true,
            label: '唤醒灵感球',
            value: _controller.unreadCount > 0
                ? '${_controller.unreadCount} 条未读反馈'
                : null,
            child: GestureDetector(
                key: const Key('feedback-orb-collapsed'),
                behavior: HitTestBehavior.opaque,
                onTap: _wakeOrb,
                child: SizedBox(
                    width: geometry.hit.width,
                    height: 56,
                    child: Stack(clipBehavior: Clip.none, children: <Widget>[
                      Positioned(
                          left: left ? -geometry.hitInset : null,
                          right: left ? null : -geometry.hitInset,
                          top: 0,
                          width: geometry.clipWidth,
                          height: 56,
                          child: art),
                    ])))));
  }

  Widget _buildOrb(BuildContext context, FeedbackConfig config) {
    // F1：灵感球不再绘制未读数字角标；未读数保留在 Semantics value 与
    // controller 中，供宿主/读屏使用。
    final bool reduceMotion =
        _orbGlowReduced || MediaQuery.disableAnimationsOf(context);
    final double diameter =
        _isDragging ? kFeedbackOrbDraggingDiameter : kFeedbackOrbIdleDiameter;
    final double target = reduceMotion ? 1 : _orbTargetStateScale;
    final Widget orbBox = AnimatedContainer(
      key: const Key('feedback-orb-body'),
      duration: reduceMotion ? Duration.zero : kFeedbackOrbSizeDuration,
      curve: kFeedbackOrbStateCurve,
      width: diameter,
      height: diameter,
      child: TweenAnimationBuilder<double>(
          tween: Tween<double>(begin: 1, end: target),
          duration: reduceMotion
              ? Duration.zero
              : (_orbPressTransition
                  ? kFeedbackOrbPressDuration
                  : kFeedbackOrbSizeDuration),
          curve: _orbPressTransition
              ? kFeedbackOrbPressCurve
              : kFeedbackOrbStateCurve,
          onEnd: () => _orbPressTransition = false,
          builder: (BuildContext context, double stateScale, Widget? child) =>
              LayoutBuilder(
                  builder: (BuildContext context, BoxConstraints box) {
                final double side = box.maxWidth;
                final double radius =
                    side / 2 * stateScale * (_liquid.radius / 52);
                _orbRenderedRadius = radius;
                // Expansion preserves the original dock center. The pointer's hit
                // offset is retained while only the rendered center has inertia.
                final Offset expansion = Offset(
                    (config.side == FeedbackSide.left ? -1 : 1) *
                        (side - 56) /
                        2,
                    (side - 56) / 2);
                return Transform.translate(
                    offset: _liquid.position + expansion,
                    child: Stack(
                        key: _orbLensAnchorKey,
                        clipBehavior: Clip.none,
                        fit: StackFit.expand,
                        children: <Widget>[
                          Positioned(
                              left: side / 2 - radius * 1.6,
                              top: side / 2 - radius * 1.6,
                              width: radius * 3.2,
                              height: radius * 3.2,
                              child: KeyedSubtree(
                                  key: const Key('feedback-orb-lens'),
                                  child: _buildOrbLensLayer(radius,
                                      fixedCenter: _isDragging
                                          ? null
                                          : _orbIdleDockCenter,
                                      mist: _isDragging ? 0 : .74,
                                      idleMix: _isDragging ? 0 : 1))),
                        ]));
              })),
    );

    // 焦点环：等价 CSS outline 2px + offset 2px，描边覆盖 R+2…R+4。
    // Positioned + IgnorePointer 不改变布局尺寸与命中区；无过渡。
    final double ringInset =
        -(kFeedbackOrbFocusWidth + kFeedbackOrbFocusOffset);
    final Widget orbWithFocusRing = Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        orbBox,
        if (_orbFocusVisible && _orbFocusNode.hasPrimaryFocus)
          Positioned(
            left: ringInset,
            top: ringInset,
            right: ringInset,
            bottom: ringInset,
            child: IgnorePointer(child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints ringBox) {
                final double side = ringBox.maxWidth + 2 * ringInset;
                final Offset expansion = Offset(
                    (config.side == FeedbackSide.left ? -1 : 1) *
                        (side - 56) /
                        2,
                    (side - 56) / 2);
                return Transform.translate(
                    offset: _liquid.position + expansion,
                    child: DecoratedBox(
                      key: const Key('feedback-orb-focus-ring'),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                          width: kFeedbackOrbFocusWidth,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ));
              },
            )),
          ),
      ],
    );

    return FocusableActionDetector(
      focusNode: _orbFocusNode,
      autofocus: false,
      // 选区覆盖层期间入口退出焦点链与快捷键（等效 ExcludeFocus）：
      // 键盘只作用于覆盖层，Tab / Space / Enter 不会再落到球上。
      enabled: _selectionCapture == null,
      // 键盘聚焦后锁存；pressed / hover / 拖动都不得清除（spec 5），
      // 失焦、hidden 与指针关闭后的单次抑制才清除。鼠标点击不请求焦点，
      // 因此不会点亮环。
      onShowFocusHighlight: (bool show) {
        if (!show) return;
        if (_orbSuppressRingOnce) {
          // 指针模态的焦点回归：焦点回球但不点亮环，等下一次键盘聚焦。
          _orbSuppressRingOnce = false;
          return;
        }
        if (_orbFocusVisible || !mounted) return;
        setState(() => _orbFocusVisible = true);
      },
      onFocusChange: (bool focused) {
        if (focused || !_orbFocusVisible) return;
        _orbFocusVisible = false;
        if (mounted) setState(() {});
      },
      // 局部快捷键：不依赖宿主 `WidgetsApp` 的默认映射（Flutter Web 的
      // Enter 默认映射为 ButtonActivateIntent），也不改动全局快捷键。
      shortcuts: const <ShortcutActivator, Intent>{
        SingleActivator(LogicalKeyboardKey.space, includeRepeats: false):
            ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.enter, includeRepeats: false):
            ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.numpadEnter, includeRepeats: false):
            ActivateIntent(),
      },
      actions: <Type, Action<Intent>>{
        ActivateIntent: CallbackAction<ActivateIntent>(
          onInvoke: (_) {
            _handleLauncherTap();
            return null;
          },
        ),
      },
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _orbHovered = true),
        onExit: (_) => setState(() => _orbHovered = false),
        child: Semantics(
          button: true,
          label: '灵感球',
          child: Listener(
            onPointerDown: (PointerDownEvent event) {
              if (event.buttons != kPrimaryButton ||
                  _orbPointer != null ||
                  _temporarilyHideForCapture ||
                  _selectionCapture != null) {
                return;
              }
              _wakeRecognizer?.cancel();
              _orbPointer = event.pointer;
              _orbPointerStart = event.position;

              final RenderBox? box = _orbLensAnchorKey.currentContext
                  ?.findRenderObject() as RenderBox?;
              _orbDockGlobal = box != null && box.attached
                  ? box.localToGlobal(box.size.center(Offset.zero))
                  : event.position;
              _liquid.reset();

              _setOrbPressed(true);
            },
            onPointerMove: (PointerMoveEvent event) {
              if (event.pointer != _orbPointer || _orbPointerStart == null) {
                return;
              }

              final Offset offset = event.position - _orbPointerStart!;
              if (!_isDragging &&
                  offset.distance <= kFeedbackOrbDragThreshold) {
                return;
              }
              if (!_isDragging) unawaited(_captureLensSnapshot());
              setState(() {
                _isDragging = true;
                _orbPressTransition = false;
                _orbPressed = false;

                _liquid.target = offset;
                _kickLiquid();
              });
            },
            onPointerUp: (PointerUpEvent event) {
              if (event.pointer != _orbPointer) return;
              _orbPointer = null;
              if (_orbPointerStart == null || !_lensVisible) return;
              final bool dragged = _isDragging;
              final RenderRepaintBoundary? boundary =
                  _repaintBoundaryKey.currentContext?.findRenderObject()
                      as RenderRepaintBoundary?;
              final Offset visualGlobal =
                  (_orbDockGlobal ?? event.position) + _liquid.position;
              _selectionOrbCenter = boundary?.globalToLocal(visualGlobal);
              _selectionDirection = _liquid.direction;
              _selectionDeform = _liquid.shaderDeform;
              _selectionWobble = _liquid.wobble;
              _selectionRadius = _orbRenderedRadius;
              setState(() {
                _isDragging = false;
                _orbPressTransition = !dragged;
                _orbPressed = false;
                _resetLiquid();
              });
              if (dragged) {
                unawaited(_captureForSelection(releaseGlobal: event.position));
              } else {
                _handleLauncherTap();
              }
            },
            onPointerCancel: (PointerCancelEvent event) {
              if (event.pointer != _orbPointer) return;
              _orbPointer = null;
              _cleanUpOrbPan(_resetOrbReleaseState);
            },
            child: GestureDetector(
                key: const Key('feedback-orb'),
                behavior: HitTestBehavior.opaque,
                child: orbWithFocusRing),
          ),
        ),
      ),
    );
  }

  Widget _buildOrbLensLayer(double radius,
          {Offset? fixedCenter,
          Size? halfSize,
          double handleMix = 0,
          double mist = 0,
          double idleMix = 0}) =>
      ValueListenableBuilder<_OrbLensSnapshot?>(
          valueListenable: _lensSnapshot,
          builder: (BuildContext context, _OrbLensSnapshot? snapshot,
              Widget? child) {
            if (snapshot == null || MediaQuery.highContrastOf(context)) {
              return IgnorePointer(
                  child: CustomPaint(
                      painter: OrbLiquidOutlinePainter(
                          radius: radius,
                          halfSize: halfSize,
                          handleMix: handleMix,
                          idleMix: idleMix,
                          dark: Theme.of(context).brightness == Brightness.dark,
                          highContrast: MediaQuery.highContrastOf(context),
                          direction: _liquid.direction,
                          deform: _liquid.shaderDeform,
                          wobble: _liquid.wobble,
                          color: MediaQuery.highContrastOf(context)
                              ? Theme.of(context).colorScheme.onSurface
                              : Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: .4))));
            }
            final RenderRepaintBoundary? boundary =
                _repaintBoundaryKey.currentContext?.findRenderObject()
                    as RenderRepaintBoundary?;
            final RenderBox? anchor = fixedCenter == null
                ? _orbLensAnchorKey.currentContext?.findRenderObject()
                    as RenderBox?
                : null;
            if (boundary == null ||
                !boundary.attached ||
                (fixedCenter == null &&
                    (anchor == null || !anchor.attached || !anchor.hasSize))) {
              return const SizedBox.expand();
            }
            // Convert both the moving center and drawing-box offset through the
            // capture boundary: embedding at a nonzero global origin is supported.
            final Offset center = fixedCenter ??
                boundary.globalToLocal(_orbDockGlobal == null
                    ? anchor!.localToGlobal(anchor.size.center(Offset.zero))
                    : _orbDockGlobal! + _liquid.position);
            return RepaintBoundary(
                child: IgnorePointer(
                    child: CustomPaint(
                        key: const Key('feedback-orb-lens-shader'),
                        painter: OrbLiquidLensPainter(
                            image: snapshot.image,
                            shader: snapshot.shader,
                            offset: center - Offset(radius * 1.6, radius * 1.6),
                            scale: snapshot.pixelRatio,
                            center: center,
                            radius: radius,
                            halfSize: halfSize,
                            handleMix: handleMix,
                            mist: mist,
                            idleMix: idleMix,
                            direction: _liquid.direction,
                            deform: _liquid.shaderDeform,
                            wobble: _liquid.wobble,
                            dark: Theme.of(context).brightness ==
                                Brightness.dark))));
          });

  Widget _buildPanel(FeedbackConfig config, {required bool visible}) {
    return Shortcuts(
      shortcuts: <ShortcutActivator, Intent>{
        const SingleActivator(LogicalKeyboardKey.escape):
            const _CloseFeedbackIntent(),
      },
      child: Actions(
        actions: <Type, Action<Intent>>{
          _CloseFeedbackIntent: CallbackAction<_CloseFeedbackIntent>(
            onInvoke: (_) {
              _close();
              return null;
            },
          ),
        },
        child: FeedbackPanel(
          key: _panelKey,
          config: config,
          visible: visible,
          onRequestClose: _close,
          onRetakeScreenshot: _retakeScreenshot,
          logProvider: widget.logProvider,
          filePicker: widget.filePicker,
          imagePicker: widget.imagePicker,
          httpClient: widget.httpClient,
          tokenStore: widget.tokenStore,
          tokenStoreFactory: widget.tokenStoreFactory,
          serverPrefStore: widget.serverPrefStore,
          // 宿主托管（v0.8.4）：值以宿主为准，变更回调透传给宿主保存；
          // 宿主只给值不给回调时隐藏面板内对应的设置区，避免无效操作。
          orbIdleStyle: _orbIdleStyle,
          orbIdleSessionOnly: _orbIdleSessionOnly,
          onOrbIdleStyleChanged: widget.orbIdleStyle != null
              ? widget.onOrbIdleStyleChanged
              : _idlePreferences.select,
          wakeGestures: _wakeGestures,
          wakeGesturesSessionOnly: _wakeGesturesSessionOnly,
          onWakeGesturesChanged: widget.wakeGestures != null
              ? widget.onWakeGesturesChanged
              : _wakePreferences.select,
          // T6/T7：向控制器上报实际使用地址；地址变化时使外层截图会话
          // 失效（旧会话的迟到交付不得写入新身份的草稿）。
          onEffectiveApiBaseChange: _onEffectiveApiBaseChange,
          onUnreadCountChange: (int count) {
            _controller.setUnreadCount(count);
          },
        ),
      ),
    );
  }
}

/// One progress drives the safe glass center, shape and its moving hit target.
/// A sphere can still be fully visible before reaching the side clip; keep
/// that painted contour inside the target while it shrinks from 56 to 44.
class _OrbMorphGeometry {
  factory _OrbMorphGeometry({
    required bool left,
    required bool handle,
    required bool dark,
    required double progress,
    required Offset dockCenter,
    required EdgeInsets safeInsets,
    required double viewportWidth,
  }) {
    final double safeLeft = safeInsets.left;
    final double safeRight = viewportWidth - safeInsets.right;
    final double edge = left ? safeLeft : safeRight;
    final double dockGap =
        left ? dockCenter.dx - 28 - edge : edge - dockCenter.dx - 28;
    final double halfWidth =
        28 + ((handle ? (dark ? 5 : 6) : 28) - 28) * progress;
    final double halfHeight = 28 + (handle && dark ? -4 : 0) * progress;
    final double inset =
        dockGap + ((handle ? (dark ? 10 : 3) : -28) - dockGap) * progress;
    final Offset center = Offset(
        left ? edge + inset + halfWidth : edge - inset - halfWidth,
        dockCenter.dy);
    // Horizontal r=1 of R7's sphere/capsule mix (at delta.y=0). This changes
    // hit layout only; sampling, shader math and the safe-side clip stay fixed.
    final double extent =
        handle ? 1 / ((1 - progress) / 28 + progress / halfWidth) : 28;
    final double visibleLeft = math.max(safeLeft, center.dx - extent);
    final double visibleRight = math.min(safeRight, center.dx + extent);
    final double width = math.max(
        56 + (44 - 56) * progress, (visibleRight - visibleLeft).clamp(0, 56));
    final double nominalInset = dockGap * (1 - progress);
    final double nominalLeft =
        left ? edge + nominalInset : edge - nominalInset - width;
    final double hitLeft = nominalLeft.clamp(visibleRight - width, visibleLeft);
    final Rect hit = Rect.fromLTWH(hitLeft, dockCenter.dy - 28, width, 56);
    return _OrbMorphGeometry._(
        progress,
        center,
        halfWidth,
        halfHeight,
        inset,
        hit,
        left ? hit.left - edge : edge - hit.right,
        math.min(
            viewportWidth - safeInsets.horizontal, math.max(56, dockGap + 56)));
  }

  const _OrbMorphGeometry._(
      this.progress,
      this.center,
      this.halfWidth,
      this.halfHeight,
      this.paintInset,
      this.hit,
      this.hitInset,
      this.clipWidth);
  final double progress;
  final Offset center;
  final double halfWidth;
  final double halfHeight;
  final double paintInset;
  final Rect hit;
  final double hitInset;
  final double clipWidth;
}

/// Dock clipping is horizontal: round caps, soft shadow and keyboard outline
/// retain their vertical paint allowance without crossing the safe side edge.
class _OrbDockClipper extends CustomClipper<Rect> {
  const _OrbDockClipper();

  @override
  Rect getClip(Size size) =>
      Rect.fromLTRB(0, -16.8, size.width, size.height + 16.8);

  @override
  bool shouldReclip(_OrbDockClipper oldClipper) => false;
}

/// 宿主无 `Overlay` 祖先时（组件按集成文档/示例包在 `MaterialApp` 外侧）
/// 自备的兜底 Overlay（内部实现，不改变对外 API）。
///
/// **为什么不能直接用 `Overlay(initialEntries: [...])`**：`initialEntries`
/// 只在 Overlay **首次挂载**时插入一次，之后 OverlayState 忽略新的列表；
/// 而 `OverlayEntry` 是 StatefulWidget 且实例不变，其 builder 若捕获了
/// 首帧的 child，父级（`FeedbackWidget`）setState 重建出的新子树永远到不了
/// 树上——`updateChild` 收到同一实例直接跳过，整棵面板子树冻结在首帧
/// （`_everOpened` 变 true、`open` 变 true，但面板 / 选区覆盖层 / 遮罩
/// 都不出现）。
///
/// 这里采用与 Flutter 官方 `OverlayPortal` 的 `_WrappingOverlay` 完全一致
/// 的模式：State 持有**唯一** entry（builder 每次求值都读取当前
/// `widget.child`），`didUpdateWidget` 在 child 实例变化时
/// `markNeedsBuild()`——子树随父级 setState 同步刷新；该 entry 仍是面板
/// 上下文的最近 Overlay，对话框 / 放大预览 / `openAsOverlay` 的兜底路径
/// 保持可用。
class _FallbackOverlay extends StatefulWidget {
  const _FallbackOverlay({required this.child});

  final Widget child;

  @override
  State<_FallbackOverlay> createState() => _FallbackOverlayState();
}

class _FallbackOverlayState extends State<_FallbackOverlay> {
  /// 唯一 entry：仅在首次 build 时作为 `initialEntries` 插入一次。
  late final OverlayEntry _entry = OverlayEntry(
    builder: (BuildContext _) => widget.child,
  );

  @override
  void didUpdateWidget(_FallbackOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    // child 换了新实例：entry 实例不变、builder 不会被重新求值，
    // 必须显式标记重建，否则子树停留在首帧（冻结缺陷回归点）。
    if (!identical(oldWidget.child, widget.child)) {
      _entry.markNeedsBuild();
    }
  }

  @override
  void dispose() {
    _entry
      ..remove()
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Overlay(initialEntries: <OverlayEntry>[_entry]);
}

/// v12 挂载环境兜底（组件包在 MaterialApp 外侧时生效）：
/// 面板 UI 需要 `Directionality` / `MediaQuery` / `Localizations` /
/// `Theme` / `Overlay` / 文本编辑快捷键祖先——宿主 MaterialApp 是组件的 child，
/// 祖先查找只向上走，所以缺失时组件自备最小环境。
///
/// 在 MaterialApp 内挂载（旧 builder 方式）时所有祖先齐备，本组件
/// 什么都不包，保持原有行为不变。
class _FeedbackEnvironment extends StatelessWidget {
  const _FeedbackEnvironment({required this.child, required this.themeMode});

  final Widget child;
  final FeedbackThemeMode themeMode;

  @override
  Widget build(BuildContext context) {
    Widget result = child;
    // Android 输入法也可能以 DEL 按键发送退格；没有 WidgetsApp 的默认
    // 文本编辑快捷键时，文字能输入却无法通过这类按键删除。沿用 Flutter
    // 的原生编辑行为；已有祖先时不覆盖宿主在其内部设置的快捷键。
    if (context.findAncestorWidgetOfExactType<DefaultTextEditingShortcuts>() ==
        null) {
      result = DefaultTextEditingShortcuts(child: result);
    }
    // Overlay 祖先：面板对话框与放大预览的兜底承载（无 Navigator 时）。
    // ⚠ `Overlay.initialEntries` 只在 Overlay **首次挂载**时插入，之后
    // OverlayState 忽略新列表；若把子树闭包进 initialEntries，父级
    // setState 重建出的新子树永远到不了树上——面板 / 选区覆盖层 / 遮罩
    // 会全部冻结在首帧（组件挂在 MaterialApp 外侧时整棵树只建一次）。
    // 交给 [_FallbackOverlay]：State 持有唯一 entry，builder 读取最新
    // child，并在 didUpdateWidget 中 markNeedsBuild（与 Flutter 官方
    // OverlayPortal/_WrappingOverlay 同一模式）。
    if (Overlay.maybeOf(context) == null) {
      result = _FallbackOverlay(child: result);
    }
    // Theme 是 StatelessWidget 而非 InheritedWidget：用祖先查找判定缺失。
    if (context.findAncestorWidgetOfExactType<Theme>() == null) {
      final Brightness brightness = switch (themeMode) {
        FeedbackThemeMode.light => Brightness.light,
        FeedbackThemeMode.dark => Brightness.dark,
        FeedbackThemeMode.system =>
          View.of(context).platformDispatcher.platformBrightness,
      };
      result = Theme(
        data: ThemeData(
          colorSchemeSeed: const Color(0xFF0071E3),
          brightness: brightness,
          useMaterial3: true,
        ),
        child: result,
      );
    }
    if (Localizations.maybeLocaleOf(context) == null) {
      final Locale requestedLocale = View.of(context).platformDispatcher.locale;
      // DefaultMaterialLocalizations 只支持英语；直接传系统中文等语言会
      // 被 Localizations 跳过，导致 TextField 在发布构建中空白并抛错。
      final Locale fallbackLocale =
          DefaultMaterialLocalizations.delegate.isSupported(requestedLocale)
              ? requestedLocale
              : const Locale('en');
      result = Localizations(
        locale: fallbackLocale,
        delegates: const <LocalizationsDelegate<Object>>[
          DefaultMaterialLocalizations.delegate,
          DefaultWidgetsLocalizations.delegate,
        ],
        child: result,
      );
    }
    if (MediaQuery.maybeOf(context) == null) {
      result = MediaQuery.fromView(
        view: View.of(context),
        child: result,
      );
    }
    if (Directionality.maybeOf(context) == null) {
      result = Directionality(
        textDirection: TextDirection.ltr,
        child: result,
      );
    }
    return result;
  }
}

/// One owner for each local masked snapshot. No unmasked fallback exists.
class _OrbLensSnapshot {
  const _OrbLensSnapshot(
      {required this.image, required this.pixelRatio, required this.shader});
  final ui.Image image;
  final double pixelRatio;
  final ui.FragmentShader shader;
}

class _CaptureHandoff {
  _CaptureHandoff(
      {required this.seq,
      required this.image,
      required this.background,
      required this.source});
  final int seq;
  final ui.Image image;
  final ui.Image background;
  final Rect source;
  Rect? target;
}
