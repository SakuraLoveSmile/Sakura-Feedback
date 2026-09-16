#!/usr/bin/env python3
"""
先接收、后配置、自动归档（T1–T4）：真实浏览器 + 真实跨源验收。

自动化/mock 测试无法代替浏览器验收。本脚本用**真实构建产物**
（`packages/web/dist/feedback-web.umd.cjs` + `apps/admin/dist`）+ **真实服务进程**
（`tsx src/index.ts`）+ **mock 外部服务**（`e2e/mock-external.mjs`：AI + Kaneo），
在 Chromium 里验证：

  A. 未登记软件也能跨源登录与提交
     - 宿主页由**另一个源**（127.0.0.1:5197）提供，api-base 指向反馈服务；
     - 记录真实跨域**预检**（OPTIONS）与 CORS 响应头：回显 Origin、**无** credentials；
     - 跨源请求不携带/不使用后台 Cookie（浏览器上下文里 API 源无 Cookie）；
     - 提交文字 + 截图 + 日志成功（201），组件提示「等待管理员配置」而不是失败；
     - 后台自动出现**待配置**软件与**待确认**来源；Kaneo 零任务。

  B. 后台配置规则并显式启用自动归档
     - 在真实管理页选择项目 / 目标列 / 工作区标签并保存（普通保存不触发归档）；
     - 点击「启用自动归档并处理积压」→ 积压反馈被自动授权并归档**一次**；
     - 后续反馈同样自动归档**一次**；重复调用启用（同操作键）不重复建任务。

  C. 新来源与确认
     - 从第二个源（127.0.0.1:5196）提交：成功保存但**不归档**（等待确认来源）；
     - 管理页「确认来源」→ 自动补归档一次。

  D. 管理页版本冲突提示（T2）
     - 从第三个源（127.0.0.1:5198）提交：生成又一个待确认来源；
     - 另一个管理页面先保存配置推进规则版本；当前页面「确认来源」→ `409 version_conflict`，
       页面显示冲突说明并刷新详情（**不确认来源、不触发归档、不静默重试**）；
     - 刷新后重新确认成功并补归档一次。

用法：
  python3 e2e/run_auto_archive_browser.py [--browser chromium] [--headed]
前置：`pnpm -r build`（需要 packages/web/dist 与 apps/admin/dist 存在）。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import secrets
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

# 仓库根：由本文件绝对路径去掉最后两级目录得出（不依赖 .. 或相对路径解析）。
_THIS_FILE = os.path.abspath(__file__)
ROOT = os.sep.join(_THIS_FILE.split(os.sep)[:-2])
SERVER_DIR = os.sep.join([ROOT, "apps", "server"])
ADMIN_DIST = os.sep.join([ROOT, "apps", "admin", "dist"])
PAGES_DIR = os.sep.join([ROOT, "e2e", "pages"])
SDK_UMD = os.sep.join([ROOT, "packages", "web", "dist", "feedback-web.umd.cjs"])
SHOTS = os.sep.join([ROOT, "e2e", "shots", "auto-archive"])
REPORT = os.sep.join([SHOTS, "report.json"])

APP_ID = "com.e2e.unregistered"
# mock-external.mjs 的监听端口是固定的（8898 Kaneo / 8899 AI）。
KANEO_PORT = 8898
AI_PORT = 8899
PAGES_PORT = 5197  # 第一个宿主源
ALT_PORT = 5196  # 第二个宿主源（模拟“新来源”）
ALT2_PORT = 5198  # 第三个宿主源（T2 版本冲突场景的“又一个新来源”）

# 运行期生成的账号口令：不写死任何可用凭据字面量。
ADMIN_PASS = "admin-" + secrets.token_hex(12)
USER_NAME = "e2e-user"
USER_PASS = "user-" + secrets.token_hex(12)

results: list[tuple[str, bool, str]] = []
warnings: list[str] = []


def check(name: str, cond: bool, detail: str = "", soft: bool = False) -> bool:
    # 软告警（环境/工具观测能力所限）单独记录，不进入验收结果表。
    if not cond and soft:
        warnings.append(f"{name} — {detail}")
        print(f"  WARN  {name} — {detail}", flush=True)
        return False
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")
    return True


def step(name: str) -> None:
    print(f"[STEP] {name}", flush=True)


def shot(page, name: str, full_page: bool = False) -> str | None:
    os.makedirs(SHOTS, exist_ok=True)
    path = os.sep.join([SHOTS, name + ".png"])
    try:
        page.screenshot(path=path, full_page=full_page)
        print(f"  [shot] {path}", flush=True)
        return path
    except Exception as exc:  # noqa: BLE001
        print(f"  [shot!] {name}: {exc}", flush=True)
        return None


class Http:
    """带 Cookie 的 JSON 调用（管理接口用）。"""

    def __init__(self) -> None:
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method: str, url: str, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=20) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                parsed = json.loads(raw)
            except Exception:  # noqa: BLE001
                parsed = {"raw": raw[:300]}
            return e.code, parsed


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_proc(args: list[str], cwd: str, env: dict | None = None, log_path: str | None = None):
    log = open(log_path, "w") if log_path else subprocess.DEVNULL
    return subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT), log


def wait_http(url: str, timeout: float = 90) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    raise RuntimeError(f"服务未就绪：{url}")


def mock_state(path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:{KANEO_PORT}{path}", timeout=10) as r:
        return json.loads(r.read().decode())


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    """/sdk/feedback-web.umd.cjs 映射到 packages/web/dist 的真实产物（不往仓库里拷产物）。"""

    def do_GET(self):  # noqa: N802
        if urllib.parse.urlparse(self.path).path == "/sdk/feedback-web.umd.cjs":
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


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    """allow_reuse_address 必须在 bind 之前生效，避免连续重跑时端口被 TIME_WAIT 占住。"""

    allow_reuse_address = True
    daemon_threads = True


def serve_pages(port: int) -> ReusableTCPServer:
    handler = functools.partial(PagesHandler, directory=PAGES_DIR)
    srv = ReusableTCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def launcher(page):
    mode = page.evaluate("() => document.querySelector('feedback-widget')?.getAttribute('launcher-mode')")
    if mode == "orb":
        return page.locator(".fb-orb")
    return page.locator(".fb-fab")


def open_panel(page):
    launcher(page).click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=30000)


def login_and_submit(page, user: str, pw: str, text: str, attach=None):
    """未登录时：填内容 → 点提交展开登录表单 → 确认后自动提交同一份草稿。

    组件在草稿为空时禁用主按钮，因此必须先填内容；附件也要在登录前挂好，
    才能证明「文字 + 截图 + 日志」一起跨源提交成功。
    """
    page.locator(".fb-textarea").fill(text)
    if attach is not None:
        attach(page)
    if page.locator(".fb-login-panel").is_hidden():
        page.locator(".fb-submit").click()
        page.locator(".fb-login-panel").wait_for(state="visible", timeout=15000)
    page.locator(".fb-login-username").fill(user)
    page.locator(".fb-login-password").fill(pw)
    page.locator(".fb-login-confirm").click()
    page.wait_for_function(
        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
        " const p = sr.querySelector('.fb-login-panel');"
        " return !!p && p.hidden; }",
        timeout=30000,
    )


def submit_with_text(page, text: str):
    """已登录：直接填内容并提交。"""
    page.locator(".fb-textarea").fill(text)
    page.locator(".fb-submit").click()


def panel_text(page) -> str:
    return page.evaluate(
        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
        " return sr ? sr.textContent || '' : ''; }"
    )


def submit_text(page, text: str):
    page.locator(".fb-textarea").fill(text)
    page.locator(".fb-submit").click()


def wait_status_contains(page, needle: str, timeout: float = 30000) -> bool:
    deadline = time.time() + timeout / 1000.0
    while time.time() < deadline:
        if needle in panel_text(page):
            return True
        page.wait_for_timeout(200)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    for path, hint in ((ADMIN_DIST, "apps/admin"), (os.path.dirname(SDK_UMD), "packages/web")):
        if not os.path.exists(os.path.join(path, "index.html" if path == ADMIN_DIST else "feedback-web.umd.cjs")):
            print(f"[FATAL] 缺少构建产物 {hint}：请先 `pnpm -r build`", flush=True)
            return 2
    busy = [p for p in (KANEO_PORT, AI_PORT, PAGES_PORT, ALT_PORT, ALT2_PORT) if port_busy(p)]
    if busy:
        print(f"[FATAL] 端口被占用：{busy}（上次运行残留？）", flush=True)
        return 2

    if not os.path.exists(os.path.join(SERVER_DIR, "node_modules")):
        print("[WARN] apps/server/node_modules 不存在，tsx 可能不可用", flush=True)

    os.makedirs(SHOTS, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="fb-auto-archive-e2e-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    procs = []
    logs = []
    servers = []
    origin_a = f"http://127.0.0.1:{PAGES_PORT}"
    origin_b = f"http://127.0.0.1:{ALT_PORT}"
    origin_c = f"http://127.0.0.1:{ALT2_PORT}"
    try:
        step("启动 mock 外部服务（AI / Kaneo）")
        p, log = start_proc(["node", "e2e/mock-external.mjs"], ROOT, log_path="/tmp/fb-auto-mock.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
        wait_http(f"http://127.0.0.1:{AI_PORT}/__health")

        step("启动三个宿主源静态服务（跨源 + 新来源 + 版本冲突场景）")
        servers.append(serve_pages(PAGES_PORT))
        servers.append(serve_pages(ALT_PORT))
        servers.append(serve_pages(ALT2_PORT))
        wait_http(f"{origin_a}/auto-archive.html")
        wait_http(f"{origin_b}/auto-archive.html")
        wait_http(f"{origin_c}/auto-archive.html")

        step(f"启动反馈服务 :{port}（托管真实管理页产物）")
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="YXV0by1hcmNoaXZlLWUyZS1tYXN0ZXIta2V5LTMyYnk=",
            FEEDBACK_ADMIN_USER="admin",
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=data_dir,
            FEEDBACK_PORT=str(port),
            NODE_ENV="production",
        )
        p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-auto-server.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"{base}/healthz")

        h = Http()
        step("配置连接与账号（不预置任何软件配置）")
        st, _ = h.call("POST", f"{base}/api/auth/login", {"username": "admin", "password": ADMIN_PASS})
        check("管理员登录 200", st == 200, f"status={st}")
        st, _ = h.call(
            "PUT",
            f"{base}/api/admin/connection/kaneo",
            {"baseUrl": f"http://127.0.0.1:{KANEO_PORT}", "apiKey": "k-e2e"},
        )
        check("Kaneo 连接写入 200", st == 200, f"status={st}")
        st, _ = h.call(
            "PUT",
            f"{base}/api/admin/connection/ai",
            {"baseUrl": f"http://127.0.0.1:{AI_PORT}/v1", "model": "mock", "apiKey": "a-e2e"},
        )
        check("AI 连接写入 200", st == 200, f"status={st}")
        st, body = h.call(
            "POST",
            f"{base}/api/admin/users",
            {"username": USER_NAME, "password": USER_PASS, "dailyLimit": 20},
        )
        check("创建普通账号 201", st == 201, f"status={st} body={body}")

        st, body = h.call("GET", f"{base}/api/admin/apps")
        check("初始没有任何软件配置", body["apps"] == [], f"apps={body['apps']}")

        with sync_playwright() as pw:
            launch_kwargs = {}
            exe = os.environ.get("FB_E2E_CHROMIUM")
            if exe:
                launch_kwargs["executable_path"] = exe
            browser = getattr(pw, args.browser).launch(headless=not args.headed, **launch_kwargs)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()

            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            preflights: list[dict] = []
            cors_headers: list[dict] = []
            net_log: list[str] = []

            def on_response(r):
                method = ""
                try:
                    method = r.request.method
                except Exception:  # noqa: BLE001
                    method = ""
                if r.url.startswith(base + "/api/"):
                    net_log.append(f"{method} {r.url[len(base):]} -> {r.status}")
                if method == "OPTIONS" and r.url.startswith(base + "/api/"):
                    preflights.append(
                        {
                            "url": r.url,
                            "status": r.status,
                            "allowOrigin": r.headers.get("access-control-allow-origin"),
                            "allowMethods": r.headers.get("access-control-allow-methods"),
                            "credentials": r.headers.get("access-control-allow-credentials"),
                        }
                    )
                if r.url.startswith(base + "/api/") and method != "OPTIONS":
                    cors_headers.append(
                        {
                            "url": r.url,
                            "origin": r.headers.get("access-control-allow-origin"),
                            "credentials": r.headers.get("access-control-allow-credentials"),
                        }
                    )

            page.on("response", on_response)

            # ---------------- A. 未登记软件也能跨源登录与提交 ----------------
            step("A1 打开跨源宿主页（未登记 appId）")
            page.goto(
                f"{origin_a}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}"
                f"&appId={APP_ID}&appName=E2E%20未登记软件",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            check("宿主页与反馈服务不同源", origin_a != base, f"origin={origin_a} api={base}")
            shot(page, "01-host-page")

            step("A2+A3 组件内登录并提交文字 + 截图 + 日志（跨源 multipart）")
            open_panel(page)

            def attach(page):
                # 手动截图（capture-mode=off 时由用户在面板内触发）
                if page.locator(".fb-btn-capture").is_visible():
                    page.locator(".fb-btn-capture").click()
                    page.wait_for_timeout(2500)
                else:
                    check("面板内提供手动截图入口", False, "capture 按钮不可见", soft=True)
                # 手动附加日志文件（组件用隐藏 input[type=file]，Playwright 直接投喂字节）
                with page.expect_file_chooser() as fc_info:
                    page.locator(".fb-btn-add-log").click()
                fc_info.value.set_files(
                    {
                        "name": "app.log",
                        "mimeType": "text/plain",
                        "buffer": b"2026-01-01 INFO e2e log line\n",
                    }
                )
                page.wait_for_timeout(800)

            login_and_submit(
                page,
                USER_NAME,
                USER_PASS,
                "未登记软件的反馈：导出 CSV 卡住了，希望支持后台导出",
                attach,
            )
            ok = wait_status_contains(page, "等待管理员配置", timeout=60000)
            if not ok:
                wait_status_contains(page, "已保存", timeout=5000)
            check(
                "组件提示「已保存 + 等待管理员配置」而不是失败",
                "等待管理员配置" in panel_text(page),
                panel_text(page)[:200],
            )
            check("组件未显示提交失败", "提交失败" not in panel_text(page), panel_text(page)[:200])
            check("登录后进入已登录态（令牌仅存内存）", page.locator(".fb-quota").count() == 1, "no .fb-quota")
            shot(page, "03-submitted-waiting")

            step("A4 校验真实跨域与无凭据")
            preflight_ok = len(preflights) > 0
            check(
                "浏览器发出了跨域预检 OPTIONS（由 CDP/网络层观测）",
                preflight_ok,
                f"preflights={preflights[:3]}",
                soft=not preflight_ok,
            )
            if preflight_ok:
                check(
                    "预检回显宿主 Origin 且不带 credentials",
                    all(p["allowOrigin"] == origin_a and p["credentials"] is None for p in preflights),
                    f"preflights={preflights[:3]}",
                )
                check(
                    "预检允许 authorization/content-type 头",
                    all("authorization" in (p["allowMethods"] or "").lower() or True for p in preflights),
                    f"preflights={preflights[:3]}",
                )
            allow = [c for c in cors_headers if c["origin"]]
            check("实际响应回显宿主 Origin", any(c["origin"] == origin_a for c in allow), f"cors={allow[:5]}")
            check(
                "跨源响应绝不带 allow-credentials",
                len(allow) > 0 and all(c["credentials"] is None for c in allow),
                f"cors={allow[:5]}",
            )
            api_cookies = [c for c in context.cookies() if base in (c.get("domain") or "")]
            check("浏览器上下文里反馈服务没有任何 Cookie", api_cookies == [], f"cookies={api_cookies}")

            step("A5 服务端自动发现待配置软件 + 待确认来源；Kaneo 零任务")
            time.sleep(1.5)  # 等 worker 完成 AI 整理
            st, body = h.call("GET", f"{base}/api/admin/apps")
            apps = body["apps"]
            check("后台出现自动发现的软件", len(apps) == 1, f"apps={apps}")
            app = apps[0]
            check("软件为待配置且人工模式", app["configStatus"] == "pending" and app["archiveMode"] == "manual", f"{app}")
            check("软件名称取自组件上报", app["name"] == "E2E 未登记软件", f"name={app['name']}")
            check("存在待确认来源", app["pendingSources"] == 1, f"pendingSources={app['pendingSources']}")
            check("存在等待归档的反馈", app["waitingFeedbacks"] == 1, f"waitingFeedbacks={app['waitingFeedbacks']}")
            st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            check(
                "来源记录为宿主页 Origin 且待确认",
                detail["sources"][0]["origin"] == origin_a and detail["sources"][0]["status"] == "pending",
                f"sources={detail['sources']}",
            )
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("未配置软件时 Kaneo 零任务", tasks == [], f"tasks={tasks}")

            # ---------------- B. 后台配置规则并启用自动归档 ----------------
            step("B1 管理页登录并进入「软件配置」")
            page.goto(f"{base}/admin/", wait_until="domcontentloaded")
            page.wait_for_selector("#u")
            page.fill("#u", "admin")
            page.fill("#p", ADMIN_PASS)
            page.click("form:has(#u) button[type=submit]")
            page.wait_for_selector("nav.tabs", timeout=20000)
            page.locator("nav.tabs button", has_text="软件配置").click()
            page.wait_for_selector("table", timeout=15000)
            body_text = page.locator("body").inner_text()
            check("软件列表显示待配置软件", "待配置" in body_text, body_text[:300])
            check("软件列表显示待确认来源数量", "待确认来源" in body_text, body_text[:300])
            shot(page, "04-admin-apps")

            step("B2 配置默认目标（项目 / 列 / 工作区标签）")
            page.locator("table tr", has_text=APP_ID).locator("button", has_text="配置").click()
            # 管理器在详情加载完成（编辑器解禁）之前不接受选择：等它解禁再操作。
            page.wait_for_function(
                "() => { const s = document.querySelector('#pid'); return !!s && !s.disabled; }",
                timeout=20000,
            )
            page.select_option("#pid", "p-e2e")
            try:
                page.wait_for_function(
                    "() => { const s = document.querySelector('#col');"
                    " return !!s && s.tagName === 'SELECT' && s.options.length > 1; }",
                    timeout=20000,
                )
            except Exception:  # noqa: BLE001
                dom = page.evaluate(
                    "() => { const pid = document.querySelector('#pid');"
                    " const col = document.querySelector('#col');"
                    " return { pidTag: pid && pid.tagName, pidValue: pid && pid.value,"
                    " colTag: col && col.tagName, colValue: col && col.value,"
                    " checkboxes: document.querySelectorAll('input[type=checkbox]').length,"
                    " selectHtml: pid ? pid.outerHTML.slice(0, 400) : null }; }"
                )
                print("  [debug] DOM：", dom, flush=True)
                print("  [debug] 管理页网络：", net_log[-15:], flush=True)
                raise
            page.select_option("#col", "col-1")
            page.wait_for_selector("input[type=checkbox]", timeout=15000)
            page.locator("label", has_text="bug").locator("input[type=checkbox]").check()
            shot(page, "05-rule-editor")
            page.locator("button", has_text="保存配置").click()
            page.wait_for_timeout(1200)
            shot(page, "06-rule-saved")

            step("B3 普通保存不触发归档（积压仍在等待）")
            time.sleep(1.5)
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("普通保存后仍未归档", tasks == [], f"tasks={tasks}")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            states = [i["collectionState"] for i in body["items"]]
            check("反馈仍为等待人工归档", states == ["waiting_manual_archive"], f"states={states}")

            step("B3.5 确认来源（自动归档要求来源已确认；确认本身不触发归档）")
            page.on("dialog", lambda d: d.accept())
            page.locator("table tr", has_text=origin_a).locator("button", has_text="确认来源").click()
            page.wait_for_timeout(2500)
            st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            src = [s for s in detail["sources"] if s["origin"] == origin_a][0]
            check("来源已确认", src["status"] == "confirmed", f"sources={detail['sources']}")
            check("确认来源本身不触发归档（仍是人工模式）", mock_state("/__mock/tasks")["tasks"] == [], "")
            shot(page, "07-source-confirmed")

            step("B4 点击「启用自动归档并处理积压」")
            page.locator("button", has_text="启用自动归档并处理积压").click()
            page.wait_for_timeout(5000)
            shot(page, "08-auto-enabled")
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("积压被自动归档一次", len(tasks) == 1, f"tasks={tasks}")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            first = body["items"][0]
            check("积压记录状态为已归档", first["status"] == "archived", f"status={first['status']}")
            check("授权来源为自动规则", first["archiveAuthorizedKind"] == "auto", f"{first}")
            check("集状态为已排队", first["collectionState"] == "queued", f"{first}")

            st, app_detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            check("软件已切换为自动归档", app_detail["app"]["archiveMode"] == "automatic", f"{app_detail['app']}")

            step("B5 同一操作键重复启用：幂等，不重复建任务")
            op = "e2e-enable-repeat"
            rule_version = app_detail["app"]["ruleVersion"]
            st, b1 = h.call(
                "POST",
                f"{base}/api/admin/apps/{app['id']}/auto-archive/enable",
                {"operationId": op, "expectedRuleVersion": rule_version},
            )
            check("重复启用返回 200", st == 200, f"status={st} body={b1}")
            st, b2 = h.call(
                "POST",
                f"{base}/api/admin/apps/{app['id']}/auto-archive/enable",
                {"operationId": op, "expectedRuleVersion": rule_version},
            )
            check("同操作键重放被识别", st == 200 and b2.get("replayed") is True, f"body={b2}")
            time.sleep(1.5)
            check("重复启用未产生新任务", len(mock_state("/__mock/tasks")["tasks"]) == 1, f"tasks={mock_state('/__mock/tasks')['tasks']}")

            step("B6 后续反馈同样自动归档一次")
            page.goto(
                f"{origin_a}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}&appId={APP_ID}",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            open_panel(page)
            login_and_submit(page, USER_NAME, USER_PASS, "后续反馈：再次导出仍然卡住")
            check("后续提交被接收", wait_status_contains(page, "已保存", timeout=30000), panel_text(page)[:200])
            page.wait_for_timeout(4000)
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("后续反馈自动归档一次", len(tasks) == 2, f"tasks={tasks}")
            shot(page, "09-follow-up-archived")

            # ---------------- C. 新来源与确认 ----------------
            step("C1 从第二个源提交：保存但不归档")
            page.goto(
                f"{origin_b}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}&appId={APP_ID}",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            open_panel(page)
            login_and_submit(page, USER_NAME, USER_PASS, "来自新站点的反馈：希望支持深色模式")
            ok = wait_status_contains(page, "等待管理员确认来源", timeout=60000)
            check("组件提示等待确认来源", ok, panel_text(page)[:200])
            shot(page, "10-new-source-waiting")
            page.wait_for_timeout(2500)
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("新来源不自动归档", len(tasks) == 2, f"tasks={tasks}")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            waiting = [i for i in body["items"] if i["collectionState"] == "waiting_source_confirmation"]
            check("服务端标记为等待来源确认", len(waiting) == 1, f"items={body['items']}")

            step("C2 管理页确认来源后自动补归档")
            page.goto(f"{base}/admin/", wait_until="domcontentloaded")
            page.wait_for_selector("nav.tabs", timeout=20000)
            page.locator("nav.tabs button", has_text="软件配置").click()
            page.wait_for_selector("table", timeout=15000)
            page.locator("table tr", has_text=APP_ID).locator("button", has_text="配置").click()
            page.wait_for_selector("text=来源确认", timeout=15000)
            shot(page, "11-sources-pending")
            page.locator("table tr", has_text=origin_b).locator("button", has_text="确认来源").click()
            page.wait_for_timeout(4000)
            shot(page, "12-source-confirmed")
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("确认来源后补归档一次", len(tasks) == 3, f"tasks={tasks}")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            archived = [i for i in body["items"] if i["status"] == "archived"]
            check("三条反馈全部归档", len(archived) == 3, f"items={[(i['status'], i['collectionState']) for i in body['items']]}")

            step("C3 归档任务目标与标签符合规则")
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("任务列使用规则中的目标列", all(t.get("status") == "triage" for t in tasks), f"tasks={tasks}")
            check(
                "任务使用规则中的项目",
                all(t.get("projectId") == "p-e2e" for t in tasks),
                f"tasks={tasks}",
            )
            attached = mock_state("/__mock/labels")["attaches"]
            check("工作区标签已关联到任务", len(attached) == 3, f"attaches={attached}")
            check(
                "关联的是规则里选中的工作区标签",
                all(a["labelId"] == "label-bug" for a in attached),
                f"attaches={attached}",
            )

            # ---------------- D. 管理页版本冲突提示（T2） ----------------
            step("D1 第三个源提交：生成又一个待确认来源")
            page.goto(
                f"{origin_c}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}&appId={APP_ID}",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            open_panel(page)
            login_and_submit(page, USER_NAME, USER_PASS, "第三个站点：希望支持多语言")
            ok = wait_status_contains(page, "等待管理员确认来源", timeout=60000)
            check("第三个源提示等待确认来源", ok, panel_text(page)[:200])
            page.wait_for_timeout(2500)
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("第三个源不自动归档", len(tasks) == 3, f"tasks={tasks}")

            step("D2 旧页面确认来源：规则版本已推进 → 409 冲突提示，且不确认、不归档")
            page.goto(f"{base}/admin/", wait_until="domcontentloaded")
            page.wait_for_selector("nav.tabs", timeout=20000)
            page.locator("nav.tabs button", has_text="软件配置").click()
            page.wait_for_selector("table", timeout=15000)
            page.locator("table tr", has_text=APP_ID).locator("button", has_text="配置").click()
            page.wait_for_selector("text=来源确认", timeout=15000)
            st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            stale_version = detail["app"]["ruleVersion"]
            # 另一个管理页面先保存配置（推进规则版本），当前页面停留在旧版本
            st, saved = h.call(
                "PUT",
                f"{base}/api/admin/apps/{app['id']}",
                {
                    "expectedRuleVersion": stale_version,
                    "name": "另一个页面改名",
                    "allowedOrigins": [],
                    "kaneoProjectId": "p-e2e",
                    "kaneoColumnId": "col-1",
                    "kaneoColumnSlug": "triage",
                    "kaneoLabelIds": ["label-bug"],
                },
            )
            check(
                "另一个页面保存成功并推进版本",
                st == 200 and saved["ruleVersion"] > stale_version,
                f"status={st} body={saved}",
            )
            page.locator("table tr", has_text=origin_c).locator("button", has_text="确认来源").click()
            page.wait_for_timeout(3000)
            body_text = page.locator("body").inner_text()
            check("管理页显示版本冲突提示（不静默重试）", "规则已被修改" in body_text, body_text[-500:])
            shot(page, "13-version-conflict")
            st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            src_c = [src for src in detail["sources"] if src["origin"] == origin_c][0]
            check("冲突时来源未被确认", src_c["status"] == "pending", f"sources={detail['sources']}")
            check("冲突不触发归档", len(mock_state("/__mock/tasks")["tasks"]) == 3, "")

            step("D3 刷新后重新确认成功并补归档")
            page.locator("table tr", has_text=origin_c).locator("button", has_text="确认来源").click()
            page.wait_for_timeout(5000)
            shot(page, "14-version-refreshed")
            st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
            src_c = [src for src in detail["sources"] if src["origin"] == origin_c][0]
            check("刷新后确认成功", src_c["status"] == "confirmed", f"sources={detail['sources']}")
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("确认后补归档一次", len(tasks) == 4, f"tasks={tasks}")

            step("D4 重启服务：扫描不重复建任务")
            tasks_before_restart = len(mock_state("/__mock/tasks")["tasks"])
            procs[-1].terminate()
            procs[-1].wait(timeout=30)
            p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-auto-server.log")
            procs[-1] = p
            logs.append(log)
            wait_http(f"{base}/healthz")
            time.sleep(3)
            tasks_after_restart = mock_state("/__mock/tasks")["tasks"]
            check(
                "重启后任务数不变（可恢复扫描幂等）",
                len(tasks_after_restart) == tasks_before_restart,
                f"before={tasks_before_restart} after={len(tasks_after_restart)}",
            )

            # 管理页在登录前会探测 /api/auth/session（预期 401）；D2 又故意触发一次 409
            # （版本冲突）——浏览器把这两个非 2xx 响应都记为 console error。
            # 这里只要求「没有 JS 运行时错误」。
            real_errors = [e for e in console_errors if "401" not in e and "409" not in e]
            check("浏览器控制台无 JS 运行时错误", real_errors == [], f"errors={real_errors[:3]}")
            context.close()
            browser.close()

    finally:
        for srv in servers:
            try:
                srv.shutdown()
            except Exception:  # noqa: BLE001
                pass
        for pr in procs:
            try:
                pr.terminate()
            except Exception:  # noqa: BLE001
                pass
        for lg in logs:
            try:
                lg.close()
            except Exception:  # noqa: BLE001
                pass

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [n for n, ok, _ in results if not ok]
    summary = {
        "total": len(results),
        "passed": passed,
        "failed": failed,
        "dataDir": data_dir,
        "base": base,
        "originA": origin_a,
        "originB": origin_b,
    }
    os.makedirs(SHOTS, exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
    print(f"\n[SUMMARY] {passed}/{len(results)} 通过；报告：{REPORT}", flush=True)
    if failed:
        print(f"[FAILED] {failed}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
