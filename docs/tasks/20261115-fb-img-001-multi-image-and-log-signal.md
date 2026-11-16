# FB-IMG-001 多图附件仅能上传一张 · 日志接入运行时信号

- 状态：待体验。目标：修掉「只能上传一张图片、无法继续添加」，并让「宿主未接入日志采集」在运行时可被看见。
- 已确认：用户原话「目前好像只能上传一张图片，没办法增加上传，修复一下。此外，feedback 强制宿主接入的时候必须提供日志收集」。日志要求仍按 FB-LOG-001 / `docs/integration.md` 5.6：强制的是接入能力，偶发无日志（暂无事件、采集超时/失败、用户移除）仍可提交。
- 工作区：主工作区 `/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`；分支 `main`，基线 HEAD `f466f3c`（本地 0.7.0，落后 origin/main 20 个提交）。未新建 worktree，未提交、推送、发布或部署。
- 开工前已有未提交改动（`apps/admin/src/*`、`docs/integration.md`、`packages/web/README.md`、`flutter/feedback/README.md`、`packages/web/src/capture.ts`、若干 e2e 脚本与 `docs/tasks/` 记录）保留原样；本次只追加相关行。

## 根因

1. Web 组件（`packages/web`）多图本来就是对的：能力未知时 `maxImages = MAX_IMAGES(5)` 乐观放行，只有服务端**明确返回 `capabilities` 而缺 `images`** 才单图降级。真实浏览器复跑（陈旧 `examples/html/feedback-web.umd.js` 与当前 dist 两侧同表）都能连加 3 张，无复现。
2. Flutter 组件（`flutter/feedback`）确有缺陷且自 v0.7.0 起一直存在：`_maxImages = (_capabilities?.images ?? 1)` 在能力**未知**时返回 1，而撰写页图片区与选图上限直接用它（`captureImageLimit` 才做了乐观兜底）。后果是宿主自动截入 1 张图后 `canAdd = 1 < 1` 为假 → **「添加图片」按钮不渲染**，用户无从添加第二张；点进去的分支又会在探测失败后把上限压成 1。各宿主 pin 的 v0.8.6 同样如此。
3. 日志接入此前只是文档要求，SDK 里没有任何运行时信号：Web 未接 `logProvider` 时「重新采集」静默消失（Flutter 已有说明文本），接入者与用户都看不出漏接。

## 本次改动

- `flutter/feedback/lib/src/panel.dart`：新增统一乐观上限 `_imageLimit`（未确认 → `kFeedbackMaxImages`，已确认 → 服务端值），供 `_buildImagesArea`、`_pickImagesInto`、`captureImageLimit` 共用（`_maxImages` 移除）；`_refreshCapabilities` 在探测失败 / 404 / 返回 null 时**不再**置 `_capabilitiesLoaded`；新增 `_applyCapabilities` 逐字段合并，session 的 `images: null` 不覆盖已知值；`_singleImageMode` 语义不变（仅「已确认且 images<2」）。
- `packages/web/src/element.ts` + `styles.ts`：日志区新增 `.fb-logs-no-provider` 固定说明（「未接入日志采集，可手动添加日志文件；宿主接入需提供 logProvider」），未接入时可见、接入后隐藏；首次呼出面板时向宿主 console 输出**一次** `[Feedback] 未接入日志采集…` 警告（同实例不重复）。不拦截提交。
- 文档：`docs/integration.md` 5.5 区分「能力未知」与「已确认单图」、5.6 增补漏接的运行时信号；`docs/api.md` 能力探测补充「探测失败 ≠ 单图」；`packages/web/README.md`、`flutter/feedback/README.md` 同步。

## 验证（本次实测）

- `cd flutter/feedback && flutter test` → **630 passed**；`flutter analyze` → No issues found。新增 `test/capabilities_probe_test.dart`（5 例：1 张截图仍可加第 2 张、features 404 后仍可加并走 `images` multipart、caps 缺 images 仍单图、images=5 后 session 返回 null 不降级、images=1 保持单图 + 降级提交）；新增 `test/logs_no_provider_test.dart`（3 例：未接入时展开出现 `feedback-logs-no-provider`、接入后不出现、未接入仍可手动加日志且说明不阻断）。**变异验证**：把 `panel.dart` 换回基线实现跑 `capabilities_probe_test.dart` → `+3 -2`（两条关键用例失败），换回修复版全通过，文件 sha256 一致。`test/multi_image_test.dart` 的「旧服务单图」用例前提由「features 404」改为「session 有 caps 无 images」，断言未弱化。
- `pnpm --filter @feedback/web test` → 37 文件 / 630 用例通过（新增 `test/logs-no-provider.test.ts` 5 例）。`pnpm typecheck` / `pnpm lint` 通过（admin styles 有 1 条既有 warning，非本次）。
- 真实浏览器（Chrome，真实 `apps/server` + 隔离 `FEEDBACK_DATA_DIR` + 当前 dist）：未接 `logProvider` 时警告恰好 1 次、日志区说明可见、「重新采集」隐藏；连续加 3 张图片计数 1→2→3、加满 3 张「添加图片」仍可见、能力未探测时 `maxImages=5`；接入后说明隐藏、重新采集可用、重开不重复告警；无 console error。探针 `/tmp/fb_verify_final.py`（临时，不入库）。
- 陈旧产物对照（`/tmp/fb-stale-*.py`）：`examples/html/feedback-web.umd.js`（Oct 15）与当前 dist 行为同表，均能连加 3 张；把服务端 `images` 去掉后两者**同时**退化为单图并提示升级 → 产物陈旧不是本次成因。

## 剩余 / 未验证

- Flutter 只在 widget 测试与 mock HTTP 下验证，未在真机/桌面平台跑能力协商；宿主工程需升级到本修复后的 SDK 版本才生效（MediaPlayer 现 pin v0.8.6、Music v0.5.2、Assistant v0.6.0 均带旧缺陷或早于 v12）。
- 各宿主仍需按 5.6 实际核验日志接入并保存证据（FB-LOG-001 未闭环项）。
- 未提交、推送、发布；用户尚未确认验收。
