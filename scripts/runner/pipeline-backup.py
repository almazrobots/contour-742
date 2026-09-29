"""Owned pilot snapshot and isolated PostgreSQL restore rehearsal; never restore over live data."""
import argparse
import fcntl
import hashlib
import json
import os
import signal
from pathlib import Path
import subprocess
import time
from datetime import datetime, timezone

PROJECT = 'w1-feat-resource-ocr-incremental'
STAND = Path('/opt/w1-gate/stand')/PROJECT
TABLES = ('inspections','files','pipeline_runs','stage_jobs','stage_artifacts')


def run(*args, timeout=120, **kwargs):
    return subprocess.check_output(args, timeout=timeout, **kwargs)


def sql(query, database='inspector'):
    return run('docker','exec','-u','postgres',PROJECT+'-postgres-1',
               'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,'-Atc',query,text=True).strip()


def counts(database='inspector'):
    return {table:int(sql(f'select count(*) from inspector.{table}',database)) for table in TABLES}


def drained():
    assert sql("select count(*) from inspector.stage_jobs where status in ('RUNNING','RECOVERING')") == '0', 'active stage job'
    root = STAND/'var/pipeline-cache'
    state = json.loads((root/'node-admission-v1/state.json').read_text())['state']
    assert not state['queue'] and not state['reservations'], 'admission not drained'
    for path in (root/'external-executions').glob('*.json'):
        record=json.loads(path.read_text())
        assert all(r['status']!='RUNNING' for r in record.get('requests',{}).values()), 'external generation active'


def healthy(name):
    for _ in range(90):
        state=json.loads(run('docker','inspect','--format','{{json .State}}',name,text=True))
        if state.get('Health',{}).get('Status')=='healthy': return
        time.sleep(1)
    raise TimeoutError(name+' did not become healthy')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);a=parser.parse_args()
    assert os.geteuid()==0
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("termination requested")))
    os.umask(0o077)
    a.output.mkdir(mode=0o700,parents=True,exist_ok=False)
    report={'started':datetime.now(timezone.utc).isoformat(),'scope':'owned synthetic pilot; same-host backup, not off-host disaster recovery'}
    stopped=[];temporary=None
    try:
        with open('/opt/resource-ocr/gpu.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            drained()
            try:
                # Stop new ingress before checking the drain a second time.
                for service in ('api','ml','execution-proxy'):
                    name=PROJECT+'-'+service+'-1'
                    stopped.append(name)  # even a CLI timeout may have stopped it
                    run('docker','stop','--time','30',name)
                    drained()
                report['counts']=counts()
                report['containers']=json.loads(run('docker','inspect',*[PROJECT+'-'+s+'-1' for s in ('api','ml','web','execution-proxy')]))
                with (a.output/'database.dump').open('xb') as stream:
                    subprocess.run(['docker','exec','-u','postgres',PROJECT+'-postgres-1','pg_dump','-U','postgres','-Fc','inspector'],stdout=stream,check=True,timeout=180)
                volume=run('docker','volume','inspect',PROJECT+'_api-blobs','--format','{{.Mountpoint}}',text=True).strip()
                assert volume.startswith('/var/lib/docker/volumes/'+PROJECT+'_api-blobs/')
                subprocess.run(['tar','-cf',str(a.output/'blobs.tar'),'-C',volume,'.'],check=True,timeout=180)
                subprocess.run(['tar','--exclude=*.sock','--exclude=minio-data','-cf',str(a.output/'state.tar'),'-C',str(STAND),'var','override.yml','gpu-override.yml'],check=True,timeout=180)
                temporary='t243_restore_'+str(os.getpid())+'_'+str(int(time.time()))
                run('docker','exec','-u','postgres',PROJECT+'-postgres-1','createdb','-U','postgres',temporary)
                with (a.output/'database.dump').open('rb') as stream:
                    subprocess.run(['docker','exec','-i','-u','postgres',PROJECT+'-postgres-1','pg_restore','-U','postgres','--exit-on-error','--no-owner','--no-acl','-d',temporary],stdin=stream,check=True,timeout=180)
                report['restored_counts']=counts(temporary)
                assert report['restored_counts']==report['counts']
                report['restore_verified']=True
                report['files']={}
                for path in a.output.glob('*.tar'):
                    with path.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
                    report['files'][path.name]={'bytes':path.stat().st_size,'sha256':digest}
                with (a.output/'database.dump').open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
                report['files']['database.dump']={'bytes':(a.output/'database.dump').stat().st_size,'sha256':digest}
            finally:
                cleanup_errors=[]
                if temporary:
                    try:
                        run('docker','exec','-u','postgres',PROJECT+'-postgres-1','dropdb','-U','postgres','--if-exists',temporary)
                    except Exception as exc: cleanup_errors.append('temporary DB: '+str(exc))
                for name in reversed(stopped):
                    try:
                        run('docker','start',name);healthy(name)
                    except Exception as exc: cleanup_errors.append(name+': '+str(exc))
                if cleanup_errors:
                    report['cleanup_errors']=cleanup_errors
                    raise RuntimeError('backup cleanup requires attention')
    except BaseException as exc:
        report['error']=type(exc).__name__+': '+str(exc)
        raise
    finally:
        report['finished']=datetime.now(timezone.utc).isoformat()
        (a.output/'manifest.json').write_text(json.dumps(report,indent=2))
        print(json.dumps({k:report[k] for k in ('restore_verified','counts','error') if k in report}))


if __name__=='__main__': main()
