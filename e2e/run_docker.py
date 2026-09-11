#!/usr/bin/env python3
"""Docker 容器验证：真实 HTTP 闭环（容器↔宿主 mock）、重启持久化、崩溃恢复流转。

两层覆盖：

A. 端到端闭环与幂等重放（原有 12 项检查，名称与语义保持不变）
   —— 管理登录/软件配置/Kaneo 连通、纯文字归档闭环、archiving 中断转待核对、
   recheck 关联真实任务、重启后幂等重放。

B. **图文归档每个“远端写入阶段”的中途重启恢复契约**（本轮新增）
   远端写入阶段顺序（见 apps/server/src/pipeline/worker.ts）：
     1 createTask              POST  /api/task/:projectId                 —— [3][4]（手工置 archiving 的既有覆盖）+ [6]（真·在途重启）
     2 createImageUpload       PUT   /api/task/image-upload/:taskId       —— [7]
     3 二进制 PUT              PUT   /__mock/upload/:key（预签名地址）    —— [8]（另见 [12][13] 的不换 key 语义）
     4 finalizeImageUpload     POST  /api/task/image-upload/:id/finalize  —— [9]
     5 createComment           POST  /api/comment/:taskId                 —— [10][11]
   外加两条恢复语义：[12] 上传地址过期、[13] 同 key 重传被拒（都不许自动换 key）。

   每个阶段的做法：用 mock 的真实控制面（``POST /__mock/fail``）在该阶段**精确注入**
   失败（``mode="hold"`` 把请求挂起 → 容器在“请求在途”时被 ``docker restart``；
   ``mode="uncertain"/"definite"`` 模拟断连 / 明文拒绝），然后断言重启后的恢复契约：
   未知结果记为 ``maybe_sent`` 且终态 ``needs_review``（绝不降级为“未发送”）、
   恢复数据（加密上传记录 / key / 资产 / 评论标记）跨重启存活、自动路径不重发
   （不重复建任务、不申请新 key、不发第二条评论）、显式 ``retry_comment`` /
   ``replace_upload`` 的语义。断言同时读取**服务端状态**与 **mock 记录的真实远端事实**
   （阶段调用次数、key 序列、PUT 字节摘要、评论条数、任务数）。

前置（**数据卷必须用 Docker 命名卷，不要用宿主 ``/tmp`` 绑定挂载**）：

    node e2e/mock-external.mjs &                      # 宿主 mock：Kaneo :8898 / AI :8899
    docker volume create fb-e2e-data
    docker run -d --name fb-e2e -p 8790:8787 \
      -e FEEDBACK_MASTER_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')" \
      -e FEEDBACK_ADMIN_USER=admin -e FEEDBACK_ADMIN_PASSWORD=docker-e2e-pass \
      -e FEEDBACK_COOKIE_SECURE=false \
      -v fb-e2e-data:/data feedback-service:local

**为什么必须用命名卷**：本套件的核心断言依赖数据在 ``docker restart`` 后仍然存在。
在 macOS Docker Desktop 上用宿主 ``/tmp`` 绑定挂载时会偶发丢失——实测同一套命令一次通过
（12/12）一次失败（重启后 ``apps/feedbacks/settings`` 全空、只剩 ``users``，即服务端在
空目录上重新建库）。原因是 SQLite 的 WAL 依赖 ``-shm`` 共享内存映射，跨宿主文件共享层
（virtiofs/gRPC-FUSE）不稳定。用 Docker 命名卷即稳定复现（59/59，已连续多次运行）。

脚本开头会把 mock 与容器业务数据复位为全新状态（``POST /__mock/reset`` +
清空容器 ``feedback_screenshots`` / ``feedbacks`` / ``apps`` 表）：否则“首次运行”
断言（软件配置 201、提交 201）在第二次运行必然失败。设 ``E2E_KEEP_DATA=1`` 可跳过复位。

运行（仓库根目录，单条命令）：``python3 e2e/run_docker.py``
"""
import base64
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib
from http.cookiejar import CookieJar

BASE = "http://127.0.0.1:8790"
MOCK = "http://127.0.0.1:8898"
CONTAINER_MOCK_BASE = "http://host.docker.internal:8898"  # 容器内可达的宿主 mock 基址
CONTAINER = "fb-e2e"
ADMIN_LOGIN = {"username": "admin", "password": "docker-e2e-pass"}
cj = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
results = []
CLIENT_BEARER = None


# ---------------- 基础工具 ----------------

def call(method, path, body=None, base=BASE):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    req.add_header("origin", BASE)
    try:
        with opener.open(req, timeout=15) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def plain(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode())


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


def brief(obj, n=240):
    return json.dumps(obj, ensure_ascii=False)[:n]


# ---------------- 容器 / 数据库 ----------------

def docker(*args, timeout=180):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def docker_exec(node_code, timeout=30):
    b64 = base64.b64encode(node_code.encode()).decode()
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "node", "-e",
         f"eval(Buffer.from('{b64}','base64').toString())"],
        capture_output=True, text=True, timeout=timeout,
    )
    if out.returncode != 0:
        raise RuntimeError(f"docker exec 失败: {out.stderr[-400:]}")
    return out.stdout.strip()


def sql_json(sql, params=()):
    """在容器内读 SQLite 并返回行数组（WAL 下并发只读安全）。"""
    args = ",".join(json.dumps(p) for p in params)
    js = (
        "const{DatabaseSync}=require('node:sqlite');"
        "const db=new DatabaseSync('/data/feedback.db');"
        "db.exec('PRAGMA busy_timeout=5000');"
        f"const rows=db.prepare({json.dumps(sql)}).all({args});"
        "console.log(JSON.stringify(rows));"
    )
    return json.loads(docker_exec(js))


def db_row(fid):
    """读一条反馈的持久化事实（含解析后的归档恢复数据与截图摘要）。"""
    rows = sql_json(
        "SELECT f.id, f.status, f.archive_stage, f.kaneo_task_id, f.error_summary,"
        " f.archive_data_json, s.sha256 AS screenshot_sha256"
        " FROM feedbacks f LEFT JOIN feedback_screenshots s ON s.feedback_id = f.id"
        " WHERE f.id = ?",
        [fid],
    )
    if not rows:
        return None
    row = rows[0]
    raw = row.pop("archive_data_json")
    row["archive"] = json.loads(raw) if raw else None
    return row


def wait_health(timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(BASE + "/healthz", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("容器 /healthz 未在超时内就绪")


def restart_container():
    out = docker("restart", CONTAINER, timeout=180)
    if out.returncode != 0:
        raise RuntimeError(f"docker restart {CONTAINER} 失败: {out.stderr[-300:]}")
    wait_health()
    started = docker("inspect", "-f", "{{.State.StartedAt}}", CONTAINER).stdout.strip()
    print(f"  INFO  docker restart {CONTAINER} → health OK（容器 StartedAt={started}）", flush=True)


def ensure_admin_session():
    """重启后复用 Cookie 会话；失效才重新登录（避免触发登录限流）。"""
    s, _ = call("GET", "/api/admin/feedback", None)
    if s != 200:
        call("POST", "/api/auth/login", ADMIN_LOGIN)
        return False
    return True


# ---------------- 提交（含截图，multipart） ----------------

def make_png(width=64, height=64, rgb=(31, 119, 180)):
    """纯 stdlib 生成合法 PNG（sharp 可解码），避免为 e2e 增加第三方依赖。"""

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def submit_shot(key, text, png):
    """multipart 提交（metadata + screenshot），返回 (status, body)。"""
    boundary = "----FBdocker" + str(int(time.time() * 1000))
    meta = {"idempotencyKey": key, "appId": "com.docker.test", "text": text,
            "context": {"appVersion": "9.9.9"}}
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
        f"Content-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
    ).encode()
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"screenshot\"; "
        f"filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n"
    ).encode()
    body += png + b"\r\n" + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/api/feedback", data=body, method="POST")
    req.add_header("content-type", f"multipart/form-data; boundary={boundary}")
    req.add_header("origin", BASE)
    if CLIENT_BEARER:
        req.add_header("authorization", f"Bearer {CLIENT_BEARER}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def api_feedback(fid):
    """GET /api/feedback/:id（Bearer 轮询状态）。"""
    req = urllib.request.Request(f"{BASE}/api/feedback/{fid}",
                                headers={"authorization": f"Bearer {CLIENT_BEARER}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def wait_status(fid, want, timeout=60):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        last = (api_feedback(fid) or {}).get("status")
        if last in want:
            return last
        time.sleep(0.4)
    return last


def admin_detail(fid):
    s, d = call("GET", f"/api/admin/feedback/{fid}", None)
    return d if s == 200 else None


def wait_archived(fid, bearer, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        call("GET", f"/api/feedback/{fid}", None)
        # 状态查询也接受 bearer
        req = urllib.request.Request(f"{BASE}/api/feedback/{fid}", headers={"authorization": f"Bearer {bearer}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            st = json.loads(r.read().decode())["status"]
        if st in ("archived", "failed", "needs_review"):
            return st
        time.sleep(1)
    return "timeout"


# ---------------- 宿主 mock 控制面 ----------------

def mock_state():
    return plain(f"{MOCK}/__mock/state")


def arm(stage, mode, once=True, after_write=True, expire=None):
    """在指定阶段精确注入失败：mode ∈ uncertain|definite|hold。"""
    body = {"stage": stage, "mode": mode, "once": once, "afterWrite": after_write}
    if expire is not None:
        body["expire"] = expire
    return post_json(f"{MOCK}/__mock/fail", body)


def clear_fail():
    return post_json(f"{MOCK}/__mock/fail", {"stage": None, "mode": None, "expire": False})


def release_held():
    return post_json(f"{MOCK}/__mock/release", {})


def wait_held(stage, timeout=40):
    """等待该阶段的请求真的到达 mock 并被挂起（“请求在途”的客观证据）。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = mock_state()
        held = [h for h in st["held"] if h["stage"] == stage]
        if held:
            return st, held
        time.sleep(0.2)
    raise RuntimeError(f"等待 mock 挂起阶段 {stage} 超时：{brief(mock_state().get('held'))}")


def stage_view(tid):
    """按 Kaneo 任务聚合本记录相关的全部远端事实。"""
    st = mock_state()
    presigns = [p for p in st["presigns"] if p["taskId"] == tid]
    keys = [p["key"] for p in presigns]
    return {
        "all": st,
        "presigns": presigns,
        "keys": keys,
        "puts": [u for u in st["putAttempts"] if u["key"] in keys],
        "finalizes": [f for f in st["finalizeAttempts"] if f["taskId"] == tid],
        "commentPosts": [c for c in st["commentAttempts"] if c["taskId"] == tid],
        "comments": st["comments"].get(tid, []),
        "assets": [k for k in st["assetKeys"] if k in keys],
    }


def tasks_for(fid):
    """本记录创建的 Kaneo 任务（描述里带 反馈ID：<fid>）。"""
    return [t for t in mock_state()["tasks"] if fid in (t.get("description") or "")]


def unique_task_ok(fid, row):
    ts = tasks_for(fid)
    return len(ts) == 1 and bool(row) and row["kaneo_task_id"] == ts[0]["id"], ts


def submit_and_hold(key, text, stage, after_write=True, expire=None):
    """注入 hold → 提交带截图反馈 → 等待该阶段请求在途。"""
    arm(stage, "hold", once=True, after_write=after_write, expire=expire)
    s, sub = submit_shot(key, text, make_png())
    if s != 201:
        raise RuntimeError(f"截图反馈提交失败 {s}: {brief(sub)}")
    fid = sub["feedbackId"]
    _, held = wait_held(stage)
    return fid, held


def reset_environment(clear_db=True):
    """mock 归零 + （默认）清空容器业务数据（feedbacks / screenshots / apps）。"""
    post_json(f"{MOCK}/__mock/reset", {})
    # 服务端在容器内：预签名上传地址/资产地址必须指向容器可达的主机名
    post_json(f"{MOCK}/__mock/state", {"publicBase": CONTAINER_MOCK_BASE})
    if clear_db:
        docker_exec(
            "const{DatabaseSync}=require('node:sqlite');"
            "const db=new DatabaseSync('/data/feedback.db');"
            "db.exec('PRAGMA busy_timeout=5000');"
            "db.exec('DELETE FROM feedback_screenshots; DELETE FROM feedbacks; DELETE FROM apps;');"
            "console.log('reset')"
        )
    return sql_json(
        "SELECT (SELECT COUNT(*) FROM apps) AS apps,"
        " (SELECT COUNT(*) FROM feedbacks) AS feedbacks,"
        " (SELECT COUNT(*) FROM feedback_screenshots) AS screenshots"
    )[0]


try:
    # ---------------- [0] 环境复位 ----------------
    print("[0] 环境复位（宿主 mock + 容器业务数据；E2E_KEEP_DATA=1 可跳过容器清理）")
    keep_data = os.environ.get("E2E_KEEP_DATA") == "1"
    if keep_data:
        print("  INFO  E2E_KEEP_DATA=1：保留容器业务数据，首次运行类断言可能失败")
    counts = reset_environment(clear_db=not keep_data)
    zero = counts["apps"] == 0 and counts["feedbacks"] == 0 and counts["screenshots"] == 0
    st0 = mock_state()
    mock_zero = (not st0["tasks"] and not st0["comments"] and not st0["assetKeys"]
                 and not any(st0["calls"].values()))
    check("环境复位：mock 状态归零（预签名/资产地址指向容器可达基址）"
          + ("，保留容器业务数据" if keep_data else "，容器业务数据清空"),
          mock_zero and (keep_data or zero) and st0.get("publicBase") == CONTAINER_MOCK_BASE,
          f"db={brief(counts, 90)} mock_calls={brief(st0['calls'], 90)} publicBase={st0.get('publicBase')}")

    print("[1] 配置容器内服务（连接指向宿主 mock）")
    s, _ = call("POST", "/api/auth/login", ADMIN_LOGIN)
    check("管理登录", s == 200, str(s))
    call("PUT", "/api/admin/connection/kaneo", {"baseUrl": "http://host.docker.internal:8898", "apiKey": "k-docker"})
    call("PUT", "/api/admin/connection/ai", {"baseUrl": "http://host.docker.internal:8899/v1", "model": "mock", "apiKey": "a-docker"})
    s, _ = call("POST", "/api/admin/apps", {
        "appId": "com.docker.test", "name": "Docker 测试",
        "allowedOrigins": ["http://localhost:5999"], "kaneoProjectId": "p-docker", "kaneoColumnSlug": "triage"})
    check("软件配置", s == 201, str(s))
    s, r = call("POST", "/api/admin/connection/kaneo/test", {"projectId": "p-docker"})
    check("容器→宿主 Kaneo mock 连通", s == 200 and r["ok"], str(r))

    print("[2] 提交反馈并等待真实闭环")
    _, login = call("POST", "/api/auth/login", {**ADMIN_LOGIN, "clientLabel": "docker-e2e"})
    bearer = login["token"]
    CLIENT_BEARER = bearer
    s, sub = call("POST", "/api/feedback", {
        "idempotencyKey": "docker-key-1", "appId": "com.docker.test",
        "text": "容器持久化验证：导出很慢", "context": {"appVersion": "9.9.9"}})
    check("提交 201", s == 201, str((s, sub)))
    st = wait_archived(sub["feedbackId"], bearer)
    check("容器内流水线归档完成", st == "archived", st)
    tasks = plain(f"{MOCK}/__mock/tasks")["tasks"]
    check("宿主 mock 收到容器创建的任务", len(tasks) == 1 and tasks[0]["status"] == "triage", str(len(tasks)))
    fid1 = sub["feedbackId"]

    print("[3] 制造 archiving 中断 + 重启容器（阶段 1 的既有模拟覆盖：手工置 archiving）")
    docker_exec(
        "const{DatabaseSync}=require('node:sqlite');"
        "const db=new DatabaseSync('/data/feedback.db');"
        f"db.prepare(\"UPDATE feedbacks SET status='archiving' WHERE id='{fid1}'\").run();"
        "console.log('flipped')"
    )
    restart_container()
    call("POST", "/api/auth/login", ADMIN_LOGIN)
    s, lst = call("GET", "/api/admin/feedback", None)
    item = lst["items"][0]
    check("重启后数据持久（记录仍在）", s == 200 and item["id"] == fid1, str(s))
    check("archiving → 待核对（不盲目重发）", item["status"] == "needs_review", item["status"])

    print("[4] 待核对：recheck 找到任务 → 自动关联归档")
    s, r = call("POST", f"/api/feedback/{fid1}/resolve", {"action": "recheck"})
    check("recheck 命中宿主 mock 中真实任务", r["status"] == "archived", str(r))
    s, detail = call("GET", f"/api/admin/feedback/{fid1}", None)
    check("任务链接已关联", bool(detail["kaneoUrl"]) and "e2e-task-1" in detail["kaneoUrl"], str(detail["kaneoUrl"]))
    tasks_after = plain(f"{MOCK}/__mock/tasks")["tasks"]
    check("恢复过程未重复创建（仍 1 任务）", len(tasks_after) == 1, str(len(tasks_after)))

    print("[5] 重启后幂等重放仍生效")
    s, rep = call("POST", "/api/feedback", {
        "idempotencyKey": "docker-key-1", "appId": "com.docker.test",
        "text": "容器持久化验证：导出很慢", "context": {"appVersion": "9.9.9"}})
    check("重启后同键重放返回原记录", s == 200 and rep.get("replayed") and rep["feedbackId"] == fid1, str((s, rep)))

    # ================= B 段：图文归档各远端写入阶段的中途重启 =================

    # ---------------- [6] 阶段 1：createTask（创建任务）中途重启 ----------------
    print("[6] 阶段 1/5：createTask 创建任务 —— 任务已在远端创建但响应丢失时重启容器")
    fid0, held0 = submit_and_hold("docker-stage1", "阶段1：创建任务中途重启", "task")
    row0 = db_row(fid0)
    ts0 = tasks_for(fid0)
    check("阶段1 在途证据：mock 已创建任务（描述含反馈 ID）且请求被挂起",
          bool(held0) and len(ts0) == 1 and fid0 in (ts0[0].get("description") or ""),
          f"held={brief(held0, 120)} tasks={len(ts0)}")
    check("阶段1 崩溃前：本地尚无 kaneo_task_id（任务创建结果未落盘）",
          row0["kaneo_task_id"] is None and row0["status"] == "archiving"
          and row0["archive_stage"] == "task_pending",
          f"status={row0['status']} stage={row0['archive_stage']} task={row0['kaneo_task_id']}")
    restart_container()
    release_held()
    ensure_admin_session()
    row0 = db_row(fid0)
    check("阶段1 重启后：needs_review 且仍未记录任务 ID（不盲目重发、也不乱认领）",
          row0["status"] == "needs_review" and row0["kaneo_task_id"] is None,
          f"status={row0['status']} task={row0['kaneo_task_id']}")
    call("POST", f"/api/feedback/{fid0}/resolve", {"action": "recheck"})
    st0 = wait_status(fid0, ("archived", "failed", "needs_review"))
    row0 = db_row(fid0)
    view0 = stage_view(row0["kaneo_task_id"] or ts0[0]["id"])
    check("阶段1 重启后 recheck：按反馈 ID 搜到既有任务并完成归档，绝不重复创建",
          st0 == "archived" and len(tasks_for(fid0)) == 1
          and row0["kaneo_task_id"] == ts0[0]["id"],
          f"status={st0} tasks={len(tasks_for(fid0))} task={row0['kaneo_task_id']}")
    check("阶段1 恢复后整条图文链路各执行一次（预签名/PUT/finalize/评论各 1）",
          len(view0["presigns"]) == 1 and len(view0["puts"]) == 1
          and len(view0["finalizes"]) == 1 and len(view0["comments"]) == 1,
          brief({"presign": len(view0["presigns"]), "puts": len(view0["puts"]),
                 "fin": len(view0["finalizes"]), "comments": len(view0["comments"])}, 160))

    # ---------------- [7] 阶段 2：createImageUpload（申请预签名地址）中途重启 ----------------
    print("[7] 阶段 2/5：createImageUpload 申请预签名地址 —— 请求在途时重启容器")
    fid2, held2 = submit_and_hold("docker-stage2", "阶段2：预签名申请中途重启", "presign")
    row2 = db_row(fid2)
    tid2 = row2["kaneo_task_id"]
    mock2 = stage_view(tid2)
    check("阶段2 在途证据：mock 已挂起预签名请求且已分配 key（远端已写入、响应丢失）",
          bool(held2) and len(mock2["presigns"]) == 1,
          f"held={brief(held2, 120)} presigns={len(mock2['presigns'])}")
    check("阶段2 崩溃前：本地尚无上传记录（预签名响应未到达 → 没有 maybe_sent 可写）",
          row2["status"] == "archiving" and row2["archive_stage"] == "asset_uploading"
          and "upload" not in (row2["archive"] or {}),
          f"status={row2['status']} stage={row2['archive_stage']} archive={brief(row2['archive'], 120)}")
    restart_container()
    release_held()
    ensure_admin_session()
    row2 = db_row(fid2)
    check("阶段2 重启后：archiving 中断 → needs_review（不盲目重发）",
          row2["status"] == "needs_review", f"{row2['status']} / {row2['error_summary']}")
    check("阶段2 重启后：恢复数据存活（固定归档目标 + 任务 ID）",
          bool(row2["archive"]) and row2["archive"]["target"]["projectId"] == "p-docker"
          and row2["kaneo_task_id"] == tid2,
          brief(row2["archive"], 160))
    ok2, ts2 = unique_task_ok(fid2, row2)
    check("阶段2 重启未重复创建任务（mock 中本记录仍 1 个任务）", ok2, f"tasks={len(ts2)}")
    check("阶段2 重启后未产生评论/资产（未进入后续阶段）",
          not stage_view(tid2)["comments"] and not stage_view(tid2)["finalizes"],
          brief(stage_view(tid2)["all"]["calls"], 90))
    s, r2 = call("POST", f"/api/feedback/{fid2}/resolve", {"action": "recheck"})
    st2 = wait_status(fid2, ("archived", "failed", "needs_review"))
    row2 = db_row(fid2)
    mock2 = stage_view(tid2)
    check("阶段2 恢复完成：recheck 后归档成功（复用原任务、不重复建任务）",
          st2 == "archived" and len(tasks_for(fid2)) == 1, f"status={st2} tasks={len(tasks_for(fid2))}")
    check("阶段2 恢复：两次预签名都指向同一 Kaneo 任务（复用原任务，绝不新建）",
          len(mock2["presigns"]) == 2 and all(p["taskId"] == tid2 for p in mock2["presigns"]),
          brief([p["taskId"] for p in mock2["presigns"]], 120))
    check("阶段2 实现行为（同 apps/server/test/fault-injection.test.ts:75 用例）：无 key 记录时重新申请地址（新 key ≠ 旧 key）",
          len(mock2["presigns"]) == 2 and mock2["presigns"][0]["key"] != mock2["presigns"][1]["key"],
          brief(mock2["keys"], 160))
    check("阶段2 mock 事实：PUT/finalize/评论各 1 次、资产 1 个、评论 1 条",
          len(mock2["puts"]) == 1 and mock2["puts"][0]["stored"]
          and len(mock2["finalizes"]) == 1 and mock2["finalizes"][0]["key"] == mock2["presigns"][1]["key"]
          and len(mock2["assets"]) == 1 and len(mock2["comments"]) == 1,
          brief({"puts": len(mock2["puts"]), "fin": len(mock2["finalizes"]),
                 "assets": len(mock2["assets"]), "comments": len(mock2["comments"])}, 160))

    # ---------------- [7] 阶段 3：二进制 PUT 中途重启 ----------------
    print("[8] 阶段 3/5：预签名二进制 PUT —— 字节已写入远端但响应丢失时重启容器")
    fid3, held3 = submit_and_hold("docker-stage3", "阶段3：二进制 PUT 中途重启", "put")
    row3 = db_row(fid3)
    tid3 = row3["kaneo_task_id"]
    view3 = stage_view(tid3)
    key3 = row3["archive"]["upload"]["key"]
    check("阶段3 崩溃前：mock 已收到字节（1 次 PUT）且请求在途（响应未回）",
          bool(held3) and len(view3["puts"]) == 1 and view3["puts"][0]["stored"]
          and view3["puts"][0]["key"] == key3,
          f"held={brief(held3, 120)} puts={len(view3['puts'])}")
    check("阶段3 崩溃前：upload.outcome=maybe_sent 已在请求离开进程前落盘",
          row3["archive"]["upload"]["outcome"] == "maybe_sent" and row3["status"] == "archiving",
          f"outcome={row3['archive']['upload']['outcome']} status={row3['status']}")
    restart_container()
    release_held()
    ensure_admin_session()
    row3 = db_row(fid3)
    check("阶段3 重启后：needs_review 且 upload.outcome 仍为 maybe_sent（绝不降级为 not_sent）",
          row3["status"] == "needs_review" and row3["archive"]["upload"]["outcome"] == "maybe_sent",
          f"status={row3['status']} outcome={row3['archive']['upload']['outcome']}")
    check("阶段3 重启后：上传恢复数据存活（key + 加密凭证；无签名参数 → expiresAt 未知=null）",
          row3["archive"]["upload"]["key"] == key3
          and bool(row3["archive"]["upload"]["credentialsEnc"])
          and row3["archive"]["upload"].get("expiresAt", "missing") is None,
          brief({k: v for k, v in row3["archive"]["upload"].items() if k != "credentialsEnc"}, 200)
          + "（凭证可解密由随后同 key 重传成功证明）")
    call("POST", f"/api/feedback/{fid3}/resolve", {"action": "recheck"})
    st3 = wait_status(fid3, ("archived", "failed", "needs_review"))
    row3 = db_row(fid3)
    view3 = stage_view(tid3)
    same_key = len(view3["puts"]) == 2 and view3["puts"][0]["key"] == view3["puts"][1]["key"]
    same_bytes = same_key and view3["puts"][0]["sha256"] == view3["puts"][1]["sha256"]
    check("阶段3 自动恢复：同 key 重传相同字节、未申请新地址（mock 预签名仍 1 次）",
          st3 == "archived" and len(view3["presigns"]) == 1 and len(view3["keys"]) == 1
          and same_key and same_bytes,
          brief({"status": st3, "presign": len(view3["presigns"]),
                 "puts": [{"key": u["key"], "stored": u["stored"], "sha8": (u["sha256"] or "")[:8]}
                          for u in view3["puts"]]}, 240))
    check("阶段3 自动恢复：资产/评论各一次、任务未重复、recoveries=1",
          len(view3["finalizes"]) == 1 and len(view3["assets"]) == 1 and len(view3["comments"]) == 1
          and len(tasks_for(fid3)) == 1 and row3["archive"]["upload"].get("recoveries") == 1
          and row3["archive"]["upload"]["outcome"] == "confirmed",
          brief({"fin": len(view3["finalizes"]), "assets": len(view3["assets"]),
                 "comments": len(view3["comments"]), "recoveries": row3["archive"]["upload"].get("recoveries")}, 200))

    # ---------------- [8] 阶段 4：finalize 中途重启 ----------------
    print("[9] 阶段 4/5：finalizeImageUpload 登记资产 —— 请求在途时重启容器")
    fid4, held4 = submit_and_hold("docker-stage4", "阶段4：finalize 中途重启", "finalize")
    row4 = db_row(fid4)
    tid4 = row4["kaneo_task_id"]
    view4 = stage_view(tid4)
    key4 = row4["archive"]["upload"]["key"]
    check("阶段4 崩溃前：PUT 已确认并落盘（outcome=confirmed），finalize 请求在途",
          bool(held4) and row4["archive"]["upload"]["outcome"] == "confirmed"
          and len(view4["puts"]) == 1 and len(view4["assets"]) == 1
          and "asset" not in (row4["archive"] or {}),
          f"outcome={row4['archive']['upload']['outcome']} puts={len(view4['puts'])}")
    restart_container()
    release_held()
    ensure_admin_session()
    row4 = db_row(fid4)
    check("阶段4 重启后：needs_review 且 upload.outcome=confirmed 存活（绝不重传字节）",
          row4["status"] == "needs_review" and row4["archive"]["upload"]["outcome"] == "confirmed"
          and row4["archive"]["upload"]["key"] == key4,
          f"status={row4['status']} outcome={row4['archive']['upload']['outcome']}")
    call("POST", f"/api/feedback/{fid4}/resolve", {"action": "recheck"})
    st4 = wait_status(fid4, ("archived", "failed", "needs_review"))
    row4 = db_row(fid4)
    view4 = stage_view(tid4)
    check("阶段4 自动恢复：零重传（mock PUT 仍 1 次、预签名仍 1 次）",
          st4 == "archived" and len(view4["puts"]) == 1 and len(view4["presigns"]) == 1,
          brief({"status": st4, "puts": len(view4["puts"]), "presigns": len(view4["presigns"])}, 160))
    check("阶段4 自动恢复：仅对原 key 再次 finalize（同 key、资产唯一、评论 1 条、任务 1 个）",
          len(view4["finalizes"]) == 2
          and all(f["key"] == key4 for f in view4["finalizes"])
          and len(view4["assets"]) == 1 and len(view4["comments"]) == 1
          and len(tasks_for(fid4)) == 1,
          brief({"fin": [f["key"] for f in view4["finalizes"]], "assets": len(view4["assets"]),
                 "comments": len(view4["comments"])}, 200))

    # ---------------- [9] 阶段 5：评论 POST 中途重启（评论已落远端） ----------------
    print("[10] 阶段 5/5：createComment 评论 POST —— 评论已落远端但响应丢失时重启容器")
    fid5, held5 = submit_and_hold("docker-stage5a", "阶段5：评论 POST 中途重启", "comment")
    row5 = db_row(fid5)
    tid5 = row5["kaneo_task_id"]
    view5 = stage_view(tid5)
    check("阶段5 崩溃前：comment.outcome=maybe_sent 已落盘，远端评论已写入（1 条）且请求在途",
          bool(held5) and row5["archive"]["comment"]["outcome"] == "maybe_sent"
          and row5["archive"]["comment"]["id"] is None and len(view5["comments"]) == 1
          and len(view5["commentPosts"]) == 1 and view5["commentPosts"][0]["stored"],
          f"outcome={row5['archive']['comment']['outcome']} comments={len(view5['comments'])}")
    restart_container()
    release_held()
    ensure_admin_session()
    row5 = db_row(fid5)
    marker5 = f"{fid5}|{row5['screenshot_sha256']}"
    check("阶段5 重启后：needs_review 且 comment.outcome 仍为 maybe_sent（绝不降级）",
          row5["status"] == "needs_review" and row5["archive"]["comment"]["outcome"] == "maybe_sent",
          f"status={row5['status']} outcome={row5['archive']['comment']['outcome']}")
    check("阶段5 重启后：恢复数据存活（asset + 评论标记 marker=反馈ID|截图摘要）",
          bool(row5["archive"].get("asset", {}).get("url"))
          and row5["archive"]["comment"]["marker"] == marker5,
          brief({"asset": row5["archive"].get("asset", {}).get("url"),
                 "marker_ok": row5["archive"]["comment"]["marker"] == marker5}, 200))
    check("阶段5 重启后：远端评论仍恰 1 条（重启未造成重复写入）",
          len(stage_view(tid5)["comments"]) == 1, str(len(stage_view(tid5)["comments"])))
    s, r5 = call("POST", f"/api/feedback/{fid5}/resolve", {"action": "recheck"})
    st5 = wait_status(fid5, ("archived", "failed", "needs_review"))
    view5 = stage_view(tid5)
    check("阶段5 自动 recheck：查重命中即归档，零重发（mock 评论 POST 仍 1 次、远端 1 条）",
          st5 == "archived" and len(view5["commentPosts"]) == 1 and len(view5["comments"]) == 1,
          brief({"status": st5, "post": len(view5["commentPosts"]), "comments": len(view5["comments"])}, 160))

    # ---------------- [10] 阶段 5：评论未落远端的 maybe_sent + 显式 retry_comment ----------------
    print("[11] 阶段 5/5：评论未落远端（hold-before-write）→ 自动路径不重发，显式 retry_comment 至多一条")
    fid6, held6 = submit_and_hold("docker-stage5b", "阶段5b：评论未落远端", "comment", after_write=False)
    row6 = db_row(fid6)
    tid6 = row6["kaneo_task_id"]
    view6 = stage_view(tid6)
    check("阶段5b 崩溃前：maybe_sent 已落盘、远端 0 条评论（写入未到达）",
          bool(held6) and row6["archive"]["comment"]["outcome"] == "maybe_sent"
          and len(view6["comments"]) == 0 and len(view6["commentPosts"]) == 1,
          f"outcome={row6['archive']['comment']['outcome']} comments={len(view6['comments'])}")
    restart_container()
    release_held()
    ensure_admin_session()
    row6 = db_row(fid6)
    check("阶段5b 重启后：needs_review + maybe_sent 保持（不因查重未命中而当作未发送）",
          row6["status"] == "needs_review" and row6["archive"]["comment"]["outcome"] == "maybe_sent",
          f"status={row6['status']} outcome={row6['archive']['comment']['outcome']}")
    call("POST", f"/api/feedback/{fid6}/resolve", {"action": "recheck"})
    st6 = wait_status(fid6, ("archived", "failed", "needs_review"), timeout=20)
    view6 = stage_view(tid6)
    check("阶段5b 自动 recheck 绝不重发评论（mock 评论 POST 仍 1 次、远端仍 0 条）",
          st6 == "needs_review" and len(view6["commentPosts"]) == 1 and len(view6["comments"]) == 0,
          brief({"status": st6, "post": len(view6["commentPosts"]), "comments": len(view6["comments"])}, 160))
    detail6 = admin_detail(fid6)
    rec6 = detail6["recovery"]
    s, r6 = call("POST", f"/api/feedback/{fid6}/recover",
                 {"action": "retry_comment", "expectedRevision": rec6["revision"]})
    st6 = wait_status(fid6, ("archived", "failed", "needs_review"))
    view6 = stage_view(tid6)
    check("阶段5b 显式 retry_comment：查重（未命中）后**至多一条**评论（mock 远端恰 1 条）",
          s == 202 and st6 == "archived" and len(view6["comments"]) == 1
          and len(view6["commentPosts"]) == 2 and fid6 in view6["comments"][0]["content"],
          brief({"http": s, "status": st6, "post": len(view6["commentPosts"]),
                 "comments": len(view6["comments"])}, 200))
    check("阶段5b retry_comment 未重复上传/登记（PUT/finalize 仍各 1 次、任务 1 个）",
          len(view6["puts"]) == 1 and len(view6["finalizes"]) == 1 and len(tasks_for(fid6)) == 1,
          brief({"puts": len(view6["puts"]), "fin": len(view6["finalizes"])}, 160))

    # ---------------- [11] 上传地址过期 → 不自动换 key，只有 replace_upload 替换 ----------------
    print("[12] 上传地址过期（Expires 已过）→ 重启后自动路径不申请新 key，replace_upload 复用原任务")
    fid7, held7 = submit_and_hold("docker-stage-expire", "过期：上传地址已过期", "put", expire=True)
    row7 = db_row(fid7)
    tid7 = row7["kaneo_task_id"]
    key7 = row7["archive"]["upload"]["key"]
    exp7 = row7["archive"]["upload"]["expiresAt"]
    check("过期 在途证据：预签名地址带已过期 Expires 且被服务端解析为过去的 expiresAt",
          bool(held7) and exp7 is not None and exp7 < time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
          f"expiresAt={exp7}")
    restart_container()
    release_held()
    ensure_admin_session()
    row7 = db_row(fid7)
    check("过期 重启后：maybe_sent + 过期信息存活（key/expiresAt 原样保留）",
          row7["status"] == "needs_review" and row7["archive"]["upload"]["outcome"] == "maybe_sent"
          and row7["archive"]["upload"]["key"] == key7
          and row7["archive"]["upload"]["expiresAt"] == exp7,
          brief({k: v for k, v in row7["archive"]["upload"].items() if k != "credentialsEnc"}, 200))
    call("POST", f"/api/feedback/{fid7}/resolve", {"action": "recheck"})
    st7 = wait_status(fid7, ("archived", "failed", "needs_review"))
    row7 = db_row(fid7)
    view7 = stage_view(tid7)
    check("过期 自动路径绝不申请新地址（mock 预签名仍 1 次、key 不变、error_summary 含“过期”）",
          st7 == "needs_review" and len(view7["presigns"]) == 1
          and row7["archive"]["upload"]["key"] == key7
          and "过期" in (row7["error_summary"] or ""),
          brief({"status": st7, "presigns": len(view7["presigns"]), "err": row7["error_summary"]}, 200))
    detail7 = admin_detail(fid7)
    check("过期 允许动作：replace_upload 可用（唯一出路）",
          "replace_upload" in detail7["recovery"]["allowedActions"],
          brief(detail7["recovery"]["allowedActions"], 120))
    s, r7 = call("POST", f"/api/feedback/{fid7}/recover",
                 {"action": "replace_upload", "expectedRevision": detail7["recovery"]["revision"]})
    row7 = db_row(fid7)
    view7 = stage_view(tid7)
    new_keys = [p["key"] for p in view7["presigns"]]
    check("过期 replace_upload：复用原任务申请新地址（mock 预签名 2 次且同一 taskId）",
          s == 202 and len(view7["presigns"]) == 2 and all(p["taskId"] == tid7 for p in view7["presigns"])
          and new_keys[0] == key7 and new_keys[1] != key7,
          brief({"http": s, "keys": new_keys}, 200))
    check("过期 replace_upload：旧 key 记入 replacedKeys、远端旧对象不删除（资产 2 个）",
          (row7["archive"].get("replacedKeys") or []) == [key7] and len(view7["assets"]) == 2,
          brief({"replacedKeys": row7["archive"].get("replacedKeys"), "assets": view7["assets"]}, 200))
    check("过期 replace_upload 后：状态 archived、评论恰 1 条、任务仍 1 个（replaced=true）",
          r7.get("status") == "archived" and r7.get("replaced") is True
          and len(view7["comments"]) == 1 and len(tasks_for(fid7)) == 1
          and view7["finalizes"][-1]["key"] == new_keys[1],
          brief({"resp": {k: r7.get(k) for k in ("status", "replaced")},
                 "comments": len(view7["comments"])}, 200))

    # ---------------- [12] 同 key 重传被拒 → 不自动换 key，只有 replace_upload 替换 ----------------
    print("[13] 同 key 重传被业务拒绝（403）→ 自动路径不换 key，replace_upload 复用原任务")
    arm("put", "uncertain", once=True)  # 首次 PUT 连接被掐断：结果未知
    s, sub12 = submit_shot("docker-stage-samekey", "同key：重传被拒", make_png())
    check("同key 提交 201", s == 201, str((s, sub12)))
    fid8 = sub12["feedbackId"]
    st8 = wait_status(fid8, ("needs_review", "failed"))
    row8 = db_row(fid8)
    tid8 = row8["kaneo_task_id"]
    key8 = (row8["archive"] or {}).get("upload", {}).get("key")
    check("同key 首次 PUT 结果未知：maybe_sent + needs_review（mock 未存字节）",
          st8 == "needs_review" and (row8["archive"] or {}).get("upload", {}).get("outcome") == "maybe_sent"
          and key8 == stage_view(tid8)["presigns"][0]["key"],
          f"status={st8} key={key8}")
    arm("put", "definite", once=True)  # 同 key 重传被明确拒绝（403）
    call("POST", f"/api/feedback/{fid8}/resolve", {"action": "recheck"})
    st8 = wait_status(fid8, ("archived", "failed", "needs_review"))
    row8 = db_row(fid8)
    view8 = stage_view(tid8)
    check("同key 自动路径绝不换 key（mock 预签名仍 1 次、PUT 同 key 被拒、error_summary 含“同 key”）",
          st8 == "needs_review" and len(view8["presigns"]) == 1
          and row8["archive"]["upload"]["key"] == key8
          and [u["key"] for u in view8["puts"]] == [key8, key8]
          and "同 key" in (row8["error_summary"] or ""),
          brief({"status": st8, "presigns": len(view8["presigns"]), "err": row8["error_summary"]}, 200))
    detail8 = admin_detail(fid8)
    s, r8 = call("POST", f"/api/feedback/{fid8}/recover",
                 {"action": "replace_upload", "expectedRevision": detail8["recovery"]["revision"]})
    row8 = db_row(fid8)
    view8 = stage_view(tid8)
    keys8 = [p["key"] for p in view8["presigns"]]
    check("同key replace_upload：复用原任务换新 key 完成归档（评论 1 条、任务 1 个、PUT 3 次）",
          s == 202 and r8.get("status") == "archived" and len(keys8) == 2 and keys8[1] != key8
          and len(view8["comments"]) == 1 and len(tasks_for(fid8)) == 1
          and len(view8["puts"]) == 3 and view8["puts"][-1]["stored"] and view8["puts"][-1]["key"] == keys8[1]
          and (row8["archive"].get("replacedKeys") or []) == [key8],
          brief({"status": r8.get("status"), "keys": keys8, "puts": len(view8["puts"]),
                 "comments": len(view8["comments"])}, 200))

    clear_fail()
finally:
    passed = sum(1 for _, okk in results if okk)
    print(f"\n=== Docker 验证：{passed}/{len(results)} 通过 ===")
    fails = [n for n, okk in results if not okk]
    # 尽力收尾：mock 是共享长驻进程；把预签名基址还原为宿主默认值，
    # 避免影响 run_browser.py（服务端跑在宿主，用 127.0.0.1）。
    try:
        post_json(f"{MOCK}/__mock/fail", {"stage": None, "mode": None, "expire": False})
        post_json(f"{MOCK}/__mock/release", {})
        post_json(f"{MOCK}/__mock/state", {"publicBase": "http://127.0.0.1:8898"})
    except Exception as e:  # mock 已退出等情况下不掩盖真正的失败信息
        print(f"  INFO  mock 收尾还原失败（不影响结果）：{e}")
    if fails:
        print("失败：", fails)
        sys.exit(1)
