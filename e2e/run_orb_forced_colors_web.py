#!/usr/bin/env python3
"""forced-colors 下灵感球焦点环可见性（spec 5）。

跑法：`uv run --with playwright --with pillow --with numpy python e2e/run_orb_forced_colors_web.py`
只读 `packages/web/dist`，不改源码。

**结论先行（2026-10-29 实测）：环在强制调色下本来就可见，不需要新增 CSS 规则。**
焦点环是自绘层（`.fb-orb-focus-ring` 的 border），当初担心的是「作者颜色
`--fb-accent` 在强制调色下失效、环读不出来」。实测相反：UA 会把 `border-color`
强制映射成系统前景色 `CanvasText`，实测与 `Canvas` 背景 21:1；而且 `CanvasText`/
`Canvas` 是规范保证成对的对比色，比我们自己挑 `Highlight`（与 `Canvas` 并非保证
成对）更稳。所以这里只留验证，不改实现。

那么真正要守的回归是**别把这条映射关掉**：任何给环或其祖先加上
`forced-color-adjust: none`（或等价的 `-ms-high-contrast-adjust`）的改动，都会让环
停在 `--fb-accent`，在高对比深色主题下只有 2.9:1，低于 WCAG 非文本的 3:1。本脚本
的核心断言就是这一条，并且做过变异验证：加上 `forced-color-adjust: none` 即转红。

断言分两层，缺一不可：
- 计算样式：强制调色下环色必须已被映射成系统色（不再等于 `--fb-accent`）；
  几何（2px 环宽、外径 = 视觉直径 + 8、与球同心）两种模式下都不得变化；
- 实际像素：从截图里取环所在圆环带，环色像素必须真的存在；强制调色下还要与紧邻的
  球外背景满足 WCAG 非文本对比度 ≥ 3:1。只看计算样式会漏掉「环被别的层盖住」。

对比度 ≥3:1 **只在强制调色模式下作为门槛**：那里用的是系统成对色，达不到就是实现
问题。非强制模式下环色是作者强调色 `--fb-accent`，实测对比度取决于宿主页背景，本卡
不替产品定这个门槛，只把测得值打成 `[DATA]`（夹具的 #c9c9c9 灰只有 2.85:1，已记为
独立遗留项）。
"""

from __future__ import annotations

import json
import re
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import png_probe

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "packages/web/dist/feedback-web.umd.cjs"
STYLES_SRC = ROOT / "packages/web/src/styles.ts"
OUT_DIR = ROOT / "e2e/shots/orb-forced-colors"

# 源码扫描结果，由 main() 填充：强制调色映射被显式关掉的声明。
FORCED_ADJUST_OFF: list[str] = []

VIEWPORT = (320, 320)
DEVICE_SCALE = 2
BASE_DIAMETER = 56.0
RING_GAP = 2.0
RING_WIDTH = 2.0
# 焦点环外径 = 当前视觉直径 + 2 × (间隙 + 环宽)，静止态 56 → 64（spec 5）。
RING_OUTER = BASE_DIAMETER + 2 * (RING_GAP + RING_WIDTH)
MIN_CONTRAST = 3.0

MEASURE_JS = """() => {
  const host = document.querySelector('feedback-widget');
  const root = host.shadowRoot;
  const orb = root.querySelector('.fb-orb');
  const ring = root.querySelector('.fb-orb-focus-ring');
  const ringStyle = getComputedStyle(ring);
  const orbRect = orb.getBoundingClientRect();
  const ringRect = ring.getBoundingClientRect();
  return {
    focusVisible: orb.matches(':focus-visible'),
    activeTag: root.activeElement ? root.activeElement.className : null,
    ringOpacity: Number.parseFloat(ringStyle.opacity),
    ringColor: ringStyle.borderTopColor,
    ringWidth: Number.parseFloat(ringStyle.borderTopWidth),
    orbOutline: getComputedStyle(orb).outlineStyle,
    forced: matchMedia('(forced-colors: active)').matches,
    ringOuter: [ringRect.width, ringRect.height],
    ringCenter: [ringRect.x + ringRect.width / 2, ringRect.y + ringRect.height / 2],
    orbCenter: [orbRect.x + orbRect.width / 2, orbRect.y + orbRect.height / 2],
  };
}"""


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, name: str, ok: bool, measured: Any) -> bool:
        self.passed += 1 if ok else 0
        self.failed += 0 if ok else 1
        if isinstance(measured, (dict, list, tuple)):
            detail = json.dumps(measured, ensure_ascii=False, separators=(",", ":"))
        else:
            detail = str(measured)
        print(f"[{'PASS' if ok else 'FAIL'}] {name} | measured={detail}", flush=True)
        return ok


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


FIXTURE = b"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Orb forced-colors fixture</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; background: #c9c9c9; }</style>
</head>
<body>
<feedback-widget launcher-mode="orb" capture-mode="off" theme="light"></feedback-widget>
<script src="/feedback-web.umd.cjs"></script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    bundle: bytes = b""

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _headers(self, status: int, content_type: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/":
            self._headers(200, "text/html; charset=utf-8", len(FIXTURE))
            self.wfile.write(FIXTURE)
            return
        if path == "/feedback-web.umd.cjs":
            self._headers(200, "text/javascript; charset=utf-8", len(self.bundle))
            self.wfile.write(self.bundle)
            return
        self._headers(404, "application/json; charset=utf-8", 2)
        self.wfile.write(b"{}")


def launch_browser(playwright: Any) -> tuple[Any, str]:
    failures: list[str] = []
    for label, kwargs in (
        ("chrome", {"channel": "chrome"}),
        ("chromium-default", {}),
        ("chromium-channel", {"channel": "chromium"}),
    ):
        try:
            return playwright.chromium.launch(headless=True, **kwargs), label
        except Exception as exc:  # 启动错误类型因安装方式而异
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
    raise RuntimeError("；".join(failures))


def parse_rgb(value: str) -> tuple[int, int, int]:
    body = value[value.index("(") + 1 : value.rindex(")")]
    parts = [p.strip() for p in body.replace("/", " ").split(",")]
    if len(parts) == 1:
        parts = body.split()
    return tuple(int(round(float(p))) for p in parts[:3])  # type: ignore[return-value]


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    def channel(raw: int) -> float:
        srgb = raw / 255
        return srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def annulus_pixels(
    arr: Any, center: tuple[float, float], inner: float, outer: float
) -> list[tuple[int, int, int]]:
    """取以球心为心、半径落在 [inner, outer] 的像素（CSS px → 设备像素）。"""
    width, height = png_probe.size(arr)
    cx, cy = center[0] * DEVICE_SCALE, center[1] * DEVICE_SCALE
    lo, hi = (inner * DEVICE_SCALE) ** 2, (outer * DEVICE_SCALE) ** 2
    out: list[tuple[int, int, int]] = []
    for y in range(height):
        for x in range(width):
            d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2
            if lo <= d <= hi:
                pixel = arr[y][x]
                out.append((int(pixel[0]), int(pixel[1]), int(pixel[2])))
    return out


def dominant(pixels: list[tuple[int, int, int]]) -> tuple[tuple[int, int, int], int]:
    counts: dict[tuple[int, int, int], int] = {}
    for pixel in pixels:
        counts[pixel] = counts.get(pixel, 0) + 1
    best = max(counts.items(), key=lambda item: item[1])
    return best[0], best[1]


def run_mode(browser: Any, base_url: str, forced: bool, results: Results) -> dict[str, Any]:
    label = "active" if forced else "none"
    context = browser.new_context(
        viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        device_scale_factor=DEVICE_SCALE,
        color_scheme="light",
        forced_colors="active" if forced else "none",
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.goto(base_url, wait_until="load")
    page.wait_for_function(
        "customElements.get('feedback-widget') && "
        "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-orb')"
    )
    # 键盘聚焦才满足 :focus-visible；点击不得点亮环（spec 5）。
    page.keyboard.press("Tab")
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    measured = page.evaluate(MEASURE_JS)
    results.check(f"[{label}] 媒体特性被正确模拟", measured["forced"] is forced, measured["forced"])
    results.check(f"[{label}] Tab 后球进入 :focus-visible", measured["focusVisible"] is True, measured)
    results.check(f"[{label}] 焦点环可见（opacity=1）", measured["ringOpacity"] == 1.0, measured["ringOpacity"])
    results.check(
        f"[{label}] 环宽仍是 2px（a11y 不改第 5 节几何）",
        abs(measured["ringWidth"] - RING_WIDTH) <= 1e-6,
        measured["ringWidth"],
    )
    results.check(
        f"[{label}] 外径仍是 视觉直径+8 = {RING_OUTER:g}",
        all(abs(v - RING_OUTER) <= 0.5 for v in measured["ringOuter"]),
        measured["ringOuter"],
    )
    results.check(
        f"[{label}] 环与球同心",
        all(abs(a - b) <= 0.5 for a, b in zip(measured["ringCenter"], measured["orbCenter"])),
        [measured["ringCenter"], measured["orbCenter"]],
    )
    results.check(f"[{label}] 无页面错误", not errors, errors)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shot = OUT_DIR / f"focus-ring-forced-colors-{label}.png"
    page.screenshot(path=str(shot))
    arr = png_probe.decode(shot.read_bytes())

    center = tuple(measured["orbCenter"])
    ring_outer_r = RING_OUTER / 2
    ring_pixels = annulus_pixels(arr, center, ring_outer_r - RING_WIDTH, ring_outer_r)
    # 球外背景：环外再留 2px 余量，避免抗锯齿边缘混入。
    bg_pixels = annulus_pixels(arr, center, ring_outer_r + 3, ring_outer_r + 8)
    ring_rgb, ring_hits = dominant(ring_pixels)
    bg_rgb, _ = dominant(bg_pixels)
    ratio = contrast_ratio(ring_rgb, bg_rgb)
    results.check(
        f"[{label}] 环所在圆环带确有稳定主色（未被其他层盖住）",
        ring_hits >= 40,
        {"ringRgb": ring_rgb, "hits": ring_hits, "sampled": len(ring_pixels)},
    )
    if forced:
        # ≥3:1 只在强制调色下作为门槛：系统色成对保证对比度，达不到就是我们的锅。
        results.check(
            f"[{label}] 环与紧邻背景对比度 ≥ {MIN_CONTRAST}:1（WCAG 非文本）",
            ratio >= MIN_CONTRAST,
            {"ringRgb": ring_rgb, "bgRgb": bg_rgb, "contrast": round(ratio, 3)},
        )
    else:
        # 非强制模式下环色是作者的 --fb-accent，对比度取决于宿主背景，不是本卡
        # 能定的门槛（夹具这块 #c9c9c9 灰只量到 2.85:1，已记为独立遗留）。
        # 这里只守「环真的画出来了且就是声明的强调色」，防自绘层被其他层盖住。
        declared = parse_rgb(measured["ringColor"])
        results.check(
            f"[{label}] 环像素就是声明的 --fb-accent（自绘层未被遮挡）",
            all(abs(a - b) <= 2 for a, b in zip(ring_rgb, declared)),
            {"ringRgb": ring_rgb, "declared": declared},
        )
        print(
            f"[DATA] [{label}] 环与夹具背景对比度={ratio:.3f}:1 "
            f"ring={ring_rgb} bg={bg_rgb}（非门槛，见任务卡遗留项）",
            flush=True,
        )
    context.close()
    return {
        "mode": label,
        "declaredColor": measured["ringColor"],
        "outlineStyle": measured["orbOutline"],
        "ringRgb": list(ring_rgb),
        "bgRgb": list(bg_rgb),
        "contrast": round(ratio, 3),
        "shot": shot.name,
    }


def main() -> int:
    if not BUNDLE.exists():
        print(f"缺少 {BUNDLE.relative_to(ROOT)}，先在 packages/web 执行 pnpm build", file=sys.stderr)
        return 2
    from playwright.sync_api import sync_playwright

    global FORCED_ADJUST_OFF
    FORCED_ADJUST_OFF = sorted(
        {
            match.group(0)
            for match in re.finditer(
                r"(?:forced-color-adjust|-ms-high-contrast-adjust)\s*:\s*none",
                STYLES_SRC.read_text(encoding="utf-8"),
            )
        }
    )

    handler = Handler
    handler.bundle = BUNDLE.read_bytes()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = LocalServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{port}/"

    results = Results()
    summary: list[dict[str, Any]] = []
    try:
        with sync_playwright() as playwright:
            browser, channel = launch_browser(playwright)
            print(f"browser={channel} pngBackend={png_probe.backend()}", flush=True)
            try:
                for forced in (False, True):
                    summary.append(run_mode(browser, base_url, forced, results))
            finally:
                browser.close()
    finally:
        server.shutdown()

    normal, forced = summary[0], summary[1]
    results.check(
        "强制调色下环色已被映射成系统色（没有 forced-color-adjust: none 把映射关掉）",
        forced["declaredColor"] != normal["declaredColor"],
        {"none": normal["declaredColor"], "active": forced["declaredColor"]},
    )
    results.check(
        "两种模式都关掉 UA outline，不出现双环",
        normal["outlineStyle"] == "none" and forced["outlineStyle"] == "none",
        {"none": normal["outlineStyle"], "active": forced["outlineStyle"]},
    )
    results.check(
        "源码里没有 forced-color-adjust / -ms-high-contrast-adjust 的 none 声明",
        not FORCED_ADJUST_OFF,
        FORCED_ADJUST_OFF or "无",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"passed={results.passed} failed={results.failed}", flush=True)
    print(f"截图仅本地证据，未入库：{OUT_DIR.relative_to(ROOT)}", flush=True)
    return 0 if results.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
