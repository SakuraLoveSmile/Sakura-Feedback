#!/usr/bin/env python3
"""
Feedback v12 端到端联调（真实浏览器 Chromium + 真实服务端 + mock 外部服务）。

编排方式与 e2e/run_browser.py 一致（独立脚本，不改写既有脚本）：

V12-1  捕获范围：动态出现的侧栏/菜单/弹窗入图（像素断言），组件 UI 不入图；
       跨源 iframe / 无 crossorigin 跨源图片触发「部分内容可能未入图」提示。
V12-2  多图附件：截图 + 手动添加并存，≤5 张，第 6 张被拒；缩略图网格。
V12-3  编辑器：矩形标注 → 保存替换；预览 sha 与服务端落库 sha 一致（预览==上传像素）。
V12-4  提交→自动归档→用户回复：Kaneo 任务保持不变（mock taskDeletes 恒为空）、
       issueStatus→waiting_admin、取消派发无新撤销任务。
V12-5  处理说明：缺 resolutionNote 的 resolved 被拒（400）；带说明解决后用户端可见；
       unread-summary 返回未读。
V12-6  我的反馈：分页（21+2 条→第 2 页）与状态筛选 UI。
V12-7  契约边界（API 级）：旧 screenshot 兼容、images⊥screenshot、>5 张/格式非法/
       sha 不符拒绝、JPEG 通过、回复多图 + 幂等重放。
V12-8  附件鉴权：未登录 401 / 他人 404 / 本人 200（images、日志 download）。
V12-9  视觉核对：390x844 / 768x1024 / 1440x900 浅深色截图存档。

外部服务（AI :8899 / Kaneo :8898）由 e2e/mock-external.mjs 模拟。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import png_probe  # noqa: E402
import run_browser as rb  # noqa: E402  复用编排：api/configure_service/wait_http/start/serve_pages
from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = rb.ROOT
SERVER = rb.SERVER
APP_ID = rb.APP_ID
PAGES_ORIGIN = rb.PAGES_ORIGIN
KANEO_PORT = rb.KANEO_PORT
AI_PORT = rb.AI_PORT
E2E_USER, E2E_PASS = rb.E2E_USER, rb.E2E_PASS
E2E_USER2, E2E_PASS2 = rb.E2E_USER2, rb.E2E_PASS2
PAGE_URL = f"{PAGES_ORIGIN}/v12-app.html"

results: list[tuple[str, bool]] = []


def step(name):
    print(f"[STEP] {name}", flush=True)


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")


def record(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


# ---------------- Bearer 用户 API ----------------

def uapi(method, path, token, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SERVER}{path}", data=data, method=method)
    req.add_header("authorization", f"Bearer {token}")
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = r.read()
            return r.status, payload if raw else (json.loads(payload.decode()) if payload else None)
    except urllib.error.HTTPError as e:
        payload = e.read()
        if raw:
            return e.code, payload
        try:
            return e.code, json.loads(payload.decode())
        except Exception:
            return e.code, {"raw": payload.decode(errors="replace")}


def user_login(user=E2E_USER, pw=E2E_PASS):
    s, res = uapi_no_token("POST", "/api/auth/login", {
        "username": user, "password": pw, "clientLabel": "e2e-v12", "appId": APP_ID,
    })
    assert s == 200, res
    return res["token"]


def uapi_no_token(method, path, body=None, origin=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SERVER}{path}", data=data, method=method)
    if origin:
        req.add_header("origin", origin)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


# ---------------- multipart 构造 ----------------

def multipart(fields: dict, files: list[tuple[str, str, bytes, str]]):
    """fields: {name: str_value}；files: [(field, filename, bytes, content_type)]"""
    boundary = "----fbv12e2e" + hashlib.sha256(os.urandom(8)).hexdigest()[:16]
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f"--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    for field, fname, data, ctype in files:
        body.write(
            f"--{boundary}\r\ncontent-disposition: form-data; name=\"{field}\"; filename=\"{fname}\"\r\n"
            f"content-type: {ctype}\r\n\r\n".encode()
        )
        body.write(data)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return boundary, body.getvalue()


def post_multipart(path, token, fields, files):
    boundary, payload = multipart(fields, files)
    req = urllib.request.Request(f"{SERVER}{path}", data=payload, method="POST")
    req.add_header("authorization", f"Bearer {token}")
    req.add_header("content-type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


# ---------------- 图片夹具 ----------------

def make_image(fmt: str, size=(320, 200), color=(0x11, 0x77, 0xcc)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def img_desc(image_id: str, data: bytes, mime: str, filename: str, source="manual"):
    w, h = Image.open(io.BytesIO(data)).size
    return {"id": image_id, "source": source, "filename": filename,
            "sha256": sha(data), "mime": mime, "byteSize": len(data),
            "width": w, "height": h}


def mock_state():
    return rb.plain_get(f"http://127.0.0.1:{KANEO_PORT}/__mock/state")


def admin_detail(fid):
    s, d = rb.api("GET", f"/api/admin/feedback/{fid}")
    assert s == 200, d
    return d


def latest_feedback_id():
    s, res = rb.api("GET", "/api/admin/feedback?limit=50")
    assert s == 200, res
    items = res.get("items", res) if isinstance(res, dict) else res
    assert items, "无反馈记录"
    return items[0]["id"]


# ---------------- 浏览器场景 ----------------

def open_panel(page):
    page.locator(".fb-orb").click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=60000)


def browser_scenarios(shots_dir, fixtures):
    from playwright.sync_api import sync_playwright  # noqa

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(PAGE_URL, wait_until="networkidle")
        page.wait_for_selector("feedback-widget .fb-orb", timeout=30000)

        step("V12-1 捕获范围与不可绘制提示")
        page.locator("#open-overlays").click()
        open_panel(page)
        cnt = page.evaluate("() => window.__fbE2E.imageCount()")
        check("自动截图进入草稿（1 张）", cnt == 1, str(cnt))
        hint = page.evaluate("() => window.__fbE2E.hint()")
        record("不可绘制内容提示", "未入图" in (hint or ""), f"hint={hint!r}")

        step("V12-2 多图添加（截图+手动并存，上限 5）")
        page.set_input_files(".fb-image-input", [fixtures["png_a"], fixtures["png_b"]])
        page.wait_for_function("() => window.__fbE2E.imageCount() === 3", timeout=20000)
        page.set_input_files(".fb-image-input", [fixtures["png_c"], fixtures["png_d"], fixtures["png_e"]])
        page.wait_for_timeout(800)
        cnt = page.evaluate("() => window.__fbE2E.imageCount()")
        record("第 6 张被拒（仍为 5）", cnt == 5, f"count={cnt}")
        err = page.evaluate("() => window.__fbE2E.error()")
        record("超限有错误提示", bool(err), f"error={err!r}")
        if cnt < 5:  # 一次最多只能到 5：补到 5
            page.set_input_files(".fb-image-input", [fixtures["png_c"], fixtures["png_d"]])
            page.wait_for_function("() => window.__fbE2E.imageCount() === 5", timeout=20000)

        step("V12-3 编辑器：矩形标注 → 保存替换 → 预览==上传")
        # 首图是稳定 DOM（.fb-screenshot-thumb-box 无 .fb-image-cell），
        # .fb-image-cell 只覆盖第 2..5 张；这里编辑第 2 张并断言 thumbSha(1)。
        before_sha = page.evaluate("() => window.__fbE2E.thumbSha(1)")
        page.locator(".fb-image-cell .fb-thumb-edit").first.click()
        page.locator(".fb-editor").wait_for(state="visible", timeout=15000)
        box = page.locator(".fb-editor-canvas").bounding_box()
        assert box
        cx, cy = box["x"] + box["width"] / 4, box["y"] + box["height"] / 4
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + box["width"] / 3, cy + box["height"] / 3, steps=8)
        page.mouse.up()
        page.locator(".fb-editor-actions .fb-editor-btn.is-primary").click()  # 保存
        page.locator(".fb-editor").wait_for(state="hidden", timeout=15000)
        page.wait_for_function(
            f"() => {{ const s = window.__fbE2E.thumbSha(1); return s && s !== {json.dumps(before_sha)}; }}",
            timeout=20000)
        edited_sha = page.evaluate("() => window.__fbE2E.thumbSha(1)")
        record("编辑保存替换附件（sha 已变化）", bool(edited_sha and edited_sha != before_sha),
               f"{before_sha}→{edited_sha}")

        step("V12-2/3 提交（面板内登录）")
        page.evaluate("""() => document.querySelector('feedback-widget').addEventListener(
            'feedback-submitted', (e) => { window.__sub = e.detail; })""")
        page.locator(".fb-textarea").first.fill("V12 联调：侧栏菜单弹窗截图 + 手动图片")
        page.locator(".fb-submit").click()
        if page.locator(".fb-login-panel").is_hidden():
            page.locator(".fb-login-panel").wait_for(state="visible", timeout=15000)
        rb.login_in_panel(page, E2E_USER, E2E_PASS)
        page.wait_for_function("() => !!window.__sub", timeout=60000)
        fid = page.evaluate("() => window.__sub.feedbackId")
        detail = admin_detail(fid)
        images = detail.get("images") or []
        check("服务端落库 5 张有序图片", len(images) == 5, json.dumps(images)[:200])
        record("图片顺序与 sort 一致", [i["sort"] for i in images] == list(range(5)),
               str([i["sort"] for i in images]))
        record("编辑后预览 sha == 服务端 sha（第 2 张）", images[1]["sha256"] == edited_sha,
               f"{images[1]['sha256']} vs {edited_sha}")

        step("V12-1 像素断言：落库截图含侧栏/菜单/弹窗，不含组件")
        shot_png = rb.api_bytes(f"/api/admin/feedback/{fid}/images/{images[0]['id']}")
        arr = png_probe.decode(shot_png)
        w, h = png_probe.size(arr)
        record("截图输出尺寸 = 视口", (w, h) == (1280, 800), f"{w}x{h}")
        nav = png_probe.probe_region(arr, {"x": 0, "y": 40, "width": 176, "height": 720}, (0, 200, 83, 255), inset=6)
        menu = png_probe.probe_region(arr, {"x": 200, "y": 40, "width": 230, "height": 180}, (255, 109, 0, 255), inset=6)
        modal = png_probe.probe_region(arr, {"x": 200, "y": 300, "width": 360, "height": 260}, (0, 176, 255, 255), inset=6)
        record("侧栏入图", nav["ratio"] > 0.9, json.dumps(nav)[:300])
        record("菜单入图", menu["ratio"] > 0.9, json.dumps(menu)[:300])
        record("弹窗入图", modal["ratio"] > 0.9, json.dumps(modal)[:300])
        right = png_probe.probe_region(arr, {"x": 900, "y": 500, "width": 300, "height": 280}, (255, 255, 255, 255), inset=4)
        record("组件 UI 不入图（右下白）", right["ratio"] > 0.95, json.dumps(right)[:300])

        step("V12-4 归档后用户回复：Kaneo 任务不删除")
        kaneo_task_id = None
        for _ in range(60):
            d = admin_detail(fid)
            if d.get("kaneoTaskId"):
                kaneo_task_id = d["kaneoTaskId"]
                break
            time.sleep(1)
        check("自动归档生成 Kaneo 任务", bool(kaneo_task_id), "超时未归档")
        token = user_login()
        reply_meta = json.dumps({
            "text": "补充：仍然复现", "idempotencyKey": "v12-reply-1",
            "images": [img_desc("r1", fixtures["png_a_bytes"], "image/png", "r1.png")],
        })
        reply_files = [("images", "r1.png", fixtures["png_a_bytes"], "image/png")]
        s, rep = post_multipart(f"/api/feedback/{fid}/messages", token,
                                {"metadata": reply_meta}, reply_files)
        check("用户回复（带图）201", s == 201, json.dumps(rep)[:200])
        s2, rep2 = post_multipart(f"/api/feedback/{fid}/messages", token,
                                  {"metadata": reply_meta}, reply_files)
        record("同键同内容幂等重放", s2 == 200 and rep2.get("replayed") is True, f"{s2} {json.dumps(rep2)[:120]}")
        time.sleep(3)  # 给撤销 worker 一个调度窗口：v12 不应有任何 DELETE
        st = mock_state()
        record("Kaneo 未收到任何 DELETE", len(st["taskDeletes"]) == 0, json.dumps(st["taskDeletes"]))
        record("Kaneo 任务仍存在", any(t.get("id") == kaneo_task_id for t in st["tasks"]),
               json.dumps(st["tasks"])[:200])
        s, dlg = rb.api("GET", f"/api/admin/feedback/{fid}/dialogue")
        record("回复后 issueStatus=waiting_admin", dlg["feedback"]["issueStatus"] == "waiting_admin",
               dlg["feedback"].get("issueStatus", "?"))
        record("无在途撤销任务（cancellation 空/终态）",
               not dlg.get("cancellation") or dlg["cancellation"].get("status") in ("cancelled", "confirmed", "failed"),
               json.dumps(dlg.get("cancellation"))[:200])

        step("V12-5 处理说明与未读")
        s, res = rb.api("POST", f"/api/admin/feedback/{fid}/issue-status", {"issueStatus": "resolved"})
        record("缺处理说明的 resolved 被拒", s == 400, f"{s} {json.dumps(res)[:120]}")
        s, res = rb.api("POST", f"/api/admin/feedback/{fid}/issue-status",
                        {"issueStatus": "resolved", "resolutionNote": "已修复，随 v0.6 发布"})
        check("带处理说明标记解决", s == 200, json.dumps(res)[:200])
        s, udlg = uapi("GET", f"/api/feedback/{fid}/dialogue", token)
        check("用户对话返回 resolved", udlg["feedback"]["issueStatus"] == "resolved", udlg["feedback"].get("issueStatus"))
        record("处理说明对用户可见", "已修复" in json.dumps(udlg, ensure_ascii=False), "对话中无说明")
        s, summary = uapi("GET", f"/api/feedback/unread-summary?appId={APP_ID}", token)
        record("未读摘要 ≥1", summary["unreadFeedbacksCount"] >= 1, json.dumps(summary))

        step("V12-5b 组件对话视图：附件经 Bearer 渲染 + 轮询不清草稿")
        page.locator(".fb-nav-btn").nth(1).click()
        page.wait_for_selector(".fb-history-item", timeout=15000)
        page.locator(".fb-history-item").first.click()
        try:
            page.wait_for_function(
                "() => { const l = window.__fbE2E.dialogueImages(); return l.length > 0 && l.every(i => i.naturalWidth > 0); }",
                timeout=20000)
        except Exception:
            pass
        imgs = page.evaluate("() => window.__fbE2E.dialogueImages()")
        record("历史图片经 Bearer 渲染成功", len(imgs) > 0 and all(i["complete"] and i["naturalWidth"] > 0 for i in imgs),
               json.dumps(imgs)[:200])
        page.locator(".fb-dialogue-reply-box .fb-textarea").fill("草稿轮询保护验证")
        page.wait_for_timeout(11500)  # 跨过一个 10s 详情轮询周期
        rt = page.evaluate("() => window.__fbE2E.replyText()")
        record("轮询后回复草稿保留", rt == "草稿轮询保护验证", f"reply={rt!r}")

        step("V12-6 我的反馈分页与筛选")
        # 种子反馈用同一 Bearer 账号归属（面板登录用户 = E2E_USER）
        for i in range(21):
            s, r = uapi("POST", "/api/feedback", token, {
                "idempotencyKey": f"v12-seed-u-{i}", "appId": APP_ID, "text": f"分页种子 {i}",
            })
            assert s == 201, (s, r)
        page.locator(".fb-dialogue-header .fb-btn-secondary").first.click()  # 返回列表
        page.wait_for_selector(".fb-history-page-info", timeout=15000)
        meta = page.evaluate("() => window.__fbE2E.historyMeta()")
        record("第 1 页 20 条", meta["items"] == 20, json.dumps(meta))
        record("筛选项含四状态文案",
               all(x in meta["filterOptions"] for x in ["待处理", "待补充", "待管理员回复", "已解决"]),
               json.dumps(meta["filterOptions"]))
        page.locator(".fb-history-page-next").click()
        page.wait_for_function(
            "() => { const m = window.__fbE2E.historyMeta(); return (m.info||'').includes('第 2') && m.items > 0; }",
            timeout=15000)
        meta2 = page.evaluate("() => window.__fbE2E.historyMeta()")
        record("第 2 页有剩余条目", 0 < meta2["items"] < 20, json.dumps(meta2))
        page.locator(".fb-history-filter").select_option("resolved")
        page.wait_for_function(
            "() => { const m = window.__fbE2E.historyMeta(); return m.filterValue === 'resolved' && m.items >= 1; }",
            timeout=15000)
        meta3 = page.evaluate("() => window.__fbE2E.historyMeta()")
        record("状态筛选生效（resolved 仅 1 条）", meta3["items"] == 1, json.dumps(meta3))

        step("V12-9 视觉核对截图")
        os.makedirs(shots_dir, exist_ok=True)
        for vw, vh in [(390, 844), (768, 1024), (1440, 900)]:
            page.set_viewport_size({"width": vw, "height": vh})
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(shots_dir, f"v12-{vw}x{vh}-light.png"))
            page.evaluate("() => document.querySelector('feedback-widget').setAttribute('theme','dark')")
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(shots_dir, f"v12-{vw}x{vh}-dark.png"))
            page.evaluate("() => document.querySelector('feedback-widget').setAttribute('theme','light')")
        record("三尺寸浅深色截图已存档", True)

        ctx.close()
        browser.close()
    return fid, token


def api_contract_checks(token, fixtures, main_fid):
    step("V12-7 契约边界（API 级）")
    png1 = fixtures["png_a_bytes"]
    meta = {"idempotencyKey": "v12-api-legacy-1", "appId": APP_ID, "text": "旧单图兼容"}
    s, r = post_multipart("/api/feedback", token, {"metadata": json.dumps(meta)},
                          [("screenshot", "s.png", png1, "image/png")])
    record("旧 screenshot 字段兼容", s == 201, f"{s} {json.dumps(r)[:120]}")

    meta2 = {"idempotencyKey": "v12-api-mixed-1", "appId": APP_ID, "text": "互斥测试",
             "images": [img_desc("i1", png1, "image/png", "i1.png")]}
    s, r = post_multipart("/api/feedback", token, {"metadata": json.dumps(meta2)},
                          [("screenshot", "s.png", png1, "image/png"),
                           ("images", "i1.png", png1, "image/png")])
    record("images 与 screenshot 同现被拒", s == 400, f"{s} {json.dumps(r)[:160]}")

    six = [(f"i{i}", fixtures["png_a_bytes"]) for i in range(6)]
    meta3 = {"idempotencyKey": "v12-api-six-1", "appId": APP_ID, "text": "六张被拒",
             "images": [img_desc(i, d, "image/png", f"{i}.png") for i, d in six]}
    s, r = post_multipart("/api/feedback", token, {"metadata": json.dumps(meta3)},
                          [("images", f"{i}.png", d, "image/png") for i, d in six])
    record("6 张图片被拒", s == 400, f"{s} {json.dumps(r)[:160]}")

    bad = b"GIF89a-not-an-image" + b"\x00" * 32
    meta4 = {"idempotencyKey": "v12-api-bad-1", "appId": APP_ID, "text": "非法格式",
             "images": [{"id": "b1", "source": "manual", "filename": "b.png",
                         "sha256": sha(bad), "mime": "image/png"}]}
    s, r = post_multipart("/api/feedback", token, {"metadata": json.dumps(meta4)},
                          [("images", "b.png", bad, "image/png")])
    record("伪装 PNG 被拒", s in (400, 413), f"{s} {json.dumps(r)[:160]}")

    jpg = fixtures["jpg_bytes"]
    meta5 = {"idempotencyKey": "v12-api-jpg-1", "appId": APP_ID, "text": "JPEG 通过",
             "images": [img_desc("j1", jpg, "image/jpeg", "j.jpg")]}
    s, r = post_multipart("/api/feedback", token, {"metadata": json.dumps(meta5)},
                          [("images", "j.jpg", jpg, "image/jpeg")])
    record("JPEG 图片通过", s == 201, f"{s} {json.dumps(r)[:160]}")

    # 回复：multipart + images
    s, r = uapi("POST", "/api/feedback", token, {
        "idempotencyKey": "v12-reply-host", "appId": APP_ID, "text": "回复宿主记录",
    })
    assert s == 201, (s, r)
    fid2 = r["feedbackId"]
    s, r = post_multipart(f"/api/feedback/{fid2}/messages", token,
                          {"metadata": json.dumps({
                              "text": "", "idempotencyKey": "v12-reply-img-1",
                              "images": [img_desc("a", png1, "image/png", "a.png"),
                                         img_desc("b", jpg, "image/jpeg", "b.jpg")],
                          })},
                          [("images", "a.png", png1, "image/png"), ("images", "b.jpg", jpg, "image/jpeg")])
    record("回复携带双图", s == 201, f"{s} {json.dumps(r)[:160]}")

    step("V12-8 附件鉴权")
    main_detail = admin_detail(main_fid)
    main_imgs = main_detail.get("images") or []
    check("存在可鉴权的图片附件", len(main_imgs) > 0)
    img_id = main_imgs[0]["id"]

    req = urllib.request.Request(f"{SERVER}/api/feedback/{main_fid}/images/{img_id}")
    try:
        urllib.request.urlopen(req, timeout=10)
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    record("未登录取图 401", code == 401, f"code={code}")

    token2 = user_login(E2E_USER2, E2E_PASS2)
    s, _ = uapi("GET", f"/api/feedback/{main_fid}/images/{img_id}", token2, raw=True)
    record("他人取图 404", s == 404, f"code={s}")
    s, body = uapi("GET", f"/api/feedback/{main_fid}/images/{img_id}", token, raw=True)
    record("本人取图 200 且内容一致", s == 200 and sha(body) == main_imgs[0]["sha256"], f"code={s}")
    return main_fid


def main():
    busy = [p for p in (8787, 5189, KANEO_PORT, AI_PORT) if rb._port_busy(p)]
    if busy:
        print(f"[FATAL] 端口被占用：{busy}（先清理残留 e2e 进程）", flush=True)
        sys.exit(2)

    procs = []
    data_dir = tempfile.mkdtemp(prefix="fb-v12-e2e-")
    shots_dir = os.path.join(ROOT, "e2e/shots/v12")
    fix_dir = tempfile.mkdtemp(prefix="fb-v12-fix-")
    fixtures = {
        "png_a": os.path.join(fix_dir, "a.png"), "png_b": os.path.join(fix_dir, "b.png"),
        "png_c": os.path.join(fix_dir, "c.png"), "png_d": os.path.join(fix_dir, "d.png"),
        "png_e": os.path.join(fix_dir, "e.png"),
    }
    colors = [(0x11, 0x77, 0xcc), (0xcc, 0x55, 0x11), (0x22, 0xaa, 0x44), (0xaa, 0x22, 0x88), (0x66, 0x66, 0x00)]
    for k, c in zip(["png_a", "png_b", "png_c", "png_d", "png_e"], colors):
        with open(fixtures[k], "wb") as f:
            f.write(make_image("PNG", color=c))
    fixtures["png_a_bytes"] = make_image("PNG", color=colors[0])
    fixtures["jpg_bytes"] = make_image("JPEG", color=(0x33, 0x66, 0x99))

    base_env = dict(os.environ)
    base_env.update(
        FEEDBACK_MASTER_KEY="bG9jYWwtZTJlLW1hc3Rlci1rZXktMzItYnl0ZXMhIQ==",
        FEEDBACK_ADMIN_USER=rb.ADMIN_USER,
        FEEDBACK_ADMIN_PASSWORD=rb.ADMIN_PASS,
        FEEDBACK_ADMIN_DIST=os.path.join(ROOT, "apps/admin/dist"),
        NODE_ENV="production",
    )
    env = dict(base_env, FEEDBACK_DATA_DIR=data_dir, FEEDBACK_PORT="8787")

    try:
        step("启动 mock 外部服务与反馈服务")
        rb.start(procs, ["node", "e2e/mock-external.mjs"], log=open("/tmp/fb-v12-mock.log", "w"))
        assert rb.wait_http(f"http://127.0.0.1:{AI_PORT}/__health") and rb.wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
        rb.start(procs, ["npx", "tsx", "src/index.ts"], cwd=os.path.join(ROOT, "apps/server"),
                 env=env, log=open("/tmp/fb-v12-server.log", "w"))
        assert rb.wait_http(f"{SERVER}/healthz", 60), "server 未启动"
        rb.serve_pages(5189, procs)

        s = rb.configure_service(SERVER, [(APP_ID, "E2E 宿主页", [PAGES_ORIGIN])])
        check("管理登录与服务配置", s == 200, str(s))

        fid, token = browser_scenarios(shots_dir, fixtures)
        api_contract_checks(token, fixtures, fid)

    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass

    failed = [n for n, ok in results if not ok]
    print(f"\n==== v12 联调结果：{len(results) - len(failed)} 通过 / {len(failed)} 失败 ====")
    for n in failed:
        print(f"  FAIL {n}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
