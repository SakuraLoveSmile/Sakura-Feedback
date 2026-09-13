#!/usr/bin/env python3
"""T1-C 默认安全存储验收 · 统一执行入口（隔离服务 + 两阶段 + 统一收尾）。

流程（第 9 轮修复后的执行器）：

  1. 取仓库级排他锁（防止并发构建同一 macOS 示例），创建本轮唯一 runId 目录。
  2. 自行启动**专用** Feedback 服务：本轮独立数据目录、随机测试管理员凭据、
     空闲本地端口；就绪检查同时确认本次进程仍存活。不再 `source .env`
     连接既有 8787 服务。
  3. 经管理接口登记本轮应用（`POST /api/admin/apps`，`allowedOrigins` 为空
     列表），回查一致；再创建每日额度为 2 的本轮账号，回查一致。
  4. 构建（debug，两阶段共用）→ 阶段 1（`phase1.json`）→ 等待并确认应用
     进程退出 → 阶段 2（读 `phase1.json`、写 `phase2.json`）→ 服务端核对
     本轮账号用量与反馈条数。
  5. 统一收尾：必要时调用受本轮身份约束的兜底清理入口、禁用本轮账号并
     核验、停止专用服务、删除参数文件；保留隔离数据库与报告供审查。
  6. 退出码：0=PASS，1=FAIL，2=BLOCKED（仅明确识别的缺少 entitlement）。

用法：`python3 e2e/run_t1c_default_storage.py`（不需要 source .env）。

安全约束：
  - 管理接口只连字面量环回地址 127.0.0.1，路径为白名单常量；
  - 全部子进程使用参数数组 + 显式 `shell=False`；本轮动态参数（runId、
    身份、结果/握手文件路径）经字符集白名单与目录边界校验后写入**本轮
    专属**参数文件（权限 0600，结束后删除），路径作为单独参数传入
    `--dart-define-from-file=<path>`，不做命令行字符串拼接；
  - 口令与管理凭据运行时随机生成、不入日志/报告；
  - 只管理本轮自己启动的进程：按进程组记录，应用进程必须经本轮结构化
    握手 + 用户/可执行路径/启动时间核验后才允许管理；不使用
    `pgrep/pkill` 之类的路径片段匹配。
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import http.client
import json
import os
import plistlib
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from t1c_executor_lib import (  # noqa: E402
    BLOCKED,
    LAUNCH_SIGNATURE_INVALID,
    EXIT_BLOCKED,
    EXIT_FAIL,
    EXIT_PASS,
    FAIL,
    NOT_RUN,
    PASS,
    acceptance_of,
    classify_launch,
    compare_signature_evidence,
    decide_overall,
    digest_of,
    distinct_phase_paths,
    evaluate_cleanup,
    evaluate_phase,
    evaluate_signature_evidence,
    compare_entitlement_values,
    keychain_entitlements,
    phase1_intact,
    signature_rejection_markers_in,
    verify_receipts,
)

# ---------------------------------------------------------------- 常量

REPO = Path(__file__).resolve().parent.parent
RUNS_ROOT = (REPO / "e2e" / "t1c-runs").resolve()
LOCK_PATH = RUNS_ROOT / ".t1c-exclusive.lock"
EXAMPLES_DIR = (REPO / "examples" / "flutter").resolve()
SERVER_DIR = (REPO / "apps" / "server").resolve()
FLUTTER_BIN = os.environ.get("T1C_FLUTTER_BIN", "/Users/sakurasep/flutter/bin/flutter")
NODE_BIN = os.environ.get("T1C_NODE_BIN", "node")

PHASE_TIMEOUT_S = 900          # 阶段/构建总超时（沿用）
SERVICE_READY_TIMEOUT_S = 90   # 专用服务就绪等待
APP_EXIT_WAIT_S = 15           # 阶段结束后等待应用退出
KILL_GRACE_S = 15              # 强制结束前的宽限
STOP_WAIT_S = 20               # 专用服务停止等待

HOST = "127.0.0.1"             # 字面量环回地址

# 阶段 → 集成测试文件（常量，不参与字符串拼接）
PHASE_TESTS = {
    "1": "integration_test/t1c_secure_storage_write_test.dart",
    "2": "integration_test/t1c_secure_storage_recovery_test.dart",
    "cleanup": "integration_test/t1c_secure_storage_cleanup_test.dart",
}

SAFE_VALUE = re.compile(r"^[A-Za-z0-9._@:/-]+$")     # 标识类（无空格）
SAFE_PATH = re.compile(r"^[A-Za-z0-9._@:/ =-]+$")    # 文件路径（允许空格）

# 管理接口路径白名单（服务固定为本机字面量环回地址）
PATH_HEALTH = "/healthz"
PATH_LOGIN = "/api/auth/login"
PATH_APPS = "/api/admin/apps"
PATH_USERS = "/api/admin/users"
PATH_USER_BY_ID = re.compile(r"^/api/admin/users/[0-9a-fA-F-]{36}$")
PATH_FEEDBACK = "/api/admin/feedback"

# 签名证据采集命令（模块级字面量列表；目标路径经边界检查后作为单独参数传入）
CMD_VERIFY = ["codesign", "--verify", "--deep", "--strict", "--verbose=2"]
CMD_DETAILS = ["codesign", "-dv", "--verbose=4"]
CMD_ENTITLEMENTS = ["codesign", "-d", "--entitlements", ":-"]
CMD_UUID = ["dwarfdump", "--uuid"]
CMD_SECURITY_IDENTITIES = ["security", "find-identity", "-v", "-p", "codesigning"]

#: 签名证据必须来自本轮构建产物目录
BUILD_PRODUCTS = ("build", "macos", "Build", "Products")

#: 各签名命令的**权威输出流**（实测 codesign 行为，避免诊断文本混入解析）：
#:   - `codesign -dv --verbose=4` 的显示输出在 **stderr**（stdout 为空）；
#:   - `codesign -d --entitlements :-` 的 plist 在 **stdout**（stderr 只有
#:     `Executable=` 与弃用警告）；
#:   - `dwarfdump --uuid` 在 stdout；`codesign --verify` 只用退出码。
SIGNATURE_OUTPUT_STREAM = {
    "verify": None,
    "details": "stderr",
    "entitlements": "stdout",
    "uuidCommand": "stdout",
}

#: 用户提供的启动签名失败基线（历史事件；只登记，不当作当前失败证据）
LAUNCH_BASELINE_FILE = ("e2e", "t1c-launch-baseline.json")


class ExecError(Exception):
    """执行器流程错误（按 FAIL 结束并写入结构化报告）。"""


# ---------------------------------------------------------------- 进程边界

@dataclass
class ProcHandle:
    pid: int
    pgid: int
    cmd: tuple
    log_path: Path
    proc: object = None          # subprocess.Popen（真实实现）；测试实现可留空
    fh: object = None


class SystemProcs:
    """真实进程边界：启动/等待/核实/终止。全部使用参数数组 + shell=False。"""

    def spawn(self, cmd, cwd, log_path, env=None) -> ProcHandle:
        fh = open(log_path, "w")
        try:
            proc = subprocess.Popen(
                list(cmd), cwd=str(cwd), stdout=fh, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=True, shell=False,
                env=env if env is not None else os.environ.copy(),
            )
        except OSError as exc:
            fh.close()
            raise ExecError(f"无法启动子进程 {cmd[0]!r}：{exc}") from exc
        return ProcHandle(pid=proc.pid, pgid=os.getpgid(proc.pid),
                          cmd=tuple(cmd), log_path=Path(log_path), proc=proc, fh=fh)

    def wait(self, handle: ProcHandle, timeout):
        try:
            code = handle.proc.wait(timeout=timeout)
            return code, False
        except subprocess.TimeoutExpired:
            return None, True

    def poll(self, handle: ProcHandle):
        """非阻塞回收子进程：返回退出码，仍在运行返回 None。

        必须用 `Popen.poll()`（会回收僵尸子进程）而不是 `os.kill(pid, 0)`：
        已退出但未回收的子进程对 `kill(pid, 0)` 仍然"存活"，会把已经停止的
        服务误判成没停。
        """
        if handle.proc is None:
            return None if self.alive(handle.pid) else 0
        return handle.proc.poll()

    def close(self, handle: ProcHandle):
        try:
            if handle.fh is not None:
                handle.fh.close()
        except OSError:
            pass

    def alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def group_alive(self, pgid: int) -> bool:
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def signal_group(self, pgid: int, sig: int):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def kill(self, pid: int, sig: int):
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def describe(self, pid: int):
        """返回 {"uid": int, "exe": str, "startedAt": float} 或 None（进程不存在）。"""
        try:
            out = subprocess.run(
                ["ps", "-ww", "-p", str(pid), "-o", "uid=,etime=,command="],
                capture_output=True, text=True, timeout=10, shell=False)
        except Exception:
            return None
        line = (out.stdout or "").strip()
        if not line or out.returncode != 0:
            return None
        parts = line.split(None, 2)
        if len(parts) < 3:
            return None
        try:
            uid = int(parts[0])
            elapsed = parse_etime(parts[1])
        except ValueError:
            return None
        return {"uid": uid, "exe": parts[2].strip(), "startedAt": time.time() - elapsed}


def parse_etime(text: str) -> int:
    """解析 `ps -o etime=` 的 `[[dd-]hh:]mm:ss`。"""
    text = text.strip()
    days = 0
    if "-" in text:
        head, text = text.split("-", 1)
        days = int(head)
    cols = [int(p) for p in text.split(":")]
    if len(cols) == 2:
        hours, minutes, seconds = 0, cols[0], cols[1]
    elif len(cols) == 3:
        hours, minutes, seconds = cols
    else:
        raise ValueError(f"无法解析 etime：{text!r}")
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


# ---------------------------------------------------------------- 专用服务

def free_port() -> int:
    """向系统申请一个空闲本地端口（仅绑定时占用，随即释放）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, 0))
        return int(s.getsockname()[1])


class ServiceHarness:
    """本轮专用 Feedback 服务：独立数据目录 + 随机管理员 + 空闲端口。"""

    def __init__(self, *, procs, run_dir: Path, server_dir=SERVER_DIR,
                 node_bin=NODE_BIN, sleep=time.sleep, clock=time.time,
                 ready_timeout_s=SERVICE_READY_TIMEOUT_S):
        self.procs = procs
        self.run_dir = Path(run_dir)
        self.server_dir = Path(server_dir)
        self.node_bin = node_bin
        self.sleep = sleep
        self.clock = clock
        self.ready_timeout_s = ready_timeout_s
        self.handle = None
        self.port = None
        self.data_dir = None
        self.admin_user = ""
        self.admin_password = ""
        self.log_path = self.run_dir / "service.log"

    def start(self) -> dict:
        self.port = free_port()
        self.data_dir = self.run_dir / "service-data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.admin_user = "t1c-admin-" + secrets.token_hex(4)
        self.admin_password = secrets.token_urlsafe(18)
        env = os.environ.copy()
        env.update({
            "FEEDBACK_DATA_DIR": str(self.data_dir),
            "FEEDBACK_PORT": str(self.port),
            "FEEDBACK_MASTER_KEY": base64.b64encode(os.urandom(32)).decode(),
            "FEEDBACK_ADMIN_USER": self.admin_user,
            "FEEDBACK_ADMIN_PASSWORD": self.admin_password,
            "FEEDBACK_COOKIE_SECURE": "0",
        })
        cmd = [self.node_bin, "--import", "tsx", "src/index.ts"]
        self.handle = self.procs.spawn(cmd, cwd=self.server_dir,
                                       log_path=self.log_path, env=env)
        deadline = self.clock() + self.ready_timeout_s
        while self.clock() < deadline:
            # 就绪检查必须同时确认本次进程仍存活
            if not self.procs.alive(self.handle.pid):
                raise ExecError(
                    f"专用服务进程已退出（pid={self.handle.pid}），日志：{self.log_path}")
            try:
                status, _ = self.api_call(PATH_HEALTH, "GET")
                if status == 200:
                    return {**self.info(), "adminPassword": self.admin_password}
            except Exception:
                pass
            self.sleep(0.5)
        raise ExecError(
            f"专用服务未在 {self.ready_timeout_s}s 内就绪（127.0.0.1:{self.port}），"
            f"日志：{self.log_path}")

    def info(self) -> dict:
        return {
            "host": HOST,
            "port": self.port,
            "pid": getattr(self.handle, "pid", None),
            "pgid": getattr(self.handle, "pgid", None),
            "dataDir": str(self.data_dir),
            "log": str(self.log_path),
            "adminUser": self.admin_user,
        }

    def api_call(self, path, method, body=None):
        conn = http.client.HTTPConnection(HOST, self.port, timeout=5)
        try:
            payload = json.dumps(body) if body is not None else None
            conn.request(method, path, body=payload,
                         headers={"content-type": "application/json"})
            res = conn.getresponse()
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw else {})
        finally:
            conn.close()

    def stop(self) -> bool:
        """停止本轮专用服务并确认已退出（按退出码回收，不把僵尸当存活）。"""
        if self.handle is None:
            return True
        pgid, pid = self.handle.pgid, self.handle.pid
        if self.procs.poll(self.handle) is not None:
            self.procs.close(self.handle)
            return True
        self.procs.signal_group(pgid, signal.SIGTERM)
        deadline = self.clock() + STOP_WAIT_S
        while self.clock() < deadline:
            if self.procs.poll(self.handle) is not None:
                self.procs.close(self.handle)
                return True
            self.sleep(0.3)
        self.procs.signal_group(pgid, signal.SIGKILL)
        self.procs.kill(pid, signal.SIGKILL)
        deadline = self.clock() + 10
        while self.clock() < deadline:
            if self.procs.poll(self.handle) is not None:
                break
            self.sleep(0.3)
        stopped = self.procs.poll(self.handle) is not None
        self.procs.close(self.handle)
        return stopped


# ---------------------------------------------------------------- 管理接口

class AdminApi:
    """受限管理客户端：只连字面量 127.0.0.1，路径白名单，无动态 URL 拼接。"""

    def __init__(self, port: int):
        self.port = int(port)
        self.cookie = ""

    def call(self, path: str, method: str, body=None, query=None):
        assert path in (PATH_HEALTH, PATH_LOGIN, PATH_APPS, PATH_USERS, PATH_FEEDBACK) \
            or PATH_USER_BY_ID.fullmatch(path), f"非白名单路径：{path}"
        target = path
        if query:
            target = f"{path}?{urllib.parse.urlencode(query)}"
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            headers = {"content-type": "application/json"}
            if self.cookie:
                headers["cookie"] = self.cookie
            payload = json.dumps(body) if body is not None else None
            conn.request(method, target, body=payload, headers=headers)
            res = conn.getresponse()
            set_cookie = res.getheader("set-cookie")
            if set_cookie:
                self.cookie = set_cookie.split(";")[0]
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw else {})
        finally:
            conn.close()

    def login(self, username: str, password: str):
        return self.call(PATH_LOGIN, "POST", {"username": username, "password": password})

    def create_app(self, app_id: str, name: str, allowed_origins):
        return self.call(PATH_APPS, "POST", {
            "appId": app_id, "name": name, "allowedOrigins": list(allowed_origins)})

    def list_apps(self):
        return self.call(PATH_APPS, "GET")

    def create_user(self, username: str, password: str, daily_limit: int):
        return self.call(PATH_USERS, "POST", {
            "username": username, "password": password, "dailyLimit": daily_limit})

    def list_users(self):
        return self.call(PATH_USERS, "GET")

    def set_enabled(self, user_id: str, enabled: bool):
        return self.call(f"/api/admin/users/{user_id}", "PATCH", {"enabled": enabled})

    def list_feedback(self, app_id: str, limit: int = 50):
        return self.call(PATH_FEEDBACK, "GET", query={"appId": app_id, "limit": limit})


# ---------------------------------------------------------------- 工具

def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def is_within(path: Path, base: Path) -> bool:
    try:
        p = Path(path).resolve()
        b = base.resolve()
    except OSError:
        return False
    return p == b or b in p.parents


def validate_value(kind: str, value: str, path: bool = False) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{kind} 必须是非空字符串")
    pattern = SAFE_PATH if path else SAFE_VALUE
    if not pattern.fullmatch(value):
        allowed = "A-Za-z0-9._@:/ =-" if path else "A-Za-z0-9._@:/-"
        raise ValueError(f"{kind} 含白名单之外的字符（仅允许 {allowed}）")
    return value


def token_state_of(result):
    """从阶段结果读取本轮令牌键状态证据。

    返回 "absent"（cleanup.tokenCleared == true）/ "maybe"（== false）/
    None（无证据）。**不推断**：没有显式证据就是 None。
    """
    if not isinstance(result, dict):
        return None
    cleanup = result.get("cleanup")
    if not isinstance(cleanup, dict):
        return None
    value = cleanup.get("tokenCleared")
    if value is True:
        return "absent"
    if value is False:
        return "maybe"
    return None


def token_storage_key(api_base: str, app_id: str) -> str:
    """复现 `feedbackTokenStorageKey`（只用于报告残留键身份，不含令牌值）。"""
    identity = f"{api_base}\x00{app_id}".encode()
    encoded = base64.urlsafe_b64encode(identity).decode().rstrip("=")
    return f"feedback_widget.bearer_token.{encoded}"


def load_launch_baseline(repo: Path) -> dict:
    """读取用户提供的启动签名失败基线（只登记，不当作当前失败证据）。"""
    path = Path(repo).joinpath(*LAUNCH_BASELINE_FILE)
    data = read_json(path)
    if not isinstance(data, dict):
        return {"available": False, "path": str(path)}
    return {"available": True, "path": str(path), **data}


def artifact_from_executable(exe_path, examples_dir: Path):
    """由握手里的实际可执行路径定位本轮 `.app`（必须位于本轮构建产物目录）。"""
    if not isinstance(exe_path, str) or not exe_path:
        return None
    parts = Path(exe_path).parts
    for idx in range(len(parts), 0, -1):
        if str(parts[idx - 1]).endswith(".app"):
            candidate = Path(*parts[:idx])
            break
    else:
        return None
    if not is_within(candidate, Path(examples_dir) / "build" / "macos"):
        return None
    return str(candidate)


def parse_signature_details(text: str) -> dict:
    """从 `codesign -dv --verbose=4` 的 **stdout** 解析标识、Team、类型与 Authority 链。"""
    identifier = team = cdhash = ""
    authorities = []
    signature_line = ""
    for line in str(text or "").splitlines():
        if line.startswith("Identifier="):
            identifier = line.split("=", 1)[1].strip()
        elif line.startswith("TeamIdentifier="):
            team = line.split("=", 1)[1].strip()
        elif line.startswith("Signature="):
            signature_line = line.split("=", 1)[1].strip()
        elif line.startswith("CDHash="):
            cdhash = line.split("=", 1)[1].strip()
        elif line.startswith("Authority="):
            authorities.append(line.split("=", 1)[1].strip())
    if authorities:
        fmt = "authority"
    elif signature_line == "adhoc" or "flags=0x2(adhoc)" in str(text):
        fmt = "adhoc"
    elif signature_line:
        fmt = "authority" if signature_line not in ("adhoc",) else "adhoc"
    else:
        fmt = "unknown"
    return {"identifier": identifier, "teamIdentifier": team,
            "signatureFormat": fmt, "cdhash": cdhash,
            "authorityChain": authorities}


def json_safe_plist(value):
    """把 plistlib 的解析结果转成 JSON 安全的形状（保留类型差异）。"""
    if isinstance(value, bool) or isinstance(value, (int, float, str)) or value is None:
        return value
    if isinstance(value, bytes):
        return {"__plist_type__": "data",
                "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, datetime):
        return {"__plist_type__": "date", "value": value.isoformat()}
    if isinstance(value, (list, tuple)):
        return [json_safe_plist(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe_plist(v) for k, v in sorted(value.items())}
    return {"__plist_type__": type(value).__name__, "value": repr(value)}


def extract_binary_uuid(text: str) -> str:
    """从 `dwarfdump --uuid` 的 **stdout** 提取 Mach-O UUID。"""
    match = re.search(r"UUID:\s*([0-9A-Fa-f-]{36})", str(text or ""))
    return match.group(1).upper() if match else ""


def parse_entitlements_plist(text):
    """用 plistlib 解析 entitlements，返回 (值字典|None, 状态)。

    空字典是有效配置；**空输出或损坏的 plist 不得当作空字典**。
    """
    if not isinstance(text, str) or not text.strip():
        return None, "error:empty-stdout"
    try:
        parsed = plistlib.loads(text.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - 任何解析失败都算失败
        return None, f"error:invalid-plist:{type(exc).__name__}"
    if not isinstance(parsed, dict):
        return None, f"error:not-a-dict:{type(parsed).__name__}"
    return json_safe_plist(parsed), "ok"


def parse_ips_timestamp(raw):
    """解析 `.ips` 头里的时间戳（`2026-09-13 01:58:58.00 +0800`）。"""
    if not isinstance(raw, str):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z"):
        try:
            return datetime.strptime(raw.strip(), fmt).timestamp()
        except ValueError:
            continue
    return None


def parse_diagnostic_report(path):
    """解析一份 `.ips`：只读事件时间 / PID / 终止原因 / 进程路径，用于匹配本轮。"""
    try:
        text = Path(path).read_text(errors="replace")
    except OSError:
        return None
    head, _, rest = text.partition("\n")
    try:
        header = json.loads(head)
    except Exception:
        header = {}
    try:
        body = json.loads(rest) if rest.strip() else {}
    except Exception:
        body = {}
    termination = body.get("termination") or {}
    namespace = str(termination.get("namespace") or "")
    indicator = str(termination.get("indicator") or "")
    signal = str((body.get("exception") or {}).get("signal") or "")
    message = " ".join(x for x in (namespace, indicator) if x) or signal or "diagnostic report"
    return {
        "source": "diagnostic-report",
        "path": str(path),
        "message": f"{message}（signal={signal}）",
        "pid": body.get("pid"),
        "timestamp": parse_ips_timestamp(header.get("timestamp")),
        "artifactPath": str(body.get("procPath") or ""),
        "incidentId": header.get("incident_id"),
        "sliceUuid": header.get("slice_uuid"),
        "appName": header.get("app_name"),
    }


def command_parse_status(command):
    """单条签名命令的采集状态：ok / error:...（超时、无退出码、非零退出）。"""
    if not isinstance(command, dict):
        return "error:no-result"
    if command.get("timedOut") is True:
        return "error:timeout"
    code = command.get("exitCode")
    if code is None:
        return "error:no-exit-code"
    if code != 0:
        return f"error:exit-{code}"
    return "ok"


# ---------------------------------------------------------------- 执行器

@dataclass
class RunPaths:
    root: Path
    run_id: str
    history: Path

    def __post_init__(self):
        self.build_log = self.root / "build.log"
        self.phase1_log = self.root / "phase1.log"
        self.phase2_log = self.root / "phase2.log"
        self.cleanup_log = self.root / "cleanup.log"
        self.params = self.root / "params.json"
        self.cleanup_params = self.root / "cleanup-params.json"
        self.report = self.root / "report.json"
        self.result_dir = None       # 沙盒容器内本轮结果目录（稍后确定）


class Executor:
    """T1-C 统一验收执行器。外部边界（进程、管理接口、服务、时钟）可注入。"""

    def __init__(self, *, procs, api_factory, service_factory,
                 runs_root: Path = RUNS_ROOT, repo: Path = REPO,
                 examples_dir: Path = EXAMPLES_DIR, server_dir: Path = SERVER_DIR,
                 flutter_bin: str = FLUTTER_BIN, node_bin: str = NODE_BIN,
                 run_id: str | None = None, uid: int | None = None,
                 clock=time.time, sleep=time.sleep,
                 phase_timeout_s: int = PHASE_TIMEOUT_S,
                 app_exit_wait_s: int = APP_EXIT_WAIT_S,
                 kill_grace_s: int = KILL_GRACE_S,
                 lock_path: Path | None = None,
                 lock_enabled: bool = True,
                 bundle_id: str | None = None,
                 container_root: Path | None = None,
                 signing_provider=None,
                 diagnostic_dirs=None,
                 cmd_runner=None):
        self.procs = procs
        self.api_factory = api_factory
        self.service_factory = service_factory
        self.runs_root = Path(runs_root).resolve()
        self.repo = Path(repo).resolve()
        self.examples_dir = Path(examples_dir).resolve()
        self.server_dir = Path(server_dir).resolve()
        self.flutter_bin = flutter_bin
        self.node_bin = node_bin
        self.clock = clock
        self.sleep = sleep
        self.phase_timeout_s = phase_timeout_s
        self.app_exit_wait_s = app_exit_wait_s
        self.kill_grace_s = kill_grace_s
        self.lock_enabled = lock_enabled
        self.lock_path = Path(lock_path) if lock_path else (self.runs_root / LOCK_PATH.name)
        self.bundle_id_override = bundle_id
        self.container_root = Path(container_root) if container_root else None
        self.signing_provider = signing_provider
        # 诊断报告目录（默认本机 DiagnosticReports；测试注入临时目录）
        self.diagnostic_dirs = [Path(d) for d in (
            diagnostic_dirs if diagnostic_dirs is not None
            else [Path.home() / "Library" / "Logs" / "DiagnosticReports"])]
        # 签名检查命令执行器（参数数组 + shell=False；测试注入假实现）
        self.cmd_runner = cmd_runner or (lambda argv, key: self._run_cmd(argv))
        self.uid = os.getuid() if uid is None else uid

        self.run_id = run_id or (time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
        self.paths: RunPaths | None = None
        self.service: ServiceHarness | None = None
        self.api = None
        self.app_id = f"t1c-{self.run_id}"
        self.username = self.app_id
        self.password = secrets.token_urlsafe(15)
        self.user_id = None
        self.service_url = ""   # 专用服务启动后按实际端口重写

        self.p1 = {"verdict": NOT_RUN, "reason": "未执行"}
        self.p2 = {"verdict": NOT_RUN, "reason": "未执行"}
        self.usage = {"ok": False, "expected": "阶段 1 接收 1 条 / 用量 1；最终 2 条不同 feedbackId / 用量 2"}
        self.cleanup = {
            "accountDisabled": False, "accountDisableVerified": False,
            "serviceStopped": False, "paramsRemoved": False,
            "dartCleanup": NOT_RUN, "dartCleanupDetail": "",
            "residualKeys": [], "serviceDataDir": None,
            "writerStopped": None, "writerStopDetail": "",
            "credentialCleanupConfirmed": None,
            "processSteps": [], "cleanupSteps": [],
        }
        self.versions = {"flutter": "", "flutter_secure_storage": "", "flutter_secure_storage_macos": ""}
        self.signing = {}
        # 签名证据：{"baseline"|"1"|"2": {...}}；启动分类：{"1"|"2": {...}}
        self.signature: dict = {}
        self.signature_comparison: dict = {
            "ok": False, "problems": ["尚未采集两阶段签名证据"], "detail": {}}
        self.launch: dict = {}
        self.acceptance: dict = {}
        self.receipts: dict = {"phase1": None, "final": None, "usage": None}
        self.launch_baseline = load_launch_baseline(self.repo)
        self.ledger: list[dict] = []
        self.error: str | None = None
        self._lock_fd = None
        # 本轮令牌键状态："unknown"（阶段 1 未执行）/ "absent"（已确认清空）
        # / "maybe"（可能有残留）。只按阶段自己给出的证据判定，不推断。
        self._token_state = "unknown"
        self._started_handles: list[ProcHandle] = []
        self._handshakes: dict = {}
        self._phase_windows: dict = {}
        self.artifact_path = None

    # ------------------------------------------------------------ 日志与账本

    def log(self, msg: str):
        print(msg, flush=True)

    def _ledger_add(self, kind: str, ident: str, **extra):
        entry = {"kind": kind, "id": ident, "cleaned": False}
        entry.update(extra)
        self.ledger.append(entry)
        self._persist_manifest()
        return entry

    def _persist_manifest(self):
        """资源清单**随创建即时落盘**：收尾（含再次中断）期间也不会丢失。"""
        if self.paths is None:
            return
        try:
            (self.paths.root / "resources.json").write_text(json.dumps(
                {"runId": self.run_id, "resources": self.ledger,
                 "processes": [self._handle_record(h) for h in self._started_handles]},
                ensure_ascii=False, indent=2))
        except OSError as exc:
            self.log(f"  [清单] 落盘失败：{exc}")

    @staticmethod
    def _handle_record(handle: ProcHandle) -> dict:
        return {"pid": handle.pid, "pgid": handle.pgid,
                "cmd": list(handle.cmd), "log": str(handle.log_path)}

    # ------------------------------------------------------------ 锁与目录

    def _acquire_lock(self) -> bool:
        if not self.lock_enabled:
            return True
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._lock_fd = fd
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()} {self.run_id}\n".encode())
        return True

    def _release_lock(self):
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = None

    def _prepare_paths(self):
        root = self.runs_root / self.run_id
        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        self.paths = RunPaths(root=root, run_id=self.run_id,
                              history=self.runs_root / "history.jsonl")
        bundle = self.bundle_id_override or self._read_bundle_id()
        if self.container_root is not None:
            # 测试注入：把"沙盒容器目录"重定向到临时目录，绝不写真实用户主目录
            result_dir = self.container_root / bundle / "Data" / "Documents" / "t1c" / self.run_id
        else:
            result_dir = (Path.home() / "Library" / "Containers" / bundle /
                          "Data" / "Documents" / "t1c" / self.run_id)
        result_dir.mkdir(parents=True, exist_ok=True)
        self.paths.result_dir = result_dir

    def _read_bundle_id(self) -> str:
        xcconfig = self.examples_dir / "macos" / "Runner" / "Configs" / "AppInfo.xcconfig"
        try:
            text = xcconfig.read_text()
        except OSError as exc:
            raise ExecError(f"无法读取 {xcconfig}：{exc}") from exc
        m = re.search(r"PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(\S+)", text)
        bundle = m.group(1) if m else ""
        if not re.fullmatch(r"[A-Za-z0-9.]+", bundle):
            raise ExecError(f"无法从 AppInfo.xcconfig 解析出合法 bundle id：{bundle!r}")
        return bundle

    # ------------------------------------------------------------ 参数文件

    def _params_for(self, phase: str) -> dict:
        result_dir = self.paths.result_dir
        params = {
            "T1C_RUN_ID": validate_value("runId", self.run_id),
            "T1C_APP_ID": validate_value("appId", self.app_id),
            "T1C_TEST_USERNAME": validate_value("username", self.username),
            "T1C_TEST_PASSWORD": self.password,
            "T1C_SERVICE_URL": validate_value("serviceUrl", self.service_url),
            "T1C_RESULT_FILE": validate_value(
                "resultFile", str(result_dir / f"phase{phase}.json"), path=True),
            "T1C_HANDSHAKE_FILE": validate_value(
                "handshakeFile", str(result_dir / f"phase{phase}-handshake.json"), path=True),
        }
        if phase == "2":
            params["T1C_PHASE1_FILE"] = validate_value(
                "phase1File", str(result_dir / "phase1.json"), path=True)
            ok, reason = distinct_phase_paths(
                params["T1C_PHASE1_FILE"], params["T1C_RESULT_FILE"])
            if not ok:
                raise ExecError(reason)
        for key, value in params.items():
            is_path = key in ("T1C_RESULT_FILE", "T1C_HANDSHAKE_FILE", "T1C_PHASE1_FILE")
            if key == "T1C_TEST_PASSWORD":
                continue  # 口令允许任意字符（只在 0600 参数文件里，不进命令行/日志）
            validate_value(key, value, path=is_path)
            if is_path and not is_within(Path(value), result_dir):
                raise ExecError(f"{key} 越过本轮结果目录边界：{value}")
        return params

    def _params_for_cleanup(self) -> dict:
        result_dir = self.paths.result_dir
        params = {
            "T1C_RUN_ID": validate_value("runId", self.run_id),
            "T1C_APP_ID": validate_value("appId", self.app_id),
            "T1C_TEST_USERNAME": validate_value("username", self.username),
            "T1C_TEST_PASSWORD": self.password,
            "T1C_SERVICE_URL": validate_value("serviceUrl", self.service_url),
            "T1C_RESULT_FILE": validate_value(
                "resultFile", str(result_dir / "cleanup.json"), path=True),
        }
        if not is_within(Path(params["T1C_RESULT_FILE"]), result_dir):
            raise ExecError("兜底清理结果路径越过本轮结果目录边界")
        return params

    def _write_params(self, path: Path, params: dict) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(params, ensure_ascii=False, indent=2))
        os.chmod(path, 0o600)
        return path

    # ------------------------------------------------------------ 子进程

    def _spawn_wait(self, cmd, log_path: Path, timeout: float, cwd: Path):
        handle = self.procs.spawn(cmd, cwd=cwd, log_path=Path(log_path), env=None)
        self._started_handles.append(handle)
        code, timed_out = self.procs.wait(handle, timeout)
        if timed_out:
            self._terminate_round_processes(handle)
        return code, timed_out, handle

    def _terminate_round_processes(self, handle: ProcHandle):
        """先终止本轮进程组；宽限期后仍存活才强制结束本轮剩余进程。"""
        self.procs.signal_group(handle.pgid, signal.SIGTERM)
        deadline = self.clock() + self.kill_grace_s
        while self.clock() < deadline:
            if not self.procs.group_alive(handle.pgid):
                return
            self.sleep(0.3)
        self.procs.signal_group(handle.pgid, signal.SIGKILL)

    def _flutter_test_cmd(self, test_file: str, params_path: Path):
        # 动态路径经边界检查后作为**单独参数**传入，不做字符串拼接
        return [self.flutter_bin, "test", test_file, "-d", "macos",
                f"--dart-define-from-file={params_path}"]

    # ------------------------------------------------------------ 启动与预检

    def _boot(self):
        self.service = self.service_factory(run_dir=self.paths.root, procs=self.procs)
        info = self.service.start()
        self._ledger_add("service", f"{HOST}:{info['port']}",
                         dataDir=info["dataDir"], pid=info.get("pid"))
        self.cleanup["serviceDataDir"] = info["dataDir"]
        self.service_url = f"http://{HOST}:{info['port']}"
        self.log(f"  [服务] 本轮专用服务 {self.service_url}（数据目录 {info['dataDir']}）")

        self.api = self.api_factory(info["port"])
        try:
            status, _body = self.api.login(info["adminUser"], info["adminPassword"])
        except Exception as exc:
            raise ExecError(f"专用服务管理员登录异常：{exc}") from exc
        if status != 200:
            raise ExecError(f"专用服务管理员登录失败：HTTP {status}")

        self._register_app()
        self._create_user()
        self._collect_versions()
        self.log(f"  [预检] 应用 {self.app_id}；账号 {self.username}；"
                 f"版本 {self.versions}")

    def _register_app(self):
        """登记本轮应用并回查一致（原生测试 allowedOrigins 使用空列表）。"""
        try:
            status, body = self.api.create_app(self.app_id, self.app_id, [])
        except Exception as exc:
            raise ExecError(f"登记本轮应用失败：{exc}") from exc
        if status != 201:
            raise ExecError(
                f"登记本轮应用失败：HTTP {status} {json.dumps(body, ensure_ascii=False)[:200]}")
        entry = self._ledger_add("app", self.app_id)
        if body.get("appId") != self.app_id:
            raise ExecError(f"登记响应 appId 与预期不一致：{body.get('appId')!r}")
        if body.get("allowedOrigins") != []:
            raise ExecError(f"登记响应 allowedOrigins 非空列表：{body.get('allowedOrigins')!r}")
        status, body = self.api.list_apps()
        if status != 200:
            raise ExecError(f"回查应用登记失败：HTTP {status}")
        found = next((a for a in body.get("apps", []) if a.get("appId") == self.app_id), None)
        if found is None:
            raise ExecError(f"回查未找到本轮应用 {self.app_id}（登记未生效）")
        if found.get("allowedOrigins") != []:
            raise ExecError(f"回查 allowedOrigins 非空列表：{found.get('allowedOrigins')!r}")
        entry["verified"] = True

    def _create_user(self):
        try:
            status, body = self.api.create_user(self.username, self.password, 2)
        except Exception as exc:
            raise ExecError(f"创建本轮测试账号失败：{exc}") from exc
        if status != 201:
            raise ExecError(
                f"创建本轮测试账号失败：HTTP {status} {json.dumps(body, ensure_ascii=False)[:200]}")
        if body.get("username") != self.username or body.get("dailyLimit") != 2:
            raise ExecError(f"创建响应与预期不一致：{json.dumps(body, ensure_ascii=False)[:200]}")
        self.user_id = body.get("id")
        entry = self._ledger_add("user", self.username, id=self.user_id)
        status, body = self.api.list_users()
        if status != 200:
            raise ExecError(f"回查账号失败：HTTP {status}")
        me = next((u for u in body.get("users", []) if u.get("username") == self.username), None)
        if me is None or me.get("dailyLimit") != 2 or me.get("enabled") is not True:
            raise ExecError(f"回查账号与预期不一致：{json.dumps(me, ensure_ascii=False)[:200]}")
        self.user_id = me.get("id")
        entry["verified"] = True

    def _collect_versions(self):
        try:
            handle = self.procs.spawn([self.flutter_bin, "--version"],
                                      cwd=self.examples_dir,
                                      log_path=self.paths.root / "flutter-version.log", env=None)
            self._started_handles.append(handle)
            code, timed_out = self.procs.wait(handle, 60)
            if not timed_out and code == 0:
                out = Path(handle.log_path).read_text(errors="replace")
                self.versions["flutter"] = out.splitlines()[0].strip() if out.strip() else "未解析"
            else:
                self.versions["flutter"] = f"读取失败（exit={code}, timeout={timed_out}）"
        except Exception as exc:
            self.versions["flutter"] = f"读取失败：{exc}"
        try:
            lock = (self.examples_dir / "pubspec.lock").read_text()
        except OSError as exc:
            lock = ""
            self.versions["flutter_secure_storage"] = f"读取失败：{exc}"
        for pkg in ("flutter_secure_storage", "flutter_secure_storage_macos"):
            m = re.search(r"(?m)^  " + re.escape(pkg) + r":.*?version: \"(.*?)\"", lock, re.S)
            if m:
                self.versions[pkg] = m.group(1)

    def _signing_info(self) -> dict:
        if self.signing_provider is not None:
            return self.signing_provider()
        info = {}
        try:
            out = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"],
                                 capture_output=True, text=True, timeout=15, shell=False)
            info["identities"] = (out.stdout or "").strip().splitlines()
        except Exception as exc:
            info["identities"] = [f"读取失败：{exc}"]
        app = (self.examples_dir / "build" / "macos" / "Build" / "Products" / "Debug" /
               "feedback_example.app")
        try:
            out = subprocess.run(["codesign", "-dv", str(app)],
                                 capture_output=True, text=True, timeout=15, shell=False)
            text = out.stderr or out.stdout or ""
            info["codesign"] = [ln for ln in text.splitlines()
                                if ln.startswith(("Authority=", "TeamIdentifier=", "Identifier="))]
        except Exception as exc:
            info["codesign"] = [f"读取失败：{exc}"]
        return info

    # ------------------------------------------------------------ 构建

    def _build(self):
        self.log("  [构建] flutter build macos --debug")
        code, timed_out, handle = self._spawn_wait(
            [self.flutter_bin, "build", "macos", "--debug"],
            self.paths.build_log, self.phase_timeout_s, self.examples_dir)
        self.procs.close(handle)
        if timed_out:
            raise ExecError(f"构建超时（>{self.phase_timeout_s}s），已终止本轮进程组；"
                            f"日志：{self.paths.build_log}")
        if code != 0:
            raise ExecError(f"构建失败（exit {code}），日志：{self.paths.build_log}")
        self.artifact_path = self._expected_artifact()
        self.signing = self._signing_info()
        self.log(f"  [签名] {json.dumps(self.signing, ensure_ascii=False)[:300]}")

    # ------------------------------------------------------------ 阶段

    def _run_phase(self, phase: str) -> dict:
        params = self._params_for(phase)
        params_path = self._write_params(
            self.paths.root / f"phase{phase}-params.json", params)
        result_file = Path(params["T1C_RESULT_FILE"])
        handshake_file = Path(params["T1C_HANDSHAKE_FILE"])
        log_path = self.paths.phase1_log if phase == "1" else self.paths.phase2_log
        identity = {"appId": self.app_id, "username": self.username}

        # 每轮先清掉本阶段自己的旧产物（不触碰其它阶段证据）
        for stale in (result_file, handshake_file):
            try:
                stale.unlink()
            except FileNotFoundError:
                pass

        phase1_digest = None
        if phase == "2":
            phase1_path = Path(params["T1C_PHASE1_FILE"])
            if not is_within(phase1_path, self.paths.result_dir):
                return {"verdict": FAIL,
                        "reason": f"阶段 2 输入路径越过本轮结果目录边界：{phase1_path}"}
            phase1_digest = digest_of(phase1_path)

        # T1-C2：阶段 1 **启动前**就把凭据状态登记为"可能有残留"。
        # 之后结果缺失、等待异常或用户中断都**不能**被解释为"阶段未执行"。
        if phase == "1":
            self._token_state = "maybe"
            self.cleanup["tokenStateAtPhase1Start"] = "maybe"

        started = self.clock()
        self._phase_windows[phase] = (started, started)
        cmd = self._flutter_test_cmd(PHASE_TESTS[phase], params_path)
        # _spawn_wait 在 wait 之前就登记句柄并落盘资源清单
        code, timed_out, handle = self._spawn_wait(
            cmd, log_path, self.phase_timeout_s, self.examples_dir)
        finished = self.clock()
        self._phase_windows[phase] = (started, finished)
        self.procs.close(handle)

        result = read_json(result_file)
        # 先登记令牌键证据（即使后面因进程/超时问题返回，也不会漏掉收尾依据）
        self._track_token_state(phase, result)

        handshake, handshake_problem = self._read_handshake(
            phase, handshake_file, self.run_id)
        if handshake:
            self._handshakes[phase] = handshake
        handshake_pid = handshake.get("pid") if handshake else None
        artifact = artifact_from_executable(
            (handshake or {}).get("exePath"), self.examples_dir) or self.artifact_path
        launch = classify_launch(
            ran=True, handshake_pid=handshake_pid, exit_code=code, timed_out=timed_out,
            evidence=self._collect_launch_evidence(phase, started, finished, artifact),
            artifact_path=artifact, round_pids=[handshake_pid] if handshake_pid else [],
            window_start=started, window_end=finished)
        self.launch[phase] = launch
        self.log(f"  [启动] 阶段 {phase}：{launch['kind']}｜{launch['reason'][:160]}")

        exit_problems = []
        if timed_out:
            exit_problems.append(
                f"阶段超时（>{self.phase_timeout_s}s），已终止本轮进程组（日志：{log_path}）")
        if phase == "2" and phase1_digest is not None:
            ok, reason = phase1_intact(phase1_digest, digest_of(Path(params["T1C_PHASE1_FILE"])))
            if not ok:
                return {"verdict": FAIL, "reason": f"阶段 2 证据完整性检查失败：{reason}",
                        "launch": launch}

        # 应用进程退出确认（只用本轮握手记录的 PID）
        exit_ok, exit_detail = self._confirm_app_exit(phase, handshake, handshake_problem,
                                                      started)
        if not exit_ok:
            exit_problems.append(exit_detail)

        verdict = evaluate_phase(code, result, self.run_id, phase, identity)
        if isinstance(result, dict):
            self.acceptance[phase] = acceptance_of(result)
        detail = f"{verdict['verdict']}：{verdict['reason']}"
        if launch["kind"] == LAUNCH_SIGNATURE_INVALID:
            return {"verdict": FAIL,
                    "reason": f"阶段 {phase} 启动被系统签名校验拒绝"
                              f"（{LAUNCH_SIGNATURE_INVALID}）：{launch['reason']}"
                              f"（阶段结果：{detail}）",
                    "launch": launch, "phaseVerdict": verdict}
        if exit_problems:
            return {"verdict": FAIL,
                    "reason": f"阶段 {phase} " + "；".join(exit_problems) + f"（阶段结果：{detail}）",
                    "launch": launch, "phaseVerdict": verdict}
        log_line = f"  [阶段 {phase}] {verdict['verdict']}：{verdict['reason']}｜{exit_detail}"
        if timed_out:
            log_line += "｜超时"
        self.log(log_line)
        return {**verdict, "launch": launch}

    def _track_token_state(self, phase: str, result):
        """按阶段结果里显式的清理证据更新本轮令牌键状态（不推断）。"""
        state = token_state_of(result)
        if phase == "1":
            # 证据缺失时保守认为可能有残留（阶段 1 已实际执行过）
            self._token_state = state or "maybe"
        elif phase == "2" and state is not None:
            self._token_state = state

    def _read_handshake(self, phase: str, handshake_file: Path, run_id: str):
        """读取并校验本轮结构化握手。返回 (handshake|None, 问题说明|None)。"""
        handshake = read_json(handshake_file)
        if not isinstance(handshake, dict):
            return None, (f"缺少阶段 {phase} 结构化握手记录（{handshake_file}）")
        if handshake.get("runId") != run_id or str(handshake.get("phase")) != phase:
            return None, f"握手记录与本轮/本阶段不符（{handshake_file}）"
        pid = handshake.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            return None, f"握手记录缺少合法 pid（{handshake_file}）"
        return handshake, None

    def _confirm_app_exit(self, phase: str, handshake, handshake_problem, started: float):
        """等待并确认本轮应用进程退出；只管理经核实的本轮进程。"""
        if handshake is None:
            return False, f"应用进程退出无法确认：{handshake_problem}——不启动恢复阶段"
        pid = handshake["pid"]

        deadline = self.clock() + self.app_exit_wait_s
        while self.clock() < deadline:
            if not self.procs.alive(pid):
                return True, f"应用进程 pid={pid} 已自然退出"
            self.sleep(0.3)

        desc = self.procs.describe(pid)
        ok, why = self._app_identity_ok(desc, started)
        if not ok:
            return False, (f"应用进程未退出且身份无法核实（pid={pid}：{why}）"
                           "——不终止该进程，也不启动恢复阶段")
        self.procs.kill(pid, signal.SIGTERM)
        deadline = self.clock() + 5
        while self.clock() < deadline:
            if not self.procs.alive(pid):
                return True, f"已核实的本轮应用进程 pid={pid} 已终止"
            self.sleep(0.2)
        self.procs.kill(pid, signal.SIGKILL)
        self.sleep(0.3)
        if self.procs.alive(pid):
            return False, f"已核实的本轮应用进程 pid={pid} 在强制结束后仍存活"
        return True, f"已核实的本轮应用进程 pid={pid} 已被强制终止"

    def _app_identity_ok(self, desc, started: float):
        if not desc:
            return False, "进程不存在或无法读取进程信息"
        if desc.get("uid") != self.uid:
            return False, f"所属用户不符（uid={desc.get('uid')}，期望 {self.uid}）"
        # 仓库路径可能含空格，因此按"前缀 + 分隔符"比较，不做 split
        exe = str(desc.get("exe") or "").strip()
        base = str((self.examples_dir / "build" / "macos").resolve())
        if not exe.startswith(base + os.sep):
            return False, f"可执行路径不属于本轮构建产物（{exe[:120]}）"
        if float(desc.get("startedAt") or 0) < started - 5:
            return False, "启动时间早于本阶段开始（疑似预先存在的示例进程）"
        return True, "身份核实通过"

    # ------------------------------------------------------------ 启动证据与签名

    def _expected_artifact(self):
        """本轮构建产物 `.app`（默认路径；握手里的实际路径优先）。"""
        if self.artifact_path:
            return self.artifact_path
        base = self.examples_dir / "build" / "macos" / "Build" / "Products" / "Debug"
        try:
            apps = sorted(base.glob("*.app"))
        except OSError:
            apps = []
        return str(apps[0]) if apps else None

    def _collect_launch_evidence(self, phase: str, window_start: float, window_end: float,
                                 artifact):
        """采集**本轮**启动窗口内的证据：只包含本阶段日志与窗口内的诊断报告。"""
        records = []
        log_path = self.paths.phase1_log if phase == "1" else self.paths.phase2_log
        try:
            text = Path(log_path).read_text(errors="replace")
        except OSError:
            text = ""
        for line in text.splitlines():
            if signature_rejection_markers_in(line):
                records.append({"source": f"phase{phase}-log",
                                "message": line.strip()[:300],
                                "artifactPath": artifact})
        records.extend(self._diagnostic_reports(window_start, window_end))
        return records

    def _diagnostic_reports(self, window_start: float, window_end: float):
        """只覆盖本阶段时间窗的诊断报告（历史崩溃报告不在窗口内，不能证明当前失败）。"""
        out = []
        for base in self.diagnostic_dirs:
            if not base.is_dir():
                continue
            for path in sorted(base.glob("*.ips")):
                try:
                    if not (window_start - 1 <= path.stat().st_mtime <= window_end + 600):
                        continue
                except OSError:
                    continue
                record = parse_diagnostic_report(path)
                if record:
                    out.append(record)
        return out

    def _capture_signature_evidence(self, key: str, artifact):
        """采集一次实际测试产物的签名证据（必须在下一阶段重新构建前完成）。

        四条命令（verify / details / entitlements / UUID）都必须成功；stdout 与
        stderr 分开保存，避免诊断文本混入 plist；entitlements 用 plistlib 解析。
        """
        ev = {"phase": key, "collected": False,
              "capturedAt": datetime.now().astimezone().isoformat(),
              "artifactPath": artifact}
        if not artifact or not Path(artifact).exists():
            ev["reason"] = "本轮构建产物不存在，未采集（不用初始构建冒充）"
            self.signature[key] = ev
            self._write_signature_evidence(key, ev)
            return ev
        exe = Path(artifact) / "Contents" / "MacOS" / (Path(artifact).stem or "app")
        if not exe.exists():
            macos_dir = Path(artifact) / "Contents" / "MacOS"
            candidates = [q for q in sorted(macos_dir.glob("*"))
                          if q.is_file() and os.access(q, os.X_OK)]
            exe = candidates[0] if candidates else exe
        ev["executablePath"] = str(exe)
        ev["verify"] = self.cmd_runner(CMD_VERIFY + [str(artifact)], key)
        ev["details"] = self.cmd_runner(CMD_DETAILS + [str(artifact)], key)
        ev["entitlements"] = self.cmd_runner(CMD_ENTITLEMENTS + [str(artifact)], key)
        ev["uuidCommand"] = self.cmd_runner(CMD_UUID + [str(exe)], key)

        parse_status = {name: command_parse_status(ev[name])
                        for name in ("verify", "details", "entitlements", "uuidCommand")}

        # codesign -dv：只从权威流（stderr）解析，绝不用合并后的 output
        details_text = ev["details"].get(
            SIGNATURE_OUTPUT_STREAM["details"] or "stdout", "")
        ev["parsedFrom"] = {name: stream for name, stream in SIGNATURE_OUTPUT_STREAM.items()}
        parsed = parse_signature_details(details_text)
        ev.update(parsed)
        if parse_status["details"] == "ok" and not parsed["identifier"]:
            parse_status["details"] = "error:no-identifier"

        # entitlements：plistlib 解析，空输出/损坏 plist 不算空字典
        if parse_status["entitlements"] == "ok":
            values, ent_status = parse_entitlements_plist(
                ev["entitlements"].get("stdout", ""))
            parse_status["entitlements"] = ent_status
        else:
            values = None
        ev["entitlementValues"] = values
        ev["entitlementKeys"] = sorted(values) if isinstance(values, dict) else []
        ev["keychainEntitlements"] = (keychain_entitlements(values)
                                      if isinstance(values, dict) else {})

        # UUID 与签名摘要（摘要只作证据）
        uuid_value = extract_binary_uuid(ev["uuidCommand"].get("stdout", ""))
        if parse_status["uuidCommand"] == "ok" and not uuid_value:
            parse_status["uuidCommand"] = "error:no-uuid"
        ev["binaryUuid"] = uuid_value
        ev["signatureDigest"] = hashlib.sha256(str(details_text).encode()).hexdigest()

        ev["parseStatus"] = parse_status
        ev["collected"] = True
        self.signature[key] = ev
        self._write_signature_evidence(key, ev)
        ok, reason = evaluate_signature_evidence(ev, key)
        bad = [f"{k}={v}" for k, v in parse_status.items() if v != "ok"]
        self.log(f"  [签名] 阶段 {key}：{'齐全' if ok else '不完整'}｜{reason}"
                 + (f"｜采集异常：{bad}" if bad else ""))
        return ev

    def _write_signature_evidence(self, key: str, ev: dict):
        if self.paths is None:
            return
        try:
            (self.paths.root / f"signature-{key}.json").write_text(
                json.dumps(ev, ensure_ascii=False, indent=2))
        except OSError as exc:
            self.log(f"  [签名] 证据落盘失败：{exc}")

    @staticmethod
    def _run_cmd(argv, key=None):
        """参数数组 + `shell=False` + 限时执行签名检查命令。

        分别保存 stdout / stderr / 退出码；`output` 是供日志查看的汇总。
        """
        argv = list(argv)
        captured = datetime.now().astimezone().isoformat()
        try:
            out = subprocess.run(argv, capture_output=True, text=True,
                                 timeout=60, shell=False)
        except subprocess.TimeoutExpired:
            return {"command": argv, "exitCode": None, "stdout": "", "stderr": "超时（>60s）",
                    "output": "超时（>60s）", "timedOut": True, "capturedAt": captured}
        except Exception as exc:  # noqa: BLE001 - 执行失败即失败
            text = f"{type(exc).__name__}: {exc}"
            return {"command": argv, "exitCode": None, "stdout": "", "stderr": text,
                    "output": text, "timedOut": False, "capturedAt": captured}
        stdout = out.stdout or ""
        stderr = out.stderr or ""
        combined = stdout
        if stderr:
            combined = f"{stdout}\n{stderr}" if stdout else stderr
        return {"command": argv, "exitCode": out.returncode, "stdout": stdout,
                "stderr": stderr, "output": combined.strip(), "timedOut": False,
                "capturedAt": captured}

    def _artifact_for_phase(self, phase: str):
        handshake = self._handshakes.get(phase) or {}
        return (artifact_from_executable(handshake.get("exePath"), self.examples_dir)
                or self._expected_artifact())

    def _receipts_ok(self) -> bool:
        final = self.receipts.get("final") or {}
        return final.get("ok") is True

    def _compare_signatures(self):
        """比对两阶段签名证据（应用标识、类型、Team、身份链、完整授权配置）。"""
        ev1, ev2 = self.signature.get("1"), self.signature.get("2")
        if not isinstance(ev1, dict) or not isinstance(ev2, dict):
            return {"ok": False, "problems": ["两阶段签名证据不齐"], "detail": {}}
        ok, problems, detail = compare_signature_evidence(ev1, ev2)
        return {"ok": ok, "problems": problems, "detail": detail}

    def _signature_gate(self):
        """PASS 前的签名证据门禁：两阶段都要齐全、采集成功且关键配置一致。"""
        comparison = self.signature_comparison
        if not isinstance(comparison, dict):
            return False, "两阶段签名证据未比对"
        if comparison.get("ok") is True:
            return True, "两阶段签名证据齐全、采集成功且关键配置一致"
        problems = comparison.get("problems") or ["未知差异"]
        return False, "两阶段签名证据不成立：" + "；".join(problems)

    @staticmethod
    def _signature_summary(ev):
        """报告里只放摘要；完整证据留在 signature-<phase>.json。"""
        if not isinstance(ev, dict):
            return {"collected": False}
        return {
            "collected": ev.get("collected") is True,
            "reason": ev.get("reason"),
            "capturedAt": ev.get("capturedAt"),
            "artifactPath": ev.get("artifactPath"),
            "executablePath": ev.get("executablePath"),
            "identifier": ev.get("identifier"),
            "teamIdentifier": ev.get("teamIdentifier"),
            "signatureFormat": ev.get("signatureFormat"),
            "cdhash": ev.get("cdhash"),
            "binaryUuid": ev.get("binaryUuid"),
            "signatureDigest": ev.get("signatureDigest"),
            "verifyExitCode": (ev.get("verify") or {}).get("exitCode"),
            "detailsExitCode": (ev.get("details") or {}).get("exitCode"),
            "entitlementsExitCode": (ev.get("entitlements") or {}).get("exitCode"),
            "uuidExitCode": (ev.get("uuidCommand") or {}).get("exitCode"),
            "parseStatus": ev.get("parseStatus"),
            "authorityChain": ev.get("authorityChain"),
            "entitlementKeys": ev.get("entitlementKeys"),
            "entitlementValues": ev.get("entitlementValues"),
            "keychainEntitlements": ev.get("keychainEntitlements"),
        }

    def _check_receipts(self, phase: str, expected_count: int):
        """经现有管理接口核对本轮接收结果与用量。返回 (ok, detail)。"""
        detail = {"phase": phase, "expectedCount": expected_count,
                  "at": datetime.now().astimezone().isoformat()}
        if self.api is None:
            detail["reason"] = "管理接口尚未建立"
            return False, detail
        try:
            status, body = self.api.list_feedback(self.app_id, limit=50)
        except Exception as exc:
            detail["reason"] = f"反馈列表查询异常：{exc}"
            return False, detail
        if status != 200:
            detail["reason"] = f"反馈列表查询 HTTP {status}（非 200）"
            return False, detail
        items = body.get("items") if isinstance(body, dict) else None
        wanted = [(p, (self.acceptance.get(p) or {}).get("feedbackId")) for p in ("1", "2")]
        if phase == "1":
            wanted = [pair for pair in wanted if pair[0] == "1"]
        wanted = [(p, fid) for p, fid in wanted if isinstance(fid, str) and fid]
        ok, reason, rc_detail = verify_receipts(
            items, wanted, self.username, expected_count)
        detail.update(rc_detail)
        detail["reason"] = reason
        if not ok:
            return False, detail
        try:
            status, body = self.api.list_users()
        except Exception as exc:
            detail["reason"] = f"账号用量查询异常：{exc}"
            return False, detail
        me = None
        if status == 200 and isinstance(body, dict):
            me = next((u for u in body.get("users", [])
                       if u.get("username") == self.username), None)
        if me is None:
            detail["reason"] = f"账号用量查询失败（HTTP {status}）"
            return False, detail
        detail["used"] = me.get("used")
        if me.get("used") != expected_count:
            detail["reason"] = f"账号用量 {me.get('used')} != 期望 {expected_count}"
            return False, detail
        detail["ok"] = True
        self.log(f"  [接收] 阶段 {phase} 服务端核对通过：{reason}；用量 {me.get('used')}")
        return True, detail

    # ------------------------------------------------------------ 收尾

    def _cleanup_resources(self):
        """固定收尾顺序（T1-C2）：

        1) 确认本轮构建/测试/应用进程（写入来源）已停止；
        2) 兜底清理凭据；
        3) 禁用并核验账号；
        4) 停止专用服务；
        5) 删除敏感参数；
        6) 记录凭据清理是否确认。

        每一步**独立**捕获错误（含收尾期间再次中断），前一步失败不阻止后续步骤；
        不在收尾期间重启任何测试。
        """
        steps = self.cleanup["cleanupSteps"]

        def step(name, fn, *args, **kwargs):
            """执行一个收尾步骤：只有显式返回 True 才算成功。"""
            entry = {"step": name}
            steps.append(entry)
            try:
                result = fn(*args, **kwargs)
                entry["ok"] = result is True
                if result is None:
                    entry["error"] = "步骤未返回明确结果（None）"
                return entry, result
            except BaseException as exc:  # 再次中断也不重启测试，继续后续独立步骤
                entry["ok"] = False
                entry["error"] = f"{type(exc).__name__}: {exc}"
                self.log(f"  [收尾] {name} 抛错：{entry['error']}")
                return entry, None

        # 1) 写入来源必须停止：只有返回 True 才算已停止；异常 / None / False 都算未确认
        writer_entry, writer_ok = step("confirm-writer-stopped",
                                       self._confirm_writer_stopped)
        writer_stopped = writer_ok is True
        writer_entry["ok"] = writer_stopped
        self.cleanup["writerStopped"] = writer_stopped
        if not writer_stopped:
            base = self.cleanup.get("writerStopDetail") or ""
            reason = writer_entry.get("error") or (
                "确认写入来源停止时未返回明确结果（None）" if writer_ok is None
                else "写入来源未确认停止")
            self.cleanup["writerStopDetail"] = f"{base}｜{reason}" if base else reason
            self._record_residual_keys()

        # 2) 兜底清理凭据（阶段崩溃无法自行清理时）
        #    写入来源未确认停止时**不启动**兜底清理进程：避免与尚存活的写入进程竞争
        if self._token_state == "maybe":
            if writer_stopped:
                step("fallback-credential-cleanup", self._run_dart_cleanup)
            else:
                steps.append({
                    "step": "fallback-credential-cleanup", "ok": False,
                    "error": "写入来源未确认停止：不启动兜底凭据清理进程，"
                             "避免与尚存活的写入进程竞争；清理记为未完成"})
                self.cleanup["dartCleanup"] = NOT_RUN
                self.cleanup["dartCleanupDetail"] = (
                    "写入来源未确认停止，未执行兜底清理（清理未完成，记录残留键名）")
                self.log("  [清理] 写入来源未确认停止：跳过兜底凭据清理")
        else:
            self.cleanup["dartCleanup"] = "NOT_NEEDED"
            self.cleanup["dartCleanupDetail"] = (
                "本轮令牌键已确认清空，无需兜底清理"
                if self._token_state == "absent"
                else "阶段 1 未执行，本轮从未写出令牌，无需兜底清理")

        # 3) 禁用本轮账号并核验
        step("disable-account", self._disable_account)

        # 4) 停止本轮专用服务并确认
        step("stop-service", self._stop_service)

        # 5) 删除参数文件（0600，结束即删）
        step("remove-params", self._remove_params)

        # 6) 凭据清理确认（写入来源未确认停止时一律不算完成）
        if self._token_state == "unknown":
            confirmed = True   # 阶段 1 未启动：从未写出令牌
        elif self._token_state == "absent":
            confirmed = True   # 阶段自己证明已清空 / 兜底清理已确认
        else:
            confirmed = self.cleanup["dartCleanup"] == PASS
        if not writer_stopped:
            confirmed = False
            self.cleanup["credentialCleanupConfirmedDetail"] = (
                "写入来源未确认停止，不报告凭据清理完成："
                + self.cleanup["writerStopDetail"])
        self.cleanup["credentialCleanupConfirmed"] = confirmed

        self._mark_ledger_dispositions()
        self._persist_manifest()

    def _record_residual_keys(self):
        """记录本轮残留键**名**（不含令牌值），供人工清理与审查。"""
        if self.cleanup.get("residualKeys"):
            return
        self.cleanup["residualKeys"] = [
            {"kind": "token", "key": token_storage_key(self.service_url, self.app_id)},
            {"kind": "probe", "key": f"{self.app_id}.probe.{self.run_id}"},
        ]

    def _mark_ledger_dispositions(self):
        """按**实际核验结果**逐条记录资源处置，不再无条件标 cleaned=true。"""
        for entry in self.ledger:
            kind = entry.get("kind")
            if kind == "user":
                ok = bool(self.cleanup["accountDisabled"]
                          and self.cleanup["accountDisableVerified"])
                entry["cleaned"] = ok
                entry["disposition"] = ("disabled-and-verified" if ok
                                        else "disable-unconfirmed")
            elif kind == "service":
                ok = bool(self.cleanup["serviceStopped"])
                entry["cleaned"] = ok
                entry["disposition"] = "stopped" if ok else "stop-unconfirmed"
            elif kind == "app":
                # 应用登记保留：不删除应用，本轮反馈历史继续保留供审查
                entry["cleaned"] = False
                entry["disposition"] = "retained-for-audit"
            else:
                entry["cleaned"] = False
                entry["disposition"] = "unknown-kind"

    def _stop_service(self) -> bool:
        if self.service is None:
            self.cleanup["serviceStopped"] = True
            return True
        try:
            self.cleanup["serviceStopped"] = bool(self.service.stop())
        except BaseException as exc:
            self.cleanup["serviceStopped"] = False
            self.cleanup["serviceStopError"] = f"{type(exc).__name__}: {exc}"
        return self.cleanup["serviceStopped"]

    def _remove_params(self) -> bool:
        removed = True
        for path in (self.paths.params, self.paths.cleanup_params,
                     self.paths.root / "phase1-params.json",
                     self.paths.root / "phase2-params.json"):
            try:
                Path(path).unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                removed = False
                self.cleanup.setdefault("paramsRemoveErrors", []).append(f"{path}: {exc}")
        self.cleanup["paramsRemoved"] = removed
        return removed

    def _confirm_writer_stopped(self) -> bool:
        """确认写入来源（本轮构建/测试进程与已核实的应用进程）已停止。

        只管理本轮自己启动的句柄与经 uid / 可执行路径 / 启动时间核实的应用
        PID；不使用路径模糊匹配批量杀进程，也绝不触碰无关进程。
        """
        problems = []
        for handle in list(self._started_handles):
            if self.procs.poll(handle) is not None:
                continue
            self.log(f"  [收尾] 本轮进程 pid={handle.pid} 仍存活：先 SIGTERM，"
                     f"15 秒后仍存活才强制终止")
            self.procs.signal_group(handle.pgid, signal.SIGTERM)
            deadline = self.clock() + 15
            while self.clock() < deadline:
                if self.procs.poll(handle) is not None:
                    break
                self.sleep(0.3)
            if self.procs.poll(handle) is None:
                self.procs.signal_group(handle.pgid, signal.SIGKILL)
                self.procs.kill(handle.pid, signal.SIGKILL)
                deadline = self.clock() + 10
                while self.clock() < deadline:
                    if self.procs.poll(handle) is not None:
                        break
                    self.sleep(0.3)
            if self.procs.poll(handle) is None:
                problems.append(
                    f"本轮进程 pid={handle.pid}（{handle.cmd[0]}）SIGTERM+15s 与 SIGKILL 后仍存活")
        # 中断可能发生在读取握手之前：这里同时按磁盘上的本轮握手记录核对
        phases = sorted(set(self._handshakes) | set(self._phase_windows))
        for phase in phases:
            handshake = self._handshakes.get(phase)
            if handshake is None:
                path = self.paths.result_dir / f"phase{phase}-handshake.json"
                handshake, _problem = self._read_handshake(phase, path, self.run_id)
            if not handshake:
                continue
            pid = handshake.get("pid")
            if not isinstance(pid, int) or pid <= 0 or not self.procs.alive(pid):
                continue
            started = self._phase_windows.get(phase, (0.0, 0.0))[0]
            ok, why = self._app_identity_ok(self.procs.describe(pid), started)
            if not ok:
                problems.append(
                    f"阶段 {phase} 应用进程 pid={pid} 仍存活且身份无法核实（{why}）"
                    "——不终止该进程，也不报告写入来源已停止")
                continue
            self.procs.kill(pid, signal.SIGTERM)
            deadline = self.clock() + 15
            while self.clock() < deadline:
                if not self.procs.alive(pid):
                    break
                self.sleep(0.3)
            if self.procs.alive(pid):
                self.procs.kill(pid, signal.SIGKILL)
                self.sleep(0.3)
            if self.procs.alive(pid):
                problems.append(f"阶段 {phase} 应用进程 pid={pid} 强制结束后仍存活")
        self.cleanup["writerStopped"] = not problems
        self.cleanup["writerStopDetail"] = (
            "；".join(problems) if problems else "本轮构建/测试与应用进程均已停止")
        self.log(f"  [收尾] 写入来源停止：{self.cleanup['writerStopDetail']}")
        return not problems

    def _run_dart_cleanup(self) -> bool:
        self._record_residual_keys()
        try:
            params = self._params_for_cleanup()
        except Exception as exc:
            self.cleanup["dartCleanup"] = FAIL
            self.cleanup["dartCleanupDetail"] = f"兜底清理参数构造失败：{exc}"
            return False
        try:
            params_path = self._write_params(self.paths.cleanup_params, params)
        except Exception as exc:
            self.cleanup["dartCleanup"] = FAIL
            self.cleanup["dartCleanupDetail"] = f"兜底清理参数写入失败：{exc}"
            return False
        cmd = self._flutter_test_cmd(PHASE_TESTS["cleanup"], params_path)
        try:
            # 兜底清理入口自身同样受进程登记与超时约束
            code, timed_out, handle = self._spawn_wait(
                cmd, self.paths.cleanup_log, self.phase_timeout_s, self.examples_dir)
            self.procs.close(handle)
        except Exception as exc:
            self.cleanup["dartCleanup"] = FAIL
            self.cleanup["dartCleanupDetail"] = f"兜底清理入口无法执行：{exc}"
            return False
        result = read_json(Path(params["T1C_RESULT_FILE"]))
        verdict = evaluate_cleanup(
            result, self.run_id, {"appId": self.app_id, "username": self.username})
        if timed_out:
            verdict = {"verdict": FAIL,
                       "reason": f"兜底清理入口超时（>{self.phase_timeout_s}s）"}
        self.cleanup["dartCleanup"] = verdict["verdict"]
        self.cleanup["dartCleanupDetail"] = verdict["reason"]
        self.cleanup["dartCleanupExit"] = code
        if verdict["verdict"] == PASS:
            self._token_state = "absent"
        self.log(f"  [清理] 兜底清理入口：{verdict['verdict']}｜{verdict['reason']}")
        return verdict["verdict"] == PASS

    def _disable_account(self) -> bool:
        if self.user_id is None:
            return True   # 没有本轮账号需要禁用
        try:
            status, body = self.api.set_enabled(self.user_id, False)
            if status != 200:
                self.cleanup["accountDisableError"] = (
                    f"HTTP {status} {json.dumps(body, ensure_ascii=False)[:200]}")
                return False
            self.cleanup["accountDisabled"] = body.get("enabled") is False
            status, body = self.api.list_users()
            me = next((u for u in body.get("users", [])
                       if u.get("username") == self.username), None)
            self.cleanup["accountDisableVerified"] = (
                status == 200 and me is not None and me.get("enabled") is False)
        except BaseException as exc:
            self.cleanup["accountDisableError"] = f"{type(exc).__name__}: {exc}"
        self.log(f"  [清理] 账号禁用：disabled={self.cleanup['accountDisabled']} "
                 f"verified={self.cleanup['accountDisableVerified']}")
        return bool(self.cleanup["accountDisabled"]
                    and self.cleanup["accountDisableVerified"])

    def _cleanup_ok(self) -> bool:
        """只有全部清理条件**显式为 True** 才算清理完成。

        写入来源停止无法确认、或凭据清理未确认时一律 false → 整体 FAIL（不是
        BLOCKED、更不是 PASS）。
        """
        account_ok = (self.user_id is None) or (
            self.cleanup["accountDisabled"] and self.cleanup["accountDisableVerified"])
        if self.user_id is not None and not account_ok:
            self.cleanup["accountDisableVerified"] = False
        writer_ok = self.cleanup["writerStopped"] is True
        credential_ok = self.cleanup["credentialCleanupConfirmed"] is True
        service_ok = self.cleanup["serviceStopped"] is True
        params_ok = self.cleanup["paramsRemoved"] is True
        return bool(writer_ok and account_ok and credential_ok
                    and service_ok and params_ok)

    # ------------------------------------------------------------ 报告与主流程

    def _write_report(self, overall: dict) -> dict:
        report = {
            "runId": self.run_id,
            "verdict": overall["verdict"],
            "reason": overall["reason"],
            "error": self.error,
            "phase1": self.p1,
            "phase2": self.p2,
            "usage": {**self.usage, "receipts": self.receipts},
            "acceptance": self.acceptance,
            "launch": self.launch,
            "launchBaseline": self.launch_baseline,
            "signature": {key: self._signature_summary(ev)
                          for key, ev in sorted(self.signature.items())},
            "signatureFiles": {key: str(self.paths.root / f"signature-{key}.json")
                               for key in sorted(self.signature)},
            "signatureComparison": self.signature_comparison,
            "cleanup": {**self.cleanup, "tokenState": self._token_state},
            "identity": {
                "appId": self.app_id,
                "username": self.username,
                "tokenStorageKey": token_storage_key(self.service_url, self.app_id),
                "probeStorageKey": f"{self.app_id}.probe.{self.run_id}",
            },
            "service": {
                "host": HOST,
                "port": None if self.service is None else self.service.port,
                "dataDir": self.cleanup.get("serviceDataDir"),
                "isolated": True,
            },
            "versions": self.versions,
            "buildMode": "debug",
            "signing": self.signing,
            "paths": {
                "runDir": str(self.paths.root),
                "buildLog": str(self.paths.build_log),
                "phase1Log": str(self.paths.phase1_log),
                "phase2Log": str(self.paths.phase2_log),
                "cleanupLog": str(self.paths.cleanup_log),
                "resultDir": str(self.paths.result_dir),
                "report": str(self.paths.report),
            },
            "resources": self.ledger,
        }
        if not self.paths.report.parent.exists():
            self.paths.report.parent.mkdir(parents=True, exist_ok=True)
        self.paths.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        try:
            with open(self.paths.history, "a") as fh:
                fh.write(json.dumps(report, ensure_ascii=False) + "\n")
        except OSError as exc:
            self.log(f"  [报告] history.jsonl 追加失败：{exc}")
        return report

    def run(self) -> int:
        if not self._acquire_lock():
            msg = (f"并发运行被拒绝：仓库级排他锁被占用（{self.lock_path}）"
                   "——同一 macOS 示例不允许并发构建/验收")
            self.log(f"FAIL：{msg}")
            self._write_early_failure(msg)
            return EXIT_FAIL
        try:
            return self._run_locked()
        finally:
            self._release_lock()

    def _write_early_failure(self, msg: str):
        """执行器在任何阶段之前就失败（并发锁/预检）时的结构化报告。"""
        try:
            self.runs_root.mkdir(parents=True, exist_ok=True)
            path = self.runs_root / f"{self.run_id}-early-failure.json"
            path.write_text(json.dumps(
                {"runId": self.run_id, "verdict": FAIL, "reason": msg},
                ensure_ascii=False, indent=2))
        except OSError:
            pass

    def _run_locked(self) -> int:
        try:
            self._prepare_paths()
        except ExecError as exc:
            self.error = str(exc)
            self.log(f"FAIL：{exc}")
            self._write_early_failure(str(exc))
            return EXIT_FAIL

        self.log(f"== T1-C 默认存储统一验收 runId={self.run_id} ==")
        try:
            self._boot()
            self._build()
            # 当前待测产物的基线签名证据（在任何阶段之前）
            self._capture_signature_evidence("baseline", self._expected_artifact())
            self.p1 = self._run_phase("1")
            # 阶段 1 实际产物的签名证据必须在阶段 2 重新构建之前采集
            self._capture_signature_evidence("1", self._artifact_for_phase("1"))
            if self.p1["verdict"] == PASS:
                ok1, self.receipts["phase1"] = self._check_receipts("1", 1)
                if not ok1:
                    self.p1 = {
                        "verdict": FAIL,
                        "reason": "阶段 1 服务端接收核对失败："
                                  f"{self.receipts['phase1'].get('reason')}",
                        "launch": self.p1.get("launch"),
                    }
                else:
                    self.p2 = self._run_phase("2")
                    self._capture_signature_evidence("2", self._artifact_for_phase("2"))
                    ok2, self.receipts["final"] = self._check_receipts("2", 2)
                    if self.p2["verdict"] == PASS and not ok2:
                        self.p2 = {
                            "verdict": FAIL,
                            "reason": "阶段 2 服务端接收核对失败："
                                      f"{self.receipts['final'].get('reason')}",
                            "launch": self.p2.get("launch"),
                        }

        except ExecError as exc:
            self.error = str(exc)
            self.log(f"FAIL：{exc}")
        except KeyboardInterrupt:
            self.error = "用户中断（KeyboardInterrupt）：已执行统一收尾"
            self.log(f"FAIL：{self.error}")
        except Exception as exc:  # 未知缺陷也必须收尾并写入报告
            self.error = f"执行器未预期错误：{type(exc).__name__}: {exc}"
            self.log(f"FAIL：{self.error}")
        finally:
            try:
                self._cleanup_resources()
            except Exception as exc:
                self.cleanup["cleanupCrash"] = f"{type(exc).__name__}: {exc}"
                self.log(f"  [清理] 收尾过程出现未预期错误：{exc}")

        # 阶段 2 未执行 / 阶段 1 未执行：明确记录"未采集"，不用初始构建冒充
        if self.p2["verdict"] == NOT_RUN:
            self.log("  [阶段 2] 未执行（阶段 1 未通过）")
            self.signature.setdefault("2", {
                "phase": "2", "collected": False,
                "reason": "阶段 2 未执行，未采集签名证据（不用初始构建冒充）",
                "capturedAt": datetime.now().astimezone().isoformat(),
            })
        if self.signature.get("1", {}).get("collected") is not True:
            self.signature.setdefault("1", {
                "phase": "1", "collected": False,
                "reason": "阶段 1 未执行或未产出可采集证据",
                "capturedAt": datetime.now().astimezone().isoformat(),
            })
        # 两阶段签名证据比对（含配置差异），供报告与门禁共用
        self.signature_comparison = self._compare_signatures()
        self.usage = {
            "ok": self._receipts_ok(),
            "expected": "阶段 1 接收 1 条 / 用量 1；最终 2 条不同 feedbackId / 用量 2",
            "phase1": self.receipts.get("phase1"),
            "final": self.receipts.get("final"),
        }
        overall = decide_overall(self.p1, self.p2, self._receipts_ok(), self.run_id,
                                 cleanup_ok=self._cleanup_ok())
        if overall["verdict"] == PASS:
            problems = []
            sig_ok, sig_reason = self._signature_gate()
            if not sig_ok:
                problems.append(sig_reason)
            if problems:
                overall = {"verdict": FAIL,
                           "reason": "整体通过条件不成立：" + "；".join(problems)}
        if self.error:
            # 执行器流程缺陷一律 FAIL，并且不打折扣地把原始原因写进报告
            overall = {"verdict": FAIL,
                       "reason": f"执行器流程失败：{self.error}｜阶段结论：{overall['reason']}"}
        self._append_cleanup_note(overall)
        exit_code = {PASS: EXIT_PASS, FAIL: EXIT_FAIL, BLOCKED: EXIT_BLOCKED}[overall["verdict"]]
        report = self._write_report(overall)
        self.log(f"== 结果：{overall['verdict']}（退出码 {exit_code}）==")
        self.log(f"== 原因：{overall['reason']}")
        self.log(f"== 证据：{report['paths']['report']}")
        return exit_code

    def _append_cleanup_note(self, overall: dict):
        """清理未完成时在原因里附上残留身份（不记录令牌值）。"""
        if self._cleanup_ok():
            return
        residual = [k["key"] for k in self.cleanup["residualKeys"]] or [
            token_storage_key(self.service_url, self.app_id)]
        if self.cleanup["dartCleanup"] == FAIL:
            residual_note = f"兜底清理失败：{self.cleanup['dartCleanupDetail']}"
        else:
            residual_note = ""
        confirmed_note = self.cleanup.get("credentialCleanupConfirmedDetail", "")
        overall["reason"] += (
            f"（收尾未全部确认：账号禁用={self.cleanup['accountDisabled']}/"
            f"服务停止={self.cleanup['serviceStopped']}/"
            f"参数删除={self.cleanup['paramsRemoved']}/"
            f"写入来源停止={self.cleanup['writerStopped']}/"
            f"兜底清理={self.cleanup['dartCleanup']}；残留键身份={residual}）"
            f"{residual_note}{confirmed_note}")


def build_executor(run_id: str | None = None) -> Executor:
    procs = SystemProcs()

    def service_factory(*, run_dir, procs):  # noqa: ARG001
        return ServiceHarness(procs=procs, run_dir=run_dir, server_dir=SERVER_DIR,
                              node_bin=NODE_BIN)

    def api_factory(port):
        return AdminApi(port)

    return Executor(procs=procs, api_factory=api_factory,
                    service_factory=service_factory, run_id=run_id)


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    run_id = None
    if args:
        if len(args) == 2 and args[0] == "--run-id":
            run_id = args[1]
        else:
            print(f"FAIL：未知参数 {args!r}（仅支持 --run-id <id>）")
            return EXIT_FAIL
    return build_executor(run_id=run_id).run()


if __name__ == "__main__":
    sys.exit(main())
