#!/usr/bin/env python3
"""FB-ENTRY-001 真实 Chrome 端到端：Web 桌面默认入口 + Alt 拖拽 + 首用提示 + 快捷键让路 + 触屏回归。

约定与 e2e/run_beam_shots_web.py 保持一致：
- uv + Playwright，真实系统 Chrome（channel=chrome；启动失败依次回退 chromium）；
- 桌面场景 has_touch=False、视口 1280x800、dpr=1（CSS 像素 == 截图输出像素）；
- 每个场景独立 context + 新页面，避免草稿 / 截图 / 首用提示互相污染；
- 宿主页 e2e/pages/entry-desktop.html、e2e/pages/entry-desktop-capture.html 只加载
  packages/web/dist 的 UMD 产物，不改 packages/web/src；
- 截图写入 e2e/shots/fb-entry-desktop/，另写 manifest.json（逐项 PASS/FAIL 与实测值）。

场景（任务 FB-ENTRY-001 验收 1/2/3/4/6/8 + 触屏回归）：
 1 不写 launcher-mode 的桌面宿主：data-fb-mode=tab，.fb-tab-launcher 可见（非 display:none）
 2 点入口：面板打开，并插入整屏视口截图
 3 Alt+拖拽 (400,300)->(760,560)：冻结覆盖层 + 选区 == 拖拽矩形（+-2px）+ 工具条可见；
   点「使用此区域」后面板打开，插入截图尺寸 == 裁剪尺寸；从按钮/链接起手不接管（排除点）
 4 Alt+点击（不拖）：进入圈选待命（.fb-lasso-hint 可见）
 5 首用提示：首次加载出现 .fb-entry-hint（含快捷键文案），刷新后不再出现
 6 快捷键让路：宿主在 document capture 阶段对 Ctrl+Shift+F preventDefault 时组件不抢；
   同一页面去掉拦截后由组件接管
 7 触屏回归：has_touch=True + 触屏视口仍解析为 beam，合成双指长按 700ms 进入圈选

不启动长期服务：本地 HTTP server 只在进程内存在，finally 关闭（并断言端口已释放）。
"""

from __future__ import annotations

import json
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
PAGE_FILES = {
    "/entry-desktop.html": ROOT / "e2e/pages/entry-desktop.html",
    "/entry-desktop-capture.html": ROOT / "e2e/pages/entry-desktop-capture.html",
}
OUT_DIR = ROOT / "e2e/shots/fb-entry-desktop"
MANIFEST = OUT_DIR / "manifest.json"

VIEWPORT = (1280, 800)
DEVICE_SCALE = 1
DRAG_START = (400, 300)
DRAG_END = (760, 560)
TOUCH_VIEWPORT = (390, 844)
TOUCH_HOLD_MS = 700
SHORTCUT = "Control+Shift+F"
APP_ID = "com.example.entry-e2e"
HINT_KEY = "feedback:entry-hint:v1:" + APP_ID
TOLERANCE = 2  # px：dataset.size / 选区框与拖拽矩形的允许误差

READY_JS = (
    "customElements.get('feedback-widget') && "
    "document.querySelector('feedback-widget')?.shadowRoot?.querySelector('.fb-region-overlay')"
)

STATE_JS = r"""() => {
  const widget = document.querySelector('feedback-widget');
  const root = widget ? widget.shadowRoot : null;
  const q = sel => (root ? root.querySelector(sel) : null);
  const round = v => Math.round(v * 100) / 100;
  const box = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  };
  const vis = el => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      visibility: cs.visibility,
      opacity: Number.parseFloat(cs.opacity),
      hidden: el.hidden,
      checkVisibility: typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        : null,
      box: box(el),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  };
  const panel = q('.fb-panel');
  const overlay = q('.fb-region-overlay');
  const frame = q('.fb-region-frame');
  const lasso = q('.fb-lasso-hint');
  const hint = q('.fb-entry-hint');
  const hintClose = q('.fb-entry-hint-close');
  const thumb = q('.fb-screenshot-thumb');
  const sizeEl = q('.fb-screenshot-size');
  const bg = q('.fb-region-bg');
  let hintSeen = 'unavailable';
  try {
    hintSeen = localStorage.getItem(
      'feedback:entry-hint:v1:' + encodeURIComponent(widget ? widget.getAttribute('app-id') || '' : '')
    );
  } catch (e) { hintSeen = 'blocked'; }
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    input: {
      fine: matchMedia('(pointer: fine)').matches,
      coarse: matchMedia('(pointer: coarse)').matches,
      touchPoints: navigator.maxTouchPoints,
      hasTouchStart: 'ontouchstart' in window,
      platform: navigator.platform,
    },
    mode: widget ? widget.dataset.fbMode || '' : null,
    launcherModeAttr: widget ? widget.getAttribute('launcher-mode') : null,
    launcherModeResolved: widget ? widget.launcherMode : null,
    captureMode: widget ? widget.captureMode : null,
    launcher: vis(q('.fb-tab-launcher')),
    orb: vis(q('.fb-orb')),
    panelOpen: !!q('.fb-panel.is-open'),
    panel: vis(panel),
    panelHidden: panel ? panel.hidden : null,
    overlayHidden: overlay ? overlay.hidden : null,
    regionBgSrc: bg ? bg.getAttribute('src') || '' : null,
    frameSize: frame ? frame.dataset.size || '' : null,
    frame: vis(frame),
    tools: vis(q('.fb-region-tools')),
    useBtn: vis(q('.fb-region-use')),
    lassoHint: lasso
      ? { hidden: lasso.hidden, box: box(lasso), text: (lasso.textContent || '').trim() }
      : null,
    entryHint: hint
      ? Object.assign(vis(hint), {
          closeVisible: !!hintClose && hintClose.getBoundingClientRect().width > 0,
        })
      : null,
    entryHintStorage: hintSeen,
    thumb: thumb
      ? {
          src: (thumb.getAttribute('src') || '').slice(0, 5),
          naturalWidth: thumb.naturalWidth,
          naturalHeight: thumb.naturalHeight,
          box: box(thumb),
          visible: thumb.getBoundingClientRect().width > 0,
        }
      : null,
    sizeLabel: sizeEl ? (sizeEl.textContent || '').trim() : null,
    hostClicks: window.__host ? window.__host.clicks.slice() : null,
    hostShortcut:
      window.__host && 'shortcutSeen' in window.__host
        ? { seen: window.__host.shortcutSeen, prevented: window.__host.shortcutPrevented }
        : null,
    visibilityState: document.visibilityState,
  };
}"""

RECT_POINTS_JS = r"""({x, y, width, height}) => {
  const xs = [x + 4, x + width / 2, x + width - 4];
  const ys = [y + 4, y + height / 2, y + height - 4];
  const points = [];
  for (const cx of xs) for (const cy of ys) points.push([Math.round(cx), Math.round(cy)]);
  const selector = 'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])';
  return points.map(([cx, cy]) => {
    const els = document.elementsFromPoint(cx, cy);
    return {
      x: cx,
      y: cy,
      interactive: els.some(el => el.closest && el.closest(selector)),
      stack: els.slice(0, 3).map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')),
    };
  });
}"""

POINT_JS = r"""({x, y}) => {
  const selector = 'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])';
  const els = document.elementsFromPoint(x, y);
  return {
    x, y,
    interactive: els.some(el => el.closest && el.closest(selector)),
    stack: els.slice(0, 3).map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')),
  };
}"""

TOUCH_HOLD_JS = r"""async (holdMs) => {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const dispatch = (type, touches, changed) => document.dispatchEvent(new TouchEvent(type, {
    bubbles: true, cancelable: true, composed: true, touches, changedTouches: changed,
  }));
  const cx = Math.round(innerWidth / 2);
  const cy = Math.round(innerHeight / 2);
  const fingers = () => [
    new Touch({ identifier: 1, target: document.body, clientX: cx - 40, clientY: cy }),
    new Touch({ identifier: 2, target: document.body, clientX: cx + 40, clientY: cy }),
  ];
  const startedAt = performance.now();
  dispatch('touchstart', fingers(), fingers());
  await new Promise(resolve => setTimeout(resolve, holdMs));
  dispatch('touchend', [], fingers());
  while (performance.now() - startedAt < 20000) {
    const overlay = window.__entry.overlay();
    if (overlay && !overlay.hidden) {
      return { armed: true, elapsedMs: Math.round(performance.now() - startedAt), origin: [cx, cy] };
    }
    await frame();
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  return { armed: false, elapsedMs: Math.round(performance.now() - startedAt), origin: [cx, cy] };
}"""


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.rows: list[dict[str, Any]] = []

    def check(self, name: str, ok: bool, detail: Any = None) -> bool:
        ok = bool(ok)
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        self.rows.append({"name": name, "passed": ok, "detail": detail})
        line = f"[{'PASS' if ok else 'FAIL'}] {name}"
        if detail is not None:
            line += " | measured=" + json.dumps(detail, ensure_ascii=False)
        print(line, flush=True)
        return ok


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    pages: dict[str, bytes] = {}
    bundle: bytes = b""

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in self.pages:
            self._send(200, "text/html; charset=utf-8", self.pages[path])
            return
        # 宿主页里 src="/sdk/feedback-web.umd.js"，这里映射到 dist 产物。
        if path in ("/sdk/feedback-web.umd.js", "/feedback-web.umd.cjs"):
            self._send(200, "text/javascript; charset=utf-8", self.bundle)
            return
        if path == "/favicon.ico":
            self._send(204, "image/x-icon", b"")
            return
        self._send(404, "application/json; charset=utf-8", b'{"error":"not found"}')


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


def size_pair(text: str) -> tuple[int, int] | None:
    """解析 dataset.size / .fb-screenshot-size 的「宽×高」。"""
    if not text or "×" not in text:
        return None
    left, _, right = text.partition("×")
    try:
        return int(left.strip()), int(right.strip())
    except ValueError:
        return None


class Harness:
    def __init__(self, browser: Any, base_url: str, results: Results) -> None:
        self.browser = browser
        self.base_url = base_url
        self.results = results
        self.shots: list[dict[str, Any]] = []

    def open(
        self,
        page_name: str,
        *,
        query: str = "",
        touch: bool = False,
        viewport: tuple[int, int] = VIEWPORT,
        seen_hint: bool = True,
    ) -> tuple[Any, Any, list[str]]:
        context = self.browser.new_context(
            viewport={"width": viewport[0], "height": viewport[1]},
            device_scale_factor=DEVICE_SCALE,
            has_touch=touch,
            color_scheme="light",
        )
        if seen_hint:
            # 首用提示单独由场景 5 验证；其它场景预置「已读」，避免提示块影响命中与截图。
            context.add_init_script("try{localStorage.setItem(%r,'seen')}catch(e){}" % HINT_KEY)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error"
            else None,
        )
        page.goto(self.base_url + page_name + query, wait_until="load")
        page.wait_for_function(READY_JS, timeout=20000)
        return context, page, errors

    def shot(self, page: Any, filename: str, measured: dict[str, Any], note: str = "") -> None:
        path = OUT_DIR / filename
        page.screenshot(path=str(path))
        exists = path.is_file()
        size = png_size(path) if exists else None
        self.results.check(
            f"截图 {filename}", exists and bool(size and size[0] > 0), {"path": str(path), "png": size}
        )
        self.shots.append(
            {
                "file": filename,
                "note": note,
                "png": {"width": size[0], "height": size[1], "bytes": size[2]} if size else None,
                "measured": measured,
            }
        )
        print(f"[SHOT] {filename} ({'ok' if exists else 'missing'})", flush=True)

    def state(self, page: Any) -> dict[str, Any]:
        return page.evaluate(STATE_JS)

    def wait_armed(self, page: Any, timeout: int = 20000) -> bool:
        try:
            page.wait_for_function("() => !window.__entry.overlay().hidden", timeout=timeout)
            return True
        except Exception:
            return False


def alt_drag(page: Any, start: tuple[float, float], end: tuple[float, float], steps: int = 12) -> None:
    page.keyboard.down("Alt")
    try:
        page.mouse.move(start[0], start[1])
        page.mouse.down()
        page.mouse.move(end[0], end[1], steps=steps)
        page.mouse.up()
    finally:
        page.keyboard.up("Alt")


def alt_click(page: Any, point: tuple[float, float]) -> None:
    page.keyboard.down("Alt")
    try:
        page.mouse.move(point[0], point[1])
        page.mouse.down()
        page.mouse.up()
    finally:
        page.keyboard.up("Alt")


def wait_thumb(page: Any, timeout: int = 20000) -> None:
    page.wait_for_function(
        "() => { const img = window.__entry.q('.fb-screenshot-thumb');"
        " return !!img && img.naturalWidth > 0 && (img.getAttribute('src') || '').startsWith('blob:'); }",
        timeout=timeout,
    )


def wait_lasso_hint(page: Any, timeout: int = 20000) -> None:
    page.wait_for_function(
        "() => { const hint = window.__entry.q('.fb-lasso-hint'); return !!hint && !hint.hidden; }",
        timeout=timeout,
    )


def inside(box: dict[str, float] | None, viewport: dict[str, int], slack: float = 0.5) -> bool:
    if not box:
        return False
    return (
        box["width"] > 0
        and box["height"] > 0
        and box["x"] >= -slack
        and box["y"] >= -slack
        and box["x"] + box["width"] <= viewport["width"] + slack
        and box["y"] + box["height"] <= viewport["height"] + slack
    )


def near(actual: int | float | None, expected: float, tolerance: float = TOLERANCE) -> bool:
    return actual is not None and abs(float(actual) - float(expected)) <= tolerance

SETTINGS_JS = r"""() => {
  const widget = document.querySelector('feedback-widget');
  const root = widget ? widget.shadowRoot : null;
  if (!root) return null;
  const rowInfo = input => {
    const row = input.closest('.fb-wake-option');
    const cs = row ? getComputedStyle(row) : null;
    const titleEl = row ? row.querySelector('.fb-wake-option-title') : null;
    return {
      checked: input.checked,
      rowHidden: row ? row.hidden : null,
      display: cs ? cs.display : null,
      title: titleEl ? (titleEl.textContent || '').trim() : null,
    };
  };
  const styles = {};
  for (const input of root.querySelectorAll('[data-launcher-style]')) {
    styles[input.dataset.launcherStyle] = rowInfo(input);
  }
  const gestures = {};
  for (const input of root.querySelectorAll('[data-wake-gesture]')) {
    gestures[input.dataset.wakeGesture] = rowInfo(input);
  }
  const desktop = root.querySelector('.fb-wake-desktop');
  const facts = desktop
    ? Array.from(desktop.querySelectorAll('.fb-wake-fact')).map(row => ({
        title: ((row.querySelector('.fb-wake-option-title') || {}).textContent || '').trim(),
        detail: ((row.querySelector('.fb-footnote') || {}).textContent || '').trim(),
      }))
    : [];
  const settingsView = root.querySelector('.fb-settings');
  const note = root.querySelector('.fb-wake-settings > .fb-footnote');
  return {
    settingsViewHidden: settingsView ? settingsView.hidden : null,
    styles,
    gestures,
    desktop: desktop
      ? { hidden: desktop.hidden, display: getComputedStyle(desktop).display, facts }
      : null,
    gestureNote: note
      ? { hidden: note.hidden, display: getComputedStyle(note).display, text: (note.textContent || '').trim() }
      : null,
  };
}"""


def scenario_default_entry(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 1/2：桌面默认入口（不写 launcher-mode）→ 点入口开面板 ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        page.wait_for_function(
            "() => document.querySelector('feedback-widget')?.dataset.fbMode === 'tab'", timeout=5000
        )
        state = h.state(page)
        measured["defaultEntry"] = state
        launcher = state["launcher"] or {}
        launcher_box = launcher.get("box") or {}
        h.results.check(
            "1 宿主未写 launcher-mode，组件解析为 auto",
            state["launcherModeAttr"] is None and state["launcherModeResolved"] == "auto",
            {"attr": state["launcherModeAttr"], "resolved": state["launcherModeResolved"]},
        )
        h.results.check(
            "1 桌面（精确指针、无触摸）生效模式为 tab",
            state["mode"] == "tab" and state["input"]["fine"] is True and state["input"]["touchPoints"] == 0,
            {"mode": state["mode"], "input": state["input"], "viewport": state["viewport"]},
        )
        h.results.check(
            "1 .fb-tab-launcher 可见（非 display:none、有实际命中尺寸、在视口内）",
            launcher.get("display") != "none"
            and launcher.get("visibility") == "visible"
            and (launcher.get("opacity") or 0) >= 0.99
            and launcher_box.get("width", 0) >= 44
            and launcher_box.get("height", 0) >= 44
            and inside(launcher_box, state["viewport"])
            and launcher.get("checkVisibility") is not False
            and "反馈" in (launcher.get("text") or ""),
            {"launcher": launcher},
        )
        h.results.check(
            "1 光束形态的灵感球在 tab 模式下隐藏",
            (state["orb"] or {}).get("display") == "none",
            {"orb": state["orb"]},
        )
        h.results.check(
            "1 初始状态面板未打开、覆盖层未出现",
            state["panelOpen"] is False and state["overlayHidden"] is True,
            {"panelOpen": state["panelOpen"], "overlayHidden": state["overlayHidden"]},
        )
        h.shot(page, "1-default-entry.png", state, "不写 launcher-mode 的桌面宿主：右侧贴边「反馈」入口")

        # ---- 场景 2：点入口 → 面板打开（带整屏视口截图） ----
        page.locator(".fb-tab-launcher").click()
        page.wait_for_function("() => !!window.__entry.q('.fb-panel.is-open')", timeout=20000)
        wait_thumb(page)
        state2 = h.state(page)
        measured["afterClick"] = state2
        thumb = state2["thumb"] or {}
        viewport = state2["viewport"]
        h.results.check(
            "2 点击入口后面板打开（.fb-panel.is-open 且有可见尺寸）",
            state2["panelOpen"] is True
            and state2["panelHidden"] is False
            and inside((state2["panel"] or {}).get("box"), viewport),
            {"panelOpen": state2["panelOpen"], "panelHidden": state2["panelHidden"], "panel": state2["panel"]},
        )
        h.results.check(
            "2 面板里插入的是整屏视口截图（尺寸 == 视口 1280x800）",
            thumb.get("naturalWidth") == viewport["width"] and thumb.get("naturalHeight") == viewport["height"],
            {"thumb": thumb, "viewport": viewport},
        )
        h.results.check(
            "2 缩略图可见且是 blob:（真实捕获，不是占位图）",
            thumb.get("visible") is True and thumb.get("src") == "blob:",
            {"thumb": thumb},
        )
        h.results.check(
            "2 面板打开时覆盖层关闭、贴边入口隐藏",
            state2["overlayHidden"] is True and (state2["launcher"] or {}).get("display") == "none",
            {"overlayHidden": state2["overlayHidden"], "launcher": state2["launcher"]},
        )
        h.shot(page, "2-entry-click-panel.png", state2, "点入口 → 面板打开并带一张整屏视口截图")
        h.results.check("1/2 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_alt_drag(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 3：Alt+拖拽选区 → 选区尺寸 → 使用此区域 ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        drag_w = DRAG_END[0] - DRAG_START[0]
        drag_h = DRAG_END[1] - DRAG_START[1]
        points = page.evaluate(
            RECT_POINTS_JS,
            {"x": DRAG_START[0], "y": DRAG_START[1], "width": drag_w, "height": drag_h},
        )
        h.results.check(
            "3 拖拽矩形内没有可交互元素（版面未漂移，Alt 拖拽测的是正文）",
            all(not point["interactive"] for point in points),
            points,
        )
        alt_drag(page, DRAG_START, DRAG_END)
        armed = h.wait_armed(page)
        h.results.check("3 Alt+拖拽松手后冻结覆盖层出现", armed, {"armed": armed})
        if not armed:
            return measured
        page.wait_for_function("() => window.__entry.q('.fb-region-frame')?.dataset.size", timeout=10000)
        page.wait_for_timeout(120)  # 预设矩形把入场动画回拨 550ms，选区已在终态
        state = h.state(page)
        measured["selection"] = state
        frame_size = size_pair(state["frameSize"] or "")
        frame_box = (state["frame"] or {}).get("box")
        tools = state["tools"] or {}
        use_btn = state["useBtn"] or {}
        h.results.check(
            "3 选区尺寸 dataset.size == 拖拽矩形（360x260，+-2px）",
            bool(frame_size) and near(frame_size[0], drag_w) and near(frame_size[1], drag_h),
            {"datasetSize": state["frameSize"], "expected": f"{drag_w}x{drag_h}"},
        )
        h.results.check(
            "3 选区框位置与拖拽矩形一致（x/y/w/h，+-2px）",
            bool(frame_box)
            and near(frame_box["x"], DRAG_START[0])
            and near(frame_box["y"], DRAG_START[1])
            and near(frame_box["width"], drag_w)
            and near(frame_box["height"], drag_h),
            {
                "frame": frame_box,
                "expected": {"x": DRAG_START[0], "y": DRAG_START[1], "width": drag_w, "height": drag_h},
            },
        )
        h.results.check(
            "3 选区框与压暗层已就位（覆盖层不是空壳）",
            (state["frame"] or {}).get("opacity", 0) >= 0.99
            and (state["regionBgSrc"] or "").startswith("blob:")
            and state["overlayHidden"] is False,
            {
                "frame": state["frame"],
                "regionBgSrc": state["regionBgSrc"],
                "overlayHidden": state["overlayHidden"],
            },
        )
        h.results.check(
            "3 选区工具条可见，且「使用此区域」可点",
            tools.get("display") != "none"
            and tools.get("visibility") == "visible"
            and (tools.get("opacity") or 0) > 0.9
            and inside(tools.get("box"), state["viewport"])
            and (use_btn.get("checkVisibility") is not False)
            and use_btn.get("text") == "使用此区域"
            and inside(use_btn.get("box"), state["viewport"]),
            {"tools": tools, "useBtn": use_btn},
        )
        h.results.check(
            "3 选区阶段不抢面板（面板仍关闭）",
            state["panelOpen"] is False,
            {"panelOpen": state["panelOpen"]},
        )
        h.shot(page, "3a-alt-drag-region.png", state, "Alt+拖拽 (400,300)->(760,560)：冻结画面 + 就位选区 + 工具条")

        page.locator(".fb-region-use").click()
        page.wait_for_function("() => !!window.__entry.q('.fb-panel.is-open')", timeout=20000)
        # 确认后有 1500ms 的「截图飞入缩略图」交接动画：期间覆盖层压暗、面板下滑入场，
        # 交接结束才收起覆盖层。等动画真的结束再量几何，避免把入场中间态当成终态。
        page.wait_for_function("() => window.__entry.overlay().hidden", timeout=8000)
        wait_thumb(page)
        page.wait_for_timeout(120)
        state2 = h.state(page)
        measured["afterUse"] = state2
        thumb = state2["thumb"] or {}
        crop = frame_size or (0, 0)
        size_label = size_pair(state2["sizeLabel"] or "")
        h.results.check(
            "3 点「使用此区域」后面板打开、覆盖层关闭（交接动画已结束）",
            state2["panelOpen"] is True and state2["overlayHidden"] is True,
            {"panelOpen": state2["panelOpen"], "overlayHidden": state2["overlayHidden"]},
        )
        panel_box = (state2["panel"] or {}).get("box") or {}
        thumb_box = (state2["thumb"] or {}).get("box") or {}
        h.results.check(
            "3 裁剪后的缩略图真的落在面板可见区内（不是飞入动画的中间位置）",
            bool(panel_box)
            and bool(thumb_box)
            and thumb_box.get("x", 0) >= panel_box.get("x", 0) - 0.5
            and thumb_box.get("y", 0) >= panel_box.get("y", 0) - 0.5
            and thumb_box.get("x", 0) + thumb_box.get("width", 0) <= panel_box.get("x", 0) + panel_box.get("width", 0) + 0.5
            and thumb_box.get("y", 0) + thumb_box.get("height", 0) <= panel_box.get("y", 0) + panel_box.get("height", 0) + 0.5,
            {"thumb": thumb_box, "panel": panel_box},
        )
        h.results.check(
            "3 插入的截图尺寸 == 裁剪尺寸（dataset.size）",
            thumb.get("naturalWidth") == crop[0] and thumb.get("naturalHeight") == crop[1],
            {"thumb": thumb, "crop": crop},
        )
        h.results.check(
            "3 插入的截图尺寸 == 拖拽矩形（360x260，+-2px）",
            near(thumb.get("naturalWidth"), drag_w) and near(thumb.get("naturalHeight"), drag_h),
            {"thumb": thumb, "expected": f"{drag_w}x{drag_h}"},
        )
        h.results.check(
            "3 面板尺寸标注与裁剪尺寸一致",
            bool(size_label) and size_label == crop,
            {"sizeLabel": state2["sizeLabel"], "crop": crop},
        )
        h.shot(page, "3b-panel-cropped.png", state2, "使用此区域：面板里插入的截图尺寸 == 裁剪尺寸")
        h.results.check("3 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured



def scenario_alt_drag_capture_off(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 3d：capture-mode=off 时 Alt+拖拽只打开面板（不冻结画面） ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        # 同一夹具页，运行期把截图模式切成 off：与宿主写 capture-mode="off" 等价。
        page.evaluate("() => document.getElementById('widget').setAttribute('capture-mode', 'off')")
        page.wait_for_function(
            "() => document.querySelector('feedback-widget')?.captureMode === 'off'", timeout=5000
        )
        alt_drag(page, DRAG_START, DRAG_END)
        page.wait_for_function("() => !!window.__entry.q('.fb-panel.is-open')", timeout=15000)
        page.wait_for_timeout(200)
        state = h.state(page)
        measured["captureOff"] = state
        thumb = state["thumb"] or {}
        h.results.check(
            "3d capture-mode=off 时 Alt+拖拽打开面板、不出现冻结覆盖层（预期行为，不是缺陷）",
            state["panelOpen"] is True and state["overlayHidden"] is True,
            {"panelOpen": state["panelOpen"], "overlayHidden": state["overlayHidden"], "captureMode": state["captureMode"]},
        )
        h.results.check(
            "3d capture-mode=off 时不自动插入截图（截图区保持隐藏）",
            thumb.get("visible") is False and (thumb.get("src") or "") != "blob:",
            {"thumb": thumb},
        )
        h.shot(page, "3d-capture-off-panel.png", state, "capture-mode=off：Alt+拖拽只打开面板，不冻结画面")
        h.results.check("3d 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_exclusions(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 3c：从按钮 / 链接起手，Alt+拖拽不接管（排除点） ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        targets = page.evaluate(
            r"""() => {
              const rect = id => {
                const r = document.getElementById(id).getBoundingClientRect();
                return {
                  x: r.x + r.width / 2,
                  y: r.y + r.height / 2,
                  box: { x: r.x, y: r.y, width: r.width, height: r.height },
                };
              };
              return { button: rect('demo-action'), link: rect('demo-link') };
            }"""
        )
        measured["targets"] = targets
        for name, target in targets.items():
            point = page.evaluate(POINT_JS, {"x": target["x"], "y": target["y"]})
            h.results.check(
                f"3c 起点 {name} 确实是可交互元素（夹具有效性）",
                point["interactive"] is True,
                point,
            )
            alt_drag(page, (target["x"], target["y"]), (target["x"] + 160, target["y"] - 140))
            page.wait_for_timeout(900)
            state = h.state(page)
            measured[f"after_{name}"] = {
                "overlayHidden": state["overlayHidden"],
                "panelOpen": state["panelOpen"],
                "hostClicks": state["hostClicks"],
            }
            h.results.check(
                f"3c 从 {name} 起手 Alt+拖拽：不出现冻结覆盖层、不打开面板",
                state["overlayHidden"] is True and state["panelOpen"] is False,
                {"overlayHidden": state["overlayHidden"], "panelOpen": state["panelOpen"], "target": name},
            )
            h.results.check(
                f"3c 从 {name} 起手拖拽没有误触宿主点击",
                (state["hostClicks"] or []) == [],
                {"hostClicks": state["hostClicks"], "target": name},
            )
        h.shot(page, "3c-alt-drag-excluded.png", measured, "从按钮起手 Alt+拖拽：组件不接管（覆盖层未出现）")

        page.locator("#demo-action").click()
        clicks = page.evaluate("() => window.__host.clicks.slice()")
        h.results.check(
            "3c 不带 Alt 的正常点击仍落到宿主按钮（排除点不是禁用区）",
            len(clicks) == 1 and clicks[0]["id"] == "demo-action",
            {"clicks": clicks},
        )
        h.results.check("3c 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_alt_click(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 4：Alt+点击（不拖）→ 圈选待命 ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        alt_click(page, DRAG_START)
        armed = h.wait_armed(page)
        h.results.check("4 Alt+点击后冻结覆盖层出现（按该点唤醒）", armed, {"armed": armed})
        if armed:
            wait_lasso_hint(page)
            page.wait_for_timeout(80)
            state = h.state(page)
            measured["standby"] = state
            lasso = state["lassoHint"] or {}
            h.results.check(
                "4 进入圈选待命：.fb-lasso-hint 可见且文案一致",
                lasso.get("hidden") is False
                and (lasso.get("text") or "") == "圈出问题位置"
                and inside(lasso.get("box"), state["viewport"]),
                {"lassoHint": lasso},
            )
            h.results.check(
                "4 待命阶段还没有选区框 / 工具条（先画圈再定选区）",
                (state["frameSize"] or "") == ""
                and (state["tools"] or {}).get("visibility") == "hidden"
                and (state["useBtn"] or {}).get("checkVisibility") is not True,
                {"frameSize": state["frameSize"], "tools": state["tools"], "useBtn": state["useBtn"]},
            )
            h.results.check(
                "4 待命阶段面板未打开",
                state["panelOpen"] is False,
                {"panelOpen": state["panelOpen"]},
            )
            h.shot(page, "4-alt-click-lasso.png", state, "Alt+点击（不拖）：冻结画面 + 圈选待命提示")
            page.keyboard.press("Escape")
            page.wait_for_function("() => window.__entry.overlay().hidden", timeout=8000)
            h.results.check(
                "4 Esc 取消后覆盖层关闭（待命不是死路）",
                page.evaluate("() => window.__entry.overlay().hidden") is True,
                {"overlayHidden": True},
            )
        h.results.check("4 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_first_hint(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 5：首次使用入口提示（出现一次） ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html", seen_hint=False)
    measured: dict[str, Any] = {}
    try:
        page.wait_for_function(
            "() => { const hint = window.__entry.q('.fb-entry-hint'); return !!hint && !hint.hidden; }",
            timeout=8000,
        )
        state = h.state(page)
        measured["firstLoad"] = state
        hint = state["entryHint"] or {}
        launcher_box = (state["launcher"] or {}).get("box") or {}
        hint_box = hint.get("box") or {}
        platform = state["input"]["platform"] or ""
        modifier = "⌘" if platform.startswith("Mac") else "Ctrl"
        expected_shortcut = modifier + "+Shift+F"
        overlap = max(
            0.0,
            min(hint_box.get("x", 0) + hint_box.get("width", 0), launcher_box.get("x", 0) + launcher_box.get("width", 0))
            - max(hint_box.get("x", 0), launcher_box.get("x", 0)),
        ) * max(
            0.0,
            min(hint_box.get("y", 0) + hint_box.get("height", 0), launcher_box.get("y", 0) + launcher_box.get("height", 0))
            - max(hint_box.get("y", 0), launcher_box.get("y", 0)),
        )
        h.results.check(
            "5 首次加载出现 .fb-entry-hint（可见、在视口内）",
            hint.get("hidden") is False
            and hint.get("display") != "none"
            and inside(hint_box, state["viewport"])
            and hint.get("checkVisibility") is not False,
            {"entryHint": hint},
        )
        h.results.check(
            f"5 提示文案含入口说明与快捷键（{expected_shortcut}）",
            "反馈入口在这里" in (hint.get("text") or "") and expected_shortcut in (hint.get("text") or ""),
            {"text": hint.get("text"), "expectedShortcut": expected_shortcut, "platform": platform},
        )
        h.results.check(
            "5 提示带可点关闭按钮（.fb-entry-hint-close）",
            hint.get("closeVisible") is True,
            {"closeVisible": hint.get("closeVisible"), "entryHint": hint},
        )
        h.results.check(
            "5 提示不遮挡入口（与 .fb-tab-launcher 无重叠）",
            overlap == 0,
            {"hint": hint_box, "launcher": launcher_box, "overlapArea": overlap},
        )
        h.results.check(
            "5 出现即记为已读（localStorage seen）",
            state["entryHintStorage"] == "seen",
            {"storage": state["entryHintStorage"], "key": HINT_KEY},
        )
        h.shot(page, "5a-entry-hint-first.png", state, "首次加载：入口旁一次性提示（含快捷键文案）")

        page.reload(wait_until="load")
        page.wait_for_function(READY_JS, timeout=20000)
        page.wait_for_function(
            "() => document.querySelector('feedback-widget')?.dataset.fbMode === 'tab'", timeout=5000
        )
        page.wait_for_timeout(2500)  # 提示延迟 900ms 出现，等足够久再断言「没有出现」
        state2 = h.state(page)
        measured["reload"] = state2
        hint2 = state2["entryHint"] or {}
        h.results.check(
            "5 刷新后不再出现入口提示",
            hint2.get("hidden") is True and hint2.get("display") == "none",
            {"entryHint": hint2, "storage": state2["entryHintStorage"]},
        )
        h.results.check(
            "5 刷新后仍记住已读（同一 appId）",
            state2["entryHintStorage"] == "seen",
            {"storage": state2["entryHintStorage"]},
        )
        h.shot(page, "5b-entry-hint-reload.png", state2, "刷新后：入口仍在，提示不再出现")
        h.results.check("5 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_shortcut_give_way(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 6：快捷键让路（宿主已 preventDefault → 组件不抢） ===", flush=True)
    measured: dict[str, Any] = {}
    context, page, errors = h.open("/entry-desktop-capture.html", query="?host=owns-shortcut")
    try:
        page.evaluate("() => { const a = document.activeElement; if (a && a.blur) a.blur(); }")
        page.keyboard.press(SHORTCUT)
        page.wait_for_timeout(1500)
        state = h.state(page)
        measured["intercepted"] = state
        lasso = state["lassoHint"] or {}
        h.results.check(
            "6 宿主在 document capture 阶段确实收到并拦截了 Ctrl+Shift+F",
            (state["hostShortcut"] or {}).get("seen", 0) >= 1
            and (state["hostShortcut"] or {}).get("prevented", 0) >= 1,
            {"hostShortcut": state["hostShortcut"]},
        )
        h.results.check(
            "6 宿主已拦截时组件让路：覆盖层不出现、面板不打开",
            state["overlayHidden"] is True and state["panelOpen"] is False,
            {"overlayHidden": state["overlayHidden"], "panelOpen": state["panelOpen"], "mode": state["mode"]},
        )
        h.results.check(
            "6 宿主已拦截时也不进入圈选待命",
            lasso.get("hidden") is True,
            {"lassoHint": lasso},
        )
        h.shot(page, "6a-shortcut-give-way.png", state, "宿主已 preventDefault：按 Ctrl+Shift+F 不出现任何组件 UI")
        h.results.check("6a 无 pageerror / console error", not errors, errors)
    finally:
        context.close()

    context, page, errors = h.open("/entry-desktop-capture.html")
    try:
        page.evaluate("() => { const a = document.activeElement; if (a && a.blur) a.blur(); }")
        page.keyboard.press(SHORTCUT)
        armed = h.wait_armed(page)
        h.results.check("6 去掉拦截后组件接管：覆盖层出现", armed, {"armed": armed})
        if armed:
            wait_lasso_hint(page)
            state = h.state(page)
            measured["taken"] = state
            h.results.check(
                "6 去掉拦截后进入圈选待命，且宿主这次没有拦截",
                (state["lassoHint"] or {}).get("hidden") is False
                and (state["hostShortcut"] or {}).get("prevented", 1) == 0
                and (state["hostShortcut"] or {}).get("seen", 0) >= 1,
                {"lassoHint": state["lassoHint"], "hostShortcut": state["hostShortcut"]},
            )
            h.shot(page, "6b-shortcut-taken.png", state, "同一页面去掉拦截：组件接管 Ctrl+Shift+F 并进入圈选待命")
        h.results.check("6b 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured



def scenario_settings_split(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 8（补充）：设置项按输入能力分叉（桌面不显示手指数） ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html")
    measured: dict[str, Any] = {}
    try:
        page.locator(".fb-tab-launcher").click()
        page.wait_for_function("() => !!window.__entry.q('.fb-panel.is-open')", timeout=20000)
        page.locator(".fb-settings-btn").click()
        page.wait_for_function(
            "() => { const view = window.__entry.q('.fb-settings'); return !!view && !view.hidden; }",
            timeout=10000,
        )
        page.wait_for_timeout(200)
        state = h.state(page)
        settings = page.evaluate(SETTINGS_JS) or {}
        measured = {"state": state, "settings": settings}
        platform = state["input"]["platform"] or ""
        alt_label = "⌥" if platform.startswith("Mac") else "Alt"
        shortcut = ("⌘" if platform.startswith("Mac") else "Ctrl") + "+Shift+F"
        styles = settings.get("styles") or {}
        desktop = settings.get("desktop") or {}
        gestures = settings.get("gestures") or {}
        facts = desktop.get("facts") or []
        fact_titles = [fact["title"] for fact in facts]
        h.results.check(
            "8 打开设置后「入口样式」提供 贴边标签 / 灵感球，且桌面不提供光束唤醒",
            (styles.get("tab") or {}).get("rowHidden") is False
            and (styles.get("tab") or {}).get("display") != "none"
            and (styles.get("orb") or {}).get("rowHidden") is False
            and (styles.get("orb") or {}).get("display") != "none"
            and (styles.get("beam") or {}).get("rowHidden") is True
            and (styles.get("beam") or {}).get("display") == "none",
            {"styles": styles},
        )
        h.results.check(
            "8 「唤醒方式」在桌面显示入口 / ⌥+拖拽 / 快捷键三项，不显示手指数",
            desktop.get("hidden") is False
            and desktop.get("display") != "none"
            and fact_titles
            == ["点击入口", "按住 " + alt_label + " 拖拽", "快捷键"]
            and any(shortcut in fact["detail"] for fact in facts),
            {"desktop": desktop, "expectedShortcut": shortcut},
        )
        h.results.check(
            "8 桌面不显示双指/三指手势项（行隐藏）与手势说明",
            bool(gestures)
            and all(row.get("rowHidden") is True and row.get("display") == "none" for row in gestures.values())
            and (settings.get("gestureNote") or {}).get("hidden") is True,
            {"gestures": gestures, "gestureNote": settings.get("gestureNote")},
        )
        h.shot(page, "8-desktop-settings.png", measured, "桌面设置：「入口样式」两选 + 「唤醒方式」三项，无手指数选项")
        h.results.check("8 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def scenario_touch(h: Harness) -> dict[str, Any]:
    print("\n=== 场景 7：触屏回归（has_touch=True + 触屏视口） ===", flush=True)
    context, page, errors = h.open("/entry-desktop.html", touch=True, viewport=TOUCH_VIEWPORT)
    measured: dict[str, Any] = {}
    try:
        page.wait_for_function(
            "() => document.querySelector('feedback-widget')?.dataset.fbMode === 'beam'", timeout=5000
        )
        state = h.state(page)
        measured["default"] = state
        h.results.check(
            "7 触屏（粗指针）下不写 launcher-mode 仍解析为 beam",
            state["mode"] == "beam" and state["input"]["coarse"] is True and state["input"]["touchPoints"] > 0,
            {"mode": state["mode"], "input": state["input"], "viewport": state["viewport"]},
        )
        h.results.check(
            "7 光束形态没有常驻入口（贴边标签与灵感球均 display:none）",
            (state["launcher"] or {}).get("display") == "none"
            and (state["orb"] or {}).get("display") == "none",
            {"launcher": state["launcher"], "orb": state["orb"]},
        )
        h.shot(page, "7a-touch-default-beam.png", state, "触屏视口 390x844 默认形态：beam（无可见入口）")

        cx, cy = TOUCH_VIEWPORT[0] // 2, TOUCH_VIEWPORT[1] // 2
        point = page.evaluate(POINT_JS, {"x": cx, "y": cy})
        h.results.check(
            "7 双指按压点落在非交互内容上（夹具有效性）",
            point["interactive"] is False,
            point,
        )
        trigger = page.evaluate(TOUCH_HOLD_JS, TOUCH_HOLD_MS)
        measured["trigger"] = trigger
        h.results.check(
            "7 合成双指长按 700ms 后冻结覆盖层出现",
            bool(trigger.get("armed")),
            trigger,
        )
        if trigger.get("armed"):
            wait_lasso_hint(page)
            page.wait_for_timeout(80)
            state2 = h.state(page)
            measured["afterHold"] = state2
            h.results.check(
                "7 双指长按后进入圈选待命（.fb-lasso-hint 可见）",
                (state2["lassoHint"] or {}).get("hidden") is False
                and (state2["lassoHint"] or {}).get("text") == "圈出问题位置",
                {"lassoHint": state2["lassoHint"]},
            )
            h.results.check(
                "7 圈选待命阶段面板未打开",
                state2["panelOpen"] is False,
                {"panelOpen": state2["panelOpen"]},
            )
            h.shot(page, "7b-touch-hold-lasso.png", state2, "触屏：双指长按 700ms 进入圈选待命")
        h.results.check("7 无 pageerror / console error", not errors, errors)
    finally:
        context.close()
    return measured


def main() -> int:
    started = time.monotonic()
    results = Results()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not BUNDLE.is_file():
        results.check(
            "组件构建产物存在",
            False,
            f"缺少 {BUNDLE}；请先执行 corepack pnpm --filter @feedback/web build",
        )
        print(f"[SUMMARY] PASS={results.passed} FAIL={results.failed}", flush=True)
        return 1
    missing = [str(path) for path in PAGE_FILES.values() if not path.is_file()]
    if missing:
        results.check("宿主页存在", False, {"missing": missing})
        print(f"[SUMMARY] PASS={results.passed} FAIL={results.failed}", flush=True)
        return 1

    bundle_stat = BUNDLE.stat()
    newest_src = max(
        (path.stat().st_mtime for path in (ROOT / "packages/web/src").rglob("*.ts")),
        default=0.0,
    )
    results.check(
        "dist 产物不早于 packages/web/src 的最新改动（构建是最新的）",
        bundle_stat.st_mtime >= newest_src,
        {
            "bundle": str(BUNDLE.relative_to(ROOT)),
            "bytes": bundle_stat.st_size,
            "builtAt": datetime.fromtimestamp(bundle_stat.st_mtime, timezone.utc).isoformat(),
            "newestSrcAt": datetime.fromtimestamp(newest_src, timezone.utc).isoformat(),
        },
    )

    temp_dir = Path(tempfile.mkdtemp(prefix="feedback-entry-desktop-"))
    server: LocalServer | None = None
    server_thread: threading.Thread | None = None
    browser = None
    browser_closed_cleanly = True
    port = 0
    manifest: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "task": "FB-ENTRY-001",
        "bundle": {
            "path": str(BUNDLE.relative_to(ROOT)),
            "bytes": bundle_stat.st_size,
            "modifiedAt": datetime.fromtimestamp(bundle_stat.st_mtime, timezone.utc).isoformat(),
        },
        "fixtures": [str(path.relative_to(ROOT)) for path in PAGE_FILES.values()],
        "desktop": {"viewport": list(VIEWPORT), "deviceScaleFactor": DEVICE_SCALE, "hasTouch": False},
        "touch": {"viewport": list(TOUCH_VIEWPORT), "deviceScaleFactor": DEVICE_SCALE, "hasTouch": True},
        "dragRect": {"from": list(DRAG_START), "to": list(DRAG_END)},
        "shots": [],
        "checks": [],
    }
    try:
        Handler.pages = {path: file.read_bytes() for path, file in PAGE_FILES.items()}
        Handler.bundle = BUNDLE.read_bytes()
        server = LocalServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        server_thread = threading.Thread(target=server.serve_forever, name="entry-desktop-http", daemon=True)
        server_thread.start()
        base_url = f"http://127.0.0.1:{port}"
        results.check(
            "临时 HTTP server 已启动（只服务夹具页与 dist 产物）",
            port > 0 and server_thread.is_alive(),
            {"baseUrl": base_url},
        )

        try:
            from playwright.sync_api import sync_playwright
        except Exception as exc:
            raise RuntimeError(f"无法导入 Playwright（请用 uv 运行）：{exc}") from exc

        with sync_playwright() as playwright:
            try:
                browser, channel, launch_failures = launch_browser(playwright)
                browser_closed_cleanly = False
                manifest["browser"] = {
                    "channel": channel,
                    "version": browser.version,
                    "launchFallbacks": launch_failures,
                }
                results.check("headless 真实浏览器已启动", bool(browser.version), manifest["browser"])

                harness = Harness(browser, base_url, results)
                manifest["measured"] = {
                    "defaultEntry": scenario_default_entry(harness),
                    "altDrag": scenario_alt_drag(harness),
                    "captureOff": scenario_alt_drag_capture_off(harness),
                    "exclusions": scenario_exclusions(harness),
                    "altClick": scenario_alt_click(harness),
                    "firstHint": scenario_first_hint(harness),
                    "shortcut": scenario_shortcut_give_way(harness),
                    "touch": scenario_touch(harness),
                    "settings": scenario_settings_split(harness),
                }
                manifest["shots"] = harness.shots
            finally:
                if browser is not None:
                    try:
                        browser.close()
                        browser_closed_cleanly = True
                    except Exception as exc:
                        results.check("浏览器关闭", False, f"{type(exc).__name__}: {exc}")
                    finally:
                        browser = None
    except Exception as exc:
        results.check("e2e harness 完成", False, f"{type(exc).__name__}: {exc}")
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
            temp_dir.rmdir()
        except OSError:
            pass

    cleanup = {
        "browserClosed": browser_closed_cleanly,
        "serverThreadStopped": server_thread is None or not server_thread.is_alive(),
        "tempDirRemoved": not temp_dir.exists(),
        "port": port,
    }
    port_closed = True
    if port:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.25)
            port_closed = sock.connect_ex(("127.0.0.1", port)) != 0
    results.check(
        "finally 完成 browser / server / 端口清理",
        all((cleanup["browserClosed"], cleanup["serverThreadStopped"], cleanup["tempDirRemoved"]))
        and port_closed,
        dict(cleanup, portClosed=port_closed),
    )

    manifest["checks"] = results.rows
    manifest["summary"] = {"passed": results.passed, "failed": results.failed}
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    results.check("manifest 写入", MANIFEST.is_file(), {"path": str(MANIFEST)})

    # 二次写入：把「manifest 写入」这一项自身也记进清单，使 manifest 的 PASS/FAIL
    # 与 stdout 汇总一致（只多这一行，不改变任何已记录结论）。
    manifest["checks"] = results.rows
    manifest["summary"] = {"passed": results.passed, "failed": results.failed}
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = results.passed + results.failed
    print(
        f"\n[SUMMARY] PASS={results.passed} FAIL={results.failed} TOTAL={total} "
        f"DURATION={time.monotonic() - started:.2f}s manifest={MANIFEST}",
        flush=True,
    )
    return 1 if results.failed else 0


if __name__ == "__main__":
    sys.exit(main())

