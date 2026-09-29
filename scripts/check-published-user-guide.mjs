// T-254: live CPU documentation smoke via private SSH transport; no app data mutations.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.GUIDE_LIVE_BASE||'https://127.0.0.1:55892';
const browser=await chromium.launch({headless:true});
try{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 const page=await ctx.newPage(),errors=[],consoleErrors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
 const list=await (await ctx.request.get(base+'/docs/guide/search.json')).json();assert.ok(list.length>=16);
 const imageUrls=new Set();
 for(const article of list){const url=base+'/docs/guide/'+article.href;const r=await ctx.request.get(url);assert.equal(r.status(),200);for(const match of (await r.text()).matchAll(/<img[^>]+src="([^"]+)"/g))imageUrls.add(new URL(match[1],url).href);}
 for(const src of imageUrls){const response=await ctx.request.get(src);assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/^image\//);}
 await page.goto(base+'/docs/index.html');await page.getByRole('heading',{name:'Материалы и документация',exact:true}).waitFor();
 for(const route of ['method/03-services.html','plans/knowledge-base.html']){const response=await ctx.request.get(base+'/docs/'+route);assert.equal(response.status(),200);}
 await page.goto(base+'/docs/index.html');await page.getByRole('link',{name:'База знаний Надзориума',exact:true}).click();await page.getByRole('heading',{name:'Руководство пользователя',exact:true}).waitFor();await page.waitForLoadState('domcontentloaded');
 await page.locator('#search').fill('разметка');try{await page.locator('#search-results a[href$="/docs/guide/annotation.html"]').waitFor({timeout:8000})}catch(e){console.log(JSON.stringify({url:page.url(),status:await page.locator('#search-status').innerText(),results:await page.locator('#search-results').innerText(),errors,consoleErrors}));throw e}
 await page.locator('#search-results a[href$="/docs/guide/annotation.html"]').click();await page.getByRole('heading',{name:'Разметка данных',exact:true}).waitFor();
 mkdirSync('out/guide-live',{recursive:true});await page.screenshot({path:'out/guide-live/desktop.png'});
 await page.goto(base+'/docs/guide/getting-started.html');await page.locator('img').scrollIntoViewIfNeeded();await page.waitForFunction(()=>{const img=document.querySelector('img');return img?.complete&&img.naturalWidth>0});
 await page.goto(base+'/docs/guide/videos.html');const cards=await page.locator('.video-card').all();assert.ok(cards.length>=2);
 for(const card of cards){const video=card.locator('video');await video.evaluate(v=>v.play());
  await video.evaluate(v=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video did not advance')),10000);const check=()=>{if(v.currentTime>0.5){clearTimeout(timer);v.removeEventListener('timeupdate',check);resolve()}};v.addEventListener('timeupdate',check);check()}));
  assert.ok(await video.evaluate(v=>v.videoWidth>0&&v.textTracks.length===1));
  await card.locator('track').evaluate(t=>new Promise((resolve,reject)=>{if(t.readyState===2)return resolve();const timer=setTimeout(()=>reject(Error('Captions did not load')),10000);t.addEventListener('load',()=>{clearTimeout(timer);resolve()},{once:true});t.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Captions failed'))},{once:true})}));
  assert.equal(await video.evaluate(v=>v.textTracks[0].cues.length),await card.locator("[data-video-seek]").count());await video.evaluate(v=>v.pause());
 }
 await page.goto(base+'/docs/gera/TRACE-MAP.html');await page.getByRole('link',{name:'Руководство пользователя',exact:true}).click();await page.getByRole('heading',{name:'Руководство пользователя',exact:true}).waitFor();await page.waitForLoadState('domcontentloaded');
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/docs/guide/library.html');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'out/guide-live/mobile.png'});
 assert.deepEqual(errors,[]);const status={live:true,articles:list.length,images:imageUrls.size,videos:cards.length,search:true,materials_link:true,trace_map_link:true,mobile:true,errors};writeFileSync('out/guide-live/status.json',JSON.stringify(status,null,2));console.log(JSON.stringify(status));
}finally{await browser.close()}
