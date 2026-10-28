import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";

export const MAX_PNG_BYTES = 5 * 1024 * 1024; // 5MiB
export const MAX_PNG_EDGE = 2048; // 2048px
export const MAX_PNG_PIXELS = 4_000_000; // 400 万像素

export class ImageValidationError extends Error {
  constructor(
    /**
     * invalid_request：描述符/数量/互斥等请求形态问题（400）；
     * invalid_format / animated_unsupported / corrupted：图片内容非法（400，路由统一映射 invalid_image）；
     * too_large：尺寸/像素/体积超限（413）。
     */
    public code: "invalid_request" | "invalid_format" | "animated_unsupported" | "too_large" | "corrupted",
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export interface SanitizedImage {
  sanitizedBuffer: Buffer;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export async function validateAndSanitizePng(rawBuffer: Buffer): Promise<SanitizedImage> {
  if (rawBuffer.byteLength > MAX_PNG_BYTES) {
    throw new ImageValidationError("too_large", `截图文件超过 ${MAX_PNG_BYTES / (1024 * 1024)}MiB 上限`);
  }
  if (rawBuffer.byteLength < 8) {
    throw new ImageValidationError("invalid_format", "图片文件过小或无效");
  }
  // Check PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  const isPngMagic =
    rawBuffer[0] === 0x89 &&
    rawBuffer[1] === 0x50 &&
    rawBuffer[2] === 0x4e &&
    rawBuffer[3] === 0x47 &&
    rawBuffer[4] === 0x0d &&
    rawBuffer[5] === 0x0a &&
    rawBuffer[6] === 0x1a &&
    rawBuffer[7] === 0x0a;
  if (!isPngMagic) {
    throw new ImageValidationError("invalid_format", "仅支持 PNG 格式图片");
  }

  let metadata: Metadata;
  try {
    const s = sharp(rawBuffer, { animated: true });
    metadata = await s.metadata();
  } catch (err) {
    throw new ImageValidationError("corrupted", `无法解码 PNG 图片: ${(err as Error).message}`);
  }

  if (metadata.format !== "png") {
    throw new ImageValidationError("invalid_format", "仅支持 PNG 格式图片");
  }
  if (metadata.pages && metadata.pages > 1) {
    throw new ImageValidationError("animated_unsupported", "不支持动图 (APNG)");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new ImageValidationError("corrupted", "无法识别图片尺寸");
  }
  if (Math.max(width, height) > MAX_PNG_EDGE) {
    throw new ImageValidationError(
      "too_large",
      `图片尺寸超限：最长边为 ${Math.max(width, height)}px，超过 ${MAX_PNG_EDGE}px 上限`,
    );
  }
  if (width * height > MAX_PNG_PIXELS) {
    throw new ImageValidationError("too_large", `图片像素总数超限：${width * height} 像素超过 ${MAX_PNG_PIXELS} 上限`);
  }

  // Re-encode to clean PNG; sharp strips EXIF, XMP, IPTC and comments by default
  let sanitizedBuffer: Buffer;
  try {
    sanitizedBuffer = await sharp(rawBuffer).png({ compressionLevel: 9 }).toBuffer();
  } catch (err) {
    throw new ImageValidationError("corrupted", `重新编码图片失败: ${(err as Error).message}`);
  }

  if (sanitizedBuffer.byteLength > MAX_PNG_BYTES) {
    throw new ImageValidationError("too_large", `编码后截图体积超过 ${MAX_PNG_BYTES / (1024 * 1024)}MiB 上限`);
  }

  const sha256 = createHash("sha256").update(sanitizedBuffer).digest("hex");
  return {
    sanitizedBuffer,
    width,
    height,
    byteSize: sanitizedBuffer.byteLength,
    sha256,
  };
}

// ------------------------------------------------------------------ v12：多图附件（PNG / JPEG / WebP）

/** 单次提交/回复的最多图片数。 */
export const MAX_IMAGE_COUNT = 5;
/** 图片附件允许的来源标记。 */
export const IMAGE_SOURCES = ["capture", "manual", "edited"] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];
export const ALLOWED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 客户端在 metadata.images[] 里给出的有序描述符。 */
export interface ImageDescriptorInput {
  id?: unknown;
  source?: unknown;
  filename?: unknown;
  sha256?: unknown;
  mime?: unknown;
}

/** multipart `images` 部件的原始字节。 */
export interface RawImagePart {
  bytes: Buffer | Uint8Array;
  filename?: string;
}

/** 校验通过的图片：原始字节原样入库（客户端编辑器已输出最终字节；sha256 为客户端声明值的核验结果）。 */
export interface ValidatedImage {
  id: string;
  source: ImageSource;
  filename: string;
  mime: ImageMime;
  bytes: Buffer;
  byteSize: number;
  /** 客户端声明的原始字节摘要（入库值即此值；与服务返回字节一致——不二次编码）。 */
  sha256: string;
  width: number;
  height: number;
}

/** 魔数嗅探：PNG / JPEG / WebP（RIFF+WEBP）。返回 null 表示无法识别。 */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.byteLength >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.byteLength >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.byteLength >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * 校验单张图片附件（v12）：
 * - 声明 mime 必须是白名单且与文件魔数一致；
 * - sharp 解码必须成功、静态图（多页/动图拒绝）、尺寸 1..2048px 且 ≤400 万像素；
 * - 体积 ≤5MiB；二进制 SHA-256 必须与描述符一致。
 * 错误码：invalid_request（描述符非法）/ invalid_image（内容非法）/ too_large（超限，HTTP 413）。
 */
export async function validateImageAttachment(
  part: RawImagePart,
  descriptor: ImageDescriptorInput,
  index: number,
): Promise<ValidatedImage> {
  const ord = `第 ${index + 1} 张图片`;

  const id = typeof descriptor.id === "string" ? descriptor.id.trim() : "";
  if (!id || id.length > 64) {
    throw new ImageValidationError("invalid_request", `${ord}缺少合法的稳定 id（1..64 字符）`);
  }
  const source = descriptor.source;
  if (source !== "capture" && source !== "manual" && source !== "edited") {
    throw new ImageValidationError("invalid_request", `${ord}来源非法，仅支持 capture/manual/edited`);
  }
  let filename = typeof descriptor.filename === "string" ? descriptor.filename.trim() : "";
  if (!filename && typeof part.filename === "string") filename = part.filename.trim();
  if (!filename) {
    throw new ImageValidationError("invalid_request", `${ord}缺少文件名`);
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new ImageValidationError("invalid_request", `${ord}文件名不能包含路径分隔符: ${filename}`);
  }
  const lower = filename.toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new ImageValidationError(
      "invalid_request",
      `${ord}文件名非法 (${filename})，仅支持 ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}`,
    );
  }
  const mime = descriptor.mime;
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") {
    throw new ImageValidationError("invalid_request", `${ord}声明的 mime 非法，仅支持 PNG/JPEG/WebP`);
  }
  const declaredSha = typeof descriptor.sha256 === "string" ? descriptor.sha256.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(declaredSha)) {
    throw new ImageValidationError("invalid_request", `${ord}缺少合法的 sha256（64 位小写十六进制）`);
  }

  const bytes = Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes);
  if (bytes.byteLength === 0) {
    throw new ImageValidationError("invalid_format", `${ord}内容为空`);
  }
  if (bytes.byteLength > MAX_PNG_BYTES) {
    throw new ImageValidationError("too_large", `${ord}超过 ${MAX_PNG_BYTES / (1024 * 1024)}MiB 上限`);
  }
  if (sniffImageMime(bytes) !== mime) {
    throw new ImageValidationError("invalid_format", `${ord}内容与声明的 ${mime} 不一致（魔数校验失败）`);
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { animated: true }).metadata();
  } catch (err) {
    throw new ImageValidationError("corrupted", `无法解码${ord}: ${(err as Error).message}`);
  }
  const expectedFormat = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : "webp";
  if (metadata.format !== expectedFormat) {
    throw new ImageValidationError("invalid_format", `${ord}解码格式与声明不一致`);
  }
  if (metadata.pages && metadata.pages > 1) {
    throw new ImageValidationError("animated_unsupported", `${ord}不支持动图/多页图片`);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new ImageValidationError("corrupted", `无法识别${ord}尺寸`);
  }
  if (Math.max(width, height) > MAX_PNG_EDGE) {
    throw new ImageValidationError(
      "too_large",
      `${ord}尺寸超限：最长边为 ${Math.max(width, height)}px，超过 ${MAX_PNG_EDGE}px 上限`,
    );
  }
  if (width * height > MAX_PNG_PIXELS) {
    throw new ImageValidationError(
      "too_large",
      `${ord}像素总数超限：${width * height} 像素超过 ${MAX_PNG_PIXELS} 上限`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== declaredSha) {
    throw new ImageValidationError("invalid_format", `${ord}的 SHA-256 摘要与描述符不一致`);
  }

  return {
    id,
    source: source as ImageSource,
    filename,
    mime: mime as ImageMime,
    bytes,
    byteSize: bytes.byteLength,
    sha256,
    width,
    height,
  };
}

/**
 * 校验整组图片附件与 metadata.images 描述符的一一对应关系：
 * - 描述符缺失但有部件 / 部件缺失但有描述符 / 数量不一致 → invalid_request；
 * - 描述符必须是数组、至多 5 项、id 在单次提交内唯一。
 * `descriptorsRaw` 为 undefined/null/空数组且无部件时返回 []。
 */
export async function validateAllImages(parts: RawImagePart[], descriptorsRaw: unknown): Promise<ValidatedImage[]> {
  if (descriptorsRaw === undefined || descriptorsRaw === null) {
    if (parts.length > 0) {
      throw new ImageValidationError("invalid_request", "存在图片部件但缺少 metadata.images 描述");
    }
    return [];
  }
  if (!Array.isArray(descriptorsRaw)) {
    throw new ImageValidationError("invalid_request", "metadata.images 必须是数组");
  }
  if (descriptorsRaw.length > MAX_IMAGE_COUNT) {
    throw new ImageValidationError("invalid_request", `图片数量超过上限，最多允许 ${MAX_IMAGE_COUNT} 张`);
  }
  if (parts.length !== descriptorsRaw.length) {
    throw new ImageValidationError(
      "invalid_request",
      `图片数量与描述不一致：收到 ${parts.length} 个部件，描述了 ${descriptorsRaw.length} 个`,
    );
  }
  const seen = new Set<string>();
  const result: ValidatedImage[] = [];
  for (let i = 0; i < parts.length; i++) {
    const desc = descriptorsRaw[i];
    if (!desc || typeof desc !== "object" || Array.isArray(desc)) {
      throw new ImageValidationError("invalid_request", `第 ${i + 1} 个图片描述必须为对象`);
    }
    const img = await validateImageAttachment(parts[i]!, desc as ImageDescriptorInput, i);
    if (seen.has(img.id)) {
      throw new ImageValidationError("invalid_request", `图片 id "${img.id}" 在本次提交内重复`);
    }
    seen.add(img.id);
    result.push(img);
  }
  return result;
}
