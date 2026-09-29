// Browser verification of an isolated documentation build; never starts product/ML.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('docs');
const reg = JSON.parse(readFileSync('docs/trace/AUDIT-PROVENANCE.json'));
const server = createServer((req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', extname(path) === '.html' ? 'text/html; charset=utf-8' : extname(path) === '.json' ? 'application/json' : 'text/plain'); res.end(readFileSync(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/gera/TRACE-MAP.html?view=audit');
  await page.locator('a[href="../trace/AUDIT-PROVENANCE.html"]').click();
  assert.equal(await page.locator('article').count(), reg.records.length);
  assert.equal(reg.records.length, 257);
  assert.ok(reg.records.every(r => r.reviewed_at && r.evidence && r.declared_revision));
  assert.ok(reg.records.every(r => r.status !== 'unchanged_not_reaudited' || r.files.every(f => f.state === 'unchanged')));
  assert.equal(reg.defects.length, 6);
  for (const d of reg.defects) assert.equal(await page.locator(`article[id="${d.id}"]`).count(), 1);
  await page.locator('#filter').fill('TZA-12.9-01'); assert.equal(await page.locator('article:visible').count(), 1);
  assert.match(await page.locator('article:visible').innerText(), /неизвестна/);
  await page.locator('#filter').fill('NO_SUCH_REQUIREMENT'); assert.equal(await page.locator('article:visible').count(), 0);
  await page.locator('#filter').fill('');
  await page.locator('article').first().locator('summary').click();
  assert.ok(await page.locator('article').first().locator('details').getAttribute('open') !== null);
  mkdirSync('out/audit-provenance-preview', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `out/audit-provenance-preview/registry-${width}.png` });
  }
  const response = await page.request.get(base + '/trace/AUDIT-PROVENANCE.json'); assert.ok(response.ok());
  assert.deepEqual((await response.json()).totals, reg.totals);
  assert.deepEqual(errors, []);
  writeFileSync('out/audit-provenance-preview/AUDIT-PROVENANCE.json', JSON.stringify(reg, null, 1));
  writeFileSync('out/audit-provenance-preview/AUDIT-PROVENANCE.html', readFileSync('docs/trace/AUDIT-PROVENANCE.html'));
  writeFileSync('out/audit-provenance-preview/verification.json', JSON.stringify({ revision: reg.checked_revision, totals: reg.totals, browser: 'PASS', widths: [1440, 390], errors }, null, 2));
  console.log(JSON.stringify({ totals: reg.totals, browser: 'PASS', widths: [1440, 390] }));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
