import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:feedback_widget/src/orb.dart';
import 'package:flutter_test/flutter_test.dart';

const int _canvasPixels = 640;
const double _canvasSize = 640;
const double _pixelRatio = 2;
const double _flow = 0.25;
const double _breath = 0.5;
const double _ringSampleRadius = 0.97;
const double _ringSampleAngle = 330;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('writes the orb screenshot matrix required by docs/orb-spec.md 10.2',
      () async {
    final Directory directory = _shotsDirectory();
    await directory.create(recursive: true);
    final List<_Shot> shots = _shots();
    final List<Map<String, Object?>> entries = <Map<String, Object?>>[];

    for (final _Shot shot in shots) {
      final Uint8List png = await _renderPng(shot);
      final File file = File('${directory.path}/${shot.file}');
      await file.writeAsBytes(png);
      final Uint8List written = await file.readAsBytes();
      await _verifyPng(written, shot);
      entries.add(shot.toManifest());
      _log('ORB_SHOT ${shot.file} d=${_round(shot.diameter)} '
          'stateScale=${shot.stateScale} breathWeight=${shot.breathWeight} '
          'pull=${_round(shot.pull)} '
          'pullRaw=${_round(shot.pullRaw ?? shot.pull)} '
          'glow=${_round(shot.glowOffset.dx)},'
          '${_round(shot.glowOffset.dy)} bytes=${written.length}');
    }

    expect(shots, hasLength(10));
    expect(
      shots.map((_Shot shot) => shot.file).toList(),
      <String>[
        'light-idle.png',
        'light-hover.png',
        'light-pressed.png',
        'light-dragging.png',
        'light-releasing.png',
        'dark-idle.png',
        'dark-hover.png',
        'dark-pressed.png',
        'dark-dragging.png',
        'dark-releasing.png',
      ],
    );

    final Map<String, Object?> manifest = <String, Object?>{
      'generatedAt': DateTime.now().toUtc().toIso8601String(),
      'canvas': <String, Object?>{
        'width': _canvasPixels,
        'height': _canvasPixels,
        'scale': _pixelRatio,
      },
      'fixture': <String, Object?>{'flow': _flow, 'breath': _breath},
      'shots': entries,
    };
    final File manifestFile = File('${directory.path}/manifest.json');
    await manifestFile.writeAsString(
        '${const JsonEncoder.withIndent('  ').convert(manifest)}\n');

    final Object? parsed = jsonDecode(await manifestFile.readAsString());
    expect(parsed, isA<Map<String, Object?>>());
    final Map<String, Object?> decoded = parsed! as Map<String, Object?>;
    expect(decoded['generatedAt'], isA<String>());
    final List<Object?> decodedShots = decoded['shots']! as List<Object?>;
    expect(decodedShots, hasLength(10));
    const List<String> requiredKeys = <String>[
      'file',
      'background',
      'brightness',
      'd',
      'stateScale',
      'breathWeight',
      'dragAngle',
      'pull',
      'pullRaw',
      'pullClamped',
      'glowOffset',
      'flow',
      'breath',
      'p',
      'note',
    ];
    for (int index = 0; index < decodedShots.length; index++) {
      final Map<String, Object?> entry =
          decodedShots[index]! as Map<String, Object?>;
      for (final String key in requiredKeys) {
        expect(entry.containsKey(key), isTrue,
            reason: '${shots[index].file} manifest lacks $key');
      }
      expect(entry['file'], shots[index].file);
      expect((entry['glowOffset']! as Map<String, Object?>).keys.toSet(),
          <String>{'dx', 'dy'});
    }
    expect((decodedShots[0]! as Map<String, Object?>)['p'], isNull);
    final Map<String, Object?> releasing =
        decodedShots[4]! as Map<String, Object?>;
    expect(releasing['p'], isA<num>());
    expect(releasing['d'], closeTo(54.872333, 1e-6));
    expect(releasing['pull'], 0.0);
    expect(releasing['pullRaw'], closeTo(-0.040274, 1e-6));
    expect(releasing['pullClamped'], isTrue);
    expect(releasing['note'], isA<String>());
    expect((releasing['glowOffset']! as Map<String, Object?>)['dx'], 0.0);
    expect((releasing['glowOffset']! as Map<String, Object?>)['dy'], 0.0);
    expect((decodedShots[0]! as Map<String, Object?>)['pullClamped'], isFalse);
    expect(manifestFile.readAsStringSync().contains(Directory.current.path),
        isFalse);
    _log('ORB_SHOT_MANIFEST ${manifestFile.path}');
  });
}

List<_Shot> _shots() {
  final double p = kFeedbackOrbReleaseCurve.transform(0.5);
  final double releaseDiameter = kFeedbackOrbDraggingDiameter +
      (kFeedbackOrbIdleDiameter - kFeedbackOrbDraggingDiameter) * p;
  // 回弹过冲时组件用 safePull 把 pull 钳到 0..1，尺寸仍按曲线过冲。
  final double rawReleasePull = 1 - p;
  final double releasePull = rawReleasePull.clamp(0.0, 1.0).toDouble();
  final ui.Offset releaseGlow = orbGlowOffset(releasePull, 0);

  List<_Shot> forBrightness(ui.Brightness brightness) => <_Shot>[
        _Shot(
          file: '${brightness.name}-idle.png',
          state: 'idle',
          brightness: brightness,
          diameter: kFeedbackOrbIdleDiameter,
          stateScale: 1.0,
          breathWeight: 1.0,
          dragAngle: 0,
          pull: 0,
          glowOffset: ui.Offset.zero,
        ),
        _Shot(
          file: '${brightness.name}-hover.png',
          state: 'hover',
          brightness: brightness,
          diameter: kFeedbackOrbIdleDiameter,
          stateScale: kFeedbackOrbHoverScale,
          breathWeight: 0,
          dragAngle: 0,
          pull: 0,
          glowOffset: ui.Offset.zero,
        ),
        _Shot(
          file: '${brightness.name}-pressed.png',
          state: 'pressed',
          brightness: brightness,
          diameter: kFeedbackOrbIdleDiameter,
          stateScale: kFeedbackOrbPressedScale,
          breathWeight: 0,
          dragAngle: 0,
          pull: 0,
          glowOffset: ui.Offset.zero,
        ),
        _Shot(
          file: '${brightness.name}-dragging.png',
          state: 'dragging',
          brightness: brightness,
          diameter: kFeedbackOrbDraggingDiameter,
          stateScale: 1.0,
          breathWeight: 0,
          dragAngle: 0,
          pull: 1,
          glowOffset: orbGlowOffset(1, 0),
        ),
        _Shot(
          file: '${brightness.name}-releasing.png',
          state: 'releasing',
          brightness: brightness,
          diameter: releaseDiameter,
          stateScale: 1.0,
          breathWeight: 0,
          dragAngle: 0,
          pull: releasePull,
          pullRaw: rawReleasePull,
          glowOffset: releaseGlow,
          release: p,
          note: '组件在回弹中把 pull 钳到 0..1，尺寸仍按曲线过冲',
        ),
      ];

  return <_Shot>[
    ...forBrightness(ui.Brightness.light),
    ...forBrightness(ui.Brightness.dark),
  ];
}

Future<Uint8List> _renderPng(_Shot shot) async {
  final ui.Color background = shot.background;
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final ui.Canvas canvas = ui.Canvas(recorder);
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, _canvasSize, _canvasSize),
    ui.Paint()..color = background,
  );
  canvas.translate(_canvasSize / 2, _canvasSize / 2);
  canvas.scale(_pixelRatio);
  // painter centers itself inside the given size box, so place that box first.
  canvas.translate(-shot.diameter / 2, -shot.diameter / 2);
  OrbPainter(
    flow: _flow,
    breath: _breath,
    breathWeight: shot.breathWeight,
    stateScale: shot.stateScale,
    dragAngle: shot.dragAngle,
    pull: shot.pull,
    glowOffset: shot.glowOffset,
    brightness: shot.brightness,
  ).paint(canvas, ui.Size.square(shot.diameter));
  final ui.Picture picture = recorder.endRecording();
  final ui.Image image;
  try {
    image = await picture.toImage(_canvasPixels, _canvasPixels);
  } finally {
    picture.dispose();
  }
  try {
    final ByteData? png =
        await image.toByteData(format: ui.ImageByteFormat.png);
    if (png == null) {
      throw StateError('PNG conversion failed for ${shot.file}');
    }
    return Uint8List.fromList(
        png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes));
  } finally {
    image.dispose();
  }
}

Future<void> _verifyPng(Uint8List bytes, _Shot shot) async {
  expect(bytes.length, greaterThan(1000), reason: '${shot.file} is empty');
  final ui.Codec codec = await ui.instantiateImageCodec(bytes);
  final ui.FrameInfo frame = await codec.getNextFrame();
  final ui.Image image = frame.image;
  try {
    expect(image.width, _canvasPixels, reason: '${shot.file} width');
    expect(image.height, _canvasPixels, reason: '${shot.file} height');
    final ByteData? raw =
        await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    if (raw == null) {
      throw StateError('rawRgba conversion failed for ${shot.file}');
    }
    final Uint8List pixels = Uint8List.fromList(
        raw.buffer.asUint8List(raw.offsetInBytes, raw.lengthInBytes));
    final int width = image.width;
    final int height = image.height;
    final _Pixel background = _pixel(pixels, width, 4, 4);
    final _Pixel expectedBackground = _Pixel.fromColor(shot.background);
    expect(background.red, closeTo(expectedBackground.red, 1),
        reason: '${shot.file} background red');
    expect(background.green, closeTo(expectedBackground.green, 1),
        reason: '${shot.file} background green');
    expect(background.blue, closeTo(expectedBackground.blue, 1),
        reason: '${shot.file} background blue');
    expect(_alpha(pixels, width, width ~/ 2, height ~/ 2), 255,
        reason: '${shot.file} must stay opaque, not fully transparent');

    final double backgroundL = background.l;
    int maximumDelta = 0;
    for (int y = 0; y < height; y += 2) {
      for (int x = 0; x < width; x += 2) {
        final int delta = (_pixel(pixels, width, x, y).l - backgroundL).abs().round();
        maximumDelta = math.max(maximumDelta, delta);
      }
    }
    expect(maximumDelta, greaterThan(40),
        reason: '${shot.file} draws no visible orb');

    final double breathFactor = 1.0 + 0.02 * _breath * shot.breathWeight;
    final double visualRadius =
        shot.diameter * shot.stateScale * breathFactor;
    final ui.Offset ringPoint = ui.Offset(
      width / 2 + _ringSampleRadius * visualRadius * math.cos(_ringSampleAngle * math.pi / 180),
      height / 2 + _ringSampleRadius * visualRadius * math.sin(_ringSampleAngle * math.pi / 180),
    );
    final _Pixel ring = _meanPixel(
        pixels, width, height, ringPoint.dx, ringPoint.dy);
    expect((ring.l - backgroundL).abs(), greaterThan(20),
        reason: '${shot.file} white ring at 0.97R/330deg blends into background');

    // docs/orb-spec.md 12.3: the core is clear glass, so the center matches
    // the uniform backdrop instead of carrying its own fill.
    final _Pixel center =
        _pixel(pixels, width, width ~/ 2, height ~/ 2);
    expect((center.l - backgroundL).abs(), lessThanOrEqualTo(3),
        reason: '${shot.file} center is not clear glass');
  } finally {
    image.dispose();
    codec.dispose();
  }
}

_Pixel _pixel(Uint8List bytes, int width, int x, int y) {
  final int index = (y * width + x) * 4;
  return _Pixel(
    bytes[index].toDouble(),
    bytes[index + 1].toDouble(),
    bytes[index + 2].toDouble(),
  );
}

int _alpha(Uint8List bytes, int width, int x, int y) =>
    bytes[(y * width + x) * 4 + 3];

_Pixel _meanPixel(
    Uint8List bytes, int width, int height, double x, double y) {
  double red = 0;
  double green = 0;
  double blue = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      final int px = (x + dx).round().clamp(0, width - 1);
      final int py = (y + dy).round().clamp(0, height - 1);
      final _Pixel value = _pixel(bytes, width, px, py);
      red += value.red;
      green += value.green;
      blue += value.blue;
    }
  }
  return _Pixel(red / 9, green / 9, blue / 9);
}

Directory _shotsDirectory() {
  Directory directory = Directory.current.absolute;
  while (true) {
    if (Directory('${directory.path}/e2e/shots').existsSync()) {
      return Directory('${directory.path}/e2e/shots/orb-hyperos4/flutter');
    }
    final Directory parent = directory.parent;
    if (parent.path == directory.path) {
      throw StateError('Repository root with e2e/shots not found from '
          '${Directory.current.path}');
    }
    directory = parent;
  }
}

double _round(double value) => double.parse(value.toStringAsFixed(6)) + 0.0;

void _log(String message) {
  // ignore: avoid_print
  print(message);
}

class _Shot {
  const _Shot({
    required this.file,
    required this.state,
    required this.brightness,
    required this.diameter,
    required this.stateScale,
    required this.breathWeight,
    required this.dragAngle,
    required this.pull,
    required this.glowOffset,
    this.pullRaw,
    this.release,
    this.note,
  });

  final String file;
  final String state;
  final ui.Brightness brightness;
  final double diameter;
  final double stateScale;
  final double breathWeight;
  final double dragAngle;
  final double pull;
  final ui.Offset glowOffset;
  final double? pullRaw;
  final double? release;
  final String? note;

  ui.Color get background => brightness == ui.Brightness.light
      ? const ui.Color(0xFFC9C9C9)
      : const ui.Color(0xFF202020);

  Map<String, Object?> toManifest() => <String, Object?>{
        'file': file,
        'state': state,
        'background': brightness == ui.Brightness.light ? '#c9c9c9' : '#202020',
        'brightness': brightness.name,
        'd': _round(diameter),
        'stateScale': _round(stateScale),
        'breathWeight': _round(breathWeight),
        'dragAngle': _round(dragAngle),
        'pull': _round(pull),
        'pullRaw': _round(pullRaw ?? pull),
        'pullClamped': pullRaw != null && pullRaw != pull,
        'glowOffset': <String, Object?>{
          'dx': _round(glowOffset.dx),
          'dy': _round(glowOffset.dy),
        },
        'flow': _flow,
        'breath': _breath,
        'p': release == null ? null : _round(release!),
        'note': note,
      };
}

class _Pixel {
  const _Pixel(this.red, this.green, this.blue);

  factory _Pixel.fromColor(ui.Color color) {
    final int value = color.toARGB32();
    return _Pixel(
      ((value >> 16) & 0xFF).toDouble(),
      ((value >> 8) & 0xFF).toDouble(),
      (value & 0xFF).toDouble(),
    );
  }

  final double red;
  final double green;
  final double blue;

  double get l => 0.299 * red + 0.587 * green + 0.114 * blue;
}
