/**
 * 截图生成与敏感区遮挡内部模块（实施计划 2.1 / 2.3）。
 *
 * 设计要点：
 * - 内置 html2canvas-pro 路径：在克隆上按布局查找密码输入与 [data-feedback-capture-mask]，
 *   修改克隆前先记录变换后的遮挡区域（裁定到截图视口），仅在克隆中隐藏敏感子树并保持
 *   原布局尺寸（visibility 方案，绝不替换节点、不改 display 类型）；清除背景图、图片
 *   来源与伪元素内容。
 * - 位图级最终保护：重绘得到最终输出位图后，在其上再填充不透明遮挡矩形（向外取整并
 *   外扩一个输出像素），随后逐区域采样验证；遮挡验证完成前绝不编码 PNG / 生成预览。
 * - 失败规则：有效且仍可见的敏感节点无法定位、坐标非有限、遮挡结果无法验证 → 本次截图
 *   失败（调用方保留旧草稿与旧截图）；明确在截图视口外可忽略；不允许静默跳过。
 * - captureProvider 扩展契约：保留原参数与返回值，新增可选 signal、视口信息与同帧遮挡
 *   信息；组件统一校验 PNG、尺寸、文件大小与遮挡坐标；页面存在可见敏感区域而提供者无法
 *   保证同帧遮挡时拒绝使用该截图；无敏感标记时旧回调保持兼容。
 * - 图片限制（两端统一）：scale = min(dpr, 2, 2048/最长逻辑边, sqrt(4_000_000/逻辑面积))；
 *   编码超过 5MiB 最多缩小重编码三次，仍超限则本次截图失败。
 */

export const MAX_CAPTURE_EDGE = 2048;
export const MAX_CAPTURE_PIXELS = 4_000_000;
export const MAX_PNG_BYTES = 5 * 1024 * 1024;
export const MAX_RECODE_ATTEMPTS = 3;
export const RECODE_FACTOR = 0.8;

/** 遮挡覆盖色（与最终位图填充一致，供采样验证）。 */
export const MASK_COVER_RGB = { r: 110, g: 110, b: 115 } as const; // #6e6e73
export const MASK_COVER_CSS = 'rgb(110, 110, 115)';

/** 用户可见的截图失败提示：保留旧草稿与旧截图，可重试或继续文字反馈。 */
export const CAPTURE_FAILURE_MESSAGE = '截图未完成，可重试或继续文字反馈';

/** 敏感元素选择器（克隆上按布局查找用）。 */
const SENSITIVE_SELECTOR = 'input[type="password"], [data-feedback-capture-mask]';

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogicalViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export type CaptureErrorReason =
  | 'aborted'
  | 'locate-failed' // 有效且仍可见的敏感节点无法定位 / 坐标非有限
  | 'provider-invalid' // 提供者返回值未通过统一校验
  | 'provider-unsafe' // 存在敏感区域但提供者无法保证同帧遮挡
  | 'verify-failed' // 最终位图遮挡结果无法验证
  | 'size-limit'; // 缩小重编码三次仍超限

export class CaptureError extends Error {
  readonly reason: CaptureErrorReason;
  /** 面向用户的提示（不含内部细节）。 */
  readonly userMessage: string;
  constructor(reason: CaptureErrorReason, detail: string, userMessage = CAPTURE_FAILURE_MESSAGE) {
    super(`[${reason}] ${detail}`);
    this.name = 'CaptureError';
    this.reason = reason;
    this.userMessage = userMessage;
  }
}

// ---------- captureProvider 扩展契约 ----------

export interface CaptureProviderContext {
  /** 原有参数：灵感球拖拽落点（0..1 视口比例）。 */
  releasePoint?: { x: number; y: number };
  /** 新增：本次捕获的取消信号（会话失效时 abort）。 */
  signal?: AbortSignal;
  /** 新增：截图视口的逻辑信息（CSS 像素）。 */
  viewport?: LogicalViewport;
  /** 新增：宿主页面当前可见敏感区域数量（>0 时提供者必须给出同帧遮挡证明）。 */
  sensitiveRegionCount?: number;
}

export interface CaptureProviderResult {
  /** 原有返回：PNG 截图字节。 */
  blob: Blob;
  /** 原有返回：图像输出像素尺寸（旧回调语义）。 */
  width: number;
  height: number;
  /** 新增可选：逻辑视口尺寸（不传时按旧语义取 width/height）。 */
  viewport?: { width: number; height: number };
  /** 新增可选：同帧遮挡证明——提供者必须确认遮挡与截图发生在同一帧。 */
  sameFrameMasking?: boolean;
  /**
   * 新增可选：同帧遮挡区域列表，坐标以输出像素计。
   * sameFrameMasking 为 true 时应列出全部被遮挡区域（可为空数组，表示本页面无敏感内容）。
   */
  maskedRegions?: CaptureRect[];
}

export type CaptureProvider = (ctx: CaptureProviderContext) => Promise<CaptureProviderResult>;

export interface ValidatedCapture {
  blob: Blob;
  viewportWidth: number;
  viewportHeight: number;
  outputWidth: number;
  outputHeight: number;
  maskedRegions: CaptureRect[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 组件统一校验 captureProvider 返回值：PNG 类型、尺寸上限、文件大小、遮挡坐标。
 * 页面存在可见敏感区域（sensitiveRegionCount > 0）而提供者未给出同帧遮挡证明时拒绝。
 */
export function validateProviderResult(
  res: CaptureProviderResult,
  sensitiveRegionCount: number,
): ValidatedCapture {
  if (!res || typeof res !== 'object') {
    throw new CaptureError('provider-invalid', 'captureProvider 未返回结果对象');
  }
  const blob = res.blob;
  if (!(blob instanceof Blob)) {
    throw new CaptureError('provider-invalid', 'captureProvider 返回值缺少 Blob');
  }
  if (!blob.type.toLowerCase().includes('image/png')) {
    throw new CaptureError('provider-invalid', '截图仅支持 PNG 格式');
  }
  if (blob.size === 0 || blob.size > MAX_PNG_BYTES) {
    throw new CaptureError('provider-invalid', `截图文件大小需在 0–${MAX_PNG_BYTES} 字节内`);
  }
  if (!isFiniteNumber(res.width) || !isFiniteNumber(res.height)) {
    throw new CaptureError('provider-invalid', '截图尺寸坐标必须为有限数字');
  }
  const outputWidth = Math.round(res.width);
  const outputHeight = Math.round(res.height);
  if (outputWidth <= 0 || outputHeight <= 0) {
    throw new CaptureError('provider-invalid', '截图尺寸必须为正数');
  }
  if (Math.max(outputWidth, outputHeight) > MAX_CAPTURE_EDGE) {
    throw new CaptureError('provider-invalid', `截图输出边长不能超过 ${MAX_CAPTURE_EDGE}px`);
  }
  if (outputWidth * outputHeight > MAX_CAPTURE_PIXELS) {
    throw new CaptureError('provider-invalid', `截图输出像素不能超过 ${MAX_CAPTURE_PIXELS}`);
  }

  let maskedRegions: CaptureRect[] = [];
  if (sensitiveRegionCount > 0) {
    if (res.sameFrameMasking !== true || !Array.isArray(res.maskedRegions)) {
      throw new CaptureError(
        'provider-unsafe',
        '页面存在可见敏感区域，但 captureProvider 未保证同帧遮挡，拒绝使用该截图',
      );
    }
    for (const r of res.maskedRegions) {
      if (
        !r ||
        !isFiniteNumber(r.x) ||
        !isFiniteNumber(r.y) ||
        !isFiniteNumber(r.width) ||
        !isFiniteNumber(r.height)
      ) {
        throw new CaptureError('provider-unsafe', '遮挡区域坐标非有限，拒绝使用该截图');
      }
      if (r.width <= 0 || r.height <= 0) {
        throw new CaptureError('provider-unsafe', '遮挡区域尺寸必须为正数');
      }
      if (r.x < -1 || r.y < -1 || r.x + r.width > outputWidth + 1 || r.y + r.height > outputHeight + 1) {
        throw new CaptureError('provider-unsafe', '遮挡区域超出截图输出范围');
      }
    }
    if (res.maskedRegions.length === 0) {
      throw new CaptureError(
        'provider-unsafe',
        `检测到 ${sensitiveRegionCount} 个可见敏感区域，但提供者未遮挡任何区域`,
      );
    }
    maskedRegions = res.maskedRegions.map((r) => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    }));
  } else if (res.sameFrameMasking === true && Array.isArray(res.maskedRegions)) {
    // 无敏感区域时旧回调兼容：若新提供者仍上报遮挡，透传（宽松校验）。
    maskedRegions = res.maskedRegions.filter(
      (r) =>
        r &&
        isFiniteNumber(r.x) &&
        isFiniteNumber(r.y) &&
        isFiniteNumber(r.width) &&
        isFiniteNumber(r.height) &&
        r.width > 0 &&
        r.height > 0,
    );
  }

  let viewportWidth = outputWidth;
  let viewportHeight = outputHeight;
  if (res.viewport && isFiniteNumber(res.viewport.width) && isFiniteNumber(res.viewport.height)) {
    if (res.viewport.width > 0 && res.viewport.height > 0) {
      viewportWidth = Math.round(res.viewport.width);
      viewportHeight = Math.round(res.viewport.height);
    }
  }

  return { blob, viewportWidth, viewportHeight, outputWidth, outputHeight, maskedRegions };
}

// ---------- 敏感节点查找与可见性 ----------

export interface CollectOptions {
  /** 返回 true 表示该元素（及其子树）不参与截图（如组件自身），跳过计数与遮挡。 */
  ignore?: (el: Element) => boolean;
}

/** 递归收集敏感节点（穿透 open shadow root）。 */
export function collectSensitiveNodes(
  root: Document | ShadowRoot | Element,
  out: Element[] = [],
): Element[] {
  out.push(...Array.from(root.querySelectorAll(SENSITIVE_SELECTOR)));
  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all) {
    const host = (el as HTMLElement).shadowRoot;
    if (host) collectSensitiveNodes(host, out);
  }
  return out;
}

function isVisibleBox(el: Element, win: Window): boolean {
  const style = win.getComputedStyle(el);
  if (style.visibility !== 'visible') return false;
  return el.getClientRects().length > 0;
}

/** 收集元素子树（含 open shadow root 内容）的全部元素。 */
export function collectSubtreeElements(root: Element | ShadowRoot | Document, out: Element[] = []): Element[] {
  if (typeof (root as Element).tagName === 'string') out.push(root as Element);
  for (const el of Array.from((root as Document | ShadowRoot | Element).querySelectorAll('*'))) {
    out.push(el);
    const host = (el as HTMLElement).shadowRoot;
    if (host) collectSubtreeElements(host, out);
  }
  return out;
}

interface ViewportClip {
  width: number;
  height: number;
}

/**
 * 计算一个敏感节点（mask 元素取其可见子树并集）在截图视口中的可见区域。
 * - 返回 null：不在截图范围内（明确可忽略）。
 * - 抛 CaptureError('locate-failed')：仍可见但坐标非有限 / 无法测量。
 */
export function sensitiveVisibleRect(
  el: Element,
  win: Window,
  vp: ViewportClip,
  opts: { subtree: boolean },
): CaptureRect | null {
  const nodes = opts.subtree ? collectSubtreeElements(el) : [el];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  for (const node of nodes) {
    if (!isVisibleBox(node, win)) continue;
    for (const r of Array.from(node.getClientRects())) {
      // 变换后的边界（getClientRects 已包含 transform / scroll 后的视口坐标）
      if (
        !Number.isFinite(r.left) ||
        !Number.isFinite(r.top) ||
        !Number.isFinite(r.right) ||
        !Number.isFinite(r.bottom)
      ) {
        throw new CaptureError('locate-failed', '敏感节点边界坐标非有限，无法安全遮挡');
      }
      // 0x0 边框/占位盒忽略（自身无可见内容；其后代单独计算）
      if (r.width <= 0 || r.height <= 0) continue;
      seen = true;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
  }

  if (!seen) return null; // 整体未渲染（display:none 等）→ 不在截图画面中

  // 裁定（裁剪）到截图视口
  const x1 = Math.max(0, Math.min(minX, vp.width));
  const y1 = Math.max(0, Math.min(minY, vp.height));
  const x2 = Math.max(0, Math.max(maxX, x1));
  const y2 = Math.max(0, Math.max(maxY, y1));
  const clippedW = Math.min(x2, vp.width) - x1;
  const clippedH = Math.min(y2, vp.height) - y1;
  if (clippedW <= 0 || clippedH <= 0) return null; // 明确在截图范围外，可忽略

  return { x: x1, y: y1, width: clippedW, height: clippedH };
}

/**
 * 统计宿主页面中“有效且仍可见”（有布局、可见、与截图视口相交）的敏感节点数。
 * 坐标非有限时抛错——不允许静默跳过。
 */
export function countVisibleSensitiveRegions(doc: Document, opts: CollectOptions = {}): number {
  const win = doc.defaultView;
  if (!win) return 0;
  const vp: ViewportClip = { width: win.innerWidth, height: win.innerHeight };
  let count = 0;
  for (const el of collectSensitiveNodes(doc)) {
    if (opts.ignore?.(el)) continue;
    const isMask = el.hasAttribute('data-feedback-capture-mask');
    if (sensitiveVisibleRect(el, win, vp, { subtree: !isMask ? false : true }) !== null) {
      count++;
    }
  }
  return count;
}

// ---------- 视口与缩放 ----------

export function logicalViewport(win: Window & typeof globalThis): LogicalViewport {
  const width = win.innerWidth;
  const height = win.innerHeight;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw new CaptureError('locate-failed', '无法获得有限的视口尺寸');
  }
  const dprRaw = win.devicePixelRatio;
  return {
    width,
    height,
    scrollX: Number.isFinite(win.scrollX) ? win.scrollX : 0,
    scrollY: Number.isFinite(win.scrollY) ? win.scrollY : 0,
    dpr: isFiniteNumber(dprRaw) && dprRaw > 0 ? dprRaw : 1,
  };
}

/** 两端统一缩放公式（实施计划 2.3）。 */
export function computeCaptureScale(vp: { width: number; height: number }, dpr: number): number {
  const maxEdge = Math.max(vp.width, vp.height);
  const area = vp.width * vp.height;
  return Math.min(dpr, 2, MAX_CAPTURE_EDGE / maxEdge, Math.sqrt(MAX_CAPTURE_PIXELS / area));
}

// ---------- 克隆级遮挡 ----------

const CLONE_MASK_CSS = `
${SENSITIVE_SELECTOR},
[data-feedback-capture-mask] *,
[data-feedback-capture-mask]::before,
[data-feedback-capture-mask]::after,
[data-feedback-capture-mask] *::before,
[data-feedback-capture-mask] *::after,
input[type="password"]::before,
input[type="password"]::after {
  visibility: hidden !important;
  background-image: none !important;
  box-shadow: none !important;
}
`;

/**
 * 仅在克隆中隐藏敏感子树：先记录遮挡区域，再修改克隆（顺序不可颠倒）。
 * 保持原布局尺寸：只设置 visibility / background-image / 图片来源，
 * 绝不替换节点、绝不改 display 类型（避免破坏 inline/flex/grid/table 布局）。
 *
 * expectedVisibleCount：真实文档中“有效且仍可见”的敏感节点数；克隆上按布局定位数
 * 不足说明有可见敏感节点无法定位 → 本次截图失败（不允许静默跳过）。
 */
export function recordAndApplyCloneMask(
  cloneDoc: Document,
  vp: ViewportClip,
  expectedVisibleCount = 0,
): CaptureRect[] {
  const win = cloneDoc.defaultView;
  if (!win) throw new CaptureError('locate-failed', '克隆文档缺少可布局的 window，无法定位敏感节点');

  const found = collectSensitiveNodes(cloneDoc);
  const rects: CaptureRect[] = [];

  // 第一遍：修改克隆前记录遮挡区域（变换后边界，裁定到截图视口）
  for (const el of found) {
    const rect = sensitiveVisibleRect(el, win, vp, { subtree: el.hasAttribute('data-feedback-capture-mask') });
    if (rect) rects.push(rect);
  }

  if (rects.length < expectedVisibleCount) {
    throw new CaptureError(
      'locate-failed',
      `页面有 ${expectedVisibleCount} 个可见敏感区域，但克隆上仅定位到 ${rects.length} 个，无法保证遮挡`,
    );
  }

  // 第二遍：隐藏（保持布局尺寸；伪元素与背景由注入样式兜底）
  const style = cloneDoc.createElement('style');
  style.setAttribute('data-feedback-capture-mask-style', '');
  style.textContent = CLONE_MASK_CSS;
  (cloneDoc.head ?? cloneDoc.documentElement).appendChild(style);

  for (const el of found) {
    const subtree = el.hasAttribute('data-feedback-capture-mask')
      ? collectSubtreeElements(el)
      : [el];
    for (const node of subtree) {
      const html = node as HTMLElement;
      if (html.style) {
        html.style.setProperty('visibility', 'hidden', 'important');
        html.style.setProperty('background-image', 'none', 'important');
      }
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IFRAME') {
        node.removeAttribute('src');
        node.removeAttribute('srcset');
        node.removeAttribute('poster');
      }
      if (tag === 'SOURCE') {
        node.removeAttribute('src');
        node.removeAttribute('srcset');
      }
      if (tag === 'IMAGE') {
        // svg <image>
        node.removeAttribute('href');
        node.removeAttribute('xlink:href');
      }
      if (tag === 'INPUT' && (node as HTMLInputElement).type === 'password') {
        try {
          (node as HTMLInputElement).value = '';
        } catch {
          /* 克隆 input 值清理失败不致命：visibility 与位图填充兜底 */
        }
      }
    }
  }

  return rects;
}

// ---------- 最终位图：不透明遮挡 + 验证 ----------

/** 逻辑视口坐标 → 输出像素矩形：向外取整并外扩一个输出像素，再裁到画布内。 */
export function maskRectToOutputPixels(
  rect: CaptureRect,
  ratioX: number,
  ratioY: number,
  canvasW: number,
  canvasH: number,
): CaptureRect {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    throw new CaptureError('locate-failed', '遮挡区域坐标非有限');
  }
  if (!Number.isFinite(ratioX) || !Number.isFinite(ratioY) || ratioX <= 0 || ratioY <= 0) {
    throw new CaptureError('verify-failed', '遮挡缩放比例非有限，无法映射到输出位图');
  }
  const x0 = Math.max(0, Math.floor(rect.x * ratioX) - 1);
  const y0 = Math.max(0, Math.floor(rect.y * ratioY) - 1);
  const x1 = Math.min(canvasW, Math.ceil((rect.x + rect.width) * ratioX) + 1);
  const y1 = Math.min(canvasH, Math.ceil((rect.y + rect.height) * ratioY) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) {
    // 记录过可见且与视口相交的区域投影后必然非退化；出现即异常，不允许静默跳过
    throw new CaptureError('verify-failed', '遮挡区域投影到输出位图后退化，无法保证覆盖');
  }
  return { x: x0, y: y0, width: w, height: h };
}

function paintMaskRects(canvas: HTMLCanvasElement, rectsPx: CaptureRect[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CaptureError('verify-failed', '无法取得最终位图的 2D 上下文');
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = MASK_COVER_CSS;
  for (const r of rectsPx) ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.restore();
}

/** 采样验证每个遮挡矩形确实被不透明覆盖色覆盖（含四角与内部网格）。 */
export function verifyCanvasMaskCoverage(canvas: HTMLCanvasElement, rectsPx: CaptureRect[]): void {
  if (rectsPx.length === 0) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CaptureError('verify-failed', '无法读取最终位图验证遮挡结果');
  for (const r of rectsPx) {
    const x = Math.floor(r.x);
    const y = Math.floor(r.y);
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) {
      throw new CaptureError('verify-failed', '遮挡矩形超出画布范围，无法验证');
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(x, y, w, h).data;
    } catch (e) {
      throw new CaptureError('verify-failed', `位图被污染或不可读，无法验证遮挡：${(e as Error).message}`);
    }
    const { r: cr, g: cg, b: cb } = MASK_COVER_RGB;
    const stepX = Math.max(1, Math.floor(w / 33));
    const stepY = Math.max(1, Math.floor(h / 33));
    const isCover = (px: number, py: number): boolean => {
      const i = (py * w + px) * 4;
      return data[i] === cr && data[i + 1] === cg && data[i + 2] === cb && data[i + 3] === 255;
    };
    for (let py = 0; py < h; py += stepY) {
      for (let px = 0; px < w; px += stepX) {
        if (!isCover(px, py)) {
          throw new CaptureError('verify-failed', `遮挡验证失败：区域 (${x + px}, ${y + py}) 未被不透明覆盖`);
        }
      }
      // 每行尾部也采样一次，保证右缘覆盖
      if (!isCover(w - 1, py)) {
        throw new CaptureError('verify-failed', `遮挡验证失败：区域右缘 (${x + w - 1}, ${y + py}) 未被不透明覆盖`);
      }
    }
    // 底缘最后一行（含右下角）单独验证
    if (!isCover(0, h - 1) || !isCover(w - 1, h - 1)) {
      throw new CaptureError('verify-failed', '遮挡验证失败：区域底缘未被不透明覆盖');
    }
  }
}

function toBlobPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new CaptureError('verify-failed', 'Canvas toBlob 失败'))), 'image/png');
  });
}

function scaleCanvas(src: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const w = Math.max(1, Math.floor(src.width * factor));
  const h = Math.max(1, Math.floor(src.height * factor));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new CaptureError('verify-failed', '缩小重画无法取得 2D 上下文');
  ctx.drawImage(src, 0, 0, w, h);
  return out;
}

function assertCanvasWithinLimits(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new CaptureError('verify-failed', '输出位图尺寸非有限');
  }
  if (Math.max(w, h) > MAX_CAPTURE_EDGE || w * h > MAX_CAPTURE_PIXELS) {
    throw new CaptureError('verify-failed', '输出位图超出两端统一限制');
  }
}

// ---------- 内置 html2canvas-pro 捕获 ----------

export interface BuiltinCaptureOptions {
  viewport: LogicalViewport;
  /** 真实文档中统计到的可见敏感节点数；克隆上定位数不足即失败。 */
  expectedSensitiveCount: number;
  signal?: AbortSignal;
  ignore?: (el: Element) => boolean;
  /** 测试注入：替代真实 html2canvas-pro 的动态导入。 */
  html2canvas?: (el: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>;
}

export interface BuiltinCaptureResult {
  blob: Blob;
  viewportWidth: number;
  viewportHeight: number;
  outputWidth: number;
  outputHeight: number;
  maskedRegions: CaptureRect[];
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CaptureError('aborted', '截图会话已失效');
}

async function defaultHtml2Canvas(): Promise<(el: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>> {
  const mod = await import('html2canvas-pro');
  return ((mod as unknown as { default?: unknown }).default || mod) as unknown as (
    el: HTMLElement,
    options?: Record<string, unknown>,
  ) => Promise<HTMLCanvasElement>;
}

/**
 * 内置视口截图：克隆遮挡 → 重绘 → 最终位图填充 + 验证 → 全部通过后才编码 PNG。
 */
export async function captureViewport(opts: BuiltinCaptureOptions): Promise<BuiltinCaptureResult> {
  checkAbort(opts.signal);
  const { viewport } = opts;
  const scale = computeCaptureScale(viewport, viewport.dpr);

  let maskRectsLogical: CaptureRect[] = [];
  const renderHtml2Canvas = opts.html2canvas ?? (await defaultHtml2Canvas());

  const canvas = await renderHtml2Canvas(document.documentElement, {
    x: viewport.scrollX,
    y: viewport.scrollY,
    width: viewport.width,
    height: viewport.height,
    scale,
    useCORS: true,
    allowTaint: false,
    logging: false,
    ignoreElements: (element: Element) => opts.ignore?.(element) ?? false,
    onclone: (clonedDoc: Document) => {
      // 记录 + 隐藏必须在修改克隆前完成；定位失败直接抛出使整次捕获失败
      maskRectsLogical = recordAndApplyCloneMask(clonedDoc, viewport, opts.expectedSensitiveCount);
    },
  });
  checkAbort(opts.signal);

  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new CaptureError('verify-failed', 'html2canvas 未产出有效画布');
  }

  let finalCanvas = canvas;
  let rectsPx: CaptureRect[] = [];
  const paintAndVerify = (): void => {
    assertCanvasWithinLimits(finalCanvas.width, finalCanvas.height);
    const ratioX = finalCanvas.width / viewport.width;
    const ratioY = finalCanvas.height / viewport.height;
    rectsPx = maskRectsLogical.map((r) =>
      maskRectToOutputPixels(r, ratioX, ratioY, finalCanvas.width, finalCanvas.height),
    );
    // 重绘后再在最终位图上填充不透明遮挡矩形（最终保护）
    if (rectsPx.length > 0) {
      paintMaskRects(finalCanvas, rectsPx);
      // 验证完成前绝不编码 PNG / 生成预览
      verifyCanvasMaskCoverage(finalCanvas, rectsPx);
    }
  };
  paintAndVerify();

  let blob = await toBlobPng(finalCanvas);
  let attempts = 0;
  while (blob.size > MAX_PNG_BYTES && attempts < MAX_RECODE_ATTEMPTS) {
    attempts++;
    checkAbort(opts.signal);
    finalCanvas = scaleCanvas(finalCanvas, RECODE_FACTOR);
    paintAndVerify();
    blob = await toBlobPng(finalCanvas);
  }
  if (blob.size > MAX_PNG_BYTES) {
    throw new CaptureError('size-limit', '缩小重编码三次后仍超过大小限制');
  }

  return {
    blob,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    outputWidth: finalCanvas.width,
    outputHeight: finalCanvas.height,
    // 与最终输出位图一致（含缩小重编码后的坐标）的遮挡区域像素矩形
    maskedRegions: rectsPx.map((r) => ({ ...r })),
  };
}
