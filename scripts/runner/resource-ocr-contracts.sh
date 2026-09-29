#!/usr/bin/env bash
# T-236: isolated real GPU / HTTP / Redis verification on the GPU host.
set -euo pipefail
: "${BASELINE_ROOT:?}"
: "${BASELINE_IMAGE:?}"
: "${REDIS_IMAGE:?}"
: "${BASELINE_REVISION:?}"
[[ "$BASELINE_ROOT" = /opt/resource-ocr/t236-* && "$BASELINE_REVISION" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASELINE_IMAGE" = sha256:* && "$REDIS_IMAGE" = sha256:* ]]
embedded=${BASELINE_EMBEDDED_CODE:-0}
[[ "$embedded" = 0 || "$embedded" = 1 ]]
code_mounts=(-v "$BASELINE_ROOT/code/ml/inspector_ml:/app/ml/inspector_ml:ro")
if [ "$embedded" = 1 ]; then
  image_revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BASELINE_IMAGE")
  [ "$image_revision" = "$BASELINE_REVISION" ] || { echo 'Built image revision mismatch'; exit 64; }
  code_mounts=() # Exercise shipped application code, with only the test driver mounted.
fi
exec 9>/opt/resource-ocr/gpu.lock
flock -n 9 || { echo 'another experiment owns GPU admission'; exit 75; }
counts=$(docker exec nadzorium-gpu-rabbitmq-1 rabbitmqctl -q list_queues messages_ready messages_unacknowledged)
echo "$counts" | awk 'NR>1 && ($1 != 0 || $2 != 0) {bad=1} END {exit bad}'
metrics=$(curl -fsS --max-time 5 http://127.0.0.1:8000/metrics)
echo "$metrics" | awk '/^vllm:num_requests_running\{/ {running=1; busy+=$NF} /^vllm:num_requests_waiting\{/ {waiting=1; busy+=$NF} END {exit !(running && waiting && busy==0)}'
[ "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 8388608 ]
[ "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)" -ge 4096 ]
[ ! -e "$BASELINE_ROOT/output/http-probe" ]
app=resource-ocr-t236-http
redis=resource-ocr-t236-redis
for name in "$app" "$redis"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "existing container $name; inspect before retry"; exit 73
  fi
done
# Only names confirmed absent above are owned by this invocation.
cleanup() { docker rm -f "$app" "$redis" >/dev/null 2>&1 || true; }
trap cleanup EXIT
printf 'revision=%s\nml_image=%s\nredis_image=%s\n' "$BASELINE_REVISION" "$BASELINE_IMAGE" "$REDIS_IMAGE"
docker run -d --rm --name "$redis" --network none --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges:true --cpus .25 --memory 128m \
  --memory-swap 128m --pids-limit 32 \
  -v "$BASELINE_ROOT/output:/baseline" "$REDIS_IMAGE" \
  redis-server --port 0 --unixsocket /baseline/redis.sock --unixsocketperm 700 \
  --save '' --appendonly no --dir /baseline >/dev/null
ready=0
for attempt in {1..30}; do
  if docker exec "$redis" redis-cli -s /baseline/redis.sock ping 2>/dev/null | grep -qx PONG; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
timeout --signal=TERM --kill-after=30s 10m docker run --rm --name "$app" \
  --gpus all --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --cpus 2 --memory 6g --memory-swap 6g --pids-limit 128 --shm-size 128m \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001 \
  -v "$BASELINE_ROOT/code/ml/eval:/app/ml/eval:ro" \
  "${code_mounts[@]}" \
  -v "$BASELINE_ROOT/output:/baseline" \
  -e BASELINE_REVISION="$BASELINE_REVISION" \
  -e INSPECTOR_PROFILE=gpu -e INSPECTOR_OCR_WORKERS=1 -e INSPECTOR_RENDER_PROCS=0 \
  -e INSPECTOR_PPOCR_GPU_MB=1536 -e INSPECTOR_PPOCR_REC_BATCH=8 -e INSPECTOR_VL_INFLIGHT=4 \
  -e INSPECTOR_VLM_BACKEND=openai -e INSPECTOR_VLM_READER=PaddlePaddle/PaddleOCR-VL-1.5 \
  -e INSPECTOR_VLM_URL=http://127.0.0.1:8000/v1 -e INSPECTOR_LLM_PROVIDER=none \
  -e INSPECTOR_CACHE=redis -e INSPECTOR_REDIS_URL=unix:///baseline/redis.sock \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  "$BASELINE_IMAGE" python -m eval.resource_ocr_http_probe
