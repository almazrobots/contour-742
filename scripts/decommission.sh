#!/usr/bin/env bash
# T-231: вывод GPU-сервера HOSTKEY 54831 (158.255.3.179) из работы — уничтожение ПДн (OWASP-0191, 152-ФЗ ст. 21 ч. 5)
# с записью в журнал переносов (translog, правило №1 ~/.claude/CLAUDE.md).
# ПО УМОЛЧАНИЮ НИЧЕГО НЕ МЕНЯЕТ (--dry-run). Менять — только с --apply --confirm 54831 и после «да» владельца на вывод.
#
#   scripts/decommission.sh [plan]                         только чтение: что лежит, чем будет стёрто
#   scripts/decommission.sh online  [--apply --confirm 54831]   на живой ОС: стоп всех контейнеров (стенд, W1, vLLM),
#       крипто-стирание (LUKS варианта Б — luksErase; ключ варианта А — удаление), удаление каталогов ПДн и томов,
#       своп, журналы, fstrim. Сервер остаётся загружаемым, но без данных. Полной гарантии на SSD не даёт.
#   scripts/decommission.sh rescue  [--apply --confirm 54831]   ТОЛЬКО из rescue-системы HOSTKEY (корень не на nvme0n1):
#       стирание NVMe целиком контроллером — sanitize (block erase) → format --ses=1 → blkdiscard, проверка нулями
#   scripts/decommission.sh log --method <как> --evidence <файл> [--apply]   запись в translog (на маке)
#
# Порядок: online → панель HOSTKEY: загрузка в rescue → rescue → log → сдача сервера (тикет — только про их слой,
# /vendor-support). Копии данных вне сервера: корпус — yandex:…/corpus-ABC и бакет nadzorium (ADR-0007), результаты
# стенда — выгрузить до online, если нужны (база стенда есть только здесь).
set -euo pipefail

HOST=${PDN_HOST:-root@158.255.3.179}
SERVER_ID=54831
R=${PDN_ROOT:-}
DEV=${PDN_NVME_DEV:-/dev/nvme0n1}
CTRL=${PDN_NVME_CTRL:-/dev/nvme0}
PDN_DIRS="opt/stand-gpu opt/corpus opt/inspector opt/t184 opt/w1-gate/eval"
IMG=$R/srv/pdn.luks
SWAP_LV=${PDN_SWAP_LV:-/dev/mapper/vg54831-swap}
DD_FLAGS=${PDN_DD_FLAGS-iflag=direct}

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { echo "decommission: $*" >&2; exit 1; }

cmd=plan; APPLY=0; CONFIRM=""; METHOD=""; EVIDENCE=""
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --confirm) CONFIRM=${2:-}; shift ;;
    --method) METHOD=${2:-}; shift ;;
    --evidence) EVIDENCE=${2:-}; shift ;;
    plan|online|rescue|log) cmd=$1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "decommission: неизвестный аргумент $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$APPLY" = 1 ] && [ "$cmd" != log ] && [ "$CONFIRM" != "$SERVER_ID" ]; then
  echo "decommission: --apply требует --confirm $SERVER_ID (номер сервера HOSTKEY)" >&2; exit 2
fi

# ─────────────────────────────── мак
if [ "${PDN_REMOTE:-}" != 1 ]; then
  if [ "$cmd" = log ]; then
    [ -n "$METHOD" ] && [ -s "$EVIDENCE" ] || die "log: нужны --method и --evidence <файл с выводом rescue>"
    what="Уничтожение ПДн при выводе сервера HOSTKEY $SERVER_ID (T-231, OWASP-0191): стенд nadzorium-gpu, корпус, кэши разбора"
    src="root@158.255.3.179:/opt/{stand-gpu,corpus,inspector,t184}, тома nadzorium-gpu_*, NVMe $DEV (953,9 ГБ) целиком"
    check=$(tr '\n' ' ' < "$EVIDENCE" | cut -c1-900)
    if [ "$APPLY" != 1 ]; then
      echo "  [dry-run] translog open --what \"$what\" --src \"$src\" --dst \"уничтожено: $METHOD\" --size \"~102 ГБ ПДн; диск 953,9 ГБ\" --check \"$check\""
      echo "  [dry-run] translog close <OP> --status \"Завершено. Сервер $SERVER_ID сдан без данных.\""
      exit 0
    fi
    op=$(translog next | grep -oE 'OP-[0-9]+' | head -1)
    [ -n "$op" ] || die "translog next не дал номер операции"
    translog open --op "$op" --what "$what" --src "$src" --dst "уничтожено: $METHOD" --size "~102 ГБ ПДн; диск 953,9 ГБ" --check "$check" --status "Выполняется"
    translog close "$op" --status "Завершено. Сервер $SERVER_ID сдан без данных." --check "$check"
    echo "  журнал переносов: $op"
    exit 0
  fi
  flags=(); [ "$APPLY" = 1 ] && flags+=(--apply --confirm "$CONFIRM")
  ssh "$HOST" "PDN_REMOTE=1 bash -s -- $cmd ${flags[*]:-}" < "$0"
  exit 0
fi

# ─────────────────────────────── сервер
run() {
  if [ "$APPLY" = 1 ]; then printf '  + %s\n' "$*"; "$@"; else printf '  [dry-run] %s\n' "$*"; fi
}
mb_of() { if [ -e "$1" ]; then echo $(( $(du -sk "$1" | awk '{print $1}') / 1024 )); else echo 0; fi; }
root_on_nvme() {  # корень живой системы лежит на стираемом диске?
  local src; src=$(findmnt -n -o SOURCE /) || return 0
  lsblk -s -n -o NAME "$src" 2>/dev/null | grep -q "${DEV##*/}"
}

cmd_plan() {
  say "что лежит (только чтение)"
  local d
  for d in $PDN_DIRS; do [ -e "$R/$d" ] && note "$(printf '%-28s %8s МБ' "/$d" "$(mb_of "$R/$d")")"; done
  note "тома Docker: $(docker volume ls -q | tr '\n' ' ')"
  [ ! -e "$IMG" ] || note "контейнер LUKS варианта Б: $IMG — будет luksErase (крипто-стирание за секунды)"
  [ ! -e "$R/opt/stand-gpu/secrets/blob_encryption_key" ] || note "ключ варианта А: будет удалён (блобы IBE1 без ключа — шум)"
  note "своп: $(swapon --show=NAME,SIZE --noheadings 2>/dev/null | tr '\n' ' ')"
  note "диск: $(lsblk -d -n -o NAME,SIZE,MODEL "$DEV" 2>/dev/null)"
  command -v nvme >/dev/null && note "nvme-cli: есть" || note "nvme-cli: нет (в rescue поставить: apt-get install -y nvme-cli)"
  say "план"
  note "online  (~10 мин): стоп контейнеров → luksErase/ключ А → rm каталогов и томов → своп → journalctl --vacuum → fstrim -av"
  note "rescue  (~5–15 мин): nvme sanitize --sanact=2 (block erase; PM9A1 ~1–2 мин) или nvme format --ses=1; проверка нулями"
  note "log     : translog open/close на маке — строка «Уничтожение ПДн при выводе сервера $SERVER_ID»"
}

cmd_online() {
  say "online: стирание на живой ОС (сервер $SERVER_ID)"
  local ids; ids=$(docker ps -q | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -z "$ids" ] || run docker stop $ids
  run systemctl stop 'runner-w*.slice'
  # вариант Б: заголовок LUKS стирается — содержимое контейнера становится шумом без восстановления
  if [ -e "$IMG" ]; then
    if cryptsetup status pdn >/dev/null 2>&1; then
      awk -F'\t' '{print $2}' "$R/etc/pdn-at-rest/mounts" 2>/dev/null | while read -r t; do run umount -l "$t" || true; done
      run umount -l "$R/srv/pdn" || true
      run cryptsetup close pdn
    fi
    run cryptsetup luksErase --batch-mode "$IMG"
    run rm -f "$IMG"
  fi
  run rm -f "$R"/opt/stand-gpu/secrets/blob_encryption_key "$R"/opt/stand-gpu/secrets/blob_encryption_key.disabled-*
  local d
  for d in $PDN_DIRS; do
    [ -e "$R/$d" ] || [ -e "$R/$d.plain-T231" ] || continue
    run chattr -i "$R/$d" 2>/dev/null || true
    run rm -rf --one-file-system "$R/$d" "$R/$d.plain-T231"
  done
  local v
  for v in $(docker volume ls -q); do run docker volume rm -f "$v"; done
  # своп: страницы процессов, работавших с ПДн
  if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then run swapoff -a; fi
  [ ! -e "$R/swapfile2" ] || run rm -f "$R/swapfile2"
  [ ! -e "$SWAP_LV" ] || run blkdiscard -f "$SWAP_LV"
  run journalctl --rotate
  run journalctl --vacuum-time=1s
  run fstrim -av
  note "online готово. Дальше: панель HOSTKEY → rescue → scripts/decommission.sh rescue --apply --confirm $SERVER_ID"
}

cmd_rescue() {
  say "rescue: стирание $DEV контроллером"
  root_on_nvme && die "корень живой системы на ${DEV##*/} — это не rescue. Загрузить rescue из панели HOSTKEY"
  command -v nvme >/dev/null || run apt-get install -y nvme-cli
  run vgchange -an vg54831 || true
  local caps method=""
  caps=$(nvme id-ctrl "$CTRL" -H 2>/dev/null || true)
  if printf '%s' "$caps" | grep -qi 'Block Erase Sanitize Operation Supported'; then
    method="nvme sanitize --sanact=2 (block erase)"
    run nvme sanitize "$CTRL" --sanact=2
    if [ "$APPLY" = 1 ]; then
      local _
      for _ in $(seq 1 180); do  # до 30 мин
        nvme sanitize-log "$CTRL" 2>/dev/null | grep -qiE 'Sanitize Progress.*65535|most recent sanitize operation completed successfully' && break
        sleep 10
      done
    fi
  elif printf '%s' "$caps" | grep -qi 'Format NVM Supported'; then
    method="nvme format --ses=1 (user data erase)"
    run nvme format "$DEV" --ses=1 --force
  else
    method="blkdiscard -f (TRIM всего диска — слабее: без гарантии стирания NAND)"
    run blkdiscard -f "$DEV"
  fi
  note "метод: $method"
  if [ "$APPLY" = 1 ]; then
    say "проверка: 8 проб по 16 МБ в разных местах диска — ждём одни нули"
    local size_mb off bad=0
    size_mb=$(( $(blockdev --getsize64 "$DEV") / 1024 / 1024 ))
    for off in 0 1 $((size_mb / 7)) $((size_mb / 3)) $((size_mb / 2)) $((size_mb * 2 / 3)) $((size_mb - 1024)) $((size_mb - 16)); do
      # cmp с /dev/zero ровно на 16 МБ: недочитанный кусок (ошибка dd) — тоже провал, а не «нули»
      # shellcheck disable=SC2086
      if cmp -s -n 16777216 <(dd if="$DEV" bs=1M count=16 skip="$off" $DD_FLAGS 2>/dev/null) /dev/zero; then
        note "смещение ${off} МБ: нули"
      else
        note "смещение ${off} МБ: НЕ нули или не прочитано"; bad=$((bad + 1))
      fi
    done
    [ "$bad" = 0 ] || die "проб не нулями: $bad из 8 — повторить другим методом"
    note "ИТОГ: $DEV стёрт ($method), пробы — нули. Скопировать этот вывод в файл на маке → decommission.sh log --evidence"
  fi
}

case $cmd in
  plan) cmd_plan ;;
  online) cmd_online ;;
  rescue) cmd_rescue ;;
  log) die "log выполняется на маке" ;;
esac
