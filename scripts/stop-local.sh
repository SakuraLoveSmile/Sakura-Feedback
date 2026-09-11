#!/usr/bin/env bash
# 停止 scripts/start-local.sh 启动的全部进程
set -uo pipefail
for name in server react vue mock; do
  pidfile="/tmp/fb-local-$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    # tsx watch 会派生子进程，按进程组终止
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "[stop] $name (pid $pid)"
  fi
done
pkill -f "e2e/mock-external.mjs" 2>/dev/null || true
# tsx watch 的真实监听进程是包装器的子进程，按命令行签名兜底清理
pkill -f "tsx.*src/index.ts" 2>/dev/null || true
pkill -f "http.server 5187" 2>/dev/null || true
pkill -f "http.server 5188" 2>/dev/null || true
echo "[stop] 完成"
