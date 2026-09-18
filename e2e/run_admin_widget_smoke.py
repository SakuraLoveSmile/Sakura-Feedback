#!/usr/bin/env python3
"""管理后台自持反馈组件 —— 真实浏览器冒烟（0.5.2 起后台内嵌 <feedback-widget>）。

流程：真实服务（tsx src/index.ts）+ 真实构建产物（apps/admin/dist）+ Playwright。
断言：登录页即有组件、单实例、自动预登记 com.feedback.admin、握手注入会话、
视口截图自动附加、提交进入收件箱（appId/username/screenshot 断言）、
导航改 page-label、主题联动、登出回组件自登录态。

用法：python3 e2e/run_admin_widget_smoke.py（先构建 apps/admin/dist）
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SERVER_DIR = os.path.join(ROOT, "apps", "server")
ADMIN_DIST = os.path.join(ROOT, "apps", "admin", "dist")

ADMIN_PASS = "admin-" + secrets.token_hex(12)
FB_TEXT = "WIDGET-SMOKE 管理后台自持组件反馈"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond, detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


class Http:
    def __init__(self) -> None:
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method: str, url: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        try:
            with self.opener.open(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": raw[:300]}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 90) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"服务未就绪：{url}")


def main() -> int:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    data_dir = tempfile.mkdtemp(prefix="fb-widget-smoke-")
    log_path = "/tmp/fb-widget-smoke-server.log"

    env = dict(os.environ)
    env.update(
        FEEDBACK_MASTER_KEY="dWktZTJlLW1hc3Rlci1rZXktMzJieXRlcyE=",
        FEEDBACK_ADMIN_USER="admin",
        FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
        FEEDBACK_ADMIN_DIST=ADMIN_DIST,
        FEEDBACK_DATA_DIR=data_dir,
        FEEDBACK_PORT=str(port),
        NODE_ENV="production",
    )
    log = open(log_path, "w")
    proc = subprocess.Popen(["npx", "tsx", "src/index.ts"], cwd=SERVER_DIR, env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        wait_http(f"{base}/healthz")
        h = Http()
        st, _ = h.call("POST", f"{base}/api/auth/login", {"username": "admin", "password": ADMIN_PASS})
        check("API 管理员登录", st == 200, f"status={st}")

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 900})

            # 1) 登录页：组件已存在且唯一，orb 入口可见
            page.goto(f"{base}/admin/", wait_until="domcontentloaded")
            # host 元素无盒模型（内容全在 shadow 内 fixed 定位）：等挂载而非可见
            page.wait_for_selector("feedback-widget", state="attached", timeout=15000)
            check("登录页存在 feedback-widget", page.locator("feedback-widget").count() == 1)
            check("登录页 orb 可见", page.locator(".fb-orb").first.is_visible())
            check("登录页 page-label", page.locator("feedback-widget").get_attribute("page-label") == "admin:login")

            # 2) 登录后台 → 宿主会话编排（预登记 + 握手注入）
            page.fill("#u", "admin")
            page.fill("#p", ADMIN_PASS)
            page.click("form:has(#u) button[type=submit]")
            page.wait_for_selector(".nav-item:visible", timeout=20000)
            check("登录后组件仍唯一", page.locator("feedback-widget").count() == 1)

            deadline = time.time() + 15
            app_ok = False
            while time.time() < deadline and not app_ok:
                st, data = h.call("GET", f"{base}/api/admin/apps")
                apps = (data or {}).get("apps", [])
                mine = [a for a in apps if a.get("appId") == "com.feedback.admin"]
                app_ok = bool(mine) and base in mine[0].get("allowedOrigins", [])
                if not app_ok:
                    time.sleep(0.5)
            check("自动登记 com.feedback.admin 且含当前 origin", app_ok)

            # 3) 点击 orb：视口截图 + 面板打开（注入会话 → 无登录表单）
            page.locator(".fb-orb").first.click()
            page.wait_for_selector(".fb-textarea:visible", timeout=20000)
            page.wait_for_timeout(1500)
            shot_visible = page.locator(".fb-screenshot-wrap").first.is_visible()
            check("视口截图自动附加", shot_visible)
            login_panel = page.locator(".fb-login-panel")
            check("面板无登录表单（握手注入生效）",
                  login_panel.count() == 0 or login_panel.first.is_hidden())

            # 4) 提交反馈（空文本时按钮本就禁用，先输入再断言可用）
            page.fill(".fb-textarea", FB_TEXT)
            page.wait_for_timeout(300)
            check("输入后提交按钮可用", page.locator(".fb-submit").first.is_enabled())
            page.locator(".fb-submit").first.click()
            page.wait_for_timeout(3000)

            st, data = h.call("GET", f"{base}/api/admin/feedback?appId=com.feedback.admin")
            items = (data or {}).get("items", [])
            hit = [i for i in items if FB_TEXT.split()[0] in (i.get("textPreview") or i.get("title") or "")]
            check("反馈进入收件箱且 appId 正确", bool(hit), f"items={len(items)}")
            if hit:
                it = hit[0]
                check("提交身份为 admin", it.get("username") == "admin", f"username={it.get('username')}")
                check("记录带截图", it.get("hasScreenshot") is True)
                st, detail = h.call("GET", f"{base}/api/admin/feedback/{it['id']}")
                ctx = ((detail or {}).get("feedback") or detail or {}).get("context") or {}
                check("pageLabel=admin:feedbacks", ctx.get("pageLabel") == "admin:feedbacks",
                      f"context={ctx}")

            # 5) 关面板导航到软件页：组件仍唯一，page-label 跟随
            #    （桌面布局下顶栏 .nav-scroll 隐藏，导航点可见的侧边栏副本；
            #      提交后面板处于 tracking 态，Escape 不关面板，用显式关闭按钮）
            if page.locator(".fb-close").count() and page.locator(".fb-close").first.is_visible():
                page.locator(".fb-close").first.click()
                page.wait_for_timeout(400)
            page.locator(".shell-nav .nav-item", has_text="软件配置").first.click()
            page.wait_for_timeout(500)
            check("导航后组件仍唯一", page.locator("feedback-widget").count() == 1)
            check("page-label 跟随页面", page.locator("feedback-widget").get_attribute("page-label") == "admin:apps",
                  page.locator("feedback-widget").get_attribute("page-label"))

            # 6) 主题联动：切深色 → 组件 theme 属性同步
            page.locator('.shell-nav select[aria-label="主题"]').first.select_option("dark")
            page.wait_for_timeout(300)
            check("theme 属性联动", page.locator("feedback-widget").get_attribute("theme") == "dark")

            # 7) 登出 → 组件回到自登录态（dropSession），仍单实例
            page.locator(".shell-nav button:has-text('退出登录')").first.click()
            page.wait_for_selector("#u", timeout=10000)
            check("登出后组件仍唯一", page.locator("feedback-widget").count() == 1)
            page.locator(".fb-orb").first.click()
            page.wait_for_selector(".fb-textarea:visible", timeout=20000)
            page.fill(".fb-textarea", "x")
            page.locator(".fb-submit").first.click()
            page.wait_for_timeout(800)
            lp = page.locator(".fb-login-panel")
            check("登出后组件回到需要登录态", lp.count() > 0 and lp.first.is_visible())

            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        log.close()

    fails = [r for r in results if not r[1]]
    print(f"\n{'=' * 50}\n{len(results) - len(fails)}/{len(results)} 通过，{len(fails)} 失败")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
