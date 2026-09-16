# 收尾记录：人工分类归档改造（T1–T4）

> 记录时间：2026-09-15。状态口径沿用 [`docs/closeout.md`](closeout.md)：
> **未开始 / 实现中 / 待体验 / 已验收**。本轮**不标记「已验收」**——只有你按真实浏览器体验确认后才记已验收。
>
> 本次改动只落在 Feedback 仓库；**未**修改线上配置、宿主（Blog 等）或 Kaneo；
> 未提交任何真实反馈数据；未推送、未部署。

## 一句话结论

提交成功**不再授权远端归档**：后台只做 AI 整理，记录停在 `needs_info`；管理员在管理页
逐条选择「项目 / 目标列 / 至少一个工作区标签 /（可选）负责人」，点「保存并归档」后
才在事务内固定归档快照、记录审计并入队。**普通保存与重启扫描都无法绕过这道授权门槛。**

## 任务状态

| 任务 | 状态 | 说明 |
|---|---|---|
| T1 可靠收集与旧数据接管 | **待体验** | v6 迁移、新状态、分类字段、审计表均落地并在隔离库副本上验证；差真实浏览器体验 |
| T2 管理操作与服务端授权 | **待体验** | 分类/归档/选项接口 + 管理页面板、跨项目清理、迟到响应丢弃、锁定与审计已实现并验收（浏览器） |
| T3 归档快照、标签与安全恢复 | **待体验** | 快照固定、工作区级标签关联+读回、幂等与防重放、needs_review 语义已实现并自动化验收；差真实 Kaneo 兼容性 |
| T4 验证与标准接入文档 | **待体验** | 自动化 246 项 + 迁移 6 项 + 浏览器 44 项全绿；文档与 Vue 示例已更新 |

## 交付清单（按文件）

### 数据层（T1）

- `apps/server/src/db/db.ts`
  - 新增迁移 6（事务内）：重建 `feedbacks` 以扩展状态 CHECK 并加入分类/授权字段；
    新增 `feedback_audit` 操作审计表；旧数据接管 `received`/`processing`（未发生远端写入）→ `needs_info`。
  - 重建表前显式 `PRAGMA foreign_keys=OFF`（node:sqlite 默认开启外键，否则 DROP 会级联删除附件），
    迁移后恢复原值；附件、任务链接与 `archive_data_json` 原样保留。
- `apps/server/src/db/repos.ts`
  - `FEEDBACK_STATUSES`、`needs_info`/`ready_to_archive`；分类字段解析与完整性判定；
    `classificationLocked`（已授权 / 已归档 / 归档中 / 已知远端任务）；
    `saveClassificationInTx`（版本乐观锁 + 状态推进）、`authorizeArchiveInTx`
    （版本比较、固定快照、审计、同 `operationId` 幂等重放）、`finishAiOrganization`、
    审计读写、`findResumable` 返回**仅已授权**的 `ready_to_archive`。

### 归档快照与 worker（T3）

- `apps/server/src/pipeline/archive-data.ts`：恢复数据升级到 **v3**，`target` 增加
  `columnId/columnSlug/labelIds/assigneeId`，新增 `labels` 记录（`not_sent`/`maybe_sent`/`confirmed` + `taskLabelId`）；
  严格校验、序列化、`normalizeToV3`、兼容读取 v1/v2/legacy/损坏/未知版本。
- `apps/server/src/pipeline/worker.ts`
  - `processLocked` 拆成「AI 阶段」与「归档阶段」：AI 阶段只整理内容，结束即 `needs_info`（**不归档**）；
    AI 失败保留原文、标题回退首行、`processed_json` 保持 NULL，并可用 `retry` 重跑 AI（仍不归档）。
  - `archive()` 入口新增**授权门槛**：没有 `archive_authorized_at` 且没有任何远端写入痕迹时拒绝写入；
    旧版本已开始远端写入的记录仍可沿既有恢复入口继续。
  - 归档目标一律取自**授权快照**；授权后修改软件配置不会重定向。
  - 新增标签阶段：只接受工作区级标签，先落盘 `maybe_sent` 再关联，写入后 `listTaskLabels` 读回确认；
    确定失败 → `failed`（可重试，复用原任务），结果不确定 → `needs_review`，绝不重复建任务。
  - `isFullyArchived` 扩展为「任务 + 全部标签 + 截图 + 全部日志」全部确认；`recheck` 增加只读标签核对。
  - `resume` 只重新入队 `received`/`processing` 与**已授权**的 `ready_to_archive`。

### Kaneo 契约（T3，按 Kaneo 源码只读核对）

- `apps/server/src/services/kaneo.ts` / `kaneo-http.ts`：新增
  `listColumns(projectId)`、`listWorkspaceLabels(workspaceId)`（`GET /label/workspace/{id}`）、
  `listTaskLabels(taskId)`（`GET /label/task/{id}`）、`attachLabelToTask`（`PUT /label/{id}/task`）、
  `listWorkspaceMembers(workspaceId)`（`GET /workspace/{id}/members`）；
  `createTask` 支持可选 `userId`，未选择时**省略该字段**。

### 管理接口（T2）

- `apps/server/src/routes/admin.ts`
  - `GET /api/admin/feedback/options?projectId=`：实时读取项目列 / 工作区级标签 / 成员。
  - `POST /api/admin/feedback/:id/classify`：`action=save`（暂存，零远端写入）/
    `action=archive`（重新校验 Kaneo 选项 → 事务内版本比较 + 固定快照 + 审计 + 入队）。
    错误语义：`422 incomplete_classification` / `invalid_classification`、`409 version_conflict` /
    `classification_locked` / `already_authorized`、`502 kaneo_unavailable`。
  - 详情新增 `classification` / `classificationLocked` / `archiveAuthorized*` / `audit`；
    列表状态筛选支持全部 8 个状态；`force-create` 现在要求已有归档授权。
- `apps/server/src/routes/feedback.ts`：`retry` / `resolve` / `recover` 的**操作审计**落库。

### 管理页（T2）

- `apps/admin/src/api.ts`：新状态文案、分类/选项/审计类型、审计动作文案。
- `apps/admin/src/views/FeedbacksView.tsx`：新增「人工分类与归档」面板 ——
  项目/列/标签/负责人选择，「保存」与「保存并归档」，软件默认项目与列**仅首次预填**，
  切换项目立即清空列/标签/负责人并用**请求序号 + 项目校验**丢弃迟到响应，
  锁定记录只读展示，归档后延迟刷新以显示最终状态与 Kaneo 链接，详情展示操作审计。

### 验证与文档（T4）

- 新增 `apps/server/test/classify-archive.test.ts`（22 项）、`apps/server/test/migration-v6.test.ts`（6 项）。
- 新增 `e2e/run_classify_archive_browser.py`（真实浏览器，44 项断言）+ 扩展 `e2e/mock-external.mjs`
  （工作区标签、任务标签、成员、项目列表、可延迟的列响应）。
- 更新 `docs/api.md`（状态机、新接口）、`docs/integration.md`（1.5 人工归档流程、Blog 最小接入清单、
  8.2/8.3 症状）、`README.md`、`examples/vue`（深色模式、菜单调用、人工归档说明）。

## 验证证据

### 1) 自动化（mock AI/Kaneo，无真实外部服务）

```
cd apps/server
npx vitest run      → Test Files 15 passed (15) / Tests 246 passed (246)
npx tsc --noEmit    → exit 0
npx biome check src test → 0 errors（25 条既有风格 warning）

仓库根
pnpm -r typecheck   → 8/8 项目通过（admin / server / updater / web / ssr / react / vue / flutter-storage-matrix 之外的适用项）
pnpm -r lint        → 0 errors
pnpm -r build       → 通过（admin / server / updater / web / 示例）
pnpm -r test        → apps/server 246 项通过（其余包的 test 为占位/空脚本）
```

未执行：`flutter analyze` / `flutter test` —— 本机**没有安装 Flutter/Dart 工具链**
（`flutter: command not found`），且本轮未改动 `flutter/**` 与 `packages/web/**`，属未验证项（见下表）。

覆盖点（`classify-archive.test.ts`）：缺分类提交与附件保存、AI 失败原文回退、
服务端拒绝不完整归档（422、零远端写入）、完整暂存零写入、项目/列/标签校验（422）、
授权后配置变化不重定向、可选负责人（带/不带 `userId`）、分类锁定、
重复点击与请求重放（同 `operationId` 幂等 / 不同 `operationId` 409 / 并发只建一个任务）、
详情审计、选项接口过滤、标签关联成功/不确定/确定失败/标签被删、重启扫描不绕过门槛、
重启恢复已授权记录、快照可回读、普通保存零写入。

### 2) 迁移（隔离副本，**绝不**直接启动新版服务迁移真实库）

```
# 真实 v3 数据库的 VACUUM INTO 一致性备份 → 隔离目录
npx tsx /tmp/fb-mig/check.mts
  BEFORE v3 26 行 / 12 截图 / digest ae5207…
  AFTER  v6 26 行 / 12 截图 / digest ae5207…（一致）
  foreign_key_check 违规 0；重启后 user_version=6、内容不变
```

`migration-v6.test.ts` 另覆盖 **v3 / v4 / v5** 三种历史版本与各历史恢复状态
（legacy `assetUrl`、v1、v2、损坏 JSON、未知版本 99）以及 `received`/`processing`/`failed`/
`needs_review`/`archiving`/`archived` 的接管规则：未发生远端写入的 `received`/`processing` → `needs_info`，
其余状态与 `archive_data_json` 原样保留，附件与外键完整。

### 3) 浏览器（真实管理页产物 + 真实服务进程 + mock Kaneo/AI）

```
python3 e2e/run_classify_archive_browser.py
  → 通过 44 / 44；报告 e2e/shots/classify-archive/report.json；截图 11 张
```

断言包括：状态筛选含全部 8 个状态；按「需要补充信息」/「已归档」/「失败」筛选；
详情分类面板与默认预填（标签不自动选择）；缺项时归档按钮禁用；
切换项目立即清空列/标签/负责人；**迟到的旧项目响应被丢弃**（mock 侧故意延迟 1.5s，不同项目返回不同列）；
完整暂存 → 待归档且零远端写入；保存并归档 → Kaneo 收到 1 个任务（真实列 slug `triage`、
项目为授权时选择的 `p-e2e`、关联 1 个工作区标签、未选负责人时省略 `userId`）；
详情出现 Kaneo 链接与操作审计；归档后分类锁定（输入禁用）；人为制造确定失败后出现「重试处理」恢复入口。

## 未验证 / 需要真实环境才能确认（诚实边界）

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 Kaneo 的标签与成员接口 | **未验证（BLOCKED）** | 契约按 Kaneo 源码只读核对（`GET /label/workspace/{id}`、`GET /label/task/{id}`、`PUT /label/{id}/task`、`GET /workspace/{id}/members`、`POST /task/{projectId}` 的 `userId`），**未**对真实实例调用；本轮不允许改动 Kaneo |
| 真实 Kaneo 上「工作区级标签关联后生成任务级新 ID」的读回行为 | **未验证** | 源码语义如此（workspace 标签插入任务级副本），需真实实例复核 |
| 真实 AI / 真实模型的整理回退表现 | **未验证** | 自动化与浏览器均使用 mock AI |
| Flutter 端提交契约回归 | **未验证** | 本轮未改动 Flutter 包；本机无 Flutter/Dart 工具链，`flutter analyze` / `flutter test` **未执行**；仅回归了服务端契约与 Web 提交路径（`accounts-quota` / `feedback` / `external-clients` 测试） |
| 真实宿主（Blog / RAG 等）照新流程接入 | **未验证** | 未修改任何宿主仓库 |
| 旧数据在真实生产库上的迁移 | **待执行（需你确认窗口）** | 已在真实库的**一致性备份副本**上验证；原库未被新版服务迁移 |

## 边界遵守情况

- 仅修改 Feedback 仓库；保留既有未跟踪目录（`.zcode/`、`e2e/flutter_matrix/out/`、
  `e2e/flutter_native/out/`、`e2e/shots/t2a/` 未动）。
- 未修改线上配置、宿主应用或 Kaneo；未提交真实反馈数据；未推送、未部署。
- 新增未跟踪产物：`apps/server/test/classify-archive.test.ts`、`apps/server/test/migration-v6.test.ts`、
  `e2e/run_classify_archive_browser.py`、`e2e/shots/classify-archive/`（验证截图与报告）。
