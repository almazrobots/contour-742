// Opt-in helper for pipeline-durable-smoke. Only the selected stand worker is signalled.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function identity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, start_ticks: Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]),
    boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}

export async function freezeWorker({ stand, project, execution, snapshot, databaseSnapshot, processId, save }) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0, 'Host root required to signal the pinned worker');
  const policy = read(`${stand}/var/node-policy.json`);
  assert.equal(policy.journal_dir, '/pipeline-cache/node-admission-v1');
  const ledger = () => {
    const envelope = read(`${stand}/var/pipeline-cache/node-admission-v1/state.json`);
    assert.equal(envelope.journal_identity, policy.journal_identity);
    return envelope.state;
  };
  const ref = `${execution.job_id}:${execution.epoch}`;
  const before = ledger();
  const reservation = before.reservations.find((r) => r.job.job_id === ref);
  if (!reservation) return null; // allocation must be durable before the fault
  const raw = execFileSync('docker', ['exec', `${project}-pipeline-redis-1`, 'redis-cli',
    '-s', '/pipeline-cache/redis.sock', '--raw', 'GET', `inspector:ml:node-supervisor-v1-${policy.journal_identity}-${ref}`],
  { encoding: 'utf8', timeout: 5000 });
  const record = JSON.parse(raw);
  if (!record.worker_identity) return null;
  assert.equal(record.scope_job, execution.job_id);
  assert.equal(record.scope_epoch, execution.epoch);
  const worker = record.worker_identity;
  assert(worker.pid > 1 && Number.isSafeInteger(worker.pid));
  assert.deepEqual(identity(worker.pid), worker);
  const cgroup = readFileSync(`/proc/${worker.pid}/cgroup`, 'utf8');
  const container = execFileSync('docker', ['inspect', '--format', '{{.Id}}', `${project}-ml-1`],
    { encoding: 'utf8', timeout: 5000 }).trim();
  assert(cgroup.includes(container), 'Worker must belong to this stand ML container');
  const evidence = { kind: 'worker-sigstop', at: new Date().toISOString(), execution,
    before: snapshot, worker, reservation, observed_unknown: false };
  save(evidence);
  try {
    process.kill(worker.pid, 'SIGSTOP');
    const deadline = Date.now() + (policy.heartbeat_ttl + 5) * 1000;
    while (Date.now() < deadline) {
      await delay(500);
      assert.deepEqual(identity(worker.pid), worker);
      const current = ledger();
      const held = current.reservations.find((r) => r.job.job_id === ref);
      assert(held, 'Frozen worker reservation was released');
      assert.equal(held.token, reservation.token);
      assert.deepEqual(held.job.resources, reservation.job.resources);
      assert(current.reservations.every((r) => before.reservations.some((old) => old.token === r.token)),
        'Another reservation admitted while the worker was frozen');
      const jobs = databaseSnapshot(processId).jobs;
      assert.equal(jobs.find((j) => j.id === execution.job_id)?.epoch, execution.epoch,
        'Frozen attempt was duplicated');
      evidence.observed_unknown ||= held.state === 'UNKNOWN';
    }
    assert(evidence.observed_unknown, 'No persisted UNKNOWN after heartbeat expiry');
  } finally {
    // Never signal a reused PID. Keep durable evidence even when an assertion fails.
    assert.deepEqual(identity(worker.pid), worker);
    process.kill(worker.pid, 'SIGCONT');
    evidence.restarted = new Date().toISOString();
    save(evidence);
  }
  return evidence;
}
