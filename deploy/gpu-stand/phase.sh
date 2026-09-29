#!/usr/bin/env bash
# Фазы видеопамяти стенда nadzorium-gpu (T-233, docs/plan/QUEUE-GPU-ALL-OBJECTS.md). Исполняется на GPU-сервере под root.
#
#   deploy/gpu-stand/phase.sh A        массовый разбор: судья выгружен из GPU, ML — 6 процессов с ареной OCR 1,5 ГБ
#   deploy/gpu-stand/phase.sh B        сверка: судья загружен, ML — 3 процесса с ареной 1 ГБ; проверки с файлами,
#                                      разобранными без судьи, переанализируются (из кэша разбора — OCR не повторяется)
#   deploy/gpu-stand/phase.sh status   фаза, контейнеры vLLM, видеопамять
#
# Судья и 6 процессов OCR вместе в 24 ГБ не помещаются: 4 процесса рядом с судьёй уже роняли ONNX по памяти (BFCArena).
# Фаза пишется в /opt/stand-gpu/tuning.env (GPU_JUDGE_PHASE, GPU_ML_WORKERS, GPU_PPOCR_GPU_MB) — скрипт стенда её подхватывает.
set -euo pipefail
BASE=/opt/stand-gpu
SRC=$BASE/src
TUNING=$BASE/tuning.env
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "phase.sh: $*" >&2; exit 1; }

set_tuning() {  # $1 — ключ, $2 — значение: заменить строку или добавить
  touch "$TUNING"
  if grep -q "^$1=" "$TUNING"; then sed -i "s/^$1=.*/$1=$2/" "$TUNING"; else echo "$1=$2" >> "$TUNING"; fi
}

ml_up() { GPU_STAND_REMOTE=1 bash "$SRC/scripts/gpu-stand.sh" up ml; }

q() { docker exec nadzorium-gpu-postgres-1 psql -U postgres -d inspector -At -c "set search_path=inspector; $1" | grep -v '^SET'; }

reanalyze() {  # все проверки не в разборе и не финализированные — старт: API сам берёт файлы с прежней ревизией ML
  local tok id n=0
  # тело входа — через stdin: пароль не попадает в командную строку процесса (видна в ps)
  tok=$(python3 -c 'import json,sys; print(json.dumps({"login": "inspector", "password": open(sys.argv[1]).read().strip()}))' \
      "$BASE/secrets/demo_password" \
    | curl -sf --cacert "$BASE/tls/ca.crt" --resolve web:46443:127.0.0.1 https://web:46443/api/v1/auth/login \
      -H 'content-type: application/json' --data-binary @- \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') || die "вход в API не удался"
  for id in $(q "select id from inspections where status not in ('PARSING','FINALIZED')"); do
    curl -s -o /dev/null --cacert "$BASE/tls/ca.crt" --resolve web:46443:127.0.0.1 -X POST \
      "https://web:46443/api/v1/inspection/$id/start" -H "authorization: Bearer $tok" && n=$((n + 1))
  done
  echo "  переанализ запрошен: $n проверок (файлы прежней ревизии ML — из кэша разбора)"
}

# сбой посреди переключения — вернуть прежние настройки фазы (tuning.env) и сказать громко: стенд мог остаться между фазами
restore_on_fail() {
  local rc=$?
  [ $rc -eq 0 ] && return
  [ -f "$TUNING.before-phase" ] && cp "$TUNING.before-phase" "$TUNING"
  echo "phase.sh: СБОЙ (код $rc) — tuning.env возвращён к прежней фазе; проверьте phase.sh status и перезапустите фазу" >&2
}
case "${1:-}" in A|B) cp "$TUNING" "$TUNING.before-phase" 2>/dev/null || true; trap restore_on_fail EXIT ;; esac

case "${1:-}" in
  A)
    echo "▶ фаза A — массовый разбор: судья выгружен"
    set_tuning GPU_JUDGE_PHASE off; set_tuning GPU_ML_WORKERS 6; set_tuning GPU_PPOCR_GPU_MB 1536
    docker stop vllm-judge >/dev/null 2>&1 || true
    ml_up
    ;;
  B)
    echo "▶ фаза B — сверка: судья загружен"
    set_tuning GPU_JUDGE_PHASE on; set_tuning GPU_ML_WORKERS 3; set_tuning GPU_PPOCR_GPU_MB 1024
    ml_up  # сначала ужать OCR — место под судью
    docker rm -f vllm-judge >/dev/null 2>&1 || true
    bash "$HERE/vllm.sh" up judge
    for _ in $(seq 1 60); do curl -sf -m 5 127.0.0.1:8001/v1/models >/dev/null && break; sleep 10; done
    curl -sf -m 5 127.0.0.1:8001/v1/models >/dev/null || die "судья не поднялся за 10 мин"
    reanalyze
    ;;
  status)
    grep -E '^GPU_(JUDGE_PHASE|ML_WORKERS|PPOCR_GPU_MB)=' "$TUNING" || true
    docker ps --format '{{.Names}} {{.Status}}' | grep -E 'vllm|nadzorium-gpu-ml' || true
    nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader
    ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
