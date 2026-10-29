import 'dart:math' as math;
import 'dart:ui' show Brightness, Color, ImageFilter, Offset, TileMode;

import 'package:flutter/animation.dart' show Cubic, Curves;
import 'package:flutter/painting.dart';
import 'package:flutter/rendering.dart' show CustomPainter;

/// 灵感球静止时的基础直径，单位为逻辑像素。
const double kFeedbackOrbIdleDiameter = 56.0;

/// 灵感球拖动时的基础直径，单位为逻辑像素。
const double kFeedbackOrbDraggingDiameter = 84.0;

/// 拖动直径相对于静止直径的比例。
const double kFeedbackOrbDragScale = 1.5;

/// 沿拖动方向的最大额外拉伸比例。
const double kFeedbackOrbDragStretchMax = 0.04;

/// 悬停状态的视觉缩放比例。
const double kFeedbackOrbHoverScale = 1.04;

/// 按压状态的视觉缩放比例。
const double kFeedbackOrbPressedScale = 0.94;

/// 尺寸与悬停状态的过渡时长。
const Duration kFeedbackOrbSizeDuration = Duration(milliseconds: 220);

/// 状态缩放的过渡曲线，对齐 Web 的 --fb-orb-state-easing。
const Cubic kFeedbackOrbStateCurve = Cubic(0.16, 1.0, 0.3, 1.0);

/// 按压状态的进入与退出时长。
const Duration kFeedbackOrbPressDuration = Duration(milliseconds: 140);

/// 松手后视觉复位的回弹时长。
const Duration kFeedbackOrbReleaseDuration = Duration(milliseconds: 460);

/// 松手回弹的三次贝塞尔曲线，允许越过目标值。
const Cubic kFeedbackOrbReleaseCurve = Cubic(0.2, 1.35, 0.32, 1.0);

/// 按压状态的缓出曲线。
const Cubic kFeedbackOrbPressCurve = Curves.easeOut;

/// 白色扫光完成一周的时长。
const Duration kFeedbackOrbSweepDuration = Duration(seconds: 10);

/// 白色扫光弧带的角宽，单位为弧度。
const double kFeedbackOrbSweepArc = 40 * math.pi / 180;

/// 白色扫光的峰值透明度。
const double kFeedbackOrbSweepWhiteAlpha = 0.80;

/// 呼吸完成一个周期的时长。
const Duration kFeedbackOrbBreathDuration = Duration(milliseconds: 5400);

/// 呼吸峰值时的视觉缩放比例。
const double kFeedbackOrbBreathScaleMax = 1.02;

/// 呼吸峰值时白色外发光的相对强度增益。
const double kFeedbackOrbBreathBloomGain = 0.08;

/// 进入拖动状态所需超过的累计位移，单位为逻辑像素。
const double kFeedbackOrbDragThreshold = 8.0;

/// 拖动拉力达到饱和的距离，单位为逻辑像素。
const double kFeedbackOrbPullDistance = 80.0;

/// 色散光晕的最大反向位移，单位为逻辑像素。
const double kFeedbackOrbGlowCounterTravel = 4.0;

/// 白色外发光的内缩量，负值表示向外扩展。
const double kFeedbackOrbBloomInset = -3.0;

/// 白色外发光的模糊半径，单位为逻辑像素。
const double kFeedbackOrbBloomBlur = 4.0;

/// 色散光晕的内缩量，负值表示向外扩展。
const double kFeedbackOrbGlowInset = -14.0;

/// 色散光晕的模糊半径，单位为逻辑像素。
const double kFeedbackOrbGlowBlur = 8.0;

/// 核心背景模糊的预留令牌，不表示本模块启用背景模糊。
const double kFeedbackOrbCoreBackdropSigma = 3.0;

/// 键盘焦点环的宽度，单位为逻辑像素。
const double kFeedbackOrbFocusWidth = 2.0;

/// 键盘焦点环的外偏移，单位为逻辑像素。
const double kFeedbackOrbFocusOffset = 2.0;

/// 灵感球的浅色与深色主题令牌，不承担绘制或状态管理。
class OrbPalette {
  /// 构造一组不可变的主题令牌。
  const OrbPalette({
    required this.bloomWhiteAlpha,
    required this.warm,
    required this.cyan,
    required this.edge,
    required this.sweepWhite,
  });

  /// 白色外发光的基础透明度。
  final double bloomWhiteAlpha;

  /// 暖侧色散颜色。
  final Color warm;

  /// 冷侧色散颜色。
  final Color cyan;

  /// 主白环边缘颜色。
  final Color edge;

  /// 白色扫光的峰值颜色。
  final Color sweepWhite;

  /// 浅色主题令牌，颜色保留浮点透明度。
  static const OrbPalette light = OrbPalette(
    bloomWhiteAlpha: 0.45,
    warm: Color.fromRGBO(255, 190, 120, 0.58),
    cyan: Color.fromRGBO(120, 200, 255, 0.70),
    edge: Color.fromRGBO(255, 255, 255, 0.95),
    sweepWhite: Color.fromRGBO(255, 255, 255, 0.80),
  );

  /// 深色主题令牌，色散颜色独立于浅色主题。
  static const OrbPalette dark = OrbPalette(
    bloomWhiteAlpha: 0.55,
    warm: Color.fromRGBO(200, 24, 0, 0.43),
    cyan: Color.fromRGBO(0, 76, 255, 0.33),
    edge: Color.fromRGBO(255, 255, 255, 0.85),
    sweepWhite: Color.fromRGBO(255, 255, 255, 0.80),
  );

  /// 按亮度返回共享的浅色或深色常量，不提供命名构造函数。
  static OrbPalette of(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;
}

/// 将十秒扫光相位映射为五点四秒周期的连续呼吸值，范围为零到一。
double orbBreath(double flow) =>
    0.5 - 0.5 * math.cos(flow * 2 * math.pi * (10 / 5.4));

/// 按累计拖动距离计算拉力，八十逻辑像素及以上饱和为一。
double orbPull(Offset offset) =>
    math.min(1.0, offset.distance / kFeedbackOrbPullDistance);

/// 返回屏幕坐标系中的拖动方向弧度，零位移返回零。
double orbDragAngle(Offset offset) =>
    offset.distance == 0.0 ? 0.0 : math.atan2(offset.dy, offset.dx);

/// 将零到一的拉力映射为沿拖动方向的一到一点零四倍拉伸。
double orbStretch(double pull) => 1.0 + kFeedbackOrbDragStretchMax * pull;

/// 计算与拖动方向相反的光晕位移，饱和拉力时位移长度为四逻辑像素。
Offset orbGlowOffset(double pull, double angle) {
  final double travel = -kFeedbackOrbGlowCounterTravel * pull;
  return Offset(travel * math.cos(angle), travel * math.sin(angle));
}

class OrbPainter extends CustomPainter {
  const OrbPainter({
    required this.flow,
    required this.breath,
    required this.breathWeight,
    required this.stateScale,
    required this.dragAngle,
    required this.pull,
    required this.glowOffset,
    required this.brightness,
    this.dispersionOpacity = 1.0,
  });

  final double flow;
  final double breath;
  final double breathWeight;
  final double stateScale;
  final double dragAngle;
  final double pull;
  final Offset glowOffset;
  final Brightness brightness;
  final double dispersionOpacity;

  @override
  void paint(Canvas canvas, Size size) {
    final OrbPalette palette = OrbPalette.of(brightness);
    final double unit = size.shortestSide / kFeedbackOrbIdleDiameter;
    final double breathFactor = 1.0 + 0.02 * breath * breathWeight;
    final double scale = unit * stateScale * breathFactor;
    final Offset center = size.center(Offset.zero);
    const double radius = kFeedbackOrbIdleDiameter / 2;
    const Color white0 = Color.fromRGBO(255, 255, 255, 0);
    const Color black0 = Color.fromRGBO(0, 0, 0, 0);
    const Color black = Color.fromRGBO(0, 0, 0, 1);

    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(dragAngle);
    canvas.scale(orbStretch(pull), 1.0);
    canvas.rotate(-dragAngle);
    canvas.scale(scale);

    final Rect bloomRect = Rect.fromCircle(
      center: Offset.zero,
      radius: radius - kFeedbackOrbBloomInset,
    );
    final double bloomAlpha =
        palette.bloomWhiteAlpha * (1.0 + kFeedbackOrbBreathBloomGain * breath);
    canvas.saveLayer(
      bloomRect,
      Paint()
        ..imageFilter = ImageFilter.blur(
          sigmaX: kFeedbackOrbBloomBlur,
          sigmaY: kFeedbackOrbBloomBlur,
          tileMode: TileMode.decal,
        ),
    );
    canvas.drawCircle(
      Offset.zero,
      bloomRect.width / 2,
      Paint()
        ..shader = RadialGradient(
          colors: <Color>[
            white0,
            white0,
            Color.fromRGBO(255, 255, 255, bloomAlpha * 0.58),
            Color.fromRGBO(255, 255, 255, bloomAlpha),
            white0,
          ],
          stops: const <double>[0, 0.78, 0.88, 0.96, 1.0],
        ).createShader(bloomRect),
    );
    canvas.restore();

    final Rect glowRect = Rect.fromCircle(
      center: Offset.zero,
      radius: radius - kFeedbackOrbGlowInset,
    );
    const double glowStart = 307.5 * math.pi / 180;
    canvas.save();
    canvas.translate(glowOffset.dx, glowOffset.dy);
    canvas.saveLayer(
      glowRect,
      Paint()
        ..color = const Color.fromRGBO(255, 255, 255, 1.0)
            .withValues(alpha: dispersionOpacity),
    );
    canvas.saveLayer(glowRect, Paint());
    canvas.saveLayer(
      glowRect,
      Paint()
        ..imageFilter = ImageFilter.blur(
          sigmaX: kFeedbackOrbGlowBlur,
          sigmaY: kFeedbackOrbGlowBlur,
          tileMode: TileMode.decal,
        ),
    );
    canvas.drawCircle(
      Offset.zero,
      glowRect.width / 2,
      Paint()
        ..shader = SweepGradient(
          startAngle: 0,
          endAngle: 2 * math.pi,
          // Sweep angles outside one turn clamp instead of wrapping in Flutter.
          transform: const GradientRotation(glowStart),
          stops: const <double>[
            0,
            97.5 / 360,
            180 / 360,
            180 / 360,
            262.5 / 360,
            1.0,
          ],
          colors: <Color>[
            palette.warm.withValues(alpha: 0),
            palette.warm,
            palette.warm.withValues(alpha: 0),
            palette.cyan.withValues(alpha: 0),
            palette.cyan,
            palette.cyan.withValues(alpha: 0),
          ],
        ).createShader(glowRect),
    );
    canvas.restore();
    // Cover the layer bounds so dstIn also clears pixels outside the mask circle.
    canvas.drawRect(
      glowRect,
      Paint()
        ..blendMode = BlendMode.dstIn
        ..shader = const RadialGradient(
          stops: <double>[0, 0.633, 0.693, 0.754, 0.834, 0.95, 1.0],
          colors: <Color>[
            black0,
            black0,
            black,
            black,
            Color.fromRGBO(0, 0, 0, 0.55),
            Color.fromRGBO(0, 0, 0, 0.06),
            black0,
          ],
        ).createShader(glowRect),
    );
    canvas.restore();
    canvas.restore();
    canvas.restore();

    final Rect coreRect = Rect.fromCircle(center: Offset.zero, radius: radius);
    final double rotation = 2 * math.pi * flow;
    canvas.saveLayer(coreRect, Paint());
    canvas.drawCircle(
      Offset.zero,
      radius,
      Paint()
        ..shader = SweepGradient(
          startAngle: 0,
          endAngle: kFeedbackOrbSweepArc,
          transform: GradientRotation(rotation - kFeedbackOrbSweepArc / 2),
          stops: const <double>[0, 0.5, 1],
          colors: <Color>[white0, palette.sweepWhite, white0],
        ).createShader(coreRect),
    );
    canvas.drawRect(
      coreRect,
      Paint()
        ..blendMode = BlendMode.dstIn
        ..shader = const RadialGradient(
          stops: <double>[0, 0.82, 0.88, 0.99, 1.0],
          colors: <Color>[black0, black0, black, black, black0],
        ).createShader(coreRect),
    );
    canvas.restore();

    canvas.drawCircle(
      Offset.zero,
      radius,
      Paint()
        ..shader = const RadialGradient(
          stops: <double>[
            0,
            0.26,
            0.44,
            0.53,
            0.62,
            0.70,
            0.75,
            0.79,
            0.84,
            0.88,
            0.92,
            0.95,
            1.0,
          ],
          colors: <Color>[
            white0,
            Color.fromRGBO(255, 255, 255, 0.11),
            Color.fromRGBO(255, 255, 255, 0.09),
            Color.fromRGBO(255, 255, 255, 0.17),
            Color.fromRGBO(255, 255, 255, 0.22),
            Color.fromRGBO(255, 255, 255, 0.35),
            Color.fromRGBO(255, 255, 255, 0.43),
            Color.fromRGBO(255, 255, 255, 0.54),
            Color.fromRGBO(255, 255, 255, 0.67),
            Color.fromRGBO(255, 255, 255, 0.81),
            Color.fromRGBO(255, 255, 255, 0.94),
            Color.fromRGBO(255, 255, 255, 0.98),
            Color.fromRGBO(255, 255, 255, 0.98),
          ],
          tileMode: TileMode.clamp,
        ).createShader(coreRect),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(OrbPainter oldDelegate) =>
      oldDelegate.flow != flow ||
      oldDelegate.breath != breath ||
      oldDelegate.breathWeight != breathWeight ||
      oldDelegate.stateScale != stateScale ||
      oldDelegate.dragAngle != dragAngle ||
      oldDelegate.pull != pull ||
      oldDelegate.glowOffset != glowOffset ||
      oldDelegate.brightness != brightness ||
      oldDelegate.dispersionOpacity != dispersionOpacity;
}

/// 面板关闭、灵感球模式、入口可见且未减少动态效果时运行流动动画。
/// hidden 包含捕获遮挡：选区覆盖层全屏遮挡时同样停止。
bool orbShouldRunFlow({
  required bool open,
  required bool orbMode,
  required bool showLauncher,
  required bool reducedMotion,
  required bool occluded,
}) =>
    !open && orbMode && showLauncher && !reducedMotion && !occluded;

/// 透镜中心处的径向放大倍数。
const double kFeedbackOrbLensCenterScale = 1.70;

/// 透镜球缘处的径向放大倍数。
const double kFeedbackOrbLensEdgeScale = 0.866;

/// 滚动角随累计行进距离增长的因子。
const double kFeedbackOrbRollFactor = 1.0;

/// 透镜径向放大表的采样点，取值为归一化半径 r/R，升序排列。
const List<double> kFeedbackOrbLensSampleR = <double>[
  0.00,
  0.25,
  0.50,
  0.70,
  0.85,
  0.95,
  1.00,
];

/// 与 [kFeedbackOrbLensSampleR] 一一对应的放大倍数采样点。
const List<double> kFeedbackOrbLensSampleM = <double>[
  1.700,
  1.698,
  1.671,
  1.577,
  1.401,
  1.173,
  0.866,
];

/// 按归一化半径返回透镜放大倍数；越界先钳制到零到一，再在表内分段线性插值。
double orbLensMagnification(double r) {
  final double t = r.clamp(0.0, 1.0);
  for (int i = 1; i < kFeedbackOrbLensSampleR.length; i++) {
    final double upper = kFeedbackOrbLensSampleR[i];
    if (t <= upper) {
      final double lower = kFeedbackOrbLensSampleR[i - 1];
      final double fraction = (t - lower) / (upper - lower);
      return kFeedbackOrbLensSampleM[i - 1] +
          (kFeedbackOrbLensSampleM[i] - kFeedbackOrbLensSampleM[i - 1]) *
              fraction;
    }
  }
  return kFeedbackOrbLensSampleM.last;
}

/// 返回球内半径 r 对应的源点半径 r / M(r)，即透镜取样位置的相对半径。
double orbLensSourceOffset(double r) {
  final double t = r.clamp(0.0, 1.0);
  if (t == 0.0) {
    return 0.0;
  }
  return t / orbLensMagnification(t);
}

/// 按累计行进距离与半径返回滚动角，钳制到零到二派；半径非正时返回零。
double orbRollAngle(double travelled, double radius) {
  if (!(radius > 0.0)) {
    return 0.0;
  }
  final double angle = travelled / radius * kFeedbackOrbRollFactor;
  return angle.clamp(0.0, 2 * math.pi);
}
