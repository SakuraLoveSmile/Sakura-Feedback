# 部署与运维

单实例运行；无 Redis、无外部数据库。所有状态在 `FEEDBACK_DATA_DIR`（SQLite WAL 文件 + 无其他内容）。

## 1. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEEDBACK_MASTER_KEY` | 是 | 主密钥。推荐 base64 的 32 字节随机值：`node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`。非 base64-32B 值将按口令 scrypt 派生。**丢失则已存密钥（AI/Kaneo）无法解密**，请备份。 |
| `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD` | 首次部署 | 初始账号，仅当库中无用户时生效；不开放注册。改密码：删除 `data/feedback.db` 中 users 行不推荐——第一版通过重建数据库或后续版本支持改密。 |
| `FEEDBACK_PORT` | 否 | 默认 8787 |
| `FEEDBACK_DATA_DIR` | 否 | 默认 `./data`；容器内 `/data` |
| `FEEDBACK_COOKIE_SECURE` | 否 | HTTPS 部署设为 `true`（默认 false，本地 http 可用） |
| `FEEDBACK_ADMIN_DIST` | 否 | 管理页构建目录；镜像内已指向 `/app/admin` |
| `FEEDBACK_SESSION_TTL_MS` 等 | 否 | 会话有效期微调（cookie 14 天 / 客户端令牌 90 天 / 握手令牌 15 分钟） |

## 2. Docker

```bash
docker build -t feedback-service .
docker compose up -d       # 读取 .env（主密钥与初始账号），卷 ./data:/data
```

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

### 升级与回退限制（重要）

1. **升级部署顺序**：停旧 worker（停止处理队列）→ 备份一致 SQLite（上述停机后整目录拷贝）→ 启动新版本 → 管理页抽查一条 `needs_review` 记录确认恢复动作就绪。
2. **新格式恢复数据**（`archive_data_json` v1：revision/target/upload/asset/comment/replacedKeys）随正文一起落库，备份即包含；`upload.credentialsEnc` 用主密钥 AES-256-GCM 加密，恢复主密钥备份才能解密预签名地址。
3. **回退限制**：新版本一经对 Kaneo 产生远端写入（创建任务 / 上传资产 / 登记 / 评论），**不允许简单恢复旧数据库并重放**——旧库没有新恢复记录（task ID、key、outcome、replacedKeys），重放会再次创建任务与资产，造成重复。需要回退时：停服 → 备份当前库 → 用新库的归档状态人工核对 Kaneo 侧既有资产/评论，再决定是否恢复旧库；恢复旧库后只允许从未产生远端写入的记录重试，其余按 `needs_review` 人工处理。

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

## 7. 日志附件与数据库 v3（本轮新增）

> **状态（如实标注）**：本节描述的迁移、接口与恢复路径均为**已落地（待体验）**——代码与自动化测试就位，但**尚未完成真实环境的端到端验收**（T7/T8 独立执行），不构成「已验收」结论。契约以 [`docs/api.md`](api.md) 的 L1–L11 / C1–C15 为准。

### 7.1 升级顺序（v2 → v3）

1. **停旧 worker**：`docker stop --time 30 <容器>`，或向进程发 `SIGTERM` 并等优雅退出；确认 `data/` 只剩 `feedback.db`（无 `-wal` / `-shm`）。
2. **整目录备份 `data/`**（停机后的一致快照，见第 2 节）。
3. **启动新版本**——迁移在服务启动时自动执行，不需要手工 SQL：
   - `feedback_logs` 的 DDL 在「建表脚本（`SCHEMA`）」与「迁移分支」**双写且逐字一致**；
   - `PRAGMA user_version < 3` 时，在**事务**内 `CREATE TABLE IF NOT EXISTS feedback_logs` → `PRAGMA user_version = 3` → `COMMIT`；
   - 任一步失败 → `ROLLBACK`，`user_version` **不前进**（下次启动会重试），不会留下半张表；
   - **不重建 `feedbacks`**、不改既有列；不提供、不执行任何批量升级脚本。
4. **启动后抽查**：管理页能打开升级前的老记录（无日志的记录：详情不显示日志区、列表日志数为 `0`）；数据仍落在同一个 `FEEDBACK_DATA_DIR`。

停机后可选验证迁移结果：

```bash
sqlite3 data/feedback.db "PRAGMA user_version;" ".schema feedback_logs"
# 期望：先输出 3；随后输出 feedback_logs 表定义与 idx_feedback_logs_feedback 索引
```

日志字节随 `data/` 一起备份（存在 `feedback_logs.log_blob`，不落文件系统），升级本身不需要额外搬运文件。

### 7.2 回退限制（重要）

- **不支持把新库拿回旧版本继续跑**。旧版本只认识归档存档数据的 `version: 1`；遇到本版本写入的 `version: 2` 会判为 `unsupported` 并**拒绝覆盖**（不会静默改写数据），这些记录的后续归档写入在旧版本上无法继续。
- 旧版本的迁移只处理 `user_version < 2`：`feedback_logs` 表与 `user_version = 3` **不会**被删除，但旧版本**不读取**日志——日志附件与逐份归档进度对旧版本不可见。
- 旧版本也不认识本版本新增的 `recover` 的 `logId`；回退后再前进，可能出现某份日志的归档进度「停在原地」，需要人工核对（见 7.3）。
- 结论：回退前先停服并备份当前库；**产生过 Kaneo 远端写入的记录不要简单恢复旧库重放**（与第 2 节第 3 条同理）——带日志会让"重复写入"的范围扩大到每份日志的资产与评论，用户也会看到重复评论。
- 本轮**不做**批量升级，也**不写**降级脚本：V1 归档存档数据继续可读，V2 只在记录发生新的归档写入时写出。

### 7.3 日志附件的人工核对与补归档（`needs_review` 时怎么办）

「截图成功但某份日志未完成」的记录**绝不会是 `archived`**：确定性失败 → `failed`；结果不确定 → `needs_review`。管理页详情按份显示每份日志的归档进度（未开始 / 进行中 / 已完成）。

1. **先核对，不要重新提交**
   - 管理页详情点「重新核对」（`recheck`）：只读远端；命中就补记确认，未命中维持 `needs_review`。它**不会**重发评论或图片，也**不会**因为"任务存在"就把整条记录标成归档完成。
2. **针对某一份日志补归档（带 `logId`）**
   - `POST /api/feedback/:id/recover`，body 例如
     `{ "action": "retry_comment", "expectedRevision": <n>, "logId": "<日志 id>" }`
     或 `{ "action": "replace_upload", "expectedRevision": <n>, "logId": "<日志 id>" }`（契约见 [`docs/api.md`](api.md) L10）。
   - 日志 `id` 的来源：`GET /api/admin/feedback/:id/logs`（Cookie 会话 + 同源）返回的 `LogMeta.id`，管理页详情每份日志也带 `data-log-id`。
   - `logId` **缺省 = 既有截图行为**；`logId` 不属于该反馈 → `404 not_found`；空串 / 非字符串 → `400 invalid_request`。
   - **UI 现状（如实标注）**：管理页当前的恢复按钮**不带 `logId`**（即针对截图）；日志级恢复目前需要按上面的接口直接调用（先用浏览器登录管理页，再复用同一会话 Cookie）。
3. **动作选择**
   - 评论可能已发出 / 不清楚 → `retry_comment`（先按 `feedbackId + logId + logSha256 + 当前资产引用` 查重，至多补发一条；**仍存在竞态**，事后必须到 Kaneo 复核评论条数）。
   - 上传地址过期 / 同 key 重传被拒 → `replace_upload`（复用原任务、为该份日志字节申请新地址；旧 key 记入 `replacedKeys`，**不删除远端对象**，远端残留需人工清理）。
4. **人工核对清单**
   - 管理页：该记录「状态」不再是「待核对」；**每一份**日志的进度都到「已完成」（单份「已完成」≠ 整条已归档，整条只看状态列）。
   - Kaneo 任务：日志资产与图片资产各就位；评论是否恰好一条（正文含查重标记）；有重复则人工清理。
   - 数据库（可选，建议停机后只查元数据）：
     ```bash
     sqlite3 data/feedback.db \
       "SELECT seq, filename, source, byte_size, sha256 FROM feedback_logs WHERE feedback_id='<uuid>' ORDER BY seq;"
     ```
     **不要**把 `log_blob` 打印到终端、写进工单或粘贴到聊天里：日志内容可能含敏感信息；需要内容请走管理页的预览 / 下载。
5. **不要做的事**：不要为了让记录变成"已归档"而重放旧库、不要手工 UPDATE `archive_data_json` / `archive_stage`、不要让用户重新提交（会产生重复任务与重复资产）。

### 7.4 容量与备份

- 日志字节存在 SQLite 的 `feedback_logs.log_blob`（**不落文件系统**），因此备份 / 迁移依然只需要整个 `data/` 目录；注意每份反馈最多 3 MiB 日志，备份体积会随之增长。
- 日志内容**不进入**运行日志 / `stdout` / 错误信息：服务端只记录文件名与大小级别的信息（错误消息也不含日志正文）。排障时同理不要打印 `log_blob`。
- 截图的备份与回退注意事项（第 2、4 节）对日志逐条适用；逐份归档进度记录在 `feedbacks.archive_data_json`（V2）里，随 `data/` 一起备份。
