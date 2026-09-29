// T-254: только публичные интерфейсы входа и справочника CPU-демо. Никаких карточек корпуса.
// Транспорт: SSH loopback tunnel to CPU candidate:45901, invoked only through remote-run.
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
const dir='docs/user-guide/screens';mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}});
 // Private internal service's self-signed TLS over two authenticated SSH tunnels; no public TLS bypass.
 const page=await context.newPage();const base='https://127.0.0.1:55894';
 await page.goto(base+'/#/login');await page.getByRole('button',{name:'Войти для просмотра',exact:true}).waitFor();
 await page.screenshot({path:dir+'/login.png'});
 await page.getByRole('button',{name:'Войти для просмотра',exact:true}).click();await page.waitForURL('**/#/inspections');
 await page.goto(base+'/#/matrix');await page.getByText('M-022',{exact:true}).first().waitFor();
 // Document list and real corpus are deliberately never captured.
 await page.screenshot({path:dir+'/matrix.png'});
 writeFileSync(dir+'/provenance.json',JSON.stringify({source:'CPU read-only platform candidate (port 45901), no production data modified',date:'2026-09-29',screens:['login.png','matrix.png'],contains_corpus:false},null,2));
 console.log('captured login and parameter catalog; no corpus screenshots');
}finally{await browser.close()}
