import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_test/flutter_test.dart';

/// spec 12.3.1 对比度保持率：核心必须接近清玻璃。
///
/// 口径按 spec 12.3.1：取球心水平带 `|dy| < 0.45R`，比较球内 `r < 0.55R` 与球外
/// `1.6R–3.2R` 的亮度标准差，`保持率 = std_in / std_out`，硬性门槛 `≥ 0.85`；
/// 并同时保留 12.3 的亮度约束（浅色主题球心不得比同位置背景更暗）。
///
/// 背景用**周期性竖条纹**而不是真实文字。12.3.1 自己写明了官方测量的局限
/// ——「球内外落在不同字形上，std 不是完全受控对比」。条纹把这个变量消掉：
/// 同一周期、同一占空比铺满整幅画布，球内外采样的理论 std 相同，任何模糊 /
/// 压白都会立刻掉下来。这比用真实文字更严，不是更松。
///
/// 另外单独算一条**受控保持率**：同一区域「有球」与「只有背景」两次渲染的 std
/// 之比。它不受球内外区域差异影响，是这组用例真正的主力断言；spec 口径的那条
/// 保留下来是为了与官方帧的数字可比。
const int _pixels = 640;
const double _canvas = 640;
const double _ratio = 2;
const double _diameter = 56;
const double _flow = 0.25;
const double _breath = 0.5;

// 条纹周期 8 设备像素（4 深 4 浅），关于画布中心对称。
const int _stripePeriod = 8;
const double _radiusDev = _diameter / 2 * _ratio;
const double _bandHalf = 0.45 * _radiusDev;
const double _insideOuter = 0.55 * _radiusDev;
const double _outsideInner = 1.6 * _radiusDev;
const double _outsideOuter = 3.2 * _radiusDev;
const double _minRetention = 0.85;

final Map<ui.Brightness, (ui.Color, ui.Color)> _stripes =
    <ui.Brightness, (ui.Color, ui.Color)>{
  // 浅色沿用出图矩阵的 #c9c9c9 台架，深色沿用 #202020；条纹对侧取与之拉开
  // 足够对比的灰，模拟压在文字上的场景。
  ui.Brightness.light: (ui.Color(0xFFC9C9C9), ui.Color(0xFF303030)),
  ui.Brightness.dark: (ui.Color(0xFF202020), ui.Color(0xFFD8D8D8)),
};

double _luma(int r, int g, int b) => 0.299 * r + 0.587 * g + 0.114 * b;

Future<Uint8List> _render(ui.Brightness brightness,
    {required bool withOrb}) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  final (ui.Color base, ui.Color stripe) = _stripes[brightness]!;
  canvas.drawRect(const ui.Rect.fromLTWH(0, 0, _canvas, _canvas),
      ui.Paint()..color = base);
  final ui.Paint stripePaint = ui.Paint()..color = stripe;
  for (int x = 0; x < _pixels; x++) {
    if ((x - _pixels ~/ 2) % _stripePeriod < _stripePeriod ~/ 2) continue;
    canvas.drawRect(
        ui.Rect.fromLTWH(x.toDouble(), 0, 1, _canvas), stripePaint);
  }
  if (withOrb) {
    canvas.translate(_canvas / 2, _canvas / 2);
    canvas.scale(_ratio);
    canvas.translate(-_diameter / 2, -_diameter / 2);
    OrbPainter(
      flow: _flow,
      breath: _breath,
      breathWeight: 1.0,
      stateScale: 1.0,
      dragAngle: 0.0,
      pull: 0.0,
      glowOffset: ui.Offset.zero,
      brightness: brightness,
    ).paint(canvas, const ui.Size.square(_diameter));
  }
  final ui.Picture picture = recorder.endRecording();
  final ui.Image image;
  try {
    image = await picture.toImage(_pixels, _pixels);
  } finally {
    picture.dispose();
  }
  try {
    final ByteData? raw =
        await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    if (raw == null) throw StateError('rawRgba 转换失败');
    return Uint8List.fromList(
        raw.buffer.asUint8List(raw.offsetInBytes, raw.lengthInBytes));
  } finally {
    image.dispose();
  }
}

/// 采样 `|dy| < _bandHalf` 带内、半径落在 `[inner, outer]` 的像素亮度。
List<double> _sample(Uint8List rgba, double inner, double outer) {
  const double cx = _pixels / 2;
  const double cy = _pixels / 2;
  final List<double> out = <double>[];
  final int yFrom = math.max(0, (cy - _bandHalf).ceil());
  final int yTo = math.min(_pixels - 1, (cy + _bandHalf).floor());
  for (int y = yFrom; y <= yTo; y++) {
    for (int x = 0; x < _pixels; x++) {
      final double dx = x + 0.5 - cx;
      final double dy = y + 0.5 - cy;
      final double r = math.sqrt(dx * dx + dy * dy);
      if (r < inner || r > outer) continue;
      final int offset = (y * _pixels + x) * 4;
      out.add(_luma(rgba[offset], rgba[offset + 1], rgba[offset + 2]));
    }
  }
  return out;
}

double _mean(List<double> values) =>
    values.reduce((double a, double b) => a + b) / values.length;

double _std(List<double> values) {
  final double mean = _mean(values);
  double sum = 0;
  for (final double value in values) {
    sum += (value - mean) * (value - mean);
  }
  return math.sqrt(sum / values.length);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final ui.Brightness brightness in ui.Brightness.values) {
    test('spec 12.3.1 ${brightness.name}：核心对比度保持率 ≥ $_minRetention',
        () async {
      final Uint8List withOrb = await _render(brightness, withOrb: true);
      final Uint8List plain = await _render(brightness, withOrb: false);

      final List<double> inside = _sample(withOrb, 0, _insideOuter);
      final List<double> outside =
          _sample(withOrb, _outsideInner, _outsideOuter);
      final List<double> insidePlain = _sample(plain, 0, _insideOuter);
      final List<double> outsidePlain =
          _sample(plain, _outsideInner, _outsideOuter);

      expect(inside.length, greaterThan(500), reason: '球内采样过少，口径算错了');
      expect(outside.length, greaterThan(5000), reason: '球外采样过少');

      // 先自检夹具：只有背景时，球内外两块区域的 std 必须本来就相当，
      // 否则 spec 口径的保持率是在量条纹分布差异，而不是量球。
      final double fixtureRatio = _std(insidePlain) / _std(outsidePlain);
      expect(fixtureRatio, closeTo(1.0, 0.05),
          reason: '条纹夹具自身不均匀：球内外基准 std 已经差 '
              '${((fixtureRatio - 1) * 100).toStringAsFixed(1)}%');

      final double specRetention = _std(inside) / _std(outside);
      final double controlled = _std(inside) / _std(insidePlain);

      // 12.3 的亮度约束：浅色主题下球心不得比同位置背景更暗。
      if (brightness == ui.Brightness.light) {
        expect(_mean(inside), greaterThanOrEqualTo(_mean(insidePlain)),
            reason: '浅色主题球心比同位置背景更暗');
      }

      debugPrint('ORB_CONTRAST ${brightness.name} '
          'specRetention=${specRetention.toStringAsFixed(4)} '
          'controlled=${controlled.toStringAsFixed(4)} '
          'fixtureRatio=${fixtureRatio.toStringAsFixed(4)} '
          'stdIn=${_std(inside).toStringAsFixed(2)} '
          'stdOut=${_std(outside).toStringAsFixed(2)} '
          'stdInPlain=${_std(insidePlain).toStringAsFixed(2)} '
          'meanIn=${_mean(inside).toStringAsFixed(2)} '
          'meanInPlain=${_mean(insidePlain).toStringAsFixed(2)} '
          'nIn=${inside.length} nOut=${outside.length}');

      expect(specRetention, greaterThanOrEqualTo(_minRetention),
          reason: 'spec 12.3.1 口径保持率低于门槛');
      expect(controlled, greaterThanOrEqualTo(_minRetention),
          reason: '受控口径（同区域有球 / 无球）保持率低于门槛');
    });
  }
}
