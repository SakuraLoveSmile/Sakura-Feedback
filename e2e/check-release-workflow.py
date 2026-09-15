#!/usr/bin/env python3
"""发布流水线静态校验：从 .github/workflows/release.yml 抽取真实步骤脚本并在沙箱中执行。

用法（在仓库根目录或任意目录都可跑，脚本按自身位置定位仓库根）：

    python3 e2e/check-release-workflow.py

不是重新实现一遍逻辑，而是把工作流里将要运行的脚本抽出来跑，验证行为（含失败路径）。
**这是静态/YAML 级 + 脚本级验证**：不运行 GitHub Actions，也不覆盖 Actions 运行时语义
（job 依赖与 if 求值、artifact 跨 job 下载、gh release 网络调用、镜像真实推送与 digest）。
这套流水线尚未在真实 CI 运行过，结论不得读作「已在真实 CI 验证」。

覆盖：契约命令、run 块内无 ${{ }} 插值、权限最小化、ci.yml 门禁保留、全部 run 块 bash -n、
渠道判定（稳定/预发布/手动/非法标签/提交不一致/fail-closed）、两个镜像的 digest 记录步骤、
release-manifest.json 生成器（含被 apps/updater 真实解析器验收与 7 类失败路径）、
release job 的本地产物校验与远端资产复查。
"""

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

import yaml

# 仓库根 = 本文件所在目录（e2e/）的上一级；不写死绝对路径，可直接在仓库根复跑。
ROOT = pathlib.Path(__file__).resolve().parent.parent
WF_PATH = ROOT / ".github/workflows/release.yml"
WF = yaml.safe_load(WF_PATH.read_text(encoding="utf-8"))

RESULTS = []


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def step_run(job, step_name):
    for step in WF["jobs"][job]["steps"]:
        if step.get("name") == step_name:
            assert "run" in step, f"step {step_name} 没有 run"
            return step["run"]
    raise KeyError(f"{job}/{step_name}")


def heredoc(run, tag):
    match = re.search(r"<<'" + tag + r"'\n(.*?)\n" + tag + r"\s*$", run, re.S | re.M)
    assert match, f"找不到 {tag} heredoc"
    return match.group(1)


def run_cmd(cmd, cwd, env=None, script=None):
    full_env = dict(os.environ)
    full_env.update(env or {})
    kwargs = dict(cwd=cwd, env=full_env, capture_output=True, text=True, errors="replace")
    if script is None:
        proc = subprocess.run(cmd, shell=True, **kwargs)
    else:
        proc = subprocess.run(cmd, input=script, shell=True, **kwargs)
    return proc


def check_contract_commands():
    for workflow in ("release.yml", "ci.yml"):
        proc = run_cmd(
            f"python3 -c \"import yaml;d=yaml.safe_load(open('.github/workflows/{workflow}'));assert d.get('jobs');print('yaml ok')\"",
            ROOT,
        )
        record(f"YAML 解析 .github/workflows/{workflow}", proc.returncode == 0 and "yaml ok" in proc.stdout, proc.stderr.strip()[:120])

    raw = WF_PATH.read_text(encoding="utf-8")
    record("grep release-manifest.json", "release-manifest.json" in raw)
    record("grep sakura-feedback-updater", "sakura-feedback-updater" in raw)


def check_no_shell_interpolation():
    offenders = []
    for job, jd in WF["jobs"].items():
        for step in jd.get("steps") or []:
            if "run" in step and "${{" in step["run"]:
                offenders.append(f"{job}/{step.get('name', '?')}")
    record("run 块内没有 ${{ }} 插值（外部值只经 env 传入）", not offenders, ", ".join(offenders))


def check_permissions():
    top = WF.get("permissions")
    record("顶层权限只读", top == {"contents": "read"}, json.dumps(top))

    write_jobs = {}
    for job, jd in WF["jobs"].items():
        perms = jd.get("permissions") or {}
        write_jobs[job] = [k for k, v in perms.items() if v == "write"]
    pkgs = [j for j, keys in write_jobs.items() if "packages" in keys]
    contents = [j for j, keys in write_jobs.items() if "contents" in keys]
    record("packages: write 仅授予 publish job", pkgs == ["publish"], f"实得 {pkgs}")
    record("contents: write 仅授予最后公开 Release 的 job", contents == ["release"], f"实得 {contents}")


def check_ci_gate_preserved():
    ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    triggers = ci[True] if True in ci else ci.get("on")
    record("ci.yml 保留 workflow_call（release 复用门禁）", "workflow_call" in triggers, json.dumps(triggers, ensure_ascii=False))
    record("ci.yml 保留 secrets-guard", "secrets-guard" in ci["jobs"], ", ".join(ci["jobs"]))
    record(
        "ci.yml 保留 node-checks（build→typecheck→lint→test 顺序）",
        "node-checks" in ci["jobs"]
        and [s.get("name") for s in ci["jobs"]["node-checks"]["steps"]][-4:]
        == ["build（先产出 workspace 包的 dist 与类型声明）", "typecheck", "lint", "test"],
    )
    record("ci.yml 保留 flutter-checks", "flutter-checks" in ci["jobs"])
    record("release.yml 仍以 workflow_call 复用 ci.yml", WF["jobs"]["checks"].get("uses") == "./.github/workflows/ci.yml")
    diff = run_cmd("git diff --stat -- .github/workflows/ci.yml", ROOT)
    record("ci.yml 未被修改（未降低门禁）", diff.stdout.strip() == "", diff.stdout.strip())


def check_manifest_generation():
    """抽取 manifest 的 Python 生成器，在沙箱里跑（含失败路径），并用执行器真实解析器验收。"""
    run = step_run("manifest", "生成 release-manifest.json")
    generator = heredoc(run, "PY")
    digest = "sha256:" + "a" * 64
    updater_digest = "sha256:" + "b" * 64
    commit = "c" * 40
    base_env = {
        "VERSION": "0.3.0",
        "CHANNEL": "stable",
        "TAG": "v0.3.0",
        "COMMIT": commit,
        "IMAGE_NAME": "ghcr.io/sakuralovesmile/sakura-feedback",
        "UPDATER_IMAGE_NAME": "ghcr.io/sakuralovesmile/sakura-feedback-updater",
        "PLATFORM": "linux/amd64",
        "UPDATER_PROTOCOL_VERSION": "1",
        "FEEDBACK_DIGEST": digest,
        "UPDATER_DIGEST": updater_digest,
    }

    def sandbox():
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-gen-"))
        (tmp / "digests").mkdir()
        (tmp / "digests/feedback-image-digest.txt").write_text(
            f"image: {base_env['IMAGE_NAME']}\ndigest: {digest}\ntags:\n  - v0.3.0\n", encoding="utf-8"
        )
        (tmp / "digests/updater-image-digest.txt").write_text(
            f"image: {base_env['UPDATER_IMAGE_NAME']}\ndigest: {updater_digest}\ntags:\n  - 0.1.0\n", encoding="utf-8"
        )
        (tmp / "apps/server/src/db").mkdir(parents=True)
        shutil.copy(ROOT / "apps/server/src/db/db.ts", tmp / "apps/server/src/db/db.ts")
        (tmp / "gen.py").write_text(generator, encoding="utf-8")
        return tmp

    # schema 期望值从真实源码的迁移常量推导（不写死 3：源码新增迁移后 harness 不该误报）
    real_db_text = (ROOT / "apps/server/src/db/db.ts").read_text(encoding="utf-8")
    schema_versions = [int(value) for value in re.findall(r"PRAGMA\s+user_version\s*=\s*(\d+)", real_db_text)]
    assert schema_versions, "apps/server/src/db/db.ts 里找不到 PRAGMA user_version 迁移常量"
    expected_schema = max(schema_versions)

    # 正例
    tmp = sandbox()
    proc = run_cmd("python3 gen.py", tmp, env=base_env)
    ok = proc.returncode == 0 and (tmp / "release-manifest.json").is_file()
    record("生成器：两个 digest 齐全时产出清单", ok, proc.stdout.strip().splitlines()[-1][:140] if proc.stdout.strip() else proc.stderr[-200:])
    produced_manifest = None
    if ok:
        manifest = json.loads((tmp / "release-manifest.json").read_text(encoding="utf-8"))
        produced_manifest = manifest
        expected_keys = [
            "manifestVersion", "version", "commit", "tag", "channel", "services",
            "platform", "dbSchemaVersion", "requiredUpdaterProtocol", "publishedAt",
        ]
        record("清单字段与冻结契约完全一致（键集合）", sorted(manifest) == sorted(expected_keys), f"{sorted(manifest)}")
        record(
            "清单取值符合契约（stable/linux-amd64/v%s/dbSchema=%d/protocol=1）" % (base_env["VERSION"], expected_schema),
            manifest["manifestVersion"] == 1
            and manifest["version"] == "0.3.0"
            and manifest["channel"] == "stable"
            and manifest["tag"] == "v0.3.0"
            and manifest["commit"] == commit
            and manifest["platform"] == "linux/amd64"
            and manifest["dbSchemaVersion"] == expected_schema
            and manifest["requiredUpdaterProtocol"] == 1
            and manifest["services"]["feedback"]["digest"] == digest
            and manifest["services"]["updater"]["digest"] == updater_digest
            and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", manifest["publishedAt"]),
            json.dumps(manifest, ensure_ascii=False),
        )
        # 用执行器真实解析器验收
        node_script = """
import fs from "node:fs";
import { parseManifest } from "%s/apps/updater/src/manifest.ts";
const parsed = parseManifest(JSON.parse(fs.readFileSync("%s/release-manifest.json", "utf8")), "stable");
if (parsed.services.updater === null) throw new Error("no updater ref");
console.log(JSON.stringify({version: parsed.version, channel: parsed.channel, dbSchemaVersion: parsed.dbSchemaVersion, protocol: parsed.requiredUpdaterProtocol}));
""" % (ROOT, tmp)
        proc = run_cmd(
            "node --experimental-strip-types --input-type=module --no-warnings -",
            tmp,
            script=node_script,
        )
        record(
            "生成的清单被 apps/updater 真实解析器 parseManifest 接受",
            proc.returncode == 0 and '"channel":"stable"' in proc.stdout,
            (proc.stdout.strip() or proc.stderr.strip())[-200:],
        )

    # 失败路径
    negative_cases = [
        ("渠道非 stable 时拒绝生成", {"CHANNEL": "prerelease"}),
        ("标签与源码版本不一致时拒绝生成", {"TAG": "v0.2.9"}),
        ("UPDATER_DIGEST 与记录文件不一致时拒绝生成", {"UPDATER_DIGEST": "sha256:" + "d" * 64}),
        ("digest 格式非法时拒绝生成", {"FEEDBACK_DIGEST": "not-a-digest"}),
        ("协议版本缺失时拒绝生成", {"UPDATER_PROTOCOL_VERSION": ""}),
    ]
    for label, override in negative_cases:
        tmp = sandbox()
        env = dict(base_env)
        env.update(override)
        proc = run_cmd("python3 gen.py", tmp, env=env)
        produced = (tmp / "release-manifest.json").is_file()
        record(f"生成器：{label}", proc.returncode != 0 and not produced, f"exit={proc.returncode} 产出清单={produced}")

    # updater digest 文件缺失
    tmp = sandbox()
    (tmp / "digests/updater-image-digest.txt").unlink()
    proc = run_cmd("python3 gen.py", tmp, env=base_env)
    record("生成器：任一镜像 digest 文件缺失即失败且不产出清单", proc.returncode != 0 and not (tmp / "release-manifest.json").is_file(), f"exit={proc.returncode}")

    # db.ts 读不到迁移常量
    tmp = sandbox()
    (tmp / "apps/server/src/db/db.ts").write_text("// 没有 PRAGMA user_version\n", encoding="utf-8")
    proc = run_cmd("python3 gen.py", tmp, env=base_env)
    record("生成器：读不到 PRAGMA user_version 即失败（不硬编码猜测）", proc.returncode != 0, f"exit={proc.returncode}")

    # 清单里的 schema 版本必须等于真实 db.ts 迁移常量的最大值（读源码，不硬编码猜测）
    record(
        "dbSchemaVersion 与源码迁移常量一致（db.ts 迁移序列 %s → %d）" % (schema_versions, expected_schema),
        produced_manifest is not None and produced_manifest["dbSchemaVersion"] == expected_schema,
        f"清单值 = {produced_manifest['dbSchemaVersion'] if produced_manifest else '未产出清单'}",
    )


def make_local_fixture(tmp, digest="sha256:" + "a" * 64, updater_digest="sha256:" + "b" * 64, commit="c" * 40, version="0.3.0"):
    (tmp / "out").mkdir(parents=True, exist_ok=True)
    (tmp / "digests").mkdir(parents=True, exist_ok=True)
    (tmp / "manifest").mkdir(parents=True, exist_ok=True)
    (tmp / "out/feedback-web-0.3.0.tgz").write_bytes(b"tgz-bytes")
    (tmp / "out/feedback-web-dist.zip").write_bytes(b"web-zip")
    (tmp / "out/feedback-admin-dist.zip").write_bytes(b"admin-zip")
    if (tmp / "out/SHA256SUMS").exists():
        (tmp / "out/SHA256SUMS").unlink()
    lines = []
    for path in sorted((tmp / "out").glob("*.tgz")) + sorted((tmp / "out").glob("*.zip")):
        digest_hex = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest_hex}  ./{path.name}")
    (tmp / "out/SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (tmp / "out/SOURCE.txt").write_text(f"commit={commit}\nversion={version}\nchannel=stable\ntag=v{version}\n", encoding="utf-8")
    (tmp / "digests/feedback-image-digest.txt").write_text(
        f"image: ghcr.io/sakuralovesmile/sakura-feedback\ndigest: {digest}\n", encoding="utf-8")
    (tmp / "digests/updater-image-digest.txt").write_text(
        f"image: ghcr.io/sakuralovesmile/sakura-feedback-updater\ndigest: {updater_digest}\n", encoding="utf-8")
    manifest = {
        "manifestVersion": 1, "version": version, "commit": commit, "tag": f"v{version}", "channel": "stable",
        "services": {
            "feedback": {"image": "ghcr.io/sakuralovesmile/sakura-feedback", "digest": digest},
            "updater": {"image": "ghcr.io/sakuralovesmile/sakura-feedback-updater", "digest": updater_digest},
        },
        "platform": "linux/amd64", "dbSchemaVersion": 3, "requiredUpdaterProtocol": 1,
        "publishedAt": "2026-01-01T00:00:00Z",
    }
    (tmp / "manifest/release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def check_release_job_local_validation():
    run = step_run("release", "校验本地产物齐全且互相一致")
    validator = heredoc(run, "PY")
    env = {"VERSION": "0.3.0", "TAG": "v0.3.0", "COMMIT": "c" * 40}

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-local-"))
    make_local_fixture(tmp)
    (tmp / "check.py").write_text(validator, encoding="utf-8")
    proc = run_cmd("( cd out && sha256sum -c SHA256SUMS ) && python3 check.py", tmp, env=env)
    record("release job：本地产物齐全时通过（含 SHA256SUMS 校验）", proc.returncode == 0, (proc.stdout.strip() or proc.stderr.strip())[-160:])

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-local-"))
    make_local_fixture(tmp)
    (tmp / "check.py").write_text(validator, encoding="utf-8")
    manifest = json.loads((tmp / "manifest/release-manifest.json").read_text(encoding="utf-8"))
    manifest["services"]["feedback"]["digest"] = "sha256:" + "e" * 64
    (tmp / "manifest/release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    proc = run_cmd("( cd out && sha256sum -c SHA256SUMS ) && python3 check.py", tmp, env=env)
    record("release job：清单 digest 与 digest 文件不一致即失败", proc.returncode != 0, f"exit={proc.returncode}")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-local-"))
    make_local_fixture(tmp)
    (tmp / "out/feedback-admin-dist.zip").unlink()
    (tmp / "check.py").write_text(validator, encoding="utf-8")
    proc = run_cmd("( cd out && sha256sum -c SHA256SUMS ) && python3 check.py", tmp, env=env)
    record("release job：缺少 dist 压缩包即失败（且 SHA256SUMS 也先报错）", proc.returncode != 0, f"exit={proc.returncode}")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-local-"))
    make_local_fixture(tmp)
    (tmp / "out/feedback-web-dist.zip").write_bytes(b"tampered")
    (tmp / "check.py").write_text(validator, encoding="utf-8")
    proc = run_cmd("( cd out && sha256sum -c SHA256SUMS ) && python3 check.py", tmp, env=env)
    record("release job：产物被篡改时 SHA256SUMS 校验失败", proc.returncode != 0 and "FAILED" in proc.stdout, proc.stdout.strip()[-120:])


def check_release_job_remote_validation():
    run = step_run("release", "公开前复查远端资产齐全（缺一即退出，Release 保持 draft）")
    validator = heredoc(run, "PY")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-remote-"))
    make_local_fixture(tmp)
    (tmp / "check.py").write_text(validator, encoding="utf-8")
    expected = [
        "feedback-web-0.3.0.tgz", "feedback-web-dist.zip", "feedback-admin-dist.zip",
        "SHA256SUMS", "SOURCE.txt", "feedback-image-digest.txt", "updater-image-digest.txt",
        "release-manifest.json",
    ]
    (tmp / "release-assets.txt").write_text("\n".join(expected) + "\n", encoding="utf-8")
    proc = run_cmd("python3 check.py", tmp)
    record("release job：远端资产齐全时通过（8 项）", proc.returncode == 0 and "远端资产齐全（8 项）" in proc.stdout, proc.stdout.strip()[-160:])

    (tmp / "release-assets.txt").write_text("\n".join(expected[:-1]) + "\n", encoding="utf-8")
    proc = run_cmd("python3 check.py", tmp)
    record("release job：远端缺少清单时不公开（失败退出）", proc.returncode != 0 and "release-manifest.json" in proc.stdout, f"exit={proc.returncode}")

    (tmp / "release-assets.txt").write_text("", encoding="utf-8")
    proc = run_cmd("python3 check.py", tmp)
    record("release job：远端资产列表为空时失败", proc.returncode != 0, f"exit={proc.returncode}")


def check_digest_step():
    """抽取 publish job 的 digest 记录步骤（真实 shell 函数），验证空/非法 digest 失败。"""
    run = step_run("publish", "记录并校验两个镜像的 digest（任一缺失/为空即失败）")
    good = "sha256:" + "a" * 64
    bad = "sha256:" + "b" * 64

    def sandbox(env):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-digest-"))
        (tmp / "step.sh").write_text(run, encoding="utf-8")
        (tmp / "summary.md").write_text("", encoding="utf-8")
        base = {
            "IMAGE_NAME": "ghcr.io/sakuralovesmile/sakura-feedback",
            "UPDATER_IMAGE_NAME": "ghcr.io/sakuralovesmile/sakura-feedback-updater",
            "GITHUB_STEP_SUMMARY": str(tmp / "summary.md"),
        }
        base.update(env)
        proc = run_cmd("bash step.sh", tmp, env=base)
        return tmp, proc

    tmp, proc = sandbox({"FEEDBACK_DIGEST": good, "UPDATER_DIGEST": bad, "FEEDBACK_TAGS": "v0.3.0", "UPDATER_TAGS": "0.1.0"})
    files_ok = (tmp / "digests/feedback-image-digest.txt").is_file() and (tmp / "digests/updater-image-digest.txt").is_file()
    content = (tmp / "digests/updater-image-digest.txt").read_text(encoding="utf-8") if files_ok else ""
    record(
        "digest 记录步骤：正常路径写出两份 digest 且带 image/digest/tags",
        proc.returncode == 0 and files_ok and "image: ghcr.io/sakuralovesmile/sakura-feedback-updater" in content,
        content.replace("\n", " | ")[:160],
    )

    _, proc = sandbox({"FEEDBACK_DIGEST": good, "UPDATER_DIGEST": "", "FEEDBACK_TAGS": "v0.3.0", "UPDATER_TAGS": "0.1.0"})
    record("digest 记录步骤：updater digest 为空即失败", proc.returncode != 0, f"exit={proc.returncode}")

    _, proc = sandbox({"FEEDBACK_DIGEST": "", "UPDATER_DIGEST": bad, "FEEDBACK_TAGS": "v0.3.0", "UPDATER_TAGS": "0.1.0"})
    record("digest 记录步骤：feedback digest 为空即失败", proc.returncode != 0, f"exit={proc.returncode}")

    _, proc = sandbox({"FEEDBACK_DIGEST": "sha256:short", "UPDATER_DIGEST": bad, "FEEDBACK_TAGS": "v0.3.0", "UPDATER_TAGS": "0.1.0"})
    record("digest 记录步骤：digest 格式非法即失败", proc.returncode != 0, f"exit={proc.returncode}")


def check_classify():
    """抽取 plan job 的渠道判定脚本，按场景验证稳定渠道判定表。"""
    run = step_run("plan", "判定版本与渠道")
    git_dir = ROOT / ".git"

    def sandbox(version="0.3.0", updater_version="0.1.0"):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="t5-plan-"))
        (tmp / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        (tmp / "apps/updater").mkdir(parents=True)
        (tmp / "apps/updater/package.json").write_text(json.dumps({"version": updater_version}), encoding="utf-8")
        (tmp / "step.sh").write_text(run, encoding="utf-8")
        (tmp / "github_output").write_text("", encoding="utf-8")
        return tmp

    def outputs(tmp):
        return dict(
            line.split("=", 1) for line in (tmp / "github_output").read_text(encoding="utf-8").splitlines() if "=" in line
        )

    def scenario(label, env, expect_exit=0, expect=None):
        tmp = sandbox()
        base = {"GITHUB_OUTPUT": str(tmp / "github_output"), "GIT_DIR": str(git_dir)}
        base.update(env)
        proc = run_cmd("bash step.sh", tmp, env=base)
        got = outputs(tmp)
        ok = proc.returncode == expect_exit
        if ok and expect:
            ok = all(got.get(k) == v for k, v in expect.items())
        record(f"plan 判定：{label}", ok, f"exit={proc.returncode} out={got} {(proc.stdout.strip().splitlines() or [''])[-1][:120]}")

    # 正式标签 + 版本一致 + 标签指向本次提交 → stable（用真实仓库的既有标签 v0.1.0 只读验证 git 分支）
    real_commit = subprocess.run(["git", "rev-parse", "v0.1.0^{commit}"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    tmp = sandbox(version="0.1.0")
    (tmp / "step.sh").write_text(run, encoding="utf-8")
    (tmp / "github_output").write_text("", encoding="utf-8")
    proc = run_cmd(
        "bash step.sh",
        tmp,
        env={
            "GITHUB_OUTPUT": str(tmp / "github_output"),
            "GIT_DIR": str(git_dir),
            "EVENT_NAME": "push",
            "REF_TYPE": "tag",
            "TAG_NAME": "v0.1.0",
            "HEAD_SHA": real_commit,
        },
    )
    got = outputs(tmp)
    record(
        "plan 判定：正式标签且与源码版本、提交都一致 → stable=true（真实 git 标签只读校验）",
        proc.returncode == 0 and got.get("stable") == "true" and got.get("channel") == "stable",
        f"exit={proc.returncode} out={got}",
    )

    proc = run_cmd(
        "bash step.sh",
        tmp,
        env={
            "GITHUB_OUTPUT": str(tmp / "github_output"),
            "GIT_DIR": str(git_dir),
            "EVENT_NAME": "push",
            "REF_TYPE": "tag",
            "TAG_NAME": "v0.1.0",
            "HEAD_SHA": "f" * 40,
        },
    )
    record("plan 判定：标签指向的提交与本次运行不一致 → 失败", proc.returncode != 0, f"exit={proc.returncode}")

    scenario(
        "正式标签与源码版本不一致 → 失败",
        {"EVENT_NAME": "push", "REF_TYPE": "tag", "TAG_NAME": "v0.2.0", "HEAD_SHA": real_commit},
        expect_exit=1,
    )
    scenario(
        "预发布标签 → 不进入稳定渠道（channel=prerelease, stable=false）",
        {"EVENT_NAME": "push", "REF_TYPE": "tag", "TAG_NAME": "v0.3.0-rc.1", "HEAD_SHA": real_commit},
        expect={"channel": "prerelease", "stable": "false"},
    )
    scenario(
        "手动触发（workflow_dispatch）→ channel=manual, stable=false",
        {"EVENT_NAME": "workflow_dispatch", "REF_TYPE": "branch", "TAG_NAME": "main", "HEAD_SHA": real_commit},
        expect={"channel": "manual", "stable": "false"},
    )
    scenario(
        "分支推送标签名不合法 → 失败",
        {"EVENT_NAME": "push", "REF_TYPE": "tag", "TAG_NAME": "release-0.3.0", "HEAD_SHA": real_commit},
        expect_exit=1,
    )
    scenario(
        "标签无法解析（空 git 仓库）→ fail-closed",
        {"EVENT_NAME": "push", "REF_TYPE": "tag", "TAG_NAME": "v0.3.0", "HEAD_SHA": real_commit, "GIT_DIR": str(pathlib.Path(tempfile.mkdtemp(prefix="t5-empty-git-")))},
        expect_exit=1,
    )

    tmp = sandbox(version="0.3.0")
    (tmp / "step.sh").write_text(run, encoding="utf-8")
    (tmp / "github_output").write_text("", encoding="utf-8")
    proc = run_cmd(
        "bash step.sh", tmp,
        env={"GITHUB_OUTPUT": str(tmp / "github_output"), "GIT_DIR": str(git_dir), "EVENT_NAME": "workflow_dispatch",
             "REF_TYPE": "branch", "TAG_NAME": "main", "HEAD_SHA": real_commit},
    )
    record("plan 判定：updater 版本单独输出且与反馈服务版本解耦（0.1.0）", outputs(tmp).get("updater_version") == "0.1.0", str(outputs(tmp)))

    tmp = sandbox(version="0.3")
    (tmp / "step.sh").write_text(run, encoding="utf-8")
    (tmp / "github_output").write_text("", encoding="utf-8")
    proc = run_cmd(
        "bash step.sh", tmp,
        env={"GITHUB_OUTPUT": str(tmp / "github_output"), "GIT_DIR": str(git_dir), "EVENT_NAME": "workflow_dispatch",
             "REF_TYPE": "branch", "TAG_NAME": "main", "HEAD_SHA": real_commit},
    )
    record("plan 判定：源码版本不是 X.Y.Z → 失败", proc.returncode != 0, f"exit={proc.returncode}")


def check_shell_syntax():
    """抽取每个 run 块做 bash 语法检查（bash -n），避免 YAML 对但 shell 错。"""
    bad = []
    for job, jd in WF["jobs"].items():
        for step in jd.get("steps") or []:
            if "run" not in step:
                continue
            proc = subprocess.run(["bash", "-n"], input=step["run"], capture_output=True, text=True)
            if proc.returncode != 0:
                bad.append(f"{job}/{step.get('name', '?')}: {proc.stderr.strip()[:120]}")
    record("所有 run 块通过 bash -n 语法检查", not bad, "; ".join(bad))


def main():
    print(f"工作流：{WF_PATH.relative_to(ROOT)}（sha256={__import__('hashlib').sha256(WF_PATH.read_bytes()).hexdigest()}）\n")
    check_contract_commands()
    check_no_shell_interpolation()
    check_permissions()
    check_ci_gate_preserved()
    check_shell_syntax()
    check_classify()
    check_digest_step()
    check_manifest_generation()
    check_release_job_local_validation()
    check_release_job_remote_validation()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n共 {len(RESULTS)} 项断言，通过 {len(RESULTS) - len(failed)}，失败 {len(failed)}")
    if failed:
        print("失败项：")
        for name in failed:
            print(" -", name)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
