/**
 * 像素级截图测试夹具：内存位图画布 + 真实 PNG 编解码（node:zlib）。
 *
 * 思路：happy-dom 没有 2D canvas / 布局。测试用 FakeCanvas（Uint8ClampedArray
 * 帧缓冲，fillRect/getImageData/drawImage 真实读写像素）+ 假 html2canvas 渲染器
 * （先执行 onclone，再把所有带 data-fake-rect 的节点按「泄漏模式」直接画上去——
 * 无视克隆内 visibility，模拟最坏情况），因此最终 PNG 中敏感区若未被位图级
 * 不透明填充覆盖就会露出红色泄漏像素——断言的是最终 PNG 字节解码后的真实像素，
 * 而不是"遮挡函数是否被调用"。
 */
import { vi } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';

export const COVER = { r: 110, g: 110, b: 115 } as const; // 与 MASK_COVER_RGB 一致
export const LEAK = { r: 255, g: 0, b: 0 } as const; // 敏感内容泄漏色
export const DECOY = { r: 0, g: 0, b: 255 } as const; // 周围布局参照色

// ---------- CRC32 + PNG 编解码 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(Array.from(type).map((ch) => ch.charCodeAt(0)));
  const crc = crc32(typeBytes, data);
  const len = u32be(data.length);
  const out = new Uint8Array(4 + 4 + data.length + 4);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  out.set(u32be(crc), 8 + data.length);
  return out;
}

/** RGBA8、无 interlace、每行 filter 0 的真实 PNG 编码。 */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array([
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // color type RGBA
    0,
    0,
    0,
  ]);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const total = sig.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let pos = sig.length;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export interface PngImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 解码本夹具生成的 PNG（signature/chunk/CRC 严格解析，filter 支持 0）。 */
export function decodePng(bytes: Uint8Array): PngImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error('不是有效的 PNG signature');
  }
  let width = 0;
  let height = 0;
  const idats: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len =
      ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width =
        ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
      height =
        ((data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!) >>> 0;
    } else if (type === 'IDAT') {
      idats.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const concated = Buffer.concat(idats.map((d) => Buffer.from(d)));
  const inflated = new Uint8Array(inflateSync(concated));
  const stride = width * 4;
  const out = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart]!;
    if (filter !== 0) throw new Error(`测试夹具仅支持 filter 0，实际 ${filter}`);
    out.set(inflated.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }
  return { width, height, data: out };
}

export async function blobToPng(blob: Blob): Promise<PngImage> {
  return decodePng(new Uint8Array(await blob.arrayBuffer()));
}

// ---------- 颜色解析与 FakeCanvas ----------

export type Rgba = [number, number, number, number];

export function parseCssColor(v: string): Rgba {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v.trim());
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4] ?? '1') * 255)];
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(v.trim());
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16), 255];
  if (v === 'transparent') return [0, 0, 0, 0];
  throw new Error(`夹具不识别的颜色：${v}`);
}

export interface FakeRenderState {
  /** false 时 fillRect 变 no-op（模拟位图填充被移除 → 验证必须失败）。 */
  paint?: boolean;
  /** true 时 getImageData 抛错（模拟污染/不可读画布）。 */
  tainted?: boolean;
  /** 依次指定第 n 次 toBlob 的返回字节数（用于触发缩小重编码路径）。 */
  blobSizes?: number[];
  /** true 时假渲染器尊重克隆内 visibility（用于"遮挡完成才编码"的反证）。 */
  honorVisibility?: boolean;
  toBlobCalls: number;
  renderCalls: number;
}

export function createState(over: Partial<FakeRenderState> = {}): FakeRenderState {
  return { paint: true, tainted: false, toBlobCalls: 0, renderCalls: 0, ...over };
}

/** 2D 仿射变换矩阵（DOMMatrix 的 a..f）：x' = a·x + c·y + e，y' = b·x + d·y + f。 */
export interface TxMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const TX_IDENTITY: TxMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** save()/restore() 保存的完整绘制状态（变换 + 样式）。 */
interface CtxSavedState {
  tx: TxMatrix;
  fillStyle: Rgba;
  styleRaw: string;
  globalAlpha: number;
  globalCompositeOperation: string;
}

class FakeCtx {
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  private _fillStyle: Rgba = [0, 0, 0, 0];
  private _styleRaw = '';
  private _tx: TxMatrix = { ...TX_IDENTITY };
  private _stack: CtxSavedState[] = [];

  constructor(private readonly canvas: FakeCanvas) {}

  get fillStyle(): string {
    return this._styleRaw;
  }
  set fillStyle(v: string) {
    this._styleRaw = v;
    this._fillStyle = parseCssColor(v);
  }

  /** 画布尺寸被重新设置时清空绘制状态（真实 canvas 行为）。 */
  resetState(): void {
    this._tx = { ...TX_IDENTITY };
    this._stack = [];
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this._fillStyle = [0, 0, 0, 0];
    this._styleRaw = '';
  }

  save(): void {
    this._stack.push({
      tx: { ...this._tx },
      fillStyle: [...this._fillStyle] as Rgba,
      styleRaw: this._styleRaw,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
    });
  }

  restore(): void {
    const s = this._stack.pop();
    if (!s) return;
    this._tx = s.tx;
    this._fillStyle = s.fillStyle;
    this._styleRaw = s.styleRaw;
    this.globalAlpha = s.globalAlpha;
    this.globalCompositeOperation = s.globalCompositeOperation;
  }

  setTransform(a?: unknown, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (typeof a === 'object' && a !== null) {
      const m = a as Partial<TxMatrix>;
      this._tx = {
        a: m.a ?? 1,
        b: m.b ?? 0,
        c: m.c ?? 0,
        d: m.d ?? 1,
        e: m.e ?? 0,
        f: m.f ?? 0,
      };
      return;
    }
    this._tx = {
      a: (a as number) ?? 1,
      b: b ?? 0,
      c: c ?? 0,
      d: d ?? 1,
      e: e ?? 0,
      f: f ?? 0,
    };
  }

  getTransform(): TxMatrix {
    return { ...this._tx };
  }

  /** 当前变换右乘 scale 矩阵（与 CanvasRenderingContext2D.scale 一致）。 */
  scale(x: number, y: number): void {
    const t = this._tx;
    this._tx = { a: t.a * x, b: t.b * x, c: t.c * y, d: t.d * y, e: t.e, f: t.f };
  }

  /** 当前变换右乘平移矩阵（与 CanvasRenderingContext2D.translate 一致）。 */
  translate(x: number, y: number): void {
    const t = this._tx;
    this._tx = {
      a: t.a,
      b: t.b,
      c: t.c,
      d: t.d,
      e: t.e + t.a * x + t.c * y,
      f: t.f + t.b * x + t.d * y,
    };
  }

  private _applyTx(x: number, y: number): { x: number; y: number } {
    const t = this._tx;
    return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.canvas.state.paint === false) return;
    // 变换后的四角取轴对齐包围盒：夹具只模拟缩放/平移（轴对齐），此时即精确
    // 矩形；若混入旋转则按包围盒多遮，符合"允许多遮不允许少遮"的保守方向。
    const p = [this._applyTx(x, y), this._applyTx(x + w, y), this._applyTx(x, y + h), this._applyTx(x + w, y + h)];
    const x0 = Math.floor(Math.min(p[0]!.x, p[1]!.x, p[2]!.x, p[3]!.x));
    const y0 = Math.floor(Math.min(p[0]!.y, p[1]!.y, p[2]!.y, p[3]!.y));
    const x1 = Math.ceil(Math.max(p[0]!.x, p[1]!.x, p[2]!.x, p[3]!.x));
    const y1 = Math.ceil(Math.max(p[0]!.y, p[1]!.y, p[2]!.y, p[3]!.y));
    this.canvas.fillRectPixels(x0, y0, x1 - x0, y1 - y0, this._fillStyle);
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    if (this.canvas.state.tainted) throw new Error('canvas is tainted by cross-origin data');
    if (x < 0 || y < 0 || x + w > this.canvas.width || y + h > this.canvas.height) {
      throw new Error('getImageData 越界');
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcStart = ((y + row) * this.canvas.width + x) * 4;
      out.set(this.canvas.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  /** 仅支持 drawImage(src, 0,0, dw, dh)（scaleCanvas 用法），最近邻采样。 */
  drawImage(src: unknown, _dx: number, _dy: number, dw?: number, dh?: number): void {
    const s = src as FakeCanvas;
    const W = dw ?? this.canvas.width;
    const H = dh ?? this.canvas.height;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.min(s.width - 1, Math.floor((x * s.width) / W));
        const sy = Math.min(s.height - 1, Math.floor((y * s.height) / H));
        const si = (sy * s.width + sx) * 4;
        const di = (y * W + x) * 4;
        out4(this.canvas.data, di, s.data.subarray(si, si + 4));
      }
    }
  }
}

function out4(target: Uint8ClampedArray, at: number, src: Uint8ClampedArray): void {
  target[at] = src[0]!;
  target[at + 1] = src[1]!;
  target[at + 2] = src[2]!;
  target[at + 3] = src[3]!;
}

/** 真实像素读写的内存画布；toBlob 产出真实可解码的 PNG 字节。 */
export class FakeCanvas {
  private _w = 300;
  private _h = 150;
  data!: Uint8ClampedArray;
  readonly ctx: FakeCtx;

  constructor(readonly state: FakeRenderState) {
    this.ctx = new FakeCtx(this);
    this.alloc();
  }

  get width(): number {
    return this._w;
  }
  set width(v: number) {
    this._w = v;
    this.alloc();
  }
  get height(): number {
    return this._h;
  }
  set height(v: number) {
    this._h = v;
    this.alloc();
  }

  getContext(type?: string): FakeCtx | null {
    return type === '2d' ? this.ctx : null;
  }

  fillRectPixels(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let row = Math.max(0, y); row < Math.min(this._h, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(this._w, x + w); col++) {
        const i = (row * this._w + col) * 4;
        this.data[i] = color[0];
        this.data[i + 1] = color[1];
        this.data[i + 2] = color[2];
        this.data[i + 3] = color[3];
      }
    }
  }

  /** 返回该像素颜色（越界抛错，帮助断言精确）。 */
  pixel(x: number, y: number): Rgba {
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) throw new Error(`像素越界 (${x},${y})`);
    const i = (y * this._w + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  toBlob(cb: (b: Blob | null) => void, mime?: string): void {
    const png = encodePng(this._w, this._h, this.data);
    let blob = new Blob([png], { type: mime || 'image/png' });
    const target = this.state.blobSizes?.[this.state.toBlobCalls];
    this.state.toBlobCalls++;
    if (target !== undefined && target > blob.size) {
      blob = new Blob([blob, new Uint8Array(target - blob.size)], { type: blob.type });
    }
    cb(blob);
  }

  private alloc(): void {
    this.data = new Uint8ClampedArray(this._w * this._h * 4);
    this.data.fill(255); // 白色背景
    // 真实 canvas：重新设置宽高会重置整个 2D 上下文状态（含变换矩阵）。
    this.ctx.resetState();
  }
}

// ---------- 假 html2canvas 渲染器 ----------

interface RenderOptions {
  width: number;
  height: number;
  scale: number;
  x?: number;
  y?: number;
  onclone: (doc: Document, el: HTMLElement) => void | Promise<void>;
  ignoreElements?: (el: Element) => boolean;
}

export function createFakeRenderer(state: FakeRenderState) {
  return async (el: HTMLElement, options?: Record<string, unknown>): Promise<HTMLCanvasElement> => {
    const o = options as unknown as RenderOptions;
    state.renderCalls++;
    const canvas = new FakeCanvas(state);
    canvas.width = Math.floor(o.width * o.scale);
    canvas.height = Math.floor(o.height * o.scale);
    // 真实 html2canvas 在渲染内容前调用 onclone；onclone 抛错必须使整次捕获失败
    await o.onclone(document, el);
    // 与真实 CanvasRenderer 一致：画布尺寸设置（已重置上下文）之后施加
    // scale + translate 且**不恢复**——返回画布的上下文带着残余变换。
    // 任何不重置变换就绘制的后续调用方都会把坐标再变换一次。
    const ctx = canvas.ctx;
    ctx.scale(o.scale, o.scale);
    ctx.translate(-(o.x ?? 0), -(o.y ?? 0));
    // 泄漏模式：无视克隆里的 visibility，把带 data-fake-rect 的节点按**文档坐标**
    // 画上去（经残余变换落到设备像素）。最终 PNG 的敏感区若未覆盖，将呈现红色。
    for (const node of Array.from(document.querySelectorAll('[data-fake-rect]'))) {
      if (state.honorVisibility && (node as HTMLElement).style?.visibility === 'hidden') continue;
      const attrs = node.getAttribute('data-fake-rect')!.split(',').map(Number);
      const color = node.getAttribute('data-fake-color') ?? `rgb(${LEAK.r},${LEAK.g},${LEAK.b})`;
      const [x, y, w, h] = attrs as [number, number, number, number];
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    }
    return canvas as unknown as HTMLCanvasElement;
  };
}

/** document.createElement('canvas') 返回 FakeCanvas（scaleCanvas 重编码路径需要）。 */
export function stubCreateElementCanvas(state: FakeRenderState): void {
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: unknown) => {
    if (String(tag).toLowerCase() === 'canvas') return new FakeCanvas(state) as unknown as HTMLCanvasElement;
    return orig(tag as 'canvas', opts as never) as unknown as HTMLElement;
  }) as typeof document.createElement);
}

// ---------- 布局几何打桩（happy-dom 无布局） ----------

/**
 * 文档滚动量：`data-fake-rect` 的语义是**文档坐标**；
 * `getClientRects` 返回视口坐标（文档坐标 − 滚动量），与真实浏览器一致。
 * `installGeometryPatch` 每次安装时复位为 0。
 */
let docScrollX = 0;
let docScrollY = 0;

/** 设置当前文档滚动量（供 getClientRects 打桩与测试用例对齐）。 */
export function setDocumentScroll(x: number, y: number): void {
  docScrollX = x;
  docScrollY = y;
}

function fakeRect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    width: w,
    height: h,
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * getClientRects 读取 data-fake-rect（支持 NaN，用于非有限坐标用例）；
 * getComputedStyle 优先返回内联 visibility（反映遮挡变更），其次 data-fb-vis，
 * 其余委托实现。返回 teardown。
 */
export function installGeometryPatch(): () => void {
  const origRects = Element.prototype.getClientRects;
  const origGcs = window.getComputedStyle.bind(window);
  docScrollX = 0;
  docScrollY = 0;

  Element.prototype.getClientRects = function (this: Element): DOMRectList {
    const attr = this.getAttribute?.('data-fake-rect');
    if (attr === null || attr === undefined) {
      // 场景外元素：无布局
      return [] as unknown as DOMRectList;
    }
    const [x, y, w, h] = attr.split(',').map(Number) as [number, number, number, number];
    // 文档坐标 → 视口坐标（减去当前文档滚动量，与真实浏览器一致）
    return [fakeRect(x - docScrollX, y - docScrollY, w, h)] as unknown as DOMRectList;
  };

  (window as unknown as { getComputedStyle: typeof window.getComputedStyle }).getComputedStyle =
    ((el: Element, pseudo?: string | null) => {
      const inline = (el as HTMLElement).style?.visibility;
      if (inline) return { visibility: inline } as CSSStyleDeclaration;
      const vis = el.getAttribute?.('data-fb-vis');
      if (vis) return { visibility: vis } as CSSStyleDeclaration;
      if (el.getAttribute?.('data-fake-rect') !== null && el.getAttribute?.('data-fake-rect') !== undefined) {
        return { visibility: 'visible' } as CSSStyleDeclaration;
      }
      return origGcs(el, pseudo);
    }) as typeof window.getComputedStyle;

  return () => {
    Element.prototype.getClientRects = origRects;
    (window as unknown as { getComputedStyle: typeof window.getComputedStyle }).getComputedStyle = origGcs;
  };
}

// ---------- 场景构建 ----------

/** 便捷创建：任意 HTML 节点 + 假几何（happy-dom innerHTML 解析）。 */
export function addNode(
  html: string,
  rect: string,
  opts: { parent?: Element; color?: readonly number[] } = {},
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstElementChild as HTMLElement;
  node.setAttribute('data-fake-rect', rect);
  if (opts.color) node.setAttribute('data-fake-color', `rgb(${opts.color.join(',')})`);
  (opts.parent ?? document.body).appendChild(node);
  return node;
}

export const VP400x300 = { width: 400, height: 300, scrollX: 0, scrollY: 0, dpr: 1 };

export function isCoverPixel(img: PngImage, x: number, y: number): boolean {
  const i = (y * img.width + x) * 4;
  return (
    img.data[i] === COVER.r &&
    img.data[i + 1] === COVER.g &&
    img.data[i + 2] === COVER.b &&
    img.data[i + 3] === 255
  );
}

export function pixelColor(img: PngImage, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}
