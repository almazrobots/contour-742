#!/bin/sh
# NFR-BACKUP (T-072): archive_command сервера PostgreSQL — копия сегмента WAL в архив (том pg-wal-archive).
#   wal-archive.sh <%p путь сегмента> <%f имя сегмента>
# По документации PostgreSQL (25.3.1): уже существующий файл архива не перезаписывается. Тот же сегмент с тем же
# содержимым (повтор после сбоя между копированием и ответом серверу) — успех; с другим содержимым — отказ (exit 1):
# сервер будет повторять, а оператор увидит ошибку в журнале, вместо тихой подмены истории.
# Запись атомарна: копия во временное имя, fsync, затем жёсткая ссылка на итоговое имя — ln не перезаписывает
# существующий файл, поэтому полусписанного или подменённого сегмента в архиве не бывает.
# Каталог архива — WAL_ARCHIVE_DIR (по умолчанию /wal-archive; переопределяется для scripts/backup.test.mjs).
# POSIX sh: в образе postgres:*-alpine нет bash.
set -eu
[ $# -eq 2 ] || { echo "wal-archive: ждём <путь %p> <имя %f>" >&2; exit 2; }
src=$1
name=$2
dir=${WAL_ARCHIVE_DIR:-/wal-archive}
dst=$dir/$name

same_or_fail() {
  if cmp -s "$src" "$dst"; then exit 0; fi
  echo "wal-archive: $name уже в архиве с другим содержимым — не перезаписываю" >&2
  exit 1
}

[ -e "$dst" ] && same_or_fail
tmp=$dir/.$name.tmp.$$
trap 'rm -f "$tmp"' EXIT
cp "$src" "$tmp"
sync "$tmp" 2>/dev/null || sync
# гонка «проверили — появился» невозможна при одном архиваторе, но ln всё равно не перезапишет
ln "$tmp" "$dst" 2>/dev/null || same_or_fail
