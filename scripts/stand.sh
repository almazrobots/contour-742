#!/usr/bin/env bash
# Стенд «stand» на маке (NFR-STAND, T-129): образы по sha → docker compose deploy/stand/compose.yml.
#   scripts/heavy.sh scripts/stand.sh build   собрать inspector-{api,ml,web}:<sha> (тяжёлое — только под замком heavy.sh)
#   scripts/stand.sh secrets                  подготовить var/stand: секреты (600), CA и сертификаты, stand.env
#   scripts/stand.sh up [--yandex|--minio|--fs] [--ml-host]  поднять (по умолчанию --yandex — бакет nadzorium, хранилище системы;
#                                                --minio — только автотесты паритета ADR-0004 п.5, решение владельца 27.09;
#                                                --ml-host — ML на маке вместо контейнера: MLX и Metal, scripts/ml-host.sh, T-130)
#   scripts/stand.sh status                   docker compose ps, /health каждого сервиса, revision == sha сборки
#   scripts/stand.sh logs [сервис…]           последние строки журналов
#   scripts/stand.sh down [--wipe]            остановить; --wipe — ещё и тома (база, кэш блобов) и данные MinIO
#   scripts/stand.sh prune                    оставить две последние сборки inspector-*, кэш сборки ≤ 5 ГБ (зовёт и build)
# Правило №0: build и up — только при свободных ≥ 20 ГБ. prune трогает только образы inspector-* и кэш сборки:
# ни томов, ни чужих образов; тома удаляются только с явным --wipe.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VAR="${STAND_VAR_DIR:-$ROOT/var/stand}"  # каталог переопределяют только тесты
SEC="$VAR/secrets"
TLS="$VAR/tls"
COMPOSE=(docker compose --project-directory "$ROOT/deploy/stand" -f "$ROOT/deploy/stand/compose.yml" --env-file "$VAR/stand.env")
# T-130: режим ML (docker | host) запоминается в var/stand/ml-mode — status, logs и down видят тот же состав сервисов
set_compose() {
  if [ "$(cat "$VAR/ml-mode" 2>/dev/null)" = host ]; then
    COMPOSE=(docker compose --project-directory "$ROOT/deploy/stand" -f "$ROOT/deploy/stand/compose.yml" -f "$ROOT/deploy/stand/compose.ml-host.yml" --env-file "$VAR/stand.env")
  fi
}
set_compose
WEB="https://127.0.0.1:45843"
# Ключи Yandex Object Storage — файл основного репозитория (.secrets, вне git); из worktree — через общий .git
YANDEX_ENV=${YANDEX_S3_ENV:-"$(cd "$(git rev-parse --git-common-dir)/.." && pwd)/.secrets/yandex-s3-nadzorium.env"}

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { echo "stand: $*" >&2; exit 1; }

need_disk() {
  local free_gb
  free_gb=$(( $(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  [ "$free_gb" -ge 20 ] || die "свободно ${free_gb} ГБ < 20 — тяжёлое не запускаю (правило №0)"
}

# Ревизия сборки: sha HEAD; незакоммиченное — с меткой -dirty (как local-gate), чтобы образ не выдавал себя за коммит
revision() {
  local sha
  sha=$(git rev-parse HEAD)
  git diff --quiet HEAD -- . ':!.claude' && git diff --cached --quiet -- . ':!.claude' || sha="$sha-dirty"
  echo "$sha"
}

# Один файл-секрет: создаётся, только если его нет; значение в вывод не попадает
secret_file() {  # $1 — путь, $2 — команда-генератор
  [ -s "$1" ] && return 0
  (umask 077; eval "$2" > "$1")
  chmod 600 "$1"
}

cert() {  # $1 — имя сервиса (DNS в сети compose), $2 — каталог
  local name=$1 dir=$2
  mkdir -p "$dir"
  if [ ! -s "$dir/server.crt" ]; then
    (umask 077
     openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$name" \
       -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
     printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' "$name" > "$dir/ext.cnf"
     openssl x509 -req -in "$dir/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
       -days 365 -extfile "$dir/ext.cnf" -out "$dir/server.crt" 2>/dev/null
     rm -f "$dir/server.csr" "$dir/ext.cnf")
    chmod 600 "$dir/server.key"; chmod 644 "$dir/server.crt"
  fi
  cp "$TLS/ca.crt" "$dir/ca.crt"
}

cmd_secrets() {
  say "секреты и TLS стенда → var/stand (вне git)"
  mkdir -p "$SEC/s3-minio" "$SEC/s3-yandex" "$TLS" "$VAR/minio-data"
  chmod 700 "$SEC" "$SEC/s3-minio" "$SEC/s3-yandex"
  for f in pg_superuser_password pg_migrator_password pg_app_password bootstrap_admin_password demo_password; do
    secret_file "$SEC/$f" "openssl rand -hex 24"
  done
  # ADR-0006: ключ шифрования блобов — один раз и НИКОГДА не перезаписывается (потеря = потеря данных в бакете)
  secret_file "$SEC/s3_encryption_key" "openssl rand -hex 32"
  # RabbitMQ (ТЗ 1.5, NFR-TLS-INTERNAL): пароль брокера — файлом, не переменной окружения (SEC-07): API читает его
  # секретом rabbitmq_password, брокер — из conf.d (10-auth.conf, 600, вне git). docker inspect пароля не покажет
  secret_file "$SEC/rabbitmq_password" "openssl rand -hex 24"
  ( umask 077
    printf 'default_user = inspector\ndefault_pass = %s\n' "$(cat "$SEC/rabbitmq_password")" > "$VAR/rabbitmq-auth.conf"
    rm -f "$VAR/rabbitmq.env" "$VAR/amqp.env" )  # прежняя раскладка: пароль в окружении контейнеров
  # MinIO: ключи корневого пользователя паритетного сервера (они же — ключи API в режиме --minio)
  secret_file "$SEC/s3-minio/access_key_id" "echo stand-\$(openssl rand -hex 8)"
  secret_file "$SEC/s3-minio/secret_access_key" "openssl rand -hex 24"
  # Yandex: ключи раскладываются из .secrets по файлам; значения не печатаются
  if [ -f "$YANDEX_ENV" ]; then
    for pair in "AWS_ACCESS_KEY_ID:access_key_id" "AWS_SECRET_ACCESS_KEY:secret_access_key"; do
      var=${pair%%:*}; out="$SEC/s3-yandex/${pair##*:}"
      (umask 077; sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$var=//p" "$YANDEX_ENV" | tail -1 \
        | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '\r\n' > "$out.tmp")
      if [ -s "$out.tmp" ]; then mv "$out.tmp" "$out"; chmod 600 "$out"; else rm -f "$out.tmp"; echo "  $var в $YANDEX_ENV не найден — режим --yandex недоступен"; fi
    done
  else
    echo "  $YANDEX_ENV нет — режим --yandex недоступен (--minio и --fs работают)"
  fi
  # CA стенда и сертификаты сервисов: SAN — имя в сети compose, localhost и 127.0.0.1 (проверки живости, браузер)
  if [ ! -s "$TLS/ca.crt" ]; then
    (umask 077
     openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 -subj "/CN=inspector-stand-ca" \
       -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
       -keyout "$TLS/ca.key" -out "$TLS/ca.crt" 2>/dev/null)
    chmod 600 "$TLS/ca.key"; chmod 644 "$TLS/ca.crt"
  fi
  for s in api web ml postgres minio rabbitmq; do cert "$s" "$TLS/$s"; done
  # T-130: ML на маке — API ходит к нему из контейнера по имени host.docker.internal (Docker Desktop)
  cert host.docker.internal "$TLS/ml-host"
  # MinIO ждёт в --certs-dir имена public.crt / private.key и корни в CAs/
  cp "$TLS/minio/server.crt" "$TLS/minio/public.crt"; cp "$TLS/minio/server.key" "$TLS/minio/private.key"
  chmod 600 "$TLS/minio/private.key"; mkdir -p "$TLS/minio/CAs"; cp "$TLS/ca.crt" "$TLS/minio/CAs/ca.crt"
  [ -f "$VAR/s3.env" ] || write_s3_env yandex
  write_stand_env
  echo "  готово: $(find "$SEC" -type f | wc -l | tr -d ' ') файлов-секретов (600), CA и сертификаты: api web ml postgres minio"
}

# Несекретные настройки режима хранилища (ADR-0006) → var/stand/s3.env; ключи — отдельными файлами-секретами
write_s3_env() {
  case $1 in
    minio) printf '%s\n' "INSPECTOR_BLOB_STORE=s3" "INSPECTOR_S3_ENDPOINT=https://minio:9000" "INSPECTOR_S3_REGION=us-east-1" \
             "INSPECTOR_S3_BUCKET=inspector-stand" "INSPECTOR_S3_PREFIX=blobs/" "INSPECTOR_S3_FORCE_PATH_STYLE=true" > "$VAR/s3.env" ;;
    yandex) printf '%s\n' "INSPECTOR_BLOB_STORE=s3" "INSPECTOR_S3_ENDPOINT=https://storage.yandexcloud.net" "INSPECTOR_S3_REGION=ru-central1" \
             "INSPECTOR_S3_BUCKET=nadzorium" "INSPECTOR_S3_PREFIX=${STAND_S3_PREFIX:-blobs/}" "INSPECTOR_S3_FORCE_PATH_STYLE=false" > "$VAR/s3.env"
            # VPN поднят (default на utun*) — трафик контейнеров к S3 через туннель: 3,8 МБ/с против 35 напрямую.
            # Прокси на хосте выводит его мимо VPN с адреса en0 (scripts/egress-direct.py), VPN остаётся включённым.
            if netstat -rn -f inet | awk '$1=="default"{print $4; exit}' | grep -q '^utun'; then
              pgrep -f scripts/egress-direct.py >/dev/null || { nohup python3 "$ROOT/scripts/egress-direct.py" > "$VAR/egress-direct.log" 2>&1 & sleep 1; }
              echo "INSPECTOR_S3_PROXY=http://host.docker.internal:43129" >> "$VAR/s3.env"
              echo "  VPN поднят — S3 через egress-direct мимо VPN ($(head -1 "$VAR/egress-direct.log" 2>/dev/null))"
            fi ;;
    fs) printf '%s\n' "INSPECTOR_BLOB_STORE=fs" > "$VAR/s3.env" ;;
  esac
  echo "$1" > "$VAR/mode"
}

# var/stand/stand.env: образы (свои — по тегу sha последней сборки, сторонние — по digest), каталоги, ревизия
write_stand_env() {
  local rev s3dir
  rev=$(cat "$VAR/revision" 2>/dev/null || echo "не-собран")
  s3dir="$SEC/s3-minio"; [ "$(cat "$VAR/mode" 2>/dev/null)" = yandex ] && s3dir="$SEC/s3-yandex"
  { grep -E '^[A-Z_]+_IMAGE=' deploy/stand/images.env
    echo "API_IMAGE=inspector-api:$rev"
    echo "ML_IMAGE=inspector-ml:$rev"
    echo "WEB_IMAGE=inspector-web:$rev"
    echo "STAND_VAR=$VAR"
    echo "S3_SECRETS_DIR=$s3dir"
    echo "STAND_REVISION=$rev"
  } > "$VAR/stand.env"
}

cmd_build() {
  need_disk
  [ -d /tmp/building-tech-heavy.lock ] || die "сборка — только под замком: scripts/heavy.sh scripts/stand.sh build"
  local rev; rev=$(revision)
  say "docker build api, ml, web · REVISION=$rev"
  mkdir -p "$VAR"
  build() {  # $1 — образ, $2 — Dockerfile. Повтор — только из-за обрывов сети до реестров (как local-gate)
    local t0=$SECONDS
    for n in 1 2 3; do
      if docker build --build-arg REVISION="$rev" -f "$2" -t "inspector-$1:$rev" .; then
        echo "  inspector-$1: $((SECONDS - t0)) с"; return 0
      fi
      echo "  сборка inspector-$1: попытка $n из 3 не удалась"; sleep 5
    done
    return 1
  }
  build api apps/api/Dockerfile
  build web apps/web/Dockerfile
  build ml ml/Dockerfile
  echo "$rev" > "$VAR/revision"
  [ -d "$SEC" ] && write_stand_env
  docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep -F ":$rev" || true
  cmd_prune
}

# Автоочистка (T-130): сборка на каждый коммит копится — за ночь T-129 10 сборок и 22 ГБ кэша сборки, диск 18 ГБ.
# Остаются KEEP_BUILDS последних сборок (по времени образа ml), текущая ревизия стенда и всё, на чём стоит контейнер.
KEEP_BUILDS=${STAND_KEEP_BUILDS:-2}
BUILD_CACHE_MAX=${STAND_BUILD_CACHE_MAX:-5gb}
cmd_prune() {
  local keep cur used tag img
  cur=$(cat "$VAR/revision" 2>/dev/null || true)
  # последние сборки считаются только среди тегов стенда: чужой образ (демо -amd64) не занимает их место
  keep=$(docker image ls inspector-ml --format '{{.CreatedAt}}|{{.Tag}}' | grep -E '\|[0-9a-f]{40}(-dirty)?$' | sort -r | head -n "$KEEP_BUILDS" | cut -d'|' -f2)
  used=$(docker ps -a --format '{{.Image}}' | sed -n 's/^inspector-[a-z]*://p')
  say "prune: оставить $KEEP_BUILDS последних сборок, кэш сборки ≤ $BUILD_CACHE_MAX"
  for img in api ml web; do
    for tag in $(docker image ls "inspector-$img" --format '{{.Tag}}'); do
      # только сборки стенда (sha из 40 символов, возможно -dirty): образы других задач (демо -amd64 и т. п.) не наши
      [[ "$tag" =~ ^[0-9a-f]{40}(-dirty)?$ ]] || continue
      if printf '%s\n%s\n%s\n' "$keep" "$cur" "$used" | grep -qxF "$tag"; then continue; fi
      if docker image rm "inspector-$img:$tag" >/dev/null 2>&1; then echo "  удалена сборка inspector-$img:$tag"; fi
    done
  done
  docker builder prune -f --max-used-space "$BUILD_CACHE_MAX" >/dev/null && echo "  кэш сборки ≤ $BUILD_CACHE_MAX"
}

cmd_up() {
  local mode=yandex ml=docker
  for a in "$@"; do
    case $a in --yandex) mode=yandex ;; --minio) mode=minio ;; --fs) mode=fs ;; --ml-host) ml=host ;; *) die "up: ждём --yandex, --minio или --fs и, по желанию, --ml-host" ;; esac
  done
  echo "$ml" > "$VAR/ml-mode" 2>/dev/null || { mkdir -p "$VAR"; echo "$ml" > "$VAR/ml-mode"; }
  set_compose
  if [ "$ml" = host ]; then
    # API ходит к ML на маке: сервис должен уже слушать, иначе API не пройдёт проверку готовности ML при разборе
    mkdir -p "$VAR/blobs"
    curl -fsS --max-time 5 --cacert "$TLS/ca.crt" https://localhost:8811/health >/dev/null 2>&1 \
      || echo "  внимание: ML на маке не отвечает — запустите scripts/heavy.sh scripts/ml-host.sh run"
  fi
  need_disk
  [ -s "$VAR/revision" ] || die "образы не собраны: scripts/heavy.sh scripts/stand.sh build"
  cmd_secrets >/dev/null
  if [ "$mode" = yandex ]; then
    [ -s "$SEC/s3-yandex/access_key_id" ] && [ -s "$SEC/s3-yandex/secret_access_key" ] || die "нет ключей Yandex (stand.sh secrets)"
  fi
  write_s3_env "$mode"
  write_stand_env
  local rev; rev=$(cat "$VAR/revision")
  for img in api ml web; do docker image inspect "inspector-$img:$rev" >/dev/null 2>&1 || die "нет образа inspector-$img:$rev — scripts/heavy.sh scripts/stand.sh build"; done
  local profiles=(); [ "$mode" = minio ] && profiles=(--profile minio)
  say "up · режим хранилища: $mode · образы :$rev"
  "${COMPOSE[@]}" ${profiles[@]+"${profiles[@]}"} up -d --wait --wait-timeout 600
  # «рубильник»: пауза ML при перегреве или нехватке памяти (scripts/load-guard.sh, журнал var/load-guard.log)
  pgrep -f scripts/load-guard.sh >/dev/null || (nohup "$ROOT/scripts/load-guard.sh" 20 >/dev/null 2>&1 &)
  [ "$(git rev-parse HEAD)" = "${rev%-dirty}" ] || echo "  внимание: HEAD уже $(git rev-parse --short HEAD), стенд собран из ${rev:0:12} — пересоберите образы"
  echo "  вход: $WEB  (CA стенда: var/stand/tls/ca.crt; учётки — демо, пароль: var/stand/secrets/demo_password)"
}

# Все профили — чтобы status, logs и down видели и MinIO, если он поднят
compose_all() { "${COMPOSE[@]}" --profile minio "$@"; }

cmd_status() {
  [ -f "$VAR/stand.env" ] || die "стенд не готовился (stand.sh secrets)"
  local rev bad=0; rev=$(cat "$VAR/revision" 2>/dev/null || echo "?")
  say "docker compose ps · режим $(cat "$VAR/mode" 2>/dev/null || echo ?) · сборка $rev"
  compose_all ps --all --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  say "/health и revision"
  local web api ml
  web=$(curl -fsS --max-time 10 --cacert "$TLS/ca.crt" "$WEB/health" 2>/dev/null || true)
  api=$(compose_all exec -T api node -e "require('node:https').get({host:'127.0.0.1',port:8810,path:'/health',ca:require('node:fs').readFileSync('/run/tls/ca.crt')},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))}).on('error',()=>{})" 2>/dev/null || true)
  ml=$(compose_all exec -T ml python -c "import ssl,urllib.request as u;c=ssl.create_default_context(cafile='/run/tls/ca.crt');print(u.urlopen('https://127.0.0.1:8811/health',timeout=8,context=c).read().decode())" 2>/dev/null || true)
  for pair in "web (через прокси → api):$web" "api:$api" "ml:$ml"; do
    local name=${pair%%:*} body=${pair#*:} got
    got=$(printf '%s' "$body" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p' | head -1)
    if printf '%s' "$body" | grep -q '"status":"ok"' && [ "$got" = "$rev" ]; then echo "  ok   $name · revision $got"
    else echo "  FAIL $name · revision ${got:-—} (ждём $rev) · ${body:0:160}"; bad=1; fi
  done
  for s in api ml web; do
    local id label
    id=$(compose_all ps -q "$s" 2>/dev/null || true)
    [ -n "$id" ] || { echo "  FAIL $s: контейнер не запущен"; bad=1; continue; }
    label=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
    [ "$label" = "$rev" ] || { echo "  FAIL $s: метка образа $label ≠ $rev"; bad=1; }
  done
  # воркер PDF.js (.mjs) — JavaScript: иначе при nosniff лист на экране верификации не рисуется (T-129)
  local mjs ct
  mjs=$(compose_all exec -T web sh -c 'ls /usr/share/nginx/html/assets | grep "\.mjs$" | head -1' 2>/dev/null || true)
  if [ -n "$mjs" ]; then
    ct=$(curl -fsSI --max-time 10 --cacert "$TLS/ca.crt" "$WEB/assets/$mjs" 2>/dev/null | tr -d '\r' | sed -n 's/^content-type: *//Ip' | head -1)
    case "$ct" in text/javascript*|application/javascript*) echo "  ok   web: воркер PDF.js ($mjs) · $ct" ;; *) echo "  FAIL web: воркер PDF.js отдаётся как ${ct:-—}"; bad=1 ;; esac
  fi
  [ "$bad" = 0 ] && echo "  стенд здоров: все сервисы healthy, revision = $rev" || return 1
}

cmd_down() {
  [ -f "$VAR/stand.env" ] || die "стенд не готовился"
  pkill -f scripts/egress-direct.py 2>/dev/null || true  # прокси мимо VPN нужен только поднятому стенду
  pkill -f scripts/load-guard.sh 2>/dev/null || true  # диспетчер нагрузки — тоже
  if [ "${1:-}" = "--wipe" ]; then
    say "down --wipe: контейнеры, тома (база, кэш блобов); данные MinIO → var/stand/КОРЗИНА"
    compose_all down -v
    if [ -d "$VAR/minio-data" ] && [ -n "$(ls -A "$VAR/minio-data")" ]; then
      local bin; bin="$VAR/КОРЗИНА/$(date +%F-%H%M%S)"; mkdir -p "$bin"; mv "$VAR/minio-data" "$bin/"; mkdir -p "$VAR/minio-data"
    fi
  else
    say "down (тома сохраняются; удалить — down --wipe)"
    compose_all down
  fi
}

cmd_logs() { compose_all logs --tail 200 "$@"; }

case ${1:-} in
  build) cmd_build ;;
  secrets) cmd_secrets ;;
  up) shift; cmd_up "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  prune) cmd_prune ;;
  down) shift; cmd_down "$@" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
