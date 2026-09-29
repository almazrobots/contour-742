#!/usr/bin/env bash
# T-235. Run on the GPU host only, with a committed eval directory mounted RO.
# BASELINE_ROOT/code/ml/eval must come from git archive of BASELINE_REVISION.
set -euo pipefail

: "${BASELINE_ROOT:?isolated experiment directory required}"
: "${BASELINE_IMAGE:?immutable sha256 image ID required}"
: "${BASELINE_REVISION:?harness commit required}"
limit=${1:-1}
case "$limit" in 1|2|3|4|5|6|7|8|9|10) ;; *) exit 64 ;; esac
[[ "$BASELINE_ROOT" = /opt/resource-ocr/* ]] || { echo 'unexpected experiment root'; exit 64; }
[[ "$BASELINE_IMAGE" = sha256:* ]] || { echo 'image must be immutable'; exit 64; }
[[ "$BASELINE_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'full harness commit required'; exit 64; }
command -v nvidia-smi >/dev/null
exec 9>"$BASELINE_ROOT/run.lock"
flock -n 9 || { echo 'another baseline is running'; exit 75; }

# No backlog or pending Reader requests at admission. This is a diagnostic
# guard, not the global governor planned for later stages.
counts=$(docker exec nadzorium-gpu-rabbitmq-1 rabbitmqctl -q list_queues messages_ready messages_unacknowledged)
if echo "$counts" | awk 'NR>1 && ($1 != 0 || $2 != 0) {bad=1} END {exit !bad}'; then
  echo 'working parse queue is busy; baseline not started'; exit 75
fi
metrics=$(curl -fsS --max-time 5 http://127.0.0.1:8000/metrics)
echo "$metrics" | awk '/^vllm:num_requests_running\{/ {running=1} /^vllm:num_requests_waiting\{/ {waiting=1} END {exit !(running && waiting)}' || {
  echo 'Reader admission metrics unavailable'; exit 75;
}
if echo "$metrics" | awk '/^vllm:num_requests_(running|waiting)\{/ && $NF != 0 {bad=1} END {exit !bad}'; then
  echo 'Reader has active/waiting requests; baseline not started'; exit 75
fi
available=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
[ "$available" -ge 8388608 ] || { echo 'less than 8 GiB RAM available'; exit 75; }
free_gpu=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
[ "$free_gpu" -ge 4096 ] || { echo 'less than 4 GiB VRAM free'; exit 75; }

name="resource-ocr-t235-$limit"
output="run-$limit-$BASELINE_REVISION"
[ ! -e "$BASELINE_ROOT/output/$output" ] || { echo 'output already exists; inspect existing job/results first'; exit 73; }
collector=''
started=0
cleanup() {
  [ "$started" = 0 ] || docker rm -f "$name" >/dev/null 2>&1 || true
  [ -z "$collector" ] || { kill "$collector" 2>/dev/null || true; wait "$collector" 2>/dev/null || true; }
}
trap cleanup EXIT
if docker container inspect "$name" >/dev/null 2>&1; then
  echo 'baseline container already exists; inspect it before starting'; exit 73
fi
nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu,utilization.memory --format=csv --loop-ms=1000 > "$BASELINE_ROOT/output/$output-gpu.csv" &
collector=$!
printf 'image=%s\nrevision=%s\nlimit=%s\n' "$BASELINE_IMAGE" "$BASELINE_REVISION" "$limit"
# One process, capped RAM/CPU, small PP-OCR arena and bounded Reader calls.
# No working service blobs/cache/Redis mounts; no ports published.
started=1
timeout --signal=TERM --kill-after=30s 15m docker run --rm --name "$name" \
  --gpus all --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 \
  --cpus 2 --memory 6g --memory-swap 6g --shm-size 128m \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001 \
  -v "$BASELINE_ROOT/code/ml/eval:/app/ml/eval:ro" \
  -v "$BASELINE_ROOT/output:/baseline" \
  -e INSPECTOR_PROFILE=gpu -e INSPECTOR_OCR_WORKERS=1 \
  -e INSPECTOR_RENDER_PROCS=0 -e INSPECTOR_PPOCR_GPU_MB=1536 \
  -e INSPECTOR_PPOCR_REC_BATCH=8 -e INSPECTOR_VL_INFLIGHT=4 \
  -e INSPECTOR_VLM_BACKEND=openai \
  -e INSPECTOR_VLM_READER=PaddlePaddle/PaddleOCR-VL-1.5 \
  -e INSPECTOR_VLM_URL=http://127.0.0.1:8000/v1 \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  "$BASELINE_IMAGE" python -m eval.resource_ocr_baseline \
  --out "/baseline/$output" --limit "$limit" --revision "$BASELINE_REVISION"
