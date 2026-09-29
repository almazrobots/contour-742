import {beforeAll,afterAll,expect,it} from 'vitest';
import {openDb,type DB} from '../src/db.ts';
import {ingestAnnotations,nextAnnotation,submitAnnotation,releaseAnnotationDataset,claimAnnotationReview,adjudicateAnnotation} from '../src/services/data-verification.ts';
import {annotationLibrary,annotationLibrarySource,markAnnotationLibrary} from '../src/services/annotation-library.ts';
let db:DB,first:string;
const owner={id:'library-owner',role:'inspector'},other={id:'library-other',role:'verifier'},curator={id:'library-curator',role:'curator'};
beforeAll(async()=>{
 db=await openDb('memory');
 for(const u of [owner,other,curator])await db.run("insert into users(id,login,name,role,password_hash) values($1,$1,$1,$2,'unused')",[u.id,u.role]);
 const tasks=Array.from({length:30},(_,n)=>({parameter:'M-007',operation:'reading',source_version:'library-synthetic-v1',sides:[{sha256:'a'.repeat(64),file_name:'synthetic.pdf',kind:'pdf',page:n+1,object_key:'synthetic',value:'11'}]}));
 await ingestAnnotations(db,curator.id,{id:'library-synthetic',source_version:'library-synthetic-v1',tasks});
 for(let n=0;n<28;n++){
  const now=new Date(Date.now()+n*1000).toISOString(),a=(await nextAnnotation(db,owner.id,()=>0,now)).assignment!;
  const reply=await submitAnnotation(db,owner.id,a.id,{token:a.token,answer:'YES',comment:n===0?'Блять, это хуйня':'Проверено по оригиналу',idempotency_key:`library-key-${String(n).padStart(20,'0')}`},now);
  if(n===0)first=reply.id;
 }
});
afterAll(async()=>{await db?.close();});
it('lists immutable saved answers with stable pagination and censored comments',async()=>{
 const page=await annotationLibrary(db,owner,{});expect(page.total).toBe(28);expect(page.items).toHaveLength(24);expect(page.scope).toBe('mine');
 const tail=await annotationLibrary(db,owner,{cursor:page.next_cursor});expect(tail.items).toHaveLength(4);expect(tail.next_cursor).toBeNull();
 expect(new Set([...page.items,...tail.items].map(r=>r.id)).size).toBe(28);
 const original=tail.items.find(r=>r.id===first)!;expect(original.comment).toBe('*****, это *****');expect(original.comment_censored).toBe(true);
 expect((await db.get<any>('select comment from verification_labels where id=$1',[first])).comment).toBe('Блять, это хуйня');
 expect(await annotationLibrarySource(db,owner,first,0)).toMatchObject({file_name:'synthetic.pdf',value:'11'});
});
it('ordinary operators cannot browse or open another operator history',async()=>{
 expect((await annotationLibrary(db,other,{})).total).toBe(0);
 await expect(annotationLibrarySource(db,other,first,0)).rejects.toMatchObject({status:404});
 await expect(markAnnotationLibrary(db,other,first,{starred:true})).rejects.toMatchObject({status:404});
 await expect(annotationLibrary(db,other,{cursor:first})).rejects.toMatchObject({status:404});
 expect((await annotationLibrary(db,curator,{})).total).toBe(28);
 await expect(annotationLibrarySource(db,owner,first,2)).rejects.toMatchObject({status:404});
});
it('personal useful-example flags are persistent and never curate or alter labels',async()=>{
 expect((await annotationLibrary(db,owner,{starred:'true'})).total).toBe(0);
 await markAnnotationLibrary(db,owner,first,{starred:true});await markAnnotationLibrary(db,owner,first,{starred:true});
 expect((await annotationLibrary(db,owner,{starred:'true'})).items.map(i=>i.id)).toEqual([first]);
 expect((await annotationLibrary(db,curator,{starred:'true'})).total).toBe(0);
 expect(Number((await db.get<any>('select count(*) n from verification_labels')).n)).toBe(28);
 expect(Number((await db.get<any>('select count(*) n from verification_adjudications')).n)).toBe(0);
 await markAnnotationLibrary(db,owner,first,{starred:false});expect((await annotationLibrary(db,owner,{starred:'true'})).total).toBe(0);
});
it('new dataset comments are censored before digesting the frozen export',async()=>{
 const row=await db.get<any>('select task_id from verification_labels where id=$1',[first]);
 // Synthetic fixture only: make this once-reviewed example eligible for curation.
 await db.run("update verification_tasks set state='answered' where id=$1",[row.task_id]);
 const lease=(await claimAnnotationReview(db,curator.id,row.task_id)).assignment;
 await adjudicateAnnotation(db,curator.id,row.task_id,{assignment_id:lease.id,token:lease.token,answer:'YES',comment:'Заебался проверять'});
 const result=await releaseAnnotationDataset(db,curator.id);expect(result.manifest.comment_policy).toBe('masked-profanity.v1');
 const item=await db.get<any>('select snapshot_json from verification_dataset_items where dataset_id=$1',[result.id]);
 const snapshot=typeof item.snapshot_json==='string'?JSON.parse(item.snapshot_json):item.snapshot_json;
 expect(snapshot.labels[0].comment).toBe('*****, это *****');expect(snapshot.adjudication.comment).toBe('******** проверять');
});
