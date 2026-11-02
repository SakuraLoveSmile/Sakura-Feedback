import 'dart:math' as math;
import 'dart:ui' as ui show Image, FragmentShader;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'orb.dart';
import 'orb_liquid.dart';

import 'api_client.dart' show FeedbackCaptureRegion;

/// 选区最小边长（逻辑像素）：拖动 / 缩放 / 重新框选都不得小于此值。
const double kCaptureSelectionMinSize = 48;

/// 初始选区边长（逻辑像素）；与手动调整的最小边长分开。
const double kCaptureSelectionInitialSize = 144;

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

/// 初始选区为144×144，以可见球心（无球快照时为落点或视口中央）为中心。
/// 靠边整体移回可用区域；视口或安全区不足144时按可用宽高收缩。
Rect initialCaptureSelection({
  required Size viewport,
  required Offset center,
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final Rect raw = Rect.fromCenter(
      center: center,
      width: kCaptureSelectionInitialSize,
      height: kCaptureSelectionInitialSize);
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

/// 冻结画面（已遮挡位图 + 捕获元数据）上的局部选区覆盖层：
/// 展示冻结位图、选区（拖动移动 / 四角缩放 / 背景重新框选）与
/// 「使用此区域 / 截取整个窗口 / 取消」工具栏。
///
/// 本覆盖层位于截图边界之外，任何选区边框、遮罩与按钮都**不入图**——
/// 确认时只对冻结位图按选区裁剪。
class CaptureSelectionOverlay extends StatefulWidget {
  const CaptureSelectionOverlay(
      {super.key,
      required this.image,
      required this.viewport,
      required this.releasePoint,
      required this.onUseRegion,
      required this.onCaptureWhole,
      required this.onCancel,
      this.busy = false,
      this.error,
      this.orbCenter,
      this.orbShader,
      this.scale = 1,
      this.direction = const Offset(1, 0),
      this.deform = 0,
      this.wobble = 0,
      this.safeInsets = EdgeInsets.zero,
      this.orbRadius = 52});
  final ui.Image image;
  final Size viewport;
  final Offset? releasePoint;
  final ValueChanged<Rect> onUseRegion;
  final VoidCallback onCaptureWhole;
  final VoidCallback onCancel;
  final bool busy;
  final String? error;
  final Offset? orbCenter;
  final ui.FragmentShader? orbShader;
  final double scale;
  final Offset direction;
  final double deform;
  final double wobble;

  /// 系统安全区与实际捕获边界相交后换算的本地边距，不是整个view的padding。
  final EdgeInsets safeInsets;
  final double orbRadius;

  @override
  State<CaptureSelectionOverlay> createState() =>
      CaptureSelectionOverlayState();
}

class CaptureSelectionOverlayState extends State<CaptureSelectionOverlay>
    with SingleTickerProviderStateMixin {
  late Rect _selection;
  Rect? _framing;
  Offset? _frameStart;
  final FocusNode _frameFocus = FocusNode(debugLabel: 'feedback-capture-frame');
  late final AnimationController _entrance = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 550));
  bool _started = false;
  Rect get selection => _selection;
  EdgeInsets get _safeInsets => widget.safeInsets;
  bool get _reduceMotion => MediaQuery.disableAnimationsOf(context);
  bool get _coarse => switch (Theme.of(context).platform) {
        TargetPlatform.android ||
        TargetPlatform.iOS ||
        TargetPlatform.fuchsia =>
          true,
        _ => false,
      };
  bool get _editable =>
      !widget.busy && (_reduceMotion || _entrance.value >= 400 / 550);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _frameFocus.requestFocus();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _selection = initialCaptureSelection(
          viewport: widget.viewport,
          safeInsets: _safeInsets,
          // orbCenter已是捕获boundary本地坐标；releasePoint仍保留真实指针落点。
          center: widget.orbCenter ??
              Offset((widget.releasePoint?.dx ?? .5) * widget.viewport.width,
                  (widget.releasePoint?.dy ?? .5) * widget.viewport.height));
    }
    if (_reduceMotion) {
      _entrance.value = 1;
    } else if (!_started) {
      _entrance.forward();
    }
    _started = true;
  }

  @override
  void dispose() {
    _entrance.dispose();
    _frameFocus.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final LogicalKeyboardKey key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      widget.onCancel();
      return KeyEventResult.handled;
    }
    if (!_editable) return KeyEventResult.ignored;
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      widget.onUseRegion(_selection);
      return KeyEventResult.handled;
    }
    final Offset? delta = <LogicalKeyboardKey, Offset>{
      LogicalKeyboardKey.arrowLeft: const Offset(-6, 0),
      LogicalKeyboardKey.arrowRight: const Offset(6, 0),
      LogicalKeyboardKey.arrowUp: const Offset(0, -6),
      LogicalKeyboardKey.arrowDown: const Offset(0, 6),
    }[key];
    if (delta == null) return KeyEventResult.ignored;
    setState(() {
      _selection = HardwareKeyboard.instance.isShiftPressed
          ? resizeCaptureSelection(_selection, CaptureHandleAnchor.bottomRight,
              delta, widget.viewport, safeInsets: _safeInsets)
          : moveCaptureSelection(_selection, delta, widget.viewport,
              safeInsets: _safeInsets);
    });
    return KeyEventResult.handled;
  }

  Rect _controlsRect(double width, double height, double hit, Rect close) {
    final Rect safe = captureSelectionArea(widget.viewport, _safeInsets);
    final double minLeft = safe.left + math.min(16, safe.width / 2);
    final double minTop = safe.top + math.min(16, safe.height / 2);
    final double maxLeft = math.max(minLeft, safe.right - width - 16);
    final double maxTop = math.max(minTop, safe.bottom - height - 16);
    final double centered =
        (_selection.center.dx - width / 2).clamp(minLeft, maxLeft);
    final double gap = hit / 2 + 12;
    final List<double> xs = <double>[
      centered,
      minLeft,
      maxLeft,
      _selection.left - gap - width,
      _selection.right + gap
    ];
    final List<double> ys = <double>[
      _selection.bottom + gap,
      _selection.top - gap - height,
      minTop,
      maxTop
    ];
    for (final double y in ys) {
      if (y < minTop || y > maxTop) continue;
      for (final double x in xs) {
        if (x < minLeft || x > maxLeft) continue;
        final Rect rect = Rect.fromLTWH(x, y, width, height);
        if (!rect.overlaps(_selection.inflate(hit / 2 + 4)) &&
            !rect.overlaps(close)) {
          return rect;
        }
      }
    }
    // On narrow embedded hosts the complete card may not fit above or below
    // the frame. Use an actually empty rectangle and scroll the card there;
    // never put controls over the selection or its corner hit targets.
    final Rect bounds = Rect.fromLTRB(minLeft, minTop,
        math.max(minLeft, safe.right - 16), math.max(minTop, safe.bottom - 16));
    List<Rect> spaces = <Rect>[bounds];
    for (final Rect obstacle in <Rect>[
      _selection.inflate(hit / 2 + 4),
      close
    ]) {
      final List<Rect> next = <Rect>[];
      for (final Rect space in spaces) {
        if (!space.overlaps(obstacle)) {
          next.add(space);
          continue;
        }
        final Rect cut = space.intersect(obstacle);
        next.addAll(<Rect>[
          Rect.fromLTRB(space.left, space.top, space.right, cut.top),
          Rect.fromLTRB(space.left, cut.bottom, space.right, space.bottom),
          Rect.fromLTRB(space.left, space.top, cut.left, space.bottom),
          Rect.fromLTRB(cut.right, space.top, space.right, space.bottom),
        ].where((r) => r.width > 0 && r.height > 0));
      }
      spaces = next;
    }
    spaces.sort((a, b) {
      double score(Rect r) =>
          math.min(width, r.width) *
          math.min(height, r.height) *
          (r.width >= math.min(120, width) && r.height >= 44 ? 10 : 1);
      return score(b).compareTo(score(a));
    });
    if (spaces.isNotEmpty &&
        spaces.first.width >= math.min(120, width) &&
        spaces.first.height >= math.min(44, height)) {
      final Rect space = spaces.first;
      final double w = math.min(width, space.width),
          h = math.min(height, space.height);
      return Rect.fromLTWH(
          centered.clamp(space.left, space.right - w), space.top, w, h);
    }
    // A frame spanning the viewport leaves no external room. Its interior is
    // usable, but the close button and all four actual corner targets are not.
    final List<Rect> targets = <Rect>[
      close,
      for (final Offset point in <Offset>[
        _selection.topLeft,
        _selection.topRight,
        _selection.bottomLeft,
        _selection.bottomRight
      ])
        Rect.fromCenter(center: point, width: hit, height: hit)
    ];
    final List<double> internalY = <double>[
      (_selection.center.dy - height / 2).clamp(minTop, maxTop),
      minTop,
      maxTop,
      for (final Rect target in targets) ...<double>[
        target.bottom,
        target.top - height
      ]
    ];
    Rect? leastOverlap;
    double overlap = double.infinity;
    for (final double y in internalY) {
      for (final double x in xs) {
        final Rect candidate = Rect.fromLTWH(
            x.clamp(minLeft, maxLeft), y.clamp(minTop, maxTop), width, height);
        double area = 0;
        for (final Rect target in targets) {
          if (candidate.overlaps(target)) {
            final Rect intersection = candidate.intersect(target);
            area += intersection.width * intersection.height;
          }
        }
        if (area == 0) return candidate;
        if (area < overlap) {
          overlap = area;
          leastOverlap = candidate;
        }
      }
    }
    if (leastOverlap != null) return leastOverlap;
    if (spaces.isEmpty) return Rect.fromLTWH(minLeft, minTop, width, height);
    final Rect space = spaces.first;
    final double w = math.min(width, space.width),
        h = math.min(height, space.height);
    return Rect.fromLTWH(
        centered.clamp(space.left, space.right - w), space.top, w, h);
  }

  Widget _buildTools(bool stacked) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final ButtonStyle primaryStyle = FilledButton.styleFrom(
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        minimumSize: const Size(0, 44),
        fixedSize: const Size.fromHeight(44),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        backgroundColor: const Color(0xFF0071E3),
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)));
    final Widget primary = FilledButton(
        key: const Key('feedback-capture-use-region'),
        onPressed: widget.busy ? null : () => widget.onUseRegion(_selection),
        style: primaryStyle,
        child: Text(widget.busy ? '正在准备…' : '使用此区域',
            maxLines: 1, overflow: TextOverflow.ellipsis));
    final Widget whole = TextButton(
        key: const Key('feedback-capture-whole-window'),
        onPressed: widget.busy ? null : widget.onCaptureWhole,
        style: TextButton.styleFrom(
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            minimumSize: const Size(0, 44),
            fixedSize: const Size.fromHeight(44),
            foregroundColor: scheme.onSurfaceVariant,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10))),
        child:
            const Text('整个窗口', maxLines: 1, overflow: TextOverflow.ellipsis));
    return Material(
        key: const Key('feedback-capture-toolbar'),
        color: scheme.surface,
        elevation: 2,
        shadowColor: Colors.black.withValues(alpha: .15),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: scheme.outlineVariant)),
        child: Padding(
            padding: const EdgeInsets.all(8),
            child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (stacked) ...<Widget>[
                    whole,
                    const SizedBox(height: 8),
                    primary
                  ] else
                    Row(children: <Widget>[
                      Expanded(child: whole),
                      const SizedBox(width: 8),
                      Expanded(child: primary)
                    ]),
                  if (widget.error != null)
                    Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(widget.error!,
                            key: const Key('feedback-capture-error'),
                            style:
                                TextStyle(color: scheme.error, fontSize: 12))),
                ])));
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
      animation: _entrance,
      builder: (BuildContext context, Widget? child) {
        final double ms = _reduceMotion ? 550 : _entrance.value * 550;
        final double shape = orbSmoothstep(0, 400, ms);
        // The release begins at the captured visible shape. Its short rebound
        // uses the first preview's wobble while that real orb fades out. A wake
        // gesture has no dragged-orb energy to replay.
        final double wobble = widget.wobble +
            (widget.orbCenter != null && !_reduceMotion
                ? orbReleaseWobble(ms / 1000)
                : 0);
        final Rect initial = Rect.fromCenter(
            center: widget.orbCenter ?? _selection.center,
            width: widget.orbRadius * 2,
            height: widget.orbRadius * 2);
        final Rect rect = _framing ?? Rect.lerp(initial, _selection, shape)!;
        final double hit = _coarse ? 44 : 30;
        final Rect safe = captureSelectionArea(widget.viewport, _safeInsets);
        final double width = math.min(320, math.max(0, safe.width - 32));
        final double textScale =
            MediaQuery.textScalerOf(context).scale(12) / 12;
        final bool stacked = width < 280 * math.max(1, textScale);
        final double totalHeight = math.min(
            math.max(0, safe.height - 32),
            16 +
                (stacked ? 96 : 44) +
                (widget.error == null ? 0 : 44 * textScale));
        final Rect close = Rect.fromLTWH(
            math.max(0, widget.viewport.width - 52),
            (8 + _safeInsets.top)
                .clamp(0, math.max(0, widget.viewport.height - 44)),
            44,
            44);
        final Rect tools = _controlsRect(width, totalHeight, hit, close);
        final double toolbarOpacity = orbSmoothstep(350, 550, ms);
        return Semantics(
            container: true,
            label: '局部截图选区，可拖动调整，回车确认，Esc 取消',
            child: FocusScope(
                child: Focus(
                    focusNode: _frameFocus,
                    onKeyEvent: _onKey,
                    child: Stack(fit: StackFit.expand, children: <Widget>[
                      RawImage(image: widget.image, fit: BoxFit.fill),
                      GestureDetector(
                        key: const Key('feedback-capture-reframe'),
                        behavior: HitTestBehavior.opaque,
                        onPanStart: !_editable
                            ? null
                            : (DragStartDetails d) => setState(() {
                                  _frameStart = d.localPosition;
                                  _framing = Rect.fromPoints(
                                      d.localPosition, d.localPosition);
                                }),
                        onPanUpdate: !_editable
                            ? null
                            : (DragUpdateDetails d) => setState(() {
                                  _framing = Rect.fromPoints(
                                      _frameStart!, d.localPosition);
                                }),
                        onPanEnd: !_editable
                            ? null
                            : (_) => setState(() {
                                  if (_framing != null) {
                                    _selection = frameCaptureSelection(
                                        _framing!.topLeft,
                                        _framing!.bottomRight,
                                        widget.viewport,
                                        safeInsets: _safeInsets);
                                  }
                                  _framing = null;
                                }),
                        onPanCancel: () => setState(() => _framing = null),
                        child: CustomPaint(
                            painter: _SelectionOverlayPainter(
                                selection: rect,
                                radius: widget.orbRadius +
                                    (12 - widget.orbRadius) * shape,
                                dim: .26 * orbSmoothstep(0, 350, ms),
                                opacity: orbSmoothstep(50, 300, ms))),
                      ),
                      if (ms < 260)
                        Positioned(
                            left: initial.center.dx - widget.orbRadius * 1.6,
                            top: initial.center.dy - widget.orbRadius * 1.6,
                            width: widget.orbRadius * 3.2,
                            height: widget.orbRadius * 3.2,
                            child: IgnorePointer(
                                child: Opacity(
                                    opacity: 1 - orbSmoothstep(0, 260, ms),
                                    child: CustomPaint(
                                        painter: widget.orbShader == null
                                            ? OrbLiquidOutlinePainter(
                                                radius: widget.orbRadius,
                                                direction: widget.direction,
                                                deform: widget.deform,
                                                wobble: wobble)
                                            : OrbLiquidLensPainter(
                                                image: widget.image,
                                                shader: widget.orbShader!,
                                                offset: initial.center -
                                                    Offset(
                                                        widget.orbRadius * 1.6,
                                                        widget.orbRadius * 1.6),
                                                scale: widget.scale,
                                                center: initial.center,
                                                radius: widget.orbRadius,
                                                direction: widget.direction,
                                                deform: widget.deform,
                                                wobble: wobble,
                                                dark: Theme.of(context)
                                                        .brightness ==
                                                    Brightness.dark,
                                                opacity: 1))))),
                      Positioned.fromRect(
                          rect: rect,
                          child: GestureDetector(
                              key: const Key('feedback-capture-selection'),
                              behavior: HitTestBehavior.opaque,
                              onPanUpdate: !_editable
                                  ? null
                                  : (DragUpdateDetails d) => setState(() {
                                        _selection = moveCaptureSelection(
                                            _selection,
                                            d.delta,
                                            widget.viewport,
                                            safeInsets: _safeInsets);
                                      }),
                              child: const SizedBox.expand())),
                      if (_framing == null && _editable)
                        for (final CaptureHandleAnchor anchor
                            in const <CaptureHandleAnchor>[
                          CaptureHandleAnchor.topLeft,
                          CaptureHandleAnchor.topRight,
                          CaptureHandleAnchor.bottomLeft,
                          CaptureHandleAnchor.bottomRight
                        ])
                          _buildHandle(anchor, hit),
                      Positioned.fromRect(
                          rect: tools,
                          child: IgnorePointer(
                              ignoring: !_editable || toolbarOpacity == 0,
                              child: Opacity(
                                  opacity: toolbarOpacity,
                                  child: SingleChildScrollView(
                                      key: const Key('feedback-capture-tools'),
                                      child: _buildTools(stacked ||
                                          tools.width <
                                              280 * math.max(1, textScale)))))),
                      Positioned.fromRect(
                          rect: close,
                          child: Opacity(
                              opacity: orbSmoothstep(120, 400, ms),
                              child: SizedBox(
                                  width: 44,
                                  height: 44,
                                  child: Material(
                                      color:
                                          Theme.of(context).colorScheme.surface,
                                      shape: const CircleBorder(),
                                      child: IconButton(
                                          key: const Key(
                                              'feedback-capture-cancel'),
                                          tooltip: '取消截图选区',
                                          onPressed: widget.onCancel,
                                          icon: Icon(Icons.close,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurface)))))),
                    ]))));
      });

  Widget _buildHandle(CaptureHandleAnchor anchor, double hit) {
    final double x = anchor.dx < 0 ? _selection.left : _selection.right;
    final double y = anchor.dy < 0 ? _selection.top : _selection.bottom;
    return Positioned(
        left: x - hit / 2,
        top: y - hit / 2,
        width: hit,
        height: hit,
        child: Semantics(
            label:
                '调整选区${anchor.dy < 0 ? '上' : '下'}${anchor.dx < 0 ? '左' : '右'}角',
            child: GestureDetector(
                key: Key(
                    'feedback-capture-handle-${anchor.dx + 1}-${anchor.dy + 1}'),
                behavior: HitTestBehavior.opaque,
                onPanUpdate: (DragUpdateDetails d) => setState(() {
                      _selection = resizeCaptureSelection(
                          _selection, anchor, d.delta, widget.viewport,
                          safeInsets: _safeInsets);
                    }),
                child: Center(
                    child: Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                            border: Border(
                                top: anchor.dy < 0
                                    ? const BorderSide(
                                        color: Colors.white, width: 2)
                                    : BorderSide.none,
                                bottom: anchor.dy > 0
                                    ? const BorderSide(
                                        color: Colors.white, width: 2)
                                    : BorderSide.none,
                                left: anchor.dx < 0
                                    ? const BorderSide(
                                        color: Colors.white, width: 2)
                                    : BorderSide.none,
                                right: anchor.dx > 0
                                    ? const BorderSide(
                                        color: Colors.white, width: 2)
                                    : BorderSide.none)))))));
  }
}

class _SelectionOverlayPainter extends CustomPainter {
  const _SelectionOverlayPainter(
      {required this.selection,
      required this.radius,
      required this.dim,
      required this.opacity});
  final Rect selection;
  final double radius;
  final double dim;
  final double opacity;
  @override
  void paint(Canvas canvas, Size size) {
    final RRect shape =
        RRect.fromRectAndRadius(selection, Radius.circular(radius));
    canvas.drawPath(
        Path.combine(PathOperation.difference,
            Path()..addRect(Offset.zero & size), Path()..addRRect(shape)),
        Paint()..color = const Color(0xFF635D92).withValues(alpha: dim));
    canvas.drawRRect(
        shape,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1
          ..color = Colors.white.withValues(alpha: .44 * opacity));
  }

  @override
  bool shouldRepaint(_SelectionOverlayPainter old) => true;
}
