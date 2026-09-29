#!/usr/bin/env bash
set -euo pipefail
root=/opt/w1-gate/eval/verification/import-review
staging=/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032
mkdir -p "$root"
chmod 700 "$root"
export VERIFICATION_IMPORT_ROOT="$root" VERIFICATION_CA_FILE=/opt/stand-gpu/tls/ca.crt
python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['VERIFICATION_IMPORT_ROOT'])
p=root/'credentials.json';p.write_text(json.dumps({'login':'curator','password':Path('/opt/stand-gpu/secrets/demo_password').read_text().strip()}));p.chmod(0o600)
PY
python3 scripts/runner/verification-import.py --staging "$staging" --checkpoint "$root/checkpoint.json" --credentials "$root/credentials.json" --source-version corpus-t244-20260929-a4ee35e8 --max-batches 2
