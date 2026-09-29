import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const browser=await chromium.launch({headless:true});
const errors=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  const url=process.env.TRACE_GAPS_URL || pathToFileURL(resolve('docs/gera/TRACE-MAP.html')).href;
  await page.goto(url+'?view=gaps');
  const counts=await page.evaluate(()=>({open:D.atoms.filter(a=>a.color!=='green').length,model:D.gaps.filter(g=>g.status==='open').length,closed:D.gaps.filter(g=>g.status==='closed').length,colors:D.counts.atomsBy}));
  assert.equal(await page.locator('[data-gap-atom]').count(),counts.open);
  assert.equal(await page.locator('[data-model-gap]').count(),counts.model);
  assert.equal(await page.locator('[data-model-gap="GAP-INSP-07"]').count(),0);
  for(const color of ['red','yellow','blue']) {
    await page.locator(`[data-scope="${color}"]`).click();
    assert.equal(await page.locator('[data-gap-atom]').count(),counts.colors[color]);
  }
  await page.locator('[data-scope="all"]').click();
  await page.locator('#q').fill('TZA-9.1.1-03');
  assert.equal(await page.locator('[data-gap-atom]').count(),1);
  await page.locator('[data-gap-atom] summary').click();
  assert.match(await page.locator('[data-gap-atom]').innerText(),/0,855.*не пройден/);
  await page.locator('#q').press('Enter');
  assert.equal(await page.locator('[data-gap-atom]').count(),1);
  await page.locator('#q').fill('NO_SUCH_GAP_567');
  assert.equal(await page.locator('[data-gap-atom]').count(),0);
  assert.equal(await page.locator('[data-model-gap]').count(),0);
  assert.equal(await page.getByRole('status').count(),2);
  await page.locator('#q').fill('');
  await page.locator('[data-model-status="closed"]').click();
  assert.equal(await page.locator('[data-model-gap]').count(),counts.closed);
  assert.match(await page.locator('[data-model-gap="GAP-INSP-07"]').innerText(),/реализована шкала/i);
  await page.locator('#q').fill('pressureClass');
  assert.ok(await page.locator('[data-gap-atom]').count()>0,'search includes implementation refs');
  await page.locator('#q').fill('');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  }
  await page.locator('#reset').click();
  assert.equal(await page.locator('[data-model-gap]').count(),counts.model);
  assert.equal(await page.locator('#panel').isVisible(),false,'gap view has no irrelevant map panel');
  await page.locator('#stage').evaluate(el=>el.scrollTop=0);
  mkdirSync('out/trace-gaps',{recursive:true});
  await page.screenshot({path:'out/trace-gaps/mobile.png'});
  assert.deepEqual(errors,[]);
  writeFileSync('out/trace-gaps/result.json',JSON.stringify({counts,errors,checks:'filters/search/empty/closed/evidence/mobile',passed:true},null,2));
  console.log(JSON.stringify({passed:true,counts}));
} finally {await browser.close();}
