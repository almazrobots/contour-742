#!/bin/sh
# NFR-CRYPTO (ТЗ 12.3-01): данные в покое лежат только на зашифрованном блочном устройстве (dm-crypt/LUKS).
#   at-rest-check.sh [--compose-project ИМЯ]… [--docker-volume ТОМ]… [ПУТЬ]…
#     --compose-project — все именованные тома проекта compose (база postgres-data, блобы api-blobs, журналы…);
#     --docker-volume   — один том docker: проверяется его Mountpoint;
#     ПУТЬ              — каталог на хосте (бэкапы и архив WAL T-136).
# Для каждого: findmnt -n -o SOURCE -T <путь> → lsblk -s -n -o TYPE <устройство> обязан содержать crypt
# (цепочка «вниз» до дисков, с глифами дерева: lvm → └─crypt → └─part — годится crypt на любом уровне).
# tmpfs и ramfs — в памяти, годятся.
# Не зашифровано хоть одно — код 1 с именами. Явный обход — INSPECTOR_AT_REST_WAIVER=<причина>: код 0 и
# предупреждение в stderr с причиной (стенд без LUKS на время приёмки — решение владельца, а не тишина).
# Коды: 0 — всё зашифровано (или обход); 1 — есть незашифрованное или проверка невозможна; 2 — неверный вызов.
set -eu
me=at-rest-check
say() { printf '%s: %s\n' "$me" "$*"; }
err() { printf '%s: %s\n' "$me" "$*" >&2; }

targets=$(mktemp) # строки «метка<TAB>путь»; путь не секрет, файл во временном каталоге
trap 'rm -f "$targets"' EXIT
tab=$(printf '\t')
add() { printf '%s\t%s\n' "$1" "$2" >>"$targets"; }
volume_path() {
  docker volume inspect -f '{{.Mountpoint}}' "$1" 2>/dev/null || { err "том docker $1 не найден"; return 1; }
}

fail=0
while [ $# -gt 0 ]; do
  case $1 in
    --compose-project)
      [ $# -ge 2 ] || { err "--compose-project: нужно имя проекта"; exit 2; }
      vols=$(docker volume ls -q --filter "label=com.docker.compose.project=$2") || { err "docker volume ls не удался"; exit 1; }
      [ -n "$vols" ] || { err "у проекта $2 нет томов — нечего проверять (сначала docker compose up --no-start)"; exit 1; }
      for v in $vols; do
        if mp=$(volume_path "$v"); then add "том $v" "$mp"; else fail=1; fi
      done
      shift 2 ;;
    --docker-volume)
      [ $# -ge 2 ] || { err "--docker-volume: нужно имя тома"; exit 2; }
      if mp=$(volume_path "$2"); then add "том $2" "$mp"; else fail=1; fi
      shift 2 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) err "неизвестный ключ $1"; exit 2 ;;
    *) add "$1" "$1"; shift ;;
  esac
done
[ -s "$targets" ] || [ "$fail" -ne 0 ] || { err "не задано, что проверять"; exit 2; }

bad=""
while IFS="$tab" read -r label path; do
  if ! src=$(findmnt -n -o SOURCE -T "$path" 2>/dev/null) || [ -z "$src" ]; then
    err "НЕ ПРОВЕРЕНО: $label ($path) — findmnt не нашёл точку монтирования"
    bad="$bad
  $label"
    continue
  fi
  fstype=$(findmnt -n -o FSTYPE -T "$path" 2>/dev/null || true)
  case $fstype in tmpfs | ramfs)
    say "ok  $label → $fstype (в памяти, не на диске)"
    continue ;;
  esac
  dev=${src%%\[*} # bind-монтирование: «/dev/mapper/data[/подкаталог]»
  if lsblk -s -n -o TYPE "$dev" 2>/dev/null | grep -qw crypt; then
    say "ok  $label → $dev (crypt)"
  else
    err "НЕ ЗАШИФРОВАН: $label ($path на $dev) — нет слоя dm-crypt/LUKS"
    bad="$bad
  $label"
  fi
done <"$targets"

if [ -n "$bad" ] || [ "$fail" -ne 0 ]; then
  if [ -n "${INSPECTOR_AT_REST_WAIVER:-}" ]; then
    err "ПРЕДУПРЕЖДЕНИЕ: данные в покое НЕ зашифрованы, проверка обойдена явно (INSPECTOR_AT_REST_WAIVER): ${INSPECTOR_AT_REST_WAIVER}"
    exit 0
  fi
  err "стенд не стартует: данные в покое обязаны лежать на dm-crypt/LUKS (ТЗ 12.3). Не зашифровано:$bad"
  exit 1
fi
say "все проверенные данные в покое — на зашифрованных устройствах"
