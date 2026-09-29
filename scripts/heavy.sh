#!/usr/bin/env bash
# Правило №0: один тяжёлый процесс на машину. Замок — каталог в /tmp (mkdir атомарен),
# общий для всех worktree. Использование: scripts/heavy.sh <команда…>
# Тяжёлое: OCR/стенд §14, фабрика синтетики, Stryker, mutmut, e2e, бенчмарки, UI-тесты.
set -u
LOCK=/tmp/building-tech-heavy.lock
free_gb=$(df -g / | awk 'NR==2{print $4}')
if [ "${free_gb:-0}" -lt 8 ]; then echo "heavy.sh: свободно ${free_gb} ГБ < 8 — тяжёлое не запускаю" >&2; exit 97; fi
# тепловой шлагбаум (T-129): CPU горячее 90 °C — ждать остывания, а не добавлять нагрузку
"$(dirname "$0")/thermal.sh" wait 90 || true
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; continue; fi
  [ $((waited % 60)) -eq 0 ] && echo "heavy.sh: жду замок (держит pid ${holder:-?}, $(cat "$LOCK/cmd" 2>/dev/null))" >&2
  sleep 5; waited=$((waited + 5))
  if [ "$waited" -ge 3600 ]; then echo "heavy.sh: замок не освободился за час" >&2; exit 98; fi
done
echo $$ > "$LOCK/pid"; echo "$*" > "$LOCK/cmd"
# рубильник — обязательная охрана тяжёлого (T-130): не запущен — поднимается; при перегреве он замораживает всё дерево
# процессов этого замка (Stryker, mutmut, тесты, этапы ML), а не только ML стенда
if [ -z "${HEAVY_NO_GUARD:-}" ] && ! pgrep -f "scripts/load-guard.sh" >/dev/null; then
  (cd "$(dirname "$0")/.." && nohup scripts/load-guard.sh 20 >/dev/null 2>&1 &)
fi
trap 'rm -f "$LOCK/pid" "$LOCK/cmd"; rmdir "$LOCK" 2>/dev/null' EXIT
"$@"
