#!/usr/bin/env python3
"""spec 12.3.1 对比度保持率（Web 端自动化）。

跑法：`uv run --with playwright --with pillow --with numpy python e2e/run_orb_contrast_web.py`
只读 `packages/web/dist`，不改源码。

口径与 `flutter/feedback/test/orb_contrast_test.dart` 完全一致，两端数字可直接比：
取球心水平带 `|dy| < 0.45R`，比较球内 `r < 0.55R` 与球外 `1.6R–3.2R` 的亮度标准差，
`保持率 = std_in / std_out`，硬性门槛 `≥ 0.85`；浅色主题另加 12.3 的亮度约束
（球心不得比同位置背景更暗）。亮度统一用 `0.299R + 0.587G + 0.114B`。

背景用**周期性竖条纹**而不是真实文字：12.3.1 自己写明官方测量的局限是「球内外落在
不同字形上」，条纹把这个变量消掉，球内外的理论 std 相同。脚本先自检夹具
（`fixtureRatio`，只有背景时球内外 std 之比必须 ≈1），再算保持率；另算一条
**受控保持率** = 同一区域「有球」/「只有背景」两次截图的 std 之比，它不受球内外
区域差异影响。

夹具相位与出图矩阵一致：`flow=0.25`（扫光 seek 到 2500ms 并 paused）、`breath=0.5`。
"""

from __future__ import annotations

import json
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
OUT_DIR = ROOT / "e2e/shots/orb-contrast"

VIEWPORT = (320, 320)
DEVICE_SCALE = 2
BASE_DIAMETER = 56.0
RADIUS_DEV = BASE_DIAMETER / 2 * DEVICE_SCALE
BAND_HALF = 0.45 * RADIUS_DEV
INSIDE_OUTER = 0.55 * RADIUS_DEV
OUTSIDE_INNER = 1.6 * RADIUS_DEV
OUTSIDE_OUTER = 3.2 * RADIUS_DEV
MIN_RETENTION = 0.85
# 条纹周期 4 CSS px（2 深 2 浅）→ deviceScaleFactor 2 下正好 8 设备像素，
# 与 Flutter 用例的 _stripePeriod = 8 设备像素一致。
STRIPE_CSS = 2
# 浅色沿用出图矩阵的 #c9c9c9 台架，深色沿用 #202020；对侧灰拉开足够对比。
THEMES = {
    "light": ("#c9c9c9", "#303030"),
    "dark": ("#202020", "#d8d8d8"),
}

FIXTURE_JS = """() => {
  const host = document.querySelector('feedback-widget');
  const root = host.shadowRoot;
  const orb = root.querySelector('.fb-orb');
  orb.style.left = 'calc(50% - 28px)';
  orb.style.right = 'auto';
  orb.style.top = 'calc(50% - 28px)';
  orb.style.bottom = 'auto';
  const style = document.createElement('style');
  style.textContent = [
    '.fb-orb { animation: none !important; }',
    '.fb-orb-sweep::before { animation-play-state: paused !important; }'
  ].join('\\n');
  root.appendChild(style);
  orb.style.setProperty('--fb-orb-breath', '0.5');
  const animations = root.getAnimations({ subtree: true });
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = 2500;
  }
  const rect = orb.getBoundingClientRect();
  return {
    breath: getComputedStyle(orb).getPropertyValue('--fb-orb-breath').trim(),
    animationName: getComputedStyle(orb).animationName,
    center: [rect.x + rect.width / 2, rect.y + rect.height / 2],
    size: [rect.width, rect.height],
  };
}"""

HIDE_JS = """() => {
  const host = document.querySelector('feedback-widget');
  host.shadowRoot.querySelector('.fb-orb').style.visibility = 'hidden';
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


def fixture_html(theme: str) -> bytes:
    base, stripe = THEMES[theme]
    period = STRIPE_CSS * 2
    return f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Orb contrast fixture ({theme})</title>
<style>
  html, body {{ margin: 0; height: 100%; overflow: hidden; background: {base}; }}
  /* 硬停止的重复渐变：条纹边界落在整 CSS 像素上，deviceScaleFactor 2 下不产生
     半透明过渡列。background-position 让条纹边界对齐视口中心（球心）。 */
  body {{
    background-image: repeating-linear-gradient(90deg,
      {base} 0 {STRIPE_CSS}px, {stripe} {STRIPE_CSS}px {period}px);
    background-position: calc(50% - {STRIPE_CSS}px) 0;
  }}
</style>
</head>
<body>
<feedback-widget launcher-mode="orb" capture-mode="off" theme="{theme}"></feedback-widget>
<script src="/feedback-web.umd.cjs"></script>
</body></html>""".encode()


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
        if path in ("/light", "/dark"):
            body = fixture_html(path.removeprefix("/"))
            self._headers(200, "text/html; charset=utf-8", len(body))
            self.wfile.write(body)
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


def sample(arr: Any, center: tuple[float, float], inner: float, outer: float) -> list[float]:
    """`|dy| < BAND_HALF` 带内、半径落在 [inner, outer] 的像素亮度（设备像素）。"""
    width, height = png_probe.size(arr)
    cx, cy = center[0] * DEVICE_SCALE, center[1] * DEVICE_SCALE
    y_from = max(0, int(cy - BAND_HALF) + 1)
    y_to = min(height - 1, int(cy + BAND_HALF))
    lo, hi = inner * inner, outer * outer
    out: list[float] = []
    for y in range(y_from, y_to + 1):
        row = arr[y]
        dy = y + 0.5 - cy
        for x in range(width):
            dx = x + 0.5 - cx
            d = dx * dx + dy * dy
            if d < lo or d > hi:
                continue
            pixel = row[x]
            out.append(0.299 * int(pixel[0]) + 0.587 * int(pixel[1]) + 0.114 * int(pixel[2]))
    return out


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def std(values: list[float]) -> float:
    avg = mean(values)
    return (sum((v - avg) ** 2 for v in values) / len(values)) ** 0.5


def run_theme(browser: Any, base_url: str, theme: str, results: Results) -> dict[str, Any]:
    context = browser.new_context(
        viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        device_scale_factor=DEVICE_SCALE,
        color_scheme=theme,
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.goto(f"{base_url}{theme}", wait_until="load")
    page.wait_for_function(
        "customElements.get('feedback-widget') && "
        "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-orb')"
    )
    fixture = page.evaluate(FIXTURE_JS)
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    results.check(
        f"[{theme}] 夹具：breath=0.5、root 呼吸动画已停",
        fixture["breath"] == "0.5" and fixture["animationName"] == "none",
        fixture,
    )
    results.check(
        f"[{theme}] 夹具：球基础直径 56、球心在视口中心",
        all(abs(v - BASE_DIAMETER) <= 0.5 for v in fixture["size"])
        and all(abs(c - v / 2) <= 0.5 for c, v in zip(fixture["center"], VIEWPORT)),
        {"center": fixture["center"], "size": fixture["size"]},
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with_path = OUT_DIR / f"contrast-{theme}-with-orb.png"
    plain_path = OUT_DIR / f"contrast-{theme}-background.png"
    page.screenshot(path=str(with_path))
    page.evaluate(HIDE_JS)
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.screenshot(path=str(plain_path))
    results.check(f"[{theme}] 无页面错误", not errors, errors)
    context.close()

    with_arr = png_probe.decode(with_path.read_bytes())
    plain_arr = png_probe.decode(plain_path.read_bytes())
    center = tuple(fixture["center"])
    inside = sample(with_arr, center, 0.0, INSIDE_OUTER)
    outside = sample(with_arr, center, OUTSIDE_INNER, OUTSIDE_OUTER)
    inside_plain = sample(plain_arr, center, 0.0, INSIDE_OUTER)
    outside_plain = sample(plain_arr, center, OUTSIDE_INNER, OUTSIDE_OUTER)

    results.check(f"[{theme}] 球内采样足量", len(inside) > 500, len(inside))
    results.check(f"[{theme}] 球外采样足量", len(outside) > 5000, len(outside))

    fixture_ratio = std(inside_plain) / std(outside_plain)
    results.check(
        f"[{theme}] 条纹夹具自身均匀（只有背景时球内外 std 之比 ≈1）",
        abs(fixture_ratio - 1.0) <= 0.05,
        round(fixture_ratio, 4),
    )

    spec_retention = std(inside) / std(outside)
    controlled = std(inside) / std(inside_plain)
    results.check(
        f"[{theme}] spec 12.3.1 口径保持率 ≥ {MIN_RETENTION}",
        spec_retention >= MIN_RETENTION,
        round(spec_retention, 4),
    )
    results.check(
        f"[{theme}] 受控口径（同区域有球 / 无球）保持率 ≥ {MIN_RETENTION}",
        controlled >= MIN_RETENTION,
        round(controlled, 4),
    )
    if theme == "light":
        results.check(
            "[light] 12.3 亮度约束：球心不得比同位置背景更暗",
            mean(inside) >= mean(inside_plain),
            {"meanIn": round(mean(inside), 2), "meanInPlain": round(mean(inside_plain), 2)},
        )
    return {
        "theme": theme,
        "specRetention": round(spec_retention, 4),
        "controlled": round(controlled, 4),
        "fixtureRatio": round(fixture_ratio, 4),
        "stdIn": round(std(inside), 2),
        "stdOut": round(std(outside), 2),
        "stdInPlain": round(std(inside_plain), 2),
        "meanIn": round(mean(inside), 2),
        "meanInPlain": round(mean(inside_plain), 2),
        "nIn": len(inside),
        "nOut": len(outside),
    }


def main() -> int:
    if not BUNDLE.exists():
        print(f"缺少 {BUNDLE.relative_to(ROOT)}，先在 packages/web 执行 pnpm build", file=sys.stderr)
        return 2
    from playwright.sync_api import sync_playwright

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
                for theme in ("light", "dark"):
                    summary.append(run_theme(browser, base_url, theme, results))
            finally:
                browser.close()
    finally:
        server.shutdown()

    for entry in summary:
        print(
            "ORB_CONTRAST {theme} specRetention={specRetention} controlled={controlled} "
            "fixtureRatio={fixtureRatio} stdIn={stdIn} stdOut={stdOut} "
            "stdInPlain={stdInPlain} meanIn={meanIn} meanInPlain={meanInPlain} "
            "nIn={nIn} nOut={nOut}".format(**entry),
            flush=True,
        )
    print(f"passed={results.passed} failed={results.failed}", flush=True)
    print(f"截图仅本地证据，未入库：{OUT_DIR.relative_to(ROOT)}", flush=True)
    return 0 if results.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
