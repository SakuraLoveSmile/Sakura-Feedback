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
| **反馈服务**（`apps/server`） | 保存原话与截图（先落库再回执）；调 AI **整理内容**；提供管理页（`/admin/`）与登录窗口（`/login`）；**由管理员在管理页逐条完成人工分类（项目 / 列 / 工作区标签 / 可选负责人）并显式授权归档**后才调 Kaneo 建任务、挂标签、传图、写评论；幂等与限流；以 `FEEDBACK_MASTER_KEY` 加密存放 AI / Kaneo 密钥 | 不自动创建 Kaneo 项目、列或看板；不自动分配标签或负责人；**提交成功不再自动归档**，也不会因为重启或保存草稿而发起远端写入；不托管宿主页面（只托管自己的管理页与登录页）；不重发结果不确定的评论或图片 |
| **Kaneo** | 提供目标项目与列、工作区级标签、工作区成员、任务与评论、图片资产的最终宿主；提供 API Key（Kaneo Web UI → 设置 → 账户 → API Keys）；提供任务的真实链接 | 不保存反馈原文的原始存档（原文在服务端 SQLite）；不参与 AI 整理 |

一句话概括数据流（与根 [`README.md`](../README.md) 一致）：
**呼出面板 →（可选）截取当前应用视口并自动遮挡 → 输入文字 → 服务保存原话与截图 → AI 整理内容 →（后台停止，等待人工）→ 管理员在管理页选择项目 / 列 / 标签 / 可选负责人 →「保存并归档」→ 写入 Kaneo**。
每次提交生成一个候选任务，**不自动分配人员、不设置日期、不安排开发**。

### 1.2 从零到跑通的配置顺序

严格按下面的顺序做，每一步都有可观察的"通过"信号：

| # | 谁 / 在哪做 | 做什么 | 通过信号 |
|---|---|---|---|
| 1 | 运维 / 服务端 | 部署反馈服务并设置环境变量：`FEEDBACK_MASTER_KEY`（必填）、首次部署的 `FEEDBACK_ADMIN_USER` / `FEEDBACK_ADMIN_PASSWORD`（字段含义见 [`deployment.md`](deployment.md) 第 1 节） | `curl -s http://<host>:8787/healthz` → `{"ok":true}` |
| 2 | 管理员 / 浏览器 | 打开 `http://<host>:8787/admin/` 登录 | 进入管理页 |
| 3 | 管理员 / 管理页「连接配置」 | 填 **Kaneo** API 地址（如 `http://kaneo:1337` 或 `https://kaneo.example.com`，含不含 `/api` 均可）与 API Key，点连接测试 | 测试返回项目名与列列表 |
| 4 | 管理员 / 管理页「连接配置」 | 填 **AI**（OpenAI 兼容 Chat Completions）地址（如 `https://api.openai.com/v1`）、模型与密钥，点连接测试 | 返回 `ping` 回显 |
| 5 | 宿主开发者 / 宿主代码 | 在组件上填 `api-base`（= 第 1 步的服务地址）、`app-id`（宿主自己的稳定标识，如 `com.example.app`）与可选 `app-name` / `app-version` / `page-label` | 面板能打开、能登录、能提交 |
| 6 | 管理员 / 管理页「软件配置」 | 首次提交后列表里会**自动出现**这条软件（待配置）：确认它的**来源**（新来源需点「确认来源」） | 来源变为「已确认」 |
| 7 | 管理员 / 管理页「软件配置」 | 选 **Kaneo 项目** → **目标列** → **至少一个工作区标签** →（可选）负责人，点「保存配置（不触发归档）」 | 规则完整（列表显示 `规则 v1`），**此时不会归档** |
| 8 | 管理员 / 管理页「软件配置」 | 点「**启用自动归档并处理积压**」 | 积压与后续反馈各归档一次，状态 `已归档`，出现 Kaneo 任务链接 |

> 也可以完全走**人工归档**：不启用自动归档，改为在管理页「反馈」里逐条选择项目 / 目标列 /
> 至少一个工作区标签 /（可选）负责人，点「保存并归档」。

**软件的默认项目与列只用于预填**：自动归档用它们作为规则的来源；人工归档时管理页只是首次预选，
标签与负责人**绝不自动选择**。启用自动归档前会实时核对目标在 Kaneo 中是否仍然有效。

### 1.3 允许来源（v7 起不再是登录前置）

> v7 起组件端点的跨域对**任意合法 http(s) Origin** 回显（Bearer + `credentials: omit`，不带 Cookie），
> 登录与提交都不再要求来源已登记。下面这节的「允许来源」现在只有两个用途：
> ① 旧版登录窗口握手（`/login` + `/api/admin/feedback` 的兼容路径）仍按白名单校验；
> ② 管理员在后台登记的来源会被直接记为**已确认来源**（免去再点一次确认）。
> 因此新接入**可以完全跳过这一步**——首次提交会自动登记来源，管理员在「软件配置」里确认即可。

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

### 1.5 人工分类与归档流程（提交成功不再自动归档）

这是与早期版本最大的行为差别，请在接入前确认运维与产品都理解：

1. **提交成功只代表"已接收 + 已整理内容"**。服务端保存原话、截图与日志附件后调用 AI 整理；
   整理完成（成功或失败）记录停在 `需要补充信息`，**不会**写入 Kaneo。
   - AI 失败不是错误：保留原文，标题回退为原文首个非空行，管理页可重试 AI，**不会**覆盖人工分类，也**不会**授权归档。
2. **管理员在管理页「反馈」详情里完成分类**：
   - 项目（下拉，来自 Kaneo 实时读取）、目标列（随项目重新加载）、**至少一个工作区标签**、可选负责人；
   - 切换项目会**立即清空**列、标签与负责人并重新加载选项；迟到的旧请求响应会被丢弃，
     不会把上一个项目的选择写进当前记录；
   - 「保存」= 暂存：允许缺项；选择完整时状态变为 `待归档`（仍**零远端写入**）。
3. **「保存并归档」是唯一的首次远端写入入口**：
   - 服务端会**重新读取** Kaneo 的项目/列/工作区标签/成员并逐项校验，不符合即拒绝（不会产生远端写入）；
   - 校验通过后在事务内比较分类版本、固定一份归档快照（连接 / 项目 / 工作区 / 列 ID+slug / 标签 / 负责人），
     记录管理员与操作时间后入队；
   - **快照一旦固定，之后修改软件配置或 Kaneo 选项都不会重定向这条任务**；
   - 同一操作标识的重放是幂等的；已完成授权的记录分类会被锁定，只能沿既有恢复入口继续。
4. **worker 执行归档**：创建任务（未选负责人时**省略** `userId`）→ 关联**工作区级**标签并读回核对 →
   上传截图/日志并挂评论 → 任务、标签、截图、日志、评论全部确认后才标记 `已归档`。
   任何结果不确定的阶段都会停在 `结果待核对` 并保留全部线索，**绝不盲目重建任务**。

### 1.6 自动归档流程（v7，可选）

管理员也可以在「软件配置」里把某个软件切成自动归档，省掉逐条人工操作：

1. 软件首次出现在列表时是**待配置**，并带一条**待确认来源**。点「配置」→ 在来源面板点「确认来源」。
   - 自动归档要求来源已确认。**确认来源不修改规则版本**：自动模式下首次确认会立刻补处理该来源的积压
     （页面提示「已确认来源，正在自动补处理该来源的积压反馈」）；仍是人工模式时只完成登记
     （提示「已确认来源。当前仍是人工归档模式…」），不会承诺自动归档。
2. 在同一个配置面板里选 Kaneo 项目 → 目标列 → **至少一个工作区标签** →（可选）负责人，点「保存配置」。
   - 这只是**普通保存**：不改变归档方式，也不会归档任何积压；保存会推进一次规则版本。
3. 点「**启用自动归档并处理积压**」（会二次确认）。服务端在这一刻实时核对目标是否仍然有效，
   然后才开始执行：**积压**与**后续**反馈各归档一次。
   - 同一操作重复点击是幂等的；并发扫描、服务重启都不会重复建任务。
   - 规则改到别的列不会重定向**已授权**的记录（快照已固定）。
4. 出现**新来源**（例如换了域名）时：反馈照常保存，但该来源暂停自动归档；
   在来源面板点「确认来源」后会**自动补归档**。
5. 关闭自动归档只**阻止新的授权**：已获授权的任务继续执行完。
6. **两个管理页面同时打开时**：保存配置、启用/停用、确认来源都必须带上页面读到的规则版本，
   版本过期会得到 `409 version_conflict`（页面刷新详情后由管理员重新确认），不会被静默覆盖；
   同一次点击的 `operationId` 在失败重试时保持不变，服务端据此幂等处理。

不满足条件（规则不完整、来源待确认、目标列失效、Kaneo 未配置）的记录保持**已接收**，
并在管理页「等待项」列与反馈详情里显示具体原因；可恢复的故障（网络类）按有上限的退避自动重试
（1 分钟起、最多 30 分钟，由服务端定时器到期自动处理，**不需要管理员反复点扫描**），
配置类问题等待管理员修正后由扫描重新拾起。**已被管理员保存过分类的记录不会被自动覆盖**，
仍由管理员逐条「保存并归档」。

> 因此：宿主的"提交成功"提示不承诺已经进入 Kaneo。产品文案请写「反馈已保存」，
> 而不是「已创建任务」。归档进度由管理员在管理页跟踪。

### 1.7 版本兼容承诺

接入方按版本号锁定组件（tgz / git ref，见 §2）；本节说明哪些表面跨版本稳定、升级时要看什么。
逐版本变更见根目录 [`CHANGELOG.md`](../CHANGELOG.md)；HTTP 侧口径见
[`docs/api.md`](api.md)「契约稳定性」。

**稳定面**

- Web：元素标签名 `feedback-widget`；§4 清单列出的全部 attribute / property
  （`api-base` / `app-id` / `app-name` / `app-version` / `page-label` / `side` / `theme` /
  `show-launcher` / `launcher-bottom` / `launcher-mode` / `capture-mode`）与方法
  （`open` / `close` / `captureAndOpen` / `cancelCapture` / `startLogin`）；
  `feedback-submitted` 事件及其 `detail = { feedbackId, status, replayed }` 形状；
  `data-feedback-capture-mask` 标记与 `input[type="password"]` 自动保护；
  `captureProvider` 回调签名（只返回 `{blob, width, height}` 的旧式回调保持兼容）；
  包导出 `openFeedback` / `defineFeedbackWidget` / `FEEDBACK_ELEMENT_TAG` 及已导出的类型名。
- Flutter：`feedback_widget.dart` barrel 导出的全部符号
  （`FeedbackWidget` / `FeedbackConfig` / `FeedbackController` / `FeedbackCaptureMask` /
  `FeedbackLogProvider` 及枚举与结果类型）。
- **默认值冻结**：`launcher-mode` 默认 `tab`、`capture-mode` 默认 `off`、`theme` 默认
  `system`、`side` 默认 `right` 等既有默认值不随版本改变——**升级不会改变旧宿主行为**。

**兼容变更**：新增可选 attribute / `OpenFeedbackOptions` 字段 / 导出符号 / 事件 `detail`
字段。宿主对未使用的可选能力保持无感即可。

**破坏性变更**只在 CHANGELOG 标注「破坏性」的版本出现：删除或重命名上述稳定面成员、
改变默认值、改变事件 `detail` 形状、收紧 `captureProvider` 校验导致旧 provider 被拒等。

**不属于稳定面**：Shadow DOM 内部结构、CSS 类名与样式、面板文案与布局（宿主不应穿透
Shadow DOM 查询节点或覆盖内部样式）；`test/` 下的测试辅助文件；`examples/` 示例代码
（仅作接入参考，不承诺逐版本不变）。

---

## 2. 安装与版本固定

### 2.1 Web：通过构建出的 npm tarball 安装（打包器宿主推荐）

包名 `@feedback/web`，当前版本 `0.5.0`，因此 tarball 文件名为 **`feedback-web-0.5.0.tgz`**（版本变了文件名跟着变）。

```bash
# ① 在仓库根构建组件包
pnpm install
pnpm --filter @feedback/web build

# ② 打成 tarball（真实产物：/tmp/fbpack/feedback-web-0.5.0.tgz）
mkdir -p /tmp/fbpack
pnpm --filter @feedback/web pack --pack-destination /tmp/fbpack
```

tarball 内含 `dist/` 全部产物（含 ESM 懒加载分块）、`package.json` 与 `README.md`。

```bash
# ③ 在你的宿主项目里安装这个 tgz
pnpm add /tmp/fbpack/feedback-web-0.5.0.tgz
# 等价写法：npm install /tmp/fbpack/feedback-web-0.5.0.tgz
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
      url: git@github.com:SakuraLoveSmile/Sakura-Feedback.git
      ref: <固定的 commit sha>      # 不要用分支名，避免"昨天能编、今天不能编"
      path: flutter/feedback        # 包在仓库的子目录里
```

> **已验证**（Comic Android 宿主实际接入）：上面这种「SSH url + 固定 `ref` + 子目录 `path`」形式
> 已真实跑通 `flutter pub get` / `flutter analyze` / `flutter test`，宿主的 `pubspec.lock` 已提交，
> 其中 `resolved-ref` 与 `ref` 同为该 sha。认证走开发机/CI 的 SSH 配置，**URL 内不写任何访问令牌**。
>
> 若本机 SSH 到 GitHub 不可用（例如 22 端口被网络策略关闭），**只为本地验证**可用一次性 env 覆盖改走
> HTTPS；不要改 `pubspec.yaml`，也不要改全局 git config：
>
> ```bash
> GIT_CONFIG_COUNT=1 \
>   GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
>   GIT_CONFIG_VALUE_0=git@github.com: \
>   flutter pub get
> ```
>
> CI / 生产环境必须让 SSH 可用（key 已注册到账号），否则 `pub get` 会失败。

拉依赖：

```bash
cd your_app && flutter pub get
```

### 2.4.1 `flutter_secure_storage` 版本兼容与宿主义务（9 / 10 / 11）

`feedback_widget` 对安全存储的约束是 **`flutter_secure_storage: '>=9.2.2 <12.0.0'`**
（[`flutter/feedback/pubspec.yaml`](../flutter/feedback/pubspec.yaml)）。组件只使用三版共有的
`read` / `write` / `delete`，**接口、存储键（`feedbackTokenStorageKey`）与「写入失败不回退内存/明文」的语义不变**，
`flutter/feedback/lib` 相对上一提交零 diff。

三档隔离矩阵实测（同一份组件测试源码，每档 `analyze` + `test` 全绿）：

| 固定版本 | 解析结果 | `darwin` | `macos` | `windows` | `platform_interface` |
|---|---|---|---|---|---|
| 9.2.2 | 9.2.2 | 无 | 3.1.3（走 `_macos`） | 3.1.2 | 1.1.2 |
| 10.3.1 | 10.3.1 | 0.3.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |
| 11.0.0 | 11.0.0 | 0.4.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |

**注意换包时点是「从 10.x 起」，不是 11 才有**：`darwin` 取代 `_macos`、`windows` 3.x→4.x、
`platform_interface` 1.x→2.x 在 10.3.1 档就已发生。

**平台要求分两半**：

- **本组件不抬高自己的下限**：仍是 `sdk: ^3.6.0` / `flutter: ">=3.27.0"`，旧宿主（Dart 3.6 / Flutter 3.27）可继续用。
- **使用 11 的宿主必须自行满足**：Dart `>=3.8.0`、Android `minSdk 24`、
  Android `compileSdk 37`（插件 `flutter_secure_storage-11.0.0` 的元数据）。
  本机 Flutter 3.41.3 默认 `compileSdk` 是 **36**，所以必须**显式**写 `compileSdk = 37`，
  不能沿用默认值（示例已在 [`examples/flutter/android/app/build.gradle.kts`](../examples/flutter/android/app/build.gradle.kts) 落实：
  `compileSdk = 37`、`minSdk = maxOf(flutter.minSdkVersion, 24)`）。
- **Music 的记录（不属于本仓库改动）**：Music 用 `flutter_secure_storage: ^11.0.0`，
  且 `android/app/build.gradle.kts` 直接继承 `flutter.compileSdkVersion`（Flutter 3.41.3 上是 36），
  因此 **Music 自身也需要显式 `compileSdk = 37`**。来源逐条见
  [`tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md`](../tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md)。
- **版本固定不使用依赖覆盖**：三档矩阵只用普通版本约束固定版本，**全仓无真实依赖覆盖声明**，
  并由 `tools/flutter-storage-matrix/check_tier.py` 逐档断言（同样的检查也跑在 CI 的矩阵 job 里）。
- **易混淆点**：`examples/flutter` 的 `ios/Podfile.lock`、`macos/Podfile.lock` 里写的
  `flutter_secure_storage_darwin (10.0.0)` 是 **CocoaPods podspec 版本**；
  对应的 **pub 包版本是 `0.4.2`**（见上表 11.0.0 档）。按 pub 版本对照时不要被这个数字误导。

**迁移边界（务必先读再升级）**：

- 放宽版本范围**不会自动迁移数据**；Android 已实测同 applicationId + 同签名逐档 `adb install -r`
  可跨 9→10→11 读回旧令牌，**macOS / iOS 本次未做 Keychain 运行时验证**，需自行验证。
- **旧宿主维持锁定版本**：已提交 `pubspec.lock` 的宿主会继续解析到原版本，不需要为了本次变更升级。
- **不能直接从 9 跳到 11**：中间 10.x 就换过平台实现包，请逐档验证。
- **本次不自动升级其他已接入应用**，**不要求升级 Feedback 服务端**，不新增日志附件，
  不改独立登录方式，也**不迁移 Music 现有凭据**（本组不读写、不删改 Music 侧任何条目）。

**验证范围**：Android 9→10→11 迁移实测通过（真实模拟器 + 真实 APK）；
macOS / iOS 只做构建，**未做 Keychain 运行时验证**；Windows / Linux 不在本次范围（未尝试、不建阻塞条目）。

📄 完整矩阵、证据追溯与复现命令：[`docs/flutter-storage-compat.md`](flutter-storage-compat.md)
（权威记录：[`VERIFICATION.md`](../VERIFICATION.md) 的「Flutter 安全存储兼容」一节）。

### 2.5 工具版本要求

| 工具 | 要求 | 依据 |
|---|---|---|
| Node.js | **≥ 22.13** | 根 [`package.json`](../package.json) 的 `engines.node` |
| 包管理 | **pnpm**（本仓库是 pnpm workspace；`packageManager: pnpm@11.23.0`） | 根 `package.json`、[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) |
| Flutter | **≥ 3.27** | [`flutter/feedback/pubspec.yaml`](../flutter/feedback/pubspec.yaml) 的 `flutter: ">=3.27.0"` |
| Dart | **^3.6** | 同上 `sdk: ^3.6.0` |

补充：服务端有一个原生依赖 `sharp`（截图的校验与重编码），安装时会带平台相关的 libvips 二进制；
数据库是 Node 内置的 `node:sqlite`，不需要额外 SQLite 模块。

使用 `flutter_secure_storage` 的宿主另有自己的下限（使用 11 需 Dart `>=3.8`、Android `minSdk 24` / `compileSdk 37`），
与本节 Flutter / Dart 下限是两回事，见 §2.4.1。

### 2.6 本次交付**不包含**的内容（明确边界）

- ❌ **不发布 `@feedback/web` 到 npm registry**：只在本仓库 `build` + `pack`，由宿主安装本地 tgz。
- ❌ **不发布 `feedback_widget` 到 pub.dev**（包内 `publish_to: none`）。
- ❌ **不发布公共 npm / pub.dev 包**，也不发布到公共容器仓库以外的任何 registry。
- ✅ **已有发布流水线**（本轮新增）：见 §2.7。跨仓库引用所需的 commit sha 由标签构建产出并回填。
- ⏳ **云端上线**：生产 compose 与 Nginx 模板已交付（[`deploy/`](../deploy)），但域名/证书/入口尚待填写，
  因此**尚未声称云端已上线**，也没有加入 SSH 自动部署。

### 2.7 服务端镜像与更新执行器：拉取、私有仓库认证、升级（本轮新增）

组件（Web tgz / Flutter 包）、反馈服务镜像与**更新执行器镜像**出自同一轮 Actions，见
[`.github/workflows/release.yml`](../.github/workflows/release.yml)。PR 只跑检查、**不发布**。

**稳定渠道判定（权威口径，与 [`docs/release.md`](./release.md) 一致）**

只有 4 个条件同时成立，才产出稳定版本（`release-manifest.json` + 公开 Release）：

1. 事件是**标签推送**（不是 `workflow_dispatch` 手动触发）；
2. 标签是**正式版本** `vX.Y.Z`（没有 `-rc.1` 之类的预发布后缀）；
3. 标签严格等于 `v<根 package.json 的 version>`；
4. 标签指向本次运行的提交（`git rev-parse refs/tags/<标签>^{commit}` == `github.sha`）。

条件 3、4 不成立 → **在推送任何镜像之前就失败退出**；条件 1、2 不成立（手动触发、预发布标签）→
仍可构建推送镜像（用于验证），但**不产出稳定清单、不创建任何 Release**。
**这是有意收紧**：「检查更新」按
`https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json` 取清单，
任何非稳定内容都不能出现在 Releases 里，否则版本检查会被引到未发布的版本上。

**镜像坐标与标签**

| 项 | 值 |
|---|---|
| 反馈服务镜像 | `ghcr.io/sakuralovesmile/sakura-feedback`（v0.5.1 起唯一镜像；`sakura-feedback-updater` 已随 updater 移除而停发） |
| 平台 | 仅 **linux/amd64** |
| 标签 | 版本标签（`v*`）、提交 SHA 标签（`sha-<40位>`）、以及 digest（`latest` 由 docker metadata-action 在标签构建时自动附加，指向同一 digest，仅供人读） |
| 生产引用 | compose.simple.yml 默认 `latest`；要固定版本可写 `vX.Y.Z` 标签或 digest（`@sha256:...`） |

一次发布的产物（同一轮构建）：Web `.tgz`、完整浏览器 `dist` 压缩包、管理页 `dist` 压缩包、
`SHA256SUMS` 清单、`SOURCE.txt`（含来源提交）、镜像 digest（`feedback-image-digest.txt`）
与稳定清单 `release-manifest.json`（清单字段见 [`docs/release.md`](./release.md)）。

**draft → 公开的顺序**：标签推送时先创建 **draft** Release，把上述全部产物与清单传上去，**复查资产齐全**
（缺一即失败退出、保持 draft），**最后一步才公开**。流水线不改动已公开的 Release，
因此不存在「已公开但产物缺失」的中间状态。

**在生产机拉取（私有 GHCR，只读凭据）**

```bash
# 只读 PAT（仅 read:packages）。凭证由 docker 保存，不要写进任何仓库文件。
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <你的用户名> --password-stdin
docker pull ghcr.io/sakuralovesmile/sakura-feedback@sha256:<digest>
```

**部署**

```bash
bash deploy/bootstrap.sh   # 交互式：收集域名、生成主密钥与管理员密码、写 .env.prod、启动
```

生成的 compose（`compose.simple.yml`）已保证：端口只绑 `127.0.0.1:8787`（公网入口一律走 Nginx TLS）、
`FEEDBACK_COOKIE_SECURE=true`、`/data` 用命名卷持久化、`FEEDBACK_PUBLIC_URL` 必填
（它决定 Cookie 写操作的同源校验基准）。
Nginx TLS 模板见 [`deploy/nginx/feedback.conf.template`](../deploy/nginx/feedback.conf.template)。

**升级**

后台「系统更新」页会按 Release 上的 `release-manifest.json` 提示是否有新版本（只检查不安装）。
确认后走 `deploy/update.sh`（自动卷备份 → pull → 重建 → 等健康），或手动：

```bash
cd <部署目录>
docker compose --env-file .env.prod pull && docker compose --env-file .env.prod up -d
```

细节以 [`docs/deployment.md`](./deployment.md) 与 [`deploy/README.md`](../deploy/README.md) 为准。

**回退**：先恢复 `backups/` 里的升级前 tar 备份，再把 `FEEDBACK_IMAGE` 改回旧版本标签后 `up -d`。
`/data` 不在镜像里；数据库迁移单向，跨 schema 版本回退必须先恢复备份。

**客户端如何跟上同一版本**

- Web：下载该版本产物的 `feedback-web-<version>.tgz`，放进宿主项目的版本化目录（如 `vendor/`），
  `package.json` 写成 `"@feedback/web": "file:vendor/feedback-web-<version>.tgz"`——
  **不要**引用本机绝对路径。
- Flutter：把 `pubspec.yaml` 的 `ref` 改成该轮构建的**来源提交 SHA**（`SOURCE.txt` 里的 `commit=`），
  然后 `flutter pub get` 并提交宿主 `pubspec.lock`。

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
  // 可选：注册日志提供者，在打开面板时自动收集（至多 3 份，每份 ≤1MiB，3秒超时保护）
  widget.logProvider = async () => [
    { filename: 'console.log', blob: new Blob(['2026-09-14 12:00:00 [INFO] app loaded\n'], { type: 'text/plain' }) }
  ];
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

3. **事件清理与日志提供者配置**：

   ```tsx
   useEffect(() => {
     if (!widget) return;
     // 可选：注入日志采集回调（打开面板自动收集，3秒超时保护）
     widget.logProvider = async () => [
       { filename: 'client.log', blob: new Blob(['app runtime diagnostic logs...\n'], { type: 'text/plain' }) },
     ];
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

onMounted(() => {
  if (widget.value) {
    // 可选：设置自动日志采集提供者
    widget.value.logProvider = async () => [
      { filename: 'frontend.log', blob: new Blob(['vue runtime logs\n'], { type: 'text/plain' }) },
    ];
    widget.value.addEventListener('feedback-submitted', onSubmitted);
  }
});
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
  widget.logProvider = async () => [
    { filename: 'ssr-client.log', blob: new Blob(['browser hydration complete\n'], { type: 'text/plain' }) }
  ];
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
            'com.example.demo',             // appId：宿主自己的标识（无需事先登记）
            appVersion: '1.0.0',
            pageLabel: pageLabel,           // 必须由宿主显式传入
            side: FeedbackSide.right,
            launcherMode: FeedbackLauncherMode.orb,      // 默认 tab，必须显式写
            captureMode: FeedbackCaptureMode.viewport,   // 默认 off，必须显式写
            // 可选：日志采集提供者（面板打开自动抓取，至多 3 份，每份 ≤1MiB，3秒超时容错）
            logProvider: () async => [
              FeedbackLogFile(
                filename: 'app.log',
                bytes: Uint8List.fromList(utf8.encode('flutter runtime logs\n')),
              ),
            ],
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
| — | `effectiveApiBase` | string \| null（只读 property） | — | 当前实际使用的服务地址：用户本机覆盖优先于 `api-base`，未覆盖时等于 `api-base` | 用户通过面板内「服务器设置」改变；语义见 5.3.1 |
| — | `logProvider` | `FeedbackLogProvider?`（即 `() => Promise<FeedbackLogFile[]> \| FeedbackLogFile[]`） | `undefined` | 自动日志采集提供者；呼出面板时调用（3秒超时容错），至多采集 3 份附件，单文件 ≤1MiB | 仅 property，替换后下一次呼出面板生效；**不清空草稿** |

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
| `logProvider` | `FeedbackLogProvider?`（即 `FutureOr<List<FeedbackLogFile>> Function()?`） | `null` | 自动日志采集提供者；呼出面板时调用（3秒超时容错），至多采集 3 份附件，单文件 ≤1MiB |
| `filePicker` | `FeedbackFilePicker?`（即 `FutureOr<List<FeedbackLogFile>> Function()?`） | `null` | 手动选择日志回调；用户点击「添加日志」时调用，未提供时默认使用 `file_selector` 打开系统文件选择器 |

**`position` 的优先级规则**（[`flutter/feedback/lib/src/widget.dart`](../flutter/feedback/lib/src/widget.dart)）：

- 垂直位置：`position.dy` **优先于** `launcherBottom`；未传 `position` 时才用 `launcherBottom` 解析值。
- 距停靠边的水平内缩：`position.dx`，未传时默认 **20 逻辑像素**。
- `side` 决定"停靠边"是哪一边（`left` → 左内缩，`right` → 右内缩）。

运行中改变**服务身份**（宿主重建 `FeedbackWidget` 并传入新 `apiBase` / `appId`）：
面板按**完整身份切换**处理——取消在途捕获 / 提交 / 轮询 / 登录接续，清空草稿、
截图、日志、任务态与幂等键，按新身份重建 API 客户端与令牌仓库并重新读取本机
服务器覆盖偏好；旧身份的迟到响应一律丢弃。**用户侧的运行时换服**走面板内
「服务器设置」（5.3.1），与宿主配置热更新走同一套身份切换收口。

`FeedbackController.effectiveApiBase`（只读）：当前实际使用的服务地址——
本机覆盖优先于 `config.apiBase`；偏好加载完成前先返回 `config.apiBase`。

### 4.3 方法

| 能力 | Web（元素实例 / `FeedbackWidget` class） | Flutter（`FeedbackController`，导出见 [`feedback_widget.dart`](../flutter/feedback/lib/feedback_widget.dart)） |
|---|---|---|
| 打开面板（**不截图**） | `open()` | `open()` |
| 关闭面板（并取消进行中的截图） | `close()` | `close()`（即使面板未展开也会通知监听者，用于让进行中的捕获会话失效） |
| **截图并打开** | `captureAndOpen(opts?)`，`opts.releasePoint` 为灵感球拖拽落点（0..1 视口比例） | `captureAndOpen({Offset? releasePoint})` |
| 取消进行中的截图 | `cancelCapture()` | `cancelCapture()` |
| 切换开关 | — | `toggle()` |
| 读取开关状态 | 面板状态可在 DOM 上观察（`aria-expanded` 等） | `isOpen`（`FeedbackController` 是 `ChangeNotifier`） |
| 展开登录表单 | `startLogin()`（在当前面板展开，返回空串） | 点击主按钮「登录并提交」时展开（Web / 原生共用） |
| 宿主注入会话 | `adoptSession({ accessToken, expiresAt })`（宿主提供的 Bearer 令牌，免组件内登录；见 7.1.1） | — |
| 宿主清除注入会话 | `dropSession()`（丢弃令牌回到需要登录态，草稿保留） | — |

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

Flutter 端：宿主传入新 `apiBase` / `appId` 重建 `FeedbackWidget` 时走同一套
身份切换收口（见 4.2 末尾），用户侧换服见下节。

#### 5.3.1 用户自定义服务器（本机覆盖，两端一致）

两端面板头部都有「服务器设置」入口（未登录也可进入）：地址输入、保存、
恢复默认、当前有效地址展示，保存后探测 `GET /healthz` 给出连通性提示
（**不静默回切**——连接失败只是提示，仍可稍后重试提交）。

- **持久化与本机隔离**：覆盖只保存在本机——Web 用 `localStorage`（按页面源），
  Flutter 原生用 `flutter_secure_storage`、Flutter Web 用 `localStorage`；
  存储键按「规范化默认地址 + `appId`」派生（`server-override.<base64url(...)>` /
  `feedback_widget.server_override.<base64url(...)>`），不同默认配置或不同
  `appId` 读到不同槽位。恢复默认只删除覆盖键，**不回写宿主 `api-base`**。
- **地址规范化**（两端同一套规则）：去首尾空白、仅允许 `http(s)`、主机必须
  非空、拒绝内嵌凭据 / 查询参数 / `#` 片段、去末尾斜杠、去默认端口
  （`http:80` / `https:443`）、保留部署路径前缀；**HTTPS 页面拒绝 HTTP 地址**
  （浏览器混合内容拦截，提前在校验层报错）。
- **同址不重置**：规范化后与当前有效地址相同的保存只写偏好，不触发任何
  身份重置（草稿原样保留）。
- **异址切换需确认**：有草稿文本 / 截图 / 日志 / 在途或未确认的提交时先弹确认
  （清空并切换）；存在结果未确认的提交时，确认框明确说明「旧服务器可能已接收
  该反馈，切换不会撤回，也不会自动向新服务器重发」。取消则一切保留。
- **身份隔离**：确认后按新身份重建——令牌仓库（Flutter 按有效地址 + `appId`
  派生键，旧令牌绝不发往新地址）、任务态、额度、轮询、幂等键、截图会话、
  日志采集全部作废重来；旧身份迟到响应（提交 / 轮询 / 会话 / 401 回调）一律
  由身份世代守卫丢弃。
- **写入失败降级**：偏好写入失败时本次会话仍生效，提示「仅本次生效」。
- **加载门控**：覆盖偏好加载完成前不启动任何依赖服务器的请求
  （会话恢复 / 额度 / 提交 / 轮询 / 日志采集都在门后）。
- **可观察**：Web 读 `element.effectiveApiBase`；Flutter 读
  `controller.effectiveApiBase`（`FeedbackController` 是 `ChangeNotifier`，
  变化会触发监听通知）。

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
- **键盘避让（Android / 小屏，T9）**：面板底部只抬升「未被宿主避让的实际重叠」——
  宿主已收缩（含 Scaffold 消费 `viewInsets`）或已避开时不再额外留白；撰写 / 登录 /
  设置内容有界可滚，底部按钮始终可达；账号「下一步」→ 密码、「完成」→ 登录，
  聚焦字段在布局完成后滚回可见区域；开合 / 旋转不清草稿、不重复提交。

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

### 6.5 日志附件规范、隐私保护与 AI 分析边界

#### 1) 附件规格与硬约束（两端与服务端严格一致）

| 规则 | 约束值 | 违规后果 |
|---|---|---|
| 文件数量 | 至多 **3 份** | 超出返回 `400 invalid_log`，整条请求拒绝，零落盘 |
| 单文件体积 | **> 0 且 ≤ 1 MiB**（1,048,576 字节） | 超出返回 `413 too_large`，空文件返回 `400 invalid_log` |
| 文件格式 | 扩展名仅限 `.log`, `.txt`, `.json`, `.jsonl` | 违规返回 `400 invalid_log` |
| 字符编码 | 严格为有效 **UTF-8 文本** | 非法编码返回 `400 invalid_log` |
| 总请求体 | multipart 请求体上限 **10 MiB** | 超出返回 `413 too_large` |

#### 2) 客户端采集与交互
- **自动采集**：宿主通过 `logProvider` 注入，面板呼出时自动执行，享有 **3 秒超时保护**；超时或抛错静默忽略，不阻碍面板打开与文字输入。
- **手动选择**：面板提供「添加日志」按钮（Web 端自动呼起系统文件选择器；Flutter 端通过 `filePicker` 回调或默认通道），支持手动添加日志。
- **安全预览与移除**：面板以只读纯文本弹窗展示日志内容，用户可在提交前点击单行预览并手动移除任意附件。
- **快照冻结与幂等**：提交瞬间冻结文本、截图与全部日志（`SubmitSnapshot` / `_FrozenSubmit`）。提交失败重试沿用相同快照与幂等键；用户增删或修改日志即刻使旧键失效并生成新键。

#### 3) 隐私与防注入边界（AI 分析与 Kaneo 归档）
- **日志是不可信诊断材料**：服务端向大模型构造提示词时，将日志置于独立的诊断材料块中，显式声明原话与日志中的任何指令均不予执行，严防针对 AI 整理的 Prompt Injection 攻击。
- **截断算法**：为保证上下文可控与模型推理效率，服务端在送入 AI 整理前执行 Unicode 码点截断：
  - **单文件截取尾部至多 8,000 Unicode 码点**（针对最新运行异常与崩溃调用栈）；
  - **全部日志文件总计至多 24,000 Unicode 码点**，超出部分直接截断或舍弃；
  - 截断按真正的 Unicode 码点计（非 UTF-16 code units），Emoji 与多字节文字不截断乱码。
- **人工排查与 Kaneo 归档**：
  - Kaneo 任务描述追加清晰的格式化日志清单（文件名、来源、体积、SHA-256 摘要）；
  - Kaneo 截图评论中附带日志文件名与体积线索；
  - 每一份日志均作为独立附件上传至 Kaneo 存储，并通过 `downloadAsset` 下载并比对 SHA-256 完整性摘要，确认一致后创建日志独立附件评论；全部附件（截图与所有日志）均确认归档后，反馈状态才标记为 `archived`（`archive_stage: "complete"`）；
  - 管理员可在管理后台列表直接看到日志计数（`logCount`），并在详情页一键下载原始文件（`application/octet-stream`）或浏览器纯文本预览（`text/plain`）；若个别日志远端上传或评论核对失败，反馈进入 `needs_review`，管理员可在详情页发起单文件 `retry_log` 针对性重试。

---

## 7. 登录、网络与平台配置

### 7.1 面板内登录（Web 组件与 Flutter 当前方式）

1. 未登录也可在面板内编辑文字与截图；点击主按钮「登录并提交」，面板**就地展开**账号密码表单（不打开任何窗口）。
2. 确认后组件调用 `POST /api/auth/login`，显式携带 `clientLabel`（Web 为 `web:<appId>`，Flutter 为
   `flutter-<平台>-<iso 时间>`）与 `appId`；v7 起 `appId` 只需**格式合法**（1..100 字符、仅字母数字与 `. _ : -`），
   **不要求软件已登记**；浏览器携带的 `Origin` 只做合法性校验（非法如 `file://` → `400 origin_not_allowed`）。
3. 成功后返回 `token` 与 `user` / `quota`；令牌仅存内存（Web、Flutter Web）或安全存储（原生 Flutter）。
   登录成功立即提交一次；取消只收起表单，草稿与截图保留。
4. **额度**：每个账号默认每天 3 次（北京时间零点刷新，所有项目/设备共用）。面板显示剩余次数；
   额度用尽返回 `429 daily_quota_exceeded`，按**未接收**处理（保留草稿、不扣次），额度刷新后可直接再提交。
   打开面板、登录成功、提交完成与应用恢复前台时刷新额度。刷新被在途查询或登录/提交忙碌挡下时，组件会登记
   「待立即刷新」意图，旧查询结束后或忙碌结束后立即补发一次（Web 会话查询另有 20 秒超时，超时按既有失败规则
   30 秒重试）；额度用尽后每 30 秒重查一次，其余状态按服务端 `resetAt` 定时单次查询。重新登录后，旧请求
   迟到的 401 不会把新登录的账号退出（Flutter 侧按请求发出时捕获的令牌与认证世代做条件清除）。
5. **旧登录窗口握手（兼容保留）**：`window.open("<apiBase>/login?appId=&nonce=&cb=…")`，登录页调用
   `POST /api/auth/handshake` 获得短期令牌后 `postMessage({ type: "feedback:auth", nonce, accessToken, expiresAt }, cbOrigin)`；
   令牌绑定当前登录用户。新集成请使用上面的面板内登录。

#### 7.1.1 宿主注入会话（`adoptSession` / `dropSession`，Web）

宿主若已持有服务端签发的 Bearer 令牌（例如同源页面以自身 Cookie 会话调
`POST /api/auth/handshake` 换取的握手令牌），可注入组件免去面板内二次登录：

```ts
widget.adoptSession({ accessToken, expiresAt }); // expiresAt：epoch 毫秒或 ISO 串
widget.dropSession();                            // 宿主会话结束时清除
```

- 注入与面板内登录等价：令牌仅存内存、绝不写 localStorage；注入后组件自动
  拉取会话身份与额度（`GET /api/auth/session`）。宿主负责到期前续注（再次调用
  `adoptSession`）或在自身会话结束时 `dropSession()`。
- 注入非法参数（空令牌 / 不可解析或过期的 `expiresAt`）按 no-op 处理；注入令牌
  401 时组件按既有规则回到需要登录态、草稿保留。
- **首个使用者是 Feedback 管理后台自身**（v0.5.2）：后台内嵌
  `<feedback-widget app-id="com.feedback.admin">`，登录后以管理员 Cookie 换握手
  令牌注入并按寿命周期续注；`com.feedback.admin` 软件缺失时自动登记、缺当前
  origin 时补入白名单，提交的反馈进入本服务收件箱。

其他要点：

- **令牌只属于签发它的服务**：`api-base` 变化即清空并需重新登录；旧服务的令牌绝不随请求发送给新基址。
- **令牌过期**：组件保留草稿并可重新登录后继续；`app-id` 变化保留令牌（同一服务）。
- **不依赖第三方 Cookie**：跨源登录 / 会话查询 / 提交走 Bearer + 任意合法 Origin 的 CORS 回显，
  且**跨源请求一律不认后台 Cookie**（即使浏览器带上了后台会话 Cookie 也只按 Bearer 判定身份）。
- **会话撤销**：管理页可列出并撤销会话（`GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、
  `POST /api/auth/sessions/revoke-all`，均需管理员），撤销或禁用账号后对应 Bearer 令牌同时失效。接口见 [`docs/api.md`](api.md)。

### 7.2 Flutter 登录

- **Web 与原生平台统一**：面板内用户名 / 密码表单 → `POST /api/auth/login`（携带 `clientLabel`，形如
  `flutter-macos-<iso 时间>`，以及 `appId`）→ 返回可撤销令牌。**Web 平台令牌仅存内存**（刷新后重新登录），
  **原生平台存入 `flutter_secure_storage`**（`SecureFeedbackTokenStore(config: …)`）。
  后续请求带 `Authorization: Bearer <token>`；收到 **401** 时清除令牌并回到未登录面板，草稿保留。密码不写日志、不留存 UI。
- **额度**：面板撰写区显示「今日剩余 N 次」；额度用尽时提交按钮禁用并提示，草稿保留。
- **令牌按服务身份分槽**：原生存储键由 `apiBase` + `appId` 派生
  （[`flutter/feedback/lib/src/token_store.dart`](../flutter/feedback/lib/src/token_store.dart) 的 `feedbackTokenStorageKey`）：

  ```
  feedback_widget.bearer_token.<base64url(apiBase + "\u0000" + appId)>   // 去掉 = 填充
  ```

  同一台设备上，不同 Feedback 服务、或同一服务的不同 `appId` **各占一个槽位**；
  读取时用同一派生键，因此**换服务读不到旧服务的令牌（返回 `null`），不会跨服务串用凭据**；
  键是确定性的，且只含平台存储后端的安全字符（`A–Z a–z 0–9 - _ .`）。
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
| Flutter 安全存储兼容（`flutter_secure_storage` 9 / 10 / 11，2026-09-14） | [`flutter/feedback/pubspec.yaml`](../flutter/feedback/pubspec.yaml)、[`tools/flutter-storage-matrix`](../tools/flutter-storage-matrix)、[`docs/flutter-storage-compat.md`](flutter-storage-compat.md) | ✅ 组件 `analyze` + `test` **112/112** exit 0；示例 `test` **37/37** exit 0；三档矩阵（9.2.2 / 10.3.1 / 11.0.0）各 116 例全绿；`build apk --debug` / `build macos --release` / `build ios --no-codesign` 全部 exit 0 | ⚠️ **部分验证**：Android 9→10→11 迁移在真实模拟器 + 真实 APK 上实测通过；**macOS / iOS 只做构建、未做 Keychain 运行时验证**；Windows / Linux 不在本次范围。结论与证据见 `VERIFICATION.md` 的「Flutter 安全存储兼容」一节 |
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
| `retry`（重试处理） | 处理流程 | 把 `failed` 重新入队；已有 AI 整理结果时跳过 AI 直接再归档。对 `需要补充信息` 且尚无 AI 结果的记录，只重新尝试 **AI 整理**，**不会**触发未授权归档 | 会继续产生远端写入（仅限已授权/已开始的归档） |
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

- **首次远端写入需要人工授权**：提交、暂存（`保存`）与重启扫描都**不会**调用 Kaneo。
  只有管理页「保存并归档」（`POST /api/admin/feedback/:id/classify`，`action=archive`）写入的持久化授权
  才会让 worker 归档；授权时固定的快照（连接 / 项目 / 工作区 / 列 / 标签 / 负责人）之后不可被配置变化重定向。
- **分类版本与操作标识**：分类保存与归档授权都带 `classifyVersion` 乐观锁（过期 → `409 version_conflict`）；
  同一次归档请求重放（同 `operationId`）是幂等的，不会产生第二个任务。
- **已授权 / 已归档记录锁定分类**：只能沿既有恢复入口继续，不能通过分类编辑另建任务。
- **标签只认工作区级**：只有 `taskId === null` 的工作区标签可被选择（避免把其他任务上的标签"搬走"）；
  关联后服务端会读回任务标签核对，未确认不会标记 `已归档`。
- **并发与过期页面**：所有管理动作带 `expectedRevision` 乐观锁——页面数据过期返回
  `409 revision_conflict`（请刷新后重试）；同一反馈正被其它操作处理返回 `409 busy`；
  远端读 / 写失败返回 `502 recover_failed` 且**状态不变**（不触发替代写入）。
- **操作审计**：分类保存、归档授权与每次人工恢复动作都会写入审计记录，详情页「操作审计」可见
  （动作、操作人、时间）。
- **目标改变**：人工恢复动作会先固定一份 Kaneo 连接配置并与已保存目标比对；
  不一致 → `409 target_changed`，**零远端写入**且恢复数据原样保留。
- **列失效**（改名 / 删除）→ `failed` 并提示修复配置；服务**不会**自动创建列或改写看板。
- 运维视角的备份、升级顺序与**回退限制**（产生远端写入后不得简单恢复旧库重放）见
  [`docs/deployment.md`](deployment.md) 第 2、4 节，本文不重复。

### 8.3 常见症状 → 原因 → 处理

| 症状（可观察） | 可能原因 | 处理 |
|---|---|---|
| 提交返回 `401`，面板要求重新登录 | 令牌已过期 / 被撤销 / 账号被禁用，或从未登录 | 在当前面板点「登录并提交」重新登录（不打开窗口）；确认 `api-base` 没被改过（改过就必须重新登录） |
| 浏览器控制台报 CORS 错误、请求被拦，服务端日志却没有该请求 | `Origin` 不合法（非 http/https），或请求打到了**不开放跨源**的路径（人工恢复、后台管理、旧握手） | 核对 `api-base` 指向的服务地址；组件只对登录/会话/退出/提交/本人记录查询开放跨源 |
| 登录报 `origin_not_allowed`（400） | 浏览器携带的 `Origin` 不是合法 http(s) 来源 | 检查宿主页地址（`file://`、自定义协议页无法跨源登录） |
| 提交成功但一直「等待管理员配置」 | 软件由本次提交自动发现，管理员还没配置 | 管理页 → 软件配置：确认来源（新来源需要）→ 选择项目/列/标签 → 点「启用自动归档并处理积压」 |
| 提交成功但显示「等待管理员确认来源」 | 自动归档已启用，但该站点是这条软件的**新来源** | 管理页 → 软件配置 → 来源确认面板点「确认来源」，确认后积压会自动补归档 |
| 提交返回 `409 idempotency_conflict` | 同一个幂等键被用于**不同内容**（例如手改了内容却复用旧 key） | 组件不自动换 key；修改内容后重新提交（新 key 自然生成） |
| 提交返回 `413 too_large` | 文字 > 10,000 码点；截图超限（>5 MiB / 最长边 >2048 / 总像素 >4M）；或 multipart 体 > 6 MiB | 缩短文字；在面板里重拍截图（会自动按限制缩放重编码）；仍不行则改用纯文字反馈 |
| 管理页恢复动作报 `409 target_changed` | 已保存的归档目标与**当前** Kaneo 配置不一致（Kaneo 地址 / 项目 / 工作区被改过） | 把配置改回原目标，或按 `needs_review` 人工处理该记录；该动作**不会**发出任何远端写入 |
| 恢复动作报 `409 revision_conflict` / `409 busy` / `502 recover_failed` | 页面数据过期 / 同一反馈正被其它操作处理 / 远端读写出错 | 刷新页面重试；稍后重试；`recover_failed` 时状态未变，可重试或人工核对 |
| 提交返回 `429 daily_quota_exceeded` | 该账号当日额度用尽（默认 3 次，北京时间零点刷新，跨项目/设备共用） | 面板显示剩余次数与下次可提交时间；未接收、不扣次，额度刷新后可直接重试 |
| 提交或登录返回 `429 rate_limited` | 限流：登录 10 次 / 15 分钟 / IP+用户名；提交 60 次 / 小时 / 会话 | 按 `Retry-After` 等待后重试 |
| 截图一直没出现，提示"截图未完成，可重试或继续文字反馈" | 敏感节点无法在克隆中定位 / 遮挡坐标非有限 / 最终位图无法验证（如 canvas 被跨源图片污染）；或 PNG 缩小重编码 3 次后仍 > 5 MiB | 重试；缩小窗口尺寸；处理会被跳过的跨源图片（补 CORS 或去掉）；改用自定义 `captureProvider`（有敏感区时**必须**提供同帧遮挡证明）；或直接用纯文字反馈 |
| 浏览器控制台出现动态 `import()` **404**（文件名形如 `html2canvas-pro.esm-*.js`） | ESM 自托管时**只部署了 `feedback-web.js`**，漏了懒加载分块 | 部署**整个 `packages/web/dist/`**（见 2.3）；或改用 UMD 单文件 |
| Vue 开发模式打印 `Failed to resolve component: feedback-widget` | 未配 `isCustomElement` | 按 3.3 配置 `vite.config.ts` |
| TS 报未知 JSX 元素 / 模板类型错误 | 未补 Custom Element 的类型声明 | 拷贝 3.2 / 3.3 的类型声明文件 |
| 服务端（Node）运行时报 `ReferenceError: HTMLElement is not defined` | 在服务端 import 了组件入口（SSR / 打包器把它打进了服务端 bundle） | 只在客户端动态 `import()`；用 `ssr: false` / `useEffect`（见 3.4） |
| 后台归档后记录停在 `failed`，提示"Kaneo 目标列已失效" | Kaneo 侧的列被改名或删除（服务端按列 slug 归档） | 管理页重选该软件配置的目标列（用「测试项目并加载列」取真实 slug），再点「重试处理」；服务**不会**自动建列 |
| 记录停在 `failed`，提示"Kaneo 连接未配置"或"认证失败" | 连接配置缺失 / API Key 失效 / 主密钥不匹配导致密钥无法解密 | 管理页「连接配置」重填并测试；若提示主密钥问题，说明环境变量 `FEEDBACK_MASTER_KEY` 与写入密钥时不一致 |
| 记录一直停在「需要补充信息」，Kaneo 里没有任务 | **预期行为**：提交成功不再自动归档，等待人工分类 | 管理页打开该记录 → 选择项目 / 列 / 至少一个工作区标签 /（可选）负责人 →「保存并归档」 |
| 「保存并归档」返回 `422 incomplete_classification` / `invalid_classification` | 缺项目/列/标签，或所选列/标签/负责人已被 Kaneo 侧改动 | 重新选择并保存；若选项列表加载失败（`502 kaneo_unavailable`），先修好连接配置 |
| 「保存并归档」返回 `409 classification_locked` / `already_authorized` | 记录已进入归档队列或已归档（分类锁定），或已用另一个操作标识授权过 | 刷新详情；需要继续处理时使用「恢复操作」，不要通过分类另建任务 |
| 详情里「保存并归档」按钮不可用 / 分类只读 | 记录已授权或已归档 | 用下方「恢复操作」（`recheck` / `retry_comment` / `replace_upload` / `retry_log`）继续，而不是改分类 |
| 标签关联失败（`failed`，提示"关联标签失败"/"工作区标签已不存在"） | 标签在授权后被删除，或 API Key 无标签权限 | 确认 Kaneo 工作区仍存在该标签；重新归档该记录（需先确认分类仍有效） |
| 归档卡在 `needs_review` 且反复出现 | 远端写入结果不确定（超时 / 断连 / 5xx / 服务在发送中崩溃 / 上传地址过期或被拒） | **不要再让用户重新提交**；按 8.2 在管理页执行 `recheck` → 必要时 `retry_comment` / `replace_upload`（注意各自风险） |
| 灵感球不显示 / 点了不截图 | 未显式设置入口模式（默认 `tab` + `off`）；或面板已打开时入口被隐藏 | 显式写 `launcher-mode="orb"` + `capture-mode="viewport"`（Flutter：`FeedbackLauncherMode.orb` + `FeedbackCaptureMode.viewport`）；关闭面板 |
| 默认 `capture-mode="off"` 时找不到截图入口 / 输入文字后无法补拍 | 这里的 `off` 只表示**不自动截图**；面板里应始终有手动的「截取当前页面」，无截图时不应出现缩略图或「重新截图 / 移除截图」 | 升级到本轮修复后的 Web 组件；面板内点「截取当前页面」即可手动截图（与文字草稿互不影响）。若按钮不可见，检查宿主是否用 CSS 压掉了 `[hidden]`（组件已内置 `[hidden]{display:none!important}` 兜底） |
| Flutter 面板里输入框选择浮层 / 截图放大预览异常 | 组件挂载位置缺少 `Overlay` / `Navigator` 祖先 | 按 3.5 用 `MaterialApp.builder` + 外层 Navigator 包裹 |
| Flutter 宿主对话框压住灵感球，或不出现在截图里 | `showDialog` 默认 `useRootNavigator: true`，对话框被推到组件上方 | 用 `useRootNavigator: false` 让对话框落在应用自己的 Navigator 里 |
| Android 构建因插件所需 `compileSdk` 高于应用而失败（AGP 的 AAR metadata 校验） | 宿主继承的默认 `compileSdk` 低于插件要求（Flutter 3.41.3 默认 36） | 在 `android/app/build.gradle.kts` 显式写 `compileSdk = 37`，并保证 `minSdk >= 24`（见 2.4.1） |
| macOS 编译报找不到 `flutter_secure_storage_macos` / 插件注册不匹配 | 用 11.x 但 `GeneratedPluginRegistrant.swift` 仍是 `_macos`（11 起改用 `flutter_secure_storage_darwin`） | `flutter pub get` 后重新构建以再生成 `macos/Flutter/GeneratedPluginRegistrant.swift`，确认导入 `flutter_secure_storage_darwin`；`ios/macos` 的 `Podfile.lock` 也应由 CocoaPods 重新生成 |
| 升级 `flutter_secure_storage` 大版本后读不到旧令牌 | 平台实现包在 10.x 起换名（见 2.4.1）；放宽约束**不会**自动迁移数据 | 先在目标的真实签名环境里按 2.4.1 逐档验证（Android 用**同 applicationId + 同签名**的 `adb install -r` 覆盖安装）；旧宿主可以保持锁定版本、不升级 |

---

## 9. 宿主清单速查（含 Blog 最小接入）

### 9.0 先接收、后配置、自动归档（v7）

**接入方不需要事先找管理员登记软件**：填好 `api-base` / `app-id` / `app-name` 就能登录并提交。
首次有效提交时服务端会自动登记一条**待配置**软件，并记录本次服务端**观察到**的来源。

接入侧只需要理解提交响应里的 `collectionState`：

| `collectionState` | 含义 | 组件表现 |
|---|---|---|
| `waiting_configuration` | 软件刚被自动发现，等管理员配置；或自动模式下被配置类问题阻塞 | 「反馈已保存，等待管理员配置该软件。」**停止轮询** |
| `waiting_source_confirmation` | 该站点是这条软件的新来源，等管理员确认 | 「反馈已保存，等待管理员确认来源。」**停止轮询** |
| `waiting_manual_archive` | 人工归档模式，或自动模式下这条记录已被管理员人工处理过 | 「反馈已保存，等待管理员归档。」**停止轮询** |
| `queued` | 已授权正在归档，或自动模式下正在整理 / 等待自动重试 | 「已保存，正在整理」+ 继续轮询到终态 |

要点：

- 等待态**不是失败**，也不是「正在处理」：组件已停止轮询，只保留「刷新状态」；
  宿主不要把这段文案改写成「提交失败」，也不要自行加重试提交（重复提交只会被幂等重放，不会新建任务）。
- 自动模式下的「等待自动重试」显示为 `queued`（继续跟踪），**不会**误报成等待人工归档。
- `app-name`（Flutter `appName`）只是**建议显示名**：管理员在后台改过名称后，组件上报的名称不再生效。
- 来源由服务端按请求 `Origin` 记录，客户端自报的名称/来源都不作为身份凭证；
  同一软件从第二个域名提交会生成一条新的「待确认来源」，确认后积压自动补归档。
- 组件的登录与提交支持**任意合法 http(s) 来源**的无凭据跨域（Bearer + `credentials: omit`），
  不需要把 origin 预先登记；`allowedOrigins` 现在只服务于旧版登录窗口握手，以及给后台登记「已确认来源」。
- 管理员**普通保存规则不会触发归档**；只有显式点「启用自动归档并处理积压」才开始自动归档。
  积压会按批连续处理直到没有可执行候选，可恢复故障到期由服务端定时器自动重试。

### 9.1 Blog（个人博客站）最小接入

Blog 是"只要一个反馈入口"的宿主，**不需要**知道 Kaneo、AI 或管理员口令。它只需要四件事：

| 项 | 值 / 来源 | 写在哪 |
|---|---|---|
| 组件固定版本与安装产物 | 与本站一致的构建产物（推荐 `pnpm pack` 出来的 `feedback-web-<版本>.tgz`，或自托管 `packages/web/dist/` 整份）；**按版本号锁定，不要用 `latest`** | 宿主 `package.json` 的依赖版本或自托管静态目录 |
| Feedback 服务地址 | 部署好的服务地址（如 `https://feedback.example.com`） | 组件属性 `api-base`（Flutter：`apiBase`） |
| `appId` | 宿主自己的软件标识（例如 `com.example.blog`）；**无需事先登记**，首次提交自动发现 | 组件属性 `app-id`（Flutter：`appId`） |
| 软件显示名（可选） | 后台尚未配置时用来显示的名字 | 组件属性 `app-name`（Flutter：`appName`） |

Blog 侧**不需要**、也**不应该**配置：管理员用户名/口令、AI 密钥、Kaneo 地址与 API Key、目标项目或列 id。
这些**只配置在 Feedback 服务端**（管理员在 `/admin/` 里维护，密钥 AES-256-GCM 加密落库）。

Blog 的反馈入口建议显式声明：`launcher-mode="orb"` + `capture-mode="viewport"`（悬浮球 + 当前视口截图），
主题与站点一致时传 `theme="dark"` / `theme="light"`（默认 `system` 跟随系统）。
接入完成后，Blog 侧只需确认「面板能打开 → 能登录 → 提交成功且提示等待配置/等待归档」；
**提交成功不等于已进 Kaneo**，管理员确认来源并启用自动归档（或逐条人工归档）后才会写入（见 9.0 与 1.5）。

### 9.2 通用核对清单

- [ ] `api-base` 指向的服务 `/healthz` 返回 `{"ok":true}`；
- [ ] `app-id` 是宿主自己**稳定且拼写正确**的标识（拼错只会多出一条待配置软件，不会报错）；
- [ ] 组件版本已锁定（tarball 或整份 `dist/`），不依赖 CDN `latest`；
- [ ] 深色模式与站点一致（`theme`），截图遮挡区域已用 `data-feedback-capture-mask` / `FeedbackCaptureMask` 标注；
- [ ] 日志接入已按附件规范实现（≤3 份、≤1 MiB、UTF-8、扩展名 `.log/.txt/.json/.jsonl`，并随 `metadata.logs` 提供摘要）；
- [ ] 产品文案已改为「反馈已保存」，等待态（等待配置 / 等待来源确认 / 等待人工归档）**不显示为失败**，也不再无限轮询；
- [ ] 管理员已知晓：先确认来源 → 配置规则 → 点「启用自动归档并处理积压」（或逐条人工归档）。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/api.md`](api.md) | HTTP 契约：认证、软件配置、连接测试、反馈接口与状态机、multipart `capture` 字段、跨源规则 |
| [`docs/deployment.md`](deployment.md) | 部署与运维：环境变量、Docker、备份/迁移、升级与回退限制、处理与失败行为 |
| [`README.md`](../README.md) | 项目总览、仓库结构、关键设计 |
| [`packages/web/README.md`](../packages/web/README.md) | Web 组件权威参考：属性 / 方法 / 事件 / 截图与遮挡 / `captureProvider` 契约 / 包体与懒加载 |
| [`flutter/feedback/README.md`](../flutter/feedback/README.md) | Flutter 包权威参考：平台支持、遮挡、捕获会话、草稿与提交、登录、令牌存储键 |
| [`docs/flutter-storage-compat.md`](flutter-storage-compat.md) | Flutter 安全存储兼容：9/10/11 版本矩阵、宿主义务、迁移边界与步骤、验证范围、待提交信息 |
| [`examples/html/README.md`](../examples/html/README.md) | 原生 HTML：UMD 自托管与静态服务 |
| [`examples/react/README.md`](../examples/react/README.md) | React 19 + Vite：类型声明、StrictMode、事件清理 |
| [`examples/vue/README.md`](../examples/vue/README.md) | Vue 3 + Vite：`isCustomElement`、模板 ref |
| [`examples/ssr/README.md`](../examples/ssr/README.md) | SSR：为什么只能在客户端动态加载 |
| [`examples/flutter/README.md`](../examples/flutter/README.md) | Flutter 示例：`MaterialApp.builder` 挂载、第二路由与宿主对话框、构建备注 |
| [`VERIFICATION.md`](../VERIFICATION.md) | 验证记录与**未验证 / BLOCKED** 清单 |

## 可选 Assist 事件接入（0.5.0）

默认关闭。需要接入时，给服务进程显式注入以下环境变量（使用 Docker Compose 时还需在
服务的 `environment` 中传入，单写宿主 `.env` 不会自动传入容器）：

| 环境变量 | 用途与默认值 |
|---|---|
| `FEEDBACK_ASSIST_HUB_URL` | Assist 中枢基地址；未设置时不入队、不投递、不开放只读接口 |
| `FEEDBACK_ASSIST_SOURCE_KEY` | 中枢签发的上报 Bearer 密钥；启用时应同时配置 |
| `FEEDBACK_ASSIST_READ_KEY` | 中枢拉取本服务反馈/附件的独立密钥；缺省回退到来源密钥 |
| `FEEDBACK_ASSIST_QUEUE_MAX` | pending 队列容量，默认 1000 |
| `FEEDBACK_ASSIST_FLUSH_MS` | 空闲轮询间隔，默认 2000 毫秒 |

事件与反馈在同一数据库事务入队，发送至中枢 `POST /api/v1/ingest/events`，包含反馈正文、
状态及附件元数据；附件字节由中枢经只读接口另行拉取。网络失败持久化退避重试，401 暂停后
定期探测。队列超限会丢弃最旧待发送项并记录溢出汇总，不能将本地队列视为永久审计存档。

中枢使用 `Authorization: Bearer <READ_KEY>` 访问：

- `GET /api/assist/feedback/:id`：反馈详情和附件元数据。
- `GET /api/assist/feedback/:id/attachments/screenshot`：PNG 截图。
- `GET /api/assist/feedback/:id/attachments/logs/:logId`：日志下载。

只读凭证可读取全部反馈，请仅交给受信中枢，通过 HTTPS 传输并保存在服务端。
本地彻底删除会清除关联事件副本及附件；已经发出的请求和中枢已保存的数据不能由本地删除撤回。
