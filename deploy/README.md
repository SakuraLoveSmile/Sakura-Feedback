# deploy/ — 生产部署资产

| 文件 | 作用 |
| --- | --- |
| `compose.simple.yml` | compose：单服务、可变镜像标签、命名卷或宿主目录存数据 |
| `bootstrap.sh` | 首次部署：核对环境 → 生成本地密钥与 `.env.prod`（600）→ 落 compose 文件 → 拉镜像启动 |
| `update.sh` | 更新：数据卷 tar 备份 → `compose pull` → 重建 → 等待健康 |
| `nginx/feedback.conf.template` | Nginx TLS 终止模板（公网入口） |
| `../docs/deployment.md` | 运维主文档：环境变量、升级/回退限制、备份恢复 |

> **v0.5.1 起**：完整模式（`compose.prod.yml` + `updater` 执行器 + `install-updater.sh`）已移除。
> 后台「系统更新」页现在只做**版本检查**（直连 GitHub Release 清单），不再提供一键安装；
> 更新一律走 `update.sh` 或手动 `compose pull && up -d`。已有的完整模式部署可按
> [从完整模式迁移](#从完整模式v05x迁移到简易模式) 一节就地切换，数据卷不受影响。

## 首次部署

```bash
# 在仓库根目录（git clone/pull 或从 Release 解压均可）
bash deploy/bootstrap.sh                          # 交互式：问域名，生成主密钥与管理员密码
bash deploy/bootstrap.sh --deploy-dir /opt/feedback --public-url https://fb.example.com
bash deploy/bootstrap.sh --dry-run                # 只展示将做的事
```

脚本做的事：核对 docker/compose → 生成主密钥（openssl/node）→ 写 `<deploy-dir>/.env.prod`（600）
→ 拷贝 `compose.simple.yml` 为 `<deploy-dir>/docker-compose.yml` → `compose pull` → `up -d` → 等健康检查。
私有 GHCR 拉不动时先 `docker login ghcr.io`（PAT 仅需 `read:packages`）。

公网入口用 `nginx/feedback.conf.template` 做 TLS 终止；compose 默认只把 `8787` 绑在
`127.0.0.1`，不直连公网。

## 数据存放：命名卷（默认）或宿主目录

数据可以放在 Docker 命名卷，也可以放在宿主目录（bind mount）——同一个
`compose.simple.yml` 两种形态都支持，区别只在 `.env.prod`：

| 形态 | `.env.prod` 设置 | 数据实际位置 |
| --- | --- | --- |
| 命名卷（默认） | `FEEDBACK_DATA_VOLUME=feedback-data`（或不设） | `docker volume inspect` 查得的卷内 |
| 宿主目录 | `FEEDBACK_DATA_PATH=/opt/feedback/data`（**必须绝对路径**） | 该目录本身，可直接 `ls`/`cp`/`tar` |

- 目录挂载适合想在宿主上直接看到 `feedback.db`、用 1Panel 文件管理或普通备份工具
  处理数据的部署；容器内文件属主为 root，属正常现象。
- `FEEDBACK_DATA_PATH`（宿主目录）与 `FEEDBACK_DATA_DIR`（容器内 `/data`，服务端变量）
  是两个不同变量，别混；也不要与 `FEEDBACK_DATA_VOLUME` 同时设置（`FEEDBACK_DATA_PATH` 优先）。
- `update.sh` 的备份对两种形态通用（`docker run -v` 对卷名与绝对路径一视同仁）。
- 从既有**命名卷**迁到**目录**：先停服，再把卷内容拷进目录后切换变量——
  ```bash
  cd <部署目录> && mkdir -p data
  docker run --rm -v <旧卷名>:/src:ro -v "$PWD/data:/dst" \
    alpine sh -c 'cp -a /src/. /dst/'
  # .env.prod：删 FEEDBACK_DATA_VOLUME，加 FEEDBACK_DATA_PATH=<部署目录绝对路径>/data
  docker compose --env-file .env.prod up -d
  # 后台确认数据完整后，旧卷保留几天再 docker volume rm <旧卷名>
  ```

## 更新与回退

```bash
bash deploy/update.sh                    # 备份数据卷 → pull → 重建 → 等健康（默认部署目录）
bash deploy/update.sh --deploy-dir /opt/feedback
bash deploy/update.sh --to v0.5.0        # 切到指定版本标签（回退；跨 schema 版本先恢复备份）
```

- `update.sh` 自动探测 `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`
  （按此顺序取第一个），并自动对准 `FEEDBACK_DATA_PATH`（目录）或 `FEEDBACK_DATA_VOLUME`（卷）。
- 备份落在 `<deploy-dir>/backups/feedback-data-<时间戳>.tgz`（保留最近 10 份）。
- 恢复备份：`docker run --rm -v <卷名或目录绝对路径>:/data -v <备份目录>:/backup <镜像> sh -c 'tar xzf /backup/<包>.tgz -C /data'`。
- 数据库迁移是**单向**的——跨 schema 版本回退必须先恢复 `update.sh` 留下的备份包。

## 版本检查（后台「系统更新」页）

登录后台 →「系统更新」：显示当前版本与最新稳定版（版本号、发布说明、镜像 digest、Release 页面链接）。
服务端直接拉取 GitHub Release 的 `release-manifest.json`，默认每 24 小时自动检查一次，也可手动点「检查更新」。
该页**只检查不安装**——确认有新版本后请用上面的 `update.sh` 更新。

相关环境变量（写到 `.env.prod` 生效）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEEDBACK_UPDATE_MANIFEST_URL` | 稳定渠道清单地址 | `off` 显式关闭检查功能；自建发布渠道可改为自定义清单地址 |
| `FEEDBACK_UPDATE_CHECK_INTERVAL_MS` | `86400000`（24h） | 自动检查间隔；`0` = 只允许手动检查 |

## 从完整模式（v0.5.x）迁移到简易模式

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
  想改用宿主目录挂载，先按「数据存放」一节把卷内容拷进目录，再换成 `FEEDBACK_DATA_PATH`。
- 同时把 `FEEDBACK_IMAGE` 从旧的 digest 固定引用改为可变标签（如
  `ghcr.io/sakuralovesmile/sakura-feedback:v0.5.1` 或 `latest`），
  否则 `up -d` 起的仍是旧版本。
- `FEEDBACK_MASTER_KEY` 必须保持原值——换了它，已存的 Kaneo/AI 密钥将无法解密。
- 残留的 `FEEDBACK_UPDATER_*` / `UPDATER_*` / `FEEDBACK_UPDATE_*` 变量可以直接删掉
  （v0.5.1 起服务端不再读取它们）；`update-control/` 目录与令牌文件也可以删。
- 迁移后后台「系统更新」页照常做版本检查，更新走 `update.sh`。
