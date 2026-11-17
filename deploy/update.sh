#!/usr/bin/env bash
# 更新入口。两个互相独立、都遵循「先下载 → 校验 → 再覆盖」的安全更新步骤：
#   1) 服务镜像：先把目标镜像按 digest 拉取到本地（不改动现有标签）→ 校验镜像 ID 与
#      发布清单的 digest 一致 → 备份 .env.prod 并切到 <tag>@<digest> → 重建容器；
#   2) geo 文件（可选）：下载到同目录临时文件 → 校验体积与 protobuf 线格式（含指定分类）
#      → 备份原文件 → 原子 rename 覆盖 → 重启 mihomo → 起不来就把备份换回去。
#
# 用法：
#   bash deploy/update.sh                       # 默认部署目录；按当前标签解析发布清单更新
#   bash deploy/update.sh --deploy-dir /opt/feedback
#   bash deploy/update.sh --to v0.9.2           # 切到指定版本（回退；跨 schema 先恢复备份）
#   bash deploy/update.sh --digest sha256:...   # 直接指定期望 digest，不拉发布清单
#   bash deploy/update.sh --no-verify           # 旧行为：直接 pull 标签，不做 digest 校验
#   bash deploy/update.sh --geosite             # 更新服务后，顺带更新 geo 文件
#   bash deploy/update.sh --geosite-only        # 只更新 geo 文件（不需要 .env.prod）
#   bash deploy/update.sh --no-backup           # 跳过数据卷备份（不推荐）

set -euo pipefail

DEPLOY_DIR="/opt/1panel/docker/compose/feedback"
NO_BACKUP=0
TO_VERSION=""
EXPECT_DIGEST=""
NO_VERIFY=0
MANIFEST_URL=""

GEOSITE_ENABLED=0
GEOSITE_ONLY=0
GEOSITE_URL="https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat"
GEOSITE_PATH="/opt/1panel/docker/compose/clash/mihomo/GeoSite.dat"
GEOSITE_CONTAINER="mihomo"
GEOSITE_REQUIRE="gfw"
GEOSITE_BACKUPS=3

usage() {
  cat <<'USAGE'
用法：bash deploy/update.sh [选项]

服务更新：
  --deploy-dir <路径>   部署目录（默认 /opt/1panel/docker/compose/feedback）
  --to <vX.Y.Z>         切到指定版本标签而不是当前标签（回退用；跨数据库 schema 版本回退需先恢复备份）
  --digest <sha256:..>  直接指定期望的镜像 digest（跳过发布清单；离线/自建渠道时用）
  --manifest-url <URL>  改用自定义发布清单地址（默认 GitHub Release 的 release-manifest.json）
  --no-verify           不校验 digest，退回旧的 compose pull 行为（不推荐）
  --no-backup           跳过数据卷 tar 备份

geo 文件更新（可选，独立于服务更新）：
  --geosite             服务更新完成后，顺带更新 geo 文件
  --geosite-only        只更新 geo 文件，不碰服务
  --geosite-url <URL>   下载地址（默认 MetaCubeX meta-rules-dat 的 geosite.dat）
  --geosite-path <路径> 目标文件（默认 /opt/1panel/docker/compose/clash/mihomo/GeoSite.dat）
  --geosite-container <名称>  需要重启的容器（默认 mihomo）
  --geosite-require <列表>    必须存在的分类，逗号分隔（默认 gfw）

其它：
  -h, --help            显示本帮助
USAGE
}

log() { printf '[update] %s\n' "$*"; }
fail() { printf '[update] 错误：%s\n' "$*" >&2; exit 1; }

# GNU coreutils 与 macOS/BSD 都能用的 sha256。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-dir) DEPLOY_DIR="${2:?}"; shift 2 ;;
    --to) TO_VERSION="${2:?}"; shift 2 ;;
    --digest) EXPECT_DIGEST="${2:?}"; shift 2 ;;
    --manifest-url) MANIFEST_URL="${2:?}"; shift 2 ;;
    --no-verify) NO_VERIFY=1; shift ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --geosite) GEOSITE_ENABLED=1; shift ;;
    --geosite-only) GEOSITE_ENABLED=1; GEOSITE_ONLY=1; shift ;;
    --geosite-url) GEOSITE_URL="${2:?}"; shift 2 ;;
    --geosite-path) GEOSITE_PATH="${2:?}"; shift 2 ;;
    --geosite-container) GEOSITE_CONTAINER="${2:?}"; shift 2 ;;
    --geosite-require) GEOSITE_REQUIRE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ============================================================================
# geo 文件：下载 → 校验 → 备份 → 原子覆盖 → 重启并复查（失败自动回滚）
# ============================================================================

# 校验下载文件：protobuf 线格式完整（无截断）+ 必需分类都存在。
# geosite.dat 顶层是 GeoSiteList{ repeated GeoSite entry = 1 }，entry 的 name 是 field 1。
verify_geosite_file() {
  local file="$1" require="$2"
  python3 - "$file" "$require" <<'PY'
import sys

path, require = sys.argv[1], sys.argv[2]

def read_varint(buf, pos):
    shift = 0
    value = 0
    while True:
        if pos >= len(buf):
            raise EOFError("varint 在文件末尾截断")
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint 过长")

data = open(path, "rb").read()
if not data:
    print("文件为空", file=sys.stderr)
    sys.exit(1)

pos = 0
names = []
while pos < len(data):
    try:
        key, pos = read_varint(data, pos)
    except EOFError as exc:
        print("线格式损坏：%s（偏移 %s）" % (exc, pos), file=sys.stderr)
        sys.exit(1)
    if key >> 3 != 1 or key & 7 != 2:
        print("线格式异常：偏移 %s 处字段号 %s 线类型 %s，应为 1/2" % (pos, key >> 3, key & 7), file=sys.stderr)
        sys.exit(1)
    try:
        length, pos = read_varint(data, pos)
    except EOFError as exc:
        print("线格式损坏：%s（偏移 %s）" % (exc, pos), file=sys.stderr)
        sys.exit(1)
    end = pos + length
    if end > len(data):
        print("文件被截断：偏移 %s 处声明 %s 字节，只剩 %s 字节" % (pos, length, len(data) - pos), file=sys.stderr)
        sys.exit(1)
    entry = data[pos:end]
    pos = end
    if entry:
        try:
            tag, i = read_varint(entry, 0)
            if tag == 0x0A:
                name_len, j = read_varint(entry, i)
                names.append(entry[j:j + name_len].decode("utf-8", "replace"))
        except (EOFError, ValueError):
            names.append("")

if not names:
    print("没有任何分类记录", file=sys.stderr)
    sys.exit(1)

lowered = set(n.lower() for n in names)
missing = [c.strip().lower() for c in require.split(",") if c.strip() and c.strip().lower() not in lowered]
if missing:
    print("缺少必需分类：%s（文件内共 %s 个分类）" % (",".join(missing), len(names)), file=sys.stderr)
    sys.exit(1)

print("分类 %s 个，包含 %s" % (len(names), require))
PY
}

# geo 更新的临时文件：全局持有，保证 EXIT trap 在函数返回后仍能清理。
GEO_TMP=""
GEO_HDR=""
cleanup_geo_tmp() {
  if [ -n "${GEO_TMP}" ]; then
    rm -f "${GEO_TMP}" "${GEO_HDR}"
  fi
}
trap cleanup_geo_tmp EXIT

update_geosite() {
  command -v python3 >/dev/null 2>&1 || fail "geo 文件校验需要 python3，请先安装"
  command -v curl >/dev/null 2>&1 || fail "geo 文件下载需要 curl"

  local file_dir header_len actual_len before_sha after_sha backup start_ts status fatal
  file_dir="$(dirname "$GEOSITE_PATH")"
  [ -d "$file_dir" ] || fail "geo 目录不存在：$file_dir"

  # 临时文件与目标同目录：后续 rename 是原子替换，不会出现半个文件被 mihomo 读到。
  GEO_TMP="$(mktemp "$file_dir/.geosite.XXXXXX")" || fail "无法在 $file_dir 创建临时文件（需要写权限）"
  GEO_HDR="$GEO_TMP.headers"

  log "下载 geo 文件：$GEOSITE_URL"
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -m 300 -D "$GEO_HDR" -o "$GEO_TMP" "$GEOSITE_URL" \
    || fail "geo 文件下载失败：$GEOSITE_URL"

  actual_len="$(wc -c <"$GEO_TMP" | tr -d ' ')"
  [ "$actual_len" -gt 0 ] || fail "geo 文件下载为空"
  # 有 Content-Length 时先做体积对照，能立刻发现「下载被截断」。
  header_len="$(awk 'BEGIN{IGNORECASE=1} /^content-length:/{v=$2} END{gsub(/[\r\n]/,"",v); print v}' "$GEO_HDR" 2>/dev/null || true)"
  if [ -n "$header_len" ]; then
    [ "$header_len" = "$actual_len" ] || fail "下载不完整：Content-Length=${header_len}，实际 $actual_len 字节"
  fi
  log "下载完成：$actual_len 字节，开始校验线格式与分类"
  verify_geosite_file "$GEO_TMP" "$GEOSITE_REQUIRE" || fail "geo 文件校验未通过，未改动 $GEOSITE_PATH"

  if [ -f "$GEOSITE_PATH" ]; then
    before_sha="$(sha256_of "$GEOSITE_PATH")"
    after_sha="$(sha256_of "$GEO_TMP")"
    if [ "$before_sha" = "$after_sha" ]; then
      log "geo 文件内容未变化（sha256 ${after_sha:0:12}…），跳过覆盖与重启"
      return 0
    fi
    backup="$GEOSITE_PATH.bak.$(date +%Y%m%d-%H%M%S)"
    log "备份现有文件：$backup"
    cp -a "$GEOSITE_PATH" "$backup" || fail "备份 $GEOSITE_PATH 失败"
    ls -1t "$GEOSITE_PATH".bak.* 2>/dev/null | tail -n +$((GEOSITE_BACKUPS + 1)) | while read -r old; do
      [ -n "$old" ] && rm -f "$old"
    done
  else
    backup=""
    log "目标文件不存在，将新建：$GEOSITE_PATH"
  fi

  mv -f "$GEO_TMP" "$GEOSITE_PATH" || fail "覆盖 $GEOSITE_PATH 失败（权限不足？）"
  GEO_TMP=""
  log "已原子替换：${GEOSITE_PATH}（sha256 $(sha256_of "$GEOSITE_PATH" | cut -c1-12)…）"

  log "重启容器 $GEOSITE_CONTAINER 并复查"
  start_ts="$(date +%s)"
  docker restart "$GEOSITE_CONTAINER" >/dev/null || fail "重启 $GEOSITE_CONTAINER 失败"
  status=""
  for _ in $(seq 1 15); do
    status="$(docker inspect -f '{{.State.Status}}' "$GEOSITE_CONTAINER" 2>/dev/null || true)"
    [ "$status" = "running" ] && break
    sleep 2
  done
  [ "$status" = "running" ] || status="not-running"

  # 只看本次重启之后产生的日志，避免把历史 fatal 当成这次失败。
  fatal="$(docker logs --since "$start_ts" "$GEOSITE_CONTAINER" 2>&1 | grep -c 'level=fatal' || true)"
  if [ "$status" != "running" ] || [ "${fatal:-0}" -gt 0 ]; then
    if [ -n "$backup" ] && [ -f "$backup" ]; then
      log "新文件启动失败，回滚到备份"
      cp -a "$backup" "$GEOSITE_PATH"
      docker restart "$GEOSITE_CONTAINER" >/dev/null 2>&1 || true
    fi
    fail "geo 文件替换后 $GEOSITE_CONTAINER 未能正常运行（status=$status, fatal=${fatal}）"
  fi
  log "geo 文件更新完成；$GEOSITE_CONTAINER 运行中，无 fatal 日志"
}

# ============================================================================
# 服务镜像：解析发布清单 → 按 digest 暂存拉取 → 校验 → 备份 env → 切换 → 重建
# ============================================================================

# 读取发布清单，输出「标签 digest」；失败时返回非零。
resolve_manifest() {
  local want_tag="$1" url manifest
  if [ -n "$MANIFEST_URL" ]; then
    url="$MANIFEST_URL"
  elif [ "$want_tag" = "latest" ]; then
    url="https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/latest/download/release-manifest.json"
  else
    url="https://github.com/SakuraLoveSmile/Sakura-Feedback/releases/download/v${want_tag#v}/release-manifest.json"
  fi
  manifest="$(mktemp)" || fail "无法创建临时文件"
  if ! curl -fsSL --retry 3 --retry-delay 2 -m 30 "$url" -o "$manifest"; then
    rm -f "$manifest"
    fail "拉取发布清单失败：${url}（可用 --digest 指定期望 digest，或 --no-verify 跳过校验）"
  fi
  if ! python3 - "$manifest" "$want_tag" <<'PY'
import json, re, sys

path, want = sys.argv[1], sys.argv[2]
try:
    manifest = json.load(open(path))
except Exception as exc:
    print("发布清单不是合法 JSON：%s" % exc, file=sys.stderr)
    sys.exit(1)

if manifest.get("manifestVersion") != 1:
    print("发布清单 manifestVersion 不是 1", file=sys.stderr)
    sys.exit(1)
if manifest.get("channel") != "stable":
    print("发布清单不是 stable 渠道", file=sys.stderr)
    sys.exit(1)
digest = ((manifest.get("services") or {}).get("feedback") or {}).get("digest") or ""
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    print("发布清单 digest 非法：%r" % digest, file=sys.stderr)
    sys.exit(1)
tag = manifest.get("tag") or ""
if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
    print("发布清单 tag 非法：%r" % tag, file=sys.stderr)
    sys.exit(1)
if want != "latest":
    normalized = want if want.startswith("v") else "v" + want
    if tag != normalized:
        print("发布清单标签 %s 与请求的 %s 不一致" % (tag, normalized), file=sys.stderr)
        sys.exit(1)
print(tag + " " + digest)
PY
  then
    rm -f "$manifest"
    return 1
  fi
  rm -f "$manifest"
}

# 从镜像引用里剥掉 tag / digest，得到仓库名（只在最后一段上处理，避免误伤 registry 端口）。
image_repo() {
  local ref="$1" last name
  last="${ref##*/}"
  name="${last%%[@:]*}"
  [ -n "$name" ] || fail "无法从 $ref 推导镜像名"
  printf '%s%s' "${ref%"$last"}" "$name"
}

# 从镜像引用里取标签；只有 digest 没有标签时返回 latest。
image_tag() {
  local ref="$1" last
  last="${ref##*/}"
  case "$last" in
    *@sha256:*) last="${last%%@*}" ;;
  esac
  case "$last" in
    *:*) printf '%s' "${last##*:}" ;;
    *) printf 'latest' ;;
  esac
}

set_env_image() {
  local value="$1"
  if grep -q '^FEEDBACK_IMAGE=' "$ENV_FILE"; then
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^FEEDBACK_IMAGE=.*|FEEDBACK_IMAGE=$value|" "$ENV_FILE"
    else
      sed -i '' "s|^FEEDBACK_IMAGE=.*|FEEDBACK_IMAGE=$value|" "$ENV_FILE"
    fi
  else
    printf 'FEEDBACK_IMAGE=%s\n' "$value" >>"$ENV_FILE"
  fi
}

wait_healthy() {
  local ok=0
  log "等待健康检查…"
  for _ in $(seq 1 30); do
    if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T feedback wget -qO- http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"ok"'; then
      ok=1
      break
    fi
    sleep 2
  done
  [ "$ok" -eq 1 ] || fail "服务未就绪：docker compose -f $COMPOSE_FILE logs --tail 50 feedback"
}

# ============================================================================

if [ "$GEOSITE_ONLY" -eq 1 ]; then
  update_geosite
  log "完成（仅 geo 文件）"
  exit 0
fi

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

# 数据位置：命名卷名或宿主目录绝对路径（docker run -v 两种都接受）。
# FEEDBACK_DATA_PATH（目录挂载）优先，其次 FEEDBACK_DATA_VOLUME（命名卷），最后默认卷名。
DATA_SOURCE="$(read_env FEEDBACK_DATA_PATH)"
DATA_SOURCE="${DATA_SOURCE:-$(read_env FEEDBACK_DATA_VOLUME)}"
DATA_SOURCE="${DATA_SOURCE:-feedback-data}"
CURRENT_IMAGE="$(read_env FEEDBACK_IMAGE)"
[ -n "$CURRENT_IMAGE" ] || fail ".env.prod 里未找到 FEEDBACK_IMAGE"

# ---------- 备份数据卷（用当前运行中的旧镜像；在新镜像拉到/启动之前完成） ----------
if [ "$NO_BACKUP" -ne 1 ]; then
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  PLATFORM="$(read_env FEEDBACK_PLATFORM)"
  PLATFORM="${PLATFORM:-linux/amd64}"
  log "备份数据 $DATA_SOURCE → $BACKUP_DIR/feedback-data-$STAMP.tgz"
  docker run --rm --platform "$PLATFORM" \
    -v "$DATA_SOURCE:/data:ro" \
    -v "$BACKUP_DIR:/backup" \
    "$CURRENT_IMAGE" \
    sh -c "tar czf \"/backup/feedback-data-$STAMP.tgz\" -C /data ." \
    || fail "数据备份失败（卷/目录 $DATA_SOURCE 存在吗？docker volume ls / ls -ld 核对）"
  # 只保留最近 10 份备份
  ls -1t "$BACKUP_DIR"/feedback-data-*.tgz 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
fi

# ---------- 解析目标镜像并做「先下载 → 校验 → 再切换」 ----------
if [ "$NO_VERIFY" -eq 1 ]; then
  log "按 --no-verify 跳过 digest 校验：直接 pull 标签"
  if [ -n "$TO_VERSION" ]; then
    NEW_IMAGE="$(image_repo "$CURRENT_IMAGE"):$TO_VERSION"
    set_env_image "$NEW_IMAGE"
    CURRENT_IMAGE="$NEW_IMAGE"
    log "FEEDBACK_IMAGE → $NEW_IMAGE"
  fi
  log "拉取镜像…"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
else
  REPO="$(image_repo "$CURRENT_IMAGE")"
  if [ -n "$TO_VERSION" ]; then
    WANT_TAG="$TO_VERSION"
  else
    WANT_TAG="$(image_tag "$CURRENT_IMAGE")"
  fi

  if [ -n "$EXPECT_DIGEST" ]; then
    printf '%s' "$EXPECT_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' \
      || fail "--digest 格式非法：$EXPECT_DIGEST"
    RESOLVED_TAG="$WANT_TAG"
    RESOLVED_DIGEST="$EXPECT_DIGEST"
    log "使用 --digest 指定的 digest：$RESOLVED_DIGEST"
  else
    log "读取发布清单以确定 $WANT_TAG 的 digest…"
    MANIFEST_RESULT="$(resolve_manifest "$WANT_TAG")" \
      || fail "发布清单校验未通过：${WANT_TAG}（可用 --digest 指定期望 digest，或 --no-verify 跳过校验）"
    RESOLVED_TAG="$(printf '%s' "$MANIFEST_RESULT" | awk '{print $1}')"
    RESOLVED_DIGEST="$(printf '%s' "$MANIFEST_RESULT" | awk '{print $2}')"
    log "发布清单：tag=$RESOLVED_TAG digest=$RESOLVED_DIGEST"
  fi

  log "暂存拉取 $REPO@${RESOLVED_DIGEST}（不改动现有标签）"
  docker pull "$REPO@$RESOLVED_DIGEST" || fail "镜像拉取失败：$REPO@$RESOLVED_DIGEST"

  PULLED_ID="$(docker image inspect "$REPO@$RESOLVED_DIGEST" --format '{{.Id}}' 2>/dev/null || true)"
  [ -n "$PULLED_ID" ] || fail "拉取后找不到 $REPO@$RESOLVED_DIGEST"
  [ "$PULLED_ID" = "$RESOLVED_DIGEST" ] \
    || fail "镜像校验失败：本地 ID $PULLED_ID 与期望 $RESOLVED_DIGEST 不一致（可能拉到镜像站的不同内容）"

  log "校验通过，写入标签 $REPO:$RESOLVED_TAG"
  docker tag "$REPO@$RESOLVED_DIGEST" "$REPO:$RESOLVED_TAG" || fail "写入标签失败"

  NEW_IMAGE="$REPO:$RESOLVED_TAG@$RESOLVED_DIGEST"
  if [ "$NEW_IMAGE" = "$CURRENT_IMAGE" ]; then
    log "目标镜像与当前一致：$NEW_IMAGE"
  fi
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$ENV_FILE" "$BACKUP_DIR/.env.prod.$(date +%Y%m%d-%H%M%S)" || fail "备份 $ENV_FILE 失败"
  set_env_image "$NEW_IMAGE"
  log "FEEDBACK_IMAGE → $NEW_IMAGE"
  CURRENT_IMAGE="$NEW_IMAGE"
fi

# ---------- 重建 ----------
log "重建容器…"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

wait_healthy

log "更新完成。当前镜像：$CURRENT_IMAGE"

# ---------- 可选：顺带更新 geo 文件 ----------
if [ "$GEOSITE_ENABLED" -eq 1 ]; then
  update_geosite
fi
