# deploy/ — 生产部署资产

| 文件 | 作用 |
| --- | --- |
| `compose.prod.yml` | 生产 compose：`feedback` + `updater` 两个服务，数据卷为 external，控制目录只读挂载 |
| `.env.prod.example` | 生产环境变量模板（复制为 `.env.prod` 后填写；`.env.prod` 已被 `.gitignore` 排除） |
| `install-updater.sh` | 首次把 updater 接进**已有**部署：核对现状 → 备份 → 生成 600 令牌 → 登记既有数据卷 → 写入受管 compose |
| `nginx/feedback.conf.template` | Nginx TLS 终止模板（公网入口） |
| `../docs/deployment.md` | 运维主文档：环境变量、updater 架构与安全边界、令牌轮换、升级/回退限制 |

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
