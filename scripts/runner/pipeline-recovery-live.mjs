#!/usr/bin/env node
// Run ONLY through remote-run.sh: isolated scratch schema/queue on our existing stand.
// Loopback TCP relays preserve TLS end-to-end and the certificate's localhost SAN.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

if (process.platform !== 'linux' || !existsSync('/opt/w1-gate')) {
  throw Error('This harness runs only on the GPU runner via scripts/remote-run.sh');
}
const project = 'w1-feat-resource-ocr-incremental';
const base = `/opt/w1-gate/stand/${project}/var`;
const ca = `${base}/tls/ca.crt`;
const relays = [], sockets = new Set();
const pgName = `t238-pg-${randomBytes(6).toString('hex')}`;
const secretDir = mkdtempSync(`${tmpdir()}/t238-pg-`);
let pgStarted = false;
function address(service) {
  const result = execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', `${project}-${service}-1`], { encoding: 'utf8' });
  const addresses = Object.values(JSON.parse(result)).map((n) => n.IPAddress).filter(Boolean);
  if (addresses.length !== 1) throw Error(`Expected exactly one private address for our ${service}`);
  return addresses[0];
}
async function relay(host, port) {
  const server = createServer((downstream) => {
    const upstream = connect({ host, port });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
    }
    downstream.pipe(upstream).pipe(downstream);
  });
  relays.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
const secret = (name) => readFileSync(`${base}/secrets/${name}`, 'utf8').trimEnd();
try {
  // Production pg_hba correctly disallows remote superuser/schema creation.
  // Use the SAME already-local immutable image in a disposable synthetic-only DB;
  // never change production roles, HBA, services or their storage.
  const pgImage = execFileSync('docker', ['inspect', '--format', '{{.Image}}', `${project}-postgres-1`], { encoding: 'utf8' }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(pgImage)) throw Error('Expected immutable local PostgreSQL image');
  const pgPassword = randomBytes(24).toString('hex');
  // Directory traversable by container uid; file contains a disposable test secret only.
  chmodSync(secretDir, 0o755);
  writeFileSync(`${secretDir}/password`, pgPassword, { mode: 0o444 });
  const cpus = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
  if (!cpus) throw Error('Cannot establish runner CPU affinity');
  execFileSync('docker', ['run', '--detach', '--name', pgName, '--label', 'inspector.test=T-238',
    '--pull=never', '--cpus=2', '--cpuset-cpus', cpus, '--memory=1g', '--memory-swap=1g',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=70:70', '--read-only',
    '--tmpfs', '/var/lib/postgresql:rw,uid=70,gid=70,size=768m',
    '--tmpfs', '/var/run/postgresql:rw,uid=70,gid=70,size=8m', '--tmpfs', '/tmp:rw,size=32m',
    '--mount', `type=bind,src=${secretDir}/password,dst=/run/test-pg-password,readonly`,
    '--env', 'POSTGRES_PASSWORD_FILE=/run/test-pg-password', '--env', 'POSTGRES_DB=inspector',
    '--publish', '127.0.0.1::5432', pgImage], { stdio: 'pipe' });
  pgStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      execFileSync('docker', ['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'inspector'], { stdio: 'pipe' });
      ready = true; break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!ready) throw Error('Disposable PostgreSQL did not become ready in 20 seconds');
  const portInfo = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', pgName], { encoding: 'utf8' }));
  const pgPort = portInfo['5432/tcp'][0].HostPort;
  const amqpPort = await relay(address('rabbitmq'), 5671);
  const pg = new URL(`postgresql://postgres@127.0.0.1:${pgPort}/inspector`);
  pg.password = pgPassword;
  const rabbit = new URL(`amqps://inspector@127.0.0.1:${amqpPort}`);
  rabbit.password = secret('rabbitmq_password');
  const files = ['tests/stage-jobs.test.ts', 'tests/stage-recovery-live.test.ts', 'tests/pipeline-source-pins.test.ts', 'tests/stage-graph.test.ts', 'tests/stage-coordinator.test.ts', 'tests/recover-parsing.test.ts', 'tests/stage-notification-recovery.test.ts'];
  console.log('T-238: disposable PostgreSQL (loopback, synthetic only), stand RabbitMQ (verified TLS); random schema + queue; no service restarts');
  const child = spawn('pnpm', ['exec', 'vitest', 'run', ...files, '--maxWorkers=1'], {
    cwd: resolve('apps/api'), stdio: 'inherit', env: { ...process.env,
      INSPECTOR_STAGE_LIVE: '1', INSPECTOR_TEST_DATABASE_URL: pg.toString(),
      INSPECTOR_STAGE_TEST_AMQP_URL: rabbit.toString(), NODE_EXTRA_CA_CERTS: ca,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all(relays.map((server) => new Promise((resolve) => server.close(resolve))));
  if (pgStarted) execFileSync('docker', ['rm', '--force', pgName], { stdio: 'pipe' });
  rmSync(`${secretDir}/password`, { force: true });
  rmSync(secretDir, { recursive: true });
}
