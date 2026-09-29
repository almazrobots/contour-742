// Inspector labels a synthetic source, a different curator adjudicates, then releases a real dataset.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const source=process.env.DOCS_API_SOURCE,revision='df65e1884788b64ecdec76b73134d9eb75faec2d';
assert(source&&readFileSync(join(source,'PINNED-REVISION'),'utf8').trim()===revision);
assert(process.env.INSPECTOR_VERIFICATION_CORPUS_DIR?.startsWith('/tmp/nadzorium-curator-corpus-'));
const out=resolve('out/curator-media'),fixture=process.env.INSPECTOR_VERIFICATION_CORPUS_DIR;mkdirSync(out,{recursive:true});
const password='docs-curator-synthetic-20260929';
Object.assign(process.env,{INSPECTOR_DEMO_PASSWORD:password,INSPECTOR_PROFILE:'dev',INSPECTOR_ML_URL:'http://127.0.0.1:9',INSPECTOR_RIN_URL:'http://127.0.0.1:9'});
globalThis.fetch=async()=>{throw Error('Fixture outbound transport forbidden');};
const {openDb}=await import(pathToFileURL(join(source,'apps/api/src/db.ts')));
const {buildApp}=await import(pathToFileURL(join(source,'apps/api/src/app.ts')));
const {ingestAnnotations}=await import(pathToFileURL(join(source,'apps/api/src/services/data-verification.ts')));
const db=await openDb('memory'),app=buildApp(db);await app.ready();
const png=readFileSync(join(out,'synthetic-original.png')),sha=createHash('sha256').update(png).digest('hex');writeFileSync(join(fixture,sha),png);
const curator=await db.get("select id from users where login='curator'");assert(curator?.id);
await ingestAnnotations(db,curator.id,{id:'docs-curator-synthetic',source_version:'docs-curator.v1',tasks:[{parameter:'M-007',operation:'reading',source_version:'docs-curator.v1',sides:[{sha256:sha,file_name:'Учебный пример — этажность.png',kind:'png',page:1,object_key:'DOCS-CURATOR-01',value:'12',quote:'Количество этажей: 11',stage:'PD',bbox:[0.04,0.25,0.80,0.60]}]}]});
const task=await db.get("select id from verification_tasks where parameter='M-007'");assert(task?.id);
const base='https://127.0.0.1:48845/verification';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1440,height:1000},recordVideo:{dir:join(out,'raw'),size:{width:1440,height:1000}}});
const health=await(await context.request.get('https://127.0.0.1:48845/health')).json();assert.equal(health.revision,revision);
const page=await context.newPage(),errors=[],calls=[],assetTasks=[],assets=[],chapters=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(/\.(js|css)(?:\?|$)/.test(r.url()))assetTasks.push((async()=>{const bytes=await r.body();assets.push({path:new URL(r.url()).pathname,sha256:createHash('sha256').update(bytes).digest('hex')});})());});
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());
 if(u.pathname.includes('/api/')){const url=u.pathname.replace(/^\/verification(?=\/api\/)/,'')+u.search;const r=await app.inject({method:req.method(),url,headers:{...req.headers(),host:'localhost'},...(req.postData()?{payload:req.postData()}:{})});calls.push({method:req.method(),path:url.split('?')[0],status:r.statusCode});const h={...r.headers};delete h['content-length'];delete h['transfer-encoding'];return route.fulfill({status:r.statusCode,headers:h,body:r.rawPayload});}
 if(u.origin!=='https://127.0.0.1:48845'){await route.abort();throw Error('Unexpected outbound browser request: '+u.origin);}await route.continue();
});
const started=Date.now(),chapter=title=>chapters.push({seconds:(Date.now()-started)/1000,title}),pause=()=>page.waitForTimeout(3100),snap=name=>page.screenshot({path:join(out,name+'.png')});
async function login(name){await page.goto(base+'/#/login');await page.locator('#login').fill(name);await page.locator('#password').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Получить задание',exact:true}).waitFor();}
async function logout(){await page.getByRole('link',{name:'Выйти',exact:true}).click();await page.locator('#login').waitFor();}
let release;
try{
 await login('inspector');chapter('Первый оператор получает синтетическое задание и проверяет оригинал');await pause();
 await page.getByRole('button',{name:'Получить задание',exact:true}).click();await page.locator('canvas').first().waitFor({state:'visible'});await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].every(c=>c.width>0));
 await page.getByRole('button',{name:/Нет/}).first().click();await page.locator('textarea').fill('В оригинале 11 этажей, предложено 12.');await page.getByLabel('Правильное значение — если видно').fill('11');
 chapter('Оператор отвечает «Нет» с исправлением 11 и пояснением');await pause();await snap('curator-original-label');
 const labelResponse=page.waitForResponse(r=>r.url().includes('/labels')&&r.request().method()==='POST');await page.getByRole('button',{name:'Сохранить и продолжить',exact:true}).click();assert.equal((await labelResponse).status(),200);
 const label=await db.get('select * from verification_labels where task_id=$1',[task.id]);assert.equal(label.answer,'NO');assert.equal(label.corrected_value,'11');assert.notEqual(label.user_id,curator.id);
 await logout();await login('curator');await page.getByRole('button',{name:'Управление разметкой',exact:true}).click();await page.getByRole('heading',{name:'Независимый разбор',exact:true}).waitFor();
 await page.getByRole('button',{name:'Разобрать',exact:true}).click();await page.getByText('независимый разбор',{exact:false}).first().waitFor();await page.locator('canvas').first().waitFor({state:'visible'});
 chapter('Другой куратор получает независимый разбор по сохранённому ответу');await pause();await snap('curator-review');
 await page.getByRole('button',{name:/Нет/}).first().click();await page.locator('textarea').fill('Независимо проверено: в оригинале 11 этажей; значение 12 неверно.');await page.getByLabel('Правильное значение — если видно').fill('11');
 chapter('Куратор выбирает «Нет», указывает обязательное основание и исправление');await pause();await snap('curator-reason');
 const reviewResponse=page.waitForResponse(r=>r.url().includes(`/tasks/${task.id}/adjudications`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Сохранить и продолжить',exact:true}).click();assert.equal((await reviewResponse).status(),200);
 const review=await db.get('select * from verification_adjudications where task_id=$1',[task.id]);assert(review&&review.author===curator.id&&review.answer==='NO'&&review.comment.length>0&&review.corrected_value==='11');
 chapter('Основание сохранено настоящим API; исходный ответ другого оператора остаётся отдельным');await pause();
 const releaseResponse=page.waitForResponse(r=>r.url().endsWith('/verification/datasets/release')&&r.request().method()==='POST');await page.getByRole('button',{name:'Зафиксировать проверенный набор',exact:true}).click();const released=await releaseResponse;assert.equal(released.status(),200);release=await released.json();assert.match(release.id,/^annotations-/);assert.equal(release.manifest.count,1);
 await page.getByText('Версия: '+release.id,{exact:true}).waitFor();const dataset=await db.get('select * from verification_datasets where id=$1',[release.id]);assert(dataset);const item=await db.get('select * from verification_dataset_items where dataset_id=$1',[release.id]);assert.equal(item.task_id,task.id);
 chapter('Куратор выпускает проверенный набор: идентификатор и один разобранный пример');await pause();await snap('curator-released');
 assert.deepEqual(errors,[]);await Promise.all(assetTasks);assert(assets.length>0);
 const video=page.video();await context.close();copyFileSync(await video.path(),join(out,'curator-walkthrough.webm'));
 const duration=(Date.now()-started)/1000,stamp=t=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
 writeFileSync(join(out,'curator-walkthrough.vtt'),'WEBVTT\n\n'+chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(chapters[i+1]?.seconds??duration)}\n${c.title}\n`).join('\n'));
 writeFileSync(join(out,'curator-transcript.txt'),chapters.map(c=>stamp(c.seconds)+' '+c.title).join('\n')+'\n');
 writeFileSync(join(out,'provenance.json'),JSON.stringify({schema:'docs-scenario.v1',scenario_id:'operator-independent-curator-release',ui_revision:revision,api_revision:revision,ui_asset_hashes:assets,roles:['inspector','curator'],fixture_id:'synthetic-single-png-11-vs-12',data:'synthetic only; separate operator and curator; not OCR or model training',production_api_calls:0,production_writes:0,fixture_api_calls:calls.length,label:{task_id:task.id,answer:label.answer,corrected_value:label.corrected_value},adjudication:{task_id:task.id,answer:review.answer,author_is_distinct:review.author!==label.user_id,has_reason:Boolean(review.comment),corrected_value:review.corrected_value},dataset:{id:release.id,manifest:release.manifest,item_count:1},validated:['operator_label_real_API','independent_review_real_API','mandatory_reason_supplied','dataset_release_real_API','dataset_item_saved'],duration_seconds:duration,chapters,page_errors:errors,recorded_at:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify({captured:true,dataset_id:release.id,production_writes:0,fixture_api_calls:calls.length}));
}catch(error){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));throw error;}
finally{await browser.close();await app.close();await db.close();}
