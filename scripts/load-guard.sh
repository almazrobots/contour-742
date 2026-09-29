#!/usr/bin/env bash
# Диспетчер нагрузки стенда — «рубильник» (T-129, требование владельца 27.09): параллельный OCR не должен перегреть
# или задушить мак. Раз в 20 с: температура CPU и GPU (macmon), свободная память (memory_pressure), своп.
#   CPU или GPU ≥ 90 °C (было 95 — владелец 27.09: держать мак холоднее), или память < 10 %, или своп растёт > 1 ГБ за цикл при памяти < 20 % → пауза ML (заморозка без
#   потери данных, API ждёт ответа ML в пределах своего тайм-аута);
#   CPU и GPU < 80 °C и память ≥ 20 % → снятие паузы. Абсолютный размер свопа не условие: macOS не отдаёт своп после
#   спада нагрузки, и прежнее правило «своп > 6 ГБ» держало ML на паузе бесконечно (27.09). Каждое действие — строка в var/load-guard.log.
# Что замораживается: контейнер ml стенда (docker pause), нативные процессы ML на маке (T-130: сервис и этапы-читатели
# MLX — kill -STOP / -CONT по pid-файлам var/stand/ml-host/pids/*.pid) и ВСЁ дерево процессов, держащее замок heavy.sh:
# Stryker с воркерами vitest, mutmut с pytest, прогоны тестов и этапы (T-130, требование владельца 27.09: Stryker грел мак
# до 92 °C, а рубильник его не видел). MLX грузит GPU, поэтому смотрим и его температуру.
#   scripts/load-guard.sh [интервал_с]      (гасится вместе со стендом: stand.sh down)
#   Для тестов: GUARD_PROBE — команда вместо scripts/thermal.sh now, GUARD_ITERS — число циклов (по умолчанию бесконечно),
#   GUARD_PIDS — каталог pid-файлов, GUARD_KILL — команда вместо kill.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=${GUARD_LOG:-var/load-guard.log}; mkdir -p var
HOT=${GUARD_HOT_C:-90}; COOL=${GUARD_COOL_C:-80}; MEMLOW=${GUARD_MEM_LOW:-10}; MEMOK=${GUARD_MEM_OK:-20}; SWAPGROW=${GUARD_SWAP_GROW_MB:-1024}
PIDS=${GUARD_PIDS:-var/stand/ml-host/pids}; KILL=${GUARD_KILL:-kill}
HEAVY_LOCK=${GUARD_HEAVY_LOCK:-/tmp/building-tech-heavy.lock}
paused=0; iter=0; prev_s=; frozen=
ts() { date '+%F %T'; }
# только ML этого стенда: чужие проекты с сервисом ml не трогаем ни паузой, ни снятием паузы
ml_ids() { docker ps -q --filter "label=com.docker.compose.project=inspector-stand" --filter "label=com.docker.compose.service=ml" "$@"; }
# живые нативные процессы ML на маке: pid из файла и процесс существует (мёртвый pid-файл не повод слать сигнал чужому)
native_pids() {
  local f p
  for f in "$PIDS"/*.pid; do
    [ -f "$f" ] || continue
    p=$(tr -dc '0-9' < "$f")
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"
  done
}
# дерево процессов владельца замка heavy.sh: сам heavy.sh и все потомки (Stryker → vitest-воркеры, mutmut → pytest)
tree() {
  local p c
  p=$1; kill -0 "$p" 2>/dev/null || return 0
  echo "$p"
  for c in $(pgrep -P "$p" 2>/dev/null); do tree "$c"; done
}
heavy_pids() {
  local p
  p=$(tr -dc '0-9' < "$HEAVY_LOCK/pid" 2>/dev/null)
  [ -n "$p" ] && tree "$p"
}
while true; do
  line=$(${GUARD_PROBE:-scripts/thermal.sh now} 2>/dev/null)
  c=$(sed -nE 's/.*cpu=([0-9]+)C.*/\1/p' <<<"$line"); g=$(sed -nE 's/.*gpu=([0-9]+)C.*/\1/p' <<<"$line")
  m=$(sed -nE 's/.*memfree=([0-9]+)%.*/\1/p' <<<"$line"); s=$(sed -nE 's/.*swap=([0-9]+)M.*/\1/p' <<<"$line")
  c=${c:-0}; g=${g:-0}; m=${m:-100}; s=${s:-0}
  grow=0; [ -n "$prev_s" ] && grow=$((s - prev_s)); prev_s=$s
  if [ "$paused" = 0 ] && { [ "$c" -ge "$HOT" ] || [ "$g" -ge "$HOT" ] || [ "$m" -lt "$MEMLOW" ] || { [ "$grow" -gt "$SWAPGROW" ] && [ "$m" -lt "$MEMOK" ]; }; }; then
    ids=$(ml_ids --filter status=running); frozen=$( { native_pids; heavy_pids; } | awk '!seen[$0]++' | tr '\n' ' ')
    done_any=0
    if [ -n "$ids" ] && docker pause $ids >/dev/null; then done_any=1; fi
    for p in $frozen; do $KILL -STOP "$p" 2>/dev/null && done_any=1; done
    if [ "$done_any" = 1 ]; then paused=1; echo "$(ts) РУБИЛЬНИК: пауза ML${frozen:+ (нативные pid: ${frozen% })}$( [ -s "$HEAVY_LOCK/cmd" ] && printf ' · тяжёлое: %s' "$(cat "$HEAVY_LOCK/cmd")") ($line)" >> "$LOG"
    else echo "$(ts) перегрев, но ML стенда не запущен ($line)" >> "$LOG"; fi
  elif [ "$paused" = 1 ] && [ "$c" -lt "$COOL" ] && [ "$g" -lt "$COOL" ] && [ "$m" -ge "$MEMOK" ]; then
    ids=$(ml_ids --filter status=paused); [ -n "$ids" ] && docker unpause $ids >/dev/null
    for p in $frozen; do $KILL -CONT "$p" 2>/dev/null; done
    paused=0; frozen=; echo "$(ts) снята пауза ML ($line)" >> "$LOG"
  fi
  iter=$((iter + 1)); [ -n "${GUARD_ITERS:-}" ] && [ "$iter" -ge "$GUARD_ITERS" ] && break
  sleep "${1:-20}"
done
