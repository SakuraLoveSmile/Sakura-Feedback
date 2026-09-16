#!/usr/bin/env bash
# 首次把 updater 接进已有的 feedback 部署：核对现状 → 备份 → 生成 600 令牌 → 登记既有数据卷 → 写入受管 compose。
#
# 设计原则：
#   1. 任何写入之前先核对（compose 文件 / 项目名 / 运行中的容器 / 容器内数据目录挂载 / 端口回环 / 仓库名）；
#      任一不符即中止并给出原因，且不改动任何文件。
#   2. 只登记，不搬迁：既有数据卷作为 external 卷原地登记，绝不声明新的可创建卷来替换它。
#   3. 顺序固定为「算改动 → 用候选文件校验 compose → 备份 → 原子写入」，失败不会留下半成品。
#   4. 重复执行幂等：令牌复用（600）、文件字节不变、不重复备份。
#   5. 不依赖真实服务器：--self-test 在独立临时目录 + 独立 compose 项目/卷里跑完整流程（含幂等与拒绝路径）。
#
# 用法：见 deploy/README.md，或 bash deploy/install-updater.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_DIR="/opt/1panel/docker/compose/feedback"
COMPOSE_FILE=""
ENV_FILE=""
PROJECT="feedback"
SERVICE="feedback"
CONTROL_NAME="update-control"
TEMPLATE="${SCRIPT_DIR}/compose.prod.yml"
BACKUP_ROOT=""
UPDATER_IMAGE_ARG=""
DRY_RUN=0
ROTATE_TOKEN=0
SELF_TEST=0
TMP_FILES=()

cleanup_tmp() {
  local file
  for file in "${TMP_FILES[@]:-}"; do
    if [ -n "${file}" ] && [ -e "${file}" ]; then
      rm -f "${file}"
    fi
  done
  # EXIT trap 在 set -e 下若以非零状态结束会覆盖脚本的退出码，这里显式返回 0
  return 0
}
trap cleanup_tmp EXIT

usage() {
  cat <<'USAGE'
用法：bash deploy/install-updater.sh [选项]

默认在 /opt/1panel/docker/compose/feedback 下操作（该路径在宿主与容器内必须一致）。

选项：
  --deploy-dir <路径>     部署目录（默认 /opt/1panel/docker/compose/feedback）
  --compose-file <路径>   现有 compose 文件（默认 <deploy-dir>/compose.yml；文件名必须是 compose.yml）
  --env-file <路径>       现有环境文件（默认 <deploy-dir>/.env.prod）
  --project <名字>        compose 项目名（默认 feedback）
  --service <名字>        受管服务名（默认 feedback）
  --template <路径>       受管 compose 模板（默认本脚本同目录的 compose.prod.yml）
  --updater-image <引用>  写入 .env.prod 的 UPDATER_IMAGE（缺省时要求文件里已有）
  --backup-root <路径>    备份根目录（默认 <deploy-dir>/.install-backups）
  --dry-run               只核对与展示将要做的改动，不写入任何文件
  --rotate-token          重新生成共享令牌（updater-token 与 feedback-token 同时替换，均 600）
  --self-test             在独立临时目录 + 独立 compose 项目里自测（含幂等与拒绝路径），不改动真实部署
  -h, --help              显示本帮助

退出码：0 成功（含「无需改动」）；非 0 表示核对失败或写入失败，且不会留下半成品。
USAGE
}

log() { printf '\n=== %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() { printf '\n[install-updater] 中止：%s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1（$2）"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "缺少 sha256sum/shasum，无法记录备份指纹"
  fi
}

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  else
    die "无法生成随机令牌（需要 openssl / od / node 之一）"
  fi
}

# 原子写入：同目录临时文件 → chmod → rename。内容从 stdin 读。
atomic_write_stream() { # <目标路径> <权限>
  local target="$1" mode="$2" dir tmp
  dir="$(dirname "${target}")"
  tmp="$(mktemp "${dir}/.$(basename "${target}").tmp.XXXXXX")" || die "无法在 ${dir} 创建临时文件（权限不足？）"
  TMP_FILES+=("${tmp}")
  cat > "${tmp}"
  chmod "${mode}" "${tmp}" || die "无法设置 ${tmp} 权限为 ${mode}"
  mv -f "${tmp}" "${target}" || die "无法重命名 ${tmp} → ${target}"
}

# 读取环境文件中某个键的最后一个值（兼容 export 前缀与引号）
env_get() { # <文件> <键>
  awk -v key="$2" '
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      n = index(line, "=")
      if (n > 0) {
        k = substr(line, 1, n - 1)
        gsub(/[[:space:]]+$/, "", k)
        if (k == key) {
          v = substr(line, n + 1)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
          if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
          found = v
        }
      }
    }
    END { print found }
  ' "$1"
}

# 生成替换后的环境文件内容（stdout）：逐行替换目标键，缺失的键追加到末尾；其它行逐字节保留。
render_env() { # <文件> KEY=VALUE ...
  local file="$1"
  shift
  # 用环境变量传多行数据（BWK awk 的 -v 不接受字面换行），awk 侧用 ENVIRON 读取
  RENDER_ENV_PAIRS="$(printf '%s\n' "$@")" awk '
    BEGIN {
      n = split(ENVIRON["RENDER_ENV_PAIRS"], arr, "\n")
      for (i = 1; i <= n; i++) {
        p = index(arr[i], "=")
        if (p <= 0) continue
        k = substr(arr[i], 1, p - 1)
        v = substr(arr[i], p + 1)
        want[k] = v
        order[++orderCount] = k
      }
    }
    {
      line = $0
      probe = line
      sub(/^[[:space:]]*export[[:space:]]+/, "", probe)
      p = index(probe, "=")
      if (p > 0) {
        k = substr(probe, 1, p - 1)
        gsub(/[[:space:]]+$/, "", k)
        if (k in want) {
          print k "=" want[k]
          applied[k] = 1
          next
        }
      }
      print line
    }
    END {
      for (i = 1; i <= orderCount; i++) {
        k = order[i]
        if (!(k in applied)) print k "=" want[k]
      }
    }
  ' "${file}"
}

compose() { # 针对部署目录的 compose 调用（参数数组，不拼接 shell）
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" -p "${PROJECT}" "$@"
}

container_id_for() { # <项目> <服务>
  docker ps -q \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" 2>/dev/null | head -1
}

inspect_field() { # <容器> <格式>
  docker inspect -f "$2" "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------- 1. 核对（不写文件）

VOLUME=""
IMAGE_REF=""
DATA_DIR=""
HOST_BIND=""
SERVICES=""
INSTALLED=0
COMPOSE_CHANGED=0
ENV_CHANGED=0
ENV_KEYS_CHANGED=""
ENV_RENDERED=""
COMPOSE_RENDERED=""

preflight() {
  log "1. 核对现有部署（此阶段不写任何文件）"
  require_cmd docker "需要 docker CLI"
  docker compose version >/dev/null 2>&1 || die "需要 docker compose 插件"
  [ -d "${DEPLOY_DIR}" ] || die "部署目录不存在：${DEPLOY_DIR}"
  [ -f "${COMPOSE_FILE}" ] || die "compose 文件不存在：${COMPOSE_FILE}（既有部署必须已经能 up 起来）"
  [ -f "${ENV_FILE}" ] || die "环境文件不存在：${ENV_FILE}（请先 cp deploy/.env.prod.example ${ENV_FILE} 并填写）"
  [ -f "${TEMPLATE}" ] || die "受管 compose 模板不存在：${TEMPLATE}"
  case "$(basename "${COMPOSE_FILE}")" in
    compose.yml) ;;
    *) die "受管 compose 文件名必须是 compose.yml（updater 的 UPDATER_COMPOSE_FILE 指向 <deploy-dir>/compose.yml），当前是 $(basename "${COMPOSE_FILE}")" ;;
  esac
  info "部署目录：${DEPLOY_DIR}"
  info "compose：${COMPOSE_FILE}（项目 ${PROJECT}，服务 ${SERVICE}）"

  local config_err
  if ! config_err="$(compose config -q 2>&1)"; then
    die "现有 compose 配置校验失败：${config_err}"
  fi
  ok "现有 compose 配置可解析（docker compose config -q）"

  SERVICES="$(compose config --services 2>/dev/null | sort | tr '\n' ' ')"
  [ -n "${SERVICES}" ] || die "未能从 compose 解析出任何服务"
  info "现有服务：${SERVICES}"
  local allowed=" ${SERVICE} updater "
  local svc
  for svc in ${SERVICES}; do
    case "${allowed}" in
      *" ${svc} "*) ;;
      *) die "compose 里存在本脚本不认识的额外服务 ${svc}：拒绝用模板覆盖手工编排的文件，请人工核对" ;;
    esac
  done
  case " ${SERVICES} " in
    *" updater "*) INSTALLED=1 ;;
  esac
  if [ "${INSTALLED}" = "1" ]; then
    grep -q "feedback-updater (managed by deploy/install-updater.sh)" "${COMPOSE_FILE}" \
      || die "compose 里已有 updater 服务但不是本脚本管理的（缺少 managed 标记）：拒绝覆盖，请人工核对"
    ok "已检测到受管 updater 服务（本次为幂等重跑）"
  fi

  local cid
  cid="$(container_id_for "${PROJECT}" "${SERVICE}")"
  [ -n "${cid}" ] || die "项目 ${PROJECT} 中找不到服务 ${SERVICE} 的容器：请先用现有 compose 把服务 up 起来"
  info "运行中容器：${cid:0:12}"

  local label_project label_service running
  label_project="$(inspect_field "${cid}" '{{index .Config.Labels "com.docker.compose.project"}}')"
  label_service="$(inspect_field "${cid}" '{{index .Config.Labels "com.docker.compose.service"}}')"
  [ "${label_project}" = "${PROJECT}" ] || die "容器所属 compose 项目是 ${label_project:-<无>}，与 --project ${PROJECT} 不一致"
  [ "${label_service}" = "${SERVICE}" ] || die "容器所属 compose 服务是 ${label_service:-<无>}，与 --service ${SERVICE} 不一致"
  running="$(inspect_field "${cid}" '{{.State.Running}}')"
  [ "${running}" = "true" ] || die "服务容器未在运行：接入 updater 需要读到当前镜像与数据卷挂载，请先 up -d"
  ok "容器匹配且运行中（项目 ${PROJECT} / 服务 ${SERVICE}）"

  DATA_DIR="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${cid}" | sed -n 's/^FEEDBACK_DATA_DIR=//p' | tail -1)"
  DATA_DIR="${DATA_DIR:-/data}"
  [ "${DATA_DIR}" = "/data" ] || die "既有部署的数据目录是 ${DATA_DIR}，与本模板固定的 /data 不一致：请人工对齐后再接入（拒绝静默改动数据位置）"
  ok "容器内数据目录：${DATA_DIR}"

  VOLUME="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"${DATA_DIR}\"}}{{.Name}}{{end}}{{end}}" "${cid}")"
  [ -n "${VOLUME}" ] || die "容器没有把命名卷挂到 ${DATA_DIR}（可能是绑定目录或匿名卷）：updater 只能复制命名卷，请先人工迁移"
  docker volume inspect "${VOLUME}" >/dev/null 2>&1 || die "数据卷 ${VOLUME} 在本机 docker 中不存在"
  ok "既有数据卷：${VOLUME}"

  local env_volume
  env_volume="$(env_get "${ENV_FILE}" FEEDBACK_DATA_VOLUME)"
  if [ -n "${env_volume}" ] && [ "${env_volume}" != "${VOLUME}" ]; then
    die "环境文件里 FEEDBACK_DATA_VOLUME=${env_volume}，但运行中容器实际挂载的是 ${VOLUME}：请人工确认（脚本不会替你改数据卷）"
  fi
  # compose 解析出的数据卷真实名字必须与容器实际挂载一致（兼容 key/name 两种形态与任意 YAML 写法）
  local resolved_volumes
  resolved_volumes="$(compose config 2>/dev/null | sed -n '/^volumes:/,$p')"
  case "${resolved_volumes}" in
    *"name: ${VOLUME}"*) ;;
    *) die "compose 声明的数据卷与容器实际挂载不一致：compose 解析出的卷是「$(printf '%s' "${resolved_volumes}" | tr '\n' ' ' | tr -s ' ')」，容器挂载的是 ${VOLUME}：请人工对齐后再接入" ;;
  esac
  if [ -z "${env_volume}" ]; then
    info "将登记既有数据卷：FEEDBACK_DATA_VOLUME=${VOLUME}"
  fi

  local bindings binding_count
  bindings="$(inspect_field "${cid}" '{{json .HostConfig.PortBindings}}')"
  binding_count="$(inspect_field "${cid}" '{{len .HostConfig.PortBindings}}')"
  case "${bindings}" in
    *'"HostIp":"0.0.0.0"'*|*'"HostIp":"::"'*|*'"HostIp":""'*)
      die "容器端口绑定包含非回环地址（${bindings}）：请改回 127.0.0.1 再接入，避免公网裸奔" ;;
  esac
  [ "${binding_count}" = "1" ] || die "容器发布了 ${binding_count} 个端口绑定，本模板只发布 8787：拒绝静默丢弃其它端口，请人工核对"
  HOST_BIND="$(inspect_field "${cid}" '{{range $p, $conf := .HostConfig.PortBindings}}{{range $conf}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}')"
  case "${HOST_BIND}" in
    127.0.0.1:*|localhost:*|"[::1]":*) ;;
    "") die "容器没有把 8787 绑到回环地址：本模板要求 127.0.0.1 绑定，拒绝静默改动端口暴露" ;;
    *) die "容器端口绑定是 ${HOST_BIND}，不是回环地址：请在 .env.prod 设置 FEEDBACK_BIND 为回环地址后再试" ;;
  esac
  ok "端口绑定只绑回环：${HOST_BIND}"
  local env_bind
  env_bind="$(env_get "${ENV_FILE}" FEEDBACK_BIND)"
  if [ -n "${env_bind}" ] && [ "${env_bind}" != "${HOST_BIND}" ]; then
    die "环境文件里 FEEDBACK_BIND=${env_bind}，但运行中容器实际绑定 ${HOST_BIND}：请人工确认（拒绝静默改动端口暴露）"
  fi

  local config_file_label
  config_file_label="$(inspect_field "${cid}" '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
  if [ -n "${config_file_label}" ] && [ "${config_file_label}" != "${COMPOSE_FILE}" ]; then
    die "运行中容器是用 ${config_file_label} 创建的，与 --compose-file ${COMPOSE_FILE} 不一致：请传入真实文件"
  fi
  ok "compose 文件与容器来源一致${config_file_label:+（${config_file_label}）}"

  IMAGE_REF="$(inspect_field "${cid}" '{{.Config.Image}}')"
  [ -n "${IMAGE_REF}" ] || die "读不到运行中容器的镜像引用"
  info "当前镜像：${IMAGE_REF}"
  local env_image
  env_image="$(env_get "${ENV_FILE}" FEEDBACK_IMAGE)"
  if [ -n "${env_image}" ] && [ "${env_image}" != "${IMAGE_REF}" ]; then
    warn "环境文件里 FEEDBACK_IMAGE=${env_image} 与运行中镜像 ${IMAGE_REF} 不一致（保留文件里的值，不覆盖）"
  fi
}

# ---------------------------------------------------------------- 2. 控制目录与令牌

TOKEN_STATE="已就绪"

prepare_control_dir() {
  log "2. 准备更新控制目录与共享令牌"
  local control_dir="${DEPLOY_DIR}/${CONTROL_NAME}"
  local primary="${control_dir}/updater-token"
  local secondary="${control_dir}/feedback-token"
  if [ "${DRY_RUN}" = "1" ]; then
    info "（dry-run）将创建 ${control_dir}（700）与 ${control_dir}/state（700）"
    local existing=""
    [ -f "${primary}" ] && existing="$(tr -d ' \n' < "${primary}")"
    [ -n "${existing}" ] && [ "${ROTATE_TOKEN}" = "0" ] && TOKEN_STATE="已就绪（复用）" || TOKEN_STATE="将生成/轮换"
    info "（dry-run）令牌：${primary} 与 ${secondary}（600，${TOKEN_STATE}）"
    return
  fi
  mkdir -p "${control_dir}" "${control_dir}/state"
  chmod 700 "${control_dir}" "${control_dir}/state"
  ok "控制目录就绪：${control_dir}（700）"

  local existing=""
  [ -f "${primary}" ] && existing="$(tr -d ' \n' < "${primary}")"
  if [ "${ROTATE_TOKEN}" = "1" ] || [ -z "${existing}" ]; then
    local token
    token="$(gen_token)"
    [ -n "${token}" ] || die "生成令牌失败"
    [ "${ROTATE_TOKEN}" = "1" ] && TOKEN_STATE="已轮换" || TOKEN_STATE="已生成"
    printf '%s\n' "${token}" | atomic_write_stream "${primary}" 600
    printf '%s\n' "${token}" | atomic_write_stream "${secondary}" 600
    ok "令牌${TOKEN_STATE}：${primary}、${secondary}（600，值不打印）"
  else
    chmod 600 "${primary}" || die "无法把 ${primary} 设为 600"
    local secondary_value=""
    [ -f "${secondary}" ] && secondary_value="$(tr -d ' \n' < "${secondary}")"
    if [ -z "${secondary_value}" ]; then
      printf '%s\n' "${existing}" | atomic_write_stream "${secondary}" 600
      ok "补齐 feedback-token（与 updater-token 同值、600）"
    elif [ "${secondary_value}" = "${existing}" ]; then
      chmod 600 "${secondary}"
      ok "复用已有令牌（两个文件同值、均 600）"
    else
      chmod 600 "${secondary}"
      TOKEN_STATE="已就绪（两文件不同值）"
      warn "feedback-token 与 updater-token 值不同：updater 两个都接受，但建议统一（删除后重跑或 --rotate-token）"
    fi
  fi
  [ "$(file_mode "${primary}")" = "600" ] || die "${primary} 权限不是 600"
  [ "$(file_mode "${secondary}")" = "600" ] || die "${secondary} 权限不是 600"
}

# ---------------------------------------------------------------- 3. 计算改动

ENV_PAIRS=()

# 收集需要写入 .env.prod 的键（直接填 ENV_PAIRS，不用子 shell，die 会立即中止脚本）
collect_env_pairs() {
  ENV_PAIRS=()
  local control_dir="${DEPLOY_DIR}/${CONTROL_NAME}"
  ENV_PAIRS+=("FEEDBACK_DATA_VOLUME=${VOLUME}")
  ENV_PAIRS+=("UPDATER_DEPLOY_DIR=${DEPLOY_DIR}")
  ENV_PAIRS+=("FEEDBACK_UPDATE_CONTROL_DIR=${control_dir}")

  local env_bind
  env_bind="$(env_get "${ENV_FILE}" FEEDBACK_BIND)"
  [ -n "${env_bind}" ] || ENV_PAIRS+=("FEEDBACK_BIND=${HOST_BIND}")

  local token_file
  token_file="$(env_get "${ENV_FILE}" FEEDBACK_UPDATE_TOKEN_FILE)"
  if [ -z "${token_file}" ]; then
    ENV_PAIRS+=("FEEDBACK_UPDATE_TOKEN_FILE=${control_dir}/feedback-token")
  else
    case "${token_file}" in
      "${control_dir}"/*) ;;
      *) die "环境文件里 FEEDBACK_UPDATE_TOKEN_FILE=${token_file} 不在控制目录 ${control_dir} 内：拒绝改动令牌路径" ;;
    esac
  fi

  local updater_url
  updater_url="$(env_get "${ENV_FILE}" FEEDBACK_UPDATER_URL)"
  [ -n "${updater_url}" ] || ENV_PAIRS+=("FEEDBACK_UPDATER_URL=http://updater:8790")

  local env_image
  env_image="$(env_get "${ENV_FILE}" FEEDBACK_IMAGE)"
  if [ -z "${env_image}" ]; then
    warn "环境文件缺少 FEEDBACK_IMAGE：用运行中镜像 ${IMAGE_REF} 登记（建议稍后改成 digest 引用）"
    ENV_PAIRS+=("FEEDBACK_IMAGE=${IMAGE_REF}")
  fi

  local image_name
  image_name="$(env_get "${ENV_FILE}" UPDATER_IMAGE_NAME)"
  if [ -z "${image_name}" ]; then
    local derived
    derived="$(printf '%s' "${env_image:-${IMAGE_REF}}" | sed -E 's/@sha256:.*$//; s/:[^/]*$//')"
    [ -n "${derived}" ] || die "无法从 ${env_image:-${IMAGE_REF}} 推导 UPDATER_IMAGE_NAME，请在 .env.prod 显式设置"
    info "登记受管镜像名：UPDATER_IMAGE_NAME=${derived}"
    ENV_PAIRS+=("UPDATER_IMAGE_NAME=${derived}")
  fi

  local updater_image
  updater_image="$(env_get "${ENV_FILE}" UPDATER_IMAGE)"
  if [ -z "${updater_image}" ]; then
    [ -n "${UPDATER_IMAGE_ARG}" ] || die "环境文件缺少 UPDATER_IMAGE：请从 Release 清单的 services.updater.digest 填入，或加 --updater-image <引用>"
    ENV_PAIRS+=("UPDATER_IMAGE=${UPDATER_IMAGE_ARG}")
  fi
}

render_compose_candidate() { # stdout：受管 compose 内容（模板逐字节复制 + managed 标记）
  printf '# >>> feedback-updater (managed by deploy/install-updater.sh) >>>\n'
  printf '# 由 deploy/install-updater.sh 写入；手改会在下次运行时被覆盖（改动前备份到 %s）。\n' "${BACKUP_ROOT:-${DEPLOY_DIR}/.install-backups}"
  cat "${TEMPLATE}"
  printf '# <<< feedback-updater (managed by deploy/install-updater.sh) <<<\n'
}

plan_changes() {
  log "3. 计算并校验将要写入的内容（仍不落盘）"
  collect_env_pairs
  [ "${#ENV_PAIRS[@]}" -gt 0 ] || die "没有需要登记的环境变量（内部错误）"

  ENV_RENDERED="$(render_env "${ENV_FILE}" "${ENV_PAIRS[@]}")"
  if [ "${ENV_RENDERED}" = "$(cat "${ENV_FILE}")" ]; then
    ok "环境文件已是最新（无改动）"
  else
    ENV_CHANGED=1
    ENV_KEYS_CHANGED="$(printf '%s\n' "${ENV_PAIRS[@]}" | cut -d= -f1 | tr '\n' ' ')"
    info "将更新环境文件：${ENV_KEYS_CHANGED}"
  fi

  COMPOSE_RENDERED="$(render_compose_candidate)"
  if [ "${COMPOSE_RENDERED}" = "$(cat "${COMPOSE_FILE}")" ]; then
    ok "compose 文件已是最新（无改动）"
  else
    COMPOSE_CHANGED=1
    info "将重写 compose 文件（新增 updater 服务 + external 数据卷声明 + 更新控制目录挂载）"
  fi

  if [ "${DRY_RUN}" = "1" ]; then
    return
  fi
  if [ "${COMPOSE_CHANGED}" = "0" ] && [ "${ENV_CHANGED}" = "0" ]; then
    return
  fi

  # 用「候选文件」先做一次真实 compose 校验：校验不过就不动任何既有文件
  local tmp_compose="${DEPLOY_DIR}/.compose.candidate.$$"
  local tmp_env="${DEPLOY_DIR}/.env.candidate.$$"
  TMP_FILES+=("${tmp_compose}" "${tmp_env}")
  printf '%s\n' "${ENV_RENDERED}" > "${tmp_env}"
  printf '%s\n' "${COMPOSE_RENDERED}" > "${tmp_compose}"
  local validate_err
  if ! validate_err="$(docker compose -f "${tmp_compose}" --env-file "${tmp_env}" -p "${PROJECT}" config -q 2>&1)"; then
    rm -f "${tmp_compose}" "${tmp_env}"
    die "候选 compose 校验失败（未改动任何既有文件）：${validate_err}"
  fi
  rm -f "${tmp_compose}" "${tmp_env}"
  ok "候选 compose 校验通过（docker compose config -q）"
}

backup_before_write() {
  log "4. 备份"
  if [ "${COMPOSE_CHANGED}" = "0" ] && [ "${ENV_CHANGED}" = "0" ]; then
    ok "无需改动，跳过备份"
    return
  fi
  local stamp dir
  stamp="$(date +%Y%m%dT%H%M%S)"
  dir="${BACKUP_ROOT}/${stamp}"
  if [ "${DRY_RUN}" = "1" ]; then
    info "（dry-run）将备份到 ${dir}（700，文件 600）"
    return
  fi
  mkdir -p "${dir}"
  chmod 700 "${dir}"
  cp -p "${COMPOSE_FILE}" "${dir}/compose.yml"
  chmod 600 "${dir}/compose.yml"
  cp -p "${ENV_FILE}" "${dir}/.env.prod"
  chmod 600 "${dir}/.env.prod"
  {
    printf 'timestamp=%s\n' "${stamp}"
    printf 'deploy_dir=%s\n' "${DEPLOY_DIR}"
    printf 'project=%s\n' "${PROJECT}"
    printf 'service=%s\n' "${SERVICE}"
    printf 'detected_volume=%s\n' "${VOLUME}"
    printf 'detected_image=%s\n' "${IMAGE_REF}"
    printf 'detected_bind=%s\n' "${HOST_BIND}"
    printf 'compose_sha256=%s\n' "$(sha256_of "${COMPOSE_FILE}")"
    printf 'env_sha256=%s\n' "$(sha256_of "${ENV_FILE}")"
  } | atomic_write_stream "${dir}/manifest.txt" 600
  ok "备份完成：${dir}（compose.yml / .env.prod / manifest.txt，均 600）"
}

commit_changes() {
  log "5. 原子写入"
  if [ "${DRY_RUN}" = "1" ]; then
    printf '\n  （dry-run：没有写入任何文件）\n'
    return
  fi
  if [ "${ENV_CHANGED}" = "1" ]; then
    printf '%s\n' "${ENV_RENDERED}" | atomic_write_stream "${ENV_FILE}" "$(file_mode "${ENV_FILE}")"
    ok "已登记到 ${ENV_FILE}：${ENV_KEYS_CHANGED}"
  fi
  if [ "${COMPOSE_CHANGED}" = "1" ]; then
    local mode
    mode="$(file_mode "${COMPOSE_FILE}")"
    printf '%s\n' "${COMPOSE_RENDERED}" | atomic_write_stream "${COMPOSE_FILE}" "${mode}"
    ok "已写入受管 compose：${COMPOSE_FILE}（权限 ${mode}）"
  fi
}

summarize() {
  log "6. 结果"
  local control_dir="${DEPLOY_DIR}/${CONTROL_NAME}"
  ok "数据卷登记：FEEDBACK_DATA_VOLUME=${VOLUME}（external，原地登记，未新建卷）"
  ok "端口登记：FEEDBACK_BIND=${HOST_BIND}（回环）"
  ok "令牌：${control_dir}/updater-token 与 ${control_dir}/feedback-token（600，${TOKEN_STATE}）"
  ok "变更：compose.yml=$([ "${COMPOSE_CHANGED}" = 1 ] && echo 重写 || echo 未变)，.env.prod=$([ "${ENV_CHANGED}" = 1 ] && echo "更新(${ENV_KEYS_CHANGED})" || echo 未变)"
  if [ "${DRY_RUN}" = "1" ]; then
    return
  fi
  cat <<NEXT

  下一步（让新 compose 生效）：
    cd ${DEPLOY_DIR} && docker compose --env-file ${ENV_FILE} up -d
    docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} -p ${PROJECT} ps
  之后：
    · feedback 内网可访问 http://updater:8790（未发布端口，仅在 compose 网络内）
    · 后台「系统更新」标签可以检查/执行更新；升级会复制数据卷并改写 FEEDBACK_IMAGE / FEEDBACK_DATA_VOLUME
    · 令牌轮换：bash deploy/install-updater.sh --rotate-token，然后 up -d --force-recreate feedback 让服务重读令牌
NEXT
}

# ---------------------------------------------------------------- 自测

self_test_mode() {
  log "自测模式：独立临时目录 + 独立 compose 项目（不触碰真实部署与 /opt/1panel）"
  require_cmd docker "需要 docker CLI"
  docker compose version >/dev/null 2>&1 || die "需要 docker compose 插件"
  local share_root="/private/tmp"
  [ -d "${share_root}" ] || share_root="/tmp"
  # 这几个变量必须全局：EXIT trap 在函数返回后执行，local 变量那时已经出作用域（set -u 下会直接失败）
  root="$(mktemp -d "${share_root}/install-updater-selftest.XXXXXX")"
  project_main="feedback-selftest-$(od -An -N2 -tx1 </dev/urandom | tr -d ' \n')"
  project_alt="feedback-selftest-alt-$(od -An -N2 -tx1 </dev/urandom | tr -d ' \n')"
  volume_main="${project_main}_feedback-data"
  volume_alt="${project_alt}_feedback-data"
  bind_port=$((20000 + RANDOM % 20000))
  checks=0
  failures=0

  selftest_cleanup() {
    set +e
    # 注意：夹具 compose 已被替换为受管版本，down 时必须带 --env-file，否则变量插值会失败
    docker compose -f "${root}/main/compose.yml" --env-file "${root}/main/.env.prod" -p "${project_main}" down -v --remove-orphans >/dev/null 2>&1 \
      || warn "自测清理：主夹具 down 失败（请手动检查 ${project_main}）"
    docker compose -f "${root}/alt/compose.yml" --env-file "${root}/alt/.env.prod" -p "${project_alt}" down -v --remove-orphans >/dev/null 2>&1 \
      || warn "自测清理：对照夹具 down 失败（请手动检查 ${project_alt}）"
    docker rm -f "${project_main}-feedback-1" "${project_alt}-feedback-1" >/dev/null 2>&1
    docker volume rm -f "${volume_main}" "${volume_alt}" >/dev/null 2>&1
    docker network rm "${project_main}_default" "${project_alt}_default" >/dev/null 2>&1
    rm -rf "${root}"
    return 0
  }
  trap 'selftest_cleanup; cleanup_tmp' EXIT

  check() { # <描述> <期望> <实际>
    local desc="$1" expected="$2" actual="$3"
    checks=$((checks + 1))
    if [ "${expected}" = "${actual}" ]; then
      printf '  ✓ %s（%s）\n' "${desc}" "${actual}"
    else
      failures=$((failures + 1))
      printf '  ✗ %s：期望「%s」，实际「%s」\n' "${desc}" "${expected}" "${actual}"
    fi
  }
  check_true() { # <描述> <0|1>
    local desc="$1" result="$2"
    checks=$((checks + 1))
    if [ "${result}" = "0" ]; then
      printf '  ✓ %s\n' "${desc}"
    else
      failures=$((failures + 1))
      printf '  ✗ %s\n' "${desc}"
    fi
  }
  run_install() { # 运行本脚本（同一 CLI，同一代码路径）
    bash "${BASH_SOURCE[0]}" --deploy-dir "$1" --project "$2" --template "${TEMPLATE}" --updater-image "alpine:3.20" "${@:3}"
  }

  mkdir -p "${root}/main" "${root}/alt"
  cat > "${root}/main/.env.prod" <<EOF
FEEDBACK_MASTER_KEY=selftest-master-key-0123456789
FEEDBACK_PUBLIC_URL=https://selftest.example.com
FEEDBACK_IMAGE=alpine:3.20
EOF
  cat > "${root}/main/compose.yml" <<EOF
services:
  feedback:
    image: alpine:3.20
    command: ["sleep", "900"]
    ports:
      - "127.0.0.1:${bind_port}:8787"
    environment:
      FEEDBACK_DATA_DIR: /data
    env_file:
      - .env.prod
    volumes:
      - feedback-data:/data
    restart: "no"
volumes:
  feedback-data:
EOF
  cat > "${root}/alt/.env.prod" <<EOF
FEEDBACK_MASTER_KEY=selftest-master-key-0123456789
FEEDBACK_PUBLIC_URL=https://selftest.example.com
FEEDBACK_IMAGE=alpine:3.20
EOF
  cat > "${root}/alt/compose.yml" <<EOF
services:
  feedback:
    image: alpine:3.20
    command: ["sleep", "900"]
    environment:
      FEEDBACK_DATA_DIR: /data-other
    env_file:
      - .env.prod
    volumes:
      - feedback-data:/data-other
    restart: "no"
volumes:
  feedback-data:
EOF

  log "自测夹具：启动两个独立 compose 项目"
  docker compose -f "${root}/main/compose.yml" -p "${project_main}" up -d >/dev/null
  docker compose -f "${root}/alt/compose.yml" -p "${project_alt}" up -d >/dev/null
  sleep 2
  info "主夹具：${project_main} / 卷 ${volume_main} / 端口 127.0.0.1:${bind_port}"
  info "对照夹具：${project_alt} / 卷 ${volume_alt} / 数据目录 /data-other"

  local out ok_env="${root}/main/.env.prod" main_compose="${root}/main/compose.yml" token_main="${root}/main/update-control/updater-token"

  log "自测 1：首次接入（核对 → 校验 → 备份 → 令牌 → 登记）"
  if out="$(run_install "${root}/main" "${project_main}" 2>&1)"; then
    check "首次接入退出码" "0" "0"
  else
    check "首次接入退出码" "0" "非零"
    printf '%s\n' "${out}" | tail -25
  fi
  check "updater-token 存在且 600" "600" "$(file_mode "${token_main}")"
  check "feedback-token 存在且 600" "600" "$(file_mode "${root}/main/update-control/feedback-token")"
  check "两个令牌同值" "same" "$([ "$(cat "${token_main}")" = "$(cat "${root}/main/update-control/feedback-token")" ] && echo same || echo diff)"
  check "既有数据卷已登记" "${volume_main}" "$(env_get "${ok_env}" FEEDBACK_DATA_VOLUME)"
  check "端口绑定已登记" "127.0.0.1:${bind_port}" "$(env_get "${ok_env}" FEEDBACK_BIND)"
  check "部署目录已登记" "${root}/main" "$(env_get "${ok_env}" UPDATER_DEPLOY_DIR)"
  check "受管镜像名已推导" "alpine" "$(env_get "${ok_env}" UPDATER_IMAGE_NAME)"
  check "updater 镜像已写入" "alpine:3.20" "$(env_get "${ok_env}" UPDATER_IMAGE)"
  check "主密钥等其它字段保留" "selftest-master-key-0123456789" "$(env_get "${ok_env}" FEEDBACK_MASTER_KEY)"
  check_true "compose 含 updater 服务" "$(grep -q '^  updater:' "${main_compose}" && echo 0 || echo 1)"
  check_true "compose 含 external 数据卷" "$(grep -q 'external: true' "${main_compose}" && echo 0 || echo 1)"
  check_true "compose 含 managed 标记" "$(grep -q 'feedback-updater (managed by' "${main_compose}" && echo 0 || echo 1)"
  check_true "旧内容已被替换" "$(grep -q 'sleep' "${main_compose}" && echo 1 || echo 0)"
  local backup_dir
  backup_dir="$(find "${root}/main/.install-backups" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)"
  check "备份目录数量" "1" "$(find "${root}/main/.install-backups" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  check "备份 env 权限" "600" "$(file_mode "${backup_dir}/.env.prod")"
  check_true "备份含原始 compose（未含 updater）" "$(grep -q 'updater:' "${backup_dir}/compose.yml" && echo 1 || echo 0)"
  local token_before compose_before env_before
  token_before="$(sha256_of "${token_main}")"
  compose_before="$(sha256_of "${main_compose}")"
  env_before="$(sha256_of "${ok_env}")"

  log "自测 2：幂等重跑（令牌不重生成、文件不变、不重复备份）"
  if out="$(run_install "${root}/main" "${project_main}" 2>&1)"; then
    check "重跑退出码" "0" "0"
  else
    check "重跑退出码" "0" "非零"
    printf '%s\n' "${out}" | tail -25
  fi
  check "令牌未变" "${token_before}" "$(sha256_of "${token_main}")"
  check "compose 未变" "${compose_before}" "$(sha256_of "${main_compose}")"
  check "env 未变" "${env_before}" "$(sha256_of "${ok_env}")"
  check "备份数量未增长" "1" "$(find "${root}/main/.install-backups" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  check_true "重跑输出提示无需改动" "$(printf '%s' "${out}" | grep -q '无改动' && echo 0 || echo 1)"

  log "自测 3：拒绝路径（任一不符必须中止且不改文件）"
  local env_guard compose_guard
  env_guard="$(sha256_of "${ok_env}")"
  compose_guard="$(sha256_of "${main_compose}")"
  if run_install "${root}/main" "no-such-project-${project_main}" >/dev/null 2>&1; then
    check "项目名不符时退出码" "非零" "0"
  else
    check "项目名不符时退出码" "非零" "非零"
  fi
  cp "${ok_env}" "${root}/env.guard"
  {
    grep -v '^FEEDBACK_DATA_VOLUME=' "${root}/env.guard"
    printf 'FEEDBACK_DATA_VOLUME=some-other-volume\n'
  } > "${ok_env}"
  if run_install "${root}/main" "${project_main}" >/dev/null 2>&1; then
    check "数据卷登记冲突时退出码" "非零" "0"
  else
    check "数据卷登记冲突时退出码" "非零" "非零"
  fi
  mv "${root}/env.guard" "${ok_env}"
  if run_install "${root}/alt" "${project_alt}" >/dev/null 2>&1; then
    check "数据目录非 /data 时退出码" "非零" "0"
  else
    check "数据目录非 /data 时退出码" "非零" "非零"
  fi
  check "拒绝路径未改动 env" "${env_guard}" "$(sha256_of "${ok_env}")"
  check "拒绝路径未改动 compose" "${compose_guard}" "$(sha256_of "${main_compose}")"

  log "自测 4：dry-run 不写文件"
  local dry_guard
  dry_guard="$(sha256_of "${main_compose}")"
  if run_install "${root}/main" "${project_main}" --dry-run >/dev/null 2>&1; then
    check "dry-run 退出码" "0" "0"
  else
    check "dry-run 退出码" "0" "非零"
  fi
  check "dry-run 未改动 compose" "${dry_guard}" "$(sha256_of "${main_compose}")"

  printf '\n=== 自测结果：%s 项断言，%s 项失败\n' "${checks}" "${failures}"
  [ "${failures}" = "0" ] || die "自测断言失败，见上方 ✗"
  ok "自测通过（临时目录 ${root}，项目 ${project_main}）"
}

# ---------------------------------------------------------------- 主流程

main() {
  if [ "${SELF_TEST}" = "1" ]; then
    self_test_mode
    return
  fi
  COMPOSE_FILE="${COMPOSE_FILE:-${DEPLOY_DIR}/compose.yml}"
  ENV_FILE="${ENV_FILE:-${DEPLOY_DIR}/.env.prod}"
  BACKUP_ROOT="${BACKUP_ROOT:-${DEPLOY_DIR}/.install-backups}"
  [ "${DRY_RUN}" = "1" ] && info "dry-run：只核对与展示，不写入任何文件"

  preflight
  prepare_control_dir
  plan_changes
  backup_before_write
  commit_changes
  summarize
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-dir) DEPLOY_DIR="${2:?--deploy-dir 需要值}"; shift 2 ;;
    --compose-file) COMPOSE_FILE="${2:?--compose-file 需要值}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file 需要值}"; shift 2 ;;
    --project) PROJECT="${2:?--project 需要值}"; shift 2 ;;
    --service) SERVICE="${2:?--service 需要值}"; shift 2 ;;
    --template) TEMPLATE="${2:?--template 需要值}"; shift 2 ;;
    --backup-root) BACKUP_ROOT="${2:?--backup-root 需要值}"; shift 2 ;;
    --updater-image) UPDATER_IMAGE_ARG="${2:?--updater-image 需要值}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rotate-token) ROTATE_TOKEN=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

main
