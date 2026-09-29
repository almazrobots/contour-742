"""Sample GPU and owned ML cgroup during a bounded runner command.

Observed maxima are sampled lower bounds, not guaranteed instantaneous peaks.
The kernel memory.peak value has cgroup lifetime scope, recorded before/after.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time


def sample():
    root = Path('/sys/fs/cgroup/w1resourceocr.slice')
    gpu = subprocess.check_output(['nvidia-smi',
        '--query-gpu=uuid,memory.total,memory.used,utilization.gpu',
        '--format=csv,noheader,nounits'], text=True, timeout=3).strip().splitlines()
    assert len(gpu) == 1
    uuid, total, used, utilization = [v.strip() for v in gpu[0].split(',')]
    return {'utc': datetime.now(timezone.utc).isoformat(), 'monotonic': time.monotonic(),
        'gpu_uuid': uuid, 'gpu_total_mib': int(total), 'gpu_used_mib': int(used),
        'gpu_utilization_percent': int(utilization),
        'ml_parent_ram_bytes': int((root/'memory.current').read_text()),
        'ml_parent_lifetime_peak_bytes': int((root/'memory.peak').read_text()),
        'ml_parent_identity': [root.stat().st_dev, root.stat().st_ino]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command and os.geteuid() == 0
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(args.output, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    samples, errors = [], []
    child = None
    try:
        samples.append(sample())
        child = subprocess.Popen(command)
        deadline = time.monotonic() + 900
        while child.poll() is None:
            if time.monotonic() > deadline:
                child.terminate()
                raise TimeoutError('resource probe command exceeded 900 seconds')
            try:
                samples.append(sample())
            except Exception as exc:
                errors.append({'utc': datetime.now(timezone.utc).isoformat(), 'type': type(exc).__name__})
            time.sleep(0.5)
        samples.append(sample())
        result = child.returncode
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        report = {'scope': 'GPU machine total; ML dedicated parent; sampled maxima are lower bounds',
                  'command_exit': child.returncode if child else None, 'samples': samples, 'errors': errors}
        if samples:
            report['observed_maxima'] = {key: max(s[key] for s in samples) for key in
                ('gpu_used_mib', 'gpu_utilization_percent', 'ml_parent_ram_bytes')}
        with os.fdopen(fd, 'w') as stream:
            json.dump(report, stream)
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps({'resource_evidence': str(args.output), 'samples': len(samples),
                      'errors': len(errors), 'observed_maxima': report.get('observed_maxima')}))
    return result or (1 if errors else 0)


if __name__ == '__main__':
    raise SystemExit(main())
