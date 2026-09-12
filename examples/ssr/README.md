# Feedback × SSR 示例

最小服务端渲染示例：Node 内置 `http`（无框架、无构建步骤）在服务端渲染完整
HTML，反馈组件**只在浏览器里**通过动态 `import()` 加载。
（完整接入指南见 [`docs/integration.md`](../../docs/integration.md)；其它接入方式见
`examples/react`、`examples/vue`、`examples/html`、`examples/flutter`。）

## 运行

```bash
# 1. 先构建组件包（必须：本示例直接读取 packages/web/dist）
pnpm --filter @feedback/web build

# 2. 启动 SSR 服务
pnpm --filter @feedback/example-ssr start      # → http://127.0.0.1:3000/
```

可用环境变量：`PORT`（默认 3000）、`FEEDBACK_APP_ID`（默认
`com.example.demo-ssr`）、`FEEDBACK_API_BASE`（默认 `http://localhost:8787`）。

## 为什么组件必须"只在客户端"加载

`@feedback/web` 的入口**顶层就有浏览器副作用**（实测）：

- 导入即注册元素：`packages/web/src/index.ts` 末尾直接调用 `defineFeedbackWidget()`；
- 类定义直接继承 `HTMLElement`：`packages/web/src/element.ts` 的
  `export class FeedbackWidget extends HTMLElement`。

在 Node 里导入 ESM 产物会立刻抛错（本仓库实测，Node v26.7.0）：

```bash
node --input-type=module -e "await import('./packages/web/dist/feedback-web.js')"
# ReferenceError: HTMLElement is not defined
#   at packages/web/dist/feedback-web.js:1226
```

所以服务端渲染只输出 **HTML 标记**（`<feedback-widget ...>` 此刻只是个未知标签），
浏览器拿到页面后才动态 `import()` 组件包并注册自定义元素：

```html
<script type="module">
  // 只在客户端执行
  await import('/vendor/@feedback/web/feedback-web.js');
  const widget = document.getElementById('widget');
  widget.addEventListener('feedback-submitted', (e) => { /* e.detail = { feedbackId, status, replayed } */ });
  document.getElementById('btn-open').addEventListener('click', () => widget.open());
  document.getElementById('btn-capture').addEventListener('click', () => widget.captureAndOpen());
</script>
```

### 用打包器时（Next.js / Nuxt / SvelteKit 等）

同样的规则：不要让组件进入服务端 bundle。

```ts
// React：useEffect 里动态 import（组件只在客户端挂载）
useEffect(() => {
  let dispose: (() => void) | undefined;
  void import('@feedback/web').then(() => {
    const widget = document.querySelector('feedback-widget') as FeedbackWidget;
    const onSubmit = (e: Event) => { /* ... */ };
    widget.addEventListener('feedback-submitted', onSubmit);
    dispose = () => widget.removeEventListener('feedback-submitted', onSubmit);
  });
  return () => dispose?.();
}, []);
```

```tsx
// 或者让框架保证只在浏览器渲染
const FeedbackWidgetLazy = dynamic(() => import('./FeedbackWidgetClient'), { ssr: false });
```

注意 `packages/web/package.json` 里 `"sideEffects": true`：打包器不会因为
"看起来没用到"而删掉这个导入，所以**顶层静态** `import '@feedback/web'`
一旦被打进服务端 bundle，就会在 Node 里执行并报上面的 `HTMLElement` 错误。

## 这一页里哪些是服务端、哪些是客户端

| 部分 | 位置 |
|---|---|
| 页面标题、表格、`<feedback-widget>` 标记、`rendered-at` 时间戳 | **服务端**（`page.mjs` 渲染，见响应里的 `rendered-at`） |
| 自定义元素注册、面板、截图、`feedback-submitted`、按钮接线 | **客户端**（内联 `<script type="module">`） |
| `/vendor/@feedback/web/*` | 服务端把 `packages/web/dist/` 的产物透传给浏览器（不拷贝、不入库；懒加载的 `html2canvas-pro` chunk 同目录，所以整目录透传） |

`api-base` / `app-id` 由服务端注入到元素属性里（`escapeHtml` 转义），
`launcher-mode="orb"` 与 `capture-mode="viewport"` 显式写在标记上
——组件默认是 `tab` / `off`。

## 宿主日志演示（`logProvider`）

按钮「写一条日志」往宿主自己的**内存日志环形缓冲**（200 行上限）里追加一行；
`logProvider` 把它的导出文本交给组件——但**只在客户端**赋值（元素在服务端只是未知标签）：

```js
// 客户端内联模块脚本里（page.mjs）
widget.logProvider = () => ({
  name: 'host-app.log',
  bytes: new TextEncoder().encode(hostLogs.dump()),
});
```

- `logProvider` 是**元素实例的 JS 属性**（不是 attribute，服务端渲染标记里写无效）。
- 组件只在**新草稿首次打开**面板时调用一次（3 秒超时 → 面板给出
  「重试 / 不带日志继续提交」）；关闭重开已有草稿、或用户移除日志后都**不会**自动重新采集。
- 上限：3 个 / 每个 1 MiB / 扩展名 `.log/.txt/.json/.jsonl` / 严格 UTF-8；
  超限会**逐个给出明确原因**（不静默丢弃、不截断）。
- 示例**不扫盘、不拦截 console**：交给组件的只是宿主本来就有的那点内存日志。

## 连你本地的服务

页面与反馈服务通常跨源：服务端只对**软件配置里登记的 `allowedOrigins`**
回显 CORS（`apps/server/src/app.ts`）。示例页面源是 `http://127.0.0.1:3000`，
需要把它加进该软件配置的 allowedOrigins，否则浏览器会拦掉提交请求。

## 检查

```bash
pnpm --filter @feedback/web build
pnpm --filter @feedback/example-ssr typecheck     # node --check 语法检查
PORT=3000 pnpm --filter @feedback/example-ssr start &
curl -s http://127.0.0.1:3000/ | grep -c 'feedback-widget'                            # 2
curl -sI http://127.0.0.1:3000/vendor/@feedback/web/feedback-web.js | head -1         # HTTP/1.1 200 OK
```

未构建组件包时：服务启动会打印警告，页面上的状态区会显示"组件未加载"，
`/vendor/@feedback/web/feedback-web.js` 返回 404 并附带构建提示。
