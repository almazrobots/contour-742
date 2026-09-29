// Deployed assets, pinned real CPU ranking API, synthetic memory DB; no GPU or production mutations.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const apiRevision='c0851cc7b78e28e7bd7a477be2d3274010d42144',source=process.env.DOCS_API_SOURCE,out=resolve('out/models-media');
assert(source&&readFileSync(join(source,'PINNED-REVISION'),'utf8').trim()===apiRevision);
assert(process.env.INSPECTOR_BLOB_DIR?.startsWith('/tmp/nadzorium-models-blobs-'));
mkdirSync(out,{recursive:true});
const password='docs-models-synthetic-20260929';
Object.assign(process.env,{INSPECTOR_PROFILE:'dev',INSPECTOR_QUEUE:'inproc',INSPECTOR_AV:'off',INSPECTOR_BLOB_STORE:'fs',INSPECTOR_DEMO_PASSWORD:password,INSPECTOR_ML_URL:'http://127.0.0.1:9',INSPECTOR_RIN_URL:'http://127.0.0.1:9'});
delete process.env.INSPECTOR_BLOB_KEY_FILE;delete process.env.INSPECTOR_BLOB_OLD_KEYS_FILE;
globalThis.fetch=async()=>{throw Error('Fixture outbound transport forbidden');};
const {openDb}=await import(pathToFileURL(join(source,'apps/api/src/db.ts')));
const {buildApp}=await import(pathToFileURL(join(source,'apps/api/src/app.ts')));
const now=()=>new Date().toISOString(),N_OBJECTS=80;
async function seedFinalized(db){

  await db.tx(async (t) => {
    for (let i = 0; i < N_OBJECTS; i++) {
      const o = `RT-OBJ-${i}`;
      await t.run("insert into objects (id, name, profile_json, created_at) values ($1,$2,$3,$4)", [o, `Объект ${i}`, "{}", now()]);
      await t.run("insert into inspections (id, object_id, status, protocol_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)", [`RT-P-${i}`, o, "FINALIZED", 1, now(), now()]);
      const cases = [["pos", i % 2 ? "M-004" : "M-003", "CONFIRMED_VIOLATION", 30 + (i % 31)], ["neg", i % 2 ? "M-003" : "M-004", "NEGATIVE_VERIFIED", i % 3]];
      for (const [kind, code, vs, dev] of cases) {
        const id = `RT-${kind}-${i}`;
        await t.run(`insert into checks (id, inspection_id, param_code, evidence_group_id, finding_status, verification_status, expected_value, actual_value, delta,
            review_priority, computed_in_version, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, `RT-P-${i}`, code, `${o}:${code}`, "CANDIDATE", vs, "100", String(100 + dev), `+${dev}`, "HIGH", 1, now(), now()]);
        const frag = "insert into evidence_fragments (check_id, file_id, stage, sheet_page, bbox_polygon_norm) values ($1,$2,$3,$4,$5)";
        await t.run(frag, [id, `RT-F-${i}-PD`, "PD", 1, "[0.1,0.1,0.2,0.2]"]);
        await t.run(frag, [id, `RT-F-${i}-RD`, "RD", 2, "[0.1,0.1,0.2,0.2]"]);
        await t.run("insert into decisions (check_id, user_id, action, status, reason_code, created_at) values ($1,$2,$3,$4,$5,$6)",
          [id, "u-insp", kind === "pos" ? "confirm" : "reject", vs, kind === "pos" ? null : "OCR_ERROR", now()]);
      }
    }
  });
}
async function fixture(){const db=await openDb('memory'),app=buildApp(db);await app.ready();await seedFinalized(db);return {db,app};}
async function loginApi(app,login){const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{login,password}});assert.equal(r.statusCode,200);return r.json().token;}
async function smoke(){
 const {db,app}=await fixture();try{
  const curator=await loginApi(app,'curator'),ml=await loginApi(app,'ml'),admin=await loginApi(app,'admin');
  const call=(url,token,payload)=>app.inject({method:'POST',url,headers:{authorization:'Bearer '+token},...(payload?{payload}:{})});
  const release=await call('/api/v1/ml/gold/release',curator);assert.equal(release.statusCode,200);const ds=release.json();assert.equal(ds.items,160);
  const train=await call('/api/v1/ml/models/train',ml,{dataset_version:ds.dataset_version});assert.equal(train.statusCode,201);const result=train.json();assert(result.model_version&&result.metrics&&result.gate);
  assert(await db.get("select action from audit_log where action='DATASET_RELEASED'"));assert(await db.get("select action from audit_log where action='MODEL_TRAINED'"));
  const forbidden=await call('/api/v1/ml/models/train',curator,{dataset_version:ds.dataset_version});assert.equal(forbidden.statusCode,403);
  if(result.gate.ok){const approve=await call('/api/v1/ml/models/'+result.model_version+'/approve',admin);assert.equal(approve.statusCode,200);}
  const info={passed:true,dataset_items:ds.items,train_status:train.statusCode,gate:result.gate,metrics:result.metrics,curator_train_status:403};writeFileSync(join(out,'api-smoke.json'),JSON.stringify(info,null,2)+'\n');return info;
 }finally{await app.close();await db.close();}
}
const smokeResult=await smoke();console.log(JSON.stringify({smoke:true,gate:smokeResult.gate}));
const {db,app}=await fixture(),base='https://127.0.0.1:46443';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1440,height:1000},recordVideo:{dir:join(out,'raw'),size:{width:1440,height:1000}}});
const health=await(await context.request.get(base+'/health')).json();assert.equal(health.revision,apiRevision);
const page=await context.newPage(),calls=[],errors=[],assets=[],assetTasks=[],chapters=[];
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(/\.(js|css)(?:\?|$)/.test(r.url()))assetTasks.push((async()=>{const b=await r.body();assets.push({path:new URL(r.url()).pathname,sha256:createHash('sha256').update(b).digest('hex')});})());});
await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.pathname.includes('/api/')){const r=await app.inject({method:req.method(),url:u.pathname+u.search,headers:{...req.headers(),host:'localhost'},...(req.postData()?{payload:req.postData()}:{})});calls.push({method:req.method(),path:u.pathname,status:r.statusCode});const h={...r.headers};delete h['content-length'];delete h['transfer-encoding'];return route.fulfill({status:r.statusCode,headers:h,body:r.rawPayload});}if(u.origin!==base){await route.abort();throw Error('Unexpected outbound request');}await route.continue();});
const start=Date.now(),chapter=title=>chapters.push({seconds:(Date.now()-start)/1000,title}),pause=()=>page.waitForTimeout(3000),snap=name=>page.screenshot({path:join(out,name+'.png')});
async function enter(login){await page.goto(base+'/#/login');await page.locator('#login').fill(login);await page.locator('#password').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Выйти',exact:true}).waitFor();await page.goto(base+'/#/ml');await page.getByRole('heading',{name:'Черновик GOLD',exact:true}).waitFor();}
async function exit(){await page.getByRole('link',{name:'Выйти',exact:true}).click();await page.locator('#login').waitFor();}
let releaseResult,trainResult;
try{
 await enter('curator');await page.getByRole('button',{name:'Выпустить версию',exact:true}).waitFor();
 chapter('Куратор: GOLD из заранее подготовленных синтетических решений; OCR не демонстрируется');await pause();await snap('models-gold-preview');
 const releaseResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ml/gold/release')&&r.request().method()==='POST');await page.getByRole('button',{name:'Выпустить версию',exact:true}).click();const released=await releaseResponse;assert.equal(released.status(),200);releaseResult=await released.json();assert.equal(releaseResult.items,160);await page.getByText(releaseResult.dataset_version,{exact:true}).waitFor();
 chapter('Версия GOLD выпущена настоящим API; сохранены 160 учебных меток');await pause();await snap('models-gold-released');await exit();await enter('ml');
 const row=page.getByRole('row').filter({has:page.getByText(releaseResult.dataset_version,{exact:true})});
 chapter('ML-инженер: Дообучить запускает CPU-ранжирование, не обучение LLM');await pause();
 const trainResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ml/models/train')&&r.request().method()==='POST');await row.getByRole('button',{name:'Дообучить',exact:true}).click();const trained=await trainResponse;assert.equal(trained.status(),201);trainResult=await trained.json();await page.getByText(trainResult.model_version,{exact:true}).waitFor();
 chapter(trainResult.gate.ok?'CPU-модель рассчитала метрики учебной выборки и прошла ворота; публикация отдельно':'Модель не прошла ворота: '+trainResult.gate.reasons.join('; '));await pause();await snap('models-training-gate');
 await exit();await enter('admin');
 if(trainResult.gate.ok){const approvedResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ml/models/'+trainResult.model_version+'/approve')&&r.request().method()==='POST');await page.getByRole('button',{name:'Подписать публикацию',exact:true}).click();assert.equal((await approvedResponse).status(),200);await page.getByText('PUBLISHED',{exact:true}).waitFor();chapter('Администратор подписал публикацию только в отдельной учебной базе');await pause();await snap('models-published');}
 await page.getByRole('link',{name:'Журнал',exact:true}).click();await page.locator('#a-action').selectOption('DATASET_RELEASED');await page.getByRole('cell',{name:'DATASET_RELEASED',exact:true}).waitFor();chapter('Журнал: реальное событие выпуска GOLD, его автор и версия');await pause();await snap('models-audit');
 const trainedRow=await db.get('select approval_status,metrics_json from model_versions where model_version=$1',[trainResult.model_version]);assert.deepEqual(JSON.parse(trainedRow.metrics_json),trainResult.metrics);assert.equal(trainedRow.approval_status,trainResult.gate.ok?'PUBLISHED':'REJECTED_BY_GATE');assert(await db.get("select action from audit_log where action='MODEL_TRAINED'"));if(trainResult.gate.ok)assert(await db.get("select action from audit_log where action='MODEL_PUBLISHED'"));assert.deepEqual(errors,[]);await Promise.all(assetTasks);
 const video=page.video();await context.close();copyFileSync(await video.path(),join(out,'models-walkthrough.webm'));
 // Same run: browser obtains actual duration and checks full decode; bundled ffmpeg extracts real frames.
 const review=await browser.newContext();await review.route('**/*',async route=>{if(route.request().url()!=='http://docs-media.invalid/video.webm')return route.abort();const b=readFileSync(join(out,'models-walkthrough.webm'));const m=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);if(m){const from=+m[1],to=m[2]?Math.min(+m[2],b.length-1):b.length-1;return route.fulfill({status:206,contentType:'video/webm',headers:{'accept-ranges':'bytes','content-range':`bytes ${from}-${to}/${b.length}`},body:b.subarray(from,to+1)});}return route.fulfill({contentType:'video/webm',body:b});});
 const rp=await review.newPage();await rp.setContent('<video muted src="http://docs-media.invalid/video.webm"></video>');await rp.waitForFunction(()=>document.querySelector('video').readyState>=2);await rp.evaluate(async()=>{const v=document.querySelector('video');v.playbackRate=8;await v.play();});await rp.waitForFunction(()=>document.querySelector('video').ended,{timeout:30000});const duration=await rp.evaluate(()=>{const v=document.querySelector('video');if(v.error)throw Error('Video decoder error');return v.duration;});assert(Number.isFinite(duration)&&duration>0);
 const ffmpeg='/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux',decoded=[];for(const [i,c]of chapters.entries()){const seconds=Math.min(c.seconds+1,duration-.2),file='decoded-'+i+'.png';execFileSync(ffmpeg,['-v','error','-ss',String(seconds),'-i',join(out,'models-walkthrough.webm'),'-frames:v','1','-y',join(out,file)]);decoded.push({seconds,file});}await review.close();
 const stamp=t=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
 writeFileSync(join(out,'models-walkthrough.vtt'),'WEBVTT\n\n'+chapters.map((c,i)=>`${i+1}\n${stamp(c.seconds)} --> ${stamp(Math.min(chapters[i+1]?.seconds??duration,duration))}\n${c.title}\n`).join('\n'));writeFileSync(join(out,'models-transcript.txt'),chapters.map(c=>stamp(c.seconds)+' '+c.title).join('\n')+'\n');
 writeFileSync(join(out,'provenance.json'),JSON.stringify({schema:'docs-scenario.v1',scenario_id:'gold-ranking-gate-audit',api_revision:apiRevision,source_web_image:'e1c9dc4f61d29e71212dda8ad5fa69f9b1cda68a',ui_source_parity:'not claimed: deployed overlay',ui_asset_hashes:assets,roles:['curator','ml_engineer','admin'],fixture_id:'retrain-route-test-80-synthetic-objects',data:'Precomputed synthetic expert decisions; no OCR, GPU or LLM training',production_api_calls:0,production_writes:0,fixture_api_calls:calls.length,release:releaseResult,training:trainResult,final_model_status:trainedRow.approval_status,metrics_scope:"Synthetic 80-object fixture; test split 20 examples (10 positive, 10 negative); not whole-corpus or OCR/LLM accuracy",gate_refusal_captured:!trainResult.gate.ok,audit_UI_filter:"DATASET_RELEASED; MODEL_TRAINED/MODEL_PUBLISHED verified in isolated DB, not shown as filtered UI rows",smoke:smokeResult,validated:['release_real_API','CPU_train_real_API','actual_gate','audit_DATASET_RELEASED','audit_MODEL_TRAINED',...(trainResult.gate.ok?['publication_real_API','audit_MODEL_PUBLISHED']:[])],duration_seconds:duration,chapters,video_review:{playback:'complete without decoder error',decoded_frames:decoded},page_errors:errors,recorded_at:now()},null,2)+'\n');console.log(JSON.stringify({captured:true,gate:trainResult.gate,duration_seconds:duration,production_writes:0}));
}catch(e){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));throw e;}
finally{await browser.close();await app.close();await db.close();}
