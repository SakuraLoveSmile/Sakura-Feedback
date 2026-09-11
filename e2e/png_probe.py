#!/usr/bin/env python3
"""
PNG 像素级断言工具（e2e 专用）。

解码方式（报告里必须写明）：
- PNG 解码用 **Pillow 10.4.0**：`Image.open(io.BytesIO(bytes)).convert('RGBA')`。
  本机已装 Pillow，因此没有使用 `apps/server` 的 sharp，也没有手写 zlib 解码。
- 像素统计用 **numpy 2.2.6**（向量化比较）；numpy 导入失败时回退到
  Pillow 的 `getcolors()` + 逐像素比对。`backend()` 返回实际使用的路径，供报告引用。

坐标约定：PNG 输出像素坐标，原点左上；rect 用 {x, y, width, height}（CSS 视口坐标在
dpr=1、scale=1 时与输出像素一一对应）。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
from typing import Any

from PIL import Image

try:  # pragma: no cover - 环境探测
    import numpy as np

    _NUMPY = True
except Exception:  # pragma: no cover
    np = None  # type: ignore[assignment]
    _NUMPY = False

MASK_RGB = (110, 110, 115)  # #6E6E73，与 packages/web/src/capture.ts 的 MASK_COVER_RGB 一致
MASK_RGBA = (110, 110, 115, 255)


def backend() -> str:
    return "Pillow 10.4.0 解码 + numpy 2.2.6 向量化统计" if _NUMPY else "Pillow 10.4.0 解码 + Pillow getcolors 统计（numpy 不可用）"


def decode(png_bytes: bytes):
    """PNG 字节 → (H, W, 4) uint8 数组（numpy）或 PIL Image（回退）。"""
    img = Image.open(io.BytesIO(png_bytes))
    img.load()
    rgba = img.convert("RGBA")
    if _NUMPY:
        return np.asarray(rgba, dtype="uint8")
    return rgba


def size(arr) -> tuple[int, int]:
    if _NUMPY:
        return int(arr.shape[1]), int(arr.shape[0])
    return int(arr.width), int(arr.height)  # type: ignore[union-attr]


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def clip_rect(rect: dict, inset: int, arr) -> tuple[int, int, int, int] | None:
    w, h = size(arr)
    x0 = int(round(rect["x"])) + inset
    y0 = int(round(rect["y"])) + inset
    x1 = int(round(rect["x"] + rect["width"])) - inset
    y1 = int(round(rect["y"] + rect["height"])) - inset
    x0 = max(0, x0)
    y0 = max(0, y0)
    x1 = min(w, x1)
    y1 = min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def color_count(arr, color: tuple[int, int, int, int]) -> int:
    """整幅图中与 color 完全相等的像素数（含 alpha）。"""
    if _NUMPY:
        return int(np.count_nonzero(np.all(arr == np.array(color, dtype="uint8"), axis=-1)))
    total = 0
    for cnt, px in arr.convert("RGBA").getcolors(maxcolors=1 << 24) or []:
        if px == color:
            total += cnt
    return total


def probe_region(arr, rect: dict, expect: tuple[int, int, int, int], inset: int = 0) -> dict:
    """区域像素统计：全部等于 expect 才算匹配。"""
    box = clip_rect(rect, inset, arr)
    out: dict[str, Any] = {
        "rect": {k: round(float(v), 2) for k, v in rect.items()},
        "inset": inset,
        "expect": list(expect),
    }
    if box is None:
        out.update({"ok": False, "error": "空区域"})
        return out
    x0, y0, x1, y1 = box
    out["pixelBox"] = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
    exp = np.array(expect, dtype="uint8") if _NUMPY else expect
    if _NUMPY:
        region = arr[y0:y1, x0:x1]
        match_mask = np.all(region == exp, axis=-1)
        total = int(match_mask.size)
        matching = int(np.count_nonzero(match_mask))
        out["pixels"] = total
        out["matching"] = matching
        out["mismatching"] = total - matching
        out["ratio"] = round(matching / total, 6) if total else 0.0
        if total - matching:
            ys, xs = np.nonzero(~match_mask)
            fy, fx = int(ys[0]), int(xs[0])
            out["firstMismatch"] = {
                "x": x0 + fx,
                "y": y0 + fy,
                "rgba": [int(v) for v in region[fy, fx]],
            }
            uniq, counts = np.unique(region.reshape(-1, 4), axis=0, return_counts=True)
            order = np.argsort(-counts)[:6]
            out["topColors"] = [
                {"rgba": [int(v) for v in uniq[i]], "count": int(counts[i])} for i in order
            ]
        out["ok"] = matching == total
    else:  # pragma: no cover - 回退路径
        region = arr.convert("RGBA").crop((x0, y0, x1, y1))
        colors = region.getcolors(maxcolors=1 << 24) or []
        total = (x1 - x0) * (y1 - y0)
        matching = sum(c for c, px in colors if px == expect)
        out.update({"pixels": total, "matching": matching, "mismatching": total - matching,
                    "ratio": round(matching / total, 6) if total else 0.0,
                    "topColors": [{"rgba": list(px), "count": c} for c, px in sorted(colors, reverse=True)[:6]],
                    "ok": matching == total})
    return out


def histogram(arr, limit: int = 8) -> list[dict]:
    """整幅图的颜色直方图（前 limit 个）。"""
    if _NUMPY:
        uniq, counts = np.unique(arr.reshape(-1, 4), axis=0, return_counts=True)
        order = np.argsort(-counts)[:limit]
        return [{"rgba": [int(v) for v in uniq[i]], "count": int(counts[i])} for i in order]
    colors = arr.convert("RGBA").getcolors(maxcolors=1 << 24) or []
    return [{"rgba": list(px), "count": c} for c, px in sorted(colors, reverse=True)[:limit]]


def save(arr, box: tuple[int, int, int, int] | None, path: str) -> str | None:
    """把整幅图或某个裁剪区域存成 PNG（证据留存）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if _NUMPY:
        sub = arr if box is None else arr[box[1]:box[3], box[0]:box[2]]
        Image.fromarray(sub, mode="RGBA").save(path)
    else:  # pragma: no cover
        img = arr if box is None else arr.convert("RGBA").crop(box)
        img.save(path)
    return path


def dump(label: str, payload: Any) -> None:
    print(f"  [PIXELS] {label}: " + json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":  # 自检：造一张图验证统计逻辑
    from PIL import ImageDraw

    im = Image.new("RGBA", (8, 4), (255, 255, 255, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([2, 0, 4, 2], fill=(110, 110, 115, 255))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    raw = buf.getvalue()
    arr = decode(raw)
    print("backend:", backend(), "size:", size(arr))
    print(json.dumps(probe_region(arr, {"x": 2, "y": 0, "width": 3, "height": 3}, MASK_RGBA), ensure_ascii=False))
    print("mask pixels:", color_count(arr, MASK_RGBA))

def count_in_rect(arr, rect, rgba):
    """区域内目标颜色的像素数（用于确认遮挡色没有外溢到正常内容上）。"""
    clip = clip_rect(rect, 0, arr)
    if clip is None:
        return 0
    x0, y0, x1, y1 = clip
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return 0
    region = arr[y0:y0 + h, x0:x0 + w]
    want = np.array(rgba, dtype=np.uint8)
    return int(np.all(region == want, axis=-1).sum())
