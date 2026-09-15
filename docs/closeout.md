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

## 任务状态

按计划的四个口径（未开始 / 实现中 / 待体验 / 已验收）。**只有你确认效果后才记「已验收」。**

| 任务 | 状态 | 说明 |
|---|---|---|
| T1 云服务器可拉固定镜像长期跑 HTTPS | **待体验** | 镜像/Actions/生产 compose/Nginx 模板/故障处理均已实测；差真实域名与公网证书 |
| T2 RAG 与 Comic 接入同一服务 | **实现中** | 两端代码与依赖已落地、构建通过；差真实 Kaneo 写入、RAG 5174 浏览器实测、Mi 10 实机 |
| T3 后续项目照着指南安装 | **待体验** | 指南已补（镜像拉取/私有认证/固定 SHA/升级）；差一个真实新项目照做一遍 |

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
- `.github/workflows/release.yml`：**稳定渠道判定以 [`docs/release.md`](release.md) 为权威口径**——
  4 个条件同时满足才算稳定发布：①事件是标签推送；②标签是正式 `vX.Y.Z`（无预发布后缀）；
  ③标签严格等于 `v<根 package.json 的 version>`；④标签指向本次运行的提交。满足时构建并推送
  `ghcr.io/sakuralovesmile/sakura-feedback` 与 `ghcr.io/sakuralovesmile/sakura-feedback-updater`
  **两个镜像**（**linux/amd64**），产出版本标签、提交 SHA 标签与 digest。
  仅 `publish` job 有 `packages: write`，仅最后公开 Release 的 job 有 `contents: write`；
  构建不读取任何生产 `.env` / 数据库 / AI / Kaneo 凭据。
- 同轮上传 Web `.tgz`、完整浏览器 `dist` 压缩包、管理页 `dist` 压缩包、`SHA256SUMS`、`SOURCE.txt`（含来源提交）、
  两个镜像的 digest（`feedback-image-digest.txt`、`updater-image-digest.txt`）与稳定清单
  `release-manifest.json`。标签推送时**先创建 draft Release**，把全部产物与清单传上去并复查资产齐全
  （缺一即失败退出、保持 draft），**最后一步才公开**；流水线不改动已公开的 Release，
  因此不会出现「已公开但产物缺失」的状态。
- **有意收紧（v0.3.0 起）**：预发布标签与 `workflow_dispatch` 手动触发**不再创建 Release**、
  也不产出稳定清单（手动触发只按 `sha-<40位>` 推送镜像用于验证构建）。原因：更新执行器按
  `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json` 取清单，
  任何非稳定内容都不能进 Releases，否则生产更新可能被引到未发布的版本上。

**CI 真实运行证据（GitHub，非本地）**

- 记录：`chore: 建立可复现源码基线` → run `34601787814`：`secrets-guard` ✓，`node-checks` ✗（见下）。
- 记录：`fix(ci): 全新检出时先 build 再 typecheck` → run 随后：`secrets-guard` ✓、
  `node-checks` ✓（install → build → typecheck → lint → test）、`flutter-checks` ✓（组件包与示例 analyze+test）。

**修掉一个"本地能过、干净检出会挂"的 CI 缺陷**

`examples/*` 依赖 workspace 包 `@feedback/web`，其类型入口是 `dist/index.d.ts`；全新检出时 `dist`
不存在，直接 `typecheck` 会报 `TS2307 Cannot find module '@feedback/web'`。本地能过只是残留了上次构建产物。

- 复现：删除 `packages/web/dist` 后 `pnpm -r typecheck` → 真实复现该错误。
- 修复：CI 步骤顺序改为 **build → typecheck → lint → test**；修复后本地与 GitHub 均通过。

**发布实跑（v0.1.0，2026-09-11）**

> 以下记录的是 **v0.1.0 时期**的流程与产物：当时只推 feedback 一个镜像、镜像 digest 只作为工作流产物上传、
> 任何 `v*` 标签推送都会直接创建并公开 Release（Release 上共 5 个资产，没有稳定清单）。
> v0.3.0 起已改为「两个镜像 + `release-manifest.json` + draft→最后公开」，以本文件上文与
> [`docs/release.md`](release.md) 为准。这一段保留为历史证据，**不代表当前流程**。

已推 `v0.1.0` 标签触发 `release.yml` 真实运行（run `34602966331`），全部 job 通过：

| job | 结果 |
|---|---|
| `checks / secrets-guard` | ✓ |
| `checks / node-checks` | ✓ |
| `checks / flutter-checks` | ✓ |
| `artifacts`（同轮产物 + Release 挂件） | ✓ |
| `publish`（构建并推送镜像、记录 digest） | ✓ |

镜像坐标与实跑产物：

```
image:  ghcr.io/sakuralovesmile/sakura-feedback
digest: sha256:9e38eec3980b8e7920e08c7a7e55b6b50d95b9af62f043d9e3aa4d8fd4b47b94
tags:   v0.1.0 | sha-d326c19ff9a18ce79ae16e64481f7bac767e01f8 | latest
```

**独立核验（不依赖本机 Docker daemon）**：直接查 GHCR registry manifest——

- manifest 可取回，`docker-content-digest` = 上述 digest（一致）；
- manifest 为 OCI image index，其中 **`linux/amd64`** 条目存在（另一条 `unknown/unknown` 是
  `provenance: true` 生成的构建溯源 attestation，属预期）。

因为仓库是 public，`docker pull ghcr.io/sakuralovesmile/sakura-feedback@sha256:9e38...` 无需登录即可拉取；
`deploy/compose.prod.yml` 正是以该 digest 固定引用，不使用 `latest`。
（`latest` 标签由 docker metadata-action 在标签构建时自动附加，指向同一 digest；
后续发布是否刷新它取决于是否再推版本标签，生产侧不依赖它。）

**Release 资产（同轮构建上传，已核对）**

`gh release view v0.1.0` 共 5 个资产：

| 资产 | 大小 |
|---|---|
| `feedback-web-0.1.0.tgz` | 205,300 B（与本机 `pnpm pack` 产物字节数一致） |
| `feedback-web-dist.zip` | 199,672 B |
| `feedback-admin-dist.zip` | 70,158 B |
| `SHA256SUMS` | 273 B（覆盖上面三个） |
| `SOURCE.txt` | 112 B |

`SOURCE.txt` 内容：

```
commit=d326c19ff9a18ce79ae16e64481f7bac767e01f8
ref=refs/tags/v0.1.0
run=34602966331
node=v22.23.2
pnpm=11.23.0
```

其中 `commit=` 与 `git rev-parse v0.1.0^{commit}` **完全一致**——这正是"Flutter 使用同一个提交 SHA"
所要引用的值（Comic 的 `ref` 也指向该提交）。



`/api/admin/connection/ai/test-vision` 保持 `{ok, reply?, reason?}` 响应结构，但实现改为：

- 服务端用 `sharp` 生成**随机 3 色块**图（颜色从 6 色调色板不重复抽取）；
- **期望顺序只留在服务端**，提示词里只说"从左到右 3 个纯色块，用英文小写颜色单词回答"，
  不含任何调色板颜色名（有测试断言提示词不含颜色名）；
- 回答顺序与期望不完全一致即返回 `ok:false` 并给出明确 `reason`。

这直接堵住旧探针的漏洞：旧实现是 1×1 像素图 + 提示词自带期望答案，模型忽略图片只回固定话术也会通过。

- 测试：`apps/server/test/external-clients.test.ts` 新增一组（探针图尺寸/唯一性/像素还原顺序、
  提示词不泄漏答案、正确顺序 → `ok:true`、错误顺序 → `ok:false`、**旧探针的通过条件现在必须失败**）。
- **变异检查**：把匹配判断临时改成恒真 → 上述两条失败用例如期失败，证明断言非空转。

#### 真实模型接入后发现的**探针假失败**（已修，属仪器缺陷不是模型问题）

你配置好真实视觉模型后首次跑探针，实测 **14/15 通过**，唯一一次失败是：

```
exp=blue,yellow,purple   got=blue, yellow, magenta
```

即模型**读对了图**（blue/yellow 都对；连对 3 色顺序的概率是 1/120，两次连续通过不可能是猜的），
只是把「紫色块」念成了 magenta。追下去发现**是探针自己的问题**：

| 色块标签 | 旧 RGB | 实际最近的命名色 |
|---|---|---|
| purple | `140,50,190` | **darkorchid**(19) ← 蓝紫，被念成 magenta/violet 完全合理 |
| red | `220,40,40` | **crimson**(28) |
| green | `40,170,50` | **forestgreen**(35) |
| blue | `40,70,220` | **royalblue**(43) |
| yellow | `240,225,30` | **gold**(35) |
| orange | `245,140,25` | **darkorange**(27) |

**6 个色块全部**「最近命名色 ≠ 自己的标签」——色值是按**意图**取的，不是按命名口径取的。
于是模型照实念出它看到的名字，却与期望不等 → 被判失败。这是**假失败**：
惩罚的是模型的命名习惯，而不是"有没有看图"。

**修法（不放宽判定，只消除歧义）**：色值改用 **CSS 标准命名色本身**
（`red #f00`、`green #008000`、`blue #00f`、`yellow #ff0`、`orange #ffa500`、`purple #800080`）。
修后每个色块"最近命名色 == 自己的标签"，优势 25–127，色块两两最小距离 90。

- **严格性未变**：顺序仍随机、期望仍只在服务端、仍要求逐位完全一致。
- 新增**自检断言**守住这类缺陷：`调色板自检：每个色块"最近的命名色"就是它自己的标签`，
  并额外断言任意两色距离 > 60（防止测试里"采样像素→就近匹配"自相混淆）。
- **变异检查**：把 purple 改回 `140,50,190` → 该断言如期失败并打印
  `色块 purple=rgb(140,50,190) 最近的命名色是 darkorchid；模型照实念就会被判失败`。
- 修后对**你的真实模型**重跑 **18/18 通过**（紫块出现多次，均正确）。

> 结论不变、但更重要了：探针通过只证明"模型会看图"，**不替代**真实截图闭环验收。

### 生产 HTTPS 形态实测（Nginx TLS 终止 + 公网 origin 校验）

本轮把生产部署形态真正搭起来跑了一遍（不是只看配置文本）：`deploy/nginx/feedback.conf.template`
替换占位符 → `nginx -t` 通过 → 用自签证书起 `nginx:alpine` 反代到服务容器
（服务设 `FEEDBACK_PUBLIC_URL=https://localhost:8443`、`FEEDBACK_COOKIE_SECURE=true`、
端口只绑回环）。实测结果：

| 检查 | 结果 |
|---|---|
| `nginx -t`（模板替换后） | **syntax is ok / test is successful** |
| 80 → 443 | `301` → `https://localhost/healthz` |
| 经 Nginx 的 HTTPS `GET /healthz` | `200`（TLS 终止 + 反代可用） |
| 安全头 | `strict-transport-security: max-age=31536000`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer` |
| 登录（`Origin` = 公网地址）| `HTTP/2 200`，`set-cookie: fb_session=…; HttpOnly; **Secure**; SameSite=Lax` |
| 管理页保存连接配置（公网 origin）| `200 {"ok":true,"apiKeySet":true}` — **没有** `origin_mismatch` |
| 伪造 `Origin: https://evil.example` | `403 {"code":"origin_mismatch"}` |
| 登记 `appId=rag`（允许 `http://127.0.0.1:5174`）| `201` |
| 跨源预检（已登记 origin）| `204` + `access-control-allow-origin: http://127.0.0.1:5174` |
| 跨源预检（未登记 origin）| `404`，**无** CORS 回显 |

要点：这同时验证了 `http.ts` 的同源校验**确实以 `FEEDBACK_PUBLIC_URL` 为准**——
容器内部看到的请求 URL 是 `http://fb-tls-app:8787`，与浏览器 `Origin` 完全不同，
若仍按内部 URL 判断就会误报 `origin_mismatch`；实测通过，说明修复生效。

未做：真实域名 + 公网证书（等域名/证书）；真实 RAG 宿主的登录弹窗跨源流程（需要你本地起 5174）。

### 管理页实际操作（失败重试 / 待核对恢复 / 过期页面冲突）

在隔离实例（`fb-ui`，端口 8797，命名卷，mock 在 8898/8899）里用真实浏览器打开
`http://127.0.0.1:8797/admin/` 走了一遍**管理页**而不是只调接口。前置数据：一条 `needs_review`
（mock 在 `task` 阶段 `hold`+`afterWrite` 制造「远端已写入但响应丢失」，然后 `docker restart`）
和一条 `failed`（`task` 阶段 `mode=definite` → Kaneo 403 明确拒绝）。

| 操作 | 界面表现 | 结果 |
|---|---|---|
| 列表页 | 两行分别显示 `待核对` / `失败`，操作者、标题、时间、Kaneo 列齐全 | 与库内状态一致 |
| 待核对 → 「详情」 | 弹窗展示：状态、反馈 ID、提交时间、处理轮次、**用户原话**、**界面截图**（24×24、0.1 KB、`新窗口打开`）、**AI 整理结果**（使用体验 / 问题）、错误摘要；按钮只有 `重新核对` + `确认缺失，再次创建` | 按 `allowedActions` 渲染，未多给动作 |
| 点「重新核对」 | 记录 `待核对 → 处理中`，Kaneo 列立刻出现指向 `…/task/e2e-task-1` 的任务链接；刷新后 `已归档` | **复用既有远端任务**，mock 任务数仍为 1（未重复创建） |
| 失败 → 「详情」 | 只提供 `重试处理`（`failed` 的唯一动作），附 `最后错误` | 与状态机一致 |
| 点「重试处理」 | `202 → archiving → archived`（注入已清除，故本次成功） | 失败重试可用 |
| **过期页面冲突** | 持有旧 revision 的弹窗上再次操作 → HTTP `409` `revision_conflict`，界面渲染「**页面数据已过期（revision 冲突），请刷新后重试**」 | 乐观锁生效且错误文案可见 |

证据截图：`e2e/shots/ADMIN-revision-conflict.png`（含冲突提示的那一屏）。

### 恢复与重复操作

沿用现有恢复状态机，本轮**未新增**任何自动补发。相关既有覆盖（归档一致性、失败重试、
待核对恢复、过期页面冲突、重复提交不重复建任务、重启后数据仍在）保留在
`apps/server/test/{pipeline,fault-injection,archive-consistency,archive-data}.test.ts`。

#### 停服备份 / 保留主密钥 / 隔离恢复（本轮新增，自动脚本）

新脚本 `e2e/run_backup_restore.py`，**28/28 通过**（`python3 e2e/run_backup_restore.py`）。
前置：宿主 mock 在 8898/8899、镜像 `feedback-service:local` 已构建、Docker 可用。

它自建容器/卷（`fb-br-a/b/c`，端口 8791–8793），不依赖 `run_docker.py` 的模块级常量：

1. 实例 A 用主密钥 A 保存 Kaneo/AI 凭据（密文）并登记软件；在 mock 的 `task` 阶段注入
   `hold`+`afterWrite`，制造「**远端已写入但结果未知**」：mock 确实创建了任务（`tasks: 0→1`），
   而请求被挂起。
2. `docker restart`（模拟进程崩溃）→ 记录转 `needs_review`
   （`error_summary`：*服务在处理中断，Kaneo 写入结果不确定，待核对*），**且没有重复创建任务**（`1→1`）。
3. `docker stop --time 30` → `data/` 只剩 `feedback.db`（无 `-wal`/`-shm`）。
4. 整目录拷贝到隔离卷 → 实例 B 用**同一主密钥**启动：记录仍在、仍是 `needs_review`、
   Kaneo 连接测试 `ok:true`（凭据可解密）、mock 任务数 **1→1（隔离恢复不向 Kaneo 重放）**。
5. 反证：实例 C 换**不同主密钥**启动同一份数据 → 连接测试 `502 ok:false`（无法解密），
   且同样零远端写入。

#### 顺带修掉的一个真实缺陷：优雅退出从未实现

`docs/deployment.md` 原本声称「优雅退出会关闭 SQLite WAL 并完成 checkpoint」，但
`apps/server/src/index.ts` 当时**没有任何 `SIGTERM`/`SIGINT` 处理**——实测 `docker stop` 后
`data/` 里 `feedback.db-wal` 仍在。这会让人误以为「只拷 `feedback.db` 单文件」是安全的。

本轮实现并验证：

- `apps/server/src/index.ts` 新增优雅退出：收到 `SIGTERM`/`SIGINT` → 停止接受新请求
  （并关闭空闲 keep-alive 连接）→ `worker.idle()` 等队列排空 → `PRAGMA wal_checkpoint(TRUNCATE)`
  → `db.close()` → 退出。20s 未排空则退出并由下次启动的恢复流程兜底（绝不自动补发）。
- `deploy/compose.prod.yml` 设 `stop_grace_period: 30s`：`docker stop` 默认只给 10s 就 `SIGKILL`，
  会早于应用自身的 20s 预算，把 WAL 留在盘上。
- `docs/deployment.md` 改写成与实现一致的停机步骤，并补上「残留 `-wal` 时不要只拷单文件」的处置。
- 证据：同一脚本第 3 步断言停机后无 `-wal`/`-shm` 残留（修复前实测有 `feedback.db-wal`）。

> 写这个脚本时先踩了 4 个**脚本自身**的坑（不是产品问题），已全部修正并记录以免复发：
> AI mock 端口写成 Kaneo 的 8898（→ AI 阶段 404 → 记录 `failed`）；用 `uncertain` 模式期待
> 「远端已写入」（该模式其实在写入前就掐断连接，远端不留任务）；连接测试缺少必填
> `{"projectId": "p-docker"}`；用客户端令牌的会话去读管理接口（403 `凭据类型不允许此操作`）。

## T2 — RAG 与 Comic 接入同一服务

### RAG（`RAG/frontend`）

- 依赖：Web 安装包放入项目内版本化目录 `vendor/feedback-web-0.1.0.tgz`，
  `package.json` 写作 `"@feedback/web": "file:vendor/feedback-web-0.1.0.tgz"`（**不引用本机绝对路径**）。
- `vite.config.ts`：按 Vue 示例设置 `compilerOptions.isCustomElement = tag === 'feedback-widget'`。
- `src/App.vue`：组件挂在**根部**（`router-view` 之外），路由切换不重建实例；动态 `import('@feedback/web')`，
  只有配置齐全时才加载。
- 配置：`VITE_FEEDBACK_API_BASE` + `VITE_FEEDBACK_APP_ID`；**任一为空则整段不渲染**（宿主行为不变）。
- 页面标签：`String(route.name ?? 'unknown')`，**只传名称、不带查询参数**。
- **已在浏览器实测**（隔离服务 `fb-rag` :8798 + `vite --port 5174`，注入
  `VITE_FEEDBACK_API_BASE=http://127.0.0.1:8798`、`VITE_FEEDBACK_APP_ID=rag`）：
  - 组件确实挂载为自定义元素，属性齐全：
    `api-base=http://127.0.0.1:8798 app-id=rag page-label=today side=right launcher-mode=orb capture-mode=viewport`，
    带 Shadow DOM，**无** `Failed to resolve component: feedback-widget` 警告（证 `isCustomElement` 生效）。
  - 宿主导航 `/today → /recall`：`page-label` 随之 `today → recall`，**同一实例保留**
    （在 DOM 节点上打的标记存活）、页面内 `feedback-widget` 数量恒为 **1** ⇒ 路由切换不重建。
  - 未登记来源被拒（本机 5174 未登记到该实例）：跨源资源请求返回 `502`；登记 `appId=rag`
    且 `allowedOrigins=['http://127.0.0.1:5174']` 后 CORS 预检才回显（另见上文 HTTPS 一节的 204/404 证据）。
  - **未做**：在 5174 里完成一次真实登录→截图→提交（需你在有真实 Kaneo/AI 的环境点一次）。
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
- **本轮复跑（改动落地后）**：`flutter analyze`（`flutter/feedback`）→ **No issues found**；
  `flutter test` → **76 项通过**。
  （更正：此前记的「159 项」不准确——`Feedback/flutter/` 下只有 `feedback/` 一个包，
  实测与 `test/*.dart` 中的 test 声明数均为 **76**；以 76 为准。）
- **宿主侧复跑**：`Comic/android/app` `flutter analyze` → **No issues found**；
  再对两个接入点单独分析（`lib/main.dart`、`lib/src/server_form_screen.dart`）→ **No issues found**。
  即分析器能沿 Git 依赖解析到 `feedback_widget`，集成在编译期成立；
  `pubspec.lock` 中 `resolved-ref` 与 `ref` 完全一致（`8c66cc07…`）。
- **挂载双分支实测**：临时用例分别在不带/带 `--dart-define` 下运行，均通过；
  再**变异检查**（把 `builder` 临时改成 `null`）→ 带配置那条如期失败，证明断言非空转。临时用例已删除。
- **仍未做**：Mi 10 实机的书库/阅读页/设置页呼出、截图、键盘、返回键与重启后登录存储。

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
  - §2.7 新增：镜像坐标/标签/digest、私有 GHCR 只读拉取、生产部署、升级与回退、客户端如何跟上同一版本
    （U1 轮起该节追加：稳定渠道 4 条件、双镜像与更新执行器镜像、稳定清单 `release-manifest.json`、
    draft→最后公开的顺序）。
- 未把访问令牌写入任何依赖 URL；私有 Git 走 SSH 配置，云服务器拉取 GHCR 使用只读凭据。

### 全新目录独立安装验证（脱离 monorepo）

在 `/tmp` 新建空项目，**只** `npm install` 项目内版本化目录里的 tgz（不引用 monorepo、不引用本机绝对路径），
用打包器构建后断言：

| 断言 | 结果 |
|---|---|
| 组件可用（入口分块含 `feedback-widget` 注册） | PASS |
| 截图懒加载分块随包产出（`html2canvas-pro.esm-*.js`，248,836 B） | PASS |
| 入口分块引用该懒加载分块（动态 import 可达，非遗漏分块） | PASS |
| 产物不含本机绝对路径（无 `Personal Project/Feedback`） | PASS |
| 依赖只有 `html2canvas-pro@2.4.2`，无 workspace 链接 | PASS |

即：Web 安装包不依赖 workspace 链接、不依赖本机缓存，也没有遗漏截图懒加载分块。

Flutter 侧的对应验证（**同样在全新空目录里做**，`/tmp/fb-flutter-dep`，
`pubspec.yaml` 只含 `flutter` sdk 与那一条 git 依赖，不引用 monorepo、不引用本机路径）：

| 断言 | 结果 |
|---|---|
| `flutter pub get` 成功（57 个依赖，无 workspace 链接） | PASS |
| `pubspec.lock` 的 `resolved-ref` == `ref` 指定的 sha | PASS（`8c66cc07…`） |
| 包解析到 **pub 缓存**而非 monorepo：`~/.pub-cache/git/Sakura-Feedback-8c66cc07…/flutter/feedback` | PASS |
| `import 'package:feedback_widget/feedback_widget.dart'` 后 `flutter analyze` | PASS（No issues found） |

> 诚实边界：本机到 `github.com:22` 不通，上面用的是文档里那条**一次性**
> `GIT_CONFIG_*` 覆盖把 `git@github.com:` 改写为 HTTPS（仓库为 public，故可读）。
> 即被验证的是**「Git 依赖 + 子目录 + 固定 SHA」这套机制**，
> **不是** SSH 认证本身——SSH 路径需在已配置 key 的机器/CI 上才能验证。

## 需要你完成（这些我无法代做）

### 1) 服务端登记两个软件身份（T2 的最后一环）

客户端只持有接入配置；Kaneo 项目与目标列由**服务端**登记。在管理页「软件」里各建一条：

| appId | 名称 | 允许来源（精确匹配 origin，不带路径） |
|---|---|---|
| `rag` | RAG 备考助手 | 开发入口 `http://127.0.0.1:5174` **+** 部署后的真实 origin（如 `https://rag.example.com`） |
| `comic-android` | Comic（Android） | 原生端不带 Origin 头，同源校验对非 Cookie 会话放行；仍建议登记以便管理与排查 |

每条还要选固定的 **Kaneo 项目 + 目标列**——这就是「各自 Kaneo 项目找到原文/图片/整理结果」的落点。

登记完，RAG 本地起法：

```bash
cd RAG/frontend
printf 'VITE_FEEDBACK_API_BASE=http://127.0.0.1:8787\nVITE_FEEDBACK_APP_ID=rag\n' > .env.local
npm run dev   # http://127.0.0.1:5174
```

Comic 构建/安装（含真实 Rust 核心，不用 Stub 界面）：

```bash
cd Comic/android/app
flutter build apk --debug \
  --dart-define=FEEDBACK_API_BASE=https://<你的反馈服务域名> \
  --dart-define=FEEDBACK_APP_ID=comic-android
```

### 2) 多模态模型与真实闭环

管理页填入 AI 的 baseUrl / model / apiKey（服务端加密保存）。之后：

1. 先点「AI 图像识别测试」——现在它会用**随机色块图**要求模型报出颜色顺序，答错即判失败；
2. 再走真实截图 `organize → Kaneo`，核对 Kaneo 里的原文、图片与整理结果
   （整理结果应包含**只存在于图片中**的可观察信息）。
   能力探针通过**不等于**业务闭环通过，两者都要看。

### 3) 云端上线（域名/证书/入口）

`deploy/compose.prod.yml` 与 Nginx 模板已就绪但**未部署**——填好域名、证书路径与
`FEEDBACK_IMAGE`（用上面那个 digest）后再上线；在此之前不声称云端已上线。

### 4) 真实 Android 实机验收

安装上面的 debug APK，在书库 / 阅读页 / 设置页验证：灵感球呼出、截图、键盘、
应用返回键，以及**重启后登录存储**仍在。执行时重新确认设备在线状态。

## 剩余问题 / 未验证（不得读作已通过）

1. **仓库可见性已确认可接受**：目标文档假设仓库为 private，实际为 **public**。已与你确认
   "仓库可开源、无隐私泄露风险"，因此按现有配置发布 **public** GHCR 包属于预期行为，不再是阻塞项。
2. **release.yml 已真实验证通过**（见上文"发布实跑"）：镜像已推送并可从 registry 取回 manifest，
   Release 上的 5 个资产齐全，`SOURCE.txt` 的 `commit=` 与 `v0.1.0` 指向的提交**完全一致**。
   此项不再是未验证。**但这只覆盖 v0.1.0 时期的单镜像流程**：本轮 U1 把 `release.yml` 扩展为
   「两个镜像 + 稳定清单 + draft→最后公开」，**扩展部分尚未在真实 GitHub Actions 上运行过**
   （本机只能做 YAML 与静态校验，见 [`docs/release.md`](release.md) 的验证状态一节）。
3. ~~**Nginx 模板未做 `nginx -t`**~~ → **已补做**：本轮起了 `nginx:alpine` 容器，模板替换占位符后
   `nginx -t` 通过，并实测 80→443 跳转、HTTPS 反代、`Secure` Cookie、公网 origin 校验
   （详见上文"生产 HTTPS 形态实测"）。**此项完成。** 仍未做的是真实域名 + 公网证书。
4. **视觉探针已对真实模型跑过**（`ark.cn-beijing.volces.com/api/coding/v3` / `minimax-m3`）：
   文本连通 `ok`；随机色块探针修掉仪器歧义后 **18/18 通过**（详见上文"探针假失败"）。
   **仍未做**：`organize → Kaneo` 的真实截图闭环——探针只证明"模型会看图"，不替代业务验收。
5. **本地 SSH 到 GitHub 22 端口不通**：`ssh.github.com:443` 返回 `Permission denied (publickey)`，
   即当前机器的 key 未注册。推送基线走的是 HTTPS + `gh` 凭据助手；CI 与生产机需可用 SSH 才能拉取私有 Git 依赖。
6. **真实 Android 实机未验收**：未在 Mi 10 上安装含真实 Rust 核心的构建，未验证书库/阅读页/设置页呼出、
   截图、键盘、返回键与重启后登录存储。
7. **RAG 已在浏览器实测（接入层）**：`vite --port 5174` 下组件挂载、属性、Shadow DOM、路由切换不重建
   均已实测（见 T2/RAG 段）。**仍未做**的是在 5174 里完成一次真实「登录 → 截图 → 提交」到真实 Kaneo。
8. **Comic 改动未提交**：宿主已有 115 项未提交改动，本轮改动与它们混在工作区，未擅自提交（按你选择保留）。
9. ~~**浏览器 E2E 本次未取得完整汇总**~~ → **已作废**：那次 SIGKILL 中断后的重跑成功，
   三引擎均取得完整汇总（见第 10 项与"跨引擎浏览器运行"）。中断时残留的
   `preview.py` / `mock-external.mjs` / tsx server 等进程已手动清理。**此项完成。**
10. **Firefox / WebKit 覆盖**：runner 已参数化（`--browser {chromium,firefox,webkit}`），同一套全量场景择引擎运行。
    **三引擎全绿：Chromium 237/237、Firefox 237/237、WebKit 237/237，exit 0。**
    其间先在 WebKit 上暴露 6 条失败，核实为 **harness 读取通道局限**（非产品缺陷），
    已改用服务端落库像素做断言（见"跨引擎浏览器运行"）。**此项完成。**
11. ~~**Docker 套件未跑**~~ → **已补做**：本轮在**重建后的镜像**上重跑 `e2e/run_docker.py`
    → **59/59 通过**（确认优雅退出改动未破坏 `docker restart` 的崩溃恢复契约）；
    并新增 `e2e/run_backup_restore.py` → **28/28 通过**（停服备份 / 保留主密钥 / 隔离恢复不重放）。
    **此项完成。**

## 跨引擎浏览器运行（Chromium / Firefox / WebKit）

同一套全量场景（`e2e/run_browser.py`）按引擎分别运行，用于覆盖检查项要求的
「截图、弹窗和提交路径」在三个引擎上的行为差异。

| 引擎 | 命令 | 结果 |
|---|---|---|
| Chromium | `python3 e2e/run_browser.py --browser chromium` | **237/237 通过，exit 0** |
| Firefox | `python3 e2e/run_browser.py --browser firefox` | **237/237 通过，exit 0** |
| WebKit | `python3 e2e/run_browser.py --browser webkit` | **237/237 通过，exit 0**（改进 harness 后） |

### WebKit 的 6 条失败 = **harness 局限**，不是产品缺陷（已核实并更正此前结论）

**更正**：我先前把这里写成"截图为 0 字节、图片静默丢失的真实缺陷"，**该结论是错的**。
错因是我只用 `GET /api/admin/feedback`（列表端点）看 `screenshot` 字段——
该端点**本就不返回**截图元数据（元数据只在 `GET /api/admin/feedback/<id>` 里加），
所以 `{}` 被我误读成"服务端没有图"。

用服务端作为唯一事实源重测（脚本留在 /tmp，未进仓库），WebKit 的结果是：

| 观测点（WebKit） | 实测 | 结论 |
|---|---|---|
| 管理端 detail `screenshot` | `byteSize=10193`，`width/height=1280x800` | **服务端有图** |
| `GET .../screenshot` 取回字节 | 10193 B，magic `\x89PNG\r\n\x1a\n` | 是合法 PNG |
| 取回图的像素直方图 | 白 957705、**红 37004**、**绿 27875** | 正是 orb.html 的地标配色 |
| 与本机 26491 B 预览图的直方图对比 | 三个计数**完全一致** | **上传的就是预览那张图** |
| sqlite `feedback_screenshots` | 有行，`byte_size=10193`，`sha256` 与 detail 一致 | 已落库 |

（预览 26491 B 与落库 10193 B 不同，是**服务端 sharp 重编码**所致，非丢图。）

所以真正的问题是 **harness 在 WebKit 上读不到 multipart 的文件部分**：
Playwright-WebKit 的 `request.post_data_buffer` 只给出元数据那一段（**592 B**），
截图部分读不到 → `screenshot` 解析成 0 B → 「上传字节 == 预览字节」断言必然失败，
并让该路径提前中断。**Chromium/Firefox 上该读取正常**，所以此前一直没暴露。

**因此**：这 6 条不是"产品在 WebKit 丢图"，而是"断言依赖了 WebKit 上不可靠的读取通道"。

**已修**：把三条「上传字节 == 预览字节」断言**删除**，改用服务端落库字节做
`same_pixels(服务端 PNG, 本地预览 PNG)` **逐像素**比对（`e2e/browser_paths.py` 新增
`pixel_sha` / `same_pixels`）。原始交付的那句断言在站点 1 之后**本就已冗余**——
紧接其后代码就会取回服务端 PNG 并做像素探针，所以这是**用更权威来源替代不可靠来源**，
断言强度不降（仍要求尺寸与每个像素一致），且让该路径不再中断、后续遮罩断言得以执行。

修后实测：

```
chromium   237/237 通过  exit 0
webkit     237/237 通过  exit 0   （原先 206/212）
```

Firefox 那次是**真实完整跑完**的：`=== E2E 结果：237/237 通过 ===`，退出码 0，
覆盖了灵感球拖拽/落点、遮罩像素级校验、遮挡失败规则、登录握手（真实弹窗 + 异源/nonce 负例）、
截图生命周期（重拍/移除）、multipart 提交落库、AI 失败分支、跨域会话恢复、窄屏键盘、Vue 示例接入。

用法（三引擎同命令，仅换 `--browser`）：

```bash
for b in chromium firefox webkit; do
  for p in 8787 8788 5187 5188 5189 8898 8899; do
    pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t); [ -n "$pid" ] && kill -9 $pid
  done
  python3 e2e/run_browser.py --browser "$b"
done
```

注意：三引擎共用 8787/5189 等端口，**必须串行**；runner 现在会在启动前检测端口占用并 FATAL 退出。

---

## v0.3.0 收尾记录（反馈附带日志、AI 分析与 Kaneo 归档）

> 记录时间：2026-09-14。
> 本轮交付三个核心目标：反馈能附带日志、日志能用于 AI 分析和人工排查、其他项目能按标准文档自行接入。只修改 Feedback 仓库及其示例，不改动外部项目（RAG、Comic、Kaneo），保留工作区既有改动。

### 1. 任务交付明细

| 子任务 | 范围 | 交付成果与验证指标 | 状态 |
|---|---|---|---|
| **L2** | 服务端存储与契约 | 数据库 Schema 升级至版本 4（`PRAGMA user_version = 4`），新增 `feedback_logs` 表与 `(feedback_id, sort_order)` 索引；请求体上限提升至 10 MiB（单日志 ≤1 MiB）；支持 multipart 传输 `logs` 描述符与有序文件流；内容哈希纳入日志摘要；提供管理端下载原始文件（`application/octet-stream`）与纯文本预览（`text/plain; charset=utf-8`）。 | **已完成** |
| **L1-Web** | Web 组件 SDK | `<feedback-widget>` 支持 `logProvider` 异步属性，呼出面板时自动采集，配有 3 秒超时保护（超时不阻塞编辑）；支持用户手动选择 `.log`, `.txt`, `.json`, `.jsonl` 附件；至多 3 份，单文件 ≤1 MiB；提供纯文本弹窗预览与单项移除；提交瞬间冻结快照，重试复用同一幂等键，修改日志自动生成新键。 | **已完成** |
| **L1-Flutter** | Flutter 组件 SDK | `FeedbackWidget` / `FeedbackPanel` 支持 `logProvider` 与 `filePicker`；呼出面板自动执行采集并施加 3 秒超时容错；提供手动添加日志、单行信息展示、文本预览弹窗、删除按钮；提交时冻结为 `_FrozenSubmit` 快照；相同快照沿用幂等键，修改日志失效旧键。 | **已完成** |
| **L3** | AI 分析与 Kaneo 归档 | 服务端日志截断算法：单文件截取尾部至多 8,000 Unicode 码点（按真实码点计数，保护 Emoji/多字节文本），全部附件总计至多 24,000 码点；大模型提示词设立不可信诊断输入防注入隔离区，原话与日志中的任何指令均不予执行；Kaneo 任务描述格式化注入日志元数据（名称、来源、体积、摘要），截图评论附带日志线索；归档恢复状态机完整保持幂等与核对兼容。 | **已完成** |
| **U1** | 系统更新与版本对齐 | 全仓版本对齐至 `0.3.0`（服务端、Web 组件、Flutter 组件、更新执行器）；`apps/updater` 探针脚本 `REQUIRED_TABLES` 纳入 `feedback_logs`；`compareDbProbes` 支持 `PRAGMA user_version ≥ 4` 核验，并兼容从旧版基线升级（旧版缺少 `feedback_logs` 计数时仅告警不报错）。 | **已完成** |
| **D1** | 标准接入文档与收尾 | 完善 [`docs/integration.md`](integration.md)（全面覆盖 React、Vue、原生 HTML、SSR、Flutter 的日志采集接入与附件规范）、更新 [`docs/api.md`](api.md)（记录 10 MiB multipart 上限、日志描述符契约与管理下载/预览端点），更新收尾记录。 | **已完成** |

### 2. 自动化验证全绿证据

#### 1) TypeScript 与 Monorepo 代码检查
- `pnpm typecheck`：8 个 Workspace 项目全通过（`apps/server`, `apps/admin`, `apps/updater`, `packages/web`, `examples/react`, `examples/vue`, `examples/ssr`）。
- `pnpm build`：全仓构建成功，生产产物正常打包（含 ESM / UMD 分块）。

#### 2) 单元与集成测试套件（全部通过）
- **`@feedback/server`**：13 个测试文件，**217 passed**
  - `test/feedback-logs.test.ts`：10 个用例全过，涵盖契约兼容、日志入库、数量/体积限制、格式校验、事务回滚、管理员下载/预览、Unicode 截断算法、防注入边界与 Kaneo 归档。
  - `test/archive-consistency.test.ts` / `test/fault-injection.test.ts` / `test/pipeline.test.ts`：状态机与恢复逻辑全绿。
- **`@feedback/updater`**：8 个测试文件，**70 passed**
  - `test/envfile-dbprobe.test.ts`：数据库探针、`feedback_logs` 表核验与旧版迁移兼容全过。
  - `test/engine.test.ts` / `test/manifest.test.ts`：更新引擎与清单解析全过。
- **`@feedback/web`**：14 个测试文件，**151 passed**
  - `test/feedback-logs.test.ts`：6 个用例全过，覆盖自动采集、3秒超时保护、手动选择、文本预览、快照冻结与重试幂等。
- **Flutter SDK (`flutter/feedback`)**：
  - `flutter analyze`：**No issues found!**（零告警，耗时 2.3s）。
  - `flutter test`：**119 passed**（包含 `feedback_logs_test.dart` 的 6 组日志生命周期与重试幂等用例）。

总计：**557 个单测/集成测试用例全数通过**，无任何破坏性改动。

---

## 2026-09-15 最后两项补修追加收口

本追加记录不改写历史结果。U1 更新探针现在从 SQLite BLOB 实际计算附件 SHA-256 与字节长度，严格拒绝损坏元数据、缺失或重复附件及不可靠更新前基线；L1 Web 组件在卸载、关闭和身份切换时统一失效日志操作，迟到结果和旧 `finally` 不得写入新草稿或忙碌态，重挂载会按面板状态重试被取消的采集。

本轮 `pnpm -r build`、`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test` 全部通过；单测结果为 server 218、updater 75、web 153，`npx tsx e2e/u1_engine_boundaries.mts` 为 33/33。当前构建产物的真实 Chromium 隔离验证覆盖卸载/重挂载 2/2，并核对实际 multipart 日志附件元数据与字节。

Docker daemon 恢复后已运行 `python3 e2e/run_u1_upgrade.py`：exit 0，**137/137** 项断言通过，`happy_path`、`verify_failure`、`release_failure`、`fast_rejects`、`env_modified`、`updater_restart` 六个场景全部通过。报告为 [`e2e/shots/u1/upgrade-report.json`](../e2e/shots/u1/upgrade-report.json)，使用隔离本地 registry、临时数据卷与 mock AI/Kaneo；未连接真实 Kaneo、生产数据或执行部署、提交、推送、打标签。历史的 Docker 不可用记录保留在上文，本轮收尾状态更新为**待体验**，交付结论为**具备进入测试部署的条件**。
