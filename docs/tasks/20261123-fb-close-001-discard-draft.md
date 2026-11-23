# FB-CLOSE-001：关闭反馈页即放弃本次未提交反馈

- 任务编号：FB-CLOSE-001；项目：personal-feedback
- 分支：main（就地修复；基线 `1c56806`，未新建 worktree）
- 状态：实现中（Flutter 与 Web 两端已实现并通过各自测试；Web 浏览器 e2e 场景待更新、真机待体验）

## 1. 问题与根因

用户报告（手机端 Flutter 宿主）：用灵感球截了一张图，没有提交，手动关闭了反馈页；再次唤醒灵感球时**直接回到刚才那条反馈**（旧截图还在），期望是「开始新的反馈」。

根因（基线 `1c56806`）：

1. `FeedbackWidget._captureAndOpen()`（`flutter/feedback/lib/src/widget.dart:1980`）先查 `_panelHasDraftContent()`：面板已持有正文、图片（含自动截图）或日志时**不再截图**，直接 `_open()`。
2. `FeedbackPanelState.didUpdateWidget()` 的关闭分支（`panel.dart:1009`）只取消登录接续与额度定时器，注释明确写着「不动草稿与截图」——面板常驻（`maintainState: true`），关掉后草稿原样留在内存里。
3. 两者叠加：关闭的截图与文字成了「草稿」，下一次点击/唤醒灵感球被守卫拦下，于是恢复旧面板而不是开始新反馈。Web 端 `packages/web/src/element.ts` 的 `isDraftDirty()` 与 `close()` 是同一套语义。

## 2. 已确认决定

用户裁决（本轮问答）：「关闭即放弃本次反馈」——清空本次自动截图、图片、日志与文字，下次唤醒重新截图、空白开始；已知代价是误关闭会丢已输入文字。客户端为 Flutter App，Web 端按一致性补齐。

据此确定的新语义（两端一致）：

- 关闭面板（关闭按钮 / Esc / 宽屏遮罩 / 宿主 `close()` 或 `visible: false`）= 放弃本次未提交的反馈：清空正文、截图、手动图片、日志，面板回到「新建反馈」撰写页，并清掉上一次提交留下的任务态（feedbackId、幂等键、冻结快照、错误与等待提示、轮询）。
- 保留：访问令牌与登录态、额度、我的反馈数据、服务地址与各家设置、历史对话的回复草稿（切回撰写页前先保存）。
- 已经发出的提交请求不撤回：关闭只清本地草稿。
- 非关闭的中断保留草稿：截图失败、重拍取消、提交失败（Class A/B）、401 回登录态、额度用尽。
- 草稿守卫本身保留：面板**仍打开**且已有内容时，宿主主动 `captureAndOpen()` 不覆盖正在编辑的内容。

## 3. 改动

Flutter（`flutter/feedback`）：

- `lib/src/panel.dart`：新增 `_discardUnsubmittedDraft()`，在 `didUpdateWidget` 的 `visible: true → false` 分支调用；清空正文 / 图片（含 capture 槽位）/ 日志 / 提交任务态 / 登录表单标记，切回撰写页并保存回复草稿。
- `lib/src/widget.dart`：仅补注释，说明草稿守卫在关闭生效后的实际作用范围；行为未改。
- 测试按新语义更新（原用例都把「关闭后草稿仍在」当既有事实）：
  - `test/draft_capture_guard_test.dart`：重写为「关闭即放弃（重新截图 / 正文清空）」「面板仍打开时 captureAndOpen 不重拍」「关闭后拖动进入选区」「重拍取消 / 重拍失败保留草稿」。
  - `test/feedback_widget_test.dart`、`test/hostless_overlay_test.dart`、`test/capture_lifecycle_test.dart`、`test/login_quota_lifecycle_test.dart`：关闭后重开断言由「草稿保留」改为「空白撰写页」，其余断言（面板常驻、迟到登录不写令牌、不自动提交）保留。
  - `test/orb_idle_test.dart`、`test/orb_lens_restore_test.dart`、`test/orb_liquid_flow_test.dart`、`test/wake_widget_test.dart`、`test/capture_region_selection_test.dart`：把「关闭 → 唤醒 → 拖动」的旧预期改为从空白开始的新截图；回复草稿仍保留的断言保留。

Web（`packages/web`）：

- `src/element.ts`：新增 `discardUnsubmittedDraft()`，在 `close()` 中面板确实打开（`openState === true`）时调用：停轮询、`phase='idle'`，清 `feedbackId / 幂等键 / 冻结快照 / 结果未知请求 / 错误与等待提示`，`textarea.value=''` + `clearDraft()`（截图、手动图片、日志，释放对象 URL，`logsCollected=false`），收起登录表单与提示，`switchTab('compose')` 后 `syncUi()`。面板未打开时 `close()` 保持「只取消进行中的截图」语义。
- 「再记一条」`resetToCompose()` 改为复用同一重置路径，避免两条「放弃未提交反馈」逻辑分叉。
- 测试：`capture-entry.test.ts` 新增 2 条回归（关闭后重新截图 / 已提交回执关闭后回到新建且额度保留）；按新语义更新 `capture-entry`、`feedback-logs`、`orb-snapshot`、`region-flow`、`wake-flow` 中依赖「关闭保留草稿」的用例。

文档：`docs/integration.md` 4.3 行为细节、API 表关闭一行、5.4 Flutter 交互约定；`flutter/feedback/README.md`（守卫、重拍、草稿与提交三处）；`packages/web/README.md`（`close()`、`captureAndOpen()`、行为摘要草稿一条）；`examples/flutter/test/widget_test.dart` 一条 reason 文案。

## 4. 已知副作用与取舍

- 面板内「重新截图」成为同一会话里唯一的重拍入口（关闭后再拖灵感球同样是「新反馈」的重截）。
- `_captureForSelection()` 里「5 张图片上限 → 提示整理附件、不发起捕获」的前置检查在当前 UI 路径下已不可达（关闭会清空图片，拖动前不可能已有 5 张）；代码作为防御保留，对应测试改为验证「关闭后上限解除、可重新发起选区捕获」。

## 5. 验证

- `flutter/feedback`：`flutter test` **704/704 通过**（Flutter 3.41.3）；`flutter analyze` **No issues found**。
- `examples/flutter`：`flutter test` **40/40 通过**。
- `packages/web`：`pnpm --filter @feedback/web test` **44 文件 / 734 用例通过**；`tsc --noEmit` 与 `lint` 通过。

## 6. 未验证 / 遗留

- 未在真机（Android 宿主）复验「截图 → 关闭 → 再次唤醒」的视觉与手感，需真机验收。
- Web 浏览器 e2e（`e2e/run_browser.py`、`e2e/browser_paths.py`、`e2e/pages/capture-styles.html`）仍有若干断言按旧语义写成「关闭后草稿 / 截图仍保留」，本轮**未运行、未修改**：`run_browser.py` T3、`browser_paths.py` P1 / P3 / P5、`capture-styles.html` 重拍取消一段。下次跑 e2e 前需按新语义更新并执行。
- 未发版本前的本地验证已完成；v0.14.0 发布记录见 §7。
- 生产（blog-prod）与管理页资产尚未升级：发布产物已就绪，升级需单独授权。
## 7. 发布 v0.14.0（2026-11-23）

- 版本收口：`package.json`、`apps/server`、`apps/admin`、`packages/web`、`flutter/feedback/pubspec.yaml` 统一为 **0.14.0**；
  `CHANGELOG.md` 增加 `[0.14.0] — 2026-11-23`；接入指南与根 README 的固定版本引用同步到 0.14.0。
- 提交：`e5007ef`（关闭即放弃 + 接入要求 + 测试与文档）、`b8c0065`（版本与 CHANGELOG）；签名标签 `v0.14.0` 指向 `b8c0065`（GPG Good signature），已推送到 `origin/main`。
- Release 流水线 [45141707519](https://github.com/SakuraLoveSmile/Sakura-Feedback/actions/runs/45141707519) 全部 job 成功；[v0.14.0](https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/tag/v0.14.0) 已公开、Latest。
- 资产七份齐全（`feedback-web-0.14.0.tgz`、`feedback-web-dist.zip`、`feedback-admin-dist.zip`、`SHA256SUMS`、`SOURCE.txt`、`feedback-image-digest.txt`、`release-manifest.json`）；`shasum -a 256 -c SHA256SUMS` 三份产物 OK；tgz 内 `version` 为 0.14.0。
- `release-manifest.json`：version/tag/commit 为 0.14.0/v0.14.0/`b8c00653…`，channel stable，schema **15**，digest `sha256:3709a164…`；GHCR `v0.14.0` 与 `latest` 同一 digest。
- 生产升级未执行（等待授权）：可用 `bash deploy/update.sh --to v0.14.0` 走「预拉 → 校验 digest → 备份 → 切换 → 健康检查」流程；schema 未变，回退只需改回旧镜像标签。
