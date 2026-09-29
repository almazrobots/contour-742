#!/usr/bin/env bash
# T-231, вариант А закрытия OWASP-0191: ключ хранения блобов на стенде nadzorium-gpu (HOSTKEY 54831, 158.255.3.179).
# Файлы пакетов в /opt/stand-gpu/blobs становятся IBE1 (AES-256-GCM с key_id, NFR-CRYPTO — тот же механизм, что в проде:
# INSPECTOR_BLOB_KEY_FILE + INSPECTOR_BLOB_WORK_DIR в tmpfs, deploy/gpu-stand/compose.at-rest.yml).
# ПО УМОЛЧАНИЮ НИЧЕГО НЕ МЕНЯЕТ (--dry-run): печатает план и проверки. Менять — только с --apply и после «да» владельца.
#
#   scripts/pdn-at-rest-a.sh [plan]              проверки (только чтение) и план — сервер не меняется
#   scripts/pdn-at-rest-a.sh migrate [--apply]   ключ (600, вне git) → api и ml с ключом → шифрование блобов → сверка →
#                                                fstrim освобождённых блоков; ключ владельцу — var/gpu-stand/ (600)
#   scripts/pdn-at-rest-a.sh verify              только чтение: все блобы IBE1 и расшифровываются ключом, API жив
#   scripts/pdn-at-rest-a.sh rollback [--apply]  расшифровать блобы обратно, ключ → *.disabled-<время>, api и ml без ключа
#   scripts/pdn-at-rest-a.sh key-to-owner        копия ключа владельцу в var/gpu-stand/blob_encryption_key (600)
# Ключ в вывод и в чат не попадает. В менеджер паролей: pbcopy < var/gpu-stand/blob_encryption_key → вставить →
# pbcopy < /dev/null.
# Флаг --busy-ok — не ждать пустой очереди разбора (перезапуск ML оборвёт идущий разбор).
#
# НЕ закрывает (явно): /opt/corpus (78 ГБ), /opt/inspector и /opt/stand-gpu/pkg (5,3 ГБ, одни и те же inode),
# /opt/t184 (3,3 ГБ), кэши разбора /opt/inspector/cache и /opt/stand-gpu/readers, тома postgres-data и redis-data
# (текст документов, ФИО), своп (20 ГБ, туда может уйти и tmpfs), журналы. Это — вариант Б или вывод сервера.
set -euo pipefail

HOST=${PDN_HOST:-root@158.255.3.179}
R=${PDN_ROOT:-}                       # префикс путей (только для тестов)
BASE=$R/opt/stand-gpu
SRC=$BASE/src
SEC=$BASE/secrets
BLOBS=$BASE/blobs
KEY=$SEC/blob_encryption_key
ENV_FILE=$BASE/stand.env
OVR=$SRC/deploy/gpu-stand/compose.at-rest.yml
PROC=${PDN_PROC:-/proc}
SHA_GLOB='????????????????????????????????????????????????????????????????'
MIN_FREE_GB=20                        # правило №0

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { echo "pdn-at-rest-a: $*" >&2; exit 1; }

cmd=plan; APPLY=0; BUSY_OK=0
for a in "$@"; do
  case $a in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --busy-ok) BUSY_OK=1 ;;
    plan|migrate|verify|rollback|key-to-owner) cmd=$a ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "pdn-at-rest-a: неизвестный аргумент $a" >&2; exit 2 ;;
  esac
done

# ─────────────────────────────── мак
if [ "${PDN_REMOTE:-}" != 1 ]; then
  cd "$(dirname "$0")/.."
  MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
  LOCAL_VAR="$MAIN_ROOT/var/gpu-stand"
  key_to_owner() {
    mkdir -p "$LOCAL_VAR"; chmod 700 "$LOCAL_VAR"
    (umask 077; ssh "$HOST" "cat $KEY" > "$LOCAL_VAR/blob_encryption_key.tmp")
    [ -s "$LOCAL_VAR/blob_encryption_key.tmp" ] || { rm -f "$LOCAL_VAR/blob_encryption_key.tmp"; die "ключ не получен"; }
    mv "$LOCAL_VAR/blob_encryption_key.tmp" "$LOCAL_VAR/blob_encryption_key"; chmod 600 "$LOCAL_VAR/blob_encryption_key"
    echo "  ключ владельцу: $LOCAL_VAR/blob_encryption_key (600, вне git). В менеджер паролей: pbcopy < этот файл → вставить → pbcopy < /dev/null"
  }
  if [ "$cmd" = key-to-owner ]; then key_to_owner; exit 0; fi
  flags=(); [ "$APPLY" = 1 ] && flags+=(--apply); [ "$BUSY_OK" = 1 ] && flags+=(--busy-ok)
  ssh "$HOST" "PDN_REMOTE=1 bash -s -- $cmd ${flags[*]:-}" < "$0"
  if [ "$cmd" = migrate ] && [ "$APPLY" = 1 ]; then key_to_owner; fi
  exit 0
fi

# ─────────────────────────────── сервер
run() {  # изменяющая команда: в --dry-run только печатается
  if [ "$APPLY" = 1 ]; then printf '  + %s\n' "$*"; "$@"; else printf '  [dry-run] %s\n' "$*"; fi
}
compose_base() { docker compose --project-directory "$SRC/deploy/gpu-stand" -f "$SRC/deploy/gpu-stand/compose.yml" --env-file "$ENV_FILE" "$@"; }
compose_key() { docker compose --project-directory "$SRC/deploy/gpu-stand" -f "$SRC/deploy/gpu-stand/compose.yml" -f "$OVR" --env-file "$ENV_FILE" "$@"; }
api_image() { grep '^API_IMAGE=' "$ENV_FILE" | cut -d= -f2; }
free_gb() { echo $(( $(df -Pk "$1" | awk 'NR==2 {print $4}') / 1024 / 1024 )); }
mem_avail_gb() { awk '/^MemAvailable:/ {print int($2/1024/1024)}' "$PROC/meminfo"; }
ibe1_count() {  # файлы с магией IBE1 среди файлов с именем SHA-256
  local n=0 f name
  for f in "$BLOBS"/*; do
    name=${f##*/}
    [ ${#name} -eq 64 ] || continue
    case $name in *[!0-9a-f]*) continue ;; esac
    [ -f "$f" ] || continue
    if [ "$(head -c 4 "$f")" = IBE1 ]; then n=$((n + 1)); fi
  done
  echo "$n"
}
queue_depth() {  # сообщений в очередях RabbitMQ стенда (в том числе неподтверждённых); пусто — 0
  compose_base exec -T rabbitmq rabbitmqctl -q list_queues messages 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {s += $1} END {print s + 0}'
}
# шифрование и откат — в контейнере образа API: uid API, без сети, только чтение кроме каталога блобов
node_in_api() {  # $1 — скрипт в /app; дальше — аргументы
  local script=$1; shift
  run docker run --rm --network none --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true --memory 6g \
    -v "$SRC/apps/api/src:/app/apps/api/src:ro" -v "$SRC/deploy/gpu-stand:/app/deploy/gpu-stand:ro" \
    -v "$BLOBS:/blobs" -v "$KEY:/run/blob_key:ro" \
    --entrypoint node "$(api_image)" "$script" --dir /blobs --key-file /run/blob_key "$@"
}

BLOCKERS=()
block() { BLOCKERS+=("$*"); printf '  \033[31mблокер:\033[0m %s\n' "$*"; }

preflight() {
  say "проверки (только чтение)"
  [ -d "$BLOBS" ] || die "нет каталога блобов $BLOBS"
  [ -s "$ENV_FILE" ] || die "нет $ENV_FILE — стенд не поднимался (gpu-stand.sh images/up)"
  local n size_mb big free mem ibe q
  n=$(find "$BLOBS" -maxdepth 1 -type f -name "$SHA_GLOB" | wc -l | tr -d ' ')
  size_mb=$(( $(du -sk "$BLOBS" | awk '{print $1}') / 1024 ))
  big=$(ls -lnS "$BLOBS" | awk 'NR==2 {print $5}')
  free=$(free_gb "$BASE")
  mem=$(mem_avail_gb)
  ibe=$(ibe1_count)
  note "блобы: $n файлов, ${size_mb} МБ, самый большой ${big:-0} байт; уже IBE1: $ibe"
  note "свободно на диске: ${free} ГБ; RAM доступно: ${mem} ГБ"
  [ "$free" -ge "$MIN_FREE_GB" ] || block "свободно ${free} ГБ < ${MIN_FREE_GB} (правило №0)"
  # пик памяти: tmpfs blob-work до 9 ГБ под разбор + шифрование одного файла (~3 × самый большой) — просим 16 ГБ запаса
  [ "$mem" -ge 16 ] || block "RAM доступно ${mem} ГБ < 16: tmpfs blob-work (9 ГБ) и шифрование не влезут без свопа"
  [ "${big:-0}" -lt 2147483647 ] || block "есть блоб больше 2 ГиБ — blobs-encrypt читает файл буфером, нужен потоковый режим"
  [ -f "$SRC/apps/api/src/cli/blobs-encrypt.ts" ] || block "на сервере нет apps/api/src/cli/blobs-encrypt.ts — gpu-stand.sh ship"
  if [ -f "$OVR" ] && [ -f "$SRC/deploy/gpu-stand/blobs-decrypt.mjs" ]; then
    if [ -s "$KEY" ]; then
      compose_key config -q >/dev/null 2>&1 || block "compose.yml + compose.at-rest.yml не сливаются (docker compose config)"
    fi
  else
    block "на сервере нет compose.at-rest.yml / blobs-decrypt.mjs — влить T-231 в main и gpu-stand.sh ship"
  fi
  if [ -s "$KEY" ]; then note "ключ хранения уже есть: $KEY (не перезаписывается)"; else note "ключа хранения нет — будет создан"; fi
  q=$(queue_depth)
  note "очередь разбора: $q сообщений"
  if [ "$q" -gt 0 ] && [ "$BUSY_OK" != 1 ]; then block "в очереди $q сообщений: перезапуск ML оборвёт разбор — дождаться пустой или --busy-ok"; fi
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    [ "$APPLY" != 1 ] || die "есть блокеры (${#BLOCKERS[@]}) — --apply не выполняется"
    note "блокеров: ${#BLOCKERS[@]} — до --apply их нужно снять"
  fi
}

not_covered() {
  say "вариант А НЕ закрывает (открытым текстом на диске остаётся)"
  note "/opt/corpus — 78 ГБ корпуса (ADR-0002: только потоком; на диске по решению T-165 без исключения)"
  note "/opt/inspector/blobs и /opt/stand-gpu/pkg — 5,3 ГБ (жёсткие ссылки, одни inode): исходники пакетов POL-17, LOS-3A"
  note "/opt/t184 — 3,3 ГБ прогона GPU-OCR; /opt/inspector/cache, /opt/stand-gpu/readers — текст страниц"
  note "тома nadzorium-gpu_postgres-data (80 МБ) и _redis-data (0,5 ГБ, кэш разбора — текст документов)"
  note "своп: LV 4 ГБ + /swapfile2 16 ГБ — страницы процессов и tmpfs blob-work"
  note "уже удалённые блоки ext4 без TRIM; журналы systemd с именами файлов"
}

cmd_plan() {
  preflight
  say "план migrate (ничего не выполнено)"
  note "1. ключ: openssl rand -hex 32 → $KEY (600, 1000:1000), копия владельцу var/gpu-stand/ на маке"
  note "2. api и ml пересоздаются с compose.at-rest.yml: API читает открытый текст (наследие) и пишет новое IBE1;"
  note "   ML читает только tmpfs blob-work — простой API ~1 мин, ML ~2–3 мин (start_period 120 с); W1 не трогается"
  note "3. blobs-encrypt.ts --dry-run, затем без него: 5,8 ГБ ≈ 1–2 мин (AES-GCM + запись), по файлу, атомарно"
  note "4. сверка: все файлы IBE1, повторный --dry-run даёт «уже зашифровано: все», /health"
  note "5. fstrim -v / — освобождённые блоки со старым открытым текстом возвращаются контроллеру (TRIM)"
  not_covered
}

cmd_migrate() {
  preflight
  say "1. ключ хранения"
  if [ -s "$KEY" ]; then
    note "есть — не трогаю"
  else
    run sh -c "umask 077 && openssl rand -hex 32 | tr -d '\\n' > '$KEY.tmp' && mv '$KEY.tmp' '$KEY'"
    run chown 1000:1000 "$KEY"
    run chmod 600 "$KEY"
  fi
  say "2. api и ml с ключом (compose.at-rest.yml)"
  run compose_key up -d --wait --wait-timeout 600 api ml
  say "3. шифрование блобов: сначала проверка без записи, затем запись"
  node_in_api apps/api/src/cli/blobs-encrypt.ts --dry-run
  node_in_api apps/api/src/cli/blobs-encrypt.ts
  say "4. сверка"
  cmd_verify_inner
  say "5. TRIM освобождённых блоков (старые копии открытого текста)"
  run fstrim -v /
  not_covered
}

cmd_verify_inner() {
  if [ "$APPLY" != 1 ]; then note "[dry-run] сверка: IBE1 у всех файлов, blobs-encrypt --dry-run → «уже зашифровано», /health api"; return 0; fi
  local n ibe
  n=$(find "$BLOBS" -maxdepth 1 -type f -name "$SHA_GLOB" | wc -l | tr -d ' ')
  ibe=$(ibe1_count)
  note "IBE1: $ibe из $n"
  [ "$n" = "$ibe" ] || die "не все файлы зашифрованы ($ibe из $n) — смотреть сводку blobs-encrypt"
  node_in_api apps/api/src/cli/blobs-encrypt.ts --dry-run
  compose_key ps api ml --format '{{.Service}} {{.Status}}'
}

cmd_verify() {
  local was=$APPLY; APPLY=1
  [ -s "$KEY" ] || die "ключа нет — вариант А не включён"
  cmd_verify_inner
  APPLY=$was
}

cmd_rollback() {
  [ -s "$KEY" ] || die "ключа нет — откатывать нечего"
  say "откат варианта А: блобы снова открытым текстом, API без ключа"
  local q; q=$(queue_depth)
  if [ "$q" -gt 0 ] && [ "$BUSY_OK" != 1 ]; then die "в очереди $q сообщений — дождаться или --busy-ok"; fi
  # API останавливается: иначе новый приём между расшифровкой и перезапуском ляжет IBE1 и станет нечитаемым
  run compose_key stop api
  node_in_api deploy/gpu-stand/blobs-decrypt.mjs --dry-run
  node_in_api deploy/gpu-stand/blobs-decrypt.mjs
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  # ключ не удаляется: копия для чтения старых бэкапов/выгрузок; gpu-stand.sh видит только blob_encryption_key
  run mv "$KEY" "$KEY.disabled-$ts"
  run compose_base up -d --wait --wait-timeout 600 api ml
  if [ "$APPLY" = 1 ]; then
    [ "$(ibe1_count)" = 0 ] || die "после отката остались файлы IBE1"
    note "готово: IBE1 не осталось, ключ — $KEY.disabled-$ts"
  fi
}

case $cmd in
  plan) cmd_plan ;;
  migrate) cmd_migrate ;;
  verify) cmd_verify ;;
  rollback) cmd_rollback ;;
  *) die "команда: plan | migrate [--apply] | verify | rollback [--apply] | key-to-owner" ;;
esac
