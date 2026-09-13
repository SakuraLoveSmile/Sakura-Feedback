#!/usr/bin/env python3
"""T1-C3 签名前置条件核查（只读，不改任何文件）。

作用：在跑真实两阶段默认存储验收之前，用**最终生效的构建设置**确认 Debug 构建
确实带上了匹配的 Team 与 Keychain 授权——而不是只看手写配置或一次成功的手工启动。

核查项：
  1. 本机可用签名身份（`security find-identity -v -p codesigning`）；
  2. Debug 的**生效**构建设置（`xcodebuild -showBuildSettings`）：
     DEVELOPMENT_TEAM / CODE_SIGN_IDENTITY / CODE_SIGN_STYLE /
     CODE_SIGN_ENTITLEMENTS / PRODUCT_BUNDLE_IDENTIFIER；
  3. 源 entitlements 文件是否包含 `keychain-access-groups`（Keychain Sharing）；
  4. 已存在的构建产物的实际签名与授权（仅作参考；产物可能早于本次配置）。

退出码：0 = 前置条件就绪（可以跑真实验收），1 = 未就绪（列出具体缺失项）。
`--json` 输出机器可读结果。

不会执行：签名、重签、修改 entitlements/pbxproj、关闭任何系统安全校验。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import plistlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MACOS_DIR = REPO / "examples" / "flutter" / "macos"
WORKSPACE = MACOS_DIR / "Runner.xcworkspace"
SCHEME = "Runner"
CONFIGURATION = "Debug"
EXPECTED_BUNDLE_ID = "dev.example.feedbackExample"
DEBUG_ENTITLEMENTS = MACOS_DIR / "Runner" / "DebugProfile.entitlements"
RELEASE_ENTITLEMENTS = MACOS_DIR / "Runner" / "Release.entitlements"
BUILT_APP = (REPO / "examples" / "flutter" / "build" / "macos" / "Build" /
             "Products" / "Debug" / "feedback_example.app")

SETTING_KEYS = (
    "DEVELOPMENT_TEAM", "CODE_SIGN_IDENTITY", "CODE_SIGN_STYLE",
    "CODE_SIGN_ENTITLEMENTS", "PRODUCT_BUNDLE_IDENTIFIER",
    "PROVISIONING_PROFILE_SPECIFIER", "CODE_SIGNING_REQUIRED",
    "CODE_SIGNING_ALLOWED",
)


def run(argv, timeout=180):
    """返回 (exitCode|None, stdout, stderr)。stdout/stderr 必须分开：
    `codesign` 的 plist 在 stdout、诊断在 stderr，混在一起会破坏解析。"""
    try:
        out = subprocess.run(list(argv), capture_output=True, text=True,
                             timeout=timeout, shell=False)
    except Exception as exc:  # noqa: BLE001
        return None, "", f"{type(exc).__name__}: {exc}"
    return out.returncode, out.stdout or "", out.stderr or ""


def collect_identities():
    code, text, err = run(["security", "find-identity", "-v", "-p", "codesigning"], timeout=30)
    text = text or err
    identities, found = [], 0
    if text:
        match = re.search(r"(\d+) valid identities found", text)
        if match:
            found = int(match.group(1))
        for line in text.splitlines():
            m = re.match(r"\s*\d+\)\s+([0-9A-Fa-f]{40})\s+\"(.+)\"", line)
            if m:
                name = m.group(2)
                team = ""
                tm = re.search(r"\(([A-Z0-9]{10})\)\s*$", name)
                if tm:
                    team = tm.group(1)
                identities.append({"sha1": m.group(1), "name": name, "team": team})
    return {"validCount": found, "identities": identities,
            "raw": (text or "").strip() if code != 0 else None}


def collect_effective_settings():
    if not WORKSPACE.exists():
        return {"error": f"找不到工作区 {WORKSPACE}"}
    code, stdout, stderr = run(["xcodebuild", "-workspace", str(WORKSPACE),
                                "-scheme", SCHEME, "-configuration", CONFIGURATION,
                                "-showBuildSettings"])
    text = stdout or stderr
    if code is None:
        return {"error": stderr}
    if code != 0:
        tail = "\n".join((text or "").splitlines()[-8:])
        return {"error": f"xcodebuild 退出码 {code}：{tail}"}
    settings = {}
    for line in (text or "").splitlines():
        m = re.match(r"\s+([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line)
        if m and m.group(1) in SETTING_KEYS:
            settings.setdefault(m.group(1), m.group(2).strip())
    return settings


def read_entitlements(path: Path):
    if not path.exists():
        return {"error": f"缺少 {path}"}
    try:
        data = plistlib.loads(path.read_bytes())
    except Exception as exc:  # noqa: BLE001
        return {"error": f"无法解析 {path.name}：{type(exc).__name__}"}
    if not isinstance(data, dict):
        return {"error": f"{path.name} 不是字典"}
    groups = data.get("keychain-access-groups")
    return {"path": str(path.relative_to(REPO)), "keys": sorted(data),
            "keychainAccessGroups": groups if isinstance(groups, list) else None}


def inspect_built_app():
    if not BUILT_APP.exists():
        return {"present": False}
    info = {"present": True, "path": str(BUILT_APP.relative_to(REPO))}
    # codesign -dv 的显示输出在 stderr；-d --entitlements 的 plist 在 stdout
    _code, _out, err = run(["codesign", "-dv", "--verbose=4", str(BUILT_APP)], timeout=60)
    details = err
    for key in ("Identifier", "TeamIdentifier", "Signature"):
        m = re.search(rf"^{key}=(.*)$", details, re.M)
        if m:
            info[key[0].lower() + key[1:]] = m.group(1).strip()
    authorities = re.findall(r"^Authority=(.*)$", details, re.M)
    info["authorityChain"] = [a.strip() for a in authorities]
    if info.get("signature") is None:
        info["signature"] = "authority" if authorities else "adhoc"
    _code, out, _err = run(["codesign", "-d", "--entitlements", ":-", str(BUILT_APP)],
                           timeout=60)
    try:
        parsed = plistlib.loads((out or "").encode("utf-8", "replace"))
        info["entitlementKeys"] = sorted(parsed) if isinstance(parsed, dict) else []
        groups = parsed.get("keychain-access-groups") if isinstance(parsed, dict) else None
        info["keychainAccessGroups"] = groups if isinstance(groups, list) else None
    except Exception:  # noqa: BLE001
        info["entitlementKeys"] = None
    return info


def evaluate(identities, settings, debug_ent, release_ent, built):
    """返回 (ready, gaps[], notes[])。"""
    gaps, notes = [], []
    if identities["validCount"] < 1:
        gaps.append("本机没有可用签名身份（security find-identity -v -p codesigning = 0）"
                    "——需在 Xcode → Settings → Accounts 登录 Apple 账号并创建/安装 "
                    "Apple Development 证书")
    if settings.get("error"):
        gaps.append(f"无法读取生效构建设置：{settings['error']}")
        return False, gaps, notes
    team = settings.get("DEVELOPMENT_TEAM") or ""
    identity = settings.get("CODE_SIGN_IDENTITY") or ""
    entitlements = settings.get("CODE_SIGN_ENTITLEMENTS") or ""
    bundle = settings.get("PRODUCT_BUNDLE_IDENTIFIER") or ""
    if not team:
        gaps.append("生效设置里没有 DEVELOPMENT_TEAM——需在 Xcode 的 Signing & Capabilities "
                    "为 Runner 选定有效的 Team（自动签名）")
    if identity.strip() == "-" or not identity:
        gaps.append(f"生效的 CODE_SIGN_IDENTITY = {identity!r}（ad-hoc）——Debug 仍被 "
                    "CODE_SIGN_IDENTITY = \"-\" 影响，自动签名不会生效")
    if not entitlements:
        gaps.append("生效设置里没有 CODE_SIGN_ENTITLEMENTS")
    elif "DebugProfile.entitlements" not in entitlements:
        gaps.append(f"Debug 使用的 entitlements 不是预期的 DebugProfile：{entitlements}")
    if bundle != EXPECTED_BUNDLE_ID:
        gaps.append(f"bundle identifier 变成 {bundle!r}，期望 {EXPECTED_BUNDLE_ID!r}"
                    "（不得静默更换，否则存储身份与容器都会变）")
    groups = debug_ent.get("keychainAccessGroups")
    if debug_ent.get("error"):
        gaps.append(debug_ent["error"])
    elif not groups:
        gaps.append("Runner/DebugProfile.entitlements 里没有 keychain-access-groups"
                    "——需在 Signing & Capabilities 添加 Keychain Sharing"
                    "（由 Xcode 生成与签名配置匹配的访问组）")
    elif any(str(g).startswith("$(") for g in groups):
        notes.append(f"Keychain 访问组使用构建变量，会在签名时展开：{groups}")
    if release_ent.get("error"):
        notes.append(release_ent["error"])
    elif not release_ent.get("keychainAccessGroups"):
        notes.append("Release.entitlements 未含 keychain-access-groups（本轮验收用 Debug，"
                     "不影响；如需发布请同样配置）")
    if built.get("present"):
        if built.get("keychainAccessGroups"):
            notes.append(f"现有构建产物已含 Keychain 授权（{built['keychainAccessGroups']}）")
        else:
            notes.append("现有构建产物不含 Keychain 授权——这是配置前的产物，配置后需重新构建")
        if built.get("authorityChain"):
            notes.append(f"现有产物签名身份链：{built['authorityChain']}")
        if team and built.get("teamIdentifier") not in (None, "not set", "", team):
            notes.append(f"现有产物的 TeamIdentifier={built.get('teamIdentifier')!r} "
                         f"与生效设置 {team!r} 不一致（产物早于配置）")
    return (not gaps), gaps, notes


def main() -> int:
    as_json = "--json" in sys.argv[1:]
    identities = collect_identities()
    settings = collect_effective_settings()
    debug_ent = read_entitlements(DEBUG_ENTITLEMENTS)
    release_ent = read_entitlements(RELEASE_ENTITLEMENTS)
    built = inspect_built_app()
    ready, gaps, notes = evaluate(identities, settings, debug_ent, release_ent, built)
    result = {
        "ready": ready, "gaps": gaps, "notes": notes,
        "identities": identities, "effectiveSettings": settings,
        "debugEntitlements": debug_ent, "releaseEntitlements": release_ent,
        "builtProduct": built,
        "expectedBundleId": EXPECTED_BUNDLE_ID,
    }
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("== T1-C3 签名前置条件核查（只读）==")
        print(f"  [签名身份] 有效身份 {identities['validCount']} 个"
              + (f"：{[i['name'] for i in identities['identities']]}"
                 if identities["identities"] else ""))
        if settings.get("error"):
            print(f"  [生效设置] 读取失败：{settings['error']}")
        else:
            for key in SETTING_KEYS:
                if key in settings:
                    print(f"  [生效设置] {key} = {settings[key]}")
            if "DEVELOPMENT_TEAM" not in settings:
                print("  [生效设置] DEVELOPMENT_TEAM = （未设置）")
        for label, ent in (("Debug", debug_ent), ("Release", release_ent)):
            if ent.get("error"):
                print(f"  [entitlements] {label}: {ent['error']}")
            else:
                print(f"  [entitlements] {label}: {ent['path']} → {ent['keys']}"
                      + (f"｜Keychain={ent['keychainAccessGroups']}"
                         if ent.get("keychainAccessGroups") else "｜无 Keychain 授权"))
        if built.get("present"):
            print(f"  [构建产物] {built['path']}｜类型={built.get('signature')}"
                  f"｜Team={built.get('teamIdentifier')}"
                  f"｜身份链={built.get('authorityChain')}")
            print(f"  [构建产物] 授权={built.get('entitlementKeys')}"
                  f"｜Keychain={built.get('keychainAccessGroups')}")
        else:
            print("  [构建产物] 尚无")
        print(f"== 结论：{'READY（前置条件就绪，可跑真实两阶段验收）' if ready else 'NOT READY'} ==")
        for gap in gaps:
            print(f"  - 缺失：{gap}")
        for note in notes:
            print(f"  - 说明：{note}")
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
