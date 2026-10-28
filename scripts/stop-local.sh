#!/usr/bin/env bash
# 停止 scripts/start-local.sh 启动的全部进程
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

descendants() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    descendants "$child"
    printf '%s\n' "$child"
  done
}

for name in server react vue mock; do
  pidfile="/tmp/fb-local-$name.pid"
  ownerfile="/tmp/fb-local-$name.owner"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || [ ! -f "$ownerfile" ]; then
      echo "[stop] $name 缺少可核对的进程身份，保留 PID 文件；请手动核对" >&2
      continue
    fi
    owner_root="$(sed -n '1p' "$ownerfile")"
    owner_started="$(sed -n '2p' "$ownerfile")"
    if [ "$owner_root" != "$ROOT" ]; then
      echo "[stop] $name 属于其他启动目录，保留进程与 PID 文件" >&2
      continue
    fi
    started="$(ps -p "$pid" -o lstart= 2>/dev/null)"
    if [ -n "$started" ] && { [ -z "$owner_started" ] || [ "$started" != "$owner_started" ]; }; then
      echo "[stop] $name 的 PID 身份已变化，保留进程与 PID 文件" >&2
      continue
    fi
    # 先快照整棵子进程树（npx → tsx watch → 监听进程），只处理本入口的后代。
    children=""
    if [ -n "$started" ]; then
      children="$(descendants "$pid")"
      kill -TERM "$pid" 2>/dev/null || true
      for child in $children; do kill -TERM "$child" 2>/dev/null || true; done
    fi
    rm -f "$pidfile" "$ownerfile"
    echo "[stop] $name (pid $pid)"
  fi
done
# 不按全局命令行匹配杀进程，其他 worktree 可能运行相同脚本。
echo "[stop] 完成"
