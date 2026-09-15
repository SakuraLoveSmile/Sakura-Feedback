# syntax=docker/dockerfile:1

# 独立 updater 镜像：只装执行器自己与 docker CLI（通过挂载的 /var/run/docker.sock 操作宿主），
# 不包含 apps/server 的任何构建产物。
#
# 构建（上下文必须是仓库根）：
#   docker build -f apps/updater/Dockerfile -t ghcr.io/sakuralovesmile/sakura-feedback-updater:0.1.0 .

# ---------- 构建阶段 ----------
FROM node:26-alpine AS build
WORKDIR /repo
# node:26 镜像不再内置 corepack，直接安装 pnpm（与本地 packageManager 版本一致）
RUN npm install -g pnpm@11.23.0

# 先拷包清单以利用层缓存（workspace 的 lock 解析需要全部 package.json；只拷清单不拷源码）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/updater/package.json apps/updater/
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY packages/web/package.json packages/web/
COPY examples/react/package.json examples/react/
COPY examples/vue/package.json examples/vue/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/updater apps/updater
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @feedback/updater build \
 && pnpm deploy --filter=@feedback/updater --legacy --prod /updater-out

# ---------- 运行阶段 ----------
FROM node:26-alpine
ENV NODE_ENV=production
# docker CLI + compose 插件：执行器所有 docker 调用都通过参数数组调用它，操作挂载进来的 socket。
# 版本与部署机一致（alpine 3.24 提供 docker-cli 29.x / docker-cli-compose v5.x）。
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
# 只拷运行期需要的内容：编译产物 + 生产依赖（本包无运行期依赖）。
# 刻意不拷 src/test/tsconfig，确保镜像里没有任何开发文件与其它 workspace 的产物。
COPY --from=build /updater-out/dist /app/updater/dist
COPY --from=build /updater-out/package.json /app/updater/package.json
COPY --from=build /updater-out/node_modules /app/updater/node_modules

# 冻结契约的默认值：部署目录在容器内外保持同一绝对路径；不发布任何端口，只在容器网络内监听 8790。
# UPDATER_IMAGE_NAME 必须由部署 compose 注入（缺失即拒绝启动）。
ENV UPDATER_LISTEN=0.0.0.0:8790 \
    UPDATER_COMPOSE_FILE=/opt/1panel/docker/compose/feedback/compose.yml \
    UPDATER_COMPOSE_PROJECT=feedback \
    UPDATER_SERVICE=feedback \
    UPDATER_DEPLOY_DIR=/opt/1panel/docker/compose/feedback \
    UPDATER_CONTROL_DIR=/opt/1panel/docker/compose/feedback/update-control \
    UPDATER_STATE_DIR=/opt/1panel/docker/compose/feedback/update-control/state \
    UPDATER_TOKEN_FILE=/opt/1panel/docker/compose/feedback/update-control/updater-token \
    UPDATER_PROTOCOL_VERSION=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/updater/dist/index.js"]
