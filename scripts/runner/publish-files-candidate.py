"""Publish tested static assets over the exact web image; API/GPU unchanged."""
import datetime, hashlib, json, subprocess
from pathlib import Path

def out(*args): return subprocess.check_output(args).decode().strip()
def run(*args): subprocess.run(args,check=True)
current=json.loads(out('docker','inspect','nadzorium-gpu-web-1'))[0]
expected='inspector-verification-main-menu:e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a'
assert current['Config']['Image']==expected, 'Web changed: review before publication'
root=Path('out/files-candidate').resolve()
for name,digest in [('index-JNMiEqrR.js','5719a6eee9744d568afd917dc286e99dfb35cb4cae6cd67331c536cbab0cfefa'),('index-D77tWavi.css','28d1bf35c3007319799ffa5ecd56d25b626802f1ee9fabe2eeeb11d5274630b0')]:
 assert out('docker','exec',current['Id'],'sha256sum','/usr/share/nginx/html/assets/'+name).split()[0]==digest
 assert digest in (root/'baseline-sha.txt').read_text()
rev=(root/'patch-revision.txt').read_text().strip()
assert len(rev)==40 and all(c in '0123456789abcdef' for c in rev)
evidence=Path('/opt/w1-gate/eval/verification/main-menu')/('files-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
evidence.mkdir(mode=0o700,parents=True)
labels=current['Config']['Labels'];configs=labels['com.docker.compose.project.config_files'].split(',')
assert configs[0]=='/opt/stand-gpu/src/deploy/gpu-stand/compose.yml'
assert all(Path(p).resolve().is_relative_to(evidence.parent.resolve()) for p in configs[1:])
(root/'Dockerfile').write_text('FROM '+current['Image']+'\nUSER 0\nCOPY dist/ /usr/share/nginx/html/\nRUN chown -R root:root /usr/share/nginx/html && chmod -R a-w /usr/share/nginx/html\nUSER 101\n')
image='inspector-files-registry:'+rev
run('docker','build','--network=none','-t',image,str(root))
assert json.loads(out('docker','inspect','nadzorium-gpu-web-1'))[0]['Id']==current['Id']
override=evidence/'override.json';override.write_text(json.dumps({'services':{'web':{'image':image}}}))
compose=['docker','compose','--env-file',labels['com.docker.compose.project.environment_file'],'-f',configs[0],'-f',str(override)]
(evidence/'before.json').write_text(json.dumps({'image':expected,'configs':configs,'revision':rev}))
try:
 run(*compose,'up','-d','--no-deps','--no-build','web')
 run('curl','--retry','10','--retry-connrefused','--retry-delay','1','--cacert','/opt/stand-gpu/tls/ca.crt','-fsS','-o','/dev/null','https://127.0.0.1:46443/health')
 actual=out('docker','exec','nadzorium-gpu-web-1','cat','/usr/share/nginx/html/index.html')
 assert actual==(root/'dist/index.html').read_text().strip()
except Exception:
 override.write_text(json.dumps({'services':{'web':{'image':expected}}}))
 run(*compose,'up','-d','--no-deps','--no-build','web')
 raise
(evidence/'status.json').write_text(json.dumps({'published':True,'image':image,'api_gpu_restarted':False}))
print(json.dumps({'published':True,'image':image,'evidence':str(evidence),'api_gpu_restarted':False}))
