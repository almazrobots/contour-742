#!/usr/bin/env bash
# Own CPU importer: verifies originals, generates immutable views, imports future finds.
set -euo pipefail
root=/opt/w1-gate/eval/verification/import-review
staging=/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032
code=$(git rev-parse HEAD)
unit=verification-import-structured-t244
if systemctl is-active --quiet "$unit"; then echo 'structured importer already active';exit 0;fi
mkdir -p "$root/structured-code-$code"
chmod 700 "$root/structured-code-$code"
cp scripts/runner/verification-{import,structured}.py "$root/structured-code-$code/"
systemctl reset-failed "$unit" 2>/dev/null || true
systemd-run --unit="$unit" --description='T244 structured original previews and tasks' \
  --property=CPUQuota=100% --property=CPUAffinity='24-29' \
  --property=MemoryHigh=1G --property=MemoryMax=2G --property=MemorySwapMax=0 \
  --property=TasksMax=32 --property=Nice=15 --property=UMask=0077 \
  --property=Restart=on-failure --property=RestartSec=30 --property=RestartPreventExitStatus=65 \
  --property=StartLimitIntervalSec=600 --property=StartLimitBurst=5 \
  --property=StandardOutput="append:$root/structured.log" --property=StandardError="append:$root/structured.log" \
  --setenv=VERIFICATION_CA_FILE=/opt/stand-gpu/tls/ca.crt \
  "$(pwd)/ml/.venv/bin/python" "$root/structured-code-$code/verification-import.py" \
  --staging "$staging" --checkpoint "$root/structured-checkpoint.json" --credentials "$root/credentials.json" \
  --source-version corpus-t244-structured-original-v1 --ingestion working-corpus-structured-t244 --formats structured
echo "structured importer started code=$code"
