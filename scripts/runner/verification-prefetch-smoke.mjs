// Synthetic browser proof: hidden reserves, durable acknowledgement, warm promotion.
// All API requests are intercepted; this test cannot add real operator labels.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const base=process.env.VERIFICATION_UI_URL||'https://127.0.0.1:48845/verification';
const out=process.env.VERIFICATION_UI_OUT;
const png=readFileSync(`${out}/synthetic.png`);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[],downloads=new Map();
page.on('pageerror',e=>errors.push(e.message));
let count=0,active=null,buffers=[],saved=0,fail=false,inFlight=false,ackAt=0;
let delayImages=150,logoutPage=null,logoutChecked=false;
const make=()=>{
 const id=`prefetch-${++count}`;
 return {id,token:'x'.repeat(64),expires_at:new Date(Date.now()+900000).toISOString(),purpose:'annotation',task:{id:`task-${id}`,parameter:'M-007',name:'Этажность',operation:count%2?'reading':'field_match',question:'Проверьте значение 11',sides:Array.from({length:count%2?1:2},(_,i)=>({file_name:'synthetic.png',kind:'png',page:1,bbox:null,anchor_bbox:null,value:'11',quote:'Этажность: 11',stage:i?'RD':'PD',geometry:'none',content_url:`/api/v1/verification/assignments/${id}/content/${i}`,fragment_url:null}))}};
};
await context.addInitScript(()=>sessionStorage.setItem('verification.session',JSON.stringify({token:'synthetic-only',user:{id:'qa',name:'Оператор',role:'verifier'}})));
await context.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname.replace(/^\/verification(?=\/api\/)/,'');
 if(path.includes('/content/')){
  downloads.set(path,(downloads.get(path)??0)+1);
  await new Promise(r=>setTimeout(r,delayImages));
  return route.fulfill({status:200,contentType:'image/png',body:png});
 }
 let body;
 if(path.endsWith('/assignments/next')){
  assert.equal(inFlight,false,'next was requested before label acknowledgement');
  active??=buffers.shift()??make();body={assignment:active};
 }else if(path.endsWith('/assignments/prefetch')){
  while(buffers.length<3)buffers.push(make());body={assignments:buffers};
 }else if(path.endsWith('/labels')){
  assert.ok(path.includes(active.id));inFlight=true;
  await new Promise(r=>setTimeout(r,300));
  inFlight=false;
  if(fail){fail=false;return route.fulfill({status:503,json:{error:'Synthetic temporary failure'}});}
  saved++;active=null;ackAt=performance.now();body={id:`label-${saved}`,saved:true,replay:false};
 }else if(path.endsWith('/auth/logout')){
  assert.equal(await logoutPage.locator('canvas').count(),0,'sources still mounted at server logout');
  logoutChecked=true;body={ok:true};
 }else if(path.endsWith('/me/stats'))body={saved};
 else if(path.endsWith('/heartbeat'))body={expires_at:new Date(Date.now()+900000).toISOString()};
 else if(path.endsWith('/auth/guest'))body={enabled:false};
 else return route.fulfill({status:404,json:{error:'Synthetic QA only'}});
 return route.fulfill({status:200,json:body});
});
const prepared=async()=>page.getByTestId('annotation-prefetched').filter({hasText:'3 из 3'}).waitFor();
const latencies=[];
try{
 await page.goto(`${base}/#/verification`);
 await page.getByRole('button',{name:'Получить задание',exact:true}).click();await prepared();
 assert.equal(saved,0);assert.equal(await page.locator('.annotation-sources:visible').count(),1);
 assert.equal(await page.locator('.annotation-sources').count(),4);
 for(let i=0;i<8;i++){
  await prepared();const before=active.id,target=buffers[0].id;
  await page.locator(`[data-assignment-id="${target}"] canvas`).evaluateAll(nodes=>nodes.forEach(c=>c.dataset.prepared='same-canvas'));
  const paths=buffers[0].task.sides.map(s=>s.content_url);
  if(i===0){
   fail=true;await page.keyboard.press('2');await page.locator('textarea').fill('Keep this comment');await page.keyboard.press('Enter');
   await page.getByRole('alert').waitFor();assert.equal(saved,0);assert.equal(active.id,before);
   assert.equal(await page.locator('textarea').inputValue(),'Keep this comment');
   await page.getByRole('button',{name:'Сохранить и продолжить'}).click();
  }else{await page.keyboard.press('1');await page.keyboard.press('Enter');}
  // Old card remains visible while the server is saving.
  assert.equal(await page.locator('.annotation-sources:visible').getAttribute('data-assignment-id'),before);
  await page.waitForFunction(id=>{const node=document.querySelector(`[data-assignment-id="${id}"]`);return node&&node.getBoundingClientRect().width>0&&[...node.querySelectorAll("canvas")].every(c=>c.width>0&&getComputedStyle(c).display!=="none");},target,{polling:"raf"});
  latencies.push(performance.now()-ackAt);
  assert.equal(await page.locator('.annotation-sources:visible canvas').evaluateAll(nodes=>nodes.every(c=>c.dataset.prepared==='same-canvas'&&c.width>0)),true);
  assert.equal(await page.locator('.annotation-sources:visible [role="status"]').count(),0,'warm card restarted its draw');
  for(const path of paths)assert.equal(downloads.get(path),1,'prepared source downloaded again');
 }
 assert.equal(saved,8);assert.equal(errors.length,0);await prepared();
 assert.equal(await page.locator('.annotation-sources').count(),4);
 const pixels=await page.locator('canvas').evaluateAll(nodes=>nodes.reduce((n,c)=>n+c.width*c.height,0));
 const sorted=[...latencies].sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1];
 assert.ok(p95<1000,`warm transition p95 exceeded 1s: ${p95}`);
 delayImages=1000;logoutPage=await context.newPage();logoutPage.on('pageerror',e=>errors.push(e.message));
 await logoutPage.goto(`${base}/#/verification`);await logoutPage.getByRole('button',{name:'Получить задание',exact:true}).click();
 await logoutPage.locator('canvas').first().waitFor({state:'attached'});
 await logoutPage.getByRole('link',{name:'Выйти',exact:true}).click();await logoutPage.locator('#login').waitFor();
 assert.equal(logoutChecked,true);assert.equal(errors.length,0);
 const result={schema:'synthetic-prefetch-qa.v1',passed:true,synthetic_labels:saved,buffer_cards:3,prepared_canvases_reused:true,source_downloads_repeated:0,durable_ack_before_next:true,error_keeps_comment:true,logout_unmounts_sources_before_revoke:true,warm_transition_samples_ms:latencies,p95_ms:p95,canvas_rgba_bytes:pixels*4,page_errors:errors.length};
 writeFileSync(`${out}/prefetch-status.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
