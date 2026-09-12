# 交付记录：「截图＋描述＋日志」（T1 / T2 / T3）

> 本轮在既有反馈能力上补齐**日志附件**：打开面板自动带上宿主最近日志、可手动补充；
> 提交后随反馈一起保存，管理页可查看与下载；AI 结合日志给出**区分证据与推测**的诊断；
> Kaneo 按「截图 → 日志」顺序归档可下载附件，且**全部附件完成才算归档完成**。
>
> 契约（线格式、限制、行为约定、并行边界）见 [`logs-plan.md`](logs-plan.md)。
> 状态口径：**未开始 / 实现中 / 待体验 / 已验收**——只有用户确认效果后才记「已验收」。
>
> 记录时间：2026-09-12。

## 任务状态

| 任务 | 状态 | 说明 |
|---|---|---|
| T1 打开反馈面板自动带日志、也能手动补充（Web / Flutter） | **待体验** | 两端已实现并有自动化回归；浏览器侧新增真实路径 P8/P9 实测通过；真实平台的文件选择对话框需在具体平台手测 |
| T2 提交后管理页查看与下载日志 | **待体验** | multipart `logs`、`feedback_logs` 子表、幂等摘要、管理端读取/下载接口全部落地并有测试 |
| T3 AI 结合日志分析、Kaneo 保留可下载附件 | **待体验** | AI 截取与 `diagnostics`、归档 V2、集中完成条件、带 `logId` 的人工恢复全部落地并有测试；真实 Kaneo 实例未验证（见「剩余缺口」） |

## 交付内容

### T1｜客户端采集与面板

| 位置 | 内容 |
|---|---|
| `packages/web/src/logs.ts`（新增） | 规则单点：3 个 / 1 MiB / `.log`/`.txt`/`.json`/`.jsonl` / 严格 UTF-8 / 3 秒超时 / 按码点截断预览 |
| `packages/web/src/element.ts` | `logProvider` JS 属性、采集会话（序号 + 身份世代双校验）、日志面板（列表 / 预览 / 移除 / 重试 / 不带日志继续提交 / 原生文件选择）、附件提交锁定与快照幂等 |
| `packages/web/src/api.ts` | `logs` 的 multipart 编码：`metadata.logs` 与 `logs` 部件同序、filename = 日志名、`text/plain`；无附件仍走原 JSON（逐字节兼容） |
| `flutter/feedback/lib/src/logs.dart`（新增） | 与服务端同一套上限与校验；`file_selector` 选择器按字节读取；预览截断 |
| `flutter/feedback/lib/src/{config,panel,widget,api_client}.dart` | `logProvider` 回调、采集与迟到保护、附件锁定、快照含日志、multipart 同序编码 |
| 示例 | `examples/{react,vue,html,ssr}` 与 `examples/flutter` 演示「宿主内存日志环形缓冲 → `logProvider`」；不扫盘、不拦截 console |

### T2｜接口、存储与管理页

| 位置 | 内容 |
|---|---|
| `apps/server/src/services/logs.ts`（新增） | 数量 / 大小 / 扩展名 / 严格 UTF-8 / `metadata.logs` 逐项核对；`invalid_log`(400) 与 `too_large`(413) 分类；文件名安全化 |
| `apps/server/src/routes/feedback.ts` | multipart `logs` 重复部件按序收集；请求体上限 6 MiB → **9 MiB**；日志参与 `contentHash`（有日志才加 `logs` 键） |
| `apps/server/src/db/db.ts` | `feedback_logs` 子表 + 迁移 **v2 → v3**（事务内、成功后写版本号、失败回滚、不重建 feedbacks） |
| `apps/server/src/db/repos.ts` | 日志与反馈/截图**同一事务**写入；有序查询；`logCount`；`contentHash` 扩展 |
| `apps/server/src/routes/admin.ts` | 列表 `logCount`、详情 `logs[]`、`recovery.logs[]`（日志级恢复状态）、`GET /feedback/:id/logs/:logId`（`no-store` + `nosniff` + 安全文件名，`?download=1`） |
| `apps/admin/src/{api,logs}.ts`、`views/FeedbacksView.tsx` | 列表日志份数、详情日志分区（预览 / 下载 / 来源 / 摘要）、「诊断（基于日志）」三块展示、日志级恢复按钮带 `logId` |

### T3｜AI 与 Kaneo

| 位置 | 内容 |
|---|---|
| `apps/server/src/services/ai.ts` | `organize(rawText, image?, logs?)`；每文件末尾 ≤ 8000 码点、合计 ≤ 24000；提示词声明日志为**不可信证据**；`diagnostics` 校验 |
| `apps/server/src/types.ts` | `FeedbackDiagnostics { logEvidence, possibleCauses, speculation }`（可选，旧结果兼容） |
| `apps/server/src/services/kaneo.ts` | 日志评论正文（可下载链接 + 日志 ID + 摘要）；任务描述追加「诊断（基于日志）」 |
| `apps/server/src/pipeline/archive-data.ts` | 归档数据 **V2**（`logs[]` 按日志 ID 索引的 upload/asset/comment/replacedKeys）；V1 继续可读；`logCommentMarker` |
| `apps/server/src/pipeline/worker.ts` | 附件级归档流程（截图 → 日志 ordinal 升序）、**集中完成条件**、恢复数据切片读写、带 `logId` 的 `retry_comment` / `replace_upload` |
| `apps/server/src/routes/feedback.ts` | `recover` 接受可选 `logId`（缺省 = 原截图行为；不存在 → 400） |

## 本次实际执行的命令与结果

### 仓库级（根目录）

| 命令 | 结果 |
|---|---|
| `pnpm test` | **11 个测试文件 / 168 项通过**（`apps/server`）；`packages/web` 12 文件 / 145 项通过 |
| `pnpm typecheck` | 全部包通过（`apps/server`、`apps/admin`、`packages/web`、`examples/react`、`examples/vue`、`examples/ssr`） |
| `pnpm lint` | 全部包通过（exit 0；`apps/server` 余 8 条既有 `noExplicitAny` 警告，非新增） |
| `pnpm build` | 全部包构建成功（含 `apps/admin` 与 `examples/react`、`examples/vue`） |

### 服务端新增回归

| 文件 | 覆盖 |
|---|---|
| `apps/server/test/logs.test.ts`（新增 16 项） | 校验矩阵（数量 / 大小 / 扩展名 / 空文件 / 二进制 / 非 UTF-8 / `byteSize` 不符 / 文件名不符）、文件名安全化、`POST /api/feedback` 落库与顺序、非法日志不落库、截图错误码优先级、无日志摘要与旧算法一致、同键换日志 409、管理端 inline/attachment/404/401、**迁移 v2→v3 升级 + 重复启动 + 失败回滚**、**日志写入失败整体回滚** |
| `apps/server/test/logs-pipeline.test.ts`（新增 17 项） | `prepareLogsForAi` 截取（末尾优先 / 8000 / 24000 上限）、`buildLogsBlock` 标注与不可信声明、worker 只从已保存附件取日志、诊断贯通描述与详情、旧结果兼容、**按截图→日志顺序归档且资产互不覆盖**、仅文本+日志、下载字节摘要一致、**日志未完成绝不 archived**（上传不确定 / 评论核对未命中）、重启后本地可下载且不重复上传、带 `logId` 的两种恢复、缺省 `logId` = 截图、recheck 未挂载不归档、有日志状态拒绝 force-create |

### Flutter

| 命令 | 结果 |
|---|---|
| `cd flutter/feedback && flutter test` | **105 项通过**（原 77 + 新增 28） |
| `cd flutter/feedback && flutter analyze` | `No issues found!` |
| `cd examples/flutter && flutter test` | **9 项通过**（原 4 + 新增 5） |
| `cd examples/flutter && flutter analyze` | `No issues found!` |

### 真实浏览器（`e2e/run_browser.py`，Chromium）

```
python3 e2e/run_browser.py --browser chromium
=== E2E 结果：288/288 通过 ===   （exit 0）
```

基线为 237 条，本轮新增 **51 条**断言（P8 + P9 两条路径）。

新增两条**真实浏览器 + 真实服务端**路径（无任何对被测组件的 mock）：

- **P8 日志附件路径**：宿主内存日志 → 打开面板自动调用 `logProvider` 一次 → 面板展示文件名 / 可读大小 / 来源（自动）→ 长日志预览**显式提示已截断** → 移除后条目消失 → 关闭重开**不重新采集、不自动补回** → 原生文件选择手动添加（合法文件进列表、`.zip` 被拒并给明确原因、超过 3 份上限明确提示且不静默丢弃）→ 提交为 multipart：`metadata.logs` 数量/顺序/来源/`byteSize` 与 `logs` 部件逐项一致 → 管理端 `logCount`、详情元数据、**逐份下载字节与提交完全一致且摘要与落库一致** → Kaneo mock 收到 3 条各带日志 ID 与可下载链接的评论。
- **P9 日志采集失败路径**：`logProvider` 首次挂起 → 约 3 秒后出现「日志获取失败」（附「重试」与「不带日志继续提交」）→ 列表为空（绝不显示半截日志）→ 描述仍可编辑、填入描述后提交按钮立即可用 → 点「重试」后日志真的出现、失败提示消失、采集不重复调用。

## 需要你确认 / 体验

1. **Web**：打开示例（`examples/react` 或 `examples/vue`）→ 点「写一条日志」→ 打开反馈面板 → 日志自动出现（来源：自动）→ 预览 / 移除 / 手动添加 → 提交后在管理页下载日志。
2. **Flutter**：`examples/flutter` 里触发日志后打开面板，确认自动日志、手动选择文件、预览与移除；**文件选择对话框需在真实平台手测**（macOS 沙盒 entitlements / Windows / Linux / Web 文件对话框在单测中无法验证）。
3. **管理页**：确认列表「日志」列、详情日志分区（预览 / 下载）、以及日志级恢复按钮是否符合预期。

## 剩余缺口（不得读作已通过）

1. **真实 Kaneo 实例未验证**：日志归档复用既有的预签名上传 → 二进制上传 → finalize → 评论挂载与鉴权下载链路，
   本轮只在 mock 上验证了调用序列、顺序、标记与字节一致性。当前相邻 Kaneo 源码允许普通附件，但**未在部署实例上验证**。
2. **真实 AI 未验证**：日志诊断的提示词与截取规则有单测覆盖，`diagnostics` 的贯通由注入的 AI 结果验证；
   未用真实模型确认「日志证据 / 可能原因 / 推测」的区分质量。
3. **日志级恢复未做浏览器实测**：管理页日志级按钮的渲染由静态/端到端冒烟（happy-dom）覆盖，
   本轮浏览器 E2E 未覆盖「点日志级恢复按钮 → 服务端带 `logId` 执行」这一条（服务端侧有测试）。
4. **示例 `examples/flutter/pubspec.lock`** 因 `pub get` 更新（新增 `file_selector` 家族条目），属构建产物级更新。
5. **Flutter 插件注册文件**（`examples/flutter/{linux,windows,macos}`）由 `pub get` 自动生成，非手改。
6. `e2e/shots/` 下的截图证据由本轮 E2E 运行重新生成（含新增 `P8-log-panel.png`、`P8-log-submitted.png`、`P9-log-timeout.png`）。
7. **本轮浏览器验证只在 Chromium 上跑过**：`run_browser.py --browser firefox|webkit` 的跨引擎复跑未执行
   （新增的 P8/P9 使用原生文件选择与真实定时器，理论上与引擎无关，但未实测）。
8. **P8/P9 的修复属于 harness 侧**：过程中暴露的 4 处失败全部定位为**测试脚手架断言错误**
   （长日志在采集后才追加、提交按钮 `disabled` 由「描述为空」决定、`Esc` 的焦点守卫、
   NetRecorder 双通道下标错位），没有放宽任何产品规则。
