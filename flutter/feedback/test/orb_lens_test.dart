import 'dart:math' as math;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter_test/flutter_test.dart';

const double _valueTolerance = 1e-9;

/// 验证灵感球透镜径向放大表、源点半径与滚动角的数值层。
void main() {
  group('灵感球透镜常量', () {
    test('中心与边缘倍率及滚动因子与契约一致', () {
      expect(kFeedbackOrbLensCenterScale, 1.70);
      expect(kFeedbackOrbLensEdgeScale, 0.866);
      expect(kFeedbackOrbRollFactor, 1.0);
    });

    test('采样点与放大倍数一一对应且半径升序', () {
      expect(kFeedbackOrbLensSampleR, hasLength(7));
      expect(kFeedbackOrbLensSampleM, hasLength(kFeedbackOrbLensSampleR.length));
      expect(kFeedbackOrbLensSampleR.first, 0.0);
      expect(kFeedbackOrbLensSampleR.last, 1.0);
      for (int i = 1; i < kFeedbackOrbLensSampleR.length; i++) {
        expect(
          kFeedbackOrbLensSampleR[i] > kFeedbackOrbLensSampleR[i - 1],
          isTrue,
        );
      }
    });
  });

  group('灵感球透镜放大倍数', () {
    test('表内七个采样点与表一致', () {
      for (int i = 0; i < kFeedbackOrbLensSampleR.length; i++) {
        expect(
          orbLensMagnification(kFeedbackOrbLensSampleR[i]),
          closeTo(kFeedbackOrbLensSampleM[i], _valueTolerance),
        );
      }
    });

    test('关键半径取到中心、中点与边缘倍率', () {
      expect(orbLensMagnification(0.0), closeTo(1.700, _valueTolerance));
      expect(orbLensMagnification(0.5), closeTo(1.671, _valueTolerance));
      expect(orbLensMagnification(1.0), closeTo(0.866, _valueTolerance));
    });

    test('相邻采样点中点落在两端倍率之间', () {
      for (int i = 1; i < kFeedbackOrbLensSampleR.length; i++) {
        final double mid =
            (kFeedbackOrbLensSampleR[i] + kFeedbackOrbLensSampleR[i - 1]) / 2;
        final double lower = kFeedbackOrbLensSampleM[i - 1];
        final double upper = kFeedbackOrbLensSampleM[i];
        final double value = orbLensMagnification(mid);
        expect(value, lessThanOrEqualTo(lower + _valueTolerance));
        expect(value, greaterThanOrEqualTo(upper - _valueTolerance));
      }
    });

    test('放大倍数沿半径单调不增', () {
      double previous = orbLensMagnification(0.0);
      for (int step = 1; step <= 200; step++) {
        final double value = orbLensMagnification(step / 200);
        expect(value, lessThanOrEqualTo(previous + _valueTolerance));
        previous = value;
      }
    });

    test('越界半径钳制到边界值且不抛异常', () {
      expect(orbLensMagnification(-2.5), orbLensMagnification(0.0));
      expect(orbLensMagnification(-1e-12), orbLensMagnification(0.0));
      expect(orbLensMagnification(1.5), orbLensMagnification(1.0));
      expect(orbLensMagnification(1e6), orbLensMagnification(1.0));
      expect(
        orbLensMagnification(-2.5),
        closeTo(kFeedbackOrbLensCenterScale, _valueTolerance),
      );
      expect(
        orbLensMagnification(1.5),
        closeTo(kFeedbackOrbLensEdgeScale, _valueTolerance),
      );
    });
  });

  group('灵感球透镜源点半径', () {
    test('球心源点为零、球缘源点约为边缘倍率倒数', () {
      expect(orbLensSourceOffset(0.0), 0.0);
      // 契约写作 1.156 ± 1e-3；按 r / M(r) 与 M(1) = 0.866 得 1.1547，相差 1.27e-3。
      final double edge = orbLensSourceOffset(1.0);
      expect(edge, closeTo(1 / kFeedbackOrbLensEdgeScale, _valueTolerance));
      expect(edge, closeTo(1.1547, 1e-4));
    });

    test('源点半径等于半径除以对应放大倍数', () {
      for (final double r in <double>[0.1, 0.25, 0.4, 0.7, 0.85, 0.95, 1.0]) {
        expect(
          orbLensSourceOffset(r),
          closeTo(r / orbLensMagnification(r), _valueTolerance),
        );
      }
    });

    test('源点半径在零到一上严格递增', () {
      double previous = orbLensSourceOffset(1 / 400);
      for (int step = 2; step <= 400; step++) {
        final double value = orbLensSourceOffset(step / 400);
        expect(value, greaterThan(previous));
        previous = value;
      }
    });

    test('越界半径钳制到边界值', () {
      expect(orbLensSourceOffset(-1.0), orbLensSourceOffset(0.0));
      expect(orbLensSourceOffset(0.0), 0.0);
      expect(orbLensSourceOffset(2.0), orbLensSourceOffset(1.0));
      expect(orbLensSourceOffset(1e6), orbLensSourceOffset(1.0));
    });
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
