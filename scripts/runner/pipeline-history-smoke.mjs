// T-238: real upload/revision/history APIs and browser on the isolated durable stand.
// Run only on GPU host via remote-run.sh --light --as-root, after the fault-test slot is released.
// No database writes, worker control, finalization, or external notifications.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, request } from 'playwright';

const stand = process.env.PIPELINE_HISTORY_STAND ?? '/opt/w1-gate/stand/w1-feat-resource-ocr-incremental';
const baseURL = process.env.PIPELINE_HISTORY_URL ?? 'https://127.0.0.1:45812';
assert.equal(new URL(baseURL).hostname, '127.0.0.1', 'history smoke is confined to our loopback stand');
const fixture = resolve(process.env.PIPELINE_HISTORY_FIXTURE ?? 'data/synth/OBJ-SEV-2');
const output = resolve(process.env.PIPELINE_HISTORY_OUTPUT ?? 'var/pipeline-history-smoke');
const timeout = Number(process.env.PIPELINE_HISTORY_TIMEOUT_MS ?? 600_000);
assert(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 3_600_000);
const original = JSON.parse(readFileSync(`${fixture}/manifest.json`, 'utf8'));
assert.equal(original.object.profile.synthetic, true, 'only explicitly synthetic fixtures');
const ids = ['SEV-PD-PZ-1', 'SEV-RD-AR-A', 'SEV-RD-AR-B'];
const files = ids.map((id) => {
  const file = structuredClone(original.files.find((f) => f.file_id === id));
  assert(file, `fixture missing ${id}`);
  assert.equal(createHash('sha256').update(readFileSync(`${fixture}/${file.file_name}`)).digest('hex'), file.sha256);
  return file;
});
const [pd, rdA, rdB] = files;
// The fixture's A is already labelled superseded because its full package contains B.
// The first upload represents the earlier point in time, before B was issued.
rdA.approval_status = 'FOR_CONSTRUCTION';
rdA.predecessor_id = null;
rdB.predecessor_id = rdA.file_id;
assert.notEqual(rdA.sha256, rdB.sha256);
const object = { ...original.object, object_id: `T238-HISTORY-${randomUUID()}`, name: 'СИНТЕТИКА · T238 история редакций' };
const password = readFileSync(`${stand}/var/secrets/demo_password`, 'utf8').trim();
mkdirSync(output, { recursive: true });
const evidence = { started: new Date().toISOString(), baseURL, fixture, phase: 'initializing', files: [], browser: [] };
const save = (name, data) => writeFileSync(`${output}/${name}.json`, JSON.stringify(data, null, 2));
const client = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
let browser, headers;
async function json(path, options = {}) {
  const response = await client.fetch(path, { headers, ...options });
  assert(response.ok(), `${path}: HTTP ${response.status()} ${await response.text()}`);
  return response.json();
}
async function upload(selected, processId) {
  const multipart = new FormData();
  if (processId) multipart.append('process_id', processId);
  multipart.append('manifest', new File([JSON.stringify({ object, files: selected })], 'manifest.json'));
  for (const f of selected) multipart.append('files', new File([readFileSync(`${fixture}/${f.file_name}`)], f.file_name));
  const result = await json('/api/v1/documents/upload', { method: 'POST', multipart });
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.accepted.length, selected.length);
  return result;
}
async function ready(processId, minimumVersion, count) {
  const until = Date.now() + timeout;
  let previous = '', last;
  while (Date.now() < until) {
    last = await json(`/api/v1/inspection/${processId}/status`);
    const summary = JSON.stringify({ phase: evidence.phase, status: last.status, version: last.protocol_version,
      files: last.files.map((f) => ({ name: f.file_name, status: f.parse_status })) });
    if (summary !== previous) { console.log(summary); previous = summary; }
    assert(!last.files.some((f) => f.parse_status === 'FAILED'), JSON.stringify(last.files));
    if (last.status === 'READY' && last.protocol_version >= minimumVersion && last.files.length === count &&
        last.files.every((f) => f.parse_status === 'DONE')) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Error(`history processing deadline exceeded: ${JSON.stringify(last)}`);
}
function objects(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
async function trace(file) {
  const { runs } = await json(`/api/v1/files/${file.id}/runs`);
  assert.equal(runs.length, 1, `unexpected reprocessing of ${file.client_file_id}`);
  assert.equal(runs[0].status, 'COMPLETE');
  const value = await json(`/api/v1/files/${file.id}/runs/${runs[0].id}/trace?page=1`);
  assert.equal(value.context.sha256, file.sha256);
  assert.equal(value.context.run_id, runs[0].id);
  assert.equal(value.completeness.publishable, true);
  assert.deepEqual(value.completeness.reasons, []);
  return { run: runs[0], trace: value };
}
async function verifyLinks(protocol, known) {
  const sources = objects(protocol).filter((o) => o.trace_url && o.pipeline_run_id && o.file_id);
  assert(sources.length, 'protocol has no linked evidence traces');
  const checked = new Set();
  for (const source of sources) {
    assert.equal(source.pipeline_run_id, known.get(source.file_id), 'protocol source refers to wrong run');
    assert(source.trace_url.startsWith(`/api/v1/files/${source.file_id}/runs/${source.pipeline_run_id}/trace?`));
    if (checked.has(source.trace_url)) continue;
    const resolved = await json(source.trace_url);
    assert.equal(resolved.context.run_id, source.pipeline_run_id);
    checked.add(source.trace_url);
  }
  return checked.size;
}
try {
  evidence.health = await json('/health');
  const login = await json('/api/v1/auth/login', { method: 'POST', data: { login: 'inspector', password } });
  headers = { authorization: `Bearer ${login.token}` };
  evidence.phase = 'first-upload';
  const firstUpload = await upload([pd, rdA]);
  evidence.process_id = firstUpload.process_id;
  save('evidence', evidence);
  const prefix = `/api/v1/inspection/${evidence.process_id}`;
  const firstState = await ready(evidence.process_id, 1, 2);
  const firstCard = await json(`/api/v1/inspections/${evidence.process_id}`);
  evidence.first_version = firstState.protocol_version;
  const firstSnapshot = await json(`${prefix}/protocol?version=${evidence.first_version}`);
  save('first-card', firstCard); save('first-snapshot', firstSnapshot);
  const known = new Map(), oldTraces = new Map();
  for (const file of firstCard.files) {
    const checked = await trace(file);
    known.set(file.id, checked.run.id); oldTraces.set(file.id, checked.trace);
    assert.equal(file.revision_role, 'CURRENT');
  }
  evidence.first_links = await verifyLinks(firstSnapshot, known);
  evidence.phase = 'append-revision';
  const secondUpload = await upload([rdB], evidence.process_id);
  assert.equal(secondUpload.process_id, evidence.process_id);
  save('evidence', evidence);
  const secondState = await ready(evidence.process_id, evidence.first_version + 1, 3);
  evidence.second_version = secondState.protocol_version;
  const secondCard = await json(`/api/v1/inspections/${evidence.process_id}`);
  const secondSnapshot = await json(`${prefix}/protocol?version=${evidence.second_version}`);
  const oldAgain = await json(`${prefix}/protocol?version=${evidence.first_version}`);
  assert.deepEqual(oldAgain, firstSnapshot, 'append changed immutable old protocol snapshot');
  assert.notEqual(secondSnapshot.versions.input_manifest_hash, firstSnapshot.versions.input_manifest_hash);
  assert.equal(secondCard.files.find((f) => f.client_file_id === rdA.file_id).revision_role, 'SUPERSEDED');
  assert.equal(secondCard.files.find((f) => f.client_file_id === rdB.file_id).revision_role, 'CURRENT');
  for (const file of secondCard.files) {
    const checked = await trace(file);
    if (known.has(file.id)) {
      assert.equal(checked.run.id, known.get(file.id));
      assert.deepEqual(checked.trace, oldTraces.get(file.id), 'append changed an existing file trace');
    }
    known.set(file.id, checked.run.id);
    evidence.files.push({ id: file.id, client_file_id: file.client_file_id, sha256: file.sha256,
      revision: file.revision, role: file.revision_role, run_id: checked.run.id });
  }
  evidence.second_links = await verifyLinks(secondSnapshot, known);
  evidence.old_links_after_append = await verifyLinks(oldAgain, known);
  const fragments = secondCard.checks.flatMap((check) => check.fragments ?? []);
  assert(fragments.some((f) => f.pipeline_run_id), 'card has no evidence run references');
  for (const fragment of fragments.filter((f) => f.pipeline_run_id)) assert.equal(fragment.pipeline_run_id, known.get(fragment.file_id));
  const history = await json(`${prefix}/protocols`);
  assert(history.some((p) => p.version === evidence.first_version));
  assert(history.some((p) => p.version === evidence.second_version));
  save('second-card', secondCard); save('second-snapshot', secondSnapshot); save('history', history);
  evidence.immutable_snapshot = true;
  evidence.phase = 'browser';
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  await page.goto(`${baseURL}/#/login`);
  await page.fill('#login', 'inspector'); await page.fill('#password', password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL(/#\/inspections/);
  await page.goto(`${baseURL}/#/inspections/${evidence.process_id}`);
  await page.getByRole('button', { name: /^Версии и журнал/ }).click();
  const historyPanel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Версии сводки сверки', exact: true }) });
  await historyPanel.getByText(`v${evidence.first_version}`, { exact: true }).waitFor();
  await historyPanel.getByText(`v${evidence.second_version}`, { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/history.png`, fullPage: true });
  await page.getByRole('button', { name: /^Документы/ }).click();
  for (const file of secondCard.files.filter((f) => [rdA.file_id, rdB.file_id].includes(f.client_file_id))) {
    await page.locator(`#doc-${file.id}`).click();
    const panel = page.getByRole('region', { name: 'Трасса обработки', exact: true });
    await panel.getByRole('button', { name: 'Трасса обработки', exact: true }).click();
    await panel.getByText(/^Страница 1 ·/).waitFor();
    assert.equal(await panel.getByRole('combobox', { name: 'Запуск обработки' }).inputValue(), known.get(file.id));
    await panel.locator('[aria-label="Транскрипция страницы"] button:enabled').first().click();
    await page.locator('.hl.anchor').last().waitFor();
    await page.screenshot({ path: `${output}/${file.client_file_id}-trace.png`, fullPage: true });
    evidence.browser.push({ file_id: file.id, run_id: known.get(file.id), trace_visible: true, overlay_visible: true });
    await page.locator(`#doc-${file.id}`).click();
  }
  evidence.phase = 'passed'; evidence.finished = new Date().toISOString();
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = String(error); throw error;
} finally {
  save('evidence', evidence);
  await browser?.close(); await client.dispose();
}
