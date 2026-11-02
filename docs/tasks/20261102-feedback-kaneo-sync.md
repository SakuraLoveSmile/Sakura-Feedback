# FB-20261102-KANEO-SYNC：Kaneo 完成状态回读与历史回溯

- 项目 / 任务编号：personal-feedback / FB-20261102-KANEO-SYNC
- 状态：实现中（代码与自动化验证完成，待发布/部署与生产回溯确认）
- 创建日期（Asia/Taipei）：2026-11-02
- 主仓库 / 当前工作目录：`/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`（main）
- 分支 / 合入目标：工作区未提交改动 → 待确认发布路径（正式发版或本地构建部署）

## 目标与范围

用户反馈「很多任务其实已经解决了，但没有给用户反馈到」。本轮做两件事：

1. **补历史**：已归档、关联 Kaneo 任务且任务已进入完成列的历史反馈，回溯置为「已解决」并给提交者写入可见的系统处理说明（产生未读）。
2. **Kaneo 完成状态回读**：Kaneo 任务进入项目 `isFinal` 完成列时，自动/手动把反馈问题状态置为 `resolved`、写入系统说明并通知用户；管理端提供单条与批量同步入口。

不含：邮件/IM 等外部通知渠道；Kaneo 侧写入；Flutter/Web 组件行为改动（复用既有系统消息与未读机制）。

## 已确认决定

- **判定依据**：只认 Kaneo 列 `isFinal === true`，不按列名/归档状态推断；任务响应需带 `status` 与 `projectId`。
- **自动范围保守**：仅自动处理 `issue_status = open`、已归档、有任务、非回收站的反馈；`waiting_user`/`waiting_admin` 的人工对话不自动关闭；已 `resolved` 不重复写入。
- **管理端可显式覆盖**：单条「同步看板状态」允许对非 `open` 记录同步；批量入口只处理自动候选。
- **用户可见文案**：系统消息与 `resolutionNote` 均为「任务看板中的对应任务已完成，问题已标记为已解决。」（如用户要求可改）。
- **通知边界**：仅应用内未读 + 对话时间线；无邮件/推送（沿用 v11 契约）。
- **自动扫描**：默认 10 分钟，`FEEDBACK_KANEO_SYNC_INTERVAL_MS=0` 关闭；每批最多 50 条；首次扫描延迟 60 秒。
- **审计**：`kaneo_status_sync`，actor 显示「系统（Kaneo 同步）」。

## 代码版本与实现

- server：`services/kaneo.ts`（`KaneoColumn.isFinal`、`KaneoTaskRef.status/projectId`）、`services/kaneo-http.ts`（列/任务读取解析）、`services/kaneo-issue-sync.ts`（单条/批量/定时服务）、`db/repos.ts`（候选查询、审计覆盖参数）、`routes/admin.ts`（两个管理端接口）、`env.ts`（`FEEDBACK_KANEO_SYNC_INTERVAL_MS`）、`app.ts`/`index.ts`（服务接线与优雅停机）。
- admin：`api.ts`（两个请求函数 + 审计文案）、`FeedbackDrawer.tsx`（单条入口）、`FeedbacksView.tsx`（批量入口与汇总）。
- 文档：`docs/api.md`、`docs/deployment.md`。

## 验证

- `pnpm --filter @feedback/server test`：447/447 通过（新增 `test/kaneo-issue-sync.test.ts` 8 条：批量通知/未完成不改/已解决不重复/自动跳过人工对话/Kaneo 故障/缺少状态/鉴权与 limit/普通用户通知）。
- `pnpm --filter @feedback/server typecheck`、`lint`（biome，0 error，43 条既有 warning）通过。
- `pnpm --filter @feedback/admin typecheck/lint/build`：通过（管理端由 teammate 执行；lint 仅 1 条既有 warning）。
- 生产数据演练（只读副本，假 Kaneo 状态来自生产 Kaneo DB）：候选 19 条 → 已解决 15 条、跳过 4 条（仍为 in-review/in-progress/to-do）、失败 0；新增 15 条系统消息、15 条 `kaneo_status_sync` 审计；二次运行不重复写入；受影响账号 3 个（各 2/4/9 条未读）。副本已删除。
- 未验证：真实 Kaneo API 端到端（仅用生产 Kaneo DB 真实状态构造假客户端）；真实浏览器按钮体验；移动端表现。发布/部署后需再核验。

## 发布/部署与生产回溯（待确认）

- 生产当前为 v0.7.0（2026-11-02 由 v0.5.2 升级，schema 14）。新功能需新镜像：
  - A. 本地构建镜像部署（不推送、不发版，回退到 v0.7.0 镜像）；
  - B. 正式发版（版本/CHANGELOG/tag/CI 出 GHCR 镜像后升级生产）。
- 回溯方式：部署后自动扫描将在首次（约 60 秒）或手动批量触发时解决 15 条；4 条未完成保持不动。
- 回退：镜像回退 + 数据备份（数据库 schema 不变，本轮无迁移）；回溯写入的系统消息与状态变更如需撤回需单独处理。
