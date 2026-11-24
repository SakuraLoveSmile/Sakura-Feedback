import 'dart:ui' as ui;

import 'package:feedback_widget/src/water_ripple.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<ui.Image> _render(void Function(Canvas) draw) async {
  final recorder = ui.PictureRecorder();
  draw(Canvas(recorder));
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(240, 240);
  } finally {
    picture.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final gpu in [true, false]) {
    test('ripple bends detail and preserves neutral tones (shader: $gpu)',
        () async {
      final shader = gpu ? (await waterRippleProgram)!.fragmentShader() : null;
      if (shader != null) addTearDown(shader.dispose);
      final page = await _render((canvas) {
        canvas.drawColor(const Color(0xFF808080), BlendMode.src);
        final ink = Paint()..color = const Color(0xFF181818);
        for (var x = 120.0; x < 240; x += 6) {
          canvas.drawRect(Rect.fromLTWH(x, 0, 2, 240), ink);
        }
      });
      addTearDown(page.dispose);
      final result = await _render((canvas) {
        canvas.drawImage(page, Offset.zero, Paint());
        WaterRipplePainter(
          progress: .25,
          origin: const Offset(120, 120),
          image: page,
          shader: shader,
        ).paint(canvas, const Size.square(240));
      });
      addTearDown(result.dispose);
      final pixels =
          (await result.toByteData(format: ui.ImageByteFormat.rawRgba))!;
      var displaced = 0;
      var maxFlatChange = 0;
      for (var y = 0; y < 240; y++) {
        for (var x = 0; x < 240; x++) {
          final offset = (y * 240 + x) * 4;
          final red = pixels.getUint8(offset);
          if (x < 116) {
            final delta = (red - 128).abs();
            if (delta > maxFlatChange) maxFlatChange = delta;
            if (red != pixels.getUint8(offset + 1) ||
                red != pixels.getUint8(offset + 2)) {
              fail('Neutral page gained a colored fringe at ($x, $y)');
            }
          } else if (x > 124) {
            final original = (x - 120) % 6 < 2 ? 24 : 128;
            if ((red - original).abs() > 40) displaced++;
          }
        }
      }
      expect(maxFlatChange, inInclusiveRange(1, 14));
      expect(displaced, greaterThan(20));
      expect(pixels.getUint8(0), 128);
    });
  }
}
