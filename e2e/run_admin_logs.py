#!/usr/bin/env python3
"""管理页日志级恢复的真实浏览器验证。

用当前源码启动隔离服务和 e2e mock，制造「任务/资产已知、日志评论结果未知」的
needs_review 记录，再从 /admin/ 点击日志级恢复按钮。请求体和 mock 远端事实都在
浏览器外独立核对，避免只测试 React 的静态渲染。
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

from playwright.sync_api import sync_playwright
from run_backup_restore import Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = "http://127.0.0.1:8796"
MOCK = "http://127.0.0.1:8896"
AI = "http://127.0.0.1:8897"
USER, PASSWORD = "admin", "backup-e2e-pass"
APP_ID = "com.br.test"  # reuse Client's fixed appId while keeping isolated data


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        raw = r.read()
        return r.status, json.loads(raw.decode()) if raw else None


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read()
        return r.status, json.loads(raw.decode()) if raw else None


def call(base, method, path, body=None, opener=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("origin", base)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with (opener or urllib.request).open(req, timeout=15) as r:
            raw = r.read()
            return r.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode())
        except Exception:
            return e.code, {"raw": raw.decode(errors="replace")}


def wait(url, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            get(url)
            return True
        except Exception:
            time.sleep(0.25)
    return False


def multipart(key, log_name, log_bytes):
    import struct
    import zlib

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(b"\x00" + b"\xc8\x3c\x3c" * 4 * 4)) + chunk(b"IEND", b""))
    boundary = "----ADMINLOGE2E"
    meta = {"idempotencyKey": key, "appId": APP_ID, "text": "管理页日志恢复验证",
            "logs": [{"name": log_name, "source": "manual", "byteSize": len(log_bytes)}]}
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
            f"Content-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"logs\"; filename=\"{log_name}\"\r\n"
             "Content-Type: text/plain\r\n\r\n").encode() + log_bytes + b"\r\n"
    return body, f"multipart/form-data; boundary={boundary}"


def main():
    ports = (8796, 8896, 8897)
    import socket
    busy = []
    for port in ports:
        with socket.socket() as s:
            s.settimeout(0.2)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                busy.append(port)
    if busy:
        raise SystemExit(f"ports already in use: {busy}")

    data_dir = tempfile.mkdtemp(prefix="fb-admin-log-e2e-")
    env = dict(os.environ, FEEDBACK_DATA_DIR=data_dir, FEEDBACK_PORT="8796",
               FEEDBACK_MASTER_KEY="YWRtaW4tbG9nLWUydGUtbWFzdGVyLWtleS0zMiEhISE=",
               FEEDBACK_ADMIN_USER=USER, FEEDBACK_ADMIN_PASSWORD=PASSWORD,
               FEEDBACK_COOKIE_SECURE="false", FEEDBACK_ADMIN_DIST=os.path.join(ROOT, "apps/admin/dist"),
               NODE_ENV="production")
    procs = []
    try:
        procs.append(subprocess.Popen(["node", "e2e/mock-external.mjs"], cwd=ROOT,
                                      env=dict(os.environ, E2E_KANEO_PORT="8896", E2E_AI_PORT="8897",
                                               E2E_KANEO_PUBLIC_BASE=MOCK),
                                      stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT))
        if not wait(MOCK + "/__health") or not wait(AI + "/__health"):
            raise RuntimeError("mock did not start")
        env["FEEDBACK_PORT"] = "8796"
        procs.append(subprocess.Popen(["npx", "tsx", "src/index.ts"], cwd=os.path.join(ROOT, "apps/server"),
                                      env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT))
        if not wait(SERVER + "/healthz"):
            raise RuntimeError("server did not start")

        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        assert call(SERVER, "POST", "/api/auth/login", {"username": USER, "password": PASSWORD}, opener)[0] == 200
        assert call(SERVER, "PUT", "/api/admin/connection/kaneo", {"baseUrl": MOCK, "apiKey": "k-admin"}, opener)[0] == 200
        assert call(SERVER, "PUT", "/api/admin/connection/ai", {"baseUrl": AI + "/v1", "model": "mock", "apiKey": "a-admin"}, opener)[0] == 200
        assert call(SERVER, "POST", "/api/admin/apps", {"appId": APP_ID, "name": "admin e2e", "allowedOrigins": [SERVER],
                                                               "kaneoProjectId": "p-admin", "kaneoColumnSlug": "triage"}, opener)[0] == 201
        # The pipeline orders screenshot comment before log comment. Skip the first
        # comment and make the second result uncertain, deterministically.
        post(MOCK + "/__mock/fail", {"stage": "comment", "mode": "uncertain", "once": True,
                                     "afterWrite": False, "skip": 1})
        log_bytes = b"manual recovery log\nECONNRESET\n"
        client = Client(8796)
        assert client.login() == 200
        token = client.client_token("admin-log-e2e")
        assert token
        status, submitted = client.submit("admin-log-key", "管理页日志恢复验证", token,
                                          [("recovery.log", "manual", log_bytes)])
        assert status == 201, submitted
        feedback_id = submitted["feedbackId"]
        detail = None
        for _ in range(120):
            status, detail = call(SERVER, "GET", f"/api/admin/feedback/{feedback_id}", opener=opener)
            if (detail or {}).get("status") == "needs_review":
                break
            time.sleep(0.25)
        assert (detail or {}).get("status") == "needs_review", detail
        log_id = (detail.get("logs") or [])[0]["id"]
        print("DETAIL_RECOVERY", json.dumps(detail.get("recovery"), ensure_ascii=False), flush=True)
        state_before = get(MOCK + "/__mock/state")[1] or {}
        before_tasks = len(state_before.get("tasks") or [])
        before_comments = sum(len(v) for v in (state_before.get("comments") or {}).values())

        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception:
                browser = pw.chromium.launch(headless=True, channel="chrome")
            page = browser.new_page()
            requests = []
            page.on("request", lambda r: requests.append(r) if r.url.endswith(f"/api/feedback/{feedback_id}/recover") else None)
            page.goto(SERVER + "/admin/", wait_until="networkidle")
            page.locator("#u").fill(USER)
            page.locator("#p").fill(PASSWORD)
            page.locator("button[type=submit]").click()
            page.get_by_role("button", name="详情").click()
            page.get_by_role("button", name="重试日志评论").wait_for()
            page.once("dialog", lambda d: d.accept())
            with page.expect_response(lambda r: r.url.endswith(f"/api/feedback/{feedback_id}/recover") and r.request.method == "POST") as response:
                page.get_by_role("button", name="重试日志评论").click()
            assert response.value.status == 202, response.value.status
            assert response.value.json().get("status") == "archived", response.value.json()
            browser.close()
        assert requests, "management page did not send recovery request"
        payload = json.loads(requests[-1].post_data or "{}")
        assert payload.get("logId") == log_id, payload
        assert payload.get("action") == "retry_comment", payload
        after_state = get(MOCK + "/__mock/state")[1] or {}
        comments = after_state.get("comments") or {}
        after_comments = sum(len(v) for v in comments.values())
        assert len(after_state.get("tasks") or []) == before_tasks, (before_tasks, after_state.get("tasks"))
        # Retry fills exactly the missing log comment once; it must not create a task
        # or duplicate the already confirmed screenshot comment.
        assert after_comments == before_comments + 1, (before_comments, after_comments)
        status, restored = call(SERVER, "GET", f"/api/admin/feedback/{feedback_id}", opener=opener)
        assert status == 200 and restored.get("status") == "archived", restored
        assert restored.get("screenshot") == detail.get("screenshot"), "confirmed screenshot changed"
        assert restored.get("logs") == detail.get("logs"), "saved logs changed during recovery"
        print(f"PASS admin log recovery: feedback={feedback_id} logId={log_id} request={payload} tasks={before_tasks} comments={after_comments}")
    finally:
        for proc in procs:
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
