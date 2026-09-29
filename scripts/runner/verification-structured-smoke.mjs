// Intercepted API: exercises all three structured viewers without real labels.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base='https://127.0.0.1:48845/verification',browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));let next=0,saved=0;
await context.addInitScript(()=>sessionStorage.setItem('verification.session',JSON.stringify({token:'synthetic-only',user:{id:'qa',name:'QA',role:'verifier'}})));
await context.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;let body;
 if(path.includes('/fragment/')){const kind=path.split('/')[6];return route.fulfill({json:{schema:'structured-original.v1',kind,label:kind,note:'Текст из оригинала',first_row:4,target_row:5,rows:[['Контекст'],['Площадь','', '123,5','<script>window.bad=true</script>'],['После']]}});}
 if(path.includes('/content/'))return route.fulfill({body:'synthetic original bytes',contentType:'application/octet-stream'});
 if(path.endsWith('/assignments/next')){
  const kind=['xlsx','docx','xml'][next++%3];body={assignment:{id:kind,token:'x'.repeat(64),expires_at:new Date(Date.now()+900000).toISOString(),task:{id:kind,parameter:'M-003',name:'Площадь',operation:'reading',question:'Проверьте значение',sides:[{kind,file_name:`synthetic.${kind}`,page:1,bbox:null,anchor_bbox:null,value:'123,5',quote:'Площадь 123,5',geometry:'none',stage:null,view_label:`${kind.toUpperCase()} · строки 4–6`,content_url:`/api/v1/verification/assignments/${kind}/content/0`,fragment_url:`/api/v1/verification/assignments/${kind}/fragment/0`}]}}};
 }else if(path.endsWith('/assignments/prefetch'))body={assignments:[]};
 else if(path.endsWith('/labels')){saved++;body={saved:true,id:`label-${saved}`};}
 else if(path.endsWith('/me/stats'))body={saved};
 else if(path.endsWith('/heartbeat'))body={expires_at:new Date(Date.now()+900000).toISOString()};
 else if(path.endsWith('/auth/guest'))body={enabled:false};
 else return route.fulfill({status:404,json:{error:'QA only'}});
 return route.fulfill({json:body});
});
try{
 await page.goto(`${base}/#/verification`);await page.getByRole('button',{name:'Получить задание',exact:true}).click();
 for(const [index,kind] of ['xlsx','docx','xml'].entries()){
  await page.getByTestId('structured-original').waitFor();assert.ok(await page.getByTestId('structured-original').innerText());
  assert.equal(await page.locator('.annotation-target-row').count(),1);
  assert.equal(await page.getByRole('button',{name:'Вся страница',exact:true}).count(),0);
  if(kind==='xlsx'){assert.ok((await page.locator('table').innerText()).includes('<script>'));assert.equal(await page.evaluate(()=>window.bad),undefined);}
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать оригинал',exact:true}).click();assert.equal((await download).suggestedFilename(),`synthetic.${kind}`);
  await page.getByRole('button',{name:'Увеличить',exact:true}).click();assert.ok(await page.getByText('125%',{exact:true}).count());
  await page.keyboard.press('1');await page.keyboard.press('Enter');
  await page.waitForFunction(n=>document.body.textContent.includes(`${['xlsx','docx','xml'][n%3].toUpperCase()} · строки`),index+1);
 }
 assert.equal(saved,3);assert.equal(errors.length,0);console.log(JSON.stringify({structured_kinds:3,original_downloads:3,highlight:true,zoom:true,html_escaped:true,synthetic_labels:3,page_errors:0}));
}finally{await browser.close();}
