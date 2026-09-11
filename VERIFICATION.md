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
