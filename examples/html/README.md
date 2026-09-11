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
