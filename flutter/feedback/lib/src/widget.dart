import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui show Image, ImageByteFormat, Picture, PictureRecorder;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart' show GestureBinding;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show MatrixUtils, RenderEditable, RenderRepaintBoundary;
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
import 'panel.dart';
import 'server_pref.dart';
import 'test_env.dart';
import 'token_store.dart';

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
  void dispose() => image.dispose();
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
    with SingleTickerProviderStateMixin {
  FeedbackController? _internalController;
  bool _everOpened = false;

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

  // 灵感球拖拽状态
  Offset _dragOffset = Offset.zero;
  Offset _lastGlobalPosition = Offset.zero;
  bool _isDragging = false;
  bool _orbHovered = false;
  bool _orbPressed = false;
  bool _orbPressTransition = false;
  bool _orbReleasing = false;
  double _orbReleaseAngle = 0.0;
  bool _orbPointerCancelled = false;

  /// 灵感球键盘焦点节点：由 Tab 聚焦，鼠标点击不请求焦点。
  final FocusNode _orbFocusNode = FocusNode(debugLabel: 'feedback-orb');

  /// 键盘聚焦后锁存的焦点环（spec 5）。pressed / dragging / hover 不清除；
  /// 清除来源为失焦、hidden，以及指针关闭后的单次抑制（T7i）。
  /// 环本身不参与布局与命中。
  bool _orbFocusVisible = false;

  double get _orbTargetStateScale {
    if (_isDragging) return 1.0;
    if (_orbReleasing) return 1.0;
    if (_orbPressed) return kFeedbackOrbPressedScale;
    if (_orbHovered) return kFeedbackOrbHoverScale;
    return 1.0;
  }

  void _setOrbPressed(bool pressed) {
    if (_orbPressed == pressed) return;
    setState(() {
      // 保留刚退出 pressed 的 140ms 窗口，对齐 Web 的 is-unpressing。
      _orbPressTransition = !_isDragging && (_orbPressed || pressed);
      _orbPressed = pressed;
    });
  }

  /// hidden 抢占进行中的拖动 / 回弹 / 悬停时集中复位（spec 5）：球体卸载会让
  /// 回弹 tween 的 onEnd 永不触发，MouseRegion 在 detach 后也不再派发 onExit。
  /// 悬停无需手工恢复：恢复帧的 MouseTracker 会按指针实际位置重新补发
  /// onEnter。调用方负责触发重建。
  void _resetOrbReleaseState() {
    _orbReleasing = false;
    _orbReleaseAngle = 0.0;
    _dragOffset = Offset.zero;
    _isDragging = false;
    _orbPressed = false;
    _orbPressTransition = false;
    _orbPointerCancelled = false;
    _orbHovered = false;
  }

  /// 灵感球光晕流动动画（系统「减少动态效果」时不创建、不运行；
  /// Flutter 测试环境默认不创建——见 [kFeedbackInFlutterTest]）。
  AnimationController? _orbGlow;
  bool _orbGlowReduced = false;
  bool _orbFlowRunning = false;

  FeedbackController get _controller =>
      widget.controller ?? (_internalController ??= FeedbackController());

  @override
  void initState() {
    super.initState();
    _panelWasOpen = _controller.isOpen;
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
    final bool reduce = MediaQuery.disableAnimationsOf(context);
    _orbGlowReduced = reduce;
    if (reduce) _orbReleasing = false;
    if (_orbGlow == null &&
        !reduce &&
        (!kFeedbackInFlutterTest || debugForceOrbAnimation)) {
      _orbGlow = AnimationController(
        vsync: this,
        duration: kFeedbackOrbSweepDuration,
      );
    }
    _syncOrbFlow();
  }

  void _syncOrbFlow() {
    final AnimationController? glow = _orbGlow;
    if (glow == null) return;
    bool shouldRunFlow() => orbShouldRunFlow(
          open: _controller.isOpen,
          orbMode: widget.config.launcherMode == FeedbackLauncherMode.orb,
          showLauncher: widget.config.showLauncher,
          reducedMotion: _orbGlowReduced,
          occluded: _selectionCapture != null,
        );
    final bool shouldRun = shouldRunFlow();
    final bool changed = _orbFlowRunning != shouldRun;
    _orbFlowRunning = shouldRun;
    if (!shouldRun) {
      glow.stop();
      if (glow.value != 0 || changed) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _orbGlow != glow || shouldRunFlow()) return;
          glow.value = 0;
        });
      }
    } else if (!glow.isAnimating && changed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _orbGlow != glow || !shouldRunFlow()) return;
        glow.value = 0;
        glow.repeat();
      });
    }
  }

  @override
  void didUpdateWidget(FeedbackWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.config.appId != widget.config.appId ||
        oldWidget.config.apiBase != widget.config.apiBase) {
      // 宿主身份变化时，面板的偏好读取可能仍在等待；先使截图会话失效，
      // 防止旧身份的编码结果迟到后交付给新身份。
      _invalidateCaptureSession();
      if (mounted && _temporarilyHideForCapture) {
        setState(() => _temporarilyHideForCapture = false);
      }
    }
    if (oldWidget.controller != widget.controller) {
      // 控制器替换：旧会话立即失效，旧请求不得再影响新控制器的 UI。
      _invalidateCaptureSession();
      _unbindController(oldWidget.controller ?? _internalController!);
      _bindController(_controller);
      _panelWasOpen = _controller.isOpen;
      // 换入的控制器可能已打开：入口随即 hidden，抢占进行中的回弹。
      if (_controller.isOpen) _resetOrbReleaseState();
    }
    if ((oldWidget.config.showLauncher && !widget.config.showLauncher) ||
        (oldWidget.config.launcherMode == FeedbackLauncherMode.orb &&
            widget.config.launcherMode != FeedbackLauncherMode.orb)) {
      // 入口变为 hidden（关闭入口或离开 orb 模式）：抢占进行中的回弹，
      // 恢复可见后从静态起点开始。本次 didUpdateWidget 后必然重建。
      _resetOrbReleaseState();
    }
  }

  void _bindController(FeedbackController controller) {
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
    _panelWasOpen = _controller.isOpen;
    if (_controller.isOpen) {
      _everOpened = true;
      // 呼出时把焦点请求到输入区。
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _panelKey.currentState?.requestInputFocus();
      });
    } else {
      // 面板关闭（含宿主直接调用 controller.close()）：进行中的捕获会话
      // 一并失效，捕获完成后不再挂载 / 恢复面板 UI。
      _invalidateCaptureSession();
      if (wasOpen) {
        // 面板关闭后把焦点还给入口（仅 orb 模式且入口可见）。环是否点亮
        // 取决于最近输入模态：指针模态的回归只移动焦点（spec 5：鼠标
        // 聚焦不显示环），键盘模态照常点亮。
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _controller.isOpen) return;
          if (!widget.config.showLauncher ||
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
      if (!_controller.isOpen) _temporarilyHideForCapture = false;
    });
  }

  /// 开始新的捕获会话：使所有旧会话失效，并统一恢复截图期间隐藏的覆盖层
  /// （宿主布局回到常规状态后再等待 paint / 捕获）。
  void _startCaptureSession() {
    _invalidateCaptureSession();
    if (mounted && _temporarilyHideForCapture) {
      setState(() => _temporarilyHideForCapture = false);
    }
  }

  /// 使当前进行中的捕获会话全部失效（取消 / 关闭 / 身份切换）。
  /// 同时作废 T1 局部选区流程：丢弃冻结画面并恢复 UI。
  void _invalidateCaptureSession() {
    _captureSeq++;
    final _FrozenCapture? selection = _selectionCapture;
    if (selection != null) {
      _selectionCapture = null;
      selection.dispose();
      if (mounted && !_disposed) setState(() {});
    }
  }

  void _cancelCapture() {
    // 用户取消：静默使旧会话失效（不报错），旧请求不得恢复新请求 UI
    // ——此时已无新请求，可安全统一恢复覆盖层与拖拽状态。
    _invalidateCaptureSession();
    if (mounted) {
      setState(() {
        _dragOffset = Offset.zero;
        _isDragging = false;
        _temporarilyHideForCapture = false;
      });
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _captureSeq++;
    final _FrozenCapture? selection = _selectionCapture;
    _selectionCapture = null;
    selection?.dispose();
    GestureBinding.instance.pointerRouter
        .removeGlobalRoute(_globalPointerRoute);
    HardwareKeyboard.instance.removeHandler(_handleGlobalKeyEvent);
    _orbFocusNode.dispose();
    _orbGlow?.dispose();
    _orbGlow = null;
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
    required int seq,
    Offset? releasePoint,
  }) async {
    // 等待一帧完成：确保 paint 状态与随后同步记录的几何一致。
    await WidgetsBinding.instance.endOfFrame;
    // 会话校验：等待 paint 期间会话被取消 / 关闭 / 新会话取代则中止。
    if (!mounted || seq != _captureSeq) return null;

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
      if (!mounted || seq != _captureSeq) return null;
      source = await boundary.toImage(pixelRatio: scale);
      if (!mounted || seq != _captureSeq) return null;
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
        if (!mounted || seq != _captureSeq) return null;
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
      if (!mounted || seq != _captureSeq) return null;
      final (Uint8List, int, int)? encoded =
          await _encodeCapturePng(frozen.image);
      // 编码是异步步骤：完成后再次校验会话，过期结果直接丢弃。
      if (encoded == null || !mounted || seq != _captureSeq) return null;
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
    if (!mounted || seq != _captureSeq) return;
    _open();
    // 面板可能尚未挂载（首次呼出）：等挂载后在 post-frame 交付，
    // 交付前再次校验捕获序号，防止 post-frame 回调写入过期结果。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || seq != _captureSeq) return;
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
    final double rx =
        reference.width > 0 ? (releaseGlobal.dx / reference.width) : 0.5;
    final double ry =
        reference.height > 0 ? (releaseGlobal.dy / reference.height) : 0.5;
    final Offset releasePoint = Offset(rx.clamp(0.0, 1.0), ry.clamp(0.0, 1.0));

    // 1) 图片上限：已达上限且无可替换截图（capture 槽位）→ 提示整理附件。
    final FeedbackPanelState? panel = _panelKey.currentState;
    if (panel != null && !panel.canAcceptCapture) {
      panel.showComposeNotice(
          '图片附件已达 ${panel.captureImageLimit} 张上限，请先整理附件后再截图');
      _open();
      return;
    }
    // 2) 草稿守卫：已有草稿 / 图片 / 日志 → 只打开面板原样恢复，不重新捕获。
    if (_panelHasDraftContent()) {
      _open();
      return;
    }
    // 3) 冻结捕获（与整窗截图同一遮挡管线）。
    _startCaptureSession();
    final int seq = _captureSeq;
    final _FrozenCapture? frozen =
        await _captureFrozen(seq: seq, releasePoint: releasePoint);
    if (!mounted || seq != _captureSeq) {
      frozen?.dispose();
      return;
    }
    if (frozen == null) {
      // 失败：保留旧草稿旧图并提示可重试；不产出任何截图、不回退整屏。
      _open();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || seq != _captureSeq) return;
        _panelKey.currentState?.showComposeNotice('截图失败，已保留原草稿与图片；可再次拖动灵感球重试');
      });
      return;
    }
    setState(() => _selectionCapture = frozen);
  }

  /// 选区流程确认：[selection] 为 null 表示「截取整个窗口」（region 省略），
  /// 非 null 表示把冻结位图裁到选区（`capture.region` 归一化透传）。
  Future<void> _deliverSelection({Rect? selection}) async {
    final _FrozenCapture? frozen = _selectionCapture;
    if (frozen == null) return;
    final int seq = _captureSeq;
    setState(() => _selectionCapture = null); // 覆盖层立即收起，位图另行释放
    ui.Image? cropped;
    Uint8List? bytes;
    int? outWidth;
    int? outHeight;
    try {
      ui.Image? source;
      if (selection == null) {
        source = frozen.image;
      } else {
        source = cropped = await _cropFrozen(frozen, selection);
      }
      if (source != null) {
        final (Uint8List, int, int)? encoded = await _encodeCapturePng(source);
        bytes = encoded?.$1;
        outWidth = encoded?.$2;
        outHeight = encoded?.$3;
      }
    } finally {
      cropped?.dispose();
      frozen.dispose();
    }
    // 会话 / 身份在裁剪期间失效：迟到结果直接丢弃（流程作废）。
    if (!mounted || seq != _captureSeq) return;
    final FeedbackCaptureInfo base = frozen.baseInfo;
    if (bytes == null) {
      // 编码失败：打开面板提示可重试，不写入任何截图。
      _open();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || seq != _captureSeq) return;
        _panelKey.currentState?.showComposeNotice('截图失败，已保留原草稿与图片；可再次拖动灵感球重试');
      });
      return;
    }
    final FeedbackCaptureInfo info = FeedbackCaptureInfo(
      viewportWidth: base.viewportWidth,
      viewportHeight: base.viewportHeight,
      pixelWidth: outWidth,
      pixelHeight: outHeight,
      capturedAt: base.capturedAt,
      releasePoint: base.releasePoint,
      // 整窗捕获省略 region；局部选区按原始捕获视口 0..1 归一化。
      region: selection == null
          ? null
          : normalizeCaptureRegion(selection, frozen.viewport),
    );
    _open();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || seq != _captureSeq) return;
      final FeedbackPanelState? panel = _panelKey.currentState;
      if (panel == null) return;
      panel.setScreenshot(bytes!, info,
          captureSeq: seq, containsUndrawable: frozen.containsUndrawable);
      panel.requestInputFocus();
    });
  }

  /// 取消选区流程：丢弃冻结画面并恢复 UI；不覆盖原草稿、不报失败。
  void _cancelSelection() {
    _invalidateCaptureSession();
    if (mounted && !_disposed) {
      setState(() {
        _dragOffset = Offset.zero;
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
    if (mounted && seq == _captureSeq && result != null) {
      _panelKey.currentState?.setScreenshot(result.bytes, result.info,
          captureSeq: seq, containsUndrawable: result.containsUndrawable);
    }
    // 旧请求的 finally 不得恢复新请求的 UI：仅在会话仍有效时恢复；
    // 会话被取消时由 _cancelCapture 统一恢复，被新会话取代时由新会话管理。
    if (mounted && seq == _captureSeq) {
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

  @override
  Widget build(BuildContext context) {
    final FeedbackConfig config = widget.config;
    final bool open = _controller.isOpen;
    // hidden（面板打开或入口关闭）时清除焦点环锁存：入口不渲染时保留 true
    // 会让下次显示在没有焦点的情况下画出环；指针关闭路径也依赖这里抑制环
    //（T7i），不是纯防御。build 内不能 setState。
    if (open || !config.showLauncher) _orbFocusVisible = false;
    _syncOrbFlow();
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final double height = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : MediaQuery.of(context).size.height;
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
        final bool isLeft = config.side == FeedbackSide.left;

        final double bottom =
            config.position?.dy ?? _parseBottom(config.launcherBottom, height);
        // T9：面板底部抬升键盘实际重叠量（未避让部分），避免输入框与
        // 操作按钮被软键盘覆盖；宿主已避让时为 0，不产生双重留白。
        final double keyboardOverlap = _keyboardOverlap(context);
        final double? left = isLeft ? (config.position?.dx ?? 20.0) : null;
        final double? right = isLeft ? null : (config.position?.dx ?? 20.0);

        // 提供本实例私有的遮挡作用域：子树内的 FeedbackCaptureMask
        // 注册到最近的作用域（嵌套组件实例各归其主）。
        return FeedbackCaptureScopeWidget(
          scope: _captureScope,
          child: _FeedbackEnvironment(
            themeMode: config.theme,
            child: Stack(
              children: <Widget>[
                Positioned.fill(
                  child: RepaintBoundary(
                    key: _repaintBoundaryKey,
                    child: widget.child,
                  ),
                ),
                // 宽屏抽屉展开时压一层可点击遮罩；窄屏为全屏页面不需要。
                if (open && wide && !_temporarilyHideForCapture)
                  Positioned.fill(
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
                              child: _buildPanel(config, visible: open),
                            );
                    }),
                  ),
                ),
                if (!open && config.showLauncher)
                  Positioned(
                    bottom: bottom,
                    left: left,
                    right: right,
                    child: Builder(
                      builder: (BuildContext context) =>
                          config.launcherMode == FeedbackLauncherMode.orb
                              ? _buildOrb(context, config)
                              : _buildFab(context, config),
                    ),
                  ),
                // T1：拖动灵感球后的局部选区覆盖层——置于最上层，
                // 冻结位图不透明铺满，灵感球 / 面板 / 启动入口都被其覆盖。
                if (_selectionCapture != null)
                  Positioned.fill(
                    child: CaptureSelectionOverlay(
                      key: const Key('feedback-capture-selection-overlay'),
                      image: _selectionCapture!.image,
                      viewport: _selectionCapture!.viewport,
                      releasePoint: _selectionCapture!.baseInfo.releasePoint,
                      onUseRegion: (Rect region) {
                        unawaited(_deliverSelection(selection: region));
                      },
                      onCaptureWhole: () {
                        unawaited(_deliverSelection(selection: null));
                      },
                      onCancel: _cancelSelection,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
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
    final int unread = _controller.unreadCount;
    Widget icon = const Icon(Icons.feedback_outlined);
    if (unread > 0) {
      icon = Badge.count(count: unread, child: icon);
    }
    return Semantics(
      button: true,
      label: '反馈',
      child: FloatingActionButton(
        key: const Key('feedback-fab'),
        heroTag: 'feedback-widget-fab',
        tooltip: '反馈',
        onPressed: _handleLauncherTap,
        child: icon,
      ),
    );
  }

  Widget _buildOrb(BuildContext context, FeedbackConfig config) {
    final int unread = _controller.unreadCount;
    final bool reduceMotion =
        _orbGlowReduced || MediaQuery.disableAnimationsOf(context);
    final double diameter = (_isDragging && !reduceMotion)
        ? kFeedbackOrbDraggingDiameter
        : kFeedbackOrbIdleDiameter;
    final Duration motion = reduceMotion
        ? Duration.zero
        : (_orbReleasing
            ? kFeedbackOrbReleaseDuration
            : kFeedbackOrbSizeDuration);
    final double target = reduceMotion ? 1.0 : _orbTargetStateScale;
    final double pull =
        (_isDragging && !reduceMotion) ? orbPull(_dragOffset) : 0.0;
    final double angle = reduceMotion
        ? 0.0
        : (_isDragging
            ? orbDragAngle(_dragOffset)
            : (_orbReleasing ? _orbReleaseAngle : 0.0));
    final bool pressTransition = _orbPressed || _orbPressTransition;
    final Brightness brightness = Theme.of(context).brightness;
    OrbPainter orbPainter(double flow, double stateScale, double pull) =>
        OrbPainter(
          flow: flow,
          breath: orbBreath(flow),
          breathWeight:
              (_isDragging || _orbPressed || _orbHovered || _orbReleasing)
                  ? 0.0
                  : 1.0,
          stateScale: stateScale,
          dragAngle: angle,
          pull: pull,
          glowOffset: orbGlowOffset(pull, angle),
          brightness: brightness,
        );
    final AnimationController? glow = _orbGlow;

    Widget orbBox = AnimatedContainer(
      key: const Key('feedback-orb-body'),
      duration: motion,
      curve: _orbReleasing ? kFeedbackOrbReleaseCurve : kFeedbackOrbStateCurve,
      width: diameter,
      height: diameter,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 1.0, end: target),
        duration: reduceMotion
            ? Duration.zero
            : (_orbReleasing
                ? kFeedbackOrbReleaseDuration
                : (pressTransition
                    ? kFeedbackOrbPressDuration
                    : kFeedbackOrbSizeDuration)),
        curve: _orbReleasing
            ? kFeedbackOrbReleaseCurve
            : (pressTransition
                ? kFeedbackOrbPressCurve
                : kFeedbackOrbStateCurve),
        onEnd: () {
          _orbPressTransition = false;
        },
        builder: (BuildContext context, double stateScale, Widget? child) =>
            TweenAnimationBuilder<double>(
          tween: Tween<double>(begin: 0.0, end: pull),
          duration: _orbReleasing ? kFeedbackOrbReleaseDuration : Duration.zero,
          curve: kFeedbackOrbReleaseCurve,
          builder: (BuildContext context, double value, Widget? child) {
            // 回弹过冲会产生负 pull，必须钳制以免 stretch<1、glow 反向。
            final double safePull =
                (_orbReleasing ? value : pull).clamp(0.0, 1.0).toDouble();
            return glow == null
                ? CustomPaint(painter: orbPainter(0.0, stateScale, safePull))
                : AnimatedBuilder(
                    animation: glow,
                    builder: (BuildContext context, Widget? child) =>
                        CustomPaint(
                      painter: orbPainter(
                        reduceMotion ? 0.0 : glow.value,
                        stateScale,
                        safePull,
                      ),
                    ),
                  );
          },
        ),
      ),
    );

    if (unread > 0) {
      orbBox = Badge.count(count: unread, child: orbBox);
    }

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
            child: IgnorePointer(
              child: DecoratedBox(
                key: const Key('feedback-orb-focus-ring'),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    width: kFeedbackOrbFocusWidth,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
              ),
            ),
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
            onPointerDown: (_) {
              setState(() {
                _orbReleasing = false;
                _orbPointerCancelled = false;
                _dragOffset = Offset.zero;
              });
              _setOrbPressed(true);
            },
            onPointerUp: (_) => _setOrbPressed(false),
            onPointerCancel: (_) {
              // 已接受的 Flutter pan 在 PointerCancel 时也调用 onPanEnd。
              _orbPointerCancelled = true;
              _setOrbPressed(false);
            },
            child: GestureDetector(
              key: const Key('feedback-orb'),
              behavior: HitTestBehavior.opaque,
              onPanStart: (DragStartDetails details) {
                _lastGlobalPosition = details.globalPosition;
                setState(() {
                  _orbReleasing = false;
                  _dragOffset = Offset.zero;
                  _isDragging = false;
                });
              },
              onPanUpdate: (DragUpdateDetails details) {
                _lastGlobalPosition = details.globalPosition;
                setState(() {
                  _dragOffset += details.delta;
                  if (_dragOffset.distance > 8.0) {
                    _isDragging = true;
                    _orbPressed = false;
                    _orbPressTransition = false;
                  }
                });
              },
              onPanEnd: (DragEndDetails details) {
                final bool dragged = _isDragging;
                final Offset releaseGlobal = _lastGlobalPosition;
                final double releaseAngle = orbDragAngle(_dragOffset);
                setState(() {
                  _orbReleaseAngle = releaseAngle;
                  _orbReleasing = dragged && !reduceMotion;
                  _dragOffset = Offset.zero;
                  _isDragging = false;
                  _orbPressed = false;
                  _orbPressTransition = false;
                });
                if (_orbPointerCancelled) return;
                if (dragged) {
                  // T1：拖动松手不再直接写草稿——进入局部选区流程
                  // （先冻结已遮挡画面，确认后才交付截图）。
                  _captureForSelection(releaseGlobal: releaseGlobal);
                } else {
                  _handleLauncherTap();
                }
              },
              onPanCancel: () {
                final bool dragged = _isDragging;
                final double releaseAngle = orbDragAngle(_dragOffset);
                setState(() {
                  _orbReleaseAngle = releaseAngle;
                  _orbReleasing = dragged && !reduceMotion;
                  _orbPressTransition =
                      !dragged && (_orbPressed || _orbPressTransition);
                  _dragOffset = Offset.zero;
                  _isDragging = false;
                  _orbPressed = false;
                });
              },
              onTap: () {
                if (!_isDragging) {
                  _handleLauncherTap();
                }
              },
              child: TweenAnimationBuilder<Offset>(
                // 目标不变时 duration=0 不会重启；减少动态效果需当帧终止旧动画。
                key: ValueKey<bool>(reduceMotion),
                tween: Tween<Offset>(begin: Offset.zero, end: _dragOffset),
                duration:
                    _orbReleasing ? kFeedbackOrbReleaseDuration : Duration.zero,
                curve: kFeedbackOrbReleaseCurve,
                onEnd: () {
                  if (!_orbReleasing) return;
                  setState(() {
                    _orbReleasing = false;
                    _orbReleaseAngle = 0.0;
                  });
                },
                builder: (BuildContext context, Offset offset, Widget? child) =>
                    Transform.translate(
                  offset: _orbReleasing ? offset : _dragOffset,
                  child: child,
                ),
                child: orbWithFocusRing,
              ),
            ),
          ),
        ),
      ),
    );
  }

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
/// `Theme` / `Overlay` 祖先——宿主 MaterialApp 是组件的 child，
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
