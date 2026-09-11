#!/usr/bin/env bash
# 本地一键启动：mock 外部服务 + 反馈服务(dev tsx watch) + React/Vue 示例静态站。
# 停止：scripts/stop-local.sh。日志：/tmp/fb-local-*.log
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ ! -f .env ]; then
  echo "缺少 .env（参考 .env.example；本地用可 node -e 生成 master key）" >&2
  exit 1
fi
set -a; source .env; set +a
export FEEDBACK_DATA_DIR="${FEEDBACK_DATA_DIR:-$ROOT/data}"
export FEEDBACK_ADMIN_DIST="${FEEDBACK_ADMIN_DIST:-$ROOT/apps/admin/dist}"
export FEEDBACK_PORT="${FEEDBACK_PORT:-8787}"

mkdir -p "$FEEDBACK_DATA_DIR"

launch() { # name, log, cmd...
  local name="$1" log="$2"; shift 2
  if [ -f "/tmp/fb-local-$name.pid" ] && kill -0 "$(cat "/tmp/fb-local-$name.pid")" 2>/dev/null; then
    echo "[start] $name 已在跑 (pid $(cat /tmp/fb-local-$name.pid))"
    return
  fi
  nohup "$@" > "$log" 2>&1 &
  echo $! > "/tmp/fb-local-$name.pid"
  echo "[start] $name → $log"
}

launch mock /tmp/fb-local-mock.log node "$ROOT/e2e/mock-external.mjs"
( cd "$ROOT/apps/server" && launch server /tmp/fb-local-server.log npx tsx watch src/index.ts )
launch react /tmp/fb-local-react.log python3 -m http.server 5187 --bind 127.0.0.1 --directory "$ROOT/examples/react/dist"
launch vue /tmp/fb-local-vue.log python3 -m http.server 5188 --bind 127.0.0.1 --directory "$ROOT/examples/vue/dist"

echo -n "[wait] 反馈服务 "
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${FEEDBACK_PORT}/healthz" >/dev/null; then echo "OK"; break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:${FEEDBACK_PORT}/healthz" >/dev/null || { echo "服务未起来，查看 /tmp/fb-local-server.log"; exit 1; }

cat <<INFO

  ✔ 全部就绪（开发用值见 .env）
    管理页      http://localhost:${FEEDBACK_PORT}/admin/   （账号 $FEEDBACK_ADMIN_USER / 见 .env）
    登录窗口    http://localhost:${FEEDBACK_PORT}/login
    React 示例  http://localhost:5187/
    Vue 示例    http://localhost:5188/
    Kaneo mock 已收任务   http://127.0.0.1:8898/__mock/tasks
    AI/Kaneo 均为本地 mock（首次使用请运行：python3 scripts/seed-local-demo.py）
INFO
