#!/usr/bin/env python3
"""
t12 复验：U1 两条缺陷的修复是否真实生效（用 t10 的原始复现步骤，不接受实现者自证）。

缺陷 1（U1-D1-version-unknown）：生产镜像里后台「当前版本」恒为 0.0.0-unknown。
缺陷 2（U1-D2-updater-url-ignored）：compose 注入的 FEEDBACK_UPDATER_URL 被服务端静默忽略。

本脚本做的事（全部为只读验证，不改任何实现）：
  1. 用**当前工作树**真实重建镜像（与 t10 相同的构建命令），确保验的是修复后的产物；
  2. 缺陷 1 复现步骤（与 t10 相同）：docker run 新镜像 → 管理员登录 → GET /api/admin/system/update
     → 断言 current.version == apps/server/package.json 的 version，且不是 0.0.0-unknown；
  3. 缺陷 2 复现步骤（与 t10 相同）：**只**注入 compose 里的规范名 FEEDBACK_UPDATER_URL=<stub>
     （不注入别名）→ 断言 config.updaterBaseUrl == stub 地址（而不是默认 http://updater:8790）；
  4. 反向回归：不设该变量 → 仍回退默认；只设别名 FEEDBACK_UPDATE_URL → 兼容别名仍被采纳；
  5. 反向回归：tsx 直跑源码布局下 readPackageVersion/SERVER_VERSION 同样正确；
  6. 把全部原始观测写入 e2e/shots/u1/reverify-defects.json（含修复前观测，供对账）。

用法：python3 e2e/reverify_u1_defects.py
"""

import json
import os
import re
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "e2e/shots/u1")
REPORT = os.path.join(SHOTS, "reverify-defects.json")
IMAGE = "u1v-feedback:0.3.0"
ADMIN_USER = "admin"
ADMIN_PASS = "u1v-reverify-pass-1"
MASTER_KEY = "dTF2LXJldmVyaWZ5LW1hc3Rlci1rZXktMzJieXRlcyE="

results = []
observations = []


def log(msg=""):
    print(msg, flush=True)


def step(msg):
    print(f"\n=== {msg}", flush=True)


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")


def record(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    return bool(cond)


def run(cmd, timeout=1800, cwd=ROOT):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    return proc.returncode, proc.stdout, proc.stderr


def docker(*args, timeout=1800):
    return run(["docker", *args], timeout=timeout)


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until(fn, timeout=120, interval=0.3, desc="条件"):
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


def http(url, method="GET", body=None, opener=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    send = opener.open if opener is not None else urllib.request.urlopen
    try:
        with send(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed = json.loads(raw)
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw[:200]}
        return exc.code, parsed


def server_package_version():
    with open(os.path.join(ROOT, "apps/server/package.json"), encoding="utf-8") as handle:
        return json.load(handle)["version"]


# --------------------------------------------------------------------------- #
# 可观测 stub（缺陷 2 需要一个「能看出服务端到底用了哪个地址」的目标）
# --------------------------------------------------------------------------- #

class Stub:
    def __init__(self):
        self.port = free_port()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), self._handler())
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def _handler(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静音
                pass

            def do_GET(self):  # noqa: N802
                payload = b'{"ok":true}'
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        return Handler


# --------------------------------------------------------------------------- #
# 容器
# --------------------------------------------------------------------------- #

class Container:
    def __init__(self, name, env_extra):
        self.name = name
        self.env_extra = env_extra
        self.port = free_port()
        self.volume = f"{name}-data"

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self):
        docker("rm", "-f", self.name)
        docker("volume", "rm", "-f", self.volume)
        docker("volume", "create", self.volume)
        args = [
            "run", "-d", "--name", self.name,
            "-p", f"127.0.0.1:{self.port}:8787",
            "-v", f"{self.volume}:/data",
            "-e", f"FEEDBACK_MASTER_KEY={MASTER_KEY}",
            "-e", f"FEEDBACK_ADMIN_USER={ADMIN_USER}",
            "-e", f"FEEDBACK_ADMIN_PASSWORD={ADMIN_PASS}",
        ]
        for key, value in self.env_extra.items():
            args += ["-e", f"{key}={value}"]
        args.append(IMAGE)
        code, out, err = docker(*args)
        if code != 0:
            raise RuntimeError(f"docker run 失败：{err[-300:]}")
        wait_until(lambda: http(f"{self.base}/healthz", timeout=3)[0] == 200, timeout=90, desc=f"{self.name} /healthz")

    def system_update(self):
        """管理员登录后读取「系统更新」状态（就是 t10 的复现步骤）。"""
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        status, _ = http(f"{self.base}/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS}, opener=opener)
        if status != 200:
            return status, None
        status, body = http(f"{self.base}/api/admin/system/update", opener=opener)
        return status, body

    def cleanup(self):
        docker("rm", "-f", self.name)
        docker("volume", "rm", "-f", self.volume)


def build_image():
    step(f"1. 用当前工作树重建镜像 {IMAGE}（与 t10 相同的构建命令）")
    commit = run(["git", "rev-parse", "HEAD"])[1].strip()
    docker("rmi", "-f", IMAGE)
    code, out, err = docker(
        "build", "-f", os.path.join(ROOT, "Dockerfile"), "-t", IMAGE,
        "--label", "org.opencontainers.image.version=0.3.0",
        "--label", f"org.opencontainers.image.revision={commit}",
        ROOT,
        timeout=2400,
    )
    check("[build] docker build exit 0", code == 0, err[-300:])
    labels = docker("image", "inspect", "--format", "{{json .Config.Labels}}", IMAGE)[1].strip()
    image_id = docker("image", "inspect", "--format", "{{.Id}}", IMAGE)[1].strip()
    log(f"[build] 镜像 ID {image_id[:19]}，labels={labels}")
    observations.append({"step": "build", "image": IMAGE, "imageId": image_id, "labels": json.loads(labels), "commit": commit})
    return image_id


def check_defect1(stub):
    step("2. 缺陷 1 复现步骤（真实容器布局 → 后台当前版本）")
    expected = server_package_version()
    c = Container("u1v-reverify-d1", {})
    try:
        c.start()
        status, body = c.system_update()
        current = ((body or {}).get("current") or {}).get("version")
        log(f"[d1] GET /api/admin/system/update → current.version={current!r}（apps/server/package.json={expected}）")
        observations.append({
            "step": "defect1",
            "command": f"docker run -d --name u1v-reverify-d1 -p 127.0.0.1:{c.port}:8787 -v {c.volume}:/data {IMAGE} "
                       "→ 管理员登录 → GET /api/admin/system/update",
            "observed": {"current.version": current},
            "expected": expected,
        })
        check("[d1] 后台状态接口 200", status == 200, f"status={status}")
        check(f"[d1] current.version == apps/server/package.json version（{expected}）", current == expected, f"got {current!r}")
        check("[d1] current.version 不再是 0.0.0-unknown", current != "0.0.0-unknown", f"got {current!r}")
        # 容器内布局核实：与缺陷根因相关的两个事实
        code, out, _ = docker("exec", c.name, "sh", "-c", "ls -l /app/server/package.json /app/server/dist/routes/system-update.js")
        log("[d1] 镜像布局：\n" + out.strip())
        observations.append({"step": "defect1-layout", "observed": out.strip()})
    finally:
        c.cleanup()


def check_defect2(stub):
    step("3. 缺陷 2 复现步骤（只注入 compose 规范名 FEEDBACK_UPDATER_URL，不注入别名）")
    c = Container("u1v-reverify-d2", {"FEEDBACK_UPDATER_URL": stub.base})
    try:
        c.start()
        status, body = c.system_update()
        reported = ((body or {}).get("config") or {}).get("updaterBaseUrl")
        log(f"[d2] 只注入 FEEDBACK_UPDATER_URL={stub.base} → config.updaterBaseUrl={reported!r}")
        observations.append({
            "step": "defect2",
            "command": f"docker run -d … -e FEEDBACK_UPDATER_URL={stub.base} {IMAGE} → 管理员登录 → GET /api/admin/system/update",
            "observed": {"config.updaterBaseUrl": reported, "updateConfigured": ((body or {}).get('config') or {}).get('updateConfigured')},
            "expected": stub.base,
        })
        check("[d2] 后台状态接口 200", status == 200, f"status={status}")
        check("[d2] updaterBaseUrl == 注入的 stub 地址（采纳，非默认值）", reported == stub.base, f"got {reported!r}")
        check("[d2] updaterBaseUrl 不是默认 http://updater:8790", reported != "http://updater:8790", f"got {reported!r}")
    finally:
        c.cleanup()


def check_regressions(stub):
    step("4. 反向回归：不设变量 → 默认；只设别名 → 兼容采纳")
    c = Container("u1v-reverify-default", {})
    try:
        c.start()
        status, body = c.system_update()
        reported = ((body or {}).get("config") or {}).get("updaterBaseUrl")
        log(f"[r1] 不注入任何更新地址变量 → config.updaterBaseUrl={reported!r}")
        observations.append({"step": "regression-default", "observed": {"config.updaterBaseUrl": reported}, "expected": "http://updater:8790"})
        check("[r1] 缺省仍回退默认 http://updater:8790", reported == "http://updater:8790", f"got {reported!r}")
    finally:
        c.cleanup()

    c = Container("u1v-reverify-alias", {"FEEDBACK_UPDATE_URL": stub.base})
    try:
        c.start()
        status, body = c.system_update()
        reported = ((body or {}).get("config") or {}).get("updaterBaseUrl")
        log(f"[r2] 只注入旧别名 FEEDBACK_UPDATE_URL={stub.base} → config.updaterBaseUrl={reported!r}")
        observations.append({"step": "regression-alias", "observed": {"config.updaterBaseUrl": reported}, "expected": stub.base})
        check("[r2] 旧别名仍被采纳（兼容性保留）", reported == stub.base, f"got {reported!r}")
    finally:
        c.cleanup()

    step("5. 反向回归：tsx 直跑源码布局下的版本读取")
    tsx = os.path.join(ROOT, "apps/server/node_modules/.bin/tsx")
    code, out, err = run(
        [tsx, "-e", 'import { SERVER_VERSION } from "./apps/server/src/routes/system-update.ts"; console.log(SERVER_VERSION);'],
        cwd=ROOT,
    )
    value = out.strip().splitlines()[-1] if out.strip() else ""
    log(f"[r3] tsx SERVER_VERSION={value!r}（exit {code}）")
    observations.append({"step": "regression-tsx", "command": "tsx -e 'import { SERVER_VERSION } …'", "observed": {"SERVER_VERSION": value}})
    check("[r3] tsx 源码布局下版本读取正确", code == 0 and value == server_package_version(), f"exit={code} value={value!r}")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    log("=== t12 复验：U1 两条缺陷的修复 ===")
    log(f"仓库：{ROOT}")
    version = docker("version", "--format", "{{.Server.Version}}")[1].strip()
    log(f"docker {version}")

    stub = Stub()
    log(f"[INFO] stub 地址（可观测目标）：{stub.base}")
    image_id = None
    try:
        image_id = build_image()
        check_defect1(stub)
        check_defect2(stub)
        check_regressions(stub)
    finally:
        stub.stop()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    log(f"\n=== t12 复验结果：{passed}/{len(results)} 项断言通过 ===")
    for name, detail in failed:
        log(f"  - {name}" + (f" — {detail}" if detail else ""))

    with open(REPORT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "purpose": "复验 t10 发现的两条 U1 缺陷（t11 修复）是否真实生效；用 t10 的原始复现步骤",
                "image": IMAGE,
                "imageId": image_id,
                "serverPackageVersion": server_package_version(),
                "defects": [
                    {
                        "id": "U1-D1-version-unknown",
                        "status": "fixed" if all(ok for n, ok, _ in results if n.startswith("[d1]")) else "not_fixed",
                        "originalObservation": "t10（修复前，~15:00）：current.version=\"0.0.0-unknown\"",
                        "reverifiedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "reverifyEvidence": "e2e/shots/u1/reverify-defects.json（step=defect1）",
                    },
                    {
                        "id": "U1-D2-updater-url-ignored",
                        "status": "fixed" if all(ok for n, ok, _ in results if n.startswith("[d2]")) else "not_fixed",
                        "originalObservation": "t10（修复前，~15:00）：只注入 FEEDBACK_UPDATER_URL 时 config.updaterBaseUrl=\"http://updater:8790\"（被忽略）",
                        "reverifiedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "reverifyEvidence": "e2e/shots/u1/reverify-defects.json（step=defect2）",
                    },
                ],
                "total": len(results),
                "passed": passed,
                "failed": [{"assertion": n, "detail": d} for n, d in failed],
                "assertions": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
                "observations": observations,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    log(f"[INFO] 报告：{os.path.relpath(REPORT, ROOT)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
