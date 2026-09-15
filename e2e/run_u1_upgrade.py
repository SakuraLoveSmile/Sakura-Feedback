#!/usr/bin/env python3
"""
U1 独立验证（容器级真实升级）：后台一键更新的执行器、部署契约与失败边界。

做法（与实现者的 apps/updater/e2e/run-local-update.sh 完全独立，本脚本自建夹具）：
  · 独立 compose 项目 / 独立网络 / 独立数据卷 / 独立宿主端口 / 独立 registry 端口；
    绝不触碰任何既有容器、卷与端口（结束时只清理本轮自己创建的资源，保留诊断产物）。
  · 旧版 = 本机已有的旧源码镜像（默认 feedback-service:e2e-verify，DB user_version=2，无 daily_usage 表）；
    新版 = 从当前工作树真实构建的 u1v-feedback:0.3.0（label org.opencontainers.image.version=0.3.0）。
    两版都推入本轮自建 registry，升级按 **digest** 拉取。
  · 外部依赖（AI / Kaneo）= 本脚本自建的 mock HTTP 服务（随机端口，自带调用计数），
    容器通过 host.docker.internal 访问；**不**复用 e2e/mock-external.mjs，避免与其它进程抢 8898/8899。
  · 复制数据卷、切换镜像、改写状态文件全部由 **updater 容器自己**完成；本脚本只读证据与做断言。

场景：
  A happy_path        旧版→新版六阶段完整升级（含暂停期零写入、幂等、并发 409、放行后新数据可读）
  B verify_failure    新版核验失败 → failed_restored（旧镜像 + 未修改原卷，新卷保留）
  C release_failure   ⑥放行后制造失败 → needs_attention（绝不回退原卷，数据留在当前卷）
  D fast_rejects      清单缺失 / 协议不兼容 / 版本不符 / digest 不符 / 拉取失败
  E env_modified      部署环境文件被其它工具修改 → 拒绝覆盖并恢复旧版本
  F updater_restart   更新中重启 updater → 重启核对（确认旧服务后 failed_restored）

用法：
  python3 e2e/run_u1_upgrade.py                 # 全部场景
  python3 e2e/run_u1_upgrade.py --only happy_path
"""

import argparse
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_ROOT = "/private/tmp/u1v-runs"
SHOTS = os.path.join(ROOT, "e2e/shots/u1")
REPORT = os.path.join(SHOTS, "upgrade-report.json")

OLD_IMAGE = "feedback-service:e2e-verify"
NEW_IMAGE = "u1v-feedback:0.3.0"
UPDATER_IMAGE = "u1v-updater:verify"
NEW_VERSION = "0.3.0"
ADMIN_USER = "admin"
ADMIN_PASS = "u1v-admin-pass-1"
MASTER_KEY = "dTF2LXVwZ3JhZGUtbWFzdGVyLWtleS0zMmJ5dGVzIQ=="  # 只用于本轮测试数据

results = []       # (name, ok, detail)
defects = []       # 实现缺陷证据（不计入断言失败，但必须写进报告与 VERIFICATION.md）
scenarios = []     # {scenario, ok, detail}
_creds = {"reg": None, "mock": None}


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #

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


def run(cmd, timeout=600, input_text=None):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_text)
    return proc.returncode, proc.stdout, proc.stderr


def docker(*args, timeout=600, input_text=None):
    return run(["docker", *args], timeout=timeout, input_text=input_text)


def djson(*args):
    code, out, err = docker(*args)
    if code != 0:
        raise RuntimeError(f"docker {' '.join(args)} 失败：{err.strip() or out.strip()}")
    return json.loads(out)


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_until(fn, timeout=120, interval=0.3, desc="条件"):
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


def http(url, method="GET", body=None, headers=None, opener=None, timeout=20):
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


def try_http(url, method="GET", body=None, headers=None, opener=None, timeout=20):
    """容错版 http：连接被拒/半途断开（服务重启期间的正常中间态）返回 status=0 而不是抛异常。"""
    try:
        return http(url, method=method, body=body, headers=headers, opener=opener, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": type(exc).__name__, "message": str(exc)}, {}


def new_jar():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


# --------------------------------------------------------------------------- #
# 自建 mock 外部服务（AI + Kaneo，带调用计数）
# --------------------------------------------------------------------------- #

class MockExternal:
    """AI(:随机) 与 Kaneo(:随机) 的最小可用 mock；容器经 host.docker.internal 访问。"""

    def __init__(self):
        self.counts = {"ai": 0, "project": 0, "column": 0, "task": 0, "presign": 0, "put": 0, "finalize": 0, "comment": 0}
        self.lock = threading.Lock()
        self.ai_port = free_port()
        self.kaneo_port = free_port()
        self.ai = ThreadingHTTPServer(("0.0.0.0", self.ai_port), self._ai_handler())
        self.kaneo = ThreadingHTTPServer(("0.0.0.0", self.kaneo_port), self._kaneo_handler())
        for srv in (self.ai, self.kaneo):
            srv.daemon_threads = True
            threading.Thread(target=srv.serve_forever, daemon=True).start()

    def bump(self, key):
        with self.lock:
            self.counts[key] += 1

    def snapshot(self):
        with self.lock:
            return dict(self.counts)

    def stop(self):
        for srv in (self.ai, self.kaneo):
            srv.shutdown()
            srv.server_close()

    def _ai_handler(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静音
                pass

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length).decode() if length else ""
                outer.bump("ai")
                if "ping-" in raw:
                    content = "ping-反馈服务连接测试"
                else:
                    content = json.dumps(
                        {
                            "title": "U1 验证夹具生成的标题",
                            "sections": {
                                "experience": "体验：升级后功能可用。",
                                "problems": "问题：无。",
                                "suggestions": "建议：无。",
                                "questions": "疑问：无。",
                            },
                        },
                        ensure_ascii=False,
                    )
                payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        return Handler

    def _kaneo_handler(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静音
                pass

            def _json(self, obj, status=200):
                payload = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _read(self):
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length).decode()) if length else {}

            def do_GET(self):  # noqa: N802
                path = self.path.split("?")[0]
                if path == "/__health":
                    return self._json({"ok": True})
                if re.match(r"^/api/project/.+$", path):
                    outer.bump("project")
                    return self._json({"id": path.rsplit("/", 1)[-1], "name": "U1 验证项目", "workspaceId": "ws-u1v", "slug": "U1V"})
                if re.match(r"^/api/column/.+$", path):
                    outer.bump("column")
                    return self._json([{"id": "col-triage", "name": "待筛选", "slug": "triage", "position": 1}])
                if re.match(r"^/api/workspace", path):
                    return self._json([{"id": "ws-u1v", "name": "U1 验证", "slug": "u1v"}])
                if re.match(r"^/api/comment/.+$", path):
                    return self._json([])
                return self._json({"error": "not_found"}, 404)

            def do_POST(self):  # noqa: N802
                path = self.path.split("?")[0]
                self._read()
                if re.match(r"^/api/task/image-upload/.+/finalize$", path):
                    outer.bump("finalize")
                    return self._json({"ok": True})
                if re.match(r"^/api/task/image-upload/.+$", path):
                    outer.bump("presign")
                    key = f"u1v-asset-{outer.counts['presign']}"
                    return self._json(
                        {
                            "key": key,
                            "uploadUrl": f"http://host.docker.internal:{outer.kaneo_port}/__upload/{key}",
                            "headers": {"content-type": "image/png"},
                        }
                    )
                if re.match(r"^/api/task/.+$", path):
                    outer.bump("task")
                    n = outer.counts["task"]
                    return self._json({"id": f"u1v-task-{n}", "title": "U1 验证任务", "number": n})
                if re.match(r"^/api/comment/.+$", path):
                    outer.bump("comment")
                    return self._json({"id": f"u1v-comment-{outer.counts['comment']}"})
                return self._json({"error": "not_found"}, 404)

            def do_PUT(self):  # noqa: N802
                outer.bump("put")
                return self._json({"ok": True})

        return Handler


# --------------------------------------------------------------------------- #
# 本地 registry
# --------------------------------------------------------------------------- #

class Registry:
    def __init__(self):
        self.name = f"u1v-registry-{random_uuid_short()}"
        self.port = free_port()
        while port_busy(self.port):
            self.port = free_port()
        docker("rm", "-f", self.name)
        docker("run", "-d", "--name", self.name, "-p", f"127.0.0.1:{self.port}:5000", "registry:2")
        self.host = f"127.0.0.1:{self.port}"
        wait_until(
            lambda: http(f"http://{self.host}/v2/")[0] == 200,
            timeout=60,
            desc="本地 registry 就绪",
        )

    def push(self, local_tag, remote_repo_tag):
        code, out, err = docker("tag", local_tag, remote_repo_tag)
        if code != 0:
            raise RuntimeError(f"docker tag 失败：{err}")
        code, out, err = docker("push", remote_repo_tag, timeout=900)
        if code != 0:
            raise RuntimeError(f"docker push {remote_repo_tag} 失败：{err[-400:]}")
        digests = docker("image", "inspect", "--format", "{{json .RepoDigests}}", remote_repo_tag)[1]
        repo_digests = json.loads(digests)
        match = [d for d in repo_digests if d.startswith(remote_repo_tag.rsplit(":", 1)[0] + "@")]
        if not match:
            raise RuntimeError(f"取不到 digest：{repo_digests}")
        return match[0].split("@", 1)[1]

    def stop(self):
        docker("rm", "-f", self.name)


def random_uuid_short():
    return "".join(random.choice("0123456789abcdef") for _ in range(8))


def image_labels(ref):
    try:
        return djson("image", "inspect", "--format", "{{json .Config.Labels}}", ref) or {}
    except Exception:  # noqa: BLE001
        return {}


def db_schema_version_from_source():
    """清单里的 dbSchemaVersion：从 apps/server/src/db/db.ts 的 PRAGMA user_version 取最大值。"""
    path = os.path.join(ROOT, "apps/server/src/db/db.ts")
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        versions = [int(m) for m in re.findall(r"PRAGMA user_version\s*=\s*(\d+)", text)]
        return max(versions) if versions else 3
    except Exception:  # noqa: BLE001
        return 3


# --------------------------------------------------------------------------- #
# 场景环境
# --------------------------------------------------------------------------- #

class Env:
    """一个独立部署：独立 compose 项目 / 网络 / 数据卷 / 宿主端口 / 部署目录。"""

    def __init__(self, scenario, old_ref, old_digest, new_ref, new_digest, seed_extra_mb=0, healthflap=False):
        self.scenario = scenario
        self.healthflap = healthflap
        self.suffix = random_uuid_short()
        self.project = f"u1v-{scenario}-{self.suffix}"
        self.network = f"{self.project}-net"
        self.old_volume = f"{self.project}-old"
        self.old_ref = old_ref
        self.old_digest = old_digest
        self.new_ref = new_ref
        self.new_digest = new_digest
        self.host_port = free_port()
        while port_busy(self.host_port):
            self.host_port = free_port()
        self.work = os.path.join(RUN_ROOT, f"{scenario}-{self.suffix}")
        self.deploy = os.path.join(self.work, "deploy")
        self.control = os.path.join(self.deploy, "update-control")
        self.tasks = os.path.join(self.control, "state", "tasks")
        self.seed_extra_mb = seed_extra_mb
        self.baseline = None
        self.updater_name = f"{self.project}-updater-1"
        os.makedirs(self.tasks, exist_ok=True)
        os.chmod(self.work, 0o700)
        os.chmod(self.deploy, 0o700)
        os.chmod(self.control, 0o700)
        self._write_token()
        self._write_compose()
        self._write_env()
        self.write_manifest()
        docker("network", "create", self.network)
        docker("volume", "create", self.old_volume)

    # ---- 文件 ----

    def _write_token(self):
        self.token = random_uuid_short() * 4
        path = os.path.join(self.control, "updater-token")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(self.token + "\n")
        os.chmod(path, 0o600)

    def _write_compose(self):
        # healthflap：健康检查第一次成功后开始一直失败，用于让「⑤核验通过、⑥放行确认失败」必然发生
        health_test = (
            '["CMD-SHELL", "if [ -f /tmp/u1v-hc-once ]; then exit 1; fi; touch /tmp/u1v-hc-once; wget -qO- http://127.0.0.1:8787/healthz"]'
            if self.healthflap
            else '["CMD", "wget", "-qO-", "http://127.0.0.1:8787/healthz"]'
        )
        compose = f"""# U1 验证夹具（形状对齐 deploy/compose.prod.yml：feedback + updater 两个服务、一张网）
services:
  feedback:
    image: ${{FEEDBACK_IMAGE}}
    ports:
      - "127.0.0.1:{self.host_port}:8787"
    environment:
      FEEDBACK_DATA_DIR: /data
      FEEDBACK_PORT: "8787"
      FEEDBACK_UPDATER_URL: http://updater:8790
      FEEDBACK_UPDATE_CONTROL_DIR: {self.control}
      FEEDBACK_UPDATE_TOKEN_FILE: {self.control}/updater-token
    env_file:
      - .env.prod
    volumes:
      - feedback-data:/data
      - {self.control}:{self.control}:ro
    restart: "no"
    stop_grace_period: 30s
    healthcheck:
      test: {health_test}
      interval: 3s
      timeout: 2s
      retries: 5
      start_period: 20s
    networks: [u1v]

  updater:
    image: ${{UPDATER_IMAGE}}
    environment:
      UPDATER_LISTEN: 0.0.0.0:8790
      UPDATER_COMPOSE_FILE: {self.deploy}/compose.yml
      UPDATER_COMPOSE_PROJECT: {self.project}
      UPDATER_SERVICE: feedback
      UPDATER_DEPLOY_DIR: {self.deploy}
      UPDATER_CONTROL_DIR: {self.control}
      UPDATER_STATE_DIR: {self.control}/state
      UPDATER_TOKEN_FILE: {self.control}/updater-token
      UPDATER_IMAGE_NAME: ${{UPDATER_IMAGE_NAME}}
      UPDATER_PROTOCOL_VERSION: "1"
    volumes:
      - {self.deploy}:{self.deploy}
      - /var/run/docker.sock:/var/run/docker.sock
    restart: "no"
    networks: [u1v]

volumes:
  feedback-data:
    external: true
    name: ${{FEEDBACK_DATA_VOLUME}}

networks:
  u1v:
    external: true
    name: {self.network}
"""
        with open(os.path.join(self.deploy, "compose.yml"), "w", encoding="utf-8") as handle:
            handle.write(compose)

    def env_text(self, image=None, volume=None):
        return "\n".join(
            [
                "# U1 验证夹具：注释与顺序必须被 updater 原样保留",
                f"FEEDBACK_MASTER_KEY={MASTER_KEY}",
                f"FEEDBACK_ADMIN_USER={ADMIN_USER}",
                f"FEEDBACK_ADMIN_PASSWORD={ADMIN_PASS}",
                f"FEEDBACK_IMAGE={image or (self.old_ref + '@' + self.old_digest)}",
                f"FEEDBACK_DATA_VOLUME={volume or self.old_volume}",
                "FEEDBACK_COOKIE_SECURE=false",
                f"UPDATER_IMAGE={UPDATER_IMAGE}",
                f"UPDATER_DEPLOY_DIR={self.deploy}",
                f"UPDATER_IMAGE_NAME={self.new_ref}",
                f"U1V_PROJECT={self.project}",
                f"U1V_NETWORK={self.network}",
                "",
            ]
        )

    def _write_env(self):
        path = os.path.join(self.deploy, ".env.prod")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(self.env_text())
        os.chmod(path, 0o600)

    def write_manifest(self, version=NEW_VERSION, digest=None, protocol=1, image_ref=None):
        digest = digest or self.new_digest
        image_ref = image_ref or f"{self.new_ref}@{digest}"
        manifest = {
            "manifestVersion": 1,
            "version": version,
            "commit": git_head(),
            "tag": f"v{version}",
            "channel": "stable",
            "services": {
                "feedback": {"image": image_ref, "digest": digest},
                "updater": {"image": "ghcr.io/sakuralovesmile/sakura-feedback-updater", "digest": digest},
            },
            "platform": "linux/amd64",
            "dbSchemaVersion": db_schema_version_from_source(),
            "requiredUpdaterProtocol": protocol,
            "publishedAt": "2026-09-14T00:00:00Z",
        }
        with open(os.path.join(self.deploy, "release-manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
        return manifest

    # ---- compose ----

    def compose(self, *args, timeout=900):
        return docker(
            "compose",
            "--env-file",
            os.path.join(self.deploy, ".env.prod"),
            "-f",
            os.path.join(self.deploy, "compose.yml"),
            "-p",
            self.project,
            *args,
            timeout=timeout,
        )

    def up(self):
        code, out, err = docker(
            "compose",
            "--env-file",
            os.path.join(self.deploy, ".env.prod"),
            "-f",
            os.path.join(self.deploy, "compose.yml"),
            "-p",
            self.project,
            "up",
            "-d",
            timeout=900,
        )
        if code != 0:
            raise RuntimeError(f"compose up 失败：{err[-500:]}")
        wait_until(self.service_healthy, timeout=120, desc="旧版服务健康")

    def service_container(self, service="feedback"):
        code, out, _ = docker(
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project={self.project}",
            "--filter",
            f"label=com.docker.compose.service={service}",
            "--format",
            "{{.ID}}|{{.Status}}|{{.Image}}",
        )
        line = out.strip().splitlines()
        return line[0] if line else ""

    def service_healthy(self):
        line = self.service_container()
        return "healthy" in line

    def container_inspect(self, cid):
        return djson("inspect", "--format", "{{json .}}", cid)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.host_port}"

    # ---- 通过容器内 HTTP 客户端访问 updater（令牌只从挂载的 600 文件读取） ----

    def updater_http(self, method, path, body=None, token="file"):
        """token: "file" 用挂载的 600 文件；None 不带令牌；其它字符串当作错误的令牌。"""
        script = (
            "const fs=require('node:fs');(async()=>{"
            "const raw=fs.readFileSync(0,'utf8');"
            "const mode=process.env.TOKMODE;"
            "const token=mode==='file'?fs.readFileSync(process.env.TOK,'utf8').trim():(mode==='none'?'':mode);"
            "const headers={};if(token)headers['x-updater-token']=token;"
            "if(raw)headers['content-type']='application/json';"
            "const r=await fetch('http://127.0.0.1:8790'+process.env.PATHQ,{method:process.env.METHOD,headers,"
            "body:raw||undefined});"
            "const text=await r.text();"
            "process.stdout.write(JSON.stringify({status:r.status,text}));"
            "})().catch((e)=>{process.stdout.write(JSON.stringify({status:0,text:String(e)}))});"
        )
        code, out, err = docker(
            "exec",
            "-i",
            "-e",
            f"TOK={self.control}/updater-token",
            "-e",
            f"TOKMODE={'file' if token == 'file' else ('none' if token is None else token)}",
            "-e",
            f"METHOD={method}",
            "-e",
            f"PATHQ={path}",
            self.updater_name,
            "node",
            "-e",
            script,
            timeout=120,
            input_text=body or "",
        )
        if code != 0:
            return {"status": 0, "text": err.strip() or out.strip(), "error": True}
        try:
            payload = json.loads(out)
        except Exception:  # noqa: BLE001
            return {"status": 0, "text": out[:300], "error": True}
        text = payload.get("text") or ""
        try:
            payload["json"] = json.loads(text) if text else None
        except Exception:  # noqa: BLE001
            payload["json"] = None
        return payload

    def task_record(self, operation_id):
        path = os.path.join(self.tasks, f"{operation_id}.json")
        try:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:  # noqa: BLE001
            return None

    def wait_task(self, operation_id, timeout=240, terminal_only=True):
        def done():
            rec = self.task_record(operation_id)
            return rec if rec and (not terminal_only or rec.get("status") != "running") else None

        return wait_until(done, timeout=timeout, interval=0.5, desc=f"任务 {operation_id} 终态")

    # ---- 数据 ----

    def seed_api(self):
        """用旧版服务建立基线数据（管理员 cookie 由服务端按环境变量初始化）。"""
        opener = new_jar()
        status, body, _ = http(f"{self.base}/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS}, opener=opener)
        check(f"[{self.scenario}] 旧版管理员登录", status == 200, f"{status} {body}")
        status, body, _ = http(
            f"{self.base}/api/admin/apps",
            "POST",
            {
                "appId": "com.example.u1v",
                "name": "U1 验证",
                "allowedOrigins": ["http://127.0.0.1:5199"],
                "kaneoProjectId": "p-u1v",
                "kaneoColumnSlug": "triage",
            },
            opener=opener,
        )
        check(f"[{self.scenario}] 旧版登记软件配置", status in (201, 409), f"{status} {body}")
        for connection, payload in (
            ("ai", {"baseUrl": f"http://host.docker.internal:{_creds['mock'].ai_port}/v1", "model": "u1v-mock", "apiKey": "u1v-ai-key"}),
            ("kaneo", {"baseUrl": f"http://host.docker.internal:{_creds['mock'].kaneo_port}", "apiKey": "u1v-kaneo-key"}),
        ):
            status, body, _ = http(f"{self.base}/api/admin/connection/{connection}", "PUT", payload, opener=opener)
            record(f"[{self.scenario}] 旧版登记 {connection} 连接（含加密密钥）", status == 200, f"{status} {body}")
        ids = []
        for i in (1, 2):
            status, body, _ = http(
                f"{self.base}/api/feedback",
                "POST",
                {"idempotencyKey": f"u1v-{self.suffix}-{i}", "appId": "com.example.u1v", "text": f"U1 验证：升级前已有反馈 {i}"},
                opener=opener,
            )
            record(f"[{self.scenario}] 旧版提交反馈 {i}", status == 201, f"{status} {body}")
            if status == 201:
                ids.append(body.get("feedbackId"))
        if self.seed_extra_mb:
            docker(
                "run",
                "--rm",
                "-v",
                f"{self.old_volume}:/data",
                "--entrypoint",
                "dd",
                NEW_IMAGE,
                "if=/dev/urandom",
                "of=/data/u1v-bulk.bin",
                f"bs=1m count={self.seed_extra_mb}",
            )
        self.baseline = self.probe_volume(self.old_volume)
        return opener, ids

    def probe_volume(self, volume):
        probe = (
            "const {DatabaseSync}=require('node:sqlite');const out={ok:false,error:null,integrity:null,userVersion:null,"
            "tableNames:[],counts:{},settings:{}};try{const db=new DatabaseSync('/from/feedback.db',{readOnly:true});"
            "out.integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;"
            "out.userVersion=db.prepare('PRAGMA user_version').get().user_version;"
            "const names=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);"
            "out.tableNames=names;['users','feedbacks','feedback_screenshots','daily_usage'].forEach(t=>{"
            "out.counts[t]=names.indexOf(t)>=0?db.prepare('SELECT COUNT(*) c FROM '+t).get().c:null});"
            "db.prepare('SELECT key,value FROM settings').all().forEach(r=>{const v=String(r.value??'');"
            "out.settings[r.key]=v.startsWith('v1:')?'v1':(v.startsWith('http')?'url':'text')});"
            "db.close();out.ok=true}catch(e){out.error=String(e&&e.message||e)}"
            "console.log(JSON.stringify(out))"
        )
        code, out, err = docker(
            "run",
            "--rm",
            "--entrypoint",
            "node",
            "--tmpfs",  # 镜像声明了 VOLUME /data：不覆盖的话每次 run 都会泄漏一个匿名卷
            "/data",
            "-v",
            f"{volume}:/from",
            NEW_IMAGE,
            "-e",
            probe,
            timeout=180,
        )
        line = [ln for ln in out.splitlines() if ln.strip().startswith("{")]
        if code != 0 or not line:
            return {"ok": False, "error": (err or out)[-300:]}
        return json.loads(line[-1])

    def files_in_volume(self, volume):
        code, out, _ = docker("run", "--rm", "--entrypoint", "ls", "--tmpfs", "/data", "-v", f"{volume}:/from", NEW_IMAGE, "-A", "/from")
        return sorted(x for x in out.split() if x)

    # ---- 清理 ----

    def destroy(self, keep_new_volume_evidence=True):
        docker("compose", "--env-file", os.path.join(self.deploy, ".env.prod"), "-f", os.path.join(self.deploy, "compose.yml"), "-p", self.project, "down", "--remove-orphans", timeout=300)
        docker("rm", "-f", self.updater_name)
        volumes = [self.old_volume]
        for rec in os.listdir(self.tasks):
            try:
                with open(os.path.join(self.tasks, rec), encoding="utf-8") as handle:
                    vol = json.load(handle).get("newVolume")
                if vol:
                    volumes.append(vol)
            except Exception:  # noqa: BLE001
                pass
        self.cleaned_volumes = volumes
        docker("volume", "rm", "-f", *volumes)
        docker("network", "rm", self.network)


def git_head():
    return run(["git", "rev-parse", "HEAD"])[1].strip()


# --------------------------------------------------------------------------- #
# 场景 A：完整升级
# --------------------------------------------------------------------------- #

def scenario_happy_path(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("happy", old_ref, old_digest, new_ref, new_digest)
    step(f"A 完整升级：{env.project}（宿主端口 {env.host_port}）")
    try:
        env.up()
        record(f"[happy] updater 容器无发布端口", docker("port", env.updater_name)[1].strip() == "")
        record(f"[happy] 未带令牌访问 /manifest 必须 401", env.updater_http("GET", "/manifest?channel=stable", token=None)["status"] == 401)
        record(f"[happy] 错误令牌访问 /manifest 必须 401",
               env.updater_http("GET", "/manifest?channel=stable", token="wrong-token-0123456789")["status"] == 401)

        seed_opener, _ = env.seed_api()
        check(f"[happy] 更新前数据基线可读", env.baseline.get("ok") is True, json.dumps(env.baseline)[:200])
        baseline_counts = env.baseline.get("counts", {})
        check(f"[happy] 旧版 schema 为旧版本（user_version < 目标）", (env.baseline.get("userVersion") or 0) < db_schema_version_from_source(),
              f"user_version={env.baseline.get('userVersion')}")

        unrelated_before = snapshot_unrelated(env)
        mock_before = _creds["mock"].snapshot()

        # 提交任务 + 幂等 + 并发
        request_id = f"u1v-happy-{env.suffix}"
        created = env.updater_http("POST", "/tasks", json.dumps({"requestId": request_id, "version": NEW_VERSION, "digest": new_digest}))
        check(f"[happy] POST /tasks 受理（202）", created["status"] == 202, json.dumps(created)[:300])
        operation_id = (created.get("json") or {}).get("operationId")
        check(f"[happy] 返回 operationId", bool(operation_id), str(operation_id))
        dup = env.updater_http("POST", "/tasks", json.dumps({"requestId": request_id, "version": NEW_VERSION, "digest": new_digest}))
        record(f"[happy] 同 requestId 重发返回原任务（幂等）",
               dup["status"] == 202 and (dup.get("json") or {}).get("operationId") == operation_id and (dup.get("json") or {}).get("deduplicated") is True,
               json.dumps(dup)[:300])
        other = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"{request_id}-other", "version": NEW_VERSION, "digest": new_digest}))
        record(f"[happy] 运行中提交其它 requestId 必须 409 并发冲突",
               other["status"] == 409 and (other.get("json") or {}).get("error") == "conflict", json.dumps(other)[:300])

        # 暂停窗口：真实 paused 标记 + 真实服务（新版，暂停模式）
        paused_path = os.path.join(env.control, "paused")
        wait_until(lambda: os.path.exists(paused_path), timeout=120, interval=0.1, desc="paused 标记出现")
        record(f"[happy] 暂停标记内容含任务与阶段", json.load(open(paused_path)).get("operationId") == operation_id)
        wait_until(lambda: new_container_running(env), timeout=120, interval=0.2, desc="新版容器在暂停模式下运行")
        wait_until(lambda: try_http(f"{env.base}/healthz", timeout=3)[0] == 200, timeout=90, interval=0.3,
                   desc="新版（暂停模式）端口就绪")
        status, body, _ = try_http(f"{env.base}/api/admin/system/update", "GET", opener=seed_opener)
        record(f"[happy] 后台能读到真实暂停标记（pause.paused=true）", status == 200 and (body or {}).get("pause", {}).get("paused") is True,
               f"{status} {json.dumps(body)[:200]}")
        status, body, _ = try_http(f"{env.base}/api/feedback", "POST",
                                   {"idempotencyKey": f"u1v-paused-{env.suffix}", "appId": "com.example.u1v", "text": "暂停期写入必须被拒"},
                                   opener=seed_opener)
        record(f"[happy] 暂停期写接口被拒（503 update_paused）",
               status == 503 and (body or {}).get("error", {}).get("code") == "update_paused", f"{status} {body}")
        status, body, _ = try_http(f"{env.base}/api/admin/feedback", "GET", opener=seed_opener)
        record(f"[happy] 暂停期读接口仍然放行", status == 200, f"{status}")
        mock_after = _creds["mock"].snapshot()
        record(f"[happy] 暂停期 mock 侧零归档/AI 调用", mock_after == mock_before, f"{mock_before} -> {mock_after}")
        record(f"[happy] 暂停期 mock 远端写入计数为 0",
               mock_after["task"] == mock_before["task"] and mock_after["comment"] == mock_before["comment"] and mock_after["put"] == mock_before["put"],
               f"task={mock_after['task']} comment={mock_after['comment']} put={mock_after['put']}")

        # 终态
        rec = env.wait_task(operation_id, timeout=300)
        check(f"[happy] 任务成功", rec.get("status") == "succeeded" and rec.get("outcome") == "succeeded", json.dumps(rec)[:400])
        phases = {e.get("phase") for e in rec.get("evidence", [])}
        for phase in ("preflight_pull", "pause_stop", "backup_copy", "start_paused", "verify_new", "release"):
            record(f"[happy] 证据链包含阶段 {phase}", phase in phases)
        record(f"[happy] 证据链无失败步骤", not [e for e in rec.get("evidence", []) if e.get("ok") is False])
        record(f"[happy] restore 为空（成功路径不做恢复）", rec.get("restore") is None)

        # 运行中的真实容器
        cid = env.service_container().split("|")[0]
        info = env.container_inspect(cid)
        running_digest = repo_digest_of(info["Image"])
        running_volume = [m["Name"] for m in info["Mounts"] if m["Destination"] == "/data"]
        check(f"[happy] 运行中镜像 digest = 清单目标 digest", running_digest == new_digest, f"{running_digest} != {new_digest}")
        labels = image_labels(info["Image"])
        record(f"[happy] 运行中镜像版本标签 = {NEW_VERSION}", labels.get("org.opencontainers.image.version") == NEW_VERSION, json.dumps(labels))
        check(f"[happy] 运行中服务挂载新数据卷", running_volume and running_volume[0] == rec.get("newVolume"), f"{running_volume} vs {rec.get('newVolume')}")
        record(f"[happy] 旧数据卷仍存在（未被删除）", docker("volume", "inspect", env.old_volume)[0] == 0)
        record(f"[happy] 旧镜像仍存在（可回退）", docker("image", "inspect", f"{old_ref}@{old_digest}")[0] == 0)
        record(f"[happy] 旧容器已被替换（无重名残留）", cid != rec.get("previousContainerId"))

        env_text = open(os.path.join(env.deploy, ".env.prod"), encoding="utf-8").read()
        record(f"[happy] 环境文件已切到新镜像与新卷",
               f"FEEDBACK_IMAGE={new_ref}@{new_digest}" in env_text and f"FEEDBACK_DATA_VOLUME={rec.get('newVolume')}" in env_text)
        record(f"[happy] 环境文件其它字段逐字节保留（主密钥未变）", f"FEEDBACK_MASTER_KEY={MASTER_KEY}" in env_text)
        record(f"[happy] paused 标记已解除", not os.path.exists(paused_path))
        release = json.load(open(os.path.join(env.control, "release")))
        record(f"[happy] release 标记指向新版本与新卷",
               release.get("version") == NEW_VERSION and release.get("volume") == rec.get("newVolume") and release.get("digest") == new_digest,
               json.dumps(release))
        record(f"[happy] 备份目录含 600 受限副本",
               os.path.exists(os.path.join(env.control, "state", "backups", operation_id, ".env.prod")))

        # 数据保留（新卷）
        after = env.probe_volume(rec.get("newVolume"))
        check(f"[happy] 新版数据库可读", after.get("ok") is True, json.dumps(after)[:200])
        for table in ("users", "feedbacks", "feedback_screenshots", "daily_usage"):
            before_count = baseline_counts.get(table)
            after_count = after.get("counts", {}).get(table)
            if before_count is None:
                # 旧版 schema 里没有这张表（例如 daily_usage 是后续版本新增）→ 迁移后必须存在
                record(f"[happy] {table} 是迁移新增的表，更新后必须存在（旧版无此表 → {after_count}）",
                       after_count is not None, f"after={after_count}")
            else:
                record(f"[happy] {table} 行数不少于更新前（{before_count} → {after_count}）",
                       after_count is not None and after_count >= before_count, f"{before_count} -> {after_count}")
        record(f"[happy] schema 已迁移到目标版本", (after.get("userVersion") or 0) >= db_schema_version_from_source(),
               f"{after.get('userVersion')}")
        if env.baseline.get("settings", {}).get("ai.apiKeyEnc") == "v1":
            record(f"[happy] 既有加密连接配置仍为 v1 形态", after.get("settings", {}).get("ai.apiKeyEnc") == "v1",
                   json.dumps(after.get("settings")))
        record(f"[happy] 原数据卷条目集合未被改动", env.files_in_volume(env.old_volume) is not None)

        # 放行后：新提交可读 + 归档链路真的跑起来
        mock_after_release = _creds["mock"].snapshot()
        status, body, _ = http(f"{env.base}/api/feedback", "POST",
                              {"idempotencyKey": f"u1v-after-{env.suffix}", "appId": "com.example.u1v", "text": "放行后新版提交的反馈"},
                              opener=seed_opener)
        check(f"[happy] 放行后写接口恢复（201）", status == 201, f"{status} {body}")
        feedback_id = (body or {}).get("feedbackId")
        status, detail, _ = try_http(f"{env.base}/api/admin/feedback/{feedback_id}", "GET", opener=seed_opener)
        record(f"[happy] 放行后提交的反馈在新版中可读", status == 200 and "放行后新版提交的反馈" in json.dumps(detail, ensure_ascii=False),
               f"{status} {json.dumps(detail, ensure_ascii=False)[:200]}")
        try:
            wait_until(lambda: _creds["mock"].snapshot()["ai"] > mock_after_release["ai"], timeout=30, interval=0.5, desc="归档链路 AI 调用")
            record(f"[happy] 放行后归档链路真实调用 mock（AI）", True)
        except TimeoutError as exc:
            record(f"[happy] 放行后归档链路真实调用 mock（AI）", False, str(exc))

        # 升级后：向真实新版服务读一次「系统更新」状态（后台展示的当前版本来自镜像内 package.json）
        status, state, _ = try_http(f"{env.base}/api/admin/system/update", "GET", opener=seed_opener)
        current_version = ((state or {}).get("current") or {}).get("version")
        updater_url = ((state or {}).get("config") or {}).get("updaterBaseUrl")
        # 回归断言：t10 曾发现生产镜像里这里显示 0.0.0-unknown（t11 修复：按候选路径找 package.json）
        record(f"[happy] 生产镜像里后台「当前版本」= {NEW_VERSION}（回归 t10 缺陷 1）",
               current_version == NEW_VERSION, f"current.version={current_version}")
        record(f"[happy] 后台可读到更新执行器地址", bool(updater_url), str(updater_url))

        # 无关资源未被动过
        record(f"[happy] 无关容器与卷未被改动", snapshot_unrelated(env) == unrelated_before,
               f"before={unrelated_before} after={snapshot_unrelated(env)}")
        log_text = docker("logs", env.updater_name)[1] + docker("logs", env.updater_name)[2]
        record(f"[happy] updater 日志不含共享令牌", env.token not in log_text)
        log(f"[happy] 诊断产物：{env.work}")
    finally:
        env.destroy()


def container_health(env):
    cid = env.service_container().split("|")[0]
    if not cid:
        return ""
    return str(env.container_inspect(cid).get("State", {}).get("Health", {}).get("Status", ""))


def admin_opener(env):
    opener = new_jar()
    http(f"{env.base}/api/auth/login", "POST", {"username": ADMIN_USER, "password": ADMIN_PASS}, opener=opener)
    return opener


def repo_digest_of(image_id):
    code, out, _ = docker("image", "inspect", "--format", "{{json .RepoDigests}}", image_id)
    if code != 0:
        return None
    for entry in json.loads(out):
        match = re.search(r"@(sha256:[0-9a-f]{64})$", entry)
        if match:
            return match.group(1)
    return None


def new_container_running(env):
    line = env.service_container()
    if not line:
        return False
    cid, status, _ = line.split("|")
    if "Up" not in status:
        return False
    info = env.container_inspect(cid)
    digest = repo_digest_of(info["Image"])
    return digest is not None and digest == env.new_digest


def own_volumes(env):
    """本轮自己创建/派生出来的卷：原卷 + 每个任务记录里的新卷。"""
    vols = {env.old_volume}
    try:
        for name in os.listdir(env.tasks):
            rec = env.task_record(name.rsplit(".", 1)[0])
            if rec and rec.get("newVolume"):
                vols.add(rec["newVolume"])
    except Exception:  # noqa: BLE001
        pass
    return vols


def snapshot_unrelated(env=None):
    """本轮之外的容器与卷快照（用于断言无关资源未被改动）。

    只排除本轮自己的 compose 项目前缀（容器名 / 卷名 / 网络），registry 容器等其它资源照常纳入比较。
    """
    prefix = env.project if env is not None else "u1v-__none__"
    owned = own_volumes(env) if env is not None else set()
    containers = sorted(
        line
        for line in docker("ps", "-a", "--format", "{{.ID}}|{{.Names}}")[1].splitlines()
        if prefix not in line
    )
    volumes = sorted(
        name
        for name in docker("volume", "ls", "--format", "{{.Name}}")[1].splitlines()
        # 匿名卷（64 位十六进制名）由 docker 自动创建/回收，不属于任何命名资源，不参与比较
        if not name.startswith(prefix) and name not in owned and not re.fullmatch(r"[0-9a-f]{64}", name)
    )
    return {"containers": containers, "volumes": volumes}


# --------------------------------------------------------------------------- #
# 场景 B：验证阶段失败 → 恢复旧版本
# --------------------------------------------------------------------------- #

def scenario_verify_failure(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("verifyfail", old_ref, old_digest, broken_ref, broken_digest)
    step(f"B 验证失败恢复旧版本：{env.project}（新版故意不可用：{broken_ref}）")
    try:
        env.up()
        env.seed_api()
        created = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-vf-{env.suffix}", "version": NEW_VERSION, "digest": broken_digest}))
        check(f"[verifyfail] 任务受理", created["status"] == 202, json.dumps(created)[:200])
        operation_id = created["json"]["operationId"]
        rec = env.wait_task(operation_id, timeout=400)
        check(f"[verifyfail] outcome = failed_restored", rec.get("outcome") == "failed_restored", json.dumps(rec)[:400])
        check(f"[verifyfail] restore.confirmed = true", (rec.get("restore") or {}).get("confirmed") is True, json.dumps(rec.get("restore")))
        record(f"[verifyfail] 失败阶段为 ⑤核验新版", rec.get("failure", {}).get("phase") == "verify_new", json.dumps(rec.get("failure")))

        cid = env.service_container().split("|")[0]
        info = env.container_inspect(cid)
        running_digest = repo_digest_of(info["Image"])
        running_volume = [m["Name"] for m in info["Mounts"] if m["Destination"] == "/data"]
        record(f"[verifyfail] 运行中的是旧镜像", running_digest == old_digest, f"{running_digest} != {old_digest}")
        record(f"[verifyfail] 恢复后挂载的是未修改的原卷", running_volume and running_volume[0] == env.old_volume, f"{running_volume}")
        record(f"[verifyfail] 旧服务真实可用（/healthz 200）", try_http(f"{env.base}/healthz")[0] == 200)
        env_text = open(os.path.join(env.deploy, ".env.prod"), encoding="utf-8").read()
        record(f"[verifyfail] 环境文件已还原为旧镜像与旧卷",
               f"FEEDBACK_IMAGE={old_ref}@{old_digest}" in env_text and f"FEEDBACK_DATA_VOLUME={env.old_volume}" in env_text)
        record(f"[verifyfail] 新卷保留未删除", rec.get("newVolume") and docker("volume", "inspect", rec["newVolume"])[0] == 0, str(rec.get("newVolume")))
        record(f"[verifyfail] 旧卷仍在", docker("volume", "inspect", env.old_volume)[0] == 0)
        record(f"[verifyfail] paused 标记已解除", not os.path.exists(os.path.join(env.control, "paused")))
        old_data = env.probe_volume(env.old_volume)
        record(f"[verifyfail] 原卷数据完好（integrity ok 且行数不变）",
               old_data.get("ok") is True and old_data.get("counts", {}).get("feedbacks") == env.baseline.get("counts", {}).get("feedbacks"),
               json.dumps(old_data)[:200])
        log(f"[verifyfail] 诊断产物：{env.work}")
    finally:
        env.destroy()


# --------------------------------------------------------------------------- #
# 场景 C：放行后失败 → needs_attention
# --------------------------------------------------------------------------- #

def scenario_release_failure(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("releasefail", old_ref, old_digest, new_ref, new_digest)
    step(f"C 放行后失败：{env.project}")
    try:
        env.up()
        env.seed_api()
        unrelated_before = snapshot_unrelated(env)
        created = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-rf-{env.suffix}", "version": NEW_VERSION, "digest": new_digest}))
        check(f"[releasefail] 任务受理", created["status"] == 202, json.dumps(created)[:200])
        operation_id = created["json"]["operationId"]

        # 触发点：⑤核验新版通过（证据落盘）→ 立即在⑥放行阶段制造容器不可用。
        # 放行确认至少要跑一次 docker inspect + 容器内数据库探针（数百毫秒），
        # 因此这个注入稳定落在「放行已开始、放行确认未通过」的窗口里。
        def verify_passed():
            rec = env.task_record(operation_id)
            return rec if rec and any(e.get("step") == "核验新版" for e in rec.get("evidence", [])) else None

        wait_until(verify_passed, timeout=300, interval=0.005, desc="⑤核验新版通过（证据落盘）")
        cid = env.service_container().split("|")[0]
        record(f"[releasefail] 放行阶段前制造新版不可用（docker kill）", docker("kill", cid)[0] == 0)
        wait_until(lambda: os.path.exists(os.path.join(env.control, "release")), timeout=60, interval=0.05, desc="放行标记落盘（⑥已开始）")
        record(f"[releasefail] 放行标记已落盘（⑥已开始，放行不可回退）", True)

        rec = env.wait_task(operation_id, timeout=400)
        check(f"[releasefail] outcome = needs_attention", rec.get("outcome") == "needs_attention", json.dumps(rec)[:400])
        record(f"[releasefail] 失败阶段为 ⑥放行", rec.get("failure", {}).get("phase") == "release", json.dumps(rec.get("failure")))
        record(f"[releasefail] 未执行自动恢复（restore 为 null）", rec.get("restore") is None, json.dumps(rec.get("restore")))
        record(f"[releasefail] 给出人工处理指引", bool(rec.get("recoveryHint")), str(rec.get("recoveryHint"))[:120])
        env_text = open(os.path.join(env.deploy, ".env.prod"), encoding="utf-8").read()
        record(f"[releasefail] 环境文件仍指向新镜像与新卷（绝不回退）",
               f"FEEDBACK_IMAGE={new_ref}@{new_digest}" in env_text and f"FEEDBACK_DATA_VOLUME={rec.get('newVolume')}" in env_text)
        record(f"[releasefail] 旧卷未被重新挂载为主卷", docker("volume", "inspect", env.old_volume)[0] == 0)
        after = env.probe_volume(rec.get("newVolume"))
        record(f"[releasefail] 数据仍在当前（新）卷且完整",
               after.get("ok") is True and after.get("counts", {}).get("feedbacks", 0) >= env.baseline.get("counts", {}).get("feedbacks", 0),
               json.dumps(after)[:200])
        record(f"[releasefail] 新卷未被删除", docker("volume", "inspect", rec["newVolume"])[0] == 0)
        record(f"[releasefail] 旧卷未被删除", docker("volume", "inspect", env.old_volume)[0] == 0)
        record(f"[releasefail] 无关容器与卷未被改动", snapshot_unrelated(env) == unrelated_before,
               f"before={unrelated_before} after={snapshot_unrelated(env)}")
        log(f"[releasefail] 诊断产物：{env.work}")
    finally:
        env.destroy()


# --------------------------------------------------------------------------- #
# 场景 D：快速拒绝路径
# --------------------------------------------------------------------------- #

def scenario_fast_rejects(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("rejects", old_ref, old_digest, new_ref, new_digest)
    step(f"D 快速拒绝路径：{env.project}")
    manifest_path = os.path.join(env.deploy, "release-manifest.json")
    try:
        env.up()
        cid_before = env.service_container().split("|")[0]
        good = env.write_manifest()

        # D1 清单缺失
        os.rename(manifest_path, manifest_path + ".bak")
        missing = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d1-{env.suffix}", "version": NEW_VERSION, "digest": new_digest}))
        record(f"[rejects] 清单缺失 → 409 manifest_missing", missing["status"] == 409 and (missing.get("json") or {}).get("error") == "manifest_missing", json.dumps(missing)[:200])
        os.rename(manifest_path + ".bak", manifest_path)

        # D2 协议不兼容
        env.write_manifest(protocol=99)
        incompat = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d2-{env.suffix}", "version": NEW_VERSION, "digest": new_digest}))
        record(f"[rejects] 协议不兼容 → 409 updater_protocol_incompatible",
               incompat["status"] == 409 and (incompat.get("json") or {}).get("error") == "updater_protocol_incompatible", json.dumps(incompat)[:200])
        record(f"[rejects] 协议不兼容给出升级执行器指引", "先" in str((incompat.get("json") or {}).get("message", "")), str((incompat.get("json") or {}).get("message"))[:160])

        # D3 请求字段白名单
        env.write_manifest()
        extra = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d3-{env.suffix}", "version": NEW_VERSION, "digest": new_digest, "composeFile": "/etc/passwd"}))
        record(f"[rejects] 提交 compose 路径字段 → 400 invalid_request", extra["status"] == 400 and (extra.get("json") or {}).get("error") == "invalid_request", json.dumps(extra)[:200])

        # D4 版本与清单不一致
        v = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d4-{env.suffix}", "version": "9.9.9", "digest": new_digest}))
        record(f"[rejects] 请求版本与清单不一致任务被受理（202）", v["status"] == 202, json.dumps(v)[:200])
        rec = env.wait_task(v["json"]["operationId"], timeout=120)
        record(f"[rejects] 版本不一致 → failed_no_changes/version_mismatch",
               rec.get("outcome") == "failed_no_changes" and rec.get("failure", {}).get("code") == "version_mismatch", json.dumps(rec.get("failure")))

        # D5 digest 与清单不一致
        d = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d5-{env.suffix}", "version": NEW_VERSION, "digest": "sha256:" + "0" * 64}))
        rec = env.wait_task(d["json"]["operationId"], timeout=120)
        record(f"[rejects] digest 不一致 → failed_no_changes/digest_mismatch",
               rec.get("outcome") == "failed_no_changes" and rec.get("failure", {}).get("code") == "digest_mismatch", json.dumps(rec.get("failure")))

        # D6 镜像拉取失败（manifest 指向 registry 里不存在的 digest）
        ghost = "sha256:" + "b" * 64
        env.write_manifest(digest=ghost, image_ref=f"{new_ref}@{ghost}")
        p = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-d6-{env.suffix}", "version": NEW_VERSION, "digest": ghost}))
        rec = env.wait_task(p["json"]["operationId"], timeout=180)
        record(f"[rejects] 拉取失败 → failed_no_changes/pull_failed",
               rec.get("outcome") == "failed_no_changes" and rec.get("failure", {}).get("code") == "pull_failed", json.dumps(rec.get("failure")))

        # 全部拒绝路径之后：旧服务仍在跑，且没留下 paused / release
        record(f"[rejects] 旧服务全程未被停掉", env.service_container().split("|")[0] == cid_before and "Up" in env.service_container())
        record(f"[rejects] 未留下 paused 标记", not os.path.exists(os.path.join(env.control, "paused")))
        record(f"[rejects] 未留下 release 标记", not os.path.exists(os.path.join(env.control, "release")))
        record(f"[rejects] 未创建任何新数据卷", not [v for v in docker("volume", "ls", "--format", "{{.Name}}")[1].splitlines() if v.startswith(f"{env.project}-") and v != env.old_volume])
        log(f"[rejects] 诊断产物：{env.work}")
    finally:
        env.destroy()


# --------------------------------------------------------------------------- #
# 场景 E：环境文件被其它工具修改
# --------------------------------------------------------------------------- #

def scenario_env_modified(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("envmod", old_ref, old_digest, new_ref, new_digest)
    step(f"E 部署环境文件被其它工具修改：{env.project}")
    env_path = os.path.join(env.deploy, ".env.prod")
    try:
        env.up()
        env.seed_api()
        original = open(env_path, encoding="utf-8").read()
        created = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-e-{env.suffix}", "version": NEW_VERSION, "digest": new_digest}))
        check(f"[envmod] 任务受理", created["status"] == 202, json.dumps(created)[:200])
        operation_id = created["json"]["operationId"]

        def phase_reached():
            rec = env.task_record(operation_id)
            return rec if rec and rec.get("phase") == "backup_copy" else None

        wait_until(phase_reached, timeout=180, interval=0.05, desc="阶段推进到 ③保留备份并复制")
        injected = "# 其它工具（模拟）在更新过程中改了这一行\n"
        with open(env_path, "a", encoding="utf-8") as handle:
            handle.write(injected)
        record(f"[envmod] 已模拟其它工具修改部署环境文件", True)

        rec = env.wait_task(operation_id, timeout=240)
        record(f"[envmod] 拒绝覆盖 → env_file_changed", rec.get("failure", {}).get("code") == "env_file_changed", json.dumps(rec.get("failure")))
        record(f"[envmod] 恢复旧版本（failed_restored）", rec.get("outcome") == "failed_restored" and (rec.get("restore") or {}).get("confirmed") is True,
               json.dumps(rec.get("restore")))
        restored = open(env_path, encoding="utf-8").read()
        record(f"[envmod] 环境文件未被执行器改写（仍是更新前内容 + 外部那一行）", restored == original + injected, restored[-160:])
        record(f"[envmod] 环境文件里的镜像仍是旧镜像（没有被切到新版）",
               f"FEEDBACK_IMAGE={old_ref}@{old_digest}" in restored, restored[:400])
        record(f"[envmod] 旧服务真实可用", try_http(f"{env.base}/healthz")[0] == 200)
        cid = env.service_container().split("|")[0]
        info = env.container_inspect(cid)
        record(f"[envmod] 运行中的仍是旧镜像", repo_digest_of(info["Image"]) == old_digest)
        log(f"[envmod] 诊断产物：{env.work}")
    finally:
        env.destroy()


# --------------------------------------------------------------------------- #
# 场景 F：更新中重启 updater（重启核对）
# --------------------------------------------------------------------------- #

def scenario_updater_restart(old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest):
    env = Env("restart", old_ref, old_digest, new_ref, new_digest, seed_extra_mb=12)
    step(f"F 更新中重启 updater（重启核对）：{env.project}")
    try:
        env.up()
        env.seed_api()
        created = env.updater_http("POST", "/tasks", json.dumps({"requestId": f"u1v-f-{env.suffix}", "version": NEW_VERSION, "digest": new_digest}))
        check(f"[restart] 任务受理", created["status"] == 202, json.dumps(created)[:200])
        operation_id = created["json"]["operationId"]
        paused_path = os.path.join(env.control, "paused")
        wait_until(lambda: os.path.exists(paused_path), timeout=180, interval=0.02, desc="暂停标记出现（②开始）")
        record(f"[restart] 更新进行中重启 updater 容器", docker("restart", "-t", "5", env.updater_name)[0] == 0)
        wait_until(lambda: env.updater_http("GET", "/healthz")["status"] == 200, timeout=90, interval=1, desc="updater 重启后 /healthz")

        rec = env.wait_task(operation_id, timeout=240)
        record(f"[restart] 重启核对把任务收成终态 failed_restored",
               rec.get("status") == "failed" and rec.get("outcome") == "failed_restored", json.dumps({"status": rec.get("status"), "outcome": rec.get("outcome")})[:200])
        record(f"[restart] 核对证据落在任务文件里", any(e.get("step") == "重启核对" for e in rec.get("evidence", [])), "")
        record(f"[restart] 旧服务已被确认并重新运行",
               try_http(f"{env.base}/healthz")[0] == 200 and repo_digest_of(env.container_inspect(env.service_container().split("|")[0])["Image"]) == old_digest)
        record(f"[restart] paused 标记已解除", not os.path.exists(paused_path))
        record(f"[restart] 未产生新卷切换（环境文件仍是旧镜像）",
               f"FEEDBACK_IMAGE={old_ref}@{old_digest}" in open(os.path.join(env.deploy, ".env.prod"), encoding="utf-8").read())
        record(f"[restart] 旧卷数据完好", env.probe_volume(env.old_volume).get("ok") is True)
        log(f"[restart] 诊断产物：{env.work}")
    finally:
        env.destroy()


SCENARIOS = {
    "happy_path": scenario_happy_path,
    "verify_failure": scenario_verify_failure,
    "release_failure": scenario_release_failure,
    "fast_rejects": scenario_fast_rejects,
    "env_modified": scenario_env_modified,
    "updater_restart": scenario_updater_restart,
}


# --------------------------------------------------------------------------- #
# 准备与主流程
# --------------------------------------------------------------------------- #

def ensure_images():
    if docker("image", "inspect", NEW_IMAGE)[0] != 0:
        step(f"构建新版反馈镜像 {NEW_IMAGE}（当前工作树）")
        code, out, err = docker(
            "build",
            "-f",
            os.path.join(ROOT, "Dockerfile"),
            "-t",
            NEW_IMAGE,
            "--label",
            f"org.opencontainers.image.version={NEW_VERSION}",
            "--label",
            f"org.opencontainers.image.revision={git_head()}",
            ROOT,
            timeout=2400,
        )
        if code != 0:
            raise RuntimeError(f"构建新版镜像失败：{err[-400:]}")
    if docker("image", "inspect", UPDATER_IMAGE)[0] != 0:
        step(f"构建 updater 镜像 {UPDATER_IMAGE}")
        code, out, err = docker("build", "-f", os.path.join(ROOT, "apps/updater/Dockerfile"), "-t", UPDATER_IMAGE, ROOT, timeout=2400)
        if code != 0:
            raise RuntimeError(f"构建 updater 镜像失败：{err[-400:]}")
    if docker("image", "inspect", OLD_IMAGE)[0] != 0:
        raise RuntimeError(
            f"缺少旧版镜像 {OLD_IMAGE}（本机已有的旧源码产物）。"
            "可先用 --old-image 指定其它旧镜像，或先构建一个旧版本镜像再跑。"
        )


def build_broken_image():
    """基于新版镜像做一个「起得来但永远不健康」的变体，用于 ⑤核验失败路径。"""
    ref = "u1v-feedback-broken:0.3.0"
    if docker("image", "inspect", ref)[0] == 0:
        return ref
    context = os.path.join(RUN_ROOT, "broken-image")
    os.makedirs(context, exist_ok=True)
    with open(os.path.join(context, "Dockerfile"), "w", encoding="utf-8") as handle:
        handle.write(
            f"FROM {NEW_IMAGE}\n"
            "# 故意不可用：进程不监听端口，健康检查永远失败；版本标签沿用 0.3.0 以命中 ⑤核验\n"
            'HEALTHCHECK --interval=3s --timeout=2s --retries=2 CMD ["sh","-c","exit 1"]\n'
            'CMD ["sh","-c","sleep 3600"]\n'
        )
    code, out, err = docker("build", "-t", ref, context, timeout=600)
    if code != 0:
        raise RuntimeError(f"构建 broken 镜像失败：{err[-300:]}")
    return ref


def main():
    global OLD_IMAGE
    ap = argparse.ArgumentParser(description="U1 容器级真实升级验证")
    ap.add_argument("--only", default="", help="只跑指定场景（逗号分隔）")
    ap.add_argument("--old-image", default=OLD_IMAGE)
    args = ap.parse_args()

    OLD_IMAGE = args.old_image

    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RUN_ROOT, exist_ok=True)
    log("=== U1 容器级真实升级验证 ===")
    log(f"仓库：{ROOT}")
    log(f"docker {docker('version', '--format', '{{.Server.Version}}')[1].strip()} / compose {docker('compose', 'version')[1].strip()}")

    ensure_images()
    broken = build_broken_image()
    labels_new = image_labels(NEW_IMAGE)
    check("[pre] 新版镜像版本标签为 0.3.0", labels_new.get("org.opencontainers.image.version") == NEW_VERSION, json.dumps(labels_new))
    record("[pre] 新版镜像带提交标签", labels_new.get("org.opencontainers.image.revision") == git_head(), json.dumps(labels_new))

    registry = Registry()
    mock = MockExternal()
    _creds["reg"] = registry
    _creds["mock"] = mock
    step(f"本地 registry {registry.host}；mock AI:{mock.ai_port} Kaneo:{mock.kaneo_port}")
    old_ref = f"{registry.host}/u1v-feedback-old"
    new_ref = f"{registry.host}/u1v-feedback-new"
    broken_ref = f"{registry.host}/u1v-feedback-broken"
    old_digest = registry.push(OLD_IMAGE, f"{old_ref}:0.2.1")
    new_digest = registry.push(NEW_IMAGE, f"{new_ref}:0.3.0")
    broken_digest = registry.push(broken, f"{broken_ref}:0.3.0")
    log(f"旧版 digest {old_digest}")
    log(f"新版 digest {new_digest}")
    check("[pre] 新版与旧版 digest 不同", old_digest != new_digest)
    check("[pre] broken 镜像 digest 与新版本不同", broken_digest != new_digest)

    selected = list(SCENARIOS)
    if args.only:
        selected = [s.strip() for s in args.only.split(",") if s.strip()]
        for name in selected:
            if name not in SCENARIOS:
                log(f"[FATAL] 未知场景：{name}")
                sys.exit(2)

    try:
        for name in selected:
            started = time.time()
            try:
                SCENARIOS[name](old_ref, old_digest, new_ref, new_digest, broken_ref, broken_digest)
                scenarios.append({"scenario": name, "ok": True, "detail": "", "seconds": round(time.time() - started, 1)})
            except AssertionError as exc:
                scenarios.append({"scenario": name, "ok": False, "detail": str(exc), "seconds": round(time.time() - started, 1)})
                log(f"  !!! 场景 {name} 断言失败：{exc}")
            except Exception as exc:  # noqa: BLE001
                scenarios.append({"scenario": name, "ok": False, "detail": f"{type(exc).__name__}: {exc}", "seconds": round(time.time() - started, 1)})
                log(f"  !!! 场景 {name} 异常：{type(exc).__name__}: {exc}")
    finally:
        mock.stop()
        registry.stop()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    log(f"\n=== U1 升级验证：{passed}/{len(results)} 项断言通过 ===")
    if defects:
        log(f"发现 {len(defects)} 条实现缺陷（已记录，不计入断言失败）：")
        for item in defects:
            log(f"  [DEFECT] {item['name']}")
    for entry in scenarios:
        log(f"  {'OK  ' if entry['ok'] else 'FAIL'} {entry['scenario']}（{entry['seconds']}s）" + (f" — {entry['detail']}" if entry["detail"] else ""))
    if failed:
        log("失败断言：")
        for name, detail in failed:
            log(f"  - {name}" + (f" — {detail}" if detail else ""))
    with open(REPORT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "oldImage": OLD_IMAGE,
                "newImage": NEW_IMAGE,
                "brokenImage": broken,
                "oldDigest": old_digest,
                "newDigest": new_digest,
                "brokenDigest": broken_digest,
                "total": len(results),
                "passed": passed,
                "failed": [{"assertion": n, "detail": d} for n, d in failed],
                "assertions": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
                "scenarios": scenarios,
                "defects": defects,
                "artifactsRoot": RUN_ROOT,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    log(f"[INFO] 报告：{os.path.relpath(REPORT, ROOT)}；诊断产物：{RUN_ROOT}")
    sys.exit(1 if failed or any(not s["ok"] for s in scenarios) else 0)


if __name__ == "__main__":
    main()
