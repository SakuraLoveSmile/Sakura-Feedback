# FB-CHANGELOG-001：各软件更新日志与反馈提出者署名

状态：待体验（已合并、正式发布并升级生产；待用户体验确认）。用户于 2026-11-04 确认：为各接入软件管理日志、关联反馈并供软件展示；默认显示账号名称，发布前可改署名或匿名。当前账号无独立昵称字段，默认取用户名，编辑器允许填写公开昵称。

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

## 体验入口与本地资源归档

- 生产管理入口：[更新日志后台](https://feedback.xn--fhqths51enha.cn/admin/?page=changelog)，登录当前管理员账号后进入。各软件的展示链接和 Markdown 地址由页面提供；当前生产尚未创建或发布任何软件日志，已有软件公开页显示规范空态。
- 历史隔离预览为 `127.0.0.1:62634` / PID `50342`，已停止，浏览器本地验收页已关闭。原合成数据目录已在内容 SHA256 完全一致后归档并移除。
- 私有归档：`/Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback/.archives/20261104-fb-changelog-001-user-credits`。包含七份正式产物、校验 JSON、最终 CI 日志、截图、合成数据库与预览/HTTP 兼容探针脚本。`preview-data-sha256.json` 可核验合成数据；不含生产数据库或生产密钥。
- 临时 worktree、本地分支与预览端口的最终清理核验以该目录的 `cleanup-result.json` 为准；主目录的其他未提交改动保持开工时状态。本地主目录因原有未提交改动未快进，远端 main 已整合全部本任务成果；本地主分支可在原改动妥善处理后更新。

## 合并、发布与生产上线

- 功能提交 `4a03439`；0.9.0 对齐五处组件版本与固定接入文档。合并本地 main 的 `37fd109`（设计令牌/宽屏分栏）和 `4d80f4a`（中央路径政策）；其管理页代码已经等效存在于最新发布线，冲突选择保留发布线后续新增样式，合并后业务源码相对功能提交无差异。政策措辞统一为主分支版本。
- 远端 main 已从 `10f42db` 快进到整合提交 `7201756d698f4f2e77154d02a2bac6d132acf24f`，该提交包含本地 main 两项原有提交的祖先关系。签名标签 `v0.9.0` 指向同一源码提交；后续提交仅补记本文证据。
- 最终组合态重新执行：根 `pnpm build`、`pnpm typecheck`、`pnpm lint` 通过；服务端 33 文件/468 项、Web 38 文件/681 项测试通过。主 agent 重新加载最终构建，确认三分类、署名/匿名、发布锁定和公开显示正常。源码自功能提交后未改变。
- [main CI 41693591151](https://github.com/SakuraLoveSmile/Sakura-Feedback/actions/runs/41693591151) 6 个 job 全通过；[Release 41694297581](https://github.com/SakuraLoveSmile/Sakura-Feedback/actions/runs/41694297581) 11 个 job 全通过，包含 Flutter 包/示例与安全存储三版本矩阵。没有跳过或降低门禁。可选本地静态 `check-release-workflow.py` 因本机两个 Python 均缺 PyYAML 未执行；工作流未改动，完整真实 Actions 已通过。
- [v0.9.0 正式 Release](https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/tag/v0.9.0) 于台北时间 2026-11-04 02:35:48 公开，非 draft、非 prerelease，已确认为 Latest。七份资产独立下载后 18 项校验通过：三份构建文件 SHA256、源码/tag/stable、tarball 版本与入口、UMD 与 zip 一致、admin 新功能/版本、schema15、OCI index/header/manifest digest 一致及 linux/amd64 平台。
- 正式镜像：`ghcr.io/sakuralovesmile/sakura-feedback@sha256:efabd9a6cbc18d5beee607467e2a9165eb1627455e607eefbee6d53b39840b90`。生产 compose 固定为 `:v0.9.0@sha256:…`，实际 RepoDigest 与发布 manifest 一致。

### 生产数据保护与升级结果

- 生产目录 `blog-prod:/opt/1panel/docker/compose/feedback`，从 v0.8.5 升级为 v0.9.0。完整备份位于 `backups/fb-changelog-001-pre-v0.9.0-20261103-182213/`（目录名时间为 UTC）：包含 `docker-compose.yml`、`.env`（私有权限）、在线一致性 `feedback-online.db`、停机快照 `feedback-stopped.db`、整个 data 的 `feedback-data-stopped-v0.8.5.tgz` 与前后校验元数据。
- 在线库快照 integrity ok、schema14，SHA256 `200aabd76d588eca841964c2b4e91c170744bb6eb5f5d25fc5df5615477e2cde`。拉取新镜像后 `docker compose stop -t 30 feedback` 优雅退出，确认无 WAL/SHM，再备份整 data；tar 内数据库字节与停机快照一致，tar SHA256 为 `a55e7a76becd58d8fe7f1e98d613047b0d157d5cc4e63503550c9f1bbd985d2a`。
- 2026-11-04 02:38:56（台北）服务恢复 HTTP 健康，容器 healthy、0 重启，运行包版本 0.9.0，数据库 schema15、integrity ok。既有 **25 条反馈、15 条消息、3 个账号、7 个软件**的整表内容 SHA256 与升级前完全相同；新日志表为空。启动扫描为既有定时行为，Kaneo 回读 4 条全部跳过，0 失败；本次没有提交生产演示反馈或发布演示日志。
- 公网 9 项核验通过：健康/既有能力接口、新 JSON/Markdown/独立展示页、匿名只读 CORS、OPTIONS、管理 API 未登录 401、既有客户端写操作未登录 401；管理页实际 JS/CSS 字节与 Release 的 admin zip 完全相同。主 agent 真实浏览器验证了生产博客的更新日志空态。
- 完整登录后管理流程在本地最终组合态实测。生产当前管理员凭据没有提供，容器初始凭据单次登录返回 401 后没有继续尝试；生产登录后人工体验仍待当前管理员确认。临时公网 smoke 校验最初误把展示页的空态提示当成 Markdown 文本；按契约及实现核实 Markdown 无已发布版本时仅保留一级标题，修正该临时校验预期后通过，未修改业务代码或既有测试。
- 回退必须先停止新服务并保留当前数据，再核对升级后是否已有 Kaneo 远端写入；跨 schema15→14 不可只换镜像。按部署文档的数据/远端写入约束恢复上述 data tar 与 compose/env 备份后再启动旧服务。该备份已校验，未在生产执行恢复演练。
