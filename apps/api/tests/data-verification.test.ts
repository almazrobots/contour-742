import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.ts";
import { ingestAnnotations, nextAnnotation, prefetchAnnotations, releaseAnnotationBuffers, submitAnnotation, annotationSource, annotationHeartbeat, annotationStats, adjudicateAnnotation, claimAnnotationReview, releaseAnnotationDataset, annotationQualityReport } from "../src/services/data-verification.ts";

let db: DB;
const at = "2026-09-29T08:00:00.000Z";
const input = (n: number, operation: "reading" | "field_match" = "reading") => ({
  parameter: "M-007", operation, source_version: "test-v1", sides: [
    { sha256: String(n).padStart(64,"a"), file_name: `source-${n}.pdf`, kind: "pdf", page: 1, bbox: [0,0,1,1], value: "11", quote: "Этажность 11", object_key: `OBJ-${n}`, stage: "PD" },
    ...(operation === "field_match" ? [{ sha256: String(n).padStart(64,"b"), file_name: `second-${n}.pdf`, kind: "pdf", page: 2, bbox: [0,0,1,1], value: "12", quote: "Этажность 12", object_key: `OBJ-${n}`, stage: "RD" }] : []),
  ],
});
beforeAll(async () => {
  db = await openDb("memory");
  for (const id of ["vf1","vf2"]) await db.run("insert into users(id,login,name,role,password_hash) values($1,$1,$1,'verifier','unused')", [id]);
});
afterAll(async () => { await db?.close(); });
describe("durable очередь разметки", () => {
  it("повторное наполнение не удваивает задания и откат не сдвигает cursor", async () => {
    const body = { id:"ingestion", source_version:"test-v1", tasks:[input(1),input(2)], cursor:{ rowid:2 } };
    expect((await ingestAnnotations(db,"vf1",body)).inserted).toBe(2);
    expect((await ingestAnnotations(db,"vf1",body)).duplicates).toBe(2);
    await expect(ingestAnnotations(db,"vf1",{ ...body, source_version:"different" })).rejects.toMatchObject({ status:409 });
    expect(JSON.parse((await db.get<any>("select cursor_json from verification_ingestions where id='ingestion'"))!.cursor_json)).toEqual({ rowid:2 });
  });
  it("обновление возвращает ту же аренду, второй пользователь получает другое задание", async () => {
    const first = await nextAnnotation(db,"vf1",()=>0,at);
    const same = await nextAnnotation(db,"vf1",()=>.4,at);
    const second = await nextAnnotation(db,"vf2",()=>0,at);
    expect(first.assignment?.id).toBe(same.assignment?.id);
    expect(first.assignment?.task.id).not.toBe(second.assignment?.task.id);
    await expect(annotationSource(db,"vf2",first.assignment!.id,0,at)).rejects.toMatchObject({ status:403 });
    const answer = { token:first.assignment!.token, idempotency_key:"idempotency-test-1", answer:"NO",comment:"Ошибка чтения",corrected_value:"12" };
    expect(await submitAnnotation(db,"vf1",first.assignment!.id,answer,at)).toMatchObject({ saved:true,replay:false });
    expect(await submitAnnotation(db,"vf1",first.assignment!.id,answer,at)).toMatchObject({ saved:true,replay:true });
    await expect(submitAnnotation(db,"vf1",first.assignment!.id,{ ...answer,answer:"YES",corrected_value:null },at)).rejects.toMatchObject({ status:409 });
    expect((await annotationStats(db,"vf1")).saved).toBe(1);
    await expect(annotationSource(db,"vf1",first.assignment!.id,0,at)).rejects.toMatchObject({ status:403 });
  });
  it("просроченная аренда не принимает ответ, задание переходит в доступные", async () => {
    const old = await nextAnnotation(db,"vf2",()=>0,at);
    const later = "2026-09-29T09:00:00.000Z";
    await expect(annotationHeartbeat(db,"vf2",old.assignment!.id,old.assignment!.token,later)).rejects.toMatchObject({ status:409 });
    await expect(submitAnnotation(db,"vf2",old.assignment!.id,{token:old.assignment!.token,idempotency_key:"expired-idempotency",answer:"YES"},later)).rejects.toMatchObject({ status:409 });
    const recovered = await nextAnnotation(db,"vf2",()=>0,later);
    expect(recovered.assignment!.id).not.toBe(old.assignment!.id);
    expect((await db.get<any>("select state from verification_assignments where id=$1",[old.assignment!.id]))!.state).toBe("expired");
    expect(["ready","claimed"]).toContain((await db.get<any>("select state from verification_tasks where id=$1",[old.assignment!.task.id]))!.state);
  });
  it("метки неизменяемы, curator выпускает снимок с исходниками и разбиением", async () => {
    const label = await db.get<any>("select * from verification_labels limit 1");
    await expect(db.run("update verification_labels set answer='YES' where id=$1",[label.id])).rejects.toThrow();
    await db.run("update verification_tasks set state='answered' where id=$1",[label.task_id]);
    await db.run("update verification_assignments set state='expired' where user_id='vf2' and state='active'");
    const lease=(await claimAnnotationReview(db,"vf2",label.task_id)).assignment;
    await adjudicateAnnotation(db,"vf2",label.task_id,{assignment_id:lease.id,token:lease.token,answer:"NO",corrected_value:"12",comment:"Проверено отдельно"});
    const release = await releaseAnnotationDataset(db,"vf2");
    expect(release.manifest.count).toBe(1);
    expect((await releaseAnnotationDataset(db,"vf2")).replay).toBe(true);
    const item = await db.get<any>("select snapshot_json from verification_dataset_items where dataset_id=$1",[release.id]);
    expect(JSON.parse(item.snapshot_json).labels[0].comment).toBe("Ошибка чтения");
  });
  it("отчёт различает найденных кандидатов и проверенные ответы; пустая выборка не даёт 100%",async()=>{
    const report=await annotationQualityReport(db);
    expect(report.items).toHaveLength(132*4);
    const row=report.items.find(r=>r.parameter==='M-007'&&r.operation==='reading')!;
    expect(row.curated_no).toBe(1);expect(row.labels).toBe(1);expect(row.precision).toMatchObject({n:1,rate:0});
    expect(row.agreement).toBeNull();expect(row.recall).toBeNull();
    const empty=report.items.find(r=>r.parameter==='M-022'&&r.operation==='reading')!;
    expect(empty.parameter).toBe('M-022');expect(empty.tasks).toBe(0);expect(empty.precision).toBeNull();expect(empty.unsure_rate).toBeNull();
  });
});

it("малая операция и объект доступны при большой группе; один источник не доминирует подряд",async()=>{
 const isolated=await openDb('memory');
 try{
  await isolated.run("insert into users(id,login,name,role,password_hash) values('balanced','balanced','balanced','verifier','unused')");
  const tasks=Array.from({length:40},(_,i)=>({...input(10),sides:[{...input(10).sides[0],page:i+1}]}));
  tasks.push(input(11),input(11,'field_match') as any);
  await ingestAnnotations(isolated,'balanced',{id:'balanced',source_version:'test-v1',tasks});
  const randoms=[.6,.6,.6,0,.6];
  const rare=(await nextAnnotation(isolated,'balanced',()=>randoms.shift()??.6,at)).assignment!;
  expect(rare.task.operation).toBe('field_match');expect(rare.task.sides[0].file_name).toBe('source-11.pdf');
  await submitAnnotation(isolated,'balanced',rare.id,{token:rare.token,idempotency_key:'balanced-first-1',answer:'NO'},at);
  const next=(await nextAnnotation(isolated,'balanced',()=>.6,at)).assignment!;
  expect(next.task.sides[0].file_name).toBe('source-10.pdf');
 }finally{await isolated.close();}
});
it("готовые страницы недавно показанного SHA уступают другому источнику той же группы",async()=>{
 const isolated=await openDb('memory');
 try{
  await isolated.run("insert into users(id,login,name,role,password_hash) values('files','files','files','verifier','unused')");
  const tasks=Array.from({length:20},(_,i)=>({...input(20),sides:[{...input(20).sides[0],page:i+1}]}));
  tasks.push({...input(21),sides:[{...input(21).sides[0],object_key:'OBJ-20'}]});
  await ingestAnnotations(isolated,'files',{id:'files',source_version:'test-v1',tasks});
  const first=(await nextAnnotation(isolated,'files',()=>0,at)).assignment!;
  await submitAnnotation(isolated,'files',first.id,{token:first.token,idempotency_key:'files-balanced-first-1',answer:'YES'},at);
  const second=(await nextAnnotation(isolated,'files',()=>0,at)).assignment!;
  expect(second.task.sides[0].file_name).not.toBe(first.task.sides[0].file_name);
 }finally{await isolated.close();}
});

it("prefetch has three exclusive reserves, cannot submit early, promotes FIFO after durable answer",async()=>{
 const isolated=await openDb('memory');
 try{
  for(const id of ['buffer-a','buffer-b'])await isolated.run("insert into users(id,login,name,role,password_hash) values($1,$1,$1,'verifier','unused')",[id]);
  await ingestAnnotations(isolated,'buffer-a',{id:'buffer',source_version:'test-v1',tasks:Array.from({length:20},(_,i)=>input(100+i))});
  const current=(await nextAnnotation(isolated,'buffer-a',()=>.5,at)).assignment!;
  const buffers=await prefetchAnnotations(isolated,'buffer-a',()=>.5,at);expect(buffers.assignments).toHaveLength(3);
  expect((await prefetchAnnotations(isolated,'buffer-a',()=>.5,at)).assignments.map(a=>a.id)).toEqual(buffers.assignments.map(a=>a.id));
  const reserved=buffers.assignments[0];
  await expect(submitAnnotation(isolated,'buffer-a',reserved.id,{token:reserved.token,idempotency_key:'cannot-submit-reserve',answer:'YES'},at)).rejects.toMatchObject({status:409});
  await expect(annotationSource(isolated,'buffer-b',reserved.id,0,at)).rejects.toMatchObject({status:403});
  expect((await annotationSource(isolated,'buffer-a',reserved.id,0,at)).file_name).toBe(reserved.task.sides[0].file_name);
  const other=(await nextAnnotation(isolated,'buffer-b',()=>.5,at)).assignment!;
  expect([current.task.id,...buffers.assignments.map(a=>a.task.id)]).not.toContain(other.task.id);
  await submitAnnotation(isolated,'buffer-a',current.id,{token:current.token,idempotency_key:'buffer-durable-answer',answer:'YES'},at);
  expect((await nextAnnotation(isolated,'buffer-a',()=>.5,at)).assignment!.id).toBe(reserved.id);
  await prefetchAnnotations(isolated,'buffer-a',()=>.5,at);
  await submitAnnotation(isolated,'buffer-a',reserved.id,{token:reserved.token,idempotency_key:'buffer-second-answer',answer:'NO'},at);
  expect((await nextAnnotation(isolated,'buffer-a',()=>.5,at)).assignment!.id).toBe(buffers.assignments[1].id);
  await releaseAnnotationBuffers(isolated,'buffer-a');
  expect(Number((await isolated.get<any>("select count(*) n from verification_assignments where user_id='buffer-a' and state='buffered'"))!.n)).toBe(0);
  expect((await annotationStats(isolated,'buffer-a')).saved).toBe(2);
 }finally{await isolated.close();}
});
it("expired preparation loses source access and returns its tasks without labels",async()=>{
 const isolated=await openDb('memory');try{
  await isolated.run("insert into users(id,login,name,role,password_hash) values('expiry-buffer','expiry-buffer','expiry-buffer','verifier','unused')");
  await ingestAnnotations(isolated,'expiry-buffer',{id:'expiry-buffer',source_version:'test-v1',tasks:Array.from({length:6},(_,i)=>input(200+i))});
  await nextAnnotation(isolated,'expiry-buffer',()=>.5,at);const buffers=await prefetchAnnotations(isolated,'expiry-buffer',()=>.5,at);
  const late='2026-09-29T10:00:00.000Z';await expect(annotationSource(isolated,'expiry-buffer',buffers.assignments[0].id,0,late)).rejects.toMatchObject({status:403});
  await releaseAnnotationBuffers(isolated,'expiry-buffer');expect((await annotationStats(isolated,'expiry-buffer')).saved).toBe(0);
  expect((await prefetchAnnotations(isolated,'expiry-buffer',()=>.5,late)).assignments).toHaveLength(0);
 }finally{await isolated.close();}
});
