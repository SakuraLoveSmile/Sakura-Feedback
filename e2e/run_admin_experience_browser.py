#!/usr/bin/env python3
"""后台体验交互回归：真实本地 API + 独立 Chromium + 精确故障注入。

复用已运行的隔离 mock（默认 Kaneo :8898 / AI :8899），不启动或重置它们。
服务使用随机端口及临时数据库，关闭更新与 Assist。不会访问用户浏览器或生产数据。
FB_E2E_ADMIN_DIST 指定构建产物；FB_E2E_SHOTS 指定独立报告/截图目录；
FB_E2E_CHROMIUM 可指定 Chromium 可执行文件。失败同样保存 report.json 和现场截图。
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import run_ui_matrix_browser as helpers

ROOT = Path(__file__).resolve().parent.parent
ADMIN_DIST = Path(os.environ.get("FB_E2E_ADMIN_DIST", ROOT / "apps/admin/dist")).resolve()
SHOTS = Path(os.environ.get("FB_E2E_SHOTS", ROOT / "e2e/shots" / (
    "admin-experience-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
))).resolve()
KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))
RESULTS: list[dict] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    RESULTS.append({"name": name, "ok": bool(condition), "detail": detail})
    print(f"{'PASS' if condition else 'FAIL'} {name}", flush=True)
    if not condition:
        raise AssertionError(f"{name}: {detail}")


def shot(page, name: str) -> None:
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def fail(route, message: str) -> None:
    route.fulfill(status=503, json={"error": {"code": "e2e_unavailable", "message": message}})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def logged_page(browser, base: str):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("localStorage.setItem('feedback.admin.theme', 'light')")
    response = ctx.request.post(base + "/api/auth/login", data={
        "username": helpers.ADMIN_USER, "password": helpers.ADMIN_PASS,
    })
    check("浏览器隔离会话登录", response.status == 200)
    page = ctx.new_page()
    page.set_default_timeout(8000)
    return ctx, page


def empty_list(page, base: str) -> None:
    calls = []

    def list_route(route):
        if route.request.method == "POST":
            # 管理页自己的反馈组件会自动注册软件；空态夹具暂时阻止这一次后台注册。
            fail(route, "空列表夹具暂不注册后台反馈组件")
            return
        calls.append(route.request.method)
        if len(calls) == 1:
            fail(route, "软件列表暂时不可用，请稍后重试")
        else:
            route.continue_()

    pattern = base + "/api/admin/apps"
    page.route(pattern, list_route)
    page.goto(base + "/admin/?page=apps")
    expect(page.get_by_text("软件列表暂时不可用，请稍后重试", exact=True)).to_be_visible()
    expect(page.get_by_text("软件列表未加载", exact=True)).to_be_visible()
    expect(page.get_by_text("还没有软件配置", exact=True)).to_have_count(0)
    check("初始读取失败展示失败态，不误显示成功空列表", True)
    shot(page, "01-apps-list-failure")
    page.get_by_role("button", name="重试", exact=True).click()
    expect(page.get_by_text("还没有软件配置", exact=True)).to_be_visible()
    expect(page.get_by_text("软件列表未加载", exact=True)).to_have_count(0)
    check("列表重试真实 GET 后显示正确空态", len(calls) >= 2 and set(calls) == {"GET"}, str(calls))
    page.unroute(pattern, list_route)


def password_reset(page, base: str, api) -> None:
    st, users = api.call("GET", "/api/admin/users")
    check("账号夹具可读取", st == 200)
    user = next(u for u in users["users"] if u["username"] == helpers.USER_NAME)
    path = base + f"/api/admin/users/{user['id']}/password"
    posts = []
    pending = []
    readback = []

    def post_route(route):
        posts.append(route.request.method)
        if len(posts) == 1:
            fail(route, "密码重置暂时不可用，请重试")
        else:
            pending.append(route)  # 保持真实请求在途；断言后才送达本地 API。

    def users_route(route):
        readback.append(route.request.method)
        fail(route, "账号列表回读暂时不可用，请重试")

    page.goto(base + "/admin/?page=accounts")
    row = page.get_by_role("row").filter(has_text=helpers.USER_NAME)
    opener = row.get_by_role("button", name="重置密码", exact=True)
    opener.click()
    modal = page.get_by_role("dialog", name=f"重置「{helpers.USER_NAME}」的密码")
    password = modal.get_by_label("新密码", exact=True)
    original = "  reset-pass-experience-1  "
    password.fill(original)
    page.route(path, post_route)
    password.press("Enter")
    expect(modal.get_by_role("alert")).to_have_text("密码重置暂时不可用，请重试")
    expect(password).to_have_value(original)
    expect(password).to_have_attribute("type", "password")
    check("密码 POST 503 后弹窗内联错误且原始密码保持掩码", posts == ["POST"])
    shot(page, "02-password-inline-failure")

    password.press("Enter")
    expect(modal.get_by_role("button", name="提交中…", exact=True)).to_be_disabled()
    expect(modal.get_by_role("button", name="取消", exact=True)).to_be_disabled()
    expect(password).to_have_attribute("readonly", "")
    password.press("Enter")
    password.press("Enter")
    page.keyboard.press("Escape")
    expect(modal).to_be_visible()
    page.wait_for_timeout(250)
    check("延迟提交锁定输入及关闭；重复 Enter 仅产生一次重试 POST", len(posts) == 2 and len(pending) == 1)
    page.route(base + "/api/admin/users", users_route)
    pending.pop().continue_()
    expect(modal).to_have_count(0)
    expect(page.get_by_text("账号列表回读暂时不可用，请重试", exact=True)).to_be_visible()
    expect(opener).to_be_focused()
    check("重置成功但回读 503 时关闭弹窗、页级错误、恢复触发按钮焦点", readback == ["GET"] and len(posts) == 2)
    shot(page, "03-password-success-readback-failure")
    page.unroute(base + "/api/admin/users", users_route)
    page.get_by_role("button", name="重试", exact=True).click()
    expect(page.get_by_text("账号列表回读暂时不可用，请重试", exact=True)).to_have_count(0)
    check("页级重试只读取账号列表，不重复密码 POST", len(posts) == 2)
    page.unroute(path, post_route)
    user_api = helpers.Api()
    st, _ = user_api.call("POST", "/api/auth/login", {"username": helpers.USER_NAME, "password": original})
    check("真实 API 使用含首尾空格的原始新密码登录成功", st == 200)


def dialogue_draft(page, base: str) -> None:
    calls = []

    def dialogue_route(route):
        calls.append(route.request.method)
        if len(calls) == 1:
            fail(route, "对话服务暂时不可用")
        else:
            route.continue_()

    pattern = re.compile(re.escape(base) + r"/api/admin/feedback/[^/]+/dialogue$")
    page.route(pattern, dialogue_route)
    page.goto(base + "/admin/?page=feedbacks")
    entry = page.locator(".cell-open, .fb-card-open").first
    entry.click()
    drawer = page.locator(".drawer")
    expect(drawer.get_by_text("对话记录加载失败：对话服务暂时不可用", exact=True)).to_be_visible()
    reply = drawer.get_by_role("textbox", name="回复内容", exact=True)
    text = "回归草稿：请保留尚未发送的排查说明。"
    reply.fill(text)
    drawer.get_by_role("button", name="重试", exact=True).click()
    expect(drawer.get_by_text("对话记录加载失败：对话服务暂时不可用", exact=True)).to_have_count(0)
    expect(reply).to_have_value(text)
    check("对话 GET 失败可重试且保留回复草稿", len(calls) >= 2)
    reply.press("Escape")
    confirmation = page.get_by_role("dialog", name="放弃未保存的内容？", exact=True)
    expect(confirmation).to_be_visible()
    confirmation.get_by_role("button", name="取消", exact=True).click()
    expect(reply).to_have_value(text)
    expect(reply).to_be_focused()
    check("回复草稿 Escape 关闭需确认，取消后保留输入和焦点", True)
    drawer.get_by_role("button", name="关闭", exact=True).click()
    expect(confirmation).to_be_visible()
    confirmation.get_by_role("button", name="取消", exact=True).click()
    expect(reply).to_have_value(text)
    check("关闭按钮同样保护回复草稿，取消保留输入", True)
    shot(page, "04-dialogue-draft-preserved")
    drawer.get_by_role("button", name="关闭", exact=True).click()
    confirmation.get_by_role("button", name="放弃并关闭", exact=True).click()
    expect(drawer).to_have_count(0)
    expect(entry).to_be_focused()
    check("明确放弃后抽屉关闭且焦点回到详情入口", True)
    entry.click()
    expect(page.get_by_role("textbox", name="回复内容", exact=True)).to_have_value("")
    check("明确放弃后的回复不会在重新打开时残留", True)
    page.locator(".drawer").get_by_role("button", name="关闭", exact=True).click()
    page.unroute(pattern, dialogue_route)


def apps_draft(page, base: str, api) -> None:
    st, _ = api.call("POST", "/api/admin/apps", {
        "appId": "com.experience.second", "name": "体验回归第二软件", "allowedOrigins": [],
        "kaneoProjectId": "p-e2e", "kaneoColumnSlug": "triage",
    })
    check("创建第二软件夹具", st == 201)
    st, before = api.call("GET", "/api/admin/apps")
    expected_names = {a["appId"]: a["name"] for a in before["apps"]}
    page.goto(base + "/admin/?page=apps")
    first_row = page.get_by_role("row").filter(has_text=helpers.SEED_APP_NAME)
    second_row = page.get_by_role("row").filter(has_text="体验回归第二软件")
    first_row.get_by_role("button", name="配置", exact=True).click()
    name = page.get_by_label("名称", exact=True)
    expect(name).to_have_value(helpers.SEED_APP_NAME)
    name.fill("第一软件未保存草稿")
    second_row.get_by_role("button", name="配置", exact=True).click()
    confirmation = page.get_by_role("dialog", name="放弃未保存的修改？", exact=True)
    expect(confirmation).to_be_visible()
    confirmation.get_by_role("button", name="取消", exact=True).click()
    expect(name).to_have_value("第一软件未保存草稿")
    expect(page.get_by_label("appId", exact=True)).to_have_value(helpers.SEED_APP_ID)
    check("软件 dirty 切换取消后仍编辑原软件，草稿保持", True)
    second_row.get_by_role("button", name="配置", exact=True).click()
    confirmation.get_by_role("button", name="放弃修改并继续", exact=True).click()
    expect(name).to_have_value("体验回归第二软件")
    expect(page.get_by_label("appId", exact=True)).to_have_value("com.experience.second")
    check("软件 dirty 切换确认后载入目标软件", True)
    name.fill("第二软件未保存草稿")
    page.get_by_role("button", name="新增软件", exact=True).click()
    expect(confirmation).to_be_visible()
    confirmation.get_by_role("button", name="取消", exact=True).click()
    expect(name).to_have_value("第二软件未保存草稿")
    check("编辑已有软件时新增入口保护未保存修改", True)
    page.get_by_role("button", name="新增软件", exact=True).click()
    confirmation.get_by_role("button", name="放弃修改并继续", exact=True).click()
    expect(name).to_have_value("")
    expect(page.get_by_label("appId", exact=True)).to_have_value("")
    name.fill("尚未创建的软件草稿")
    first_row.get_by_role("button", name="配置", exact=True).click()
    expect(confirmation).to_be_visible()
    confirmation.get_by_role("button", name="取消", exact=True).click()
    expect(name).to_have_value("尚未创建的软件草稿")
    check("新建软件草稿也受到切换保护", True)
    shot(page, "05-apps-new-draft-preserved")
    first_row.get_by_role("button", name="配置", exact=True).click()
    confirmation.get_by_role("button", name="放弃修改并继续", exact=True).click()
    expect(name).to_have_value(helpers.SEED_APP_NAME)
    st, saved = api.call("GET", "/api/admin/apps")
    names = {a["appId"]: a["name"] for a in saved["apps"]}
    check("放弃与取消均未写入服务器或意外创建软件", st == 200 and names == expected_names)


def run() -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    helpers.BASE = base
    helpers.KANEO_PORT, helpers.AI_PORT = KANEO_PORT, AI_PORT
    helpers.check = check
    errors = []
    browser_errors = []
    started = time.time()
    page = None
    exit_code = 0
    try:
        check("后台构建产物存在", (ADMIN_DIST / "index.html").is_file())
        for label, mock_port, path in (("Kaneo", KANEO_PORT, "/__mock/state"), ("AI", AI_PORT, "/__mock/ai-calls")):
            with urllib.request.urlopen(f"http://127.0.0.1:{mock_port}{path}", timeout=3) as response:
                json.load(response)
                check(f"复用隔离 {label} mock", response.status == 200)
        with tempfile.TemporaryDirectory(prefix="fb-admin-experience-") as data_dir:
            env = {k: v for k, v in os.environ.items() if not k.startswith("FEEDBACK_ASSIST")}
            env.update(
                FEEDBACK_MASTER_KEY=secrets.token_hex(32), FEEDBACK_ADMIN_USER=helpers.ADMIN_USER,
                FEEDBACK_ADMIN_PASSWORD=helpers.ADMIN_PASS, FEEDBACK_ADMIN_DIST=str(ADMIN_DIST),
                FEEDBACK_DATA_DIR=data_dir, FEEDBACK_PORT=str(port), FEEDBACK_COOKIE_SECURE="0",
                FEEDBACK_UPDATE_MANIFEST_URL="off", FEEDBACK_UPDATE_CHECK_INTERVAL_MS="0", NODE_ENV="production",
            )
            # 不继承真实部署 public URL；所有测试目标严格由本地随机端口构造。
            env.pop("FEEDBACK_PUBLIC_URL", None)
            with (SHOTS / "server.log").open("w") as log:
                proc = subprocess.Popen(["npx", "tsx", "src/index.ts"], cwd=ROOT / "apps/server",
                                        env=env, stdout=log, stderr=subprocess.STDOUT)
                try:
                    check("临时数据库服务启动", helpers.wait_http(base + "/healthz"))
                    api = helpers.Api()
                    st, _ = api.call("POST", "/api/auth/login", {
                        "username": helpers.ADMIN_USER, "password": helpers.ADMIN_PASS,
                    })
                    check("隔离管理员 API 登录", st == 200)
                    with sync_playwright() as playwright:
                        kwargs = {"headless": True}
                        if os.environ.get("FB_E2E_CHROMIUM"):
                            kwargs["executable_path"] = os.environ["FB_E2E_CHROMIUM"]
                        browser = playwright.chromium.launch(**kwargs)
                        try:
                            ctx, page = logged_page(browser, base)
                            page.on("pageerror", lambda error: browser_errors.append(str(error)))
                            try:
                                empty_list(page, base)
                            except Exception:
                                shot(page, "failure-initial-list")
                                raise
                            helpers.seed(api)
                            for name, scenario in (
                                ("password-reset", lambda: password_reset(page, base, api)),
                                ("dialogue-draft", lambda: dialogue_draft(page, base)),
                                ("apps-draft", lambda: apps_draft(page, base, api)),
                            ):
                                try:
                                    scenario()
                                except Exception as exc:
                                    errors.append({"scenario": name, "error": str(exc), "traceback": traceback.format_exc()})
                                    RESULTS.append({"name": name + " 场景完成", "ok": False, "detail": str(exc)})
                                    shot(page, "failure-" + name)
                                    # 每个后续场景重新建立页面，避免残留弹窗/故障注入干扰。
                                    ctx.close()
                                    ctx, page = logged_page(browser, base)
                                    page.on("pageerror", lambda error: browser_errors.append(str(error)))
                            check("页面无 JavaScript 运行时异常", not browser_errors, str(browser_errors))
                            ctx.close()
                        finally:
                            browser.close()
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
    except Exception as exc:
        errors.append({"scenario": "harness", "error": str(exc), "traceback": traceback.format_exc()})
        RESULTS.append({"name": "验证前置或初始列表场景完成", "ok": False, "detail": str(exc)})
        exit_code = 2
    passed = sum(item["ok"] for item in RESULTS)
    report = {
        "adminDist": str(ADMIN_DIST), "shots": str(SHOTS), "base": base,
        "adminIndexSha256": hashlib.sha256((ADMIN_DIST / "index.html").read_bytes()).hexdigest()
        if (ADMIN_DIST / "index.html").is_file() else None,
        "durationSeconds": round(time.time() - started, 2),
        "isolation": {"temporaryDatabase": True, "headlessChromium": True, "updateManifest": "off",
                      "assist": "disabled", "mockPorts": [KANEO_PORT, AI_PORT]},
        "coverage": ["initial-app-list-failure-retry-empty", "password-reset-failure-mask-raw-value",
                     "password-reset-delayed-duplicate-enter", "successful-reset-list-readback-failure-focus",
                     "dialogue-load-retry-draft", "drawer-escape-button-draft-protection-focus",
                     "apps-switch-existing-and-new-draft-protection"],
        "notCovered": ["deletion", "full-business-lifecycle", "real-AI-or-Kaneo", "visual-matrix"],
        "fixtureNotes": ["初始空列表场景暂时让后台反馈组件的自动注册 POST 返回503，以维持真实空数据库；之后恢复正常 API。",
                         "延迟密码请求只暂停在浏览器网络边界，释放后由真实本地 API 完成重置；新密码用真实登录验证。"],
        "summary": {"total": len(RESULTS), "passed": passed, "failed": len(RESULTS) - passed},
        "results": RESULTS, "errors": errors, "browserErrors": browser_errors,
    }
    (SHOTS / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[SUMMARY] {passed}/{len(RESULTS)}；{SHOTS / 'report.json'}", flush=True)
    return exit_code or (1 if errors or passed != len(RESULTS) else 0)


if __name__ == "__main__":
    sys.exit(run())
