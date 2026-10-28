# Feedback 开发约定

<!-- development-workflow:begin v1 -->

## 统一开发流程（2026-10-24）

```text
Project-ID: personal-feedback
Worktree-Root: /Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback
```

- 项目标识：`personal-feedback`。优先沿用外部任务编号；否则在任务记录内分配项目内唯一编号。任务编号对应整项工作，计划内 T1/T2 对应步骤，不混用。
- 新 worktree：`/Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback/<YYYYMMDD>-<type>-<task-id>-<slug>/`；默认分支 `<type>/<YYYYMMDD>-<task-id>-<slug>`。创建前核对工作区、`git worktree list`、基线及归属。日期使用创建时台北日期，跨天不改名；英文部分小写连字符。旧工作树与自动化旧路径不迁移、改名或清理，新建任务遵守此规则。
- 一个任务保留一份权威记录，优先维护原计划，新记录放 `docs/tasks`。记录目标与范围、已确认决定、分支/worktree/合入目标、验收场景、代码版本、验证与未验证项、遗留及必要运行资源。恢复前核对路径、HEAD、索引/未提交改动和下一步，不能沿用失效的通过结论。
- 普通实现选择自主完成；超出已授权范围的业务行为、公共接口、重要兼容性、数据或费用变化，先说明影响并解决决定。不顺手扩大重构，不改验收目标来迁就实现。
- 正式提交围绕一个可解释的功能变化，说明原来/现在、原因、关键实现及实测。提交前核对暂存差异，排除已有无关改动；提交、推送、合并、发布、生产操作分别沿用已有授权，本段不新增权限。
- 修改测试预期、删/跳用例或降低检查强度须说明依据。未运行写未运行，必要验证缺失不能算完成；证据绑定代码版本与环境。并行时先明确共享接口、文件唯一写入者及端口/数据目录/进程归属，主 agent 验证最终组合态。
- 状态只用“未开始、实现中、待体验、已验收”。适用验证完成后待体验，用户明确确认后才已验收；合并/发布另记。合并且验证通过后，在同一任务内按数据保全规则清理本任务已完成 worktree；无独有/未保存成果、运行任务或必要路径引用才可移除，需保留的未跟踪/忽略文件先作可核验恢复备份，不强删，不影响其他任务；远端分支删除须有明确授权。
- 架构入口见下文，职责/调用链/数据流变化时更新原说明。仅明确调用 `$mentored-development` 才在指定范围逐函数带教；普通开发连续推进。通用细则：`/Users/sakurasep/.codex/guidance/development-workflow.md`；任务模板：`/Users/sakurasep/.codex/templates/development-task.md`。更严格的项目数据、验证和发布规则继续适用。

<!-- development-workflow:end -->

## 项目入口与验证

- 结构入口为 [README.md](README.md)，HTTP 契约见 [docs/api.md](docs/api.md)，宿主接入见 [docs/integration.md](docs/integration.md)。调用链：`packages/web/` 或 `flutter/feedback/` → `apps/server/src/app.ts` → `src/db/` 与 `src/pipeline/`；管理页在 `apps/admin/`，服务入口为 `apps/server/src/index.ts`。
- 保留独立组件与宿主的边界；涉及组件升级时按现有接入文档核对版本及产物。服务数据落在 `FEEDBACK_DATA_DIR`，启动前确认本任务的配置与独立数据目录，不复用真实运行库进行测试。
- 根 `package.json` 定义 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`；按受影响包选择检查。服务测试为 `pnpm --filter @feedback/server test`，Web 组件测试为 `pnpm --filter @feedback/web test`，定义分别在对应 `package.json`。
- `apps/admin/package.json` 的 `test` 只是提示后退出成功，不含管理页行为断言；根 `pnpm test` 通过不能证明管理页用户流程。管理页、截图遮挡、登录、提交与追踪按相关 `e2e/` 场景进行浏览器验证。
- 本地启动入口为 `pnpm --filter @feedback/server dev`（README 与包脚本）；管理页需对应的构建产物。测试前检查临时数据与 mock 边界；真实 AI、Kaneo 归档、外部账号、Flutter 各平台和生产发布分别按授权验证。历史 [VERIFICATION.md](VERIFICATION.md) 与 closeout 文档需核对版本后使用。
