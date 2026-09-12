#!/usr/bin/env bash
# 真实服务入口：前台运行，不启动 mock，也不改写连接配置。
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE_ROOT="$PWD"
SERVICE_ENV_FILE="${FEEDBACK_ENV_FILE:-$SERVICE_ROOT/.env}"
if [ ! -f "$SERVICE_ENV_FILE" ]; then
  echo "缺少环境文件：$SERVICE_ENV_FILE（参考 .env.example）" >&2
  exit 1
fi
set -a
source "$SERVICE_ENV_FILE"
set +a
: "${FEEDBACK_DATA_DIR:?请在环境文件中明确设置 FEEDBACK_DATA_DIR（真实数据目录，勿复用 mock 数据）}"
if [[ "$FEEDBACK_DATA_DIR" != /* ]]; then
  export FEEDBACK_DATA_DIR="$SERVICE_ROOT/$FEEDBACK_DATA_DIR"
fi
export FEEDBACK_ADMIN_DIST="${FEEDBACK_ADMIN_DIST:-$SERVICE_ROOT/apps/admin/dist}"
if [ ! -f apps/server/dist/index.js ] || [ ! -f "$FEEDBACK_ADMIN_DIST/index.html" ]; then
  echo "缺少构建产物，请先运行 corepack pnpm build" >&2
  exit 1
fi
echo "启动真实服务（不配置 AI/Kaneo、不启动 mock）；Ctrl-C 优雅停机。"
exec node apps/server/dist/index.js
