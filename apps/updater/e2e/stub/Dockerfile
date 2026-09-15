# 本地端到端验证用的「feedback 服务替身」镜像。
#
# 它只做三件事，用来让真实的六阶段更新流程可以完整跑通：
#   1. 暴露 /healthz（容器健康检查与放行应答）
#   2. 在 FEEDBACK_DATA_DIR 建出与 apps/server 同样的表结构与 user_version=3，并写入一批固定数据
#   3. 收到 SIGTERM 时优雅退出（退出码 0），满足执行器「退出码 0/143」的停服预算
#
# 注意：这是测试替身，不是生产镜像；apps/server 的真实镜像由仓库根 Dockerfile 构建。
FROM node:26-alpine

ARG VERSION=0.0.0
ARG COMMIT=unknown
LABEL org.opencontainers.image.title="feedback-stub" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"

ENV APP_VERSION=${VERSION} \
    FEEDBACK_DATA_DIR=/data \
    FEEDBACK_PORT=8787 \
    FEEDBACK_UPDATE_CONTROL_DIR=/update-control

WORKDIR /app
COPY server.mjs /app/server.mjs
EXPOSE 8787

CMD ["node", "/app/server.mjs"]
