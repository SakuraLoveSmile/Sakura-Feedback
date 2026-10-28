import 'dart:async' show unawaited;
import 'dart:math' as math;
import 'dart:typed_data' show ByteData, Uint8List;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'images.dart';
import 'widget.dart'
    show kFeedbackCaptureMaxBytes, kFeedbackWideBreakpoint;

/// 编辑器动效时长（T2 规格：160–220ms）。
const Duration kEditorMotion = Duration(milliseconds: 180);

/// 面板内图片编辑器（v12 / T2）：「调整选区 → 应用裁剪 → 保存图片」，
/// 以及矩形标注 / 不透明遮挡 / 撤销 / 取消 / 保存。
///
/// 裁剪**松手不自动裁剪**：进入待确认态，选区边框与外部暗化遮罩持续显示，
/// 支持移动、八个控制点缩放、重新框选；「应用裁剪」后主画布展示完整结果，
/// 可继续标注 / 遮挡 / 撤销。**存在未应用选区时禁止保存**。
///
/// 裁剪保留操作类型：实色遮挡（不透明 `rgb(110,110,115)` 色块）在裁剪后
/// 仍是遮挡（绝不退化成描边）；预览与最终导出**共用同一编辑结果**
/// （[_paintEditResult]），辅助边框 / 网格 / 控制点只画在覆盖层、
/// 绝不写入图片。
///
/// 编辑器一律输出 PNG（编辑路径统一重编码），并按契约上限等比缩小
/// （2048px / 400万像素 / 5MiB），返回的字节即最终预览效果。
///
/// 使用 [FeedbackImageEditor.open] 弹出全屏编辑页（MaterialPageRoute，
/// 需要 Navigator 祖先；面板在 MaterialApp 外侧挂载时由外层 Overlay
/// 兜底——见 [FeedbackImageEditor.openAsOverlay]）。
class FeedbackImageEditor extends StatefulWidget {
  /// 构造编辑器。[image] 为已解码的原图（编辑坐标系即其像素）；
  /// [onDone] 仅 Overlay 模式使用（路由模式经 `pop` 返回结果）。
  const FeedbackImageEditor({
    super.key,
    required this.image,
    required this.filename,
    this.onDone,
  });

  /// 原图（编辑基准，撤销栈的根）。
  final ui.Image image;

  /// 展示用文件名。
  final String filename;

  /// Overlay 模式的完成回调（路由模式为 null）。
  final void Function(Uint8List? result)? onDone;

  /// 以路由方式打开（需要 Navigator 祖先）。取消返回 null；
  /// 保存返回 PNG 字节（已按契约等比缩小）。
  static Future<Uint8List?> open(
    BuildContext context, {
    required Uint8List bytes,
    required String filename,
  }) async {
    final ui.Image image = await decodeImage(bytes);
    if (!context.mounted) {
      image.dispose();
      return null;
    }
    return Navigator.of(context).push<Uint8List>(
      MaterialPageRoute<Uint8List>(
        fullscreenDialog: true,
        builder: (_) => FeedbackImageEditor(image: image, filename: filename),
      ),
    );
  }

  /// 以 OverlayEntry 方式打开（无 Navigator 祖先时的兜底，如组件挂在
  /// MaterialApp 外侧）。[overlay] 为祖先 OverlayState；取消回调 null。
  static void openAsOverlay(
    OverlayState overlay, {
    required Uint8List bytes,
    required String filename,
    required void Function(Uint8List? result) onDone,
  }) {
    try {
      // decodeImage 是异步的：失败时回调 null（取消语义，原图保留）。
      decodeImage(bytes).then((ui.Image decoded) {
        late OverlayEntry entry;
        entry = OverlayEntry(
          builder: (BuildContext ctx) => FeedbackImageEditor(
            image: decoded,
            filename: filename,
            onDone: (Uint8List? result) {
              entry.remove();
              onDone(result);
            },
          ),
        );
        overlay.insert(entry);
      }).catchError((Object _) {
        onDone(null);
        return null;
      });
    } catch (_) {
      onDone(null);
    }
  }

  @override
  FeedbackImageEditorState createState() => FeedbackImageEditorState();
}

/// 编辑工具模式。
enum _EditorTool { none, crop, rect, mask }

/// 一条已提交的编辑操作（作用于当前基准图坐标系）。
/// 裁剪不进入操作栈（裁剪直接换基准图），操作只有矩形标注与遮挡。
class _EditOp {
  const _EditOp.rect(this.rect, this.color) : kind = _EditorTool.rect;

  const _EditOp.mask(this.rect)
      : kind = _EditorTool.mask,
        color = const Color(0xFF6E6E73);

  final _EditorTool kind;
  final Rect rect;
  final Color color;
}

/// 编辑快照：基准图 + 其后的标注操作（裁剪把标注坐标映射进新基准，
/// 且**保留操作类型**——遮挡仍是遮挡）。
class _EditSnapshot {
  _EditSnapshot(this.base, [List<_EditOp>? ops])
      : ops = List<_EditOp>.unmodifiable(ops ?? const <_EditOp>[]);

  final ui.Image base;
  final List<_EditOp> ops;
}

/// 裁剪选区的画布内交互模式。
enum _CropInteraction { none, frame, move }

/// 把「基准图 + 操作」绘制到 [dst]（**预览与最终导出共用**的唯一渲染）。
///
/// [srcImage] 指定基准图源矩形（裁剪结果预览用），null = 整图。
/// 只绘制编辑内容本身：辅助边框 / 网格 / 控制点 / 暗化遮罩由各自
/// 覆盖层绘制，**绝不进入此函数**（即绝不写入导出图片）。
void _paintEditResult(
  Canvas canvas,
  Rect dst,
  ui.Image base,
  List<_EditOp> ops, {
  Rect? srcImage,
}) {
  final Rect src = srcImage ??
      (Offset.zero & Size(base.width.toDouble(), base.height.toDouble()));
  if (dst.isEmpty || src.isEmpty) return;
  canvas.save();
  canvas.clipRect(dst);
  canvas.drawImageRect(base, src, dst, Paint());
  final double s = dst.width / src.width;
  final double strokeWidth =
      math.max(3.0, base.width / 400.0) * math.max(s, 0.0001);
  for (final _EditOp op in ops) {
    final Rect r = Rect.fromLTWH(
      dst.left + (op.rect.left - src.left) * s,
      dst.top + (op.rect.top - src.top) * s,
      op.rect.width * s,
      op.rect.height * s,
    );
    canvas.drawRect(
      r,
      Paint()
        ..color = op.color
        ..style = op.kind == _EditorTool.mask
            ? PaintingStyle.fill
            : PaintingStyle.stroke
        ..strokeWidth = strokeWidth,
    );
  }
  canvas.restore();
}

/// 编辑器状态（public 仅供测试驱动裁剪待确认状态机）。
class FeedbackImageEditorState extends State<FeedbackImageEditor> {
  /// 撤销栈：栈底为原图。
  final List<_EditSnapshot> _history = <_EditSnapshot>[];

  _EditorTool _tool = _EditorTool.none;
  Offset? _dragStart;
  Offset? _dragCurrent;
  _CropInteraction _cropInteraction = _CropInteraction.none;
  Offset _moveDelta = Offset.zero;

  /// 裁剪选区（**图像坐标系**）：松手后进入待确认态，应用 / 取消后清空。
  Rect? _pendingCrop;
  bool _saving = false;

  /// 当前基准图。
  ui.Image get _base => _history.last.base;

  /// 当前基准之上的标注列表。
  List<_EditOp> get _ops => _history.last.ops;

  /// 是否存在未应用的裁剪选区（测试可见）。
  bool get hasPendingCrop => _pendingCrop != null;

  /// 未应用的裁剪选区（图像坐标；测试可见）。
  Rect? get pendingCrop => _pendingCrop;

  /// 当前基准图尺寸（测试可见）。
  Size get baseSize => Size(_base.width.toDouble(), _base.height.toDouble());

  /// 已提交操作（图像坐标）及是否遮挡（测试可见）：
  /// 裁剪必须保留 `mask` 类型（实色遮挡不得退化成矩形描边）。
  List<({Rect rect, bool mask})> get editOps => <({Rect rect, bool mask})>[
        for (final _EditOp op in _ops)
          (rect: op.rect, mask: op.kind == _EditorTool.mask),
      ];

  @override
  void initState() {
    super.initState();
    _history.add(_EditSnapshot(widget.image));
  }

  @override
  void dispose() {
    // 只释放编辑器自己生成的中间基准（撤销栈内可能共享同一基准；
    // 栈底原图由调用方管理，绝不在此释放）。
    final Set<ui.Image> seen = <ui.Image>{};
    for (int i = 1; i < _history.length; i++) {
      final ui.Image base = _history[i].base;
      if (identical(base, widget.image)) continue;
      if (seen.add(base)) base.dispose();
    }
    super.dispose();
  }

  /// 图片在屏幕上的展示矩形（fit contain），由 build 内 LayoutBuilder 设置。
  Rect _displayRect = Rect.zero;

  /// 展示比例（逻辑 → 展示）。
  double get _displayScale => _displayRect.width / math.max(1, _base.width);

  Rect _toImageRect(Rect displayRect) {
    if (_displayRect.isEmpty) return Rect.zero;
    final double sx = _base.width / _displayRect.width;
    final Offset tl = Offset(
      ((displayRect.left - _displayRect.left) * sx)
          .clamp(0.0, _base.width.toDouble()),
      ((displayRect.top - _displayRect.top) * sx)
          .clamp(0.0, _base.height.toDouble()),
    );
    final Offset br = Offset(
      ((displayRect.right - _displayRect.left) * sx)
          .clamp(0.0, _base.width.toDouble()),
      ((displayRect.bottom - _displayRect.top) * sx)
          .clamp(0.0, _base.height.toDouble()),
    );
    return Rect.fromPoints(tl, br);
  }

  /// 图像坐标 → 展示坐标（[_toImageRect] 的逆变换）。
  Rect _toDisplayRect(Rect imageRect) {
    final double s = _displayScale;
    return Rect.fromLTWH(
      _displayRect.left + imageRect.left * s,
      _displayRect.top + imageRect.top * s,
      imageRect.width * s,
      imageRect.height * s,
    );
  }

  /// 把裁剪选区钳进图像边界并保持最小 8px。
  Rect _clampCrop(Rect rect) {
    const double minSize = 8;
    double left = rect.left.clamp(0.0, _base.width.toDouble());
    double top = rect.top.clamp(0.0, _base.height.toDouble());
    double right = rect.right.clamp(left, _base.width.toDouble());
    double bottom = rect.bottom.clamp(top, _base.height.toDouble());
    if (right - left < minSize) {
      right = math.min(_base.width.toDouble(), left + minSize);
      left = math.max(0.0, right - minSize);
    }
    if (bottom - top < minSize) {
      bottom = math.min(_base.height.toDouble(), top + minSize);
      top = math.max(0.0, bottom - minSize);
    }
    return Rect.fromLTRB(left, top, right, bottom);
  }

  /// 生效选区（含拖动中的实时位移），用于预览与覆盖层同步显示。
  Rect? get _effectiveCrop {
    final Rect? pending = _pendingCrop;
    if (pending == null) return null;
    if (_cropInteraction == _CropInteraction.move) {
      return _clampCrop(pending.shift(_moveDelta));
    }
    return pending;
  }

  void _commitRect(Rect displayRect) {
    final Rect r = _toImageRect(displayRect);
    if (r.isEmpty || r.shortestSide < 2) return;
    if (_tool == _EditorTool.crop) {
      // T2.1：松手**不自动裁剪** —— 进入待确认态，由用户「应用 / 取消」。
      setState(() => _pendingCrop = _clampCrop(r));
    } else {
      final _EditOp op = _tool == _EditorTool.mask
          ? _EditOp.mask(r)
          : _EditOp.rect(r, Colors.redAccent);
      setState(() {
        _history.add(_EditSnapshot(_base, <_EditOp>[..._ops, op]));
      });
    }
  }

  /// 应用裁剪：基准图换成子图，既有标注坐标映射进新基准（原点平移），
  /// 且**保留操作类型**（遮挡仍是不透明实色块，绝不退化成描边）。
  Future<void> _applyCrop(Rect r) async {
    r = _clampCrop(r);
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    canvas.drawImageRect(
      _base,
      r,
      Offset.zero & Size(r.width, r.height),
      Paint(),
    );
    final ui.Picture picture = recorder.endRecording();
    final ui.Image cropped =
        await picture.toImage(r.width.round(), r.height.round());
    picture.dispose();
    if (!mounted) {
      cropped.dispose();
      return;
    }
    setState(() {
      _history.add(_EditSnapshot(cropped, <_EditOp>[
        for (final _EditOp op in _ops)
          if (op.kind == _EditorTool.mask)
            _EditOp.mask(op.rect.translate(-r.left, -r.top))
          else
            _EditOp.rect(op.rect.translate(-r.left, -r.top), op.color),
      ]));
      _pendingCrop = null;
      _cropInteraction = _CropInteraction.none;
      _moveDelta = Offset.zero;
    });
  }

  /// 应用当前待确认的裁剪选区。
  Future<void> _applyPendingCrop() async {
    final Rect? pending = _effectiveCrop;
    if (pending == null) return;
    await _applyCrop(pending);
  }

  /// 取消裁剪选区：回到未选区状态，不改动图片。
  void _cancelPendingCrop() {
    setState(() {
      _pendingCrop = null;
      _cropInteraction = _CropInteraction.none;
      _moveDelta = Offset.zero;
    });
  }

  void _undo() {
    if (_history.length <= 1) return;
    setState(() {
      final _EditSnapshot top = _history.removeLast();
      if (!identical(top.base, _history.last.base) &&
          !identical(top.base, widget.image)) {
        top.base.dispose();
      }
      // 回退到上一状态后，选区坐标系可能已变化：一并清掉待确认选区。
      _pendingCrop = null;
      _cropInteraction = _CropInteraction.none;
      _moveDelta = Offset.zero;
    });
  }

  /// 渲染最终位图：基准图 + 依次应用标注（与预览共用同一渲染函数）。
  Future<Uint8List?> _renderFinal() async {
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    _paintEditResult(
      canvas,
      Offset.zero & Size(_base.width.toDouble(), _base.height.toDouble()),
      _base,
      _ops,
    );
    final ui.Picture picture = recorder.endRecording();
    ui.Image? composed;
    try {
      composed = await picture.toImage(_base.width, _base.height);
      final ByteData? data =
          await composed.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) return null;
      Uint8List bytes =
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      // 契约上限：等比缩小到 2048px / 400万像素 / 5MiB。
      if (bytes.length > kFeedbackCaptureMaxBytes ||
          feedbackImageScaleFactor(composed.width, composed.height) < 1.0) {
        final Uint8List? shrunk = await downscaleImageToPng(bytes);
        if (shrunk == null) {
          return null; // 调用方提示并保留草稿
        }
        bytes = shrunk;
      }
      return bytes;
    } finally {
      picture.dispose();
      composed?.dispose();
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    // T2.4：存在未应用选区时禁止保存（按钮已禁用，这里是双保险）。
    if (_pendingCrop != null) return;
    setState(() => _saving = true);
    final Uint8List? result = await _renderFinal();
    if (!mounted) return;
    if (widget.onDone != null) {
      widget.onDone!(result);
      return;
    }
    Navigator.of(context).pop<Uint8List>(result);
  }

  void _cancel() {
    if (widget.onDone != null) {
      widget.onDone!(null);
      return;
    }
    Navigator.of(context).pop<Uint8List>();
  }

  bool get _cropToolActive => _tool == _EditorTool.crop;

  void _onPanStart(DragStartDetails d) {
    if (_tool == _EditorTool.none) return;
    if (_cropToolActive && _pendingCrop != null) {
      // 待确认选区内按下 = 移动选区；选区外按下 = 重新框选。
      final Rect displaySel = _toDisplayRect(_effectiveCrop!);
      if (displaySel.inflate(6).contains(d.localPosition)) {
        setState(() {
          _cropInteraction = _CropInteraction.move;
          _moveDelta = Offset.zero;
          _dragStart = null;
          _dragCurrent = null;
        });
        return;
      }
    }
    setState(() {
      _cropInteraction = _CropInteraction.frame;
      _dragStart = d.localPosition;
      _dragCurrent = d.localPosition;
    });
  }

  void _onPanUpdate(DragUpdateDetails d) {
    if (_cropInteraction == _CropInteraction.move) {
      final double s = math.max(0.0001, _displayScale);
      setState(() {
        _moveDelta += d.delta / s;
      });
      return;
    }
    if (_dragStart == null) return;
    setState(() => _dragCurrent = d.localPosition);
  }

  void _onPanEnd(DragEndDetails d) {
    if (_cropInteraction == _CropInteraction.move) {
      final Rect? pending = _pendingCrop;
      final Offset delta = _moveDelta;
      setState(() {
        _cropInteraction = _CropInteraction.none;
        _moveDelta = Offset.zero;
        if (pending != null) _pendingCrop = _clampCrop(pending.shift(delta));
      });
      return;
    }
    final Offset? start = _dragStart;
    final Offset? end = _dragCurrent;
    setState(() {
      _cropInteraction = _CropInteraction.none;
      _dragStart = null;
      _dragCurrent = null;
    });
    if (start == null || end == null) return;
    _commitRect(Rect.fromPoints(start, end));
  }

  Rect? get _liveRect {
    if (_dragStart == null || _dragCurrent == null) return null;
    return Rect.fromPoints(_dragStart!, _dragCurrent!);
  }

  Widget _toolButton({
    required Key key,
    required _EditorTool tool,
    required IconData icon,
    required String tooltip,
  }) {
    final bool active = _tool == tool;
    return IconButton(
      key: key,
      tooltip: tooltip,
      iconSize: 22,
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
      isSelected: active,
      style: IconButton.styleFrom(
        backgroundColor:
            active ? Theme.of(context).colorScheme.primaryContainer : null,
      ),
      icon: Icon(icon),
      onPressed: () {
        setState(() {
          if (active && tool == _EditorTool.crop) {
            // 关闭裁剪工具时同时放弃未应用选区（不改动图片）。
            _pendingCrop = null;
            _cropInteraction = _CropInteraction.none;
            _moveDelta = Offset.zero;
          }
          _tool = active ? _EditorTool.none : tool;
        });
      },
    );
  }

  /// 八个缩放控制点（仅裁剪待确认态显示；命中区 32dp）。
  List<Widget> _buildCropHandles(Rect displaySel) {
    const double hit = 32;
    final List<Widget> handles = <Widget>[];
    for (final (int dx, int dy) in const <(int, int)>[
      (-1, -1),
      (0, -1),
      (1, -1),
      (-1, 0),
      (1, 0),
      (-1, 1),
      (0, 1),
      (1, 1),
    ]) {
      final double cx = dx < 0
          ? displaySel.left
          : dx > 0
              ? displaySel.right
              : displaySel.center.dx;
      final double cy = dy < 0
          ? displaySel.top
          : dy > 0
              ? displaySel.bottom
              : displaySel.center.dy;
      handles.add(
        Positioned(
          left: cx - hit / 2,
          top: cy - hit / 2,
          width: hit,
          height: hit,
          child: GestureDetector(
            key: Key('feedback-editor-crop-handle-${dx + 1}-${dy + 1}'),
            behavior: HitTestBehavior.opaque,
            onPanUpdate: (DragUpdateDetails d) {
              final double s = math.max(0.0001, _displayScale);
              final Rect pending = _pendingCrop!;
              final Offset delta = d.delta / s;
              double left = pending.left;
              double top = pending.top;
              double right = pending.right;
              double bottom = pending.bottom;
              if (dx < 0) left += delta.dx;
              if (dx > 0) right += delta.dx;
              if (dy < 0) top += delta.dy;
              if (dy > 0) bottom += delta.dy;
              setState(() {
                _pendingCrop = _clampCrop(Rect.fromLTRB(left, top, right, bottom));
              });
            },
            child: Center(
              child: Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: dx == 0 || dy == 0
                      ? BoxShape.rectangle
                      : BoxShape.circle,
                  border: Border.all(color: Colors.black26, width: 0.6),
                  borderRadius: dx == 0 || dy == 0
                      ? BorderRadius.circular(2)
                      : null,
                ),
              ),
            ),
          ),
        ),
      );
    }
    return handles;
  }

  /// 裁剪结果预览面板：与导出共用同一渲染；显示输出尺寸。
  Widget _buildCropPreview() {
    final Rect? pending = _effectiveCrop;
    final int outW = (pending?.width ?? _base.width).round();
    final int outH = (pending?.height ?? _base.height).round();
    return Container(
      key: const Key('feedback-editor-crop-preview'),
      color: const Color(0xFF121212),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            '裁剪结果',
            key: const Key('feedback-editor-crop-preview-title'),
            style: const TextStyle(
                color: Colors.white,
                fontSize: 13,
                fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            '输出尺寸 $outW×$outH',
            key: const Key('feedback-editor-crop-size'),
            style: const TextStyle(color: Colors.white70, fontSize: 12),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: Center(
              child: AspectRatio(
                aspectRatio: pending == null
                    ? _base.width / math.max(1, _base.height)
                    : pending.width / math.max(1, pending.height),
                child: CustomPaint(
                  key: const Key('feedback-editor-crop-preview-canvas'),
                  painter: _CropPreviewPainter(
                    base: _base,
                    ops: _ops,
                    crop: pending,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 底部固定确认区：待确认时提供「应用裁剪 / 取消裁剪」。
  Widget _buildConfirmBar() {
    final bool pending = _pendingCrop != null;
    return Container(
      key: const Key('feedback-editor-confirm-bar'),
      color: const Color(0xFF121212),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: AnimatedSwitcher(
        duration: kEditorMotion,
        switchInCurve: Curves.easeOut,
        switchOutCurve: Curves.easeOut,
        child: pending
            ? Row(
                key: const Key('feedback-editor-crop-actions'),
                children: <Widget>[
                  Expanded(
                    child: FilledButton(
                      key: const Key('feedback-editor-crop-apply'),
                      onPressed: () {
                        unawaited(_applyPendingCrop());
                      },
                      child: const Text('应用裁剪'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('feedback-editor-crop-cancel'),
                      onPressed: _cancelPendingCrop,
                      child: const Text('取消裁剪'),
                    ),
                  ),
                ],
              )
            : Text(
                key: const Key('feedback-editor-crop-hint'),
                _tool == _EditorTool.crop
                    ? '拖选区域后点击「应用裁剪」；可移动、缩放或重新框选'
                    : '选择裁剪工具拖选区域，松手后可调整再应用',
                textAlign: TextAlign.center,
                style:
                    const TextStyle(color: Colors.white54, fontSize: 12),
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool pending = _pendingCrop != null;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text('编辑图片 — ${widget.filename}',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 15)),
        leading: IconButton(
          key: const Key('feedback-editor-cancel'),
          tooltip: '取消',
          icon: const Icon(Icons.close),
          onPressed: _cancel,
        ),
        actions: <Widget>[
          IconButton(
            key: const Key('feedback-editor-undo'),
            tooltip: '撤销',
            icon: const Icon(Icons.undo),
            onPressed: _history.length > 1 ? _undo : null,
          ),
          // T2.4：存在未应用选区时禁止保存，并说明原因。
          Tooltip(
            message: pending ? '请先应用或取消裁剪选区' : '保存图片',
            child: TextButton(
              key: const Key('feedback-editor-save'),
              onPressed: (_saving || pending) ? null : _save,
              child: _saving
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('保存', style: TextStyle(color: Colors.white)),
            ),
          ),
        ],
      ),
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          // T2.3：桌面/宽屏左侧编辑、右侧 280px 结果预览；
          // 窄屏上下排列、结果区高 160px；底部固定确认按钮。
          final bool wide =
              constraints.maxWidth >= kFeedbackWideBreakpoint;
          final Widget canvas = LayoutBuilder(
            builder: (BuildContext context, BoxConstraints inner) {
              final double scale = math.min(
                inner.maxWidth / _base.width,
                inner.maxHeight / _base.height,
              );
              final Size fitted =
                  Size(_base.width * scale, _base.height * scale);
              _displayRect = Rect.fromLTWH(
                (inner.maxWidth - fitted.width) / 2,
                (inner.maxHeight - fitted.height) / 2,
                fitted.width,
                fitted.height,
              );
              final Rect? pending = _effectiveCrop;
              final Rect? pendingDisplay =
                  pending == null ? null : _toDisplayRect(pending);
              final bool showHandles = pendingDisplay != null &&
                  _cropToolActive &&
                  _cropInteraction == _CropInteraction.none;
              return Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  Positioned.fill(
                    child: GestureDetector(
                      key: const Key('feedback-editor-canvas'),
                      onPanStart: _onPanStart,
                      onPanUpdate: _onPanUpdate,
                      onPanEnd: _onPanEnd,
                      child: CustomPaint(
                        painter: _EditorPainter(
                          image: _base,
                          displayRect: _displayRect,
                          ops: _ops,
                          tool: _tool,
                          liveRect: _liveRect,
                          pendingDisplay: _cropToolActive
                              ? pendingDisplay
                              : null,
                        ),
                      ),
                    ),
                  ),
                  if (showHandles)
                    ..._buildCropHandles(pendingDisplay),
                ],
              );
            },
          );
          final Widget preview = _buildCropPreview();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                child: wide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          Expanded(child: canvas),
                          SizedBox(width: 280, child: preview),
                        ],
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          Expanded(child: canvas),
                          SizedBox(height: 160, child: preview),
                        ],
                      ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: <Widget>[
                      _toolButton(
                        key: const Key('feedback-editor-crop'),
                        tool: _EditorTool.crop,
                        icon: Icons.crop,
                        tooltip: '裁剪（拖选区域后应用）',
                      ),
                      _toolButton(
                        key: const Key('feedback-editor-rect'),
                        tool: _EditorTool.rect,
                        icon: Icons.rectangle_outlined,
                        tooltip: '矩形标注',
                      ),
                      _toolButton(
                        key: const Key('feedback-editor-mask'),
                        tool: _EditorTool.mask,
                        icon: Icons.block,
                        tooltip: '遮挡（不透明）',
                      ),
                    ],
                  ),
                ),
              ),
              _buildConfirmBar(),
            ],
          );
        },
      ),
    );
  }
}

class _EditorPainter extends CustomPainter {
  _EditorPainter({
    required this.image,
    required this.displayRect,
    required this.ops,
    required this.tool,
    required this.liveRect,
    required this.pendingDisplay,
  });

  final ui.Image image;
  final Rect displayRect;
  final List<_EditOp> ops;
  final _EditorTool tool;
  final Rect? liveRect;

  /// 裁剪待确认选区（展示坐标）：边框 + 外部暗化 + 三分线 —— 覆盖层
  /// 绘制，绝不进入导出图片。
  final Rect? pendingDisplay;

  @override
  void paint(Canvas canvas, Size size) {
    // 编辑内容（与导出共用同一渲染函数）。
    _paintEditResult(canvas, displayRect, image, ops);
    // 裁剪待确认态：选区外压暗 + 白色边框 + 三分线（仅覆盖层）。
    final Rect? pending = pendingDisplay;
    if (pending != null && !pending.isEmpty) {
      canvas.drawPath(
        Path.combine(
          PathOperation.difference,
          Path()..addRect(Offset.zero & size),
          Path()..addRect(pending),
        ),
        Paint()..color = Colors.black.withValues(alpha: 0.45),
      );
      final Paint grid = Paint()
        ..strokeWidth = 0.7
        ..color = Colors.white.withValues(alpha: 0.35);
      for (int i = 1; i <= 2; i++) {
        final double dx = pending.left + pending.width * i / 3;
        final double dy = pending.top + pending.height * i / 3;
        canvas.drawLine(
            Offset(dx, pending.top), Offset(dx, pending.bottom), grid);
        canvas.drawLine(
            Offset(pending.left, dy), Offset(pending.right, dy), grid);
      }
      canvas.drawRect(
        pending,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = Colors.white,
      );
    }
    // 拖动中的实时矩形（标注 / 遮挡 / 新框选）。
    final Rect? live = liveRect;
    if (live != null && !live.isEmpty) {
      final Paint paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = switch (tool) {
          _EditorTool.crop => Colors.white,
          _EditorTool.rect => Colors.redAccent,
          _EditorTool.mask => const Color(0xFF6E6E73),
          _ => Colors.white,
        };
      canvas.drawRect(live, paint);
      if (tool == _EditorTool.crop) {
        // 裁剪预览：非选区压暗（覆盖层，不入图）。
        canvas.drawPath(
          Path.combine(
            PathOperation.difference,
            Path()..addRect(Offset.zero & size),
            Path()..addRect(live),
          ),
          Paint()..color = Colors.black.withValues(alpha: 0.45),
        );
      }
    }
  }

  @override
  bool shouldRepaint(_EditorPainter oldDelegate) => true;
}

/// 裁剪结果预览绘制：与最终导出共用 [_paintEditResult]，
/// 源矩形为当前（待确认）选区 —— 拖动选区即同步更新。
class _CropPreviewPainter extends CustomPainter {
  _CropPreviewPainter({
    required this.base,
    required this.ops,
    required this.crop,
  });

  final ui.Image base;
  final List<_EditOp> ops;
  final Rect? crop;

  @override
  void paint(Canvas canvas, Size size) {
    _paintEditResult(
      canvas,
      Offset.zero & size,
      base,
      ops,
      srcImage: crop,
    );
  }

  @override
  bool shouldRepaint(_CropPreviewPainter oldDelegate) =>
      oldDelegate.crop != crop ||
      oldDelegate.base != base ||
      oldDelegate.ops != ops;
}
