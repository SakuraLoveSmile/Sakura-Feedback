#!/usr/bin/env bash
# 简易模式首次部署：核对环境 → 交互收集配置 → 生成 .env.prod（600）→ 落 compose.yml → 拉镜像启动。
#
# 用法：
#   bash deploy/bootstrap.sh                          # 交互式（缺什么问什么）
#   bash deploy/bootstrap.sh --public-url https://fb.example.com
#   bash deploy/bootstrap.sh --deploy-dir /opt/feedback --image ghcr.io/.../sakura-feedback:v0.4.0
#   bash deploy/bootstrap.sh --dry-run                # 只展示将做的事，不写文件
#
# 之后的每次更新：bash deploy/update.sh（同一部署目录）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/compose.simple.yml"

DEPLOY_DIR="/opt/1panel/docker/compose/feedback"
PUBLIC_URL=""
IMAGE="ghcr.io/sakuralovesmile/sakura-feedback:latest"
ADMIN_USER="admin"
ADMIN_PASSWORD=""
BIND="127.0.0.1:8787"
DRY_RUN=0
FORCE=0
NON_INTERACTIVE=0

usage() {
  cat <<'USAGE'
用法：bash deploy/bootstrap.sh [选项]

选项：
  --deploy-dir <路径>      部署目录（默认 /opt/1panel/docker/compose/feedback）
  --public-url <URL>       公网入口地址，如 https://fb.example.com（缺省则交互询问）
  --image <引用>           镜像引用（默认 ghcr.io/sakuralovesmile/sakura-feedback:latest；
                           可换 :vX.Y.Z 固定版本，回退也用它）
  --admin-user <名字>      初始管理员用户名（默认 admin；仅首启建号时生效）
  --admin-password <密码>  初始管理员密码（缺省则生成随机值并打印一次）
  --bind <地址:端口>       宿主绑定（默认 127.0.0.1:8787；仅允许回环地址）
  --force                  部署目录已有 .env.prod 时覆盖（会先备份原文件）
  --non-interactive        不询问；缺必填项即报错退出
  --dry-run                只核对与展示改动，不写任何文件
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-dir) DEPLOY_DIR="${2:?}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:?}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift 2 ;;
    --bind) BIND="${2:?}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap] 错误：%s\n' "$*" >&2; exit 1; }

# ---------- 核对环境 ----------
command -v docker >/dev/null 2>&1 || fail "未找到 docker"
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose（需要 compose v2 插件）"

case "$BIND" in
  127.0.0.1:*|localhost:*|\[::1\]:*) ;;
  *) fail "FEEDBACK_BIND 只允许回环地址（公网入口走 Nginx TLS）；收到：$BIND" ;;
esac

[ -f "$TEMPLATE" ] || fail "找不到模板 $TEMPLATE"

# ---------- 收集配置 ----------
if [ -z "$PUBLIC_URL" ]; then
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    fail "缺少 --public-url（--non-interactive 模式下必填）"
  fi
  printf '公网入口地址（如 https://fb.example.com）：' >&2
  read -r PUBLIC_URL
fi
case "$PUBLIC_URL" in
  https://*) ;;
  http://*) log "警告：公网入口是 http——Cookie Secure 已开，登录态只在 HTTPS 下可用。建议配 Nginx TLS。" ;;
  *) fail "--public-url 必须是含协议的 origin（https://…）" ;;
esac
PUBLIC_URL="${PUBLIC_URL%/}"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"; else node -e "console.log(require('crypto').randomBytes($1).toString('base64'))"; fi
}
gen_password() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 12; else node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"; fi
}

MASTER_KEY="$(gen_secret 32)"
GENERATED_PW=0
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(gen_password)"
  GENERATED_PW=1
fi

ENV_FILE="$DEPLOY_DIR/.env.prod"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

if [ -e "$ENV_FILE" ] && [ "$FORCE" -ne 1 ]; then
  fail "$ENV_FILE 已存在（如需重来加 --force）"
fi

# ---------- 展示计划 ----------
log "部署目录：$DEPLOY_DIR"
log "镜像：$IMAGE"
log "公网地址：$PUBLIC_URL"
log "绑定：$BIND"
log "初始管理员：$ADMIN_USER"
if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run：不写文件、不拉镜像、不启动。"
  exit 0
fi

# ---------- 写入 ----------
mkdir -p "$DEPLOY_DIR"
umask 077

if [ -e "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  log "已备份既有 .env.prod"
fi

cat > "$ENV_FILE" <<EOF
# 由 deploy/bootstrap.sh 生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
FEEDBACK_IMAGE=$IMAGE
FEEDBACK_PUBLIC_URL=$PUBLIC_URL
FEEDBACK_BIND=$BIND
FEEDBACK_MASTER_KEY=$MASTER_KEY
FEEDBACK_ADMIN_USER=$ADMIN_USER
FEEDBACK_ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

cp "$TEMPLATE" "$COMPOSE_FILE"
log "已写入 ${ENV_FILE}（600）与 ${COMPOSE_FILE}"

# 裸 docker compose 的查找顺序是 compose.yaml > compose.yml > docker-compose.yaml > docker-compose.yml；
# 目录里若残留旧文件会盖过刚写入的 docker-compose.yml，必须提示。
for f in compose.yaml compose.yml docker-compose.yaml; do
  [ -f "$DEPLOY_DIR/$f" ] && log "注意：$DEPLOY_DIR/$f 仍在——裸 docker compose 会优先使用它而不是 docker-compose.yml，建议删除"
done

# ---------- 拉取并启动 ----------
cd "$DEPLOY_DIR"
if ! docker compose --env-file .env.prod -f docker-compose.yml pull; then
  fail "镜像拉取失败。私有 GHCR 需要先登录：
  echo \"\$GHCR_READ_TOKEN\" | docker login ghcr.io -u <用户名> --password-stdin
  （PAT 仅需 read:packages）"
fi
docker compose --env-file .env.prod -f docker-compose.yml up -d

# ---------- 等待健康 ----------
log "等待健康检查…"
ok=0
for _ in $(seq 1 30); do
  if docker compose --env-file .env.prod -f docker-compose.yml exec -T feedback wget -qO- http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"ok"'; then
    ok=1; break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  log "健康检查未通过，最近日志："
  docker compose --env-file .env.prod -f docker-compose.yml logs --tail 30 feedback >&2 || true
  fail "服务未就绪，请检查上面的日志"
fi

log "启动成功：${PUBLIC_URL}（管理页 ${PUBLIC_URL}/admin/）"
if [ "$GENERATED_PW" -eq 1 ]; then
  printf '\n初始管理员凭据（只显示这一次，已写入 .env.prod）：\n  用户名：%s\n  密码：%s\n\n' "$ADMIN_USER" "$ADMIN_PASSWORD"
fi
log "下一步：Nginx TLS 终止模板见 deploy/nginx/feedback.conf.template"
log "以后每次更新：bash $(dirname "$0")/update.sh --deploy-dir $DEPLOY_DIR"
