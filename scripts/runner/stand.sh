#!/usr/bin/env bash
# Серверная половина `scripts/remote-run.sh stand …` (T-183, ADR-0009): dev-стенд ветки на раннере.
#   stand.sh up|down|logs|status <ветка> <sha> [--wipe | сервис…]
# Стенд ветки — тот же deploy/stand/compose.yml, что на маке, со своими именами и портом:
#   каталог /opt/w1-gate/stand/<проект>, compose-проект и образы — w1-<ветка>, web — 127.0.0.1:45810…45829
#   (45810 — стенд из main, остальным — первый свободный, закрепляется за веткой в stand/ports).
# Хранилище — fs (ключей бакета на раннере нет, ADR-0002), ML — из контейнера на CPU. Все контейнеры и сборка — на
# ядрах раннера (/opt/w1-gate/cpus): сервер общий с разбором T-165, его GPU и /opt/inspector не трогаются.
# Сборка — buildx с драйвером docker-container на тех же ядрах с пониженной долей CPU; очередь — полоса stand
# (/opt/w1-gate/lock.stand, та же, что у remote-run.sh --lane stand), мутации её не держат.
set -euo pipefail
R=${W1_ROOT:-/opt/w1-gate}
action=${1:?up|down|logs|status}; branch=${2:?ветка}; sha=${3:-}; shift 3 || shift $#
gpu_image=""
if [ "${1:-}" = --gpu-pilot ]; then
  [ "$action" = up ] && [ "$branch" = feat/resource-ocr-incremental ] || { echo 'GPU pilot is restricted to the resource-ocr branch'; exit 64; }
  gpu_image=${2:?immutable GPU image ID}; shift 2
  [[ "$gpu_image" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 64
fi
if [ "$action" = up ] && [ "$#" -gt 0 ]; then
  echo 'runner-stand: unsupported up arguments; GPU deployment requires --gpu-pilot <immutable image ID>' >&2
  exit 64
fi
export PATH="$R/tools/bin:$PATH" DOCKER_CONFIG="$R/tools/docker"   # compose и buildx — плагины в своём каталоге
cpus=$(cat "$R/cpus" 2>/dev/null || echo 24-31)
stand_lane=stand
builder=w1
builder_shares=256
build_cpus=$cpus
if [ -n "$gpu_image" ]; then
  # Codex priority profile: model group and builder use different P-cores.
  cpus=0-7
  build_cpus=8-15
  stand_lane=resource-ocr-stand
  builder=resource-ocr
  builder_shares=1024
fi

# имя проекта compose и образов: строчные латиница, цифры и «-»
proj="w1-$(printf '%s' "$branch" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
S="$R/stand/$proj"; SRC="$S/src"; VAR="$S/var"
mkdir -p "$R/stand"
say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { echo "runner-stand: $*" >&2; exit 1; }

# порт web: main — 45810, остальным — первый свободный из 45811–45829, закреплённый за веткой
port_of() {
  local reg="$R/stand/ports" p
  touch "$reg"
  p=$(awk -v n="$proj" '$1 == n {print $2}' "$reg")
  if [ -z "$p" ]; then
    if [ "$branch" = main ]; then p=45810
    else
      for c in $(seq 45811 45829); do awk -v c="$c" '$2 == c {f=1} END {exit !f}' "$reg" || { p=$c; break; }; done
      [ -n "$p" ] || die "свободных портов 45811–45829 нет: освободите стенд другой ветки (stand down --forget)"
    fi
    echo "$proj $p" >> "$reg"
  fi
  echo "$p"
}

compose() {
  local extra=()
  [ ! -f "$S/gpu-override.yml" ] || extra=(-f "$S/gpu-override.yml")
  docker compose -p "$proj" --project-directory "$SRC/deploy/stand" -f "$SRC/deploy/stand/compose.yml" -f "$S/override.yml" \
    "${extra[@]}" \
    --env-file "$VAR/stand.env" "$@"
}

# GPU pilot: immutable code release over pinned dependencies; own PostgreSQL/Rabbit/blobs/Redis.
write_gpu_override() {
  local port=$1 ml_port=$((port + 2000)) proxy_port=$((port + 2100)) proxy_identity node_policy_env="" node_policy_mounts="" node_cgroup_parent=""
  mkdir -p "$VAR/pipeline-cache"
  chown 10001:10001 "$VAR/pipeline-cache"; chmod 700 "$VAR/pipeline-cache"
  # Bootstrap once. Loss of an existing journal never silently creates an empty safe one.
  if [ ! -f "$VAR/execution-proxy.identity" ]; then
    [ ! -e "$VAR/pipeline-cache/external-executions" ] || die 'proxy identity missing for existing journal'
    cat /proc/sys/kernel/random/uuid > "$VAR/execution-proxy.identity"
    proxy_identity=$(cat "$VAR/execution-proxy.identity")
    docker run --rm --pull=never --network none --user 10001:10001 --read-only \
      --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --memory-swap 512m \
      --entrypoint python --workdir /app/ml \
      -v "$VAR/pipeline-cache:/pipeline-cache" \
      -e INSPECTOR_EXECUTION_PROXY_ROOT=/pipeline-cache/external-executions \
      -e "INSPECTOR_EXECUTION_PROXY_IDENTITY=$proxy_identity" \
      "$gpu_image" -m inspector_ml.execution_proxy --initialize
  fi
  proxy_identity=$(cat "$VAR/execution-proxy.identity")
  [ -f "$VAR/pipeline-cache/external-executions/identity.json" ] || die 'proxy journal missing; refusing unsafe reinitialization'
  if [ ! -f "$VAR/local-execution.identity" ]; then
    [ ! -e "$VAR/pipeline-cache/executions-v2" ] || die 'local identity missing for existing journal'
    cat /proc/sys/kernel/random/uuid > "$VAR/local-execution.identity"
    docker run --rm --pull=never --network none --user 10001:10001 --read-only \
      --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --memory-swap 512m \
      --entrypoint python --workdir /app/ml \
      -v "$VAR/pipeline-cache:/pipeline-cache" \
      -e INSPECTOR_PIPELINE_EXECUTIONS_DIR=/pipeline-cache/executions-v2 \
      -e "INSPECTOR_PIPELINE_JOURNAL_IDENTITY=$(cat "$VAR/local-execution.identity")" \
      "$gpu_image" -m inspector_ml.pipeline_execution --initialize
  fi
  [ -f "$VAR/pipeline-cache/executions-v2/identity.json" ] || die 'local execution journal missing; refusing unsafe reinitialization'

  if [ -f "$VAR/node-policy.json" ]; then
    systemctl is-active --quiet resource-ocr-reader-lifecycle.service || die 'node policy requires live Reader lifecycle helper'
    # Keep hierarchical OOM counters alive when Docker recreates the ML cgroup.
    # Only this stand ML container belongs to this parent; do not reset it.
    systemctl start w1resourceocr.slice
    node_cgroup_parent='    cgroup_parent: w1resourceocr.slice'
    if [ ! -e "$VAR/pipeline-cache/node-admission-v1" ]; then
      [ ! -e "$VAR/node-admission.initialized" ] || die 'node journal lost; refusing unsafe reinitialization'
      docker run --rm --pull=never --network none --user 10001:10001 --read-only \
        --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --memory-swap 512m \
        --entrypoint python --workdir /app/ml \
        -v "$VAR/pipeline-cache:/pipeline-cache" \
        -v "$VAR/node-policy.json:/run/node-policy.json:ro" \
        "$gpu_image" -m inspector_ml.node_supervisor provision /run/node-policy.json
      touch "$VAR/node-admission.initialized"
    fi
    [ -f "$VAR/pipeline-cache/node-admission-v1/identity.json" ] || die 'node journal identity missing'
    node_policy_env='      INSPECTOR_NODE_POLICY: /run/node-policy.json
      INSPECTOR_NODE_OOM_CGROUP: /node-oom-parent'
    node_policy_mounts="      - $VAR/node-policy.json:/run/node-policy.json:ro
      - /proc:/host-proc:ro
      - /sys/fs/cgroup/w1resourceocr.slice:/node-oom-parent:ro
      - /opt/resource-ocr/node-agent/control:/reader-control:ro"
  fi


  cat > "$S/gpu-override.yml" <<EOF
services:
  api:
    cpus: 2
    mem_limit: 2g
    extra_hosts: ["ml:host-gateway"]
    environment:
      INSPECTOR_PIPELINE_ROUTE: staged-v1
      INSPECTOR_PIPELINE_EXECUTION: durable
      INSPECTOR_PIPELINE_POLICY: regional-v1
      INSPECTOR_PARSE_CONCURRENCY: "1"
      INSPECTOR_ML_URL: https://ml:$ml_port
      INSPECTOR_SHEET_DIFF_AUTO: "0"
  ml:
    image: $gpu_image
$node_cgroup_parent
    networks: !reset []
    network_mode: host
    gpus: all
    cpus: 4
    mem_limit: 6g
    memswap_limit: 6g
    environment:
      HOST: 172.17.0.1
      PORT: "$ml_port"
      INSPECTOR_REVISION: "$sha"
      INSPECTOR_PROFILE: gpu
      INSPECTOR_ML_WORKERS: "1"
$node_policy_env
      INSPECTOR_OCR_WORKERS: "1"
      INSPECTOR_RENDER_PROCS: "0"
      INSPECTOR_PPOCR_GPU_MB: "1536"
      INSPECTOR_PPOCR_DET_FLOOR: "960"
      INSPECTOR_PPOCR_REC_BATCH: "8"
      INSPECTOR_VL_INFLIGHT: "4"
      INSPECTOR_VLM_BACKEND: openai
      INSPECTOR_VLM_READER: PaddlePaddle/PaddleOCR-VL-1.5
      INSPECTOR_VLM_URL: http://127.0.0.1:8000/v1
      INSPECTOR_JUDGE_PHASE: "off"
      INSPECTOR_CACHE: redis
      INSPECTOR_REDIS_URL: unix:///pipeline-cache/redis.sock
      INSPECTOR_PIPELINE_EXECUTIONS_DIR: /pipeline-cache/executions-v2
      INSPECTOR_PIPELINE_JOURNAL_IDENTITY: $(cat "$VAR/local-execution.identity")
      INSPECTOR_EXECUTION_PROXY_URL: http://127.0.0.1:$proxy_port
      INSPECTOR_EXECUTION_PROXY_NAMESPACE: $proj
      INSPECTOR_EXECUTION_PROXY_IDENTITY: $proxy_identity
      HF_HUB_OFFLINE: "1"
      TRANSFORMERS_OFFLINE: "1"
    volumes:
      - $VAR/pipeline-cache:/pipeline-cache
$node_policy_mounts
    healthcheck:
      test: ["CMD", "python", "-c", "import ssl,urllib.request as u;c=ssl.create_default_context(cafile='/run/tls/ca.crt');c.check_hostname=False;u.urlopen('https://172.17.0.1:$ml_port/health',context=c,timeout=6)"]
    depends_on:
      pipeline-redis: {condition: service_healthy}
      execution-proxy: {condition: service_healthy}
  execution-proxy:
    image: $gpu_image
    entrypoint: ["python", "-m", "uvicorn"]
    command: ["inspector_ml.execution_proxy:build_from_env", "--factory", "--host", "127.0.0.1", "--port", "$proxy_port", "--no-access-log"]
    working_dir: /app/ml
    network_mode: host
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    cpus: 1
    mem_limit: 512m
    memswap_limit: 512m
    pids_limit: 64
    environment:
      INSPECTOR_EXECUTION_PROXY_ROOT: /pipeline-cache/external-executions
      INSPECTOR_EXECUTION_PROXY_IDENTITY: $proxy_identity
      INSPECTOR_EXECUTION_PROXY_NAMESPACE: $proj
      INSPECTOR_EXECUTION_PROXY_UPSTREAM: http://127.0.0.1:8000/v1/chat/completions
      INSPECTOR_REDIS_URL: unix:///pipeline-cache/redis.sock
    volumes:
      - $VAR/pipeline-cache:/pipeline-cache
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:$proxy_port/health',timeout=3)"]
      interval: 5s
      timeout: 4s
      retries: 12
    depends_on:
      pipeline-redis: {condition: service_healthy}
  pipeline-redis:
    image: sha256:0b2b77d3ea5078274795e3177cdbdada8b96316684a38911d528534ed679b5ec
    network_mode: none
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    cpus: 0.25
    mem_limit: 1536m
    memswap_limit: 1536m
    pids_limit: 32
    command: ["redis-server", "--port", "0", "--unixsocket", "/pipeline-cache/redis.sock", "--unixsocketperm", "700", "--save", "", "--appendonly", "no", "--dir", "/pipeline-cache", "--maxmemory", "1024mb", "--maxmemory-policy", "noeviction"]
    volumes: ["$VAR/pipeline-cache:/pipeline-cache"]
    healthcheck:
      test: ["CMD", "redis-cli", "-s", "/pipeline-cache/redis.sock", "ping"]
      interval: 5s
      timeout: 3s
      retries: 12
EOF
}

gpu_admission() {
  [ -n "$gpu_image" ] || return 0
  # Read-only check of shared consumers; no stop/restart/flush on the working stand.
  mkdir -p /opt/resource-ocr
  exec 7>/opt/resource-ocr/gpu.lock
  flock -n 7 || die 'another resource-ocr experiment owns GPU admission'
  [ "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 10485760 ] || die 'GPU pilot needs 10 GiB available RAM'
  [ "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)" -ge 4096 ] || die 'GPU pilot needs 4 GiB free VRAM'
  docker exec nadzorium-gpu-rabbitmq-1 rabbitmqctl -q list_queues messages_ready messages_unacknowledged |
    awk 'NR>1 && ($1 != 0 || $2 != 0) {bad=1} END {exit bad}' || die 'working stand has queued processing'
  curl -fsS --max-time 5 http://127.0.0.1:8000/metrics |
    awk '/^vllm:num_requests_running\{/ {r=1; busy+=$NF} /^vllm:num_requests_waiting\{/ {w=1; busy+=$NF} END {exit !(r && w && busy==0)}' || die 'shared Reader is busy'
}

# Linux не маскирует права, как Docker Desktop на маке: stand.sh пишет секреты и ключи 600 от root, а сервисы идут
# под своими uid. Ключ TLS — владельцу-сервису (600); секреты — группе стенда (640), в которую контейнеры входят через
# group_add. Прочим пользователям хоста — по-прежнему ничего.
STAND_GID=4183
fix_perms() {
  local pair svc uid
  # каталог стенда — только root (dockerd монтирует от root): группа 4183 открывает секреты контейнерам, а не хосту
  chmod 700 "$S"
  chgrp -R "$STAND_GID" "$VAR/secrets" "$VAR/rabbitmq-auth.conf"
  find "$VAR/secrets" -type d -exec chmod 750 {} +
  find "$VAR/secrets" -type f -exec chmod 640 {} +
  chmod 640 "$VAR/rabbitmq-auth.conf"
  for pair in postgres:70 api:1000 ml:10001 rabbitmq:100 web:101 minio:1000; do
    svc=${pair%%:*}; uid=${pair#*:}
    for k in "$VAR/tls/$svc/server.key" "$VAR/tls/$svc/private.key"; do [ -f "$k" ] && chown "$uid" "$k" && chmod 600 "$k"; done
  done
}

# оверлей стенда ветки: порт web, ядра раннера и группа секретов у каждого сервиса
write_override() {
  local port=$1 s
  { echo "# генерирует scripts/runner/stand.sh (T-183) — не править руками"
    echo "services:"
    for s in $(docker compose -p "$proj" --project-directory "$SRC/deploy/stand" -f "$SRC/deploy/stand/compose.yml" --env-file "$VAR/stand.env" config --services); do
      echo "  $s:"
      echo "    cpuset: \"$cpus\""
      echo "    group_add: [\"$STAND_GID\"]"
      [ "$s" = web ] && echo "    ports: !override [\"127.0.0.1:$port:8443\"]"
    done
  } > "$S/override.yml"
}

write_env() {
  { grep -E '^[A-Z_]+_IMAGE=' "$SRC/deploy/stand/images.env"
    echo "API_IMAGE=$(docker image inspect "$proj-api:$sha" --format '{{.Id}}')"
    echo "ML_IMAGE=$(docker image inspect "$proj-ml:$sha" --format '{{.Id}}')"
    echo "WEB_IMAGE=$(docker image inspect "$proj-web:$sha" --format '{{.Id}}')"
    echo "STAND_VAR=$VAR"
    echo "S3_SECRETS_DIR=$VAR/secrets/s3-minio"
    echo "STAND_REVISION=$sha"
  } > "$VAR/stand.env"
}

build_gpu_release() {
  local base_id="$gpu_image" base_tag="$proj-dependencies:${gpu_image#sha256:}"
  docker tag "$base_id" "$base_tag"
  [ "$(docker image inspect "$base_tag" --format '{{.Id}}')" = "$base_id" ] || die 'GPU dependency identity mismatch'
  # The daemon builder sees the pinned local base. This Dockerfile only COPYs
  # small code/seed/font layers: no RUN, downloads or model initialization.
  docker buildx build --builder default --pull=false --network none --load \
    --build-arg "GPU_BASE=$base_tag" --build-arg "GPU_BASE_ID=$base_id" --build-arg "REVISION=$sha" \
    -f "$SRC/ml/Dockerfile.gpu-release" -t "$proj-ml:$sha" "$SRC" > "$S/build-ml.log" 2>&1 \
    || { tail -40 "$S/build-ml.log"; die 'immutable GPU code build failed'; }
  gpu_image=$(docker image inspect "$proj-ml:$sha" --format '{{.Id}}')
  [[ "$gpu_image" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid release image identity'
  [ "$(docker image inspect "$gpu_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$sha" ] || die 'GPU code revision mismatch'
  echo "  immutable ML release: $gpu_image"
}

cmd_up() {
  [ -n "$sha" ] || die "up: нужен sha"
  # полоса stand (как run.sh с --lane stand): сборки стендов — по одной, мутации и гейт (полоса heavy) их не держат;
  # очередь видна одинаково — cat /opt/w1-gate/lock.stand.cmd. Процессор мутациям уступает builder (cpu-shares).
  exec 8>"$R/lock.$stand_lane"
  if ! flock -n 8; then echo "runner-stand: жду замок полосы $stand_lane (держит: $(cat "$R/lock.$stand_lane.cmd" 2>/dev/null))"; flock 8; fi
  echo "$branch@${sha:0:12}: stand up" > "$R/lock.$stand_lane.cmd"
  trap 'rm -f "$R/lock.$stand_lane.cmd"' EXIT
  # и замок ветки: down, logs и status этой ветки не читают стенд посреди пересоздания
  exec 9>"$R/stand/$proj.lock"; flock 9

  [ -d "$SRC/.git" ] || git clone -q "$R/repo.git" "$SRC"
  git -C "$SRC" fetch -q origin "+refs/heads/*:refs/remotes/origin/*"
  git -C "$SRC" checkout -q --detach "$sha" || die "нет коммита $sha — сначала push (remote-run.sh делает его сам)"
  git -C "$SRC" reset -q --hard "$sha"; git -C "$SRC" clean -qfdx
  # A private backup/rollback caller may use umask 077. Git preserves existing
  # permissions, which COPY would otherwise carry into non-root runtime images.
  # Normalize only this disposable source checkout, never VAR/secrets or .git.
  find "$SRC" -path "$SRC/.git" -prune -o -type d -exec chmod a+rx {} +
  find "$SRC" -path "$SRC/.git" -prune -o -type f -exec chmod a+r {} +

  # сборка на ядрах раннера: свой builder buildx (docker-container) с cpuset; образы — в демон (--load)
  local builder_limits=()
  [ -z "$gpu_image" ] || builder_limits=(--driver-opt memory=8g --driver-opt memory-swap=8g)
  docker buildx inspect "$builder" >/dev/null 2>&1 || docker buildx create --name "$builder" --driver docker-container --driver-opt "\"cpuset-cpus=$build_cpus\"" --driver-opt "cpu-shares=$builder_shares" "${builder_limits[@]}" >/dev/null
  if [ -n "$gpu_image" ]; then
    docker buildx inspect --bootstrap "$builder" >/dev/null
    docker update --cpus 6 --cpuset-cpus "$build_cpus" --memory 8g --memory-swap 8g "buildx_buildkit_${builder}0" >/dev/null
  fi
  say "сборка $proj-{api,web,ml}:${sha:0:12} · ядра $build_cpus"
  build_image() {
    local img=${1%%:*} f=${1#*:} t0=$SECONDS
    docker buildx build --builder "$builder" --load --progress plain --build-arg REVISION="$sha" -f "$SRC/$f" -t "$proj-$img:$sha" "$SRC" > "$S/build-$img.log" 2>&1 \
      || { tail -40 "$S/build-$img.log"; die "сборка $img не прошла (лог $S/build-$img.log)"; }
    echo "  $proj-$img: $((SECONDS - t0)) с"
  }
  if [ -n "$gpu_image" ]; then
    local api_build web_build build_failed=0
    build_image api:apps/api/Dockerfile & api_build=$!
    build_image web:apps/web/Dockerfile & web_build=$!
    wait "$api_build" || build_failed=1
    wait "$web_build" || build_failed=1
    [ "$build_failed" = 0 ] || die 'parallel API/web build failed'
    build_gpu_release
  else
    local img
    for img in api:apps/api/Dockerfile web:apps/web/Dockerfile ml:ml/Dockerfile; do build_image "$img"; done
  fi

  # секреты и TLS — штатным stand.sh (openssl, файлы 600); ключей Yandex на раннере нет — режим fs
  mkdir -p "$VAR"
  echo "INSPECTOR_BLOB_STORE=fs" > "$VAR/s3.env"; echo fs > "$VAR/mode"; echo docker > "$VAR/ml-mode"; echo "$sha" > "$VAR/revision"
  (cd "$SRC" && STAND_VAR_DIR="$VAR" bash scripts/stand.sh secrets >/dev/null)
  fix_perms
  write_env
  local port; port=$(port_of)
  write_override "$port"
  if [ -n "$gpu_image" ]; then
    gpu_admission
    write_gpu_override "$port"
  elif [ -f "$S/gpu-override.yml" ]; then
    die 'this stand is a GPU pilot; pass --gpu-pilot with its immutable image ID'
  fi
  say "up $proj · web 127.0.0.1:$port · хранилище fs · ML в контейнере"
  compose up -d --wait --wait-timeout 900 --remove-orphans
  if [ -n "$gpu_image" ] && [ -f "$VAR/node-policy.json" ]; then
    # buildx's privileged builder can request GPU devices. During the supervised
    # pilot it stays stopped after builds; its cache volume is retained.
    docker stop --time 30 "buildx_buildkit_${builder}0" >/dev/null
  fi
  # Keep GPU pilot release tags for explicit rollback; no automatic deletion.
  if [ -z "$gpu_image" ]; then
  for img in api web ml; do
    # нет прежних тегов — grep пуст и с pipefail оборвал бы up до смоука: || true
    { docker image ls "$proj-$img" --format '{{.Tag}}' | grep -vxF "$sha" || true; } | while read -r t; do docker image rm "$proj-$img:$t" >/dev/null 2>&1 || true; done
  done
  fi
  smoke "$port"
  echo "  с мака: ssh -N -L $port:127.0.0.1:$port ${W1_RUNNER_HOST:-root@158.255.3.179} → https://127.0.0.1:$port (CA — $VAR/tls/ca.crt)"
}

# смоук: /health с ревизией и маршрут серверного импорта (T-169) — 401 без входа, есть в OpenAPI
smoke() {
  local port=$1 ca="$VAR/tls/ca.crt" base="https://127.0.0.1:$1" rev code
  rev=$(curl -fsS --max-time 10 --cacert "$ca" "$base/health" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
  [ "$rev" = "$sha" ] || die "смоук: /health отдаёт ревизию '${rev:-нет ответа}', ждали $sha"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$ca" -H 'content-type: application/json' -d '{}' "$base/api/v1/documents/import")
  [ "$code" = 401 ] || die "смоук: POST /api/v1/documents/import без входа — $code, ждали 401"
  curl -fsS --max-time 10 --cacert "$ca" "$base/api/v1/openapi.json" | grep -q '"/api/v1/documents/import"' || die "смоук: маршрута импорта нет в OpenAPI"
  echo "  смоук: /health revision ${sha:0:12}, /documents/import отвечает (401 без входа, есть в OpenAPI)"
}

case $action in
  up) cmd_up ;;
  down)
    [ -f "$S/override.yml" ] || die "стенда $proj нет"
    case "${1:-}" in
      --wipe) compose down -v --remove-orphans ;;                      # и тома: база и блобы стенда ветки
      --forget) compose down -v --remove-orphans; sed -i "/^$proj /d" "$R/stand/ports"; echo "  порт освобождён" ;;
      *) compose down --remove-orphans ;;
    esac ;;
  logs) [ -f "$S/override.yml" ] || die "стенда $proj нет"; compose logs --no-color --tail "${LINES:-200}" "$@" ;;
  status)
    [ -f "$S/override.yml" ] || die "стенда $proj нет"
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
    port=$(awk -v n="$proj" '$1 == n {print $2}' "$R/stand/ports"); sha=$(cat "$VAR/revision"); smoke "$port" ;;
  *) die "ждём up|down|logs|status" ;;
esac
