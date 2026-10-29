import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

/// T-L3b：C 路线（单次捕获 + `orb_lens.frag`）。
///
/// 证据分三层：
/// 1. 着色器数学：把七点径向表直接画在一张条纹图上量倍率——球心 1.70
///    （±5%）、球缘 < 1.0、r/R > 1 全透明。
/// 2. 组件接线：首次可见后 C 接管；hidden 释放快照并回退 A；再次可见在
///    一秒闸门内不捕获、闸门过期后补一次；失败注入时保持 A 且不冒泡。
/// 3. 宿主 bundling：`examples/flutter` 能按包前缀加载 `.frag`（见
///    examples/flutter/test/orb_lens_asset_test.dart）。
const int _imageSize = 512;
const double _center = 256;
const double _lensRadius = 200;
const double _stripePeriod = 32;
const double _stripeHalf = 16;
// 相位错开球心，保证球心附近有条纹边沿可比对。
const double _stripePhase = 8;

/// 拖动饱和时的玻璃拉伸倍率（与 `orbStretch(1.0)` 同值）。
const double _stretch = 1.04;

/// 斜向拖动的代表角，用来证明椭圆跟随拖动方向。
const double _angle = 0.6;
const double _minCenter = 1.615;
const double _maxCenter = 1.785;

final Key _lensKey = const Key('feedback-orb-lens');
final Key _shaderLensKey = const Key('feedback-orb-lens-shader');

Future<ui.Image> _stripeImage() async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, _imageSize.toDouble(), _imageSize.toDouble()),
    ui.Paint()..color = const Color(0xFFC85050),
  );
  for (double x = _stripePhase; x < _imageSize; x += _stripePeriod) {
    canvas.drawRect(
      Rect.fromLTWH(x, 0, _stripeHalf, _imageSize.toDouble()),
      ui.Paint()..color = const Color(0xFF5050C8),
    );
  }
  return recorder.endRecording().toImage(_imageSize, _imageSize);
}

class _LensImage {
  const _LensImage(this.rgba);

  final Uint8List rgba;

  int alphaAt(int x, int y) => rgba[(y * _imageSize + x) * 4 + 3];

  double chromaAt(int x, int y) {
    final int o = (y * _imageSize + x) * 4;
    return (rgba[o] - rgba[o + 2]).toDouble();
  }

  List<double> chromaRow(int y) => <double>[
        for (int x = 0; x < _imageSize; x++) chromaAt(x, y),
      ];

  double channelAt(int x, int y, int channel) =>
      rgba[(y * _imageSize + x) * 4 + channel].toDouble();

  List<double> channelRow(int y, int channel) => <double>[
        for (int x = 0; x < _imageSize; x++) channelAt(x, y, channel),
      ];

  /// 两个渲染结果的 alpha 差异像素数（用来证明色散不改透明度）。
  int alphaDiffCount(_LensImage other) {
    int diff = 0;
    for (int i = 3; i < rgba.length; i += 4) {
      if (rgba[i] != other.rgba[i]) diff++;
    }
    return diff;
  }

  double meanLuma(double inner, double outer) {
    double sum = 0;
    int count = 0;
    for (int y = 0; y < _imageSize; y++) {
      for (int x = 0; x < _imageSize; x++) {
        final double dx = x + 0.5 - _center;
        final double dy = y + 0.5 - _center;
        final double r = math.sqrt(dx * dx + dy * dy);
        if (r < inner || r > outer) continue;
        final int o = (y * _imageSize + x) * 4;
        sum += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
        count++;
      }
    }
    return count == 0 ? double.nan : sum / count;
  }
}

/// 把着色器画满 512×512（画布本身透明），返回原始像素。
///
/// [stretch] / [angle] 是拖动拉伸后的玻璃椭圆：半长轴 = R × stretch，
/// 沿拖动角 angle。
Future<_LensImage> _paintLens(
  ui.FragmentShader shader,
  ui.Image bg, {
  double stretch = 1.0,
  double angle = 0.0,
  double dispersion = kFeedbackOrbLensDispersionEdge,
}) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  shader
    ..setFloat(0, _imageSize.toDouble())
    ..setFloat(1, _imageSize.toDouble())
    ..setFloat(2, 0)
    ..setFloat(3, 0)
    ..setFloat(4, 1)
    ..setFloat(5, _center)
    ..setFloat(6, _center)
    ..setFloat(7, _lensRadius)
    ..setFloat(8, stretch)
    ..setFloat(9, angle)
    ..setFloat(10, dispersion)
    ..setImageSampler(0, bg);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, _imageSize.toDouble(), _imageSize.toDouble()),
    ui.Paint()..shader = shader,
  );
  final ui.Image out =
      await recorder.endRecording().toImage(_imageSize, _imageSize);
  final ByteData? raw =
      await out.toByteData(format: ui.ImageByteFormat.rawRgba);
  final Uint8List rgba = raw!.buffer.asUint8List();
  out.dispose();
  return _LensImage(rgba);
}

/// 环带内相邻条纹边沿的平均间距 / 源半周期（16 px）= 表观放大倍率。
///
/// 比对单一线性倍率更稳：径向映射在球缘是非线性的，相关系数拟合会被
/// 亚像素压缩骗到 1.0 附近；边沿间距是直接的像素证据。
double _edgeMagnification(List<double> row, double inner, double outer) {
  final List<double> edges = <double>[];
  final int from = (_center - outer).ceil();
  final int to = (_center + outer).floor();
  for (int x = from; x < to; x++) {
    if ((x - _center).abs() < inner) continue;
    final double a = row[x];
    final double b = row[x + 1];
    if ((a < 0) == (b < 0)) continue;
    edges.add(x + (0 - a) / (b - a));
  }
  // 只统计同一侧的相邻边沿：跨过球心的那一跳不是条纹间距。
  double sum = 0;
  int count = 0;
  for (int i = 1; i < edges.length; i++) {
    if ((edges[i] - _center).sign != (edges[i - 1] - _center).sign) continue;
    sum += edges[i] - edges[i - 1];
    count++;
  }
  if (count == 0) return double.nan;
  return sum / count / _stripeHalf;
}

/// 球心两侧最近的两条边沿相距 16px（半个条纹周期），除以源半周期 = 球心倍率。
double _centerPeriodMagnification(List<double> row, double level) {
  double? left;
  double? right;
  for (int x = 1; x < _imageSize - 1; x++) {
    final double a = row[x] - level;
    final double b = row[x + 1] - level;
    if ((a < 0) == (b < 0)) continue;
    final double edge = x + (0 - a) / (b - a);
    if (edge <= _center) {
      if (left == null || edge > left) left = edge;
    } else if (right == null || edge < right) {
      right = edge;
    }
  }
  if (left == null || right == null) return double.nan;
  return (right - left) / _stripeHalf;
}

/// 水平线性渐变：value = [atValue] + (x − [atX]) × [slope]，两端钳到 0..255。
/// 平滑夹具用来测亚像素位移——硬边的量化台阶测不出这么小的量。
Future<ui.Image> _rampImage(
  double slope, {
  double atX = _center,
  double atValue = 128,
}) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  for (int x = 0; x < _imageSize; x++) {
    final int value = (atValue + (x - atX) * slope).round().clamp(0, 255);
    canvas.drawRect(
      Rect.fromLTWH(x.toDouble(), 0, 1, _imageSize.toDouble()),
      ui.Paint()..color = Color.fromARGB(255, value, value, value),
    );
  }
  return recorder.endRecording().toImage(_imageSize, _imageSize);
}

/// 黑底白块，竖直硬边在 [edgeX]。
Future<ui.Image> _hardEdgeImage(double edgeX) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, _imageSize.toDouble(), _imageSize.toDouble()),
    ui.Paint()..color = const Color(0xFF000000),
  );
  canvas.drawRect(
    Rect.fromLTWH(edgeX, 0, _imageSize - edgeX, _imageSize.toDouble()),
    ui.Paint()..color = const Color(0xFFFFFFFF),
  );
  return recorder.endRecording().toImage(_imageSize, _imageSize);
}

Future<ui.Image> _flatGrayImage(int value) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  final Color color = Color.fromARGB(255, value, value, value);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, _imageSize.toDouble(), _imageSize.toDouble()),
    ui.Paint()..color = color,
  );
  return recorder.endRecording().toImage(_imageSize, _imageSize);
}

/// 非对称夹具：黑底上两个白块，左上大块、右上小块。
/// 上下翻转、左右翻转、180° 旋转都会把它们移出原象限，可判定翻转类型。
Future<ui.Image> _asymmetricImage() async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, _imageSize.toDouble(), _imageSize.toDouble()),
    ui.Paint()..color = const Color(0xFF000000),
  );
  // 球心左上 40px：20×20，放大后中心约 (188,188)。
  canvas.drawRect(
    const Rect.fromLTWH(206, 206, 20, 20),
    ui.Paint()..color = const Color(0xFFFFFFFF),
  );
  // 球心右上 35/−25px：10×10，放大后中心约 (315.5,213.5)。
  canvas.drawRect(
    const Rect.fromLTWH(286, 226, 10, 10),
    ui.Paint()..color = const Color(0xFFFFFFFF),
  );
  return recorder.endRecording().toImage(_imageSize, _imageSize);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('着色器：球心 1.70、球缘 < 1.0、r>R 透明', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final ui.FragmentProgram program =
          await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
      final ui.Image background = await _stripeImage();
      final _LensImage lens =
          await _paintLens(program.fragmentShader(), background);
      background.dispose();
      final List<double> row = lens.chromaRow(_center.toInt());

      final double center = _edgeMagnification(row, 0, 0.30 * _lensRadius);
      final double mid =
          _edgeMagnification(row, 0.60 * _lensRadius, 0.80 * _lensRadius);
      final double rim =
          _edgeMagnification(row, 0.90 * _lensRadius, 0.995 * _lensRadius);
      debugPrint('ORB_LENS_SHADER center=${center.toStringAsFixed(4)} '
          'mid=${mid.toStringAsFixed(4)} rim=${rim.toStringAsFixed(4)}');

      expect(center, inInclusiveRange(_minCenter, _maxCenter),
          reason: '球心倍率应为 1.70（±5%）');
      expect(mid, lessThan(center), reason: '放大倍率必须沿半径单调不增');
      expect(rim, lessThan(1.0), reason: '球缘 M(1)=0.866，采样应当压缩');

      // r/R > 1 输出透明：取球心右侧 1.05R 处。
      final int outsideX = (_center + 1.05 * _lensRadius).round();
      final int centerY = _center.toInt();
      expect(lens.alphaAt(outsideX, centerY), 0, reason: '圆外必须完全透明');
      expect(lens.alphaAt(_center.toInt(), centerY), 255, reason: '球心必须是不透明采样');
    });
  });

  testWidgets('拖动拉伸：椭圆长轴沿拖动方向，整条轴不透明且倍率仍 1.70', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final ui.FragmentProgram program =
          await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
      final ui.Image background = await _stripeImage();
      final _LensImage straight = await _paintLens(
        program.fragmentShader(),
        background,
        stretch: _stretch,
      );
      final _LensImage rotated = await _paintLens(
        program.fragmentShader(),
        background,
        stretch: _stretch,
        angle: _angle,
      );
      background.dispose();

      final int centerY = _center.toInt();
      int transparent = 0;
      int scanned = 0;
      int transparentRotated = 0;
      int scannedRotated = 0;
      final double reach = 0.999 * _lensRadius * _stretch;
      for (double d = 0; d <= reach; d += 1) {
        scanned++;
        if (straight.alphaAt((_center + d).round(), centerY) != 255) {
          transparent++;
        }
        scannedRotated++;
        final int rx = (_center + d * math.cos(_angle)).round();
        final int ry = (_center + d * math.sin(_angle)).round();
        if (rotated.alphaAt(rx, ry) != 255) transparentRotated++;
      }
      debugPrint('ORB_LENS_STRETCH scanned=$scanned transparent=$transparent '
          'scannedRotated=$scannedRotated transparentRotated=$transparentRotated '
          'reach=${reach.toStringAsFixed(2)}');

      // 长轴端：0.999×(R×stretch) 内一粒透明像素都不许有（修补前 1.0R 外全透明）。
      expect(transparent, 0, reason: '拖动轴方向上不得出现透明像素');
      expect(transparentRotated, 0, reason: '旋转后的长轴方向同样不得透明');
      // 长轴外、短轴外都必须恢复透明：椭圆而不是圆。
      final double beyondMajor = 1.01 * _lensRadius * _stretch;
      expect(straight.alphaAt((_center + beyondMajor).round(), centerY), 0);
      expect(
          rotated.alphaAt(
            (_center + beyondMajor * math.cos(_angle)).round(),
            (_center + beyondMajor * math.sin(_angle)).round(),
          ),
          0);
      // 短轴（垂直于拖动方向）：R 以内不透明，1.01R 透明。
      final int minorIn = (_center + 0.99 * _lensRadius).round();
      final int minorOut = (_center + 1.01 * _lensRadius).round();
      expect(straight.alphaAt(_center.toInt(), minorIn), 255);
      expect(straight.alphaAt(_center.toInt(), minorOut), 0);
      final double perp = _angle + math.pi / 2;
      expect(
          rotated.alphaAt(
            (_center + 0.99 * _lensRadius * math.cos(perp)).round(),
            (_center + 0.99 * _lensRadius * math.sin(perp)).round(),
          ),
          255);
      expect(
          rotated.alphaAt(
            (_center + 1.01 * _lensRadius * math.cos(perp)).round(),
            (_center + 1.01 * _lensRadius * math.sin(perp)).round(),
          ),
          0);
      // 旋转举证：沿屏幕 y 轴、0.999×(R×stretch) 处应已落在椭圆外。
      expect(rotated.alphaAt(_center.toInt(), (_center + reach).round()), 0,
          reason: '椭圆必须随拖动角旋转，而不是固定沿 x 轴');

      // 该方向倍率仍为 1.70（±5%）。
      final double magnification = _edgeMagnification(
          straight.chromaRow(centerY), 0, 0.30 * _lensRadius);
      expect(magnification, inInclusiveRange(_minCenter, _maxCenter),
          reason: '拉伸后拖动轴方向倍率仍应为 1.70');
      debugPrint(
          'ORB_LENS_STRETCH_M magnification=${magnification.toStringAsFixed(4)}');
    });
  });

  testWidgets('色散：R/B 边沿采样位移 = Dispersion × r² × R',
      (WidgetTester tester) async {
    // 球缘色散强度是用户观感裁决（0.072 → 0.05）。期望值用字面量而不是
    // 常量：常量被误改时位移断言自己就会红，不会两边同时归零而假绿。
    const double expectedEdge = 0.05;
    expect(kFeedbackOrbLensDispersionEdge, expectedEdge,
        reason: '球缘色散强度的观感裁决值');
    await tester.runAsync(() async {
      final ui.FragmentProgram program =
          await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
      final int cy = _center.toInt();

      /// 硬边夹具：位移 ≥1px 时用阈值交点，直接读数不受采样量化影响。
      Future<double> hardEdgeShift(double targetR) async {
        final double sourceRadius = orbLensSourceOffset(targetR) * _lensRadius;
        final ui.Image background =
            await _hardEdgeImage(_center + sourceRadius);
        final _LensImage lens =
            await _paintLens(program.fragmentShader(), background);
        background.dispose();
        double crossing(List<double> row) {
          for (int x = _center.toInt() + 2;
              x < (_center + 0.995 * _lensRadius).floor();
              x++) {
            final double a = row[x] - 128;
            final double b = row[x + 1] - 128;
            if ((a < 0) == (b < 0)) continue;
            return x + (0 - a) / (b - a);
          }
          return double.nan;
        }

        double sourceAt(double x) =>
            orbLensSourceOffset((x - _center).abs() / _lensRadius) *
            _lensRadius;
        final double xR = crossing(lens.channelRow(cy, 0));
        final double xG = crossing(lens.channelRow(cy, 1));
        final double xB = crossing(lens.channelRow(cy, 2));
        final double total = sourceAt(xR) - sourceAt(xB);
        debugPrint('ORB_LENS_DISPERSION r=$targetR '
            'R:${xR.toStringAsFixed(2)} G:${xG.toStringAsFixed(2)} '
            'B:${xB.toStringAsFixed(2)} sourceShift=${total.toStringAsFixed(2)}');
        expect(xB, lessThan(xG), reason: 'B 向球缘采样 → 屏幕边沿更靠内');
        expect(xG, lessThan(xR), reason: 'R 向球心采样 → 屏幕边沿更靠外');
        return total;
      }

      /// 平滑渐变：通道均值差 / 渐变斜率就是 B 与 R 取样点在源坐标里的间距。
      ///
      /// 渐变定义在源坐标上且线性，两个通道各自偏移 ±位移后读到的值差
      /// 正好是「斜率 × 总位移」，与屏幕到源的放大无关。
      Future<double> rampShift(
        double targetR,
        double halfWidth,
        double slope, {
        double atX = _center,
      }) async {
        final ui.Image background = await _rampImage(slope, atX: atX);
        final _LensImage lens =
            await _paintLens(program.fragmentShader(), background);
        background.dispose();
        final int from =
            (_center + (targetR - halfWidth) * _lensRadius).round();
        final int to =
            (_center + (targetR + halfWidth) * _lensRadius).round();
        double mean(int channel) {
          double sum = 0;
          for (int x = from; x <= to; x++) {
            sum += lens.channelAt(x, cy, channel);
          }
          return sum / (to - from + 1);
        }

        final double total = (mean(2) - mean(0)) / slope;
        debugPrint('ORB_LENS_DISPERSION r=$targetR ramp '
            'window=[$from,$to] sourceShift=${total.toStringAsFixed(3)}');
        return total;
      }

      // 球缘的放大表导数约 7 源像素/屏幕像素，硬边交点只能分辨到 ±1 屏幕像素
      // （≈7 源像素），读不出 0.05R ≈ 9.6px；球缘改用平滑渐变（斜率 4，
      // 取样窗口落在渐变线性区中间，避开 0/255 钳制）。
      final double rim = await rampShift(0.98, 0.015, 4, atX: 456);
      final double outer = await hardEdgeShift(0.9);
      // 球心的位移只有 0.1px 量级：用一条覆盖 0.02R–0.18R 的渐变带，
      // 让足够多的取样相位参与平均，读数才不被纹理量化的单相位噪声左右。
      final double inner = await rampShift(0.1, 0.08, 2.0);

      double edgeAt(double r) => expectedEdge * r * r * _lensRadius;
      expect(rim, closeTo(edgeAt(0.98), 0.25 * edgeAt(0.98)),
          reason: 'r≈1 处 B−R 应约 0.05R（半径 200 约 10px）');
      expect(outer, closeTo(edgeAt(0.9), 0.25 * edgeAt(0.9)),
          reason: 'r≈0.9 处应约 0.041R');
      expect(inner, lessThan(0.3), reason: 'r≈0.1 处通道错位应可忽略');
    });
  });

  testWidgets('色散不改球心倍率、亮度与 alpha 剖面', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final ui.FragmentProgram program =
          await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
      final int cy = _center.toInt();

      final ui.Image stripes = await _stripeImage();
      final _LensImage off = await _paintLens(
        program.fragmentShader(),
        stripes,
        dispersion: 0,
      );
      final _LensImage on = await _paintLens(program.fragmentShader(), stripes);
      stripes.dispose();

      // 球心倍率：取球心两侧最近的两条边沿（整周期 32px），R/B 各自量一次。
      for (final int channel in <int>[0, 2]) {
        final double offM =
            _centerPeriodMagnification(off.channelRow(cy, channel), 135);
        final double onM =
            _centerPeriodMagnification(on.channelRow(cy, channel), 135);
        debugPrint('ORB_LENS_DISPERSION_MAG ch=$channel '
            'off=${offM.toStringAsFixed(4)} on=${onM.toStringAsFixed(4)}');
        expect((onM - offM).abs() / offM, lessThan(0.01),
            reason: '分通道采样不得改变球心倍率');
      }
      // 中心采样通道（G）逐像素不变。
      expect(on.channelRow(cy, 1), off.channelRow(cy, 1),
          reason: 'G 是中心采样，必须与改动前逐像素一致');

      // 亮度中性：纯灰 128 上球内平均亮度变化 < 2/255。
      final ui.Image gray = await _flatGrayImage(128);
      final _LensImage grayOff = await _paintLens(
        program.fragmentShader(),
        gray,
        dispersion: 0,
      );
      final _LensImage grayOn =
          await _paintLens(program.fragmentShader(), gray);
      gray.dispose();
      final double meanDelta = (grayOn.meanLuma(0, 0.9 * _lensRadius) -
              grayOff.meanLuma(0, 0.9 * _lensRadius))
          .abs();
      debugPrint(
          'ORB_LENS_DISPERSION_LUMA delta=${meanDelta.toStringAsFixed(4)}');
      expect(meanDelta, lessThan(2.0), reason: '纯灰背景球内平均亮度变化应 < 2/255');

      // alpha 剖面完全不变；圆外仍为 0。
      expect(on.alphaDiffCount(off), 0, reason: '色散不得改变 alpha');
      expect(grayOn.alphaDiffCount(grayOff), 0, reason: '色散不得改变 alpha');
      expect(on.alphaAt((_center + 1.05 * _lensRadius).round(), cy), 0,
          reason: '圆外必须仍然完全透明');
    });
  });

  group('着色器朝向', () {
    testWidgets('正立：非对称夹具放大后仍在上方/左侧', (WidgetTester tester) async {
      await tester.runAsync(() async {
        final ui.FragmentProgram program =
            await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
        final ui.Image background = await _asymmetricImage();
        final _LensImage lens =
            await _paintLens(program.fragmentShader(), background);
        background.dispose();

        ({double x, double y, int count}) bright(
          double cx,
          double cy,
          double half,
        ) {
          double sx = 0;
          double sy = 0;
          int n = 0;
          for (int y = (cy - half).round(); y <= (cy + half).round(); y++) {
            for (int x = (cx - half).round(); x <= (cx + half).round(); x++) {
              if (lens.alphaAt(x, y) == 0) continue;
              final double luma = 0.299 * lens.channelAt(x, y, 0) +
                  0.587 * lens.channelAt(x, y, 1) +
                  0.114 * lens.channelAt(x, y, 2);
              if (luma < 128) continue;
              sx += x + 0.5;
              sy += y + 0.5;
              n++;
            }
          }
          return (
            x: n == 0 ? double.nan : sx / n,
            y: n == 0 ? double.nan : sy / n,
            count: n,
          );
        }

        final ({double x, double y, int count}) upperLeft =
            bright(188, 188, 30);
        final ({double x, double y, int count}) upperRight =
            bright(315, 213, 25);
        debugPrint('ORB_LENS_ORIENTATION '
            'ul=(${upperLeft.x.toStringAsFixed(1)},'
            '${upperLeft.y.toStringAsFixed(1)}) n=${upperLeft.count} '
            'ur=(${upperRight.x.toStringAsFixed(1)},'
            '${upperRight.y.toStringAsFixed(1)}) n=${upperRight.count}');

        expect(upperLeft.count, greaterThan(0),
            reason: '左上白块放大后不见了：内容被翻转或错位');
        expect(upperLeft.x, lessThan(_center), reason: '左侧内容跑到右侧');
        expect(upperLeft.y, lessThan(_center), reason: '上方内容跑到下方：上下颠倒');
        expect(upperRight.count, greaterThan(0),
            reason: '右上白块放大后不见了：内容被翻转或错位');
        expect(upperRight.x, greaterThan(_center), reason: '右侧内容跑到左侧');
        expect(upperRight.y, lessThan(_center), reason: '上方内容跑到下方：上下颠倒');
        expect(upperLeft.count, greaterThan(upperRight.count),
            reason: '大小块被互换：180° 旋转或左右翻转');
      });
    });

    test('GLES 捕获纹理翻转只作用于采样 uv，且所有采样统一走 sampleLens', () {
      final String source = readComponentSource('shaders/orb_lens.frag');
      expect(RegExp(r'texture\(uBg').allMatches(source).length, 1,
          reason: '所有采样必须经 sampleLens，漏一处就会在 GLES 上颠倒');
      expect(RegExp(r'vec4 sampleLens\(vec2 imagePx\)').hasMatch(source), isTrue,
          reason: '缺少采样封装');
      expect(
          RegExp(r'#if defined\(IMPELLER_TARGET_OPENGLES\) && '
                  r'!defined\(IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED\)\s*\n'
                  r'\s*uv\.y = 1\.0 - uv\.y;')
              .hasMatch(source),
          isTrue,
          reason: 'Impeller OpenGL ES 的捕获纹理自下而上，采样 v 必须翻转；'
              '3.47 起由 IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED 关闭');
    });
  });

  group('径向放大表一致性', () {
    test('shader 的断点、系数、分段宽度与 kFeedbackOrbLensSampleR/M 一致', () {
      final String source = readComponentSource('shaders/orb_lens.frag');
      final List<double> breaks = <double>[
        for (final RegExpMatch match
            in RegExp(r'if \(t <= ([0-9.]+)\)').allMatches(source))
          double.parse(match.group(1)!),
      ];
      final List<RegExpMatch> mixes = RegExp(
        r'mix\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,',
      ).allMatches(source).toList();
      final List<double> coefficients = <double>[
        double.parse(mixes.first.group(1)!),
        for (final RegExpMatch match in mixes) double.parse(match.group(2)!),
      ];
      final List<double> widths = <double>[
        for (final RegExpMatch match in RegExp(
          r'mix\([^,]+,[^,]+,\s*(?:t\s*/\s*|\(t\s*-\s*[0-9.]+\s*\)\s*/\s*)([0-9.]+)\s*\)',
        ).allMatches(source))
          double.parse(match.group(1)!),
      ];

      expect(breaks, kFeedbackOrbLensSampleR.sublist(1, 6),
          reason: 'shader 断点与 Dart 表漂移');
      expect(coefficients, hasLength(kFeedbackOrbLensSampleM.length));
      for (int i = 0; i < coefficients.length; i++) {
        expect(coefficients[i], closeTo(kFeedbackOrbLensSampleM[i], 1e-9),
            reason: '第 $i 个放大系数与 Dart 表漂移');
      }
      final List<double> expectedWidths = <double>[
        for (int i = 1; i < kFeedbackOrbLensSampleR.length; i++)
          kFeedbackOrbLensSampleR[i] - kFeedbackOrbLensSampleR[i - 1],
      ];
      expect(widths, hasLength(expectedWidths.length), reason: '分段数不一致');
      for (int i = 0; i < widths.length; i++) {
        expect(widths[i], closeTo(expectedWidths[i], 1e-12),
            reason: '第 $i 段宽度与断点漂移');
      }
    });
  });

  group('着色器 uniform 接线', () {
    // 打包进 asset 的 .frag 是编译产物（IPLR 二进制），读不到声明；只能读源码。
    final String shaderSource = readComponentSource('shaders/orb_lens.frag');

    test('uniform 声明顺序与 orbLensUniformValues 的十一个槽位一一对应', () {
      final List<String> slots = <String>[
        for (final RegExpMatch match in RegExp(
          r'^\s*uniform\s+(vec2|float|sampler2D)\s+(\w+)\s*;',
          multiLine: true,
        ).allMatches(shaderSource))
          if (match.group(1) != 'sampler2D')
            for (int i = 0; i < (match.group(1) == 'vec2' ? 2 : 1); i++)
              match.group(2)!,
      ];
      expect(slots, <String>[
        'uImageSize',
        'uImageSize',
        'uOffset',
        'uOffset',
        'uScale',
        'uCenter',
        'uCenter',
        'uRadiusPx',
        'uStretch',
        'uAngle',
        'uDispersion',
      ]);
      expect(shaderSource, contains('uniform sampler2D uBg;'),
          reason: 'uBg 不占 float 槽位，由 setImageSampler 单独设置');
      expect(
        orbLensUniformValues(
          imageSize: const Size(1, 1),
          imageOffset: Offset.zero,
          pixelRatio: 1,
          center: Offset.zero,
          radiusPx: 1,
          stretch: 1,
          angle: 0,
          dispersion: 0,
        ),
        hasLength(slots.length),
      );
    });

    test('已知输入的十一个值按序落位', () {
      const double ratio = 2.5;
      const Offset offset = Offset(40, 20);
      const Offset center = Offset(28, 28);
      const double radius = 28;
      const double stretch = 1.04;
      const double angle = 0.75;
      final List<double> values = orbLensUniformValues(
        imageSize: const Size(800, 600),
        imageOffset: offset,
        pixelRatio: ratio,
        center: center,
        radiusPx: radius,
        stretch: stretch,
        angle: angle,
        dispersion: kFeedbackOrbLensDispersionEdge,
      );
      expect(values, hasLength(11));
      expect(values[0], 800);
      expect(values[1], 600);
      expect(values[2], offset.dx);
      expect(values[3], offset.dy);
      expect(values[4], ratio, reason: 'uScale 就是捕获像素比');
      expect(values[5], offset.dx + center.dx * ratio);
      expect(values[6], offset.dy + center.dy * ratio);
      expect(values[7], radius * ratio);
      expect(values[8], stretch);
      expect(values[9], angle);
      expect(values[10], kFeedbackOrbLensDispersionEdge);
    });

    test('色散常量落在索引 10', () {
      final List<double> values = orbLensUniformValues(
        imageSize: const Size(10, 10),
        imageOffset: Offset.zero,
        pixelRatio: 1,
        center: Offset.zero,
        radiusPx: 8,
        stretch: 1,
        angle: 0,
        dispersion: kFeedbackOrbLensDispersionEdge,
      );
      expect(values.indexOf(kFeedbackOrbLensDispersionEdge), 10);
    });

    test('painter 的 uniform 只经 orbLensUniformValues 写入', () {
      final String widgetSource = readComponentSource('lib/src/widget.dart');
      expect(widgetSource, contains('orbLensUniformValues('));
      expect(widgetSource,
          contains('dispersion: kFeedbackOrbLensDispersionEdge'),
          reason: 'painter 必须把色散常量交给统一顺序表');
      expect(RegExp(r'setFloat\(\s*\d+\s*,').hasMatch(widgetSource), isFalse,
          reason: '逐项下标写入会再次脱离顺序保护');
      expect(widgetSource, contains('setFloat(i, uniforms[i])'));
    });
  });

  group('组件接线', () {
    late FeedbackController controller;
    late http.Client client;

    setUp(() {
      controller = FeedbackController();
      client = captureMockClient();
      debugOrbLensGateDuration = const Duration(seconds: 1);
      debugOrbLensCaptureAttempts = 0;
      debugFailOrbLensCapture = false;
    });

    tearDown(() {
      debugFailOrbLensShader = false;
      debugFailOrbLensCapture = false;
      debugOrbLensGateDuration = const Duration(seconds: 1);
      controller.dispose();
      client.close();
    });

    Future<GlobalKey> pumpHost(WidgetTester tester, {Widget? child}) async {
      final GlobalKey host = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(400, 400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(RepaintBoundary(
        key: host,
        child: MaterialApp(
          home: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-lens-shader',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.off,
              // 球心落在 (200,200)，供坐标映射用例量像素。
              position: const Offset(172, 172),
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: client,
            child: SizedBox.expand(
              child: child ?? const ColoredBox(color: Color(0xFFC9C9C9)),
            ),
          ),
        ),
      ));
      await tester.pump();
      return host;
    }

    Future<void> waitForC(WidgetTester tester) async {
      for (int i = 0; i < 200; i++) {
        await tester.pump();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
        await tester.pump();
        if (find.byKey(_shaderLensKey).evaluate().isNotEmpty) return;
      }
      fail('C 路线未在超时内接管');
    }

    /// 拖动开始是一次合法触发；返回时 pan 仍按着，调用方负责取消。
    Future<TestGesture> startDrag(WidgetTester tester) async {
      final TestGesture gesture =
          await tester.startGesture(tester.getCenter(find.byKey(_lensKey)));
      await gesture.moveBy(const Offset(-20, -20));
      await tester.pump();
      return gesture;
    }

    testWidgets('首次可见后 C 接管；hidden 释放回退 A；一秒闸门内不再捕获',
        (WidgetTester tester) async {
      // 闸门拉到十分钟：整段序列内都不可能有第二次捕获，不依赖真实耗时。
      debugOrbLensGateDuration = const Duration(minutes: 10);
      await pumpHost(tester);
      expect(find.byKey(_lensKey), findsOneWidget);
      await waitForC(tester);
      expect(find.byKey(_shaderLensKey), findsOneWidget);
      expect(find.byType(BackdropFilter), findsNothing,
          reason: 'C 就绪后不再叠 A 的 backdrop 层');

      controller.open();
      await tester.pump();
      await tester.pump();
      expect(find.byKey(_shaderLensKey), findsNothing, reason: 'hidden 释放快照');
      expect(find.byType(BackdropFilter), findsNothing, reason: 'hidden 不渲染入口');

      controller.close();
      await tester.pump();
      await tester.pump();
      expect(find.byKey(_shaderLensKey), findsNothing,
          reason: '距上次捕获不足 1000ms，不得再次捕获');
      expect(find.byType(BackdropFilter), findsOneWidget, reason: '回退 A');

      // 闸门内拖动开始也不得触发第二次捕获。
      final TestGesture blocked = await startDrag(tester);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(_shaderLensKey), findsNothing,
          reason: '一秒闸门内的拖动触发必须被拦下');
      await blocked.cancel();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      // 把闸门放开（等价于等待一秒过期），避免依赖真实耗时。
      debugOrbLensGateDuration = Duration.zero;
      final TestGesture capture = await startDrag(tester);
      await waitForC(tester);
      expect(find.byKey(_shaderLensKey), findsOneWidget, reason: '拖动开始应重新捕获');
      await capture.cancel();
      await tester.pump();
    });

    testWidgets('C 路线坐标换算：球心 10px 外的暗线画到约 17px 处', (WidgetTester tester) async {
      final GlobalKey host =
          await pumpHost(tester, child: CustomPaint(painter: _LinePainter()));
      await waitForC(tester);
      expect(find.byKey(_shaderLensKey), findsOneWidget);

      final ui.Image image = (await tester.runAsync(() async {
        final RenderRepaintBoundary boundary =
            host.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        return boundary.toImage(pixelRatio: 2);
      }))!;
      final ByteData? raw = await tester.runAsync<ByteData?>(
          () => image.toByteData(format: ui.ImageByteFormat.rawRgba));
      final Uint8List rgba = raw!.buffer.asUint8List();
      final int width = image.width;
      image.dispose();

      double luma(int x, int y) {
        final int o = (y * width + x) * 4;
        return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      }

      // 球心 (200,200) 逻辑 → 400 设备像素；源暗线在 190 逻辑（-10px）。
      final int row = 400;
      double weightSum = 0;
      double momentX = 0;
      double darkest = 255;
      for (int x = 355; x <= 395; x++) {
        final double value = luma(x, row);
        darkest = value < darkest ? value : darkest;
        final double weight = (220 - value).clamp(0.0, 255.0);
        weightSum += weight;
        momentX += weight * x;
      }
      final double centroidX = weightSum > 0 ? momentX / weightSum : double.nan;
      debugPrint('ORB_LENS_MAP centroid=$centroidX '
          'luma=${darkest.toStringAsFixed(1)}');
      expect(darkest, lessThan(80), reason: '球内必须能看到放大后的暗线');
      // 源暗线中心在球心左侧 19 设备像素（10 逻辑像素 + 半线宽），
      // × 1.70 = 32.3 → 预计落在 367.7。
      expect(centroidX, closeTo(400 - 19 * 1.70, 3),
          reason: 'C 路线坐标换算错误：暗线未落在 1.70 倍处');
    });

    testWidgets('C 路线正立：球心左上方的方块仍画在左上方', (WidgetTester tester) async {
      final GlobalKey host = await pumpHost(
        tester,
        child: CustomPaint(painter: _CornerSquarePainter()),
      );
      await waitForC(tester);
      expect(find.byKey(_shaderLensKey), findsOneWidget);

      final ui.Image image = (await tester.runAsync(() async {
        final RenderRepaintBoundary boundary =
            host.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        return boundary.toImage(pixelRatio: 2);
      }))!;
      final ByteData? raw = await tester.runAsync<ByteData?>(
          () => image.toByteData(format: ui.ImageByteFormat.rawRgba));
      final Uint8List rgba = raw!.buffer.asUint8List();
      final int width = image.width;
      image.dispose();

      // 球心 (200,200) 逻辑 → 输出 (400,400)；只扫玻璃内（r<52），避开白环。
      const double center = 400;
      double sumX = 0;
      double sumY = 0;
      int count = 0;
      for (int y = 0; y < width; y++) {
        for (int x = 0; x < width; x++) {
          final double dx = x + 0.5 - center;
          final double dy = y + 0.5 - center;
          if (dx * dx + dy * dy > 52 * 52) continue;
          final int o = (y * width + x) * 4;
          final double luma =
              0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
          if (luma > 100) continue;
          sumX += x + 0.5;
          sumY += y + 0.5;
          count++;
        }
      }
      debugPrint('ORB_LENS_ORIENTATION_WIDGET count=$count '
          'cx=${(sumX / count).toStringAsFixed(1)} '
          'cy=${(sumY / count).toStringAsFixed(1)}');
      // 方块外缘被白色球环压住，只统计到内侧约一半面积。
      expect(count, greaterThan(50), reason: '玻璃内找不到放大后的黑块');
      expect(sumX / count, lessThan(center - 5), reason: '黑块跑到右侧：左右颠倒');
      expect(sumY / count, lessThan(center - 5), reason: '黑块跑到下方：上下颠倒');
    });

    testWidgets('拖动拉伸：C 路线把 orbStretch(pull) 与拖动角传进着色器',
        (WidgetTester tester) async {
      await pumpHost(tester);
      await waitForC(tester);
      expect(find.byKey(_shaderLensKey), findsOneWidget);

      final Finder body = find.byKey(const Key('feedback-orb-body'));
      final TestGesture gesture =
          await tester.startGesture(tester.getCenter(body));
      // 第一次位移只跨过 pan slop，后两次累计业务位移并让拉力饱和。
      await gesture.moveBy(const Offset(-40, 0));
      await gesture.moveBy(const Offset(-40, 0));
      await gesture.moveBy(const Offset(-40, 0));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 260));

      final OrbPainter orb = tester
          .widgetList<CustomPaint>(
              find.descendant(of: body, matching: find.byType(CustomPaint)))
          .map((CustomPaint paint) => paint.painter)
          .whereType<OrbPainter>()
          .single;
      expect(orb.pull, 1.0, reason: '拖动 100px 应让拉力饱和');
      expect(tester.getSize(body).width, closeTo(84, 0.01));
      expect(find.byKey(_shaderLensKey), findsOneWidget);

      final CustomPaint lensPaint = tester.widget<CustomPaint>(
        find.descendant(
            of: find.byKey(_shaderLensKey), matching: find.byType(CustomPaint)),
      );
      final dynamic lens = lensPaint.painter;
      debugPrint('ORB_LENS_STRETCH_WIRING pull=${orb.pull} '
          'stretch=${lens.stretch} angle=${lens.dragAngle}');
      expect(lens.stretch as double, closeTo(orbStretch(1.0), 1e-9),
          reason: '着色器必须收到 painter 同源的 orbStretch(pull)');
      expect(lens.dragAngle as double, closeTo(orb.dragAngle, 1e-9));

      await gesture.cancel();
      await tester.pump();
    });

    testWidgets('着色器失败注入：保持 A 放大，无异常冒泡', (WidgetTester tester) async {
      debugFailOrbLensShader = true;
      await pumpHost(tester);
      for (int i = 0; i < 40; i++) {
        await tester.pump();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
      }
      expect(tester.takeException(), isNull);
      expect(find.byKey(_lensKey), findsOneWidget);
      expect(find.byKey(_shaderLensKey), findsNothing);
      expect(find.byType(BackdropFilter), findsOneWidget,
          reason: '着色器不可用时必须保留 A 的 BackdropFilter 放大');
      expect(debugOrbLensCaptureAttempts, 0,
          reason: '着色器不可用是终态，不得为每次触发做整窗捕获');
    });

    testWidgets('捕获节奏：首次可见 1 次；闸门内 0 次；放开后一次拖动 1 次',
        (WidgetTester tester) async {
      debugOrbLensGateDuration = const Duration(minutes: 10);
      await pumpHost(tester);
      await waitForC(tester);
      expect(debugOrbLensCaptureAttempts, 1, reason: '首次可见只捕一次');

      final TestGesture blocked = await startDrag(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(debugOrbLensCaptureAttempts, 1, reason: '闸门内拖动不得再捕');
      await blocked.cancel();
      await tester.pump();

      debugOrbLensGateDuration = Duration.zero;
      final TestGesture allowed = await startDrag(tester);
      await tester.pump();
      for (int i = 0; i < 20; i++) {
        await tester.pump();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
      }
      expect(debugOrbLensCaptureAttempts, 2,
          reason: '闸门放开后，一次拖动开始只捕一次');
      await allowed.cancel();
      await tester.pump();
    });

    testWidgets('捕获失败：首次 + 两次重试，最多 3 次', (WidgetTester tester) async {
      debugFailOrbLensCapture = true;
      await pumpHost(tester);
      for (int i = 0; i < 60; i++) {
        await tester.pump();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
      }
      expect(tester.takeException(), isNull);
      expect(debugOrbLensCaptureAttempts, 3, reason: '首次 + 2 次重试后停手');
      expect(find.byKey(_shaderLensKey), findsNothing, reason: '失败期间保持 A');
      expect(find.byType(BackdropFilter), findsOneWidget);
    });
  });
}

/// 白底 + 球心左上 10 逻辑像素处的 4×4 黑色方块，用来判定透镜内容朝向。
class _CornerSquarePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.white);
    canvas.drawRect(
      const Rect.fromLTWH(186, 186, 8, 8),
      Paint()..color = Colors.black,
    );
  }

  @override
  bool shouldRepaint(_CornerSquarePainter oldDelegate) => false;
}

/// 白底 + 球心左侧 10 逻辑像素处 1 逻辑像素宽的黑线。
class _LinePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.white);
    canvas.drawRect(
      const Rect.fromLTWH(190, 0, 1, 400),
      Paint()..color = Colors.black,
    );
  }

  @override
  bool shouldRepaint(_LinePainter oldDelegate) => false;
}
