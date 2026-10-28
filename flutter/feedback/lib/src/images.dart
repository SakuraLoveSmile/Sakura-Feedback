import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data' show ByteData, Endian, Uint8List;
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart' as fs;
import 'package:crypto/crypto.dart' as crypto;

import 'api_client.dart' show FeedbackImageFile;
import 'idempotency.dart';
import 'widget.dart'
    show
        kFeedbackCaptureMaxBytes,
        kFeedbackCaptureMaxEdgePx,
        kFeedbackCaptureMaxPixels;

/// 图片附件数量上限（两端统一，v12）。
const int kFeedbackMaxImages = 5;

/// 允许的图片扩展名（PNG / JPEG / WebP）。
const Set<String> kFeedbackAllowedImageExtensions = <String>{
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
};

/// 支持的图片 MIME（静态图）。
const Set<String> kFeedbackAllowedImageMimes = <String>{
  'image/png',
  'image/jpeg',
  'image/webp',
};

/// 图片处理失败（客户端校验 / 缩放失败）。消息面向用户可读；
/// 草稿与已有附件必须保留（调用方负责提示，不丢内容）。
class FeedbackImageException implements Exception {
  /// 构造图片异常。
  const FeedbackImageException(this.message);

  /// 用户可读的失败原因。
  final String message;

  @override
  String toString() => 'FeedbackImageException: $message';
}

/// 按魔数识别图片 MIME；不认识的二进制一律返回 null。
String? detectImageMime(Uint8List bytes) {
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0D &&
      bytes[5] == 0x0A &&
      bytes[6] == 0x1A &&
      bytes[7] == 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xFF &&
      bytes[1] == 0xD8 &&
      bytes[2] == 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46 &&
      bytes[8] == 0x57 &&
      bytes[9] == 0x45 &&
      bytes[10] == 0x42 &&
      bytes[11] == 0x50) {
    return 'image/webp';
  }
  return null;
}

/// 静态 WebP 校验：RIFF「WEBP」中 VP8X 特征位含 ANIM（0x02）或存在 ANIM 块
/// 即为动图（契约：动图 WebP 拒绝）。
bool isAnimatedWebP(Uint8List bytes) {
  if (detectImageMime(bytes) != 'image/webp') return false;
  if (bytes.length < 30) return false;
  int offset = 12;
  while (offset + 8 <= bytes.length) {
    final String fourcc = String.fromCharCodes(bytes.sublist(offset, offset + 4));
    final int size = ByteData.sublistView(bytes, offset + 4, offset + 8)
        .getUint32(0, Endian.little);
    if (fourcc == 'ANIM') return true;
    if (fourcc == 'VP8X' && offset + 8 < bytes.length) {
      final int flags = bytes[offset + 8];
      if (flags & 0x02 != 0) return true; // ANIM 位
    }
    offset += 8 + size + (size.isOdd ? 1 : 0); // RIFF 块按偶数对齐
  }
  return false;
}

/// 按 MIME 取规范扩展名（含点）。
String imageExtensionForMime(String mime) {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/png':
    default:
      return '.png';
  }
}

/// 把文件名规范到与 MIME 匹配的扩展名（仅基名；无法识别时用回退名）。
String normalizeImageFilename(String? raw, String mime, {String? fallback}) {
  String name = (raw == null || raw.trim().isEmpty)
      ? (fallback ?? 'image')
      : raw.trim();
  // 只保留基名（防路径分隔符）。
  name = name.split(RegExp(r'[/\\]')).last;
  final int dot = name.lastIndexOf('.');
  final String base = dot > 0 ? name.substring(0, dot) : name;
  final String safeBase =
      base.isEmpty ? (fallback ?? 'image') : base;
  return '$safeBase${imageExtensionForMime(mime)}';
}

/// 解码图片尺寸（不解码整帧用于显示——本包只在需要缩放/校验时使用）。
Future<ui.Image> decodeImage(Uint8List bytes) async {
  final ui.Codec codec = await ui.instantiateImageCodec(bytes);
  try {
    final ui.FrameInfo frame = await codec.getNextFrame();
    return frame.image;
  } finally {
    codec.dispose();
  }
}

/// 按契约上限计算的等比缩放系数（最长边 2048 / 400 万像素）。
double feedbackImageScaleFactor(int width, int height) {
  if (width <= 0 || height <= 0) return 1.0;
  double scale = 1.0;
  final double maxEdge = math.max(width, height).toDouble();
  if (maxEdge > kFeedbackCaptureMaxEdgePx) {
    scale = math.min(scale, kFeedbackCaptureMaxEdgePx / maxEdge);
  }
  final double pixels = width * height.toDouble();
  if (pixels > kFeedbackCaptureMaxPixels) {
    scale = math.min(scale, math.sqrt(kFeedbackCaptureMaxPixels / pixels));
  }
  return scale;
}

/// 等比缩小重编码为 PNG：先按尺寸系数解码缩放，字节仍超限时逐步按
/// 0.8 倍再缩（最多 4 次）。返回 null 表示已尽力仍超限（调用方提示并
/// 保留草稿，不丢弃已有图片）。
Future<Uint8List?> downscaleImageToPng(Uint8List bytes) async {
  ui.Image? image;
  try {
    image = await decodeImage(bytes);
  } catch (_) {
    return null;
  }
  try {
    double scale = feedbackImageScaleFactor(image.width, image.height);
    // 源已在像素限制内但字节超限（如大 JPEG）也从 1.0 起步按步长缩。
    for (int attempt = 0; attempt < 4; attempt++) {
      ui.Image? scaled;
      try {
        if (scale >= 1.0) {
          scaled = image;
        } else {
          final int w = math.max(1, (image.width * scale).round());
          final ui.Codec codec = await ui.instantiateImageCodec(
            bytes,
            targetWidth: w,
          );
          try {
            scaled = (await codec.getNextFrame()).image;
          } finally {
            codec.dispose();
          }
        }
        final ByteData? data = await scaled.toByteData(
          format: ui.ImageByteFormat.png,
        );
        if (data != null && data.lengthInBytes <= kFeedbackCaptureMaxBytes) {
          return data.buffer
              .asUint8List(data.offsetInBytes, data.lengthInBytes);
        }
      } finally {
        if (!identical(scaled, image)) scaled?.dispose();
      }
      scale *= 0.8;
    }
    return null;
  } finally {
    image.dispose();
  }
}

/// 把手动选择的原始图片整理为可上传的 [FeedbackImageFile]：
/// 魔数识别 MIME → 拒绝动图 WebP → 超尺寸/超字节时等比缩小重编码为 PNG →
/// 仍超限抛 [FeedbackImageException]（调用方提示并保留草稿）。
///
/// [source] 标记 `manual` / `capture` / `edited`；[id] 缺省生成稳定随机 ID；
/// [existingId] 用于编辑保存时复用原 ID（不占新名额）。
Future<FeedbackImageFile> normalizeFeedbackImage(
  Uint8List bytes, {
  String? filename,
  String source = 'manual',
  String? id,
}) async {
  final String? mime = detectImageMime(bytes);
  if (mime == null) {
    throw const FeedbackImageException('仅支持 PNG / JPEG / WebP 静态图片');
  }
  if (mime == 'image/webp' && isAnimatedWebP(bytes)) {
    throw const FeedbackImageException('不支持动态 WebP 图片');
  }

  Uint8List finalBytes = bytes;
  String finalMime = mime;
  bool needsEncode = finalBytes.length > kFeedbackCaptureMaxBytes;
  if (!needsEncode) {
    ui.Image? probe;
    try {
      probe = await decodeImage(bytes);
      if (feedbackImageScaleFactor(probe.width, probe.height) < 1.0) {
        needsEncode = true;
      }
    } catch (_) {
      throw const FeedbackImageException('无法读取该图片');
    } finally {
      probe?.dispose();
    }
  }
  if (needsEncode) {
    final Uint8List? encoded = await downscaleImageToPng(bytes);
    if (encoded == null) {
      throw const FeedbackImageException(
          '图片超出 2048px / 400万像素 / 5MiB 限制且无法缩小');
    }
    finalBytes = encoded;
    finalMime = 'image/png';
  }
  return FeedbackImageFile(
    id: id ?? generateFeedbackIdempotencyKey(),
    filename:
        normalizeImageFilename(filename, finalMime, fallback: 'image'),
    bytes: finalBytes,
    mime: finalMime,
    source: source,
    sha256: crypto.sha256.convert(finalBytes).toString(),
  );
}

/// 默认图片选择器（`file_selector`，多选）：读取字节并逐一整理为
/// [FeedbackImageFile]。返回 null 表示用户取消；个别文件整理失败会跳过
/// 并通过 [onError] 上抛第一条错误消息（调用方提示）。
Future<List<FeedbackImageFile>?> defaultFeedbackImagePicker({
  void Function(String message)? onError,
}) async {
  const fs.XTypeGroup typeGroup = fs.XTypeGroup(
    label: 'images',
    extensions: <String>['png', 'jpg', 'jpeg', 'webp'],
  );
  final List<fs.XFile> files =
      await fs.openFiles(acceptedTypeGroups: const <fs.XTypeGroup>[typeGroup]);
  if (files.isEmpty) return null;
  final List<FeedbackImageFile> result = <FeedbackImageFile>[];
  String? firstError;
  for (final fs.XFile file in files) {
    try {
      final Uint8List bytes = await file.readAsBytes();
      result.add(
        await normalizeFeedbackImage(bytes, filename: file.name),
      );
    } on FeedbackImageException catch (e) {
      firstError ??= e.message;
    } catch (_) {
      firstError ??= '读取图片失败';
    }
  }
  if (result.isEmpty && firstError != null) {
    throw FeedbackImageException(firstError);
  }
  if (firstError != null) onError?.call(firstError);
  return result;
}
