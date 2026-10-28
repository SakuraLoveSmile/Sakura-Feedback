#!/usr/bin/env python3
"""
管理网站深色模式与 UI 优化 —— 真实浏览器验收（T1 深色模式 / T2 UI·响应式·无障碍 / 业务回归）。

冻结契约：/tmp/feedback-admin-ui/CONTRACT.md；断言清单：/tmp/feedback-admin-ui/agent-d.md。

做法沿用 e2e/run_admin_delete_browser.py 骨架：真实构建产物（apps/admin/dist，
可用 FB_E2E_ADMIN_DIST 指向其它产物目录）+ 真实服务进程（tsx src/index.ts）
+ mock 外部服务（mock-external.mjs：Kaneo :8898 / AI :8899）+ Playwright sync_api；
临时数据目录 + 动态空闲端口 + try/finally 进程清理。
种子数据一律脚本内 API 创建（管理 API + 普通账号提交），不碰真实服务。

断言分级（产品并行开发期间语义）：
- check()           harness 关键前置与「业务回归」硬断言：失败记 FAIL 并中断当节；
- record()          非中断硬断言：失败记 FAIL 但继续执行（F2.* 反馈页观感门槛主要走这里）；
- spec()            T1/T2 契约断言：满足记 PASS；不满足按「待实现」记入 pending（不计失败）；
- spec(soft=True)   度量项（对比度等）：不满足记 warnings（soft 警告，同样不计失败）。
report.json 分 results / pending / warnings 三段，便于区分「harness 验证」与「产品待实现」。
退出码：2=前置缺失，1=硬断言（check/record）失败，0=全部硬断言与契约断言通过（pending 阻止通过）。

用法：python3 e2e/run_admin_ui_browser.py [--browser chromium] [--headed]
环境：FB_E2E_ADMIN_DIST 指定管理页产物目录（默认 apps/admin/dist）；
     FB_E2E_CHROMIUM 指定浏览器可执行文件；
     FB_E2E_SHOTS    指定截图与 report.json 输出目录；未指定时每次运行写入
                     e2e/shots/admin-ui-f2-<启动时间戳 yyyymmdd-HHMMSS>/ 独立目录
                     （历史目录 e2e/shots/admin-ui/ 不再写入）；
     E2E_KANEO_PORT / E2E_AI_PORT 显式设置任一端口时，两个端口在运行前必须空闲——
                     被占直接 FATAL(2)，不接管未知进程、不杀占用者；
                     都未显式设置时保持「双端口均为健康 mock 则复用，否则拉起/报错」语义。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
from urllib.parse import urlsplit
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

_THIS_FILE = os.path.abspath(__file__)
# 账号呈现探针（T3 冻结接口）：纯函数模块，导入无副作用。
sys.path.insert(0, os.path.dirname(_THIS_FILE))
import test_feedback_username_probe as uname_probe

ROOT = os.sep.join(_THIS_FILE.split(os.sep)[:-2])
SERVER_DIR = os.sep.join([ROOT, "apps", "server"])
ADMIN_DIST = os.environ.get("FB_E2E_ADMIN_DIST") or os.sep.join([ROOT, "apps", "admin", "dist"])
# F2 起报告目录按运行隔离：FB_E2E_SHOTS 显式指定，否则落到带启动时间戳的新目录，
# 不覆盖 e2e/shots/admin-ui/ 里已有的历史 report.json 与截图。
_SHOTS_ENV = os.environ.get("FB_E2E_SHOTS")
SHOTS = (
    os.path.abspath(_SHOTS_ENV)
    if _SHOTS_ENV
    else os.sep.join([ROOT, "e2e", "shots", "admin-ui-f2-" + time.strftime("%Y%m%d-%H%M%S")])
)
REPORT = os.sep.join([SHOTS, "report.json"])

KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))
# 任一 mock 端口被显式指定 → 视为调用方已规划端口：运行前两端口必须空闲，
# 被占即 FATAL（不接管未知进程、不杀占用者）。都未指定时保持原有复用/报错语义。
MOCK_PORTS_EXPLICIT = "E2E_KANEO_PORT" in os.environ or "E2E_AI_PORT" in os.environ

# T1 契约：localStorage key 与控件选择器（冻结）。
THEME_KEY = "feedback.admin.theme"
THEME_SELECT = 'select[aria-label="主题"]'
SEARCH_SEL = '.filter-bar input[type="search"]'

ADMIN_PASS = "admin-" + secrets.token_hex(12)
USER_NAME = "e2e-ui-user"
USER_PASS = "user-" + secrets.token_hex(12)

SEED_APP_ID = "com.e2e.ui-seed"
SEED_APP_NAME = "E2E UI 种子软件"
UI_APP_ID = "com.e2e.ui-created"
FB_SYNC_TEXT = "UIE2E-SYNC 已同步待归档反馈"
FB_FIND_TEXT = "UIE2E-FIND 搜索目标反馈"
DRAFT_TEXT = "UIE2E-DRAFT 草稿关键词"
# 列表行匹配用短针：AI 整理后标题被截断（E2E整理：{前18字符}），不能拿整句原文做 has_text。
ROW_SYNC_NEEDLE = "UIE2E-SYNC"
ROW_FIND_NEEDLE = "UIE2E-FIND"

# ---------- F2 反馈页 UI 观感夹具 ----------
# 批量账号：dailyLimit 默认 3，批量 50+ 提交必须显式放大（上限 1,000,000）。
F2_BULK_USER = "e2e-ui-bulk"
F2_BULK_PASS = "bulk-" + secrets.token_hex(12)
F2_BULK_LIMIT = 500
# 收件箱 PAGE_SIZE=50：已有种子 inbox 1 条（sync 转已归档），再造 50 条使总量 >50 → 出现「加载更多」。
F2_BULK_COUNT = 50
F2_LONG_USER = "e2e-ui-超长用户名甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸末班车"
F2_LONG_PASS = "long-" + secrets.token_hex(12)
# 恰好 100 个连续 ASCII 字符的合法账号（服务端上限 100）：回归「无断词点账号撑破页面」。
F2_ASCII_USER = "e2e-ui-ascii-" + "a" * 87
F2_ASCII_PASS = "ascii-" + secrets.token_hex(12)
F2_LONG_APP_ID = "com.e2e.ui-long-app-name"
F2_LONG_APP_NAME = "E2E超长软件名称·验证软件列与筛选项在极端长度下的截断与换行行为-abcdefghijklmnopqrstuvwxyz0123456789"
# 不传 appName 提交 → 服务端自动发现软件，name 即 appId（构造 name==appId 行）。
F2_SAME_APP_ID = "com.e2e.ui-same-name-app"
# 行定位针：放在正文开头 → AI 标题（E2E整理：+原文前18字符）与 textPreview 都含针。
F2_NEEDLE = {
    "bulk": "UIE2E-BULK",
    "longtext": "UIE2E-LONGTEXT",
    "longapp": "UIE2E-LONGAPP",
    "sameapp": "UIE2E-SAMEAPP",
    "longuser": "UIE2E-LONGUSER",
    "asciiuser": "UIE2E-ASCIIUSER",
    "unread": "UIE2E-UNREAD",
    "waiting": "UIE2E-WAITING",
    "notitle": "UIE2E-NOTITLE",
}
F2_LONG_TEXT = F2_NEEDLE["longtext"] + " " + (
    "这是一段刻意拉长的反馈正文，用来验证标题与摘要两行 clamp 截断不会把列表行高撑破。"
    "其中包含了足够多的重复描述文字，确保超过摘要 240 字符上限与两行高度限制。"
) * 7

# ---------- Kaneo In Review：T1（软件配置冲突比较/竞态）+ T4（工单筛选计数）夹具 ----------
# 三个专用软件对象：C=竞态延迟 GET 对象、R=竞态编辑/保存对象、K=409 逐项比较对象。
# 全部 API 种子创建（列/标签取 mock Kaneo：col-1/col-2、label-bug/label-ui、项目 p-e2e/p-other）。
T1_APP_RACE_DELAY = "com.e2e.t1-race-delay"
T1_APP_RACE_EDIT = "com.e2e.t1-race-edit"
T1_APP_CONFLICT = "com.e2e.t1-conflict"
T4_APP_ID = "com.e2e.t4-filter-counts"
T4_APP_NAME = "E2E T4 筛选计数软件"
# T4 工单状态分布：inbox open×2 / waiting_admin / waiting_user / resolved / archived(open)；trash open×1。
T4_NEEDLE = "UIE2E-T4"
T4_ITEM_COUNT = 7

# ---------- 新交互契约（T1 冲突比较 UI）——集中可配置 ----------
# 锚点已与 A 交付对齐（AppsView.tsx）：比较区 data-conflict-region + fieldset[data-conflict-group]
# + radio name=conflict-{key} value=mine|theirs + data-conflict-side 双方值展示。
T1_UI = {
    # 表单字段（现有契约，稳定）
    "field_name": "#an",
    "field_appid": "#ai2",
    "field_origins": "#orig",
    "field_project": "#pid",
    "field_column": "#col",
    "status_box": ".rule-status",
    "save_button_text": ["保存配置", "创建"],
    "retry_refresh_text": "重试刷新",
    # 冲突比较区（已实现锚点）
    "conflict_region": "[data-conflict-region]",
    "conflict_group_sel": "fieldset[data-conflict-group='{key}']",
    "conflict_radio": "input[type=radio][name='conflict-{key}'][value='{side}']",
    "conflict_side_sel": "[data-conflict-side='{side}']",
    "conflict_choice_mine": "我的修改",
    "conflict_choice_latest": "最新保存",
    "conflict_apply_text": "应用比较结果",
    "conflict_exit_text": "退出比较继续编辑",
    "conflict_enter_text": "进入比较",
    "conflict_retry_read_text": "重试读取最新配置",
    "conflict_fetch_fail_hint": "读取最新配置失败",
    "conflict_save_reject_hint": "未解决",
    "conflict_needs_choice_tag": "需选择",
    "conflict_auto_mine_tag": "采用我的修改",
    "conflict_auto_theirs_tag": "采用最新保存",
    # 状态文案
    "status_conflict": "保存冲突",
    "status_saved": "已保存",
    "status_unsaved": "未保存",
    "status_refresh_fail": "刷新失败",
    "form_heading_prefix": "配置：",
}
# 比较组 key ↔ 展示名（legend 文本；target 组内按既定接口约束展示标签 id）。
T1_GROUPS = {
    "name": {"key": "name", "title": "软件名称"},
    "origins": {"key": "origins", "title": "允许来源"},
    "target": {"key": "target", "title": "默认同步目标"},
}

# ---------- FB4 布局回归（Feedback #4）：视口 × 主题矩阵 ----------
FB4_WIDTHS = (390, 767, 768, 1280)
FB4_THEMES = ("light", "dark")

results: list[tuple[str, bool, str]] = []
pending: list[tuple[str, str]] = []
warnings: list[str] = []


def check(name: str, cond: bool, detail: str = "", soft: bool = False) -> bool:
    """硬断言：失败记 FAIL 并抛 AssertionError 中断当节（soft 时只记警告）。"""
    if not cond and soft:
        warnings.append(f"{name} — {detail}")
        print(f"  WARN  {name} — {detail}", flush=True)
        return False
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    if not cond:
        raise AssertionError(f"{name} — {detail}")
    return True


def record(name: str, cond: bool, detail: str = "") -> bool:
    """非中断硬断言：失败记 FAIL 但继续执行。"""
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f" — {detail}" if detail and not cond else ""), flush=True)
    return bool(cond)


def spec(name: str, cond: bool, detail: str = "", soft: bool = False) -> bool:
    """T1/T2 契约断言：满足记 PASS；不满足按 soft 记警告、否则记「待实现」（pending）。"""
    if cond:
        results.append((name, True, detail))
        print(f"  PASS  {name}", flush=True)
        return True
    if soft:
        warnings.append(f"{name} — {detail}")
        print(f"  WARN  {name} — {detail}", flush=True)
        return False
    pending.append((name, detail or "未满足（待实现）"))
    print(f"  PEND  {name} — {detail or '未满足（待实现）'}", flush=True)
    return False


def step(name: str) -> None:
    print(f"[STEP] {name}", flush=True)


# --only 过滤：只运行标签含任一 token 的节（S1/S2 登录前置始终执行）。
ONLY_FILTER: list[str] = []


def run_section(label: str, fn) -> None:
    """一节断言：check() 失败只中断本节，其余节照常执行。"""
    if ONLY_FILTER and not any(t in label for t in ONLY_FILTER) and not label.startswith(("S1 ", "S2 ")):
        print(f"[SKIP] {label}", flush=True)
        return
    try:
        fn()
    except AssertionError as exc:
        print(f"[ABORT] {label} 中断：{exc}", flush=True)
    except Exception as exc:  # noqa: BLE001
        record(f"{label}（执行异常）", False, f"{type(exc).__name__}: {str(exc)[:200]}")


def shot(page, name: str, full_page: bool = False) -> str | None:
    os.makedirs(SHOTS, exist_ok=True)
    path = os.sep.join([SHOTS, name + ".png"])
    try:
        page.screenshot(path=path, full_page=full_page)
        print(f"  [shot] {path}", flush=True)
        return path
    except Exception as exc:  # noqa: BLE001
        print(f"  [shot!] {name}: {exc}", flush=True)
        return None


class Http:
    """带 Cookie 的 JSON 调用（管理/公开接口用）。"""

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

    def call_raw(self, method: str, url: str, body=None, headers=None):
        """同 call() 但返回原始字节——日志附件等非 JSON 端点用。"""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


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


def mock_alive() -> bool:
    """已有 mock 外部服务在跑（Kaneo/AI 健康检查均通过）时可复用，不再起第二个实例。"""
    for port in (KANEO_PORT, AI_PORT):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/__health", timeout=2) as r:
                if json.loads(r.read().decode()).get("ok") is not True:
                    return False
        except Exception:  # noqa: BLE001
            return False
    return True


def admin_login(page, base: str) -> None:
    page.goto(f"{base}/admin/", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("#u", timeout=4000)
    except Exception:  # noqa: BLE001
        pass  # 已有会话：直接落在管理页
    if page.locator("#u").count() and page.locator("#u").is_visible():
        page.fill("#u", "admin")
        page.fill("#p", ADMIN_PASS)
        page.click("form:has(#u) button[type=submit]")
    page.wait_for_selector(".nav-item:visible", timeout=20000)


def goto_view(page, view: str) -> None:
    """点击区域页签（inbox/archived/trash 对应第 1/2/3 个 .view-tab）。"""
    idx = {"inbox": 0, "archived": 1, "trash": 2}[view]
    page.locator(".view-tab").nth(idx).click()
    page.wait_for_timeout(400)


def body_text(page) -> str:
    return page.locator("body").inner_text()


# ---------- 主题/测量辅助 ----------


def dataset_theme(page):
    return page.evaluate("() => document.documentElement.dataset.theme || null")


def stored_theme(page):
    return page.evaluate(
        "() => { try { return window.localStorage.getItem(" + json.dumps(THEME_KEY) + "); } catch (e) { return null; } }"
    )


def theme_select_count(page) -> int:
    return page.locator(THEME_SELECT).count()


def select_values(page) -> list:
    return page.evaluate(
        "() => [...document.querySelectorAll(" + json.dumps(THEME_SELECT) + ")].map((s) => s.value)"
    )


def all_select_values(page, value: str) -> bool:
    vals = select_values(page)
    return bool(vals) and all(v == value for v in vals)


def select_theme(page, value: str) -> bool:
    """在可见的主题控件上选择偏好；无可见控件返回 False。"""
    sel = page.locator(f"{THEME_SELECT}:visible").first
    if sel.count() == 0:
        return False
    sel.select_option(value)
    page.wait_for_timeout(250)
    return True


def scroll_probe(page) -> list:
    return page.evaluate("() => [document.scrollingElement.scrollWidth, window.innerWidth]")


def _px(v) -> float:
    try:
        return float(str(v).replace("px", "").strip())
    except Exception:  # noqa: BLE001
        return -1.0


# ---------- 对比度（sRGB 相对亮度，soft 度量项） ----------


def parse_rgb(s):
    if not s:
        return None
    m = re.match(r"rgba?\((.*)\)", str(s).strip())
    if not m:
        return None
    parts = [p for p in re.split(r"[,\s/]+", m.group(1).strip()) if p]
    if len(parts) < 3:
        return None
    try:
        r, g, b = float(parts[0]), float(parts[1]), float(parts[2])
        a = float(parts[3]) if len(parts) >= 4 else 1.0
        if a > 1:
            a = a / 100.0
        return (r, g, b, a)
    except ValueError:
        return None


def _blend(fg, bg):
    """把带 alpha 的前景叠到不透明背景上。"""
    r, g, b, a = fg
    if a >= 1:
        return (r, g, b)
    return tuple(a * c + (1 - a) * bc for c, bc in zip((r, g, b), bg))


def _luminance(rgb) -> float:
    def ch(c: float) -> float:
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])


def contrast(fg_s, bg_s):
    """WCAG 对比度（L1+0.05)/(L2+0.05)；解析失败返回 None。"""
    fg, bg = parse_rgb(fg_s), parse_rgb(bg_s)
    if fg is None or bg is None:
        return None
    bg_rgb = _blend(bg, (255, 255, 255))  # 半透明背景按白底近似
    fg_rgb = _blend(fg, bg_rgb)
    l1, l2 = _luminance(fg_rgb), _luminance(bg_rgb)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def fmt_ratio(r) -> str:
    return f"{r:.2f}" if r is not None else "n/a"


COLORS_JS = """() => {
  const transparent = (c) => !c || c === 'transparent' || /rgba\\(.*,\\s*0\\s*\\)$/.test(c);
  const effBg = (el) => {
    let n = el;
    while (n) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!transparent(bg)) return bg;
      n = n.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };
  const out = {};
  out.body = { color: getComputedStyle(document.body).color, bg: effBg(document.body) };
  const btn = document.querySelector('.btn.primary');
  out.btn = btn ? { color: getComputedStyle(btn).color, bg: getComputedStyle(btn).backgroundColor } : null;
  const ctl = document.querySelector('input, select, textarea');
  if (ctl) {
    const cs = getComputedStyle(ctl);
    out.ctl = {
      border: cs.borderTopColor,
      bg: transparent(cs.backgroundColor) ? effBg(ctl.parentElement || ctl) : cs.backgroundColor,
    };
  } else out.ctl = null;
  return out;
}"""


def contrast_assertions(page, label: str) -> None:
    """正文 ≥4.5:1、主按钮 ≥4.5:1、控件边框 ≥3:1（soft 警告）。"""
    colors = page.evaluate(COLORS_JS)
    body = colors.get("body") or {}
    r = contrast(body.get("color"), body.get("bg"))
    spec(
        f"T1.8 {label} 正文前景/背景对比度 ≥4.5:1",
        r is not None and r >= 4.5,
        f"{body.get('color')} vs {body.get('bg')} → {fmt_ratio(r)}",
        soft=True,
    )
    btn = colors.get("btn")
    if btn:
        r = contrast(btn.get("color"), btn.get("bg"))
        spec(
            f"T1.8 {label} 主按钮文字/底色对比度 ≥4.5:1",
            r is not None and r >= 4.5,
            f"{btn.get('color')} vs {btn.get('bg')} → {fmt_ratio(r)}",
            soft=True,
        )
    else:
        warnings.append(f"T1.8 {label} 未找到 .btn.primary，跳过主按钮对比度")
    ctl = colors.get("ctl")
    if ctl:
        r = contrast(ctl.get("border"), ctl.get("bg"))
        spec(
            f"T1.8 {label} 控件边框/相邻背景对比度 ≥3:1",
            r is not None and r >= 3.0,
            f"{ctl.get('border')} vs {ctl.get('bg')} → {fmt_ratio(r)}",
            soft=True,
        )
    else:
        warnings.append(f"T1.8 {label} 未找到输入控件，跳过边框对比度")


UNTYPED_COMPARE_JS = """() => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;';
  const a = document.createElement('input');           // 未写 type → 属性缺失
  const b = document.createElement('input');
  b.type = 'password';
  host.appendChild(a);
  host.appendChild(b);
  document.body.appendChild(host);
  const props = ['borderTopLeftRadius', 'minHeight', 'fontSize', 'fontFamily', 'borderTopWidth'];
  const ca = getComputedStyle(a);
  const cb = getComputedStyle(b);
  const out = {};
  for (const p of props) out[p] = [ca[p], cb[p]];
  host.remove();
  return out;
}"""

FIELD_ASSOC_JS = """() => {
  const p = document.getElementById('p');
  const err = document.querySelector('.field-error');
  return {
    describedby: p ? p.getAttribute('aria-describedby') : null,
    invalid: p ? p.getAttribute('aria-invalid') : null,
    errId: err ? err.id : null,
    errText: err ? (err.textContent || '').slice(0, 80) : null,
    hasLabel: !!document.querySelector('label[for="p"]'),
  };
}"""

# 让 localStorage.setItem 仅对主题键抛错：验证「存储失败不阻断当次页面内切换」。
STORAGE_FAIL_JS = (
    "(() => { try {\n"
    "  const orig = Storage.prototype.setItem;\n"
    "  Storage.prototype.setItem = function (k, v) {\n"
    f"    if (k === {json.dumps(THEME_KEY)}) throw new Error('e2e: storage disabled');\n"
    "    return orig.call(this, k, v);\n"
    "  };\n"
    "} catch (e) {} })();"
)


# ---------- T1 深色模式（登录页部分） ----------


def sec_t1_follow_system(page) -> None:
    """T1.1 清空存储默认跟随系统：emulate dark→dark、light→light（无需刷新）。"""
    page.emulate_media(color_scheme="dark")
    try:
        page.wait_for_function(
            "() => document.documentElement.dataset.theme === 'dark'", timeout=3000
        )
    except Exception:  # noqa: BLE001
        pass
    spec(
        "T1.1 默认跟随系统：emulate dark → dataset.theme='dark'",
        dataset_theme(page) == "dark",
        f"dataset={dataset_theme(page)}",
    )
    page.emulate_media(color_scheme="light")
    try:
        page.wait_for_function(
            "() => document.documentElement.dataset.theme === 'light'", timeout=3000
        )
    except Exception:  # noqa: BLE001
        pass
    spec(
        "T1.1 默认跟随系统：改 emulate light → dataset.theme='light'（无需刷新）",
        dataset_theme(page) == "light",
        f"dataset={dataset_theme(page)}",
    )


def sec_t1_override(page) -> None:
    """T1.2 手动覆盖：select dark/light/system → 存储与 dataset 同步、三处一致。"""
    if theme_select_count(page) == 0:
        spec("T1.2 主题控件存在：select[aria-label='主题']", False, "登录页未找到主题控件")
        return
    spec("T1.2 主题控件存在：select[aria-label='主题']", True)
    select_theme(page, "dark")
    spec(
        "T1.2 选 dark → localStorage.feedback.admin.theme='dark'",
        stored_theme(page) == "dark",
        f"stored={stored_theme(page)}",
    )
    spec("T1.2 选 dark → dataset.theme='dark'", dataset_theme(page) == "dark", f"dataset={dataset_theme(page)}")
    spec("T1.2 同一页面多处控件显示值一致（全为 dark）", all_select_values(page, "dark"), f"values={select_values(page)}")
    select_theme(page, "light")
    spec(
        "T1.2 选 light → stored/dataset 均为 'light'",
        stored_theme(page) == "light" and dataset_theme(page) == "light",
        f"stored={stored_theme(page)} dataset={dataset_theme(page)}",
    )
    select_theme(page, "system")
    spec(
        "T1.2 改回 system → 恢复跟随系统（当前 emulate light → 'light'）",
        dataset_theme(page) == "light",
        f"dataset={dataset_theme(page)}",
    )


def sec_t1_login_draft(page) -> None:
    """T1.9 切换主题不清空登录页用户名草稿（不 remount）。"""
    page.fill("#u", "草稿用户甲")
    if not select_theme(page, "dark"):
        spec("T1.9 切换主题保留登录页用户名草稿", False, "无主题控件")
        page.fill("#u", "")
        return
    select_theme(page, "light")
    spec(
        "T1.9 切换主题保留登录页用户名草稿",
        page.input_value("#u") == "草稿用户甲",
        f"value={page.input_value('#u')!r}",
    )
    page.fill("#u", "")


def sec_t1_reload_persist(page) -> None:
    """T1.3 刷新后持久化：reload 后 select 值与 dataset 保持。"""
    if theme_select_count(page) == 0:
        spec("T1.3 刷新后偏好持久化", False, "无主题控件")
        return
    select_theme(page, "dark")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#u", timeout=15000)
    page.wait_for_timeout(300)
    spec("T1.3 刷新后 dataset.theme 保持 'dark'", dataset_theme(page) == "dark", f"dataset={dataset_theme(page)}")
    vals = select_values(page)
    spec("T1.3 刷新后控件显示值保持 'dark'", bool(vals) and all(v == "dark" for v in vals), f"values={vals}")


def sec_t1_invalid_pref(page) -> None:
    """T1.4 非法偏好（'neon'）按 system 解析。"""
    page.evaluate(f"() => window.localStorage.setItem({json.dumps(THEME_KEY)}, 'neon')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#u", timeout=15000)
    page.wait_for_timeout(300)
    vals = select_values(page)
    # 当前 emulate light：system 解析结果应为 'light'，控件显示应为 'system'。
    spec(
        "T1.4 非法存储值 'neon' 按 system 解析",
        dataset_theme(page) == "light" and ((not vals) or all(v == "system" for v in vals)),
        f"dataset={dataset_theme(page)} values={vals}",
    )


def sec_t1_manual_vs_system(page) -> None:
    """T1.5 手动偏好时改系统色 → dataset 不变；改回 system 恢复跟随。"""
    if theme_select_count(page) == 0:
        spec("T1.5 手动偏好时改系统色 → dataset 不变", False, "无主题控件")
        return
    select_theme(page, "dark")
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(400)
    spec(
        "T1.5 手动 dark 时系统变 light → dataset 保持 'dark'",
        dataset_theme(page) == "dark",
        f"dataset={dataset_theme(page)}",
    )
    select_theme(page, "system")
    page.wait_for_timeout(250)
    spec(
        "T1.5 改回 system → 恢复跟随（emulate light → 'light'）",
        dataset_theme(page) == "light",
        f"dataset={dataset_theme(page)}",
    )
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(400)
    spec(
        "T1.5 system 下系统变 dark → dataset='dark'",
        dataset_theme(page) == "dark",
        f"dataset={dataset_theme(page)}",
    )
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(300)


def sec_t2_keyboard(page) -> None:
    """T2.14 键盘：Tab 到达主题 select、可键盘改值、focus-visible 焦点指示可见。"""
    if theme_select_count(page) == 0:
        spec("T2.14 键盘 Tab 可到达主题控件", False, "无主题控件")
        return
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
    reached = False
    for _ in range(40):
        page.keyboard.press("Tab")
        page.wait_for_timeout(60)
        label = page.evaluate("() => document.activeElement ? document.activeElement.getAttribute('aria-label') : null")
        if label == "主题":
            reached = True
            break
    spec("T2.14 键盘 Tab 可到达主题 select", reached)
    if not reached:
        spec("T2.14 focus-visible 焦点指示可见（outline-width>0）", False, "未能聚焦控件")
        spec("T2.14 键盘可修改主题值", False, "未能聚焦控件")
        return
    ol = page.evaluate(
        "() => { const s = getComputedStyle(document.activeElement); return [s.outlineWidth, s.outlineStyle]; }"
    )
    spec(
        "T2.14 focus-visible 焦点指示可见（outline-width>0）",
        ol[0] not in ("0px", "0") and ol[1] != "none",
        f"outline={ol}",
    )
    before = page.evaluate("() => document.activeElement.value")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(250)
    after = page.evaluate("() => document.activeElement.value")
    if after == before:
        page.keyboard.press("Enter")
        page.wait_for_timeout(250)
        after = page.evaluate("() => document.activeElement.value")
    spec("T2.14 键盘可修改主题值（ArrowDown/Enter）", after != before, f"{before}→{after}")


def sec_t1_login_shots_contrast(page) -> None:
    """T1.7/T1.8 登录页双主题截图与对比度度量（soft）。"""
    for theme in ("light", "dark"):
        select_theme(page, theme)
        page.wait_for_timeout(300)
        shot(page, f"01-login-{theme}")
        if dataset_theme(page) != theme:
            warnings.append(f"登录页 {theme} 对比度跳过：主题未生效 dataset={dataset_theme(page)}")
            continue
        contrast_assertions(page, f"登录页·{theme}")
    select_theme(page, "system")


# ---------- T2 UI / 响应式 / 无障碍（登录页部分） ----------


def sec_t2_login_viewport(page) -> None:
    """T2.11 登录页 390/768/1440/1920 无整页横向溢出；390 下单行控件 ≥44px。"""
    for w, hgt, name in ((390, 844, "mobile"), (768, 1024, "tablet"), (1440, 900, "desktop"), (1920, 1080, "wide")):
        page.set_viewport_size({"width": w, "height": hgt})
        page.wait_for_timeout(350)
        info = scroll_probe(page)
        spec(
            f"T2.11 登录页 {name} {w}×{hgt} 无整页横向溢出",
            info[0] <= info[1] + 1,
            f"scrollWidth={info[0]} innerWidth={info[1]}",
        )
        if w == 390:
            mh = page.evaluate("() => getComputedStyle(document.getElementById('u')).minHeight")
            spec(
                "T2.11 登录页 390 视口单行控件 computed min-height ≥44px",
                _px(mh) >= 44,
                f"minHeight={mh}",
            )
            shot(page, "02-login-mobile-390", full_page=True)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(250)


def sec_t2_untyped_input(page) -> None:
    """T2.12 未写 type 的 input 与 input[type='password'] 等效样式。"""
    cmp_result = page.evaluate(UNTYPED_COMPARE_JS)
    bad = {k: v for k, v in cmp_result.items() if v[0] != v[1]}
    spec(
        "T2.12 未写 type 的 input 与 input[type='password'] 等效样式（radius/min-height/font/border-width）",
        not bad,
        f"diff={bad or cmp_result}",
    )


def sec_t2_field_assoc(page) -> None:
    """T2.13 Field 关联：登录失败 → 密码框 aria-describedby 指向 .field-error、aria-invalid、label[for]。"""
    page.fill("#u", "admin")
    page.fill("#p", "wrong-password-e2e")
    page.click("form:has(#u) button[type=submit]")
    try:
        page.wait_for_selector(".field-error, .err, [role='alert']", timeout=10000)
    except Exception:  # noqa: BLE001
        pass
    page.wait_for_timeout(300)
    info = page.evaluate(FIELD_ASSOC_JS)
    desc = (info.get("describedby") or "").split()
    spec(
        "T2.13 登录失败：密码框 aria-describedby 指向 .field-error",
        bool(info.get("errId")) and info["errId"] in desc,
        f"info={info}",
    )
    spec("T2.13 登录失败：密码框 aria-invalid='true'", info.get("invalid") == "true", f"info={info}")
    spec("T2.13 label[for='p'] 关联密码控件", bool(info.get("hasLabel")), f"info={info}")
    shot(page, "03-login-field-error")


# ---------- 管理外壳内（反馈页）----------


def sec_admin_login(page, base: str) -> None:
    """S2 管理员登录进入管理外壳（harness 关键前置，硬断言）。"""
    try:
        admin_login(page, base)
        ok = True
    except Exception:  # noqa: BLE001
        ok = False
    check("管理员登录成功：进入管理外壳（导航可见）", ok and page.locator(".nav-item:visible").count() >= 1)


def sec_t1_feedback(page) -> None:
    """T1.2/T1.7/T1.8/T1.9 反馈页：壳层控件一致性、草稿保留、双主题截图与对比度。"""
    n = theme_select_count(page)
    spec("T1.2 壳层主题控件存在（侧栏 .shell-nav + 顶栏 .shell-top）", n >= 2, f"count={n}")
    if n == 0:
        spec("T1.9 切换主题保留反馈页筛选草稿", False, "无主题控件")
    else:
        select_theme(page, "dark")
        spec(
            "T1.2 壳层多处控件显示值一致（全为 dark）",
            all_select_values(page, "dark"),
            f"values={select_values(page)}",
        )
        select_theme(page, "light")
    # 草稿保持：筛选输入文本 → 切主题 → 文本保留
    try:
        page.wait_for_selector(SEARCH_SEL, timeout=10000)
        page.fill(SEARCH_SEL, DRAFT_TEXT)
        page.wait_for_timeout(600)  # 搜索防抖 300ms 落 URL
        select_theme(page, "dark")
        select_theme(page, "light")
        spec(
            "T1.9 切换主题保留反馈页筛选草稿",
            page.input_value(SEARCH_SEL) == DRAFT_TEXT,
            f"value={page.input_value(SEARCH_SEL)!r}",
        )
    except Exception as exc:  # noqa: BLE001
        spec("T1.9 切换主题保留反馈页筛选草稿", False, f"搜索框不可用：{exc}")
    # 双主题截图 + 对比度
    for theme in ("light", "dark"):
        select_theme(page, theme)
        page.wait_for_timeout(300)
        shot(page, f"04-feedbacks-{theme}")
        if dataset_theme(page) != theme:
            warnings.append(f"反馈页 {theme} 对比度跳过：主题未生效 dataset={dataset_theme(page)}")
            continue
        contrast_assertions(page, f"反馈页·{theme}")
    select_theme(page, "system")


def zoom_reachability(page, label: str) -> None:
    """窄 CSS 视口（卡片形态）下：页签/全部筛选/详情入口/行级菜单经滚动与键盘可达。

    供 T2.15 布局等效（720×450 CSS 视口）与 actual_zoom（真实 200% 缩放后同为
    ~720 CSS 布局）复用；全部走 record() 非中断硬断言。
    """
    tabs = page.locator(".view-tab:visible")
    record(f"{label} 三个区域页签可见", tabs.count() >= 3, f"tabs={tabs.count()}")
    # 本轮改版：<768 整个筛选区（含搜索）默认收起 → 先展开，再校验控件可见可达
    page.evaluate(
        """() => {
            const t = document.querySelector('#fb-filter-toggle');
            if (t && t.getAttribute('aria-expanded') === 'false') t.click();
        }"""
    )
    page.wait_for_timeout(300)
    ctrls = page.locator(".feedback-filters input, .feedback-filters select")
    n = ctrls.count()
    ctl_ok = n >= 4
    for i in range(n):
        try:
            ctrls.nth(i).scroll_into_view_if_needed()
            ctl_ok = ctl_ok and ctrls.nth(i).is_visible()
        except Exception:  # noqa: BLE001
            ctl_ok = False
    record(f"{label} 全部筛选控件可滚动到达且可见", ctl_ok, f"controls={n}")
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0,0); }")
    reached = False
    for _ in range(140):
        page.keyboard.press("Tab")
        page.wait_for_timeout(35)
        hit = page.evaluate(
            "() => { const el = document.activeElement;"
            " return !!(el && el.classList && el.classList.contains('fb-card-open')); }"
        )
        if hit:
            reached = True
            break
    record(f"{label} 键盘 Tab 可到达卡片详情入口 .fb-card-open", reached)
    if reached:
        page.keyboard.press("Enter")
        opened = False
        try:
            page.wait_for_selector(".drawer", timeout=8000)
            opened = True
        except Exception:  # noqa: BLE001
            pass
        record(f"{label} Enter 打开详情抽屉", opened)
        if opened:
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            record(f"{label} Esc 关闭抽屉", page.locator(".drawer").count() == 0)
    card = page.locator(".fb-card").first
    menu_ok = False
    if card.count() >= 1:
        try:
            btn = card.locator(".more-menu > button")
            btn.scroll_into_view_if_needed()
            btn.click()
            page.wait_for_selector(".more-menu-pop", timeout=4000)
            menu_ok = True
        except Exception:  # noqa: BLE001
            pass
    record(f"{label} 行级 MoreMenu 可弹出", menu_ok)
    if menu_ok:
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)


def sec_t2_feedback_viewport(page) -> None:
    """T2.11 反馈页四档视口无溢出（390 控件 ≥44px）；T2.15 720×450 布局等效可达性。"""
    for w, hgt, name in ((390, 844, "mobile"), (768, 1024, "tablet"), (1440, 900, "desktop"), (1920, 1080, "wide")):
        page.set_viewport_size({"width": w, "height": hgt})
        page.wait_for_timeout(400)
        info = scroll_probe(page)
        spec(
            f"T2.11 反馈页 {name} {w}×{hgt} 无整页横向溢出",
            info[0] <= info[1] + 1,
            f"scrollWidth={info[0]} innerWidth={info[1]}",
        )
        if w < 1200:
            # 顶栏导航必须真实可见：.nav-scroll 需有非零宽度且至少一个菜单项落在可视裁剪区内。
            # （历史缺陷：主题 select 继承 width:100% 把 .nav-scroll 压成 0px，:visible 仍判真。）
            nav = page.evaluate(
                "() => { const s = document.querySelector('.nav-scroll');"
                " const items = [...document.querySelectorAll('.shell-top .nav-item')];"
                " const sr = s ? s.getBoundingClientRect() : null;"
                " const vis = items.filter(i => { const r = i.getBoundingClientRect();"
                "   return sr && r.width > 0 && r.right > sr.left + 4 && r.left < sr.right - 4; }).length;"
                " return { w: sr ? Math.round(sr.width) : 0, vis, total: items.length }; }"
            )
            spec(
                f"T2.11 反馈页 {name} 顶栏导航可见（.nav-scroll 非零宽且菜单项落入视区）",
                nav["w"] > 30 and nav["vis"] >= 1,
                f"{nav}",
            )
        if w == 390:
            # 本轮改版：<768 筛选区默认收起 → 先展开再测控件触控高度（并让移动截图与
            # 基线「筛选可见」形态可比）。
            page.evaluate(
                """() => {
                    const t = document.querySelector('#fb-filter-toggle');
                    if (t && t.getAttribute('aria-expanded') === 'false') t.click();
                }"""
            )
            page.wait_for_timeout(300)
            mh = page.evaluate(
                "() => { const el = document.querySelector("
                + json.dumps(SEARCH_SEL)
                + "); return el ? getComputedStyle(el).minHeight : null; }"
            )
            spec(
                "T2.11 反馈页 390 视口单行控件 computed min-height ≥44px",
                _px(mh) >= 44,
                f"minHeight={mh}",
            )
            shot(page, "05-feedbacks-mobile-390", full_page=True)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)
    # T2.15 布局等效检查：720×450 CSS 视口 ≈ 1440×900 视口经真实浏览器 200% 缩放后的
    # CSS 布局（媒体查询/换行/溢出等效）。注意：这【不是】浏览器缩放本身——旧实现的
    # CDP Emulation.setPageScaleFactor 只缩放视觉视口、不触发 CSS 重排（innerWidth 不变），
    # 已废弃；真实 200% 缩放证据由 actual_zoom 节在独立 headed 会话中提供。
    f2_reset_inbox(page, 1)
    page.set_viewport_size({"width": 720, "height": 450})
    page.wait_for_timeout(450)
    info = scroll_probe(page)
    spec(
        "T2.15 布局等效（720×450≈1440@200%）反馈页无整页横向溢出",
        info[0] <= info[1] + 1,
        f"scrollWidth={info[0]} innerWidth={info[1]}",
    )
    zoom_reachability(page, "T2.15 布局等效")
    if page.locator(".drawer").count():
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)


def sec_t1_logout(page) -> None:
    """T1.10 退出重登：logout → 回登录页 → 偏好仍在（storage 未被清）。"""
    select_theme(page, "dark")
    btn = page.locator(".shell-nav button", has_text="退出登录")
    if btn.count() == 0:
        btn = page.locator("button:visible", has_text="退出")
    btn.first.click()
    try:
        page.wait_for_selector("#u", timeout=10000)
        back = True
    except Exception:  # noqa: BLE001
        back = False
    spec("T1.10 退出登录回到登录页", back)
    if not back:
        return
    spec(
        "T1.10 退出后 localStorage 偏好未被清（仍为 'dark'）",
        stored_theme(page) == "dark",
        f"stored={stored_theme(page)}",
    )
    spec(
        "T1.10 退出后 dataset.theme 仍按偏好解析（'dark'）",
        dataset_theme(page) == "dark",
        f"dataset={dataset_theme(page)}",
    )
    vals = select_values(page)
    if vals:
        spec("T1.10 登录页控件显示值仍为 'dark'", all(v == "dark" for v in vals), f"values={vals}")


# ---------- T1.6 存储失败兜底（独立 context） ----------


def sec_t1_storage_fail(browser, base: str) -> None:
    """localStorage.setItem 抛错时：页面内切换仍生效（dataset 变化）。"""
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    try:
        ctx.add_init_script(STORAGE_FAIL_JS)
        p2 = ctx.new_page()
        p2.goto(f"{base}/admin/", wait_until="domcontentloaded")
        p2.wait_for_selector("#u", timeout=15000)
        if theme_select_count(p2) == 0:
            spec("T1.6 存储失败时页面内切换仍生效", False, "无主题控件")
            return
        p2.locator(f"{THEME_SELECT}:visible").first.select_option("dark")
        p2.wait_for_timeout(300)
        spec(
            "T1.6 localStorage.setItem 抛错时页面内切换仍生效（dataset='dark'）",
            dataset_theme(p2) == "dark",
            f"dataset={dataset_theme(p2)} stored={stored_theme(p2)}",
        )
        shot(p2, "06-storage-fail-dark")
    finally:
        ctx.close()


# ---------- F2 反馈页 UI 观感（夹具 + 硬门槛断言节） ----------


def seed_f2_fixtures(h: Http, base: str) -> dict:
    """F2 夹具：全部走真实 API，失败即 check() 硬失败（夹具必须可靠）。

    - 批量账号 dailyLimit=500：提交 50 条填充反馈 → 收件箱 >50 → 出现「加载更多」；
    - 长文本 / 长名软件 / 长名用户 / name==appId（自动发现）各一条；
    - 无标题（title=NULL）：趁 worker 队列仍深时提交并立即移入回收站——
      回收站/暂停记录不进入 AI 整理（worker processLocked 早退），title 恒为 NULL，
      留在回收站避免在收件箱触发 5s 轮询；
    - 未读 + waiting_admin：用户对自有反馈追加留言（admin_unread_count>0 → unread，issueStatus→waiting_admin）；
    - waiting_user：管理端回复（issueStatusAction=reply）。
    """
    ids: dict[str, str] = {}
    # 夹具自检：100 字符 ASCII 账号必须精确命中服务端上限（回归「99 字符夹具」——
    # 99 仍合法但不再覆盖上限边界；前缀 "e2e-ui-ascii-" 13 字符 + 'a'×87 = 100）。
    check(
        "F2 夹具：ASCII 账号精确为 100 字符（服务端上限）",
        len(F2_ASCII_USER) == 100,
        f"len={len(F2_ASCII_USER)}",
    )
    st, body = h.call(
        "POST",
        f"{base}/api/admin/users",
        {"username": F2_BULK_USER, "password": F2_BULK_PASS, "dailyLimit": F2_BULK_LIMIT},
    )
    check("F2 夹具：批量账号创建 201", st == 201, f"status={st} body={body}")
    st, body = h.call(
        "POST",
        f"{base}/api/admin/users",
        {"username": F2_LONG_USER, "password": F2_LONG_PASS, "dailyLimit": 20},
    )
    check("F2 夹具：长名账号创建 201", st == 201, f"status={st} body={body}")
    st, body = h.call(
        "POST",
        f"{base}/api/admin/users",
        {"username": F2_ASCII_USER, "password": F2_ASCII_PASS, "dailyLimit": 20},
    )
    check("F2 夹具：100 字符 ASCII 账号创建 201", st == 201, f"status={st} body={body}")
    st, body = h.call(
        "POST",
        f"{base}/api/admin/apps",
        {
            "appId": F2_LONG_APP_ID,
            "name": F2_LONG_APP_NAME,
            "allowedOrigins": [],
            "kaneoProjectId": "p-e2e",
            "kaneoColumnSlug": "triage",
        },
    )
    check("F2 夹具：长名软件创建 201", st == 201, f"status={st} body={body}")

    bh, lh, ah = Http(), Http(), Http()
    st, _ = bh.call("POST", f"{base}/api/auth/login", {"username": F2_BULK_USER, "password": F2_BULK_PASS})
    check("F2 夹具：批量账号登录 200", st == 200, f"status={st}")
    st, _ = lh.call("POST", f"{base}/api/auth/login", {"username": F2_LONG_USER, "password": F2_LONG_PASS})
    check("F2 夹具：长名账号登录 200", st == 200, f"status={st}")
    st, _ = ah.call("POST", f"{base}/api/auth/login", {"username": F2_ASCII_USER, "password": F2_ASCII_PASS})
    check("F2 夹具：100 字符账号登录 200", st == 200, f"status={st}")

    def submit(sess: Http, app_id: str, text: str, key: str):
        return sess.call(
            "POST",
            f"{base}/api/feedback",
            {
                "idempotencyKey": f"ui-f2-{key}-{secrets.token_hex(4)}",
                "appId": app_id,
                "text": text,
                "context": {"appVersion": "1.0.0", "pageLabel": "ui-f2"},
            },
        )

    # 批量填充：先把串行 worker 的队列积深，为紧随其后的「无标题」夹具制造安全回收窗口。
    bulk_fail: list[tuple[int, int]] = []
    for i in range(F2_BULK_COUNT):
        st, body = submit(
            bh,
            SEED_APP_ID,
            f"{F2_NEEDLE['bulk']}-{i:02d} 批量填充反馈",
            f"bulk-{i}",
        )
        if st != 201:
            bulk_fail.append((i, st))
    check(
        "F2 夹具：50 条批量反馈全部 201",
        not bulk_fail,
        f"fails={bulk_fail[:5]}",
    )

    # 其余夹具行：排在批量之后继续加深队列（无标题夹具的回收窗口更稳）。
    fixture_specs = [
        ("longtext", bh, SEED_APP_ID, F2_LONG_TEXT),
        ("longapp", bh, F2_LONG_APP_ID, f"{F2_NEEDLE['longapp']} 长软件名夹具：软件列应同时展示名称与 appId 且不破版。"),
        ("sameapp", bh, F2_SAME_APP_ID, f"{F2_NEEDLE['sameapp']} 同名软件夹具：name==appId 时软件列只渲染一次。"),
        ("unread", bh, SEED_APP_ID, f"{F2_NEEDLE['unread']} 未读夹具：本条将由用户追加留言产生未读标记。"),
        ("waiting", bh, SEED_APP_ID, f"{F2_NEEDLE['waiting']} 等待回复夹具：本条将由管理端回复转为待用户补充。"),
    ]
    for key, sess, app_id, text in fixture_specs:
        st, body = submit(sess, app_id, text, key)
        check(f"F2 夹具：{key} 反馈提交 201", st == 201, f"status={st} body={body}")
        ids[key] = body["feedbackId"]
    st, body = submit(
        lh,
        SEED_APP_ID,
        f"{F2_NEEDLE['longuser']} 长用户名夹具",
        "longuser",
    )
    check("F2 夹具：longuser 反馈提交 201", st == 201, f"status={st} body={body}")
    ids["longuser"] = body["feedbackId"]
    st, body = submit(
        ah,
        SEED_APP_ID,
        # 正文保持短：标题/摘要各一行，把行高变量留给账号列（F2.H ≤104px 硬门槛）。
        f"{F2_NEEDLE['asciiuser']} 账号夹具",
        "asciiuser",
    )
    check("F2 夹具：asciiuser 反馈提交 201", st == 201, f"status={st} body={body}")
    ids["asciiuser"] = body["feedbackId"]

    # 无标题记录：提交 → 立即 trash（new 记录 lifecycle_version=0）→ worker 跳过 → title 恒 NULL。
    # 竞态兜底：worker 已抢先写入标题时，彻底删除该候选并换新幂等键重试（至多 3 次）。
    notitle_id = None
    for attempt in range(3):
        st, body = submit(
            bh,
            SEED_APP_ID,
            f"{F2_NEEDLE['notitle']} 无标题夹具：标题位应回退为原文摘要且不重复显示。",
            f"notitle-{attempt}",
        )
        check("F2 夹具：无标题候选反馈提交 201", st == 201, f"attempt={attempt} status={st} body={body}")
        fid = body["feedbackId"]
        trashed = False
        for _ in range(8):
            st, _ = h.call(
                "POST",
                f"{base}/api/admin/feedback/lifecycle",
                {"action": "trash", "items": [{"id": fid, "expectedVersion": 0}]},
            )
            if st == 200:
                trashed = True
                break
            if st == 409:  # busy/version 冲突：worker 可能正持锁处理，稍后复核标题
                time.sleep(0.4)
                continue
            break
        _, det = h.call("GET", f"{base}/api/admin/feedback/{fid}")
        if trashed and det and det.get("title") is None:
            notitle_id = fid
            break
        # 竞态失败：标题已被写入 → 回收站 → 彻底删除，保持列表干净后重试。
        if det and det.get("id"):
            lv = det.get("lifecycleVersion") or 0
            if det.get("mgmtState") != "trash":
                st3, _ = h.call(
                    "POST",
                    f"{base}/api/admin/feedback/lifecycle",
                    {"action": "trash", "items": [{"id": fid, "expectedVersion": lv}]},
                )
                if st3 == 200:
                    lv += 1
            h.call(
                "POST",
                f"{base}/api/admin/feedback/lifecycle",
                {"action": "purge", "items": [{"id": fid, "expectedVersion": lv}]},
            )
    check("F2 夹具：无标题记录构造成功（回收站中 title=NULL）", notitle_id is not None)
    ids["notitle"] = notitle_id or ""

    # 等收件箱全部落终态（needs_info 等；无 received/processing/archiving → 页面不做 5s 轮询，DOM 稳定）。
    settled = False
    deadline = time.time() + 150
    while time.time() < deadline:
        st, lst = h.call("GET", f"{base}/api/admin/feedback?view=inbox&limit=100")
        if st == 200 and lst:
            items = lst.get("items") or []
            active = [i for i in items if i.get("status") in ("received", "processing", "archiving")]
            if items and not active:
                settled = True
                break
        time.sleep(0.8)
    check("F2 夹具：收件箱全部进入终态（无活动处理状态）", settled)

    # 未读 + waiting_admin：用户对自有反馈追加留言（sender_type='user' → admin_unread_count>0）。
    st, body = bh.call(
        "POST",
        f"{base}/api/feedback/{ids['unread']}/messages",
        {"text": "补充：该问题在弱网环境下必现，请管理端处理。", "idempotencyKey": f"ui-f2-msg-{secrets.token_hex(4)}"},
    )
    check("F2 夹具：用户追加留言 201", st == 201, f"status={st} body={body}")
    # waiting_user：管理端回复（issueStatusAction=reply → waiting_user）。
    st, body = h.call(
        "POST",
        f"{base}/api/admin/feedback/{ids['waiting']}/messages",
        {"text": "请补充复现步骤与版本信息。", "issueStatusAction": "reply"},
    )
    check("F2 夹具：管理端回复 201", st == 201, f"status={st} body={body}")

    # API 复核夹具终态（与列表装配同一条路径，先于浏览器断言发现夹具失败）。
    st, lst = h.call("GET", f"{base}/api/admin/feedback?view=inbox&limit=100")
    by_id = {i.get("id"): i for i in (lst or {}).get("items", [])} if st == 200 else {}
    u = by_id.get(ids["unread"]) or {}
    w = by_id.get(ids["waiting"]) or {}
    check(
        "F2 夹具：未读记录 unread=true 且 issueStatus=waiting_admin",
        u.get("unread") is True and u.get("issueStatus") == "waiting_admin",
        f"unread={u.get('unread')} issue={u.get('issueStatus')}",
    )
    check(
        "F2 夹具：管理端回复记录 issueStatus=waiting_user",
        w.get("issueStatus") == "waiting_user",
        f"issue={w.get('issueStatus')}",
    )
    return {"ids": ids}


def f2_wait_rows(page, min_rows: int = 1, timeout: float = 15.0) -> int:
    """等 .fb-table 行数达到下限；返回最终行数（计数不看可见性，桌面/移动均适用）。"""
    n = -1
    deadline = time.time() + timeout
    while time.time() < deadline:
        n = page.locator(".fb-table tbody tr").count()
        if n >= min_rows:
            break
        page.wait_for_timeout(300)
    return n


def f2_reset_inbox(page, min_rows: int = 1) -> int:
    """回到收件箱默认态：清空搜索草稿、切到 inbox 区域并等行渲染。"""
    try:
        page.fill(SEARCH_SEL, "")
    except Exception:  # noqa: BLE001
        pass
    goto_view(page, "inbox")
    page.wait_for_timeout(700)  # 搜索防抖 300ms 落 URL + 列表重取
    return f2_wait_rows(page, min_rows)


# 行级探针：按针文本定位行，读取标题/摘要/软件/账号/状态标签/操作列的可观测事实。
F2_ROW_JS = """(needle) => {
  const tr = [...document.querySelectorAll('.fb-table tbody tr')]
    .find((r) => (r.innerText || '').includes(needle));
  if (!tr) return null;
  const tds = [...tr.querySelectorAll('td')];
  const cellText = (i) => (tds[i] ? (tds[i].innerText || '').trim() : '');
  const cellOverflow = (i) => (tds[i] ? tds[i].scrollWidth - tds[i].clientWidth : 0);
  const titleEl = tr.querySelector('.cell-open .feedback-title');
  const sumEl = tr.querySelector('.cell-open .feedback-summary');
  const menuBtn = tr.querySelector('.more-menu > button');
  const mr = menuBtn ? menuBtn.getBoundingClientRect() : null;
  const mcs = menuBtn ? getComputedStyle(menuBtn) : null;
  return {
    title: titleEl ? (titleEl.textContent || '').trim() : null,
    hasSummary: !!sumEl,
    summary: sumEl ? (sumEl.textContent || '').trim() : null,
    summaryClamp: sumEl ? getComputedStyle(sumEl).getPropertyValue('-webkit-line-clamp') : null,
    titleCell: cellText(1),
    appCell: cellText(2),
    userCell: cellText(3),
    tags: tds[4] ? [...tds[4].querySelectorAll('.tag')].map((t) => (t.textContent || '').trim()) : [],
    appOverflow: cellOverflow(2),
    userOverflow: cellOverflow(3),
    rowH: Math.round(tr.getBoundingClientRect().height),
    menuVisible: !!(menuBtn && mr && mr.width > 0 && mr.height > 0
      && mcs && mcs.display !== 'none' && mcs.visibility !== 'hidden' && !menuBtn.disabled),
  };
}"""

# 页级探针：筛选分组/日期区间/标题摘要/更多操作按钮的整体契约。
F2_DOM_JS = """() => {
  const vis = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const page = document.querySelector('.feedback-page');
  const groups = [...document.querySelectorAll('.feedback-filters .feedback-filter-group')];
  const labels = groups.map((g) => g.querySelector('.feedback-filter-label'));
  const dr = document.querySelector('.feedback-filters .feedback-date-range');
  const titles = [...document.querySelectorAll('.fb-table tbody .cell-open .feedback-title')];
  const sums = [...document.querySelectorAll('.fb-table tbody .cell-open .feedback-summary')];
  const sumBad = sums.filter((s) => {
    const t = s.parentElement ? s.parentElement.querySelector('.feedback-title') : null;
    const st = (s.textContent || '').trim();
    return !t || !st || st === (t.textContent || '').trim();
  }).length;
  const menus = [...document.querySelectorAll('.fb-table .more-menu > button')];
  return {
    page: !!page,
    groupCount: groups.length,
    groupsOk: groups.length >= 3 && labels.every((l) => l && (l.textContent || '').trim() && vis(l)),
    labelTexts: labels.map((l) => (l ? (l.textContent || '').trim() : null)),
    dateOk: !!dr && dr.querySelectorAll('input[type="date"]').length === 2,
    titleCount: titles.length,
    summaryCount: sums.length,
    summaryBad: sumBad,
    menuCount: menus.length,
    menusVisible: menus.length > 0 && menus.slice(0, 12).every((b) => vis(b) && !b.disabled),
  };
}"""

# 对比度探针：正文（标题）、次要文字（摘要/muted）、筛选控件边框。
F2_CONTRAST_JS = """() => {
  const transparent = (c) => !c || c === 'transparent' || /rgba\\(.*,\\s*0\\s*\\)$/.test(c);
  const effBg = (el) => {
    let n = el;
    while (n) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!transparent(bg)) return bg;
      n = n.parentElement;
    }
    return 'rgb(255, 255, 255)';
  };
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: transparent(cs.backgroundColor) ? effBg(el) : cs.backgroundColor };
  };
  const out = {};
  out.title = pick('.fb-table tbody .cell-open .feedback-title') || pick('.feedback-title');
  out.secondary = pick('.fb-table tbody .feedback-summary') || pick('.fb-table tbody .muted') || pick('.muted');
  const ctl = document.querySelector('.feedback-filters input[type="search"]')
    || document.querySelector('.feedback-filters select')
    || document.querySelector('.feedback-filters input');
  if (ctl) {
    const cs = getComputedStyle(ctl);
    out.ctl = { border: cs.borderTopColor, bg: transparent(cs.backgroundColor) ? effBg(ctl) : cs.backgroundColor };
  } else out.ctl = null;
  return out;
}"""


def sec_f2_pagination(page, fx: dict) -> None:
    """F2.A 游标分页：首屏 50 行、「加载更多」出现、点击后行数增加。"""
    f2_reset_inbox(page, 50)
    n = f2_wait_rows(page, 50, 25)
    record("F2.A 收件箱首屏加载满一页（PAGE_SIZE=50）", n >= 50, f"rows={n}")
    more = page.locator(".feedback-page .btn", has_text="加载更多")
    has_more = more.count() >= 1 and more.first.is_visible()
    record("F2.A 「加载更多」按钮出现（nextCursor 非空）", has_more)
    if not has_more:
        return
    more.first.click()
    n2 = f2_wait_rows(page, n + 1, 20)
    record("F2.A 点击「加载更多」后行数增加", n2 > n, f"{n}→{n2}")
    shot(page, "f2-list-50plus", full_page=True)


def sec_f2_dom(page, fx: dict) -> None:
    """F2.B 桌面 DOM 契约（1440）：筛选分组/日期区间/标题摘要/软件列去重/双状态标签/未读/更多操作。"""
    f2_reset_inbox(page, 1)
    # 本轮改版：日期条件收进「更多筛选」（默认收起）→ 先展开，再探测 .feedback-date-range
    page.evaluate(
        """() => {
            const b = document.querySelector('#fb-more-filters-toggle');
            if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
        }"""
    )
    page.wait_for_timeout(300)
    probe = page.evaluate(F2_DOM_JS)
    record("F2.B .feedback-page 页面容器存在", probe["page"])
    record(
        "F2.B .feedback-filters 内分组均含可见 .feedback-filter-label",
        probe["groupsOk"],
        f"groups={probe['groupCount']} labels={probe['labelTexts']}",
    )
    record("F2.B .feedback-date-range 包裹两个 date 输入", probe["dateOk"])
    record("F2.B 标题单元格含 .cell-open > .feedback-title", probe["titleCount"] >= 1, f"titles={probe['titleCount']}")
    record(
        "F2.B 标题≠摘要的行渲染 .feedback-summary 且摘要文本≠标题",
        probe["summaryCount"] >= 1 and probe["summaryBad"] == 0,
        f"summaries={probe['summaryCount']} bad={probe['summaryBad']}",
    )
    record(
        "F2.B 操作列 .more-menu 按钮非悬浮即可见可用",
        probe["menuCount"] >= 1 and probe["menusVisible"],
        f"menus={probe['menuCount']}",
    )

    def row(key: str):
        return page.evaluate(F2_ROW_JS, F2_NEEDLE[key])

    r = row("longtext")
    record("F2.B 长文本夹具行存在", r is not None)
    if r:
        record(
            "F2.B 长文本摘要被 clamp（-webkit-line-clamp 生效、行高受限不破版）",
            bool(r["hasSummary"]) and r["summaryClamp"] not in (None, "", "none") and r["rowH"] <= 200,
            f"clamp={r['summaryClamp']} rowH={r['rowH']}",
        )
    r = row("longapp")
    record("F2.B 长软件名夹具行存在", r is not None)
    if r:
        record(
            "F2.B 长软件名同时展示 name 与 appId 且单元格无横向内溢出",
            F2_LONG_APP_NAME in r["appCell"] and F2_LONG_APP_ID in r["appCell"] and r["appOverflow"] <= 2,
            f"appCell={r['appCell'][:90]!r} overflow={r['appOverflow']}",
        )
    r = row("sameapp")
    record("F2.B name==appId 夹具行存在", r is not None)
    if r:
        record(
            "F2.B name==appId 时软件列只渲染一次（不重复显示）",
            r["appCell"] == F2_SAME_APP_ID,
            f"appCell={r['appCell']!r}",
        )
    r = row("longuser")
    record("F2.B 长用户名夹具行存在", r is not None)
    if r:
        record(
            "F2.B 长用户名完整渲染且单元格无横向内溢出",
            F2_LONG_USER in r["userCell"] and r["userOverflow"] <= 2,
            f"userCell={r['userCell'][:60]!r} overflow={r['userOverflow']}",
        )
    r = row("unread")
    record("F2.B 未读夹具行存在", r is not None)
    if r:
        tags = r["tags"]
        record(
            "F2.B 未读行出现「未读」tag，且处理状态/工单沟通双 tag 文案不同并存",
            "未读" in tags and "待管理处理" in tags and len({t for t in tags if t}) >= 3,
            f"tags={tags}",
        )
        record("F2.B 未读行 .more-menu 按钮可见可用", r["menuVisible"])
        if r["menuVisible"]:
            tr = page.locator(".fb-table tbody tr", has_text=F2_NEEDLE["unread"]).first
            tr.locator(".more-menu > button").click()
            pop = False
            try:
                page.wait_for_selector(".more-menu-pop", timeout=4000)
                pop = True
            except Exception:  # noqa: BLE001
                pass
            record("F2.B .more-menu 点击弹出 .more-menu-pop", pop)
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)
            record("F2.B Esc 关闭 .more-menu-pop 弹出层", page.locator(".more-menu-pop").count() == 0)
    r = row("waiting")
    record("F2.B 待用户补充夹具行存在", r is not None)
    if r:
        tags = r["tags"]
        record(
            "F2.B 工单沟通 tag 与处理状态 tag 文案不同并存（含「待用户补充」）",
            "待用户补充" in tags and len({t for t in tags if t}) >= 2,
            f"tags={tags}",
        )

    # 无标题行在回收站：preview 只在标题位出现一次、不重复渲染为摘要。
    goto_view(page, "trash")
    f2_wait_rows(page, 1, 15)
    r = row("notitle")
    record("F2.B 无标题夹具行存在（回收站）", r is not None)
    if r:
        occurrences = r["titleCell"].count(F2_NEEDLE["notitle"])
        record(
            "F2.B title 缺失行 preview 只出现一次（标题位回退、无摘要重复）",
            r["hasSummary"] is False and r["title"] is not None and occurrences == 1,
            f"title={r['title']!r} summary={r['summary']!r} needle×{occurrences}",
        )
    goto_view(page, "inbox")
    f2_wait_rows(page, 1, 15)


def sec_f2_responsive(page) -> None:
    """F2.C 响应式硬门槛：四档视口 + 767/768/1199/1200 边界无整页横向溢出；断点翻转与 390 控件高度。"""
    # 断点边界（宽度精度 ±1px，高度取常用值即可）
    for w in (767, 768, 1199, 1200):
        page.set_viewport_size({"width": w, "height": 900})
        page.wait_for_timeout(350)
        info = scroll_probe(page)
        record(
            f"F2.C 反馈页边界宽度 {w}px 无整页横向溢出",
            info[0] <= info[1] + 1,
            f"scrollWidth={info[0]} innerWidth={info[1]}",
        )
    # 767/768 是卡片↔表格断点：两侧各验一次形态翻转
    page.set_viewport_size({"width": 767, "height": 900})
    page.wait_for_timeout(350)
    cards767 = page.locator(".fb-cards").first.is_visible() and not page.locator(".fb-table").first.is_visible()
    record("F2.C 767px 卡片形态（.fb-cards 可见 / .fb-table 隐藏）", cards767)
    shot(page, "f2-breakpoint-767")
    page.set_viewport_size({"width": 768, "height": 900})
    page.wait_for_timeout(350)
    tbl768 = page.locator(".fb-table").first.is_visible() and not page.locator(".fb-cards").first.is_visible()
    record("F2.C 768px 表格形态（.fb-table 可见 / .fb-cards 隐藏）", tbl768)
    shot(page, "f2-breakpoint-768")
    # 390：溢出 + 卡片渲染 + 筛选控件触控高度 ≥44px
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)
    info = scroll_probe(page)
    record(
        "F2.C 反馈页 390×844 无整页横向溢出",
        info[0] <= info[1] + 1,
        f"scrollWidth={info[0]} innerWidth={info[1]}",
    )
    n_cards = page.locator(".fb-card").count()
    record(
        "F2.C 390 视口移动卡片渲染（.fb-card>0 且 .fb-table 隐藏）",
        n_cards > 0 and not page.locator(".fb-table").first.is_visible(),
        f"cards={n_cards}",
    )
    # 本轮改版：<768 筛选区默认收起 → 先展开再测控件触控高度（收起时控件不渲染）
    page.evaluate(
        """() => {
            const t = document.querySelector('#fb-filter-toggle');
            if (t && t.getAttribute('aria-expanded') === 'false') t.click();
        }"""
    )
    page.wait_for_timeout(300)
    mh = page.evaluate(
        "() => [...document.querySelectorAll('.feedback-filters input, .feedback-filters select')]"
        ".map((el) => getComputedStyle(el).minHeight)"
    )
    record(
        "F2.C 390 视口筛选控件 computed min-height 均 ≥44px",
        bool(mh) and all(_px(v) >= 44 for v in mh),
        f"minHeights={mh}",
    )
    for w, hgt, name in ((768, 1024, "tablet"), (1440, 900, "desktop"), (1920, 1080, "wide")):
        page.set_viewport_size({"width": w, "height": hgt})
        page.wait_for_timeout(350)
        info = scroll_probe(page)
        record(
            f"F2.C 反馈页 {name} {w}×{hgt} 无整页横向溢出",
            info[0] <= info[1] + 1,
            f"scrollWidth={info[0]} innerWidth={info[1]}",
        )
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)


def sec_f2_contrast(page) -> None:
    """F2.D 反馈页明暗双主题对比度硬门槛：正文/次要文字 ≥4.5:1、筛选控件边框 ≥3:1。"""
    for theme in ("light", "dark"):
        if not select_theme(page, theme):
            record(f"F2.D 反馈页·{theme} 主题控件可切换", False, "无可见主题控件")
            continue
        page.wait_for_timeout(300)
        if dataset_theme(page) != theme:
            record(f"F2.D 反馈页·{theme} 主题生效", False, f"dataset={dataset_theme(page)}")
            continue
        c = page.evaluate(F2_CONTRAST_JS)
        t = c.get("title")
        r = contrast(t.get("color"), t.get("bg")) if t else None
        record(
            f"F2.D 反馈页·{theme} 正文（标题）前景/背景对比度 ≥4.5:1",
            r is not None and r >= 4.5,
            f"{(t or {}).get('color')} vs {(t or {}).get('bg')} → {fmt_ratio(r)}",
        )
        s = c.get("secondary")
        r = contrast(s.get("color"), s.get("bg")) if s else None
        record(
            f"F2.D 反馈页·{theme} 次要文字（.feedback-summary/.muted）对比度 ≥4.5:1",
            r is not None and r >= 4.5,
            f"{(s or {}).get('color')} vs {(s or {}).get('bg')} → {fmt_ratio(r)}",
        )
        ctl = c.get("ctl")
        r = contrast(ctl.get("border"), ctl.get("bg")) if ctl else None
        record(
            f"F2.D 反馈页·{theme} 输入控件边框/相邻背景对比度 ≥3:1",
            r is not None and r >= 3.0,
            f"{(ctl or {}).get('border')} vs {(ctl or {}).get('bg')} → {fmt_ratio(r)}",
        )
    select_theme(page, "system")
    page.wait_for_timeout(200)


def sec_f2_keyboard(page) -> None:
    """F2.E 键盘与焦点：Tab 到达 .cell-open、focus-visible outline、Enter 开抽屉、Esc 还原。"""
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
    reached = False
    for _ in range(90):
        page.keyboard.press("Tab")
        page.wait_for_timeout(50)
        hit = page.evaluate(
            "() => { const el = document.activeElement;"
            " return !!(el && el.classList && el.classList.contains('cell-open')); }"
        )
        if hit:
            reached = True
            break
    record("F2.E Tab 可到达标题按钮 .cell-open", reached)
    if not reached:
        return
    ol = page.evaluate(
        "() => { const s = getComputedStyle(document.activeElement); return [s.outlineWidth, s.outlineStyle]; }"
    )
    record("F2.E .cell-open 键盘焦点 outline 非 none/0", ol[0] not in ("0px", "0") and ol[1] != "none", f"outline={ol}")
    page.keyboard.press("Enter")
    opened = False
    try:
        page.wait_for_selector(".drawer", timeout=8000)
        opened = True
    except Exception:  # noqa: BLE001
        pass
    record("F2.E Enter 打开详情抽屉 .drawer", opened)
    if opened:
        shot(page, "f2-drawer")
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        record("F2.E Esc 关闭抽屉还原列表", page.locator(".drawer").count() == 0)
        # 焦点陷阱关闭时把焦点还给触发元素（useFocusTrap restoreRef）。
        restored = page.evaluate(
            "() => { const el = document.activeElement;"
            " return !!(el && el.classList && el.classList.contains('cell-open')); }"
        )
        record("F2.E 抽屉关闭后焦点还原到 .cell-open", restored)


def sec_f2_load_error(page) -> None:
    """F2.F 加载/错误态：列表请求中断 → .inline-error；取消拦截点重试恢复；延迟响应 → 骨架屏（soft）。"""

    def is_list_call(url: str) -> bool:
        # URL 谓词：Playwright 调用时传入的是 url 字符串（不是 Route 对象）。
        # 只拦列表本身：counts/app-options/详情（/feedback/<id>）路径不含 'feedback?' 字样。
        return bool(re.search(r"/api/admin/feedback\?", url))

    def abort(route) -> None:
        route.abort()

    f2_reset_inbox(page, 1)
    page.route(is_list_call, abort)
    try:
        page.locator(".page-header .btn", has_text="刷新").first.click()
        ok_err = False
        try:
            page.wait_for_selector(".inline-error", timeout=10000)
            ok_err = True
        except Exception:  # noqa: BLE001
            pass
        record("F2.F 列表请求中断后出现 .inline-error", ok_err)
        shot(page, "f2-error-state")
    finally:
        try:
            page.unroute(is_list_call, abort)
        except Exception:  # noqa: BLE001
            pass
    retry = page.locator(".inline-error .btn", has_text="重试")
    clicked = retry.count() >= 1
    if clicked:
        retry.first.click()
    recovered = False
    deadline = time.time() + 12
    while time.time() < deadline:
        if page.locator(".inline-error").count() == 0 and page.locator(".fb-table tbody tr").count() >= 1:
            recovered = True
            break
        page.wait_for_timeout(250)
    record("F2.F 取消拦截后点重试恢复列表（错误提示消失、行仍在）", clicked and recovered, f"retry={clicked}")

    # 骨架屏探测（时序敏感，只做 soft 警告）：hold 1.2s 后放行真实响应，期间应出现 .skeleton。
    def hold_then_real(route) -> None:
        time.sleep(1.2)
        try:
            route.fulfill(response=route.fetch())
        except Exception:  # noqa: BLE001
            try:
                route.continue_()
            except Exception:  # noqa: BLE001
                pass

    page.route(is_list_call, hold_then_real)
    try:
        page.fill(SEARCH_SEL, "f2-skeleton-probe-no-match")
        seen = False
        deadline = time.time() + 1.1
        while time.time() < deadline:
            if page.locator(".skeleton").count() > 0:
                seen = True
                break
            page.wait_for_timeout(60)
        check("F2.F 延迟响应期间骨架屏 .skeleton 出现", seen, soft=True)
        page.wait_for_timeout(1600)  # 等 hold 放行落地
    finally:
        try:
            page.unroute(is_list_call, hold_then_real)
        except Exception:  # noqa: BLE001
            pass
    page.fill(SEARCH_SEL, "")
    page.wait_for_timeout(800)
    f2_wait_rows(page, 1, 15)


def sec_f2_shots(page) -> None:
    """F2.G 截图：同数据同视口的明暗双图——1440 桌面、390 卡片、1920 宽屏（错误态与 50 条列表见前节）。"""
    f2_reset_inbox(page, 1)
    for theme in ("light", "dark"):
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(250)
        ok_theme = select_theme(page, theme)
        page.wait_for_timeout(300)
        record(
            f"F2.G 截图前 {theme} 主题已生效",
            ok_theme and dataset_theme(page) == theme,
            f"dataset={dataset_theme(page)}",
        )
        shot(page, f"f2-desktop-1440-{theme}")
        # 主题控件在窄视口可能不可见：在桌面宽下切好主题再缩到 390 截卡片形态。
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(400)
        shot(page, f"f2-mobile-390-{theme}")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(250)
    select_theme(page, "light")
    page.set_viewport_size({"width": 1920, "height": 1080})
    page.wait_for_timeout(350)
    shot(page, "f2-wide-1920-light")
    # 还原：1440×900 + system 偏好
    page.set_viewport_size({"width": 1440, "height": 900})
    select_theme(page, "system")
    page.wait_for_timeout(300)


def sec_f2_username(page) -> None:
    """F2.H 提交账号呈现硬门槛（探针：e2e/test_feedback_username_probe.py）。

    桌面 1440：.feedback-username--table DOM/title 保留完整账号、视觉 ≤2 行、
    行高 ≤104px、MoreMenu 可见可弹出；移动 390：.feedback-username--mobile 完整换行、
    账号自身与整页均无横向溢出。100 连续 ASCII 账号为回归针，长名账号同行覆盖，
    普通短账号作对照（username 恒来自登录用户，无 API 路径产生空账号行）。
    """
    page.set_viewport_size({"width": 1440, "height": 900})
    f2_reset_inbox(page, 1)
    page.wait_for_timeout(350)
    for needle, user, label in (
        (F2_NEEDLE["asciiuser"], F2_ASCII_USER, "桌面·100字符ASCII账号"),
        (F2_NEEDLE["longuser"], F2_LONG_USER, "桌面·长名账号"),
        # 普通短账号对照：sameapp 行由 F2_BULK_USER 提交且排在首页（bulk-* 行最旧会落在第二页）。
        (F2_NEEDLE["sameapp"], F2_BULK_USER, "桌面·普通账号对照"),
    ):
        uname_probe.assert_table_username(
            record, page, needle=needle, username=user, name_prefix=f"F2.H {label}"
        )
    tr = page.locator(".fb-table tbody tr", has_text=F2_NEEDLE["asciiuser"]).first
    ok_row = tr.count() >= 1
    record("F2.H 桌面·100字符账号行定位", ok_row)
    if ok_row:
        pop = False
        try:
            tr.locator(".more-menu > button").click()
            page.wait_for_selector(".more-menu-pop", timeout=4000)
            pop = True
        except Exception:  # noqa: BLE001
            pass
        record("F2.H 桌面·100字符账号行 MoreMenu 弹出", pop)
        shot(page, "f2-username-1440-menu")
        if pop:
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)
    shot(page, "f2-username-1440")
    # 移动 390×844：断言在 light 做一次（布局规则与主题无关），明暗各截一张 100 字符卡片。
    for theme in ("light", "dark"):
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(250)
        select_theme(page, theme)
        page.wait_for_timeout(300)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(450)
        if theme == "light":
            for needle, user, label in (
                (F2_NEEDLE["asciiuser"], F2_ASCII_USER, "移动·100字符ASCII账号"),
                (F2_NEEDLE["longuser"], F2_LONG_USER, "移动·长名账号"),
                (F2_NEEDLE["sameapp"], F2_BULK_USER, "移动·普通账号对照"),
            ):
                uname_probe.assert_mobile_username(
                    record, page, needle=needle, username=user, name_prefix=f"F2.H {label}"
                )
        card = page.locator(".fb-card", has_text=F2_NEEDLE["asciiuser"]).first
        try:
            card.scroll_into_view_if_needed()
            page.wait_for_timeout(150)
        except Exception:  # noqa: BLE001
            pass
        shot(page, f"f2-username-390-{theme}")
    page.set_viewport_size({"width": 1440, "height": 900})
    select_theme(page, "system")
    page.wait_for_timeout(300)


# ---------- actual_zoom：真实浏览器缩放（非模拟、非 CSS 视口等效） ----------
# 机制：一次性扩展的 service worker 调 chrome.tabs.setZoom——浏览器原生缩放 API，
# 与 UI Ctrl/Cmd+ 同一代码路径（缩放指示器显示 200%），区别于已废弃的
# Emulation.setPageScaleFactor（只缩放视觉视口、不重排 CSS）。需 --headed chromium；
# headless/机制不可用时记 pending（阻止通过），不由自动脚本凭空填写「实际缩放通过」。
ZOOM_EXT_MANIFEST = {
    "manifest_version": 3,
    "name": "fb-e2e-actual-zoom",
    "version": "1.0",
    "permissions": ["tabs"],
    "background": {"service_worker": "sw.js"},
}
ZOOM_EXT_SW = "// fb e2e zoom driver: chrome.tabs.* 由主脚本经 service worker evaluate 调用\n"


def sec_actual_zoom(pw, args, base: str) -> None:
    """actual_zoom 真实浏览器 200% 缩放证据（隔离 headed Chromium 持久会话）。

    记录：浏览器缩放显示（chrome.tabs.getZoom）、CSS innerWidth、devicePixelRatio、
    媒体查询回排、200% 下页签/筛选/详情/菜单可达性、截图；随后恢复 100% 再清理。
    FB_E2E_ZOOM_WAIT_SEC 设为 >0 时，在 200% 状态停留 N 秒供人工核对有头窗口。
    """
    name = "actual_zoom 真实浏览器 200% 缩放（chrome.tabs.setZoom）"
    if not args.headed or args.browser != "chromium":
        pending.append((name, "需要 --headed 且 --browser chromium 会话提供真实缩放证据"))
        print(f"  PEND  {name} — 需要 --headed chromium", flush=True)
        return
    zoom_dir = tempfile.mkdtemp(prefix="fb-actual-zoom-")
    ext_dir = os.sep.join([zoom_dir, "ext"])
    os.makedirs(ext_dir, exist_ok=True)
    with open(os.sep.join([ext_dir, "manifest.json"]), "w") as f:
        json.dump(ZOOM_EXT_MANIFEST, f)
    with open(os.sep.join([ext_dir, "sw.js"]), "w") as f:
        f.write(ZOOM_EXT_SW)
    zctx = None
    try:
        zctx = pw.chromium.launch_persistent_context(
            os.sep.join([zoom_dir, "profile"]),
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=[f"--load-extension={ext_dir}", f"--disable-extensions-except={ext_dir}"],
        )
        zp = zctx.new_page()
        admin_login(zp, base)
        f2_reset_inbox(zp, 1)
        # MV3 service worker 懒启动：页面导航后再等其就绪（负载下首次注册可能 >10s）。
        sw = None
        t0 = time.time()
        while time.time() - t0 < 30 and sw is None:
            if zctx.service_workers:
                sw = zctx.service_workers[0]
            else:
                time.sleep(0.3)
        if sw is None:
            pending.append((name, "缩放扩展 service worker 未就绪"))
            print(f"  PEND  {name} — service worker 未就绪", flush=True)
            return
        before = zp.evaluate("() => [devicePixelRatio, innerWidth]")
        record("actual_zoom 基线 100%（dpr=1、innerWidth=1440）", before[0] == 1 and before[1] == 1440, f"{before}")
        shot(zp, "zoom-100-feedbacks")
        zoomed = sw.evaluate(
            """async (baseUrl) => {
              const tabs = await chrome.tabs.query({});
              const t = tabs.find((x) => (x.url || '').startsWith(baseUrl))
                        || tabs.find((x) => x.active);
              await chrome.tabs.setZoom(t.id, 2.0);
              return await chrome.tabs.getZoom(t.id);
            }""",
            base,
        )
        zp.wait_for_timeout(700)
        after = zp.evaluate(
            "() => [devicePixelRatio, innerWidth, matchMedia('(max-width: 767px)').matches]"
        )
        record("actual_zoom 浏览器缩放显示=200%（chrome.tabs.getZoom）", zoomed == 2, f"getZoom={zoomed}")
        record(
            "actual_zoom 真实缩放回排：dpr=2、innerWidth≈720、(max-width:767px) 命中",
            after[0] == 2 and 700 <= after[1] <= 740 and after[2] is True,
            f"{after}",
        )
        zinfo = scroll_probe(zp)
        record(
            "actual_zoom 200% 缩放下无整页横向溢出",
            zinfo[0] <= zinfo[1] + 1,
            f"scrollWidth={zinfo[0]} innerWidth={zinfo[1]}",
        )
        shot(zp, "zoom-200-real-feedbacks", full_page=True)
        zoom_reachability(zp, "actual_zoom")
        wait_s = float(os.environ.get("FB_E2E_ZOOM_WAIT_SEC", "0") or 0)
        if wait_s > 0:
            print(f"  [actual_zoom] 200% 状态停留 {wait_s}s：可在有头窗口核对浏览器缩放指示", flush=True)
            zp.wait_for_timeout(int(wait_s * 1000))
        restored = sw.evaluate(
            """async (baseUrl) => {
              const tabs = await chrome.tabs.query({});
              const t = tabs.find((x) => (x.url || '').startsWith(baseUrl))
                        || tabs.find((x) => x.active);
              await chrome.tabs.setZoom(t.id, 1.0);
              return await chrome.tabs.getZoom(t.id);
            }""",
            base,
        )
        zp.wait_for_timeout(500)
        back = zp.evaluate("() => [devicePixelRatio, innerWidth]")
        record(
            "actual_zoom 恢复 100%（getZoom=1、dpr=1、innerWidth≈1440）",
            restored == 1 and back[0] == 1 and back[1] >= 1400,
            f"getZoom={restored} {back}",
        )
        with open(os.sep.join([SHOTS, "zoom-evidence.json"]), "w") as f:
            json.dump(
                {
                    "method": "chrome.tabs.setZoom（浏览器原生缩放，等效 UI 缩放；非 Emulation）",
                    "getZoomAt200": zoomed,
                    "before100": {"devicePixelRatio": before[0], "innerWidth": before[1]},
                    "at200": {"devicePixelRatio": after[0], "innerWidth": after[1], "mobileMq": after[2]},
                    "restored100": {"getZoom": restored, "devicePixelRatio": back[0], "innerWidth": back[1]},
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
    except Exception as exc:  # noqa: BLE001
        record(f"{name} 执行", False, f"{type(exc).__name__}: {str(exc)[:200]}")
    finally:
        if zctx is not None:
            try:
                zctx.close()
            except Exception:  # noqa: BLE001
                pass


# ---------- F4 账号页区块间距 ----------

F4_GAP_JS = (
    "() => { const rect = (sel) => { const el = document.querySelector(sel);"
    " return el ? el.getBoundingClientRect() : null; };"
    " const ls = rect('.accounts-list-section');"
    " const cs = rect('.accounts-create-section');"
    " const tw = rect('.accounts-list-section .table-wrap');"
    " const cd = rect('.accounts-create-section .card');"
    " const secs = document.querySelector('.accounts-sections');"
    " return {"
    " sectionGap: ls && cs ? +(cs.top - ls.bottom).toFixed(2) : null,"
    " boxGap: tw && cd ? +(cd.top - tw.bottom).toFixed(2) : null,"
    " cssGap: secs ? getComputedStyle(secs).rowGap : null }; }"
)


def f4_gap(page):
    """两边框矩形间距（boxGap）：账号列表 .table-wrap 下缘 → 新建账号 .card 上缘。"""
    return page.evaluate(F4_GAP_JS)


def f4_goto_accounts(page) -> bool:
    page.locator(".nav-item:visible", has_text="账号").first.click()
    try:
        page.wait_for_selector(".accounts-page .accounts-sections", timeout=10000)
        return True
    except Exception:  # noqa: BLE001
        return False


def f4_reload_accounts(page) -> None:
    """?page=accounts 经 pushState 落 URL，reload 后仍在账号页并重新拉取用户列表。"""
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".accounts-page", timeout=15000)


def sec_f4_accounts_spacing(page) -> None:
    """F4 账号页：.accounts-sections gap 24px(≥768)/16px(≤767)±1；
    断点×明暗×空/有账号矩阵、加载/错误骨架留白、390 局部横滚、焦点环与账号操作。"""

    def gap_close(exp: float):
        g = f4_gap(page)
        return g is not None and g["boxGap"] is not None and abs(g["boxGap"] - exp) <= 1, g

    step("F4.0 进入账号视图（1440 桌面宽导航）")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(250)
    check("F4 导航到账号视图（.accounts-sections 出现）", f4_goto_accounts(page))
    rows_ok = False
    try:
        page.wait_for_selector(".accounts-list-section table", timeout=10000)
        rows_ok = True
    except Exception:  # noqa: BLE001
        pass
    check("F4 账号表加载出种子用户", rows_ok)
    check(
        "F4 .accounts-page 下 .accounts-sections 仅含 list/create 两个子区块",
        page.evaluate(
            "() => { const p = document.querySelector('.accounts-page');"
            " const s = p && p.querySelector('.accounts-sections');"
            " return !!s && s.children.length === 2"
            " && s.children[0].classList.contains('accounts-list-section')"
            " && s.children[1].classList.contains('accounts-create-section'); }"
        ),
    )

    step("F4.A 有账号：断点×明暗矩阵（gap 与整页横向溢出）")
    for theme in ("light", "dark"):
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(250)
        ok_theme = select_theme(page, theme)
        record(
            f"F4.A 有账号·{theme} 主题生效",
            ok_theme and dataset_theme(page) == theme,
            f"dataset={dataset_theme(page)}",
        )
        for w, exp in ((390, 16), (767, 16), (768, 24), (1280, 24), (2048, 24)):
            page.set_viewport_size({"width": w, "height": 844 if w == 390 else 900})
            page.wait_for_timeout(300)
            ok, g = gap_close(exp)
            record(f"F4.A 有账号·{theme}·{w}px 两区间距 {exp}±1px", ok, f"gap={g}")
            info = scroll_probe(page)
            record(
                f"F4.A 有账号·{theme}·{w}px 无整页横向溢出",
                info[0] <= info[1] + 1,
                f"scrollWidth={info[0]} innerWidth={info[1]}",
            )
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(250)
        shot(page, f"f4-accounts-1440-{theme}")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(300)
        shot(page, f"f4-accounts-390-{theme}")

    step("F4.B 390 表格局部横滚（.table-wrap overflow-x）")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    tw = page.evaluate(
        "() => { const t = document.querySelector('.accounts-list-section .table-wrap');"
        " if (!t) return null;"
        " const can = t.scrollWidth > t.clientWidth + 1;"
        " let scrolled = false;"
        " if (can) { t.scrollLeft = 60; scrolled = t.scrollLeft > 0; t.scrollLeft = 0; }"
        " return {ox: getComputedStyle(t).overflowX, sw: t.scrollWidth, cw: t.clientWidth,"
        " can: can, scrolled: scrolled}; }"
    )
    record(
        "F4.B 390 .table-wrap 局部横滚可用（overflow-x:auto 且可滚动或内容不溢出）",
        tw is not None
        and tw["ox"] in ("auto", "scroll")
        and (not tw["can"] or tw["scrolled"]),
        f"wrap={tw}",
    )
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(250)

    step("F4.C 空账号：拦截 GET /api/admin/users → EmptyState 下同矩阵")
    users_url = re.compile(r"/api/admin/users(\?|$)")

    def empty_users(route, request) -> None:
        if request.method == "GET":
            route.fulfill(status=200, content_type="application/json", body='{"users":[]}')
        else:
            route.continue_()

    page.route(users_url, empty_users)
    try:
        f4_reload_accounts(page)
        empty_ok = False
        try:
            page.wait_for_selector(".accounts-list-section .empty", timeout=10000)
            empty_ok = True
        except Exception:  # noqa: BLE001
            pass
        record("F4.C 空账号态渲染 .empty", empty_ok)
        for theme in ("light", "dark"):
            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_timeout(250)
            select_theme(page, theme)
            page.wait_for_timeout(250)
            for w, exp in ((390, 16), (767, 16), (768, 24), (1280, 24), (2048, 24)):
                page.set_viewport_size({"width": w, "height": 844 if w == 390 else 900})
                page.wait_for_timeout(300)
                ok, g = gap_close(exp)
                record(f"F4.C 空账号·{theme}·{w}px 两区间距 {exp}±1px", ok, f"gap={g}")
            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_timeout(250)
            shot(page, f"f4-accounts-empty-1440-{theme}")
    finally:
        try:
            page.unroute(users_url, empty_users)
        except Exception:  # noqa: BLE001
            pass
    back = False
    try:
        f4_reload_accounts(page)
        page.wait_for_selector(".accounts-list-section tbody tr", timeout=12000)
        back = True
    except Exception:  # noqa: BLE001
        pass
    record("F4.C 取消拦截后账号表恢复", back)

    step("F4.D 加载态骨架：挂起响应期间骨架留白一致")
    select_theme(page, "light")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.wait_for_timeout(250)

    # handler 立即返回、把 route 存起不 resolve：请求挂起 → 加载态持续，可从容测量；
    # handler 不 sleep 故不阻塞 dispatcher（阻塞式 sleep 会错过整个加载窗口）。
    held_routes = []

    def hold_users(route, request) -> None:
        if request.method == "GET":
            held_routes.append(route)
        else:
            route.continue_()

    page.route(users_url, hold_users)
    try:
        page.reload(wait_until="domcontentloaded")
        seen_loading = False
        g_loading = None
        deadline = time.time() + 12
        while time.time() < deadline:
            if (
                page.locator(".accounts-list-section .table-wrap").count() >= 1
                and "加载中" in (page.locator(".accounts-list-section").inner_text() or "")
            ):
                seen_loading = True
                g_loading = f4_gap(page)
                break
            page.wait_for_timeout(100)
        record("F4.D 响应挂起期间出现「加载中」骨架", seen_loading)
        record(
            "F4.D 加载态两区间距 24±1px",
            g_loading is not None
            and g_loading["boxGap"] is not None
            and abs(g_loading["boxGap"] - 24) <= 1,
            f"gap={g_loading}",
        )
        shot(page, "f4-accounts-loading-1280")
    finally:
        for r in held_routes:
            try:
                r.continue_()
            except Exception:  # noqa: BLE001
                pass
        try:
            page.unroute(users_url, hold_users)
        except Exception:  # noqa: BLE001
            pass
    f4_reload_accounts(page)
    page.wait_for_selector(".accounts-list-section table", timeout=10000)

    step("F4.E 错误态：请求中断 → InlineError + 骨架间距不变")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.wait_for_timeout(250)

    def abort_users(route, request) -> None:
        if request.method == "GET":
            route.abort()
        else:
            route.continue_()

    page.route(users_url, abort_users)
    try:
        page.reload(wait_until="domcontentloaded")
        ok_err = False
        try:
            page.wait_for_selector(".inline-error", timeout=10000)
            ok_err = True
        except Exception:  # noqa: BLE001
            pass
        record("F4.E 列表请求中断后出现 .inline-error", ok_err)
        record(
            "F4.E .inline-error 带 role=alert 且位于 .accounts-sections 之前",
            page.evaluate(
                "() => { const e = document.querySelector('.inline-error[role=\"alert\"]');"
                " const s = document.querySelector('.accounts-sections');"
                " return !!(e && s && (e.compareDocumentPosition(s) & 4)); }"
            ),
        )
        g_err = f4_gap(page)
        record(
            "F4.E 错误态骨架两区间距 24±1px",
            g_err is not None and g_err["boxGap"] is not None and abs(g_err["boxGap"] - 24) <= 1,
            f"gap={g_err}",
        )
        shot(page, "f4-accounts-error-1280")
    finally:
        try:
            page.unroute(users_url, abort_users)
        except Exception:  # noqa: BLE001
            pass
    rec = False
    try:
        f4_reload_accounts(page)
        page.wait_for_selector(".accounts-list-section tbody tr", timeout=12000)
        rec = page.locator(".inline-error").count() == 0
    except Exception:  # noqa: BLE001
        pass
    record("F4.E 取消拦截后错误消失、列表恢复", rec)

    step("F4.F 键盘焦点：Tab 到达新建账号输入 #un，焦点环 2px 可见且不被裁切")
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
    hit = False
    for _ in range(80):
        page.keyboard.press("Tab")
        page.wait_for_timeout(40)
        hit = page.evaluate("() => !!(document.activeElement && document.activeElement.id === 'un')")
        if hit:
            break
    record("F4.F Tab 可到达新建账号输入 #un", hit)
    if hit:
        ol = page.evaluate(
            "() => { const s = getComputedStyle(document.activeElement);"
            " return [s.outlineWidth, s.outlineStyle]; }"
        )
        record("F4.F #un 焦点环 2px solid 可见", ol[0] == "2px" and ol[1] == "solid", f"outline={ol}")
        vis = page.evaluate(
            "() => { const r = document.activeElement.getBoundingClientRect();"
            " return r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1; }"
        )
        record("F4.F #un 焦点元素完整落于视口内（未被裁切）", vis)

    step("F4.G 账号操作：UI 创建 → 禁用/启用 → 重置密码弹窗")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(250)
    uname = "e2e-f4-" + secrets.token_hex(3)
    page.fill("#un", uname)
    page.fill("#up", "pw-" + secrets.token_hex(6))
    page.locator(".accounts-create-section .btn.primary", has_text="创建账号").click()
    created = False
    deadline = time.time() + 12
    while time.time() < deadline:
        if page.locator(".accounts-list-section tbody tr", has_text=uname).count() >= 1:
            created = True
            break
        page.wait_for_timeout(300)
    record("F4.G UI 创建账号成功（列表出现新用户）", created)
    if created:
        row = page.locator(".accounts-list-section tbody tr", has_text=uname).first
        row.locator(".btn", has_text="禁用").click()
        dis = False
        deadline = time.time() + 10
        while time.time() < deadline:
            r = page.locator(".accounts-list-section tbody tr", has_text=uname).first
            if r.count() >= 1 and "已禁用" in (r.inner_text() or ""):
                dis = True
                break
            page.wait_for_timeout(300)
        record("F4.G 禁用新账号（行出现「已禁用」）", dis)
        r = page.locator(".accounts-list-section tbody tr", has_text=uname).first
        r.locator(".btn", has_text="启用").click()
        en = False
        deadline = time.time() + 10
        while time.time() < deadline:
            r = page.locator(".accounts-list-section tbody tr", has_text=uname).first
            if r.count() >= 1 and "已禁用" not in (r.inner_text() or ""):
                en = True
                break
            page.wait_for_timeout(300)
        record("F4.G 重新启用新账号", en)
        r = page.locator(".accounts-list-section tbody tr", has_text=uname).first
        r.locator(".btn", has_text="重置密码").click()
        modal_ok = False
        try:
            page.wait_for_selector(".overlay .modal", timeout=8000)
            modal_ok = True
        except Exception:  # noqa: BLE001
            pass
        record("F4.G 重置密码弹窗出现", modal_ok)
        if modal_ok:
            page.fill("#prompt-input", "pw2-" + secrets.token_hex(6))
            page.locator(".modal .btn.primary", has_text="重置密码").click()
            toast_ok = False
            deadline = time.time() + 8
            while time.time() < deadline:
                if page.locator(".toast", has_text="密码已重置").count() >= 1:
                    toast_ok = True
                    break
                page.wait_for_timeout(250)
            record("F4.G 重置密码提交成功（toast 确认）", toast_ok)
            page.wait_for_timeout(400)

    step("F4.H 还原：1440 视口 + system 主题 + 回到反馈页")
    page.set_viewport_size({"width": 1440, "height": 900})
    select_theme(page, "system")
    page.wait_for_timeout(250)
    page.locator(".nav-item:visible", has_text="反馈").first.click()
    page.wait_for_timeout(500)


# ---------- 业务回归（隔离环境） ----------


def wait_row_with_text(page, needle: str, timeout: float = 10.0) -> bool:
    """等 .fb-table 中出现含指定文本的行（搜索/切换视图后的渲染收敛轮询）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.locator(".fb-table tbody tr", has_text=needle).count() >= 1:
            return True
        page.wait_for_timeout(300)
    return False


def sec_regression(page, base: str) -> None:
    """登录 → 反馈页；UI 创建软件；搜索 → 抽屉；归档一条 → 删除确认弹窗。"""
    try:
        admin_login(page, base)
        ok = True
    except Exception:  # noqa: BLE001
        ok = False
    check("重新登录成功（业务回归前置）", ok)
    check(
        "登录后落在反馈页",
        page.locator(".view-tab").count() >= 3 or page.locator(".page-header h1", has_text="反馈").count() >= 1,
    )

    step("R2 UI 创建软件配置并保存")
    page.locator(".nav-item:visible", has_text="软件配置").first.click()
    page.wait_for_selector("table, .empty, #an", timeout=15000)
    page.fill("#an", "E2E UI 验收软件")
    page.fill("#ai2", UI_APP_ID)
    page.locator("button", has_text="创建").first.click()
    try:
        page.wait_for_selector(f"text={UI_APP_ID}", timeout=15000)
        created = True
    except Exception:  # noqa: BLE001
        created = False
    check("UI 创建软件配置并保存成功（列表出现新 appId）", created and UI_APP_ID in body_text(page))
    shot(page, "06-app-created")

    step("R3 反馈列表搜索筛选 → 详情抽屉")
    page.locator(".nav-item:visible", has_text="反馈").first.click()
    page.wait_for_selector(SEARCH_SEL, timeout=15000)
    page.fill(SEARCH_SEL, FB_FIND_TEXT)
    rows = -1
    deadline = time.time() + 10
    while time.time() < deadline:
        rows = page.locator(".fb-table tbody tr").count()
        if rows == 1:
            break
        page.wait_for_timeout(300)
    check("反馈列表搜索筛选出唯一目标", rows == 1, f"rows={rows}")
    page.locator(".fb-table tbody tr", has_text=ROW_FIND_NEEDLE).first.click()
    opened = False
    try:
        page.wait_for_selector(".drawer", timeout=10000)
        # 语义判据（不依赖视觉 class）：抽屉正文渲染出该条反馈原文。
        # v11 抽屉里原文是「用户原话」时间线首条（.drawer-body 内 detail.text，无 .quote 节点）。
        deadline = time.time() + 10
        while time.time() < deadline:
            if (
                page.locator(".drawer .drawer-body").count() >= 1
                and ROW_FIND_NEEDLE in (page.locator(".drawer").inner_text() or "")
            ):
                opened = True
                break
            page.wait_for_timeout(300)
    except Exception:  # noqa: BLE001
        pass
    check("点击行打开详情抽屉（.drawer 出现且正文含该反馈原文）", opened)
    shot(page, "07-feedback-drawer")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    step("R4 归档一条（种子已同步反馈 → 已归档区域）")
    # F2 夹具后收件箱 ~57 条、PAGE_SIZE=50 游标分页（创建时间倒序）：最早创建的 SYNC
    # 种子行落在第二页，必须先按针文本搜出来再操作（分页本身是 F2.A 的受测行为，不改）。
    page.fill(SEARCH_SEL, ROW_SYNC_NEEDLE)
    check("R4 搜索定位到种子 SYNC 行", wait_row_with_text(page, ROW_SYNC_NEEDLE, 12))
    row = page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).first
    row.locator(".more-menu > button").click()
    page.locator(".more-menu-pop button", has_text="归档").click()
    page.wait_for_timeout(1200)
    goto_view(page, "archived")
    # q 过滤在视图间保留：归档视图只命中 SYNC 行；等渲染收敛再断言。
    wait_row_with_text(page, ROW_SYNC_NEEDLE, 10)
    check(
        "归档一条反馈后进入「已归档」区域",
        page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).count() >= 1,
    )
    shot(page, "08-archived")

    step("R5 删除确认弹窗：移入回收站 → 彻底删除")
    wait_row_with_text(page, ROW_SYNC_NEEDLE, 10)
    row = page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).first
    row.locator(".more-menu > button").click()
    page.locator(".more-menu-pop button", has_text="移入回收站").click()
    modal_ok = False
    try:
        page.wait_for_selector(".overlay .modal", timeout=8000)
        modal_ok = True
    except Exception:  # noqa: BLE001
        pass
    check("删除确认弹窗出现（移入回收站 ConfirmDialog）", modal_ok)
    shot(page, "09-trash-confirm")
    page.locator(".modal .btn", has_text="移入回收站").last.click()
    page.wait_for_timeout(1000)
    goto_view(page, "trash")
    # 回收站仅 SYNC + F2 无标题夹具两行、不分页，但视图切换仍是异步加载：先等行渲染。
    wait_row_with_text(page, ROW_SYNC_NEEDLE, 10)
    check("回收站出现该反馈", page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).count() >= 1)
    row = page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).first
    row.locator(".more-menu > button").click()
    page.locator(".more-menu-pop button", has_text="彻底删除").click()
    modal_ok = False
    try:
        page.wait_for_selector(".overlay .modal", timeout=8000)
        modal_ok = True
    except Exception:  # noqa: BLE001
        pass
    check(
        "彻底删除确认弹窗出现（requireText 输入框）",
        modal_ok and page.locator("#confirm-text").count() >= 1,
    )
    page.locator("#confirm-text").fill("删除")
    page.locator(".modal .btn.danger").click()
    page.wait_for_timeout(1200)
    check(
        "彻底删除完成（回收站清空该条）",
        page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).count() == 0,
    )
    shot(page, "10-purged")


# ---------- Feedback-3：规则保存状态可信 + 后台诊断日志 ----------
FB3_RENAME = "E2E-FB3 改名验证"
FB3_MARK_A = "UIE2E-FB3-NOLOG"
FB3_MARK_B = "UIE2E-FB3-WITHLOG"
DIAG_FILENAME = "admin-diagnostics.jsonl"
DIAG_LEVELS = {"info", "warn", "error"}
DIAG_EVENTS = {"api_request", "auth_session", "handshake", "diagnostics"}
DIAG_CODES = {
    "ok",
    "version_conflict",
    "unauthorized",
    "forbidden",
    "not_found",
    "invalid_request",
    "app_exists",
    "incomplete_rule",
    "invalid_rule",
    "invalid_state",
    "kaneo_unavailable",
    "daily_quota_exceeded",
    "rate_limited",
    "conflict",
    "server_error",
    "network",
    "timeout",
    "unknown",
}
DIAG_KEYS = {"time", "level", "event", "code", "status"}


def fb3_status_text(page) -> str:
    els = page.locator(".rule-status")
    return els.inner_text() if els.count() else ""


def fb3_tags(page) -> list:
    return [t.strip() for t in page.locator(".rule-status-tag").all_inner_texts()]


def fb3_wait_tag(page, needle: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in fb3_tags(page):
            return True
        page.wait_for_timeout(300)
    return needle in fb3_tags(page)


def sec_fb3_rule_status(page, h: Http, base: str) -> None:
    """FB3-A 软件配置页规则状态摘要：缺项/未保存/已保存/409 冲突/普通保存零同步。"""
    step("FB3.1 种子软件详情：「规则缺项」与「来源待确认」分开显示")
    page.locator(".nav-item:visible", has_text="软件配置").first.click()
    page.wait_for_selector("table", timeout=15000)
    page.locator("tbody tr", has_text=SEED_APP_ID).first.locator("button", has_text="配置").click()
    page.wait_for_selector(".rule-status", timeout=15000)
    # 规则选项（列/标签）异步加载完成才算详情就绪
    page.wait_for_selector(".label-picker", timeout=15000)
    txt = fb3_status_text(page)
    record("FB3.1 缺列ID/标签的软件显示「规则缺项」", "规则缺项" in txt, f"tags={fb3_tags(page)}")
    record(
        "FB3.1 缺项明细指明「缺目标列 ID」与「缺至少一个工作区标签」",
        "缺目标列 ID" in txt and "缺至少一个工作区标签" in txt,
        f"text={txt[:200]}",
    )
    record(
        "FB3.1 「来源待确认」独立于规则缺项单独显示",
        "来源待确认" in txt,
        f"text={txt[:240]}",
    )
    shot(page, "fb3-rule-missing")

    step("FB3.2 编辑规则 → 「未保存」；补齐列+标签保存 → 「已保存」")
    page.select_option("#col", "col-1")
    page.locator(".label-picker input[type=checkbox]").first.check()
    page.wait_for_timeout(300)
    record("FB3.2 表单修改后显示「未保存」", "未保存" in fb3_tags(page), f"tags={fb3_tags(page)}")
    # 保存前的 mock Kaneo 任务数：早前夹具归档已合法创建任务，零写远端须按增量判定。
    _, mock_tasks_before = h.call("GET", f"http://127.0.0.1:{KANEO_PORT}/__mock/tasks")
    tasks_before = len((mock_tasks_before or {}).get("tasks") or [])
    page.locator("button.btn.primary", has_text="保存配置").first.click()
    check("FB3.2 完整规则保存成功并回读确认（「已保存」出现）", fb3_wait_tag(page, "已保存"), f"tags={fb3_tags(page)}")
    txt = fb3_status_text(page)
    record("FB3.2 保存后「规则缺项」标签消失", "规则缺项" not in fb3_tags(page), f"tags={fb3_tags(page)}")
    record("FB3.2 已保存行展示规则版本号", "规则 v" in txt, f"text={txt[:200]}")
    shot(page, "fb3-rule-saved")

    step("FB3.3 普通保存零同步：archiveMode 仍 manual、保存前后 mock 任务数不变、回读完整")
    st, apps_body = h.call("GET", f"{base}/api/admin/apps")
    app = next((a for a in (apps_body or {}).get("apps", []) if a["appId"] == SEED_APP_ID), None)
    record(
        "FB3.3 普通保存后软件仍为人工同步模式（未触发自动同步）",
        app is not None and app.get("archiveMode") == "manual",
        f"mode={(app or {}).get('archiveMode')}",
    )
    _, mock_tasks = h.call("GET", f"http://127.0.0.1:{KANEO_PORT}/__mock/tasks")
    tasks_after = len((mock_tasks or {}).get("tasks") or [])
    record(
        "FB3.3 普通保存未产生新的远端任务（保存前后任务数不变）",
        tasks_after == tasks_before,
        f"before={tasks_before} after={tasks_after}",
    )
    record(
        "FB3.3 GET 回读 ruleComplete=true（ID/标签一致落库）",
        app is not None
        and app.get("ruleComplete") is True
        and app.get("defaults", {}).get("columnId") == "col-1"
        and len(app.get("defaults", {}).get("labelIds", [])) >= 1,
        f"app={app}",
    )

    step("FB3.4 409 冲突：API 侧推进版本 → UI 持旧版本保存 → 「保存冲突」+ 草稿保留")
    ver = app["ruleVersion"] if app else None
    check("FB3.4 前置：拿到种子软件 ruleVersion", ver is not None)
    st, put_body = h.call(
        "PUT",
        f"{base}/api/admin/apps/{app['id']}",
        {
            "name": app["name"],
            "allowedOrigins": app["allowedOrigins"],
            "kaneoProjectId": app["kaneoProjectId"],
            "kaneoColumnSlug": app["kaneoColumnSlug"],
            "kaneoColumnId": app["defaults"]["columnId"],
            "kaneoLabelIds": app["defaults"]["labelIds"],
            "kaneoAssigneeId": app["defaults"]["assigneeId"],
            "kaneoAssigneeName": app["defaults"]["assigneeName"],
            "expectedRuleVersion": ver,
        },
    )
    check("FB3.4 前置：API 侧保存推进规则版本成功", st == 200, f"status={st} body={put_body}")
    page.fill("#an", FB3_RENAME)
    page.wait_for_timeout(300)
    record("FB3.4 改名后显示「未保存」", "未保存" in fb3_tags(page), f"tags={fb3_tags(page)}")
    page.locator("button.btn.primary", has_text="保存配置").first.click()
    conflict_shown = fb3_wait_tag(page, "保存冲突")
    record(
        "FB3.4 过期版本保存显示「保存冲突」（409 version_conflict）",
        conflict_shown,
        f"tags={fb3_tags(page)} text={fb3_status_text(page)[:240]}",
    )
    shot(page, "fb3-rule-conflict")
    record(
        "FB3.4 冲突后表单草稿保留（名称仍是用户输入）",
        page.locator("#an").input_value() == FB3_RENAME,
        f"an={page.locator('#an').input_value()}",
    )
    record(
        "FB3.4 冲突行提示最新保存版本供比较",
        "最新保存版本" in fb3_status_text(page),
        f"text={fb3_status_text(page)[:240]}",
    )

    step("FB3.5 比较后再次保存（新版本）→ 成功且草稿生效")
    # T1 契约：409 后快照读取成功自动进入逐项比较，需「应用比较结果」解冻后再保存。
    region_open = t1_wait_conflict(page, 15)
    record(
        "FB3.5 冲突后比较区打开（逐项比较入口）",
        region_open,
        f"region={t1_conflict_visible(page)} status={fb3_status_text(page)[:160]!r}",
    )
    # 外部保存未改名称/来源/目标 → 各组自动采用；「应用比较结果」直接可用。
    if t1_conflict_visible(page):
        page.locator("button", has_text=T1_UI["conflict_apply_text"]).first.click()
        page.wait_for_timeout(400)
    page.locator("button.btn.primary", has_text="保存配置").first.click()
    saved_again = fb3_wait_tag(page, "已保存")
    record(
        "FB3.5 冲突后再次保存成功（「已保存」且冲突行消失）",
        saved_again and "保存冲突" not in fb3_status_text(page),
        f"tags={fb3_tags(page)}",
    )
    st, detail = h.call("GET", f"{base}/api/admin/apps/{app['id']}")
    record(
        "FB3.5 服务端名称为再次保存的草稿值",
        (detail or {}).get("app", {}).get("name") == FB3_RENAME,
        f"name={(detail or {}).get('app', {}).get('name')}",
    )
    shot(page, "fb3-rule-resaved")


def sec_fb3_write_refresh_failure(page) -> None:
    """写请求成功、紧随其后的列表 GET 失败时区分已写入并可安全重试刷新。"""
    step("FB3.5a 新建成功但列表刷新失败：保留已写入状态并重试 GET")
    page.locator(".nav-item:visible", has_text="软件配置").first.click()
    page.wait_for_selector(".rule-status", timeout=15000)
    cancel = page.locator("button", has_text="取消编辑")
    if cancel.count():
        cancel.click()
    app_id = f"com.e2e.refresh-{secrets.token_hex(4)}"
    app_name = "E2E 刷新失败新建"
    page.fill("#an", app_name)
    page.fill("#ai2", app_id)

    def run_failure_case(method: str, write_path: str, label: str, click_save) -> dict:
        state = {
            "writes": 0,
            "write_status": None,
            "list_failures": 0,
            "list_failure_status": None,
            "armed": False,
            "app_id": None,
        }

        def fail_first_post_write_list(route, request) -> None:
            path = urlsplit(request.url).path.rstrip("/")
            if request.method == "GET" and path.endswith("/api/admin/apps") and state["armed"]:
                state["list_failures"] += 1
                state["armed"] = False
                if state["list_failures"] == 1:
                    state["list_failure_status"] = 503
                    route.fulfill(
                        status=503,
                        content_type="application/json",
                        body='{"error":{"code":"server_error","message":"E2E 注入列表刷新失败"}}',
                    )
                    return
            if request.method == method and path == write_path:
                state["writes"] += 1
                response = route.fetch()
                state["write_status"] = response.status
                if 200 <= response.status < 300:
                    state["armed"] = True
                    if method == "POST":
                        try:
                            state["app_id"] = response.json().get("id")
                        except Exception:  # noqa: BLE001
                            pass
                route.fulfill(response=response)
                return
            route.continue_()

        page.route("**/api/admin/apps**", fail_first_post_write_list)
        try:
            with page.expect_response(
                lambda response: response.request.method == method
                and urlsplit(response.url).path.rstrip("/") == write_path,
                timeout=15000,
            ) as write_response:
                click_save()
            check(
                f"{label} 捕获到唯一成功写请求",
                state["writes"] == 1 and 200 <= write_response.value.status < 300,
                f"writes={state['writes']} status={write_response.value.status}",
            )
            deadline = time.time() + 15
            while time.time() < deadline and state["list_failures"] == 0:
                page.wait_for_timeout(50)
            check(
                f"{label} 成功写入后的首个列表 GET 被注入 503",
                state["list_failures"] == 1 and state["list_failure_status"] == 503,
                f"writes={state['writes']} listFailures={state['list_failures']} status={state['list_failure_status']}",
            )
            status_text = ""
            while time.time() < deadline:
                status_text = page.locator(".rule-status").inner_text()
                if "已保存，但列表刷新失败" in status_text:
                    break
                page.wait_for_timeout(100)
            record(
                f"{label} 写请求成功后首个列表 GET 失败仍显示已保存",
                "已保存，但列表刷新失败" in status_text and "未写入" not in status_text,
                f"writes={state['writes']} listFailures={state['list_failures']} status={status_text[:220]!r}",
            )
            record(
                f"{label} 失败来自首次刷新而非写入失败",
                state["writes"] == 1
                and state["write_status"] is not None
                and 200 <= state["write_status"] < 300
                and state["list_failures"] == 1
                and state["list_failure_status"] == 503,
                f"writes={state['writes']} writeStatus={state['write_status']} "
                f"listFailures={state['list_failures']} listStatus={state['list_failure_status']}",
            )
            retry = page.locator(".rule-status button", has_text="重试刷新")
            record(f"{label} 显示可重试刷新操作", retry.count() == 1 and retry.is_enabled())
            if retry.count() == 1 and retry.is_enabled():
                retry.click()
                deadline = time.time() + 15
                while time.time() < deadline:
                    status_text = page.locator(".rule-status").inner_text()
                    if "刷新失败" not in status_text and not page.locator(".rule-status button", has_text="重试刷新").count():
                        break
                    page.wait_for_timeout(100)
            record(
                f"{label} 重试刷新后状态恢复且没有再次写入",
                "刷新失败" not in status_text
                and state["writes"] == 1
                and state["list_failures"] == 1
                and "未写入" not in status_text,
                f"writes={state['writes']} listFailures={state['list_failures']} status={status_text[:220]!r}",
            )
            return state
        finally:
            try:
                page.unroute("**/api/admin/apps**", fail_first_post_write_list)
            except Exception:  # noqa: BLE001
                pass

    create = run_failure_case(
        "POST",
        "/api/admin/apps",
        "FB3 新建",
        lambda: page.locator(".btn.primary", has_text="创建").click(),
    )
    record("FB3 新建失败后重试刷新没有第二个 POST", create["writes"] == 1)
    created = create.get("app_id")
    check("FB3 新建回读重试后表格出现已创建软件", bool(created) and page.locator("tbody tr", has_text=app_id).count() == 1)

    step("FB3.5b 编辑成功但列表刷新失败：保留已写入状态并重试 GET")
    check("FB3 编辑回归可打开新建的软件", page.locator("tbody tr", has_text=app_id).count() == 1)
    page.locator("tbody tr", has_text=app_id).first.locator("button", has_text="配置").click()
    page.wait_for_function(
        """(name) => {
          const heading = [...document.querySelectorAll('h2')]
            .find((el) => el.textContent.trim() === `配置：${name}`);
          const nameInput = document.querySelector('#an');
          const appIdInput = document.querySelector('#ai2');
          const projectInput = document.querySelector('#pid');
          const save = [...document.querySelectorAll('button.btn.primary')]
            .find((el) => el.textContent.includes('保存配置'));
          return !!heading && nameInput?.value === name && appIdInput?.disabled === true
            && !!projectInput && !projectInput.disabled && !!save && !save.disabled;
        }""",
        arg=app_name,
        timeout=15000,
    )
    check("FB3 编辑详情字段、项目控件与保存操作已就绪", bool(created))
    page.fill("#an", "E2E 刷新失败编辑")
    edit = run_failure_case(
        "PUT",
        f"/api/admin/apps/{created}",
        "FB3 编辑",
        lambda: page.locator(".btn.primary", has_text="保存配置").click(),
    )
    check("FB3 编辑写入只请求一次 PUT", edit["writes"] == 1)
    check(
        "FB3 编辑刷新重试后保留服务端名称",
        page.locator("#an").input_value() == "E2E 刷新失败编辑",
    )


def fb3_open_widget(page) -> bool:
    """打开组件面板并等日志采集落「已附诊断日志」。"""
    page.locator(".fb-orb").click()
    page.wait_for_selector(".fb-textarea", timeout=30000)
    deadline = time.time() + 20
    while time.time() < deadline:
        st_el = page.locator(".fb-logs-summary")
        if st_el.count() and st_el.is_visible() and "已附诊断日志" in (st_el.inner_text() or ""):
            return True
        page.wait_for_timeout(300)
    return False


def fb3_submit(page, text: str) -> bool:
    """组件内填写并提交，等「已保存」状态出现。"""
    page.fill(".fb-textarea", text)
    # 等握手会话就绪：主按钮从「登录并提交」变为「提交」
    deadline = time.time() + 30
    while time.time() < deadline:
        btn = page.locator(".fb-submit").first
        if btn.count() and btn.inner_text().strip() == "提交":
            break
        page.wait_for_timeout(300)
    page.locator(".fb-submit").first.click()
    deadline = time.time() + 40
    while time.time() < deadline:
        s = page.locator(".fb-status")
        if s.count() and "已保存" in (s.inner_text() or ""):
            return True
        page.wait_for_timeout(400)
    return False


def fb3_find_feedback(h: Http, base: str, marker: str, timeout: float = 15.0) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, body = h.call("GET", f"{base}/api/admin/feedback?q={marker}")
        items = (body or {}).get("items") or []
        if items:
            return items[0]["id"]
        time.sleep(0.5)
    return None


def sec_fb3_widget_diag(page, h: Http, base: str) -> None:
    """FB3-B 组件诊断日志：附加/移除不重附加/登出清空/跨会话隔离/真实 JSONL 哨兵扫描。"""
    step("FB3.6 打开组件面板：显示「已附诊断日志」+ 附件列表含诊断文件")
    record("FB3.6 组件打开后显示「已附诊断日志」", fb3_open_widget(page), f"status={page.locator('.fb-logs-summary').inner_text() if page.locator('.fb-logs-summary').count() else '∅'}")
    record(
        "FB3.6 附件列表含 admin-diagnostics.jsonl（自动来源徽标）",
        page.locator(".fb-log-item", has_text=DIAG_FILENAME).count() >= 1,
        f"items={page.locator('.fb-log-name').all_inner_texts()}",
    )
    shot(page, "fb3-widget-attached")

    step("FB3.7 移除附件 → 关闭重开不静默重附加 → 提交（无日志）")
    # 本轮 T4：日志区默认只显示摘要，条目与「删除 / 预览」在展开后的体内 → 先展开再操作。
    _logs_toggle = page.locator(".fb-logs-toggle")
    if _logs_toggle.count() and _logs_toggle.first.get_attribute("aria-expanded") != "true":
        _logs_toggle.first.click()
        page.wait_for_timeout(250)
    page.locator(".fb-log-btn-remove").first.click()
    page.wait_for_timeout(400)
    record(
        "FB3.7 移除后附件列表清空",
        page.locator(".fb-log-item").count() == 0,
        f"items={page.locator('.fb-log-item').count()}",
    )
    # 用面板关闭按钮而非 Escape：移除按钮删除自身后焦点离开组件，Esc 不触发 close。
    page.locator(".fb-close").first.click()
    page.wait_for_timeout(600)
    page.locator(".fb-orb").click()
    page.wait_for_selector(".fb-textarea", timeout=30000)
    page.wait_for_timeout(1500)
    record(
        "FB3.7 重开面板不静默重附加（日志区仍为空）",
        page.locator(".fb-log-item").count() == 0,
        f"items={page.locator('.fb-log-item').count()} status={page.locator('.fb-logs-summary').inner_text() if page.locator('.fb-logs-summary').count() else '∅'}",
    )
    check("FB3.7 无日志纯文本提交成功", fb3_submit(page, f"{FB3_MARK_A} 移除日志后纯文本提交"))
    page.locator(".fb-close").first.click()
    page.wait_for_timeout(600)
    fb_a = fb3_find_feedback(h, base, FB3_MARK_A)
    check("FB3.7 管理端可检索到无日志提交", fb_a is not None)
    st, det_a = h.call("GET", f"{base}/api/admin/feedback/{fb_a}")
    logs_a = (det_a or {}).get("logs") or []
    record(
        "FB3.7 移除后提交确实不带诊断附件",
        all(l.get("filename") != DIAG_FILENAME for l in logs_a),
        f"logs={logs_a}",
    )

    step("FB3.8 登出→重登：诊断缓冲清空换代，组件实例按身份重建")
    page.locator("button", has_text="退出").last.click()
    page.wait_for_selector("#u", timeout=15000)
    admin_login(page, base)
    check("FB3.8 重登成功（新会话）", page.locator(".nav-item:visible").count() >= 1)

    step("FB3.9 新会话重开组件：诊断日志重新附加并提交")
    check("FB3.9 新会话显示「已附诊断日志」", fb3_open_widget(page))
    check("FB3.9 新会话提交成功（附诊断日志）", fb3_submit(page, f"{FB3_MARK_B} 新会话诊断日志"))
    page.locator(".fb-close").first.click()
    page.wait_for_timeout(600)
    shot(page, "fb3-widget-submitted")

    step("FB3.10 服务端核验：附件存在、体积合规、JSONL 白名单与哨兵扫描")
    fb_b = fb3_find_feedback(h, base, FB3_MARK_B)
    check("FB3.10 管理端可检索到新会话提交", fb_b is not None)
    st, det_b = h.call("GET", f"{base}/api/admin/feedback/{fb_b}")
    logs_b = (det_b or {}).get("logs") or []
    diag = next((l for l in logs_b if l.get("filename") == DIAG_FILENAME), None)
    record(
        "FB3.10 反馈附带 admin-diagnostics.jsonl（source=auto）",
        diag is not None and diag.get("source") == "auto",
        f"logs={logs_b}",
    )
    if diag is None:
        return
    record(
        "FB3.10 附件非空且 ≤256KiB",
        0 < int(diag.get("byteSize") or 0) <= 256 * 1024,
        f"byteSize={diag.get('byteSize')}",
    )
    st, raw = h.call_raw("GET", f"{base}/api/admin/feedback/{fb_b}/logs/{diag['id']}")
    check("FB3.10 附件内容可下载（200）", st == 200 and isinstance(raw, (bytes, bytearray)), f"status={st}")
    text = raw.decode("utf-8", errors="replace")
    lines = [l for l in text.strip().split("\n") if l.strip()]
    entries = []
    parse_ok = True
    for line in lines:
        try:
            entries.append(json.loads(line))
        except Exception:  # noqa: BLE001
            parse_ok = False
    record("FB3.10 JSONL 每行均为合法 JSON 且非空", parse_ok and len(entries) >= 1, f"lines={len(lines)}")
    key_ok = all(set(e.keys()) <= DIAG_KEYS for e in entries)
    val_ok = all(
        e.get("level") in DIAG_LEVELS
        and e.get("event") in DIAG_EVENTS
        and ("code" not in e or e["code"] in DIAG_CODES)
        and ("status" not in e or (isinstance(e["status"], int) and 100 <= e["status"] <= 599))
        for e in entries
    )
    record("FB3.10 条目仅含白名单字段（time/level/event/code/status）", key_ok, f"keys={[sorted(e.keys()) for e in entries[:5]]}")
    record("FB3.10 level/event/code/status 全部落在白名单枚举", val_ok)
    sentinels = [ADMIN_PASS, USER_PASS, "Bearer", "token", "cookie", "password", "http://", "https://", FB3_MARK_B]
    leaked = [s for s in sentinels if s in text]
    record("FB3.10 哨兵扫描：无密码/凭据/URL/反馈正文泄漏", leaked == [], f"leaked={leaked}")
    record(
        "FB3.10 跨会话隔离：新会话日志无旧会话 version_conflict 事件",
        all(e.get("code") != "version_conflict" for e in entries),
        f"codes={[e.get('code') for e in entries]}",
    )
    record(
        "FB3.10 新会话日志含 auth_session 起点标记",
        any(e.get("event") == "auth_session" for e in entries),
        f"events={[e.get('event') for e in entries]}",
    )


# ---------- Kaneo In Review：T1 软件配置竞态/冲突比较 + T4 工单筛选计数 ----------
#
# 断言分级沿用文件头契约：
# - check()  夹具/前置硬断言（失败中断当节）；
# - record() 请求级硬断言（拦截到的请求方法/计数/请求体——实现无关，失败即 FAIL）；
# - spec()   新交互契约断言（比较区、草稿保护语义——A 未落地时记 pending 而非 FAIL）。
#
# 新交互的选择器/文案全部集中在 T1_UI / T1_GROUPS：A 交付后按真实 DOM 收窄即可，
# 场景流程与断言语义不需改动。


def _t1_path(path: str) -> str:
    """规范化请求路径：去查询串与尾斜杠。"""
    return urlsplit(path).path.rstrip("/")


def t1_put_body(app_row_id: str) -> dict:
    """PUT /api/admin/apps/<id> 请求体：kaneo* 字段与 validateAppDefaults 契约一致。"""
    return {
        "name": "E2E-T1 外部保存",
        "allowedOrigins": [],
        "kaneoProjectId": "p-e2e",
        "kaneoColumnId": "col-1",
        "kaneoColumnSlug": "triage",
        "kaneoLabelIds": ["label-bug"],
        "kaneoAssigneeId": None,
        "expectedRuleVersion": None,  # 调用方填
    }


def t1_api_put_app(h: Http, base: str, app_row_id: str, expected_version: int, **over) -> tuple[int, dict]:
    """外部（非 UI）保存：用于推进版本制造 409 与「另一对象保存」。"""
    body = t1_put_body(app_row_id)
    body["expectedRuleVersion"] = expected_version
    body.update(over)
    st, resp = h.call("PUT", f"{base}/api/admin/apps/{app_row_id}", body)
    return st, resp or {}


def t1_goto_apps(page) -> None:
    """导航到软件配置页并等表格/表单就绪（重复导航时强制视图重挂载取新列表）。"""
    nav = page.locator(".nav-item:visible", has_text="软件配置").first
    nav.click()
    page.wait_for_selector("#an", timeout=15000)
    page.wait_for_timeout(300)


def t1_reset_apps_view(page) -> None:
    """强制 AppsView 重挂载：离开到反馈页再回来（重置 selected/draft/表单为新建态）。"""
    page.locator(".nav-item:visible", has_text="反馈").first.click()
    page.wait_for_selector(SEARCH_SEL, timeout=15000)
    page.wait_for_timeout(300)
    t1_goto_apps(page)


def t1_open_detail(page, app_id: str, timeout: float = 15.0) -> bool:
    """点列表「配置」打开详情并等表单回填（#ai2 回填为本对象且 disabled）。"""
    row = page.locator("tbody tr", has_text=app_id).first
    if row.count() == 0:
        return False
    row.locator("button", has_text="配置").click()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if (
                page.locator(T1_UI["field_appid"]).input_value() == app_id
                and page.locator(T1_UI["field_appid"]).is_disabled()
            ):
                return True
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(200)
    return False


def t1_save_button(page):
    """主保存按钮（编辑=「保存配置（不触发同步）」，创建=「创建」）。"""
    for txt in T1_UI["save_button_text"]:
        btn = page.locator("button.btn.primary", has_text=txt)
        if btn.count() >= 1:
            return btn.first
    return page.locator(".btn-row .btn.primary").first


def t1_click_save(page) -> None:
    t1_save_button(page).click()


def t1_try_save(page, timeout: float = 3000) -> bool:
    """尝试点保存：按钮被禁用（比较态/忙碌）时短超时返回 False 而不中断节。"""
    try:
        t1_save_button(page).click(timeout=timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


def t1_wait_status(page, needle: str, timeout: float = 15.0) -> bool:
    """等 .rule-status 出现指定文本。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in fb3_status_text(page):
            return True
        page.wait_for_timeout(200)
    return needle in fb3_status_text(page)


def t1_conflict_visible(page) -> bool:
    """比较区是否打开（实现锚点 [data-conflict-region]）。"""
    try:
        return page.locator(T1_UI["conflict_region"]).count() >= 1
    except Exception:  # noqa: BLE001
        return False


def t1_conflict_pending(page) -> bool:
    """冲突未解决（含比较区未打开/读取失败）——status 行出现「保存冲突」。"""
    return T1_UI["status_conflict"] in fb3_status_text(page)


def t1_wait_conflict(page, timeout: float = 15.0) -> bool:
    """等比较区出现或「保存冲突」状态出现（任一即进入冲突态）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if t1_conflict_visible(page) or t1_conflict_pending(page):
            return True
        page.wait_for_timeout(200)
    return t1_conflict_visible(page) or t1_conflict_pending(page)


def t1_group(page, group_key: str):
    """比较组容器：fieldset[data-conflict-group=key]。"""
    return page.locator(T1_UI["conflict_group_sel"].format(key=group_key))


def t1_group_needs_choice(page, group_key: str) -> bool:
    """该组是否处于「双方不同、需选择」状态（比较区内出现需选择标记）。"""
    g = t1_group(page, group_key)
    if g.count() == 0:
        return False
    return T1_UI["conflict_needs_choice_tag"] in (g.inner_text() or "")


def t1_group_state(page, group_key: str) -> str:
    """读取组态标签原文（需选择/采用我的修改/采用最新保存/双方一致）。"""
    g = t1_group(page, group_key)
    if g.count() == 0:
        return ""
    return (g.inner_text() or "").strip()


def t1_group_choose(page, group_key: str, side: str) -> bool:
    """在指定比较组内选择一侧：side ∈ {"mine","theirs"}（radio name=conflict-{key}）。"""
    g = t1_group(page, group_key)
    if g.count() == 0:
        return False
    radio = g.locator(T1_UI["conflict_radio"].format(key=group_key, side=side))
    if radio.count() >= 1:
        try:
            radio.check()
            return True
        except Exception:  # noqa: BLE001
            pass
    # 退化：按可见文本点 label
    choice = T1_UI["conflict_choice_mine"] if side == "mine" else T1_UI["conflict_choice_latest"]
    lab = g.locator("label", has_text=choice)
    if lab.count() >= 1:
        try:
            lab.first.click()
            return True
        except Exception:  # noqa: BLE001
            pass
    return False


def t1_compare_group_present(page) -> dict:
    """返回各组比较行是否出现（name/origins/target）。"""
    return {k: t1_group(page, v["key"]).count() >= 1 for k, v in T1_GROUPS.items()}


def t1_apply_resolution(page) -> bool:
    btn = page.locator("button", has_text=T1_UI["conflict_apply_text"])
    if btn.count() >= 1 and btn.first.is_enabled():
        btn.first.click()
        return True
    return False


def t1_route_delay(page, match, delay_s: float, counter: dict | None = None, method: str = "GET"):
    """注册延迟路由：匹配请求延迟 delay_s 后放行真实响应。

    match 可以是精确路径字符串（匹配规范化 path）或 url 谓词；method 限定请求方法。
    Playwright 路由谓词只收 URL 字符串，方法判定在 handler 内做。
    """
    if isinstance(match, str):
        want = match
        pred = lambda url: _t1_path(url) == want  # noqa: E731
    else:
        pred = match

    def handler(route, request):
        if request.method == method and pred(request.url):
            if counter is not None:
                counter["n"] = counter.get("n", 0) + 1
            time.sleep(delay_s)
            try:
                # 只放行原请求（延迟由 sleep 提供）：绝不能 route.fetch()——
                # 那会发起第二个真实请求，对 PUT 造成重复写入/版本推进。
                route.continue_()
            except Exception:  # noqa: BLE001
                pass
            if counter is not None:
                counter["done"] = counter.get("done", 0) + 1
            return
        # 不匹配的请求交给下一个匹配处理器（continue_ 会跳过整条链直达网络）。
        route.fallback()

    handler._t1_pred = pred  # unroute 需要注册时的同一谓词对象
    page.route(pred, handler)
    return handler


def t1_unroute(page, handler) -> None:
    """注销 t1_route_delay 注册的路由或 t1_capture_writes 注册的事件监听。"""
    try:
        if hasattr(handler, "_t1_req"):  # capture 监听对
            page.remove_listener("request", handler._t1_req)
            page.remove_listener("response", handler._t1_resp)
            return
        page.unroute(getattr(handler, "_t1_pred", "**/api/**"), handler)
    except Exception:  # noqa: BLE001
        pass


def t1_capture_writes(page, state: dict):
    """计数 + 捕获 POST/PUT 写请求体与响应状态（state['posts']/['puts'] 每项
    {method,path,body,status}）。

    用 request/response 事件而非路由处理器计数：路由 fulfill/continue_ 会跳过
    其余匹配处理器（LIFO 链），事件监听则对所有已发出的请求无条件可见，
    注入延迟/失败路由不会遮蔽写计数。"""
    state.setdefault("posts", [])
    state.setdefault("puts", [])

    def on_request(request):
        try:
            path = _t1_path(request.url)
        except Exception:  # noqa: BLE001
            return
        if request.method == "POST" and path.endswith("/api/admin/apps"):
            state["posts"].append({"method": "POST", "path": path, "body": request.post_data_json or {}, "status": None, "req": request})
        elif request.method == "PUT" and "/api/admin/apps/" in path:
            state["puts"].append({"method": "PUT", "path": path, "body": request.post_data_json or {}, "status": None, "req": request})

    def on_response(response):
        try:
            req = response.request
            path = _t1_path(response.url)
            is_post = req.method == "POST" and path.endswith("/api/admin/apps")
            is_put = req.method == "PUT" and "/api/admin/apps/" in path
            if not (is_post or is_put):
                return
            bucket = state["posts"] if is_post else state["puts"]
            # 先按请求对象精确关联；不同 Request 包装实例退化为 路径+体 匹配。
            for it in reversed(bucket):
                if it["status"] is None and it.get("req") is req:
                    it["status"] = response.status
                    return
            try:
                body = req.post_data_json or {}
            except Exception:  # noqa: BLE001
                body = {}
            for it in reversed(bucket):
                if it["status"] is None and it["path"] == path and it["body"] == body:
                    it["status"] = response.status
                    return
            for it in reversed(bucket):
                if it["status"] is None and it["path"] == path:
                    it["status"] = response.status
                    return
        except Exception:  # noqa: BLE001
            pass

    cap = types.SimpleNamespace(_t1_req=on_request, _t1_resp=on_response)
    page.on("request", on_request)
    page.on("response", on_response)
    return cap


def seed_t1_apps(h: Http, base: str) -> dict:
    """T1 场景三个软件对象（API 创建；完整规则，避免「规则缺项」干扰状态断言）。"""
    out = {}
    for key, app_id in (
        ("race_delay", T1_APP_RACE_DELAY),
        ("race_edit", T1_APP_RACE_EDIT),
        ("conflict", T1_APP_CONFLICT),
    ):
        st, body = h.call(
            "POST",
            f"{base}/api/admin/apps",
            {
                "appId": app_id,
                "name": f"E2E-T1 {key}",
                "allowedOrigins": [],
                "kaneoProjectId": "p-e2e",
                "kaneoColumnId": "col-1",
                "kaneoColumnSlug": "triage",
                "kaneoLabelIds": ["label-bug"],
                "kaneoAssigneeId": None,
            },
        )
        check(f"T1 夹具：软件 {key} 创建 201", st == 201, f"status={st} body={body}")
        out[key] = {"row_id": body["id"], "ruleVersion": body["ruleVersion"], "appId": app_id}
    return out


def sec_t1_delayed_get_race(page, h: Http, base: str, fx: dict) -> None:
    """T1.1 竞态：延迟 GET 期间编辑 → 另一对象保存 → PUT 后继续编辑 → 刷新失败后修改再重试。

    断言：最终字段值与 PUT 请求体（名称/来源/版本），不止状态提示。
    竞态语义：对**同一对象 C**——详情 GET 在途期间用户已改草稿，
    迟到的 GET 不得覆盖编辑（未改字段可合并服务端值，身份必须建立→保存走 PUT）。
    """
    c = fx["race_delay"]   # 延迟 GET 的对象（在其加载窗口内编辑）
    r = fx["race_edit"]    # 另一对象（经 API 保存，模拟第二客户端并行写入）
    c_id, r_id = c["row_id"], r["row_id"]
    my_name = "E2E-T1 竞态草稿名 A1"
    my_origin = "https://race-keep.example.com"
    writes = {"posts": [], "puts": []}

    step("T1.1a 对象 C 详情 GET 延迟 2.2s：在途期间编辑草稿 + 另一对象 R 经 API 保存")
    t1_reset_apps_view(page)
    gets = {"n": 0}
    delay_h = t1_route_delay(page, f"/api/admin/apps/{c_id}", 2.2, gets, method="GET")
    try:
        row_c = page.locator("tbody tr", has_text=c["appId"]).first
        check("T1.1 对象 C 行可见", row_c.count() >= 1)
        row_c.locator("button", has_text="配置").click()
        page.wait_for_timeout(250)
        # GET 在途期间尝试编辑（若实现把表单锁定则记实现选择，等待落地后再改）。
        edited_in_flight = False
        try:
            page.fill(T1_UI["field_name"], my_name, timeout=800)
            page.fill(T1_UI["field_origins"], my_origin, timeout=800)
            edited_in_flight = True
        except Exception:  # noqa: BLE001
            edited_in_flight = False
        # 另一对象保存：经 API 对 R 做 PUT（第二客户端并行写入，不碰 UI）。
        st, _ = t1_api_put_app(h, base, r_id, r["ruleVersion"], name="E2E-T1 R 并行保存")
        check("T1.1 另一对象 R 经 API 保存成功", st == 200, f"status={st}")
        # 等延迟 GET 真正落地：以表单绑定到 C 为信号（appId 字段填入且禁用）。
        deadline = time.time() + 12
        while time.time() < deadline:
            try:
                if (
                    page.locator(T1_UI["field_appid"]).input_value() == c["appId"]
                    and gets.get("done", 0) >= 1
                ):
                    break
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(120)
        page.wait_for_timeout(400)
        if not edited_in_flight:
            try:
                page.fill(T1_UI["field_name"], my_name)
                page.fill(T1_UI["field_origins"], my_origin)
            except Exception:  # noqa: BLE001
                pass
        spec(
            "T1.1a 延迟 GET 落地不覆盖在途编辑（草稿名称/来源保留）",
            page.locator(T1_UI["field_name"]).input_value() == my_name
            and page.locator(T1_UI["field_origins"]).input_value() == my_origin,
            f"inFlightEdit={edited_in_flight} name={page.locator(T1_UI['field_name']).input_value()!r} "
            f"orig={page.locator(T1_UI['field_origins']).input_value()!r}",
        )
        spec(
            "T1.1a 延迟 GET 建立对象身份（表单绑定 C 的 appId 且不可改）",
            page.locator(T1_UI["field_appid"]).input_value() == c["appId"]
            and page.locator(T1_UI["field_appid"]).is_disabled(),
            f"ai2={page.locator(T1_UI['field_appid']).input_value()}",
        )
        shot(page, "t1-race-delayed-get")
        # 断言后把草稿收敛到期望值，保证后续 PUT 体断言只检验实现语义。
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                if page.locator(T1_UI["field_name"]).input_value() != my_name:
                    page.fill(T1_UI["field_name"], my_name, timeout=800)
                if page.locator(T1_UI["field_origins"]).input_value() != my_origin:
                    page.fill(T1_UI["field_origins"], my_origin, timeout=800)
                break
            except Exception:  # noqa: BLE001
                page.wait_for_timeout(300)
    finally:
        t1_unroute(page, delay_h)

    step("T1.1b PUT 后继续编辑：慢 PUT 期间再改 + 写后编辑；断言两次 PUT 请求体")
    # 慢化 C 的 PUT 与其后的详情 GET：写期间再改一次，断言响应/回读不回滚草稿。
    slow_put_h = t1_route_delay(page, f"/api/admin/apps/{c_id}", 1.6, None, method="PUT")
    slow_get_h = t1_route_delay(
        page,
        lambda url: _t1_path(url) == f"/api/admin/apps/{c_id}" and gets.get("done", 0) >= 1,
        2.5,
        None,
        method="GET",
    )
    # 路由按 LIFO 执行：写捕获必须最后注册才能先于延迟路由看到请求。
    cap = t1_capture_writes(page, writes)
    try:
        t1_click_save(page)
        name_during_write = "E2E-T1 写期间再改 A2"
        edit_during = False
        try:
            page.fill(T1_UI["field_name"], name_during_write, timeout=1200)
            edit_during = True
        except Exception:  # noqa: BLE001
            edit_during = False
        # PUT 已落地、详情回读仍在延迟窗口：草稿须保留写期间编辑（不被 PUT 响应回滚）。
        page.wait_for_timeout(1900)
        spec(
            "T1.1b 写期间的新编辑保留为未保存（PUT 响应不回滚草稿）",
            (not edit_during) or page.locator(T1_UI["field_name"]).input_value() == name_during_write,
            f"editDuringWrite={edit_during} name={page.locator(T1_UI['field_name']).input_value()!r}",
        )
        deadline = time.time() + 15
        while time.time() < deadline and len(writes["puts"]) < 1:
            page.wait_for_timeout(100)
        record(
            "T1.1b 草稿编辑保存走 PUT 且只发一次（身份已建立、无重复 POST）",
            len(writes["puts"]) == 1 and len(writes["posts"]) == 0,
            f"puts={len(writes['puts'])} posts={len(writes['posts'])} "
            f"status1={writes['puts'][0]['status'] if writes['puts'] else None}",
        )
        if writes["puts"]:
            body = writes["puts"][0]["body"]
            spec(
                "T1.1b 首个 PUT 请求体=保存时草稿（名称/来源/版本取自编辑基准 v1）",
                body.get("name") == my_name
                and body.get("allowedOrigins") == [my_origin]
                and body.get("expectedRuleVersion") == c["ruleVersion"],
                f"body={body} status={writes['puts'][0]['status']}",
            )
        # 等首个保存完整收尾（含延迟的详情回读）：草稿仍不得被服务端值回写覆盖。
        t1_wait_status(page, T1_UI["status_saved"], 15)
        page.wait_for_timeout(2600)  # 越过 slow_get 2.5s 窗口让迟到回读也落地
        spec(
            "T1.1b 保存后详情回读不把写期间编辑冲掉（草稿仍为用户值）",
            (not edit_during) or page.locator(T1_UI["field_name"]).input_value() == name_during_write,
            f"name={page.locator(T1_UI['field_name']).input_value()!r}",
        )
        # 第二个 PUT：写后编辑落库（当前字段值与请求体一致）。
        name_after_write = "E2E-T1 写后再改 A3"
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                page.fill(T1_UI["field_name"], name_after_write, timeout=800)
                break
            except Exception:  # noqa: BLE001
                page.wait_for_timeout(300)
        if not t1_try_save(page, 4000):
            spec("T1.1b 写后可再次发起保存（保存按钮可用）", False, "保存按钮持续禁用")
        deadline = time.time() + 15
        while time.time() < deadline and len(writes["puts"]) < 2:
            page.wait_for_timeout(100)
        record(
            "T1.1b PUT 后继续编辑再保存发出第二个 PUT",
            len(writes["puts"]) >= 2,
            f"puts={len(writes['puts'])}",
        )
        if len(writes["puts"]) >= 2:
            body2 = writes["puts"][1]["body"]
            spec(
                "T1.1b 第二个 PUT 体=用户草稿值（版本随首个 PUT 响应推进到 v2）",
                body2.get("expectedRuleVersion") == (c["ruleVersion"] + 1)
                and body2.get("name") in (name_after_write, name_during_write, my_name),
                f"body={body2} status={writes['puts'][1]['status']}",
            )
    finally:
        t1_unroute(page, slow_put_h)
        t1_unroute(page, slow_get_h)

    step("T1.1c 刷新失败后修改再重试：重试 GET-only，不重置草稿、不发写请求")
    fail_list = {"armed": False, "failed": 0, "writes_during_retry": 0}

    def fail_first_list(route, request):
        path = _t1_path(request.url)
        if request.method == "PUT" and path == f"/api/admin/apps/{c_id}":
            fail_list["armed"] = True
        elif request.method == "GET" and path.endswith("/api/admin/apps") and fail_list["armed"] and fail_list["failed"] == 0:
            fail_list["failed"] += 1
            route.fulfill(
                status=503,
                content_type="application/json",
                body='{"error":{"code":"server_error","message":"E2E 注入列表刷新失败"}}',
            )
            return
        route.fallback()

    fail_pred = lambda url: "/api/admin/apps" in url  # noqa: E731
    fail_first_list._t1_pred = fail_pred
    page.route(fail_pred, fail_first_list)
    try:
        # 上一节的慢路由已注销，但写后回读/保存 busy 收尾可能仍在进行：先等保存按钮可用。
        ready = False
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                if t1_save_button(page).is_enabled():
                    ready = True
                    break
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(250)
        check(
            "T1.1c 前置：保存按钮可用（无遗留冲突/忙碌态）",
            ready,
            f"enabled={ready} status={fb3_status_text(page)[:220]!r} "
            f"region={t1_conflict_visible(page)} puts={len(writes['puts'])}",
        )
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and fail_list["failed"] == 0:
            page.wait_for_timeout(100)
        got_hint = t1_wait_status(page, T1_UI["status_refresh_fail"], 8) or (
            T1_UI["status_saved"] in fb3_status_text(page)
        )
        spec(
            "T1.1c 保存成功但列表刷新失败给出已保存+可重试提示",
            fail_list["failed"] == 1 and got_hint,
            f"failed={fail_list['failed']} status={fb3_status_text(page)[:200]!r}",
        )
        # 失败后修改再重试：重试刷新只应是 GET（服务端快照），草稿不被重置。
        name_retry_edit = "E2E-T1 重试前再改 A4"
        try:
            page.fill(T1_UI["field_name"], name_retry_edit)
        except Exception:  # noqa: BLE001
            pass
        retry = page.locator("button", has_text=T1_UI["retry_refresh_text"])
        if retry.count() >= 1 and retry.first.is_enabled():
            puts_before = len(writes["puts"]) + len(writes["posts"])
            retry.first.click()
            page.wait_for_timeout(1200)
            spec(
                "T1.1c 重试刷新为 GET-only：无新增写请求且草稿不被重置",
                (len(writes["puts"]) + len(writes["posts"])) == puts_before
                and page.locator(T1_UI["field_name"]).input_value() == name_retry_edit,
                f"writes={len(writes['puts']) + len(writes['posts'])} name={page.locator(T1_UI['field_name']).input_value()!r}",
            )
        else:
            spec("T1.1c 显示可重试刷新操作", False, f"status={fb3_status_text(page)[:200]!r}")
    finally:
        t1_unroute(page, fail_first_list)
        t1_unroute(page, cap)


def sec_t1_conflict_compare(page, h: Http, base: str, fx: dict) -> None:
    """T1.2 409 逐项比较全覆盖：三组均双方不同值、同组未选择保存被拒、
    比较期间读取失败、解决后再次 409 重新比较（版本推进 v1→v2→v3→v4 全程断言请求体）。"""
    k = fx["conflict"]
    k_id = k["row_id"]
    base_ver = k["ruleVersion"]  # v1（夹具创建版本）
    latest_name = "E2E-T1 外部名 L1"
    latest_origin = "https://latest-1.example.com"
    latest2_name = "E2E-T1 外部名 L2"
    latest2_origin = "https://latest-2.example.com"
    my_name = "E2E-T1 我方名 M1"
    my_origin = "https://mine-1.example.com"
    writes = {"posts": [], "puts": []}

    step("T1.2a 制造首冲突：外部 v2 改名称/来源/列；我方 v1 上改名称/来源/目标 → 三组双方不同值")
    t1_reset_apps_view(page)
    check("T1.2 打开冲突对象详情", t1_open_detail(page, k["appId"]))
    st, resp = t1_api_put_app(
        h, base, k_id, base_ver,
        name=latest_name,
        allowedOrigins=[latest_origin],
        kaneoColumnId="col-2", kaneoColumnSlug="doing",
        kaneoLabelIds=["label-ui"],
    )
    check("T1.2 前置：外部保存推进版本 v2", st == 200, f"status={st} body={resp}")
    # UI 侧在 v1 基准上改名称/来源/目标组（列+标签同改，目标组原子比较 → 三组均双方不同值）。
    page.fill(T1_UI["field_name"], my_name)
    page.fill(T1_UI["field_origins"], my_origin)
    try:
        page.select_option(T1_UI["field_column"], "col-2")
    except Exception:  # noqa: BLE001
        pass
    try:
        page.locator(".label-picker input[type=checkbox]").nth(1).check()
    except Exception:  # noqa: BLE001
        pass
    # 先注册一次性 503：409 后的「比较快照 GET」即比较数据来源，注入读取失败覆盖「比较期间读取失败」。
    fail_once = {"n": 0}

    def fail_detail(route, request):
        if (
            request.method == "GET"
            and _t1_path(request.url) == f"/api/admin/apps/{k_id}"
            and fail_once["n"] == 0
        ):
            fail_once["n"] += 1
            route.fulfill(
                status=503,
                content_type="application/json",
                body='{"error":{"code":"server_error","message":"E2E 注入比较期读取失败"}}',
            )
            return
        route.fallback()

    fail_detail_pred = lambda url: _t1_path(url) == f"/api/admin/apps/{k_id}"  # noqa: E731
    fail_detail._t1_pred = fail_detail_pred
    cap = t1_capture_writes(page, writes)
    page.route(fail_detail_pred, fail_detail)
    try:
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and (len(writes["puts"]) < 1 or writes["puts"][0]["status"] is None):
            page.wait_for_timeout(100)
        record(
            "T1.2a 旧基准保存发出一次 PUT（携带草稿值与 v1，服务端 409）",
            len(writes["puts"]) == 1
            and writes["puts"][0]["body"].get("expectedRuleVersion") == base_ver
            and writes["puts"][0]["body"].get("name") == my_name
            and writes["puts"][0]["body"].get("allowedOrigins") == [my_origin]
            and writes["puts"][0]["status"] == 409,
            f"puts={writes['puts']}",
        )
        # 409 → 快照 GET 被注入 503 → 读取失败提示 + 草稿保留（fetchError 路径）。
        deadline = time.time() + 15
        while time.time() < deadline and fail_once["n"] == 0:
            page.wait_for_timeout(100)
        deadline = time.time() + 10
        while time.time() < deadline and T1_UI["conflict_fetch_fail_hint"] not in fb3_status_text(page):
            page.wait_for_timeout(200)
        spec(
            "T1.2a 比较读取失败给出提示且保留旧基准与草稿（可重试）",
            fail_once["n"] == 1
            and T1_UI["conflict_fetch_fail_hint"] in fb3_status_text(page)
            and page.locator(T1_UI["field_name"]).input_value() == my_name,
            f"injected={fail_once['n']} name={page.locator(T1_UI['field_name']).input_value()!r} "
            f"status={fb3_status_text(page)[:220]!r}",
        )
        # 重试读取：503 只注入一次，第二次 GET 应成功 → 比较区打开。
        retry_btn = page.locator("button", has_text=T1_UI["conflict_retry_read_text"])
        spec("T1.2a 读取失败后提供重试读取入口", retry_btn.count() >= 1, "无重试读取按钮")
        if retry_btn.count() >= 1:
            retry_btn.first.click()
        compare_open = t1_wait_conflict(page, 15)
        spec(
            "T1.2a 重试读取后进入逐项比较（比较区/保存冲突出现）",
            compare_open,
            f"status={fb3_status_text(page)[:220]!r} region={t1_conflict_visible(page)}",
        )
        if not compare_open:
            return
        shot(page, "t1-conflict-compare")
        spec(
            "T1.2a 比较期间表单冻结（名称/来源/项目控件禁用）",
            page.locator(T1_UI["field_name"]).is_disabled()
            and page.locator(T1_UI["field_origins"]).is_disabled()
            and page.locator(T1_UI["field_project"]).is_disabled(),
            "字段未全部禁用",
        )
        groups = t1_compare_group_present(page)
        needs = {g: t1_group_needs_choice(page, v["key"]) for g, v in T1_GROUPS.items()}
        spec(
            "T1.2a 三个比较组出现且均为「需选择」（双方不同值）",
            all(groups.values()) and all(needs.values()),
            f"groups={groups} needsChoice={needs}",
        )
        target_text = t1_group(page, "target").inner_text() if groups.get("target") else ""
        spec(
            "T1.2a 双侧目标显示列、标签名称和 ID",
            all(value in target_text for value in ("进行中", "bug", "ui", "col-2", "label-bug", "label-ui")),
            f"target={target_text[:420]!r}",
        )
        # 同组未选择时保存被拒：冲突未解决保存禁用 → 无新 PUT，比较态保留。
        save_enabled_before = t1_save_button(page).is_enabled()
        t1_try_save(page, 2500)
        page.wait_for_timeout(700)
        spec(
            "T1.2a 同组未选择时保存被拒（无新 PUT，比较态保留）",
            len(writes["puts"]) == 1 and t1_conflict_pending(page),
            f"puts={len(writes['puts'])} saveEnabled={save_enabled_before} "
            f"conflict={t1_conflict_pending(page)} status={fb3_status_text(page)[:160]!r}",
        )
        t1_unroute(page, fail_detail)

        step("T1.2b 逐项选择：名称=我方、来源=最新、目标组=我方；应用后保存")
        c1 = t1_group_choose(page, "name", "mine")
        c2 = t1_group_choose(page, "origins", "theirs")
        c3 = t1_group_choose(page, "target", "mine")
        spec(
            "T1.2b 三个比较组均可显式选择（我方/最新/我方）",
            c1 and c2 and c3,
            f"name={c1} origins={c2} target={c3}",
        )
        spec("T1.2b 「应用比较结果」可执行", t1_apply_resolution(page), "应用按钮不可用")
        page.wait_for_timeout(500)
        spec(
            "T1.2b 「应用比较结果」只更新草稿与基准（不发送 PUT）",
            len(writes["puts"]) == 1,
            f"puts={len(writes['puts'])}",
        )
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and len(writes["puts"]) < 2:
            page.wait_for_timeout(100)
        spec(
            "T1.2b 应用比较结果后保存发出第二次 PUT",
            len(writes["puts"]) == 2,
            f"puts={len(writes['puts'])}",
        )
        if len(writes["puts"]) >= 2:
            b2 = writes["puts"][1]["body"]
            spec(
                "T1.2b PUT2 体=解决结果（我方名 + 最新来源 + 我方目标组 + v2 基准）",
                b2.get("name") == my_name
                and b2.get("allowedOrigins") == [latest_origin]
                and b2.get("kaneoColumnId") == "col-2"
                and sorted(b2.get("kaneoLabelIds") or []) == sorted(["label-bug", "label-ui"])
                and b2.get("expectedRuleVersion") == base_ver + 1,
                f"body={b2}",
            )
            t1_wait_status(page, T1_UI["status_saved"], 15)

        step("T1.2c 解决后再次 409：外部推进 v3 → 再保存 → 重新比较（不自动重放）")
        st, det = h.call("GET", f"{base}/api/admin/apps/{k_id}")
        cur_ver = ((det or {}).get("app") or {}).get("ruleVersion")
        check("T1.2c 前置：读到当前规则版本", isinstance(cur_ver, int), f"ver={cur_ver}")
        st, resp = t1_api_put_app(
            h, base, k_id, cur_ver,
            name=latest2_name,
            allowedOrigins=[latest2_origin],
            kaneoProjectId="p-other", kaneoColumnId="col-x1", kaneoColumnSlug="done",
        )
        check("T1.2c 前置：外部二次推进版本", st == 200, f"status={st} body={resp}")
        # 解决后再编辑：名称改 M2 + 去掉 label-ui（目标组 mine 变为 col-2+[bug]）。
        # 使名称/目标两组在第二次比较中三方不同 → 仍需显式选择，验证「再次 409 不自动重放、重新逐项比较」。
        my_name2 = "E2E-T1 我方名 M2"
        page.fill(T1_UI["field_name"], my_name2)
        try:
            page.locator(".label-picker input[type=checkbox]").nth(1).uncheck()
        except Exception:  # noqa: BLE001
            pass
        option_failures = {"count": 0}

        def fail_compare_options(route, request):
            if request.method == "GET" and option_failures["count"] == 0:
                option_failures["count"] += 1
                route.fulfill(status=503, content_type="application/json", body='{"error":{"code":"server_error","message":"E2E 选项暂不可用"}}')
                return
            route.fallback()

        options_pred = lambda url: _t1_path(url) == "/api/admin/feedback/options"  # noqa: E731
        page.route(options_pred, fail_compare_options)
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and (len(writes["puts"]) < 3 or writes["puts"][2]["status"] is None):
            page.wait_for_timeout(100)
        reconflict = t1_wait_conflict(page, 15)
        spec(
            "T1.2c 再次 409 重新进入比较（PUT3 被拒后比较区再现）",
            reconflict and len(writes["puts"]) == 3 and writes["puts"][2]["status"] == 409,
            f"puts={len(writes['puts'])} region={t1_conflict_visible(page)} "
            f"put3_status={writes['puts'][2]['status'] if len(writes['puts']) >= 3 else None}",
        )
        if len(writes["puts"]) >= 3:
            b3 = writes["puts"][2]["body"]
            spec(
                "T1.2c PUT3 用解决后基准发送当前草稿（M2 名 + 已解决来源 + 我方目标去标签），非自动重放新值",
                b3.get("expectedRuleVersion") == cur_ver
                and b3.get("name") == my_name2
                and b3.get("allowedOrigins") == [latest_origin]
                and b3.get("kaneoColumnId") == "col-2"
                and (b3.get("kaneoLabelIds") or []) == ["label-bug"],
                f"body={b3} cur={cur_ver}",
            )
        if not reconflict:
            return
        deadline = time.time() + 10
        while time.time() < deadline and page.get_by_text("选项读取失败").count() == 0:
            page.wait_for_timeout(100)
        spec(
            "T1.2c 选项读取失败保留比较与草稿，禁止应用",
            option_failures["count"] == 1
            and page.get_by_text("选项读取失败").count() > 0
            and not page.get_by_role("button", name="应用比较结果").is_enabled()
            and page.locator(T1_UI["field_name"]).input_value() == my_name2,
            f"failures={option_failures['count']} status={fb3_status_text(page)[:180]!r}",
        )
        retry_options = page.get_by_role("button", name="重试读取选项")
        if retry_options.count():
            retry_options.click()
            page.get_by_text("选项读取失败").wait_for(state="hidden", timeout=15000)
        page.unroute(options_pred, fail_compare_options)
        deadline = time.time() + 15
        while time.time() < deadline and not all(
            value in t1_group(page, "target").inner_text() for value in ("进行中", "已上线")
        ):
            page.wait_for_timeout(100)
        target_text2 = t1_group(page, "target").inner_text()
        spec(
            "T1.2c 跨项目冲突分别显示两侧项目和列名称",
            all(value in target_text2 for value in ("E2E 测试项目", "另一个项目", "进行中", "已上线", "col-2", "col-x1")),
            f"target={target_text2[:450]!r}",
        )
        shot(page, "t1-conflict-recompare")
        # 二次比较组态（编辑基准=PUT2 已保存草稿值：M1/[latest-1]/col-2+[bug,ui]）：
        # 名称 base=M1 vs mine=M2 vs theirs=L2 → 需选择；
        # 来源 base=[latest-1] vs mine=[latest-1] vs theirs=[latest-2] → 自动采用最新保存；
        # 目标 base=col-2+[bug,ui] vs mine=col-2+[bug] vs theirs=col-1+[bug] → 三方不同需选择。
        n_needs = t1_group_needs_choice(page, "name")
        o_needs = t1_group_needs_choice(page, "origins")
        t_needs = t1_group_needs_choice(page, "target")
        spec(
            "T1.2c 二次比较组态正确（名称/目标需选择，来源自动采用最新保存）",
            n_needs and t_needs and not o_needs,
            f"name={n_needs} origins={o_needs} target={t_needs} "
            f"originsState={t1_group_state(page,'origins')[:120]!r}",
        )
        r1 = t1_group_choose(page, "name", "mine")
        r3 = t1_group_choose(page, "target", "mine")
        spec(
            "T1.2c 二次比较可再选（名称=我方、目标=我方）",
            r1 and r3,
            f"name={r1} target={r3}",
        )
        spec("T1.2c 二次「应用比较结果」可执行", t1_apply_resolution(page), "应用按钮不可用")
        page.wait_for_timeout(500)
        spec(
            "T1.2c 二次应用不发送 PUT（PUT 仍由保存触发）",
            len(writes["puts"]) == 3,
            f"puts={len(writes['puts'])}",
        )
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and len(writes["puts"]) < 4:
            page.wait_for_timeout(100)
        spec(
            "T1.2c 二次解决后保存发出 PUT4（最新基准 v3 + 解决结果）",
            len(writes["puts"]) == 4
            and writes["puts"][3]["body"].get("expectedRuleVersion") == cur_ver + 1
            and writes["puts"][3]["body"].get("name") == my_name2
            and writes["puts"][3]["body"].get("allowedOrigins") == [latest2_origin]
            and writes["puts"][3]["body"].get("kaneoColumnId") == "col-2"
            and (writes["puts"][3]["body"].get("kaneoLabelIds") or []) == ["label-bug"],
            f"puts={writes['puts']}",
        )
        t1_wait_status(page, T1_UI["status_saved"], 15)
        st, det = h.call("GET", f"{base}/api/admin/apps/{k_id}")
        app = (det or {}).get("app") or {}
        final_name = len(writes["puts"]) >= 4 and writes["puts"][3]["body"].get("name") or None
        spec(
            "T1.2c 服务端终态=二次解决结果（与 PUT4 体一致 + 版本推进）",
            app.get("name") == final_name
            and app.get("allowedOrigins") == [latest2_origin]
            and app.get("ruleVersion") == (cur_ver + 2),
            f"name={app.get('name')} origins={app.get('allowedOrigins')} ver={app.get('ruleVersion')}",
        )
        record(
            "T1.2 全程未产生 POST（编辑对象不走创建）",
            len(writes["posts"]) == 0,
            f"posts={writes['posts']}",
        )
    finally:
        t1_unroute(page, fail_detail)
        t1_unroute(page, cap)


def sec_t1_create_refresh_retry(page, h: Http, base: str, fx: dict) -> None:
    """T1.3 创建后刷新失败：全程只创建一条（POST=1），后续保存走 PUT。"""
    step("T1.3 新建软件 → 注入创建后列表 GET 失败 → 修改再保存")
    t1_reset_apps_view(page)
    new_app_id = f"com.e2e.t1-create-{secrets.token_hex(3)}"
    new_name = "E2E-T1 创建后刷新失败"
    state = {"posts": [], "puts": [], "list_failed": 0, "armed": False, "app_row": None}
    created_row = {"id": None}

    def handler(route, request):
        path = _t1_path(request.url)
        if request.method == "POST" and path.endswith("/api/admin/apps"):
            state["posts"].append({"body": request.post_data_json or {}})
            resp = route.fetch()
            state["armed"] = True
            try:
                created_row["id"] = (resp.json() or {}).get("id")
            except Exception:  # noqa: BLE001
                pass
            route.fulfill(response=resp)
            return
        if request.method == "PUT" and created_row["id"] and path == f"/api/admin/apps/{created_row['id']}":
            state["puts"].append({"body": request.post_data_json or {}})
        if request.method == "GET" and path.endswith("/api/admin/apps") and state["armed"] and state["list_failed"] == 0:
            state["list_failed"] += 1
            route.fulfill(
                status=503,
                content_type="application/json",
                body='{"error":{"code":"server_error","message":"E2E 注入创建后刷新失败"}}',
            )
            return
        route.fallback()

    page.route("**/api/admin/apps**", handler)
    try:
        page.fill(T1_UI["field_name"], new_name)
        page.fill(T1_UI["field_appid"], new_app_id)
        t1_click_save(page)
        deadline = time.time() + 15
        while time.time() < deadline and state["list_failed"] == 0:
            page.wait_for_timeout(100)
        spec(
            "T1.3 创建成功但首个列表 GET 失败仍给出已保存/可重试提示",
            len(state["posts"]) == 1 and state["list_failed"] == 1,
            f"posts={len(state['posts'])} listFailed={state['list_failed']} status={fb3_status_text(page)[:200]!r}",
        )
        # 失败后修改再保存：应是 PUT 而非第二个 POST。
        page.wait_for_timeout(300)
        try:
            page.fill(T1_UI["field_name"], new_name + " v2")
        except Exception:  # noqa: BLE001
            pass
        t1_click_save(page)
        page.wait_for_timeout(1500)
        record(
            "T1.3 创建后刷新失败全程只创建一条（POST=1，后续为 PUT）",
            len(state["posts"]) == 1,
            f"posts={len(state['posts'])} puts={len(state['puts'])}",
        )
        spec(
            "T1.3 刷新失败后修改再保存走 PUT（复用已创建身份与版本）",
            len(state["puts"]) >= 1
            and isinstance(state["puts"][0]["body"].get("expectedRuleVersion"), int),
            f"puts={state['puts']} status={fb3_status_text(page)[:160]!r}",
        )
        if created_row["id"]:
            st, det = h.call("GET", f"{base}/api/admin/apps/{created_row['id']}")
            record(
                "T1.3 服务端仅一条该 appId 记录（无重复创建）",
                st == 200 and (det or {}).get("app", {}).get("appId") == new_app_id,
                f"status={st} appId={(det or {}).get('app', {}).get('appId')}",
            )
    finally:
        try:
            page.unroute("**/api/admin/apps**", handler)
        except Exception:  # noqa: BLE001
            pass


# ---------- T4 工单筛选计数一致（UI 层断言，与服务端测试互补） ----------


def seed_t4_fixtures(h: Http, base: str) -> dict:
    """T4 夹具：1 个专用软件 + 7 条反馈，分布为
    inbox open×2 / waiting_admin / waiting_user / resolved / archived(open)；trash open×1。
    先建 T4 软件（完整规则），再由独立账号提交并立即做状态操作，最后 API 复核分布。"""
    st, body = h.call(
        "POST",
        f"{base}/api/admin/apps",
        {
            "appId": T4_APP_ID,
            "name": T4_APP_NAME,
            "allowedOrigins": [],
            "kaneoProjectId": "p-e2e",
            "kaneoColumnId": "col-1",
            "kaneoColumnSlug": "triage",
            "kaneoLabelIds": ["label-bug"],
            "kaneoAssigneeId": None,
        },
    )
    check("T4 夹具：专用软件创建 201", st == 201, f"status={st} body={body}")
    t4_user = "e2e-t4-user"
    t4_pass = "t4-" + secrets.token_hex(10)
    st, body = h.call(
        "POST",
        f"{base}/api/admin/users",
        {"username": t4_user, "password": t4_pass, "dailyLimit": 20},
    )
    check("T4 夹具：提交账号创建 201", st == 201, f"status={st} body={body}")
    uh = Http()
    st, _ = uh.call("POST", f"{base}/api/auth/login", {"username": t4_user, "password": t4_pass})
    check("T4 夹具：提交账号登录 200", st == 200, f"status={st}")

    ids = {}
    specs = ["open-a", "open-b", "w-admin", "w-user", "resolved", "archive", "trash"]
    for i, key in enumerate(specs):
        st, body = uh.call(
            "POST",
            f"{base}/api/feedback",
            {
                "idempotencyKey": f"ui-t4-{key}-{secrets.token_hex(4)}",
                "appId": T4_APP_ID,
                "text": f"{T4_NEEDLE}-{key} T4 工单状态夹具 {key}",
                "context": {"appVersion": "1.0.0", "pageLabel": "ui-t4"},
            },
        )
        check(f"T4 夹具：{key} 提交 201", st == 201, f"status={st} body={body}")
        ids[key] = body["feedbackId"]

    # 状态操作（在 worker 落定前完成本地状态写入，处理中也可改工单状态）。
    st, body = uh.call(
        "POST",
        f"{base}/api/feedback/{ids['w-admin']}/messages",
        {"text": "补充：T4 用户追加留言 → waiting_admin", "idempotencyKey": f"t4-m-{secrets.token_hex(4)}"},
    )
    check("T4 夹具：waiting_admin 用户留言 201", st == 201, f"status={st} body={body}")
    st, body = h.call(
        "POST",
        f"{base}/api/admin/feedback/{ids['w-user']}/messages",
        {"text": "请补充信息。", "issueStatusAction": "reply"},
    )
    check("T4 夹具：waiting_user 管理端回复 201", st == 201, f"status={st} body={body}")
    st, body = h.call(
        "POST",
        f"{base}/api/admin/feedback/{ids['resolved']}/issue-status",
        {"issueStatus": "resolved", "resolutionNote": "T4 已处理"},
    )
    check("T4 夹具：resolved 标记 200", st == 200, f"status={st} body={body}")
    # trash：先取生命周期版本再回收
    st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['trash']}")
    lv = ((det or {}).get("lifecycleVersion")) or 0
    st, body = h.call(
        "POST",
        f"{base}/api/admin/feedback/lifecycle",
        {"action": "trash", "items": [{"id": ids["trash"], "expectedVersion": lv}]},
    )
    check("T4 夹具：trash 移入回收站 200", st == 200, f"status={st} body={body}")
    # archive：等处理完后分类归档 → 落 archived 区
    deadline = time.time() + 120
    done = False
    while time.time() < deadline:
        st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['archive']}")
        if det and det.get("processed"):
            cver = (det.get("classification") or {}).get("version", 0)
            st, body = h.call(
                "POST",
                f"{base}/api/admin/feedback/{ids['archive']}/classify",
                {
                    "action": "archive",
                    "classifyVersion": cver,
                    "operationId": f"t4-{secrets.token_hex(6)}",
                    "projectId": "p-e2e",
                    "columnId": "col-1",
                    "columnSlug": "triage",
                    "labelIds": ["label-bug"],
                    "assigneeId": None,
                    "assigneeName": None,
                },
            )
            if st in (200, 202):
                done = True
                break
        time.sleep(0.6)
    check("T4 夹具：archive 分类归档受理", done)
    deadline = time.time() + 45
    archived = False
    while time.time() < deadline:
        st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['archive']}")
        if det and det.get("status") == "archived":
            archived = True
            break
        time.sleep(0.5)
    check("T4 夹具：archive 同步完成（status=archived）", archived, f"status={(det or {}).get('status')}")
    # 同步成功只代表可归档：还需显式生命周期 archive 把它移入「已归档」管理区域。
    st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['archive']}")
    lv = ((det or {}).get("lifecycleVersion")) or 0
    st, body = h.call(
        "POST",
        f"{base}/api/admin/feedback/lifecycle",
        {"action": "archive", "items": [{"id": ids["archive"], "expectedVersion": lv}]},
    )
    check("T4 夹具：archive 移入已归档区域 200", st == 200, f"status={st} body={body}")
    # 等 T4 软件收件箱全部落终态（避免轮询干扰 UI 断言）
    deadline = time.time() + 150
    settled = False
    while time.time() < deadline:
        st, lst = h.call("GET", f"{base}/api/admin/feedback?view=inbox&appId={T4_APP_ID}&limit=100")
        if st == 200 and lst:
            items = lst.get("items") or []
            if items and not [i for i in items if i.get("status") in ("received", "processing", "archiving")]:
                settled = True
                break
        time.sleep(0.7)
    check("T4 夹具：T4 软件收件箱全部终态", settled)
    # API 复核分布
    st, lst = h.call("GET", f"{base}/api/admin/feedback?view=all&appId={T4_APP_ID}&limit=100")
    by_id = {i.get("id"): i for i in (lst or {}).get("items", [])} if st == 200 else {}
    expect = {
        "w-admin": "waiting_admin",
        "w-user": "waiting_user",
        "resolved": "resolved",
    }
    ok_dist = all(by_id.get(ids[k], {}).get("issueStatus") == v for k, v in expect.items())
    check("T4 夹具：issueStatus 分布复核", ok_dist, f"dist={{k: by_id.get(ids[k],{{}}).get('issueStatus') for k in expect}}")
    return {"ids": ids, "app_row_id": None}


def t4_api_counts(h: Http, base: str, extra: str = "") -> dict:
    st, body = h.call("GET", f"{base}/api/admin/feedback/counts?appId={T4_APP_ID}{extra}")
    return (body or {}) if st == 200 else {}


def t4_api_list(h: Http, base: str, extra: str = "") -> list:
    st, body = h.call("GET", f"{base}/api/admin/feedback?view=inbox&appId={T4_APP_ID}&limit=100{extra}")
    return (body or {}).get("items", []) if st == 200 else []


def t4_ui_tab_count(page, idx: int) -> int | None:
    """读区域页签上的计数徽标（inbox=0/archived=1/trash=2）。"""
    try:
        el = page.locator(".view-tab").nth(idx).locator(".count")
        txt = (el.inner_text() or "").strip()
        return int(txt) if txt.isdigit() else None
    except Exception:  # noqa: BLE001
        return None


def t4_ui_rows(page) -> int:
    return page.locator(".fb-table tbody tr").count()


def sec_fb_filter_counts(page, h: Http, base: str, fx: dict) -> None:
    """T4 混合工单状态下：筛选列表与 counts 一致（API 复核 + UI 徽标/行数互证）。"""
    step("T4.1 API 层：各 issueStatus 下列表条数与 counts 对应区域一致")
    st, allc = h.call("GET", f"{base}/api/admin/feedback/counts?appId={T4_APP_ID}")
    check("T4.1 counts 接口 200", st == 200, f"status={st} body={allc}")
    # 服务端事实：每种的 issueStatus 的列表条数
    truth = {}
    for iss in ("", "open", "waiting_admin", "waiting_user", "resolved"):
        items = t4_api_list(h, base, f"&issueStatus={iss}" if iss else "")
        truth[iss or "(all)"] = len([i for i in items if i.get("issueStatus") == iss] if iss else items)
    spec(
        "T4.1 混合状态各筛选列表条数符合夹具分布",
        truth.get("waiting_admin") == 1
        and truth.get("waiting_user") == 1
        and truth.get("resolved") == 1
        and truth.get("open") == 2,
        f"truth={truth}",
    )
    # 非法值对列表与 counts 均应 400（T4 修复契约）。
    st_l, _ = h.call("GET", f"{base}/api/admin/feedback?view=inbox&issueStatus=bogus")
    st_c, _ = h.call("GET", f"{base}/api/admin/feedback/counts?issueStatus=bogus")
    spec(
        "T4.1 非法 issueStatus 对列表与 counts 均返回 400",
        st_l == 400 and st_c == 400,
        f"list={st_l} counts={st_c}",
    )

    step("T4.2 UI 层：筛选列表行数 == 服务端列表条数 == counts 徽标")
    page.locator(".nav-item:visible", has_text="反馈").first.click()
    page.wait_for_selector(SEARCH_SEL, timeout=15000)
    f2_reset_inbox(page, 1)
    # 应用专用软件筛选隔离 T4 数据（其余软件行不进断言）；选项异步加载，先等其出现。
    app_sel = page.locator('select[aria-label="软件筛选"]')
    app_ready = False
    if app_sel.count() >= 1:
        deadline = time.time() + 10
        while time.time() < deadline:
            if app_sel.locator(f'option[value="{T4_APP_ID}"]').count() >= 1:
                app_ready = True
                break
            page.wait_for_timeout(300)
        try:
            app_sel.select_option(T4_APP_ID)
        except Exception:  # noqa: BLE001
            app_ready = False
    check("T4.2 软件筛选可定位 T4 专用软件", app_ready, "app-options 未含 T4_APP_ID")

    def wait_ui_rows(want: int, timeout: float = 8.0) -> int:
        deadline = time.time() + timeout
        n = t4_ui_rows(page)
        while time.time() < deadline:
            n = t4_ui_rows(page)
            if n == want:
                return n
            page.wait_for_timeout(250)
        return n

    def wait_tab_count(idx: int, timeout: float = 8.0) -> int | None:
        deadline = time.time() + timeout
        v = t4_ui_tab_count(page, idx)
        while time.time() < deadline:
            v = t4_ui_tab_count(page, idx)
            if v is not None:
                return v
            page.wait_for_timeout(250)
        return v

    # 等应用筛选后的首屏收敛：T4 inbox 全量应为 5 条（open×2+wa+wu+resolved）
    n0 = wait_ui_rows(5, 10)
    record(
        "T4.2 软件筛选后收件箱行数收敛为夹具全量（5）",
        n0 == len(t4_api_list(h, base)),
        f"ui={n0} api={len(t4_api_list(h, base))}",
    )
    iss_sel = page.locator('select[aria-label="工单沟通状态筛选"]')
    check("T4.2 工单状态筛选控件存在", iss_sel.count() >= 1)
    for iss, label in (("open", "新反馈"), ("waiting_admin", "待管理处理"), ("waiting_user", "待用户补充"), ("resolved", "已解决")):
        iss_sel.select_option(iss)
        api_items = t4_api_list(h, base, f"&issueStatus={iss}")
        api_cnt = t4_api_counts(h, base, f"&issueStatus={iss}")
        ui_rows = wait_ui_rows(len(api_items))
        tab_inbox = wait_tab_count(0)
        record(
            f"T4.2 {label}({iss}) UI 行数 == API 列表条数",
            ui_rows == len(api_items),
            f"ui={ui_rows} api={len(api_items)}",
        )
        spec(
            f"T4.2 {label}({iss}) counts.inbox 徽标与筛选列表一致",
            tab_inbox == len(api_items) and api_cnt.get("inbox") == len(api_items),
            f"tab={tab_inbox} apiCounts={api_cnt} rows={len(api_items)}",
        )
        # 每行均带对应工单状态标签（UI 层断言一致性，互补服务端测试）。
        want = label
        per_row_ok = True
        rows = page.locator(".fb-table tbody tr")
        for i in range(rows.count()):
            row_tags = rows.nth(i).locator(".tag").all_inner_texts()
            if want not in [t.strip() for t in row_tags]:
                per_row_ok = False
                break
        spec(
            f"T4.2 {label} 筛选列表每行均带「{want}」工单标签",
            ui_rows == 0 or per_row_ok,
            f"rows={ui_rows} sampleTags={rows.first.locator('.tag').all_inner_texts() if rows.count() else []}",
        )
    # 清空筛选恢复全量
    iss_sel.select_option("")
    api_all = t4_api_list(h, base)
    spec(
        "T4.2 清空筛选恢复全量（UI 行数 == API 全部条数）",
        wait_ui_rows(len(api_all)) == len(api_all),
        f"ui={t4_ui_rows(page)} api={len(api_all)}",
    )
    # 区域徽标跨三区一致：trash 徽标应含 T4 回收站 1 条（appId 筛选下）。
    api_counts_all = t4_api_counts(h, base)
    spec(
        "T4.2 回收站徽标计数与 API 一致（含 T4 trash 1 条）",
        t4_ui_tab_count(page, 2) == api_counts_all.get("trash"),
        f"tab={t4_ui_tab_count(page, 2)} api={api_counts_all}",
    )
    shot(page, "t4-filter-counts")
    # 清理筛选：后续节（actual_zoom 等）复用默认收件箱视图，残留的 appId 过滤会干扰行断言。
    try:
        iss_sel.select_option("")
        app_sel.select_option("")
        page.wait_for_timeout(600)
    except Exception:  # noqa: BLE001
        pass


# ---------- FB4 布局回归（Feedback #4）：390/767/768/1280px × 明暗主题 ----------


def sec_fb4_layout_regression(page) -> None:
    """四档宽度 × 明暗主题：整页无横向溢出 + 截图 + 断点形态 + 焦点/可达抽查。"""
    step("FB4 反馈页布局回归矩阵截图（390/767/768/1280 × light/dark）")
    page.locator(".nav-item:visible", has_text="反馈").first.click()
    f2_reset_inbox(page, 1)
    for theme in FB4_THEMES:
        # 主题控件窄视口可能不可见：先在桌面宽下切好主题再缩窗。
        page.set_viewport_size({"width": 1280, "height": 900})
        page.wait_for_timeout(250)
        ok_theme = select_theme(page, theme)
        page.wait_for_timeout(300)
        record(f"FB4 {theme} 主题切换生效", ok_theme and dataset_theme(page) == theme, f"dataset={dataset_theme(page)}")
        for w in FB4_WIDTHS:
            page.set_viewport_size({"width": w, "height": 900})
            page.wait_for_timeout(400)
            info = scroll_probe(page)
            record(
                f"FB4 {theme} {w}px 无整页横向溢出",
                info[0] <= info[1] + 1,
                f"scrollWidth={info[0]} innerWidth={info[1]}",
            )
            shot(page, f"fb4-{w}-{theme}")
            if w == 767:
                record(
                    f"FB4 {theme} 767px 卡片形态（.fb-cards 可见 / .fb-table 隐藏）",
                    page.locator(".fb-cards").first.is_visible() and not page.locator(".fb-table").first.is_visible(),
                )
            if w == 768:
                record(
                    f"FB4 {theme} 768px 表格形态（.fb-table 可见 / .fb-cards 隐藏）",
                    page.locator(".fb-table").first.is_visible() and not page.locator(".fb-cards").first.is_visible(),
                )
    # 焦点与可达抽查（明暗各一次代表：light 390 卡片形态键盘到详情；dark 1280 表格焦点环）
    step("FB4 焦点/可达抽查")
    select_theme(page, "light")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0,0); }")
    reached = False
    for _ in range(120):
        page.keyboard.press("Tab")
        page.wait_for_timeout(40)
        hit = page.evaluate(
            "() => { const el = document.activeElement;"
            " return !!(el && el.classList && (el.classList.contains('fb-card-open') || el.classList.contains('cell-open'))); }"
        )
        if hit:
            reached = True
            break
    record("FB4 390px 键盘可达卡片详情入口", reached)
    if reached:
        ol = page.evaluate(
            "() => { const s = getComputedStyle(document.activeElement); return [s.outlineWidth, s.outlineStyle]; }"
        )
        record("FB4 焦点元素 outline 可见（非 none/0）", ol[0] not in ("0px", "0") and ol[1] != "none", f"outline={ol}")
        page.keyboard.press("Enter")
        opened = False
        try:
            page.wait_for_selector(".drawer", timeout=8000)
            opened = True
        except Exception:  # noqa: BLE001
            pass
        record("FB4 Enter 打开详情抽屉", opened)
        if opened:
            shot(page, "fb4-390-drawer-light")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            record("FB4 Esc 关闭抽屉", page.locator(".drawer").count() == 0)
    # 菜单可达：首行 MoreMenu 弹出
    page.set_viewport_size({"width": 1280, "height": 900})
    page.wait_for_timeout(350)
    row = page.locator(".fb-table tbody tr").first
    menu_ok = False
    if row.count() >= 1:
        try:
            row.locator(".more-menu > button").click()
            page.wait_for_selector(".more-menu-pop", timeout=4000)
            menu_ok = True
        except Exception:  # noqa: BLE001
            pass
    record("FB4 1280px 行级 MoreMenu 可弹出", menu_ok)
    if menu_ok:
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    select_theme(page, "system")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument(
        "--only",
        action="append",
        default=[],
        help="只运行标签含该子串的节（可重复）；S1/S2 登录前置始终执行",
    )
    args = ap.parse_args()
    ONLY_FILTER.extend(args.only)

    if not os.path.exists(os.path.join(ADMIN_DIST, "index.html")):
        print(
            f"[FATAL] 缺少管理页构建产物 {ADMIN_DIST}：请先 `pnpm --filter @feedback/admin build`"
            "（或用 FB_E2E_ADMIN_DIST 指定产物目录）",
            flush=True,
        )
        return 2
    busy = [p for p in (KANEO_PORT, AI_PORT) if port_busy(p)]
    if MOCK_PORTS_EXPLICIT and busy:
        # 显式端口被占：不接用未知进程、不杀占用者，直接 FATAL。
        print(f"[FATAL] E2E_KANEO_PORT/E2E_AI_PORT 已显式指定但端口被占用：{busy}", flush=True)
        return 2
    # 端口被占但本身就是健康的 mock 实例时复用（不重启、不杀死——可能是并行工作区在跑）。
    reuse_mock = bool(busy) and len(busy) == 2 and mock_alive()
    if busy and not reuse_mock:
        print(f"[FATAL] 端口被占用：{busy}（上次运行残留？）", flush=True)
        return 2

    os.makedirs(SHOTS, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="fb-admin-ui-e2e-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    procs = []
    logs = []
    try:
        if reuse_mock:
            step("复用已运行的 mock 外部服务（8898/8899 健康检查通过，不另起实例）")
        else:
            step("启动 mock 外部服务（AI :8899 / Kaneo :8898）")
            p, log = start_proc(["node", "e2e/mock-external.mjs"], ROOT, log_path="/tmp/fb-ui-mock.log")
            procs.append(p)
            logs.append(log)
            wait_http(f"http://127.0.0.1:{KANEO_PORT}/__health")
            wait_http(f"http://127.0.0.1:{AI_PORT}/__health")

        step(f"启动反馈服务 :{port}（托管 {ADMIN_DIST}）")
        env = dict(os.environ)
        env.update(
            FEEDBACK_MASTER_KEY="dWktZTJlLW1hc3Rlci1rZXktMzJieXRlcyE=",
            FEEDBACK_ADMIN_USER="admin",
            FEEDBACK_ADMIN_PASSWORD=ADMIN_PASS,
            FEEDBACK_ADMIN_DIST=ADMIN_DIST,
            FEEDBACK_DATA_DIR=data_dir,
            FEEDBACK_PORT=str(port),
            NODE_ENV="production",
        )
        p, log = start_proc(["npx", "tsx", "src/index.ts"], SERVER_DIR, env=env, log_path="/tmp/fb-ui-server.log")
        procs.append(p)
        logs.append(log)
        wait_http(f"{base}/healthz")

        h = Http()
        step("种子数据：连接 / 账号 / 软件 / 反馈（脚本内 API，不碰真实服务）")
        st, _ = h.call("POST", f"{base}/api/auth/login", {"username": "admin", "password": ADMIN_PASS})
        check("管理员 API 登录 200", st == 200, f"status={st}")
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
        st, body = h.call(
            "POST", f"{base}/api/admin/users", {"username": USER_NAME, "password": USER_PASS, "dailyLimit": 20}
        )
        check("创建普通账号 201", st == 201, f"status={st} body={body}")
        st, body = h.call(
            "POST",
            f"{base}/api/admin/apps",
            {
                "appId": SEED_APP_ID,
                "name": SEED_APP_NAME,
                "allowedOrigins": [],
                "kaneoProjectId": "p-e2e",
                "kaneoColumnSlug": "triage",
            },
        )
        check("种子软件创建 201", st == 201, f"status={st} body={body}")

        uh = Http()
        st, _ = uh.call("POST", f"{base}/api/auth/login", {"username": USER_NAME, "password": USER_PASS})
        check("普通账号登录 200", st == 200, f"status={st}")
        ids = {}
        for key, text in (("sync", FB_SYNC_TEXT), ("find", FB_FIND_TEXT)):
            st, body = uh.call(
                "POST",
                f"{base}/api/feedback",
                {
                    "idempotencyKey": f"ui-e2e-{key}-{secrets.token_hex(4)}",
                    "appId": SEED_APP_ID,
                    "text": text,
                    "context": {"appVersion": "1.0.0", "pageLabel": "ui-e2e"},
                },
            )
            check(f"种子反馈 {key} 201", st == 201, f"status={st} body={body}")
            ids[key] = body["feedbackId"]

        # 等 worker 完成 AI 整理（mock AI），再人工分类归档 → status=archived（UI「归档」动作的前提）。
        det = None
        deadline = time.time() + 45
        while time.time() < deadline:
            st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['sync']}")
            if det and det.get("processed"):
                break
            time.sleep(0.5)
        check("种子反馈 AI 整理完成", bool(det and det.get("processed")), f"det={det}")
        cver = (det.get("classification") or {}).get("version", 0)
        st, body = h.call(
            "POST",
            f"{base}/api/admin/feedback/{ids['sync']}/classify",
            {
                "action": "archive",
                "classifyVersion": cver,
                "operationId": f"op-{secrets.token_hex(6)}",
                "projectId": "p-e2e",
                "columnId": "col-1",
                "columnSlug": "triage",
                "labelIds": ["label-bug"],
                "assigneeId": None,
                "assigneeName": None,
            },
        )
        check("分类+同步受理", st in (200, 202), f"status={st} body={body}")
        deadline = time.time() + 45
        while time.time() < deadline:
            st, det = h.call("GET", f"{base}/api/admin/feedback/{ids['sync']}")
            if det and det.get("status") == "archived":
                break
            time.sleep(0.5)
        check(
            "种子反馈已同步（status=archived）",
            bool(det and det.get("status") == "archived"),
            f"status={(det or {}).get('status')}",
        )

        step("F2 种子数据：批量 50 条 + 长文本/长名/同名/无标题/未读/待回复夹具（脚本内 API）")
        f2_fx = seed_f2_fixtures(h, base)

        step("T1 种子数据：竞态/冲突比较三个软件对象（脚本内 API）")
        t1_fx = seed_t1_apps(h, base)
        step("T4 种子数据：专用软件 + 7 条混合工单状态反馈（脚本内 API）")
        t4_fx = seed_t4_fixtures(h, base)

        with sync_playwright() as pw:
            browser = None
            last_exc = None
            launch_attempts = (
                [{}, {"channel": "chrome"}, {"channel": "chromium"}]
                if args.browser == "chromium" and not os.environ.get("FB_E2E_CHROMIUM")
                else [{}]
            )
            for kwargs in launch_attempts:
                try:
                    exe = os.environ.get("FB_E2E_CHROMIUM")
                    if exe:
                        kwargs = {**kwargs, "executable_path": exe}
                    browser = getattr(pw, args.browser).launch(headless=not args.headed, **kwargs)
                    print(f"[INFO] {args.browser} launch kwargs={kwargs or 'default'}", flush=True)
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
            if browser is None:
                raise last_exc
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            def open_login() -> None:
                page.goto(f"{base}/admin/", wait_until="domcontentloaded")
                try:
                    page.wait_for_selector("#u", timeout=15000)
                    ok2 = True
                except Exception:  # noqa: BLE001
                    ok2 = False
                check("登录页渲染（#u 用户名输入出现）", ok2)

            # ---------- T1 深色模式（登录页） ----------
            run_section("S1 登录页渲染", open_login)
            run_section("T1-A 默认跟随系统", lambda: sec_t1_follow_system(page))
            run_section("T1-B 手动覆盖与控件一致性", lambda: sec_t1_override(page))
            run_section("T1-C 切主题保留登录草稿", lambda: sec_t1_login_draft(page))
            run_section("T1-D 刷新持久化", lambda: sec_t1_reload_persist(page))
            run_section("T1-E 非法偏好回退 system", lambda: sec_t1_invalid_pref(page))
            run_section("T1-F 手动偏好屏蔽系统变化", lambda: sec_t1_manual_vs_system(page))
            run_section("T2-A 键盘可达与焦点可见", lambda: sec_t2_keyboard(page))
            run_section("T1-H 登录页截图与对比度", lambda: sec_t1_login_shots_contrast(page))

            # ---------- T2 UI / 响应式 / 无障碍（登录页） ----------
            run_section("T2-B 登录页响应式溢出", lambda: sec_t2_login_viewport(page))
            run_section("T2-C 无 type 控件等效", lambda: sec_t2_untyped_input(page))
            run_section("T2-D Field 关联（登录失败）", lambda: sec_t2_field_assoc(page))

            # ---------- 管理外壳内（反馈页） ----------
            run_section("S2 管理员登录", lambda: sec_admin_login(page, base))
            run_section("T1-I 反馈页主题/草稿/截图/对比度", lambda: sec_t1_feedback(page))
            run_section("T2-E 反馈页响应式与布局等效缩放", lambda: sec_t2_feedback_viewport(page))

            # ---------- F2. 反馈页 UI 观感（F2 夹具驱动的硬门槛；在业务回归之前） ----------
            run_section("F2.A 游标分页与加载更多", lambda: sec_f2_pagination(page, f2_fx))
            run_section("F2.B 列表 DOM 契约", lambda: sec_f2_dom(page, f2_fx))
            run_section("F2.C 响应式与断点边界", lambda: sec_f2_responsive(page))
            run_section("F2.D 明暗主题对比度", lambda: sec_f2_contrast(page))
            run_section("F2.E 键盘焦点与抽屉", lambda: sec_f2_keyboard(page))
            run_section("F2.F 加载与错误态", lambda: sec_f2_load_error(page))
            run_section("F2.G 明暗双主题截图", lambda: sec_f2_shots(page))
            run_section("F2.H 账号呈现硬门槛", lambda: sec_f2_username(page))

            # ---------- F4 账号页区块间距（只读检查 + 账号操作证据；不改反馈页种子状态） ----------
            run_section("F4 账号页区块间距与操作", lambda: sec_f4_accounts_spacing(page))

            run_section("T1-J 退出重登偏好保持", lambda: sec_t1_logout(page))

            # ---------- 业务回归（隔离环境） ----------
            run_section("S3 业务回归", lambda: sec_regression(page, base))

            # ---------- Feedback-3：规则保存状态 + 后台诊断日志 ----------
            run_section("FB3-A 规则保存状态", lambda: sec_fb3_rule_status(page, h, base))
            run_section("FB3-A 写入成功后的列表刷新失败恢复", lambda: sec_fb3_write_refresh_failure(page))
            run_section("FB3-B 组件诊断日志", lambda: sec_fb3_widget_diag(page, h, base))

            # ---------- Kaneo In Review：T1 软件配置竞态/冲突比较（成员 A 的 UI 契约断言） ----------
            run_section("T1.1 延迟 GET 竞态与写期间编辑", lambda: sec_t1_delayed_get_race(page, h, base, t1_fx))
            run_section("T1.2 409 逐项冲突比较", lambda: sec_t1_conflict_compare(page, h, base, t1_fx))
            run_section("T1.3 创建后刷新失败只创建一条", lambda: sec_t1_create_refresh_retry(page, h, base, t1_fx))

            # ---------- T4 工单筛选计数一致（UI 层断言，与 D 的服务端测试互补） ----------
            run_section("T4 混合工单状态筛选与 counts 一致", lambda: sec_fb_filter_counts(page, h, base, t4_fx))

            # ---------- FB4 布局回归（Feedback #4）：390/767/768/1280 × 明暗 ----------
            run_section("FB4 布局回归矩阵", lambda: sec_fb4_layout_regression(page))

            # ---------- T1.6 存储失败兜底（独立 context） ----------
            run_section("T1-K 存储失败兜底", lambda: sec_t1_storage_fail(browser, base))

            # ---------- actual_zoom 真实浏览器缩放（独立 headed 持久会话） ----------
            run_section("actual_zoom 真实浏览器缩放", lambda: sec_actual_zoom(pw, args, base))

            real_errors = [
                e for e in console_errors if "401" not in e and "404" not in e and "Failed to load" not in e
            ]
            record("浏览器控制台无 JS 运行时错误", real_errors == [], f"errors={real_errors[:5]}")
            ctx.close()
            browser.close()

    finally:
        for pr in procs:
            try:
                pr.terminate()
            except Exception:  # noqa: BLE001
                pass
        for lg in logs:
            try:
                lg.close()
            except Exception:  # noqa: BLE001
                pass

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [n for n, ok, _ in results if not ok]
    summary = {
        "total": len(results) + len(pending),
        "asserted": len(results),
        "passed": passed,
        "failed": failed,
        "pendingCount": len(pending),
        "warningCount": len(warnings),
        "dataDir": data_dir,
        "base": base,
        "adminDist": ADMIN_DIST,
        "shots": SHOTS,
    }
    os.makedirs(SHOTS, exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump({"summary": summary, "results": results, "pending": pending, "warnings": warnings}, f, ensure_ascii=False, indent=2)
    print(f"\n[SUMMARY] {passed}/{len(results)} 硬断言通过；{len(pending)} 项待实现；{len(warnings)} 条警告", flush=True)
    if pending:
        print(f"[PENDING] {[n for n, _ in pending]}", flush=True)
    if failed:
        print(f"[FAILED] {failed}", flush=True)
    print(f"[REPORT] {REPORT}", flush=True)
    return 1 if failed or pending else 0


if __name__ == "__main__":
    sys.exit(main())
