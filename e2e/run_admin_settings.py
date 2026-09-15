#!/usr/bin/env python3
"""
T2-A 独立验证：管理页「管理员设置」（PATCH /api/admin/me）真实浏览器端到端。

验证对象（只读，不在本脚本内修改任何实现）：
- apps/server/src/routes/admin.ts 的 `PATCH /api/admin/me`
- apps/server/src/db/repos.ts 的 `updateAdminCredentialsInTx`
- apps/admin/src/views/SettingsView.tsx + App.tsx 的「管理员设置」标签与回登录页流程

做法：
1. 真实构建管理页前端（`pnpm --filter @feedback/admin build`），由反馈服务托管 apps/admin/dist；
2. 每个场景一份全新 data 目录 → 启动真实服务（tsx src/index.ts）→ Chromium 真实驱动管理页；
3. 六条路径 × 两个视口（1280x800 桌面 / 390x844 手机）：仅改用户名、仅改密码、同时修改、
   当前密码错误、重名、连续失败触发限流；截图落在 e2e/shots/t2a/<视口>/；
4. 横切断言：窄屏不横向溢出、按钮可点、失败后密码字段清空且用户名草稿保留、成功后回登录页并
   预填新用户名 + 出现重新登录提示、localStorage/sessionStorage 无密码、服务端日志无密码明文、
   重启服务后新凭据可登录/旧凭据不可登录、普通账号 client 令牌不受影响、全部旧会话被撤销。

本脚本只做验证与取证，不修改任何实现文件；发现缺陷只记录并让人工/队长决策。
"""

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "apps/server")
ADMIN_DIST = os.path.join(ROOT, "apps/admin/dist")
SHOTS = os.path.join(ROOT, "e2e/shots/t2a")
REPORT = os.path.join(SHOTS, "report.json")
LOG_DIR = "/tmp"

# 初始账号（每个场景都用全新 data 目录，由此账号引导）
ADMIN_USER = "admin"
ADMIN_PASS = "t2a-admin-pass-1"
# 场景里使用的新凭据
NEW_USERNAME = "t2a-admin-renamed"
NEW_PASS = "T2a-new-pass-2"
# 故意错误/冲突用的值
WRONG_PASS = "T2a-wrong-pass-3"
DUP_USER = "t2a-dup-user"
DUP_PASS = "T2a-dup-pass-4"
# 普通账号（用于 client 令牌不受影响的断言）
CLIENT_USER = "t2a-client-user"
CLIENT_PASS = "T2a-client-pass-5"
APP_ID = "com.example.t2a-admin-settings"
APP_ORIGIN = "http://127.0.0.1:5199"

# 服务端日志里绝不允许出现的明文口令集合（每项都是本次真实使用过的口令）
SECRETS = [ADMIN_PASS, NEW_PASS, WRONG_PASS, DUP_PASS, CLIENT_PASS]

VIEWPORTS = {"desktop": (1280, 800), "mobile": (390, 844)}

results = []  # (name, ok, detail)
scenario_outcomes = []  # {viewport, scenario, ok, detail}


# --------------------------------------------------------------------------- #
# 断言原语
# --------------------------------------------------------------------------- #

def _put(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""), flush=True)


def check(name, cond, detail=""):
    """硬断言：不满足即抛出，中断当前场景。"""
    _put(name, cond, detail)
    if not cond:
        raise AssertionError(f"{name} — {detail}")


def record(name, cond, detail=""):
    """软断言：记录但不中断（用于横切检查，避免一条失败掩盖其余证据）。"""
    _put(name, cond, detail)
    return bool(cond)


def step(name):
    print(f"[STEP] {name}", flush=True)


def shot(page, name, full_page=False):
    path = os.path.join(SHOTS, name + ".png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        page.screenshot(path=path, full_page=full_page)
        print(f"  [shot] {os.path.relpath(path, ROOT)}", flush=True)
        return os.path.relpath(path, ROOT)
    except Exception as exc:  # noqa: BLE001
        print(f"  [shot!] {name}: {exc}", flush=True)
        return None


# --------------------------------------------------------------------------- #
# HTTP 客户端（真实网络请求，cookie 由 CookieJar 维护）
# --------------------------------------------------------------------------- #

class HttpClient:
    def __init__(self, label=""):
        self.label = label
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method, url, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=20) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None), dict(r.headers)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                parsed = json.loads(raw)
            except Exception:  # noqa: BLE001
                parsed = {"raw": raw[:200]}
            return e.code, parsed, dict(e.headers)

    def cookie_header(self):
        for c in self.opener.handlers:
            jar = getattr(c, "cookiejar", None)
            if jar is not None:
                return "; ".join(f"{ck.name}={ck.value}" for ck in jar)
        return ""


def header_of(headers, name):
    for k, v in (headers or {}).items():
        if k.lower() == name.lower():
            return v
    return None


# --------------------------------------------------------------------------- #
# 服务进程
# --------------------------------------------------------------------------- #

class ServerHandle:
    """一个真实反馈服务进程（tsx src/index.ts，托管 apps/admin/dist）。可 stop/start 复用同一 data 目录。"""

    def __init__(self, port, data_dir, log_path, tag):
        self.port = port
        self.data_dir = data_dir
        self.log_path = log_path
        self.tag = tag
        self.proc = None
        self.log = None

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout=90):
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="dDItYS1lMmUtbWFzdGVyLWtleS0zMi1ieXRlcyEh",
            FEEDBACK_ADMIN_USER=ADMIN_USER,
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=self.data_dir,
            FEEDBACK_PORT=str(self.port),
            NODE_ENV="production",
        )
        self.log = open(self.log_path, "a")
        self.log.write(f"\n===== start {self.tag} port={self.port} data={self.data_dir} =====\n")
        self.log.flush()
        self.proc = subprocess.Popen(
            ["npx", "tsx", "src/index.ts"],
            cwd=SERVER_DIR,
            env=env,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"服务进程提前退出（code {self.proc.returncode}），日志：{self.log_path}")
            try:
                with urllib.request.urlopen(f"{self.base}/healthz", timeout=2):
                    return True
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        raise RuntimeError(f"服务 {self.base} 未在 {timeout}s 内就绪，日志：{self.log_path}")

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None
        if self.log is not None:
            self.log.flush()
            self.log.close()
            self.log = None

    def log_text(self):
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                return f.read()
        except FileNotFoundError:
            return ""


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


# --------------------------------------------------------------------------- #
# 管理页驱动
# --------------------------------------------------------------------------- #

class Ctx:
    """场景上下文：浏览器 page/context、当前服务、当前端口、视口。"""

    def __init__(self, page, context, srv, viewport_name, vw):
        self.page = page
        self.context = context
        self.srv = srv
        self.viewport_name = viewport_name
        self.vw = vw
        self.shots = []

    @property
    def base(self):
        return self.srv.base

    def snap(self, name, full_page=False):
        p = shot(self.page, f"{self.viewport_name}/{name}", full_page=full_page)
        if p:
            self.shots.append(p)
        return p

    # ---- 管理页基本动作 ----

    def goto_login(self):
        self.page.goto(f"{self.base}/admin/", wait_until="domcontentloaded")
        self.page.wait_for_selector("#u")
        return self.page.locator("#u").input_value()

    def login(self, username, password, expect_ok=True):
        """在登录页填表并提交；expect_ok=True 时等待进入管理页。"""
        self.page.fill("#u", username)
        self.page.fill("#p", password)
        self.page.click("form:has(#u) button[type=submit]")
        if expect_ok:
            self.page.wait_for_selector("nav.tabs", timeout=15000)
        else:
            self.page.wait_for_selector("p.err", timeout=15000)
            return self.page.locator("p.err").inner_text()

    def open_settings(self):
        self.page.click("nav.tabs button:has-text('管理员设置')")
        self.page.wait_for_selector("#me-username")
        self.page.wait_for_function(
            "() => { const el = document.querySelector('#me-username'); return !!el && el.value.length > 0; }",
            timeout=15000,
        )
        return self.page.locator("#me-username").input_value()

    def save(self):
        self.page.click("form:has(#me-username) button[type=submit]")

    def wait_err(self, contains, timeout=15000):
        self.page.wait_for_function(
            "(m) => { const e = document.querySelector('p.err'); return !!e && e.textContent.includes(m); }",
            arg=contains,
            timeout=timeout,
        )
        return self.page.locator("p.err").inner_text()

    def wait_login_page(self, timeout=15000):
        """等待回到登录页（保存成功后 App 切到未登录态）。"""
        self.page.wait_for_selector("form:has(#u)", timeout=timeout)
        self.page.wait_for_selector("nav.tabs", state="detached", timeout=timeout)

    def values(self):
        return {
            "username": self.page.locator("#me-username").input_value(),
            "current": self.page.locator("#me-current").input_value(),
            "new": self.page.locator("#me-new").input_value(),
            "confirm": self.page.locator("#me-confirm").input_value(),
        }

    # ---- 横切断言 ----

    def assert_layout(self, label):
        sw = self.page.evaluate("Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)")
        iw = self.page.evaluate("window.innerWidth")
        record(f"{label} 无横向溢出（scrollWidth={sw} <= innerWidth={iw}）", sw <= iw + 1, f"scrollWidth={sw} innerWidth={iw}")
        viewport_w = iw
        for sel in ("#me-username", "#me-current", "#me-new", "#me-confirm"):
            box = self.page.locator(sel).bounding_box()
            ok = bool(box) and box["x"] >= -1 and (box["x"] + box["width"]) <= viewport_w + 1
            record(f"{label} 输入框 {sel} 在视口内", ok, f"box={box} viewport={viewport_w}")
        btn = self.page.locator("form:has(#me-username) button[type=submit]")
        box = btn.bounding_box()
        record(
            f"{label} 保存按钮可见/可用/在视口内",
            btn.is_visible() and btn.is_enabled() and bool(box) and box["x"] >= -1 and (box["x"] + box["width"]) <= viewport_w + 1,
            f"visible={btn.is_visible()} enabled={btn.is_enabled()} box={box}",
        )

    def assert_no_secret_in_storage(self, label):
        dump = self.page.evaluate(
            "() => { const o = {local:{}, session:{}};"
            " for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o.local[k]=localStorage.getItem(k);}"
            " for (let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i); o.session[k]=sessionStorage.getItem(k);}"
            " return JSON.stringify(o); }"
        )
        for secret in SECRETS:
            record(f"{label} storage 不含口令 {secret[:4]}***", secret not in dump)
        record(f"{label} storage 的键名不含 password/token/secret", not re.search(r"pass|token|secret", dump, re.I))
        for secret in SECRETS:
            record(f"{label} URL 不含口令 {secret[:4]}***", secret not in self.page.url)
        return dump

    def assert_secrets_absent_from_log(self, label):
        text = self.srv.log_text()
        for secret in SECRETS:
            record(f"{label} 服务端日志不含口令明文 {secret[:4]}***", secret not in text)


# --------------------------------------------------------------------------- #
# 场景公共：普通账号 client 令牌（Bearer）链路
# --------------------------------------------------------------------------- #

def setup_client_token(base):
    """在服务端建立普通账号 + 应用配置，并签发一个 client 令牌。返回 token 或 None。"""
    admin = HttpClient("admin-setup")
    status, body, _ = admin.call("POST", f"{base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    if status != 200:
        return None, f"管理员 API 登录失败 {status} {body}"
    status, body, _ = admin.call(
        "POST",
        f"{base}/api/admin/apps",
        {
            "appId": APP_ID,
            "name": "T2A 令牌检查",
            "allowedOrigins": [APP_ORIGIN],
            "kaneoProjectId": "p-t2a",
            "kaneoColumnSlug": "triage",
        },
    )
    if status not in (201, 409):
        return None, f"建应用失败 {status} {body}"
    status, body, _ = admin.call(
        "POST",
        f"{base}/api/admin/users",
        {"username": CLIENT_USER, "password": CLIENT_PASS, "dailyLimit": 50},
    )
    if status not in (201, 409):
        return None, f"建普通账号失败 {status} {body}"
    status, body, _ = admin.call(
        "POST",
        f"{base}/api/auth/login",
        {"username": CLIENT_USER, "password": CLIENT_PASS, "clientLabel": "t2a-client", "appId": APP_ID},
        headers={"Origin": APP_ORIGIN},
    )
    if status != 200 or not isinstance(body, dict) or "token" not in body:
        return None, f"签发 client 令牌失败 {status} {body}"
    return body["token"], None


def bearer_session(base, token):
    hc = HttpClient("bearer")
    return hc.call("GET", f"{base}/api/auth/session", headers={"Authorization": f"Bearer {token}"})


def assert_client_token_ok(label, base, token):
    status, body, _ = bearer_session(base, token)
    ok = status == 200 and isinstance(body, dict) and (body.get("user") or {}).get("username") == CLIENT_USER
    record(f"{label} 普通账号 client 令牌仍可用（{CLIENT_USER}）", ok, f"status={status} body={body}")
    return ok


# --------------------------------------------------------------------------- #
# 六条路径
# --------------------------------------------------------------------------- #

def check_static():
    """版本与文档收口（静态断言，均为只读检查）。"""
    step("静态断言：版本 0.2.1 与文档契约")
    for rel in ("package.json", "apps/server/package.json", "apps/admin/package.json", "packages/web/package.json"):
        path = os.path.join(ROOT, rel)
        try:
            with open(path, encoding="utf-8") as f:
                version = json.load(f).get("version")
        except Exception as exc:  # noqa: BLE001
            version = f"读取失败：{exc}"
        record(f"[静态] {rel} 版本为 0.2.1", version == "0.2.1", f"version={version!r}")

    with open(os.path.join(ROOT, "docs/api.md"), encoding="utf-8") as f:
        api_doc = f.read()
    record("[静态] docs/api.md 含 PATCH /api/admin/me 契约", "`PATCH /api/admin/me`" in api_doc)
    for token, desc in (
        ("invalid_current_password", "当前密码错误码"),
        ("user_exists", "重名错误码"),
        ("rate_limited", "限流错误码"),
        ("Retry-After", "Retry-After 头"),
        ("reauthenticate", "成功响应字段"),
    ):
        record(f"[静态] docs/api.md 记录 {desc}（{token}）", token in api_doc)

    with open(os.path.join(ROOT, "docs/deployment.md"), encoding="utf-8") as f:
        dep_doc = f.read()
    stale = [ln for ln in dep_doc.splitlines() if ("重建数据库" in ln and "无需重建数据库" not in ln)]
    record("[静态] docs/deployment.md 不再要求「重建数据库」改密", not stale, f"stale={stale}")
    record("[静态] docs/deployment.md 指向后台「管理员设置」", "管理员设置" in dep_doc)


def scenario_username_only(c):
    """仅改用户名：新密码留空。"""
    label = f"[{c.viewport_name}/仅改用户名]"
    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    prefilled = c.open_settings()
    check(f"{label} 用户名预填当前账号", prefilled == ADMIN_USER, f"prefilled={prefilled!r}")
    c.assert_layout(f"{label} 设置页")
    c.snap("01-username-only-settings", full_page=True)

    c.page.fill("#me-username", NEW_USERNAME)
    c.page.fill("#me-current", ADMIN_PASS)
    c.snap("02-username-only-filled")
    c.save()
    c.wait_login_page()
    notice = c.page.locator(".ok-text").inner_text() if c.page.locator(".ok-text").count() else ""
    check(f"{label} 回登录页并出现重新登录提示", "凭据已更新，请重新登录" in notice, f"notice={notice!r}")
    check(f"{label} 登录页用户名已预填新用户名", c.page.locator("#u").input_value() == NEW_USERNAME,
          f"value={c.page.locator('#u').input_value()!r}")
    c.assert_no_secret_in_storage(label)
    c.snap("03-username-only-login-prefilled")

    err = c.login(ADMIN_USER, ADMIN_PASS, expect_ok=False)
    check(f"{label} 旧用户名不可登录", "用户名或密码错误" in err, f"err={err!r}")
    c.snap("04-username-only-old-login-rejected")
    c.login(NEW_USERNAME, ADMIN_PASS)
    check(f"{label} 新用户名 + 旧密码可登录（只改了用户名）", c.page.locator("nav.tabs").is_visible())
    c.snap("05-username-only-new-login-ok")
    c.assert_secrets_absent_from_log(label)


def scenario_password_only(c):
    """仅改密码：用户名输入框保持当前用户名。"""
    label = f"[{c.viewport_name}/仅改密码]"
    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    prefilled = c.open_settings()
    check(f"{label} 用户名预填当前账号", prefilled == ADMIN_USER, f"prefilled={prefilled!r}")
    c.assert_layout(f"{label} 设置页")

    token, err = setup_client_token(c.base)
    check(f"{label} 预先签发普通账号 client 令牌", token is not None, str(err))
    assert_client_token_ok(f"{label} 改动前", c.base, token)

    # 另开一个管理员 cookie 会话，用于断言「全部会话（不止当前）被撤销」
    other = HttpClient("admin-other-session")
    st, _, _ = other.call("POST", f"{c.base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    check(f"{label} 第二个管理员 cookie 会话建立", st == 200, f"status={st}")
    browser_cookie = "; ".join(f"{k['name']}={k['value']}" for k in c.context.cookies())

    c.page.fill("#me-current", ADMIN_PASS)
    c.page.fill("#me-new", NEW_PASS)
    c.page.fill("#me-confirm", NEW_PASS)
    c.snap("01-password-only-filled")
    c.save()
    c.wait_login_page()
    notice = c.page.locator(".ok-text").inner_text() if c.page.locator(".ok-text").count() else ""
    check(f"{label} 回登录页并出现重新登录提示", "凭据已更新，请重新登录" in notice, f"notice={notice!r}")
    check(f"{label} 登录页用户名仍预填当前用户名", c.page.locator("#u").input_value() == ADMIN_USER,
          f"value={c.page.locator('#u').input_value()!r}")
    c.assert_no_secret_in_storage(label)
    c.snap("02-password-only-login-prefilled")

    # 旧会话必须全部失效（当前浏览器的 cookie + 另一个 HTTP cookie 会话）
    probe = HttpClient("cookie-probe")
    st1, _, _ = probe.call("GET", f"{c.base}/api/auth/session", headers={"Cookie": browser_cookie})
    record(f"{label} 浏览器旧 cookie 会话已失效", st1 == 401, f"status={st1}")
    st2, _, _ = other.call("GET", f"{c.base}/api/auth/session")
    record(f"{label} 另一个管理员 cookie 会话也已失效", st2 == 401, f"status={st2}")

    assert_client_token_ok(f"{label} 改动后", c.base, token)

    err = c.login(ADMIN_USER, ADMIN_PASS, expect_ok=False)
    check(f"{label} 旧密码不可登录", "用户名或密码错误" in err, f"err={err!r}")
    c.snap("03-password-only-old-login-rejected")
    c.login(ADMIN_USER, NEW_PASS)
    check(f"{label} 新密码可登录", c.page.locator("nav.tabs").is_visible())
    c.snap("04-password-only-new-login-ok")
    c.assert_secrets_absent_from_log(label)


def scenario_both(c):
    """同时改用户名与密码，并重启服务验证持久化。"""
    label = f"[{c.viewport_name}/同时修改]"
    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    c.open_settings()
    c.assert_layout(f"{label} 设置页")

    token, err = setup_client_token(c.base)
    check(f"{label} 预先签发普通账号 client 令牌", token is not None, str(err))

    c.page.fill("#me-username", NEW_USERNAME)
    c.page.fill("#me-current", ADMIN_PASS)
    c.page.fill("#me-new", NEW_PASS)
    c.page.fill("#me-confirm", NEW_PASS)
    c.snap("01-both-filled")
    c.save()
    c.wait_login_page()
    notice = c.page.locator(".ok-text").inner_text() if c.page.locator(".ok-text").count() else ""
    check(f"{label} 回登录页并出现重新登录提示", "凭据已更新，请重新登录" in notice, f"notice={notice!r}")
    check(f"{label} 登录页用户名已预填新用户名", c.page.locator("#u").input_value() == NEW_USERNAME,
          f"value={c.page.locator('#u').input_value()!r}")
    c.assert_no_secret_in_storage(label)
    c.snap("02-both-login-prefilled")
    assert_client_token_ok(f"{label} 改动后", c.base, token)

    # 重启服务（同一 data 目录、同一端口），验证凭据持久化与旧会话仍失效
    step(f"{label} 重启服务（同 data 目录）")
    c.srv.stop()
    c.srv.start()
    try:
        with urllib.request.urlopen(f"{c.base}/healthz", timeout=5) as r:
            health = r.status
    except Exception as exc:  # noqa: BLE001
        health = f"{type(exc).__name__}: {exc}"
    check(f"{label} 重启后服务可用（/healthz）", health == 200, f"health={health}")
    c.page.reload(wait_until="domcontentloaded")
    c.page.wait_for_selector("form:has(#u)", timeout=15000)
    check(f"{label} 重启后仍是未登录态（旧会话未复活）", c.page.locator("nav.tabs").count() == 0)
    c.snap("03-both-after-restart-not-authed")

    err = c.login(ADMIN_USER, ADMIN_PASS, expect_ok=False)
    check(f"{label} 重启后旧凭据不可登录", "用户名或密码错误" in err, f"err={err!r}")
    c.snap("04-both-after-restart-old-rejected")
    c.login(NEW_USERNAME, NEW_PASS)
    check(f"{label} 重启后新凭据可登录（已持久化）", c.page.locator("nav.tabs").is_visible())
    c.snap("05-both-after-restart-new-ok")
    assert_client_token_ok(f"{label} 重启后", c.base, token)
    c.assert_secrets_absent_from_log(label)


def scenario_wrong_current(c):
    """当前密码错误：报错、密码字段清空、用户名草稿保留、会话不受影响。"""
    label = f"[{c.viewport_name}/当前密码错误]"
    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    c.open_settings()
    c.assert_layout(f"{label} 设置页")

    c.page.fill("#me-username", "t2a-draft-name")
    c.page.fill("#me-current", WRONG_PASS)
    c.snap("01-wrong-current-filled")
    c.save()
    err = c.wait_err("当前密码不正确")
    c.snap("02-wrong-current-error")

    vals = c.values()
    check(f"{label} 用户名草稿保留", vals["username"] == "t2a-draft-name", f"values={vals}")
    record(f"{label} 当前密码字段已清空", vals["current"] == "", f"values={vals}")
    record(f"{label} 新密码字段已清空", vals["new"] == "", f"values={vals}")
    record(f"{label} 确认新密码字段已清空", vals["confirm"] == "", f"values={vals}")
    c.assert_no_secret_in_storage(label)

    # 失败不改凭据：原凭据仍可登录，当前会话仍有效
    c.page.reload(wait_until="domcontentloaded")
    c.page.wait_for_selector("nav.tabs", timeout=15000)
    record(f"{label} 当前会话在失败后仍有效", c.page.locator("nav.tabs").is_visible())
    c.snap("03-wrong-current-session-alive")
    c.assert_secrets_absent_from_log(label)


def scenario_duplicate_username(c):
    """新用户名与既有账号重复：409 报错、整体回滚（原凭据不变）。"""
    label = f"[{c.viewport_name}/重名]"
    setup = HttpClient("dup-setup")
    st, _, _ = setup.call("POST", f"{c.base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    check(f"{label} 管理员 API 登录", st == 200, f"status={st}")
    st, body, _ = setup.call("POST", f"{c.base}/api/admin/users", {"username": DUP_USER, "password": DUP_PASS})
    check(f"{label} 预置同名普通账号", st == 201, f"status={st} body={body}")

    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    c.open_settings()
    c.assert_layout(f"{label} 设置页")
    c.page.fill("#me-username", DUP_USER)
    c.page.fill("#me-current", ADMIN_PASS)
    c.snap("01-duplicate-filled")
    c.save()
    err = c.wait_err("该用户名已存在")
    c.snap("02-duplicate-error")

    vals = c.values()
    check(f"{label} 用户名草稿保留（便于改名重试）", vals["username"] == DUP_USER, f"values={vals}")
    record(f"{label} 密码字段已清空", vals["current"] == "" and vals["new"] == "" and vals["confirm"] == "", f"values={vals}")
    c.assert_no_secret_in_storage(label)

    # 回滚证明：原管理员凭据仍可用（用户名未被改掉）
    probe = HttpClient("rollback-probe")
    st, body, _ = probe.call("POST", f"{c.base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    check(f"{label} 冲突后原用户名/密码仍可登录（整体回滚）", st == 200, f"status={st} body={body}")
    c.snap("03-duplicate-original-creds-ok")
    c.assert_secrets_absent_from_log(label)


def scenario_rate_limit(c):
    """连续失败触发 429（10 次/15 分钟，按管理员 id 计时）。"""
    label = f"[{c.viewport_name}/连续失败限流]"
    c.goto_login()
    c.login(ADMIN_USER, ADMIN_PASS)
    c.open_settings()
    c.assert_layout(f"{label} 设置页")
    c.page.fill("#me-username", "t2a-draft-name")

    for i in range(1, 11):
        c.page.fill("#me-current", WRONG_PASS)
        c.save()
        c.wait_err("当前密码不正确")
        vals = c.values()
        record(f"{label} 第 {i} 次失败：当前密码字段清空", vals["current"] == "", f"values={vals}")
        if i in (1, 10):
            c.snap(f"0{i if i == 1 else 2}-rate-limit-fail-{i}")

    vals = c.values()
    record(f"{label} 第 10 次失败后用户名草稿仍保留", vals["username"] == "t2a-draft-name", f"values={vals}")

    c.page.fill("#me-current", WRONG_PASS)
    c.save()
    err = c.wait_err("尝试过于频繁")
    record(f"{label} 第 11 次请求被限流（界面提示）", "尝试过于频繁" in err, f"err={err!r}")
    c.snap("03-rate-limit-429")

    # Retry-After 头必须真实下发（用第 12 次请求观察响应头）
    cookie = "; ".join(f"{k['name']}={k['value']}" for k in c.context.cookies())
    probe = HttpClient("rate-probe")
    st, body, headers = probe.call(
        "PATCH",
        f"{c.base}/api/admin/me",
        {"currentPassword": WRONG_PASS, "username": "t2a-draft-name"},
        headers={"Cookie": cookie, "Origin": c.base},
    )
    retry_after = header_of(headers, "Retry-After")
    record(f"{label} 限流响应 429 且带 Retry-After 头", st == 429 and (retry_after or "").isdigit(),
           f"status={st} Retry-After={retry_after!r} body={body}")
    record(f"{label} 限流后会话仍有效（未被登出）", c.page.locator("nav.tabs").is_visible())
    c.assert_secrets_absent_from_log(label)


def scenario_guards_http(c):
    """守卫与响应卫生（真实 HTTP，不经浏览器）：只读探查，不做任何成功改密。

    顺序与实现一致：守卫（Cookie 管理员 + 同源）先跑，限流在守卫之后，
    因此本场景的这些被拒请求不会消耗限流预算。
    """
    label = f"[{c.viewport_name}/守卫与响应卫生]"
    admin = HttpClient("guard-admin")
    st, _, _ = admin.call("POST", f"{c.base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    check(f"{label} 管理员 API 登录", st == 200, f"status={st}")
    admin_cookie = admin.cookie_header()

    st, _, _ = admin.call("POST", f"{c.base}/api/admin/users", {"username": CLIENT_USER, "password": CLIENT_PASS})
    check(f"{label} 建普通账号", st == 201, f"status={st}")

    # 1) 普通账号 cookie
    normal = HttpClient("guard-normal")
    st, _, _ = normal.call("POST", f"{c.base}/api/auth/login", {"username": CLIENT_USER, "password": CLIENT_PASS})
    check(f"{label} 普通账号 cookie 登录", st == 200, f"status={st}")
    normal_cookie = normal.cookie_header()
    st, body, _ = normal.call("PATCH", f"{c.base}/api/admin/me", {"currentPassword": CLIENT_PASS, "newPassword": NEW_PASS})
    record(f"{label} 普通账号 Cookie 被拒（403 forbidden）", st == 403 and (body or {}).get("error", {}).get("code") == "forbidden",
           f"status={st} body={body}")

    # 2) 管理员 Bearer（client 令牌）不能改凭据
    st, body, _ = admin.call(
        "POST",
        f"{c.base}/api/admin/apps",
        {
            "appId": APP_ID,
            "name": "T2A 守卫检查",
            "allowedOrigins": [APP_ORIGIN],
            "kaneoProjectId": "p-t2a",
            "kaneoColumnSlug": "triage",
        },
    )
    check(f"{label} 建应用（供给 client 令牌登录）", st in (201, 409), f"status={st} body={body}")
    st, body, _ = admin.call(
        "POST",
        f"{c.base}/api/auth/login",
        {"username": ADMIN_USER, "password": ADMIN_PASS, "clientLabel": "t2a-admin-client", "appId": APP_ID},
        headers={"Origin": APP_ORIGIN},
    )
    check(f"{label} 管理员 client 令牌可签发", st == 200 and isinstance(body, dict) and "token" in body, f"status={st} body={body}")
    admin_token = body["token"]
    bearer = HttpClient("guard-bearer")
    st, body, _ = bearer.call("PATCH", f"{c.base}/api/admin/me", {"currentPassword": ADMIN_PASS, "newPassword": NEW_PASS},
                              headers={"Authorization": f"Bearer {admin_token}"})
    record(f"{label} 管理员 Bearer 令牌被拒（403 unauthorized）", st == 403 and (body or {}).get("error", {}).get("code") == "unauthorized",
           f"status={st} body={body}")

    # 3) 跨源 Origin
    cross = HttpClient("guard-cross")
    st, body, _ = cross.call("PATCH", f"{c.base}/api/admin/me", {"currentPassword": ADMIN_PASS, "newPassword": NEW_PASS},
                             headers={"Cookie": admin_cookie, "Origin": "http://127.0.0.1:9"})
    record(f"{label} 跨源 Origin 被拒（403 origin_mismatch）",
           st == 403 and (body or {}).get("error", {}).get("code") == "origin_mismatch", f"status={st} body={body}")

    # 4) 无凭据
    anon = HttpClient("guard-anon")
    st, body, _ = anon.call("PATCH", f"{c.base}/api/admin/me", {"currentPassword": ADMIN_PASS, "newPassword": NEW_PASS})
    record(f"{label} 无凭据被拒（401）", st == 401, f"status={st} body={body}")

    # 5) 响应卫生：会话响应不含口令/哈希字段
    st, body, _ = admin.call("GET", f"{c.base}/api/auth/session")
    raw = json.dumps(body, ensure_ascii=False)
    record(f"{label} 会话响应不含 pass_hash", "pass_hash" not in raw, raw[:200])
    for secret in SECRETS:
        record(f"{label} 会话响应不含口令明文 {secret[:4]}***", secret not in raw)

    # 6) 以上被拒请求都没有改动凭据
    probe = HttpClient("guard-probe")
    st, _, _ = probe.call("POST", f"{c.base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    record(f"{label} 被拒请求后原凭据仍可用（无副作用）", st == 200, f"status={st}")
    c.assert_secrets_absent_from_log(label)


SCENARIOS = [
    ("username-only", scenario_username_only),
    ("password-only", scenario_password_only),
    ("both", scenario_both),
    ("wrong-current", scenario_wrong_current),
    ("duplicate-username", scenario_duplicate_username),
    ("rate-limit", scenario_rate_limit),
    ("guards-http", scenario_guards_http),
]


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #

def launch_engine(pw, kind):
    if kind != "chromium":
        return getattr(pw, kind).launch(headless=True)
    last = None
    for kwargs in ({}, {"channel": "chrome"}, {"channel": "chromium"}):
        try:
            browser = pw.chromium.launch(headless=True, **kwargs)
            print(f"[INFO] chromium launch kwargs={kwargs or 'default'}", flush=True)
            return browser
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise last


def run_viewport(pw, viewport_name, vw, vh, port, scenarios):
    print(f"\n########## 视口 {viewport_name} {vw}x{vh}（端口 {port}） ##########", flush=True)
    browser = launch_engine(pw, "chromium")
    try:
        for name, fn in scenarios:
            data_dir = tempfile.mkdtemp(prefix=f"t2a-{viewport_name}-{name}-")
            log_path = os.path.join(LOG_DIR, f"t2a-server-{viewport_name}-{name}.log")
            srv = ServerHandle(port, data_dir, log_path, f"{viewport_name}/{name}")
            ctx = None
            try:
                step(f"{viewport_name}/{name}：启动服务（data={data_dir}）")
                srv.start()
                context = browser.new_context(viewport={"width": vw, "height": vh})
                page = context.new_page()
                ctx = Ctx(page, context, srv, viewport_name, vw)
                fn(ctx)
                scenario_outcomes.append({"viewport": viewport_name, "scenario": name, "ok": True, "detail": ""})
                print(f"  --- 场景 {viewport_name}/{name} 完成 ---", flush=True)
            except AssertionError as exc:
                scenario_outcomes.append({"viewport": viewport_name, "scenario": name, "ok": False, "detail": str(exc)})
                print(f"  !!! 场景 {viewport_name}/{name} 断言失败：{exc}", flush=True)
                if ctx is not None:
                    ctx.snap(f"99-{name}-failure")
            except Exception as exc:  # noqa: BLE001
                scenario_outcomes.append({"viewport": viewport_name, "scenario": name, "ok": False, "detail": f"{type(exc).__name__}: {exc}"})
                print(f"  !!! 场景 {viewport_name}/{name} 异常：{type(exc).__name__}: {exc}", flush=True)
                if ctx is not None:
                    try:
                        ctx.snap(f"99-{name}-failure")
                    except Exception:  # noqa: BLE001
                        pass
            finally:
                if ctx is not None:
                    # 服务端日志中的口令明文检查（含异常路径）
                    try:
                        ctx.assert_secrets_absent_from_log(f"[{viewport_name}/{name}]")
                    except Exception:  # noqa: BLE001
                        pass
                    ctx.context.close()
                srv.stop()
                shutil.rmtree(data_dir, ignore_errors=True)
    finally:
        browser.close()


def main():
    ap = argparse.ArgumentParser(description="T2-A 管理页「管理员设置」真实浏览器验证")
    ap.add_argument("--skip-build", action="store_true", help="跳过管理页构建（默认会真实构建）")
    ap.add_argument("--only", default="", help="只跑指定场景名（逗号分隔），默认全部")
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    args = ap.parse_args()

    os.makedirs(SHOTS, exist_ok=True)
    scenarios = SCENARIOS
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        scenarios = [s for s in SCENARIOS if s[0] in wanted]
        if not scenarios:
            print(f"[FATAL] --only 未匹配到任何场景：{args.only}")
            sys.exit(2)

    print("=== T2-A 管理页「管理员设置」真实浏览器验证 ===", flush=True)
    print(f"仓库：{ROOT}", flush=True)

    check_static()

    if not args.skip_build:
        step("构建管理页前端（pnpm --filter @feedback/admin build）")
        build = subprocess.run(
            ["pnpm", "--filter", "@feedback/admin", "build"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        print(build.stdout[-2000:], flush=True)
        print(build.stderr[-2000:], flush=True)
        if build.returncode != 0:
            print(f"[FATAL] 管理页构建失败 exit={build.returncode}")
            sys.exit(2)
        record("管理页构建 exit 0", build.returncode == 0, f"exit={build.returncode}")

    index_html = os.path.join(ADMIN_DIST, "index.html")
    if not os.path.exists(index_html):
        print(f"[FATAL] 缺少管理页构建产物：{index_html}")
        sys.exit(2)
    mtime = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(index_html)))
    print(f"[INFO] 托管产物 {os.path.relpath(index_html, ROOT)} mtime={mtime}", flush=True)

    ports = {}
    for vp in VIEWPORTS:
        p = free_port()
        while port_busy(p):
            p = free_port()
        ports[vp] = p

    started = time.time()
    with sync_playwright() as pw:
        for vp, (vw, vh) in VIEWPORTS.items():
            run_viewport(pw, vp, vw, vh, ports[vp], scenarios)
    duration = round(time.time() - started, 1)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    print(f"\n=== T2-A 断言结果：{passed}/{len(results)} 通过，用时 {duration}s ===", flush=True)
    print("场景结果：", flush=True)
    for o in scenario_outcomes:
        print(f"  {'OK  ' if o['ok'] else 'FAIL'} {o['viewport']}/{o['scenario']}" + (f" — {o['detail']}" if o["detail"] else ""), flush=True)
    if failed:
        print("失败断言：", flush=True)
        for n, d in failed:
            print(f"  - {n}" + (f" — {d}" if d else ""), flush=True)

    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "durationSec": duration,
                "viewports": {k: {"width": v[0], "height": v[1], "port": ports[k]} for k, v in VIEWPORTS.items()},
                "total": len(results),
                "passed": passed,
                "failed": [{"assertion": n, "detail": d} for n, d in failed],
                "assertions": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
                "scenarios": scenario_outcomes,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"[INFO] 报告：{os.path.relpath(REPORT, ROOT)}", flush=True)

    sys.exit(1 if failed or any(not o["ok"] for o in scenario_outcomes) else 0)


if __name__ == "__main__":
    main()
