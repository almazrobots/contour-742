"""Owner-only finite Judge profiling window; no inference payloads or GPU overlap."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal
import time
import urllib.request
from datetime import datetime

PROJECT = 'w1-feat-resource-ocr-incremental'
ROOT = Path('/opt/w1-gate/stand') / PROJECT / 'var/pipeline-cache'
HELPER = Path('/opt/resource-ocr/node-agent')


def run(*args, timeout=45):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def reader(action):
    policy = json.loads((HELPER/'reader-policy.json').read_text())
    return json.loads(run('curl', '--fail', '--silent', '--max-time', '40', '--unix-socket',
        str(HELPER/'control/reader.sock'), '-H', 'Content-Type: application/json', '-d',
        json.dumps({'policy_identity': policy['policy_identity']}), 'http://localhost/'+action))


def drained():
    state = json.loads((ROOT/'node-admission-v1/state.json').read_text())['state']
    assert not state['queue'] and not state['reservations'], 'ML admission not drained'
    for path in (ROOT/'external-executions').glob('*.json'):
        record = json.loads(path.read_text())
        assert all(r['status'] != 'RUNNING' for r in record.get('requests', {}).values()), 'External execution active'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--profile', type=Path, required=True)
    p.add_argument('--profile-sha', required=True)
    p.add_argument('--admission', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--deadline-utc', required=True)
    a = p.parse_args()
    cutoff = datetime.fromisoformat(a.deadline_utc)
    assert cutoff.tzinfo is not None and cutoff.timestamp() > time.time()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt('termination requested')))
    assert os.geteuid() == 0 and hashlib.sha256(a.profile.read_bytes()).hexdigest() == a.profile_sha
    a.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = {'admission': a.admission, 'profile_sha': a.profile_sha, 'started': time.time(), 'samples': []}
    def save():
        temp = a.output/'status.tmp'
        temp.write_text(json.dumps(report)); temp.chmod(0o600); temp.replace(a.output/'status.json')
    with open('/opt/resource-ocr/gpu.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        assert subprocess.run(['docker', 'inspect', 'm022-judge-pilot'], capture_output=True).returncode != 0
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        assert int(mem['MemAvailable'].split()[0]) >= 32*1024**2
        drained()
        api_stopped = ml_stopped = reader_stopped = judge_started = False
        try:
            run('docker', 'stop', '--timeout', '30', PROJECT+'-api-1'); api_stopped = True
            drained()
            run('docker', 'stop', '--timeout', '30', PROJECT+'-ml-1'); ml_stopped = True
            drained()
            assert reader('stop')['stopped']; reader_stopped = True
            assert not run('nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits')
            env = dict(os.environ, M022_ADMISSION_ID=a.admission)
            judge_started = True  # Even a CLI timeout may have created the container.
            report['container'] = subprocess.check_output(['bash', str(a.profile)], env=env, text=True, timeout=60).strip()
            ready = False
            deadline = time.monotonic()+600
            while time.monotonic() < deadline and time.time() < cutoff.timestamp():
                state = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', 'm022-judge-pilot'))
                assert state['Running'] and not state['OOMKilled'], 'Judge stopped or OOM'
                pid = state['Pid']
                cg = next(x[3:] for x in Path(f'/proc/{pid}/cgroup').read_text().splitlines() if x.startswith('0::'))
                directory = Path('/sys/fs/cgroup')/cg.lstrip('/')
                gpu = run('nvidia-smi', '--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits')
                used, utilization = map(int, gpu.split(','))
                report['samples'].append({'utc_epoch': time.time(), 'gpu_mib': used, 'gpu_utilization': utilization,
                    'ram': int((directory/'memory.current').read_text()), 'ram_peak': int((directory/'memory.peak').read_text())})
                assert used < 22*1024, 'Judge exceeded reserved VRAM'
                if not ready:
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=2) as response:
                            ready = response.status == 200
                    except Exception:
                        pass
                    if ready:
                        report['ready'] = time.time(); deadline = time.monotonic()+600
                        print(json.dumps({'ready': True, 'admission': a.admission}), flush=True)
                save()
                if ready and (a.output/'done').exists():
                    report['completed'] = time.time(); break
                time.sleep(1)
            else:
                raise TimeoutError('Judge window expired')
        except BaseException as exc:
            report['error'] = type(exc).__name__+': '+str(exc)
            raise
        finally:
            safe = True
            if judge_started:
                label = run('docker', 'inspect', '--format', '{{index .Config.Labels "m022.admission"}}', 'm022-judge-pilot')
                assert label == a.admission, 'Refusing to stop a foreign Judge'
                run('docker', 'stop', '--timeout', '30', 'm022-judge-pilot')
                safe = not run('nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits')
            if safe:
                if reader_stopped: reader('start')
                if ml_stopped: run('docker', 'start', PROJECT+'-ml-1')
                if api_stopped: run('docker', 'start', PROJECT+'-api-1')
            report['ocr_restart_requested'] = safe
            report['finished'] = time.time(); save()


if __name__ == '__main__':
    main()
