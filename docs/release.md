# 发布流水线（Release）

一个 `v*` 标签推上去之后发生什么、`release-manifest.json` 里必须有什么、以及为什么 GitHub Release
在全部产物齐全之前一直是 draft。实现见 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

> **验证状态（重要）**：本文档描述的行为**尚未在真实 GitHub Actions 上运行过**。
> 本机没有 GitHub 运行环境，本轮只做了 YAML 解析、`bash -n` 语法检查、以及把工作流里将要执行的脚本
> 抽出来在沙箱里跑（含失败路径）的静态/脚本级验证——见第 6 节。job 依赖、artifact 跨 job 下载、
> `gh release` 网络调用等 Actions 运行时语义**未经验证**。第一次真机发布前请按第 5 节逐步核对。

## 1. 触发方式与渠道

| 事件 | 推镜像 | 产出稳定清单 | Release |
|---|---|---|---|
| 推送**正式**版本标签 `vX.Y.Z`（与根 `package.json` 的 version 完全一致） | 是 | 是 | 创建 draft → 齐全后公开 |
| 推送**预发布**标签（如 `v0.3.0-rc.1`） | 是 | 否 | 不创建、不公开 |
| 推送正式标签但标签与源码版本不一致（如 `v0.2.0` 而源码是 `0.3.0`） | **否**（推任何镜像之前就失败） | 否 | 不创建 |
| 推送标签但标签名不符合 `v*` 约定（如 `release-0.3.0`） | 否 | 否 | 不创建 |
| 手动触发 `workflow_dispatch` | 是（`sha-<提交>` 标签） | 否 | 不创建、不公开 |
| PR / 分支推送 | 否 | 否 | 不创建（只有 `ci.yml` 检查） |

**稳定渠道判定**（四个条件同时成立，缺一即不是稳定发布）：

1. 事件是标签推送（`push` + `ref_type=tag`）；
2. 标签名匹配正式版本 `^v\d+\.\d+\.\d+$`（无 `-rc`／`+build` 之类后缀）；
3. 标签严格等于 `v<根 package.json 的 version>`；
4. 标签指向本次运行的提交：`git rev-parse refs/tags/<标签>^{commit}` == `github.sha`。

判定由 `plan` job 在任何构建之前完成。条件 3、4 不满足时**直接失败退出**——因为发布错的清单比不发布更糟：
镜像一旦用错误的版本标签推上去就无法收回。条件 1、2 不满足（手动触发 / 预发布标签）不报错，只是不进入
稳定渠道：仍可构建推镜像用于验证，但**不会**创建 Release、不会产出 `release-manifest.json`。
`checks`（复用 `ci.yml`）不通过时同样不会构建、不会推送。

## 2. job 结构与权限

| job | needs | 权限 | 作用 |
|---|---|---|---|
| `checks` | — | 复用 `ci.yml`（`contents: read`） | secrets-guard、node-checks、flutter-checks 门禁 |
| `plan` | `checks` | `contents: read` | 读两个 `package.json` 的 version，判定渠道（表见第 1 节） |
| `artifacts` | `plan` | `contents: read` | Web `.tgz`、两份 dist `.zip`、`SHA256SUMS`、`SOURCE.txt` |
| `publish` | `plan`, `artifacts` | `contents: read` + **`packages: write`** | 构建并推送 feedback 与 updater 两个镜像，记录并校验 digest |
| `manifest` | `plan`, `artifacts`, `publish` | `contents: read` | 生成 `release-manifest.json`，再用执行器解析器验收 |
| `release` | `plan`, `artifacts`, `publish`, `manifest` | **`contents: write`** | 创建 draft、上传全部资产、复查齐全、最后一步公开 |

权限约束：顶层只有 `contents: read`；`packages: write` 只属于 `publish`；`contents: write` 只属于 `release`，
且 `artifacts` / `manifest` job 完全不接触 GitHub Release——**唯一能写 Release 的 job 就是最后公开它的 job**。

外部值（`github.ref_name`、`github.sha`、标签名等）一律经 `env:` 传入，**不插值进 `run:` 的 shell 文本**；
镜像标签继续由 `docker/metadata-action` 生成。

## 3. `release-manifest.json` 契约

冻结版本 `manifestVersion = 1`，由 `manifest` job 生成，字段与
[`apps/updater/src/manifest.ts`](../apps/updater/src/manifest.ts) 的 `parseManifest` 一一对应：

| 字段 | 类型 | 说明 |
|---|---|---|
| `manifestVersion` | number | 固定 `1`；执行器只接受这一版 |
| `version` | string | 正式语义版本（如 `0.3.0`），等于根 `package.json` 的 version（去 `v` 前缀） |
| `commit` | string | 本次运行的提交 SHA（`github.sha`） |
| `tag` | string | 版本标签（如 `v0.3.0`） |
| `channel` | string | 稳定清单恒为 `"stable"`；非 stable 时根本不产出清单 |
| `services.feedback.image` / `.digest` | string | `ghcr.io/sakuralovesmile/sakura-feedback` + `sha256:<64 位小写十六进制>` |
| `services.updater.image` / `.digest` | string | `ghcr.io/sakuralovesmile/sakura-feedback-updater` + digest（必填，不接受 `null`） |
| `platform` | string | 固定 `linux/amd64` |
| `dbSchemaVersion` | number | 服务端 `PRAGMA user_version` 的当前值（现为 `5`），见下 |
| `requiredUpdaterProtocol` | number | 更新执行器协议版本，现为 `1` |
| `publishedAt` | string | 生成清单的时刻（UTC，`YYYY-MM-DDTHH:MM:SSZ`） |

示例：

```json
{
  "manifestVersion": 1,
  "version": "0.3.0",
  "commit": "0f4c9b2e1d7a8c3f5e6b0a1d2c3e4f5a6b7c8d9e",
  "tag": "v0.3.0",
  "channel": "stable",
  "services": {
    "feedback": {
      "image": "ghcr.io/sakuralovesmile/sakura-feedback",
      "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    },
    "updater": {
      "image": "ghcr.io/sakuralovesmile/sakura-feedback-updater",
      "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    }
  },
  "platform": "linux/amd64",
  "dbSchemaVersion": 5,
  "requiredUpdaterProtocol": 1,
  "publishedAt": "2026-09-14T05:55:17Z"
}
```

要点：

- **`dbSchemaVersion` 读自源码**：生成脚本解析 `apps/server/src/db/db.ts` 里所有 `PRAGMA user_version = N`，
  取最大值（现为 `5`）。不是硬编码，也不是猜的；读不到就失败退出。
- **两个镜像 digest 都必须存在且非空**：`publish` job 任一 digest 为空或格式非法就失败退出，
  后续 `manifest` job 根本不会运行；`manifest` job 还会把 digest 与记录文件、job output 交叉核对。
- **清单必须被执行器接受**：生成后立刻用 `apps/updater` 的**真实解析器**（`parseManifest`）验收，
  并要求 `services.updater` 与 `dbSchemaVersion` 非空。零依赖实现：Node 22 的类型剥离直接跑 TS，不需要 `pnpm install`。
- **消费地址**：执行器按 `UPDATER_IMAGE_NAME` 推导
  `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json`，
  再用 `requiredUpdaterProtocol` 判断自己的协议版本够不够（不够则拒绝更新并提示先手工升级 updater）。
  因此清单必须挂在**已公开**（非 draft、非 prerelease）的 Release 上，且资产名必须正好是 `release-manifest.json`。
- 两个 digest 同时作为 Release 资产存在：`feedback-image-digest.txt`、`updater-image-digest.txt`
  （文件内含 `image:` / `digest:` / `tags:`，供人工核对；`image-digest.txt` 这个旧名字已由前者取代）。

## 4. draft → 公开的顺序与不变量

`release` job 内的顺序是固定的，全部产物齐全前 Release 一直是 draft：

1. 下载四份 artifact：Web 产物（`feedback-web-<sha>`）、两份 digest、稳定清单；
2. 校验本地产物齐全且互相一致：`sha256sum -c SHA256SUMS`、清单里的两个 digest 必须与 digest 文件相同、
   清单的 `version` / `tag` / `commit` 必须等于本次运行的值、至少 1 个 `.tgz` + 2 个 `.zip` + `SHA256SUMS` + `SOURCE.txt`；
3. 若 Release 不存在 → `gh release create --draft`；若已存在**且已公开** → 直接失败退出（不修改已公开版本）；
4. `gh release upload` 上传全部资产：`*.tgz`、`*.zip`、`SHA256SUMS`、`SOURCE.txt`、
   两份 digest、`release-manifest.json`；
5. **复查远端**：`gh release view --json assets` 的资产名必须覆盖第 4 步全部文件（缺一即失败退出）；
6. 最后一步才 `gh release edit --draft=false --latest`。

不变量：

- **不会出现「已公开但产物缺失」**：公开是最后一步，且在第 5 步复查之后；第 1–5 步任一失败都停在 draft。
  第 6 步自身失败同样只留下 draft（此时 Release 完整但未公开，人工重跑或手工公开即可）。
- **已公开的 Release 不会被流水线改写**：重跑同一标签时第 3 步会失败退出，不会重新上传或改动已公开资产。
- **稳定清单只会出现在正式版本上**：`manifest` 与 `release` job 都带
  `if: needs.plan.outputs.stable == 'true'`，手动触发与预发布标签不会走到这里。
- 同一 ref 的发布串行化（`concurrency: release-${{ github.ref }}`，`cancel-in-progress: false`），
  避免两次运行同时改同一个 draft。

## 5. 人工发布步骤

前置：`main` 上 CI 绿、版本号已收口（根 `package.json` 与 `apps/server`、`apps/admin`、`packages/web`
统一为要发布的版本；`apps/updater` 保持自己的 `0.1.0` 不动）。

```bash
# 1) 确认版本号（必须等于要去掉的 v 之后的标签名）
python3 -c "import json;print(json.load(open('package.json'))['version'])"   # → 0.3.0

# 2) 打标签并推送（由人工执行；本仓库工作流不会自动打标签）
git tag v0.3.0
git push origin v0.3.0

# 3) 观察运行
gh run watch

# 4) 核对 Release（公开前是 draft；公开后 isDraft=false、isLatest=true）
gh release view v0.3.0 --json isDraft,isLatest,url,assets

# 5) 取清单核对字段与 digest
gh release download v0.3.0 -p release-manifest.json -O -
```

预期 job 顺序：`checks` → `plan` → `artifacts` → `publish` → `manifest` → `release`。
（`manifest`、`release` 只在稳定渠道出现；`artifacts` 与 `publish` 会并行推进。）

失败处理：

- 停在 `plan`：标签与源码版本/提交不匹配，或标签名不合法。修正后重新打标签（**不要**用同一个标签强推覆盖：
  删掉旧标签再推）。
- 停在 `artifacts` / `publish` / `manifest`：Release 还没被创建或仍是 draft，修好后重跑该 run 即可。
- 停在 `release` 的第 5 步之前：Release 是 draft 且可能只有部分资产，重跑会重新上传并覆盖（`--clobber`）。
- `release` 的第 6 步失败：Release 完整但未公开；重跑该 run（第 3 步会因「已存在」而跳过创建），
  或人工 `gh release edit v0.3.0 --draft=false --latest`。
- 已经公开的版本要「重发」：流水线拒绝改动已公开 Release。请人工删除该 Release（或换新版本号）后重跑。

部署侧（生产）：compose 按 digest 固定镜像，**不使用可变标签**；updater 容器按第 3 节的地址自行拉取清单，
人工步骤与前置条件见 `docs/deployment.md` 与 `apps/updater/README.md`（由 U1-2 / U1-4 收口）。

## 6. 本机静态验证（本轮做了什么、没做什么）

本轮**没有**运行 GitHub Actions（本机没有该环境，也没有权限触发）。实际做过的检查：

| 检查 | 结果 |
|---|---|
| 契约命令：`yaml.safe_load` 解析 `release.yml` / `ci.yml`、`grep release-manifest.json`、`grep sakura-feedback-updater` | 4/4 通过 |
| 每个 `run:` 块 `bash -n` 语法检查 | 全部通过 |
| `run:` 块内不出现 `${{ }}` 插值（外部值只经 `env:`） | 通过 |
| 权限：顶层只读、`packages: write` 只在 `publish`、`contents: write` 只在 `release` | 通过 |
| `ci.yml` 保留 `workflow_call`、secrets-guard、node-checks、flutter-checks，并新增三档安全存储矩阵 | 结构通过；旧 harness 的“ci.yml 未被修改”历史断言会单独报 1 项 |
| `plan` 判定表：正式标签+版本+提交一致 → `stable=true`（用仓库里真实的 `v0.1.0` 标签只读校验 git 路径）；提交不一致 / 版本不一致 / 标签名非法 / 标签无法解析 → 失败退出；预发布 → `prerelease`；手动触发 → `manual` | 8 个场景全部符合预期 |
| digest 步骤：正常写出两份 digest；任一为空 / 格式非法 → 失败退出 | 4 个场景符合预期 |
| 清单生成器：正例产出符合契约的清单，并被 `apps/updater` 的**真实解析器** `parseManifest` 接受；渠道非 stable、标签与版本不一致、digest 文件缺失、digest 与 job output 不一致、digest 格式非法、协议版本缺失、`db.ts` 读不到 `PRAGMA user_version` → 全部失败且不产出清单 | 12 项符合预期 |
| `release` job 校验脚本：本地产物齐全（含 `sha256sum -c`）通过；清单 digest 不一致 / 缺 `.zip` / 产物被篡改 → 失败 | 4 项符合预期 |
| 远端资产复查脚本：齐全（8 项）通过；缺清单 / 资产列表为空 → 失败 | 3 项符合预期 |

当前 harness 共 47 项断言，其中 46 项通过；唯一失败是旧的“ci.yml 未被修改”断言，而本次 `ci.yml` 新增的 Flutter 存储矩阵是有意的发布门禁变更。其余 YAML、权限、版本、digest、清单、篡改检测和 fail-closed 路径均通过。
被验证的 `release.yml` sha256：`afede6cc252b78f1be7bf0cc2764a34727cf30eeab2e19060693148ed6caaf91`。

**未验证**（真机发布前必须人工确认）：job 依赖与 `if` 求值、`actions/upload-artifact` /
`download-artifact` 的跨 job 取件、`gh release create/upload/edit` 的真实网络行为、`docker/build-push-action`
两个镜像的真实推送与 digest、`metadata-action` 生成的标签集合、以及 `manifest` job 里
`actions/download-artifact` 是否需要额外 `actions: read` 权限（`upload` 在 v0.1.0 的真实运行中不需要，
下载未在本仓库跑过）。

## 7. 已知边界

- **本机无法运行 Actions**：上表所有结论都是静态/脚本级，不等价于真机验证；第一次发布请按第 5 节逐步核对。
- **预发布/手动触发不再创建 Release**（相对 v0.1.0 时期「任何标签都挂 Release」的行为是收紧）：
  原因是执行器按 `releases/latest/download/` 取清单，任何非稳定内容都不应出现在 Releases 里。
  如果确实要把预发布挂出来，请人工用 `gh release create --prerelease` 处理（流水线不会代替你判断）。
- **updater 镜像的标签语义**：`0.1.0` 来自 `apps/updater/package.json`（与反馈服务版本解耦），
  `v0.3.0` 表示「随 v0.3.0 一起构建的这个 updater 镜像」，另有 `sha-<提交>`；部署一律按 digest 固定，标签仅供人读。
- 两个镜像的 `provenance` 与 `sbom` 仍开启；`latest` 标签由 `metadata-action` 自动附加，**不要**在部署里用它。
- `docs/closeout.md` 里「release.yml 只推一个镜像、标签推送即挂 Release」的描述是 v0.1.0 时期的历史记录，
  与本文档不一致；该文件不在本任务改动范围内，需要在 U1 收口时一并更新。
