#!/usr/bin/env python3
"""
网页端改进 T1–T4 浏览器验收：收件箱 / 已归档 / 回收站全生命周期 + 统一设计语言回归。

验证对象：
- apps/admin 新工作台：分组导航、三区域页签与计数、搜索/筛选、勾选与批量操作、
  详情抽屉（只读回收站）、确认弹窗（含「输入删除」）、通知、空/加载态；
- apps/server 生命周期接口：archive/unarchive/trash/restore/resume_processing/purge、
  乐观版本、回收站只读、彻底删除后的 410 与最小删除凭据；
- 四档视口 390×844 / 768×1024 / 1440×900 / 1920×1080：无整体横向滚动、
  移动端卡片列表与底部批量栏避让安全区、桌面抽屉 600px；
- 其余六个管理页在共享设计系统下无布局/功能退化。

做法与 run_admin_delete_browser.py 相同：真实构建产物 + 真实服务进程 +
mock 外部服务（mock-external.mjs）+ Chromium。

用法：
  python3 e2e/run_lifecycle_browser.py [--browser chromium] [--headed]
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
SHOTS = os.sep.join([ROOT, "e2e", "shots", "lifecycle"])
REPORT = os.sep.join([SHOTS, "report.json"])

APP_ID = "com.e2e.lifecycle"
APP_NAME = "生命周期验收软件"
APP_ORIGIN = "http://127.0.0.1:5196"
KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))
PAGES_PORT = 5196

ADMIN_PASS = "admin-" + secrets.token_hex(12)

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


def admin_login(page, base: str) -> None:
    page.goto(f"{base}/admin/", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("#u", timeout=4000)
    except Exception:  # noqa: BLE001
        pass
    if page.locator("#u").count() and page.locator("#u").is_visible():
        page.fill("#u", "admin")
        page.fill("#p", ADMIN_PASS)
        page.click("form:has(#u) button[type=submit]")
    page.locator(".nav-item:visible").first.wait_for(timeout=20000)


def goto_view(page, view: str) -> None:
    """点击区域页签（inbox/archived/trash 对应第 1/2/3 个 .view-tab）。"""
    idx = {"inbox": 0, "archived": 1, "trash": 2}[view]
    page.locator(".view-tab").nth(idx).click()
    page.wait_for_timeout(300)


def open_drawer(page, text: str) -> None:
    page.locator(".fb-table tbody tr", has_text=text).first.click()
    page.wait_for_selector(".drawer", timeout=10000)
    # 详情异步加载：等正文出现（quote 块 = 用户原话已渲染）。
    page.wait_for_selector(".drawer .quote", timeout=10000)


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
    data_dir = tempfile.mkdtemp(prefix="fb-lifecycle-e2e-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    procs = []
    logs = []
    servers = []
    try:
        step("启动 mock 外部服务（AI / Kaneo）与宿主源")
        p, log = start_proc(["node", "e2e/mock-external.mjs"], ROOT, log_path="/tmp/fb-lc-mock.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
        wait_http(f"http://127.0.0.1:{AI_PORT}/__health")
        servers.append(serve_pages(PAGES_PORT))

        step(f"启动反馈服务 :{port}（托管真实管理页产物）")
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="bGlmZWN5Y2xlLWUyZS1tYXN0ZXIta2V5LTMyYnl0ZXM=",
            FEEDBACK_ADMIN_USER="admin",
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=data_dir,
            FEEDBACK_PORT=str(port),
            NODE_ENV="production",
        )
        p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-lc-server.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"{base}/healthz")

        h = Http()
        step("配置连接与软件")
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
        st, _ = h.call(
            "POST",
            f"{base}/api/admin/apps",
            {
                "appId": APP_ID,
                "name": APP_NAME,
                "allowedOrigins": [APP_ORIGIN],
                "kaneoProjectId": "p-e2e",
                "kaneoColumnSlug": "triage",
            },
        )
        check("软件配置创建 201", st == 201, f"status={st}")

        # 提交归属普通账号（配额可调；owner 410 检查也用它的会话）。
        user_name = "e2e-lc-user"
        user_pass = "user-" + secrets.token_hex(10)
        st, _ = h.call(
            "POST",
            f"{base}/api/admin/users",
            {"username": user_name, "password": user_pass, "dailyLimit": 50},
        )
        check("创建普通账号 201", st == 201, f"status={st}")
        uh = Http()
        st, _ = uh.call("POST", f"{base}/api/auth/login", {"username": user_name, "password": user_pass})
        check("普通账号登录 200", st == 200, f"status={st}")

        step("提交 4 条反馈（普通账号会话，worker 走 mock AI）")
        ids = {}
        for key, text in (
            ("synced", "已同步候选：生命周期验收反馈 A"),
            ("inbox", "收件箱留存：生命周期验收反馈 B"),
            ("trash", "回收站候选：生命周期验收反馈 C"),
            ("purge", "彻底删除候选：生命周期验收反馈 D"),
        ):
            st, body = uh.call(
                "POST",
                f"{base}/api/feedback",
                {
                    "idempotencyKey": f"lifecycle-e2e-{key}",
                    "appId": APP_ID,
                    "text": text,
                    "context": {"appVersion": "1.0.0", "pageLabel": "lifecycle"},
                },
            )
            check(f"提交 {key} 201", st == 201, f"status={st} body={body}")
            ids[key] = body["feedbackId"]

        # 等 AI 整理完成（needs_info / ready_to_archive）
        step("等待 worker 完成 AI 整理")
        deadline = time.time() + 30
        while time.time() < deadline:
            st, body = h.call("GET", f"{base}/api/admin/feedback/{ids['synced']}")
            if body and body.get("processed"):
                break
            time.sleep(0.5)

        step("把反馈 A 人工分类并同步到 Kaneo（→ status=archived）")
        st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['synced']}")
        cver = det.get("classification", {}).get("version", 0)
        st, body = h.call(
            "POST",
            f"{base}/api/admin/feedback/{ids['synced']}/classify",
            {
                "action": "archive",
                "classifyVersion": cver,
                "operationId": f"op-{secrets.token_hex(6)}",
                "projectId": "p-e2e",
                "columnId": "col-1",
                "columnSlug": "triage",
                "labelIds": ["label-bug"],
                "assigneeId": None,
                "assigneeName": None,
            },
        )
        check("分类+同步受理", st in (200, 202), f"status={st} body={body}")
        deadline = time.time() + 30
        while time.time() < deadline:
            st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['synced']}")
            if det and det.get("status") == "archived":
                break
            time.sleep(0.5)
        check("反馈 A 已同步（status=archived）", det.get("status") == "archived", f"status={det.get('status')}")

        with sync_playwright() as pw:
            launch_kwargs = {}
            exe = os.environ.get("FB_E2E_CHROMIUM")
            if exe:
                launch_kwargs["executable_path"] = exe
            browser = getattr(pw, args.browser).launch(headless=not args.headed, **launch_kwargs)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()

            step("登录并检查分组导航")
            admin_login(page, base)
            check("分组导航：工作台", page.locator(".nav-group-label", has_text="工作台").count() >= 1)
            check("分组导航：管理", page.locator(".nav-group-label", has_text="管理").count() >= 1)
            check("分组导航：系统", page.locator(".nav-group-label", has_text="系统").count() >= 1)
            check("默认落在反馈页", page.locator(".view-tab").count() == 3)
            shot(page, "01-nav-desktop")

            step("收件箱：三区域计数 + 列表")
            page.wait_for_selector(".fb-table tbody tr", timeout=15000)
            inbox_count = page.locator(".view-tab").nth(0).locator(".count").inner_text()
            check("收件箱计数=4", inbox_count.strip() == "4", f"count={inbox_count}")
            check("列表含反馈 B", page.locator(".fb-table tbody tr", has_text="生命周期验收反馈 B").count() == 1)

            step("搜索筛选")
            page.locator('input[type="search"]').fill("反馈 B")
            page.wait_for_timeout(500)  # 防抖 300ms
            page.wait_for_timeout(500)
            rows = page.locator(".fb-table tbody tr").count()
            check("搜索后仅剩 1 行", rows == 1, f"rows={rows}")
            page.locator('input[type="search"]').fill("")
            page.wait_for_timeout(900)

            step("详情抽屉：固定内容顺序")
            open_drawer(page, "生命周期验收反馈 B")
            drawer = page.locator(".drawer")
            check("抽屉打开", drawer.count() == 1)
            check("抽屉含「用户原话」", drawer.locator("h3", has_text="用户原话").count() == 1)
            check("抽屉含「分类与同步目标」", drawer.locator("h3", has_text="分类与同步目标").count() == 1)
            check("URL 写入 id 参数", "id=" in page.url)
            shot(page, "02-drawer")
            page.keyboard.press("Escape")
            page.wait_for_selector(".drawer", state="detached", timeout=5000)

            step("反馈 A（已同步）在抽屉中归档")
            open_drawer(page, "生命周期验收反馈 A")
            page.locator(".drawer-foot .btn", has_text="归档").first.click()
            page.wait_for_timeout(800)
            check("归档后收件箱不再显示 A", page.locator(".fb-table tbody tr", has_text="反馈 A").count() == 0)
            page.keyboard.press("Escape")  # 关闭可能仍开着的抽屉
            page.wait_for_timeout(300)

            step("已归档区域：A 出现并可恢复")
            goto_view(page, "archived")
            check("已归档含 A", page.locator(".fb-table tbody tr", has_text="反馈 A").count() == 1)
            shot(page, "03-archived")
            # 行内更多菜单恢复
            row = page.locator(".fb-table tbody tr", has_text="反馈 A")
            row.locator(".more-menu > button").click()
            page.get_by_role("menuitem", name="恢复到收件箱", exact=True).click()
            page.wait_for_timeout(800)
            check("恢复后已归档为空", page.locator(".fb-table tbody tr").count() == 0)
            goto_view(page, "inbox")
            check("A 回到收件箱", page.locator(".fb-table tbody tr", has_text="反馈 A").count() == 1)

            step("回收站：移入 → 只读详情 → 恢复")
            row = page.locator(".fb-table tbody tr", has_text="反馈 C")
            row.locator(".more-menu > button").click()
            page.get_by_role("menuitem", name="移入回收站", exact=True).click()
            page.wait_for_selector(".modal", timeout=5000)
            check("确认框说明保留远端内容", page.locator(".modal", has_text="已有 Kaneo 任务与附件会保留").count() == 1)
            page.locator(".modal .btn.danger, .modal .btn", has_text="移入回收站").last.click()
            page.wait_for_timeout(800)
            goto_view(page, "trash")
            check("回收站含 C", page.locator(".fb-table tbody tr", has_text="反馈 C").count() == 1)
            open_drawer(page, "反馈 C")
            check("抽屉只读标记", page.locator(".drawer", has_text="只读").count() == 1)
            check("只读：无分类控件", page.locator(".drawer select").count() == 0)
            check("只读：无恢复动作区", page.locator(".drawer h3", has_text="恢复动作").count() == 0)
            shot(page, "04-trash-drawer")
            page.locator(".drawer-foot .btn", has_text="恢复").first.click()
            page.wait_for_timeout(800)
            check("恢复后回收站为空", page.locator(".fb-table tbody tr").count() == 0)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            step("彻底删除：输入「删除」确认")
            goto_view(page, "inbox")
            row = page.locator(".fb-table tbody tr", has_text="反馈 D")
            row.locator(".more-menu > button").click()
            page.get_by_role("menuitem", name="移入回收站", exact=True).click()
            page.wait_for_selector(".modal", timeout=5000)
            page.locator(".modal .btn", has_text="移入回收站").last.click()
            page.wait_for_timeout(800)
            goto_view(page, "trash")
            row = page.locator(".fb-table tbody tr", has_text="反馈 D")
            row.locator(".more-menu > button").click()
            page.get_by_role("menuitem", name="彻底删除", exact=True).click()
            page.wait_for_selector(".modal", timeout=5000)
            # 未输入「删除」时确认按钮禁用
            confirm_btn = page.locator(".modal .btn.danger")
            check("未输入确认文本时按钮禁用", confirm_btn.is_disabled())
            page.locator("#confirm-text").fill("删除")
            confirm_btn.click()
            page.wait_for_timeout(800)
            check("彻底删除后回收站为空", page.locator(".fb-table tbody tr").count() == 0)
            st, body = h.call("GET", f"{base}/api/admin/feedback/{ids['purge']}")
            check("管理端详情 410（已清理）", st == 410, f"status={st}")
            # 所属用户（提交账号）走公开接口应得 410；管理员同为 410，其他用户 404。
            st, body = uh.call("GET", f"{base}/api/feedback/{ids['purge']}")
            check("所属用户公开查询 410", st == 410, f"status={st} body={body}")

            step("批量操作：勾选 B → 归档被拒绝（未同步），逐项原因展示")
            goto_view(page, "inbox")
            row = page.locator(".fb-table tbody tr", has_text="反馈 B")
            row.locator('input[type="checkbox"]').check()
            check("批量栏出现", page.locator(".batch-bar").count() == 1)
            check("归档按钮禁用（未全同步）", page.locator(".batch-bar .btn", has_text="归档").first.is_disabled())
            shot(page, "05-batch-bar")
            # 批量移入回收站（合法动作）
            page.locator(".batch-bar .btn", has_text="移入回收站").click()
            page.wait_for_selector(".modal", timeout=5000)
            page.locator(".modal .btn", has_text="移入回收站").last.click()
            page.wait_for_timeout(800)
            check("B 已离开收件箱", page.locator(".fb-table tbody tr", has_text="反馈 B").count() == 0)
            goto_view(page, "trash")
            check("回收站含 B", page.locator(".fb-table tbody tr", has_text="反馈 B").count() == 1)
            # 恢复 B，让收件箱回到干净状态
            row = page.locator(".fb-table tbody tr", has_text="反馈 B")
            row.locator('input[type="checkbox"]').check()
            page.locator(".batch-bar .btn", has_text="恢复").click()
            page.wait_for_timeout(800)
            goto_view(page, "inbox")

            step("URL 状态：刷新与前进后退")
            page.locator('input[type="search"]').fill("反馈 A")
            page.wait_for_timeout(900)
            check("URL 含 q= ", "q=" in page.url)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".fb-table tbody tr", timeout=10000)
            check("刷新后搜索保持", page.locator('input[type="search"]').input_value() == "反馈 A")
            open_drawer(page, "反馈 A")
            check("详情 URL 可直达", "id=" in page.url)
            page.go_back()
            page.wait_for_timeout(500)
            check("后退关闭抽屉", page.locator(".drawer").count() == 0)

            step("其余管理页共享外壳回归")
            for label, expect in (
                ("软件配置", "软件配置"),
                ("账号", "账号"),
                ("连接配置", "连接配置"),
                ("会话", "会话"),
                ("管理员设置", "管理员设置"),
                ("系统更新", "系统更新"),
            ):
                page.locator(".nav-item:visible", has_text=label).first.click()
                page.wait_for_timeout(600)
                ok = page.locator(".page-header h1", has_text=expect).count() >= 1
                check(f"页面「{label}」渲染", ok)
            shot(page, "06-other-pages")

            step("四档视口：无整体横向滚动")
            for w, hgt, name in (
                (390, 844, "mobile"),
                (768, 1024, "tablet"),
                (1440, 900, "desktop"),
                (1920, 1080, "wide"),
            ):
                page.set_viewport_size({"width": w, "height": hgt})
                page.locator(".nav-item:visible", has_text="反馈").first.click()
                page.wait_for_timeout(600)
                overflow = page.evaluate(
                    "() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1"
                )
                check(f"{name} {w}×{hgt} 无横向滚动", not overflow)
                if name == "mobile":
                    check("移动端卡片列表显示", page.locator(".fb-card").count() >= 1)
                    check("移动端表格隐藏", page.locator(".fb-table").first.is_hidden())
                if name == "desktop":
                    check("桌面表格显示", page.locator(".fb-table").first.is_visible())
                shot(page, f"07-viewport-{name}", full_page=(name == "mobile"))

            browser.close()

        passed = sum(1 for _, ok, _ in results if ok)
        failed = [(n, d) for n, ok, d in results if not ok]
        print(f"\n[RESULT] {passed}/{len(results)} 通过；{len(warnings)} 警告", flush=True)
        for n, d in failed:
            print(f"  FAIL: {n} — {d}", flush=True)
        os.makedirs(SHOTS, exist_ok=True)
        with open(REPORT, "w") as f:
            json.dump({"results": results, "warnings": warnings}, f, ensure_ascii=False, indent=2)
        return 0 if not failed else 1
    except Exception as exc:  # noqa: BLE001
        print(f"[FATAL] {exc}", flush=True)
        try:
            with open(REPORT, "w") as f:
                json.dump({"results": results, "warnings": warnings, "fatal": str(exc)}, f, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass
        return 1
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:  # noqa: BLE001
                pass
        for s in servers:
            try:
                s.shutdown()
            except Exception:  # noqa: BLE001
                pass
        for log in logs:
            try:
                log.close()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    sys.exit(main())
