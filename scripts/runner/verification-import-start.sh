#!/usr/bin/env bash
# Durable CPU-only bridge to the isolated module database. No model/container lifecycle.
set -euo pipefail
root=/opt/w1-gate/eval/verification/import-review
staging=/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032
code=$(git rev-parse HEAD)
mkdir -p "$root/code-$code"
chmod 700 "$root" "$root/code-$code"
test -s "$root/credentials.json"
test -s "$staging/candidates.sqlite"
cp scripts/runner/verification-import.py "$root/code-$code/verification-import.py"
chmod 600 "$root/code-$code/verification-import.py"
for operation in reading pairs; do
  unit="verification-import-$operation-t244"
  if systemctl is-active --quiet "$unit"; then
    echo "verification: $unit already active; no duplicate"
    continue
  fi
  checkpoint="$root/checkpoint.json"
  ingestion=working-corpus-t244
  if [ "$operation" = pairs ]; then
    checkpoint="$root/pairs-checkpoint.json"
    ingestion=working-corpus-pairs-t244
  fi
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemd-run --unit="$unit" --description="T244 durable $operation annotation tasks" \
    --property=CPUQuota=100% --property=CPUAffinity='24-29' \
    --property=MemoryHigh=512M --property=MemoryMax=1G --property=MemorySwapMax=0 \
    --property=TasksMax=32 --property=Nice=15 --property=UMask=0077 \
    --property=Restart=on-failure --property=RestartSec=30 --property=RestartPreventExitStatus=65 \
    --property=StartLimitIntervalSec=600 --property=StartLimitBurst=5 --property=TimeoutStopSec=15 \
    --property=StandardOutput="append:$root/$operation.log" --property=StandardError="append:$root/$operation.log" \
    --setenv=VERIFICATION_CA_FILE=/opt/stand-gpu/tls/ca.crt \
    /usr/bin/python3 "$root/code-$code/verification-import.py" \
    --staging "$staging" --checkpoint "$checkpoint" --credentials "$root/credentials.json" \
    --source-version corpus-t244-20260929-a4ee35e8 --ingestion "$ingestion" --operation "$operation"
  echo "verification: started $unit code=$code target=private-review"
done
