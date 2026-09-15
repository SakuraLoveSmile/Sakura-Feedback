#!/usr/bin/env bash
# 真实 Docker 端到端：验证 apps/updater 在真实 docker socket 上跑完六个阶段。
#
# 设计原则：
#   - 只用独立资源：独立 compose 项目名、独立网络、独立数据卷、独立容器名、独立本地 registry 端口。
#   - 绝不触碰既有部署（feedback-service:*、既有卷、/opt/1panel/... 一律不动），退出时清理自己创建的一切。
#   - 被更新的服务是 e2e/stub 里的「feedback 服务替身」：真实 node:sqlite 数据库 + 真实健康检查 + 优雅退出。
#
# 用法：bash apps/updater/e2e/run-local-update.sh
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${E2E_DIR}/../../.." && pwd)"

SUFFIX="$(od -An -N2 -tx1 </dev/urandom | tr -d ' \n')"
PROJECT="feedback-e2e-${SUFFIX}"
NETWORK="feedback-e2e-net-${SUFFIX}"
REGISTRY_CONTAINER="feedback-e2e-registry-${SUFFIX}"
REGISTRY_PORT="$((20000 + RANDOM % 20000))"
REGISTRY_HOST="127.0.0.1:${REGISTRY_PORT}"
STUB_REPO="${REGISTRY_HOST}/feedback-stub-e2e"
OLD_TAG="0.2.1"
NEW_TAG="0.3.0"
OLD_VOLUME="feedback-e2e-old-${SUFFIX}"
UPDATER_CONTAINER="feedback-e2e-updater-${SUFFIX}"
UPDATER_IMAGE="${UPDATER_IMAGE:-sakura-feedback-updater:dev}"
COMMIT="$(printf 'a%.0s' $(seq 1 40))"
# Docker Desktop 的文件共享包含 /private/tmp 与 /tmp，但不一定包含 $TMPDIR（macOS 默认 /var/folders）。
# 部署目录必须能被宿主 daemon 看到，所以固定在共享根下建工作目录。
SHARE_ROOT="/private/tmp"
[ -d "${SHARE_ROOT}" ] || SHARE_ROOT="/tmp"
WORK="$(mktemp -d "${SHARE_ROOT}/feedback-updater-e2e.${SUFFIX}.XXXXXX")"
DEPLOY="${WORK}/deploy"
CONTROL="${DEPLOY}/update-control"
TOKEN="$(od -An -N24 -tx1 </dev/urandom | tr -d ' \n')"
NEW_VOLUME=""
CHECKS=0
FAILURES=0

log() { printf '\n=== %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

check() { # check <描述> <期望> <实际>
  local desc="$1" expected="$2" actual="$3"
  CHECKS=$((CHECKS + 1))
  if [ "${expected}" = "${actual}" ]; then
    printf '  ✓ %s（%s）\n' "${desc}" "${actual}"
  else
    FAILURES=$((FAILURES + 1))
    printf '  ✗ %s：期望「%s」，实际「%s」\n' "${desc}" "${expected}" "${actual}"
  fi
}

check_true() { # check_true <描述> <0|1>
  local desc="$1" result="$2"
  CHECKS=$((CHECKS + 1))
  if [ "${result}" = "0" ]; then
    printf '  ✓ %s\n' "${desc}"
  else
    FAILURES=$((FAILURES + 1))
    printf '  ✗ %s\n' "${desc}"
  fi
}

file_mode() { # 兼容 BSD 与 GNU stat
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

json_get() { # stdin: JSON, $1: 点号路径
  node -e 'const fs=require("fs");const raw=fs.readFileSync(0,"utf8");let value;try{value=JSON.parse(raw)}catch{process.stdout.write("");process.exit(0)}for(const key of process.argv[1].split(".")){value=value?.[key]}process.stdout.write(value===undefined||value===null?"":String(value))' "$1"
}

cleanup() {
  local status=$?
  set +e
  printf '\n=== 清理\n'
  docker rm -f "${UPDATER_CONTAINER}" >/dev/null 2>&1
  if [ -f "${DEPLOY}/compose.yml" ]; then
    docker compose -f "${DEPLOY}/compose.yml" --env-file "${DEPLOY}/.env.prod" -p "${PROJECT}" down --remove-orphans >/dev/null 2>&1
  fi
  docker rm -f "${REGISTRY_CONTAINER}" >/dev/null 2>&1
  docker volume rm -f "${OLD_VOLUME}" >/dev/null 2>&1
  [ -n "${NEW_VOLUME}" ] && docker volume rm -f "${NEW_VOLUME}" >/dev/null 2>&1
  docker network rm "${NETWORK}" >/dev/null 2>&1
  docker rmi -f "${STUB_REPO}:${OLD_TAG}" "${STUB_REPO}:${NEW_TAG}" "feedback-stub-e2e:local" >/dev/null 2>&1
  rm -rf "${WORK}"
  exit "${status}"
}
trap cleanup EXIT

log "0. 前置检查：docker / compose / 执行器镜像"
docker version >/dev/null || { echo "需要可用的 docker"; exit 1; }
docker compose version >/dev/null || { echo "需要 docker compose"; exit 1; }
if ! docker image inspect "${UPDATER_IMAGE}" >/dev/null 2>&1; then
  info "构建执行器镜像 ${UPDATER_IMAGE}"
  docker build -f "${REPO_ROOT}/apps/updater/Dockerfile" -t "${UPDATER_IMAGE}" "${REPO_ROOT}" >/dev/null
fi
info "执行器镜像：${UPDATER_IMAGE}"
info "工作目录：${WORK}（项目 ${PROJECT}，网络 ${NETWORK}）"

log "1. 准备部署目录与 600 权限共享令牌"
mkdir -p "${CONTROL}/state"
printf '%s\n' "${TOKEN}" > "${CONTROL}/updater-token"
chmod 600 "${CONTROL}/updater-token"
chmod 700 "${WORK}" "${DEPLOY}" "${CONTROL}"
check "令牌文件权限" "600" "$(file_mode "${CONTROL}/updater-token")"

log "2. 起独立本地 registry（宿主回环端口，仅用于推送/拉取测试镜像）"
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${REGISTRY_CONTAINER}" -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS "http://${REGISTRY_HOST}/v2/" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://${REGISTRY_HOST}/v2/" >/dev/null || { echo "本地 registry 未就绪"; exit 1; }
info "registry: http://${REGISTRY_HOST}"

log "3. 构建并推送两版「feedback 替身」镜像"
docker build \
  --build-arg "VERSION=${OLD_TAG}" --build-arg "COMMIT=${COMMIT}" \
  -t "${STUB_REPO}:${OLD_TAG}" "${E2E_DIR}/stub" >/dev/null
docker build \
  --build-arg "VERSION=${NEW_TAG}" --build-arg "COMMIT=${COMMIT}" \
  -t "${STUB_REPO}:${NEW_TAG}" "${E2E_DIR}/stub" >/dev/null
docker push "${STUB_REPO}:${OLD_TAG}" >/dev/null
docker push "${STUB_REPO}:${NEW_TAG}" >/dev/null
digest_of() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" \
    | grep -m1 "^${STUB_REPO}@" | sed 's/.*@//'
}
OLD_DIGEST="$(digest_of "${STUB_REPO}:${OLD_TAG}")"
NEW_DIGEST="$(digest_of "${STUB_REPO}:${NEW_TAG}")"
[ -n "${OLD_DIGEST}" ] && [ -n "${NEW_DIGEST}" ] || { echo "未能取到镜像 digest"; exit 1; }
info "旧版 digest：${OLD_DIGEST}"
info "新版 digest：${NEW_DIGEST}"
check_true "新版 digest 与旧版不同" "$([ "${OLD_DIGEST}" != "${NEW_DIGEST}" ] && echo 0 || echo 1)"

log "4. 造出带真实数据的数据卷（旧卷 = 本轮更新前的生产数据）"
docker volume create "${OLD_VOLUME}" >/dev/null
docker run -d --name "feedback-e2e-seed-${SUFFIX}" \
  -v "${OLD_VOLUME}:/data" -e APP_VERSION="${OLD_TAG}" "${STUB_REPO}@${OLD_DIGEST}" >/dev/null
seed_ready=1
for _ in $(seq 1 30); do
  if docker exec "feedback-e2e-seed-${SUFFIX}" node -e 'fetch("http://127.0.0.1:8787/healthz").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    seed_ready=0
    break
  fi
  sleep 1
done
check_true "旧版容器健康（真实 docker run）" "${seed_ready}"
SEED_COUNTS="$(docker exec "feedback-e2e-seed-${SUFFIX}" node -e 'fetch("http://127.0.0.1:8787/version").then(async (r)=>process.stdout.write(await r.text())).catch(()=>process.exit(1))')"
info "旧卷数据：${SEED_COUNTS}"
docker stop "feedback-e2e-seed-${SUFFIX}" >/dev/null
docker rm "feedback-e2e-seed-${SUFFIX}" >/dev/null
check "旧卷 users" "2" "$(printf '%s' "${SEED_COUNTS}" | json_get counts.users)"
check "旧卷 feedbacks" "5" "$(printf '%s' "${SEED_COUNTS}" | json_get counts.feedbacks)"
check "旧卷 schema 版本" "3" "$(printf '%s' "${SEED_COUNTS}" | json_get counts.userVersion)"

log "5. 写部署文件（compose / .env.prod / 版本清单）"
cat > "${DEPLOY}/compose.yml" <<EOF
services:
  feedback:
    image: \${FEEDBACK_IMAGE}
    env_file:
      - .env.prod
    environment:
      FEEDBACK_DATA_DIR: /data
      FEEDBACK_PORT: "8787"
      FEEDBACK_UPDATE_CONTROL_DIR: /update-control
    volumes:
      # 注意：service 引用的是卷的 key，key 的真实名字由 FEEDBACK_DATA_VOLUME 决定；
      # 执行器只改环境文件里的这个变量，compose 就会把服务挂到新的数据卷上。
      - feedback-data:/data
      - ./update-control:/update-control:ro
    stop_grace_period: 30s
    restart: "no"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8787/healthz"]
      interval: 1s
      timeout: 2s
      retries: 20
      start_period: 1s
    networks:
      - e2e
networks:
  e2e:
    external: true
    name: ${NETWORK}
volumes:
  feedback-data:
    external: true
    name: \${FEEDBACK_DATA_VOLUME}
EOF
cat > "${DEPLOY}/.env.prod" <<EOF
# e2e 部署环境文件：注释与顺序必须被执行器原样保留
FEEDBACK_MASTER_KEY=e2e-master-key-0123456789abcdef
FEEDBACK_ADMIN_USER=admin
FEEDBACK_IMAGE=${STUB_REPO}@${OLD_DIGEST}
FEEDBACK_DATA_VOLUME=${OLD_VOLUME}
FEEDBACK_COOKIE_SECURE=false
EOF
chmod 600 "${DEPLOY}/.env.prod"
cat > "${DEPLOY}/release-manifest.json" <<EOF
{
  "manifestVersion": 1,
  "version": "${NEW_TAG}",
  "commit": "${COMMIT}",
  "tag": "v${NEW_TAG}",
  "channel": "stable",
  "services": {
    "feedback": { "image": "${STUB_REPO}@${NEW_DIGEST}", "digest": "${NEW_DIGEST}" },
    "updater": { "image": "ghcr.io/sakuralovesmile/sakura-feedback-updater", "digest": "${NEW_DIGEST}" }
  },
  "platform": "linux/amd64",
  "dbSchemaVersion": 3,
  "requiredUpdaterProtocol": 1,
  "publishedAt": "2026-09-14T00:00:00Z"
}
EOF
info "清单：${DEPLOY}/release-manifest.json"

log "6. 用 compose 起旧版服务（真实项目名/网络/外部卷）"
docker compose -f "${DEPLOY}/compose.yml" --env-file "${DEPLOY}/.env.prod" -p "${PROJECT}" up -d feedback >/dev/null
service_healthy=1
for _ in $(seq 1 60); do
  state="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=feedback" --format '{{.Status}}')"
  case "${state}" in *"healthy"*) service_healthy=0; break ;; esac
  sleep 1
done
check_true "compose 起的旧版服务健康" "${service_healthy}"
OLD_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=feedback")"
info "旧版容器：${OLD_CONTAINER:0:12}"

log "7. 起执行器容器（挂 docker socket 与部署目录，不发布端口）"
docker run -d --name "${UPDATER_CONTAINER}" \
  --network "${NETWORK}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${DEPLOY}:${DEPLOY}" \
  -e "UPDATER_IMAGE_NAME=${STUB_REPO}" \
  -e "UPDATER_DEPLOY_DIR=${DEPLOY}" \
  -e "UPDATER_CONTROL_DIR=${CONTROL}" \
  -e "UPDATER_STATE_DIR=${CONTROL}/state" \
  -e "UPDATER_TOKEN_FILE=${CONTROL}/updater-token" \
  -e "UPDATER_COMPOSE_FILE=${DEPLOY}/compose.yml" \
  -e "UPDATER_COMPOSE_PROJECT=${PROJECT}" \
  -e "UPDATER_SERVICE=feedback" \
  -e "UPDATER_LISTEN=0.0.0.0:8790" \
  "${UPDATER_IMAGE}" >/dev/null
updater_ready=1
for _ in $(seq 1 30); do
  if docker exec "${UPDATER_CONTAINER}" node -e 'fetch("http://127.0.0.1:8790/healthz").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    updater_ready=0
    break
  fi
  sleep 1
done
check_true "执行器容器 /healthz 就绪" "${updater_ready}"
if [ "${updater_ready}" != "0" ]; then
  docker logs "${UPDATER_CONTAINER}" 2>&1 | tail -20
  exit 1
fi
check "执行器容器没有发布端口" "" "$(docker port "${UPDATER_CONTAINER}" || true)"

# 容器内的 HTTP 客户端：令牌只从挂载的 600 文件读取，不进命令行、不进日志
cat > "${DEPLOY}/e2e-http-client.mjs" <<'EOF'
import { readFileSync } from "node:fs";

const [method, requestPath, body] = process.argv.slice(2);
const token = readFileSync(process.env.E2E_TOKEN_PATH, "utf8").trim();
const response = await fetch(`http://127.0.0.1:8790${requestPath}`, {
  method,
  headers: { "x-updater-token": token, "content-type": "application/json" },
  body: body ? body : undefined,
});
const text = await response.text();
process.stdout.write(`${response.status} ${text}`);
EOF
http_call() { # http_call <method> <path> [body]
  local method="$1" request_path="$2" body="${3:-}"
  docker exec -e "E2E_TOKEN_PATH=${CONTROL}/updater-token" "${UPDATER_CONTAINER}" \
    node "${DEPLOY}/e2e-http-client.mjs" "${method}" "${request_path}" "${body}"
}

log "8. 鉴权检查：无令牌必须 401"
unauthorized="$(docker exec "${UPDATER_CONTAINER}" node -e 'fetch("http://127.0.0.1:8790/manifest?channel=stable").then((r)=>process.stdout.write(String(r.status)))')"
check "无令牌访问 /manifest" "401" "${unauthorized}"
bad_token="$(docker exec "${UPDATER_CONTAINER}" node -e 'fetch("http://127.0.0.1:8790/manifest?channel=stable",{headers:{"x-updater-token":"wrong-token-1234567890"}}).then((r)=>process.stdout.write(String(r.status)))')"
check "错误令牌访问 /manifest" "401" "${bad_token}"
foreign_field="$(http_call POST /tasks '{"requestId":"e2e-bad","version":"0.3.0","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","composeFile":"/etc/passwd"}')"
check "提交 compose 路径被拒" "400" "$(printf '%s' "${foreign_field}" | cut -d' ' -f1)"
check_true "拒绝原因可读" "$(printf '%s' "${foreign_field}" | grep -q 'invalid_request' && echo 0 || echo 1)"

log "8.5 真实拒绝路径：清单协议不兼容必须 409 且不动服务"
cp "${DEPLOY}/release-manifest.json" "${WORK}/release-manifest.good.json"
node -e 'const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));m.requiredUpdaterProtocol=99;fs.writeFileSync(p,JSON.stringify(m,null,2))' "${DEPLOY}/release-manifest.json"
incompatible="$(http_call POST /tasks "{\"requestId\":\"e2e-incompatible-${SUFFIX}\",\"version\":\"${NEW_TAG}\",\"digest\":\"${NEW_DIGEST}\"}")"
check "协议不兼容时状态码" "409" "$(printf '%s' "${incompatible}" | cut -d' ' -f1)"
check_true "给出执行器升级指引" "$(printf '%s' "${incompatible}" | grep -q '更新执行器协议 v99' && echo 0 || echo 1)"
check_true "协议不兼容时不产生任务" "$([ "$(ls "${CONTROL}/state/tasks" | wc -l | tr -d ' ')" = "0" ] && echo 0 || echo 1)"
check_true "协议不兼容时服务未被动过" "$(docker ps -q --filter "id=${OLD_CONTAINER}" | grep -q . && echo 0 || echo 1)"
cp "${WORK}/release-manifest.good.json" "${DEPLOY}/release-manifest.json"

log "8.6 真实失败路径：digest 与清单不一致 → failed_no_changes，旧服务继续运行"
bad="$(http_call POST /tasks "{\"requestId\":\"e2e-mismatch-${SUFFIX}\",\"version\":\"${NEW_TAG}\",\"digest\":\"sha256:0000000000000000000000000000000000000000000000000000000000000000\"}")"
check "不一致任务已受理" "202" "$(printf '%s' "${bad}" | cut -d' ' -f1)"
bad_id="$(printf '%s' "${bad}" | cut -d' ' -f2- | json_get operationId)"
bad_status="running"
bad_json=""
for _ in $(seq 1 60); do
  bad_body="$(http_call GET "/tasks/${bad_id}")"
  bad_json="$(printf '%s' "${bad_body}" | cut -d' ' -f2-)"
  bad_status="$(printf '%s' "${bad_json}" | json_get status)"
  case "${bad_status}" in failed|needs_attention|succeeded) break ;; esac
  sleep 1
done
check "不一致任务终态" "failed" "${bad_status}"
check "不一致任务分类（未改动部署）" "failed_no_changes" "$(printf '%s' "${bad_json}" | json_get outcome)"
check "不一致任务失败原因" "digest_mismatch" "$(printf '%s' "${bad_json}" | json_get failure.code)"
check_true "失败后旧服务仍在运行" "$(docker ps -q --filter "id=${OLD_CONTAINER}" | grep -q . && echo 0 || echo 1)"
check_true "失败后没有暂停标记" "$([ ! -e "${CONTROL}/paused" ] && echo 0 || echo 1)"
check_true "失败后没有创建新数据卷" "$(docker volume ls --format '{{.Name}}' | grep -q "^feedback-data-${NEW_TAG}-" && echo 1 || echo 0)"
check_true "失败后没有放行标记" "$([ ! -e "${CONTROL}/release" ] && echo 0 || echo 1)"

log "9. 提交真实更新任务（HTTP 202 + 后台六阶段）"
created="$(http_call POST /tasks "{\"requestId\":\"e2e-${SUFFIX}\",\"version\":\"${NEW_TAG}\",\"digest\":\"${NEW_DIGEST}\"}")"
info "POST /tasks → ${created}"
check "受理状态码" "202" "$(printf '%s' "${created}" | cut -d' ' -f1)"
OPERATION_ID="$(printf '%s' "${created}" | cut -d' ' -f2- | json_get operationId)"
[ -n "${OPERATION_ID}" ] || { echo "没有拿到 operationId"; exit 1; }
info "operationId：${OPERATION_ID}"

duplicated="$(http_call POST /tasks "{\"requestId\":\"e2e-${SUFFIX}\",\"version\":\"${NEW_TAG}\",\"digest\":\"${NEW_DIGEST}\"}")"
check "同 requestId 重发返回原任务" "${OPERATION_ID}" "$(printf '%s' "${duplicated}" | cut -d' ' -f2- | json_get operationId)"

task_status="running"
task_body=""
for _ in $(seq 1 180); do
  task_body="$(http_call GET "/tasks/${OPERATION_ID}")"
  task_status="$(printf '%s' "${task_body}" | cut -d' ' -f2- | json_get status)"
  case "${task_status}" in
    succeeded|failed|needs_attention) break ;;
  esac
  sleep 2
done
task_json="$(printf '%s' "${task_body}" | cut -d' ' -f2-)"
info "最终任务：$(printf '%s' "${task_json}" | json_get status) / $(printf '%s' "${task_json}" | json_get outcome) / $(printf '%s' "${task_json}" | json_get phaseLabel)"
info "消息：$(printf '%s' "${task_json}" | json_get message)"
[ "${FAILURES}" = "0" ] || { printf '%s\n' "${task_json}"; }

log "10. 断言六阶段结果"
check "任务终态" "succeeded" "${task_status}"
check "结果分类" "succeeded" "$(printf '%s' "${task_json}" | json_get outcome)"
NEW_VOLUME="$(printf '%s' "${task_json}" | json_get newVolume)"
info "新数据卷：${NEW_VOLUME}"

for phase in preflight_pull pause_stop backup_copy start_paused verify_new release; do
  check_true "证据链包含阶段 ${phase}" "$(printf '%s' "${task_json}" | grep -q "\"${phase}\"" && echo 0 || echo 1)"
done
check_true "证据链无失败步骤" "$(printf '%s' "${task_json}" | grep -q '"ok": false' && echo 1 || echo 0)"

NEW_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=feedback")"
[ -n "${NEW_CONTAINER}" ] || { echo "更新后没有运行中的 feedback 容器"; exit 1; }
NEW_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${NEW_CONTAINER}")"
RUNNING_DIGEST="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${NEW_IMAGE_ID}" | grep -m1 "^${STUB_REPO}@" | sed 's/.*@//')"
check "运行中的镜像 digest = 清单新版 digest" "${NEW_DIGEST}" "${RUNNING_DIGEST}"
check_true "运行中的服务换了新容器（旧容器已被 force-recreate 替换）" "$([ "${NEW_CONTAINER}" != "${OLD_CONTAINER}" ] && echo 0 || echo 1)"

RUNNING_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "${NEW_CONTAINER}")"
check "运行中的服务挂载新数据卷" "${NEW_VOLUME}" "${RUNNING_VOLUME}"
RUNNING_VERSION="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "${NEW_IMAGE_ID}")"
check "运行中的镜像版本标签" "${NEW_TAG}" "${RUNNING_VERSION}"

log "11. 断言数据保留与旧资源保留"
after_counts="$(docker exec -i "${NEW_CONTAINER}" node --input-type=module - <<'EOF'
const response = await fetch("http://127.0.0.1:8787/version");
process.stdout.write(await response.text());
EOF
)"
info "新版数据：${after_counts}"
check "新版 users 保留" "2" "$(printf '%s' "${after_counts}" | json_get counts.users)"
check "新版 feedbacks 保留" "5" "$(printf '%s' "${after_counts}" | json_get counts.feedbacks)"
check "新版 feedback_screenshots 保留" "3" "$(printf '%s' "${after_counts}" | json_get counts.feedback_screenshots)"
check "新版 daily_usage 保留" "7" "$(printf '%s' "${after_counts}" | json_get counts.daily_usage)"
check "新版 schema 版本" "3" "$(printf '%s' "${after_counts}" | json_get counts.userVersion)"

check_true "旧数据卷仍在（未删除）" "$(docker volume inspect "${OLD_VOLUME}" >/dev/null 2>&1 && echo 0 || echo 1)"
check_true "旧镜像仍在（未删除）" "$(docker image inspect "${STUB_REPO}@${OLD_DIGEST}" >/dev/null 2>&1 && echo 0 || echo 1)"
check_true "旧版容器已被替换（没有重名残留）" "$(docker ps -a --filter "id=${OLD_CONTAINER}" --format '{{.ID}}' | grep -q . && echo 1 || echo 0)"

# 旧卷挂 rw 才能用只读连接打开 WAL 数据库（SQLite 需要在同目录创建 -shm）；
# 数据库文件本身只被读取，不会被改写。
old_data_ok=1
if docker run --rm -v "${OLD_VOLUME}:/data" --entrypoint node "${STUB_REPO}@${OLD_DIGEST}" -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/feedback.db",{readOnly:true});const r=d.prepare("SELECT COUNT(*) c FROM feedbacks").get().c;const u=d.prepare("PRAGMA user_version").get().user_version;process.exit(r===5&&u===3?0:1)' >/dev/null 2>&1; then
  old_data_ok=0
fi
check_true "旧卷数据仍可读且完整（feedbacks=5, schema=3）" "${old_data_ok}"

log "12. 断言控制文件语义"
check_true "paused 标记已解除" "$([ ! -e "${CONTROL}/paused" ] && echo 0 || echo 1)"
check_true "release 标记已落盘且指向新版本" "$(grep -q "\"version\": \"${NEW_TAG}\"" "${CONTROL}/release" && echo 0 || echo 1)"
check_true "任务状态文件已终态落盘" "$(grep -q '"status": "succeeded"' "${CONTROL}/state/tasks/${OPERATION_ID}.json" && echo 0 || echo 1)"
check_true "备份目录含受限副本（600）" "$([ "$(file_mode "${CONTROL}/state/backups/${OPERATION_ID}/.env.prod")" = "600" ] && echo 0 || echo 1)"
check_true "环境文件保留其它字段（主密钥未变）" "$(grep -q '^FEEDBACK_MASTER_KEY=e2e-master-key-0123456789abcdef$' "${DEPLOY}/.env.prod" && echo 0 || echo 1)"
check_true "环境文件已切到新镜像与新卷" "$(grep -q "^FEEDBACK_IMAGE=${STUB_REPO}@${NEW_DIGEST}$" "${DEPLOY}/.env.prod" && grep -q "^FEEDBACK_DATA_VOLUME=${NEW_VOLUME}$" "${DEPLOY}/.env.prod" && echo 0 || echo 1)"

log "13. 断言执行器日志不含共享令牌"
if docker logs "${UPDATER_CONTAINER}" 2>&1 | grep -q "${TOKEN}"; then
  check_true "日志不含令牌" 1
else
  check_true "日志不含令牌" 0
fi
info "执行器日志片段："
docker logs "${UPDATER_CONTAINER}" 2>&1 | tail -6 | sed 's/^/    /'

printf '\n=== 结果：%s 项断言，%s 项失败\n' "${CHECKS}" "${FAILURES}"
[ "${FAILURES}" = "0" ] || exit 1
printf '真实更新流程验证通过（项目 %s，operationId %s）\n' "${PROJECT}" "${OPERATION_ID}"
