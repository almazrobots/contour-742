import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db.ts";
import { AnnotationAnswer, AnnotationTaskInput, annotationFingerprint, annotationQuestion, annotationInterval, chooseAnnotationParameter, chooseAnnotationStratum, splitAnnotationGroups, type AnnotationTask } from "../domain/data-verification.ts";
import {censorAnnotationComment} from "../domain/annotation-comments.ts";
import { HttpError } from "./inspections.ts";

export const annotationJson = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) as T : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const LEASE_MS = 15 * 60 * 1000;
const date = () => new Date().toISOString();
export const AnnotationIngestion = z.object({
  id: z.string().min(1).max(100), source_version: z.string().min(1).max(200),
  source_associations:z.array(z.object({object_key:z.string().min(1).max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000).default([]),
  tasks: z.array(AnnotationTaskInput).max(100), cursor: z.record(z.string(), z.unknown()).default({}),
  inventory: z.record(z.string(), z.unknown()).default({}),
}).strict();

async function addTasks(t:DB,tasks:AnnotationTask[]):Promise<number> {
  if(!tasks.length)return 0;
  const records=tasks.map(task=>{const fingerprint=annotationFingerprint(task);return {
    id:`vt-${fingerprint}`,fingerprint,parameter:task.parameter,operation:task.operation,question:annotationQuestion(task),
    snapshot_json:task,difficulty:task.difficulty,source_version:task.source_version,object_key:task.sides[0].object_key,
    random_key:parseInt(fingerprint.slice(0,12),16)/0xffffffffffff,required_reviews:parseInt(fingerprint.slice(12,14),16)<26?2:1,
  };});
  const rows=await t.all<any>(`with inserted as (
    insert into verification_tasks(id,fingerprint,parameter,operation,question,snapshot_json,difficulty,source_version,object_key,random_key,required_reviews)
    select id,fingerprint,parameter,operation,question,snapshot_json,difficulty,source_version,object_key,random_key,required_reviews
    from jsonb_to_recordset($1::jsonb) as r(id text,fingerprint text,parameter text,operation text,question text,snapshot_json jsonb,difficulty text,source_version text,object_key text,random_key double precision,required_reviews integer)
    on conflict(fingerprint) do nothing returning parameter
  ), counted as (select parameter,count(*)::integer n from inserted group by parameter), coverage as (
    insert into verification_coverage(parameter,ready) select parameter,n from counted order by parameter
    on conflict(parameter) do update set ready=verification_coverage.ready+excluded.ready returning parameter
  ) select coalesce(sum(n),0)::integer n from counted`,[JSON.stringify(records)]);
  return Number(rows[0].n);
}
async function addTask(t:DB,task:AnnotationTask):Promise<boolean>{return (await addTasks(t,[task]))>0;}

export async function ingestAnnotations(db: DB, author: string, raw: unknown) {
  const input = AnnotationIngestion.parse(raw);
  return db.tx(async (t) => {
    await t.run(`insert into verification_ingestions(id,source_version,author) values($1,$2,$3) on conflict(id) do nothing`, [input.id,input.source_version,author]);
    const existing = await t.get<any>("select source_version from verification_ingestions where id=$1 for update", [input.id]);
    if (existing!.source_version !== input.source_version) throw new HttpError(409, "Версия источника не совпадает с начатым обходом");
    for(const member of input.source_associations) await t.run("insert into verification_source_groups(ingestion_id,object_key,sha256) values($1,$2,$3) on conflict do nothing",[input.id,member.object_key,member.sha256]);
    const known=new Set((await t.all<any>("select code from params")).map(r=>r.code));
    for(const task of input.tasks) {
      if(!known.has(task.parameter))throw new HttpError(400,"Параметра нет в Матрице");
      if(task.source_version!==input.source_version)throw new HttpError(400,"Задание относится к другой версии источника");
    }
    const inserted=await addTasks(t,input.tasks);
    await t.run("update verification_ingestions set cursor_json=$2,inventory_json=$3,updated_at=$4 where id=$1", [input.id,JSON.stringify(input.cursor),JSON.stringify(input.inventory),date()]);
    return { id: input.id, inserted, duplicates: input.tasks.length - inserted, cursor: input.cursor };
  });
}

async function expireAssignments(t: DB, now: string, user: string) {
  const expired = await t.all<any>(`select a.id,a.task_id,a.purpose,v.parameter from verification_assignments a join verification_tasks v on v.id=a.task_id
    where a.state in ('active','buffered') and a.expires_at <= $1 order by (a.user_id=$2) desc,a.expires_at limit 500 for update of a skip locked`, [now,user]);
  const returned=new Map<string,number>();
  for (const row of expired) {
    await t.run("update verification_assignments set state='expired',buffer_slot=null where id=$1", [row.id]);
    if (row.purpose === "review") continue;
    const changed = await t.run("update verification_tasks set state='ready' where id=$1 and state='claimed'", [row.task_id]);
    if (changed.rowCount) returned.set(row.parameter,(returned.get(row.parameter)??0)+1);
  }
  for(const parameter of [...returned.keys()].sort())await t.run("update verification_coverage set ready=ready+$2 where parameter=$1",[parameter,returned.get(parameter)]);
}

async function reclaimExpired(db:DB,user:string,now:string){
  await db.tx(async t=>{await t.get("select id from users where id=$1 for update",[user]);await expireAssignments(t,now,user);});
}

function present(row: any) {
  const snapshot = annotationJson<AnnotationTask>(row.snapshot_json);
  return { id: row.assignment_id, purpose: row.purpose, token: row.token, expires_at: new Date(row.expires_at).toISOString(),
    task: { id: row.task_id, parameter: row.parameter, name: row.parameter_name, operation: row.operation, question: row.question,
      sides: snapshot.sides.map((s, index) => ({ file_name: s.file_name, kind: s.kind, page: s.page, bbox: s.bbox, anchor_bbox: s.anchor_bbox,
        value: s.value, quote: s.quote, stage: s.stage, geometry: s.geometry,
        content_url: `/api/v1/verification/assignments/${row.assignment_id}/content/${index}`,
        view_label:s.preview?.label??null,fragment_url: (s.crop||s.preview) ? `/api/v1/verification/assignments/${row.assignment_id}/fragment/${index}` : null })) } };
}

const ASSIGNMENT_VIEW = `select a.id assignment_id,a.purpose,a.token,a.expires_at,v.id task_id,v.parameter,v.operation,v.question,v.snapshot_json,p.parameter_name
  from verification_assignments a join verification_tasks v on v.id=a.task_id join params p on p.code=v.parameter`;

async function allocateAnnotation(t:DB,user:string,random:()=>number,now:string,state="active",slot:number|null=null) {
    let groups = (await t.all<any>("select parameter,ready,answered from verification_coverage where ready>0 order by parameter"))
      .map((r) => ({ parameter: r.parameter as string, ready: Number(r.ready), answered: Number(r.answered) }));
    const mode = random();
    while (groups.length) {
      const parameter = chooseAnnotationParameter(groups, mode >= .5 && mode < .8 ? "undercovered" : "ordinary", random());
      // Balance eligible object/operation groups, not their candidate volumes.
      const recent = await t.all<any>(`select v.object_key,v.operation,v.snapshot_json from verification_assignments a
        join verification_tasks v on v.id=a.task_id where a.user_id=$1 and a.purpose='annotation'
        order by a.created_at desc,a.id limit 20`,[user]);
      const recentShas=[...new Set(recent.slice(0,5).flatMap(r=>annotationJson<AnnotationTask>(r.snapshot_json).sides.map(s=>s.sha256)))];
      const pick = async (hard:boolean) => {
        let strata=(await t.all<any>(`with verified as (
          select v.object_key,v.operation,count(distinct s.side->>'sha256')::integer verified_sources
          from (select distinct on (task_id) task_id,answer from verification_adjudications order by task_id,id desc) a join verification_tasks v on v.id=a.task_id
          cross join lateral jsonb_array_elements(v.snapshot_json->'sides') s(side)
          where v.parameter=$1 and a.answer in ('YES','NO') group by v.object_key,v.operation
        ) select v.object_key,v.operation,coalesce(max(c.verified_sources),0)::integer verified_sources
          from verification_tasks v left join verified c on c.object_key=v.object_key and c.operation=v.operation
          where v.state='ready' and v.parameter=$1 ${hard ? "and v.difficulty in ('hard','control')" : ""}
          and not exists(select 1 from verification_labels l where l.task_id=v.id and l.user_id=$2)
          group by v.object_key,v.operation order by v.object_key,v.operation`,[parameter,user]))
          .map(r=>({...r,verified_sources:Number(r.verified_sources),object_recent:recent.filter(p=>p.object_key===r.object_key).length,recent:recent.filter(p=>p.object_key===r.object_key&&p.operation===r.operation).length}));
        while(strata.length){
          const group=chooseAnnotationStratum(strata,mode>=.5&&mode<.8,random(),random())!;
          const threshold=random();
          const query=(after:boolean,avoidRecent:boolean)=>t.get<any>(`select v.* from verification_tasks v
            where v.state='ready' and v.parameter=$1 and v.object_key=$2 and v.operation=$3
            and not exists(select 1 from verification_labels l where l.task_id=v.id and l.user_id=$4)
            ${hard ? "and v.difficulty in ('hard','control')" : ""}
            ${avoidRecent ? "and not exists(select 1 from jsonb_array_elements(v.snapshot_json->'sides') s where s->>'sha256' in (select jsonb_array_elements_text($6::jsonb)))" : ""}
            and v.random_key ${after ? ">=" : "<"} $5 order by v.random_key limit 1 for update of v skip locked`,
            avoidRecent?[parameter,group.object_key,group.operation,user,threshold,JSON.stringify(recentShas)]:[parameter,group.object_key,group.operation,user,threshold]);
          const task=(recentShas.length ? await query(true,true)??await query(false,true):undefined)??await query(true,false)??await query(false,false);
          if(task)return task;
          strata=strata.filter(r=>r.object_key!==group.object_key||r.operation!==group.operation);
        }
        return undefined;
      };
      const task = (mode >= .8 ? await pick(true) : undefined) ?? await pick(false);
      if (!task) { groups = groups.filter((g) => g.parameter !== parameter); continue; }
      const id = randomUUID(), token = randomBytes(32).toString("hex"), expiry = new Date(Date.parse(now) + LEASE_MS).toISOString();
      await t.run("insert into verification_assignments(id,task_id,user_id,token,expires_at,created_at,state,buffer_slot) values($1,$2,$3,$4,$5,$6,$7,$8)", [id,task.id,user,token,expiry,now,state,slot]);
      await t.run("update verification_tasks set state='claimed' where id=$1", [task.id]);
      await t.run("update verification_coverage set ready=ready-1 where parameter=$1", [parameter]);
      const view = await t.get<any>(`${ASSIGNMENT_VIEW} where a.id=$1`, [id]);
      return { assignment: present(view) };
    }
    return { assignment: null };
}
export async function nextAnnotation(db: DB, user: string, random = Math.random, now = date()) {
  await reclaimExpired(db,user,now);
  return db.tx(async t=>{
    await t.get("select id from users where id=$1 for update",[user]);
    const own=await t.get<any>(`${ASSIGNMENT_VIEW} where a.user_id=$1 and a.state='active' and a.expires_at>$2`,[user,now]);
    if(own)return {assignment:present(own)};
    const buffered=await t.get<any>("select id from verification_assignments where user_id=$1 and state='buffered' and expires_at>$2 order by buffer_order limit 1 for update",[user,now]);
    if(buffered){
      await t.run("update verification_assignments set state='active',buffer_slot=null,expires_at=$2 where id=$1",[buffered.id,new Date(Date.parse(now)+LEASE_MS).toISOString()]);
      return {assignment:present(await t.get<any>(`${ASSIGNMENT_VIEW} where a.id=$1`,[buffered.id]))};
    }
    return allocateAnnotation(t,user,random,now);
  });
}
export async function prefetchAnnotations(db:DB,user:string,random=Math.random,now=date()) {
  await reclaimExpired(db,user,now);
  // Commit one allocation at a time: randomly chosen coverage rows must never
  // remain locked together in opposite orders across concurrent operators.
  for(let count=0;count<3;count++) {
    const added=await db.tx(async t=>{
      await t.get("select id from users where id=$1 for update",[user]);
      const active=await t.get<any>("select purpose from verification_assignments where user_id=$1 and state='active' and expires_at>$2",[user,now]);
      if(active?.purpose!=='annotation')return false;
      const existing=await t.all<any>("select buffer_slot from verification_assignments where user_id=$1 and state='buffered'",[user]);
      const slot=[1,2,3].find(n=>!existing.some(r=>r.buffer_slot===n));
      if(!slot)return false;
      return Boolean((await allocateAnnotation(t,user,random,now,'buffered',slot)).assignment);
    });
    if(!added)break;
  }
  return db.tx(async t=>{
    await t.get("select id from users where id=$1 for update",[user]);
    const active=await t.get<any>("select purpose from verification_assignments where user_id=$1 and state='active' and expires_at>$2",[user,now]);
    if(active?.purpose!=='annotation')return {assignments:[]};
    const rows=await t.all<any>(`${ASSIGNMENT_VIEW} where a.user_id=$1 and a.state='buffered' and a.expires_at>$2 order by a.buffer_order`,[user,now]);
    return {assignments:rows.map(present)};
  });
}
async function releaseBuffers(t:DB,user:string) {
  const rows=await t.all<any>(`update verification_assignments set state='expired',buffer_slot=null
    where user_id=$1 and state='buffered' returning task_id`,[user]);
  const returned=new Map<string,number>();
  for(const row of rows){
    const task=await t.get<any>("update verification_tasks set state='ready' where id=$1 and state='claimed' returning parameter",[row.task_id]);
    if(task)returned.set(task.parameter,(returned.get(task.parameter)??0)+1);
  }
  for(const parameter of [...returned.keys()].sort())await t.run("update verification_coverage set ready=ready+$2 where parameter=$1",[parameter,returned.get(parameter)]);
}
export async function releaseAnnotationBuffers(db:DB,user:string) {
  return db.tx(async t=>{await t.get("select id from users where id=$1 for update",[user]);await releaseBuffers(t,user);return {ok:true};});
}

export async function annotationHeartbeat(db: DB, user: string, id: string, token: string, now = date()) {
  const expiry = new Date(Date.parse(now) + LEASE_MS).toISOString();
  const r = await db.run("update verification_assignments set expires_at=$4 where id=$1 and user_id=$2 and token=$3 and state='active' and expires_at>$5", [id,user,token,expiry,now]);
  if (!r.rowCount) throw new HttpError(409, "Аренда задания истекла; получите задание заново");
  await db.run("update verification_assignments set expires_at=$2 where user_id=$1 and state='buffered' and expires_at>$3",[user,expiry,now]);
  return { expires_at: expiry };
}

export async function annotationSource(db: DB, user: string, id: string, side: number, now = date()) {
  if (!Number.isInteger(side) || side < 0 || side > 1) throw new HttpError(404, "Фрагмент не найден");
  const row = await db.get<any>(`${ASSIGNMENT_VIEW} where a.id=$1 and a.user_id=$2 and a.state in ('active','buffered') and a.expires_at>$3`, [id,user,now]);
  if (!row) throw new HttpError(403, "Документ доступен только в вашем действующем задании");
  const snapshot = annotationJson<AnnotationTask>(row.snapshot_json);
  const source = snapshot.sides[side];
  if (!source) throw new HttpError(404, "Фрагмент не найден");
  return source;
}

export async function submitAnnotation(db: DB, user: string, id: string, raw: unknown, now = date()) {
  const input = AnnotationAnswer.parse(raw);
  const requestDigest = hash({ assignment_id: id, ...input });
  return db.tx(async (t) => {
    await t.get("select id from users where id=$1 for update", [user]);
    const replay = await t.get<any>("select id,task_id,request_digest from verification_labels where user_id=$1 and idempotency_key=$2", [user,input.idempotency_key]);
    if (replay) {
      if (replay.request_digest !== requestDigest) throw new HttpError(409, "Этот ключ уже использован для другого ответа");
      return { id: replay.id, saved: true, replay: true };
    }
    const assignment = await t.get<any>("select * from verification_assignments where id=$1 and user_id=$2 for update", [id,user]);
    if (!assignment) throw new HttpError(404, "Назначение не найдено");
    if (assignment.state !== "active" || assignment.token !== input.token || Date.parse(assignment.expires_at) <= Date.parse(now)) throw new HttpError(409, "Аренда задания истекла или ответ уже сохранён");
    if (assignment.purpose !== "annotation") throw new HttpError(409,"Это задание предназначено для разбора куратором");
    const task = await t.get<any>("select * from verification_tasks where id=$1 for update", [assignment.task_id]);
    if(input.corrected_value!==null && task.operation!=="reading")throw new HttpError(400,"Исправление значения доступно только в задании на прочтение");
    const label = randomUUID();
    await t.run(`insert into verification_labels(id,assignment_id,task_id,user_id,answer,comment,corrected_value,idempotency_key,request_digest,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [label,id,task.id,user,input.answer,input.comment,input.corrected_value,input.idempotency_key,requestDigest,now]);
    const remaining = Number(task.review_count) + 1 < Number(task.required_reviews);
    await t.run("update verification_assignments set state='submitted' where id=$1", [id]);
    await t.run("update verification_tasks set state=$2,review_count=review_count+1 where id=$1", [task.id,remaining ? "ready" : "answered"]);
    const column = input.answer === "YES" ? "yes" : input.answer === "NO" ? "no" : "unsure";
    await t.run(`update verification_coverage set answered=answered+1,${column}=${column}+1,ready=ready+$2 where parameter=$1`, [task.parameter,remaining ? 1 : 0]);
    // A matching verdict generates a separate simple comparison, not a business decision.
    if (task.operation === "field_match" && input.answer === "YES" && !remaining) {
      const labels = await t.all<any>("select answer from verification_labels where task_id=$1", [task.id]);
      if (labels.every((l) => l.answer === "YES")) {
        const snapshot = annotationJson<AnnotationTask>(task.snapshot_json);
        await addTask(t, { ...snapshot, operation: "comparison" });
      }
    }
    return { id: label, saved: true, replay: false };
  });
}

export async function annotationStats(db: DB, user: string) {
  const rows = await db.all<any>("select answer,count(*) n from verification_labels where user_id=$1 group by answer", [user]);
  const counts = Object.fromEntries(rows.map((r) => [r.answer, Number(r.n)]));
  return { saved: rows.reduce((n,r) => n + Number(r.n),0), yes: counts.YES ?? 0, no: counts.NO ?? 0, unsure: counts.UNSURE ?? 0 };
}

export async function annotationCoverage(db: DB) {
  const rows = await db.all<any>(`select p.code parameter,p.parameter_name name,coalesce(c.ready,0) ready,coalesce(c.answered,0) answered,
    coalesce(c.yes,0) yes,coalesce(c.no,0) no,coalesce(c.unsure,0) unsure from params p left join verification_coverage c on c.parameter=p.code
    where p.code ~ '^M-[0-9]{3}$' and substring(p.code from 3)::integer between 1 and 132 order by p.code`);
  const ingestions = await db.all<any>("select id,source_version,cursor_json,inventory_json,updated_at from verification_ingestions order by updated_at desc limit 20");
  return { parameters: rows, ingestions: ingestions.map((r) => ({ ...r, cursor: annotationJson(r.cursor_json), inventory: annotationJson(r.inventory_json) })) };
}

export async function annotationQualityReport(db:DB) {
  const rows=await db.all<any>(`with label_counts as (
    select task_id,count(*)::integer labels,count(distinct user_id)::integer authors,
      count(*) filter(where answer='YES')::integer yes,count(*) filter(where answer='NO')::integer no,
      count(*) filter(where answer='UNSURE')::integer unsure,count(distinct answer)::integer variants
    from verification_labels group by task_id
  ), latest_review as (
    select distinct on(task_id) task_id,answer from verification_adjudications order by task_id,id desc
  ), totals as (
    select v.parameter,v.operation,count(*)::integer tasks,
      count(l.task_id)::integer labeled_tasks,coalesce(sum(l.labels),0)::integer labels,
      coalesce(sum(l.yes),0)::integer yes,coalesce(sum(l.no),0)::integer no,coalesce(sum(l.unsure),0)::integer unsure,
      count(*) filter(where l.authors>=2)::integer repeated_tasks,
      count(*) filter(where l.authors>=2 and l.variants=1)::integer agreeing_tasks,
      count(*) filter(where a.answer='YES')::integer curated_yes,
      count(*) filter(where a.answer='NO')::integer curated_no,
      count(*) filter(where a.answer='UNSURE')::integer curated_unsure
    from verification_tasks v left join label_counts l on l.task_id=v.id left join latest_review a on a.task_id=v.id
    group by v.parameter,v.operation
  ) select p.code parameter,o.operation,t.tasks,t.labeled_tasks,t.labels,t.yes,t.no,t.unsure,
    t.repeated_tasks,t.agreeing_tasks,t.curated_yes,t.curated_no,t.curated_unsure from params p
    cross join (values('reading'),('field_match'),('comparison'),('missing')) o(operation)
    left join totals t on t.parameter=p.code and t.operation=o.operation
    where p.code ~ '^M-[0-9]{3}$' and substring(p.code from 3)::integer between 1 and 132 order by p.code,o.operation`);
  const items=rows.map(r=>{
    const keys=["tasks","labeled_tasks","labels","yes","no","unsure","repeated_tasks","agreeing_tasks","curated_yes","curated_no","curated_unsure"] as const;
    const counts=Object.fromEntries(keys.map(k=>[k,Number(r[k]??0)])) as Record<(typeof keys)[number],number>;
    return {parameter:r.parameter,operation:r.operation,...counts,
      unsure_rate:counts.labels?counts.unsure/counts.labels:null,
      agreement:annotationInterval(counts.agreeing_tasks,counts.repeated_tasks),
      precision:r.operation==='reading'?annotationInterval(counts.curated_yes,counts.curated_yes+counts.curated_no):null,
      recall:null,recall_reason:"missing_ground_truth_not_available"};
  });
  return {schema:"annotation-quality.v1",generated_at:date(),items,
    interpretation:"Reading precision uses independent curator YES/NO verdicts. Agreement is exact agreement across at least two distinct operators. Rates describe this annotated sample, not the whole corpus; selection bias and shared documents remain."};
}

export async function annotationReviews(db: DB, author: string) {
  const rows = await db.all<any>(`select v.id,v.parameter,p.parameter_name name,v.review_count,
    count(l.id)::integer labels,count(distinct l.answer)::integer answers,
    bool_or(l.answer='UNSURE') unsure from verification_tasks v join params p on p.code=v.parameter
    join verification_labels l on l.task_id=v.id where v.state='answered'
    and not exists(select 1 from verification_labels own where own.task_id=v.id and own.user_id=$1)
    and not exists(select 1 from verification_adjudications a where a.task_id=v.id)
    group by v.id,p.parameter_name order by bool_or(l.answer='UNSURE') desc,count(distinct l.answer) desc,v.id limit 100`,[author]);
  return {tasks:rows};
}
export async function claimAnnotationReview(db: DB, user: string, taskId: string, now=date()) {
  await reclaimExpired(db,user,now);
  return db.tx(async(t) => {
    await t.get("select id from users where id=$1 for update",[user]);
    const own = await t.get<any>(`${ASSIGNMENT_VIEW} where a.user_id=$1 and a.state='active'`,[user]);
    if (own) {
      if (own.purpose === "review" && own.task_id === taskId) return {assignment:present(own)};
      throw new HttpError(409,"Сначала завершите текущее задание");
    }
    const task = await t.get<any>("select * from verification_tasks where id=$1 for update",[taskId]);
    if (!task || task.state !== 'answered') throw new HttpError(409,"Задание ещё не размечено");
    if (await t.get("select 1 from verification_labels where task_id=$1 and user_id=$2",[taskId,user])) throw new HttpError(403,"Нужен независимый разбор другим куратором");
    if (await t.get("select 1 from verification_assignments where task_id=$1 and state='active'",[taskId])) throw new HttpError(409,"Задание уже разбирает другой куратор");
    await releaseBuffers(t,user);
    const id=randomUUID(), token=randomBytes(32).toString('hex');
    await t.run("insert into verification_assignments(id,task_id,user_id,token,expires_at,created_at,purpose) values($1,$2,$3,$4,$5,$6,'review')",[id,taskId,user,token,new Date(Date.parse(now)+LEASE_MS).toISOString(),now]);
    return {assignment:present(await t.get<any>(`${ASSIGNMENT_VIEW} where a.id=$1`,[id]))};
  });
}
export const AdjudicationInput = z.object({ assignment_id:z.string().max(100),token:z.string().min(20).max(100),answer: z.enum(["YES","NO","UNSURE"]), corrected_value: z.string().max(2000).nullable().default(null), comment: z.string().min(1).max(2000) }).strict().refine(a=>a.corrected_value===null||a.answer==='NO',"Исправление значения требует ответа Нет");
export async function adjudicateAnnotation(db: DB, author: string, task: string, raw: unknown, now=date()) {
  const answer=AdjudicationInput.parse(raw);
  return db.tx(async(t) => {
    await t.get("select id from users where id=$1 for update",[author]);
    const lease=await t.get<any>("select * from verification_assignments where id=$1 and task_id=$2 and user_id=$3 for update",[answer.assignment_id,task,author]);
    if (!lease || lease.purpose !== 'review' || lease.token !== answer.token) throw new HttpError(403,"Нет назначения на независимый разбор");
    // A lost acknowledgement must not append a second adjudication.
    const old=await t.get<any>("select * from verification_adjudications where task_id=$1 and author=$2 and created_at >= $3 order by id desc limit 1",[task,author,lease.created_at]);
    if (lease.state === 'submitted' && old) {
      if (old.answer !== answer.answer || old.comment !== answer.comment || old.corrected_value !== answer.corrected_value) throw new HttpError(409,"Разбор уже сохранён с другим ответом");
      return {id:Number(old.id),saved:true};
    }
    if (lease.state !== 'active' || Date.parse(lease.expires_at)<=Date.parse(now)) throw new HttpError(409,"Аренда разбора истекла");
    if(answer.corrected_value!==null) {
      const row=await t.get<any>("select operation from verification_tasks where id=$1",[task]);
      if(row?.operation!=="reading")throw new HttpError(400,"Исправление значения доступно только в задании на прочтение");
    }
    const result=await t.run("insert into verification_adjudications(task_id,author,answer,comment,corrected_value,created_at) values($1,$2,$3,$4,$5,$6) returning id",[task,author,answer.answer,answer.comment,answer.corrected_value,now]);
    await t.run("update verification_assignments set state='submitted' where id=$1",[lease.id]);
    return {id:Number(result.rows[0].id),saved:true};
  });
}

export async function releaseAnnotationDataset(db: DB, author: string) {
  return db.tx(async (t) => {
    const rows = await t.all<any>(`select v.*,a.id adjudication_id,a.answer,a.corrected_value,a.comment,a.author,a.created_at adjudicated_at from verification_tasks v
      join lateral(select * from verification_adjudications where task_id=v.id order by id desc limit 1) a on true
      where a.answer in ('YES','NO') order by v.id limit 10001`);
    if (rows.length>10000) throw new HttpError(409,"Более 10000 примеров: требуется отдельный выпуск с явным scope");
    if (!rows.length) throw new HttpError(409, "Нет разобранных куратором примеров для выпуска");
    const memberships=await t.all<any>("select distinct object_key,sha256 from verification_source_groups");
    const groups = splitAnnotationGroups([...memberships.map((r,i)=>({id:`membership-${i}`,object_key:r.object_key,shas:[r.sha256]})),...rows.map((r) => ({ id: r.id, object_key: r.object_key, shas: annotationJson<AnnotationTask>(r.snapshot_json).sides.map((s) => s.sha256) }))]);
    const allLabels=await t.all<any>("select task_id,id,user_id,answer,comment,corrected_value,created_at from verification_labels where task_id in (select jsonb_array_elements_text($1::jsonb)) order by created_at,id",[JSON.stringify(rows.map(r=>r.id))]);
    const byTask=new Map<string,any[]>();
    for (const {task_id,...label} of allLabels) { const bucket=byTask.get(task_id) ?? []; bucket.push({...label,comment:censorAnnotationComment(label.comment)}); byTask.set(task_id,bucket); }
    const entries = [];
    for (const row of rows) {
      const labels = byTask.get(row.id) ?? [];
      entries.push({ id: row.id, task: annotationJson<AnnotationTask>(row.snapshot_json), labels,
        adjudication: { id:Number(row.adjudication_id), answer: row.answer, corrected_value: row.corrected_value, comment: censorAnnotationComment(row.comment), author: row.author, at: row.adjudicated_at }, ...groups[row.id] });
    }
    const digest = hash(entries), id = `annotations-${digest.slice(0,24)}`;
    const manifest = { schema: "annotation-dataset.v1", count: entries.length, digest, type: "human_verified_tasks_not_ocr_transcriptions", split_method: "objects_and_shared_sources", comment_policy:"masked-profanity.v1" };
    const existing = await t.get("select id from verification_datasets where id=$1", [id]);
    if (!existing) {
      await t.run("insert into verification_datasets(id,author,manifest_json,digest) values($1,$2,$3,$4)", [id,author,JSON.stringify(manifest),digest]);
      for (const row of entries) await t.run("insert into verification_dataset_items(dataset_id,task_id,snapshot_json,split) values($1,$2,$3,$4)", [id,row.id,JSON.stringify(row),row.split]);
    }
    return { id, manifest, replay: Boolean(existing) };
  });
}
