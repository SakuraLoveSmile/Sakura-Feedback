import 'dart:math' as math;
import 'dart:ui';

/// R2 first-preview motion, integrated at 240 Hz across ordinary frame rates.
class OrbLiquid {
  Offset position = Offset.zero;
  Offset target = Offset.zero;
  Offset velocity = Offset.zero;
  Offset direction = const Offset(1, 0);
  double deform = 0;
  double wobble = 0;
  double radius = 52;
  double _accumulator = 0;
  double? _releaseElapsed;
  bool _wasMoving = false;

  double get shaderDeform => deform * .72;
  bool get settled =>
      (target - position).distance < .03 &&
      velocity.distance < .2 &&
      deform < .002 &&
      (_releaseElapsed == null || _releaseElapsed! > 1.1) &&
      (radius - 52).abs() < .002;

  void reset([Offset at = Offset.zero]) {
    position = target = at;
    velocity = Offset.zero;
    direction = const Offset(1, 0);
    deform = wobble = _accumulator = 0;
    radius = 52;
    _releaseElapsed = null;
    _wasMoving = false;
  }

  void advance(double elapsed,
      {required bool moving, bool reducedMotion = false}) {
    if (reducedMotion) {
      reset(target);
      return;
    }
    if (moving) {
      _releaseElapsed = null;
      wobble = 0;
    } else if (_wasMoving) {
      _releaseElapsed = 0;
    }
    _wasMoving = moving;
    const double dt = 1 / 240;
    _accumulator += elapsed.clamp(0, .032);
    while (_accumulator + 1e-12 >= dt) {
      velocity += ((target - position) * (moving ? 290 : 240) -
              velocity * (moving ? 24 : 19)) *
          dt;
      position += velocity * dt;
      final double speed = velocity.distance;
      if (speed > 12) direction = velocity / speed;
      deform += (math.min(speed / 530, 1.3) - deform) * math.min(dt * 12, 1);
      radius += ((moving ? 54 : 52) - radius) * math.min(dt * 12, 1);
      if (_releaseElapsed != null) {
        _releaseElapsed = _releaseElapsed! + dt;
        wobble = orbReleaseWobble(_releaseElapsed!);
      }
      _accumulator -= dt;
    }
    if (!moving && settled) {
      position = target;
      velocity = Offset.zero;
      deform = wobble = 0;
      radius = 52;
      _releaseElapsed = null;
    }
  }
}

double orbReleaseWobble(double elapsed) =>
    math.sin(elapsed * 23) * math.exp(-elapsed * 6);

double orbSmoothstep(double start, double end, double value) {
  final double p = ((value - start) / (end - start)).clamp(0, 1);
  return p * p * (3 - 2 * p);
}

/// First-preview circular source radius: continuously increasing through the
/// edge. The seventh-power bend clamps, while the original offset does not.
double orbLiquidSourceRadius(double radius, {double magnification = 1.62}) {
  final double r = math.max(0, radius);
  return r * (1 / magnification + .54 * math.pow(r.clamp(0, 1), 7));
}

/// Radial boundary of the original stretched q-space contour. Deform is d,
/// already multiplied by .72, exactly like the shader uniform.
double orbLiquidContour(
    double angle, Offset direction, double deform, double wobble) {
  final Offset axis = direction.distanceSquared > 1e-12
      ? direction / direction.distance
      : const Offset(1, 0);
  final Offset radial = Offset(math.cos(angle), math.sin(angle));
  final double stretch = 1 + deform * .20;
  final double x = (radial.dx * axis.dx + radial.dy * axis.dy) / stretch;
  final double y =
      (-radial.dx * axis.dy + radial.dy * axis.dx) * math.sqrt(stretch);
  final double a = math.atan2(y, x);
  final double contour = 1 +
      deform * (.045 * math.cos(3 * a) - .035 * math.cos(a)) +
      wobble * .028 * math.cos(2 * a + .7);
  return contour / math.sqrt(x * x + y * y);
}
