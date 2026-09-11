#!/usr/bin/env python3
"""
T7 日志端到端取证路径（由 e2e/run_browser.py 在既有 T1–T10/P1–P7 之后调用）。

覆盖「截图 + 描述 + 日志」的真实浏览器链路与三态归档判定：
  L1 全链路：自动采集 → 手动补充 → 预览 → 移除 → 关闭重开保留草稿 →
              multipart 提交 → 服务端落库 → 管理端下载（**字节摘要与提交字节一致**）
  L2 采集失败/超时/超限：提示清楚、仍可不带日志提交、迟到结果不污染新草稿
  L3 断网重试：只产生一条反馈（同 key 同字节），改附件后换新 key 作为新提交
  L4 已知错误日志：AI 请求体确实含预期片段；超长文件被标注截取；
             管理端/Kaneo 描述展示诊断且区分证据与推测；Kaneo 侧字节摘要一致
  L5 『截图完成但日志未完成』：状态不是 archived（真实构造），未完成时不显示
             「全部归档完成」；成功附件不重复归档；not_started 两种来源分开取证
  L6 管理页真实浏览器回归：日志数量/逐份属性/预览/下载响应头/诊断分块/状态诚实性

所有断言都取自真实浏览器 + 真实 :8787 服务 + mock 外部服务的**真实收到的请求**，
不使用任何模拟的服务端结果。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.request

AI_BASE = "http://127.0.0.1:8899"
KANEO_BASE = "http://127.0.0.1:8898"


# ---------------- 基础工具 ----------------


def post_json(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST", headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def get_json(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())


def reset_mocks():
    post_json(f"{KANEO_BASE}/__mock/reset", {})
    post_json(f"{AI_BASE}/__mock/state", {"aiFail": False})
    post_json(f"{KANEO_BASE}/__mock/state", {"publicBase": "http://127.0.0.1:8898"})


def kaneo_state():
    return get_json(f"{KANEO_BASE}/__mock/state")


def kaneo_tasks():
    return get_json(f"{KANEO_BASE}/__mock/tasks")["tasks"]


def ai_last():
    return get_json(f"{AI_BASE}/__mock/ai-last")["last"]


def ai_calls():
    return get_json(f"{AI_BASE}/__mock/ai-calls")


def inject_fail(**kw):
    return post_json(f"{KANEO_BASE}/__mock/fail", kw)


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parts_in_order(body: bytes | None, ct: str) -> list[dict]:
    """按 multipart 出现顺序解析部件（不丢同名重复部件，保序 —— seq 断言依赖它）。"""
    m = re.search(r'boundary="?([^";,]+)"?', ct or "")
    if not m or not body:
        return []
    boundary = b"--" + m.group(1).encode()
    out = []
    for chunk in body.split(boundary):
        if b"\r\n\r\n" not in chunk:
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        nm = re.search(rb'name="([^"]*)"', head)
        if not nm:
            continue
        fn = re.search(rb'filename="([^"]*)"', head)
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        if payload == b"":
            continue  # 收尾 boundary
        out.append(
            {
                "name": nm.group(1).decode(),
                "filename": fn.group(1).decode() if fn else None,
                "bytes": payload,
            }
        )
    return out


def meta_of(entry: dict) -> dict | None:
    for p in parts_in_order(entry.get("body"), entry.get("ct")):
        if p["name"] == "metadata":
            try:
                return json.loads(p["bytes"].decode())
            except Exception:
                return None
    return None


def log_parts(entry: dict) -> list[dict]:
    return [p for p in parts_in_order(entry.get("body"), entry.get("ct")) if p["name"] == "logs"]


def request_body(req):
    try:
        v = req.post_data_buffer
        return v() if callable(v) else v
    except Exception:
        return None


class SubmitTap:
    """页面级提交观测器：记录真实 multipart 请求体，可按需中断一次（断网重试用例）。"""

    def __init__(self, page, abort_first=False):
        self.entries: list[dict] = []
        self.aborts = 0
        self.abort_next = abort_first
        page.route("**/api/feedback", self._handle)

    @staticmethod
    def _is_submit(url: str) -> bool:
        return bool(re.search(r"/api/feedback/?$", url))

    def _handle(self, route):
        req = route.request
        if req.method == "POST" and self._is_submit(req.url):
            self.entries.append(
                {
                    "ct": req.headers.get("content-type", ""),
                    "body": request_body(req),
                }
            )
            if self.abort_next:
                self.abort_next = False
                self.aborts += 1
                route.abort("connectionfailed")
                return
        route.continue_()

    def last(self) -> dict:
        return self.entries[-1]


# ---------------- 管理端 / DB 读取 ----------------


def admin_list(deps) -> list[dict]:
    status, data = deps["api"]("GET", "/api/admin/feedback")
    assert status == 200, f"admin 列表 {status}"
    return (data or {}).get("items") or []


def admin_detail(deps, fid: str):
    status, data = deps["api"]("GET", f"/api/admin/feedback/{fid}")
    return status, (data or {})


def admin_logs_api(deps, fid: str):
    status, data = deps["api"]("GET", f"/api/admin/feedback/{fid}/logs")
    return status, (data or {})


def newest_feedback(deps, exclude_ids=()) -> dict | None:
    items = [it for it in admin_list(deps) if it.get("id") not in exclude_ids]
    if not items:
        return None
    return max(items, key=lambda it: str(it.get("createdAt") or ""))


def wait_status(deps, fid: str, wanted: set[str], timeout=120) -> dict:
    """轮询管理接口直到反馈进入终态（避免用客户端乐观状态当事实）。"""
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        status, data = admin_detail(deps, fid)
        last = data
        st = data.get("status")
        if st in wanted:
            return data
        time.sleep(0.4)
    raise AssertionError(f"等待状态 {wanted} 超时，最后状态={last.get('status')}（{last}）")


def db_path(deps) -> str:
    return os.path.join(deps["data_dir"], "feedback.db")


def db_query(deps, sql, args=()):
    con = sqlite3.connect(f"file:{db_path(deps)}?mode=ro", uri=True, timeout=10)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def db_exec(deps, sql, args=()):
    con = sqlite3.connect(db_path(deps), timeout=10)
    try:
        con.execute(sql, args)
        con.commit()
    finally:
        con.close()


# ---------------- 浏览器动作 ----------------


def new_logs_page(deps, *, plan=None, mode=None, delay_ms=None):
    page = deps["ctx"].new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(f"{deps['pages']}/logs.html", wait_until="networkidle")
    patch = {}
    if mode is not None:
        patch["mode"] = mode
    if delay_ms is not None:
        patch["delayMs"] = delay_ms
    if plan is not None:
        patch["plan"] = list(plan)
    if patch:
        page.evaluate("(p) => window.__fbE2E.setKnobs(p)", patch)
    return page


def open_panel(page, timeout=60000):
    page.locator(".fb-fab").click()
    page.locator(".fb-panel").wait_for(state="visible", timeout=timeout)


def wait_log_count(page, n, timeout=30000):
    page.wait_for_function(
        "(n) => document.querySelector('feedback-widget').shadowRoot.querySelectorAll('.fb-log-item').length === n",
        arg=n,
        timeout=timeout,
    )


def shadow_text(page, selector):
    return page.evaluate("(sel) => { const e = document.querySelector('feedback-widget').shadowRoot.querySelector(sel);"
                         " return e ? e.textContent : null; }", selector)


def submit_panel(page, deps, timeout=60000):
    """点提交；未登录时组件会弹登录窗 —— 真实完成登录（cookie 已在则为静默握手）。"""
    popup = None
    try:
        with deps["ctx"].expect_page(timeout=4000) as pi:
            page.locator(".fb-submit").click()
        popup = pi.value
    except Exception:
        # 静默握手：无弹窗，请求已发出
        return False
    popup.wait_for_load_state()
    form = popup.locator("#login-form")
    used_form = False
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if form.is_visible():
                used_form = True
                break
            if popup.is_closed():
                break
        except Exception:
            break
        time.sleep(0.15)
    if used_form:
        popup.locator("#username").fill(deps["admin_user"])
        popup.locator("#password").fill(deps["admin_pass"])
        popup.locator("#submit").click()
    try:
        popup.wait_for_event("close", timeout=30000)
    except Exception:
        pass
    return used_form


def wait_widget_settled(page, timeout=120):
    """等组件的提交/轮询周期结束（出现归档链接或失败卡片）。"""
    page.wait_for_function(
        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
        " return !!sr.querySelector('.fb-task-link') || !!sr.querySelector('.fb-status-card'); }",
        timeout=timeout,
    )


def write_tmp_log(path, content_bytes):
    with open(path, "wb") as f:
        f.write(content_bytes)
    return path


# ---------------- L1 全链路 ----------------


def l1_full_chain(deps):
    step, check = deps["step"], deps["check"]
    step("L1 全链路：自动日志 + 手动补充 + 预览 + 移除 + 重开保留 + 提交 + 管理端下载一致")
    reset_mocks()
    before_ids = {it["id"] for it in admin_list(deps)}

    manual_bytes = "MANUAL-LOG-UNIT-1\nmanual line two\n".encode()
    manual_path = write_tmp_log("/tmp/fb-e2e-manual.log", manual_bytes)
    page = new_logs_page(deps, plan=["ok"])
    tap = SubmitTap(page)
    open_panel(page)

    # 1) 自动采集：logProvider 返回 1 份 app.log
    wait_log_count(page, 1)
    auto = page.evaluate("() => window.__fbE2E.logs()")
    check("L1 打开面板后自动出现 1 份日志（logProvider 真实被调用）", len(auto) == 1 and auto[0]["name"] == "app.log",
          json.dumps(auto, ensure_ascii=False))
    check("L1 自动日志标记来源=自动采集", "自动" in auto[0]["source"], json.dumps(auto[0], ensure_ascii=False))

    # 2) 手动补充一份（真实磁盘文件经 input[type=file]）
    page.locator(".fb-logs-area input[type=file]").set_input_files(manual_path)
    wait_log_count(page, 2)
    both = page.evaluate("() => window.__fbE2E.logs()")
    check("L1 手动补充后 2 份日志且第二份标记来源=手动补充",
          len(both) == 2 and "手动" in both[1]["source"] and both[1]["name"] == "fb-e2e-manual.log",
          json.dumps(both, ensure_ascii=False))

    # 3) 预览手动那份：内容必须与磁盘字节逐字一致
    page.evaluate("() => window.__fbE2E.clickItemAction('fb-e2e-manual.log', 'preview')")
    page.wait_for_function(
        "() => document.querySelector('feedback-widget').shadowRoot"
        ".querySelector('.fb-log-preview-modal')?.classList.contains('is-open')", timeout=10000
    )
    preview_text = page.evaluate("() => window.__fbE2E.previewText()")
    check("L1 预览内容与磁盘文件逐字一致（纯文本、无 innerHTML）", preview_text == manual_bytes.decode(),
          repr(preview_text))
    page.evaluate("() => document.querySelector('feedback-widget').shadowRoot"
                  ".querySelector('.fb-log-preview-close').click()")

    # 4) 移除手动那份 → 回到 1 份
    page.evaluate("() => window.__fbE2E.clickItemAction('fb-e2e-manual.log', 'remove')")
    wait_log_count(page, 1)

    # 5) 关闭重开：草稿（文字 + 日志）保留
    text = "L1 全链路：导出 CSV 卡住，附运行日志"
    page.locator(".fb-textarea").fill(text)
    page.keyboard.press("Escape")
    page.locator(".fb-panel").wait_for(state="hidden", timeout=5000)
    open_panel(page)
    page.wait_for_timeout(300)
    after = page.evaluate("() => window.__fbE2E.logs()")
    check("L1 关闭重开后草稿保留：文字与 1 份日志都在",
          page.locator(".fb-textarea").input_value() == text and len(after) == 1 and after[0]["name"] == "app.log",
          json.dumps(after, ensure_ascii=False))

    # 6) 提交（登录弹窗 → 真实提交）
    opened_form = submit_panel(page, deps)
    check("L1 首次提交走真实登录弹窗（未登录 → 登录并提交）", opened_form is True, str(opened_form))
    wait_widget_settled(page)
    fb = newest_feedback(deps, exclude_ids=before_ids)
    check("L1 服务端新建了 1 条反馈", fb is not None and fb["id"] not in before_ids,
          json.dumps(fb or {}, ensure_ascii=False))
    fid = fb["id"]

    detail = wait_status(deps, fid, {"archived", "needs_review", "failed"})
    check("L1 反馈最终归档（archived）", detail.get("status") == "archived", str(detail.get("status")))
    check("L1 管理列表 logCount=1", fb.get("logCount") == 1, str(fb.get("logCount")))

    # 7) 提交体：multipart + metadata.logs + 1 个 logs 部件，字节摘要记下来
    entry = tap.last()
    meta = meta_of(entry)
    lparts = log_parts(entry)
    check("L1 提交为 multipart 且 metadata.logs 长度为 1",
          entry["ct"].startswith("multipart/form-data") and isinstance(meta, dict)
          and isinstance(meta.get("logs"), list) and len(meta["logs"]) == 1,
          json.dumps(meta, ensure_ascii=False)[:400])
    check("L1 请求体里有 1 个 logs 部件（文件名与 metadata 对应）",
          len(lparts) == 1 and lparts[0]["filename"] == "app.log",
          json.dumps([p["filename"] for p in lparts], ensure_ascii=False))
    submitted_bytes = lparts[0]["bytes"]
    # 契约 L2：metadata.logs[i] 只带 {name, source}（sha256 由服务端按实际字节计算，
    # 客户端不得自述摘要）—— 这里按契约断言字段集合，再用下面的服务端 LogMeta 做摘要核对。
    check("L1 metadata.logs[0] 字段集合严格为 {name, source}（契约 L2）",
          set(meta["logs"][0].keys()) == {"name", "source"}
          and meta["logs"][0]["name"] == "app.log" and meta["logs"][0]["source"] == "auto",
          json.dumps(meta["logs"][0], ensure_ascii=False))

    # 8) 管理端逐份元数据 + 下载字节摘要与提交字节一致
    status, logs_resp = admin_logs_api(deps, fid)
    check("L1 GET /api/admin/feedback/:id/logs → 200 且 seq 升序",
          status == 200 and [l["seq"] for l in logs_resp.get("logs", [])] == [0],
          json.dumps(logs_resp.get("logs"), ensure_ascii=False)[:400])
    logmeta = logs_resp["logs"][0]
    check("L1 LogMeta.sha256/byteSize 与提交字节一致",
          logmeta["sha256"] == sha256_hex(submitted_bytes) and logmeta["byteSize"] == len(submitted_bytes),
          json.dumps(logmeta, ensure_ascii=False))
    check("L1 LogMeta 三字段齐备且自洽（truncated/totalCodepoints/archiveState）",
          logmeta.get("truncated") is False and isinstance(logmeta.get("totalCodepoints"), int)
          and logmeta.get("archiveState") == "confirmed",
          json.dumps(logmeta, ensure_ascii=False))
    dl = deps["api_bytes"](f"/api/admin/feedback/{fid}/logs/{logmeta['id']}?download=1")
    check("L1 管理端下载字节摘要 == 提交字节摘要（端到端一致）",
          sha256_hex(dl) == sha256_hex(submitted_bytes) and len(dl) == len(submitted_bytes),
          f"downloaded={len(dl)}B/{sha256_hex(dl)[:16]} submitted={len(submitted_bytes)}B/{sha256_hex(submitted_bytes)[:16]}")
    check("L1 下载字节就是日志原文（含 canary 行）", b"E2E-LOG-CANARY-7f3a91" in dl, str(dl[:80]))

    if deps["shot"]:
        deps["shot"](page, "L1-full-chain")
    page.close()


# ---------------- L2 失败 / 超时 / 超限 / 迟到 ----------------


def l2_fail_timeout_oversize_stale(deps):
    step, check = deps["step"], deps["check"]
    step("L2 采集失败/超时/超限：提示清楚、仍可不带日志提交、迟到结果不污染新草稿")
    reset_mocks()

    # (a) 超时：3 秒后给出明确提示 + 可重试
    page = new_logs_page(deps, plan=["timeout"])
    open_panel(page)
    page.wait_for_function(
        "() => { const e = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-log-status');"
        " return !!e && !e.hidden && e.textContent.includes('超时'); }", timeout=15000
    )
    status_txt = shadow_text(page, ".fb-log-status")
    check("L2 超时提示明确（含「超时 3 秒」）", "超时" in (status_txt or "") and "3" in (status_txt or ""), repr(status_txt))
    check("L2 超时后提供重试入口（.fb-log-retry-btn）", page.locator(".fb-log-retry-btn").count() == 1,
          str(page.locator(".fb-log-retry-btn").count()))
    # 仍可不带日志提交
    text = "L2 日志采集超时仍可提交"
    page.locator(".fb-textarea").fill(text)
    submit_panel(page, deps)
    wait_widget_settled(page)
    fb_timeout = newest_feedback(deps)
    detail = wait_status(deps, fb_timeout["id"], {"archived", "needs_review", "failed"})
    check("L2 超时分支：不带日志也能真实提交并落库（logCount=0）",
          fb_timeout.get("logCount") == 0 and detail.get("status") == "archived",
          f"logCount={fb_timeout.get('logCount')} status={detail.get('status')}")
    page.close()

    # (b) 采集失败：明确报错
    page = new_logs_page(deps, plan=["fail"])
    open_panel(page)
    page.wait_for_function(
        "() => { const e = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-log-error');"
        " const s = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-log-status');"
        " return (!!e && !e.hidden && e.textContent.length > 0) || (!!s && !s.hidden && s.textContent.includes('失败')); }",
        timeout=15000,
    )
    err_txt = shadow_text(page, ".fb-log-error") or shadow_text(page, ".fb-log-status")
    check("L2 采集失败提示清楚（含「日志获取失败」）", "失败" in (err_txt or ""), repr(err_txt))
    page.close()

    # (c) 文件超限：1.5MiB > 单文件 1MiB → 拒绝并提示，草稿里不得出现该文件
    page = new_logs_page(deps, plan=["empty"])
    open_panel(page)
    huge = write_tmp_log("/tmp/fb-e2e-huge.log", b"x" * (1024 * 1024 + 512 * 1024))
    page.locator(".fb-logs-area input[type=file]").set_input_files(huge)
    page.wait_for_function(
        "() => { const e = document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-log-error');"
        " return !!e && !e.hidden && e.textContent.length > 0; }", timeout=15000
    )
    lim_txt = shadow_text(page, ".fb-log-error")
    check("L2 超限提示明确（含 1MiB 上限）", "1MiB" in (lim_txt or "") or "上限" in (lim_txt or ""), repr(lim_txt))
    check("L2 超限文件没有被加进草稿", page.evaluate("() => window.__fbE2E.logs().length") == 0,
          str(page.evaluate("() => window.__fbE2E.logs()")))
    if deps["shot"]:
        deps["shot"](page, "L2-oversize")
    page.close()

    # (d) 迟到结果不得污染新草稿
    page = new_logs_page(deps, plan=["late", "ok"], delay_ms=8000)
    open_panel(page)
    page.wait_for_timeout(400)
    check("L2 迟到场景：第一次 logProvider 调用已发出（尚未返回）",
          page.evaluate("() => window.__fbE2E.knobs().calls") == 1,
          str(page.evaluate("() => window.__fbE2E.knobs()")))
    text2 = "L2 迟到结果隔离：先提交一条不带日志的"
    page.locator(".fb-textarea").fill(text2)
    submit_panel(page, deps)
    wait_widget_settled(page)
    fb_late = newest_feedback(deps)
    check("L2 迟到场景第一条：不带日志提交成功（logCount=0）", fb_late.get("logCount") == 0, str(fb_late.get("logCount")))
    # 再记一条 → 新草稿；关掉面板再打开 → 组件按"每份新草稿首次打开面板时调用一次"
    # 触发第二次采集（provider 队列里第二项是 ok → app.log）
    page.locator("button:has-text('再记一条')").last.click()
    page.wait_for_timeout(400)
    check("L2 再记一条后草稿已清空（新草稿，日志区不残留上一份的日志）",
          page.evaluate("() => window.__fbE2E.logs().length") == 0,
          json.dumps(page.evaluate("() => window.__fbE2E.logs()"), ensure_ascii=False))
    page.keyboard.press("Escape")
    page.locator(".fb-panel").wait_for(state="hidden", timeout=5000)
    open_panel(page)
    wait_log_count(page, 1, timeout=20000)
    new_draft = page.evaluate("() => window.__fbE2E.logs()")
    check("L2 新草稿只拿到第二次调用的 app.log", len(new_draft) == 1 and new_draft[0]["name"] == "app.log",
          json.dumps(new_draft, ensure_ascii=False))
    # 等迟到 promise（8s）落地，再确认没有 late.log 混进新草稿
    page.wait_for_timeout(6000)
    stale = page.evaluate("() => window.__fbE2E.logs()")
    check("L2 迟到结果落回后新草稿仍是 1 份 app.log（旧请求结果不污染新草稿）",
          len(stale) == 1 and stale[0]["name"] == "app.log"
          and "late.log" not in json.dumps(stale, ensure_ascii=False),
          json.dumps(stale, ensure_ascii=False))
    check("L2 每次新草稿只触发一次采集（共 2 次 provider 调用）",
          page.evaluate("() => window.__fbE2E.knobs().calls") == 2,
          str(page.evaluate("() => window.__fbE2E.knobs().records")))
    page.close()


# ---------------- L3 断网重试与幂等键 ----------------


def l3_offline_retry_idempotency(deps):
    step, check = deps["step"], deps["check"]
    step("L3 断网重试只产生一条反馈；改附件后换新 key 作为新提交")
    reset_mocks()
    page = new_logs_page(deps, plan=["ok"])
    tap = SubmitTap(page, abort_first=True)
    open_panel(page)
    wait_log_count(page, 1)

    ids_before = {it["id"] for it in admin_list(deps)}
    page.locator(".fb-textarea").fill("L3 断网重试与幂等键")
    submit_panel(page, deps)
    page.wait_for_function(
        "() => { const sr = document.querySelector('feedback-widget').shadowRoot;"
        " const c = sr.querySelector('.fb-status-card');"
        " return !!c && (c.textContent.includes('未到达') || c.textContent.includes('失败') || c.textContent.includes('重试')); }",
        timeout=60000,
    )
    check("L3 网络失败被真实制造（浏览器侧中断 1 次提交）", tap.aborts == 1, str(tap.aborts))
    ids_after_fail = {it["id"] for it in admin_list(deps)}
    check("L3 提交未到达服务：服务端没有新建反馈", ids_after_fail == ids_before, str(len(ids_after_fail - ids_before)))
    first_key = meta_of(tap.entries[0]).get("idempotencyKey")
    check("L3 第一次提交带幂等键", isinstance(first_key, str) and len(first_key) > 8, repr(first_key))

    # 重试：同 key 同字节
    page.locator(".fb-retry").click()
    page.wait_for_function(
        "() => !!document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-task-link')", timeout=120000
    )
    retry_entry = tap.last()
    retry_key = meta_of(retry_entry).get("idempotencyKey")
    check("L3 重试复用同一个幂等键（同草稿同字节）", retry_key == first_key, f"{first_key} vs {retry_key}")
    check("L3 重试的日志字节与首次一致",
          [p["bytes"] for p in log_parts(retry_entry)] == [p["bytes"] for p in log_parts(tap.entries[0])],
          "log parts differ")
    ids_after_retry = {it["id"] for it in admin_list(deps)}
    check("L3 重试后服务端只多 1 条反馈（不重复创建）", len(ids_after_retry - ids_before) == 1,
          str(ids_after_retry - ids_before))

    # 改附件 → 新 key → 新提交
    fb1 = newest_feedback(deps)
    wait_status(deps, fb1["id"], {"archived", "needs_review", "failed"})
    page.locator("button:has-text('再记一条')").last.click()
    page.wait_for_timeout(400)
    # 新草稿：关掉面板再打开 → 组件按"每份新草稿首次打开面板时调用一次"重新采集
    page.keyboard.press("Escape")
    page.locator(".fb-panel").wait_for(state="hidden", timeout=5000)
    open_panel(page)
    wait_log_count(page, 1, timeout=20000)
    page.locator(".fb-textarea").fill("L3 改附件后作为新提交")
    extra = write_tmp_log("/tmp/fb-e2e-l3-extra.log", b"L3-EXTRA-LOG\n")
    page.locator(".fb-logs-area input[type=file]").set_input_files(extra)
    wait_log_count(page, 2, timeout=15000)
    submit_panel(page, deps)
    wait_widget_settled(page)
    second_entry = tap.last()
    second_key = meta_of(second_entry).get("idempotencyKey")
    check("L3 改附件后使用新的幂等键", isinstance(second_key, str) and second_key != first_key,
          f"{first_key} vs {second_key}")
    ids_after_second = {it["id"] for it in admin_list(deps)}
    check("L3 新提交确实新建了第二条反馈", len(ids_after_second - ids_before) == 2, str(len(ids_after_second - ids_before)))
    fb2 = newest_feedback(deps)
    wait_status(deps, fb2["id"], {"archived", "needs_review", "failed"})
    page.close()
    return {"first_key": first_key, "second_key": second_key, "fb1": fb1["id"], "fb2": fb2["id"]}


# ---------------- L4 已知错误日志 / AI / Kaneo 诊断 ----------------


def l4_ai_logs_and_kaneo(deps):
    step, check = deps["step"], deps["check"]
    step("L4 已知错误日志：AI 请求含预期片段；超长截取；诊断区分证据/推测；Kaneo 字节摘要一致")
    reset_mocks()
    page = new_logs_page(deps, plan=["ok"])
    tap = SubmitTap(page)
    open_panel(page)
    wait_log_count(page, 1)
    text = "L4 已知错误日志：导出 CSV 报错"
    page.locator(".fb-textarea").fill(text)
    submit_panel(page, deps)
    wait_widget_settled(page)
    fb = newest_feedback(deps)
    detail = wait_status(deps, fb["id"], {"archived", "needs_review", "failed"})
    fid = fb["id"]
    check("L4 带错误日志的反馈归档成功", detail.get("status") == "archived", str(detail.get("status")))

    # 1) AI 请求体（mock 真实收到）包含预期日志片段
    last = ai_last()
    body_text = (last or {}).get("userText") or ""
    check("L4 AI 请求体确实包含日志 canary 片段", "E2E-LOG-CANARY-7f3a91" in body_text, body_text[-400:])
    check("L4 AI 请求体带日志头部（文件名/来源/seq 结构）",
          "文件名=app.log" in body_text and "来源=auto" in body_text and "seq=0" in body_text,
          body_text[:400])
    check("L4 AI 请求体仍包含用户原话", text in body_text, body_text[:200])

    # 2) 服务端解析出的 diagnostics：证据 vs 推测分字段
    # 注意：GET /feedback/:id/logs 只返回 {logs}；diagnostics 由详情 processed.diagnostics 暴露
    status, detail_l4 = admin_detail(deps, fid)
    diag = ((detail_l4.get("processed") or {}).get("diagnostics")) or {}
    ev = diag.get("logEvidence") or []
    ca = diag.get("possibleCauses") or []
    check("L4 管理接口返回 diagnostics 且证据/推测分字段",
          len(ev) >= 1 and len(ca) >= 1 and isinstance(ev[0].get("seq"), int),
          json.dumps(diag, ensure_ascii=False)[:400])
    check("L4 证据是日志原文逐字摘录（含 canary）", "E2E-LOG-CANARY-7f3a91" in (ev[0].get("quote") or ""),
          json.dumps(ev[:1], ensure_ascii=False)[:300])
    check("L4 推测带 confidence 且不是证据字段", ca[0].get("confidence") in ("low", "medium") and "hypothesis" in ca[0],
          json.dumps(ca[:1], ensure_ascii=False)[:300])

    # 3) Kaneo 描述展示诊断内容（区分证据/推测）
    tasks = kaneo_tasks()
    check("L4 Kaneo 收到 1 个任务", len(tasks) == 1, str(len(tasks)))
    desc = tasks[0].get("description") or ""
    check("L4 Kaneo 描述含用户原话与反馈 ID 标记", text in desc and "反馈ID" in desc, desc[:300])
    check("L4 Kaneo 描述含日志证据摘录（canary）", "E2E-LOG-CANARY-7f3a91" in desc, desc[-500:])
    check("L4 Kaneo 描述把推测单独标注（未证实/可能原因）",
          ("可能原因" in desc or "推测" in desc) and ("未证实" in desc or "hypothesis" in desc.lower()),
          desc[-500:])

    # 4) Kaneo 侧附件字节摘要 == 提交字节摘要（日志 + 截图都查）
    st = kaneo_state()
    entry = tap.last()
    presigns = st.get("presigns") or []
    put_attempts = {p["key"]: p for p in (st.get("putAttempts") or []) if p.get("stored")}
    check("L4 Kaneo 侧发生上传（有成功的 PUT 记录）", len(put_attempts) >= 2, str(list(put_attempts)))
    submitted = {p["bytes"] for p in log_parts(entry)}
    log_digests = {sha256_hex(p["bytes"]) for p in log_parts(entry)}
    matched = [k for k, v in put_attempts.items() if v.get("sha256") in log_digests and v.get("bytes") in {len(b) for b in submitted}]
    check("L4 Kaneo 侧存在与日志提交字节摘要一致的资产", len(matched) >= 1,
          json.dumps({"logDigests": sorted(log_digests), "put": {k: v.get("sha256") for k, v in put_attempts.items()}}, ensure_ascii=False))
    check("L4 该资产可以通过 Kaneo mock 下载回真实字节", all(k in (st.get("assetKeys") or []) for k in matched), str(matched))

    # 5) 超长文件被标注截取（9000 码点 > 8000）
    page2 = new_logs_page(deps, plan=["big"])
    tap2 = SubmitTap(page2)
    open_panel(page2)
    wait_log_count(page2, 1)
    page2.locator(".fb-textarea").fill("L4 超长日志截取标注")
    submit_panel(page2, deps)
    wait_widget_settled(page2)
    fb3 = newest_feedback(deps)
    wait_status(deps, fb3["id"], {"archived", "needs_review", "failed"})
    status, logs3 = admin_logs_api(deps, fb3["id"])
    lm = (logs3.get("logs") or [{}])[0]
    expect_cp = page2.evaluate("() => window.__logExpect.bigCodepoints")
    check(f"L4 超长日志被标 truncated=true 且 totalCodepoints=={expect_cp}（码点，不是字节）",
          lm.get("truncated") is True and lm.get("totalCodepoints") == expect_cp and expect_cp > 8000,
          json.dumps(lm, ensure_ascii=False))
    ai3 = ai_last()
    body3 = (ai3 or {}).get("userText") or ""
    check("L4 AI 请求体带「已截取」标注与原始长度", "已截取" in body3 and str(expect_cp) in body3, body3[-500:])
    run_len = max((len(m) for m in re.findall(r"x+", body3)), default=0)
    check("L4 AI 只收到末尾 8000 码点：尾部标记可见、头部标记不可见、x 串长度 ≈8000",
          "TAIL-MARKER-9000-END" in body3 and "HEAD-MARKER-SHOULD-BE-DROPPED" not in body3
          and 7900 <= run_len <= 8100,
          f"tail={'TAIL-MARKER-9000-END' in body3} head={'HEAD-MARKER-SHOULD-BE-DROPPED' in body3} run={run_len}")
    if deps["shot"]:
        deps["shot"](page2, "L4-truncated")
    page.close()
    page2.close()


# ---------------- L5 三态归档判定（最关键） ----------------


def _make_partial(deps, mode: str):
    """真实构造『截图 confirmed + 日志 seq=0 partial』。

    归档顺序是先截图后日志（mock comment 依次为：截图 #1、日志 seq=0 #2、seq=1 #3）。
    注入 `skip:1` → 第 1 次评论放行（截图成功确认），第 2 次评论（日志 seq=0）按 mode 失败。
    """
    reset_mocks()
    inject_fail(stage="comment", mode=mode, once=True, skip=1)
    page = new_logs_page(deps, plan=["multi"])
    tap = SubmitTap(page)
    open_panel(page)
    wait_log_count(page, 2)
    page.locator(".fb-textarea").fill(f"L5 部分归档（{mode}）：截图成功、某份日志未完成")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=180)
    fb = newest_feedback(deps)
    detail = wait_status(deps, fb["id"], {"archived", "needs_review", "failed"}, timeout=180)
    return page, tap, fb, detail


def _assert_partial_per_log(deps, fid, check, label):
    """逐份进度 + DB 事实：必须是真实 partial（V2 有记录、无 comment），不是 not_started。"""
    status, logs_resp = admin_logs_api(deps, fid)
    logs = logs_resp.get("logs") or []
    states = {l["seq"]: l.get("archiveState") for l in logs}
    # 真实管道语义（本次实测）：日志按 seq 升序处理，第一份失败即停止 → 后续份保持 not_started。
    # 因此断言「失败那份=partial、后续份未被误标为 confirmed」，而不是假设后续份已完成。
    check(f"{label} 逐份 archiveState：失败份 partial、未处理份不得显示 confirmed（不是一刀切）",
          states.get(0) == "partial" and states.get(1) in ("not_started", "partial") and states.get(1) != "confirmed",
          json.dumps({"states": states, "logs": logs}, ensure_ascii=False)[:500])
    rows = db_query(deps, "SELECT status, archive_stage, archive_data_json FROM feedbacks WHERE id=?", (fid,))
    check(f"{label} DB 里 status 不是 archived 且 archive_stage 不是 complete",
          bool(rows) and rows[0][0] != "archived" and rows[0][1] != "complete", str(rows[:1])[:200])
    data = json.loads(rows[0][2]) if rows and rows[0][2] else {}
    logs_v2 = (data or {}).get("logs") or {}
    partial_log = logs[0]["id"]
    rec = logs_v2.get(partial_log) or {}
    outcome = (rec.get("comment") or {}).get("outcome")
    check(f"{label} V2 里 seq=0 的 logId 有记录但 comment 未确认（partial 的真实来源；实测 outcome={outcome}）",
          partial_log in logs_v2 and outcome != "confirmed",
          json.dumps({partial_log: rec}, ensure_ascii=False)[:400])
    deps.setdefault("_observations", []).append(f"{label} 失败份 comment.outcome={outcome}；upload.outcome={(rec.get('upload') or {}).get('outcome')}")
    # 本地字节不因未完成而丢失
    for l in logs:
        raw = deps["api_bytes"](f"/api/admin/feedback/{fid}/logs/{l['id']}?download=1")
        check(f"{label} 未完成状态下 seq={l['seq']} 本地文件仍可下载且摘要一致",
              sha256_hex(raw) == l["sha256"], f"{sha256_hex(raw)[:16]} vs {l['sha256'][:16]}")
    return logs


def _retry_without_rearchive(deps, fid, check, label, *, endpoint="retry", log_id=None, revision=None):
    """补齐未完成的那份：已确认的附件不得重新上传/重复归档。

    endpoint="retry"（failed 状态）或 "recover"（needs_review + 逐份 retry_comment，L10 可选 logId）。
    """
    before = kaneo_state()
    before_keys = {p["key"] for p in (before.get("presigns") or [])}
    # 已上传成功过字节的 key（retry 前）——这些绝不能再次上传/再次申请地址
    before_uploaded = {p["key"]: p for p in (before.get("putAttempts") or []) if p.get("stored")}
    before_puts_total = len(before.get("putAttempts") or [])
    before_puts_per_key = {}
    for p in (before.get("putAttempts") or []):
        before_puts_per_key[p["key"]] = before_puts_per_key.get(p["key"], 0) + 1
    if endpoint == "retry":
        st_code, body = deps["api"]("POST", f"/api/feedback/{fid}/retry", {})
        op_name = "retry"
    else:
        payload = {"action": "retry_comment", "expectedRevision": revision}
        if log_id:
            payload["logId"] = log_id
        st_code, body = deps["api"]("POST", f"/api/feedback/{fid}/recover", payload)
        op_name = f"recover(retry_comment, logId={str(log_id)[:8]}…)" if log_id else "recover(retry_comment)"
    check(f"{label} {op_name} 返回 2xx（真实调用）", 200 <= st_code < 300,
          f"{st_code} {json.dumps(body, ensure_ascii=False)[:300]}")
    try:
        detail2 = wait_status(deps, fid, {"archived"}, timeout=180)
    except AssertionError as exc:
        check(f"{label} {op_name} 后补齐并归档", False, str(exc)[:200])
        detail2 = admin_detail(deps, fid)[1]
    after = kaneo_state()
    after_keys = {p["key"] for p in (after.get("presigns") or [])}
    keynames = after.get("keyFilenames") or {}
    new_keys = after_keys - before_keys
    # retry 允许为「从未上传过」的附件申请新地址（本次实测：第一份日志失败即停止，
    # 后续日志份保持 not_started，retry 时才首次上传）；但不允许为已成功过的附件重来。
    already_uploaded_names = {keynames.get(k) for k in before_uploaded}
    new_names = {keynames.get(k) for k in new_keys}
    check(f"{label} {op_name} 只补齐未上传过的附件，不为已上传成功的附件申请新地址",
          not (new_names & already_uploaded_names), 
          json.dumps({"newKeys": sorted(new_keys), "newNames": sorted(str(n) for n in new_names),
                      "alreadyUploaded": sorted(str(n) for n in already_uploaded_names)}, ensure_ascii=False))
    after_puts_per_key = {}
    for p in (after.get("putAttempts") or []):
        after_puts_per_key[p["key"]] = after_puts_per_key.get(p["key"], 0) + 1
    reuploaded = {k: (before_puts_per_key[k], after_puts_per_key.get(k, 0))
                  for k in before_uploaded if after_puts_per_key.get(k, 0) != before_puts_per_key.get(k, 0)}
    check(f"{label} {op_name} 后已上传成功的 key 的 PUT 次数未增长（没有重新上传已成功字节）",
          not reuploaded, json.dumps({"reuploaded": {k: v for k, v in reuploaded.items()},
                                      "before": before_puts_total, "after": len(after.get("putAttempts") or [])}, ensure_ascii=False))
    # 已确认（asset.url 非空 + comment confirmed）的附件在 retry 后仍指向同一份资产
    check(f"{label} {op_name} 前后已上传资产的字节摘要未被改写",
          all((after.get("putAttempts") or []) and
              any(p["key"] == k and p.get("sha256") == v.get("sha256") for p in (after.get("putAttempts") or []))
              for k, v in before_uploaded.items()),
          json.dumps({k: v.get("sha256", "")[:12] for k, v in before_uploaded.items()}, ensure_ascii=False))
    check(f"{label} 补齐后反馈才变 archived（未完成时绝不提前显示已归档）",
          detail2.get("status") == "archived", str(detail2.get("status")))
    status, logs_final = admin_logs_api(deps, fid)
    check(f"{label} 补齐后逐份都是 confirmed",
          {l.get("archiveState") for l in (logs_final.get("logs") or [])} == {"confirmed"},
          json.dumps(logs_final.get("logs"), ensure_ascii=False)[:300])


def l5_partial_not_archived(deps):
    step, check = deps["step"], deps["check"]
    step("L5 截图完成但某份日志未完成 → 绝不 archived（评论结果不确定 → 待核对）")
    page, tap, fb, detail = _make_partial(deps, "uncertain")
    fid = fb["id"]
    st = detail.get("status")
    check("L5 反馈级状态不是 archived（真实构造的部分归档）", st != "archived", f"status={st}")
    check("L5 评论写入结果不确定 → needs_review（待核对），绝不显示已归档", st == "needs_review", f"status={st}")
    logs = _assert_partial_per_log(deps, fid, check, "L5")
    failed_log_id = logs[0]["id"]
    # needs_review 不允许 retry（服务端语义），必须走 recover；先断言 allowedActions 与非法 logId 语义
    rec = detail.get("recovery") or {}
    check("L5 服务端 recovery 明确允许 retry_comment 且携带 revision",
          "retry_comment" in (rec.get("allowedActions") or []) and isinstance(rec.get("revision"), int),
          json.dumps(rec, ensure_ascii=False)[:300])
    rev = rec.get("revision")
    st_bad, body_bad = deps["api"]("POST", f"/api/feedback/{fid}/recover",
                                   {"action": "retry_comment", "expectedRevision": rev, "logId": "no-such-log"})
    check("L5 recover 指定不存在的 logId → 404（不误伤其它附件）", st_bad == 404,
          f"{st_bad} {json.dumps(body_bad, ensure_ascii=False)[:200]}")
    st_empty, body_empty = deps["api"]("POST", f"/api/feedback/{fid}/recover",
                                       {"action": "retry_comment", "expectedRevision": rev, "logId": ""})
    check("L5 recover 指定空 logId → 400（非法值不静默降级为截图行为）", st_empty == 400,
          f"{st_empty} {json.dumps(body_empty, ensure_ascii=False)[:200]}")
    if deps["shot"]:
        deps["shot"](page, "L5-partial-needs-review")
    _retry_without_rearchive(deps, fid, check, "L5", endpoint="recover", log_id=failed_log_id, revision=rev)
    page.close()


def l5c_partial_definite_failed(deps):
    step, check = deps["step"], deps["check"]
    step("L5c 截图完成但某份日志被明确拒绝 → failed（仍绝不 archived），retry 后补齐")
    page, tap, fb, detail = _make_partial(deps, "definite")
    fid = fb["id"]
    st = detail.get("status")
    check("L5c 反馈级状态不是 archived", st != "archived", f"status={st}")
    check("L5c 评论被明确拒绝 → failed（明文失败 ≠ 已归档）", st == "failed", f"status={st}")
    _assert_partial_per_log(deps, fid, check, "L5c")
    if deps["shot"]:
        deps["shot"](page, "L5c-partial-failed")
    _retry_without_rearchive(deps, fid, check, "L5c")
    page.close()


def l5b_not_started_sources(deps):
    step, check = deps["step"], deps["check"]
    step("L5b not_started 的两种来源分开取证：归档前失败 / presign 失败 / corrupt 回落")
    reset_mocks()

    # (1) 归档流程前失败：任务创建明确失败 → 反馈 failed，但日志已落库
    inject_fail(stage="task", mode="definite", once=True)
    page = new_logs_page(deps, plan=["ok"])
    tap = SubmitTap(page)
    open_panel(page)
    wait_log_count(page, 1)
    page.locator(".fb-textarea").fill("L5b 归档前失败：日志已保存但未进入归档")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=150)
    fb = newest_feedback(deps)
    fid = fb["id"]
    detail = wait_status(deps, fid, {"archived", "needs_review", "failed"}, timeout=150)
    check("L5b 任务创建失败 → 反馈级 failed", detail.get("status") == "failed", str(detail.get("status")))
    check("L5b failed 状态下管理详情仍返回 logs 数组（不是悄悄省略）",
          isinstance(detail.get("logs"), list) and len(detail["logs"]) == 1,
          json.dumps(detail.get("logs"), ensure_ascii=False)[:300])
    lg = (detail.get("logs") or [{}])[0]
    check("L5b 该份日志 archiveState=not_started（V2 无记录）", lg.get("archiveState") == "not_started",
          json.dumps(lg, ensure_ascii=False))
    check("L5b 该份日志仍带 truncated/totalCodepoints 真值（字段不能因 failed 而缺）",
          lg.get("truncated") is False and isinstance(lg.get("totalCodepoints"), int),
          json.dumps(lg, ensure_ascii=False))
    # 日志接口同样可读
    status, logs_api = admin_logs_api(deps, fid)
    check("L5b failed 状态下 GET .../logs 仍 200 且逐份 not_started",
          status == 200 and all(l.get("archiveState") == "not_started" for l in logs_api.get("logs", [])),
          f"{status} {json.dumps(logs_api.get('logs'), ensure_ascii=False)[:300]}")
    raw = deps["api_bytes"](f"/api/admin/feedback/{fid}/logs/{lg['id']}?download=1")
    entry = tap.last()
    check("L5b 未归档时本地字节仍可下载且与提交一致",
          sha256_hex(raw) == sha256_hex(log_parts(entry)[0]["bytes"]), sha256_hex(raw)[:16])
    page.close()

    # (2) presign 失败（用 filename 精确定位到日志那一份）→ V2 无记录 → not_started
    reset_mocks()
    inject_fail(stage="presign", mode="definite", once=True, filename="app.log")
    page = new_logs_page(deps, plan=["ok"])
    open_panel(page)
    wait_log_count(page, 1)
    page.locator(".fb-textarea").fill("L5b presign 失败：不落盘上传记录")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=150)
    fb2 = newest_feedback(deps)
    d2 = wait_status(deps, fb2["id"], {"archived", "needs_review", "failed"}, timeout=150)
    lg2 = (d2.get("logs") or [{}])[0]
    check("L5b presign 阶段失败 → 反馈级 failed/needs_review 且非 archived",
          d2.get("status") != "archived", str(d2.get("status")))
    check("L5b presign 失败后该份日志 archiveState=not_started（先申请后落盘的真实证据）",
          lg2.get("archiveState") == "not_started", json.dumps(lg2, ensure_ascii=False))
    st2 = kaneo_state()
    check("L5b presign 注入确实命中了日志那一份（mock 记录的 presign 文件名过滤生效）",
          (st2.get("fail") or {}).get("fired", 0) >= 1, json.dumps(st2.get("fail"), ensure_ascii=False))
    page.close()

    # (3) corrupt 回落：直接改库为非法 V2 形态 → 读路径回落 not_started 且不报错
    reset_mocks()
    page = new_logs_page(deps, plan=["ok"])
    open_panel(page)
    wait_log_count(page, 1)
    page.locator(".fb-textarea").fill("L5b corrupt 回落")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=150)
    fb3 = newest_feedback(deps)
    d3 = wait_status(deps, fb3["id"], {"archived", "needs_review", "failed"}, timeout=150)
    fid3 = fb3["id"]
    logid3 = (d3.get("logs") or [{}])[0]["id"]
    corrupt = {"version": 2, "revision": 1, "target": "t-1", "logs": {logid3: {"asset": {"id": "x", "url": ""}}}}
    db_exec(deps, "UPDATE feedbacks SET archive_data_json=? WHERE id=?", (json.dumps(corrupt), fid3))
    status3, d3b = admin_detail(deps, fid3)
    check("L5b corrupt 形态下管理详情不报错（仍 200）", status3 == 200, str(status3))
    lg3 = (d3b.get("logs") or [{}])[0]
    check("L5b corrupt 回落为 not_started（**标注：这是 corrupt 回落，不是真实未开始**）",
          lg3.get("archiveState") == "not_started", json.dumps(lg3, ensure_ascii=False))
    check("L5b corrupt 回落不影响本地字节下载（存档数据损坏 != 日志字节丢失）",
          len(deps["api_bytes"](f"/api/admin/feedback/{fid3}/logs/{logid3}?download=1")) > 0, "download failed")
    deps["_corrupt_note"] = f"corrupt 注入：feedbacks.archive_data_json={json.dumps(corrupt)}; 读回 archiveState={lg3.get('archiveState')}"
    page.close()


# ---------------- L6 管理页真实浏览器回归 ----------------


def l6_admin_ui(deps):
    step, check = deps["step"], deps["check"]
    step("L6 管理页真实浏览器回归：日志数量/逐份属性/预览下载响应头/诊断分块/状态诚实性")
    # 复用 L4/L5 已落库的数据；这里新造一条「归档成功 + 带诊断」的记录，保证诊断块存在
    reset_mocks()
    page = new_logs_page(deps, plan=["ok"])
    open_panel(page)
    wait_log_count(page, 1)
    page.locator(".fb-textarea").fill("L6 管理页回归：带诊断的归档记录")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=150)
    fb = newest_feedback(deps)
    fid = fb["id"]
    detail = wait_status(deps, fid, {"archived", "needs_review", "failed"}, timeout=150)
    check("L6 准备数据：该反馈已归档", detail.get("status") == "archived", str(detail.get("status")))
    logmeta = (detail.get("logs") or [{}])[0]
    page.close()

    admin = deps["ctx"].new_page()
    admin.set_viewport_size({"width": 1440, "height": 900})
    admin.goto(f"{deps['service']}/admin/", wait_until="networkidle")
    if admin.locator("#u").count() > 0 and admin.locator("#u").is_visible():
        admin.locator("#u").fill(deps["admin_user"])
        admin.locator("#p").fill(deps["admin_pass"])
        admin.locator("form button[type=submit]").click()
    admin.wait_for_selector('[data-testid="feedback-row"]', timeout=30000)
    check("L6 管理页真实登录并渲染反馈列表", admin.locator('[data-testid="feedback-row"]').count() >= 1,
          str(admin.locator('[data-testid="feedback-row"]').count()))

    row = admin.locator(f'[data-testid="feedback-row"][data-feedback-id="{fid}"]')
    check("L6 列表行按 data-feedback-id 可定位", row.count() == 1, str(row.count()))
    count_el = row.locator('[data-testid="log-count"]')
    check("L6 列表行 logCount 与接口一致",
          count_el.get_attribute("data-log-count") == str(detail.get("logCount")),
          f"dom={count_el.get_attribute('data-log-count')} api={detail.get('logCount')}")

    # 列表行状态诚实性：已归档记录才允许「已归档」
    row_status = row.locator('[data-testid="feedback-row-status"]')
    check("L6 列表行状态钩子：data-status 与接口一致且 data-archive-complete 只由 archived 派生",
          row_status.get_attribute("data-status") == detail.get("status")
          and row_status.get_attribute("data-archive-complete") == ("true" if detail.get("status") == "archived" else "false"),
          f"status={row_status.get_attribute('data-status')} complete={row_status.get_attribute('data-archive-complete')}")

    row.locator('[data-testid="feedback-row"]').first.click() if False else row.click()
    dialog = admin.locator('[role="dialog"][aria-label="反馈详情"]')
    dialog.wait_for(state="visible", timeout=15000)
    check("L6 详情弹窗打开", dialog.is_visible())

    item = dialog.locator('[data-testid="log-item"]')
    check("L6 详情逐份渲染 log-item 且数量与接口一致",
          item.count() == len(detail.get("logs") or []), f"dom={item.count()} api={len(detail.get('logs') or [])}")
    # 逐份属性与服务端逐字交叉核对（缺失即判红）
    dom_attrs = dialog.locator('[data-testid="log-item"]').first
    got = {
        "data-log-id": dom_attrs.get_attribute("data-log-id"),
        "data-log-seq": dom_attrs.get_attribute("data-log-seq"),
        "data-log-filename": dom_attrs.get_attribute("data-log-filename"),
        "data-log-source": dom_attrs.get_attribute("data-log-source"),
        "data-log-bytesize": dom_attrs.get_attribute("data-log-bytesize"),
        "data-log-truncated": dom_attrs.get_attribute("data-log-truncated"),
        "data-log-codepoints": dom_attrs.get_attribute("data-log-codepoints"),
        "data-log-archive-state": dom_attrs.get_attribute("data-log-archive-state"),
        "data-log-archive-label": dom_attrs.get_attribute("data-log-archive-label"),
    }
    expected = {
        "data-log-id": logmeta["id"],
        "data-log-seq": str(logmeta["seq"]),
        "data-log-filename": logmeta["filename"],
        "data-log-source": logmeta["source"],
        "data-log-bytesize": str(logmeta["byteSize"]),
        "data-log-truncated": "true" if logmeta["truncated"] else "false",
        "data-log-codepoints": str(logmeta["totalCodepoints"]),
        "data-log-archive-state": logmeta["archiveState"],
    }
    label_map = {"not_started": "未开始", "partial": "进行中", "confirmed": "已完成"}
    expected["data-log-archive-label"] = label_map[logmeta["archiveState"]]
    check("L6 逐份日志 9 个属性必须存在且与服务端逐字一致（缺失即判红）",
          all(got[k] == v for k, v in expected.items()), json.dumps({"dom": got, "api": expected}, ensure_ascii=False))
    check("L6 archiveState→展示文案映射正确（confirmed→已完成）",
          got["data-log-archive-label"] == "已完成", str(got["data-log-archive-label"]))

    # 状态诚实性（详情）：archived 记录才允许 complete=true，且文案为已归档
    dst = dialog.locator('[data-testid="feedback-status"]')
    st_attrs = {"status": dst.get_attribute("data-status"), "complete": dst.get_attribute("data-archive-complete")}
    st_text = (dst.text_content() or "").strip()
    check("L6 详情状态节点：data-status/data-archive-complete/文案三者自洽",
          st_attrs["status"] == "archived" and st_attrs["complete"] == "true" and st_text == "已归档",
          json.dumps({**st_attrs, "text": st_text}, ensure_ascii=False))

    # 预览：同源 fetch，读原始响应头 + 内容与下载字节一致
    with admin.expect_response(lambda r: f"/api/admin/feedback/{fid}/logs/{logmeta['id']}" in r.url and "download" not in r.url) as pi:
        dialog.locator('[data-testid="log-preview"]').first.click()
    presp = pi.value
    ph = presp.headers
    check("L6 预览响应头：no-store + nosniff + text/plain + inline",
          ph.get("cache-control") == "no-store" and ph.get("x-content-type-options") == "nosniff"
          and "text/plain" in (ph.get("content-type") or "") and "inline" in (ph.get("content-disposition") or "inline"),
          json.dumps(ph, ensure_ascii=False))
    admin.wait_for_function(
        "(id) => { const p = document.querySelector(`[data-testid=\"log-preview-body\"][data-log-id=\"${id}\"]`);"
        " return !!p && p.textContent.length > 0; }", arg=logmeta["id"], timeout=15000
    )
    preview_body = dialog.locator(f'[data-testid="log-preview-body"][data-log-id="{logmeta["id"]}"]').text_content()
    server_bytes = deps["api_bytes"](f"/api/admin/feedback/{fid}/logs/{logmeta['id']}")
    check("L6 预览内容 == 服务端字节解码（无转义/无截断）", preview_body == server_bytes.decode("utf-8"),
          f"dom={preview_body[:60]!r} api={server_bytes[:60]!r}")

    # 下载：纯 <a href="?download=1">，无 target/download 属性；响应头是 attachment
    dl_link = dialog.locator('[data-testid="log-download"]').first
    check("L6 下载是纯链接：href 只带 ?download=1、无 target、无 HTML download 属性",
          dl_link.get_attribute("href") == f"/api/admin/feedback/{fid}/logs/{logmeta['id']}?download=1"
          and dl_link.get_attribute("target") is None and dl_link.get_attribute("download") is None,
          json.dumps({"href": dl_link.get_attribute("href"), "target": dl_link.get_attribute("target"),
                      "download": dl_link.get_attribute("download")}, ensure_ascii=False))
    with admin.expect_response(lambda r: "download=1" in r.url) as pi2:
        dl_link.click()
    dresp = pi2.value
    dh = dresp.headers
    check("L6 下载响应头：no-store + nosniff + attachment + 安全文件名",
          dh.get("cache-control") == "no-store" and dh.get("x-content-type-options") == "nosniff"
          and "attachment" in (dh.get("content-disposition") or "")
          and logmeta["filename"] in (dh.get("content-disposition") or ""),
          json.dumps(dh, ensure_ascii=False))
    check("L6 下载响应体就是日志字节（Content-Length 与 byteSize 一致）",
          dh.get("content-length") == str(logmeta["byteSize"]), str(dh.get("content-length")))

    # 诊断分块：证据（已证实）与推测（未证实）分开，且项数来自服务端
    diag = (detail.get("diagnostics") or {})
    if diag.get("logEvidence") or diag.get("possibleCauses"):
        ev_block = dialog.locator('[data-testid="diag-evidence"]')
        ca_block = dialog.locator('[data-testid="diag-causes"]')
        check("L6 诊断：证据块与推测块分开渲染", ev_block.count() == 1 and ca_block.count() == 1,
              f"evidence={ev_block.count()} causes={ca_block.count()}")
        ev_items = ev_block.locator('[data-testid="evidence-item"]')
        ca_items = ca_block.locator('[data-testid="cause-item"]')
        check("L6 诊断：证据项数与推测项数与接口一致",
              ev_items.count() == len(diag.get("logEvidence") or []) and ca_items.count() == len(diag.get("possibleCauses") or []),
              f"dom={ev_items.count()}/{ca_items.count()} api={len(diag.get('logEvidence') or [])}/{len(diag.get('possibleCauses') or [])}")
        if ca_items.count() > 0:
            check("L6 推测项带 confidence 且标注「不确定」",
                  ca_items.first.get_attribute("data-confidence") in ("low", "medium")
                  and "不确定" in (ca_items.first.text_content() or ""),
                  json.dumps({"confidence": ca_items.first.get_attribute("data-confidence"),
                              "text": (ca_items.first.text_content() or "")[:80]}, ensure_ascii=False))
        evtext = (ev_block.text_content() or "")
        catext = (ca_block.text_content() or "")
        check("L6 诊断：证据块文案标明「已证实」，推测块标明「推测/未证实」（两处分开、不混写）",
              "已证实" in evtext and ("推测" in catext or "未证实" in catext), f"ev={evtext[:60]!r} ca={catext[:60]!r}")
    else:
        check("L6 诊断块：接口无合法条目时整块不渲染", dialog.locator('[data-testid="diagnostics"]').count() == 0,
              "diagnostics 块不应出现")

    if deps["shot"]:
        deps["shot"](admin, "L6-admin-detail")
    admin.close()


def l6b_admin_status_honesty_partial(deps):
    """列表/详情在任何时候都不得把未完成说成已归档（语义钩子，不做全文搜索）。"""
    step, check = deps["step"], deps["check"]
    step("L6b 管理页状态诚实性：partial 记录不得显示「已归档」")
    reset_mocks()
    inject_fail(stage="comment", mode="definite", once=True, skip=1)
    page = new_logs_page(deps, plan=["ok"])
    open_panel(page)
    wait_log_count(page, 1)
    page.locator(".fb-textarea").fill("L6b partial 记录的状态诚实性")
    submit_panel(page, deps)
    wait_widget_settled(page, timeout=150)
    fb = newest_feedback(deps)
    fid = fb["id"]
    detail = wait_status(deps, fid, {"needs_review", "failed", "archived"}, timeout=150)
    check("L6b 记录处于未完成态（needs_review）", detail.get("status") == "needs_review", str(detail.get("status")))
    page.close()

    admin = deps["ctx"].new_page()
    admin.goto(f"{deps['service']}/admin/", wait_until="networkidle")
    if admin.locator("#u").count() > 0 and admin.locator("#u").is_visible():
        admin.locator("#u").fill(deps["admin_user"])
        admin.locator("#p").fill(deps["admin_pass"])
        admin.locator("form button[type=submit]").click()
    row = admin.locator(f'[data-testid="feedback-row"][data-feedback-id="{fid}"]')
    row.wait_for(state="visible", timeout=30000)
    rs = row.locator('[data-testid="feedback-row-status"]')
    check("L6b 列表行：data-status != archived 且 data-archive-complete != true",
          rs.get_attribute("data-status") != "archived" and rs.get_attribute("data-archive-complete") != "true",
          json.dumps({"status": rs.get_attribute("data-status"), "complete": rs.get_attribute("data-archive-complete")}))
    check("L6b 列表行文案不是「已归档」（核心场景应为「待核对」）",
          (rs.text_content() or "").strip() == "待核对", repr((rs.text_content() or "").strip()))
    row.click()
    dialog = admin.locator('[role="dialog"][aria-label="反馈详情"]')
    dialog.wait_for(state="visible", timeout=15000)
    ds = dialog.locator('[data-testid="feedback-status"]')
    check("L6b 详情：data-status != archived 且文案不是「已归档」",
          ds.get_attribute("data-status") != "archived" and (ds.text_content() or "").strip() != "已归档"
          and ds.get_attribute("data-archive-complete") != "true",
          json.dumps({"status": ds.get_attribute("data-status"), "text": (ds.text_content() or "").strip(),
                      "complete": ds.get_attribute("data-archive-complete")}, ensure_ascii=False))
    # 逐份：未完成的那份必须显示「进行中」，且不得出现"整体/全部归档完成"的聚合措辞
    partial_items = dialog.locator('[data-testid="log-item"][data-log-archive-state="partial"]')
    check("L6b 存在 partial 的逐份项（真实构造）", partial_items.count() >= 1, str(partial_items.count()))
    if partial_items.count() >= 1:
        lbl = partial_items.first.get_attribute("data-log-archive-label")
        check("L6b partial 项的展示文案是「进行中」", lbl == "进行中", str(lbl))
    dialog_text = dialog.text_content() or ""
    forbidden = [t for t in ("全部归档完成", "全部已完成", "全部日志已归档") if t in dialog_text]
    check("L6b 未完成时页面不得出现「整体/全部归档完成」类聚合措辞", not forbidden, str(forbidden))
    if deps["shot"]:
        deps["shot"](admin, "L6b-partial-honesty")
    admin.close()


# ---------------- 入口 ----------------


def run(deps):
    paths = [
        ("L1 日志全链路（采集→补充→预览→移除→重开→提交→下载一致）", l1_full_chain),
        ("L2 采集失败/超时/超限 + 迟到结果隔离", l2_fail_timeout_oversize_stale),
        ("L3 断网重试与幂等键变化", l3_offline_retry_idempotency),
        ("L4 AI 日志证据/截取/诊断与 Kaneo 字节一致", l4_ai_logs_and_kaneo),
        ("L5 部分归档：绝不 archived + 成功附件不重复归档", l5_partial_not_archived),
        ("L5c 明确拒绝的部分归档（failed 也绝不 archived）", l5c_partial_definite_failed),
        ("L5b not_started 的三种来源分开取证", l5b_not_started_sources),
        ("L6 管理页真实浏览器回归", l6_admin_ui),
        ("L6b 管理页状态诚实性（partial 不得显示已归档）", l6b_admin_status_honesty_partial),
    ]
    only = os.environ.get("E2E_LOGS_ONLY", "").strip()
    if only:
        keep = {s.strip() for s in only.split(",")}
        paths = [(n, f) for n, f in paths if any(n.startswith(k) for k in keep)]
        print(f"[INFO] E2E_LOGS_ONLY={only} → 只跑 {len(paths)} 条日志路径", flush=True)
    for name, fn in paths:
        try:
            fn(deps)
        except Exception as exc:  # 单条路径失败不掩盖其余路径
            deps["record"](f"{name}：后续断言未执行（{str(exc)[:200]}）", False, "路径中断")
        time.sleep(0.3)
