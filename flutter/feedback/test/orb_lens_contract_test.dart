import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/test_env.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'capture_test_utils.dart';

/// T-L7c：C 路线（生产默认：单次捕获 + `orb_lens.frag`）的常驻契约回归。
///
/// T-L7a 用仓库外临时用例量过三项，但删掉后 C 路线没有任何覆盖，而 C 才是
/// 生产默认。本文件把三项固化：
/// 1. spec 12.3.1 对比度保持率 ≥ 0.85（light / dark），**必须先等 C 接管**；
/// 2. 命中区 A == C：56 与 84 两档，盒内多点 / 盒外 0.7px / 焦点环带一致；
/// 3. Semantics 不被透镜层污染：A 与 C 的节点数、标签完全一致。
///
/// 确定性约束：
/// - 等 C 用有限次 `pump` + `runAsync(10ms)`，最多 2s，超时明确 fail；
/// - 不使用 `pumpAndSettle`（球体有常驻 ticker 的路径会让它挂起）；
/// - 每个用例先卸载上一棵树再挂新树：同类型 `FeedbackWidget` 会被原地
///   update，上一例的球体元素会带着旧状态留下，污染 hidden / 路线切换。
///
/// 夹具与测量方法沿用 `orb_lens_widget_test.dart`（条纹相位对齐球心）；
/// 不改动该文件与 `orb_lens_shader_test.dart` 的既有用例。
const double _logicalWidth = 800;
const double _logicalHeight = 600;
const double _pixelRatio = 2;
const double _orbCenterX = 400;
const double _orbCenterY = 300;
const double _radiusDev = 28 * _pixelRatio;
// 条纹周期 8 逻辑像素，相位以球心为原点，球内外同相位。
const double _stripePeriod = 8;
const double _minRetention = 0.85;
// C 先在首帧可见后捕获一次；2s 足够覆盖首帧 + 两帧重试窗口。
const int _cWaitIterations = 200;
const Duration _cWaitStep = Duration(milliseconds: 10);

final Finder _orb = find.byKey(const Key('feedback-orb'));
final Finder _body = find.byKey(const Key('feedback-orb-body'));
final Finder _lens = find.byKey(const Key('feedback-orb-lens'));
final Finder _shaderLens = find.byKey(const Key('feedback-orb-lens-shader'));

/// 竖条纹背景，相位以 [center] 为原点，保证球内外采样同一个周期。
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

  double luma(int x, int y) {
    final int o = (y * width + x) * 4;
    return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
}

Future<GlobalKey> _pumpHost(
  WidgetTester tester, {
  required FeedbackController controller,
  required http.Client client,
  required _StripesPainter stripes,
  bool showLauncher = true,
  Brightness brightness = Brightness.light,
}) async {
  final GlobalKey root = GlobalKey();
  await tester.binding.setSurfaceSize(
      const Size(_logicalWidth, _logicalHeight));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  // 卸载上一棵树：同类型 FeedbackWidget 会被原地 update，旧状态会残留。
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  await tester.pumpWidget(RepaintBoundary(
    key: root,
    child: MaterialApp(
      theme: ThemeData(brightness: brightness),
      home: FeedbackWidget(
        key: UniqueKey(),
        config: FeedbackConfig(
          'https://svc.test',
          'com.example.orb-lens-contract',
          launcherMode: FeedbackLauncherMode.orb,
          captureMode: FeedbackCaptureMode.off,
          showLauncher: showLauncher,
          position: const Offset(
            _orbCenterX - 28,
            _orbCenterY - 28,
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
  ));
  await tester.pump();
  return root;
}

/// 等 C 路线接管；超时直接失败——不允许「静默退回 A 仍算通过」。
Future<void> _waitForC(WidgetTester tester) async {
  for (int i = 0; i < _cWaitIterations; i++) {
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(_cWaitStep);
    });
    await tester.pump();
    if (_shaderLens.evaluate().isNotEmpty) return;
  }
  fail('C 路线未在 ${_cWaitIterations * _cWaitStep.inMilliseconds}ms 内接管：'
      '生产默认必须是捕获 + shader；着色器缺失或捕获失败时不得静默退回 A 后'
      '让本用例通过（请检查 debugFailOrbLensShader / 捕获链路）。');
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

/// spec 12.3.1：球心水平带 `|dy| < 0.45R`，比较 `r < 0.55R` 与
/// `1.6R–3.2R` 的亮度标准差；返回(保持率, 球内均值, 球外均值, 球内 std)。
(double, double, double, double) _retention(_Frame frame) {
  final double cx = _orbCenterX * _pixelRatio;
  final double cy = _orbCenterY * _pixelRatio;
  final double bandHalf = 0.45 * _radiusDev;
  List<double> sample(double inner, double outer) {
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

  final List<double> inside = sample(0, 0.55 * _radiusDev);
  final List<double> outside = sample(1.6 * _radiusDev, 3.2 * _radiusDev);
  expect(inside.length, greaterThan(500), reason: '球内采样过少');
  expect(outside.length, greaterThan(5000), reason: '球外采样过少');
  return (std(inside) / std(outside), mean(inside), mean(outside), std(inside));
}

/// 命中路径的稳定指纹：只取 target 的运行时类型，避免受绑定细节影响。
String _hitFingerprint(WidgetTester tester, Offset point) =>
    tester.hitTestOnBinding(point).path
        .map((HitTestEntry entry) => entry.target.runtimeType.toString())
        .join('>');

/// 该点是否命中了球体自己的手势盒（`feedback-orb` 的 RenderObject）。
bool _hitsOrb(WidgetTester tester, Offset point) {
  final RenderObject orb = tester.renderObject(_orb);
  return tester
      .hitTestOnBinding(point)
      .path
      .any((HitTestEntry entry) => identical(entry.target, orb));
}

/// Semantics 快照：从球体节点沿 `parent` 找到视图根，再深度优先遍历，
/// 记录节点数与全部标签。失败时抛出，便于区分「语义树为空」与「节点被改写」。
(List<String>, int) _semanticsSnapshot(WidgetTester tester) {
  SemanticsNode root = tester.semantics.find(_body);
  while (root.parent != null) {
    root = root.parent!;
  }
  final List<String> labels = <String>[];
  int count = 0;
  void visit(SemanticsNode node) {
    count++;
    if (node.label.isNotEmpty) labels.add(node.label);
    node.visitChildren((SemanticsNode child) {
      visit(child);
      return true;
    });
  }

  visit(root);
  return (labels, count);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FeedbackController controller;
  late http.Client client;

  setUp(() {
    // 默认走 C；路由由各用例显式声明，避免上一次的残留。
    debugDisableOrbLensCapture = false;
    debugFailOrbLensShader = false;
    controller = FeedbackController();
    client = captureMockClient();
  });

  tearDown(() {
    debugDisableOrbLensCapture = false;
    debugFailOrbLensShader = false;
    controller.dispose();
    client.close();
  });

  /*
   * 1) C 路线对比度保持率（spec 12.3.1）。
   *
   * 与 `orb_lens_widget_test.dart` 的 A 路线用例同口径，但必须真的等 C 接管：
   * 先断言 shader 透镜层存在且 A 的 BackdropFilter 已撤掉，再采样。
   */
  for (final Brightness brightness in Brightness.values) {
    testWidgets('T-L7c spec 12.3.1 C 路线 ${brightness.name}：核心对比度保持率 ≥ 0.85',
        (WidgetTester tester) async {
      final (Color base, Color stripe) = brightness == Brightness.light
          ? (const Color(0xFFC9C9C9), const Color(0xFF303030))
          : (const Color(0xFF202020), const Color(0xFFD8D8D8));
      final _StripesPainter themedStripes = _StripesPainter(
        base: base,
        stripe: stripe,
        center: const Offset(_orbCenterX, _orbCenterY),
      );

      final GlobalKey withOrb = await _pumpHost(
        tester,
        controller: controller,
        client: client,
        stripes: themedStripes,
        brightness: brightness,
      );
      expect(_lens, findsOneWidget, reason: 'idle 必须有透镜层');
      await _waitForC(tester);
      expect(_shaderLens, findsOneWidget, reason: 'C 路线应已接管');
      expect(find.byType(BackdropFilter), findsNothing,
          reason: 'C 就绪后不得再叠 A 的 BackdropFilter');
      final _Frame lensed = await _capture(tester, withOrb);
      expect(tester.getCenter(_body),
          const Offset(_orbCenterX, _orbCenterY),
          reason: '球心偏离会让带区采样失去意义');

      final GlobalKey plain = await _pumpHost(
        tester,
        controller: controller,
        client: client,
        stripes: themedStripes,
        brightness: brightness,
        showLauncher: false,
      );
      expect(_body, findsNothing, reason: '基线帧不得有球');
      final _Frame background = await _capture(tester, plain);

      final (double specRetention, double meanIn, double _, double stdIn) =
          _retention(lensed);
      final (double fixtureRatio, double meanInPlain, double _, double _) =
          _retention(background);
      debugPrint('T_L7C_CONTRAST ${brightness.name} '
          'specRetention=${specRetention.toStringAsFixed(4)} '
          'fixtureRatio=${fixtureRatio.toStringAsFixed(4)} '
          'stdIn=${stdIn.toStringAsFixed(2)} '
          'meanIn=${meanIn.toStringAsFixed(2)} '
          'meanInPlain=${meanInPlain.toStringAsFixed(2)}');

      expect(fixtureRatio, closeTo(1.0, 0.05), reason: '条纹夹具自身不均匀');
      if (brightness == Brightness.light) {
        expect(meanIn, greaterThanOrEqualTo(meanInPlain),
            reason: '浅色主题球心不得比同位置背景更暗（spec 12.3）');
      }
      expect(specRetention, greaterThanOrEqualTo(_minRetention),
          reason: 'C 路线 spec 12.3.1 保持率低于门槛');
    });
  }

  /*
   * 2) 命中区 A == C（56 / 84）。
   *
   * 命中盒是 GestureDetector（`feedback-orb`），拖动时它停在停靠位、不随视觉
   * 平移；这里比较两条路线在同一批点上的命中路径指纹，并断言盒尺寸。
   */
  for (final bool dragging in <bool>[false, true]) {
    final double expectedBox = dragging ? 84 : 56;
    testWidgets('T-L7c 命中区 ${expectedBox.toInt()}：A 与 C 完全一致',
        (WidgetTester tester) async {
      Future<(Rect, Map<String, String>, Map<String, bool>)> sample(
          {required bool routeC}) async {
        debugDisableOrbLensCapture = !routeC;
        await _pumpHost(tester,
            controller: FeedbackController(),
            client: captureMockClient(),
            stripes: const _StripesPainter(
              base: Color(0xFFC9C9C9),
              stripe: Color(0xFF303030),
              center: Offset(_orbCenterX, _orbCenterY),
            ));
        if (routeC) {
          await _waitForC(tester);
          expect(_shaderLens, findsOneWidget);
        } else {
          expect(find.byType(BackdropFilter), findsOneWidget);
        }

        TestGesture? gesture;
        if (dragging) {
          gesture = await tester.startGesture(tester.getCenter(_orb));
          // 第一次位移只跨过 Flutter pan slop（DragStartBehavior.start），
          // 第二次才累计业务位移——与 orb_drag_test / 透镜七态用例同口径。
          await gesture.moveBy(const Offset(-40, -40));
          await tester.pump();
          await gesture.moveBy(const Offset(-40, -40));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.getSize(_orb).width, closeTo(84, 0.01),
              reason: 'dragging 时应为 84');
        } else {
          expect(tester.getSize(_orb).width, closeTo(56, 0.01),
              reason: 'idle 时应为 56');
        }

        final Rect box = tester.getRect(_orb);
        final double half = box.width / 2;
        final Offset center = box.center;
        final double ringRadius = half + 3; // 焦点环带：球沿外 2px 间隙起
        final Map<String, Offset> probes = <String, Offset>{
          'center': center,
          'left': center + Offset(-half + 2, 0),
          'right': center + Offset(half - 2, 0),
          'top': center + Offset(0, -half + 2),
          'bottom': center + Offset(0, half - 2),
          'cornerInside': center + Offset(half - 0.5, half - 0.5),
          // 盒外 0.7px：矩形命中区之外，任何新增热区都会被这条抓住。
          'outside07': box.bottomRight + const Offset(0.7, 0.7),
          // 焦点环带（r = R + 3）：环层是 IgnorePointer，不得扩大命中。
          'ringBand': center + Offset(0, ringRadius),
        };
        final Map<String, String> points = <String, String>{
          for (final MapEntry<String, Offset> entry in probes.entries)
            entry.key: _hitFingerprint(tester, entry.value),
        };
        final Map<String, bool> hitsOrb = <String, bool>{
          for (final MapEntry<String, Offset> entry in probes.entries)
            entry.key: _hitsOrb(tester, entry.value),
        };

        if (gesture != null) {
          await gesture.cancel();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 500));
        }
        return (box, points, hitsOrb);
      }

      final (Rect aBox, Map<String, String> aHits, Map<String, bool> aOrbHits) =
          await sample(routeC: false);
      final (Rect cBox, Map<String, String> cHits, Map<String, bool> cOrbHits) =
          await sample(routeC: true);
      debugPrint('T_L7C_HIT box=${expectedBox.toInt()} '
          'a=${aBox.size} c=${cBox.size} points=${aHits.length} '
          'orbHits=$aOrbHits');
      expect(cBox.size, aBox.size, reason: 'A/C 的命中盒几何必须一致');
      expect(aBox.width, closeTo(expectedBox, 0.01));
      expect(aBox.height, closeTo(expectedBox, 0.01));
      for (final String key in aHits.keys) {
        expect(cHits[key], aHits[key],
            reason: '命中路径在 $key 处 A/C 不一致（命中区被透镜层改变）');
        expect(cOrbHits[key], aOrbHits[key],
            reason: '是否命中球体在 $key 处 A/C 不一致');
      }
      for (final String key in <String>[
        'center',
        'left',
        'right',
        'top',
        'bottom',
        'cornerInside',
      ]) {
        expect(aOrbHits[key], isTrue, reason: '$key 应命中球体');
      }
      // 盒外 0.7px 与焦点环带都不得命中球体自身的手势盒。
      expect(aOrbHits['outside07'], isFalse,
          reason: '${expectedBox.toInt()} 盒外 0.7px 不应命中球体');
      expect(aOrbHits['ringBand'], isFalse,
          reason: '焦点环带不应命中球体（环层为 IgnorePointer）');
    });
  }

  /*
   * 3) Semantics 不被透镜层污染。
   *
   * 透镜层（A 的 BackdropFilter / C 的 shader CustomPaint）都包在
   * IgnorePointer 里；这里在真实树下比较 A/C 的节点数与标签序列。
   */
  testWidgets('T-L7c Semantics：A 与 C 的节点数与标签完全一致',
      (WidgetTester tester) async {
    Future<(List<String>, int)> sample({required bool routeC}) async {
      debugDisableOrbLensCapture = !routeC;
      await _pumpHost(tester,
          controller: FeedbackController(),
          client: captureMockClient(),
          stripes: const _StripesPainter(
            base: Color(0xFFC9C9C9),
            stripe: Color(0xFF303030),
            center: Offset(_orbCenterX, _orbCenterY),
          ));
      if (routeC) {
        await _waitForC(tester);
        expect(_shaderLens, findsOneWidget);
      }
      // SemanticsHandle 必须在用例体内 dispose：放到 tearDown 会在
      // 测试框架的 end-of-test 校验之后，触发「handle 未释放」。
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pump();
      final (List<String>, int) snapshot = _semanticsSnapshot(tester);
      handle.dispose();
      return snapshot;
    }

    final (List<String> aLabels, int aCount) = await sample(routeC: false);
    final (List<String> cLabels, int cCount) = await sample(routeC: true);
    debugPrint('T_L7C_SEMANTICS a=$aCount c=$cCount labels=$aLabels');

    expect(aCount, greaterThan(0), reason: '场景应有 Semantics 节点');
    expect(cCount, aCount, reason: 'C 路线不得新增/删除 Semantics 节点');
    expect(cLabels, aLabels, reason: 'C 路线不得改写 Semantics 标签');
    expect(cLabels.where((String label) => label == '灵感球').length, 1,
        reason: '球入口应恰好有一个「灵感球」语义节点');
  });
}
