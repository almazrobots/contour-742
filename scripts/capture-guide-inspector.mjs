// Capture authentic deployed web assets with every API call served by isolated buildApp.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('--review-video')){
 const media=readFileSync('out/inspector-media/inspector-walkthrough.webm'),review=resolve('out/inspector-review');mkdirSync(review,{recursive:true});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>{
   if(route.request().url()!=='http://docs-media.invalid/video.webm')return route.abort();
   const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
   if(range){const from=Number(range[1]),to=range[2]?Math.min(Number(range[2]),media.length-1):media.length-1;return route.fulfill({status:206,contentType:'video/webm',headers:{'accept-ranges':'bytes','content-range':`bytes ${from}-${to}/${media.length}`},body:media.subarray(from,to+1)});}
   return route.fulfill({status:200,contentType:'video/webm',headers:{'accept-ranges':'bytes'},body:media});
  });
  const page=await context.newPage();await page.setContent('<style>body{margin:0}video{width:1440px;height:1000px}</style><video muted preload="auto" src="http://docs-media.invalid/video.webm"></video>');
  await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
  const info=await page.evaluate(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,buffered_end:v.buffered.length?v.buffered.end(v.buffered.length-1):null}});
  assert.equal(info.width,1440);assert.equal(info.height,1000);
  for(const [at,name] of [[4,'evidence'],[15,'undo'],[21,'finalized']]){
   await page.evaluate(at=>new Promise((resolve,reject)=>{const v=document.querySelector('video');v.addEventListener('seeked',()=>{v.requestVideoFrameCallback(()=>resolve());v.play().catch(reject)},{once:true});v.addEventListener('error',()=>reject(Error('Video decode error')),{once:true});v.currentTime=at}),at);
   await page.evaluate(()=>document.querySelector('video').pause());
   await page.screenshot({path:join(review,'video-'+name+'.png')});
  }
  await page.evaluate(async()=>{const v=document.querySelector('video');v.currentTime=0;v.playbackRate=8;await v.play();});
  await page.waitForFunction(()=>document.querySelector('video').ended,{timeout:20000});
  assert.equal(await page.evaluate(()=>document.querySelector('video').error),null);
  info.playback='complete without decoder error';info.duration=await page.evaluate(()=>document.querySelector('video').duration);
  const ffmpeg=process.env.DOCS_FFMPEG || '/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux';
  info.decoded_frames=[];
  for(const [seconds,name] of [[4,'evidence'],[15,'undo'],[21,'finalized']]){
   const path=join(review,'decoded-'+name+'.png');execFileSync(ffmpeg,['-v','error','-ss',String(seconds),'-i','out/inspector-media/inspector-walkthrough.webm','-frames:v','1','-y',path]);
   info.decoded_frames.push({seconds,file:'decoded-'+name+'.png',sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
  }
  assert(Number.isFinite(info.duration)&&info.duration>21);
  const provenancePath='out/inspector-media/provenance.json',provenance=JSON.parse(readFileSync(provenancePath,'utf8'));
  provenance.capture_wall_clock_seconds??=provenance.duration_seconds;provenance.duration_seconds=info.duration;provenance.video_review=info;
  writeFileSync(provenancePath,JSON.stringify(provenance,null,2)+'\n');
  const stamp=t=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`};
  writeFileSync('out/inspector-media/inspector-walkthrough.vtt','WEBVTT\n\n'+provenance.chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(Math.min(provenance.chapters[i+1]?.seconds??info.duration,info.duration))}\n${c.title}\n`).join('\n'));
  writeFileSync(join(review,'video-review.json'),JSON.stringify(info,null,2)+'\n');console.log(JSON.stringify(info));await context.close();
 }finally{await browser.close();}
 process.exit(0);
}
const apiRevision='c0851cc7b78e28e7bd7a477be2d3274010d42144';
const webImage='e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a';
const source=process.env.DOCS_API_SOURCE,out=resolve('out/inspector-media');
assert(source && readFileSync(join(source,'PINNED-REVISION'),'utf8').trim()===apiRevision);
assert(process.env.INSPECTOR_BLOB_DIR?.startsWith('/tmp/nadzorium-inspector-blobs-'));
mkdirSync(out,{recursive:true});
Object.assign(process.env,{INSPECTOR_PROFILE:'dev',INSPECTOR_BLOB_STORE:'fs',INSPECTOR_DEMO_PASSWORD:'docs-synthetic-inspector-20260929',INSPECTOR_ML_URL:'http://127.0.0.1:9',INSPECTOR_RIN_URL:'http://127.0.0.1:9'});
delete process.env.INSPECTOR_BLOB_KEY_FILE;delete process.env.INSPECTOR_BLOB_OLD_KEYS_FILE;
globalThis.fetch=async()=>{throw Error('Outbound fixture transport forbidden');};
const {openDb}=await import(pathToFileURL(join(source,'apps/api/src/db.ts')));
const {buildApp}=await import(pathToFileURL(join(source,'apps/api/src/app.ts')));
const {blobStore}=await import(pathToFileURL(join(source,'apps/api/src/services/blobstore.ts')));
const db=await openDb('memory'),app=buildApp(db);await app.ready();
const at=new Date().toISOString(),inspection='DOCS-INSPECTION-01',check='DOCS-CHECK-01';
await db.run("insert into objects(id,name,profile_json,created_at) values('DOCS-OBJECT-01','Учебный объект — проверка этажности','{}',$1)",[at]);
await db.run("insert into inspections(id,object_id,status,protocol_version,scenario,created_at,updated_at) values($1,'DOCS-OBJECT-01','READY',1,'FULL',$2,$2)",[inspection,at]);
const originals=[];
for(const stage of ['PD','RD']){
 const bytes=readFileSync('out/inspector-fixture/'+stage+'.pdf'),sha=createHash('sha256').update(bytes).digest('hex'),id='DOCS-FILE-'+stage;
 await blobStore().put(sha,bytes);originals.push({id,stage,sha,bytes:bytes.length});
 await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,parse_status,revision_role,pages_json,uploaded_at)
 values($1,$2,'DOCS-OBJECT-01',$1,$3,$4,$5,'pdf',$6,$7,'1','DONE','CURRENT',$8,$9)`,[id,inspection,'Учебный пример — '+stage+'.pdf',sha,bytes.length,stage,'DEMO-'+stage,JSON.stringify([{page:1,width:900,height:600}]),at]);
}
await db.run(`insert into checks(id,inspection_id,param_code,evidence_group_id,finding_status,verification_status,expected_value,actual_value,review_priority,reason,computed_in_version,created_at,updated_at)
 values($1,$2,'M-007','DOCS-EVIDENCE-01','CANDIDATE','PENDING','11','12','MEDIUM','Заранее подготовленное учебное расхождение ПД и РД; OCR не запускался',1,$3,$3)`,[check,inspection,at]);
for(const f of originals)await db.run(`insert into evidence_fragments(check_id,file_id,sha256,stage,document_code,revision,sheet_page,extracted_value,role_expected_actual)
 values($1,$2,$3,$4,$5,'1',1,$6,$7)`,[check,f.id,f.sha,f.stage,'DEMO-'+f.stage,f.stage==='PD'?'11':'12',f.stage==='PD'?'expected':'actual']);
const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{login:'inspector',password:process.env.INSPECTOR_DEMO_PASSWORD}});assert.equal(login.statusCode,200);
const token=login.json().token,headers={authorization:'Bearer '+token};
const premature=await app.inject({method:'POST',url:`/api/v1/inspection/${inspection}/finalize`,headers,payload:{}});assert.equal(premature.statusCode,409);
const inspector=await db.get("select id from users where login='inspector'");
const base='https://127.0.0.1:46443';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1440,height:1000},recordVideo:{dir:join(out,'raw'),size:{width:1440,height:1000}}});
const health=await(await context.request.get(base+'/health')).json();assert.equal(health.revision,apiRevision);
const page=await context.newPage(),errors=[],calls=[],assets=[],chapters=[];
page.on('pageerror',e=>errors.push(e.message));
const assetTasks=[];
page.on('response',r=>{if(/\.(js|css)(?:\?|$)/.test(r.url()))assetTasks.push((async()=>{const bytes=await r.body();assets.push({path:new URL(r.url()).pathname,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});})());});
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());
 if(u.pathname.includes('/api/')){
  const r=await app.inject({method:req.method(),url:u.pathname+u.search,headers:{...req.headers(),host:'localhost'},...(req.postData()?{payload:req.postData()}: {})});
  calls.push({method:req.method(),path:u.pathname,status:r.statusCode,at:Date.now()});
  const h={...r.headers};delete h['content-length'];delete h['transfer-encoding'];await route.fulfill({status:r.statusCode,headers:h,body:r.rawPayload});return;
 }
 if(u.origin!==base){await route.abort();throw Error('Unexpected outbound browser request: '+u.origin);}
 await route.continue();
});
const start=Date.now(),chapter=title=>chapters.push({seconds:(Date.now()-start)/1000,title});
const pause=()=>page.waitForTimeout(2800);
const snap=name=>page.screenshot({path:join(out,name+'.png')});
try{
 await page.goto(base+'/#/login');await page.locator('#login').fill('inspector');await page.locator('#password').fill(process.env.INSPECTOR_DEMO_PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByText('Учебный объект — проверка этажности',{exact:true}).waitFor();
 await page.goto(base+'/#/inspections/'+inspection);await page.getByRole('button',{name:/Карточки кандидатов|Верифицировать/}).waitFor();
 chapter('Учебная проверка: заранее подготовленные результаты, один кандидат');await pause();await snap('inspector-overview');
 const pdfResponses=originals.map(f=>page.waitForResponse(r=>r.url().includes(`/api/v1/files/${f.id}/content`)));
 await page.getByRole('button',{name:/Карточки кандидатов|Верифицировать/}).click();
 for(const response of await Promise.all(pdfResponses)){assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/application\/pdf/);await response.finished();}
 await page.locator('canvas').nth(1).waitFor({state:'visible'});
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].filter(c=>c.width>100&&c.height>100).length>=2);
 for(const f of originals)assert(calls.some(c=>c.path===`/api/v1/files/${f.id}/content`&&c.status===200));
 chapter('Сравните настоящие учебные PDF: в ПД 11 этажей, в РД 12');await pause();await snap('inspector-evidence');
 const decisionResponse=page.waitForResponse(r=>r.url().endsWith(`/api/v1/checks/${check}/decision`)&&r.request().method()==='POST');
 await page.getByRole('button',{name:/Признать/}).click();assert.equal((await decisionResponse).status(),200);
 await page.getByText('Все кандидаты обработаны — к сводке сверки').waitFor();
 const decisions=await db.all('select * from decisions where check_id=$1 and not superseded',[check]);assert.equal(decisions.length,1);assert.equal(decisions[0].action,'confirm');assert.equal(decisions[0].user_id,inspector.id);
 assert.equal((await db.get('select verification_status from checks where id=$1',[check])).verification_status,'CONFIRMED_VIOLATION');
 assert.equal((await db.get('select status from inspections where id=$1',[inspection])).status,'COMPLETED');
 assert((await db.all("select action from audit_log where object_id=$1 and action like 'DECISION_%'",[check])).length>=1);
 chapter('Признать: решение сохранено настоящим API в отдельной учебной базе');await pause();await snap('inspector-decision');
 await page.goto(base+'/#/inspections/'+inspection);await page.getByRole('button',{name:'Завершить',exact:true}).waitFor();
 chapter('Завершите сводку: доступно настоящее десятисекундное окно отмены');const finalizeStarted=Date.now();await page.getByRole('button',{name:'Завершить',exact:true}).click();
 await page.waitForResponse(r=>r.url().endsWith(`/api/v1/inspection/${inspection}/finalize`)&&r.request().method()==='POST',{timeout:25000});
 const finalizeCall=calls.find(c=>c.path===`/api/v1/inspection/${inspection}/finalize`);assert.equal(finalizeCall.status,200);assert(finalizeCall.at-finalizeStarted>=9500);
 const finalized=await db.get('select status,finalized_at,sync_status from inspections where id=$1',[inspection]);assert.equal(finalized.status,'FINALIZED');assert(finalized.finalized_at);assert.equal(finalized.sync_status,'PENDING_SYNC');
 assert.equal((await db.get('select status from protocols where inspection_id=$1 order by version desc limit 1',[inspection])).status,'FINALIZED');
 assert.equal((await db.get('select status from sync_jobs where inspection_id=$1',[inspection])).status,'PENDING_SYNC');
 assert(await db.get("select action from audit_log where object_id=$1 and action='PROTOCOL_FINALIZED'",[inspection]));
 const locked=await app.inject({method:'POST',url:`/api/v1/checks/${check}/decision`,headers,payload:{action:'confirm'}});assert.equal(locked.statusCode,409);
 chapter('Сводка завершена; передача в РиН ожидается и в этом видео не выполняется');await pause();await snap('inspector-finalized');
 assert.deepEqual(errors,[]);await Promise.all(assetTasks);assert(assets.length>0);
 const video=page.video();await context.close();copyFileSync(await video.path(),join(out,'inspector-walkthrough.webm'));
 const duration=(Date.now()-start)/1000,stamp=t=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`};
 writeFileSync(join(out,'inspector-walkthrough.vtt'),'WEBVTT\n\n'+chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(chapters[i+1]?.seconds??duration)}\n${c.title}\n`).join('\n'));
 writeFileSync(join(out,'inspector-transcript.txt'),chapters.map(c=>stamp(c.seconds)+' '+c.title).join('\n')+'\n');
 writeFileSync(join(out,'provenance.json'),JSON.stringify({schema:'docs-scenario.v1',scenario_id:'inspector-decision-finalize',role:'inspector',fixture_id:'synthetic-pd11-rd12',api_revision:apiRevision,source_web_image:webImage,ui_source_parity:'not claimed: deployed overlay; asset hashes recorded',ui_asset_hashes:assets,health_revision:health.revision,data:'Synthetic PDFs and precomputed candidate; no OCR/ML demonstration',production_api_calls:0,production_writes:0,fixture_api_calls:calls.length,check_id:check,outcome:'CONFIRMED_VIOLATION; FINALIZED; PENDING_SYNC',validated:['premature_finalize_409','two_pdf_originals','decision_user','decision_audit','COMPLETED','real_10sec_undo','protocol_FINALIZED','sync_PENDING_SYNC','decision_after_finalize_409'],originals,finalize_wait_ms:finalizeCall.at-finalizeStarted,duration_seconds:duration,chapters,page_errors:errors,recorded_at:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify({captured:true,production_writes:0,fixture_decisions:decisions.length,duration_seconds:duration}));
}catch(e){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));throw e;}
finally{await browser.close();await app.close();await db.close();}
