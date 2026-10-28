/**
 * v12 多图附件：客户端校验、解码、等比缩小与「不可绘制内容」检测。
 *
 * 与截图（capture.ts）的限制一致：最长边 ≤2048px、≤400 万像素、≤5 MiB；
 * 格式仅限 PNG / JPEG / WebP 静态图（动图 WebP 拒绝）。手动图片先魔数校验
 * 再解码；超出尺寸/像素上限的等比缩小重编码，仍超体积上限的提示但保留草稿。
 */

export const MAX_IMAGES = 5;
export const MAX_IMAGE_EDGE = 2048;
export const MAX_IMAGE_PIXELS = 4_000_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 体积超限时的重编码次数（与截图 MAX_RECODE_ATTEMPTS 一致）。 */
export const MAX_IMAGE_RECODE_ATTEMPTS = 3;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface DecodedImage {
  width: number;
  height: number;
  /** CanvasImageSource（真实浏览器为 ImageBitmap / HTMLImageElement；测试可注入任意绘制源）。 */
  source: CanvasImageSource;
  /** 使用后是否需要 close()（ImageBitmap 资源释放）。 */
  close?: () => void;
}

export interface PreparedImage {
  blob: Blob;
  mime: ImageMime;
  width: number;
  height: number;
  /** 最终字节数仍 >5 MiB：提示用户但不丢草稿（提交会被服务端 413 拒绝）。 */
  oversize: boolean;
}

export type PrepareImageError =
  | 'invalid_type' // 非 PNG/JPEG/WebP 或魔数不符 / 动图 WebP
  | 'decode_failed' // 解码失败（损坏文件等）
  | 'empty'; // 0 字节

export class ImageInputError extends Error {
  readonly reason: PrepareImageError;
  constructor(reason: PrepareImageError, detail: string) {
    super(detail);
    this.name = 'ImageInputError';
    this.reason = reason;
  }
}

// ---------- 魔数与类型 ----------

function sniffMime(header: Uint8Array): ImageMime | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: RIFF????WEBP
  if (
    header.length >= 12 &&
    header[0] === 0x52 && // R
    header[1] === 0x49 && // I
    header[2] === 0x46 && // F
    header[3] === 0x46 && // F
    header[8] === 0x57 && // W
    header[9] === 0x45 && // E
    header[10] === 0x42 && // B
    header[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  return null;
}

/** 动图 WebP：VP8X chunk 的动画标志位（字节 20 的 bit1）。 */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  // RIFF 头 12 字节；VP8X chunk 头 8 字节；VP8X 载荷首字节为标志位。
  for (let pos = 12; pos + 8 <= Math.min(bytes.length, 256); ) {
    const fourcc = String.fromCharCode(bytes[pos]!, bytes[pos + 1]!, bytes[pos + 2]!, bytes[pos + 3]!);
    const size =
      ((bytes[pos + 4]! | (bytes[pos + 5]! << 8) | (bytes[pos + 6]! << 16) | (bytes[pos + 7]! << 24)) >>> 0);
    if (fourcc === 'VP8X' && size >= 1) {
      const flags = bytes[pos + 8]!;
      return (flags & 0x02) !== 0;
    }
    if (fourcc === 'VP8 ' || fourcc === 'VP8L') return false; // 到图像数据块：非 VP8X 容器
    pos += 8 + size + (size % 2); // RIFF chunk 偶对齐
  }
  return false;
}

const EXT_BY_MIME: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** 文件名基名（去路径分隔符）；无扩展名或扩展名不符时按 mime 修正。 */
export function normalizeImageFilename(name: string, mime: ImageMime, fallback: string): string {
  const base = (name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\r\n]/g, '').trim() || fallback;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot === -1 ? '' : cleaned.slice(dot).toLowerCase();
  const ok =
    (mime === 'image/png' && ext === '.png') ||
    (mime === 'image/jpeg' && (ext === '.jpg' || ext === '.jpeg')) ||
    (mime === 'image/webp' && ext === '.webp');
  return ok ? cleaned : `${cleaned.replace(/\.[^.]*$/, '')}${EXT_BY_MIME[mime]}`;
}

// ---------- 解码 ----------

export interface DecodeOptions {
  /** 测试注入：替代 createImageBitmap / <img> 解码。 */
  decode?: (blob: Blob) => Promise<DecodedImage>;
}

async function decodeViaImgTag(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const done = new Promise<HTMLImageElement>((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new ImageInputError('decode_failed', '图片解码失败'));
    });
    img.src = url;
    const el = await done;
    const width = el.naturalWidth || el.width;
    const height = el.naturalHeight || el.height;
    if (width <= 0 || height <= 0) throw new ImageInputError('decode_failed', '图片尺寸无效');
    return { width, height, source: el };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 解码图片为可绘制源（优先 createImageBitmap，降级 <img>）。 */
export async function decodeImage(blob: Blob, opts: DecodeOptions = {}): Promise<DecodedImage> {
  if (opts.decode) return opts.decode(blob);
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width > 0 && bmp.height > 0) {
        return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
      }
      bmp.close();
    } catch {
      /* 解码失败降级 <img> 路径 */
    }
  }
  return decodeViaImgTag(blob);
}

// ---------- 等比缩小与重编码 ----------

function canvasToBlob(canvas: HTMLCanvasElement, mime: ImageMime): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), mime, mime === 'image/jpeg' ? 0.92 : undefined);
    } catch {
      resolve(null);
    }
  });
}

/** 等比缩小到限制内（最长边 / 总像素），返回缩放后的目标尺寸（不变则返回原尺寸）。 */
export function fitWithinLimits(width: number, height: number): { width: number; height: number } {
  const byEdge = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  const byPixels = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
  const scale = Math.min(byEdge, byPixels);
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function drawScaled(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageInputError('decode_failed', '无法取得画布上下文');
  // JPEG/WebP 无透明通道诉求：白底避免透明区域变黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dstW, dstH);
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
  return canvas;
}

/**
 * 规范化待提交图片：解码 → 需要时等比缩小到边/像素上限 → 体积仍超 5MiB 时
 * 继续缩小重编码（至多 MAX_IMAGE_RECODE_ATTEMPTS 次）。
 *
 * 输出 mime：保持原格式重编码（JPEG/WebP）；重编码失败或来源已是 PNG 时用 PNG。
 * 仍超限时返回 oversize=true（调用方提示并保留草稿，由服务端最终裁决）。
 */
export async function prepareImageForUpload(
  blob: Blob,
  opts: DecodeOptions = {},
): Promise<PreparedImage> {
  if (blob.size === 0) throw new ImageInputError('empty', '图片不能为空文件');
  const head = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  const mime = sniffMime(head);
  if (!mime) throw new ImageInputError('invalid_type', '仅支持 PNG / JPEG / WebP 静态图片');
  if (mime === 'image/webp' && isAnimatedWebp(head)) {
    throw new ImageInputError('invalid_type', '不支持动图 WebP');
  }
  // 声明类型与魔数不符时以魔数为准（服务端按 mime 校验魔数一致性，这里先对齐）
  const declared = (blob.type || '').toLowerCase();
  if (declared && declared !== mime && declared.startsWith('image/')) {
    // 例如 .jpg 文件被宿主标为 image/png：以魔数修正，避免 400 invalid_image。
    blob = new Blob([blob], { type: mime });
  }

  const decoded = await decodeImage(blob, opts);
  try {
    const target = fitWithinLimits(decoded.width, decoded.height);
    if (target.width === decoded.width && target.height === decoded.height && blob.size <= MAX_IMAGE_BYTES) {
      return { blob, mime, width: decoded.width, height: decoded.height, oversize: false };
    }
    // 需要缩放或体积超限：重编码（优先原格式，失败回退 PNG）
    let canvas = drawScaled(decoded.source, decoded.width, decoded.height, target.width, target.height);
    let outMime: ImageMime = mime;
    let out = await canvasToBlob(canvas, outMime);
    if (!out) {
      outMime = 'image/png';
      out = await canvasToBlob(canvas, outMime);
    }
    let attempts = 0;
    while (out && out.size > MAX_IMAGE_BYTES && attempts < MAX_IMAGE_RECODE_ATTEMPTS) {
      attempts++;
      const next = drawScaled(canvas, canvas.width, canvas.height,
        Math.max(1, Math.floor(canvas.width * 0.8)),
        Math.max(1, Math.floor(canvas.height * 0.8)));
      canvas = next;
      const recoded = await canvasToBlob(canvas, outMime);
      if (recoded) out = recoded;
      else break;
    }
    if (!out) throw new ImageInputError('decode_failed', '图片重编码失败');
    return {
      blob: out,
      mime: outMime,
      width: canvas.width,
      height: canvas.height,
      oversize: out.size > MAX_IMAGE_BYTES,
    };
  } finally {
    decoded.close?.();
  }
}

/**
 * 对已解码图片重新导出（编辑器保存结果）：渲染出的位图按 PNG 编码并套用
 * 同一套尺寸/体积收缩规则。canvas 为空或编码失败返回 null。
 */
export async function exportEditedImage(
  canvas: HTMLCanvasElement,
): Promise<PreparedImage | null> {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
  const target = fitWithinLimits(canvas.width, canvas.height);
  let out: Blob | null;
  let w: number;
  let h: number;
  if (target.width === canvas.width && target.height === canvas.height) {
    out = await canvasToBlob(canvas, 'image/png');
    w = canvas.width;
    h = canvas.height;
  } else {
    const scaled = drawScaled(canvas, canvas.width, canvas.height, target.width, target.height);
    out = await canvasToBlob(scaled, 'image/png');
    w = scaled.width;
    h = scaled.height;
    canvas = scaled;
  }
  let attempts = 0;
  while (out && out.size > MAX_IMAGE_BYTES && attempts < MAX_IMAGE_RECODE_ATTEMPTS) {
    attempts++;
    const next = drawScaled(canvas, canvas.width, canvas.height,
      Math.max(1, Math.floor(canvas.width * 0.8)),
      Math.max(1, Math.floor(canvas.height * 0.8)));
    canvas = next;
    const recoded = await canvasToBlob(canvas, 'image/png');
    if (recoded) {
      out = recoded;
      w = canvas.width;
      h = canvas.height;
    } else break;
  }
  if (!out) return null;
  return { blob: out, mime: 'image/png', width: w, height: h, oversize: out.size > MAX_IMAGE_BYTES };
}

// ---------- 不可绘制内容检测（T1） ----------

function isCrossOriginUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim();
  if (!v || v.startsWith('data:') || v.startsWith('blob:') || v.startsWith('#')) return false;
  try {
    const url = new URL(v, document.baseURI);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function elementVisible(el: Element): boolean {
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility !== 'visible') return false;
  } catch {
    /* getComputedStyle 不可用时按可见处理（保守提示） */
  }
  return el.getClientRects().length > 0;
}

/**
 * 统计视口内**可能无法进入截图位图**的嵌入内容：
 * - 跨源 iframe（未授权 CORS 的嵌入页无法被 DOM 重绘捕获）；
 * - 跨源 <img>/<image> 未声明 crossorigin（html2canvas useCORS 下会拉取失败或污染画布）。
 * 返回检测到的元素数量；>0 时组件在预览旁提示「部分内容可能未入图」并允许手动加图。
 */
export function countUndrawableContent(doc: Document, ignore?: (el: Element) => boolean): number {
  let count = 0;
  const scan = (root: Document | ShadowRoot | Element): void => {
    const nodes = Array.from(root.querySelectorAll('iframe, img, image'));
    for (const node of nodes) {
      if (ignore?.(node)) continue;
      if (!elementVisible(node)) continue;
      const tag = node.tagName.toUpperCase();
      if (tag === 'IFRAME') {
        const src = node.getAttribute('src') ?? (node as HTMLIFrameElement).src;
        // 跨源 iframe 无法被 DOM 重绘捕获；srcdoc / 同源 / 空 src 不提示。
        if (isCrossOriginUrl(src)) count++;
      } else {
        const img = node as HTMLImageElement;
        const src = node.getAttribute('src') ?? node.getAttribute('href') ?? img.src;
        if (isCrossOriginUrl(src) && node.getAttribute('crossorigin') === null) count++;
      }
    }
    // 穿透 open shadow root
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) scan(shadow);
    }
  };
  scan(doc);
  return count;
}
