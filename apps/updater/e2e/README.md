# apps/updater 真实 Docker 端到端

`run-local-update.sh` 用**本机真实 Docker**（真实 socket、真实 compose 项目、真实数据卷）把执行器的六阶段
跑完一遍，用来验证「单元测试里的假 docker」没有掩盖真实行为差异。

```bash
bash apps/updater/e2e/run-local-update.sh
```

## 它做了什么

1. 只使用独立资源：项目名 `feedback-e2e-*`、网络 `feedback-e2e-net-*`、旧卷 `feedback-e2e-old-*`、
   本地 registry 端口 `127.0.0.1:<随机>`、容器名 `feedback-e2e-*`；退出时清理自己创建的一切。
2. 起一个本地 registry，构建并推送两版「feedback 服务替身」（`stub/`，真实 `node:sqlite` 数据库 +
   真实健康检查 + SIGTERM 优雅退出），拿到两个真实 `sha256` digest。
3. 造出旧部署：外部数据卷（含 2 账号 / 5 反馈 / 3 截图 / 7 条额度记录，`user_version=3`）、
   `compose.yml`（`image: ${FEEDBACK_IMAGE}`、`feedback-data` 外部卷 `name: ${FEEDBACK_DATA_VOLUME}`）、
   `.env.prod`、`release-manifest.json`，再用 `docker compose` 起旧版服务。
4. 起执行器容器：挂 `/var/run/docker.sock` 与同路径部署目录，**不发布端口**，令牌来自 600 文件。
5. 走真实 HTTP 协议：无令牌/错令牌 401、提交 compose 路径被 400 拒绝、协议不兼容 409（且服务未被动过）、
   digest 与清单不一致 → `failed_no_changes`（旧服务继续运行、无暂停标记、无新卷、无放行标记）、
   正常更新 → 202 + 同 requestId 幂等。
6. 断言更新结果：任务 `succeeded`、六阶段证据齐全、运行中镜像 digest 与清单一致、
   服务已挂到新数据卷、数据行数全部保留、旧卷与旧镜像仍在、`paused` 已解除、`release` 已落盘、
   备份副本 600、环境文件其它字段未变、执行器日志不含令牌。

## 注意

- `/private/tmp`（macOS 上 Docker Desktop 的共享目录）用来放部署目录，保证宿主 daemon 能看到同一路径；
  容器内外路径完全一致。
- 被更新的镜像来自本地 registry（`127.0.0.1:<随机端口>`），因此 digest 是真实的、
  与生产「从 ghcr.io 拉取固定 digest」的流程一致。
- 该脚本不会触碰任何既有镜像/卷/容器，也不会创建 `/opt/1panel/...`。

## 最近一次运行（本仓库，本机 Docker 29.5.3 / compose v5.1.4）

完整断言清单见同目录 `last-run-summary.txt`：

```
=== 结果：56 项断言，0 项失败
真实更新流程验证通过（项目 feedback-e2e-4ead，operationId op-20260914T053814Z-ec44e2d7）
```

关键断言（节选）：

```
✓ 运行中的镜像 digest = 清单新版 digest（sha256:a6c8e2…0b4）
✓ 运行中的服务挂载新数据卷（feedback-data-0.3.0-20260914T053815Z）
✓ 新版 users 保留（2）/ feedbacks（5）/ feedback_screenshots（3）/ daily_usage（7）/ schema（3）
✓ 旧数据卷仍在（未删除）、旧镜像仍在（未删除）、旧卷数据仍可读且完整
✓ paused 标记已解除、release 标记已落盘且指向新版本
✓ 协议不兼容时状态码（409）、协议不兼容时不产生任务、服务未被动过
✓ 不一致任务分类（未改动部署）（failed_no_changes）、旧服务仍在运行、没有创建新数据卷
✓ 日志不含令牌
```
