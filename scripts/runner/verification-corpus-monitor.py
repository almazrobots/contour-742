"""Aggregate-only runtime evidence; no document text or identities in stdout."""
import argparse
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
p.add_argument('--seconds', type=int, default=40)
a = p.parse_args()
os.umask(0o077)
root = Path(a.out)
samples = []
previous = None
for _ in range(a.seconds):
    cpu = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    mem = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
    gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], text=True, timeout=5).strip().split(',')
    sample = {'utc': datetime.now(UTC).isoformat(), 'gpu_percent': int(gpu[0]),
              'vram_mib': int(gpu[1]), 'ram_active_percent': 100 * (1 - mem['MemAvailable'] / mem['MemTotal'])}
    if previous:
        delta = [v - old for v, old in zip(cpu, previous)]
        sample['cpu_percent'] = 100 * (1 - (delta[3] + delta[4]) / max(1, sum(delta)))
    previous = cpu
    samples.append(sample)
    time.sleep(1)
db = sqlite3.connect('file:' + str(root / 'candidates.sqlite') + '?mode=ro', uri=True)
result = {'measured_at': datetime.now(UTC).isoformat(), 'samples': len(samples),
          'gpu_mean_percent': statistics.mean(s['gpu_percent'] for s in samples),
          'cpu_mean_percent': statistics.mean(s['cpu_percent'] for s in samples if 'cpu_percent' in s),
          'ram_active_mean_percent': statistics.mean(s['ram_active_percent'] for s in samples),
          'vram_max_mib': max(s['vram_mib'] for s in samples),
          'candidates': db.execute('SELECT count(*) FROM candidates').fetchone()[0],
          'parameters_with_candidates': db.execute('SELECT count(distinct parameter) FROM candidates').fetchone()[0],
          'sources': dict(db.execute('SELECT state,count(*) FROM sources GROUP BY state')),
          'bands': dict(db.execute('SELECT state,count(*) FROM bands GROUP BY state'))}
path = root / ('resources-' + datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ') + '.json')
path.write_text(json.dumps({'summary': result, 'samples': samples}, indent=2))
print(json.dumps({'evidence': str(path), **result}))
