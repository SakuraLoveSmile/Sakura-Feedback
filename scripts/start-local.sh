#!/usr/bin/env bash
# mock 演示一键启动：真实服务请用 start-service.sh，本脚本不能证明真实归档。
# 停止：scripts/stop-local.sh。日志：/tmp/fb-local-*.log
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ ! -f .env ]; then
  echo "缺少 .env（参考 .env.example；本地用可 node -e 生成 master key）" >&2
  exit 1
fi
set -a; source .env; set +a
# 不继承真实服务的 FEEDBACK_DATA_DIR；worker 启动即可能处理旧记录。
export FEEDBACK_DATA_DIR="$ROOT/data/mock-demo"
export FEEDBACK_ADMIN_DIST="$ROOT/apps/admin/dist"
# 示例与 seed 约定本机 8787；不继承真实 HTTPS 入口及 Cookie 配置。
export FEEDBACK_PORT=8787
export FEEDBACK_COOKIE_SECURE=false
unset FEEDBACK_PUBLIC_URL

# 在启动 worker 之前检查演示库，防止曾被手动配置成真实连接的库产生外部写入。
node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.FEEDBACK_DATA_DIR, 'feedback.db');
if (fs.existsSync(file)) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
      for (const [key, expected] of [['kaneo.baseUrl', 'http://127.0.0.1:8898'], ['ai.baseUrl', 'http://127.0.0.1:8899/v1']]) {
        const value = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
        if (value && value.replace(/\/+$/, '') !== expected) {
          throw new Error('演示库存在非 mock 连接，拒绝启动；请保留该库并使用真实服务入口');
        }
      }
    }
  } finally { db.close(); }
}
NODE

mkdir -p "$FEEDBACK_DATA_DIR"

if [ ! -f "$ROOT/apps/server/dist/index.js" ] || [ ! -f "$FEEDBACK_ADMIN_DIST/index.html" ]; then
  echo "缺少构建产物，请先运行 corepack pnpm build" >&2
  exit 1
fi

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
launch server /tmp/fb-local-server.log node "$ROOT/apps/server/dist/index.js"
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
