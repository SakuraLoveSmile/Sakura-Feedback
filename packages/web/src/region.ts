/**
 * T1 局部截图选区（灵感球拖拽 → 松手 → 调整选区 → 确认 → 填写反馈）。
 *
 * 坐标约定（与冻结规格一致）：
 * - 选区状态 `RegionRect` 始终以**捕获视口逻辑像素**（capture.viewportWidth/Height
 *   描述的那个视口）为坐标系；覆盖层把冻结位图铺满整个窗口显示，显示时按
 *   「窗口尺寸 / 捕获视口尺寸」换算，指针事件再反向换算回选区坐标系。
 * - `NormalizedRegion`（提交用 `capture.region`）是 0..1 归一化值，同样相对
 *   **原始捕获视口**，并保证 x+width≤1、y+height≤1。
 * - 裁剪时归一化值直接乘冻结位图尺寸即可得到像素矩形（位图完整覆盖捕获视口），
 *   因此不依赖 DPR / 捕获 scale 的额外换算。
 *
 * 本模块保持纯函数（几何）+ 一个位图裁剪入口，DOM 交互在 element.ts 的覆盖层里。
 */

import { decodeImage, exportEditedImage } from './images';

/** 选区矩形：捕获视口逻辑像素坐标。 */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 归一化选区（提交 metadata 的 `capture.region`）：0..1，相对原始捕获视口。 */
export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionViewport {
  width: number;
  height: number;
}

/** 选区最小边长（逻辑像素）。 */
export const MIN_REGION_SIZE = 48;
/** 初始选区宽 / 高上限（逻辑像素）。 */
export const REGION_DEFAULT_WIDTH = 400;
export const REGION_DEFAULT_HEIGHT = 260;
/** 键盘调整选区的步长（逻辑像素）。 */
export const REGION_KEY_STEP = 8;

/** 八个缩放控制点方位。 */
export type RegionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const REGION_HANDLES: readonly RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * 向下取整到 1e-6：归一化值向下取整可保证 `x + width ≤ 1`、`y + height ≤ 1`
 * （选区本身已被夹在视口内，原始和 ≤ 1；两部分各自向下取整后和仍 ≤ 1）。
 */
function floor6(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v * 1e6) / 1e6);
}

/** 防御浮点最后一位：求和仍 >1 时先重算、再退一个极小步长，保证契约恒成立。 */
function fitPair(start: number, limit: number): number {
  let v = start;
  if (v > limit) v = Math.max(0, Math.floor(limit * 1e6) / 1e6);
  if (v > limit) v = Math.max(0, limit - 1e-9);
  return v;
}

/** 把选区夹回捕获视口内，并强制最小 48×48（视口本身更小时取视口尺寸）。 */
export function clampRegion(sel: RegionRect, viewport: RegionViewport): RegionRect {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const minW = Math.min(MIN_REGION_SIZE, vw);
  const minH = Math.min(MIN_REGION_SIZE, vh);
  const width = Math.max(minW, Math.min(sel.width, vw));
  const height = Math.max(minH, Math.min(sel.height, vh));
  const x = Math.max(0, Math.min(sel.x, vw - width));
  const y = Math.max(0, Math.min(sel.y, vh - height));
  return { x, y, width, height };
}

/**
 * 松手位置处的初始选区：
 * 宽 `min(400, 视口宽×80%)`、高 `min(260, 视口高×40%)`，中心为松手点（0..1），
 * 靠边时整体移回可见区域内，并强制最小 48×48。
 */
export function initialRegionSelection(
  release: { x: number; y: number },
  viewport: RegionViewport,
): RegionRect {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const width = Math.min(REGION_DEFAULT_WIDTH, vw * 0.8);
  const height = Math.min(REGION_DEFAULT_HEIGHT, vh * 0.4);
  const cx = clamp01(release.x) * vw;
  const cy = clamp01(release.y) * vh;
  return clampRegion({ x: cx - width / 2, y: cy - height / 2, width, height }, viewport);
}

/** 移动选区（键盘方向键 / 拖动），保持尺寸并夹回视口。 */
export function moveRegion(sel: RegionRect, dx: number, dy: number, viewport: RegionViewport): RegionRect {
  return clampRegion({ ...sel, x: sel.x + dx, y: sel.y + dy }, viewport);
}

/** 按控制点方位缩放选区，强制最小 48×48 并夹回视口。 */
export function resizeRegion(
  sel: RegionRect,
  handle: RegionHandle,
  dx: number,
  dy: number,
  viewport: RegionViewport,
): RegionRect {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const minW = Math.min(MIN_REGION_SIZE, vw);
  const minH = Math.min(MIN_REGION_SIZE, vh);
  let left = sel.x;
  let top = sel.y;
  let right = sel.x + sel.width;
  let bottom = sel.y + sel.height;

  if (handle.includes('w')) left = Math.max(0, Math.min(left + dx, right - minW));
  if (handle.includes('e')) right = Math.min(vw, Math.max(right + dx, left + minW));
  if (handle.includes('n')) top = Math.max(0, Math.min(top + dy, bottom - minH));
  if (handle.includes('s')) bottom = Math.min(vh, Math.max(bottom + dy, top + minH));

  return clampRegion({ x: left, y: top, width: right - left, height: bottom - top }, viewport);
}

/** 由拖拽起点 / 终点归一化出选区（允许反向拖拽；小于 48×48 时撑到最小）。 */
export function regionFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: RegionViewport,
): RegionRect {
  const x0 = Math.min(start.x, end.x);
  const y0 = Math.min(start.y, end.y);
  const x1 = Math.max(start.x, end.x);
  const y1 = Math.max(start.y, end.y);
  return clampRegion({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, viewport);
}

/**
 * 选区 → 提交用 `capture.region`：0..1 归一化、相对原始捕获视口，
 * 向下取整到 1e-6，保证 x+width≤1、y+height≤1。
 */
export function normalizeRegion(sel: RegionRect, viewport: RegionViewport): NormalizedRegion {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const clamped = clampRegion(sel, viewport);
  const x = floor6(clamped.x / vw);
  const y = floor6(clamped.y / vh);
  const width = fitPair(floor6(clamped.width / vw), 1 - x);
  const height = fitPair(floor6(clamped.height / vh), 1 - y);
  return { x, y, width, height };
}

/** 归一化选区 → 冻结位图像素矩形（整数、夹在位图内、至少 1×1）。 */
export function regionToBitmapRect(
  region: NormalizedRegion,
  bitmapWidth: number,
  bitmapHeight: number,
): { x: number; y: number; width: number; height: number } {
  const bw = Math.max(1, Math.round(bitmapWidth));
  const bh = Math.max(1, Math.round(bitmapHeight));
  const x = Math.max(0, Math.min(bw - 1, Math.round(region.x * bw)));
  const y = Math.max(0, Math.min(bh - 1, Math.round(region.y * bh)));
  const right = Math.max(x + 1, Math.min(bw, Math.round((region.x + region.width) * bw)));
  const bottom = Math.max(y + 1, Math.min(bh, Math.round((region.y + region.height) * bh)));
  return { x, y, width: right - x, height: bottom - y };
}

export interface CroppedRegionImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * 把冻结的全视口位图裁到选区：
 * 选区（捕获视口逻辑像素）→ 归一化 → 位图像素 → drawImage 源矩形 → PNG 编码
 * （编码沿用统一的尺寸 / 体积收缩规则）。
 *
 * 源矩形取整数像素，避免小数源坐标在最近邻采样下落到无效像素。
 */
export async function cropFrozenRegion(
  blob: Blob,
  sel: RegionRect,
  viewport: RegionViewport,
): Promise<CroppedRegionImage> {
  const decoded = await decodeImage(blob);
  try {
    const region = normalizeRegion(sel, viewport);
    const rect = regionToBitmapRect(region, decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法取得裁剪画布上下文');
    ctx.drawImage(decoded.source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const out = await exportEditedImage(canvas);
    if (!out) throw new Error('裁剪结果编码失败');
    return { blob: out.blob, width: out.width, height: out.height };
  } finally {
    decoded.close?.();
  }
}
