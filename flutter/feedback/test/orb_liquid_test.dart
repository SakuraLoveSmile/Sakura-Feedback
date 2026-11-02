import 'dart:math' as math;
import 'package:feedback_widget/src/orb_liquid.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // R2 explicitly returns to first-preview dynamics. Fourier caps/area
  // assertions describe the superseded R1 shape and are replaced here.
  test('fixed step is independent of ordinary frame subdivision', () {
    final OrbLiquid a = OrbLiquid()..target = const Offset(140, -60);
    final OrbLiquid b = OrbLiquid()..target = a.target;
    for (int i = 0; i < 60; i++) {
      a.advance(1 / 60, moving: true);
    }
    for (int i = 0; i < 240; i++) {
      b.advance(1 / 240, moving: true);
    }
    expect((a.position - b.position).distance, lessThan(1e-8));
    expect(a.deform, closeTo(b.deform, 1e-8));
    expect(a.direction, b.direction);
    expect(a.radius, closeTo(b.radius, 1e-8));
  });

  test('drag spring is 290/24, release spring is 240/19, d is deform*.72', () {
    const double dt = 1 / 240;
    final OrbLiquid liquid = OrbLiquid()..target = const Offset(200, 60);
    liquid.advance(dt, moving: true);
    final Offset velocity = const Offset(200, 60) * (290 * dt);
    expect(liquid.velocity, velocity);
    expect(liquid.position, velocity * dt);
    expect(liquid.direction, velocity / velocity.distance);
    expect(liquid.deform,
        closeTo(math.min(velocity.distance / 530, 1.3) * dt * 12, 1e-12));
    expect(liquid.shaderDeform, liquid.deform * .72);
    expect(liquid.radius, closeTo(52 + 2 * dt * 12, 1e-12));
    final Offset releaseV = velocity +
        ((liquid.target - liquid.position) * 240 - velocity * 19) * dt;
    liquid.advance(dt, moving: false);
    expect(liquid.velocity, releaseV);
    expect(
        liquid.wobble, closeTo(math.sin(dt * 23) * math.exp(-dt * 6), 1e-12));
    expect(liquid.deform, greaterThan(0),
        reason: 'release keeps speed-driven deformation');
    liquid.advance(dt, moving: true);
    expect(liquid.wobble, 0, reason: 'a new press resets the release wobble');
  });

  test('inertia, release wobble and radius converge without an idle ticker',
      () {
    final OrbLiquid liquid = OrbLiquid()..target = const Offset(200, 60);
    liquid.advance(1 / 60, moving: true);
    expect(liquid.position.dx, inExclusiveRange(0, 200));
    for (int i = 0; i < 180; i++) {
      liquid.target = Offset(200 * math.cos(i / 8), 150 * math.sin(i / 11));
      liquid.advance(1 / 60, moving: true);
      expect(liquid.deform, inInclusiveRange(0, 1.3));
      expect(liquid.radius, inInclusiveRange(52, 54));
    }
    liquid.advance(.032, moving: false);
    expect(liquid.wobble, isNot(0));
    for (int i = 0; i < 600; i++) {
      liquid.advance(1 / 60, moving: false);
    }
    expect(liquid.settled, isTrue);
    expect(liquid.position, liquid.target);
    expect(liquid.velocity, Offset.zero);
    expect(liquid.deform, 0);
    expect(liquid.wobble, 0);
    expect(liquid.radius, 52);
  });

  test(
      'long frames clamp to .032s; reduced motion and cancellation clear energy',
      () {
    final OrbLiquid a = OrbLiquid()..target = const Offset(200, 0);
    final OrbLiquid b = OrbLiquid()..target = a.target;
    a.advance(10, moving: true);
    b.advance(.032, moving: true);
    expect(a.position, b.position);
    a.advance(0, moving: true, reducedMotion: true);
    expect(a.position, a.target);
    expect(a.velocity, Offset.zero);
    expect(a.deform, 0);
    expect(a.wobble, 0);
    expect(a.radius, 52);
    expect(a.settled, isTrue);
    a.reset();
    expect(a.position, Offset.zero);
    expect(a.target, Offset.zero);
  });

  test(
      'radial boundary satisfies the original q-space equation and rotates with axis',
      () {
    const Offset direction = Offset(.6, -.8);
    const double d = 1.3 * .72, wobble = .55;
    final double rotation = math.atan2(direction.dy, direction.dx);
    for (int i = 0; i < 64; i++) {
      final double theta = i * 2 * math.pi / 64;
      final double shape = orbLiquidContour(theta, direction, d, wobble);
      final Offset p = Offset(math.cos(theta), math.sin(theta)) * shape;
      const double stretch = 1 + d * .20;
      final double x = (p.dx * .6 - p.dy * .8) / stretch;
      final double y = (p.dx * .8 + p.dy * .6) * math.sqrt(stretch);
      final double a = math.atan2(y, x);
      final double contour = 1 +
          d * (.045 * math.cos(3 * a) - .035 * math.cos(a)) +
          wobble * .028 * math.cos(2 * a + .7);
      expect(math.sqrt(x * x + y * y) / contour, closeTo(1, 1e-12));
      expect(
          shape,
          closeTo(
              orbLiquidContour(theta - rotation, const Offset(1, 0), d, wobble),
              1e-12));
    }
    expect(
        orbLiquidContour(0, const Offset(1, 0), d, wobble),
        isNot(closeTo(
            orbLiquidContour(math.pi, const Offset(1, 0), d, wobble), .001)));
    expect(orbLiquidContour(0, Offset.zero, 0, 0), 1);
  });
}
