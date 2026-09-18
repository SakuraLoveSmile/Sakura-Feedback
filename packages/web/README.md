# @feedback/web

框架无关的反馈组件（Custom Element `<feedback-widget>` + Shadow DOM）。**唯一的运行时依赖是 `html2canvas-pro@2.4.2`，且只被内置视口截图路径使用**：ESM 构建把它拆成独立 chunk 并在首次截图时动态 `import()`，纯文字提交或自定义 `captureProvider` 都不会加载；UMD 构建单文件内联。除此之外只用浏览器内置能力（fetch / custom elements / Shadow DOM）。严格遵循仓库 `docs/api.md` HTTP 契约。

> 📘 **完整接入指南：[`docs/integration.md`](../../docs/integration.md)**
> —— 从服务端配置、组件安装、挂载悬浮球到登录/截图/反馈/归档的端到端步骤。
> 本 README 是属性 / 方法 / 事件 / 截图与遮挡的**权威参考**。

## 安装

```bash
pnpm add @feedback/web
```

### npm 导入（自动定义元素）

```ts
import { FeedbackWidget, openFeedback } from '@feedback/web';
```

### `<script>` 直接加载（UMD，顶层副作用自动注册元素）

```html
<script src="/path/to/feedback-web.umd.cjs"></script>
<feedback-widget api-base="http://localhost:8787" app-id="com.example.app"></feedback-widget>
```

## 属性 / attributes

| attribute | prop | 必填 | 说明 |
|---|---|---|---|
| `api-base` | `apiBase` | 是 | 反馈服务地址（含协议，如 `http://localhost:8787`）；**运行时变化 = 完整身份切换**：取消在途捕获 / 提交 / 轮询 / 登录，清空令牌、任务态与草稿，新服务需重新登录 |
| `app-id` | `appId` | 是 | 服务端登记的软件标识；**运行时变化会废弃当前草稿、进行中的捕获与旧提交结果**（同一服务，令牌保留） |
| `app-version` | `appVersion` | 否 | 随 `context.appVersion` 上报（变化只刷新头部信息，不清空草稿） |
| `page-label` | `pageLabel` | 否 | 随 `context.pageLabel` 上报（变化只刷新头部信息，不清空草稿） |
| `side` | `side` | 否 | 悬浮按钮位置 `left` \| `right`（默认 `right`） |
| `theme` | `theme` | 否 | `system` \| `light` \| `dark`（默认 `system`） |
| `show-launcher` | `showLauncher` | 否 | 是否显示贴边入口（默认 `true`） |
| `launcher-bottom` | `launcherBottom` | 否 | 入口垂直位置（默认 `25%`） |
| `launcher-mode` | `launcherMode` | 否 | `tab`（贴边标签）\| `orb`（灵感球，默认 `tab`） |
| `capture-mode` | `captureMode` | 否 | `off` \| `viewport`：呼出时是否**自动**截取当前视口（默认 `off`）。`off` 只关闭**自动**截图——面板里始终有手动的「截取当前页面」 |
| — | `effectiveApiBase` | — | **只读**：当前实际使用的服务地址（用户本机覆盖优先于 `api-base`；未覆盖时等于 `api-base`） |

## 自定义服务器（设置视图）

面板头部有「服务器设置」入口（未登录也可进入）：地址输入 + 保存 + 恢复默认 + 当前有效地址 + 连通性探测（保存后 `GET /healthz`，不回切）。

- 覆盖仅保存在**本机 localStorage**，按「页面源 + `app-id` + 规范化默认地址」分槽位隔离；恢复默认只删本机覆盖，不修改 `api-base` 属性。
- 地址规范化：去空白与末尾斜杠、去默认端口、保留部署路径前缀；仅 `http(s)`、要求主机非空、拒绝内嵌凭据 / 查询参数 / `#` 片段；**HTTPS 页面拒绝 HTTP 地址**（混合内容会被浏览器拦截）。
- 相同规范化地址保存不重置任何状态；异址且有草稿 / 截图 / 日志 / 未确认提交时需确认后清空，存在结果未确认的提交时提示「旧服务器可能已接收」。
- 切换后身份完全隔离：令牌、任务态、额度、轮询、幂等键、在途操作全部按新身份重建，旧身份迟到响应一律丢弃；偏好写入失败时本次会话仍生效并提示「仅本次生效」。
- 偏好加载完成前不启动任何依赖服务器的请求。

## 方法与事件

- `open()` / `close()`：开关面板。`close()` 会同时取消进行中的截图（即使面板尚未打开）。`open()` **只打开面板、不截图**；自动截图只发生在 `capture-mode="viewport"` 的呼出路径。
- `captureAndOpen(opts?)`：截图并打开面板。`opts.releasePoint` 为灵感球拖拽落点（0..1 视口比例）。
  - 已有草稿（文字或截图）时**恢复草稿、不重拍**；有捕获进行中时**合并**到该会话，不重复发起。
  - 这是**呼出**语义：草稿一脏就不再重拍。面板内的手动截图入口（「截取当前页面」/「重新截图」）走显式重拍流程，**不受草稿影响**。
- `cancelCapture()`：取消进行中的捕获：失效会话序号 → abort → 释放 Pointer Capture → 恢复 UI。迟到的结果被静默丢弃。
- `startLogin()`：在当前面板展开登录表单（不打开窗口），返回空串。
- `feedback-submitted`（CustomEvent，bubbles + composed）：提交被服务端接收（201/200）后在元素上派发，`detail = { feedbackId, status, replayed }`。

## 截图与敏感区遮挡

### 遮挡注册

- 页面中的 `input[type="password"]` 自动受保护。
- 任意元素标注 `data-feedback-capture-mask` 即可声明敏感子树（整棵子树被遮挡）。
- 组件自身的反馈 UI 永不出现在截图中。

### 遮挡语义（2.1）

1. 在**克隆文档**上按布局定位敏感节点（含 open shadow root），修改克隆**之前**记录变换后边界（`getClientRects` 并集），裁定到截图视口；
2. 仅在克隆中隐藏敏感子树：`visibility:hidden!important` + `background-image:none!important` + 清除 `img/canvas/video/source/svg image` 的图片来源 + 注入样式清除伪元素内容；**不替换节点、不改布局尺寸**，真实页面零修改；
3. 渲染产出位图后，在**最终位图**上再填充不透明遮挡矩形（`rgb(110,110,115)`，向外取整并外扩一个输出像素），随后逐区域采样验证；**遮挡验证完成前绝不编码 PNG / 生成预览**。

### 失败规则

有效且仍可见的敏感节点无法在克隆中定位、遮挡坐标非有限、或最终位图无法验证（如 canvas 被跨源图片污染）→ **本次截图失败**：保留旧草稿与旧截图，展示「截图未完成，可重试或继续文字反馈」，绝不让用户以为截好图了。明确在截图视口外的敏感节点可忽略。

### 图片限制（2.3，两端统一）

- 缩放系数：`scale = min(dpr, 2, 2048 / 最长逻辑边, sqrt(4_000_000 / 逻辑面积))`；
- 输出约束：最长边 ≤ 2048px、总像素 ≤ 4,000,000、PNG ≤ 5MiB；
- 编码超过 5MiB 时按 ×0.8 缩小重编码（每轮重填遮挡并重新验证），最多 3 次，仍超限 → 截图失败（不发送超限图）；
- 上报元数据区分**逻辑视口尺寸**（`viewportWidth/Height`，CSS 像素）与**输出像素尺寸**（`pixelWidth/pixelHeight`），见 `docs/api.md`。

### 渲染支持范围与已知限制

内置路径基于 `html2canvas-pro`：受其渲染能力限制（跨源图片需 CORS 否则被跳过、iframe 内容、部分高级 CSS 与 WebGL 内容不保证还原）。需要像素级保真时请使用自定义 `captureProvider`。

## captureProvider（自定义截图）

```ts
widget.captureProvider = async (ctx) => {
  // ctx = {
  //   releasePoint?,            // 原有参数：拖拽落点（0..1）
  //   signal?,                  // AbortSignal：会话失效（重拍/关闭/取消/卸载/换 provider/appId）时 abort
  //   viewport?,                // { width, height, scrollX, scrollY, dpr } 逻辑视口
  //   sensitiveRegionCount?,    // 当前视口内"有效且仍可见"的敏感区域数量
  // }
  return {
    blob,                       // PNG 字节（必填）
    width, height,              // 输出像素尺寸（必填，原语义）
    viewport?,                  // 可选：逻辑视口尺寸 {width,height}（缺省回落 width/height）
    sameFrameMasking?,          // 敏感区域存在时必须为 true：遮挡与截图同帧完成
    maskedRegions?,             // 同帧遮挡区域列表（输出像素坐标）
  };
};
```

组件统一校验返回值：PNG 类型、`0 < size ≤ 5MiB`、边 ≤ 2048、像素 ≤ 4M、遮挡坐标有限/为正/在输出范围内。**页面存在可见敏感区域而 provider 未提供同帧遮挡证明时，拒绝使用该截图**（按遮挡失败规则处理）。无敏感标记的页面上，只返回 `{blob,width,height}` 的旧式回调保持兼容。`signal` abort 后本会话结果被丢弃且不报错。替换 `captureProvider`（含置空）会使进行中的旧捕获立即失效。

## 行为摘要（对齐契约）

- 呼出流程：`capture-mode="viewport"` 时**先截图后开面板**（截图中隐藏组件自身 UI）→ 遮挡与编码全部完成、会话仍有效 → 写入草稿并打开面板。
- 手动截图（默认 `capture-mode="off"` 宿主唯一的截图方式）：面板的截图区**预览与操作分离**——无截图时显示「截取当前页面」，此时缩略图 / 放大 / 「重新截图 / 移除截图」都不出现；有截图时显示预览与「重新截图 / 移除截图」；移除后回到首个入口并**保留文字**。手动入口复用显式重拍流程（不受文字草稿影响、可替换旧图、**失败不丢旧图与文字**，首次失败保留重试入口），捕获期间三个操作全部禁用并给出加载态——面板在捕获期间整体不可见，因此加载态与组件 UI 都不可能进入截图；截图结束后焦点回到面板内（原控件已隐藏时回到输入框）。提交与轮询期间禁止截图与移除。
- 草稿：**组件实例单一所有者**——同实例关闭再打开保留；从 DOM 断开重连保留截图字节并重建预览 URL；仅存内存，刷新即弃，绝不用 localStorage；`app-id` 变化时旧草稿与旧捕获整体废弃。重拍是唯一替换旧截图的入口，重拍失败不丢旧图；移除截图同时移除落点与捕获时间。有文字或截图的草稿再次呼出时恢复草稿不重拍。
- 提交流程：提交瞬间**冻结快照**（幂等键 / 应用与来源 / 原话 / 截图字节 / 元数据 / 草稿版本），HTTP 只读快照；提交期间禁用编辑、重拍、移除与重复提交。POST `/api/feedback` → 已接收（201/200 后才清空草稿）→ 轮询 `GET /api/feedback/:id`（2s 起指数退避封顶 5s，最长约 2 分钟）→ 已归档（展示任务链接）/ 服务端处理失败（原话已保存：提供「刷新状态 / 复制标识」与找回提示，**绝不重复提交**）/ 提交未到达服务（保留草稿，展示 errorSummary 与「重试提交」，复用同一幂等键与同一字节）。
- **服务身份与凭据隔离（P1）**：`api-base` 与 `app-id` 共同构成服务身份，任一变化都会递增实例内的**身份世代**；所有异步操作（提交、轮询、捕获会话、登录响应）在开始时捕获世代，恢复后世代不符即整体 no-op——**旧服务 / 旧身份的迟到结果绝不写入新身份的状态**（不写 `lastFeedbackId`、不改相位、不清草稿、不派发 `feedback-submitted`、不启动轮询）。
- `api-base` 变化 = **完整身份切换**：取消捕获会话 / 提交快照 / 幂等键 / 登录表单，停止轮询（复位 `polling` / `pollDelay` / `pollStartedAt`），清空**访问令牌**（`accessToken = null`、`tokenExpiresAt = 0`）与任务态（`lastFeedbackId` / `lastRecord` / `lastErrorSummary` / `unconfirmedRequest` / 登录错误，相位复位 `idle`）与草稿（含 textarea），并 `syncUi()` 重渲染。**新服务必须重新登录**：旧服务的 `Authorization` 绝不随请求发送给新基址（切换后未重新登录时组件不会发出任何请求）。
- `app-id` 变化 = **同一服务内**切换：草稿 / 捕获 / 提交结果 / 轮询 / 旧 `appId` 的登录表单全部作废，相位复位 `idle`；**令牌保留**（服务未变，无需重新登录）。
- `page-label` / `app-version` / `theme` 变化**绝不清空草稿**：前两者只刷新头部 `vX.Y.Z · 页面标签`，`theme` 只改样式；令牌、任务态与截图同样不受影响。提交来源取自**冻结快照**——快照冻结后修改 `page-label`（含后续重试）不会改变请求的元数据与截图字节。
- 服务端已接收但后台处理失败（`phase === 'failed'` 且已有记录）的卡片提供：**刷新状态**（`GET /api/feedback/:id` 只读重取，复用身份世代校验，刷新到 `archived` 即展示任务链接）、**复制标识**（`navigator.clipboard.writeText`，剪贴板 API 不可用时静默降级、绝不抛错）与**找回提示**（管理页可据反馈标识找回原话与截图）。该分支**绝不再次 POST `/api/feedback`**；「重试提交」只属于「提交未到达服务」的分支（同 key 同字节）。
- 幂等与冲突：草稿未变化的重试复用**同一幂等键与同一字节**；`409 idempotency_conflict` 显示冲突、**不自动换 key**；结果未知的提交（网络错误/5xx）在草稿被修改时保留原请求标识与时间供人工核对，新内容用新 key 重新提交。
- 登录：未登录可在面板内编辑；点击「登录并提交」就地展开账号密码表单，`POST /api/auth/login` 显式携带 `clientLabel=web:<appId>` 与 `appId`，令牌仅存内存，成功后只提交一次。登录响应绑定发起时的服务身份：`api-base` / `app-id` 变化会丢弃迟到的登录结果（新身份必须重新登录）。响应含 `user` 与每日 `quota`（北京时间零点刷新）。
- 令牌仅存组件实例内存，且**只属于签发它的服务**（`api-base` 变化即清空，需重新登录）；未提交草稿仅存组件实例内存。
- 无障碍：Esc 关闭（先关截图预览再关面板）、focus trap、打开聚焦 textarea、关闭恢复焦点、`role="dialog"` `aria-modal`、`prefers-reduced-motion` 尊重。

## 包体与懒加载

- ESM 构建（`dist/feedback-web.js`，约 86KB / gzip 约 24KB）：`html2canvas-pro` 拆为独立 chunk（约 329KB / gzip 约 76KB），**仅在首次触发内置截图时动态 import**；使用 `captureProvider` 或纯文字反馈不会加载。
- UMD 构建（`dist/feedback-web.umd.cjs`，约 320KB / gzip 约 84KB）：单文件内联全部依赖（含 html2canvas-pro），`<script>` 直挂场景无法分包。

## 本地开发

```bash
pnpm --filter @feedback/web build      # vite lib（ES + UMD）+ tsc 声明
pnpm --filter @feedback/web test       # vitest（happy-dom）：含像素级遮挡与生命周期回归
pnpm --filter @feedback/web typecheck
pnpm --filter @feedback/web lint
```

测试架构提示：`test/pixel-fixture.ts` 提供内存帧缓冲 FakeCanvas 与真实 PNG 编解码（node:zlib），`test/masking.test.ts` 以"泄漏模式"假渲染器断言最终 PNG 字节中敏感区确为不透明覆盖色、周围像素不误伤；`test/lifecycle.test.ts` 用可控 Promise（deferred）验证捕获会话交错与提交快照冻结，并以 `vi.mock('html2canvas-pro')` 覆盖内置路径；`test/capture-entry.test.ts` 覆盖面板内**手动截图入口**（默认 `off` 宿主、先写文字再截图、首次失败重试、移除后补拍、重拍失败留旧图、连击防重入、关闭/卸载/换身份后的迟到结果丢弃、焦点与提交期禁用）。

真实浏览器回归（`[hidden]` 的样式级联、焦点与触屏尺寸只有真机浏览器能验）：`python3 e2e/run_browser.py`，其中 P5（默认 `off` 下截图区必须真的隐藏 + 手动入口可用）、P6（侧边标签 → 不自动截图 → 手动截图 → 像素/放大/重拍 → multipart 落库）、P7（窄屏 + 键盘 Enter 激活 + 焦点不掉到隐藏控件）对应本轮改动。
