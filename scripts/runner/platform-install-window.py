"""Bounded bootstrap proof; temporarily replace only the idle owned ML pilot.

Retains both deployments and their volumes. Standard nadzorium-gpu and Reader
are never stopped. The predecessor ML is restored on every terminal path.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import time


def info(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--attempt', type=int, default=1, choices=range(1, 10))
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--root', type=Path, default=Path('/opt/resource-ocr/platform-install-prepare-v5-20260929'))
    parser.add_argument('--project', default='platform-install-v5')
    parser.add_argument('--images', type=Path)
    parser.add_argument('--first-job', default='w1job-131010-20117')
    args = parser.parse_args()
    root = args.root
    project = args.project
    if not re.fullmatch(r'/opt/resource-ocr/platform-install-[A-Za-z0-9_-]+', str(root)) or not re.fullmatch(r'platform-install-[a-z0-9-]+', project):
        raise ValueError('isolated installation root/project required')
    if args.first_job and not re.fullmatch(r'w1job-[0-9]+-[0-9]+', args.first_job):
        raise ValueError('invalid bootstrap job')
    revision = (root / 'source/SOURCE_REVISION').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('frozen archive revision required')
    images = args.images or Path(f'/opt/resource-ocr/platform-builds/{revision}/images.json')
    if json.loads(images.read_text())['revision'] != revision:
        raise ValueError('archive/image revision mismatch')
    state = root / 'state'
    previous = info('w1-feat-resource-ocr-incremental-ml-1')
    if previous['Config']['Labels']['com.docker.compose.project'] != 'w1-feat-resource-ocr-incremental' or not previous['State']['Running']:
        raise RuntimeError('expected owned predecessor ML unavailable')
    statuses = subprocess.check_output(['docker', 'exec', 'w1-feat-resource-ocr-incremental-postgres-1',
        'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from inspector.stage_jobs where status not in (\'SUCCEEDED\',\'FAILED\',\'CANCELLED\');"'], text=True).strip()
    if statuses != '0':
        raise RuntimeError('predecessor pipeline has pending work')
    report = {'schema': 'platform-install-window/1', 'previous_container': previous['Id'],
              'standard_gpu_stopped': False, 'reader_stopped': False}
    path = root / f'install-window-{args.attempt}.json'
    if path.exists():
        raise RuntimeError('proof output already exists')
    def save():
        path.write_text(json.dumps(report, indent=2))
    def credentials():
        return {str(p.relative_to(state)): hashlib.sha256(p.read_bytes()).hexdigest()
                for parent in ['secrets', 'tls'] for p in (state / parent).rglob('*') if p.is_file()}
    before = credentials()
    collector_paused = False
    collector_unit = 'verification-corpus-t244.service'
    collector_definition = root / f'collector-{args.attempt}' / collector_unit
    save()
    try:
        if args.smoke:
            pid = int(subprocess.check_output(['systemctl', 'show', collector_unit, '-p', 'MainPID', '--value'], text=True))
            proc = Path('/proc') / str(pid)
            if pid <= 0 or b'teacher.corpus_queue' not in (proc / 'cmdline').read_bytes().split(b'\0'):
                raise RuntimeError('expected resumable collector unavailable')
            log = Path(os.readlink(proc / 'fd/1'))
            if not str(log).startswith('/opt/w1-gate/eval/verification/') or log.name != 'runner.log':
                raise RuntimeError('unexpected collector checkpoint location')
            collector_definition.parent.mkdir(mode=0o700, exist_ok=False)
            collector_definition.write_bytes(subprocess.check_output(['systemctl', 'cat', collector_unit]))
            with sqlite3.connect(f'file:{log.parent}/candidates.sqlite?mode=ro', uri=True) as source:
                with sqlite3.connect(root / f'collector-checkpoint-{args.attempt}.sqlite') as target:
                    source.backup(target)
            collector_paused = True
            subprocess.run(['systemctl', 'stop', collector_unit], check=True, timeout=35)
        subprocess.run(['docker', 'stop', '--time', '30', previous['Id']], check=True, capture_output=True, timeout=40)
        # The already-running first bootstrap is the sole owner of its startup
        # lock. Observe it; never launch a competing duplicate.
        deadline = time.monotonic() + 240
        while args.first_job and subprocess.run(['systemctl', 'is-active', '--quiet', args.first_job]).returncode == 0:
            if time.monotonic() >= deadline:
                raise TimeoutError('first bootstrap did not terminate')
            time.sleep(2)
        env = dict(os.environ, DOCKER_CONFIG=str(root / 'docker-config'))
        command = ['python3', str(root / 'source/scripts/platform-start.py'), '--state', str(state),
            '--project', project, '--images', str(images),
            '--external-reader-container', 'vllm-reader', '--reader-controller', '/opt/resource-ocr/node-agent']
        deployment = json.loads((state / 'deployment.json').read_text())
        if deployment['project'] != project:
            raise ValueError('deployment project mismatch')
        for name, port in zip(['web', 'ml', 'proxy', 'redis'], deployment['ports'], strict=True):
            command.extend(['--'+name+'-port', str(port)])
        health_file = state / 'health.json'
        if not health_file.exists() or json.loads(health_file.read_text()).get('revision') != revision:
            # The first attempt is confirmed terminal above. Retry the same
            # installation state, without a second live startup or new OCR.
            with (root / f'start-recovered-{args.attempt}.log').open('w') as logs:
                subprocess.run(command, env=env, stdout=logs, stderr=logs, timeout=180, check=True)
        health = json.loads((state / 'health.json').read_text())
        if health.get('revision') != revision:
            raise RuntimeError('first bootstrap revision mismatch')
        report['first_start_revision'] = revision
        save()
        with (root / f'start-repeat-{args.attempt}.log').open('w') as logs:
            result = subprocess.run(command, env=env, stdout=logs, stderr=logs, timeout=180)
        report['repeat_start_exit_code'] = result.returncode
        report['credentials_unchanged'] = credentials() == before
        save()
        if result.returncode or not report['credentials_unchanged']:
            raise RuntimeError('repeat bootstrap failed continuity check')
        if args.smoke:
            smoke_env = dict(os.environ, PIPELINE_SMOKE_URL=f"https://127.0.0.1:{deployment['ports'][0]}",
                PIPELINE_SMOKE_PASSWORD_FILE=str(state / 'secrets/demo_password'),
                PIPELINE_SMOKE_OUTPUT=str(root / f'pipeline-smoke-{args.attempt}'), PIPELINE_SMOKE_COMPLETE='1',
                PIPELINE_SMOKE_VERIFICATION='1')
            with (root / f'pipeline-smoke-{args.attempt}.log').open('w') as logs:
                smoke = subprocess.run(['node', 'scripts/runner/pipeline-stand-smoke.mjs'], env=smoke_env,
                                       stdout=logs, stderr=logs, timeout=600)
            report['pipeline_smoke_exit_code'] = smoke.returncode
            save()
            if smoke.returncode:
                raise RuntimeError('complete synthetic pipeline failed; inspect private smoke evidence')
    finally:
        # Every restore action must run even if the new installation failed
        # before creating ML or stopping its container raises an exception.
        restore_errors = []
        try:
            found = subprocess.run(['docker', 'inspect', f'{project}-ml-1'], capture_output=True, text=True)
            if found.returncode == 0:
                current = json.loads(found.stdout)[0]
                if current['Config']['Labels'].get('com.docker.compose.project') != project:
                    raise RuntimeError('new ML ownership mismatch')
                subprocess.run(['docker', 'stop', '--time', '30', current['Id']], check=True, capture_output=True, timeout=40)
                report['new_ml_paused_after_window'] = not info(current['Id'])['State']['Running']
            else:
                report['new_ml_container_absent'] = True
        except Exception as error:
            restore_errors.append('new_ml_stop:' + type(error).__name__)
        try:
            subprocess.run(['docker', 'start', previous['Id']], check=True, capture_output=True, timeout=40)
            report['previous_ml_resumed'] = info(previous['Id'])['State']['Running']
        except Exception as error:
            restore_errors.append('previous_ml_resume:' + type(error).__name__)
        if collector_paused:
            try:
                fragment = subprocess.check_output(['systemctl', 'show', collector_unit, '-p', 'FragmentPath', '--value'], text=True).strip()
                if not fragment:
                    subprocess.run(['systemctl', 'link', '--runtime', str(collector_definition)], check=True)
                subprocess.run(['systemctl', 'start', collector_unit], check=True, timeout=35)
                report['collector_resumed'] = int(subprocess.check_output(['systemctl', 'show', collector_unit, '-p', 'MainPID', '--value'], text=True)) > 0
            except Exception as error:
                restore_errors.append('collector_resume:' + type(error).__name__)
        report['restore_errors'] = restore_errors
        save()
        if restore_errors:
            raise RuntimeError('window restoration incomplete: ' + ','.join(restore_errors))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
