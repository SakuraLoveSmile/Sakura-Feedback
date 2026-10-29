import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

/// T-L3a：A 路线透镜（BackdropFilter + ImageFilter.matrix）的 widget 级验收。
///
/// 三条证据：
/// 1. 条纹周期：球心放大倍率 = 球外周期 × 1.70（±5%），同时反推放大中心
///    与球心对齐（≤1 逻辑像素）。
/// 2. 对比度保持率：沿用 spec 12.3.1 口径（`orb_contrast_test.dart`），
///    球内 std / 球外 std 与受控口径都 ≥ 0.85。
/// 3. 七态层存在矩阵：idle / hover / pressed / focus-visible / dragging /
///    releasing 有，hidden 无；reduced-motion 不关放大。
///
/// 像素证据走「挂真 widget → 整屏 toImage → 逐像素」路线；不是只断言
/// BackdropFilter 存在，因为层在而矩阵错的情况正是本卡要防的回归。
const double _logicalWidth = 800;
const double _logicalHeight = 600;
const double _pixelRatio = 2;
const double _orbCenterX = 400;
const double _orbCenterY = 300;
const double _radiusDev = 28 * _pixelRatio;
// 条纹周期 8 逻辑像素（4 深 4 浅），相位对齐球心，球内外同相位。
const double _stripePeriod = 8;
const double _minRetention = 0.85;

final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _body = find.byKey(const Key('feedback-orb-body'));
final Finder _lens = find.byKey(const Key('feedback-orb-lens'));

/// 竖条纹背景。相位以 [center] 为原点，保证球内外采样同一个周期。
class _StripesPainter extends CustomPainter {
  const _StripesPainter({
    required this.base,
    required this.stripe,
    required this.center,
  });

  final Color base;
  final Color stripe;
  final Offset center;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = base);
    final Paint paint = Paint()..color = stripe;
    for (int x = 0; x < size.width.ceil(); x++) {
      final double d = (x - center.dx) % _stripePeriod;
      if (d >= _stripePeriod / 2) continue;
      canvas.drawRect(Rect.fromLTWH(x.toDouble(), 0, 1, size.height), paint);
    }
  }

  @override
  bool shouldRepaint(_StripesPainter oldDelegate) =>
      oldDelegate.base != base ||
      oldDelegate.stripe != stripe ||
      oldDelegate.center != center;
}

class _Frame {
  const _Frame(this.width, this.height, this.rgba);

  final int width;
  final int height;
  final Uint8List rgba;

  int _offset(int x, int y) => (y * width + x) * 4;

  /// 色差通道 R − B：白壳、发光都是加性白光，不改变该通道；
  /// 条纹边沿因此不会被球体覆盖层糊掉。
  double chroma(int x, int y) {
    final int o = _offset(x, y);
    return (rgba[o] - rgba[o + 2]).toDouble();
  }

  double luma(int x, int y) {
    final int o = _offset(x, y);
    return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
}

/// 把条纹背景挂进真实 FeedbackWidget，返回整屏捕获用的 key。
Future<GlobalKey> _pumpHost(
  WidgetTester tester, {
  required FeedbackController controller,
  required http.Client client,
  required _StripesPainter stripes,
  bool showLauncher = true,
  bool reducedMotion = false,
  Brightness brightness = Brightness.light,
  Size surface = const Size(_logicalWidth, _logicalHeight),
}) async {
  final GlobalKey root = GlobalKey();
  await tester.binding.setSurfaceSize(surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(RepaintBoundary(
    key: root,
    child: MaterialApp(
      theme: ThemeData(brightness: brightness),
      home: Builder(
        builder: (BuildContext context) => MediaQuery(
          data:
              MediaQuery.of(context).copyWith(disableAnimations: reducedMotion),
          child: FeedbackWidget(
            config: FeedbackConfig(
              'https://svc.test',
              'com.example.orb-lens',
              launcherMode: FeedbackLauncherMode.orb,
              captureMode: FeedbackCaptureMode.off,
              showLauncher: showLauncher,
              position: const Offset(
                _logicalWidth / 2 - 28,
                _logicalHeight / 2 - 28,
              ),
            ),
            controller: controller,
            tokenStore: MemoryTokenStore('tok'),
            serverPrefStore: MemoryServerPrefStore(),
            httpClient: client,
            child: SizedBox.expand(
              child: CustomPaint(painter: stripes),
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
  return root;
}

Future<_Frame> _capture(WidgetTester tester, GlobalKey root) async {
  final ui.Image image = (await tester.runAsync(() async {
    final RenderRepaintBoundary boundary =
        root.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    return boundary.toImage(pixelRatio: _pixelRatio);
  }))!;
  final int width = image.width;
  final int height = image.height;
  final ByteData? raw = await tester.runAsync<ByteData?>(
      () => image.toByteData(format: ui.ImageByteFormat.rawRgba));
  image.dispose();
  return _Frame(width, height, raw!.buffer.asUint8List());
}

double _linearAt(List<double> values, double x) {
  final int i = x.floor();
  if (i < 0 || i >= values.length - 1) {
    return values[i.clamp(0, values.length - 1)];
  }
  final double f = x - i;
  return values[i] * (1 - f) + values[i + 1] * f;
}

double _pearson(List<double> a, List<double> b) {
  final double meanA = a.reduce((double x, double y) => x + y) / a.length;
  final double meanB = b.reduce((double x, double y) => x + y) / b.length;
  double num = 0;
  double denA = 0;
  double denB = 0;
  for (int i = 0; i < a.length; i++) {
    final double da = a[i] - meanA;
    final double db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA == 0 || denB == 0) return 0;
  return num / math.sqrt(denA * denB);
}

/// 在 [from, to] 行区间内，用「球内像素 vs 背景同点采样」的相关系数反推
/// 放大倍率 [m] 与放大中心 [p]。[background] 是无球帧的完整行。
double _correlationAt(List<double> inside, List<double> row, int from, int to,
    double m, double p, List<double> a, List<double> b) {
  a.clear();
  b.clear();
  for (int x = from; x <= to; x++) {
    final double src = p + (x - p) / m;
    if (src < 0 || src > row.length - 1.001) return 0;
    a.add(inside[x - from]);
    b.add(_linearAt(row, src));
  }
  return _pearson(a, b);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FeedbackController controller;
  late http.Client client;
  late FocusHighlightStrategy savedStrategy;

  setUp(() {
    controller = FeedbackController();
    client = captureMockClient();
    savedStrategy = FocusManager.instance.highlightStrategy;
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
  });

  tearDown(() {
    controller.dispose();
    client.close();
    FocusManager.instance.highlightStrategy = savedStrategy;
  });

  testWidgets('球心条纹周期 = 球外周期 × 1.70，放大中心与球心对齐 ≤1 逻辑像素',
      (WidgetTester tester) async {
    // 红蓝条纹：色差通道不受白壳 / 发光影响，边沿位置可直接反推。
    const _StripesPainter stripes = _StripesPainter(
      base: Color(0xFFC85050),
      stripe: Color(0xFF5050C8),
      center: Offset(_orbCenterX, _orbCenterY),
    );

    final GlobalKey withOrb = await _pumpHost(tester,
        controller: controller, client: client, stripes: stripes);
    expect(_lens, findsOneWidget, reason: 'idle 必须有透镜层');
    final _Frame lensed = await _capture(tester, withOrb);
    expect(tester.getCenter(_body), const Offset(_orbCenterX, _orbCenterY));

    final GlobalKey plain = await _pumpHost(
      tester,
      controller: controller,
      client: client,
      stripes: stripes,
      showLauncher: false,
    );
    expect(_orb, findsNothing);
    final _Frame background = await _capture(tester, plain);

    final int cy = (_orbCenterY * _pixelRatio).round();
    final int cx = (_orbCenterX * _pixelRatio).round();
    final List<double> insideRow = <double>[
      for (int x = 0; x < lensed.width; x++) lensed.chroma(x, cy)
    ];
    final List<double> bgRow = <double>[
      for (int x = 0; x < background.width; x++) background.chroma(x, cy)
    ];

    // 球外周期自检：逻辑 8 → 设备 16，边沿间隔 8。
    final List<int> outsideEdges = <int>[];
    for (int x = cx + (1.6 * _radiusDev).round();
        x < cx + (3.0 * _radiusDev).round();
        x++) {
      if ((bgRow[x] < 0) != (bgRow[x + 1] < 0)) outsideEdges.add(x);
    }
    expect(outsideEdges.length, greaterThan(4), reason: '球外条纹太少，夹具异常');
    final double outsidePeriod = (outsideEdges.last - outsideEdges.first) /
        (outsideEdges.length - 1) *
        2;
    expect(outsidePeriod, closeTo(_stripePeriod * _pixelRatio, 0.5),
        reason: '球外周期应为 16 设备像素（8 逻辑像素）');

    // 拟合窗口限制在 r ≤ 0.5R：球缘白环、扫光不进入证据区。
    final int from = (cx - 0.5 * _radiusDev).ceil();
    final int to = (cx + 0.5 * _radiusDev).floor();
    final List<double> inside = <double>[
      for (int x = from; x <= to; x++) insideRow[x]
    ];
    final List<double> a = <double>[];
    final List<double> b = <double>[];
    double bestM = 0;
    double bestP = 0;
    double best = -2;
    for (double p = cx - 6; p <= cx + 6; p += 0.5) {
      for (double m = 1.3; m <= 2.1; m += 0.005) {
        final double c = _correlationAt(inside, bgRow, from, to, m, p, a, b);
        if (c > best) {
          best = c;
          bestM = m;
          bestP = p;
        }
      }
    }
    final double atIdentity =
        _correlationAt(inside, bgRow, from, to, 1.0, cx.toDouble(), a, b);
    debugPrint('ORB_LENS period=${(outsidePeriod).toStringAsFixed(2)}dev '
        'm=${bestM.toStringAsFixed(4)} p=${bestP.toStringAsFixed(1)} '
        'corr=${best.toStringAsFixed(4)} corr@1.0=${atIdentity.toStringAsFixed(4)}');

    // 若透镜没生效（没有 backdrop 采样），最佳拟合会退回 m≈1.0。
    expect(best, greaterThan(atIdentity + 0.15),
        reason: '球内应与球心周围背景高度相关，而不是与球外原始相位相关');
    expect(bestM, closeTo(1.70, 1.70 * 0.05), reason: '球心条纹倍率应等于球外周期 × 1.70');
    expect(bestP, closeTo(cx.toDouble(), _pixelRatio),
        reason: '放大中心与球心对齐误差不得超过 1 逻辑像素');
  });

  for (final Brightness brightness in Brightness.values) {
    testWidgets('spec 12.3.1 ${brightness.name}：透镜下核心对比度保持率 ≥ 0.85',
        (WidgetTester tester) async {
      final (Color base, Color stripe) = brightness == Brightness.light
          ? (const Color(0xFFC9C9C9), const Color(0xFF303030))
          : (const Color(0xFF202020), const Color(0xFFD8D8D8));
      final _StripesPainter stripes = _StripesPainter(
        base: base,
        stripe: stripe,
        center: const Offset(_orbCenterX, _orbCenterY),
      );

      final GlobalKey withOrb = await _pumpHost(tester,
          controller: controller,
          client: client,
          stripes: stripes,
          brightness: brightness);
      expect(_lens, findsOneWidget);
      final _Frame lensed = await _capture(tester, withOrb);

      final GlobalKey plain = await _pumpHost(tester,
          controller: controller,
          client: client,
          stripes: stripes,
          showLauncher: false,
          brightness: brightness);
      final _Frame background = await _capture(tester, plain);

      final double cx = _orbCenterX * _pixelRatio;
      final double cy = _orbCenterY * _pixelRatio;
      final double bandHalf = 0.45 * _radiusDev;
      List<double> sample(_Frame frame, double inner, double outer) {
        final List<double> out = <double>[];
        for (int y = math.max(0, (cy - bandHalf).ceil());
            y <= math.min(frame.height - 1, (cy + bandHalf).floor());
            y++) {
          for (int x = 0; x < frame.width; x++) {
            final double dx = x + 0.5 - cx;
            final double dy = y + 0.5 - cy;
            final double r = math.sqrt(dx * dx + dy * dy);
            if (r < inner || r > outer) continue;
            out.add(frame.luma(x, y));
          }
        }
        return out;
      }

      final List<double> inside = sample(lensed, 0, 0.55 * _radiusDev);
      final List<double> outside =
          sample(lensed, 1.6 * _radiusDev, 3.2 * _radiusDev);
      final List<double> insidePlain = sample(background, 0, 0.55 * _radiusDev);
      final List<double> outsidePlain =
          sample(background, 1.6 * _radiusDev, 3.2 * _radiusDev);
      expect(inside.length, greaterThan(500), reason: '球内采样过少');
      expect(outside.length, greaterThan(5000), reason: '球外采样过少');

      double mean(List<double> values) =>
          values.reduce((double a, double b) => a + b) / values.length;
      double std(List<double> values) {
        final double m = mean(values);
        double sum = 0;
        for (final double v in values) {
          sum += (v - m) * (v - m);
        }
        return math.sqrt(sum / values.length);
      }

      final double fixtureRatio = std(insidePlain) / std(outsidePlain);
      final double specRetention = std(inside) / std(outside);
      final double controlled = std(inside) / std(insidePlain);
      debugPrint('ORB_LENS_CONTRAST ${brightness.name} '
          'specRetention=${specRetention.toStringAsFixed(4)} '
          'controlled=${controlled.toStringAsFixed(4)} '
          'fixtureRatio=${fixtureRatio.toStringAsFixed(4)} '
          'stdIn=${std(inside).toStringAsFixed(2)} '
          'stdOut=${std(outside).toStringAsFixed(2)} '
          'stdInPlain=${std(insidePlain).toStringAsFixed(2)} '
          'meanIn=${mean(inside).toStringAsFixed(2)} '
          'meanInPlain=${mean(insidePlain).toStringAsFixed(2)} '
          'nIn=${inside.length} nOut=${outside.length}');

      expect(fixtureRatio, closeTo(1.0, 0.05), reason: '条纹夹具自身不均匀');
      if (brightness == Brightness.light) {
        expect(mean(inside), greaterThanOrEqualTo(mean(insidePlain)),
            reason: '浅色主题球心比同位置背景更暗');
      }
      expect(specRetention, greaterThanOrEqualTo(_minRetention),
          reason: 'spec 12.3.1 口径保持率低于门槛');
      expect(controlled, greaterThanOrEqualTo(_minRetention),
          reason: '受控口径（同区域有球 / 无球）保持率低于门槛');
    });
  }

  testWidgets('七态透镜层存在矩阵：六态有、hidden 无，reduced-motion 不关放大',
      (WidgetTester tester) async {
    const _StripesPainter stripes = _StripesPainter(
      base: Color(0xFFC9C9C9),
      stripe: Color(0xFF303030),
      center: Offset(_orbCenterX, _orbCenterY),
    );
    await _pumpHost(tester,
        controller: controller, client: client, stripes: stripes);

    final List<String> seen = <String>[];
    void expectLens(String state, {required bool present}) {
      expect(_lens, present ? findsOneWidget : findsNothing, reason: state);
      if (present) seen.add(state);
    }

    expectLens('idle', present: true);

    final TestGesture mouse =
        await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    expectLens('hover', present: true);

    final TestGesture press =
        await tester.startGesture(tester.getCenter(_body));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 160));
    expectLens('pressed', present: true);

    // 首次位移只跨过 pan slop（DragStartBehavior.start），第二次才累计业务位移。
    await press.moveBy(const Offset(-40, -40));
    await press.moveBy(const Offset(-40, -40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 260));
    expect(tester.getSize(_body).width, closeTo(84, 0.01),
        reason: 'dragging 直径 84');
    expectLens('dragging', present: true);

    // 取消而不是抬起：抬起会冻结选区覆盖层，覆盖层期间按契约不挂透镜。
    await press.cancel();
    await mouse.moveTo(Offset.zero);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 55));
    expectLens('releasing', present: true);
    await tester.pump(const Duration(milliseconds: 500));

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(find.byKey(const Key('feedback-orb-focus-ring')), findsOneWidget);
    expectLens('focus-visible', present: true);

    controller.open();
    await tester.pump();
    await tester.pump();
    expect(_body, findsNothing, reason: '面板打开即 hidden');
    expectLens('hidden', present: false);
    expect(seen, <String>[
      'idle',
      'hover',
      'pressed',
      'dragging',
      'releasing',
      'focus-visible',
    ]);

    controller.close();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // reduced-motion 只关流动角，不关放大。
    await _pumpHost(tester,
        controller: controller,
        client: client,
        stripes: stripes,
        reducedMotion: true);
    expectLens('idle reduced-motion', present: true);
  });
}
