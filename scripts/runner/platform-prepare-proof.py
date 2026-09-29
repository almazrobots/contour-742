"""Exercise the packaged bootstrap twice without launching model/services.

Uses a frozen git archive, not a mutable runner checkout. Private state and
credentials are retained outside source. Never adopts an existing directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--project', default='platform-prepare-proof')
    for name, default in [('web',49443), ('ml',49511), ('proxy',49512), ('redis',49379)]:
        parser.add_argument('--'+name+'-port', type=int, default=default)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'/opt/resource-ocr/platform-install-[A-Za-z0-9_-]+', str(args.output)):
        raise ValueError('root and isolated installation proof path required')
    os.umask(0o077)
    manifest = json.loads(args.images.read_text())
    revision = manifest['revision']
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('full source revision required')
    args.output.mkdir(mode=0o700, exist_ok=False)
    # The runner isolates HOME; its tools are deliberately not installed in
    # that HOME. Make discovery explicit only for this private proof process.
    docker_config = args.output / 'docker-config'
    docker_config.mkdir(mode=0o700)
    (docker_config / 'config.json').write_text(json.dumps({
        'cliPluginsExtraDirs': ['/opt/w1-gate/tools/docker/cli-plugins'],
    }))
    environment = dict(os.environ, DOCKER_CONFIG=str(docker_config))
    source = args.output / 'source'
    source.mkdir()
    archive = args.output / 'source.tar'
    with archive.open('wb') as stream:
        subprocess.run(['git', 'archive', '--format=tar', revision], stdout=stream, check=True)
    subprocess.run(['tar', '-xf', str(archive), '-C', str(source)], check=True)
    (source / 'SOURCE_REVISION').write_text(revision + '\n')
    for path in source.rglob('*'):
        if path.is_dir():
            path.chmod(path.stat().st_mode | 0o555)
        elif path.is_file():
            path.chmod(path.stat().st_mode | 0o444)
    state = args.output / 'state'
    project = args.project
    command = ['python3', str(source / 'scripts/platform-start.py'), '--state', str(state), '--project', project,
               '--images', str(args.images), '--prepare-only']
    for name in ['web', 'ml', 'proxy', 'redis']:
        command.extend(['--'+name+'-port', str(getattr(args, name+'_port'))])
    with archive.open('rb') as stream:
        archive_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    report = {'schema': 'platform-prepare-proof/1', 'revision': revision,
              'harness_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'source_archive_sha256': archive_sha,
              'source_is_git_checkout': (source / '.git').exists(), 'services_started': False}
    def save():
        (args.output / 'evidence.json').write_text(json.dumps(report, indent=2))
    def containers():
        return sorted(subprocess.check_output(['docker', 'ps', '-q'], text=True).split())
    def credentials():
        paths = sorted((state / 'secrets').rglob('*')) + sorted((state / 'tls').rglob('*'))
        return {str(p.relative_to(state)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in paths if p.is_file()}
    before = containers()
    save()
    for index in [1, 2]:
        with (args.output / f'prepare-{index}.log').open('w') as logs:
            result = subprocess.run(command, stdout=logs, stderr=logs, timeout=300, env=environment)
        report[f'prepare_{index}_exit_code'] = result.returncode
        save()
        if result.returncode:
            raise RuntimeError('bootstrap preparation failed; inspect private logs')
        if index == 1:
            saved_credentials = credentials()
            identities = {name: (state / name).read_bytes() for name in ['execution-proxy.identity', 'local-execution.identity']}
    report['credentials_unchanged'] = credentials() == saved_credentials
    report['journal_identities_unchanged'] = all((state / name).read_bytes() == value for name, value in identities.items())
    report['running_container_ids_unchanged'] = containers() == before
    report['tls_directories_traversable'] = all(p.stat().st_mode & 0o555 == 0o555 for p in (state / 'tls').rglob('*') if p.is_dir())
    report['host_state_private'] = state.stat().st_mode & 0o077 == 0
    save()
    if not all(report[k] for k in ['credentials_unchanged', 'journal_identities_unchanged',
                                  'running_container_ids_unchanged', 'tls_directories_traversable', 'host_state_private']):
        raise RuntimeError('repeat preparation violated continuity or service isolation')
    print(json.dumps({k: v for k, v in report.items() if not k.endswith('sha256')}))


if __name__ == '__main__':
    main()
