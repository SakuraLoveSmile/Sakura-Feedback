# FB-CHANGELOG-001：各软件更新日志与反馈提出者署名

状态：实现中（功能本地验证完成，正在整合发布与上线）。用户于 2026-11-04 确认：为各接入软件管理日志、关联反馈并供软件展示；默认显示账号名称，发布前可改署名或匿名。当前账号无独立昵称字段，默认取用户名，编辑器允许填写公开昵称。

工作树：`/Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback/20261104-feat-fb-changelog-001-user-credits`；分支 `feat/20261104-fb-changelog-001-user-credits`；基线 `343c439`（最新 v0.8.6 发布记录）。主工作区 main 存在其他任务改动且落后发布分支，本任务不改写它；预期合入 main；用户于 2026-11-04 明确要求“合并上线吧”，已授权提交、合并、推送、正式发布及生产升级。整合在本任务工作树完成，不更新脏主工作区的文件或索引。

## 已确认行为与视觉依据

- 管理页新增“更新日志”，沿用软件配置/账号页面的 page-header、card、Field、btn、共享颜色与间距。先选软件，左侧版本列表，右侧结构化编辑器，窄屏单列；不更换全局样式。编辑器有版本、日期、摘要、条目、升级说明，条目按新增/改进/修复分类，标题与说明由管理员面向用户编辑。
- 新增关联只接受同一 appId 的未在回收站反馈；每条可关联多条反馈。原来已经保存的关联在源反馈删除/进回收站后允许保留与修改署名。同一用户可在不同条目获署名；单条目相同公开署名去重。署名取保存时快照，后续账号更名/停用不改变已发布文本。`creditName: null` 表示匿名（展示“匿名用户”），空白名字拒绝。管理员界面可见反馈关联，公开内容不含反馈 ID、原话、账号 ID、附件、Kaneo 信息。
- 草稿保存与发布分开；发布为管理员显式动作，取消发布后公开入口不再返回。发布后修改应先取消发布，避免未审核的编辑直接对外。更新不改变反馈处理/解决状态，不调用 AI 或 Kaneo。
- 每个 appId+version 唯一；关联软件软删除后保留管理记录，公开入口停用；appId 重新登记时仍按 appId 管理历史日志，不跨软件关联。纯新增 schema 15，保留旧反馈/账号；迁移幂等，事务内更新版本。

### 权威契约与模板

接口字段、校验、错误和兼容性统一维护于 [HTTP 契约的软件更新日志节](../api.md#软件更新日志)，不在任务记录重复维护。日志格式与填写规范见 [统一模板](../changelog-template.md)；宿主链接/JSON 接入见 [接入指南](../integration.md#软件更新日志与反馈致谢)。新增 `GET /api/admin/changelog/apps` 专门提供活跃软件与拥有历史日志的软件选项，不依赖是否还有反馈。

## 实施与分工

- T1：只读 explorer 已查明现有 feedback.user_id→users.username 及 appId 隔离，无 nickname 字段。主 agent 冻结以上契约。
- T2：后端 worker 独占 `apps/server/src/db/changelog.ts`、`apps/server/src/routes/changelog.ts`、`apps/server/src/pages/changelog.ts`、`apps/server/src/db/db.ts`、`apps/server/src/app.ts`、`apps/server/test/changelog.test.ts`。自行完成 schema/路由/规范模板与公开页；不得改其他文件，不继续派生。与 T3 按以上契约并行。
- T3：主 agent 独占 `apps/admin/src/api.ts`、`App.tsx`、`views/ChangelogView.tsx`、页面局部 CSS、`AGENTS.md`、文档与任务记录；负责界面、反馈选择、匿名/署名、预览、复制 Markdown/展示链接与最终接入。
- T4：主 agent 亲自核验组合态真实服务/浏览器。测试只用隔离临时数据库和 mock，不连接真实 AI/Kaneo。必要时 reviewer 只读检查权限、迁移与公开内容边界。实际端口/数据目录/进程在运行后补记。
- 轻量 quick_worker 仅更新 7 个旧测试文件的 19 处最新 schema 断言（14→15），同步 2 处用例说明；这是新增 schema15 的预期变化，未改历史夹具、数据断言、回滚要求或跳过任何用例。独立 reviewer 检查了权限/迁移/公开边界和前端状态，发现的 HTTP 随机 ID 兼容性与无反馈软件删除后历史入口问题均已修复。

## 验收与证据

1. A/B 软件反馈分别可选，跨软件关联拒绝；多用户署名、匿名、重复署名去重在保存/重载/发布后的页面与 Markdown 一致。
2. 草稿公开不可读；显式发布可见；取消发布消失；已发布内容不可直接改；旧 revision 冲突不覆盖新版本。
3. 公开接口与展示页没有原话、反馈 ID、账号 ID、附件、Kaneo；恶意昵称/标题转义，不执行 HTML；普通账号与跨源写入无管理员权限。
4. 旧 schema 14 数据升级保留，schema 15 重开幂等；软件删除公开停用；账号改名/反馈删除后已发布署名快照稳定。
5. 管理页桌面/移动与深浅色实测；必要 typecheck/lint/build、服务测试及新增规则测试；仅使用本任务代码，不能沿用历史结果。

## 本次实测（2026-11-04）

验证对象为本分支 `343c439` 基线上的本任务全部未提交源码改动，后端和管理端组合运行；最后只整理本记录，没有后续源码变动。

- 服务端全套：**33 文件、468 测试通过**（其中新更新日志规则 13 项），日志 `/tmp/feedback-changelog-server-tests-final.log`。覆盖权限、跨软件关联、草稿隔离、发布/取消发布、乐观锁、署名去重/转义、历史快照、无反馈软件软删除管理入口、schema14 保留/重开与迁移失败回滚。
- server typecheck/build、admin typecheck/build、所需 Web 依赖构建通过；server/admin lint 退出 0。server 保留 43 条旧代码 warning（any 等），admin 保留 1 条旧共享 CSS specificity warning；本次新模块 Biome 无 warning。Vite 保留单 bundle 超过 500 kB 提示，未降低阈值。Release 日志提取回归 2/2 通过，`git diff --check` 通过。
- 主 agent 在真实 IAB 浏览器上从管理登录走通：选星光笔记→新增/改进/修复三条→关联同软件反馈→改昵称“小樱”/匿名→草稿保存→公开空态→发布→公开对应条目→复制 Markdown→取消发布后公开空态→重新发布。单条目两个同名署名合并一次，匿名在页面和导出均为“匿名用户”。原反馈仅供内部的文本没有出现在产物中。
- 桌面 1280px 深色与浅色、管理页和公开页 390px 窄屏均实测；窄屏 document/client scrollWidth 相等为 390，无横向溢出。截图位于 `e2e/shots/changelog-20261104/`：`public-desktop-light.jpg`（1280×955）、`public-mobile-dark.jpg`（390×890）、`admin-mobile-light.jpg`（390×4399）。
- HTTP 兼容性通过本地只读代理临时删除 `Crypto.prototype.randomUUID`，在普通构建产物运行前使其缺失，DOM 标记验证为 `undefined`；页面成功初始渲染、新建版本并添加第二条条目。该临时探针页已关闭、代理进程已停止，主预览页面未修改浏览器 API。主题和视口仿真已恢复。

## 体验入口、资源与下一步

- 隔离后台：`http://127.0.0.1:62634/admin/?page=changelog`（已登录的浏览器页停在星光笔记）；公开示例：`http://127.0.0.1:62634/changelog/com.demo.notes`。只绑定回环地址，全部名称、反馈和版本均为合成验收数据。
- 预览进程 PID `50342` / exec session `77187`；数据目录 `/var/folders/3f/d270m3fx56b4ff4x8l0xcn8m0000gn/T/feedback-test-EmqD3a`。启动脚本在本工作树忽略目录 `apps/server/.agent-teams/changelog-preview.ts`；演示凭据/完整资源元数据在忽略文件 `e2e/shots/changelog-20261104/run.json`。外部 AI/Kaneo 均注入 mock，更新检查及远程同步定时器关闭。
- 功能本地验证后用户已授权合并上线；本次准备发布 0.9.0。生产已只读确认位于 `blog-prod:/opt/1panel/docker/compose/feedback`，当前镜像 v0.8.5。合入 main 前整合本地 main 的两项已提交改动与最新发布线；必要组合态验证通过后发布、备份并升级生产，最后停止预览、保存需要的截图/演示资料并清理本任务 worktree。该中央目录为按约定手动创建的 Git worktree，App 因非受管目录未能附加，实际路径与分支见本文开头。

## 合并与上线（进行中）

- 功能提交 `4a03439`；0.9.0 对齐五处组件版本与固定接入文档。合并本地 main 的 `37fd109`（设计令牌/宽屏分栏）和 `4d80f4a`（中央路径政策）；其管理页代码已经等效存在于最新发布线，冲突选择保留发布线后续新增样式，合并后业务源码相对功能提交无差异。政策措辞统一为主分支版本。
- 远端 main 当前 `10f42db`，是本任务发布线祖先；先在此工作树完成合并和最终验证，再快进推送 origin/main，主目录中其他任务的未提交内容保持原样。
- 已只读核实生产 0.8.5 容器健康、公开 HTTPS `/healthz` 与管理页为 200；schema14→15 前将保留在线 SQLite 一致性快照、compose/env 备份及停机后的整个 data 备份。
