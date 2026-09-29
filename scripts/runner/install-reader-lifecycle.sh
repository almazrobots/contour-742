#!/usr/bin/env bash
# T-239: fixed Reader actuator, installed on the GPU host through remote-run.
set -euo pipefail
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || exit 64
base=${READER_LIFECYCLE_BASE:-/opt/resource-ocr/node-agent}
revision=${READER_LIFECYCLE_REVISION:-$(git rev-parse HEAD)}
reader_container=${READER_LIFECYCLE_CONTAINER:-vllm-reader}
[[ "$base" =~ ^/[a-zA-Z0-9_./-]+$ && "$base" != *..* && "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ "$reader_container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || exit 64
release="$base/releases/$revision"
unit=${READER_LIFECYCLE_UNIT:-resource-ocr-reader-lifecycle.service}
[[ "$unit" =~ ^[a-zA-Z0-9_-]+\.service$ ]] || exit 64
[[ $# == 0 || ( $# == 1 && $1 == --restart-helper ) ]] || exit 64
install -d -m 0755 -o root -g root "$base" "$base/releases" "$release" "$release/inspector_ml"
install -d -m 0750 -o root -g 10001 "$base/control"
for module in __init__ reader_lifecycle resource_telemetry resource_admission; do
  install -m 0644 -o root -g root "ml/inspector_ml/$module.py" "$release/inspector_ml/$module.py"
done
# Keep the identity across deployments. A replaced container requires explicit reconciliation.
python3 - "$base" "$reader_container" <<'PY'
import json, os, pathlib, subprocess, sys, uuid
base = pathlib.Path(sys.argv[1])
reader_name = sys.argv[2]
container = json.loads(subprocess.check_output(['docker', 'inspect', reader_name]))[0]
gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'], text=True).split()
if len(gpu) != 1:
    raise SystemExit('expected one pinned GPU')
path = base / 'reader-policy.json'
if path.exists():
    policy = json.loads(path.read_text())
    if (policy['container_id'], policy['container_name'], policy['gpu_uuid']) != (container['Id'], reader_name, gpu[0]):
        raise SystemExit('Reader identity changed; reconcile before installation')
else:
    policy = dict(policy_identity=str(uuid.uuid4()), container_id=container['Id'], container_name=reader_name, gpu_uuid=gpu[0])
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(policy, stream)
        stream.flush()
        os.fsync(stream.fileno())
PY
# This changes restart ownership only; it neither stops nor reloads the model.
docker update --restart=no "$reader_container" >/dev/null
if [ "${1:-}" = --restart-helper ]; then
  # Restart only the actuator process, never the Reader container or its model.
  systemctl stop "$unit"
fi
if systemctl is-active --quiet "$unit"; then
  echo 'Reader helper already active; keeping its pinned release until a controlled restart'
else
  systemctl stop "$unit" 2>/dev/null || true
  cat > "/etc/systemd/system/$unit" <<EOF
[Unit]
Description=Fixed Reader lifecycle actuator for resource OCR supervisor
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=root
Group=root
Environment=PYTHONPATH=$release
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStartPre=/usr/bin/rm -f $base/control/reader.sock
ExecStart=/usr/bin/python3 -m inspector_ml.reader_lifecycle --policy $base/reader-policy.json --socket $base/control/reader.sock
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
KillMode=control-group
CPUQuota=50%
MemoryMax=256M
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$unit"
fi
policy_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["policy_identity"])' "$base/reader-policy.json")
for attempt in $(seq 1 20); do
  if [ -S "$base/control/reader.sock" ]; then break; fi
  sleep 0.25
done
curl --fail --silent --show-error --max-time 15 --unix-socket "$base/control/reader.sock" \
  -H 'Content-Type: application/json' -d "{\"policy_identity\":\"$policy_id\"}" http://localhost/probe
echo
