# @feedback/updater — 独立更新执行器

U1（后台一键更新）里的执行器：一个只做一件事的独立服务与镜像——把**预配置 compose 项目里的 feedback 服务**
从当前版本更新到清单指定的新版本，并在每一步留下可核对的证据。

- 镜像：`ghcr.io/sakuralovesmile/sakura-feedback-updater`（本包版本固定 `0.1.0`，与反馈服务版本解耦）
- 监听：容器网络内 `http://updater:8790`，**不发布任何端口**（宿主不暴露，只有 feedback 服务经 compose 内网调用）
- 权限：挂载 `/var/run/docker.sock` 与部署目录——等价于宿主管理权限，**不是代码级隔离**（见「安全边界」）
- 不依赖 `apps/server` 的任何产物；镜像里只有执行器自己的编译产物与 docker CLI

## 环境变量（冻结契约）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPDATER_LISTEN` | `0.0.0.0:8790` | 监听地址，支持 `host:port` / `:port` / `port` |
| `UPDATER_COMPOSE_FILE` | `<deploy>/compose.yml` | 受管 compose 文件（绝对路径） |
| `UPDATER_COMPOSE_PROJECT` | `feedback` | 受管 compose 项目名 |
| `UPDATER_SERVICE` | `feedback` | 受管服务名（禁止设为 `updater`，否则拒绝启动） |
| `UPDATER_DEPLOY_DIR` | `/opt/1panel/docker/compose/feedback` | 部署目录，容器内外同绝对路径 |
| `UPDATER_CONTROL_DIR` | `<deploy>/update-control` | 控制目录（feedback 服务只读挂载） |
| `UPDATER_STATE_DIR` | `<control>/state` | 任务状态与备份根目录 |
| `UPDATER_TOKEN_FILE` | `<control>/updater-token` | 600 权限共享令牌文件 |
| `UPDATER_IMAGE_NAME` | 无（**必填**） | 受管镜像名（不含标签/digest），如 `ghcr.io/sakuralovesmile/sakura-feedback` |
| `UPDATER_PROTOCOL_VERSION` | `1` | 本执行器实现的协议版本 |

其它路径都是推导值，不接受调用方输入：部署环境文件 `<deploy>/.env.prod`、
本地清单候选 `<deploy>/release-manifest.json` 与 `<control>/release-manifest.json`、
清单缓存 `<state>/manifest-cache.json`、任务文件 `<state>/tasks/<operationId>.json`、备份 `<state>/backups/<operationId>/`。

## 控制目录（feedback 服务只读挂载同一目录）

```
update-control/
  updater-token      600 随机令牌：执行器校验 x-updater-token
  feedback-token     600 随机令牌：feedback 侧（存在即一并接受，避免两侧文件不一致）
  paused             存在即表示「更新进行中，业务写入必须拒绝」；内容为 JSON（供后台展示阶段）
  release            放行标记：记录已放行的版本、镜像引用与数据卷
  state/tasks/*.json 任务状态（每个阶段边界原子落盘）
  state/backups/     本轮配置与主密钥环境文件的 600 受限副本
```

`paused` / `release` 都是「临时文件 + rename」的原子写；`paused` 的解除就是 `unlink`。
feedback 服务侧读取 `paused` 与 `state/tasks/*.json` 即可实现暂停写入与进度展示。

## HTTP 协议（全部需要 `x-updater-token`，`/healthz` 除外）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/tasks` | 请求体只接受 `{requestId, version, digest}`；落盘后返回 `202 {operationId}` |
| `GET` | `/tasks/:id` | 返回任务记录（阶段、证据、失败原因、恢复指引） |
| `GET` | `/manifest?channel=stable` | 返回当前版本清单；不支持其它渠道（400） |
| `GET` | `/healthz` | `{ok, version, protocolVersion, busy}`，无需令牌（容器 healthcheck 用） |

- 客户端提交 `compose` 路径、命令、任意镜像或卷名等额外字段一律 `400 invalid_request`，执行器**不做任何推测性解析**。
- 鉴权失败（令牌缺失或错误）一律 `401`；令牌不进入响应体、日志或任何客户端可见位置。
- 幂等：同一 `requestId` 重发返回原任务的 `operationId`；已有任务运行中收到其它 `requestId` 返回 `409 conflict`。
- 清单缺失/非法/不可达、或 `requiredUpdaterProtocol` 高于本执行器时，`POST /tasks` 直接 `409` 并给出执行器升级指引。

## 版本清单来源

1. `<deploy>/release-manifest.json`（人工/离线安装与本地验证用，优先级最高）
2. 远端 GitHub Releases：由 `UPDATER_IMAGE_NAME` 推导（`ghcr.io/<owner>/<repo>` →
   `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json`）
3. 上次成功拉取的本地缓存（远端暂时不可用时兜底，并在任务里记 `warnings`）

非 `ghcr.io` 命名空间（例如本地构建标签）没有远端地址，只接受本地清单。

## 六阶段状态机

每个阶段**边界先落盘**（先把阶段写进任务文件，再执行该阶段工作），便于重启核对与人工排查。

1. **①预检并拉取**：读 `.env.prod`（必须已登记 `FEEDBACK_IMAGE` / `FEEDBACK_DATA_VOLUME`）→ 读清单并校验协议、
   版本与 digest → 记录运行中容器 → 采集更新前数据基线 → `docker pull` 并核对 digest → **旧镜像保留**
   → 空间检查（数据卷所在磁盘可用空间 ≥ 待复制数据大小的 **1.2 倍**，不足则保持旧服务运行并失败退出）
2. **②暂停并停服**：写 `paused` 标记 → `compose stop -t 30`（沿用 30s 优雅退出预算）→ 确认退出。
   仍在运行、OOM、或退出码不是 0/143 → **中止升级**，不做后续备份（不把不一致数据当作完整快照）
3. **③保留备份并复制**：把 compose 与 `.env.prod`（含主密钥）另存为 600 受限副本 → 创建独立新卷（已存在则拒绝）
   → `cp -a` 完整复制原卷（含 `-wal`/`-shm`）→ 校验条目集合与体积。原卷作为本轮完整备份**绝不覆盖**
4. **④启动验证**：原子替换 `.env.prod` 中 `FEEDBACK_IMAGE` 与 `FEEDBACK_DATA_VOLUME`（其它行逐字节保留，权限不变）
   → 只重建 feedback 服务（`--force-recreate --no-deps --pull never`，执行器自身不会被重建）
   → 新版在 `paused` 存在的情况下以暂停模式启动
5. **⑤核验新版**（限时 120 秒，未知结果不算成功）：实际镜像 digest、版本/提交标签、数据卷挂载、
   数据库完整性（`PRAGMA integrity_check`）、目标 schema 版本、账号/反馈/截图/额度行数不少于更新前、
   既有加密连接配置形态仍为 `v1`、容器健康状态
6. **⑥放行**：先持久记录放行意图（任务文件 + `release` 标记）→ 原子解除暂停（删除 `paused`）
   → 确认实际版本、运行状态与放行应答后才记录成功

## 失败语义（前台按 `outcome` 区分）

| outcome | 含义 | 保障 |
| --- | --- | --- |
| `failed_no_changes` | 预检/拉取/空间检查失败，**未改动部署** | 旧服务保持运行，旧镜像与旧卷未被触碰 |
| `failed_restored` | 验证阶段失败且确认尚未放行 | 还原 `.env.prod` → 用旧镜像 + 未修改的原卷重建 → 旧服务通过检查（含数据库探针）后才记为「更新失败，已恢复旧版本」 |
| `needs_attention` | 无法确凿判定，或**已开始放行后的任何失败** | 绝不自动恢复原卷；保留当前数据，附任务证据与恢复指引 |
| `succeeded` | 六阶段全部通过并完成放行 | `release` 标记与任务文件均已落盘 |

- 一旦进入放行阶段，**绝不自动回退数据卷**；后续失败保留当前数据并标记需要处理。
- 新卷永远保留作诊断，不自动删除；执行器不执行 `docker rm`/`rmi`/`prune`/卷删除（代码层拦截，非仅约定）。
- 可执行文件缺失、命令超时、非零退出全部映射为明确失败，不会静默继续。

## 重启核对

进程启动时（开始监听之前）读取已落盘任务、控制文件与 Docker 实际状态：

- 放行标记存在且运行中镜像 digest 与目标一致 → 判定更新已完成（`succeeded`）
- 环境文件已指向新镜像 → 记为 `needs_attention`（不盲目回退，避免把新数据静默覆盖回旧卷）
- 环境文件仍指向旧镜像 → 确认旧服务运行（必要时重建）后解除暂停，记为 `failed_restored`
- 无法判定 → `needs_attention`，绝不盲目重复更新或回退
- 没有进行中的任务时，只清理「引用终态且已知安全」的过期 `paused` 标记

## 安全边界

- 挂载 docker socket 等于宿主 root 权限；执行器只把 socket 用于**预配置项目/服务**的停止、重建、卷创建与复制，
  永远不接受来自客户端的路径、命令、镜像或卷名。
- 共享令牌来自 600 权限文件，权限过宽只告警（执行器不改动部署目录权限）。
- 令牌不会出现在响应、日志或任务文件里。

## 部署侧需要对齐的接口（给 U1-2 / U1-3 / U1-4）

1. `.env.prod` 必须含 `FEEDBACK_IMAGE`（含 digest 的完整引用）与 `FEEDBACK_DATA_VOLUME`（外部卷名）；
   执行器只改这两行，其它行逐字节保留。首次安装由 `deploy/install-updater.sh` 完成登记。
2. compose 文件里服务必须引用卷的 **key**，key 的真实名字由 `FEEDBACK_DATA_VOLUME` 决定：
   ```yaml
   services:
     feedback:
       image: ${FEEDBACK_IMAGE}
       volumes: [ "feedback-data:/data" ]   # 引用 key，不是变量
   volumes:
     feedback-data:
       external: true
       name: ${FEEDBACK_DATA_VOLUME}        # 执行器只改环境文件里的这个变量
   ```
   并且 `feedback` 服务把数据卷挂到 `FEEDBACK_DATA_DIR`（默认 `/data`）——执行器按挂载点识别数据卷。
3. compose 项目名 `feedback`、服务名 `feedback`、部署目录与控制目录在容器内外保持同一绝对路径。
4. updater 服务需接入 feedback 所在的 compose 网络（`docker compose up` 才能被同项目识别），
   并挂载同一部署目录（可读写）与 `/var/run/docker.sock`；不发布端口。
5. feedback 服务只读挂载控制目录，读取 `paused`（暂停写入）与 `state/tasks/*.json`（进度），
   令牌读自 `FEEDBACK_UPDATE_TOKEN_FILE`，请求头 `x-updater-token`。
6. 需要 `updater` 镜像的 digest 时，从 Release 清单的 `services.updater` 读取；执行器不自我更新。

## 本地真实验证

`e2e/run-local-update.sh` 用**真实 Docker**（独立 compose 项目/网络/卷/端口，绝不触碰生产资源）跑完整流程：
本地 registry 推入一个会被更新的 `feedback` 替身服务，执行器容器经真实 socket 完成
停服 → 复制卷 → 换镜像 → 核验 → 放行，最后断言新版本在跑、数据保留、旧卷与旧镜像仍在。

```bash
bash apps/updater/e2e/run-local-update.sh
```

单元测试（全部使用注入的假 docker，覆盖阶段顺序、失败恢复、重启核对、鉴权与协议校验）：

```bash
pnpm --filter @feedback/updater test
pnpm --filter @feedback/updater typecheck
pnpm --filter @feedback/updater lint
pnpm --filter @feedback/updater build
docker build -f apps/updater/Dockerfile -t sakura-feedback-updater:dev .
```
