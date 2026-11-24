import 'dart:math' as math;
import 'dart:ui' as ui
    show FragmentShader, Image, ImageByteFormat, PictureRecorder;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'orb.dart';
import 'orb_liquid.dart';
import 'beam_aurora.dart';
import 'wake_visual.dart';
import 'water_ripple.dart';

import 'api_client.dart' show FeedbackCaptureRegion;

/// 选区最小边长（逻辑像素）：拖动 / 缩放 / 重新框选都不得小于此值。
const double kCaptureSelectionMinSize = 48;

const _captureSurface = Color(0xFF242725);
const _captureRim = Color(0x38FFFFFF);

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

/// 圈选轨迹：包围盒外扩边距、最小边长、采样间距（与 Web 端同值）。
const double kLassoPad = 8;
const double kLassoMinSize = 64;
const double kLassoSampleDistance = 4;

/// 丢弃与上一点距离不足 [minDistance] 的采样点；非有限坐标直接忽略。
List<Offset> simplifyLassoPath(
  Iterable<Offset> points, {
  double minDistance = kLassoSampleDistance,
}) {
  final List<Offset> out = <Offset>[];
  for (final Offset point in points) {
    if (!point.dx.isFinite || !point.dy.isFinite) continue;
    final Offset? previous = out.isEmpty ? null : out.last;
    if (previous != null && (point - previous).distance < minDistance) {
      continue;
    }
    out.add(point);
  }
  return out;
}

/// 圈选轨迹 → 选区：包围盒四周外扩 [pad]，不足 [minSize] 时以中心撑开，
/// 最后夹回可用区域（含安全区）。无有效点时返回左上角起的最小选区。
Rect lassoBoundingRect(
  Iterable<Offset> points,
  Size viewport, {
  double pad = kLassoPad,
  double minSize = kLassoMinSize,
  EdgeInsets safeInsets = EdgeInsets.zero,
}) {
  final List<Offset> finite = points
      .where((Offset point) => point.dx.isFinite && point.dy.isFinite)
      .toList(growable: false);
  if (finite.isEmpty) {
    return clampCaptureSelection(
      Rect.fromLTWH(0, 0, minSize, minSize),
      viewport,
      safeInsets: safeInsets,
    );
  }
  double left = finite.first.dx, right = finite.first.dx;
  double top = finite.first.dy, bottom = finite.first.dy;
  for (final Offset point in finite) {
    if (point.dx < left) left = point.dx;
    if (point.dx > right) right = point.dx;
    if (point.dy < top) top = point.dy;
    if (point.dy > bottom) bottom = point.dy;
  }
  left -= pad;
  top -= pad;
  right += pad;
  bottom += pad;
  double width = right - left;
  double height = bottom - top;
  if (width < minSize) {
    final double centerX = (left + right) / 2;
    left = centerX - minSize / 2;
    width = minSize;
  }
  if (height < minSize) {
    final double centerY = (top + bottom) / 2;
    top = centerY - minSize / 2;
    height = minSize;
  }
  return clampCaptureSelection(
    Rect.fromLTWH(left, top, width, height),
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
      this.wakeOrigins = const [],
      required this.onUseRegion,
      required this.onCaptureWhole,
      required this.onCancel,
      this.busy = false,
      this.error,
      this.onRedraw,
      this.orbCenter,
      this.orbShader,
      this.edgeReflection = true,
      this.scale = 1,
      this.direction = const Offset(1, 0),
      this.deform = 0,
      this.wobble = 0,
      this.safeInsets = EdgeInsets.zero,
      this.lassoFirst = false,
      this.wakeVisual = FeedbackWakeVisual.ripple,
      this.gestureGlass = false,
      this.orbRadius = 52});
  final ui.Image image;
  final Size viewport;
  final Offset? releasePoint;
  final List<Offset> wakeOrigins;
  final ValueChanged<Rect> onUseRegion;
  final VoidCallback onCaptureWhole;
  final VoidCallback onCancel;
  final bool busy;
  final String? error;
  final VoidCallback? onRedraw;
  final Offset? orbCenter;
  final ui.FragmentShader? orbShader;
  final bool edgeReflection;
  final double scale;
  final Offset direction;
  final double deform;
  final double wobble;

  /// 系统安全区与实际捕获边界相交后换算的本地边距，不是整个view的padding。
  final EdgeInsets safeInsets;
  final double orbRadius;
  final bool gestureGlass;

  /// 光束唤醒：先播放唤醒动效/压暗，等待用户圈选后才出现方框与工具条。
  final bool lassoFirst;

  /// 唤醒动效：水波纹（默认）或波光。
  final FeedbackWakeVisual wakeVisual;

  @override
  State<CaptureSelectionOverlay> createState() =>
      CaptureSelectionOverlayState();
}

class CaptureSelectionOverlayState extends State<CaptureSelectionOverlay>
    with TickerProviderStateMixin {
  Rect? _selection;
  Rect? _morphFrom;
  final List<Offset> _lasso = <Offset>[];
  ui.FragmentShader? _waterShader;
  Rect get _sel => _selection!;
  bool get _water => widget.wakeVisual == FeedbackWakeVisual.ripple;
  late final AnimationController _beam = AnimationController(
      vsync: this,
      duration: _water ? kWaterRippleDuration : kBeamAuroraDuration);
  double get _beamMillis => _beam.value * _beam.duration!.inMilliseconds;
  bool get _armed =>
      !widget.lassoFirst ||
      _reduceMotion ||
      _beamMillis >= kBeamAuroraDuration.inMilliseconds;
  Rect? _framing;
  Offset? _frameStart;
  final FocusNode _frameFocus = FocusNode(debugLabel: 'feedback-capture-frame');
  late final AnimationController _entrance = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 550));
  bool _started = false;
  bool _guideDismissed = false;
  Rect get selection => _sel;
  EdgeInsets get _safeInsets => widget.safeInsets;

  /// 波光从按压点向外扩散；快捷键唤醒没有落点时取视口中心。
  Offset get _beamOrigin => Offset(
      (widget.releasePoint?.dx ?? .5) * widget.viewport.width,
      (widget.releasePoint?.dy ?? .5) * widget.viewport.height);
  bool get _reduceMotion => MediaQuery.disableAnimationsOf(context);
  bool get _coarse => switch (Theme.of(context).platform) {
        TargetPlatform.android ||
        TargetPlatform.iOS ||
        TargetPlatform.fuchsia =>
          true,
        _ => false,
      };
  bool get _editable =>
      !widget.busy &&
      _selection != null &&
      _armed &&
      (_reduceMotion || _entrance.value >= 400 / 550);

  @override
  void initState() {
    super.initState();
    _hintOnDark = _sampleHintBackground();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _frameFocus.requestFocus();
    });
  }

  // The host can display a light screenshot even when the system theme is dark.
  // Only sample the masked strip where the instruction will appear.
  late Future<bool?> _hintOnDark;

  Future<bool?> _sampleHintBackground() async {
    final image = widget.image;
    final viewport = widget.viewport;
    if (viewport.isEmpty) return null;
    final width = math.min(120.0, viewport.width);
    final center = Offset(
        (viewport.width + _safeInsets.left - _safeInsets.right) / 2,
        (viewport.height - _safeInsets.bottom - 20).clamp(0, viewport.height));
    final scale =
        Offset(image.width / viewport.width, image.height / viewport.height);
    final strip = Rect.fromCenter(
        center: Offset(center.dx * scale.dx, center.dy * scale.dy),
        width: width * scale.dx,
        height: 4 * scale.dy);
    final recorder = ui.PictureRecorder();
    Canvas(recorder).drawImageRect(
        image,
        strip,
        const Rect.fromLTWH(0, 0, 9, 1),
        Paint()..filterQuality = FilterQuality.low);
    final picture = recorder.endRecording();
    try {
      final sample = await picture.toImage(9, 1);
      try {
        final bytes =
            await sample.toByteData(format: ui.ImageByteFormat.rawRgba);
        if (bytes == null) return null;
        final lumas = List.generate(9, (i) {
          final offset = 4 * i;
          return .2126 * bytes.getUint8(offset) +
              .7152 * bytes.getUint8(offset + 1) +
              .0722 * bytes.getUint8(offset + 2);
        })
          ..sort();
        return lumas[4] < 128;
      } finally {
        sample.dispose();
      }
    } finally {
      picture.dispose();
    }
  }

  @override
  void didUpdateWidget(CaptureSelectionOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.image != oldWidget.image ||
        widget.viewport != oldWidget.viewport ||
        widget.safeInsets != oldWidget.safeInsets) {
      _hintOnDark = _sampleHintBackground();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      if (!widget.lassoFirst) {
        _selection = initialCaptureSelection(
            viewport: widget.viewport,
            safeInsets: _safeInsets,
            // orbCenter已是捕获boundary本地坐标；releasePoint仍保留真实指针落点。
            center: widget.orbCenter ??
                Offset((widget.releasePoint?.dx ?? .5) * widget.viewport.width,
                    (widget.releasePoint?.dy ?? .5) * widget.viewport.height));
      } else {
        if (!_reduceMotion) {
          if (_water) _prepareWater();
          _beam.forward();
        }
      }
    }
    if (_reduceMotion) {
      _guideDismissed = true;
      if (widget.lassoFirst) _beam.value = 1;
      _entrance.value = 1;
    } else if (!_started) {
      _entrance.forward();
    }
    _started = true;
  }

  Future<void> _prepareWater() async {
    final program = await waterRippleProgram;
    if (!mounted || program == null || _beam.isCompleted) return;
    setState(() => _waterShader = program.fragmentShader());
  }

  @override
  void dispose() {
    _waterShader?.dispose();
    _entrance.dispose();
    _beam.dispose();
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
    if (_selection == null) {
      if (key == LogicalKeyboardKey.enter ||
          key == LogicalKeyboardKey.numpadEnter) {
        widget.onCaptureWhole();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (!_editable) return KeyEventResult.ignored;
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      widget.onUseRegion(_sel);
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
          ? resizeCaptureSelection(
              _sel, CaptureHandleAnchor.bottomRight, delta, widget.viewport,
              safeInsets: _safeInsets)
          : moveCaptureSelection(_sel, delta, widget.viewport,
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
        (_sel.center.dx - width / 2).clamp(minLeft, maxLeft);
    final double gap = hit / 2 + 12;
    final List<double> xs = <double>[
      centered,
      minLeft,
      maxLeft,
      _sel.left - gap - width,
      _sel.right + gap
    ];
    final List<double> ys = <double>[
      _sel.bottom + gap,
      _sel.top - gap - height,
      minTop,
      maxTop
    ];
    for (final double y in ys) {
      if (y < minTop || y > maxTop) continue;
      for (final double x in xs) {
        if (x < minLeft || x > maxLeft) continue;
        final Rect rect = Rect.fromLTWH(x, y, width, height);
        if (!rect.overlaps(_sel.inflate(hit / 2 + 4)) &&
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
    for (final Rect obstacle in <Rect>[_sel.inflate(hit / 2 + 4), close]) {
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
        _sel.topLeft,
        _sel.topRight,
        _sel.bottomLeft,
        _sel.bottomRight
      ])
        Rect.fromCenter(center: point, width: hit, height: hit)
    ];
    final List<double> internalY = <double>[
      (_sel.center.dy - height / 2).clamp(minTop, maxTop),
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

  void _redraw() {
    if (widget.busy) return;
    setState(() {
      _selection = null;
      _morphFrom = null;
      _frameStart = null;
      _framing = null;
      _lasso.clear();
    });
    widget.onRedraw?.call();
    _frameFocus.requestFocus();
  }

  static const _editorButtonSurface = Color(0xC4272727);

  Widget _editorButton(
      String label, IconData icon, String key, VoidCallback action,
      {bool primary = false}) {
    return TextButton.icon(
        key: Key(key),
        onPressed: widget.busy ? null : action,
        style: TextButton.styleFrom(
            minimumSize: const Size(44, 44),
            padding: EdgeInsets.symmetric(horizontal: primary ? 18 : 10),
            foregroundColor: primary ? const Color(0xFF202020) : Colors.white,
            disabledForegroundColor: primary ? Colors.black45 : Colors.white54,
            backgroundColor: primary ? Colors.white : _editorButtonSurface,
            textStyle:
                const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        icon: Icon(icon, size: 19),
        label: Text(label));
  }

  Widget _editorEdge({required Widget child, bool top = false}) {
    return Positioned(
        left: 0,
        right: 0,
        top: top ? 0 : null,
        bottom: top ? null : 0,
        child: Padding(
            padding: EdgeInsets.fromLTRB(
                12 + _safeInsets.left,
                top ? 10 + _safeInsets.top : 0,
                12 + _safeInsets.right,
                top ? 0 : 10 + _safeInsets.bottom),
            child: child));
  }

  Widget _editorActions() {
    return Material(
        key: const Key('feedback-capture-tools'),
        type: MaterialType.transparency,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (widget.error != null)
            Material(
                color: _editorButtonSurface,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Text(widget.error!,
                        key: const Key('feedback-capture-error'),
                        style: const TextStyle(
                            color: Colors.white, fontSize: 13)))),
          LayoutBuilder(
              builder: (context, constraints) => SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: ConstrainedBox(
                      constraints:
                          BoxConstraints(minWidth: constraints.maxWidth),
                      child: Row(
                          key: const Key('feedback-capture-toolbar'),
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Row(children: [
                              _editorButton('重画', Icons.undo_rounded,
                                  'feedback-capture-redraw', _redraw),
                              const SizedBox(width: 6),
                              _editorButton(
                                  '整图',
                                  Icons.fit_screen_outlined,
                                  'feedback-capture-whole-window',
                                  widget.onCaptureWhole),
                            ]),
                            _editorButton(
                                widget.busy ? '正在准备…' : '确认',
                                Icons.check_rounded,
                                'feedback-capture-use-region',
                                () => widget.onUseRegion(_sel),
                                primary: true),
                          ])))),
        ]));
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[_entrance, _beam]),
      builder: (BuildContext context, Widget? child) {
        if (_selection == null) return _buildLassoSurface();
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
            center: widget.orbCenter ?? _sel.center,
            width: widget.orbRadius * 2,
            height: widget.orbRadius * 2);
        final Rect rect =
            _framing ?? Rect.lerp(_morphFrom ?? initial, _sel, shape)!;
        final double hit = _coarse ? 44 : 30;
        final Rect safe = captureSelectionArea(widget.viewport, _safeInsets);
        final Rect close = Rect.fromLTWH(
            math.max(0, widget.viewport.width - _safeInsets.right - 52),
            (8 + _safeInsets.top)
                .clamp(0, math.max(0, widget.viewport.height - 44)),
            44,
            44);
        final double upperGap = _sel.top - safe.top,
            lowerGap = safe.bottom - _sel.bottom;
        final double textScale =
            MediaQuery.textScalerOf(context).scale(14) / 14;
        final double actionsHeight = math.max(48, textScale * 24) +
            (widget.error == null ? 0 : 48 * math.max(1, textScale));
        final double edgeSpace = actionsHeight + 22 + hit / 2;
        final bool toolsAtTop = lowerGap < edgeSpace && upperGap >= edgeSpace;
        final Rect? floatingTools = math.max(upperGap, lowerGap) < edgeSpace
            ? _controlsRect(
                math.min(320, math.max(0, safe.width - 32)),
                math.min(actionsHeight, math.max(0, safe.height - 32)),
                hit,
                close)
            : null;
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
                                radius: !widget.lassoFirst && _morphFrom == null
                                    ? widget.orbRadius +
                                        (2 - widget.orbRadius) * shape
                                    : 2,
                                corners: shape,
                                dim:
                                    kBeamDimOpacity * orbSmoothstep(0, 350, ms),
                                opacity: orbSmoothstep(50, 300, ms))),
                      ),
                      if (ms < 260 && _morphFrom == null)
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
                                                edgeReflection: widget.edgeReflection,
                                                gestureGlass:
                                                    widget.gestureGlass,
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
                                            _sel, d.delta, widget.viewport,
                                            safeInsets: _safeInsets);
                                      }),
                              child: const SizedBox.expand())),
                      Positioned.fill(
                          child: IgnorePointer(
                              ignoring: !_editable,
                              child: Opacity(
                                  opacity: toolbarOpacity,
                                  child: Stack(children: [
                                    if (floatingTools == null)
                                      _editorEdge(
                                          top: toolsAtTop,
                                          child: _editorActions())
                                    else
                                      Positioned.fromRect(
                                          rect: floatingTools,
                                          child: SingleChildScrollView(
                                              child: _editorActions())),
                                  ])))),
                      if (_framing == null && _editable)
                        for (final CaptureHandleAnchor anchor
                            in const <CaptureHandleAnchor>[
                          CaptureHandleAnchor.topLeft,
                          CaptureHandleAnchor.topRight,
                          CaptureHandleAnchor.bottomLeft,
                          CaptureHandleAnchor.bottomRight
                        ])
                          _buildHandle(anchor, hit, _sel),
                      Positioned.fromRect(
                          rect: toolsAtTop
                              ? close.shift(
                                  Offset(0, safe.bottom - 8 - close.bottom))
                              : close,
                          child: Opacity(
                              opacity: orbSmoothstep(120, 400, ms),
                              child: _buildClose())),
                    ]))));
      });

  Widget _buildClose() => Material(
      color: const Color(0xB3272727),
      shape: const CircleBorder(side: BorderSide(color: _captureRim)),
      child: IconButton(
          key: const Key('feedback-capture-cancel'),
          tooltip: '取消截图选区',
          onPressed: widget.onCancel,
          icon:
              const Icon(Icons.close_rounded, size: 20, color: Colors.white)));

  /// 在同一张冻结截图上等待用户首次画圈或重画。
  Widget _buildLassoSurface() {
    final Rect close = Rect.fromLTWH(
        math.max(0, widget.viewport.width - _safeInsets.right - 52),
        (8 + _safeInsets.top)
            .clamp(0, math.max(0, widget.viewport.height - 44)),
        44,
        44);
    final bool armed = _armed;
    final bool showWave =
        widget.lassoFirst && !_reduceMotion && !_beam.isCompleted;
    return Semantics(
        container: true,
        label: '局部截图圈选：画一个圈圈出问题区域，回车使用整个窗口，Esc 取消',
        child: FocusScope(
            child: Focus(
                focusNode: _frameFocus,
                onKeyEvent: _onKey,
                child: Stack(fit: StackFit.expand, children: <Widget>[
                  RawImage(image: widget.image, fit: BoxFit.fill),
                  if (showWave && _water)
                    IgnorePointer(
                        child: CustomPaint(
                            painter: WaterRipplePainter(
                                shader: _waterShader,
                                image: widget.image,
                                progress: _beam.value,
                                origin: _beamOrigin))),
                  if (showWave && !_water)
                    IgnorePointer(
                        child: CustomPaint(
                            painter: BeamAuroraPainter(
                                fingertips: widget.wakeOrigins,
                                progress: _beam.value,
                                origin: _beamOrigin))),
                  Listener(
                      key: const Key('feedback-capture-lasso'),
                      onPointerDown: (_) {
                        if (widget.lassoFirst && !_guideDismissed) {
                          setState(() => _guideDismissed = true);
                        }
                      },
                      // An accepted Flutter pan can end on a system cancellation.
                      // Discard its open path before the recognizer handles that event.
                      onPointerCancel: (_) {
                        if (_lasso.isNotEmpty) setState(_lasso.clear);
                      },
                      child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onPanStart: !armed
                              ? null
                              : (DragStartDetails d) => setState(() {
                                    if (!_beam.isCompleted) _beam.value = 1;
                                    _lasso
                                      ..clear()
                                      ..add(d.localPosition);
                                  }),
                          onPanUpdate: !armed
                              ? null
                              : (DragUpdateDetails d) {
                                  if (_lasso.isNotEmpty &&
                                      (d.localPosition - _lasso.last)
                                              .distance >=
                                          4) {
                                    setState(() => _lasso.add(d.localPosition));
                                  }
                                },
                          onPanEnd: !armed ? null : (_) => _commitLasso(),
                          onPanCancel:
                              !armed ? null : () => setState(_lasso.clear),
                          child: CustomPaint(
                              painter: _LassoPainter(_lasso.toList())))),
                  if (widget.lassoFirst && _beam.isCompleted && !_guideDismissed)
                    Positioned.fromRect(
                        rect: Rect.fromCenter(center: _beamOrigin, width: 112, height: 80),
                        child: IgnorePointer(
                            child: TweenAnimationBuilder<double>(
                                key: const Key('feedback-lasso-guide'),
                                duration: const Duration(milliseconds: 1120),
                                tween: Tween(begin: 0, end: 1),
                                onEnd: () => setState(() => _guideDismissed = true),
                                builder: (_, t, __) => Opacity(
                                    opacity: 1 - const Interval(.82, 1, curve: Curves.easeOut).transform(t),
                                    child: RepaintBoundary(
                                        child: CustomPaint(painter: _LassoGuidePainter(t))))))),
                  if (armed && _lasso.isEmpty)
                    _editorEdge(
                        child: IgnorePointer(
                            child: FutureBuilder<bool?>(
                                future: _hintOnDark,
                                builder: (context, snapshot) => _lassoHint(
                                    snapshot.data ??
                                        (Theme.of(context).brightness ==
                                            Brightness.dark))))),
                  if (armed && _lasso.isEmpty)
                    Positioned.fromRect(rect: close, child: _buildClose()),
                ]))));
  }

  Widget _lassoHint(bool dark) {
    // Outline the glyphs so they stay legible over a mixed screenshot.
    final ink = dark ? Colors.white : const Color(0xFF252528);
    final edge = dark ? const Color(0xE6262628) : Colors.white;
    final shadows = [
      Shadow(color: edge, blurRadius: 1.5, offset: const Offset(0, .7)),
      Shadow(color: edge, blurRadius: 1.5, offset: const Offset(0, -.7)),
    ];
    return Row(mainAxisAlignment: MainAxisAlignment.center, children: [
      Icon(Icons.gesture_rounded, size: 20, color: ink, shadows: shadows),
      const SizedBox(width: 8),
      Text('圈出问题位置',
          style: TextStyle(
              fontSize: 14,
              color: ink,
              shadows: shadows,
              fontWeight: FontWeight.w600,
              decoration: TextDecoration.none)),
    ]);
  }

  void _commitLasso() {
    final List<Offset> points = List<Offset>.of(_lasso);
    _lasso.clear();
    if (points.length < 2) {
      setState(() {});
      return;
    }
    final Rect raw = lassoBoundingRect(points, widget.viewport,
        pad: 0, minSize: 1, safeInsets: EdgeInsets.zero);
    final Rect padded =
        lassoBoundingRect(points, widget.viewport, safeInsets: _safeInsets);
    setState(() {
      _selection = padded;
      _morphFrom = raw;
      _framing = null;
    });
    _entrance.forward(from: 0);
  }

  Widget _buildHandle(CaptureHandleAnchor anchor, double hit, Rect sel) {
    final double x = anchor.dx < 0 ? sel.left : sel.right;
    final double y = anchor.dy < 0 ? sel.top : sel.bottom;
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
                          _sel, anchor, d.delta, widget.viewport,
                          safeInsets: _safeInsets);
                    }))));
  }
}

class _LassoGuidePainter extends CustomPainter {
  const _LassoGuidePainter(this.progress);
  final double progress;

  // Coordinates are relative to the gesture midpoint. The last curve crosses
  // the first stroke and turns inward as the fingertip lifts.
  static final _loop = (Path()
        ..moveTo(23, -22)
        ..cubicTo(5, -31, -26, -22, -41, -5)
        ..cubicTo(-58, 16, -41, 31, -16, 29)
        ..cubicTo(12, 29, 43, 12, 47, -7)
        ..cubicTo(50, -26, 28, -31, 10, -24)
        ..cubicTo(4, -22, 0, -19, -4, -16))
      .computeMetrics().first;
  static final _ink = const LinearGradient(
      begin: Alignment.bottomLeft, end: Alignment.topRight,
      colors: [Color(0xFF338F87), Color(0xFF73CBB3), Color(0xFFB7F2D8)])
      .createShader(const Rect.fromLTRB(-43, -28, 44, 29));
  static const _travel = Interval(.04, .74, curve: Cubic(.32, 0, .22, 1));

  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    final length = _loop.length * _travel.transform(progress);
    final trail = _loop.extractPath(0, length);
    final pen = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 3.8
      ..color = const Color(0x94245C58);
    canvas.drawPath(trail, pen);
    canvas.drawPath(trail, pen
      ..strokeWidth = 2.5
      ..color = Colors.white
      ..shader = _ink);

    final touch = const Interval(0, .06).transform(progress) *
        (1 - const Interval(.67, .80).transform(progress));
    if (touch <= 0) return;
    final tip = _loop.getTangentForOffset(length)!.position;
    final light = Paint()..color = const Color(0xFF86E6C9).withValues(alpha: .3 * touch);
    canvas.drawCircle(tip, 5 * touch, light);
    canvas.drawCircle(tip, 2.55 * touch, light..color = const Color(0xFF458E82));
    canvas.drawCircle(tip, 1.85 * touch, light..color = const Color(0xFFF0FFF9));
  }

  @override
  bool shouldRepaint(_LassoGuidePainter oldDelegate) =>
      oldDelegate.progress != progress;
}

class _LassoPainter extends CustomPainter {
  const _LassoPainter(this.points);
  final List<Offset> points;
  @override
  void paint(Canvas canvas, Size size) {
    if (points.isEmpty) return;
    final Path stroke = Path()..addPolygon(points, false);
    final ink = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = _captureSurface.withValues(alpha: .8)
      ..strokeWidth = 4;
    canvas.drawPath(stroke, ink);
    canvas.drawPath(
        stroke,
        ink
          ..color = Colors.white
          ..strokeWidth = 2);
  }

  @override
  bool shouldRepaint(covariant _LassoPainter oldDelegate) => true;
}

class _SelectionOverlayPainter extends CustomPainter {
  const _SelectionOverlayPainter(
      {required this.selection,
      required this.radius,
      required this.corners,
      required this.dim,
      required this.opacity});
  final Rect selection;
  final double radius;
  final double corners;
  final double dim;
  final double opacity;
  @override
  void paint(Canvas canvas, Size size) {
    final RRect shape =
        RRect.fromRectAndRadius(selection, Radius.circular(radius));
    canvas.drawPath(
        Path.combine(PathOperation.difference,
            Path()..addRect(Offset.zero & size), Path()..addRRect(shape)),
        Paint()..color = kBeamDimColor.withValues(alpha: dim));
    canvas.drawRRect(
        shape,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1
          ..color = Colors.white.withValues(alpha: .95 * opacity));
    if (corners > 0) {
      final path = Path();
      final length = math.min(14.0, selection.shortestSide / 3) * corners;
      for (final dx in [-1, 1]) {
        for (final dy in [-1, 1]) {
          final x = dx < 0 ? selection.left : selection.right;
          final y = dy < 0 ? selection.top : selection.bottom;
          path
            ..moveTo(x - dx * length, y)
            ..lineTo(x, y)
            ..lineTo(x, y - dy * length);
        }
      }
      final pen = Paint()
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 4
        ..color = Colors.black.withValues(alpha: .40 * opacity);
      canvas.drawPath(path, pen);
      canvas.drawPath(
          path,
          pen
            ..strokeWidth = 2.5
            ..color = Colors.white.withValues(alpha: opacity));
    }
  }

  @override
  bool shouldRepaint(_SelectionOverlayPainter old) => true;
}
