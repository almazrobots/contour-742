"""Real bounded cgroup OOM, isolated from live models; verify durable quarantine.

Run as host root through remote-run, with the existing immutable GPU image.
No GPU devices/network are granted to the allocation subprocess.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from uuid import uuid4

from inspector_ml.node_admission import NodeAdmission
from inspector_ml.node_supervisor import Supervisor
from inspector_ml.resource_admission import JobRef, Resources, StopProof, Telemetry


def command(*args):
    return subprocess.check_output(args, text=True, timeout=45).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    args = parser.parse_args()
    assert os.geteuid() == 0
    import re
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', args.image)
    name = 'resource-oom-probe-' + uuid4().hex[:12]
    unit = 'w1oomprobe' + uuid4().hex[:12] + '.slice'
    parent = Path('/sys/fs/cgroup') / unit
    command('systemctl', 'start', unit)
    observer = object.__new__(Supervisor)
    observer.cgroup = lambda: parent
    os.environ.pop('INSPECTOR_NODE_OOM_CGROUP', None)
    try:
        before = observer.oom_events()
        result = subprocess.run(['docker', 'run', '--name', name, '--network', 'none',
            '--cgroup-parent', unit, '--memory', '64m', '--memory-swap', '64m',
            '--cpus', '0.5', '--pids-limit', '32', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--entrypoint', 'python', args.image,
            '-c', 'x=[bytearray(8*1024*1024) for _ in range(64)]'],
            capture_output=True, timeout=45)
        state = json.loads(command('docker', 'inspect', '--format', '{{json .State}}', name))
        assert result.returncode == 137 and state['OOMKilled'] and not state['Running']
        command('docker', 'rm', name)
        after = observer.oom_events()
        assert before['identity'] == after['identity']
        assert after['counters'][1] > before['counters'][1]
        assert observer.had_oom({'oom_events': before})
        with TemporaryDirectory(prefix='oom-journal-') as directory:
            kwargs = dict(journal_identity=str(uuid4()), node_id='isolated-oom',
                policy_id='isolated-oom', capacity=Resources(ram=64*1024**2), resident=Resources())
            owner = NodeAdmission(Path(directory)/'journal', initialize=True, **kwargs)
            try:
                job = JobRef('allocation', 'oom-probe', Resources(ram=64*1024**2))
                owner.enqueue(job)
                reservation = owner.reserve_next(Telemetry(1, Resources()), now=1).reservation
                assert reservation
                # The container is removed and had no network/external execution.
                assert owner.release(job.job_id, StopProof(reservation.token, True, True), oom=True)
                assert owner.enqueue(JobRef('retry', 'oom-probe', job.resources)).reason == 'oom_configuration'
            finally:
                owner.close()
            owner = NodeAdmission(Path(directory)/'journal', **kwargs)
            try:
                assert owner.configuration_blocked('oom-probe')
                assert not owner.snapshot()
            finally:
                owner.close()
        print(json.dumps({'passed': True, 'scope': 'isolated real cgroup OOM, no GPU/model',
            'exit_code': result.returncode, 'before': before, 'after': after,
            'quarantine_survives_restart': True}))
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)
        command('systemctl', 'stop', unit)


if __name__ == '__main__':
    main()
