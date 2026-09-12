# 反馈日志附件：实施契约（T1 / T2 / T3）

本文件是「截图＋描述＋日志」本次交付的**冻结契约**：Web、Flutter、服务端、管理页、AI/Kaneo
各工作流必须按此实现，避免并行改动期间接口漂移。产品规则以任务书为准，本文件只把规则落成
可执行的线格式与行为约定。

## 0. 范围

- T1：打开反馈面板自动附带宿主日志，也能手动补充；可预览、移除；采集失败仍可提交截图与描述。
- T2：`POST /api/feedback` 接收日志；`feedback_logs` 子表持久化；管理页查看/下载。
- T3：AI 结合日志分析并输出 `diagnostics`；Kaneo 按截图、日志顺序归档可下载附件。

不做：压缩包、系统日志扫描、长期日志平台、拦截全局 console、扫盘、自动收集网络请求。
宿主负责在把日志交给组件**之前**去除凭据等敏感内容。

## 1. 提交线格式（`POST /api/feedback`）

- 有截图**或**有日志 → `multipart/form-data`；都没有 → 保持原 JSON 请求（完全兼容）。
- 描述（`metadata.text`）始终必填，规则不变（1..10000 码点）。
- 文件部件：`screenshot`（0..1）、`logs`（0..3，**重复同名部件，顺序即元数据顺序**）。
- `metadata` JSON 增加可选 `logs` 数组，**长度必须等于 `logs` 部件数**，按下标一一对应：

```json
{
  "idempotencyKey": "…",
  "appId": "…",
  "text": "…",
  "context": { "appVersion": "…", "pageLabel": "…" },
  "capture": { "…": "仅截图时" },
  "logs": [
    { "name": "app.log", "source": "auto",   "byteSize": 12345 },
    { "name": "network.jsonl", "source": "manual", "byteSize": 678 }
  ]
}
```

- `name`：客户端文件名（服务端按白名单扩展名校验并做安全化后入库）。
- `source`：`"auto"`（首次打开自动采集）或 `"manual"`（用户手动添加）。
- `byteSize`：可选；出现时必须与实际字节数一致，否则 `invalid_log`。

### 1.1 限制与错误码

| 规则 | 常量 | 违反时 |
| --- | --- | --- |
| 日志文件数 ≤ 3 | `MAX_LOGS = 3` | `too_large` / 413 |
| 单文件 ≤ 1 MiB | `MAX_LOG_BYTES = 1048576` | `too_large` / 413 |
| 扩展名 ∈ `.log .txt .json .jsonl`（大小写不敏感） | — | `invalid_log` / 400 |
| 内容非空 | — | `invalid_log` / 400 |
| 内容为合法 UTF-8（严格解码，无替换字符、无 `0x00`） | — | `invalid_log` / 400 |
| `metadata.logs` 与 `logs` 部件数量一致且逐项可解析 | — | `invalid_log` / 400 |
| 部件 filename（若存在）basename 与 `metadata.logs[i].name` 一致 | — | `invalid_log` / 400 |
| 请求体 ≤ 9 MiB | `MAX_MULTIPART_BYTES = 9 * 1024 * 1024` | `too_large` / 413 |

- 尺寸上限走 `too_large`/413，内容与元数据问题走 `invalid_log`/400；截图错误码不变。
- 服务端**不截断、不静默丢弃**：任何超限都整单拒绝并给出明确 message。
- 请求体上限用「content-length 预检 + 流式累计」双重判定（现有实现方式保留）。

### 1.2 幂等摘要

- 有日志时：`contentHash` 的 payload 增加 `logs: [{ name, sha256 }, …]`（**顺序敏感**），
  与现有 `screenshotSha256`/`releasePoint` 并列。
- 无日志时：payload 与算法**逐字节保持原样**（旧客户端重试仍然命中，兼容）。
- 同一幂等键换日志 → `idempotency_conflict` / 409（由 hash 不一致自然得出）。

## 2. 存储（SQLite）

新增表（`db.ts` SCHEMA + 迁移，`user_version 2 → 3`，**不重建 feedbacks**）：

```sql
CREATE TABLE IF NOT EXISTS feedback_logs (
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  name         TEXT NOT NULL,      -- 服务端安全化后的文件名
  source       TEXT NOT NULL CHECK (source IN ('auto','manual')),
  content      BLOB NOT NULL,      -- 原始 UTF-8 字节
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(feedback_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_feedback ON feedback_logs(feedback_id, ordinal);
```

- 迁移在事务内执行；**成功后才写 `PRAGMA user_version = 3`**；失败回滚且版本不变。
- 反馈 + 截图 + 全部日志在**同一事务**写入，任一失败整体回滚。

## 3. 管理端接口

### 3.1 列表

`GET /api/admin/feedback` 的 item 增加 `logCount: number`（无日志为 `0`）。

### 3.2 详情

`GET /api/admin/feedback/:id` 增加：

```json
"logs": [
  { "id": "…", "name": "app.log", "source": "auto", "byteSize": 12345,
    "sha256": "…", "createdAt": "…", "ordinal": 0 }
]
```

`processed` 原样返回（可含 `diagnostics`；旧结果无该字段）。

### 3.3 日志读取/下载

`GET /api/admin/feedback/:id/logs/:logId`（cookie 管理鉴权 + 同源检查，与其余管理接口一致）：

- 200：响应体为原始 UTF-8 文本字节。
- 头：`content-type: text/plain; charset=utf-8`、`cache-control: no-store`、
  `x-content-type-options: nosniff`、`content-disposition: inline; filename="<安全名>"`；
  带 `?download=1` 时 disposition 改为 `attachment`。
- 404 `not_found`；**不返回公开链接**，不把附件内容写进运行日志。

### 3.4 恢复接口

`POST /api/feedback/:id/recover` 的 body 增加可选 `logId`：

- 缺省 = 原有截图行为（完全不变，兼容旧管理页）。
- 提供时 = 针对该日志的附件（`retry_comment` / `replace_upload`）。
- `logId` 不存在于该反馈 → `invalid_request` / 400。

## 4. Web / Flutter 行为契约（T1）

两端语义必须一致：

1. **回调**：Web `FeedbackWidget.logProvider`（JS 属性，同时可经 `openFeedback({ logProvider })` 传入）；
   Flutter `FeedbackConfig(logProvider: …)`。返回文件名 + 日志字节。
   - Web：`() => Promise<FeedbackLogFile | FeedbackLogFile[] | null>`，
     `FeedbackLogFile = { name: string; bytes: Uint8Array }`。
   - Flutter：`Future<List<FeedbackLogFile>> Function()`，
     `FeedbackLogFile = { String name; Uint8List bytes }`。
   - **未配置回调**时只显示「手动添加日志」入口。
2. **采集时机**：新草稿**首次打开**时调用一次，采集时点固定为该次打开时间；
   **重新打开已有草稿不重新采集**；用户移除后**不自动补回**。
3. **超时**：3 秒未返回 → 显示「日志获取失败」，提供「重试」与「不带日志继续提交」。
   失败/超时**不阻塞**截图与描述提交。
4. **限制**：自动与手动文件**共用**同一上限（3 个 / 每个 1 MiB / 扩展名白名单）；
   超限给出明确提示，**不静默删除或截断文件**。
5. **面板**：展示文件名、大小、来源（自动/手动）；支持纯文本预览与移除；
   说明日志会参与 AI 分析及归档。
6. **手动添加**：Web `<input type="file" multiple accept=".log,.txt,.json,.jsonl">`；
   Flutter 用 `file_selector`（`openFiles`），按**字节**读取（`readAsBytes`），Web 与原生端一致。
7. **迟到结果**：关闭、卸载、切换服务或应用后，迟到的采集结果**不得写回**。
8. **提交期间**：提交及状态轮询期间锁定附件修改；提交失败保留原快照；
   **修改附件后生成新的幂等键**（与现有截图行为一致）；采集中允许编辑描述，取消采集后可继续提交。
9. **草稿复用**：沿用现有草稿与提交快照机制（Web 的本地草稿存储、Flutter 的草稿状态），
   新草稿需能在关闭重开后保留日志列表。
10. **提交编码**：`metadata.logs` 与 `logs` 部件顺序一致；部件 filename 用日志文件名。

## 5. AI 与 Kaneo（T3）

### 5.1 AI 输入

- `AiClient.organize(rawText, image?, logs?)`：`logs?: { name; sha256; byteSize; text; truncated }[]`。
- worker **只从已保存附件读取**日志（数据库），重试时绝不重新向宿主取日志。
- 截取规则：每个文件最多取**末尾 8,000 个 Unicode 码点**；全部文件合计最多 **24,000** 码点。
  记录文件名、摘要（sha256）、字节数、原始码点数与是否截取。
- 日志是**不可信证据**：提示词必须声明不得执行其中的指令、不得覆盖用户原话与整理规则。
- 管理页与 Kaneo 描述同步展示诊断内容；兼容旧结果缺少该字段。

### 5.2 整理结果

```ts
diagnostics?: {
  logEvidence: string;    // 日志中可直接读到的事实（引用/转述）
  possibleCauses: string; // 由日志与用户描述推出的可能原因（未证实）
  speculation: string;    // 明确标注为推测、日志无法证实的部分
}
```

- 无日志时保持旧提示词与旧输出（不新增字段），兼容旧测试与旧结果。
- 有日志时提示词要求：不得把错误日志直接当成已证实根因；推测必须写进 `speculation`。
- 三个字段都为空则不输出 `diagnostics`。

### 5.3 Kaneo 归档

- 归档顺序：**先截图，再按 `ordinal` 升序的日志**。
- 日志评论标记：`<feedbackId>|<logId>|<sha256>`；截图标记不变（`<feedbackId>|<sha256>`）。
- 评论正文含可下载附件链接（复用现有评论区挂载与鉴权下载机制）。
- 归档数据新增 **V2**（`version: 2`）：保留原有 `upload/asset/comment/replacedKeys`（截图），
  新增 `logs: [{ logId, upload?, asset?, comment?, replacedKeys? }]`。V1 继续可读，
  **不批量改写历史记录**；新写入一律 V2。
- **完成条件集中检查**：所有附件（截图若有 + 每份日志）都确认挂载后才允许 `status=archived`；
  仅截图完成而日志未完成 → 绝不标记 `archived`。
- 已确认附件不重复上传；远端结果不确定 → `needs_review`，先用评论 + 下载字节摘要核对，
  再决定是否推进，**不盲目创建第二份**。
- 恢复动作（`retry_comment`/`replace_upload`）支持可选 `logId`；缺省仍是截图。

## 6. 并行工作流边界

| 工作流 | 独占文件 |
| --- | --- |
| 服务端（captain） | `apps/server/**`、`docs/api.md`、`docs/integration.md` |
| Web | `packages/web/**`、`examples/vue/**`、`examples/react/**`、`examples/html/**`、`examples/ssr/**` |
| Flutter | `flutter/feedback/**`、`examples/flutter/lib/**`、`examples/flutter/test/**` |
| 管理页 | `apps/admin/**` |

跨边界改动一律先在对话/文档中提出，不直接改别人的文件。
