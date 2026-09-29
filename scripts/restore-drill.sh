#!/usr/bin/env bash
# NFR-RECOVERY (T-072, ТЗ 11: RTO ≤ 1 ч, RPO ≤ 15 мин) — учение по восстановлению PostgreSQL из бэкапа и архива WAL.
# Конфигурация — та же, что в профиле gpu: deploy/gpu/postgres/backup.conf (флагами -c, как в compose.yml),
# wal-archive.sh как archive_command, pg-backup.sh once для базового бэкапа; образ — POSTGRES_IMAGE из deploy/gpu/.env.example.
#   1. мастер пишет строку drill(id, at) раз в секунду; 2. базовый бэкап; 3. запись идёт ещё PAUSE_S секунд (по умолчанию
#   420 — больше archive_timeout 300, чтобы хотя бы один сегмент закрылся по таймеру); 4. docker kill мастера — его том
#   данных дальше считается потерянным; 5. восстановление в новый контейнер: распаковка бэкапа, recovery.signal,
#   restore_command из архива, конец восстановления — продвижение (recovery_target не задан: вся доступная история).
# RTO — от начала восстановления до базы, готовой к записи, со сверенными строками; RPO — at последней подтверждённой
# записи до падения минус at последней восстановленной. Вердикт: RTO ≤ 3600 с, RPO ≤ 900 с, подтверждённые строки не потеряны
# сверх RPO (каждая подтверждённая строка с id ≤ последней восстановленной — на месте).
# Тома — именованные тома docker с уникальными именами (bind-каталог мака не годится под PGDATA: владелец и режим 0700
# через virtiofs не держатся); порты не публикуются — всё через docker exec. Всё гасится в trap.
# Запуск — только через замок тяжёлого: scripts/heavy.sh scripts/restore-drill.sh  →  var/restore-drill.json, docs/qa/BACKUP-DRILL.md
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PAUSE_S=${PAUSE_S:-420}
IMG=$(sed -nE 's/^POSTGRES_IMAGE=([^ #]+).*/\1/p' deploy/gpu/.env.example)
[ -n "$IMG" ] || { echo "restore-drill: POSTGRES_IMAGE не найден в deploy/gpu/.env.example" >&2; exit 1; }
P=inspector-drill-$$
M=$P-master R=$P-restore
VOLS=("$P-data" "$P-data2" "$P-wal" "$P-base")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/inspector-drill.XXXXXX")
WRITER=
PGPW=$(openssl rand -hex 16)
SCRIPTS=(-v "$ROOT/deploy/gpu/postgres/wal-archive.sh:/etc/postgresql/wal-archive.sh:ro" -v "$ROOT/deploy/gpu/postgres/pg-backup.sh:/etc/postgresql/pg-backup.sh:ro")

cleanup() {
  touch "$TMP/stop" 2>/dev/null || true
  [ -n "$WRITER" ] && kill "$WRITER" 2>/dev/null || true
  docker rm -f "$M" "$R" >/dev/null 2>&1 || true
  docker volume rm "${VOLS[@]}" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ts() { date '+%T'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
say() { echo "$(ts) restore-drill: $*"; }

# Строки backup.conf → флаги -c (значение без кавычек — как в command сервиса postgres в compose.yml)
CONF=()
while IFS= read -r line; do
  line=${line%%#*}
  [[ $line =~ ^[[:space:]]*([a-z_]+)[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*$ ]] || continue
  CONF+=(-c "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}")
done < deploy/gpu/postgres/backup.conf
[ ${#CONF[@]} -ge 8 ] || { echo "restore-drill: backup.conf разобран не полностью: ${CONF[*]}" >&2; exit 1; }

sql() { docker exec "$1" psql -U postgres -tAq -v ON_ERROR_STOP=1 -c "$2"; }
wait_ready() { # $1 — контейнер, $2 — секунд
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    docker exec "$1" pg_isready -q -h 127.0.0.1 -U postgres && return 0
    sleep 0.5
  done
  echo "restore-drill: $1 не принял соединение за $2 с" >&2; docker logs --tail 30 "$1" >&2; return 1
}

for v in "${VOLS[@]}"; do docker volume create "$v" >/dev/null; done
# новые тома создаются с владельцем root; сервер и pg-backup работают под uid 70
docker run --rm -u 0 -v "$P-wal:/wal-archive" -v "$P-base:/backups" "$IMG" sh -c 'chown 70:70 /wal-archive /backups && chmod 700 /wal-archive /backups'

say "мастер: $IMG ${CONF[*]}"
docker run -d --name "$M" -e POSTGRES_PASSWORD="$PGPW" -v "$P-data:/var/lib/postgresql" -v "$P-wal:/wal-archive" -v "$P-base:/backups" \
  "${SCRIPTS[@]}" "$IMG" postgres "${CONF[@]}" >/dev/null
# По TCP: во время init временный сервер слушает только сокет — готовность по TCP наступает после init
wait_ready "$M" 120
sql "$M" "create table drill (id serial primary key, at timestamptz not null default clock_timestamp())" >/dev/null

# Писатель: строка в секунду; в журнал — только подтверждённые сервером вставки (id|at в секундах эпохи)
(
  while [ ! -f "$TMP/stop" ]; do
    out=$(sql "$M" "insert into drill default values returning id || '|' || extract(epoch from at)" 2>/dev/null) && [ -n "$out" ] && echo "$out" >> "$TMP/writes.log"
    sleep 1
  done
) &
WRITER=$!
sleep 5

say "базовый бэкап (pg-backup.sh once)"
docker exec -u postgres "$M" sh /etc/postgresql/pg-backup.sh once
BASE=$(docker exec "$M" sh -c 'ls -1d /backups/base/[0-9]* | tail -n 1')
BASE_KB=$(docker exec "$M" du -sk "$BASE" | cut -f1)

say "запись продолжается $PAUSE_S с (archive_timeout — 300 с)"
sleep "$PAUSE_S"

say "docker kill мастера"
docker kill "$M" >/dev/null
touch "$TMP/stop"
wait "$WRITER" 2>/dev/null || true
WRITER=
LAST=$(tail -n 1 "$TMP/writes.log")
LAST_ID=${LAST%%|*}
LAST_AT=${LAST##*|}
WRITTEN=$(wc -l < "$TMP/writes.log" | tr -d ' ')
say "последняя подтверждённая запись до падения: id=$LAST_ID, всего подтверждено $WRITTEN"

# ── восстановление: отсчёт RTO
T0=$(now_ms)
docker run --rm -u 0 -v "$P-data2:/var/lib/postgresql" -v "$P-base:/backups:ro" "$IMG" sh -c "
  set -e
  mkdir -p \"\$PGDATA\"
  tar -xzf '$BASE/base.tar.gz' -C \"\$PGDATA\"
  touch \"\$PGDATA/recovery.signal\"
  echo \"restore_command = 'cp /wal-archive/%f %p'\" >> \"\$PGDATA/postgresql.auto.conf\"
  chown -R 70:70 /var/lib/postgresql
  chmod 700 \"\$PGDATA\"
"
docker run -d --name "$R" -e POSTGRES_PASSWORD="$PGPW" -v "$P-data2:/var/lib/postgresql" -v "$P-wal:/wal-archive" \
  "${SCRIPTS[@]}" "$IMG" postgres "${CONF[@]}" >/dev/null
wait_ready "$R" 3600
for ((i = 0; i < 7200; i++)); do
  [ "$(sql "$R" "select pg_is_in_recovery()")" = f ] && break
  sleep 0.5
done
[ "$(sql "$R" "select pg_is_in_recovery()")" = f ] || { echo "restore-drill: восстановление не закончилось за час" >&2; exit 1; }
read -r R_COUNT R_MAX R_AT < <(sql "$R" "select count(*), coalesce(max(id), 0), coalesce(extract(epoch from max(at)), 0) from drill" | tr '|' ' ')
# сверка: каждая подтверждённая строка с id ≤ последней восстановленной — на месте
IDS=$(awk -F'|' -v m="$R_MAX" '$1 <= m { printf "%s%s", (n++ ? "," : ""), $1 }' "$TMP/writes.log")
MISSING=$(sql "$R" "select count(*) from unnest(array[${IDS:-0}]::int[]) x where x not in (select id from drill)")
T1=$(now_ms)
WAL_FILES=$(docker exec "$R" sh -c 'ls /wal-archive | wc -l' | tr -d ' ')

RTO=$(awk -v a="$T0" -v b="$T1" 'BEGIN { printf "%.1f", (b - a) / 1000 }')
RPO=$(awk -v a="$LAST_AT" -v b="$R_AT" 'BEGIN { d = a - b; if (d < 0) d = 0; printf "%.1f", d }')
LOST=$((LAST_ID - R_MAX))
OK=$(awk -v r="$RTO" -v p="$RPO" -v m="$MISSING" 'BEGIN { print (r <= 3600 && p <= 900 && m == 0) ? "true" : "false" }')
REV=$(git rev-parse --short HEAD 2>/dev/null || echo "нет git")
[ -n "$(git status --porcelain 2>/dev/null)" ] && REV="$REV + незакоммиченные правки"
DATE=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
say "RTO $RTO с, RPO $RPO с, потеряно строк $LOST, пропусков $MISSING → ok=$OK"

mkdir -p var docs/qa
cat > var/restore-drill.json <<JSON
{
 "date": "$DATE",
 "image": "$IMG",
 "revision": "$REV",
 "pause_s": $PAUSE_S,
 "archive_timeout_s": 300,
 "base_backup": { "dir": "$BASE", "kb": $BASE_KB },
 "wal_files_in_archive": $WAL_FILES,
 "written_before_kill": { "rows": $WRITTEN, "last_id": $LAST_ID, "last_at_epoch": $LAST_AT },
 "restored": { "rows": $R_COUNT, "last_id": $R_MAX, "last_at_epoch": $R_AT, "missing_confirmed_rows": $MISSING },
 "rto_s": $RTO,
 "rpo_s": $RPO,
 "rows_lost": $LOST,
 "limits": { "rto_s": 3600, "rpo_s": 900 },
 "ok": $OK
}
JSON

if [ "$OK" = true ]; then
  VERDICT="**Вердикт: ✅ выполнено** — RTO $RTO с ≤ 3600 с, RPO $RPO с ≤ 900 с, подтверждённые строки до точки восстановления на месте."
else
  VERDICT="**Вердикт: ❌ не выполнено** — RTO $RTO с (предел 3600), RPO $RPO с (предел 900), пропущено подтверждённых строк: $MISSING."
fi
cat > docs/qa/BACKUP-DRILL.md <<MD
---
id: QA-BACKUP-DRILL
title: "NFR-BACKUP, NFR-RECOVERY — учение по восстановлению PostgreSQL (ТЗ 11, 12.8)"
type: qa-report
status: draft
owner: "@almaz"
created: ${DATE:0:10}
traces_to: [NFR-BACKUP, NFR-RECOVERY]
tags: [qa, backup, recovery]
---

# Учение по восстановлению из бэкапа и архива WAL

$VERDICT

Критерий (ТЗ 11): RTO ≤ 1 ч, RPO ≤ 15 мин. Сгенерировано \`scripts/restore-drill.sh\` $DATE; сырые данные — \`var/restore-drill.json\`.

| Показатель | Значение |
|---|---|
| RTO — от начала восстановления до базы, готовой к записи, со сверкой строк | **$RTO с** |
| RPO — последняя подтверждённая запись до падения минус последняя восстановленная | **$RPO с** |
| Подтверждено записей до падения | $WRITTEN (последняя id $LAST_ID) |
| Восстановлено строк | $R_COUNT (последняя id $R_MAX); потеряно $LOST, пропусков среди подтверждённых до точки восстановления — $MISSING |
| Базовый бэкап | \`$BASE\`, $BASE_KB КБ |
| Сегментов и файлов в архиве WAL | $WAL_FILES |

## Как шло

1. PostgreSQL \`$IMG\` с флагами из \`deploy/gpu/postgres/backup.conf\` — теми же, что у сервиса postgres профиля gpu
   (\`archive_mode=on\`, \`archive_command\` → \`wal-archive.sh\`, \`archive_timeout=300\`).
2. Писатель вставлял строку \`drill(id, at)\` раз в секунду; через 5 с — базовый бэкап \`pg-backup.sh once\`
   (\`pg_basebackup -Ft -z -X fetch\`), тем же скриптом, что служба \`pg-backup\`.
3. Запись шла ещё $PAUSE_S с, затем \`docker kill\` мастера; его том данных дальше не используется.
4. Новый контейнер: распаковка базового бэкапа, \`recovery.signal\`, \`restore_command = 'cp /wal-archive/%f %p'\`;
   цели восстановления нет — применяется весь архив, затем продвижение.

## Оговорка

Учение — на маке в docker, база маленькая (одна таблица, сотни строк): RTO здесь — нижняя оценка, на проде он растёт
с объёмом базы и числом сегментов WAL после бэкапа. RPO определяется \`archive_timeout\` (300 с) и не зависит от объёма:
незаархивированный хвост текущего сегмента теряется при потере диска с данными. Копия вне хоста —
\`compose.backup-s3.yml\` (раз в 5 минут); её восстановление здесь не проверялось.
Ревизия: \`$REV\`.
MD
say "итог: var/restore-drill.json, docs/qa/BACKUP-DRILL.md"
[ "$OK" = true ]
