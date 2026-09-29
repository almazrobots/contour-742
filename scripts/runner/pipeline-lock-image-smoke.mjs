// Execute in the built API image as its default non-root user, with only /tmp writable.
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const dir = await mkdtemp(join(tmpdir(), 'pipeline-lock-smoke-'));
const path = join(dir, 'lock');
const fh = await open(path, 'a+', 0o600);
const run = (args, fd) => new Promise((resolve, reject) => {
  const child = spawn('flock', args, { stdio: ['ignore', 'ignore', 'inherit', ...(fd === undefined ? [] : [fd])] });
  child.once('error', reject);
  child.once('exit', (code) => resolve(code));
});
try {
  assert.equal(await run(['-x', '-w', '2', '3'], fh.fd), 0);
  assert.equal(await run(['-n', path, 'true']), 1, 'parent must retain the inherited-descriptor lock');
  await fh.close();
  assert.equal(await run(['-n', path, 'true']), 0, 'closing the parent descriptor must release the lock');
  console.log('API image: non-root inherited-fd lock, contention and release passed');
} finally {
  await fh.close();
  await rm(dir, { recursive: true });
}
