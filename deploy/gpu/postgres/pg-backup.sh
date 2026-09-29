#!/bin/sh
# NFR-BACKUP (T-072, ТЗ 12.8): ежедневный базовый бэкап PostgreSQL и чистка старше RETENTION_DAYS (30 дней).
#   pg-backup.sh once                  — базовый бэкап сегодняшнего дня (UTC) в $BACKUP_DIR/base/<ГГГГ-ММ-ДД>, затем prune
#   pg-backup.sh prune <каталог> <дни> — чистка: base/<дата> старше <дни> и WAL архива старше самого старого оставшегося бэкапа
#   pg-backup.sh loop                  — служба pg-backup: once сразу, затем каждый день в BACKUP_HOUR_UTC:00
#   pg-backup.sh check                 — healthcheck: свежий бэкап не старше 26 ч
# Бэкап: pg_basebackup -Ft -z -X fetch — самодостаточный архив (нужные WAL внутри base.tar.gz); восстановление на момент
# после бэкапа — этот архив плюс WAL из архива (wal-archive.sh), учение — scripts/restore-drill.sh.
# Подключение — сокетом /var/run/postgresql (общий том pg-run с сервером), роль postgres по peer (pg_hba: local replication):
# ни пароля, ни сети службе не нужно. POSIX sh — в образе postgres:*-alpine нет bash; даты — целочисленной арифметикой,
# без GNU/BusyBox date -d (тест гоняет чистку на маке с BSD date).
# Чистка WAL: удаляются сегменты, заархивированные раньше начала самого старого оставшегося базового бэкапа (метка
# .started) — для восстановления из любого хранимого бэкапа они не нужны; *.history (линии времени) не удаляются.
# Бэкапов не осталось — WAL не трогаем: без базы чистить нечего сверять.
# Для тестов: NOW — «сейчас» в секундах эпохи (по умолчанию date +%s).
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
WAL_ARCHIVE_DIR=${WAL_ARCHIVE_DIR:-/wal-archive}
RETENTION_DAYS=${RETENTION_DAYS:-30}
BACKUP_HOUR_UTC=${BACKUP_HOUR_UTC:-1}

log() { echo "pg-backup $(date -u '+%F %T') $*"; }

# Номер дня от 1970-01-01 по григорианской дате (алгоритм days_from_civil Х. Хиннанта)
days_from_civil() {
  y=$1; m=${2#0}; d=${3#0}
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  mp=$(((m + 9) % 12))
  doy=$(((153 * mp + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

today() { echo $(( ${NOW:-$(date +%s)} / 86400 )); }

# Удалить base/<ГГГГ-ММ-ДД>, чей возраст (сегодня − дата) больше <дни>: при 30 днях 31-дневный уходит, 30-дневный остаётся
prune() {
  root=$1; keep=$2
  case $keep in '' | *[!0-9]*) echo "pg-backup: срок хранения «$keep» — не число дней" >&2; exit 2 ;; esac
  t=$(today)
  for dir in "$root"/base/*; do
    [ -d "$dir" ] || continue
    name=${dir##*/}
    case $name in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) continue ;; esac
    age=$((t - $(days_from_civil "${name%%-*}" "$(echo "$name" | cut -d- -f2)" "${name##*-}")))
    if [ "$age" -gt "$keep" ]; then
      log "удаляю бэкап $name (возраст $age дн. > $keep)"
      rm -rf "$dir"
    fi
  done
  oldest=
  for dir in "$root"/base/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    [ -d "$dir" ] && { oldest=$dir; break; }
  done
  if [ -n "$oldest" ] && [ -f "$oldest/.started" ] && [ -d "$WAL_ARCHIVE_DIR" ]; then
    n=$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -type f ! -name '*.history' ! -name '.*' ! -newer "$oldest/.started" | wc -l)
    find "$WAL_ARCHIVE_DIR" -maxdepth 1 -type f ! -name '*.history' ! -name '.*' ! -newer "$oldest/.started" -exec rm -f {} +
    log "WAL старше бэкапа ${oldest##*/}: удалено $((n))"
  fi
}

once() {
  day=$(date -u +%F)
  dst=$BACKUP_DIR/base/$day
  if [ -d "$dst" ]; then log "бэкап $day уже есть"; else
    part=$dst.partial
    mark=$BACKUP_DIR/base/.started-$day
    mkdir -p "$BACKUP_DIR/base"
    rm -rf "$part"
    touch "$mark"
    log "pg_basebackup → $dst"
    # Явные проверки, а не set -e: в «once || …» цикла loop оболочка set -e внутри функции не соблюдает
    if ! pg_basebackup -D "$part" -Ft -z -X fetch --checkpoint=fast -l "inspector $day" \
      -h "${PGHOST:-/var/run/postgresql}" -U "${PGUSER:-postgres}" -w; then
      rm -rf "$part" "$mark"
      return 1
    fi
    mv "$mark" "$part/.started" && mv "$part" "$dst" || return 1
    log "готово: $(du -sk "$dst" | cut -f1) КБ"
  fi
  # чистка — только после успешного бэкапа: неудачный день не съедает самый старый из хранимых
  prune "$BACKUP_DIR" "$RETENTION_DAYS"
}

check() {
  newest=
  for dir in "$BACKUP_DIR"/base/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do [ -d "$dir" ] && newest=$dir; done
  [ -n "$newest" ] || { echo "нет ни одного бэкапа"; exit 1; }
  [ -n "$(find "$newest" -maxdepth 0 -mmin -1560)" ] || { echo "последний бэкап ${newest##*/} старше 26 ч"; exit 1; }
}

case ${1:-} in
  once) once ;;
  prune) [ $# -eq 3 ] || { echo "pg-backup: prune <каталог> <дни>" >&2; exit 2; }; prune "$2" "$3" ;;
  check) check ;;
  loop)
    trap 'exit 0' TERM INT
    while :; do
      once || log "ОШИБКА бэкапа — повтор в следующий запуск"
      now=$(date +%s)
      wait_s=$(( (86400 + BACKUP_HOUR_UTC * 3600 - now % 86400) % 86400 ))
      [ "$wait_s" -gt 0 ] || wait_s=86400
      log "следующий запуск через $wait_s с"
      sleep "$wait_s" &
      wait $!
    done
    ;;
  *) echo "pg-backup: once | prune <каталог> <дни> | loop | check" >&2; exit 2 ;;
esac
