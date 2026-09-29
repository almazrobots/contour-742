#!/usr/bin/env bash
# T-231, вариант Б закрытия OWASP-0191: LUKS2 под всеми данными с ПДн на GPU-сервере HOSTKEY 54831 (158.255.3.179).
# ПО УМОЛЧАНИЮ НИЧЕГО НЕ МЕНЯЕТ (--dry-run): печатает проверки и план. Менять — только с --apply и после «да» владельца.
#
# Свободного места в LVM нет (28.09: vg54831 VFree 0 — корень root 947,9 ГБ занимает всю группу; ext4 на лету не
# сжимается). Поэтому том — контейнер-файл: /srv/pdn.luks (по умолчанию 200 ГБ, fallocate) → loop → LUKS2
# aes-xts-plain64 512 бит, argon2id → ext4 → /srv/pdn. Каталоги остаются на прежних путях — bind-монтирования,
# ни compose, ни раннер, ни скрипты не меняются. Выделенный LV вместо файла — только через rescue-загрузку (см. T-231).
#
#   scripts/pdn-at-rest-b.sh [plan]               проверки (только чтение), объёмы, оценка простоя, план
#   scripts/pdn-at-rest-b.sh create [--apply]     ключ на маке (var/gpu-stand/pdn-luks.key, 600) → контейнер, luksFormat,
#                                                 open, mkfs, mount; ключ идёт через stdin ssh и на диск сервера не пишется
#   scripts/pdn-at-rest-b.sh migrate [--apply]    фаза 1 (онлайн): предкопия rsync; фаза 2 (простой стенда): стоп стенда,
#                                                 докопия --delete, сверка по содержимому, bind-монтирования, подъём;
#                                                 фаза 3 (онлайн): сверка корпуса; старые копии → *.plain-T231
#   scripts/pdn-at-rest-b.sh wipe-plain [--apply] удалить *.plain-T231 и fstrim (только после сверки фазы 3)
#   scripts/pdn-at-rest-b.sh swap [--apply]       своп: /swapfile2 выключить и удалить, LV swap — dm-crypt со случайным
#                                                 ключом на каждую загрузку (crypttab), blkdiscard старого содержимого
#   scripts/pdn-at-rest-b.sh unlock               после перезагрузки: открыть (ключ с мака через stdin), смонтировать, поднять стенд
#   scripts/pdn-at-rest-b.sh lock [--apply]       стенд стоп, размонтировать, закрыть
#   scripts/pdn-at-rest-b.sh rollback [--apply]   вернуть каталоги на корневую ФС (из *.plain-T231 или копией из LUKS)
#   scripts/pdn-at-rest-b.sh status               только чтение: что открыто и смонтировано, цепочка crypt у каждого пути
# Флаг --busy-ok — не ждать, пока чужие процессы (раннер W1, прогон T-184) закроют файлы в переносимых каталогах.
#
# Перезагрузка: ключа на сервере нет — после ребута данные закрыты, стенд не стартует (точки монтирования пустые и
# chattr +i: контейнеры падают громко, а не создают пустую базу), W1 и vLLM работают. Открыть — `unlock` с мака.
set -euo pipefail

HOST=${PDN_HOST:-root@158.255.3.179}
R=${PDN_ROOT:-}                       # префикс путей (только для тестов)
IMG=$R/srv/pdn.luks
IMG_GB=${PDN_IMG_GB:-200}
NAME=pdn
MAPPER=/dev/mapper/$NAME
MNT=$R/srv/pdn
STATE=$R/etc/pdn-at-rest
MOUNTS=$STATE/mounts                  # «источник в LUKS<TAB>цель» — порядок монтирования
PROC=${PDN_PROC:-/proc}
PROJECT=nadzorium-gpu
DIRS="opt/stand-gpu opt/corpus opt/inspector opt/t184"
SUFFIX=plain-T231
SWAP_LV=${PDN_SWAP_LV:-/dev/mapper/vg54831-swap}
SWAPFILE=${PDN_SWAPFILE:-/swapfile2}
FSTAB=$R/etc/fstab
CRYPTTAB=$R/etc/crypttab
GPU_STAND=$R/opt/stand-gpu/src/scripts/gpu-stand.sh
MIN_FREE_GB=20                        # правило №0
RSYNC_MBPS=${PDN_RSYNC_MBPS:-400}     # консервативно: чтение NVMe 5,5–6,5 ГБ/с (dd 28.09), aes-xts 2,7 ГБ/с, rsync — один поток
CHECK_MBPS=${PDN_CHECK_MBPS:-1500}    # сверка -c: чтение обеих сторон

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { echo "pdn-at-rest-b: $*" >&2; exit 1; }

cmd=plan; APPLY=0; BUSY_OK=0
for a in "$@"; do
  case $a in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --busy-ok) BUSY_OK=1 ;;
    plan|create|migrate|wipe-plain|swap|unlock|lock|rollback|status) cmd=$a ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "pdn-at-rest-b: неизвестный аргумент $a" >&2; exit 2 ;;
  esac
done

# ─────────────────────────────── мак
if [ "${PDN_REMOTE:-}" != 1 ]; then
  cd "$(dirname "$0")/.."
  MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
  LOCAL_VAR="$MAIN_ROOT/var/gpu-stand"
  LKEY="$LOCAL_VAR/pdn-luks.key"
  flags=(); [ "$APPLY" = 1 ] && flags+=(--apply); [ "$BUSY_OK" = 1 ] && flags+=(--busy-ok)
  needs_key=0
  case $cmd in create) [ "$APPLY" = 1 ] && needs_key=1 ;; unlock) needs_key=1 ;; esac
  if [ "$needs_key" = 0 ] && [ "$APPLY" = 0 ]; then
    # только чтение: скрипт через stdin, на сервер ничего не кладётся
    ssh "$HOST" "PDN_REMOTE=1 bash -s -- $cmd ${flags[*]:-}" < "$0"
    exit 0
  fi
  if [ "$cmd" = create ] && [ ! -s "$LKEY" ]; then
    mkdir -p "$LOCAL_VAR"; chmod 700 "$LOCAL_VAR"
    (umask 077; openssl rand -hex 32 | tr -d '\n' > "$LKEY")
    echo "  ключ LUKS создан: $LKEY (600, вне git). В менеджер паролей: pbcopy < \"$LKEY\" → вставить → pbcopy < /dev/null"
  fi
  if [ "$needs_key" = 1 ]; then [ -s "$LKEY" ] || die "нет ключа $LKEY"; fi
  ssh "$HOST" 'install -m 700 /dev/stdin /usr/local/sbin/pdn-at-rest-b.sh' < "$0"
  if [ "$needs_key" = 1 ]; then
    ssh "$HOST" "PDN_REMOTE=1 /usr/local/sbin/pdn-at-rest-b.sh $cmd ${flags[*]:-}" < "$LKEY"
  else
    ssh "$HOST" "PDN_REMOTE=1 /usr/local/sbin/pdn-at-rest-b.sh $cmd ${flags[*]:-}" < /dev/null
  fi
  exit 0
fi

# ─────────────────────────────── сервер
run() {  # изменяющая команда: в --dry-run только печатается
  if [ "$APPLY" = 1 ]; then printf '  + %s\n' "$*"; "$@"; else printf '  [dry-run] %s\n' "$*"; fi
}
free_gb() { echo $(( $(df -Pk "$1" | awk 'NR==2 {print $4}') / 1024 / 1024 )); }
mb_of() { if [ -e "$1" ]; then echo $(( $(du -sk "$1" | awk '{print $1}') / 1024 )); else echo 0; fi; }
meminfo_gb() { awk -v k="$1:" '$1 == k {print int($2/1024/1024)}' "$PROC/meminfo"; }
is_open() { [ -e "$MAPPER" ] || cryptsetup status "$NAME" >/dev/null 2>&1; }
is_mounted() { mountpoint -q "$1" 2>/dev/null; }
rev_lines() { awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' "$@"; }
stand_ids() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT"; }
stand_volumes() {  # тома проекта стенда, кроме tmpfs blob-work (в памяти): «имя<TAB>путь _data»
  local v
  for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
    case $v in *blob-work) continue ;; esac
    printf '%s\t%s\n' "$v" "$(docker volume inspect -f '{{.Mountpoint}}' "$v")"
  done
}
# пути, которые переносятся: «цель<TAB>источник в LUKS»
targets() {
  local d
  for d in $DIRS; do [ -e "$R/$d" ] && printf '%s\t%s\n' "$R/$d" "$MNT/$d"; done
  stand_volumes | while IFS="$(printf '\t')" read -r v p; do printf '%s\t%s\n' "$p" "$MNT/docker-volumes/$v"; done
}
# процессы с открытыми файлами или рабочим каталогом внутри $1 (без lsof: /proc/*/fd и cwd)
holders() {
  local p l
  for p in "$PROC"/[0-9]*; do
    for l in "$p"/cwd "$p"/fd/*; do
      case $(readlink "$l" 2>/dev/null || true) in "$1"|"$1"/*) echo "${p##*/}"; break ;; esac
    done
  done | sort -u
}
crypt_chain() {  # «crypt» — путь лежит на dm-crypt (цепочка вниз до диска), tmpfs — в памяти
  local src fstype
  src=$(findmnt -n -o SOURCE -T "$1" 2>/dev/null) || { echo "нет"; return; }
  fstype=$(findmnt -n -o FSTYPE -T "$1" 2>/dev/null || true)
  case $fstype in tmpfs|ramfs) echo "tmpfs"; return ;; esac
  src=${src%%\[*}
  if lsblk -s -n -o TYPE "$src" 2>/dev/null | grep -qw crypt; then echo "crypt"; else echo "открыто ($src)"; fi
}
read_key() {  # ключ — 64 hex из stdin (с мака); на диск не пишется, живёт в переменной
  KEYHEX=$(head -c 64)
  case $KEYHEX in *[!0-9a-f]*|"") die "ключ: ждём 64 шестнадцатеричных символа на stdin" ;; esac
  [ ${#KEYHEX} -eq 64 ] || die "ключ: ждём 64 шестнадцатеричных символа на stdin"
}
luks() { printf '%s' "$KEYHEX" | cryptsetup "$@" --key-file=-; }

cmd_plan() {
  say "проверки (только чтение)"
  local vfree free need total=0 stand_mb=0 mb t s mem swapused
  vfree=$(vgs --noheadings --units g -o vg_free 2>/dev/null | tr -d ' ' || echo "?")
  free=$(free_gb "$R/")
  need=$((IMG_GB + MIN_FREE_GB))
  note "LVM: свободно в группе ${vfree:-?} → том — контейнер-файл $IMG (${IMG_GB} ГБ)"
  note "корневая ФС: свободно ${free} ГБ, нужно ≥ ${need} ГБ (контейнер + запас правила №0)"
  [ "$free" -ge "$need" ] || note "БЛОКЕР: места мало — уменьшить PDN_IMG_GB или освободить"
  note "cryptsetup: $(cryptsetup --version 2>/dev/null || echo 'нет')"
  if is_open; then note "LUKS $NAME уже открыт"; fi
  say "что переносится"
  while IFS="$(printf '\t')" read -r t s; do
    mb=$(mb_of "$t"); total=$((total + mb))
    case $t in */stand-gpu|*/_data) stand_mb=$((stand_mb + mb)) ;; esac
    note "$(printf '%-60s %8s МБ → %s' "$t" "$mb" "$s")"
    local h; h=$(holders "$t" | tr '\n' ' ')
    [ -z "$h" ] || note "   открыт процессами: $h"
  done < <(targets)
  note "итого ${total} МБ; из них стенд (простой) ${stand_mb} МБ"
  say "оценка времени (rsync ${RSYNC_MBPS} МБ/с, сверка ${CHECK_MBPS} МБ/с — PDN_RSYNC_MBPS/PDN_CHECK_MBPS)"
  local pre=$((total / RSYNC_MBPS)) down_copy=$((stand_mb / RSYNC_MBPS + 30)) down_check=$((2 * stand_mb / CHECK_MBPS)) post=$((2 * (total - stand_mb) / CHECK_MBPS))
  note "create: fallocate + luksFormat (argon2id ~2 с) + mkfs ≈ 1 мин, онлайн"
  note "фаза 1, онлайн: предкопия ≈ $((pre / 60 + 1)) мин (нагрузка на диск, стенд и W1 работают)"
  note "фаза 2, ПРОСТОЙ СТЕНДА: стоп ~30 с + докопия ≈ ${down_copy} с + сверка ≈ ${down_check} с + подъём (ML start_period) ~3 мин"
  note "   итого простой стенда ≈ $(( (30 + down_copy + down_check + 180) / 60 + 1 )) мин; W1 и vLLM не останавливаются"
  note "   (на переключении /opt/corpus и /opt/inspector раннер W1 не должен держать там файлы — иначе --busy-ok или пауза W1)"
  note "фаза 3, онлайн: сверка корпуса ≈ $((post / 60 + 1)) мин; wipe-plain: rm + fstrim ≈ 1–2 мин"
  mem=$(meminfo_gb MemAvailable); swapused=$(( $(meminfo_gb SwapTotal) - $(meminfo_gb SwapFree) ))
  note "своп: занято ${swapused} ГБ, RAM доступно ${mem} ГБ — шаг swap нужен запас ≥ 8 ГБ после выгрузки свопа"
  say "НЕ закрывает и после варианта Б"
  note "данные открыты, пока том смонтирован: root на сервере (и W1 под root — OWASP-0196) читает их как обычно"
  note "корень ОС, образы и слои Docker (/var/lib/docker 53 ГБ, /var/lib/containerd 41 ГБ) — ПДн там нет, но и шифрования нет"
  note "удалённые до TRIM блоки: fstrim отдаёт их контроллеру, физическое стирание NAND гарантирует только вывод (decommission.sh)"
  note "журналы systemd (имена файлов в строках) — journalctl --vacuum при выводе"
}

cmd_create() {
  local free; free=$(free_gb "$R/")
  [ "$free" -ge $((IMG_GB + MIN_FREE_GB)) ] || die "свободно ${free} ГБ < ${IMG_GB}+${MIN_FREE_GB} — не создаю"
  [ ! -e "$IMG" ] || die "$IMG уже есть — не перезаписываю (открыть: unlock)"
  command -v cryptsetup >/dev/null || die "нет cryptsetup"
  if [ "$APPLY" = 1 ]; then read_key; fi
  say "контейнер LUKS2 ${IMG_GB} ГБ → $MNT"
  run mkdir -p "$R/srv" "$STATE"
  run sh -c "umask 077 && fallocate -l ${IMG_GB}G '$IMG'"
  if [ "$APPLY" = 1 ]; then
    printf '  + cryptsetup luksFormat --type luks2 … %s --key-file=- (ключ из stdin)\n' "$IMG"
    luks luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id --batch-mode "$IMG"
    printf '  + cryptsetup open %s %s --key-file=-\n' "$IMG" "$NAME"
    luks open --type luks2 "$IMG" "$NAME"
  else
    note "[dry-run] cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id $IMG --key-file=- (ключ с мака)"
    note "[dry-run] cryptsetup open $IMG $NAME --key-file=-"
  fi
  run mkfs.ext4 -q -L "$NAME" -m 0 "$MAPPER"
  run mkdir -p "$MNT"
  run mount -o noatime,nodev,nosuid "$MAPPER" "$MNT"
  run chmod 700 "$MNT"
  note "резервная копия заголовка LUKS: cryptsetup luksHeaderBackup $IMG --header-backup-file /dev/shm/pdn.hdr → на мак var/gpu-stand/ (600), с сервера удалить"
}

# rsync каталогов одним вызовом — жёсткие ссылки /opt/stand-gpu/pkg ↔ /opt/inspector/blobs сохраняются
sync_all() {  # $1 — доп. ключи rsync (например --delete)
  local extra=${1:-} srcs=() d
  for d in $DIRS; do [ -e "$R/$d" ] && srcs+=("$R/$d"); done
  run mkdir -p "$MNT/opt" "$MNT/docker-volumes"
  # shellcheck disable=SC2086
  run rsync -aHAX --numeric-ids $extra "${srcs[@]}" "$MNT/opt/"
  stand_volumes | while IFS="$(printf '\t')" read -r v p; do
    # shellcheck disable=SC2086
    run rsync -aHAX --numeric-ids $extra "$p/" "$MNT/docker-volumes/$v/"
  done
}
# сверка по содержимому: rsync -c --dry-run не должен найти ни одного отличия
check_same() {  # $1 — источник, $2 — копия
  if [ "$APPLY" != 1 ]; then note "[dry-run] сверка -c: $1 ↔ $2"; return 0; fi
  local diff; diff=$(rsync -aHAXc --numeric-ids --delete --dry-run --itemize-changes "$1/" "$2/")
  [ -z "$diff" ] || die "сверка не сошлась: $1 ↔ $2 ($(printf '%s\n' "$diff" | wc -l | tr -d ' ') отличий) — остановка, переключения нет"
  note "сверка: $1 = $2"
}
switch_bind() {  # $1 — цель, $2 — источник в LUKS: старый каталог → *.plain-T231, пустая точка монтирования chattr +i
  local t=$1 s=$2 own mode
  own=$(stat -c '%u:%g' "$t" 2>/dev/null || echo 0:0); mode=$(stat -c '%a' "$t" 2>/dev/null || echo 755)
  [ ! -e "$t.$SUFFIX" ] || die "$t.$SUFFIX уже есть — прошлый перенос не завершён"
  run mv "$t" "$t.$SUFFIX"
  run mkdir "$t"
  run chown "$own" "$t"
  run chmod "$mode" "$t"
  run chattr +i "$t"
  run mount --bind "$s" "$t"
  if [ "$APPLY" = 1 ]; then printf '%s\t%s\n' "$s" "$t" >> "$MOUNTS"; fi
}

cmd_migrate() {
  is_mounted "$MNT" || [ "$APPLY" != 1 ] || die "$MNT не смонтирован — сначала create или unlock"
  [ ! -s "$MOUNTS" ] || die "перенос уже выполнен ($MOUNTS) — status"
  local free; free=$(free_gb "$R/")
  [ "$free" -ge "$MIN_FREE_GB" ] || die "свободно ${free} ГБ < ${MIN_FREE_GB} (правило №0)"
  run mkdir -p "$STATE"
  say "фаза 1 (онлайн): предкопия"
  sync_all
  say "фаза 2 (простой стенда): стоп, докопия, сверка, переключение, подъём"
  local ids; ids=$(stand_ids | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -z "$ids" ] || run docker stop $ids
  local t s h busy=""
  while IFS="$(printf '\t')" read -r t s; do
    h=$(holders "$t" | tr '\n' ' ')
    [ -z "$h" ] || busy="$busy ${t} [$h]"
  done < <(targets)
  if [ -n "$busy" ]; then
    if [ "$BUSY_OK" = 1 ]; then note "открыто чужими процессами (--busy-ok):$busy"
    else
      # shellcheck disable=SC2086
      [ -z "$ids" ] || run docker start $ids
      die "файлы открыты чужими процессами:$busy — стенд поднят обратно; дождаться или --busy-ok"
    fi
  fi
  sync_all --delete
  check_same "$R/opt/stand-gpu" "$MNT/opt/stand-gpu"
  while IFS="$(printf '\t')" read -r v p; do check_same "$p" "$MNT/docker-volumes/$v"; done < <(stand_volumes)
  while IFS="$(printf '\t')" read -r t s; do switch_bind "$t" "$s"; done < <(targets)
  run env GPU_STAND_REMOTE=1 bash "$GPU_STAND" up
  say "фаза 3 (онлайн): сверка остальных каталогов по содержимому"
  local d
  for d in $DIRS; do
    [ "$d" = opt/stand-gpu ] && continue
    [ -e "$R/$d.$SUFFIX" ] || [ "$APPLY" != 1 ] || continue
    check_same "$R/$d.$SUFFIX" "$MNT/$d"
  done
  if [ "$APPLY" = 1 ]; then date -u +%FT%TZ > "$STATE/verified"; fi
  cmd_status
  note "старые копии: *.$SUFFIX — удалить после проверки стенда: wipe-plain --apply"
}

cmd_wipe_plain() {
  [ -s "$STATE/verified" ] || [ "$APPLY" != 1 ] || die "нет отметки сверки $STATE/verified — сначала migrate --apply"
  say "удаление открытых копий *.$SUFFIX и TRIM"
  local t s
  while IFS="$(printf '\t')" read -r s t; do
    [ -e "$t.$SUFFIX" ] || continue
    note "$t.$SUFFIX: $(mb_of "$t.$SUFFIX") МБ"
    run rm -rf --one-file-system "$t.$SUFFIX"
  done < <(cat "$MOUNTS" 2>/dev/null || targets | awk -F'\t' '{print $2 "\t" $1}')
  # shred на SSD под ext4 бесполезен (журнал, перераспределение блоков): удалённое отдаётся контроллеру TRIM'ом
  run fstrim -v /
}

cmd_swap() {
  local mem used uuid
  mem=$(meminfo_gb MemAvailable); used=$(( $(meminfo_gb SwapTotal) - $(meminfo_gb SwapFree) ))
  say "своп: занято ${used} ГБ, RAM доступно ${mem} ГБ"
  [ $((mem - used)) -ge 8 ] || die "после выгрузки свопа останется $((mem - used)) ГБ < 8 — риск OOM (W1). Окно без нагрузки"
  uuid=$(blkid -s UUID -o value "$SWAP_LV" 2>/dev/null || true)
  run cp -p "$FSTAB" "$FSTAB.bak-T231"
  run cp -p "$CRYPTTAB" "$CRYPTTAB.bak-T231"
  if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then run swapoff "$SWAPFILE"; fi
  run rm -f "$SWAPFILE"
  run swapoff "$SWAP_LV"
  run blkdiscard -f "$SWAP_LV"
  if [ "$APPLY" = 1 ]; then
    swap_fstab "$FSTAB" "$SWAP_LV" "$uuid" "$SWAPFILE" > "$FSTAB.new-T231" && mv "$FSTAB.new-T231" "$FSTAB"
    grep -q '^cswap ' "$CRYPTTAB" 2>/dev/null || printf 'cswap %s /dev/urandom swap,cipher=aes-xts-plain64,size=512\n' "$SWAP_LV" >> "$CRYPTTAB"
    echo "  + fstab: своп → /dev/mapper/cswap; crypttab: cswap со случайным ключом"
  else
    note "[dry-run] fstab: строки свопа ($SWAP_LV, UUID=$uuid, $SWAPFILE) закомментировать, добавить /dev/mapper/cswap"
    note "[dry-run] crypttab: cswap $SWAP_LV /dev/urandom swap,cipher=aes-xts-plain64,size=512"
  fi
  run systemctl daemon-reload
  run systemctl start systemd-cryptsetup@cswap.service
  run swapon /dev/mapper/cswap
  run fstrim -v /
  note "своп стал 4 ГБ (было 20): при нехватке — zram (systemd-zram-generator), на диск ничего не ложится"
}
# fstab без открытого свопа: $1 файл, $2 LV, $3 UUID LV, $4 файл свопа → stdout
swap_fstab() {
  awk -v lv="$2" -v uuid="$3" -v sf="$4" '
    $3 == "swap" && ($1 == lv || $1 == "/dev/vg54831/swap" || (uuid != "" && $1 == "UUID=" uuid) || $1 == sf) { print "# T-231: " $0; next }
    { print }
    END { print "/dev/mapper/cswap none swap sw 0 0" }' "$1"
}

cmd_unlock() {
  [ -e "$IMG" ] || die "нет $IMG"
  [ -s "$MOUNTS" ] || die "нет $MOUNTS — перенос не выполнялся"
  APPLY=1
  if ! is_open; then read_key; printf '  + cryptsetup open %s %s --key-file=-\n' "$IMG" "$NAME"; luks open --type luks2 "$IMG" "$NAME"; fi
  is_mounted "$MNT" || run mount -o noatime,nodev,nosuid "$MAPPER" "$MNT"
  local s t
  while IFS="$(printf '\t')" read -r s t; do is_mounted "$t" || run mount --bind "$s" "$t"; done < "$MOUNTS"
  run env GPU_STAND_REMOTE=1 bash "$GPU_STAND" up
  cmd_status
}

cmd_lock() {
  say "закрыть: стенд стоп, размонтировать, закрыть LUKS"
  local ids; ids=$(stand_ids | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -z "$ids" ] || run docker stop $ids
  local s t
  if [ -s "$MOUNTS" ]; then
    while IFS="$(printf '\t')" read -r s t; do if is_mounted "$t"; then run umount "$t"; fi; done < <(rev_lines "$MOUNTS")
  fi
  if is_mounted "$MNT"; then run umount "$MNT"; fi
  if is_open; then run cryptsetup close "$NAME"; fi
}

cmd_rollback() {
  [ -s "$MOUNTS" ] || die "нет $MOUNTS — откатывать нечего"
  say "откат: каталоги обратно на корневую ФС"
  local ids; ids=$(stand_ids | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -z "$ids" ] || run docker stop $ids
  local s t
  while IFS="$(printf '\t')" read -r s t; do
    if is_mounted "$t"; then run umount "$t"; fi
    run chattr -i "$t"
    run rmdir "$t"
    if [ -e "$t.$SUFFIX" ]; then
      run mv "$t.$SUFFIX" "$t"   # до wipe-plain: старая копия цела (но без изменений после переноса!)
    else
      is_mounted "$MNT" || [ "$APPLY" != 1 ] || die "$MNT не смонтирован — сначала unlock"
      run mkdir -p "$t"
      run rsync -aHAX --numeric-ids "$s/" "$t/"
    fi
  done < <(rev_lines "$MOUNTS")
  run mv "$MOUNTS" "$MOUNTS.rolled-back-$(date +%Y%m%d-%H%M%S)"
  run env GPU_STAND_REMOTE=1 bash "$GPU_STAND" up
  note "контейнер $IMG оставлен (закрыть: cryptsetup close $NAME; удалить — только с «да» владельца, decommission.sh)"
}

cmd_status() {
  say "состояние"
  if is_open; then note "LUKS $NAME: открыт"; else note "LUKS $NAME: закрыт или не создан"; fi
  if is_mounted "$MNT"; then note "$MNT: смонтирован"; else note "$MNT: не смонтирован"; fi
  local t s
  while IFS="$(printf '\t')" read -r t s; do note "$(printf '%-60s %s' "$t" "$(crypt_chain "$t")")"; done < <(targets)
  note "своп: $(swapon --show=NAME --noheadings 2>/dev/null | tr '\n' ' ')"
}

case $cmd in
  plan) cmd_plan ;;
  create) cmd_create ;;
  migrate) cmd_migrate ;;
  wipe-plain) cmd_wipe_plain ;;
  swap) cmd_swap ;;
  unlock) cmd_unlock ;;
  lock) cmd_lock ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
esac
