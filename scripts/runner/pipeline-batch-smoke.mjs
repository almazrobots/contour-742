// Synthetic pilot only: upload batch, measure control responses, verify every physical page.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';

assert.equal(process.platform, 'linux', 'remote runner only');
const fixture = resolve(process.env.PIPELINE_SMOKE_FIXTURE);
const output = resolve(process.env.PIPELINE_SMOKE_OUTPUT);
const manifest = JSON.parse(readFileSync(`${fixture}/manifest.json`));
const expected = JSON.parse(readFileSync(`${fixture}/expected.json`));
assert.equal(manifest.object.profile.synthetic, true, 'synthetic fixture required');
assert(manifest.files.length >= 1 && manifest.files.length <= 10);
manifest.object.object_id = `T243-${randomUUID()}`;
mkdirSync(output, { mode: 0o700 });
const evidence = { started: new Date().toISOString(), observations: [], files: [], mode: 'fresh-upload; new run; immutable runtime identity recorded' };
const save = () => writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
const client = await request.newContext({ baseURL: 'https://127.0.0.1:45812', ignoreHTTPSErrors: true });
async function json(path, options = {}) {
  const response = await client.fetch(path, { timeout: 15_000, ...options });
  assert(response.ok(), `${path}: HTTP ${response.status()}`);
  return response.json();
}
try {
  const password = readFileSync('/opt/w1-gate/stand/w1-feat-resource-ocr-incremental/var/secrets/demo_password', 'utf8').trim();
  evidence.health = await json('/health');
  const { token } = await json('/api/v1/auth/login', { method: 'POST', data: { login: 'inspector', password } });
  const headers = { authorization: `Bearer ${token}` };
  const multipart = new FormData();
  multipart.append('manifest', new File([JSON.stringify(manifest)], 'manifest.json'));
  for (const f of manifest.files) {
    assert.equal(basename(f.file_name), f.file_name);
    assert.equal(expected[f.file_name].sha256, f.sha256);
    multipart.append('files', new File([readFileSync(`${fixture}/${f.file_name}`)], f.file_name));
  }
  const uploaded = await json('/api/v1/documents/upload', { method: 'POST', headers, multipart, timeout: 60_000 });
  evidence.process_id = uploaded.process_id;
  assert.match(evidence.process_id, /^P-[0-9]{8}-[0-9a-f]+$/);
  save(); console.log(JSON.stringify({ uploaded: evidence.process_id, documents: manifest.files.length }));
  const deadline = Date.now()+12*60_000;
  let state;
  while (Date.now()<deadline) {
    const start = performance.now();
    state = await json(`/api/v1/inspection/${evidence.process_id}/status`, { headers });
    evidence.observations.push({ utc: new Date().toISOString(), ms: performance.now()-start, state: state.status,
      done: state.files.filter((f) => f.parse_status==='DONE').length });
    save();
    assert(!state.files.some((f) => f.parse_status==='FAILED'), JSON.stringify(state.files.map((f) => ({ name:f.file_name,error:f.parse_error }))));
    if (state.status==='READY') break;
    if (evidence.observations.length % 10===1) console.log(JSON.stringify(evidence.observations.at(-1)));
    await new Promise((r) => setTimeout(r,2000));
  }
  assert.equal(state.status,'READY','bounded pilot deadline exceeded');
  const card = await json(`/api/v1/inspections/${evidence.process_id}`,{headers});
  assert.equal(card.files.length,manifest.files.length);
  for (const file of card.files) {
    assert.equal(file.parse_status,'DONE');
    const gold = expected[file.file_name];
    assert.equal(file.sha256,gold.sha256);
    const { runs } = await json(`/api/v1/files/${file.id}/runs`,{headers});
    assert.equal(runs.length,1); assert.equal(runs[0].status,'COMPLETE');
    const pages=[];
    for (let page=1;page<=gold.pages;page++) {
      const trace=await json(`/api/v1/files/${file.id}/runs/${runs[0].id}/trace?page=${page}`,{headers});
      assert.equal(trace.context.sha256,gold.sha256);
      assert.equal(trace.completeness.publishable,true);
      assert.deepEqual(trace.completeness.reasons,[]);
      assert(trace.regions.length>0 && trace.regions.every((r) => r.region.page===page));
      assert(trace.regions.some((r) => r.lines.length>0));
      pages.push({ page,regions:trace.regions.length });
    }
    evidence.files.push({name:file.file_name,sha256:file.sha256,run_id:runs[0].id,pages}); save();
  }
  const protocol=await json(`/api/v1/inspection/${evidence.process_id}/protocol`,{headers});
  assert.equal(protocol.process_id,evidence.process_id);
  const times=evidence.observations.map((o) => o.ms).sort((a,b) => a-b);
  evidence.control_latency_ms={samples:times.length,p95:times[Math.ceil(times.length*.95)-1],max:times.at(-1)};
  evidence.passed=true; evidence.finished=new Date().toISOString();
  console.log(JSON.stringify({passed:true,process_id:evidence.process_id,documents:evidence.files.length,
    pages:evidence.files.reduce((n,f) => n+f.pages.length,0),control:evidence.control_latency_ms}));
} catch (error) {
  evidence.error=String(error); throw error;
} finally { save(); await client.dispose(); }
