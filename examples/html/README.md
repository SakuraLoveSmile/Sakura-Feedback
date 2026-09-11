# Feedback × 原生 HTML 示例

没有框架、没有打包器：一个 `<script>` 标签 + 一个自定义元素 + 两个按钮。
适合"我就想在一个静态页/老站点里挂上反馈入口"的场景。
（完整接入指南见 [`docs/integration.md`](../../docs/integration.md)；其它接入方式见
`examples/react`、`examples/vue`、`examples/ssr`、`examples/flutter`。）

## 1. 先构建组件包

```bash
# 仓库根目录
pnpm install
pnpm --filter @feedback/web build
```

`packages/web/dist/` 里与本示例相关的两个产物（实测大小）：

| 文件 | 大小 | 说明 |
|---|---|---|
| `feedback-web.umd.cjs` | 约 316 KB（gzip 约 82 KB） | **单文件、内联 `html2canvas-pro`**；`<script>` 直挂用这个 |
| `feedback-web.js` | 约 80 KB | ESM 版；把 `html2canvas-pro` 拆成独立 chunk（约 329 KB）**懒加载**，纯文字/`captureProvider` 场景不会加载 |

（体积随版本变化，以 `pnpm --filter @feedback/web build` 的输出为准。）

## 2. 把 UMD 产物拷进本目录（不要提交进 git）

```bash
cp packages/web/dist/feedback-web.umd.cjs examples/html/feedback-web.umd.js
```

- 拷贝时**改名成 `.js`**：静态服务器多按扩展名给 MIME，`.cjs` 常被当成
  `application/octet-stream`，浏览器会拒绝执行 classic script。
- 本目录的 `serve.mjs` 对 `.cjs` 也按 JavaScript MIME 返回；你若想保留
  `.cjs` 原名，把 `index.html` 里的 `src` 一起改掉也能跑。
- `examples/html/.gitignore` 已忽略这两个文件名 —— 构建产物不入库，
  请按上面的命令自行拷贝。

## 3. 起静态服务

```bash
pnpm --filter @feedback/example-html serve        # http://127.0.0.1:8080/
```

也支持 `PORT=9000 pnpm --filter @feedback/example-html serve`。
用别的静态服务器也行（注意 `.js` 的 MIME 与缓存）。

## 页面做了什么

```html
<script src="./feedback-web.umd.js"></script>   <!-- 1. 加载 UMD：顶层副作用自动注册元素 -->
<feedback-widget
  api-base="http://localhost:8787"
  app-id="com.example.demo-html"
  launcher-mode="orb"        <!-- 默认是 tab，必须显式写 -->
  capture-mode="viewport"    <!-- 默认是 off，必须显式写 -->
></feedback-widget>
```

- `open()`：只打开面板，**不截图**；`captureAndOpen()`：截图并打开。
  `openFeedback()` 内部只调 `open()`，即使传 `captureMode: 'viewport'`
  也不会立即截图（需要截图请调元素上的 `captureAndOpen()`）。
- `feedback-submitted`：服务**已接收**提交（201/200）后派发，
  `event.detail = { feedbackId, status, replayed }`。
- `data-feedback-capture-mask`：标在任意元素上，截图时整棵子树被中性遮罩覆盖。
- 截图范围是**当前应用视口**；拖拽落点只标记问题位置。没有局部裁剪、
  没有系统悬浮窗、不跨应用截图。

## 连你本地的服务

- `api-base` 改成你的服务地址，`app-id` 必须是服务端登记过的软件标识。
- 页面与反馈服务通常跨源：服务端只对**软件配置里登记的
  `allowedOrigins`** 回显 CORS（见 `apps/server/src/app.ts`）。用本示例的
  `http://127.0.0.1:8080`（或 `http://localhost:8080`）时，记得把它加进该软件
  配置的 allowedOrigins，否则浏览器会拦掉请求。

## 检查

```bash
pnpm --filter @feedback/web build
pnpm --filter @feedback/example-html copy:bundle
PORT=8080 pnpm --filter @feedback/example-html serve &
curl -sI http://127.0.0.1:8080/                    | head -1   # HTTP/1.1 200 OK
curl -sI http://127.0.0.1:8080/feedback-web.umd.js | head -1   # HTTP/1.1 200 OK
```

## 日志接入（`logProvider`）

本示例在 `index.html` 里给元素赋了 `logProvider`，把宿主已有的日志缓冲交给组件（返回前先做一次简单脱敏）：

```js
const hostLogs = [ /* 宿主自己的日志行 */ ];
widget.logProvider = async () => {
  const sanitized = hostLogs
    .map((line) => line.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***'))
    .join('\n');
  return [{ name: 'client.log', bytes: new TextEncoder().encode(sanitized) }];
};
```

- 类型：`() => FeedbackLogPart[] | Promise<FeedbackLogPart[]>`，`FeedbackLogPart = { name, bytes: Uint8Array }`。**不配置就完全不自动采集**（仍可在面板里手动添加）。
- 时机与超时：每份新草稿**首次打开面板时调用一次**，超时 **3 秒**；失败/超时后面板提示「日志获取失败」，可点「重试」或**不带日志继续提交**。面板内另有「+ 添加文件」手动入口。
- 限制（自动 + 手动合计）：≤ **3** 个文件、单份 ≤ **1 MiB**、合计 ≤ **3 MiB**，仅 `.log` / `.txt` / `.json` / `.jsonl`，必须是有效 UTF-8 且不含 NUL。数量/大小超限 → `413 too_large`；其余 → `400 invalid_log`，**整单拒绝**（不会只丢一份）。
- ⚠️ **脱敏是宿主的责任**（组件不做过滤）：去掉 `Bearer`/Token/Cookie/密码等凭据与个人数据。日志**会参与 AI 诊断并被归档到 Kaneo 任务**，请按你的合规要求处理。
- 状态：本轮**已落地（待体验）**——有可用入口，但尚未完成真实环境端到端验收。完整说明见 [`docs/integration.md` 第 9 章](../../docs/integration.md#9-日志接入本轮新增) 与 [`docs/api.md`](../../docs/api.md) 的 L1–L11。
