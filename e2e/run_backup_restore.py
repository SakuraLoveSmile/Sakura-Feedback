#!/usr/bin/env python3
"""停服备份 → 保留主密钥 → 恢复到隔离实例 的流程验证（T1 运维项）。

验证目标（对应计划里的"验证停服备份、保留主密钥、恢复到隔离实例的流程；
隔离恢复不得自动重放到真实 Kaneo"）：

  1. 停服后整目录拷贝 `data/`；核查此时是否仍有 WAL / -shm 残留
     （文档声称"优雅退出会关闭 SQLite WAL 并完成 checkpoint"，本脚本实测该说法）。
  2. 用**同一主密钥**在隔离实例上恢复：数据在、密文可解密（Kaneo/AI 连接测试通过）。
  3. 隔离恢复**不得**把 needs_review（maybe_sent）的记录自动重放到 Kaneo：
     恢复后远端 createTask 次数不增加，记录仍是 needs_review。
  4. 反证：换成**不同主密钥**启动同一份恢复数据 → 密文无法解密，连接按"未配置"处理。
     以此证明"保留主密钥"是硬前提，而不是可选项。

前置：宿主 mock 已在 8898/8899；Docker daemon 可用；被测镜像可由 `docker image inspect` 解析。
不依赖 run_docker.py 的模块级常量，独立管理自己的容器/卷，便于单独运行。

环境变量（全部可选，不设置时保持既有行为）：
  * `FEEDBACK_E2E_IMAGE`    被测镜像引用，默认 `feedback-service:local`。
                            可直接给候选 digest（`repo@sha256:...`）：本脚本用
                            `docker image inspect` 解析引用，不要求镜像有本地标签。
  * `FEEDBACK_E2E_PLATFORM` 强制 `docker run --platform`。默认 auto：镜像架构与本机
                            daemon 架构不一致时自动用 `linux/<镜像架构>`（例如 ARM 主机
                            上跑 amd64 候选镜像，属于模拟环境，不作为性能证据）。
  * `FEEDBACK_E2E_RUN_ID`   本次运行标识。默认按时间+pid 生成，用于给容器/卷起专属名称。
  * `FEEDBACK_E2E_PORT_A/B/C` 三个测试端口，默认 8791/8792/8793。

资源归属：容器与卷一律带本次 RUN_ID 后缀，退出时只删除**本次运行创建**的资源，
不按固定名称删除其它实例的数据；端口被占用时直接报错，不抢占。
"""
import json
import hashlib
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = os.environ.get("FEEDBACK_E2E_IMAGE") or "feedback-service:local"
MOCK = "http://127.0.0.1:8898"
MOCK_AI = "http://127.0.0.1:8899"
MOCK_IN_DOCKER = "http://host.docker.internal:8898"
MOCK_AI_IN_DOCKER = "http://host.docker.internal:8899/v1"
ADMIN = {"username": "admin", "password": "backup-e2e-pass"}

# 本次运行专属标识与资源名：绝不复用固定名称，避免误删上一次运行留下的容器/卷。
RUN_ID = os.environ.get("FEEDBACK_E2E_RUN_ID") or f"{time.strftime('%m%d%H%M%S')}-{os.getpid()}"
VOL_SRC = f"fb-br-src-{RUN_ID}"
VOL_DST = f"fb-br-dst-{RUN_ID}"
A, B, C = (f"fb-br-a-{RUN_ID}", f"fb-br-b-{RUN_ID}", f"fb-br-c-{RUN_ID}")
PORT_A = int(os.environ.get("FEEDBACK_E2E_PORT_A") or 8791)
PORT_B = int(os.environ.get("FEEDBACK_E2E_PORT_B") or 8792)
PORT_C = int(os.environ.get("FEEDBACK_E2E_PORT_C") or 8793)
APP_ID = "com.br.test"

PLATFORM = ""       # 由 resolve_platform() 决定
IMAGE_IDENT = None  # (image_id, architecture, repo_digests_json)
CREATED_CONTAINERS = []
CREATED_VOLUMES = []

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


def step(name):
    print(f"\n[{len(results)}] {name}", flush=True)


def docker(*args, timeout=180, check_rc=True):
    p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check_rc and p.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:3])} 失败: {p.stderr[-400:]}")
    return p.stdout.strip()


def _norm_arch(arch):
    return {"aarch64": "arm64", "x86_64": "amd64", "amd64": "amd64", "arm64": "arm64"}.get(
        (arch or "").strip(), (arch or "").strip()
    )


def image_inspect(ref):
    """用 `docker image inspect` 解析镜像引用。

    digest 引用（repo@sha256:...）没有本地标签，旧写法 `docker images --format
    {{.Repository}}:{{.Tag}}` 会把它当成“不存在”而误拒。inspect 对两种引用都有效。

    返回 (image_id, architecture, repo_digests_json)；不可解析时返回 None。
    """
    p = subprocess.run(
        ["docker", "image", "inspect", "--format",
         "{{.Id}}|{{.Architecture}}|{{json .RepoDigests}}", ref],
        capture_output=True, text=True, timeout=60,
    )
    if p.returncode != 0:
        return None
    parts = p.stdout.strip().split("|", 2)
    return tuple(parts) if len(parts) == 3 else None


def daemon_arch():
    p = subprocess.run(["docker", "info", "--format", "{{.Architecture}}"],
                       capture_output=True, text=True, timeout=60)
    return _norm_arch(p.stdout.strip()) if p.returncode == 0 else ""


def resolve_platform():
    """镜像架构与本机 daemon 不一致时显式 `--platform`（ARM 主机跑 amd64 候选镜像）。"""
    forced = (os.environ.get("FEEDBACK_E2E_PLATFORM") or "").strip()
    if forced and forced.lower() != "auto":
        return forced
    if not IMAGE_IDENT:
        return ""
    img_arch = _norm_arch(IMAGE_IDENT[1])
    host_arch = daemon_arch()
    if img_arch and host_arch and img_arch != host_arch:
        return f"linux/{img_arch}"
    return ""


def platform_args():
    return ["--platform", PLATFORM] if PLATFORM else []


def cleanup():
    """只清理本次运行创建的资源：绝不按固定名称删除其它实例的容器/卷。"""
    for n in CREATED_CONTAINERS:
        subprocess.run(["docker", "rm", "-f", n], capture_output=True, text=True)
    for v in CREATED_VOLUMES:
        subprocess.run(["docker", "volume", "rm", v], capture_output=True, text=True)


def port_free(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


def check_ports_free():
    busy = [p for p in (PORT_A, PORT_B, PORT_C) if not port_free(p)]
    if busy:
        raise RuntimeError(
            f"测试端口被占用：{busy}。请释放端口，或用 FEEDBACK_E2E_PORT_A/B/C 指定其它端口。"
        )


def start(name, port, volume, master_key):
    docker(
        "run", "-d", "--name", name, *platform_args(), "-p", f"{port}:8787",
        "-e", f"FEEDBACK_MASTER_KEY={master_key}",
        "-e", f"FEEDBACK_ADMIN_USER={ADMIN['username']}",
        "-e", f"FEEDBACK_ADMIN_PASSWORD={ADMIN['password']}",
        "-e", "FEEDBACK_COOKIE_SECURE=false",
        "-v", f"{volume}:/data", IMAGE,
    )
    CREATED_CONTAINERS.append(name)


def wait_health(port, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"
        self.jar = urllib.request.HTTPCookieProcessor(__import__("http.cookiejar", fromlist=["CookieJar"]).CookieJar())
        self.opener = urllib.request.build_opener(self.jar)

    def call(self, method, path, body=None, bearer=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        req.add_header("origin", self.base)
        if bearer:
            req.add_header("authorization", f"Bearer {bearer}")
        try:
            with self.opener.open(req, timeout=20) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": raw}

    def bytes(self, path):
        req = urllib.request.Request(self.base + path, method="GET")
        req.add_header("origin", self.base)
        with self.opener.open(req, timeout=20) as r:
            return r.read()

    def login(self):
        return self.call("POST", "/api/auth/login", ADMIN)[0]

    def client_token(self, label):
        # 用独立会话换取客户端令牌：绝不覆盖本实例的管理页会话（否则后续管理接口会 403）
        jar = urllib.request.HTTPCookieProcessor(__import__("http.cookiejar", fromlist=["CookieJar"]).CookieJar())
        opener = urllib.request.build_opener(jar)
        data = json.dumps({**ADMIN, "clientLabel": label}).encode()
        req = urllib.request.Request(self.base + "/api/auth/login", data=data, method="POST")
        req.add_header("content-type", "application/json")
        req.add_header("origin", self.base)
        try:
            with opener.open(req, timeout=20) as r:
                return (json.loads(r.read().decode()) or {}).get("token")
        except urllib.error.HTTPError:
            return None

    def submit(self, key, text, bearer, logs=None):
        boundary = "----BR" + str(int(time.time() * 1000))
        logs = logs or []
        meta = {"idempotencyKey": key, "appId": APP_ID, "text": text}
        if logs:
            meta["logs"] = [
                {"name": name, "source": source, "byteSize": len(content)}
                for name, source, content in logs
            ]
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
            f"Content-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
        ).encode()
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"screenshot\"; "
            f"filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n"
        ).encode()
        body += _png(24, 24, (200, 60, 60)) + b"\r\n" + f"--{boundary}--\r\n".encode()
        # metadata.logs and logs parts must stay in the same order.
        if logs:
            head = (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
                f"Content-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
            ).encode()
            image = (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"screenshot\"; "
                f"filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n"
            ).encode() + _png(24, 24, (200, 60, 60)) + b"\r\n"
            body = head + image
            for name, _source, content in logs:
                body += (
                    f"--{boundary}\r\nContent-Disposition: form-data; name=\"logs\"; "
                    f"filename=\"{name}\"\r\nContent-Type: text/plain\r\n\r\n"
                ).encode() + content + b"\r\n"
            body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(self.base + "/api/feedback", data=body, method="POST")
        req.add_header("content-type", f"multipart/form-data; boundary={boundary}")
        req.add_header("origin", self.base)
        req.add_header("authorization", f"Bearer {bearer}")
        try:
            with self.opener.open(req, timeout=25) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, {"raw": e.read().decode()[:200]}


def _png(w, h, rgb):
    import struct
    import zlib

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def mock(path, body=None):
    payload = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{MOCK}{path}", data=payload, method="POST" if payload else "GET")
    if payload:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def mock_tasks():
    return len((mock("/__mock/state") or {}).get("tasks") or [])


def wait_held(stage, timeout=60):
    """等待该阶段的请求真的到达 mock 并被挂起（“远端已写入、响应丢失”的客观证据）。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        held = [h for h in (mock("/__mock/state") or {}).get("held") or [] if h.get("stage") == stage]
        if held:
            return held
        time.sleep(0.2)
    raise RuntimeError(f"等待 mock 挂起阶段 {stage} 超时")


def volume_list(volume):
    out = docker("run", "--rm", *platform_args(), "-v", f"{volume}:/data",
                 "--entrypoint", "sh", IMAGE, "-c", "ls -1 /data")
    return [x for x in out.splitlines() if x.strip()]


def main():
    global PLATFORM, IMAGE_IDENT
    key_a = subprocess.run(["node", "-e", 'console.log(require("crypto").randomBytes(32).toString("base64"))'],
                           capture_output=True, text=True).stdout.strip()
    key_b = subprocess.run(["node", "-e", 'console.log(require("crypto").randomBytes(32).toString("base64"))'],
                           capture_output=True, text=True).stdout.strip()
    assert key_a and key_b and key_a != key_b

    IMAGE_IDENT = image_inspect(IMAGE)
    PLATFORM = resolve_platform()
    check_ports_free()

    try:
        for v in (VOL_SRC, VOL_DST):
            docker("volume", "create", v)
            CREATED_VOLUMES.append(v)
        step("准备：本次资源身份、宿主 mock 可达、镜像可解析")
        print(f"       RUN_ID={RUN_ID} 容器={[A, B, C]} 卷={[VOL_SRC, VOL_DST]} 端口={[PORT_A, PORT_B, PORT_C]}",
              flush=True)
        print(f"       镜像={IMAGE}", flush=True)
        if IMAGE_IDENT:
            print(f"       image_id={IMAGE_IDENT[0]} architecture={IMAGE_IDENT[1]} "
                  f"repo_digests={IMAGE_IDENT[2]}", flush=True)
        print(f"       daemon_arch={daemon_arch()} → docker run 平台={PLATFORM or '（本机默认）'}"
              + ("（跨架构模拟运行，不作为性能证据）" if PLATFORM else ""), flush=True)
        check("镜像可由 docker image inspect 解析（digest 引用不被当作不存在）",
              IMAGE_IDENT is not None, (IMAGE_IDENT or ("", "", ""))[0][:26])
        if IMAGE_IDENT and "@sha256:" in IMAGE:
            check("本地镜像 RepoDigests 与请求的 digest 一致",
                  IMAGE.split("@", 1)[1] in IMAGE_IDENT[2], IMAGE.split("@", 1)[1])
        if IMAGE_IDENT:
            free = docker("run", "--rm", *platform_args(), "--entrypoint", "sh", IMAGE,
                          "-c", "df -h / | tail -1")
            print(f"       Docker VM 空间: {free}", flush=True)
        check("宿主 mock Kaneo :8898 可达", mock("/__health").get("ok") is True)
        ai_calls = urllib.request.urlopen(f"{MOCK_AI}/__mock/ai-calls", timeout=5).read().decode()
        check("宿主 mock AI :8899 可达", "ai" in ai_calls or ai_calls.strip().startswith(("{", "[")))
        mock("/__mock/reset", {})
        # 容器内的预签名/资产地址必须指向容器可达的宿主名，否则上传阶段必然失败
        mock("/__mock/state", {"publicBase": MOCK_IN_DOCKER})

        step("实例 A：写入凭据（用主密钥 A 加密）与一条 maybe_sent 记录")
        start(A, PORT_A, VOL_SRC, key_a)
        check("A 健康", wait_health(PORT_A))
        ca = Client(PORT_A)
        check("A 管理登录", ca.login() == 200)
        s, _ = ca.call("PUT", "/api/admin/connection/kaneo", {"baseUrl": MOCK_IN_DOCKER, "apiKey": "k-br"})
        check("A 保存 Kaneo 凭据（密文）", s == 200, str(s))
        s, _ = ca.call("PUT", "/api/admin/connection/ai",
                       {"baseUrl": MOCK_AI_IN_DOCKER, "model": "mock", "apiKey": "a-br"})
        check("A 保存 AI 凭据（密文）", s == 200, str(s))
        s, _ = ca.call("POST", "/api/admin/apps",
                       {"appId": APP_ID, "name": "br", "allowedOrigins": [ca.base],
                        "kaneoProjectId": "p-docker", "kaneoColumnSlug": "triage"})
        check("A 登记软件", s == 201, str(s))
        bearer = ca.client_token("br-client")
        check("A 取得客户端令牌", bool(bearer))

        # 让 createTask(task) 在**远端已写入**后挂起不响应 → 本地结果未知 → 重启后 needs_review。
        # （mock 的 uncertain 是在写入前直接掐断连接，远端不会留下任务，不是我们要的取证场景）
        mock("/__mock/fail", {"stage": "task", "mode": "hold", "once": True, "afterWrite": True})
        log_payload = [
            ("server.log", "auto", b"2026-09-12T01:02:03Z ERROR upstream ECONNRESET\n"),
            ("manual.txt", "manual", "人工补充：仅在隔离恢复后核对字节摘要。\n".encode("utf-8")),
        ]
        expected_log_hashes = {name: hashlib.sha256(content).hexdigest() for name, _source, content in log_payload}
        st, body = ca.submit("br-key-1", "备份恢复验证：远端已写入但结果未知", bearer, log_payload)
        check("A 提交被接受", st == 201, f"{st} {body}")
        fid = (body or {}).get("feedbackId")
        held = wait_held("task")
        remote_tasks = mock_tasks()
        check("A 在途证据：mock 已创建任务且请求被挂起", bool(held) and remote_tasks == 1,
              f"held={len(held)} tasks={remote_tasks}")

        step("重启 A（模拟进程崩溃）→ 恢复契约：不盲目重发，转待核对")
        docker("restart", A)
        mock("/__mock/release", {})
        check("A 重启后健康", wait_health(PORT_A))
        check("A 重新登录", ca.login() == 200)
        status, detail = None, None
        t0 = time.time()
        while time.time() - t0 < 60:
            sd, d = ca.call("GET", f"/api/admin/feedback/{fid}")
            detail = d or {}
            status = detail.get("status")
            if status in ("needs_review", "archived", "failed"):
                break
            time.sleep(0.5)
        check("A 该记录进入 needs_review（未知结果不降级为未发送，也不盲目重发）",
              status == "needs_review", f"{status} / {detail.get('errorSummary') or detail.get('error_summary')}")
        tasks_after_submit = mock_tasks()
        check("A 重启后没有重复创建任务", tasks_after_submit == remote_tasks == 1,
              f"{remote_tasks} -> {tasks_after_submit}")
        s, detail_after_restart = ca.call("GET", f"/api/admin/feedback/{fid}")
        logs_a = (detail_after_restart or {}).get("logs") or []
        check("A 备份前详情保留日志元数据（顺序与摘要）",
              s == 200 and [x.get("name") for x in logs_a] == [x[0] for x in log_payload]
              and [x.get("sha256") for x in logs_a] == [expected_log_hashes[x[0]] for x in log_payload],
              json.dumps(logs_a, ensure_ascii=False))

        step("停服（docker stop）并观察 data/ 内容，实测文档的 checkpoint 说法")
        docker("stop", "--time", "30", A)
        files = volume_list(VOL_SRC)
        print(f"       data/ 内容: {files}", flush=True)
        check("停服后 data/ 仍有 feedback.db", any(f == "feedback.db" for f in files), str(files))
        wal_after_stop = sorted(f for f in files if f.endswith(("-wal", "-shm")))
        print(f"       停机后残留 WAL/SHM: {wal_after_stop or '（无）'}", flush=True)
        check("优雅退出已 checkpoint：停机后 data/ 无 WAL/SHM 残留（可直接整目录备份）",
              not wal_after_stop, str(wal_after_stop))

        step("整目录拷贝 data/ 到隔离卷")
        docker("run", "--rm", *platform_args(), "-v", f"{VOL_SRC}:/from", "-v", f"{VOL_DST}:/to",
               "--entrypoint", "sh", IMAGE, "-c", "cp -a /from/. /to/ && ls -1 /to")
        check("隔离卷已获得数据副本", "feedback.db" in volume_list(VOL_DST))

        step("实例 B：同主密钥 + 恢复数据 → 数据可用、密文可解密、**不自动重放**")
        start(B, PORT_B, VOL_DST, key_a)
        check("B 健康", wait_health(PORT_B))
        cb = Client(PORT_B)
        check("B 管理登录（用户/会话随备份恢复）", cb.login() == 200)
        s, lst = cb.call("GET", "/api/admin/feedback")
        ids = [x.get("id") for x in ((lst or {}).get("items") or [])]
        check("B 恢复出备份中的反馈记录", fid in ids, f"count={len(ids)}")
        s, d = cb.call("GET", f"/api/admin/feedback/{fid}")
        check("B 该记录仍是 needs_review（未被自动补发）", (d or {}).get("status") == "needs_review",
              str((d or {}).get("status")))
        logs_b = (d or {}).get("logs") or []
        check("B 恢复出全部日志元数据且 logId 唯一",
              len(logs_b) == len(log_payload) and len({x.get("id") for x in logs_b}) == len(logs_b)
              and [x.get("name") for x in logs_b] == [x[0] for x in log_payload],
              json.dumps(logs_b, ensure_ascii=False))
        for log_meta in logs_b:
            raw = cb.bytes(f"/api/admin/feedback/{fid}/logs/{log_meta['id']}")
            expected = next(content for name, _source, content in log_payload if name == log_meta["name"])
            check(f"B 隔离恢复日志 {log_meta['name']} 字节与 SHA-256 一致",
                  raw == expected and hashlib.sha256(raw).hexdigest() == log_meta.get("sha256"),
                  f"bytes={len(raw)} sha={hashlib.sha256(raw).hexdigest()[:16]}")
        foreign_log = "log-from-another-feedback"
        s, bad = cb.call("POST", f"/api/feedback/{fid}/recover",
                         {"action": "retry_comment", "expectedRevision": (d or {}).get("recovery", {}).get("revision", 0),
                          "logId": foreign_log})
        check("B 恢复接口拒绝不属于该反馈的 logId", s == 400, f"{s} {bad}")
        s, kt = cb.call("POST", "/api/admin/connection/kaneo/test", {"projectId": "p-docker"})
        check("B 用保留的主密钥能解密 Kaneo 凭据（连接测试 ok）", s == 200 and (kt or {}).get("ok") is True,
              f"{s} {json.dumps(kt, ensure_ascii=False)[:160]}")
        tasks_after_restore = mock_tasks()
        check("隔离恢复**没有**向 Kaneo 新增 createTask（不自动重放）",
              tasks_after_restore == tasks_after_submit, f"{tasks_after_submit} -> {tasks_after_restore}")

        step("反证：换用不同主密钥启动同一份恢复数据 → 密文不可解密")
        docker("stop", B)
        start(C, PORT_C, VOL_DST, key_b)
        check("C 健康", wait_health(PORT_C))
        cc = Client(PORT_C)
        check("C 管理登录", cc.login() == 200)
        s, kt2 = cc.call("POST", "/api/admin/connection/kaneo/test", {"projectId": "p-docker"})
        ok_val = (kt2 or {}).get("ok")
        check("不同主密钥下 Kaneo 凭据**无法**解密（连接测试不 ok）", not (s == 200 and ok_val is True),
              f"status={s} ok={ok_val}")
        tasks_after_wrong_key = mock_tasks()
        check("错误主密钥下同样不会向 Kaneo 写入", tasks_after_wrong_key == tasks_after_submit,
              f"{tasks_after_submit} -> {tasks_after_wrong_key}")
    finally:
        cleanup()

    passed = sum(1 for _, ok in results if ok)
    failed = [n for n, ok in results if not ok]
    print(f"\n=== 备份/恢复验证：{passed}/{len(results)} 通过 ===")
    if failed:
        print("失败：", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()
