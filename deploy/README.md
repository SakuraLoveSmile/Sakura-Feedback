# deploy/ — 生产部署资产

| 文件 | 作用 |
| --- | --- |
| `compose.simple.yml` | **简易模式** compose：单服务、可变镜像标签、compose 自管理数据卷 |
| `bootstrap.sh` | 简易模式首次部署：核对环境 → 生成本地密钥与 `.env.prod`（600）→ 落 `compose.yml` → 拉镜像启动 |
| `update.sh` | 简易模式更新：数据卷 tar 备份 → `compose pull` → 重建 → 等待健康 |
| `compose.prod.yml` | 完整模式 compose：`feedback` + `updater` 两个服务，数据卷为 external，控制目录只读挂载 |
| `.env.prod.example` | 完整模式环境变量模板（复制为 `.env.prod` 后填写；`.env.prod` 已被 `.gitignore` 排除） |
| `install-updater.sh` | 完整模式接入：核对现状 → 备份 → 生成 600 令牌 → 登记既有数据卷 → 写入受管 compose |
| `nginx/feedback.conf.template` | Nginx TLS 终止模板（公网入口） |
| `../docs/deployment.md` | 运维主文档：环境变量、updater 架构与安全边界、令牌轮换、升级/回退限制 |

## 两种部署形态

| | 简易模式（`compose.simple.yml`） | 完整模式（`compose.prod.yml`） |
| --- | --- | --- |
| 服务数 | 1（只有 feedback） | 2（feedback + updater 执行器） |
| 镜像引用 | 可变标签（`latest` / `vX.Y.Z`） | digest 固定（`@sha256:…`） |
| 首次部署 | `bash deploy/bootstrap.sh`（交互式，一条命令） | 填 `.env.prod` + `install-updater.sh` |
| 每次更新 | `bash deploy/update.sh`（自动打卷备份）或 `compose pull && up -d` | 后台「系统更新」点一下（暂停写入 + 卷副本备份 + 逐阶段证据） |
| 数据卷 | compose 自管理的普通卷 | external 卷 + 每轮更新留一份完整副本 |
| 回退 | 改回旧版本标签 + `up -d`；跨 schema 版本需先恢复备份包 | 改回旧 digest + `up -d`（旧卷副本仍在） |
| 适合 | 个人小实例、图省事 | 在意可复现与更新审计 |

简易模式刻意放弃了：digest 精确复现、更新期间暂停业务写入、自动卷副本与操作证据。
数据库迁移是**单向**的——跨 schema 版本回退（如 0.4.0 → 0.3.0）必须先恢复 `update.sh` 留下的备份包。

## 简易模式：首次部署

```bash
# 在仓库根目录（git clone/pull 或从 Release 解压均可）
bash deploy/bootstrap.sh                          # 交互式：问域名，生成主密钥与管理员密码
bash deploy/bootstrap.sh --deploy-dir /opt/feedback --public-url https://fb.example.com
bash deploy/bootstrap.sh --dry-run                # 只展示将做的事
```

脚本做的事：核对 docker/compose → 生成主密钥（openssl/node）→ 写 `<deploy-dir>/.env.prod`（600）
→ 拷贝 `compose.simple.yml` 为 `<deploy-dir>/docker-compose.yml` → `compose pull` → `up -d` → 等健康检查。
私有 GHCR 拉不动时先 `docker login ghcr.io`（PAT 仅需 `read:packages`）。

## 简易模式：更新与回退

```bash
bash deploy/update.sh                    # 备份数据卷 → pull → 重建 → 等健康（默认部署目录）
bash deploy/update.sh --deploy-dir /opt/feedback
bash deploy/update.sh --to v0.3.0        # 切到指定版本标签（回退；跨 schema 版本先恢复备份）
```

备份落在 `<deploy-dir>/backups/feedback-data-<时间戳>.tgz`（保留最近 10 份）。
恢复备份：`docker run --rm -v <卷名>:/data -v <备份目录>:/backup <镜像> sh -c 'tar xzf /backup/<包>.tgz -C /data'`。

### 从完整模式迁到简易模式

已有的 updater 部署可以就地切换，数据卷直接接管：

```bash
cd <部署目录>                                                 # 即放着旧 compose 与 .env.prod 的目录
docker compose --env-file .env.prod down                      # 停服务；数据卷与 .env.prod 都保留
cp compose.yml compose.yml.bak.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true   # 备份旧 compose（若叫这名）
cp <仓库>/deploy/compose.simple.yml docker-compose.yml        # 换成单服务 compose（1Panel 惯例文件名）
rm -f compose.yml compose.yaml docker-compose.yaml            # 删掉旧 compose 文件，避免多文件歧义
docker compose --env-file .env.prod -f docker-compose.yml up -d
```

前提与说明：

- `.env.prod` 里确认有 `FEEDBACK_DATA_VOLUME=<现有卷名>`（完整模式部署本来就有这项，
  `docker volume ls` 可核对）；简易 compose 用它复用原卷，**不会新建空卷**。
- `FEEDBACK_MASTER_KEY` 必须保持原值——换了它，已存的 Kaneo/AI 密钥将无法解密。
- 残留的 `FEEDBACK_UPDATER_*` / `UPDATER_*` 变量可以删掉；留着也不影响运行，
  只是后台「系统更新」页会连不上执行器（正常——简易模式的更新入口是 `update.sh`）。
- `update.sh` 自动探测 `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`
  （按此顺序取第一个），并自动对准 `FEEDBACK_DATA_VOLUME` 指定的卷。
- 注意：**完整模式**（`install-updater.sh` + updater）仍要求文件名叫 `compose.yml`
  （`UPDATER_COMPOSE_FILE` 契约），两种模式的文件名约定不同。

---

以下为**完整模式**（updater）的部署形态与接入步骤。

目标部署形态（冻结契约）：

```
/opt/1panel/docker/compose/feedback/          # 部署目录：宿主与容器内同一绝对路径
├── compose.yml                               # 受管 compose（由 install-updater.sh 写入，含 updater 服务）
├── .env.prod                                 # 600：主密钥、公网地址、镜像 digest、数据卷名、updater 变量
├── update-control/                           # 700：更新控制目录（feedback 以 :ro 挂载）
│   ├── updater-token                         # 600：updater 校验 x-updater-token
│   ├── feedback-token                        # 600：feedback 读取并发送（与上面同值）
│   ├── paused                                # 存在即表示「更新进行中，业务写入必须拒绝」
│   ├── release                               # 放行标记（已放行的版本/镜像/数据卷）
│   └── state/                                # 任务状态与 600 备份副本
└── .install-backups/<时间戳>/                 # install-updater.sh 的 600 备份（compose + env + manifest）
```

## 首次接入 updater（从既有 v0.2.x 部署升级）

前置：服务正在用现有 compose 运行（`docker compose ps` 能看到 `feedback`），并且已经能从 GHCR 拉取新镜像。

```bash
# 1) 取这一版的部署文件（git clone/pull 或从 Release 附件解压），进入仓库根目录
cp deploy/.env.prod.example deploy/.env.prod
#    填：FEEDBACK_MASTER_KEY、FEEDBACK_PUBLIC_URL、FEEDBACK_IMAGE、UPDATER_IMAGE、UPDATER_IMAGE_NAME

# 2) 先看一眼脚本会做什么（不写任何文件）
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback --dry-run

# 3) 正式接入
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback

# 4) 让新 compose 生效（此时才会重建服务，数据卷原地不变）
cd /opt/1panel/docker/compose/feedback
docker compose --env-file .env.prod up -d
docker compose --env-file .env.prod ps
```

脚本在**任何写入之前**依次核对，任一不符即带原因中止（非零退出，不改任何文件）：

1. `docker` / `docker compose` 可用；部署目录、compose 文件（必须叫 `compose.yml`）、`.env.prod` 存在。
2. 现有 compose 能通过 `docker compose config -q`；服务集合只含 `feedback`（重跑时允许已含受管 `updater`）。
3. 项目名与服务名对应的容器存在且**正在运行**，容器标签里的项目/服务与 `--project` / `--service` 一致。
4. 容器内数据目录必须是 `/data`（本模板固定），且该位置挂的是**命名卷**（不是绑定目录/匿名卷）；卷必须真实存在。
5. 环境文件里的 `FEEDBACK_DATA_VOLUME` 若已存在，必须与容器实际挂载的卷一致（拒绝替你改数据卷）。
6. 端口绑定必须只绑回环；`FEEDBACK_BIND` 若已存在必须与实际绑定一致（拒绝静默改动端口暴露）。
7. 运行中容器记录的 compose 文件路径与 `--compose-file` 一致（避免改错文件）。

通过后：备份 → 生成/复用令牌（600）→ 登记 `FEEDBACK_DATA_VOLUME` / `FEEDBACK_BIND` / `UPDATER_DEPLOY_DIR` /
`FEEDBACK_UPDATE_CONTROL_DIR` / `FEEDBACK_UPDATE_TOKEN_FILE` / `FEEDBACK_UPDATER_URL` / `UPDATER_IMAGE_NAME` →
用**候选文件**先跑一次 `docker compose config -q` → 原子写入 compose 与 `.env.prod`。

### 选项

| 选项 | 说明 |
| --- | --- |
| `--deploy-dir <路径>` | 部署目录（默认 `/opt/1panel/docker/compose/feedback`） |
| `--compose-file` / `--env-file` / `--project` / `--service` | 覆盖默认的 `compose.yml` / `.env.prod` / `feedback` / `feedback` |
| `--template <路径>` | 受管 compose 模板（默认脚本同目录的 `compose.prod.yml`） |
| `--updater-image <引用>` | `.env.prod` 里没有 `UPDATER_IMAGE` 时用它写入 |
| `--backup-root <路径>` | 备份根目录（默认 `<deploy-dir>/.install-backups`） |
| `--dry-run` | 只核对并展示将要做的改动，不写文件 |
| `--rotate-token` | 重新生成两个 600 令牌文件 |
| `--self-test` | 独立临时目录 + 独立 compose 项目自测（见下） |

### 幂等

重复执行不会重复生成令牌、不会重复插入服务定义：令牌已存在即复用并强制 600；compose 与环境文件按内容比对，
一致就输出「无改动」并跳过写入，也不会产生多余备份（备份只在确实要写之前生成）。

### 令牌生成与轮换

- 令牌是 32 字节随机数的十六进制串（64 字符），由脚本写入 `update-control/updater-token` 与 `feedback-token`（都 600，同值）。
- feedback 从 `FEEDBACK_UPDATE_TOKEN_FILE` 读取并放在 `x-updater-token` 请求头里；updater 校验自己那份。
- 令牌不写进镜像、不进 compose 文件、不回浏览器、不写日志；`.env.prod` 与令牌文件都不入库。
- 轮换：`bash deploy/install-updater.sh --rotate-token`，然后
  `docker compose --env-file .env.prod up -d --force-recreate feedback updater`
  （两侧都在启动时读令牌；轮换前先确认没有进行中的更新）。

## 本地验证（不需要真实服务器）

```bash
# 1) 语法
bash -n deploy/install-updater.sh

# 2) compose 配置（先用模板生成一份本地测试值；deploy/.env.prod 已被 .gitignore 排除）
cp deploy/.env.prod.example deploy/.env.prod   # 填任意合法值：两个镜像 digest、FEEDBACK_DATA_VOLUME 等
docker compose -f deploy/compose.prod.yml --env-file deploy/.env.prod config -q
docker compose -f deploy/compose.prod.yml --env-file deploy/.env.prod config --services   # feedback / updater

# 3) 脚本行为的真实自测：独立临时目录 + 独立 compose 项目/卷/端口，跑完自动清理
bash deploy/install-updater.sh --self-test
```

`--self-test` 会真起两个 `feedback-selftest-*` compose 项目（含命名卷），依次验证：首次接入、
幂等重跑（令牌/文件哈希不变、备份不增长）、三类拒绝路径（项目名不符 / 数据卷登记冲突 / 数据目录非 `/data`）、
以及 `--dry-run` 不写文件；结束时 `down -v` + 删卷删网络删临时目录。它不会触碰 `/opt/1panel/...` 或任何既有部署。

渲染后的配置应当满足（可用 `docker compose config` 自查）：

- `updater` 服务**没有** `ports`；只经 compose 网络以 `http://updater:8790` 访问。
- `updater` 以**同一绝对路径**挂载部署目录，并挂 `/var/run/docker.sock`；`feedback` 不挂 socket。
- `feedback` 以 `:ro` 挂载 `update-control`；数据卷来自 `volumes.feedback-data`（`external: true` + `name: ${FEEDBACK_DATA_VOLUME}`）。
