// Real multipart UI upload and own CPU text-layer parser; never seeds parsing results.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const revision='c0851cc7b78e28e7bd7a477be2d3274010d42144',source=process.env.DOCS_API_SOURCE,mlUrl=process.env.INSPECTOR_ML_URL;
assert(source&&readFileSync(join(source,'PINNED-REVISION'),'utf8').trim()===revision);
assert(process.env.INSPECTOR_BLOB_DIR?.startsWith('/tmp/nadzorium-upload-blobs-'));
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(mlUrl||''));
Object.assign(process.env,{INSPECTOR_PROFILE:'dev',INSPECTOR_QUEUE:'inproc',INSPECTOR_AV:'off',INSPECTOR_BLOB_STORE:'fs',INSPECTOR_DEMO_PASSWORD:'docs-upload-fixture-20260929',INSPECTOR_RIN_URL:'http://127.0.0.1:9'});
delete process.env.INSPECTOR_BLOB_KEY_FILE;delete process.env.INSPECTOR_BLOB_OLD_KEYS_FILE;
const mlCalls=[],realFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));assert.equal(url.origin,mlUrl,'Only private loopback ML may be contacted');const r=await realFetch(input,options);mlCalls.push({method:options?.method??'GET',path:url.pathname,status:r.status});return r;};
const mlHealth=JSON.parse(readFileSync('out/upload-media/ml-health.json','utf8'));assert.equal(mlHealth.profile,'dev');assert.equal(mlHealth.llm,'none');assert.equal(mlHealth.revision,revision);
const {openDb}=await import(pathToFileURL(join(source,'apps/api/src/db.ts')));
const {buildApp}=await import(pathToFileURL(join(source,'apps/api/src/app.ts')));
const {parseQueue}=await import(pathToFileURL(join(source,'apps/api/src/services/inspections.ts')));
const db=await openDb('memory'),app=buildApp(db);await app.ready();
assert.equal((await db.get('select count(*)::int n from files')).n,0);
const out=resolve('out/upload-media'),pdf=readFileSync(join(out,'DEMO-PD.pdf')),pdfSha=createHash('sha256').update(pdf).digest('hex');mkdirSync(out,{recursive:true});
const base='https://127.0.0.1:46443',browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1440,height:1000},recordVideo:{dir:join(out,'raw'),size:{width:1440,height:1000}}});
const health=await(await context.request.get(base+'/health')).json();assert.equal(health.revision,revision);
const page=await context.newPage(),calls=[],errors=[],assets=[],tasks=[],chapters=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(/\.(js|css)(?:\?|$)/.test(r.url()))tasks.push((async()=>{const b=await r.body();assets.push({path:new URL(r.url()).pathname,sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length})})());});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.pathname.includes('/api/')){
  const payload=req.postDataBuffer();
  const r=await app.inject({method:req.method(),url:url.pathname+url.search,headers:{...req.headers(),host:'localhost'},...(payload?{payload}: {})});
  calls.push({method:req.method(),path:url.pathname,status:r.statusCode});const headers={...r.headers};delete headers['content-length'];delete headers['transfer-encoding'];await route.fulfill({status:r.statusCode,headers,body:r.rawPayload});return;
 }
 if(url.origin!==base){await route.abort();throw Error('External browser request forbidden');}await route.continue();
});
const started=Date.now(),chapter=title=>chapters.push({seconds:(Date.now()-started)/1000,title}),pause=()=>page.waitForTimeout(3000),snap=name=>page.screenshot({path:join(out,name+'.png')});
try{
 await page.goto(base+'/#/login');await page.locator('#login').fill('inspector');await page.locator('#password').fill(process.env.INSPECTOR_DEMO_PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Новая проверка',exact:true}).waitFor();
 await page.getByRole('link',{name:'Загрузка',exact:true}).click();await page.locator('#card-object_id').fill('DOCS-UPLOAD-01');await page.locator('#card-name').fill('Учебный объект — загрузка и разбор');await page.locator('#card-address').fill('Синтетический учебный адрес');
 await page.locator('#files').setInputFiles({name:'DEMO-PD.pdf',mimeType:'application/pdf',buffer:pdf});
 if(process.env.DOCS_UPLOAD_MANIFEST==='1'){
  const manifest={files:[{file_id:'DEMO-PD-1',file_name:'DEMO-PD.pdf',sha256:pdfSha,doc_stage:'PD',discipline:'ПЗ',document_code:'DEMO-PD',revision:'1',approval_status:'APPROVED',approval_date:'2026-09-29'}]};
  await page.locator('#files').setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
 }
 chapter('Добавьте учебный PDF с текстовым слоем и заполните карточку объекта');await pause();await snap('upload-form');
 const response=page.waitForResponse(r=>r.url().includes('/api/v1/documents/upload')&&r.request().method()==='POST');await page.getByRole('button',{name:'Загрузить и начать проверку',exact:true}).click();const received=await response;assert.equal(received.status(),202);const accepted=await received.json();assert.equal(accepted.accepted.length,1);assert.equal(accepted.rejected.length,0);assert.equal(accepted.accepted[0].sha256,pdfSha);
 chapter('Пакет принят настоящим API; начат отдельный CPU-разбор учебного PDF');await pause();await snap('upload-accepted');
 let parseTimer;try{await Promise.race([parseQueue(db).idle(),new Promise((_,reject)=>{parseTimer=setTimeout(()=>reject(Error('Private parser timeout')),60000)})]);}finally{clearTimeout(parseTimer);}
 const f=await db.get('select id,parse_status,parse_error,engine,ml_revision,pages_json from files where inspection_id=$1',[accepted.process_id]);assert.equal(f.parse_status,'DONE',f.parse_error||'Actual ML parse did not finish');assert(f.engine);assert.equal(f.ml_revision,mlHealth.ml_revision);assert(JSON.parse(f.pages_json).length===1);
 if(process.env.DOCS_UPLOAD_MANIFEST==='1'){
  const metadata=await db.get('select doc_stage,revision,approval_status,revision_role from files where id=$1',[f.id]);
  assert.equal(metadata.doc_stage,'PD');assert.equal(metadata.revision,'1');assert.equal(metadata.approval_status,'APPROVED');assert.equal(metadata.revision_role,'CURRENT');
  writeFileSync(join(out,'manifest-validation.json'),JSON.stringify({validated:true,metadata,synthetic:true,production_writes:0},null,2));
 }
 const extracted=await db.all('select param_code,raw,value_num,value_text,page from extractions where file_id=$1',[f.id]);
 assert(mlCalls.some(c=>c.path==='/analyze'&&c.status===200));assert(await db.get("select action from audit_log where object_id=$1 and action='FILES_UPLOADED'",[accepted.process_id]));
 await page.getByRole('button',{name:'Открыть проверку',exact:true}).click();await page.getByRole('button',{name:/^Документы/}).click();await page.getByText('DEMO-PD.pdf',{exact:false}).first().waitFor();
 chapter('Откройте Документы: статус обработки получен от настоящего Python ML');await pause();await snap('upload-documents');
 // Sheet may prefetch/cache the original while the documents table is opening.
 // Opening the row must not require a second network response for the same PDF.
 await page.getByText('DEMO-PD.pdf',{exact:false}).first().click();await page.locator('canvas').first().waitFor({state:'visible'});
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(c=>c.width>100&&c.height>100));
 assert(calls.some(c=>c.path===`/api/v1/files/${f.id}/content`&&c.status===200));
 // Original retrieval uses the authenticated browser and the actual session token.
 const browserOriginal=await page.evaluate(async id=>{const key=Object.keys(sessionStorage).find(k=>{try{return Boolean(JSON.parse(sessionStorage.getItem(k)).token)}catch{return false}});const token=JSON.parse(sessionStorage.getItem(key)).token;const r=await fetch('/api/v1/files/'+id+'/content',{headers:{authorization:'Bearer '+token}});return {status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}},f.id);assert.equal(browserOriginal.status,200);assert.equal(createHash('sha256').update(Buffer.from(browserOriginal.bytes)).digest('hex'),pdfSha);
 chapter(extracted.length?'Оригинал доступен; значения действительно извлечены из учебного текстового слоя':'Оригинал доступен; извлечённых параметров в этом учебном примере нет');await pause();await snap('upload-original');

 if(process.env.DOCS_UPLOAD_SUPPLEMENT==='1'){
  await page.goto(base+'/#/inspections/'+accepted.process_id);
  await page.getByRole('button',{name:'Дозагрузить',exact:true}).click();
  const more=readFileSync(join(out,'DEMO-RD.pdf'));
  await page.locator('#files').setInputFiles({name:'DEMO-RD.pdf',mimeType:'application/pdf',buffer:more});
  chapter('Дозагрузка: проверьте номер существующей проверки, добавьте новый PDF');await pause();await snap('supplement-form');
  const next=page.waitForResponse(r=>r.url().includes('/api/v1/documents/upload')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Дозагрузить и пересчитать',exact:true}).click();
  const rr=await next;assert.equal(rr.status(),202);const result=await rr.json();
  assert.equal(result.process_id,accepted.process_id);assert.equal(result.accepted.length,1);assert.equal(result.rejected.length,0);
  let timer;try{await Promise.race([parseQueue(db).idle(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Supplement timeout')),60000)})]);}finally{clearTimeout(timer);}
  const files=await db.all('select id,parse_status,sha256 from files where inspection_id=$1',[accepted.process_id]);
  assert.equal(files.length,2);assert(files.every(x=>x.parse_status==='DONE'));assert(files.some(x=>x.id===f.id));assert(files.some(x=>x.sha256===createHash('sha256').update(more).digest('hex')));
  await page.getByRole('button',{name:'Открыть проверку',exact:true}).click();
  await page.getByRole('button',{name:/^Документы/}).click();
  await page.getByText('DEMO-RD.pdf',{exact:false}).first().waitFor();
  chapter('В прежней проверке два документа; оба обработаны отдельным CPU-парсером');await pause();await snap('supplement-result');
 }
 assert.deepEqual(errors,[]);await Promise.all(tasks);const video=page.video();await context.close();const videoPath=join(out,'upload-walkthrough.webm');copyFileSync(await video.path(),videoPath);
 const review=await browser.newContext();await review.route('**/*',route=>route.fulfill({status:200,contentType:'video/webm',body:readFileSync(videoPath)}));const player=await review.newPage();await player.setContent('<video muted src="http://docs-video.invalid/upload.webm"></video>');await player.waitForFunction(()=>document.querySelector('video').readyState>=2);await player.evaluate(async()=>{const v=document.querySelector('video');v.playbackRate=8;await v.play()});await player.waitForFunction(()=>document.querySelector('video').ended);const decoded=await player.evaluate(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,error:v.error}});assert.equal(decoded.error,null);assert(Number.isFinite(decoded.duration));await review.close();
 const frames=[];for(const [index,name] of [[0,'form'],[1,'accepted'],[2,'documents'],[3,'original']]){const seconds=Math.min(chapters[index].seconds+1,decoded.duration-0.2),path=join(out,'decoded-'+name+'.png');execFileSync('/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux',['-v','error','-ss',String(seconds),'-i',videoPath,'-frames:v','1','-y',path]);frames.push({seconds,file:'decoded-'+name+'.png',sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}
 const stamp=t=>{const n=Math.round(t*1000);return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')}.${String(n%1000).padStart(3,'0')}`};writeFileSync(join(out,'upload-walkthrough.vtt'),'WEBVTT\n\n'+chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(Math.min(chapters[i+1]?.seconds??decoded.duration,decoded.duration))}\n${c.title}\n`).join('\n'));writeFileSync(join(out,'upload-transcript.txt'),chapters.map(c=>stamp(c.seconds)+' '+c.title).join('\n')+'\n');
 writeFileSync(join(out,'provenance.json'),JSON.stringify({schema:'docs-scenario.v1',scenario_id:process.env.DOCS_UPLOAD_SUPPLEMENT==='1'?'upload-and-supplement-real-cpu':'upload-real-cpu-textlayer-documents',role:'inspector',fixture_id:'synthetic-textlayer-pdf-real-parser',api_revision:revision,source_web_image:'e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a',ui_source_parity:'not claimed: deployed overlay; asset hashes',ui_asset_hashes:assets,health_revision:health.revision,ml_health:mlHealth,ml_calls:mlCalls,production_api_calls:0,production_writes:0,data:'Generated text-layer PDF; real private CPU parser; no seeded DONE/results',not_demonstrated:['scan OCR','GPU parser parity','LLM/VLM','production antivirus','external RIN'],fixture_api_calls:calls.length,check_id:f.id,outcome:'Actual upload202; parserDONE; original SHA verified',parsed_file:f,extractions:extracted,pdf_sha256:pdfSha,duration_seconds:decoded.duration,chapters,video_review:{...decoded,frames},page_errors:errors,recorded_at:new Date().toISOString()},null,2)+'\n');console.log(JSON.stringify({captured:true,DONE:true,extractions:extracted.length,duration:decoded.duration}));
}catch(e){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));throw e;}
finally{await browser.close();await app.close();await db.close();}
