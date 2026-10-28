# WIP 归拢提交 · 任务记录

- Project-ID：`personal-feedback`
- 任务编号：`20261028-chore-wip-consolidate`
- 分支：`chore/20261028-wip-consolidate`
- Worktree：`<Worktree-Root>/20261028-chore-wip-consolidate/`
- 合入目标：`main`（走分支 + PR）
- 开始时间：2026-10-28

## 1 目标与范围

把长期堆积在主工作区的 WIP 成果，以 `origin/main` 为基线重建成一条干净分支并按包切片提交。

范围内：

- 89 个已跟踪文件的改动
- 71 个未跟踪源码/文档文件（约 1.1 MB）
- 文档脱敏（本机绝对路径）

范围外：

- 941 张未跟踪截图（91 MB）不入库，改为 `.gitignore` 忽略
- 不做大文件的 hunk 级功能拆分
- 不删除任何既有分支；不改动主工作区

## 2 已确认决定

| 决定 | 内容 |
| --- | --- |
| 基线 | `origin/main@40d6813`，**不** rebase/merge `wip/local-consolidated` |
| 截图证据 | 全部不入库 + `e2e/shots/` 加入 `.gitignore`；已跟踪的 138 张保持现状 |
| 提交粒度 | 按包 8 片 |
| `AGENTS.md` | 脱敏后入库 |
| 交付 | 推分支 + 开 PR |

### 为什么不沿用 `wip/local-consolidated`

- 该分支与 `origin/main` **无共同祖先**（`git merge-base` 返回空）。
- 其已提交树比远端**更旧**：相对 `main` 会删掉 v0.6.0 的 `apps/server/src/assist/manage_routes.ts`（512 行）、`apps/server/test/assist-mgmt.test.ts`（925 行）与 CHANGELOG 条目。
- 远端对历史做过脱敏重写，65 个"本地独有"提交与远端提交标题逐条对应，SHA 全变。
- 结论：待保留成果全在工作区，不在提交历史。

## 3 代码版本与基线

| 项 | 值 |
| --- | --- |
| 主工作区 HEAD（源） | `7a82ebd080fc5e642226b3ea78311575082c2cbf` |
| 新分支基线 HEAD | `40d6813055ec8a0f66b37332ce186920574bc6d5` |
| 主工作区 `git status --short` 条目 | 264（89 modified + 175 untracked 条目） |
| `git diff --stat` | 89 files changed, 24503 insertions(+), 4886 deletions(-) |
| 全量未跟踪文件 | 1012（其中 941 在 `e2e/shots/`，71 为源码/文档） |

## 4 安全网（阶段 0，已完成）

| 项 | 值 |
| --- | --- |
| 快照提交（悬挂，仅 tag 可达） | `50def8a7f4e4c51522325d3cea0f01abe570dd46` |
| tag | `backup/wip-20261028` |
| 快照树 | `a9aed655018c8d561b1cbd925b0a40ce0d814ee9` |
| 快照内 blob 数 | 723（HEAD 652 + 71 未跟踪） |

快照用临时索引（`GIT_INDEX_FILE=/tmp/wip.idx`）+ `commit-tree` 制作，**未触碰**主工作区与真实索引。

导出件：

| 文件 | 大小/行数 | sha256 |
| --- | --- | --- |
| `/tmp/wip-tracked.patch` | 1552508 B | `87cc89eb3b8aa1fe914faa1827a10fd1e9abd8dfa24a3b3a2c4d3088876929ae` |
| `/tmp/wip-untracked-all.txt` | 1012 行 | `a352072f92d161334590aa744dbe2d5fb137530937653be61615db8cc58ea002` |
| `/tmp/wip-untracked-nonshot.txt` | 71 行 | `a8bd18cf44c489691496eabba79f97755e9e3ce9a89b7b9ae85a59e3c0bc42f4` |

`/tmp` 下的导出件会随系统清理消失；权威备份是 tag `backup/wip-20261028`（在仓库对象库内）。

### 阶段 0 验证

| 检查 | 结果 |
| --- | --- |
| 快照 blob 与工作区文件逐一比对 | 723/723 字节一致，0 mismatch（`/tmp/verify-snapshot.sh`） |
| `e2e/pages/sdk` | 符号链接，mode `120000`，目标 `../../packages/web/dist` 已正确捕获；该目标是被忽略的构建产物，当前悬空 |
| 主工作区未被改动 | HEAD / 264 条目 / 0 暂存 / 89 改动 / 1012 未跟踪，均与基线一致 |
| content filter 影响 | 仅配置了 LFS filter，无 `.gitattributes`，LFS 实际未启用，补丁保真 |
| 新分支上游 | 建 worktree 时默认跟踪 `origin/main`，**已解除**，避免误推主干 |

## 5 实际切片

计划 8 片，实际 9 片——`scripts/` 的本地演示安全加固是独立的功能变化，从「任务记录」片中拆出单独提交。

| # | 提交 | 内容 | 提交前验证 |
| --- | --- | --- | --- |
| 1 | `chore` | `.gitignore` 忽略 `e2e/shots/` | `check-ignore` 双向核对 |
| 2 | `feat(server)` | Issue 对话闭环与多图附件契约（迁移 v13/v14） | server 30 文件 / 439 测试 |
| 3 | `feat(web)` | 会话式反馈面板 | web 28 文件 / 359 测试 |
| 4 | `feat(flutter)` | Flutter 对齐 Web 能力 | flutter 360 测试 + analyze |
| 5 | `feat(admin)` | 后台七页体验与对话处理面 | biome check + 生产构建 |
| 6 | `docs` | v11/v12 契约与宿主接入示例 | typecheck 7 项目 |
| 7 | `test(e2e)` | 对话/多图/界面矩阵脚本 | 19 脚本 `py_compile` |
| 8 | `fix(scripts)` | 本地演示独立数据目录与拒绝复用 | `bash -n` |
| 9 | `docs(tasks)` | `AGENTS.md` + 任务记录 | 敏感串扫描 |

## 6 重叠文件（须三方移植）

与远端 v0.6.0 / 脱敏提交同时改动、不能整树覆盖的 13 个文件：

```text
apps/admin/src/ui.tsx
apps/server/src/app.ts
apps/server/src/assist/routes.ts
apps/server/src/db/db.ts
apps/server/test/accounts-quota.test.ts
apps/server/test/assist.test.ts
apps/server/test/lifecycle-v9.test.ts
apps/server/test/migration-v6.test.ts
apps/server/test/migration-v8.test.ts
docs/integration.md
flutter/feedback/lib/src/panel.dart
flutter/feedback/pubspec.yaml
flutter/feedback/test/feedback_logs_test.dart
```

守门条件：`assist/manage_routes.ts` 仍被 `app.ts` 注册，`assist-mgmt.test.ts` 仍在且通过。

## 6.1 迁移号撞号（阶段 1 发现，已处置）

远端 v0.6.0 把 `assist_mgmt_requests` 冻结为迁移 **v12**（`PRAGMA user_version = 12`），
而 WIP 用 **v11**（Issue 对话）+ **v12**（多图附件）。两边对 `user_version = 12` 赋了不同语义。

已发布的 v0.6.0 库停在 `user_version = 12`。若按原号合并，`if (v < 11)` 与 `if (v < 12)`
对这些库全部跳过 → Issue 对话表与多图表永不创建，运行期直接崩。

处置：保留已发布的 v12，把 WIP 的两段顺延为 **v13 / v14**，终态版本号 **14**。

| 迁移号 | 内容 | 来源 |
| --- | --- | --- |
| v12 | `assist_mgmt_requests` | 远端 v0.6.0（已发布，不可改号） |
| v13 | Issue 对话 / 附件 / 已读游标 / Kaneo 撤销任务（契约 v11） | WIP，由 v11 顺延 |
| v14 | 多图附件 / 处理说明 / 撤销 cancelled 态（契约 v12） | WIP，由 v12 顺延 |

- 升级路径：v0.6.0 库（12）→ 13 → 14 ✓；全新库 → 2..10, 12, 13, 14 ✓。
- **契约命名不动**：`docs/api.md` 的「v11 契约 / v12 增量」是 HTTP 契约版本，与 `user_version` 是两条轴。db.ts 注释已写明错开原因。
- 迁移内部的临时表 `*_v12` 一并改名为 `*_v14`，与迁移号一致。
- 连带修正：全部「迁移完成后终态」断言 12 → 14（6 个测试文件）；`migration-v12.test.ts` 模拟的历史库起点 11 → 13。故意构造的中间态断言（8 / 7 / 2）保留不动。
- 已知取舍：本机遗留的 WIP 测试库若停在 12，重开后不会补建 v13/v14 的表。这类库是一次性临时库（项目约定测试不复用真实运行库），不作兼容处理。

## 6.2 三方合并的静默丢失（阶段 1 发现，已处置）

本地 `1bf354a fix: preserve useful changes from retired Feedback branches` 在远端**没有对应提交**
（`ccd99b7` 为空提交，无内容）。它改了 6 个文件：

```text
apps/admin/src/ui.tsx                          flutter/feedback/lib/src/panel.dart
e2e/run_backup_restore.py                      flutter/feedback/test/feedback_logs_test.dart
scripts/start-local.sh                          scripts/stop-local.sh
```

对这 6 个文件，`origin/main` 的内容恰好等于 `1bf354a^`（主干只差这一个提交，无竞争改动）。

两个坑：

1. 其中 3 个（`run_backup_restore.py`、`start-local.sh`、`stop-local.sh`）落在「保留 main 版本」集合里，按原计划会整份丢掉该提交的成果。
2. `ui.tsx` 被 `git apply --3way` 报告为 **cleanly applied**，但结果里 `1bf354a` 的菜单键盘/焦点逻辑**被静默删除**——因为相对补丁基线，main 看起来像「删除了」这段代码，而 WIP 侧未改动同一区域，合并便采纳了这个「删除」。历史被重写、无共同祖先时，`--3way` 的 clean 不等于正确。

处置：这 6 个文件全部改取 WIP 版本（main 无独有内容）。并对其余 7 个自动合并文件逐个核对
「main 独有贡献」与「合并结果 vs 快照差异」是否对应，确认无第二处丢失。

其余 21 个「保留 main 版本」的文件已逐个复核，差异均为 v0.6.0 新能力、版号提升或脱敏，main 确实更新。

## 7 脱敏清单（已完成）

| 文件 | 位置 | 处理 |
| --- | --- | --- |
| `AGENTS.md` | `Worktree-Root` 与新 worktree 路径 | 改 `<WORKTREE_ROOT>` 占位符，并补一条说明该变量按各自环境配置、不写入仓库 |
| `AGENTS.md` | guidance / templates 的本机绝对路径 | 改为「本机 Codex 配置目录下」的相对描述 |
| `docs/integration.md` | 684–686 行本机 flutter 路径 | 远端 `main` 的脱敏版本已覆盖，无需再改 |

逐提交扫描口径：本机家目录绝对路径、真实 Kaneo 域名、内网 IP、设备 UDID、Apple Team ID、密钥样式串。
最终对 9 个提交逐一扫描，无命中。

## 8 状态

| 阶段 | 状态 |
| --- | --- |
| 阶段 0 安全网与 worktree | 已完成 |
| 阶段 1 移植并全绿 | 已完成 |
| 阶段 2 切片提交 | 已完成（9 片） |
| 阶段 3 脱敏收口 | 已完成 |
| 阶段 4 推分支与 PR | 实现中 |

整体状态：**待体验**。自动检查与静态检查已完成；浏览器端用户流程、真实 AI / Kaneo、
Flutter 各平台原生与部署未在本任务验证，需用户确认后才能转「已验收」。

状态口径：未开始 / 实现中 / 待体验 / 已验收。

## 9 阶段 1 验证结果

环境：macOS arm64；Node v24.13.3；pnpm 11.23.0（`~/Library/pnpm/bin/pnpm`，PATH 上的 8.15.4 与
`packageManager: pnpm@11.23.0` 不兼容，不能用）；Flutter 3.47.7 stable（`~/devsdk/flutter`，
不用 PATH 上的 3.41.3）。

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 通过（admin 包体 >500 kB 提示为既有现象） |
| `pnpm typecheck` | 通过（7 个项目）。注：全新检出必须先 build，否则 examples 找不到 `@feedback/web` |
| `pnpm lint` | 通过。43 条 `any` 警告集中在测试文件，与 WIP 原记录一致，非本次引入的错误 |
| `pnpm --filter @feedback/server test` | **30 文件 / 439 测试通过**；日志可见迁移按 v10 → v12 → v13 → v14 顺序执行 |
| `pnpm --filter @feedback/web test` | **28 文件 / 359 测试通过** |
| `flutter analyze`（flutter/feedback） | No issues found |
| `flutter test`（flutter/feedback） | **360 测试全部通过** |
| v0.6.0 守门 | `manage_routes.ts`、`assist-mgmt.test.ts` 在位；`app.ts` 已注册管理路由；`env.ts` 含 `assistMgmtKey`；版本 0.6.0；`assist-mgmt.test.ts` 单独跑 **32 测试通过** |

未验证（本阶段不覆盖）：真实 AI、真实 Kaneo、浏览器 e2e 场景、管理页用户流程、Flutter 各平台原生、
部署与发布。这些按既有授权单独进行。

环境处置记录：

- 首次 `pnpm install` 时 `@img/sharp-libvips-darwin-arm64` 与 `@biomejs/cli-darwin-arm64`
  两个原生包下载失败（网络），只留空目录，导致 25 个服务端测试文件因 `sharp` 加载失败而报错。
  pnpm 的状态缓存认为「已是最新」不会自动补齐，重装无效。处置：删掉空壳目录后从源工作区
  复制同版本包；`pnpm-lock.yaml` 全程未改动。该失败与代码无关。
- `flutter pub get` / `flutter analyze` 会自动向 `flutter/feedback/analysis_options.yaml`
  写入 `exclude: build/**`。该文件在 `origin/main` 与 WIP 两侧都没有这一行，属工具副作用，
  提交前撤销，不随本次成果入库。

