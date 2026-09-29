#!/usr/bin/env bash
# vLLM стенда nadzorium-gpu (T-230, OWASP-0212): читатель PaddleOCR-VL-1.5 (:8000), судья Qwen3.5-9B (:8001) и маршрутизатор
# :8010 — команда запуска в репозитории, а не в истории shell. Исполняется на GPU-сервере под root.
#
#   deploy/gpu-stand/vllm.sh warm            скачать ровно закреплённые ревизии в /opt/hf (единственный шаг с сетью)
#   deploy/gpu-stand/vllm.sh up [reader|judge|all]   пересоздать контейнеры: офлайн (HF_HUB_OFFLINE=1), кэш только на чтение
#   deploy/gpu-stand/vllm.sh router          маршрутизатор как служба systemd (DynamicUser, только 127.0.0.1:8010)
#   deploy/gpu-stand/vllm.sh status          контейнеры, образ, ревизии, /v1/models через маршрутизатор
#
# Ревизии — ml/models.yaml (reader/judge: revision, гейт test_model_registry.py сверяет их с этим файлом). Образ — по digest.
# --trust-remote-code не нужен: vLLM 0.30 / transformers 5.17 знают PaddleOCRVLForConditionalGeneration и процессор
# (проверено 28.09 офлайн из /opt/hf: конфиг, токенизатор, процессор — без удалённого кода). Код репозитория HF не исполняется.
# Пересоздание vLLM останавливает разбор: запускать только вне прогонов (systemctl is-active t184-rest и др. — не active).
set -euo pipefail

VLLM_IMAGE=vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90
HF_DIR=${HF_DIR:-/opt/hf}
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "vllm.sh: $*" >&2; exit 1; }

# имя, модель, ревизия, порт хоста, аргументы vllm serve
spec() {
  case "$1" in
    reader) set -- vllm-reader "PaddlePaddle/PaddleOCR-VL-1.5" "2a4195faa5e7914c12f2fc601d72c81caf8d2da5" 8000 \
              --gpu-memory-utilization 0.22 --max-num-seqs 256 ;;  # T-233: 64 слота — очередь 800 запросов при GPU 84 %
    judge)  set -- vllm-judge "Qwen/Qwen3.5-9B" "c202236235762e1c871ad0ccb60c8ee5ba337b9a" 8001 \
              --quantization fp8 --gpu-memory-utilization 0.62 --max-model-len 16384 --max-num-seqs 32 ;;
    *) die "роль: reader | judge" ;;
  esac
  printf '%s\n' "$@"
}

warm() {
  local role name model rev
  for role in reader judge; do
    mapfile -t a < <(spec "$role"); name=${a[0]}; model=${a[1]}; rev=${a[2]}
    echo "  $name: $model@$rev → $HF_DIR"
    docker run --rm -v "$HF_DIR:/root/.cache/huggingface" --entrypoint python3 "$VLLM_IMAGE" \
      -c "import sys; from huggingface_hub import snapshot_download as s; print(s(sys.argv[1], revision=sys.argv[2]))" "$model" "$rev"
  done
}

up_one() {
  local a; mapfile -t a < <(spec "$1")
  local name=${a[0]} model=${a[1]} rev=${a[2]} port=${a[3]}
  [ -d "$HF_DIR/hub/models--${model//\//--}/snapshots/$rev" ] || die "$model@$rev нет в $HF_DIR — сначала vllm.sh warm"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --gpus all --ipc=host \
    -p "127.0.0.1:$port:8000" \
    -v "$HF_DIR:/root/.cache/huggingface:ro" \
    -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e VLLM_NO_USAGE_STATS=1 -e DO_NOT_TRACK=1 \
    "$VLLM_IMAGE" \
    --model "$model" --revision "$rev" --tokenizer-revision "$rev" --served-model-name "$model" "${a[@]:4}" >/dev/null
  echo "  $name: $model@${rev:0:12} · 127.0.0.1:$port"
}

router() {
  install -d -m 0755 /opt/stand-gpu/vlm
  install -m 0644 "$HERE/vlm-router.py" /opt/stand-gpu/vlm/vlm-router.py
  cat > /etc/systemd/system/vlm-router.service <<'UNIT'
[Unit]
Description=Маршрутизатор OpenAI API к vLLM стенда nadzorium-gpu (127.0.0.1:8010)
After=docker.service

[Service]
ExecStart=/usr/bin/python3 /opt/stand-gpu/vlm/vlm-router.py
Restart=always
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6
IPAddressAllow=localhost
IPAddressDeny=any
CapabilityBoundingSet=
MemoryMax=1G

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  # маршрутизатор, запущенный руками (T-165), держит порт — остановить перед службой
  pkill -f '^python3 /opt/inspector/vlm-router.py$' || true
  systemctl enable --now vlm-router.service
  systemctl --no-pager --lines 0 status vlm-router.service | head -3
}

status() {
  docker ps -a --filter name=vllm- --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
  for n in vllm-reader vllm-judge; do
    docker inspect "$n" --format "$n: {{json .Config.Cmd}}" 2>/dev/null | grep -oE '"--revision","[0-9a-f]{12}' || echo "$n: без --revision"
  done
  curl -fsS --max-time 10 http://127.0.0.1:8010/v1/models | python3 -c 'import json,sys; print("  модели:", [m["id"] for m in json.load(sys.stdin)["data"]])' \
    || echo "  маршрутизатор :8010 не отвечает"
}

cmd=${1:-status}; shift || true
case "$cmd" in
  warm) warm ;;
  up)
    case "${1:-all}" in
      all) up_one reader; up_one judge ;;
      reader|judge) up_one "$1" ;;
      *) die "up reader | judge | all" ;;
    esac ;;
  router) router ;;
  status) status ;;
  *) die "команда: warm | up [reader|judge|all] | router | status" ;;
esac
