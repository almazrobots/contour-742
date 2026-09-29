// Real inspector login and main-menu transition. Does not submit operator labels.
import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base='https://nadzorium-gpu.almazrobots.ru';
const out='/opt/w1-gate/eval/verification/main-menu-browser';mkdirSync(out,{recursive:true,mode:0o700});
const credentials=JSON.parse(readFileSync('/opt/w1-gate/eval/verification/import-review/credentials.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({httpCredentials:{username:'owner',password:readFileSync('/opt/stand-gpu/secrets/basic_auth_password','utf8').trim()},viewport:{width:1600,height:1000}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`${base}/#/login`);await page.locator('#login').fill('inspector');await page.locator('#password').fill(credentials.password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 const link=page.getByRole('link',{name:'Разметка данных',exact:true});await link.waitFor({timeout:30000});
 assert.equal(await link.getAttribute('href'),'/verification/#/verification');
 assert.equal(await page.getByRole('link',{name:'Витрина разметки',exact:true}).getAttribute('href'),'/verification/#/verification-library');
 const mainSession=await page.evaluate(()=>sessionStorage.getItem('inspector.session'));
 assert.equal(JSON.parse(mainSession).user.role,'inspector');
 await page.screenshot({path:`${out}/main-inspector.png`,fullPage:true});
 await link.click();await page.locator('#login').waitFor({timeout:30000});
 await page.locator('#login').fill('inspector');await page.locator('#password').fill(credentials.password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Получить задание',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('inspector.session')),mainSession);
 assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('verification.session')).user.role),'inspector');
 await page.getByRole('button',{name:'Получить задание',exact:true}).click();
 await page.locator('.annotation-sources:visible canvas').first().waitFor({state:'visible',timeout:60000});
 await page.screenshot({path:`${out}/module-inspector.png`,fullPage:true});
 await page.getByRole('link',{name:'Выйти',exact:true}).click();await page.locator('#login').waitFor();
 const token=JSON.parse(mainSession).token;
 const logout=await context.request.post(`${base}/api/v1/auth/logout`,{headers:{authorization:`Bearer ${token}`}});assert.equal(logout.status(),200);
 if(errors.length)writeFileSync(`${out}/page-errors.json`,JSON.stringify(errors),{mode:0o600});
 assert.equal(errors.length,0);
 const result={main_inspector_login:true,main_menu_link:true,main_library_link:true,module_inspector_login:true,original_rendered:true,main_session_preserved:true,admin_promoted:false,labels_submitted:0,page_errors:0};
 writeFileSync(`${out}/status.json`,JSON.stringify(result));console.log(JSON.stringify(result));
}finally{await browser.close();}
