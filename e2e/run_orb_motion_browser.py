#!/usr/bin/env python3
"""用真实 Chromium 验证 Web 灵感球的注册属性、连续动画与降级行为。"""

from __future__ import annotations

import json
import math
import shutil
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "packages/web/dist/feedback-web.umd.cjs"
ORB_PROPERTIES = {
    "--fb-orb-breath": "0",
    "--fb-orb-state-scale": "1",
    "--fb-orb-breath-weight": "1",
    "--fb-orb-drag-angle": "0rad",
    "--fb-orb-stretch-along": "1",
    "--fb-orb-glow-x": "0px",
    "--fb-orb-glow-y": "0px",
}
HTML = b"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orb motion browser verification</title></head>
<body>
<feedback-widget launcher-mode="orb" capture-mode="off"></feedback-widget>
<script src="/feedback-web.umd.cjs"></script>
</body></html>"""
DRAG_SCRIPT = """() => {
  const orb = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb');
  const before = orb.getBoundingClientRect();
  const init = {bubbles: true, composed: true, button: 0, buttons: 1,
                pointerId: 41, pointerType: 'mouse', isPrimary: true};
  orb.dispatchEvent(new PointerEvent('pointerdown', {...init, clientX: 100, clientY: 100}));
  orb.dispatchEvent(new PointerEvent('pointermove', {...init, clientX: 180, clientY: 100}));
  return {beforeX: before.x, beforeY: before.y};
}"""
RELEASE_SCRIPT = """() => {
  const orb = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb');
  orb.dispatchEvent(new PointerEvent('pointercancel', {
    bubbles: true, composed: true, button: 0, pointerId: 41,
    pointerType: 'mouse', isPrimary: true, clientX: 180, clientY: 100
  }));
  return {
    className: orb.className,
    transform: orb.style.transform,
    angle: orb.style.getPropertyValue('--fb-orb-drag-angle'),
    stretch: orb.style.getPropertyValue('--fb-orb-stretch-along'),
    glowX: orb.style.getPropertyValue('--fb-orb-glow-x'),
    glowY: orb.style.getPropertyValue('--fb-orb-glow-y'),
    releasing: orb.classList.contains('is-releasing'),
    dragging: orb.classList.contains('is-dragging')
  };
}"""
RING_SCRIPT = """() => {
  const root = document.querySelector('feedback-widget').shadowRoot;
  const orb = root.querySelector('.fb-orb');
  const ring = root.querySelector('.fb-orb-focus-ring');
  const orbRect = orb.getBoundingClientRect();
  const ringRect = ring ? ring.getBoundingClientRect() : null;
  const ringStyle = ring ? getComputedStyle(ring) : null;
  const orbStyle = getComputedStyle(orb);
  return {
    exists: !!ring,
    orbDisplay: orbStyle.display,
    stateScale: orbStyle.getPropertyValue('--fb-orb-state-scale').trim(),
    opacity: ringStyle ? ringStyle.opacity : null,
    pointerEvents: ringStyle ? ringStyle.pointerEvents : null,
    ringSize: ringRect ? [ringRect.width, ringRect.height] : null,
    orbCenter: [orbRect.x + orbRect.width / 2, orbRect.y + orbRect.height / 2],
    ringCenter: ringRect ? [ringRect.x + ringRect.width / 2, ringRect.y + ringRect.height / 2] : null,
    orbFocusVisible: orb.matches(':focus-visible')
  };
}"""
HIDE_SCRIPT = """() => {
  const root = document.querySelector('feedback-widget').shadowRoot;
  const orb = root.querySelector('.fb-orb');
  const ring = root.querySelector('.fb-orb-focus-ring');
  orb.classList.add('is-hidden');
  const ringRect = ring.getBoundingClientRect();
  const state = {
    orbDisplay: getComputedStyle(orb).display,
    ringSize: [ringRect.width, ringRect.height],
    ringVisible: typeof ring.checkVisibility === 'function'
      ? ring.checkVisibility()
      : ringRect.width > 0
  };
  orb.classList.remove('is-hidden');
  return state;
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

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _headers(self, status: int, content_type: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._headers(200, "text/html; charset=utf-8", len(HTML))
            self.wfile.write(HTML)
            return
        if path == "/feedback-web.umd.cjs":
            self._headers(200, "text/javascript; charset=utf-8", len(self.bundle))
            self.wfile.write(self.bundle)
            return
        if path == "/favicon.ico":
            self._headers(204, "image/x-icon", 0)
            return
        body = b'{"error":"unauthorized"}'
        self._headers(401, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        body = b'{"error":"unauthorized"}'
        self._headers(401, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)


FallbackInitScript = """(() => {
  let mode = 'already-unavailable';
  if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
    try {
      Object.defineProperty(CSS, 'registerProperty', {
        value: undefined, configurable: true, writable: true
      });
      mode = 'define-on-css';
    } catch (firstError) {
      try {
        CSS.registerProperty = undefined;
        mode = 'assign-on-css';
      } catch (secondError) {
        mode = 'direct-replacement-failed';
      }
    }
  }
  if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
    try {
      const replacement = new Proxy(CSS, {
        get(target, property, receiver) {
          if (property === 'registerProperty') return undefined;
          return Reflect.get(target, property, receiver);
        }
      });
      Object.defineProperty(window, 'CSS', {
        value: replacement, configurable: true, writable: true
      });
      mode = 'replace-window-css';
    } catch (error) {
      mode = 'window-replacement-failed';
    }
  }
  window.__fbRegisterPropertyDisableMode = mode;
  window.__fbRegisterPropertyDisabled =
    typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function';
})();"""


def close_to(value: float, expected: float, tolerance: float) -> bool:
    return math.isfinite(value) and abs(value - expected) <= tolerance


def semantic_initial(name: str, value: str) -> bool:
    expected = ORB_PROPERTIES[name]
    if name == "--fb-orb-drag-angle":
        return value in ("0rad", "0deg")
    try:
        return close_to(float(value.removesuffix("px")), float(expected.removesuffix("px")), 1e-9)
    except ValueError:
        return False


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
        except Exception as exc:  # Playwright 的启动错误类型因安装方式而异
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
    raise RuntimeError("；".join(failures))


def new_page(browser: Any, base_url: str, reduced: bool = False, fallback: bool = False) -> tuple[Any, Any, list[str]]:
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    if fallback:
        context.add_init_script(FallbackInitScript)
    page = context.new_page()
    if reduced:
        page.emulate_media(reduced_motion="reduce")
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on("console", lambda message: errors.append(f"console.error: {message.text}") if message.type == "error" else None)
    page.goto(base_url, wait_until="load")
    page.wait_for_function(
        "customElements.get('feedback-widget') && "
        "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-orb')"
    )
    return context, page, errors


def orb_state(page: Any, before: dict[str, float] | None = None) -> dict[str, Any]:
    return page.evaluate(
        """(before) => {
          const root = document.querySelector('feedback-widget').shadowRoot;
          const orb = root.querySelector('.fb-orb');
          const core = root.querySelector('.fb-orb-core');
          const glow = root.querySelector('.fb-orb-glow');
          const orbRect = orb.getBoundingClientRect();
          const coreRect = core.getBoundingClientRect();
          const glowRect = glow.getBoundingClientRect();
          const matrix = new DOMMatrixReadOnly(getComputedStyle(orb).transform);
          const glowTranslate = getComputedStyle(glow).translate;
          const translateNumbers = glowTranslate === 'none'
            ? [0, 0]
            : (glowTranslate.match(/-?[\\d.]+/g) || []).map(Number);
          return {
            className: orb.className,
            rootInlineTransform: orb.style.transform,
            rootComputedTranslate: [matrix.m41, matrix.m42],
            rootActualDelta: before ? [orbRect.x - before.beforeX, orbRect.y - before.beforeY] : null,
            coreGeometry: [coreRect.width, coreRect.height],
            stretchInline: orb.style.getPropertyValue('--fb-orb-stretch-along').trim(),
            glowInline: [
              orb.style.getPropertyValue('--fb-orb-glow-x').trim(),
              orb.style.getPropertyValue('--fb-orb-glow-y').trim()
            ],
            glowComputedTranslate: glowTranslate,
            glowComputedNumbers: [translateNumbers[0] || 0, translateNumbers[1] || 0],
            glowActualCenterOffset: [
              glowRect.x + glowRect.width / 2 - (orbRect.x + orbRect.width / 2),
              glowRect.y + glowRect.height / 2 - (orbRect.y + orbRect.height / 2)
            ]
          };
        }""",
        before,
    )


def check_page_errors(results: Results, label: str, page: Any, errors: list[str]) -> None:
    page.wait_for_timeout(20)
    results.check(f"{label}无 pageerror/console error", not errors, errors)


def normal_scenario(results: Results, browser: Any, base_url: str, evidence: dict[str, Any]) -> None:
    context = None
    try:
        context, page, errors = new_page(browser, base_url)
        ready = page.evaluate(
            """() => ({
              defined: !!customElements.get('feedback-widget'),
              shadow: !!document.querySelector('feedback-widget')?.shadowRoot,
              orb: !!document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-orb')
            })"""
        )
        results.check("正常页 custom element 与 shadow orb 已就绪", all(ready.values()), ready)

        values = page.evaluate(
            """(names) => Object.fromEntries(names.map((name) =>
              [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()]))""",
            list(ORB_PROPERTIES),
        )
        evidence["registeredInitials"] = values
        for name, value in values.items():
            results.check(f"registered property 语义初值 {name}", semantic_initial(name, value), value)

        fallback_class = page.evaluate(
            "document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb').classList.contains('fb-orb-properties-unavailable')"
        )
        results.check("正常页 orb 不带 fallback class", not fallback_class, fallback_class)

        page.evaluate(
            """async () => {
              const orb = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb');
              orb.style.animation = 'none';
              void orb.offsetWidth;
              orb.style.removeProperty('animation');
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
            }"""
        )
        samples = page.evaluate(
            """async () => {
              const root = document.querySelector('feedback-widget').shadowRoot;
              const orb = root.querySelector('.fb-orb');
              const core = root.querySelector('.fb-orb-core');
              const output = [];
              const started = performance.now();
              for (let index = 0; index < 7; index++) {
                if (index) await new Promise(resolve => setTimeout(resolve, 145));
                const breathText = getComputedStyle(orb).getPropertyValue('--fb-orb-breath').trim();
                const scaleText = getComputedStyle(core).scale.trim();
                output.push({
                  elapsedMs: performance.now() - started,
                  breathText,
                  breath: Number.parseFloat(breathText),
                  scaleText,
                  scale: scaleText === 'none' ? 1 : Number.parseFloat(scaleText)
                });
              }
              return output;
            }"""
        )
        evidence["breathSamples"] = samples
        breaths = [sample["breath"] for sample in samples]
        scales = [sample["scale"] for sample in samples]
        intermediate = [value for value in breaths if math.isfinite(value) and 0 < value < 1]
        breath_deltas = [b - a for a, b in zip(breaths, breaths[1:])]
        scale_deltas = [b - a for a, b in zip(scales, scales[1:])]
        results.check("真实呼吸采样至少 6 帧且约 1 秒", len(samples) >= 6 and samples[-1]["elapsedMs"] <= 1150, samples)
        results.check("breath 全部位于 [0,1]", all(math.isfinite(v) and 0 <= v <= 1 for v in breaths), breaths)
        results.check("breath 至少 4 个严格中间值", len(intermediate) >= 4, breaths)
        results.check(
            "breath 相邻帧连续同向变化",
            sum(abs(delta) > 1e-7 for delta in breath_deltas) >= 4
            and (all(delta >= -1e-7 for delta in breath_deltas) or all(delta <= 1e-7 for delta in breath_deltas)),
            breath_deltas,
        )
        results.check("core computed scale 全部位于 [1,1.02]", all(1 <= value <= 1.02 for value in scales), scales)
        results.check(
            "core scale 相邻帧连续同向变化且对应 breath",
            sum(abs(delta) > 1e-7 for delta in scale_deltas) >= 4
            and all(abs(scale - (1 + breath * 0.02)) <= 0.0002 for breath, scale in zip(breaths, scales)),
            {"scales": scales, "deltas": scale_deltas},
        )

        before = page.evaluate(DRAG_SCRIPT)
        page.wait_for_timeout(220)
        page.evaluate("() => new Promise(requestAnimationFrame)")
        state = orb_state(page, before)
        evidence["normalGeometry"] = state
        width, height = state["coreGeometry"]
        results.check("正常拖动 core 几何约 87.36×84", close_to(width, 87.36, 0.1) and close_to(height, 84, 0.1), state["coreGeometry"])
        results.check("正常拖动 inline stretch=1.04", close_to(float(state["stretchInline"]), 1.04, 1e-9), state["stretchInline"])
        glow = [float(value.removesuffix("px")) for value in state["glowInline"]]
        results.check("正常拖动 inline glow=(-4,0)", close_to(glow[0], -4, 1e-9) and close_to(glow[1], 0, 1e-9), state["glowInline"])
        root_ok = close_to(state["rootComputedTranslate"][0], 80, 0.01) and close_to(state["rootActualDelta"][0], 80, 0.01)
        results.check("正常拖动 root 真实平移 80px", root_ok, {"computed": state["rootComputedTranslate"], "actual": state["rootActualDelta"], "inline": state["rootInlineTransform"]})
        page.evaluate(RELEASE_SCRIPT)
        check_page_errors(results, "正常页", page, errors)
    finally:
        if context is not None:
            context.close()


def ring_centered(state: dict[str, Any], tolerance: float = 0.5) -> bool:
    if not state["ringCenter"] or not state["orbCenter"]:
        return False
    return all(close_to(a, b, tolerance) for a, b in zip(state["ringCenter"], state["orbCenter"]))


def focus_ring_scenario(results: Results, browser: Any, base_url: str, evidence: dict[str, Any]) -> None:
    context = None
    try:
        context, page, errors = new_page(browser, base_url)
        idle = page.evaluate(RING_SCRIPT)
        evidence["focusRingIdle"] = idle
        results.check("焦点环节点存在且默认不可见", bool(idle["exists"]) and idle["opacity"] == "0", idle)
        results.check("焦点环 pointer-events: none", idle["pointerEvents"] == "none", idle["pointerEvents"])
        results.check(
            "idle 焦点环外径 64 且与球同心",
            close_to(idle["ringSize"][0], 64, 0.1)
            and close_to(idle["ringSize"][1], 64, 0.1)
            and ring_centered(idle),
            {"size": idle["ringSize"], "ringCenter": idle["ringCenter"], "orbCenter": idle["orbCenter"]},
        )

        page.keyboard.press("Tab")
        page.wait_for_timeout(50)
        focused = page.evaluate(RING_SCRIPT)
        evidence["focusRingFocusVisible"] = focused
        results.check("Tab 键盘聚焦落在灵感球并进入 :focus-visible", focused["orbFocusVisible"], focused["orbFocusVisible"])
        results.check(":focus-visible 时焦点环可见", focused["opacity"] == "1", focused["opacity"])
        results.check(
            "键盘聚焦焦点环外径仍 64 且与球同心",
            close_to(focused["ringSize"][0], 64, 0.1) and ring_centered(focused),
            {"size": focused["ringSize"], "ringCenter": focused["ringCenter"], "orbCenter": focused["orbCenter"]},
        )

        page.evaluate(DRAG_SCRIPT)
        page.wait_for_timeout(220)
        page.evaluate("() => new Promise(requestAnimationFrame)")
        dragged = page.evaluate(RING_SCRIPT)
        evidence["focusRingDragging"] = dragged
        results.check("拖动状态因子到 1.5", close_to(float(dragged["stateScale"]), 1.5, 1e-6), dragged["stateScale"])
        results.check(
            "dragging 焦点环外径 92 且与球同心",
            close_to(dragged["ringSize"][0], 92, 0.15)
            and close_to(dragged["ringSize"][1], 92, 0.15)
            and ring_centered(dragged),
            {"size": dragged["ringSize"], "ringCenter": dragged["ringCenter"], "orbCenter": dragged["orbCenter"]},
        )

        page.evaluate(RELEASE_SCRIPT)
        hidden = page.evaluate(HIDE_SCRIPT)
        evidence["focusRingHidden"] = hidden
        results.check(
            "hidden（display:none）时焦点环不渲染",
            hidden["orbDisplay"] == "none"
            and close_to(hidden["ringSize"][0], 0, 0.01)
            and close_to(hidden["ringSize"][1], 0, 0.01)
            and not hidden["ringVisible"],
            hidden,
        )
        check_page_errors(results, "焦点环页", page, errors)
    finally:
        if context is not None:
            context.close()


def reduced_scenario(results: Results, browser: Any, base_url: str, evidence: dict[str, Any]) -> None:
    context = None
    try:
        context, page, errors = new_page(browser, base_url, reduced=True)
        reduced = page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
        results.check("reduced-motion 媒体模拟生效", reduced, reduced)
        before = page.evaluate(DRAG_SCRIPT)
        page.evaluate("() => new Promise(requestAnimationFrame)")
        state = orb_state(page, before)
        evidence["reducedMotion"] = state
        width, height = state["coreGeometry"]
        results.check("reduced-motion 拖动 core 保持 56×56", close_to(width, 56, 0.1) and close_to(height, 56, 0.1), state["coreGeometry"])
        reduced_ring = page.evaluate(RING_SCRIPT)
        evidence["reducedMotionRing"] = reduced_ring
        results.check(
            "reduced-motion 拖动焦点环保持 64 且与球同心",
            close_to(reduced_ring["ringSize"][0], 64, 0.1)
            and close_to(reduced_ring["ringSize"][1], 64, 0.1)
            and ring_centered(reduced_ring),
            {"size": reduced_ring["ringSize"], "stateScale": reduced_ring["stateScale"],
             "ringCenter": reduced_ring["ringCenter"], "orbCenter": reduced_ring["orbCenter"]},
        )
        computed = state["glowComputedNumbers"]
        actual = state["glowActualCenterOffset"]
        results.check(
            "reduced-motion glow computed/实际 translate 为 0",
            all(close_to(value, 0, 0.01) for value in (*computed, *actual)),
            {"computedText": state["glowComputedTranslate"], "computed": computed, "actualCenterOffset": actual},
        )
        results.check(
            "reduced-motion root 仍真实平移 80px",
            close_to(state["rootComputedTranslate"][0], 80, 0.01) and close_to(state["rootActualDelta"][0], 80, 0.01),
            {"computed": state["rootComputedTranslate"], "actual": state["rootActualDelta"], "inline": state["rootInlineTransform"]},
        )
        released = page.evaluate(RELEASE_SCRIPT)
        defaulted = not released["releasing"] and not released["dragging"] and all(
            released[key] == "" for key in ("transform", "angle", "stretch", "glowX", "glowY")
        )
        results.check("reduced-motion 释放即时复位且无 is-releasing", defaulted, released)
        check_page_errors(results, "reduced-motion 页", page, errors)
    finally:
        if context is not None:
            context.close()


def fallback_scenario(results: Results, browser: Any, base_url: str, evidence: dict[str, Any]) -> None:
    context = None
    try:
        context, page, errors = new_page(browser, base_url, fallback=True)
        disabled = page.evaluate("({disabled: window.__fbRegisterPropertyDisabled, mode: window.__fbRegisterPropertyDisableMode, type: typeof CSS.registerProperty})")
        results.check("fallback 页脚本加载前可靠禁用 CSS.registerProperty", disabled["disabled"] and disabled["type"] != "function", disabled)
        state = page.evaluate(
            """() => {
              const orb = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb');
              const style = getComputedStyle(orb);
              return {className: orb.className, fallback: orb.classList.contains('fb-orb-properties-unavailable'),
                      animationName: style.animationName, transition: style.transition,
                      transitionProperty: style.transitionProperty};
            }"""
        )
        results.check("fallback orb 带 fb-orb-properties-unavailable", state["fallback"], state)
        fallback_samples = page.evaluate(
            """async () => {
              const orb = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb');
              const values = [];
              for (let index = 0; index < 5; index++) {
                values.push(getComputedStyle(orb).getPropertyValue('--fb-orb-breath').trim());
                if (index < 4) await new Promise(resolve => setTimeout(resolve, 65));
              }
              return values;
            }"""
        )
        evidence["fallback"] = {"style": state, "breathSamples": fallback_samples, "disable": disabled}
        parsed_samples = [float(value) for value in fallback_samples]
        results.check("fallback breath 至少 5 次全为 0", len(parsed_samples) >= 5 and all(value == 0 for value in parsed_samples), fallback_samples)
        results.check("fallback animation-name 为 none", state["animationName"] == "none", state["animationName"])
        registered_in_transition = [name for name in ORB_PROPERTIES if name in state["transition"] or name in state["transitionProperty"]]
        results.check("fallback transition 不含 registered custom properties", not registered_in_transition, {"transition": state["transition"], "transitionProperty": state["transitionProperty"], "found": registered_in_transition})

        before = page.evaluate(DRAG_SCRIPT)
        drag_state = orb_state(page, before)
        results.check(
            "fallback 拖动 root 仍真实平移 80px",
            close_to(drag_state["rootComputedTranslate"][0], 80, 0.01) and close_to(drag_state["rootActualDelta"][0], 80, 0.01),
            {"computed": drag_state["rootComputedTranslate"], "actual": drag_state["rootActualDelta"], "inline": drag_state["rootInlineTransform"]},
        )
        fallback_ring = page.evaluate(RING_SCRIPT)
        evidence["fallback"]["focusRing"] = fallback_ring
        results.check(
            "fallback 无 registered property 时焦点环外径仍为 92 且同心",
            close_to(fallback_ring["ringSize"][0], 92, 0.2)
            and close_to(fallback_ring["ringSize"][1], 92, 0.2)
            and ring_centered(fallback_ring),
            {"size": fallback_ring["ringSize"], "ringCenter": fallback_ring["ringCenter"], "orbCenter": fallback_ring["orbCenter"]},
        )
        released = page.evaluate(RELEASE_SCRIPT)
        defaulted = not released["releasing"] and not released["dragging"] and all(
            released[key] == "" for key in ("transform", "angle", "stretch", "glowX", "glowY")
        )
        results.check("fallback 释放即时默认且无 is-releasing", defaulted, released)
        check_page_errors(results, "fallback 页", page, errors)
    finally:
        if context is not None:
            context.close()


def port_is_closed(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def main() -> int:
    started = time.monotonic()
    results = Results()
    evidence: dict[str, Any] = {}
    if not BUNDLE.is_file():
        results.check("组件构建产物存在", False, f"缺少 {BUNDLE}；请先按 packages/web/package.json 执行 pnpm --filter @feedback/web build")
        print(f"[SUMMARY] PASS={results.passed} FAIL={results.failed} TOTAL={results.passed + results.failed}", flush=True)
        return 1

    temp_dir = Path(tempfile.mkdtemp(prefix="feedback-orb-browser-"))
    server: LocalServer | None = None
    server_thread: threading.Thread | None = None
    browser = None
    browser_closed_cleanly = True
    port = 0
    try:
        Handler.bundle = BUNDLE.read_bytes()
        server = LocalServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        server_thread = threading.Thread(target=server.serve_forever, name="orb-http", daemon=True)
        server_thread.start()
        base_url = f"http://127.0.0.1:{port}/"
        results.check("临时 HTTP server 使用随机端口且已启动", port > 0 and server_thread.is_alive(), {"url": base_url, "port": port})

        try:
            from playwright.sync_api import sync_playwright
        except Exception as exc:
            raise RuntimeError(f"无法导入仓库既有 Python Playwright：{exc}") from exc

        with sync_playwright() as playwright:
            try:
                browser, channel, launch_failures = launch_browser(playwright)
                browser_closed_cleanly = False
                version = browser.version
                evidence["browser"] = {"channel": channel, "version": version, "fallbackFailures": launch_failures}
                results.check("headless 浏览器已启动", bool(version), evidence["browser"])
                for label, scenario in (
                    ("正常页", normal_scenario),
                    ("焦点环页", focus_ring_scenario),
                    ("reduced-motion 页", reduced_scenario),
                    ("fallback 页", fallback_scenario),
                ):
                    try:
                        scenario(results, browser, base_url, evidence)
                    except Exception as exc:
                        results.check(f"{label}场景无 harness 异常", False, f"{type(exc).__name__}: {exc}")
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
        results.check("浏览器验证 harness 完成", False, f"{type(exc).__name__}: {exc}")
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

    browser_closed = browser_closed_cleanly
    server_stopped = server_thread is None or not server_thread.is_alive()
    port_closed = port == 0 or port_is_closed(port)
    temp_removed = not temp_dir.exists()
    cleanup = {
        "browserClosed": browser_closed,
        "serverThreadStopped": server_stopped,
        "tempDirRemoved": temp_removed,
        "port": port,
        "portClosed": port_closed,
    }
    evidence["cleanup"] = cleanup
    results.check("finally 完成 browser/server/temp 清理", all((browser_closed, server_stopped, temp_removed)), cleanup)
    results.check("临时 HTTP 端口已关闭", port_closed, {"port": port, "closed": port_closed})

    print(f"[EVIDENCE] {json.dumps(evidence, ensure_ascii=False, separators=(',', ':'))}", flush=True)
    total = results.passed + results.failed
    print(
        f"[SUMMARY] PASS={results.passed} FAIL={results.failed} TOTAL={total} "
        f"DURATION={time.monotonic() - started:.2f}s",
        flush=True,
    )
    return 1 if results.failed else 0


if __name__ == "__main__":
    sys.exit(main())
