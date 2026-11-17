#!/usr/bin/env python3
"""deploy/update.sh 的安全更新回归：先下载 → 校验 → 再覆盖。

覆盖两条路径：
  1) 镜像：按 digest 暂存拉取，校验镜像 ID 与发布清单一致后才写标签与 .env.prod；
  2) geo 文件：下载到临时文件，校验体积/线格式/分类，校验失败绝不覆盖，成功后备份并原子替换。

测试用 PATH 里的假 docker 隔离真实环境；不访问网络、不碰真实容器。
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
UPDATE_SH = ROOT / "deploy" / "update.sh"

DIGEST = "sha256:" + "a" * 64
OTHER_DIGEST = "sha256:" + "b" * 64

STUB = r"""#!/usr/bin/env bash
# 记录调用并按场景返回固定结果；不做任何真实 docker 操作。
printf '%s\n' "$*" >>"$STUB_LOG"

case "$1" in
  pull)
    [ -z "${STUB_PULL_FAIL:-}" ] || { echo "stub pull failed" >&2; exit 1; }
    exit 0 ;;
  tag)
    exit 0 ;;
  image)
    if [ -n "${STUB_IMAGE_ID:-}" ]; then printf '%s\n' "$STUB_IMAGE_ID"; else printf '%s\n' "${3##*@}"; fi
    exit 0 ;;
  compose)
    for arg in "$@"; do
      case "$arg" in
        exec) printf '{"ok":true}\n'; exit 0 ;;
      esac
    done
    exit 0 ;;
  restart)
    exit 0 ;;
  inspect)
    printf 'running\n'
    exit 0 ;;
  logs)
    printf 'level=info msg="stub log"\n'
    exit 0 ;;
  *)
    exit 0 ;;
esac
"""


def write(path: pathlib.Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def geosite(*names: str) -> bytes:
    out = bytearray()
    for name in names:
        payload = name.encode("utf-8")
        inner = b"\x0a" + varint(len(payload)) + payload
        out += b"\x0a" + varint(len(inner)) + inner
    return bytes(out)


class Case:
    def __init__(self, workdir: pathlib.Path, stub: pathlib.Path, log: pathlib.Path):
        self.workdir = workdir
        self.stub = stub
        self.log = log

    def run(self, *args: str, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env["PATH"] = str(self.stub) + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin"
        env["STUB_LOG"] = str(self.log)
        for key in ("http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            env.pop(key, None)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            ["bash", str(UPDATE_SH), *args],
            cwd=self.workdir,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )

    def calls(self) -> list[str]:
        if not self.log.exists():
            return []
        return [line for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()]


def setup() -> Case:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="fb-update-"))
    stub = tmp / "bin"
    stub.mkdir()
    write(stub / "docker", STUB)
    deploy = tmp / "deploy"
    deploy.mkdir()
    (deploy / ".env.prod").write_text(
        "FEEDBACK_IMAGE=ghcr.io/example/feedback:latest\nFEEDBACK_DATA_VOLUME=feedback-data\n",
        encoding="utf-8",
    )
    (deploy / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    return Case(tmp, stub, tmp / "calls.log")


def manifest(tmp: pathlib.Path, tag: str = "v0.9.2", digest: str = DIGEST) -> pathlib.Path:
    path = tmp / "release-manifest.json"
    path.write_text(
        json.dumps(
            {
                "manifestVersion": 1,
                "version": tag.lstrip("v"),
                "tag": tag,
                "channel": "stable",
                "services": {"feedback": {"image": "ghcr.io/example/feedback", "digest": digest}},
            }
        ),
        encoding="utf-8",
    )
    return path


def expect(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    failures: list[str] = []
    tmp_dirs: list[pathlib.Path] = []

    syntax = subprocess.run(["bash", "-n", str(UPDATE_SH)], capture_output=True, text=True)
    expect(syntax.returncode == 0, "bash -n 未通过：" + syntax.stderr.strip(), failures)

    # 1) 镜像：暂存拉取 → 校验 → 才写标签与 env
    case = setup()
    tmp_dirs.append(case.workdir)
    mf = manifest(case.workdir)
    res = case.run("--deploy-dir", "deploy", "--to", "v0.9.2", "--manifest-url", mf.as_uri(), "--no-backup")
    joined = "\n".join(case.calls())
    env_text = (case.workdir / "deploy" / ".env.prod").read_text(encoding="utf-8")
    expect(res.returncode == 0, "[镜像成功] 退出码 %s：%s" % (res.returncode, res.stderr[-300:]), failures)
    expect("pull ghcr.io/example/feedback@" + DIGEST in joined, "[镜像成功] 未按 digest 暂存拉取", failures)
    expect("tag ghcr.io/example/feedback@" + DIGEST + " ghcr.io/example/feedback:v0.9.2" in joined,
           "[镜像成功] 校验后未写标签", failures)
    expect("FEEDBACK_IMAGE=ghcr.io/example/feedback:v0.9.2@" + DIGEST in env_text,
           "[镜像成功] .env.prod 未固定 tag@digest", failures)
    expect("up -d" in joined, "[镜像成功] 未重建容器", failures)

    # 2) 镜像 ID 与清单 digest 不一致 → 停下且不改 env
    case = setup()
    tmp_dirs.append(case.workdir)
    mf = manifest(case.workdir)
    res = case.run("--deploy-dir", "deploy", "--to", "v0.9.2", "--manifest-url", mf.as_uri(), "--no-backup",
                   env_extra={"STUB_IMAGE_ID": OTHER_DIGEST})
    joined = "\n".join(case.calls())
    env_text = (case.workdir / "deploy" / ".env.prod").read_text(encoding="utf-8")
    expect(res.returncode != 0, "[digest 不一致] 应当失败退出", failures)
    expect("镜像校验失败" in res.stderr, "[digest 不一致] 缺少明确报错", failures)
    expect("up -d" not in joined, "[digest 不一致] 不应重建容器", failures)
    expect("ghcr.io/example/feedback:v0.9.2" not in env_text, "[digest 不一致] 不应改写 .env.prod", failures)

    # 3) 清单标签与请求标签不一致 → 拉取前失败
    case = setup()
    tmp_dirs.append(case.workdir)
    mf = manifest(case.workdir, tag="v0.9.1")
    res = case.run("--deploy-dir", "deploy", "--to", "v0.9.2", "--manifest-url", mf.as_uri(), "--no-backup")
    expect(res.returncode != 0, "[标签不一致] 应当失败退出", failures)
    expect(not any(c.startswith("pull ") for c in case.calls()), "[标签不一致] 不应拉取镜像", failures)

    # 4) --no-verify 保持旧行为
    case = setup()
    tmp_dirs.append(case.workdir)
    res = case.run("--deploy-dir", "deploy", "--no-verify", "--to", "v0.9.2", "--no-backup")
    joined = "\n".join(case.calls())
    expect(res.returncode == 0, "[no-verify] 退出码 %s：%s" % (res.returncode, res.stderr[-200:]), failures)
    expect("pull" in joined, "[no-verify] 应执行 compose pull", failures)
    expect("image inspect" not in joined, "[no-verify] 不应做 digest 校验", failures)

    # 5) geo：校验通过 → 备份 + 原子替换 + 重启
    case = setup()
    tmp_dirs.append(case.workdir)
    geo_dir = case.workdir / "geo"
    geo_dir.mkdir()
    good = geosite("GFW", "CN", "ADVERTISERS")
    (geo_dir / "GeoSite.dat").write_bytes(b"old-content")
    (geo_dir / "new.dat").write_bytes(good)
    res = case.run("--geosite-only", "--geosite-path", str(geo_dir / "GeoSite.dat"),
                   "--geosite-url", (geo_dir / "new.dat").as_uri(), "--geosite-container", "mihomo")
    joined = "\n".join(case.calls())
    expect(res.returncode == 0, "[geo 成功] 退出码 %s：%s" % (res.returncode, res.stderr[-300:]), failures)
    expect((geo_dir / "GeoSite.dat").read_bytes() == good, "[geo 成功] 目标文件未被替换", failures)
    expect(bool(list(geo_dir.glob("GeoSite.dat.bak.*"))), "[geo 成功] 没有留下备份", failures)
    expect("restart mihomo" in joined, "[geo 成功] 未重启容器", failures)

    # 6) geo：截断文件 → 拒绝覆盖
    case = setup()
    tmp_dirs.append(case.workdir)
    geo_dir = case.workdir / "geo"
    geo_dir.mkdir()
    (geo_dir / "GeoSite.dat").write_bytes(b"old-content")
    (geo_dir / "bad.dat").write_bytes(geosite("GFW", "CN")[:-4])
    res = case.run("--geosite-only", "--geosite-path", str(geo_dir / "GeoSite.dat"),
                   "--geosite-url", (geo_dir / "bad.dat").as_uri())
    joined = "\n".join(case.calls())
    expect(res.returncode != 0, "[geo 截断] 应当失败退出", failures)
    expect("截断" in res.stderr or "校验未通过" in res.stderr,
           "[geo 截断] 报错未说明原因：%s" % res.stderr[-200:], failures)
    expect((geo_dir / "GeoSite.dat").read_bytes() == b"old-content", "[geo 截断] 不得改动目标文件", failures)
    expect("restart" not in joined, "[geo 截断] 不得重启容器", failures)

    # 7) geo：内容未变化 → 跳过覆盖与重启
    case = setup()
    tmp_dirs.append(case.workdir)
    geo_dir = case.workdir / "geo"
    geo_dir.mkdir()
    same = geosite("GFW", "CN")
    (geo_dir / "GeoSite.dat").write_bytes(same)
    (geo_dir / "new.dat").write_bytes(same)
    res = case.run("--geosite-only", "--geosite-path", str(geo_dir / "GeoSite.dat"),
                   "--geosite-url", (geo_dir / "new.dat").as_uri())
    joined = "\n".join(case.calls())
    expect(res.returncode == 0, "[geo 未变化] 退出码 %s：%s" % (res.returncode, res.stderr[-200:]), failures)
    expect("restart" not in joined, "[geo 未变化] 不应重启容器", failures)
    expect("未变化" in res.stdout, "[geo 未变化] 未说明跳过原因", failures)

    # 8) geo：缺少必需分类 → 拒绝
    case = setup()
    tmp_dirs.append(case.workdir)
    geo_dir = case.workdir / "geo"
    geo_dir.mkdir()
    (geo_dir / "GeoSite.dat").write_bytes(b"old-content")
    (geo_dir / "cn-only.dat").write_bytes(geosite("CN", "PRIVATE"))
    res = case.run("--geosite-only", "--geosite-path", str(geo_dir / "GeoSite.dat"),
                   "--geosite-url", (geo_dir / "cn-only.dat").as_uri(), "--geosite-require", "gfw")
    expect(res.returncode != 0, "[geo 缺分类] 应当失败退出", failures)
    expect("gfw" in res.stderr.lower(), "[geo 缺分类] 报错应指出缺失分类", failures)

    for path in tmp_dirs:
        shutil.rmtree(path, ignore_errors=True)

    if failures:
        print("FAIL:")
        for item in failures:
            print("  -", item)
        return 1
    print("update.sh 安全更新回归：8 组场景全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
