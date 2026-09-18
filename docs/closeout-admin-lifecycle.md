# 收尾记录：网页端改进——反馈整理、删除与统一 UI（T1–T4）

> 记录时间：2026-09-17。状态口径沿用 [`closeout.md`](closeout.md)：
> **未开始 / 实现中 / 待体验 / 已验收**。本轮**不标记「已验收」**——只有你按真实浏览器体验确认后才记已验收。
>
> 本次改动只落在 Feedback 仓库；**未**修改 Kaneo、宿主组件或线上数据；未提交、未推送、未部署。
> 本轮设计令牌与产品规则由改进计划固定，未自行调整；未新增深色主题。

## 一句话结论

管理端现在具备完整的「**查看 → 处理 → 同步 → 归档 → 清理**」流程：反馈页顶部固定
**收件箱 / 已归档 / 回收站** 三个区域，删除先进回收站可恢复、彻底删除手动输入「删除」确认；
只有完整同步到 Kaneo 的记录允许本地归档，同步成功**不**自动归档；全部七个管理页共用同一套
浅色工作台设计令牌与共享组件。

## 任务状态

| 任务 | 状态 | 说明 |
|---|---|---|
| T1 独立收件箱归档 | **待体验** | 迁移 v9（`mgmt_state`/`archived_at`/`archived_by`/`lifecycle_version`/`resume_paused` + 删除凭据表）、区域计数/列表过滤/单条与批量动作接口、仅 `status=archived` 可归档（服务端强校验）、历史数据全部落收件箱 |
| T2 回收站 / 恢复 / 彻底删除 | **待体验** | 软删除→回收站、恢复回收件箱且未完成记录保持暂停、worker 与扫描全链路排除回收站/暂停记录、彻底删除事务清理 BLOB+审计并留最小防重放凭据、所有者查询返回 410、不返还额度、不触碰远端 |
| T3 列表 / 筛选 / 批量 / URL 状态 | **待体验** | 三区计数、防抖搜索（≤200 字）、软件/状态/日期筛选、游标分页 50、勾选批量（≤100、逐项结果不回滚）、URL 保存区域/筛选/详情 id（刷新与前进后退可恢复）、有活动处理时每 5 秒原位轮询、请求序号丢弃迟到响应 |
| T4 详情与全站 UI | **待体验** | 600px 详情抽屉（内容顺序按计划固定）、回收站只读、分类草稿保护与放弃确认、共享组件库（按钮/标签/弹窗/抽屉/通知/空态/骨架/更多菜单）、分组导航（工作台/管理/系统）、其余六页统一外壳与控件、`window.confirm/prompt/alert` 全部替换 |

## 交付清单（按文件）

### 数据层与服务端（T1/T2）

- `apps/server/src/db/db.ts` — 迁移 v9：`feedbacks` 新增 `mgmt_state`（inbox/archived/trash）、
  `archived_at`/`archived_by`、`trashed_at`/`trashed_by`、`lifecycle_version`、`resume_paused`；
  新表 `feedback_deletion_receipts`（提交键摘要、内容摘要、用户 ID、原反馈 ID、删除时间）。
  历史记录 `mgmt_state='inbox'` 默认落入收件箱，不自动迁移到已归档。
- `apps/server/src/db/repos.ts` — 生命周期引擎 `applyLifecycleInTx`（单条/批量同一入口、
  乐观并发版本、逐项结果）、`listFeedbacks` 扩展 `view/q/from/to`、三区计数
  `countFeedbacksByMgmt`（与列表同筛选）、软件选项 `listFeedbackAppOptions`（含已删软件）、
  删除凭据 `writeDeletionReceipt`/`findDeletionReceipt`、重试/恢复/自动扫描排除回收站与暂停。
- `apps/server/src/routes/admin.ts` — `GET /feedback?view=&q=&from=&to=`、`GET /feedback/counts`、
  `GET /feedback/app-options`、`POST /feedback/:id/lifecycle`、`POST /feedback/lifecycle`（批量，
  每项带 `expectedVersion`，409 冲突逐项返回）、详情返回 `readOnly`；分类/重试对回收站记录拒绝。
- `apps/server/src/pipeline/worker.ts` — `withFeedbackLock` 管理动作与 worker 同锁；
  `processLocked` 处理前重读 `mgmt_state`/`resume_paused`（回收站→跳过、暂停→挂起）；
  手动恢复/重试清除暂停标记；持锁记录返回「处理中」。
- `apps/server/src/routes/feedback.ts` — 提交键命中删除凭据返回 410（防重放）；
  所属用户 GET 已清理记录返回 410，其他用户不泄露存在性。
- `apps/server/test/lifecycle-v9.test.ts` — 21 用例（见下）；`migration-v6.test.ts`、
  `accounts-quota.test.ts` 终态断言 7→9（纯版本号，未改语义）。

### 管理端（T3/T4）

- `apps/admin/src/styles.css` — 固定设计令牌全部落地为 CSS 变量（背景 `#F6F7F9`、主色
  `#2563EB`、间距 4/8/12/16/24/32、圆角 8/12、控件高 36/移动 44、动效 120–160ms 仅透明度与颜色
  + `prefers-reduced-motion` 关闭）；响应式三档：≥1200 左侧 224px 导航 / 768–1199 顶部菜单 /
  <768 卡片列表+全屏抽屉。
- `apps/admin/src/ui.tsx` — 共享组件：`Icon`（18px/1.75 线宽单色 SVG）、`Tag`、`Modal` 与
  `ConfirmDialog`（焦点约束/Esc/焦点恢复/背景锁定）、`PromptDialog`（含密码模式）、`Drawer`、
  `useToast` 通知、`EmptyState`、`SkeletonRows`、`InlineError`、`MoreMenu`。
- `apps/admin/src/url.ts` — `useUrlState`：查询参数读写 + `popstate` 监听（前进后退可恢复）。
- `apps/admin/src/App.tsx` — 分组导航外壳（工作台/管理/系统），桌面侧栏 + 平板/手机顶部菜单，
  当前页写入 `?nav=`。
- `apps/admin/src/api.ts` — 生命周期类型（`MgmtView`/`LifecycleAction`/计数/批量结果）、
  状态文案「已同步/待同步/同步中」（原 `archived` 语义不再对用户称「归档」）。
- `apps/admin/src/views/FeedbacksView.tsx` — 三区标签页+计数、搜索/软件/状态/日期筛选、
  游标加载、全选与批量操作（≤100、成功项移除仅留失败项勾选）、5 秒轮询（隐藏停止、
  有新反馈仅提示不打断）、URL 状态、请求序号防迟到回写。
- `apps/admin/src/views/FeedbackDrawer.tsx` — 详情抽屉固定八段顺序；分类与同步目标
  （项目→列→标签→负责人，自动预填不算脏、迟到选项按请求序号丢弃）、恢复动作区、
  审计记录默认折叠、回收站只读、未保存关闭先确认。
- 其余六页（Apps/Accounts/Connections/Sessions/Settings/SystemUpdate）：统一页头/表单/表格/
  弹窗样式；`window.confirm`→`ConfirmDialog`、`window.prompt`→`PromptDialog`、`alert`→toast；
  软件配置文案「自动归档」→「自动同步到 Kaneo」；业务规则未改。

### 浏览器验证

- `e2e/run_lifecycle_browser.py` — 真实构建产物 + 真实服务进程 + mock AI/Kaneo + Chromium，
  覆盖生命周期全链路与四档视口；截图与 `report.json` 在 `e2e/shots/lifecycle/`。
- `e2e/run_admin_delete_browser.py` — 原软件删除回归脚本适配新外壳
  （`nav.tabs`→`.nav-item:visible`、原生 confirm→共享 `ConfirmDialog`、空列表 EmptyState）。

## 验证结果（本轮全部真实运行）

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @feedback/server test` | **323/323**（302 既有 + 21 生命周期新增） |
| `pnpm --filter @feedback/server typecheck` | ✅ exit 0 |
| `pnpm --filter @feedback/server lint` | ✅ 0 error，36 warning（均为既有告警，非本轮引入） |
| `pnpm --filter @feedback/admin typecheck` | ✅ exit 0 |
| `pnpm --filter @feedback/admin lint` | ✅ biome 0 error / 0 warning |
| `pnpm --filter @feedback/admin build` | ✅ `dist/` 282 kB JS + 17 kB CSS |
| 生命周期浏览器 E2E | **58/58 通过，0 警告**（`e2e/shots/lifecycle/report.json`） |
| 软件删除流程回归 E2E | **53/53 通过**（`e2e/shots/admin-delete/report.json`，脚本已适配新外壳与共享确认弹窗） |

### 生命周期 E2E 覆盖（58 项摘要）

- 管理登录、Kaneo/AI 连接写入、软件配置、普通账号提交 4 条反馈、worker 经 mock AI 整理。
- 人工分类+同步到 Kaneo → `status=archived`；分组导航三组渲染；默认落收件箱且计数=4。
- 搜索过滤、抽屉「用户原话/分类与同步目标」区块、`?id=` 写入 URL、URL 直达详情。
- 已同步记录本地归档→收件箱移除→已归档出现→恢复回收件箱。
- 移入回收站确认框明示「远端内容与附件保留」；回收站抽屉只读（无分类控件、无恢复区）。
- 彻底删除须输入「删除」、删后管理端与所属用户公开查询均 410。
- 批量：未全同步时归档按钮禁用、逐项执行、失败原因展示、成功项离开勾选。
- `?q=` 刷新保持、详情 URL 直达、后退关闭抽屉。
- 其余六页共享外壳回归；390/768/1440/1920 四档无整体横向滚动，移动端卡片/桌面表格切换正确。

### 服务端新增测试（21 用例，`lifecycle-v9.test.ts`）

迁移 v9（v8 历史库升级保留全部字段与附件、空库直接建 v9、重启幂等）；生命周期动作
（归档条件校验：未同步/失败/待核对拒绝，仅完整同步可归档；恢复保留远端关联）；
批量动作（逐项成功/冲突/非法状态、版本乐观并发、部分失败不回滚）；
队列安全（持锁返回处理中、排队记录可移回收站、回收站记录出队不处理、恢复后暂停不自动重发）；
彻底删除（事务清理 BLOB+审计、防重放凭据拦截同提交键、不返还额度、所有者 410）；
权限（普通账号无管理接口）与区域计数/搜索过滤。

## 浏览器入口

`pnpm --filter @feedback/server dev` + `pnpm --filter @feedback/admin dev`，
或生产形态：`pnpm --filter @feedback/admin build` 后由服务端托管 `apps/admin/dist`
（`FEEDBACK_ADMIN_DIST` 指向构建产物）。

建议体验顺序：

1. 反馈页三区域切换与计数；搜索/筛选组合后刷新，URL 状态保持。
2. 打开一条反馈 → 分类并「保存并同步到 Kaneo」→ 回到列表 → 手动「归档」→ 已归档区出现。
3. 勾选多条 → 移入回收站（确认框数量与远端保留说明）→ 回收站只读详情 → 恢复回收件箱（未完成记录显示「已暂停」，需显式恢复处理）。
4. 回收站彻底删除 → 输入「删除」→ 管理端详情与所属用户查询均 410。
5. <768px 视口：卡片列表、底部批量操作栏、全屏抽屉。

## BLOCKED / 未验证（如实标注，不得读作已通过）

- **真实 Kaneo 兼容性**：同步契约沿用既有实现未改动；本轮 mock 环境验证，真实服务未复验
  （上轮图片上传阻塞结论仍有效：Kaneo 侧 S3 未配置）。
- **200% 缩放与纯键盘全链路**：组件已具备焦点约束与 Esc，但 200% 缩放观感未逐项截图。
- **数据库体积**：彻底删除释放 SQLite 内部可复用空间，不承诺文件立即缩小（计划内不引入 VACUUM）。
- 批量上限 100 条由前端禁用与服务端校验双重保证；超过上限的并发请求未做专项压测。

## 状态

**待体验。** 自动化与浏览器脚本全绿；只有你按真实浏览器确认后才记「已验收」。
