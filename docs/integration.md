# 完整接入指南（宿主应用 → 反馈服务 → Kaneo）

本篇是**唯一的完整接入入口**。目标读者是从未看过 `apps/server` 源码的宿主开发者：
按本文配置服务、安装组件、挂载悬浮球，即可在独立宿主中完成**登录 → 截图 → 反馈 → 归档**。

- HTTP 字段与认证契约不在本文重复：见 [`docs/api.md`](api.md)。
- 部署、备份、升级/回退等运维细节不在本文重复：见 [`docs/deployment.md`](deployment.md)。
- 已知边界与验证程度见本文第 7.3 节与 [`VERIFICATION.md`](../VERIFICATION.md)。

本文只描述**可直接观察到的黑盒行为**（属性、方法、事件、HTTP 状态、管理页动作），
不展开服务端内部的阶段机。

---

## 1. 接入前准备

### 1.1 三方责任边界

| 角色 | 负责什么 | 不负责什么 |
|---|---|---|
| **宿主应用**（你的 HTML / React / Vue / SSR 站点或 Flutter App） | 提供页面与视口；挂载 `<feedback-widget>` / `FeedbackWidget`；显式传入 `api-base`（`apiBase`）与 `app-id`（`appId`），可选 `app-version` / `page-label`；用 `data-feedback-capture-mask` / `FeedbackCaptureMask` 声明敏感区域；持有组件实例并（Flutter）持有 `FeedbackController` 的生命周期；在宿主 UI 里提供呼出入口 | 不持有 AI / Kaneo 密钥；不指定归档到的 Kaneo 项目或列；不重发"服务端已接收"的反馈；不实现截图、遮挡、幂等、轮询 |
| **反馈服务**（`apps/server`） | 保存原话与截图（先落库再回执）；调 AI 整理；调 Kaneo API 建任务、传图、写评论；提供管理页（`/admin/`）与登录窗口（`/login`）；幂等与限流；以 `FEEDBACK_MASTER_KEY` 加密存放 AI / Kaneo 密钥 | 不自动创建 Kaneo 项目、列或看板；不分配负责人 / 日期 / 里程碑；不托管宿主页面（只托管自己的管理页与登录页）；不重发结果不确定的评论或图片 |
| **Kaneo** | 提供目标项目与列、任务与评论、图片资产的最终宿主；提供 API Key（Kaneo Web UI → 设置 → 账户 → API Keys）；提供任务的真实链接 | 不保存反馈原文的原始存档（原文在服务端 SQLite）；不参与 AI 整理 |

一句话概括数据流（与根 [`README.md`](../README.md) 一致）：
**呼出面板 →（可选）截取当前应用视口并自动遮挡 → 输入文字 → 服务保存原话与截图 → AI 整理 → 写入指定 Kaneo 项目的列**。
每次提交生成一个候选任务，**不自动分配人员、不设置日期、不安排开发**。

### 1.2 从零到跑通的配置顺序

严格按下面的顺序做，每一步都有可观察的"通过"信号：

| # | 谁 / 在哪做 | 做什么 | 通过信号 |
|---|---|---|---|
| 1 | 运维 / 服务端 | 部署反馈服务并设置环境变量：`FEEDBACK_MASTER_KEY`（必填）、首次部署的 `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD`（字段含义见 [`deployment.md`](deployment.md) 第 1 节） | `curl -s http://<host>:8787/healthz` → `{"ok":true}` |
| 2 | 管理员 / 浏览器 | 打开 `http://<host>:8787/admin/` 登录 | 进入管理页 |
| 3 | 管理员 / 管理页「连接配置」 | 填 **Kaneo** API 地址（如 `http://kaneo:1337` 或 `https://kaneo.example.com`，含不含 `/api` 均可）与 API Key，点连接测试 | 测试返回项目名与列列表 |
| 4 | 管理员 / 管理页「连接配置」 | 填 **AI**（OpenAI 兼容 Chat Completions）地址（如 `https://api.openai.com/v1`）、模型与密钥，点连接测试 | 返回 `ping` 回显 |
| 5 | 管理员 / 管理页「软件配置」 | **新建软件**：`appId`（如 `com.example.app`）、名称、**允许来源**（见 1.3）、目标 Kaneo 项目 id、目标列（用「测试项目并加载列」拉真实列 slug 后选择，例如"待筛选"列） | 列表出现该软件配置 |
| 6 | 管理员 / 管理页 | **记下 `appId`** | `appId` 创建后**不可修改**（修改只接受其余字段） |
| 7 | 宿主开发者 / 宿主代码 | 在组件上填 `api-base`（= 第 1 步的服务地址）与 `app-id`（= 第 6 步的 `appId`），可选 `app-version` / `page-label` | 面板能打开、能登录、能提交 |

目标 Kaneo 项目由服务端按 `appId` 决定，**客户端不可指定**；客户端也不认识 Kaneo 地址。

### 1.3 允许来源必须写精确

「允许来源」（`allowedOrigins`）是**逐条精确匹配的 origin 列表**，服务端在保存时会用 `new URL(item).origin`
归一化（[`apps/server/src/routes/admin.ts`](../apps/server/src/routes/admin.ts) 的 `normalizeOriginList`），
登录握手时逐条比对（[`apps/server/src/routes/auth.ts`](../apps/server/src/routes/auth.ts) 的 `validateHandshakeTarget`）。

**origin 的构成是 `协议://主机:端口`，三者任一不同就是不同的来源：**

| 你以为一样 | 实际 | 结论 |
|---|---|---|
| `http://localhost:5173` / `http://127.0.0.1:5173` | 主机名不同 | **必须分别登记两条** |
| `http://localhost:5173` / `https://localhost:5173` | 协议不同 | 必须分别登记 |
| `http://localhost` / `http://localhost:8080` | 端口不同（前者是默认 80） | 必须分别登记 |
| `https://app.example.com/settings` | 路径会被丢弃，归一化为 `https://app.example.com` | 写路径无效，别指望按路径区分 |

实践建议：

- 一个软件配置里把**开发与生产的全部来源**都登记齐，例如
  `http://localhost:5173`、`http://127.0.0.1:5173`、`https://app.example.com`。
- 端口、协议都要写全。漏掉一个的典型后果：登录窗口报 `origin_not_allowed`
  （HTTP 403；来源写法本身非法时是 400），或浏览器因为拿不到 CORS 头而直接拦掉提交请求（见 8.3 第 2、3 条）。
- 跨源规则：`/api/feedback*` 只对**已在任一软件配置中登记的 Origin** 回显 CORS 头（含 `OPTIONS` 预检）；
  管理接口与登录接口不开放跨源。规则细节见 [`docs/api.md`](api.md) 的「跨源（CORS）」一节。
- Flutter 原生（非浏览器）不受 CORS 约束，但 **Web 平台的登录握手仍需登记来源**。

### 1.4 客户端绝不持有 AI 或 Kaneo 密钥

- 客户端只有三样东西：`apiBase`、`appId`、以及登录后拿到并**只属于该服务**的访问令牌。
- AI 与 Kaneo 密钥由管理员在管理页填写，服务端以主密钥做 **AES-256-GCM 加密后落盘**（SQLite）；
  读取接口只回 `apiKeySet: true`，**永不回传明文**。密钥字段与接口见 [`docs/api.md`](api.md)。
- 组件源码与构建产物里没有任何密钥；Flutter 包不读取任何环境密钥。
- 反馈面板里只有"用户名 / 密码"登录输入（Flutter 原生）或跳转服务登录窗口（Web），**没有密钥输入口**。
- 日志不记录反馈原文、密码或令牌。

---

## 2. 安装与版本固定

### 2.1 Web：通过构建出的 npm tarball 安装（打包器宿主推荐）

包名 `@feedback/web`，当前版本 `0.1.0`，因此 tarball 文件名为 **`feedback-web-0.1.0.tgz`**（版本变了文件名跟着变）。

```bash
# ① 在仓库根构建组件包
pnpm install
pnpm --filter @feedback/web build

# ② 打成 tarball（真实产物：/tmp/fbpack/feedback-web-0.1.0.tgz）
mkdir -p /tmp/fbpack
pnpm --filter @feedback/web pack --pack-destination /tmp/fbpack
```

tarball 内含 `dist/` 全部产物（含 ESM 懒加载分块）、`package.json` 与 `README.md`。

```bash
# ③ 在你的宿主项目里安装这个 tgz
pnpm add /tmp/fbpack/feedback-web-0.1.0.tgz
# 等价写法：npm install /tmp/fbpack/feedback-web-0.1.0.tgz
```

```ts
// ④ 副作用导入即自动注册 <feedback-widget>
import '@feedback/web';
```

仓库内示例用 workspace 依赖（`"@feedback/web": "workspace:*"`），宿主用 tarball 路径即可，API 完全一致。
`packages/web/package.json` 里 `"sideEffects": true`：打包器不会因为"看起来没用到"而删掉这个导入。

### 2.2 纯 HTML 自托管 UMD

产物文件名是 **`dist/feedback-web.umd.cjs`**（单文件，`html2canvas-pro` 已内联；实测约 316 KB / gzip 约 82 KB）。

```bash
pnpm --filter @feedback/web build
cp packages/web/dist/feedback-web.umd.cjs examples/html/feedback-web.umd.js
pnpm --filter @feedback/example-html serve        # http://127.0.0.1:8080/
```

```html
<script src="./feedback-web.umd.js"></script>          <!-- 顶层副作用自动注册元素 -->
<feedback-widget api-base="http://localhost:8787" app-id="com.example.app"
                 launcher-mode="orb" capture-mode="viewport"></feedback-widget>
```

拷贝时**改名成 `.js`**：静态服务器多按扩展名给 MIME，`.cjs` 常被当成 `application/octet-stream`，
浏览器会拒绝执行 classic script。构建产物不入库（见 [`examples/html/README.md`](../examples/html/README.md)）。

### 2.3 ESM 自托管：必须**同时部署**动态截图分块

ESM 构建 `dist/feedback-web.js`（约 80 KB）把 `html2canvas-pro` 拆成**独立分块**
`dist/html2canvas-pro.esm-*.js`（实测 328.98 KB / gzip 约 75.5 KB），**在首次触发内置截图时才动态 `import()`**。

- ✅ **整个 `dist/` 目录一起部署**（文件名带内容哈希，每次构建都会变，例如当前的 `html2canvas-pro.esm-CQ8baKsv.js`）。
- ❌ 只部署 `feedback-web.js` 一个文件 → 用户第一次点"截图"时动态 import **404**，截图直接失败（见 8.3 第 10 条）。
- 纯文字反馈或使用自定义 `captureProvider` 时不会加载该分块，但**不要因此不做部署**。
- 用打包器（Vite / webpack 等）时无需手工处理：构建产物会自动带上该分块（见 `examples/react`、`examples/vue` 的构建输出）。
- 参考实现：[`examples/ssr/server.mjs`](../examples/ssr/server.mjs) 就是把整个 `packages/web/dist/` 透传到 `/vendor/@feedback/web/`，正是为了这个懒加载分块。

### 2.4 Flutter：`path` 依赖或固定 Git commit

包名 `feedback_widget`，**该包 `publish_to: none`——不发布到 pub.dev**（见 [`flutter/feedback/pubspec.yaml`](../flutter/feedback/pubspec.yaml)），
因此**不能**写 `feedback_widget: ^0.1.0`。

本地 / 同仓（仓库内示例的写法，[`examples/flutter/pubspec.yaml`](../examples/flutter/pubspec.yaml)）：

```yaml
dependencies:
  feedback_widget:
    path: ../../flutter/feedback
```

跨仓库（固定 Git commit + `flutter/feedback` 子目录）：

```yaml
dependencies:
  feedback_widget:
    git:
      url: https://<你的仓库地址>.git
      ref: <固定的 commit sha>      # 不要用分支名，避免"昨天能编、今天不能编"
      path: flutter/feedback        # 包在仓库的子目录里
```

> 上面是 Dart pub 的标准 git 依赖写法（`url` / `ref` / `path`）。本仓库内没有任何文件使用该形式，
> 仓库内的示例走的是 `path` 依赖——跨仓库写法属于**未在本仓库验证**的配置。

拉依赖：

```bash
cd your_app && /Users/sakurasep/flutter/bin/flutter pub get
```

### 2.5 工具版本要求

| 工具 | 要求 | 依据 |
|---|---|---|
| Node.js | **≥ 22.13** | 根 [`package.json`](../package.json) 的 `engines.node` |
| 包管理 | **pnpm**（本仓库是 pnpm workspace；`packageManager: pnpm@11.23.0`） | 根 `package.json`、[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) |
| Flutter | **≥ 3.27** | [`flutter/feedback/pubspec.yaml`](../flutter/feedback/pubspec.yaml) 的 `flutter: ">=3.27.0"` |
| Dart | **^3.6** | 同上 `sdk: ^3.6.0` |

补充：服务端有一个原生依赖 `sharp`（截图的校验与重编码），安装时会带平台相关的 libvips 二进制；
数据库是 Node 内置的 `node:sqlite`，不需要额外 SQLite 模块。

### 2.6 本次交付**不包含**的内容（明确边界）

- ❌ **不发布 `@feedback/web` 到 npm registry**：只在本仓库 `build` + `pack`，由宿主安装本地 tgz。
- ❌ **不发布 `feedback_widget` 到 pub.dev**（包内 `publish_to: none`）。
- ❌ **不做 Git push / tag / 发布流水线**：跨仓库引用所需的 commit sha 由你自行提交后取得。
- ❌ **不做真实部署**：Docker 镜像构建与上线见 [`docs/deployment.md`](deployment.md)，由你自行执行。

---

## 3. 完整接入示例

五份示例与 `examples/` 下的真实工程一一对应。**所有"悬浮球"示例都显式写了入口模式**，
因为 Web 组的默认值是 `launcher-mode="tab"` + `capture-mode="off"`，Flutter 的默认值是
`FeedbackLauncherMode.tab` + `FeedbackCaptureMode.off`——**不显式写就不会有灵感球，也不会截图**（升级不会改变旧宿主行为）。

### 3.1 原生 HTML（[`examples/html`](../examples/html)）

无框架、无打包器：一个 `<script>` + 一个自定义元素 + 两个按钮。

| 文件 | 作用 |
|---|---|
| [`examples/html/index.html`](../examples/html/index.html) | 页面本体：UMD `<script>`、元素声明、事件订阅、按钮接线 |
| [`examples/html/serve.mjs`](../examples/html/serve.mjs) | 零依赖静态服务器（把 `.js/.mjs/.cjs` 一律按 JavaScript MIME 返回） |
| [`examples/html/README.md`](../examples/html/README.md) | 构建 / 拷贝 / 起服务 / 检查命令 |

```bash
pnpm install
pnpm --filter @feedback/web build
pnpm --filter @feedback/example-html copy:bundle      # 产出 examples/html/feedback-web.umd.js
pnpm --filter @feedback/example-html serve            # http://127.0.0.1:8080/
# 也支持 PORT=9000 pnpm --filter @feedback/example-html serve
```

```html
<script src="./feedback-web.umd.js"></script>

<!-- launcher-mode 默认是 tab、capture-mode 默认是 off：必须显式写，否则没有灵感球、也不会截图 -->
<feedback-widget
  id="widget"
  api-base="http://localhost:8787"
  app-id="com.example.demo-html"
  app-version="1.0.0"
  page-label="home"
  side="right"
  launcher-mode="orb"
  capture-mode="viewport"
></feedback-widget>

<script>
  const widget = document.getElementById('widget');
  widget.addEventListener('feedback-submitted', (event) => {
    const { feedbackId, status, replayed } = event.detail;   // 服务端已接收
  });
  document.getElementById('btn-open').addEventListener('click', () => widget.open());
  document.getElementById('btn-capture').addEventListener('click', () => widget.captureAndOpen());
</script>
```

`api-base` 与 `app-id` 改成你自己的值；页面来源（本示例是 `http://127.0.0.1:8080`，用 `localhost` 访问时是
`http://localhost:8080`）必须写进该软件配置的允许来源（见 1.3）。

### 3.2 React + TypeScript（[`examples/react`](../examples/react)）

React 19 + Vite，演示 `StrictMode`、Custom Element 的 TS 类型、事件清理。

| 文件 | 作用 |
|---|---|
| [`examples/react/src/main.tsx`](../examples/react/src/main.tsx) | 入口，`<StrictMode>` 包裹（开发模式会刻意双调用渲染与 effect） |
| [`examples/react/src/App.tsx`](../examples/react/src/App.tsx) | 回调 ref 提升元素实例、事件订阅与清理、显式入口模式、敏感区演示 |
| [`examples/react/src/feedback-widget.d.ts`](../examples/react/src/feedback-widget.d.ts) | JSX 类型声明（可整份拷进你的项目） |
| [`examples/react/vite.config.ts`](../examples/react/vite.config.ts) | 普通 React 配置（React 侧**不需要**像 Vue 那样排除自定义元素） |

```bash
pnpm -C examples/react build       # vite build
pnpm -C examples/react typecheck   # tsc -p tsconfig.json --noEmit
pnpm --filter @feedback/example-react dev
```

四条关键约束：

1. **副作用导入**：`import '@feedback/web';` —— 导入即自动注册元素。
2. **把元素实例提升为 state**（不要 `useRef` + `useEffect(..., [])`）：

   ```tsx
   const [widget, setWidget] = useState<FeedbackWidget | null>(null);
   <feedback-widget ref={setWidget} api-base="…" app-id="…" launcher-mode="orb" capture-mode="viewport" />
   ```

   事件订阅的 effect 依赖"元素身份"，因此 StrictMode 的双调用（setup → cleanup → setup）
   与 ref 的 detach / reattach 都能正确对应 `addEventListener` / `removeEventListener`。

3. **事件清理必须成对**：

   ```tsx
   useEffect(() => {
     if (!widget) return;
     const onSubmit = (ev: Event) => { const d = (ev as CustomEvent).detail; };
     widget.addEventListener('feedback-submitted', onSubmit);
     return () => widget.removeEventListener('feedback-submitted', onSubmit);
   }, [widget]);
   ```

4. **补 Custom Element 的 TS 类型声明**：不补的话 TS 不认识 `<feedback-widget>`。
   仓库里的 [`examples/react/src/feedback-widget.d.ts`](../examples/react/src/feedback-widget.d.ts) 覆盖**全部受支持 attributes**，
   其中 `launcher-mode` / `capture-mode` / `theme` / `side` 是字面量联合类型（写错取值 `tsc` 会报错）。

**StrictMode 生命周期注意点**：开发模式下 React 会 mount → unmount → mount。
本示例是安全的，因为 `<feedback-widget>` 是**真实的 DOM 元素**，React 不会重建它——
草稿、登录令牌等状态都活在元素实例上，重挂 effect 不会让用户丢失已输入内容；
订阅 effect 每次成对 add/remove，双调用结束后仍只有一个监听器。

完整片段与说明见 [`examples/react/README.md`](../examples/react/README.md)。

### 3.3 Vue 3 + Vite（[`examples/vue`](../examples/vue)）

| 文件 | 作用 |
|---|---|
| [`examples/vue/vite.config.ts`](../examples/vue/vite.config.ts) | **必配** `isCustomElement` |
| [`examples/vue/src/App.vue`](../examples/vue/src/App.vue) | 模板 ref、事件订阅与卸载清理、三个按钮（含 `openFeedback()` 的行为演示） |
| [`examples/vue/src/feedback-widget.d.ts`](../examples/vue/src/feedback-widget.d.ts) | `GlobalComponents['feedback-widget']` 声明 |

```bash
pnpm -C examples/vue build       # vite build
pnpm -C examples/vue typecheck   # vue-tsc -p tsconfig.json --noEmit
```

**必须配 `isCustomElement`**，否则模板编译器会为 `<feedback-widget>` 生成
`_resolveComponent("feedback-widget")`，开发模式打印 `Failed to resolve component: feedback-widget`
（生产构建只是把告警剥掉，查找仍在）：

```ts
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag === 'feedback-widget',
        },
      },
    }),
  ],
});
```

用法要点：

```vue
<script setup lang="ts">
import '@feedback/web';                       // 副作用：自动注册元素
import { useTemplateRef, onMounted, onBeforeUnmount } from 'vue';
import type { FeedbackWidget } from '@feedback/web';

const widget = useTemplateRef<FeedbackWidget>('widget');   // 用模板 ref，不要 document.querySelector

onMounted(() => widget.value?.addEventListener('feedback-submitted', onSubmitted));
onBeforeUnmount(() => widget.value?.removeEventListener('feedback-submitted', onSubmitted));
</script>

<template>
  <feedback-widget ref="widget" api-base="…" app-id="…"
                   launcher-mode="orb" capture-mode="viewport" />
</template>
```

### 3.4 SSR（[`examples/ssr`](../examples/ssr)）

Node 内置 `http`（无框架、无构建步骤）在服务端渲染完整 HTML，反馈组件**只在客户端动态 `import()`**。

| 文件 | 作用 |
|---|---|
| [`examples/ssr/server.mjs`](../examples/ssr/server.mjs) | HTTP 服务：`/` 渲染页面、`/vendor/@feedback/web/*` 透传组件产物 |
| [`examples/ssr/page.mjs`](../examples/ssr/page.mjs) | 服务端渲染的 HTML 与客户端内联脚本 |
| [`examples/ssr/README.md`](../examples/ssr/README.md) | 为什么必须只在客户端加载、服务端/客户端分工表 |

```bash
pnpm --filter @feedback/web build                 # 必须先构建（示例直接读取 packages/web/dist）
pnpm --filter @feedback/example-ssr typecheck     # node --check server.mjs && node --check page.mjs
pnpm --filter @feedback/example-ssr start         # http://127.0.0.1:3000/
# 可用环境变量：PORT（默认 3000）、FEEDBACK_APP_ID、FEEDBACK_API_BASE
```

> `examples/ssr` **没有 `build` 脚本**（它不是构建型示例）：`pnpm -C examples/ssr build` 会以
> `ERR_PNPM_NO_SCRIPT`（exit 1）失败，这是预期的；它的"检查"命令是 `typecheck` + `start` + `curl`。

**绝不能宣传"服务端可以直接 import 组件"**。`@feedback/web` 的入口**顶层就有浏览器副作用**：

- 导入即注册元素：`packages/web/src/index.ts` 末尾直接调用 `defineFeedbackWidget()`；
- 类定义直接继承 `HTMLElement`：`packages/web/src/element.ts` 的 `class FeedbackWidget extends HTMLElement`。

在 Node 里导入 ESM 产物会立刻抛错（[`examples/ssr/README.md`](../examples/ssr/README.md) 实测，Node v26.7.0）：

```bash
node --input-type=module -e "await import('./packages/web/dist/feedback-web.js')"
# ReferenceError: HTMLElement is not defined
```

正确做法：服务端只输出 **HTML 标记**（`<feedback-widget …>` 此刻只是个未知标签），
浏览器拿到页面后才动态 `import()` 并注册元素：

```html
<script type="module">
  await import('/vendor/@feedback/web/feedback-web.js');       // 仅客户端
  const widget = document.getElementById('widget');
  widget.addEventListener('feedback-submitted', (e) => { /* e.detail = { feedbackId, status, replayed } */ });
  document.getElementById('btn-open').addEventListener('click', () => widget.open());
  document.getElementById('btn-capture').addEventListener('click', () => widget.captureAndOpen());
</script>
```

用打包器（Next.js / Nuxt / SvelteKit 等）时规则相同：**不要让组件进入服务端 bundle**。
`useEffect` 里动态 `import('@feedback/web')`，或用框架的"仅客户端"开关
（如 `next/dynamic` 的 `{ ssr: false }`）。因为 `packages/web/package.json` 里 `"sideEffects": true`，
打包器不会因为"看起来没用到"而删掉这个导入——一个**顶层静态** `import '@feedback/web'`
被打进服务端 bundle，就会在 Node 里执行并抛出上面的 `HTMLElement` 错误。

### 3.5 Flutter（[`examples/flutter`](../examples/flutter)）

| 文件 | 作用 |
|---|---|
| [`examples/flutter/pubspec.yaml`](../examples/flutter/pubspec.yaml) | `feedback_widget` 走 `path: ../../flutter/feedback` |
| [`examples/flutter/lib/main.dart`](../examples/flutter/lib/main.dart) | **`MaterialApp.builder` 包裹整个 Navigator 子树**；控制器由应用根持有并 `dispose` |
| [`examples/flutter/lib/home_page.dart`](../examples/flutter/lib/home_page.dart) | 第一个路由：`controller.open()` / `controller.captureAndOpen()` |
| [`examples/flutter/lib/details_page.dart`](../examples/flutter/lib/details_page.dart) | **第二个路由**：验证悬浮球跨页存活 |
| [`examples/flutter/lib/host_dialog.dart`](../examples/flutter/lib/host_dialog.dart) | **宿主对话框**：验证截图包含宿主对话框、不包含反馈面板 |
| [`examples/flutter/lib/sensitive_card.dart`](../examples/flutter/lib/sensitive_card.dart) | `FeedbackCaptureMask` 敏感区演示 |
| [`examples/flutter/test/widget_test.dart`](../examples/flutter/test/widget_test.dart) | 4 个用例：冒烟 / 跨路由不重建 / 截图范围（含像素断言）/ 根卸载后控制器已 dispose |

```sh
cd examples/flutter
/Users/sakurasep/flutter/bin/flutter analyze   # 本机实测：No issues found!（exit 0）
/Users/sakurasep/flutter/bin/flutter test      # 本机实测：4 个用例全过（exit 0）
/Users/sakurasep/flutter/bin/flutter run -d chrome     # 或 -d macos
```

**挂载位置（本示例的核心）**：组件通过 `MaterialApp.builder` 包裹应用自己的 **Navigator 子树**，
而不是某个页面的 child。于是 push / pop 路由不会重建组件——灵感球在任何路由下都在场，
草稿、截图与登录令牌也不会因为导航丢失。

```dart
MaterialApp(
  routes: <String, WidgetBuilder>{
    HomePage.routeName: (context) => HomePage(controller: _feedback),
    DetailsPage.routeName: (context) => const DetailsPage(),
  },
  builder: (BuildContext context, Widget? child) {   // child = 应用自己的 Navigator 子树
    return Navigator(                                 // 只承载组件、不做跳转的外层 Navigator
      onGenerateRoute: (settings) => PageRouteBuilder<void>(
        settings: settings,
        transitionDuration: Duration.zero,
        reverseTransitionDuration: Duration.zero,
        pageBuilder: (context, a, b) => FeedbackWidget(
          config: FeedbackConfig(
            'http://localhost:8787',        // apiBase：改成你的服务地址
            'com.example.demo',             // appId：服务端已登记
            appVersion: '1.0.0',
            pageLabel: pageLabel,           // 必须由宿主显式传入
            side: FeedbackSide.right,
            launcherMode: FeedbackLauncherMode.orb,      // 默认 tab，必须显式写
            captureMode: FeedbackCaptureMode.viewport,   // 默认 off，必须显式写
          ),
          controller: _feedback,           // 由应用根持有
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
  },
)
```

**控制器生命周期**：`FeedbackController` 是根 `StatefulWidget` 的字段，只在根的 `dispose()` 里释放
（[`examples/flutter/lib/main.dart`](../examples/flutter/lib/main.dart)）；页面只接收它，不创建也不释放
（[`examples/flutter/lib/home_page.dart`](../examples/flutter/lib/home_page.dart)）。

**为什么 `builder` 里还有一层"外层 Navigator"**：面板里的 `TextField` 需要 `Overlay` 祖先才能建立选择浮层，
截图放大预览用的 `showDialog()` 也需要 `Navigator` / `Overlay` 祖先，而应用自己的 Navigator 在组件**之下**，
祖先查找只向上走。由此带来一条**宿主注意事项**：这层外层 Navigator 就是 `rootNavigator`，
宿主自己 `showDialog(...)` 若用默认的 `useRootNavigator: true`，对话框会被推到组件**上方**——
既压住灵感球，也不会进入截图。所以 `host_dialog.dart` 显式用 `useRootNavigator: false`，
让对话框落在应用自己的 Navigator 里（= 宿主内容）。

**第二个路由 + 宿主对话框验证什么**：灵感球跨页存活；截图**包含宿主对话框**（宿主 UI），
但**不包含反馈面板自己**（面板在截图边界之外）。

---

## 4. 配置与方法 / 事件完整清单

### 4.1 Web 属性（attribute ↔ property）

属性名是 kebab-case，对应的 property 是 camelCase；两者都可用（`element.apiBase = '…'` 等价于 `setAttribute('api-base', '…')`）。

| attribute | prop | 类型 / 可选值 | 默认值 | 说明 | **变化时的副作用** |
|---|---|---|---|---|---|
| `api-base` | `apiBase` | string（含协议） | 无（必填） | 反馈服务地址，如 `http://localhost:8787` | **完整身份切换**：取消在途捕获 / 提交 / 轮询 / 握手，清空访问令牌、任务态与草稿；**新服务必须重新登录**（旧服务的 `Authorization` 绝不发给新基址） |
| `app-id` | `appId` | string | 无（必填） | 服务端登记的软件标识 | **同一服务内**切换：草稿 / 捕获 / 旧提交结果 / 轮询 / 绑定旧 `appId` 的握手全部作废；**令牌保留**（服务未变，无需重新登录） |
| `app-version` | `appVersion` | string | 无 | 随 `context.appVersion` 上报（服务端最多取 50 字符） | 只刷新头部 `vX.Y.Z · 页面标签`，**不清空草稿** |
| `page-label` | `pageLabel` | string | 无 | 随 `context.pageLabel` 上报（服务端最多取 200 字符） | 只刷新头部信息，**不清空草稿** |
| `side` | `side` | `left` \| `right` | `right` | 入口停靠在左侧还是右侧 | 纯样式，不影响草稿 / 令牌 / 截图 |
| `theme` | `theme` | `system` \| `light` \| `dark` | `system` | 主题 | 只改样式，**不清空草稿** |
| `show-launcher` | `showLauncher` | 字符串属性：只有 `"false"` 表示隐藏，其余值（含缺省）都显示 | 显示（`true`） | 是否显示内置入口 | 纯展示 |
| `launcher-bottom` | `launcherBottom` | CSS 长度字符串（百分比或像素，如 `25%` / `80px`） | `25%` | 入口距底部的垂直位置 | 纯展示 |
| `launcher-mode` | `launcherMode` | `tab`（贴边标签） \| `orb`（**灵感球**，可拖拽指出位置并截图） | **`tab`** | 入口形态 | 纯展示；切到 `orb` 时标签隐藏、切到 `tab` 时灵感球隐藏。**不影响草稿与截图开关** |
| `capture-mode` | `captureMode` | `off` \| `viewport` | **`off`** | 呼出时是否**自动**截取当前应用视口 | 只改下一次呼出的行为；**不清空草稿**。`off` 只关闭**自动**截图：面板里始终有手动的「截取当前页面」 |

**明确结论（易踩坑）**：

- `launcher-mode` 与 `capture-mode` 的默认值是 `tab` / `off`。**不显式写就不会有灵感球，也不会自动截图。**
- `capture-mode="off"` **不等于没有截图入口**：用户仍可在面板里点「截取当前页面」手动截图（先输入文字也能截、失败可重试、移除后可补拍）。希望「呼出即截图」才需要 `capture-mode="viewport"`。
- `page-label` / `app-version` / `theme` 变化**绝不清空草稿**。
- 提交来源取自**提交瞬间冻结的快照**：快照冻结后再改 `page-label`（含后续重试）不会改变请求的元数据与截图字节。
- 属性会在页面里被读回来（`widget.launcherMode` 等），取值非法时回落默认值（例如 `launcher-mode="orb2"` 等价于 `tab`）。

### 4.2 Flutter `FeedbackConfig` 参数

`FeedbackConfig(apiBase, appId, {...})` 是**不可变**配置对象（字段全 `final`），在构造 `FeedbackWidget` 时传入。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiBase`（位置参数，必填） | `String` | — | 反馈服务地址；必须是 http(s) 且主机名非空（断言）；**末尾 `/` 会被去掉** |
| `appId`（位置参数，必填） | `String` | — | 服务端登记的软件标识（会 trim） |
| `appVersion` | `String?` | `null` | 仅在显式传入时随提交上报 |
| `pageLabel` | `String?` | `null` | 仅在显式传入时随提交上报 |
| `side` | `FeedbackSide.left` \| `FeedbackSide.right` | `FeedbackSide.right` | 悬浮按钮停靠侧，同时决定宽屏抽屉展开方向 |
| `position` | `Offset?` | `null` | 见下方优先级规则 |
| `theme` | `FeedbackThemeMode.system` \| `.light` \| `.dark` | `.system` | 主题模式 |
| `showLauncher` | `bool` | `true` | 是否显示内置入口 |
| `launcherBottom` | `String` | `'25%'` | 入口距可用区域底部的位置；支持百分比（`25%`）、像素（`80px`）或裸数字；**解析失败回落 25%** |
| `launcherMode` | `FeedbackLauncherMode.tab` \| `.orb` | **`.tab`** | 经典侧边悬浮按钮 / 灵感球 |
| `captureMode` | `FeedbackCaptureMode.off` \| `.viewport` | **`.off`** | 关闭截图 / 呼出时捕获当前视口完整截图 |

**`position` 的优先级规则**（[`flutter/feedback/lib/src/widget.dart`](../flutter/feedback/lib/src/widget.dart)）：

- 垂直位置：`position.dy` **优先于** `launcherBottom`；未传 `position` 时才用 `launcherBottom` 解析值。
- 距停靠边的水平内缩：`position.dx`，未传时默认 **20 逻辑像素**。
- `side` 决定"停靠边"是哪一边（`left` → 左内缩，`right` → 右内缩）。

运行中改变**服务身份**（`apiBase` / `appId`）：Flutter 端**未定义也未验证**热切换语义——
`FeedbackConfig` 是构造参数，包内未导出运行时替换配置的入口。要换服务或换软件，请**重建 `FeedbackWidget` 实例**。
（Web 端有明确的身份切换语义，见 4.1 与 5.3。）

### 4.3 方法

| 能力 | Web（元素实例 / `FeedbackWidget` class） | Flutter（`FeedbackController`，导出见 [`feedback_widget.dart`](../flutter/feedback/lib/feedback_widget.dart)） |
|---|---|---|
| 打开面板（**不截图**） | `open()` | `open()` |
| 关闭面板（并取消进行中的截图） | `close()` | `close()`（即使面板未展开也会通知监听者，用于让进行中的捕获会话失效） |
| **截图并打开** | `captureAndOpen(opts?)`，`opts.releasePoint` 为灵感球拖拽落点（0..1 视口比例） | `captureAndOpen({Offset? releasePoint})` |
| 取消进行中的截图 | `cancelCapture()` | `cancelCapture()` |
| 切换开关 | — | `toggle()` |
| 读取开关状态 | 面板状态可在 DOM 上观察（`aria-expanded` 等） | `isOpen`（`FeedbackController` 是 `ChangeNotifier`） |
| 主动开始登录握手 | `startLogin()`（返回登录页 URL） | 面板内触发（原生表单 / Web 弹窗握手） |

行为细节（两端一致）：

- **`captureAndOpen()` 遇到已有草稿时"恢复草稿、不重拍"**：面板已持有文字或截图时，任何呼出入口都不重新截图，
  原有的文字与截图字节原样恢复，避免新图覆盖用户正在编辑的内容。
- `close()` 会同时取消进行中的截图（即使面板尚未打开）；迟到结果被静默丢弃。
- **重拍是唯一替换旧截图的入口**（面板内的「重新截图」）；只有重拍成功才替换旧图，失败 / 取消 / 中途关闭都保留旧图。

**模块级辅助函数（Web）**：`openFeedback(options?)`——若页面上还没有 `<feedback-widget>` 就动态创建一个，
配置传入的选项，然后打开面板。**它内部只调用 `open()`，不会截图**（见 4.5）。

### 4.4 事件（Web）：`feedback-submitted`

| 项 | 值 |
|---|---|
| 名称 | `feedback-submitted` |
| 派发位置 | `<feedback-widget>` 元素实例上 |
| 选项 | `bubbles: true` + `composed: true`（穿过 Shadow DOM 冒泡） |
| `detail` | `{ feedbackId, status, replayed }` |
| 触发时机 | 提交被**服务端接收**（HTTP 201，或同 key 同内容的幂等重放 200 `replayed: true`）之后 |

> ⚠️ **语义必须按这句话理解**：`feedback-submitted` 表示「**服务端已接收**」，
> **不是**「Kaneo 已归档」。此时后台的 AI 整理与 Kaneo 写入**还没开始或还没完成**。
> 要知道是否真正归档，请轮询 `GET /api/feedback/:id`（面板自己就在做这件事：2s 起指数退避、封顶 5s），
> 归档成功后会展示任务链接。接口细节见 [`docs/api.md`](api.md)。

**Flutter 没有等价的 `feedback-submitted` 事件**：`FeedbackController` 是 `ChangeNotifier`，
只暴露面板开关状态（`isOpen`）——包内**不导出**提交事件流。提交/归档进度在面板 UI 内呈现
（`FeedbackStage`：撰写 / 提交未送达 / 已接收 / 处理中 / 已归档 / 服务端记录失败 / 幂等冲突）。
宿主若要感知结果，请以面板 UI 与 `GET /api/feedback/:id` 为准。

### 4.5 纠正既有文档错误：`openFeedback()` 不能承诺立即截图

历史文档里出现过"调用 `openFeedback({ captureMode: 'viewport' })` 就会截图"的说法，**这是错的**。
[`packages/web/src/index.ts`](../packages/web/src/index.ts) 的实现是：

```ts
// 组装/配置元素之后：
widget.open();     // ← 只有这一句
```

因此：

- `openFeedback()` **只确保元素存在并调用 `open()`**；传 `captureMode: 'viewport'` 只是**配置属性**，
  不会立即拍摄，也不会触发 `captureAndOpen()`。
- 需要"拖完立刻截图并打开面板"时**必须**调用元素上的 `captureAndOpen()`（Flutter 是 `controller.captureAndOpen()`）。
- 原生 HTML / Vue / React 三个示例都把这一点写在页面上或按钮文案里（`examples/vue` 的第三个按钮即专门演示此行为）。

---

## 5. 路由、生命周期与交互

### 5.1 单页应用路由切换（Web）

- **组件实例应由宿主顶层持有**：把 `<feedback-widget>` 放在应用壳（root layout / App 组件）里，
  而不是某个会被卸载的路由页面组件内。草稿（文字 + 截图字节）**只存在元素实例内存中**，
  元素被销毁后再新建一个，草稿就没了。
- **从 DOM 断开重连的草稿语义**：元素被移除后重新插入（同一实例），
  文字与**截图字节保留在实例上**，重连时重建预览 URL（`connectedCallback`）；
  但断开会使**进行中的捕获会话失效、停止轮询、取消登录握手**（`disconnectedCallback`）。
  也就是说：断开重连"草稿还在"，但"在途的事情全部作废"，重新登录 / 重新截图由用户操作触发。
- 建议整个宿主只挂**一个**实例：多个实例各自持有草稿、令牌与状态，页面上也会出现多个入口。
- 路由变化时更新 `page-label` 即可（变化不清草稿）；**不要**在路由切换时改 `api-base` / `app-id`
  ——那会触发身份切换并清空草稿（见 5.3）。

### 5.2 Flutter 挂载位置与控制器生命周期

- 用 **`MaterialApp.builder` 包裹整个 Navigator 子树**（见 3.5 的代码与理由），
  不要在页面里挂组件——否则页面被 push/pop 时组件会被重建，草稿与登录状态随之丢失。
- **控制器由应用根持有**：`FeedbackController` 只应在根的 `dispose()` 中释放；
  页面只接收并调用它（`examples/flutter` 的 `test/widget_test.dart` 断言了组件 State、
  控制器实例与面板 State 在导航前后是**同一个对象**）。
- `builder` 里额外的外层 Navigator 是 `rootNavigator`：宿主自己 `showDialog(...)` 要用
  `useRootNavigator: false` 才会落在组件下方、成为"宿主内容"（并进入截图）。
- `pageLabel` 必须由宿主显式传入：示例用 `NavigatorObserver` 把当前命名路由同步给组件
  （匿名路由如对话框不会改变 `pageLabel`）。

### 5.3 服务身份切换（运行时改 `api-base` / `app-id`）

`api-base` 与 `app-id` 共同构成**服务身份**，任一变化都会递增实例内的身份世代，
所有异步操作（提交、轮询、捕获会话、登录握手回调）在恢复后若世代不符即整体 no-op——
**旧服务 / 旧身份的迟到结果绝不写入新身份的状态**（不写 feedbackId、不改相位、不清草稿、不派发事件、不启动轮询）。

| 变化 | 取消什么 | 清空什么 | 保留什么 | 需要重新登录？ |
|---|---|---|---|---|
| `api-base` 变化 | 捕获会话、提交快照与幂等键、登录握手、轮询 | 访问令牌、任务态（feedbackId / 最近记录 / 错误摘要 / 降级链接）、草稿（含 textarea） | —（相位复位 `idle`） | **是**。切换后未重新登录时组件不会发出任何请求 |
| `app-id` 变化 | 草稿、捕获、旧提交结果、轮询、绑定旧 `appId` 的握手 | 同上（相位复位 `idle`） | **访问令牌**（服务未变） | 否 |

Flutter 端：见 4.2 末尾（未定义热切换语义，请重建组件实例）。

### 5.4 交互约定

Web：

- **Esc**：先关闭截图放大预览，再关闭面板（Esc 只在焦点位于组件内时生效）。
- **焦点**：打开时聚焦输入框；关闭时把焦点还给呼出入口（灵感球 / 标签）；面板内有 focus trap；
  使用 `role="dialog"` + `aria-modal`；尊重 `prefers-reduced-motion`。
- **拖拽**：灵感球拖拽释放后，落点作为 `releasePoint`（0..1 归一化）随截图元数据上报，**只标记问题在哪**。
- **入口可见性**：面板打开时入口隐藏，关闭后恢复。

Flutter：

- **Esc**：关闭面板（组件内 `Shortcuts` / `Actions` 绑定）。
- **宽屏（≥ 768px，`kFeedbackWideBreakpoint`）**：面板以侧边抽屉展开，宽度 = `min(400, 视口宽度)`
  （`kFeedbackPanelWidth = 400`），点遮罩可关闭；**窄屏**为全屏页面式。
- **入口可见性**：面板打开时入口不渲染（`if (!open && config.showLauncher)`），关闭后恢复。
- 灵感球：单击 = 按 `captureMode` 决定是否截图；拖拽（位移 > 8 逻辑像素）释放 = **总是**带落点截图并打开
  （例外：面板已持有草稿 / 截图时不重拍，直接恢复草稿，见 4.3）。

---

## 6. 截图范围、遮挡与隐私

### 6.1 截图范围：**当前应用可见视口**（请务必读这一段）

> **截图范围 = 当前应用的可见视口。**
> 拖拽落点**只用于指出问题位置**，不做任何裁剪，也不改变截图范围。
> **本次不提供局部裁剪、不提供系统级悬浮窗、不支持跨应用截图**——
> 拍不到别的窗口、别的应用、别的显示器或桌面。**请不要把它描述或当成系统截图工具。**

| 端 | 截的是什么 | 明确不包含 |
|---|---|---|
| Web | **宿主页面视口**（当前可见区域，由页面渲染管线产出） | 组件自身的反馈 UI（面板与入口永不出现在截图中）；浏览器界面；其它标签页或窗口；桌面 |
| Flutter | `FeedbackWidget` 包住的**宿主子树**（`RepaintBoundary` 边界）的当前完整视口 | 系统悬浮窗 / 状态栏等系统 UI；反馈面板自身（位于截图边界之外，无需入图再擦除） |

两端一致的两个推论：

1. 截图**不是**"整页截图"（不滚动、不拼接全文档），只拍**呼出那一刻屏幕上可见的内容**。
2. 想要"用户能自己框选一块区域"的能力**本次没有**；请改用敏感区遮挡 + 文字描述（见 6.2）。

### 6.2 遮挡：可复制的示例

敏感区域在**最终位图**上被**不透明中性遮罩**（`rgb(110,110,115)` = `#6E6E73`）覆盖；
**遮挡验证完成前绝不编码 PNG、绝不生成预览**。

Web：

```html
<!-- ① 任意元素标注该属性：整棵子树在截图时被中性遮罩覆盖 -->
<div data-feedback-capture-mask>
  <p>卡号：6222 0000 1234 5678</p>
</div>

<!-- ② 密码输入框自动受保护，无需手工标注 -->
<input type="password" value="…">
```

React / Vue 里写法相同（都编译成同一个 DOM 属性）：`<div data-feedback-capture-mask>…</div>`。

Flutter：

```dart
// ① 用 FeedbackCaptureMask 包裹敏感子树（跨实例移动会自动重新注册到最近的组件实例）
FeedbackCaptureMask(
  child: Text('卡号：6222 0000 1234 5678'),
)

// ② 标准 obscureText 输入区域自动纳入保护
TextField(obscureText: true)
```

遮罩颜色可自定义（Flutter 为 `FeedbackCaptureMask(maskColor: …)`）：截图时**只取 RGB 分量并强制不透明**。

遮挡语义摘要：在**克隆文档 / 位图后处理**中完成遮挡，真实页面零修改；
定位失败、遮挡坐标非有限，或最终位图无法验证（如 canvas 被跨源图片污染）→ **本次截图失败**：
保留旧草稿与旧截图，提示「截图未完成，可重试或继续文字反馈」，**绝不让用户以为截好图了**。
明确在截图视口之外的敏感节点可忽略。Web 端完整三步语义见 [`packages/web/README.md`](../packages/web/README.md) 的「截图与敏感区遮挡」；
Flutter 端见 [`flutter/feedback/README.md`](../flutter/feedback/README.md) 的「截图与遮挡」。

### 6.3 图片限制（两端一致）

| 限制 | 值 |
|---|---|
| PNG 字节数 | **≤ 5 MiB** |
| 最长边 | **≤ 2048 px**（输出像素） |
| 总像素 | **≤ 4,000,000** |
| 缩放系数 | `scale = min(dpr, 2, 2048 / 最长逻辑边, sqrt(4_000_000 / 逻辑面积))` |
| 超 5 MiB 时 | 按 **×0.8** 缩小重编码，最多 **3 次**（每轮重填遮挡并重新验证）；仍超限 → **截图失败，不发送超限图** |

服务端会独立复测与重编码 PNG，并**再次**施加同样的上限；multipart 请求体另有 6 MiB 上限，
超限返回 `413 too_large`。元数据区分**逻辑视口尺寸**（`viewportWidth/Height`，CSS 像素）与
**输出像素尺寸**（`pixelWidth/pixelHeight`）——字段定义见 [`docs/api.md`](api.md)，本文不重复。

### 6.4 渲染边界与自定义 `captureProvider`

内置截图路径基于 `html2canvas-pro`，**受其渲染能力限制**：

- 跨源图片需要 CORS，否则会被跳过（图片位置留下空白）；
- **iframe 内容不保证还原**（通常拍不到 iframe 内部）；
- 部分高级 CSS 与 WebGL 内容不保证还原。

需要像素级保真时，Web 端可使用**自定义 `captureProvider`**（完整契约见
[`packages/web/README.md`](../packages/web/README.md) 的「captureProvider（自定义截图）」）。

硬约束（必须遵守）：

- 页面存在**可见敏感区域**时，provider **必须提供同帧遮挡证明**
  （`sameFrameMasking: true` + `maskedRegions`，遮挡与截图同帧完成），**否则组件拒绝使用该截图**；
- 返回值统一校验：PNG 类型、`0 < size ≤ 5MiB`、边 ≤ 2048、像素 ≤ 4M、遮挡坐标有限 / 为正 / 在输出范围内；
- 无敏感标记的页面上，只返回 `{ blob, width, height }` 的旧式回调保持兼容；
- `signal` abort 后本会话结果被丢弃且不报错；替换 `captureProvider`（含置空）会使进行中的旧捕获立即失效。

Flutter 端**没有**等价的 `captureProvider` 扩展点（`feedback_widget` 未导出该能力）——
Flutter 端只提供内置视口截图 + `FeedbackCaptureMask` 遮挡。

---

## 7. 登录、网络与平台配置

### 7.1 Web 登录握手时序

1. 组件内「登录」→ 打开 `"<apiBase>/login?appId=<appId>&nonce=<r>&cb=<encodeURIComponent(宿主 origin)>"`
   （实现为 `window.open(url, "feedback_login", "popup,width=480,height=640")`）。
2. 用户在服务自己的窗口完成 `POST /api/auth/login`（建立 `SameSite=Lax` 的 Cookie 会话；HTTPS 部署下 `Secure`）。
3. 登录页调用 `POST /api/auth/handshake { appId, origin }`（服务端**再次**校验 origin 在该 `appId` 的
   `allowedOrigins` 内，不在则 `403 origin_not_allowed`）→ 获得**短期访问令牌**（默认 900 秒）。
4. 登录页 `window.opener.postMessage({ type: "feedback:auth", nonce, accessToken, expiresAt }, cbOrigin)` 后自行关闭。
5. 组件**严格校验三件事**：`event.origin === 服务 origin`、`type === "feedback:auth"`、`nonce` 匹配——
   三者全对才接受令牌；令牌**仅存组件实例内存**。

其他要点：

- **弹窗被拦截**时 `window.open` 返回 `null`：组件降级显示「打开登录窗口」的普通链接（`target="_blank"`），点击同样能完成流程。
- **令牌只属于签发它的服务**：`api-base` 变化即清空并需重新登录；旧服务的令牌绝不随请求发送给新基址。
- **令牌过期**：组件保留草稿，重新走 1–5；重开软件后走同一流程，由服务域 Cookie 静默完成第 2 步
  （登录页检测到有效 Cookie 时跳过表单直接执行 3–4）。
- **不依赖第三方 Cookie**：会话 Cookie 只在同站第一方上下文使用；跨源提交走 Bearer + 已登记 Origin 的 CORS 头。
- **会话撤销**：管理页可列出并撤销会话（`GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、
  `POST /api/auth/sessions/revoke-all`），撤销后对应 Bearer 令牌同时失效。接口见 [`docs/api.md`](api.md)。

### 7.2 Flutter 登录

- **原生平台**：面板内用户名 / 密码表单 → `POST /api/auth/login`（携带 `clientLabel`，形如
  `flutter-macos-<iso 时间>`）→ 返回**长期可撤销令牌**（默认 90 天）→ 存入平台安全存储
  （`flutter_secure_storage`；`SecureFeedbackTokenStore(config: …)`）。
  后续请求带 `Authorization: Bearer <token>`；收到 **401** 时清除令牌并回到登录视图。密码不写日志。
- **令牌按服务身份分槽**：原生存储键由 `apiBase` + `appId` 派生
  （[`flutter/feedback/lib/src/token_store.dart`](../flutter/feedback/lib/src/token_store.dart) 的 `feedbackTokenStorageKey`）：

  ```
  feedback_widget.bearer_token.<base64url(apiBase + "\u0000" + appId)>   // 去掉 = 填充
  ```

  同一台设备上，不同 Feedback 服务、或同一服务的不同 `appId` **各占一个槽位**；
  读取时用同一派生键，因此**换服务读不到旧服务的令牌（返回 `null`），不会跨服务串用凭据**；
  键是确定性的，且只含平台存储后端的安全字符（`A–Z a–z 0–9 - _ .`）。
- **Flutter Web**：走与 Web 组件相同的弹窗 + `postMessage` 握手，短期令牌**仅存内存**
  （不持久化，因此不需要服务隔离键）；弹窗被拦截时提供「打开登录窗口」入口。
- Flutter 原生（非浏览器）不受 CORS 约束；但 **Flutter Web 仍受**，需登记来源。

### 7.3 验证程度：代码支持 / 构建验证 / 实机闭环（诚实标注）

下表把三种证据分开。**"实机闭环"指**：真实宿主 + 真实运行的服务端 + 真实 Kaneo（含 AI 密钥）
跑完整登录 → 截图 → 反馈 → 归档。第 3 轮**已经真实跑过**：真实系统 Chrome + 真实服务端（Kaneo / AI 为 mock）的 Web 全链路，
以及真实服务端 + **真实 AI** + **真实 Kaneo** 的纯文字闭环（图文闭环被所配模型能力挡住，见下表）。
除此之外的行一律写"未验证"，**不得读作已通过**。

| 能力 | 代码支持（本仓库文件） | 构建 / 自动化验证（真实运行） | 实机闭环 |
|---|---|---|---|
| Web 组件构建与打包 | `packages/web` | ✅ `pnpm --filter @feedback/web build`、`pnpm --filter @feedback/web pack`（本轮实跑，产出 `feedback-web-0.1.0.tgz`） | —（构建产物本身无需闭环） |
| 原生 HTML / UMD | [`examples/html`](../examples/html) | ✅ 本轮：`copy:bundle` exit 0；`serve` 后 `/` 与 `/feedback-web.umd.js` 均 `HTTP/1.1 200 OK` | ❌ **未验证**（未在真实宿主机 + 真实服务端联调提交） |
| React + TS | [`examples/react`](../examples/react) | ✅ 本轮：`pnpm -C examples/react build` exit 0（vite 产物含懒加载分块）；`typecheck` exit 0 | ✅ 真实浏览器加载该示例产物 + 真实服务端跑通「登录 → 截图 → 反馈 → 归档」（Kaneo / AI 为 mock） |
| Vue 3 + Vite | [`examples/vue`](../examples/vue) | ✅ 本轮：`pnpm -C examples/vue build` exit 0；`typecheck` exit 0；`isCustomElement` 已证明（产物中 `resolveComponent` 计数 0） | ✅ 真实浏览器加载该示例产物 + 真实服务端跑通完整链路（Kaneo / AI 为 mock） |
| SSR（客户端动态加载） | [`examples/ssr`](../examples/ssr) | ✅ 本轮：`typecheck` exit 0；`start` 后 `/` 返回 200 且含 `feedback-widget` 标记（`grep -c` = 2），vendor 产物 `feedback-web.js` 与懒加载分块 `html2canvas-pro.esm-CQ8baKsv.js` 均 `HTTP/1.1 200 OK` | ❌ **未验证** |
| Flutter 组件与示例 | `flutter/feedback`、[`examples/flutter`](../examples/flutter) | ✅ 本轮：`flutter analyze` → `No issues found!`（exit 0）；`flutter test` → 4 个用例全过（exit 0） | ❌ **未验证**（未连真实服务端跑完整提交） |
| 浏览器端到端（登录握手 / 提交 / 草稿 / 窄屏等） | `e2e/run_browser.py` | ✅ 第 4 轮：`python3 e2e/run_browser.py` **237/237 通过**（真实系统 Chrome + 真实服务端），含灵感球拖动落点、像素级遮挡、异源 / 错 nonce 登录、切换 `api-base` 后的凭据隔离、**默认 `capture-mode=off` 下截图区必须真的隐藏且必须能看到「截取当前页面」**（`[hidden]` 级联回归），以及**真实侧边标签 → 打开不自动截图 → 手动截图 → 像素 / 放大 / 重拍 → multipart 落库**（P6）与**窄屏 + 键盘 Enter 的手动截图**（P7） | ✅ Web 端已在真实浏览器 + 真实服务端跑通「登录 → 截图 → 反馈 → 归档」（Kaneo / AI 为 mock） |
| 像素级遮挡安全性 | Web：`packages/web/test/masking.test.ts`；Flutter：`test/capture_mask_pixel_test.dart` | ✅ 自动化像素断言通过；**第 3 轮补上真实浏览器像素验证**（Pillow 解码最终 PNG：遮罩区 68676/68676、密码框区 14868/14868 全为 `rgb(110,110,115)`；泄漏型 provider 被拒且从未上传） | ✅ 真实浏览器遮挡断言已验证 |
| 真实 Kaneo + AI 图文归档 | [`apps/server/src/pipeline/worker.ts`](../apps/server/src/pipeline/worker.ts)、[`apps/server/src/services/kaneo-http.ts`](../apps/server/src/services/kaneo-http.ts) | ✅ 真实 AI + 真实 Kaneo 的**纯文字**闭环已跑通（落库任务链接指向真实 Kaneo 任务） | ⚠️ **图文闭环 BLOCKED（且当前会「静默降级」）**：截图采集/上传/入库全部正常（`hasScreenshot: true`、`capture.releasePoint` 已持久化），但所配 AI **看不到图**——当前端点是编码套餐 `.../api/coding/v3`，视觉模型在该端点一律 404；用纯红图探针实测当前模型 `deepseek-v4-flash` 带图与不带图回答完全相同（图片被静默丢弃）。**同一条生产路径有时返回 400（硬失败）、有时返回 200 并照常归档**，即"AI 从未看过截图却归档成功"。**接入方务必自测**：`POST /api/feedback` 带截图后确认 AI 输出确实引用了截图中可见的界面内容；换支持视觉的模型/端点前不得认为图文能力可用 |
| 管理页恢复动作（retry / resolve / recover） | `apps/admin`、[`apps/server/src/routes/feedback.ts`](../apps/server/src/routes/feedback.ts) | ⚠️ 仅 API 级验证（含 `409 busy` / `revision_conflict` / `target_changed`、`allowedActions` 与 `actionNotes` 内容） | ❌ 真实浏览器点击操作**未验证** |
| Docker 容器级重启恢复 | [`Dockerfile`](../Dockerfile)、`e2e/run_docker.py` | ✅ 第 3 轮重跑：**59/59 通过**（真实容器 + 8 次 `docker restart`），覆盖**图文归档每个远端写入阶段**的中途重启恢复契约（任务创建 / 预签名 / 字节 PUT / finalize / 评论，含地址过期与同 key 被拒）；未挂载仓库真实 `./data` | ✅ 容器级已验证（外部服务为宿主 mock） |
| Android / iOS 构建 | [`examples/flutter`](../examples/flutter) | ⚠️ 第 1 轮已验证（apk --debug / ios --no-codesign）；第 3 轮只跑 `analyze` + `test` | ❌ **未验证**（本轮未重跑构建，也未在真实设备上安装运行） |

---

## 8. 失败处理与故障排查

### 8.1 两类失败：先分清"到没到服务端"

| | **A 类：提交未到达服务端** | **B 类：服务端已接收，但后台失败** |
|---|---|---|
| 判据 | 网络异常 / 超时 / 未拿到任何 HTTP 响应（Flutter 为 `FeedbackStage.notSent`；Web 端是 `failed` 相位下**没有**任何反馈记录的分支） | 已经拿到 `feedbackId`；`GET /api/feedback/:id` 返回 `failed` 或 `needs_review`（Web 端为 `failed` 相位下**已有记录**的分支；面板把它显示为"失败，已记录，可在管理页处理"） |
| 客户端该做什么 | **保留草稿**；提供「重试提交」 | **绝不重新提交**；改用「刷新状态」/「复制反馈标识」，并把标识交给管理员在管理页找回 |
| 幂等键 | 重试**复用同一幂等键与同一字节**（正文 + 截图字节 + 元数据）；只有当冻结快照**变化**（改文案、重拍得到新截图、移除截图）时才换新 key | 不适用。面板「返回编辑」后用户再次提交的是**全新反馈（新 key）**，不是重发旧工单 |
| 服务端视角 | 没有该记录 | 已有原话与截图；同 key 不同内容会返回 `409 idempotency_conflict`（组件**不自动换 key**） |
| 典型错误码 | 网络错误 / `5xx`（结果未知） | `failed` / `needs_review`（详情见 8.2） |

配套约束：`409 idempotency_conflict` 显示冲突、**不自动换 key**；结果未知的提交（网络错误 / 5xx）
在草稿被修改时保留原请求标识与时间供人工核对，新内容用新 key 重新提交。

### 8.2 归档恢复语义（黑盒）

**`needs_review`（待核对）是什么**：服务端**不确定** Kaneo 那边到底写没写成功。
它不是普通失败，也不是"稍后自动重试"——它表示"必须人工核对"，面板对用户显示为
「失败（已记录，可在管理页处理）」。

进入 `needs_review` 的典型原因（都可观察）：

- Kaneo 超时 / 断连 / 5xx（创建任务、上传、登记资产、写评论任一环节）；
- 评论已提交但随后列表核对**未发现**该评论；
- 服务在发送中崩溃 / 重启（`archiving` 中断）；
- 恢复数据损坏、版本未知，或阶段与恢复数据互相矛盾；
- 上传地址已过期，或同 key 重传被业务拒绝；
- 已保存的归档目标（Kaneo 地址 / 项目 / 工作区）与当前配置不一致。

**管理页各恢复动作做什么、风险是什么**（管理页只渲染服务端 `allowedActions` 里允许的动作）：

| 动作 | 针对 | 做什么 | 风险 / 副作用 |
|---|---|---|---|
| `retry`（重试处理） | 处理流程 | 把 `failed` 重新入队；已有 AI 整理结果时跳过 AI 直接再归档 | 会继续产生远端写入 |
| `recheck`（重新核对） | 任务 | 优先使用**已有 task ID**（不重复搜索、不重置阶段）；没有 task ID 才按任务描述中的 `反馈ID：<uuid>` 搜索；命中 → 关联为已归档；未命中 → **维持 `needs_review`** | 只读，**不会重发任何评论或图片** |
| `force-create`（再次创建任务） | 任务创建 | 仅允许"任务创建结果未知且无任何已知 task / 附件 / 评论状态"的记录（否则 `409`）；清空写入类状态后重建 | **可能产生重复任务**，仅在确认 Kaneo 中确实没有对应任务时使用 |
| `retry_comment`（针对评论） | 评论 | 执行前**再次查重**（反馈 ID + 图片摘要 + 当前资产引用）：命中 → 补记确认并归档（**零远端写入**）；未命中 → **重发一次**评论 | 远端列表与写入之间存在竞态，**仍可能产生重复评论**，请在 Kaneo 中复核 |
| `replace_upload`（针对图片） | 图片 | 先经鉴权资产下载核对真实字节（一致 → 仅补记，不替换）；替换时**复用原 task**、申请新上传地址、保留旧 key 记录（`replacedKeys`）、**不自动删除远端对象**；替换后重发评论 | 远端旧对象须**人工清理**；这是"上传地址过期 / 被拒"的唯一出路 |

**两条硬性语义（务必记住）**：

1. **自动路径从不重复发送评论**。自动重试只有"确认未发送过"（`not_sent`）才会继续；
   若评论结果未知（`maybe_sent`）或已确认（`confirmed`）而核对未命中，自动路径**停止并转待核对**，
   只有管理页显式点 `retry_comment` 才允许发送一次。
2. **上传地址过期或被拒时不会自动换新地址**。同 key 重传次数有上限（3 次）；
   超过上限 / 地址过期 / 被拒绝 → 转 `needs_review`，由管理员显式执行 `replace_upload` 才申请新地址
   （自动换 key 会遗留未被追踪的旧对象，因此被有意禁止）。

其他相关语义：

- **并发与过期页面**：所有管理动作带 `expectedRevision` 乐观锁——页面数据过期返回
  `409 revision_conflict`（请刷新后重试）；同一反馈正被其它操作处理返回 `409 busy`；
  远端读 / 写失败返回 `502 recover_failed` 且**状态不变**（不触发替代写入）。
- **目标改变**：人工恢复动作会先固定一份 Kaneo 连接配置并与已保存目标比对；
  不一致 → `409 target_changed`，**零远端写入**且恢复数据原样保留。
- **列失效**（改名 / 删除）→ `failed` 并提示修复配置；服务**不会**自动创建列或改写看板。
- 运维视角的备份、升级顺序与**回退限制**（产生远端写入后不得简单恢复旧库重放）见
  [`docs/deployment.md`](deployment.md) 第 2、4 节，本文不重复。

### 8.3 常见症状 → 原因 → 处理

| 症状（可观察） | 可能原因 | 处理 |
|---|---|---|
| 提交返回 `401`，面板要求重新登录 | 令牌已过期（Web 组件/Flutter Web 的短期令牌默认 15 分钟；Flutter 原生的长期令牌默认 90 天），或从未登录 | 点登录完成握手 / 在 Flutter 面板内登录；确认 `api-base` 没被改过（改过就必须重新登录） |
| 浏览器控制台报 CORS 错误、请求被拦，服务端日志却没有该请求 | 宿主 origin 未被登记（服务端只对已登记 Origin 回显 CORS 头） | 管理页 → 软件配置 → 把**精确 origin**（协议 + 主机 + 端口）加进允许来源；`localhost` 与 `127.0.0.1` **分别登记**（见 1.3） |
| 登录窗口报 `origin_not_allowed`（403，来源写法非法时为 400），或页面提示"来源不合法" | 握手的 `cb`（宿主 origin）不在该 `appId` 的 `allowedOrigins` 内 | 同上；注意协议与端口也要完全一致 |
| 提交返回 `404 unknown_app` | `app-id` 与服务端登记的 `appId` 不一致，或该软件配置被删 | 核对管理页「软件配置」里的 `appId`（创建后不可改）；`app-id` 必须逐字符一致 |
| 提交返回 `409 idempotency_conflict` | 同一个幂等键被用于**不同内容**（例如手改了内容却复用旧 key） | 组件不自动换 key；修改内容后重新提交（新 key 自然生成） |
| 提交返回 `413 too_large` | 文字 > 10,000 码点；截图超限（>5 MiB / 最长边 >2048 / 总像素 >4M）；或 multipart 体 > 6 MiB | 缩短文字；在面板里重拍截图（会自动按限制缩放重编码）；仍不行则改用纯文字反馈 |
| 管理页恢复动作报 `409 target_changed` | 已保存的归档目标与**当前** Kaneo 配置不一致（Kaneo 地址 / 项目 / 工作区被改过） | 把配置改回原目标，或按 `needs_review` 人工处理该记录；该动作**不会**发出任何远端写入 |
| 恢复动作报 `409 revision_conflict` / `409 busy` / `502 recover_failed` | 页面数据过期 / 同一反馈正被其它操作处理 / 远端读写出错 | 刷新页面重试；稍后重试；`recover_failed` 时状态未变，可重试或人工核对 |
| 提交或登录返回 `429` | 限流：登录 10 次 / 15 分钟 / IP+用户名；提交 60 次 / 小时 / 会话 | 按 `Retry-After` 等待后重试 |
| 截图一直没出现，提示"截图未完成，可重试或继续文字反馈" | 敏感节点无法在克隆中定位 / 遮挡坐标非有限 / 最终位图无法验证（如 canvas 被跨源图片污染）；或 PNG 缩小重编码 3 次后仍 > 5 MiB | 重试；缩小窗口尺寸；处理会被跳过的跨源图片（补 CORS 或去掉）；改用自定义 `captureProvider`（有敏感区时**必须**提供同帧遮挡证明）；或直接用纯文字反馈 |
| 浏览器控制台出现动态 `import()` **404**（文件名形如 `html2canvas-pro.esm-*.js`） | ESM 自托管时**只部署了 `feedback-web.js`**，漏了懒加载分块 | 部署**整个 `packages/web/dist/`**（见 2.3）；或改用 UMD 单文件 |
| Vue 开发模式打印 `Failed to resolve component: feedback-widget` | 未配 `isCustomElement` | 按 3.3 配置 `vite.config.ts` |
| TS 报未知 JSX 元素 / 模板类型错误 | 未补 Custom Element 的类型声明 | 拷贝 3.2 / 3.3 的类型声明文件 |
| 服务端（Node）运行时报 `ReferenceError: HTMLElement is not defined` | 在服务端 import 了组件入口（SSR / 打包器把它打进了服务端 bundle） | 只在客户端动态 `import()`；用 `ssr: false` / `useEffect`（见 3.4） |
| 后台归档后记录停在 `failed`，提示"Kaneo 目标列已失效" | Kaneo 侧的列被改名或删除（服务端按列 slug 归档） | 管理页重选该软件配置的目标列（用「测试项目并加载列」取真实 slug），再点「重试处理」；服务**不会**自动建列 |
| 记录停在 `failed`，提示"Kaneo 连接未配置"或"认证失败" | 连接配置缺失 / API Key 失效 / 主密钥不匹配导致密钥无法解密 | 管理页「连接配置」重填并测试；若提示主密钥问题，说明环境变量 `FEEDBACK_MASTER_KEY` 与写入密钥时不一致 |
| 归档卡在 `needs_review` 且反复出现 | 远端写入结果不确定（超时 / 断连 / 5xx / 服务在发送中崩溃 / 上传地址过期或被拒） | **不要再让用户重新提交**；按 8.2 在管理页执行 `recheck` → 必要时 `retry_comment` / `replace_upload`（注意各自风险） |
| 灵感球不显示 / 点了不截图 | 未显式设置入口模式（默认 `tab` + `off`）；或面板已打开时入口被隐藏 | 显式写 `launcher-mode="orb"` + `capture-mode="viewport"`（Flutter：`FeedbackLauncherMode.orb` + `FeedbackCaptureMode.viewport`）；关闭面板 |
| 默认 `capture-mode="off"` 时找不到截图入口 / 输入文字后无法补拍 | 这里的 `off` 只表示**不自动截图**；面板里应始终有手动的「截取当前页面」，无截图时不应出现缩略图或「重新截图 / 移除截图」 | 升级到本轮修复后的 Web 组件；面板内点「截取当前页面」即可手动截图（与文字草稿互不影响）。若按钮不可见，检查宿主是否用 CSS 压掉了 `[hidden]`（组件已内置 `[hidden]{display:none!important}` 兜底） |
| Flutter 面板里输入框选择浮层 / 截图放大预览异常 | 组件挂载位置缺少 `Overlay` / `Navigator` 祖先 | 按 3.5 用 `MaterialApp.builder` + 外层 Navigator 包裹 |
| Flutter 宿主对话框压住灵感球，或不出现在截图里 | `showDialog` 默认 `useRootNavigator: true`，对话框被推到组件上方 | 用 `useRootNavigator: false` 让对话框落在应用自己的 Navigator 里 |

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/api.md`](api.md) | HTTP 契约：认证、软件配置、连接测试、反馈接口与状态机、multipart `capture` 字段、跨源规则 |
| [`docs/deployment.md`](deployment.md) | 部署与运维：环境变量、Docker、备份/迁移、升级与回退限制、处理与失败行为 |
| [`README.md`](../README.md) | 项目总览、仓库结构、关键设计 |
| [`packages/web/README.md`](../packages/web/README.md) | Web 组件权威参考：属性 / 方法 / 事件 / 截图与遮挡 / `captureProvider` 契约 / 包体与懒加载 |
| [`flutter/feedback/README.md`](../flutter/feedback/README.md) | Flutter 包权威参考：平台支持、遮挡、捕获会话、草稿与提交、登录、令牌存储键 |
| [`examples/html/README.md`](../examples/html/README.md) | 原生 HTML：UMD 自托管与静态服务 |
| [`examples/react/README.md`](../examples/react/README.md) | React 19 + Vite：类型声明、StrictMode、事件清理 |
| [`examples/vue/README.md`](../examples/vue/README.md) | Vue 3 + Vite：`isCustomElement`、模板 ref |
| [`examples/ssr/README.md`](../examples/ssr/README.md) | SSR：为什么只能在客户端动态加载 |
| [`examples/flutter/README.md`](../examples/flutter/README.md) | Flutter 示例：`MaterialApp.builder` 挂载、第二路由与宿主对话框、构建备注 |
| [`VERIFICATION.md`](../VERIFICATION.md) | 验证记录与**未验证 / BLOCKED** 清单 |
