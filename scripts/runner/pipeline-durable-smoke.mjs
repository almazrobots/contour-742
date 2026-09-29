// One synthetic PDF through real HTTP/queue/ML/database; optional state-triggered API crash.
import assert from 'node:assert/strict';
import { freezeWorker } from './pipeline-resource-fault.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { request } from 'playwright';

if (process.platform !== 'linux') throw Error('Run on the GPU server through remote-run.sh');
const project = 'w1-feat-resource-ocr-incremental';
const freeze = process.env.PIPELINE_SMOKE_FREEZE_WORKER === '1';
const restartApi = process.env.PIPELINE_SMOKE_RESTART_API === '1';
const restartMl = process.env.PIPELINE_SMOKE_RESTART_ML === '1';
const restartDependency = process.env.PIPELINE_SMOKE_RESTART_DEPENDENCY ?? '';
const cacheLoss = process.env.PIPELINE_SMOKE_CACHE_LOSS === '1';
assert(['', 'rabbitmq', 'postgres'].includes(restartDependency), 'Unsupported fault target');
assert(Number(freeze) + Number(restartApi) + Number(restartMl) + Number(Boolean(restartDependency)) + Number(cacheLoss) <= 1, 'One fault per run');
const faultMode = freeze || restartApi || restartMl || Boolean(restartDependency) || cacheLoss;
assert(!(faultMode && process.env.PIPELINE_SMOKE_PROCESS), 'Fault scenario requires a fresh upload');
const stand = `/opt/w1-gate/stand/${project}`;
const output = resolve(process.env.PIPELINE_SMOKE_OUTPUT ?? `/opt/resource-ocr/t238-first-${Date.now()}`);
const fixture = resolve(process.env.PIPELINE_SMOKE_FIXTURE ?? 'data/synth/OBJ-SEV-2');
const selectedFile = process.env.PIPELINE_SMOKE_FILE ?? 'SEV-PD-PZ-1.pdf';
const manifest = JSON.parse(readFileSync(`${fixture}/manifest.json`, 'utf8'));
manifest.files = manifest.files.filter((file) => file.file_name === selectedFile);
assert.equal(manifest.files.length, 1);
manifest.files[0].predecessor_id = null;
manifest.object.object_id = `T238-${randomUUID()}`;
manifest.object.name = 'СИНТЕТИКА · T238 первый durable PDF';
mkdirSync(output, { recursive: true });
const client = await request.newContext({ baseURL: 'https://127.0.0.1:45812', ignoreHTTPSErrors: true });
const evidence = { started: new Date().toISOString(), scenario: 'one-real-durable-pdf' };
async function json(path, options = {}) {
  const response = await client.fetch(path, options);
  assert(response.ok(), `${path}: HTTP ${response.status()} ${await response.text()}`);
  return response.json();
}
function databaseSnapshot(processId) {
  assert.match(processId, /^P-[0-9]{8}-[0-9a-f]+$/);
  const query = `select json_build_object(
    'runs',(select json_agg(json_build_object('id',r.id,'mode',r.execution_mode,'status',r.status)) from inspector.pipeline_runs r join inspector.files f on f.id=r.file_id where f.inspection_id='${processId}'),
    'jobs',(select json_agg(json_build_object('id',j.id,'stage',j.stage,'status',j.status,'epoch',j.attempt_epoch,'error',j.error)) from inspector.stage_jobs j join inspector.pipeline_runs r on r.id=j.run_id join inspector.files f on f.id=r.file_id where f.inspection_id='${processId}'),
    'committed',(select coalesce(json_agg(json_build_object('job_id',a.job_id,'epoch',a.attempt_epoch,'digest',a.artifact_digest,'blob_sha256',a.blob_sha256,'stage',j.stage)), '[]'::json) from inspector.stage_artifacts a join inspector.stage_jobs j on j.id=a.job_id join inspector.pipeline_runs r on r.id=a.run_id join inspector.files f on f.id=r.file_id where f.inspection_id='${processId}'),
    'artifacts',(select count(*) from inspector.stage_artifacts a join inspector.pipeline_runs r on r.id=a.run_id join inspector.files f on f.id=r.file_id where f.inspection_id='${processId}'),
    'active_pins',(select count(*) from inspector.pipeline_source_pins p join inspector.pipeline_runs r on r.id=p.run_id join inspector.files f on f.id=r.file_id where f.inspection_id='${processId}' and p.released_at is null))`;
  return JSON.parse(execFileSync('docker', ['exec', '-u', 'postgres', `${project}-postgres-1`,
    'psql', '-U', 'postgres', '-d', 'inspector', '-Atc', query], { encoding: 'utf8', timeout: 10_000 }));
}
// Read existing ML metadata only; this neither starts work nor changes journal state.
function observedExecution(job) {
  assert.match(job.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert(Number.isInteger(job.epoch) && job.epoch > 0);
  const key = `${job.id}.${job.epoch}`;
  try {
    const journal = JSON.parse(readFileSync(`${stand}/var/pipeline-cache/${process.env.PIPELINE_SMOKE_EXECUTIONS_DIR ?? 'executions-v2'}/${key}.json`, 'utf8'));
    if (journal.unstarted === true) return null;
    assert.equal(journal.key, key);
    assert.match(journal.request_digest, /^[0-9a-f]{64}$/);
    return { job_id: job.id, epoch: job.epoch, state: journal.state, reason: journal.reason,
      request_digest: journal.request_digest, updated_at: journal.updated_at };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
try {
  evidence.health = await json('/health');
  const password = readFileSync(`${stand}/var/secrets/demo_password`, 'utf8').trim();
  const { token } = await json('/api/v1/auth/login', { method: 'POST', data: { login: 'inspector', password } });
  const headers = { authorization: `Bearer ${token}` };
  const multipart = new FormData();
  multipart.append('manifest', new File([JSON.stringify(manifest)], 'manifest.json'));
  for (const file of manifest.files) multipart.append('files', new File([readFileSync(`${fixture}/${file.file_name}`)], file.file_name));
  const uploaded = process.env.PIPELINE_SMOKE_PROCESS
    ? { process_id: process.env.PIPELINE_SMOKE_PROCESS }
    : await json('/api/v1/documents/upload', { method: 'POST', headers, multipart });
  const processId = uploaded.process_id;
  assert.match(processId, /^P-[0-9]{8}-[0-9a-f]+$/);
  evidence.process_id = processId;
  evidence.resumed = Boolean(process.env.PIPELINE_SMOKE_PROCESS);
  writeFileSync(`${output}/started.json`, JSON.stringify(evidence, null, 2));
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(`durable PDF ${evidence.resumed ? 'resumed' : 'uploaded'}: ${processId}`);
  let state;
  const timeoutMs = Number(process.env.PIPELINE_SMOKE_TIMEOUT_MS ?? 180_000);
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1_800_000, 'Invalid smoke timeout');
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    state = await json(`/api/v1/inspection/${processId}/status`, { headers });
    if (i % 20 === 0) console.log(JSON.stringify({ status: state.status, files: state.files.map((f) => ({ status: f.parse_status, error: f.parse_error })) }));
    assert(!state.files.some((f) => f.parse_status === 'FAILED'), JSON.stringify(state.files));
    if (state.status === 'READY') break;
    if (faultMode && !evidence.fault) {
      const snapshot = databaseSnapshot(processId);
      if (cacheLoss && snapshot.committed.some((item) => item.stage === 'parse') &&
          !snapshot.jobs.some((job) => ['RUNNING', 'RECOVERING'].includes(job.status))) {
        execFileSync('docker', ['pause', `${project}-api-1`], { timeout: 10_000 });
        try {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const frozen = databaseSnapshot(processId);
          if (!frozen.jobs.some((job) => ['RUNNING', 'RECOVERING'].includes(job.status))) {
            evidence.fault = { kind: 'cold-ml-cache', at: new Date().toISOString(), before: frozen };
            writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
            console.log('fault: own Redis cache cleared between committed stages; restarting idle ML');
            execFileSync('docker', ['exec', `${project}-pipeline-redis-1`, 'redis-cli', '-s', '/pipeline-cache/redis.sock', 'FLUSHDB'], { timeout: 10_000 });
            execFileSync('docker', ['restart', '--time=1', `${project}-ml-1`], { timeout: 30_000 });
            let healthy = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              const health = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', `${project}-ml-1`], { encoding: 'utf8', timeout: 3_000 }).trim();
              if (health === 'healthy') { healthy = true; break; }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            assert(healthy, 'ML did not recover after cold cache');
            evidence.fault.restarted = new Date().toISOString();
          }
        } finally { execFileSync('docker', ['unpause', `${project}-api-1`], { timeout: 10_000 }); }
      }
      // An asynchronous ML acknowledgement moves the DB job to RECOVERING while
      // its execution is still running. The ML journal below proves activity.
      const active = snapshot.jobs?.filter((job) => ['RUNNING', 'RECOVERING'].includes(job.status)) ?? [];
      const execution = active.map(observedExecution).find((item) => item && ['RUNNING', 'DONE'].includes(item.state));
      if (freeze && execution?.state === 'RUNNING') {
        const frozen = await freezeWorker({ stand, project, execution, snapshot, databaseSnapshot, processId,
          save: (fault) => { evidence.fault = fault; writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2)); } });
        if (frozen) evidence.fault = frozen;
      }
      let external = null;
      if (restartMl && execution) {
        const key = createHash('sha256').update(JSON.stringify({ epoch: execution.epoch, job_id: execution.job_id, namespace: project })).digest('hex');
        try { external = JSON.parse(readFileSync(`${stand}/var/pipeline-cache/external-executions/${key}.json`, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!freeze && !cacheLoss && snapshot.committed.some((item) => item.stage === 'parse') && execution &&
          (!restartMl || (execution.state === 'RUNNING' && Object.values(external?.requests ?? {}).some((item) => item.status === 'RUNNING')))) {
        evidence.fault = { kind: restartMl ? 'ml-sigkill' : `${restartDependency || 'api'}-sigkill`, at: new Date().toISOString(), execution, external, before: snapshot };
        writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
        const victim = restartMl ? 'ml' : (restartDependency || 'api');
        console.log(`fault: SIGKILL own stand ${victim} while a stage is RUNNING`);
        execFileSync('docker', ['kill', '--signal=KILL', `${project}-${victim}-1`], { timeout: 15_000 });
        execFileSync('docker', ['start', `${project}-${victim}-1`], { timeout: 30_000 });
        let healthy = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          try { const health = await json('/health', { timeout: 2_000 }); if (restartMl && !health.ml?.ok) throw Error('ML not ready'); healthy = true; break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
        }
        assert(healthy, 'Service did not recover in 60 seconds');
        evidence.fault.restarted = new Date().toISOString();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(state.status, 'READY', 'durable processing deadline exceeded');
  if (faultMode) assert(evidence.fault?.restarted, 'No in-flight stage caught; fault scenario not proven');
  const card = await json(`/api/v1/inspections/${processId}`, { headers });
  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].parse_status, 'DONE');
  const file = card.files[0];
  const { runs } = await json(`/api/v1/files/${file.id}/runs`, { headers });
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'COMPLETE');
  const trace = await json(`/api/v1/files/${file.id}/runs/${runs[0].id}/trace?page=1`, { headers });
  assert.equal(trace.completeness.publishable, true);
  assert((trace.regions ?? [trace.page]).some((region) => region.lines.length > 0));
  evidence.database = databaseSnapshot(processId);
  assert(evidence.database.runs.every((run) => run.mode === 'durable' && run.status === 'COMPLETE'));
  evidence.sealed_unstarted = [];
  for (const job of evidence.database.jobs) {
    assert.equal(job.status, 'SUCCEEDED');
    const expected = restartMl && job.id === evidence.fault.execution.job_id ? 2 : 1;
    if (job.epoch === expected) continue;
    // A crash can land between claiming the next job and submitting it to ML.
    // Only a persisted unstarted tombstone proves this was not repeated OCR.
    assert(faultMode && job.epoch === 2 && expected === 1, 'Unexpected execution attempts');
    assert.notEqual(job.id, evidence.fault.execution?.job_id, 'Observed execution cannot become unstarted');
    const prior = observedExecution({ ...job, epoch: 1 });
    assert.equal(prior?.state, 'CANCELLED', 'Extra epoch must have a sealed unstarted predecessor');
    assert.equal(prior.reason, 'sealed_unstarted');
    evidence.sealed_unstarted.push(prior);
  }
  assert.equal(evidence.database.jobs.length, trace.completeness.planned_regions + 4);
  assert.equal(evidence.database.artifacts, evidence.database.jobs.length);
  assert.equal(evidence.database.active_pins, 0);
  if (faultMode) {
    for (const committed of evidence.fault.before.committed) {
      assert.deepEqual(evidence.database.committed.find((item) => item.job_id === committed.job_id), committed,
        'Committed artifact changed after API restart');
    }
    for (const before of evidence.fault.before.jobs.filter((job) => job.epoch > 0)) {
      const after = evidence.database.jobs.find((job) => job.id === before.id);
      const expected = restartMl && before.id === evidence.fault.execution.job_id ? before.epoch + 1 : before.epoch;
      assert(after && (after.epoch === expected ||
        (after.epoch === 2 && before.epoch === 1 && evidence.sealed_unstarted.some((item) => item.job_id === before.id))),
        'Unexpected execution attempts after restart');
    }
    const protocol = execFileSync('docker', ['exec', '-u', 'postgres', `${project}-postgres-1`,
      'psql', '-U', 'postgres', '-d', 'inspector', '-Atc',
      `select count(*) from inspector.protocols where inspection_id='${processId}'`], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(Number(protocol.trim()), 1, 'API restart duplicated protocol publication');
  }
  evidence.finished = new Date().toISOString();
  evidence.run_id = runs[0].id;
  writeFileSync(`${output}/trace.json`, JSON.stringify(trace, null, 2));
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, process_id: processId, jobs: evidence.database.jobs.length, evidence: output }));
} catch (error) {
  evidence.failed = new Date().toISOString();
  evidence.error = error instanceof Error ? error.message : String(error);
  if (evidence.process_id) {
    try { evidence.database = databaseSnapshot(evidence.process_id); }
    catch (diagnosticError) {
      evidence.database_snapshot_error = String(diagnosticError);
      console.error('smoke: database snapshot failed:', evidence.database_snapshot_error);
    }
  }
  try { writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2)); }
  catch (writeError) { console.error('smoke: failed to save evidence:', writeError); }
  throw error;
} finally {
  try { await client.dispose(); }
  catch (disposeError) { console.error('smoke: client cleanup failed:', disposeError); }
}
