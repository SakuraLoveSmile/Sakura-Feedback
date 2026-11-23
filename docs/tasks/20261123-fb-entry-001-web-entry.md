# FB-ENTRY-001：Web 端默认入口与鼠标唤醒（P0 / 方案 A）

- 任务编号：FB-ENTRY-001；项目：personal-feedback
- 分支：feat/20261123-fb-entry-001-web-entry
- 基线：c675dd8（main，v0.12.0）；合入目标 main
- 状态：实现中
## 1. 背景与目标

用户反馈：Web 端反馈组件的用户端体验仍是移动端模型——唤醒方式是双指长按，桌面鼠标/触控板用户实际可用路径只有页面上看不见的 ⌘/Ctrl+Shift+F。

审查结论（基线 c675dd8，证据行号）：

1. launcher-mode=beam（默认）把 .fb-orb 与 .fb-tab-launcher 一起 display:none !important（packages/web/src/styles.ts:562-566），桌面零可见入口。
2. 唤醒只监听 touchstart/move/end/cancel（packages/web/src/wake-gestures.ts:50）；触控板双指是 wheel，并被 scroll() 立即重置（同文件 :68）。
3. 桌面唯一路径默认 primary+shift+f，页面无提示，且在 capture 阶段 stopImmediatePropagation（packages/web/src/element.ts:4650-4689）。
4. 「入口样式」设置藏在面板内，而打开面板又依赖唤醒或宿主 open()（element.ts:4713-4742）。
5. 文案为手指语言：松开手指唤醒灵感球（element.ts:3949）、从手指之间浮现（:4718）、两指同时按住 700 毫秒（wake-gestures.ts:3）。
6. 验证侧一直没有桌面真实路径：e2e/run_beam_shots_web.py:59 在 1280×800 桌面视口用合成 TouchEvent 断言，快捷键只按一次（:333）。
7. 任务记录 20261122-fb-beam-001-beam-wake.md:11 已把「鼠标/键盘依赖可配置快捷键与无障碍隐藏入口」写成接受的取舍——桌面体验是被接受，不是被设计。
目标：桌面浏览器上默认形态自带可发现入口，唤醒改用指针语义，文案与设置项按输入能力分叉；触屏形态与既有 `beam` 行为不变。

## 2. 范围（用户选定方案 A：P0 全做，含默认值改 auto）

1. 新增 `launcher-mode=auto` 并作为默认：主指针为精细指针时用贴边标签入口，粗指针/触屏时走光束手势；显式 `beam` / `tab` / `orb` 行为不变。
2. 桌面唤醒补齐指针语义：`⌥/Alt + 拖拽` 直接框出选区并进入既有选区工具条；`Alt+点击`（无拖动）在该点按现有手势路径唤醒。
3. 快捷键降级为次要路径：保留可配置与默认组合，新增「宿主已处理则让路」（`defaultPrevented`）。
4. 首次使用一次性提示：可见入口旁说明入口与快捷键，按 appId 只出现一次。
5. 文案与设置项按输入能力分叉：桌面不展示「双指长按/三指上滑/双指双击」，改为入口、`⌥+拖拽`、快捷键三项；`aria-label` 同源生成。

不在本轮：圈选取消后落到面板（P1）、`syncWakeSettings` 的模式感知（P1）、`⌥+点击元素` 定位元素矩形（第二步）、Flutter 侧同构改动、版本号与发布。

## 3. 已确认决定

- 用户选择 **A**：连默认值一起改，接受存量宿主形态变化，需要 CHANGELOG 迁移说明与文档同步。
- 输入能力用能力探测（`matchMedia('(pointer: fine)')` + `navigator.maxTouchPoints` / `ontouchstart`），不读 UA。
- `auto` 在无 `matchMedia` 环境退化为 `beam`（不能探测时保持已发布默认，不静默改行为）。
- 默认快捷键组合不变（`primary+shift+f`）；本轮的「次要路径」靠可见入口 + 首次提示 + 宿主让路实现，不改组合以免额外破坏宿主文档与肌肉记忆。
- `wake-shortcut="off"` 同时关闭 `⌥+拖拽`（宿主的单一入口控制开关），在文档中写明。
- 触屏能力仍存在（触屏笔记本、平板）时，双指长按等手势继续可用。
## 4. 验收场景

1. 桌面（无触摸、精细指针）不写 `launcher-mode`：页面出现贴边「反馈」入口；点击打开面板并带视口截图；`⌘/Ctrl+Shift+F` 仍可用。
2. 桌面 `⌥/Alt + 拖拽`：松手后出现冻结画面与已就位的选区工具条，选区等于拖拽矩形（夹回视口、最小 48px 边长，不额外外扩），确认后只提交该区域。
3. 桌面 `Alt+点击`（无拖动）：在该点进入圈选手势待命。
4. 触屏（粗指针）：不写 `launcher-mode` 仍走光束唤醒；双指长按 700ms 进入圈选。
5. 显式 `launcher-mode="beam"` 的存量宿主：形态与 0.12.0 完全一致（无入口、手势与快捷键照旧）。
6. 桌面首次进入：出现一次性入口提示，再次加载不再出现；按 appId 隔离。
7. 设置面板：桌面「入口样式」提供 贴边标签 / 灵感球；触屏设备额外提供 光束唤醒；「唤醒方式」在桌面显示入口、`⌥+拖拽`、快捷键，不显示手指数选项。
8. `⌘/Ctrl+Shift+F` 在宿主已 `preventDefault` 的页面上让路，不再抢占。

## 5. 验证计划

- `pnpm --filter @feedback/web test`（含新增 input-profile / entry-auto / alt-drag 用例）。
- `pnpm --filter @feedback/web typecheck`、`lint`、`build`。
- 真实 Chrome：纯鼠标/键盘（`has_touch=False`）走通 1、2、3、6、7；触屏视口走通 4。

## 6. 遗留

- P1：圈选「取消」后落到面板、`syncWakeSettings` 模式感知。
- 第二步：`⌥+点击元素` 定位元素矩形。
- Flutter 端默认入口未改（两端默认形态在本次之后不再一致，需在文档中写明）。

## 7. 实现摘要（待补：完成后回填）

实现已完成部分（2026-11-23）：

- 新增 `packages/web/src/input-profile.ts`：能力探测（`(pointer: fine)` / `maxTouchPoints` / `ontouchstart` / `(any-pointer: coarse)`）、`autoLauncherMode`、快捷键文案与平台修饰键。无 `matchMedia` 时探测结果为不可判定，解析保持 beam。
- `launcher-mode` 增加 `auto` 并成为默认；`effectiveLauncherMode()` 解析：auto → 本机偏好 → 能力默认；显式 tab/orb 直通；显式 beam 仅允许切到灵感球。
- 桌面唤醒：`⌥/Alt + 拖拽` 记录矩形 → 冻结后以 `regionFromDrag` 作为预设选区（48px 最小边、不额外外扩、跳过圈选动画）；拖动不足 8px 走 `wakeAt`（视口中心或落点的既有唤醒）；`capture-mode=off` 时只打开面板；从输入框/按钮/链接等内容起手不接管。
- 快捷键：默认组合不变；新增 `defaultPrevented` 让路；auto 解析为贴边标签时快捷键可用（`mouseEntryWakeAvailable` → `wakeAt`）。
- 首用提示 `.fb-entry-hint`：有可见入口时延迟 900ms 出现，按 appId 记 `feedback:entry-hint:v1:<appId>`=seen，可关闭、9 秒自动收起；打开面板或开始截图时收起。
- 文案与设置分叉：`syncBeamA11yLabel`、`desktopWakeRows`、入口样式三选（贴边标签/灵感球/光束）、「唤醒方式」桌面说明组与手势组互斥显示。
- 触屏语义保持：`beamLikeHost` 让 auto 在触屏设备上仍按 0.12 的待机语义（灵感球默认隐藏、手势待机）。

验证（本 worktree，基线 c675dd8）：

- `corepack pnpm --filter @feedback/web typecheck / lint / build`：通过（构建 `dist/feedback-web.js 445.49 kB`）。
- `corepack pnpm --filter @feedback/web test`：**731/731 通过**，新增 26 项（input-profile 8、entry-auto 13、alt-drag 6，另 1 项 capture-mode=off 分支），更新既有 2 项断言（默认值 auto、localStorage 断言收窄）。
- 真实浏览器验证由 browser-verify 执行；文档同步由 docs-sync 执行。

仍未验证：真实触屏设备/触屏笔记本的实际手感；Safari/Firefox 的 `(pointer: fine)` 与 Alt+拖拽；Flutter 端未改，两端默认形态从此不同。
### 文档同步（docs-sync，2026-11-23）

- 改动 15 个文件：`packages/web/README.md`、`docs/beam-spec.md`、`docs/integration.md`、`examples/{html,react,vue,ssr}`、`CHANGELOG.md`（新增 `[未发布]`）以及清单外的根 `README.md` 与 `docs/orb-spec.md`（补「当前口径（0.13 起）」，不改历史结论）。
- 复核：全仓 `*.md` 里「默认 beam」的剩余命中全部是 Flutter 事实或 0.10–0.12 的历史说明；`examples/react` 与 `examples/vue` 的 typecheck exit 0。
- 真实浏览器实测发现的注册顺序约束（宿主必须早于组件注册同组合键 capture 监听才会被让路）已写进 Web README 与接入指南 §5.3.2。

### 真实浏览器验证（browser-verify，2026-11-23）

- 环境：真实 Chrome 157.0.8103.79（channel=chrome，headless），Playwright；产物为当次重建的 dist（脚本首项断言 dist 不早于 src）。
- `e2e/run_entry_desktop.py`：**PASS=85 / FAIL=0**（19.3s）。断言覆盖：默认 `data-fb-mode=tab` 且贴边入口可见（box 1209,556,71×44）、点入口开面板并插入 1280×800 整屏截图、Alt+拖拽 `(400,300)→(760,560)` 得到 `360×260` 选区（frame rect 精确一致）且确认后缩略图自然尺寸 360×260、从按钮/链接起手不接管、`capture-mode=off` 时只开面板、Alt+点击进入圈选待命、首用提示出现一次并在刷新后消失、宿主 preventDefault 时零反应而在无拦截时接管、触屏 390×844 默认仍 beam 且双指长按 700ms 进入圈选、设置项分叉（tab/orb 可见、beam 行隐藏、桌面三项说明、手势行隐藏）。
- 光束回归 `e2e/run_beam_shots_web.py`：**PASS=36 / FAIL=0**（`e2e/pages/beam.html` 已显式声明 `launcher-mode=beam`）。
- 截图与实测值： `e2e/shots/fb-entry-desktop/`（14 张 + manifest.json）。
- 过程中唯一一次 FAIL 是脚本把「截图飞入缩略图」交接动画的中间态当终态测量，改为等覆盖层关闭后测量，未放宽阈值。

### 本轮完成状态

- 已实现、已单测（731/731）、已真实浏览器验证（85 + 36 全 PASS）、已同步文档；typecheck / lint / build 通过。
- **未提交、未合入、未发布**（等待授权）。

### 遗留（本轮不做）

- P1：圈选「取消」后落到面板；`syncWakeSettings` 的模式感知；`⌥+点击元素` 定位元素矩形。
- 既有文案： `examples/react/src/App.tsx:79` 与 `examples/html/index.html:93-95` 的「无局部裁剪」表述在 0.12 已过时；两份 `feedback-widget.d.ts` 里 `capture-mode` 注释仍写默认 `off`（实际 viewport）。
- 圈选覆盖层右上角「×」与页面导航文字有轻微视觉重叠（既有布局，与本次改动无关）。
- Flutter 端默认入口未改，两端默认形态不一致。
- 真实触屏笔记本（同时有鼠标与触摸）的手感、Safari/Firefox 的 `(pointer: fine)` 与 Alt+拖拽未测。
## 8. 管理后台集成（2026-11-23）

用户追加要求：把本次改动更新到 feedback 管理后台（`apps/admin` 内嵌 `<feedback-widget>`）。

做了什么：

- 管理页显式 `launcher-mode="orb"` 的注释更新为当前事实：不走 0.10 的 beam 默认，也不使用 0.13 auto 在桌面解析出的贴边标签；工作台圈选只在 `⌥/Alt + 拖拽` 时发生。外观与入口不变。
- 依次重建 `packages/web` 与 `apps/admin` 的 dist（admin 内嵌的组件产物是构建期打包的，改组件后必须先重建 web 再重建 admin）。
- 修掉一个实测暴露的真实不一致：0.12 的快捷键只在光束 / 手势待机时响应，灵感球停靠时按 `⌘/Ctrl+Shift+F` 无反应，而首用提示会写「也可以按 …」。现改为灵感球入口下快捷键等同点击入口（`capture-mode=viewport` 时截图后开面板），补 1 项单测，Web 测试 732/732。

验证（真实 Chrome + 真实服务 + 真实 `apps/admin/dist`）：

- `e2e/run_admin_widget_smoke.py`：**21/21 通过**（登录页组件唯一、orb 可见、预登记与握手、视口截图、提交进收件箱、page-label 跟随、主题联动、登出回自登录）。该脚本本机需把 `chromium.launch()` 换成 `channel="chrome"` 才能跑（既有脚本限制，未修改脚本）。
- 临时验证脚本（用后已删除，未入库）11/11 通过：管理页入口仍为 orb 且贴边标签不显示、首用提示只出现一次且刷新后消失、`Ctrl+Shift+F` 在灵感球模式下打开面板、`Alt+拖拽` 得到 `280×160` 选区且等于拖拽矩形、Esc 收起覆盖层、取消后导航可用且 page-label 跟随、零 pageerror。
- 最终 dist 上复跑 `e2e/run_entry_desktop.py`：**85/85 通过**（原先 85 项的证据因此对齐到最后一个构建）。

未做 / 待定：

- 管理页仍固定灵感球，未切换为 auto 的贴边标签（需产品决定，见对话）。
- `apps/admin/dist` 是构建产物（`.gitignore` 忽略），生产管理页要按发布流程更新；本轮未发布、未部署。
- 未提交 git。
## 9. 发布 v0.13.0（2026-11-23）

- 版本收口：`package.json`、`apps/server`、`apps/admin`、`packages/web`、`flutter/feedback/pubspec.yaml` 统一为 **0.13.0**；`CHANGELOG.md` 的 `[未发布]` 段改为 `[0.13.0] — 2026-11-23`。
- 本地门禁：`pnpm install --frozen-lockfile`、`pnpm -r build`、`pnpm -r typecheck`、`pnpm -r lint` 通过；服务端 469、Web 732 项测试通过；`e2e/check-release-notes.py` 与 `e2e/check-update-sh.py` 通过；Flutter 组件 analyze 无问题、704 项测试通过，示例 40 项通过。
- 提交：`b6c2ad7`（组件）、`49244c7`（e2e）、`8663956`（文档与 CHANGELOG）、`8ea335b`（chore(release) v0.13.0）、`91268b2`（注册顺序补充）；合并 `e1d52c5`。`main` CI 45130726654 success。
- 签名标签 `v0.13.0` 指向 `e1d52c5`，GPG Good signature；Release 流水线 45131154199 全部 job 成功，[v0.13.0](https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/tag/v0.13.0) 已公开、Latest。
- 资产七份齐全，`shasum -a 256 -c SHA256SUMS` 三份产物 OK；`release-manifest.json`：version/tag/commit 为 0.13.0/v0.13.0/`e1d52c5`，channel stable，schema **15**，digest `sha256:692e14a9…`；GHCR `v0.13.0` 与 `latest` 同一 digest。

## 10. 生产升级（2026-11-23 15:33）

- 目标 `blog-prod:/opt/1panel/docker/compose/feedback`（compose 项目 feedback，容器 feedback-feedback-1）；从 v0.12.0（digest `e4bd5240…`）升级到 **v0.13.0**。
- 预拉与核对：`docker pull …:v0.13.0` 得到 digest `692e14a9…`，与发布清单一致；镜像标签 `org.opencontainers.image.version=v0.13.0`、revision `e1d52c5`，容器内 `/app/server/package.json` 为 0.13.0。
- 备份：`backups/fb-rel-013-pre-v0.13.0-20261123-153325/`（700），含 `docker-compose.yml.pre`、`.env`、停机库 `feedback-stopped.db`（sha256 `5ebc393c…`）、停机整目录 `feedback-data-stopped-v0.12.0.tgz`（`29d40975…`，4.8M）与 `SHA256SUMS`、停机时 data 目录清单。
- 切换：停机后 data 无 WAL/SHM 残留，照搬上一轮做法改 compose 镜像为 `:v0.13.0@sha256:692e14a9…` 后 `docker compose up -d`，约 6 秒 healthy，RestartCount 0；脚本内置「60 秒不 healthy 自动回退 v0.12.0」，本次未触发。
- 数据：升级前后 schema 15、integrity ok、20 张表 **1784 行**，逐表行数完全一致（feedbacks 32、feedback_audit 107、sessions 1508 等）。本轮无数据库迁移。
- 公网核验（`https://feedback.xn--fhqths51enha.cn`）：`/healthz`、`/api/features`、`/api/changelog/studytool`、`/admin/` 均 200，未登录 `/api/admin/apps` 401；管理页 6 个资产（index.html 与 5 个 JS/CSS）与 Release 的 `feedback-admin-dist.zip` 逐字节一致；线上 `feedback-widget-36fin6si.js` 含新代码标记（`pointer: fine`、`fb-entry-hint`）。
- 回退：compose 改回 `:v0.12.0@sha256:e4bd5240…` 后 `docker compose up -d`（schema 同为 15，无需恢复数据；如需可解 tar 或换 `feedback-stopped.db`）。

### 发布后仍待处理

- 生产 `data/update-check.json` 仍是旧结果，24 小时自动检查或后台「检查更新」后显示 0.13.0。
- 浏览器需强刷新 `/admin/` 才会载入新资产。
- **各 Web 宿主（含 blog）要自己升级到 `feedback-web-0.13.0.tgz` 才拿得到新入口行为**；本次只发布了组件包与管理页，未改动任何宿主站点。
