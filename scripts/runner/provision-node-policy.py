"""Prepare the explicit, conservative first supervisor pilot policy on the host.

Does not initialize a ledger or launch models. Existing policy is never silently
replaced: journal policy changes require reconciliation with its owner.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4

BASE = Path('/opt/resource-ocr/node-agent')
VAR = Path('/opt/w1-gate/stand/w1-feat-resource-ocr-incremental/var')
GIB = 1024 ** 3


def resources(cpu=0, ram=0, vram=0, pixels=0, spool=0, tokens=0):
    return dict(cpu=cpu, ram=ram, vram=vram, pixels=pixels, spool=spool, tokens=tokens)


def main():
    if os.geteuid() != 0 or not Path('/proc/sys/kernel/random/boot_id').exists():
        raise SystemExit('GPU Linux host root required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', type=Path, default=BASE)
    parser.add_argument('--var', type=Path, default=VAR)
    parser.add_argument('--node-id', default='gpu-54831')
    parser.add_argument('--policy-id', default='resource-ocr-pilot-v1')
    args = parser.parse_args()
    path = args.var / 'node-policy.json'
    if path.exists():
        print('Existing node policy retained:', path)
        return
    reader = json.loads((args.base / 'reader-policy.json').read_text())
    probe = json.loads(subprocess.check_output([
        'curl', '--fail', '--silent', '--show-error', '--max-time', '15',
        '--unix-socket', str(args.base / 'control/reader.sock'),
        '-H', 'Content-Type: application/json', '-d',
        json.dumps({'policy_identity': reader['policy_identity']}), 'http://localhost/probe']))
    if not probe['running'] or not probe['ready'] or probe['container_id'] != reader['container_id']:
        raise SystemExit('Pinned resident Reader is not ready')
    # ML RAM is enforced by its 6 GiB cgroup. Reader has a separate 12 GiB cgroup;
    # its RAM reduces host MemAvailable, and both models share VRAM accounting.
    # These are conservative pilot ceilings, not a claim of measured peak usage.
    policy = dict(
        schema='node-supervisor.v1', node_id=args.node_id, policy_id=args.policy_id,
        journal_identity=str(uuid4()), journal_dir='/pipeline-cache/node-admission-v1',
        worker_socket='/pipeline-cache/node-worker/private.sock', gpu_uuid=reader['gpu_uuid'],
        capacity=resources(cpu=4000, ram=6*GIB, vram=22*GIB, pixels=150_000_000, spool=GIB, tokens=8192),
        resident=resources(cpu=500, ram=GIB, vram=7*GIB),
        job_budget=resources(cpu=3500, ram=4*GIB, vram=8*GIB, pixels=150_000_000, spool=64*1024**2, tokens=8192),
        proc='/host-proc', cgroup='/sys/fs/cgroup', cgroup_root='/sys/fs/cgroup',
        spool='/pipeline-cache', reader_processes=probe['gpu_processes'],
        reader_lifecycle=dict(socket='/reader-control/reader.sock', policy_identity=reader['policy_identity']),
        queue_limit=64, telemetry_ttl=5, heartbeat_ttl=30)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
    with os.fdopen(fd, 'w') as stream:
        json.dump(policy, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.chown(path, 0, 10001)
    # Bootstrap runs under umask077; explicitly grant the service group read
    # access after writing, while keeping the policy immutable to that group.
    os.chmod(path, 0o640)
    print('Prepared policy; ledger initialization still required:', path)


if __name__ == '__main__':
    main()
