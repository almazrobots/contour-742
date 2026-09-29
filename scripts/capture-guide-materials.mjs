// Read-only walkthrough of published documentation. No application API or private corpus.
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const dir='out/materials-media';mkdirSync(dir,{recursive:true});
const base='https://127.0.0.1:55892',browser=await chromium.launch({headless:true});
try{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},recordVideo:{dir:dir+'/raw',size:{width:1440,height:1000}}});
 await ctx.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());assert.equal(r.method(),'GET');assert.equal(u.origin,base);assert(u.pathname.startsWith('/docs/')||u.pathname==='/favicon.ico');await route.continue();});
 const page=await ctx.newPage(),errors=[],chapters=[];page.on('pageerror',e=>errors.push(e.message));
 const publication=await(await ctx.request.get(base+'/docs/publication.json')).json();
 const start=Date.now(),step=async(title,file)=>{chapters.push({seconds:(Date.now()-start)/1000,title});await page.waitForTimeout(3200);await page.screenshot({path:dir+'/'+file+'.png'});};
 await page.goto(base+'/docs/guide/index.html');await page.getByRole('heading',{name:'Руководство пользователя',exact:true}).waitFor();
 await step('Выберите задачу в руководстве; поиск доступен в левой панели','materials-start');
 await page.locator('#search').fill('Реестр материалов');const result=page.locator('#search-results a').filter({hasText:'Реестр материалов'}).first();await result.waitFor();
 await step('Найдите каталог материалов по названию','materials-search');await result.click();
 await page.getByRole('heading',{name:'Реестр материалов',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Что считать актуальным',exact:true}).scrollIntoViewIfNeeded();
 await step('Проверьте назначение и актуальность: прошлый отчёт не подтверждает новый выпуск','materials-status');
 await page.getByRole('link',{name:'План развития базы знаний',exact:true}).click();
 await page.getByRole('heading',{name:'Текущий подтверждённый выпуск',exact:true}).scrollIntoViewIfNeeded();
 await step('Откройте действующий план: текущий выпуск и незавершённые работы указаны отдельно','materials-plan');
 assert.deepEqual(errors,[]);const video=page.video();await ctx.close();copyFileSync(await video.path(),dir+'/materials-walkthrough.webm');
 writeFileSync(dir+'/provenance.json',JSON.stringify({schema:'docs-scenario.v1',scenario_id:'find-material-current-plan',publication,chapters,production_writes:0,scope:'Published documentation only; no app actions',errors},null,2)+'\n');
 console.log(JSON.stringify({captured:true,chapters:chapters.length,production_writes:0}));
}finally{await browser.close();}
