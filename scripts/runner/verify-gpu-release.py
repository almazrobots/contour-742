"""Read-only verification of the actual pilot's image/code identity, no model calls."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

project = 'w1-feat-resource-ocr-incremental'
expected = sys.argv[1]
assert len(expected) == 40 and all(c in '0123456789abcdef' for c in expected)
images = {}
for name in ('api', 'web', 'ml', 'execution-proxy'):
    c = json.loads(subprocess.check_output(['docker', 'inspect', f'{project}-{name}-1']))[0]
    assert c['State']['Running'] and c['State']['Health']['Status'] == 'healthy'
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', c['Image']]))[0]
    assert image['Config']['Labels']['org.opencontainers.image.revision'] == expected, name
    assert c['Config']['Image'] == c['Image'], (name, 'mutable image reference')
    assert not any(m['Destination'].startswith('/app/ml') for m in c['Mounts']), name
    images[name] = c['Image']
root = Path('ml/inspector_ml')
code = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob('*.py'))}
local_digest = hashlib.sha256(json.dumps(code, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
runtime_digest = subprocess.check_output(['docker','exec',f'{project}-ml-1','python','-c',
    'from inspector_ml.pipeline_runtime import code_digest; print(code_digest())'],text=True).strip()
assert runtime_digest == local_digest, 'running Python differs from checked-out code'
assert images['ml'] == images['execution-proxy']
print(json.dumps({'revision':expected,'images':images,'code_digest':runtime_digest,'source_mounts':0}))
