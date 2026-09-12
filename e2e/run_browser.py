#!/usr/bin/env python3
"""
Feedback Web 组件真实浏览器端到端验证（Chromium via Playwright）。

原有场景：加载/呼出/Esc/焦点恢复、草稿保留、超限禁提交、登录握手提交→归档、
AI 失败保留输入与重试、跨域会话恢复（Cookie 静默握手）、窄屏布局、Vue 示例接入。

新增场景（见 e2e/browser_paths.py，宿主页在 e2e/pages/，由本文件托管在 :5189）：
P1 灵感球拖动 → 落点记录/使用 → 截图就是宿主视口（灵感球不在图里）
P2 遮罩：[data-feedback-capture-mask] 与 input[type=password] 在最终 PNG 上的像素级验证
P3 遮挡失败规则：可见敏感区无法遮挡 → 整次截图失败（旧草稿/旧截图保留 + 用户被告知）
P4 登录握手：真实弹窗+postMessage 严格校验的负例（异源 / nonce 不匹配）+ api-base 切换后的凭据隔离
P5 截图区可见性：默认 capture-mode=off 下截图区真的隐藏、且面板里必须有「截取当前页面」入口；
   viewport 模式「移除截图」后回到首个入口并保留文字（[hidden] 级联回归）
P6 默认 off 模式的手动截图：侧边标签打开不自动截图（blob URL 计数为 0）→ 先写文字 →
   点「截取当前页面」→ 有效 PNG / 敏感区遮挡 / 不含组件 UI → 放大 / 重拍 → multipart 提交落库
P7 窄屏(390x844)+键盘：入口可点不溢出、无空白破图占位、Enter 激活截图、焦点不掉到隐藏控件

外部服务全部使用 e2e/mock-external.mjs 模拟。

---------------- 对既有场景做的期望更新（都是「例子/组件已按文档演进、脚本没跟上」）----------------
1) 入口选择器：examples/react 与 examples/vue 现在显式声明
   `launcher-mode="orb" capture-mode="viewport"`（各自 README 与源码注释都写明「组件默认是
   tab/off，这里显式覆盖」）。orb 模式下贴边标签由 `:host([launcher-mode="orb"])
   .fb-tab-launcher{display:none}`（packages/web/src/styles.ts:260）隐藏，所以原来对
   `.fb-fab` 的 `is_visible()` 断言必然为假。改为按 `launcher-mode` 解析真实可见入口
   （`launcher()`），焦点恢复断言也用同一个入口的 class。
2) 呼出时序：`capture-mode="viewport"` 时组件「先截图后开面板」
   （packages/web/README.md §行为摘要），点击入口后面板要等截图完成才可见。
   原来的「点击后立即 is_visible()」改为 `wait_for(state="visible")`（断言不变，只是不再抢跑）。
3) 登录入口：未登录点「提交」时组件在 `submit()` 里直接 `beginLogin(true)` →
   `handshake.openPopup()`（packages/web/src/element.ts:1183/1500），即**第一次点提交就开窗**；
   脚本原来是「先点提交，再点 .fb-login 期待开窗」。另外 `.fb-login-area` 这个类在
   packages/web/** 与两个示例产物里都不存在（只出现在脚本里），组件未登录时是把主按钮
   改成 `.fb-submit.fb-login` 并把状态文案设为「需要登录」（element.ts:1599）。
   因此 T5/T8/T10 改为「点提交 → expect_page → 弹窗内完成登录」，并断言
   「主按钮文案 = 登录并提交」「状态含 需要登录」。
"""

import argparse
import functools
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_paths  # noqa: E402
import png_probe  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = "http://localhost:8787"
SERVER2 = "http://localhost:8788"
ADMIN_USER, ADMIN_PASS = "admin", "e2e-browser-pass-1"
REACT_ORIGIN = "http://localhost:5187"
VUE_ORIGIN = "http://localhost:5188"
PAGES_ORIGIN = "http://localhost:5189"
ATTACKER_ORIGIN = "http://127.0.0.1:5189"
PAGES_DIR = os.path.join(ROOT, "e2e/pages")
SDK_UMD = os.path.join(ROOT, "packages/web/dist/feedback-web.umd.cjs")
APP_ID = "com.example.demo-e2e"

results = []


def step(name):
    print(f"[STEP] {name}", flush=True)


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")


def record(name, ok, detail=""):
    """软断言：记录结果但不中断（用于让单条路径失败不掩盖其余路径）。"""
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


# ---------------- HTTP API（带 cookie，每个服务一份 jar） ----------------

_openers = {}


def _opener(base):
    if base not in _openers:
        _openers[base] = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )
    return _openers[base]


def api(method, path, body=None, origin=None, base=SERVER):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    req.add_header("origin", origin or base)
    try:
        with _opener(base).open(req, timeout=15) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def api_bytes(path, base=SERVER):
    """带 cookie 的二进制 GET（管理端截图）。"""
    req = urllib.request.Request(f"{base}{path}", method="GET")
    with _opener(base).open(req, timeout=20) as r:
        return r.read()


def plain_get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())


def post_json(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


# ---------------- 进程编排 ----------------

def wait_http(url, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.3)
    return False


def start(procs, cmd, cwd=None, env=None, log=None):
    p = subprocess.Popen(
        cmd, cwd=cwd or ROOT, env=env, stdout=log or subprocess.DEVNULL, stderr=subprocess.STDOUT
    )
    procs.append(p)
    return p


def serve_static(directory, port, procs):
    # allow_reuse_address 必须在 bind 之前生效（类属性），否则上一次运行的 TIME_WAIT
    # 会让紧随其后的重跑直接 "Address already in use"。
    code = f"""
import http.server, functools, socketserver
class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory={directory!r})
S(("127.0.0.1", {port}), h).serve_forever()
"""
    return start(procs, [sys.executable, "-c", code])


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    """/sdk/feedback-web.umd.js 映射到 packages/web/dist 的真实产物（不往仓库里拷产物）。"""

    def do_GET(self):  # noqa: N802
        if urllib.parse.urlparse(self.path).path == "/sdk/feedback-web.umd.js":
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


def serve_pages(port, procs):
    handler = functools.partial(PagesHandler, directory=PAGES_DIR)
    srv = ReusableTCPServer(("127.0.0.1", port), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ---------------- 服务配置 ----------------

def configure_service(base, app_ids):
    """返回管理登录状态码；连接与软件配置失败直接断言。"""
    login_status, _ = api("POST", "/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS}, base=base)
    if login_status != 200:
        return login_status
    s, _ = api("PUT", "/api/admin/connection/kaneo", {"baseUrl": "http://127.0.0.1:8898", "apiKey": "k-e2e"}, base=base)
    assert s == 200, s
    s, _ = api("PUT", "/api/admin/connection/ai",
               {"baseUrl": "http://127.0.0.1:8899/v1", "model": "mock", "apiKey": "a-e2e"}, base=base)
    assert s == 200, s
    for app_id, name, origins in app_ids:
        s, _ = api("POST", "/api/admin/apps",
                   {"appId": app_id, "name": name, "allowedOrigins": origins,
                    "kaneoProjectId": "p-e2e", "kaneoColumnSlug": "triage"}, base=base)
        assert s == 201, s
    return login_status


# ---------------- 主流程 ----------------

def _port_busy(port: int) -> bool:
    """端口是否已有监听者（用于启动前预检）。"""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    ap = argparse.ArgumentParser(description="Feedback Web 组件真实浏览器 E2E")
    ap.add_argument(
        "--browser",
        default="chromium",
        choices=("chromium", "firefox", "webkit"),
        help="浏览器引擎；默认 chromium",
    )
    args = ap.parse_args()

    # 预检端口：上一次运行被强杀会留下孤儿进程继续占着 8787/5189 等端口。
    # 若不预检，新服务会 EADDRINUSE 启动失败，请求落到旧实例上，
    # 表现为 configure_service 返回 409（appId 已存在）——看起来像测试失败，实为环境残留。
    busy = [p for p in (8787, 8788, 5187, 5188, 5189, 8898, 8899) if _port_busy(p)]
    if busy:
        print(
            f"[FATAL] 以下端口已被占用，多半是上次运行残留的进程：{busy}\n"
            "        先清理再跑（按端口占用者精确杀，避免误杀无关进程）：\n"
            "        for p in 8787 8788 5187 5188 5189 8898 8899; do "
            'pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t); [ -n "$pid" ] && kill -9 $pid; done',
            flush=True,
        )
        sys.exit(2)

    procs = []
    data_dir = tempfile.mkdtemp(prefix="fb-e2e-")
    data_dir2 = tempfile.mkdtemp(prefix="fb-e2e-b-")
    base_env = dict(os.environ)
    base_env.update(
        FEEDBACK_MASTER_KEY="bG9jYWwtZTJlLW1hc3Rlci1rZXktMzItYnl0ZXMhIQ==",
        FEEDBACK_ADMIN_USER=ADMIN_USER,
        FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
        FEEDBACK_ADMIN_DIST=os.path.join(ROOT, "apps/admin/dist"),
        NODE_ENV="production",
    )
    env = dict(base_env, FEEDBACK_DATA_DIR=data_dir, FEEDBACK_PORT="8787")
    env2 = dict(base_env, FEEDBACK_DATA_DIR=data_dir2, FEEDBACK_PORT="8788")
    shots = os.path.join(ROOT, "e2e/shots")
    os.makedirs(shots, exist_ok=True)
    os.makedirs(PAGES_DIR, exist_ok=True)
    assert os.path.exists(SDK_UMD), f"缺少组件产物：{SDK_UMD}（pnpm --filter @feedback/web build）"

    try:
        step("启动 mock 外部服务 (AI :8899 / Kaneo :8898)")
        start(procs, ["node", "e2e/mock-external.mjs"], log=open("/tmp/fb-e2e-mock.log", "w"))
        assert wait_http("http://127.0.0.1:8899/__health") and wait_http("http://127.0.0.1:8898/__health")

        step("启动反馈服务 (:8787)")
        start(procs, ["npx", "tsx", "src/index.ts"], cwd=os.path.join(ROOT, "apps/server"),
              env=env, log=open("/tmp/fb-e2e-server.log", "w"))
        assert wait_http(f"{SERVER}/healthz", 60), "server 未启动"

        step("启动第二个反馈服务实例 (:8788，用于 api-base 切换后的凭据隔离)")
        start(procs, ["npx", "tsx", "src/index.ts"], cwd=os.path.join(ROOT, "apps/server"),
              env=env2, log=open("/tmp/fb-e2e-server2.log", "w"))
        assert wait_http(f"{SERVER2}/healthz", 60), "server2 未启动"

        step("配置连接与软件")
        s1 = configure_service(SERVER, [
            ("com.example.demo-react", "E2E React", [REACT_ORIGIN]),
            ("com.example.demo-vue", "E2E Vue", [VUE_ORIGIN]),
            (APP_ID, "E2E 宿主页", [PAGES_ORIGIN]),
        ])
        check("管理登录（服务 1 :8787）", s1 == 200, str(s1))
        # 服务 2 只需要 e2e 宿主页的 appId（api-base 切换后的新服务身份）
        s2 = configure_service(SERVER2, [(APP_ID, "E2E 宿主页", [PAGES_ORIGIN])])
        check("管理登录（服务 2 :8788）", s2 == 200, str(s2))

        step("静态托管 React/Vue 示例 (5187/5188) 与 e2e 宿主页 (5189 + SDK 产物映射)")
        serve_static(os.path.join(ROOT, "examples/react/dist"), 5187, procs)
        serve_static(os.path.join(ROOT, "examples/vue/dist"), 5188, procs)
        serve_pages(5189, procs)
        assert wait_http(REACT_ORIGIN) and wait_http(VUE_ORIGIN)
        assert wait_http(f"{PAGES_ORIGIN}/orb.html") and wait_http(f"{ATTACKER_ORIGIN}/attacker.html")
        assert wait_http(f"{PAGES_ORIGIN}/sdk/feedback-web.umd.js")

        step(f"Playwright {args.browser} 场景 · 全量")
        run_browser(shots, kind=args.browser)

    finally:
        for p in procs:
            p.terminate()
        time.sleep(0.5)
        for p in procs:
            p.kill()

    passed = sum(1 for _, okk in results if okk)
    failed = [n for n, okk in results if not okk]
    print(f"\n=== E2E 结果：{passed}/{len(results)} 通过 ===")
    if failed:
        print("失败：", failed)
        sys.exit(1)


def launch_engine(pw, kind):
    """按引擎启动。Chromium 优先用 playwright 自带（系统 python 未装
    chromium_headless_shell 时回退系统 Chrome/Chromium）；firefox/webkit 直接启动。"""
    if kind != "chromium":
        return getattr(pw, kind).launch(headless=True)
    last = None
    for kwargs in ({}, {"channel": "chrome"}, {"channel": "chromium"}):
        try:
            browser = pw.chromium.launch(headless=True, **kwargs)
            print(f"[INFO] chromium launch kwargs={kwargs or 'default'}", flush=True)
            return browser
        except Exception as exc:
            last = exc
    raise last


def run_browser(shots, kind="chromium"):
    with sync_playwright() as pw:
        browser = launch_engine(pw, kind)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()

        def shot(pg, name):
            try:
                pg.screenshot(path=os.path.join(shots, f"{name}.png"))
            except Exception:
                pass

        try:
            scenarios(page, ctx, shot, browser, shots, kind)
        finally:
            browser.close()


def widget(page):
    """shadow 内部件句柄定位（Playwright CSS 自动穿透 open shadow DOM）。"""
    return page.locator("feedback-widget")


def launcher(page):
    """当前宿主页真正可见的入口 + 其 class 关键字。

    orb 模式下贴边标签 `.fb-tab-launcher` 被 `:host([launcher-mode="orb"])` 规则
    display:none（packages/web/src/styles.ts:260），可见入口是灵感球 `.fb-orb`。
    """
    mode = page.evaluate("() => document.querySelector('feedback-widget')?.getAttribute('launcher-mode')")
    if mode == "orb":
        return page.locator(".fb-orb"), "fb-orb"
    return page.locator(".fb-fab"), "fb-fab"


def open_panel(page, timeout=60000):
    """点击入口呼出面板；capture-mode=viewport 的宿主是「先截图后开面板」。"""
    loc, _ = launcher(page)
    loc.click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=timeout)


def wait_form_or_close(popup, timeout=40):
    """登录弹窗：等密码表单出现，或等它自己关掉（有 Cookie 时静默握手）。"""
    form = popup.locator("#login-form")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if form.is_visible():
                return True
            if popup.is_closed():
                return False
        except Exception:
            return False
        time.sleep(0.15)
    return False


def finish_login(popup):
    """在真实登录弹窗里完成登录，返回是否走了密码表单。"""
    popup.wait_for_load_state()
    used_form = wait_form_or_close(popup)
    if used_form:
        popup.locator("#username").fill(ADMIN_USER)
        popup.locator("#password").fill(ADMIN_PASS)
        popup.locator("#submit").click()
    try:
        if not popup.is_closed():
            popup.wait_for_event("close", timeout=30000)
    except Exception:
        pass
    return used_form


def request_body(req):
    """playwright-python 1.58 里 post_data_buffer 是 property（旧版是方法），两者都兼容。"""
    try:
        v = req.post_data_buffer
        return v() if callable(v) else v
    except Exception:
        return None


class FeedbackPosts:
    """记录真实发出的 POST /api/feedback，并可按需制造"提交未到达服务"。

    - 请求体：给 `**/api/feedback` 装一个只读路由（不改请求、只 fallback 放行），
      Playwright 才会把请求体缓冲下来；未被路由的大 multipart 请求
      `post_data_buffer` 只会读到空字节（实测 86KB 上传读回 0 字节）。
    - 中断：T7b 用的网络层失败开关（fail_next），纯浏览器侧行为，不改任何应用代码。
    """

    def __init__(self, ctx):
        self.requests = []
        self.bodies = []
        self.aborted = []
        self.responses = 0
        self.ctx = ctx
        self.webkit = ctx.browser.browser_type.name == "webkit"
        self._fail_next = False
        ctx.on("request", self._on_request)
        ctx.on("response", self._on_response)
        if not self.webkit:
            ctx.route("**/api/feedback", self._handle)

    @property
    def fail_next(self):
        return self._fail_next

    @fail_next.setter
    def fail_next(self, value):
        if self.webkit and value != self._fail_next:
            if value:
                self.ctx.route("**/api/feedback", self._handle)
            else:
                self.ctx.unroute("**/api/feedback", self._handle)
        self._fail_next = value

    @staticmethod
    def _is_submit(r):
        return r.method == "POST" and r.url.startswith(SERVER) and r.url.endswith("/api/feedback")

    def _on_request(self, r):
        if self._is_submit(r):
            self.requests.append(r)
            if self.webkit:
                self.bodies.append({"url": r.url, "ct": r.headers.get("content-type", ""),
                                    "body": request_body(r)})

    def _on_response(self, resp):
        if self._is_submit(resp.request):
            self.responses += 1

    def _handle(self, route):
        req = route.request
        if self._is_submit(req):
            if not self.webkit:
                self.bodies.append({"url": req.url, "ct": req.headers.get("content-type", ""),
                                    "body": request_body(req)})
            if self.fail_next:
                self.aborted.append(req.url)
                route.abort("connectionfailed")
                return
        route.fallback()

    def count(self) -> int:
        return len(self.requests)

    def aborted_count(self) -> int:
        return len(self.aborted)

    def entry(self, idx: int) -> dict:
        return dict(self.bodies[idx])

    def last(self) -> dict:
        return self.entry(-1)


def admin_records(base=SERVER):
    """管理端反馈列表（服务端真实持久化事实）。"""
    status, data = api("GET", "/api/admin/feedback", base=base)
    assert status == 200, status
    return (data or {}).get("items") or []


def submit_body(entry):
    """从请求体里取出 (metadata, screenshot 字节)；JSON 提交没有独立截图字段。"""
    ct = entry.get("ct") or ""
    body = entry.get("body") or b""
    if ct.startswith("application/json"):
        try:
            return json.loads(body.decode()), None
        except Exception:
            return None, None
    parsed = browser_paths.parse_multipart(body, ct)
    meta = None
    if "metadata" in parsed:
        try:
            meta = json.loads(parsed["metadata"].decode())
        except Exception:
            meta = None
    return meta, parsed.get("screenshot")


def scenarios(page, ctx, shot, browser, shots, kind="chromium"):
    # 预签名上传地址 / 资产地址的基址：本套件的服务端跑在宿主 → 必须是 127.0.0.1。
    # run_docker.py（服务端在容器内）会把 mock 切到 http://host.docker.internal:8898，
    # 这里显式切回来，避免两个套件互相污染（mock 是共享的长驻进程）。
    post_json("http://127.0.0.1:8898/__mock/state", {"publicBase": "http://127.0.0.1:8898"})
    # 调试用：E2E_ONLY_PATHS=1 只跑新增路径（默认完整跑 T1–T10 + P1–P4）
    if os.environ.get("E2E_ONLY_PATHS") == "1":
        print("[INFO] E2E_ONLY_PATHS=1：跳过 T1–T10（仅调试用）", flush=True)
    else:
        check_kaneo_reset = plain_get("http://127.0.0.1:8898/__mock/tasks")
        assert check_kaneo_reset == {"tasks": []}
        posts = FeedbackPosts(ctx)

        page.goto(f"{REACT_ORIGIN}/", wait_until="networkidle")

        step("T1 加载与呼出")
        entry, entry_class = launcher(page)
        check("组件注册且入口可见（react 示例声明 launcher-mode=orb → 灵感球）", entry.is_visible(),
              f"entry_class={entry_class}")
        # 旧脚本在这里断言 .fb-fab 可见 → 必然失败：orb 模式下贴边标签被
        # :host([launcher-mode="orb"]) .fb-tab-launcher{display:none} 隐藏（packages/web/src/styles.ts:260）
        check("贴边标签在 orb 模式下按文档隐藏", not page.locator(".fb-fab").is_visible(),
              f"entry_class={entry_class}")
        open_panel(page)
        panel = page.locator(".fb-panel")
        check("面板打开", panel.is_visible())
        focused = page.evaluate("document.querySelector('feedback-widget').shadowRoot.activeElement?.className")
        check("焦点在输入框", focused == "fb-textarea", str(focused))

        step("T2 Esc 关闭与焦点恢复")
        page.keyboard.press("Escape")
        panel.wait_for(state="hidden", timeout=5000)  # 关闭有 300ms 退场动画
        check("Esc 关闭面板", not panel.is_visible())
        focused = page.evaluate("document.querySelector('feedback-widget').shadowRoot.activeElement?.className")
        check(f"焦点恢复入口（{entry_class}）", entry_class in (focused or ""), str(focused))

        step("T3 草稿保留")
        entry.click()
        panel.wait_for(state="visible", timeout=60000)
        page.locator(".fb-textarea").fill("这是草稿内容，不会提交")
        page.keyboard.press("Escape")
        panel.wait_for(state="hidden", timeout=5000)
        entry.click()
        panel.wait_for(state="visible", timeout=60000)
        check("重开后草稿保留", page.locator(".fb-textarea").input_value() == "这是草稿内容，不会提交")
        page.locator(".fb-textarea").fill("")

        step("T4 超限禁提交")
        page.locator(".fb-textarea").fill("字" * 10001)
        check("计数器显示超限", "10001" in page.locator(".fb-counter").inner_text(), page.locator(".fb-counter").inner_text())
        check("提交按钮禁用", page.locator(".fb-submit").is_disabled())
        page.locator(".fb-textarea").fill("")

        step("T5 未登录提交 → 弹窗握手 → 归档")
        text1 = "深色模式下导出 CSV 会卡住，希望支持后台导出"
        page.locator(".fb-textarea").fill(text1)
        # 未登录点「提交」：submit() → beginLogin(true) → handshake.openPopup()（element.ts:1183/1500）
        with ctx.expect_page() as pop_info:
            page.locator(".fb-submit").click()
        popup = pop_info.value
        popup.wait_for_load_state()
        login_btn = page.locator(".fb-login")
        check("未登录时主按钮变为登录入口", login_btn.count() > 0 and login_btn.inner_text().strip() == "登录并提交",
              login_btn.inner_text() if login_btn.count() else "no .fb-login")
        check("状态提示需要登录", "需要登录" in page.locator(".fb-status").inner_text(),
              page.locator(".fb-status").inner_text())
        check("登录弹窗打到 <apiBase>/login", popup.url.startswith(f"{SERVER}/login?"), popup.url)
        used_form = finish_login(popup)
        check("首次登录走密码表单", used_form is True, str(used_form))
        status = page.locator(".fb-status")
        status.wait_for(state="visible")
        # 等「服务已接收」：文档化行为 = 201/200 之后才清空草稿与输入（README §提交流程）。
        # 注意：脚本原来等的是状态文案里出现「已接收」，但组件在 tracking 阶段渲染的是
        # 「已保存，正在整理」（element.ts:1229），docs/api.md:27 写的 received→「已接收」
        # 在组件里根本不存在 —— 见报告里的文档/UI 文案不一致（不在这里替产品改文案）。
        page.wait_for_function(
            "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
            " const ta = sr.querySelector('.fb-textarea');"
            " const st = sr.querySelector('.fb-status');"
            " return ta.value === '' && st.textContent.trim() !== ''; }",
            timeout=30000,
        )
        check("握手后自动提交且清空输入", page.locator(".fb-textarea").input_value() == "")
        page.wait_for_selector(".fb-task-link", timeout=60000)
        link = page.locator(".fb-task-link").get_attribute("href")
        check("归档状态与任务链接", "/dashboard/workspace/ws-e2e/project/p-e2e/task/" in (link or ""), str(link))
        shot(page, "T5-archived")

        step("T6 Kaneo mock 收到的任务契约")
        tasks = plain_get("http://127.0.0.1:8898/__mock/tasks")["tasks"]
        check("收到 1 个任务", len(tasks) == 1, str(len(tasks)))
        t = tasks[0]
        check("列=triage", t.get("status") == "triage", str(t.get("status")))
        check("优先级 no-priority", t.get("priority") == "no-priority", str(t.get("priority")))
        check("不携带负责人/日期字段", set(t.keys()) >= {"title", "description", "priority", "status"} and not (set(t.keys()) & {"userId", "dueDate", "startDate", "milestoneId"}), str(list(t.keys())))
        check("描述含用户原话", text1 in (t.get("description") or ""))
        check("描述含反馈ID标记", "反馈ID" in (t.get("description") or ""))
        check("描述含来源", "E2E React" in (t.get("description") or "") and "com.example.demo-react" in t["description"])
        check("标题为 AI 整理结果", (t.get("title") or "").startswith("E2E整理"), str(t.get("title")))

        step("T7a 服务端 AI 整理失败：原话已保存、绝不重复提交（文档化分支）")
        # 原脚本用 mock AI 500 注入失败，但断言的是 .fb-error-summary/.fb-retry ——
        # 那是「提交未到达服务」的客户端分支（element.ts:1704 分支 4）。
        # 服务端已接收但后台处理失败走的是分支 2（element.ts:1659）：
        # 卡片「原话已保存，后台整理未完成…请勿重复提交」+ 刷新状态/复制标识，
        # 且绝不再次 POST（packages/web/README.md §提交流程、docs/api.md）。见报告。
        post_json("http://127.0.0.1:8899/__mock/state", {"aiFail": True})
        text_ai = "同步功能经常失败，请排查网络重试逻辑"
        page.locator(".fb-textarea").fill(text_ai)
        posts_before_ai = posts.count()
        page.locator(".fb-submit").click()
        # 注意：tracking 阶段（分支 5）的卡片也是 is-warn，必须等分支 2 的独特文案
        page.wait_for_function(
            "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
            " const c = sr.querySelector('.fb-status-card');"
            " return !!c && c.textContent.includes('原话已保存，后台整理未完成'); }",
            timeout=120000,
        )
        card_text = page.locator(".fb-status-card").inner_text()
        check("服务端整理失败时提示原话已保存", "原话已保存" in card_text, card_text[:200])
        check("失败卡片给出反馈标识（可在管理页找回）", "反馈标识" in card_text, card_text[:200])
        check("失败卡片带真实错误详情", "详情：" in card_text, card_text[:200])
        check("服务端失败分支提供「刷新状态」", page.locator(".fb-refresh-btn").count() == 1)
        check("服务端失败分支提供「复制标识」", page.locator(".fb-copy-id-btn").count() == 1)
        check("服务端失败分支不提供「重试提交」（绝不重复提交）", page.locator(".fb-retry").count() == 0)
        check("失败时服务端已收到 1 次提交", posts.count() - posts_before_ai == 1, str(posts.count() - posts_before_ai))
        page.wait_for_timeout(3000)
        check("失败分支不会自动重发（3 秒内无新增提交）", posts.count() - posts_before_ai == 1,
              str(posts.count() - posts_before_ai))
        shot(page, "T7a-server-failed")
        post_json("http://127.0.0.1:8899/__mock/state", {"aiFail": False})

        step("T7b 提交未到达服务 → 保留草稿 → 修复网络后重试 → 归档（同 key 同字节）")
        page.locator(".fb-status-card.is-warn .fb-card-actions button").last.click()  # 再记一条
        page.keyboard.press("Escape")
        page.locator(".fb-panel").wait_for(state="hidden", timeout=5000)
        open_panel(page)  # capture-mode=viewport：呼出时重新截图，让重试带截图字节
        page.wait_for_selector(".fb-screenshot-wrap", timeout=30000)
        text2 = "同步功能经常失败，请排查网络重试逻辑"
        page.locator(".fb-textarea").fill(text2)
        retry_source = page.locator("img.fb-screenshot-thumb").evaluate("""async img => {
            const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
            let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
        }""")
        posts.fail_next = True  # 真实网络层失败：浏览器发出请求但拿不到响应
        posts_before_net = posts.count()
        resp_before_net = posts.responses
        records_before = len(admin_records())
        page.locator(".fb-submit").click()
        page.wait_for_selector(".fb-error-summary", timeout=60000)
        check("提交未到达服务时保留原输入", page.locator(".fb-textarea").input_value() == text2,
              repr(page.locator(".fb-textarea").input_value()))
        check("错误摘要可见（尚未确认保存）", page.locator(".fb-error-summary").inner_text() != "",
              page.locator(".fb-error-summary").inner_text())
        check("提供「重试提交」入口", page.locator(".fb-retry").count() == 1)
        check("该分支确实是客户端失败卡片（未保存）", page.locator(".fb-status-card.is-error").count() == 1)
        check("浏览器确实发出了这次提交（请求已产生，只是被中断）",
              posts.count() - posts_before_net == 1, str(posts.count() - posts_before_net))
        check("该提交没有拿到任何 HTTP 响应（网络层真实失败）",
              posts.responses == resp_before_net, f"{resp_before_net} -> {posts.responses}")
        check("该提交被网络层真实中断（路由层拒绝连接）", posts.aborted_count() == 1, str(posts.aborted_count()))
        check("网络中断的提交没有到达服务（管理端无新记录）",
              len(admin_records()) == records_before, f"{records_before} -> {len(admin_records())}")
        shot(page, "T7b-submit-failed")
        aborted_entry = posts.entry(posts_before_net)
        meta1, shot1 = submit_body(aborted_entry)
        png_probe.dump("T7b 被中断的提交（浏览器请求体）",
                       {"url": aborted_entry["url"], "ct": aborted_entry["ct"],
                        "bodyBytes": len(aborted_entry["body"] or b""), "readErr": aborted_entry.get("err"),
                        "idempotencyKey": (meta1 or {}).get("idempotencyKey"),
                        "screenshotBytes": len(shot1 or b"")})
        check("浏览器真实发出了这次被中断的提交（可读到完整请求体）",
              meta1 is not None and (aborted_entry.get("body") or b""), f"body={len(aborted_entry.get('body') or b'')}B")
        posts.fail_next = False
        posts_before_retry = posts.count()
        page.locator(".fb-retry").click()
        page.wait_for_selector(".fb-task-link", timeout=120000)
        check("重试后归档（共 2 任务）", len(plain_get("http://127.0.0.1:8898/__mock/tasks")["tasks"]) == 2,
              str(len(plain_get("http://127.0.0.1:8898/__mock/tasks")["tasks"])))
        retry = posts.last()
        png_probe.dump("T7b 重试提交（浏览器请求体）",
                       {"url": retry["url"], "ct": retry["ct"], "bodyBytes": len(retry["body"] or b"")})
        meta2, shot2 = submit_body(retry)
        check("重试复用同一幂等键（同 key）", meta1.get("idempotencyKey") == meta2.get("idempotencyKey"),
              f"{meta1.get('idempotencyKey')} vs {meta2.get('idempotencyKey')}")
        retry_row = next(it for it in admin_records()
                         if api("GET", f"/api/admin/feedback/{it['id']}")[1].get("text") == text2)
        retry_png = api_bytes(f"/api/admin/feedback/{retry_row['id']}/screenshot")
        check("重试保存原截图的完整像素（服务端重编码后逐像素一致）",
              browser_paths.same_pixels(png_probe.decode(browser_paths.b64_to_bytes(retry_source)), png_probe.decode(retry_png)))
        check("重试是新增提交（总提交数 +1）", posts.count() - posts_before_retry == 1,
              str(posts.count() - posts_before_retry))
        check("重试成功落库（管理端记录数 +1）", len(admin_records()) == records_before + 1,
              f"{records_before} -> {len(admin_records())}")

        step("T8 跨域会话恢复（刷新后 Cookie 静默握手）")
        page.reload(wait_until="networkidle")
        open_panel(page)
        text3 = "重开软件后的会话恢复验证"
        page.locator(".fb-textarea").fill(text3)
        with ctx.expect_page() as pop_info:
            page.locator(".fb-submit").click()
        popup = pop_info.value
        # 有 cookie：无表单，直接握手并自动关闭
        used_form = finish_login(popup)
        check("恢复会话跳过密码表单", used_form is False, str(used_form))
        page.wait_for_selector(".fb-task-link", timeout=60000)
        tasks = plain_get("http://127.0.0.1:8898/__mock/tasks")["tasks"]
        check("恢复后提交成功（共 3 任务）", len(tasks) == 3, str(len(tasks)))

        step("T9 窄屏全屏布局")
        # T8 结束时面板仍开着（归档态），先关闭避免入口变成 toggle。
        # 注意 Esc 只在焦点位于组件内部时生效（element.ts:1785 的 inside 判定），
        # 登录弹窗关闭后焦点回到宿主页 body，所以这里先把焦点点回面板再按 Esc。
        page.locator(".fb-textarea").click()
        page.keyboard.press("Escape")
        page.locator(".fb-panel").wait_for(state="hidden", timeout=5000)
        page.set_viewport_size({"width": 390, "height": 844})
        open_panel(page)
        page.wait_for_timeout(500)  # 等入场动画结束
        box = page.locator(".fb-panel").bounding_box()
        check("窄屏面板接近全宽", box is not None and box["width"] >= 380, str(box))
        shot(page, "T9-narrow")
        page.keyboard.press("Escape")
        page.set_viewport_size({"width": 1280, "height": 800})

        step("T10 Vue 示例接入")
        vpage = ctx.new_page()
        vpage.goto(f"{VUE_ORIGIN}/", wait_until="networkidle")
        ventry, ventry_class = launcher(vpage)
        check("Vue 示例入口可见（launcher-mode=orb）", ventry.is_visible(), ventry_class)
        ventry.click()
        vpage.locator(".fb-panel").wait_for(state="visible", timeout=60000)
        text4 = "Vue 应用反馈链路验证"
        vpage.locator(".fb-textarea").fill(text4)
        with ctx.expect_page() as pop_info:
            vpage.locator(".fb-submit").click()
        popup = pop_info.value
        used_form = finish_login(popup)
        check("Vue 侧沿用已有 Cookie（无表单静默握手）", used_form is False, str(used_form))
        vpage.wait_for_selector(".fb-task-link", timeout=60000)
        tasks = plain_get("http://127.0.0.1:8898/__mock/tasks")["tasks"]
        check("Vue 链路归档（共 4 任务）", len(tasks) == 4, str(len(tasks)))
        vpage.close()

        # ---------------- P5 截图区可见性（只有真实浏览器能验证） ----------------
        # happy-dom 不做 Shadow DOM 样式级联，单测断言不到 `[hidden]` 是否真的生效。
        step("P5 截图区可见性：默认 capture-mode 与「移除截图」/ 手动入口")

        def shot_region(pg):
            return pg.evaluate("""() => {
              const sr = document.querySelector('feedback-widget').shadowRoot;
              const wrap = sr.querySelector('.fb-screenshot-wrap');
              const img = sr.querySelector('img.fb-screenshot-thumb');
              const r = wrap.getBoundingClientRect();
              const state = (sel) => { const el = sr.querySelector(sel); const b = el.getBoundingClientRect();
                return {hidden: el.hidden, display: getComputedStyle(el).display, disabled: el.disabled,
                        text: (el.textContent || '').trim(), visible: b.width > 0 && b.height > 0}; };
              return {hidden: wrap.hidden, display: getComputedStyle(wrap).display,
                      visible: r.width > 0 && r.height > 0,
                      w: Math.round(r.width), h: Math.round(r.height),
                      imgSrc: img ? img.getAttribute('src') : null,
                      imgNaturalW: img ? img.naturalWidth : 0,
                      brokenImg: !!img && img.complete && img.naturalWidth === 0,
                      capture: state('.fb-btn-capture'),
                      retake: state('.fb-btn-retake'),
                      remove: state('.fb-btn-remove')};
            }""")

        def panel_text(pg):
            return pg.evaluate(
                """() => document.querySelector('feedback-widget').shadowRoot
                     .querySelector('.fb-textarea').value"""
            )

        # P5a：宿主未声明 capture-mode（默认 off）——绝大多数真实宿主的形态
        offpage = ctx.new_page()
        offpage.goto(f"{PAGES_ORIGIN}/off.html", wait_until="networkidle")
        off_entry, off_cls = launcher(offpage)
        check("P5a 默认宿主入口可见（未声明 launcher-mode → 贴边标签）", off_entry.is_visible(), off_cls)
        off_entry.click()
        offpage.locator(".fb-panel").wait_for(state="visible", timeout=60000)
        offpage.wait_for_timeout(800)
        st = shot_region(offpage)
        check(
            "P5a 默认 capture-mode=off：截图区必须真的不可见（[hidden] 生效）",
            (not st["visible"]) and st["display"] == "none",
            str(st),
        )
        check("P5a 默认模式：要么没有截图，要么缩略图能解码（不得「有 src 却加载失败」）",
              st["imgSrc"] is None or st["imgNaturalW"] > 0,
              str(st))
        # 本次修复的缺口：默认 off 表示「关闭自动截图」，不是「没有截图入口」。
        check("P5a 默认 capture-mode=off：面板里必须能看到可用的「截取当前页面」入口",
              st["capture"]["visible"] and not st["capture"]["hidden"]
              and st["capture"]["disabled"] is False and st["capture"]["text"] == "截取当前页面",
              str(st["capture"]))
        check("P5a 无截图时「重新截图 / 移除截图」不得占版面（[hidden] 对按钮同样生效）",
              (not st["retake"]["visible"]) and st["retake"]["display"] == "none"
              and (not st["remove"]["visible"]) and st["remove"]["display"] == "none",
              f"retake={st['retake']} remove={st['remove']}")
        offpage.close()

        # P5b：viewport 模式下点「移除截图」——移除后截图区必须真的隐藏
        vp = ctx.new_page()
        vp.goto(f"{PAGES_ORIGIN}/orb.html", wait_until="networkidle")
        vp_entry, _ = launcher(vp)
        vp_entry.click()
        vp.locator(".fb-panel").wait_for(state="visible", timeout=60000)
        vp.locator("img.fb-screenshot-thumb").wait_for(state="visible", timeout=60000)
        vp.wait_for_timeout(500)
        before = shot_region(vp)
        vp.locator(".fb-textarea").fill("移除截图后文字必须保留")
        vp.locator(".fb-btn-remove").click()
        vp.wait_for_timeout(700)
        after = shot_region(vp)
        check(
            "P5b viewport 模式：移除前缩略图是真图（有 blob src + 解码成功）",
            before["visible"] and str(before["imgSrc"]).startswith("blob:") and before["imgNaturalW"] > 0,
            f"before={before}",
        )
        check(
            "P5b 点「移除截图」后截图区必须真的隐藏（不能只是 hidden=true）",
            (not after["visible"]) and after["display"] == "none",
            f"before={before} after={after}",
        )
        check(
            "P5b 移除后回到首个入口「截取当前页面」（可再次补拍），并保留文字",
            after["capture"]["visible"] and not after["capture"]["hidden"]
            and after["capture"]["text"] == "截取当前页面"
            and after["remove"]["display"] == "none" and after["retake"]["display"] == "none"
            and panel_text(vp) == "移除截图后文字必须保留",
            f"after={after} text={panel_text(vp)!r}",
        )
        vp.close()

    # ---------------- 新增：三条真实浏览器路径 ----------------
    deps = {
        "ctx": ctx,
        "browser": browser,
        "browser_kind": kind,
        "check": check,
        "record": record,
        "step": step,
        "shot": shot,
        "api": api,
        "api_bytes": api_bytes,
        "plain_get": plain_get,
        "pages": PAGES_ORIGIN,
        "attacker": ATTACKER_ORIGIN,
        "service": SERVER,
        "service2": SERVER2,
        "app_id": APP_ID,
        "admin_user": ADMIN_USER,
        "admin_pass": ADMIN_PASS,
        "shots_dir": shots,
        "pages_dir": PAGES_DIR,
        "pixel_results": [],
    }
    browser_paths.run(deps)


if __name__ == "__main__":
    main()
