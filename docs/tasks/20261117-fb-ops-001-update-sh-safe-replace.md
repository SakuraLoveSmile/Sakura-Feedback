# update.sh：镜像与 geo 文件的「先下载 → 校验 → 再覆盖」

- 项目 personal-feedback；任务 FB-OPS-001；状态：待体验。
- 目标：把 2026-11-17 生产事故里手工执行的两种安全更新流程固化进 `deploy/update.sh`——镜像按 digest 暂存校验后再切换、geo 文件下载校验后再原子覆盖；对应 0.9.1→0.9.2 升级时 docker 代理不可用、以及 mihomo 因 `GeoSite.dat` 截断崩溃重启两件事。
- 授权：用户 2026-11-17 明确「把先下载后校验再覆盖写进 update.sh」，并在追问中确认「镜像与 geo 文件两者都要」。
- 工作区：主工作区 `/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`；分支 `main`。

## 改动

- `deploy/update.sh`：
  - 镜像：新增 `--digest` / `--manifest-url` / `--no-verify`。默认从 GitHub Release 的 `release-manifest.json` 解析目标 `tag` 与 `digest`（校验 `manifestVersion=1`、`channel=stable`、digest 格式、tag 与请求一致），随后 `docker pull repo@sha256:…`（不改动现有标签）→ `docker image inspect` 的 `Id` 必须等于清单 digest → 才 `docker tag` 写标签、备份 `.env.prod` 并切到 `<tag>@<digest>`。任一步不一致即退出，容器与 `.env.prod` 不动。
  - geo 文件：新增 `--geosite` / `--geosite-only` / `--geosite-url` / `--geosite-path` / `--geosite-container` / `--geosite-require`。下载到目标目录内的临时文件（同目录 rename 为原子替换）→ `Content-Length` 对照 → protobuf 线格式逐条解析（末条长度越界判截断）→ 必需分类（默认 `gfw`）存在 → 备份现有文件（保留 3 份）→ 原子覆盖 → 重启容器并复查 `running` 与 `level=fatal`；失败自动回滚备份。内容未变化时跳过覆盖与重启。
  - 其它：临时文件用 EXIT trap 清理；中文紧邻变量统一写成 `${VAR}` 形式，避免非 UTF-8 locale 下变量名被吞。
- `e2e/check-update-sh.py`：8 组回归（语法、镜像成功、digest 不一致、清单标签不一致、`--no-verify`、geo 成功、geo 截断、geo 未变化、geo 缺分类），用 PATH 里的假 `docker` 隔离，不联网、不碰真实容器；已接入 `ci.yml` 的 node-checks。
- `deploy/README.md`、`docs/deployment.md`：补新的参数与行为说明。

## 验证

- `bash -n deploy/update.sh` 通过；`python3 e2e/check-update-sh.py` 8/8 通过。
- 生产 `blog-prod` 真机（只读/无副作用路径）：
  - `--geosite-only --geosite-url file://<当前文件>`：下载 4,358,194 字节、校验出 1567 个分类含 `gfw`、sha256 未变化 → 跳过覆盖与重启，退出 0，mihomo 保持 Up。
  - `--geosite-url file:///etc/hostname`：线格式校验失败退出 1，原文件 sha 不变，容器未重启。
  - `--geosite-url file://<截断到 3,036,992 字节的副本>`：报「文件被截断：偏移 2282562 处声明 1944127 字节，只剩 754430 字节」并退出 1，原文件与容器均未动。
- 未在生产执行镜像路径的端到端：该机是手工维护的 compose（镜像直接钉在 `docker-compose.yml`，没有 `.env.prod`），`update.sh` 的服务更新分支不适用；镜像路径只在回归用例里验证。

## 剩余 / 边界

- 生产部署仍是「compose 直接钉镜像 + `.env`」形态，与本脚本假设的 `.env.prod + compose.simple.yml` 不同；要让它接管该机，需要先把部署迁回简易模式（另开任务，未做）。
- `--geosite` 的默认路径/容器名按当前生产写死（`/opt/1panel/docker/compose/clash/mihomo/GeoSite.dat`、`mihomo`），别的机器用参数覆盖。
- geo 下载地址默认官方 GitHub；国内建议显式传镜像地址（第三方代理属于信任决定，不写进默认值）。
- 本次不改版本号、不发 Release；相关行为随下次发版进入 CHANGELOG。
