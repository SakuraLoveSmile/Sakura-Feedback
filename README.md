# Feedback — 跨项目个人反馈组件与归档服务

> 📘 **完整接入指南：[`docs/integration.md`](docs/integration.md)**
> —— React / Vue / 原生 HTML / SSR / Flutter 的完整接入步骤、属性与方法清单、
> 截图与遮挡的已知限制，都集中在这一篇。

个人使用的反馈收集组件 + 归档服务。流程：**呼出面板 →（可选）截取当前应用视口并自动遮挡敏感区 → 输入文字 → 服务保存原话与截图 → AI 整理 → 写入指定 Kaneo 项目的待筛选列**。

反馈是**截图 + 文字**的多模态提交，不是只有文字：灵感球入口（`launcher-mode="orb"`）可以拖到界面任意位置指出问题，组件随即截取**当前应用视口**，在客户端完成像素级遮挡后，把截图与文字一起提交（`POST /api/feedback` 的 multipart `screenshot` 部件）。也可以只用文字——截图的默认值就是**关闭自动截图**（Web `capture-mode="off"`，Flutter `FeedbackCaptureMode.off`）；这种情况下面板里仍有手动的「截取当前页面」，用户想带图时随时可拍（先输入文字也能拍、失败可重试、移除后可补拍），截图与文字互不影响。

每次提交生成一个候选任务，不自动分配人员、设置日期或安排开发。客户端不含任何 AI 或 Kaneo 密钥。

## 截图范围（重要，别误读）

- 只截取**当前应用的视口**：Web 端是宿主页面视口，Flutter 端是宿主 App 视口（组件内部的 `RepaintBoundary` 只包住宿主内容，反馈面板自己永远不入图）。
- 灵感球/入口的**拖拽落点只标记"问题在哪里"**，不裁剪、也不改变截图范围。
- **没有局部裁剪、没有系统级悬浮窗、不跨应用截图**——拍不到别的窗口、别的应用或桌面。别把它当成系统截图工具。
- 敏感区域在**最终位图**上被不透明中性遮罩（#6E6E73）覆盖，遮挡验证完成前绝不编码 PNG：
  Web 端给元素标 `data-feedback-capture-mask`（`input[type="password"]` 自动受保护）；
  Flutter 端用 `FeedbackCaptureMask` 包裹（`obscureText` 输入框自动受保护）。
- 图片限制两端一致：最长边 ≤ 2048px、总像素 ≤ 4,000,000、PNG ≤ 5MiB。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `apps/server` | 反馈服务：Node.js + TypeScript + Hono；数据库是 Node 内置的 `node:sqlite`（`src/db/db.ts`，不需要额外自带的 SQLite 原生模块），但服务**仍有一个原生依赖 `sharp`**（截图的校验与重编码，`src/services/image.ts`），安装时会带上平台相关的 libvips 二进制（本机为 `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64`）。含管理 API、账号与每日额度、登录窗口页（兼容保留）、后台处理流水线 |
| `apps/admin` | 管理页（React + Vite），构建产物由 server 在 `/admin/` 下托管 |
| `packages/web` | 框架无关 Web 组件 `<feedback-widget>`（TypeScript Custom Element + Shadow DOM），npm 导入或 `<script>` 加载，导出 `openFeedback()`。运行时依赖只有 `html2canvas-pro`（2.4.2），**且只被内置视口截图路径使用**：ESM 构建（`dist/feedback-web.js`，约 80 KB）把它拆成独立 chunk（约 329 KB）**懒加载**；UMD 构建（`dist/feedback-web.umd.cjs`，约 316 KB）单文件内联。纯文字提交或自定义 `captureProvider` 都不会加载它（体积以 `pnpm --filter @feedback/web build` 的输出为准） |
| `flutter/feedback` | Flutter 包 `feedback_widget`：`FeedbackWidget` 包裹组件 + `FeedbackController` 主动呼出，覆盖 Web/Android/iOS/Windows/macOS/Linux |
| `examples/react` `examples/vue` `examples/flutter` | 框架接入示例：React 19（`StrictMode`、完整 JSX 类型）、Vue 3（`isCustomElement` + 模板 ref）、Flutter（`MaterialApp.builder` 挂载 + 应用根持有控制器 + 第二个路由/宿主对话框） |
| `examples/html` | 原生 HTML 示例：`<script>` 直接加载自托管 UMD 产物，无构建步骤（先构建组件包并拷贝产物，见其 README） |
| `examples/ssr` | 最小 SSR 示例：Node 内置 `http`（无框架）在服务端渲染 HTML，反馈组件只在客户端动态 `import()`——组件入口会触碰浏览器全局，绝不能进服务端 bundle |
| `docs/integration.md` | **完整接入指南**：各框架与 Flutter 的接入步骤、API 清单、已知限制 |
| `docs/api.md` | HTTP 契约（认证、软件配置、连接测试、反馈四组接口与状态机） |
| `docs/deployment.md` | 部署与运维说明 |

## 快速开始（开发）

```bash
corepack enable
pnpm install
pnpm --filter @feedback/admin build
FEEDBACK_MASTER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))') \
FEEDBACK_ADMIN_USER=admin FEEDBACK_ADMIN_PASSWORD=changeme \
pnpm --filter @feedback/server dev
# 服务: http://127.0.0.1:8787  管理页: /admin（旧登录窗口: /login，兼容保留）
```

验证命令：各包均有 `build / test / typecheck / lint` 脚本（`pnpm -r run …`）；Flutter 包用 `flutter analyze` / `flutter test`（见其 README）。

## 生产部署

使用 Docker（推荐）：见 `docs/deployment.md`。数据（SQLite + 密文密钥）全部落在 `FEEDBACK_DATA_DIR`（容器内 `/data`），持久化该卷即可。

## 关键设计

- 提交内容：文字上限 10,000 码点 + 可选截图（限制见上面"截图范围"）；页面上下文（`app-version` / `page-label`）由宿主显式传入，组件不自动抓取页面、参数、日志或剪贴板。
- 原话先入库再返回“已接收”；后台处理可在服务重启后恢复（崩溃于 Kaneo 发送中的记录进入“待核对”，通过任务描述中的反馈 ID 核对，绝不盲目重复创建）。
- AI 只产出标题与结构化整理（使用体验/问题/建议/待确认），来源信息、原话引用与反馈 ID 由服务追加，AI 不决定项目、列或调度。
- Kaneo 目标列以真实 slug 保存；列失效时停止归档并提示修复，不自动创建或改写看板。
- 提交幂等：客户端唯一标识；同标识不同内容返回冲突。
- 登录：Web 组件与 Flutter 都在**当前面板内**用账号密码登录（`POST /api/auth/login` + `clientLabel`/`appId`，Bearer，不依赖跨站 Cookie）；Web 令牌仅存内存，原生 Flutter 用平台安全存储。旧登录窗口握手仍兼容。账号由后台创建分发，不开放注册；每账号默认每天 3 次提交额度，北京时间零点刷新。
- 日志不记录反馈原文、密码或令牌；密钥以主密钥 AES-256-GCM 加密存储（`apps/server/src/crypto/secret.ts`），页面仅显示掩码。
