import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:feedback_widget/src/capture_selection.dart';

void main() {
  const Size viewport = Size(400, 300);

  test('empty path yields the minimal square at the origin', () {
    expect(lassoBoundingRect(const <Offset>[], viewport),
        const Rect.fromLTWH(0, 0, 64, 64));
  });

  test('single point expands to the minimal square centered on the point', () {
    expect(lassoBoundingRect(const <Offset>[Offset(200, 150)], viewport),
        const Rect.fromLTWH(168, 118, 64, 64));
  });

  test('tiny loop expands to minimal size around the bbox center', () {
    final Rect rect = lassoBoundingRect(const <Offset>[
      Offset(200, 150),
      Offset(210, 156),
      Offset(204, 162),
      Offset(198, 156),
    ], viewport);
    expect(rect, const Rect.fromLTWH(172, 124, 64, 64));
  });

  test('diagonal stroke pads the bounding box by 8px', () {
    expect(
        lassoBoundingRect(const <Offset>[Offset(50, 50), Offset(150, 130)],
            viewport),
        const Rect.fromLTWH(42, 42, 116, 96));
  });

  test('clamps an oversized loop to the viewport', () {
    expect(
        lassoBoundingRect(
            const <Offset>[Offset(-40, -20), Offset(520, 380)], viewport),
        const Rect.fromLTWH(0, 0, 400, 300));
  });

  test('keeps a loop near the bottom-right corner inside the viewport', () {
    expect(
        lassoBoundingRect(
            const <Offset>[Offset(390, 290), Offset(399, 299)], viewport),
        const Rect.fromLTWH(336, 236, 64, 64));
  });

  test('ignores non-finite samples and simplifies dense paths', () {
    expect(
        lassoBoundingRect(
            const <Offset>[Offset(double.nan, 10), Offset(80, 80)], viewport),
        const Rect.fromLTWH(48, 48, 64, 64));
    expect(
        simplifyLassoPath(const <Offset>[
          Offset(0, 0),
          Offset(1, 1),
          Offset(5, 0),
          Offset(10, 0),
        ]),
        const <Offset>[Offset(0, 0), Offset(5, 0), Offset(10, 0)]);
  });

  test('respects safe insets when clamping', () {
    expect(
        lassoBoundingRect(
            const <Offset>[Offset(4, 4), Offset(40, 40)],
            viewport,
            safeInsets: const EdgeInsets.fromLTRB(20, 30, 10, 10)),
        const Rect.fromLTWH(20, 30, 64, 64));
  });

  test('handles a 1px viewport without producing invalid sizes', () {
    expect(
        lassoBoundingRect(
            const <Offset>[Offset(5, 5)], const Size(1, 1)),
        const Rect.fromLTWH(0, 0, 1, 1));
  });
}
