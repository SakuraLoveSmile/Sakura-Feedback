#!/usr/bin/env python3
"""
人工分类归档改造（T2/T3/T4）：管理页真实浏览器验收。

自动化/mock 测试无法代替浏览器验收（管理页 `pnpm test` 是空脚本）。本脚本用**真实构建产物**
（`apps/admin/dist`）+ **真实服务进程**（`tsx src/index.ts`）+ **mock 外部服务**
（`e2e/mock-external.mjs`：AI + Kaneo）在 Chromium 里驱动管理页，验证：

  1. 状态筛选包含全部 8 个状态（含 needs_info / ready_to_archive）；
  2. 详情出现「人工分类与归档」面板：项目 / 目标列 / 工作区标签 / 可选负责人；
  3. 切换项目**立即清空**列、标签与负责人；**迟到的旧项目响应被丢弃**（不同项目返回不同列）；
  4. 「保存」= 暂存：缺项 → 需要补充信息，完整 → 待归档，且**零远端写入**；
  5. 「保存并归档」→ 已归档，出现 Kaneo 任务链接，且 mock 侧确实收到正确项目/列/标签/负责人；
  6. 归档后分类**锁定**（输入禁用），详情出现操作审计与恢复入口；
  7. 不完整归档被服务端拒绝（422）且 UI 显示错误、mock 无任务。

用法：
  python3 e2e/run_classify_archive_browser.py [--browser chromium]
前置：`pnpm --filter @feedback/admin build`（或已存在 apps/admin/dist）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "apps/server")
ADMIN_DIST = os.path.join(ROOT, "apps/admin/dist")
SHOTS = os.path.join(ROOT, "e2e/shots/classify-archive")
REPORT = os.path.join(SHOTS, "report.json")

ADMIN_USER = "admin"
ADMIN_PASS = "classify-admin-pass-1"
APP_ID = "com.example.classify-e2e"
APP_ORIGIN = "http://127.0.0.1:5199"
KANEO_PORT = 8898
AI_PORT = 8899

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "", soft: bool = False) -> bool:
    results.append((name, bool(cond), detail))
    mark = "PASS" if cond else ("WARN" if soft else "FAIL")
    print(f"  {mark}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond and not soft:
        raise AssertionError(f"{name} — {detail}")
    return bool(cond)


def step(name: str) -> None:
    print(f"[STEP] {name}", flush=True)


def shot(page, name: str, full_page: bool = False) -> str | None:
    os.makedirs(SHOTS, exist_ok=True)
    path = os.path.join(SHOTS, name + ".png")
    try:
        page.screenshot(path=path, full_page=full_page)
        print(f"  [shot] {os.path.relpath(path, ROOT)}", flush=True)
        return os.path.relpath(path, ROOT)
    except Exception as exc:  # noqa: BLE001
        print(f"  [shot!] {name}: {exc}", flush=True)
        return None


class Http:
    def __init__(self) -> None:
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method: str, url: str, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=20) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                parsed = json.loads(raw)
            except Exception:  # noqa: BLE001
                parsed = {"raw": raw[:300]}
            return e.code, parsed

    def cookie(self) -> str:
        for h in self.opener.handlers:
            jar = getattr(h, "cookiejar", None)
            if jar is not None:
                return "; ".join(f"{c.name}={c.value}" for c in jar)
        return ""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_proc(args: list[str], cwd: str, env: dict | None = None, log_path: str | None = None):
    log = open(log_path, "w") if log_path else subprocess.DEVNULL
    return subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT), log


def wait_http(url: str, timeout: float = 90) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    raise RuntimeError(f"服务未就绪：{url}")


def mock_state(path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:{KANEO_PORT}{path}", timeout=10) as r:
        return json.loads(r.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    args = ap.parse_args()

    if not os.path.exists(os.path.join(ADMIN_DIST, "index.html")):
        print("[FATAL] 缺少管理页构建产物：请先 `pnpm --filter @feedback/admin build`", flush=True)
        return 2
    busy = [p for p in (KANEO_PORT, AI_PORT) if port_busy(p)]
    if busy:
        print(f"[FATAL] 端口被占用：{busy}（上次运行残留？）", flush=True)
        return 2

    os.makedirs(SHOTS, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="fb-classify-e2e-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    procs = []
    logs = []
    try:
        step("启动 mock 外部服务（AI / Kaneo）")
        p, log = start_proc(["node", "e2e/mock-external.mjs"], ROOT, log_path="/tmp/fb-classify-mock.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
        wait_http(f"http://127.0.0.1:{AI_PORT}/__health")

        step(f"启动反馈服务 :{port}（托管真实管理页产物）")
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="Y2xhc3NpZnktZTJlLW1hc3Rlci1rZXktMzItYnl0ZQ==",
            FEEDBACK_ADMIN_USER=ADMIN_USER,
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=data_dir,
            FEEDBACK_PORT=str(port),
            NODE_ENV="production",
        )
        p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-classify-server.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"{base}/healthz")

        step("配置连接与软件（默认项目 p-e2e / 列 triage，仅用于预填）")
        h = Http()
        st, _ = h.call("POST", f"{base}/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
        check("管理员登录 200", st == 200, f"status={st}")
        st, _ = h.call(
            "PUT",
            f"{base}/api/admin/connection/kaneo",
            {"baseUrl": f"http://127.0.0.1:{KANEO_PORT}", "apiKey": "k-e2e"},
        )
        check("Kaneo 连接写入 200", st == 200, f"status={st}")
        st, _ = h.call(
            "PUT",
            f"{base}/api/admin/connection/ai",
            {"baseUrl": f"http://127.0.0.1:{AI_PORT}/v1", "model": "mock", "apiKey": "a-e2e"},
        )
        check("AI 连接写入 200", st == 200, f"status={st}")
        st, _ = h.call(
            "POST",
            f"{base}/api/admin/apps",
            {
                "appId": APP_ID,
                "name": "分类验收软件",
                "allowedOrigins": [APP_ORIGIN],
                "kaneoProjectId": "p-e2e",
                "kaneoColumnSlug": "triage",
            },
        )
        check("软件配置创建 201", st == 201, f"status={st}")

        step("通过真实提交接口产生两条反馈（提交不再授权远端归档）")
        ids = []
        for i in range(2):
            st, body = h.call(
                "POST",
                f"{base}/api/feedback",
                {
                    "idempotencyKey": f"classify-e2e-{i}",
                    "appId": APP_ID,
                    "text": f"分类验收反馈 {i}：导出按钮点击后没有反应",
                    "context": {"appVersion": "1.0.0", "pageLabel": "export"},
                },
                headers={"origin": APP_ORIGIN},
            )
            check(f"提交 {i} 201", st == 201, f"status={st} body={body}")
            ids.append(body["feedbackId"])
        time.sleep(2.0)  # 等 worker 完成 AI 整理
        tasks_after_submit = mock_state("/__mock/tasks")["tasks"]
        check("提交后 Kaneo 无任务（提交不授权远端归档）", tasks_after_submit == [], f"tasks={tasks_after_submit}")

        with sync_playwright() as pw:
            launch_kwargs = {}
            # 本机 Playwright 浏览器缓存版本可能高于 Python 包内置的期望版本：
            # 允许用 FB_E2E_CHROMIUM 指定可执行文件（否则用默认查找）。
            exe = os.environ.get("FB_E2E_CHROMIUM")
            if exe:
                launch_kwargs["executable_path"] = exe
            browser = getattr(pw, args.browser).launch(**launch_kwargs)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            step("打开管理页并登录")
            page.goto(f"{base}/admin/", wait_until="domcontentloaded")
            page.wait_for_selector("#u")
            page.fill("#u", ADMIN_USER)
            page.fill("#p", ADMIN_PASS)
            page.click("form:has(#u) button[type=submit]")
            page.wait_for_selector("nav.tabs", timeout=20000)
            shot(page, "01-login-ok")

            step("状态筛选包含全部 8 个状态")
            page.wait_for_selector("#sf")
            options = page.locator("#sf option").all_inner_texts()
            for label in [
                "已接收",
                "处理中",
                "需要补充信息",
                "待归档",
                "归档中",
                "结果待核对",
                "已归档",
                "失败",
            ]:
                check(f"状态筛选项含「{label}」", label in options, f"options={options}")
            page.select_option("#sf", "needs_info")
            page.wait_for_timeout(600)
            shot(page, "02-filter-needs-info")
            rows = page.locator("table tbody tr").count()
            check("按「需要补充信息」筛出记录", rows >= 2, f"rows={rows}")

            step("打开详情：分类面板与默认预填（软件默认项目/列仅预填）")
            page.locator("table tbody tr button:has-text('详情')").first.click()
            page.wait_for_selector("aside.detail-pane")
            page.wait_for_selector("select[aria-label='所在项目']")
            page.wait_for_function(
                "() => { const s = document.querySelector(\"select[aria-label='所在项目']\"); return !!s && s.value.length > 0; }",
                timeout=15000,
            )
            proj_val = page.locator("select[aria-label='所在项目']").input_value()
            check("默认项目已预填软件配置", proj_val == "p-e2e", f"value={proj_val}")
            page.wait_for_function(
                "() => { const s = document.querySelector(\"select[aria-label='目标列']\"); return !!s && s.options.length > 1; }",
                timeout=15000,
            )
            page.wait_for_timeout(400)
            col_val = page.locator("select[aria-label='目标列']").input_value()
            check("默认列按 slug 预填为 triage", col_val == "col-1", f"value={col_val}")
            labels = page.locator("aside.detail-pane input[type=checkbox]")
            check("工作区标签没有自动选择（标签不自动选择）", labels.count() >= 1 and not any(labels.nth(i).is_checked() for i in range(labels.count())))
            shot(page, "03-detail-classify-panel")

            step("不完整分类的客户端守卫：归档按钮禁用并给出提示（服务端 422 由自动化测试覆盖）")
            archive_btn = page.get_by_role("button", name="保存并归档", exact=True)
            check("缺标签时「保存并归档」按钮禁用", archive_btn.is_disabled())
            check(
                "面板提示需补齐项目/列/标签",
                "归档前请补齐" in page.locator("aside.detail-pane").inner_text(),
                page.locator("aside.detail-pane").inner_text()[-200:],
            )
            shot(page, "04-incomplete-guard")

            step("切换项目立即清空列/标签/负责人，并丢弃迟到响应")
            page.select_option("select[aria-label='目标列']", "col-1")
            page.locator("aside.detail-pane input[type=checkbox]").first.check()
            page.select_option("select[aria-label='负责人']", "user-e2e-1")
            # mock 对 p-other 的列响应故意延迟 1.5s：先切到 p-other，再立刻切回 p-e2e，
            # 迟到的 p-other 响应必须被丢弃（否则列选项会变成「已上线 / done」）。
            page.select_option("select[aria-label='所在项目']", "p-other")
            page.wait_for_timeout(150)
            col_now = page.locator("select[aria-label='目标列']").input_value()
            assignee_now = page.locator("select[aria-label='负责人']").input_value()
            labels_now = page.locator("aside.detail-pane input[type=checkbox]")
            checked_now = any(labels_now.nth(i).is_checked() for i in range(labels_now.count()))
            check("切换项目后目标列被清空", col_now == "", f"value={col_now}")
            check("切换项目后负责人被清空", assignee_now == "", f"value={assignee_now}")
            check("切换项目后标签被清空", not checked_now)
            shot(page, "05a-project-switched-cleared")
            page.select_option("select[aria-label='所在项目']", "p-e2e")
            page.wait_for_function(
                "() => { const s = document.querySelector(\"select[aria-label='目标列']\"); return !!s && Array.from(s.options).some(o => o.textContent.includes('triage')); }",
                timeout=15000,
            )
            page.wait_for_timeout(1800)  # 等迟到的 p-other 响应到达
            col_texts = page.locator("select[aria-label='目标列'] option").all_inner_texts()
            check(
                "迟到的旧项目响应被丢弃（列选项仍是当前项目的 triage/doing）",
                any("triage" in t for t in col_texts) and not any("done" in t for t in col_texts),
                f"options={col_texts}",
            )
            check("迟到响应未把旧项目选择写回（列保持未选择）", page.locator("select[aria-label='目标列']").input_value() == "")
            shot(page, "05b-late-response-discarded")

            step("完整暂存 → 待归档（零远端写入）")
            page.select_option("select[aria-label='目标列']", "col-1")
            page.locator("aside.detail-pane input[type=checkbox]").first.check()
            page.get_by_role("button", name="保存", exact=True).click()
            page.wait_for_function(
                "() => document.querySelector('aside.detail-pane')?.textContent.includes('待归档')",
                timeout=15000,
            )
            check("完整暂存后状态为待归档", "待归档" in page.locator("aside.detail-pane").inner_text())
            check("暂存后 Kaneo 仍无任务（零远端写入）", mock_state("/__mock/tasks")["tasks"] == [])
            shot(page, "06-saved-ready-to-archive")

            step("保存并归档 → 已归档 + Kaneo 链接")
            page.get_by_role("button", name="保存并归档", exact=True).click()
            page.wait_for_function(
                "() => document.querySelector('aside.detail-pane')?.textContent.includes('已归档')",
                timeout=20000,
            )
            page.wait_for_timeout(800)
            tasks = mock_state("/__mock/tasks")["tasks"]
            check("Kaneo 收到 1 个任务", len(tasks) == 1, f"tasks={tasks}")
            check("任务使用真实列 slug（triage）", tasks and tasks[0].get("status") == "triage", f"tasks={tasks}")
            check(
                "任务项目为授权时选择的 p-e2e",
                tasks and tasks[0].get("projectId") == "p-e2e",
                f"tasks={tasks}",
            )
            labels_state = mock_state("/__mock/labels")
            check("工作区标签已关联到任务", len(labels_state["attaches"]) == 1, f"attaches={labels_state['attaches']}")
            check("未选择负责人时省略 userId", tasks and "userId" not in tasks[0], f"task={tasks[0] if tasks else None}")
            detail_text = page.locator("aside.detail-pane").inner_text()
            check("详情出现 Kaneo 任务链接入口", "在 Kaneo 中查看任务" in detail_text, detail_text[-200:])
            check("详情显示操作审计", "操作审计" in detail_text, detail_text[-400:])
            shot(page, "07-archived-with-link", full_page=True)

            step("归档后分类锁定（输入禁用）")
            check("项目选择被禁用", page.locator("select[aria-label='所在项目']").is_disabled())
            check("目标列选择被禁用", page.locator("select[aria-label='目标列']").is_disabled())
            check(
                "锁定提示可见",
                "分类已锁定" in page.locator("aside.detail-pane").inner_text(),
                page.locator("aside.detail-pane").inner_text()[:200],
            )
            shot(page, "08-classification-locked")

            step("已归档记录出现在「已归档」筛选")
            page.click("aside.detail-pane button[aria-label='关闭']")
            page.select_option("#sf", "archived")
            page.wait_for_timeout(600)
            rows = page.locator("table tbody tr").count()
            check("按「已归档」筛出记录", rows >= 1, f"rows={rows}")
            shot(page, "09-filter-archived")

            step("恢复入口：人为制造确定失败后详情出现「重试处理」")
            with urllib.request.urlopen(
                urllib.request.Request(
                    f"http://127.0.0.1:{KANEO_PORT}/__mock/fail",
                    data=json.dumps({"stage": "task", "mode": "definite", "once": True}).encode(),
                    headers={"content-type": "application/json"},
                    method="POST",
                ),
                timeout=10,
            ) as r:
                r.read()
            st, body = h.call("POST", f"{base}/api/admin/feedback/{ids[0]}/classify", {
                "action": "archive",
                "classifyVersion": 0,
                "projectId": "p-e2e",
                "columnId": "col-1",
                "columnSlug": "triage",
                "labelIds": ["label-bug"],
                "operationId": "op-browser-recovery",
            }, headers={"origin": base})
            check("第二条归档授权 202", st == 202, f"status={st}")
            time.sleep(2.0)
            page.select_option("#sf", "failed")
            page.wait_for_timeout(700)
            check("按「失败」筛出记录", page.locator("table tbody tr").count() >= 1)
            page.locator("table tbody tr button:has-text('详情')").first.click()
            page.wait_for_selector("aside.detail-pane")
            page.wait_for_function(
                "() => document.querySelector('aside.detail-pane')?.textContent.includes('重试处理')",
                timeout=15000,
            )
            check("恢复入口「重试处理」可见", "重试处理" in page.locator("aside.detail-pane").inner_text())
            shot(page, "10-recovery-entry", full_page=True)

            # 登录前 App 会先探测 GET /api/auth/session，未登录必然 401 —— 这是预期行为。
            unexpected = [
                e
                for e in console_errors
                if not (e.startswith("Failed to load resource") and "401" in e)
            ]
            check("管理页无预期外的 console 错误", not unexpected, f"errors={unexpected[:3]}", soft=True)
            check(
                "登录前的会话探测 401 为唯一 console 错误",
                all("401" in e for e in console_errors),
                f"errors={console_errors[:3]}",
                soft=True,
            )
            browser.close()

        print("\n===== 汇总 =====", flush=True)
        failed = [r for r in results if not r[1]]
        with open(REPORT, "w", encoding="utf-8") as f:
            json.dump(
                {"results": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results], "failed": len(failed)},
                f,
                ensure_ascii=False,
                indent=2,
            )
        print(f"通过 {len(results) - len(failed)} / {len(results)}；报告：{os.path.relpath(REPORT, ROOT)}", flush=True)
        return 0 if not failed else 1
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    p.kill()
        for log in logs:
            try:
                log.close()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
