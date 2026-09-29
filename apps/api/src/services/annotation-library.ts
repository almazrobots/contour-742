import {z} from 'zod';
import type {DB} from '../db.ts';
import type {AnnotationTask} from '../domain/data-verification.ts';
import {allowed} from '../domain/access.ts';
import {censorAnnotationComment} from '../domain/annotation-comments.ts';
import {annotationJson} from './data-verification.ts';
import {HttpError} from './inspections.ts';

export const LibraryQuery=z.object({cursor:z.string().uuid().optional(),starred:z.enum(['true','false']).default('false')}).strict();
export const LibraryMark=z.object({starred:z.boolean()}).strict();
type Viewer={id:string;role:string};
async function ownLabel(db:DB,user:Viewer,id:string){
  const row=await db.get<any>(`select l.*,v.snapshot_json,v.parameter,v.operation,v.question,p.parameter_name,u.name author_name
    from verification_labels l join verification_tasks v on v.id=l.task_id join params p on p.code=v.parameter join users u on u.id=l.user_id
    where l.id=$1 and ($2 or l.user_id=$3)`,[id,allowed(user.role,'verification.manage'),user.id]);
  if(!row)throw new HttpError(404,'Ответ не найден');
  return row;
}
function present(row:any){
  const task=annotationJson<AnnotationTask>(row.snapshot_json),comment=censorAnnotationComment(row.comment);
  return {id:row.id,answer:row.answer,comment,comment_censored:comment!==row.comment,corrected_value:row.corrected_value,
    created_at:new Date(row.created_at).toISOString(),author_name:row.author_name,starred:Boolean(row.starred),
    task:{id:row.task_id,parameter:row.parameter,name:row.parameter_name,operation:row.operation,question:row.question,
      sides:task.sides.map((s,i)=>({file_name:s.file_name,kind:s.kind,page:s.page,bbox:s.bbox,anchor_bbox:s.anchor_bbox,
        value:s.value,quote:s.quote,stage:s.stage,geometry:s.geometry,
        content_url:`/api/v1/verification/library/${row.id}/content/${i}`,
        view_label:s.preview?.label??null,fragment_url:(s.crop||s.preview)?`/api/v1/verification/library/${row.id}/fragment/${i}`:null}))}};
}
export async function annotationLibrary(db:DB,user:Viewer,raw:unknown){
  const query=LibraryQuery.parse(raw),all=allowed(user.role,'verification.manage');
  const cursor=query.cursor?await ownLabel(db,user,query.cursor):null;
  const values=[user.id,all,query.starred==='true',cursor?.created_at??null,cursor?.id??null];
  const rows=await db.all<any>(`select l.*,v.snapshot_json,v.parameter,v.operation,v.question,p.parameter_name,u.name author_name,m.starred
    from verification_labels l join verification_tasks v on v.id=l.task_id join params p on p.code=v.parameter join users u on u.id=l.user_id
    left join verification_library_marks m on m.label_id=l.id and m.user_id=$1
    where ($2 or l.user_id=$1) and (not $3 or m.starred=true)
      and ($4::timestamptz is null or (l.created_at,l.id)<($4::timestamptz,$5::text))
    order by l.created_at desc,l.id desc limit 25`,values);
  const total=await db.get<any>(`select count(*) n from verification_labels l left join verification_library_marks m on m.label_id=l.id and m.user_id=$1
    where ($2 or l.user_id=$1) and (not $3 or m.starred=true)`,values.slice(0,3));
  return {items:rows.slice(0,24).map(present),next_cursor:rows.length>24?rows[23].id:null,total:Number(total.n),scope:all?'all':'mine',comment_policy:'masked-profanity.v1'};
}
export async function annotationLibrarySource(db:DB,user:Viewer,id:string,index:number){
  if(!Number.isInteger(index)||index<0||index>1)throw new HttpError(404,'Фрагмент не найден');
  const row=await ownLabel(db,user,id);
  const side=annotationJson<AnnotationTask>(row.snapshot_json).sides[index];
  if(!side)throw new HttpError(404,'Фрагмент не найден');
  return side;
}
export async function markAnnotationLibrary(db:DB,user:Viewer,id:string,raw:unknown){
  const input=LibraryMark.parse(raw);await ownLabel(db,user,id);
  await db.run(`insert into verification_library_marks(label_id,user_id,starred) values($1,$2,$3)
    on conflict(label_id,user_id) do update set starred=excluded.starred,updated_at=now()`,[id,user.id,input.starred]);
  return {id,starred:input.starred};
}
