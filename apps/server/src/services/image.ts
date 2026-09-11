import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";

export const MAX_PNG_BYTES = 5 * 1024 * 1024; // 5MiB
export const MAX_PNG_EDGE = 2048; // 2048px
export const MAX_PNG_PIXELS = 4_000_000; // 400 万像素

export class ImageValidationError extends Error {
  constructor(
    public code: "invalid_format" | "animated_unsupported" | "too_large" | "corrupted",
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
