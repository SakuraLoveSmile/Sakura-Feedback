import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'wake_paint.dart';

const Duration kBeamAuroraDuration = Duration(milliseconds: 720);
const Color kBeamDimColor = Color(0xFF635D92);
const double kBeamDimOpacity = 0.26;

/// 从触点向屏幕边缘铺开的虹彩光晕，中央透明，两侧柔和消隐。
class BeamAuroraPainter extends CustomPainter {
  const BeamAuroraPainter(
      {required this.progress,
      required this.origin,
      this.fingertips = const []});

  final double progress;
  final Offset origin;
  final List<Offset> fingertips;

  // SweepGradient 从正右方向开始顺时针采色，首尾相接。这里存的是加到原像素的光量，暗色文字能保留轮廓。
  static const _spectrum = SweepGradient(
    stops: [
      0,
      45 / 360,
      .25,
      135 / 360,
      175 / 360,
      215 / 360,
      268 / 360,
      310 / 360,
      1
    ],
    colors: [
      Color(0xFF3D370C),
      Color(0xFF40251B),
      Color(0xFF3E2040),
      Color(0xFF252848),
      Color(0xFF103744),
      Color(0xFF1A3248),
      Color(0xFF343744),
      Color(0xFF3E3424),
      Color(0xFF3D370C),
    ],
  );

  @override
  void paint(Canvas canvas, Size size) {
    final double t = progress.clamp(0.0, 1.0);
    if (size.isEmpty || t <= 0 || t >= 1) return;
    final double far = Offset(math.max(origin.dx, size.width - origin.dx),
            math.max(origin.dy, size.height - origin.dy))
        .distance;
    final double start = size.shortestSide * .06;
    final double radius =
        start + (far * 1.60 - start) * (1 - math.pow(1 - t, 1.5));
    paintWakeBands(
      canvas,
      size,
      fingertips.isEmpty ? [origin] : fingertips,
      radius,
      spectrum: _spectrum,
      edgeStrength: .42 * wakeSmooth((t - .40) / .34),
      opacity: wakeSmooth(t / .13) * (1 - wakeSmooth((t - .68) / .32)),
    );
  }

  @override
  bool shouldRepaint(covariant BeamAuroraPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.origin != origin ||
      oldDelegate.fingertips != fingertips;
}
