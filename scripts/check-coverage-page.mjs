// Run on W1 after generating documentation, or against the public final release.
// Usage: node scripts/check-coverage-page.mjs [TRACE-MAP.html path]
// Live: TRACE_DOCS_BASE=https://.../TRACE-MAP.html TRACE_DOCS_AUTH_FILE=/private/auth.json
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const file = resolve(process.argv[2] || 'docs/gera/TRACE-MAP.html');
const url = new URL(process.env.TRACE_DOCS_BASE || pathToFileURL(file).href);
assert.ok(url.pathname.endsWith('/TRACE-MAP.html'), 'target must be TRACE-MAP.html');
url.searchParams.set('view', 'coverage');
const output = resolve('out/coverage-page-audit');
mkdirSync(output, { recursive: true });
const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const httpCredentials = process.env.TRACE_DOCS_AUTH_FILE
    ? JSON.parse(readFileSync(process.env.TRACE_DOCS_AUTH_FILE, 'utf8')) : undefined;
  const context = await browser.newContext({ httpCredentials, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: 90000 });
  const bytes = url.protocol === 'file:' ? readFileSync(file) : await response.body();
  if (url.protocol !== 'file:') {
    assert.equal(response.status(), 200);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(readFileSync(file)).digest('hex'), 'public response matches final local artifact');
  }
  const data = await page.evaluate(() => ({ coverage: D.coverage, atoms: D.atoms }));
  const { coverage: c, atoms } = data;
  assert.equal(new Set(atoms.map(a => a.id)).size, atoms.length, 'unique atoms');
  function checkTally(summary, subset) {
    assert.equal(summary.n, subset.length);
    for (const key of ['done', 'partial', 'none']) assert.equal(summary[key], subset.filter(a => a.code === key).length);
    assert.equal(summary.pct, subset.length ? Math.round(100 * summary.done / subset.length) : 0);
    assert.equal(summary.done + summary.partial + summary.none, summary.n);
    for (const color of ['green', 'yellow', 'red', 'blue', 'grey']) assert.equal(summary.colors[color], subset.filter(a => a.color === color).length);
    assert.equal(Object.values(summary.colors).reduce((n, v) => n + v, 0), summary.n);
  }
  checkTally(c.total, atoms);
  for (const section of c.sections) checkTally(section, atoms.filter(a => a.section === section.id));
  for (const group of c.groups) checkTally(group, atoms.filter(a => group.sections.includes(a.section)));
  assert.equal((await page.locator('.cvhero .big').innerText()).trim(), `${c.total.pct} %`);
  const text = await page.locator('#stage').innerText();
  assert.match(text, /не доказывает поведение кода/);
  assert.match(text, /процент выполнения.*не установлен/);
  assert.match(text, /не сравнивает содержимое файлов реализации/);
  assert.doesNotMatch(await page.locator('header').innerText(), /реализовано и проверено|код готов, ждёт стенда/i);
  assert.doesNotMatch(text, /Реализовано и проверено|Код готов, ждёт стенда/);
  for (const section of c.sections) {
    const row = page.locator(`[data-sec="${section.id}"]`);
    assert.equal((await row.locator('.pc').innerText()).trim(), `${section.pct} %`);
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'), 'true');
    const content = row.locator('xpath=following-sibling::*[1]');
    for (const atom of section.open) assert.ok((await content.innerText()).includes(atom.id), `open atom ${atom.id} is visible`);
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'), 'false');
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload({ waitUntil: 'load' });
    await page.locator('#stage').evaluate(el => { el.scrollTop = 0; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `coverage fits ${width}px viewport`);
    await page.screenshot({ path: `${output}/coverage-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, [], 'no browser JavaScript errors');
  const report = { ok: true, url: url.href, sha256: createHash('sha256').update(bytes).digest('hex'), total: c.total, sections: c.sections.length, browserErrors: errors };
  writeFileSync(`${output}/status.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
