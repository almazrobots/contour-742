// Real saved operator history. Read only; never creates a label or changes a star.
import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base='https://nadzorium-gpu.almazrobots.ru',out='/opt/w1-gate/eval/verification/library-public';mkdirSync(out,{recursive:true,mode:0o700});
const credentials=JSON.parse(readFileSync('/opt/w1-gate/eval/verification/import-review/credentials.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({httpCredentials:{username:'owner',password:readFileSync('/opt/stand-gpu/secrets/basic_auth_password','utf8').trim()},viewport:{width:1600,height:1000}});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`${base}/verification/`);await page.locator('#login').fill('curator');await page.locator('#password').fill(credentials.password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 const link=page.getByRole('link',{name:'Витрина разметки',exact:true});await link.waitFor();await link.click();
 await page.locator('canvas').first().waitFor({state:'visible',timeout:60000});
 const s=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('verification.session')));
 const r=await context.request.get(`${base}/verification/api/v1/verification/library`,{headers:{authorization:`Bearer ${s.token}`}});assert.equal(r.status(),200);
 const result=await r.json();assert.ok(result.total>=43);assert.equal(result.scope,'all');assert.equal(result.comment_policy,'masked-profanity.v1');
 assert.ok(await page.getByTestId('library-comment').count());assert.equal(errors.length,0);
 await page.screenshot({path:`${out}/saved-answers.png`,fullPage:true});
 await page.getByRole('link',{name:'Выйти',exact:true}).click();await page.locator('#login').waitFor();
 const evidence={public_library:true,total_saved:result.total,original_rendered:true,comments_visible:true,censored_comments_in_page:result.items.filter(i=>i.comment_censored).length,labels_submitted:0,marks_changed:0,page_errors:0};
 writeFileSync(`${out}/status.json`,JSON.stringify(evidence));console.log(JSON.stringify(evidence));
}finally{await browser.close();}
