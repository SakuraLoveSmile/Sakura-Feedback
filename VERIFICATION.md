# 验证记录

## 第 1 轮（基线，2026-09-08）

日期：2026-09-08 · 环境：macOS，Node v26.7.0，pnpm 11.23.0，Flutter 3.41.3 (Dart 3.11.1)，Docker 29.5.3，Chromium（Playwright 1.58 / 系统 Chrome 无头）。

### 仓库门禁（全部真实运行）

| 命令 | 结果 |
|---|---|
| `pnpm -r build` | ✅ exit 0（server tsc、admin vite、web vite、examples react/vue） |
| `pnpm -r typecheck` | ✅ exit 0 |
| `pnpm -r test` | ✅ exit 0 |
| `pnpm -r lint` | ✅ exit 0（server/admin biome，web eslint） |
| `pnpm approve-builds` 供应链配置 | ✅ `pnpm-workspace.yaml` 固定 `minimumReleaseAge: 0` + `allowBuilds.esbuild`（与本地一致，容器可复现） |

### 服务端自动化测试（旧文：5 文件 45 用例）

覆盖：认证、软件映射、持久化恢复（重启重入队/archiving 中断转 needs_review）、重复提交幂等、AI 异常有限重试、失效目标列、Kaneo 结果不确定恢复、外部客户端 fetch 级契约、密钥加密存储。

### Web 组件真实浏览器 E2E（`e2e/run_browser.py`，Chromium，27/27 通过）

React/Vue 示例静态托管 + 反馈服务 :8787 + 外部服务全 mock：组件注册/面板/Esc、草稿跨开关保留、超限计数、登录握手全链路、Kaneo mock 契约核验、AI 故障恢复、刷新后跨域会话恢复、窄屏布局、Vue 完整链路。

### Flutter（旧文：包 25 用例 / 示例 1 用例）

`flutter analyze` 无问题；`flutter test` 全过；`flutter build web --release` / `macos --release`（42.3 MB）/ `apk --debug` / `ios --no-codesign` ✅；Linux/Windows 未验证（宿主限制）。

### Docker（旧文：`e2e/run_docker.py` 12/12 通过）

镜像构建 + smoke；容器↔宿主 mock 真实 HTTP 闭环、`docker restart` 数据持久、archiving 中断记录重启后转 needs_review 且未重复创建、recheck 命中真实任务关联归档、重启后幂等重放返回原记录。

---

## 第 2 轮（遮挡 / 生命周期 / 归档恢复验收，2026-09-10）

环境同上（Docker 29.5.3、系统 Chrome、Playwright 缓存仅 chromium_1234；Flutter 3.41.3 / Dart 3.11.1）。

### 1. 全仓门禁（验收时全部重新真实运行）

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm -r test` | ✅ exit 0 | web 9 文件 **88** 用例全过（masking 23 + lifecycle 23 + submit 7 + screenshot 7 + 其余 28）；server 8 文件 **105** 用例全过（fault-injection 13 + archive-data 20 + pipeline 25 + screenshot-pipeline 8 + admin 6 + feedback 6 + auth 9 + external-clients） |
| `pnpm -r lint` | ✅ exit 0 | web done；server biome 0 error、10 warning + 1 info（含 `test/pipeline.test.ts:789` 未使用函数 `rowTaskId` 等既有告警，非本轮引入） |
| `pnpm -r typecheck` | ✅ exit 0 | 5 项目（admin/web/server/react/vue examples） |
| `pnpm -r build` | ✅ exit 0 | web `dist/feedback-web.js` 73.74 kB（gzip 19.94）+ 懒加载 chunk `html2canvas-pro.esm-*.js` 328.98 kB（gzip 75.51）；UMD `feedback-web.umd.cjs` 312.30 kB（gzip 80.90）；server tsc；admin 216 kB；react/vue examples |

### 2. Flutter 门禁（验收时重新真实运行）

| 项目 | 结果 |
|---|---|
| `flutter analyze`（flutter/feedback） | ✅ No issues found |
| `flutter test`（flutter/feedback） | ✅ **52** 用例全过（capture_mask_pixel 10 + capture_lifecycle 11 + panel/widget/api 其余） |
| `flutter analyze`（examples/flutter） | ✅ No issues found |
| `flutter test`（examples/flutter） | ✅ 1 用例（灵感球先截图后开面板冒烟） |
| `flutter build web --release`（示例） | ✅ |
| `flutter build macos --release`（示例） | ✅ 42.7 MB（本轮重跑） |
| apk / ios 构建 | ⚠️ 本轮未重跑（第 1 轮已验证；本轮仅 Dart 逻辑层改动，构建入口未变） |

### 3. 三类缺口回归测试（均为新增/转正用例，全部通过）

**Web 像素级遮挡（`packages/web/test/masking.test.ts`，23 用例）**：内存帧缓冲 FakeCanvas + node:zlib 真实 PNG 编解码（CRC32/chunk 严格解析）+ 假渲染器「泄漏模式」——克隆内 visibility 被无视、敏感内容强制画成红色，断言的是**最终 PNG 字节**中敏感区为不透明覆盖色 `rgb(110,110,115)`（含向外取整 + 外扩 1px）、装饰节点不被误伤、仅外扩 1px 处不覆盖；密码框/敏感 img/srcset/背景图/伪元素/SVG image/嵌套溢出并集/旋转缩放小数坐标/视口外与隐藏忽略；失败规则（locate-failed / verify-failed 且 `toBlobCalls===0`——遮挡验证完成前绝不编码 / 污染画布）；缩小重编码 3 轮每轮重填重验证、4 次全超限 size-limit；纯函数（computeCaptureScale / maskRectToOutputPixels / verifyCanvasMaskCoverage / validateProviderResult 全矩阵）。

**Web 异步生命周期（`packages/web/test/lifecycle.test.ts`，23 用例）**：deferred 可控 Promise——普通呼出合并、有草稿不重拍、重拍取消旧会话、finally 不串扰 UI、close() 未开面板也取消、cancelCapture、provider 替换/卸载+重挂（保留字节重建 URL、不重复绑定）/appId 变化、两实例隔离、provider 同帧证明拒用/接受、提交快照冻结（禁用编辑/同 key 同字节重试/未知结果保留原请求/409 不换 key/重拍失败保旧图/登录挂起迟到捕获不入请求）；`vi.mock('html2canvas-pro')` 内置路径失败不丢旧预览、成功路径端到端 PNG 像素覆盖断言。

**Flutter 像素级遮挡（`capture_mask_pixel_test.dart`，10 用例）**：真实 `ui.instantiateImageCodec` 解码 PNG 后逐像素断言——遮挡中心/内圈不透明覆盖（视觉色取 RGB + 强制 alpha=0xFF）、周围布局正确无泄漏、旋转 45°+缩放 2x AABB 允许多遮/不允许少遮（该用例修复了 RenderTransform.paintBounds 不含变换的真实 bug）、obscureText 中性灰保护、双实例像素级隔离、几何失效中止且旧截图逐字节保留、初始捕获失效无预览、统一图片限制公式 3 条边界。

**Flutter 异步生命周期（`capture_lifecycle_test.dart`，11 用例）**：先截图后开面板（同步断言面板未展开）、A/B 交错仅 B 交付、取消/关闭/销毁/控制器替换四路径、恢复草稿不重拍、面板侧丢弃过期序号交付、临时 ui.Image/ui.Picture 成功/取消/中止三路径全释放（onCreate/onDispose 全局计数）。

**服务端归档中断恢复（`apps/server/test/fault-injection.test.ts`，13 用例，独立临时库 + 进程内 HTTP）**：断言**远端调用次数**（created/uploads/finalizes/comments 长度与 putCalls/commentCalls/finalizeCalls/listCalls 计数器）、**key**（`finalizes[0].key === "key-task-1"`、upload.key/outcome、签名过期换新 key `key-task-1-2` 且不等于旧 key）、**task ID**（`kaneo_task_id === "task-1"` 复用、恢复轮零任务创建、目标改变零远端写入）、**评论身份**（内容含反馈 ID/摘要/资产引用、数量唯一、`comment.outcome` 从 not_sent/maybe_sent → confirmed；schema 级 `comment.id` 往返与非法类型拒绝）。另有 archive-data 20、pipeline 25、screenshot-pipeline 8 用例覆盖数据格式、分阶段恢复、操作锁与 revision 乐观锁、旧格式兼容（`loadArchiveData` legacy 分支、字节核对、下载 404 待核对）。

### 4. 文档与实际行为一致性

| 文档 | 结论 |
|---|---|
| `packages/web/README.md` | ✅ 重写：属性表（theme/show-launcher/launcher-bottom/launcher-mode/capture-mode）、方法与事件（captureAndOpen 合并与恢复草稿语义、close 取消、cancelCapture 顺序）、截图与遮挡三步语义/失败规则/2.3 限制公式/html2canvas-pro 支持范围、captureProvider 完整契约（signal/viewport/sensitiveRegionCount/sameFrameMasking/maskedRegions、旧回调兼容）、行为摘要（先截图后开面板/草稿实例所有/快照冻结/幂等与 409/未知结果保留）、包体与懒加载、测试架构 |
| `flutter/feedback/README.md` | ✅ 更新：截图与遮挡支持范围（作用域/变换/obscureText/maskColor 不透明化/几何失效中止）、统一图片限制公式与失败语义、捕获会话与草稿/重拍/取消契约、提交冻结快照、回归测试索引 |
| `docs/api.md` | ✅ 更新：capture 元数据（viewportWidth/Height 逻辑 vs pixelWidth/pixelHeight 输出，输出像素不完整 → 400；`outputWidth` 别名已作废为未知字段）、retry/resolve/recover 契约（expectedRevision、409 busy/revision_conflict/invalid_state、502 recover_failed、allowedActions/actionTargets、recheck/force-create/retry_comment/replace_upload 语义与目标）、4.5 旧记录兼容 |
| `docs/deployment.md` | ✅ 本轮补全：分阶段恢复动作与人工操作含义（recheck/force-create/retry_comment/replace_upload + 乐观锁/互斥）、备份一致性要求（先停旧 worker、WAL 停机拷贝或 `.backup`）、升级部署顺序、新格式恢复数据备份与**回退限制**（新版本产生远端写入后不得简单恢复旧库重放）；修正旧「不包含截图」的过时边界 |
| `VERIFICATION.md` | ✅ 本文件（第 2 轮记录） |

### 5. BLOCKED / 未验证（本环境不具备或未重跑，如实标注）

1. **真实浏览器三浏览器截图（Chrome/Firefox/WebKit）**：Firefox 与 WebKit 本机未安装（Playwright 缓存仅有 chromium）→ **BLOCKED**；系统 Chrome/Chromium 可用，但 `e2e/run_browser.py` 无遮挡断言步骤、本轮未扩展真实浏览器遮挡验证 → **未验证**。像素级遮挡安全性由 Web（happy-dom + 真实 PNG 编解码+泄漏模式渲染器）与 Flutter（真实渲染管线 + 真实 PNG 解码）双层自动化覆盖，但不等同于真实浏览器像素验证。
2. **Docker 容器级重启恢复**：Docker 29.5.3 可用，但本轮未对新归档格式重跑 `e2e/run_docker.py`（第 1 轮 12/12 为旧版行为）→ **未验证**；中断/崩溃恢复由 fault-injection 进程内重启模拟（独立数据目录 + 新 app 实例）覆盖。
3. **真实 Kaneo AI 图文闭环**：无真实 Kaneo 实例与 AI 密钥 → **BLOCKED**；仅 fetch 级契约 mock 验证（Kaneo 仓库零修改）。
4. **管理页恢复动作交互**：retry/resolve/recover 仅 API 级验证（含 409 busy/revision_conflict、allowedActions 内容）；真实浏览器点击操作 → **未验证**。
5. apk/iOS 构建本轮未重跑（见上表，第 1 轮已验证）。

### 6. 抽查结论

- Web/Flutter 测试为**像素级断言**（最终 PNG 解码后逐像素验证敏感区不透明覆盖与周围布局），非仅断言调用遮挡函数 —— ✅ 通过。
- 归档恢复测试断言远端调用次数 / key / task ID / 评论身份 —— ✅ 通过（附低优先建议：故障注入用例可在 `maybe_sent → recheck` 命中后追加 `comment?.id` 与 mock 远端 id（`comment-1`）一致的断言，将评论 ID 的集成级断言与 schema 级断言补全）。
- 三类缺口均有对应回归测试且全部通过 —— ✅ 通过。
- 门禁全部真实运行且通过 —— ✅。

---

## 第 3 轮（服务身份隔离 / 归档一致性 / 草稿与重试 / 接入文档，2026-09-10）

环境：macOS，Node v26.7.0，pnpm 11.23.0，Docker 29.5.3，Flutter 3.41.3 / Dart 3.11.1，Playwright + 系统 Chrome（无 chromium_headless_shell）。仓库**无 git commit**（全部文件未跟踪），因此无法用 `git diff` 界定改动；下面按文件与命令实录。

### 1. 全仓门禁（本轮全部重新真实运行）

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm -r test` | ✅ exit 0 | web **10 文件 / 105 用例**全过（新增 `identity.test.ts` 17）；server **9 文件 / 126 用例**全过（新增 `archive-consistency.test.ts` 10 与资产下载凭据边界 10）；admin 以浏览器验证代替单测 |
| `pnpm -r typecheck` | ✅ exit 0 | 7 个项目（admin / server / web / react / vue / ssr / html） |
| `pnpm -r lint` | ✅ exit 0 | server biome **0 error**（9 warning + 1 info，均为既有 `noExplicitAny`）；web eslint 通过；admin biome 通过 |
| `pnpm -r build` | ✅ exit 0 | admin 216.89 kB；web ESM + 懒加载 chunk + UMD；react / vue 产物含 `html2canvas-pro.esm-CQ8baKsv-744Yx3ZH.js` 251.46 kB |

Flutter 门禁（`/Users/sakurasep/flutter/bin/flutter`，不在 PATH）：

| 项目 | 结果 |
|---|---|
| `flutter test`（flutter/feedback） | ✅ **76 用例**全过（第 2 轮 52 → 76，新增 24，未删除任何既有用例） |
| `flutter analyze`（flutter/feedback） | ✅ `No issues found!` |
| `flutter test`（examples/flutter） | ✅ 4 用例全过 |
| `flutter analyze`（examples/flutter） | ✅ `No issues found!` |

### 2. 本轮先写失败测试再修复（真实记录）

| 测试文件 | 修复前（真实失败） | 修复后 |
|---|---|---|
| `packages/web/test/identity.test.ts`（17 用例） | **12 failed \| 5 passed** —— 旧服务 201 迟到响应仍派发 `feedback-submitted`；在途轮询把旧记录写进新身份卡片；`api-base` / `app-id` 变化后轮询仍在跑（60s 内 12 次 GET）；切换后令牌未清（B 会收到 A 的 `Authorization`）；`api-base` 变化未清草稿；`app-id` 在途提交把新身份锁死在 `submitting`；旧 `appId` 令牌被接受用于新 `appId` 提交；服务端已接收的失败卡片缺刷新/复制/找回入口 | ✅ 17/17（连跑 3 次无 flake） |
| `apps/server/test/archive-consistency.test.ts`（10 用例） | **8 failed \| 2 passed** —— 恢复入口未统一检查已保存目标（远端写入 +3）；评论结果未知被记为 `not_sent`；过期上传地址自动换新 key（`archived` 而非 `needs_review`）；同 key 被拒后自动申请新地址；`allowedActions` 未提供 `replace_upload` | ✅ 10/10 |
| `flutter/feedback/test/token_store_scope_test.dart`（7 用例） | **0 passed \| 4 failed** —— 服务 B 读到服务 A 的令牌；键就是全局 `feedback_widget.bearer_token`；A 的 `clear()` 清掉 B；同一 `apiBase` 不同 `appId` 共槽 | ✅ 全过 |
| `flutter/feedback/test/draft_capture_guard_test.dart`（8 用例） | **3 passed \| 5 failed** —— 已有草稿再点球仍发起截图并覆盖旧截图字节；拖动/`captureAndOpen()` 同样绕过草稿；重拍中关闭面板后永久不可见 | ✅ 全过 |
| `flutter/feedback/test/submit_failure_class_test.dart`（9 用例） | **2 passed \| 3 failed** —— 换/删截图后仍复用同一幂等键；服务端已接收（Class B）仍二次 `POST /api/feedback` | ✅ 全过 |

**资产下载凭据边界（`apps/server/test/external-clients.test.ts` 新增 10 用例）**：本项**不是失败优先**——`kaneo-http.ts` 的可信来源校验与 `manual` 重定向处理先于测试落地，因此没有"修复前"取证。为证明断言有效，做了一次**变异验证**：把 `assertTrustedAssetUrl` 换成裸 `new URL(...)`、并把跨源重定向的 `sameTrust` 强制为 `true`，重跑得 **4 failed \| 24 passed**（失败项正是「非可信来源零请求」「相似域名不被信任」「非 http(s) 协议拒绝」「跨源重定向不带 Authorization」）；还原后 **28/28 通过**。断言内容：只向可信 Kaneo 主机（含子域与 `clientUrl`）携带 `Authorization` 且 `redirect="manual"`；非可信来源 / 相似伪造域名（`k.local.evil.com`、`notk.local`）/ `file://` / 非法 URL → 抛 `KaneoDefiniteError` 且 **fetch 调用数为 0**；跨源重定向第二跳**不带** `Authorization` 且以 `redirect="error"` 拒绝再跟随；同源重定向保留凭据并按原 URL 解析相对 `Location`；两跳仍是重定向 → 停止跟随；缺 `Location` → 明确报错；404 保持"不能证明文件不存在"语义。

既有用例中被**重新表述**（而非削弱/删除）的 3 处：server `fault-injection` 两例与 `pipeline` 两例（原断言"评论结果未知 → 恢复自动重发""签名过期 → 自动换新 key"）、Flutter `feedback_panel_test` 一例（原断言 Class B 二次 POST）。新表述断言的是本轮确立的规则（自动路径绝不重发、只有显式 `retry_comment` 发一次、过期地址只能 `replace_upload`），覆盖面严格大于原用例。

### 3. 真实浏览器 E2E（`python3 e2e/run_browser.py`，真实系统 Chrome + 真实 `apps/server`）

- 第 3 轮：**174/174 通过**（exit 0，后因交付后回归新增 P5 变成 **179/179**，见第 10 节）。新增三条路径：
  - `p1_orb_drag`（33 断言）：真实 `mouse down/move/up` 拖到 (256,192) → `releasePoint={"x":0.2,"y":0.24}` → 提交 `metadata.capture` → 服务端落库一致 → AI 提示原文含「用户关注落点：归一化坐标 x=0.20 (20%), y=0.24 (24%)」；灵感球原位 48×48 **全白**、组件强调色 0 像素（球与面板均不入图）。
  - `p2_mask_pixels`（24 断言，Pillow + numpy 真实解码 PNG）：`[mask]` 区 68676/68676、密码框区 14868/14868 全为 `rgb(110,110,115)`；全图 `#ff00ff`/`#00ffff` 各 0 像素；邻近带遮罩色 0 像素（不外溢）；客户端与服务端 PNG 分别验证。
  - `p3_mask_failure`（17 断言）：可见敏感区无法在克隆中定位 → 内置路径真实抛 `CaptureError: [locate-failed]`，用户看到「截图未完成」，旧草稿文字与旧截图字节（sha256 前缀 `7cf1bf5c`）原样保留、0 次提交；泄漏型 `captureProvider`（含 69095 个未遮挡像素且未声明同帧遮挡）被拒绝且从未上传；同图 + `sameFrameMasking`/`maskedRegions` 声明则被接受。
  - `p4_login_handshake`（47 断言）：真异源页投递伪造令牌被忽略（宿主确实收到消息但无伪造令牌请求）；正确类型 + 错误 nonce + 旧真实令牌同样被忽略；切换到第二个服务实例后，打到新服务的请求 `authorization` **全为 null**，旧令牌全流程只出现在旧服务。
- 顺带修复的测试盲区（非产品缺陷）：`e2e/mock-external.mjs` 此前缺图文归档端点（`/task/image-upload/*`、`/comment/:taskId`），导致**任何带截图的提交在 e2e 下必然 failed**、图文归档零覆盖；本轮补齐并断言预签名上传地址零凭据。
- 文档与 UI 文案不一致（非功能缺陷）：`docs/api.md` 原写「received→已接收」，而组件实际渲染「已保存，正在整理」等文案。**已修正 `docs/api.md`**，使其只记录真实文案，并注明状态值本身只出现在 HTTP 契约里。

### 4. Docker 容器级验证（`python3 e2e/run_docker.py`）

真实镜像构建（`feedback-service:local`）+ 真实容器 `fb-e2e`（`-p 8790:8787`）+ 宿主 mock（Kaneo :8898 / AI :8899），真实 `docker restart`（单次运行 8 次）。**未挂载仓库真实 `./data`**（运行前后 `data/feedback.db` 的 mtime 未变）。

**59/59 通过**（exit 0）。构成：原有 12 项（名称与语义未改）+ 新增环境复位 1 + 阶段检查 46。

原本的 12 项：管理登录与软件配置、容器→宿主 Kaneo mock 连通、提交 201、容器内流水线归档完成、宿主 mock 收到容器创建的任务、`archiving` 中断 + 重启后数据持久、重启后转 `needs_review`（不盲目重发）、`recheck` 命中真实任务并关联归档、恢复过程零重复创建、重启后同幂等键重放返回原记录。

新增的第 1 层覆盖 —— **图文归档每个「远端写入阶段」的中途重启**，注入方式是用 mock 的真实控制面 `POST /__mock/fail {stage,mode:"hold",afterWrite}` 把请求**挂起在应答之前**（远端写入已真实发生），此时 `docker restart` 容器：

| 阶段 | 重启后断言（服务端状态 + mock 记录的真实远端事实双重核对） |
|---|---|
| 1 `createTask` | 真·在途重启 → 崩溃前本地尚无 `kaneo_task_id` → 重启后 `needs_review` 且仍无 ID → `recheck` **按反馈 ID**搜到既有任务并归档，**绝不重复创建**；恢复后各阶段恰好各 1 次 |
| 2 `createImageUpload` | 重启后 `needs_review`、恢复数据存活（固定归档目标 + 任务 ID）、未重复建任务、未产生评论/资产；恢复完成后两次预签名**指向同一 Kaneo 任务**，PUT/finalize/评论各 1 次 |
| 3 二进制 PUT | 崩溃前 mock **已真实收到字节**、本地 `upload.outcome=maybe_sent` 已在请求离开进程前落盘 → 重启后仍为 `maybe_sent`（**绝不降级为 `not_sent`**）、恢复数据（key + 加密凭证）存活 → 自动恢复**同 key 重传相同字节**（两次 PUT 的 sha8 相同）、**未申请新地址**（预签名仍 1 次）、资产/评论各 1 次 |
| 4 `finalizeImageUpload` | 崩溃前 PUT 已确认（`confirmed`）→ 重启后 `confirmed` 存活、**零重传**（PUT 仍 1 次）→ 只对**原 key** 再次 finalize，资产唯一、评论 1 条 |
| 5 `createComment` | 评论已落远端、响应丢失 → `maybe_sent` 落盘并在重启后保持 → 自动 `recheck` **查重命中即归档、零重发**（评论 POST 仍 1 次、远端仍 1 条）；另测「评论未落远端」变体：自动路径**仍不重发**，只有显式 `retry_comment` 才发且**恰一条** |
| 12 上传地址过期 | 预签名返回 `?Expires=<过去>` → 重启后 `maybe_sent` + `expiresAt` 原样保留 → 自动路径**绝不申请新地址**（预签名仍 1 次，`error_summary` 含"过期"）→ 唯一出路 `replace_upload`：**复用原任务**申请新地址，旧 key 记入 `replacedKeys`、远端旧对象不删除 |
| 13 同 key 重传被拒 | 首次 PUT 结果未知 → 恢复时同 key 被 403 → 自动路径**绝不换 key**（预签名仍 1 次，`error_summary` 含"同 key"）→ `replace_upload` 复用原任务换新 key 完成归档（评论 1 条、任务仍 1 个） |

第 2 层：被顺带修掉的**测试替身缺陷**（非产品缺陷）—— mock 原先固定返回 `http://127.0.0.1:8898` 的预签名地址，容器内服务端连不上，导致**在此之前容器里的图文归档链路根本走不通**（PUT 直接 `fetch failed`）。现已可配置基址（默认不变）。

**环境坑（已写入 `e2e/run_docker.py` 头部文档）**：本套件依赖数据在 `docker restart` 后存活。在 macOS Docker Desktop 上用宿主 `/tmp` **绑定挂载**会偶发丢失 —— 实测同一套命令一次 12/12 通过、一次在重启后 `apps/feedbacks/settings` 全空只剩 `users`（服务端在空目录上重新建库），直接表现为 `items` 为空而报错；改用 **Docker 命名卷** `-v fb-e2e-data:/data` 后稳定 59/59（已连续多次）。原因是 SQLite WAL 依赖 `-shm` 共享内存映射，跨宿主文件共享层不稳定。**这不是产品缺陷**，但首次在本机复现时极易误判为归档丢失。

### 5. 独立安装验证（脱离 monorepo workspace links）

- `pnpm --filter @feedback/web build` → exit 0；`pnpm --filter @feedback/web pack --pack-destination /tmp/fb-pack` → exit 0，产物 `feedback-web-0.1.0.tgz`（196 KB，含 `dist` 全部产物**与懒加载分块** `html2canvas-pro.esm-CQ8baKsv.js`）。
- 在 `/tmp/fb-host`（monorepo 之外的全新 npm 项目）执行 `npm install /tmp/fb-pack/feedback-web-0.1.0.tgz` → 0 vulnerabilities；`html2canvas-pro` 作为真实依赖一并安装。
- 在 happy-dom 模拟 DOM 中真实导入已安装产物：
  - ESM `import('@feedback/web')` → 导出 `FEEDBACK_ELEMENT_TAG / FeedbackWidget / defineFeedbackWidget / openFeedback`；`customElements.get('feedback-widget')` 已注册；`shadowRoot` 存在；`open/close/captureAndOpen/cancelCapture` 均为 function；`launcher-mode` / `capture-mode` 未设置时读回 `null`（即默认 `tab` / `off`）。
  - CJS `require('@feedback/web')` → 同样注册成功（UMD 入口可用）。

### 6. 真实 AI / 真实 Kaneo（本轮在已配置的真实环境实跑）

在真实 `apps/server`（`.env` + `data/feedback.db` 中已配置的真实 Kaneo `https://kaneo.xn--fhqths51enha.cn`、项目 `gvfgclb9idzgi0jdfqg4wk72` / 列 `待筛选`，真实 AI `https://ark.cn-beijing.volces.com/api/coding/v3` / `deepseek-v4-flash`）上真实提交：

- **纯文字闭环 ✅ 通过**：`POST /api/feedback` → 201 → 真实 AI 整理出标题与结构化三段（使用体验/问题/建议/待确认）→ 真实 Kaneo 创建候选任务 → 终态 `archived`，`kaneoUrl = https://kaneo.xn--fhqths51enha.cn/dashboard/workspace/ujhqmhAOywzRnoqy0UUH3KaZajQriUI1/project/gvfgclb9idzgi0jdfqg4wk72/task/lj77fcjze1lwfatgogewo0b4`（反馈 ID `37b9ad39-2880-4acb-97a7-fb750cb99616`，`attemptCount=1`，无 error）。
- **图文闭环 ❌ BLOCKED（环境能力，非代码缺陷）**：带截图的提交（反馈 ID `f6349d52-c201-44e5-ab1a-b272df971a41`）在 AI 阶段被真实拒绝 —— `AI 接口返回 400: Model do not support image input`。截图本身**已真实入库**（`screenshot.width/height/byteSize/sha256` 齐全，`capture.releasePoint={x:0.2,y:0.24}` 与 `viewportWidth/Height=1280/800` 持久化，管理页 `hasScreenshot: true`），即"提交 → 图片校验/重编码 → 落库 → 恢复信息"链路真实可用；缺的是所选模型不具备视觉输入能力，本轮无法完成带图归档。
- 上述两条真实提交均在用户已授权的测试项目中创建了记录：纯文字那条已在 Kaneo 生成任务 `lj77fcjze1lwfatgogewo0b4`（**待人工核对后清理**）；图文那条因 AI 失败停在 `failed`，**未在 Kaneo 创建任何任务**。Kaneo 仓库零修改。

### 7. 文档交付

| 文档 | 结论 |
|---|---|
| `docs/integration.md` | ✅ **新建**（911 行，8 章齐全 + 相关文档）。第 1 章三方责任与配置顺序、`localhost`/`127.0.0.1` 分别登记；第 2 章 tarball/UMD/ESM 分块/Flutter `path`+固定 commit、工具版本、明确"不发布、不 push"；第 3 章 HTML/React/Vue/SSR/Flutter 五份示例（全部显式 `orb` + `viewport`，并说明默认 `tab`/`off`）；第 4 章完整属性/方法/事件表 + `openFeedback()` 纠偏（只调 `open()`，不承诺截图）+ `feedback-submitted` = 服务端已接收 ≠ Kaneo 已归档；第 5 章路由与生命周期；第 6 章截图范围（显著标注**仅当前应用可见视口**、无局部裁剪/无系统悬浮窗/不跨应用）+ 可复制遮挡示例 + 图片限制 + `captureProvider` 契约；第 7 章登录/网络/平台 + 「代码支持 / 构建验证 / 实机闭环」诚实表；第 8 章失败处理与排查表。**89 个相对链接全部有效（BROKEN 0）**。 |
| 各 README 链接 | ✅ 根 `README.md`、`packages/web/README.md`、`flutter/feedback/README.md`、`examples/{html,ssr,react,vue,flutter}/README.md` 均链接到 `docs/integration.md` |
| `README.md`（根） | ✅ 修正三处不准确说法：「无原生依赖」（server 实为含原生依赖 `sharp`+libvips，DB 才是内置 `node:sqlite`）、「仅文字」（实为截图+文字多模态）、新增「截图范围（重要，别误读）」章节 |
| `packages/web/package.json` / `README.md` | ✅ 修正「运行时零依赖」：唯一运行时依赖是 `html2canvas-pro@2.4.2`，仅内置视口截图路径使用，ESM 下懒加载 |
| `docs/api.md` | ✅ 新增 `409 target_changed`；`retry_comment` 先查重再**至多一条**评论 + 竞态仍可能重复；`replace_upload` 是唯一替换入口；`not_sent`/`maybe_sent`/`confirmed` 语义表；`hasScreenshot`/`actionNotes` 与动作门禁；修正面板文案 |
| `docs/deployment.md` | ✅ 新增 §4.1 `target_changed` 运维处置、§4.2 上传地址过期/同 key 被拒的人工替换路径、§4.3 自动重试从不补发第二条评论 |
| `apps/admin` | ✅ 恢复区新增逐动作风险说明（`actionNotes`）与 `retry_comment` 重复风险确认框，并改写底部说明不再暗示重发无风险 |

### 8. BLOCKED / 未验证（如实标注，不得读作已通过）

1. **真实 AI + Kaneo 的「图文」闭环**：**BLOCKED**。真实环境已跑通纯文字闭环；带图闭环被所配模型能力挡住。**后续补充取证（同一真实环境，改进了原先过于简略的表述）**：
   - 截图链路本身**完全正常**：截图已真实入库（640×400 / 1359 字节 / `sha256` / `capture.releasePoint={x:0.2,y:0.24}` / viewport 1280×800），真实浏览器像素级验证通过（179/179，见第 3、10 节）。
   - 卡点在 AI：当前 `ai.baseUrl` 是**编码套餐端点** `https://ark.cn-beijing.volces.com/api/coding/v3`，该端点**只提供编码类模型**——实测 `doubao-1.5-vision-pro-250328`、`doubao-1-5-thinking-vision-pro-250428`、`doubao-vision-pro-32k-241028` 三个视觉模型全部 `404 The requested model does not support the coding plan feature`。
   - **能力探针（决定性）**：用 96×96 纯红 PNG 问"主色调"，当前模型 `deepseek-v4-flash` 带图与不带图**回答完全相同**（均答"看不到"）→ 该模型**没有视觉能力，图片被静默丢弃**。
   - **因此比"失败"更危险**：同一条生产路径（`ai.organize()` + 真实截图）**两次调用结果不一致**——流水线里那次返回 `400 Model do not support image input`（硬失败、反馈转 `failed`），补测时同样调用却返回 **200 并正常产出 JSON**，即"归档成功但 AI 从未看过截图"的**静默降级**，用户与开发者都不会察觉。
   - 换到标准端点 `https://ark.cn-beijing.volces.com/api/v3` 后模型列表可见视觉模型，但本账号对这些模型返回 `404 does not exist or you do not have access to it` → 需在火山方舟控制台**开通视觉模型**或改用推理接入点 `ep-xxxx`，**这不是本仓库能修的问题**。
   - 结论：**截图能用；AI 看图不能用**。纯文字闭环真实通过；图文闭环在换用支持视觉的模型/端点前**不得标注为通过**。
2. ~~**Firefox / WebKit 真实浏览器**：**BLOCKED**~~ → **第 10 节已解除**：为排查截图缩略图缺陷已实际安装 Playwright Firefox 146.0.1 与 WebKit，并在两引擎上实测了组件面板与管理页的截图渲染/放大。仍**未**做的：把完整 179 条 E2E 场景在 Firefox/WebKit 上整套重跑（本轮在这两个引擎上只跑了截图相关路径），因此其余场景仍不能推断到这两个引擎。
3. **管理页恢复动作的真实浏览器点击**：**未验证**。`retry` / `resolve` / `recover`（含 `409 busy` / `revision_conflict` / `target_changed`）仅到 API 级；管理页新增的风险提示与确认框经 `tsc` + `biome` + 构建产物核对，**未经真实点击**。
4. **host 应用的真实安装闭环**：部分验证。npm tarball 已在 monorepo 之外真实安装并成功导入注册；但**未在一个真实第三方宿主应用**里跑完整提交。
5. **Flutter 实机 / 平台构建**：**未验证**。本轮只跑 `analyze` + `test`（76 + 4 用例，均为真实渲染管线 / 真实 PNG 解码），未重跑 `apk` / `ios` / `macos` 构建，未在真机安装。Flutter 安全存储用例通过插件的内存测试平台（`FlutterSecureStorage.setMockInitialValues`）驱动真实存储代码与真实键派生，**不是**真实 Keychain / EncryptedSharedPreferences 后端。
6. **Flutter 跨仓库 Git 依赖写法**（`git: url/ref/path`）：仓库内无任何文件使用该形式，`docs/integration.md` 已显式标注为"未在本仓库验证的配置"。
7. **Flutter 运行时热切换 `apiBase`/`appId`**：包内未导出运行时替换配置的入口，语义**未定义也未验证**；文档按"请重建组件实例"表述，未编造行为。
8. **真实 Kaneo / S3 的预签名行为**：**未验证**。Docker 套件里"上传地址过期"用 mock 的 `Expires` 参数模拟，**没有**真实 `X-Amz-*` 签名与真实过期；真实存储侧是否会产生未被追踪的孤儿对象，本环境无法观测。
9. **阶段 2（申请上传地址）无法被断言为 `maybe_sent`**：这是**产品实现限制**（`maybe_sent` 只在 PUT 前与评论 POST 前落盘，预签名阶段没有"结果未知"标记的落盘点），Docker 套件因此**如实断言真实行为**并在检查名里标注，**没有**伪装成"符合 no-new-key 用例"。该第三种情形（离线期间已补记）为避免误读已写入 `docs/api.md`；`worker.ts` 里原先自相矛盾的注释也已改正。
10. **Kaneo 测试数据需人工清理**：真实闭环在用户项目 `gvfgclb9idzgi0jdfqg4wk72` 留下任务 `lj77fcjze1lwfatgogewo0b4`（纯文字那条）；带图那条因 AI 失败未创建任务。**本仓库不自动删除远端数据**，需人工核对后清理。

### 9. 抽查结论

- 本轮四条主线（服务身份隔离、归档一致性、Flutter 草稿与两类失败、接入文档与示例）均**先写失败测试并跑出真实失败**，再改实现转绿 —— ✅。
- 归档一致性用「远端写入次数」而非仅状态断言（目标改变时零写入、未知结果零自动重发、过期地址零新 key、`replace_upload` 才替换）—— ✅。
- 真实浏览器已补上像素级遮挡断言与凭据隔离断言（此前只有 DOM/单测层覆盖）—— ✅。
- 文档诚实性：`docs/integration.md` 第 7.3 节把「代码支持 / 构建验证 / 实机闭环」分列，实机未验证项一律标 ❌ —— ✅。
- 未做且明确排除：部署、发布包、提交推送、生产数据迁移、Kaneo 仓库修改 —— ✅ 本轮均未触碰。
- 远端写入的安全性论证是**有依据可查**的，不是"看起来安全"：无 upload 记录 ⇒ 字节从未发出，依据是**落盘顺序**（上传记录与 `maybe_sent` 都先落盘、之后才 PUT，`worker.ts` 有对应注释与 `fault-injection` 的 `uploads.length===0` 断言）；三种情形（有记录且过期 / 有记录且同 key 被拒 / 完全无记录）的取舍已在代码注释与 `docs/api.md` 显式区分。

### 10. 交付后回归：用户实测发现的真实缺陷（已修，含失败优先取证）

**现象（用户报告）**：在网页端看到的**反馈截图缩略图是失效的，并且无法放大**。

**根因**：`packages/web/src/styles.ts` 里 `.fb-screenshot-wrap { display: flex }` 是**作者规则**，会压掉浏览器默认样式表的 **UA 规则** `[hidden] { display: none }` —— 于是 `element.hidden = true` **完全失效**，元素照旧占据版面 362×167。

**触发条件（覆盖面很大）**：宿主**未声明 `capture-mode`**（组件默认值就是 `off`，即绝大多数存量宿主）时面板会显示一个空的「当前截图 / 点击放大 / 重新截图 / 移除截图」区，缩略图 `src` 为空 → **破图占位**，点击也无法放大（无截图时 `openZoomModal()` 直接返回）；同理「移除截图」看起来毫无反应（`hidden = true` 不生效），而草稿里的截图字节其实已被清空 —— 用户可能以为带图提交，实际没带。

**为什么此前四轮都没发现**：`e2e/run_browser.py` 的**每一个**宿主页都显式写了 `capture-mode="viewport"`（React/Vue 示例也是），默认 `off` 的可视路径从未被真实浏览器渲染过；而单测跑在 happy-dom 上，**不做 Shadow DOM 样式级联**，断言不到 `hidden` 是否真的生效。原有 `.fb-panel[hidden] { display: none !important }` 是一条**局部补丁**，说明这个坑此前踩过一次，但只补了面板、漏了截图区。

**失败优先取证（真实运行）**：先新增宿主页 `e2e/pages/off.html`（**故意不声明** `capture-mode`）与 5 条真实浏览器断言，在修 CSS 之前运行得到：

```
FAIL  P5a 默认 capture-mode=off：截图区必须真的不可见（[hidden] 生效）
      — {'hidden': True, 'display': 'flex', 'visible': True, 'w': 362, 'h': 167, 'imgSrc': None, 'brokenImg': True}
```

**修复**：在 Shadow DOM 样式表顶部加全局兜底 `[hidden] { display: none !important; }`（并删除只覆盖面板的局部补丁），同时把该类的成因、真实故障形态与回归位置写进注释，避免每新增一个设置 `display` 的组件规则就重踩一次。

**修复后（真实运行）**：`python3 e2e/run_browser.py` → **179/179 通过**（原 174 + 新增 5）：

```
PASS  P5a 默认宿主入口可见（未声明 launcher-mode → 贴边标签）
PASS  P5a 默认 capture-mode=off：截图区必须真的不可见（[hidden] 生效）
PASS  P5a 默认模式：要么没有截图，要么缩略图能解码（不得「有 src 却加载失败」）
PASS  P5b viewport 模式：移除前缩略图是真图（有 blob src + 解码成功）
PASS  P5b 点「移除截图」后截图区必须真的隐藏（不能只是 hidden=true）
```

**跨引擎核查**（本轮为排查该问题新装 Playwright Firefox 146.0.1 与 WebKit，同时解除了第 2 轮记录里的 BLOCKED 项）：Chromium（系统 Chrome）、Firefox、WebKit 三引擎 × 「组件面板缩略图/放大」与「管理页详情缩略图/灯箱」两个界面均实测正常（缩略图真实解码成功、放大可用）；管理页走**真实登录表单**路径同样正常。即该缺陷是 **CSS 级联**问题，与引擎无关。

**Flutter 端无同类问题**：`flutter/feedback/lib/src/panel.dart:1079` 用 `if (_screenshotBytes != null) ...` 条件渲染，不依赖 `hidden` 语义。

**未覆盖（如实标注）**：`off` 模式下的**提交**链路（无截图提交）本次只验证了面板渲染，未在真实浏览器里跑完整提交归档。

**第 4 轮已补上这条**：P6 走的就是 `off`（未声明 `capture-mode`）宿主的手动截图 → multipart 提交 → 服务端落库，见下节。

---

## 第 4 轮（Web 侧边组件手动截图入口，2026-09-11）

环境：macOS，Node v26.7.0，pnpm 11.23.0，真实系统 Chrome（Playwright 1.58），真实 `apps/server`（:8787 / :8788），AI 与 Kaneo 为 `e2e/mock-external.mjs`。
**范围**：只改 Web 组件（`packages/web`）及其单测 / 浏览器回归 / 文档。未改 Flutter、AI、Kaneo、数据库；**未执行发布部署**。

### 1. 缺陷（源码确认，与用户报告一致）

**现象**：Web 侧边组件没有截图入口——既没有首次截图入口，输入文字后也没有补拍入口。

**根因（两条叠加，均在 `packages/web/src/element.ts`）**：

1. `syncUi()` 只在 `draft.screenshotUrl` 存在时显示 `.fb-screenshot-wrap`，而「重新截图 / 移除截图」两个按钮**长在这个 wrap 里** → 没有截图时操作区随预览一起隐藏。默认 `capture-mode="off"`（不自动截图）的宿主打开面板后**没有任何截图入口**；`off` 下呼出也**不**调用 `captureAndOpen()`（`bindEvents` 里 `launcher` 点击走 `open()`）。
2. 呼出式 `captureAndOpen()` 带草稿恢复规则（`isDraftDirty()` = 有文字**或**有截图 → 只恢复草稿、绝不重拍）→ 用户**先输入文字**之后，连"呼出即补拍"这条路径也不成立。

**为什么 105 个用例没发现**：基线实测 `pnpm --filter @feedback/web test` **105/105 通过**，但既有用例的截图入口全部直接调用 `captureAndOpen()` / `retakeScreenshot()`（或点 `.fb-btn-retake`），**没有一个用例经过"面板里那个还不存在的按钮"**；happy-dom 也没有 Shadow DOM 样式级联，断言不到 `[hidden]` 的真实可见性。

### 2. 选定方案（已确认的界面行为变化）

- 默认提供**手动**截图：`capture-mode="off"` 的语义明确为「关闭**自动**截图」，面板里始终有手动的「截取当前页面」。
- 打开面板**不自动拍摄**；`capture-mode="viewport"` **保持**原有自动捕获行为。
- 手动入口复用现有**显式重拍流程**，不调用会被文字草稿拦下的 `captureAndOpen()`；首次截图与重拍都保留已有文字。
- **不新增公共 API / 依赖 / 服务端字段**：`open()` 仍只打开面板，`captureAndOpen()` 仍保留草稿恢复规则；新增的 `captureFromPanel()` / `restorePanelFocus()` / `syncShotUi()` 全是私有实现。

### 3. 实现（`packages/web/src/element.ts` + `styles.ts`）

- **预览与操作分离**：新增 `.fb-shot-area` 容器；`.fb-screenshot-wrap` 只放缩略图（无截图 → `display:none` 且缩略图 `src` 一起撤掉，杜绝"有 src 却加载失败"的破图占位）；`.fb-screenshot-actions` 常驻，含「截取当前页面 / 重新截图 / 移除截图」三件套，按 `hasShot` 互斥显示。
- 「截取当前页面」是主色填充按钮（默认 off 宿主里它是唯一的截图方式），窄屏（≤767.98px）下加大到触屏可点尺寸并允许换行。
- **加载 / 禁用态**：`isCapturing` 期间三件套 `disabled` + `aria-busy="true"` + 文案「截取中…」；该状态在隐藏面板**之前**同一 tick 落到 DOM，面板随后整体 `visibility:hidden` → 加载态与组件 UI 都不可能进入截图。会话结束（成功 / 失败 / 失效）即恢复真实可用性。
- **防重入**：`captureFromPanel()` 在 `phase==='submitting' || polling || isCapturing` 时直接返回；`removeScreenshot()` 增加与按钮禁用态一致的提交 / 轮询守卫；`startPolling()` 补一次 `syncUi()`，让禁用态与 `polling` 同帧（此前 201 之后按钮会停在"可用"的旧状态）。
- **焦点**：捕获期间面板 `visibility:hidden`，真实浏览器会把焦点丢到 body → 结束后把焦点还回去（优先点击前的元素，已隐藏 / 禁用则回到 textarea）；焦点卡在已隐藏控件上（部分引擎不主动失焦）同样处理；用户已聚焦到可见的别处时绝不抢焦点。
- **迟到结果**：继续复用既有会话失效机制（`captureSeq` + `identityEpoch`），关闭 / 卸载 / 换 `app-id` / 换 `api-base` 后到达的截图既不写草稿也不再开面板。窄屏焦点锁 `focusables()` 现在排除 `[hidden]` 子树（否则会把焦点交给不可见的缩略图）。
- **未触碰**：敏感区遮挡与遮挡失败规则、图片尺寸 / 体积限制、组件自身排除逻辑（P1/P2/P3、masking 用例、P6 的像素断言全部照旧通过）。

### 4. 单测（105 → 120 全过；含失败优先取证）

`pnpm --filter @feedback/web test` → **11 文件 120 用例全部通过**；新增 `packages/web/test/capture-entry.test.ts` 15 例：默认入口、先输入文字再手动截图、手动截图随 multipart 提交（字节一致）、首次失败保留重试入口、移除后补拍、重拍失败留旧图与文字、连击只发起一次（加载态 + `aria-busy`）、关闭 / 卸载 / 换身份后迟到结果丢弃、焦点兜底（含"卡在隐藏按钮"分支）、提交与轮询期间禁止截图 / 移除。

**失败优先取证（真实运行）**：把 `syncShotUi()` 临时改回修复前的行为（`captureBtn.hidden = true`，即"没有首次截图入口"）后重跑该文件：

```
× 默认 capture-mode=off：呼出面板不自动拍摄，但面板里有「截取当前页面」
× 首次截图失败：保留手动重试入口与文字，重试可成功
× 移除截图后回到首个入口：可再次补拍且文字保留
× 捕获期间关闭面板：迟到结果不开面板、不写草稿，UI 恢复可用
× 捕获期间卸载：迟到结果不写入草稿，重挂载后不出现预览
× 捕获期间切换身份（app-id）：迟到结果不写入新身份
Tests  6 failed | 9 passed (15)
```

（修复前更彻底：`.fb-btn-capture` 节点根本不存在，该文件全部用例都会失败。）恢复源码后 `shasum` 校验一致，120/120 通过。

### 5. 真实浏览器 E2E：`python3 e2e/run_browser.py` → **237/237 通过（exit 0）**

真实系统 Chrome + 真实 `apps/server`；组件产物为最终源码构建的 `packages/web/dist/feedback-web.umd.cjs`（`sha256` 前缀 `f4d23c789f41fea1`）。相对第 3 轮的 179 项，本轮新增 / 增强 58 项：

- **P5 增强（8 项，含 3 项新增）**：默认 `off` 宿主的截图区必须 `display:none` 且不占版面，**同时**必须能看到可用的「截取当前页面」；无截图时「重新截图 / 移除截图」`display:none` 不占版面；viewport 模式点「移除截图」后回到首个入口并保留文字。
- **P6 新增（32 项）——真实侧边标签的完整路径**（宿主页 `e2e/pages/manual.html`，不声明 `capture-mode` / `launcher-mode`）：
  - 打开**不自动截图**：全程 `URL.createObjectURL` 计数 = 0，且预览 `display:none`、缩略图无 `src`、`naturalWidth=0`（不只是"看不见"）；
  - 面板里存在可用入口 `截取当前页面`，无截图时「重新截图 / 移除截图」不出现；
  - **先填文字**再真实点击该按钮 → 有效 PNG（**1280×800、28320 字节**）、文字保留、入口切换、面板恢复可见、状态区无失败提示；
  - 像素级：两个敏感区（`[data-feedback-capture-mask]` 与 `input[type=password]`）**全部为 `rgb(110,110,115)`**（直方图 91224 像素），绿色 / 蓝色正常内容可见（56646 / 37450 像素），敏感区原色 0 像素；**面板原区域与侧边标签原区域全部为纯白宿主背景**、全图组件强调色像素 **0** → 截图不含反馈面板与入口；服务端落库 PNG 复核同样的遮挡断言；
  - 预览放大：真实点击缩略图 → 弹窗 `visibility:visible` 且大图 `naturalWidth>0`，Esc 只关弹窗、面板保持打开；重拍产生新的有效 PNG 且保留文字；
  - 提交：真实登录弹窗 → multipart `screenshot` 部件**字节 sha256 与本地做像素断言的同一份一致**，`metadata.capture` 无 `releasePoint`、viewport/pixel 均 1280×800，服务端记录 1280×800 且 `capturedAt` 存在。
- **P7 新增（10 项）——窄屏 390×844 + 键盘**：无截图时预览 `display:none` 且宽度 0（无破图占位）；手动按钮文案正确、高 ≥32px、不溢出面板与视口；面板全屏且 `aria-modal=true`；**键盘 Enter 激活截图**产生 390×844 有效 PNG 并保留文字；截图后焦点实测 `BUTTON.fb-btn-capture` → **`TEXTAREA.fb-textarea`**（在面板内、非隐藏、非禁用，没掉到 body）；截图无组件强调色像素。

### 6. 仓库门禁（本轮全部重新真实运行）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @feedback/web test` | ✅ 11 文件 **120/120 通过** |
| `pnpm --filter @feedback/web typecheck` | ✅ exit 0 |
| `pnpm --filter @feedback/web lint` | ✅ exit 0 |
| `pnpm --filter @feedback/web build` | ✅ exit 0：ESM `86.28 kB`（gzip 24.25）、懒加载 chunk `328.98 kB`（gzip 75.65）、UMD `320.25 kB`（gzip 83.73） |
| `python3 e2e/run_browser.py` | ✅ **237/237 通过**（真实系统 Chrome + 真实服务端，外部服务为 mock） |

### 7. 文档交付

- `packages/web/README.md`：`capture-mode` 属性说明（`off` = 关闭自动截图）、`open()` / `captureAndOpen()` 语义边界、行为摘要新增「手动截图」条目（含失败重试、加载态、焦点、提交期禁用）、包体体积更新、测试架构提示新增 `capture-entry.test.ts` 与 P5/P6/P7。
- `docs/integration.md`：属性表 `capture-mode` 行、「明确结论（易踩坑）」新增一条（`off` ≠ 没有截图入口）、FAQ 新增「默认 off 时找不到截图入口 / 输入文字后无法补拍」、能力表 E2E 行更新为第 4 轮 237/237。
- `README.md`：多模态说明补上"默认关闭自动截图时面板里仍有手动截图"。

### 8. BLOCKED / 未验证（如实标注，不得读作已通过）

- **宿主接入验证：未提供真实宿主页面，未验证**。本轮全部结论来自仓库内源码、单测、真实浏览器 + 真实服务端（AI / Kaneo 为 mock）与文档；**这不等于线上问题已修复**——真实宿主需按 `docs/integration.md` 接入后自行确认「面板里有「截取当前页面」、点它能出图、提交带图」。
- 未在 Firefox / WebKit 重跑本轮新增的 P6 / P7（第 3 轮曾用三引擎核查 `[hidden]` 级联与缩略图渲染，本轮改动是同一条级联路径上的新增节点）。
- 本轮未触碰、也未验证：Flutter 端（其面板用条件渲染，无同类缺口）、真实 AI / 真实 Kaneo 的图文闭环（仍为第 3 轮记录的 BLOCKED）、管理页、数据库、Docker、发布部署。
- P6 的 `off` 链路提交用的是 mock AI / mock Kaneo（与既有 P1–P4 一致），未验证真实外部服务。

### 9. 抽查结论

缺陷定位与用户在真实宿主观察到的现象一致（默认 `off` + 先写文字 → 无任何截图入口）；修复把「首个截图入口」做成常驻操作区、与预览解耦，语义只改一处（`off` = 关闭自动截图）；单元与真实浏览器证据都覆盖了首次截图、先文字后截图、失败重试、移除后补拍、重拍失败留旧图、连击、关闭 / 卸载 / 换身份、提交期禁用、窄屏与键盘；**宿主接入未验证**，因此对外表述只能是"仓库内已验证"，不能说线上已修复。

## 第 5 轮（原位登录 / 账号管理 / 每日额度，2026-09-12）

日期：2026-09-12 · 环境：macOS，Node v26.7.0，pnpm 11.23.0，Flutter 3.41.3 (Dart 3.11.1)，Playwright 1.58 + 系统 Chrome（真实浏览器）。

任务状态：**T1 / T2 / T3 均「待体验」**（实现完成，仓库门禁与真实浏览器/HTTP 验证通过；等待用户确认后才标记「已验收」）。执行顺序 T2 → T3 → T1。

### T2 账号与管理权限（待体验）

实现：`users` 增加 `role` / `enabled` / `daily_limit`（默认 3），后台新增「账号」页与 `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/password`；所有后台接口、会话管理、反馈重试/恢复统一要求**管理员角色 + 现有 Cookie/同源检查**（`requireAdminCookie`），禁用账号或重置密码即时撤销其全部会话，鉴权每次联查账号启用状态。

自动化证据（`apps/server/test/accounts-quota.test.ts`，新增 14 例）：

- 创建账号默认每日 3 次；重复用户名 409；响应不含口令或哈希。
- 禁用账号立即撤销会话（401）；启用后可重新登录；重置口令同样撤销旧会话。
- 普通账号即使持有 Cookie，访问 `/api/admin/*` 与 `/api/auth/sessions` 一律 403 `forbidden`；管理员不出现在账号列表、也不可被本页管理。
- 额度从 3 调 5、当天已用 3 → 立即剩余 2；降到 1 → 剩余 0。

真实浏览器/后台操作证据：管理页真实登录 → 「软件配置」创建 `com.verify.app`（允许来源 `http://127.0.0.1:5199`）→ 「账号」页创建 `alice`，列表显示「启用 / 每日上限 3 / 今日已用 0 / 剩余 3（下次刷新时间）」；「反馈」列表新增「提交账号」列，3 条记录均显示 `alice`。
HTTP 证据：`alice` 的 Bearer 令牌调 `GET /api/admin/users`、`GET /api/auth/sessions` 均 `403`。

### T3 每日额度与反馈归属（待体验）

实现：`user_version` 迁移 v2 → v3（事务内完成，失败回滚且版本号不前进）；沿用原账号迁为管理员、保留口令与会话、历史反馈归属初始账号且不追扣；新增按「账号 ID + 北京时间日期」唯一的 `daily_usage`。`submitFeedbackAtomic` 在单个事务内：核验账号有效 → 检查幂等 → 检查额度 → 保存反馈与截图 → 增加用量 → 提交，之后才入队；日期与 `resetAt` 由服务端时钟产生。幂等保留全局唯一键：同账号同键同内容重放不扣次（额度满也可重放），他账号占用同键统一 `idempotency_conflict`；普通账号只能读自己的反馈/截图（他人 404），管理员全量。

自动化证据：

- 迁移：v2 旧库 → 账号角色 `admin`、`enabled=1`、`daily_limit=3`、口令保留；`fb-old.user_id` 归初始账号；`user_version=3`；注入 `UPDATE users` 触发器失败时整体回滚（版本号仍 2、`role` 列不存在）。
- 额度：默认 3、第 4 次 429 `daily_quota_exceeded` 且带同结构 `quota`；跨两个 app 合计；另一账号独立 3 次；并发生效（剩余 1 时并发两条 → 一条 201、一条 429）；事务失败（注入 `INSERT INTO feedbacks` 抛错）用量保持 0。
- 幂等：重放不扣次、额度满仍可重放；同键不同内容 409；他账号占用同键 409 且不返回 `feedbackId`。
- 北京时间日切（可控服务端时钟）：`2026-01-01T15:59Z`（北京 23:59）用尽 → 越过 `16:00Z`（北京次日零点）后额度恢复，`resetAt` 正确。
- 归属：普通账号读他人记录/截图 404；管理员详情返回 `username`；普通账号调用 `/api/feedback/:id/retry` 403。

真实浏览器/HTTP 证据：跨源宿主页（`127.0.0.1:5199`，服务 `127.0.0.1:8787`）面板内登录 `alice` 后连续提交 3 条，额度依次 3 → 2 → 1 → 0；剩余 0 时提交按钮禁用并显示「今日提交次数已用完，下次可提交时间：2026/9/14 00:00:00」，草稿保留。HTTP 复核：`quota` 结构 `{dailyLimit:3,used:3,remaining:0,resetAt}`；额度 0 提交返回 `429 daily_quota_exceeded` + 同结构 `quota`；原生（无 `Origin`）令牌登录放行。

### T1 当前面板内登录（待体验）

实现：Web 组件（`element.ts` / `auth.ts` / `api.ts` / `styles.ts`）与 Flutter（`panel.dart` / `api_client.dart` / 平台文件）都改为**面板内账号密码登录**，不再打开登录窗口：未登录仍可编辑，点击「登录并提交」就地展开表单（确认按钮同文案），成功后只提交一次，取消只收起表单。`POST /api/auth/login` 令牌模式显式携带 `clientLabel` + `appId`，按该应用 `allowedOrigins` 校验浏览器 `Origin`（原生无 `Origin` 放行）；登录/会话查询/退出支持跨源 Bearer CORS；旧握手端点兼容保留且签发绑定当前登录用户。响应统一带 `user` 与 `quota`；`daily_quota_exceeded` 明确按「未接收」处理（保留草稿、不套用「结果未知」）。额度在打开面板 / 登录成功 / 提交完成 / 恢复前台时刷新。

自动化证据：

- Web：`packages/web` 11 文件 126 例全过，`auth.test.ts` 覆盖展开表单不打开窗口、确认文案、凭据错误清空密码保留草稿、`clientLabel=web:<appId>` + `credentials:'omit'`、来源被拒提示、额度展示、打开面板刷新额度（GET `/api/auth/session`）、429 `daily_quota_exceeded` 按未接收处理并禁用新提交；身份隔离用例改为登录响应绑定世代。
- Flutter：`flutter analyze` 无问题；`flutter test` **78/78 通过**，覆盖未登录可编辑、面板内表单、`appId` 随登录发送、`user`/`quota`/`fetchSession` 解析、额度用尽禁用与提示、401 后重登续交。
- 服务端：新增令牌登录 appId/Origin 校验用例（未带 appId 400、来源未登记 403、appId 未登记 404、原生无 Origin 放行）。

真实浏览器证据（`python3 e2e/run_browser.py`，真实系统 Chrome + 真实服务端，**225/225 通过，exit 0**）：未登录点提交在当前面板展开表单且**未打开任何新窗口**；异源宿主（`127.0.0.1:5199` ↔ `127.0.0.1:8787`）直接登录并提交成功；凭据错误提示且保留草稿；`api-base` 切换后旧令牌绝不发往新服务；旧 P1–P7 截图/灵感球/像素/窄屏路径全部照旧通过。`e2e/browser_paths.py` 与 `e2e/run_browser.py` 的弹窗握手流程已同步改写为面板内登录。

体验入口：宿主页示例见仓库 `examples/`；`e2e/pages/*.html`；管理页 `/admin`（「账号」页）。本地起服务：`pnpm dev` 后打开 `http://127.0.0.1:8787/admin`（后台）与任一接入 `feedback-widget` 的页面（面板内点「登录并提交」）。

### 仓库门禁（本轮全部真实运行）

| 命令 | 结果 |
|---|---|
| `pnpm -r typecheck` | ✅ exit 0（server / admin / web / examples react / vue / ssr） |
| `pnpm -r lint` | ✅ exit 0（server / admin biome，web eslint；仅既有 `noExplicitAny` 警告） |
| `pnpm -r test` | ✅ server **150/150**（10 文件）、web **126/126**（11 文件），admin 以浏览器验证代替单测 |
| `pnpm -r build` | ✅ exit 0（server tsc、admin / web / examples vite） |
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **78/78 通过** |
| `python3 e2e/run_browser.py` | ✅ **225/225 通过**（真实系统 Chrome + 真实服务端，AI / Kaneo 为 mock） |

### 未验证 / BLOCKED（如实标注，不得读作已通过）

- **Flutter 原生真机流程未运行**（第 5 轮当时的结论，**已在第 6 轮部分更正**）：第 5 轮本环境只跑了 `flutter analyze` 与 `flutter test`；第 6 轮已在本机 **macOS 原生** 跑通面板内登录 / 提交 / 额度用尽 / 调额恢复 / 重开刷新（见第 6 轮第 4 节）。**Android / iOS 仍未验证**（无模拟器/真机），**macOS 原生 Keychain 令牌持久化在本环境未验证**（ad-hoc 签名无 Keychain access group，见第 6 轮第 5 节）。
- **Flutter Web 真浏览器未运行**（第 5 轮当时的结论，**已在第 6 轮更正**）：第 6 轮已用系统 Chrome 加载真实 Flutter Web 产物对真实服务完成跨源原位登录 / 提交 / 额度 / 重开实测（见第 6 轮第 3 节）。
- **真实 Kaneo / 真实 AI 未接入**：浏览器 E2E 中外部服务为 mock；本轮账号/额度/登录逻辑与外部服务无关，但归档闭环仍未用真实外部服务复跑。
- **发布与生产迁移未执行**：未做 Docker / 生产库迁移；迁移仅在临时库与测试注入下验证。
- 迁移脚本在真实 v2 生产库上的规模与耗时未评估（逻辑与回滚已用测试覆盖，但未压测）。


---

## 第 6 轮（T1 补修：登录失效与额度刷新生命周期，2026-09-13）

日期：2026-09-13 · 环境：macOS（Apple Silicon），Node v26.7.0，pnpm 11.23.0，Flutter 3.41.3 (Dart 3.11.1)，Playwright 1.58 + **系统 Chrome**（`channel=chrome`，无头），真实 Feedback 服务端（隔离数据目录），外部 AI / Kaneo 为 mock。

任务状态：**T1 = 「待体验」**（实现完成、仓库门禁与三个真实入口实测通过；等待用户确认后才标「已验收」）。T2 后台账号管理、T3 服务端计次规则未改动。

### 1. 本次修复（T1 补修）

**T1-A 过期的登录操作失效**

- Web（`packages/web/src/element.ts`）：新增独立递增的**登录序号** `loginSeq`。关闭面板、取消登录、组件卸载、`api-base`/`app-id` 变化都会递增序号，并清除密码、登录忙碌状态与待自动提交标记。登录回调（成功与失败两条路径）返回后必须同时满足「序号未变 + 身份世代未变 + 组件仍连接」才允许写令牌 / 更新界面 / 自动提交。
  - 关闭面板对已建立的登录态、草稿与截图**无副作用**；「取消」按钮在登录进行中保持可用（否则用户无法中止挂起的登录）。
- Flutter（`flutter/feedback/lib/src/panel.dart`、`widget.dart`）：同样的 `_loginSeq` 语义，并且在**写入令牌之前**与**写入完成之后**各校验一次；第二次校验失败时**不做无条件清库**（避免误删更新的凭据），只保证不更新界面、不自动提交。宿主通过新增的内部协作参数 `FeedbackPanel.visible` 传入**真实开关状态**（截图期间暂时隐藏不算关闭，兼容既有直接构造面板的测试，`visible == null` 时行为与旧版一致）。

**T1-B 统一额度刷新与生命周期**

- 统一调度：未登录 / 面板未打开 / 应用不在前台不排程；**额度用尽 → 每 30 秒刷新**（与 `resetAt` 合并取更早者，同一时刻最多一个定时器）；其它状态只在服务端 `resetAt` 排**单次**查询，到期只向服务端取值，**不自行把剩余次数改回 3**。
- 刷新结果除身份与令牌外还校验**查询序号**：提交成功、收到额度错误、401、关闭、卸载、退到后台、身份变化都会使旧查询失效，旧查询不得把次数加回。401 回到需要登录态并停止定时查询；网络失败保留旧额度与草稿，30 秒后再试（不对过期 `resetAt` 立即循环）。
- **本轮发现并修复的真实缺陷**：`resetAt` 若异常超远（> 2^31−1 ms），宿主定时器会把延时截断为立即触发，形成对服务端的**紧密循环请求**。已加安全上限（Web 24 小时 / Flutter 24 小时）并补了失败用例（Web 用真实定时器，去掉上限即失败）。

### 2. 回归测试（先补能抓住缺陷的用例，再实现修复）

新增 12 个 Web 用例 + 12 个 Flutter 用例，另有 1 条 Web 真实浏览器路径：

| 用例 | 覆盖 |
|---|---|
| `packages/web/test/login-invalidation.test.ts`（5） | 登录挂起期间关闭 / 卸载 / 取消 → 迟到的成功不写令牌、不自动提交、草稿保留；重新打开后可继续编辑并重新登录（只提交一次）；旧登录的迟到失败不覆盖新登录 |
| `packages/web/test/quota-lifecycle.test.ts`（7） | 用尽后 30 秒轮询恢复（后台 3→5、已用 3 → 剩余 2）；跨 `resetAt` 只触发一次有效刷新；网络失败 30 秒后重试且不紧密循环；旧额度查询迟到不覆盖提交后的次数；关闭 / 退到后台无轮询、重开 / 回前台立即查询；401 停止定时；`resetAt` 超远不因定时器溢出紧密循环 |
| `flutter/feedback/test/login_quota_lifecycle_test.dart`（9） | Flutter 面板层同上（含「失效的登录不调用令牌写入」用记录型令牌仓库断言） |
| `flutter/feedback/test/panel_visibility_wiring_test.dart`（3） | 宿主把真实开关状态传给常驻面板；关闭不轮询、重开立即刷新（不是只请求焦点）；**截图期间暂时隐藏时 `panel.visible` 仍为 true** |

**先红后绿证据**：实现修复前，`packages/web/test/login-invalidation.test.ts` + `quota-lifecycle.test.ts` 共 11 例中 10 例失败（唯一通过的是与序号无关的断言）；把 `element.ts` 的登录序号校验临时去掉并重建后，`e2e/run_browser.py` 的 P5 路径真实失败（`P5 迟到的登录成功后仍未登录（主按钮仍是「登录并提交」）`）。两处均已在恢复实现后转绿。

### 3. 三个真实入口实测

**3.1 Web 真实浏览器（`python3 e2e/run_browser.py`，系统 Chrome + 真实服务端，AI / Kaneo 为 mock）**

✅ **234/234 通过，exit 0**。新增路径 **P5「登录期间关闭 / 重新打开」**（9 条断言全过）：用页面内慢网络（延迟 `window.fetch` 上的 `/api/auth/login` 2.5 秒）制造「登录请求挂起」，在响应返回前用真实鼠标点击关闭面板，随后核对真实网络层与界面：

- 迟到的登录成功**不触发自动提交**（该上下文 `POST /api/feedback` 计数 0）；
- 迟到的登录成功后主按钮**仍是「登录并提交」**（未进入已登录态）；
- 重新打开**保留草稿**且仍可编辑；重新登录后**只自动提交一次**；
- 已登录面板显示「今日剩余」；**关闭后不再查询额度**；**重新打开立即重新查询额度**（`GET /api/auth/session`）。

> 环境说明：新增路径使用**独立测试账号**（`e2e-user-2`）。登录限流按「IP｜用户名」计数，共用账号会把主链路推到 10 次/15 分钟上限（复现过一次 `P6` 登录被限流的假失败），分账号后稳定。

**3.2 Flutter Web（真实 Flutter Web 产物 + 系统 Chrome + 真实服务端，跨源）**

- 启动：`cd examples/flutter && flutter run -d web-server --web-port=5300 --web-hostname=localhost`；
- 浏览器：Playwright `chromium.launch(channel="chrome", headless=True)` 打开 `http://localhost:5300`；
- 服务端登记：`appId=com.example.demo`，`allowedOrigins=["http://localhost:5300"]`（宿主 Origin 与服务 `http://localhost:8787` 不同源）；
- 隔离数据目录 + 独立测试账号（当日额度上限 1）。

✅ **10/10 断言通过**：跨源原位登录（`POST /api/auth/login` 打到真实服务，无新窗口）→ 服务端落库 1 条 → 额度用尽（服务端剩余 0、客户端不再发起提交、草稿保留并显示「今日提交次数已用完」）→ 后台把上限调到 3 → **面板不重开**，30 秒轮询后剩余变 2 且恢复提交（服务端新增第 2 条）→ 关闭面板后无额度查询 → **重新打开立即查询额度**（`GET /api/auth/session`）。

> 偏差说明：计划写的是 `flutter run -d chrome`。实际 `-d chrome` 的调试端口无法被外部自动化附着（`Unable to connect to Chrome debug port`），改用 `-d web-server` 提供真实 Web 产物、由**系统 Chrome** 加载同一份构建；被测对象与应用行为不变。

**3.3 macOS 原生（真实 macOS 应用进程 + 真实服务端）**

- 命令：`cd examples/flutter && flutter test integration_test/t1_native_lifecycle_test.dart -d macos`（集成测试在**真实 macOS 嵌入器**里跑同一套组件：真实 Timer、真实 HTTP 到真实服务端）。

✅ **1/1 通过**：灵感球打开面板 → 未登录可编辑、登录表单不自动出现 → 点提交**就地展开登录表单** → 原位登录并**自动提交一次**（服务端剩余 0）→ 额度用尽时新提交按钮禁用 → 后台调高上限 → **面板未重开**，≤30 秒轮询后剩余 2 且恢复提交（服务端新增第 2 条）→ 关闭 → 改额 → **重新打开立即刷新**为「今日剩余 5 次」（上限 7 − 已用 2）。

### 4. 仓库门禁（本轮全部真实运行）

| 命令 | 结果 |
|---|---|
| `pnpm test`（= `pnpm -r test`） | ✅ exit 0：web **138/138**（13 文件）、server **150/150**（10 文件）、admin 以浏览器验证代替单测 |
| `pnpm typecheck`（= `pnpm -r typecheck`） | ✅ exit 0（server / admin / web / examples react / vue / ssr） |
| `pnpm lint`（= `pnpm -r lint`） | ✅ exit 0（server biome 18 warning + 1 info 为既有；web eslint 通过） |
| `pnpm build`（= `pnpm -r build`） | ✅ exit 0（server tsc、admin / web / examples vite） |
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **90/90 通过**（新增 12 例） |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter test`（`examples/flutter`） | ✅ **4/4 通过** |
| `flutter test integration_test/t1_native_lifecycle_test.dart -d macos` | ✅ 1/1 通过 |
| `python3 e2e/run_browser.py` | ✅ **234/234 通过**，exit 0 |

### 5. 未验证 / BLOCKED（如实标注，不得读作已通过）

- **macOS 原生 Keychain 令牌持久化未验证**：示例为 **ad-hoc 签名**（`TeamIdentifier` 未设置），`flutter_secure_storage` 写入返回 `PlatformException(..., Code: -34018, Message: A required entitlement is not present.)`；补 `keychain-access-groups` 后 ad-hoc 应用**无法启动**（`Error waiting for a debug connection`），关闭 Debug 沙箱同样无法绕过。因此 3.3 的集成测试**注入 `MemoryTokenStore`**：验证的是真实 macOS 应用进程里的**流程**，不是原生安全存储写入。要在真机验证需有效的 Apple 开发者签名身份 + Xcode Keychain Sharing 能力。
- **macOS 原生合成输入不可用（已停止盲目重试）**：分别尝试 ①`osascript`/System Events `click at`、②CoreGraphics `CGEventPost`（HID 与 `PostToPid`）、③带 `CGEventSource(HIDSystemState)` + `kCGMouseEventClickState` 的注入。③ 能让**内容区点击**生效（面板可打开），但**键盘输入无法进入密码框**（同一套注入对输入区与用户名字段有效；已排除 Secure Event Input：`IsSecureEventInputEnabled()` 全程为 false，现场存在系统输入法候选态）。故改用集成测试驱动。
- **Android / iOS 未验证**（无模拟器/真机）。macOS 成功不等于 Android / iOS 已验证。
- **真实 Kaneo / 真实 AI 未接入**：三个入口的外部服务均为 mock，本批不宣称真实归档闭环。
- **发布与生产迁移未执行**：未做 Docker / 生产库迁移；跨日验证用可控 `resetAt` 与真实时钟，**未修改系统时间**。

### 6. 需要报告的两处示例权限 / 依赖变更（非组件与服务的公开配置）

- `examples/flutter/macos/Runner/{DebugProfile,Release}.entitlements`：新增 `com.apple.security.network.client`。原模板缺失该项，**App Sandbox 下示例应用无法访问反馈服务**（这也是上一轮「macOS 原生不可用」之外的真实缺口）。
- `examples/flutter/pubspec.yaml`：`dev_dependencies` 增加 `integration_test`（SDK 包，仅用于原生验证）。

### 7. 体验入口与操作步骤（T1 = 待体验）

1. **Web**：`pnpm dev` 起服务后打开任一接入 `feedback-widget` 的宿主页（`e2e/pages/*.html`、`examples/react|vue`）；面板内点「登录并提交」→ 不打开新窗口、就地展开表单 → 登录后只提交一次。**额度用尽时保持面板打开**，后台「账号」页调高上限，≤30 秒即可继续提交。
2. **Flutter Web**：`cd examples/flutter && flutter run -d chrome --web-port=5300`，并把 `http://localhost:5300` 登记到该应用的允许来源。
3. **macOS 原生**：`cd examples/flutter && flutter run -d macos`（示例配置指向 `http://localhost:8787`、`appId=com.example.demo`）。

---

## 第 7 轮（T1 继续补修：保护新登录、补发额度刷新、默认存储验证通路，2026-09-13）

日期：2026-09-13 · 环境：macOS（Apple Silicon），Node v26.7.0，pnpm 11.23.0，Flutter 3.41.3 (Dart 3.11.1)，Playwright 1.58 + 系统 Chrome（无头），真实 Feedback 服务端，外部 AI / Kaneo 为 mock。工作区含第 5/6 轮全部未提交改动，本轮在其上增量修改、未回退任何内容。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（按本轮任务要求从第 6 轮的「待体验」回到实现中：T1-A / T1-B 与存储失败提示已完成并全部验证；默认 Data Protection Keychain 的登录/提交/重启恢复验证受签名环境阻塞，见 §5。只有用户确认才标「已验收」）。

### 1. 本次修复

**T1-A 旧请求的 401 不得清除新登录（Flutter + Web）**

- Flutter 新增内部令牌协调层 `flutter/feedback/lib/src/token_coordination.dart`（不入公开导出）：
  - `CoordinatedTokenStore` 包装任意 `FeedbackTokenStore`：**操作队列**（read/write/clear 全串行，登录写入与 401 条件清除之间不允许插队）+ **认证世代**（write/clear 成功后递增）。
  - 共享粒度：默认 `SecureFeedbackTokenStore` 按 `storageKey`（`apiBase`+`appId` 派生键）跨实例共享同一协调器；其余仓库按实例共享。公开接口与宿主自定义存储实现零改动（`SecureFeedbackTokenStore` 仅新增只读 `storageKey` getter）。
  - `clearIfCurrent(lease)`：世代不符**或**底层令牌已被更换 → 返回 false（不清除、不通知）；都符合才清除。
- `api_client.dart`：三个认证方法（fetchSession / submitFeedback 含 multipart 分支 / fetchFeedback）改为**请求发出前**经 `lease()` 捕获「实际使用的令牌 + 认证世代」；401 统一走 `_handleUnauthorized(lease)`——仅当前世代才 `clearIfCurrent` + `onUnauthorized`；失效请求仍向原调用者抛 `ApiException(401)`。无无条件 `clear()` 补救，也不忽略任何 401。
- `panel.dart`：`initState` 用 `CoordinatedTokenStore.of(...)` 包裹（登录写入与 ApiClient 共享同一队列与世代）；提交/刷新状态的 401 分支只退出忙碌态，过期认证错误不改写界面；「同账号重新登录后幂等重试」行为不变。
- Web（`packages/web/src/element.ts`）：额度刷新 401 原有 `quotaResultValid` 令牌比对已正确；**提交 / 轮询 / 手动刷新**三处 401 补上同样的令牌归属校验（捕获请求所用令牌，`usedToken !== accessToken` 时只退出忙碌态——轮询按退避续排下一拍，不清凭据、不改登录界面、草稿与快照保留）。

**T1-B 被占用时登记「待立即刷新」，结束后立即补发（Web + Flutter 对称实现）**

- 新状态 `quotaRefreshPending` / `_quotaRefreshPending`：打开面板 / 回到前台的刷新被**在途查询或登录/提交忙碌**挡下时登记（布尔标记天然合并多次登记）；旧查询 finally 或忙碌结束点（登录成功、提交成功、额度错误）**优先消费**——条件仍满足立即补发一次并清除标记，否则按既有 30 秒 / resetAt 规则排定时器（不紧密循环、不永久停摆）。
- 清除点仅限生命周期：关闭、卸载/销毁、退到后台、身份变化（Web `identityEpoch` 递增处）、401（防对已失效会话的补发循环）。登录/提交成功不清除（忙碌结束后补发）。
- 既有规则全部保留：查询序号 + 身份 + 令牌三重校验（提交后旧额度不得覆盖扣次）、30 秒失败重试、`QUOTA_MAX_DELAY` 封顶、轮询频率不变。
- Web 会话查询 20 秒超时（`packages/web/src/api.ts`，与 Flutter `_requestTimeout` 一致）：仅 `getSession` 传 `timeoutMs`，AbortController + finally 清定时器；超时按既有失败分支释放占用并 30 秒重试。**提交 / 轮询 / 登录未加任何超时或幂等改动。**

**T1-C 存储失败提示 + 默认存储验证通路**

- `panel.dart _login()`：令牌写入单独 try/catch——安全存储写入失败时提示「**无法保存登录状态，请检查应用的安全存储配置**」，清空密码、取消自动提交、保留草稿，不再统称「网络异常」。不回退内存 / 明文存储、不切换 Keychain 类型、不升级插件。
- 新增两个 macOS 集成测试（默认存储路径，**不注入 tokenStore**）+ 公共设施（`examples/flutter/integration_test/t1c_secure_storage_{common,write_test,recovery_test}.dart`）：隔离存储键（`http://127.0.0.1:8787` + 独立探针槽位）、固定测试账号、写后真实重启（两次 `flutter test -d macos` 调用之间）验证恢复会话并提交，最后仅清理该测试身份数据。开头探针在默认 Data Protection Keychain 不可写时以 `markTestSkipped` 输出明确 BLOCKED 原因（本机即此情形，exit 0，见 §5）；签名环境就绪后通过统一执行入口执行默认存储验收。
- 既有 `t1_native_lifecycle_test.dart` 保留为**内存令牌仓库流程验证**，标题与文件头明确「不作为默认存储验收」。

### 2. 回归测试（先补能抓住缺陷的用例，再实现修复）

新增 16 个 Flutter 用例 + 7 个 Web 用例 + 1 条 Web 真实浏览器路径（P8）：

| 用例 | 覆盖 |
|---|---|
| `flutter/feedback/test/api_client_test.dart`（+3） | 旧会话/旧提交请求挂起期间保存新令牌 → 迟到 401：新令牌保留、回调不触发、仍向调用者抛错；当前世代 401 照常清除并回调（防矫枉过正） |
| `flutter/feedback/test/token_coordination_test.dart`（+8，新文件） | 写入递增世代；世代不符不清除；令牌值比对兜底（绕过协调器直写场景）；队列串行（Completer 控制先后：清除排在挂起写入之后看到新世代）；`of()` 幂等；默认安全存储相同服务身份跨实例共享协调状态、不同身份隔离；写入失败不递增世代且不破坏队列 |
| `flutter/feedback/test/login_quota_lifecycle_test.dart`（+5） | 面板层：旧令牌提交在「额度 401 → 重登」后返回 401 不清新令牌不退登（真实 UI 全路径）；查询挂起期间关闭再打开 → 旧结果丢弃 + 立即补发一次；连续重开/回前台合并为一次补发；提交忙碌期间回前台 → 忙碌结束立即补发；安全存储写入失败 → 精确文案、密码清空、草稿保留、不自动提交 |
| `packages/web/test/quota-lifecycle.test.ts`（+4） | 查询在途时关闭再打开 → 旧结果丢弃 + 立即补发一次；连续重开/回前台合并；登录忙碌暂缓 → 登录成功立即补发；会话查询 6→挂起 20 秒超时 → 释放占用并按 30 秒规则重试 |
| `packages/web/test/login-invalidation.test.ts`（+3） | 旧令牌的提交 / 轮询 / 手动刷新请求在重登后返回 401：新令牌保留、不进入需要登录态（轮询以新令牌继续至归档） |
| `e2e/browser_paths.py` P8（+5 断言） | 慢会话查询在途时关闭/重开：页面侧 fetch 延迟 6s；在途重开不并发（A 出网前 0 条）；A 出网返回后旧结果丢弃并**立即**补发一次（A→B 同窗口）；补发不重复；补发结果生效 |

**先红后绿证据**：实现修复前，Flutter 7 个缺陷级用例（api_client 2 + 面板层 T1-A/T1-B/T1-C 5）全部失败（旧会话/旧提交 401 后 `store.read()` 变 null、T1-B 三例补发计数停 在 1、T1-C 显示「网络异常」而非存储提示）；Web 7 个新用例全部失败（补发计数停 在 0/1、超时用例永不重试、旧 401 清掉新令牌）。既有用例（Flutter 90 / Web 138）两轮全部保持绿。实现后全绿（见 §4）。

### 3. 真实入口实测

**3.1 Web 真实浏览器（`python3 e2e/run_browser.py`，系统 Chrome + 真实服务端）**

✅ **239/239 通过，exit 0**（在最终代码树上复跑确认）。新增路径 **P8「慢会话关闭/重开补发」** 5 条断言全过；第 6 轮全部路径（含 P5）照旧通过。

**3.2 Flutter Web（发布产物 + 系统 Chrome + 真实跨源服务端）**

- 产物：`cd examples/flutter && flutter build web && python3 -m http.server 5300 --directory build/web`；服务端登记 `com.example.demo` 的 `allowedOrigins=["http://localhost:5300"]`。
- 驱动：`python3 e2e/flutter_web_slow_session.py`（坐标驱动，同第 6 轮方法；隔离测试账号口令运行时生成，结束禁用账号并撤销会话；慢会话用页面侧 `window.fetch` 包装延迟第一次 `/api/auth/session` 8s）。

✅ **7/7 断言通过**：跨源原位登录 + 自动续交（服务端剩余 0）→ 额度用尽视图（截图 `e2e/shots/FW-04-exhausted.png`：用尽文案 + 草稿保留 + 提交禁用）→ 后台调额 1→3，**面板未重开**，≤30 秒轮询后成功再次提交（服务端第 2 条、剩余 1）→ 慢会话在途时关闭/重开：**不并发**（A 挂起未出网期间 0 条）→ A 出网返回后旧结果丢弃并**立即补发**（A→B 同窗口，0.01s；缺失实现时下一条要等 30 秒/resetAt）→ 补发不重复。

> 偏差说明：`flutter run -d web-server` 的 DDC 调试产物在系统 Chrome 中首载无法完成启动（连续两次不同依据的尝试后停止盲试），改用**发布构建 + 静态服务**（更贴近真实产物）。另曾尝试语义树驱动（`ensureSemantics` 钩子），但语义 DOM 的全屏 barrier 节点会拦截一切点击，已放弃该钩子并从示例移除；最终采用与第 6 轮相同的坐标驱动。

**3.3 macOS 原生（真实 macOS 应用进程 + 真实服务端）**

- 内存流程验证：`flutter test integration_test/t1_native_lifecycle_test.dart -d macos`（管理员凭据改经 `--dart-define` 注入）→ ✅ **1/1 通过**（内容同第 6 轮）。
- 默认存储验收（T1-C 新增）：`t1c_secure_storage_write_test.dart` 与 `t1c_secure_storage_recovery_test.dart` → **BLOCKED 跳过**（探针实测默认 Keychain 写入返回 -34018，以 skip + 明确阻塞说明结束，两次均 exit 0）。完整执行步骤已写入测试文件头与 §5。

### 4. 仓库门禁（本轮全部真实运行，最终代码树）

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ exit 0：web **145/145**（13 文件，+7）、server **150/150**（10 文件） |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0（server biome 既有 warning；web eslint 通过） |
| `pnpm build` | ✅ exit 0 |
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **106/106 通过**（+16） |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter test`（`examples/flutter`） | ✅ **4/4 通过** |
| `flutter test integration_test/t1_native_lifecycle_test.dart -d macos` | ✅ 1/1 通过 |
| `flutter test integration_test/t1c_secure_storage_write_test.dart -d macos` | ⏸ BLOCKED 跳过（exit 0，探针输出阻塞原因） |
| `flutter test integration_test/t1c_secure_storage_recovery_test.dart -d macos` | ⏸ BLOCKED 跳过（exit 0，同上） |
| `python3 e2e/run_browser.py` | ✅ **239/239 通过**，exit 0 |
| `python3 e2e/flutter_web_slow_session.py` | ✅ **7/7 通过** |

### 5. 未验证 / BLOCKED（如实标注，不得读作已通过）

- **默认 macOS Data Protection Keychain 的登录 / 提交 / 重启恢复验证阻塞（T1-C 核心）**：`security find-identity -v -p codesigning` = **0 个有效签名身份**（本轮复核）；示例为 ad-hoc 签名，默认 Data Protection Keychain 写入返回 -34018（本轮探针再次实测）。依赖确认：`flutter_secure_storage 9.2.4`、macOS 实现 `flutter_secure_storage_macos 3.1.3`（两处 pubspec.lock 一致），默认 Data Protection Keychain。**验证通路已备好**：两个两阶段集成测试（写入 → 真实重启 → 恢复提交 → 清理测试身份）+ 探针跳过机制。具备可用签名身份后：为示例配置匹配的 Team、签名与 Keychain Sharing，核对实际构建产物 entitlements 后运行统一入口 `python3 e2e/run_t1c_default_storage.py`，执行默认存储验收。不虚构 Team ID、不申请付费服务、不清理用户 Keychain、不升级插件、不做内存/明文回退。
- **示例 `widget_test.dart` 一处间歇失败的兜底修复（非本轮缺陷）**：截图范围用例偶发「widget 树销毁后仍有挂起 Timer」（把本轮 lib 改动暂存后基线同样复现，且失败更多）；已在用例收尾推进假时钟越过会话恢复的 2 秒超时兜底，修复后连跑三次全绿。
- **Android / iOS 未验证**（无模拟器/真机）；真实 Kaneo / 真实 AI 沿用 mock；未做发布与生产迁移。
- **集成测试管理员凭据改经 `--dart-define` 注入**（`source .env` 后传给 flutter test），源码不再含凭据字面量；本地库曾缺 `com.example.demo` 应用登记（历史数据变动），已通过管理接口补登并配置允许来源。

### 6. 体验入口与操作步骤（T1 = 实现中：默认 macOS 存储验证阻塞）

1. **Web**：同第 6 轮；新行为——额度查询期间关闭再打开面板，旧查询结束后立即补发一次最新额度；旧请求的迟到 401 不再把重新登录的账号退出。
2. **Flutter Web**：`flutter build web` 后静态服务 `build/web`（或 `flutter run -d chrome`），允许来源登记 `http://localhost:5300`；同上行为，另会话查询有 20 秒超时。
3. **macOS 原生**：同第 6 轮；登录成功但安全存储写入失败时提示「无法保存登录状态，请检查应用的安全存储配置」（保留草稿、清空密码、不自动提交）。


---

## 第 8 轮（T1 最终收尾：默认存储验收的可靠判定，2026-09-13）

日期：2026-09-13 · 环境：同第 7 轮。范围限定 T1-C1/C2/C3（验收机制修正与统一执行）；T1-A、T1-B、计次规则、存储插件、Web/服务端均未改动。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（统一验收入口已可用，实际运行结论为 BLOCKED/退出码 2，见 §3；只有用户确认才标「已验收」）。

### 1. 验收机制修正

**T1-C1 探针只识别已知阻塞（`t1c_secure_storage_common.dart`）**

- 探针返回结构化结论 `T1cCheck {verdict: pass|fail|blocked, reason, cleanupError}`；分类收敛到纯函数 `classifyStorageFailure`（可单测）：
  - **仅** PlatformException 中可明确识别的 OSStatus `-34018`（errSecMissingEntitlement）→ BLOCKED；
  - 其他平台异常、任意非 PlatformException 异常 → FAIL（保留实际错误码与脱敏消息，不伪装成签名问题）；
  - 写后读取为空 / 不一致 → FAIL（只比较长度，不回显内容）；
  - 清理失败独立记录在 `cleanupError`，不覆盖主原因；探针本身通过但清理失败 → 整体 FAIL。
- 探针键为本次运行独立槽位（`<appId>.probe.<runId>`），清理仅针对该键并复核清空；不读写已有用户凭据。
- 恢复前置纯函数 `classifyRestorePrecheck`：记录无效 → FAIL「执行前置错误」；记录有效但存储无令牌 → FAIL「重启后凭据丢失」（禁止跳过）。

**T1-C2 统一执行入口（`e2e/run_t1c_default_storage.py` + 纯判定库 `e2e/t1c_executor_lib.py`）**

- 执行器生成唯一 `runId`，派生本轮专用应用（`t1c-<runId>`，经管理接口登记）、测试账号（口令运行时随机生成，不入日志/报告）与存储身份（存储键由 apiBase+appId 派生）；两阶段注入完全相同参数（写入 `examples/flutter/t1c-defines.json` 固定命名文件，经 `--dart-define-from-file` 注入；该文件已 gitignore）。
- 服务固定为字面量环回地址 `127.0.0.1`（端口经纯数字校验），管理路径白名单；管理员凭据只从环境读取。
- 预检记录依赖版本（Flutter 3.41.3、flutter_secure_storage 9.2.4、macOS 3.1.3）、构建模式（debug，两阶段共用一次构建）与实际签名（`security find-identity` + `codesign -dv`）。
- 阶段判定**同时检查进程退出码与结构化结果文件**：结果文件写入沙盒应用自身容器（`~/Library/Containers/dev.example.feedbackExample/Data/Documents/t1c/<runId>/`，应用可写、执行器可读）；PASS 必须退出码 0 + verdict=PASS + runId 匹配 +（阶段 2）清理布尔项全为 true；exit 0 / skip / 缺文件一律不算 PASS；BLOCKED 也要求退出码 0（skip 路径）。
- 阶段 1 明确 PASS 且应用进程确认结束后才启动阶段 2（进程等待 900s 上限，超时杀本执行器启动的进程组并留日志证据）；阶段 2 不输入账号密码、不注入 tokenStore，从默认存储恢复会话、以界面账号行核对本轮身份、提交成功，最后清理本轮令牌与探针键；执行器服务端核对总用量 `used==2` 并禁用本轮测试账号（撤销会话）；清理未完成记录残留身份、不判 PASS。
- 退出码约定：**0=PASS，1=FAIL，2=BLOCKED**；未知存储错误不得转 BLOCKED。结果同时写入 `e2e/t1c-runs/current/report.json` 与 `history.jsonl`（证据留档，目录已加入 .gitignore）。

**T1-C3 记录修正**：删除第 7 轮「签名就绪后即可自动完整执行」的未经实测保证，改为「签名就绪后运行统一入口执行默认存储验收」；内存集成测试保留为原生流程证据，明确不证明 Keychain 或重启恢复。

### 2. 验收机制自身测试（先于真实运行）

| 输入或场景 | 预期 | 落点 |
|---|---|---|
| 可识别的 -34018（message/details 携带） | BLOCKED | `examples/flutter/test/t1c_probe_classification_test.dart`（13 例，Dart 分类器全分支）|
| 其他平台异常（-25293 等）、非 PlatformException | FAIL，不伪装成签名问题 | 同上 |
| 写后读取为空 / 不一致 | FAIL（不回显内容） | 同上 |
| 探针通过但清理失败 / 主失败+清理失败并存 | FAIL / 两者都记录 | 同上 |
| 记录有效但存储无令牌 | FAIL「重启后凭据丢失」 | 同上（classifyRestorePrecheck） |
| exit 0 但 verdict=skip / 缺失 | FAIL，不得判 PASS | `e2e/test_t1c_executor.py`（15 例，Python 判定） |
| BLOCKED 但退出码非 0 | FAIL | 同上 |
| runId 不一致 | FAIL，不读取其他测试身份 | 同上 |
| 阶段 2 清理布尔项未全 true | FAIL，记录残留身份 | 同上 |
| 两阶段 + 清理 + 用量全过 | PASS | 同上（decide_overall） |
| 阶段未全执行且无已知阻塞 | FAIL（执行器流程缺陷） | 同上 |

✅ `python3 -m unittest e2e.test_t1c_executor` → 15/15；`flutter test`（examples/flutter）→ **17/17**（含 13 例分类器）。

### 3. 真实验收运行（实际阶段结果）

命令：`set -a; source .env; set +a && python3 e2e/run_t1c_default_storage.py`

✅ 按预期结束：**BLOCKED（退出码 2）**。runId=`20260913-160501-06d38a`（同日早一轮 20260913-160015-264bc1 结论相同；两轮之间按 Mimosa L2 复查意见收紧了执行器自身的安全实现：dart-define 改经固定命名文件注入、flutter 子进程命令全部为无插值的字面量列表、产物路径常量名且不含 `..`）：

- 预检通过：专用测试服务 `127.0.0.1:8787`、本轮应用 `t1c-20260913-160015-264bc1`、测试账号已创建；版本与签名已记录（`0 valid identities found`、`TeamIdentifier=not set`、flutter_secure_storage 9.2.4 / macOS 3.1.3、构建模式 debug）。
- 阶段 1 探针：默认 Data Protection Keychain 写入返回 `PlatformException(Code: -34018, A required entitlement is not present.)` → **BLOCKED**（唯一允许的阻塞分类；原始错误码已保留在结构化结果中）；阶段 2 按规则未执行。
- 清理：本轮测试账号已禁用（会话已撤销）；探针键随探针自清。证据：`e2e/t1c-runs/current/report.json`、沙盒容器内 `phase1.json`（只含 runId、测试身份、检查结论，不含令牌/口令）、`history.jsonl`。

### 4. 门禁（本轮实际运行）

| 命令 | 结果 |
|---|---|
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **106/106** |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter test`（`examples/flutter`） | ✅ **17/17**（+13 分类器用例） |
| `python3 -m unittest e2e.test_t1c_executor` | ✅ **15/15** |
| `python3 e2e/run_t1c_default_storage.py` | ✅ 按预期 **BLOCKED（exit 2）** |

Web / 服务端及 React/Vue 示例本轮零改动，按任务要求不重复其门禁（第 7 轮记录仍有效）。

### 5. 待解决条件与 BLOCKED（如实标注）

- **默认 macOS 存储验收等待签名环境**：`security find-identity -v -p codesigning` = **0 个有效身份**（本轮统一入口再次实测并记录）。具备条件后：为示例配置匹配的 Team、签名与 Keychain Sharing，核对构建产物 entitlements（`codesign -dv` 已由执行器自动留档），再运行同一命令 `python3 e2e/run_t1c_default_storage.py` **执行默认存储验收**——两阶段真实通过（退出码 0）才能把 T1 标「待体验」；出现非 -34018 的存储错误将按 FAIL 结束，不会伪装成阻塞。不虚构 Team ID、不自动申请付费服务、不清理用户 Keychain。
- 本轮统一入口运行过的遗留：无（测试账号已禁用、探针键已清、令牌从未写出）。
- Android / iOS、真实 Kaneo / AI、发布与生产迁移：沿用第 6/7 轮记录，仍未验证。

### 6. 体验入口（T1 = 实现中：默认 macOS 存储验证阻塞）

1. **Web**：`pnpm dev` 后打开任一接入 `feedback-widget` 的宿主页。独立可体验。
2. **Flutter Web**：`flutter build web` 后静态服务 `build/web`（允许来源登记 `http://localhost:5300`）。独立可体验。
3. **macOS 原生**：⚠️ 在默认存储验收通过前，此入口的**存储失败会阻断登录续交**（登录成功但令牌无法持久化时提示「无法保存登录状态，请检查应用的安全存储配置」，保留草稿、不自动提交、不进入已登录态）；功能验收以第 7 轮 §3.3 的内存流程集成测试为流程证据，不证明 Keychain 与重启恢复。

---

## 第 9 轮（T1-C 修复：先让验收工具自身可靠，再验证默认安全存储，2026-09-13）

日期：2026-09-13 · 环境：同第 8 轮。范围限定 T1-C 执行器 / 判定库 / 两阶段集成测试的可靠性修复与真实复跑；T1-A、T1-B、账号额度规则、组件登录逻辑、安全存储方式、Web / 服务端业务代码均未改动；未发布、未操作生产数据；开始前已核对脏工作区并保留既有改动。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（验收工具自身缺陷已修复并有全路径测试覆盖；真实运行结论为 BLOCKED / 退出码 2 且**清理已确认完成**；默认存储真实验收通过前不标「待体验」，只有用户确认后才标「已验收」）。

### 1. 修通两阶段执行路径

- **隔离服务**：统一入口自行启动**本轮专用** Feedback 服务——随机空闲本地端口（三轮实测互不相同：50303 / 51947 / 65491）、本轮独立数据目录 `e2e/t1c-runs/<runId>/service-data`、运行时随机测试管理员凭据（`FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD` / `FEEDBACK_MASTER_KEY` 全部随机生成）。不再 `source .env`，也不再连接既有 8787 服务；管理接口只连字面量环回地址 `127.0.0.1`，路径为常量白名单。就绪检查**同时确认本次进程仍存活**（`/healthz` 200 且 `Popen.poll()` 为 None）。
- **应用登记与账号**：调用现有 `POST /api/admin/apps` 创建本轮 `appId`（`allowedOrigins` 为**空列表**，原生客户端不带 Origin），随即回查 `GET /api/admin/apps` 一致（appId 与 allowedOrigins 都必须相符）；再创建 `dailyLimit = 2` 的本轮账号并回查一致（username / dailyLimit / enabled）。创建响应与回查不一致立即 FAIL，不进入阶段。
- **统一协议**：两阶段结果只使用大写 `PASS / FAIL / BLOCKED`，阶段标识为字符串 `"1"` / `"2"`；Python 判定库与 Dart 写入共用同一契约常量（检查项名、清理项名、`blockedCause`）。小写 verdict（第 8 轮历史值 `blocked` 即此类）不再被接受。
- **独立文件与显式路径**：阶段 1 只写 `phase1.json`；阶段 2 显式设置 `T1C_PHASE1_FILE`（输入）与 `T1C_RESULT_FILE`（输出，`phase2.json`），执行器在启动阶段 2 前断言两者不同，并在阶段 2 前后比对 `phase1.json` 的 SHA-256：被改写/删除立即 FAIL（测试中「第二阶段覆盖第一阶段文件」即走此路径）。
- **运行隔离**：每轮日志、参数与报告归入唯一 `runId` 目录（权限 0700），沙盒结果目录沿用同一 `runId`；仓库级 `flock` 排他锁阻止并发构建同一 macOS 示例；参数文件权限 `0600`、结束后删除；历史证据不被下一轮覆盖（同一命令两轮复跑的旧报告逐字未变）。
- **子进程**：全部参数数组 + 显式 `shell=False`；本轮动态路径经字符集白名单与**目录边界检查**后，作为单独参数传入 `--dart-define-from-file=<本轮参数文件>`，不做命令行字符串拼接。

### 2. 严格判定结果与清理

判定收敛到纯函数 `e2e/t1c_executor_lib.py`（无 IO、可单测）：

| 输入或场景 | 判定 |
|---|---|
| 结果文件缺失 / 不可解析 / 不是 JSON 对象 | FAIL |
| `runId` / `phase` / `identity.appId` / `identity.username` 与预期不符 | FAIL（不读取其他测试身份） |
| verdict 小写或未知 | FAIL（契约只允许大写） |
| PASS 但进程退出码 ≠ 0 | FAIL |
| 必需检查项缺失或未通过（阶段 1：`probe`/`tokenPersisted`/`loginSubmit`；阶段 2：`phase1Record`/`probe`/`tokenRestored`/`identityRestored`/`restoreSubmit`/`cleanup`） | FAIL |
| 阶段 2 缺 `tokenCleared` / `probeCleared`、类型不对或非 `true` | FAIL |
| **任何非空 `cleanupError`**（含可识别 -34018 的情形） | FAIL（主错误与清理错误都保留） |
| 阶段 1 未显式给出令牌去向证据（`cleanup.tokenCleared` 缺失/类型错） | FAIL（无法证明就不能推断） |
| BLOCKED 但 `blockedCause` 不在白名单（未知错误） | FAIL |
| BLOCKED 但未证明无残留（`tokenCleared` 非 true）或探针未清理 | FAIL |
| 可识别的 `-34018` + 清理完成 | BLOCKED / 退出码 2 |
| `-34018` + 清理失败 | FAIL / 退出码 1（两个原因都保留） |
| 写入阶段成功、恢复阶段读不到令牌 | FAIL「重启后凭据丢失」 |
| 清理失败 / 阶段未全执行 / 用量核对不为两次 | FAIL（清理失败不得被 PASS 或 BLOCKED 掩盖） |

退出码固定 **0 = PASS，1 = FAIL，2 = BLOCKED**。恢复阶段先检查第一阶段记录与身份（`runId`、`phase="1"`、`verdict=="PASS"`、`identity` 完全一致），记录无效立即 FAIL 且**不读取存储**。

### 3. 进程与失败路径统一收尾

- **移除按路径片段执行的 `pgrep/pkill`**。只管理本轮自己启动的进程：子进程以独立进程组启动并记录 `pgid`；应用进程 PID 来自本轮**结构化握手文件**（`phase1-handshake.json` / `phase2-handshake.json`，由集成测试写入 `pid`），执行器核验 runId/phase、所属用户（`uid`）、可执行路径（必须位于本轮 `examples/flutter/build/macos` 之下，按"前缀 + 分隔符"比较以兼容含空格的仓库路径）与启动时间（不得早于本阶段开始）之后，才允许管理该进程。
- 第一阶段结束后等待并确认应用退出，最多 15 秒；未退出则只终止**已核实**的本轮进程（SIGTERM → 5s → SIGKILL）并再次确认；**无法证明退出时判 FAIL，且不启动阶段 2**（测试覆盖：握手缺失、身份无法核实、核实后正常终止三种路径；身份不可核实的进程一律不杀）。
- 阶段总超时沿用 900 秒；超时先终止本轮进程组，15 秒后仍存活才 SIGKILL 本轮剩余进程。**预先存在的示例应用进程不被触碰**（测试用常驻"既有示例进程"验证其不被终止且仍存活）。
- 从创建第一项资源起进入 `try/finally`：构建失败、阶段失败、阶段超时、崩溃、用户中断（KeyboardInterrupt）都走同一收尾；Dart 阶段使用 `finally`——成功的第一阶段保留令牌供恢复（`cleanup.tokenCleared=false`），第一阶段失败或第二阶段结束时尝试清理本轮令牌与探针键。
- 阶段崩溃无法自行清理时，执行器调用**受本轮身份约束的兜底清理入口**（新增第 3 个集成测试 `t1c_secure_storage_cleanup_test.dart`，只删本轮令牌键与探针键）；清理无法完成则报告**残留键身份**（由 apiBase + appId 复现 `feedbackTokenStorageKey`）与实际错误，**不记录令牌值**。
- 收尾顺序：必要时兜底清理 → 禁用本轮账号并核验禁用结果 → 停止专用服务并确认 → 删除参数文件；**保留隔离数据库与报告供审查**，不删除反馈历史。所有失败出口都写入结构化最终报告（`report.json` + 追加 `history.jsonl`）。
- **本轮实测发现并修复的执行器缺陷**：`stop()` 原先用 `os.kill(pid, 0)` 判断服务是否退出，而**已退出但未回收的僵尸子进程对 `kill(pid,0)` 仍然"存活"**，导致服务已停止却被判「服务停止=False」，整轮被误判为 FAIL。修复为按 `Popen.poll()` 回收后确认退出（`SystemProcs.poll`），并补了使用**真实子进程**的回归测试。

### 4. 机制测试（先补完整执行路径测试，再修复）

`e2e/test_t1c_executor.py` → ✅ **64/64 通过**（纯判定 40 例 + 执行器全路径 20 例 + 进程/边界 4 例）。执行器全路径测试**直接调用 `Executor.run()`**，只替换进程启动、服务通信与专用服务生命周期（FakeProcs / InMemoryApi / FakeService）；模拟阶段**读取执行器实际生成的 `--dart-define-from-file` 参数文件**，并向参数里写明的 `T1C_RESULT_FILE` / `T1C_HANDSHAKE_FILE` 写结果，不替执行器修正路径或状态；管理接口模拟真实服务端行为（**应用未登记即登录 → 404 unknown_app**）。测试全程不写真实用户主目录 / Keychain，也不连真实 8787。

| 必测场景 | 落点 | 实测 |
|---|---|---|
| 应用未登记即登录 | 注入"跳过登记"的执行器 → 阶段内登录 404 | ✅ FAIL，证明登记步骤不可省略 |
| 登记接口"成功"但未落库 | 回查不一致 | ✅ 立即 FAIL，不进入阶段 |
| 正常两阶段 | 输入输出路径正确、状态统一、用量 2、清理完成 | ✅ PASS / 退出码 0 |
| 第二阶段覆盖第一阶段文件 | 阶段 2 改写 phase1.json | ✅ FAIL（证据完整性） |
| 阶段或身份不匹配、缺清理字段 | phase/identity/cleanup 三种注入 | ✅ 均 FAIL |
| `-34018` 且清理成功 | blocked + `tokenCleared/probeCleared=true` | ✅ BLOCKED / 2 |
| `-34018` 同时清理失败 | blocked + 非空 `cleanupError` | ✅ FAIL / 1，主错误与清理错误都在原因里 |
| 写入阶段成功、恢复后无令牌 | 令牌键被清空后进入阶段 2 | ✅ FAIL「重启后凭据丢失」 |
| 构建失败 / 阶段超时 / 阶段崩溃 | 统一收尾 | ✅ 均执行收尾（账号禁用、服务停止、参数删除），崩溃时调用兜底清理入口 |
| 兜底清理本身失败 | 清理入口返回 FAIL | ✅ 报告残留键身份与实际错误，不记录令牌值 |
| 账号禁用失败 | 禁用接口 500 | ✅ FAIL（清理失败不被掩盖） |
| 同时存在其他示例进程 | 常驻"既有示例进程" | ✅ 不被终止且仍存活 |
| 第一阶段进程退出无法确认 | 不写握手记录 | ✅ FAIL 且不运行第二阶段 |
| 应用存活但身份无法核实 | uid 不符 | ✅ 不杀进程、不进入阶段 2 |
| 应用存活且身份已核实 | 握手 PID + 正确身份 | ✅ 仅终止该轮进程后进入阶段 2 |
| 两轮执行 | 同一入口跑两轮 | ✅ 证据不覆盖，history 追加为两行 |
| 并发运行 | 外部持有仓库级锁 | ✅ 被锁拒绝（FAIL，未启动服务与阶段） |

Dart 侧（`examples/flutter/test/t1c_probe_classification_test.dart`，20 例）：探针分类全分支 + 「清理失败一律 FAIL，`-34018` 也不豁免」+ 大写线上协议（`toJson` 输出 `PASS/FAIL/BLOCKED` 与 `blockedCause`）+ `phase1RecordValid` 身份/阶段/verdict 校验 + 恢复前置「重启后凭据丢失」。

### 5. 真实验收运行（实际结论）

命令：`python3 e2e/run_t1c_default_storage.py`（**不再需要 `source .env`**）。

| 轮次 | runId | 结论 | 退出码 | 说明 |
|---|---|---|---|---|
| 第 9 轮首次复跑 | `20260913-170708-682518` | FAIL | 1 | 执行器自身收尾缺陷：服务停止无法确认（僵尸子进程）→ 已定位并修复 |
| 第 9 轮修复后复跑 | `20260913-170959-3bf10d` | **BLOCKED** | **2** | 真实签名阻塞 + 清理已确认完成 |
| 最终代码树复跑 | `20260913-171407-0ff16e` | **BLOCKED** | **2** | 与上一轮一致（专用服务 51947、清理四项全部确认、无残留进程） |

修复后本轮实测（细节取自**最终代码树**复跑 `runId=20260913-171407-0ff16e`；`20260913-170959-3bf10d` 结论完全相同，仅端口/pid 不同）：

- 专用服务 `127.0.0.1:51947`（数据目录 `e2e/t1c-runs/20260913-171407-0ff16e/service-data`），本轮随机管理员；应用 `t1c-20260913-171407-0ff16e` 与本轮账号均已登记/创建并回查一致。
- 构建 `flutter build macos --debug` 成功；签名留档 `0 valid identities found`、`Identifier=dev.example.feedbackExample`、`TeamIdentifier=not set`。
- 阶段 1：探针写默认 Data Protection Keychain 返回 `PlatformException(Code: -34018, A required entitlement is not present.)` → **BLOCKED**（唯一允许的阻塞分类，`blockedCause=missing-entitlement`）。清理证据齐全：`cleanup.tokenCleared=true`（`tokenClearedBy=never-written`）、`cleanup.probeCleared=true`（`probeClearedBy=write-never-succeeded+read-null`），无 `cleanupError`——即"本轮从未写出令牌且再次读取确认为空"，属可证明而非推断。
- 应用进程经本轮结构化握手记录 PID（`20260913-170959-3bf10d` 为 `pid=61302`；`20260913-171407-0ff16e` 为 `pid=63846`），核验后**已自然退出**（未触发任何终止动作）；阶段 2 按规则未执行。
- 收尾：账号禁用并回查确认（`accountDisabled=true` / `accountDisableVerified=true`）、专用服务停止并确认（`serviceStopped=true`）、参数文件删除（`paramsRemoved=true`）、兜底清理标记 `NOT_NEEDED`（令牌键已确认清空）。退出码 **2**；复跑后复查无遗留服务进程。

产物：`e2e/t1c-runs/20260913-171407-0ff16e/report.json` 与 `e2e/t1c-runs/20260913-170959-3bf10d/report.json`（各含 `build.log` / `phase1.log` / `service.log` / 隔离数据库）、沙盒容器内 `.../t1c/<runId>/phase1.json` 与 `phase1-handshake.json`、`e2e/t1c-runs/history.jsonl`（追加式，历史行未被改写）。

> 说明：模拟执行器全路径通过，只证明**工具衔接正确**，不证明 Keychain 验收成功。本机仍缺有效签名身份，默认存储真实验收（写入 → 真实重启 → 恢复会话 → 两次提交）仍未完成。

### 6. 同步更正最新历史记录（保留原始产物，不改写原始执行结果）

- 对象：第 8 轮最新一次真实运行 `runId=20260913-160501-06d38a`。
- 原始产物**原样保留**：`e2e/t1c-runs/current/report.json`（`verdict=BLOCKED`，mtime 未变）、`e2e/t1c-runs/history.jsonl` 第 4 行、容器内 `.../20260913-160501-06d38a/phase1.json`。本轮只向其所在目录**追加**审查说明文件 `e2e/t1c-runs/current/REVIEW-round8-cleanupError.md`（同一内容另存一份可入库副本 `e2e/REPORT-t1c-round8-cleanupError-review.md`），并把结论登记在本节。
- **该轮含非空 `cleanupError`，按既定规则应归为 FAIL（退出码 1），不是 BLOCKED**：
  - `phase1.json` 的 `cleanupError` 为 `PlatformException(Unexpected security result code, Code: -34018, Message: A required entitlement is not present., -34018, null)`，`cleanup` 为空对象 `{}`（`probeCleared` 证据缺失）——清理并未完成，清理失败不得被 BLOCKED 掩盖；
  - 该轮 `verdict` 写作小写 `"blocked"`，不符合大写契约；
  - 该轮没有给出"本轮从未写出令牌、无残留"的证明，因此也不能按"可证明无残留"记录清理完成（无法证明不能推断）。
- **附签名阻塞原因（照旧成立，未被更正否定）**：`security find-identity -v -p codesigning` = `0 valid identities found`；构建产物 ad-hoc 签名（`TeamIdentifier=not set`）；运行时默认 Keychain 写入返回 `-34018 / errSecMissingEntitlement`。本机无法完成默认存储验收的根因确为缺少有效签名身份 + Keychain Sharing。

### 7. 门禁（本轮实际运行）

| 命令 | 结果 |
|---|---|
| `python3 -m unittest e2e.test_t1c_executor` | ✅ **64/64** |
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **106/106** |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter test`（`examples/flutter`） | ✅ **24/24**（分类器 20 + 示例 4） |
| `python3 e2e/run_t1c_default_storage.py` | ✅ 按实测 **BLOCKED（exit 2）**，清理已确认完成 |

未修改 Web / 服务端业务代码，按任务要求不重复其全套门禁（第 7 轮记录仍有效）。

### 8. 未验证 / BLOCKED（如实标注，不得读作已通过）

- **默认 macOS Data Protection Keychain 的写入 / 重启恢复 / 两次提交仍未验证（T1-C 核心）**。阻塞经**两条不同依据**确认后停止盲试：① `security find-identity -v -p codesigning` = 0 个有效身份 + 构建产物 ad-hoc 签名；② 运行时探针实测 `-34018 / errSecMissingEntitlement`。具备条件后：为示例配置匹配的 Team、签名与 Keychain Sharing，核对两个阶段实际应用的签名身份与 entitlements（执行器已自动留档 `codesign -dv`），再运行同一命令；两阶段真实通过（退出码 0）才把 T1 标「待体验」。
- 出现非 `-34018` 的存储错误将按 FAIL 结束，不会伪装成阻塞；清理未完成同样 FAIL。
- Android / iOS、真实 Kaneo / AI、发布与生产迁移：沿用第 6/7 轮记录，仍未验证。
- 第 8 轮遗留：无（测试账号已禁用、探针键已清、令牌从未写出）；第 9 轮各轮次运行的测试账号均已禁用并核验，隔离数据库与报告保留供审查。

### 9. 体验入口（T1 = 实现中：默认 macOS 存储验证阻塞）

1. **Web**：`pnpm dev` 后打开任一接入 `feedback-widget` 的宿主页。独立可体验。
2. **Flutter Web**：`flutter build web` 后静态服务 `build/web`（允许来源登记 `http://localhost:5300`）。独立可体验。
3. **macOS 原生**：⚠️ 在默认存储验收通过前，此入口的**存储失败会阻断登录续交**（登录成功但令牌无法持久化时提示「无法保存登录状态，请检查应用的安全存储配置」，保留草稿、不自动提交、不进入已登录态）；功能验收以第 7 轮 §3.3 的内存流程集成测试为流程证据，不证明 Keychain 与重启恢复。

---

## 第 10 轮（T1-C 最终收尾：接收验收、中断清理与 macOS 启动签名修复，2026-09-13）

日期：2026-09-13 · 环境：macOS 27.0 (26A428) / Flutter 3.41.3 / flutter_secure_storage 9.2.4（macOS 实现 3.1.3）。范围限定 T1-C1（按真实接收结果验收）、T1-C2（中断收尾顺序）、T1-C3（两阶段签名证据）、T1-C4（启动签名失败处理）与既有执行器／测试／本文件的延续；未改 Web 与服务端业务代码，未发布，未操作生产数据；开始前已核对 `git status --short --branch` 并保留既有未提交改动。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（启动已验证：当前产物真实启动并写出本轮握手；默认存储写入／重启恢复仍被缺少签名身份阻塞）。

### 1. T1-C1：按真实接收结果验证两阶段提交

**判据变更**：删除两处等待 `feedback-continue`（已归档界面）的逻辑。隔离服务不配置 AI / Kaneo，后台归档失败**不否定反馈已接收**；提交成功的唯一判据是服务端接收。

- **真实 HTTP 转发观察器**（`t1c_secure_storage_common.dart` 的 `AcceptanceObserver`）：经组件**已有** `httpClient` 注入点接入 `FeedbackWidget`；底层是正常 `http.Client`，请求原样转发、**不伪造响应、不主动提交、不替组件重试、不注入 tokenStore**。读取响应流后以**相同状态、头与字节**重建 `StreamedResponse` 交还组件；只记录反馈 POST 的 `httpStatus` / `feedbackId` / `replayed`，不记录凭据、请求头或正文（`t1c_acceptance_observer_test.dart` 逐条断言）。
- **接收判定**：每阶段最多等待 30 秒，要求**恰好一次** `POST /api/feedback` 返回 **201**、**非空 `feedbackId`**、**非重放**；拒绝、重放、超时、缺 ID、多次提交一律 FAIL（`classifyAcceptance`）。重放判定优先于状态码（服务端对幂等重放返回 `200 replayed:true`，不能误报成普通"未接收"）。
- **阶段结果新增 `acceptance: {httpStatus, feedbackId, replayed}`**，并有同名必需检查项 `acceptance`（阶段 1：`probe`/`tokenPersisted`/`acceptance`；阶段 2：`phase1Record`/`probe`/`tokenRestored`/`identityRestored`/`acceptance`/`cleanup`）。判定库对 `acceptance` 做**结构校验**，即使阶段自称 PASS 也照样 FAIL。
- **执行器核对**：阶段 1 之后即经现有管理接口核对本轮反馈 **1 条**、用量 **1**，通过后才启动阶段 2；最终核对**两个不同 feedbackId**、归属为本轮账号、用量 **2**。管理查询非 200、条数不符、归属错误、ID 重复或阶段报告的 ID 未出现在服务端列表，一律失败（`verify_receipts`）。
- **阶段 1 仍保留**：面板登录、默认安全存储写入、跨实例读取；**阶段 2 禁止输入凭据**，恢复账号必须属于本轮。

**真实隔离服务接收契约检查**（新增 `e2e/t1c_receipt_contract_check.py`，不替代 Keychain 验收）：

```
python3 e2e/t1c_receipt_contract_check.py
runId=20260913-210731-receipt-d5b50f → ✅ PASS（退出码 0）
```
真实隔离服务（`127.0.0.1:61350` + 独立数据目录 + 随机管理员）：客户端令牌登录 → 两次提交均 `201` + 非空 `feedbackId` + 非重放（ID `a61b28e5-…` / `06a06e2e-…`）→ 同一 `idempotencyKey` 重放返回 `200 replayed:true` 且**未计入用量** → 管理接口核对 2 条、归属正确、两个 ID 不同、用量 2 → 账号禁用并核验、隔离服务停止。证据：`e2e/t1c-runs/20260913-210731-receipt-d5b50f/receipt-contract.json`。

### 2. T1-C2：中断收尾先停止写入来源，再清理存储

- **凭据状态前置登记**：阶段 1 **启动之前**就把令牌键状态登记为 `"maybe"`（`cleanup.tokenStateAtPhase1Start="maybe"`）。此后结果缺失、等待异常或用户中断都**不能**被解释为"阶段未执行"。
- **进程登记先于等待**：`_spawn_wait` 在 `spawn` 之后、`wait` 之前登记句柄，并**随创建即时落盘** `resources.json`（`{"runId","resources","processes"}`），收尾期间再次中断也不会丢失清单。保留本轮进程组记录与应用握手 PID 的用户／可执行路径／启动时间核验，不使用路径模糊匹配批量杀进程。
- **固定收尾顺序**（`cleanup.cleanupSteps` 逐项留痕）：
  1. 确认本轮构建／测试进程与已核实应用进程**退出**（`confirm-writer-stopped`）；
  2. 兜底清理凭据（`fallback-credential-cleanup`）；
  3. 禁用并核验账号（`disable-account`）；
  4. 停止专用服务（`stop-service`）；
  5. 删除敏感参数（`remove-params`）。
- **停止语义**：SIGTERM 后等待最多 **15 秒**，仍存活才对本轮进程组／已核实 PID 强制 SIGKILL 并**复查**；身份无法核实的应用进程一律不杀，而是记录"写入来源未确认停止"。
- **每项独立容错**：每一步单独捕获错误（含 `KeyboardInterrupt`），前一步失败不阻止后续步骤；**收尾期间再次中断不重启任何测试**。
- **清理确认**：`cleanup.credentialCleanupConfirmed` 只有在写入来源已确认停止、且令牌键已被阶段自己证明清空或兜底清理确认清空时才为 `true`；写入来源未确认停止时**不报告凭据清理完成**，整体一律 FAIL。主错误与清理错误同时保留（`_append_cleanup_note` 附残留键身份，**不记录令牌值**）。

实测（`runId=20260913-210759-701330`）：`writerStopped=true`、`credentialCleanupConfirmed=true`、四步收尾全部 `ok`。

### 3. T1-C3：两个实际测试产物分别留证

- **握手新增实际可执行路径**：`writeHandshake` 写入 `pid` 与 `exePath`（`Platform.resolvedExecutable`）。执行器校验该路径属于本轮构建产物目录后定位 `.app`（`artifact_from_executable`），并拒绝构建产物目录之外的路径。
- **每阶段实际产物生成后立即采集**（在下一阶段重新构建之前）：`codesign --verify --deep --strict --verbose=2`、`codesign -dv --verbose=4`、`codesign -d --entitlements :-`，全部使用**参数数组 + `shell=False`**；另采集二进制 UUID（`dwarfdump --uuid`）与**签名内容摘要**（`codesign -dv` 输出的 SHA-256）。保存命令退出码、时间、路径、阶段、UUID 与摘要，落盘 `signature-<phase>.json`，报告里放摘要。
- **两阶段对比**（`compare_signature_evidence`）：比对应用标识、签名身份／Team、签名类型、**Keychain 相关授权**与 entitlements 键集合；**不要求**两个测试入口的二进制哈希／CDHash／UUID 相同。证据缺失、静态验证失败或关键配置不一致**均不能 PASS**（`_signature_gate` 仅在整体本可 PASS 时生效）。
- **未执行第二阶段时明确记录未采集**，不用初始构建冒充：本轮报告 `signature["2"] = {collected:false, reason:"阶段 2 未执行，未采集签名证据（不用初始构建冒充）"}`。

本轮实测（`runId=20260913-210759-701330`）：

| 证据 | 采集时刻 | Identifier | Team | 类型 | 静态验证 | 二进制 UUID | 签名摘要（前 12 位） |
|---|---|---|---|---|---|---|---|
| baseline | 构建后（21:08:14） | dev.example.feedbackExample | not set | adhoc | exit 0 | D0D27D81-…-4CC6 | 47ddabb74ce7 |
| 阶段 1 | 阶段 1 结束后（21:08:32） | dev.example.feedbackExample | not set | adhoc | exit 0 | D0D27D81-…-4CC6 | ba00fa95d99f |
| 阶段 2 | 未执行 → 未采集 | — | — | — | — | — | — |

> 该表本身就是"**UUID 相同不等于签名状态相同**"的实证：两次采集的 LC_UUID 完全相同，签名内容摘要却不同。

### 4. T1-C4：macOS 启动签名失败处理

**1) 建立当前基线（保留用户原始报告）**

用户提供的报告已登记为 `e2e/t1c-launch-baseline.json`（原始文件保留在 `~/.Trash/DiagnosticReports/feedback_example-2026-09-13-015858.ips`，SHA-256 `ba2b3c21534137921c94ff029507f2c80209adf4deb6b6823ee147bb7cd98f89`，**未复制、未改写**）：

| 字段 | 值 |
|---|---|
| 事件 ID | `A8E76EAA-A356-4BA4-AF6C-4EAAC1C56724` |
| 时间 | `2026-09-13 01:58:58.00 +0800`（procLaunch 58.6128 → captureTime 58.6757，约 63 ms） |
| 进程 / PID | `feedback_example` / `33996` |
| Bundle | `dev.example.feedbackExample` |
| slice UUID | `d0d27d81-5cae-3644-bac8-cc455a1d4cc6` |
| 终止 | `namespace=CODESIGNING, indicator=Taskgated Invalid Signature, code=1, flags=66` |
| 信号 | `SIGKILL (Code Signature Invalid)` |
| 签名信息 | `codeSigningID=""`、`codeSigningTeamID=""`、`codeSigningFlags=16777216`、`codeSigningValidationCategory=0` |
| 系统 | `macOS 27.0 (26A428)` |

**2) 当前待测产物的静态签名证据**（构建后立即采集，先于任何阶段）：`codesign --verify --deep --strict --verbose=2` → `valid on disk` / `satisfies its Designated Requirement`（exit 0）；`-dv` → `Identifier=dev.example.feedbackExample`、`Signature=adhoc`、`TeamIdentifier=not set`、`Sealed Resources version=2 rules=13 files=10`；entitlements → `app-sandbox` / `cs.allow-jit` / `get-task-allow` / `network.client` / `network.server`（**无 `keychain-access-groups`**，与默认 Keychain `-34018` 一致）。**未据此断言当时签名状态**。

**3) 受控启动与准确分类**

执行器通过受控阶段启动记录实际 PID、启动时间、退出码与结构化握手，并用纯函数 `classify_launch` 分类（只接受与本轮 PID 或本阶段时间窗 + 本轮产物路径匹配的证据；历史报告一律记入 `ignored`）：

- 有匹配本轮 PID／时间窗与产物的 `Taskgated Invalid Signature` → `launch_signature_invalid`，整体 FAIL；
- 应用启动并产生握手后 Keychain 探针返回可识别 `-34018` → 沿用既有阻塞规则（清理完成后才 BLOCKED）；
- 无握手且无匹配签名拒绝证据 → 记录实际启动失败／超时（`launch_failed`），**不猜测成签名问题**；
- 日志采集只覆盖本轮进程与本阶段启动窗口，历史崩溃报告不能拿来证明当前失败。

**4) 实测结论：旧事件本轮未复现**

本轮 `runId=20260913-210759-701330` 的启动分类为 **`verified`**——应用正常启动并在 **21:08:32** 写出本轮结构化握手（`pid=22282`、`exePath` 指向本轮 `feedback_example.app/Contents/MacOS/feedback_example`），随后 Keychain 探针返回 `-34018`。即：

- **启动已验证**：当前构建产物真实启动并进入应用内测试（不是静态检查的推断）；
- **Keychain 仍阻塞**：默认 Data Protection Keychain 写入返回 `-34018`（缺少 `keychain-access-groups` 授权）；

二者分别记录，**不合并为整体通过**。按计划第 3 条"若当前产物能启动且获得握手：记录'旧事件本轮未复现'，不进行无依据的重签名或权限改动；保留启动门禁防止再次遗漏"执行：**未做任何重签名、未改 entitlements、未改构建配置**。

**5) 禁止的替代处理（本轮均未使用）**：未关闭 SIP / Gatekeeper / 系统签名校验（系统 `sip` 状态由用户环境决定，未触碰）；未批量移除 quarantine；未使用 `codesign --deep --force` 反复重签；未回退内存／明文存储。静态校验通过**没有**被当作真实启动成功的替代证据——启动结论来自真实进程与握手。

**6) 已有的流程级修复（针对"构建后修改产物／并发构建"这一最可能成因）**：第 9 轮加入的**仓库级排他锁**（`e2e/t1c-runs/.t1c-exclusive.lock`）阻止对同一 macOS 示例的并发构建／验收，本轮继续生效（并发运行被拒并写入 `*-early-failure.json`）；签名证据在**每阶段实际产物生成后、下一阶段重新构建前**采集，避免用后一次构建冒充前一阶段的产物状态。

### 5. 回归测试与红检（先补测试，再用旁路证明测试有效）

`python3 -m unittest e2e.test_t1c_executor` → ✅ **117/117**（纯判定 68 + 执行器全路径 29 + 中断 8 + 启动签名 5 + 签名门禁 5 + 服务边界 2）。

| 必测场景 | 预期 | 实测 |
|---|---|---|
| 应用未登记即登录 | 测试失败，证明登记步骤不可省略 | ✅ FAIL（unknown_app），不进入阶段 2 |
| 登记接口"成功"但未落库 | 回查不一致立即失败 | ✅ FAIL，未进入阶段 |
| 正常两阶段 | 输入输出路径正确、状态统一、用量 2、清理完成 | ✅ PASS / 退出码 0 |
| **提交被拒绝（阶段自称 PASS）** | FAIL | ✅ FAIL（httpStatus） |
| **幂等重放** | FAIL | ✅ FAIL（replayed） |
| **缺 feedbackId** | FAIL | ✅ FAIL |
| **错误归属** | FAIL | ✅ FAIL（归属） |
| **两阶段重复 ID** | FAIL | ✅ FAIL（接收核对） |
| 管理查询非 200 / 用量不符 | FAIL | ✅ FAIL |
| 第二阶段覆盖第一阶段文件 | FAIL | ✅ FAIL（证据完整性） |
| 阶段或身份不匹配、缺清理字段 | FAIL | ✅ FAIL |
| `-34018` 且清理成功 | BLOCKED / 2 | ✅ BLOCKED |
| `-34018` 同时清理失败 | FAIL / 1，保留两个原因 | ✅ FAIL |
| 写入阶段成功、恢复后无令牌 | FAIL「重启后凭据丢失」 | ✅ FAIL |
| 构建失败 / 阶段超时 / 崩溃 | 收尾执行，残留如实记录 | ✅ 均收尾；崩溃调用兜底清理 |
| **中断注入（构建 / 第一阶段无结果 / 恢复阶段）** | 进程停止**先于**凭据清理；账号与服务继续收尾 | ✅ 顺序与步骤均符合 |
| **写入来源无法确认停止** | 不报告凭据清理完成、整体 FAIL | ✅ `credentialCleanupConfirmed=false` |
| 无关进程（其他示例进程） | 不被终止 | ✅ 存活 |
| 第一阶段进程退出无法确认 | 不运行第二阶段 | ✅ FAIL 且未执行阶段 2 |
| 两轮执行 / 并发运行 | 证据不覆盖 / 被锁拒绝 | ✅ 旧报告逐字未变 / 拒绝 |
| **匹配本轮证据的签名拒绝** | `launch_signature_invalid` → FAIL | ✅ FAIL |
| **旧报告（窗口外）** | 不套用 | ✅ `launch_failed`，不进签名分类 |
| **静态通过但启动被拒** | 仍 FAIL | ✅ FAIL（静态 exit 0 但启动被拒） |
| **无证据的启动超时** | 不冒充签名阻塞 | ✅ `launch_failed` |
| 启动失败也执行 T1-C2 收尾 | 收尾执行 | ✅ 首步即 `confirm-writer-stopped` |
| **签名证据缺失 / 静态验证失败 / 配置不一致** | 不能 PASS | ✅ 三种均 FAIL（阶段仍 PASS，由门禁拦下） |
| 未执行第二阶段 | 明确记录未采集，不用初始构建冒充 | ✅ `collected:false` |

**红检**（把每处修复旁路后，确认对应回归测试确实失败，7/7 全部变红）：接收证据门禁、服务端接收核对、收尾先停止写入来源、写入来源未确认不得报告清理完成、两阶段签名证据门禁、启动签名失败分类、应用登记不可省略。

### 6. 门禁（本轮实际运行）

| 命令 | 结果 |
|---|---|
| `python3 -m unittest e2e.test_t1c_executor` | ✅ **117/117** |
| `flutter analyze`（`flutter/feedback`） | ✅ No issues found |
| `flutter test`（`flutter/feedback`） | ✅ **106/106** |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter test`（`examples/flutter`） | ✅ **36/36**（接收观察器/判定 12 + 分类器 20 + 示例 4） |
| `python3 e2e/t1c_receipt_contract_check.py` | ✅ **PASS**（真实隔离服务接收契约，runId `20260913-210731-receipt-d5b50f`） |
| `python3 e2e/run_t1c_default_storage.py` | ✅ 按实测 **BLOCKED（exit 2）**：启动已验证、清理四项全部确认 |

未修改 Web / 服务端业务代码，按任务要求不重复其全套门禁（第 7 轮记录仍有效）。

### 7. 真实验收运行（实际结论）

命令：`python3 e2e/run_t1c_default_storage.py`

| runId | 结论 | 退出码 | 关键实测 |
|---|---|---|---|
| `20260913-210759-701330` | **BLOCKED** | **2** | 隔离服务 `127.0.0.1:61605`；构建成功；**启动分类 `verified`（pid=22282 写出本轮握手）**；基线签名证据齐全且静态验证通过；阶段 1 探针 `-34018` → BLOCKED；阶段 1 签名证据已在阶段 2 之前采集；阶段 2 未执行（签名证据记未采集）；收尾四步全 `ok`、`writerStopped=true`、`credentialCleanupConfirmed=true` |
| `20260913-211230-4d0697`（**最终代码树复跑**） | **BLOCKED** | **2** | 隔离服务 `127.0.0.1:64312`；**启动分类 `verified`（pid=24147 写出本轮握手）**；基线与阶段 1 签名证据齐全、静态验证 exit 0；阶段 1 探针 `-34018` → BLOCKED；阶段 2 未执行（签名证据记未采集）；收尾四步全 `ok`、`writerStopped=true`、`credentialCleanupConfirmed=true`；复跑后无遗留进程 |

产物：`e2e/t1c-runs/20260913-211230-4d0697/` 与 `e2e/t1c-runs/20260913-210759-701330/`（各含 `report.json`、`signature-baseline.json`、`signature-1.json`、`resources.json`、`build.log`、`phase1.log`、`service.log`、隔离数据库）、沙盒容器内 `.../t1c/20260913-210759-701330/phase1.json` 与 `phase1-handshake.json`、`e2e/t1c-runs/history.jsonl`（追加式，历史行未改写）。

> 说明：模拟执行器全路径与真实隔离服务接收契约通过，只证明**工具衔接与接收判据正确**，不证明 Keychain 验收成功。默认存储真实验收（写入 → 真实重启 → 恢复会话 → 两次接收）仍因缺少有效签名身份未完成。

### 8. 未验证 / BLOCKED（如实标注，不得读作已通过）

- **默认 macOS Data Protection Keychain 的写入 / 重启恢复 / 两次接收仍未验证（T1-C 核心）**。阻塞经两条不同依据确认：① `security find-identity -v -p codesigning` = 0 个有效身份 + 产物 ad-hoc 签名；② 运行时探针实测 `-34018 / errSecMissingEntitlement`（entitlements 中确无 `keychain-access-groups`）。因此本轮真实运行的阶段 1 在提交前即阻塞，`acceptance` 证据在真实两阶段中**尚未产生**（接收契约由 §1 的隔离服务检查单独证明）。
- **启动签名**：本轮结论是"旧事件未复现 + 启动已验证"，**不是**"历史 `Taskgated Invalid Signature` 的根因已被定位并修复"。若今后再次出现启动被拒，`launch_signature_invalid` 分类与启动门禁会把它与 Keychain 阻塞、普通超时区分开并判 FAIL。
- 具备签名身份后：为示例配置匹配的 Team、签名与 Keychain Sharing，核对两阶段实际应用的签名身份与 entitlements（执行器已自动留档），再运行同一命令；两阶段真实通过（退出码 0）才把 T1 标「待体验」。
- Android / iOS、真实 Kaneo / AI、发布与生产迁移：沿用第 6/7 轮记录，仍未验证。
- 本轮遗留：无（各轮测试账号均已禁用并核验、探针键已清、隔离数据库与报告保留供审查；未产生 Keychain 写入）。

### 9. 体验入口（T1 = 实现中：默认 macOS 存储验证阻塞）

1. **Web**：`pnpm dev` 后打开任一接入 `feedback-widget` 的宿主页。独立可体验。
2. **Flutter Web**：`flutter build web` 后静态服务 `build/web`（允许来源登记 `http://localhost:5300`）。独立可体验。
3. **macOS 原生**：⚠️ 在默认存储验收通过前，此入口的**存储失败会阻断登录续交**（登录成功但令牌无法持久化时提示「无法保存登录状态，请检查应用的安全存储配置」，保留草稿、不自动提交、不进入已登录态）；功能验收以第 7 轮 §3.3 的内存流程集成测试为流程证据，不证明 Keychain 与重启恢复。

---

## 第 11 轮（T1 最终补修：关闭验收误放行，再完成默认存储验证，2026-09-13）

日期：2026-09-13 · 环境：macOS 27.0 (26A428) / Flutter 3.41.3 / flutter_secure_storage 9.2.4（macOS 实现 3.1.3）。范围限定 T1-C2（停止状态无法确认时禁止通过）与 T1-C3（比较真实授权配置、严格检查采集结果）的工具修复，以及既有统一入口的真实复跑；未修改业务计次规则与公开 API，未发布，未操作生产数据。开始前已核对 `git status --short --branch` 并保留全部已有改动。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（工具门禁已按本轮要求收紧并通过；真实两阶段仍被缺少有效签名身份阻塞）。

### 1. T1-C2：停止状态无法确认时，禁止通过

**修复**（`e2e/run_t1c_default_storage.py`）：

- `writer_ok is not False` → **严格成功判定**：只有 `_confirm_writer_stopped()` 显式返回 `True` 才算写入来源已停止；抛异常、返回 `None`、返回 `False` 一律记 `writerStopped=false`，并把**原始错误**（`OSError:` / `KeyboardInterrupt:` / `步骤未返回明确结果（None）`）写进 `writerStopDetail` 与 `cleanupSteps[].error`，可在报告中定位。
- 停止状态无法确认时**不启动兜底凭据清理进程**（避免与尚存活的写入进程竞争），记录清理未完成与**本轮残留键名**（只记键名，不记令牌值）；清理步骤条目 `ok=false` 并附原因。
- 后续禁用账号、停止专用服务、删除敏感参数仍**独立执行**；`step()` 改为"只有显式返回 `True` 才算成功"，`_disable_account()` / `_run_dart_cleanup()` 改为返回显式布尔。
- `_cleanup_ok()` 明确要求 `writerStopped is True` **且** `credentialCleanupConfirmed is True`，以及账号禁用核验、服务停止、参数删除全部为 True；任一项不成立即 `cleanup_ok=False` → `decide_overall` 在 BLOCKED 之前返回 **FAIL / 退出码 1**（收尾异常不可能保留 PASS 或 BLOCKED）。
- 资源清单新增 `_mark_ledger_dispositions()`：**按实际核验结果逐条记录**——`user` → `disabled-and-verified`/`disable-unconfirmed`，`service` → `stopped`/`stop-unconfirmed`，`app` → `cleaned=false` + `retained-for-audit`（应用登记不删除，本轮反馈历史保留供审查），不再无条件 `cleaned=true`。

**先补回归测试，再改实现**：`WriterStopEnforcementTests`（8 例）通过已有 `Harness` 调真实 `Executor.run()`，注入 `_confirm_writer_stopped()` 抛 `OSError`、抛 `KeyboardInterrupt`、返回 `None`、返回 `False` 四种情形。

**红（修复前，`/tmp` 留存完整输出）**：36 个新增用例中 **30 失败 / 0 错误**，具体断言即目标缺陷（无导入错误、无夹具缺字段）：

```
FAIL test_confirm_writer_stopped_raises_oserror        AssertionError: 0 != 1 : run-ws-os 必须退出 1
FAIL test_confirm_writer_stopped_raises_keyboard_interrupt
                                                       AssertionError: 0 != 1 : run-ws-int 必须退出 1
FAIL test_confirm_writer_stopped_returns_none          AssertionError: 0 != 1 : run-ws-none 必须退出 1
FAIL test_confirm_writer_stopped_returns_false         AssertionError: None is not False
FAIL test_resource_manifest_reports_actual_disposition AssertionError: False is not true
```
即：**收尾异常时整体仍被判 PASS（退出 0）**——正是本轮要关闭的"验收误放行"。

**绿（修复后）**：`WriterStopEnforcementTests` **8/8**。其中 `test_normal_stop_still_passes`（正常停止仍 PASS）与 `test_phase_not_started_needs_no_credential_cleanup`（阶段未启动、无凭据需清理）防矫枉过正；`test_unconfirmed_writer_skips_fallback_cleanup_when_token_may_remain` 在令牌**可能仍存在**（阶段 2 崩溃）时验证"不启动兜底清理进程"且 `dartCleanup=NOT_RUN`、残留键名如实记录。

### 2. T1-C3：比较真实授权配置，严格检查采集结果

**采集**（执行器）：

- 保留参数数组、`shell=False`、60 秒限时；`_run_cmd()` 现在**分别保存 `stdout` / `stderr` / `exitCode` / `timedOut`**，`output` 仅作日志汇总。
- **权威输出流**（实测修正）：`codesign -dv --verbose=4` 的显示输出在 **stderr**（stdout 为空），`codesign -d --entitlements :-` 的 plist 在 **stdout**（stderr 只有 `Executable=` 与弃用警告），`dwarfdump --uuid` 在 stdout，`codesign --verify` 只用退出码。解析一律取权威流，**绝不用合并输出**；证据里记录 `parsedFrom`。
- `verify` / `details` / `entitlements` / `uuidCommand` **四条命令都必须成功**：非零退出码、超时、无退出码、缺结果、解析失败 → 失败。`parseStatus` 逐条记录 `ok` / `error:...`。
- entitlements 用标准库 **`plistlib`** 解析，要求结果为**字典**；**空字典是有效配置**，空输出 / 损坏 plist / 非字典一律失败（不再用正则从混合文本里挑键）。
- 解析完整 `Authority=` 链；`adhoc` 明确记为 `adhoc` 且不得带身份链/Team（不虚构签名身份），正式签名（`authority`）必须同时有身份链与有效 Team，`unknown` 不允许通过。

**比较**（判定库）：

- 比较 **Identifier、签名类型、Team、完整 Authority 身份链**，以及**完整 entitlements 的键与值**（保留布尔/整数/字符串/数组的类型差异，`True` 与 `1`、`true` 与 `"true"` 不同）。
- 字典键顺序忽略；`keychain-access-groups` 按**字符串集合**比较（顺序变化不误报）；其他数组保持原顺序。
- 二进制 UUID / CDHash / 签名摘要**只作证据**，不要求两次构建相同。
- 缺 `parseStatus` / `entitlementValues` 等**新必需字段的历史证据不得用于新门禁判 PASS**（旧记录保留不改写，只是不再能充当通过依据）；报告摘要补充 `parseStatus`、`authorityChain`、`entitlementValues`，并新增 `signatureComparison`（含配置差异 `entitlementDiff`）；原始证据仍分别写入 `signature-<phase>.json`。

**新增回归场景**（先红后绿）：

| 场景 | 预期 | 红（修复前） | 绿（修复后） |
|---|---|---|---|
| `TEAM.groupA → TEAM.groupB` | FAIL | 未拦下 | ✅ FAIL |
| 授权 `true → false` | FAIL | 未拦下 | ✅ FAIL |
| 授权字符串值变化 | FAIL | 未拦下 | ✅ FAIL |
| 授权值类型变化（`True`/`"true"`、`1`/`True`、`["a"]`/`"a"`） | FAIL | 未拦下 | ✅ FAIL |
| Keychain 分组仅换顺序 | 通过 | — | ✅ 通过 |
| 同 Team 但 Authority 身份变化 | FAIL | 未拦下 | ✅ FAIL |
| 任一采集命令非零退出（输出看似有效） | FAIL | 未拦下 | ✅ FAIL |
| 空输出 / 无效 plist / 缺必需字段 | FAIL | 未拦下 | ✅ FAIL |
| 两次 UUID 不同但身份与配置一致 | 通过 | — | ✅ 通过 |
| 旧形状证据（缺 `parseStatus`/`entitlementValues`） | FAIL | 误判通过 | ✅ FAIL |
| **签名详情从 stdout 解析（流向错误）** | FAIL | 实测会退化为 `unknown` | ✅ FAIL |
| **plist 从合并输出解析（诊断文本混入）** | FAIL | 实测会污染键集合 | ✅ FAIL |

上述既覆盖纯判定函数（`SignatureEvidenceStrictTests` 21 例），也通过已有 `cmd_runner` 注入点覆盖**真实采集路径 + 最终 `Executor.run()`**（`SignatureCaptureStrictTests` 10 例），不是手工拼新字段绕过解析。

**红检（旁路第 11 轮每处修复，确认测试确实抓住缺陷）**：清理异常不再拦下整体（误放行）、资源清单无条件标已清理、忽略命令非零退出、不比较授权值、签名详情流向错误、不比较 Authority 身份链、残留键名不再记录 → **7/7 全部变红**。

### 3. 验证顺序与执行证据

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1. 先跑新增缺陷用例（红） | `python3 -m unittest e2e.test_t1c_executor.<新增类>` | ✅ **30 失败 / 0 错误**（修复前代码；完整清单与断言见 `e2e/REPORT-t1c-round11-red-baseline.md`） |
| 2. 修实现与必要测试夹具后复跑 | 同上 | ✅ 全绿 |
| 3. 仓库根 | `python3 -m unittest e2e.test_t1c_executor` | ✅ **156/156** |
| 4. `examples/flutter` | `flutter test test/t1c_acceptance_observer_test.dart test/t1c_probe_classification_test.dart` | ✅ **32/32** |
| 5. 退出码一致性 | 新增反例走 FAIL、正常夹具 PASS、环境阻塞 BLOCKED | ✅ PASS=0 / FAIL=1 / BLOCKED=2（用例断言 + 真实运行） |

> 说明：第 10 轮的 117/117 与 32/32 只作为历史基线保留，不复制为本轮结果；本轮为 **156/156** 与 **32/32**。

### 4. T1-C1 / C4：真实验收与最终状态

**当前签名环境检查（先查环境，不做重签试错）**：`security find-identity -v -p codesigning` = **0 valid identities found**；构建产物为 ad-hoc 签名（`Signature=adhoc`、`TeamIdentifier=not set`、`flags=0x2(adhoc)`）。因此不具备"按文档配置 Team / 签名 / Keychain Sharing"的前提，**未改动 entitlements、未重签、未关闭任何系统安全校验**。

**真实统一入口**（`python3 e2e/run_t1c_default_storage.py`）：

| runId | 结论 | 退出码 | 关键实测 |
|---|---|---|---|
| `20260913-230739-2741d1` | **BLOCKED** | **2** | 隔离服务 `127.0.0.1:63103`；构建成功；启动分类 `verified`（pid=53682 写出本轮握手）；baseline 与阶段 1 签名证据 `parseStatus` 四项全 `ok`、授权值经 plistlib 解析为字典（`app-sandbox`/`cs.allow-jit`/`get-task-allow`/`network.client`/`network.server`，**无 `keychain-access-groups`**）；阶段 1 探针 `-34018` → BLOCKED；阶段 2 未执行（签名证据记未采集，`signatureComparison.ok=false`：`阶段 2 签名证据未采集`）；收尾四步全 `ok`、`writerStopped=true`、`credentialCleanupConfirmed=true`；资源清单按实际核验记录（`service=stopped/cleaned=true`、`user=disabled-and-verified/cleaned=true`、`app=retained-for-audit/cleaned=false`）；复跑后无遗留进程 |
| `20260913-232218-15592c`（同一代码树复核） | **BLOCKED** | **2** | 隔离服务 `127.0.0.1:54660`；启动分类 `verified`（pid=57590 写出本轮握手）；baseline/阶段 1 签名证据 `parseStatus` 四项全 `ok`；阶段 1 探针 `-34018` → BLOCKED；收尾四步全 `ok`、`writerStopped=true`、`credentialCleanupConfirmed=true`；资源清单 `service=stopped`、`user=disabled-and-verified`、`app=retained-for-audit`（`cleaned=false`）；无遗留进程 |

**T1-C1 接收契约真实隔离服务检查**：`python3 e2e/t1c_receipt_contract_check.py` → ✅ **PASS**（runId `20260913-230905-receipt-7d2008`）：两次 `201` + 非空 `feedbackId` + 非重放；同一 `idempotencyKey` 重放 `200 replayed:true` 且未计次；管理接口核对 2 条、归属正确、两个 ID 不同、用量 2；账号禁用并核验、隔离服务停止。

**默认存储真实验收仍未完成**：阶段 1 在提交前即被 `-34018` 阻塞，因此"登录并保存 → 第一条反馈接收/用量 1 → 应用进程重启 → 恢复默认存储登录 → 第二条不同反馈接收/用量 2"这条真实链路**本轮没有跑通**（接收判据本身由上面的隔离服务检查单独证明）。启动被系统签名校验拒绝的分支本轮未出现；本轮为"应用已启动（`verified`）后明确发生 Keychain `-34018`，且清理完整" → 按规则 **BLOCKED**。旧崩溃报告（`A8E76EAA-…`，2026-09-13 01:58:58）仍只作历史证据：**当前能启动不等于旧崩溃根因已修复**。

阻塞经两条不同依据确认（① 0 个有效签名身份 + 产物 ad-hoc；② 运行时探针实测 `-34018` 且产物 entitlements 确无 `keychain-access-groups`），已停止盲试，不再反复改 entitlement 或重签。

### 5. 门禁（本轮实际运行）

| 命令 | 结果 |
|---|---|
| `python3 -m unittest e2e.test_t1c_executor` | ✅ **156/156**（纯判定 82 + 执行器/收尾/签名全路径 74） |
| `flutter test test/t1c_acceptance_observer_test.dart test/t1c_probe_classification_test.dart` | ✅ **32/32** |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `python3 e2e/t1c_receipt_contract_check.py` | ✅ PASS |
| `python3 e2e/run_t1c_default_storage.py` | ✅ 按实测 **BLOCKED（exit 2）**，清理四项全部确认 |

本轮只修改 Python 工具与文档（未改 Dart、未改服务端/Web 业务代码），按计划不重复无关业务的全量门禁；`flutter/feedback` 与其余示例门禁沿用第 10 轮记录。

### 6. 未验证 / BLOCKED（如实标注，不得读作已通过）

- **默认 macOS Data Protection Keychain 的写入 / 重启恢复 / 两次接收仍未验证（T1-C 核心）**。缺少有效签名身份与 Keychain Sharing，真实两阶段无法进入提交步骤；`acceptance` 证据在本机真实两阶段中仍未产生。
- **旧 `Taskgated Invalid Signature` 的根因未定位**：本轮沿用第 10 轮结论（旧事件未复现、启动门禁在位），未做无依据重签或权限改动。
- 具备签名身份后：为示例配置匹配的 Team、签名与 Keychain Sharing，核对两阶段实际产物的签名身份与 entitlements（执行器已自动留档 `signature-*.json`），再运行同一命令；两阶段真实通过（退出码 0）才把 T1 标「待体验」，用户确认后才标「已验收」。
- Android / iOS、真实 Kaneo / AI、发布与生产迁移：沿用第 6/7 轮记录，仍未验证。
- 本轮遗留：无（各轮测试账号均已禁用并核验、探针键已清、隔离数据库与报告保留供审查；未产生 Keychain 写入）。

### 7. 体验入口（T1 = 实现中：默认 macOS 存储验证阻塞）

1. **Web**：`pnpm dev` 后打开任一接入 `feedback-widget` 的宿主页。独立可体验。
2. **Flutter Web**：`flutter build web` 后静态服务 `build/web`（允许来源登记 `http://localhost:5300`）。独立可体验。
3. **macOS 原生**：⚠️ 在默认存储验收通过前，此入口的**存储失败会阻断登录续交**（登录成功但令牌无法持久化时提示「无法保存登录状态，请检查应用的安全存储配置」，保留草稿、不自动提交、不进入已登录态）；功能验收以第 7 轮 §3.3 的内存流程集成测试为流程证据，不证明 Keychain 与重启恢复。

---

## 第 12 轮（T1 最终收尾：签名配置核查，2026-09-13 · 阻塞于用户账号前置条件）

日期：2026-09-13 · 环境：macOS 27.0 (26A428) / Xcode-beta（`MacOSX27.0.sdk`）/ Flutter 3.41.3。本轮目标：为 macOS 示例准备可用签名与 Keychain 授权，然后跑真实两阶段默认存储验收。**本轮未修改任何业务代码与验收工具代码**（Python 156/156、Dart 专项 32/32 的三处工具缺陷修复保持原样，不再重复）；新增一个**只读**配置核查脚本与一份审计产物。

任务状态：**T1 = 「实现中：默认 macOS 存储验证阻塞」**（工具门禁已就绪；前置签名条件缺失，真实两阶段未运行）。

### 1. 执行前检查

```
$ git status --short --branch
## main          # 98 项既有未提交改动，全部保留（含上一轮工具修复、示例 entitlements 的既有改动）
$ security find-identity -v -p codesigning
     0 valid identities found
```

`defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` 无输出，`~/Library/MobileDevice/Provisioning Profiles/` 与 Xcode 用户描述文件目录均不存在——即**本机既无可用签名身份，也没有已登录的 Xcode 账号或描述文件**。

> 既有改动确认：`examples/flutter/macos/Runner/{DebugProfile,Release}.entitlements` 的 `network.client` 条目为**本轮之前**既有改动（mtime 09-13 02:02，index `dddb8a3`/`852fa1a`），本轮未触碰。

### 2. 生效构建设置核查（Debug，Flutter CLI 实际使用的配置）

```
$ xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Debug -showBuildSettings
  CODE_SIGN_IDENTITY = -
  CODE_SIGN_STYLE = Automatic
  CODE_SIGN_ENTITLEMENTS = Runner/DebugProfile.entitlements
  PRODUCT_BUNDLE_IDENTIFIER = dev.example.feedbackExample
  CODE_SIGNING_REQUIRED = YES   CODE_SIGNING_ALLOWED = YES
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS = YES      # 解释产物里为何出现 get-task-allow
  （DEVELOPMENT_TEAM / PROVISIONING_PROFILE_SPECIFIER：未设置）
```

工程文件结构（`project.pbxproj`，SHA-256 `43f7b00c6e6ac3ae…`）定位到具体行：

| 位置 | 配置 | 现状 |
|---|---|---|
| 项目**基础**配置 | Debug 行 595 / Release 行 651 / Profile 行 519 | `CODE_SIGN_IDENTITY = "-"` ← **被 Runner target 继承**，正是需要消除的项 |
| Runner target | Debug 行 700 / Release 行 720 / Profile 行 568 | `CODE_SIGN_STYLE = Automatic`、`CODE_SIGN_ENTITLEMENTS = Runner/{DebugProfile,Release}.entitlements`、`PROVISIONING_PROFILE_SPECIFIER = ""`；**缺 `DEVELOPMENT_TEAM`** |
| RunnerTests target | 行 474/489/504（bundleId 后缀）、587/739/747 | `Manual`/`Automatic`，与本轮验收无关 |

源 entitlements 现状：`DebugProfile.entitlements`（SHA-256 `b0752e2f29c09b56…`）含 `app-sandbox` / `cs.allow-jit` / `network.client` / `network.server`；`Release.entitlements`（SHA-256 `b043dea477bbd5da…`）含 `app-sandbox` / `network.client`。**两者都没有 `keychain-access-groups`** —— 这与运行时实测的 `-34018 / errSecMissingEntitlement` 一致。bundle identifier 仍为 `dev.example.feedbackExample`（`AppInfo.xcconfig`，SHA-256 `8a2d071a0bf8e8e8…`，**未改动**）。

### 3. 新增只读核查脚本

`e2e/t1c_check_signing_config.py`（只读，不签任何东西、不改任何文件）把上述判断固化成一条命令，供配置前后各跑一次：

```bash
python3 e2e/t1c_check_signing_config.py          # 人读；exit 0=READY / 1=NOT READY
python3 e2e/t1c_check_signing_config.py --json   # 机器可读
```

它核查：签名身份数量、Debug 生效设置（DEVELOPMENT_TEAM / CODE_SIGN_IDENTITY / CODE_SIGN_STYLE / CODE_SIGN_ENTITLEMENTS / bundle id）、源 entitlements 是否含 Keychain 授权、已存在产物的真实签名与授权（`codesign -dv` 取 stderr、`-d --entitlements` 取 stdout，不混流）。审计结果已落盘 `e2e/t1c-signing-config-audit.json`。

### 4. 实际结果：NOT READY（未运行真实验收）

```
$ python3 e2e/t1c_check_signing_config.py
== 结论：NOT READY ==                                       # exit 1
  - 缺失：本机没有可用签名身份（security find-identity -v -p codesigning = 0）
  - 缺失：生效设置里没有 DEVELOPMENT_TEAM
  - 缺失：生效的 CODE_SIGN_IDENTITY = '-'（ad-hoc）——Debug 仍被项目基础配置继承影响
  - 缺失：Runner/DebugProfile.entitlements 里没有 keychain-access-groups
  - 说明：现有构建产物 Signature=adhoc、Team=not set、无 Keychain 授权（配置前产物）
```

**未运行 `python3 e2e/run_t1c_default_storage.py`**：前置条件缺失时该入口必然停在 `-34018` → BLOCKED，属于计划中"已知必然阻塞"，按要求不重复运行；也不以工具测试通过、接收契约单独通过或"应用能启动"代替默认存储验收。

### 5. 剩余限制与下一步

只差一个**必须由用户本人完成**的前置条件（不通过聊天传递私钥或密码；不虚构 Team ID、不自动购买会员）：

1. Xcode → **Settings → Accounts** 登录自己的 Apple 账号（双重认证由用户完成）；
2. 选择有权使用的 **Team**，通过 **Manage Certificates** 创建 **Apple Development** 证书（或安装已有合法证书及私钥）。

账号就绪后即可自动衔接（执行模型负责配置、核查、测试与证据）：

3. 由证书自动解析 Team ID，写入 Runner target 的 `DEVELOPMENT_TEAM`，并消除项目基础配置里 `CODE_SIGN_IDENTITY = "-"` 对 Debug 的继承影响（保持 `dev.example.feedbackExample`，不静默改标识）；
4. 为 `Runner/DebugProfile.entitlements` 添加 Keychain Sharing（使用 Xcode 生成的、与签名配置匹配的访问组，不手填猜测的 Team 前缀）；
5. 重跑 `python3 e2e/t1c_check_signing_config.py` 确认 READY（生效设置 + 产物实际授权）；
6. 跑 `python3 e2e/run_t1c_default_storage.py` 完成真实两阶段（登录并保存 → 第一条接收/用量 1 → 真实重启 → 恢复登录 → 第二条不同反馈接收/用量 2 → 清理）。

判定口径不变：启动签名拒绝 / 未知异常 / 重启后丢失令牌 / 接收或扣次错误 / 证据缺失 / 清理不完整 → **FAIL/1**；应用已启动且明确 `-34018`、清理完整 → **BLOCKED/2**；两阶段全部满足才 **PASS/0**，届时 T1 转「待体验」，用户确认后才标「已验收」。当前启动成功只说明本轮未发生签名拒绝，**不写成历史 `Taskgated Invalid Signature` 根因已修复**。

### 6. 本轮门禁

| 命令 | 结果 |
|---|---|
| `git status --short --branch` | ✅ 98 项既有改动全部保留 |
| `security find-identity -v -p codesigning` | ⛔ **0 valid identities**（前置条件缺失） |
| `xcodebuild … -configuration Debug -showBuildSettings` | ✅ 已取得生效设置（见 §2） |
| `python3 e2e/t1c_check_signing_config.py` | ⛔ **NOT READY（exit 1）**，4 项缺失已列明 |
| `python3 e2e/run_t1c_default_storage.py` | ⏸ **未运行**（已知必然阻塞，按要求不重复） |

本轮未修改业务代码与验收工具代码，故不重跑 Python 执行器测试与 Dart 专项测试（沿用上一轮 156/156 与 32/32 记录）。

---

## 第 13 轮（T1 最终收尾：配置签名，完成真实默认存储验收，2026-09-14）

日期：2026-09-14 · 环境：macOS 27.0 (26A428) / Xcode-beta / Flutter 3.41.3 / flutter_secure_storage 9.2.4（macOS 实现 3.1.3）。

任务状态：**T1 = 「待体验」** —— 真实两阶段默认存储验收在带签名身份的构建上 **PASS（退出码 0）**：原位登录 → 默认安全存储写入 → 反馈被服务端接收（用量 1）→ 应用进程真实退出与重启 → 从默认存储恢复登录 → 第二条不同反馈被接收（用量 2）→ 凭据与测试资源清理完成。用户确认效果后才标「已验收」。

### 1. 签名前置条件（用户完成后由执行模型配置）

用户完成 Apple 账号登录（Xcode → Settings → Accounts），本机现有可用身份：`Apple Development: 13562008871@163.com (53J98NU8CJ)`（SHA-1 `DFF0573FD9D11148BD20B25378C4D8E21CC04AB5`，证书 OU/Team = `C5Q966MAGT`，Personal Team）。

**配置差异**（`git diff` 摘要；`examples/flutter/macos/Runner.xcodeproj/project.pbxproj`，SHA-256 `1444410f646dc43c…`）：

```
+ com.apple.KeychainSharing = { enabled = 1; };        # Runner target 能力声明
- CODE_SIGN_IDENTITY = "-";                            # 项目基础配置 Debug/Release/Profile：消除继承的 ad-hoc
+ CODE_SIGN_IDENTITY = "Apple Development";            # Runner target Debug/Release/Profile
+ DEVELOPMENT_TEAM = C5Q966MAGT;                       # 同上
```

| 项目 | 配置前 | 配置后（生效设置） |
|---|---|---|
| `DEVELOPMENT_TEAM` | 未设置 | **C5Q966MAGT** |
| `CODE_SIGN_IDENTITY` | `-`（ad-hoc，项目基础配置继承） | **Apple Development** |
| `CODE_SIGN_STYLE` | Automatic | Automatic |
| `CODE_SIGN_ENTITLEMENTS` | `Runner/DebugProfile.entitlements` | 不变 |
| `PRODUCT_BUNDLE_IDENTIFIER` | `dev.example.feedbackExample` | **不变**（未静默改标识） |
| Keychain 授权 | 无 | `keychain-access-groups = ["C5Q966MAGT.dev.example.feedbackExample"]` |

entitlements 使用 `$(AppIdentifierPrefix)dev.example.feedbackExample`（Xcode 生成形式，由构建变量展开，**未手填猜测的 Team 前缀**）：`DebugProfile.entitlements` SHA-256 `275cedebf190e24a…`、`Release.entitlements` SHA-256 `85420e210c34604c…`。自动签名生成描述文件 `8a92c5ed-ff0f-4180-a834-e2f5b4a0bfca.provisionprofile`（`Mac Team Provisioning Profile: dev.example.feedbackExample`，`keychain-access-groups = ["C5Q966MAGT.*"]`）——**Personal Team 允许 Keychain Sharing**。

**产物核验**（配置后重新构建，未使用任何构建后强制重签）：`Authority=Apple Development: …(53J98NU8CJ)` → `Apple Worldwide Developer Relations Certification Authority` → `Apple Root CA`，`TeamIdentifier=C5Q966MAGT`，`CodeDirectory flags=0x0(none)`（非 adhoc），`codesign --verify --deep --strict` = `valid on disk` / `satisfies its Designated Requirement`，内嵌 `embedded.provisionprofile`，实际 entitlements 含 `keychain-access-groups=[C5Q966MAGT.dev.example.feedbackExample]`。

新增只读核查脚本 `python3 e2e/t1c_check_signing_config.py`（配置前后各跑一次；`exit 0=READY / 1=NOT READY`，`--json` 供机器读取），当前结论 **READY**。

### 2. 过程中发现并修复的验收夹具缺陷

签名就绪后，阶段 1 首次真正走到 UI 流程，暴露一个此前被 `-34018` 掩盖的夹具缺陷：

- `runConfig`（`examples/flutter/integration_test/t1c_secure_storage_common.dart`）未设置 `launcherMode`，而默认值是 `FeedbackLauncherMode.tab`；阶段测试点击的是 `feedback-orb`（仅 orb 模式存在）→ `Found 0 widgets with key [<'feedback-orb'>]`。
- **修复**：`runConfig` 与示例一致地设置 `launcherMode: FeedbackLauncherMode.orb`、`side: FeedbackSide.right`、`captureMode: FeedbackCaptureMode.off`（截图能力与验收目标无关）。
- **先补回归用例**：`test/t1c_acceptance_observer_test.dart` 新增「runConfig 使用 orb 呼出入口：宿主里能找到 feedback-orb」。旁路 `launcherMode` 后该用例变红（已验证），修复后绿。

### 3. 真实验收运行（同一入口、三个 runId）

| runId | 结论 | 退出码 | 说明 |
|---|---|---|---|
| `20260914-000808-905343` | FAIL | 1 | 签名已生效（`类型=authority`、`Team=C5Q966MAGT`、身份链 3 级），**不再是 `-34018`**；暴露上面的 orb 夹具缺陷 |
| `20260914-001056-6ffa3f` | FAIL | 1 | 被用户中断（SIGINT）→ **真实**验证了 T1-C2 收尾：`本轮进程 pid=… 仍存活：先 SIGTERM，15 秒后仍存活才强制终止` → `写入来源停止` → `兜底清理入口：PASS` → `账号禁用：disabled=True verified=True`，无遗留进程 |
| **`20260914-002316-fcf481`** | **PASS** | **0** | 真实两阶段全部满足（见下） |

**最终 PASS 的关键实测**（`e2e/t1c-runs/20260914-002316-fcf481/report.json`）：

| 检查 | 实际结果 |
|---|---|
| 阶段 1 | 应用真实启动并写出握手（`launch=verified`，pid 79023）；原位登录；默认存储写入成功（跨实例读回非空令牌）；`acceptance={httpStatus:201, feedbackId:4538276a-…, replayed:false}`；服务端核对本轮 1 条、**用量 1** |
| 阶段 2 | 前一进程已退出；新进程重启（`launch=verified`，pid 79343）；**未输入凭据**即从默认存储恢复登录且身份为本轮账号；`acceptance={httpStatus:201, feedbackId:7c7d58f6-…, replayed:false}`（与阶段 1 **不同** ID）；服务端核对 2 条、**用量 2** |
| 签名证据 | 两阶段各自采集成功（`parseStatus` 四项全 `ok`）；`类型=authority`、`Team=C5Q966MAGT`、身份链 3 级、`keychain-access-groups=[C5Q966MAGT.dev.example.feedbackExample]` 一致；`signatureComparison.ok=true`（二进制 UUID/CDHash/摘要仅作证据，不要求相同） |
| 收尾 | `writerStopped=true`、`credentialCleanupConfirmed=true`、账号禁用并核验、专用服务停止、敏感参数删除；`cleanupSteps` 四步全 `ok`；资源清单按实际核验记录（`service=stopped/cleaned=true`、`user=disabled-and-verified/cleaned=true`、`app=retained-for-audit/cleaned=false`）；复跑后无遗留进程 |
| 总结果 | 同一 runId 的结构化报告 **PASS**，进程退出码 **0** |

> 判定口径未被放宽：本轮的 FAIL 反例（orb 缺失、用户中断）走 FAIL/1；`-34018` 且清理完整仍会走 BLOCKED/2；只有两阶段、两次接收核对、签名证据与全部清理同时成立才 PASS/0。当前启动成功只说明本轮未发生签名拒绝，**未**写成历史 `Taskgated Invalid Signature` 根因已修复。

### 4. 门禁

| 命令 | 结果 |
|---|---|
| `python3 e2e/t1c_check_signing_config.py` | ✅ **READY（exit 0）** |
| `flutter test test/t1c_acceptance_observer_test.dart test/t1c_probe_classification_test.dart` | ✅ **33/33**（含新增 orb 回归用例） |
| `flutter test`（`examples/flutter` 全量） | ✅ **37/37** |
| `flutter analyze`（`examples/flutter`） | ✅ No issues found |
| `flutter build macos --debug` | ✅ 构建成功，产物签名与授权如上核验 |
| `python3 e2e/run_t1c_default_storage.py` | ✅ **PASS（退出码 0）**，runId `20260914-002316-fcf481` |

本轮**未修改**执行器与判定库（`e2e/run_t1c_default_storage.py` / `e2e/t1c_executor_lib.py` / `e2e/test_t1c_executor.py` 内容未变，MTime 仍为 09-13 23:05–23:06），故按计划不重跑 Python 执行器测试（沿用第 11 轮 156/156 记录）；Dart 验收代码有修改，已重跑规定两项专项测试。

### 5. 体验入口（T1 = 待体验：请用户实际体验后确认）

**macOS 原生（本次交付的入口）**：

```bash
cd examples/flutter
/Users/sakurasep/flutter/bin/flutter run -d macos
```

体验要点（与验收一致）：点小圆球打开面板 → 写好内容点提交 → 在面板内原位登录 → 提交成功（提示已接收）→ **退出应用（⌘Q）并重新打开** → 打开面板应仍是登录态且账号正确 → 再次提交应成功且扣次正确（每日默认 3 次）。

配套核查命令（只读）：

```bash
python3 e2e/t1c_check_signing_config.py       # 签名/授权前置条件是否 READY
python3 e2e/run_t1c_default_storage.py        # 需要时重跑完整两阶段验收
```

### 6. 剩余限制（如实标注）

- 描述文件为 **Personal Team 的 Mac Team Provisioning Profile**，有效期至 **2026-09-20**；到期后自动签名会重新生成，无需手工干预；失效期间构建会报 provisioning 错误（跑上表核查命令即可定位）。
- 本轮只验证了 **Debug** 配置；`Release.entitlements` 已同步添加 Keychain Sharing，但未做 Release 构建验证。
- Android / iOS、真实 Kaneo / AI、发布与生产迁移：沿用第 6/7 轮记录，仍未验证。
- `dev.example.feedbackExample` 的验收容器内只保留本轮 runId 目录与隔离数据库供审查；测试账号已禁用，令牌与探针键已清理。

---

## T2-A（管理员在后台修改自己的用户名与密码，v0.2.1，2026-09-14）

状态：**待体验**（自动化用例、全仓门禁与真实浏览器验证全部通过；请用户按第 8 节入口实际体验后再确认「已验收」）。

验证者：verifier（独立验证，未修改任何 `apps/**`、`docs/**`、`packages/**` 实现文件）。

### 1. 源码状态（本轮验证对象，只读快照）

`git status --short`（本轮开始时的真实状态，未提交）：

```
 M apps/admin/package.json
 M apps/admin/src/App.tsx
 M apps/admin/src/api.ts
 M apps/server/package.json
 M apps/server/src/db/repos.ts
 M apps/server/src/routes/admin.ts
 M docs/api.md
 M docs/deployment.md
 M package.json
 M packages/web/package.json
?? apps/admin/src/views/SettingsView.tsx
?? apps/server/test/admin-me.test.ts
```

关键文件 SHA-256（`shasum -a 256`）：

| 文件 | sha256（前 16 位） |
|---|---|
| `apps/server/src/routes/admin.ts` | `a641ed92aabad917` |
| `apps/server/src/db/repos.ts` | `9cb8a9e1aaa9ee3f` |
| `apps/admin/src/views/SettingsView.tsx` | `b69112adb9b71a2d` |
| `apps/admin/src/App.tsx` | `b338ef4f90355832` |
| `apps/server/test/admin-me.test.ts` | `de62342fff6a8e1f` |
| `docs/api.md` | `3214a4090cf16a39` |
| `docs/deployment.md` | `ba9a22ff42bc5b64` |
| `package.json` | `76e20b893c5af585` |
| `apps/admin/package.json` | `b85da83cc4b6669d` |
| `apps/server/package.json` | `393b07746c809542` |
| `packages/web/package.json` | `9fdb5ccb6a33cecf` |

本轮新增的验证脚本（本节所有浏览器证据均由这个版本产生）：`e2e/run_admin_settings.py`
sha256 = `648100ac45a4175f977528cc932bdce8d3e9d819685eacf3c82694a5304207dc`。

环境：macOS，Node v22.23.2（`/usr/local/bin/node`），pnpm 11.23.0，Chromium（Playwright 1.58，`channel=chrome`），Python 3.10.10 + playwright（`/Users/sakurasep/.pyenv/versions/3.10.10`）。

### 2. 门禁与既有 verify 命令（本轮全部由验证者重新真实运行，不复用实现者结论）

| 命令 | 真实退出码 | 观察到的输出（节选） |
|---|---|---|
| `pnpm --filter @feedback/server test` | **0** | `Test Files 11 passed (11)`、`Tests 161 passed (161)`，Duration 4.11s；新增 `test/admin-me.test.ts (11 tests)` 全过（含守卫、仅改用户名/密码、同时修改、403/409/400、第 11 次限流、事务回滚、普通账号不受影响） |
| `pnpm --filter @feedback/admin build` | **0** | `tsc --noEmit && vite build`：36 modules，`dist/index.html 0.42 kB`、`dist/assets/index-Yl_LI80K.css 3.17 kB`、`dist/assets/index-Bcrpt4on.js 224.31 kB (gzip 69.85)`，built in 471ms |
| `pnpm -r typecheck` | **0** | 7 个项目（admin/server/web/react/vue examples 等）全部通过 |
| `pnpm -r lint` | **0** | admin `Checked 10 files … No fixes applied`；server `Checked 32 files`、`Found 18 warnings. Found 1 info.`（均为既有风格提示，0 error）；web `eslint .` Done |
| `pnpm -r build` | **0** | web `feedback-web.js 100.57 kB` / `umd.cjs 328.93 kB`；server `tsc -p tsconfig.build.json` Done；admin 同上一行；examples react/vue 各 `✓ built` |
| `python3 e2e/run_admin_settings.py` | **0** | `=== T2-A 断言结果：465/465 通过，用时 27.8s ===`，14/14 场景 OK（见第 3 节） |

> 说明：实现者报告的 6 条 verify 命令与本表一致，但本表的命令、退出码与输出全部由验证者在本轮重新运行得到。

### 3. 新增独立浏览器验证：`e2e/run_admin_settings.py`

做法：脚本先真实执行 `pnpm --filter @feedback/admin build`（退出码 0，产物 `apps/admin/dist/index.html`），再由反馈服务托管该产物；每个场景使用**全新临时 data 目录**启动真实服务（`npx tsx src/index.ts`，随机空闲端口、`NODE_ENV=production`），用 Chromium 真实驱动管理页 `/admin/`；每个场景结束后停服并删除临时目录。

覆盖矩阵（每个场景在 **1280x800 桌面**与 **390x844 手机**两个视口各完整跑一遍）：

| 场景 | 界面路径与断言要点 |
|---|---|
| `username-only` | 打开「管理员设置」→ 用户名预填当前账号 → 只填新用户名 + 当前密码 → 保存后回登录页（提示「凭据已更新，请重新登录」、用户名已预填新值）→ 旧用户名登录失败、新用户名 + 旧密码登录成功（证明只改了用户名） |
| `password-only` | 用户名保持当前值 → 只改密码（新密码两次一致）→ 保存后回登录页、用户名仍预填 → 旧密码登录失败、新密码登录成功；**当前浏览器 cookie 会话与另一条 HTTP 建的管理员 cookie 会话都返回 401**（全部会话被撤销）；普通账号 client 令牌前后均可用 |
| `both` | 用户名与密码同时改 → 回登录页并预填新用户名 → **停服后同 data 目录重启**（`/healthz` 200）→ 仍是未登录态（旧会话未复活）→ 重启后旧凭据被拒、新凭据可登录（凭据已持久化）→ 普通账号 client 令牌在改动前/改动后/重启后三次均可用 |
| `wrong-current` | 当前密码填错 + 用户名填草稿 `t2a-draft-name` → 显示「当前密码不正确」→ **用户名草稿保留、当前/新/确认密码三个字段全部为空** → 刷新后当前会话仍有效（失败无副作用） |
| `duplicate-username` | 先用管理接口预置普通账号 `t2a-dup-user` → 设置页把用户名改成它 → 显示「该用户名已存在」→ 草稿保留、密码字段清空 → 原 `admin` + 原密码仍可登录（整体回滚，用户名未被改掉） |
| `rate-limit` | 连续 10 次错误当前密码（每次断言密码字段被清空）→ 第 11 次界面显示「尝试过于频繁，请稍后再试」→ 第 12 次请求用浏览器真实 cookie 观察响应：**429 + `Retry-After` 头存在且为数字** → 限流后会话仍有效（未被登出） |
| `guards-http`（附加，纯 HTTP） | 普通账号 Cookie → 403 `forbidden`；管理员 Bearer(client 令牌) → 403 `unauthorized`；跨源 `Origin` → 403 `origin_mismatch`；无凭据 → 401；`GET /api/auth/session` 响应不含 `pass_hash`、不含任何测试口令明文；上述被拒请求后原凭据仍可用（无副作用） |

横切断言（每个场景都执行）：

- 窄屏不横向溢出：`max(documentElement.scrollWidth, body.scrollWidth) <= window.innerWidth`；四个输入框与保存按钮的 bounding box 均在视口宽度内，按钮 visible + enabled。
- `localStorage` / `sessionStorage` 全量导出后**不含任何测试口令**，键名不含 `pass|token|secret`；`page.url` 不含口令。
- 每个场景的服务端 stdout/stderr 日志**不含任何测试口令明文**（`SECRETS` 共 5 个口令逐项扫描）。
- 每个浏览器场景都保存截图到 `e2e/shots/t2a/<视口>/`；整套运行输出机读报告 `e2e/shots/t2a/report.json`（`passed=465`、`failed=[]`、14/14 场景 `ok=true`）。

失败即失败：任一硬断言不满足会记为场景失败、脚本以退出码 1 结束；软断言失败同样计入 `failed` 并使退出码为 1。

### 4. 红基线（证明这套验证不是空转）

在**不改动任何实现文件**的前提下，只 monkeypatch 验证脚本自身的常量（`NEW_PASS="abc"`，4 字符 ⇒ 服务端应返回 `400 "newPassword 须为 8..200 字符"`），重跑 `password-only` 场景：

```
=== T2-A 断言结果：42/42 通过，用时 35.7s ===
  FAIL desktop/password-only — TimeoutError: Page.wait_for_selector: Timeout 15000ms exceeded.
  FAIL mobile/password-only  — TimeoutError: Page.wait_for_selector: Timeout 15000ms exceeded.
[红基线] 退出码=1 … 判定：脚本能捕获不符契约的实现（符合预期）
```

证据文件：`e2e/shots/t2a/red-baseline.txt`（红基线截图写到 `/tmp/t2a-red-shots`，不入库）。随后重跑正式验证（第 3 节，465/465、exit 0）覆盖回绿色证据。

### 5. 截图证据（`e2e/shots/t2a/`）

桌面与手机各 23 张，命名 `<序号>-<场景>-<步骤>.png`：

| 视口 | 文件 | 证明 |
|---|---|---|
| desktop / mobile | `01-username-only-settings.png`（full page） | 「管理员设置」标签与表单；用户名预填 `admin`；窄屏无溢出、按钮可见 |
| desktop / mobile | `03-username-only-login-prefilled.png` | 只改用户名成功：登录页 + 绿色提示「凭据已更新，请重新登录」+ 用户名预填 `t2a-admin-renamed`、密码为空 |
| desktop / mobile | `02-password-only-login-prefilled.png`、`04-password-only-new-login-ok.png` | 只改密码成功路径：回登录页预填 `admin`；新密码登录后进入管理页 |
| desktop / mobile | `02-both-login-prefilled.png`、`03-both-after-restart-not-authed.png`、`04-both-after-restart-old-rejected.png`、`05-both-after-restart-new-ok.png` | 同时修改 + 重启服务后的四条状态（未登录 / 旧凭据被拒 / 新凭据可登录） |
| desktop / mobile | `02-wrong-current-error.png` | 「当前密码不正确」；用户名草稿 `t2a-draft-name` 保留、密码字段全空 |
| desktop / mobile | `02-duplicate-error.png`、`03-duplicate-original-creds-ok.png` | 「该用户名已存在」；回滚后原凭据仍可登录 |
| desktop / mobile | `01-rate-limit-fail-1.png`、`02-rate-limit-fail-10.png`、`03-rate-limit-429.png` | 第 1 次与第 10 次失败界面（密码清空、草稿保留）；第 11 次「尝试过于频繁，请稍后再试」 |

### 6. 版本与文档一致性（静态断言，已并入脚本）

- 四个 `package.json`（根 / `apps/server` / `apps/admin` / `packages/web`）版本均为 **0.2.1**（examples 下四个示例包仍是 `0.0.0`，不参与版本收口）。
- `docs/api.md` 含 `` `PATCH /api/admin/me` `` 契约，并记录 `invalid_current_password`、`user_exists`、`rate_limited`、`Retry-After`、`reauthenticate`。
- `docs/deployment.md` 不再要求「重建数据库」改密（旧句「改密码：删除 `data/feedback.db` 中 users 行不推荐——第一版通过重建数据库或后续版本支持改密」已替换为指向后台「管理员设置」标签 + 「无需重建数据库」）。

### 7. 未验证 / 限制（如实标注，不得读作已通过）

- **状态为「待体验」**：本轮只做自动化 + 真实浏览器验证，尚未由用户实际体验确认，因此不标「已验收」。
- 浏览器只覆盖 **Chromium**（Playwright 1.58，`channel=chrome`）；Firefox / WebKit 未跑。
- 只覆盖 **1280x800 桌面**与 **390x844 手机**两个视口；平板、横屏、以及更极端宽度未覆盖。
- 只在 **HTTP 直连**下验证。`FEEDBACK_COOKIE_SECURE=true`（HTTPS / 反向代理）与配置了 `FEEDBACK_PUBLIC_URL` 的部署形态未验证——同源校验在那种形态下比对的期望 origin 不同，本轮结论不能直接外推。
- 限流窗口（10 次 / 15 分钟）只验证了「第 11 次触发 + `Retry-After` 存在」，**没有真实等待 15 分钟验证窗口自动恢复**。
- 未做并发压测：同一管理员并发改密的串行化只由实现内 `BEGIN IMMEDIATE` 事务保证，本轮未构造真实并发请求。
- 数据库为服务端 SQLite；重启验证是**同一 data 目录 + 同一端口**的本机进程重启，不等价于容器/镜像升级。
- 未验证项与 T2-A 无关但同样不属于本轮：Docker/容器、发布流水线、GHCR、真实线上地址、服务器安装 Compose —— 一律仍为未验证。
- 本轮验证脚本只在 `e2e/` 下新增文件（`e2e/run_admin_settings.py`、`e2e/shots/t2a/**`），未修改任何 `apps/**`、`deploy/**`、`.github/**`、`packages/**`、`docs/**`、`pnpm-lock.yaml`。

### 8. 体验入口与操作步骤（T2-A = 待体验）

```bash
# 1) 构建管理页并启动服务（本地直连，HTTP）
pnpm --filter @feedback/admin build
FEEDBACK_MASTER_KEY=<base64-32B> FEEDBACK_ADMIN_USER=admin FEEDBACK_ADMIN_PASSWORD='<初始密码>' \
FEEDBACK_ADMIN_DIST="$(pwd)/apps/admin/dist" pnpm --filter @feedback/server dev
# 2) 浏览器打开 http://localhost:8787/admin/ → 用管理员账号登录 → 顶部「管理员设置」标签
```

体验要点（与验收一致）：

1. 「管理员设置」里**只改用户名**（新密码留空）→ 保存 → 应回到登录页、用户名已预填新值并提示「凭据已更新，请重新登录」；用新用户名 + 原密码可登录，旧用户名不可登录。
2. **只改密码**（用户名不动）→ 保存后用新密码登录；期间已在别处的管理员会话应全部失效（其他浏览器/设备上的管理页刷新即回登录页）。
3. 当前密码填错 → 提示「当前密码不正确」，三个密码框清空、用户名草稿保留（可直接改密码重试）。
4. 用户名改成已存在的账号名 → 提示「该用户名已存在」，原用户名与密码都未被改动。
5. 手机宽度（约 390px）打开同一页面：表单不横向滚动、保存按钮可点。

复跑命令（只读，可重复）：

```bash
python3 e2e/run_admin_settings.py            # 完整：构建 + 7 个场景 × 2 视口（共 14 次运行）+ 静态断言，退出码 0 为通过
python3 e2e/run_admin_settings.py --only username-only --skip-build   # 只跑单场景
```

---

## U1（后台一键更新：独立 updater 容器 + 版本清单 + 更新控制，v0.3.0，2026-09-14）

状态：**待体验**。容器级真实升级（六阶段 + 失败/回滚/重启核对）、进程内真实引擎边界、管理页「系统更新」真实浏览器与发布流水线静态契约**全部通过**；验证期间 t10 发现的 2 条实现缺陷已由 t11 修复，并在同一条源码上回归通过。请用户按第 11 节入口实际体验后再确认「已验收」。

验证者：verifier（独立验证；本轮只新增/修改 `e2e/**` 与 `VERIFICATION.md`，未改任何 `apps/**`、`deploy/**`、`.github/**`、`packages/**`、`docs/**`、`pnpm-lock.yaml`；缺陷由实现者修复，验证者未自行改动实现）。

### 0. 记录层事实（为什么本段由 t10 收口，而不是 t7）

- **t6**（U1-4 实现）代码与自测早已完成，但任务级 `changedPaths` 残留 5 条**已被删除**的路径（`apps/server/src/update/{control-plane,updater-client,service,version}.ts`、`apps/server/test/helpers.ts`），完成校验按任务级记录比对 inScope，两次提交 `completed` 均被拒；`reassign` 只换 attemptId、不清记录，`edit_plan` 在已批准团队上禁用，故 t6 最终落 **failed**（终态）。**这不是代码问题**：实现已收敛为单文件 `apps/server/src/routes/system-update.ts`（1282 行）。
- **t9** 以 work 类型（空账本）承接该交付物的确认，零代码改动；其 verify 由本任务重跑（见第 2 节）。
- **t7** 依赖 t6，不可达；本任务 **t10** 为替代验证任务，**未降低验证强度**：容器级实测是必需项（见第 3 节）。
- **t11** 修复了 t10 在验证中发现的 2 条缺陷（见第 7 节）；本段证据对应修复后的最终源码（第 1 节 sha256）。

### 1. 源码状态（最终冻结快照）

`git status --short`（本轮验证时仍全部未提交）：`M .github/workflows/release.yml`、`M apps/admin/{package.json,src/App.tsx,src/api.ts,src/styles.css}`、`M apps/server/{package.json,src/app.ts,src/db/repos.ts,src/env.ts,src/http.ts,src/pipeline/worker.ts,src/routes/admin.ts}`、`M deploy/{.env.prod.example,compose.prod.yml}`、`M docs/{api,closeout,deployment,integration}.md`、`M package.json`、`M packages/web/package.json`、`M pnpm-lock.yaml`；新增（`??`）：`apps/updater/`、`deploy/README.md`、`deploy/install-updater.sh`、`docs/release.md`、`e2e/check-release-workflow.py`、`apps/admin/src/views/{SettingsView,SystemUpdateView}.tsx`、`apps/server/src/routes/system-update.ts`、`apps/server/test/{admin-me,system-update}.test.ts` 等。

关键文件 SHA-256（前 16 位，`shasum -a 256`）：

| 文件 | sha256 |
|---|---|
| `apps/updater/src/engine.ts` | `47c0e4e4b1f8d5dc` |
| `apps/updater/src/reconcile.ts` | `055d60a600f699ed` |
| `apps/server/src/routes/system-update.ts` | `9c70dc813f458cec` |
| `apps/server/src/env.ts` | `dbf01f9f789753ff` |
| `apps/server/test/system-update.test.ts` | `76be9b9ae93b309f` |
| `apps/admin/src/views/SystemUpdateView.tsx` | `7891b6b533075acb` |
| `deploy/compose.prod.yml` | `c0cb2bf1e6d17a02` |
| `deploy/install-updater.sh` | `dfc2b337e182b3ac` |
| `.github/workflows/release.yml` | `afede6cc252b78f1` |
| `docs/release.md` | `13f55ef8d2316e78` |

本轮新增的验证脚本（本段所有证据均由这些版本产生）：

| 脚本 | sha256（前 16 位） |
|---|---|
| `e2e/run_u1_upgrade.py` | `0680cb9cf612684b` |
| `e2e/run_u1_admin_browser.py` | `56f44765ffe97e4c` |
| `e2e/u1_engine_boundaries.mts` | `4ad90a9cb02ed69a` |
| `e2e/reverify_u1_defects.py`（t12 复验） | `eab67b60600bae27` |
| `e2e/check-release-workflow.py`（t5 入库，本轮复跑） | `23261294e92421fd` |

环境：macOS，Node v22.23.2，pnpm 11.23.0，Docker 29.5.3 / Docker Compose v5.1.4，Chromium（Playwright 1.58，`channel=chrome`），Python 3.10.10。

### 2. 门禁与 verify 命令（全部由验证者在本轮重新真实运行）

| 命令 | 真实退出码 | 观察到的输出（节选） |
|---|---|---|
| `pnpm -r build` | **0** | updater/server/admin/web/examples 全部 Done |
| `pnpm -r typecheck` | **0** | 8 个 workspace 项目 Done |
| `pnpm -r lint` | **0** | updater 24 files、admin 11 files 无 error；server 34 files `Found 19 warnings. Found 1 info.`（既有风格项，0 error）；web `eslint .` Done |
| `pnpm -r test` | **0** | server `12 passed (12) / 206 passed (206)`（含 `system-update.test.ts`）、updater `8 passed (8) / 69 passed (69)`、web `13 passed (13) / 145 passed (145)` |
| `pnpm --filter @feedback/updater test` | **0** | `Test Files 8 passed (8)`、`Tests 69 passed (69)` |
| `pnpm --filter @feedback/updater build/typecheck/lint`（t3 声明） | **0 / 0 / 0** | 逐条重跑均 exit 0 |
| `bash -n deploy/install-updater.sh`（t4 声明） | **0** | 无语法错误 |
| `docker compose -f deploy/compose.prod.yml --env-file deploy/.env.prod config -q`（t4） | **0** | 配置校验通过 |
| `docker compose … config --services`（t4） | **0** | 输出 `feedback` / `updater` |
| `python3 e2e/check-release-workflow.py`（t5 入库 harness） | **0** | `共 47 项断言，通过 47，失败 0`；被测 `release.yml` sha256=`afede6cc…af91` |
| `python3 e2e/run_u1_upgrade.py` | **0** | `137/137 项断言通过`，6/6 场景 OK（第 3 节） |
| `python3 e2e/run_u1_admin_browser.py` | **0** | `39/39 项断言通过`（第 5 节） |
| `npx tsx e2e/u1_engine_boundaries.mts`（补充，进程内真实引擎） | **0** | `33 项通过，0 项失败`（第 4 节） |

`deploy/.env.prod` 是本机已有的测试值文件（gitignored，不入库），只用于 `compose config` 校验；本轮未使用任何生产账号或真实数据。

### 3. 容器级真实升级：`e2e/run_u1_upgrade.py`

夹具（自建，独立于 `apps/updater/e2e/run-local-update.sh`）：每个场景一个**独立 compose 项目 / 独立网络 / 独立数据卷 / 独立宿主端口**，部署目录固定在 `/private/tmp/u1v-runs/<场景>-<随机>`（Docker Desktop 共享目录）；外部依赖（AI / Kaneo）由本脚本自建的 mock HTTP 服务提供（随机端口，容器经 `host.docker.internal` 访问），**不复用** `e2e/mock-external.mjs`（避免与其它进程抢 8898/8899）。复制数据卷、切换镜像、改写 `paused`/`release`/任务文件**全部由 updater 容器自己完成**，脚本只读证据并断言。

镜像来源（如实说明）：

| 角色 | 来源 | 镜像 ID | 本轮 registry digest |
|---|---|---|---|
| 旧版 | 本机已有的**旧源码产物** `feedback-service:e2e-verify`（2 天前构建，DB `PRAGMA user_version=2`、无 `daily_usage` 表） | `7b8d7df4d0a0` | `sha256:00827060424c150b3ce2b5bfe3b285d54e8bf719c2320e3494fdf3bd79211cd2` |
| 新版 | 从**当前工作树**真实构建 `u1v-feedback:0.3.0`（`docker build -f Dockerfile`，label `org.opencontainers.image.version=0.3.0`、`revision=cd79673768d93a23facb8ee370fe24ee2c2323b2`） | `190671d778e5` | `sha256:0395096304a2cad4f4240532bb44f0613d6c76f6b0fbb772d034a975149101ef` |
| broken | `FROM u1v-feedback:0.3.0` + 恒失败 HEALTHCHECK + `CMD sleep`（只用于「⑤核验新版失败」场景，版本标签仍是 0.3.0） | `70940750dd80` | `sha256:729c56b0db0f4cba2174c39e030ef6d40f74d5569a5c1765a58a0be20681f4fd` |
| updater | `docker build -f apps/updater/Dockerfile` | `43a630c78f79` | 经本地 registry 推送 |

compose 夹具形状对齐 `deploy/compose.prod.yml`（feedback + updater 两个服务、外部卷、控制目录只读挂载、updater 挂私有 socket 且**不发布端口**），但允许 HTTP（生产 compose 强制 `FEEDBACK_PUBLIC_URL` + `COOKIE_SECURE=true`，见第 8 节限制）。

场景结果（`e2e/shots/u1/upgrade-report.json`，`passed=137/137`）：

| 场景 | 用时 | 覆盖与关键断言 |
|---|---|---|
| A `happy_path` | 17.4s | 旧版真实数据（1 账号 + 2 条反馈 + 加密连接配置，schema v2）→ 提交升级 → **暂停窗口**（`/api/feedback` 写被拒 `503 update_paused`、读仍放行、后台能读到真实 `paused` 标记、mock 侧归档/AI 调用计数**零增长**）→ 六阶段全过 → 运行中容器 digest = 清单 digest、版本标签 0.3.0、挂载**新**卷、`release` 标记指向新版本+新卷、`paused` 已解除、环境文件只改两行（主密钥逐字节保留）、旧卷/旧镜像保留、新卷数据不少于基线（`daily_usage` 由迁移新建）、`ai.apiKeyEnc` 仍为 `v1` 形态；**幂等**（同 requestId 重发返回原 operationId + `deduplicated:true`）与**并发 409**；放行后写接口恢复 201 且新提交的反馈在新版中可读（归档链路真实调用 mock）；无关容器/卷未被改动；updater 日志无令牌 |
| B `verify_failure` | 160.0s | 新版**故意不可用**（broken 镜像）→ ⑤核验失败 → `failed_restored`、`restore.confirmed=true`；运行中容器回到**旧镜像 + 未修改的原卷**、旧服务真实可用、环境文件还原、**新卷保留未删除**、`paused` 解除 |
| C `release_failure` | 137.1s | ⑤核验通过（以证据落盘为触发点）后**立即制造新版不可用** → ⑥放行确认失败 → `needs_attention`、`restore=null`（**绝不回退原卷**）、环境文件仍指向新镜像+新卷、数据仍在当前（新）卷且完整、新旧卷都保留、给出人工处理指引、无关容器与卷未被改动 |
| D `fast_rejects` | 7.4s | 清单缺失 → 409 `manifest_missing`；协议不兼容 → 409 `updater_protocol_incompatible` + 升级执行器指引；多余字段（`composeFile`）→ 400 `invalid_request`；版本不符 → `failed_no_changes/version_mismatch`；digest 不符 → `failed_no_changes/digest_mismatch`；镜像拉不动 → `failed_no_changes/pull_failed`；以上全程旧服务未被停、未留 `paused`/`release`、未创建任何新卷 |
| E `env_modified` | 8.9s | 任务推进到 ③ 时由「其它工具」改写 `.env.prod` → ④拒绝覆盖 `env_file_changed` → `failed_restored`；环境文件保持「更新前内容 + 外部那一行」（执行器未改写它）、镜像仍是旧镜像、旧服务可用 |
| F `updater_restart` | 9.1s | ②刚写 `paused` 就重启 updater 容器（真实 `docker restart`）→ 启动时**重启核对**：确认旧服务运行、解除暂停、任务落 `failed`/`failed_restored`，证据链含「重启核对」，环境文件仍是旧镜像，旧卷数据完好 |

### 4. 进程内真实引擎边界：`e2e/u1_engine_boundaries.mts`（33 项断言，exit 0）

直接驱动**真实** `UpdateEngine`（真实阶段机、真实任务/标记落盘、真实失败与恢复分支），只把 docker 端口换成可编程假实现（夹具只模拟 docker 的观察结果与故障，**不代替执行器**做复制、换镜像或状态转换）。覆盖容器级成本过高或不可构造的边界：

| 场景 | 断言 |
|---|---|
| S1 磁盘空间 1.2 倍边界 | 可用空间**恰好** `ceil(size×1.2)` 时空间检查通过；**少 1KB** 即 `insufficient_space` + `failed_no_changes`，不创建/复制新卷 |
| S2/S3 停服异常 | 退出码 7 → `stop_abnormal_exit`（不做备份复制）；OOM → `stop_oom_killed`；两者都尝试恢复并确认旧版本 |
| S4 复制失败 | `copy_failed`（复制抛错）/ `copy_verify_failed`（条目缺失）→ `failed_restored`；**新卷保留**，执行器从未调用卷删除 |
| S5 目标新卷已存在 | `volume_exists`（拒绝覆盖），未执行复制 |
| S6 清单协议不兼容 | `updater_protocol_incompatible` + `failed_no_changes`，未拉取镜像 |
| S7 ⑤核验新版失败 | `failed_restored` + `restore.confirmed`，环境文件还原为旧镜像，新卷保留，`paused` 解除 |
| S8 ⑥放行后失败 | `needs_attention`、`restore=null`、放行标记已落盘、新卷与旧卷都在 |

### 5. 管理页「系统更新」真实浏览器：`e2e/run_u1_admin_browser.py`（39 项断言，exit 0）

做法：真实反馈服务（`tsx` 启动，全新 data/控制目录 + 600 令牌文件）托管真实管理页产物（`apps/admin/dist`），`FEEDBACK_UPDATER_URL` 指向本脚本自建的**可控 updater 桩**（服务端→执行器协议是真实代码路径；桩只决定清单内容、任务进度与是否可达）。Chromium 真实点击覆盖：

- **检查更新**：真实 `POST /api/admin/system/update/check` → 桩收到真实 `x-updater-token`；页面显示「已获取最新版本信息」、可更新版本号、「可更新」标记、协议兼容行；未检查前「更新到最新稳定版」禁用。
- **提交更新**：真实 `POST /api/admin/system/update` → 「更新任务已受理：<operationId>」、进度卡显示任务 ID、`operationId` 写入 `localStorage`；请求体**只含** `requestId/version/digest`。
- **进度显示**：桩推进阶段 → 页面 2s 轮询刷新阶段文案（「③保留备份并复制」/「更新进行中」/ `update_paused` 说明）。
- **服务重启期间**：杀掉真实服务进程 → 页面显示「正在恢复连接…」并明确「**不算**更新失败」；未把不可达判成任务失败、未丢失已跟踪的任务 ID；服务恢复后提示消失并继续显示同一任务。
- **刷新恢复**：`page.reload()` 后仅凭 `localStorage` 里的任务 ID 自动恢复进度卡（无需再点任何按钮）。
- **真实暂停标记**：在控制目录写真实 `paused`（含 `phase=verify_new`）→ 页面出现「业务写入已暂停」+ 阶段说明 +「（当前阶段：⑤核验新版）」。
- **终态**：桩置 `succeeded` → 页面显示「更新成功」。
- **网络异常不谎报**：桩清单不可用 → 「检查失败」+「不影响正在运行的服务」。
- **停止跟踪** → 「已停止在本页跟踪该任务」+ `localStorage` 清空。
- **手机视口 390x844**：进度卡与任务 ID 可见、无横向溢出。
- **回归断言**（第 7 节缺陷 1）：页面「当前版本」必须是真实包版本 `0.3.0`，且**不得**出现 `0.0.0-unknown`。
- 服务端日志不含共享令牌明文。

截图：`e2e/shots/u1/browser/*.png`（`01-tab-initial`、`02-check-result`、`03-accepted`、`04-progress`、`05-recovering`、`06-recovered`、`07-after-reload`、`08-paused-banner`、`09-succeeded`、`10-forgotten`、`11-mobile`），机读报告 `e2e/shots/u1/browser-report.json`。

### 6. 发布流水线静态契约与版本一致性

- **流水线**：`python3 e2e/check-release-workflow.py` → `47/47` 断言通过（exit 0），覆盖：YAML 解析、`contents: write` 只授予最后公开 Release 的 job、`ci.yml` 的 `workflow_call`/secrets-guard/node-checks/flutter-checks 保留、渠道判定（预发布标签→`prerelease` 不产出稳定清单；标签名非法→构建前失败）、两份 digest 记录与校验、清单生成器的 7 类失败路径、清单字段与冻结契约一致、生成的清单被 `apps/updater` **真实解析器** `parseManifest` 接受、`dbSchemaVersion` 与源码迁移常量一致（`[2,3] → 3`）、release job 本地产物校验（含 `sha256sum -c` 与篡改检测）、远端资产齐全才公开。被测 `release.yml` sha256=`afede6cc…af91`。
- **版本一致性**：根 `package.json` / `apps/server` / `apps/admin` / `packages/web` 均为 **0.3.0**；`apps/updater` 为 **0.1.0**（与反馈服务版本解耦，镜像内编译期常量 `UPDATER_VERSION=0.1.0`）。协议版本三处一致：`apps/server/src/env.ts` 的 `SUPPORTED_UPDATER_PROTOCOL=1`、`apps/updater/src/version.ts` 的 `UPDATER_PROTOCOL_VERSION=1`、`deploy/compose.prod.yml` 的 `UPDATER_PROTOCOL_VERSION: "1"`；清单 `manifestVersion=1`、`requiredUpdaterProtocol=1`。
- **镜像名一致**：`deploy/compose.prod.yml` 的 `FEEDBACK_IMAGE`/`UPDATER_IMAGE`/`UPDATER_IMAGE_NAME` 与 `docs/release.md`、`apps/updater/README.md` 里的 `ghcr.io/sakuralovesmile/sakura-feedback` 与 `…-updater` 一致；清单 `services.feedback.image`+`digest`、`services.updater.image`+`digest` 与执行器解析要求一致。

### 7. 缺陷（t10 发现 → t11 修复 → t12 复验通过：**已修复并复验**）

| # | 缺陷（t10 发现时） | 复现证据 | 影响 | 处置与回归断言 |
|---|---|---|---|---|
| 1 | 生产镜像里后台「当前版本」恒为 `0.0.0-unknown` | `docker run u1v-feedback:0.3.0` → 管理员登录 → `GET /api/admin/system/update` → `current.version="0.0.0-unknown"`；`readPackageVersion()` 从模块目录向上 3 层找 `package.json`，镜像布局 `/app/server/dist/routes/` 向上 3 层是 `/app/`（无该文件），实际在 `/app/server/package.json` | 后台「当前版本」在真实部署里不可用（U1 的核心可观测信息之一） | **t11 修复**（候选路径解析）。本段回归：容器级「生产镜像里后台当前版本 = 0.3.0」；浏览器级「当前版本显示为真实包版本 0.3.0 且无 0.0.0-unknown」 |
| 2 | `deploy/compose.prod.yml` 注入的 `FEEDBACK_UPDATER_URL` 被服务端忽略（`env.ts` 只读 `FEEDBACK_UPDATE_URL`） | 只按 compose 方式注入 `FEEDBACK_UPDATER_URL=<桩地址>` 启动服务 → `config.updaterBaseUrl="http://updater:8790"`（默认值），检查更新直接 `updater_unreachable`；`docs/api.md` 写的也是 `FEEDBACK_UPDATE_URL` | 真实部署里改这个变量不会生效（静默忽略）；默认值恰好等于 compose 默认值，只在改地址/端口时暴露 | **t11 修复**（`FEEDBACK_UPDATER_URL` 规范名 + 旧名 `FEEDBACK_UPDATE_URL` 作别名）。本段回归：探针服务只注入 compose 名 → 断言被采纳 |

> 两条缺陷均按契约「回传队长处理」，由实现者在 t11 修复；验证者未修改实现。本节记录的是**同一条最终源码**上的回归断言（若将来回归，脚本会直接失败）。

**t12 独立复验（缺陷发现者用 t10 的原始复现步骤重跑，不接受实现者自证）**

复验脚本：`e2e/reverify_u1_defects.py`（sha256 `eab67b60600bae27…`），报告 `e2e/shots/u1/reverify-defects.json` —— **10/10 断言通过，exit 0**；镜像用当前工作树按与 t10 相同的命令重建。

| 项 | 复验步骤（与 t10 相同） | 本轮实际观测 | 判定 |
|---|---|---|---|
| 缺陷 1 | `docker run` 新镜像（真实容器布局）→ 管理员登录 → `GET /api/admin/system/update` | `current.version = "0.3.0"` == `apps/server/package.json` 的 version；镜像内 `/app/server/package.json`（623B，`name=@feedback/server`）与 `/app/server/dist/routes/system-update.js` 并存 | **已修复** |
| 缺陷 2 | **只**注入 compose 规范名 `FEEDBACK_UPDATER_URL=<stub>`（不注入别名）→ 同接口 | `config.updaterBaseUrl = "<stub 地址>"`（采纳，不再是默认 `http://updater:8790`），`updateConfigured=true` | **已修复** |
| 反向回归 1 | 不注入任何更新地址变量 | `config.updaterBaseUrl = "http://updater:8790"`（缺省仍回退默认） | 通过 |
| 反向回归 2 | 只注入旧别名 `FEEDBACK_UPDATE_URL=<stub>` | 同样被采纳（兼容别名保留） | 通过 |
| 反向回归 3 | tsx 直跑源码布局：`tsx -e 'import { SERVER_VERSION } …'` | `SERVER_VERSION = "0.3.0"`（exit 0） | 通过 |

配套 verify（本轮实跑）：`pnpm --filter @feedback/server test` → exit 0，`12 passed (12) / 206 passed (206)`，其中 `system-update.test.ts` **45 tests**（t11 新增 12 个版本/环境变量用例）；`pnpm -r build` → exit 0；`python3 e2e/run_u1_admin_browser.py` → exit 0，`39/39` 断言（含「当前版本显示为真实包版本 0.3.0（回归：曾显示 0.0.0-unknown）」与「FEEDBACK_UPDATER_URL 被服务端采纳」）。

复验结论：**两条缺陷的修复真实生效，且未引入回归**；`e2e/shots/u1/upgrade-report.json` 与 `browser-report.json` 的 `defects` 字段已把这两条标为 `fixed` 并附上本轮命令、观测输出与报告路径（原始观测与发现时间保留，未被改写）。若将来任一缺陷复现，第 3/5 节的硬断言与本节复验脚本会直接失败。

**时间线（如实留档，原始证据未被改写）**：

| 时刻（2026-09-14） | 事件 | 当时观察 |
|---|---|---|
| ~14:50 | 验证者按当时源码构建新版镜像 `u1v-feedback:0.3.0`（镜像 ID `de309bb1d6a4`） | — |
| ~15:00–15:05 | 验证者首次跑容器/浏览器流程 | **两条缺陷红**：容器内 `current.version="0.0.0-unknown"`；只注入 `FEEDBACK_UPDATER_URL` 时 `config.updaterBaseUrl="http://updater:8790"`（默认值），检查更新 `updater_unreachable` |
| ~15:05 | 验证者把两条缺陷证据回传队长（未改实现） | 队长据此开出 t11 |
| 15:11 | t11（server-engineer）改动 `apps/server/src/env.ts`、`apps/server/src/routes/system-update.ts`、`apps/server/test/system-update.test.ts`、`docs/api.md` | 两条缺陷修复（规范名 + 别名回退；候选包路径） |
| 15:32–15:33 | 验证者重建镜像（新镜像 ID `190671d778e5`）并重跑浏览器流程 | **两条转绿**：`FEEDBACK_UPDATER_URL` 被采纳；页面「当前版本 0.3.0」、无 `0.0.0-unknown` |
| 15:34–15:40 | 验证者在**同一条最终源码**上重跑 13 条 verify + 容器级 6 场景 + 进程内边界 | 全绿（137/137、39/39、33/33） |
| 15:49 | **t12 复验**（verifier，用 t10 原始复现步骤重建镜像） | 两条缺陷 **10/10 断言转绿**：容器内 `current.version=0.3.0`、只注入 `FEEDBACK_UPDATER_URL` 即被采纳；反向回归（缺省默认值 / 旧别名兼容 / tsx 源码布局）全部通过 |

所以第 7 节表格里的「红」是**发现时刻的真实状态**，「绿」是 t11 修复后的回归结果——两者不是同一份源码。t12 已按**原始复现步骤**（注入口径：只设 `FEEDBACK_UPDATER_URL`、不设别名；版本口径：真实容器内管理员登录后读 `GET /api/admin/system/update`）完成复验：两条缺陷均判为**已修复**，且反向回归通过（见本节「t12 独立复验」）。

工具自身的缺陷（记录在案，已修）：验证脚本的 `wait_until` 最初把「异常」当成真值返回，会让等待静默失效（曾导致一次假通过）。已修正为「异常不算满足、超时抛出并带上最后一次观察」，两个 Python 脚本均已更新。

### 8. 未验证 / 限制（如实标注，不得读作已通过）

- **本机无法验证的部分**：GitHub Actions 的真实运行、GHCR 推送与真实镜像 digest、线上正式地址（域名 + TLS + Nginx）、在真实服务器上首次安装 Compose（`deploy/install-updater.sh` 的真实执行）——**全部未验证**，一律不得声称已上线。
- 容器级测试用的是**本地自建 registry + 本地构建镜像**（`127.0.0.1:<随机端口>`），不是 GHCR 上的发布产物；旧版镜像是本机已有的旧源码产物（`feedback-service:e2e-verify`），不是正式发布的 v0.2.x 镜像。
- 容器夹具是**自建 compose**（形状对齐 `deploy/compose.prod.yml`）且走 **HTTP**；生产 compose 强制 `FEEDBACK_PUBLIC_URL` + `FEEDBACK_COOKIE_SECURE=true`（HTTPS/反代形态）**未验证**。
- 「磁盘空间不足」只验证了 **1.2 倍边界**（进程内真实引擎 + 可编程 docker），**没有**做真实磁盘耗尽；停服异常/复制失败/卷已存在/协议不兼容/放行后失败同样在进程内真实引擎上跑（容器级跑了第 3 节 6 个场景）。
- 未做真实并发（多副本/多客户端同时点击）与真实 15 分钟限流窗口恢复；幂等与 409 是单进程内的串行验证。
- 浏览器只覆盖 **Chromium**；视口只覆盖桌面 1280x800 与手机 390x844。
- updater 挂载 `/var/run/docker.sock` = 宿主管理员权限（设计如此，见 `apps/updater/README.md` 安全边界）；本轮**未**做权限隔离/恶意客户端验证。
- 本轮容器级场景结束后清理了自己创建的容器/网络/卷（**保留**部署目录、任务文件、updater 日志等诊断产物于 `/private/tmp/u1v-runs/<场景>-<随机>/`）；测试身份、卷、端口均为本轮新建，未使用生产账号或真实数据。

### 9. 发布前置条件（需用户确认，验证者一律不执行）

1. **打标签**：`v0.2.1`（T2-A）与 `v0.3.0`（U1）标签**需用户确认后**才可创建并推送；标签必须指向本次运行提交且严格等于 `v<根 package.json version>`（见 `docs/release.md` 的 4 条件）。
2. **推镜像**：GHCR 的两个镜像（`sakura-feedback`、`sakura-feedback-updater`）由 Release 流水线推送；本机未推送任何镜像。
3. **服务器首次安装**：`deploy/install-updater.sh --deploy-dir <部署目录>` 的首次接入（登记既有数据卷、生成 600 令牌、备份既有 compose/env）**未在真实服务器执行过**。
4. **正式地址验证通过前不声称已上线**：只有用户按第 11 节在真实部署上体验并确认后，才可把 T2-A / U1 从「待体验」改为「已验收」。
5. 生产 compose 需要用户环境提供 `FEEDBACK_PUBLIC_URL`（HTTPS 域名）、`FEEDBACK_DATA_VOLUME`（既有卷名）、`FEEDBACK_BIND`、`UPDATER_IMAGE` / `UPDATER_IMAGE_NAME` / `UPDATER_DEPLOY_DIR` 等（见 `deploy/.env.prod.example` 与 `deploy/README.md`）。

### 10. 诊断产物与复跑命令

```bash
# 容器级真实升级（6 场景，含 ⑤核验失败→恢复旧版本、⑥放行后失败→needs_attention、更新中重启核对）
python3 e2e/run_u1_upgrade.py                       # 退出码 0 为通过；报告 e2e/shots/u1/upgrade-report.json
python3 e2e/run_u1_upgrade.py --only happy_path     # 单场景复跑

# 管理页「系统更新」真实浏览器（真实服务 + 可控 updater 桩 + Chromium）
python3 e2e/run_u1_admin_browser.py                 # 退出码 0 为通过；报告 e2e/shots/u1/browser-report.json

# 进程内真实引擎边界（磁盘 1.2 倍、停服异常、复制失败、放行后失败等）
npx tsx e2e/u1_engine_boundaries.mts

# 发布流水线静态契约（t5 入库）
python3 e2e/check-release-workflow.py

# t12 复验：两条历史缺陷（版本读取 / FEEDBACK_UPDATER_URL 采纳）的修复是否仍生效
python3 e2e/reverify_u1_defects.py
```

证据文件：`e2e/shots/u1/upgrade-report.json`、`e2e/shots/u1/browser-report.json`、`e2e/shots/u1/browser/*.png`、`/private/tmp/u1v-runs/<场景>-<随机>/`（含 `.env.prod`、`compose.yml`、`update-control/state/tasks/*.json`、备份目录）。首次复跑会自动构建缺少的镜像（`u1v-feedback:0.3.0`、`u1v-updater:verify`、`u1v-feedback-broken:0.3.0`）。

### 11. 体验入口与操作步骤（U1 = 待体验）

**服务器首次接入（需用户执行，验证者未做过）**

```bash
# 1) 部署目录（示例：/opt/1panel/docker/compose/feedback），放 compose.yml 与 .env.prod
cp deploy/compose.prod.yml /opt/1panel/docker/compose/feedback/compose.yml
cp deploy/.env.prod.example /opt/1panel/docker/compose/feedback/.env.prod   # 填 MASTER_KEY / 域名 / 两个 digest / 卷名
# 2) 首次接入：核对运行中的部署 → 生成 600 令牌 → 登记既有数据卷（只登记不创建）
bash deploy/install-updater.sh --deploy-dir /opt/1panel/docker/compose/feedback
# 3) 起服务
cd /opt/1panel/docker/compose/feedback && docker compose --env-file .env.prod up -d
```

**体验要点（与验收一致）**

1. 打开 `https://<域名>/admin/` → 管理员登录 → 顶部「**系统更新**」标签：应显示「当前版本 0.3.0」、更新执行器「已接入」。
2. 点「**检查更新**」：应显示最新稳定版与「可更新」标记（若已是最新则显示「当前已是最新稳定版」）。
3. 点「**更新到最新稳定版**」：页面出现「更新任务」卡与阶段进度；更新期间业务写入会被拒（`update_paused`），页面顶部出现「业务写入已暂停」横幅。
4. **服务重启期间**（后台代理会短暂取不到进度）：页面显示「**正在恢复连接…**」并明确说明这**不算**更新失败——不要把它当成失败。
5. 更新完成后显示「更新成功」；刷新页面或关掉标签再打开，仍会按任务 ID 恢复进度（`localStorage`）。
6. 失败语义：预检失败显示「更新失败，未改动部署」；⑤核验失败显示「更新失败，已恢复旧版本」（旧数据卷与旧镜像都保留）；⑥放行后失败显示「需要处理」并给出恢复指引（**不会**自动回退数据卷）。
7. 磁盘与卷：新数据卷命名为 `feedback-data-<版本>-<时间戳>`，旧卷作为完整备份保留、**不会**被自动删除；升级后请人工确认无误再自行清理。

## Flutter 安全存储兼容（flutter_secure_storage 9.2.2 / 10.3.1 / 11.0.0，2026-09-14 · 状态：待体验）

> 本轮由验证者（verifier，任务 t5）独立执行。用户要求两次收敛验证成本，最终范围见 §0；
> 收敛前已完成的独立矩阵与 macOS Keychain 运行时验证结果作为附录保留（§11），并明确标注
> 它们**不在最终收敛范围内**。所有命令、退出码、结构化产物均为本轮真实运行结果，不复用实现者结论。

### 0. 最终验证范围（用户要求「再砍一刀」后的收敛结果）

| 项目 | 是否做 | 说明 |
| --- | --- | --- |
| 静态核对（依赖 / 接口 / 存储键） | 做 | §3，git diff + 就地读符号定义 |
| 三档解析结论核对 | 只读证据，不重跑矩阵 | §4；9.2.2 与 11.0.0 采信实现者证据 |
| 矩阵脚本复跑 | 于收敛前执行过一次（exit 0），收敛后未再跑 | §2 命令 7 |
| Android 9→10→11 迁移实测 | 做（本任务唯一重型项） | §6，真实模拟器 + 真实 APK + 相同签名升级 |
| macOS / iOS | 只做构建 | §7；**未做 Keychain 运行时验证** |
| Windows / Linux | 不做 | 不在原生范围；不建任何阻塞条目 |

环境事实：Flutter 3.41.3 / Dart 3.11.1 在 `$HOME/flutter`（不在 PATH）；Xcode 27.0；
Android SDK 在 `~/Library/Android/sdk`（有 `platforms/android-37.0`，但 `ANDROID_HOME`/`ANDROID_SDK_ROOT` 未设置，需显式指定）；
`jenv` shim 损坏（`which java` 直接报错），可用 JDK 为 `/opt/homebrew/opt/openjdk@17`（17.0.20）。

### 1. 源码状态（只读快照，`git rev-parse HEAD` = cd79673）

```
 M flutter/feedback/pubspec.yaml                      （约束一行 + 注释）
 M flutter/feedback/test/token_store_scope_test.dart  （+32 行：读/写/删除往返、重复删除幂等）
?? flutter/feedback/test/host_credential_coexistence_test.dart （新增，4 例）
```

- `git diff -- flutter/feedback/lib` 输出 **0 行**，`git diff --name-only -- flutter/feedback/lib` 为空 → 组件库零改动。
- `lib/src/config.dart`、`lib/src/token_store.dart`、`lib/src/widget.dart`、`lib/feedback_widget.dart`、`lib/src/platform_io.dart` 逐个与 HEAD 一致。
- 关键符号仍在原位（就地读取）：`class FeedbackConfig`（config.dart:49）、
  `abstract class FeedbackTokenStore` + `read()`/`write()`/`clear()`（token_store.dart:9/11/14/17）、
  `String feedbackTokenStorageKey(FeedbackConfig)`（token_store.dart:32）、`class FeedbackWidget`（widget.dart:84）。
- 组件对插件只用三版共有的 `read` / `write` / `delete`（`platform_io.dart:31/35/38`），
  组件包约束为 `flutter_secure_storage: '>=9.2.2 <12.0.0'`（pubspec.yaml:20），
  `environment` 保持 `sdk: ^3.6.0` / `flutter: ">=3.27.0"` 未动。

### 2. 命令与真实退出码（本轮实际运行）

产物目录：`e2e/flutter_native/out/verify/`（`exitcodes.tsv` 汇总）。

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `cd flutter/feedback && flutter analyze && flutter test` | 0 | `+112: All tests passed!`（112 例） |
| 2 | `cd examples/flutter && flutter test` | 0 | `+37: All tests passed!` |
| 3 | `cd examples/flutter && flutter build apk --debug` | 0 | `✓ Built build/app/outputs/flutter-apk/app-debug.apk` |
| 4 | `cd examples/flutter && flutter build macos --release` | 0 | `✓ Built build/macos/Build/Products/Release/feedback_example.app (43.2MB)` |
| 5 | `cd examples/flutter && flutter build ios --no-codesign` | 0 | `✓ Built build/ios/iphoneos/Runner.app (16.9MB)` |
| 6 | `security find-identity -v -p codesigning` | 0 | `1 valid identities found`：`Apple Development: 13562008871@163.com (53J98NU8CJ)`（TeamIdentifier `C5Q966MAGT`） |
| 7 | `bash tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0` | 0 | 三档全 PASS（收敛前执行，之后未再跑） |
| 8 | 契约中的 `grep -rn "dependency_overrides" <三个 pubspec> ; test $? -eq 1` | **1（不通过）** | grep 命中 `tools/flutter-storage-matrix/pubspec.yaml:25` 的**注释**行；见 §8-F1 |

### 3. 静态核对（两条关键声明）

1. **全仓不存在 dependency_overrides（实质成立）**：排除 `node_modules` / `build` / `.dart_tool` 后，
   对 `*.yaml/*.yml/*.lock/*.dart` 扫描 `dependency_overrides`，命中项**全部是注释或文档文本**：
   `tools/flutter-storage-matrix/pubspec.yaml:25`（注释）、`tools/flutter-storage-matrix/lib/feedback_storage_matrix.dart:8`（文档注释）、
   `.github/workflows/ci.yml:111`（job 名称说明）、`e2e/flutter_matrix/host/pubspec.yaml:18` 及其工作副本（本轮验证宿主自建的注释）。
   只匹配「行首真实声明 `dependency_overrides:`」时**无任何匹配**（grep exit 1）。
   ⚠️ 但契约里写的字面命令（把 `tools/flutter-storage-matrix/pubspec.yaml` 也纳入 grep）会因上述注释命中而 exit 1 → 见 §8-F1。
2. **接口与存储键未改动**：见 §1（`flutter/feedback/lib` 零 diff；符号定义逐条与 HEAD 一致）。

### 4. 三档解析结论核对（只读实现者证据，未重跑）

`tools/flutter-storage-matrix/out/matrix-summary.tsv`：

| 档位 | Dart | flutter_secure_storage | windows | platform_interface | darwin | pub_get | analyze | test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9.2.2 | 3.11.1 | 9.2.2 | 3.1.2 | 1.1.2 | - | 0 | 0 | 0（PASS） |
| 10.3.1 | 3.11.1 | 10.3.1 | 4.2.2 | 2.1.0 | 0.3.2 | 0 | 0 | 0（PASS） |
| 11.0.0 | 3.11.1 | 11.0.0 | 4.2.2 | 2.1.0 | 0.4.2 | 0 | 0 | 0（PASS） |

逐档 `out/<tier>/resolved.json` 的 `resolved` 与 `checks`（全部 `ok=true`）核对：

- **9.2.2**：`flutter_secure_storage_macos=3.1.3`、`windows=3.1.2`、`platform_interface=1.1.2`（linux 1.2.3 / web 1.2.1），**无 darwin** → 走 `_macos`。
- **10.3.1**：`darwin=0.3.2`、`windows=4.2.2`、`platform_interface=2.1.0`（linux 3.0.3 / web 2.1.1），**无 `_macos`**。
- **11.0.0**：`darwin=0.4.2`、`windows=4.2.2`、`platform_interface=2.1.0`（linux 3.0.3 / web 2.1.1），**无 `_macos`**。

**结论：「darwin 取代 `_macos`」「windows 3.x→4.x」「platform_interface 1.x→2.x」都从 10.3.1 档就发生，不是 11 才发生** ——
与 t2 的实测修正一致，summary 表属实。10.3.1 这一档（既非旧锁 9.2.4 也非新锁 11.0.0）已单独逐项手工复核。

**诚实标注：本轮按契约要求不重跑矩阵，因此 9.2.2 与 11.0.0 两档的解析结论属「采信实现者证据」；只有 10.3.1 一档被逐项读过 resolved.json 复核。**
（收敛前本人另建的独立宿主 `e2e/flutter_matrix` 曾独立复现过三档，见 §11 附录，但那不在最终收敛范围内。）

### 5. Android 可行性探针（限时，结论：可行）

| 检查 | 结果 |
| --- | --- |
| 指定 `ANDROID_HOME=~/Library/Android/sdk` 后能否构建 APK | 可以：`flutter build apk --debug` exit 0（示例与测试应用均成功） |
| JDK | `jenv` shim 损坏（`which java` 报 `No such file or directory`）；显式用 `/opt/homebrew/opt/openjdk@17`（17.0.20）后 Gradle 正常 |
| 模拟器/设备 | 模拟器 `sakura_test`（android-35 google_apis arm64）可启动并 `sys.boot_completed=1`；`adb` 可用；无 Android 真机 |

→ 探针判定**可行**，因此继续执行 §6 的迁移实测（未出现需要判「未通过」的分支）。

### 6. Android 9→10→11 迁移实测（真实模拟器 + 真实 APK，本任务唯一重型项）

**独立测试应用**：`e2e/flutter_native/keychain_probe`（`flutter create --org com.feedbackverify`），
`applicationId = com.feedbackverify.keychain_probe`，逐档只改 pubspec 的 `flutter_secure_storage` 为精确版本后重新构建。

**方法（为什么不用 `flutter test integration_test -d <android>`）**：`flutter test` 在跑完后会**卸载应用**，
跨档数据（正是迁移要验证的东西）无法保留。因此改为：

```
flutter build apk --debug --dart-define=PHASE=<阶段> …   # 阶段编译进 APK
adb install -r -t app-debug.apk                          # 同签名升级安装，保留数据
adb shell am start -n com.feedbackverify.keychain_probe/.MainActivity   # 真实应用进程
adb shell run-as com.feedbackverify.keychain_probe cat code_cache/probe-<tag>.json  # 结构化结果
```

探针走的是组件在原生平台的**真实存储路径**（`feedback_widget/src/platform_io.dart` 的 `SecureFeedbackTokenStore`），
并同时用同一安全存储写入模拟的宿主凭据（音乐服务器密码 `music_subsonic_password` + 第三方令牌 `third_party.access_token`），
用于验证清理不越界。**不接触用户真实凭据**，测试密钥均为字面测试值。

**签名**：`~/.android/debug.keystore`（SHA256 `B2:BB:48:10:EC:00:74:FE:6E:23:41:68:9F:DE:03:75:5F:5B:E7:56:7D:77:9D:2C:CE:9D:93:18:D0:FC:7A:8D`）；
逐档 `dumpsys` 记录的 `signatures=[db13ec38]` 相同、`versionName=0.1.0`、`minSdk=24` → 三档都是**同一应用标识 + 同一签名**的升级安装。

**结果（`e2e/flutter_native/out/native/android-mig-*.result.json`，全部 verdict=PASS）**：

| 阶段 | 档位 | 结果 | 关键字段 |
| --- | --- | --- | --- |
| 写入测试令牌（登录保存） | 9.2.2 | PASS | `written/readBack=token-android-v9`，`readBackDelayed=token-android-v9`（退出前停留 5s 复读） |
| 读取 9 档写入的令牌（迁移是否完成） | 10.3.1 | PASS | `expected=token-android-v9`，`readBack=token-android-v9` |
| 再写入 10 档自己的令牌 | 10.3.1 | PASS | `written/readBack=token-android-v10` |
| 读取 10 档写入的令牌 | 11.0.0 | PASS | `expected/readBack=token-android-v10` |
| 删除（退出登出） | 11.0.0 | PASS | `beforeDelete=token-android-v10`，`afterDelete=null`，`rawAfterDelete=null`，`afterDeleteDelayed=null` |
| 独立进程复核删除已落盘 | 11.0.0 | PASS | `readBack=null`、`rawReadBack=null`（新进程启动后确实读不到） |
| 11 档一轮内 写/读/删 + 宿主共存 | 11.0.0 | PASS | `initial=null`、`readBack=token-android-v11`、`afterDelete=null`；宿主两键始终可读 |
| 11 档删除后独立进程复核 | 11.0.0 | PASS | `readBack=null` |

**宿主凭据共存**：上表每个阶段（含 11 档删除之后）`host.musicPassword.read=music-secret-t3`、
`host.thirdPartyToken.read=third-party-token-t3` 始终可读 → 组件的登出/401 清理只动自己那一格，与单测
`host_credential_coexistence_test.dart` 的结论互相印证。

**明文回退检查**：探针在应用数据目录内扫描令牌字面量（排除探针自己的产物文件），
各阶段 `plaintext.hits=[]`（scannedFiles 4~8）；`adb run-as … cat shared_prefs/FlutterSecureStorage.xml` 中
令牌以密文出现、无明文；删除后该 XML 中不再含 Feedback 槽位（`grep -c feedback_widget` 见
`e2e/flutter_native/out/native/android-post-delete-prefs.txt`）。

**夹具伪影（如实记录，非组件缺陷）**：最初的迁移跑法让探针在 `write`/`delete` 之后立刻 `exit(0)`，
而 Android 的 `SharedPreferences.Editor.apply()` 是异步落盘，进程被杀时写入尚未刷盘，
于是出现了「9 档写入在 10 档读不到（包括宿主凭据也读不到）」与「删除后新进程又读到旧令牌」的假象。
归因证据：`out/native/android-flush-attribution.txt`；隔离实验 `out/native/android-flush-*.result.json`
（删除后停留 5s 再退出 → 新进程读回为 `null`，说明 delete 本身是持久的）。
修正：写/删阶段统一在退出前停留 5s 并复读确认，并新增 `absent` 阶段在独立进程复核；
上表为修正后的最终结果。**观察项（非阻塞）**：真实应用若在登出后数毫秒内被系统杀死，插件的删除同样可能未落盘——这是插件后端语义，与本组件的接口无关。

### 7. macOS / iOS：仅构建（未做运行时验证）

| 命令 | 退出码 | 产物 |
| --- | --- | --- |
| `flutter build macos --release`（examples/flutter） | 0 | `feedback_example.app`（43.2MB） |
| `flutter build ios --no-codesign`（examples/flutter） | 0 | `Runner.app`（16.9MB） |

**明确标注：本轮按收敛范围未做 macOS/iOS 的 Keychain 运行时验证**（未安装、未启动、未读写 Keychain）。
签名与 entitlements 在本轮只做了构建通过这一层结论；收敛前完成的 macOS 运行时实测见 §11 附录。

### 8. 本轮发现（不阻塞本轮验收，但需记录）

- **F1（低）字面 verify 命令必然失败**：`grep -rn "dependency_overrides" flutter/feedback/pubspec.yaml examples/flutter/pubspec.yaml tools/flutter-storage-matrix/pubspec.yaml ; test $? -eq 1` 因为
  `tools/flutter-storage-matrix/pubspec.yaml:25` 的**注释**里含该词而 grep 命中 → 复合命令 exit 1。
  实质结论（无真实声明）成立；建议后续把该命令改成只匹配非注释行（例如 `grep -rEn "^[[:space:]]*dependency_overrides[[:space:]]*:"`），
  或把说明文字改写成不含该字面量。历史记录中 t1/t2 写「契约命令 exit 0」只对当时的两文件版本成立。
- **F2（低）示例的 Podfile.lock 未随 11.0.0 切换刷新**：`examples/flutter/macos/Podfile.lock` 仍写 `flutter_secure_storage_macos (6.1.3)`，
  `examples/flutter/ios/Podfile.lock` 仍写 `flutter_secure_storage (6.0.0)` 与 `.symlinks/plugins/flutter_secure_storage/ios`，
  而 pubspec 已固定 11.0.0（其 ios/macos 默认实现均为 `flutter_secure_storage_darwin`）。
  构建时 `pod install` 会自动重写这些文件，因此不阻塞构建（§2 命令 4/5 均 exit 0）；
  但首次构建会改动这两个文件（生成物）。本轮把工具改写后的差异记录在 `e2e/flutter_native/out/verify/generated-lock-diffs.txt`，
  随后**已还原**为工作区原状（不在验证者职责内改动 examples/）。
- **F3（提示）探针/夹具语义**：Android 上「删除后立即杀进程 → 删除可能未落盘」（§6 末）值得任何写存储测试的人注意；
  本组件代码无此问题（它不做进程级操作），但用 `flutter_secure_storage` 写集成测试时需给异步落盘留时间。

### 9. 测试数据清理（本轮已执行）

- macOS：探针自身的三个键（派生令牌键 + 两个模拟宿主凭据键）已删除，`remainingKeys=[]`（`out/native/macos-cleanup.result.json`）；
  测试应用容器 `~/Library/Containers/com.feedbackverify.keychainProbe` 已移除（`container_removed=yes`）。
  **未清理、也未读取用户 Keychain 中的任何其它条目。**
- Android：测试应用已卸载（`Success`，卸载前后 `pm list packages` 计数 1 → 0），shared_prefs/Keystore 条目随卸载清除，
  模拟器随后关闭（`out/native/android-cleanup.txt`）。
- 全程未接触用户真实凭据（测试令牌与"宿主凭据"都是字面测试值）。

### 10. 未验证 / 限制（如实标注，不得读作已通过）

1. **macOS / iOS 运行时（Keychain 读写删）本轮未做**——按收敛范围只做构建。
2. **iOS 运行时在本机目前也缺少必要条件**：`xcrun simctl list runtimes` 为空（无已安装模拟器运行时），
   且收敛前实测本机只有针对 `dev.example.feedbackExample` 与 macOS 平台的 Xcode 托管描述文件，**没有 iOS 真机描述文件**。
   → iOS Keychain 运行时验证判定为**未通过/未做**，不虚构 Team、不清理用户 Keychain。
3. **Windows / Linux**：不在本轮原生范围，未尝试、也未建任何阻塞条目。
4. **Android 未使用真机**，验证在模拟器（android-35 google_apis arm64）上完成。
5. 三档矩阵：9.2.2 / 11.0.0 为采信实现者证据（§4 已标注）；收敛后未再复跑矩阵脚本。
6. 原生运行时只在 Android 上覆盖了 9 写 → 10 读/写 → 11 读/删 的迁移序列，未在 9/10 档单独跑完整"写→重启读→删"往返。

### 11. 附录：收敛前已完成、但不属于最终范围的两组结果（如实保留）

> 这两组在用户要求收紧范围**之前**已跑完，产物保留但**不作为本轮验收依据**，仅供复核与后续复用。

1) **独立矩阵宿主**（`e2e/flutter_matrix`，验证者自建、不复用 `tools/flutter-storage-matrix`）：
   在 `flutter create --template=package` 宿主里用 path 依赖引用 `flutter/feedback`，并把 `flutter_secure_storage` 逐档固定为精确版本；
   另把 `flutter/feedback` 的 lib/test 原样复制到 `work/<tier>/feedback` 后只在副本里改那一行约束，配合 sha256 清单证明跑的是同一份源码。
   结果（`e2e/flutter_matrix/out/matrix-summary.tsv`）：

   | 档位 | SUT 解析 | darwin | macos | windows | platform_interface | pub_get | analyze | test | 宿主解析 | 宿主 analyze/test |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | 9.2.2 | 9.2.2 | - | 3.1.3 | 3.1.2 | 1.1.2 | 0 | 0 | 0（112/112） | 9.2.2 | 0 / 0（10 例） |
   | 10.3.1 | 10.3.1 | 0.3.2 | - | 4.2.2 | 2.1.0 | 0 | 0 | 0（112/112） | 10.3.1 | 0 / 0（10 例） |
   | 11.0.0 | 11.0.0 | 0.4.2 | - | 4.2.2 | 2.1.0 | 0 | 0 | 0（112/112） | 11.0.0 | 0 / 0（10 例） |

   （三档 SUT 副本与工作区源码 sha256 一致；与实现者的解析表逐项一致，含 10.x 起换包这一修正。）

2) **macOS Keychain 运行时**（`e2e/flutter_native/work/macos-entitled`，Apple Development 签名 + `keychain-access-groups`）：
   三次**独立进程启动**分别为 write → read（进程重启后读取）→ delete，均 PASS
   （`out/native/macos-{write,read,delete,absent}.result.json`）；期间宿主模拟凭据始终可读、无明文命中。
   反例对照（`work/macos-denied`，ad-hoc 签名、无 entitlement）：写入抛 `PlatformException`
   `code="Unexpected security result code"`、`details="-34018"`、`message="Code: -34018, Message: A required entitlement is not present."`，
   且读取返回 `null`、无明文回退——即"存储不可用"时的真实错误表现。
   静态检查（本轮做）：`examples/flutter` Release 产物 `TeamIdentifier=C5Q966MAGT`、
   `keychain-access-groups=[C5Q966MAGT.dev.example.feedbackExample]`、`app-sandbox=true`。

### 12. 体验入口与操作步骤（Flutter 安全存储兼容 = 待体验）

```bash
export PATH="$HOME/flutter/bin:$PATH"

# a) 组件包单测（112 例）
cd flutter/feedback && flutter analyze && flutter test

# b) 三档隔离矩阵（约 5 分钟，需要联网解析 9.2.2/10.3.1）
bash tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0
cat tools/flutter-storage-matrix/out/matrix-summary.tsv

# c) Android 9→10→11 迁移实测（需 JDK 17 + 已启动模拟器/真机）
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
bash e2e/flutter_native/run_native.sh android-migrate
ls e2e/flutter_native/out/native/android-mig-*.result.json

# d) 构建（示例已固定 11.0.0）
cd examples/flutter && flutter build macos --release && flutter build ios --no-codesign && flutter build apk --debug
```

**体验要点**：c) 会依次在同一应用标识/同一 debug 签名上安装 9.2.2 → 10.3.1 → 11.0.0，
逐档产出 `verdict=PASS` 的结构化 JSON；若某档出现 `verdict=FAIL`，说明该档切换真的破坏了已存令牌（这是本组验证最有价值的信号）。

### 13. 交付收口复核（t6，非验证者观测 · 2026-09-14）

> 本节由文档收口任务 **t6** 追加，**不是 t5 验证者的观测**；§0~§12 的原始记录未做任何修改。
> t5 的 §8-F1（契约字面命令命中注释）与 §8-F2（示例 Podfile.lock 未随 11.0.0 刷新）
> 已由后续修复任务 **t7** 闭环；下面是收口时对修正后现状的复核（命令与结果均为本次真实运行）。

| 遗留 | t5 当时的记录（§8） | 收口时现状（复核命令 → 结果） |
| --- | --- | --- |
| F1 契约字面命令 | exit 1：命中 `tools/flutter-storage-matrix/pubspec.yaml:25` 的注释 | 该注释已改写；`grep -rn "dependency_overrides" flutter/feedback/pubspec.yaml examples/flutter/pubspec.yaml tools/flutter-storage-matrix/pubspec.yaml` 无输出（grep exit 1）→ `test $? -eq 1` 成立，**契约命令 exit 0** |
| F2 示例 Podfile.lock | ios `flutter_secure_storage (6.0.0)`；macos `flutter_secure_storage_macos (6.1.3)` | 由 CocoaPods 1.17.0 重新生成：两文件均为 `flutter_secure_storage_darwin (10.0.0)`、`SPEC CHECKSUM: 46e40169…`；`flutter_secure_storage_macos` / `(6.1.3)` / `(6.0.0)` 在两 lock 中零匹配（grep exit 1）；sha256 = ios `7a65397b…`、macos `738891b3…`（重跑 `pod install` 后不变，非手改） |

⚠️ **易混淆点（供文档与接入方对照）**：`Podfile.lock` 里的 **`10.0.0` 是 CocoaPods podspec 版本**
（`flutter_secure_storage_darwin-0.4.2/darwin/flutter_secure_storage_darwin.podspec:6` 的 `s.version = '10.0.0'`），
**该 pub 包版本是 `0.4.2`**（§4 表格），两者不是同一个数字含义。

**与 §8 的关系**：§8 保留 t5 当轮的原始观测，不解锁、不改写；F1/F2 的现状以本节为准。
本轮范围与限制（macOS / iOS 未做 Keychain 运行时验证、Windows / Linux 不在本次范围）**不受本节影响**，仍以 §0、§7、§10 为准。

---

## Feedback v0.3.0 上线前修复计划（日志真实归档、身份隔离、更新防御与文档示例闭环，2026-09-14 · 状态：待体验）

### 1. 本轮修复范围与标准
- **L3: 真实归档闭环**：消除“日志未真正上传却被标记为 archived”假象。
  - Kaneo 附件协议复用 `createImageUpload` & `finalizeImageUpload`（`surface: "comment"`）；
  - 远端写入后通过 `downloadAsset` 逐一回下载原始字节并比对 SHA-256 完整性摘要；
  - 升级 `archive_data_json` 至 V2 结构（支持独立附件索引 `screenshot` 与各个 `log.id`），归档判定门禁 `isFullyArchived` 严格要求截图（若有）与全部日志附件均已确认，纯文本反馈则在任务创建成功后直接归档；
  - 数据库迁移升至 user_version 5，平滑迁移历史含日志但缺失 V2 归档凭据的伪 archived 记录至 `needs_review`；管理端与探针支持针对性 `retry_log` 恢复。
- **L1: 跨身份隔离与手动选择优化**：
  - Web 与 Flutter 客户端在切换 `apiBase` / `appId` 时严格清理草稿与日志缓存，防止日志跨应用泄露；
  - Flutter 端文件选择实现 3 级优先（`widget.filePicker` > `widget.config.filePicker` > 默认 `_defaultFilePicker` 基于 `file_selector: 1.0.3`），且在前端严格验证 UTF-8 编码。
- **U1: 更新防御与探针增强**：
  - 更新探针增加附件字节级 SHA-256、体积与归属校验，保证更新前后数据一致；
  - 完善更新暂停期反馈写入保护与系统更新回滚安全。
- **D1: 文档与示例闭环**：
  - 统一修复 `docs/integration.md` 中的日志示例（Web 为 `FeedbackLogFile` `{ filename, blob }`，Flutter 为 `FeedbackLogFile(filename, bytes)`）；
  - 示例项目依赖刷新与验证全绿。

### 2. 门禁验证结果

| 门禁项 | 命令 | 结果 | 细节证据 |
|---|---|---|---|
| Workspace 构建 | `pnpm -r build` | ✅ exit 0 | 8 个构建项目（admin、server、updater、web、examples react/vue）全部构建成功 |
| Workspace 类型检查 | `pnpm -r typecheck` | ✅ exit 0 | 8 个项目（含 ssr 语法检查与 web/admin/server tsc）无任何类型错误 |
| Workspace 代码质量 | `pnpm -r lint` | ✅ exit 0 | 全部代码通过 Biome / ESLint 规范检查，0 error |
| Workspace 单元测试 | `pnpm -r test` | ✅ exit 0 | server 13 文件 218 用例全过；web 14 文件 151 用例全过；updater 8 文件 71 用例全过；admin 冒烟通过 |
| Flutter 代码质量 | `flutter analyze` | ✅ exit 0 | `flutter/feedback` 与 `examples/flutter` 均报告 `No issues found!` |
| Flutter 单元测试 | `flutter test` | ✅ exit 0 | `flutter/feedback` 119 个测试全部通过；`examples/flutter` 37 个测试全部通过 |

### 3. 验收结论
- 本阶段已严格按照 L3 → L1 → U1 → D1 顺序执行完毕，全仓代码、自动化用例、示例工程与接入文档均已闭环对齐。
- 当前结论：**可以进入测试部署**（状态标记为 **待体验**）。

---

## 2026-09-15 U1 / L1 最后两项补修追加记录

本节只追加本轮源码修复与验证，不覆盖上方历史记录。当前状态：**待体验**；源码、构建、类型、lint、单测、隔离浏览器及真实 Docker 容器升级验证均已通过。该结果仍不等同于正式生产部署或用户验收。

### U1：附件字节级升级核验

- 修复前反例：探针只信数据库保存的 `sha256` / `byte_size`；将 `feedback_logs.bytes` 从 `AAA` 改为 `BBB` 而保留旧摘要时，旧逻辑仍可能放行。截图字节同类问题一致。
- 修复：[`apps/updater/src/db-probe.ts`](apps/updater/src/db-probe.ts) 在容器内用 `node:crypto` 对 BLOB 逐行计算实际 SHA-256 与字节长度；严格解析附件列表、计数、重复 ID、表名和元数据；旧 schema 缺 `feedback_logs` 时保留兼容，schema ≥4 强制日志表与计数；更新前基线不可靠时在拉取镜像前以 `baseline_probe_failed` / `failed_no_changes` 停止。
- 回归：真实临时 SQLite 覆盖 `AAA→BBB` 保留摘要失败、同步更新摘要但升级前后内容变化失败、截图字节损坏失败、健康数据通过；非法附件、缺失元数据、重复 ID、基线损坏均失败。

### L1：卸载后的迟到日志丢弃

- 修复：[`packages/web/src/element.ts`](packages/web/src/element.ts) 集中使用 `invalidateLogCollection()`；卸载、关闭和身份切换递增 `logOpSeq`、释放忙碌态并清理当前计时器。成功、失败、`finally` 均核对序号、身份世代、草稿对象、`isConnected` 和面板状态；仅有效完成标记 `logsCollected`；重挂载且面板仍打开时按取消状态重试。
- 回归：[`packages/web/test/feedback-logs.test.ts`](packages/web/test/feedback-logs.test.ts) 新增 2 项可控 Promise 测试，覆盖卸载后旧结果不入列表，以及旧 `finally` 不清除新采集忙碌态。
- 真实浏览器：当前 `packages/web/dist/feedback-web.umd.cjs` 在隔离页面通过卸载/重挂载 2/2；另用隔离 `fetch` stub 实际提交 multipart，核对 `metadata.logs`、文件名、`source=auto` 与文件字节全部一致，未连接真实 Kaneo。

### D1：本轮命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm -r build` | exit 0，8 个 workspace 项目完成 |
| `pnpm -r typecheck` | exit 0，8 个项目完成 |
| `pnpm -r lint` | exit 0；server 保留既有 23 条 warning，无 error |
| `pnpm -r test` | exit 0；server 218、updater 75、web 153，admin smoke 通过 |
| `npx tsx e2e/u1_engine_boundaries.mts` | exit 0，33/33 通过 |
| `python3 e2e/check-release-workflow.py` | 46/47；唯一失败是既有 `.github/workflows/ci.yml` 工作区改动触发的“未被修改”历史断言，本轮未回滚该改动 |
| `python3 e2e/run_u1_upgrade.py` | exit 0，137/137 断言通过，6/6 场景通过；使用从 `HEAD` 归档构建的旧版镜像、本工作树新版镜像及隔离本地 registry/卷 |

真实容器报告：[`e2e/shots/u1/upgrade-report.json`](e2e/shots/u1/upgrade-report.json)。本轮旧版 digest 为 `sha256:2ff9619975749eacd20ef32a9e12ecc48bf2c9d3c78f7ad3ebce15f482854ec6`，新版 digest 为 `sha256:767569d3fccdc6102fc0872066621f95be9cdbbe3664b9b4275b00a2f1232b7d`；成功、核验失败恢复、放行后失败、快速拒绝、环境文件并发修改、updater 重启六个场景全部通过。验证使用隔离 mock AI/Kaneo 与临时数据卷，未连接真实 Kaneo、生产数据或执行部署、提交、推送、打标签；因此当前结论为**具备进入测试部署的条件，状态待体验**。
