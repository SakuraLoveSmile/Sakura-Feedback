#!/usr/bin/env bash
# 停止 scripts/start-local.sh 启动的全部进程
set -uo pipefail
for name in server react vue mock; do
  pidfile="/tmp/fb-local-$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    # 同时通知此入口记录的直接子进程；不匹配其它实例的命令行。
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "[stop] $name (pid $pid)"
  fi
done
# 不按全局命令行匹配兜底杀进程：其他隔离实例可能使用相同脚本。
echo "[stop] 完成"
