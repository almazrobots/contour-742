// Synthetic keyboard UI contract against the built app. Does not write any corpus/human labels.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.VERIFICATION_UI_URL||'https://127.0.0.1:48845/verification';
const out=process.env.VERIFICATION_UI_OUT||'/tmp/verification-ui-qa';mkdirSync(out,{recursive:true,mode:0o700});
const image=readFileSync(process.env.VERIFICATION_SYNTHETIC_PNG||`${out}/synthetic.png`);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
let counter=0,active=null,labels=[],requests=[],fail=false;
const side=(i,index)=>({file_name:`synthetic-${index}.png`,kind:'png',page:1,bbox:null,anchor_bbox:null,value:'11',quote:'Этажность 11',stage:index?'RD':'PD',geometry:'none',content_url:`/api/v1/verification/assignments/qa-${i}/content/${index}`,fragment_url:null});
const next=()=>active??(active={id:`qa-${++counter}`,token:'x'.repeat(64),expires_at:new Date(Date.now()+900000).toISOString(),purpose:'annotation',task:{id:`task-${counter}`,parameter:'M-007',name:'Количество этажей',operation:counter%2?'reading':'field_match',question:counter%2?'В документе указано «11»?':'Выделенные поля обозначают один признак?',sides:counter%2?[side(counter,0)]:[side(counter,0),side(counter,1)]}});
await context.addInitScript(()=>{const s=JSON.stringify({token:'synthetic-qa-only',user:{id:'qa',name:'Оператор',login:'qa',role:'verifier'}});sessionStorage.setItem('inspector.session',s);sessionStorage.setItem('verification.session',s);});
await context.route('**/api/**',async route=>{
 const req=route.request(),path=new URL(req.url()).pathname;let body;
 if(path.includes('/content/'))return route.fulfill({status:200,contentType:'image/png',body:image});
 if(path.endsWith('/assignments/next'))body={assignment:next()};
 else if(path.endsWith('/labels')){
  const data=req.postDataJSON();requests.push(data);
  if(fail){fail=false;return route.fulfill({status:503,json:{error:'Синтетический отказ сохранения'}});}
  if(!labels.some(x=>x.idempotency_key===data.idempotency_key))labels.push(data);
  active=null;body={id:`label-${labels.length}`,saved:true,replay:false};
 }else if(path.endsWith('/me/stats'))body={saved:labels.length,yes:0,no:0,unsure:labels.length};
 else if(path.endsWith('/heartbeat'))body={expires_at:new Date(Date.now()+900000).toISOString()};
 else if(path.endsWith('/auth/guest'))body={enabled:false};
 else return route.fulfill({status:404,json:{error:'Synthetic QA route'}});
 return route.fulfill({status:200,json:body});
});
const ready=async()=>{await page.locator('canvas').first().waitFor({state:'visible'});await page.waitForFunction(()=>Array.from(document.querySelectorAll('canvas')).every(c=>c.width>0&&getComputedStyle(c).display!=='none'));};
const saved=async(n)=>{await page.waitForFunction(n=>document.querySelector('[data-testid="annotation-saved"]')?.textContent===String(n),n);await ready();};
try{
 await page.goto(`${base}/#/verification`);await page.getByRole('button',{name:'Получить задание',exact:true}).click();await ready();
 await page.keyboard.press('1');await page.locator('textarea').waitFor();assert.equal(labels.length,0);await page.waitForFunction(()=>document.activeElement===document.querySelector('textarea'),null,{timeout:1000});
 await page.getByRole('button',{name:'Вводить текст, включая цифры'}).click();await page.keyboard.type('1');assert.equal(await page.locator('textarea').inputValue(),'1');assert.equal(labels.length,0);await page.keyboard.press('Enter');await saved(1);assert.equal(labels[0].comment,'1');
 await page.keyboard.press('2');await page.locator('textarea').fill('Ошибка ');await page.keyboard.type('2');await page.keyboard.press('Enter');await saved(2);assert.equal(labels[1].answer,'NO');assert.equal(labels[1].comment,'Ошибка 2');
 await page.keyboard.press('3');await page.keyboard.press('3');await saved(3);assert.equal(labels[2].comment,'');
 await page.keyboard.press('3');await page.locator('textarea').fill('Первая');await page.keyboard.press('Shift+Enter');assert.equal(labels.length,3);await page.keyboard.type('Вторая');fail=true;await page.keyboard.press('Enter');await page.getByRole('alert').waitFor();assert.match(await page.locator('textarea').inputValue(),/Первая\nВторая/);assert.equal(labels.length,3);await page.getByRole('button',{name:'Сохранить и продолжить'}).click();await saved(4);assert.equal(requests.at(-1).idempotency_key,requests.at(-2).idempotency_key);
 const oldId=active.id;await page.reload();await page.getByRole('button',{name:'Получить задание',exact:true}).click();await ready();assert.equal(active.id,oldId);
 for(let i=0;i<20;i++){await page.keyboard.press('3');await page.keyboard.press('Enter');await saved(5+i);}
 assert.equal(labels.length,24);assert.equal(errors.length,0,errors.join('\n'));await page.screenshot({path:`${out}/keyboard-unified.png`,fullPage:true});
 writeFileSync(`${out}/status.json`,JSON.stringify({schema:'synthetic-keyboard-qa.v1',completed:true,saved:labels.length,tests:['first_digit_focus','numeric_comment_mode','digits_in_nonempty_comment','double_digit_empty_submit','shift_enter','retain_comment_on_error','retry_same_idempotency_key','reload_same_assignment','20_consecutive_cards','single_and_paired_canvases'],page_errors:errors},null,2));console.log(JSON.stringify({keyboard_smoke:'passed',saved:labels.length,page_errors:errors.length}));
}finally{await browser.close();}
