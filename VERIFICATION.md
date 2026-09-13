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
