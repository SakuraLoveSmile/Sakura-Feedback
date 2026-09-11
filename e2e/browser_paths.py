#!/usr/bin/env python3
"""
三条新的真实浏览器路径（由 e2e/run_browser.py 调用，复用它的服务/mock 编排）：

P1 灵感球拖动：launcher-mode=orb + capture-mode=viewport，
  拖到宿主视口里的指定坐标 → 面板打开、截图落进草稿、落点被记录并用于指向问题、
  截图就是宿主视口（灵感球/面板不在图里）。

P2 遮罩：宿主页同时有 [data-feedback-capture-mask] 与 input[type=password]，
  在最终 PNG（组件产出的字节 + 服务端落库的字节）上做像素级断言：
  两个区域必须被不透明中性遮挡色 #6E6E73 覆盖，周围内容照常可见。

P3 遮挡失败规则：可见敏感区无法遮挡时必须整次截图失败
  （旧草稿/旧截图保留、用户被告知截图未完成、绝不静默产出未遮挡图片）。

P4 登录握手：真实弹窗到 <apiBase>/login → postMessage 回宿主（严格 origin+type+nonce），
  负例（异源 / nonce 不匹配）必须被忽略；切换 api-base 后旧服务令牌绝不发给新服务。

所有断言都是真实浏览器/真实服务观测；没有对被测组件做任何 mock。
注意：组件的「提交」按钮在未登录时会**直接打开**登录弹窗
（packages/web/src/element.ts: beginLogin() → handshake.openPopup()），
所以下面所有登录流程都是「点提交 → expect_page → 在弹窗里完成登录」。
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.parse

import png_probe

MASK_RGBA = png_probe.MASK_RGBA
WHITE_RGBA = (255, 255, 255, 255)
MAGENTA_RGBA = (255, 0, 255, 255)
CYAN_RGBA = (0, 255, 255, 255)
GREEN_RGBA = (0, 255, 0, 255)
BLUE_RGBA = (0, 0, 255, 255)
RED_RGBA = (255, 0, 0, 255)
ACCENT_RGBA = (0, 113, 227, 255)  # --fb-accent: #0071e3（灵感球图标色）
FORGED_TOKEN = "FORGED-TOKEN-FROM-WRONG-ORIGIN"


# ---------------- 网络观测 ----------------


def request_body(req):
    """playwright-python 1.58 里 post_data_buffer 是 property（旧版是方法）。"""
    try:
        v = req.post_data_buffer
        return v() if callable(v) else v
    except Exception:
        return None


def is_submit_url(url: str) -> bool:
    """POST /api/feedback（排除 /api/feedback/:id 的轮询读取）。"""
    return bool(re.search(r"/api/feedback/?$", url))


class NetRecorder:
    """context 级请求/响应记录：证据直接取自浏览器真实网络层。

    请求体必须经过一次**只读路由**才能拿到：Playwright 只在路由命中时缓冲请求体，
    未路由的大 multipart（86KB 截图上传）`post_data_buffer` 会读回空字节。
    路由只做记录并 `fallback()` 放行，不改动请求本身。
    """

    def __init__(self, ctx, capture_bodies=True):
        self._requests = []
        self._handshakes = []
        self._bodies = []
        ctx.on("request", lambda r: self._requests.append(r))
        ctx.on("response", self._on_response)
        if capture_bodies:
            ctx.route("**/api/feedback", self._capture)

    def _capture(self, route):
        req = route.request
        if req.method == "POST" and is_submit_url(req.url):
            self._bodies.append({"url": req.url, "ct": req.headers.get("content-type", ""),
                                 "body": request_body(req)})
        route.fallback()

    def _on_response(self, resp):
        if "/api/auth/handshake" in resp.url:
            self._handshakes.append(resp)

    # -- 索引 --
    def mark(self) -> int:
        return len(self._requests)

    def entries(self, since: int = 0) -> list[dict]:
        out = []
        for r in self._requests[since:]:
            try:
                headers = r.headers
            except Exception:
                headers = {}
            out.append({"method": r.method, "url": r.url, "authorization": headers.get("authorization")})
        return out

    def _submit_requests(self) -> list:
        out = []
        for r in self._requests:
            if r.method == "POST" and is_submit_url(r.url):
                out.append(r)
        return out

    def feedback_count(self) -> int:
        return len(self._submit_requests())

    def feedback_posts(self, since: int = 0) -> list[dict]:
        out = []
        for i, r in enumerate(self._submit_requests()):
            if i < since:
                continue
            body = self._bodies[i]["body"] if i < len(self._bodies) else None
            ct = self._bodies[i]["ct"] if i < len(self._bodies) else r.headers.get("content-type", "")
            parsed = parse_multipart(body, ct) if body else {}
            meta = None
            if "metadata" in parsed:
                try:
                    meta = json.loads(parsed["metadata"].decode())
                except Exception:
                    meta = None
            out.append(
                {
                    "url": r.url,
                    "authorization": r.headers.get("authorization"),
                    "contentType": ct,
                    "bodyBytes": len(body or b""),
                    "metadata": meta,
                    "screenshot": parsed.get("screenshot"),
                }
            )
        return out

    def bearer(self, token: str, since: int = 0) -> list[dict]:
        want = f"Bearer {token}"
        return [e for e in self.entries(since) if (e["authorization"] or "") == want]

    def to_base(self, base: str, since: int = 0) -> list[dict]:
        return [e for e in self.entries(since) if e["url"].startswith(base)]

    def bearer_tokens(self, since: int = 0, base: str | None = None) -> list[str]:
        """客户端真实携带过的 Bearer 令牌（按首次出现顺序，去重）。

        直接从请求头观测，不依赖解析握手响应体（更稳、也更贴近"旧令牌有没有被发出去"）。
        """
        seen: list[str] = []
        for e in self.entries(since):
            auth = e["authorization"] or ""
            if not auth.startswith("Bearer ") or (base and not e["url"].startswith(base)):
                continue
            tok = auth[len("Bearer "):]
            if tok not in seen:
                seen.append(tok)
        return seen

    def tokens(self) -> list[str]:
        out = []
        for resp in self._handshakes:
            try:
                data = resp.json()
            except Exception:
                continue
            tok = (data or {}).get("accessToken")
            if tok:
                out.append(tok)
        return out


def parse_multipart(body: bytes, content_type: str) -> dict:
    m = re.search(r'boundary="?([^";,]+)"?', content_type or "")
    if not m or not body:
        return {}
    boundary = b"--" + m.group(1).encode()
    out: dict[str, bytes] = {}
    for part in body.split(boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, _, payload = part.partition(b"\r\n\r\n")
        nm = re.search(rb'name="([^"]+)"', head)
        if not nm:
            continue
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        out[nm.group(1).decode()] = payload
    return out


# ---------------- 通用工具 ----------------


def pixel_sha(arr) -> str:
    """解码后位图的像素签名（尺寸 + RGBA 摘要）；兼容 numpy 与 PIL 两种后端。"""
    w, h = png_probe.size(arr)
    if hasattr(arr, "tobytes"):
        body = arr.tobytes()
    else:
        body = arr.convert("RGBA").tobytes()
    return f"{w}x{h}:{png_probe.sha256(body)}"


def same_pixels(a, b) -> bool:
    """两张解码后的位图是否逐像素一致（尺寸 + 全部 RGBA 字节）。"""
    return pixel_sha(a) == pixel_sha(b)


def new_page(deps, url, console_log=None):
    page = deps["ctx"].new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    if console_log is not None:
        page.on("console", lambda m: console_log.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console_log.append(f"[pageerror] {e}"))
    page.goto(url, wait_until="networkidle")
    return page


def b64_to_bytes(b64: str) -> bytes:
    return base64.b64decode(b64)


def drag_orb(page, drag_to=None, timeout=60000) -> dict:
    """真实鼠标操作灵感球：drag_to=None → 点击呼出（capture-mode=viewport 先截图后开面板）。"""
    orb = page.locator(".fb-orb")
    box = orb.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    dragging = False
    if drag_to:
        page.mouse.move(drag_to[0], drag_to[1], steps=12)
        dragging = page.evaluate(
            "() => !!document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb.is-dragging')"
        )
    page.mouse.up()
    page.locator(".fb-panel").wait_for(state="visible", timeout=timeout)
    return {"orbBox": box, "dragging": dragging}


def client_png(page, deps) -> tuple[bytes, object]:
    b64 = page.evaluate("() => window.__fbE2E.blobBase64()")
    deps["check"]("草稿里有可读取的截图字节（blob URL 可取回）", bool(b64), "blobBase64 返回空")
    raw = b64_to_bytes(b64)
    return raw, png_probe.decode(raw)


def login_in_popup(popup, deps, timeout=40) -> bool:
    """在真实登录弹窗里完成登录；返回是否走了密码表单（无 Cookie 的干净 context 才会）。"""
    popup.wait_for_load_state()
    form = popup.locator("#login-form")
    deadline = time.time() + timeout
    visible = False
    while time.time() < deadline:
        try:
            if form.is_visible():
                visible = True
                break
            if popup.is_closed():
                break
        except Exception:
            break
        time.sleep(0.15)
    if visible:
        popup.locator("#username").fill(deps["admin_user"])
        popup.locator("#password").fill(deps["admin_pass"])
        popup.locator("#submit").click()
    try:
        popup.wait_for_event("close", timeout=20000)
    except Exception:
        pass
    return visible


def submit_with_login(page, deps, timeout=90000, rec=None) -> dict:
    """
    未登录 → 点「提交」会打开 <apiBase>/login 弹窗 → 弹窗内真实登录 → 组件自动提交。
    返回 {fid, token, payload, posts, mark}：token 是本次握手真实签发的令牌。
    """
    ctx = page.context  # P4c 用的是独立 context，不能写死主 context
    rec = rec or deps["rec"]
    mark = rec.feedback_count()
    tokens_before = len(rec.tokens())
    with page.expect_response(
        lambda r: r.url.endswith("/api/feedback") and r.request.method == "POST", timeout=timeout
    ) as info:
        with ctx.expect_page() as pop_info:
            page.locator(".fb-submit").click()
        popup = pop_info.value
        login_in_popup(popup, deps)
    payload = info.value.json() or {}
    tokens = rec.tokens()
    token = tokens[tokens_before] if len(tokens) > tokens_before else None
    posts = rec.feedback_posts(mark)
    return {"fid": payload.get("feedbackId"), "token": token, "payload": payload, "posts": posts}


def probe(label, arr, rect, expect, inset, deps, prefix="px"):
    """区域像素统计 + 证据打印 + 断言。"""
    p = png_probe.probe_region(arr, rect, expect, inset)
    p["label"] = label
    deps["pixel_results"].append(p)
    box = p.get("pixelBox")
    if box:
        p["cropPng"] = png_probe.save(
            arr,
            (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]),
            os.path.join(deps["shots_dir"], f"{prefix}-{label.replace(' ', '_').replace('/', '_')}.png"),
        )
    png_probe.dump(label, p)
    deps["check"](
        f"像素断言：{label} 全部为 rgb{tuple(expect[:3])}（inset {inset}px）",
        p.get("ok") is True,
        json.dumps(p, ensure_ascii=False)[:400],
    )
    return p


def ai_call_for(deps, needle):
    calls = deps["plain_get"]("http://127.0.0.1:8899/__mock/ai-calls")
    return [c for c in calls.get("calls", []) if needle in (c.get("userText") or "")]



def visible_probe(label, arr, rect, expect, deps, prefix="px", min_ratio=0.9):
    """「周围内容照常可见」：原色占比达标，且区域内一个遮挡色像素都没有。"""
    p = png_probe.probe_region(arr, rect, expect, 3)
    mask_px = png_probe.count_in_rect(arr, rect, MASK_RGBA)
    p.update({"label": label, "maskColorPixels": mask_px, "minRatio": min_ratio})
    p["ok"] = p["ratio"] >= min_ratio and mask_px == 0
    deps["pixel_results"].append(p)
    png_probe.dump(label, p)
    deps["check"](
        f"像素断言：{label} 保持原色（≥{int(min_ratio * 100)}%）且无遮罩色",
        p["ok"] is True,
        json.dumps(p, ensure_ascii=False)[:400],
    )
    return p


def orb_rect(page):
    """灵感球当前矩形 + 可见性（bounding_box 在异常状态下会返回 None，这里直接读布局）。"""
    return page.evaluate(
        """() => { const sr = document.querySelector('feedback-widget').shadowRoot;
                   const o = sr.querySelector('.fb-orb');
                   if (!o) return {found: false};
                   const r = o.getBoundingClientRect(); const cs = getComputedStyle(o);
                   return {found: true, x: r.x, y: r.y, width: r.width, height: r.height,
                           display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                           transform: cs.transform, hidden: o.hidden, cls: o.className}; }"""
    )


def rect_js(selector_expr: str) -> str:
    return f"""() => {{ const r = {selector_expr}.getBoundingClientRect();
                 return {{x: r.x, y: r.y, width: r.width, height: r.height}}; }}"""


# ---------------- P1：灵感球拖动 ----------------


def p1_orb_drag(deps):
    step, check = deps["step"], deps["check"]
    step("P1 灵感球拖动 → 落点 → 视口截图（真实鼠标拖拽）")
    rec = NetRecorder(deps["ctx"])
    deps["rec"] = rec

    page = new_page(deps, f"{deps['pages']}/orb.html")
    vp = page.evaluate("() => ({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY})")
    check("P1 宿主视口 1280x800、dpr=1、未滚动", vp == {"w": 1280, "h": 800, "dpr": 1, "sx": 0, "sy": 0}, str(vp))
    check("P1 灵感球可见（launcher-mode=orb）", page.locator(".fb-orb").is_visible())
    check("P1 贴边标签在 orb 模式下隐藏（文档化样式 styles.ts:260）", not page.locator(".fb-fab").is_visible())

    tx, ty = 256, 192  # 红色 landmark (100,100)-(340,260) 内 → 归一化 0.2 / 0.24
    info = drag_orb(page, drag_to=(tx, ty))
    check("P1 拖动中灵感球进入 is-dragging 态（真实指针事件）", info["dragging"] is True, str(info))
    check("P1 释放后反馈面板打开", page.locator(".fb-panel").is_visible())
    page.locator(".fb-screenshot-wrap").wait_for(state="visible", timeout=30000)
    check("P1 截图写入草稿（缩略图可见）", page.locator(".fb-screenshot-wrap").is_visible())
    after = orb_rect(page)
    png_probe.dump("P1 释放后灵感球状态（面板打开期间）", after)
    check("P1 释放后灵感球位移复位（不再有拖拽 transform）", after.get("transform") == "none", json.dumps(after, ensure_ascii=False))
    check("P1 面板打开时入口按文档隐藏（styles.ts:265 .fb-launcher.is-hidden）",
          "is-hidden" in (after.get("cls") or ""), after.get("cls"))

    raw, arr = client_png(page, deps)
    hash_before_reopen = png_probe.sha256(raw)
    w, h = png_probe.size(arr)
    check("P1 截图就是宿主视口尺寸 1280x800（dpr=1 → scale=1）", (w, h) == (1280, 800), f"{w}x{h}")
    png_probe.dump("P1 客户端 PNG", {"bytes": len(raw), "sha256": png_probe.sha256(raw), "size": [w, h]})
    png_probe.save(arr, None, os.path.join(deps["shots_dir"], "P1-orb-drag-client.png"))
    png_probe.dump("P1 客户端 PNG 颜色直方图", png_probe.histogram(arr, 6))

    landmark = {"x": 100, "y": 100, "width": 240, "height": 160}
    visible_probe("P1 landmark 区块（被指向的问题区域）", arr, landmark, RED_RGBA, deps, "P1")
    point = png_probe.probe_region(arr, {"x": tx - 4, "y": ty - 4, "width": 8, "height": 8}, RED_RGBA, 0)
    png_probe.dump("P1 落点 (256,192) 处像素", point)
    check("P1 落点 (256,192) 落在被指向的红色区块上", point.get("ok") is True, json.dumps(point, ensure_ascii=False)[:300])

    original_orb_rect = {"x": info["orbBox"]["x"], "y": info["orbBox"]["y"],
                         "width": info["orbBox"]["width"], "height": info["orbBox"]["height"]}
    probe("P1 灵感球原位区域（必须是纯宿主背景）", arr, original_orb_rect, WHITE_RGBA, 2, deps, "P1")
    accent = png_probe.color_count(arr, ACCENT_RGBA)
    png_probe.dump("P1 组件强调色像素数（#0071e3）", {"count": accent})
    check("P1 截图里没有组件 UI 的强调色像素", accent == 0, f"count={accent}")

    # 关闭面板 → 灵感球必须重新出现在原位置（回位可观测）
    page.locator(".fb-close").click()
    page.locator(".fb-panel").wait_for(state="hidden", timeout=8000)
    restored = orb_rect(page)
    png_probe.dump("P1 面板关闭后的灵感球状态", restored)
    check("P1 关闭面板后灵感球回到原位置且可见",
          restored.get("found") is True and restored["display"] != "none"
          and abs(restored["x"] - info["orbBox"]["x"]) < 1 and abs(restored["y"] - info["orbBox"]["y"]) < 1,
          json.dumps(restored, ensure_ascii=False))

    # ---- 提交：落点走完 客户端 → 服务端 → AI 链路 ----
    drag_orb(page)  # 已有草稿 → 只恢复草稿打开，不重拍（README §行为摘要）
    reopened = png_probe.sha256(b64_to_bytes(page.evaluate("() => window.__fbE2E.blobBase64()")))
    check("P1 重新呼出不重拍（草稿截图字节不变）", reopened == hash_before_reopen,
          f"{hash_before_reopen} -> {reopened}")
    page.locator(".fb-textarea").fill("灵感球拖动落点验证：导出按钮卡住")
    res = submit_with_login(page, deps)
    fid = res["fid"]
    check("P1 服务端返回 feedbackId", bool(fid), str(fid))
    check("P1 观察到 1 次 multipart 提交", len(res["posts"]) == 1, str(len(res["posts"])))
    meta = res["posts"][0]["metadata"] or {}
    cap = meta.get("capture") or {}
    png_probe.dump("P1 提交请求 metadata.capture（客户端侧）", cap)
    check("P1 提交 metadata.capture.releasePoint == 释放点归一化坐标",
          cap.get("releasePoint") == {"x": 0.2, "y": 0.24}, json.dumps(cap, ensure_ascii=False))
    check("P1 capture 的逻辑视口/输出像素都是 1280x800",
          [cap.get("viewportWidth"), cap.get("viewportHeight"), cap.get("pixelWidth"), cap.get("pixelHeight")]
          == [1280, 800, 1280, 800], json.dumps(cap, ensure_ascii=False))

    s, detail = deps["api"]("GET", f"/api/admin/feedback/{fid}")
    check("P1 管理端读取详情 200", s == 200, str(s))
    stored = (detail or {}).get("screenshot") or {}
    stored_cap = stored.get("capture") or {}
    png_probe.dump("P1 服务端落库 screenshot 元数据", stored)
    check("P1 服务端持久化 releasePoint 一致", stored_cap.get("releasePoint") == {"x": 0.2, "y": 0.24},
          json.dumps(stored_cap, ensure_ascii=False))
    check("P1 服务端实测 PNG 尺寸 1280x800", [stored.get("width"), stored.get("height")] == [1280, 800],
          json.dumps(stored, ensure_ascii=False))
    check("P1 capturedAt 已记录", bool(stored_cap.get("capturedAt")), json.dumps(stored_cap, ensure_ascii=False))

    srv_bytes = deps["api_bytes"](f"/api/admin/feedback/{fid}/screenshot")
    srv_arr = png_probe.decode(srv_bytes)
    png_probe.dump("P1 服务端落库 PNG",
                   {"bytes": len(srv_bytes), "sha256": png_probe.sha256(srv_bytes), "size": list(png_probe.size(srv_arr))})
    # 服务端落库的图必须与本地预览**逐像素一致**——
    # 这是「用户提交的就是他预览到的那张图」的服务端侧证据。
    # 不使用 Playwright 读 multipart：WebKit 上该通道只给出元数据段（读不到文件部分）。
    check("P1 服务端落库 PNG 与本地预览逐像素一致", same_pixels(srv_arr, arr), pixel_sha(srv_arr) + " vs " + pixel_sha(arr))
    png_probe.save(srv_arr, None, os.path.join(deps["shots_dir"], "P1-orb-drag-server.png"))
    visible_probe("P1 服务端 PNG landmark", srv_arr, landmark, RED_RGBA, deps, "P1srv")
    probe("P1 服务端 PNG 灵感球原位区域", srv_arr, original_orb_rect, WHITE_RGBA, 2, deps, "P1srv")

    kstate = deps["plain_get"]("http://127.0.0.1:8898/__mock/state")
    png_probe.dump("P1 Kaneo 图文归档状态",
                   {"assetKeys": kstate.get("assetKeys"), "commentTasks": list((kstate.get("comments") or {}).keys()),
                    "uploadAuthLeaks": kstate.get("uploadAuthLeaks")})
    check("P1 图文归档已登记资产并挂载截图评论",
          bool(kstate.get("assetKeys")) and bool(kstate.get("comments")), json.dumps(kstate, ensure_ascii=False)[:200])
    check("P1 预签名上传地址零凭据（未携带 Kaneo API Key）", kstate.get("uploadAuthLeaks") == [],
          str(kstate.get("uploadAuthLeaks")))

    mine = ai_call_for(deps, "灵感球拖动落点验证")
    check("P1 mock AI 收到本次归档请求", len(mine) == 1, str(len(mine)))
    prompt = (mine[-1] or {}).get("userText") or "" if mine else ""
    png_probe.dump("P1 AI 归档提示文本部分", prompt)
    check("P1 AI 提示带【用户关注落点】且坐标 == 释放点",
          "【用户关注落点】：归一化坐标 x=0.20 (20%), y=0.24 (24%)" in prompt, prompt[:400])
    check("P1 AI 提示带截图输出尺寸", "【截图输出尺寸】：1280 x 800 像素" in prompt, prompt[:400])
    check("P1 AI 请求是带图的多模态请求", bool(mine) and mine[-1].get("hasImage") is True,
          json.dumps(mine[-1:], ensure_ascii=False)[:300])
    if deps["shot"]:
        deps["shot"](page, "P1-orb-drag")
    page.close()


# ---------------- P2：遮罩像素级 ----------------


def p2_mask_pixels(deps):
    step, check = deps["step"], deps["check"]
    step("P2 遮罩：两个敏感区在最终 PNG 上必须是不透明 #6E6E73")
    rec = NetRecorder(deps["ctx"])
    deps["rec"] = rec

    page = new_page(deps, f"{deps['pages']}/mask.html")
    state = page.evaluate(
        """() => {
          const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
          const sc = document.getElementById('secret-card');
          const pw = document.getElementById('pw');
          return {secretVisible: vis(sc), secretMasked: sc.hasAttribute('data-feedback-capture-mask'),
                  pwVisible: vis(pw), pwType: pw.type};
        }"""
    )
    png_probe.dump("P2 宿主页敏感区状态", state)
    check("P2 [data-feedback-capture-mask] 区域可见", state["secretVisible"] and state["secretMasked"], str(state))
    check("P2 input[type=password] 可见", state["pwVisible"] and state["pwType"] == "password", str(state))

    rects = page.evaluate("() => window.__fbE2E.rects()")
    png_probe.dump("P2 宿主页元素视口矩形", rects)
    drag_orb(page)
    check("P2 点按呼出后面板打开", page.locator(".fb-panel").is_visible())
    page.locator(".fb-screenshot-wrap").wait_for(state="visible", timeout=30000)

    raw, arr = client_png(page, deps)
    w, h = png_probe.size(arr)
    check("P2 客户端 PNG 是宿主视口 1280x800", (w, h) == (1280, 800), f"{w}x{h}")
    png_probe.dump("P2 客户端 PNG", {"bytes": len(raw), "sha256": png_probe.sha256(raw)})
    png_probe.save(arr, None, os.path.join(deps["shots_dir"], "P2-mask-client.png"))
    png_probe.dump("P2 客户端 PNG 颜色直方图", png_probe.histogram(arr, 8))

    probe("P2 [mask]区域", arr, rects["secret-card"], MASK_RGBA, 3, deps, "P2")
    probe("P2 password区域", arr, rects["pw"], MASK_RGBA, 3, deps, "P2")
    visible_probe("P2 正常内容(北)", arr, rects["visible-block"], GREEN_RGBA, deps, "P2")
    visible_probe("P2 正常内容(南)", arr, rects["footer-block"], BLUE_RGBA, deps, "P2")

    mag = png_probe.color_count(arr, MAGENTA_RGBA)
    cyan = png_probe.color_count(arr, CYAN_RGBA)
    png_probe.dump("P2 敏感区原色像素数（客户端 PNG）", {"magenta_ff00ff": mag, "cyan_00ffff": cyan})
    check("P2 敏感区原色一个像素都不剩（#ff00ff）", mag == 0, f"count={mag}")
    check("P2 敏感区原色一个像素都不剩（#00ffff）", cyan == 0, f"count={cyan}")

    left_band = {"x": rects["secret-card"]["x"] - 10, "y": rects["secret-card"]["y"],
                 "width": 8, "height": rects["secret-card"]["height"]}
    visible_probe("P2 遮挡左侧紧邻带（不得外溢）", arr, left_band, WHITE_RGBA, deps, "P2")
    above_band = {"x": rects["pw"]["x"], "y": rects["pw"]["y"] - 10, "width": rects["pw"]["width"], "height": 8}
    visible_probe("P2 password 上方紧邻带（不得外溢）", arr, above_band, WHITE_RGBA, deps, "P2")

    page.locator(".fb-textarea").fill("遮罩像素验证：密钥与密码输入框都必须被遮挡")
    res = submit_with_login(page, deps)
    fid = res["fid"]
    check("P2 观察到 1 次 multipart 提交", len(res["posts"]) == 1, str(len(res["posts"])))
    cap = ((res["posts"][0]["metadata"] or {}).get("capture")) or {}
    png_probe.dump("P2 提交 metadata.capture", cap)
    check("P2 点按呼出没有落点（只有拖拽才带 releasePoint）", "releasePoint" not in cap, json.dumps(cap, ensure_ascii=False))

    check("P2 服务端返回 feedbackId", bool(fid), str(fid))
    s, detail = deps["api"]("GET", f"/api/admin/feedback/{fid}")
    stored = (detail or {}).get("screenshot") or {}
    png_probe.dump("P2 服务端落库 screenshot 元数据", stored)
    check("P2 服务端实测 PNG 尺寸 1280x800", [stored.get("width"), stored.get("height")] == [1280, 800],
          json.dumps(stored, ensure_ascii=False))

    srv_bytes = deps["api_bytes"](f"/api/admin/feedback/{fid}/screenshot")
    srv_arr = png_probe.decode(srv_bytes)
    png_probe.dump("P2 服务端落库 PNG",
                   {"bytes": len(srv_bytes), "sha256": png_probe.sha256(srv_bytes), "size": list(png_probe.size(srv_arr))})
    check("P2 服务端落库 PNG 与本地预览逐像素一致", same_pixels(srv_arr, arr), pixel_sha(srv_arr) + " vs " + pixel_sha(arr))
    png_probe.save(srv_arr, None, os.path.join(deps["shots_dir"], "P2-mask-server.png"))
    probe("P2 服务端 PNG [mask]区域", srv_arr, rects["secret-card"], MASK_RGBA, 3, deps, "P2srv")
    probe("P2 服务端 PNG password区域", srv_arr, rects["pw"], MASK_RGBA, 3, deps, "P2srv")
    visible_probe("P2 服务端 PNG 正常内容", srv_arr, rects["visible-block"], GREEN_RGBA, deps, "P2srv")
    srv_mag = png_probe.color_count(srv_arr, MAGENTA_RGBA)
    srv_cyan = png_probe.color_count(srv_arr, CYAN_RGBA)
    png_probe.dump("P2 敏感区原色像素数（服务端 PNG）", {"magenta_ff00ff": srv_mag, "cyan_00ffff": srv_cyan})
    check("P2 服务端落库 PNG 里敏感区原色为 0", srv_mag == 0 and srv_cyan == 0, f"magenta={srv_mag} cyan={srv_cyan}")

    mine = ai_call_for(deps, "遮罩像素验证")
    check("P2 AI 归档提示带截图输出尺寸",
          bool(mine) and "【截图输出尺寸】：1280 x 800 像素" in mine[-1]["userText"], str(len(mine)))
    check("P2 带图反馈的 AI 请求是多模态", bool(mine) and mine[-1].get("hasImage") is True)
    if deps["shot"]:
        deps["shot"](page, "P2-mask")
    page.close()


# ---------------- P3：遮挡失败规则 ----------------


def p3_mask_failure(deps):
    step, check = deps["step"], deps["check"]
    step("P3 遮挡失败规则：可见敏感区无法遮挡 → 本次截图必须失败")
    rec = NetRecorder(deps["ctx"])
    deps["rec"] = rec
    logs: list[str] = []

    page = new_page(deps, f"{deps['pages']}/maskfail.html", console_log=logs)
    state = page.evaluate("() => window.__fbE2E.state()")
    png_probe.dump("P3 宿主初始状态", state)
    check("P3 存在可见敏感区（真实文档计数 ≥1）", state["realSensitiveVisible"] >= 1, str(state))
    posts_before = rec.feedback_count()

    drag_orb(page)
    page.locator(".fb-screenshot-wrap").wait_for(state="visible", timeout=30000)
    first_raw, first_arr = client_png(page, deps)
    hash1 = png_probe.sha256(first_raw)
    secret_rect = page.evaluate(rect_js("document.getElementById('fragile-secret')"))
    png_probe.dump("P3 第一次成功截图", {"sha256": hash1, "bytes": len(first_raw), "size": list(png_probe.size(first_arr))})
    png_probe.save(first_arr, None, os.path.join(deps["shots_dir"], "P3-first-ok.png"))
    probe("P3 第一次截图里敏感区已被遮罩", first_arr, secret_rect, MASK_RGBA, 3, deps, "P3")
    png_probe.dump("P3 第一次截图敏感区原色像素数", {"magenta": png_probe.color_count(first_arr, MAGENTA_RGBA)})

    draft_text = "失败规则验证：旧草稿与旧截图必须保留"
    page.locator(".fb-textarea").fill(draft_text)

    # 机制 1：渲染器忽略开关
    page.locator("#e2e-fail-ignore").click()
    armed = page.evaluate("() => window.__fbE2E.state()")
    png_probe.dump("P3 触发后宿主状态（机制 1：data-html2canvas-ignore）", armed)
    check("P3 机制 1：敏感区在真实文档里仍然可见", armed["fragileVisible"] is True and armed["realSensitiveVisible"] >= 1, str(armed))

    def wait_failure(timeout=25) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if "截图未完成" in page.evaluate("() => window.__fbE2E.statusText()"):
                return True
            time.sleep(0.2)
        return False

    page.locator("#e2e-retake").click()
    mechanism = "克隆丢弃 data-html2canvas-ignore 子树 → locate-failed"
    failed = wait_failure()
    if not failed:
        page.locator("#e2e-reset").click()
        page.locator("#e2e-fail-tag").click()
        armed2 = page.evaluate("() => window.__fbE2E.state()")
        png_probe.dump("P3 触发后宿主状态（机制 2：标签选择器失配）", armed2)
        check("P3 机制 2：敏感区在真实文档里仍然可见", armed2["realSensitiveVisible"] >= 1, str(armed2))
        page.locator("#e2e-retake").click()
        mechanism = "自定义元素在克隆里失配（无可见盒 → locate-failed）"
        failed = wait_failure()

    status_text = page.evaluate("() => window.__fbE2E.statusText()")
    png_probe.dump("P3 内置路径失败证据",
                   {"mechanism": mechanism, "status": status_text, "consoleTail": logs[-6:]})
    check("P3 可见敏感区无法遮挡 → 用户被告知「截图未完成」", "截图未完成" in status_text, status_text)
    old_src = page.evaluate("() => window.__fbE2E.thumbSrc()")
    check("P3 失败时草稿里仍有旧截图（缩略图未消失）", bool(old_src))
    now_hash = png_probe.sha256(b64_to_bytes(page.evaluate("() => window.__fbE2E.blobBase64()")))
    png_probe.dump("P3 失败前后草稿截图哈希", {"before": hash1, "after": now_hash})
    check("P3 旧截图字节原样保留（未被失败截图覆盖）", now_hash == hash1, f"{hash1} -> {now_hash}")
    check("P3 旧草稿文字保留", page.locator(".fb-textarea").input_value() == draft_text,
          repr(page.locator(".fb-textarea").input_value()))
    check("P3 失败路径没有发起任何提交", rec.feedback_count() == posts_before, str(rec.feedback_count()))

    # 机制 3：泄漏型 captureProvider（返回真实未遮挡截图且不声明同帧遮挡）
    # Esc 只在焦点位于组件内时生效（element.ts:1785）：先点面板再关
    page.locator(".fb-textarea").click()
    page.keyboard.press("Escape")
    page.locator(".fb-panel").wait_for(state="hidden", timeout=8000)
    leaky_path = os.path.join(deps["pages_dir"], "leaky.png")
    page.screenshot(path=leaky_path)
    leaky_bytes = open(leaky_path, "rb").read()
    leaky_arr = png_probe.decode(leaky_bytes)
    sub = {"x": secret_rect["x"] + 8, "y": secret_rect["y"] + secret_rect["height"] - 40,
           "width": secret_rect["width"] - 16, "height": 32}
    leaky_plain = png_probe.probe_region(leaky_arr, sub, MAGENTA_RGBA, 0)
    leaky_mag = png_probe.color_count(leaky_arr, MAGENTA_RGBA)
    png_probe.dump("P3 泄漏型截图（Playwright 真实截图）",
                   {"sha256": png_probe.sha256(leaky_bytes), "size": list(png_probe.size(leaky_arr)),
                    "magentaPixels": leaky_mag, "plainRegion": leaky_plain})
    check("P3 泄漏图确实含未遮挡敏感区原像素（测试前提成立）",
          leaky_plain.get("ok") is True and leaky_mag > 0, json.dumps(leaky_plain, ensure_ascii=False)[:300])

    drag_orb(page)  # 有草稿 → 只开面板，不重拍（文档化行为）
    check("P3 有草稿时再次呼出不重拍（缩略图仍是旧图）",
          page.evaluate("() => window.__fbE2E.thumbSrc()") == old_src)
    info = page.evaluate("(u) => window.__fbE2E.installLeakyProvider(u)", "/leaky.png")
    png_probe.dump("P3 泄漏型 provider 已安装", info)
    check("P3 泄漏型 provider 安装成功",
          page.evaluate("() => typeof window.__fbE2E.widget().captureProvider === 'function'"))

    page.locator("#e2e-retake").click()
    failed2 = wait_failure()
    status2 = page.evaluate("() => window.__fbE2E.statusText()")
    png_probe.dump("P3 泄漏型 provider 结果", {"status": status2, "consoleTail": logs[-4:]})
    check("P3 provider 未保证同帧遮挡 → 拒绝该截图并提示失败", "截图未完成" in status2, status2)
    check("P3 泄漏图没有被采纳进草稿", page.evaluate("() => window.__fbE2E.thumbSrc()") == old_src)
    check("P3 失败路径没有发起任何提交（泄漏图未上传）", rec.feedback_count() == posts_before, str(rec.feedback_count()))
    leaked = [p["url"] for p in rec.feedback_posts() if p.get("screenshot") and leaky_bytes in p["screenshot"]]
    png_probe.dump("P3 上传体里含泄漏图字节的提交数", {"count": len(leaked)})
    check("P3 整个 P3 期间没有任何请求携带泄漏图字节", not leaked, str(leaked))

    # 正向对照：同一张图 + 声明同帧遮挡 → 被接受（证明负例的成因就是缺声明）
    compliant = page.evaluate(
        """async (u) => {
          const res = await fetch(u, {cache: 'no-store'});
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          const w = bmp.width, h = bmp.height; bmp.close();
          const r = document.getElementById('fragile-secret').getBoundingClientRect();
          window.__fbE2E.widget().captureProvider = async () => ({
            blob, width: w, height: h, viewport: {width: w, height: h},
            sameFrameMasking: true,
            maskedRegions: [{x: r.x, y: r.y, width: r.width, height: r.height}],
          });
          return {w, h, rect: {x: r.x, y: r.y, width: r.width, height: r.height}};
        }""",
        "/leaky.png",
    )
    png_probe.dump("P3 合规 provider 声明", compliant)
    page.locator("#e2e-retake").click()
    accepted = False
    deadline = time.time() + 25
    while time.time() < deadline:
        src = page.evaluate("() => window.__fbE2E.thumbSrc()")
        if src and src != old_src:
            accepted = True
            break
        time.sleep(0.2)
    got_hash = png_probe.sha256(b64_to_bytes(page.evaluate("() => window.__fbE2E.blobBase64()")))
    png_probe.dump("P3 正向对照结果", {"accepted": accepted, "newDraftHash": got_hash,
                                       "leakyHash": png_probe.sha256(leaky_bytes)})
    check("P3 正向对照：provider 声明同帧遮挡后同一张图被接受（负例成因 = 缺声明）",
          accepted and got_hash == png_probe.sha256(leaky_bytes), f"accepted={accepted}")
    if deps["shot"]:
        deps["shot"](page, "P3-maskfail")
    page.close()


# ---------------- P4：登录握手 ----------------


def _fresh_login_context(deps, label):
    """无 Cookie 的独立 context：保证登录弹窗一定停在真实密码表单（待握手状态）。"""
    ctx = deps["browser"].new_context(viewport={"width": 1280, "height": 800})
    rec = NetRecorder(ctx)
    page = ctx.new_page()
    page.goto(f"{deps['pages']}/login.html", wait_until="networkidle")
    # 该宿主页用 tab 入口（capture-mode=off）：面板默认关闭，先呼出再输入
    mode = page.evaluate("() => document.querySelector('feedback-widget')?.getAttribute('launcher-mode')")
    page.locator(".fb-orb" if mode == "orb" else ".fb-fab").click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=30000)
    origin = page.evaluate("() => location.origin")
    deps["check"](f"{label} 宿主页 origin 与服务不同源", origin == deps["pages"], origin)
    return ctx, rec, page


def p4_login_handshake(deps):
    step, check = deps["step"], deps["check"]

    # ---------- P4a：异源消息必须被忽略 ----------
    step("P4a 登录握手：异源消息必须被忽略 → 真实登录仍然成功")
    ctx, rec, page = _fresh_login_context(deps, "P4a")
    deps["rec"] = rec
    page.locator(".fb-textarea").fill("异源伪造消息必须被忽略")
    with ctx.expect_page() as pop_info:
        page.locator(".fb-submit").click()
    popup = pop_info.value
    popup.wait_for_load_state()
    check("P4a 未登录点提交 → 弹窗打到 <apiBase>/login", popup.url.startswith(deps["service"] + "/login?"), popup.url)
    q = {k: urllib.parse.unquote(v) for k, v in re.findall(r"([^?&=]+)=([^&]*)", popup.url.split("?", 1)[1])}
    png_probe.dump("P4a 登录页 URL 参数", q)
    check("P4a 登录页 URL 带 appId/nonce/cb", {"appId", "nonce", "cb"} <= set(q), str(q))
    check("P4a cb 是宿主 origin", q["cb"] == deps["pages"], q.get("cb"))
    check("P4a 弹窗停在真实待登录状态", popup.locator("#login-form").is_visible())
    nonce = q["nonce"]

    attacker_url = f"{deps['attacker']}/attacker.html?nonce={nonce}&token={FORGED_TOKEN}"
    page.evaluate("(u) => { document.getElementById('e2e-open-attacker').dataset.url = u; }", attacker_url)
    mark = rec.mark()
    with ctx.expect_page() as apop:
        page.locator("#e2e-open-attacker").click()
    apage = apop.value
    apage.wait_for_function("() => window.__attacker && window.__attacker.posts > 0", timeout=15000)
    ainfo = apage.evaluate("() => window.__attacker")
    png_probe.dump("P4a 异源页投递记录", ainfo)
    check("P4a 攻击窗口来自另一个 origin", ainfo["origin"] == deps["attacker"], str(ainfo))
    check("P4a 攻击页确实投递了消息（不是被浏览器丢弃）",
          ainfo["posts"] > 0 and not ainfo["lastError"] and ainfo["hasOpener"], str(ainfo))
    page.wait_for_function("() => window.__fbE2E.messages.length > 0", timeout=15000)
    got = page.evaluate("() => window.__fbE2E.messages")
    png_probe.dump("P4a 宿主页收到的消息（含 origin/nonce/token）", got)
    check("P4a 宿主页收到了这条异源消息（送达 ≠ 被接受）",
          any(m["origin"] == deps["attacker"] and m["type"] == "feedback:auth" and m["nonce"] == nonce for m in got),
          json.dumps(got, ensure_ascii=False))
    page.wait_for_timeout(1000)
    forged = rec.bearer(FORGED_TOKEN, since=mark)
    check("P4a 组件忽略异源消息：没有任何请求带伪造令牌", not forged, str(forged)[:300])
    check("P4a 组件忽略异源消息：没有发起提交", rec.feedback_count() == 0, str(rec.feedback_count()))
    check("P4a 握手仍待完成（弹窗表单还在）", popup.locator("#login-form").is_visible())
    check("P4a 宿主页仍显示需要登录",
          page.evaluate("() => window.__fbE2E.widget().shadowRoot.querySelector('.fb-submit').textContent") == "登录并提交")
    check("P4a 草稿文字保留", page.locator(".fb-textarea").input_value() == "异源伪造消息必须被忽略")
    apage.close()

    form_visible = login_in_popup(popup, deps)
    check("P4a 真实登录走的是密码表单（干净 context）", form_visible is True, str(form_visible))
    page.wait_for_selector(".fb-task-link", timeout=90000)
    toks = rec.bearer_tokens()
    posts = rec.feedback_posts()
    png_probe.dump("P4a 客户端真实携带的令牌", {"bearerTokens": len(toks), "handshakeResponses": len(rec.tokens()),
                                            "submitAuth": posts[0]["authorization"] if posts else None})
    check("P4a 登录后自动提交 1 次", len(posts) == 1, str(len(posts)))
    check("P4a 客户端开始携带握手签发的真实令牌", len(toks) == 1, str(toks))
    check("P4a 该令牌不是异源伪造令牌", bool(toks) and toks[0] != FORGED_TOKEN, str(toks))
    check("P4a 提交携带的就是这个真实令牌", bool(posts) and posts[0]["authorization"] == f"Bearer {toks[0]}",
          str(posts[:1])[:200])
    check("P4a 提交打到旧服务 8787", bool(posts) and posts[0]["url"].startswith(deps["service"] + "/api/feedback"))
    token_a_real = toks[0]
    page.close()
    ctx.close()

    # ---------- P4b：origin 正确但 nonce 不匹配 ----------
    step("P4b 登录握手：正确 origin + 错误 nonce（真实旧令牌重放）必须被忽略")
    ctx2, rec2, page2 = _fresh_login_context(deps, "P4b")
    deps["rec"] = rec2
    page2.locator(".fb-textarea").fill("旧 nonce 重放必须被忽略")
    with ctx2.expect_page() as pop_info2:
        page2.locator(".fb-submit").click()
    popup2 = pop_info2.value
    popup2.wait_for_load_state()
    check("P4b 弹窗停在真实待登录状态", popup2.locator("#login-form").is_visible())
    nonce2 = {k: urllib.parse.unquote(v) for k, v in re.findall(r"([^?&=]+)=([^&]*)", popup2.url.split("?", 1)[1])}["nonce"]
    stale_nonce = "0123456789abcdef0123456789abcdef"
    check("P4b 重放 nonce 与本次握手 nonce 不同", stale_nonce != nonce2, nonce2)
    mark2 = rec2.mark()
    popup2.evaluate(
        """([nonce, token, target]) => window.opener.postMessage(
             {type: 'feedback:auth', nonce, accessToken: token,
              expiresAt: new Date(Date.now() + 3600_000).toISOString()}, target)""",
        [stale_nonce, token_a_real, deps["pages"]],
    )
    page2.wait_for_function("() => window.__fbE2E.messages.length > 0", timeout=15000)
    got2 = page2.evaluate("() => window.__fbE2E.messages")
    png_probe.dump("P4b 宿主页收到的消息", got2)
    check("P4b 宿主页收到了来自服务 origin 的消息",
          any(m["origin"] == deps["service"] and m["type"] == "feedback:auth" for m in got2),
          json.dumps(got2, ensure_ascii=False))
    page2.wait_for_timeout(1200)
    check("P4b 组件忽略 nonce 不匹配的消息：没有发起提交", rec2.feedback_count() == 0, str(rec2.feedback_count()))
    check("P4b 该旧令牌没有被用于任何请求", not rec2.bearer(token_a_real, since=mark2), str(rec2.bearer(token_a_real, since=mark2))[:300])
    check("P4b 宿主页仍显示需要登录", page2.locator(".fb-login").is_visible())
    check("P4b 草稿文字保留", page2.locator(".fb-textarea").input_value() == "旧 nonce 重放必须被忽略")

    form_visible2 = login_in_popup(popup2, deps)
    check("P4b 之后真实登录仍成功（正例）", form_visible2 is True, str(form_visible2))
    page2.wait_for_selector(".fb-task-link", timeout=90000)
    tokens2 = rec2.bearer_tokens()
    posts2 = rec2.feedback_posts()
    check("P4b 客户端只携带了本次真实令牌", len(tokens2) == 1, str(tokens2))
    check("P4b 提交用的是本次真实令牌", bool(posts2) and posts2[0]["authorization"] == f"Bearer {tokens2[0]}",
          str(posts2[:1])[:300])
    check("P4b 本次令牌与 P4a 的令牌不同", bool(tokens2) and tokens2[0] != token_a_real)
    check("P4b 被重放的旧令牌从未被客户端使用", token_a_real not in tokens2, str(tokens2))
    page2.close()
    ctx2.close()

    # ---------- P4c：切换 api-base 的凭据隔离 ----------
    step("P4c 切换 api-base：旧服务令牌绝不发给新服务")
    ctx3, rec3, page3 = _fresh_login_context(deps, "P4c")
    deps["rec"] = rec3
    page3.locator(".fb-textarea").fill("切换服务前的提交")
    first = submit_with_login(page3, deps, rec=rec3)
    page3.wait_for_selector(".fb-task-link", timeout=90000)
    tokens3 = rec3.bearer_tokens(base=deps["service"])
    check("P4c 客户端对旧服务携带了令牌", len(tokens3) == 1, str(tokens3))
    token_old = tokens3[0]
    check("P4c 旧服务提交带旧令牌", bool(first["posts"]) and first["posts"][0]["authorization"] == f"Bearer {token_old}",
          str(first["posts"][:1])[:300])
    check("P4c 旧服务确实接收了提交", bool(first["fid"]), str(first["fid"]))

    mark3 = rec3.mark()
    page3.evaluate("(u) => window.__fbE2E.setApiBase(u)", deps["service2"])
    after = page3.evaluate(
        "() => ({apiBase: window.__fbE2E.widget().apiBase, text: window.__fbE2E.widget().shadowRoot.querySelector('.fb-textarea').value})"
    )
    png_probe.dump("P4c 切换 api-base 后的组件状态", after)
    check("P4c api-base 已切到新服务", after["apiBase"] == deps["service2"], str(after))
    check("P4c 切换清空旧服务草稿（文档化：完整身份切换）", after["text"] == "", str(after))

    page3.locator(".fb-textarea").fill("切换服务后的提交")
    with ctx3.expect_page() as pop_info4:
        page3.locator(".fb-submit").click()
    popup4 = pop_info4.value
    popup4.wait_for_load_state()
    check("P4c 切换后提交 → 为新服务打开登录窗（不会直接发提交）",
          popup4.url.startswith(deps["service2"] + "/login?"), popup4.url)
    to_new = rec3.to_base(deps["service2"], since=mark3)
    png_probe.dump("P4c 切换后打到新服务的请求",
                   [{"method": e["method"], "url": e["url"], "authorization": e["authorization"]} for e in to_new])
    old_to_new = [e for e in to_new if (e["authorization"] or "") == f"Bearer {token_old}"]
    check("P4c 没有任何打到新服务的请求带旧服务 Authorization", not old_to_new, str(old_to_new)[:300])
    new_posts = [e for e in to_new if e["method"] == "POST" and e["url"].endswith("/api/feedback")]
    check("P4c 未重新登录前不会向新服务发提交请求", not new_posts, str(new_posts)[:300])

    form_visible4 = login_in_popup(popup4, deps)
    check("P4c 新服务登录走真实表单（不同 origin → 无旧 Cookie）", form_visible4 is True, str(form_visible4))
    page3.wait_for_selector(".fb-task-link", timeout=90000)
    tokens4 = rec3.bearer_tokens(since=mark3, base=deps["service2"])
    check("P4c 新服务登录后客户端携带新令牌（不是旧服务的）", len(tokens4) == 1, str(tokens4))
    token_new = tokens4[0]
    check("P4c 新旧令牌不同", token_new != token_old)
    posts_new = [p for p in rec3.feedback_posts() if p["url"].startswith(deps["service2"])]
    png_probe.dump("P4c 新服务提交", posts_new[:1])
    check("P4c 新服务提交用的是新令牌", bool(posts_new) and posts_new[0]["authorization"] == f"Bearer {token_new}",
          str(posts_new[:1])[:300])
    check("P4c 新服务提交没带旧令牌", all(p["authorization"] != f"Bearer {token_old}" for p in posts_new))
    old_anywhere = [e for e in rec3.bearer(token_old) if e["url"].startswith(deps["service2"])]
    check("P4c 全流程扫描：旧令牌从未发往新服务", not old_anywhere, str(old_anywhere)[:300])
    png_probe.dump("P4c 旧令牌出现过的请求（应只在 8787）",
                   [{"method": e["method"], "url": e["url"]} for e in rec3.bearer(token_old)])
    page3.close()
    ctx3.close()


# ---------------- P6：默认 off 模式的**手动**截图入口 ----------------
#
# 修复前的缺口（用户报告）：截图操作区整体长在「仅有截图才显示」的预览里，
# 默认 capture-mode="off" 的宿主（绝大多数存量宿主）既不会自动截图、
# 又没有首次截图入口；先输入文字后，呼出式的 captureAndOpen() 也会被草稿拦下。
#
# 本路径全部用真实鼠标 / 键盘操作真实的侧边标签与面板按钮，不做任何组件 mock：
#   打开不自动截图（blob URL 计数为 0，不只是"看不见"）
#   → 先填文字 → 点「截取当前页面」→ 有效 PNG + 敏感区遮挡 + 不含组件 UI
#   → 预览放大 / Esc → 重拍保留文字 → multipart 提交 → 服务端落库字节复核。


def p6_manual_capture(deps):
    step, check = deps["step"], deps["check"]
    step("P6 默认 capture-mode=off：侧边标签 → 不自动截图 → 手动截图 → 像素 / 放大 / 提交")
    rec = NetRecorder(deps["ctx"])
    deps["rec"] = rec

    page = deps["ctx"].new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    # 组件只在「真的截到图」时才创建 blob URL：用它区分「没截图」与「截图了但没显示」
    page.add_init_script(
        "(() => { window.__fbBlobUrls = 0; const orig = URL.createObjectURL.bind(URL);"
        " URL.createObjectURL = (b) => { window.__fbBlobUrls++; return orig(b); }; })()"
    )
    page.goto(f"{deps['pages']}/manual.html", wait_until="networkidle")

    vp = page.evaluate("() => ({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY})")
    check("P6 宿主视口 1280x800、dpr=1、未滚动", vp == {"w": 1280, "h": 800, "dpr": 1, "sx": 0, "sy": 0}, str(vp))
    attrs = page.evaluate(
        """() => { const w = window.__fbE2E.widget();
             return {launcher: w.getAttribute('launcher-mode'), capture: w.getAttribute('capture-mode'),
                     side: w.getAttribute('side')}; }"""
    )
    png_probe.dump("P6 宿主声明的入口属性", attrs)
    check("P6 宿主未声明 capture-mode / launcher-mode（默认 off + 贴边标签）",
          attrs["capture"] is None and attrs["launcher"] is None, json.dumps(attrs, ensure_ascii=False))
    check("P6 侧边标签入口可见（默认 launcher-mode=tab）", page.locator(".fb-fab").is_visible())
    check("P6 灵感球在 tab 模式下隐藏", not page.locator(".fb-orb").is_visible())
    launcher_box = page.locator(".fb-fab").bounding_box()
    png_probe.dump("P6 侧边标签矩形", launcher_box)

    # ---- 1) 真实点击侧边标签：打开面板，且**不**自动截图 ----
    page.locator(".fb-fab").click()
    panel = page.locator(".fb-panel")
    panel.wait_for(state="visible", timeout=60000)
    page.wait_for_timeout(900)  # 若存在自动捕获，这段时间足够写完草稿并渲染预览
    opened = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const vis = (el) => { const r = el.getBoundingClientRect();
              return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; };
            const wrap = sr.querySelector('.fb-screenshot-wrap');
            const thumb = sr.querySelector('img.fb-screenshot-thumb');
            const capture = sr.querySelector('.fb-btn-capture');
            const retake = sr.querySelector('.fb-btn-retake');
            const remove = sr.querySelector('.fb-btn-remove');
            return {blobUrls: window.__fbBlobUrls,
                    wrapHidden: wrap.hidden, wrapDisplay: getComputedStyle(wrap).display, wrapVisible: vis(wrap),
                    thumbSrc: thumb ? thumb.getAttribute('src') : null,
                    thumbNatural: thumb ? thumb.naturalWidth : 0,
                    captureVisible: vis(capture), captureHidden: capture.hidden,
                    captureDisabled: capture.disabled, captureText: (capture.textContent || '').trim(),
                    retakeHidden: retake.hidden, removeHidden: remove.hidden,
                    retakeVisible: vis(retake), removeVisible: vis(remove)}; }"""
    )
    png_probe.dump("P6 打开面板后的截图区状态", opened)
    check("P6 打开面板不自动截图（全程没有创建过任何截图 blob URL）",
          opened["blobUrls"] == 0, str(opened["blobUrls"]))
    check("P6 打开面板不自动截图（无预览、缩略图无 src、解码宽度为 0）",
          opened["wrapHidden"] and opened["wrapDisplay"] == "none" and not opened["wrapVisible"]
          and opened["thumbSrc"] is None and opened["thumbNatural"] == 0,
          json.dumps(opened, ensure_ascii=False))
    check("P6 面板里有可用的手动截图入口「截取当前页面」",
          opened["captureVisible"] and not opened["captureHidden"] and not opened["captureDisabled"]
          and opened["captureText"] == "截取当前页面",
          json.dumps(opened, ensure_ascii=False))
    check("P6 无截图时「重新截图 / 移除截图」都不出现（且真的不占版面）",
          opened["retakeHidden"] and opened["removeHidden"]
          and not opened["retakeVisible"] and not opened["removeVisible"],
          json.dumps(opened, ensure_ascii=False))

    panel_box = panel.bounding_box()
    png_probe.dump("P6 面板矩形（捕获时必须不可见）", panel_box)

    # 关键回归：**先输入文字**。修复前这条文字会让所有"呼出式"补拍失效。
    text = "手动截图入口验证：默认不自动截图，点按钮才拍"
    page.locator(".fb-textarea").fill(text)

    # ---- 2) 真实点击「截取当前页面」→ 有效 PNG ----
    page.locator(".fb-btn-capture").click()
    page.locator(".fb-screenshot-wrap").wait_for(state="visible", timeout=60000)
    page.wait_for_timeout(500)
    after = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const vis = (el) => { const r = el.getBoundingClientRect();
              return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; };
            const thumb = sr.querySelector('img.fb-screenshot-thumb');
            return {blobUrls: window.__fbBlobUrls, text: sr.querySelector('.fb-textarea').value,
                    thumbSrc: thumb.getAttribute('src'), thumbNatural: thumb.naturalWidth,
                    captureHidden: sr.querySelector('.fb-btn-capture').hidden,
                    retakeVisible: vis(sr.querySelector('.fb-btn-retake')),
                    removeVisible: vis(sr.querySelector('.fb-btn-remove')),
                    panelVisible: vis(sr.querySelector('.fb-panel')),
                    panelVisibility: getComputedStyle(sr.querySelector('.fb-panel')).visibility,
                    status: window.__fbE2E.statusText()}; }"""
    )
    png_probe.dump("P6 手动截图后的面板状态", after)
    check("P6 手动截图写入草稿（预览可见 + blob URL 可解码）",
          str(after["thumbSrc"]).startswith("blob:") and after["thumbNatural"] > 0,
          json.dumps(after, ensure_ascii=False))
    check("P6 手动截图保留已有文字草稿", after["text"] == text, str(after["text"]))
    check("P6 截图后入口切换：首个入口隐藏、「重新截图 / 移除截图」可见",
          after["captureHidden"] and after["retakeVisible"] and after["removeVisible"],
          json.dumps(after, ensure_ascii=False))
    check("P6 截图结束后面板恢复可见（捕获期间整体隐藏）",
          after["panelVisible"] and after["panelVisibility"] == "visible", json.dumps(after, ensure_ascii=False))
    check("P6 手动截图未报错（状态区不出现截图失败提示）",
          "截图未完成" not in (after["status"] or ""), str(after["status"]))

    raw, arr = client_png(page, deps)
    w, h = png_probe.size(arr)
    check("P6 手动截图是有效 PNG 且尺寸 == 宿主视口 1280x800", (w, h) == (1280, 800), f"{w}x{h}")
    check("P6 手动截图字节量正常（> 1KB，不是空图）", len(raw) > 1024, f"{len(raw)} bytes")
    png_probe.dump("P6 客户端 PNG", {"bytes": len(raw), "sha256": png_probe.sha256(raw), "size": [w, h]})
    png_probe.save(arr, None, os.path.join(deps["shots_dir"], "P6-manual-client.png"))
    png_probe.dump("P6 客户端 PNG 颜色直方图", png_probe.histogram(arr, 8))

    rects = page.evaluate("() => window.__fbE2E.rects()")
    png_probe.dump("P6 宿主页元素视口矩形", rects)
    visible_probe("P6 正常内容(北)", arr, rects["visible-block"], GREEN_RGBA, deps, "P6")
    visible_probe("P6 正常内容(南)", arr, rects["footer-block"], BLUE_RGBA, deps, "P6")
    probe("P6 [mask] 区域", arr, rects["secret-card"], MASK_RGBA, 3, deps, "P6")
    probe("P6 password 区域", arr, rects["pw"], MASK_RGBA, 3, deps, "P6")
    mag = png_probe.color_count(arr, MAGENTA_RGBA)
    cyan = png_probe.color_count(arr, CYAN_RGBA)
    png_probe.dump("P6 敏感区原色像素数（客户端 PNG）", {"magenta_ff00ff": mag, "cyan_00ffff": cyan})
    check("P6 手动截图里敏感区原色一个像素都不剩", mag == 0 and cyan == 0, f"magenta={mag} cyan={cyan}")

    probe("P6 面板原区域（必须是纯宿主背景：截图不含反馈面板）", arr, panel_box, WHITE_RGBA, 2, deps, "P6")
    probe("P6 侧边标签原区域（必须是纯宿主背景）", arr, launcher_box, WHITE_RGBA, 2, deps, "P6")
    accent = png_probe.color_count(arr, ACCENT_RGBA)
    png_probe.dump("P6 组件强调色像素数（#0071e3）", {"count": accent})
    check("P6 手动截图里没有任何组件 UI 的强调色像素", accent == 0, f"count={accent}")

    # ---- 3) 预览放大：真实点击缩略图 → 全屏弹窗；Esc 只关弹窗 ----
    page.locator(".fb-screenshot-thumb-box").click()
    # 弹窗有 opacity/visibility 0.2s 过渡，大图也要解码：等真实可解码再断言
    page.wait_for_function(
        """() => { const sr = window.__fbE2E.shadow();
            const modal = sr.querySelector('.fb-zoom-modal');
            const img = modal.querySelector('img');
            return modal.classList.contains('is-open')
                && getComputedStyle(modal).visibility === 'visible'
                && !!img && img.naturalWidth > 0; }""",
        timeout=30000,
    )
    zoom = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const modal = sr.querySelector('.fb-zoom-modal');
            const img = modal.querySelector('img');
            return {open: modal.classList.contains('is-open'),
                    modalVisible: getComputedStyle(modal).visibility === 'visible',
                    zoomSrc: img.getAttribute('src'), zoomNatural: img.naturalWidth,
                    thumbSrc: sr.querySelector('img.fb-screenshot-thumb').getAttribute('src')}; }"""
    )
    png_probe.dump("P6 放大弹窗状态", zoom)
    check("P6 预览可放大：点击缩略图打开全屏弹窗且大图可解码",
          zoom["open"] and zoom["modalVisible"] and str(zoom["zoomSrc"]).startswith("blob:")
          and zoom["zoomNatural"] > 0 and zoom["zoomSrc"] == zoom["thumbSrc"],
          json.dumps(zoom, ensure_ascii=False))
    if deps["shot"]:
        deps["shot"](page, "P6-manual-zoom")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    esc = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            return {zoomOpen: sr.querySelector('.fb-zoom-modal').classList.contains('is-open'),
                    panelVisible: sr.querySelector('.fb-panel').getBoundingClientRect().width > 0}; }"""
    )
    check("P6 Esc 先关放大弹窗、面板保持打开", esc["zoomOpen"] is False and esc["panelVisible"] is True, str(esc))

    # ---- 4) 重拍：保留文字，产生新的有效 PNG ----
    before_retake = page.evaluate("() => window.__fbBlobUrls")
    page.locator(".fb-btn-retake").click()
    page.wait_for_function(f"() => window.__fbBlobUrls > {before_retake}", timeout=60000)
    page.wait_for_timeout(400)
    raw2, arr2 = client_png(page, deps)
    w2, h2 = png_probe.size(arr2)
    retake = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const thumb = sr.querySelector('img.fb-screenshot-thumb');
            return {text: sr.querySelector('.fb-textarea').value, thumbNatural: thumb.naturalWidth,
                    captureHidden: sr.querySelector('.fb-btn-capture').hidden,
                    retakeVisible: sr.querySelector('.fb-btn-retake').getBoundingClientRect().width > 0,
                    status: window.__fbE2E.statusText()}; }"""
    )
    png_probe.dump("P6 重拍后的面板状态", retake)
    check("P6 重拍产生新的有效 PNG（尺寸不变）", (w2, h2) == (1280, 800) and len(raw2) > 1024, f"{w2}x{h2} {len(raw2)}B")
    check("P6 重拍保留文字与已有截图入口", retake["text"] == text and retake["thumbNatural"] > 0
          and retake["captureHidden"] and retake["retakeVisible"], json.dumps(retake, ensure_ascii=False))
    probe("P6 重拍后 [mask] 区域仍被遮挡", arr2, rects["secret-card"], MASK_RGBA, 3, deps, "P6r")
    png_probe.save(arr2, None, os.path.join(deps["shots_dir"], "P6-manual-retake-client.png"))

    # ---- 5) 提交：手动截图必须随 multipart 上传，且服务端落库字节一致 ----
    res = submit_with_login(page, deps)
    fid = res["fid"]
    check("P6 服务端返回 feedbackId", bool(fid), str(fid))
    check("P6 观察到 1 次 multipart 提交", len(res["posts"]) == 1, str(len(res["posts"])))
    meta = res["posts"][0]["metadata"] or {}
    cap = meta.get("capture") or {}
    png_probe.dump("P6 提交 metadata.capture", cap)
    check("P6 提交原话 == 先写后拍的那段文字", meta.get("text") == text, str(meta.get("text")))
    check("P6 手动截图没有落点（只有拖拽才带 releasePoint）", "releasePoint" not in cap,
          json.dumps(cap, ensure_ascii=False))
    check("P6 capture 的逻辑视口 / 输出像素都是 1280x800",
          [cap.get("viewportWidth"), cap.get("viewportHeight"), cap.get("pixelWidth"), cap.get("pixelHeight")]
          == [1280, 800, 1280, 800], json.dumps(cap, ensure_ascii=False))

    s, detail = deps["api"]("GET", f"/api/admin/feedback/{fid}")
    check("P6 管理端读取详情 200", s == 200, str(s))
    stored = (detail or {}).get("screenshot") or {}
    png_probe.dump("P6 服务端落库 screenshot 元数据", stored)
    check("P6 服务端实测 PNG 尺寸 1280x800",
          [stored.get("width"), stored.get("height")] == [1280, 800], json.dumps(stored, ensure_ascii=False))
    check("P6 服务端记录了捕获时间", bool((stored.get("capture") or {}).get("capturedAt")),
          json.dumps(stored, ensure_ascii=False))

    srv_bytes = deps["api_bytes"](f"/api/admin/feedback/{fid}/screenshot")
    srv_arr = png_probe.decode(srv_bytes)
    png_probe.dump("P6 服务端落库 PNG",
                   {"bytes": len(srv_bytes), "sha256": png_probe.sha256(srv_bytes), "size": list(png_probe.size(srv_arr))})
    check("P6 服务端落库 PNG 与本地预览逐像素一致（重拍后）", same_pixels(srv_arr, arr2), pixel_sha(srv_arr) + " vs " + pixel_sha(arr2))
    png_probe.save(srv_arr, None, os.path.join(deps["shots_dir"], "P6-manual-server.png"))
    visible_probe("P6 服务端 PNG 正常内容", srv_arr, rects["visible-block"], GREEN_RGBA, deps, "P6srv")
    probe("P6 服务端 PNG [mask] 区域", srv_arr, rects["secret-card"], MASK_RGBA, 3, deps, "P6srv")
    probe("P6 服务端 PNG password 区域", srv_arr, rects["pw"], MASK_RGBA, 3, deps, "P6srv")
    srv_mag = png_probe.color_count(srv_arr, MAGENTA_RGBA)
    srv_cyan = png_probe.color_count(srv_arr, CYAN_RGBA)
    check("P6 服务端落库 PNG 里敏感区原色为 0", srv_mag == 0 and srv_cyan == 0,
          f"magenta={srv_mag} cyan={srv_cyan}")

    mine = ai_call_for(deps, "手动截图入口验证")
    check("P6 mock AI 收到本次归档请求", len(mine) == 1, str(len(mine)))
    if deps["shot"]:
        deps["shot"](page, "P6-manual-submitted")
    page.close()


# ---------------- P7：窄屏 + 键盘的手动截图入口 ----------------


def p7_manual_capture_narrow_keyboard(deps):
    step, check = deps["step"], deps["check"]
    step("P7 窄屏(390x844) + 键盘激活：入口可点、无破图占位、焦点不落在隐藏控件")

    page = deps["ctx"].new_page()
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{deps['pages']}/manual.html", wait_until="networkidle")
    check("P7 窄屏：侧边标签可见", page.locator(".fb-fab").is_visible())
    page.locator(".fb-fab").click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=60000)
    page.wait_for_timeout(800)
    st = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const wrap = sr.querySelector('.fb-screenshot-wrap');
            const thumb = sr.querySelector('img.fb-screenshot-thumb');
            const cap = sr.querySelector('.fb-btn-capture');
            const panel = sr.querySelector('.fb-panel');
            const r = cap.getBoundingClientRect();
            const pr = panel.getBoundingClientRect();
            return {wrapDisplay: getComputedStyle(wrap).display,
                    wrapW: Math.round(wrap.getBoundingClientRect().width),
                    thumbSrc: thumb ? thumb.getAttribute('src') : null,
                    thumbNatural: thumb ? thumb.naturalWidth : 0,
                    capText: (cap.textContent || '').trim(),
                    capLeft: Math.round(r.left), capRight: Math.round(r.right), capH: Math.round(r.height),
                    panelW: Math.round(pr.width), panelH: Math.round(pr.height),
                    ariaModal: panel.getAttribute('aria-modal'),
                    vw: innerWidth, vh: innerHeight}; }"""
    )
    png_probe.dump("P7 窄屏打开面板后的截图区状态", st)
    check("P7 窄屏无截图：预览区 display:none 且不占版面（不是空白破图占位）",
          st["wrapDisplay"] == "none" and st["wrapW"] == 0 and st["thumbSrc"] is None and st["thumbNatural"] == 0,
          json.dumps(st, ensure_ascii=False))
    check("P7 窄屏：手动截图按钮可见、文案正确、触屏可点（高 ≥ 32px）",
          st["capText"] == "截取当前页面" and st["capH"] >= 32, json.dumps(st, ensure_ascii=False))
    check("P7 窄屏：按钮不溢出面板与视口",
          0 <= st["capLeft"] and st["capRight"] <= min(st["panelW"], st["vw"]) + 1,
          json.dumps(st, ensure_ascii=False))
    check("P7 窄屏面板是全屏模态（面板宽高 == 视口、aria-modal=true）",
          st["ariaModal"] == "true" and st["panelW"] == st["vw"] and st["panelH"] == st["vh"],
          json.dumps(st, ensure_ascii=False))

    text = "窄屏键盘路径：Enter 激活手动截图"
    page.locator(".fb-textarea").fill(text)
    page.locator(".fb-btn-capture").focus()
    focus_before = page.evaluate("() => window.__fbE2E.active()")
    png_probe.dump("P7 键盘激活前的焦点", focus_before)
    check("P7 键盘焦点确实在手动截图按钮上",
          focus_before.get("found") is True and "fb-btn-capture" in (focus_before.get("cls") or ""),
          json.dumps(focus_before, ensure_ascii=False))

    page.keyboard.press("Enter")
    page.wait_for_function("() => !!window.__fbE2E.thumbSrc()", timeout=60000)
    page.wait_for_timeout(500)
    kb = page.evaluate(
        """() => { const sr = window.__fbE2E.shadow();
            const thumb = sr.querySelector('img.fb-screenshot-thumb');
            return {text: sr.querySelector('.fb-textarea').value, thumbNatural: thumb.naturalWidth,
                    capHidden: sr.querySelector('.fb-btn-capture').hidden,
                    retakeVisible: sr.querySelector('.fb-btn-retake').getBoundingClientRect().width > 0,
                    status: window.__fbE2E.statusText()}; }"""
    )
    raw, arr = client_png(page, deps)
    w, h = png_probe.size(arr)
    png_probe.dump("P7 键盘激活后的状态", kb)
    check("P7 键盘 Enter 激活手动截图 → 有效 PNG 且尺寸 == 窄屏视口 390x844",
          (w, h) == (390, 844) and len(raw) > 512, f"{w}x{h} {len(raw)}B")
    check("P7 键盘路径保留文字并切换入口", kb["text"] == text and kb["thumbNatural"] > 0
          and kb["capHidden"] and kb["retakeVisible"] and "截图未完成" not in (kb["status"] or ""),
          json.dumps(kb, ensure_ascii=False))
    png_probe.save(arr, None, os.path.join(deps["shots_dir"], "P7-narrow-keyboard-client.png"))

    focus_after = page.evaluate("() => window.__fbE2E.active()")
    png_probe.dump("P7 截图后的焦点", focus_after)
    check("P7 截图后焦点仍在面板内、不落在隐藏或禁用控件上（不会掉到 body）",
          focus_after.get("found") is True and focus_after.get("unreachable") is False
          and focus_after.get("disabled") is False,
          json.dumps(focus_after, ensure_ascii=False))
    check("P7 截图中不含组件强调色像素（面板不在图里）",
          png_probe.color_count(arr, ACCENT_RGBA) == 0,
          str(png_probe.color_count(arr, ACCENT_RGBA)))
    if deps["shot"]:
        deps["shot"](page, "P7-narrow-keyboard")
    page.close()


# ---------------- 入口 ----------------


def run(deps):
    deps.setdefault("pixel_results", [])
    paths = [
        ("P1 灵感球拖动路径", p1_orb_drag),
        ("P2 遮罩像素路径", p2_mask_pixels),
        ("P3 遮挡失败规则路径", p3_mask_failure),
        ("P4 登录握手路径", p4_login_handshake),
        ("P6 默认 off 模式手动截图路径", p6_manual_capture),
        ("P7 窄屏 + 键盘手动截图路径", p7_manual_capture_narrow_keyboard),
    ]
    for name, fn in paths:
        try:
            fn(deps)
        except Exception as exc:  # 单条路径失败不掩盖其余路径
            deps["record"](f"{name}：后续断言未执行（{str(exc)[:180]}）", False, "路径中断")
        time.sleep(0.3)
