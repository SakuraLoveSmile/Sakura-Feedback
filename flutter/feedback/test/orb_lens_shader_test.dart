// R3 restores all first-preview optics, superseding R1's reverse outer annulus.
// These are rendered pixel checks, plus a structural uniform/GLES contract.
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:feedback_widget/src/orb.dart';
import 'package:feedback_widget/src/orb_liquid.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'capture_test_utils.dart';

const int _size = 512;
const Offset _center = Offset(256, 256);

Future<ui.FragmentProgram> _loadOrbLensProgram() async {
  // 与组件实际加载顺序一致：矩阵宿主使用包前缀，组件根测试使用根键。
  // 两种键都失败时继续抛错，不能把 shader 像素检查降级为无纹理绘制。
  try {
    return await ui.FragmentProgram.fromAsset(
      'packages/feedback_widget/shaders/orb_lens.frag',
    );
  } catch (_) {
    return ui.FragmentProgram.fromAsset('shaders/orb_lens.frag');
  }
}

Future<ui.Image> _image(void Function(Canvas canvas) draw) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  draw(Canvas(recorder));
  final ui.Picture picture = recorder.endRecording();
  try {
    return await picture.toImage(_size, _size);
  } finally {
    picture.dispose();
  }
}

class _Pixels {
  _Pixels(this.data);
  final Uint8List data;
  int channel(double x, double y, int channel) =>
      data[(y.floor().clamp(0, 511) * _size + x.floor().clamp(0, 511)) * 4 +
          channel];
}

/// Independent CPU evaluation of first-preview.html's full-canvas two mixes,
/// expressed as the premultiplied layer that is composed over that canvas.
/// q is evaluated directly, rather than using the production contour helper.
List<double> _referencePixel(
  Offset point, {
  required List<double> Function(Offset) sample,
  double radius = 200,
  Offset direction = const Offset(1, 0),
  double deform = 0,
  double wobble = 0,
  bool dark = false,
  double opacity = 1,
}) {
  final Offset offset = point - _center;
  final Offset axis = direction / direction.distance;
  final double stretch = 1 + deform * .20;
  final double qx =
      (offset.dx * axis.dx + offset.dy * axis.dy) / radius / stretch;
  final double qy = (-offset.dx * axis.dy + offset.dy * axis.dx) /
      radius *
      math.sqrt(stretch);
  final double angle = math.atan2(qy, qx);
  final double contour = 1 +
      deform * (.045 * math.cos(3 * angle) - .035 * math.cos(angle)) +
      wobble * .028 * math.cos(2 * angle + .7);
  final double r = math.sqrt(qx * qx + qy * qy) / contour;
  final double edge = ((r - (1 - 1.1 / radius)) / (2.2 / radius)).clamp(0, 1);
  final double inside = 1 - edge * edge * (3 - 2 * edge);
  final Offset source =
      _center + offset * (1 / 1.62 + .54 * math.pow(r.clamp(0, 1), 7));
  final Offset ray = (offset + const Offset(.001, .001)) /
      (offset + const Offset(.001, .001)).distance;
  final double dispersion = .52 * math.pow(r.clamp(0, 1), 8);
  final double theta = math.atan2(offset.dy, offset.dx);
  double gaussian(double x) => math.exp(-x * x);
  final double light = .55 + .45 * math.cos(theta + 2.25);
  final double shadow = gaussian((r - .973) / .018) * (1 - light);
  final double white = gaussian((r - .992) / .012) * (.28 + .5 * light) * .64 +
      gaussian((r - .943) / .030) * .10 * light +
      gaussian((r - .84) / .095) * (.5 + .5 * math.sin(theta - .6)) * .12;
  final double glow =
      gaussian((r - 1.04) / .065) * .055 * (1 - inside) * (1 - inside);
  final List<double> sampled = <double>[
    sample(source + ray * dispersion)[0],
    sample(source)[1],
    sample(source - ray * dispersion)[2],
  ];
  return <double>[
    for (int channel = 0; channel < 3; channel++)
      ((((sampled[channel] * (1 - shadow * .19)) * (1 - white) +
                          <double>[.99, .995, 1][channel] * white +
                          <double>[.002, .003, .009][channel] *
                              (dark ? .5 : 1)) *
                      inside +
                  <double>[.95, .965, 1][channel] * glow) *
              opacity *
              255)
          .clamp(0, 255),
    (inside + glow) * opacity * 255,
  ];
}

Future<_Pixels> _render(
  ui.Image image, {
  double radius = 200,
  Offset center = _center,
  Offset offset = Offset.zero,
  double ratio = 1,
  double opacity = 1,
  Offset direction = const Offset(1, 0),
  double deform = 0,
  double wobble = 0,
  bool dark = false,
  Color? backdrop,
  Size? halfSize,
  double handleMix = 0,
  double mist = 0,
  double idleMix = 0,
}) async {
  final ui.FragmentProgram program = await _loadOrbLensProgram();
  final ui.FragmentShader shader = program.fragmentShader();
  final List<double> values = orbLensUniformValues(
      imageSize: const Size(512, 512),
      imageOffset: offset,
      pixelRatio: ratio,
      center: center,
      radiusPx: radius,
      direction: direction,
      deform: deform,
      wobble: wobble,
      opacity: opacity,
      dark: dark,
      halfSize: halfSize,
      handleMix: handleMix,
      mist: mist,
      idleMix: idleMix,
      localSize: const Size(512, 512));
  for (int i = 0; i < values.length; i++) {
    shader.setFloat(i, values[i]);
  }
  shader.setImageSampler(0, image);
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  if (backdrop != null) canvas.drawColor(backdrop, BlendMode.src);
  canvas.drawRect(
      const Rect.fromLTWH(0, 0, 512, 512), Paint()..shader = shader);
  final ui.Picture picture = recorder.endRecording();
  ui.Image? rendered;
  try {
    rendered = await picture.toImage(512, 512);
    final ByteData? raw =
        await rendered.toByteData(format: ui.ImageByteFormat.rawRgba);
    return _Pixels(Uint8List.fromList(raw!.buffer.asUint8List()));
  } finally {
    rendered?.dispose();
    picture.dispose();
    shader.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'R11 dark idle keeps the clear background and a subdued local edge for sphere and capsule',
      (tester) async {
    await tester.runAsync(() async {
      const Color backdrop = Color(0xFF1C1D21);
      final ui.Image safe =
          await _image((canvas) => canvas.drawColor(backdrop, BlendMode.src));
      try {
        for (final bool handle in <bool>[false, true]) {
          final _Pixels pixels = await _render(safe,
              center: const Offset(256.5, 256.5),
              radius: 28,
              halfSize: handle ? const Size(5, 24) : null,
              handleMix: handle ? 1 : 0,
              mist: .74,
              idleMix: 1,
              dark: true,
              backdrop: backdrop);
          expect(pixels.channel(256, 256, 0), inInclusiveRange(29, 34),
              reason: 'the selected clear glass only lightly tints the host');
          expect(pixels.channel(256, 256, 2), inInclusiveRange(34, 40));
          expect(pixels.channel(256, 256, 3), 255);
          for (int x = 256; x <= 256 + (handle ? 5 : 28) + 8; x++) {
            for (int c = 0; c < 3; c++) {
              expect(pixels.channel(x.toDouble(), 256, c), lessThan(80),
                  reason: 'the edge must never become a bright white ring');
            }
          }
        }
      } finally {
        safe.dispose();
      }
    });
  });

  testWidgets(
      'R11 dark no-texture fallback is nearly transparent and retains high-contrast contours',
      (tester) async {
    await tester.runAsync(() async {
      for (final bool handle in <bool>[false, true]) {
        for (final bool highContrast in <bool>[false, true]) {
          final OrbLiquidOutlinePainter fallback = OrbLiquidOutlinePainter(
              radius: 28,
              halfSize: handle ? const Size(5, 24) : null,
              handleMix: handle ? 1 : 0,
              idleMix: 1,
              dark: true,
              highContrast: highContrast);
          final ui.Image image = await _image(
              (canvas) => fallback.paint(canvas, const Size(512, 512)));
          try {
            final ByteData? raw =
                await image.toByteData(format: ui.ImageByteFormat.rawRgba);
            final _Pixels pixels = _Pixels(raw!.buffer.asUint8List());
            if (highContrast) {
              expect(pixels.channel(256, 256, 3), 0,
                  reason: 'the existing high-contrast outline is preserved');
            } else {
              expect(pixels.channel(256, 256, 3),
                  handle ? inInclusiveRange(10, 14) : inInclusiveRange(3, 6),
                  reason: 'the rejected 62% smoke body must not return');
              expect(pixels.channel(256, 256, 0), lessThanOrEqualTo(8));
              expect(pixels.channel(256, 256, 2), lessThanOrEqualTo(9));
              for (int i = 0; i < pixels.data.length; i += 4) {
                for (int c = 0; c < 3; c++) {
                  expect(pixels.data[i + c],
                      lessThanOrEqualTo(pixels.data[i + 3]));
                }
              }
            }
          } finally {
            image.dispose();
          }
        }
      }
    });
  });

  testWidgets(
      'R11 clear idle preserves a one-pixel feature with only 0.35px softness',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image point = await _image((canvas) => canvas.drawRect(
          const Rect.fromLTWH(256, 256, 1, 1), Paint()..color = Colors.red));
      try {
        final _Pixels pixels = await _render(point,
            center: const Offset(256.5, 256.5),
            radius: 28,
            mist: .74,
            idleMix: 1,
            dark: true);
        expect(pixels.channel(256, 256, 3), closeTo(.825 * 255, 1),
            reason: 'lightly filtered safe alpha retains fine detail');
      } finally {
        point.dispose();
      }
    });
  });

  testWidgets(
      'R9 light idle glow remains visible and softly fades 2–6px outside round and handle shapes',
      (tester) async {
    await tester.runAsync(() async {
      for (final Color backdrop in <Color>[
        Colors.white,
        const Color(0xFFF3F4FA)
      ]) {
        final ui.Image safe =
            await _image((canvas) => canvas.drawColor(backdrop, BlendMode.src));
        try {
          for (final bool handle in <bool>[false, true]) {
            final _Pixels pixels = await _render(safe,
                center: const Offset(256.5, 256.5),
                radius: 28,
                halfSize: handle ? const Size(6, 28) : null,
                handleMix: handle ? 1 : 0,
                mist: .74,
                idleMix: 1,
                backdrop: backdrop);
            final List<int> differences = <int>[
              for (int gap = 2; gap <= 6; gap++)
                (backdrop.r * 255).round() -
                    pixels.channel(
                        256 + (handle ? 6 : 28) + gap.toDouble(), 256, 0),
            ];
            debugPrint('R9 shader ${backdrop.toARGB32().toRadixString(16)} '
                '${handle ? 'handle' : 'orb'} red contrast at 2–6px: $differences');
            expect(differences.first, greaterThanOrEqualTo(15),
                reason:
                    'light ${handle ? 'handle' : 'orb'} must be visible on ${backdrop.toARGB32().toRadixString(16)}');
            expect(differences[2], greaterThanOrEqualTo(10));
            expect(differences.last, greaterThanOrEqualTo(4),
                reason:
                    'the glow spans logical pixels instead of collapsing with handle width');
            for (int i = 1; i < differences.length; i++) {
              expect(
                  differences[i - 1] - differences[i], inInclusiveRange(1, 10),
                  reason:
                      'a wide smooth falloff must replace a narrow hard border');
            }
          }
        } finally {
          safe.dispose();
        }
      }
    });
  });

  testWidgets(
      'R9 no-texture light fallback has a visible soft glow and transparent center',
      (tester) async {
    await tester.runAsync(() async {
      for (final Color backdrop in <Color>[
        Colors.white,
        const Color(0xFFF3F4FA)
      ]) {
        for (final bool handle in <bool>[false, true]) {
          final OrbLiquidOutlinePainter fallback = OrbLiquidOutlinePainter(
              radius: 28,
              halfSize: handle ? const Size(6, 28) : null,
              handleMix: handle ? 1 : 0,
              idleMix: 1);
          final ui.Image image = await _image((canvas) {
            canvas.drawColor(backdrop, BlendMode.src);
            fallback.paint(canvas, const Size(512, 512));
          });
          final ui.Image layer = await _image(
              (canvas) => fallback.paint(canvas, const Size(512, 512)));
          try {
            final ByteData? raw =
                await image.toByteData(format: ui.ImageByteFormat.rawRgba);
            final _Pixels pixels = _Pixels(raw!.buffer.asUint8List());
            final List<int> differences = <int>[
              for (final int gap in <int>[2, 4, 6])
                (backdrop.r * 255).round() -
                    pixels.channel(
                        256 + (handle ? 6 : 28) + gap.toDouble(), 256, 0),
            ];
            expect(differences[0], greaterThanOrEqualTo(15));
            expect(differences[1], greaterThanOrEqualTo(7));
            expect(differences[2], greaterThanOrEqualTo(2));
            expect(differences[0], greaterThan(differences[1]));
            expect(differences[1], greaterThan(differences[2]));
            final ByteData? layerRaw =
                await layer.toByteData(format: ui.ImageByteFormat.rawRgba);
            final _Pixels layerPixels = _Pixels(layerRaw!.buffer.asUint8List());
            expect(layerPixels.channel(256, 256, 3), 0);
          } finally {
            image.dispose();
            layer.dispose();
          }
        }
      }
    });
  });

  testWidgets(
      'R11 idle preserves transparent sampled centers and premultiplication with a soft outer shadow',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image transparent = await _image((canvas) {});
      try {
        for (final bool handle in <bool>[false, true]) {
          for (final bool dark in <bool>[false, true]) {
            final _Pixels layer = await _render(transparent,
                center: const Offset(256.5, 256.5),
                radius: 28,
                halfSize: handle
                    ? (dark ? const Size(5, 24) : const Size(6, 28))
                    : null,
                handleMix: handle ? 1 : 0,
                mist: .74,
                idleMix: 1,
                dark: dark);
            expect(
                <int>[for (int c = 0; c < 4; c++) layer.channel(256, 256, c)],
                <int>[0, 0, 0, 0]);
            int excess = 0;
            for (int i = 0; i < layer.data.length; i += 4) {
              for (int c = 0; c < 3; c++) {
                excess =
                    math.max(excess, layer.data[i + c] - layer.data[i + 3]);
              }
            }
            expect(excess, 0,
                reason: 'every output pixel remains premultiplied');
            if (dark) {
              final int halfWidth = handle ? 5 : 28;
              int previousAlpha = 255;
              for (int gap = 2; gap <= 6; gap++) {
                final double x = 256 + halfWidth + gap.toDouble();
                final int alpha = layer.channel(x, 256, 3);
                // R11's transparent exterior is the selected preview's
                // soft neutral shadow; it is independent of sampled alpha.
                expect(alpha,
                    closeTo(math.exp(-math.pow(gap / 4.5, 2)) * .11 * 255, 1));
                expect(alpha, lessThan(previousAlpha));
                expect(layer.channel(x, 256, 0), lessThanOrEqualTo(12));
                previousAlpha = alpha;
              }
            }
          }
        }
      } finally {
        transparent.dispose();
      }
    });
  });

  testWidgets(
      'R7 mist averages premultiplied RGBA with bounded Gaussian weights and preserves transparent hosts',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image point = await _image((canvas) {
        canvas.drawRect(
            const Rect.fromLTWH(256, 256, 1, 1), Paint()..color = Colors.red);
      });
      final ui.Image transparent = await _image((canvas) {});
      final ui.Image semi = await _image((canvas) {
        canvas.drawColor(const Color(0x804080C0), BlendMode.src);
      });
      try {
        final _Pixels sharp =
            await _render(point, center: const Offset(256.5, 256.5));
        final _Pixels mist = await _render(point,
            center: const Offset(256.5, 256.5), mist: .74, idleMix: 1);
        expect(sharp.channel(256, 256, 3), 255);
        final double expectedAlpha = (.26 + .74 * .40262 * .40262) * 255;
        expect(mist.channel(256, 256, 3), closeTo(expectedAlpha, 1),
            reason: '25 taps average alpha before unpremultiplication');
        expect(mist.channel(256, 256, 0), greaterThan(80));
        for (int c = 0; c < 3; c++) {
          expect(mist.channel(256, 256, c),
              lessThanOrEqualTo(mist.channel(256, 256, 3)));
        }
        final _Pixels empty = await _render(transparent, mist: .74, idleMix: 1);
        expect(<int>[for (int c = 0; c < 4; c++) empty.channel(256, 256, c)],
            <int>[0, 0, 0, 0]);
        final _Pixels half =
            await _render(semi, mist: .74, idleMix: 1, opacity: .5);
        expect(half.channel(256, 256, 3), 64);
        expect(half.channel(256, 256, 0), greaterThan(10),
            reason: 'no opaque black fallback');
      } finally {
        point.dispose();
        transparent.dispose();
        semi.dispose();
      }
    });
  });

  testWidgets(
      'idle capsule has complete round caps: R11 dark 10 by 48 and R9 light 12 by 56',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image safe = await _image((canvas) {
        canvas.drawColor(Colors.blue, BlendMode.src);
      });
      try {
        for (final bool dark in <bool>[false, true]) {
          final _Pixels pixels = await _render(safe,
              center: const Offset(256.5, 256.5),
              radius: 28,
              halfSize: dark ? const Size(5, 24) : const Size(6, 28),
              handleMix: 1,
              mist: .74,
              idleMix: 1,
              dark: dark);
          expect(pixels.channel(dark ? 252 : 251, 256, 3), greaterThan(250));
          expect(pixels.channel(dark ? 252 : 251, dark ? 273 : 274, 3),
              greaterThan(250),
              reason: 'vertical stem is not an ellipse');
          expect(pixels.channel(256, dark ? 233 : 229, 3), greaterThan(250));
          expect(pixels.channel(256, dark ? 279 : 283, 3), greaterThan(250));
          if (dark) {
            expect(pixels.channel(249, 230, 3), lessThan(30));
            // Five pixels beyond the new 5px half-width is only soft shadow.
            expect(pixels.channel(246, 256, 3), closeTo(8, 1));
          } else {
            // R9 intentionally adds a 4.5px-wide light idle glow outside the
            // surface; these pixels may contain glow, but never opaque glass.
            expect(pixels.channel(249, 230, 3), inInclusiveRange(35, 45));
            expect(pixels.channel(246, 256, 3), inInclusiveRange(18, 28));
          }
        }
      } finally {
        safe.dispose();
      }
    });
  });

  testWidgets(
      'rendered center is upright at 1.62 and outer source pixels match the increasing first-preview bend',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image ramp = await _image((Canvas canvas) {
        for (int x = 0; x < 512; x++) {
          final int g = (x / 2).floor();
          canvas.drawRect(Rect.fromLTWH(x.toDouble(), 0, 1, 512),
              Paint()..color = Color.fromARGB(255, g, g, g));
        }
      });
      try {
        final _Pixels result = await _render(ramp);
        // The center maps 1 logical px to 1/1.62 source px, and stays upright.
        final int atCenter = result.channel(256, 256, 1);
        final int atRight = result.channel(320, 256, 1);
        expect(atRight - atCenter, closeTo(64 / 1.62 / 2, 2));
        for (final double r in <double>[.5, .75, .86, .93, .973, .992, 1]) {
          final int x = (256 + 200 * r).floor();
          final List<double> expected = _referencePixel(Offset(x + .5, 256.5),
              sample: (Offset source) =>
                  List<double>.filled(3, source.dx / 510));
          expect(result.channel(x.toDouble(), 256, 1), closeTo(expected[1], 2),
              reason:
                  'real sampled pixel must match first-preview bend at r=$r');
        }
        const Offset direction = Offset(.6, -.8);
        final _Pixels deformed = await _render(ramp,
            radius: 100, direction: direction, deform: .936, wobble: .55);
        for (int angle = 0; angle < 12; angle++) {
          for (final double r in <double>[.5, .75, .9, 1]) {
            final int x =
                (256 + 100 * r * math.cos(angle * math.pi / 6)).floor();
            final int y =
                (256 + 100 * r * math.sin(angle * math.pi / 6)).floor();
            final List<double> expected = _referencePixel(
                Offset(x + .5, y + .5),
                sample: (Offset source) =>
                    List<double>.filled(3, source.dx / 510),
                radius: 100,
                direction: direction,
                deform: .936,
                wobble: .55);
            expect(deformed.channel(x.toDouble(), y.toDouble(), 1),
                closeTo(expected[1], 2),
                reason:
                    'deformed refraction must use original offset, not q or contour normal');
          }
        }
        expect(result.channel(256, 256, 3), 255);
        expect(result.channel(256 + 200 * 1.2, 256, 3), 0);
        expect(
            result.channel(256 + 200 * 1.05, 256, 3), inInclusiveRange(13, 14),
            reason: 'first-preview .055 neutral glow replaces the old halo');
      } finally {
        ramp.dispose();
      }
    });
  });

  testWidgets(
      'rendered dispersion samples red outward and blue inward on both sides',
      (tester) async {
    await tester.runAsync(() async {
      for (final int x in <int>[65, 446]) {
        final Offset delta = Offset(x + .5, 256.5) - _center;
        final Offset source = _center +
            delta /
                delta.distance *
                (200 * orbLiquidSourceRadius(delta.distance / 200));
        final ui.Image edge = await _image((Canvas c) {
          c.drawPaint(Paint()..color = Colors.black);
          c.drawRect(
              x > 256
                  ? Rect.fromLTRB(source.dx, 0, 512, 512)
                  : Rect.fromLTRB(0, 0, source.dx, 512),
              Paint()..color = Colors.white);
        });
        try {
          final _Pixels pixels = await _render(edge);
          expect(pixels.channel(x.toDouble(), 256, 0),
              greaterThan(pixels.channel(x.toDouble(), 256, 2) + 80),
              reason: 'the bright side is outward at x=$x; R must sample it');
        } finally {
          edge.dispose();
        }
      }
    });
  });

  testWidgets(
      'R2 first-preview q contour follows direction, deform and wobble without circular clipping',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image bg =
          await _image((Canvas c) => c.drawPaint(Paint()..color = Colors.blue));
      const Offset direction = Offset(.6, -.8);
      const double deform = 1.3 * .72, wobble = .55;
      try {
        final _Pixels pixels = await _render(bg,
            radius: 100, direction: direction, deform: deform, wobble: wobble);
        for (int i = 0; i < 32; i++) {
          final double a = i * 2 * math.pi / 32;
          final double r = 100 * orbLiquidContour(a, direction, deform, wobble);
          final Offset normal = Offset(math.cos(a), math.sin(a));
          final Offset inside = _center + normal * (r * .94);
          final Offset outside = _center + normal * (r * 1.16);
          expect(pixels.channel(inside.dx, inside.dy, 3), 255);
          expect(
              pixels.channel(outside.dx, outside.dy, 3), lessThanOrEqualTo(1));
        }
      } finally {
        bg.dispose();
      }
    });
  });

  testWidgets(
      'asymmetric quadrant pixels remain above and left; no Y or X reversal',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image bg = await _image((Canvas c) {
        c.drawPaint(Paint()..color = Colors.black);
        c.drawRect(
            const Rect.fromLTWH(210, 210, 30, 30), Paint()..color = Colors.red);
        c.drawRect(const Rect.fromLTWH(275, 220, 12, 12),
            Paint()..color = Colors.green);
      });
      try {
        final _Pixels pixels = await _render(bg);
        expect(pixels.channel(206, 206, 0), greaterThan(240));
        expect(pixels.channel(306, 206, 0), lessThan(5));
        expect(pixels.channel(206, 306, 0), lessThan(5));
        expect(pixels.channel(296, 206, 1), greaterThan(100));
      } finally {
        bg.dispose();
      }
    });
  });

  testWidgets(
      'logical offset and capture scale work independently of screen DPR',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image bg = await _image((Canvas c) {
        c.drawPaint(Paint()..color = Colors.black);
        c.drawRect(const Rect.fromLTWH(240, 240, 32, 32),
            Paint()..color = Colors.white);
      });
      try {
        final _Pixels pixels = await _render(bg,
            center: const Offset(128, 128),
            offset: const Offset(64, 64),
            ratio: 2,
            radius: 40);
        expect(pixels.channel(64, 64, 0), 255,
            reason: 'local64 + offset64 = logical128 = image256');
        expect(pixels.channel(80, 64, 0), lessThan(5));
      } finally {
        bg.dispose();
      }
    });
  });

  testWidgets(
      'edge alpha antialiases and opacity preserves valid premultiplied pixels',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image bg = await _image(
          (Canvas c) => c.drawPaint(Paint()..color = const Color(0x80FFFFFF)));
      try {
        final _Pixels full = await _render(bg);
        final _Pixels faded = await _render(bg, opacity: .5);
        // Preserve the safe snapshot's alpha after unpremultiplying samples,
        // including the existing half-opacity contract (128 -> 64).
        expect(full.channel(256, 256, 3), closeTo(128, 1));
        expect(faded.channel(256, 256, 3), closeTo(64, 1));
        for (int channel = 0; channel < 3; channel++) {
          expect(full.channel(256, 256, channel), closeTo(128, 1));
          expect(faded.channel(256, 256, channel), closeTo(64, 1));
        }
        expect(full.channel(456, 256, 3), inExclusiveRange(0, 128));
        expect(faded.channel(456, 256, 3), lessThan(full.channel(456, 256, 3)));
        expect(faded.channel(20, 20, 3), 0);
        int excess = 0;
        for (int i = 0; i < faded.data.length; i += 4) {
          for (int c = 0; c < 3; c++) {
            excess = math.max(excess, faded.data[i + c] - faded.data[i + 3]);
          }
        }
        expect(excess, lessThanOrEqualTo(1),
            reason: 'every output pixel must remain premultiplied');
      } finally {
        bg.dispose();
      }
    });
  });

  testWidgets(
      'transparent safe snapshot keeps center transparent and host backdrop visible; outer glow remains independent',
      (tester) async {
    await tester.runAsync(() async {
      final ui.Image transparent = await _image((Canvas c) {});
      try {
        for (final double opacity in <double>[1, .5]) {
          final _Pixels layer = await _render(transparent, opacity: opacity);
          for (int channel = 0; channel < 4; channel++) {
            expect(layer.channel(256, 256, channel), 0,
                reason:
                    'transparent snapshot must not create an opaque center');
          }
          expect(layer.channel(464, 256, 3), greaterThan(0),
              reason: 'outer glow is independent of the sampled surface alpha');
          final _Pixels composite = await _render(transparent,
              opacity: opacity, backdrop: const Color(0xFF2A8C6F));
          for (int channel = 0; channel < 4; channel++) {
            expect(composite.channel(256, 256, channel),
                <int>[42, 140, 111, 255][channel],
                reason:
                    'the real host backdrop must remain visible through the center');
          }
        }
      } finally {
        transparent.dispose();
      }
    });
  });

  testWidgets(
      'actual shader matches first-preview lighting, cold tint and independent glow in both themes',
      (tester) async {
    await tester.runAsync(() async {
      const Color color = Color(0xFF204060);
      final ui.Image background =
          await _image((Canvas c) => c.drawPaint(Paint()..color = color));
      try {
        for (final bool dark in <bool>[false, true]) {
          for (final bool distorted in <bool>[false, true]) {
            for (final double opacity in <double>[1, .37]) {
              const Offset direction = Offset(.6, -.8);
              final double deform = distorted ? .936 : 0;
              final double wobble = distorted ? .55 : 0;
              final _Pixels pixels = await _render(background,
                  dark: dark,
                  radius: 100,
                  direction: direction,
                  deform: deform,
                  wobble: wobble,
                  opacity: opacity);
              for (int angle = 0; angle < 12; angle++) {
                for (final double r in <double>[
                  .3,
                  .84,
                  .943,
                  .973,
                  .992,
                  1,
                  1.015,
                  1.04,
                  1.08
                ]) {
                  final double theta = angle * math.pi / 6;
                  final int x = (256 + 100 * r * math.cos(theta)).floor();
                  final int y = (256 + 100 * r * math.sin(theta)).floor();
                  final List<double> expected = _referencePixel(
                      Offset(x + .5, y + .5),
                      sample: (_) => <double>[32 / 255, 64 / 255, 96 / 255],
                      radius: 100,
                      direction: direction,
                      deform: deform,
                      wobble: wobble,
                      dark: dark,
                      opacity: opacity);
                  for (int channel = 0; channel < 4; channel++) {
                    expect(pixels.channel(x.toDouble(), y.toDouble(), channel),
                        closeTo(expected[channel], 2),
                        reason:
                            'dark=$dark distorted=$distorted opacity=$opacity theta=$theta r=$r channel=$channel');
                  }
                }
              }
            }
          }
        }
        final _Pixels light = await _render(background);
        final _Pixels dark = await _render(background, dark: true);
        expect(light.channel(256, 256, 2) - dark.channel(256, 256, 2),
            inInclusiveRange(1, 2),
            reason: 'dark halves the cold tint in actual shader pixels');
        final ui.Image black = await _image(
            (Canvas c) => c.drawPaint(Paint()..color = Colors.black));
        try {
          final _Pixels blackPixels = await _render(black);
          for (int channel = 0; channel < 4; channel++) {
            expect(light.channel(464, 256, channel),
                blackPixels.channel(464, 256, channel),
                reason:
                    'outer glow color must be independent of sampled glass');
          }
        } finally {
          black.dispose();
        }
      } finally {
        background.dispose();
      }
    });
  });

  test(
      '23 float contract appends R7 material after unchanged R3 slots; GLES condition retained',
      () {
    final String source = readComponentSource('shaders/orb_lens.frag');
    final List<String> slots = <String>[
      for (final RegExpMatch m
          in RegExp(r'^uniform (vec2|float) (\w+);', multiLine: true)
              .allMatches(source))
        for (int i = 0; i < (m.group(1) == 'vec2' ? 2 : 1); i++) m.group(2)!,
    ];
    expect(slots, <String>[
      'uImageSize',
      'uImageSize',
      'uOffset',
      'uOffset',
      'uScale',
      'uCenter',
      'uCenter',
      'uRadius',
      'uDirection',
      'uDirection',
      'uDeform',
      'uWobble',
      'uMagnification',
      'uRimStrength',
      'uOpacity',
      'uLocalSize',
      'uLocalSize',
      'uDark',
      'uHalfSize',
      'uHalfSize',
      'uHandleMix',
      'uMist',
      'uIdleMix'
    ]);
    expect(
        orbLensUniformValues(
            imageSize: const Size(800, 600),
            imageOffset: const Offset(20, 30),
            pixelRatio: 1.5,
            center: const Offset(70, 90),
            radiusPx: 52,
            direction: const Offset(.6, -.8),
            deform: .9 * .72,
            wobble: -.3,
            opacity: .8,
            dark: true,
            localSize: const Size(166.4, 166.4)),
        <double>[
          800,
          600,
          20,
          30,
          1.5,
          70,
          90,
          52,
          .6,
          -.8,
          .9 * .72,
          -.3,
          1.62,
          .64,
          .8,
          166.4,
          166.4,
          1,
          52,
          52,
          0,
          0,
          0
        ]);
    expect(
        orbLensUniformValues(
                imageSize: Size.zero,
                imageOffset: Offset.zero,
                pixelRatio: 1,
                center: Offset.zero,
                radiusPx: 52)
            .last,
        0);
    expect(
        source,
        contains(
            'defined(IMPELLER_TARGET_OPENGLES) && !defined(IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED)'));
    expect(source, contains('uv.y = 1.0 - uv.y;'));
    expect(source, contains('uImageSize - vec2(.5)'));
  });
}
