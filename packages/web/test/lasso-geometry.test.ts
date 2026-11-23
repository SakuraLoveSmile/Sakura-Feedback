import { describe, expect, it } from 'vitest';
import { lassoBoundingRect, simplifyPath } from '../src/region';

const viewport = { width: 400, height: 300 };

describe('lasso geometry', () => {
  it('empty path yields the minimal square at the origin', () => {
    expect(lassoBoundingRect([], viewport)).toEqual({ x: 0, y: 0, width: 64, height: 64 });
  });

  it('single point expands to the minimal square centered on the point', () => {
    expect(lassoBoundingRect([{ x: 200, y: 150 }], viewport)).toEqual({ x: 168, y: 118, width: 64, height: 64 });
  });

  it('tiny loop expands to minimal size around the bbox center', () => {
    const rect = lassoBoundingRect([
      { x: 200, y: 150 }, { x: 210, y: 156 }, { x: 204, y: 162 }, { x: 198, y: 156 },
    ], viewport);
    expect(rect).toEqual({ x: 172, y: 124, width: 64, height: 64 });
  });

  it('diagonal stroke pads the bounding box by 8px', () => {
    expect(lassoBoundingRect([{ x: 50, y: 50 }, { x: 150, y: 130 }], viewport)).toEqual({ x: 42, y: 42, width: 116, height: 96 });
  });

  it('clamps an oversized loop to the viewport', () => {
    expect(lassoBoundingRect([{ x: -40, y: -20 }, { x: 520, y: 380 }], viewport)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('keeps a loop near the bottom-right corner inside the viewport', () => {
    expect(lassoBoundingRect([{ x: 390, y: 290 }, { x: 399, y: 299 }], viewport)).toEqual({ x: 336, y: 236, width: 64, height: 64 });
  });

  it('ignores non-finite samples and simplifies dense paths', () => {
    expect(lassoBoundingRect([{ x: NaN, y: 10 }, { x: 80, y: 80 }], viewport)).toEqual({ x: 48, y: 48, width: 64, height: 64 });
    expect(simplifyPath([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
  });

  it('accepts explicit pad and min overrides', () => {
    expect(lassoBoundingRect([{ x: 100, y: 100 }, { x: 200, y: 150 }], viewport, { pad: 0, min: 0 })).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it('handles a 1px viewport without producing invalid sizes', () => {
    expect(lassoBoundingRect([{ x: 5, y: 5 }], { width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
