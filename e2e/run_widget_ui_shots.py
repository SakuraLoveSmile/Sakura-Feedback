#!/usr/bin/env python3
"""组件视觉前后对比截图（4 视口 × 明暗双主题），可指向不同构建产物。

用途（验收第 5 条）：先用**本轮改动前**的产物形成截图基线，再用**改动后**产物跑同一
脚本、同一场景，交付前后对比；历史截图不充当本次验证。

场景（每次都相同，宿主页固定 e2e/pages/orb.html）：
  1) 静止灵感球（launcher-mode=orb）
  2) 点击灵感球 → 截图完成后面板（capture-mode=viewport）
  3) 打开图片编辑器 → 切到「裁剪」→ 在画布上拖出一个选区 → 松手后的编辑器形态
     （改动前：松手后选区边框消失、无独立结果预览；改动后：选区持续显示 + 「裁剪结果」预览）

环境变量：
  FB_E2E_SDK_DIST    /sdk/feedback-web.umd.js 的产物目录（默认 packages/web/dist；
                     基线用 .baseline/web/dist 快照，避免与并行执行者的重建竞态）
  FB_E2E_SHOTS       截图输出目录（默认 e2e/shots/widget-ui-<时间戳>）
  FB_E2E_PAGES_PORT  本脚本自建宿主页端口（默认 5291，避开既有预览 5189）

宿主页 e2e/pages/*.html 的 api-base 固定指向 :8787（本机既有体验环境）。本脚本**只做
只读交互**：开面板、开编辑器、拖选区，不提交、不登录、不写入该服务的任何数据。
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import sys
import time

from playwright.sync_api import sync_playwright

_THIS = os.path.abspath(__file__)
ROOT = os.path.dirname(os.path.dirname(_THIS))
PAGES_DIR = os.path.join(ROOT, "e2e", "pages")
SDK_DIST = os.environ.get("FB_E2E_SDK_DIST") or os.path.join(ROOT, "packages", "web", "dist")
SDK_UMD = os.path.join(SDK_DIST, "feedback-web.umd.cjs")
PAGES_PORT = int(os.environ.get("FB_E2E_PAGES_PORT", "5291"))
BACKEND = "http://localhost:8787"
SHOTS = os.environ.get("FB_E2E_SHOTS") or os.path.join(
    ROOT, "e2e", "shots", "widget-ui-" + time.strftime("%Y%m%d-%H%M%S")
)

VIEWPORTS = [(390, 844), (768, 1024), (1440, 900), (1920, 1080)]
THEMES = ["light", "dark"]
PAGE_URL = f"http://localhost:{PAGES_PORT}/orb.html"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    """e2e/pages 静态托管 + /sdk/feedback-web.umd.js 映射到指定产物目录。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PAGES_DIR, **kwargs)

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/sdk/feedback-web.umd.js":
            with open(SDK_UMD, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("content-type", "text/javascript; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def log_message(self, *args):  # 静音
        pass


def start_pages_server():
    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = Server(("127.0.0.1", PAGES_PORT), PagesHandler)
    import threading

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def shot(page, name: str) -> None:
    os.makedirs(SHOTS, exist_ok=True)
    path = os.path.join(SHOTS, name + ".png")
    try:
        page.screenshot(path=path)
        print(f"  [shot] {path}", flush=True)
    except Exception as exc:  # noqa: BLE001
        check(f"截图 {name}", False, f"{type(exc).__name__}: {exc}")


def overflow(page) -> tuple[int, int]:
    return page.evaluate(
        "() => [document.documentElement.scrollWidth, window.innerWidth]"
    )


def run() -> int:
    if not os.path.exists(SDK_UMD):
        print(f"[FATAL] 缺少组件产物 {SDK_UMD}", flush=True)
        return 2
    try:
        import urllib.request

        urllib.request.urlopen(BACKEND + "/healthz", timeout=3).read()
    except Exception:  # noqa: BLE001
        print(f"[FATAL] 体验服务 {BACKEND} 未就绪（本脚本不负责启动/重启既有预览）", flush=True)
        return 2

    os.makedirs(SHOTS, exist_ok=True)
    httpd = start_pages_server()
    print(f"[INFO] SDK={SDK_DIST}\n[INFO] 宿主页=http://localhost:{PAGES_PORT}/orb.html\n[INFO] SHOTS={SHOTS}", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in THEMES:
            ctx = browser.new_context(color_scheme=theme)
            for w, h in VIEWPORTS:
                tag = f"{theme}-{w}x{h}"
                page = ctx.new_page()
                page.set_viewport_size({"width": w, "height": h})
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(PAGE_URL, wait_until="load")
                page.wait_for_timeout(600)

                # 1) 静止灵感球（Custom Element 是 open shadow root，直接读几何）
                orb = page.evaluate(
                    """() => {
                        const w = document.querySelector('feedback-widget');
                        const sr = w && w.shadowRoot;
                        if (!sr) return null;
                        const orb = sr.querySelector('.fb-orb');
                        if (!orb) return null;
                        const r = orb.getBoundingClientRect();
                        return {x: r.x, y: r.y, w: r.width, h: r.height,
                                visible: !!(r.width && r.height) && getComputedStyle(orb).visibility !== 'hidden'};
                    }"""
                )
                check(f"{tag} 灵感球可见", bool(orb and orb.get("visible")), str(orb))
                if orb:
                    check(
                        f"{tag} 灵感球尺寸记录",
                        True,
                        f"w={orb['w']:.0f} h={orb['h']:.0f}",
                    )
                # 注：宿主页 orb.html 自带 1280px 宽的演示内容（非产品 UI），
                # 整页溢出检查放到打开面板后针对**组件面板**做。
                shot(page, f"01-orb-static-{tag}")

                # 2) 真实指针点击灵感球（组件监听 pointerdown/up，合成 click 不生效）
                if orb:
                    page.mouse.click(orb["x"] + orb["w"] / 2, orb["y"] + orb["h"] / 2)
                try:
                    page.wait_for_function(
                        """() => {
                            const sr = document.querySelector('feedback-widget').shadowRoot;
                            const panel = sr.querySelector('.fb-panel');
                            return panel && panel.classList.contains('is-open');
                        }""",
                        timeout=15000,
                    )
                    panel_ok = True
                except Exception as exc:  # noqa: BLE001
                    panel_ok = False
                    check(f"{tag} 面板打开", False, str(exc)[:120])
                if panel_ok:
                    check(f"{tag} 面板打开（截图完成后面板可见）", True)
                    # 组件面板自身不越界（宿主页内容不计入）
                    panel_box = page.evaluate(
                        """() => {
                            const sr = document.querySelector('feedback-widget').shadowRoot;
                            const p = sr.querySelector('.fb-panel');
                            if (!p) return null;
                            const r = p.getBoundingClientRect();
                            return {x: r.x, w: r.width, vw: window.innerWidth};
                        }"""
                    )
                    if panel_box:
                        check(
                            f"{tag} 面板不越出视口",
                            panel_box["x"] >= -1 and panel_box["x"] + panel_box["w"] <= panel_box["vw"] + 1,
                            str(panel_box),
                        )
                    shot(page, f"02-panel-{tag}")

                    # 3) 打开图片编辑器（截图缩略图下方的「编辑」入口）
                    page.wait_for_timeout(400)
                    clicked = page.evaluate(
                        """() => {
                            const sr = document.querySelector('feedback-widget').shadowRoot;
                            const btn = [...sr.querySelectorAll('button')]
                              .find(b => (b.textContent || '').trim() === '编辑'
                                  && b.getClientRects().length > 0);
                            if (!btn) return 'no-edit-button';
                            const r = btn.getBoundingClientRect();
                            return {x: r.x + r.width / 2, y: r.y + r.height / 2};
                        }"""
                    )
                    if isinstance(clicked, dict):
                        page.mouse.click(clicked["x"], clicked["y"])
                        try:
                            page.wait_for_function(
                                """() => {
                                    const sr = document.querySelector('feedback-widget').shadowRoot;
                                    const ed = sr.querySelector('.fb-editor');
                                    if (!ed) return false;
                                    // 覆盖层是 position:fixed，offsetParent 恒为 null，改用几何判定
                                    const s = getComputedStyle(ed);
                                    return s.display !== 'none' && s.visibility !== 'hidden'
                                        && ed.getClientRects().length > 0;
                                }""",
                                timeout=8000,
                            )
                            editor_ok = True
                        except Exception:  # noqa: BLE001
                            editor_ok = False
                        check(f"{tag} 图片编辑器打开", editor_ok)
                        if editor_ok:
                            shot(page, f"03-editor-{tag}")
                            # 切到「裁剪」工具
                            page.evaluate(
                                """() => {
                                    const sr = document.querySelector('feedback-widget').shadowRoot;
                                    const btn = [...sr.querySelectorAll('button')]
                                      .find(b => (b.textContent || '').trim() === '裁剪');
                                    if (btn) btn.click();
                                }"""
                            )
                            page.wait_for_timeout(200)
                            # 在画布上拖出一个选区（中偏左上 → 对角）
                            box = page.evaluate(
                                """() => {
                                    const sr = document.querySelector('feedback-widget').shadowRoot;
                                    const c = sr.querySelector('.fb-editor-canvas');
                                    if (!c) return null;
                                    const r = c.getBoundingClientRect();
                                    return {x: r.x, y: r.y, w: r.width, h: r.height};
                                }"""
                            )
                            if box and box["w"] > 40 and box["h"] > 40:
                                x0 = box["x"] + box["w"] * 0.2
                                y0 = box["y"] + box["h"] * 0.2
                                x1 = box["x"] + box["w"] * 0.7
                                y1 = box["y"] + box["h"] * 0.7
                                page.mouse.move(x0, y0)
                                page.mouse.down()
                                page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=5)
                                page.mouse.move(x1, y1, steps=5)
                                page.mouse.up()
                                page.wait_for_timeout(300)
                                shot(page, f"04-editor-crop-selection-{tag}")
                                # 松手后选区是否仍然可见（改动前为否：这是本轮要修的差异）
                                state = page.evaluate(
                                    """() => {
                                        const sr = document.querySelector('feedback-widget').shadowRoot;
                                        const bar = sr.querySelector('.fb-editor-cropbar');
                                        const hint = sr.querySelector('.fb-editor-crop-hint');
                                        const preview = sr.querySelector('.fb-editor-preview, .fb-crop-preview');
                                        return {
                                          cropBarVisible: !!(bar && !bar.hidden),
                                          hint: hint ? (hint.textContent || '').trim() : null,
                                          hasPreview: !!preview,
                                        };
                                    }"""
                                )
                                check(
                                    f"{tag} 裁剪选区松手后仍处于待确认态",
                                    bool(state["cropBarVisible"]),
                                    json.dumps(state, ensure_ascii=False),
                                )
                            else:
                                check(f"{tag} 编辑器画布可拖拽", False, str(box))
                            # 关闭编辑器（不保存）
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(200)
                    elif clicked == "no-edit-button":
                        check(f"{tag} 面板内存在「编辑」入口", False, "未找到编辑按钮")

                check(f"{tag} 页面无 JS 运行时错误", not errors, str(errors[:1]))
                page.close()
            ctx.close()
        browser.close()
    httpd.shutdown()

    passed = sum(1 for _, ok, _ in results if ok)
    report = {
        "sdk": SDK_DIST,
        "page": PAGE_URL,
        "shots": SHOTS,
        "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed},
        "results": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
    }
    with open(os.path.join(SHOTS, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"[SUMMARY] {passed}/{len(results)} 通过；报告 {os.path.join(SHOTS, 'report.json')}", flush=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(run())
