# 部署与运维

单实例运行；无 Redis、无外部数据库。所有状态在 `FEEDBACK_DATA_DIR`（SQLite WAL 文件 + 无其他内容）。

## 1. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEEDBACK_MASTER_KEY` | 是 | 主密钥。推荐 base64 的 32 字节随机值：`node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`。非 base64-32B 值将按口令 scrypt 派生。**丢失则已存密钥（AI/Kaneo）无法解密**，请备份。 |
| `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD` | 首次部署 | 初始账号，仅当库中无用户时生效；不开放注册。**改用户名/密码**：登录后台 →「管理员设置」标签，在那里修改自己的用户名与密码（v0.3.0 起支持）。保存成功后该管理员**全部会话（含当前）立即失效**，需要用新凭据重新登录；账号 id、角色、每日额度与历史反馈归属都不变，**无需重建数据库**。 |
| `FEEDBACK_PORT` | 否 | 默认 8787 |
| `FEEDBACK_DATA_DIR` | 否 | 默认 `./data`；容器内 `/data` |
| `FEEDBACK_COOKIE_SECURE` | 否 | HTTPS 部署设为 `true`（默认 false，本地 http 可用） |
| `FEEDBACK_ADMIN_DIST` | 否 | 管理页构建目录；镜像内已指向 `/app/admin` |
| `FEEDBACK_UPDATER_URL` | U1 起 | updater 的内网地址，默认 `http://updater:8790`；只在 compose 网络内可访问（updater 不发布端口） |
| `FEEDBACK_UPDATE_CONTROL_DIR` | U1 起 | 更新控制目录（`:ro` 挂载）：读 `paused` 判断是否暂停写入、读 `state/tasks/*.json` 展示进度 |
| `FEEDBACK_UPDATE_TOKEN_FILE` | U1 起 | 600 权限共享令牌文件；以请求头 `x-updater-token` 调用 updater。令牌不进日志/响应/前端 |
| `FEEDBACK_SESSION_TTL_MS` 等 | 否 | 会话有效期微调（cookie 14 天 / 客户端令牌 90 天 / 握手令牌 15 分钟） |

上面是**服务端**读取的变量。生产部署还有一组供 compose 变量替换使用的部署变量（`FEEDBACK_IMAGE`、`FEEDBACK_PUBLIC_URL`、
`FEEDBACK_DATA_VOLUME`、`FEEDBACK_BIND`、`UPDATER_IMAGE`、`UPDATER_IMAGE_NAME`、`UPDATER_DEPLOY_DIR` 等），
首选用 `deploy/.env.prod.example` 生成 `deploy/.env.prod` 并按注释填写；各项含义见该模板与 [`../deploy/README.md`](../deploy/README.md)。

## 2. Docker

本地开发（仓库根 `compose.yml`：单服务、绑定挂载 `./data`）：

```bash
docker build -t feedback-service .
docker compose up -d       # 读取 .env（主密钥与初始账号），卷 ./data:/data
```

生产（`deploy/compose.prod.yml`：两个服务、固定 digest 镜像、external 数据卷）：

```bash
cp deploy/.env.prod.example deploy/.env.prod     # 填主密钥 / 域名 / 两个镜像 digest / 既有数据卷名
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback   # 首次接入 updater（先 --dry-run 看一眼）
cd /opt/1panel/docker/compose/feedback && docker compose --env-file .env.prod up -d
```

- 端口只绑回环（`FEEDBACK_BIND`，默认 `127.0.0.1:8787`），公网入口一律走 Nginx TLS 终止。
- `feedback` 只读挂载更新控制目录、**不挂 docker socket**；`updater` 挂 socket 与部署目录、**不发布任何端口**。
- 数据卷声明为 `external`（`name: ${FEEDBACK_DATA_VOLUME}`）：compose 既不创建也不删除它，这是「升级不换数据」的前提。
- 配置自查：`docker compose -f deploy/compose.prod.yml --env-file deploy/.env.prod config -q`（以及 `config --services` 应为 `feedback` + `updater`）。
- 全新机器的接入步骤、脚本选项与本地自测见 [`../deploy/README.md`](../deploy/README.md)。

备份/迁移：**先停旧 worker**，随后整目录拷贝 `data/` 即可。停机方式与前置条件：

- 用 `docker stop <容器>`（`deploy/compose.prod.yml` 已设 `stop_grace_period: 30s`）或向进程发 `SIGTERM`。
  服务收到信号后停止接受新请求 → 等处理队列排空 → `PRAGMA wal_checkpoint(TRUNCATE)` → 关闭 SQLite。
  停机完成后 `data/` 只应剩 `feedback.db`（无 `-wal` / `-shm`），此时整目录拷贝是一致快照。
- **必须留足优雅退出时间**：`docker stop` 默认只给 10s 就会 `SIGKILL`，早于应用自身的 20s 排空预算，
  会把 WAL 留在盘上（数据不丢，但单文件 `feedback.db` 快照会缺最近写入）。要么用 `docker stop --time 30`，
  要么依赖 compose 里的 `stop_grace_period`。
- WAL 模式下趁运行只拷 `feedback.db` 单文件会得到不一致快照；如必须在线备份，用
  `sqlite3 data/feedback.db ".backup '<目标>'"` 或等价 WAL 安全备份（连 `-wal` / `-shm` 一起拷也可）。
- 停服后 `data/` 仍有 `-wal` 残留，说明没有走优雅退出（如被 `SIGKILL`）。此时**不要只拷 `feedback.db`**：
  连 `feedback.db-wal` 一起拷贝，或先按上面的停机步骤重来一次。

一致性验证：`e2e/run_backup_restore.py` 会自动断言「停机后 `data/` 无 WAL/SHM 残留」，并验证同主密钥恢复、
不同主密钥无法解密、以及隔离恢复不向 Kaneo 重放。

验证持久化：`docker compose restart` 后未处理反馈自动恢复队列（详见下）。

### 2.1 updater 与安全边界

U1 起，生产部署里多了一个独立服务 `updater`：后台「系统更新」标签里点更新时，真正干活的是它。

```
浏览器 ──管理页「系统更新」──▶ feedback ──内网 http://updater:8790 ──▶ updater
                                 │        （请求头 x-updater-token）        │
                                 └──只读控制目录 paused / release / state ◀──┤
                                                                             │
                                              /var/run/docker.sock（宿主管理权限）
                                                                             ▼
                     宿主 docker：pull 新镜像 → 停服 → 复制数据卷 → 改 .env.prod → 重建 feedback → 核验 → 放行
```

- **updater 不发布端口**，只在同一张 compose 网络里监听 `8790`；除 `feedback` 外没有入口。
- **updater 只能更新一个服务**：compose 文件、项目名、服务名、受管镜像名全部来自它自己的环境变量（`UPDATER_*`），
  客户端只能提交 `requestId` / `version` / `digest` 三个字段；提交 compose 路径、命令、镜像名或卷名一律 `400`。
- **docker socket 等于宿主管理权限**：挂载 `/var/run/docker.sock` 的容器可以控制宿主上的所有容器、镜像与卷，
  这不是代码级隔离，只能靠「只接受预配置目标 + 令牌鉴权 + 审计日志」约束。请把服务器访问权与这个 socket 同等对待。
- **updater 不更新自己**：它只停/重建 `feedback`（`--no-deps`），协议不兼容时拒绝更新并提示人工升级 updater 容器。
- 令牌、控制文件、任务状态都在部署目录里（见下），不写进镜像、不进 compose 文件、不进版本库。

### 2.2 首次接入 updater（仍是服务器上的手工操作）

`updater` 的引入会改变 compose 文件形态（多一个服务、数据卷改成 external、feedback 多一个只读挂载），
所以**第一次**必须在服务器上执行一次 `deploy/install-updater.sh`；之后的版本升级都可以从后台点。

脚本在任何写入之前先核对：compose 文件（必须叫 `compose.yml`）、compose 项目名、正在运行的服务容器、
容器内 `/data` 是否挂的是命名卷、环境文件里登记的数据卷/端口是否与容器实际一致；任一不符即中止且不改文件。
通过后：备份现有 compose 与 `.env.prod`（带时间戳、600、含 sha256 台账）→ 生成 600 随机令牌 →
把**既有数据卷**原地登记为 `FEEDBACK_DATA_VOLUME`（绝不新建卷替换数据）→ 用候选文件先跑一次 `config -q` → 原子写入。

常用命令：

```bash
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback --dry-run   # 只核对与展示
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback             # 正式接入
bash deploy/install-updater.sh --self-test                                                  # 本地在独立临时目录+独立项目里自测
```

脚本幂等：重复执行不会重复生成令牌、不会重复插入服务定义，文件一致时只输出「无改动」。完整选项与本地验证步骤见
[`../deploy/README.md`](../deploy/README.md)。

### 2.3 升级流程与令牌轮换

**首次升级**（引入 updater）：停旧 worker → 备份一致 SQLite（上述停机后整目录拷贝）→ 按 2.2 接入 →
`docker compose up -d` 让两个服务生效 → 管理页抽查一条 `needs_review` 确认恢复动作就绪。

**之后每次升级**：登录后台 →「系统更新」→（检查最新稳定版）→ 点更新。服务端会先把写入切到**暂停**状态，
然后由 updater 依次执行：预检并拉取新镜像（校验协议/版本/digest、检查磁盘剩余空间 ≥ 待复制数据的 1.2 倍）→
写暂停标记并优雅停服（30s 预算）→ 把现有数据卷**完整复制**到独立新卷（原卷作为本轮完整备份保留）→
原子改写 `.env.prod` 里的 `FEEDBACK_IMAGE` 与 `FEEDBACK_DATA_VOLUME` → 只重建 `feedback` →
核验新版（实际 digest、版本/提交、数据库完整性、目标 schema、账号/反馈/截图/额度行数、既有加密配置可读，限时 120s）→
放行（记录放行标记后原子解除暂停）。

- 暂停期间：业务写入被拒绝、后台不再触发归档，**管理页仍可查看进度**；解除暂停后写入与队列自动恢复，
  暂停状态来自只读挂载的控制目录（`paused`），服务重启也不会丢。
- 任务进度与结果：控制目录 `state/tasks/<operationId>.json`；终态分「更新失败，已恢复旧版本」与需要人工处理的
  「需要处理」两类，后者会附任务证据与恢复指引。
- 更新期间可以放心刷新/关闭后台页面：任务在服务端继续跑，重连后从持久结果恢复显示。

**令牌轮换**（怀疑泄露或例行更换）：令牌是 `update-control/updater-token` 与 `feedback-token`（600，同值），
feedback 读它并以 `x-updater-token` 调用 updater。两侧都在**启动时**读取令牌文件，所以：

```bash
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback --rotate-token
cd /opt/1panel/docker/compose/feedback
docker compose --env-file .env.prod up -d --force-recreate feedback updater   # 轮换前先确认没有进行中的更新
```

快捷自检（不打印令牌）：`docker compose --env-file .env.prod exec feedback wget -qO- http://updater:8790/healthz`。

### 2.4 升级与回退限制（重要）

1. **数据卷行为**：一次成功升级会生成一个新卷 `feedback-data-<版本>-<时间戳>`，并把 `FEEDBACK_DATA_VOLUME` 指向它；
   被替换下来的原卷**不会被删除**（执行器只创建与复制卷，永不执行 `prune` / `rmi` / 卷删除）。
   因此升级前请确认磁盘剩余空间 ≥ 现有数据量（执行器要求 ≥ 1.2 倍，不足会拒绝更新并保持旧服务运行）。
2. **后台更新失败时**：验证阶段失败且确认尚未放行 → 自动切回旧镜像与未修改的原卷，标记「更新失败，已恢复旧版本」；
   一旦进入放行阶段则**绝不自动回退数据卷**，后续失败会保留当前数据并标为「需要处理」，附任务证据与恢复指引。
   新卷始终保留作诊断，需要人工确认后再决定删除。
3. **人工回退到旧版本**：停服 → 把 `.env.prod` 的 `FEEDBACK_IMAGE` 与 `FEEDBACK_DATA_VOLUME` 改回升级前的值
   （升级前的值可从 `.install-backups/` 与任务记录里查到）→ `docker compose --env-file .env.prod up -d`。
   回退前请先确认新卷上没有需要保留的新数据，并阅读下一条。
4. **新格式恢复数据**（`archive_data_json` v1：revision/target/upload/asset/comment/replacedKeys）随正文一起落库，备份即包含；`upload.credentialsEnc` 用主密钥 AES-256-GCM 加密，恢复主密钥备份才能解密预签名地址。
5. **Kaneo 远端写入限制**：新版本一经对 Kaneo 产生远端写入（创建任务 / 上传资产 / 登记 / 评论），**不允许简单恢复旧数据库并重放**——旧库没有新恢复记录（task ID、key、outcome、replacedKeys），重放会再次创建任务与资产，造成重复。需要回退时：停服 → 备份当前库 → 用新库的归档状态人工核对 Kaneo 侧既有资产/评论，再决定是否恢复旧库；恢复旧库后只允许从未产生远端写入的记录重试，其余按 `needs_review` 人工处理。

## 3. 首次配置步骤

1. 打开 `http://<host>:8787/admin/` 登录。
2. 「连接配置」：填 Kaneo API 地址（如 `http://kaneo:1337` 或 `https://kaneo.example.com`，含不含 `/api` 均可）与在 Kaneo Web UI（设置→账户→API Keys）签发的 key；填 AI 兼容接口地址（如 `https://api.openai.com/v1`）、模型与密钥，分别点连接测试。
3. 「软件配置」：为每个接入软件登记 `appId`、允许的 Web 来源（登录握手回传目标的精确 origin）、Kaneo 项目 id（用「测试项目并加载列」拉取真实列 slug 并选择目标列，如“待筛选”列）。
4. 客户端接入参数：服务地址 + `appId`（+可选软件版本、页面标识）。目标 Kaneo 项目由服务端按 appId 决定。

## 4. 处理与失败行为（运维视角）

- 提交即入库（状态 `received`），返回后才后台处理：AI 整理（瞬时故障最多重试 3 次/轮）→ 写 Kaneo 任务（优先级 `no-priority`，无负责人/日期/里程碑）。
- AI 或归档明确失败 → `failed`，管理页「重试处理」（已有整理结果时跳过 AI 直接再归档）。
- Kaneo 写入结果不确定（超时/断连/5xx/服务在发送中崩溃）→ `needs_review`。管理页按 `recovery.allowedActions` 只渲染可用动作，全部动作携带 `expectedRevision` 乐观锁（过期页面 → `409 revision_conflict`，请刷新）：
  - **`recheck`（重新核对，针对任务）**：优先使用已有 task ID（不重复搜索、不重置阶段）；无 task ID 才按任务描述中的 `反馈ID：<uuid>` 全局搜索；命中自动关联为已归档，未命中维持 `needs_review`。恢复流程绝不盲目创建。只读取远端结果，**不会重发任何评论或图片**。
  - **`force-create`（再次创建任务）**：仅当任务创建结果未知且无任何 task/附件/评论状态已知时可用（否则 409）；有重复风险提示。
  - **`retry_comment`（针对评论，唯一允许重发评论的动作）**：执行前按「反馈 ID + 图片摘要 + 当前资产引用」查重；命中→补记确认并归档（零远端写入），未命中→发送**至多一条**评论。**仍可能产生重复评论**（远端列表与写入之间存在竞态），管理页在确认框中提示该风险，操作后请到 Kaneo 复核评论数量。
  - **`replace_upload`（针对图片，唯一可以替换图片的动作）**：先经鉴权下载核对真实字节（与本地截图 SHA-256 比对；一致则仅补记，不替换）；替换时**复用原任务、保留旧 key 恢复记录（`replacedKeys`）、不自动删除远端对象**；替换成功后重发评论。核对失败或多候选 → `needs_review` 待人工核对，绝不猜测。
  - 管理操作互斥：同一反馈同时被处理时其它操作返回 `409 busy`；归档目标已改变返回 `409 target_changed`（见下）；远端读取/写入失败返回 `502 recover_failed` 且状态不变（不触发替代写入）。
- 列失效（改名/删除）→ `failed` 并提示修复配置；服务不会自动创建列或改写看板。

### 4.1 归档目标变更（`409 target_changed`）

- **含义**：每条记录在首次远端写入前会把当时的归档目标（Kaneo `apiBase` / 项目 / 工作区）固定进恢复数据。之后每个恢复动作都会先查询当前配置的 Kaneo，并与已保存目标逐字段比对；不一致即返回 `409 target_changed`（`recheck` / `force-create` / `retry_comment` / `replace_upload`），消息说明“已停止远端操作且未改动恢复数据”，附注还标出不一致的字段。
- **为什么这样设计**：避免把旧记录的恢复数据（旧 key、旧资产、旧评论线索）写进另一个项目或实例，产生无法追溯的重复任务/资产。
- **运维处置**：① 若属于误改，**把 Kaneo 地址/项目/工作区改回原值**，刷新管理页后重新执行同一动作；② 若确实要迁移到新目标，不要指望旧记录自动跟随——请依据记录里留存的 key 与资产线索在 Kaneo 中人工处理该记录，或保留原目标实例直到旧记录处理完。
- **改配置不会重定向旧记录**：修改「连接配置」或软件的 Kaneo 项目后，历史记录在新目标上不会继续；它们会停下等待人工判断。升级/迁移前请先确认**没有未处理的 `needs_review` 记录**（管理页按「待核对」筛选）。
- 注意 `POST /api/feedback/:id/retry`（管理页「重试处理」）**不返回**该错误：请求照常 `202`，随后后台处理会零远端写入停止并把记录置为 `needs_review`（`error_summary` 含“归档恢复目标已改变”）。管理页刷新即可看到——记录若原为 `failed`，刷新后应出现在「待核对」筛选中。

### 4.2 上传地址过期与同 key 重传被拒（人工替换）

- 预签名上传地址会过期（`upload.expiresAt`）。**自动路径绝不因过期而申请新上传地址**：记录转入 `needs_review`，`error_summary` 含“过期”，原始 key 与 `expiresAt` 完好保留。
- 同一 key 的重传被 Kaneo 业务拒绝（签名失效/策略拒绝等）同样**不自动换 key**：`needs_review`，`error_summary` 含“同 key”，原 key 保留。自动路径对同一 key 只做「重传相同字节」的安全恢复，累计上限 3 次。
- 这两种情况的唯一出路是管理页的**「替换截图上传」**（`replace_upload`）：复用原任务申请新地址替换图片，保留旧 key 记录（`replacedKeys`）并且**不删除远端对象**——远端残留文件须人工清理（当记录曾被多次替换时尤需注意）。
- 走这条路之前请先确认 Kaneo 中该任务是否已经有图片：`replace_upload` 会先下载远端资产比对字节，一致则不替换。

### 4.3 自动重试从不补发第二条评论

- 评论写入前会先把 `comment.outcome` 落盘为 `maybe_sent`（含义是“**可能已到达 Kaneo**”），只有远端明确拒绝才降级为 `not_sent`；**`maybe_sent` 永不改回“未发送”**。
- 因此 `retry`、「重新核对」以及服务重启后的后台恢复，遇到 `comment.outcome` 为 `maybe_sent` / `confirmed` 且远端查重未命中时，**一律停止自动处理并维持 `needs_review`**，不会自动补发评论——避免产生重复评论。补发评论只能由人工执行 `retry_comment`（查重后至多一条，且仍存在竞态风险）。
- 排查时不要以“远端没查到评论”为由反复执行自动重试：请直接查看详情页的 `recovery.commentOutcome` / `uploadOutcome`，或按 `docs/api.md` 的「恢复数据写入结果语义」判断。

错误码与字段的确切含义、请求/响应形态见 **`docs/api.md`**（含 `409 target_changed` 的完整报错文本与各恢复动作的错误码）；本节只讲运维处置，不复述字段表。

## 5. 反向代理（HTTPS）

反馈服务与 Kaneo 同域部署亦可。要求：透传 `Host`（同源检查依赖最终 URL）与 WebSocket 无关（本服务无 WS）。`X-Forwarded-Proto` 非必需（Origin 校验用请求 URL）。Cookie `SameSite=Lax`，管理页与登录窗口均为第一方上下文，不依赖第三方 Cookie。

## 6. 已知边界（第一版）

- 单实例、进程内队列：水平扩展不支持（多实例会并发处理同一恢复队列）。
- 限流为进程内滑动窗口（登录 10 次/15 分钟/IP+用户名；提交 60 次/小时/会话）。
- 截图归档依赖 Kaneo 图片上传接口与资产鉴权下载；远端对象在替换后不自动删除（须人工清理）。
- 不包含语音、系统悬浮窗、截图编辑器、公开反馈、多用户管理、任务自动拆分。截图支持范围见 `packages/web/README.md` 与 `flutter/feedback/README.md` 的「截图与敏感区遮挡」章节。
