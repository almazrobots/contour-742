#!/bin/sh
# Запуск стенда профиля gpu с проверкой шифрования данных в покое (NFR-CRYPTO, ТЗ 12.3-01).
#   deploy/gpu/up.sh [--s3] [аргументы docker compose up…]
#     --s3 — с надстройкой compose.s3.yml (блобы в бакете, ADR-0006).
# Порядок: docker compose up --no-start (создаёт тома, ничего не запускает) → at-rest-check.sh по всем томам проекта и
# по каталогам AT_REST_EXTRA_PATHS (бэкапы и архив WAL T-136, через пробел) → docker compose up -d --wait.
# Не зашифровано — стенд не стартует; обход только явный: INSPECTOR_AT_REST_WAIVER=<причина>.
# Окружение: файл .env рядом (или INSPECTOR_GPU_ENV); выкатка — только после «да» владельца (правило №2).
set -eu
here=$(cd "$(dirname -- "$0")" && pwd)
project=${COMPOSE_PROJECT_NAME:-inspector-gpu} # name: в compose.yml
env_file=${INSPECTOR_GPU_ENV:-$here/.env}
s3=0
if [ "${1:-}" = --s3 ]; then s3=1; shift; fi

compose() {
  if [ "$s3" -eq 1 ]; then
    docker compose --project-directory "$here" -p "$project" -f "$here/compose.yml" -f "$here/compose.s3.yml" --env-file "$env_file" "$@"
  else
    docker compose --project-directory "$here" -p "$project" -f "$here/compose.yml" --env-file "$env_file" "$@"
  fi
}

compose up --no-start
# каталоги бэкапов и архива WAL — из окружения, иначе строкой AT_REST_EXTRA_PATHS= из .env (файл не исполняется)
extra=${AT_REST_EXTRA_PATHS-$(sed -n 's/^AT_REST_EXTRA_PATHS=//p' "$env_file" 2>/dev/null | tail -n 1)}
# T136-M2 (OWASP R2): каталоги службы pg-backup (PG_BACKUP_DIR, PG_WAL_ARCHIVE_DIR, T-072) проверяются всегда — забыть их
# в AT_REST_EXTRA_PATHS нельзя; дамп базы с ПДн не лежит на диске без dm-crypt/LUKS
envval() { eval "v=\${$1-}"; [ -n "$v" ] && { printf '%s' "$v"; return; }; sed -n "s/^$1=//p" "$env_file" 2>/dev/null | tail -n 1; }
for k in PG_BACKUP_DIR PG_WAL_ARCHIVE_DIR; do v=$(envval "$k"); [ -n "$v" ] && extra="$extra $v"; done
# shellcheck disable=SC2086 # список путей через пробел
"$here/at-rest-check.sh" --compose-project "$project" $extra
compose up -d --wait "$@"
