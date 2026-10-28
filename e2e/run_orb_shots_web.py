#!/usr/bin/env python3
"""T8-web：按 docs/orb-spec.md 10.2 输出 Web 灵感球 10 张截图与 manifest。

夹具约束（见任务卡 T8-web）：
- flow=0.25：.fb-orb-sweep::before 用 animation-delay:-2.5s + paused 冻结；
- breath=0.5：关闭 root 的 fb-orb-breath 动画并以 inline 变量写入 0.5；
- 320×320 clip × deviceScaleFactor 2 → 640×640，球始终位于 clip 中心。
测试页只覆盖 .fb-orb 的定位与动画相位，不修改 packages/web/src，也不新增公开属性。
"""

from __future__ import annotations

import json
import math
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "packages/web/dist/feedback-web.umd.cjs"
OUT_DIR = ROOT / "e2e/shots/orb-hyperos4/web"
MANIFEST = OUT_DIR / "manifest.json"

VIEWPORT = (640, 640)
DEVICE_SCALE = 2
CLIP_SIZE = 320
ORB_BASE_DIAMETER = 56.0
DRAG_DISTANCE = 80.0
FLOW = 0.25
BREATH = 0.5
RELEASE_CURVE = (0.2, 1.35, 0.32, 1.0)
RELEASE_DURATION_MS = 460
RELEASE_SAMPLE_MS = 230
BACKGROUNDS = {"light": "#c9c9c9", "dark": "#202020"}
STATES = ("idle", "hover", "pressed", "dragging", "releasing")


def cubic_bezier_y_at_x(x: float, p1x: float, p1y: float, p2x: float, p2y: float) -> tuple[float, float]:
    def axis(t: float, p1: float, p2: float) -> float:
        return 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t**3

    low, high = 0.0, 1.0
    for _ in range(200):
        mid = (low + high) / 2
        if axis(mid, p1x, p2x) < x:
            low = mid
        else:
            high = mid
    t = (low + high) / 2
    return axis(t, p1x, p2x), axis(t, p1y, p2y)


_, SOLVED_P = cubic_bezier_y_at_x(0.5, *RELEASE_CURVE)
# T8-web 修正：p 取 1.040274（与 Flutter kFeedbackOrbReleaseCurve.transform(0.5) 一致）。
# 曲线在 x=0.5 处过冲，解析值 ≈1.0402804 仅用于复核，夹具写入以修正值为准。
RELEASE_P = 1.040274
RELEASE_PULL = round(1 - RELEASE_P, 6)
RELEASE_TRANSLATE_X = round(DRAG_DISTANCE * RELEASE_PULL, 6)
RELEASE_SCALE = round(1.5 - 0.5 * RELEASE_P, 6)
RELEASE_STRETCH = round(1 + 0.04 * RELEASE_PULL, 6)
RELEASE_GLOW_X = round(-4 * RELEASE_PULL, 6)
RELEASE_DIAMETER = round(ORB_BASE_DIAMETER * RELEASE_SCALE, 6)
RELEASE_NOTE = (
    "Web 由 CSS 过渡直接插值，不 clamp；Flutter 在同帧把 pull clamp 到 0，"
    "故 stretch/glow 两端在过冲段不同"
)

FIXTURE_JS = """() => {
  const host = document.querySelector('feedback-widget');
  const root = host.shadowRoot;
  const orb = root.querySelector('.fb-orb');
  // 仅测试页定位：把固定定位的球移到视口中心，不触碰组件行为。
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
  // 只靠 CSS 的 negative delay 会带上「动画启动到样式注入」的几十毫秒；
  // 用 WAAPI 把扫光精确 seek 到 10s 周期的 25%（2500ms），再保持 paused。
  const animations = root.getAnimations({ subtree: true });
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = 2500;
  }
  return {
    breath: getComputedStyle(orb).getPropertyValue('--fb-orb-breath').trim(),
    animationName: getComputedStyle(orb).animationName,
    animationCount: animations.length
  };
}"""

MEASURE_JS = """() => {
  const host = document.querySelector('feedback-widget');
  const root = host.shadowRoot;
  const orb = root.querySelector('.fb-orb');
  const core = root.querySelector('.fb-orb-core');
  const bloom = root.querySelector('.fb-orb-bloom');
  const sweep = root.querySelector('.fb-orb-sweep');
  const ring = root.querySelector('.fb-orb-focus-ring');
  const orbStyle = getComputedStyle(orb);
  const orbRect = orb.getBoundingClientRect();
  const coreRect = core.getBoundingClientRect();
  const matrixOf = (value) =>
    value === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(value);
  const matrix = matrixOf(orbStyle.transform);
  const sweepBefore = getComputedStyle(sweep, '::before');
  const sweepMatrix = matrixOf(sweepBefore.transform);
  const bloomBeforeOpacity = Number.parseFloat(getComputedStyle(bloom, '::before').opacity);
  const sweepAngle = Math.atan2(sweepMatrix.b, sweepMatrix.a) * 180 / Math.PI;
  const number = (name) => Number.parseFloat(orbStyle.getPropertyValue(name));
  return {
    className: orb.className,
    hovered: orb.matches(':hover'),
    focusRingOpacity: Number.parseFloat(getComputedStyle(ring).opacity),
    rootRect: [orbRect.x, orbRect.y, orbRect.width, orbRect.height],
    rootCenter: [orbRect.x + orbRect.width / 2, orbRect.y + orbRect.height / 2],
    coreRect: [coreRect.x, coreRect.y, coreRect.width, coreRect.height],
    coreCenter: [coreRect.x + coreRect.width / 2, coreRect.y + coreRect.height / 2],
    stateScale: number('--fb-orb-state-scale'),
    breath: number('--fb-orb-breath'),
    breathWeight: number('--fb-orb-breath-weight'),
    stretch: number('--fb-orb-stretch-along'),
    glowX: number('--fb-orb-glow-x'),
    glowY: number('--fb-orb-glow-y'),
    dragAngle: number('--fb-orb-drag-angle'),
    rootTransform: orbStyle.transform,
    rootTranslate: [matrix.m41, matrix.m42],
    opacity: Number.parseFloat(orbStyle.opacity),
    bloomOpacity: Number.parseFloat(getComputedStyle(bloom).opacity),
    bloomBeforeOpacity,
    sweepBeforeTransform: sweepBefore.transform,
    sweepAngleDeg: sweepAngle,
    sweepAnimationDelay: sweepBefore.animationDelay,
    sweepAnimationPlayState: sweepBefore.animationPlayState,
    rootAnimationName: orbStyle.animationName
  };
}"""

RELEASE_JS = """async (values) => {
  const host = document.querySelector('feedback-widget');
  const root = host.shadowRoot;
  const orb = root.querySelector('.fb-orb');
  const init = {
    bubbles: true, composed: true, button: 0, buttons: 1,
    pointerId: 41, pointerType: 'mouse', isPrimary: true
  };
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  orb.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: 320, clientY: 320 }));
  orb.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: 400, clientY: 320 }));
  await raf();
  orb.dispatchEvent(new PointerEvent('pointercancel', {
    ...init, buttons: 0, clientX: 400, clientY: 320
  }));
  await raf();
  await raf();
  const releasingAtFreeze = orb.classList.contains('is-releasing');
  orb.style.setProperty('transition', 'none');
  orb.style.setProperty('--fb-orb-state-scale', String(values.stateScale));
  orb.style.setProperty('--fb-orb-breath-weight', '0');
  orb.style.setProperty('--fb-orb-drag-angle', '0rad');
  orb.style.setProperty('--fb-orb-stretch-along', String(values.stretch));
  orb.style.setProperty('--fb-orb-glow-x', `${values.glowX}px`);
  orb.style.setProperty('--fb-orb-glow-y', '0px');
  orb.style.transform = `translate3d(${values.translateX}px, 0px, 0)`;
  await raf();
  return {
    releasingAtFreeze,
    dragging: orb.classList.contains('is-dragging'),
    transition: getComputedStyle(orb).transitionProperty
  };
}"""

PROBE_JS = """async () => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:10px;height:10px';
  document.body.appendChild(el);
  const animation = new Animation(new KeyframeEffect(
    el,
    [{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }],
    { duration: 460, easing: 'cubic-bezier(0.2, 1.35, 0.32, 1)', fill: 'both' }
  ));
  animation.play();
  animation.pause();
  animation.currentTime = 230;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  el.remove();
  return matrix.m41 / 100;
}"""


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, name: str, ok: bool, measured: Any) -> bool:
        if ok:
            self.passed += 1
            status = "PASS"
        else:
            self.failed += 1
            status = "FAIL"
        if isinstance(measured, (dict, list, tuple)):
            detail = json.dumps(measured, ensure_ascii=False, separators=(",", ":"))
        else:
            detail = str(measured)
        print(f"[{status}] {name} | measured={detail}", flush=True)
        return ok


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def fixture_html(theme: str) -> bytes:
    background = BACKGROUNDS[theme]
    return f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orb screenshot fixture ({theme})</title>
<style>html, body {{ margin: 0; height: 100%; overflow: hidden; background: {background}; }}</style>
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
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
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
        if path == "/favicon.ico":
            self._headers(204, "image/x-icon", 0)
            return
        body = b'{"error":"not found"}'
        self._headers(404, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)


def close_to(value: float, expected: float, tolerance: float) -> bool:
    return math.isfinite(value) and abs(value - expected) <= tolerance


def launch_browser(playwright: Any) -> tuple[Any, str, list[str]]:
    failures: list[str] = []
    attempts = (
        ("chrome", {"channel": "chrome"}),
        ("chromium-default", {}),
        ("chromium-channel", {"channel": "chromium"}),
    )
    for label, kwargs in attempts:
        try:
            return playwright.chromium.launch(headless=True, **kwargs), label, failures
        except Exception as exc:  # Playwright 启动错误类型因安装方式而异
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
    raise RuntimeError("；".join(failures))


def open_fixture(browser: Any, base_url: str, theme: str) -> tuple[Any, Any, list[str]]:
    context = browser.new_context(
        viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        device_scale_factor=DEVICE_SCALE,
        color_scheme=theme,
    )
    page = context.new_page()
    page.emulate_media(reduced_motion="no-preference", color_scheme=theme)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )
    page.goto(f"{base_url}{theme}", wait_until="load")
    page.wait_for_function(
        "customElements.get('feedback-widget') && "
        "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-orb')"
    )
    page.evaluate(FIXTURE_JS)
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    return context, page, errors


def expected_for(theme: str, state: str) -> dict[str, Any]:
    common: dict[str, Any] = {
        "stateScale": 1.0,
        "breathWeight": 1.0,
        "stretch": 1.0,
        "glowX": 0.0,
        "translateX": 0.0,
        "d": ORB_BASE_DIAMETER,
        "coreWidth": ORB_BASE_DIAMETER * (1 + 0.02 * BREATH),
        "coreHeight": ORB_BASE_DIAMETER * (1 + 0.02 * BREATH),
        "bloomBeforeOpacity": (0.45 if theme == "light" else 0.55) * (1 + 0.08 * BREATH),
        "p": None,
        "pull": 0.0,
    }
    if state == "idle":
        return common
    if state == "hover":
        common.update(stateScale=1.04, breathWeight=0.0, coreWidth=58.24, coreHeight=58.24)
        return common
    if state == "pressed":
        common.update(stateScale=0.94, breathWeight=0.0, coreWidth=52.64, coreHeight=52.64)
        return common
    if state == "dragging":
        common.update(
            stateScale=1.5,
            breathWeight=0.0,
            stretch=1.04,
            glowX=-4.0,
            translateX=DRAG_DISTANCE,
            d=84.0,
            coreWidth=87.36,
            coreHeight=84.0,
            pull=1.0,
        )
        return common
    common.update(
        stateScale=RELEASE_SCALE,
        breathWeight=0.0,
        stretch=RELEASE_STRETCH,
        glowX=RELEASE_GLOW_X,
        translateX=RELEASE_TRANSLATE_X,
        d=RELEASE_DIAMETER,
        coreWidth=ORB_BASE_DIAMETER * RELEASE_SCALE * RELEASE_STRETCH,
        coreHeight=ORB_BASE_DIAMETER * RELEASE_SCALE,
        p=RELEASE_P,
        pull=RELEASE_PULL,
    )
    return common


def png_size(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    width, height = struct.unpack(">II", data[16:24])
    return width, height, len(data)


def apply_state(page: Any, state: str) -> dict[str, Any]:
    if state == "idle":
        page.mouse.move(0, 0)
        page.wait_for_timeout(120)
        return {}
    if state == "hover":
        page.mouse.move(320, 320)
        page.wait_for_timeout(300)
        return {}
    if state == "pressed":
        page.mouse.move(320, 320)
        page.mouse.down()
        page.wait_for_timeout(220)
        return {}
    if state == "dragging":
        page.mouse.move(320, 320)
        page.mouse.down()
        page.mouse.move(320 + DRAG_DISTANCE, 320, steps=1)
        page.wait_for_timeout(320)
        return {}
    result = page.evaluate(
        RELEASE_JS,
        {
            "stateScale": RELEASE_SCALE,
            "stretch": RELEASE_STRETCH,
            "glowX": RELEASE_GLOW_X,
            "translateX": RELEASE_TRANSLATE_X,
        },
    )
    page.wait_for_timeout(60)
    return result


def assert_measurement(
    results: Results, theme: str, state: str, expected: dict[str, Any], measured: dict[str, Any], release: dict[str, Any] | None
) -> None:
    label = f"{theme}-{state}"
    results.check(
        f"{label} state-scale",
        close_to(measured["stateScale"], expected["stateScale"], 1e-3),
        {"measured": measured["stateScale"], "expected": expected["stateScale"]},
    )
    results.check(
        f"{label} breath 固定 0.5",
        close_to(measured["breath"], BREATH, 1e-6),
        measured["breath"],
    )
    results.check(
        f"{label} breath-weight",
        close_to(measured["breathWeight"], expected["breathWeight"], 1e-3),
        {"measured": measured["breathWeight"], "expected": expected["breathWeight"]},
    )
    results.check(
        f"{label} stretch",
        close_to(measured["stretch"], expected["stretch"], 1e-3),
        {"measured": measured["stretch"], "expected": expected["stretch"]},
    )
    results.check(
        f"{label} glow-x",
        close_to(measured["glowX"], expected["glowX"], 0.01),
        {"measured": measured["glowX"], "expected": expected["glowX"]},
    )
    results.check(
        f"{label} root translate-x",
        close_to(measured["rootTranslate"][0], expected["translateX"], 0.02),
        {"measured": measured["rootTranslate"], "expected": expected["translateX"]},
    )
    results.check(
        f"{label} core 几何",
        close_to(measured["coreRect"][2], expected["coreWidth"], 0.15)
        and close_to(measured["coreRect"][3], expected["coreHeight"], 0.15),
        {
            "measured": measured["coreRect"][2:],
            "expected": [expected["coreWidth"], expected["coreHeight"]],
        },
    )
    results.check(
        f"{label} 球心与 core 同心",
        close_to(measured["coreCenter"][0], measured["rootCenter"][0], 0.05)
        and close_to(measured["coreCenter"][1], measured["rootCenter"][1], 0.05),
        {"root": measured["rootCenter"], "core": measured["coreCenter"]},
    )
    results.check(
        f"{label} bloom 白色 alpha",
        close_to(measured["bloomBeforeOpacity"], expected["bloomBeforeOpacity"], 2e-3),
        {"measured": measured["bloomBeforeOpacity"], "expected": expected["bloomBeforeOpacity"]},
    )
    results.check(
        f"{label} 扫光冻结在 25%（90deg, paused）",
        close_to(measured["sweepAngleDeg"], 90.0, 0.1)
        and measured["sweepAnimationPlayState"] == "paused",
        {
            "angle": measured["sweepAngleDeg"],
            "delay": measured["sweepAnimationDelay"],
            "playState": measured["sweepAnimationPlayState"],
        },
    )
    results.check(
        f"{label} root breath 动画已停用",
        measured["rootAnimationName"] == "none",
        measured["rootAnimationName"],
    )
    results.check(
        f"{label} 焦点环不可见",
        close_to(measured["focusRingOpacity"], 0.0, 1e-6),
        measured["focusRingOpacity"],
    )
    if state == "hover":
        results.check(f"{label} :hover 生效", measured["hovered"], measured["hovered"])
    elif state == "pressed":
        results.check(
            f"{label} is-pressed 生效",
            "is-pressed" in measured["className"].split(),
            measured["className"],
        )
    elif state == "dragging":
        results.check(
            f"{label} is-dragging 生效",
            "is-dragging" in measured["className"].split(),
            measured["className"],
        )
    elif state == "releasing":
        results.check(
            f"{label} 冻结时处于 is-releasing",
            bool(release and release["releasingAtFreeze"]),
            release,
        )
        results.check(
            f"{label} 冻结值未带 transition",
            bool(release and release["transition"] == "none"),
            release,
        )
    else:
        results.check(
            f"{label} 无交互 class",
            not {"is-pressed", "is-dragging", "is-releasing"} & set(measured["className"].split()),
            measured["className"],
        )


def main() -> int:
    started = time.monotonic()
    results = Results()
    if not BUNDLE.is_file():
        results.check(
            "组件构建产物存在",
            False,
            f"缺少 {BUNDLE}；请先执行 pnpm --filter @feedback/web build",
        )
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="feedback-orb-shots-"))
    server: LocalServer | None = None
    server_thread: threading.Thread | None = None
    browser = None
    browser_closed_cleanly = True
    port = 0
    manifest: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "task": "T8-web",
        "spec": "docs/orb-spec.md 10.2",
        "canvas": {"width": VIEWPORT[0], "height": VIEWPORT[1], "scale": DEVICE_SCALE},
        "clip": {"width": CLIP_SIZE, "height": CLIP_SIZE, "deviceScaleFactor": DEVICE_SCALE},
        "fixture": {
            "flow": FLOW,
            "breath": BREATH,
            "background": BACKGROUNDS,
            "themeAttribute": "theme=light|dark（组件既有属性）",
            "positioning": "测试页 inline 覆盖 .fb-orb 的 left/top 到视口中心；不改组件源码",
            "flowFreeze": "WAAPI 将 .fb-orb-sweep::before 的 10s 扫光 pause 后 seek 到 currentTime=2500ms（25%）；CSS 兜底 animation-play-state:paused",
            "breathFreeze": ".fb-orb { animation:none } + inline --fb-orb-breath:0.5",
            "breathScale": 1 + 0.02 * BREATH,
            "focusRing": "截图矩阵不含 focus-visible；每张断言 .fb-orb-focus-ring opacity=0",
        },
        "release": {
            "curve": "cubic-bezier(0.2, 1.35, 0.32, 1)",
            "durationMs": RELEASE_DURATION_MS,
            "sampleMs": RELEASE_SAMPLE_MS,
            "p": RELEASE_P,
            "pPull": RELEASE_PULL,
            "translateX": RELEASE_TRANSLATE_X,
            "stateScale": RELEASE_SCALE,
            "stretch": RELEASE_STRETCH,
            "glowX": RELEASE_GLOW_X,
            "dragAngle": 0.0,
            "breathWeight": 0.0,
            "d": RELEASE_DIAMETER,
            "note": RELEASE_NOTE,
            "pSource": (
                "任务卡 T8-web 修正值 + Flutter kFeedbackOrbReleaseCurve.transform(0.5)；"
                "解析解与 Chromium WAAPI 230ms 采样仅用于复核"
            ),
        },
        "shots": [],
    }

    try:
        Handler.bundle = BUNDLE.read_bytes()
        server = LocalServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        server_thread = threading.Thread(target=server.serve_forever, name="orb-shots-http", daemon=True)
        server_thread.start()
        base_url = f"http://127.0.0.1:{port}/"
        results.check("临时 HTTP server 已启动", port > 0 and server_thread.is_alive(), base_url)

        try:
            from playwright.sync_api import sync_playwright
        except Exception as exc:
            raise RuntimeError(f"无法导入 Playwright：{exc}") from exc

        with sync_playwright() as playwright:
            try:
                browser, channel, launch_failures = launch_browser(playwright)
                browser_closed_cleanly = False
                manifest["browser"] = {
                    "channel": channel,
                    "version": browser.version,
                    "launchFallbacks": launch_failures,
                }
                results.check("headless 浏览器已启动", bool(browser.version), manifest["browser"])

                probe_context, probe_page, probe_errors = open_fixture(browser, base_url, "light")
                try:
                    probe_p = float(probe_page.evaluate(PROBE_JS))
                finally:
                    probe_context.close()
                manifest["release"]["solvedP"] = SOLVED_P
                manifest["release"]["probeP"] = probe_p
                manifest["release"]["probeDeltaVsP"] = probe_p - RELEASE_P
                results.check(
                    "Chromium 实测 230ms 进度与修正 p 一致",
                    close_to(probe_p, RELEASE_P, 1e-4),
                    {"probeP": probe_p, "p": RELEASE_P, "solvedP": SOLVED_P},
                )
                results.check(
                    "解析解与修正 p 一致（过冲段）",
                    close_to(SOLVED_P, RELEASE_P, 1e-4),
                    {"solvedP": SOLVED_P, "p": RELEASE_P},
                )
                results.check("probe 页无 pageerror", not probe_errors, probe_errors)

                for theme in ("light", "dark"):
                    for state in STATES:
                        context, page, errors = open_fixture(browser, base_url, theme)
                        release_info: dict[str, Any] | None = None
                        try:
                            release_info = apply_state(page, state)
                            measured = page.evaluate(MEASURE_JS)
                            center_x, center_y = measured["rootCenter"]
                            clip_x = round(center_x - CLIP_SIZE / 2)
                            clip_y = round(center_y - CLIP_SIZE / 2)
                            clip = {
                                "x": clip_x,
                                "y": clip_y,
                                "width": CLIP_SIZE,
                                "height": CLIP_SIZE,
                            }
                            results.check(
                                f"{theme}-{state} clip 位于视口内",
                                0 <= clip_x and clip_x + CLIP_SIZE <= VIEWPORT[0]
                                and 0 <= clip_y and clip_y + CLIP_SIZE <= VIEWPORT[1],
                                clip,
                            )
                            path = OUT_DIR / f"{theme}-{state}.png"
                            page.screenshot(path=str(path), clip=clip)
                            width, height, size = png_size(path)
                            results.check(
                                f"{theme}-{state} PNG 640×640",
                                (width, height) == (640, 640),
                                {"width": width, "height": height, "bytes": size},
                            )
                            page.wait_for_timeout(20)
                            results.check(f"{theme}-{state} 无 pageerror/console error", not errors, errors)

                            expected = expected_for(theme, state)
                            assert_measurement(results, theme, state, expected, measured, release_info)

                            manifest["shots"].append(
                                {
                                    "file": path.name,
                                    "state": state,
                                    "background": BACKGROUNDS[theme],
                                    "brightness": theme,
                                    "d": expected["d"],
                                    "stateScale": expected["stateScale"],
                                    "breathWeight": expected["breathWeight"],
                                    "dragAngle": 0.0,
                                    "pull": expected["pull"],
                                    "glowOffset": {"dx": expected["glowX"], "dy": 0.0},
                                    "flow": FLOW,
                                    "breath": BREATH,
                                    "p": expected["p"],
                                    "clip": clip,
                                    "png": {"width": width, "height": height, "bytes": size},
                                    "expected": {
                                        "stateScale": expected["stateScale"],
                                        "breathWeight": expected["breathWeight"],
                                        "stretch": expected["stretch"],
                                        "glowX": expected["glowX"],
                                        "translateX": expected["translateX"],
                                        "d": expected["d"],
                                        "coreRect": [expected["coreWidth"], expected["coreHeight"]],
                                        "bloomBeforeOpacity": expected["bloomBeforeOpacity"],
                                    },
                                    "measured": measured,
                                    "releaseFreeze": release_info,
                                }
                            )
                            print(
                                f"[SHOT] {path.name} clip={clip} scale={measured['stateScale']} "
                                f"core={measured['coreRect'][2]:.3f}x{measured['coreRect'][3]:.3f} "
                                f"center=({center_x:.2f},{center_y:.2f})",
                                flush=True,
                            )
                        finally:
                            context.close()

                result = manifest["release"]
                results.check(
                    "manifest release 与 Flutter manifest 口径一致（p=1.040274）",
                    close_to(result["p"], 1.040274, 1e-9)
                    and close_to(result["stateScale"], 0.979863, 1e-6)
                    and close_to(result["translateX"], -3.22192, 1e-5)
                    and close_to(result["stretch"], 0.998389, 1e-6)
                    and close_to(result["glowX"], 0.161096, 1e-6)
                    and close_to(result["d"], 54.872333, 1e-5),
                    {
                        "p": result["p"],
                        "stateScale": result["stateScale"],
                        "translateX": result["translateX"],
                        "stretch": result["stretch"],
                        "glowX": result["glowX"],
                        "d": result["d"],
                    },
                )
            finally:
                if browser is not None:
                    try:
                        browser.close()
                        browser_closed_cleanly = True
                    except Exception as exc:
                        results.check("browser 关闭", False, f"{type(exc).__name__}: {exc}")
                    finally:
                        browser = None
    except Exception as exc:
        results.check("截图 harness 完成", False, f"{type(exc).__name__}: {exc}")
    finally:
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception as exc:
                results.check("HTTP server 关闭", False, f"{type(exc).__name__}: {exc}")
        if server_thread is not None:
            server_thread.join(timeout=5)
        try:
            shutil.rmtree(temp_dir)
        except Exception as exc:
            results.check("临时目录删除", False, f"{type(exc).__name__}: {exc}")

    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    results.check("manifest 写入", MANIFEST.is_file(), str(MANIFEST))

    cleanup = {
        "browserClosed": browser_closed_cleanly,
        "serverThreadStopped": server_thread is None or not server_thread.is_alive(),
        "tempDirRemoved": not temp_dir.exists(),
        "port": port,
    }
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        cleanup["portClosed"] = sock.connect_ex(("127.0.0.1", port)) != 0 if port else True
    results.check(
        "finally 完成 browser/server/temp 清理",
        all((cleanup["browserClosed"], cleanup["serverThreadStopped"], cleanup["tempDirRemoved"])),
        cleanup,
    )
    results.check("临时 HTTP 端口已关闭", cleanup["portClosed"], cleanup)

    total = results.passed + results.failed
    print(
        f"[SUMMARY] PASS={results.passed} FAIL={results.failed} TOTAL={total} "
        f"P={RELEASE_P:.6f} DURATION={time.monotonic() - started:.2f}s",
        flush=True,
    )
    return 1 if results.failed else 0


if __name__ == "__main__":
    sys.exit(main())
