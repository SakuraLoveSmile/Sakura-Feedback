# 收尾记录（T1–T3）

> 本文件记录本轮「收尾与首批接入」的交付、版本、证据与剩余问题。
> 历史验证记录继续保留在 [`VERIFICATION.md`](../VERIFICATION.md)，不被本文件取代。
>
> 记录时间：2026-09-11。状态口径：**未开始 / 实现中 / 待体验 / 已验收**。

## 交付版本

| 项 | 值 |
|---|---|
| 仓库 | `git@github.com:SakuraLoveSmile/Sakura-Feedback.git`（本次确认为 **public**，见"剩余问题"） |
| 分支 | `main` |
| 组件版本 | `@feedback/web` 0.1.0、`feedback_widget` 0.1.0 |
| Web 安装包 | `feedback-web-0.1.0.tgz`，SHA-256 `0e300dac47811045bb9b150ad0e3001b68618a1f028354ca52560ebb39992737` |
| 宿主接入的组件提交 | `8c66cc07c3ba9e1fa706485b8b0b8ada25635343` |

## T1 — 构建、部署和故障处理可用

### 已修正的两个既有问题

**1) 同源校验以公网 origin 为准**

`apps/server/src/http.ts` 的 `expectedOrigin()` 优先使用 `FEEDBACK_PUBLIC_URL` 的 origin，
未配置时回退到请求 URL（保留本地/直连行为）。`checkSameOrigin()` 由 auth / admin / feedback
三处调用点共用，**没有**放开 Origin，也**没有**信任任何转发头来推导来源。

- 测试：`apps/server/test/auth.test.ts`（含 `publicUrl` 场景、伪造相似域名被拒、未登记来源被拒）。

**2) 不再强制覆盖 `FEEDBACK_COOKIE_SECURE=false`**

`compose.yml` 移除了该 `environment` 覆盖，改由 `.env` 决定。生产配置独立为 `deploy/`：
拉取 digest 固定镜像、端口只绑 `127.0.0.1:8787`、`Secure` Cookie、`/data` 命名卷、必填公网地址；
附 Nginx TLS 模板（域名/证书路径由部署时填写）。

- 验证：`docker compose config` 实跑（dev 与 prod 两份），prod 确认 `host_ip: 127.0.0.1`、
  `FEEDBACK_COOKIE_SECURE: "true"`、镜像引用为 `@sha256:...`。

### 版本交付（GitHub Actions）

- `.github/workflows/ci.yml`：PR / 分支推送只跑检查，**不发布**。
- `.github/workflows/release.yml`：`v*` 标签或手动触发 → 先复用 CI，通过后构建并推送
  `ghcr.io/sakuralovesmile/sakura-feedback`（**linux/amd64**），产出版本标签、提交 SHA 标签与 digest。
  仅 publish job 有 `packages: write`；构建不读取任何生产 `.env` / 数据库 / AI / Kaneo 凭据。
- 同轮上传 Web `.tgz`、完整浏览器 `dist` 压缩包、管理页 `dist`、`SHA256SUMS`、`SOURCE.txt`（含来源提交）、
  `image-digest.txt`；标签推送时挂到 GitHub Release。

**CI 真实运行证据（GitHub，非本地）**

- 记录：`chore: 建立可复现源码基线` → run `34601787814`：`secrets-guard` ✓，`node-checks` ✗（见下）。
- 记录：`fix(ci): 全新检出时先 build 再 typecheck` → run 随后：`secrets-guard` ✓、
  `node-checks` ✓（install → build → typecheck → lint → test）、`flutter-checks` ✓（组件包与示例 analyze+test）。

**修掉一个"本地能过、干净检出会挂"的 CI 缺陷**

`examples/*` 依赖 workspace 包 `@feedback/web`，其类型入口是 `dist/index.d.ts`；全新检出时 `dist`
不存在，直接 `typecheck` 会报 `TS2307 Cannot find module '@feedback/web'`。本地能过只是残留了上次构建产物。

- 复现：删除 `packages/web/dist` 后 `pnpm -r typecheck` → 真实复现该错误。
- 修复：CI 步骤顺序改为 **build → typecheck → lint → test**；修复后本地与 GitHub 均通过。

### 视觉能力探针（不再"假通过"）

`/api/admin/connection/ai/test-vision` 保持 `{ok, reply?, reason?}` 响应结构，但实现改为：

- 服务端用 `sharp` 生成**随机 3 色块**图（颜色从 6 色调色板不重复抽取）；
- **期望顺序只留在服务端**，提示词里只说"从左到右 3 个纯色块，用英文小写颜色单词回答"，
  不含任何调色板颜色名（有测试断言提示词不含颜色名）；
- 回答顺序与期望不完全一致即返回 `ok:false` 并给出明确 `reason`。

这直接堵住旧探针的漏洞：旧实现是 1×1 像素图 + 提示词自带期望答案，模型忽略图片只回固定话术也会通过。

- 测试：`apps/server/test/external-clients.test.ts` 新增一组（探针图尺寸/唯一性/像素还原顺序、
  提示词不泄漏答案、正确顺序 → `ok:true`、错误顺序 → `ok:false`、**旧探针的通过条件现在必须失败**）。
- **变异检查**：把匹配判断临时改成恒真 → 上述两条失败用例如期失败，证明断言非空转。

### 恢复与重复操作

沿用现有恢复状态机，本轮**未新增**任何自动补发。相关既有覆盖（归档一致性、失败重试、
待核对恢复、过期页面冲突、重复提交不重复建任务、重启后数据仍在）保留在
`apps/server/test/{pipeline,fault-injection,archive-consistency,archive-data}.test.ts`。

## T2 — RAG 与 Comic 接入同一服务

### RAG（`RAG/frontend`）

- 依赖：Web 安装包放入项目内版本化目录 `vendor/feedback-web-0.1.0.tgz`，
  `package.json` 写作 `"@feedback/web": "file:vendor/feedback-web-0.1.0.tgz"`（**不引用本机绝对路径**）。
- `vite.config.ts`：按 Vue 示例设置 `compilerOptions.isCustomElement = tag === 'feedback-widget'`。
- `src/App.vue`：组件挂在**根部**（`router-view` 之外），路由切换不重建实例；动态 `import('@feedback/web')`，
  只有配置齐全时才加载。
- 配置：`VITE_FEEDBACK_API_BASE` + `VITE_FEEDBACK_APP_ID`；**任一为空则整段不渲染**（宿主行为不变）。
- 页面标签：`String(route.name ?? 'unknown')`，**只传名称、不带查询参数**。
- 服务端登记：`appId=rag`，允许来源需含 `http://127.0.0.1:5174`（实际开发入口）与部署后的真实 origin。
- 遮挡：**该应用没有密钥/凭据输入界面**（已检索 views/components 确认），故"配置页密钥区域遮挡"在此处不适用。

**验证证据**

- `npm run build` 通过。
- **条件打包实证**：不配置时产物**不含** `feedback-widget`；配置后新增
  `dist/assets/feedback-web-*.js`(67.9 KB) 与 `html2canvas-pro.esm-*.js`(248.8 KB) 两个懒加载分块。

### Comic Android（`Comic/android/app`）

- 依赖：`feedback_widget` Git 依赖，SSH url + `path: flutter/feedback` + `ref` 固定为
  `8c66cc07c3ba9e1fa706485b8b0b8ada25635343`；宿主 `pubspec.lock` 已提交，
  其中 `resolved-ref` 与 `ref` 一致。
- `lib/main.dart`：控制器由**应用根**持有并在根 `dispose()` 释放；经 `MaterialApp.builder` 挂载，
  复用示例的「外层 Navigator（只承载组件、不做跳转）+ `FeedbackWidget` 包裹应用 Navigator 子树」结构，
  以提供 `Overlay`/`Navigator` 祖先（面板选择浮层、截图放大 `showDialog` 需要）。
- 配置：`--dart-define=FEEDBACK_API_BASE=...`、`--dart-define=FEEDBACK_APP_ID=comic-android`；
  未配置时 `builder` 为 `null`，宿主行为完全不变。
- 未触碰 Rust、FRB 生成代码、阅读数据库与 Komga 规则。
- 遮挡：`server_form_screen.dart` 的 **API Key（X-API-Key）** 字段整块包进 `FeedbackCaptureMask`。

**验证证据**

- `flutter pub get` 成功（本机 SSH 22 端口不通，仅本地验证用一次性 env 覆盖改走 HTTPS；
  `pubspec.yaml` 内保持 SSH url，未改全局 git config）。
- `flutter analyze` → **No issues found**。
- `flutter test` → **159 项通过**。
- **挂载双分支实测**：临时用例分别在不带/带 `--dart-define` 下运行，均通过；
  再**变异检查**（把 `builder` 临时改成 `null`）→ 带配置那条如期失败，证明断言非空转。临时用例已删除。

### 两端统一

- 首批均使用**可拖动灵感球 + 视口截图**：Web 侧显式 `launcher-mode="orb"` + `capture-mode="viewport"`，
  Flutter 侧显式 `FeedbackLauncherMode.orb` + `FeedbackCaptureMode.viewport`。
- 客户端只持有 Feedback 接入配置；AI 与 Kaneo 密钥只在服务端，归档目标（Kaneo 项目/列）由服务端登记。
- Feedback 登录独立于宿主登录，**未新增**账号同步或单点登录。
- 基线：Comic 实施前记录 115 项既有未提交改动 + HEAD `0509c49`；RAG 非 Git 管理，修改前对
  `package.json` / `package-lock.json` / `vite.config.ts` / `src/` 做了针对性备份，未覆盖其他工作。

## T3 — 后续项目能照着安装

- 唯一接入指南仍为 [`docs/integration.md`](integration.md)，本轮补充：
  - §2.4 跨仓库 Flutter 依赖改为**已验证**的 SSH + 固定 SHA 写法（含本地 SSH 不通时的一次性 env 覆盖）；
  - §2.6 边界更新（已有发布流水线；云端尚未上线）；
  - §2.7 新增：镜像坐标/标签/digest、私有 GHCR 只读拉取、生产部署、升级与回退、客户端如何跟上同一版本。
- 未把访问令牌写入任何依赖 URL；私有 Git 走 SSH 配置，云服务器拉取 GHCR 使用只读凭据。

## 剩余问题 / 未验证（不得读作已通过）

1. **仓库可见性**：目标文档假设仓库为 private，但实际为 **public**。因此按当前配置发布的 GHCR 包默认也是
   public。是否改为 private（或调整包可见性）需你决定——**尚未推送任何标签，故尚未发布任何镜像**。
2. **release.yml 尚未真实跑过**：只跑了 `ci.yml`。构建/推送镜像与 Release 挂件需要一次 `v*` 标签或手动触发才能验证。
3. **Nginx 模板未做 `nginx -t`**：本机 Docker daemon 未运行，无法起 nginx 容器校验语法；模板占位符替换已实测无残留。
4. **视觉探针只做了能力层验证**：真实多模态模型未配置，`test-vision` 未对真实模型跑过；
   「能力探针不能替代业务验收」——`organize → Kaneo` 的真实截图闭环仍待你配置模型后进行。
5. **本地 SSH 到 GitHub 22 端口不通**：`ssh.github.com:443` 返回 `Permission denied (publickey)`，
   即当前机器的 key 未注册。推送基线走的是 HTTPS + `gh` 凭据助手；CI 与生产机需可用 SSH 才能拉取私有 Git 依赖。
6. **真实 Android 实机未验收**：未在 Mi 10 上安装含真实 Rust 核心的构建，未验证书库/阅读页/设置页呼出、
   截图、键盘、返回键与重启后登录存储。
7. **RAG 运行时未在浏览器实测**：仅做了构建与条件打包验证，未在 `127.0.0.1:5174` 打开面板提交。
8. **Comic 改动未提交**：宿主已有 115 项未提交改动，本轮改动与它们混在工作区，未擅自提交。
