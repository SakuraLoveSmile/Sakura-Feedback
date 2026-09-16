#!/usr/bin/env bash
# 简易模式更新：备份数据卷（tar 包）→ compose pull → up -d → 等待健康。
# 对应 compose.simple.yml / bootstrap.sh 的部署形态。
#
# 用法：
#   bash deploy/update.sh                       # 默认部署目录
#   bash deploy/update.sh --deploy-dir /opt/feedback
#   bash deploy/update.sh --no-backup           # 跳过卷备份（不推荐）
#   bash deploy/update.sh --to v0.3.0           # 回退/切到指定版本标签（数据库已迁移时需同时恢复备份）

set -euo pipefail

DEPLOY_DIR="/opt/1panel/docker/compose/feedback"
NO_BACKUP=0
TO_VERSION=""

usage() {
  cat <<'USAGE'
用法：bash deploy/update.sh [选项]

选项：
  --deploy-dir <路径>   部署目录（默认 /opt/1panel/docker/compose/feedback）
  --to <vX.Y.Z>         切到指定版本标签而不是 latest（回退用；跨数据库 schema 版本回退需先恢复备份）
  --no-backup           跳过数据卷 tar 备份
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-dir) DEPLOY_DIR="${2:?}"; shift 2 ;;
    --to) TO_VERSION="${2:?}"; shift 2 ;;
    --no-backup) NO_BACKUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '[update] %s\n' "$*"; }
fail() { printf '[update] 错误：%s\n' "$*" >&2; exit 1; }

ENV_FILE="$DEPLOY_DIR/.env.prod"
BACKUP_DIR="$DEPLOY_DIR/backups"

[ -f "$ENV_FILE" ] || fail "找不到 ${ENV_FILE}（先用 bootstrap.sh 部署）"

# compose 文件名按约定顺序自动探测（1Panel 惯例 docker-compose.* 优先）。
COMPOSE_FILE=""
COUNT=0
for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
  if [ -f "$DEPLOY_DIR/$f" ]; then
    [ -z "$COMPOSE_FILE" ] && COMPOSE_FILE="$DEPLOY_DIR/$f"
    COUNT=$((COUNT + 1))
  fi
done
[ -n "$COMPOSE_FILE" ] || fail "在 $DEPLOY_DIR 找不到 compose 文件（docker-compose.yml / compose.yml）"
[ "$COUNT" -le 1 ] || log "提示：部署目录里有多个 compose 文件；本脚本固定用 $(basename "$COMPOSE_FILE")，裸 docker compose 的选取顺序不同——建议只保留一个"

# 不整体 source env 文件（值里可能含特殊字符），只提取需要的字段。
# 用 sed 而非 grep：无匹配时返回 0，避免 pipefail 下静默退出。
read_env() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

VOLUME="$(read_env FEEDBACK_DATA_VOLUME)"
VOLUME="${VOLUME:-feedback-data}"
CURRENT_IMAGE="$(read_env FEEDBACK_IMAGE)"
[ -n "$CURRENT_IMAGE" ] || fail ".env.prod 里未找到 FEEDBACK_IMAGE"

# ---------- 备份数据卷（用当前运行中的旧镜像；在新镜像拉到/启动之前完成） ----------
if [ "$NO_BACKUP" -ne 1 ]; then
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  PLATFORM="$(read_env FEEDBACK_PLATFORM)"
  PLATFORM="${PLATFORM:-linux/amd64}"
  log "备份数据卷 $VOLUME → $BACKUP_DIR/feedback-data-$STAMP.tgz"
  docker run --rm --platform "$PLATFORM" \
    -v "$VOLUME:/data:ro" \
    -v "$BACKUP_DIR:/backup" \
    "$CURRENT_IMAGE" \
    sh -c "tar czf \"/backup/feedback-data-$STAMP.tgz\" -C /data ." \
    || fail "卷备份失败（卷 $VOLUME 存在吗？docker volume ls 核对）"
  # 只保留最近 10 份备份
  ls -1t "$BACKUP_DIR"/feedback-data-*.tgz 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
fi

# ---------- 切换版本标签（可选） ----------
if [ -n "$TO_VERSION" ]; then
  # 只在最后一个路径段上剥 tag/digest，避免把 registry 端口（host:443/repo:tag）误当 tag。
  LAST="${CURRENT_IMAGE##*/}"
  NAME="${LAST%%[@:]*}"
  [ -n "$NAME" ] || fail "无法从 $CURRENT_IMAGE 推导镜像名"
  BASE="${CURRENT_IMAGE%"$LAST"}${NAME}"
  NEW_IMAGE="$BASE:$TO_VERSION"
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^FEEDBACK_IMAGE=.*|FEEDBACK_IMAGE=$NEW_IMAGE|" "$ENV_FILE"
  else
    sed -i '' "s|^FEEDBACK_IMAGE=.*|FEEDBACK_IMAGE=$NEW_IMAGE|" "$ENV_FILE"
  fi
  log "FEEDBACK_IMAGE → $NEW_IMAGE"
  CURRENT_IMAGE="$NEW_IMAGE"
fi

# ---------- 拉取并重启 ----------
log "拉取镜像…"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

# ---------- 等待健康 ----------
log "等待健康检查…"
ok=0
for _ in $(seq 1 30); do
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T feedback wget -qO- http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"ok"'; then
    ok=1; break
  fi
  sleep 2
done
[ "$ok" -eq 1 ] || fail "服务未就绪：docker compose -f $COMPOSE_FILE logs --tail 50 feedback"

log "更新完成。当前镜像：$CURRENT_IMAGE"
