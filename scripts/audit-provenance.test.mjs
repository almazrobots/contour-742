import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProvenance, renderProvenance } from './audit-provenance.mjs';
import { atomColor } from './tz-color.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'audit-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  const atom = { id: 'TZA-1', t: 'Критерий', accept: 'Проверка', trace: ['RULE'] };
  const dz = { sections: [{ items: [{ atoms: [atom] }] }] };
  const model = { impl: { RULE: { code: ['src/run.ts::run'], tests: ['tests/run.test.ts::works'] } } };
  put('docs/tz/tz-decomposition.yaml', dz); put('docs/gera/inspector/model.yaml', model);
  put('src/run.ts', 'export const run = () => true;'); put('tests/run.test.ts', 'assert.equal(run(), true);');
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test'); git('add', '.'); git('commit', '-m', 'reviewed');
  const revision = git('rev-parse', 'HEAD');
  const audit = { audited_at: '2026-09-27', revision, atoms: { 'TZA-1': { verdict: 'REAL', uncertain: false, evidence: 'src/run.ts:1; tests/run.test.ts:1' } }, defects: [{ id: 'TZA-1', status: 'open', t: '<script>bad()</script>' }] };
  put('docs/trace/COVERAGE-AUDIT.json', audit);
  const snapshots = { revision, atoms: { 'TZA-1': { ...atom } } };
  return { root, put, git, audit, snapshots, model, dz, atom, run: () => buildProvenance(root, audit, snapshots, model, dz) };
}
test('unchanged files retain historical verdict without claiming new audit', t => {
  const f = fixture(t), r = f.run().records[0];
  assert.equal(r.status, 'unchanged_not_reaudited'); assert.equal(r.reviewed_revision, f.audit.revision);
  assert.equal(r.files.length, 2); assert.ok(r.files.every(x => x.reviewed_url === null));
});
test('code drift without trace drift invalidates green, including uncommitted changes', t => {
  const f = fixture(t); f.put('src/run.ts', 'export const run = () => false;');
  const r = f.run().records[0]; assert.equal(r.status, 'reaudit_required');
  assert.equal(r.files.find(x => x.path === 'src/run.ts').state, 'changed');
  assert.equal(atomColor({ ...f.atom, code: 'done', auditFreshness: r.status }, f.audit.atoms['TZA-1'], f.atom).color, 'yellow');
});
test('changed test and changed link both require repeat review', t => {
  const f = fixture(t); f.put('tests/run.test.ts', '// no assertion'); assert.equal(f.run().records[0].status, 'reaudit_required');
  f.model.impl.RULE.tests = ['tests/other.ts::works']; assert.ok(f.run().records[0].reasons.includes('изменены связи модели с кодом/тестами'));
});
test('mutable revision is unknown and cannot preserve green', t => {
  const f = fixture(t); f.audit.reaudits = [{ at: '2026-09-28', revision: 'origin/main', atoms: ['TZA-1'] }];
  const r = f.run().records[0]; assert.equal(r.status, 'unknown'); assert.equal(r.reviewed_revision, null);
  assert.equal(atomColor({ ...f.atom, code: 'done', auditFreshness: r.status }, f.audit.atoms['TZA-1'], f.atom).color, 'yellow');
});
test('individual dated review takes precedence; missing snapshot is unknown', t => {
  const f = fixture(t); f.audit.atoms['TZA-1'].reaudited = { at: '2026-09-29', revision: f.audit.revision };
  delete f.snapshots.atoms['TZA-1']; const r = f.run().records[0]; assert.equal(r.reviewed_at, '2026-09-29'); assert.equal(r.status, 'unknown');
});
test('criterion changes and removed evidence require re-audit; HTML escapes evidence', t => {
  const f = fixture(t); f.atom.accept = 'Другой критерий'; rmSync(join(f.root, 'src/run.ts'));
  const r = f.run(); assert.equal(r.records[0].status, 'reaudit_required');
  assert.equal(r.records[0].files.find(x => x.path === 'src/run.ts').state, 'missing');
  const html = renderProvenance(r); assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;')); assert.ok(!html.includes('<script>bad()'));
});

test('later batch review supersedes older atom metadata without discarding history', t => {
  const f = fixture(t);
  f.audit.atoms['TZA-1'].reaudited = { at: '2026-09-28', revision: f.audit.revision };
  f.audit.reaudits = [{ at: '2026-09-29', revision: f.audit.revision, atoms: ['TZA-1'] }];
  const r = f.run().records[0];
  assert.equal(r.reviewed_at, '2026-09-29'); assert.equal(r.metadata_source, 'reaudits'); assert.equal(r.review_history.length, 3);
});
