// T-254: проверка публикационного контракта, внутренних ссылок и браузерного поведения.
import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const out=resolve(process.argv[2]||'out/user-guide');
const standalone=process.argv.includes('--standalone');
const pages=readdirSync(out).filter(p=>p.endsWith('.html'));
assert.ok(pages.length>=16);
for(const page of pages){const text=readFileSync(join(out,page),'utf8');for(const [,href]of text.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)){if(href.startsWith('../')||href.startsWith('/')||href.startsWith('https:'))continue;assert.ok(existsSync(join(out,href)),page+': missing '+href)}assert.ok(!text.includes('GUIDELINKTOKEN'));assert.ok(text.includes('lang="ru"'));}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webm':'video/webm','.vtt':'text/vtt; charset=utf-8','.png':'image/png','.woff2':'font/woff2'};
const server=createServer((req,res)=>{const path=resolve(out,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(out+'/')){res.writeHead(403).end();return}if(!existsSync(path)){res.writeHead(404).end();return}res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');
const bytes=readFileSync(path);res.setHeader('Accept-Ranges','bytes');
if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);const first=match?Number(match[1]):-1,last=match&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
if(first<0||first>=bytes.length||last<first){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length}).end();return}
res.writeHead(206,{'Content-Range':`bytes ${first}-${last}/${bytes.length}`,'Content-Length':last-first+1});res.end(bytes.subarray(first,last+1));return}
res.setHeader('Content-Length',bytes.length);res.end(bytes)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base+'/index.html');assert.equal(await page.locator('h1').innerText(),'Руководство пользователя');
 await page.locator('#search').fill('финализация');await page.locator('#search-results a').first().waitFor();assert.ok((await page.locator('#search-results').innerText()).includes('Завершение'));
 await page.locator('#search').fill('zzzznotfound');await page.getByText('Ничего не найдено.',{exact:false}).waitFor();
 await page.locator('#search').press('Escape');await page.waitForTimeout(250);assert.equal(await page.locator('#search-results a').count(),0);
 await page.goto(base+'/annotation.html');await page.locator('.toc a').first().click();assert.ok((await page.evaluate(()=>location.hash)).startsWith('#section-'));
 mkdirSync('out/guide-audit',{recursive:true});await page.screenshot({path:'out/guide-audit/desktop.png',fullPage:true});
 for(const width of [1440,1920,2560]){
  await page.setViewportSize({width,height:1000});await page.goto(base+'/annotation.html');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);
  assert.equal(await page.locator('.sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().left)),0);
  assert.equal(await page.locator('main').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  await page.screenshot({path:'out/guide-audit/desktop-'+width+'.png'});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/library.html');assert.equal(await page.locator('#navigation').getAttribute('open'),null);
 await page.locator('#sidebar-toggle').click();await page.locator('#navigation summary').click();assert.ok(await page.locator('#navigation a[aria-current="page"]').isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'out/guide-audit/mobile.png',fullPage:true});
 if(existsSync(join(out,'videos.html'))){
  await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/videos.html');
  for(const card of await page.locator('.video-card').all()){
   const video=card.locator('video');await video.evaluate(v=>v.play());
   await video.evaluate(v=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video did not advance')),10000);const check=()=>{if(v.currentTime>0.5){clearTimeout(timer);v.removeEventListener('timeupdate',check);resolve()}};v.addEventListener('timeupdate',check);check()}));
   assert.ok(await video.evaluate(v=>v.videoWidth>0&&Number.isFinite(v.duration)&&v.duration>1));await video.evaluate(v=>v.pause());
   await card.locator('summary').click();await card.locator('[data-video-seek]').nth(2).click();assert.ok(await video.evaluate(v=>v.currentTime>1));
   await card.locator('track').evaluate(t=>new Promise((resolve,reject)=>{if(t.readyState===2)return resolve();t.addEventListener('load',resolve,{once:true});t.addEventListener('error',reject,{once:true})}));
   assert.equal(await video.evaluate(v=>v.textTracks[0].cues.length),await card.locator("[data-video-seek]").count());
  }
 }
 assert.deepEqual(errors,[]);writeFileSync('out/guide-audit/status.json',JSON.stringify({pages:pages.length,search:true,not_found:true,escape:true,toc:true,mobile_navigation:true,no_horizontal_overflow:true,errors},null,2));console.log('guide check: '+pages.length+' pages, links, search, toc, layouts 390/1440/1920/2560 OK');
}finally{await browser?.close();await new Promise(r=>server.close(r))}
