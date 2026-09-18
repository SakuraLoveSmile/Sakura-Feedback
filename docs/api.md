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

## 契约稳定性

本节界定接入方可以依赖的**稳定面**。组件侧（Web 属性 / 方法 / 事件、Flutter 导出符号）的
对应口径见 [`docs/integration.md`](integration.md) §1.7；逐版本变更见根目录
[`CHANGELOG.md`](../CHANGELOG.md)。

**稳定面（非破坏性变更中保证不变）**

- 客户端实际用到的端点路径、HTTP 方法与认证类别：`POST /api/feedback`、
  `GET /api/feedback/:id`、`GET /api/feedback/:id/screenshot`、`POST /api/auth/login`、
  `GET /api/auth/session`、`POST /api/auth/logout`。
- 错误信封 `{ "error": { "code", "message" } }` 与本文档已列出的 `code` 取值；
  `message` 措辞可随版本调整，不作为判等依据。
- 幂等语义：同一 `idempotencyKey` + 相同内容 → `200` 重放；同 key 不同内容 →
  `409 idempotency_conflict`。
- multipart 部件名：`metadata` / `screenshot` / `logs`；已文档化的请求与响应字段名和类型；
  `status`、`collectionState` 既有取值的含义。

**兼容变更（任何版本都可能出现，客户端必须容忍）**

- 响应 JSON 新增字段、请求新增可选字段、新增端点、枚举**新增取值**
  （`status` / `collectionState` 只增不减；遇到未知取值请按最保守分支展示，不得当作解析失败）、
  校验放宽与缺陷修复。

**破坏性变更（只在 CHANGELOG 标注「破坏性」的版本中出现）**

- 删除 / 重命名端点或字段、改变字段类型或语义、移除枚举取值、收窄既有上限
  （如缩短 `text` 长度或降低图片限制）、改变认证方式或幂等语义，以及行为反转
  （如「提交成功是否触发远端归档」这类语义翻转）。

**不属于契约面（可随时变）**

- 管理页 UI 与内部页面结构、数据库表结构与迁移编号、本文档未列出的字段与端点、
  错误 `message` 的具体措辞。标注「兼容保留」的旧入口（如 `/login` + `/api/auth/handshake*`）
  保留期间可用，但可能在未来版本移除；移除会写入 CHANGELOG。

## 状态机（反馈记录）

> **人工分类归档改造（v6）**：提交成功**不再授权远端归档**。后台只做 AI 内容整理，
> 整理完成（成功或失败）后记录停在 `needs_info`，等待管理员在管理页完成分类；只有管理页的
> 「保存并归档」写入持久化归档授权后，worker 才会执行**首次远端写入**。
>
> **先接收、后配置、自动归档（v7）**：软件不必事先登记——首次有效提交会**自动发现**一条待配置软件；
> 来源逐条记录（待确认/已确认）。管理员配置规则并**显式启用**自动归档后，满足
> 「自动模式 + 来源已确认 + 规则完整有效」的记录由**自动授权入口**（与人工归档同一事务、同一快照）
> 进入归档流程；其余记录保持「已接收」并写明等待/阻塞原因。

| status | 含义 | 后继 |
|---|---|---|
| `received` | 原话已持久化，等待 AI 整理 | `processing` |
| `processing` | AI 整理中（或人工重试中） | `needs_info` / `archiving` |
| `needs_info` | 等待人工补充分类（缺项目/列/标签） | `ready_to_archive` / `processing` |
| `ready_to_archive` | 分类完整，等待人工归档授权（**零远端写入**） | `archiving` |
| `archiving` | 已持久化人工归档授权，创建请求已发出或待发 | `archived` / `needs_review` / `failed` |
| `needs_review` | Kaneo 写入结果不确定，待核对 | `archived` / `archiving` |
| `archived` | 已写入 Kaneo，终态 | — |
| `failed` | 归档**明确失败**（AI 失败不算 failed，见下），可重试 | `processing` / `archiving` |

- AI 整理失败：**不再置为 `failed`**。保留原文，标题回退为原文首个非空行，`processed_json` 保持 NULL，
  `error_summary` 说明回退原因；状态进入 `needs_info`。管理页 `retry` 会重新尝试 AI 整理（绝不触发未授权的远端归档）。
- 老版本遗留记录（`received`/`processing`，从未发生远端写入）在迁移 6 中接入人工流程（→ `needs_info`）；
  已有 `failed`/`needs_review` 不自动重跑；已开始远端写入（已有 task ID 或恢复数据含上传/资产/评论痕迹）的记录
  保留原目标与恢复上下文，只能沿既有恢复入口继续。

面板向用户展示的文案（Web 组件 `packages/web/src/element.ts`，Flutter 包文案不同）：
`received` / `processing` / `needs_info` / `ready_to_archive` / `archiving` → 「已保存，正在整理」；
`archived` → 「反馈已归档。感谢你的支持！」；
`needs_review` → 「归档结果待确认。原话已保存，将在管理页人工复核。」；
`failed` 但服务端已接收 → 「原话已保存，后台整理未完成，可在管理页处理。请勿重复提交。」；
提交未到达服务（无服务端记录）→ 「尚未确认保存，请检查网络后重试。」。
**注意**：状态值本身（`received` 等）只出现在 HTTP 契约里，不作为用户可见文案。

v7 起组件还会按 `collectionState` 覆盖「已保存，正在整理」这句文案（等待态优先，且停止轮询）：
- `waiting_configuration` → 「反馈已保存，等待管理员配置该软件。」
- `waiting_source_confirmation` → 「反馈已保存，等待管理员确认来源。」
- `waiting_manual_archive` → 「反馈已保存，等待管理员归档。」
这些提示都表示**已保存**，不是提交失败；`queued` 仍按「已保存，正在整理」继续跟踪。

## 认证组

### POST /api/auth/login
Body: `{ "username": string, "password": string, "clientLabel"?: string, "appId"?: string }`
- 无 `clientLabel`（管理后台 / 旧登录页）：`200 { "ok": true, "expiresAt": "<iso>", "user", "quota" }` + Set-Cookie；不返回令牌。
- 有 `clientLabel`（Web 组件 / Flutter）：必须携带**格式合法**的 `appId`（1..100 字符，仅字母数字与 `. _ : -`），
  否则 `400 "invalid_request"`。**不再要求软件已登记**：登录只校验账号、启用状态与限流，
  浏览器携带的 `Origin` 只做合法性校验（非法如 `file://` → `400 "origin_not_allowed"`），不再比对允许来源白名单。
  **登录本身不创建任何软件记录**——软件在首次有效提交时自动发现。
  原生客户端不发送 `Origin`。成功返回 `200 { "ok": true, "token": "<bearer，仅此一次明文返回>", "expiresAt", "user", "quota" }`（不附带 Cookie）。
- 旧登录握手（`/login` + `/api/auth/handshake*`）**保持原有安全限制**：仍要求软件已登记且来源在 `allowedOrigins` 内。
- 账号不存在 / 已禁用 / 密码错误统一 `401 "invalid_credentials"`；限流后 `429 "rate_limited"`（`Retry-After` 头）。
- 限流：按 IP+用户名滑动窗口。组件端点的登录、会话查询、退出支持跨源 Bearer（CORS，见文末），不依赖跨站 Cookie。

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

后台「系统更新」标签用到的两个接口。**v0.5.1 起只做版本检查，不提供安装**：
服务端直接拉取 GitHub Release 的 `release-manifest.json` 并与本机版本比较；
更新动作在服务器上手动执行（`deploy/update.sh`）。两个接口都走管理员 Cookie +
**严格的同源检查（读操作也校验 `Origin`）**：普通账号 → `403 "forbidden"`、
Bearer 令牌 → `403 "unauthorized"`、跨源 `Origin` → `403 "origin_mismatch"`。

环境变量（全部可选）：

| 变量 | 说明 |
| --- | --- |
| `FEEDBACK_UPDATE_MANIFEST_URL` | 版本清单地址，默认稳定渠道 Release 的 `release-manifest.json`；`off` / `none` / `disabled` 显式关闭检查功能（接口仍可用，检查固定返回 `manifest_not_configured`） |
| `FEEDBACK_UPDATE_CHECK_INTERVAL_MS` | 自动**检查**间隔，默认 24 小时；`0` 关闭自动检查（仍允许手动检查） |

- `GET /api/admin/system/update` → 当前版本、检查配置、最近一次检查结果：
  ```jsonc
  { "current": { "version": "0.5.1" },
    "config": { "manifestUrl": "https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json",
                "checkIntervalMs": 86400000 },
    "check": { "state": "ok", "checkedAt": "<iso>", "source": "<manifestUrl>",
               "latest": { "version": "0.6.0", "tag": "v0.6.0", "notes": "…",
                           "publishedAt": "<iso>", "digest": "sha256:…",
                           "image": "ghcr.io/…", "releaseUrl": "https://github.com/<owner>/<repo>/releases/tag/v0.6.0" },
               "failedCode": null, "failedMessage": null } }
  ```
  - `check.state`：`never`（尚未检查）/ `ok`（有新版本）/ `up_to_date`（清单版本 ≤ 当前版本）/
    `failed`（检查失败，附 `failedCode` / `failedMessage`）。
  - **检查失败只体现为状态**：清单不可达（`manifest_unreachable`）、HTTP 非 200（`manifest_http_error`）、
    清单非法（`manifest_bad_response`）、功能被关闭（`manifest_not_configured`）都不会返回 5xx，
    也绝不影响正在运行的服务。前端据此显示「检查失败，可稍后重试」。
  - 检查结果缓存在 `FEEDBACK_DATA_DIR/update-check.json`，重启后仍可展示上次结果。
- `POST /api/admin/system/update/check` → `200 { "check": 同上的 check 对象 }`：手动触发一次检查（只读，**绝不安装**）。
  自动检查每 `checkIntervalMs` 跑一次，同样只检查。
  - 限流：按管理员 id 独立计时，30 次 / 15 分钟（`429 "rate_limited"` + `Retry-After`）。

> v0.5.1 前的接口 `POST /api/admin/system/update`（发起更新）与 `GET /api/admin/system/update/:id`
> （任务进度）已随 updater 执行器一并移除，调用会返回 `404 "not_found"`；
> 更新期间的 `update_paused` 暂停写入机制同样已移除。

## 反馈组

### POST /api/feedback （Bearer 或 Cookie）
```jsonc
{
  "idempotencyKey": "client-generated uuid",   // 必填，≤200 字符
  "appId": "com.example.app",                   // 必填；**无需预先登记**（首次提交自动发现）
  "appName": "我的应用",                         // 可选；仅当管理员尚未设置名称时采用
  "text": "用户原话",                            // 必填，1..10000 字符（按码点计）
  "context": {                                   // 可选，全部由宿主显式传入
    "appVersion": "1.2.3",
    "pageLabel": "settings/account"
  }
}
```
响应（均带 `user: { id, username, role }` 与 `quota`）：
- `201 { "feedbackId": string, "status": "received", "user", "quota", "collectionState" }`
- `200 { "feedbackId", "status", "replayed": true, "user", "quota", "collectionState" }`（同 key 同内容，幂等重放；**不扣次数**，额度已满也允许）
- `409 "idempotency_conflict"`（同 key 不同内容；或同 key 被**其他账号**占用 —— 统一通用冲突，不透露原记录）
- `429 "daily_quota_exceeded"`（当日额度用尽，明确**未接收**；响应携带同结构 `quota`，**不创建软件、不扣费**）
- `410 "gone"`（该 `idempotencyKey` 曾对应的反馈已被管理员**彻底删除**；命中最小删除凭据，不新建、不扣次）
- `401` / `400 "invalid_request"` / `400 "origin_not_allowed"` / `413 "too_large"` / `429 "rate_limited"`

**先接收、后配置（自动发现软件）**：`appId` 不再要求事先在后台登记。
首次**有效**提交时，服务端在同一事务内创建一条**待配置**软件（默认人工模式、零归档规则），
并登记本次观察到的来源。幂等重放、额度用尽、校验失败都不会产生空软件记录。
并发提交同一 `appId` 只会创建一条软件记录（写事务串行 + `app_id` 唯一约束）。

**软件名称**：可选字段 `appName`（≤100 字符）。仅在管理员尚未设置名称时采用；管理员在后台保存过名称后，
客户端上报的名称不会覆盖它（该软件的 `nameSource` 变为 `admin`）。

**服务端观察到的来源**：浏览器取请求 `Origin`（规范化到 `scheme://host[:port]`）；
无 `Origin` 的原生客户端记为 `native`，单独确认。客户端**自报**的名称与来源都不作为软件身份凭证。

`collectionState`（可选字段，旧客户端可忽略）：反馈当前卡在哪一步，见下节。

### 收集状态 `collectionState`

组件据此显示「已保存，等待…」，**绝不把等待归档显示为提交失败**。取值与优先级：

| 值 | 含义 | 判定 |
|---|---|---|
| `queued` | 会自动处理（继续跟踪） | 已授权（人工或自动）或已有远端任务；或**自动模式 + 来源已确认 + 该记录未被人工编辑**（整理中 / 等待自动重试）。已授权 / 已有远端任务优先级最高，等待配置不会覆盖它 |
| `waiting_configuration` | 等待管理员配置软件 | 软件 `configStatus = pending`；或自动模式下该记录被**配置类**问题阻塞（规则不完整 / 目标失效），等待管理员修正 |
| `waiting_source_confirmation` | 等待管理员确认来源 | 自动归档模式，且该记录的来源仍是「待确认」 |
| `waiting_manual_archive` | 等待管理员人工归档 | 人工模式（含自动归档已关闭）；或自动模式下该记录**已被人工作业**（`classifyVersion > 0` 或存在编辑留痕，含未授权的 `ready_to_archive`） |

POST 提交与 `GET /api/feedback/:id` 响应都会带上该字段（`GET` 按当前状态现算）。
组件在收到等待态后应停止轮询并保留手动刷新——等待不是「处理中」。
自动模式下「等待自动重试」属于 `queued`（组件继续跟踪），**不得**显示为等待人工归档。

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
`200 { "id", "status", "createdAt", "updatedAt", "errorSummary"?: string|null, "kaneoUrl"?: string|null,
"collectionState"?: string }`
**归属隔离**：普通账号只能读取自己的反馈状态与截图，他人记录统一 `404 "not_found"`（不透露存在性）；管理员可读全量。面板轮询此端点（建议 2s 退避至 5s）；收到等待态时停止轮询、保留手动刷新。
**已彻底删除**：记录被管理员永久删除后，所属账号查询返回 `410 "gone"`；其他账号仍返回 `404`（不泄露存在性）。截图/日志端点同理。

### GET /api/admin/feedback/options?projectId=&lt;id&gt; （仅管理员 Cookie 会话）
从 Kaneo **实时**读取分类所需的有效选项。
`200 { "project": { "id", "name", "workspaceId" }, "columns": [{ "id", "slug", "name" }],
"labels": [{ "id", "name", "color" }], "members": [{ "id", "name", "email", "role" }] }`。
- `labels` 只包含**工作区级**标签（`taskId === null`）：关联到任务时 Kaneo 会新建任务级标签行，
  不会移动其他任务上的标签。
- 缺 `projectId` → `400 "invalid_request"`；Kaneo 读取失败 → `502 "kaneo_unavailable"`。

### POST /api/admin/feedback/:id/classify （仅管理员 Cookie 会话 + 同源）
人工分类保存与归档授权（T2/T3 的唯一入口）。
```jsonc
{
  "action": "save" | "archive",
  "classifyVersion": 0,          // 乐观锁：必须等于页面读到的 classification.version
  "projectId": "…" | null,
  "columnId": "…" | null,
  "columnSlug": "…" | null,
  "labelIds": ["…"],
  "assigneeId": "…" | null,      // 可选负责人
  "assigneeName": "…" | null,
  "operationId": "…"             // 归档授权必填（缺省服务端生成），用于幂等与防重放
}
```
- `action: "save"`（暂存）：**允许缺项**；完整分类（项目 + 列 + ≥1 标签）→ `ready_to_archive`，
  缺项 → `needs_info`。`200 { "ok": true, "status", "classifyVersion", "classification", "archiveQueued": false }`。
  **零远端写入**。
- `action: "archive"`（归档授权）：服务端**重新读取 Kaneo 有效选项**并校验项目、列、工作区标签与负责人，
  然后在事务内比较分类版本、固定归档快照（连接 / 项目 / 工作区 / 列 ID+slug / 标签 / 负责人）、
  记录管理员与操作时间并入队。
  `202 { "ok": true, "status": "ready_to_archive", "classifyVersion", "classification", "revision", "archiveQueued": true, "replayed": false }`。
  - 分类不完整 → `422 "incomplete_classification"`；项目/列/标签/负责人与 Kaneo 不符 → `422 "invalid_classification"`；**两种都不产生远端写入**。
  - 版本过期 → `409 "version_conflict"`；已进入归档队列 / 已归档 / 已有远端任务 → `409 "classification_locked"`；
    已授权但操作标识不同 → `409 "already_authorized"`。
  - 同一 `operationId` 重放 → `202` 且 `replayed: true`，不重复入队、不重复写远端。
  - 授权后配置变化**不会重定向**本次任务：worker 只使用快照里的目标。
  - 锁定的记录只能沿既有恢复入口（`retry` / `resolve` / `recover`）继续，不能通过分类编辑另建任务。
- 详情 `GET /api/admin/feedback/:id` 额外返回 `classification`（含 `version`）、`classificationLocked`、
  `archiveAuthorized`、`archiveAuthorizedAt`、`archiveOperationId` 与 `audit`（操作审计，按时间正序）。
- 提交成功与保存分类都不会调用 Kaneo；重启扫描只重新入队 `received`/`processing`（仅 AI）与
  **已持久化授权**的 `ready_to_archive`。

### POST /api/feedback/:id/retry （仅 Cookie 会话，管理页）
将 `failed` 重新入队（归档失败→从持久化断点恢复）；对 `needs_info` 且尚无 AI 整理结果
（AI 失败已按原文回退）的记录，重新尝试 AI 整理。**绝不因重试而发起未经人工授权的远端归档。**
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

### 生命周期管理（仅管理员 Cookie 会话；迁移 v9 起）

每条反馈带独立于处理状态的**管理状态** `mgmtState`：`inbox` / `archived` / `trash`（回收站）。
处理状态 `status=archived` 仍表示「已同步到 Kaneo」；本地 `archived` 区域只是管理归档，
不产生任何远端请求。历史记录一律 `inbox`。

- `GET /api/admin/feedback?view=&q=&from=&to=` — 列表扩展：`view` ∈ `inbox|archived|trash|all`
  （缺省 `inbox`；`all` = 收件箱+已归档，不含回收站）；`q` 按标题/原文/反馈 ID 字面匹配
  （≤200 字符，通配符按字面处理，不搜日志 BLOB）；`from`/`to` 为 RFC3339 半开区间。
  保留 `status`/`appId`/`cursor`/`limit`（≤100）。列表项额外返回 `mgmtState`、
  `lifecycleVersion`、`resumePaused`、`archivedAt`、`trashedAt`、`appName`、
  `hasScreenshot`、`logCount`、`availableActions`（服务端口径的可用动作）。
- `GET /api/admin/feedback/counts?view=&q=&from=&to=&status=&appId=` — 三个区域计数，
  按与列表相同的搜索/筛选条件计算（`view` 不计入）：`{ inbox, archived, trash }`。
- `GET /api/admin/feedback/app-options` — 有历史反馈的软件选项（含已删除软件）：
  `{ items: [{ appId, name, deleted }] }`。
- `POST /api/admin/feedback/lifecycle` — 生命周期动作，单条与批量同一入口：
  ```jsonc
  { "action": "archive"|"unarchive"|"trash"|"restore"|"resume_processing"|"purge",
    "items": [{ "id": "…", "expectedVersion": 3 }, …] }   // 1..100 项；expectedVersion 必填非负整数
  ```
  成功 `200 { "ok": true, "action", "results": [{ "id", "ok", "code"?, "message"?,
  "mgmtState"?, "lifecycleVersion"?, "purged"?, "alreadyPurged"? }] }`；
  业务部分失败不回滚已成功项。**仅一项且该项失败**时直接返回对应 HTTP 错误
  （与既有错误格式一致，如 `409 "invalid_state"`）。
  `GET /api/admin/feedback/:id` 详情对回收站记录返回 `readOnly: true`。

动作语义：

| 动作 | 条件 | 结果 |
|---|---|---|
| `archive` | `mgmtState=inbox` 且 `status=archived`（完整同步；仅存在远端任务 ID 不够） | 进入已归档区域；零远端请求 |
| `unarchive` | `mgmtState=archived` | 回到收件箱 |
| `trash` | `mgmtState` ∈ `inbox|archived` | 进回收站；正文/截图/日志/分类/远端关联全部保留，停止一切自动处理（**不触碰远端任务**） |
| `restore` | `mgmtState=trash` | 回收件箱；未完成记录 `resumePaused=true`（不自动重发） |
| `resume_processing` | `resumePaused=true` 且不在回收站 | 清除暂停标记，按现有状态继续处理 |
| `purge` | `mgmtState=trash` | 事务内删除反馈+附件 BLOB+审计，写最小删除凭据；不可恢复 |

错误：`404 "not_found"`；`409 "version_conflict"`（`expectedVersion` 过期，刷新后重试）；
`409 "busy"`（该反馈正被其他操作持锁处理）；`409 "invalid_state"`（不满足动作条件，
如未同步记录归档、非回收站记录 purge）；`400 "invalid_request"`（未知动作/超限）。
正在处理中的记录返回 busy，不强行中断在途外部请求。

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
  "allowedOrigins": ["https://app.example.com"],  // 显式放行的来源：登记时直接视为「已确认来源」
  "kaneoProjectId": "proj-xxx",      // 默认目标项目（归档规则的来源）
  "kaneoColumnSlug": "backlog",      // 默认目标列 slug
  // ---- 先接收后配置 / 自动归档 ----
  "nameSource": "admin" | "client",  // 名称来源：管理员设置后客户端不可覆盖
  "configStatus": "pending" | "configured",  // pending=自动发现后待配置
  "archiveMode": "manual" | "automatic",
  "ruleVersion": 0,                  // 配置保存与归档模式变更时自增（来源确认不推进）
  "defaults": {
    "projectId": "", "columnId": "", "columnSlug": "",
    "labelIds": [], "assigneeId": null, "assigneeName": null
  },
  "ruleComplete": false,             // 项目 + 目标列 + ≥1 工作区标签
  "autoEnabledAt": null, "autoEnabledBy": null,
  "firstSeenAt": "<iso>", "lastSeenAt": "<iso>",
  "pendingSources": 0,               // 待确认来源数
  "confirmedSources": 0,             // 已确认来源数
  "waitingFeedbacks": 0,             // 尚未授权且无远端任务的反馈数
  "createdAt": "<iso>", "updatedAt": "<iso>"
}
```
- `GET /api/admin/apps` → `{ "apps": [App] }`（含上表统计字段，供列表显示「待配置 / 待确认来源 / 等待反馈」）
- `GET /api/admin/apps/:id` → `{ "app": App, "sources": [Source] }`；`Source` 为
  `{ "origin", "kind": "browser"|"native", "status": "pending"|"confirmed", "firstSeenAt", "lastSeenAt", "confirmedAt", "confirmedBy" }`
- `POST /api/admin/apps`（同字段）→ `201 App`；重复 appId → `409 "app_exists"`。
  管理员填写的 `allowedOrigins` 在创建时直接登记为**已确认来源**。
- `PUT /api/admin/apps/:id`（`appId` 字段被忽略；可带 `kaneoColumnId` / `kaneoLabelIds` / `kaneoAssigneeId` / `kaneoAssigneeName`；
  **必带** `expectedRuleVersion`）→ `200 App`。**普通保存绝不触发归档**，也不改变归档模式；
  保存成功即推进一次 `ruleVersion`，并把名称接管为管理员所有（`nameSource = admin`）。
  页面版本已过期 → `409 "version_conflict"`，**一个字节都不写**（两个管理页面不会互相覆盖配置）；
  缺少 `expectedRuleVersion` → `400 "invalid_request"`。
- `DELETE /api/admin/apps/:id` → `204`（历史反馈保留）

### POST /api/admin/apps/:id/sources/confirm （仅管理员 Cookie 会话 + 同源）
`{ "origin": string, "operationId": string, "expectedRuleVersion": number }` →
`200 { "ok": true, "replayed", "source": Source, "autoArchiveEnabled", "backlogDispatched" }`。
把服务端观察到的某个来源标记为**已确认**。两个字段都必填：
- `operationId` 是**一次操作的稳定幂等键**（页面为同一次点击保留同一个值，网络重试不生成新键）；
- `expectedRuleVersion` 是页面读到的规则版本；与库内不一致 → `409 "version_conflict"`，
  **不确认来源、不触发任何归档**。

事务内先识别同一 `operationId` 的成功重放（幂等返回、不重复补处理），再检查版本与来源状态。
该来源此前已确认（其他操作键）→ `200 { "alreadyConfirmed": true }`；来源不存在 → `404 "not_found"`；
缺少必填字段 → `400 "invalid_request"`。
**确认来源不修改 `ruleVersion`**：自动模式下首次确认会清除「等待来源确认」阻塞并
`backlogDispatched = true`（由扫描补处理积压）；人工模式下只登记确认，`backlogDispatched = false`
（后台据此提示「已确认来源，等待启用自动归档」）。

### POST /api/admin/apps/:id/auto-archive/enable （仅管理员 Cookie 会话 + 同源）
`{ "expectedRuleVersion": number, "operationId"?: string }` →
`200 { "ok": true, "replayed": boolean, "app": App }`。
管理员显式点击「启用自动归档并处理积压」：启用前用 Kaneo 实时核对默认目标（只读），
随后把模式切到 `automatic`（推进 `ruleVersion`）并触发补处理扫描。错误语义：
- 规则不完整（缺项目/列/标签）→ `422 "incomplete_rule"`（不写任何东西）
- 目标在 Kaneo 中已失效 → `422 "invalid_rule"`；Kaneo 不可达 → `502 "kaneo_unavailable"`
- `expectedRuleVersion` 与当前不一致 → `409 "version_conflict"`；缺失 → `400 "invalid_request"`
- 同 `operationId` 重放 → 幂等返回，**不重复处理积压**

### POST /api/admin/apps/:id/auto-archive/disable （仅管理员 Cookie 会话 + 同源）
`{ "expectedRuleVersion": number, "operationId"?: string }` → `200 { "ok", "replayed", "app" }`。
关闭自动归档**只阻止新的授权**：已获授权的任务继续执行，不撤销任何已固定的快照；
模式变更同样推进 `ruleVersion`，因此旧页面再次启用 / 停用会被 `409 "version_conflict"` 拒绝。

## 自动归档（T3）语义

- **授权门槛不变**：普通保存、规则启用、来源确认、重启扫描都不会直接写远端；
  只有「自动模式已启用 + 来源已确认 + 规则完整有效」的记录才会进入既有的归档授权事务
  （与人工归档共用同一事务、同一 V3 快照结构）。
- **固定快照**：自动授权同样在事务内固定项目 / 列 / 标签 / 负责人；此后改规则**不会**重定向已授权记录。
- **幂等**：自动授权的操作键为 `auto:<feedbackId>:<ruleVersion>`，同记录同规则版本重复扫描只授权一次；
  事务内还会复核「模式仍为自动 + 规则版本未变 + 来源仍已确认」，因此重复点击、并发扫描与启停竞争都不会重复建任务。
- **阻塞与退避**：不满足条件的记录保持「已接收」并记录原因（管理页与组件都能看到）。
  `autoBlockedKind = "config"` 表示配置问题（规则不完整、来源待确认、目标列失效、Kaneo 未配置），
  **等待管理员修正**，修正后由扫描重新拾起；`"retryable"` 表示可恢复故障（网络/连接类），
  按有上限的指数退避重试（1 分钟起，最多 30 分钟）。
- **人工保护（T3）**：已被管理员保存过分类的记录（`classifyVersion > 0` 或存在 `classifyUpdatedAt`/`classifyUpdatedBy` 留痕）
  **不参与**自动候选，也不在自动授权事务内被覆盖——即使分类不完整或被清空。这类记录仍可由管理员用
  「保存并归档」完成；候选查询、自动授权入口与最终授权事务三处同时执行这一保护，
  因此「扫描取到候选之后管理员才保存」的竞争窗口同样不会覆盖人工内容。
- **积压排空（T3）**：扫描按批（默认 50 条）取候选，一批处理完后**继续查询**直到没有可执行候选；
  同一轮不重复尝试同一条记录。人工记录、配置阻塞（`config`）、尚未到期的退避与已授权记录都会被排除，
  不会造成空转或饥饿。
- **到期重试（T3）**：服务按库内**最早到期的**可恢复退避设置一个可取消定时器，到期重新查库并处理；
  启用规则、确认来源、配置修正、AI 整理完成与服务恢复都进入同一个调度入口。
  启动时恢复立即可执行任务并重新安排未来重试；**人工触发扫描不能绕过尚未到期的退避**。
  优雅退出时先停止调度与定时器，再排空已有队列、关闭数据库。
- **远端结果不确定**：仍走既有 `needs_review` 待核对流程，绝不重新创建任务。

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

- `GET /api/admin/feedback?status=&appId=&cursor=&limit=50` → `status` 支持全部状态
  （`received` / `processing` / `needs_info` / `ready_to_archive` / `archiving` / `needs_review` / `archived` / `failed`）。
  `{ "items": [{ "id", "appId", "username": string|null, "status", "createdAt", "updatedAt", "title"?: string|null, "kaneoUrl"?: string|null, "errorSummary"?: string|null, "archiveStage"?: string|null, "hasScreenshot": boolean, "logCount": number, "classification": { "projectId", "columnId", "columnSlug", "labelIds", "assigneeId", "assigneeName", "version", "updatedAt", "updatedBy" }, "archiveAuthorized": boolean, "classificationLocked": boolean, "sourceOrigin": string, "collectionState": string, "archiveAuthorizedKind": "manual"|"auto"|null, "archiveRuleVersion": number|null, "autoBlockedKind": "retryable"|"config"|null, "autoBlockedReason": string|null, "autoAttempts": number, "autoNextAttemptAt": string|null }], "nextCursor": string|null }`
  （`username` 为提交账号；旧记录归属迁移前的初始账号；`logCount` 为该记录附带的日志文件数量；
  `sourceOrigin` 为服务端观察到的来源，`collectionState` 见前文；`autoBlocked*` 为自动归档阻塞原因与退避时间）
- `GET /api/admin/feedback/:id` → 详情：以上字段 + `{ "username", "text", "processed"?: {...}, "kaneoTaskId"?, "attemptCount", "lastError"?, "context"?, "screenshot"?, "logs": [...], "recovery"?, "classification", "classificationLocked", "archiveAuthorized", "archiveAuthorizedAt", "archiveOperationId", "audit": [{ "id", "at", "actor", "action", "detail" }] }`，其中 `screenshot` 为截图元数据（`width`/`height`/`byteSize`/`sha256`/`capture`/`createdAt`，无截图则为 `null`；PNG 本体经 `GET /api/admin/feedback/:id/screenshot` 取回），`logs` 为该记录有序排列的日志附件元数据列表，`recovery` 见「管理页允许动作」，`audit` 为持久化操作审计（分类保存 / 归档授权 / 恢复动作）。
- `GET /api/admin/feedback/:id/logs/:logId/download` → 下载日志原始文件，`Content-Type: application/octet-stream`，附带标准 RFC 5987 / RFC 6266 `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` 标头。
- `GET /api/admin/feedback/:id/logs/:logId/preview` → 在浏览器内直接预览纯文本日志内容，`Content-Type: text/plain; charset=utf-8`，`Content-Disposition: inline`。
- `GET /api/admin/feedback/:id/logs/:logId` → 便捷预览路由，行为等价于 `/preview`。

## 面板内登录（Web 组件 / Flutter，当前方式）

1. 未登录也可在面板内编辑反馈文字与截图；点击主按钮「登录并提交」。
2. 面板**就地展开**账号密码表单（同一个主按钮文案为「登录并提交」），不打开任何窗口。
3. 确认后调用 `POST /api/auth/login`，显式携带 `clientLabel`（Web 为 `web:<appId>`，Flutter 为 `flutter-<平台>-<时间>`）
   与 `appId`；`appId` 只需格式合法，**无需事先登记**（软件在首次有效提交时自动发现）。
4. 成功后令牌仅存内存（Web / Flutter Web）或安全存储（原生 Flutter），立即提交一次；取消只收起表单，草稿保留。
   提交成功后按响应里的 `collectionState` 提示：`queued` 继续跟踪轮询；等待配置/等待来源确认/等待人工归档则
   显示「已保存，等待…」并停止轮询（保留手动刷新），**绝不显示为提交失败**。
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
| `appId` | 是 | 软件标识；**无需事先登记**，首次提交自动发现 |
| `appName`（Web 属性 `app-name`，Flutter `appName`） | 否 | 上报的软件显示名称；管理员设置过名称后不会覆盖 |
| `appVersion` | 否 | 展示在 Kaneo 任务来源信息 |
| `pageLabel` | 否 | 宿主显式传入的页面标识 |

自动归档的项目与列由管理员在后台配置，客户端不可指定。

## 跨源（CORS）

宿主应用与反馈服务通常不同源，且**软件可以完全没有预先配置**。服务端因此对
**组件真正用到的端点**开放无凭据跨域，并对任意**合法 http(s) Origin** 回显：

- 允许跨源的路径仅限：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session`、
  `POST /api/feedback`、`GET /api/feedback/:id`、`GET /api/feedback/:id/screenshot`；
- 回显 `access-control-allow-origin: <请求 Origin>` 与 `access-control-max-age: 300`，
  **绝不回显 `access-control-allow-credentials`**——组件一律使用 Bearer + `credentials: omit`；
- **跨源请求一律不认后台 Cookie**：携带 `Origin` 且与服务 origin 不一致时，Cookie 不参与鉴权
  （即使浏览器带上了后台会话 Cookie，也只按 Bearer 判定身份）；
- 其余路径（人工恢复动作、后台管理、会话管理、旧握手、系统更新）**不参与跨源放行**，保持第一方同源 Cookie 限制。

Flutter 原生（非浏览器）不受 CORS 约束；无 `Origin` 的请求按原生客户端处理，来源记为 `native`。
