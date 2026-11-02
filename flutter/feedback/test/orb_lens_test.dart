import 'dart:math' as math;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter_test/flutter_test.dart';

const double _valueTolerance = 1e-9;

/// 验证灵感球透镜径向放大表、源点半径与滚动角的数值层。
void main() {
  // R3 restores the complete first preview, superseding R1's reverse annulus.
  test('首版中心 1.62，外缘源半径约 1.157，采样表仅用于诊断', () {
    expect(kFeedbackOrbLensCenterScale, 1.62);
    expect(kFeedbackOrbLensEdgeScale, closeTo(1 / (1 / 1.62 + .54), 1e-12));
    expect(kFeedbackOrbLensDispersionEdge, .52);
    expect(kFeedbackOrbLensRimStrength, .64);
    expect(kFeedbackOrbRollFactor, 1);
    expect(kFeedbackOrbLensSampleR, hasLength(7));
    for (int i = 0; i < kFeedbackOrbLensSampleR.length; i++) {
      expect(orbLensMagnification(kFeedbackOrbLensSampleR[i]),
          closeTo(kFeedbackOrbLensSampleM[i], _valueTolerance));
    }
  });

  test('首版使用原始半径乘七次弯曲，中心极限为 1.62', () {
    for (int i = 0; i <= 64; i++) {
      final double r = i / 100;
      expect(orbLensSourceOffset(r),
          closeTo(r * (1 / 1.62 + .54 * math.pow(r, 7)), _valueTolerance));
    }
    expect(orbLensMagnification(.001), closeTo(1.62, 1e-12));
  });

  test('首版源半径连续递增，.75/.86/1 的实际源位置匹配冻结值', () {
    expect(orbLensSourceOffset(0), 0);
    expect(orbLensSourceOffset(.75), closeTo(.517024, .000001));
    expect(orbLensSourceOffset(.86), closeTo(.692442, .000001));
    expect(orbLensSourceOffset(1), closeTo(1 / 1.62 + .54, _valueTolerance));
    double previous = 0;
    for (int i = 1; i <= 1000; i++) {
      final double current = orbLensSourceOffset(i / 1000);
      expect(current, greaterThan(previous));
      previous = current;
    }
  });

  test('弯曲因子钳制但原始偏移继续递增，中心没有除零', () {
    expect(orbLensSourceOffset(-1), 0);
    expect(orbLensSourceOffset(2), closeTo(2 * (1 / 1.62 + .54), 1e-12));
    expect(orbLensMagnification(0).isFinite, isTrue);
    for (final double boundary in <double>[.64, .86, 1]) {
      expect(
          (orbLensSourceOffset(boundary - 1e-8) -
                  orbLensSourceOffset(boundary + 1e-8))
              .abs(),
          lessThan(1e-6));
    }
    for (final double r in <double>[.1, .5, .75, .86, .93, 1]) {
      expect(
          orbLensMagnification(r), closeTo(r / orbLensSourceOffset(r), 1e-12));
    }
  });

  group('灵感球滚动角', () {
    test('零行进返回零角', () {
      expect(orbRollAngle(0.0, 28.0), 0.0);
    });

    test('行进一个半径等于一弧度', () {
      expect(orbRollAngle(28.0, 28.0), closeTo(1.0, _valueTolerance));
    });

    test('行进半个圆周的半径长度等于派', () {
      expect(
        orbRollAngle(math.pi * 28.0, 28.0),
        closeTo(math.pi, _valueTolerance),
      );
    });

    test('行进一个圆周的半径长度等于二派', () {
      expect(
        orbRollAngle(2 * math.pi * 28.0, 28.0),
        closeTo(2 * math.pi, _valueTolerance),
      );
    });

    test('超出范围的夹角钳制到零与二派', () {
      expect(orbRollAngle(1e6, 28.0), 2 * math.pi);
      expect(orbRollAngle(-5.0, 28.0), 0.0);
    });

    test('半径非正时返回零且不是 NaN', () {
      for (final double radius in <double>[0.0, -1.0, -1e-6]) {
        final double angle = orbRollAngle(1.0, radius);
        expect(angle, 0.0);
        expect(angle.isNaN, isFalse);
      }
    });
  });
}
