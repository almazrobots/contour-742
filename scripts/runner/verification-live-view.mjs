// Private visual review: open an actual source; never submit a label.
import {chromium,request} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const base='https://127.0.0.1:48845',out='/opt/w1-gate/eval/verification/live-view';
mkdirSync(out,{recursive:true,mode:0o700});
const credentials=JSON.parse(readFileSync('/opt/w1-gate/eval/verification/import-review/credentials.json','utf8'));
const api=await request.newContext({ignoreHTTPSErrors:true});
const login=await api.post(`${base}/api/v1/auth/login`,{data:credentials});
if(login.status()!==200)throw Error(`private login failed ${login.status()}`);
const session=await login.json();const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1200}});
await context.addInitScript(s=>{sessionStorage.setItem('inspector.session',JSON.stringify(s));sessionStorage.setItem('verification.session',JSON.stringify(s));},session);
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`${base}/verification/#/verification`);await page.getByRole('button',{name:'Получить задание',exact:true}).click();
 await page.locator('canvas').first().waitFor({state:'visible',timeout:60000});
 await page.screenshot({path:`${out}/original-fragment.png`,fullPage:true});
 const a=await (await api.post(`${base}/api/v1/verification/assignments/next`,{headers:{authorization:`Bearer ${session.token}`}})).json();
 writeFileSync(`${out}/assignment.json`,JSON.stringify(a,null,2),{mode:0o600});
 writeFileSync(`${out}/status.json`,JSON.stringify({schema:'private-live-source-view.v1',opened:true,side_count:a.assignment.task.sides.length,page_errors:errors.length,labels_submitted:0}),{mode:0o600});
 console.log(JSON.stringify({live_source_opened:true,sides:a.assignment.task.sides.length,page_errors:errors.length,labels_submitted:0}));
}finally{await browser.close();await api.dispose();}
