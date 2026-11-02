# 变更记录（CHANGELOG）

按发布标签归档**对接入方可观察**的变更：组件 API、HTTP 契约、部署与分发方式。
内部重构、测试与 CI 加固不逐条列出（完整历史见 `git log`）。

稳定性口径：见 [`docs/api.md`](docs/api.md)「契约稳定性」与
[`docs/integration.md`](docs/integration.md) §1.7。标注 **破坏性** 的条目表示
宿主升级时需要处理；未标注的均为兼容变更（新增可选字段 / 属性 / 端点）或内部变更。

## [0.8.1] — 2026-11-02

### 修复与体验

- **管理端 Web 页面修订**：登录页改为品牌说明 + 登录表单双栏（窄屏只保留表单）；会话页改为设备/会话卡片并明确「当前会话」；软件、账号、连接、管理员设置、系统更新等页面统一设计令牌、间距与响应式布局；同步更新浏览器验收脚本。
- 服务端与组件运行时行为无变化；本版本统一版本号，便于管理端产物与部署版本对应。数据库 schema 保持 **14**。

### 分发

- root、server、admin、Web 与 Flutter 组件统一为 **0.8.1**；Web 使用本 Release 的 `feedback-web-0.8.1.tgz`，Flutter 固定 Git 标签 `v0.8.1`。

## [0.8.0] — 2026-11-02

### 新增

- **Kaneo 完成状态回读**：已归档反馈关联的 Kaneo 任务进入项目 `isFinal` 完成列时，服务端自动（默认每 10 分钟；`FEEDBACK_KANEO_SYNC_INTERVAL_MS=0` 可关闭）或由管理员手动「同步完成状态」把问题置为「已解决」，并写入一条用户可见的系统处理说明（计入「我的反馈」未读）。自动扫描只处理仍为「待处理」的已归档记录，不自动关闭等待用户/等待管理员的人工对话；已解决记录不重复写入。新增管理端接口 `POST /api/admin/feedback/:id/sync-kaneo` 与 `POST /api/admin/feedback/sync-kaneo`，详见 `docs/api.md`。
- **中文等国际化域名（IDN）**：自定义服务器地址支持中文域名，按 IDNA 转为 ASCII/punycode 后校验、比较与请求；`。` / `．` / `｡` 与全角 ASCII 按常用 UTS46 映射处理（Web 端由浏览器 URL 解析完成转换）。
- **管理端反馈工作台**：统一设计令牌与 236px 侧栏；≥1280px 时反馈列表与详情同屏、各自滚动、表头吸顶，窄屏保留遮罩抽屉；关闭详情后焦点回到触发项，跨断点保留回复草稿。

### 修复

- 设置中服务器地址留空（含仅空白）时保存不再报「请输入服务器地址」，按保持当前实际使用的服务器不变处理；清除覆盖仍走「恢复默认」。
- Flutter 端中文域名不再被百分号编码成无法解析的主机名；`FeedbackConfig.apiBase` 在构造时完成 IDN 转换。

### 升级与兼容

- 服务端数据库 schema 保持 **14**，无需迁移；旧版组件继续兼容（新增可选端点与行为，既有契约不变）。
- 若不希望服务端自动改工单状态，设置 `FEEDBACK_KANEO_SYNC_INTERVAL_MS=0`，仅使用管理端手动同步；「看板任务完成」不会写回 Kaneo，也不代表自动重开/关闭人工对话。

### 分发

- root、server、admin、Web 与 Flutter 组件统一为 **0.8.0**；Web 使用本 Release 的 `feedback-web-0.8.0.tgz`，Flutter 固定 Git 标签 `v0.8.0`。

## [0.7.1] — 2026-11-02

### 修复

- **Web / Flutter 深色待机通透玻璃**：完整球、贴边半球与小把手采用近透明底色、背景折射和局部细高光，优化深色背景上的待机观感；无安全纹理时使用透明轮廓降级。
- **深色小把手**：普通深色模式调整为 10×48 逻辑像素、距安全边 10 像素，保留原命中范围。浅色和高对比仍使用原尺寸与边距，唤醒、5 秒收起、形变及拖动截图流程保持兼容。

### 升级与兼容

- root、server、admin、Web 与 Flutter 统一为 **0.7.1**。Web 使用本 Release 的 `feedback-web-0.7.1.tgz`，Flutter 固定 Git 标签 `v0.7.1`。
- 公共 API、宿主配置和数据库 schema 14 不变；本版本不新增数据迁移，也不会自动升级已接入的宿主或生产服务。

## [0.7.0] — 2026-11-02

### 新增

- **会话式问题追踪**：用户可在“我的反馈”查看状态、未读回复与完整对话，继续补充文字和附件；管理员回复、请求补充、填写处理说明后解决或重开问题。用户回复保留既有 Kaneo 任务和链接。
- **多图与图片编辑**：首次反馈及回复支持至多 5 张有序图片，支持预览、裁剪、标注、遮挡与删除；旧服务通过能力协商保持单图模式，并提示升级。
- **Web / Flutter 液态灵感球**：透明柔光待机、闲置 5 秒后收为小把手或贴边球，拖动切换清晰玻璃；松手以球心生成 144×144 逻辑像素初始选区，四角调整、确认后进入真实附件。手动调整最小边长仍为 48。
- **可选唤醒手势**：设置中选择双指长按、三指上滑或双指双击，默认关闭，按本机 appId 保存；只唤醒当前宿主入口，松手后再拖球截图。
- **管理工作台与诊断接入**：优化反馈详情、软件、账号、会话、连接、设置等页面，补齐日志、诊断记录与宿主接入示例。

### 修复与分发

- 修复截图/装饰透镜的遮挡、异步失效、关闭后纹理恢复、拖动命中及 Flutter 宿主外层输入退格；浅色待机入口使用更易分辨的宽柔光。
- 修复安全存储矩阵宿主的 shader 测试资源路径，保留实际像素断言；发布改为手动触发，产物齐全后才公开 Release。

### 升级与兼容

- root、server、admin、Web 与 Flutter 组件统一为 **0.7.0**。Web 从本 Release 的 `feedback-web-0.7.0.tgz` 安装，Flutter 固定 Git 标签 `v0.7.0`；不发布到 pub.dev。
- 服务端数据库从 schema 12 自动迁移至 **schema 14**（Issue 对话及多图附件）。升级前备份数据目录；回退旧服务必须同时恢复升级前备份，不让旧服务直接使用新库。
- **管理员解决问题必须填写处理说明**；自写管理端需按 `docs/api.md` 提交 `resolutionNote`。旧单图提交及公开宿主入口保持兼容，新客户端先探测 `/api/features`，完整新体验建议组件与服务同时升级。
- 截图只覆盖当前宿主可捕获视口，不跨应用、不做系统截图；Flutter 平台视图可能留下空洞并安全降级。Android 真机历史验证与本轮发布验证分别记录，不宣称所有平台均已实测。正式发布不自动升级生产服务。

## [0.6.0] — 2026-09-19

### 新增

- **Assist 管理面（接入契约 v1.1）**：新增仅中枢内网回连的管理接口组
  - `GET /api/assist/manage/feedback`：反馈列表回读，支持 `view`（inbox/archived/trash/all）、
    `cursor`/`limit` 分页与 `q` 搜索，响应附三区计数；条目含 `mgmtState`、`lifecycleVersion`、
    `collectionState`、`resumePaused`、`allowedActions` 等管理字段。
  - `POST /api/assist/manage/feedback/:id/action`：单条生命周期与安全重试操作
    （`archive`/`unarchive`/`trash`/`restore`/`resume_processing`/`retry`/`recheck`），
    `requestId` 幂等去重（同键同参数回放已存结果，参数不同返回 `request_id_conflict`，
    运行中超 10 分钟惰性终结为 `outcome_uncertain`），生命周期动作携带
    `expectedLifecycleVersion`、`retry`/`recheck` 携带 `expectedRevision` 乐观锁。
  - 新增环境变量 `FEEDBACK_ASSIST_MGMT_KEY`（独立管理凭证）：未配置则整组不挂载；
    与生效只读凭证（`FEEDBACK_ASSIST_READ_KEY`/`FEEDBACK_ASSIST_SOURCE_KEY`）相同时拒绝挂载并记警告。
- **`GET /api/assist/feedback/:id` 详情扩展字段**（兼容新增）：`appName`、`mgmtState`、
  `lifecycleVersion`、`revision`、`issueStatus`、`collectionState`、`resumePaused`、
  `archiveStage`、`kaneoTaskUrl`、`archivedAt`、`trashedAt`、`allowedActions`、
  `capabilities.manage`（管理面是否挂载）。

### 升级说明

- 服务端数据库自动迁移至 **schema v12**：新增 `assist_mgmt_requests` 幂等请求表
  （迁移号按契约冻结为 v12，v11 预留给 Issue 对话特性），不改任何既有表与状态机。
- 管理面不改变反馈业务语义：回收站恢复不自动重启处理，`archive` 仅为本地归档区语义
  （不代表创建 Kaneo 任务），彻底删除（purge）不开放给管理凭证。

## [0.5.2] — 2026-09-19

### 新增

- **管理后台自持反馈组件**：管理页内嵌 `<feedback-widget>`（灵感球入口 + 视口截图），
  管理员在后台任何页面（含登录页）都能直接把问题反馈进本服务的收件箱；提交按
  `appId=com.feedback.admin` 归类，`pageLabel` 自动跟随当前管理页（`admin:<page>`），
  主题跟随后台主题偏好。截图遮罩沿用组件规则（`input[type=password]` 等敏感区自动遮盖）。
- **组件宿主会话 API**：`FeedbackWidget` 新增 `adoptSession({accessToken, expiresAt})` /
  `dropSession()` 公开方法与 `FeedbackHostSession` 类型——宿主持有服务端签发的
  Bearer 令牌（如同源页面以自身 Cookie 会话调 `POST /api/auth/handshake` 换取的握手令牌）
  时可注入组件，免去组件内二次登录；注入后自动拉取会话身份与额度，令牌仅存内存。
  管理后台即首个使用者：登录后自动登记 `com.feedback.admin` 软件（缺失则创建、
  缺当前 origin 则补入白名单），握手注入并按令牌寿命周期续注；任一步失败组件回退
  为面板内自登录，不影响后台功能。
- **数据目录挂载（bind mount）**：`deploy/compose.simple.yml` 新增可选部署变量
  `FEEDBACK_DATA_PATH`（宿主目录绝对路径）——设置后 `/data` 改为绑定挂载该目录，
  替代命名卷；不设则行为不变。`update.sh` 的备份对两种形态通用
  （`FEEDBACK_DATA_PATH` 优先于 `FEEDBACK_DATA_VOLUME`）。注意与容器内路径变量
  `FEEDBACK_DATA_DIR`（`/data`，服务端变量）区分。

## [0.5.1] — 2026-09-19

### 破坏性

- **移除自动更新执行器（updater）**：`apps/updater`、完整模式部署资产（`deploy/compose.prod.yml`、
  `deploy/install-updater.sh`、`deploy/.env.prod.example`）与更新控制链路整体移除。后台「系统更新」
  改为**只检查不安装**：服务端直接拉取 GitHub Release 清单比对版本，展示最新版本、发布时间、
  镜像 digest 与 Release 链接；实际升级由管理员手动执行 `deploy/update.sh`（先打数据卷备份）
  或 `docker compose pull && up -d`。
- **API 收敛**：移除 `POST /api/admin/system/update`（发起更新）与
  `GET /api/admin/system/update/:id`（任务进度）；保留 `GET /api/admin/system/update` 与
  `POST /api/admin/system/update/check`（限流）。更新期间不再暂停业务写入（`paused` 标记与
  `503 update_paused` 行为一并移除）。
- **环境变量变更**：移除 `FEEDBACK_UPDATER_URL` / `FEEDBACK_UPDATE_URL` /
  `FEEDBACK_UPDATE_TOKEN_FILE` / `FEEDBACK_UPDATE_CONTROL_DIR` 及全部 `UPDATER_*` 变量；新增
  `FEEDBACK_UPDATE_MANIFEST_URL`（默认指向本仓库最新 Release 的 `release-manifest.json`，
  `off` 可禁用检查）与 `FEEDBACK_UPDATE_CHECK_INTERVAL_MS`（默认 24h，`0` = 仅手动检查）。
- **发布流水线**：只构建并推送 feedback 单镜像；`release-manifest.json` 不再包含
  `services.updater` 与 `requiredUpdaterProtocol` 字段。

### 迁移说明（原完整模式 → 简易模式）

- 停机并备份后，把 `deploy/compose.simple.yml` 以 `docker-compose.yml`（或 `compose.yml`）放回部署
  目录；`.env.prod` 中 `FEEDBACK_DATA_VOLUME` 必须指向**原数据卷名**（完整模式为 external 卷，不带
  项目前缀），`FEEDBACK_IMAGE` 改为版本标签（如
  `ghcr.io/sakuralovesmile/sakura-feedback:v0.5.1`），删除全部 updater 相关变量与 `update-control/`
  目录，然后 `docker compose --env-file .env.prod up -d`。详细步骤见
  `deploy/README.md`「从完整模式迁移」。**卷名指错会挂上一个新的空卷，表现为数据丢失**——先
  `docker volume ls` 核对再启动。

## [0.5.0] — 2026-09-18

### 新增

- **管理工作台**：重设计反馈、软件、账号、会话、连接、设置与系统更新页面；支持浅色、深色、跟随系统主题，保存主题偏好，优化移动端、键盘操作与表单可访问性。
- **反馈生命周期**：新增收件箱、已归档、回收站，支持搜索、筛选、批量操作、恢复与彻底删除。仅完整同步到 Kaneo 的反馈可本地归档；恢复未完成反馈后保持暂停，需显式恢复处理。
- **软件软删除**：删除软件后保留历史反馈，不再新增自动同步授权；已授权任务继续执行，同一 appId 后续提交会重新登记为待配置软件。
- **自定义服务器**：Web 与 Flutter 面板支持配置、记住及恢复默认服务地址，按软件与默认服务器隔离偏好；跨服务器切换清除原认证和草稿。
- **可选 Assist 接入**：增加持久化事件队列、失败退避与带独立凭证的反馈/附件只读接口；默认关闭，需显式配置中枢地址与密钥。

- **简易部署模式**：`deploy/compose.simple.yml`（单服务、可变镜像标签、compose 自管理数据卷）、
  `deploy/bootstrap.sh`（交互式首次部署：生成主密钥与管理员密码、写 `.env.prod`、拉镜像启动）、
  `deploy/update.sh`（数据卷 tar 备份 → `compose pull` → 重建 → 等健康，`--to vX.Y.Z` 可回退）。
  更新路径从「抄 digest → 改 env → pull/up」简化为一条命令。完整模式（digest 固定 + updater
  一键更新）不变，取舍对比见 `deploy/README.md`「两种部署形态」。

### 修复

- 修复 Web 页面滚动或缩放后截图遮罩受残留 Canvas 变换影响的问题；遮罩无法确认时继续拒绝截图。
- 修复 Web 切换软件标识并加载不同服务器偏好时旧令牌可能发往新服务器的问题。
- 修复 Flutter 键盘遮挡面板，以及切换软件/服务器期间迟到的配置保存、截图结果污染新身份的问题。
- 修复管理端迟到详情覆盖当前反馈、保存失败误报成功及轮询丢失分页尾部记录的问题。
- 彻底删除反馈时同时清除本地 Assist 事件副本；Assist 投递增加超时与停止取消，避免请求悬挂阻塞队列。

### 升级说明

- 服务端数据库自动迁移至 **schema v10**，旧反馈保留并进入收件箱。升级前备份数据卷；回退旧版本时应同时恢复升级前的数据备份，不能直接让旧程序使用升级后的数据库。
- 本地归档/回收站不删除 Kaneo 任务。彻底删除不可恢复，不返还每日额度；已发送至 Kaneo/Assist 的远端数据不在本地删除范围。
- 普通账号查询已彻底删除的反馈或重放原提交键时可能收到 **HTTP 410**。管理员反馈列表默认只返回收件箱；查询收件箱和已归档请显式使用 `view=all`。
- Web、Flutter、服务端和管理端版本统一为 **0.5.0**；updater 保持 **0.1.0**。Web 包通过本 Release 的 `.tgz` / dist 资产分发。

## [0.4.0] — 2026-09-16

> 对应文档中的 v6 / v7 里程碑。

### 破坏性

- **提交成功不再自动归档（v6）**：`POST /api/feedback` 成功仅代表「已接收 + AI 整理」。
  写入 Kaneo 需管理员在管理页逐条「保存并归档」，或配置规则后显式「启用自动归档并处理积压」。
  依赖「提交即出任务」旧链路的宿主需要调整预期与文案。
- **反馈状态机调整**：新增 `needs_info` / `ready_to_archive`；AI 整理失败不再置 `failed`
  （保留原文、标题回退为原文首个非空行）。轮询 `GET /api/feedback/:id` 的客户端必须容忍新状态值。

### 新增

- **先接收、后配置（v7）**：`appId` 无需事先登记，首次有效提交自动发现一条待配置软件；
  面板内登录同样不再要求软件已登记（仍校验账号、启用状态、限流与 Origin 合法性）。
- `collectionState` 字段（`POST /api/feedback` 与 `GET /api/feedback/:id` 响应）：
  `queued` / `waiting_configuration` / `waiting_source_confirmation` / `waiting_manual_archive`，
  组件据此显示「已保存，等待…」并停止轮询。
- 可选 `appName` 上报：`POST /api/feedback` 的 `appName` 字段、Web 属性 `app-name`、
  Flutter `FeedbackConfig.appName`；管理员保存过名称后客户端上报不再覆盖。
- 来源登记与确认：服务端按请求 Origin（原生记 `native`）逐条登记来源，管理员确认；
  新增 `POST /api/admin/apps/:id/sources/confirm`。
- 自动归档：`POST /api/admin/apps/:id/auto-archive/enable|disable`、`ruleVersion` 乐观锁、
  列表 `autoBlocked*` 阻塞原因字段；可恢复故障按 1 分钟~30 分钟有上限退避自动重试。
- 人工分类接口：`GET /api/admin/feedback/options`、`POST /api/admin/feedback/:id/classify`
  （`action: save|archive`、`classifyVersion` 乐观锁、`operationId` 幂等）。

### 变更（放宽，非破坏）

- CORS：`/api/feedback*` 与 `/api/auth/*` 组件端点对任意合法 http(s) Origin 回显
  （仍只 Bearer、`credentials: omit`）；旧握手端点不随此放宽。
- `allowedOrigins` 语义改为「管理员登记即已确认来源」；旧登录窗口握手仍按白名单校验。

## [0.3.0] — 2026-09-15

### 新增

- **日志附件**：Web 组件 `logProvider`（导出 `FeedbackLogProvider` / `FeedbackLogFile` /
  `FeedbackLogAttachment` 类型）与面板日志附加入口；Flutter 导出 `FeedbackLogProvider` /
  `FeedbackFilePicker` / `FeedbackLogFile`。契约：`POST /api/feedback` multipart 新增可重复的
  `logs` 部件与 `metadata.logs` 描述符（≤3 份、单份 ≤1 MiB、`.log/.txt/.json/.jsonl`、
  UTF-8、SHA-256 完整性校验）；管理页新增日志下载 / 预览端点
  （`GET /api/admin/feedback/:id/logs/:logId[/download|/preview]`）。
- `PATCH /api/admin/me`：管理员修改自己的用户名 / 密码，成功后该账号全部会话失效。
- 系统更新：`/api/admin/system/update*`（检查 / 发起 / 进度）+ 独立 updater 执行器镜像
  `ghcr.io/sakuralovesmile/sakura-feedback-updater`；更新期间 `paused` 标记使业务写入返回
  `503 update_paused`。

### 变更

- 发布流水线收紧：预发布标签与 `workflow_dispatch` 不再创建 Release；正式标签须与根
  `package.json` 版本及提交严格一致，否则在推送任何镜像前失败。
- Flutter `flutter_secure_storage` 约束放宽至 `>=9.2.2 <12.0.0`
  （使用 11 的宿主需满足 Dart ≥3.8、Android minSdk 24 / compileSdk 37）。

## [0.2.0] — 2026-09-13

### 新增

- **账号体系与每日提交额度**：账号由后台创建分发（`/api/admin/users*`），每账号默认每天
  3 次、北京时间零点刷新；登录 / 会话 / 提交响应统一携带 `user` 与 `quota`；
  额度用尽返回 `429 daily_quota_exceeded`。
- **面板内登录**成为当前方式：Web 组件与 Flutter 在面板内调用 `POST /api/auth/login`
  （显式 `clientLabel` + `appId`）换取 Bearer 令牌；Web 组件新增导出类型
  `AuthUser` / `Quota` / `LoginResponse` / `SessionResponse`。
- 服务端优雅退出（SIGTERM/SIGINT 先 checkpoint WAL）。
- e2e 支持 `--browser` 跨引擎（Chromium / Firefox / WebKit）与 `--smoke` 轻量模式。

### 变更（需注意）

- 旧登录窗口握手（`/login` + `/api/auth/handshake*`）降级为**兼容保留**：仍可用，
  但仍要求软件已登记且来源在 `allowedOrigins` 内。新集成请使用面板内登录。
- CORS：`/api/auth/*`（login / logout / session）纳入跨源 Bearer 放行范围。

## [0.1.0] — 2026-09-11

首个可复现基线：

- `<feedback-widget>` Web 组件（ESM + UMD 双产物；`captureProvider` 扩展点、
  视口截图与敏感区遮挡、`feedback-submitted` 事件、`openFeedback()`）。
- `feedback_widget` Flutter 包（`FeedbackWidget` / `FeedbackController` / `FeedbackCaptureMask`）。
- 反馈服务（Hono + node:sqlite + sharp）、管理页、Kaneo 归档链路（提交整理后直接写入
  软件配置的项目目标列）。
- 发布流水线：标签发布 → GHCR 镜像 + Release 资产（Web tgz、dist zip、SHA256SUMS）。
- 登录方式为服务侧登录窗口握手（`/login` + `/api/auth/handshake`）。
