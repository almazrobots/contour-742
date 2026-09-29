// Real public browser login/source/logout. Never creates an operator label.
import {chromium,request} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base='https://nadzorium-gpu.almazrobots.ru',out='/opt/w1-gate/eval/verification/public-browser';
mkdirSync(out,{recursive:true,mode:0o700});
const credentials=JSON.parse(readFileSync('/opt/w1-gate/eval/verification/import-review/credentials.json','utf8'));
if(process.env.VERIFICATION_SMOKE_LOGIN)credentials.login=process.env.VERIFICATION_SMOKE_LOGIN;
const basic={username:'owner',password:readFileSync('/opt/stand-gpu/secrets/basic_auth_password','utf8').trim()};
const anonymous=await request.newContext();
const unauth=await anonymous.get(`${base}/verification/api/v1/verification/me/stats`);
assert.equal(unauth.status(),401);await anonymous.dispose();
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({httpCredentials:basic,viewport:{width:1600,height:1200}});
const page=await context.newPage();const errors=[],wrongApis=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))wrongApis.push(r.url());});
await context.addInitScript(()=>sessionStorage.setItem('inspector.session','main-session-sentinel'));
try{
 await page.goto(`${base}/verification/`);
 await page.locator('#login').fill(credentials.login);await page.locator('#password').fill(credentials.password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Получить задание',exact:true}).waitFor({timeout:30000});
 assert.equal(await page.getByRole('link',{name:'Разметка данных',exact:true}).count(),1);
 assert.equal(await page.getByRole('link',{name:'Объекты',exact:true}).count(),0);
 await page.getByRole('button',{name:'Получить задание',exact:true}).click();
 await page.locator('.annotation-sources:visible canvas').first().waitFor({state:'visible',timeout:60000});
 await page.waitForFunction(()=>Array.from(document.querySelector('.annotation-sources:not([style*="display: none"])').querySelectorAll('canvas')).every(c=>getComputedStyle(c).display!=='none'&&c.width>0));
 assert.ok((await page.locator('.annotation-page').boundingBox()).y<100,'work area is vertically centered away from the top');
 const s=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('verification.session')));
 if(credentials.login==='inspector'){
  assert.equal(s.user.role,'inspector');
  assert.equal(await page.getByRole('button',{name:'Управление разметкой',exact:true}).count(),0);
  const manage=await context.request.get(`${base}/verification/api/v1/verification/coverage`,{headers:{authorization:`Bearer ${s.token}`}});
  assert.equal(manage.status(),403);
 }
 await page.screenshot({path:`${out}/public-original.png`,fullPage:true});
 let pdfZoom=null;
 if(process.env.VERIFICATION_CHECK_PDF_ZOOM==='1'){
  const own=await (await context.request.post(`${base}/verification/api/v1/verification/assignments/next`,{headers:{authorization:`Bearer ${s.token}`}})).json();
  const index=own.assignment.task.sides.findIndex(side=>side.kind==='pdf');
  if(index>=0){
   const doc=page.locator('.annotation-sources:visible .annotation-document').nth(index);
   const ready=async()=>{await doc.locator('canvas').waitFor({state:'visible'});await page.waitForFunction(i=>!document.querySelector('.annotation-sources:not([style*="display: none"])').querySelectorAll('.annotation-document')[i].querySelector('[role="status"]'),index);};
   await doc.getByRole('button',{name:'Вся страница',exact:true}).click();await ready();
   const before=await doc.locator('canvas').evaluate(c=>c.width);
   for(let n=0;n<4;n++){await doc.getByRole('button',{name:'Увеличить',exact:true}).click();await ready();}
   const after=await doc.locator('canvas').evaluate(c=>c.width);
   pdfZoom={before_pixels:before,after_pixels:after,detail_increased:after>before};
   await page.screenshot({path:`${out}/public-full-detail.png`,fullPage:true});
   await doc.getByRole('button',{name:'Фрагмент',exact:true}).click();await ready();
  }
 }
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('inspector.session')),'main-session-sentinel');
 assert.equal(wrongApis.length,0);assert.equal(errors.length,0);
 await page.getByRole('link',{name:'Выйти',exact:true}).click();await page.locator('#login').waitFor();
 const revoked=await context.request.get(`${base}/verification/api/v1/verification/me/stats`,{headers:{authorization:`Bearer ${s.token}`}});
 assert.equal(revoked.status(),401);
 const result={public_url:`${base}/verification/`,login:true,original_rendered:true,logout_revoked:true,
   role:s.user.role,main_session_preserved:true,wrong_api_requests:wrongApis.length,page_errors:errors.length,pdf_zoom:pdfZoom,labels_submitted:0};
 writeFileSync(`${out}/status.json`,JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));
}finally{await browser.close();}
