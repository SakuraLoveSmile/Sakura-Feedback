import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'wake_paint.dart' show wakeSmooth;

const kWaterRippleDuration = Duration(seconds: 2);

// Programs are immutable. Each overlay owns its sampler and shader instance.
final Future<ui.FragmentProgram?> waterRippleProgram = _loadWaterProgram();

Future<ui.FragmentProgram?> _loadWaterProgram() async {
  for (final key in const [
    'packages/feedback_widget/shaders/water_ripple.frag',
    'shaders/water_ripple.frag',
  ]) {
    try {
      return await ui.FragmentProgram.fromAsset(key);
    } catch (_) {
      // A standalone package test and a consuming app have different asset keys.
    }
  }
  return null;
}

/// 同一圈水波的内外坡面向相反方向折射，两侧高光随波传播缓慢转动。
class WaterRipplePainter extends CustomPainter {
  const WaterRipplePainter({
    required this.progress,
    required this.origin,
    required this.image,
    this.shader,
  });

  final double progress;
  final Offset origin;
  final ui.Image image;
  final ui.FragmentShader? shader;

  @override
  void paint(Canvas canvas, Size size) {
    final double t = progress.clamp(0.0, 1.0);
    if (size.isEmpty || t <= 0 || t >= 1) return;
    final travel = (t / .9).clamp(0.0, 1.0);
    final farCorner = Offset(math.max(origin.dx, size.width - origin.dx),
        math.max(origin.dy, size.height - origin.dy));
    final radius = farCorner.distance * (.38 * travel + .62 * wakeSmooth(travel));
    final effect = shader;
    if (effect != null) {
      effect
        ..setFloat(0, size.width)
        ..setFloat(1, size.height)
        ..setFloat(2, origin.dx)
        ..setFloat(3, origin.dy)
        ..setFloat(4, t * 2)
        ..setFloat(5, image.width.toDouble())
        ..setFloat(6, image.height.toDouble())
        ..setFloat(7, radius)
        ..setImageSampler(0, image);
      canvas.drawRect(Offset.zero & size, Paint()..shader = effect);
      return;
    }
    // Canvas-only fallback for engines without runtime fragment shaders.
    final amplitude = wakeSmooth(t / .065) * (1 - wakeSmooth((t - .275) / .625));
    if (amplitude <= 0) return;
    final unit = math.min(size.shortestSide / 361, 1.6);
    final width = math.min(radius * .2, (radius * .05).clamp(2.4 * unit, 12 * unit));
    final bend = amplitude * math.min(width * .78, 6.5 * unit);
    final Rect circle =
        Rect.fromCircle(center: origin, radius: radius + 2 * width);
    final Shader arcs = SweepGradient(
      transform: GradientRotation(-math.pi / 2 + t * math.pi * 2 / 3),
      colors: const [
        Colors.white,
        Color(0xA3FFFFFF),
        Color(0x50FFFFFF),
        Color(0x50FFFFFF),
        Color(0xA3FFFFFF),
        Colors.white,
        Color(0xA3FFFFFF),
        Color(0x50FFFFFF),
        Color(0x50FFFFFF),
        Color(0xA3FFFFFF),
        Colors.white,
      ],
      stops: const [0, .085, .19, .31, .415, .5, .585, .69, .81, .915, 1],
    ).createShader(circle);
    _paintWave(canvas, size, radius + width, width, amplitude * .9, bend, arcs);
    _paintWave(canvas, size, radius - width, width, amplitude, -bend, arcs);
  }

  void _paintWave(Canvas canvas, Size size, double radius, double width,
      double alpha, double bend, Shader arcs) {
    final double outer = radius + width;
    final double scale = radius / (radius + bend);
    final Rect bounds = Rect.fromCircle(center: origin, radius: outer)
        .inflate(2)
        .intersect(Offset.zero & size);
    if (bounds.isEmpty || alpha <= 0) return;
    double stop(double x) => ((radius + width * x) / outer).clamp(0.0, 1.0);
    // 限定离屏层，并让透明蒙版越过裁切边缘，避免抗锯齿留下细矩形。
    canvas.save();
    canvas.clipRect(bounds, doAntiAlias: false);
    final Rect cover = bounds.inflate(2);
    canvas.saveLayer(
        bounds, Paint()..color = Colors.white.withValues(alpha: alpha));
    canvas.drawImageRect(
        image,
        Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
        Rect.fromLTWH(origin.dx * (1 - scale), origin.dy * (1 - scale),
            size.width * scale, size.height * scale),
        Paint()
          ..filterQuality = FilterQuality.low
          ..colorFilter = ColorFilter.mode(
            bend > 0 ? const Color(0x09000000) : const Color(0x09FFFFFF),
            BlendMode.srcATop,
          ));
    canvas.drawRect(
        cover,
        Paint()
          ..blendMode = BlendMode.dstIn
          ..shader = ui.Gradient.radial(origin, outer, const [
            Color(0x00FFFFFF),
            Color(0x88FFFFFF),
            Color(0xFFFFFFFF),
            Color(0x88FFFFFF),
            Color(0x00FFFFFF),
          ], [
            stop(-1),
            stop(-.60),
            stop(0),
            stop(.60),
            stop(1)
          ]));
    canvas.drawRect(
        cover,
        Paint()
          ..blendMode = BlendMode.dstIn
          ..shader = arcs);
    canvas.restore();
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant WaterRipplePainter oldDelegate) =>
      oldDelegate.shader != shader ||
      oldDelegate.progress != progress ||
      oldDelegate.origin != origin ||
      oldDelegate.image != image;
}
