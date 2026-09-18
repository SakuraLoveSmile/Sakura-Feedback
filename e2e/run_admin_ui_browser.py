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
- spec()            T1/T2 契约断言：满足记 PASS；不满足按「待实现」记入 pending（不计失败）；
- spec(soft=True)   度量项（对比度等）：不满足记 warnings（soft 警告，同样不计失败）。
report.json 分 results / pending / warnings 三段，便于区分「harness 验证」与「产品待实现」。
退出码：2=前置缺失，1=硬断言（check/record）失败，0=全部硬断言与契约断言通过（pending 阻止通过）。

用法：python3 e2e/run_admin_ui_browser.py [--browser chromium] [--headed]
环境：FB_E2E_ADMIN_DIST 指定管理页产物目录（默认 apps/admin/dist）；
     FB_E2E_CHROMIUM 指定浏览器可执行文件。
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
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

_THIS_FILE = os.path.abspath(__file__)
ROOT = os.sep.join(_THIS_FILE.split(os.sep)[:-2])
SERVER_DIR = os.sep.join([ROOT, "apps", "server"])
ADMIN_DIST = os.environ.get("FB_E2E_ADMIN_DIST") or os.sep.join([ROOT, "apps", "admin", "dist"])
SHOTS = os.sep.join([ROOT, "e2e", "shots", "admin-ui"])
REPORT = os.sep.join([SHOTS, "report.json"])

KANEO_PORT = int(os.environ.get("E2E_KANEO_PORT", "8898"))
AI_PORT = int(os.environ.get("E2E_AI_PORT", "8899"))

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


def run_section(label: str, fn) -> None:
    """一节断言：check() 失败只中断本节，其余节照常执行。"""
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
    page.wait_for_timeout(400)
    spec(
        "T1.1 默认跟随系统：emulate dark → dataset.theme='dark'",
        dataset_theme(page) == "dark",
        f"dataset={dataset_theme(page)}",
    )
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(400)
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


def sec_t2_feedback_viewport(page, ctx) -> None:
    """T2.11 反馈页四档视口无溢出（390 控件 ≥44px）；T2.15 200% 缩放无溢出。"""
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
    # T2.15 200% 缩放：CDP Emulation.setPageScaleFactor（Chromium 专有）
    try:
        cdp = ctx.new_cdp_session(page)
        cdp.send("Emulation.setPageScaleFactor", {"pageScaleFactor": 2.0})
        page.wait_for_timeout(500)
        info = scroll_probe(page)
        spec(
            "T2.15 200% 缩放（1440 视口）下反馈页无整页横向溢出",
            info[0] <= info[1] + 1,
            f"scrollWidth={info[0]} innerWidth={info[1]}",
        )
        cdp.send("Emulation.setPageScaleFactor", {"pageScaleFactor": 1.0})
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"T2.15 200% 缩放度量跳过（CDP 不可用或非 Chromium）：{exc}")


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


# ---------- 业务回归（隔离环境） ----------


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
    try:
        page.wait_for_selector(".drawer", timeout=10000)
        page.wait_for_selector(".drawer .quote", timeout=10000)
        opened = True
    except Exception:  # noqa: BLE001
        opened = False
    check("点击行打开详情抽屉", opened)
    shot(page, "07-feedback-drawer")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    step("R4 归档一条（种子已同步反馈 → 已归档区域）")
    page.fill(SEARCH_SEL, "")
    page.wait_for_timeout(900)
    row = page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).first
    row.locator(".more-menu > button").click()
    page.locator(".more-menu-pop button", has_text="归档").click()
    page.wait_for_timeout(1200)
    goto_view(page, "archived")
    check(
        "归档一条反馈后进入「已归档」区域",
        page.locator(".fb-table tbody tr", has_text=ROW_SYNC_NEEDLE).count() >= 1,
    )
    shot(page, "08-archived")

    step("R5 删除确认弹窗：移入回收站 → 彻底删除")
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=("chromium", "firefox", "webkit"))
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(os.path.join(ADMIN_DIST, "index.html")):
        print(
            f"[FATAL] 缺少管理页构建产物 {ADMIN_DIST}：请先 `pnpm --filter @feedback/admin build`"
            "（或用 FB_E2E_ADMIN_DIST 指定产物目录）",
            flush=True,
        )
        return 2
    busy = [p for p in (KANEO_PORT, AI_PORT) if port_busy(p)]
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
            run_section("T2-E 反馈页响应式与 200% 缩放", lambda: sec_t2_feedback_viewport(page, ctx))
            run_section("T1-J 退出重登偏好保持", lambda: sec_t1_logout(page))

            # ---------- 业务回归（隔离环境） ----------
            run_section("S3 业务回归", lambda: sec_regression(page, base))

            # ---------- T1.6 存储失败兜底（独立 context） ----------
            run_section("T1-K 存储失败兜底", lambda: sec_t1_storage_fail(browser, base))

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
