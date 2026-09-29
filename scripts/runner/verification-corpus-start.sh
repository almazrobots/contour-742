#!/usr/bin/env bash
# Run via remote-run.sh --light --as-root; no container lifecycle operations.
set -euo pipefail
unit=verification-corpus-t244
if systemctl is-active --quiet "$unit"; then
  echo 'verification: already active; not launching a duplicate'
  exit 0
fi
code=$(git rev-parse HEAD)
root=${VERIFICATION_RUN_ROOT:-/opt/w1-gate/eval/verification/t244-$code}
case "$root" in /opt/w1-gate/eval/verification/t244-*) ;; *) echo 'invalid private run root'; exit 64 ;; esac
src="$root/code-$code"
mkdir -p "$src"
chmod 700 "$root" "$src"
rsync -a --exclude=.git --exclude=node_modules --exclude=.venv --exclude=var --exclude=__pycache__ ./ "$src/"
python_bin="$PWD/ml/.venv/bin/python"
"$python_bin" - <<'PY'
import json,subprocess
cmd=json.loads(subprocess.check_output(['docker','inspect','vllm-reader','--format','{{json .Config.Cmd}}']))
expected={'--model':'PaddlePaddle/PaddleOCR-VL-1.5','--revision':'2a4195faa5e7914c12f2fc601d72c81caf8d2da5',
          '--tokenizer-revision':'2a4195faa5e7914c12f2fc601d72c81caf8d2da5'}
for flag,value in expected.items():
    if flag not in cmd or cmd[cmd.index(flag)+1] != value:
        raise RuntimeError('resident Reader differs from inspected profile')
print('verification: resident model/revisions match; no model launch')
PY
systemctl reset-failed "$unit" 2>/dev/null || true
systemd-run --unit="$unit" --description='T244 resumable corpus candidate staging' \
  --property=WorkingDirectory="$src/ml" --property=CPUQuota=1800% \
  --property=CPUAffinity='0-29' --property=MemoryHigh=24G --property=MemoryMax=28G \
  --property=MemorySwapMax=0 --property=TasksMax=512 --property=Nice=10 \
  --property=RuntimeMaxSec=86400 --property=TimeoutStopSec=20 --property=UMask=0077 \
  --property=StandardOutput="append:$root/runner.log" --property=StandardError="append:$root/runner.log" \
  --setenv="VERIFICATION_CODE_SHA=$code" --setenv=OPENBLAS_NUM_THREADS=1 \
  --setenv=OMP_NUM_THREADS=1 --setenv=INSPECTOR_PROFILE=dev --setenv=INSPECTOR_VLM_BACKEND=none \
  "$python_bin" -m teacher.corpus_queue --out "$root" --workers 16 --gpu-max 16 --gpu --historical-refs
echo "verification: unit=$unit private_output=$root code=$code"
