// Mocked gallery workflow: no corpus labels, marks or leases are created.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.VERIFICATION_UI_URL||'https://127.0.0.1:48845/verification',out=process.env.VERIFICATION_UI_OUT;
const image=readFileSync(`${out}/synthetic.png`);
const items=Array.from({length:26},(_,n)=>{
 const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 return {id,answer:n%2?'NO':'YES',comment:n?'Проверено <script>alert("bad")</script>':'*****, это *****',comment_censored:n===0,corrected_value:null,created_at:'2026-09-29T09:00:00Z',author_name:'Оператор',starred:false,task:{id,parameter:'M-007',name:'Этажность',operation:'reading',question:'В документе указано 11?',sides:[{file_name:'synthetic.png',kind:'png',page:1,bbox:null,anchor_bbox:null,value:'11',quote:'Этажность 11',stage:'PD',geometry:'none',content_url:`/api/v1/verification/library/${id}/content/0`,fragment_url:null}]}};
});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[];let marks=0,otherWrites=0;
page.on('pageerror',e=>errors.push(e.message));
await context.addInitScript(()=>sessionStorage.setItem('verification.session',JSON.stringify({token:'synthetic-only',user:{id:'qa',name:'Оператор',role:'verifier'}})));
await context.route('**/api/**',async route=>{
 const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/verification(?=\/api\/)/,'');let body;
 if(path.includes('/content/'))return route.fulfill({status:200,contentType:'image/png',body:image});
 if(path.endsWith('/library')){
  const selected=items.filter(i=>url.searchParams.get('starred')!=='true'||i.starred),tail=url.searchParams.has('cursor');
  body={items:selected.slice(tail?24:0,tail?48:24),next_cursor:!tail&&selected.length>24?selected[23].id:null,total:selected.length,scope:'mine',comment_policy:'masked-profanity.v1'};
 }else if(path.endsWith('/mark')){
  const id=path.split('/').at(-2),item=items.find(i=>i.id===id);item.starred=req.postDataJSON().starred;marks++;body={id,starred:item.starred};
 }else if(path.endsWith('/auth/guest'))body={enabled:false};
 else{if(req.method()==='POST')otherWrites++;return route.fulfill({status:404,json:{error:'Synthetic QA only'}});}
 return route.fulfill({status:200,json:body});
});
try{
 await page.goto(`${base}/#/verification-library`);
 await page.getByRole('heading',{name:'Витрина разметки',exact:true}).waitFor();
 await page.locator('canvas').waitFor({state:'visible'});
 assert.equal(await page.locator('.library-entry').count(),24);
 assert.match(await page.getByTestId('library-total').textContent(),/26/);
 assert.equal(await page.getByTestId('library-comment').textContent(),'*****, это *****');
 await page.getByRole('button',{name:'☆ Отметить хороший пример',exact:true}).click();
 await page.getByRole('button',{name:'★ Хороший пример',exact:true}).waitFor();assert.equal(items[0].starred,true);
 await page.getByRole('button',{name:'Хорошие примеры',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.library-entry').length===1);
 assert.match(await page.getByTestId('library-total').textContent(),/1/);
 await page.getByRole('button',{name:'Все ответы',exact:true}).click();await page.getByRole('button',{name:'Показать ещё',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.library-entry').length===26);
 await page.locator('.library-entry').nth(1).click();assert.equal(await page.getByTestId('library-comment').textContent(),'Проверено <script>alert("bad")</script>');
 await page.reload();await page.locator('canvas').waitFor({state:'visible'});await page.getByRole('button',{name:'★ Хороший пример',exact:true}).waitFor();
 assert.equal(otherWrites,0);assert.equal(marks,1);assert.equal(errors.length,0);
 await page.screenshot({path:`${out}/library-synthetic.png`,fullPage:true});
 const result={synthetic_library:'passed',pagination:true,comments:true,censored_comment_visible:true,comment_html_escaped:true,persistent_star:true,other_writes:otherWrites,page_errors:0};
 writeFileSync(`${out}/library-status.json`,JSON.stringify(result));console.log(JSON.stringify(result));
}finally{await browser.close();}
