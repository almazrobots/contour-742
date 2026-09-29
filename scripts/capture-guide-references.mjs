// Read-only reference workflow, real pinned API and its public seed in isolated memory DB.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const revision='c0851cc7b78e28e7bd7a477be2d3274010d42144',source=process.env.DOCS_API_SOURCE;
assert(source&&readFileSync(join(source,'PINNED-REVISION'),'utf8').trim()===revision);
assert(process.env.INSPECTOR_BLOB_DIR?.startsWith('/tmp/nadzorium-references-blobs-'));
Object.assign(process.env,{INSPECTOR_PROFILE:'dev',INSPECTOR_BLOB_STORE:'fs',INSPECTOR_DEMO_PASSWORD:'docs-reference-fixture-20260929',INSPECTOR_ML_URL:'http://127.0.0.1:9'});
delete process.env.INSPECTOR_BLOB_KEY_FILE;delete process.env.INSPECTOR_BLOB_OLD_KEYS_FILE;
globalThis.fetch=async()=>{throw Error('Outbound fixture transport forbidden');};
const {openDb}=await import(pathToFileURL(join(source,'apps/api/src/db.ts')));
const {buildApp}=await import(pathToFileURL(join(source,'apps/api/src/app.ts')));
const db=await openDb('memory'),app=buildApp(db);await app.ready();
const counts=()=>db.get('select (select count(*)::int from params) params,(select count(*)::int from normative_base) norms,(select count(*)::int from inspections) inspections,(select count(*)::int from decisions) decisions');
const before=await counts();assert(before.params>0);assert(before.norms>0);assert.equal(before.inspections,0);
const out=resolve('out/references-media');mkdirSync(out,{recursive:true});
const base='https://127.0.0.1:46443',browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1440,height:1000},recordVideo:{dir:join(out,'raw'),size:{width:1440,height:1000}}});
const health=await(await context.request.get(base+'/health')).json();assert.equal(health.revision,revision);
const page=await context.newPage(),errors=[],calls=[],assets=[],assetTasks=[],chapters=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(/\.(js|css)(?:\?|$)/.test(r.url()))assetTasks.push((async()=>{const b=await r.body();assets.push({path:new URL(r.url()).pathname,sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length})})());});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.pathname.includes('/api/')){
  assert(req.method()==='GET'||(req.method()==='POST'&&url.pathname==='/api/v1/auth/login'),'Reference workflow must not mutate domain data');
  const r=await app.inject({method:req.method(),url:url.pathname+url.search,headers:{...req.headers(),host:'localhost'},...(req.postData()?{payload:req.postData()}: {})});
  calls.push({method:req.method(),path:url.pathname,status:r.statusCode});
  const headers={...r.headers};delete headers['content-length'];delete headers['transfer-encoding'];await route.fulfill({status:r.statusCode,headers,body:r.rawPayload});return;
 }
 if(url.origin!==base){await route.abort();throw Error('External browser request forbidden');}await route.continue();
});
const started=Date.now(),chapter=title=>chapters.push({seconds:(Date.now()-started)/1000,title});
const pause=()=>page.waitForTimeout(3000),snap=name=>page.screenshot({path:join(out,name+'.png')});
try{
 await page.goto(base+'/#/login');await page.locator('#login').fill('inspector');await page.locator('#password').fill(process.env.INSPECTOR_DEMO_PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Новая проверка',exact:true}).waitFor();
 await page.getByRole('link',{name:'Матрица',exact:true}).click();await page.locator('#m-q').waitFor();
 chapter('Откройте Матрицу: справочник параметров и правил сравнения');await pause();await snap('references-matrix');
 await page.locator('#m-q').fill('M-023');assert.equal(await page.locator('button[data-code]').count(),1);
 chapter('Найдите M-023 по коду: класс конструктивной пожарной опасности');await pause();await snap('references-search');
 const passportResponse=page.waitForResponse(r=>r.url().includes('/api/v1/params/M-023/passport'));
 await page.locator('button[data-code="M-023"]').click();const passport=await passportResponse;assert.equal(passport.status(),200);const actual=await passport.json();assert(actual.passport);assert.match(actual.passport.basis,/123-ФЗ/);
 await page.locator('#param-passport').waitFor();
 chapter('Откройте паспорт параметра: описание, правило и нормативное основание');await pause();await snap('references-passport');
 await page.locator('#param-passport').getByText('Нормативное основание',{exact:true}).scrollIntoViewIfNeeded();
 assert.match(await page.locator('#param-passport').innerText(),/123-ФЗ/);
 chapter('В паспорте указаны основания; это справочная информация, а не проверка редакции закона');await pause();await snap('references-basis');
 const actsResponse=page.waitForResponse(r=>r.url().includes('/api/v1/legal-acts')&&r.status()===200);
 await page.getByRole('link',{name:'Нормы',exact:true}).click();await page.getByRole('heading',{name:'Нормативные документы',exact:true}).waitFor();await actsResponse;
 chapter('Откройте Нормы: документы, пределы, сроки действия и правовые акты');await pause();await snap('references-norms');
 assert(calls.some(c=>c.path==='/api/v1/normative'&&c.status===200));assert(calls.some(c=>c.path==='/api/v1/legal-acts'&&c.status===200));assert(!calls.some(c=>c.path==='/api/v1/normative/search'));
 assert.deepEqual(await counts(),before);assert.deepEqual(errors,[]);await Promise.all(assetTasks);assert(assets.length>0);
 const video=page.video();await context.close();const raw=await video.path(),videoPath=join(out,'references-walkthrough.webm');copyFileSync(raw,videoPath);
 const review=await browser.newContext();await review.route('**/*',route=>route.fulfill({status:200,contentType:'video/webm',body:readFileSync(videoPath)}));const player=await review.newPage();await player.setContent('<video muted src="http://docs-video.invalid/references.webm"></video>');await player.waitForFunction(()=>document.querySelector('video').readyState>=2);await player.evaluate(async()=>{const v=document.querySelector('video');v.playbackRate=8;await v.play()});await player.waitForFunction(()=>document.querySelector('video').ended);const decoded=await player.evaluate(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,error:v.error}});assert.equal(decoded.error,null);assert.equal(decoded.width,1440);assert.equal(decoded.height,1000);assert(Number.isFinite(decoded.duration));await review.close();
 const ffmpeg='/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux',frames=[];
 for(const [index,name] of [[1,'search'],[2,'passport'],[3,'basis'],[4,'norms']]){
  const seconds=Math.min(chapters[index].seconds+1,decoded.duration-0.2),path=join(out,'decoded-'+name+'.png');execFileSync(ffmpeg,['-v','error','-ss',String(seconds),'-i',videoPath,'-frames:v','1','-y',path]);frames.push({seconds,file:'decoded-'+name+'.png',sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
 }
 const stamp=t=>{const n=Math.round(t*1000);return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')}.${String(n%1000).padStart(3,'0')}`};
 writeFileSync(join(out,'references-walkthrough.vtt'),'WEBVTT\n\n'+chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(Math.min(chapters[i+1]?.seconds??decoded.duration,decoded.duration))}\n${c.title}\n`).join('\n'));
 writeFileSync(join(out,'references-transcript.txt'),chapters.map(c=>stamp(c.seconds)+' '+c.title).join('\n')+'\n');
 writeFileSync(join(out,'provenance.json'),JSON.stringify({schema:'docs-scenario.v1',scenario_id:'references-param-passport-basis',role:'inspector',fixture_id:'isolated-public-reference-seed',api_revision:revision,source_web_image:'e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a',ui_source_parity:'not claimed: deployed overlay; actual asset hashes',ui_asset_hashes:assets,health_revision:health.revision,data:'Public reference seed in isolated memory database; no private documents',production_api_calls:0,production_writes:0,fixture_api_calls:calls.length,check_id:'M-023-passport-basis',outcome:'Parameter found; actual passport and basis opened; normative list viewed; domain DB unchanged',validated:['parameter_filter','real_passport_response','passport_basis_123FZ','normative_list','legal_acts','no_domain_mutations','full_video_playback'],not_demonstrated:['normative_search: no search control in deployed Normative UI','legal edition verification'],db_counts:before,duration_seconds:decoded.duration,chapters,video_review:{...decoded,frames},page_errors:errors,recorded_at:new Date().toISOString()},null,2)+'\n');console.log(JSON.stringify({captured:true,production_writes:0,duration:decoded.duration,frames}));
}catch(e){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));throw e;}
finally{await browser.close();await app.close();await db.close();}
