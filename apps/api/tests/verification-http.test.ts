import { afterAll,beforeAll,expect,it } from "vitest";
import { mkdtemp,writeFile,rm,mkdir,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
process.env.INSPECTOR_DEMO_PASSWORD="annotation-http-test-password";
let app:any,db:any,root:string;
const tokens:Record<string,string>={};
const bytes=Buffer.from("%PDF-1.4\nPrivate synthetic source\n"),sha=createHash('sha256').update(bytes).digest('hex');
const call=async(who:string,method:string,url:string,payload?:unknown)=>{
  tokens[who]??=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{login:who,password:process.env.INSPECTOR_DEMO_PASSWORD}})).json().token;
  return app.inject({method,url,headers:{authorization:`Bearer ${tokens[who]}`},...(payload?{payload}:{})});
};
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'annotation-http-'));await writeFile(join(root,sha),bytes);process.env.INSPECTOR_VERIFICATION_CORPUS_DIR=root;
  db=await (await import('../src/db.ts')).openDb('memory');app=(await import('../src/app.ts')).buildApp(db);await app.ready();
});
afterAll(async()=>{await app?.close();await db?.close();delete process.env.INSPECTOR_VERIFICATION_CORPUS_DIR;await rm(root,{recursive:true,force:true});});
it('admin creates a restricted verifier; work cannot change business decisions or curate',async()=>{
  const created=await call('admin','POST','/api/v1/admin/verifiers',{login:'verifier-http',name:'Оператор',password:process.env.INSPECTOR_DEMO_PASSWORD});expect(created.statusCode).toBe(200);expect(created.json().role).toBe('verifier');expect(created.body).not.toContain('hash');
  for(const [method,url] of [['POST','/api/v1/verification/ingestions'],['POST','/api/v1/verification/datasets/release'],['POST','/api/v1/admin/verifiers'],['GET','/api/v1/verification/quality'],['GET','/api/v1/inspections']])expect((await call('verifier-http',method,url)).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/v1/verification/assignments/next'})).statusCode).toBe(401);
});
it('quality report is authorized and has a complete contract without invented accuracy',async()=>{
 const result=await call('curator','GET','/api/v1/verification/quality');expect(result.statusCode,result.body).toBe(200);
 const report=result.json();expect(report.items).toHaveLength(528);expect(report.items.every((r:any)=>r.precision===null&&r.recall===null)).toBe(true);
});
it('source access is lease-bound; ranges work; durable replay works over the HTTP contract',async()=>{
  const source={sha256:sha,file_name:'synthetic.pdf',kind:'pdf',page:1,object_key:'test-object',value:'11',stage:null,crop:null,artifact_sha256:null};
  const fill=await call('curator','POST','/api/v1/verification/ingestions',{id:'http-ingest',source_version:'http-v1',tasks:[{parameter:'M-007',operation:'reading',source_version:'http-v1',sides:[source]}]});expect(fill.statusCode,fill.body).toBe(200);
  const r=await call('verifier-http','POST','/api/v1/verification/assignments/next');expect(r.statusCode,r.body).toBe(200);const a=r.json().assignment;
  expect((await call('verifier-http','POST','/api/v1/verification/assignments/next')).json().assignment.id).toBe(a.id);
  expect((await call('inspector','GET',a.task.sides[0].content_url)).statusCode).toBe(403);
  const range=await app.inject({method:'GET',url:a.task.sides[0].content_url,headers:{authorization:`Bearer ${tokens['verifier-http']}`,range:'bytes=0-3'}});expect(range.statusCode).toBe(206);expect(range.rawPayload).toEqual(bytes.subarray(0,4));
  const body={token:a.token,idempotency_key:'http-idempotency-1',answer:'UNSURE',comment:'Нечётко'};
  const label=await call('verifier-http','POST',`/api/v1/verification/assignments/${a.id}/labels`,body);expect(label.statusCode,label.body).toBe(200);
  expect((await call('verifier-http','POST',`/api/v1/verification/assignments/${a.id}/labels`,body)).json().replay).toBe(true);
  expect((await call('verifier-http','GET',a.task.sides[0].content_url)).statusCode).toBe(403);
  expect((await call('verifier-http','POST',`/api/v1/verification/assignments/${a.id}/labels`,{...body,answer:'YES'})).statusCode).toBe(409);
});
it('source mismatch and traversal never serve a different original',async()=>{
  await writeFile(join(root,sha),Buffer.from('changed')); // hash cache uses size/mtime
  const fill=await call('curator','POST','/api/v1/verification/ingestions',{id:'http-ingest',source_version:'http-v1',tasks:[{parameter:'M-007',operation:'reading',source_version:'http-v1',sides:[{sha256:sha,file_name:'second.pdf',kind:'pdf',page:2,object_key:'test-object'}]}]});expect(fill.statusCode).toBe(200);
  const a=(await call('inspector','POST','/api/v1/verification/assignments/next')).json().assignment;
  expect((await call('inspector','GET',a.task.sides[0].content_url)).statusCode).toBe(409);
  expect((await call('inspector','GET',`/api/v1/verification/assignments/${a.id}/content/99`)).statusCode).toBe(400);
});

it('library sources require a saved owned label; anonymous and model roles are rejected',async()=>{
 await writeFile(join(root,sha),bytes);
 expect((await app.inject({method:'GET',url:'/api/v1/verification/library'})).statusCode).toBe(401);
 expect((await call('ml','GET','/api/v1/verification/library')).statusCode).toBe(403);
 const list=await call('verifier-http','GET','/api/v1/verification/library');expect(list.statusCode,list.body).toBe(200);
 const item=list.json().items[0];expect(item.comment).toBe('Нечётко');
 expect((await call('verifier-http','GET',item.task.sides[0].content_url)).statusCode).toBe(200);
 expect((await call('inspector','GET',item.task.sides[0].content_url)).statusCode).toBe(404);
 const mark=await call('verifier-http','POST',`/api/v1/verification/library/${item.id}/mark`,{starred:true});expect(mark.statusCode,mark.body).toBe(200);
 expect((await call('verifier-http','GET','/api/v1/verification/library?starred=true')).json().items).toHaveLength(1);
});

it('structured fragments retain ownership, digest and realpath guards; originals download intact',async()=>{
 // Earlier tests deliberately leave synthetic raster tasks pending. Isolate this
 // scenario from randomized parameter allocation without changing production code.
 await db.run("update verification_tasks set state='answered' where source_version='http-v1'");
 process.env.INSPECTOR_VERIFICATION_STAGING_DIR=root;await mkdir(join(root,'structured'));
 const original=Buffer.from('synthetic XML original'),sourceSha=createHash('sha256').update(original).digest('hex');await writeFile(join(root,sourceSha),original);
 const view=Buffer.from(JSON.stringify({schema:'structured-original.v1',kind:'xml',rows:[['Площадь 123']]})),digest=createHash('sha256').update(view).digest('hex');
 const path=join(root,'structured',digest+'.json');await writeFile(path,view);
 const input={parameter:'M-003',operation:'reading',source_version:'structured-http-v1',sides:[{sha256:sourceSha,file_name:'test.xml',kind:'xml',page:1,object_key:'structured-http',preview:{key:digest,sha256:digest,label:'XML · текст',revision:'structured-original.v1'}}]};
 const fill=await call('curator','POST','/api/v1/verification/ingestions',{id:'structured-http',source_version:'structured-http-v1',tasks:[input]});expect(fill.statusCode,fill.body).toBe(200);
 const task=(await db.get('select id from verification_tasks where source_version=$1',['structured-http-v1'])).id;
 const review=await call('curator','POST','/api/v1/verification/assignments/next');expect(review.statusCode,review.body).toBe(200);expect(review.json().assignment.task.id).toBe(task);const side=review.json().assignment.task.sides[0];
 expect(side.view_label).toBe('XML · текст');
 expect((await app.inject({method:'GET',url:side.fragment_url})).statusCode).toBe(401);
 expect((await call('verifier-http','GET',side.fragment_url)).statusCode).toBe(403);
 const good=await call('curator','GET',side.fragment_url);expect(good.statusCode,good.body).toBe(200);expect(good.headers['content-type']).toContain('application/json');expect(good.rawPayload).toEqual(view);
 const download=await call('curator','GET',side.content_url);expect(download.rawPayload).toEqual(original);expect(download.headers['content-disposition']).toContain('attachment;');
 await writeFile(path,'changed');expect((await call('curator','GET',side.fragment_url)).statusCode).toBe(409);
 await rm(path);await symlink(join(root,sourceSha),path);expect((await call('curator','GET',side.fragment_url)).statusCode).toBe(409);
 await rm(path);await symlink('/etc/passwd',path);expect((await call('curator','GET',side.fragment_url)).statusCode).toBe(403);
 delete process.env.INSPECTOR_VERIFICATION_STAGING_DIR;
});
