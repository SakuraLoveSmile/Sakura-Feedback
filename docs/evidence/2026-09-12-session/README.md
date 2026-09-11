# 2026-09-12 会话保存说明（反馈：截图＋描述＋日志）

本目录是会话期验证取证的留档，随 worktree 一同保存。

## 仓库结构

| 位置 | 分支 | HEAD | 说明 |
|---|---|---|---|
| `Feedback/`（原目录） | `main` | `083259e` | 已回退至会话开始前状态，工作区干净 |
| `Feedback-feedback-logs/`（本 worktree） | `preserve/feedback-logs-20260912` | 见 `git log -1` | 会话全部工作与取证的快照 |

> `main` 仅回退了**受版本控制**的文件。`dist/`、`build/`、`node_modules/`、`.agent-teams/` 等被 `.gitignore` 忽略，
> 未随回退清理，其中 `dist/` 仍是会话期构建产物；如需与回退后的源码一致，在 `Feedback/` 下重跑 `pnpm -r build`。

## 本轮交付（T1/T2/T3）

- **T1**：Web（`packages/web`）与 Flutter（`flutter/feedback`）打开反馈面板自动附带最近日志，可手动补充、
  预览、移除；采集失败仍可提交截图与描述。
- **T2**：日志与反馈一起保存；管理页可查看与下载；网络失败重试不丢失附件、不重复创建反馈。
- **T3**：AI 结合日志分析并在管理页与 Kaneo 侧保留可下载附件；分析中区分「日志证据」与「推测」；
  日志未归档成功时不显示全部归档完成。

## 验证状态（重要，勿误读）

**T1–T3 均为「实现中」，尚未达到「待体验」，更未「已验收」。**

- 单元/集成证据充分：server 200 tests、web 134、flutter 90（+ examples/flutter 4），均退出码 0。
- **但没有任何一轮真实浏览器端到端验证是在稳定代码状态上完成的。**
  会话期 t7 取证期间工作区被反复写入（`worker.ts`、`panel.dart`、`docs/api.md`、`e2e/*` 等先后落盘），
  那批证据跨了多个代码状态，已判为无效。
- 因此依赖真实浏览器行为的验收项**尚未验证**：草稿关闭重开保留、下载摘要与提交一致、
  归档三态矩阵、以及「截图完成但日志未完成时不得显示全部归档完成」。

## 关键缺陷修复（审查期先行修复，pre-applied）

| 编号 | 严重度 | 内容 | 状态 |
|---|---|---|---|
| **F1** | high | 归档终态响应恒报 `archived`：`worker.ts` 四处 `done ? "archived" : …`，而 `done` 是字符串联合恒为真值；`persist_failed` 被报成 `ok:true/202/archived`（**把落盘失败报告成成功**） | 已修并核实（四处改为 `done === "archived"` + `persist_failed` 早退；路由映射 `502 + error.code`） |
| F2 | medium | 管理页把未做核验的 AI 摘录标为「已证实」（服务端只校验结构、从不逐字比对） | 契约侧与 UI 侧已改；e2e 断言待改 |
| F3 | medium | Flutter 自动采集静默丢弃不合格日志、无提示（违反「不得静默删除或截断」） | 已修并补 4 条用例 |
| F5 | low | 不可解码日志被静默跳过，未按契约留痕 | 已实现：`recordSkippedLog` 写 `seq`+安全文件名+原因进 `error_summary`，**不含日志内容** |
| F6 | low | 契约「`"logs": {}` 判 corrupt」缺少测试锚定 | 已补阴性用例（含「缺省 ≠ `{}`」判别性断言） |
| F4 | — | **误报**：reviewer 引用旧快照所致，契约本已合规，无需修复 | stale-finding |

**F1 的现场证据**：`fb-snap/snap-0251.tar`（tar sha256 `5b28b193…`）内含**修复前**的 `worker.ts`
（sha256 `a12930d8…`，四处 `done ? "archived"`）。这是证明该缺陷确曾存在的独立依据；
修复后的行为（`202 + needs_review` / `502 + persist_failed`）见 `failing-first-late.txt` 与测试用例。

## 未完成事项

1. **e2e 断言去硬编码**：`e2e/browser_logs.py` 中 `check(... "已证实" in evtext ...)` 把一句系统并未保证的
   声明固化成了测试期望。F2 文案落地后该断言必然失败，需改为按 `data-testid="diag-evidence"/"diag-causes"`
   定位 + **限定作用域的反断言**。注：该文件行号已漂移四次，**必须按文本锚定**，勿按行号。
2. **t7 完整重采**：需在**单一冻结状态**上跑一次完整端到端验证（8 条验收 + 三态矩阵 + 响应头专项）。
3. **t8 评审 / t9 整合**：尚未进行。F1/F3/F5/F6 的修复属「审查期先行修复」，
   正式 finding 与 `sourceFindingId` 未产生（`repair` 类任务要求该字段，故这批以 work 任务执行）。
4. **真实 AI / Kaneo 调用**：本轮全部使用 mock，**未**对真实服务验证。
5. **Flutter 原生文件选择器弹窗**：未验证。

## 已知缺口（如实标注，非失败项）

- `feedback_logs.log_blob` 为 `NOT NULL`，故 F5 的「落库字节缺失」分支无法真实构造，有代码无用例。
- 管理页「按 `logId` 的日志级手动恢复」入口未暴露（接口已支持），文档标「实现中」。

## 取证文件索引

| 文件 | 内容 |
|---|---|
| `fb-snap/snap-0251.tar` | 修复前 23 个关键文件快照（含带 bug 的 `worker.ts`） |
| `w4.bak` | 修复前 `worker.ts` 单文件副本（与快照交叉验证用） |
| `failing-first.txt` | 早期「先失败后修复」原始取证（38 failed / 5 passed） |
| `failing-first-late.txt` | 后续失败留档与阴性对照（含 F1 五条失败输出） |
| `verifier_*.log/txt` | verifier 的构建前后 dist 指纹与套件输出 |
| `t2-*.log` | t2 三条门禁日志 |
| `fb-manifest.json` | 早期 manifest |

> 注意：`failing-first-late.txt` 的 mtime（02:56）**晚于** F1 修复时刻（02:52:37），
> 其中的 F1 失败输出**不得**定性为「自然前置失败」——它是变异式对照（mutation control）
> 或修复前副本的复跑，具体流程由 backend-engineer 说明。缺陷成立与否**不依赖**该文件，
> 以上文的快照哈希与类型分析为准。

## 如何继续

```bash
cd "/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback-feedback-logs"
pnpm install          # worktree 无 node_modules（被 .gitignore 忽略，未随快照复制）
pnpm -r test && pnpm -r typecheck && pnpm -r lint && pnpm -r build
```

若要恢复为工作分支：在原目录 `git checkout preserve/feedback-logs-20260912`（需先移除本 worktree，
或用 `git worktree move`）。若要丢弃保存：`git worktree remove <路径>` 后删除分支。
