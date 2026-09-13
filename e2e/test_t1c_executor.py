#!/usr/bin/env python3
"""T1-C 统一验收执行器测试。

分两层：

1. 纯判定层（`t1c_executor_lib`）：阶段契约、真实接收、签名证据、启动分类、
   服务端接收核对。
2. `ExecutorFlowTests` / `InterruptionTests` / `LaunchSignatureTests` /
   `SignatureGateTests` —— **直接调用真实执行器流程**（`Executor.run()`），
   只替换进程启动、服务通信、专用服务生命周期、签名命令与诊断报告目录：
     - 模拟阶段必须读取执行器实际生成的 `--dart-define-from-file` 参数文件，
       并向参数里写明的 `T1C_RESULT_FILE` / `T1C_HANDSHAKE_FILE` 写结果，
       不替执行器修正路径或状态；
     - 管理接口为内存实现，并模拟「应用未登记即登录 → 404 unknown_app」的
       真实服务端行为；
     - 绝不使用真实用户 Keychain / 真实主目录 / 真实 8787 服务 / 真实签名命令。

运行：`python3 -m unittest e2e.test_t1c_executor -v`
"""
import base64
import fcntl
import json
import os
import plistlib
import shutil
import signal
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from t1c_executor_lib import (  # noqa: E402
    BLOCKED,
    EXIT_BLOCKED,
    EXIT_FAIL,
    EXIT_PASS,
    FAIL,
    LAUNCH_FAILED,
    LAUNCH_NOT_ATTEMPTED,
    LAUNCH_SIGNATURE_INVALID,
    LAUNCH_VERIFIED,
    NOT_RUN,
    PASS,
    acceptance_problems,
    classify_launch,
    compare_signature_evidence,
    decide_overall,
    distinct_phase_paths,
    evaluate_cleanup,
    evaluate_phase,
    evaluate_signature_evidence,
    keychain_entitlements,
    phase1_intact,
    signature_rejection_markers_in,
    verify_receipts,
)

import run_t1c_default_storage as ex  # noqa: E402

RUN = "run-x"
IDENT = {"appId": "t1c-run-x", "username": "t1c-run-x"}
PASS_CHECKS_1 = ("probe", "tokenPersisted", "acceptance")
PASS_CHECKS_2 = ("phase1Record", "probe", "tokenRestored",
                 "identityRestored", "acceptance", "cleanup")


def checks(names, verdict=PASS):
    return [{"name": n, "verdict": verdict, "reason": ""} for n in names]


def acc(status=201, fid="fb-1", replayed=False):
    return {"httpStatus": status, "feedbackId": fid, "replayed": replayed}


DEFAULT_ENTITLEMENTS = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.get-task-allow": True,
    "com.apple.security.network.client": True,
    "keychain-access-groups": ["TEAM.groupA"],
}


# ------------------------------------------------------------------ 纯判定

def phase1_body(verdict=PASS, run_id=RUN, cleanup=None, acceptance=None, **extra):
    body = {
        "runId": run_id, "phase": "1", "verdict": verdict, "reason": "r",
        "identity": dict(IDENT), "checks": checks(PASS_CHECKS_1),
        "acceptance": acc() if acceptance is None else acceptance,
        # PASS 时令牌按设计保留给阶段 2：tokenCleared=false 是显式证据而非缺失
        "cleanup": ({"probeCleared": True, "tokenCleared": False}
                    if cleanup is None else cleanup),
    }
    body.update(extra)
    return body


def phase2_body(verdict=PASS, run_id=RUN, cleanup=None, check_list=None,
                acceptance=None, **extra):
    body = {
        "runId": run_id, "phase": "2", "verdict": verdict, "reason": "r",
        "identity": dict(IDENT),
        "checks": check_list if check_list is not None else checks(PASS_CHECKS_2),
        "acceptance": acc(fid="fb-2") if acceptance is None else acceptance,
        "cleanup": ({"tokenCleared": True, "probeCleared": True}
                    if cleanup is None else cleanup),
    }
    body.update(extra)
    return body


class EvaluatePhaseTests(unittest.TestCase):
    def test_pass_requires_identity_match(self):
        self.assertEqual(evaluate_phase(0, phase1_body(), RUN, "1", IDENT)["verdict"], PASS)

    def test_app_id_mismatch_is_fail(self):
        body = phase1_body()
        body["identity"] = {"appId": "other", "username": IDENT["username"]}
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("identity.appId", r["reason"])

    def test_username_mismatch_is_fail(self):
        body = phase1_body()
        body["identity"] = {"appId": IDENT["appId"], "username": "other"}
        self.assertEqual(evaluate_phase(0, body, RUN, "1", IDENT)["verdict"], FAIL)

    def test_phase_mismatch_is_fail(self):
        r = evaluate_phase(0, phase2_body(), RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("phase 不匹配", r["reason"])

    def test_run_id_mismatch_is_fail(self):
        r = evaluate_phase(0, phase2_body(run_id="run-OTHER"), RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("不读取其他测试身份", r["reason"])

    def test_result_must_be_json_object(self):
        for bad in ([], "PASS", 3, True):
            with self.subTest(bad=bad):
                r = evaluate_phase(0, bad, RUN, "1", IDENT)
                self.assertEqual(r["verdict"], FAIL)
                self.assertIn("不是 JSON 对象", r["reason"])

    def test_missing_result_file_is_fail(self):
        r = evaluate_phase(0, None, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("缺失或不可解析", r["reason"])

    def test_lowercase_verdict_is_not_accepted(self):
        r = evaluate_phase(0, phase1_body(verdict="blocked"), RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("契约只允许", r["reason"])

    def test_skip_with_exit0_is_not_pass(self):
        self.assertEqual(
            evaluate_phase(0, phase1_body(verdict="skip"), RUN, "1", IDENT)["verdict"], FAIL)

    def test_pass_requires_exit0(self):
        self.assertEqual(
            evaluate_phase(1, phase1_body(), RUN, "1", IDENT)["verdict"], FAIL)

    # ---- 真实接收（T1-C1）----
    def test_acceptance_reject_is_fail(self):
        r = evaluate_phase(0, phase1_body(acceptance=acc(status=400, fid=None)),
                           RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("httpStatus", r["reason"])

    def test_acceptance_replayed_is_fail(self):
        r = evaluate_phase(0, phase1_body(acceptance=acc(status=200, replayed=True)),
                           RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("replayed", r["reason"])

    def test_acceptance_missing_id_is_fail(self):
        r = evaluate_phase(0, phase1_body(acceptance=acc(fid="")), RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("feedbackId", r["reason"])

    def test_acceptance_absent_is_fail(self):
        body = phase1_body()
        body.pop("acceptance")
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("acceptance", r["reason"])

    def test_acceptance_must_be_non_replay_boolean(self):
        r = evaluate_phase(0, phase1_body(acceptance=acc(replayed="false")),
                           RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)

    def test_acceptance_problems_helper(self):
        self.assertEqual(acceptance_problems({"acceptance": acc()}), [])
        self.assertTrue(acceptance_problems({}))
        self.assertTrue(acceptance_problems({"acceptance": acc(status=201, replayed=True)}))

    # ---- 检查项与清理 ----
    def test_missing_required_check_is_fail(self):
        body = phase1_body()
        body["checks"] = [c for c in body["checks"] if c["name"] != "tokenPersisted"]
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("tokenPersisted", r["reason"])

    def test_required_check_not_pass_is_fail(self):
        body = phase1_body()
        body["checks"][0]["verdict"] = FAIL
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("probe", r["reason"])

    def test_extra_failing_check_cannot_pass(self):
        body = phase1_body()
        body["checks"].append({"name": "extra", "verdict": FAIL, "reason": "boom"})
        self.assertEqual(evaluate_phase(0, body, RUN, "1", IDENT)["verdict"], FAIL)

    def test_checks_shape_invalid_is_fail(self):
        body = phase1_body()
        body["checks"] = "not-a-list"
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("checks", r["reason"])

    def test_phase2_missing_cleanup_field_is_fail(self):
        r = evaluate_phase(0, phase2_body(cleanup={"tokenCleared": True}), RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("probeCleared", r["reason"])

    def test_phase2_cleanup_wrong_type_is_fail(self):
        r = evaluate_phase(0, phase2_body(
            cleanup={"tokenCleared": "true", "probeCleared": True}), RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("类型非法", r["reason"])

    def test_phase2_cleanup_false_is_fail(self):
        r = evaluate_phase(0, phase2_body(
            cleanup={"tokenCleared": False, "probeCleared": True}), RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("tokenCleared", r["reason"])

    def test_phase1_requires_probe_cleared(self):
        r = evaluate_phase(0, phase1_body(
            cleanup={"probeCleared": False, "tokenCleared": False}), RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("probeCleared", r["reason"])

    def test_phase1_requires_token_cleared_evidence(self):
        r = evaluate_phase(0, phase1_body(cleanup={"probeCleared": True}),
                           RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("tokenCleared", r["reason"])

    def test_phase1_token_cleared_true_also_ok_for_pass(self):
        r = evaluate_phase(0, phase1_body(
            cleanup={"probeCleared": True, "tokenCleared": True}), RUN, "1", IDENT)
        self.assertEqual(r["verdict"], PASS)

    # ---- 阻塞 ----
    def test_blocked_with_recognized_cause_and_cleanup(self):
        body = phase1_body(verdict=BLOCKED, blockedCause="missing-entitlement",
                           reason="-34018 errSecMissingEntitlement",
                           cleanup={"probeCleared": True, "tokenCleared": True},
                           checks=[{"name": "probe", "verdict": BLOCKED, "reason": "-34018"}])
        self.assertEqual(evaluate_phase(0, body, RUN, "1", IDENT)["verdict"], BLOCKED)

    def test_blocked_unknown_cause_is_fail(self):
        body = phase1_body(verdict=BLOCKED, blockedCause="something-else",
                           cleanup={"probeCleared": True, "tokenCleared": True})
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("未知错误不能转为 BLOCKED", r["reason"])

    def test_blocked_without_token_evidence_is_fail(self):
        body = phase1_body(verdict=BLOCKED, blockedCause="missing-entitlement",
                           cleanup={"probeCleared": True, "tokenCleared": False})
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("tokenCleared", r["reason"])

    def test_blocked_nonzero_exit_is_fail(self):
        body = phase1_body(verdict=BLOCKED, blockedCause="missing-entitlement",
                           cleanup={"probeCleared": True, "tokenCleared": True})
        self.assertEqual(evaluate_phase(1, body, RUN, "1", IDENT)["verdict"], FAIL)

    def test_blocked_with_cleanup_failure_is_fail(self):
        body = phase1_body(
            verdict=BLOCKED, blockedCause="missing-entitlement",
            reason="平台安全存储错误：-34018 errSecMissingEntitlement",
            cleanupError="clear 失败：-34018",
            cleanup={"probeCleared": False, "tokenCleared": True},
            checks=[{"name": "probe", "verdict": BLOCKED, "reason": "-34018"}])
        r = evaluate_phase(0, body, RUN, "1", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("清理失败", r["reason"])
        self.assertIn("errSecMissingEntitlement", r["reason"])
        self.assertIn("clear 失败", r["reason"])

    def test_cleanup_error_overrides_pass(self):
        body = phase2_body()
        body["cleanupError"] = "delete 抛错"
        r = evaluate_phase(0, body, RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("delete 抛错", r["reason"])

    def test_restore_token_lost_is_fail(self):
        check_list = checks([n for n in PASS_CHECKS_2 if n != "tokenRestored"])
        check_list.append({"name": "tokenRestored", "verdict": FAIL,
                           "reason": "重启后凭据丢失"})
        body = phase2_body(verdict=FAIL, check_list=check_list,
                           reason="重启后凭据丢失：第一阶段成功记录有效，但默认安全存储中读不到令牌")
        r = evaluate_phase(1, body, RUN, "2", IDENT)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("重启后凭据丢失", r["reason"])

    def test_phase1_intact_detects_overwrite(self):
        ok, reason = phase1_intact("aaa", "bbb")
        self.assertFalse(ok)
        self.assertIn("覆盖", reason)
        self.assertTrue(phase1_intact("aaa", "aaa")[0])
        self.assertFalse(phase1_intact(None, "bbb")[0])

    def test_distinct_phase_paths(self):
        self.assertTrue(distinct_phase_paths("/a/phase1.json", "/a/phase2.json")[0])
        self.assertFalse(distinct_phase_paths("/a/phase1.json", "/a/phase1.json")[0])
        self.assertFalse(distinct_phase_paths(None, "/a/phase2.json")[0])


class DecideOverallTests(unittest.TestCase):
    def test_all_pass(self):
        self.assertEqual(
            decide_overall(phase1_body(), phase2_body(), True, RUN)["verdict"], PASS)

    def test_cleanup_not_ok_beats_blocked(self):
        r = decide_overall({"verdict": BLOCKED, "reason": "已知阻塞"},
                           {"verdict": NOT_RUN, "reason": "未执行"}, False, RUN,
                           cleanup_ok=False)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("清理未完成", r["reason"])

    def test_blocked_when_cleanup_ok(self):
        r = decide_overall({"verdict": BLOCKED, "reason": "已知阻塞 -34018"},
                           {"verdict": NOT_RUN, "reason": "未执行"}, False, RUN)
        self.assertEqual(r["verdict"], BLOCKED)

    def test_not_run_without_blocked_is_executor_defect(self):
        r = decide_overall({"verdict": PASS, "reason": "ok"},
                           {"verdict": NOT_RUN, "reason": "未执行"}, False, RUN)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("流程缺陷", r["reason"])

    def test_usage_mismatch_is_fail(self):
        r = decide_overall(phase1_body(), phase2_body(), False, RUN)
        self.assertEqual(r["verdict"], FAIL)
        self.assertIn("总用量", r["reason"])


class ReceiptVerificationTests(unittest.TestCase):
    def item(self, ident, owner=IDENT["username"]):
        return {"id": ident, "username": owner, "appId": IDENT["appId"]}

    def test_ok(self):
        ok, reason, detail = verify_receipts(
            [self.item("a"), self.item("b")], [("1", "a"), ("2", "b")],
            IDENT["username"], 2)
        self.assertTrue(ok, reason)
        self.assertEqual(detail["count"], 2)

    def test_count_mismatch(self):
        ok, reason, _ = verify_receipts([self.item("a")], [("1", "a")],
                                        IDENT["username"], 2)
        self.assertFalse(ok)
        self.assertIn("条数", reason)

    def test_wrong_owner(self):
        ok, reason, _ = verify_receipts(
            [self.item("a", owner="someone-else")], [("1", "a")],
            IDENT["username"], 1)
        self.assertFalse(ok)
        self.assertIn("归属", reason)

    def test_duplicate_ids(self):
        ok, reason, _ = verify_receipts(
            [self.item("a")], [("1", "a"), ("2", "a")], IDENT["username"], 1)
        self.assertFalse(ok)
        self.assertIn("重复", reason)

    def test_expected_id_missing_from_server(self):
        ok, reason, _ = verify_receipts([self.item("a")], [("1", "zzz")],
                                        IDENT["username"], 1)
        self.assertFalse(ok)
        self.assertIn("未出现", reason)

    def test_non_list_is_failure(self):
        ok, reason, _ = verify_receipts(None, [], IDENT["username"], 0)
        self.assertFalse(ok)
        self.assertIn("不是数组", reason)


class SignatureEvidenceTests(unittest.TestCase):
    """第 10 轮遗留的判定用例：夹具升级为第 11 轮证据形状。"""

    def evidence(self, **overrides):
        ev = sig_evidence()
        ev.update(overrides)
        return ev

    def test_complete_evidence_ok(self):
        self.assertTrue(evaluate_signature_evidence(self.evidence(), "1")[0])

    def test_not_collected_is_failure(self):
        ok, reason = evaluate_signature_evidence(
            {"collected": False, "reason": "阶段 2 未执行"}, "2")
        self.assertFalse(ok)
        self.assertIn("未采集", reason)

    def test_static_verify_failure(self):
        ok, reason = evaluate_signature_evidence(
            self.evidence(verify={"exitCode": 1}), "1")
        self.assertFalse(ok)
        self.assertIn("静态验证失败", reason)

    def test_missing_uuid_or_digest(self):
        self.assertFalse(evaluate_signature_evidence(self.evidence(binaryUuid=""), "1")[0])
        self.assertFalse(evaluate_signature_evidence(self.evidence(signatureDigest=""), "1")[0])

    def test_compare_ignores_binary_hash_but_checks_config(self):
        a = self.evidence()
        b = self.evidence(binaryUuid="OTHER", signatureDigest="cafe")
        ok, problems, _ = compare_signature_evidence(a, b)
        self.assertTrue(ok, problems)

    def test_compare_detects_team_and_entitlement_difference(self):
        ok, problems, _ = compare_signature_evidence(
            self.evidence(), self.evidence(teamIdentifier="TEAM123"))
        self.assertFalse(ok)
        self.assertTrue(any("Team" in p for p in problems))
        ok2, problems2, _ = compare_signature_evidence(
            self.evidence(entitlementValues={"keychain-access-groups": ["TEAM.a"]}),
            self.evidence(entitlementValues={"keychain-access-groups": ["TEAM.b"]}))
        self.assertFalse(ok2)
        self.assertTrue(any("Keychain" in p for p in problems2))

    def test_compare_requires_both_collected(self):
        ok, problems, _ = compare_signature_evidence(
            self.evidence(), {"collected": False})
        self.assertFalse(ok)
        self.assertTrue(problems)

    def test_keychain_entitlements_filter(self):
        self.assertEqual(keychain_entitlements(
            ["com.apple.security.app-sandbox", "keychain-access-groups"]),
            ["keychain-access-groups"])


class LaunchClassificationTests(unittest.TestCase):
    ARTIFACT = "/repo/examples/flutter/build/macos/Build/Products/Debug/feedback_example.app"

    def test_handshake_is_verified_launch(self):
        r = classify_launch(ran=True, handshake_pid=1234, exit_code=0,
                            artifact_path=self.ARTIFACT)
        self.assertEqual(r["kind"], LAUNCH_VERIFIED)

    def test_matching_rejection_is_signature_invalid(self):
        r = classify_launch(
            ran=True, exit_code=1,
            evidence=[{"source": "diagnostic-report",
                       "message": "CODESIGNING Taskgated Invalid Signature（signal=SIGKILL）",
                       "pid": 999, "timestamp": 1000.0,
                       "artifactPath": f"{self.ARTIFACT}/Contents/MacOS/feedback_example"}],
            artifact_path=self.ARTIFACT, window_start=990.0, window_end=1010.0)
        self.assertEqual(r["kind"], LAUNCH_SIGNATURE_INVALID)

    def test_old_report_outside_window_is_ignored(self):
        r = classify_launch(
            ran=True, exit_code=1,
            evidence=[{"source": "diagnostic-report",
                       "message": "CODESIGNING Taskgated Invalid Signature",
                       "pid": 999, "timestamp": 100.0,
                       "artifactPath": f"{self.ARTIFACT}/Contents/MacOS/feedback_example"}],
            artifact_path=self.ARTIFACT, window_start=990.0, window_end=1010.0)
        self.assertEqual(r["kind"], LAUNCH_FAILED)
        self.assertEqual(len(r["ignored"]), 1)
        self.assertIn("不归为签名问题", r["reason"])

    def test_pid_match_counts_even_without_timestamp(self):
        r = classify_launch(
            ran=True, exit_code=None, timed_out=True,
            evidence=[{"source": "system-log",
                       "message": "Taskgated Invalid Signature", "pid": 4242}],
            artifact_path=self.ARTIFACT, round_pids=[4242],
            window_start=990.0, window_end=1010.0)
        self.assertEqual(r["kind"], LAUNCH_SIGNATURE_INVALID)

    def test_timeout_without_evidence_is_not_signature(self):
        r = classify_launch(ran=True, exit_code=None, timed_out=True,
                            artifact_path=self.ARTIFACT,
                            window_start=1.0, window_end=2.0)
        self.assertEqual(r["kind"], LAUNCH_FAILED)
        self.assertIn("不猜测为签名问题", r["reason"])

    def test_not_ran(self):
        self.assertEqual(classify_launch(ran=False)["kind"], LAUNCH_NOT_ATTEMPTED)

    def test_rejection_markers(self):
        self.assertTrue(signature_rejection_markers_in("Taskgated Invalid Signature"))
        self.assertTrue(signature_rejection_markers_in("killed: CODESIGNING"))
        self.assertFalse(signature_rejection_markers_in("Lost connection to device"))


# ------------------------------------------------------------------ 执行器全路径
#
# 外部边界替换：
#   - FakeProcs        ：进程启动/等待/核实/终止（只按 pid/pgid 操作，不枚举系统进程）
#   - InMemoryApi      ：服务通信（含"应用未登记不能登录"的真实行为）
#   - FakeService      ：专用服务生命周期
#   - cmd_runner       ：签名检查命令（假实现，不碰真实产物）
#   - diagnostic_dirs  ：诊断报告目录（临时目录，不读真实历史报告）
# 其余全部是真实执行器代码路径。

class InMemoryApi:
    """替换服务通信；实现执行器用到的全部管理接口。"""

    def __init__(self, world=None):
        self.world = world
        self.registered = {}
        self.users = {}
        self.feedback_items = []
        self.login_calls = []
        self.disable_calls = []
        self.register_noop = False
        self.fail_disable = False
        self.fail_feedback_list = False
        self.usage_override = None

    # ---- 管理接口（执行器直接使用） ----
    def login(self, username, password):
        if not username or not password:
            raise AssertionError("管理登录必须使用运行时随机凭据")
        return 200, {"ok": True}

    def create_app(self, app_id, name, allowed_origins):
        payload = {"appId": app_id, "name": name, "allowedOrigins": list(allowed_origins),
                   "kaneoProjectId": "", "kaneoColumnSlug": ""}
        if self.register_noop:
            return 201, payload
        self.registered[app_id] = {"id": f"app-{len(self.registered) + 1}", **payload}
        return 201, dict(self.registered[app_id])

    def list_apps(self):
        return 200, {"apps": [dict(v) for v in self.registered.values()]}

    def create_user(self, username, password, daily_limit):
        self.users[username] = {"id": f"user-{len(self.users) + 1}", "username": username,
                                "password": password, "enabled": True,
                                "dailyLimit": daily_limit, "used": 0}
        return 201, self._public(self.users[username])

    def list_users(self):
        users = [self._public(u) for u in self.users.values()]
        if self.usage_override is not None:
            for u in users:
                u["used"] = self.usage_override
        return 200, {"users": users}

    def set_enabled(self, user_id, enabled):
        self.disable_calls.append((user_id, enabled))
        if self.world is not None:
            self.world.event("account_disable")
        if self.fail_disable:
            return 500, {"error": "disable failed"}
        for u in self.users.values():
            if u["id"] == user_id:
                u["enabled"] = enabled
                return 200, self._public(u)
        return 404, {"error": "not_found"}

    def list_feedback(self, app_id, limit=50):
        if self.fail_feedback_list:
            return 500, {"error": "boom"}
        return 200, {"items": [i for i in self.feedback_items if i["appId"] == app_id]}

    @staticmethod
    def _public(user):
        return {k: v for k, v in user.items() if k != "password"}

    # ---- 阶段侧行为（模拟 Flutter 客户端） ----
    def client_login(self, app_id, username, password):
        self.login_calls.append({"appId": app_id, "appRegistered": app_id in self.registered})
        if app_id not in self.registered:
            return 404, {"error": "unknown_app"}       # 与真实服务端一致
        user = self.users.get(username)
        if user is None or user["password"] != password:
            return 401, {"error": "invalid_credentials"}
        return 200, {"ok": True, "token": "fake-token"}

    def submit(self, app_id, username):
        if app_id not in self.registered:
            return 404, {"error": "unknown_app"}
        ident = f"fb-{len(self.feedback_items) + 1}"
        self.feedback_items.append({"id": ident, "appId": app_id,
                                    "username": username, "status": "received"})
        self.users[username]["used"] += 1
        return 201, {"feedbackId": ident, "status": "received"}

    def submit_as(self, app_id, owner):
        ident = f"fb-{len(self.feedback_items) + 1}"
        self.feedback_items.append({"id": ident, "appId": app_id,
                                    "username": owner, "status": "received"})
        return 201, {"feedbackId": ident, "status": "received"}


class FakeProcs:
    """替换进程边界；只按 pid/pgid 操作，从不枚举系统进程。"""

    def __init__(self, world=None):
        self.world = world
        self._next = 5000
        self.handles = []
        self.alive_pids = set()
        self.describe_map = {}
        self.group_pids = {}
        self.killed = []
        self.group_signals = []
        self.spawn_hook = None
        self.closed = []

    def spawn(self, cmd, cwd, log_path, env=None):
        self._next += 1
        handle = ex.ProcHandle(pid=self._next, pgid=self._next,
                               cmd=tuple(cmd), log_path=Path(log_path))
        self.handles.append(handle)
        self.alive_pids.add(handle.pid)
        self.group_pids[handle.pgid] = {handle.pid}
        return handle

    def wait(self, handle, timeout):
        code, timed_out = (0, False) if self.spawn_hook is None else self.spawn_hook(handle)
        if not timed_out:
            self.alive_pids.discard(handle.pid)
        return code, timed_out

    def poll(self, handle):
        return None if handle.pid in self.alive_pids else 0

    def close(self, handle):
        self.closed.append(handle.pid)

    def alive(self, pid):
        return pid in self.alive_pids

    def group_alive(self, pgid):
        return any(p in self.alive_pids for p in self.group_pids.get(pgid, ()))

    def signal_group(self, pgid, sig):
        self.group_signals.append((pgid, sig))
        if self.world is not None:
            self.world.event(f"signal_group:{pgid}:{sig}")
        if sig == signal.SIGKILL:
            for pid in self.group_pids.get(pgid, ()):
                self.alive_pids.discard(pid)

    def kill(self, pid, sig):
        self.killed.append((pid, sig))
        if self.world is not None:
            self.world.event(f"kill:{pid}:{sig}")
        if sig == signal.SIGKILL:
            self.alive_pids.discard(pid)

    def describe(self, pid):
        info = self.describe_map.get(pid)
        return dict(info) if info else None

    def register_app_pid(self, pid, *, alive, uid, exe, started_at):
        self.describe_map[pid] = {"uid": uid, "exe": exe, "startedAt": started_at}
        if alive:
            self.alive_pids.add(pid)
        else:
            self.alive_pids.discard(pid)


class FakeClock:
    def __init__(self):
        self.t = 1_700_000_000.0

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += max(float(seconds), 0.001)


class FakeService:
    """替换专用服务生命周期。"""

    def __init__(self, *, run_dir, procs, world):
        self.run_dir = Path(run_dir)
        self.procs = procs
        self.world = world
        self.port = world.next_port()
        self.data_dir = self.run_dir / "service-data"
        self.log_path = self.run_dir / "service.log"
        self.handle = None

    def start(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.handle = self.procs.spawn(["node", "--import", "tsx", "src/index.ts"],
                                       cwd=self.run_dir, log_path=self.log_path, env={})
        return {"host": "127.0.0.1", "port": self.port, "pid": self.handle.pid,
                "pgid": self.handle.pgid, "dataDir": str(self.data_dir),
                "log": str(self.log_path), "adminUser": "admin-round",
                "adminPassword": "round-secret"}

    def stop(self):
        self.world.event("service_stop")
        self.procs.alive_pids.discard(self.handle.pid)
        return True


def kind_of(cmd):
    cmd = [str(c) for c in cmd]
    if "--version" in cmd:
        return "version"
    if "build" in cmd:
        return "build"
    joined = " ".join(cmd)
    if "t1c_secure_storage_write_test.dart" in joined:
        return "1"
    if "t1c_secure_storage_recovery_test.dart" in joined:
        return "2"
    if "t1c_secure_storage_cleanup_test.dart" in joined:
        return "cleanup"
    return "unknown"


class Harness:
    """把全部外部边界替换成可控实现，其余走真实执行器。"""

    def __init__(self, tmp: Path, *, behavior=None):
        self.tmp = Path(tmp).resolve()
        self.runs_root = self.tmp / "runs"
        self.container_root = self.tmp / "containers"
        self.server_dir = self.tmp / "server"
        self.examples_dir = self.tmp / "examples" / "flutter"
        self.diagnostic_dir = self.tmp / "diagnostic-reports"
        for path in (self.server_dir, self.diagnostic_dir):
            path.mkdir(parents=True, exist_ok=True)
        # 假的本轮构建产物（签名证据采集指向它，不碰真实 app）
        self.app_bundle = (self.examples_dir / "build" / "macos" / "Build" /
                           "Products" / "Debug" / "feedback_example.app")
        self.app_exe = self.app_bundle / "Contents" / "MacOS" / "feedback_example"
        self.app_exe.parent.mkdir(parents=True, exist_ok=True)
        self.app_exe.write_text("#!/bin/sh\nexit 0\n")

        self.events: list[str] = []
        self.api = InMemoryApi(self)
        self.procs = FakeProcs(self)
        self.clock = FakeClock()
        self.services = []
        self._port = 54000
        self.token_written = False
        self.phase_params = {}
        self.ran = []
        self.build_exit = 0
        self.shared_feedback_id = None
        self.verify_exit = {"baseline": 0, "1": 0, "2": 0}
        self.details_overrides = {}
        self.entitlements_overrides = {}
        self.details_fields = {}          # key -> {"Signature","TeamIdentifier","Authority"}
        self.entitlement_dicts = {}       # key -> plist 字典（覆盖默认授权）
        self.cmd_overrides = {}           # (key, kind) -> _cmd 关键字
        self.uuid_overrides = {}          # key -> dwarfdump stdout
        self.signature_calls = []
        self.behavior = {
            "noop_register": False,
            "build": "ok",              # ok | fail | timeout
            "phase1": "pass",
            "phase2": "pass",
            "cleanup": "pass",          # pass | fail
            "handshake": True,
            "app_alive_after_phase": False,
            "app_identity_ok": True,
            "disable": "ok",            # ok | fail
            "interrupt": None,          # None | "build" | "1" | "2"
            "feedback_list": "ok",      # ok | fail
            "usage": None,              # 覆盖服务端用量
            "stuck_app_pid": None,      # 收尾时仍存活且身份无法核实的应用 PID
        }
        if behavior:
            self.behavior.update(behavior)
        self.api.register_noop = self.behavior["noop_register"]
        self.api.fail_disable = self.behavior["disable"] == "fail"
        self.api.fail_feedback_list = self.behavior["feedback_list"] == "fail"
        self.api.usage_override = self.behavior["usage"]
        self.procs.spawn_hook = self._on_wait
        # 预先存在的示例进程：执行器不得终止它
        self.preexisting_pid = 4242
        self.procs.alive_pids.add(self.preexisting_pid)
        self.procs.group_pids[4242] = {self.preexisting_pid}
        self.procs.describe_map[self.preexisting_pid] = {
            "uid": os.getuid(),
            "exe": str(self.examples_dir / "build/macos/preexisting.app/Contents/MacOS/x"),
            "startedAt": self.clock() - 3600,
        }
        stuck = self.behavior.get("stuck_app_pid")
        if stuck:
            self.procs.alive_pids.add(stuck)
            self.procs.describe_map[stuck] = {
                "uid": os.getuid() + 1, "exe": str(self.app_exe),
                "startedAt": self.clock(),
            }

    # ---- 基础设施 ----
    def event(self, name):
        self.events.append(name)

    def next_port(self):
        self._port += 1
        return self._port

    def service_factory(self, *, run_dir, procs):
        svc = FakeService(run_dir=run_dir, procs=procs, world=self)
        self.services.append(svc)
        return svc

    # ---- 签名检查命令（假实现）：按 (阶段, 命令种类) 返回结构化结果 ----
    CMD_KINDS = ("verify", "details", "entitlements", "uuidCommand")

    def cmd_kind(self, argv):
        joined = " ".join(str(a) for a in argv)
        if argv[0] == "codesign" and "--verify" in joined:
            return "verify"
        if argv[0] == "codesign" and "-dv" in argv:
            return "details"
        if argv[0] == "codesign" and "--entitlements" in argv:
            return "entitlements"
        if argv[0] == "dwarfdump":
            return "uuidCommand"
        raise AssertionError(f"未预期的签名命令：{argv}")

    def cmd_runner(self, argv, key):
        self.signature_calls.append((key, [str(a) for a in argv]))
        kind = self.cmd_kind(argv)
        override = self.cmd_overrides.get((key, kind))
        if override is not None:
            return self._cmd(argv, **override)
        # 与真实 codesign 一致的输出流：-dv 走 stderr，entitlements/uuid 走 stdout
        if kind == "verify":
            return self._cmd(argv, exitCode=self.verify_exit.get(key, 0),
                             stderr="valid on disk")
        if kind == "details":
            return self._cmd(argv, stderr=self.details_overrides.get(
                key, self._details_text(key)))
        if kind == "entitlements":
            return self._cmd(argv, stdout=self.entitlements_overrides.get(
                key, self._entitlements_text(key)))
        return self._cmd(
            argv, stdout=self.uuid_overrides.get(
                key, "UUID: D0D27D81-5CAE-3644-BAC8-CC455A1D4CC6 (arm64) x"))

    @staticmethod
    def _cmd(argv, exitCode=0, stdout="", stderr="", timedOut=False):
        combined = stdout
        if stderr:
            combined = f"{combined}\n{stderr}" if combined else stderr
        return {"command": [str(a) for a in argv], "exitCode": exitCode,
                "stdout": stdout, "stderr": stderr, "output": combined,
                "timedOut": timedOut,
                "capturedAt": "2026-09-13T00:00:00+08:00"}

    def _details_text(self, key):
        if key in self.details_fields:
            fields = self.details_fields[key]
        else:
            fields = {"Signature": "adhoc", "TeamIdentifier": "not set"}
        lines = ["Executable=/tmp/feedback_example",
                 "Identifier=dev.example.feedbackExample",
                 "Format=app bundle with Mach-O thin (arm64)"]
        lines += [f"Authority={a}" for a in fields.get("Authority", [])]
        lines += ["CodeDirectory v=20400 size=436 flags=0x2(adhoc) hashes=3+7 location=embedded",
                  f"CDHash={key}-cdhash",
                  f"Signature={fields.get('Signature', 'adhoc')}",
                  f"TeamIdentifier={fields.get('TeamIdentifier', 'not set')}"]
        return "\n".join(lines) + "\n"

    def _entitlements_text(self, key):
        if key in self.entitlements_overrides:
            return self.entitlements_overrides[key]
        if key in self.entitlement_dicts:
            return plistlib.dumps(self.entitlement_dicts[key]).decode()
        return plistlib.dumps(DEFAULT_ENTITLEMENTS).decode()

    def executor(self, run_id=None, cls=ex.Executor, **kwargs):
        kwargs.setdefault("lock_enabled", True)
        return cls(
            procs=self.procs,
            api_factory=lambda port: self.api,
            service_factory=self.service_factory,
            runs_root=self.runs_root,
            repo=ex.REPO,   # 只读：加载启动签名基线
            examples_dir=self.examples_dir,
            server_dir=self.server_dir,
            flutter_bin="/fake/flutter",
            node_bin="/fake/node",
            run_id=run_id,
            uid=os.getuid(),
            clock=self.clock,
            sleep=self.clock.sleep,
            phase_timeout_s=60,
            app_exit_wait_s=15,
            kill_grace_s=0,
            bundle_id="dev.example.feedbackExample",
            container_root=self.container_root,
            signing_provider=lambda: {"identities": ["fake"],
                                      "codesign": ["Identifier=fake"]},
            diagnostic_dirs=[self.diagnostic_dir],
            cmd_runner=self.cmd_runner,
            **kwargs)

    # ---- 模拟阶段进程 ----
    def _on_wait(self, handle):
        kind = kind_of(handle.cmd)
        if kind == "version":
            Path(handle.log_path).write_text("Flutter fake 1.0.0\n")
            return 0, False
        if kind == "build":
            Path(handle.log_path).write_text("build log\n")
            if self.behavior["interrupt"] == "build":
                raise KeyboardInterrupt("模拟构建期间中断")
            if self.behavior["build"] == "timeout":
                return None, True
            return self.build_exit, False
        if kind in ("1", "2", "cleanup"):
            Path(handle.log_path).write_text(f"{kind} log\n")
            params = self._read_params_from_cmd(handle)
            if self.behavior["interrupt"] == kind:
                # 真实顺序：应用先写出握手，随后操作者中断
                self._write_handshake(params, kind, alive=False)
                raise KeyboardInterrupt(f"模拟阶段 {kind} 期间中断")
            self.phase_params[kind] = params
            self.ran.append(kind)
            if kind == "cleanup":
                return self._script_cleanup(params)
            return self._script_phase(kind, params)
        raise AssertionError(f"未识别的子进程命令：{handle.cmd}")

    def _read_params_from_cmd(self, handle):
        arg = next((a for a in handle.cmd
                    if str(a).startswith("--dart-define-from-file=")), None)
        if arg is None:
            raise AssertionError("阶段命令缺少 --dart-define-from-file 参数")
        path = Path(str(arg).split("=", 1)[1])
        if not path.exists():
            raise AssertionError(f"阶段参数文件不存在：{path}")
        return json.loads(path.read_text())

    def _write_result(self, params, body):
        path = Path(params["T1C_RESULT_FILE"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, ensure_ascii=False, indent=2))

    def _write_handshake(self, params, phase, *, alive):
        if not self.behavior["handshake"]:
            return
        pid = 9000 + int(phase)
        self.procs.register_app_pid(
            pid, alive=alive, uid=os.getuid(), exe=str(self.app_exe),
            started_at=self.clock() + 1)
        if self.behavior["app_alive_after_phase"] and phase == "1":
            self.procs.alive_pids.add(pid)
            if not self.behavior["app_identity_ok"]:
                self.procs.describe_map[pid]["uid"] = os.getuid() + 1
        Path(params["T1C_HANDSHAKE_FILE"]).write_text(json.dumps(
            {"runId": params["T1C_RUN_ID"], "phase": str(phase), "pid": pid,
             "exePath": str(self.app_exe), "writtenAt": "fake"}, ensure_ascii=False))

    def _identity(self, params):
        return {"appId": params["T1C_APP_ID"], "username": params["T1C_TEST_USERNAME"]}

    def _acceptance(self, mode, params, phase):
        """模拟阶段观察到的接收结果。"""
        app_id = params["T1C_APP_ID"]
        username = params["T1C_TEST_USERNAME"]
        if mode == "pass_with_reject":
            return acc(status=400, fid=None)
        if mode == "pass_with_replay":
            _status, body = self.api.submit(app_id, username)
            return acc(status=200, fid=body["feedbackId"], replayed=True)
        if mode == "pass_with_no_id":
            return acc(status=201, fid="")
        if mode == "pass_with_duplicate":
            # 复用第一阶段已接收的 ID：服务端只多出一条（或不增），却报告两次
            if self.shared_feedback_id is None:
                _status, body = self.api.submit(app_id, username)
                self.shared_feedback_id = body.get("feedbackId")
            return acc(status=201, fid=self.shared_feedback_id)
        if mode == "pass_wrong_owner":
            _status, body = self.api.submit_as(app_id, "someone-else")
            return acc(status=201, fid=body["feedbackId"])
        status, body = self.api.submit(app_id, username)
        if status != 201:
            return acc(status=status, fid=None)
        self.shared_feedback_id = body["feedbackId"]
        return acc(status=201, fid=body["feedbackId"])

    def _script_phase(self, phase, params):
        rid = params["T1C_RUN_ID"]
        identity = self._identity(params)
        mode = self.behavior["phase1"] if phase == "1" else self.behavior["phase2"]
        required = PASS_CHECKS_1 if phase == "1" else PASS_CHECKS_2
        pass_like = mode == "pass" or mode.startswith("pass_")

        # 阶段内真实"登录 + 提交"（应用未登记则 404，与真实服务端一致）
        status, _ = self.api.client_login(
            params["T1C_APP_ID"], params["T1C_TEST_USERNAME"], params["T1C_TEST_PASSWORD"])
        if status != 200 and mode not in ("blocked", "blocked_cleanup_fail"):
            self._write_result(params, {
                "runId": rid, "phase": phase, "verdict": FAIL,
                "reason": f"阶段 {phase} 登录失败：HTTP {status} unknown_app",
                "identity": identity,
                "checks": checks(required, verdict=FAIL),
                "cleanup": {"probeCleared": True, "tokenCleared": True}})
            self._write_handshake(params, phase, alive=False)
            return 1, False

        if pass_like or mode == "cleanup_missing":
            if mode == "cleanup_missing":
                acceptance = acc(fid="fb-phase1")
            else:
                acceptance = self._acceptance(mode, params, phase)
            body = {
                "runId": rid, "phase": phase, "verdict": PASS,
                "reason": f"阶段 {phase} 通过",
                "identity": identity,
                "checks": checks(required),
                "acceptance": acceptance,
            }
            if phase == "1":
                body["cleanup"] = {"probeCleared": True, "tokenCleared": False}
                if mode == "pass":
                    self.token_written = True
            else:
                if mode == "cleanup_missing":
                    body["cleanup"] = {"probeCleared": True}
                else:
                    body["cleanup"] = {"tokenCleared": True, "probeCleared": True}
                    if mode == "pass":
                        if not self.token_written:
                            check_list = checks(
                                [n for n in required if n != "tokenRestored"])
                            check_list.append({"name": "tokenRestored", "verdict": FAIL,
                                               "reason": "重启后凭据丢失"})
                            body.update(verdict=FAIL, checks=check_list,
                                        reason="重启后凭据丢失：第一阶段成功记录有效，"
                                               "但默认安全存储中读不到令牌")
                            self._write_result(params, body)
                            self._write_handshake(params, phase, alive=False)
                            return 1, False
                        self.token_written = False
            self._write_result(params, body)
            self._write_handshake(params, phase, alive=False)
            return 0, False

        if mode == "wrong_phase":
            self._write_result(params, {
                "runId": rid, "phase": "2" if phase == "1" else "1", "verdict": PASS,
                "reason": "错误阶段标识", "identity": identity,
                "checks": checks(PASS_CHECKS_1), "acceptance": acc(),
                "cleanup": {"probeCleared": True, "tokenCleared": False}})
            self._write_handshake(params, phase, alive=False)
            return 0, False

        if mode == "wrong_identity":
            wrong = {"appId": identity["appId"] + "-other", "username": identity["username"]}
            self._write_result(params, {
                "runId": rid, "phase": phase, "verdict": PASS, "reason": "错误身份",
                "identity": wrong, "checks": checks(PASS_CHECKS_1), "acceptance": acc(),
                "cleanup": {"probeCleared": True, "tokenCleared": False}})
            self._write_handshake(params, phase, alive=False)
            return 0, False

        if mode == "blocked":
            self._write_result(params, {
                "runId": rid, "phase": phase, "verdict": BLOCKED,
                "blockedCause": "missing-entitlement",
                "reason": "默认 Data Protection Keychain 不可写："
                          "-34018 errSecMissingEntitlement",
                "identity": identity,
                "checks": [{"name": "probe", "verdict": BLOCKED, "reason": "-34018"}],
                "cleanup": {"probeCleared": True, "tokenCleared": True}})
            self._write_handshake(params, phase, alive=False)
            return 0, False

        if mode == "blocked_cleanup_fail":
            self._write_result(params, {
                "runId": rid, "phase": phase, "verdict": BLOCKED,
                "blockedCause": "missing-entitlement",
                "reason": "默认 Data Protection Keychain 不可写："
                          "-34018 errSecMissingEntitlement",
                "cleanupError": "PlatformException(-34018) 删除探针键失败",
                "identity": identity,
                "checks": [{"name": "probe", "verdict": BLOCKED, "reason": "-34018"}],
                "cleanup": {"probeCleared": False, "tokenCleared": True}})
            self._write_handshake(params, phase, alive=False)
            return 0, False

        if mode == "crash":
            self._write_handshake(params, phase, alive=False)
            return 1, False

        if mode == "timeout":
            return None, True

        raise AssertionError(f"未实现的阶段行为：{mode}")

    def _script_cleanup(self, params):
        self.event("dart_cleanup")
        if self.behavior["cleanup"] == "fail":
            self._write_result(params, {
                "runId": params["T1C_RUN_ID"], "phase": "cleanup", "verdict": FAIL,
                "reason": "兜底清理失败：删除本轮令牌键时 PlatformException(-34018)",
                "cleanupError": "PlatformException(-34018)",
                "identity": self._identity(params),
                "cleanup": {"tokenCleared": False, "probeCleared": False}})
            return 1, False
        self.token_written = False
        self._write_result(params, {
            "runId": params["T1C_RUN_ID"], "phase": "cleanup", "verdict": PASS,
            "reason": "本轮令牌与探针键已清理",
            "identity": self._identity(params),
            "cleanup": {"tokenCleared": True, "probeCleared": True}})
        return 0, False


class NoRegisterExecutor(ex.Executor):
    """缺陷注入：登记步骤被跳过（用于证明登记不可省略）。"""

    def _register_app(self):
        pass


class ExecutorFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-exec-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    # ---- 登记 ----
    def test_login_without_app_registration_fails(self):
        h = self.harness()
        code = h.executor(run_id="run-noregister", cls=NoRegisterExecutor).run()
        self.assertEqual(code, EXIT_FAIL)
        report = self.report(h, "run-noregister")
        self.assertIn("unknown_app", report["phase1"]["reason"])
        self.assertFalse(h.api.login_calls[0]["appRegistered"])
        self.assertNotIn("2", h.ran)

    def test_registration_not_effective_is_detected(self):
        h = self.harness(noop_register=True)
        self.assertEqual(h.executor(run_id="run-noop").run(), EXIT_FAIL)
        self.assertIn("回查未找到本轮应用", self.report(h, "run-noop")["reason"])
        self.assertEqual(h.ran, [])

    # ---- 正常两阶段（T1-C1 接收为准）----
    def test_happy_path_two_phases(self):
        h = self.harness()
        self.assertEqual(h.executor(run_id="run-ok").run(), EXIT_PASS)
        report = self.report(h, "run-ok")
        self.assertEqual(report["verdict"], PASS)
        self.assertEqual(report["usage"]["ok"], True)
        self.assertEqual(report["usage"]["final"]["count"], 2)
        self.assertEqual(report["usage"]["final"]["used"], 2)
        self.assertEqual(report["usage"]["phase1"]["count"], 1)
        self.assertEqual(report["usage"]["phase1"]["used"], 1)
        self.assertNotEqual(report["acceptance"]["1"]["feedbackId"],
                            report["acceptance"]["2"]["feedbackId"])
        self.assertTrue(report["cleanup"]["accountDisabled"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])
        self.assertTrue(report["cleanup"]["writerStopped"])
        self.assertTrue(report["cleanup"]["credentialCleanupConfirmed"])
        self.assertEqual(h.ran, ["1", "2"])
        # 两阶段签名证据都已采集且关键配置一致
        self.assertTrue(report["signature"]["1"]["collected"])
        self.assertTrue(report["signature"]["2"]["collected"])
        self.assertEqual(report["signature"]["1"]["verifyExitCode"], 0)
        self.assertTrue((h.runs_root / "run-ok" / "signature-1.json").exists())
        self.assertTrue((h.runs_root / "run-ok" / "signature-baseline.json").exists())

    def test_params_file_is_owner_only_and_deleted(self):
        h = self.harness()
        seen = {}

        def spy(handle):
            if kind_of(handle.cmd) == "1":
                arg = next(a for a in handle.cmd
                           if str(a).startswith("--dart-define-from-file="))
                path = Path(str(arg).split("=", 1)[1])
                seen["mode"] = oct(path.stat().st_mode & 0o777)
                seen["path"] = path
            return h._on_wait(handle)

        h.procs.spawn_hook = spy
        self.assertEqual(h.executor(run_id="run-perm").run(), EXIT_PASS)
        self.assertEqual(seen["mode"], "0o600")
        self.assertFalse(seen["path"].exists())

    # ---- 接收失败族（阶段自称 PASS 也必须 FAIL）----
    def test_rejected_submission_is_fail(self):
        h = self.harness(phase1="pass_with_reject")
        self.assertEqual(h.executor(run_id="run-reject").run(), EXIT_FAIL)
        report = self.report(h, "run-reject")
        self.assertIn("httpStatus", report["phase1"]["reason"])
        self.assertNotIn("2", h.ran)

    def test_replayed_submission_is_fail(self):
        h = self.harness(phase1="pass_with_replay")
        self.assertEqual(h.executor(run_id="run-replay").run(), EXIT_FAIL)
        self.assertIn("replayed", self.report(h, "run-replay")["phase1"]["reason"])

    def test_missing_feedback_id_is_fail(self):
        h = self.harness(phase1="pass_with_no_id")
        self.assertEqual(h.executor(run_id="run-noid").run(), EXIT_FAIL)
        self.assertIn("feedbackId", self.report(h, "run-noid")["phase1"]["reason"])

    def test_wrong_owner_is_fail(self):
        h = self.harness(phase1="pass_wrong_owner")
        self.assertEqual(h.executor(run_id="run-owner").run(), EXIT_FAIL)
        report = self.report(h, "run-owner")
        self.assertIn("归属", report["phase1"]["reason"])
        self.assertNotIn("2", h.ran)

    def test_duplicate_feedback_id_is_fail(self):
        h = self.harness(phase2="pass_with_duplicate")
        self.assertEqual(h.executor(run_id="run-dup").run(), EXIT_FAIL)
        report = self.report(h, "run-dup")
        # 两个阶段报告了同一个 feedbackId：接收核对必须失败
        self.assertEqual(report["acceptance"]["1"]["feedbackId"],
                         report["acceptance"]["2"]["feedbackId"])
        self.assertIn("接收核对失败", report["phase2"]["reason"])

    def test_admin_feedback_list_error_is_fail(self):
        h = self.harness(feedback_list="fail")
        self.assertEqual(h.executor(run_id="run-listfail").run(), EXIT_FAIL)
        self.assertIn("HTTP 500", self.report(h, "run-listfail")["phase1"]["reason"])

    def test_usage_mismatch_is_fail(self):
        h = self.harness(usage=1)
        self.assertEqual(h.executor(run_id="run-usage").run(), EXIT_FAIL)
        self.assertIn("用量", self.report(h, "run-usage")["phase2"]["reason"])

    # ---- 阶段契约 ----
    def test_phase2_overwriting_phase1_file_fails(self):
        h = self.harness()
        original = h._script_phase

        def evil(phase, params):
            result = original(phase, params)
            if phase == "2":
                body = json.loads(Path(params["T1C_RESULT_FILE"]).read_text())
                Path(params["T1C_PHASE1_FILE"]).write_text(json.dumps(body))
            return result

        h._script_phase = evil
        self.assertEqual(h.executor(run_id="run-overwrite").run(), EXIT_FAIL)
        self.assertIn("证据完整性", self.report(h, "run-overwrite")["reason"])

    def test_phase_mismatch_is_fail(self):
        h = self.harness(phase1="wrong_phase")
        self.assertEqual(h.executor(run_id="run-phase").run(), EXIT_FAIL)
        self.assertIn("phase 不匹配", self.report(h, "run-phase")["phase1"]["reason"])

    def test_identity_mismatch_is_fail(self):
        h = self.harness(phase1="wrong_identity")
        self.assertEqual(h.executor(run_id="run-ident").run(), EXIT_FAIL)
        self.assertIn("identity", self.report(h, "run-ident")["phase1"]["reason"])

    def test_missing_cleanup_field_is_fail(self):
        h = self.harness(phase2="cleanup_missing")
        self.assertEqual(h.executor(run_id="run-cleanupfield").run(), EXIT_FAIL)
        self.assertIn("tokenCleared",
                      self.report(h, "run-cleanupfield")["phase2"]["reason"])

    def test_blocked_when_probe_cleanup_proven(self):
        h = self.harness(phase1="blocked")
        self.assertEqual(h.executor(run_id="run-blocked").run(), EXIT_BLOCKED)
        report = self.report(h, "run-blocked")
        self.assertEqual(report["phase2"]["verdict"], NOT_RUN)
        self.assertEqual(h.ran, ["1"])
        # 阶段 2 未执行：签名证据明确"未采集"，不用初始构建冒充
        self.assertFalse(report["signature"]["2"]["collected"])
        self.assertIn("未执行", report["signature"]["2"]["reason"])

    def test_blocked_with_cleanup_failure_is_fail(self):
        h = self.harness(phase1="blocked_cleanup_fail")
        self.assertEqual(h.executor(run_id="run-blocked-cleanup").run(), EXIT_FAIL)
        reason = self.report(h, "run-blocked-cleanup")["phase1"]["reason"]
        self.assertIn("清理失败", reason)
        self.assertIn("errSecMissingEntitlement", reason)
        self.assertIn("删除探针键失败", reason)

    def test_restore_without_token_is_fail(self):
        h = self.harness()
        original = h._script_phase

        def lose_token(phase, params):
            if phase == "2":
                h.token_written = False
            return original(phase, params)

        h._script_phase = lose_token
        self.assertEqual(h.executor(run_id="run-tokenlost").run(), EXIT_FAIL)
        self.assertIn("重启后凭据丢失",
                      self.report(h, "run-tokenlost")["phase2"]["reason"])

    # ---- 失败路径统一收尾 ----
    def test_build_failure_still_cleans_up(self):
        h = self.harness(build="fail")
        h.build_exit = 1
        self.assertEqual(h.executor(run_id="run-buildfail").run(), EXIT_FAIL)
        report = self.report(h, "run-buildfail")
        self.assertIn("构建失败", report["error"])
        self.assertTrue(report["cleanup"]["accountDisabled"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])
        self.assertEqual(h.ran, [])

    def test_phase_timeout_terminates_round_process_group(self):
        h = self.harness(phase1="timeout")
        self.assertEqual(h.executor(run_id="run-timeout").run(), EXIT_FAIL)
        report = self.report(h, "run-timeout")
        self.assertIn("超时", report["reason"])
        self.assertTrue(any(sig == signal.SIGTERM for _, sig in h.procs.group_signals))
        self.assertTrue(any(sig == signal.SIGKILL for _, sig in h.procs.group_signals))
        self.assertTrue(report["cleanup"]["accountDisabled"])

    def test_phase_crash_runs_fallback_cleanup(self):
        h = self.harness(phase2="crash")
        self.assertEqual(h.executor(run_id="run-crash").run(), EXIT_FAIL)
        report = self.report(h, "run-crash")
        self.assertIn("cleanup", h.ran)
        self.assertEqual(report["cleanup"]["dartCleanup"], PASS)
        self.assertTrue(report["cleanup"]["credentialCleanupConfirmed"])

    def test_fallback_cleanup_failure_reports_residual_keys(self):
        h = self.harness(phase2="crash", cleanup="fail")
        self.assertEqual(h.executor(run_id="run-residual").run(), EXIT_FAIL)
        report = self.report(h, "run-residual")
        self.assertEqual(report["cleanup"]["dartCleanup"], FAIL)
        self.assertIn("残留", report["reason"])
        self.assertIn(report["identity"]["tokenStorageKey"], report["reason"])
        self.assertFalse(report["cleanup"]["credentialCleanupConfirmed"])
        blob = json.dumps(report, ensure_ascii=False)
        self.assertNotIn(h.api.users["t1c-run-residual"]["password"], blob)

    def test_account_disable_failure_forces_fail(self):
        h = self.harness(disable="fail")
        self.assertEqual(h.executor(run_id="run-disablefail").run(), EXIT_FAIL)
        report = self.report(h, "run-disablefail")
        self.assertIn("清理", report["reason"])
        self.assertFalse(report["cleanup"]["accountDisableVerified"])

    def test_preexisting_example_process_untouched(self):
        h = self.harness()
        self.assertEqual(h.executor(run_id="run-others").run(), EXIT_PASS)
        self.assertNotIn(h.preexisting_pid, [pid for pid, _ in h.procs.killed])
        self.assertIn(h.preexisting_pid, h.procs.alive_pids)

    def test_unconfirmed_app_exit_skips_phase2(self):
        h = self.harness(handshake=False)
        self.assertEqual(h.executor(run_id="run-noexit").run(), EXIT_FAIL)
        self.assertIn("退出无法确认", self.report(h, "run-noexit")["reason"])
        self.assertNotIn("2", h.ran)

    def test_alive_app_with_unverifiable_identity_is_not_killed(self):
        h = self.harness(app_alive_after_phase=True, app_identity_ok=False)
        self.assertEqual(h.executor(run_id="run-unverified").run(), EXIT_FAIL)
        self.assertIn("身份无法核实", self.report(h, "run-unverified")["reason"])
        self.assertEqual(h.procs.killed, [])
        self.assertNotIn("2", h.ran)

    def test_alive_verified_app_is_terminated_before_phase2(self):
        h = self.harness(app_alive_after_phase=True)
        self.assertEqual(h.executor(run_id="run-killapp").run(), EXIT_PASS)
        self.assertIn((9001, signal.SIGTERM), h.procs.killed)
        self.assertEqual(h.ran, ["1", "2"])

    def test_two_runs_do_not_overwrite_evidence(self):
        h = self.harness()
        self.assertEqual(h.executor(run_id="run-a").run(), EXIT_PASS)
        first = (h.runs_root / "run-a" / "report.json").read_text()
        h.api.users.clear()
        h.api.registered.clear()
        h.api.feedback_items.clear()
        h.services.clear()
        self.assertEqual(h.executor(run_id="run-b").run(), EXIT_PASS)
        self.assertEqual((h.runs_root / "run-a" / "report.json").read_text(), first)
        history = (h.runs_root / "history.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(history), 2)

    def test_concurrent_run_is_rejected_by_lock(self):
        h = self.harness()
        h.runs_root.mkdir(parents=True, exist_ok=True)
        fd = os.open(h.runs_root / ex.LOCK_PATH.name, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual(h.executor(run_id="run-locked").run(), EXIT_FAIL)
        rejected = json.loads((h.runs_root / "run-locked-early-failure.json").read_text())
        self.assertIn("并发运行被拒绝", rejected["reason"])
        self.assertEqual(h.ran, [])


class InterruptionTests(unittest.TestCase):
    """T1-C2：中断时先停止写入来源，再清理凭据；账号/服务/参数继续收尾。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-interrupt-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    def test_credential_state_registered_before_phase1_even_without_result(self):
        """第一阶段启动前即登记"可能有残留"：结果缺失不能被当作"未执行"。"""
        h = self.harness(interrupt="1")
        self.assertEqual(h.executor(run_id="run-int1").run(), EXIT_FAIL)
        report = self.report(h, "run-int1")
        # 启动前就登记为"可能有残留"（结果缺失也不当作"未执行"）
        self.assertEqual(report["cleanup"]["tokenStateAtPhase1Start"], "maybe")
        self.assertEqual(report["cleanup"]["dartCleanup"], PASS)
        self.assertTrue(report["cleanup"]["credentialCleanupConfirmed"])
        self.assertIn("dart_cleanup", h.events)
        # 阶段 1 没有留下结果文件，仍完成了凭据清理
        result_dir = Path(report["paths"]["resultDir"])
        self.assertFalse((result_dir / "phase1.json").exists())

    def test_writer_stop_precedes_credential_cleanup(self):
        h = self.harness(interrupt="1")
        self.assertEqual(h.executor(run_id="run-order").run(), EXIT_FAIL)
        signals = [i for i, e in enumerate(h.events)
                   if e.startswith("signal_group:") or e.startswith("kill:")]
        cleanup_at = h.events.index("dart_cleanup")
        self.assertTrue(signals, "应先在收尾中终止本轮仍存活的进程")
        self.assertLess(max(signals), cleanup_at, "必须先停止写入来源，再清理凭据")

    def test_teardown_continues_after_interrupt(self):
        h = self.harness(interrupt="1")
        self.assertEqual(h.executor(run_id="run-teardown").run(), EXIT_FAIL)
        report = self.report(h, "run-teardown")
        self.assertTrue(report["cleanup"]["accountDisabled"])
        self.assertTrue(report["cleanup"]["accountDisableVerified"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])
        steps = [s["step"] for s in report["cleanup"]["cleanupSteps"]]
        self.assertEqual(steps, ["confirm-writer-stopped", "fallback-credential-cleanup",
                                 "disable-account", "stop-service", "remove-params"])

    def test_interrupt_during_build(self):
        h = self.harness(interrupt="build")
        self.assertEqual(h.executor(run_id="run-intbuild").run(), EXIT_FAIL)
        report = self.report(h, "run-intbuild")
        self.assertIn("用户中断", report["error"])
        self.assertEqual(report["cleanup"]["tokenState"], "unknown")
        self.assertNotIn("tokenStateAtPhase1Start", report["cleanup"])
        self.assertEqual(report["cleanup"]["dartCleanup"], "NOT_NEEDED")
        self.assertTrue(report["cleanup"]["accountDisabled"])
        self.assertNotIn("dart_cleanup", h.events)

    def test_interrupt_during_phase2(self):
        h = self.harness(interrupt="2")
        self.assertEqual(h.executor(run_id="run-int2").run(), EXIT_FAIL)
        report = self.report(h, "run-int2")
        self.assertIn("用户中断", report["error"])
        self.assertEqual(report["cleanup"]["dartCleanup"], PASS)
        self.assertTrue(report["cleanup"]["credentialCleanupConfirmed"])
        self.assertTrue(report["cleanup"]["serviceStopped"])

    def test_unrelated_processes_survive_interrupt(self):
        h = self.harness(interrupt="1")
        self.assertEqual(h.executor(run_id="run-intothers").run(), EXIT_FAIL)
        self.assertNotIn(h.preexisting_pid, [pid for pid, _ in h.procs.killed])
        self.assertIn(h.preexisting_pid, h.procs.alive_pids)

    def test_residual_not_reported_as_cleared_when_writer_unconfirmed(self):
        """写入来源无法确认停止 → 不报告凭据清理完成，且整体 FAIL。"""
        h = self.harness(interrupt="1", app_alive_after_phase=True,
                         app_identity_ok=False)
        self.assertEqual(h.executor(run_id="run-unconfirmed").run(), EXIT_FAIL)
        report = self.report(h, "run-unconfirmed")
        self.assertFalse(report["cleanup"]["writerStopped"])
        self.assertFalse(report["cleanup"]["credentialCleanupConfirmed"])
        self.assertIn("不报告凭据清理完成", report["reason"])

    def test_resource_manifest_persisted(self):
        h = self.harness(interrupt="1")
        self.assertEqual(h.executor(run_id="run-manifest").run(), EXIT_FAIL)
        manifest = json.loads((h.runs_root / "run-manifest" / "resources.json").read_text())
        kinds = [r["kind"] for r in manifest["resources"]]
        self.assertIn("service", kinds)
        self.assertIn("app", kinds)
        self.assertIn("user", kinds)
        self.assertTrue(manifest["processes"])


class LaunchSignatureTests(unittest.TestCase):
    """T1-C4：启动签名失败分类与启动门禁。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-launch-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    def write_diagnostic(self, h, *, age_seconds, pid, ind=0,
                         indicator="Taskgated Invalid Signature",
                         proc_path=None):
        """写一份落在执行器时钟轴上的诊断报告（历史/本轮由 age_seconds 决定）。"""
        from datetime import datetime as _dt
        path = h.diagnostic_dir / f"feedback_example-diag-{ind}.ips"
        stamp_epoch = h.clock() - age_seconds
        header = {"app_name": "feedback_example",
                  "timestamp": _dt.fromtimestamp(stamp_epoch).astimezone().strftime(
                      "%Y-%m-%d %H:%M:%S.%f %z"),
                  "slice_uuid": "d0d27d81-5cae-3644-bac8-cc455a1d4cc6",
                  "incident_id": "A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724"}
        body = {"pid": pid, "procPath": proc_path or str(h.app_exe),
                "termination": {"namespace": "CODESIGNING", "indicator": indicator},
                "exception": {"signal": "SIGKILL (Code Signature Invalid)"}}
        path.write_text(json.dumps(header) + "\n" + json.dumps(body))
        os.utime(path, (stamp_epoch, stamp_epoch))
        return path

    def test_matching_rejection_is_classified_as_signature_invalid(self):
        h = self.harness(handshake=False)
        original = h._script_phase

        def crash_with_report(phase, params):
            self.write_diagnostic(h, age_seconds=0, pid=9001)
            return original(phase, params)

        h._script_phase = crash_with_report
        self.assertEqual(h.executor(run_id="run-sigbad").run(), EXIT_FAIL)
        report = self.report(h, "run-sigbad")
        self.assertIn("launch_signature_invalid", report["reason"])
        self.assertEqual(report["launch"]["1"]["kind"], LAUNCH_SIGNATURE_INVALID)

    def test_old_report_does_not_prove_current_failure(self):
        h = self.harness(handshake=False)
        self.write_diagnostic(h, age_seconds=3600, pid=33996)
        self.assertEqual(h.executor(run_id="run-oldreport").run(), EXIT_FAIL)
        report = self.report(h, "run-oldreport")
        self.assertEqual(report["launch"]["1"]["kind"], LAUNCH_FAILED)
        self.assertNotIn("launch_signature_invalid", report["reason"])
        self.assertTrue(report["launchBaseline"]["available"])
        self.assertEqual(report["launchBaseline"]["originalCrashReport"]["incidentId"],
                         "A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724")

    def test_static_verify_pass_but_launch_rejected_still_fails(self):
        h = self.harness(handshake=False)
        original = h._script_phase

        def crash_with_report(phase, params):
            self.write_diagnostic(h, age_seconds=0, pid=9001)
            return original(phase, params)

        h._script_phase = crash_with_report
        self.assertEqual(h.executor(run_id="run-staticok").run(), EXIT_FAIL)
        report = self.report(h, "run-staticok")
        self.assertEqual(report["signature"]["baseline"]["verifyExitCode"], 0)
        self.assertEqual(report["launch"]["1"]["kind"], LAUNCH_SIGNATURE_INVALID)

    def test_launch_timeout_without_evidence_is_not_signature(self):
        h = self.harness(phase1="timeout")
        self.assertEqual(h.executor(run_id="run-sigtimeout").run(), EXIT_FAIL)
        report = self.report(h, "run-sigtimeout")
        self.assertEqual(report["launch"]["1"]["kind"], LAUNCH_FAILED)
        self.assertNotIn("launch_signature_invalid", report["reason"])

    def test_launch_failure_still_runs_teardown(self):
        h = self.harness(handshake=False)
        self.assertEqual(h.executor(run_id="run-launchfail").run(), EXIT_FAIL)
        report = self.report(h, "run-launchfail")
        steps = [s["step"] for s in report["cleanup"]["cleanupSteps"]]
        self.assertEqual(steps[0], "confirm-writer-stopped")
        self.assertTrue(report["cleanup"]["accountDisabled"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])


class SignatureGateTests(unittest.TestCase):
    """T1-C3：签名证据缺失 / 静态验证失败 / 关键配置不一致都不能 PASS。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-signature-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    def test_static_verify_failure_blocks_pass(self):
        h = self.harness()
        h.verify_exit = {"baseline": 0, "1": 0, "2": 1}
        self.assertEqual(h.executor(run_id="run-sigverify").run(), EXIT_FAIL)
        report = self.report(h, "run-sigverify")
        self.assertIn("静态验证失败", report["reason"])
        self.assertEqual(report["phase1"]["verdict"], PASS)
        self.assertEqual(report["phase2"]["verdict"], PASS)

    def test_config_mismatch_blocks_pass(self):
        h = self.harness()
        h.entitlements_overrides = {"2": (
            "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>"
            "<key>com.apple.security.app-sandbox</key><true/>"
            "</dict></plist>")}
        self.assertEqual(h.executor(run_id="run-sigmismatch").run(), EXIT_FAIL)
        report = self.report(h, "run-sigmismatch")
        self.assertIn("entitlements", report["reason"])
        self.assertIn("多出键", report["reason"])
        self.assertEqual(report["phase1"]["verdict"], PASS)

    def test_team_mismatch_blocks_pass(self):
        h = self.harness()
        h.details_overrides = {"2": (
            "Identifier=dev.example.feedbackExample\n"
            "Signature=adhoc\nTeamIdentifier=TEAM12345\n")}
        self.assertEqual(h.executor(run_id="run-sigteam").run(), EXIT_FAIL)
        self.assertIn("Team", self.report(h, "run-sigteam")["reason"])

    def test_phase2_not_run_records_not_collected(self):
        h = self.harness(phase1="blocked")
        self.assertEqual(h.executor(run_id="run-sigblocked").run(), EXIT_BLOCKED)
        report = self.report(h, "run-sigblocked")
        self.assertFalse(report["signature"]["2"]["collected"])
        self.assertIn("未采集", report["signature"]["2"]["reason"])
        self.assertEqual(report["verdict"], BLOCKED)

    def test_signature_commands_are_argument_arrays(self):
        h = self.harness()
        self.assertEqual(h.executor(run_id="run-sigcmd").run(), EXIT_PASS)
        for _key, argv in h.signature_calls:
            self.assertIsInstance(argv, list)
            self.assertTrue(all(isinstance(a, str) for a in argv))
        verify_calls = [argv for _key, argv in h.signature_calls if "--verify" in argv]
        self.assertTrue(verify_calls)
        self.assertIn("--deep", verify_calls[0])
        self.assertIn("--strict", verify_calls[0])


# ------------------------------------------------------------------ 本轮新增反例
#
# T1-C2：停止状态无法确认时禁止通过；T1-C3：真实授权配置比较与采集严格性。
# 这些用例**先于实现**编写（红 → 绿）。

def writer_stop_executor(outcome):
    """注入 `_confirm_writer_stopped` 的结果：raise_oserror / raise_interrupt /
    return_none / return_false / return_true。"""
    class Injected(ex.Executor):
        def _confirm_writer_stopped(self):
            if outcome == "raise_oserror":
                raise OSError("模拟：无法确认写入来源停止（OSError）")
            if outcome == "raise_interrupt":
                raise KeyboardInterrupt("模拟：收尾期间再次中断")
            if outcome == "return_none":
                return None
            if outcome == "return_false":
                return False
            return True
    return Injected


class WriterStopEnforcementTests(unittest.TestCase):
    """T1-C2：只有返回 True 才算写入来源已停止。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-writerstop-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    def run_with(self, outcome, run_id):
        h = self.harness()                      # 正常两阶段夹具：本来会 PASS
        cls = writer_stop_executor(outcome)
        code = h.executor(run_id=run_id, cls=cls).run()
        return h, self.report(h, run_id), code

    def assert_blocked_by_writer_stop(self, h, report, code, run_id, marker):
        # 整体必须 FAIL / 退出码 1（不得保留 PASS 或 BLOCKED）
        self.assertEqual(code, EXIT_FAIL, f"{run_id} 必须退出 1")
        self.assertEqual(report["verdict"], FAIL)
        # 停止状态无法确认
        self.assertIs(report["cleanup"]["writerStopped"], False)
        self.assertIs(report["cleanup"]["credentialCleanupConfirmed"], False)
        # 不再启动兜底凭据清理进程（避免与尚存活的写入进程竞争）
        self.assertNotIn("dart_cleanup", h.events)
        self.assertNotEqual(report["cleanup"]["dartCleanup"], PASS)
        # 残留键名如实记录，且不含令牌值
        self.assertTrue(report["cleanup"]["residualKeys"], "必须记录本轮残留键名")
        blob = json.dumps(report, ensure_ascii=False)
        self.assertNotIn(h.api.users[f"t1c-{run_id}"]["password"], blob)
        # 原始错误可在报告中定位
        self.assertIn(marker, blob)
        # 后续独立收尾仍然执行
        steps = {s["step"]: s for s in report["cleanup"]["cleanupSteps"]}
        self.assertFalse(steps["confirm-writer-stopped"]["ok"])
        self.assertTrue(steps["disable-account"]["ok"])
        self.assertTrue(steps["stop-service"]["ok"])
        self.assertTrue(steps["remove-params"]["ok"])
        self.assertTrue(report["cleanup"]["accountDisableVerified"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])

    def test_confirm_writer_stopped_raises_oserror(self):
        h, report, code = self.run_with("raise_oserror", "run-ws-os")
        self.assert_blocked_by_writer_stop(h, report, code, "run-ws-os", "OSError")

    def test_confirm_writer_stopped_raises_keyboard_interrupt(self):
        h, report, code = self.run_with("raise_interrupt", "run-ws-int")
        self.assert_blocked_by_writer_stop(h, report, code, "run-ws-int", "KeyboardInterrupt")

    def test_confirm_writer_stopped_returns_none(self):
        h, report, code = self.run_with("return_none", "run-ws-none")
        self.assert_blocked_by_writer_stop(h, report, code, "run-ws-none",
                                           "未返回明确结果")

    def test_confirm_writer_stopped_returns_false(self):
        h, report, code = self.run_with("return_false", "run-ws-false")
        self.assert_blocked_by_writer_stop(h, report, code, "run-ws-false", "写入来源")

    def test_unconfirmed_writer_skips_fallback_cleanup_when_token_may_remain(self):
        """令牌可能仍存在（阶段 2 未把令牌清空）时，写入来源未确认停止 →
        **不启动**兜底清理进程，只记录清理未完成与残留键名。"""
        h = self.harness(phase2="crash")     # 阶段 1 成功写出令牌后阶段 2 崩溃
        cls = writer_stop_executor("return_false")
        code = h.executor(run_id="run-ws-maybe", cls=cls).run()
        report = self.report(h, "run-ws-maybe")
        self.assertEqual(code, EXIT_FAIL)
        self.assertIs(report["cleanup"]["writerStopped"], False)
        self.assertIs(report["cleanup"]["credentialCleanupConfirmed"], False)
        self.assertNotIn("dart_cleanup", h.events, "不得启动兜底清理进程")
        self.assertEqual(report["cleanup"]["dartCleanup"], "NOT_RUN")
        self.assertIn("未确认停止", report["cleanup"]["dartCleanupDetail"])
        self.assertTrue(report["cleanup"]["residualKeys"])
        steps = {x["step"]: x for x in report["cleanup"]["cleanupSteps"]}
        self.assertFalse(steps["fallback-credential-cleanup"]["ok"])
        self.assertTrue(steps["disable-account"]["ok"])
        self.assertTrue(report["cleanup"]["serviceStopped"])
        self.assertTrue(report["cleanup"]["paramsRemoved"])

    def test_resource_manifest_reports_actual_disposition(self):
        h, report, _code = self.run_with("return_false", "run-ws-ledger")
        entries = {e["kind"]: e for e in report["resources"]}
        # 不得无条件把所有条目标为已清理
        self.assertTrue(any(e["cleaned"] is not True for e in report["resources"]))
        self.assertIs(entries["app"]["cleaned"], False, "应用登记不删除，不得冒报已清理")
        self.assertIs(entries["service"]["cleaned"], True)
        self.assertIs(entries["user"]["cleaned"], True)
        for entry in report["resources"]:
            self.assertIn("disposition", entry)

    def test_normal_stop_still_passes(self):
        """正常停止成功 + 无残留：仍必须 PASS（防矫枉过正）。"""
        h = self.harness()
        self.assertEqual(h.executor(run_id="run-ws-ok").run(), EXIT_PASS)
        report = self.report(h, "run-ws-ok")
        self.assertIs(report["cleanup"]["writerStopped"], True)
        self.assertIs(report["cleanup"]["credentialCleanupConfirmed"], True)

    def test_phase_not_started_needs_no_credential_cleanup(self):
        """阶段 1 未启动：没有凭据需要清理，但收尾仍按实际核验记录。"""
        h = self.harness(build="fail")
        h.build_exit = 1
        self.assertEqual(h.executor(run_id="run-ws-nophase").run(), EXIT_FAIL)
        report = self.report(h, "run-ws-nophase")
        self.assertIs(report["cleanup"]["writerStopped"], True)
        self.assertIs(report["cleanup"]["credentialCleanupConfirmed"], True)
        self.assertEqual(report["cleanup"]["dartCleanup"], "NOT_NEEDED")
        self.assertNotIn("dart_cleanup", h.events)


def sig_evidence(**overrides):
    """新形状（第 11 轮）的完整签名证据。"""
    base = {
        "collected": True,
        "capturedAt": "2026-09-13T00:00:00+08:00",
        "artifactPath": "/x/feedback_example.app",
        "executablePath": "/x/feedback_example.app/Contents/MacOS/feedback_example",
        "binaryUuid": "D0D27D81-5CAE-3644-BAC8-CC455A1D4CC6",
        "signatureDigest": "deadbeef",
        "cdhash": "abc",
        "identifier": "dev.example.feedbackExample",
        "teamIdentifier": "not set",
        "signatureFormat": "adhoc",
        "authorityChain": [],
        "parseStatus": {"verify": "ok", "details": "ok",
                        "entitlements": "ok", "uuidCommand": "ok"},
        "verify": {"exitCode": 0, "timedOut": False, "stdout": "valid on disk", "stderr": ""},
        "details": {"exitCode": 0, "timedOut": False, "stdout": "Identifier=dev.example.feedbackExample", "stderr": ""},
        "entitlements": {"exitCode": 0, "timedOut": False, "stdout": "<plist/>", "stderr": ""},
        "uuidCommand": {"exitCode": 0, "timedOut": False, "stdout": "UUID: X", "stderr": ""},
        "entitlementValues": {"com.apple.security.app-sandbox": True},
        "entitlementKeys": ["com.apple.security.app-sandbox"],
    }
    base.update(overrides)
    return base


class SignatureEvidenceStrictTests(unittest.TestCase):
    """T1-C3：采集严格性与授权配置比较（纯判定）。"""

    def test_complete_new_shape_ok(self):
        self.assertTrue(evaluate_signature_evidence(sig_evidence(), "1")[0])

    def test_historical_shape_without_new_fields_is_rejected(self):
        """旧记录（缺 parseStatus / entitlementValues）不得用于新门禁判 PASS。"""
        old = {"collected": True, "identifier": "dev.example.feedbackExample",
               "teamIdentifier": "not set", "signatureFormat": "adhoc",
               "binaryUuid": "X", "signatureDigest": "y",
               "verify": {"exitCode": 0}, "details": {"exitCode": 0},
               "entitlements": {"exitCode": 0},
               "entitlementKeys": ["a"], "keychainEntitlements": []}
        ok, reason = evaluate_signature_evidence(old, "1")
        self.assertFalse(ok, "历史证据缺新必需字段时必须失败")
        self.assertIn("parseStatus", reason)

    def test_nonzero_exit_on_any_command_fails_even_with_plausible_output(self):
        for kind in ("details", "entitlements", "uuidCommand"):
            with self.subTest(kind=kind):
                ev = sig_evidence()
                ev[kind] = dict(ev[kind], exitCode=1,
                                stdout="Identifier=dev.example.feedbackExample")
                ok, reason = evaluate_signature_evidence(ev, "1")
                self.assertFalse(ok)
                self.assertIn(kind, reason)

    def test_timeout_fails(self):
        ev = sig_evidence()
        ev["verify"] = dict(ev["verify"], timedOut=True, exitCode=None)
        ok, reason = evaluate_signature_evidence(ev, "1")
        self.assertFalse(ok)
        self.assertIn("超时", reason)

    def test_missing_or_invalid_plist_fails(self):
        for status in ("empty-stdout", "invalid-plist"):
            with self.subTest(status=status):
                ev = sig_evidence(parseStatus={"verify": "ok", "details": "ok",
                                               "entitlements": status, "uuidCommand": "ok"})
                ok, reason = evaluate_signature_evidence(ev, "1")
                self.assertFalse(ok)
                self.assertIn("entitlements", reason)

    def test_empty_entitlements_dict_is_valid(self):
        ev = sig_evidence(entitlementValues={}, entitlementKeys=[])
        self.assertTrue(evaluate_signature_evidence(ev, "1")[0])

    def test_adhoc_claiming_authority_is_inconsistent(self):
        ev = sig_evidence(signatureFormat="adhoc", authorityChain=["Fake Authority"],
                          teamIdentifier="TEAM123")
        ok, reason = evaluate_signature_evidence(ev, "1")
        self.assertFalse(ok)
        self.assertIn("adhoc", reason)

    def test_formal_signature_requires_chain_and_team(self):
        without_chain = sig_evidence(signatureFormat="authority",
                                     authorityChain=[], teamIdentifier="TEAM123")
        self.assertFalse(evaluate_signature_evidence(without_chain, "1")[0])
        without_team = sig_evidence(signatureFormat="authority",
                                    authorityChain=["Developer ID Application: X (TEAM123)"],
                                    teamIdentifier="not set")
        self.assertFalse(evaluate_signature_evidence(without_team, "1")[0])
        complete = sig_evidence(signatureFormat="authority",
                                authorityChain=["Developer ID Application: X (TEAM123)",
                                                "Developer ID Certification Authority"],
                                teamIdentifier="TEAM123")
        self.assertTrue(evaluate_signature_evidence(complete, "1")[0])

    def test_unknown_signature_format_fails(self):
        self.assertFalse(evaluate_signature_evidence(
            sig_evidence(signatureFormat="unknown"), "1")[0])

    # ---- 比较规则 ----
    def cmp(self, a_overrides, b_overrides):
        a = sig_evidence(**a_overrides)
        b = sig_evidence(**b_overrides)
        return compare_signature_evidence(a, b)

    def test_team_change_fails(self):
        ok, problems, _ = self.cmp(
            {"signatureFormat": "authority", "teamIdentifier": "TEAM.groupA",
             "authorityChain": ["A"]},
            {"signatureFormat": "authority", "teamIdentifier": "TEAM.groupB",
             "authorityChain": ["A"]})
        self.assertFalse(ok)
        self.assertTrue(any("Team" in p for p in problems))

    def test_authority_identity_change_same_team_fails(self):
        ok, problems, _ = self.cmp(
            {"signatureFormat": "authority", "teamIdentifier": "TEAM123",
             "authorityChain": ["Developer ID Application: A (TEAM123)"]},
            {"signatureFormat": "authority", "teamIdentifier": "TEAM123",
             "authorityChain": ["Developer ID Application: B (TEAM123)"]})
        self.assertFalse(ok)
        self.assertTrue(any("Authority" in p or "身份" in p for p in problems))

    def test_boolean_value_change_fails(self):
        ok, _, _ = self.cmp(
            {"entitlementValues": {"com.apple.security.app-sandbox": True}},
            {"entitlementValues": {"com.apple.security.app-sandbox": False}})
        self.assertFalse(ok)

    def test_string_value_change_fails(self):
        ok, _, _ = self.cmp(
            {"entitlementValues": {"com.apple.developer.team-identifier": "TEAM-A"}},
            {"entitlementValues": {"com.apple.developer.team-identifier": "TEAM-B"}})
        self.assertFalse(ok)

    def test_value_type_change_fails(self):
        for left, right in (((True), ("true")), ((1), (True)), ((["a"]), ("a"))):
            with self.subTest(left=left, right=right):
                ok, _, _ = self.cmp(
                    {"entitlementValues": {"k": left}},
                    {"entitlementValues": {"k": right}})
                self.assertFalse(ok)

    def test_keychain_groups_order_change_passes(self):
        ok, problems, _ = self.cmp(
            {"entitlementValues": {"keychain-access-groups": ["TEAM.a", "TEAM.b"]}},
            {"entitlementValues": {"keychain-access-groups": ["TEAM.b", "TEAM.a"]}})
        self.assertTrue(ok, problems)

    def test_keychain_groups_membership_change_fails(self):
        ok, _, _ = self.cmp(
            {"entitlementValues": {"keychain-access-groups": ["TEAM.groupA"]}},
            {"entitlementValues": {"keychain-access-groups": ["TEAM.groupB"]}})
        self.assertFalse(ok)

    def test_other_array_order_change_fails(self):
        ok, _, _ = self.cmp(
            {"entitlementValues": {"com.apple.developer.associated-domains": ["a", "b"]}},
            {"entitlementValues": {"com.apple.developer.associated-domains": ["b", "a"]}})
        self.assertFalse(ok)

    def test_dict_key_order_is_ignored(self):
        ok, problems, _ = self.cmp(
            {"entitlementValues": {"a": True, "b": "x"}},
            {"entitlementValues": {"b": "x", "a": True}})
        self.assertTrue(ok, problems)

    def test_added_or_removed_entitlement_key_fails(self):
        ok, _, _ = self.cmp(
            {"entitlementValues": {"a": True}},
            {"entitlementValues": {"a": True, "b": False}})
        self.assertFalse(ok)

    def test_different_uuid_and_cdhash_but_same_identity_passes(self):
        ok, problems, _ = self.cmp(
            {"binaryUuid": "AAAA", "cdhash": "111", "signatureDigest": "d1"},
            {"binaryUuid": "BBBB", "cdhash": "222", "signatureDigest": "d2"})
        self.assertTrue(ok, problems)

    def test_compare_rejects_historical_evidence(self):
        ok, problems, _ = compare_signature_evidence(
            {"collected": True, "identifier": "x", "teamIdentifier": "not set",
             "signatureFormat": "adhoc", "binaryUuid": "u", "signatureDigest": "d",
             "verify": {"exitCode": 0}, "details": {"exitCode": 0},
             "entitlements": {"exitCode": 0}, "entitlementKeys": []},
            sig_evidence())
        self.assertFalse(ok)
        self.assertTrue(problems)


class SignatureCaptureStrictTests(unittest.TestCase):
    """T1-C3：通过真实采集路径（cmd_runner 注入）+ 最终 Executor.run() 覆盖。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-signature-capture-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def harness(self, **behavior):
        return Harness(self.tmp, behavior=behavior)

    def report(self, h, run_id):
        return json.loads((h.runs_root / run_id / "report.json").read_text())

    def test_command_result_keeps_stdout_and_stderr_separate(self):
        h = self.harness(phase1="blocked")     # 只跑到 baseline + 阶段 1
        h.cmd_overrides[("baseline", "entitlements")] = {
            "exitCode": 0, "stdout": plistlib.dumps(DEFAULT_ENTITLEMENTS).decode(),
            "stderr": "Executable=/x\nwarning: Specifying ':' in the path is deprecated"}
        self.assertEqual(h.executor(run_id="run-sig-io").run(), EXIT_BLOCKED)
        raw = json.loads((h.runs_root / "run-sig-io" / "signature-baseline.json").read_text())
        self.assertIn("keychain-access-groups", raw["entitlements"]["stdout"])
        self.assertNotIn("deprecated", raw["entitlements"]["stdout"])
        self.assertIn("deprecated", raw["entitlements"]["stderr"])
        # 汇总输出仍保留供日志查看
        self.assertIn("deprecated", raw["entitlements"]["output"])
        parse_status = raw.get("parseStatus") or {}
        self.assertEqual(parse_status.get("entitlements"), "ok",
                         "采集必须记录每个命令的解析状态")
        self.assertEqual((raw.get("entitlementValues") or {}).get("keychain-access-groups"),
                         ["TEAM.groupA"], "必须用 plistlib 解析出授权值")

    def test_details_are_parsed_from_stderr_not_stdout(self):
        """实测行为：`codesign -dv` 的显示输出在 stderr；解析必须用权威流，
        不能被 stdout 里的同形文本带偏，也不能用合并后的 output。"""
        h = self.harness(phase1="blocked")
        h.cmd_overrides[("baseline", "details")] = {
            "exitCode": 0, "stderr": h._details_text("baseline"),
            "stdout": "Identifier=WRONG.stdout.identity\nSignature=adhoc\n"
                      "TeamIdentifier=not set\n"}
        self.assertEqual(h.executor(run_id="run-sig-stream").run(), EXIT_BLOCKED)
        raw = json.loads((h.runs_root / "run-sig-stream" / "signature-baseline.json").read_text())
        self.assertEqual(raw["identifier"], "dev.example.feedbackExample")
        self.assertEqual(raw["parsedFrom"]["details"], "stderr")
        self.assertEqual(raw["parsedFrom"]["entitlements"], "stdout")

    def test_plist_is_parsed_from_stdout_not_merged_output(self):
        """entitlements 的 plist 只在 stdout；stderr 的 Executable=/警告不得混入。"""
        h = self.harness(phase1="blocked")
        h.cmd_overrides[("baseline", "entitlements")] = {
            "exitCode": 0, "stdout": plistlib.dumps(DEFAULT_ENTITLEMENTS).decode(),
            "stderr": "<plist><dict><key>BOGUS.from.stderr</key><true/></dict></plist>"}
        self.assertEqual(h.executor(run_id="run-sig-stream2").run(), EXIT_BLOCKED)
        raw = json.loads((h.runs_root / "run-sig-stream2" / "signature-baseline.json").read_text())
        self.assertNotIn("BOGUS.from.stderr", raw["entitlementValues"])
        self.assertIn("keychain-access-groups", raw["entitlementValues"])

    def test_nonzero_exit_with_plausible_output_blocks_pass(self):
        h = self.harness()
        h.cmd_overrides[("1", "details")] = {
            "exitCode": 1, "stderr": h._details_text("1")}
        self.assertEqual(h.executor(run_id="run-sig-exit").run(), EXIT_FAIL)
        report = self.report(h, "run-sig-exit")
        self.assertIn("签名", report["reason"])
        self.assertEqual(report["phase1"]["verdict"], PASS)

    def test_invalid_plist_blocks_pass(self):
        h = self.harness()
        h.entitlements_overrides["2"] = "this is not a plist"
        self.assertEqual(h.executor(run_id="run-sig-plist").run(), EXIT_FAIL)
        report = self.report(h, "run-sig-plist")
        self.assertIn("entitlements", report["reason"])
        status = ((report["signature"]["2"].get("parseStatus") or {})
                  .get("entitlements"))
        self.assertNotEqual(status, "ok", "损坏的 plist 不得被当作有效解析")

    def test_keychain_group_order_change_passes_gate(self):
        h = self.harness()
        h.entitlement_dicts["1"] = dict(DEFAULT_ENTITLEMENTS,
                                        **{"keychain-access-groups": ["TEAM.a", "TEAM.b"]})
        h.entitlement_dicts["2"] = dict(DEFAULT_ENTITLEMENTS,
                                        **{"keychain-access-groups": ["TEAM.b", "TEAM.a"]})
        self.assertEqual(h.executor(run_id="run-sig-order").run(), EXIT_PASS)

    def test_keychain_group_membership_change_fails_gate(self):
        h = self.harness()
        h.entitlement_dicts["2"] = dict(DEFAULT_ENTITLEMENTS,
                                        **{"keychain-access-groups": ["TEAM.groupB"]})
        self.assertEqual(h.executor(run_id="run-sig-group").run(), EXIT_FAIL)
        self.assertIn("Keychain", self.report(h, "run-sig-group")["reason"])

    def test_entitlement_value_change_fails_gate(self):
        h = self.harness()
        h.entitlement_dicts["2"] = dict(DEFAULT_ENTITLEMENTS,
                                        **{"com.apple.security.app-sandbox": False})
        self.assertEqual(h.executor(run_id="run-sig-bool").run(), EXIT_FAIL)
        self.assertIn("entitlements", self.report(h, "run-sig-bool")["reason"])

    def test_official_signature_identity_change_fails_gate(self):
        h = self.harness()
        for key in ("baseline", "1", "2"):
            h.details_fields[key] = {
                "Signature": "authority", "TeamIdentifier": "TEAM123",
                "Authority": ["Developer ID Application: A (TEAM123)"]}
        h.details_fields["2"] = {
            "Signature": "authority", "TeamIdentifier": "TEAM123",
            "Authority": ["Developer ID Application: B (TEAM123)"]}
        self.assertEqual(h.executor(run_id="run-sig-auth").run(), EXIT_FAIL)
        self.assertIn("Authority", self.report(h, "run-sig-auth")["reason"])

    def test_report_summary_includes_parse_status_and_identity(self):
        h = self.harness(phase1="blocked")
        self.assertEqual(h.executor(run_id="run-sig-summary").run(), EXIT_BLOCKED)
        report = self.report(h, "run-sig-summary")
        summary = report["signature"]["baseline"]
        self.assertEqual((summary.get("parseStatus") or {}).get("verify"), "ok",
                         "报告摘要必须含解析状态")
        self.assertEqual(summary.get("authorityChain"), [], "报告摘要必须含签名身份链")
        self.assertEqual(summary.get("signatureFormat"), "adhoc")
        self.assertIn("entitlementValues", summary, "报告摘要必须含授权配置")
        self.assertIn("signatureComparison", report, "报告必须含两阶段配置差异")


class ServiceHarnessTests(unittest.TestCase):
    """专用服务生命周期的真实进程边界测试（不用假进程）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1c-service-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_stop_confirms_exit_of_real_child_process(self):
        """回归：已退出但未回收的子进程对 kill(pid,0) 仍然"存活"，
        必须用 Popen.poll() 回收后确认退出，否则已停止的服务会被误判为没停。"""
        procs = ex.SystemProcs()
        harness = ex.ServiceHarness(procs=procs, run_dir=self.tmp, server_dir=self.tmp,
                                    node_bin="node")
        harness.port = 1
        harness.data_dir = self.tmp / "service-data"
        harness.handle = procs.spawn(["/bin/sleep", "30"], cwd=self.tmp,
                                     log_path=self.tmp / "sleep.log", env={})
        self.assertTrue(procs.alive(harness.handle.pid))
        self.assertTrue(harness.stop())
        self.assertFalse(procs.alive(harness.handle.pid))

    def test_stop_without_handle_is_ok(self):
        procs = ex.SystemProcs()
        harness = ex.ServiceHarness(procs=procs, run_dir=self.tmp, server_dir=self.tmp)
        self.assertTrue(harness.stop())


class BoundaryHelperTests(unittest.TestCase):
    def test_parse_etime(self):
        self.assertEqual(ex.parse_etime("01:30"), 90)
        self.assertEqual(ex.parse_etime("02:01:30"), 7290)
        self.assertEqual(ex.parse_etime("1-02:00:00"), 93600)

    def test_token_storage_key_matches_dart_derivation(self):
        key = ex.token_storage_key("http://127.0.0.1:8787", "t1c-run")
        raw = "http://127.0.0.1:8787\x00t1c-run".encode()
        expected = ("feedback_widget.bearer_token."
                    + base64.urlsafe_b64encode(raw).decode().rstrip("="))
        self.assertEqual(key, expected)

    def test_evaluate_cleanup_requires_both_flags(self):
        body = {"runId": RUN, "phase": "cleanup", "verdict": PASS, "reason": "ok",
                "identity": dict(IDENT),
                "cleanup": {"tokenCleared": True, "probeCleared": True}}
        self.assertEqual(evaluate_cleanup(body, RUN, IDENT)["verdict"], PASS)
        body["cleanup"]["probeCleared"] = False
        self.assertEqual(evaluate_cleanup(body, RUN, IDENT)["verdict"], FAIL)
        wrong_ident = dict(body, identity={"appId": "x", "username": "y"})
        self.assertEqual(evaluate_cleanup(wrong_ident, RUN, IDENT)["verdict"], FAIL)

    def test_artifact_from_executable_requires_build_products(self):
        inside = str(ex.EXAMPLES_DIR / "build/macos/Build/Products/Debug/"
                     "feedback_example.app/Contents/MacOS/feedback_example")
        self.assertTrue(ex.artifact_from_executable(inside, ex.EXAMPLES_DIR)
                        .endswith("feedback_example.app"))
        self.assertIsNone(ex.artifact_from_executable(
            "/tmp/elsewhere/feedback_example.app/Contents/MacOS/feedback_example",
            ex.EXAMPLES_DIR))
        self.assertIsNone(ex.artifact_from_executable(None, ex.EXAMPLES_DIR))

    def test_parse_diagnostic_report_and_timestamp(self):
        tmp = Path(tempfile.mkdtemp(prefix="t1c-ips-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        path = tmp / "feedback_example-2026-09-13-015858.ips"
        path.write_text(json.dumps({
            "app_name": "feedback_example", "timestamp": "2026-09-13 01:58:58.00 +0800",
            "slice_uuid": "d0d27d81-5cae-3644-bac8-cc455a1d4cc6",
            "incident_id": "A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724"}) + "\n" + json.dumps({
            "pid": 33996,
            "procPath": "/x/feedback_example.app/Contents/MacOS/feedback_example",
            "termination": {"namespace": "CODESIGNING",
                            "indicator": "Taskgated Invalid Signature"},
            "exception": {"signal": "SIGKILL (Code Signature Invalid)"}}))
        record = ex.parse_diagnostic_report(path)
        self.assertEqual(record["pid"], 33996)
        self.assertEqual(record["incidentId"], "A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724")
        self.assertTrue(signature_rejection_markers_in(record["message"]))
        self.assertIsNotNone(record["timestamp"])

    def test_launch_baseline_file_is_loadable(self):
        baseline = ex.load_launch_baseline(ex.REPO)
        self.assertTrue(baseline["available"])
        self.assertEqual(baseline["originalCrashReport"]["incidentId"],
                         "A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724")

    def test_parse_signature_details_and_entitlements(self):
        details = ex.parse_signature_details(
            "Identifier=dev.example.feedbackExample\n"
            "Signature=adhoc\nTeamIdentifier=not set\nCDHash=abc\n")
        self.assertEqual(details["identifier"], "dev.example.feedbackExample")
        self.assertEqual(details["signatureFormat"], "adhoc")
        self.assertEqual(details["cdhash"], "abc")
        values, status = ex.parse_entitlements_plist(plistlib.dumps({
            "com.apple.security.app-sandbox": True,
            "keychain-access-groups": ["TEAM.groupA"],
        }).decode())
        self.assertEqual(status, "ok")
        self.assertIn("keychain-access-groups", values)
        self.assertEqual(values["keychain-access-groups"], ["TEAM.groupA"])
        # 空输出 / 损坏 plist 不得当作空字典
        self.assertEqual(ex.parse_entitlements_plist("")[1], "error:empty-stdout")
        self.assertTrue(ex.parse_entitlements_plist("not a plist")[1]
                        .startswith("error:invalid-plist"))
        self.assertEqual(ex.parse_entitlements_plist(
            plistlib.dumps({}).decode()), ({}, "ok"))
        self.assertEqual(
            ex.extract_binary_uuid("UUID: D0D27D81-5CAE-3644-BAC8-CC455A1D4CC6 (arm64)"),
            "D0D27D81-5CAE-3644-BAC8-CC455A1D4CC6")


if __name__ == "__main__":
    unittest.main()
