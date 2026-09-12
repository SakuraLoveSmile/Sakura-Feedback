# Feedback × React 示例

演示在 React 19 + Vite 应用中接入 [`@feedback/web`](../../packages/web) 的 `<feedback-widget>` 自定义元素。
（其它接入方式见 `examples/vue`、`examples/html`、`examples/ssr`、`examples/flutter`；完整指南见 [`docs/integration.md`](../../docs/integration.md)。）

## 运行

```bash
# 仓库根目录
pnpm install
pnpm --filter @feedback/web build      # 先生成组件包产物
pnpm --filter @feedback/example-react dev
```

## 检查

```bash
pnpm --filter @feedback/example-react typecheck   # tsc -p tsconfig.json --noEmit
pnpm --filter @feedback/example-react build       # vite build
```

## 接入步骤

1. 依赖（`package.json`）：

   ```json
   { "dependencies": { "@feedback/web": "workspace:*" } }
   ```

2. 副作用导入即自动注册元素（`src/App.tsx`）：

   ```tsx
   import '@feedback/web';
   ```

3. JSX 里直接用元素，并把**元素实例提升为 state**（`src/App.tsx`）：

   ```tsx
   const [widget, setWidget] = useState<FeedbackWidget | null>(null);
   <feedback-widget ref={setWidget} api-base="..." app-id="..." />;
   ```

   用回调 ref 而不是 `useRef` + `useEffect(..., [])`：事件订阅的 effect 依赖
   "元素身份"，StrictMode 的双调用（setup → cleanup → setup）与 ref 的
   detach/reattach 都能正确对应 add/removeListener。

4. 订阅提交事件（`src/App.tsx`）：

   ```tsx
   useEffect(() => {
     if (!widget) return;
     const onSubmit = (ev: Event) => {
       const { feedbackId, status } = (ev as CustomEvent).detail;
     };
     widget.addEventListener('feedback-submitted', onSubmit);
     return () => widget.removeEventListener('feedback-submitted', onSubmit);
   }, [widget]);
   ```

   `feedback-submitted` 是服务**已接收**提交（201/200）后派发的事件，
   `detail = { feedbackId, status, replayed }`；它不是"已归档到 Kaneo"的通知。

5. 类型声明见 `src/feedback-widget.d.ts`（可直接拷贝到你的项目）：
   `IntrinsicElements['feedback-widget']` 覆盖**全部受支持 attributes** ——
   `api-base` / `app-id` / `app-version` / `page-label` / `side` / `theme` /
   `show-launcher` / `launcher-bottom` / `launcher-mode` / `capture-mode`，
   其中 `launcher-mode`、`capture-mode`、`theme`、`side` 是字面量联合类型
   （写错取值 tsc 会报错）。

6. 打开与截图：

   ```tsx
   widget.open();           // 只打开面板，不截图
   widget.captureAndOpen(); // 截图并打开（截图期间面板自身不入图）
   ```

   ⚠️ `openFeedback()` **内部只调 `open()`**：即使传 `captureMode: 'viewport'`
   也不会立即截图；需要截图请用元素上的 `captureAndOpen()`。

## 关于 StrictMode

`src/main.tsx` 用 `<StrictMode>` 包裹应用。开发模式下 React 会刻意双调用渲染与
effect（mount → unmount → mount），本示例是安全的：

- `<feedback-widget>` 是**真实的 DOM 元素**，React 不会重建它；草稿、登录令牌等
  状态都活在元素实例上，重挂 effect 不会让用户丢失已输入内容；
- 订阅 effect 每次成对 add/removeListener，双调用结束后仍只有一个监听器。

## 属性默认值与显式覆盖

组件默认是 `launcher-mode="tab"`、`capture-mode="off"`（这样升级不会改变旧宿主
行为）。本示例要演示灵感球 + 自动截图，所以**显式**写了这两项：

```tsx
<feedback-widget
  api-base="http://localhost:8787"
  app-id="com.example.demo-react"
  launcher-mode="orb"        {/* 默认 tab */}
  capture-mode="viewport"    {/* 默认 off */}
/>
```

截图范围是**当前应用视口**；灵感球拖拽落点只标记问题位置，没有局部裁剪、
没有系统悬浮窗、不跨应用截图。`data-feedback-capture-mask` 标注的区域
（见 `src/App.tsx` 的敏感数据演示区）在截图中会被中性遮罩覆盖。

## 宿主日志演示（`logProvider`）

示例多了一个按钮「写一条日志」：宿主自己维护**内存日志环形缓冲**
（`src/host-logs.ts`，200 行上限，超出丢最旧的行），`logProvider` 返回它的导出文本：

```tsx
// logProvider 是元素实例的 JS 属性；useMemo 保证引用稳定，StrictMode
// 双调用 effect 时第二次赋值是 no-op，不会打断在途采集。
const logProvider = useMemo<LogProvider>(() => () => exportHostLog(hostLogs), [hostLogs]);
useEffect(() => {
  if (!widget) return;
  widget.logProvider = logProvider;
}, [widget, logProvider]);
```

- `logProvider` 是**元素实例的 JS 属性**（不是 attribute，写在 JSX 上无效）；
  也可以经 `openFeedback({ logProvider })` 传入。
- 组件只在**新草稿首次打开**面板时调用一次（3 秒超时 → 面板给出
  「重试 / 不带日志继续提交」）；关闭重开已有草稿、或用户移除日志后都**不会**自动重新采集。
- 上限：3 个 / 每个 1 MiB / 扩展名 `.log/.txt/.json/.jsonl` / 严格 UTF-8；
  超限会**逐个给出明确原因**（不静默丢弃、不截断）。面板里可预览（截断并说明）、
  移除，也能用原生 `<input type="file" multiple>` 手动补充。
- 示例**不扫盘、不拦截 console**：交给组件的只是宿主本来就有的那点内存日志；
  真实项目请先在宿主侧去掉凭据等敏感内容。

## 连你本地的服务

- `api-base` 改成你的服务地址，`app-id` 必须是服务端登记过的软件标识。
- 页面与反馈服务通常跨源：服务端只对**软件配置里登记的 `allowedOrigins`**
  回显 CORS（`apps/server/src/app.ts`）。Vite 开发服务器默认是
  `http://localhost:5173`，记得把它加进该软件配置的 allowedOrigins。

## 不用打包器

- 原生 `<script>` 直挂 UMD 产物：见 `examples/html`；
- 服务端渲染 + 客户端动态 `import()`：见 `examples/ssr`。
