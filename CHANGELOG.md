# 变更记录（CHANGELOG）

按发布标签归档**对接入方可观察**的变更：组件 API、HTTP 契约、部署与分发方式。
内部重构、测试与 CI 加固不逐条列出（完整历史见 `git log`）。

稳定性口径：见 [`docs/api.md`](docs/api.md)「契约稳定性」与
[`docs/integration.md`](docs/integration.md) §1.7。标注 **破坏性** 的条目表示
宿主升级时需要处理；未标注的均为兼容变更（新增可选字段 / 属性 / 端点）或内部变更。

## [未发布]

### 新增

- **简易部署模式**：`deploy/compose.simple.yml`（单服务、可变镜像标签、compose 自管理数据卷）、
  `deploy/bootstrap.sh`（交互式首次部署：生成主密钥与管理员密码、写 `.env.prod`、拉镜像启动）、
  `deploy/update.sh`（数据卷 tar 备份 → `compose pull` → 重建 → 等健康，`--to vX.Y.Z` 可回退）。
  更新路径从「抄 digest → 改 env → pull/up」简化为一条命令。完整模式（digest 固定 + updater
  一键更新）不变，取舍对比见 `deploy/README.md`「两种部署形态」。

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
