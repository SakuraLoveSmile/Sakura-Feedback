# syntax=docker/dockerfile:1

# ---------- 构建阶段 ----------
FROM node:26-alpine AS build
WORKDIR /repo
# node:26 镜像不再内置 corepack，直接安装 pnpm（与本地 packageManager 版本一致）
RUN npm install -g pnpm@11.23.0

# 先拷包清单以利用层缓存（workspace 中 lock 解析需要全部 package.json）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY packages/web/package.json packages/web/
COPY examples/react/package.json examples/react/
COPY examples/vue/package.json examples/vue/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY apps/admin apps/admin
COPY packages packages

# admin 依赖 @feedback/web 的构建产物（exports 指向 dist/），必须先构建 web 包
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @feedback/web build \
 && pnpm --filter @feedback/admin build \
 && pnpm --filter @feedback/server build \
 && pnpm deploy --filter=@feedback/server --legacy --prod /server-out

# ---------- 运行阶段 ----------
FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /server-out /app/server
COPY --from=build /repo/apps/admin/dist /app/admin

ENV FEEDBACK_DATA_DIR=/data \
    FEEDBACK_ADMIN_DIST=/app/admin \
    FEEDBACK_PORT=8787
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "/app/server/dist/index.js"]
