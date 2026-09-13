#!/usr/bin/env python3
"""T1-C1 接收契约的真实隔离服务检查（不替代 Keychain 验收）。

T1-C1 把"提交成功"的判据从「界面出现已归档视图」换成「服务端真实接收」。
本检查用**真实隔离 Feedback 服务**（随机空闲端口 + 独立数据目录 + 运行时随机
管理员）验证该判据依赖的服务端契约确实成立：

  1. 登记本轮应用（`allowedOrigins` 空列表）并创建 `dailyLimit = 2` 的本轮账号；
  2. 以真实客户端方式登录（携带 appId 的令牌登录）并提交两次：
     第一次与第二次都必须 `201` + 非空 `feedbackId` + 非重放；
  3. 用同一 `idempotencyKey` 重放一次：必须 `200 replayed:true`，
     且**不得**产生新的接收（条数与用量都不变）；
  4. 经管理接口核对：本轮应用下 2 条反馈、归属为本轮账号、两个 ID 不同、用量 2；
  5. 收尾：禁用并核验账号、停止专用服务（保留隔离数据库供审查）。

隔离服务不配置 AI / Kaneo：后台归档会失败，但"已接收"不因此改变——这正是
阶段测试不再等待 `feedback-continue` 的原因。

退出码：0 = PASS，1 = FAIL（本检查不产生 BLOCKED）。

用法：`python3 e2e/t1c_receipt_contract_check.py`
"""
from __future__ import annotations

import json
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import http.client  # noqa: E402

from t1c_executor_lib import verify_receipts  # noqa: E402
from run_t1c_default_storage import (  # noqa: E402
    EXIT_FAIL,
    EXIT_PASS,
    HOST,
    RUNS_ROOT,
    AdminApi,
    ExecError,
    ServiceHarness,
    SystemProcs,
)


class ClientApi:
    """模拟 Flutter 客户端：手动带 Bearer 的 HTTP 客户端（不做管理登录）。"""

    def __init__(self, port: int):
        self.port = int(port)
        self.token = ""

    def call(self, path: str, method: str, body=None):
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            headers = {"content-type": "application/json"}
            if self.token:
                headers["authorization"] = f"Bearer {self.token}"
            payload = json.dumps(body) if body is not None else None
            conn.request(method, path, body=payload, headers=headers)
            res = conn.getresponse()
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw else {})
        finally:
            conn.close()

    def login(self, app_id: str, username: str, password: str):
        status, body = self.call("/api/auth/login", "POST", {
            "username": username, "password": password,
            "clientLabel": "t1c-receipt-contract", "appId": app_id,
        })
        if status == 200 and isinstance(body, dict) and body.get("token"):
            self.token = str(body["token"])
        return status, body

    def submit(self, app_id: str, text: str, idem_key: str):
        return self.call("/api/feedback", "POST", {
            "appId": app_id, "text": text, "idempotencyKey": idem_key,
        })


def main() -> int:
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-receipt-" + secrets.token_hex(3)
    run_dir = RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    app_id = f"t1c-{run_id}"
    username = app_id
    password = secrets.token_urlsafe(15)

    procs = SystemProcs()
    service = ServiceHarness(procs=procs, run_dir=run_dir)
    api = None
    service_handle = None
    problems: list[str] = []
    detail: dict = {"runId": run_id, "appId": app_id}
    account_disabled = False
    print(f"== T1-C1 接收契约检查 runId={run_id} ==")

    try:
        service_handle = service.start()
        detail["service"] = {"host": HOST, "port": service.port,
                             "dataDir": str(service.data_dir)}
        print(f"  [服务] 隔离服务 {HOST}:{service.port}（数据目录 {service.data_dir}）")

        api = AdminApi(service.port)
        status, _ = api.login(service.admin_user, service.admin_password)
        if status != 200:
            raise ExecError(f"专用服务管理员登录失败：HTTP {status}")

        status, body = api.create_app(app_id, app_id, [])
        if status != 201 or body.get("appId") != app_id:
            raise ExecError(f"登记应用失败：HTTP {status} {body}")
        status, body = api.list_apps()
        if status != 200 or not any(a.get("appId") == app_id
                                    for a in body.get("apps", [])):
            raise ExecError("应用登记回查不一致")

        status, body = api.create_user(username, password, 2)
        if status != 201 or body.get("dailyLimit") != 2:
            raise ExecError(f"创建账号失败：HTTP {status} {body}")
        user_id = body.get("id")

        client = ClientApi(service.port)
        status, body = client.login(app_id, username, password)
        if status != 200 or not client.token:
            raise ExecError(f"客户端令牌登录失败：HTTP {status} {body}")
        print("  [登录] 客户端令牌登录成功（携带本轮 appId）")

        receipts = []
        for index in (1, 2):
            key = f"{run_id}-{index}-{secrets.token_hex(4)}"
            status, body = client.submit(app_id, f"T1-C1 接收契约检查 #{index}", key)
            feedback_id = body.get("feedbackId") if isinstance(body, dict) else None
            replayed = bool(body.get("replayed")) if isinstance(body, dict) else False
            detail[f"submit{index}"] = {"httpStatus": status, "feedbackId": feedback_id,
                                        "replayed": replayed}
            if status != 201:
                problems.append(f"第 {index} 次提交未被接收：HTTP {status}")
            if not feedback_id:
                problems.append(f"第 {index} 次提交缺少 feedbackId")
            if replayed:
                problems.append(f"第 {index} 次提交被标记为重放")
            receipts.append((str(index), feedback_id, key))
            print(f"  [提交 {index}] HTTP {status}｜feedbackId={feedback_id}｜replayed={replayed}")

        # 幂等重放：必须 200 replayed:true，且不产生新的接收
        first_key = receipts[0][2]
        status, body = client.submit(app_id, "T1-C1 接收契约检查 #1", first_key)
        replayed = bool(body.get("replayed")) if isinstance(body, dict) else False
        detail["replay"] = {"httpStatus": status, "replayed": replayed,
                            "feedbackId": body.get("feedbackId") if isinstance(body, dict) else None}
        print(f"  [重放] HTTP {status}｜replayed={replayed}")
        if status != 200 or not replayed:
            problems.append(f"同一 idempotencyKey 重放未按契约返回 200 replayed:true（HTTP {status}）")
        if isinstance(body, dict) and body.get("feedbackId") != receipts[0][1]:
            problems.append("重放返回了不同的 feedbackId")

        # 管理接口核对
        status, body = api.list_feedback(app_id, limit=50)
        if status != 200:
            problems.append(f"反馈列表查询失败：HTTP {status}")
            items = None
        else:
            items = body.get("items")
        expected = [(phase, fid) for phase, fid, _key in receipts if fid]
        ok, reason, rc_detail = verify_receipts(items, expected, username, 2)
        detail["receipts"] = rc_detail
        if not ok:
            problems.append(f"接收核对失败：{reason}")
        else:
            print(f"  [核对] {reason}")

        status, body = api.list_users()
        me = next((u for u in body.get("users", []) if u.get("username") == username), None) \
            if status == 200 else None
        detail["usage"] = None if me is None else me.get("used")
        if me is None:
            problems.append(f"账号用量查询失败：HTTP {status}")
        elif me.get("used") != 2:
            problems.append(f"服务端用量 {me.get('used')} != 2（重放不得计入用量）")
        else:
            print(f"  [用量] 服务端用量 = {me.get('used')}（两次新接收，重放未计次）")

        detail["userId"] = user_id
    except (ExecError, Exception) as exc:  # noqa: BLE001 - 任何异常都进入统一收尾
        problems.append(f"{type(exc).__name__}: {exc}")
    finally:
        if api is not None and detail.get("userId"):
            try:
                status, body = api.set_enabled(detail["userId"], False)
                if status == 200:
                    _s, users = api.list_users()
                    me = next((u for u in users.get("users", [])
                               if u.get("username") == username), None)
                    account_disabled = bool(me is not None and me.get("enabled") is False)
                print(f"  [清理] 账号禁用并核验：{account_disabled}")
            except Exception as exc:  # noqa: BLE001
                problems.append(f"账号禁用失败：{exc}")
        try:
            stopped = service.stop()
        except Exception as exc:  # noqa: BLE001
            stopped = False
            problems.append(f"专用服务停止异常：{exc}")
        print(f"  [清理] 隔离服务已停止：{stopped}")
        if not stopped:
            problems.append("隔离服务未能确认停止")

    verdict = "PASS" if not problems else "FAIL"
    report = {
        "runId": run_id, "verdict": verdict, "problems": problems, "detail": detail,
        "accountDisabled": account_disabled,
        "isolation": {"mode": "isolated-service", "externalAi": False, "kaneo": False},
        "note": "本检查只验证接收契约；不替代 Keychain 验收",
    }
    (run_dir / "receipt-contract.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2))
    print(f"== 结果：{verdict}（退出码 {EXIT_PASS if verdict == 'PASS' else EXIT_FAIL}）==")
    for problem in problems:
        print(f"  - {problem}")
    print(f"== 证据：{run_dir / 'receipt-contract.json'}")
    return EXIT_PASS if verdict == "PASS" else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
