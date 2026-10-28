#!/usr/bin/env python3
"""手机问题追踪隔离预览：临时数据库、真实本地 API，无外部服务访问。

保持进程运行即可用浏览器体验。重新构建 Web 后，复制 dist 到 runtime/host 即可刷新。
"""
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    Path("/tmp/feedback-mobile-tracking-20261013").mkdir(parents=True, exist_ok=True)
    runtime = Path(tempfile.mkdtemp(prefix="feedback-mobile-tracking-"))
    host = runtime / "host"
    host.mkdir()
    for file in (ROOT / "packages/web/dist").glob("*.js"):
        shutil.copy(file, host)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    host.joinpath("index.html").write_text(f'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>手机反馈追踪 · 隔离预览</title><style>
body{{margin:0;padding:24px;font-family:system-ui;background:#f5f5f7;color:#1d1d1f}}main{{max-width:640px;margin:auto}}
h1{{font-size:24px}}p{{line-height:1.7}}code{{overflow-wrap:anywhere}}a{{color:#0071e3}}
</style><main><h1>反馈与问题追踪</h1><p>点击右侧反馈入口，提交后选择「查看进展」，或在「我的反馈」查看回复、处理说明并补充信息。</p>
<p>仅本地示例数据。账号 <code>mobile-demo</code>，密码 <code>mobile-demo-20261013</code>。</p>
<p><a href="?theme=light">浅色</a> · <a href="?theme=dark">深色</a></p></main>
<feedback-widget api-base="{base}" app-id="com.mobile.tracking" app-name="手机追踪预览" capture-mode="off"></feedback-widget>
<script type="module">import './feedback-web.js';
document.querySelector('feedback-widget').setAttribute('theme',new URL(location.href).searchParams.get('theme')||'light');</script></html>''')
    env = dict(os.environ)
    env.update(FEEDBACK_PORT=str(port), FEEDBACK_DATA_DIR=str(runtime / "data"),
               FEEDBACK_ADMIN_DIST=str(host), FEEDBACK_MASTER_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
               FEEDBACK_ADMIN_USER="admin", FEEDBACK_ADMIN_PASSWORD="mobile-admin-20261013",
               FEEDBACK_UPDATE_MANIFEST_URL="off", FEEDBACK_ASSIST_HUB_URL="",
               FEEDBACK_ASSIST_SOURCE_KEY="", FEEDBACK_ASSIST_READ_KEY="", NODE_ENV="production")
    log = runtime.joinpath("server.log").open("w")
    proc = subprocess.Popen([str(ROOT / "apps/server/node_modules/.bin/tsx"), "src/index.ts"],
                            cwd=ROOT / "apps/server", env=env, stdout=log, stderr=subprocess.STDOUT)
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"content-type": "application/json", "origin": base})
        with op.open(req, timeout=10) as response:
            return json.load(response)

    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError(runtime.joinpath("server.log").read_text())
            try:
                call("GET", "/healthz")
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError("隔离服务启动超时")
        call("POST", "/api/auth/login", {"username": "admin", "password": "mobile-admin-20261013"})
        call("POST", "/api/admin/users", {"username": "mobile-demo", "password": "mobile-demo-20261013", "dailyLimit": 50})
        call("POST", "/api/admin/apps", {"appId": "com.mobile.tracking", "name": "手机追踪预览", "allowedOrigins": [base]})
        call("POST", "/api/auth/login", {"username": "mobile-demo", "password": "mobile-demo-20261013", "appId": "com.mobile.tracking"})
        ids = []
        for text in ["手机上提交反馈之后，希望可以清楚看到问题的处理进展和回复，而不是提交完就不知道去哪找。", "保存按钮已经修复，但横屏的时候提示文字还是被遮住，希望继续跟进同一个问题。", "请帮忙检查 Android 手机上的深色模式，输入框和按钮对比度偏低。"]:
            ids.append(call("POST", "/api/feedback", {"appId": "com.mobile.tracking", "text": text, "idempotencyKey": secrets.token_hex(16)})["feedbackId"])
        call("POST", "/api/auth/login", {"username": "admin", "password": "mobile-admin-20261013"})
        ver = call("GET", f"/api/admin/feedback/{ids[1]}")["dialogueVersion"]
        call("POST", f"/api/admin/feedback/{ids[1]}/issue-status", {"issueStatus": "resolved", "resolutionNote": "已修复保存后的提示；如横屏下仍有异常，请在这里继续补充截图。", "expectedDialogueVersion": ver})
        ver = call("GET", f"/api/admin/feedback/{ids[2]}")["dialogueVersion"]
        call("POST", f"/api/admin/feedback/{ids[2]}/messages", {"text": "已收到反馈，方便补充 Android 版本和出现问题的页面吗？", "issueStatusAction": "request_info", "expectedDialogueVersion": ver})
        info = {"base": base, "host": str(host), "runtime": str(runtime), "pid": proc.pid, "ids": ids}
        runtime.joinpath("runtime.json").write_text(json.dumps(info, ensure_ascii=False, indent=2))
        Path("/tmp/feedback-mobile-tracking-20261013/runtime.json").write_text(json.dumps(info, ensure_ascii=False, indent=2))
        print(json.dumps(info, ensure_ascii=False), flush=True)
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=25)
        log.close()


if __name__ == "__main__":
    main()
