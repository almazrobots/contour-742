// UI-only acceptance with synthetic API fixtures; not backend or production evidence.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||'apps/web/dist');
const server=createServer((req,res)=>{const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+'/')){res.writeHead(403).end();return;}const f=existsSync(p)?p:resolve(root,'index.html');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(f)]||'application/octet-stream');res.end(readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 await ctx.addInitScript(()=>sessionStorage.setItem('inspector.session',JSON.stringify({token:'fixture',user:{id:'fixture',login:'inspector',name:'Учебный инспектор',role:'inspector'}})));
 const page=await ctx.newPage(),calls=[];let longName=true;
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url());calls.push(u.pathname+u.search);let body={};
 if(u.pathname==='/api/v1/files')body={total:26,items:[{id:'demo',file_name:longName?'Учебный документ — '+ 'длинное название '.repeat(12)+'.pdf':'Учебный документ — пояснительная записка.pdf',document_code:'DEMO-01',object_name:'Учебный объект',doc_type:'PDF',pages:1,parse_status:'DONE',uploaded_at:'2026-09-29T10:00:00Z',mentions:1,params:[{param_code:'M007',name:'Этажность',in_matrix:true,mentions:1,distinct_values:1}]}]};
 if(u.pathname.endsWith('/params'))body={total:1,items:[{id:'m1',raw:'11',page:1,line_text:'Количество этажей: 11'}]};
 await route.fulfill({json:body});});
 await page.goto((process.env.FILES_UI_BASE||('http://127.0.0.1:'+server.address().port))+'/index.html#/files');
 const file=page.getByRole('button',{name:/Учебный документ/});await file.waitFor();await file.focus();await page.keyboard.press('Enter');assert.equal(await file.getAttribute('aria-expanded'),'true');
 assert.equal(await page.locator('a[href="/verification/#/verification"]').count(),1);
 assert.equal(await page.locator('a[href="/verification/#/verification-library"]').count(),1);
 const param=page.getByRole('button',{name:/Этажность/});await param.focus();await page.keyboard.press('Space');await page.getByText('Количество этажей: 11',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Поиск',exact:true}).fill('DEMO');await page.waitForResponse(r=>r.url().includes('q=DEMO'));
 await page.getByRole('button',{name:'Вперёд',exact:true}).click();await page.waitForResponse(r=>r.url().includes('offset=25'));
 assert(calls.some(p=>p.includes('offset=25')&&p.includes('q=DEMO')));
 longName=false;await page.reload();await page.getByRole('button',{name:/Учебный документ/}).click();await page.getByRole('button',{name:/Этажность/}).click();await page.getByText('Количество этажей: 11',{exact:true}).waitFor();
 mkdirSync('out/files-audit',{recursive:true});await page.screenshot({path:'out/files-audit/desktop.png'});
 console.log(JSON.stringify({ui_only:true,keyboard_disclosure:true,parameter_source:true,server_search_and_pagination:true}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
