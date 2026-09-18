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
| `FEEDBACK_UPDATE_MANIFEST_URL` | 否 | 「检查更新」的版本清单地址，默认稳定渠道 Release 的 `release-manifest.json`；`off` 显式关闭检查功能 |
| `FEEDBACK_UPDATE_CHECK_INTERVAL_MS` | 否 | 自动检查间隔，默认 86400000（24 小时，只检查不安装）；`0` = 只允许手动检查 |
| `FEEDBACK_SESSION_TTL_MS` 等 | 否 | 会话有效期微调（cookie 14 天 / 客户端令牌 90 天 / 握手令牌 15 分钟） |

上面是**服务端**读取的变量。生产部署还有一组供 compose 变量替换使用的部署变量（`FEEDBACK_IMAGE`、`FEEDBACK_PUBLIC_URL`、
`FEEDBACK_DATA_VOLUME`、`FEEDBACK_DATA_PATH`（宿主目录挂载）、`FEEDBACK_BIND` 等），由 `deploy/bootstrap.sh` 写入 `<部署目录>/.env.prod`（600）；
各项含义见 [`../deploy/README.md`](../deploy/README.md)。

## 2. Docker

本地开发（仓库根 `compose.yml`：单服务、绑定挂载 `./data`）：

```bash
docker build -t feedback-service .
docker compose up -d       # 读取 .env（主密钥与初始账号），卷 ./data:/data
```

生产部署形态（`deploy/compose.simple.yml`：单服务、可变镜像标签、命名卷或宿主目录存数据）：

```bash
bash deploy/bootstrap.sh     # 首次：交互式收集域名、生成主密钥与管理员密码、写 .env.prod、启动
bash deploy/update.sh        # 之后每次更新：卷备份 → compose pull → 重建 → 等健康
```

镜像默认跟 `latest`；要固定版本在 `.env.prod` 里写 `FEEDBACK_IMAGE=...:vX.Y.Z`。
端口只绑回环（`FEEDBACK_BIND`，默认 `127.0.0.1:8787`），公网入口一律走 Nginx TLS 终止。

> v0.5.1 起移除了完整模式（`compose.prod.yml` + `updater` 执行器）：后台「系统更新」只做版本检查，
> 更新统一走 `update.sh`（更新期间不暂停写入、不留逐版本卷副本——`update.sh` 的 tar 备份
> 就是唯一的回退凭据；数据库迁移单向，跨 schema 版本回退必须先恢复备份）。
> 既有完整模式部署的迁移步骤见 [`../deploy/README.md`](../deploy/README.md)。

备份/迁移：**先停旧 worker**，随后整目录拷贝 `data/` 即可。停机方式与前置条件：

- 用 `docker stop <容器>`（`deploy/compose.simple.yml` 已设 `stop_grace_period: 30s`）或向进程发 `SIGTERM`。
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

### 2.1 版本检查（后台「系统更新」）

登录后台 →「系统更新」标签：显示当前版本与最新稳定版（版本号、发布说明、镜像 digest、Release 页面链接）。
服务端直接拉取 GitHub Release 的 `release-manifest.json` 并与本机版本比较——**只检查，不安装**：
该页没有任何更新按钮，也不会触碰 compose、镜像或数据卷。检查结果缓存在 `FEEDBACK_DATA_DIR/update-check.json`，
默认每 24 小时自动检查一次（`FEEDBACK_UPDATE_CHECK_INTERVAL_MS`，`0` 关闭），也可手动点「检查更新」。
自建发布渠道可用 `FEEDBACK_UPDATE_MANIFEST_URL` 指向自定义清单地址，`off` 则整体关闭检查功能。

### 2.2 升级流程

确认有新版本后，在服务器上执行：

```bash
cd <部署目录>
bash <仓库>/deploy/update.sh          # 卷备份 → compose pull → 重建 → 等健康（自动识别 compose 文件名）
# 或手动：docker compose --env-file .env.prod pull && docker compose --env-file .env.prod up -d
```

`update.sh` 先把数据卷打成 tar 备份（`<deploy-dir>/backups/`，保留最近 10 份），再拉取重建；
这就是唯一的回退凭据。数据库迁移是**单向**的：跨 schema 版本回退（如 0.5.x → 0.4.x）
必须先恢复备份包，不能只改镜像标签。

更新期间服务有短暂停机（`stop` → `up -d`，compose 的 `stop_grace_period: 30s` 负责优雅退出）；
与旧完整模式不同，**更新期间不再暂停业务写入**——停机窗口内的提交会随容器一起不可用，
恢复后自动重试由客户端/组件的重试语义承担。

### 2.3 升级与回退限制（重要）

1. **数据位置行为**：`update.sh` 的备份是 tar 包；数据（命名卷或 `FEEDBACK_DATA_PATH`
   指定的宿主目录）始终由 compose 管理，不会被重建过程触碰。
2. **人工回退到旧版本**：先恢复 `backups/` 里升级前的 tar 备份（见 deploy/README.md 的恢复命令），
   再把 `FEEDBACK_IMAGE` 改回旧版本标签 → `docker compose --env-file .env.prod up -d`。
   只改标签不恢复备份，旧版本读不动新 schema 会直接起不来。
3. **新格式恢复数据**（`archive_data_json` v1：revision/target/upload/asset/comment/replacedKeys）随正文一起落库，备份即包含；`upload.credentialsEnc` 用主密钥 AES-256-GCM 加密，恢复主密钥备份才能解密预签名地址。
4. **Kaneo 远端写入限制**：新版本一经对 Kaneo 产生远端写入（创建任务 / 上传资产 / 登记 / 评论），**不允许简单恢复旧数据库并重放**——旧库没有新恢复记录（task ID、key、outcome、replacedKeys），重放会再次创建任务与资产，造成重复。需要回退时：停服 → 备份当前库 → 用新库的归档状态人工核对 Kaneo 侧既有资产/评论，再决定是否恢复旧库；恢复旧库后只允许从未产生远端写入的记录重试，其余按 `needs_review` 人工处理。

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
