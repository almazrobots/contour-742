// Private visual review using original-derived frozen views. No human labels.
// API isolated here; live authorization/digests are verified separately by HTTP tests.
import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const staging='/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032',qa=JSON.parse(readFileSync(`${staging}/structured-qa.json`,'utf8'));
const out='/opt/w1-gate/eval/verification/structured-browser';mkdirSync(out,{recursive:true,mode:0o700});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1100}});let current;
await context.addInitScript(()=>sessionStorage.setItem('verification.session',JSON.stringify({token:'private-qa-intercepted',user:{id:'qa',name:'Проверка',role:'verifier'}})));
await context.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;let body;
 if(path.includes('/fragment/')){
  const bytes=readFileSync(`${staging}/structured/${current.preview.key}.json`);assert.equal(createHash('sha256').update(bytes).digest('hex'),current.preview.sha256);
  return route.fulfill({contentType:'application/json',body:bytes});
 }
 if(path.endsWith('/assignments/next')){
  const c=current.candidate;body={assignment:{id:'private-view',token:'x'.repeat(64),expires_at:new Date(Date.now()+900000).toISOString(),task:{id:'qa',parameter:c.parameter,name:'Проверка оригинала',operation:'reading',question:'Проверьте найденное значение',sides:[{kind:current.kind,file_name:current.refs[0]?.path||`original.${current.kind}`,page:c.page,bbox:null,anchor_bbox:null,value:c.extraction.raw,quote:c.extraction.line_text,geometry:'none',stage:null,view_label:current.preview.label,content_url:'/api/v1/verification/assignments/private-view/content/0',fragment_url:'/api/v1/verification/assignments/private-view/fragment/0'}]}}};
 }else if(path.endsWith('/assignments/prefetch'))body={assignments:[]};
 else if(path.endsWith('/me/stats'))body={saved:0};
 else if(path.endsWith('/auth/guest'))body={enabled:false};
 else if(path.endsWith('/heartbeat'))body={expires_at:new Date(Date.now()+900000).toISOString()};
 else return route.fulfill({status:403,json:{error:'Read-only private QA; no labels'}});
 return route.fulfill({json:body});
});
const results=[];
try{
 for(const kind of ['xlsx','docx','xml']){
  assert.ok(qa.samples[kind],`no pinned original for ${kind}`);current={...qa.samples[kind],kind};
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://127.0.0.1:48845/verification/#/verification');await page.getByRole('button',{name:'Получить задание',exact:true}).click();await page.getByTestId('structured-original').waitFor();
  assert.ok(await page.locator('.annotation-target-row').count());assert.equal(errors.length,0);
  await page.screenshot({path:`${out}/${kind}.png`,fullPage:true});results.push({kind,original_view:true,page_errors:0});await page.close();
 }
 writeFileSync(`${out}/status.json`,JSON.stringify({results,labels_submitted:0,api_intercepted_for_visual_qa:true}),{mode:0o600});console.log(JSON.stringify({structured_original_views:results.length,page_errors:0,labels_submitted:0,private_output:out}));
}finally{await browser.close();}
