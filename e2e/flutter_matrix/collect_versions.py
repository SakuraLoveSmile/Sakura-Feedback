#!/usr/bin/env python3
"""从 pubspec.lock 里抽 flutter_secure_storage 家族的解析版本（独立实现，不复用实现者脚本）。

用法：collect_versions.py <pubspec.lock> <tier>
输出：JSON（stdout）
"""
import json
import sys

FAMILY = (
    "flutter_secure_storage",
    "flutter_secure_storage_darwin",
    "flutter_secure_storage_linux",
    "flutter_secure_storage_macos",
    "flutter_secure_storage_platform_interface",
    "flutter_secure_storage_web",
    "flutter_secure_storage_windows",
)


def parse_lock(path):
    """极简 pubspec.lock 解析：只取 packages 段里的 name -> version。"""
    out = {}
    section = None
    name = None
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line.startswith(" "):
                section = line.split(":", 1)[0].strip()
                continue
            if section != "packages":
                continue
            indent = len(line) - len(line.lstrip(" "))
            stripped = line.strip()
            if indent == 2 and stripped.endswith(":"):
                name = stripped[:-1]
            elif indent == 4 and stripped.startswith("version:") and name:
                out[name] = stripped.split(":", 1)[1].strip().strip('"')
    return out


def main():
    lock, tier = sys.argv[1], sys.argv[2]
    packages = parse_lock(lock)
    family = {k: packages[k] for k in FAMILY if k in packages}
    sys.stdout.write(json.dumps({
        "tier": tier,
        "lock": lock,
        "flutter_secure_storage": packages.get("flutter_secure_storage"),
        "family": family,
        "major": (packages.get("flutter_secure_storage") or "").split(".")[0],
        "package_count": len(packages),
    }, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
