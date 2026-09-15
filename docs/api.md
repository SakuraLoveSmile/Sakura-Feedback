# Feedback 服务 HTTP 契约 (v1)

Base URL：`http(s)://<host>:8787`。所有 JSON 请求必须 `Content-Type: application/json`，请求体上限 64 KB。
所有错误统一返回：`{ "error": { "code": "<machine_code>", "message": "<人类可读，可安全展示>" } }`。

认证方式（两类接口）：

1. **Cookie 会话**（管理后台与旧登录页）：`POST /api/auth/login` 成功后由服务端下发 HttpOnly Cookie
   `fb_session`（`SameSite=Lax`；HTTPS 部署下 `Secure`）。仅同站第一方请求携带，不依赖第三方 Cookie。
   管理后台、会话管理、反馈重试 / 恢复均要求**管理员角色**且 Cookie 同源；普通账号即使持有 Cookie 也会收到 `403 forbidden`。
2. **Bearer 令牌**（客户端组件登录与提交反馈）：`Authorization: Bearer <token>`。来源：
   - Web 组件与 Flutter（Web / 原生）：在**当前面板内**用账号密码调用 `POST /api/auth/login` 携带
     `clientLabel` + `appId` 换取令牌（Web 组件与 Flutter Web 仅存内存，原生 Flutter 存入安全存储）；
   - 旧登录窗口握手签发的短期令牌（兼容保留，默认 15 分钟）。

账号由后台创建并分发，**不开放注册**。部署初始账号由 `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD` 建立，角色为管理员。

### 每日提交额度

- 每个账号默认每天 **3 次**，按**北京时间**每天零点刷新；所有接入项目与设备共用同一额度。
- 日期与 `resetAt` 均由服务端时钟产生，客户端时间不参与，也不依赖定时清零。
- 一次反馈被服务端成功保存计一次；网络重试（同 key 同内容）不重复扣次；后台 AI / 归档失败不退次数；
  参数错误与事务失败不计次。
- 统一额度结构：`{ "dailyLimit": number, "used": number, "remaining": number, "resetAt": "<iso UTC>" }`。
- 登录、会话查询、提交成功与幂等重放响应都带 `user: { id, username, role }` 与 `quota`。
- 额度用尽返回 `429 daily_quota_exceeded`（**明确未接收**，不扣次），响应携带同结构 `quota`。

## 状态机（反馈记录）

| status | 含义 | 后继 |
|---|---|---|
| `received` | 原话已持久化，等待后台处理 | `processing` / `failed` |
| `processing` | AI 整理中 | `archiving` / `failed` |
| `archiving` | 已持久化“将发送 Kaneo”，创建请求已发出或待发 | `archived` / `needs_review` / `failed` |
| `needs_review` | Kaneo 写入结果不确定，待核对 | `archived` / `archiving` |
| `archived` | 已写入 Kaneo，终态 | — |
| `failed` | AI 或归档明确失败，可重试 | `processing` / `archiving` |

面板向用户展示的文案（Web 组件 `packages/web/src/element.ts`，Flutter 包文案不同）：
`received` / `processing` / `archiving` → 「已保存，正在整理」；
`archived` → 「反馈已归档。感谢你的支持！」；
`needs_review` → 「归档结果待确认。原话已保存，将在管理页人工复核。」；
`failed` 但服务端已接收 → 「原话已保存，后台整理未完成，可在管理页处理。请勿重复提交。」；
提交未到达服务（无服务端记录）→ 「尚未确认保存，请检查网络后重试。」。
**注意**：状态值本身（`received` 等）只出现在 HTTP 契约里，不作为用户可见文案。

## 认证组

### POST /api/auth/login
Body: `{ "username": string, "password": string, "clientLabel"?: string, "appId"?: string }`
- 无 `clientLabel`（管理后台 / 旧登录页）：`200 { "ok": true, "expiresAt": "<iso>", "user", "quota" }` + Set-Cookie；不返回令牌。
- 有 `clientLabel`（Web 组件 / Flutter）：必须同时携带 `appId`，否则 `400 "invalid_request"`；
  浏览器请求会按该 `appId` 的 `allowedOrigins` 校验 `Origin`（未登记 `403 "origin_not_allowed"`，`appId` 未配置 `404 "unknown_app"`），
  原生客户端不发送 `Origin` 时不校验来源。成功返回 `200 { "ok": true, "token": "<bearer，仅此一次明文返回>", "expiresAt", "user", "quota" }`（不附带 Cookie）。
- 账号不存在 / 已禁用 / 密码错误统一 `401 "invalid_credentials"`；限流后 `429 "rate_limited"`（`Retry-After` 头）。
- 限流：按 IP+用户名滑动窗口。登录、会话查询、退出支持跨源 Bearer（CORS，见文末），不依赖跨站 Cookie。

### POST /api/auth/logout
Cookie 或 Bearer。`204`。撤销当前会话（其 Bearer 令牌同时失效）。

### GET /api/auth/session
Cookie 或 Bearer。`200 { "authenticated": true, "kind": "cookie"|"client", "expiresAt": "<iso>", "user", "quota", "clientLabel"?: string }`；未认证 `401`。
组件在打开面板 / 登录成功 / 提交完成 / 恢复前台时调用此端点刷新额度。

### GET /api/auth/handshake/validate?appId=&origin= （需 Cookie 会话，兼容保留）
旧登录窗口在把令牌 postMessage 给宿主前调用。校验 `origin` 是否在 `appId` 的允许来源列表内。
- `200 { "ok": true }` 或 `400 "origin_not_allowed"`。

### POST /api/auth/handshake （需 Cookie 会话，兼容保留；body `{ "appId": string, "origin": string }`）
签发短期访问令牌，**绑定当前登录用户**（不再固定为数据库首个账号）。服务端再次校验 origin。
`200 { "accessToken": string, "expiresIn": number, "expiresAt": "<iso>" }`（默认 `expiresIn` = 900 秒）。

### 管理：会话撤销（仅管理员 Cookie 会话）
- `GET /api/auth/sessions` → `{ "sessions": [{ "id", "kind", "clientLabel"?, "createdAt", "lastUsedAt"?, "expiresAt", "current": bool }] }`
- `DELETE /api/auth/sessions/:id` → `204`（撤销 `current` 亦返回 `204`，前端应随即跳登录）。
- `POST /api/auth/sessions/revoke-all` → `{ "revoked": number }`
- 账号被禁用、密码被重置或**管理员改了自己的凭据**时，其全部会话立即失效（鉴权每次检查账号启用状态）。

### 账号管理（仅管理员 Cookie 会话，前缀 /api/admin/users）

账号对象（**绝不返回密码或哈希**）：
```jsonc
{ "id", "username", "enabled": bool, "dailyLimit": number, "used": number, "remaining": number,
  "resetAt": "<iso>", "createdAt": "<iso>" }
```
- `GET /api/admin/users` → `{ "users": [账号] }`（只列出**普通账号**；管理员保留，不在此管理）
- `POST /api/admin/users` `{ "username", "password", "dailyLimit"?: number }` → `201 账号`；`dailyLimit` 缺省为 3，
  必须是非负安全整数（`0` 表示禁止新提交）；重复用户名 `409 "user_exists"`；缺失/非法字段 `400 "invalid_request"`。
- `PATCH /api/admin/users/:id` `{ "enabled"?: bool, "dailyLimit"?: number }` → `200 账号`；调整立即生效且**不清除当天用量**
  （额度从 3 调 5、当天已用 3 次 → 剩余 2；降到低于已用次数 → 剩余 0）；禁用账号同时撤销其全部会话。
  目标不是普通账号（含管理员）→ `404 "not_found"`。
- `POST /api/admin/users/:id/password` `{ "password" }` → `{ "ok": true }`，并撤销该账号全部会话。

### 管理员设置：修改自己的凭据（仅管理员 Cookie 会话）

`PATCH /api/admin/me` —— **目标恒为当前会话管理员账号**：不接受任何可指定他人账号的字段（多余字段一律忽略），
普通账号 Cookie（`403 "forbidden"`）、Bearer 令牌（`403 "unauthorized"`，本接口只接受 Cookie 会话）、
跨源 `Origin`（`403 "origin_mismatch"`）都会被守卫拒绝。**不新增迁移，`users` 表结构不变**。

```
{ "currentPassword": string,        // 必填：当前密码
  "username"?: string,              // 可选：新用户名，去首尾空格后 1..100 字符
  "newPassword"?: string }          // 可选：新密码，8..200 字符（不 trim，首尾空格也是密码字符）
```

- 成功：`200 { "ok": true, "reauthenticate": true }`，并清除会话 Cookie。
  **该账号全部会话（含发起本次请求的会话与它的 Bearer 令牌）在同一个事务内被撤销**，客户端必须重新登录。
  账号 `id` / `role` / `daily_limit` 与历史反馈归属都不变；改密码不会扣减额度。
- `username` 与 `newPassword` 都未提供（含只给空白字符串）→ `400 "invalid_request"`；
  `currentPassword` 缺失或非字符串、`username` 超出 1..100、`newPassword` 超出 8..200 → `400 "invalid_request"`。
- 当前密码不正确 → `403 "invalid_current_password"`（凭据与会话都不变）。
- 新用户名已被其它账号占用 → `409 "user_exists"`；唯一性在事务内复查，冲突时整体回滚（用户名与密码都保持原值）。
- 限流：**按管理员 id** 独立计时，10 次 / 15 分钟；超限 `429 "rate_limited"` 并携带 `Retry-After` 头（秒）。
- 任一步失败整体 `ROLLBACK`：用户名与密码都不会出现「只改了一半」的状态。

### 系统更新（仅管理员 Cookie 会话，前缀 /api/admin/system/update）

后台「系统更新」标签用到的三个接口。反馈服务只做**代理与展示**，真正的部署动作全部由独立的 updater
执行器完成（`http://updater:8790`，见 `apps/updater/README.md`）。三个接口都走管理员 Cookie + **严格的同源检查
（读操作也校验 `Origin`）**：普通账号 → `403 "forbidden"`、Bearer 令牌 → `403 "unauthorized"`、
跨源 `Origin` → `403 "origin_mismatch"`。

环境变量（全部可选，缺失即「未接入更新」）：

| 变量 | 规范名 | 说明 |
| --- | --- | --- |
| `FEEDBACK_UPDATER_URL` | ✅ **规范名** | updater 内网地址，默认 `http://updater:8790`。**该名字与 `deploy/compose.prod.yml` 注入的名字一致**；改这里才会真正生效。 |
| `FEEDBACK_UPDATE_URL` | 别名（兼容） | v0.3.0 之前文档用过的旧名字。仅在 `FEEDBACK_UPDATER_URL` 未设置时才被读取；两者同时设置时**规范名优先**。新部署请用规范名。 |
| `FEEDBACK_UPDATE_TOKEN_FILE` | ✅ 规范名 | 共享令牌文件（600 权限），请求头 `x-updater-token`；令牌**绝不**进入日志、响应或前端 |
| `FEEDBACK_UPDATE_CONTROL_DIR` | ✅ 规范名 | 与执行器共享的控制目录（只读挂载）：`paused` 标记与 `state/tasks/*.json` 进度 |
| `FEEDBACK_UPDATE_CHECK_INTERVAL_MS` | ✅ 规范名 | 自动**检查**间隔，默认 24 小时；`0` 关闭自动检查。compose 未注入（缺省即 24 小时），需要时可在 compose 覆盖层或 `.env.prod` 里加 |

> 上表三处变量名与 `deploy/compose.prod.yml` 注入的名字逐一对齐：`FEEDBACK_UPDATER_URL`、
> `FEEDBACK_UPDATE_CONTROL_DIR`、`FEEDBACK_UPDATE_TOKEN_FILE`。规范名之外只保留 `FEEDBACK_UPDATE_URL`
> 一个兼容别名，且已在服务端 `apps/server/src/env.ts` 的 `UPDATE_URL_ENV` / `UPDATE_URL_ENV_ALIAS` 常量里落位。

- `GET /api/admin/system/update` → 当前版本、更新配置、暂停状态、最近一次检查结果、最近任务：
  ```jsonc
  { "current": { "version": "0.3.0", "protocol": 1 },
    "config": { "updateConfigured": true, "updaterBaseUrl": "http://updater:8790", "tokenFile": "…",
                "controlDir": "…", "protocolSupported": 1, "checkIntervalMs": 86400000 },
    "pause": { "paused": false, "since": null, "marker": null },
    "check": { "state": "ok", "checkedAt": "<iso>", "latest": { "version": "0.3.0", "notes": "…",
               "publishedAt": "<iso>", "digest": "sha256:…", "image": "…" },
               "compatible": true, "requiredProtocol": 1, "supportedProtocol": 1, "guidance": null,
               "failedCode": null, "failedMessage": null, "warnings": [] },
    "recentOperations": [ /* 与下面 GET :id 的 operation 同构 */ ] }
  ```
  - `check.state`：`never`（尚未检查）/ `ok`（有新版本）/ `up_to_date` / `incompatible`（执行器协议不兼容）/
    `failed`（检查失败，附 `failedCode` / `failedMessage`）。
  - **检查失败只体现为状态**：updater 不可达、清单缺失或非法、令牌未配置都不会返回 5xx，
    也绝不影响正在运行的服务（业务读写照常）。前端据此显示「检查失败，可稍后重试」。
  - 协议不兼容（清单 `requiredUpdaterProtocol` 高于本服务支持的 `current.protocol`）时 `check.compatible = false`、
    `state = "incompatible"`、`guidance` 给出「先在服务器上手工升级 updater 容器」的指引；版本信息仍正常展示。
- `POST /api/admin/system/update/check` → `200 { "check": 同上的 check 对象 }`：手动触发一次检查（只读，**绝不安装**）。
  自动检查每 `checkIntervalMs` 跑一次，同样只检查、绝不定时自动安装。
- `POST /api/admin/system/update` `{ "requestId": string, "version": string, "digest": string }` →
  `202 { "operationId", "status", "deduplicated" }`
  - **只接受这三个字段**：`composePath` / `composeFile` / `command` / `image` / `volume` / `service` / `project`
    等一律 `400 "invalid_request"`——部署路径、命令、镜像与卷名由执行器按预配置决定，反馈服务不接触也不转发。
  - `version` 必须是 semver、`digest` 必须是 `sha256:<64 位小写十六进制>`，否则 `400 "invalid_request"`。
  - `requestId`（1..128 位 `[A-Za-z0-9._:-]`）用于幂等：同一 `requestId` 重发返回原任务的 `operationId`
    （`deduplicated: true`）；已有任务在执行 → `409 { "error": { "code": "update_in_progress" }, "operationId", "phase" }`。
  - 执行器协议不兼容、清单缺失或版本/digest 与清单不一致 → `409` 并给出原因。
  - 执行器不可达 / 未接入 → `503 "update_executor_unreachable"` / `"update_not_configured"` / `"update_token_unavailable"`，
    其它上游错误 → `502 "update_executor_error"`；**绝不返回 500 堆栈**。
  - 限流：按管理员 id 独立计时，30 次 / 15 分钟（`429 "rate_limited"` + `Retry-After`）。
- `GET /api/admin/system/update/:id` → 任务进度（`operationId` 非法 → `400 "invalid_request"`）：
  ```jsonc
  { "status": "known", "fromControlDir": true,
    "operation": { "operationId": "op-…", "version": "0.3.0", "status": "running",
                   "outcome": null, "outcomeLabel": "更新进行中", "phase": "backup_copy",
                   "phaseLabel": "③保留备份并复制", "message": "…", "failure": null,
                   "recoveryHint": null, "warnings": [],
                   "evidence": [ { "at", "phase", "step", "ok", "detail"? } ] } }
  ```
  - 进度优先读控制目录里执行器逐阶段落盘的任务文件，因此**服务重启期间也能显示进度**。
  - 上游不可达且本地无记录 → `200 { "status": "unreachable", "error": { "code": "updater_unreachable", … } }`：
    这是「正在恢复连接」而**不是**更新失败，前端应继续重试（只有执行器给出的终态才是权威结果）。
  - 上游与控制目录都没有该任务 → `200 { "status": "unknown" }`。
  - `outcomeLabel` 用于区分终态：`succeeded` /「更新失败，未改动部署」（`failed_no_changes`）/
    「更新失败，已恢复旧版本」（`failed_restored`）/「需要处理」（`needs_attention`，附 `failure`、`recoveryHint`
    与 `evidence`）。前端不提供任何自动删除旧镜像或备份卷的入口。

### 更新期间的暂停写入

updater 在执行「②暂停并停服」前会向控制目录写入 `paused` 标记（JSON，含 `phase`/`message`），
反馈服务**只读**读取该标记（`FEEDBACK_UPDATE_CONTROL_DIR`），并据此：

- 拒绝新的业务写入：`POST /api/feedback` 以及管理侧写操作（`PATCH /api/admin/me`、账号/软件配置/连接配置）
  统一返回 `503 "update_paused"`，`message` 带上执行器给出的阶段说明。
- worker **不取队、不处理**：更新期间零 Kaneo/AI 调用（队列保留在内存，解除暂停后自动继续）。
- 读操作（后台读进度、反馈状态查询）始终可用；**系统更新自己的检查入口显式豁免**，
  避免暂停标记残留时后台无法自愈。
- `paused` 标记按短 TTL 缓存读取；文件缺失即视为未暂停，控制面异常**绝不**阻断业务写入。
- 解除暂停 = 执行器删除 `paused` 文件（`unlink` 原子），反馈服务随后自动恢复写入与 worker。

## 反馈组

### POST /api/feedback （Bearer 或 Cookie）
```jsonc
{
  "idempotencyKey": "client-generated uuid",   // 必填，≤200 字符
  "appId": "com.example.app",                   // 必填，须已在服务端配置
  "text": "用户原话",                            // 必填，1..10000 字符（按码点计）
  "context": {                                   // 可选，全部由宿主显式传入
    "appVersion": "1.2.3",
    "pageLabel": "settings/account"
  }
}
```
响应（均带 `user: { id, username, role }` 与 `quota`）：
- `201 { "feedbackId": string, "status": "received", "user", "quota" }`
- `200 { "feedbackId", "status", "replayed": true, "user", "quota" }`（同 key 同内容，幂等重放；**不扣次数**，额度已满也允许）
- `409 "idempotency_conflict"`（同 key 不同内容；或同 key 被**其他账号**占用 —— 统一通用冲突，不透露原记录）
- `429 "daily_quota_exceeded"`（当日额度用尽，明确**未接收**；响应携带同结构 `quota`）
- `401` / `400 "invalid_request"` / `404 "unknown_app"` / `413 "too_large"` / `429 "rate_limited"`

**multipart 变体**（携带截图与/或日志附件）：`Content-Type: multipart/form-data`，总请求体上限 10 MiB。
- 字段 `metadata`：同上 JSON，另加可选 `capture`（截图元数据）与可选 `logs`（日志附件描述符数组）。
- 字段 `screenshot`（可选）：PNG 文件（上限 2048px / 400 万像素 / 5 MiB）。
- 字段 `logs`（可选，可重复）：日志文件二进制流（多部分字段名均为 `logs`，按顺序与 `metadata.logs` 描述符一对一对应）。

`capture` 仅接受白名单字段，全部可选：

| 字段 | 类型 | 说明 |
|---|---|---|
| `viewportWidth` / `viewportHeight` | number | 捕获时的**逻辑 CSS 视口**尺寸 |
| `pixelWidth` / `pixelHeight` | number | 最终 PNG 的**实际输出像素**尺寸（1..65535 整数，成对出现；与逻辑视口区分；旧客户端可缺省） |
| `capturedAt` | string | 截图时间 |
| `releasePoint` | `{x,y}` | 0..1 归一化落点 |

未知字段忽略；输出像素出现但不完整或不是 1..65535 整数时整条请求 `400 "invalid_request"`。早期实现曾接受 `outputWidth`/`outputHeight` 作为同一字段的别名，命名定稿后已作废：现按未知字段忽略，规范名只有 `pixelWidth`/`pixelHeight`。AI 归档提示优先使用输出像素尺寸，逻辑视口仅作回退。服务端另行测量并持久化真实 PNG 尺寸（管理端 `screenshot.width/height` 为准），PNG 本身仍受 2048px / 400 万像素 / 5MiB 限制。

`metadata.logs` 数组（可选）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `filename` | string | 文件名（仅基名，禁止包含路径分隔符），扩展名仅限 `.log`, `.txt`, `.json`, `.jsonl` |
| `source` | `"auto"` \| `"manual"` | 来源（组件/宿主自动采集 或 用户手动选择） |
| `sha256` | string | 文件内容的 SHA-256 十六进制摘要（64 位小写） |

日志附件校验规则（违规整条请求拒绝，零落盘且不扣减额度）：
- 数量：每个反馈至多 3 份日志文件，超出返回 `400 "invalid_log"`。
- 单文件体积：单份日志不得为空（0 字节）且不得超过 1 MiB（1,048,576 字节），超出返回 `413 "too_large"`。
- 格式与编码：仅限 `.log`, `.txt`, `.json`, `.jsonl` 扩展名，且内容必须为有效 UTF-8 文本编码，非法格式/编码返回 `400 "invalid_log"`。
- 完整性：二进制部分的 SHA-256 必须与 `metadata.logs` 中的 `sha256` 完全一致，且部分数量与描述符数量必须严格一致，否则返回 `400 "invalid_log"`。
- 幂等判定：请求内容哈希综合计算 `text`、`context`、`screenshot` 与全部 `logs` 的摘要。日志内容发生任何改变即视为新内容；相同幂等键再次提交相同内容触发幂等重放（`200`，`replayed: true`）。

### GET /api/feedback/:id （Bearer 或 Cookie）
`200 { "id", "status", "createdAt", "updatedAt", "errorSummary"?: string|null, "kaneoUrl"?: string|null }`
**归属隔离**：普通账号只能读取自己的反馈状态与截图，他人记录统一 `404 "not_found"`（不透露存在性）；管理员可读全量。面板轮询此端点（建议 2s 退避至 5s）。

### POST /api/feedback/:id/retry （仅 Cookie 会话，管理页）
将 `failed` 重新入队（AI 失败→从 processing 恢复；归档失败→从 archiving 恢复）。
Body 可选 `{ "expectedRevision": number }`（恢复数据 revision 乐观锁；缺省不校验）。
`202 { "ok": true, "status": "processing", "revision": number }`；
非法状态 `409 "invalid_state"`；该反馈正在被其他操作处理 → `409 "busy"`；revision 不一致 → `409 "revision_conflict"`（过期页面不得覆盖新状态，请刷新）。

> retry 不返回 `409 "target_changed"`：若该记录的恢复数据已固定归档目标，而当前 Kaneo 配置已不再指向该目标，请求仍返回 `202`，但后台处理会**零远端写入**停止并把记录置为 `needs_review`（`error_summary` 含“归档恢复目标已改变”）。返回 `409 "target_changed"` 的是 `resolve` / `recover` 的同步入口（见 `target_changed` 小节）。

### POST /api/feedback/:id/resolve （仅 Cookie 会话，管理页，针对 needs_review）
```jsonc
{ "action": "recheck" }        // 优先已有 task ID（不重复搜索、不重置阶段）；无 task ID 才按反馈 ID 标记搜索；找到→继续归档，否则维持 needs_review
{ "action": "force-create" }   // 仅允许"任务创建结果未知且无任何已知 task/附件状态"的记录；已有 task ID 或已知上传/资产/评论状态一律 409
```
Body 可选 `{ "expectedRevision": number }`。`202 { "ok": true, "status": ..., "revision": number }`；错误语义同 retry（含 `409 "busy"` / `409 "revision_conflict"`）；归档目标已改变 → `409 "target_changed"`（见下）。

### 409 target_changed （归档目标与当前 Kaneo 配置不一致）

首次远端写入前，服务端会把当时的归档目标固定进恢复数据（`archive_data_json.target`：`apiBase`、`projectId`、`workspaceId`）。此后人工恢复入口会先向**当前配置**的 Kaneo 查询该项目，再把解析出的目标与已保存目标逐字段比对（`apiBase` → `projectId` → `workspaceId`）；任一字段不同即返回：

```jsonc
409 { "error": {
  "code": "target_changed",
  "message": "归档目标与当前 Kaneo 配置不一致，已停止远端操作且未改动恢复数据。请先改回原目标或人工处理该记录。（已保存的归档目标与当前配置不一致（<字段名>），已停止远端操作，恢复数据原样保留）"
} }
```

- 触发入口（同步返回该错误）：`resolve` 的 `recheck` / `force-create`，`recover` 的 `retry_comment` / `replace_upload`。**`POST /api/feedback/:id/retry` 不返回该错误**（见上文：它在后台转为 `needs_review`）。
- 语义保证：**零远端写入**（不创建任务、不上传、不登记资产、不发评论），且**未改动恢复数据**（已保存的 `target` / `upload.key` / `asset` / `comment` / `replacedKeys` 原样保留，`kaneo_task_id` 不变）；记录状态不变（仍为 `needs_review`），刷新详情后同一动作即可再次尝试。
- 处置：改回原 Kaneo 地址/项目/工作区后重试该动作，或依据留存的 key 与资产线索人工处理。**改配置不会把旧记录重定向到新目标**——旧记录一律在此停下等待人工判断。

### POST /api/feedback/:id/recover （仅 Cookie 会话，管理页；针对 needs_review 的分阶段恢复）
```jsonc
{ "action": "retry_comment",  "expectedRevision": number }  // 针对评论：先查重；命中→补记确认并归档，未命中→发送**至多一条**评论
{ "action": "replace_upload", "expectedRevision": number }  // 针对图片：先经鉴权资产下载核对真实字节（一致则不替换）；替换复用原 task、保留旧 key 恢复记录（replacedKeys）、不自动删远端对象；替换成功后才发新评论
```
`expectedRevision` 必填。`202 { "ok": true, "status": ..., "revision": number, "replaced"?: boolean, "note"?: string }`；
`400 "invalid_request"`（缺 expectedRevision / 非法 action）；`409 "busy"` / `"revision_conflict"` / `"invalid_state"` / `"target_changed"`；远端读取/写入失败 → `502 "recover_failed"`（状态不变，不触发替代写入）。

**`retry_comment`（唯一允许重发评论的动作）**
- 发送前先按「反馈 ID + 截图摘要 + 当前资产引用」查询远端评论：命中 → 只补记 `comment.outcome = "confirmed"` 并归档（**零远端写入**）；未命中 → 发送**至多一条**评论。
- 发出前先落盘 `comment.outcome = "maybe_sent"`，落盘失败则绝不发出请求；发送后再次查重，命中即记 `confirmed` 并归档，未命中则记 `maybe_sent` 并维持 `needs_review`。
- **仍可能产生重复评论**：查重（读取远端列表）与写入之间存在竞态，两个操作人同时重发、或上一次写入已到达 Kaneo 但列表尚未可见时都会漏判。操作人必须在 Kaneo 中复核评论数量。管理页在确认框中提示同一风险。
- `retry`、`recheck`、后台恢复等自动路径**绝不**因为“查重没查到”就重发评论：遇到 `maybe_sent` / `confirmed` 一律停止并维持 `needs_review`。`recheck` 本身只读取远端并确认（零远端写入）；仅当恢复数据记录评论**确实从未发送**（`not_sent` 或缺失）且核对未命中时，才交回正常归档流程从断点继续（见下方结果语义）。

**`replace_upload`（唯一可以替换图片的动作）**
- 复用**原 Kaneo 任务**，向 Kaneo 申请**新**上传地址并上传本地原图，然后 `finalize` 新 key 为资产并发送新评论。
- 替换前若资产已知，会经鉴权下载比对真实字节：**一致 → 不替换**（返回 `replaced: false`），仅核对；核对失败（含 404）不能证明文件不存在，按管理员决定继续替换。
- 被替换的旧 key 记入 `replacedKeys`（最多保留 20 条），旧 key 与旧资产线索保留可追溯；**不删除远端对象**，远端残留文件需人工清理。
- **上传地址过期**（`upload.expiresAt` 已过）与**同 key 重传被业务拒绝**这两种情况，自动路径**不会**申请新上传地址：记录转入 `needs_review`，`error_summary` 分别含“过期”“同 key”，原始 key 与 `expiresAt` 完好保留；`replace_upload` 是唯一出路。自动路径对同一 key 只做「重传相同字节」的安全恢复，累计上限 3 次。
- **第三种情况：完全没有 upload 记录**（申请地址的请求在途时进程中断，本地还没来得及落盘）。此时自动路径**会**重新申请一个上传地址，不转 `needs_review`。这是安全的，判据是**落盘顺序**：上传记录与 `maybe_sent` 都先落盘、之后才发 PUT 字节，所以“没有记录”蕴含“字节从未发出”，远端不可能存在该次上传的对象——被丢弃的只是一个未被使用过的预签名地址（该地址本身可能在 Kaneo 侧被分配过，但没有对象产生）。因此三种情形的分界是「**远端是否可能已存在该次上传的对象**」：可能（有记录）→ 绝不换 key；不可能（无记录）→ 允许重新申请。

### 恢复数据写入结果语义（`upload.outcome` / `comment.outcome`）

`archive_data_json` 的 `upload.outcome` 与 `comment.outcome` 取值恒为下列三者之一（管理页对应 `recovery.uploadOutcome` / `recovery.commentOutcome`）：

| 取值 | 含义 | 可再自动发送？ |
|---|---|---|
| `not_sent` | 该次写入**确定未离开进程**（尚未发出，或被远端明确拒绝） | 可：自动路径可重新发送 |
| `maybe_sent` | 写入已发出但**结果未知**（超时/断连/进程崩溃）。因在请求离开进程前先落盘，其含义是“**可能已到达 Kaneo**” | **否**：自动路径不重发，需人工动作（评论走 `retry_comment`，图片走 `replace_upload`） |
| `confirmed` | 已收到远端成功响应并持久化 | 否：只做 finalize/核对，绝不重传 |

- **`maybe_sent` 不会被降级为 `not_sent`**。服务端在评论 POST / 图片 PUT 离开进程前先持久化 `maybe_sent`，仅在远端**明确拒绝**（确定未创建）时才改写为 `not_sent`。因此 `maybe_sent` 绝不可当作“未发送”处理。
- 旧记录/缺少可靠发送证据的恢复数据一律按**未知**处理，绝不视为“未发送”。
- 因此 `retry`、`recheck`、后台恢复在遇到 `maybe_sent` / `confirmed` 且查重未命中时**停止自动处理并维持 `needs_review`**，保留全部线索等待人工判断——这样不会产生第二条评论。

### 管理页允许动作
`GET /api/admin/feedback/:id` 详情返回
`recovery: { revision, stage, uploadOutcome, assetKnown, commentOutcome, hasScreenshot, allowedActions, actionTargets, actionNotes }`：
- `hasScreenshot`：该记录是否存有本地截图（等价于 `screenshot !== null`）。列表项 `GET /api/admin/feedback` 也返回该字段；
- `actionTargets: Record<string, string>`：动作目标说明（`retry` 处理流程、`recheck` 任务核对、`force-create` 任务创建、`retry_comment` 评论、`replace_upload` 图片）；
- `actionNotes: Record<string, string>`：动作风险说明（人类可读，供管理页在点击前展示），当前为 `retry_comment`（查重后仍可能重复的竞态）、`replace_upload`（申请新地址替换、旧对象不自动删除）、`recheck`（只读确认，不重发）、`force-create`（可能产生重复任务）。
管理页只渲染 `allowedActions` 中的按钮并在标题注明动作目标与风险；`retry_comment` 必须附带上述重复风险提示。放行条件：
- `failed` → `retry`；
- `needs_review` → `recheck` 恒可用；已有 task ID **且** 资产已知 → `retry_comment`；已有 task ID **且** 有截图（`hasScreenshot`）→ `replace_upload`（**上传地址过期/被拒绝时的唯一出路，不要求资产已知**）；仅当任务创建结果未知且无任何已知 task/附件状态 → `force-create`。

### 旧记录兼容（4.5）
- 旧文字反馈原路径；旧 `archived` 记录为终态不重开；不批量改写现有数据库。
- 仅含 `assetUrl` 的旧记录：恢复时先经鉴权下载接口核对真实字节（与本地截图 SHA-256 比对），一致才补齐恢复信息；核对失败/字节不一致 → `needs_review` 待人工核对，不猜测重建。
- 恢复数据损坏 / 版本未知 / 阶段与恢复数据矛盾 → `needs_review`，新格式保存前做版本检查（revision 乐观锁）。

## 软件配置组（仅 Cookie 会话，前缀 /api/admin/apps）

App 对象：
```jsonc
{
  "id": string,
  "appId": "com.example.app",        // 提交时携带的唯一标识，创建后不可改
  "name": "示例软件",
  "allowedOrigins": ["https://app.example.com"],  // Web 登录握手允许的 origin，精确匹配
  "kaneoProjectId": "proj-xxx",      // 目标 Kaneo 项目
  "kaneoColumnSlug": "backlog",      // 目标列的真实 slug，服务端在归档时解析为列 id
  "createdAt": "<iso>", "updatedAt": "<iso>"
}
```
- `GET /api/admin/apps` → `{ "apps": [App] }`
- `POST /api/admin/apps`（同字段）→ `201 App`；重复 appId → `409 "app_exists"`
- `PUT /api/admin/apps/:id`（`appId` 字段被忽略）→ `200 App`
- `DELETE /api/admin/apps/:id` → `204`（历史反馈保留）

## 连接配置组（仅 Cookie 会话）

### Kaneo
- `GET /api/admin/connection/kaneo` → `{ "baseUrl": string|null, "clientUrl": string|null, "apiKeySet": boolean }`（密钥永不回传明文，仅 `apiKeySet`；`clientUrl` 为任务链接基址，留空时默认取 `baseUrl` 去掉 `/api` 后缀）
- `PUT /api/admin/connection/kaneo` `{ "baseUrl", "clientUrl"?: string, "apiKey"?: string }`；省略或传空 `apiKey` 表示保持原值。
- `POST /api/admin/connection/kaneo/test` `{ "projectId": string }` → `{ "ok": true, "project": { "id", "name", "workspaceId", "slug" }, "columns": [{ "id", "slug", "name" }] }` 或 `502 { ok:false, "reason": string }`（用于配置界面选列并保存真实 slug；创建任务时 `status` 即列 slug）。

### AI（OpenAI 兼容，Chat Completions）
- `GET /api/admin/connection/ai` → `{ "baseUrl": string|null, "model": string|null, "apiKeySet": boolean }`
- `PUT /api/admin/connection/ai` `{ "baseUrl", "model", "apiKey"?: string }`
- `POST /api/admin/connection/ai/test` → `{ "ok": true, "reply": "ping 回显" }` 或 `{ "ok": false, "reason": string }`

密钥以部署环境提供的主密钥（`FEEDBACK_MASTER_KEY`）做 AES-256-GCM 加密后存 SQLite；日志不记录反馈原文、密码或令牌。

## 管理列表组（仅 Cookie 会话）

- `GET /api/admin/feedback?status=&appId=&cursor=&limit=50` →
  `{ "items": [{ "id", "appId", "username": string|null, "status", "createdAt", "updatedAt", "title"?: string|null, "kaneoUrl"?: string|null, "errorSummary"?: string|null, "archiveStage"?: string|null, "hasScreenshot": boolean, "logCount": number }], "nextCursor": string|null }`
  （`username` 为提交账号；旧记录归属迁移前的初始账号；`logCount` 为该记录附带的日志文件数量）
- `GET /api/admin/feedback/:id` → 详情：以上字段 + `{ "username", "text", "processed"?: { "title", "sections": { "experience", "problems", "suggestions", "questions" } }, "kaneoTaskId"?, "attemptCount", "lastError"?, "context"?, "screenshot"?, "logs": Array<{ "id", "feedbackId", "sortOrder", "filename", "source", "byteSize", "sha256", "createdAt" }>, "recovery"? }`，其中 `screenshot` 为截图元数据（`width`/`height`/`byteSize`/`sha256`/`capture`/`createdAt`，无截图则为 `null`；PNG 本体经 `GET /api/admin/feedback/:id/screenshot` 取回），`logs` 为该记录有序排列的日志附件元数据列表，`recovery` 见「管理页允许动作」。
- `GET /api/admin/feedback/:id/logs/:logId/download` → 下载日志原始文件，`Content-Type: application/octet-stream`，附带标准 RFC 5987 / RFC 6266 `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` 标头。
- `GET /api/admin/feedback/:id/logs/:logId/preview` → 在浏览器内直接预览纯文本日志内容，`Content-Type: text/plain; charset=utf-8`，`Content-Disposition: inline`。
- `GET /api/admin/feedback/:id/logs/:logId` → 便捷预览路由，行为等价于 `/preview`。

## 面板内登录（Web 组件 / Flutter，当前方式）

1. 未登录也可在面板内编辑反馈文字与截图；点击主按钮「登录并提交」。
2. 面板**就地展开**账号密码表单（同一个主按钮文案为「登录并提交」），不打开任何窗口。
3. 确认后调用 `POST /api/auth/login`，显式携带 `clientLabel`（Web 为 `web:<appId>`，Flutter 为 `flutter-<平台>-<时间>`）
   与 `appId`；浏览器请求由服务端按该 `appId` 的 `allowedOrigins` 校验 `Origin`。
4. 成功后令牌仅存内存（Web / Flutter Web）或安全存储（原生 Flutter），立即提交一次；取消只收起表单，草稿保留。
5. 打开面板、登录成功、提交完成与应用恢复前台时刷新额度；跨过 `resetAt` 后重新查询，不在本地擅自重置。
   剩余 0 次禁止新提交，但结果未知的同键请求仍允许重试（避免丢失已接收结果）。

密码不持久化、不进入反馈或截图、不写日志，登录结束即清空。

### 旧登录窗口握手（兼容保留）

服务端仍保留 `/login` + `/api/auth/handshake` 供既有集成使用：登录页校验 `cb` origin 在 appId 的 `allowedOrigins` 内后
`postMessage({ type: "feedback:auth", nonce, accessToken, expiresAt })`；组件校验 `event.origin` 与 `nonce`。
握手令牌绑定当前登录用户。新集成请使用上面的面板内登录。

## 客户端公开参数（Web / Flutter 共用）

| 参数 | 必填 | 说明 |
|---|---|---|
| `apiBase` | 是 | 服务地址，如 `https://fb.example.com` |
| `appId` | 是 | 服务端软件配置中登记的标识 |
| `appVersion` | 否 | 展示在 Kaneo 任务来源信息 |
| `pageLabel` | 否 | 宿主显式传入的页面标识 |

目标 Kaneo 项目由服务端按 appId 决定，客户端不可指定。

## 跨源（CORS）

宿主应用与反馈服务通常不同源。`/api/feedback*` 与 `/api/auth/*`（登录、会话查询、退出）仅接受 **Bearer** 类凭据参与跨源：
服务端只对已在任一软件配置 `allowedOrigins` 中登记的 Origin 回显 CORS 头（含 OPTIONS 预检），不使用跨站 Cookie。
登录还会按目标 `appId` 的 `allowedOrigins` 校验 `Origin`。管理接口仍限第一方同源 Cookie。Flutter 原生（非浏览器）不受 CORS 约束。
