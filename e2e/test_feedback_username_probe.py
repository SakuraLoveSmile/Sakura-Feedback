"""提交账号（.feedback-username）呈现探针 —— F2.H 断言的纯函数模块。

被 e2e/run_admin_ui_browser.py 以 `import test_feedback_username_probe as uname_probe`
导入（主脚本已把 e2e/ 目录加入 sys.path）。模块只读调用方传入的 playwright
page 对象（鸭子类型）：不创建服务、不启动浏览器、不连网络，import 无任何副作用。

行/卡片定位靠「针文本」：候选行（.fb-table tbody tr）/卡片（.fb-card）的
innerText 包含 needle 即目标，找不到返回 null。

冻结字段契约（JS 探针原样返回的页面事实）：

USERNAME_TABLE_JS（桌面 ≥768px 表格行）：
  hasClass        行内存在 .feedback-username（不存在则回退取第 4 个 td 测量，
                  此时 hasClass=false，title 等 class 相关事实自然为 null）
  fullText        账号元素 textContent.trim（DOM 应保留完整账号）
  title           账号元素 title 属性（无则 null）
  scrollWidth / clientWidth / scrollHeight / clientHeight   账号元素盒测量
  visibleHeight   账号元素 getBoundingClientRect().height
  lineHeight      computed line-height 数值 px（'normal' 回退 fontSize*1.2）
  lines           visibleHeight/lineHeight，保留 2 位小数
  rowHeight       所在 tr 的 getBoundingClientRect().height（取整）
  menuReachable   行内 .more-menu>button 非 disabled、rect>0、display/visibility 正常
  cellOverflow    账号 td scrollWidth-clientWidth
  docScrollWidth / innerWidth   整页横向溢出事实

USERNAME_CARD_JS（移动 <768px 卡片）：
  hasClass / fullText / scrollWidth / clientWidth / scrollHeight / clientHeight /
  visibleHeight / lineHeight / lines   同上（无 class 时元素项为 null/0，
                  并直接在 .fb-card-meta 内量算溢出事实）
  cardWidth / cardScrollWidth          卡片 clientWidth / scrollWidth
  metaOverflow     .fb-card-meta 容器 scrollWidth-clientWidth 与其内各 span
                   scrollWidth-clientWidth 的最大值（任一 span 横向溢出即 >0）
  menuReachable / docScrollWidth / innerWidth   同上

调用方式（主脚本 sec_f2_username 实际用法）：

    import test_feedback_username_probe as uname_probe

    uname_probe.assert_table_username(
        record, page, needle=F2_NEEDLE["asciiuser"],
        username=F2_ASCII_USER, name_prefix="F2.H 桌面·100字符ASCII账号",
    )
    uname_probe.assert_mobile_username(
        record, page, needle=F2_NEEDLE["asciiuser"],
        username=F2_ASCII_USER, name_prefix="F2.H 移动·100字符ASCII账号",
    )

record 为主脚本传入的 `record(name, cond, detail)` 非中断断言函数：每条门槛
各自记录并继续执行；探针未命中（None）时后续条目也逐条 record(False)，
detail 带实测值（缺失为 None），保证缺陷在改动前被逐条捕获。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# 行级账号探针：按针文本定位 .fb-table 行，读取 .feedback-username（缺失回退
# 第 4 个 td）的 DOM/盒模型/行高/菜单可达性事实。与 F2_ROW_JS 同风格。
USERNAME_TABLE_JS: str = """(needle) => {
  const tr = [...document.querySelectorAll('.fb-table tbody tr')]
    .find((r) => (r.innerText || '').includes(needle));
  if (!tr) return null;
  const tds = [...tr.querySelectorAll('td')];
  const cls = tr.querySelector('.feedback-username');
  const el = cls || tds[3] || null;
  const td = el && el.closest ? el.closest('td') : (tds[3] || null);
  const cs = el ? getComputedStyle(el) : null;
  const fs = cs ? parseFloat(cs.fontSize) : NaN;
  let lh = cs ? parseFloat(cs.lineHeight) : NaN;
  if (isNaN(lh)) lh = isNaN(fs) ? 0 : fs * 1.2;
  const visibleH = el ? el.getBoundingClientRect().height : 0;
  const menuBtn = tr.querySelector('.more-menu > button');
  const mr = menuBtn ? menuBtn.getBoundingClientRect() : null;
  const mcs = menuBtn ? getComputedStyle(menuBtn) : null;
  return {
    hasClass: !!cls,
    fullText: el ? (el.textContent || '').trim() : null,
    title: el ? el.getAttribute('title') : null,
    scrollWidth: el ? el.scrollWidth : 0,
    clientWidth: el ? el.clientWidth : 0,
    scrollHeight: el ? el.scrollHeight : 0,
    clientHeight: el ? el.clientHeight : 0,
    visibleHeight: visibleH,
    lineHeight: lh,
    lines: lh > 0 ? Math.round((visibleH / lh) * 100) / 100 : 0,
    rowHeight: Math.round(tr.getBoundingClientRect().height),
    menuReachable: !!(menuBtn && mr && mr.width > 0 && mr.height > 0
      && mcs && mcs.display !== 'none' && mcs.visibility !== 'hidden' && !menuBtn.disabled),
    cellOverflow: td ? td.scrollWidth - td.clientWidth : 0,
    docScrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}"""

# 卡片级账号探针：按针文本定位 .fb-card，读取 .feedback-username 的 DOM/盒模型
# 事实；class 缺失时元素项为 null/0，metaOverflow 仍直接在 .fb-card-meta 内量算
# （容器横向溢出与其内任一 span 横向溢出取最大值），保证无 class 的缺陷也能量化。
USERNAME_CARD_JS: str = """(needle) => {
  const card = [...document.querySelectorAll('.fb-card')]
    .find((c) => (c.innerText || '').includes(needle));
  if (!card) return null;
  const el = card.querySelector('.feedback-username');
  const meta = card.querySelector('.fb-card-meta');
  const cs = el ? getComputedStyle(el) : null;
  const fs = cs ? parseFloat(cs.fontSize) : NaN;
  let lh = cs ? parseFloat(cs.lineHeight) : NaN;
  if (isNaN(lh)) lh = isNaN(fs) ? 0 : fs * 1.2;
  const visibleH = el ? el.getBoundingClientRect().height : 0;
  let metaOverflow = 0;
  if (meta) {
    metaOverflow = meta.scrollWidth - meta.clientWidth;
    for (const s of meta.querySelectorAll('span')) {
      metaOverflow = Math.max(metaOverflow, s.scrollWidth - s.clientWidth);
    }
  }
  const menuBtn = card.querySelector('.more-menu > button');
  const mr = menuBtn ? menuBtn.getBoundingClientRect() : null;
  const mcs = menuBtn ? getComputedStyle(menuBtn) : null;
  return {
    hasClass: !!el,
    fullText: el ? (el.textContent || '').trim() : null,
    scrollWidth: el ? el.scrollWidth : 0,
    clientWidth: el ? el.clientWidth : 0,
    scrollHeight: el ? el.scrollHeight : 0,
    clientHeight: el ? el.clientHeight : 0,
    visibleHeight: visibleH,
    lineHeight: lh,
    lines: lh > 0 ? Math.round((visibleH / lh) * 100) / 100 : 0,
    cardWidth: card.clientWidth,
    cardScrollWidth: card.scrollWidth,
    metaOverflow: metaOverflow,
    menuReachable: !!(menuBtn && mr && mr.width > 0 && mr.height > 0
      && mcs && mcs.display !== 'none' && mcs.visibility !== 'hidden' && !menuBtn.disabled),
    docScrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}"""


def probe_table(page: Any, needle: str) -> dict[str, Any] | None:
    """桌面表格账号行探针：命中返回字段 dict，未命中（或非 dict）返回 None。"""
    res = page.evaluate(USERNAME_TABLE_JS, needle)
    return res if isinstance(res, dict) else None


def probe_card(page: Any, needle: str) -> dict[str, Any] | None:
    """移动卡片账号探针：命中返回字段 dict，未命中（或非 dict）返回 None。"""
    res = page.evaluate(USERNAME_CARD_JS, needle)
    return res if isinstance(res, dict) else None


def _is_num(v: Any) -> bool:
    """JS 数值字段判定：排除 bool/None/字符串；NaN 由比较自然失败。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _le(value: Any, limit: float) -> bool:
    return _is_num(value) and value <= limit


def _le_pair(left: Any, right: Any, slack: float) -> bool:
    return _is_num(left) and _is_num(right) and left <= right + slack


def _cut(v: Any, limit: int = 90) -> str:
    """record detail 实测值：repr 截断（None/百字符账号安全）。"""
    s = repr(v)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def assert_table_username(
    record: Callable[[str, bool, str], bool],
    page: Any,
    *,
    needle: str,
    username: str,
    name_prefix: str,
    max_lines: float = 2,
    max_row_h: float = 104,
) -> bool:
    """桌面表格「提交账号」逐条硬断言（非中断，全部执行；任一失败返回 False）。

    门槛：探针命中 / .feedback-username class 存在 / DOM 保留完整账号 /
    title 提供完整值 / 视觉行数 ≤max_lines / 行高 ≤max_row_h /
    账号单元格无横向内溢出 / 行内 MoreMenu 可见可用。
    """
    probe = probe_table(page, needle)
    p: dict[str, Any] = probe if isinstance(probe, dict) else {}

    ok = record(f"{name_prefix} 探针命中目标行", probe is not None, f"needle={needle!r}")
    ok = record(
        f"{name_prefix} .feedback-username class 存在",
        bool(p.get("hasClass")),
        f"hasClass={p.get('hasClass')!r}",
    ) and ok
    ok = record(
        f"{name_prefix} DOM 保留完整账号",
        p.get("fullText") == username,
        f"fullText={_cut(p.get('fullText'))} expect={_cut(username)}",
    ) and ok
    ok = record(
        f"{name_prefix} title 提供完整值",
        p.get("title") == username,
        f"title={_cut(p.get('title'))}",
    ) and ok
    ok = record(
        f"{name_prefix} 账号视觉行数 ≤{max_lines}",
        _le(p.get("lines"), max_lines + 0.01),
        f"lines={p.get('lines')} lineHeight={p.get('lineHeight')} visibleHeight={p.get('visibleHeight')}",
    ) and ok
    ok = record(
        f"{name_prefix} 目标行高 ≤{max_row_h}px",
        _le(p.get("rowHeight"), max_row_h),
        f"rowHeight={p.get('rowHeight')}",
    ) and ok
    ok = record(
        f"{name_prefix} 账号单元格无横向内溢出",
        _le(p.get("cellOverflow"), 2) and _le_pair(p.get("scrollWidth"), p.get("clientWidth"), 2),
        f"cellOverflow={p.get('cellOverflow')} scrollWidth={p.get('scrollWidth')} clientWidth={p.get('clientWidth')}",
    ) and ok
    ok = record(
        f"{name_prefix} 行内 MoreMenu 可见可用",
        bool(p.get("menuReachable")),
        f"menuReachable={p.get('menuReachable')!r}",
    ) and ok
    return ok


def assert_mobile_username(
    record: Callable[[str, bool, str], bool],
    page: Any,
    *,
    needle: str,
    username: str,
    name_prefix: str,
) -> bool:
    """移动卡片「提交账号」逐条硬断言（非中断，全部执行；任一失败返回 False）。

    门槛：探针命中 / .feedback-username class 存在 / DOM 保留完整账号 /
    账号元素自身与 meta 无横向溢出 / 完整换行未裁剪（无 clamp 隐藏）/
    整页无横向溢出。
    """
    probe = probe_card(page, needle)
    p: dict[str, Any] = probe if isinstance(probe, dict) else {}

    ok = record(f"{name_prefix} 探针命中目标卡片", probe is not None, f"needle={needle!r}")
    ok = record(
        f"{name_prefix} .feedback-username class 存在",
        bool(p.get("hasClass")),
        f"hasClass={p.get('hasClass')!r}",
    ) and ok
    ok = record(
        f"{name_prefix} DOM 保留完整账号",
        p.get("fullText") == username,
        f"fullText={_cut(p.get('fullText'))} expect={_cut(username)}",
    ) and ok
    ok = record(
        f"{name_prefix} 账号元素自身无横向溢出",
        _le_pair(p.get("scrollWidth"), p.get("clientWidth"), 1) and _le(p.get("metaOverflow"), 1),
        f"scrollWidth={p.get('scrollWidth')} clientWidth={p.get('clientWidth')} metaOverflow={p.get('metaOverflow')}",
    ) and ok
    ok = record(
        f"{name_prefix} 账号完整换行未裁剪",
        _le_pair(p.get("scrollHeight"), p.get("clientHeight"), 1),
        f"scrollHeight={p.get('scrollHeight')} clientHeight={p.get('clientHeight')} lines={p.get('lines')}",
    ) and ok
    ok = record(
        f"{name_prefix} 整页无横向溢出",
        _le_pair(p.get("docScrollWidth"), p.get("innerWidth"), 1),
        f"docScrollWidth={p.get('docScrollWidth')} innerWidth={p.get('innerWidth')}",
    ) and ok
    return ok
