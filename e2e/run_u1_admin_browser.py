#!/usr/bin/env python3
"""
U1 独立验证（管理页「系统更新」标签，Chromium 真实驱动）。

做法：
  · 真实反馈服务（apps/server，tsx 启动，全新临时 data 目录）托管真实管理页构建产物
    （apps/admin/dist），并接上一个**本脚本自建的可控 updater 桩**（随机端口）：
    服务端到执行器的协议是真实代码路径，桩只决定「清单内容 / 任务进度 / 是否可达」。
  · Chromium 真实点击「系统更新」标签，覆盖：检查更新、提交更新、进度显示、
    服务重启期间「正在恢复连接」、刷新后按任务 ID 恢复显示、网络异常不被判为更新失败、
    真实 paused 标记触发的暂停横幅、停止跟踪。
  · 容器级的真实升级由 e2e/run_u1_upgrade.py 负责（本脚本不碰 docker）。

用法：
  python3 e2e/run_u1_admin_browser.py
"""

import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADMIN_DIST = os.path.join(ROOT, "apps/admin/dist")
SHOTS = os.path.join(ROOT, "e2e/shots/u1/browser")
REPORT = os.path.join(ROOT, "e2e/shots/u1/browser-report.json")

ADMIN_USER = "admin"
ADMIN_PASS = "u1v-browser-pass-1"
TOKEN = "u1v-browser-token-0123456789abcdef"
DIGEST = "sha256:" + "a" * 64
# 服务端包版本（固定展示值）与「桩清单里可更新的新版本」必须不同，才能走「可更新」路径。
CURRENT_VERSION = "0.3.0"
LATEST_VERSION = "0.4.0"
VERSION = LATEST_VERSION  # 桩清单/提交用的目标版本
OP_ID = "op-browser-" + "".join(random.choice("0123456789abcdef") for _ in range(8))

results = []
defects = []
stub_requests = []


def log(msg=""):
    print(msg, flush=True)


def step(msg):
    print(f"\n=== {msg}", flush=True)


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")


def defect(name, evidence):
    """记录一条**实现缺陷证据**（不计入断言失败，但必须出现在报告与 VERIFICATION.md 里）。"""
    defects.append({"name": name, "evidence": evidence})
    print(f"  [DEFECT] {name}\n           证据：{evidence}", flush=True)


def record(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    return bool(cond)


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_until(fn, timeout=60, interval=0.2, desc="条件"):
    """等待 fn 返回真值。

    注意：异常**不算满足**（异常对象是真值，直接当成功会让等待静默失效）——
    这里把异常记成 last 继续等，超时才抛出并带上最后一次观察。
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            result = fn()
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
        else:
            if result:
                return result
            last = result
        time.sleep(interval)
    raise TimeoutError(f"{desc} 未在 {timeout}s 内满足（最后观察：{last!r}）")


def http(url, method="GET", body=None, headers=None, opener=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    send = opener.open if opener is not None else urllib.request.urlopen
    try:
        with send(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed = json.loads(raw)
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw[:200]}
        return exc.code, parsed, dict(exc.headers)


# --------------------------------------------------------------------------- #
# 可控 updater 桩
# --------------------------------------------------------------------------- #

class StubUpdater:
    def __init__(self):
        self.port = free_port()
        self.task = None
        self.token_ok = None
        self.saw_token = 0
        self.manifest_enabled = True
        self.http = ThreadingHTTPServer(("127.0.0.1", self.port), self._handler())
        self.http.daemon_threads = True
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.http.shutdown()
        self.http.server_close()

    def set_task(self, **fields):
        self.task = {**(self.task or {}), **fields}

    def _manifest(self):
        return {
            "manifestVersion": 1,
            "version": VERSION,
            "commit": "b" * 40,
            "tag": f"v{VERSION}",
            "channel": "stable",
            "services": {
                "feedback": {"image": f"127.0.0.1:5999/u1v-browser@{DIGEST}", "digest": DIGEST},
                "updater": {"image": "ghcr.io/sakuralovesmile/sakura-feedback-updater", "digest": DIGEST},
            },
            "platform": "linux/amd64",
            "dbSchemaVersion": 3,
            "requiredUpdaterProtocol": 1,
            "publishedAt": "2026-09-14T00:00:00Z",
        }

    def _handler(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # 静音
                pass

            def _send(self, obj, status=200):
                payload = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _authorized(self):
                outer.saw_token += 1
                header = self.headers.get("x-updater-token")
                outer.token_ok = header == TOKEN
                return outer.token_ok

            def _body(self):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length).decode() if length else ""
                stub_requests.append({"method": self.command, "path": self.path, "body": raw})
                try:
                    return json.loads(raw) if raw else {}
                except Exception:  # noqa: BLE001
                    return {}

            def do_GET(self):  # noqa: N802
                path = self.path.split("?")[0]
                if path == "/healthz":
                    return self._send({"ok": True, "version": "0.1.0", "protocolVersion": 1, "busy": outer.task is not None and outer.task.get("status") == "running"})
                if not self._authorized():
                    return self._send({"error": "unauthorized"}, 401)
                if path == "/manifest":
                    if not outer.manifest_enabled:
                        return self._send({"error": "manifest_missing"}, 502)
                    return self._send(outer._manifest())
                if path.startswith("/tasks/"):
                    op = path.split("/", 2)[2]
                    if not outer.task or outer.task.get("operationId") != op:
                        return self._send({"error": "not_found"}, 404)
                    return self._send(outer.task)
                return self._send({"error": "not_found"}, 404)

            def do_POST(self):  # noqa: N802
                path = self.path.split("?")[0]
                body = self._body()
                if not self._authorized():
                    return self._send({"error": "unauthorized"}, 401)
                if path == "/tasks":
                    if outer.task and outer.task.get("status") == "running" and outer.task.get("requestId") == body.get("requestId"):
                        return self._send({"operationId": OP_ID, "status": "running", "deduplicated": True}, 202)
                    outer.task = {
                        "operationId": OP_ID,
                        "requestId": body.get("requestId"),
                        "version": body.get("version"),
                        "digest": body.get("digest"),
                        "status": "running",
                        "outcome": None,
                        "phase": "accepted",
                        "phaseLabel": "已受理",
                        "message": "任务已受理，等待执行",
                        "createdAt": "2026-09-14T00:00:00.000Z",
                        "updatedAt": "2026-09-14T00:00:00.000Z",
                        "startedAt": "2026-09-14T00:00:00.000Z",
                        "finishedAt": None,
                        "failure": None,
                        "recoveryHint": None,
                        "warnings": [],
                        "evidence": [],
                    }
                    return self._send({"operationId": OP_ID, "status": "running", "phase": "accepted"}, 202)
                return self._send({"error": "not_found"}, 404)

        return Handler


# --------------------------------------------------------------------------- #
# 真实反馈服务
# --------------------------------------------------------------------------- #

class Server:
    def __init__(self, data_dir, control_dir, port, updater_url, set_update_url=True):
        self.set_update_url = set_update_url
        self.data_dir = data_dir
        self.control_dir = control_dir
        self.port = port
        self.updater_url = updater_url
        self.proc = None
        self.extra_env = {}
        self.log_path = os.path.join(tempfile.gettempdir(), f"u1v-browser-server-{port}.log")

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self):
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="dTF2LWJyb3dzZXItbWFzdGVyLWtleS0zMi1ieXRlcyE=",
            FEEDBACK_ADMIN_USER=ADMIN_USER,
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=self.data_dir,
            FEEDBACK_PORT=str(self.port),
            FEEDBACK_UPDATE_CONTROL_DIR=self.control_dir,
            FEEDBACK_UPDATE_TOKEN_FILE=os.path.join(self.control_dir, "updater-token"),
            **({"FEEDBACK_UPDATE_URL": self.updater_url} if self.set_update_url else {}),
            FEEDBACK_UPDATE_CHECK_INTERVAL_MS="0",
            NODE_ENV="production",
        )
        env.update(self.extra_env)
        logfile = open(self.log_path, "a")
        logfile.write(f"\n===== start port={self.port} =====\n")
        logfile.flush()
        self.proc = subprocess.Popen(
            ["npx", "tsx", "src/index.ts"],
            cwd=os.path.join(ROOT, "apps/server"),
            env=env,
            stdout=logfile,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # npx 会派生真正的 node：必须按进程组收尾
        )
        wait_until(lambda: http(f"{self.base}/healthz", timeout=3)[0] == 200, timeout=90, interval=0.3, desc="反馈服务就绪")

    def stop(self, hard=True):
        if self.proc is None:
            return
        import signal

        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL if hard else signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait(timeout=5)
        self.proc = None
        wait_until(lambda: not port_busy(self.port), timeout=20, interval=0.2, desc="端口释放")

    def log_text(self):
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as handle:
                return handle.read()
        except FileNotFoundError:
            return ""


# --------------------------------------------------------------------------- #
# 浏览器辅助
# --------------------------------------------------------------------------- #

def shot(page, name):
    path = os.path.join(SHOTS, f"{name}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        page.screenshot(path=path, full_page=False)
        log(f"  [shot] {os.path.relpath(path, ROOT)}")
    except Exception as exc:  # noqa: BLE001
        log(f"  [shot!] {name}: {exc}")


def text_of(page, selector):
    loc = page.locator(selector)
    return loc.inner_text() if loc.count() else ""


def visible(page, selector):
    loc = page.locator(selector)
    return loc.count() > 0 and loc.first.is_visible()


def open_tab(page, server):
    page.goto(f"{server.base}/admin/", wait_until="domcontentloaded")
    page.wait_for_selector("#u")
    page.fill("#u", ADMIN_USER)
    page.fill("#p", ADMIN_PASS)
    page.click("form:has(#u) button[type=submit]")
    page.wait_for_selector("nav.tabs", timeout=20000)
    page.click("nav.tabs button:has-text('系统更新')")
    page.wait_for_selector("text=当前版本", timeout=20000)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    log("=== U1 管理页「系统更新」真实浏览器验证 ===")

    if not os.path.exists(os.path.join(ADMIN_DIST, "index.html")):
        step("构建管理页（pnpm --filter @feedback/admin build）")
        proc = subprocess.run(["pnpm", "--filter", "@feedback/admin", "build"], cwd=ROOT, capture_output=True, text=True)
        check("[pre] 管理页构建 exit 0", proc.returncode == 0, proc.stderr[-300:])

    data_dir = tempfile.mkdtemp(prefix="u1v-browser-data-")
    control_dir = tempfile.mkdtemp(prefix="u1v-browser-control-")
    os.makedirs(os.path.join(control_dir, "state", "tasks"), exist_ok=True)
    with open(os.path.join(control_dir, "updater-token"), "w", encoding="utf-8") as handle:
        handle.write(TOKEN + "\n")
    os.chmod(os.path.join(control_dir, "updater-token"), 0o600)

    stub = StubUpdater()
    port = free_port()
    while port_busy(port):
        port = free_port()
    server = Server(data_dir, control_dir, port, stub.base)
    server.start()
    log(f"[INFO] 反馈服务 {server.base}（data={data_dir}，control={control_dir}），updater 桩 {stub.base}")

    step("0. 配置变量名探针（compose 注入名 vs 服务端读取名）")
    probe_port = free_port()
    while port_busy(probe_port):
        probe_port = free_port()
    probe_control = tempfile.mkdtemp(prefix="u1v-browser-probe-")
    with open(os.path.join(probe_control, "updater-token"), "w", encoding="utf-8") as handle:
        handle.write(TOKEN + "\n")
    os.chmod(os.path.join(probe_control, "updater-token"), 0o600)
    # 只按 compose 的方式注入 FEEDBACK_UPDATER_URL（不注入服务端实际读取的 FEEDBACK_UPDATE_URL）
    probe = Server(tempfile.mkdtemp(prefix="u1v-browser-probe-data-"), probe_control, probe_port, stub.base, set_update_url=False)
    probe_env_name = "FEEDBACK_UPDATER_URL"
    probe.extra_env = {probe_env_name: stub.base}
    try:
        probe.start()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        http(f"{probe.base}/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS}, opener=opener)
        status, body, _ = http(f"{probe.base}/api/admin/system/update", "GET", opener=opener)
        reported = (body or {}).get("config", {}).get("updaterBaseUrl")
        record("[browser] 探针服务可用", status == 200, f"{status}")
        if reported == stub.base:
            record(f"[browser] {probe_env_name} 被服务端采纳", True)
        else:
            defect(
                f"compose 注入的 {probe_env_name} 被服务端忽略（服务端读的是 FEEDBACK_UPDATE_URL）",
                f"设置 {probe_env_name}={stub.base} 后，GET /api/admin/system/update 的 config.updaterBaseUrl = {reported}；"
                f"apps/server/src/env.ts:75 读的是 env.FEEDBACK_UPDATE_URL，而 deploy/compose.prod.yml:39 注入的是 FEEDBACK_UPDATER_URL。"
                "默认值 http://updater:8790 恰好与 compose 默认值相同，所以真实部署里这个变量改了也不会生效。",
            )
    finally:
        probe.stop()

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, channel="chrome")
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            try:
                run_browser_steps(page, server, stub, context)
            finally:
                browser.close()
    finally:
        server.stop()
        stub.stop()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    log(f"\n=== U1 管理页验证：{passed}/{len(results)} 项断言通过 ===")
    if defects:
        log(f"发现 {len(defects)} 条实现缺陷（已记录，不计入断言失败）：")
        for d in defects:
            log(f"  [DEFECT] {d['name']}")
    if failed:
        log("失败断言：")
        for name, detail in failed:
            log(f"  - {name}" + (f" — {detail}" if detail else ""))
    with open(REPORT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "total": len(results),
                "passed": passed,
                "failed": [{"assertion": n, "detail": d} for n, d in failed],
                "assertions": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
                "defects": defects,
                "updaterRequests": stub_requests,
                "serverLog": server.log_path,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    log(f"[INFO] 报告：{os.path.relpath(REPORT, ROOT)}；截图：{os.path.relpath(SHOTS, ROOT)}")
    sys.exit(1 if failed else 0)


def run_browser_steps(page, server, stub, context):
    step("1. 打开「系统更新」标签")
    open_tab(page, server)
    body0 = text_of(page, "body")
    record("[browser] 标签页显示当前版本", "当前版本" in body0)
    record(f"[browser] 当前版本显示为真实包版本 {CURRENT_VERSION}（回归：曾显示 0.0.0-unknown）",
           CURRENT_VERSION in body0 and "0.0.0-unknown" not in body0, body0[:160])
    record("[browser] 显示更新执行器「已接入」", "已接入" in text_of(page, "body"))
    record("[browser] 尚未检查过时给出引导", "尚未检查过" in text_of(page, "body"))
    record("[browser] 未检查前不允许提交更新", page.locator("button:has-text('更新到最新稳定版')").is_disabled())
    shot(page, "01-tab-initial")

    step("2. 检查更新（真实 POST /api/admin/system/update/check → updater 桩）")
    page.click("button:has-text('检查更新')")
    page.wait_for_function(
        "() => document.body.innerText.includes('已获取最新版本信息') || document.body.innerText.includes('检查失败')",
        timeout=25000,
    )
    body = text_of(page, "body")
    if "检查失败" in body:
        log("  [debug] 检查失败，页面文本（截断）：\n" + body[:600])
        log("  [debug] 服务端日志尾部：\n" + server.log_text()[-1200:])
        log("  [debug] 桩收到的请求：" + json.dumps(stub_requests, ensure_ascii=False)[:500])
        log(f"  [debug] 桩的令牌校验结果：token_ok={stub.token_ok} saw={stub.saw_token}")
    record("[browser] 检查成功提示", "已获取最新版本信息" in body)
    record("[browser] 展示可更新版本号", LATEST_VERSION in body, body[:200])
    record("[browser] 展示「可更新」标记", "可更新" in body)
    record("[browser] 展示协议兼容行", "兼容" in body)
    record("[browser] 桩收到真实令牌", stub.token_ok is True, f"token_ok={stub.token_ok}")
    shot(page, "02-check-result")

    step("3. 提交更新（真实 POST /api/admin/system/update → 桩 202）")
    check("[browser] 检查后可提交更新", page.locator("button:has-text('更新到最新稳定版')").is_enabled())
    page.click("button:has-text('更新到最新稳定版')")
    page.wait_for_selector(f"text=更新任务已受理：{OP_ID}", timeout=20000)
    record("[browser] 提示已受理并给出任务 ID", f"更新任务已受理：{OP_ID}" in text_of(page, "body"))
    record("[browser] 进度卡显示任务 ID", OP_ID in text_of(page, "body"))
    stored = page.evaluate("() => window.localStorage.getItem('feedback.systemUpdate.operationId')")
    record("[browser] operationId 写入 localStorage", stored == OP_ID, f"stored={stored!r}")
    record("[browser] 提交体只含 requestId/version/digest",
           any(r["path"] == "/tasks" and set(json.loads(r["body"] or "{}").keys()) == {"requestId", "version", "digest"} for r in stub_requests),
           json.dumps([r for r in stub_requests if r["path"] == "/tasks"], ensure_ascii=False)[:300])
    shot(page, "03-accepted")

    step("4. 进度显示：桩推进到 ③保留备份并复制")
    stub.set_task(phase="backup_copy", phaseLabel="③保留备份并复制", message="③保留备份并复制：配置受限副本 + 完整复制数据卷",
                  updatedAt="2026-09-14T00:00:30.000Z")
    wait_until(lambda: "③保留备份并复制" in text_of(page, "body"), timeout=20, interval=0.5, desc="进度阶段刷新")
    record("[browser] 进度阶段实时更新", "③保留备份并复制" in text_of(page, "body"))
    record("[browser] 运行中显示「更新进行中」", "更新进行中" in text_of(page, "body"))
    record("[browser] 说明了暂停写入语义", "update_paused" in text_of(page, "body"))
    shot(page, "04-progress")

    step("5. 服务重启期间：必须显示「正在恢复连接」，不得判为更新失败")
    server.stop()
    wait_until(lambda: "正在恢复连接" in text_of(page, "body"), timeout=30, interval=0.5, desc="恢复连接提示")
    body = text_of(page, "body")
    record("[browser] 重启期间显示「正在恢复连接…」", "正在恢复连接" in body)
    record("[browser] 明确说明「不算更新失败」", "不算" in body and "更新失败" in body)
    record("[browser] 未把不可达判为任务失败", "更新失败，未改动部署" not in body and "需要人工处理" not in body)
    record("[browser] 未清空已跟踪的任务 ID", OP_ID in body or "更新任务" in body)
    shot(page, "05-recovering")
    server.start()

    step("6. 服务恢复后：同一任务继续显示，恢复连接提示消失")
    wait_until(lambda: "正在恢复连接" not in text_of(page, "body"), timeout=30, interval=0.5, desc="恢复连接提示消失")
    record("[browser] 恢复后不再显示恢复连接", "正在恢复连接" not in text_of(page, "body"))
    record("[browser] 恢复后继续显示同一任务", OP_ID in text_of(page, "body"))
    shot(page, "06-recovered")

    step("7. 刷新页面后按任务 ID 恢复显示")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("nav.tabs", timeout=20000)
    page.click("nav.tabs button:has-text('系统更新')")
    wait_until(lambda: OP_ID in text_of(page, "body"), timeout=25, interval=0.5, desc="刷新后任务卡恢复")
    record("[browser] 刷新后自动恢复同一任务", OP_ID in text_of(page, "body"))
    record("[browser] 刷新后仍显示阶段进度", "③保留备份并复制" in text_of(page, "body"))
    shot(page, "07-after-reload")

    step("8. 真实 paused 标记 → 暂停横幅")
    with open(os.path.join(server.control_dir, "paused"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "operationId": OP_ID,
                "requestId": "web-u1v-browser",
                "version": VERSION,
                "digest": DIGEST,
                "phase": "verify_new",
                "message": "新版已启动，等待核验，写入仍暂停",
                "startedAt": "2026-09-14T00:01:00.000Z",
                "updatedAt": "2026-09-14T00:01:00.000Z",
            },
            handle,
            ensure_ascii=False,
        )
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("nav.tabs", timeout=20000)
    page.click("nav.tabs button:has-text('系统更新')")
    wait_until(lambda: "业务写入已暂停" in text_of(page, "body"), timeout=25, interval=0.5, desc="暂停横幅")
    body = text_of(page, "body")
    record("[browser] 暂停横幅出现", "业务写入已暂停" in body)
    record("[browser] 横幅显示执行器写入的阶段", "⑤核验新版" in body, body[:200])
    record("[browser] 横幅显示阶段说明", "新版已启动，等待核验，写入仍暂停" in body)
    shot(page, "08-paused-banner")
    os.remove(os.path.join(server.control_dir, "paused"))

    step("9. 更新成功（终态）")
    stub.set_task(status="succeeded", outcome="succeeded", phase="done", phaseLabel="完成",
                  message="更新完成，已放行 v0.3.0", finishedAt="2026-09-14T00:02:00.000Z",
                  evidence=[{"at": "2026-09-14T00:00:30.000Z", "phase": "backup_copy", "step": "复制原卷到新卷", "ok": True}])
    wait_until(lambda: "更新成功" in text_of(page, "body"), timeout=30, interval=0.5, desc="终态展示")
    record("[browser] 终态显示「更新成功」", "更新成功" in text_of(page, "body"))
    shot(page, "09-succeeded")

    step("10. updater 不可达时的检查：失败但不谎报更新失败")
    stub.manifest_enabled = False
    page.click("button:has-text('检查更新')")
    page.wait_for_selector("text=检查失败", timeout=25000)
    body = text_of(page, "body")
    record("[browser] 不可达时提示检查失败", "检查失败" in body)
    record("[browser] 明确不影响正在运行的服务", "不影响正在运行的服务" in body, body[:200])
    stub.manifest_enabled = True

    step("11. 停止跟踪 → 清空 localStorage")
    page.click("button:has-text('停止跟踪')")
    wait_until(lambda: "已停止在本页跟踪该任务" in text_of(page, "body"), timeout=15, interval=0.3, desc="停止跟踪提示")
    record("[browser] 停止跟踪后不再显示任务卡", OP_ID not in text_of(page, "body"))
    record("[browser] 停止跟踪清空 localStorage",
           page.evaluate("() => window.localStorage.getItem('feedback.systemUpdate.operationId')") is None)
    shot(page, "10-forgotten")

    step("12. 手机视口（390x844）复核标签与进度卡")
    page.set_viewport_size({"width": 390, "height": 844})
    stub.set_task(status="running", outcome=None, phase="start_paused", phaseLabel="④启动验证", message="④启动验证：原子更新环境文件后只重建反馈服务")
    page.evaluate("(op) => window.localStorage.setItem('feedback.systemUpdate.operationId', op)", OP_ID)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("nav.tabs", timeout=20000)
    page.click("nav.tabs button:has-text('系统更新')")
    wait_until(lambda: OP_ID in text_of(page, "body"), timeout=25, interval=0.5, desc="手机视口任务卡")
    record("[browser] 手机视口显示进度与任务 ID", OP_ID in text_of(page, "body") and "④启动验证" in text_of(page, "body"))
    sw = page.evaluate("Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)")
    iw = page.evaluate("window.innerWidth")
    record("[browser] 手机视口无横向溢出", sw <= iw + 1, f"scrollWidth={sw} innerWidth={iw}")
    shot(page, "11-mobile")
    page.set_viewport_size({"width": 1280, "height": 800})

    step("13. 服务端日志不含共享令牌")
    record("[browser] 服务端日志不含 updater 令牌明文", TOKEN not in server.log_text())


if __name__ == "__main__":
    main()
