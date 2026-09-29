#!/usr/bin/env bash
# ML на маке (T-130, NFR-ML-HOST): MLX на Metal недоступен внутри Docker, поэтому сервис разбора и этапы-читатели
# запускаются на самом маке. Стенд поднимается с ним командой scripts/stand.sh up --ml-host.
#   scripts/heavy.sh scripts/ml-host.sh run                сервис ML (судья Qwen3.5-9B) — https://127.0.0.1:8811, TLS 1.3
#   scripts/heavy.sh scripts/ml-host.sh stage <этап> [--limit N]   этап конвейера: parse | reader | reader2 | report
#   scripts/ml-host.sh status | stop
# Одна модель — один процесс (опыт T-129): этап не стартует, пока работает сервис, и наоборот. Всё тяжёлое — под замком
# heavy.sh (он же ждёт CPU < 90 °C и памяти ≥ 15 % перед стартом); во время работы — рубильник load-guard.sh: процесс
# пишет pid в var/stand/ml-host/pids, и при перегреве CPU/GPU или росте свопа рубильник его замораживает (SIGSTOP).
# Разбор — на эффективных ядрах (taskpolicy -c utility): мак не греется ради фоновой работы.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VAR="${STAND_VAR_DIR:-$ROOT/var/stand}"
HOST_DIR="$VAR/ml-host"
PIDS="$HOST_DIR/pids"
TLS="$VAR/tls/ml-host"

die() { echo "ml-host: $*" >&2; exit 1; }
alive() { [ -f "$1" ] && kill -0 "$(tr -dc '0-9' < "$1")" 2>/dev/null; }

need() {
  [ -d /tmp/building-tech-heavy.lock ] || die "тяжёлое — только под замком: scripts/heavy.sh scripts/ml-host.sh $*"
  local free_gb
  free_gb=$(( $(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  [ "$free_gb" -ge 20 ] || die "свободно ${free_gb} ГБ < 20 — не запускаю (правило №0)"
  [ -x ml/.venv/bin/python ] || die "нет ml/.venv: cd ml && uv sync --locked --extra dev --extra semantic --extra mlx"
  mkdir -p "$PIDS" "$HOST_DIR/cache" "$HOST_DIR/readers" "$VAR/blobs"
}

# Окружение сервиса и этапов: те же каталоги файлов и кэша, что видит API стенда (var/stand/blobs — bind mount)
env_ml() {
  local rev; rev=$(git rev-parse HEAD)
  git diff --quiet HEAD -- ml && git diff --cached --quiet -- ml || rev="$rev-dirty"
  export INSPECTOR_PROFILE=dev INSPECTOR_REVISION="$rev" INSPECTOR_ROOT="$ROOT"
  export INSPECTOR_BLOB_DIR="$VAR/blobs" INSPECTOR_ML_CACHE="$HOST_DIR/cache" INSPECTOR_READER_CACHE="$HOST_DIR/readers"
  export INSPECTOR_VLM_BACKEND=mlx INSPECTOR_MLX_MEMORY_GB="${INSPECTOR_MLX_MEMORY_GB:-10}"
  export INSPECTOR_OCR_WORKERS="${INSPECTOR_OCR_WORKERS:-2}" INSPECTOR_LLM_PROVIDER=none
  # модели только локальные: ни одного похода в сеть за весами или токенизатором (ADR: открытые веса, локально)
  export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1
}

cmd_run() {
  need run
  for f in "$PIDS"/stage-*.pid; do alive "$f" && die "работает этап ($(basename "$f")) — одна модель за раз"; done
  alive "$PIDS/service.pid" && die "сервис уже запущен (pid $(cat "$PIDS/service.pid"))"
  [ -s "$TLS/server.crt" ] || die "нет сертификата $TLS — scripts/stand.sh secrets"
  env_ml
  export INSPECTOR_ML_TLS_CERT="$TLS/server.crt" INSPECTOR_ML_TLS_KEY="$TLS/server.key" HOST=127.0.0.1 PORT=8811
  # exec: pid оболочки становится pid Python — рубильник замораживает именно сервис, а не обёртку над ним
  echo $$ > "$PIDS/service.pid"
  echo "ml-host: сервис ML на маке · https://127.0.0.1:8811 · $INSPECTOR_REVISION · журнал $HOST_DIR/service.log"
  cd ml && exec .venv/bin/python serve.py >> "$HOST_DIR/service.log" 2>&1
}

cmd_stage() {
  local name=${1:-}; shift || true
  case $name in parse|reader|reader2|report) ;; *) die "stage: parse | reader | reader2 | report" ;; esac
  need "stage $name"
  alive "$PIDS/service.pid" && die "работает сервис ML — одна модель за раз: scripts/ml-host.sh stop"
  env_ml
  local pidf="$PIDS/stage-$name.pid" qos=()
  # разбор — CPU: на эффективных ядрах (меньше нагрев); читателям нужен GPU — обычный приоритет
  [ "$name" = parse ] && qos=(taskpolicy -c utility)
  echo "ml-host: этап $name $* · журнал $HOST_DIR/stages.log"
  # код выхода — самого Python, а не tee в конце конвейера (иначе упавший этап выглядит успешным)
  rm -f "$HOST_DIR/stage.rc"
  ( cd ml && { ${qos[@]+"${qos[@]}"} .venv/bin/python -m inspector_ml.stages "$name" "$@"; echo $? > "$HOST_DIR/stage.rc"; } ) 2>>"$HOST_DIR/stages.err" | tee -a "$HOST_DIR/stages.log" &
  local pipe=$!
  sleep 1
  pgrep -f "inspector_ml.stages $name" | head -1 > "$pidf" || true
  wait "$pipe" || true
  rm -f "$pidf"
  local rc; rc=$(cat "$HOST_DIR/stage.rc" 2>/dev/null || echo 1)
  [ "$rc" = 0 ] || echo "ml-host: этап $name завершился с кодом $rc — см. $HOST_DIR/stages.err" >&2
  return "$rc"
}

cmd_status() {
  local ok=0
  if alive "$PIDS/service.pid"; then
    echo "сервис: pid $(cat "$PIDS/service.pid")"
    curl -fsS --max-time 5 --cacert "$VAR/tls/ca.crt" https://localhost:8811/health && echo || ok=1
  else echo "сервис: не запущен"; fi
  for f in "$PIDS"/stage-*.pid; do alive "$f" && echo "этап: $(basename "$f" .pid) pid $(cat "$f")"; done
  return $ok
}

cmd_stop() {
  alive "$PIDS/service.pid" || { echo "сервис не запущен"; return 0; }
  local pid; pid=$(tr -dc '0-9' < "$PIDS/service.pid")
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  echo "сервис остановлен (pid $pid)"
}

case ${1:-} in
  run) cmd_run ;;
  stage) shift; cmd_stage "$@" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
