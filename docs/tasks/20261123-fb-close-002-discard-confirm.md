# FB-CLOSE-002：关闭反馈面板前确认「放弃这次反馈？」

- 任务编号：FB-CLOSE-002；项目：personal-feedback
- 分支：main（就地实现；基线 `1427c10`，v0.14.0 已发布）
- 状态：实现中（两端已实现并通过组件测试；未提交、未发版、未真机验证）

## 1. 背景

FB-CLOSE-001 / 0.14.0 把「关闭反馈面板」定成**放弃本次未提交的反馈**（清正文、截图、图片、日志）。
用户提出：既然关闭即丢弃，误触关闭 / 误按安卓返回就会把刚写的东西一起丢掉，应该在关闭前提醒。

## 2. 已确认的处理口径

| 项 | 规则 |
|---|---|
| 触发条件 | 面板里有**用户亲手写 / 加**的内容：正文去空白后非空；手动添加或**编辑过**的图片；手动添加的日志 |
| 不触发 | 只有自动截图（`capture` 且未编辑）或自动采集的日志（`source=auto`）——它们每次呼出都会产生，否则「打开看一眼再关」也要弹窗 |
| 触发入口 | 关闭按钮、Esc、宽屏遮罩、安卓返回（Flutter `didPopRoute` / Web `handleBackPressed`） |
| 不触发 | 宿主的程序化关闭（Flutter `controller.close()` / Web `close()`）与内部流程（身份切换、提交后重置、捕获相关） |
| 结果 | 「继续编辑」留在面板、内容原样；「放弃」才关闭并按 0.14.0 语义丢弃 |

## 3. Flutter 改动

- `lib/src/panel.dart`：新增只读 `hasAbandonableWork`（正文 / 非 capture 图片 / 手动日志）与 `confirmDiscard()`
  （复用面板既有 `_showPanelDialog`，Navigator 与兜底 Overlay 两条路径都可用；Esc = 继续编辑，点遮罩 = 继续编辑，
  初始焦点在「继续编辑」）。
- `lib/src/widget.dart`：`_close()` 改为 `_requestClose()`——有用户内容先 `panel.confirmDiscard()`，确认后才失效捕获会话并
  关闭；新增 `didPopRoute()` 接管安卓返回（面板打开时返回 true，不再把返回交给宿主路由）。
- 测试：新增 `test/close_confirm_test.dart` 7 例（只有自动截图不弹、正文弹并继续编辑/放弃、Esc、宿主 close 不弹、
  手动日志、手动图片、安卓返回）；`capture_test_utils.dart` 新增 `confirmDiscardIfAsked` 供既有用例补确认步骤；
  受影响 4 个测试文件共 12 处补点「放弃」。

## 4. Web 改动

- `src/element.ts`：新增 `requestUserClose()` / `hasUserContent()` / `openCloseConfirm()` / `dismissCloseConfirm()` /
  `cancelCloseConfirm()` / `confirmCloseDiscard()` / `trapCloseConfirmFocus()`；关闭按钮、面板内 Esc、`handleBackPressed()`
  改为 `requestUserClose()`；公开 `close()` 仍是程序化立即关闭（开场先收起确认层）。
- 确认层挂在 shadow root（面板有 `transform` + `overflow:hidden`，`fixed` 会被裁掉），`role=dialog` + `aria-modal`
  + `aria-labelledby/describedby`，初始焦点「继续编辑」，取消后焦点回到打开前控件；键盘只放行 Esc/Tab/Enter。
- `src/styles.ts`：沿用既有令牌与 `.fb-btn-secondary`，遮罩 `rgba(0,0,0,.45)` + `blur(6px)`，层级高于日志/放大预览。
- 测试：新增 `test/close-confirm.test.ts` 9 例；`host-bridge.test.ts` 的「三级层级退出」按新语义改写。

## 5. 已知限制

- Flutter 组件挂在 Navigator 之外（`MaterialApp.builder`）：宿主仍有可 pop 的路由时，系统可能先 pop 宿主页面、
  组件收不到这次返回。此时需要宿主自己在返回前调用 `controller.close()`。

## 6. 验证

- Flutter：`flutter test` **711/711 通过**；`flutter/feedback` 与 `examples/flutter` 的 `flutter analyze` 均无问题。
- Web：`pnpm --filter @feedback/web test` **45 文件 / 743 用例通过**；`tsc --noEmit` 与 `lint` 通过。

## 7. 未验证 / 遗留

- 未在真机复验弹窗手感、遮罩观感与安卓返回序列（状态：待体验）。
- 未跑真实浏览器 / e2e。已知需按新交互更新的旧断言：`e2e/browser_paths.py:728-731`（P3 Esc 关闭）、
  `browser_paths.py:977-979`（P5 关闭按钮）、`browser_paths.py:992-997`（P5 旧「重开保留草稿」断言，0.14.0 起已过时）。
- 未提交、未发版：`CHANGELOG.md` 已加 `[未发布]` 段落；版本号与 Release 按后续指令。
