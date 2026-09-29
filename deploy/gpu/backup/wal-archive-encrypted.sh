#!/bin/sh
# NFR-CRYPTO (ТЗ 12.3-01) × T-136: archive_command с шифрованием «в покое» — пример стыка.
#   archive_command = '/opt/backup/wal-archive-encrypted.sh %p %f'
# Окружение: WAL_ARCHIVE_DIR — каталог архива; AT_REST_RECIPIENT_CERT — сертификат получателя (закрытого ключа нет).
# Сегмент ложится каталогом $WAL_ARCHIVE_DIR/%f (формат at-rest-encrypt.sh), атомарно.
# Повтор той же архивации (PostgreSQL повторяет после сбоя) сравнивается по SHA-256 ОТКРЫТОГО текста (plain.sha256):
# то же содержимое — 0, другое — отказ без перезаписи (как same_or_fail в wal-archive.sh T-136).
set -eu
me=wal-archive-encrypted
die() { printf '%s: %s\n' "$me" "$*" >&2; exit 1; }

[ $# -eq 2 ] || die "вызов: $me %p %f"
src=$1
name=$2
: "${WAL_ARCHIVE_DIR:?WAL_ARCHIVE_DIR — каталог архива WAL}"
: "${AT_REST_RECIPIENT_CERT:?AT_REST_RECIPIENT_CERT — сертификат получателя}"
# %f — имя сегмента или .history/.backup: без путей и скрытых имён
case $name in '' | */* | .*) die "недопустимое имя сегмента «${name}»" ;; esac
[ -f "$src" ] || die "нет файла сегмента $src"
dest="$WAL_ARCHIVE_DIR/$name"

if [ -e "$dest" ]; then
  [ -f "$dest/plain.sha256" ] || die "$dest есть, но без plain.sha256 — архив повреждён, разбор вручную"
  have=$(openssl dgst -sha256 -r <"$src" | cut -d' ' -f1)
  if [ "$have" = "$(cut -d' ' -f1 <"$dest/plain.sha256")" ]; then
    printf '%s: %s уже в архиве, содержимое совпало\n' "$me" "$name" >&2
    exit 0
  fi
  die "в архиве другой $name (SHA-256 открытого текста различается) — не перезаписываю"
fi
exec "$(dirname -- "$0")/at-rest-encrypt.sh" -r "$AT_REST_RECIPIENT_CERT" -o "$dest" <"$src"
