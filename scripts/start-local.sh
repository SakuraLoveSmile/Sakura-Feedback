#!/usr/bin/env bash
# mock 演示一键启动：mock 外部服务 + 反馈服务(dev tsx watch) + React/Vue 示例静态站。
# 使用独立 data/mock-demo；不证明真实 AI / Kaneo 归档。
# 停止：scripts/stop-local.sh。日志：/tmp/fb-local-*.log
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ ! -f .env ]; then
  echo "缺少 .env（参考 .env.example；本地用可 node -e 生成 master key）" >&2
  exit 1
fi
set -a; source .env; set +a
# 不继承真实服务数据；worker 启动即可能处理旧记录。
export FEEDBACK_DATA_DIR="$ROOT/data/mock-demo"
export FEEDBACK_ADMIN_DIST="$ROOT/apps/admin/dist"
# 示例与 seed-local-demo.py 固定使用这些本机入口。
export FEEDBACK_PORT=8787
export FEEDBACK_COOKIE_SECURE=false
export E2E_KANEO_PORT=8898
export E2E_AI_PORT=8899
unset FEEDBACK_PUBLIC_URL E2E_KANEO_PUBLIC_BASE
# 演示过程不投递到真实 Assist Hub。
unset FEEDBACK_ASSIST_HUB_URL FEEDBACK_ASSIST_SOURCE_KEY FEEDBACK_ASSIST_READ_KEY

# 拒绝复用可能来自旧数据目录的已运行进程，也不抢占已有服务端口。
for name in mock server react vue; do
  if [ -f "/tmp/fb-local-$name.pid" ] && kill -0 "$(cat "/tmp/fb-local-$name.pid")" 2>/dev/null; then
    echo "[start] $name 已在跑，拒绝复用；请先核对该进程的数据目录与用途" >&2
    exit 1
  fi
done

# 在启动 worker 之前只读核对演示库，拒绝曾被配置为真实连接的库。
node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const file = path.join(process.env.FEEDBACK_DATA_DIR, 'feedback.db');
if (fs.existsSync(file)) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
      for (const [key, expected] of [['kaneo.baseUrl', 'http://127.0.0.1:8898'], ['ai.baseUrl', 'http://127.0.0.1:8899/v1']]) {
        const value = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
        if (value && value.replace(/\/+$/, '') !== expected) {
          throw new Error('演示库存在非 mock 连接，拒绝启动；请保留该库并核对用途');
        }
      }
    }
  } finally { db.close(); }
}
Promise.all([8787, 8898, 8899, 5187, 5188].map(port => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); reject(new Error(`端口 ${port} 已被占用，拒绝启动；请先核对占用者`)); });
  socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  socket.once('timeout', () => { socket.destroy(); reject(new Error(`端口 ${port} 检查超时`)); });
}))).catch(error => { console.error(error.message); process.exitCode = 1; });
NODE

mkdir -p "$FEEDBACK_DATA_DIR"

launch() { # name, log, cmd...
  local name="$1" log="$2"; shift 2
  if [ -f "/tmp/fb-local-$name.pid" ] && kill -0 "$(cat "/tmp/fb-local-$name.pid")" 2>/dev/null; then
    echo "[start] $name 已在跑 (pid $(cat /tmp/fb-local-$name.pid))"
    return
  fi
  nohup "$@" > "$log" 2>&1 &
  local pid=$!
  echo "$pid" > "/tmp/fb-local-$name.pid"
  { printf '%s\n' "$ROOT"; ps -p "$pid" -o lstart=; } > "/tmp/fb-local-$name.owner"
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
    演示数据    $FEEDBACK_DATA_DIR
    AI/Kaneo 均为本地 mock，Assist 投递已关闭。
    首次使用运行：python3 scripts/seed-local-demo.py
    seed 仅配置连接与示例应用；需要自动归档时，在管理页补齐列、标签并显式启用规则。
INFO
