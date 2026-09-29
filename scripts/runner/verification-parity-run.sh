#!/usr/bin/env bash
# A separate temporary PostgreSQL with synthetic tests only; no production DB mutation.
set -euo pipefail
root=/opt/w1-gate/eval/verification/parity
mkdir -p "$root"
chmod 700 "$root"
python3 - <<'PY'
from pathlib import Path
import secrets
p=Path('/opt/w1-gate/eval/verification/parity/password');p.write_text(secrets.token_hex(32));p.chmod(0o600)
PY
container=verification-t244-parity-pg
if docker inspect "$container" >/dev/null 2>&1; then echo 'parity container already exists; refusing to replace';exit 64;fi
trap 'docker stop --time 10 "$container" >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name "$container" --cpus 2 --memory 2g --memory-swap 2g --pids-limit 128 \
  -p 127.0.0.1:48846:5432 --mount "type=bind,src=$root/password,dst=/run/secrets/password,readonly" \
  --tmpfs /var/lib/postgresql:rw,size=1g \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/password \
  postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true;break;fi
  sleep 1
done
[ "$ready" = true ] || { echo 'isolated parity DB failed readiness';exit 1; }
node scripts/runner/verification-parity-run.mjs
