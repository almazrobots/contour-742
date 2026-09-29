#!/bin/sh
# NFR-CRYPTO (ТЗ 12.3-01) × T-136: restore_command для архива wal-archive-encrypted.sh.
#   restore_command = '/opt/backup/wal-restore-encrypted.sh %f %p'
# Окружение: WAL_ARCHIVE_DIR; AT_REST_RECIPIENT_CERT и AT_REST_RECIPIENT_KEY — ключ приносят на время восстановления.
# Нет сегмента в архиве — код 1 молча: для PostgreSQL это штатный «конец архива».
set -eu
me=wal-restore-encrypted
[ $# -eq 2 ] || { printf '%s: вызов: %s %%f %%p\n' "$me" "$me" >&2; exit 2; }
name=$1
target=$2
: "${WAL_ARCHIVE_DIR:?WAL_ARCHIVE_DIR — каталог архива WAL}"
case $name in '' | */* | .*) printf '%s: недопустимое имя «%s»\n' "$me" "$name" >&2; exit 2 ;; esac
[ -d "$WAL_ARCHIVE_DIR/$name" ] || exit 1
exec "$(dirname -- "$0")/at-rest-decrypt.sh" -o "$target" "$WAL_ARCHIVE_DIR/$name"
