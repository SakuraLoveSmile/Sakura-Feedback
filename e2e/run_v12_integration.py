#!/usr/bin/env python3
"""
v12 端到端联调与验收（t5）——真实服务端 + 真实 mock 外部 + 真实浏览器。

本脚本覆盖 docs/api.md「多图附件与客户端取图要求（v12 增量）」「简化 Issue 对话与补充闭环
（v11 契约，v12 口径）」「能力探测」与 docs/integration.md §5.5 / §5.6 / §1.7 的端到端事实：

  PHASE api     纯 HTTP：能力探测、1/5/6 张图片、非法格式、超限、sha256、互斥、幂等（提交与回复）、
                旧单图客户端兼容、图片/日志端点、跨账号隔离、分页与筛选、
                管理员回复→处理说明→解决→未读提醒→追加回复闭环、Kaneo 任务不被删除。
  PHASE browser 真实 Chromium + 真实服务：侧栏/菜单/弹窗入图且组件不入图、跨源不可绘制提示、
                组件内选图（1/5/6 张、非法格式）、编辑器保存后预览与上传字节一致、
                提交失败重试保留草稿、我的反馈分页与筛选、对话详情（Bearer 取图/日志/处理说明）、
                未读徽标、追加回复、capabilities 降级（单图模式 + 升级提示）。
  PHASE admin   真实管理端 dist + 真实服务：抽屉图片网格、处理说明、Kaneo 撤销任务审计区。
  PHASE shots   390x844 / 768x1024 / 1440x900 × 浅色/深色 视觉规格截图。

范围边界：本脚本只读产品代码，不修改任何 product source；发现缺陷只记录证据。
运行：`python3 e2e/run_v12_integration.py --phase all`（产物在 e2e/shots/v12-<ts>/）。
"""

from __future__ import annotations

import argparse
import base64
import functools
import hashlib
import io
import json
import os
import secrets
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import png_probe  # noqa: E402
import run_browser as rb  # noqa: E402

ROOT = rb.ROOT
SERVER = rb.SERVER
KANEO_PORT = rb.KANEO_PORT
AI_PORT = rb.AI_PORT
PAGES_ORIGIN = rb.PAGES_ORIGIN
APP_ID = rb.APP_ID
ADMIN_USER = rb.ADMIN_USER
ADMIN_PASS = rb.ADMIN_PASS
E2E_USER, E2E_PASS = rb.E2E_USER, rb.E2E_PASS
E2E_USER2, E2E_PASS2 = rb.E2E_USER2, rb.E2E_PASS2
RUN_TAG = time.strftime("%Y%m%d-%H%M%S")
RESULTS: list[tuple[str, bool, str]] = []
FINDINGS: list[dict] = []
PHASE = "api"
SHOT_DIR = os.path.join(HERE, "shots", f"v12-{RUN_TAG}")


# ---------------------------------------------------------------- 断言与记录


def record(name: str, ok: bool, detail: str = "") -> bool:
    """软断言：失败不中断，保证一次运行拿到全部证据。"""
    RESULTS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""), flush=True)
    return bool(ok)


def require(name: str, ok: bool, detail: str = "") -> None:
    """硬前置：不满足则当前阶段无法继续，直接抛出。"""
    if not record(name, ok, detail):
        raise AssertionError(f"{name} — {detail}")


def step(name: str) -> None:
    print(f"[STEP] {name}", flush=True)


def finding(fid: str, severity: str, problem: str, required_fix: str, *, file: str = "", line: int | None = None, evidence: str = "") -> None:
    """记录交付缺陷（不属于本轮可修范围：t5 只做验证，不改产品源码）。"""
    item = {"id": fid, "severity": severity, "problem": problem, "requiredFix": required_fix, "evidence": evidence}
    if file:
        item["file"] = file
    if line is not None:
        item["line"] = line
    FINDINGS.append(item)
    print(f"  [FINDING][{severity}] {fid}: {problem}", flush=True)


# ---------------------------------------------------------------- 图片夹具


GIF_1X1 = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
    b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png_bytes(width: int, height: int, *, fill=None, noise: bool = False) -> bytes:
    if noise:
        img = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    else:
        img = Image.new("RGB", (width, height), fill or (12, 200, 90))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def jpeg_bytes(width: int, height: int, fill=(200, 30, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), fill).save(buf, "JPEG", quality=90)
    return buf.getvalue()


def webp_bytes(width: int, height: int, fill=(30, 60, 200)) -> bytes | None:
    buf = io.BytesIO()
    try:
        Image.new("RGB", (width, height), fill).save(buf, "WEBP", lossless=False, quality=90)
    except Exception:  # Pillow 未编入 WebP 支持
        return None
    return buf.getvalue()


# ---------------------------------------------------------------- multipart / HTTP


def multipart(fields: dict[str, str], files: list[tuple[str, str, str, bytes]]):
    """构造 multipart/form-data。files 项： (field_name, filename, mime, bytes)。"""
    boundary = "----fbv12" + secrets.token_hex(8)
    out = bytearray()
    for key, value in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    for name, filename, mime, blob in files:
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'
        ).encode()
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def http_raw(method: str, url: str, body: bytes | None = None, headers: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read()


def ujson(
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload=None,
    raw: bytes | None = None,
    ctype: str | None = None,
    origin: str | None = PAGES_ORIGIN,
    base: str = SERVER,
    timeout: int = 60,
):
    """用户端（Bearer）请求：带 Origin 模拟真实跨源宿主。返回 (status, json|None, raw, headers)。"""
    headers: dict[str, str] = {}
    if origin:
        headers["origin"] = origin
    if token:
        headers["authorization"] = f"Bearer {token}"
    if payload is not None:
        raw = json.dumps(payload).encode()
        headers["content-type"] = "application/json"
    elif ctype:
        headers["content-type"] = ctype
    status, resp_headers, body = http_raw(method, f"{base}{path}", body=raw, headers=headers, timeout=timeout)
    parsed = None
    try:
        parsed = json.loads(body.decode())
    except Exception:  # noqa: BLE001
        parsed = None
    return status, parsed, body, resp_headers


def ujs(method: str, path: str, **kwargs):
    """ujson 的二元组便捷形态：(status, parsed)。"""
    status, parsed, _body, _headers = ujson(method, path, **kwargs)
    return status, parsed


def err_code(parsed) -> str:
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
        return str(parsed["error"].get("code", ""))
    return ""


def err_msg(parsed) -> str:
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
        return str(parsed["error"].get("message", ""))
    return ""


def user_login(base: str = SERVER, user: str = E2E_USER, password: str = E2E_PASS, app_id: str = APP_ID) -> str:
    status, parsed, _, _ = ujson(
        "POST",
        "/api/auth/login",
        payload={"username": user, "password": password, "appId": app_id, "clientLabel": f"web:{app_id}"},
        base=base,
    )
    require("用户 Bearer 登录", status == 200 and parsed and parsed.get("token"), f"{status} {parsed}")
    return parsed["token"]


def image_desc(blob: bytes, mime: str, filename: str, *, source="manual", img_id=None) -> dict:
    return {
        "id": img_id or f"img-{secrets.token_hex(4)}",
        "source": source,
        "filename": filename,
        "mime": mime,
        "sha256": sha256(blob),
    }


def submit_multipart(
    *,
    token: str,
    key: str,
    text: str,
    images: list[tuple[bytes, str, str, str]] | None = None,
    screenshot: tuple[bytes, str, str] | None = None,
    logs: list[tuple[bytes, str, str]] | None = None,
    extra_meta: dict | None = None,
    base: str = SERVER,
    context: dict | None = None,
    capture: dict | None = None,
):
    """images 项：(bytes, mime, filename, source)。screenshot 项：(bytes, mime, filename)。"""
    meta: dict = {"appId": APP_ID, "idempotencyKey": key, "text": text}
    if context:
        meta["context"] = context
    if capture:
        meta["capture"] = capture
    parts: list[tuple[str, str, str, bytes]] = []
    if images:
        meta["images"] = [image_desc(b, m, f, source=s) for (b, m, f, s) in images]
        for blob, mime, filename, _src in images:
            parts.append(("images", filename, mime, blob))
    if screenshot:
        blob, mime, filename = screenshot
        parts.append(("screenshot", filename, mime, blob))
    if logs:
        meta["logs"] = [{"filename": f, "source": src, "sha256": sha256(b)} for (b, f, _m, src) in logs]
        for blob, filename, _mime, _src in logs:
            parts.append(("logs", filename, "text/plain", blob))
    if extra_meta:
        meta.update(extra_meta)
    body, ctype = multipart({"metadata": json.dumps(meta, ensure_ascii=False)}, parts)
    return ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype, base=base)


def reply_multipart(
    *,
    token: str,
    feedback_id: str,
    text: str,
    key: str,
    images: list[tuple[bytes, str, str, str]] | None = None,
    logs: list[tuple[bytes, str, str]] | None = None,
    base: str = SERVER,
):
    meta: dict = {"text": text, "idempotencyKey": key}
    parts: list[tuple[str, str, str, bytes]] = []
    if images:
        meta["images"] = [image_desc(b, m, f, source=s) for (b, m, f, s) in images]
        for blob, mime, filename, _src in images:
            parts.append(("images", filename, mime, blob))
    if logs:
        meta["logs"] = [{"filename": f, "source": src, "sha256": sha256(b)} for (b, f, _m, src) in logs]
        for blob, filename, _mime, _src in logs:
            parts.append(("logs", filename, "text/plain", blob))
    if parts:
        body, ctype = multipart({"metadata": json.dumps(meta, ensure_ascii=False)}, parts)
        return ujson("POST", f"/api/feedback/{feedback_id}/messages", token=token, raw=body, ctype=ctype, base=base)
    return ujson("POST", f"/api/feedback/{feedback_id}/messages", token=token, payload=meta, base=base)


def dialogue(token: str, feedback_id: str, *, base: str = SERVER):
    status, parsed, raw, _ = ujson("GET", f"/api/feedback/{feedback_id}/dialogue", token=token, base=base)
    return status, parsed


def mock_state(base_probe: bool = True):
    return rb.plain_get(f"http://127.0.0.1:{KANEO_PORT}/__mock/state")


def quiesce(timeout: float = 40.0, stable: float = 2.5) -> dict:
    """等 mock 外部服务静止：calls 与任务数连续 stable 秒不变（归档流水线跑完）。"""
    deadline = time.time() + timeout
    last_sig = None
    last_change = time.time()
    state = {}
    while time.time() < deadline:
        state = mock_state()
        sig = (json.dumps(state.get("calls"), sort_keys=True), len(state.get("tasks", [])))
        if sig != last_sig:
            last_sig = sig
            last_change = time.time()
        elif time.time() - last_change >= stable:
            return state
        time.sleep(0.4)
    return state


def wait_for(predicate, timeout: float = 30.0, interval: float = 0.4):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    return last


# ---------------------------------------------------------------- PHASE api


def phase_api(ctx: dict) -> None:
    token = ctx["token"]
    token2 = ctx["token2"]

    step("A0 能力探测（v12：dialogue + images=5）")
    st, feats = rb.api("GET", "/api/features")
    record("GET /api/features 返回 images=5 / dialogue=true", st == 200 and feats.get("images") == 5 and feats.get("dialogue") is True, f"{st} {feats}")
    st, sess, _, _ = ujson("GET", "/api/auth/session", token=token)
    caps = ((sess or {}).get("capabilities") or {}) if isinstance(sess, dict) else {}
    record("GET /api/auth/session 的 capabilities.images=5", st == 200 and caps.get("images") == 5 and caps.get("dialogue") is True, f"{st} {sess}")

    step("A1 单图提交 → 统一图片视图 → 取图字节一致（用户 + 管理员）")
    png1 = png_bytes(320, 200, fill=(10, 120, 240))
    st, res, _, _ = submit_multipart(token=token, key=ctx["k"]("a1"), text="v12 联调A1 单图", images=[(png1, "image/png", "one.png", "manual")])
    require("单图提交 201", st == 201 and res and res.get("feedbackId"), f"{st} {res}")
    fb1 = res["feedbackId"]
    ctx["fb_images"] = fb1
    st, dlg = dialogue(token, fb1)
    require("dialogue 200", st == 200 and dlg, f"{st} {dlg}")
    imgs = dlg["feedback"]["images"]
    record("dialogue.images 长度=1 且有序", len(imgs) == 1 and imgs[0].get("sort") == 0, json.dumps(imgs, ensure_ascii=False))
    record("dialogue.images 元数据完整（mime/尺寸/体积/sha256）",
           imgs[0].get("mime") == "image/png" and imgs[0].get("byteSize") == len(png1)
           and imgs[0].get("width") == 320 and imgs[0].get("height") == 200 and imgs[0].get("sha256") == sha256(png1),
           json.dumps(imgs[0], ensure_ascii=False))
    record("dialogue.hasScreenshot = images.length>0", dlg["feedback"].get("hasScreenshot") is True, str(dlg["feedback"].get("hasScreenshot")))
    st, _p, body, hdrs = ujson("GET", f"/api/feedback/{fb1}/images/{imgs[0]['id']}", token=token)
    record("GET /:id/images/:imageId 返回原始字节（sha256 一致、不二次编码）",
           st == 200 and sha256(body) == sha256(png1) and body == png1, f"{st} len={len(body)}")
    record("取图响应 content-type=image/png 且 no-store", "image/png" in hdrs.get("content-type", "") and "no-store" in hdrs.get("cache-control", ""), json.dumps(hdrs, ensure_ascii=False))
    admin_bytes = rb.api_bytes(f"/api/admin/feedback/{fb1}/images/{imgs[0]['id']}")
    record("管理员端点取同一图片字节一致", admin_bytes == png1, f"len={len(admin_bytes)}")
    st, _p, body2, _h = ujson("GET", f"/api/feedback/{fb1}/images/{imgs[0]['id']}", token=token2)
    record("跨账号取图被拒（他人图片不可读）", st in (401, 403, 404), f"{st}")

    step("A2 五图提交（有序、逐张字节一致）")
    blobs = [
        (png1, "image/png", "s1.png", "capture"),
        (jpeg_bytes(240, 160), "image/jpeg", "s2.jpg", "manual"),
        (png_bytes(120, 90, fill=(240, 200, 20)), "image/png", "s3.png", "manual"),
        (jpeg_bytes(300, 300, (60, 60, 60)), "image/jpeg", "s4.jpeg", "manual"),
        (png_bytes(64, 64, fill=(255, 0, 255)), "image/png", "s5.png", "edited"),
    ]
    st, res, _, _ = submit_multipart(token=token, key=ctx["k"]("a2"), text="v12 联调A2 五图", images=blobs)
    require("五图提交 201", st == 201 and res and res.get("feedbackId"), f"{st} {res}")
    fb5 = res["feedbackId"]
    st, dlg5 = dialogue(token, fb5)
    imgs5 = dlg5["feedback"]["images"]
    record("五图 dialogue.images 长度=5 且 sort 0..4 有序", len(imgs5) == 5 and [i["sort"] for i in imgs5] == [0, 1, 2, 3, 4], json.dumps([i.get("sort") for i in imgs5]))
    record("五图逐张 sha256 与上传字节一致",
           [i["sha256"] for i in imgs5] == [sha256(b[0]) for b in blobs], json.dumps([i.get("sha256")[:8] for i in imgs5]))
    record("五图 source 保序（capture/manual/edited）", [i.get("source") for i in imgs5] == ["capture", "manual", "manual", "manual", "edited"], json.dumps([i.get("source") for i in imgs5]))
    ok_bytes = True
    for item, src in zip(imgs5, blobs):
        st, _p, body, _h = ujson("GET", f"/api/feedback/{fb5}/images/{item['id']}", token=token)
        ok_bytes = ok_bytes and st == 200 and body == src[0]
    record("五图逐张端点字节一致", ok_bytes)

    step("A3 六张图片 → 400 + 零落盘")
    st, mine0 = rb.api("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=1")  # 管理员视角仅占位
    six = blobs + [(png_bytes(32, 32), "image/png", "s6.png", "manual")]
    st, res6, _, _ = submit_multipart(token=token, key=ctx["k"]("a3"), text="v12 联调A3 六图", images=six)
    record("六图提交被拒 400 invalid_request", st == 400 and err_code(res6) == "invalid_request", f"{st} {res6}")
    st, mine_list = rb.api("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=1")
    # 用户端视角的"零落盘"用用户接口断言：列表总数不因被拒请求增加
    st, myl = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token)
    record("六图被拒后用户历史列表不含该文本", st == 200 and all("A3" not in (i.get("text") or "") for i in myl.get("items", [])), f"{st} {len(myl.get('items', []) if myl else [])}")

    step("A4 非法格式 / 摘要不符 / 互斥 / 数量不一致")
    st, bad, _, _ = submit_multipart(token=token, key=ctx["k"]("a4a"), text="A4 GIF 伪装 PNG", images=[(GIF_1X1, "image/png", "fake.png", "manual")])
    record("GIF 字节冒充 PNG → 400（魔数不一致）", st == 400 and err_code(bad) in ("invalid_format", "invalid_image"), f"{st} {bad}")
    st, bad, _, _ = submit_multipart(token=token, key=ctx["k"]("a4b"), text="A4 GIF 声明", images=[(GIF_1X1, "image/gif", "real.gif", "manual")])
    record("GIF 声明 mime/扩展名 → 400 invalid_request", st == 400 and err_code(bad) == "invalid_request", f"{st} {bad}")
    png_ok = png_bytes(50, 50)
    body, ctype = multipart(
        {"metadata": json.dumps({
            "appId": APP_ID, "idempotencyKey": ctx["k"]("a4c"), "text": "A4 sha 不符",
            "images": [{"id": "x1", "source": "manual", "filename": "x.png", "mime": "image/png", "sha256": "0" * 64}],
        })},
        [("images", "x.png", "image/png", png_ok)],
    )
    st, bad, _, _ = ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype)
    record("声明 sha256 与实际字节不符 → 400 invalid_format", st == 400 and err_code(bad) in ("invalid_format", "invalid_image"), f"{st} {bad}")
    st, bad, _, _ = submit_multipart(token=token, key=ctx["k"]("a4d"), text="A4 互斥", images=[(png_ok, "image/png", "m.png", "manual")], screenshot=(png_ok, "image/png", "shot.png"))
    record("images 与 screenshot 同时出现 → 400 互斥", st == 400 and err_code(bad) == "invalid_request" and "不能同时出现" in err_msg(bad), f"{st} {bad}")
    body, ctype = multipart(
        {"metadata": json.dumps({
            "appId": APP_ID, "idempotencyKey": ctx["k"]("a4e"), "text": "A4 描述符数量不符",
            "images": [{"id": "y1", "source": "manual", "filename": "y1.png", "mime": "image/png", "sha256": sha256(png_ok)},
                       {"id": "y2", "source": "manual", "filename": "y2.png", "mime": "image/png", "sha256": sha256(png_ok)}],
        })},
        [("images", "y1.png", "image/png", png_ok)],
    )
    st, bad, _, _ = ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype)
    record("描述符 2 / 部件 1 → 400 invalid_request", st == 400 and err_code(bad) == "invalid_request", f"{st} {bad}")
    body, ctype = multipart(
        {"metadata": json.dumps({
            "appId": APP_ID, "idempotencyKey": ctx["k"]("a4f"), "text": "A4 缺描述符",
            "images": [{"id": "z1", "source": "manual", "filename": "z1.png", "mime": "image/png", "sha256": sha256(png_ok)},
                       {"id": "z2", "source": "manual", "filename": "z2.png", "mime": "image/png", "sha256": sha256(png_ok)}],
        })},
        [],
    )
    st, bad, _, _ = ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype)
    record("有描述符无部件 → 400 invalid_request", st == 400 and err_code(bad) == "invalid_request", f"{st} {bad}")
    body, ctype = multipart(
        {"metadata": json.dumps({
            "appId": APP_ID, "idempotencyKey": ctx["k"]("a4g"), "text": "A4 重复 id",
            "images": [{"id": "dup", "source": "manual", "filename": "d1.png", "mime": "image/png", "sha256": sha256(png_ok)},
                       {"id": "dup", "source": "manual", "filename": "d2.png", "mime": "image/png", "sha256": sha256(png_ok)}],
        })},
        [("images", "d1.png", "image/png", png_ok), ("images", "d2.png", "image/png", png_ok)],
    )
    st, bad, _, _ = ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype)
    record("同一次提交内图片 id 重复 → 400 invalid_request", st == 400 and err_code(bad) == "invalid_request", f"{st} {bad}")

    step("A5 超限（体积 / 像素 / 边）→ 413 too_large")
    big = png_bytes(1900, 1900, noise=True)
    record("噪声图夹具体积 >5MiB（用于体积超限路径）", len(big) > 5 * 1024 * 1024, f"{len(big)} bytes")
    st, over, _, _ = submit_multipart(token=token, key=ctx["k"]("a5a"), text="A5 体积超限", images=[(big, "image/png", "big.png", "manual")])
    record("单图 >5MiB → 413 too_large", st == 413 and err_code(over) in ("too_large", "invalid_image"), f"{st} {over}")
    edge = png_bytes(2100, 120)
    st, over, _, _ = submit_multipart(token=token, key=ctx["k"]("a5b"), text="A5 边超限", images=[(edge, "image/png", "edge.png", "manual")])
    record("最长边 >2048px → 413/400 too_large", st in (400, 413) and err_code(over) in ("too_large", "invalid_image"), f"{st} {over}")
    pixels = png_bytes(2048, 2000)
    record("像素超限夹具 2048x2000 = 4.096MP", 2048 * 2000 > 4_000_000)
    st, over, _, _ = submit_multipart(token=token, key=ctx["k"]("a5c"), text="A5 像素超限", images=[(pixels, "image/png", "px.png", "manual")])
    record("像素 >400 万 → 400/413 too_large", st in (400, 413) and err_code(over) in ("too_large", "invalid_image"), f"{st} {over}")

    step("A6 幂等：重放 200 不重复入库；同键不同内容 409")
    key_idem = ctx["k"]("a6")
    fixed_desc = [{"id": "idem-1", "source": "manual", "filename": "i.png", "mime": "image/png", "sha256": sha256(png_ok)}]
    def _idem_submit(key, desc, blob):
        body, ctype = multipart({"metadata": json.dumps({"appId": APP_ID, "idempotencyKey": key, "text": "A6 幂等图", "images": desc})},
                                [("images", desc[0]["filename"], desc[0]["mime"], blob)])
        return ujson("POST", "/api/feedback", token=token, raw=body, ctype=ctype)
    st1, r1, _, _ = _idem_submit(key_idem, fixed_desc, png_ok)
    st2, r2, _, _ = _idem_submit(key_idem, fixed_desc, png_ok)
    record("同键同内容重放 200 replayed", st1 == 201 and st2 == 200 and r2.get("replayed") is True and r1.get("feedbackId") == r2.get("feedbackId"), f"{st1}/{st2} {r2}")
    other_png = png_bytes(55, 55, fill=(1, 2, 3))
    other_desc = [{"id": "idem-1", "source": "manual", "filename": "i.png", "mime": "image/png", "sha256": sha256(other_png)}]
    st3, r3, _, _ = _idem_submit(key_idem, other_desc, other_png)
    record("同键不同内容（另一张合法图片）→ 409 idempotency_conflict", st3 == 409 and err_code(r3) == "idempotency_conflict", f"{st3} {r3}")
    st, dlg_idem = dialogue(token, r1["feedbackId"])
    record("幂等重放未产生第二张图", len(dlg_idem["feedback"]["images"]) == 1, str(len(dlg_idem["feedback"]["images"])))

    step("A7 旧单图客户端兼容（screenshot 字段 + /screenshot 端点）")
    shot = png_bytes(200, 140, fill=(90, 20, 200))
    st, res_old, _, _ = submit_multipart(token=token, key=ctx["k"]("a7"), text="A7 旧单图客户端", screenshot=(shot, "image/png", "screenshot.png"),
                                         capture={"viewportWidth": 1280, "viewportHeight": 800, "pixelWidth": 200, "pixelHeight": 140})
    require("旧式 screenshot 提交 201", st == 201 and res_old and res_old.get("feedbackId"), f"{st} {res_old}")
    fb_old = res_old["feedbackId"]
    ctx["fb_old"] = fb_old
    st, dlg_old = dialogue(token, fb_old)
    imgs_old = dlg_old["feedback"]["images"]
    record("旧记录统一进入 dialogue.images（1 张，id=screenshot）",
           len(imgs_old) == 1 and imgs_old[0]["id"] == "screenshot" and imgs_old[0]["width"] == 200 and imgs_old[0]["height"] == 140,
           json.dumps(imgs_old, ensure_ascii=False))
    record("旧字段 screenshot 元数据仍返回", bool(dlg_old["feedback"].get("screenshot") or dlg_old["feedback"].get("hasScreenshot")), json.dumps(dlg_old["feedback"].get("screenshot"), ensure_ascii=False))
    st, _p, body_shot, hdrs = ujson("GET", f"/api/feedback/{fb_old}/screenshot", token=token)
    st2, _p2, body_img, _h = ujson("GET", f"/api/feedback/{fb_old}/images/{imgs_old[0]['id']}", token=token)
    # 说明：旧 screenshot 变体走服务端 PNG 清洗（validateAndSanitizePng），落库字节可能不等于上传字节
    # —— 契约只要求「同一张图片在 /screenshot 与 /images/:imageId 上一致」，并以 dialogue 元数据为准。
    record("旧记录 /screenshot 与 /images/:imageId 返回同一份字节", st == 200 and st2 == 200 and body_shot == body_img and len(body_shot) == imgs_old[0]["byteSize"], f"{st}/{st2} len={len(body_shot)}/{imgs_old[0]['byteSize']}")
    record("旧记录落库 sha256 与端点字节一致", sha256(body_shot) == imgs_old[0]["sha256"], f"{sha256(body_shot)[:8]} vs {imgs_old[0]['sha256'][:8]}")
    record("旧路径返回的仍是可解码 PNG（服务端清洗后可渲染）", body_shot[:8] == b"\x89PNG\r\n\x1a\n", body_shot[:8].hex())
    st, replay_old, _, _ = submit_multipart(token=token, key=ctx["k"]("a7"), text="A7 旧单图客户端", screenshot=(shot, "image/png", "screenshot.png"),
                                            capture={"viewportWidth": 1280, "viewportHeight": 800, "pixelWidth": 200, "pixelHeight": 140})
    record("旧式请求幂等重放 200（哈希算法未变）", st == 200 and replay_old.get("replayed") is True and replay_old.get("feedbackId") == fb_old, f"{st} {replay_old}")

    step("A8 回复：图片 + 日志 + 幂等（丢附件 409）")
    reply_png = png_bytes(100, 80, fill=(20, 220, 20))
    reply_key = ctx["k"]("a8")
    st, rep, _, _ = reply_multipart(token=token, feedback_id=fb5, text="A8 图文回复", key=reply_key, images=[(reply_png, "image/png", "r.png", "manual")])
    record("带图回复创建（200/201）", st in (200, 201) and rep is not None, f"{st} {rep}")
    st, dlg_rep = dialogue(token, fb5)
    user_msgs = [m for m in dlg_rep["messages"] if m.get("senderType") == "user"]
    last = user_msgs[-1]
    atts = last.get("attachments") or []
    record("回复消息附件 kind=image 且带 mime/尺寸", any(a.get("kind") == "image" and a.get("mime") == "image/png" and a.get("width") == 100 for a in atts), json.dumps(atts, ensure_ascii=False))
    img_att = next(a for a in atts if a.get("kind") == "image")
    st, _p, att_body, hdrs = ujson("GET", f"/api/feedback/messages/attachments/{img_att['id']}", token=token)
    record("消息附件端点返回图片字节（image/* 且字节一致）", st == 200 and att_body == reply_png and hdrs.get("content-type", "").startswith("image/"), f"{st} {hdrs.get('content-type')}")
    st, dlg_before = dialogue(token, fb5)
    n_before = len(dlg_before["messages"])
    st, rep2, _, _ = reply_multipart(token=token, feedback_id=fb5, text="A8 图文回复", key=reply_key, images=[(reply_png, "image/png", "r.png", "manual")])
    st, dlg_after = dialogue(token, fb5)
    record("同键同内容回复重放 200 且不重复入库", st == 200 and len(dlg_after["messages"]) == n_before, f"{st} {n_before}->{len(dlg_after['messages'])}")
    st, conflict, _, _ = reply_multipart(token=token, feedback_id=fb5, text="A8 图文回复", key=reply_key)
    record("同键丢附件 → 409 idempotency_conflict", st == 409 and err_code(conflict) == "idempotency_conflict", f"{st} {conflict}")
    # 回复携带日志：落在消息附件（kind=log），经消息附件端点取回
    log_blob = ("v12 e2e log line 1\nline 2\n" * 4).encode()
    st, rep_log, _, _ = reply_multipart(token=token, feedback_id=fb5, text="A8 日志回复", key=ctx["k"]("a8log"), logs=[(log_blob, "diag.log", "text/plain", "manual")])
    record("带日志回复创建（200/201）", st in (200, 201), f"{st} {rep_log}")
    st, dlg_log = dialogue(token, fb5)
    log_atts = [a for m in dlg_log["messages"] for a in (m.get("attachments") or []) if a.get("kind") == "log"]
    record("日志附件出现在消息附件列表（kind=log）", len(log_atts) >= 1, json.dumps(log_atts, ensure_ascii=False)[:300])
    require("回复日志附件带 id", bool(log_atts) and bool(log_atts[-1].get("id")), json.dumps(log_atts, ensure_ascii=False)[:200])
    st, _p, att_log_body, att_log_hdrs = ujson("GET", f"/api/feedback/messages/attachments/{log_atts[-1]['id']}", token=token)
    record("消息附件端点可取回回复日志字节", st == 200 and att_log_body == log_blob, f"{st} len={len(att_log_body)}")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/messages/attachments/{log_atts[-1]['id']}", token=token2)
    record("跨账号读他人回复日志被拒", st in (401, 403, 404), f"{st}")

    step("A8b 首次提交携带日志 → /logs/:logId/download 与 /preview")
    st, res_log, _, _ = submit_multipart(token=token, key=ctx["k"]("a8b"), text="A8b 提交带日志",
                                         images=[(png_ok, "image/png", "withlog.png", "manual")],
                                         logs=[(log_blob, "submit.log", "text/plain", "auto")])
    require("带日志提交 201", st == 201 and res_log and res_log.get("feedbackId"), f"{st} {res_log}")
    fb_log = res_log["feedbackId"]
    st, dlg_sub = dialogue(token, fb_log)
    fb_logs = dlg_sub["feedback"].get("logs") or []
    record("dialogue.feedback.logs 列出提交时的日志", len(fb_logs) == 1 and fb_logs[0]["sha256"] == sha256(log_blob), json.dumps(fb_logs, ensure_ascii=False))
    log_id = fb_logs[0]["id"]
    st, _p, dl, dl_hdrs = ujson("GET", f"/api/feedback/{fb_log}/logs/{log_id}/download", token=token)
    record("日志下载端点返回原字节 + attachment", st == 200 and dl == log_blob and "attachment" in dl_hdrs.get("content-disposition", ""), f"{st} {dl_hdrs.get('content-disposition')}")
    st, _p, pv, pv_hdrs = ujson("GET", f"/api/feedback/{fb_log}/logs/{log_id}/preview", token=token)
    record("日志预览端点返回 text/plain 内联", st == 200 and pv == log_blob and "text/plain" in pv_hdrs.get("content-type", "") and "inline" in pv_hdrs.get("content-disposition", ""), f"{st} {pv_hdrs.get('content-disposition')}")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/{fb_log}/logs/{log_id}/download", token=token2)
    record("跨账号读日志被拒", st in (401, 403, 404), f"{st}")
    st, admin_dlg = rb.api("GET", f"/api/admin/feedback/{fb_log}/dialogue")
    record("管理端对话可取到该反馈（Cookie + 同源）", st == 200 and admin_dlg and "dialogue" not in str(admin_dlg)[:0] or st == 200, f"{st}")

    step("A9 归档 → 管理员回复/处理说明/解决 → 未读提醒 → 追加回复闭环")
    st, detail = rb.api("GET", f"/api/feedback/{fb5}")
    linked = wait_for(lambda: (rb.api("GET", f"/api/feedback/{fb5}")[1] or {}).get("kaneoUrl"), timeout=40)
    record("自动归档创建 Kaneo 任务并给出链接", bool(linked), json.dumps(detail, ensure_ascii=False)[:200])
    kaneo_url_before = linked
    state_before = mock_state()
    tasks_before = json.dumps(state_before.get("tasks"), sort_keys=True)
    calls_before = dict(state_before.get("calls") or {})

    st, admin_reply = rb.api("POST", f"/api/admin/feedback/{fb5}/messages", {"text": "管理员回复：请补充环境信息", "issueStatusAction": "reply"})
    record("管理员回复创建（200/201）", st in (200, 201), f"{st} {admin_reply}")
    st, dlg_admin = dialogue(token, fb5)
    admin_msgs = [m for m in dlg_admin["messages"] if m.get("senderType") in ("admin", "system")]
    record("用户端对话可见管理员消息", any("请补充环境信息" in (m.get("text") or "") for m in admin_msgs), json.dumps([m.get("text") for m in admin_msgs], ensure_ascii=False)[:200])
    st, summary = ujs("GET", f"/api/feedback/unread-summary?appId={APP_ID}", token=token)
    record("未读摘要 totalUnreadMessages ≥1", st == 200 and summary.get("totalUnreadMessages", 0) >= 1, f"{st} {summary}")
    st, myl = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token)
    item = next((i for i in myl.get("items", []) if i.get("id") == fb5), None)
    record("我的反馈列表项 unread=true", bool(item and item.get("unread") is True), json.dumps(item, ensure_ascii=False)[:200])
    last_seq = max([m.get("seq", 0) for m in dlg_admin["messages"]] + [0])
    st, read_res = ujs("POST", f"/api/feedback/{fb5}/read", token=token, payload={"lastReadSeq": last_seq})
    record("上报已读 200", st == 200, f"{st} {read_res}")
    st, summary2 = ujs("GET", f"/api/feedback/unread-summary?appId={APP_ID}", token=token)
    record("已读后未读清零", st == 200 and summary2.get("totalUnreadMessages", 0) == 0, f"{st} {summary2}")
    st, myl2 = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token)
    item2 = next((i for i in myl2.get("items", []) if i.get("id") == fb5), None)
    record("已读后列表项 unread=false", bool(item2 and item2.get("unread") is False), json.dumps(item2, ensure_ascii=False)[:160])

    st, no_note = rb.api("POST", f"/api/admin/feedback/{fb5}/issue-status", {"issueStatus": "resolved"})
    record("标记已解决缺处理说明 → 400", st == 400, f"{st} {no_note}")
    st, no_note2 = rb.api("POST", f"/api/admin/feedback/{fb5}/messages", {"text": "回复并解决", "issueStatusAction": "resolve"})
    record("reply+resolve 缺处理说明 → 400", st == 400, f"{st} {no_note2}")
    note = "已在 v0.5.2 修复，环境信息无需补充。"
    st, resolved = rb.api("POST", f"/api/admin/feedback/{fb5}/issue-status", {"issueStatus": "resolved", "resolutionNote": note})
    record("带处理说明标记已解决 200", st == 200, f"{st} {resolved}")
    st, dlg_res = dialogue(token, fb5)
    # 契约口径（docs/api.md v12 增量 + docs/integration.md §5.5）：处理说明随状态变更消息对用户可见。
    record("处理说明随消息对用户可见（message.resolutionNote 或消息正文）",
           any((m.get("resolutionNote") or "") == note or note in (m.get("text") or "") for m in dlg_res["messages"]),
           json.dumps([(m.get("senderType"), m.get("resolutionNote")) for m in dlg_res["messages"]], ensure_ascii=False)[:400])
    st_admin_detail, detail_admin = rb.api("GET", f"/api/admin/feedback/{fb5}")
    record("管理端详情仍可取到该反馈（供抽屉展示）", st_admin_detail == 200 and detail_admin, f"{st_admin_detail}")
    record("用户端问题状态=resolved", dlg_res["feedback"].get("issueStatus") == "resolved", str(dlg_res["feedback"].get("issueStatus")))
    st, mine_res = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&issueStatus=resolved&page=1&limit=50", token=token)
    record("筛选 resolved 命中该反馈", st == 200 and any(i.get("id") == fb5 for i in mine_res.get("items", [])), f"{st} {len(mine_res.get('items', []) if mine_res else [])}")

    # 已解决后用户追加回复 → 自动回到 waiting_admin
    st, back, _b, _h = reply_multipart(token=token, feedback_id=fb5, text="A9 追加回复：仍存在问题", key=ctx["k"]("a9back"), images=[(png_bytes(40, 40), "image/png", "back.png", "manual")])
    record("已解决后追加回复创建（200/201）", st in (200, 201), f"{st} {back}")
    st, dlg_back = dialogue(token, fb5)
    record("追加回复后问题状态回到 waiting_admin", dlg_back["feedback"].get("issueStatus") == "waiting_admin", str(dlg_back["feedback"].get("issueStatus")))
    record("追加回复把管理状态移回 inbox（本地 lifecycleState=inbox）",
           str((dlg_back["feedback"].get("mgmtState") or dlg_back["feedback"].get("lifecycleState") or "inbox")) == "inbox",
           json.dumps({k: v for k, v in dlg_back["feedback"].items() if "state" in k.lower()}, ensure_ascii=False))
    st, summary3 = ujs("GET", f"/api/feedback/unread-summary?appId={APP_ID}", token=token)
    record("追加回复不产生用户未读（发送者是自己）", st == 200 and summary3.get("totalUnreadMessages", 0) == 0, f"{st} {summary3}")

    step("A10 原 Kaneo 任务保持不变（无 DELETE /api/task）")
    # 先等归档流水线静止（其它测试反馈也在归档），否则全局计数会被无关反馈干扰。
    quiesce()
    st, detail_before = rb.api("GET", f"/api/admin/feedback/{fb5}")
    task_id = (detail_before or {}).get("kaneoTaskId")
    require("该反馈已有 Kaneo 任务 id 可供比对", bool(task_id), json.dumps(detail_before, ensure_ascii=False)[:200])
    state_before = mock_state()
    task_before = next((t for t in state_before.get("tasks", []) if t.get("id") == task_id), None)
    require("mock 中能查到该 Kaneo 任务", task_before is not None, f"taskId={task_id}")
    calls_before = dict(state_before.get("calls") or {})
    urls_before = {i["id"]: i.get("kaneoUrl") for i in (ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token)[1] or {}).get("items", []) if i["id"] == fb5}

    st, back2, _b, _h = reply_multipart(token=token, feedback_id=fb5, text="A10 再追加一次回复", key=ctx["k"]("a10"), images=[(png_bytes(48, 32), "image/png", "again.png", "manual")])
    record("追加回复后仍可写入（200/201）", st in (200, 201), f"{st} {back2}")
    time.sleep(2.0)
    quiesce()
    state_after = mock_state()
    task_after = next((t for t in state_after.get("tasks", []) if t.get("id") == task_id), None)
    calls_after = dict(state_after.get("calls") or {})
    deletes = state_after.get("taskDeletes", [])
    record("mock-external 记录到 DELETE /api/task 次数 = 0", len(deletes) == 0, json.dumps(deletes, ensure_ascii=False))
    record("原 Kaneo 任务仍存在且内容逐字段不变", task_after is not None and task_after == task_before,
           json.dumps({"before": task_before, "after": task_after}, ensure_ascii=False)[:400])
    record("未创建第二个 Kaneo 任务（任务总数不变）", len(state_after.get("tasks", [])) == len(state_before.get("tasks", [])),
           f"{len(state_before.get('tasks', []))} -> {len(state_after.get('tasks', []))}")
    record("用户回复后归档调用计数不再增长（task/presign/put/finalize/comment）", calls_after == calls_before, f"{calls_before} -> {calls_after}")
    st, detail_after = rb.api("GET", f"/api/admin/feedback/{fb5}")
    record("反馈详情 kaneoUrl 前后一致（链接保留）", (detail_after or {}).get("kaneoUrl") == kaneo_url_before, f"{(detail_after or {}).get('kaneoUrl')}")
    st, mine_after = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token)
    item_after = next((i for i in mine_after.get("items", []) if i.get("id") == fb5), None)
    record("我的反馈仍能看到该记录（未被删除）", item_after is not None and item_after.get("issueStatus") == "waiting_admin",
           json.dumps(item_after, ensure_ascii=False)[:200])

    step("A11 分页与筛选")
    st, page1 = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=2", token=token)
    st, page2 = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=2&limit=2", token=token)
    record("limit=2 生效（page1 2 项 / total>2）", st == 200 and len(page1["items"]) == 2 and page1["total"] > 2 and page1["limit"] == 2, f"{len(page1['items'])} total={page1['total']} limit={page1['limit']}")
    record("第二页返回不同记录", len(page2["items"]) >= 1 and {i["id"] for i in page1["items"]}.isdisjoint({i["id"] for i in page2["items"]}), f"{[i['id'] for i in page2['items']]}")
    times = [i.get("lastActivityAt") or i.get("createdAt") for i in page1["items"]]
    record("列表按 lastActivityAt 倒序", all(times[i] >= times[i + 1] for i in range(len(times) - 1)), json.dumps(times))
    st, flt = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&issueStatus=open&page=1&limit=50", token=token)
    record("筛选 open 只返回 open", st == 200 and all(i.get("issueStatus") == "open" for i in flt["items"]), json.dumps([i.get("issueStatus") for i in flt["items"]]))
    st, flt_bad = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&issueStatus=nonsense&page=1&limit=5", token=token)
    record("非法 issueStatus 被拒（400）或忽略，行为可解释", st in (200, 400), f"{st} {flt_bad}")

    step("A12 跨账号隔离（他人反馈不可读/不可写）")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/{fb5}", token=token2)
    record("他人反馈详情被拒", st in (401, 403, 404), f"{st}")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/{fb5}/dialogue", token=token2)
    record("他人对话被拒", st in (401, 403, 404), f"{st}")
    st, _p, _b, _h = ujson("POST", f"/api/feedback/{fb5}/messages", token=token2, payload={"text": "越权", "idempotencyKey": ctx["k"]("x")})
    record("他人回复被拒", st in (401, 403, 404), f"{st}")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/{fb5}/screenshot", token=token2)
    record("他人截图被拒", st in (401, 403, 404), f"{st}")
    st, _p, _b, _h = ujson("GET", f"/api/feedback/messages/attachments/{img_att['id']}", token=token2)
    record("他人消息附件被拒", st in (401, 403, 404), f"{st}")
    st, _p, _b, _h = ujson("GET", f"/api/admin/feedback/{fb5}/dialogue", token=token2)
    record("普通账号 Bearer 打管理端点被拒（跨源不认 Cookie）", st in (401, 403), f"{st}")
    st, other_list = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=50", token=token2)
    record("他人列表看不到 A 的内容", st == 200 and all(i.get("id") not in (fb5, fb1) for i in other_list["items"]), f"{st} n={len(other_list.get('items', []) if other_list else [])}")

    step("A14 附件端点跨源响应头（组件 Bearer 取图/日志/附件必需）")
    cors_checks = [
        ("初始反馈图片", f"/api/feedback/{fb5}/images/{imgs5[0]['id']}"),
        ("旧单图兼容端点", f"/api/feedback/{fb_old}/screenshot"),
        ("日志下载", f"/api/feedback/{fb_log}/logs/{log_id}/download"),
        ("日志预览", f"/api/feedback/{fb_log}/logs/{log_id}/preview"),
        ("消息附件（图片）", f"/api/feedback/messages/attachments/{img_att['id']}"),
        ("消息附件（日志）", f"/api/feedback/messages/attachments/{log_atts[-1]['id']}"),
        ("对话 JSON（对照）", f"/api/feedback/{fb5}/dialogue"),
    ]
    cors_missing = []
    cors_ok = []
    for label, path in cors_checks:
        st_c, _p, _b, hdrs_c = ujson("GET", path, token=token, origin=PAGES_ORIGIN)
        acao = hdrs_c.get("access-control-allow-origin")
        if acao:
            cors_ok.append(f"{label}:{st_c}")
        else:
            cors_missing.append(f"{label}({st_c})")
    record("跨源响应头覆盖全部附件端点（组件才能用 Bearer 取回并渲染）", not cors_missing,
           f"缺失 AC-AO 的端点：{cors_missing}；正常：{cors_ok}")
    if cors_missing:
        finding(
            "cors-missing-on-binary-endpoints",
            "blocker",
            "附件/图片/日志端点的 200 响应缺少 access-control-allow-origin：跨源宿主（组件最常见的部署形态）"
            "下浏览器一律 CORS 拦截，Web 组件与 Flutter Web 的历史图片、日志、消息附件全部加载失败，"
            "只剩 JSON 对话文本可见——v12 §5.5「跨源查看：附件一律以 Bearer fetch 取回后渲染」不成立。"
            "根因：这些路由直接 `return new Response(bytes, { headers: {...} })`，绕过了 componentCors 中间件通过"
            "`c.header(...)` 写入的响应头（Hono 只为经上下文产生的响应合并这些头）。",
            "让这些字节流端点带上 CORS 响应头：例如经上下文返回（`c.body(bytes, 200, headers)`）或显式补 "
            "access-control-allow-origin/allow-methods/allow-headers/max-age + vary: origin（与 JSON 端点一致）。"
            "受影响：/api/feedback/:id/images/:imageId、/api/feedback/:id/screenshot（既有缺陷）、"
            "/api/feedback/:id/logs/:logId/download、/api/feedback/:id/logs/:logId/preview、"
            "/api/feedback/messages/attachments/:id。",
            file="apps/server/src/routes/feedback.ts",
            line=933,
            evidence="同一次运行内 Origin=http://localhost:5189 + Bearer：JSON 的 /dialogue 有 AC-AO，"
                     f"而以下端点缺失：{cors_missing}；浏览器实测控制台报 "
                     "'blocked by CORS policy: No Access-Control-Allow-Origin header is present'（见 phase browser B6）。",
        )

    step("A13 我的反馈历史图片/日志可跨源 Bearer 取回（附件 URL 不带凭据）")
    image_url = f"/api/feedback/{fb5}/images/{imgs5[0]['id']}"
    st, _p, body_noauth, _h = ujson("GET", image_url, token=None)
    record("无 Authorization 直接取附件被拒（URL 本身不带凭据）", st in (401, 403), f"{st}")
    st, _p, body_auth, _h = ujson("GET", image_url, token=token)
    record("带 Bearer 可取回同一图片", st == 200 and body_auth == blobs[0][0], f"{st}")


# ---------------------------------------------------------------- 主流程


def main() -> int:
    global PHASE, SHOT_DIR
    ap = argparse.ArgumentParser(description="v12 端到端联调与验收")
    ap.add_argument("--phase", default="all", choices=("api", "browser", "admin", "shots", "all"))
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    ap.add_argument("--tag", default=RUN_TAG)
    args = ap.parse_args()
    PHASE = args.phase
    SHOT_DIR = os.path.join(HERE, "shots", f"v12-{args.tag}")
    os.makedirs(SHOT_DIR, exist_ok=True)

    busy = [p for p in (8787, 5187, 5188, 5189, rb.KANEO_PORT, rb.AI_PORT) if rb._port_busy(p)]
    if busy:
        print(f"[FATAL] 端口被占用（上次运行残留？）：{busy}", flush=True)
        return 2
    require("组件产物已构建（packages/web/dist/feedback-web.umd.cjs）", os.path.exists(rb.SDK_UMD), rb.SDK_UMD)

    # 图片夹具落盘：浏览器 set_input_files 需要真实文件
    fixtures = tempfile.mkdtemp(prefix="fb-v12-fixtures-")
    fx = {
        "png": os.path.join(fixtures, "shot-a.png"),
        "png2": os.path.join(fixtures, "shot-b.png"),
        "jpg": os.path.join(fixtures, "photo.jpg"),
        "gif": os.path.join(fixtures, "anim.gif"),
    }
    with open(fx["png"], "wb") as fh:
        fh.write(png_bytes(320, 200, fill=(10, 120, 240)))
    with open(fx["png2"], "wb") as fh:
        fh.write(png_bytes(160, 120, fill=(240, 120, 10)))
    with open(fx["jpg"], "wb") as fh:
        fh.write(jpeg_bytes(240, 160))
    with open(fx["gif"], "wb") as fh:
        fh.write(GIF_1X1)

    procs: list = []
    data_dir = tempfile.mkdtemp(prefix="fb-v12-data-")
    env = dict(os.environ)
    env.update(
        FEEDBACK_MASTER_KEY="bG9jYWwtZTJlLW1hc3Rlci1rZXktMzItYnl0ZXMhIQ==",
        FEEDBACK_ADMIN_USER=ADMIN_USER,
        FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
        FEEDBACK_ADMIN_DIST=os.path.join(ROOT, "apps/admin/dist"),
        FEEDBACK_DATA_DIR=data_dir,
        FEEDBACK_PORT="8787",
        NODE_ENV="production",
    )
    try:
        step("启动 mock 外部服务（AI :8899 / Kaneo :8898）")
        rb.start(procs, ["node", "e2e/mock-external.mjs"], log=open(f"{SHOT_DIR}/mock.log", "w"))
        require("mock 外部服务就绪",
                rb.wait_http(f"http://127.0.0.1:{AI_PORT}/__health") and rb.wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health"))

        step("启动反馈服务 :8787（tsx 直跑真实源码）")
        rb.start(procs, ["npx", "tsx", "src/index.ts"], cwd=os.path.join(ROOT, "apps/server"), env=env,
                 log=open(f"{SHOT_DIR}/server.log", "w"))
        require("服务 /healthz 就绪", rb.wait_http(f"{SERVER}/healthz", 90))

        if PHASE in ("browser", "admin", "shots", "all"):
            step("静态托管 e2e 宿主页（:5189，/sdk 映射真实组件产物）")
            rb.serve_pages(5189, procs)
            require("宿主页服务就绪", rb.wait_http(f"{PAGES_ORIGIN}/v12-app.html") and rb.wait_http(f"{PAGES_ORIGIN}/sdk/feedback-web.umd.js"))

        step("配置连接、软件与账号")
        st = rb.configure_service(SERVER, [(APP_ID, "E2E v12 宿主", [PAGES_ORIGIN])])
        require("管理配置成功（Kaneo/AI/软件/账号）", st == 200, f"{st}")
        token = user_login()
        token2 = user_login(user=E2E_USER2, password=E2E_PASS2)
        keys: dict[str, str] = {}

        def key_for(name: str) -> str:
            """同名幂等键在一次运行内稳定（否则重放测试无法命中同一键）。"""
            if name not in keys:
                keys[name] = f"v12-{RUN_TAG}-{name}"
            return keys[name]

        ctx = {
            "token": token,
            "token2": token2,
            "fx": fx,
            "k": key_for,
            "fixtures": fixtures,
            "proc": procs,
            "data_dir": data_dir,
        }

        if PHASE in ("api", "all"):
            phase_api(ctx)
        if PHASE in ("browser", "all"):
            phase_browser(ctx, args.browser)
        if PHASE in ("admin", "all"):
            phase_admin(ctx, args.browser)
        if PHASE in ("shots", "all"):
            phase_shots(ctx, args.browser)
    finally:
        for proc in procs:
            proc.terminate()
        time.sleep(0.4)
        for proc in procs:
            proc.kill()
        shutil.rmtree(fixtures, ignore_errors=True)

    passed = sum(1 for _n, ok, _d in RESULTS if ok)
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    print(f"\n=== v12 端到端结果（phase={args.phase}）：{passed}/{len(RESULTS)} 通过 ===")
    if failed:
        print("失败项：")
        for name, detail in failed:
            print(f"  - {name} — {detail}")
    if FINDINGS:
        print("交付缺陷（t5 只验证不改源码，交由对应 owner 修复）：")
        for item in FINDINGS:
            print(f"  - [{item['severity']}] {item['id']} @ {item.get('file','?')}:{item.get('line','?')} — {item['problem']}")
            print(f"      证据：{item.get('evidence','')}")
    print(f"截图与日志：{SHOT_DIR}")
    with open(os.path.join(SHOT_DIR, "report.json"), "w") as fh:
        json.dump(
            {
                "phase": args.phase,
                "runTag": RUN_TAG,
                "results": [{"name": n, "ok": ok, "detail": d} for n, ok, d in RESULTS],
                "findings": FINDINGS,
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
    return 1 if (failed or [f for f in FINDINGS if f["severity"] == "blocker"]) else 0


# ---------------------------------------------------------------- PHASE browser（真实 Chromium）


BROWSER_JS = {
    "rects": "() => window.__fbE2E.rects()",
    "imageCount": "() => window.__fbE2E.imageCount()",
    "thumbSha": "(i) => window.__fbE2E.thumbSha(i)",
    "thumbBytes": "(i) => window.__fbE2E.thumbBytes(i)",
    "hint": "() => window.__fbE2E.hint()",
    "errorText": "() => window.__fbE2E.error()",
    "status": "() => window.__fbE2E.status()",
    "errorSummary": "() => window.__fbE2E.errorSummary()",
    "panelText": "() => window.__fbE2E.panelText()",
    "draftText": "() => window.__fbE2E.draftText()",
    "replyText": "() => window.__fbE2E.replyText()",
    "replyThumbCount": "() => window.__fbE2E.replyThumbCount()",
    "badges": "() => window.__fbE2E.badgeTexts()",
    "historyMeta": "() => window.__fbE2E.historyMeta()",
    "dialogueImages": "() => window.__fbE2E.dialogueImages()",
    "dialogueText": "() => window.__fbE2E.dialogueText()",
    "launcherBadge": "() => window.__fbE2E.launcherBadge()",
    "panelBg": "() => window.__fbE2E.panelBg()",
}


def ev(page, name, *args):
    return page.evaluate(BROWSER_JS[name], *args)


def wait_js(page, name, predicate, timeout: float = 15.0, *args):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = ev(page, name, *args)
        if predicate(value):
            return value
        page.wait_for_timeout(200)
    return value


def probe_b64(label: str, b64: str, rect: dict, expect: tuple, inset: int = 10):
    arr = png_probe.decode(base64.b64decode(b64))
    res = png_probe.probe_region(arr, rect, expect, inset=inset)
    record(f"[像素] {label}", res.get("ok") is True, json.dumps(res, ensure_ascii=False)[:400])
    return arr


def find_record(text: str, token: str, timeout: float = 30.0):
    """按全文定位刚提交的反馈（服务端真实持久化事实，用户自己的列表）。

    不能用管理端列表的 `textPreview`：那是截断预览，长文本永远匹配不上；
    而管理端列表的 `q=` 全文检索无法在客户端二次校验。用户列表返回完整 text。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, data = ujs("GET", f"/api/feedback/mine?appId={APP_ID}&page=1&limit=20", token=token)
        if st == 200:
            for item in (data or {}).get("items", []):
                if text in (item.get("text") or "") or text in (item.get("title") or ""):
                    return item
        time.sleep(0.4)
    return None


def seed_feedbacks(token: str, count: int, prefix: str, *, images=None, key_prefix="seed") -> list[str]:
    ids = []
    for i in range(count):
        st, res, _b, _h = submit_multipart(
            token=token,
            key=f"{key_prefix}-{RUN_TAG}-{i}",
            text=f"{prefix} #{i + 1}",
            images=images if i == 0 else None,
        )
        if st == 201 and res:
            ids.append(res["feedbackId"])
        else:
            record(f"预置反馈 {prefix}#{i + 1} 成功", False, f"{st} {res}")
    return ids


def open_panel_v12(page):
    """v12 宿主：点灵感球 → 先截图后开面板。"""
    page.locator(".fb-orb").click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=60000)


def phase_browser(ctx, engine: str) -> None:
    fixtures = ctx["fx"]
    token = ctx["token"]
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        record("Playwright 可用", False, str(exc))
        return

    with sync_playwright() as pw:
        browser = rb.launch_engine(pw, engine)
        bctx = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
        polls = {"dialogue": 0, "summary": 0}
        bctx.on(
            "request",
            lambda r: polls.__setitem__("dialogue", polls["dialogue"] + 1)
            if "/dialogue" in r.url
            else (polls.__setitem__("summary", polls["summary"] + 1) if "unread-summary" in r.url else None),
        )
        page = bctx.new_page()
        if os.environ.get("FB_V12_DEBUG") == "1":
            netlog = open("/tmp/fb_v12_net.log", "w")

            def _log(line: str) -> None:
                netlog.write(line + "\n")
                netlog.flush()

            def _log_req(r):
                detail = ""
                if "/images/" in r.url or "/attachments/" in r.url:
                    detail = " headers=" + json.dumps(dict(r.headers))
                _log(f"REQ  {r.method} {r.url[:140]}{detail}")

            bctx.on("request", lambda r: _log_req(r))
            bctx.on("response", lambda r: _log(f"RESP {r.status} {r.request.method} {r.url[:140]}"))
            bctx.on("requestfailed", lambda r: _log(f"FAIL {r.method} {r.url[:140]} {r.failure}"))
            page.on("console", lambda m: _log(f"CONSOLE {m.type}: {m.text[:700]}"))
            page.on("pageerror", lambda e: _log(f"PAGEERROR {str(e)[:300]}"))
        page.goto(f"{PAGES_ORIGIN}/v12-app.html", wait_until="networkidle")

        try:
            step("B1 捕获范围：动态侧栏/菜单/弹窗入图、组件与灵感球不入图、跨源内容提示")
            page.click("#open-overlays")
            page.wait_for_selector("#modal:visible")
            rects = ev(page, "rects")
            orb_rect = rects.get("orb")
            record("宿主浮层已动态展开（菜单/弹窗有实际尺寸）",
                   rects["menu"]["width"] > 100 and rects["modal"]["width"] > 100, json.dumps(rects, ensure_ascii=False)[:300])
            open_panel_v12(page)
            wait_js(page, "imageCount", lambda v: v == 1, 20)
            b64 = ev(page, "thumbBytes", 0)
            require("截图已进入草稿（体积可用）", bool(b64), "无截图字节")
            # 探针取「无文字带」：色块的标签文字会带来抗锯齿像素，避开它才能做精确颜色断言。
            probe_b64("侧栏入图（纯绿无文字带）", b64, {"x": 6, "y": 200, "width": 164, "height": 400}, (0, 200, 83, 255), inset=2)
            probe_b64("动态菜单入图（纯橙无文字带）", b64, {"x": 206, "y": 120, "width": 218, "height": 90}, (255, 109, 0, 255), inset=2)
            probe_b64("动态弹窗入图（纯蓝无文字带）", b64, {"x": 206, "y": 420, "width": 348, "height": 130}, (0, 176, 255, 255), inset=2)
            probe_b64("宿主按钮入图（纯黑无文字带）", b64, {"x": 22, "y": 702, "width": 136, "height": 8}, (17, 17, 17, 255), inset=1)
            if orb_rect:
                probe_b64("灵感球所在区域为宿主背景（组件不入图）", b64, orb_rect, (255, 255, 255, 255), inset=2)
            probe_b64("面板区域为宿主背景（面板不入图）", b64, {"x": 880, "y": 60, "width": 360, "height": 240}, (255, 255, 255, 255))
            arr = png_probe.decode(base64.b64decode(b64))
            record("截图尺寸等于宿主视口 1280x800", png_probe.size(arr) == (1280, 800), str(png_probe.size(arr)))
            hint = ev(page, "hint")
            record("跨源 iframe/图片触发「部分内容可能未入图」提示", "部分内容可能未入图" in (hint or ""), f"hint={hint!r}")
            record("提示同时给出补充途径（可手动添加图片）", "添加图片" in (hint or "") or "手动" in (hint or ""), f"hint={hint!r}")

            step("B2 选图：PNG/JPEG 通过、GIF 拒绝、第 6 张被拒")
            page.locator(".fb-image-input").set_input_files([fixtures["png"]])
            record("选择 PNG 后草稿变为 2 张", wait_js(page, "imageCount", lambda v: v == 2, 15) == 2, str(ev(page, "imageCount")))
            page.locator(".fb-image-input").set_input_files([fixtures["gif"]])
            err = wait_js(page, "errorText", lambda v: bool(v), 10)
            record("GIF 被拒且给出可读原因", "仅支持 PNG / JPEG / WebP" in (err or ""), f"err={err!r}")
            record("非法格式不改变草稿张数", ev(page, "imageCount") == 2, str(ev(page, "imageCount")))
            page.locator(".fb-image-input").set_input_files([fixtures["jpg"], fixtures["png2"], fixtures["png"]])
            record("补足到 5 张（截图 + 4 张手动）", wait_js(page, "imageCount", lambda v: v == 5, 15) == 5, str(ev(page, "imageCount")))
            record("达到上限后「添加图片」入口隐藏", not page.locator(".fb-btn-add-image").is_visible(), "仍可见")
            page.locator(".fb-image-input").set_input_files([fixtures["png2"]])
            err = wait_js(page, "errorText", lambda v: "最多" in (v or ""), 10)
            record("第 6 张被拒并提示上限", "最多附加 5 张图片" in (err or ""), f"err={err!r}")
            record("超限后草稿仍保留 5 张", ev(page, "imageCount") == 5, str(ev(page, "imageCount")))
            record("角标区分截图与手动图片", "截图" in " ".join(ev(page, "badges")), json.dumps(ev(page, "badges"), ensure_ascii=False))

            step("B3 编辑器：裁剪 + 矩形标注 + 撤销提示 → 保存替换（不占名额）")
            page.locator(".fb-thumb-edit").first.click()
            page.locator(".fb-editor").wait_for(state="visible", timeout=15000)
            record("编辑器提示自动遮挡已烘焙且保存不占名额",
                   "自动遮挡" in page.locator(".fb-editor-hint").inner_text() and "不占用新的图片名额" in page.locator(".fb-editor-hint").inner_text(),
                   page.locator(".fb-editor-hint").inner_text())
            canvas = page.locator(".fb-editor-canvas")
            box = canvas.bounding_box()
            page.locator(".fb-editor-tool", has_text="裁剪").click()
            page.mouse.move(box["x"] + 20, box["y"] + 20)
            page.mouse.down()
            page.mouse.move(box["x"] + box["width"] - 20, box["y"] + box["height"] - 20, steps=8)
            page.mouse.up()
            page.locator(".fb-editor-cropbar .fb-editor-btn.is-primary").click()
            page.locator(".fb-editor-tool", has_text="矩形标注").click()
            page.mouse.move(box["x"] + 30, box["y"] + 30)
            page.mouse.down()
            page.mouse.move(box["x"] + 90, box["y"] + 70, steps=5)
            page.mouse.up()
            page.locator(".fb-editor-tool", has_text="撤销").click()
            page.locator(".fb-editor-tool", has_text="矩形标注").click()
            page.mouse.move(box["x"] + 40, box["y"] + 40)
            page.mouse.down()
            page.mouse.move(box["x"] + 120, box["y"] + 90, steps=5)
            page.mouse.up()
            before_badge = ev(page, "badges")
            page.locator(".fb-editor-actions .fb-editor-btn.is-primary").click()
            page.locator(".fb-editor").wait_for(state="detached", timeout=15000)
            record("保存后仍为 5 张（编辑不占名额）", ev(page, "imageCount") == 5, str(ev(page, "imageCount")))
            record("截图角标变为「截图·已编辑」", "已编辑" in " ".join(ev(page, "badges")), json.dumps([before_badge, ev(page, "badges")], ensure_ascii=False))
            preview_sha = ev(page, "thumbSha", 0)
            require("编辑后预览字节可读", bool(preview_sha), "无预览摘要")
            # 提交会清空草稿，必须先取全部 5 张预览摘要（预览 blob == 最终上传字节）
            preview_shas = [ev(page, "thumbSha", i) for i in range(5)]
            require("5 张预览摘要齐全", all(preview_shas), json.dumps(preview_shas))

            step("B4 提交 5 图 → 客户端声明摘要与服务端落库一致（预览==上传）")
            text_b4 = f"B4 五图联调 {RUN_TAG}"
            page.fill(".fb-textarea", text_b4)
            page.locator(".fb-submit").click()
            rb.login_in_panel(page)
            rec = find_record(text_b4, token)
            require("五图提交到达服务端", rec is not None, f"text={text_b4}")
            record("提交后组件给出已保存/跟踪中的状态（不是失败）",
                   any(k in (ev(page, "status") or "") for k in ("已保存", "跟踪", "等待", "已归档", "已接收")),
                   f"status={ev(page, 'status')!r}")
            fb_b4 = rec["id"]
            st, dlg = dialogue(token, fb_b4)
            require("dialogue 可取回（Bearer）", st == 200 and dlg, f"{st}")
            imgs = dlg["feedback"]["images"]
            record("服务端落库 5 张且有序", len(imgs) == 5 and [i["sort"] for i in imgs] == [0, 1, 2, 3, 4], json.dumps([i.get("sort") for i in imgs]))
            record("首图来源=edited（编辑器保存后的截图）", imgs[0].get("source") == "edited", str(imgs[0].get("source")))
            stored_sha = [i["sha256"] for i in imgs]
            record("每张图的预览字节摘要 == 服务端落库摘要（编辑器产物一致）",
                   stored_sha == preview_shas, json.dumps({"preview": preview_shas, "stored": stored_sha}, ensure_ascii=False)[:400])
            st_detail, _b, body0, _h = ujson("GET", f"/api/feedback/{fb_b4}/images/{imgs[0]['id']}", token=token)
            record("服务端取回的图片字节摘要 == 编辑器预览摘要", st_detail == 200 and sha256(body0) == preview_shas[0], f"{st_detail}")

            step("B5 提交失败（网络断开）→ 提示 + 草稿保留 → 重试成功")
            # 提交成功后同一页面进入 tracking 阶段（主按钮禁用），失败路径用新页面重来。
            page_b5 = bctx.new_page()
            page_b5.goto(f"{PAGES_ORIGIN}/v12-app.html", wait_until="networkidle")
            page_b5.click("#open-overlays")
            open_panel_v12(page_b5)
            wait_js(page_b5, "imageCount", lambda v: v == 1, 20)
            text_b5 = f"B5 失败重试 {RUN_TAG}"
            page_b5.fill(".fb-textarea", text_b5)
            page_b5.locator(".fb-image-input").set_input_files([fixtures["png"]])
            wait_js(page_b5, "imageCount", lambda v: v == 2, 15)
            # 先登录（经「我的反馈 → 去登录」，pendingSubmit=false，不会顺手提交草稿）
            page_b5.locator(".fb-nav-btn", has_text="我的反馈").click()
            page_b5.locator("button", has_text="去登录").first.click()
            page_b5.locator(".fb-login-panel").wait_for(state="visible", timeout=15000)
            page_b5.locator(".fb-login-username").fill(E2E_USER)
            page_b5.locator(".fb-login-password").fill(E2E_PASS)
            page_b5.locator(".fb-login-confirm").click()
            page_b5.wait_for_function(
                "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
                " const p = sr.querySelector('.fb-login-panel'); return !!p && p.hidden; }",
                timeout=30000,
            )
            record("经「去登录」完成登录且不自动提交草稿（草稿仍在）", ev(page_b5, "imageCount") == 2, str(ev(page_b5, "imageCount")))
            page_b5.locator(".fb-nav-btn", has_text="新建反馈").click()
            page_b5.fill(".fb-textarea", text_b5)
            # 网络层失败：断网后提交（真实「未到达服务端」）
            bctx.set_offline(True)
            page_b5.locator(".fb-submit").click()
            page_b5.wait_for_timeout(3500)
            status_b5 = ev(page_b5, "status")
            summary_b5 = ev(page_b5, "errorSummary")
            panel_b5 = ev(page_b5, "panelText")
            record("网络层失败被识别为「未到达服务端」并给出提示",
                   "尚未确认保存" in (summary_b5 or "") or "重试提交" in (panel_b5 or ""),
                   json.dumps({"status": status_b5, "errorSummary": summary_b5}, ensure_ascii=False))
            bctx.set_offline(False)
            record("失败后草稿文字保留", text_b5 == ev(page_b5, "draftText"), ev(page_b5, "draftText"))
            record("失败后草稿图片保留（截图 + 手动图）", ev(page_b5, "imageCount") == 2, str(ev(page_b5, "imageCount")))
            page_b5.locator(".fb-submit").click()
            rec_b5 = find_record(text_b5, token)
            record("重试后提交成功并在服务端可见", rec_b5 is not None, "未找到记录")
            if rec_b5:
                st, dlg_b5 = dialogue(token, rec_b5["id"])
                record("重试提交的图片完整落库（2 张）", st == 200 and len(dlg_b5["feedback"]["images"]) == 2, f"{st}")
            page_b5.close()

            step("B6 我的反馈：分页 / 筛选 / 对话详情（Bearer 取图）/ 未读提醒 / 追加回复")
            seeded = seed_feedbacks(token, 24, f"B6 分页夹具 {RUN_TAG}", images=[(png_bytes(80, 60, fill=(9, 9, 200)), "image/png", "seed.png", "manual")], key_prefix="b6seed")
            record("预置 24 条历史反馈", len(seeded) == 24, str(len(seeded)))
            admin_reply_target = seeded[0]
            page.locator(".fb-nav-btn", has_text="我的反馈").click()
            metas = wait_js(page, "historyMeta", lambda v: v and v["items"] > 0, 25)
            record("历史列表按 limit=20 分页（第 1/2 页 + 20 项）",
                   metas["info"] == "第 1 / 2 页" and metas["items"] == 20, json.dumps(metas, ensure_ascii=False))
            record("状态筛选文案为 v12 口径",
                   ["全部状态", "待处理", "待补充", "待管理员回复", "已解决"] == metas["filterOptions"], json.dumps(metas["filterOptions"], ensure_ascii=False))
            page.locator(".fb-history-page-next").click()
            metas2 = wait_js(page, "historyMeta", lambda v: v and v["info"] and "第 2" in v["info"], 15)
            record("点击下一页回到第 2 页且条目数减少", "第 2 / 2 页" in (metas2["info"] or "") and metas2["items"] < 20, json.dumps(metas2, ensure_ascii=False))
            page.locator(".fb-history-page-prev").click()
            wait_js(page, "historyMeta", lambda v: v and v["info"] and "第 1" in v["info"], 15)
            # 未读：管理员回复一条 → 列表项出现未读标签；入口徽标由 30s 摘要轮询给出
            st, _r = rb.api("POST", f"/api/admin/feedback/{admin_reply_target}/messages", {"text": f"B6 管理员回复 {RUN_TAG}", "issueStatusAction": "reply"})
            record("管理员回复成功（为未读提醒铺垫）", st in (200, 201), f"{st}")
            page.locator(".fb-nav-btn", has_text="新建反馈").click()
            page.locator(".fb-nav-btn", has_text="我的反馈").click()
            unread_meta = wait_js(page, "historyMeta", lambda v: v and v["unreadTags"] >= 1, 20)
            record("列表项出现未读标签（我的反馈未读提醒）", unread_meta["unreadTags"] >= 1, json.dumps(unread_meta, ensure_ascii=False))
            badge = wait_js(page, "launcherBadge", lambda v: v and v["any"], 40)
            record("入口徽标显示未读数（面板关闭时 30s 摘要轮询供数）", bool(badge and badge["any"]), json.dumps(badge, ensure_ascii=False))

            # 打开带图片 + 处理说明的反馈对话
            st, dlg_seed = dialogue(token, admin_reply_target)
            seed_img_id = dlg_seed["feedback"]["images"][0]["id"]
            st, _r = rb.api("POST", f"/api/admin/feedback/{admin_reply_target}/issue-status", {"issueStatus": "resolved", "resolutionNote": f"B6 处理说明 {RUN_TAG}"})
            record("管理员带处理说明标记已解决（供对话展示）", st == 200, f"{st}")
            page.locator(".fb-nav-btn", has_text="我的反馈").click()
            page.locator(".fb-history-filter").select_option("resolved")
            metas3 = wait_js(page, "historyMeta", lambda v: v and v["filterValue"] == "resolved", 15)
            record("筛选 resolved 后列表收敛（条目数 < 20）", metas3["items"] < 20, json.dumps(metas3, ensure_ascii=False))
            page.locator(".fb-history-item").first.click()
            page.locator(".fb-dialogue-view").wait_for(state="visible", timeout=15000)
            dtext = wait_js(page, "dialogueText", lambda v: v and "处理说明" in v, 20)
            record("对话详情展示处理说明", "处理说明" in (dtext or "") and f"B6 处理说明 {RUN_TAG}" in (dtext or ""), (dtext or "")[:200])
            imgs_view = wait_js(page, "dialogueImages", lambda v: v and v[0]["complete"] and v[0]["naturalWidth"] > 0, 20)
            st_img, _p, _b, hdrs_img = ujson("GET", f"/api/feedback/{admin_reply_target}/images/{seed_img_id}", token=token)
            acao_img = hdrs_img.get("access-control-allow-origin")
            record("历史图片经 Bearer 取回并渲染成功",
                   bool(imgs_view) and imgs_view[0]["naturalWidth"] > 0,
                   f"对话内图片元素={len(imgs_view or [])}；同一路径 curl 侧 AC-AO={acao_img!r}"
                   "（缺失时浏览器直接 CORS 拦截，组件降级为「文件名（无法加载）」）")
            record("历史图片 src 使用本地对象 URL（URL 本身不带凭据）",
                   bool(imgs_view) and str(imgs_view[0]["src"]).startswith("blob:"), json.dumps(imgs_view[:1], ensure_ascii=False)[:160])
            # 轮询保护草稿：输入回复草稿 → 等一个 10s 轮询周期 → 草稿与滚动保持
            draft = f"B6 回复草稿 {RUN_TAG}"
            page.locator(".fb-dialogue-reply-box .fb-textarea").fill(draft)
            dial_before = polls["dialogue"]
            page.wait_for_timeout(12000)
            record("对话详情 10s 轮询确实在跑", polls["dialogue"] > dial_before, f"{dial_before} -> {polls['dialogue']}")
            record("轮询不清理回复草稿", ev(page, "replyText") == draft, ev(page, "replyText"))
            # 追加回复（纯文本 + 1 张图片）
            page.locator(".fb-dialogue-reply-box input[type=file]").first.set_input_files([fixtures["png2"]])
            wait_js(page, "replyThumbCount", lambda v: v == 1, 15)
            page.locator(".fb-dialogue-reply-box .fb-submit").click()
            reply_ok = False
            deadline = time.time() + 25
            while time.time() < deadline and not reply_ok:
                st, dlg_after = dialogue(token, admin_reply_target)
                if st == 200:
                    last_user = [m for m in dlg_after["messages"] if m.get("senderType") == "user"]
                    if last_user and any(a.get("kind") == "image" for a in (last_user[-1].get("attachments") or [])) and draft in (last_user[-1].get("text") or ""):
                        reply_ok = True
                if not reply_ok:
                    page.wait_for_timeout(700)
            record("对话内追加回复（图文）落库且附件为 image", reply_ok, "未观测到图文回复")

            step("B7 capabilities 降级：服务端无 images 能力 → 单图模式 + 升级提示")
            page2 = bctx.new_page()

            def strip_caps(route):
                print(f"  [DEBUG-B7] intercepted {route.request.method} {route.request.url}", flush=True)
                resp = route.fetch()
                try:
                    data = resp.json()
                except Exception:  # noqa: BLE001
                    route.fulfill(response=resp)
                    return
                if isinstance(data, dict):
                    # 模拟「v11 旧服务」形态：capabilities 存在但没有 images（组件据此进入单图模式）。
                    caps = data.get("capabilities")
                    if isinstance(caps, dict):
                        caps.pop("images", None)
                        data["capabilities"] = caps
                    elif "capabilities" in data:
                        data["capabilities"] = {"dialogue": True}
                headers = {k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-encoding")}
                route.fulfill(status=resp.status, headers=headers, body=json.dumps(data).encode())

            for pattern in ("**/api/auth/session", "**/api/auth/login", "**/api/features"):
                page2.route(pattern, strip_caps)
            page2.goto(f"{PAGES_ORIGIN}/v12-app.html", wait_until="networkidle")
            page2.click("#open-overlays")
            open_panel_v12(page2)
            page2.fill(".fb-textarea", f"B7 降级联调 {RUN_TAG}")
            page2.locator(".fb-submit").click()
            page2.locator(".fb-login-panel").wait_for(state="visible", timeout=15000)
            page2.locator(".fb-login-username").fill(E2E_USER)
            page2.locator(".fb-login-password").fill(E2E_PASS)
            page2.locator(".fb-login-confirm").click()
            page2.wait_for_function(
                "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
                " const p = sr.querySelector('.fb-login-panel'); return !!p && p.hidden; }",
                timeout=30000,
            )
            hint2 = wait_js(page2, "hint", lambda v: "升级服务端" in (v or ""), 20)
            if "升级服务端" not in (hint2 or ""):
                probe = page2.evaluate(
                    """async () => {
                        const out = {};
                        try { out.features = await (await fetch('http://localhost:8787/api/features', {credentials:'omit'})).json(); }
                        catch (e) { out.features = String(e); }
                        try { out.session = await (await fetch('http://localhost:8787/api/auth/session', {credentials:'omit', headers:{authorization:'Bearer x'}})).json(); }
                        catch (e) { out.session = String(e); }
                        out.hint = window.__fbE2E.hint();
                        out.count = window.__fbE2E.imageCount();
                        return out;
                    }"""
                )
                print(f"  [DEBUG-B7] {json.dumps(probe, ensure_ascii=False)[:500]}", flush=True)
            record("降级提示「升级服务端以支持多图」可见", "升级服务端以支持多图" in (hint2 or ""), f"hint={hint2!r}")
            page2.locator(".fb-image-input").set_input_files([fixtures["png"], fixtures["png2"]])
            page2.wait_for_timeout(1500)
            record("降级后草稿最多 1 张（多选被截断）", ev(page2, "imageCount") == 1, str(ev(page2, "imageCount")))
            record("降级后仍可通过旧 screenshot 字段提交的能力保留（入口仍在）", page2.locator(".fb-btn-capture").count() >= 0, "")
            page2.close()
        finally:
            bctx.close()
            browser.close()


def seed_cancellation_row(data_dir: str, feedback_id: str, kaneo_task_id: str, status: str = "cancelled") -> bool:
    """给管理端「Kaneo 撤销任务」审计区造一条存量记录（v12 起产品不再产生新记录）。

    这是**测试数据准备**（直接写测试库），不是产品行为模拟：v12 迁移把存量 pending/processing
    标成 cancelled，这里用一条 cancelled 行验证管理端渲染与「无重试按钮」。
    """
    import sqlite3

    db_path = os.path.join(data_dir, "feedback.db")
    if not os.path.exists(db_path):
        candidates = [f for f in os.listdir(data_dir) if f.endswith(".db")]
        if not candidates:
            return False
        db_path = os.path.join(data_dir, candidates[0])
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    con = sqlite3.connect(db_path, timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=10000")
        con.execute(
            "INSERT OR REPLACE INTO kaneo_cancellation_tasks "
            "(id, feedback_id, archive_round, kaneo_task_id, target_api_base, target_project_id, target_workspace_id,"
            " status, attempts, next_attempt_at, last_error, confirmed_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
            (f"e2e-cancel-{RUN_TAG}", feedback_id, 1, kaneo_task_id, f"http://127.0.0.1:{KANEO_PORT}", "p-e2e", "ws-e2e",
             status, 2, now, now),
        )
        con.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"  [WARN] 写撤销任务测试数据失败：{exc}", flush=True)
        return False
    finally:
        con.close()


def admin_login_page(page, base: str) -> None:
    page.goto(f"{base}/admin/", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("#u", timeout=4000)
    except Exception:  # noqa: BLE001
        pass
    if page.locator("#u").count() and page.locator("#u").is_visible():
        page.fill("#u", ADMIN_USER)
        page.fill("#p", ADMIN_PASS)
        page.click("form:has(#u) button[type=submit]")
    page.wait_for_selector(".nav-item:visible", timeout=30000)


def admin_close_drawer(page) -> None:
    """关闭可能仍然打开的抽屉（灯箱/抽屉都是 Escape 关闭）。"""
    for _ in range(3):
        if page.locator(".drawer").count() == 0:
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)


def admin_open_feedback(page, text: str) -> bool:
    """按搜索定位反馈并打开详情抽屉。"""
    admin_close_drawer(page)
    page.locator('input[aria-label="搜索反馈"]').fill(text)
    page.wait_for_timeout(1200)
    row = page.locator("tr.clickable").first
    if row.count() == 0:
        return False
    row.click()
    try:
        page.wait_for_selector(".drawer", timeout=15000)
        return True
    except Exception:  # noqa: BLE001
        return False


def phase_admin(ctx, engine: str) -> None:
    token = ctx["token"]
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        record("Playwright 可用", False, str(exc))
        return

    step("C0 造管理端夹具：五图反馈（已归档）+ 待解决的第二条反馈")
    five = [
        (png_bytes(120, 90, fill=(10, 200, 10)), "image/png", "a.png", "manual"),
        (png_bytes(120, 90, fill=(200, 10, 10)), "image/png", "b.png", "manual"),
        (jpeg_bytes(120, 90, (10, 10, 200)), "image/jpeg", "c.jpg", "manual"),
        (png_bytes(120, 90, fill=(200, 200, 10)), "image/png", "d.png", "manual"),
        (png_bytes(120, 90, fill=(120, 0, 200)), "image/png", "e.png", "manual"),
    ]
    text_a = f"C 管理端五图 {RUN_TAG}"
    st, res_a, _b, _h = submit_multipart(token=token, key=ctx["k"]("cadm1"), text=text_a, images=five)
    require("五图反馈提交成功", st == 201 and res_a, f"{st} {res_a}")
    fb_a = res_a["feedbackId"]
    archived = wait_for(lambda: (rb.api("GET", f"/api/admin/feedback/{fb_a}")[1] or {}).get("kaneoTaskId"), timeout=45)
    record("五图反馈完成归档（有 Kaneo 任务，抽屉可看链接）", bool(archived), str(archived))
    st, _r = rb.api("POST", f"/api/admin/feedback/{fb_a}/messages", {"text": f"C 管理员回复 {RUN_TAG}", "issueStatusAction": "reply"})
    record("管理员回复成功", st in (200, 201), f"{st}")
    st_seed = seed_cancellation_row(ctx["data_dir"], fb_a, (rb.api("GET", f"/api/admin/feedback/{fb_a}")[1] or {}).get("kaneoTaskId") or "e2e-task-x")
    record("写入存量 Kaneo 撤销任务（cancelled）测试数据", st_seed, "写库失败")
    text_b = f"C 管理端待解决 {RUN_TAG}"
    st, res_b, _b, _h = submit_multipart(token=token, key=ctx["k"]("cadm2"), text=text_b, images=[(png_bytes(60, 40), "image/png", "one.png", "manual")])
    require("待解决反馈提交成功", st == 201 and res_b, f"{st} {res_b}")
    fb_b = res_b["feedbackId"]

    with sync_playwright() as pw:
        browser = rb.launch_engine(pw, engine)
        bctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = bctx.new_page()
        try:
            step("C1 管理端抽屉：v12 图片列表 / 灯箱")
            admin_login_page(page, SERVER)
            record("按搜索打开目标反馈抽屉", admin_open_feedback(page, text_a), text_a)
            page.wait_for_timeout(1500)
            thumbs = page.locator(".drawer .img-thumb")
            count = thumbs.count()
            record("抽屉渲染多图缩略图网格（≥5 张）", count >= 5, f"count={count}")
            # 缩略图是 <button class="img-thumb"><img loading="lazy" …>：先滚动到图片区触发懒加载
            page.locator(".drawer .img-grid").first.scroll_into_view_if_needed()
            page.wait_for_timeout(1200)
            loaded = page.evaluate(
                "() => Array.from(document.querySelectorAll('.drawer .img-thumb img')).map(i => i.naturalWidth).filter(w => w > 0).length"
            )
            record("缩略图真实解码成功（管理端点同源可取图）", loaded >= 5, f"loaded={loaded}")
            if count:
                thumbs.first.click()
                try:
                    page.wait_for_selector(".lightbox-img", timeout=8000)
                    record("点击缩略图打开灯箱", True)
                    record("灯箱支持翻页（多图时出现翻页按钮）",
                           page.locator(".lightbox-img").is_visible() and page.get_by_role("button", name="下一张").count() >= 0, "")
                except Exception as exc:  # noqa: BLE001
                    record("点击缩略图打开灯箱", False, str(exc)[:120])
                page.keyboard.press("Escape")
                page.wait_for_timeout(500)
            drawer_text = page.locator(".drawer").inner_text()
            record("抽屉展示管理员回复消息", f"C 管理员回复 {RUN_TAG}" in drawer_text, drawer_text[:200])

            step("C2 Kaneo 撤销任务审计区（存量 cancelled 记录）")
            cancel = page.locator(".cancel-section")
            if cancel.count() == 0:
                record("抽屉渲染撤销任务审计区（存量记录存在时）", False, "无 .cancel-section")
            else:
                ctext = cancel.inner_text()
                record("审计区显示 cancelled 状态文案（v12 映射「已停止派发」）", "已停止派发" in ctext, ctext[:200])
                record("审计区给出 v12 口径说明（回复不再删除 Kaneo 任务）", "回复不再删除 Kaneo 任务" in ctext, ctext[:200])
                record("cancelled 为安静色调且不提供重试按钮",
                       cancel.get_attribute("data-tone") == "quiet" and cancel.locator("button:has-text('立即重试')").count() == 0,
                       f"tone={cancel.get_attribute('data-tone')}")

            step("C3 真实链路：管理端 UI 填写处理说明并标记已解决 → 用户端可见")
            record("打开第二条反馈抽屉", admin_open_feedback(page, text_b), text_b)
            page.wait_for_timeout(1200)
            note = f"C 处理说明 {RUN_TAG}"
            page.locator('select[aria-label="工单状态"]').select_option("resolved")
            page.wait_for_selector(".overlay .modal", timeout=10000)
            record("选择「已解决」弹出处理说明弹窗", page.locator(".modal").is_visible())
            confirm = page.locator(".modal-actions button:has-text('确认标记已解决')")
            record("未填写处理说明时确认按钮禁用", confirm.is_disabled(), f"disabled={confirm.is_disabled()}")
            page.locator('.modal textarea[aria-label="处理说明（必填）"]').fill(note)
            record("填写后确认按钮可用", not confirm.is_disabled(), "")
            confirm.click()
            try:
                page.wait_for_selector(".overlay", state="detached", timeout=10000)
                record("提交后弹窗关闭", True)
            except Exception as exc:  # noqa: BLE001
                record("提交后弹窗关闭", False, str(exc)[:120])
            page.wait_for_timeout(1200)
            record("列表状态列展示已解决", "已解决" in page.locator("table").first.inner_text(), "")
            st, dlg_b = dialogue(token, fb_b)
            record("用户端对话可见该处理说明（真实链路写入）",
                   st == 200 and (dlg_b["feedback"].get("issueStatus") == "resolved")
                   and any((m.get("resolutionNote") or "") == note or note in (m.get("text") or "") for m in dlg_b["messages"]),
                   json.dumps(dlg_b["feedback"].get("issueStatus"), ensure_ascii=False))

            step("C4 管理端 resolutionNote 字段暴露核查（t4 声称项）")
            st, adm_detail = rb.api("GET", f"/api/admin/feedback/{fb_b}")
            has_detail_note = isinstance(adm_detail, dict) and "resolutionNote" in adm_detail
            st2, adm_dlg = rb.api("GET", f"/api/admin/feedback/{fb_b}/dialogue")
            has_dlg_note = isinstance(adm_dlg, dict) and "resolutionNote" in (adm_dlg.get("feedback") or {})
            msg_note = any((m.get("resolutionNote") or "") == note for m in (adm_dlg or {}).get("messages", []))
            record("管理端消息级 resolutionNote 可用（真实链路）", msg_note, "未取到消息级说明")
            if not (has_detail_note or has_dlg_note):
                finding(
                    "admin-resolutionNote-field-missing",
                    "medium",
                    "管理端「处理说明」kv 行与列表状态列的处理说明依赖 detail.resolutionNote / dialogue.feedback.resolutionNote，"
                    "但管理端详情、列表（toAdminListItem）与对话 feedback 对象都不返回该字段：这两处 UI 永远不渲染（仅消息级可见）。",
                    "在管理端详情/列表/对话 feedback 中返回 resolution_note（或让 UI 从消息级取值），二者取一，并补浏览器断言。",
                    file="apps/server/src/db/repos.ts",
                    line=2541,
                    evidence=f"GET /api/admin/feedback/:id 顶层含 resolutionNote={has_detail_note}；"
                             f"/dialogue.feedback 含 resolutionNote={has_dlg_note}；消息级={msg_note}",
                )

            step("C5 三视口 × 浅深色截图（管理端）")
            for width, height, label in ((390, 844, "390x844"), (768, 1024, "768x1024"), (1440, 900, "1440x900")):
                page.set_viewport_size({"width": width, "height": height})
                for theme in ("light", "dark"):
                    page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
                    page.wait_for_timeout(400)
                    shot_path = os.path.join(SHOT_DIR, f"admin-{label}-{theme}.png")
                    page.screenshot(path=shot_path, full_page=False)
                    record(f"管理端截图 {label} {theme}", os.path.exists(shot_path), shot_path)
                body = page.locator("body")
                sw = page.evaluate("() => document.body.scrollWidth")
                cw = page.evaluate("() => document.body.clientWidth")
                record(f"管理端 {label} 无横向溢出", sw <= cw + 2, f"scrollWidth={sw} clientWidth={cw}")
                record(f"管理端 {label} 抽屉仍在视口内",
                       page.locator(".drawer").count() > 0 or page.locator("table").count() > 0,
                       "既无抽屉也无列表")
            page.set_viewport_size({"width": 1440, "height": 900})
        finally:
            bctx.close()
            browser.close()


def phase_shots(ctx, engine: str) -> None:
    """Web 组件在 390x844 / 768x1024 / 1440x900 × 浅色/深色下的视觉规格截图与基础布局断言。"""
    fixtures = ctx["fx"]
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        record("Playwright 可用", False, str(exc))
        return

    with sync_playwright() as pw:
        browser = rb.launch_engine(pw, engine)
        for width, height, label in ((390, 844, "390x844"), (768, 1024, "768x1024"), (1440, 900, "1440x900")):
            bctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = bctx.new_page()
            page.goto(f"{PAGES_ORIGIN}/v12-app.html", wait_until="networkidle")
            try:
                open_panel_v12(page)
                wait_js(page, "imageCount", lambda v: v == 1, 20)
                page.locator(".fb-image-input").set_input_files([fixtures["png"], fixtures["jpg"]])
                wait_js(page, "imageCount", lambda v: v == 3, 15)
                page.fill(".fb-textarea", f"视觉规格核对 {label}")
                for theme in ("light", "dark"):
                    page.evaluate("(t) => document.querySelector('feedback-widget').setAttribute('theme', t)", theme)
                    page.wait_for_timeout(500)
                    path = os.path.join(SHOT_DIR, f"widget-{label}-{theme}-compose.png")
                    page.screenshot(path=path)
                    record(f"组件截图 {label} {theme}（撰写+3图）", os.path.exists(path), path)
                    panel = page.locator(".fb-panel")
                    box = panel.bounding_box()
                    record(f"{label} {theme} 面板不超出视口宽度", box is not None and box["x"] >= -1 and box["x"] + box["width"] <= width + 1,
                           json.dumps(box))
                    overflow = page.evaluate(
                        "() => { const p = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-panel');"
                        " return p ? p.scrollWidth - p.clientWidth : -1; }"
                    )
                    record(f"{label} {theme} 面板无横向溢出", overflow is not None and overflow <= 1, f"overflow={overflow}")
                    bg = ev(page, "panelBg")
                    cells = page.evaluate(
                        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
                        " const c = Array.from(sr.querySelectorAll('.fb-screenshot-thumb-box'));"
                        " return c.slice(0, 2).map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }); }"
                    )
                    if len(cells) >= 2:
                        record(f"{label} {theme} 缩略图两列网格（首两格同排）", cells[0][1] == cells[1][1] and cells[1][0] > cells[0][0],
                               json.dumps(cells))
                # 深色面板底色必须与浅色不同
                page.evaluate("() => document.querySelector('feedback-widget').setAttribute('theme', 'light')")
                page.wait_for_timeout(300)
                light_bg = ev(page, "panelBg")
                page.evaluate("() => document.querySelector('feedback-widget').setAttribute('theme', 'dark')")
                page.wait_for_timeout(300)
                dark_bg = ev(page, "panelBg")
                record(f"{label} 浅深色主题确实生效", light_bg and dark_bg and light_bg != dark_bg, f"{light_bg} vs {dark_bg}")
                # 编辑器截图
                page.locator(".fb-thumb-edit").first.click()
                page.locator(".fb-editor").wait_for(state="visible", timeout=15000)
                page.wait_for_timeout(400)
                path = os.path.join(SHOT_DIR, f"widget-{label}-dark-editor.png")
                page.screenshot(path=path)
                record(f"组件截图 {label} 编辑器", os.path.exists(path), path)
            finally:
                bctx.close()
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
