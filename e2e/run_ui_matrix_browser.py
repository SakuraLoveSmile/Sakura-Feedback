#!/usr/bin/env python3
"""管理后台视觉矩阵截图与结构检查（4 视口 × 明暗双主题 × 全部页面）。

用途（验收第 4、5 条）：同一脚本、同一场景分别跑在**改动前**与**改动后**的构建产物上，
交付逐文件名可比对的前后截图与结构断言（无整页横向溢出、页面可达、抽屉可开、焦点可见）。

环境变量：
  FB_E2E_ADMIN_DIST  管理页产物目录（默认 apps/admin/dist；基线用 .baseline/admin/dist）
  FB_E2E_SHOTS       截图输出目录（默认 e2e/shots/admin-matrix-<时间戳>）
  FB_E2E_MATRIX_PORT 反馈服务端口（默认 8797，避开既有预览 8787/8788）
  E2E_KANEO_PORT / E2E_AI_PORT  复用或隔离 mock（默认 8898/8899，与既有预览一致时复用健康实例）

200% 缩放：真浏览器 tab 缩放在无头模式不可用，这里用「CSS 视口减半」等效复现
（浏览器缩放的布局效果就是可用 CSS 像素减半），报告中标注为 zoom200。
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

_THIS = os.path.abspath(__file__)
ROOT = os.path.dirname(os.path.dirname(_THIS))
SERVER_DIR = os.path.join(ROOT, "apps", "server")
ADMIN_DIST = os.environ.get("FB_E2E_ADMIN_DIST") or os.path.join(ROOT, "apps", "admin", "dist")
PORT = int(os.environ.get("FB_E2E_MATRIX_PORT", "8797"))
BASE = f"http://localhost:{PORT}"
KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))
SHOTS = os.environ.get("FB_E2E_SHOTS") or os.path.join(
    ROOT, "e2e", "shots", "admin-matrix-" + time.strftime("%Y%m%d-%H%M%S")
)
ADMIN_USER, ADMIN_PASS = "admin", "matrix-pass-e2e-1"
USER_NAME, USER_PASS = "matrix-user", "matrix-user-pass-1"
SEED_APP_ID, SEED_APP_NAME = "com.matrix.e2e", "矩阵夹具软件"

# 四档验收视口 + 600–767 抽屉全屏敏感档 + 两组 200% 缩放等效（CSS 视口减半）
VIEWPORTS = [
    ("390x844", 390, 844),
    ("700x900", 700, 900),
    ("768x1024", 768, 1024),
    ("1440x900", 1440, 900),
    ("1920x1080", 1920, 1080),
    ("zoom200-1440x900", 720, 450),
    ("zoom200-1920x1080", 960, 540),
]
PAGES = ["feedbacks", "apps", "accounts", "connections", "sessions", "settings", "system-update"]

results: list[dict] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append({"name": name, "ok": bool(cond), "detail": detail})
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)


def port_busy(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_http(url: str, timeout: float = 40) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return True
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    return False


class Api:
    """最小 JSON API 客户端（自动携带会话 Cookie）。"""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            BASE + path,
            data=data,
            method=method,
            headers={"content-type": "application/json"} if data else {},
        )
        try:
            with self.op.open(req, timeout=20) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            raw = e.read()
            try:
                return e.code, json.loads(raw) if raw else None
            except Exception:  # noqa: BLE001
                return e.code, {"raw": raw[:200].decode("utf-8", "replace")}


def port_busy_any(port: int) -> bool:
    return port_busy(port)


def seed(api: Api) -> None:
    st, _ = api.call("POST", "/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    check("管理登录 200", st == 200, f"status={st}")
    # 复用既有 mock（预览环境已在 8898/8899 起过健康实例时不重复起）
    st, _ = api.call(
        "PUT",
        "/api/admin/connection/kaneo",
        {"baseUrl": f"http://127.0.0.1:{KANEO_PORT}", "apiKey": "k-e2e"},
    )
    check("Kaneo 连接写入", st in (200, 204), f"status={st}")
    st, _ = api.call(
        "PUT",
        "/api/admin/connection/ai",
        {"baseUrl": f"http://127.0.0.1:{AI_PORT}/v1", "model": "mock", "apiKey": "a-e2e"},
    )
    check("AI 连接写入", st in (200, 204), f"status={st}")
    st, body = api.call(
        "POST",
        "/api/admin/users",
        {"username": USER_NAME, "password": USER_PASS, "dailyLimit": 20},
    )
    check("创建普通账号 201", st == 201, f"status={st} body={body}")
    st, body = api.call(
        "POST",
        "/api/admin/apps",
        {
            "appId": SEED_APP_ID,
            "name": SEED_APP_NAME,
            "allowedOrigins": [],
            "kaneoProjectId": "p-e2e",
            "kaneoColumnSlug": "triage",
        },
    )
    check("种子软件创建 201", st == 201, f"status={st} body={body}")

    uh = Api()
    st, _ = uh.call("POST", "/api/auth/login", {"username": USER_NAME, "password": USER_PASS})
    check("普通账号登录 200", st == 200, f"status={st}")
    ids = []
    texts = [
        "导出 CSV 时进度条卡在 90%，等了十分钟也没有反应。",
        "设置页保存后没有提示，我不确定到底有没有生效。",
        "深色模式下按钮文字看不清楚，对比度太低。",
    ]
    for i, text in enumerate(texts):
        st, body = uh.call(
            "POST",
            "/api/feedback",
            {
                "idempotencyKey": f"matrix-{i}-{secrets_token()}",
                "appId": SEED_APP_ID,
                "text": text,
                "context": {"appVersion": "1.0.0", "pageLabel": "matrix"},
            },
        )
        check(f"种子反馈 {i} 201", st == 201, f"status={st} body={body}")
        if st == 201:
            ids.append(body.get("feedbackId"))
    # 状态多样性：第二条置为已解决（带处理说明），第三条等待用户补充
    if len(ids) >= 3:
        detail_st, detail = api.call("GET", f"/api/admin/feedback/{ids[1]}")
        ver = (detail or {}).get("dialogueVersion") or 0
        st, _ = api.call(
            "POST",
            f"/api/admin/feedback/{ids[1]}/issue-status",
            {"issueStatus": "resolved", "resolutionNote": "已在 0.6.0 修复导出进度回传。", "expectedDialogueVersion": ver},
        )
        check("夹具：置为已解决", st in (200, 201, 204), f"status={st}")
        detail_st, detail = api.call("GET", f"/api/admin/feedback/{ids[2]}")
        ver = (detail or {}).get("dialogueVersion") or 0
        st, _ = api.call(
            "POST",
            f"/api/admin/feedback/{ids[2]}/messages",
            {"text": "方便补充一下截图吗？", "issueStatusAction": "request_info", "expectedDialogueVersion": ver},
        )
        check("夹具：请求补充信息", st in (200, 201, 204), f"status={st}")
    return ids


def secrets_token() -> str:
    import secrets

    return secrets.token_hex(4)


def overflow(page) -> tuple[int, int]:
    return page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")


def run() -> int:
    if not os.path.exists(os.path.join(ADMIN_DIST, "index.html")):
        print(f"[FATAL] 缺少管理页产物 {ADMIN_DIST}", flush=True)
        return 2
    if port_busy(PORT):
        print(f"[FATAL] 端口 {PORT} 已被占用；用 FB_E2E_MATRIX_PORT 指定其它端口", flush=True)
        return 2
    for name, port in (("Kaneo mock", KANEO_PORT), ("AI mock", AI_PORT)):
        if not port_busy(port):
            print(f"[FATAL] {name} :{port} 未就绪（本脚本复用既有 mock，不自行起停既有预览）", flush=True)
            return 2

    os.makedirs(SHOTS, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="fb-matrix-")
    env = dict(os.environ)
    env.update(
        FEEDBACK_MASTER_KEY="bWF0cml4LWUyZS1tYXN0ZXIta2V5LTIyYnl0ZXMhIQ==",
        FEEDBACK_ADMIN_USER=ADMIN_USER,
        FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
        FEEDBACK_ADMIN_DIST=ADMIN_DIST,
        FEEDBACK_DATA_DIR=data_dir,
        FEEDBACK_PORT=str(PORT),
        NODE_ENV="production",
    )
    log = open("/tmp/fb-matrix-server.log", "w")
    proc = subprocess.Popen(
        ["npx", "tsx", "src/index.ts"], cwd=SERVER_DIR, env=env,
        stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        if not wait_http(f"{BASE}/healthz"):
            print("[FATAL] 反馈服务未就绪，见 /tmp/fb-matrix-server.log", flush=True)
            return 2

        print("[STEP] 种子数据（独立临时数据目录，不触碰既有预览数据）", flush=True)
        seed(Api())

        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch()

            # —— 登录页（未登录上下文）——
            for theme in ("light", "dark"):
                ctx = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme=theme)
                page = ctx.new_page()
                page.goto(f"{BASE}/admin/", wait_until="load")
                page.wait_for_timeout(500)
                sw, iw = overflow(page)
                check(f"登录页 {theme} 1440×900 无横向溢出", sw <= iw + 1, f"{sw}>{iw}")
                shot(page, f"login-{theme}-1440x900")
                ctx.close()

            # —— 已登录：全部页面 × 视口 × 主题 ——
            for theme in ("light", "dark"):
                ctx = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme=theme)
                ctx.add_init_script(
                    f"try {{ localStorage.setItem('feedback.admin.theme', '{theme}'); }} catch (e) {{}}"
                )
                resp = ctx.request.post(
                    f"{BASE}/api/auth/login", data={"username": ADMIN_USER, "password": ADMIN_PASS}
                )
                check(f"{theme} 上下文 API 登录", resp.status == 200, f"status={resp.status}")
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))

                for vp_name, w, h in VIEWPORTS:
                    page.set_viewport_size({"width": w, "height": h})
                    for pg in PAGES:
                        page.goto(f"{BASE}/admin/?page={pg}", wait_until="load")
                        page.wait_for_timeout(450)
                        sw, iw = overflow(page)
                        check(f"[{theme} {vp_name}] {pg} 无整页横向溢出", sw <= iw + 1, f"{sw}>{iw}")
                        shot(page, f"{pg}-{theme}-{vp_name}")

                    # 反馈详情抽屉（新旧结构都用 .cell-open / .fb-card-open 入口）
                    page.goto(f"{BASE}/admin/?page=feedbacks", wait_until="load")
                    page.wait_for_timeout(600)
                    opened = page.evaluate(
                        """() => {
                            const sel = '.cell-open, .fb-card-open, .feedback-title button, .feedback-title';
                            const el = document.querySelector(sel);
                            if (!el) return 'no-entry';
                            el.click();
                            return 'ok';
                        }"""
                    )
                    if opened == "ok":
                        page.wait_for_timeout(700)
                        drawer = page.evaluate(
                            """() => {
                                const d = document.querySelector('.drawer');
                                return d ? {open: !d.hidden && d.getBoundingClientRect().width > 0,
                                           w: d.getBoundingClientRect().width} : null;
                            }"""
                        )
                        check(
                            f"[{theme} {vp_name}] 反馈详情抽屉打开",
                            bool(drawer and drawer["open"]),
                            str(drawer),
                        )
                        if drawer and drawer["open"]:
                            if w < 768:
                                # T5：详情在 768 以下全屏（600–767 是旧版非全屏的敏感区间）
                                check(
                                    f"[{theme} {vp_name}] 详情抽屉全屏（<768）",
                                    drawer["w"] >= w - 1,
                                    f"drawerWidth={drawer['w']} viewport={w}",
                                )
                            sw, iw = overflow(page)
                            check(f"[{theme} {vp_name}] 详情打开时无横向溢出", sw <= iw + 1, f"{sw}>{iw}")
                            shot(page, f"feedback-detail-{theme}-{vp_name}")
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(300)
                    else:
                        check(f"[{theme} {vp_name}] 反馈详情入口存在", False, opened)

                # 焦点可见性抽查（桌面 + 移动各一次）
                page.set_viewport_size({"width": 1440, "height": 900})
                page.goto(f"{BASE}/admin/?page=feedbacks", wait_until="load")
                page.wait_for_timeout(400)
                page.keyboard.press("Tab")
                page.keyboard.press("Tab")
                focus = page.evaluate(
                    """() => {
                        const el = document.activeElement;
                        if (!el || el === document.body) return null;
                        const s = getComputedStyle(el);
                        return {tag: el.tagName, outline: s.outlineStyle, width: s.outlineWidth,
                                shadow: s.boxShadow};
                    }"""
                )
                check(
                    f"[{theme}] Tab 焦点可见（outline 或 box-shadow）",
                    bool(focus)
                    and (
                        (focus["outline"] not in ("none",) and focus["width"] not in ("0px",))
                        or (focus["shadow"] and focus["shadow"] != "none")
                    ),
                    str(focus),
                )
                shot(page, f"focus-{theme}-1440x900")
                check(f"[{theme}] 页面无 JS 运行时错误", not errors, str(errors[:1]))
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        shutil.rmtree(data_dir, ignore_errors=True)

    passed = sum(1 for r in results if r["ok"])
    report = {
        "adminDist": ADMIN_DIST,
        "shots": SHOTS,
        "viewports": [v[0] for v in VIEWPORTS],
        "themes": ["light", "dark"],
        "pages": PAGES,
        "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed},
        "results": results,
    }
    with open(os.path.join(SHOTS, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"[SUMMARY] {passed}/{len(results)} 通过；报告 {os.path.join(SHOTS, 'report.json')}", flush=True)
    return 0 if passed == len(results) else 1


def shot(page, name: str) -> None:
    path = os.path.join(SHOTS, name + ".png")
    try:
        page.screenshot(path=path)
        print(f"  [shot] {path}", flush=True)
    except Exception as exc:  # noqa: BLE001
        check(f"截图 {name}", False, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(run())
