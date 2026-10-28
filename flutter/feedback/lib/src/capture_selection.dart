import 'dart:math' as math;
import 'dart:ui' as ui show Image;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;

import 'api_client.dart' show FeedbackCaptureRegion;

/// 选区最小边长（逻辑像素）：拖动 / 缩放 / 重新框选都不得小于此值。
const double kCaptureSelectionMinSize = 48;

/// 初始选区宽度上限（dp）。
const double kCaptureSelectionMaxWidth = 400;

/// 初始选区高度上限（dp）。
const double kCaptureSelectionMaxHeight = 260;

/// 动效时长（T2 规格：160–220ms）。
const Duration kCaptureSelectionMotion = Duration(milliseconds: 180);

/// 八个缩放控制点锚点（相对选区：-1 左/上、0 中、1 右/下）。
@immutable
class CaptureHandleAnchor {
  /// 构造锚点（[dx]/[dy] ∈ {-1, 0, 1}）。
  const CaptureHandleAnchor(this.dx, this.dy);

  /// 水平锚：-1 左边缘、0 垂直居中、1 右边缘。
  final int dx;

  /// 垂直锚：-1 上边缘、0 水平居中、1 下边缘。
  final int dy;

  /// 左上。
  static const CaptureHandleAnchor topLeft = CaptureHandleAnchor(-1, -1);

  /// 上中。
  static const CaptureHandleAnchor top = CaptureHandleAnchor(0, -1);

  /// 右上。
  static const CaptureHandleAnchor topRight = CaptureHandleAnchor(1, -1);

  /// 左中。
  static const CaptureHandleAnchor left = CaptureHandleAnchor(-1, 0);

  /// 右中。
  static const CaptureHandleAnchor right = CaptureHandleAnchor(1, 0);

  /// 左下。
  static const CaptureHandleAnchor bottomLeft = CaptureHandleAnchor(-1, 1);

  /// 下中。
  static const CaptureHandleAnchor bottom = CaptureHandleAnchor(0, 1);

  /// 右下。
  static const CaptureHandleAnchor bottomRight = CaptureHandleAnchor(1, 1);

  /// 全部八个控制点（按左→右、上→下顺序）。
  static const List<CaptureHandleAnchor> all = <CaptureHandleAnchor>[
    topLeft,
    top,
    topRight,
    left,
    right,
    bottomLeft,
    bottom,
    bottomRight,
  ];
}

/// 可用区域（视口扣除安全区）；宽高不足 0 时钳到 0。
Rect captureSelectionArea(Size viewport, EdgeInsets safeInsets) {
  final double left = safeInsets.left.clamp(0.0, viewport.width);
  final double top = safeInsets.top.clamp(0.0, viewport.height);
  final double right =
      (viewport.width - safeInsets.right).clamp(left, viewport.width);
  final double bottom =
      (viewport.height - safeInsets.bottom).clamp(top, viewport.height);
  return Rect.fromLTRB(left, top, right, bottom);
}

/// 把选区整体移回可用区域（含安全区），并保证最小 48×48：
/// 尺寸超可用区时收缩，位置越界时整体平移（不裁形）。
Rect clampCaptureSelection(
  Rect rect,
  Size viewport, {
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final Rect area = captureSelectionArea(viewport, safeInsets);
  final double minWidth = math.min(kCaptureSelectionMinSize, area.width);
  final double minHeight = math.min(kCaptureSelectionMinSize, area.height);
  double width = rect.width.isFinite && rect.width > 0
      ? rect.width.clamp(minWidth, area.width)
      : minWidth;
  double height = rect.height.isFinite && rect.height > 0
      ? rect.height.clamp(minHeight, area.height)
      : minHeight;
  final double left = rect.left.isFinite
      ? rect.left.clamp(area.left, math.max(area.left, area.right - width))
      : area.left;
  final double top = rect.top.isFinite
      ? rect.top.clamp(area.top, math.max(area.top, area.bottom - height))
      : area.top;
  return Rect.fromLTWH(left, top, width, height);
}

/// 初始选区：宽 `min(400dp, 屏宽×80%)`、高 `min(260dp, 屏高×40%)`，
/// 中心为松手位置；靠边时整体移回可见区域（含安全区），最小 48×48。
Rect initialCaptureSelection({
  required Size viewport,
  required Offset center,
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final double width = math.max(
    kCaptureSelectionMinSize,
    math.min(kCaptureSelectionMaxWidth, viewport.width * 0.8),
  );
  final double height = math.max(
    kCaptureSelectionMinSize,
    math.min(kCaptureSelectionMaxHeight, viewport.height * 0.4),
  );
  final Rect raw = Rect.fromCenter(center: center, width: width, height: height);
  return clampCaptureSelection(raw, viewport, safeInsets: safeInsets);
}

/// 移动选区（整体平移后移回可用区域）。
Rect moveCaptureSelection(
  Rect selection,
  Offset delta,
  Size viewport, {
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  return clampCaptureSelection(
    selection.shift(delta),
    viewport,
    safeInsets: safeInsets,
  );
}

/// 按锚点缩放选区：对侧边缘固定，最小 48×48，越界时钳回可用区域。
Rect resizeCaptureSelection(
  Rect selection,
  CaptureHandleAnchor anchor,
  Offset delta,
  Size viewport, {
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final Rect area = captureSelectionArea(viewport, safeInsets);
  final double minWidth = math.min(kCaptureSelectionMinSize, area.width);
  final double minHeight = math.min(kCaptureSelectionMinSize, area.height);
  double left = selection.left.clamp(area.left, area.right);
  double top = selection.top.clamp(area.top, area.bottom);
  double right = selection.right.clamp(left, area.right);
  double bottom = selection.bottom.clamp(top, area.bottom);
  // 先保证既有选区满足最小尺寸（防御：布局抖动传入退化矩形）。
  if (right - left < minWidth) right = math.min(area.right, left + minWidth);
  if (bottom - top < minHeight) bottom = math.min(area.bottom, top + minHeight);
  if (right - left < minWidth) left = math.max(area.left, right - minWidth);
  if (bottom - top < minHeight) top = math.max(area.top, bottom - minHeight);
  // 拖动边缘（对侧固定），钳到可用区并保持最小尺寸。
  if (anchor.dx < 0) {
    left = (left + delta.dx).clamp(area.left, right - minWidth);
  } else if (anchor.dx > 0) {
    right = (right + delta.dx).clamp(left + minWidth, area.right);
  }
  if (anchor.dy < 0) {
    top = (top + delta.dy).clamp(area.top, bottom - minHeight);
  } else if (anchor.dy > 0) {
    bottom = (bottom + delta.dy).clamp(top + minHeight, area.bottom);
  }
  return Rect.fromLTRB(left, top, right, bottom);
}

/// 由两点重新框选（拖动方向任意），保证最小尺寸后移回可用区域。
Rect frameCaptureSelection(
  Offset start,
  Offset end,
  Size viewport, {
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final Rect area = captureSelectionArea(viewport, safeInsets);
  final double minWidth = math.min(kCaptureSelectionMinSize, area.width);
  final double minHeight = math.min(kCaptureSelectionMinSize, area.height);
  double left = math.min(start.dx, end.dx);
  double right = math.max(start.dx, end.dx);
  double top = math.min(start.dy, end.dy);
  double bottom = math.max(start.dy, end.dy);
  if (right - left < minWidth) {
    // 极小拖动：以起点为左上扩展出最小选区（随后整体移回可用区）。
    left = start.dx;
    right = left + minWidth;
  }
  if (bottom - top < minHeight) {
    top = start.dy;
    bottom = top + minHeight;
  }
  return clampCaptureSelection(
    Rect.fromLTRB(left, top, right, bottom),
    viewport,
    safeInsets: safeInsets,
  );
}

/// 选区换算为 `capture.region`（0..1 归一化，相对原始捕获视口）。
FeedbackCaptureRegion normalizeCaptureRegion(Rect selection, Size viewport) {
  return FeedbackCaptureRegion.fromRect(selection, viewport);
}

/// 冻结画面（已遮挡位图 + 捕获元数据）上的局部选区覆盖层（T1）：
/// 展示冻结位图、选区（拖动移动 / 八点缩放 / 背景重新框选）与
/// 「使用此区域 / 截取整个窗口 / 取消」工具栏。
///
/// 本覆盖层位于截图边界之外，任何选区边框、遮罩与按钮都**不入图**——
/// 确认时只对冻结位图按选区裁剪。
class CaptureSelectionOverlay extends StatefulWidget {
  /// 构造覆盖层。[image] 为已完成位图级遮挡的冻结位图；
  /// [viewport] 为原始捕获视口（逻辑像素）；[releasePoint] 为松手落点
  /// （0..1，相对视口，null 表示无落点时居中）。
  const CaptureSelectionOverlay({
    super.key,
    required this.image,
    required this.viewport,
    required this.releasePoint,
    required this.onUseRegion,
    required this.onCaptureWhole,
    required this.onCancel,
  });

  /// 已遮挡的冻结位图。
  final ui.Image image;

  /// 原始捕获视口（逻辑像素尺寸）。
  final Size viewport;

  /// 松手落点（0..1 相对视口）。
  final Offset? releasePoint;

  /// 使用当前选区（裁剪冻结位图）。
  final ValueChanged<Rect> onUseRegion;

  /// 截取整个窗口（整张冻结位图，region 省略）。
  final VoidCallback onCaptureWhole;

  /// 取消：丢弃冻结画面恢复 UI，不覆盖草稿、不报失败。
  final VoidCallback onCancel;

  @override
  State<CaptureSelectionOverlay> createState() => CaptureSelectionOverlayState();
}

/// 覆盖层状态（public 仅供测试读取当前选区）。
class CaptureSelectionOverlayState extends State<CaptureSelectionOverlay> {
  /// 当前选区（逻辑像素，相对覆盖层坐标系）。
  late Rect _selection;

  /// 重新框选中的实时矩形（null = 未在框选）。
  Rect? _framing;

  /// 可用区域（视口扣安全区），布局时更新。
  Size _layoutSize = Size.zero;

  /// 首次布局后按安全区钳一次（initState 时尚无 MediaQuery 安全区）。
  bool _safeAreaClamped = false;

  /// 覆盖层内的焦点落点，对齐 Web 的 `.fb-region-frame`：挂载后把焦点从
  /// 灵感球等外部节点移入覆盖层。Enter 确认 / Esc 取消由本层 Shortcuts
  /// 处理（焦点必须落在其后代上，见上方注释）。
  final FocusNode _frameFocus = FocusNode(debugLabel: 'feedback-capture-frame');

  @override
  void initState() {
    super.initState();
    _selection = clampCaptureSelection(
      Rect.fromCenter(
        center: Offset(
          (widget.releasePoint?.dx ?? 0.5) * widget.viewport.width,
          (widget.releasePoint?.dy ?? 0.5) * widget.viewport.height,
        ),
        width: math.min(kCaptureSelectionMaxWidth, widget.viewport.width * 0.8),
        height:
            math.min(kCaptureSelectionMaxHeight, widget.viewport.height * 0.4),
      ),
      widget.viewport,
    );
    // 挂载后请求：此前焦点可能在身后的灵感球上，键盘事件不得落到那里。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _frameFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    _frameFocus.dispose();
    super.dispose();
  }

  /// 当前选区（测试可见）。
  Rect get selection => _selection;

  EdgeInsets get _safeInsets => MediaQuery.maybePaddingOf(context) ??
      (MediaQuery.maybeOf(context)?.padding ?? EdgeInsets.zero);

  /// 覆盖层坐标系尺寸：优先实际布局（等于原始捕获视口），
  /// 尚未布局时退回冻结时记录的视口尺寸。
  Size get _viewport =>
      _layoutSize != Size.zero ? _layoutSize : widget.viewport;

  bool get _reduceMotion => MediaQuery.disableAnimationsOf(context);

  Duration get _motion => _reduceMotion ? Duration.zero : kCaptureSelectionMotion;

  void _setSelection(Rect next) {
    setState(() => _selection = next);
  }

  void _cancel() => widget.onCancel();

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        _layoutSize = Size(constraints.maxWidth, constraints.maxHeight);
        final EdgeInsets insets = _safeInsets;
        if (!_safeAreaClamped) {
          _safeAreaClamped = true;
          _selection = clampCaptureSelection(
            _selection,
            _viewport,
            safeInsets: insets,
          );
        }
        final Size viewport = _viewport;
        final Rect? framing = _framing;
        return Semantics(
          container: true,
          label: '局部截图选区，可拖动调整，回车确认，Esc 取消',
          // 不加外层 Focus(autofocus)：Shortcuts 自带 Focus 节点，事件沿
          // 焦点链**向上**冒泡——焦点必须落在按钮等后代上，快捷键才生效。
          child: Shortcuts(
              shortcuts: <ShortcutActivator, Intent>{
                const SingleActivator(LogicalKeyboardKey.escape):
                    const _CancelSelectionIntent(),
                // 对齐 Web regionFrame：回车确认；空格不映射，既不能落到
                // 球上重拍整窗，也不直接激活按钮。
                const SingleActivator(LogicalKeyboardKey.enter):
                    const _ConfirmSelectionIntent(),
                const SingleActivator(LogicalKeyboardKey.numpadEnter):
                    const _ConfirmSelectionIntent(),
              },
              child: Actions(
                actions: <Type, Action<Intent>>{
                  _CancelSelectionIntent:
                      CallbackAction<_CancelSelectionIntent>(
                    onInvoke: (_) {
                      _cancel();
                      return null;
                    },
                  ),
                  _ConfirmSelectionIntent:
                      CallbackAction<_ConfirmSelectionIntent>(
                    onInvoke: (_) {
                      widget.onUseRegion(_selection);
                      return null;
                    },
                  ),
                },
                child: Stack(
                  fit: StackFit.expand,
                  children: <Widget>[
                    // 焦点落点（等价 Web 的 .fb-region-frame）：无视觉、不参与
                    // 命中，仅承载键盘焦点；initState 的 post-frame 请求焦点。
                    Focus(
                      focusNode: _frameFocus,
                      includeSemantics: false,
                      child: const SizedBox.expand(),
                    ),
                    // 冻结位图（已遮挡），铺满覆盖层。
                    RawImage(image: widget.image, fit: BoxFit.fill),
                    // 选区外压暗遮罩 + 选区边框与控制点（均为覆盖层绘制，不入图）。
                    CustomPaint(
                      painter: _SelectionOverlayPainter(
                        selection: framing ?? _selection,
                        framing: framing != null,
                        reduceMotion: _reduceMotion,
                      ),
                    ),
                    // 背景拖动 = 重新框选（opaque：完全遮蔽下方的灵感球 /
                    // 面板 / 启动入口，选区流程期间不透传任何点击）。
                    GestureDetector(
                      key: const Key('feedback-capture-reframe'),
                      behavior: HitTestBehavior.opaque,
                      onPanStart: (DragStartDetails d) {
                        setState(() => _framing = Rect.fromPoints(
                            d.localPosition, d.localPosition));
                      },
                      onPanUpdate: (DragUpdateDetails d) {
                        final Rect? live = _framing;
                        if (live == null) return;
                        setState(() {
                          _framing =
                              Rect.fromPoints(live.topLeft, d.localPosition);
                        });
                      },
                      onPanEnd: (DragEndDetails d) {
                        final Rect? live = _framing;
                        if (live == null) return;
                        setState(() => _framing = null);
                        _setSelection(frameCaptureSelection(
                          live.topLeft,
                          live.bottomRight,
                          viewport,
                          safeInsets: insets,
                        ));
                      },
                      child: const SizedBox.expand(),
                    ),
                    // 选区本体：内部拖动 = 整体移动。
                    Positioned(
                      left: (framing ?? _selection).left,
                      top: (framing ?? _selection).top,
                      width: (framing ?? _selection).width,
                      height: (framing ?? _selection).height,
                      child: framing != null
                          ? const SizedBox.expand()
                          : GestureDetector(
                              key: const Key('feedback-capture-selection'),
                              behavior: HitTestBehavior.opaque,
                              onPanUpdate: (DragUpdateDetails d) {
                                _setSelection(moveCaptureSelection(
                                  _selection,
                                  d.delta,
                                  viewport,
                                  safeInsets: insets,
                                ));
                              },
                              child: const SizedBox.expand(),
                            ),
                    ),
                    // 八个缩放控制点（仅选区定型后显示）。
                    if (framing == null)
                      for (final CaptureHandleAnchor anchor
                          in CaptureHandleAnchor.all)
                        _buildHandle(anchor, viewport, insets),
                    // 底部工具栏：确认 / 整窗 / 取消（键盘可达、焦点清晰）。
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: SafeArea(
                        top: false,
                        child: AnimatedOpacity(
                          duration: _motion,
                          opacity: 1,
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                            child: Material(
                              key: const Key('feedback-capture-toolbar'),
                              color: theme.colorScheme.surfaceContainerHigh,
                              elevation: 4,
                              borderRadius: BorderRadius.circular(16),
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: <Widget>[
                                    Text(
                                      '调整选区后确认；也可以在画面上拖动重新框选',
                                      key: const Key('feedback-capture-hint'),
                                      textAlign: TextAlign.center,
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                              color: theme
                                                  .colorScheme.onSurfaceVariant),
                                    ),
                                    const SizedBox(height: 8),
                                    Row(
                                      children: <Widget>[
                                        Expanded(
                                          child: FilledButton(
                                            key: const Key(
                                                'feedback-capture-use-region'),
                                            autofocus: true,
                                            onPressed: () => widget
                                                .onUseRegion(_selection),
                                            child: const Text('使用此区域'),
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        Expanded(
                                          child: OutlinedButton(
                                            key: const Key(
                                                'feedback-capture-whole-window'),
                                            onPressed: widget.onCaptureWhole,
                                            child: const Text('截取整个窗口'),
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        SizedBox(
                                          height: 48,
                                          child: OutlinedButton(
                                            key: const Key(
                                                'feedback-capture-cancel'),
                                            onPressed: _cancel,
                                            child: const Text('取消'),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
      },
    );
  }

  Widget _buildHandle(
    CaptureHandleAnchor anchor,
    Size viewport,
    EdgeInsets insets,
  ) {
    // 视觉 12dp、命中区 32dp（≥48dp 触控由相邻区域共享满足握手要求的
    // 最小移动精度；主操作按钮均为 48dp）。
    const double visual = 12;
    const double hit = 32;
    final Rect sel = _selection;
    final double cx = anchor.dx < 0
        ? sel.left
        : anchor.dx > 0
            ? sel.right
            : sel.center.dx;
    final double cy = anchor.dy < 0
        ? sel.top
        : anchor.dy > 0
            ? sel.bottom
            : sel.center.dy;
    return Positioned(
      left: cx - hit / 2,
      top: cy - hit / 2,
      width: hit,
      height: hit,
      child: GestureDetector(
        key: Key(
            'feedback-capture-handle-${anchor.dx + 1}-${anchor.dy + 1}'),
        behavior: HitTestBehavior.opaque,
        onPanUpdate: (DragUpdateDetails d) {
          _setSelection(resizeCaptureSelection(
            _selection,
            anchor,
            d.delta,
            viewport,
            safeInsets: insets,
          ));
        },
        child: Center(
          child: Container(
            width: visual,
            height: visual,
            decoration: BoxDecoration(
              color: Colors.white,
              shape: anchor.dx == 0 || anchor.dy == 0
                  ? BoxShape.rectangle
                  : BoxShape.circle,
              border: Border.all(color: Colors.black26, width: 0.6),
              borderRadius: anchor.dx == 0 || anchor.dy == 0
                  ? BorderRadius.circular(2)
                  : null,
            ),
          ),
        ),
      ),
    );
  }
}

/// 取消选区意图（Esc）。
class _CancelSelectionIntent extends Intent {
  const _CancelSelectionIntent();
}

/// 确认选区意图（Enter）：与工具栏「使用此区域」同一动作。
class _ConfirmSelectionIntent extends Intent {
  const _ConfirmSelectionIntent();
}

/// 选区覆盖层绘制：选区外压暗遮罩 + 白色边框（覆盖层元素，不入图）。
class _SelectionOverlayPainter extends CustomPainter {
  _SelectionOverlayPainter({
    required this.selection,
    required this.framing,
    required this.reduceMotion,
  });

  final Rect selection;
  final bool framing;
  final bool reduceMotion;

  @override
  void paint(Canvas canvas, Size size) {
    // 选区外整体压暗（含安全区），突出当前选区。
    canvas.drawPath(
      Path.combine(
        PathOperation.difference,
        Path()..addRect(Offset.zero & size),
        Path()..addRect(selection),
      ),
      Paint()..color = Colors.black.withValues(alpha: 0.45),
    );
    final bool animate = !reduceMotion;
    canvas.drawRect(
      selection,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = animate ? 2.4 : 2
        ..color = framing ? const Color(0xFF0071E3) : Colors.white,
    );
    // 三分辅助线（仅覆盖层显示，绝不入图）。
    final Paint grid = Paint()
      ..strokeWidth = 0.7
      ..color = Colors.white.withValues(alpha: 0.35);
    for (int i = 1; i <= 2; i++) {
      final double dx = selection.left + selection.width * i / 3;
      final double dy = selection.top + selection.height * i / 3;
      canvas.drawLine(
          Offset(dx, selection.top), Offset(dx, selection.bottom), grid);
      canvas.drawLine(
          Offset(selection.left, dy), Offset(selection.right, dy), grid);
    }
  }

  @override
  bool shouldRepaint(_SelectionOverlayPainter oldDelegate) => true;
}
