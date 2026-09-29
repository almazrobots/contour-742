"""Publish just the annotation feature; validate and reload Caddy, no GPU lifecycle."""
import datetime,hashlib,json,re,subprocess,time
from pathlib import Path

BASE_LOCK='@locked not path /api/* /health'
FEATURE_LOCK=BASE_LOCK+' /verification/api/* /verification/health'
def patch(config,fragment):
    config=re.sub(r'\s*# T244-BEGIN\n.*?# T244-END\n','\n',config,flags=re.S)
    if config.count(FEATURE_LOCK)==1:pass
    elif config.count(BASE_LOCK)==1:config=config.replace(BASE_LOCK,FEATURE_LOCK)
    else:raise ValueError('unexpected Caddy auth matcher; refusing replacement')
    upstream='\treverse_proxy https://127.0.0.1:46443 {'
    if config.count(upstream)!=1:raise ValueError('unexpected main upstream; refusing replacement')
    return config.replace(upstream,''.join('\t'+line+'\n' for line in fragment.splitlines())+upstream)

def run():
    host=Path('/opt/stand-gpu/src/deploy/gpu-stand/Caddyfile')
    before=host.read_bytes();candidate=patch(before.decode(),Path('deploy/verification/Caddyfile.fragment').read_text()).encode()
    root=Path('/opt/w1-gate/eval/verification/public-rollout');root.mkdir(mode=0o700,exist_ok=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');evidence=root/stamp;evidence.mkdir(mode=0o700)
    for name,data in [('Caddyfile.before',before),('Caddyfile.after',candidate)]:
        p=evidence/name;p.write_bytes(data);p.chmod(0o600)
    validate=subprocess.run(['docker','exec','-i','nadzorium-gpu-caddy-1','caddy','validate','--config','/dev/stdin','--adapter','caddyfile'],input=candidate,capture_output=True)
    (evidence/'validation.log').write_bytes(validate.stdout+validate.stderr)
    if validate.returncode:raise RuntimeError('Caddy validation failed; configuration unchanged')
    # Rehearsal DB has its own annotation accounts/session namespace. Revoke only
    # sessions restored from the old snapshot; keep subsequently issued module sessions.
    marker=root/'restored-sessions-revoked.json'
    if not marker.exists():
        cutoff=datetime.datetime.fromtimestamp(Path('/opt/w1-gate/eval/verification/review-database/source.dump').stat().st_mtime,datetime.timezone.utc).isoformat()
        sql=f"delete from inspector.sessions where created_at <= '{cutoff}'::timestamptz;"
        proc=subprocess.run(['docker','exec','-i','-u','postgres','nadzorium-verification-postgres-1','psql','-d','inspector','-v','ON_ERROR_STOP=1'],input=sql.encode(),capture_output=True)
        if proc.returncode:raise RuntimeError('restored session revocation failed')
        marker.write_text(json.dumps({'cutoff_utc':cutoff,'revoked':True}));marker.chmod(0o600)
    if host.read_bytes()!=before:raise RuntimeError('Caddy configuration changed concurrently; no overwrite')
    # Keep the inode when possible. A bind may already refer to an older, unlinked
    # inode from an earlier rollout; a reload of that path would silently load old routes.
    host.write_bytes(candidate)
    mounted=subprocess.check_output(['docker','exec','nadzorium-gpu-caddy-1','cat','/etc/caddy/Caddyfile'])
    repaired_bind=mounted!=candidate
    if repaired_bind:
        subprocess.run(['docker','restart','--time','10','nadzorium-gpu-caddy-1'],capture_output=True,check=True)
        mounted=subprocess.check_output(['docker','exec','nadzorium-gpu-caddy-1','cat','/etc/caddy/Caddyfile'])
        if mounted!=candidate:raise RuntimeError('Caddy bind still stale after proxy restart')
    reload=['docker','exec','nadzorium-gpu-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile','--address','unix//tmp/caddy-admin.sock']
    for attempt in range(5):
        result=subprocess.run(reload,capture_output=True)
        if result.returncode==0:break
        time.sleep(.5)
    (evidence/'reload.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:
        host.write_bytes(before);subprocess.run(reload,capture_output=True,check=True)
        raise RuntimeError('feature reload failed; previous configuration restored')
    report={'feature_url':'https://nadzorium-gpu.almazrobots.ru/verification/','config_sha256':hashlib.sha256(candidate).hexdigest(),
            'main_upstream_preserved':True,'gpu_lifecycle_operations':0,'stale_proxy_bind_repaired':repaired_bind,'backup':str(evidence/'Caddyfile.before')}
    p=evidence/'status.json';p.write_text(json.dumps(report));p.chmod(0o600);print(json.dumps(report))

if __name__=='__main__':run()
