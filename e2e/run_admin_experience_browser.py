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



def triage_navigation(page, base: str) -> None:
    page.goto(base + "/admin/")
    entries = page.locator(".fb-table .cell-open")
    expect(entries.first).to_be_visible()
    expect(page.locator("th.col-user")).to_be_visible()
    expect(page.locator(".feedback-detail-pane")).to_have_count(0)
    entries.first.click()
    current_url = page.url
    drawer = page.locator(".drawer")
    drawer.get_by_role("button", name="写回复", exact=True).click()
    reply = drawer.get_by_role("textbox", name="回复内容")
    expect(reply).to_be_focused()
    reply.fill("待复核的回复草稿")
    entries.nth(1).click()
    confirm = page.get_by_role("dialog", name="放弃未保存的内容？")
    expect(confirm).to_be_visible()
    expect(page).to_have_url(current_url)
    confirm.get_by_role("button", name="取消").click()
    expect(reply).to_have_value("待复核的回复草稿")
    expect(entries.first).to_have_attribute("aria-current", "true")
    entries.nth(1).click()
    confirm.get_by_role("button", name="放弃并切换").click()
    expect(entries.nth(1)).to_have_attribute("aria-current", "true")
    expect(reply).to_have_value("")
    second_url = page.url
    pending = []
    messages = re.compile(re.escape(base) + r"/api/admin/feedback/[^/]+/messages$")
    page.route(messages, lambda route: pending.append(route))
    reply.fill("已收到，正在核对导出流程。")
    drawer.get_by_role("button", name="回复", exact=True).click()
    expect(reply).to_be_disabled()
    entries.first.click()
    expect(page).to_have_url(second_url)
    expect(entries.nth(1)).to_have_attribute("aria-current", "true")
    expect(confirm).to_have_count(0)
    assert len(pending) == 1
    pending.pop().continue_()
    expect(reply).to_have_value("")
    expect(drawer.get_by_text("已收到，正在核对导出流程。", exact=True)).to_be_visible()
    page.unroute(messages)
    check("回复发送中留在原反馈，真实提交后对话可读回", True)
    drawer.get_by_role("button", name="关闭", exact=True).click()
    expect(entries.nth(1)).to_be_focused()
    check("桌面全宽列表、写回复入口、取消保留草稿、确认切换及关闭后焦点恢复", True)

    page.set_viewport_size({"width": 390, "height": 844})
    try:
        search = page.get_by_role("searchbox", name="搜索反馈")
        expect(search).to_be_visible()
        toggle = page.locator("#fb-filter-toggle")
        expect(toggle).to_have_attribute("aria-expanded", "false")
        search.fill("CSV")
        cards = page.locator(".fb-card-open")
        expect(cards).to_have_count(1)
        expect(cards.first).to_contain_text("CSV")
        toggle.click()
        page.get_by_label("软件筛选").select_option(helpers.SEED_APP_ID)
        toggle.click()
        expect(search).to_have_value("CSV")
        expect(page.get_by_role("region", name="已生效筛选")).to_contain_text(helpers.SEED_APP_NAME)
        page.get_by_role("button", name="清除全部筛选", exact=True).click()
        expect(cards).to_have_count(3)
        check("手机可直接搜索，与软件筛选组合后能清除并恢复完整列表", True)
    finally:
        page.set_viewport_size({"width": 1440, "height": 900})


def list_failure_retry(page, base: str) -> None:
    for name, endpoint, title in (
        ("accounts", "/api/admin/users", "账号列表未加载"),
        ("sessions", "/api/auth/sessions", "会话列表未加载"),
    ):
        path = base + endpoint
        page.route(path, lambda route: fail(route, "读取列表暂时失败"))
        page.goto(base + "/admin/?page=" + name)
        expect(page.get_by_text(title, exact=True)).to_be_visible()
        expect(page.locator(".skeleton-rows")).to_have_count(0)
        page.unroute(path)
        page.get_by_role("button", name="重试", exact=True).click()
        expect(page.locator("tbody tr").first).to_be_visible()
        expect(page.get_by_text(title, exact=True)).to_have_count(0)
        check(title + "时停止骨架，重试真实读取恢复列表", True)

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



def directories(page, base: str, api) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    try:
        for slug, label, title in (
            ("accounts", "搜索用户名", "没有匹配的账号"),
            ("apps", "搜索软件名称或 appId", "没有匹配的软件"),
            ("sessions", "搜索设备或会话名称", "没有匹配的会话"),
        ):
            page.goto(base + "/admin/?page=" + slug)
            find = page.get_by_role("searchbox", name=label)
            expect(page.locator(".directory-table tbody tr").first).to_be_visible()
            assert page.locator(".directory-table").evaluate("el => el.getBoundingClientRect().width <= innerWidth")
            find.fill("zz-no-matches-zz")
            expect(page.get_by_text(title, exact=True)).to_be_visible()
            page.get_by_role("button", name="清除筛选", exact=True).click()
            expect(page.locator(".directory-table tbody tr").first).to_be_visible()
            if slug == "accounts":
                row = page.get_by_role("row").filter(has_text=helpers.USER_NAME)
                limit = row.get_by_role("textbox", name=helpers.USER_NAME + " 每日上限")
                limit.fill("")
                row.get_by_role("button", name="保存", exact=True).click()
                expect(row.get_by_role("alert")).to_be_visible()
                limit.fill("19")
                row.get_by_role("button", name="保存", exact=True).click()
                expect(page.get_by_text("每日上限已更新", exact=True)).to_be_visible()
                _, users = api.call("GET", "/api/admin/users")
                assert next(u for u in users["users"] if u["username"] == helpers.USER_NAME)["dailyLimit"] == 19
            if slug == "apps":
                find.fill(helpers.SEED_APP_ID)
                page.get_by_role("button", name="配置", exact=True).click()
                expect(page.get_by_role("heading", name=re.compile(r"配置：\s*" + re.escape(helpers.SEED_APP_NAME)))).to_be_focused()
            check("手机目录搜索、恢复与完整卡片：" + slug, True)
    finally:
        page.set_viewport_size({"width": 1440, "height": 900})


def changelog_edit(page, base: str, api) -> None:
    page.goto(base + "/admin/?page=feedbacks")
    nav = page.locator(".shell-nav")
    release_list = base + "/api/admin/changelog?*"
    page.route(release_list, lambda route: fail(route, "版本记录暂时不可用"))
    nav.get_by_role("button", name="更新日志", exact=True).click()
    expect(page.get_by_text("版本记录暂时不可用", exact=True)).to_be_visible()
    expect(page.locator("#changelog-version-input")).to_have_count(0)
    page.unroute(release_list)
    page.get_by_role("button", name="重试", exact=True).click()
    version = page.locator("#changelog-version-input")
    version.fill("1.2.3")
    page.locator("#changelog-summary").fill("手机端可以直接查找账号")
    page.get_by_placeholder("例如：修复导出文件时偶发的闪退").fill("改善手机账号操作")
    page.get_by_role("button", name="预览当前版本").click()
    preview = page.get_by_role("dialog", name="展示预览")
    expect(preview.get_by_text("改善手机账号操作", exact=True)).to_be_visible()
    preview.get_by_role("button", name="返回编辑").click()
    page.get_by_role("button", name="新建版本", exact=True).click()
    page.get_by_role("dialog", name="放弃本版本的修改？").get_by_role("button", name="取消").click()
    expect(version).to_have_value("1.2.3")
    nav.get_by_role("button", name="会话", exact=True).click()
    page.get_by_role("dialog", name="离开当前页面？").get_by_role("button", name="取消").click()
    with page.expect_event("dialog") as pending:
        page.evaluate("() => { setTimeout(() => history.back(), 0); }")
    pending.value.dismiss()
    expect(page).to_have_url(re.compile(r"page=changelog"))
    expect(version).to_have_value("1.2.3")
    with page.expect_event("dialog") as leaving:
        page.evaluate("() => { setTimeout(() => location.reload(), 0); }")
    assert leaving.value.type == "beforeunload"
    leaving.value.dismiss()
    expect(version).to_have_value("1.2.3")
    page.get_by_role("button", name="保存草稿").click()
    expect(page.get_by_text("草稿已保存，尚未对外发布", exact=True)).to_be_visible()
    app = page.locator("#changelog-app").input_value()
    _, data = api.call("GET", "/api/admin/changelog?appId=" + app)
    assert any(x["version"] == "1.2.3" and not x["publishedAt"] for x in data["items"])
    nav.get_by_role("button", name="反馈", exact=True).click()
    quick = page.get_by_role("button", name="待管理处理", exact=True)
    quick.click()
    expect(page.get_by_label("工单沟通状态筛选")).to_have_value("waiting_admin")
    quick.click()
    expect(page.get_by_label("工单沟通状态筛选")).to_have_value("")
    check("版本读取失败可重试，日志预览、跨页/后退/刷新取消保留草稿、保存并读回", True)
    active = page.get_by_role("tab", selected=True)
    active.press("End")
    expect(active).to_contain_text("回收站")
    expect(active).to_be_focused()
    active.press("Home")
    expect(active).to_contain_text("收件箱")
    check("待管理处理快捷筛选、键盘切换反馈区域及焦点", True)

    panel = page.get_by_role("tabpanel", name=re.compile("收件箱"))
    menu_button = panel.get_by_role("button", name="更多操作", exact=True).first
    menu_button.press("ArrowDown")
    menu = page.get_by_role("menu")
    expect(menu.get_by_role("menuitem").first).to_be_focused()
    menu.press("Escape")
    expect(menu).to_have_count(0)
    expect(menu_button).to_be_focused()
    menu_button.click()
    menu.get_by_role("menuitem", name="移入回收站").click()
    modal = page.get_by_role("dialog", name=re.compile("移入回收站"))
    modal.get_by_role("button", name="取消").click()
    expect(menu_button).to_be_focused()
    check("行菜单键盘打开和退出、确认弹窗取消后归焦", True)


def connections_and_settings(page, base: str, api) -> None:
    url = base + "/api/admin/connection/kaneo"
    page.route(url, lambda route: fail(route, "Kaneo 配置读取暂时失败"))
    page.goto(base + "/admin/?page=connections")
    k = page.get_by_role("region", name="Kaneo 连接")
    a = page.get_by_role("region", name="AI 连接")
    expect(k.get_by_role("alert")).to_be_visible()
    name = a.get_by_label("模型", exact=True)
    name.fill("mock-new-model")
    expect(a.get_by_role("button", name="连接测试", exact=True)).to_be_disabled()
    page.unroute(url)
    k.get_by_role("button", name="重试", exact=True).click()
    expect(k.locator("#kb")).to_be_visible()
    expect(name).to_have_value("mock-new-model")
    a.get_by_role("button", name="保存", exact=True).click()
    expect(a.get_by_text("AI 配置已保存", exact=True)).to_be_visible()
    _, data = api.call("GET", "/api/admin/connection/ai")
    assert data["model"] == "mock-new-model" and data["apiKeySet"]
    a.get_by_role("button", name="连接测试", exact=True).click()
    expect(a.get_by_role("status")).to_contain_text("AI 连通正常")
    check("连接卡失败独立重试、草稿隔离、保留原密钥、保存新模型并测试本地模拟服务", True)

    page.goto(base + "/admin/?page=settings")
    save = page.get_by_role("button", name="保存", exact=True)
    page.locator("#me-current").fill("temporary-draft")
    expect(save).to_be_disabled()
    page.locator("#me-username").fill("new-draft")
    expect(save).to_be_enabled()
    expect(page.locator(".profile-text b")).to_have_text(helpers.ADMIN_USER)
    page.locator(".shell-nav").get_by_role("button", name="系统更新").click()
    page.get_by_role("button", name="放弃修改并离开").click()
    expect(page.get_by_role("heading", name="系统更新")).to_be_visible()
    expect(page.get_by_role("button", name="检查更新")).to_be_disabled()
    expect(page.get_by_text("更新检查已关闭，暂无发布说明。")).to_be_visible()
    check("管理员设置拦截无改动保存；离开可取消草稿；关闭版本源时检查状态一致", True)

def session_revoke(page, base: str, api) -> None:
    client = "回归专用测试设备"
    response, details = api.call("POST", "/api/auth/login", {
        "username": helpers.ADMIN_USER, "password": helpers.ADMIN_PASS,
        "clientLabel": client, "appId": helpers.SEED_APP_ID,
    })
    assert response == 200 and "token" in details
    page.goto(base + "/admin/?page=sessions")
    page.get_by_label("会话类型筛选").select_option("client")
    row = page.get_by_role("row").filter(has_text=client)
    row.get_by_role("button", name="撤销").click()
    confirm = page.get_by_role("dialog", name="撤销该会话？")
    expect(confirm).to_contain_text(client)
    confirm.get_by_role("button", name="取消").click()
    expect(row).to_be_visible()
    row.get_by_role("button", name="撤销").click()
    confirm.get_by_role("button", name="撤销", exact=True).click()
    expect(row).to_have_count(0)
    devices = page.context.request.get(base + "/api/auth/sessions").json()["sessions"]
    assert all(item.get("clientLabel") != client for item in devices)
    others = sum(not item["current"] for item in devices)
    page.get_by_role("button", name="撤销其它全部会话").click()
    bulk = page.get_by_role("dialog", name="撤销其它全部会话？")
    expect(bulk).to_contain_text(f"以外的 {others} 个会话")
    bulk.get_by_role("button", name="取消").click()
    assert page.context.request.get(base + "/api/auth/session").ok
    check("按类型查找会话，取消后保留、确认后撤销指定测试设备，批量确认显示真实数量", True)


def login_and_logout(browser, base: str) -> None:
    with browser.new_context(viewport={"width": 1440, "height": 900}) as ctx:
        page = ctx.new_page()
        session_url = base + "/api/auth/session"
        page.route(session_url, lambda r: fail(r, "会话服务暂时不可用"))
        page.goto(base + "/admin/?page=feedbacks")
        expect(page.get_by_text("暂时无法连接管理服务，请重试。")).to_be_visible()
        page.unroute(session_url)
        page.get_by_role("button", name="重试", exact=True).click()
        form = page.locator(".login-form")
        form.locator("#u").fill(helpers.USER_NAME)
        password = form.locator("#p")
        password.fill(helpers.USER_PASS)
        toggle = form.get_by_role("button", name="显示密码")
        toggle.click()
        expect(password).to_have_attribute("type", "text")
        expect(password).to_have_attribute("data-feedback-capture-mask", "")
        toggle.click()
        expect(password).to_have_attribute("type", "password")
        form.get_by_role("button", name="登录", exact=True).click()
        expect(form.get_by_text("这个账号可以提交反馈。请使用管理员账号登录工作台。")).to_be_visible()
        form.locator("#u").fill(helpers.ADMIN_USER)
        password.fill(helpers.ADMIN_PASS)
        form.get_by_role("button", name="重试登录").click()
        logout = page.get_by_role("button", name="退出登录", exact=True)
        logout_url = base + "/api/auth/logout"
        page.route(logout_url, lambda r: fail(r, "退出暂时不可用"))
        logout.click()
        expect(page.get_by_text("退出失败，当前页面已保留。请重试退出。")).to_be_visible()
        page.unroute(logout_url)
        logout.click()
        expect(form).to_be_visible()
        assert ctx.request.get(session_url).status == 401
        check("会话检查失败可重试、密码显隐、普通账号提示、管理员登录及退出失败重试", True)


def update_and_credentials(page, base: str, api) -> None:
    url = base + "/api/admin/system/update"
    status_code, status = api.call("GET", "/api/admin/system/update")
    assert status_code == 200
    status["config"]["manifestUrl"] = base + "/example-manifest"
    page.route(url, lambda r: r.fulfill(json=status))
    page.route(url + "/check", lambda r: r.fulfill(json={"check": {
        "state": "failed", "checkedAt": "2026-01-02T00:00:00Z", "failedMessage": "本地版本清单暂时不可用"
    }}))
    page.goto(base + "/admin/?page=system-update")
    page.get_by_role("button", name="检查更新").click()
    expect(page.get_by_role("alert")).to_contain_text("本地版本清单暂时不可用")
    expect(page.locator(".inline-ok")).to_have_count(0)
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
    page.get_by_role("button", name="复制更新命令").click()
    expect(page.get_by_text("已复制更新命令", exact=True)).to_be_visible()
    assert page.evaluate("navigator.clipboard.readText()") == "bash deploy/update.sh"
    check("版本源报错展示失败原因，复制按钮将完整命令写入剪贴板", True)

    page.locator(".shell-nav").get_by_role("button", name="管理员设置").click()
    new_name = helpers.ADMIN_USER + "-updated"
    page.locator("#me-username").fill(new_name)
    page.locator("#me-current").fill(helpers.ADMIN_PASS)
    page.get_by_role("button", name="保存", exact=True).click()
    login = page.locator(".login-form")
    expect(login.locator("#u")).to_have_value(new_name)
    assert api.call("GET", "/api/auth/session")[0] == 401
    login.locator("#p").fill(helpers.ADMIN_PASS)
    login.get_by_role("button", name="登录", exact=True).click()
    expect(page.locator(".profile-text b")).to_have_text(new_name)
    check("修改临时管理员名称后旧会话失效，使用预填的新名称重新登录", True)


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
                                ("login-and-logout", lambda: login_and_logout(browser, base)),
                                ("password-reset", lambda: password_reset(page, base, api)),
                                ("dialogue-draft", lambda: dialogue_draft(page, base)),
                                ("triage-navigation", lambda: triage_navigation(page, base)),
                                ("list-failure-retry", lambda: list_failure_retry(page, base)),
                                ("apps-draft", lambda: apps_draft(page, base, api)),
                                ("directories", lambda: directories(page, base, api)),
                                ("changelog-edit", lambda: changelog_edit(page, base, api)),
                                ("connections-and-settings", lambda: connections_and_settings(page, base, api)),
                                ("session-revoke", lambda: session_revoke(page, base, api)),
                                ("update-and-credentials", lambda: update_and_credentials(page, base, api)),
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
                     "feedback-full-list-switch-draft-reply-focus", "reply-in-flight-switch-guard",
                     "mobile-search-and-filters", "accounts-sessions-list-failure-retry",
                     "apps-switch-existing-and-new-draft-protection", "mobile-directories", "changelog-draft-preview-save",
                     "dirty-page-navigation", "saved-connection-tests", "settings-noop", "disabled-update-source", "session-revoke-confirm-and-readback",
                     "login-role-logout-retry", "update-failure-and-clipboard", "credential-change-and-relogin"],
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
