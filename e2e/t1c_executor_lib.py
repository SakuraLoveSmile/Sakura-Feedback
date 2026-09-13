#!/usr/bin/env python3
"""T1-C 统一验收执行器 · 纯判定逻辑（可单测，无 IO）。

阶段结果协议（Dart 写入 / Python 读取完全一致；**不混用大小写**）：

    {"runId": "<本轮运行标识>",
     "phase": "1" | "2",
     "verdict": "PASS" | "FAIL" | "BLOCKED",
     "reason": "<人类可读原因>",
     "blockedCause": "missing-entitlement",      # 仅 BLOCKED 且可明确识别时
     "cleanupError": "<非空即表示清理失败>",       # 可选
     "identity": {"appId": "...", "username": "..."},
     "checks": [{"name": "...", "verdict": "PASS|FAIL|BLOCKED", "reason": "..."}],
     "cleanup": {"probeCleared": true, "tokenCleared": true},
     "finishedAt": "<ISO8601>"}

判定规则（T1-C 第 9 轮收紧）：
- 结果必须是 JSON **对象**；runId / phase / identity.appId / identity.username
  必须与预期**完全一致**（phase 严格字符串 "1"/"2"，verdict 严格大写）。
- PASS 必须同时满足：进程退出码 0 + verdict==PASS + 必需检查项齐全且全部
  PASS + 该阶段全部强制清理布尔项为 true。exit 0 / skip / 缺文件都不算 PASS。
- 第二阶段必须显式包含 tokenCleared: true 与 probeCleared: true；缺字段、
  类型不对或非 true 一律 FAIL。任何非空 cleanupError 一律 FAIL。
- BLOCKED 只接受「明确识别的缺少 entitlement」结果（blockedCause 属于
  白名单）且要求清理完成（阶段 1 的 BLOCKED 必须能证明本轮从未写出令牌）；
  未知错误不能转为 BLOCKED。
- 探针同时保留主错误与清理错误；**只要清理失败，整体就是 FAIL**，即使
  主错误是可识别的 -34018 也一样。
"""

import hashlib
import json

PASS = "PASS"
FAIL = "FAIL"
BLOCKED = "BLOCKED"
NOT_RUN = "NOT_RUN"

# 退出码约定：0=PASS，1=FAIL，2=BLOCKED
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_BLOCKED = 2

VERDICTS = (PASS, FAIL, BLOCKED)
PHASES = ("1", "2")

#: 唯一允许判 BLOCKED 的原因标识（Dart 侧只有明确识别 -34018 /
#: errSecMissingEntitlement 时才写入该值）。
BLOCKED_CAUSE_MISSING_ENTITLEMENT = "missing-entitlement"
BLOCKED_CAUSES = (BLOCKED_CAUSE_MISSING_ENTITLEMENT,)

#: 各阶段必须齐全且全部 PASS 的检查项（机器可读名；Dart 侧同名常量）。
#: `acceptance` = 服务端真实接收（201 + 非空 feedbackId + 非重放）。
REQUIRED_CHECKS = {
    "1": ("probe", "tokenPersisted", "acceptance"),
    "2": ("phase1Record", "probe", "tokenRestored", "identityRestored", "acceptance", "cleanup"),
}

#: 真实接收契约：只接受 201（新建），且必须带非空 feedbackId、且非幂等重放。
ACCEPTANCE_HTTP_STATUS = 201

#: 各阶段必须显式为 **true** 的强制清理项。
REQUIRED_CLEANUP_TRUE = {
    "1": ("probeCleared",),
    "2": ("tokenCleared", "probeCleared"),
}

#: 必须存在且为布尔值的清理证据项（PASS 时不强制为 true）：
#: 阶段 1 的 `tokenCleared` 表示"阶段 1 结束时本轮令牌键是否已确认清空"——
#: PASS 时按设计为 false（令牌保留给恢复阶段）。这一事实必须由阶段自己
#: 给出，执行器不替它推断（无法证明就不能推断）；判 BLOCKED 时它必须为
#: true，即能够证明本轮从未写出令牌、没有残留。
REQUIRED_CLEANUP_BOOL = {
    "1": ("tokenCleared",),
    "2": (),
}


def _verdict(verdict, reason, **details):
    out = {"verdict": verdict, "reason": reason}
    if details:
        out["details"] = details
    return out


def evaluate_phase(exit_code, result, expect_run_id, phase, expect_identity=None):
    """判定单个阶段。result 为解析后的 JSON 值（期望是 dict）或 None。

    expect_identity: {"appId": str, "username": str}；给出时必须完全一致。

    返回 {"verdict": PASS|FAIL|BLOCKED, "reason": str}。
    """
    label = f"阶段 {phase} "
    if phase not in PHASES:
        return _verdict(FAIL, f"执行器内部错误：未知阶段标识 {phase!r}（契约只允许 '1'/'2'）")
    if result is None:
        return _verdict(
            FAIL,
            f"{label}结果文件缺失或不可解析（进程退出码 {exit_code}）"
            "——缺文件、skip 或崩溃都不得判 PASS",
        )
    if not isinstance(result, dict):
        return _verdict(
            FAIL,
            f"{label}结果不是 JSON 对象（实际类型 {type(result).__name__}）——不读取形状未知的证据",
        )

    # ---- 身份与阶段：完全一致，任何一项不符立即 FAIL ----
    problems = identity_problems(result, expect_run_id, phase, expect_identity)
    if problems:
        return _verdict(FAIL, f"{label}身份/阶段不符：{'；'.join(problems)}")

    # ---- 清理错误：非空即 FAIL（任何 verdict 都不能掩盖）----
    cleanup_error = result.get("cleanupError")
    if cleanup_error not in (None, ""):
        if not isinstance(cleanup_error, str):
            return _verdict(
                FAIL, f"{label}cleanupError 类型非法（{type(cleanup_error).__name__}），按清理失败处理")
        main_reason = result.get("reason") or ""
        return _verdict(
            FAIL,
            f"{label}清理失败：{cleanup_error}｜主错误：{main_reason}"
            "（两个原因都保留；记录残留身份，不判 PASS/BLOCKED，"
            "即使主错误是可识别的签名阻塞也不例外）",
        )

    raw_verdict = result.get("verdict")
    if not isinstance(raw_verdict, str) or raw_verdict not in VERDICTS:
        return _verdict(
            FAIL,
            f"{label}结果 verdict 缺失、大小写不符契约或未知：{raw_verdict!r}"
            f"（契约只允许 {'/'.join(VERDICTS)}）",
        )
    reason = result.get("reason") or ""

    if raw_verdict == BLOCKED:
        if exit_code != 0:
            return _verdict(
                FAIL, f"{label}结果为 BLOCKED 但进程退出码为 {exit_code}（应为 skip 的 0）")
        cause = result.get("blockedCause")
        if cause not in BLOCKED_CAUSES:
            return _verdict(
                FAIL,
                f"{label}声称 BLOCKED 但缺少可识别的阻塞原因"
                f"（blockedCause={cause!r} 不在白名单 {list(BLOCKED_CAUSES)}）"
                "——未知错误不能转为 BLOCKED",
            )
        bad_cleanup = _bad_cleanup(result, phase, blocked=True)
        if bad_cleanup:
            return _verdict(
                FAIL,
                f"{label}已知环境阻塞（{cause}）但清理未完成：{','.join(bad_cleanup)}"
                "——记录残留身份，不判 BLOCKED",
            )
        return _verdict(BLOCKED, f"{label}已知环境阻塞：{reason}")

    if raw_verdict == PASS:
        if exit_code != 0:
            return _verdict(FAIL, f"{label}结果为 PASS 但进程退出码为 {exit_code}")
        acceptance = acceptance_problems(result)
        if acceptance:
            return _verdict(
                FAIL,
                f"{label}服务端接收证据不成立：{'；'.join(acceptance)}"
                "（拒绝 / 重放 / 超时 / 缺 ID 均不得判 PASS）",
            )
        missing, not_pass, shape = _check_problems(result, phase)
        if shape:
            return _verdict(FAIL, f"{label}{shape}")
        if missing:
            return _verdict(
                FAIL, f"{label}必需检查项缺失：{','.join(missing)}——证据不全不得判 PASS")
        if not_pass:
            return _verdict(
                FAIL, f"{label}必需检查项未通过：{','.join(not_pass)}——不得判 PASS")
        bad_cleanup = _bad_cleanup(result, phase)
        if bad_cleanup:
            return _verdict(
                FAIL,
                f"{label}清理未完成：{','.join(bad_cleanup)}（记录残留身份，不判 PASS）",
            )
        return _verdict(PASS, f"{label}通过：{reason}")

    return _verdict(FAIL, f"{label}失败：{reason}")


def acceptance_problems(result):
    """服务端真实接收契约：201 + 非空 feedbackId + 非重放。

    返回问题列表（空列表 = 成立）。拒绝（非 201）、重放、缺 ID 一律不算接收。
    """
    acceptance = result.get("acceptance")
    if not isinstance(acceptance, dict):
        return [f"acceptance 缺失或不是对象（实际 {type(acceptance).__name__}）"]
    problems = []
    status = acceptance.get("httpStatus")
    if status != ACCEPTANCE_HTTP_STATUS:
        problems.append(f"httpStatus={status!r}（要求 {ACCEPTANCE_HTTP_STATUS}）")
    feedback_id = acceptance.get("feedbackId")
    if not isinstance(feedback_id, str) or not feedback_id.strip():
        problems.append(f"feedbackId 缺失或为空（{feedback_id!r}）")
    if acceptance.get("replayed") is not False:
        problems.append(
            f"replayed={acceptance.get('replayed')!r}（要求 false——重放不算新接收）")
    return problems


def acceptance_of(result):
    """取出规范化后的接收证据（仅供执行器核对与报告，缺字段返回 None）。"""
    if not isinstance(result, dict):
        return None
    acceptance = result.get("acceptance")
    if not isinstance(acceptance, dict):
        return None
    return {
        "httpStatus": acceptance.get("httpStatus"),
        "feedbackId": acceptance.get("feedbackId"),
        "replayed": acceptance.get("replayed"),
    }


def identity_problems(result, expect_run_id, phase, expect_identity=None):
    """返回结果与预期不一致的问题列表（空列表 = 一致）。"""
    problems = []
    if result.get("runId") != expect_run_id:
        problems.append(
            f"runId 不匹配（期望 {expect_run_id!r}，实际 {result.get('runId')!r}）"
            "——不读取其他测试身份")
    if result.get("phase") != phase:
        problems.append(
            f"phase 不匹配（期望 {phase!r}，实际 {result.get('phase')!r}）")
    identity = result.get("identity")
    if not isinstance(identity, dict):
        problems.append(f"identity 缺失或不是对象（实际 {type(identity).__name__}）")
        return problems
    if expect_identity is not None:
        for key in ("appId", "username"):
            if identity.get(key) != expect_identity.get(key):
                problems.append(
                    f"identity.{key} 不匹配（期望 {expect_identity.get(key)!r}，"
                    f"实际 {identity.get(key)!r}）")
    else:
        for key in ("appId", "username"):
            if not isinstance(identity.get(key), str) or not identity.get(key):
                problems.append(f"identity.{key} 缺失或非字符串")
    return problems


def _check_problems(result, phase):
    """返回 (缺失项, 未通过项, 形状问题)。"""
    checks = result.get("checks")
    if not isinstance(checks, list):
        return [], [], f"checks 缺失或不是数组（实际 {type(checks).__name__}）"
    by_name = {}
    malformed = []
    for item in checks:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            malformed.append(repr(item)[:80])
            continue
        by_name[item["name"]] = item
    if malformed:
        return [], [], f"checks 含结构非法的条目：{'; '.join(malformed)}"
    missing, not_pass = [], []
    for name in REQUIRED_CHECKS[phase]:
        item = by_name.get(name)
        if item is None:
            missing.append(name)
            continue
        if item.get("verdict") != PASS:
            not_pass.append(f"{name}={item.get('verdict')!r}")
    # 必需项都通过时，其余检查项也不得失败（整体 PASS 与单项 FAIL 不能并存）
    if not missing and not not_pass:
        for name, item in sorted(by_name.items()):
            if item.get("verdict") != PASS:
                not_pass.append(f"{name}={item.get('verdict')!r}")
    return missing, not_pass, None


def _bad_cleanup(result, phase, *, blocked=False):
    """返回未满足的强制清理项说明（空列表 = 全部满足）。

    blocked=True（判 BLOCKED）时，布尔证据项也必须为 true（证明无残留）。
    """
    cleanup = result.get("cleanup")
    if not isinstance(cleanup, dict):
        return [f"cleanup 缺失或不是对象（实际 {type(cleanup).__name__}）"]
    must_true = list(REQUIRED_CLEANUP_TRUE[phase])
    if blocked:
        must_true += [k for k in REQUIRED_CLEANUP_BOOL[phase] if k not in must_true]
    bad = []
    for key in must_true:
        if key not in cleanup:
            bad.append(f"{key} 缺失")
        elif not isinstance(cleanup[key], bool):
            bad.append(f"{key} 类型非法（{type(cleanup[key]).__name__}，必须为布尔 true）")
        elif cleanup[key] is not True:
            bad.append(f"{key}={cleanup[key]}")
    if not blocked:
        for key in REQUIRED_CLEANUP_BOOL[phase]:
            if key in must_true:
                continue
            if key not in cleanup:
                bad.append(f"{key} 缺失（必须显式给出该清理证据）")
            elif not isinstance(cleanup[key], bool):
                bad.append(f"{key} 类型非法（{type(cleanup[key]).__name__}，必须为布尔值）")
    return bad


def evaluate_cleanup(result, expect_run_id, expect_identity):
    """判定执行器兜底清理入口（阶段崩溃后的残留清理）结果。

    返回 {"verdict": PASS|FAIL, "reason": str}。
    """
    if result is None or not isinstance(result, dict):
        return _verdict(FAIL, "兜底清理结果缺失、不可解析或不是 JSON 对象——按残留未清理处理")
    problems = identity_problems(result, expect_run_id, "cleanup", expect_identity)
    if problems:
        return _verdict(FAIL, f"兜底清理身份不符：{'；'.join(problems)}")
    bad = []
    cleanup = result.get("cleanup")
    if not isinstance(cleanup, dict):
        bad.append(f"cleanup 缺失或不是对象（实际 {type(cleanup).__name__}）")
    else:
        for key in ("tokenCleared", "probeCleared"):
            if cleanup.get(key) is not True:
                bad.append(f"{key}={cleanup.get(key)!r}")
    err = result.get("cleanupError")
    if err not in (None, ""):
        bad.append(f"cleanupError={err}")
    if bad or result.get("verdict") != PASS:
        return _verdict(
            FAIL,
            f"兜底清理未完成：{'; '.join(bad) or result.get('reason') or 'verdict != PASS'}"
            "——记录残留键身份，不判清理完成",
        )
    return _verdict(PASS, f"兜底清理完成：{result.get('reason') or ''}")


def decide_overall(p1, p2, usage_ok, run_id, cleanup_ok=True):
    """汇总两阶段、服务端用量核对与账号清理。

    - 有已执行阶段 FAIL → FAIL（任何其他结论都不能掩盖）；
    - 否则有阶段 BLOCKED → BLOCKED；
    - 有阶段未执行且无 BLOCKED → FAIL（执行器流程缺陷）；
    - 两阶段 PASS 但用量核对不为两次 / 账号清理未完成 → FAIL；
    - 全部通过 → PASS。
    """
    ran = [p for p in (p1, p2) if p.get("verdict") != NOT_RUN]
    for p in ran:
        if p["verdict"] == FAIL:
            return _verdict(FAIL, p["reason"])
    if not cleanup_ok:
        return _verdict(
            FAIL, "本轮清理未完成（账号禁用 / 服务停止 / 参数文件删除未全部确认）"
            "——清理失败不得被 PASS 或 BLOCKED 掩盖")
    for p in ran:
        if p["verdict"] == BLOCKED:
            return _verdict(BLOCKED, p["reason"])
    if len(ran) < 2:
        return _verdict(
            FAIL, f"阶段未全部执行且无已知阻塞（执行器流程缺陷，runId={run_id}）")
    if not usage_ok:
        return _verdict(
            FAIL,
            f"服务端总用量核对失败（本轮 runId={run_id}：登录续交 + 恢复提交应为两次）",
        )
    return _verdict(PASS, f"T1-C 默认存储两阶段验收通过（runId={run_id}）")


def digest_of(path):
    """文件 SHA-256 摘要（缺失或不可读返回 None）。"""
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def phase1_intact(before_digest, after_digest):
    """第二阶段不得覆盖/改写第一阶段结果文件。

    返回 (ok, reason)。
    """
    if before_digest is None:
        return False, "第一阶段结果文件在第二阶段执行前不存在，无法证明未被覆盖"
    if after_digest is None:
        return False, "第一阶段结果文件在第二阶段执行后消失（被覆盖或删除）"
    if before_digest != after_digest:
        return False, "第一阶段结果文件在第二阶段执行后被改写（第二阶段覆盖了第一阶段证据）"
    return True, "第一阶段结果文件未被改写"


def distinct_phase_paths(phase1_path, phase2_path):
    """输入/输出路径必须不同。返回 (ok, reason)。"""
    if phase1_path is None or phase2_path is None:
        return False, "阶段 2 的输入（phase1.json）与输出（phase2.json）路径未显式设置"
    if str(phase1_path) == str(phase2_path):
        return False, f"阶段 2 输入与输出是同一路径：{phase1_path}——禁止覆盖第一阶段证据"
    return True, "阶段 2 输入与输出路径不同"


# ------------------------------------------------------------------ 服务端接收核对

def verify_receipts(items, expected_feedback_ids, expected_username, expected_count):
    """核对服务端真实接收结果（T1-C1）。

    items: 管理接口返回的本轮应用反馈条目（[{id, username, ...}]）。
    expected_feedback_ids: [(phase, feedbackId)]，来自各阶段 acceptance 证据。

    返回 (ok, reason, detail)。要求：条数精确匹配、归属全部为本轮账号、
    两个阶段的 feedbackId 都真实出现且互不相同。证据不足一律失败。
    """
    detail = {"expectedCount": expected_count, "expectedIds": [fid for _, fid in expected_feedback_ids]}
    if not isinstance(items, list):
        return False, f"管理接口反馈列表不是数组（实际 {type(items).__name__}）", detail
    detail["count"] = len(items)
    if len(items) != expected_count:
        return False, f"本轮反馈条数 {len(items)} != 期望 {expected_count}", detail
    owners = []
    ids = []
    for item in items:
        if not isinstance(item, dict):
            return False, f"反馈条目结构非法：{item!r}", detail
        owners.append(item.get("username"))
        ids.append(item.get("id"))
    detail["ids"] = ids
    detail["owners"] = owners
    if any(owner != expected_username for owner in owners):
        return False, f"反馈归属不属于本轮账号（期望 {expected_username!r}，实际 {owners!r}）", detail
    if any(not isinstance(fid, str) or not fid for fid in ids):
        return False, f"存在缺失 id 的反馈条目：{ids!r}", detail
    if len(set(ids)) != len(ids):
        return False, f"反馈 ID 重复：{ids!r}", detail
    wanted = [fid for _, fid in expected_feedback_ids]
    if len(set(wanted)) != len(wanted):
        return False, f"两个阶段报告的 feedbackId 相同（重复 ID 不算两次接收）：{wanted!r}", detail
    missing = [fid for fid in wanted if fid not in ids]
    if missing:
        return False, f"阶段报告的 feedbackId 未出现在服务端列表：{missing!r}", detail
    return True, f"服务端接收核对通过（{expected_count} 条，ID={wanted}）", detail


# ------------------------------------------------------------------ 启动签名证据

SIGNATURE_NOT_COLLECTED = "NOT_COLLECTED"

#: 签名拒绝的可识别标记（小写匹配；只用于把证据归类，不用于猜测）。
SIGNATURE_REJECTION_MARKERS = (
    "taskgated invalid signature",
    "invalid signature",
    "code signature invalid",
    "codesigning",
)


def signature_rejection_markers_in(text):
    """返回命中的签名拒绝标记（空列表 = 未命中）。"""
    lowered = str(text or "").lower()
    return [marker for marker in SIGNATURE_REJECTION_MARKERS if marker in lowered]


#: 签名采集必须全部成功的命令（任一非零退出 / 超时 / 缺结果 / 解析失败都失败）
REQUIRED_SIGNATURE_COMMANDS = ("verify", "details", "entitlements", "uuidCommand")

#: 允许的签名类型；`unknown` 不允许通过。
SIGNATURE_FORMATS = ("adhoc", "authority")

#: `TeamIdentifier` 里表示"没有团队"的写法。
NO_TEAM_VALUES = ("", "not set", "not set.", "none")


def _type_tag(value):
    """JSON 化后的类型标签：布尔与整型必须区分开（Python 里 True == 1）。"""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "real"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "dict"
    if value is None:
        return "null"
    return type(value).__name__


def _bag(items):
    """数组的集合形式（用于顺序无关比较）。"""
    return sorted(json.dumps(item, sort_keys=True, default=str) for item in items)


def compare_entitlement_values(left, right, path=""):
    """比较两份完整 entitlements（键与值），保留类型差异。

    - 字典键顺序忽略；
    - `keychain-access-groups` 按字符串集合比较（顺序变化不误报）；
    - 其他数组保持原顺序；
    - 布尔 / 整数 / 字符串 / 数组等类型不同即视为不同。
    """
    problems = []
    left_tag, right_tag = _type_tag(left), _type_tag(right)
    if left_tag != right_tag:
        return [f"entitlements {path or '<root>'} 值类型不同："
                f"{left_tag} vs {right_tag}（{left!r} vs {right!r}）"]
    if left_tag == "dict":
        for key in sorted(set(left) | set(right)):
            child = f"{path}.{key}" if path else key
            if key not in left:
                problems.append(f"entitlements 缺少键：{child}")
            elif key not in right:
                problems.append(f"entitlements 多出键：{child}")
            else:
                problems.extend(compare_entitlement_values(left[key], right[key], child))
        return problems
    if left_tag == "array":
        leaf = path.rsplit(".", 1)[-1]
        if leaf == "keychain-access-groups":
            if _bag(left) != _bag(right):
                problems.append(
                    f"entitlements Keychain 授权分组集合不同（{path}）：{left!r} vs {right!r}")
            return problems
        if len(left) != len(right):
            problems.append(
                f"entitlements {path} 数组长度不同：{len(left)} vs {len(right)}")
            return problems
        for index, (lv, rv) in enumerate(zip(left, right)):
            problems.extend(compare_entitlement_values(lv, rv, f"{path}[{index}]"))
        return problems
    if left != right:
        problems.append(f"entitlements {path or '<root>'} 值不同：{left!r} vs {right!r}")
    return problems


def _command_problem(evidence, name, label):
    """命令级问题（缺结果 / 超时 / 缺退出码 / 非零退出）。"""
    command = evidence.get(name)
    if not isinstance(command, dict):
        return f"{label}缺少 {name} 命令结果"
    if command.get("timedOut") is True:
        return f"{label}{name} 命令超时"
    code = command.get("exitCode")
    if code is None:
        return f"{label}{name} 命令缺少退出码（未真正执行）"
    if code != 0:
        if name == "verify":
            return (f"{label}静态验证失败（codesign --verify --deep --strict "
                    f"退出码 {code}）")
        return f"{label}{name} 命令退出码非 0（{code}）——输出内容不作数"
    return None


def evaluate_signature_evidence(evidence, phase):
    """判定某一阶段的签名证据是否齐全、采集成功且内部自洽。返回 (ok, reason)。

    - `collected != true` → 未采集（不得用初始构建冒充）；
    - 缺 `parseStatus` / `entitlementValues` 等新必需字段的历史证据 → 失败
      （旧记录可以保留为历史，但不得直接用于新门禁判 PASS）；
    - verify / details / entitlements / UUID 四条命令都必须成功（退出码 0、未超时）；
    - entitlements 必须是 plistlib 解析出来的**字典**（空字典是有效配置）；
    - ad-hoc 明确记录类型且不得虚构签名身份；正式签名必须同时有身份链与有效 Team。
    """
    label = f"阶段 {phase} 签名证据"
    if not isinstance(evidence, dict) or evidence.get("collected") is not True:
        return False, f"{label}未采集"
    parse_status = evidence.get("parseStatus")
    if not isinstance(parse_status, dict):
        return False, f"{label}缺少 parseStatus（历史证据不得用于新门禁）"
    for name in REQUIRED_SIGNATURE_COMMANDS:
        problem = _command_problem(evidence, name, label)
        if problem:
            return False, problem
    for name in REQUIRED_SIGNATURE_COMMANDS:
        status = parse_status.get(name)
        if status != "ok":
            return False, f"{label}{name} 解析状态非 ok：{status!r}"
    if not evidence.get("identifier"):
        return False, f"{label}缺少应用标识（Identifier）"
    if not evidence.get("binaryUuid"):
        return False, f"{label}缺少二进制 UUID"
    if not evidence.get("signatureDigest"):
        return False, f"{label}缺少签名内容摘要"
    values = evidence.get("entitlementValues")
    if not isinstance(values, dict):
        return False, (f"{label}缺少解析后的 entitlements（entitlementValues 必须是字典，"
                       "空输出/损坏 plist 不得当作空字典）")
    fmt = evidence.get("signatureFormat")
    if fmt not in SIGNATURE_FORMATS:
        return False, f"{label}签名类型未知或缺失：{fmt!r}（不允许 unknown）"
    chain = evidence.get("authorityChain")
    if not isinstance(chain, list):
        return False, f"{label}缺少 Authority 身份链字段"
    team = evidence.get("teamIdentifier")
    has_team = isinstance(team, str) and team.strip().lower() not in NO_TEAM_VALUES
    if fmt == "adhoc":
        if chain:
            return False, (f"{label}adhoc 签名不应带 Authority 身份链"
                           f"（{chain[:2]!r}）——不得虚构签名身份")
        if has_team:
            return False, f"{label}adhoc 签名不应带 Team（{team!r}）——不得虚构签名身份"
    else:
        if not chain:
            return False, f"{label}正式签名缺少 Authority 身份链"
        if not has_team:
            return False, f"{label}正式签名缺少有效 Team（{team!r}）"
    return True, (f"{label}齐全：Identifier={evidence.get('identifier')}、"
                  f"类型={fmt}、Team={team!r}、身份链 {len(chain)} 级")


def compare_signature_evidence(evidence1, evidence2):
    """对比两阶段签名证据：应用标识、签名类型、Team、Authority 身份链与完整授权配置。

    二进制 UUID / CDHash / 签名摘要**只作证据**，不要求两次构建相同。
    返回 (ok, problems, detail)。
    """
    detail = {}
    for phase, evidence in (("1", evidence1), ("2", evidence2)):
        ok, reason = evaluate_signature_evidence(evidence, phase)
        if not ok:
            return False, [reason], detail
    detail["identifier"] = [evidence1.get("identifier"), evidence2.get("identifier")]
    detail["teamIdentifier"] = [evidence1.get("teamIdentifier"),
                                evidence2.get("teamIdentifier")]
    detail["signatureFormat"] = [evidence1.get("signatureFormat"),
                                 evidence2.get("signatureFormat")]
    detail["authorityChain"] = [list(evidence1.get("authorityChain") or []),
                                list(evidence2.get("authorityChain") or [])]
    problems = []
    if evidence1.get("identifier") != evidence2.get("identifier"):
        problems.append(f"应用标识不一致：{evidence1.get('identifier')!r} vs "
                        f"{evidence2.get('identifier')!r}")
    if evidence1.get("signatureFormat") != evidence2.get("signatureFormat"):
        problems.append(f"签名类型不一致：{evidence1.get('signatureFormat')!r} vs "
                        f"{evidence2.get('signatureFormat')!r}")
    if evidence1.get("teamIdentifier") != evidence2.get("teamIdentifier"):
        problems.append(f"签名 Team 不一致：{evidence1.get('teamIdentifier')!r} vs "
                        f"{evidence2.get('teamIdentifier')!r}")
    if detail["authorityChain"][0] != detail["authorityChain"][1]:
        problems.append(f"签名 Authority 身份链不一致：{detail['authorityChain'][0]!r} vs "
                        f"{detail['authorityChain'][1]!r}")
    diff = compare_entitlement_values(evidence1.get("entitlementValues"),
                                      evidence2.get("entitlementValues"))
    detail["entitlementDiff"] = diff
    problems.extend(diff)
    if problems:
        return False, problems, detail
    return True, [], detail


def keychain_entitlements(source):
    """挑出与 Keychain / 安全存储相关的授权。

    传入字典时返回 {键: 值}（保留值，供报告与比较使用）；传入键列表时返回排序后的键
    （兼容既有调用）。
    """
    if isinstance(source, dict):
        return {k: v for k, v in sorted(source.items()) if "keychain" in k.lower()}
    return sorted(k for k in source if "keychain" in k.lower())



# ------------------------------------------------------------------ 启动失败分类

LAUNCH_VERIFIED = "verified"
LAUNCH_SIGNATURE_INVALID = "launch_signature_invalid"
LAUNCH_FAILED = "launch_failed"
LAUNCH_NOT_ATTEMPTED = "not_attempted"


def _evidence_matches(record, artifact_path, round_pids, window_start, window_end):
    """证据是否属于本轮：PID 命中本轮进程，或落在本阶段窗口内且指向本轮产物。"""
    pid = record.get("pid")
    if isinstance(pid, int) and pid in set(round_pids or ()):
        return True
    stamp = record.get("timestamp")
    if not isinstance(stamp, (int, float)):
        return False
    if window_start is None or window_end is None:
        return False
    if not (window_start - 1 <= stamp <= window_end + 1):
        return False
    path = record.get("artifactPath")
    if not path or not artifact_path:
        return True
    return path == artifact_path or artifact_path in path


def classify_launch(*, ran, handshake_pid=None, exit_code=None, timed_out=False,
                    evidence=None, artifact_path=None, round_pids=(),
                    window_start=None, window_end=None):
    """T1-C4 启动失败分类（纯函数）。

    只接受与本轮 PID、或本阶段时间窗 + 本轮产物路径匹配的证据；
    历史崩溃报告（时间/产物不匹配）一律记入 `ignored`，不能证明当前失败。
    """
    matched_rejection, other, ignored = [], [], []
    for record in evidence or ():
        record = dict(record)
        if not _evidence_matches(record, artifact_path, round_pids, window_start, window_end):
            ignored.append(record)
            continue
        if signature_rejection_markers_in(record.get("message")):
            matched_rejection.append(record)
        else:
            other.append(record)

    out = {"matched": matched_rejection, "other": other, "ignored": ignored}
    if not ran:
        out.update(kind=LAUNCH_NOT_ATTEMPTED, reason="本阶段未启动应用（无启动证据）")
        return out
    if handshake_pid:
        out.update(
            kind=LAUNCH_VERIFIED,
            reason=f"应用已启动并产生本轮结构化握手（pid={handshake_pid}）",
            handshakePid=handshake_pid,
        )
        return out
    if matched_rejection:
        out.update(
            kind=LAUNCH_SIGNATURE_INVALID,
            reason=(
                "有匹配本轮 PID／时间窗与产物的签名拒绝证据（"
                + "；".join(str(r.get("message"))[:120] for r in matched_rejection[:3])
                + "）——判 launch_signature_invalid"
            ),
        )
        return out
    if timed_out:
        out.update(
            kind=LAUNCH_FAILED,
            reason="启动阶段超时且无本轮握手、无匹配的签名拒绝证据"
                   "——按实际启动失败/超时记录，不猜测为签名问题",
        )
        return out
    out.update(
        kind=LAUNCH_FAILED,
        reason=f"未获得本轮握手且无匹配的签名拒绝证据（进程退出码 {exit_code}）"
               "——按实际启动失败记录，不归为签名问题",
    )
    return out
