# Release 改为只能手动触发（20261029-chore-release-manual-dispatch）

- 项目标识：`personal-feedback`
- 任务编号：`20261029-chore-release-manual-dispatch`
- 分支：`chore/20261029-release-manual-dispatch`（基线 `origin/main` = `b4dba97`）
- 合入目标：`main`
- 状态：待体验

## 1. 目标与范围

把发布流水线从「推 `v*` 标签即自动发布」改成**只能手动触发**，同时**保留完整的正式发布能力**
（镜像 + `release-manifest.json` + draft→公开 Release）。目的是让「打标签」和「对外发布」变成
两个独立决定，而不是推标签的副作用。

范围只有四个文件：`.github/workflows/release.yml`、`docs/release.md`、`docs/integration.md`、
`e2e/check-release-workflow.py`。不动 `ci.yml`、不动服务端更新检查逻辑、不动 `CHANGELOG.md`。

## 2. 已确认的决定

- 保留正式发布能力，改由手动触发（用户 2026-10-29 选定）。被否的方案是「只留构建推镜像、
  不再发布 Release」——那会让 `release-manifest.json` 再也产不出来，管理端「检查更新」
  （`apps/server/src/routes/system-update.ts` 的 `parseManifest`）没有清单可读，等于静默
  停掉一个已发布的产品功能。
- 不采用「在 GitHub 上禁用 Release workflow」：`disabled_manually` 状态下连
  `workflow_dispatch` 也点不动，与「改为手动触发」矛盾。

## 3. 实现

### 3.1 触发器

```yaml
on:
  workflow_dispatch:
    inputs:
      version_tag: { required: false, default: "" }
```

删掉 `push: tags: ["v*"]`。

### 3.2 稳定渠道判定（`plan` job）

判定的信息来源从「事件类型 + `github.ref_name`」换成「`inputs.version_tag` 输入」，
四个校验一个没少，且全部保持 fail-closed：

| 旧 | 新 |
|---|---|
| `EVENT_NAME=push` 且 `REF_TYPE=tag` | `INPUT_TAG` 非空 |
| `TAG_NAME` 匹配 `^v\d+\.\d+\.\d+$` | 同（对 `INPUT_TAG`） |
| `TAG_NAME` == `v<package.json version>` | 同 |
| `refs/tags/$TAG_NAME^{commit}` == `github.sha` | 同；错误信息补了「标签必须已推送到远端」 |

外部值仍然一律经 `env:` 传入、不插值进 shell 文本；标签名仍然先过白名单正则再使用。

### 3.3 镜像标签（`publish` job）

`type=ref,event=tag` 已经永远不可能命中（没有 tag 事件了），删除。版本标签改由
`type=raw,value=${{ inputs.version_tag }}` 提供——这一条本来就在，行为不变。

`latest` 需要特别处理：它原先是 `docker/metadata-action` 在 tag 事件下由
`flavor latest=auto` 隐式附加的，删掉 tag 触发后会一起消失。现在改成显式
`type=raw,value=latest,enable=${{ needs.plan.outputs.stable == 'true' }}`——
不仅恢复了 `latest`，而且比原来更严：预发布标签不会再把 `latest` 指到非正式镜像上。

## 4. 验证

环境：本机 macOS arm64。`python3` 没有 `pyyaml`，用 `uv run --with pyyaml python` 执行
（未改动系统解释器）。

| 项 | 命令 | 结果 |
|---|---|---|
| 发布流水线静态校验 | `uv run --with pyyaml python e2e/check-release-workflow.py` | **51/51 断言通过，exit 0**（改动前是 48 项，新增 3 项） |
| 反向验证新断言有效 | 把 `push: tags: ["v*"]` 加回 release.yml 再跑 | 触发器断言 **FAIL**（`triggers=['push', 'workflow_dispatch']`），50/51；还原后回到 51/51 |
| 残留引用 | 全仓库 grep `EVENT_NAME` / `REF_TYPE` / `TAG_NAME` / `github.ref_type` / `github.ref_name` | 无残留（`VERIFICATION.md` 里的历史记录除外） |

harness 新增的 3 项断言：

1. `on:` 只有 `workflow_dispatch`，没有任何自动触发；
2. `version_tag` 输入存在、非必填、默认空串；
3. `publish` 的镜像标签里没有 `type=ref,event=tag`，且 `latest` 由 `needs.plan.outputs.stable` 控制。

同时把原有的 plan 判定场景全部迁到新契约，并把「手动触发 → manual」这条改写成
「`version_tag` 留空 → manual/stable=false/tag 为空」，断言强度没有下降（多断言了 `tag` 输出）。

### 未验证项（必须按此口径读结论）

- **没有真实跑过一次 GitHub Actions 发布**。本轮全部是 YAML 级 + 从工作流里抽出真实 shell
  在沙箱执行的脚本级验证，不覆盖 Actions 运行时语义：job 依赖与 `if` 求值、artifact 跨 job
  下载、`gh release` 网络调用、镜像真实推送与 digest、`metadata-action` 实际生成的标签集合。
  `latest` 由显式 `type=raw` 附加这一点，只在 YAML 层面断言过，没有看到真实的 tag 列表。
- `e2e/check-release-workflow.py` **不在 CI 里跑**（`ci.yml` 只跑 `check-release-notes.py`），
  所以这 51 项断言目前只有人工执行时才生效。把它接进 CI 是独立的一片，本次没做。

## 5. 遗留

- `docs/closeout.md` 第 51–65 行也复述了稳定渠道的 4 个条件，其中①仍写着「事件是标签推送」。
  该文件自带「记录时间：2026-09-11」且内容仍停留在双镜像（updater 已于 v0.5.1 移除）的年代，
  属于历史记录，本次**没有改**，只依赖它已有的那句「稳定渠道判定以 docs/release.md 为权威口径」。
  要么整篇标记为历史快照，要么整篇刷新——都应是独立任务，不在本片范围内。
- `CHANGELOG.md` 按发布标签归档、没有 Unreleased 段，本次没加条目。发布方式属于
  「部署与分发方式」，下次发版时应在对应版本段里记一句「发布改为手动触发」。
