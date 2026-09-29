#!/usr/bin/env python3
"""Single-host bootstrap for the portable durable Reader/OCR platform profile.

Run on the target Linux GPU host. Reuses existing platform services, pins source
and images, retains credentials/journals on repeat, and never removes a model or
existing deployment. Judge admission and corpus accuracy are separate gates.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

SOURCE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SOURCE / 'deploy/platform'))
from storage import prepare_s3
VLLM_IMAGE = 'vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90'
MODELS = [('PaddlePaddle/PaddleOCR-VL-1.5', '2a4195faa5e7914c12f2fc601d72c81caf8d2da5'),
          ('Qwen/Qwen3.5-9B', 'c202236235762e1c871ad0ccb60c8ee5ba337b9a')]


def run(*args, env=None, log=None, timeout=900):
    if log:
        with Path(log).open('w') as stream:
            subprocess.run(args, env=env, stdout=stream, stderr=stream, check=True, timeout=timeout)
    else:
        subprocess.run(args, env=env, check=True, timeout=timeout)


def output(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def initialize_journal(state, image, name, module, identity_env, identity):
    cache = state / 'pipeline-cache'
    journal = cache / name
    intent = state / (name + '.provisioned')
    if (journal / 'identity.json').exists():
        return
    if journal.exists() or intent.exists():
        raise RuntimeError('journal missing or incomplete; refusing unsafe reinitialization')
    with intent.open('x') as stream:
        stream.write(identity + '\n')
    env = ['-e', f'{identity_env}={identity}']
    if module == 'execution_proxy':
        env += ['-e', f'INSPECTOR_EXECUTION_PROXY_ROOT=/pipeline-cache/{name}']
    else:
        env += ['-e', f'INSPECTOR_PIPELINE_EXECUTIONS_DIR=/pipeline-cache/{name}']
    run('docker', 'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--cpus', '1',
        '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '64',
        '--entrypoint', 'python', '--workdir', '/app/ml', '-v', f'{cache}:/pipeline-cache',
        *env, image, '-m', 'inspector_ml.' + module, '--initialize')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, default=Path('/opt/inspector-platform'))
    parser.add_argument('--project', default='inspector-platform')
    parser.add_argument('--images', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--no-download', action='store_true')
    parser.add_argument('--hf-dir', type=Path)
    parser.add_argument('--external-reader-container')
    parser.add_argument('--reader-controller', type=Path)
    parser.add_argument('--s3-env', type=Path, help='Private YC/AWS credentials file; selects S3, never silently falls back to fs')
    parser.add_argument('--s3-key-file', type=Path, help='Original S3 corpus encryption key (separate from local cache key)')
    parser.add_argument('--s3-prefix', help='Writable object prefix (default blobs/)')
    parser.add_argument('--s3-read-prefixes', help='Comma-separated historical prefixes using the same encryption key')
    for name, default in [('web', 49443), ('ml', 49511), ('proxy', 49512), ('redis', 49379)]:
        parser.add_argument('--' + name + '-port', type=int, default=default)
    args = parser.parse_args()
    os.umask(0o077)
    os.chdir(SOURCE)
    if os.geteuid() != 0 or not Path('/proc/sys/kernel/random/boot_id').exists():
        raise RuntimeError('Linux root required on the target host')
    revision_file = SOURCE / 'SOURCE_REVISION'
    source_revision = revision_file.read_text().strip() if revision_file.exists() else output('git', 'rev-parse', 'HEAD')
    revision = args.revision or source_revision
    if revision != source_revision:
        raise ValueError('revision differs from the actual source')
    if not revision_file.exists():
        run('git', 'diff', '--quiet', 'HEAD', '--', '.', ':!.claude')
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', args.project):
        raise ValueError('full source revision and bounded project name required')
    state = args.state.resolve()
    if state == Path('/') or state == SOURCE or SOURCE in state.parents or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(state)):
        raise ValueError('state must live outside the source archive')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    startup_lock = (state / '.startup.lock').open('a')
    fcntl.flock(startup_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    bootstrap = {'schema': 'platform-bootstrap/1', 'project': args.project,
                 'ports': [args.web_port, args.ml_port, args.proxy_port, args.redis_port]}
    bootstrap_file = state / 'bootstrap.json'
    if bootstrap_file.exists():
        if json.loads(bootstrap_file.read_text()) != bootstrap:
            raise ValueError('existing bootstrap identity differs')
    else:
        if any(p.name != '.startup.lock' for p in state.iterdir()):
            raise ValueError('unidentified existing state; explicit import required')
        with bootstrap_file.open('x') as stream:
            json.dump(bootstrap, stream)
    for dependency in ['docker', 'openssl', 'systemctl', 'curl']:
        if not shutil.which(dependency):
            raise RuntimeError('missing target dependency: ' + dependency)
    run('docker', 'compose', 'version')
    run('docker', 'buildx', 'version')
    existing = output('docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={args.project}').split()
    for container in existing:
        labels = json.loads(output('docker', 'inspect', container))[0]['Config']['Labels']
        if str(state / 'platform-override.json') not in labels.get('com.docker.compose.project.config_files', '').split(','):
            raise RuntimeError('Compose project already belongs to another deployment')
    if args.images:
        manifest = json.loads(args.images.read_text())
        if manifest['revision'] != revision:
            raise ValueError('source and image revisions differ')
        images = manifest['images']
    else:
        if shutil.disk_usage(state).free < 80 * 1024**3:
            raise RuntimeError('80 GiB free required for builds/models and working data')
        builder = args.project + '-build'
        buildkit = 'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8'
        if subprocess.run(['docker', 'buildx', 'inspect', builder], capture_output=True).returncode:
            cpuset = ','.join(map(str, sorted(os.sched_getaffinity(0))))
            run('docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container',
                '--driver-opt', 'image=' + buildkit, '--driver-opt', 'memory=8g',
                '--driver-opt', 'memory-swap=8g', '--driver-opt', f'"cpuset-cpus={cpuset}"')
        run('docker', 'buildx', 'inspect', '--bootstrap', builder)
        run('docker', 'update', '--cpus', '6', '--memory', '8g', '--memory-swap', '8g', f'buildx_buildkit_{builder}0')
        images = {}
        for role, dockerfile in [('api', 'apps/api/Dockerfile'), ('web', 'apps/web/Dockerfile'), ('ml', 'ml/Dockerfile')]:
            tag = f'{args.project}-{role}:{revision}'
            command = ['docker', 'buildx', 'build', '--builder', builder, '--load', '--build-arg', f'REVISION={revision}',
                       '-f', str(SOURCE / dockerfile), '-t', tag]
            if role == 'ml':
                command += ['--target', 'gpu']
            run(*command, str(SOURCE), log=state / (role + '-build.log'), timeout=7200)
            images[role] = output('docker', 'image', 'inspect', tag, '--format', '{{.Id}}')
        manifest = {'schema': 'platform-candidate-images/1', 'revision': revision, 'images': images}
    if set(images) != {'api', 'web', 'ml'}:
        raise ValueError('exactly three application images required')
    for role, image in images.items():
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise ValueError('immutable application image required')
        if output('docker', 'image', 'inspect', image, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}') != revision:
            raise ValueError('actual image revision mismatch: ' + role)
    image_file = state / 'images.json'
    image_file.write_text(json.dumps(manifest, indent=2))
    bridge = json.loads(output('docker', 'network', 'inspect', 'bridge'))[0]['IPAM']['Config'][0]['Gateway']
    run('python3', str(SOURCE / 'deploy/platform/configure.py'), '--source', str(SOURCE), '--state', str(state),
        '--project', args.project, '--revision', revision, '--images', str(image_file), '--gateway', bridge,
        '--web-port', str(args.web_port), '--ml-port', str(args.ml_port), '--proxy-port', str(args.proxy_port),
        '--redis-port', str(args.redis_port), log=state / 'configuration.json')
    env = dict(os.environ, GPU_STAND_REMOTE='1', GPU_STAND_BASE=str(state), GPU_STAND_SOURCE=str(SOURCE))
    run('bash', str(SOURCE / 'scripts/gpu-stand.sh'), 'secrets', env=env, log=state / 'secrets-prepare.log')
    # Host state remains root-private. Mounted TLS directories must be
    # traversable by each container's service uid; key files stay owner-only.
    for directory in (state / 'tls').rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    key = state / 'secrets/blob_encryption_key'
    if not key.exists():
        for blob in (state / 'blobs').iterdir():
            if blob.is_file():
                with blob.open('rb') as stream:
                    if stream.read(4) == b'IBE1':
                        raise RuntimeError('encrypted originals exist without their key; restore the original key')
        with key.open('x') as stream:
            stream.write(output('openssl', 'rand', '-hex', '32') + '\n')
    os.chown(key, 1000, 1000)
    key.chmod(0o600)
    storage_overlay = prepare_s3(state, args.s3_env, args.s3_key_file, args.s3_prefix, args.s3_read_prefixes)
    cache = state / 'pipeline-cache'
    os.chown(cache, 10001, 10001)
    compose = ['docker', 'compose', '-p', args.project, '--project-directory', str(SOURCE / 'deploy/gpu-stand'),
               '-f', str(SOURCE / 'deploy/gpu-stand/compose.yml'), '-f', str(SOURCE / 'deploy/gpu-stand/compose.at-rest.yml'),
               '-f', str(state / 'platform-override.json'),
               '-f', str(SOURCE / 'deploy/gpu-stand/compose.antivirus.yml'),
               '--env-file', str(state / 'stand.env')]
    if storage_overlay:
        compose.extend(['-f', str(storage_overlay)])
    run(*compose, 'config', '--quiet')
    if args.prepare_only:
        print(json.dumps({'prepared': True, 'services_started': False, 'state': str(state), 'revision': revision}))
        return
    if not Path('/sys/fs/cgroup/cgroup.controllers').exists() or not shutil.which('nvidia-smi'):
        raise RuntimeError('cgroup v2 and NVIDIA driver/toolkit required')
    available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    if available < (16 if args.external_reader_container else 32) * 1024**3:
        raise RuntimeError('insufficient available RAM for the declared service ceilings')
    gpu = output('nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits').splitlines()
    if len(gpu) != 1 or int(gpu[0]) < 22000:
        raise RuntimeError('one GPU with at least 22 GiB VRAM required')
    node_base = state / 'node-agent'
    if args.external_reader_container:
        if not args.reader_controller or not (args.reader_controller / 'control/reader.sock').exists():
            raise RuntimeError('external Reader requires an already active pinned controller')
        external = json.loads((args.reader_controller / 'reader-policy.json').read_text())
        if external['container_name'] != args.external_reader_container:
            raise RuntimeError('external Reader controller identity differs')
        if not node_base.exists():
            node_base.symlink_to(args.reader_controller.resolve(), target_is_directory=True)
        if node_base.resolve() != args.reader_controller.resolve():
            raise RuntimeError('existing Reader controller differs')
    else:
        reader = args.project + '-reader'
        exists = subprocess.run(['docker', 'inspect', reader], capture_output=True).returncode == 0
        if not exists:
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', 8000)) == 0:
                    raise RuntimeError('Reader port already belongs to another deployment')
            if output('nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits'):
                raise RuntimeError('GPU has other owners; drain them before a clean model bootstrap')
            hf = (args.hf_dir or state / 'hf').resolve()
            hf.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not args.no_download:
                for model, model_revision in MODELS:
                    run('docker', 'run', '--rm', '--cpus', '2', '--memory', '2g', '-v', f'{hf}:/root/.cache/huggingface',
                        '--entrypoint', 'python3', VLLM_IMAGE, '-c',
                        'import sys;from huggingface_hub import snapshot_download; snapshot_download(sys.argv[1],revision=sys.argv[2])',
                        model, model_revision, log=state / ('download-' + model.split('/')[-1] + '.log'), timeout=7200)
            model, model_revision = MODELS[0]
            if not (hf / ('hub/models--' + model.replace('/', '--')) / 'snapshots' / model_revision).exists():
                raise RuntimeError('pinned Reader snapshot missing')
            run('docker', 'run', '-d', '--name', reader, '--label', f'inspector.platform={args.project}',
                '--restart', 'no', '--gpus', 'all', '--cpus', '8', '--memory', '12g', '--memory-swap', '12g',
                '--pids-limit', '512', '--ipc', 'private', '--shm-size', '2g', '-p', '127.0.0.1:8000:8000',
                '-v', f'{hf}:/root/.cache/huggingface:ro', '-e', 'HF_HUB_OFFLINE=1', '-e', 'TRANSFORMERS_OFFLINE=1',
                '-e', 'VLLM_NO_USAGE_STATS=1', VLLM_IMAGE, '--model', model, '--revision', model_revision,
                '--tokenizer-revision', model_revision, '--served-model-name', model,
                '--gpu-memory-utilization', '0.22', '--max-num-seqs', '8')
        else:
            info = json.loads(output('docker', 'inspect', reader))[0]
            if info['Config']['Labels'].get('inspector.platform') != args.project:
                raise RuntimeError('Reader container is not owned by this deployment')
            if not info['State']['Running']:
                run('docker', 'start', reader)
        deadline = time.monotonic() + 600
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('Reader readiness deadline exceeded')
            time.sleep(2)
        env = dict(os.environ, READER_LIFECYCLE_BASE=str(node_base), READER_LIFECYCLE_REVISION=revision,
                   READER_LIFECYCLE_CONTAINER=reader, READER_LIFECYCLE_UNIT=args.project + '-reader-lifecycle.service')
        run('bash', str(SOURCE / 'scripts/runner/install-reader-lifecycle.sh'), env=env, log=state / 'reader-controller.log')
    run('python3', str(SOURCE / 'scripts/runner/provision-node-policy.py'), '--base', str(node_base),
        '--var', str(state), '--node-id', args.project, '--policy-id', args.project + '-v1', log=state / 'node-policy-prepare.log')
    slice_file = Path('/etc/systemd/system') / (args.project + '.slice')
    if not slice_file.exists():
        with slice_file.open('x') as stream:
            stream.write('[Unit]\nDescription=Platform ML persistent OOM accounting\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\n')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', args.project + '.slice')
    initialize_journal(state, images['ml'], 'external-executions', 'execution_proxy',
                       'INSPECTOR_EXECUTION_PROXY_IDENTITY', (state / 'execution-proxy.identity').read_text().strip())
    initialize_journal(state, images['ml'], 'executions-v2', 'pipeline_execution',
                       'INSPECTOR_PIPELINE_JOURNAL_IDENTITY', (state / 'local-execution.identity').read_text().strip())
    node_journal = cache / 'node-admission-v1'
    marker = state / 'node-admission.provisioned'
    if not (node_journal / 'identity.json').exists():
        if node_journal.exists() or marker.exists():
            raise RuntimeError('node journal lost/incomplete; refusing reinitialization')
        marker.touch(exist_ok=False)
        run('docker', 'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--cpus', '1', '--memory', '512m',
            '--entrypoint', 'python', '--workdir', '/app/ml', '-v', f'{cache}:/pipeline-cache',
            '-v', f'{state}/node-policy.json:/run/node-policy.json:ro', images['ml'],
            '-m', 'inspector_ml.node_supervisor', 'provision', '/run/node-policy.json')
    run(*compose, 'up', '-d', '--wait', '--wait-timeout', '900')
    run('curl', '--fail', '--silent', '--show-error', '--max-time', '10', '--cacert', str(state / 'tls/ca.crt'),
        f'https://127.0.0.1:{args.web_port}/health', log=state / 'health.json')
    health = json.loads((state / 'health.json').read_text())
    if health.get('revision') != revision:
        raise RuntimeError('running API revision differs from release')
    print(json.dumps({'started': True, 'revision': revision, 'state': str(state),
                      'web': f'https://127.0.0.1:{args.web_port}', 'judge_phase': 'off',
                      'acceptance_quality_proven': False}))


if __name__ == '__main__':
    main()
