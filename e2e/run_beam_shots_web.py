#!/usr/bin/env python3
"""T8-web：0.10 光束唤醒（beam + 圈选）与「确认区域后打开面板」的 7 张截图。

与 run_orb_shots_web.py 同一套约定（任务记录 T8-web）：
- uv + Playwright、headless Chromium、deviceScaleFactor=3；PNG 写入
  e2e/shots/orb-hyperos4/web/beam/（与 orb 截图同根，便于对照），另写 manifest.json；
- 每个场景独立 context + 全新页面，避免图钉 / 唤醒偏好互相污染；
- 只读 e2e/pages/beam.html 的真实组件（UMD 产物），不改 packages/web/src。

触发方式：BEAM 场景用合成双指长按 700ms（DEFAULT_WAKE_GESTURES），松手后组件
await 真实截图再冻结画面；REDUCED 场景用 ⌘/Ctrl+Shift+F 快捷键（默认 wake-shortcut），
在 prefers-reduced-motion: reduce 下函数立即进入「压暗 + 圈选待命」，可稳定截图。

7 帧：
  1 beam-wake-250ms        冻结画面 + 水波纹从双指按压点扩散约 250ms（压暗渐入 / 未进入待命）
  2 lasso-hint             圈选就绪，水波继续消退：压暗 0.26 + 圈选提示 + 选区框不出现
  3 lasso-stroke           圈选中途：轨迹 .fb-lasso 非空、提示仍在
  4 lasso-committed        松手后包围盒展开为选区框（轨迹清空、提示隐藏）
  5 panel-after-use        点「使用此区域」→ 面板带截图打开
  6 reduced-motion-idle    reduced-motion 下快捷键唤醒：光束层 display:none，直接待命
  7 aurora-option          预置 wake-visual=aurora 后同一手势渲染波光（可选项真实生效）
"""

from __future__ import annotations

import json
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
PAGE_FILE = ROOT / "e2e/pages/beam.html"
OUT_DIR = ROOT / "e2e/shots/orb-hyperos4/web/beam"
MANIFEST = OUT_DIR / "manifest.json"

VIEWPORT = (1280, 800)
DEVICE_SCALE = 3
# 与页面 #hero-chart 一致：圈选这一块品红图表区。
CHART_RECT = (656, 120, 560, 300)
BEAM_SAMPLE_MS = 250
BEAM_TOTAL_MS = 760
TOUCH_HOLD_MS = 700
LASSO_POINTS = ((740, 220), (900, 200), (1090, 250), (1160, 330), (1040, 390), (860, 380), (720, 320))

# 第 1 帧：双指长按松手后，等组件完成真实截图（截图先于覆盖层），再等光束播放到 250ms。
WAKE_HOLD_JS = """async (holdMs) => {
  const widget = window.__beam.widget();
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const touch = (type, active, changed = active) => document.dispatchEvent(new TouchEvent(type, {
    bubbles: true, cancelable: true, composed: true, touches: active, changedTouches: changed
  }));
  const [cx, cy] = window.__waterTestOrigin || [640, 380];
  const fingers = () => [
    new Touch({ identifier: 1, target: document.body, clientX: cx - 120, clientY: cy }),
    new Touch({ identifier: 2, target: document.body, clientX: cx + 120, clientY: cy })
  ];
  touch('touchstart', fingers());
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  touch('touchend', [], fingers());
  const startedAt = performance.now();
  while (performance.now() - startedAt < 15000) {
    if (!window.__beam.overlay().hidden) {
      // 覆盖层先以 is-lasso-arming 出现，下一帧 rAF 才由 animateBeam 写入压暗/光束：
      // 以「第一次看到压暗 > 0」的帧作为光束动画 t=0，供调用方按真实进度取样。
      const dim = window.__beam.q('.fb-region-dim');
      const sample = () => Number.parseFloat(dim.style.opacity || '0') > 0;
      if (sample()) {
        return {armed: true, elapsedMs: Math.round(performance.now() - startedAt), beamReady: true};
      }
      await raf();
      if (sample()) {
        return {armed: true, elapsedMs: Math.round(performance.now() - startedAt), beamReady: true};
      }
      // 环境里 rAF 被限流：退化为 16ms 轮询，最长 1s。
      const polled = performance.now();
      while (performance.now() - polled < 1000 && !sample()) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return {
        armed: true,
        beamReady: sample(),
        elapsedMs: Math.round(performance.now() - startedAt),
        dim: dim.style.opacity || ''
      };
    }
    await raf();
  }
  return {armed: false, elapsedMs: Math.round(performance.now() - startedAt), status: window.__beam.statusText()};
}"""

# Read the actual framebuffer during its draw, before the browser discards it.
WATER_PROBE_JS = r"""(() => {
  window.__waterTestOrigin = [384, 290];
  const samples = window.__waterSamples = {};
  const api = WebGLRenderingContext.prototype;
  const upload = api.texImage2D, draw = api.drawArrays;
  const sources = new WeakMap();
  api.texImage2D = function(...args) {
    const result = upload.apply(this, args);
    const image = args.at(-1);
    if (image instanceof HTMLImageElement) sources.set(this, image);
    return result;
  };
  api.drawArrays = function(...args) {
    const result = draw.apply(this, args);
    const beam = this.canvas.parentElement;
    if (!beam?.classList.contains('fb-beam') || samples.later) return result;
    const program = this.getParameter(this.CURRENT_PROGRAM);
    const t = this.getUniform(program, this.getUniformLocation(program, 'seconds'));
    const stage = t > .015 && t < .22 ? 'early'
      : samples.early && t >= Math.max(.26, samples.early.t + .15) && t < .65 ? 'later' : null;
    if (stage && !samples[stage]) {
      const [x, y] = window.__waterTestOrigin;
      const sx = this.canvas.width / beam.clientWidth, sy = this.canvas.height / beam.clientHeight;
      // Scan down from the actual touch, independently of the production radius formula.
      const rows = Math.floor(this.canvas.height - y * sy);
      const rgba = new Uint8Array(rows * 4);
      this.readPixels(Math.floor(x*sx), 0, 1, rows, this.RGBA, this.UNSIGNED_BYTE, rgba);
      const active = [];
      for (let d = 0; d < rows; d++) if (rgba[(rows - 1 - d) * 4 + 3]) active.push(d / sy);
      if (active.length) samples[stage] = {
        first: active[0], last: active.at(-1), t,
        safe: sources.get(this) === window.__beam.q('.fb-region-bg')
      };
    }
    return result;
  };
})()"""

# 取生产样式的实际计算值；截图时保留原有混合与蒙版。
BEAM_MEASURE_JS = r"""() => {
  const overlay = window.__beam.q('.fb-region-overlay');
  const beam = window.__beam.q('.fb-beam');
  const water = beam.querySelectorAll('.fb-ripple-wave');
  const halo = beam.querySelector('.fb-wake-spectrum');
  const band = halo || water[0];
  const style = band && getComputedStyle(band);
  const dim = window.__beam.q('.fb-region-dim');
  return {
    overlayHidden: overlay.hidden,
    arming: overlay.classList.contains('is-lasso-arming'),
    beamOpacity: Number.parseFloat(getComputedStyle(beam).opacity),
    beamDisplay: getComputedStyle(beam).display,
    center: beam.style.getPropertyValue('--fb-wake-origin').trim().split(/ +/).map(parseFloat),
    rippleCount: water.length,
    gpu: !!beam.querySelector('canvas'),
    waterSamples: window.__waterSamples,
    opposingArcs: getComputedStyle(beam).maskImage.includes('repeating-conic-gradient'),
    usesFrozenImage: water.length === 2 && [...water].every(
      el => getComputedStyle(el).backgroundImage.includes(window.__beam.q('.fb-region-bg').src)
    ),
    hasSpectrum: !!halo,
    waveCenters: [...(style?.maskImage || '').matchAll(/radial-gradient\((?:circle )?[\d.]+px at ([\d.]+)px ([\d.]+)px/g)].map(m => [+m[1], +m[2]]),
    conic: !!style && style.backgroundImage.includes('conic-gradient'),
    radialMask: !!style && style.maskImage.includes('radial-gradient'),
    bandOpacity: style ? Number(style.opacity) : 0,
    dimOpacity: Number.parseFloat(dim.style.opacity || '0'),
    hintHidden: window.__beam.q('.fb-lasso-hint').hidden,
    mode: window.__beam.widget().dataset.fbMode,
    panelOpen: window.__beam.panelOpen()
  };
}"""

STATE_JS = """() => {
  const overlay = window.__beam.overlay();
  const frame = window.__beam.q('.fb-region-frame');
  const hint = window.__beam.q('.fb-lasso-hint');
  const lasso = window.__beam.q('.fb-lasso');
  const use = window.__beam.q('.fb-region-use');
  const frameBox = frame.getBoundingClientRect();
  return {
    overlayHidden: overlay.hidden,
    arming: overlay.classList.contains('is-lasso-arming'),
    beamOpacity: Number.parseFloat(getComputedStyle(window.__beam.q('.fb-beam')).opacity),
    beamDisplay: getComputedStyle(window.__beam.q('.fb-beam')).display,
    dimOpacity: Number.parseFloat(window.__beam.q('.fb-region-dim').style.opacity || '0'),
    hintHidden: hint.hidden,
    hintText: (hint.textContent || '').trim(),
    lassoPoints: (lasso.getAttribute('points') || '').length,
    frameOpacity: frame.style.opacity,
    frameSize: frame.dataset.size || null,
    frameRect: [frameBox.x, frameBox.y, frameBox.width, frameBox.height],
    useVisible: !!use && use.getBoundingClientRect().width > 0 && getComputedStyle(use).visibility !== 'hidden',
    useText: use ? (use.textContent || '').trim() : '',
    mode: window.__beam.widget().dataset.fbMode,
    panelOpen: window.__beam.panelOpen()
  };
}"""

PANEL_JS = """async () => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 20000) {
    if (window.__beam.panelOpen()) break;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const panel = window.__beam.q('.fb-panel');
  const box = panel.getBoundingClientRect();
  const textarea = window.__beam.q('.fb-textarea');
  const thumb = window.__beam.q('.fb-screenshot-thumb');
  const thumbBox = thumb ? thumb.getBoundingClientRect() : null;
  return {
    panelOpen: window.__beam.panelOpen(),
    panelHidden: panel.hidden,
    panelRect: [box.x, box.y, box.width, box.height],
    textareaFocused: document.activeElement === window.__beam.widget()
      || window.__beam.shadow().activeElement === textarea,
    thumbSrc: thumb ? (thumb.getAttribute('src') || '').slice(0, 5) : null,
    thumbBox: thumbBox ? [thumbBox.x, thumbBox.y, thumbBox.width, thumbBox.height] : null
  };
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


class Handler(BaseHTTPRequestHandler):
    bundle: bytes = b""
    page: bytes = b""

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
        if path in ("/", "/beam.html"):
            self._headers(200, "text/html; charset=utf-8", len(self.page))
            self.wfile.write(self.page)
            return
        # beam.html 里 src="/sdk/feedback-web.umd.js"，这里直接映射到 dist 产物。
        if path in ("/sdk/feedback-web.umd.js", "/feedback-web.umd.cjs"):
            self._headers(200, "text/javascript; charset=utf-8", len(self.bundle))
            self.wfile.write(self.bundle)
            return
        if path == "/favicon.ico":
            self._headers(204, "image/x-icon", 0)
            return
        body = b'{"error":"not found"}'
        self._headers(404, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)


def png_size(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    width, height = struct.unpack(">II", data[16:24])
    return width, height, len(data)


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


def open_page(browser: Any, base_url: str, reduced_motion: str = "no-preference", init_script: str | None = None) -> tuple[Any, Any, list[str]]:
    context = browser.new_context(
        viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        device_scale_factor=DEVICE_SCALE,
        has_touch=True,
        color_scheme="light",
    )
    if init_script:
        context.add_init_script(init_script)
    page = context.new_page()
    page.emulate_media(reduced_motion=reduced_motion, color_scheme="light")
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )
    page.goto(base_url, wait_until="load")
    page.wait_for_function(
        "customElements.get('feedback-widget') && "
        "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-region-overlay')"
    )
    return context, page, errors


def fire_shortcut(page: Any) -> None:
    """⌘/Ctrl+Shift+F（默认 wake-shortcut）：页面上没有输入焦点，必然落在组件监听上。"""
    page.evaluate("() => { const active = document.activeElement; if (active && active.blur) active.blur(); }")
    page.keyboard.press("Control+Shift+F")


def wait_armed(page: Any, timeout_ms: int = 15000) -> bool:
    try:
        page.wait_for_function("() => !window.__beam.overlay().hidden", timeout=timeout_ms)
        return True
    except Exception:
        return False


def draw_lasso(page: Any, points: tuple[tuple[int, int], ...], pause_every: int = 2) -> None:
    """在覆盖层上画闭合圈：pointerdown → 若干 pointermove → 停在起点（松手由调用方决定）。

    LASSO_POINTS 按 1280×800 视口设计；覆盖层是 position:fixed; inset:0，
    正常情况下比例 1:1，这里按实际视口等比缩放，避免客户端坐标被钳位而
    让轨迹变形（轨迹 points 与指针事件共用同一坐标系，无需再换算）。
    """
    size = page.evaluate("() => window.__beam.viewportSize()")
    sx, sy = size["width"] / VIEWPORT[0], size["height"] / VIEWPORT[1]
    scaled = [(px * sx, py * sy) for px, py in points]
    page.mouse.move(*scaled[0])
    page.mouse.down()
    for index, (px, py) in enumerate(scaled[1:], start=1):
        page.mouse.move(px, py, steps=4)
        if pause_every and index % pause_every == 0:
            page.wait_for_timeout(16)
    page.mouse.move(*scaled[0], steps=4)


def main() -> int:
    started = time.monotonic()
    results = Results()
    if not BUNDLE.is_file():
        results.check("组件构建产物存在", False, f"缺少 {BUNDLE}；请先执行 pnpm --filter @feedback/web build")
        return 1
    if not PAGE_FILE.is_file():
        results.check("光束宿主页存在", False, f"缺少 {PAGE_FILE}")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="feedback-beam-shots-"))
    server: LocalServer | None = None
    server_thread: threading.Thread | None = None
    browser = None
    browser_closed_cleanly = True
    port = 0
    manifest: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "task": "T8-web",
        "fixture": str(PAGE_FILE.relative_to(ROOT)),
        "canvas": {"width": VIEWPORT[0], "height": VIEWPORT[1], "scale": DEVICE_SCALE},
        "hostDefaults": "未声明 launcher-mode / capture-mode → 0.10 默认 beam + viewport",
        "wake": {
            "gesture": "合成双指长按 700ms（DEFAULT_WAKE_GESTURES：two-finger-hold）",
            "shortcut": "⌘/Ctrl+Shift+F（默认 wake-shortcut=primary+shift+f）",
            "beamSampleMs": BEAM_SAMPLE_MS,
            "beamTotalMs": BEAM_TOTAL_MS,
        },
        "chartRect": {"x": CHART_RECT[0], "y": CHART_RECT[1], "width": CHART_RECT[2], "height": CHART_RECT[3]},
        "lasso": {"points": [list(point) for point in LASSO_POINTS]},
        "shots": [],
    }

    def record(name: str, filename: str, note: str, measured: dict[str, Any], checks: list[tuple[str, bool, Any]]) -> None:
        for check_name, ok, detail in checks:
            results.check(f"{name} {check_name}", ok, detail)
        path = OUT_DIR / filename
        status = "captured" if path.is_file() else "missing"
        if status == "missing":
            results.check(f"{name} PNG 已写出", False, str(path))
        size = png_size(path) if status == "captured" else None
        manifest["shots"].append(
            {
                "file": filename,
                "frame": name,
                "note": note,
                "status": status,
                "png": {"width": size[0], "height": size[1], "bytes": size[2]} if size else None,
                "measured": measured,
            }
        )
        print(f"[SHOT] {filename} ({status}) {json.dumps(measured, ensure_ascii=False)[:400]}", flush=True)

    try:
        Handler.bundle = BUNDLE.read_bytes()
        Handler.page = PAGE_FILE.read_bytes()
        server = LocalServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        server_thread = threading.Thread(target=server.serve_forever, name="beam-shots-http", daemon=True)
        server_thread.start()
        base_url = f"http://127.0.0.1:{port}/beam.html"
        results.check("临时 HTTP server 已启动", port > 0 and server_thread.is_alive(), base_url)

        try:
            from playwright.sync_api import sync_playwright
        except Exception as exc:
            raise RuntimeError(f"无法导入 Playwright（请用 uv 运行）：{exc}") from exc

        with sync_playwright() as playwright:
            try:
                browser, channel, launch_failures = launch_browser(playwright)
                browser_closed_cleanly = False
                manifest["browser"] = {"channel": channel, "version": browser.version, "launchFallbacks": launch_failures}
                results.check("headless 浏览器已启动", bool(browser.version), manifest["browser"])

                beam_frame: dict[str, Any] | None = None

                # ---------------- 1) 双指长按 → 波光从按压点泛起约 250ms ----------------
                context, page, errors = open_page(browser, base_url, init_script=WATER_PROBE_JS)
                try:
                    trigger = page.evaluate(WAKE_HOLD_JS, TOUCH_HOLD_MS)
                    results.check("F1 双指长按 700ms 后覆盖层出现且光束动画已起帧", bool(trigger.get("armed")), trigger)
                    results.check("F1 本环境 rAF 能驱动光束动画（未退化）", bool(trigger.get("beamReady")), trigger)
                    # 组件完成截图后才启动动画。记录采样时刻，不干预渲染。
                    armed_elapsed = int(trigger.get("elapsedMs") or 0)
                    results.check(
                        "F1 光束首帧起算，环境延迟未越过采样点（约 250ms）",
                        armed_elapsed < BEAM_SAMPLE_MS - 60,
                        {"armedElapsedMs": armed_elapsed, "sampleMs": BEAM_SAMPLE_MS},
                    )
                    # Capture time precedes animation start. Sample a rendered frame on
                    # the 430ms dim curve rather than subtracting that capture latency.
                    page.wait_for_function(
                        "threshold => Number(window.__beam.q('.fb-region-dim').style.opacity) >= threshold",
                        arg=0.26 * BEAM_SAMPLE_MS / 430,
                        timeout=2000,
                    )
                    measured = page.evaluate(BEAM_MEASURE_JS)
                    page.screenshot(path=str(OUT_DIR / "1-beam-wake-250ms.png"))
                    beam_frame = {"trigger": trigger, "measured": measured}
                    record(
                        "1-beam-wake-250ms",
                        "1-beam-wake-250ms.png",
                        "冻结画面 + 水波纹从双指按压点扩散约 250ms：压暗渐入中，仍在波纹阶段（未进入圈选待命）",
                        dict(measured, armedElapsedMs=armed_elapsed),
                        [
                            ("覆盖层可见且处于光束阶段", (not measured["overlayHidden"]) and measured["arming"], measured),
                            ("早期水波出现在偏心触点附近，采样已遮挡底图", measured["gpu"] and measured.get("waterSamples", {}).get("early", {}).get("safe") and measured["waterSamples"]["early"]["first"] < 75 and measured["waterSamples"]["early"]["last"] < 130 and measured["rippleCount"] == 0 and measured["beamOpacity"] > .2, measured),
                            ("波心位于双指中点 (384,290)", measured["center"] == [384, 290], measured["center"]),
                            ("压暗随波光渐入（>0.05，未超过稳态 0.26）且圈选提示未出现", 0.05 < measured["dimOpacity"] <= 0.265 and measured["hintHidden"], {"dim": measured["dimOpacity"], "hintHidden": measured["hintHidden"]}),
                            ("当前模式为 beam 且面板未打开", measured["mode"] == "beam" and not measured["panelOpen"], {"mode": measured["mode"], "panelOpen": measured["panelOpen"]}),
                            ("无 pageerror/console error", not errors, errors),
                        ],
                    )

                    # ---------------- 2) 光束结束：压暗 + 圈选提示 ----------------
                    page.wait_for_function(
                        "() => !window.__beam.q('.fb-lasso-hint').hidden", timeout=BEAM_TOTAL_MS + 2000
                    )
                    page.wait_for_timeout(120)
                    state = page.evaluate(STATE_JS)
                    samples = page.evaluate("window.__waterSamples")
                    early, later = samples.get("early", {}), samples.get("later", {})
                    results.check("波峰离开触点后继续向外传播",
                                  bool(early and later) and later["first"] > early["first"] + 20
                                  and later["last"] > early["last"] + 45, samples)
                    page.screenshot(path=str(OUT_DIR / "2-lasso-hint.png"))
                    record(
                        "2-lasso-hint",
                        "2-lasso-hint.png",
                        "压暗 0.26 + 「画个圈，只需圈出问题位置」提示；选区框与工具栏保持不可见",
                        state,
                        [
                            ("压暗 0.26，水波余波期间可以圈选", abs(state["dimOpacity"] - 0.26) < 0.01 and state["beamOpacity"] > .9, {"dim": state["dimOpacity"], "beam": state["beamOpacity"]}),
                            ("提示可见且文案一致", (not state["hintHidden"]) and state["hintText"] == "画个圈，只需圈出问题位置", {"hidden": state["hintHidden"], "text": state["hintText"]}),
                            ("未圈选前选区框隐藏、无轨迹", state["frameOpacity"] == "0" and state["lassoPoints"] == 0, {"frameOpacity": state["frameOpacity"], "points": state["lassoPoints"]}),
                        ],
                    )

                    # ---------------- 3) 圈选中途 ----------------
                    draw_lasso(page, LASSO_POINTS, pause_every=1)
                    page.wait_for_timeout(60)
                    mid = page.evaluate(STATE_JS)
                    page.screenshot(path=str(OUT_DIR / "3-lasso-stroke.png"))
                    record(
                        "3-lasso-stroke",
                        "3-lasso-stroke.png",
                        "按住拖动中的轨迹（.fb-lasso 非空），提示仍在，尚未形成选区框",
                        mid,
                        [
                            ("轨迹非空，水波已退出", mid["lassoPoints"] > 0 and mid["beamOpacity"] < .02, mid),
                            ("提示仍在且选区框未成形", (not mid["hintHidden"]) and mid["frameOpacity"] == "0", {"hintHidden": mid["hintHidden"], "frameOpacity": mid["frameOpacity"]}),
                        ],
                    )

                    # ---------------- 4) 松手：包围盒展开为选区框 ----------------
                    lasso_bounds = page.evaluate("() => window.__beam.lassoBounds()")
                    page.mouse.up()
                    # 松手即提交包围盒：轨迹清空、提示隐藏；选区框带尺寸标注。
                    page.wait_for_function(
                        "() => window.__beam.q('.fb-lasso-hint').hidden && "
                        "!!window.__beam.q('.fb-region-frame').dataset.size", timeout=5000
                    )
                    page.wait_for_timeout(700)  # 选区展开动画 550ms
                    committed = page.evaluate(STATE_JS)
                    page.screenshot(path=str(OUT_DIR / "4-lasso-committed.png"))
                    record(
                        "4-lasso-committed",
                        "4-lasso-committed.png",
                        "松手后包围盒（外扩 8px / 最小 64px）展开为选区框，轨迹清空、提示隐藏、工具栏出现",
                        committed,
                        [
                            ("轨迹清空、提示隐藏", committed["lassoPoints"] == 0 and committed["hintHidden"], {"points": committed["lassoPoints"], "hintHidden": committed["hintHidden"]}),
                            ("选区框可见且有尺寸标注", float(committed["frameOpacity"] or 0) > 0.9 and bool(committed["frameSize"]), {"opacity": committed["frameOpacity"], "size": committed["frameSize"]}),
                            ("「使用此区域」可见", committed["useVisible"] and committed["useText"] == "使用此区域", {"visible": committed["useVisible"], "text": committed["useText"]}),
                            # 选区 = 轨迹包围盒外扩 8px：宽高都应明显大于原始轨迹（图表区约 560×300），
                            # 且选区包含全部轨迹点（松手前从 DOM 采样，先于组件清空 points）。
                            (
                                "选区由轨迹包围盒外扩而成并覆盖圈出区域",
                                bool(lasso_bounds)
                                and committed["frameRect"][2] >= lasso_bounds["width"] * 0.95
                                and committed["frameRect"][3] >= lasso_bounds["height"] * 0.95
                                and committed["frameRect"][2] >= CHART_RECT[2] * 0.6,
                                {"frame": committed["frameRect"], "lasso": lasso_bounds},
                            ),
                        ],
                    )

                    # ---------------- 5) 确认区域 → 面板 ----------------
                    page.locator(".fb-region-use").click()
                    panel = page.evaluate(PANEL_JS)
                    page.screenshot(path=str(OUT_DIR / "5-panel-after-use.png"))
                    record(
                        "5-panel-after-use",
                        "5-panel-after-use.png",
                        "点「使用此区域」→ 面板打开并带一张裁剪后的截图（blob:）",
                        panel,
                        [
                            ("面板已打开且覆盖层关闭", panel["panelOpen"] and not panel["panelHidden"], {"open": panel["panelOpen"], "hidden": panel["panelHidden"]}),
                            ("截图缩略图为 blob 图", panel["thumbSrc"] == "blob:" and panel["thumbBox"] is not None, {"src": panel["thumbSrc"], "box": panel["thumbBox"]}),
                            ("无 pageerror/console error", not errors, errors),
                        ],
                    )
                finally:
                    context.close()

                # ---------------- 6) reduced-motion：快捷键唤醒直接待命 ----------------
                context, page, reduced_errors = open_page(browser, base_url, reduced_motion="reduce")
                try:
                    fire_shortcut(page)
                    armed = wait_armed(page)
                    results.check("F6 reduced-motion 快捷键后覆盖层出现", armed, armed)
                    page.wait_for_timeout(400)
                    reduced = page.evaluate(STATE_JS)
                    page.screenshot(path=str(OUT_DIR / "6-reduced-motion-idle.png"))
                    record(
                        "6-reduced-motion-idle",
                        "6-reduced-motion-idle.png",
                        "prefers-reduced-motion: reduce：快捷键唤醒跳过光束，直接压暗 + 圈选待命",
                        reduced,
                        [
                            ("光束层 display:none（跳过动画）", reduced["beamDisplay"] == "none", reduced["beamDisplay"]),
                            ("直接进入待命：压暗 0.26 + 提示可见", abs(reduced["dimOpacity"] - 0.26) < 0.01 and not reduced["hintHidden"], {"dim": reduced["dimOpacity"], "hintHidden": reduced["hintHidden"]}),
                            ("无 pageerror/console error", not reduced_errors, reduced_errors),
                        ],
                    )
                finally:
                    context.close()

                # ---------------- 7) 可选波光：预置偏好后同一手势渲染极光 ----------------
                context, page, aurora_errors = open_page(
                    browser, base_url,
                    init_script=(
                        "try{localStorage.setItem('feedback:wake-visual:v1:com.example.demo-e2e','aurora')}catch(e){}"
                    ),
                )
                try:
                    trigger = page.evaluate(WAKE_HOLD_JS, TOUCH_HOLD_MS)
                    results.check("F7 预置波光偏好后双指长按仍进入波纹阶段", bool(trigger.get("armed")), trigger)
                    armed_elapsed = int(trigger.get("elapsedMs") or 0)
                    if armed_elapsed < BEAM_SAMPLE_MS:
                        page.wait_for_timeout(BEAM_SAMPLE_MS - armed_elapsed)
                    measured = page.evaluate(BEAM_MEASURE_JS)
                    page.screenshot(path=str(OUT_DIR / "7-aurora-option.png"))
                    record(
                        "7-aurora-option",
                        "7-aurora-option.png",
                        "切到波光后，从两个指尖分别铺开彩光，重叠处合成连续虹彩",
                        measured,
                        [
                            ("虹彩沿圆周连续变色，径向蒙版与可见亮度生效", measured["hasSpectrum"] and measured["conic"] and measured["radialMask"] and measured["bandOpacity"] > .2 and measured["beamOpacity"] > .2, measured),
                            ("两束光起于实际触点，中点保留在 (640,380)", measured["waveCenters"] == [[520,380],[760,380]] and measured["center"] == [640,380], measured),
                            ("波光模式只绘制虹彩光晕", measured["rippleCount"] == 0, measured),
                            ("无 pageerror/console error", not aurora_errors, aurora_errors),
                        ],
                    )
                finally:
                    context.close()

                if beam_frame is not None:
                    manifest["beamFrame"] = {
                        "trigger": beam_frame["trigger"],
                        "measuredAtSample": beam_frame["measured"],
                        "note": "样式测量与截图连续执行；截图保留实际播放进度。",
                    }
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

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
        f"DURATION={time.monotonic() - started:.2f}s",
        flush=True,
    )
    return 1 if results.failed else 0


if __name__ == "__main__":
    sys.exit(main())
