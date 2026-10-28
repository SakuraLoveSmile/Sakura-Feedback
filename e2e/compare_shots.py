#!/usr/bin/env python3
"""截图前后对比：按**文件名**配对「改动前基线」与「改动后」两批截图。

用法：
  python3 e2e/compare_shots.py --baseline <基线目录> --new <新目录> [--out report.json] [--name 标签]

输出：
  - 同名截图：尺寸是否变化 + 差异像素比例（RGB 任一通道差 >8 记为不同）
  - 仅单侧存在的文件：列为 added / removed（场景新增或改名，需人工确认）
  - 差异最大的前若干张另存 side-by-side 对比图（baseline | new）

只读取，不修改任何目录。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from PIL import Image, ImageChops

DIFF_THRESHOLD = 8      # 通道差阈值：>= 记为“不同像素”
TOP_N_COMPOSITES = 8    # 另存对比图的张数（按差异比例降序）


def diff_ratio(a: Image.Image, b: Image.Image) -> float:
    """返回 RGB 上「通道差 > DIFF_THRESHOLD」的像素占比（0..1）。"""
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    gray = diff.convert("L")
    hist = gray.histogram()
    total = sum(hist)
    if total == 0:
        return 0.0
    differing = sum(hist[DIFF_THRESHOLD + 1:])
    return differing / total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--name", default="shots")
    args = ap.parse_args()

    base_dir = os.path.abspath(args.baseline)
    new_dir = os.path.abspath(args.new)
    for d in (base_dir, new_dir):
        if not os.path.isdir(d):
            print(f"[FATAL] 目录不存在：{d}", flush=True)
            return 2

    base_files = {f for f in os.listdir(base_dir) if f.lower().endswith(".png")}
    new_files = {f for f in os.listdir(new_dir) if f.lower().endswith(".png")}
    common = sorted(base_files & new_files)
    added = sorted(new_files - base_files)
    removed = sorted(base_files - new_files)

    entries: list[dict] = []
    identical = 0
    for name in common:
        pa, pb = os.path.join(base_dir, name), os.path.join(new_dir, name)
        try:
            a, b = Image.open(pa), Image.open(pb)
        except Exception as exc:  # noqa: BLE001
            entries.append({"file": name, "error": f"{type(exc).__name__}: {exc}"})
            continue
        size_changed = a.size != b.size
        ratio = None if size_changed else diff_ratio(a, b)
        if ratio == 0.0:
            identical += 1
        entries.append(
            {
                "file": name,
                "baselineSize": list(a.size),
                "newSize": list(b.size),
                "sizeChanged": size_changed,
                "diffRatio": ratio,
            }
        )

    changed = [e for e in entries if e.get("sizeChanged") or (e.get("diffRatio") or 0) > 0]
    changed.sort(key=lambda e: (1 if e.get("sizeChanged") else 0, e.get("diffRatio") or 0), reverse=True)

    # 差异最大的若干张 → side-by-side 对比图
    composites: list[str] = []
    for e in changed[:TOP_N_COMPOSITES]:
        name = e["file"]
        try:
            a, b = Image.open(os.path.join(base_dir, name)).convert("RGB"), Image.open(
                os.path.join(new_dir, name)
            ).convert("RGB")
            h = max(a.height, b.height)
            canvas = Image.new("RGB", (a.width + b.width + 8, h), (255, 0, 255))
            canvas.paste(a, (0, 0))
            canvas.paste(b, (a.width + 8, 0))
            out = os.path.join(new_dir, f"_compare_{name}")
            canvas.save(out)
            composites.append(out)
        except Exception:  # noqa: BLE001
            continue

    report = {
        "name": args.name,
        "baseline": base_dir,
        "new": new_dir,
        "summary": {
            "common": len(common),
            "identical": identical,
            "changed": len(changed),
            "addedOnlyInNew": len(added),
            "removedOnlyInBaseline": len(removed),
        },
        "changed": changed,
        "added": added,
        "removed": removed,
        "composites": composites,
    }
    out_path = args.out or os.path.join(new_dir, "compare-report.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    s = report["summary"]
    print(f"[{args.name}] 同名 {s['common']}｜完全一致 {s['identical']}｜有差异 {s['changed']}"
          f"｜新增 {s['addedOnlyInNew']}｜基线独有 {s['removedOnlyInBaseline']}")
    for e in changed[:15]:
        if e.get("sizeChanged"):
            print(f"  - {e['file']}: 尺寸 {e['baselineSize']} → {e['newSize']}")
        else:
            print(f"  - {e['file']}: 差异像素 {e['diffRatio'] * 100:.2f}%")
    if added:
        print(f"  [added] {added[:8]}{' …' if len(added) > 8 else ''}")
    if removed:
        print(f"  [removed] {removed[:8]}{' …' if len(removed) > 8 else ''}")
    print(f"[REPORT] {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
