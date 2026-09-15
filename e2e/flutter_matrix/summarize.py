#!/usr/bin/env python3
"""把三档结果汇总成 TSV，并做独立一致性断言（不复用实现者的 check_tier.py）。

用法：summarize.py <out_dir> <tier>...
"""
import json
import os
import sys


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def exits(out, tier):
    path = os.path.join(out, tier, "exitcodes.txt")
    data = {}
    if not os.path.exists(path):
        return data
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                data[k] = v
    return data


def tests_passed(out, tier, sub=""):
    path = os.path.join(out, tier, sub, "test.log")
    if not os.path.exists(path):
        return "?"
    count = None
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if "+" in line and line[:1].isdigit():
            head = line.split(":", 1)[-1].strip()
            if head.startswith("+"):
                count = head.split()[0]
    if "All tests passed" in open(path, encoding="utf-8", errors="replace").read():
        return f"{count} passed" if count else "passed"
    return "FAILED"


def major(version):
    return version.split(".")[0] if version else None


def main():
    out = sys.argv[1]
    tiers = sys.argv[2:]
    rows = []
    problems = []
    for tier in tiers:
        set_ = read_json(os.path.join(out, tier, "resolved.json")) or {}
        host = read_json(os.path.join(out, tier, "host", "resolved.json")) or {}
        ex = exits(out, tier)
        fam = set_.get("family", {})
        host_fam = host.get("family", {})
        rows.append([
            tier,
            set_.get("flutter_secure_storage") or "?",
            fam.get("flutter_secure_storage_darwin", "-"),
            fam.get("flutter_secure_storage_macos", "-"),
            fam.get("flutter_secure_storage_windows", "-"),
            fam.get("flutter_secure_storage_platform_interface", "-"),
            ex.get("pub_get_exit", "?"),
            ex.get("analyze_exit", "?"),
            ex.get("test_exit", "?"),
            tests_passed(out, tier),
            host.get("flutter_secure_storage") or "?",
            ex.get("host_pub_get_exit", "?"),
            ex.get("host_analyze_exit", "?"),
            ex.get("host_test_exit", "?"),
            tests_passed(out, tier, "host"),
        ])
        # 独立断言：A) SUT 与宿主两条路径解析出的主版本必须一致且等于目标档
        if major(set_.get("flutter_secure_storage")) != tier.split(".")[0]:
            problems.append(f"{tier}: SUT resolved {set_.get('flutter_secure_storage')}")
        if major(host.get("flutter_secure_storage")) != tier.split(".")[0]:
            problems.append(f"{tier}: host resolved {host.get('flutter_secure_storage')}")
        if not host_fam.get("flutter_secure_storage_darwin") and major(tier) in ("10", "11"):
            problems.append(f"{tier}: host missing darwin subpackage")
        for key in ("pub_get_exit", "analyze_exit", "test_exit",
                    "host_pub_get_exit", "host_analyze_exit", "host_test_exit"):
            if ex.get(key) != "0":
                problems.append(f"{tier}: {key}={ex.get(key)}")

    header = [
        "tier", "sut_resolved", "darwin", "macos", "windows", "platform_interface",
        "pub_get", "analyze", "test", "sut_tests",
        "host_resolved", "host_pub_get", "host_analyze", "host_test", "host_tests",
    ]
    print("\t".join(header))
    for row in rows:
        print("\t".join(str(c) for c in row))
    print()
    print(f"# source-identity: sut==workspace => "
          + ", ".join(f"{t}={open(os.path.join(out, t, 'source-identity.txt')).read().splitlines()[-1]}"
                      for t in tiers if os.path.exists(os.path.join(out, t, "source-identity.txt"))))
    print("# problems: " + ("none" if not problems else "; ".join(problems)))


if __name__ == "__main__":
    main()
