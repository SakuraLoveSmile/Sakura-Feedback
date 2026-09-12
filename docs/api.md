# Feedback 服务 HTTP 契约 (v1)

Base URL：`http(s)://<host>:8787`。所有 JSON 请求必须 `Content-Type: application/json`，请求体上限 64 KB。
所有错误统一返回：`{ "error": { "code": "<machine_code>", "message": "<人类可读，可安全展示>" } }`。

认证方式（两类接口）：

1. **Cookie 会话**（管理页与登录窗口）：`POST /api/auth/login` 成功后由服务端下发 HttpOnly Cookie
   `fb_session`（`SameSite=Lax`；HTTPS 部署下 `Secure`）。仅同站第一方请求携带，不依赖第三方 Cookie。
2. **Bearer 令牌**（客户端组件提交反馈）：`Authorization: Bearer <token>`。令牌来源两种：
   - Web 组件：登录窗口握手交付的**短期访问令牌**（默认 15 分钟）；
   - Flutter 原生端：`POST /api/auth/login` 携带 `clientLabel` 换取的**长期可撤销令牌**（默认 90 天）。

无注册接口。初始账号由部署环境变量 `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD` 建立。

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
Body: `{ "username": string, "password": string, "clientLabel"?: string }`
- 无 `clientLabel`（浏览器）：`200 { "ok": true, "expiresAt": "<iso>" }` + Set-Cookie；不返回令牌。
- 有 `clientLabel`（Flutter 原生等）：`200 { "ok": true, "token": "<bearer，仅此一次明文返回>", "expiresAt": "<iso>" }`，同时可附带 Cookie。
- 失败：`401 { error.code: "invalid_credentials" }`；限流后 `429 "rate_limited"`（`Retry-After` 头）。
- 限流：按 IP+用户名滑动窗口。

### POST /api/auth/logout
Cookie 会话。`204`。撤销当前会话（其 Bearer 令牌同时失效）。

### GET /api/auth/session
Cookie 或 Bearer。`200 { "authenticated": true, "kind": "cookie"|"client", "expiresAt": "<iso>", "clientLabel"?: string }`；未认证 `401`。

### GET /api/auth/handshake/validate?appId=&origin= （需 Cookie 会话）
登录窗口在把令牌 postMessage 给宿主前调用。校验 `origin` 是否在 `appId` 的允许来源列表内。
- `200 { "ok": true }` 或 `400 "origin_not_allowed"`。

### POST /api/auth/handshake （需 Cookie 会话；body `{ "appId": string, "origin": string }`）
签发短期访问令牌。服务端再次校验 origin。
`200 { "accessToken": string, "expiresIn": number, "expiresAt": "<iso>" }`（默认 `expiresIn` = 900 秒）。

### 管理：会话撤销
- `GET /api/auth/sessions` → `{ "sessions": [{ "id", "kind", "clientLabel"?, "createdAt", "lastUsedAt"?, "expiresAt", "current": bool }] }`
- `DELETE /api/auth/sessions/:id` → `204`（不能撤销当前 cookie 会话本身以外均可；撤销 `current` 返回 `204` 但前端应随即跳登录）。
- `POST /api/auth/sessions/revoke-all` → `{ "revoked": number }`

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
响应：
- `201 { "feedbackId": string, "status": "received" }`
- `200 { "feedbackId", "status", "replayed": true }`（同 key 同内容，幂等重放）
- `409 "idempotency_conflict"`（同 key 不同内容）
- `401` / `400 "invalid_request"` / `400 "invalid_log"` / `404 "unknown_app"` / `413 "too_large"` / `429`

**multipart 变体**（携带截图或日志）：`Content-Type: multipart/form-data`，字段：
- `metadata`：同上 JSON，另加可选 `capture` 与可选 `logs`；
- `screenshot`：可选 PNG 文件（0..1）；
- `logs`：**可重复**的日志文件部件（0..3），出现顺序即 `metadata.logs` 的下标顺序。

有截图**或**有日志时必须用 multipart；两者都没有时保持原 JSON 请求（逐字节兼容）。
`metadata.logs` 每项为 `{ "name": string, "source": "auto"|"manual", "byteSize"?: number }`：

| 规则 | 取值 | 违反时 |
|---|---|---|
| 日志文件数 | ≤ 3 | `413 "too_large"` |
| 单个日志大小 | ≤ 1 MiB | `413 "too_large"` |
| 扩展名白名单 | `.log` / `.txt` / `.json` / `.jsonl`（大小写不敏感） | `400 "invalid_log"` |
| 内容 | 非空、严格合法 UTF-8、无 NUL 字节 | `400 "invalid_log"` |
| `metadata.logs` 与 `logs` 部件 | 数量一致、逐项来源与名称可解析；`byteSize` 出现时必须与实际一致；部件 filename（若存在）basename 必须与 `name` 一致 | `400 "invalid_log"` |
| 请求体总大小 | ≤ 9 MiB（content-length 预检 + 流式累计双重判定） | `413 "too_large"` |

日志只接受宿主**显式导出**的内容：服务端不扫盘、不拦截 console、不自行收集网络请求；脱敏（凭据等）由宿主在交给组件前完成。服务端**不截断、不静默丢弃**超限文件，一律整单拒绝并给出明确 message。

`capture` 仅接受白名单字段，全部可选：

| 字段 | 类型 | 说明 |
|---|---|---|
| `viewportWidth` / `viewportHeight` | number | 捕获时的**逻辑 CSS 视口**尺寸 |
| `pixelWidth` / `pixelHeight` | number | 最终 PNG 的**实际输出像素**尺寸（1..65535 整数，成对出现；与逻辑视口区分；旧客户端可缺省） |
| `capturedAt` | string | 截图时间 |
| `releasePoint` | `{x,y}` | 0..1 归一化落点 |

未知字段忽略；输出像素出现但不完整或不是 1..65535 整数时整条请求 `400 "invalid_request"`。早期实现曾接受 `outputWidth`/`outputHeight` 作为同一字段的别名，命名定稿后已作废：现按未知字段忽略，规范名只有 `pixelWidth`/`pixelHeight`。AI 归档提示优先使用输出像素尺寸，逻辑视口仅作回退。服务端另行测量并持久化真实 PNG 尺寸（管理端 `screenshot.width/height` 为准），PNG 本身仍受 2048px / 400 万像素 / 5MiB 限制。

### GET /api/feedback/:id （Bearer 或 Cookie）
`200 { "id", "status", "createdAt", "updatedAt", "errorSummary"?: string|null, "kaneoUrl"?: string|null }`
不存在/无权限 `404 "not_found"`。面板轮询此端点（建议 2s 退避至 5s）。

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
{ "action": "retry_comment",  "expectedRevision": number, "logId"?: string }  // 针对评论：先查重；命中→补记确认并按完成条件收尾，未命中→发送**至多一条**评论
{ "action": "replace_upload", "expectedRevision": number, "logId"?: string }  // 针对附件：先经鉴权资产下载核对真实字节（一致则不替换）；替换复用原 task、保留旧 key 恢复记录（replacedKeys）、不自动删远端对象；替换成功后才发新评论
```
`expectedRevision` 必填。**`logId` 可选：缺省 = 原有截图行为（旧管理页完全兼容）；提供时针对该份日志附件执行同一动作**；`logId` 不属于该反馈 → `400 "invalid_request"`。
`202 { "ok": true, "status": ..., "revision": number, "replaced"?: boolean, "note"?: string }`；
`400 "invalid_request"`（缺 expectedRevision / 非法 action / 非法或不存在的 logId）；`409 "busy"` / `"revision_conflict"` / `"invalid_state"` / `"target_changed"`；远端读取/写入失败 → `502 "recover_failed"`（状态不变，不触发替代写入）。

**收尾统一走集中完成条件**：只有该记录的**全部附件**（截图，以及每份日志）都已确认挂载评论时才置 `archived`；只完成其中一部分时返回 `202` 且状态维持 `needs_review`（`error_summary` 提示尚有附件未完成）。任何自动路径（后台处理、`retry`、`recheck`、进程重启恢复）都经同一判定，**禁止仅因截图完成就标记 `archived`**。

**`retry_comment`（唯一允许重发评论的动作）**
- 发送前先按「反馈 ID + 附件摘要 + 当前资产引用」查询远端评论（日志再加日志 ID）：命中 → 只补记 `comment.outcome = "confirmed"` 并按完成条件收尾（**零远端写入**）；未命中 → 发送**至多一条**评论。
- 发出前先落盘 `comment.outcome = "maybe_sent"`，落盘失败则绝不发出请求；发送后再次查重，命中即记 `confirmed` 并归档，未命中则记 `maybe_sent` 并维持 `needs_review`。
- **仍可能产生重复评论**：查重（读取远端列表）与写入之间存在竞态，两个操作人同时重发、或上一次写入已到达 Kaneo 但列表尚未可见时都会漏判。操作人必须在 Kaneo 中复核评论数量。管理页在确认框中提示同一风险。
- `retry`、`recheck`、后台恢复等自动路径**绝不**因为“查重没查到”就重发评论：遇到 `maybe_sent` / `confirmed` 一律停止并维持 `needs_review`。`recheck` 本身只读取远端并确认（零远端写入）；仅当恢复数据记录评论**确实从未发送**（`not_sent` 或缺失）且核对未命中时，才交回正常归档流程从断点继续（见下方结果语义）。

**`replace_upload`（唯一可以替换附件的动作）**
- 复用**原 Kaneo 任务**，向 Kaneo 申请**新**上传地址并上传本地原图（截图或该份日志字节），然后 `finalize` 新 key 为资产并发送新评论。
- 替换前若资产已知，会经鉴权下载比对真实字节：**一致 → 不替换**（返回 `replaced: false`），仅核对；核对失败（含 404）不能证明文件不存在，按管理员决定继续替换。
- 被替换的旧 key 记入 `replacedKeys`（最多保留 20 条），旧 key 与旧资产线索保留可追溯；**不删除远端对象**，远端残留文件需人工清理。
- **上传地址过期**（`upload.expiresAt` 已过）与**同 key 重传被业务拒绝**这两种情况，自动路径**不会**申请新上传地址：记录转入 `needs_review`，`error_summary` 分别含“过期”“同 key”，原始 key 与 `expiresAt` 完好保留；`replace_upload` 是唯一出路。自动路径对同一 key 只做「重传相同字节」的安全恢复，累计上限 3 次。
- **第三种情况：完全没有 upload 记录**（申请地址的请求在途时进程中断，本地还没来得及落盘）。此时自动路径**会**重新申请一个上传地址，不转 `needs_review`。这是安全的，判据是**落盘顺序**：上传记录与 `maybe_sent` 都先落盘、之后才发 PUT 字节，所以“没有记录”蕴含“字节从未发出”，远端不可能存在该次上传的对象——被丢弃的只是一个未被使用过的预签名地址（该地址本身可能在 Kaneo 侧被分配过，但没有对象产生）。因此三种情形的分界是「**远端是否可能已存在该次上传的对象**」：可能（有记录）→ 绝不换 key；不可能（无记录）→ 允许重新申请。

### 恢复数据结构（`archive_data_json`，version 2）

```jsonc
{
  "version": 2,                       // 当前写入版本；version 1 仍可读（读取时不做批量改写）
  "revision": number,                 // 乐观锁，单调递增
  "target": { "apiBase", "projectId", "workspaceId" },
  "upload"?: {...}, "asset"?: {...}, "comment"?: {...}, "replacedKeys"?: [...],  // 截图附件（字段含义同历史版本）
  "logs"?: [{ "logId": string, "upload"?, "asset"?, "comment"?, "replacedKeys"? }]  // 按日志 ID 索引的独立附件记录
}
```

- 截图的四个字段语义与 V1 完全一致，**V1 记录继续可读**、不会因新增版本被拒绝或改写。
- 每份日志拥有**独立**的上传、资产与评论记录，互不覆盖；`logId` 对应 `feedback_logs.id`。
- 归档顺序固定为「先截图，再按日志 `ordinal` 升序」。日志评论标记为 `<feedbackId>|<logId>|<sha256>`；截图标记仍为 `<feedbackId>|<sha256>`。
- 评论正文含可下载附件链接，复用既有评论区挂载与鉴权下载机制；每份日志一条评论，便于单独重试与核对。
- 已完成（`confirmed`）的附件不会重复上传；远端结果不确定时进入 `needs_review`，先用评论列表 + 鉴权下载字节摘要核对，再决定是否推进，**不盲目创建第二份**。

### 恢复数据写入结果语义（`upload.outcome` / `comment.outcome`）

`archive_data_json` 的 `upload.outcome` 与 `comment.outcome` 取值恒为下列三者之一（管理页对应 `recovery.uploadOutcome` / `recovery.commentOutcome`，日志级对应 `recovery.logs[].uploadOutcome` / `recovery.logs[].commentOutcome`）：

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
`recovery: { revision, stage, uploadOutcome, assetKnown, commentOutcome, hasScreenshot, hasLogs, logs, allowedActions, actionTargets, actionNotes }`：
- `hasScreenshot`：该记录是否存有本地截图（等价于 `screenshot !== null`）。列表项 `GET /api/admin/feedback` 也返回该字段；
- `hasLogs`：是否存在日志附件；`logs: [{ logId, name, revision, stage, uploadOutcome, assetKnown, commentOutcome, allowedActions }]`：**日志级**恢复状态（与截图同一套语义，按日志 ID 索引），管理页据此渲染日志级 `retry_comment` / `replace_upload` 按钮并携带该 `logId`。旧服务端/旧记录缺少这些字段时管理页安全降级（只展示截图级动作）；
- `logCount`：列表项返回该记录已保存的日志份数（无日志为 `0`）；
- `logEntryPoints` 与截图的 `allowedActions` 规则一致：`needs_review` 且任务已知时，资产已知 → `retry_comment`；始终允许 `replace_upload`（过期/被拒上传的唯一出路，不要求资产已知）；
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
  `{ "items": [{ "id", "appId", "status", "createdAt", "updatedAt", "title"?: string|null, "kaneoUrl"?: string|null, "errorSummary"?: string|null, "archiveStage"?: string|null, "hasScreenshot": boolean, "logCount": number }], "nextCursor": string|null }`
- `GET /api/admin/feedback/:id` → 详情：以上字段 + `{ "text", "processed"?: { "title", "sections": { "experience", "problems", "suggestions", "questions" }, "diagnostics"?: { "logEvidence", "possibleCauses", "speculation" } }, "kaneoTaskId"?, "attemptCount", "lastError"?, "context"?, "screenshot"?, "logs", "recovery"? }`，其中 `screenshot` 为截图元数据（`width`/`height`/`byteSize`/`sha256`/`capture`/`createdAt`，无截图则为 `null`；PNG 本体经 `GET /api/admin/feedback/:id/screenshot` 取回），`recovery` 见「管理页允许动作」。
- `logs: [{ "id", "name", "source": "auto"|"manual", "byteSize", "sha256", "createdAt", "ordinal" }]`：日志元数据（按 `ordinal` 升序，**不含内容字节**；无日志为 `[]`）。`processed.diagnostics` 仅在 AI 结合日志给出诊断时出现，旧结果缺少该字段（管理页必须兼容）。
- `GET /api/admin/feedback/:id/logs/:logId` → 该日志的**原始 UTF-8 文本**（cookie 管理鉴权 + 同源检查，与其余管理接口一致）。响应头固定 `content-type: text/plain; charset=utf-8`、`cache-control: no-store`、`x-content-type-options: nosniff`、`content-disposition: inline; filename="<安全名>"; filename*=UTF-8''<编码名>`；`?download=1` 时 disposition 改为 `attachment`。日志不存在或不属于该反馈 → `404 "not_found"`。**不产生公开链接**，响应内容也绝不写入运行日志。

## Web 登录握手时序

1. 组件内“登录”按钮 → `window.open("<service>/login?appId=<appId>&nonce=<r>&cb=<encodeURIComponent(宿主 origin)>", "_blank", "popup")`。
2. 用户在服务自己的窗口完成 `POST /api/auth/login`（Cookie 会话建立）。
3. 登录页调用 `POST /api/auth/handshake`（服务端校验 cb origin 在 appId 的 allowedOrigins 内）获得短期令牌。
4. 登录页 `window.opener.postMessage({ type: "feedback:auth", nonce, accessToken, expiresAt }, cbOrigin)` 后自行关闭。
5. 组件校验 `event.origin === <服务 origin>` 且 `nonce` 匹配，存储令牌（仅内存），继续提交。
弹窗被拦截时 `window.open` 返回 null：组件显示“打开登录窗口”普通链接入口。
令牌过期后组件保留草稿，重新走 1–5；重开软件后走同一流程，由 Cookie 静默完成 2（登录页检测到有效 Cookie 时跳过表单直接执行 3–4）。

## 客户端公开参数（Web / Flutter 共用）

| 参数 | 必填 | 说明 |
|---|---|---|
| `apiBase` | 是 | 服务地址，如 `https://fb.example.com` |
| `appId` | 是 | 服务端软件配置中登记的标识 |
| `appVersion` | 否 | 展示在 Kaneo 任务来源信息 |
| `pageLabel` | 否 | 宿主显式传入的页面标识 |
| `logProvider` | 否 | 宿主日志回调（Web JS 属性 / Flutter 构造参数）；返回文件名 + 日志字节。未配置时面板只显示「手动添加日志」入口 |

目标 Kaneo 项目由服务端按 appId 决定，客户端不可指定。

### `logProvider` 行为约定（两端一致）

1. 新草稿**首次打开**时调用一次，采集时点固定为该次打开时间；重新打开已有草稿**不重新采集**；用户移除后**不自动补回**。
2. **3 秒超时**即视为失败：显示「日志获取失败」，提供「重试」与「不带日志继续提交」；失败与超时**不阻塞**截图与描述提交。
3. 上限与提交规则同提交线格式（3 个 / 每个 1 MiB / 扩展名白名单 / 严格 UTF-8）；自动与手动文件共用上限，超限逐个给出明确原因，**不静默删除或截断**。
4. 关闭面板、卸载组件、切换 `apiBase`/`appId` 后，迟到的采集结果**不得写回**；提交与状态轮询期间锁定附件修改，提交失败保留原快照，**修改附件后生成新的幂等键**。
5. 日志来自宿主既有日志系统：组件**不拦截全局 console、不扫描磁盘、不自行收集网络请求**；宿主负责在交给组件前去除凭据等敏感内容。

## 跨源（CORS）

宿主应用与反馈服务通常不同源。`/api/feedback*` 仅接受 Bearer/Cookie 中 **Bearer** 类凭据参与跨源：服务端只对已在任一软件配置 `allowedOrigins` 中登记的 Origin 回显 CORS 头（含 OPTIONS 预检）。管理接口与登录接口不开放跨源（第一方上下文）。Flutter 原生（非浏览器）不受 CORS 约束。
