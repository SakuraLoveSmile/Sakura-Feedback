import 'dart:math' as math;
import 'dart:ui' show Brightness, Color, Offset;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter/animation.dart' show Curves;
import 'package:flutter_test/flutter_test.dart';

const double _geometryTolerance = 1e-9;
const double _colorTolerance = 1e-6;

/// 验证灵感球令牌、几何、连续呼吸与任务卡运行条件。
void main() {
  group('灵感球设计令牌', () {
    test('全部常量与任务卡数值一致', () {
      expect(kFeedbackOrbIdleDiameter, 56.0);
      expect(kFeedbackOrbDraggingDiameter, 84.0);
      expect(kFeedbackOrbDragScale, 1.5);
      expect(kFeedbackOrbDragStretchMax, 0.04);
      expect(kFeedbackOrbHoverScale, 1.04);
      expect(kFeedbackOrbPressedScale, 0.94);
      expect(kFeedbackOrbSizeDuration.inMilliseconds, 220);
      expect(kFeedbackOrbPressDuration.inMilliseconds, 140);
      expect(kFeedbackOrbReleaseDuration.inMilliseconds, 460);
      expect(kFeedbackOrbReleaseCurve.a, 0.2);
      expect(kFeedbackOrbReleaseCurve.b, 1.35);
      expect(kFeedbackOrbReleaseCurve.c, 0.32);
      expect(kFeedbackOrbReleaseCurve.d, 1.0);
      expect(kFeedbackOrbPressCurve, same(Curves.easeOut));
      expect(kFeedbackOrbSweepDuration.inMilliseconds, 10000);
      expect(kFeedbackOrbSweepArc, 40 * math.pi / 180);
      expect(kFeedbackOrbSweepWhiteAlpha, 0.80);
      expect(kFeedbackOrbBreathDuration.inMilliseconds, 5400);
      expect(kFeedbackOrbBreathScaleMax, 1.02);
      expect(kFeedbackOrbBreathBloomGain, 0.08);
      expect(kFeedbackOrbDragThreshold, 8.0);
      expect(kFeedbackOrbPullDistance, 80.0);
      expect(kFeedbackOrbGlowCounterTravel, 4.0);
      expect(kFeedbackOrbBloomInset, -3.0);
      expect(kFeedbackOrbBloomBlur, 4.0);
      expect(kFeedbackOrbGlowInset, -14.0);
      expect(kFeedbackOrbGlowBlur, 8.0);
      expect(kFeedbackOrbCoreBackdropSigma, 3.0);
      expect(kFeedbackOrbFocusWidth, 2.0);
      expect(kFeedbackOrbFocusOffset, 2.0);
    });
  });

  group('灵感球固定拖动向量', () {
    test('零位移保持零角度、零拉力、原始比例与零光晕位移', () {
      _expectGeometry(
        Offset.zero,
        pull: 0.0,
        angle: 0.0,
        stretch: 1.0,
        glow: Offset.zero,
      );
    });

    test('八像素位移产生十分之一拉力与一点零零四倍拉伸', () {
      _expectGeometry(
        const Offset(8.0, 0.0),
        pull: 0.1,
        angle: 0.0,
        stretch: 1.004,
        glow: const Offset(-0.4, 0.0),
      );
    });

    test('向右八十像素产生饱和拉力与向左四像素光晕位移', () {
      _expectGeometry(
        const Offset(80.0, 0.0),
        pull: 1.0,
        angle: 0.0,
        stretch: 1.04,
        glow: const Offset(-4.0, 0.0),
      );
    });

    test('向下八十像素的角度为半个圆周率且光晕向上偏移', () {
      _expectGeometry(
        const Offset(0.0, 80.0),
        pull: 1.0,
        angle: math.pi / 2,
        stretch: 1.04,
        glow: const Offset(0.0, -4.0),
      );
    });

    test('六十八十向量按方向分解反向光晕且拉力饱和', () {
      _expectGeometry(
        const Offset(60.0, 80.0),
        pull: 1.0,
        angle: math.atan2(80.0, 60.0),
        stretch: 1.04,
        glow: const Offset(-2.4, -3.2),
      );
    });

    test('一百六十像素位移不会增加饱和拉力与光晕位移', () {
      _expectGeometry(
        const Offset(160.0, 0.0),
        pull: 1.0,
        angle: 0.0,
        stretch: 1.04,
        glow: const Offset(-4.0, 0.0),
      );
    });
  });

  group('灵感球连续呼吸', () {
    const List<double> flows = <double>[
      0.0,
      0.135,
      0.27,
      0.405,
      0.54,
      0.675,
      0.81,
      0.945,
    ];

    test('八个采样点与独立的等价正弦平方公式一致', () {
      for (final double flow in flows) {
        final double halfPhase = (flow * 10.0 / 5.4) * math.pi;
        final double sine = math.sin(halfPhase);
        final double expected = sine * sine;
        expect(
          orbBreath(flow),
          closeTo(expected, _geometryTolerance),
          reason: '扫光相位为 $flow',
        );
      }
    });

    test('零相位与完整周期为谷值，半周期为峰值', () {
      expect(orbBreath(0.0), 0.0);
      // 指定公式在相位零点五四完成一周期，峰值实际位于零点二七。
      expect(orbBreath(0.54), closeTo(0.0, _geometryTolerance));
      expect(orbBreath(0.27), closeTo(1.0, _geometryTolerance));
      expect(orbBreath(0.27), greaterThan(0.95));
    });

    test('相邻采样差小于零点七五且存在中间值，排除零一方波', () {
      bool hasIntermediateValue = false;
      for (int index = 0; index < flows.length; index++) {
        final double breath = orbBreath(flows[index]);
        if (breath > _geometryTolerance && breath < 1.0 - _geometryTolerance) {
          hasIntermediateValue = true;
        }
        if (index > 0) {
          final double previous = orbBreath(flows[index - 1]);
          expect((breath - previous).abs(), lessThan(0.75));
        }
      }
      expect(hasIntermediateValue, isTrue);
    });

    test('采样呼吸值保持零到一且缩放不超过一点零二', () {
      for (final double flow in flows) {
        final double breath = orbBreath(flow);
        final double scale = 1.0 + 0.02 * breath;
        expect(breath, inInclusiveRange(0.0, 1.0));
        expect(scale, lessThanOrEqualTo(1.02));
      }
    });
  });

  group('灵感球运行条件真值表', () {
    test('面板关闭、灵感球模式、入口可见且未减少动态效果时运行', () {
      final bool run = orbShouldRunFlow(
        open: false,
        orbMode: true,
        showLauncher: true,
        reducedMotion: false,
        occluded: false,
      );
      expect(run, isTrue);
    });

    test('仅面板打开时停止', () {
      final bool run = orbShouldRunFlow(
        open: true,
        orbMode: true,
        showLauncher: true,
        reducedMotion: false,
        occluded: false,
      );
      expect(run, isFalse);
    });

    test('仅非灵感球模式时停止', () {
      final bool run = orbShouldRunFlow(
        open: false,
        orbMode: false,
        showLauncher: true,
        reducedMotion: false,
        occluded: false,
      );
      expect(run, isFalse);
    });

    test('仅入口不可见时停止', () {
      final bool run = orbShouldRunFlow(
        open: false,
        orbMode: true,
        showLauncher: false,
        reducedMotion: false,
        occluded: false,
      );
      expect(run, isFalse);
    });

    test('仅开启减少动态效果时停止', () {
      final bool run = orbShouldRunFlow(
        open: false,
        orbMode: true,
        showLauncher: true,
        reducedMotion: true,
        occluded: false,
      );
      expect(run, isFalse);
    });

    test('仅选区覆盖层遮挡时停止', () {
      final bool run = orbShouldRunFlow(
        open: false,
        orbMode: true,
        showLauncher: true,
        reducedMotion: false,
        occluded: true,
      );
      expect(run, isFalse);
    });

    test('穷举三十二种组合，仅可见且允许动画的灵感球运行', () {
      const List<bool> values = <bool>[false, true];
      for (final bool open in values) {
        for (final bool orbMode in values) {
          for (final bool showLauncher in values) {
            for (final bool reducedMotion in values) {
              for (final bool occluded in values) {
                final bool run = orbShouldRunFlow(
                  open: open,
                  orbMode: orbMode,
                  showLauncher: showLauncher,
                  reducedMotion: reducedMotion,
                  occluded: occluded,
                );
                expect(
                    run,
                    !open &&
                        orbMode &&
                        showLauncher &&
                        !reducedMotion &&
                        !occluded);
              }
            }
          }
        }
      }
    });
  });

  group('灵感球主题令牌', () {
    test('浅色主题的六个字段保留准确的浮点颜色', () {
      const OrbPalette palette = OrbPalette.light;
      expect(palette.bloomWhiteAlpha, closeTo(0.45, _colorTolerance));
      _expectColor(palette.warm, 255, 190, 120, 0.58);
      _expectColor(palette.cyan, 120, 200, 255, 0.70);
      _expectColor(palette.edge, 255, 255, 255, 0.95);
      _expectColor(palette.hairline, 0, 0, 0, 0.10);
      _expectColor(palette.sweepWhite, 255, 255, 255, 0.80);
    });

    test('深色主题的六个字段保留准确的浮点颜色', () {
      const OrbPalette palette = OrbPalette.dark;
      expect(palette.bloomWhiteAlpha, closeTo(0.55, _colorTolerance));
      _expectColor(palette.warm, 200, 24, 0, 0.43);
      _expectColor(palette.cyan, 0, 76, 255, 0.33);
      _expectColor(palette.edge, 255, 255, 255, 0.85);
      _expectColor(palette.hairline, 255, 255, 255, 0.18);
      _expectColor(palette.sweepWhite, 255, 255, 255, 0.80);
    });

    test('亮度映射返回对应的共享主题常量', () {
      expect(OrbPalette.of(Brightness.light), same(OrbPalette.light));
      expect(OrbPalette.of(Brightness.dark), same(OrbPalette.dark));
    });
  });
}

void _expectGeometry(
  Offset offset, {
  required double pull,
  required double angle,
  required double stretch,
  required Offset glow,
}) {
  final double actualPull = orbPull(offset);
  final double actualAngle = orbDragAngle(offset);
  final double actualStretch = orbStretch(actualPull);
  final Offset actualGlow = orbGlowOffset(actualPull, actualAngle);
  expect(actualPull, closeTo(pull, _geometryTolerance));
  expect(actualAngle, closeTo(angle, _geometryTolerance));
  expect(actualStretch, closeTo(stretch, _geometryTolerance));
  expect(actualGlow.dx, closeTo(glow.dx, _geometryTolerance));
  expect(actualGlow.dy, closeTo(glow.dy, _geometryTolerance));
}

void _expectColor(Color actual, int red, int green, int blue, double alpha) {
  expect(actual.a, closeTo(alpha, _colorTolerance));
  expect(actual.r, closeTo(red / 255.0, _colorTolerance));
  expect(actual.g, closeTo(green / 255.0, _colorTolerance));
  expect(actual.b, closeTo(blue / 255.0, _colorTolerance));
}
