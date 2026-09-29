// Synthetic vector PDF regression: zoom must add detail and reuse the PDF load.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const out='/opt/w1-gate/eval/verification/pdf-zoom';mkdirSync(out,{recursive:true,mode:0o700});
const stream='BT /F1 8 Tf 200 850 Td (SMALL ORIGINAL VECTOR TEXT - VALUE 11) Tj ET\n';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2384 1684] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
const assignment={id:'zoom-qa',token:'x'.repeat(64),expires_at:new Date(Date.now()+900000).toISOString(),purpose:'annotation',task:{id:'zoom-qa',parameter:'M-007',name:'Synthetic floor count',operation:'reading',question:'Synthetic 11?',sides:[{file_name:'synthetic-a0-vector.pdf',kind:'pdf',page:1,bbox:[.05,.45,.2,.55],anchor_bbox:null,value:'11',quote:'Synthetic vector test',stage:'PD',geometry:'word',content_url:'/api/v1/verification/assignments/zoom-qa/content/0',fragment_url:null}]}};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},deviceScaleFactor:2});
await context.addInitScript(()=>{const s=JSON.stringify({token:'synthetic-only',user:{id:'qa',role:'verifier'}});sessionStorage.setItem('verification.session',s);sessionStorage.setItem('inspector.session',s);});
let requests=0;const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await context.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.includes('/content/')){requests++;return route.fulfill({status:200,contentType:'application/pdf',body:Buffer.from(pdf)});}
 if(path.endsWith('/assignments/next'))return route.fulfill({json:{assignment}});
 if(path.endsWith('/me/stats'))return route.fulfill({json:{saved:0}});
 if(path.endsWith('/heartbeat'))return route.fulfill({json:{expires_at:assignment.expires_at}});
 return route.fulfill({status:404,json:{error:'Synthetic only'}});
});
const ready=async()=>{await page.locator('canvas').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.annotation-canvas-wrap [role="status"]'));};
try{
 await page.goto('https://127.0.0.1:48845/verification/#/verification');await page.getByRole('button',{name:'Получить задание',exact:true}).click();await ready();
 await page.getByRole('button',{name:'Вся страница',exact:true}).click();await ready();
 const before=await page.locator('canvas').evaluate(c=>c.width),baselineRequests=requests;
 for(let i=0;i<4;i++){await page.getByRole('button',{name:'Увеличить',exact:true}).click();await ready();}
 const after=await page.locator('canvas').evaluate(c=>c.width);
 assert.ok(after>=before*1.7,`PDF detail did not increase: ${before} -> ${after}`);
 assert.equal(requests,baselineRequests,'zoom downloaded the same PDF again');
 await page.getByRole('button',{name:'Фрагмент',exact:true}).click();await ready();
 assert.equal(requests,baselineRequests,'full/fragment redownloaded PDF');
 assert.equal(errors.length,0);
 await page.screenshot({path:`${out}/synthetic-detail.png`,fullPage:true});
 const result={zoom_detail_increases:true,before_pixels:before,after_pixels:after,pdf_requests:requests,repeated_pdf_requests:requests-baselineRequests,page_errors:errors.length,labels_submitted:0};
 writeFileSync(`${out}/status.json`,JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));
}finally{await browser.close();}
