import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
const dir=mkdtempSync(join(tmpdir(),'inspection-details-'));
let app:any,db:any,token:string,id:string;
const provenance=JSON.stringify({mentions:[{raw:'x'.repeat(200000),stage:'PD',use:'chosen'}]});
beforeAll(async()=>{
 Object.assign(process.env,{INSPECTOR_BLOB_DIR:join(dir,'blobs'),INSPECTOR_DEMO_PASSWORD:'test-pass',INSPECTOR_ML_URL:'http://127.0.0.1:9'});
 db=await (await import('../src/db.ts')).openDb('memory');app=await (await import('../src/app.ts')).buildApp(db);
 token=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{login:'inspector',password:'test-pass'}})).json().token;
 id=await (await import('../src/services/inspections.ts')).createInspection({db,user:{id:'u-insp',login:'inspector',name:'И',role:'inspector'},ip:'127.0.0.1'} as any,{object_id:'DETAIL-OBJ',name:'Synthetic details'});
 await db.run("insert into checks (id,inspection_id,param_code,evidence_group_id,finding_status,verification_status,computed_in_version,created_at,updated_at,provenance_json,l8_json) values ('DETAIL-CHECK',$1,'M-023','g','CANDIDATE','PENDING',1,now(),now(),$2,$3)",[id,provenance,JSON.stringify({reason:'retained'})]);
});
afterAll(async()=>{await app?.close();await db?.close();rmSync(dir,{recursive:true,force:true})});
const get=(url:string)=>app.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`}});
it('preserves the full default contract but omits heavy details in the deferred card',async()=>{
 const full=await get(`/api/v1/inspections/${id}`);expect(full.statusCode).toBe(200);expect(full.json().checks[0].provenance_json).toBe(provenance);
 const brief=await get(`/api/v1/inspections/${id}?details=deferred`);expect(brief.statusCode).toBe(200);expect(brief.body.length).toBeLessThan(full.body.length/10);
 expect(brief.json().checks[0]).toMatchObject({id:'DETAIL-CHECK',has_provenance:true,provenance_json:null,l8_json:null});
});
it('returns the exact selected evidence without modifying stored data',async()=>{
 const r=await get('/api/v1/checks/DETAIL-CHECK/details');expect(r.statusCode).toBe(200);expect(r.json().provenance_json).toBe(provenance);expect(JSON.parse(r.json().l8_json)).toEqual({reason:'retained'});
});
it('requires authentication and reports a missing check',async()=>{
 expect((await app.inject({method:'GET',url:'/api/v1/checks/DETAIL-CHECK/details'})).statusCode).toBe(401);
 expect((await get('/api/v1/checks/DOES-NOT-EXIST/details')).statusCode).toBe(404);
 expect((await get(`/api/v1/inspections/${id}?details=invalid`)).statusCode).toBe(400);
});
