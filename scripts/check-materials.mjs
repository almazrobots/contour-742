import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('out/docs'),out=process.env.DOCS_LIVE_BASE?'out/material-live':'out/material-audit';mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{const p=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!p.startsWith(root+'/')||!existsSync(p)){res.writeHead(404).end();return}const types={'.html':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.woff2':'font/woff2'};res.setHeader('Content-Type',types[extname(p)]||'application/octet-stream');res.end(readFileSync(p))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=process.env.DOCS_LIVE_BASE||'http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});const errors=[];
try{
 const page=await browser.newPage({ignoreHTTPSErrors:true});page.on('pageerror',e=>errors.push(e.message));
 for(const width of [1440,1920,2560,390]){
  await page.setViewportSize({width,height:1000});
  for(const route of ['index.html','method/03-services.html','approach/c4.html','plans/knowledge-base.html']){
   await page.goto(base+'/'+route);assert.equal(await page.locator('.site-header .brand').count(),1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+':overflow '+width);
   await page.screenshot({path:join(out,route.replaceAll('/','-')+'-'+width+'.png')});
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/index.html');
 await page.keyboard.press('Control+k');assert.equal(await page.locator('#material-search').evaluate(el=>document.activeElement===el),true);
 await page.locator('#material-search').fill('разметка');await page.locator('#search-results a').first().waitFor();
 assert.ok((await page.locator('#search-results a').first().getAttribute('href')).includes('/guide/'));
 await page.goto(base+'/method/03-services.html');await page.locator('.toc a').first().click();assert.ok((await page.evaluate(()=>location.hash)).startsWith('#material-section-'));
 for(const width of [1440,2560,390]){
  await page.setViewportSize({width,height:1000});
  for(const route of ['gera/ARCHITECTURE.html','gera/PIPELINE.html','design/design-system.html','bi/dashboard.html']){
   await page.goto(base+'/'+route);assert.equal(await page.locator('.docs-service-nav').count(),1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+':overflow '+width);
   await page.screenshot({path:join(out,route.replaceAll('/','-')+'-'+width+'.png')});
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/gera/ARCHITECTURE.html');
 for(const profile of ['stand','dev','gpu']){await page.locator('[data-p="'+profile+'"]').click();assert.equal(await page.locator('[data-p="'+profile+'"]').getAttribute('aria-pressed'),'true');}
 await page.locator('.dia .n[data-id]').filter({visible:true}).first().click();assert.ok((await page.locator('#card').innerText()).length>40);
 await page.goto(base+'/bi/dashboard.html');await page.keyboard.press('Control+k');await page.locator('#pq').waitFor({state:'visible'});await page.keyboard.press('Escape');assert.ok(await page.locator('#scrim').isHidden());
 await page.locator('[data-p="7d"]').click();await page.waitForFunction(()=>document.querySelector('[data-p="7d"]')?.getAttribute('aria-pressed')==='true');
 await page.goto(base+'/design/design-system.html');await page.locator('.toc a[href="#color"]').click();await page.waitForFunction(()=>location.hash==='#color');
 const publication=JSON.parse(readFileSync(join(root,'publication.json'))),previous=JSON.parse(readFileSync('out/previous-publication.json'));
 for(const key of Object.keys(previous)){if(!['site_revision','docs_published_at'].includes(key))assert.deepEqual(publication[key],previous[key])}
 assert.deepEqual(errors,[]);writeFileSync(join(out,'status.json'),JSON.stringify({routes:8,widths:[1440,1920,2560,390],search:true,toc:true,source_data_metadata_preserved:true,errors},null,2));console.log('materials: layouts, search, toc, source metadata OK');
}finally{await browser.close();await new Promise(r=>server.close(r))}
