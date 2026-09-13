#!/usr/bin/env python3
# Flutter Web 实测（T1-B）：慢会话查询在途时关闭/重开 → 旧结果丢弃、结束后
# 立即补发一次；并验证「调额恢复」≤30 秒（30 秒轮询规则）。
#
# 前置（详见 VERIFICATION.md 第 7 轮）：
#   1) bash scripts/start-local.sh（真实服务端 :8787）
#   2) com.example.demo 登记 allowedOrigins=["http://localhost:5300"]
#   3) cd examples/flutter && flutter build web
#      && python3 -m http.server 5300 --bind 127.0.0.1 \
#           --directory build/web &
#   4) FEEDBACK_ADMIN_USER=… FEEDBACK_ADMIN_PASSWORD=… \
#        python3 e2e/flutter_web_slow_session.py
#
# 凭据只从环境变量读取；测试账号口令在运行时随机生成（仅存在于本地测试服务）。
# 驱动方式：坐标驱动（与第 6 轮相同；1280x800 视口）。Flutter Web 发布产物 +
# 系统 Chrome + 真实跨源服务端。慢会话用 Playwright route 在网络层延迟
# 第一次 /api/auth/session（等价于页面侧慢网络）。断言全部来自真实网络层
# 与服务端状态；每步截图存 e2e/shots/FW-*.png 供视觉核验。
import os
import secrets
import sys
import time

import requests
from playwright.sync_api import sync_playwright

SERVICE = "http://127.0.0.1:8787"
APP_URL = "http://localhost:5300"
ADMIN_USER = os.environ.get("FEEDBACK_ADMIN_USER", "")
ADMIN_PASS = os.environ.get("FEEDBACK_ADMIN_PASSWORD", "")
SHOT_DIR = os.path.join(os.path.dirname(__file__), "shots")

# 1280x800 视口下的关键坐标（灵感球默认落点 + 面板布局，见 VERIFICATION 第 7 轮）。
ORB = (1236, 576)
TEXTAREA = (1080, 400)
LOGIN_MAIN = (1189, 767)      # 未登录主按钮「登录并提交」
USER_FIELD = (1080, 623)      # 登录表单·用户名
PASS_FIELD = (1080, 673)      # 登录表单·密码
LOGIN_CONFIRM = (959, 716)    # 登录表单·确认按钮
CONTINUE = (1080, 516)        # 归档视图「继续反馈」
SUBMIT = (1199, 767)          # 已登录主按钮「提交」
CLOSE = (1251, 31)            # 面板右上角 ✕

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), str(detail)[:300]))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}"[:400], flush=True)


def main():
    assert ADMIN_USER and ADMIN_PASS, "缺少 FEEDBACK_ADMIN_USER / FEEDBACK_ADMIN_PASSWORD（先 source .env）"
    admin = requests.Session()
    r = admin.post(
        f"{SERVICE}/api/auth/login",
        json={"username": ADMIN_USER, "password": ADMIN_PASS},
        timeout=10,
    )
    assert r.status_code == 200, f"管理员登录失败：{r.status_code}"

    # 隔离测试账号（dailyLimit=1：登录自动续交后立刻用尽，便于验证调额恢复）；
    # 口令运行时随机生成，测试结束后禁用账号并撤销全部会话。
    username = f"fwweb-{int(time.time() * 1000)}"
    password = "fwweb-" + secrets.token_hex(8)
    r = admin.post(
        f"{SERVICE}/api/admin/users",
        json={"username": username, "password": password, "dailyLimit": 1},
        timeout=10,
    )
    assert r.status_code == 201, f"创建测试账号失败：{r.status_code} {r.text[:200]}"
    user_id = r.json()["id"]

    def remaining():
        r2 = admin.get(f"{SERVICE}/api/admin/users", timeout=10)
        for u in r2.json()["users"]:
            if u["username"] == username:
                return u["remaining"]
        return -1

    def set_limit(n):
        r2 = admin.patch(
            f"{SERVICE}/api/admin/users/{user_id}",
            json={"dailyLimit": n, "enabled": True},
            timeout=10,
        )
        assert r2.status_code == 200, f"调额失败：{r2.status_code}"

    session_requests = []   # /api/auth/session 请求时间戳
    feedback_posts = []     # /api/feedback POST 时间戳

    def _record(req):
        if req.url.endswith("/api/auth/session"):
            session_requests.append(time.time())
        elif req.url.endswith("/api/feedback") and req.method == "POST":
            feedback_posts.append(time.time())

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("request", _record)

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def wait_until(cond, timeout_s=60):
            # 必须用 page.wait_for_timeout 步进：sync Playwright 只在
            # Playwright 调用期间派发事件回调（time.sleep 会饿死事件队列）。
            end = time.time() + timeout_s
            while time.time() < end:
                if cond():
                    return True
                page.wait_for_timeout(400)
            return cond()

        # 页面侧慢网络：只延迟第一次 /api/auth/session 的 fetch（6s）。
        # （8s）# Flutter Web 的 package:http 在 Web 上走 fetch；挂起即等价于请求在途
        # （Dart 侧 Future 未落定，额度在途占用成立），且请求尚未出网。
        page.add_init_script("""
          (() => {
            const orig = window.fetch.bind(window);
            let armed = false;
            // 由测试在「慢会话阶段」开始时手动武装（先前的额度轮询不得被延迟）。
            window.__fbArmSessionDelay = () => { armed = true; };
            window.fetch = async (input, init) => {
              const url = String(input && input.url ? input.url : input);
              if (armed && url.includes('/api/auth/session')) {
                armed = false;
                await new Promise((r) => setTimeout(r, 8000));
              }
              return orig(input, init);
            };
          })();
        """)

        page.goto(APP_URL, wait_until="load")
        page.wait_for_selector("flutter-view", timeout=60000)
        page.wait_for_timeout(6000)

        # ---- 1) 灵感球呼出（先截图后开面板）→ 草稿 → 原位登录 → 自动续交 ----
        page.mouse.click(*ORB)
        page.wait_for_timeout(4500)
        page.mouse.click(*TEXTAREA)
        page.wait_for_timeout(300)
        page.keyboard.type("Flutter Web 慢会话验证", delay=15)
        shot("FW-01-panel.png")
        page.mouse.click(*LOGIN_MAIN)
        page.wait_for_timeout(1000)
        page.mouse.click(*USER_FIELD)
        page.keyboard.type(username, delay=15)
        page.mouse.click(*PASS_FIELD)
        page.keyboard.type(password, delay=15)
        shot("FW-02-login-form.png")
        page.mouse.click(*LOGIN_CONFIRM)
        ok = wait_until(lambda: len(feedback_posts) >= 1, timeout_s=60)
        # 等面板内轮询走到「已归档」（AI mock 处理需 2s+4s 两个轮询拍），
        # 否则「继续反馈」按钮尚未出现，点击会落空。
        page.wait_for_timeout(9000)
        check("FW 原位登录成功并自动续交 1 次（真实跨源服务端）",
              ok and remaining() == 0, f"posts={len(feedback_posts)} remaining={remaining()}")
        shot("FW-03-archived.png")

        # ---- 2) 额度用尽 → 后台调额 → ≤30 秒轮询恢复提交（不重开面板）----
        page.mouse.click(*CONTINUE)  # 回到撰写视图
        page.wait_for_timeout(1000)
        # 首条草稿已被自动续交消费：输入新草稿（提交按钮要求非空正文）。
        page.mouse.click(*TEXTAREA)
        page.wait_for_timeout(300)
        page.keyboard.type("调额恢复后第二次提交", delay=15)
        shot("FW-04-exhausted.png")
        set_limit(3)
        posts_before = len(feedback_posts)
        t_set = time.time()
        ok = wait_until(lambda: len(session_requests) >= 1, timeout_s=40)
        check("FW 额度用尽后 30 秒规则轮询会话（跨过调额即恢复）", ok,
              f"session_polls={len(session_requests)} in {time.time()-t_set:.1f}s")
        page.mouse.click(*SUBMIT)
        ok = wait_until(lambda: len(feedback_posts) >= posts_before + 1, timeout_s=30)
        check("FW 调额恢复：面板未重开即成功再次提交（服务端第 2 条）",
              ok and remaining() == 1,
              f"posts={len(feedback_posts)} remaining={remaining()}")
        shot("FW-05-recovered.png")

        # ---- 3) 慢会话在途：关闭 → 重开 → 旧结果丢弃 → 立即补发一次 ----
        # 页面侧延迟期间请求尚未出网（计数为 0），Dart 侧 Future 已挂起
        # （在途占用成立）；A 出网返回后被序号校验丢弃，随即立即补发一次 B。
        # 武装慢会话延迟（只影响接下来的第一次会话查询）。
        page.evaluate("() => window.__fbArmSessionDelay()")
        mark_s, mark_f = len(session_requests), len(feedback_posts)

        def s_count():
            return len(session_requests) - mark_s

        t_arm = time.time()
        page.mouse.click(*CLOSE)  # 关闭面板
        page.wait_for_timeout(700)
        page.mouse.click(*ORB)    # 灵感球：额度查询 A 立即发出（send 被页面侧挂起 8s）
        page.wait_for_timeout(400)

        # A 在途（挂起未出网）：再次关闭 → 重开，被在途占用挡下 → 登记待补发。
        page.mouse.click(*CLOSE)
        page.wait_for_timeout(400)
        page.mouse.click(*ORB)
        page.wait_for_timeout(2600)  # 捕获 + 面板打开：刷新被在途占用挡下
        check("FW 查询在途时重开：不并发发起第二个会话查询（A 挂起未出网）",
              s_count() == 0, f"count={s_count()}")

        # A 出网（灵感球点击后约 8s）并立即返回：旧结果被序号校验丢弃，
        # 随即立即补发一次 B（A→B 同窗口；缺失实现时只有 A 一条，
        # 下一条要等 30 秒 / resetAt）。
        ok = wait_until(lambda: s_count() >= 2, timeout_s=20)
        a_to_b = (session_requests[-1] - session_requests[-2]) if len(session_requests) >= 2 else 999
        check("FW 旧查询出网后旧结果丢弃并立即补发一次（A→B 同窗口，而非 30s/resetAt）",
              ok and s_count() == 2 and a_to_b < 2.0,
              f"count={s_count()} a_to_b={a_to_b:.2f}s")
        page.wait_for_timeout(1500)
        check("FW 补发不重复（此后无新增会话查询）", s_count() == 2, f"count={s_count()}")
        check("FW 慢会话阶段无多余提交", len(feedback_posts) - mark_f == 0,
              f"posts={len(feedback_posts)}")
        shot("FW-06-reissue.png")

        page.close()
        browser.close()

    # 清理：禁用测试账号（撤销其全部会话）。
    admin.patch(
        f"{SERVICE}/api/admin/users/{user_id}",
        json={"enabled": False},
        timeout=10,
    )

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n=== Flutter Web 实测：{len(results) - len(failed)}/{len(results)} 通过 ===")
    if failed:
        print(f"失败：{failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
