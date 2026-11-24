import 'dart:ui' as ui;

import 'package:flutter/material.dart';

double wakeSmooth(double value) {
  final double x = value.clamp(0.0, 1.0);
  return x * x * (3 - 2 * x);
}

/// 先合并各个波面的透明度，再施加一次虹彩。两指靠近时交叠处仍能看见正文。
void paintWakeBands(
  Canvas canvas,
  Size size,
  List<Offset> origins,
  double radius, {
  required SweepGradient spectrum,
  required SweepGradient highlights,
  required double edgeStrength,
  required double opacity,
}) {
  if (opacity <= 0) return;
  final Rect viewport = Offset.zero & size;
  final Paint mask = Paint();
  final recorder = ui.PictureRecorder();
  final maskCanvas = Canvas(recorder, viewport);
  for (final Offset center in origins) {
    mask.shader = ui.Gradient.radial(center, radius, const [
      Color(0x00FFFFFF),
      Color(0x03FFFFFF),
      Color(0x24FFFFFF),
      Color(0xA3FFFFFF),
      Color(0xFFFFFFFF),
      Color(0xDEFFFFFF),
      Color(0x59FFFFFF),
      Color(0x0FFFFFFF),
      Color(0x00FFFFFF),
    ], const [
      0,
      .16,
      .34,
      .52,
      .65,
      .74,
      .86,
      .95,
      1
    ]);
    maskCanvas.drawCircle(center, radius, mask);
  }
  if (edgeStrength > 0) {
    maskCanvas.save();
    maskCanvas.scale(size.width, size.height);
    mask.shader = ui.Gradient.radial(const Offset(.5, .5), .70, [
      Colors.transparent,
      Colors.transparent,
      Colors.white.withValues(alpha: edgeStrength * .24),
      Colors.white.withValues(alpha: edgeStrength),
    ], const [
      0,
      .54,
      .74,
      1
    ]);
    maskCanvas.drawRect(const Rect.fromLTWH(0, 0, 1, 1), mask);
    maskCanvas.restore();
  }

  final shape = recorder.endRecording();

  void tint(SweepGradient gradient, BlendMode blend) {
    canvas.saveLayer(
        viewport,
        Paint()
          ..blendMode = blend
          ..color = Colors.white.withValues(alpha: opacity));
    canvas.drawPicture(shape);
    canvas.drawRect(
        viewport.inflate(2),
        Paint()
          ..blendMode = BlendMode.srcIn
          ..shader = gradient.createShader(viewport));
    canvas.restore();
  }

  canvas.save();
  canvas.clipRect(viewport, doAntiAlias: false);
  tint(spectrum, BlendMode.plus);
  tint(highlights, BlendMode.darken);
  canvas.restore();
  shape.dispose();
}
