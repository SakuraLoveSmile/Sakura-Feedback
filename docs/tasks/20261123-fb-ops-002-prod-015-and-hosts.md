# FB-OPS-002：生产升级 v0.15.0 与 Web 宿主升级

- 任务编号：FB-OPS-002；项目：personal-feedback
- 日期：2026-11-23；执行者：lead
- 状态：实现中（feedback 生产已升级并核验；Blog 代码已换到 0.15.0 并本地验证，未走发布；其余宿主未动）

## 1. 生产升级（blog-prod → v0.15.0）

- 目标：`/opt/1panel/docker/compose/feedback`（compose 项目 feedback，容器 feedback-feedback-1），从 v0.13.0
  （digest `692e14a9…`）升级到 **v0.15.0**（digest `c8e630f4…`，与 release-manifest 一致）。
- 预拉与核对：`docker pull …@sha256:c8e630f4…`，本地镜像 ID 与 digest 一致；标签
  `org.opencontainers.image.version=v0.15.0`、`revision=fad2562a…`；容器内 `/app/server/package.json` 为 0.15.0。
- 备份：`backups/fb-rel-015-pre-v0.15.0-20261123-175253/`（700），含 `docker-compose.yml.pre`、`.env`、
  停机整目录 `feedback-data-stopped-v0.15.0.tgz`（4.8M）、停机 data 目录清单与 `SHA256SUMS`（三份校验 OK）。
- 切换：停机 → 备份 → 改 compose 镜像为 `:v0.15.0@sha256:c8e630f4…` → `docker compose up -d`；约 10 秒 healthy，
  RestartCount 0。脚本内置「健康检查失败自动回退旧 compose」，本次未触发。
- 数据：升级前后 schema 15、integrity ok、20 张表 **1802 行**，逐表行数完全一致（feedbacks 32、sessions 1524、
  feedback_audit 108 等）。本轮无数据库迁移。
- 公网核验（`https://feedback.xn--fhqths51enha.cn`）：`/healthz`、`/api/features`、`/api/changelog/studytool`、
  `/admin/` 均 200，未登录 `/api/admin/apps` 401；管理页 `index.html` 与 4 个资产（1 html + 3 JS/CSS）与 Release 的
  `feedback-admin-dist.zip` 逐字节一致。
- 回退：compose 镜像改回 `:v0.13.0@sha256:692e14a9…` 后 `up -d`（schema 同为 15，无需恢复数据）。

## 2. Web 宿主现状

| 宿主 | 当前接入 | 位置 | 本轮状态 |
| --- | --- | --- | --- |
| Blog | vendored `feedback-web.js`（0.5.x 时代）+ 同名 `html2canvas-pro.esm-CQ8baKsv.js` | `modules/stellar/web/assets/vendor/feedback/`（`go:embed` 进二进制） | **已换到 0.15.0**：入口 455574 B（sha256 `5ce1f966…`），懒加载分块内容哈希未变、无需替换；`go build ./cmd/blog` 与 `go test ./modules/stellar/...` 通过。**未发布、未部署**（Blog 的发布需 dev→main→release PR + tag + CI 镜像 + compose 切换，属其仓库授权范围）。 |
| Library | `@feedback/web` `file:vendor/feedback-web-0.5.2.tgz` | `frontend/`（Vue） | 未动；0.5.2 → 0.15.0 跨 10 个 minor，需按 CHANGELOG 逐项核对入口默认值、关闭语义与宿主设置 |
| TransHub | `@feedback/web` `file:vendor/feedback-web-0.5.2.tgz` | `local-trans-api-demo/frontend/`（Vue） | 未动；同上 |
| StudyTool | `@feedback/web` `file:vendor/feedback-web-0.4.1-studytool.1.tgz`（**自带补丁的 fork 构建**） | `frontend/` + `e2e/` | 未动；换到 0.15.0 前要先决定是否放弃该 fork 补丁（需核对 `.feedback-work` 里的改动是否已上游） |

## 3. 未验证 / 遗留

- Blog 未在浏览器里验收（组件换成 0.15.0 后需确认浅色/深色、入口、截图、关闭确认与懒加载分块都正常）；未走发布与部署。
- Library / TransHub / StudyTool 未升级：均为 2026-09/10 后未再动的项目，升级属各自仓库的一轮迁移，需按宿主分别验证。
- 生产 `data/update-check.json` 仍是旧检查结果，24 小时自动检查或后台「检查更新」后显示 0.15.0。
