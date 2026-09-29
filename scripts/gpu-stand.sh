#!/usr/bin/env bash
# Стенд «nadzorium-gpu» (T-185): https://nadzorium-gpu.almazrobots.ru на GPU-сервере HOSTKEY 54831 (158.255.3.179).
# Запускается с мака; всё, кроме ship и pass, исполняется на сервере (ssh → этот же скрипт с GPU_STAND_REMOTE=1).
#
#   scripts/gpu-stand.sh ship              выложить deploy/gpu-stand, deploy/gpu, исходники загрузчика → /opt/stand-gpu/src
#   scripts/gpu-stand.sh secrets           секреты (600), CA и сертификаты, пароль basic auth → /opt/stand-gpu (вне git);
#                                          пароль basic auth копируется владельцу в var/gpu-stand/ основного репо (600)
#   scripts/gpu-stand.sh images <sha> [api web ml]
#                                          тег inspector-gpu-<компонент>:<sha> поверх сборки w1-main-{api,web,ml-gpu}:<sha> (сборка — сессия
#                                          W1 на том же сервере, из main — ADR-0005); без списка — все три
#   scripts/gpu-stand.sh build <sha> [api web ml]
#                                          своя сборка из коммита main, когда W1 его не собирал: git archive <sha> →
#                                          /opt/stand-gpu/build/<sha>, docker build на ядрах 28–31 (0–27 — разбор), REVISION=sha,
#                                          тег inspector-gpu-<компонент>:<sha>; без списка — все три
#   Ревизия назначается покомпонентно ($BASE/revision-{api,web,ml}; нет файла — общая $BASE/revision): api/web можно
#   обновить, оставив ML прежним (T-185: ML профиля gpu на main ждёт T-230).
#   scripts/gpu-stand.sh up [сервис…]      docker compose up (postgres, rabbitmq, redis, api, ml, web, caddy); со списком —
#                                          только эти сервисы, без зависимостей (api — после api-migrate новой ревизии)
#   scripts/gpu-stand.sh status            состояние контейнеров, /health каждого сервиса, ревизия, объекты и файлы
#   scripts/gpu-stand.sh logs [сервис…]    последние строки журналов
#   scripts/gpu-stand.sh load [--approval] пакеты POL-17 и LOS-3A с сервера (/opt/inspector) загрузчиком apps/api/src/cli/load-package.ts,
#                                          --no-start: разбор запускает CTO-сессия (T-165); прочие аргументы — загрузчику
#                                          (--approval — решение владельца 28.09: «ПД утверждена, РД в производство работ»)
#   scripts/gpu-stand.sh down              остановить (тома сохраняются; удаление — только руками и с «да» владельца)
#   scripts/gpu-stand.sh pass              путь к паролю basic auth на маке (значение не печатается)
# Правило №0: up и load — при свободных ≥ 20 ГБ на сервере. Каталоги W1 (/opt/w1-gate, w1-*), /opt/inspector, /opt/corpus
# и контейнер vllm-reader скрипт не меняет: /opt/inspector только читается (жёсткие ссылки на блобы).
set -euo pipefail

HOST=${GPU_STAND_HOST:-root@158.255.3.179}
BASE=${GPU_STAND_BASE:-/opt/stand-gpu}
SRC=${GPU_STAND_SOURCE:-$BASE/src}
DOMAIN=${GPU_STAND_DOMAIN:-nadzorium-gpu.almazrobots.ru}

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { echo "gpu-stand: $*" >&2; exit 1; }

# ─────────────────────────────── мак
if [ "${GPU_STAND_REMOTE:-}" != 1 ]; then
  cd "$(dirname "$0")/.."
  MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
  LOCAL_VAR="$MAIN_ROOT/var/gpu-stand"
  cmd=${1:-}; shift || true
  case $cmd in
    ship)
      rev=$(git rev-parse HEAD)
      say "ship · $rev → $HOST:$SRC"
      ssh "$HOST" "mkdir -p $BASE && rm -rf $SRC.new && mkdir -p $SRC.new"
      git archive --format=tar HEAD deploy/gpu-stand deploy/gpu/postgres deploy/gpu/rabbitmq apps/api/src apps/api/package.json scripts/gpu-stand.sh \
        | ssh "$HOST" "tar -x -C $SRC.new && echo $rev > $SRC.new/SOURCE_REVISION && rm -rf $SRC.old && { [ ! -d $SRC ] || mv $SRC $SRC.old; } && mv $SRC.new $SRC"
      echo "  готово: $SRC (исходник конфигурации $rev)" ;;
    pass)
      echo "$LOCAL_VAR/basic_auth_password (логин прокси: owner); вход в приложение — inspector, пароль: $LOCAL_VAR/app_password" ;;
    secrets)
      ssh "$HOST" "GPU_STAND_REMOTE=1 bash $SRC/scripts/gpu-stand.sh secrets"
      mkdir -p "$LOCAL_VAR"; chmod 700 "$LOCAL_VAR"
      (umask 077
       ssh "$HOST" "cat $BASE/secrets/basic_auth_password" > "$LOCAL_VAR/basic_auth_password.tmp"
       ssh "$HOST" "cat $BASE/secrets/demo_password" > "$LOCAL_VAR/app_password.tmp")
      for f in basic_auth_password app_password; do
        [ -s "$LOCAL_VAR/$f.tmp" ] || die "не получен $f"
        mv "$LOCAL_VAR/$f.tmp" "$LOCAL_VAR/$f"; chmod 600 "$LOCAL_VAR/$f"
      done
      echo "  пароли владельцу: $LOCAL_VAR/{basic_auth_password,app_password} (600, вне git)" ;;
    images|up|status|logs|load|down)
      ssh "$HOST" "GPU_STAND_REMOTE=1 bash $SRC/scripts/gpu-stand.sh $cmd $*" ;;
    build)
      sha=${1:?build <sha> [api web ml]}; shift
      sha=$(git rev-parse --verify "$sha^{commit}")
      say "build · $sha → $HOST:$BASE/build/$sha"
      ssh "$HOST" "rm -rf $BASE/build/$sha && mkdir -p $BASE/build/$sha"
      git archive --format=tar "$sha" package.json pnpm-lock.yaml pnpm-workspace.yaml apps/api apps/web data/seed ml assets/fonts \
        | ssh "$HOST" "tar -x -C $BASE/build/$sha"
      ssh "$HOST" "GPU_STAND_REMOTE=1 bash $SRC/scripts/gpu-stand.sh build $sha $*" ;;
    *) sed -n '2,30p' "$0"; exit 2 ;;
  esac
  exit 0
fi

# ─────────────────────────────── сервер
SEC=$BASE/secrets
TLS=$BASE/tls
ENV=$BASE/stand.env
COMPOSE=(docker compose --project-directory "$SRC/deploy/gpu-stand" -f "$SRC/deploy/gpu-stand/compose.yml" --env-file "$ENV")
# T-231 (вариант А, OWASP-0191): есть ключ хранения — блобы на диске шифруются (compose.at-rest.yml); нет — всё как было.
# Ключ создаёт только scripts/pdn-at-rest-a.sh migrate --apply (после «да» владельца).
BLOB_KEY=$SEC/blob_encryption_key
if [ -s "$BLOB_KEY" ]; then COMPOSE+=(-f "$SRC/deploy/gpu-stand/compose.at-rest.yml"); fi
# Сторонние образы — по digest (postgres, rabbitmq, redis — те же, что deploy/stand/images.env и deploy/gpu/.env.example)
POSTGRES_IMAGE=postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
RABBITMQ_IMAGE=rabbitmq:4.3-management-alpine@sha256:ce634665a8e7262384a793581c20cb8a46343887446eb391b77c814febeca4b2
REDIS_IMAGE=redis:8.8-alpine@sha256:0b2b77d3ea5078274795e3177cdbdada8b96316684a38911d528534ed679b5ec
CADDY_IMAGE=caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

need_disk() {
  local free_gb; free_gb=$(( $(df -Pk "$BASE" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  [ "$free_gb" -ge 20 ] || die "свободно ${free_gb} ГБ < 20 — не запускаю (правило №0)"
}

secret_file() { [ -s "$1" ] && return 0; (umask 077; eval "$2" > "$1"); chmod 600 "$1"; }

cert() {  # $1 — имя (DNS), $2 — каталог; SAN: имя, localhost, 127.0.0.1, 172.17.0.1 (ML слушает мост docker0)
  local name=$1 dir=$2
  mkdir -p "$dir"
  if [ ! -s "$dir/server.crt" ]; then
    (umask 077
     openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$name" -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
     printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1,IP:172.17.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' "$name" > "$dir/ext.cnf"
     openssl x509 -req -in "$dir/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial -days 825 -extfile "$dir/ext.cnf" -out "$dir/server.crt" 2>/dev/null
     rm -f "$dir/server.csr" "$dir/ext.cnf")
    chmod 644 "$dir/server.crt"
  fi
  cp "$TLS/ca.crt" "$dir/ca.crt"
  chmod 644 "$dir/ca.crt"
}

cmd_secrets() {
  say "секреты и TLS → $BASE (вне git)"
  mkdir -p "$SEC" "$TLS" "$BASE/caddy" "$BASE/blobs" "$BASE/readers" "$BASE/pkg"
  chmod 700 "$SEC"
  for f in pg_superuser_password pg_migrator_password pg_app_password bootstrap_admin_password demo_password rabbitmq_password; do
    secret_file "$SEC/$f" "openssl rand -hex 24"
  done
  secret_file "$SEC/basic_auth_password" "openssl rand -base64 18 | tr -d '/+=' | head -c 20"
  (umask 077; printf 'default_user = inspector\ndefault_pass = %s\n' "$(cat "$SEC/rabbitmq_password")" > "$BASE/rabbitmq-auth.conf")
  if [ ! -s "$TLS/ca.crt" ]; then
    (umask 077
     openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 -subj "/CN=nadzorium-gpu-ca" \
       -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
       -keyout "$TLS/ca.key" -out "$TLS/ca.crt" 2>/dev/null)
    chmod 644 "$TLS/ca.crt"
  fi
  for s in api web postgres rabbitmq redis; do cert "$s" "$TLS/$s"; done
  cert ml-gpu "$TLS/ml"
  # владельцы ключей — uid процессов в контейнерах (cap_drop ALL: chown внутри невозможен)
  chown 70:70 "$TLS/postgres/server.key"; chmod 600 "$TLS/postgres/server.key"
  chown 1000:1000 "$TLS/api/server.key"; chmod 600 "$TLS/api/server.key"
  chown 101:101 "$TLS/web/server.key"; chmod 600 "$TLS/web/server.key"
  chown 10001:10001 "$TLS/ml/server.key"; chmod 600 "$TLS/ml/server.key"
  chown 100:101 "$TLS/rabbitmq/server.key" "$BASE/rabbitmq-auth.conf"; chmod 600 "$TLS/rabbitmq/server.key" "$BASE/rabbitmq-auth.conf"
  chown 999:1000 "$TLS/redis/server.key"; chmod 600 "$TLS/redis/server.key"
  # секреты compose (file:) монтируются с правами файла хоста: читают их postgres (70), api (1000) — 644 внутри каталога 700 root
  chmod 644 "$SEC"/pg_*_password "$SEC"/bootstrap_admin_password "$SEC"/rabbitmq_password "$SEC"/demo_password
  chmod 600 "$SEC/basic_auth_password"
  chown 1000:1000 "$BASE/blobs"; chown 10001:10001 "$BASE/readers"
  # хеш пароля basic auth для Caddy (логин owner); сам пароль — только в secrets/basic_auth_password
  local hash
  hash=$({ cat "$SEC/basic_auth_password"; echo; } | docker run --rm -i --network none "$CADDY_IMAGE" caddy hash-password --algorithm bcrypt --bcrypt-cost 10 2>/dev/null | tail -1)
  [ -n "$hash" ] || die "caddy hash-password не дал хеша"
  (umask 022; printf 'owner %s\n' "$hash" > "$BASE/caddy/users.caddy")
  echo "  готово: $(find "$SEC" -type f | wc -l) файлов-секретов, CA и сертификаты: api web ml postgres rabbitmq redis"
}

rev_of() { cat "$BASE/revision-$1" 2>/dev/null || cat "$BASE/revision" 2>/dev/null || die "образ $1 не назначен: gpu-stand.sh images|build <sha> $1"; }

write_env() {
  local api web ml; api=$(rev_of api); web=$(rev_of web); ml=$(rev_of ml)
  { echo "POSTGRES_IMAGE=$POSTGRES_IMAGE"; echo "RABBITMQ_IMAGE=$RABBITMQ_IMAGE"; echo "REDIS_IMAGE=$REDIS_IMAGE"; echo "CADDY_IMAGE=$CADDY_IMAGE"
    echo "API_IMAGE=inspector-gpu-api:$api"; echo "WEB_IMAGE=inspector-gpu-web:$web"; echo "ML_GPU_IMAGE=inspector-gpu-ml:$ml"
    echo "STAND_VAR=$BASE"; echo "STAND_REVISION=$api"
    if [ -f "$BASE/tuning.env" ]; then cat "$BASE/tuning.env"; fi   # GPU_ML_CPUS, GPU_OCR_WORKERS, GPU_PARSE_CONCURRENCY… — правится на месте
  } > "$ENV"
}

components() {  # COMPONENTS — компоненты из аргументов; пусто — все три
  local c; COMPONENTS=()
  for c in "$@"; do case $c in api|web|ml) COMPONENTS+=("$c") ;; *) die "компонент: api | web | ml, а не «$c»" ;; esac; done
  [ ${#COMPONENTS[@]} -gt 0 ] || COMPONENTS=(api web ml)
}

assign() {  # $1 — компонент, $2 — sha: ревизия компонента в $BASE/revision-<компонент>
  echo "$2" > "$BASE/revision-$1"
  echo "  inspector-gpu-$1:$2 · revision $(docker image inspect "inspector-gpu-$1:$2" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
}

cmd_images() {
  local sha=${1:?images <sha main> [api web ml]} i; shift
  components "$@"
  # ML — цель gpu (ml/Dockerfile --target gpu → w1-main-ml-gpu, T-230): образ по умолчанию без GPU-OCR в профиле gpu не стартует
  local src
  for i in "${COMPONENTS[@]}"; do
    src="w1-main-$i:$sha"; [ "$i" = ml ] && src="w1-main-ml-gpu:$sha"
    docker image inspect "$src" >/dev/null 2>&1 || die "нет образа $src (сборка сессии W1 ещё не готова)"
    docker tag "$src" "inspector-gpu-$i:$sha"
    ml_is_gpu "$i" "$sha"
    assign "$i" "$sha"
  done
  write_env
}

ml_is_gpu() {  # $1 — компонент, $2 — sha: ML стенда — только цель gpu ml/Dockerfile (T-230, OWASP-0210)
  [ "$1" != ml ] || [ "$(docker image inspect "inspector-gpu-ml:$2" --format '{{index .Config.Labels "org.opencontainers.image.title"}}')" = inspector-ml-gpu ] \
    || die "inspector-gpu-ml:$2 — не цель gpu ml/Dockerfile"
}

cmd_build() {  # контекст уже выложен с мака в $BASE/build/<sha> (git archive)
  local sha=${1:?build <sha> [api web ml]} i ctx; shift; ctx=$BASE/build/$sha
  need_disk
  [ -f "$ctx/pnpm-lock.yaml" ] || die "нет контекста сборки $ctx"
  components "$@"
  for i in "${COMPONENTS[@]}"; do
    say "docker build $i · REVISION=$sha · ядра 28–31"
    if [ "$i" = ml ]; then
      # ML — цель gpu (T-230): ADD --checksum весов требует BuildKit; ресурсы сборки ограничивает сам демон
      docker build --build-arg REVISION="$sha" -f "$ctx/ml/Dockerfile" --target gpu -t "inspector-gpu-ml:$sha" "$ctx"
    else
      # классический сборщик (buildx на сервере нет): ядра 28–31 и потолок памяти — разбор на 0–27 не задевается
      DOCKER_BUILDKIT=0 docker build --cpuset-cpus 28-31 --memory 4g --memory-swap 6g --build-arg REVISION="$sha" \
        -f "$ctx/apps/$i/Dockerfile" -t "inspector-gpu-$i:$sha" "$ctx"
    fi
    ml_is_gpu "$i" "$sha"
    assign "$i" "$sha"
  done
  write_env
}

cmd_up() {
  need_disk
  [ -s "$SEC/demo_password" ] || die "нет секретов: gpu-stand.sh secrets"
  write_env
  say "up · api :$(rev_of api) · web :$(rev_of web) · ml :$(rev_of ml)${*:+ · только $*}"
  if [ $# -eq 0 ]; then "${COMPOSE[@]}" up -d --wait --wait-timeout 900; return; fi
  # точечно, без зависимостей (ML может быть остановлен ради памяти): API — только после миграций своей ревизии
  if printf '%s\n' "$@" | grep -qx api; then
    "${COMPOSE[@]}" up -d --no-deps api-migrate
    local code; code=$(docker wait "$("${COMPOSE[@]}" ps -aq api-migrate)")
    [ "$code" = 0 ] || { "${COMPOSE[@]}" logs --tail 40 api-migrate; die "api-migrate: код $code"; }
  fi
  "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 900 "$@"
}

cmd_status() {
  say "контейнеры · api :$(rev_of api 2>/dev/null || echo ?) · web :$(rev_of web 2>/dev/null || echo ?) · ml :$(rev_of ml 2>/dev/null || echo ?)"
  "${COMPOSE[@]}" ps --all --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  say "/health"
  local web ml
  web=$(curl -fsS --max-time 10 --cacert "$TLS/ca.crt" --resolve web:46443:127.0.0.1 https://web:46443/health 2>/dev/null || true)
  ml=$(curl -fsS --max-time 10 --cacert "$TLS/ca.crt" --resolve ml-gpu:48811:172.17.0.1 https://ml-gpu:48811/health 2>/dev/null || true)
  echo "  web → api: ${web:0:200}"
  echo "  ml:        ${ml:0:200}"
  echo "  снаружи:   $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/") без пароля (ждём 401), health $(curl -s --max-time 15 "https://$DOMAIN/health" | head -c 200)"
  say "объекты и файлы (PostgreSQL)"
  "${COMPOSE[@]}" exec -T postgres psql -q -U postgres -d inspector -v ON_ERROR_STOP=1 -Atc "set search_path=inspector;" -c \
    "select o.id, o.name, count(distinct i.id) as inspections, count(f.id) as files, count(f.id) filter (where f.parse_status='DONE') as parsed from objects o left join inspections i on i.object_id=o.id left join files f on f.inspection_id=i.id group by 1,2 order by 1" 2>/dev/null \
    | sed 's/^/  /' || echo "  (запрос не прошёл — схема другая?)"
}

cmd_load() {  # аргументы — загрузчику как есть (--approval)
  need_disk
  local web_ca="$TLS/ca.crt" api_img
  api_img=$(grep '^API_IMAGE=' "$ENV" | cut -d= -f2)
  # T-231: при ключе хранения серверный импорт сразу пишет IBE1 — открытый текст в каталог блобов не ложится
  local key_mount=() key_arg=()
  if [ -s "$BLOB_KEY" ]; then key_mount=(-v "$BLOB_KEY:/run/blob_key:ro"); key_arg=(--import-key-file /run/blob_key); fi
  for pair in "POL-17:pol17:Полярная ул., 17" "LOS-3A:los3a:Лосевская ул., 3А"; do
    local id=${pair%%:*} rest=${pair#*:}; local cat=${rest%%:*} name=${rest#*:}
    local dir=$BASE/pkg/$id
    say "$id · «$name»: папка с исходными путями (жёсткие ссылки на /opt/inspector/blobs)"
    python3 - "$dir" "/opt/inspector/catalog/$cat.jsonl" <<'PY'
import json, os, sys
dst, catalog = sys.argv[1], sys.argv[2]
n = 0
for line in open(catalog, encoding="utf-8"):
    e = json.loads(line)
    p = os.path.normpath(e["path"])
    if p.startswith("..") or os.path.isabs(p):
        raise SystemExit(f"путь вне каталога: запись {n}")
    out = os.path.join(dst, p)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if not os.path.exists(out):
        os.link(f"/opt/inspector/blobs/{e['sha256']}", out)
    n += 1
print(f"  файлов по каталогу: {n}")
PY
    chmod -R a+rX "$dir"
    say "$id: загрузчик (API через web 127.0.0.1:46443, серверный импорт в $BASE/blobs)"
    mkdir -p "$BASE/load-reports/$id"; chown 1000:1000 "$BASE/load-reports/$id"
    docker run --rm --network host --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
      --add-host web:127.0.0.1 \
      -v "$SRC/apps/api/src:/app/apps/api/src:ro" \
      -v "$dir:/pkg:ro" -v "$BASE/blobs:/import" -v "$web_ca:/run/ca.crt:ro" \
      -v "$SEC/demo_password:/run/app_password:ro" -v "$BASE/load-reports/$id:/out" \
      "${key_mount[@]}" \
      --entrypoint node "$api_img" apps/api/src/cli/load-package.ts /pkg \
        --api https://web:46443 --ca /run/ca.crt --login inspector --password-file /run/app_password \
        --object-id "$id" --object-name "$name" --import-dir /import "${key_arg[@]}" --no-start --out /out "$@"
  done
}

cmd=${1:-}; shift || true
case $cmd in
  secrets) cmd_secrets ;;
  images) cmd_images "$@" ;;
  build) cmd_build "$@" ;;
  up) cmd_up "$@" ;;
  status) cmd_status ;;
  logs) "${COMPOSE[@]}" logs --tail 80 "$@" ;;
  load) cmd_load "$@" ;;
  down) "${COMPOSE[@]}" down ;;
  *) die "команда: secrets | images <sha> [api web ml] | build <sha> [api web ml] | up [сервис…] | status | logs | load [--approval] | down" ;;
esac
