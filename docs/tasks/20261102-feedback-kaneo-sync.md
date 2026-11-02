# FB-20261102-KANEO-SYNC：Kaneo 完成状态回读与历史回溯

- 项目 / 任务编号：personal-feedback / FB-20261102-KANEO-SYNC
- 状态：待体验（v0.8.0 已发布、生产已升级并完成回溯；管理端按钮真实点击与用户观感待确认）
- 创建日期（Asia/Taipei）：2026-11-02
- 主仓库 / 当前工作目录：`/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`（主工作区有其他并发会话，本次在独立 worktree 发版）
- 分支 / 发布：`feat/20261102-fb-20261102-kaneo-sync`（基于 `origin/main` + cherry-pick 37fd109 + 本次改动）→ 标签 `v0.8.0`

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
- **release worktree 组合态（发布提交 693e693）**：`pnpm -r build/typecheck/lint` 通过；server 447、web 618、flutter 组件 636、flutter 示例 38 项通过；flutter analyze 无问题。
- 生产数据演练（只读副本，假 Kaneo 状态来自生产 Kaneo DB）：候选 19 条 → 已解决 15 条、跳过 4 条（仍为 in-review/in-progress/to-do）、失败 0；新增 15 条系统消息、15 条 `kaneo_status_sync` 审计；二次运行不重复写入；受影响账号 3 个（各 2/4/9 条未读）。副本已删除。
- 未验证：真实 Kaneo API 端到端（仅用生产 Kaneo DB 真实状态构造假客户端）；真实浏览器按钮体验；移动端表现。发布/部署后需再核验。

## 发布、部署与生产回溯（已完成）

- **发布**：v0.8.0（2026-11-02）。Release 资产齐全、非 draft/非 prerelease：
  <https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/tag/v0.8.0>；
  镜像 `ghcr.io/sakuralovesmile/sakura-feedback:v0.8.0`，
  digest `sha256:bd8a5bcbe3ebdadc83200405dec9c690c888be36b7d1dcaa875012dba784ff8c`（与生产实际镜像一致）。
  Release workflow run 41418400565 全部 job 成功（含 CI 门禁、flutter 三档存储矩阵）。
- **部署**：生产 compose 由 `v0.7.0` 切到 `v0.8.0`（`/opt/1panel/docker/compose/feedback/`）。升级前做了在线一致性数据库快照（v0.7.0，sha256 `0ea3ed2c…c92f`，integrity ok、25 条反馈）与停服后数据目录 tar，compose 备份于同目录 `backups/`；容器 8 秒恢复 healthy，日志无迁移记录（schema 仍 14）。
- **回溯结果**（部署后首次自动扫描日志）：
  `[kaneo-sync] 检查 19 条：已解决 15，跳过 4，失败 0`。
  数据库核对：`issue_status` resolved 15 / open 10；`feedback_messages` 15 条系统说明（均带 `resolution_note`）；
  `feedback_audit` 新增 15 条 `kaneo_status_sync`；未读分布 3 个账号 2/4/9 条。二次扫描不会重复写入（间隔 10 分钟）。
- **今天那条反馈**（`4696e8f6…`，15:01 提交）：仍为 `ready_to_archive`，没有 Kaneo 任务
  （AI 密钥无效 + 来源待确认，属既有生产配置问题），因此本轮不回溯、保持「待处理」；待归档生成任务并完成后会自动同步。
- **公开核验**：`/healthz`、`/api/features`（dialogue/images）、`/admin/` 均 200；管理端 bundle 含两个新入口文案；
  未登录调用两个同步接口均 401。
- **回退**：镜像切回 v0.7.0 + 恢复备份（schema 未变，无需数据库回退）；回溯写入如需撤回需单独处理。

## 遗留与未验证

- 远端 `main` 尚未合并本发布分支（发版期间主工作区有其他并发会话的未推送提交与未完成改动）；待并发工作收尾后通过 PR 合入。
- 管理端「同步看板状态 / 同步完成状态」未做真实登录后的浏览器点击验证（缺少当前管理员密码）；用户端「我的反馈」未读与时间线由自动化测试 + 生产数据核对覆盖，待用户体验确认。
- 后续 Kaneo 任务完成将按 10 分钟周期自动同步；如有不希望自动改状态的部署，设置 `FEEDBACK_KANEO_SYNC_INTERVAL_MS=0`。
