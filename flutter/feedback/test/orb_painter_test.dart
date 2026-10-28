import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter_test/flutter_test.dart';

const int _pixelRatio = 4;
final Map<double, double> _radialProfile = <double, double>{
  0.26: 0.11,
  0.44: 0.09,
  0.53: 0.17,
  0.62: 0.22,
  0.70: 0.35,
  0.79: 0.54,
  0.84: 0.67,
  0.88: 0.81,
  0.92: 0.94,
};
const List<double> _dispersionRadii = <double>[1.04, 1.12, 1.25];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final double angle in <double>[0, math.pi / 2]) {
    test('84dp pull=1 dragAngle=$angle white-ring rising half-height ratio',
        () async {
      final _Frame frame = await _render(
        orbSize: 84,
        pull: 1,
        dragAngle: angle,
        flow: 0.5,
        transparentBackground: true,
        dispersionOpacity: 0,
        pixelRatio: 16,
      );
      final double horizontal = _halfHeightRadius(frame, 0) * 42;
      final double vertical = _halfHeightRadius(frame, 90) * 42;
      final double ratio = horizontal / vertical;
      final double expected = angle == 0 ? 1.04 : 1 / 1.04;
      expect(ratio, closeTo(expected, 0.01));
      _log('T4-5 STRETCH angle=$angle radius0=$horizontal '
          'radius90=$vertical ratio=$ratio expected=$expected tolerance=0.01');
    });
  }

  for (final ui.Brightness brightness in ui.Brightness.values) {
    final String theme = brightness.name;
    late _Frame idle;
    late _Frame pressed;
    late _Frame dispersionOff;
    late _Frame transparent;
    late _Frame edgeProfile;

    group('$theme material', () {
      setUpAll(() async {
        idle = await _render(brightness: brightness, dispersionOpacity: 1.0);
        dispersionOff =
            await _render(brightness: brightness, dispersionOpacity: 0.0);
        pressed = await _render(brightness: brightness, stateScale: 0.94);
        transparent =
            await _render(brightness: brightness, transparentBackground: true);
        // At 4x, the 3x3 window at 0.99R still straddles the circle's hard edge.
        edgeProfile = await _render(brightness: brightness, pixelRatio: 16);
        final _Pixel warm = idle.sample(1.12, 30);
        final _Pixel cyan = idle.sample(1.12, 210);
        for (final MapEntry<double, double> point in _radialProfile.entries) {
          final double actual = idle.alpha(point.key, 330);
          final double error = actual - point.value;
          _log('ORB_PROFILE $theme r=${point.key.toStringAsFixed(2)} '
              'alpha=${actual.toStringAsFixed(5)} '
              'expected=${point.value.toStringAsFixed(2)} '
              'error=${error.toStringAsFixed(5)} pass=${error.abs() <= 0.05}');
        }
        for (final double radius in <double>[0.95, 0.99, 1.30]) {
          final _Frame frame = radius == 0.99 ? edgeProfile : idle;
          final double actual = frame.alpha(radius, 330);
          final bool pass = radius == 1.30 ? actual <= 0.03 : actual >= 0.95;
          _log('ORB_PROFILE $theme r=${radius.toStringAsFixed(2)} '
              'alpha=${actual.toStringAsFixed(5)} '
              'expected=${radius == 1.30 ? "<=0.03" : ">=0.95"} pass=$pass '
              'sampling=${radius == 0.99 ? 16 : _pixelRatio}x window=3x3');
        }
        for (final double radius in _dispersionRadii) {
          final double on = idle.meanL(radius);
          final double off = dispersionOff.meanL(radius);
          final double delta = on - off;
          _log('ORB_DISPERSION $theme r=${radius.toStringAsFixed(2)} '
              'meanL_on=${on.toStringAsFixed(5)} '
              'meanL_off=${off.toStringAsFixed(5)} '
              'meanDeltaL=${delta.toStringAsFixed(5)} pass=${delta.abs() <= 8}');
        }
        _log('ORB_SAMPLE $theme bgL=${idle.backgroundL.toStringAsFixed(3)} '
            'centerL=${idle.sample(0, 0).l.toStringAsFixed(3)} '
            'centerAlpha=${idle.alpha(0, 330).toStringAsFixed(5)} '
            'maxL(r<.80)=${idle.maxInnerL.toStringAsFixed(3)} '
            'split=${(cyan.blueMinusRed - warm.blueMinusRed).toStringAsFixed(3)} '
            'B-R[30,210]=${warm.blueMinusRed.toStringAsFixed(3)},${cyan.blueMinusRed.toStringAsFixed(3)} '
            'pressedAlpha(.893)=${pressed.alpha(0.893, 330).toStringAsFixed(5)} '
            'pressedWindowPeak=${_pressedWindowPeak(pressed).toStringAsFixed(5)} '
            'pressedAlpha(.95)=${pressed.alpha(0.95, 330).toStringAsFixed(5)}');
      });

      test('clear glass center preserves background luminance', () {
        expect((idle.sample(0, 0).l - idle.backgroundL).abs(),
            lessThanOrEqualTo(3));
      });

      test('radial white ring matches the complete section 12.2 profile', () {
        for (final MapEntry<double, double> point in _radialProfile.entries) {
          expect(idle.alpha(point.key, 330), closeTo(point.value, 0.05),
              reason: '$theme alpha at ${point.key}R, image angle 330 degrees');
        }
        expect(idle.alpha(0.95, 330), greaterThanOrEqualTo(0.95));
        expect(edgeProfile.alpha(0.99, 330), greaterThanOrEqualTo(0.95));
        expect(idle.alpha(1.30, 330), lessThanOrEqualTo(0.03));
      });

      test('no independent highlight inside 0.80R', () {
        expect(idle.maxInnerL, lessThan(245));
      });

      test(
          'bipolar dispersion has warm and cyan poles without square boundaries',
          () {
        final List<double> diagonals = <double>[45, 135, 225, 315]
            .map((double angle) => transparent.opacity(1.60, angle))
            .toList();
        final double outerMaximum = transparent.maxOuterAlpha;
        _log('ORB_BOUNDARY $theme r=1.60 angles=[45,135,225,315] '
            'alpha=${diagonals.map((double alpha) => alpha.toStringAsFixed(5)).join(",")} '
            'expected=<=0.02 pass=${diagonals.every((double alpha) => alpha <= 0.02)}');
        _log('ORB_BOUNDARY $theme r>1.55 gridStep=0.05R '
            'maxAlpha=${outerMaximum.toStringAsFixed(5)} '
            'expected=<=0.03 pass=${outerMaximum <= 0.03}');
        expect(diagonals, everyElement(lessThanOrEqualTo(0.02)),
            reason: '$theme 1.60R diagonal alpha=$diagonals');
        expect(outerMaximum, lessThanOrEqualTo(0.03),
            reason: '$theme maximum alpha outside 1.55R=$outerMaximum');
        final double warm = idle.sample(1.12, 30).blueMinusRed;
        final double cyan = idle.sample(1.12, 210).blueMinusRed;
        expect(cyan - warm, greaterThanOrEqualTo(40));
        expect(warm, lessThan(0));
        expect(cyan, greaterThan(0));
      });

      // 12.6.2 measures isolated layer contribution across the 1.04R–1.25R annulus;
      // peak-angle comparisons contradict the split requirement in 12.6.1.
      for (final double radius in _dispersionRadii) {
        test('isolated dispersion mean luminance stays neutral at ${radius}R',
            () {
          final double delta = idle.meanL(radius) - dispersionOff.meanL(radius);
          expect(delta.abs(), lessThanOrEqualTo(8),
              reason: '$theme meanDeltaL at ${radius}R=$delta (72 angles)');
        });
      }
      test('dispersion mean luminance has consistent signs across the annulus',
          () {
        final List<double> deltas = _dispersionRadii
            .map((double r) => idle.meanL(r) - dispersionOff.meanL(r))
            .toList();
        expect(
            deltas.every((double delta) => delta >= 0) ||
                deltas.every((double delta) => delta <= 0),
            isTrue,
            reason: '$theme annular meanDeltaL=$deltas');
      });

      test('stateScale 0.94 white-ring plateau contracts to about 0.893R', () {
        expect(pressed.alpha(0.893, 330), greaterThanOrEqualTo(0.95));
        expect(_pressedWindowPeak(pressed), greaterThanOrEqualTo(0.95));
        expect(pressed.alpha(0.95, 330), lessThan(idle.alpha(0.95, 330)));
      });

      test('flow rotates only white sweep, not the dispersion poles', () async {
        final _Frame rotated = await _render(brightness: brightness, flow: 0.5);
        for (final double angle in <double>[30, 120, 210]) {
          expect(rotated.sample(1.12, angle).red,
              closeTo(idle.sample(1.12, angle).red, 0.01));
          expect(rotated.sample(1.12, angle).blue,
              closeTo(idle.sample(1.12, angle).blue, 0.01));
        }
      });
    });
  }

  group('shouldRepaint', () {
    final OrbPainter baseline = _painter();
    final Map<String, OrbPainter> mutations = <String, OrbPainter>{
      'flow': _painter(flow: 0.5),
      'breath': _painter(breath: 0.5),
      'breathWeight': _painter(breathWeight: 0),
      'stateScale 0.94': _painter(stateScale: 0.94),
      'stateScale 1.04': _painter(stateScale: 1.04),
      'dragAngle': _painter(dragAngle: math.pi / 2),
      'pull': _painter(pull: 0.5),
      'glowOffset': _painter(glowOffset: const ui.Offset(-4, 0)),
      'brightness': _painter(brightness: ui.Brightness.dark),
      'dispersionOpacity': _painter(dispersionOpacity: 0.0),
    };
    for (final MapEntry<String, OrbPainter> entry in mutations.entries) {
      test('single ${entry.key} mutation repaints', () {
        expect(entry.value.shouldRepaint(baseline), isTrue);
      });
    }
    test('identical values do not repaint', () {
      expect(_painter().shouldRepaint(baseline), isFalse);
    });
    test('light to dark explicitly repaints', () {
      expect(_painter(brightness: ui.Brightness.dark).shouldRepaint(baseline),
          isTrue);
    });
  });

  if (const bool.fromEnvironment('ORB_WRITE_SAMPLES')) {
    test('export offscreen review samples', () async {
      final Directory directory = Directory('/tmp/orb-t4-2');
      await directory.create(recursive: true);
      for (final String name in <String>['light', 'dark', 'light-pressed']) {
        await _render(
          brightness: name == 'dark' ? ui.Brightness.dark : ui.Brightness.light,
          flow: 0.25,
          breath: 0.5,
          stateScale: name == 'light-pressed' ? 0.94 : 1.0,
          canvasSize: 112,
          pngPath: '${directory.path}/$name.png',
        );
      }
    });
  }
}

void _log(String message) {
  // ignore: avoid_print
  print(message);
}

double _halfHeightRadius(_Frame frame, double angle) {
  final double step = 1 / frame.orbitRadius;
  double previousRadius = 0.65;
  double previousAlpha = frame.opacity(previousRadius, angle);
  for (double radius = previousRadius + step; radius < 0.9; radius += step) {
    final double alpha = frame.opacity(radius, angle);
    if (previousAlpha < 0.5 && alpha >= 0.5) {
      return previousRadius +
          (radius - previousRadius) *
              (0.5 - previousAlpha) /
              (alpha - previousAlpha);
    }
    previousRadius = radius;
    previousAlpha = alpha;
  }
  throw StateError('White-ring rising edge did not cross alpha 0.5');
}

double _pressedWindowPeak(_Frame frame) => <double>[
      0.883,
      0.888,
      0.893,
      0.898,
      0.903
    ].map((double r) => frame.alpha(r, 330)).reduce(math.max);

OrbPainter _painter({
  double flow = 0,
  double breath = 0,
  double breathWeight = 1,
  double stateScale = 1.0,
  double dragAngle = 0,
  double pull = 0,
  ui.Offset glowOffset = ui.Offset.zero,
  ui.Brightness brightness = ui.Brightness.light,
  double dispersionOpacity = 1.0,
}) =>
    OrbPainter(
      flow: flow,
      breath: breath,
      breathWeight: breathWeight,
      stateScale: stateScale,
      dragAngle: dragAngle,
      pull: pull,
      glowOffset: glowOffset,
      brightness: brightness,
      dispersionOpacity: dispersionOpacity,
    );

Future<_Frame> _render({
  ui.Brightness brightness = ui.Brightness.light,
  double flow = 0,
  double breath = 0,
  double stateScale = 1.0,
  double dragAngle = 0,
  double pull = 0,
  double dispersionOpacity = 1.0,
  bool transparentBackground = false,
  int pixelRatio = _pixelRatio,
  int canvasSize = 160,
  double orbSize = 56,
  String? pngPath,
}) async {
  final ui.Color background = brightness == ui.Brightness.light
      ? const ui.Color(0xFFC9C9C9)
      : const ui.Color(0xFF202020);
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.scale(pixelRatio.toDouble());
  if (!transparentBackground) {
    canvas.drawColor(background, ui.BlendMode.src);
  }
  canvas.save();
  canvas.translate((canvasSize - orbSize) / 2, (canvasSize - orbSize) / 2);
  _painter(
    brightness: brightness,
    flow: flow,
    breath: breath,
    stateScale: stateScale,
    dragAngle: dragAngle,
    pull: pull,
    dispersionOpacity: dispersionOpacity,
  ).paint(canvas, ui.Size.square(orbSize));
  canvas.restore();
  final ui.Picture picture = recorder.endRecording();
  final int pixels = canvasSize * pixelRatio;
  final ui.Image image;
  try {
    image = await picture.toImage(pixels, pixels);
  } finally {
    picture.dispose();
  }
  try {
    if (pngPath != null) {
      await _writePng(image, pngPath);
    }
    final ByteData? data =
        await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    if (data == null) {
      throw StateError('rawRgba conversion failed');
    }
    return _Frame(
      Uint8List.fromList(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes)),
      pixels,
      orbSize * pixelRatio / 2,
      brightness == ui.Brightness.light ? 201 : 32,
    );
  } finally {
    image.dispose();
  }
}

Future<void> _writePng(ui.Image source, String path) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.drawImageRect(
    source,
    ui.Rect.fromLTWH(0, 0, source.width.toDouble(), source.height.toDouble()),
    const ui.Rect.fromLTWH(0, 0, 224, 224),
    ui.Paint()..filterQuality = ui.FilterQuality.high,
  );
  final ui.Picture picture = recorder.endRecording();
  final ui.Image image;
  try {
    image = await picture.toImage(224, 224);
  } finally {
    picture.dispose();
  }
  try {
    final ByteData? png =
        await image.toByteData(format: ui.ImageByteFormat.png);
    if (png == null) {
      throw StateError('PNG conversion failed');
    }
    await File(path).writeAsBytes(
        png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes));
    _log('ORB_PNG $path ${image.width}x${image.height} '
        'source=${source.width}x${source.height} sampling=4x margin=28dp');
  } finally {
    image.dispose();
  }
}

class _Frame {
  const _Frame(this.bytes, this.canvasSize, this.orbitRadius, this.backgroundL);

  final Uint8List bytes;
  final int canvasSize;
  final double orbitRadius;
  final double backgroundL;

  _Pixel pixel(int x, int y) {
    final int index = (y * canvasSize + x) * 4;
    return _Pixel(bytes[index].toDouble(), bytes[index + 1].toDouble(),
        bytes[index + 2].toDouble());
  }

  _Pixel sample(double radius, double imageAngle) {
    final double angle = imageAngle * math.pi / 180;
    final int x =
        (canvasSize / 2 + radius * orbitRadius * math.cos(angle) - 0.5).round();
    final int y =
        (canvasSize / 2 + radius * orbitRadius * math.sin(angle) - 0.5).round();
    double red = 0;
    double green = 0;
    double blue = 0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        final _Pixel value = pixel(x + dx, y + dy);
        red += value.red;
        green += value.green;
        blue += value.blue;
      }
    }
    return _Pixel(red / 9, green / 9, blue / 9);
  }

  double alpha(double radius, double angle) =>
      (sample(radius, angle).l - backgroundL) / (255 - backgroundL);

  double opacity(double radius, double imageAngle) {
    final double angle = imageAngle * math.pi / 180;
    final int x =
        (canvasSize / 2 + radius * orbitRadius * math.cos(angle) - 0.5).round();
    final int y =
        (canvasSize / 2 + radius * orbitRadius * math.sin(angle) - 0.5).round();
    double total = 0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        total += bytes[((y + dy) * canvasSize + x + dx) * 4 + 3] / 255;
      }
    }
    return total / 9;
  }

  double get maxOuterAlpha {
    double maximum = 0;
    final double center = canvasSize / 2;
    final double limit = orbitRadius * 1.55;
    final double step = orbitRadius * 0.05;
    for (double y = 0; y < canvasSize; y += step) {
      for (double x = 0; x < canvasSize; x += step) {
        final int px = x.floor();
        final int py = y.floor();
        final double dx = px + 0.5 - center;
        final double dy = py + 0.5 - center;
        if (dx * dx + dy * dy > limit * limit) {
          maximum =
              math.max(maximum, bytes[(py * canvasSize + px) * 4 + 3] / 255);
        }
      }
    }
    return maximum;
  }

  double meanL(double radius) {
    double total = 0;
    for (int index = 0; index < 72; index++) {
      total += sample(radius, index * 5.0).l;
    }
    return total / 72;
  }

  double get maxInnerL {
    double maximum = 0;
    final double center = canvasSize / 2;
    final double limit = orbitRadius * 0.8;
    for (int y = (center - limit).floor(); y <= (center + limit).ceil(); y++) {
      for (int x = (center - limit).floor();
          x <= (center + limit).ceil();
          x++) {
        final double dx = x + 0.5 - center;
        final double dy = y + 0.5 - center;
        if (dx * dx + dy * dy < limit * limit) {
          maximum = math.max(maximum, pixel(x, y).l);
        }
      }
    }
    return maximum;
  }
}

class _Pixel {
  const _Pixel(this.red, this.green, this.blue);

  final double red;
  final double green;
  final double blue;

  double get l => 0.299 * red + 0.587 * green + 0.114 * blue;
  double get blueMinusRed => blue - red;
}
