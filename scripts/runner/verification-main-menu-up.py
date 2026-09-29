"""Add only the module link to the currently published inspector frontend.

The existing API, ML, databases, proxy, TLS and frontend base revision stay intact.
Keep an explicit Compose override so the original frontend can be restored.
"""
import datetime,json,os,subprocess,tarfile,tempfile
from pathlib import Path

def command(args,**kwargs):
    return subprocess.check_output(args,**kwargs)

def run():
    os.environ['DOCKER_CONFIG']='/opt/w1-gate/tools/docker'
    current=json.loads(command(['docker','inspect','nadzorium-gpu-web-1']))[0]
    base=current['Config']['Labels']['org.opencontainers.image.revision']
    if base!='c0851cc7b78e28e7bd7a477be2d3274010d42144':
        raise RuntimeError('Published frontend base changed; refusing an unreviewed replacement')
    revision=command(['git','rev-parse','HEAD']).decode().strip()
    root=Path('/opt/w1-gate/eval/verification/main-menu')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence=root/stamp;evidence.mkdir(mode=0o700)
    (evidence/'before.json').write_text(json.dumps({'image':current['Config']['Image'],'base':base,'feature_commit':revision}))
    with tempfile.TemporaryDirectory(prefix='main-menu-',dir=root) as name:
        source=Path(name)
        archive=source/'source.tar'
        with archive.open('wb') as stream:subprocess.run(['git','archive',base],stdout=stream,check=True)
        with tarfile.open(archive) as content:content.extractall(source,filter='data')
        archive.unlink()
        main=source/'apps/web/src/main.tsx';text=main.read_text()
        anchor='        {link("/new", "upload", "Загрузка", canWork(role))}'
        if text.count(anchor)!=1:raise RuntimeError('Expected menu anchor absent')
        link='\n        {["inspector","supervisor","admin","curator"].includes(role)&&<a href="/verification/#/verification" title="Разметка данных"><Icon name="list" size={20}/>Разметка данных</a>}\n        {["inspector","supervisor","admin","curator"].includes(role)&&<a href="/verification/#/verification-library" title="Витрина разметки"><Icon name="matrix" size={20}/>Витрина разметки</a>}'
        main.write_text(text.replace(anchor,anchor+link))
        (evidence/'main-menu.patch').write_text(link)
        builder='verification-t244'
        subprocess.run(['docker','buildx','inspect','--bootstrap',builder],check=True,stdout=subprocess.DEVNULL)
        image=f'inspector-verification-main-menu:{revision}'
        with (evidence/'build.log').open('wb') as log:
            subprocess.run(['docker','buildx','build','--builder',builder,'--load','--build-arg',f'REVISION={base}','-t',image,'-f','apps/web/Dockerfile','.'],cwd=source,check=True,stdout=log,stderr=subprocess.STDOUT)
        subprocess.run(['docker','stop','--time','15',f'buildx_buildkit_{builder}0'],check=True,stdout=subprocess.DEVNULL)
    # Check again after the build, including the existing API health. Never stop it.
    actual=json.loads(command(['docker','inspect','nadzorium-gpu-web-1']))[0]
    if actual['Id']!=current['Id']:raise RuntimeError('Frontend changed during build; refusing deployment')
    subprocess.run(['curl','--cacert','/opt/stand-gpu/tls/ca.crt','-fsS','-o','/dev/null','https://127.0.0.1:46443/health'],check=True)
    labels=current['Config']['Labels']
    configs=labels['com.docker.compose.project.config_files'].split(',')
    config=configs[0]
    if config!='/opt/stand-gpu/src/deploy/gpu-stand/compose.yml' or any(not Path(extra).resolve().is_relative_to(root.resolve()) or Path(extra).name!='override.json' for extra in configs[1:]):
        raise RuntimeError('Unknown Compose override requires review')
    # Replace only our prior menu override; retain the authoritative base config.
    override=evidence/'override.json';override.write_text(json.dumps({'services':{'web':{'image':image}}}))
    compose=['docker','compose','--env-file',labels['com.docker.compose.project.environment_file'],'-f',config,'-f',str(override)]
    subprocess.run(compose+['up','-d','--no-deps','--no-build','web'],check=True,cwd=labels['com.docker.compose.project.working_dir'])
    try:
        subprocess.run(['node','scripts/runner/verification-main-menu-smoke.mjs'],check=True)
    except Exception:
        override.write_text(json.dumps({'services':{'web':{'image':current['Config']['Image']}}}))
        subprocess.run(compose+['up','-d','--no-deps','--no-build','web'],check=True,cwd=labels['com.docker.compose.project.working_dir'])
        raise
    (root/'current.json').write_text(json.dumps({'schema':'verification-main-menu-rollout.v1','feature_commit':revision,'base_revision':base,'image':image,'previous_image':current['Config']['Image'],'compose_override':str(override),'api_ml_restarted':False}))
    print(json.dumps({'main_menu':'published','base_revision':base,'feature_commit':revision,'api_ml_restarted':False}))

if __name__=='__main__':run()
