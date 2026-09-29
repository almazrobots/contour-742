// Remote browser acceptance: user keyboard behavior, delayed index, retry and stale queries.
// Run after building out/docs. No production API or application database is involved.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,join} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve('out/docs');
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'};
const server=createServer((req,res)=>{
 try{
  const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!path.startsWith(root+'/')||!statSync(path).isFile()){res.writeHead(404).end();return}
  res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');res.end(readFileSync(path));
 }catch{res.writeHead(404).end()}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
const fixture=[
 {title:'Учебный А: разметка',description:'Первый учебный сценарий',text:'альфа',href:'annotation.html'},
 {title:'Учебный Б: витрина',description:'Второй учебный сценарий',text:'бета',href:'library.html'},
];
const errors=[],checks=[];
let browser;
const deferred=()=>{let release;const promise=new Promise(done=>{release=done});return {promise,release}};
const fulfill=(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixture)});
async function waitStarted(signal){
 let timer;try{await Promise.race([signal.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Search request did not start')),5000)})])}finally{clearTimeout(timer)}
}
async function statusHas(page,text){await page.waitForFunction(text=>document.getElementById('search-status').textContent.includes(text),text)}
async function active(page,selector){await page.waitForFunction(selector=>document.activeElement===document.querySelector(selector),selector)}

try{
 browser=await chromium.launch({headless:true});
 for(const target of [{route:'guide/index.html',input:'#search'},{route:'index.html',input:'#material-search'}]){
  async function open(handler){
   const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
   page.on('pageerror',error=>errors.push(target.route+': '+error.message));
   await page.goto(base+'/'+target.route);
   const input=page.locator(target.input);
   const indexUrl=await input.evaluate(el=>new URL(el.dataset.index||'search.json',location.href).href);
   await context.route(indexUrl,handler);
   return {context,page,input,indexUrl};
  }
  // The second native link is selected by keyboard and opens its own destination.
  {
   const {context,page,input}=await open(fulfill);
   try{
    await page.locator('#article').focus();await page.keyboard.press('Control+k');await active(page,target.input);
    await input.fill('учебный');await statusHas(page,'Найдено статей: 2');
    await input.press('ArrowDown');await active(page,'#search-results a:first-child');
    await page.keyboard.press('ArrowDown');await active(page,'#search-results a:nth-child(2)');
    await page.keyboard.press('Home');await active(page,'#search-results a:first-child');
    await page.keyboard.press('End');await active(page,'#search-results a:nth-child(2)');
    await page.keyboard.press('Escape');await active(page,target.input);
    assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#search-results a').count(),0);
    await input.press('Escape');await active(page,'#article');
    await page.keyboard.press('Control+k');await input.fill('учебный');await statusHas(page,'Найдено статей: 2');
    await input.press('ArrowDown');await page.keyboard.press('ArrowUp');await active(page,target.input);
    await input.press('ArrowUp');await active(page,'#search-results a:nth-child(2)');
    await page.keyboard.press('Enter');await page.waitForURL('**/guide/library.html');
    checks.push(target.route+': keyboard destination, Escape and focus');
   }finally{await context.close()}
  }
  // Failure is actionable: Enter retries without forcing a reload or changing query.
  {
   let calls=0;
   const {context,page,input}=await open(route=>++calls===1?route.fulfill({status:503,body:'unavailable'}):fulfill(route));
   try{
    await input.fill('учебный');await statusHas(page,'Поиск недоступен');
    await input.press('Enter');await statusHas(page,'Найдено статей: 2');assert.equal(calls,2);
    await input.press('Enter');await page.waitForURL('**/guide/annotation.html');
    checks.push(target.route+': 503 retry and input Enter');
   }finally{await context.close()}
  }
  // Delay the network, change the query before it arrives, then assert only the latest result.
  {
   const gate=deferred(),started=deferred();
   const {context,page,input}=await open(async route=>{started.release();await gate.promise;await fulfill(route)});
   try{
    await input.fill('альфа');await waitStarted(started);await statusHas(page,'Ищем');
    assert.equal(await page.locator('#search-results a').count(),0);
    await input.fill('бета');gate.release();await statusHas(page,'Найдено статей: 1');
    assert.match(await page.locator('#search-results').innerText(),/Витрина|витрина/);
    assert.doesNotMatch(await page.locator('#search-results').innerText(),/Учебный А/);
    await input.fill('неттакойстатьи');await statusHas(page,'Ничего не найдено');
    assert.equal(await page.locator('#search-results a').count(),0);
    checks.push(target.route+': delayed latest query and empty state');
   }finally{gate.release();await context.close()}
  }
  // Escape while the index is pending must not allow the old query to reappear.
  {
   const gate=deferred(),started=deferred();
   const {context,page,input,indexUrl}=await open(async route=>{started.release();await gate.promise;await fulfill(route)});
   try{
    await input.fill('учебный');await waitStarted(started);await input.press('Escape');
    const response=page.waitForResponse(indexUrl);gate.release();await (await response).finished();
    // Allow response parsing and the debounce window to complete before the negative assertion.
    await page.waitForTimeout(250);
    assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#search-results a').count(),0);
    assert.equal(await page.locator('#search-status').innerText(),'');await active(page,target.input);
    checks.push(target.route+': pending Escape rejects stale result');
   }finally{gate.release();await context.close()}
  }
 }
 // Standalone BI retains its own command palette; the docs input is absent.
 const context=await browser.newContext(),page=await context.newPage();
 try{
  page.on('pageerror',error=>errors.push('BI: '+error.message));
  await page.goto(base+'/bi/dashboard.html');await page.keyboard.press('Control+k');
  await page.locator('#pq').waitFor({state:'visible'});await active(page,'#pq');
  assert.equal(await page.locator('#search,#material-search').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#scrim').isHidden(),true);
  checks.push('BI: command palette isolated');
 }finally{await context.close()}
 assert.deepEqual(errors,[]);
 mkdirSync('out/search-audit',{recursive:true});
 writeFileSync(join('out/search-audit','status.json'),JSON.stringify({checks,errors},null,2)+'\n');
 console.log('docs search: '+checks.length+' browser acceptance checks passed');
}finally{await browser?.close();await new Promise(done=>server.close(done))}
