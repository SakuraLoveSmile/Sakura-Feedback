import 'dart:math' as math;
import 'dart:ui' as ui show Image, ImageByteFormat, Picture, PictureRecorder;
import 'dart:ui' show ImageFilter, Offset, Rect, Size;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show MatrixUtils, RenderEditable, RenderRepaintBoundary;
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:http/http.dart' as http;

import 'api_client.dart' show FeedbackCaptureInfo;
import 'capture_mask.dart';
import 'config.dart';
import 'controller.dart';
import 'panel.dart';
import 'token_store.dart';

/// 宽屏断点：>= 此宽度时面板以侧边抽屉展开，否则全屏页面式。
const double kFeedbackWideBreakpoint = 768;

/// 宽屏侧边抽屉宽度（px），实际不超过视口 90%。
const double kFeedbackPanelWidth = 400;

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
  const _CaptureResult(this.bytes, this.info);
  final Uint8List bytes;
  final FeedbackCaptureInfo info;
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
    @visibleForTesting this.httpClient,
    @visibleForTesting this.tokenStore,
  });

  /// 被包裹的宿主内容。
  final Widget child;

  /// 连接与展示配置。
  final FeedbackConfig config;

  /// 主动呼出接口（`open()` / `close()` / `captureAndOpen()`）。
  final FeedbackController? controller;

  /// 测试注入的 HTTP 客户端。
  @visibleForTesting
  final http.Client? httpClient;

  /// 测试注入的令牌仓库。
  @visibleForTesting
  final FeedbackTokenStore? tokenStore;

  @override
  State<FeedbackWidget> createState() => _FeedbackWidgetState();
}

class _FeedbackWidgetState extends State<FeedbackWidget> {
  FeedbackController? _internalController;
  bool _everOpened = false;
  bool _temporarilyHideForCapture = false;

  /// 捕获会话序号：每次开始新捕获会话自增。会话有效性以
  /// `seq == _captureSeq` 判断；取消 / 关闭 / 销毁 / 控制器替换 / 新会话
  /// 都会使旧会话失效，旧请求不得再交付结果或恢复新请求的 UI。
  int _captureSeq = 0;

  /// 本组件实例私有的遮挡作用域：不同组件实例的遮挡注册互不影响。
  final FeedbackCaptureScope _captureScope = FeedbackCaptureScope();

  final GlobalKey _repaintBoundaryKey = GlobalKey();
  final GlobalKey<FeedbackPanelState> _panelKey =
      GlobalKey<FeedbackPanelState>();

  // 灵感球拖拽状态
  Offset _dragOffset = Offset.zero;
  Offset _lastGlobalPosition = Offset.zero;
  bool _isDragging = false;

  FeedbackController get _controller =>
      widget.controller ?? (_internalController ??= FeedbackController());

  @override
  void initState() {
    super.initState();
    _bindController(_controller);
  }

  @override
  void didUpdateWidget(FeedbackWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      // 控制器替换：旧会话立即失效，旧请求不得再影响新控制器的 UI。
      _invalidateCaptureSession();
      _unbindController(oldWidget.controller ?? _internalController!);
      _bindController(_controller);
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
    }
    setState(() {
      // 关闭时同时复位"截图期间隐藏覆盖层"状态：重拍中途关闭面板后再次
      // 呼出，面板必须恢复可见（否则会一直停留在隐藏状态）。
      if (!_controller.isOpen) _temporarilyHideForCapture = false;
    });
  }

  /// 开始新的捕获会话：使所有旧会话失效，并统一恢复截图期间隐藏的覆盖层
  /// （宿主布局回到常规状态后再等待 paint / 捕获）。
  void _startCaptureSession() {
    _captureSeq++;
    if (mounted && _temporarilyHideForCapture) {
      setState(() => _temporarilyHideForCapture = false);
    }
  }

  /// 使当前进行中的捕获会话全部失效（取消 / 关闭 / 销毁）。
  void _invalidateCaptureSession() {
    _captureSeq++;
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
    _invalidateCaptureSession();
    _unbindController(_controller);
    _internalController?.dispose();
    super.dispose();
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

  Future<_CaptureResult?> _capture({
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

      final FeedbackCaptureInfo captureInfo = FeedbackCaptureInfo(
        viewportWidth: size.width.round(),
        viewportHeight: size.height.round(),
        capturedAt: DateTime.now().toUtc().toIso8601String(),
        releasePoint: releasePoint,
      );

      // PNG 超限时按统一缩小步长重试（同 Web 端 0.8 倍、最多 3 次重试）。
      for (int attempt = 0; attempt <= kFeedbackCaptureRetryLimit; attempt++) {
        // 每个异步步骤（toImage / 编码）后校验会话，取消即中止重试。
        if (!mounted || seq != _captureSeq) return null;
        ui.Image? source;
        ui.Picture? picture;
        ui.Image? composited;
        try {
          source = await boundary.toImage(pixelRatio: scale);
          // 遮挡几何映射到实际输出像素：向外取整、外扩边缘、裁定到图片范围。
          final List<Rect> pixelRects = regions
              .map((r) => _maskRectInPixels(
                  r.rect, scale, source!.width, source.height))
              .toList(growable: false);
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
          }
          final ui.Image finalImage = composited ?? source;
          final ByteData? byteData =
              await finalImage.toByteData(format: ui.ImageByteFormat.png);
          // 编码是异步步骤：完成后再次校验会话，过期结果直接丢弃。
          if (!mounted || seq != _captureSeq) return null;
          if (byteData != null) {
            final int byteLength = byteData.lengthInBytes;
            if (byteLength <= kFeedbackCaptureMaxBytes) {
              final Uint8List bytes = byteData.buffer
                  .asUint8List(byteData.offsetInBytes, byteLength);
              // 元数据区分逻辑视口尺寸与输出像素尺寸。
              final FeedbackCaptureInfo info = FeedbackCaptureInfo(
                viewportWidth: captureInfo.viewportWidth,
                viewportHeight: captureInfo.viewportHeight,
                pixelWidth: finalImage.width,
                pixelHeight: finalImage.height,
                capturedAt: captureInfo.capturedAt,
                releasePoint: captureInfo.releasePoint,
              );
              return _CaptureResult(bytes, info);
            }
            // 仍超限且还有重试机会：继续缩小重编码。
          }
        } finally {
          // 成功、失败、取消路径都释放全部临时资源。
          picture?.dispose();
          composited?.dispose();
          source?.dispose();
        }
        scale *= kFeedbackCaptureRetryScaleStep;
      }
      // 重试耗尽仍超限：本次截图失败（不返回超大图——服务端必回 413，
      // 静默降级只会把失败推迟到网络层）。保留旧草稿旧截图，可重试或
      // 继续文字反馈。
      debugPrint('Feedback screenshot capture failed: '
          'PNG 超出 $kFeedbackCaptureMaxBytes 字节且重试已用尽');
      return null;
    } on _CaptureGeometryException catch (e) {
      // 已注册且可能可见的遮挡区域计算失败：中止截图（不生成无遮挡图）。
      debugPrint('Feedback screenshot capture aborted: $e');
    } catch (e) {
      debugPrint('Feedback screenshot capture error: $e');
    }
    return null;
  }

  /// 统一草稿守卫：面板已持有草稿文本或截图时，任何呼出入口都不得重新截图
  /// ——否则新图会覆盖用户正在编辑的内容。
  ///
  /// 面板只在首次呼出（`_everOpened`）后挂载；未挂载（null）即无草稿可言，
  /// 照常捕获。`hasDraft` 按去空白后的正文判定。
  bool _panelHasDraftContent() {
    final FeedbackPanelState? panel = _panelKey.currentState;
    return panel != null && (panel.hasDraft || panel.hasScreenshot);
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
        panel.setScreenshot(result.bytes, result.info, captureSeq: seq);
      }
      // 最后聚焦输入框。
      panel.requestInputFocus();
    });
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
      _panelKey.currentState
          ?.setScreenshot(result.bytes, result.info, captureSeq: seq);
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
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final double height = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : MediaQuery.of(context).size.height;
        final bool wide = width >= kFeedbackWideBreakpoint;
        final double panelWidth = wide
            ? (kFeedbackPanelWidth < width ? kFeedbackPanelWidth : width)
            : width;
        final bool isLeft = config.side == FeedbackSide.left;

        final double bottom =
            config.position?.dy ?? _parseBottom(config.launcherBottom, height);
        final double? left = isLeft ? (config.position?.dx ?? 20.0) : null;
        final double? right = isLeft ? null : (config.position?.dx ?? 20.0);

        // 提供本实例私有的遮挡作用域：子树内的 FeedbackCaptureMask
        // 注册到最近的作用域（嵌套组件实例各归其主）。
        return FeedbackCaptureScopeWidget(
          scope: _captureScope,
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
                top: 0,
                bottom: 0,
                width: panelWidth,
                left: isLeft ? 0 : null,
                right: isLeft ? null : 0,
                child: !_everOpened
                    ? const SizedBox.shrink()
                    : Visibility(
                        visible: open && !_temporarilyHideForCapture,
                        maintainState: true,
                        child: _buildPanel(config),
                      ),
              ),
              if (!open && config.showLauncher)
                Positioned(
                  bottom: bottom,
                  left: left,
                  right: right,
                  child: config.launcherMode == FeedbackLauncherMode.orb
                      ? _buildOrb(context, config)
                      : _buildFab(context, config),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildFab(BuildContext context, FeedbackConfig config) {
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

  Widget _buildOrb(BuildContext context, FeedbackConfig config) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      button: true,
      label: '灵感球',
      child: GestureDetector(
        key: const Key('feedback-orb'),
        behavior: HitTestBehavior.opaque,
        onPanStart: (DragStartDetails details) {
          _lastGlobalPosition = details.globalPosition;
          _isDragging = false;
        },
        onPanUpdate: (DragUpdateDetails details) {
          _lastGlobalPosition = details.globalPosition;
          setState(() {
            _dragOffset += details.delta;
            if (_dragOffset.distance > 8.0) {
              _isDragging = true;
            }
          });
        },
        onPanEnd: (DragEndDetails details) {
          final bool dragged = _isDragging;
          final Offset releaseGlobal = _lastGlobalPosition;
          setState(() {
            _dragOffset = Offset.zero;
            _isDragging = false;
          });
          if (dragged) {
            final Size screenSize = MediaQuery.of(context).size;
            final double rx = screenSize.width > 0
                ? (releaseGlobal.dx / screenSize.width).clamp(0.0, 1.0)
                : 0.5;
            final double ry = screenSize.height > 0
                ? (releaseGlobal.dy / screenSize.height).clamp(0.0, 1.0)
                : 0.5;
            _captureAndOpen(releasePoint: Offset(rx, ry));
          } else {
            _handleLauncherTap();
          }
        },
        onPanCancel: () {
          setState(() {
            _dragOffset = Offset.zero;
            _isDragging = false;
          });
        },
        onTap: () {
          if (!_isDragging) {
            _handleLauncherTap();
          }
        },
        child: Transform.translate(
          offset: _dragOffset,
          child: Container(
            width: 48,
            height: 48,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: Color(0x24000000),
                  blurRadius: 12,
                  spreadRadius: 0,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            child: ClipOval(
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 16, sigmaY: 16),
                child: Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: isDark
                        ? const Color(0x802C2C2E)
                        : const Color(0x99FFFFFF),
                    border: Border.all(
                      color: isDark
                          ? const Color(0x33FFFFFF)
                          : const Color(0x26000000),
                      width: 0.8,
                    ),
                  ),
                  child: Center(
                    child: Icon(
                      Icons.auto_awesome,
                      size: 20,
                      color: isDark
                          ? const Color(0xFFF2F2F7)
                          : const Color(0xFF1D1D1F),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPanel(FeedbackConfig config) {
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
          onRequestClose: _close,
          onRetakeScreenshot: _retakeScreenshot,
          httpClient: widget.httpClient,
          tokenStore: widget.tokenStore,
        ),
      ),
    );
  }
}
