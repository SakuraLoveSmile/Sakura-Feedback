/**
 * T1 局部选区纯几何与裁剪（验收 1）：
 * - 拖球至中央 / 四角 / 靠边时初始选区计算（含整体移回可见区域）；
 * - 最小 48×48 逻辑像素约束（移动、缩放、重新框选一律强制）；
 * - `capture.region` 归一化：0..1、相对原始捕获视口、x+width≤1 / y+height≤1；
 * - 归一化选区 → 冻结位图像素的裁剪换算（真实 PNG 字节像素断言）。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  MIN_REGION_SIZE,
  clampRegion,
  cropFrozenRegion,
  initialRegionSelection,
  moveRegion,
  normalizeRegion,
  regionFromDrag,
  regionToBitmapRect,
  resizeRegion,
} from '../src/region';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

const VP = { width: 1024, height: 768 };

beforeEach(() => {
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob);
    const c = {
      width: png.width,
      height: png.height,
      data: png.data,
      close: () => {},
      getContext: () => null,
    };
    return c;
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('初始选区（松手位置为中心，靠边整体移回可见区）', () => {
  it('视口中央：宽 min(400,80%)、高 min(260,40%)，中心即松手点', () => {
    const sel = initialRegionSelection({ x: 0.5, y: 0.5 }, VP);
    expect(sel.width).toBe(400);
    expect(sel.height).toBe(260);
    expect(sel.x + sel.width / 2).toBeCloseTo(VP.width / 2, 6);
    expect(sel.y + sel.height / 2).toBeCloseTo(VP.height / 2, 6);
    expect(sel.x).toBeGreaterThanOrEqual(0);
    expect(sel.y).toBeGreaterThanOrEqual(0);
  });

  it('四角：选区整体移回视口内（不越界）', () => {
    for (const release of [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]) {
      const sel = initialRegionSelection(release, VP);
      expect(sel.x).toBeGreaterThanOrEqual(0);
      expect(sel.y).toBeGreaterThanOrEqual(0);
      expect(sel.x + sel.width).toBeLessThanOrEqual(VP.width);
      expect(sel.y + sel.height).toBeLessThanOrEqual(VP.height);
      expect(sel.width).toBe(400);
      expect(sel.height).toBe(260);
    }
    // 左上角松手 → 选区贴齐左上
    expect(initialRegionSelection({ x: 0, y: 0 }, VP)).toEqual({ x: 0, y: 0, width: 400, height: 260 });
    // 右下角松手 → 选区贴齐右下
    const br = initialRegionSelection({ x: 1, y: 1 }, VP);
    expect(br.x + br.width).toBe(VP.width);
    expect(br.y + br.height).toBe(VP.height);
  });

  it('靠边（非角）：中心对齐松手点后整体移回', () => {
    const left = initialRegionSelection({ x: 0.02, y: 0.5 }, VP);
    expect(left.x).toBe(0);
    expect(left.y + left.height / 2).toBeCloseTo(VP.height / 2, 6);

    const right = initialRegionSelection({ x: 0.99, y: 0.5 }, VP);
    expect(right.x + right.width).toBe(VP.width);
  });

  it('小视口：宽高按比例收缩且仍受最小 48×48 约束', () => {
    const small = { width: 100, height: 60 };
    const sel = initialRegionSelection({ x: 0.5, y: 0.5 }, small);
    // min(400, 100*0.8)=80 → 受最小 48 影响后仍为 80；高 min(260,24)=24 → 撑到 48
    expect(sel.width).toBe(80);
    expect(sel.height).toBe(MIN_REGION_SIZE);
    expect(sel.y + sel.height).toBeLessThanOrEqual(small.height);
  });
});

describe('最小 48×48 约束', () => {
  it('clampRegion：强制最小边并夹回视口', () => {
    const sel = clampRegion({ x: -50, y: -50, width: 10, height: 10 }, VP);
    expect(sel.width).toBe(MIN_REGION_SIZE);
    expect(sel.height).toBe(MIN_REGION_SIZE);
    expect(sel.x).toBe(0);
    expect(sel.y).toBe(0);

    const overflow = clampRegion({ x: 1000, y: 700, width: 400, height: 200 }, VP);
    expect(overflow.x + overflow.width).toBeLessThanOrEqual(VP.width);
    expect(overflow.y + overflow.height).toBeLessThanOrEqual(VP.height);
  });

  it('resizeRegion：八向缩放都不得小于 48×48，也不越界', () => {
    const start = { x: 300, y: 300, width: 200, height: 200 };
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      const shrunk = resizeRegion(start, handle, 1000, 1000, VP); // 极端收缩方向
      expect(shrunk.width).toBeGreaterThanOrEqual(MIN_REGION_SIZE);
      expect(shrunk.height).toBeGreaterThanOrEqual(MIN_REGION_SIZE);
      const grown = resizeRegion(start, handle, -1000, -1000, VP); // 极端放大方向
      expect(grown.x).toBeGreaterThanOrEqual(0);
      expect(grown.y).toBeGreaterThanOrEqual(0);
      expect(grown.x + grown.width).toBeLessThanOrEqual(VP.width);
      expect(grown.y + grown.height).toBeLessThanOrEqual(VP.height);
    }
  });

  it('moveRegion 与 regionFromDrag：移动贴边、重新框选撑到最小', () => {
    const moved = moveRegion({ x: 100, y: 100, width: 100, height: 100 }, -9999, -9999, VP);
    expect(moved).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    const movedFar = moveRegion({ x: 100, y: 100, width: 100, height: 100 }, 9999, 9999, VP);
    expect(movedFar.x + movedFar.width).toBeLessThanOrEqual(VP.width);
    expect(movedFar.y + movedFar.height).toBeLessThanOrEqual(VP.height);

    const tiny = regionFromDrag({ x: 10, y: 10 }, { x: 12, y: 13 }, VP);
    expect(tiny.width).toBe(MIN_REGION_SIZE);
    expect(tiny.height).toBe(MIN_REGION_SIZE);
    // 反向拖拽同样成立
    const rev = regionFromDrag({ x: 200, y: 200 }, { x: 100, y: 100 }, VP);
    expect(rev).toEqual({ x: 100, y: 100, width: 100, height: 100 });
  });
});

describe('region 归一化（0..1，相对原始捕获视口）', () => {
  it('常规选区：等于选区 / 视口，且 x+width≤1、y+height≤1', () => {
    const r = normalizeRegion({ x: 102.4, y: 76.8, width: 512, height: 384 }, VP);
    expect(r.x).toBeCloseTo(0.1, 5);
    expect(r.y).toBeCloseTo(0.1, 5);
    expect(r.width).toBeCloseTo(0.5, 5);
    expect(r.height).toBeCloseTo(0.5, 5);
    expect(r.x + r.width).toBeLessThanOrEqual(1);
    expect(r.y + r.height).toBeLessThanOrEqual(1);
  });

  it('贴右下边：x+width≈1、y+height≈1 且绝不越界', () => {
    const r = normalizeRegion({ x: 624, y: 508, width: 400, height: 260 }, VP);
    expect(r.x + r.width).toBeLessThanOrEqual(1);
    expect(r.y + r.height).toBeLessThanOrEqual(1);
    expect(r.x + r.width).toBeCloseTo(1, 5);
    expect(r.y + r.height).toBeCloseTo(1, 5);
  });

  it('浮点噪声不会造成越界（向下取整到 1e-6）', () => {
    // 刻意用除不尽的比例：300/1000、700/1000 组合
    const vp = { width: 999, height: 777 };
    const sel = { x: 999 - 333, y: 777 - 259, width: 333, height: 259 };
    const r = normalizeRegion(sel, vp);
    expect(r.x + r.width).toBeLessThanOrEqual(1);
    expect(r.y + r.height).toBeLessThanOrEqual(1);
    expect(r.x).toBeLessThanOrEqual(1);
  });

  it('超范围输入先夹回视口再归一化', () => {
    const r = normalizeRegion({ x: -100, y: -100, width: 99999, height: 99999 }, VP);
    expect(r).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('归一化 → 冻结位图像素裁剪', () => {
  it('regionToBitmapRect：按位图尺寸换算并夹在位图内', () => {
    expect(regionToBitmapRect({ x: 0.25, y: 0.5, width: 0.5, height: 0.5 }, 400, 300)).toEqual({
      x: 100,
      y: 150,
      width: 200,
      height: 150,
    });
    const edge = regionToBitmapRect({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 401, 301);
    expect(edge.x + edge.width).toBeLessThanOrEqual(401);
    expect(edge.y + edge.height).toBeLessThanOrEqual(301);
  });

  it('cropFrozenRegion：裁出的像素与冻结位图对应区域一致（真实 PNG 字节）', async () => {
    const W = 400;
    const H = 300;
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i] = x % 256;
        px[i + 1] = y % 256;
        px[i + 2] = 128;
        px[i + 3] = 255;
      }
    }
    const frozen = new Blob([encodePng(W, H, px)], { type: 'image/png' });

    const sel = { x: 40, y: 90, width: 320, height: 120 };
    const out = await cropFrozenRegion(frozen, sel, { width: W, height: H });
    expect(out.width).toBe(320);
    expect(out.height).toBe(120);

    const png = await blobToPng(out.blob);
    expect(png.width).toBe(320);
    expect(png.height).toBe(120);
    const at = (x: number, y: number): number[] => {
      const i = (y * png.width + x) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!, png.data[i + 3]!];
    };
    // 首像素 = 冻结位图 (40,90)；尾像素 = (359,209)
    expect(at(0, 0)).toEqual([40 % 256, 90, 128, 255]);
    expect(at(319, 119)).toEqual([359 % 256, 209, 128, 255]);
    // 归一化路径给出同一结果
    const region = normalizeRegion(sel, { width: W, height: H });
    const viaRegion = regionToBitmapRect(region, W, H);
    expect(viaRegion).toEqual({ x: 40, y: 90, width: 320, height: 120 });
  });
});
