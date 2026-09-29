#!/usr/bin/env bash
# Температура мака (T-129, просьба владельца 27.09): журнал и шлагбаум для тяжёлых операций (правило №0).
#   scripts/thermal.sh now            одна строка: CPU °C, GPU °C, мощность системы, нагрузка
#   scripts/thermal.sh log [сек]      фоновый журнал в var/thermal.log (по умолчанию раз в 120 с)
#   scripts/thermal.sh wait [°C] [%]  ждать, пока CPU < порога (90 °C) и свободной памяти ≥ порога (15 %); без macmon — не ждёт
# Датчики Apple Silicon читает macmon (brew) без sudo.
set -euo pipefail
cd "$(dirname "$0")/.."
now() {
  command -v macmon >/dev/null || { echo "macmon нет"; return 0; }
  timeout 15 macmon pipe -s 1 -i 1000 2>/dev/null | python3 -c "
import json, sys, os
d = json.loads(sys.stdin.readline()); t = d.get('temp') or {}
import subprocess, re
mp = subprocess.run(['memory_pressure', '-Q'], capture_output=True, text=True).stdout
free = int((re.search(r'(\\d+)%', mp) or [0, 0])[1])
sw = subprocess.run(['sysctl', '-n', 'vm.swapusage'], capture_output=True, text=True).stdout
used = float((re.search(r'used = ([\\d.]+)M', sw) or [0, 0])[1])
print('%s cpu=%.0fC gpu=%.0fC sys=%.1fW load=%.1f memfree=%d%% swap=%.0fM' % (d['timestamp'][:19], t.get('cpu_temp_avg', 0), t.get('gpu_temp_avg', 0), d.get('sys_power', 0), os.getloadavg()[0], free, used))"
}
case "${1:-now}" in
  now) now ;;
  log) mkdir -p var; while true; do now >> var/thermal.log; sleep "${2:-120}"; done ;;
  wait)
    lim=${2:-90}; memmin=${3:-15}
    while command -v macmon >/dev/null; do
      line=$(now); c=$(sed -E 's/.*cpu=([0-9]+)C.*/\1/' <<<"$line"); m=$(sed -E 's/.*memfree=([0-9]+)%.*/\1/' <<<"$line")
      [ "${c:-0}" -lt "$lim" ] && [ "${m:-100}" -ge "$memmin" ] && break
      echo "thermal: CPU ${c} °C (порог ${lim}), свободно памяти ${m} % (порог ${memmin}) — жду" >&2; sleep 30
    done ;;
  *) echo "thermal.sh now|log [сек]|wait [°C]" >&2; exit 2 ;;
esac
