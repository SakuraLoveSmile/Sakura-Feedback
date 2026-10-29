import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
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

class _LensRow {
  const _LensRow(this.chroma, this.alpha);

  final List<double> chroma;
  final List<int> alpha;
}

/// 把着色器画满 512×512，返回过球心那一行的色差与 alpha。
Future<_LensRow> _paintLens(ui.FragmentShader shader, ui.Image bg) async {
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
  final int row = _center.toInt();
  return _LensRow(
    <double>[
      for (int x = 0; x < _imageSize; x++)
        (rgba[(row * _imageSize + x) * 4] -
                rgba[(row * _imageSize + x) * 4 + 2])
            .toDouble(),
    ],
    <int>[
      for (int x = 0; x < _imageSize; x++) rgba[(row * _imageSize + x) * 4 + 3],
    ],
  );
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('着色器：球心 1.70、球缘 < 1.0、r>R 透明', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final ui.FragmentProgram program =
          await ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
      final ui.Image background = await _stripeImage();
      final _LensRow row =
          await _paintLens(program.fragmentShader(), background);
      background.dispose();

      final double center =
          _edgeMagnification(row.chroma, 0, 0.30 * _lensRadius);
      final double mid = _edgeMagnification(
          row.chroma, 0.60 * _lensRadius, 0.80 * _lensRadius);
      final double rim = _edgeMagnification(
          row.chroma, 0.90 * _lensRadius, 0.995 * _lensRadius);
      debugPrint('ORB_LENS_SHADER center=${center.toStringAsFixed(4)} '
          'mid=${mid.toStringAsFixed(4)} rim=${rim.toStringAsFixed(4)}');

      expect(center, inInclusiveRange(_minCenter, _maxCenter),
          reason: '球心倍率应为 1.70（±5%）');
      expect(mid, lessThan(center), reason: '放大倍率必须沿半径单调不增');
      expect(rim, lessThan(1.0), reason: '球缘 M(1)=0.866，采样应当压缩');

      // r/R > 1 输出透明：取球心右侧 1.05R 处。
      final int outsideX = (_center + 1.05 * _lensRadius).round();
      expect(row.alpha[outsideX], 0, reason: '圆外必须完全透明');
      expect(row.alpha[_center.toInt()], 255, reason: '球心必须是不透明采样');
    });
  });

  group('组件接线', () {
    late FeedbackController controller;
    late http.Client client;

    setUp(() {
      controller = FeedbackController();
      client = captureMockClient();
    });

    tearDown(() {
      debugFailOrbLensShader = false;
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

    Future<void> realDelay(WidgetTester tester, int ms) async {
      await tester.runAsync(() async {
        await Future<void>.delayed(Duration(milliseconds: ms));
      });
      await tester.pump();
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

      // 闸门过期后的拖动开始：重新捕获一次，C 回来。
      await realDelay(tester, 1100);
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
    });
  });
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
