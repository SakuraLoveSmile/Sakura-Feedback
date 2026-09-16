# Feedback × Vue 示例

演示在 Vue 3 + Vite 应用中接入 [`@feedback/web`](../../packages/web) 的 `<feedback-widget>` 自定义元素。
（其它接入方式见 `examples/react`、`examples/html`、`examples/ssr`、`examples/flutter`；完整指南见 [`docs/integration.md`](../../docs/integration.md)。）

## 运行

```bash
# 仓库根目录
pnpm install
pnpm --filter @feedback/web build      # 先生成组件包产物
pnpm --filter @feedback/example-vue dev
```

## 检查

```bash
pnpm --filter @feedback/example-vue typecheck   # vue-tsc -p tsconfig.json --noEmit
pnpm --filter @feedback/example-vue build       # vite build
```

## 关键一步：把元素排除出 Vue 组件解析（`vite.config.ts`）

```ts
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // <feedback-widget> 是宿主页面注册的 Custom Element，不是 Vue 组件
          isCustomElement: (tag: string) => tag === 'feedback-widget',
        },
      },
    }),
  ],
});
```

不加这个选项，模板编译器会为 `<feedback-widget>` 生成
`_resolveComponent("feedback-widget")`，开发模式会打印
`Failed to resolve component: feedback-widget`（生产构建只是把告警剥掉，查找仍在）。
加上之后编译结果变成普通元素节点：

```
不加：const _component_feedback_widget = _resolveComponent("feedback-widget")
加了：_createElementVNode("feedback-widget", _hoisted_4, null, 512 /* NEED_PATCH */)
```

## 接入步骤

1. 依赖（`package.json`）：

   ```json
   { "dependencies": { "@feedback/web": "workspace:*" } }
   ```

2. 副作用导入即自动注册元素（`src/App.vue`）：

   ```vue
   <script setup lang="ts">
   import '@feedback/web'; // 副作用：自动注册元素
   </script>
   ```

3. 用**模板 ref** 拿元素实例，而不是 `document.querySelector`：

   ```vue
   <script setup lang="ts">
   import { useTemplateRef } from 'vue';
   import type { FeedbackWidget } from '@feedback/web';

   const widget = useTemplateRef<FeedbackWidget>('widget');
   </script>

   <template>
     <feedback-widget ref="widget" api-base="..." app-id="..." />
   </template>
   ```

4. 订阅事件并在卸载时清理（`src/App.vue`）：

   ```ts
   onMounted(() => widget.value?.addEventListener('feedback-submitted', onSubmitted));
   onBeforeUnmount(() => widget.value?.removeEventListener('feedback-submitted', onSubmitted));
   ```

   `feedback-submitted` 的 `detail = { feedbackId, status, replayed }`，表示服务
   **已接收**提交（201/200）。

5. 打开与截图（宿主菜单 / 工具栏同样调用这两个方法）：

   ```ts
   widget.value?.open();           // 只打开面板，不截图
   widget.value?.captureAndOpen(); // 截图并打开
   ```

   ⚠️ `openFeedback()` **内部只调 `open()`**：即使传 `captureMode: 'viewport'`
   也只是配置属性，不会立即截图。示例里第三个按钮演示了这一点（按钮文案已写明
   "仅打开面板，不截图"）。要截图必须调元素的 `captureAndOpen()`。

6. 类型声明见 `src/feedback-widget.d.ts`：`GlobalComponents['feedback-widget']`
   声明了全部受支持 attributes（含 `theme` / `show-launcher` / `launcher-bottom`
   / `launcher-mode` / `capture-mode`），直接拷贝到你的项目即可。

7. 深色模式：用 `theme` 绑定站点主题（`system` / `light` / `dark`，默认跟随系统）：

   ```vue
   <feedback-widget :theme="theme" ... />
   ```

   示例顶部菜单提供了主题切换，文案与面板配色会同步，**不会清空草稿**。

## 属性默认值与显式覆盖

组件默认是 `launcher-mode="tab"`、`capture-mode="off"`（升级不改变旧宿主行为）。
本示例要演示灵感球 + 自动截图，所以**显式**写在元素上：

```html
<feedback-widget
  ref="widget"
  api-base="http://localhost:8787"
  app-id="com.example.demo-vue"
  launcher-mode="orb"        <!-- 默认 tab -->
  capture-mode="viewport"    <!-- 默认 off -->
  :theme="theme"             <!-- 默认 system，与站点主题联动 -->
/>
```

截图范围是**当前应用视口**；灵感球拖拽落点只标记问题位置，没有局部裁剪、
没有系统悬浮窗、不跨应用截图。`data-feedback-capture-mask` 标注的区域在截图中
会被中性遮罩覆盖。

## 提交成功 ≠ 已归档（人工归档流程）

服务端**不再在提交时自动归档**：`feedback-submitted` 的 `detail.status` 是 `received`，
表示"原话已保存、AI 已开始整理"。归档需要管理员在 Feedback 管理页打开该记录，
选择**项目 / 目标列 / 至少一个工作区标签 /（可选）负责人**，再点「保存并归档」。
宿主文案请写「反馈已保存」，不要写「已创建任务」。

## 连你本地的服务

- `api-base` 改成你的服务地址，`app-id` 必须是服务端登记过的软件标识。
- 页面与反馈服务通常跨源：服务端只对**软件配置里登记的 `allowedOrigins`**
  回显 CORS（`apps/server/src/app.ts`）。Vite 开发服务器默认是
  `http://localhost:5173`，记得把它加进该软件配置的 allowedOrigins。
- 管理员口令、AI 密钥、Kaneo 地址与 API Key **只配置在 Feedback 服务端**，
  宿主（含 Blog）不需要也不应持有。

## 不用打包器

- 原生 `<script>` 直挂 UMD 产物：见 `examples/html`；
- 服务端渲染 + 客户端动态 `import()`：见 `examples/ssr`。
