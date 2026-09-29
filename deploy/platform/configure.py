"""Portable durable GPU profile over the existing nadzorium-gpu services.

No services are started here. State lives outside the source archive and model
calls require the separately provisioned, identity-pinned node supervisor.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import uuid


def exclusive_identity(path, journal):
    if path.exists():
        value = path.read_text().strip()
        if str(uuid.UUID(value)) != value:
            raise ValueError("invalid stored journal identity")
        return value
    if journal.exists():
        raise ValueError("journal exists without its identity; refusing reinitialization")
    value = str(uuid.uuid4())
    with path.open('x') as stream:
        stream.write(value + '\n')
    path.chmod(0o600)
    return value


def prepare(source, state, project, revision, images, gateway, web_port, ml_port, proxy_port, redis_port):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', project):
        raise ValueError('invalid deployment namespace')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('full source revision required')
    state, source = Path(state).resolve(), Path(source).resolve()
    if state == Path('/') or state == source or source in state.parents or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(state)):
        raise ValueError('state must be a separate absolute directory outside source')
    ipaddress.IPv4Address(gateway)
    ports = [web_port, ml_port, proxy_port, redis_port]
    if len(set(ports)) != 4 or any(type(p) is not int or not 40000 < p < 65536 for p in ports):
        raise ValueError('four distinct ports above 40000 required')
    if set(images) != {'api', 'web', 'ml'} or any(not re.fullmatch(r'sha256:[0-9a-f]{64}', v) for v in images.values()):
        raise ValueError('three immutable application image IDs required')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = state / 'deployment.json'
    identity = {'schema': 'platform-deployment/1', 'project': project,
                'gateway': gateway, 'ports': ports}
    if marker.exists():
        if json.loads(marker.read_text()) != identity:
            raise ValueError('existing deployment identity differs; explicit migration required')
    else:
        if (state / 'stand.env').exists() or (state / 'pipeline-cache').exists():
            raise ValueError('unidentified existing state; refusing to adopt it')
        with marker.open('x') as stream:
            json.dump(identity, stream, indent=2)
        marker.chmod(0o600)
    cache = state / 'pipeline-cache'
    cache.mkdir(mode=0o700, exist_ok=True)
    proxy_identity = exclusive_identity(state / 'execution-proxy.identity', cache / 'external-executions')
    local_identity = exclusive_identity(state / 'local-execution.identity', cache / 'executions-v2')
    image_env = {}
    for line in (source / 'deploy/stand/images.env').read_text().splitlines():
        if re.match(r'^[A-Z_]+_IMAGE=', line):
            key, value = line.split('=', 1)
            image_env[key] = value
    image_env['CADDY_IMAGE'] = 'caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b'
    image_env['REDIS_IMAGE'] = 'redis:8.8-alpine@sha256:0b2b77d3ea5078274795e3177cdbdada8b96316684a38911d528534ed679b5ec'
    env = {**image_env, 'API_IMAGE': images['api'], 'WEB_IMAGE': images['web'], 'ML_GPU_IMAGE': images['ml'],
           'STAND_VAR': str(state), 'STAND_REVISION': revision, 'STAND_GATEWAY': gateway,
           'STAND_WEB_PORT': str(web_port), 'STAND_ML_PORT': str(ml_port), 'STAND_REDIS_PORT': str(redis_port),
           'GPU_BLOB_WORK_MB': '1536', 'GPU_BLOB_WORK_TMPFS': '2g'}
    (state / 'stand.env').write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
    slice_name = project + '.slice'
    proxy_url = f'http://127.0.0.1:{proxy_port}'
    redis_url = f'rediss://127.0.0.1:{redis_port}/0?ssl_ca_certs=/run/tls/ca.crt'
    overlay = {'services': {
        'caddy': {'profiles': ['public-edge']},
        'postgres': {'cpus': 2, 'mem_limit': '2g', 'memswap_limit': '2g'},
        'rabbitmq': {'cpus': 1, 'mem_limit': '1g', 'memswap_limit': '1g'},
        'redis': {'cpus': 1, 'mem_limit': '1536m', 'memswap_limit': '1536m',
                  'command': ['redis-server', '--maxmemory', '1gb', '--maxmemory-policy', 'allkeys-lru',
                      '--appendonly', 'yes', '--dir', '/data', '--port', '0', '--tls-port', '6379',
                      '--tls-cert-file', '/run/tls/server.crt', '--tls-key-file', '/run/tls/server.key',
                      '--tls-ca-cert-file', '/run/tls/ca.crt', '--tls-auth-clients', 'no', '--tls-protocols', 'TLSv1.3']},
        'api': {'cpus': 2, 'mem_limit': '6g', 'memswap_limit': '6g', 'environment': {
            'INSPECTOR_PIPELINE_ROUTE': 'staged-v1', 'INSPECTOR_PIPELINE_EXECUTION': 'durable',
            'INSPECTOR_PIPELINE_POLICY': 'regional-v1', 'INSPECTOR_PARSE_CONCURRENCY': '1',
            'INSPECTOR_PARSE_PART_CONCURRENCY': '1', 'INSPECTOR_SHEET_DIFF_AUTO': '0'}},
        'ml': {'cpus': 4, 'mem_limit': '6g', 'memswap_limit': '6g', 'pids_limit': 512,
            'cgroup_parent': slice_name, 'environment': {
                'INSPECTOR_ML_WORKERS': '1', 'INSPECTOR_NODE_POLICY': '/run/node-policy.json',
                'INSPECTOR_NODE_OOM_CGROUP': '/node-oom-parent', 'INSPECTOR_OCR_WORKERS': '1',
                'INSPECTOR_RENDER_PROCS': '0', 'INSPECTOR_PPOCR_GPU_MB': '1536',
                'INSPECTOR_PPOCR_DET_FLOOR': '960', 'INSPECTOR_PPOCR_REC_BATCH': '8',
                'INSPECTOR_VL_INFLIGHT': '4', 'INSPECTOR_VLM_URL': 'http://127.0.0.1:8000/v1',
                'INSPECTOR_JUDGE_PHASE': 'off', 'INSPECTOR_EXECUTION_PROXY_URL': proxy_url,
                'INSPECTOR_EXECUTION_PROXY_NAMESPACE': project, 'INSPECTOR_EXECUTION_PROXY_IDENTITY': proxy_identity,
                'INSPECTOR_PIPELINE_EXECUTIONS_DIR': '/pipeline-cache/executions-v2',
                'INSPECTOR_PIPELINE_JOURNAL_IDENTITY': local_identity,
                'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'},
            'volumes': [f'{cache}:/pipeline-cache', f'{state}/node-policy.json:/run/node-policy.json:ro',
                        '/proc:/host-proc:ro', f'/sys/fs/cgroup/{slice_name}:/node-oom-parent:ro',
                        f'{state}/node-agent/control:/reader-control:ro'],
            'depends_on': {'execution-proxy': {'condition': 'service_healthy'}}},
        'execution-proxy': {'image': images['ml'], 'entrypoint': ['python', '-m', 'uvicorn'],
            'command': ['inspector_ml.execution_proxy:build_from_env', '--factory', '--host', '127.0.0.1',
                        '--port', str(proxy_port), '--no-access-log'], 'working_dir': '/app/ml',
            'network_mode': 'host', 'user': '10001:10001', 'read_only': True, 'restart': 'unless-stopped',
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'cpus': 1,
            'mem_limit': '512m', 'memswap_limit': '512m', 'pids_limit': 64,
            'environment': {'INSPECTOR_EXECUTION_PROXY_ROOT': '/pipeline-cache/external-executions',
                'INSPECTOR_EXECUTION_PROXY_IDENTITY': proxy_identity, 'INSPECTOR_EXECUTION_PROXY_NAMESPACE': project,
                'INSPECTOR_EXECUTION_PROXY_UPSTREAM': 'http://127.0.0.1:8000/v1/chat/completions',
                'INSPECTOR_REDIS_URL': redis_url},
            'volumes': [f'{cache}:/pipeline-cache', f'{state}/tls/ml:/run/tls:ro'],
            'healthcheck': {'test': ['CMD', 'python', '-c',
                f"import urllib.request;urllib.request.urlopen('{proxy_url}/health',timeout=3)"],
                'interval': '5s', 'timeout': '4s', 'retries': 12},
            'depends_on': {'redis': {'condition': 'service_healthy'}}}}}
    (state / 'platform-override.json').write_text(json.dumps(overlay, indent=2))
    return {'state': str(state), 'project': project, 'revision': revision, 'images': images,
            'web': f'https://127.0.0.1:{web_port}', 'processing_started': False,
            'judge_phase': 'off', 'source_mounts': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--gateway', required=True)
    for name, default in [('web', 49443), ('ml', 49511), ('proxy', 49512), ('redis', 49379)]:
        parser.add_argument('--' + name + '-port', type=int, default=default)
    args = parser.parse_args()
    manifest = json.loads(args.images.read_text())
    if manifest['revision'] != args.revision:
        raise ValueError('image manifest revision differs from source')
    print(json.dumps(prepare(args.source, args.state, args.project, args.revision, manifest['images'],
          args.gateway, args.web_port, args.ml_port, args.proxy_port, args.redis_port)))
