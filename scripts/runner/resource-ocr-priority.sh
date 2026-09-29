#!/usr/bin/env bash
# User-authorized Codex priority profile after the neighbouring session ended.
# Run through remote-run.sh --as-root; never delete data, queues, images or caches.
set -euo pipefail
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || exit 64
R=/opt/w1-gate
project=w1-feat-resource-ocr-incremental
backup="$R/priority-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
chmod 700 "$backup"
for name in cpus.w1 cpus.light nice.w1 nice.b nice.light memory.w1.heavy memory.w1.light; do
  if [[ -f "$R/$name" ]]; then cp "$R/$name" "$backup/$name"; else touch "$backup/$name.absent"; fi
done
systemctl show runner-w1.slice -p MemoryMax -p MemorySwapMax -p CPUWeight > "$backup/runner-w1.before"
for name in nadzorium-gpu-api-1 nadzorium-gpu-ml-1 w1-main-api-1 w1-main-ml-1 vllm-reader "$project-ml-1" buildx_buildkit_resource-ocr0 buildx_buildkit_w10; do
  docker inspect --format '{{.Name}} {{.State.Running}} cpu={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}}' "$name"
done > "$backup/containers.before"

# Close new submissions before checking again. If drain cannot be proved, restore
# the API entry points and leave all ML services running.
drained=0
trap 'if [[ "$drained" == 0 ]]; then docker start nadzorium-gpu-api-1 w1-main-api-1 >/dev/null; fi' EXIT
docker stop --time 60 nadzorium-gpu-api-1 w1-main-api-1
for broker in nadzorium-gpu-rabbitmq-1 w1-main-rabbitmq-1; do
  queues=$(docker exec "$broker" rabbitmqctl -q list_queues name messages_ready messages_unacknowledged)
  printf '%s\n' "$queues"
  # Require a recognized queue row; reject any pending or unacknowledged messages.
  printf '%s\n' "$queues" | awk 'NF==3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {seen++; if ($2+$3>0) bad=1} END {exit(!seen || bad)}'
done
curl --fail --silent --max-time 5 http://127.0.0.1:8000/metrics |
  awk '/^vllm:num_requests_(running|waiting)[{ ]/ {seen++; if ($NF != 0) bad=1} END {exit(!seen || bad)}'
docker stop --time 60 nadzorium-gpu-ml-1 w1-main-ml-1
drained=1
trap - EXIT

printf '8-29\n' > "$R/cpus.w1"
printf '30-31\n' > "$R/cpus.light"
printf '5\n' > "$R/nice.w1"
printf '5\n' > "$R/nice.b"
printf '5\n' > "$R/nice.light"
printf '10G\n' > "$R/memory.w1.heavy"
printf '4G\n' > "$R/memory.w1.light"
systemctl set-property runner-w1.slice MemoryMax=28G MemorySwapMax=0 CPUWeight=200

# Model group retains P-cores 0-7; build work no longer shares those cores.
docker update --cpus 4 --cpuset-cpus 0-7 --memory 12g --memory-swap 12g vllm-reader
docker update --cpus 4 --cpuset-cpus 0-7 --memory 6g --memory-swap 6g "$project-ml-1"
docker update --cpus 6 --cpuset-cpus 8-15 --memory 8g --memory-swap 8g buildx_buildkit_resource-ocr0
# The old builder is idle according to the fresh inventory; preserve its cache volume.
docker stop --time 30 buildx_buildkit_w10
printf 'priority profile applied; restore data: %s\n' "$backup"
free -m
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv,noheader
systemctl show runner-w1.slice -p MemoryMax -p MemorySwapMax -p CPUWeight
