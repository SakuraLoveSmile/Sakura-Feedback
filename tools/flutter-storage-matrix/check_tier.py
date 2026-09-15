#!/usr/bin/env python3
"""按档校验隔离矩阵宿主的解析结果与插件硬约束。

设计原则：**不猜版本**。所有结论都来自实际产物：
- 宿主 `pubspec.lock` / `.dart_tool/package_config.json`：实际解析到的插件与
  federated 子包版本；
- 插件包自身（pub cache）的 `pubspec.yaml` 与 `android/build.gradle`：Dart /
  Android 硬要求；
- 可选的 Music（sakuramusic）检出版本：宿主侧约束的对照来源。

用法：
  python3 check_tier.py --tier 11.0.0 --host <host 目录> [--music <Music 目录>]

退出码：0 = 全部通过；1 = 有失败项；2 = 用法/环境问题（如宿主未 pub get）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Optional

PREFIX = "flutter_secure_storage"

# 每档的 federated 家族形态。这些不是猜的：由各档实际 pub get 解析结果确定，
# 并在 run.sh 的每次运行中重新核对（对不上即失败）。
TIER_RULES: dict[str, dict[str, object]] = {
    "9.2.2": {
        "darwin": False,  # 9.x 走 flutter_secure_storage_macos
        "macos_major": 3,
        "windows_major": 3,
        "platform_interface_major": 1,
    },
    "10.3.1": {
        "darwin": True,  # 10.x 起 darwin 统一 iOS/macOS
        "macos_major": None,  # 不再解析出 _macos
        "windows_major": 4,
        "platform_interface_major": 2,
    },
    "11.0.0": {
        "darwin": True,
        "macos_major": None,
        "windows_major": 4,
        "platform_interface_major": 2,
    },
}

# 11 档与 Music 一致的硬约束（来源见 MUSIC-CONSTRAINTS.md）：
# - Dart >=3.8（flutter_secure_storage 11.0.0 的 environment.sdk 下限）
# - Android minSdk 24 / compileSdk 37（11.0.0 的 android/build.gradle）
MUSIC_PARITY_TIERS = {"11.0.0"}
EXPECTED_ANDROID_COMPILE_SDK = 37
EXPECTED_ANDROID_MIN_SDK = 24
EXPECTED_DART_FLOOR = (3, 8, 0)


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[bool, str, str]] = []

    def check(self, ok: bool, name: str, detail: str) -> bool:
        self.rows.append((ok, name, detail))
        return ok

    def info(self, name: str, detail: str) -> None:
        self.rows.append((True, name, detail))

    @property
    def failed(self) -> list[tuple[bool, str, str]]:
        return [r for r in self.rows if not r[0]]

    def dump(self) -> None:
        for ok, name, detail in self.rows:
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {name}: {detail}")
        if self.failed:
            print(f"  {len(self.failed)} 项失败")
        else:
            print("  全部通过")


def parse_lock_versions(path: str) -> dict[str, str]:
    """从 pubspec.lock 中取出 包名 -> 版本（只认包条目，忽略 description 内的键）。"""
    out: dict[str, str] = {}
    current: Optional[str] = None
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            raw = line.rstrip("\n")
            header = re.match(r"^  ([A-Za-z0-9_]+):\s*$", raw)
            if header:
                current = header.group(1)
                continue
            if current is not None:
                version = re.match(r'^    version: "?([^"\s]+)"?\s*$', raw)
                if version:
                    out[current] = version.group(1)
                    current = None
    return out


def parse_package_roots(host: str) -> dict[str, str]:
    """从 .dart_tool/package_config.json 取 包名 -> 本地目录（解析权威来源）。"""
    path = os.path.join(host, ".dart_tool", "package_config.json")
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    roots: dict[str, str] = {}
    for entry in data["packages"]:
        uri = entry["rootUri"]
        if uri.startswith("file://"):
            roots[entry["name"]] = uri[len("file://") :]
        else:
            roots[entry["name"]] = os.path.normpath(
                os.path.join(host, ".dart_tool", uri)
            )
    return roots, data.get("generatorVersion", "")


def parse_sdk_floor(constraint: str) -> Optional[tuple[int, int, int]]:
    """把 Dart SDK 约束解析成下限三元组；无法识别时返回 None。"""
    text = constraint.strip().strip("'\"")
    caret = re.match(r"^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$", text)
    if caret:
        return (
            int(caret.group(1)),
            int(caret.group(2) or 0),
            int(caret.group(3) or 0),
        )
    gte = re.search(r">=\s*(\d+)\.(\d+)(?:\.(\d+))?", text)
    if gte:
        return (int(gte.group(1)), int(gte.group(2)), int(gte.group(3) or 0))
    exact = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?$", text)
    if exact:
        return (int(exact.group(1)), int(exact.group(2)), int(exact.group(3) or 0))
    return None


def read_yaml_environment_sdk(path: str) -> Optional[str]:
    """从 pubspec.yaml 的 environment 块里读出 sdk 一行（只读，不做完整 YAML 解析）。"""
    in_env = False
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            if re.match(r"^environment:\s*$", line):
                in_env = True
                continue
            if in_env:
                if line and not line.startswith((" ", "\t")):
                    break
                match = re.match(r"^\s+sdk:\s*(.+?)\s*$", line)
                if match:
                    return match.group(1)
    return None


def read_dependency_constraint(path: str, package: str) -> Optional[str]:
    """读出 pubspec.yaml 中某个依赖的版本约束原文。

    只认「2 空格缩进 + 包名 + 冒号 + 版本形态的值」，避免误命中 description
    等多行标量里出现的包名。
    """
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    pattern = re.compile(rf"(?m)^  {re.escape(package)}:[ \t]*(.+?)[ \t]*$")
    for match in pattern.finditer(text):
        value = match.group(1)
        if re.match(r"^['\"]?[\^<>=0-9]", value):
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", required=True, help="本档固定的 flutter_secure_storage 版本")
    parser.add_argument("--host", required=True, help="隔离宿主目录")
    parser.add_argument("--music", default="", help="可选的 Music（sakuramusic）检出目录")
    parser.add_argument(
        "--flutter-sdk",
        default="",
        help="本机 Flutter SDK 根目录：用于读取其 gradle 默认 compileSdk/minSdk",
    )
    parser.add_argument(
        "--example-gradle",
        default="",
        help="示例 app 的 android/app/build.gradle.kts（11 档须显式 compileSdk=37）",
    )
    parser.add_argument("--json-out", default="", help="可选：把结论写成 JSON")
    args = parser.parse_args()

    host = os.path.abspath(args.host)
    tier = args.tier
    report = Report()
    summary: dict[str, object] = {"tier": tier, "host": host, "checks": []}

    lock_path = os.path.join(host, "pubspec.lock")
    if not os.path.exists(lock_path):
        print(f"宿主未解析依赖（缺少 {lock_path}）；请先 flutter pub get", file=sys.stderr)
        return 2

    versions = parse_lock_versions(lock_path)
    try:
        roots, dart_version = parse_package_roots(host)
    except (OSError, KeyError, ValueError) as exc:
        print(f"无法读取 package_config.json：{exc}", file=sys.stderr)
        return 2

    resolved = {
        name: version
        for name, version in versions.items()
        if name == PREFIX or name.startswith(PREFIX + "_")
    }
    summary["resolved"] = dict(sorted(resolved.items()))
    summary["dart_sdk"] = dart_version

    print(f"== 档位 {tier} ==")
    report.info("实际解析到的包", json.dumps(summary["resolved"], ensure_ascii=False))
    report.info("Dart SDK", dart_version or "未知")

    # 1) 本档固定的版本确实生效。
    actual = resolved.get(PREFIX)
    report.check(
        actual == tier,
        "flutter_secure_storage 版本",
        f"期望 {tier}，实际 {actual}",
    )

    rules = TIER_RULES.get(tier)
    if rules is None:
        report.check(False, "档位规则", f"没有为 {tier} 定义家族的预期形态")
    else:
        darwin = resolved.get(PREFIX + "_darwin")
        macos = resolved.get(PREFIX + "_macos")
        windows = resolved.get(PREFIX + "_windows")
        interface = resolved.get(PREFIX + "_platform_interface")

        if rules["darwin"]:
            report.check(
                darwin is not None and macos is None,
                "federated：darwin 取代 _macos",
                f"darwin={darwin}，macos={macos}（期望 darwin 存在且不再解析 _macos）",
            )
        else:
            report.check(
                macos is not None and darwin is None,
                "federated：走 _macos（尚无 darwin）",
                f"macos={macos}，darwin={darwin}",
            )

        if rules["macos_major"] is not None and macos is not None:
            major = int(macos.split(".")[0])
            report.check(
                major == rules["macos_major"],
                "flutter_secure_storage_macos 主版本",
                f"期望 {rules['macos_major']}.x，实际 {macos}",
            )

        if windows is None:
            report.check(False, "flutter_secure_storage_windows", "未解析到该子包")
        else:
            major = int(windows.split(".")[0])
            report.check(
                major == rules["windows_major"],
                "flutter_secure_storage_windows 主版本",
                f"期望 {rules['windows_major']}.x，实际 {windows}",
            )

        if interface is None:
            report.check(False, "flutter_secure_storage_platform_interface", "未解析到该子包")
        else:
            major = int(interface.split(".")[0])
            report.check(
                major == rules["platform_interface_major"],
                "platform_interface 主版本",
                f"期望 {rules['platform_interface_major']}.x，实际 {interface}",
            )

    # 2) 禁止用 dependency_overrides 掩盖版本冲突（只看声明行，忽略注释里的说明文字）。
    host_pubspec = os.path.join(host, "pubspec.yaml")
    with open(host_pubspec, encoding="utf-8") as handle:
        pubspec_text = handle.read()
    declared_lines = [
        line for line in pubspec_text.splitlines() if not line.lstrip().startswith("#")
    ]
    has_override = any(
        re.match(r"^\s*dependency_overrides\s*:", line) for line in declared_lines
    )
    report.check(
        not has_override,
        "禁用 dependency_overrides",
        "宿主 pubspec.yaml 未声明 dependency_overrides"
        if not has_override
        else "宿主 pubspec.yaml 出现了 dependency_overrides 声明",
    )

    # 3) 宿主自身的 Dart 下限与 11 档要求一致（>=3.8），且不低于被解析包的可行域。
    host_floor = parse_sdk_floor(read_yaml_environment_sdk(host_pubspec) or "")
    report.check(
        host_floor is not None and host_floor >= EXPECTED_DART_FLOOR,
        "宿主 Dart 下限",
        f"{host_floor}（要求 >= {'.'.join(map(str, EXPECTED_DART_FLOOR))}）",
    )

    # 4) 11 档：与 Music 使用 11 的硬要求逐条对齐（读插件包自身元数据）。
    if tier in MUSIC_PARITY_TIERS:
        plugin_root = roots.get(PREFIX)
        if not plugin_root or not os.path.isdir(plugin_root):
            report.check(False, "插件包目录", f"package_config 未指向有效目录：{plugin_root}")
        else:
            plugin_sdk = read_yaml_environment_sdk(os.path.join(plugin_root, "pubspec.yaml"))
            floor = parse_sdk_floor(plugin_sdk or "")
            report.check(
                floor is not None and floor >= EXPECTED_DART_FLOOR,
                "插件包 Dart 下限（Music 对齐）",
                f"flutter_secure_storage {actual} 要求 sdk {plugin_sdk}，下限 {floor}",
            )
            if dart_version:
                def as_tuple(text: str) -> tuple[int, int, int]:
                    parts = [int(x) for x in re.findall(r"\d+", text)[:3]]
                    parts += [0] * (3 - len(parts))
                    return (parts[0], parts[1], parts[2])

                report.check(
                    floor is None or as_tuple(dart_version) >= floor,
                    "当前 Dart 满足插件下限",
                    f"本机 Dart {dart_version} >= {plugin_sdk}",
                )

            android_gradle = os.path.join(plugin_root, "android", "build.gradle")
            if os.path.exists(android_gradle):
                with open(android_gradle, encoding="utf-8") as handle:
                    gradle = handle.read()
                compile_sdk = re.search(r"compileSdk\s*=?\s*(\d+)", gradle)
                min_sdk = re.search(r"minSdk\s*=?\s*(\d+)", gradle)
                report.check(
                    compile_sdk is not None
                    and int(compile_sdk.group(1)) == EXPECTED_ANDROID_COMPILE_SDK,
                    "插件 Android compileSdk（Music 对齐）",
                    f"期望 {EXPECTED_ANDROID_COMPILE_SDK}，实际 "
                    f"{compile_sdk.group(1) if compile_sdk else '未找到'}",
                )
                report.check(
                    min_sdk is not None
                    and int(min_sdk.group(1)) == EXPECTED_ANDROID_MIN_SDK,
                    "插件 Android minSdk（Music 对齐）",
                    f"期望 {EXPECTED_ANDROID_MIN_SDK}，实际 "
                    f"{min_sdk.group(1) if min_sdk else '未找到'}",
                )
            else:
                report.check(False, "插件 Android gradle", f"未找到 {android_gradle}")

        # 4b) 示例 app 的 Android 配置必须显式满足 11 的要求。
        if args.example_gradle:
            example_gradle = os.path.abspath(args.example_gradle)
            if not os.path.exists(example_gradle):
                report.check(False, "示例 app gradle", f"未找到 {example_gradle}")
            else:
                with open(example_gradle, encoding="utf-8") as handle:
                    example_text = handle.read()
                example_compile = re.search(r"(?m)^\s*compileSdk\s*=\s*(\d+)", example_text)
                report.check(
                    example_compile is not None
                    and int(example_compile.group(1)) == EXPECTED_ANDROID_COMPILE_SDK,
                    "示例 app 显式 compileSdk",
                    f"期望显式 {EXPECTED_ANDROID_COMPILE_SDK}，实际 "
                    f"{example_compile.group(1) if example_compile else '未显式设置'}",
                )
                example_min = re.search(r"(?m)^\s*minSdk\s*=\s*([^\n]+)$", example_text)
                min_ok = False
                min_detail = "未找到 minSdk 行"
                if example_min:
                    raw = example_min.group(1).strip()
                    min_detail = raw
                    literal = re.match(r"(\d+)$", raw)
                    if literal:
                        min_ok = int(literal.group(1)) >= EXPECTED_ANDROID_MIN_SDK
                    elif "flutter.minSdkVersion" in raw:
                        # 继承 Flutter 默认值：由下面的 FlutterExtension 检查确认其为 24。
                        min_ok = True
                report.check(
                    min_ok,
                    "示例 app minSdk >= 24",
                    f"{min_detail}（要求 >= {EXPECTED_ANDROID_MIN_SDK}）",
                )
        else:
            report.info("示例 app gradle", "跳过：未传 --example-gradle")

        # 4c) 本机 Flutter 的 Android 默认值：证明“显式提升”是必要的、不是多余的。
        if args.flutter_sdk:
            extension = os.path.join(
                args.flutter_sdk,
                "packages",
                "flutter_tools",
                "gradle",
                "src",
                "main",
                "kotlin",
                "FlutterExtension.kt",
            )
            if not os.path.exists(extension):
                report.info("Flutter gradle 默认值", f"未找到 {extension}（跳过）")
            else:
                with open(extension, encoding="utf-8") as handle:
                    extension_text = handle.read()
                default_compile = re.search(
                    r"val\s+compileSdkVersion:\s*Int\s*=\s*(\d+)", extension_text
                )
                default_min = re.search(
                    r"val\s+minSdkVersion:\s*Int\s*=\s*(\d+)", extension_text
                )
                if default_compile and default_min:
                    report.check(
                        int(default_compile.group(1)) < EXPECTED_ANDROID_COMPILE_SDK,
                        "Flutter 默认 compileSdk 低于 11 的要求",
                        f"默认 {default_compile.group(1)} < {EXPECTED_ANDROID_COMPILE_SDK}"
                        "（所以示例必须显式提升，而不是沿用 flutter.compileSdkVersion）",
                    )
                    report.check(
                        int(default_min.group(1)) >= EXPECTED_ANDROID_MIN_SDK,
                        "Flutter 默认 minSdk >= 24",
                        f"默认 {default_min.group(1)}",
                    )
                else:
                    report.check(False, "Flutter gradle 默认值", "未能从 FlutterExtension.kt 解析出默认值")
        else:
            report.info("Flutter gradle 默认值", "跳过：未传 --flutter-sdk")

    # 5) Music 对照（可选；CI 上通常没有 Music 检出，此时明确记录为跳过而不是通过）。
    if args.music:
        music = os.path.abspath(args.music)
        music_pubspec = os.path.join(music, "pubspec.yaml")
        music_lock = os.path.join(music, "pubspec.lock")
        if os.path.exists(music_pubspec) and os.path.exists(music_lock):
            constraint = read_dependency_constraint(music_pubspec, PREFIX)
            music_versions = parse_lock_versions(music_lock)
            music_resolved = music_versions.get(PREFIX)
            summary["music"] = {
                "pubspec": music_pubspec,
                "constraint": constraint,
                "resolved": music_resolved,
                "windows": music_versions.get(PREFIX + "_windows"),
                "darwin": music_versions.get(PREFIX + "_darwin"),
            }
            report.info(
                "Music 侧约束来源",
                f"{music_pubspec}: {PREFIX}: {constraint}（lock 解析 {music_resolved}）",
            )
            if tier in MUSIC_PARITY_TIERS:
                report.check(
                    bool(music_resolved and music_resolved.startswith(tier.split(".")[0] + ".")),
                    "Music 与 11 档同主版本",
                    f"Music 解析 {music_resolved}，本档 {tier}",
                )
        else:
            report.info(
                "Music 对照",
                f"跳过：{music} 不存在或未 pub get（CI 不检入 Music 源码）",
            )
    else:
        report.info("Music 对照", "跳过：未传 --music")

    print()
    report.dump()

    summary["passed"] = not report.failed
    summary["checks"] = [
        {"ok": ok, "name": name, "detail": detail} for ok, name, detail in report.rows
    ]
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)

    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
