#!/usr/bin/env python3
"""
T5 独立验证：管理页「删除软件」真实浏览器端到端。

验证对象：
- apps/admin/src/views/AppsView.tsx 的删除交互（确认文案、进行中防重复、
  错误提示与重试、迟到详情响应丢弃、删除成功与刷新失败的区分）；
- apps/server 的软删除 DELETE /api/admin/apps/:id（历史保留、幂等 204、404/401）；
- 删除后同 appId 重新提交 → 新内部记录重新发现（待配置/人工模式），旧反馈仍挂旧记录。

做法：真实构建产物（packages/web/dist + apps/admin/dist）+ 真实服务进程
（tsx src/index.ts）+ mock 外部服务（mock-external.mjs），Chromium 真实驱动。

用法：
  python3 e2e/run_admin_delete_browser.py [--browser chromium] [--headed]
前置：`pnpm -r build`。
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

_THIS_FILE = os.path.abspath(__file__)
ROOT = os.sep.join(_THIS_FILE.split(os.sep)[:-2])
SERVER_DIR = os.sep.join([ROOT, "apps", "server"])
ADMIN_DIST = os.sep.join([ROOT, "apps", "admin", "dist"])
PAGES_DIR = os.sep.join([ROOT, "e2e", "pages"])
SDK_UMD = os.sep.join([ROOT, "packages", "web", "dist", "feedback-web.umd.cjs"])
SHOTS = os.sep.join([ROOT, "e2e", "shots", "admin-delete"])
REPORT = os.sep.join([SHOTS, "report.json"])

APP_ID = "com.e2e.delete-app"
KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))
PAGES_PORT = 5195  # 独占宿主源端口，避免与其他 e2e 脚本撞车

ADMIN_PASS = "admin-" + secrets.token_hex(12)
USER_NAME = "e2e-del-user"
USER_PASS = "user-" + secrets.token_hex(12)

results: list[tuple[str, bool, str]] = []
warnings: list[str] = []


def check(name: str, cond: bool, detail: str = "", soft: bool = False) -> bool:
    if not cond and soft:
        warnings.append(f"{name} — {detail}")
        print(f"  WARN  {name} — {detail}", flush=True)
        return False
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")
    return True


def record(name: str, cond: bool, detail: str = "") -> bool:
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    return bool(cond)


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

    def bytes(self, url: str):
        req = urllib.request.Request(url, method="GET")
        try:
            with self.opener.open(req, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


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
    """/sdk/feedback-web.umd.cjs 映射到 packages/web/dist 的真实产物。"""

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


def panel_text(page) -> str:
    return page.evaluate(
        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
        " return sr ? sr.textContent || '' : ''; }"
    )


def login_and_submit(page, user: str, pw: str, text: str, attach=None):
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


def wait_status_contains(page, needle: str, timeout: float = 30000) -> bool:
    deadline = time.time() + timeout / 1000.0
    while time.time() < deadline:
        if needle in panel_text(page):
            return True
        page.wait_for_timeout(200)
    return False


def admin_login(page, base: str) -> None:
    page.goto(f"{base}/admin/", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("#u", timeout=4000)
    except Exception:  # noqa: BLE001
        pass  # 已有会话：直接落在管理页
    if page.locator("#u").count() and page.locator("#u").is_visible():
        page.fill("#u", "admin")
        page.fill("#p", ADMIN_PASS)
        page.click("form:has(#u) button[type=submit]")
    page.wait_for_selector(".nav-item:visible", timeout=20000)


def open_apps_tab(page) -> None:
    page.locator(".nav-item:visible", has_text="软件配置").first.click()
    # 空列表渲染 EmptyState 而非空表格（新外壳），两者都算加载完成。
    page.wait_for_selector("table, .empty", timeout=15000)


def confirm_dialog(page):
    """共享 ConfirmDialog：等待弹窗、返回正文、点击危险确认按钮。"""
    modal = page.locator(".overlay .modal")
    modal.wait_for(state="visible", timeout=10000)
    text = modal.inner_text()
    modal.locator(".btn.danger").click()
    return text


def app_row(page, app_id: str):
    return page.locator("table tr", has_text=app_id)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    for path, hint in ((ADMIN_DIST, "apps/admin"), (os.path.dirname(SDK_UMD), "packages/web")):
        if not os.path.exists(os.path.join(path, "index.html" if path == ADMIN_DIST else "feedback-web.umd.cjs")):
            print(f"[FATAL] 缺少构建产物 {hint}：请先 `pnpm -r build`", flush=True)
            return 2
    busy = [p for p in (KANEO_PORT, AI_PORT, PAGES_PORT) if port_busy(p)]
    if busy:
        print(f"[FATAL] 端口被占用：{busy}（上次运行残留？）", flush=True)
        return 2

    os.makedirs(SHOTS, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="fb-admin-delete-e2e-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    origin_a = f"http://127.0.0.1:{PAGES_PORT}"
    procs = []
    logs = []
    servers = []
    try:
        step("启动 mock 外部服务（AI / Kaneo）与宿主源")
        p, log = start_proc(["node", "e2e/mock-external.mjs"], ROOT, log_path="/tmp/fb-del-mock.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
        wait_http(f"http://127.0.0.1:{AI_PORT}/__health")
        servers.append(serve_pages(PAGES_PORT))
        wait_http(f"{origin_a}/auto-archive.html")

        step(f"启动反馈服务 :{port}（托管真实管理页产物）")
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="ZGVsZXRlLWUyZS1tYXN0ZXIta2V5LTMyYnl0ZXMh",
            FEEDBACK_ADMIN_USER="admin",
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=data_dir,
            FEEDBACK_PORT=str(port),
            NODE_ENV="production",
        )
        p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-del-server.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"{base}/healthz")

        h = Http()
        step("配置连接与账号")
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
            "POST", f"{base}/api/admin/users", {"username": USER_NAME, "password": USER_PASS, "dailyLimit": 20}
        )
        check("创建普通账号 201", st == 201, f"status={st} body={body}")

        with sync_playwright() as pw:
            browser = None
            last_exc = None
            launch_attempts = (
                [{}, {"channel": "chrome"}, {"channel": "chromium"}]
                if args.browser == "chromium" and not os.environ.get("FB_E2E_CHROMIUM")
                else [{}]
            )
            for kwargs in launch_attempts:
                try:
                    exe = os.environ.get("FB_E2E_CHROMIUM")
                    if exe:
                        kwargs = {**kwargs, "executable_path": exe}
                    browser = getattr(pw, args.browser).launch(headless=not args.headed, **kwargs)
                    print(f"[INFO] {args.browser} launch kwargs={kwargs or 'default'}", flush=True)
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
            if browser is None:
                raise last_exc
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            delete_requests: list[str] = []

            def on_request(req):
                if req.method == "DELETE" and req.url.startswith(base + "/api/admin/apps/"):
                    delete_requests.append(req.url)

            page.on("request", on_request)

            def attach(page):
                if page.locator(".fb-btn-capture").is_visible():
                    page.locator(".fb-btn-capture").click()
                    page.wait_for_timeout(2500)
                with page.expect_file_chooser() as fc_info:
                    page.locator(".fb-btn-add-log").click()
                fc_info.value.set_files(
                    {"name": "app.log", "mimeType": "text/plain", "buffer": b"2026-01-01 INFO del-e2e log\n"}
                )
                page.wait_for_timeout(800)

            # ---------------- A. 带历史的软件 ----------------
            step("A1 组件提交文字 + 截图 + 日志（自动发现软件）")
            page.goto(
                f"{origin_a}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}"
                f"&appId={APP_ID}&appName=E2E%20待删除软件",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            open_panel(page)
            login_and_submit(page, USER_NAME, USER_PASS, "将被删除软件的反馈：含截图与日志", attach)
            check("提交被接收", wait_status_contains(page, "已保存", timeout=60000), panel_text(page)[:200])
            time.sleep(1.5)

            st, body = h.call("GET", f"{base}/api/admin/apps")
            apps = body["apps"]
            check("后台自动发现软件", len(apps) == 1, f"apps={apps}")
            app1 = apps[0]
            app1_id = app1["id"]

            step("A2 人工分类并授权归档 → 产生审计记录与远端任务（更厚重的历史）")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            fid = body["items"][0]["id"]
            st, detail = h.call("GET", f"{base}/api/admin/feedback/{fid}")
            st, arch = h.call(
                "POST",
                f"{base}/api/admin/feedback/{fid}/classify",
                {
                    "action": "archive",
                    "classifyVersion": (detail.get("classification") or {}).get("version", 0),
                    "projectId": "p-e2e",
                    "columnId": "col-1",
                    "columnSlug": "triage",
                    "labelIds": ["label-bug"],
                    "assigneeId": None,
                },
            )
            check("归档授权已受理", st in (200, 202), f"status={st} body={arch}")
            t0 = time.time()
            while time.time() - t0 < 30 and not mock_state("/__mock/tasks")["tasks"]:
                time.sleep(0.5)
            check("反馈已归档到 mock Kaneo（历史含远端任务）", len(mock_state("/__mock/tasks")["tasks"]) == 1, "")

            # ---------------- B. 管理页删除（详情打开中）----------------
            step("B1 管理页登录 → 软件配置 → 打开详情后删除")
            admin_login(page, base)
            open_apps_tab(page)
            app_row(page, APP_ID).locator("button", has_text="配置").click()
            page.wait_for_selector("text=来源确认", timeout=15000)
            check("详情面板已打开", "来源确认" in page.locator("body").inner_text(), "")

            app_row(page, APP_ID).locator("button", has_text="删除").click()
            dialog_text = confirm_dialog(page)
            page.wait_for_timeout(1500)
            shot(page, "01-after-delete")
            check(
                "确认文案说明历史保留与重新出现",
                "历史反馈" in dialog_text and "重新出现" in dialog_text,
                f"dialog={dialog_text[:120]}",
            )
            check("发出且仅发出一个 DELETE", len(delete_requests) == 1, f"delete={delete_requests}")
            body_text = page.locator("body").inner_text()
            check("删除后列表行被移除", APP_ID not in body_text, body_text[:300])
            check("删除后详情面板关闭", "来源确认" not in body_text, body_text[-300:])
            check("出现删除成功提示", "已删除" in body_text and "保留" in body_text, body_text[:400])

            # ---------------- C. 历史保留（API + 页面标记）----------------
            step("C1 历史反馈/截图/日志/审计保留")
            st, body = h.call("GET", f"{base}/api/admin/feedback?appId={APP_ID}")
            items = body["items"]
            check("历史反馈仍在列表", len(items) == 1, f"items={items}")
            check("列表标记软件已删除", items[0].get("appDeleted") is True, f"item={items[0]}")
            check("历史反馈保持已归档状态", items[0]["status"] == "archived", f"status={items[0]['status']}")
            st, detail = h.call("GET", f"{base}/api/admin/feedback/{fid}")
            check("详情可读取且 app.deletedAt 非空", st == 200 and detail["app"]["deletedAt"], f"status={st}")
            check("详情仍关联旧软件行", detail["app"]["id"] == app1_id, f"app={detail['app']}")
            check("截图元数据仍在", bool(detail.get("screenshot")), f"screenshot={detail.get('screenshot')}")
            check("日志元数据仍在", len(detail.get("logs") or []) == 1, f"logs={detail.get('logs')}")
            check("审计记录仍在", len(detail.get("audit") or []) >= 1, f"audit={detail.get('audit')}")
            st, png = h.bytes(f"{base}/api/admin/feedback/{fid}/screenshot")
            check("历史截图字节可读（PNG）", st == 200 and png[:4] == b"\x89PNG", f"status={st} head={png[:8]!r}")
            log_id = detail["logs"][0]["id"]
            st, log_bytes = h.bytes(f"{base}/api/admin/feedback/{fid}/logs/{log_id}/download")
            check("历史日志字节可读", st == 200 and b"del-e2e log" in log_bytes, f"status={st}")

            step("C2 反馈列表页显示「软件已删除」标记")
            page.locator(".nav-item:visible", has_text="反馈").first.click()
            page.wait_for_selector(f"text={APP_ID}", timeout=15000)
            body_text = page.locator("body").inner_text()
            check("反馈列表标记软件已删除", "软件已删除" in body_text, body_text[:400])
            shot(page, "02-feedback-deleted-mark")

            # ---------------- D. 幂等与权限边界（API）----------------
            step("D1 重复删除 204 / 不存在 404 / 未登录 401")
            st, _ = h.call("DELETE", f"{base}/api/admin/apps/{app1_id}")
            check("重复删除返回 204", st == 204, f"status={st}")
            st, _ = h.call("DELETE", f"{base}/api/admin/apps/app-nonexistent")
            check("不存在的软件返回 404", st == 404, f"status={st}")
            anon = Http()
            st, _ = anon.call("DELETE", f"{base}/api/admin/apps/{app1_id}")
            check("未登录删除返回 401", st == 401, f"status={st}")
            st, _ = h.call("PUT", f"{base}/api/admin/apps/{app1_id}", {"expectedRuleVersion": 1, "name": "x"})
            check("已删除软件拒绝配置修改", st == 404, f"status={st}")

            # ---------------- E. 重新发现 ----------------
            step("E1 同 appId 再次有效提交 → 新内部记录")
            page.goto(
                f"{origin_a}/auto-archive.html?apiBase={urllib.parse.quote(base, safe='')}&appId={APP_ID}",
                wait_until="domcontentloaded",
            )
            page.locator("feedback-widget").wait_for(state="attached", timeout=15000)
            open_panel(page)
            login_and_submit(page, USER_NAME, USER_PASS, "删除后再次提交的反馈")
            check("重新提交被接收", wait_status_contains(page, "已保存", timeout=60000), panel_text(page)[:200])
            time.sleep(1.5)
            st, body = h.call("GET", f"{base}/api/admin/apps")
            apps = body["apps"]
            check("重新发现出新的活跃软件", len(apps) == 1, f"apps={apps}")
            app2 = apps[0]
            check("新记录内部 id 不同", app2["id"] != app1_id, f"old={app1_id} new={app2['id']}")
            check(
                "新记录为待配置 + 人工模式（不继承旧配置）",
                app2["configStatus"] == "pending" and app2["archiveMode"] == "manual",
                f"app={app2}",
            )
            st, detail2 = h.call("GET", f"{base}/api/admin/feedback/{fid}")
            check("旧反馈仍关联旧软件行", detail2["app"]["id"] == app1_id, f"app={detail2['app']}")

            # ---------------- F. 进行中防重复（慢响应下双击）----------------
            step("F1 删除进行中按钮禁用：双击只发出一个 DELETE")
            admin_login(page, base)
            open_apps_tab(page)
            held: list = []

            def hold_delete(route):
                req = route.request
                if req.method == "DELETE" and f"/api/admin/apps/{app2['id']}" in req.url:
                    held.append(route)
                    return  # 不响应：请求挂起，制造「删除进行中」
                route.continue_()

            page.route("**/api/admin/apps/*", hold_delete)
            delete_requests.clear()
            delete_btn = app_row(page, APP_ID).locator("button", has_text="删除")
            delete_btn.click()
            confirm_dialog(page)
            page.wait_for_timeout(600)
            deleting_btn = app_row(page, APP_ID).locator("button", has_text="删除中")
            check("进行中按钮变为「删除中…」且禁用", deleting_btn.count() == 1 and deleting_btn.is_disabled(), "")
            # 删除进行中再点一次（按钮已禁用，点击应无效果、也不应再弹确认框）
            deleting_btn.click(force=True)
            page.wait_for_timeout(400)
            check("挂起期间仅发出一个 DELETE", len(delete_requests) == 1, f"delete={delete_requests}")
            check("未弹出第二个确认框", page.locator(".overlay .modal").count() == 0, "")
            held[0].continue_()
            page.unroute("**/api/admin/apps/*")
            page.wait_for_timeout(1200)
            body_text = page.locator("body").inner_text()
            check("挂起释放后删除完成、行移除", APP_ID not in body_text, body_text[:300])

            # ---------------- G. 删除失败可重试 ----------------
            step("G1 删除请求失败 → 错误提示可重试；重试成功")
            st, body = h.call(
                "POST",
                f"{base}/api/admin/apps",
                {"appId": "com.e2e.delete-empty", "name": "空软件", "allowedOrigins": []},
            )
            check("手动新增空软件 201", st == 201, f"status={st} body={body}")
            app3_id = body["id"]
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".nav-item:visible", timeout=20000)
            open_apps_tab(page)
            aborts = {"count": 0}

            def abort_once(route):
                req = route.request
                if req.method == "DELETE" and aborts["count"] == 0:
                    aborts["count"] += 1
                    route.abort()
                    return
                route.continue_()

            page.route("**/api/admin/apps/*", abort_once)
            app_row(page, "com.e2e.delete-empty").locator("button", has_text="删除").click()
            confirm_dialog(page)
            page.wait_for_timeout(1200)
            body_text = page.locator("body").inner_text()
            check("删除失败显示可重试错误", "删除失败" in body_text and "重试" in body_text, body_text[:400])
            check("失败后行仍在列表", "com.e2e.delete-empty" in body_text, "")
            shot(page, "03-delete-failed")
            app_row(page, "com.e2e.delete-empty").locator("button", has_text="删除").click()
            confirm_dialog(page)
            page.wait_for_timeout(1200)
            page.unroute("**/api/admin/apps/*")
            body_text = page.locator("body").inner_text()
            check("重试删除成功、行移除", "com.e2e.delete-empty" not in body_text, body_text[:300])
            check("重试后出现成功提示", "已删除" in body_text, body_text[:400])

            # ---------------- H. 迟到详情响应丢弃 ----------------
            step("H1 删除期间迟到的详情响应不得回写面板")
            st, body = h.call(
                "POST",
                f"{base}/api/admin/apps",
                {"appId": "com.e2e.delete-late", "name": "迟到详情软件", "allowedOrigins": []},
            )
            check("手动新增软件（迟到响应用）201", st == 201, f"status={st} body={body}")
            app4_id = body["id"]
            st, captured = h.call("GET", f"{base}/api/admin/apps/{app4_id}")
            check("预先抓取详情 200", st == 200, f"status={st}")
            held_detail: list = []

            def hold_detail(route):
                req = route.request
                if req.method == "GET" and req.url.endswith(f"/api/admin/apps/{app4_id}"):
                    held_detail.append(route)
                    return
                route.continue_()

            page.route("**/api/admin/apps/*", hold_detail)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".nav-item:visible", timeout=20000)
            open_apps_tab(page)
            app_row(page, "com.e2e.delete-late").locator("button", has_text="配置").click()
            page.wait_for_timeout(600)
            check("详情响应被挂起（面板尚未出现）", "来源确认" not in page.locator("body").inner_text(), "")
            # 详情在途时点同一页面的「删除」：删除成功后迟到的详情响应必须被丢弃
            app_row(page, "com.e2e.delete-late").locator("button", has_text="删除").click()
            confirm_dialog(page)
            page.wait_for_timeout(800)
            held_detail[0].fulfill(status=200, content_type="application/json", body=json.dumps(captured))
            page.unroute("**/api/admin/apps/*")
            page.wait_for_timeout(1000)
            body_text = page.locator("body").inner_text()
            check(
                "迟到详情未回写（无该软件的「来源确认」面板）",
                "来源确认：迟到详情软件" not in body_text,
                body_text[-400:],
            )
            check("迟到响应未触发详情错误提示", "读取软件详情失败" not in body_text, body_text[-300:])
            shot(page, "04-late-detail-discarded")

            # ---------------- I. 删除成功但列表刷新失败 ----------------
            step("I1 删除成功 + 列表刷新失败：提示区分")
            st, body = h.call(
                "POST",
                f"{base}/api/admin/apps",
                {"appId": "com.e2e.delete-refresh", "name": "刷新失败软件", "allowedOrigins": []},
            )
            check("手动新增软件（刷新失败用）201", st == 201, f"status={st} body={body}")
            app5_id = body["id"]
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".nav-item:visible", timeout=20000)
            open_apps_tab(page)
            list_aborts = {"count": 0}

            def fail_list_once(route):
                req = route.request
                # 仅拦列表（GET /api/admin/apps 无尾部 id）
                if req.method == "GET" and req.url.rstrip("/").endswith("/api/admin/apps") and list_aborts["count"] == 0:
                    list_aborts["count"] += 1
                    route.abort()
                    return
                route.continue_()

            page.route("**/api/admin/apps*", fail_list_once)
            app_row(page, "com.e2e.delete-refresh").locator("button", has_text="删除").click()
            confirm_dialog(page)
            page.wait_for_timeout(1500)
            body_text = page.locator("body").inner_text()
            check(
                "删除成功但刷新失败有独立提示",
                "已删除" in body_text and "刷新失败" in body_text,
                body_text[:400],
            )
            check("删除成功的行已被乐观移除", "com.e2e.delete-refresh" not in body_text, "")
            page.unroute("**/api/admin/apps*")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".nav-item:visible", timeout=20000)
            open_apps_tab(page)
            body_text = page.locator("body").inner_text()
            check("手动刷新后列表与服务端一致（无已删软件）", "com.e2e.delete-refresh" not in body_text, "")
            shot(page, "05-refresh-failed")

            # ---------------- J. 空软件删除路径已由 G 覆盖；收尾 ----------------
            real_errors = [e for e in console_errors if "401" not in e and "404" not in e and "Failed to load" not in e]
            record("浏览器控制台无 JS 运行时错误", real_errors == [], f"errors={real_errors[:5]}")
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
    summary = {"total": len(results), "passed": passed, "failed": failed, "dataDir": data_dir, "base": base}
    os.makedirs(SHOTS, exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump({"summary": summary, "results": results, "warnings": warnings}, f, ensure_ascii=False, indent=2)
    print(f"\n[SUMMARY] {passed}/{len(results)} 通过；报告：{REPORT}", flush=True)
    if failed:
        print(f"[FAILED] {failed}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
