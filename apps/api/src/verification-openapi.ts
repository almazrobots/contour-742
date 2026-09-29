// T-244: independent annotation contract, separate from inspection verdicts.
const S={type:"string"}, I={type:"integer"}, B={type:"boolean"}, O={type:"object"};
const str=(max:number,min=0)=>({...S,minLength:min,maxLength:max});
const obj=(properties:Record<string,unknown>,required=Object.keys(properties),strict=false)=>({type:"object",properties,required,...(strict?{additionalProperties:false}:{})});
const arr=(items:unknown)=>({type:"array",items});
const en=(values:string[])=>({...S,enum:values});
const nullable=(schema:unknown)=>{const value=schema as {enum?:unknown[]};return {...schema as object,nullable:true,...(value.enum?{enum:[...value.enum,null]}:{})};};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const json=(schema:unknown)=>({content:{"application/json":{schema}}});
const path=(name:string,schema:unknown=str(100,1))=>({name,in:"path",required:true,schema});
const body=(schema:unknown)=>({requestBody:{required:true,...json(schema)}});
const op=(summary:string,schema:unknown,parameters:unknown[]=[],request?:unknown)=>({summary,parameters,security:[{bearer:[]}],...(request?body(request):{}),responses:{200:{description:"Успех",...json(schema)},400:{description:"Некорректный запрос",...json(ref("Error"))},401:{description:"Нужен вход",...json(ref("Error"))},403:{description:"Нет доступа",...json(ref("Error"))},409:{description:"Конфликт состояния",...json(ref("Error"))}}});
const box={type:"array",minItems:4,maxItems:4,items:{type:"number",minimum:0,maximum:1},nullable:true};
const sha={...S,pattern:"^[a-f0-9]{64}$"};
const answer=en(["YES","NO","UNSURE"]);
const source=obj({sha256:sha,file_name:str(600,1),kind:en(["pdf","image","jpg","png","tif","docx","xlsx","xml"]),page:{...I,minimum:1,maximum:100000},bbox:box,anchor_bbox:box,value:str(2000),quote:str(4000),object_key:str(200,1),stage:nullable(en(["PD","RD","ID"])),file_id:nullable(str(100)),inspection_id:nullable(str(100)),revision:nullable(str(100)),artifact_sha256:nullable(sha),geometry:en(["word","coarse_band","none"]),preview:nullable(obj({key:sha,sha256:sha,label:str(600,1),revision:en(['structured-original.v1'])})),crop:nullable(obj({page:{...I,minimum:1},band:{...I,minimum:0,maximum:3},sha256:sha})),provenance:O},["sha256","file_name","kind","page","object_key"],true);
const task=obj({parameter:{...S,pattern:"^M-(?:00[1-9]|0[1-9]\\d|1[0-2]\\d|13[0-2])$"},operation:en(["reading","field_match","comparison","missing"]),sides:{...arr(source),minItems:1,maxItems:2},difficulty:en(["ordinary","hard","control"]),source_version:str(200,1)},["parameter","operation","sides"],true);
const side=obj({file_name:S,kind:S,page:I,bbox:box,anchor_bbox:box,value:S,quote:S,stage:nullable(S),geometry:S,content_url:S,fragment_url:nullable(S),view_label:nullable(S)});
export const annotationSchemas={
  AnnotationAssignment:obj({id:S,purpose:en(["annotation","review"]),token:S,expires_at:{...S,format:"date-time"},task:obj({id:S,parameter:S,name:S,operation:S,question:S,sides:arr(side)})}),
  AnnotationTaskInput:task,
};
const assignment=obj({assignment:nullable(ref("AnnotationAssignment"))});
const saved=obj({id:S,saved:B,replay:B});
const stats=obj({saved:I,yes:I,no:I,unsure:I});
const base="/api/v1/verification";
const binary={summary:"Источник только собственного действующего задания",parameters:[path("id"),path("side",{...I,minimum:0,maximum:1})],security:[{bearer:[]}],responses:{200:{description:"Исходный документ",content:{"application/pdf":{schema:{type:"string",format:"binary"}},"image/png":{schema:{type:"string",format:"binary"}},"application/octet-stream":{schema:{type:"string",format:"binary"}}}},206:{description:"Часть источника",content:{"application/octet-stream":{schema:{type:"string",format:"binary"}}}},403:{description:"Нет назначения",...json(ref("Error"))}}};
const libraryItem=obj({id:S,answer,comment:S,comment_censored:B,corrected_value:nullable(S),created_at:S,author_name:S,starred:B,task:obj({id:S,parameter:S,name:S,operation:S,question:S,sides:arr(side)})});
export const annotationPaths={
  [`${base}/library`]:{get:op("Витрина сохранённых ответов: свои или все для куратора",obj({items:arr(libraryItem),total:I,next_cursor:nullable(S),scope:en(["mine","all"]),comment_policy:S}),[{name:"cursor",in:"query",schema:{...S,format:"uuid"}},{name:"starred",in:"query",schema:en(["true","false"])}])},
  [`${base}/library/{id}/mark`]:{post:op("Личная отметка хорошего примера, не независимый разбор",obj({id:S,starred:B}),[path("id")],obj({starred:B},undefined,true))},
  [`${base}/library/{id}/content/{side}`]:{get:{...binary,summary:"Закреплённый исходник доступного сохранённого ответа"}},
  [`${base}/library/{id}/fragment/{side}`]:{get:{...binary,summary:"Фрагмент доступного сохранённого ответа"}},
  [`${base}/assignments/next`]:{post:op("Получить или продолжить задание",assignment)},
  [`${base}/assignments/prefetch`]:{post:op("Подготовить до трёх следующих назначений",obj({assignments:arr(ref("AnnotationAssignment"))}))},
  [`${base}/assignments/release-buffer`]:{post:op("Освободить резервы подготовки",obj({ok:B}))},
  [`${base}/assignments/{id}/heartbeat`]:{post:op("Продлить активную аренду",obj({expires_at:S}),[path("id")],obj({token:str(100,20)},undefined,true))},
  [`${base}/assignments/{id}/labels`]:{post:op("Сохранить ответ один раз",saved,[path("id")],obj({token:str(100,20),idempotency_key:str(100,16),answer,comment:str(2000),corrected_value:nullable(str(2000))},["token","idempotency_key","answer"],true))},
  [`${base}/assignments/{id}/content/{side}`]:{get:binary},
  [`${base}/assignments/{id}/fragment/{side}`]:{get:binary},
  [`${base}/me/stats`]:{get:op("Мои сохранённые ответы",stats)},
  [`${base}/coverage`]:{get:op("Покрытие всех 132 параметров",obj({parameters:arr(obj({parameter:S,name:S,ready:I,answered:I,yes:I,no:I,unsure:I})),ingestions:arr(obj({id:S,source_version:S,cursor:O,inventory:O,updated_at:S}))}))},
  [`${base}/quality`]:{get:op("Качество человеческой разметки по параметру и операции",obj({schema:S,generated_at:S,interpretation:S,items:arr(obj({parameter:S,operation:S,tasks:I,labeled_tasks:I,labels:I,yes:I,no:I,unsure:I,repeated_tasks:I,agreeing_tasks:I,curated_yes:I,curated_no:I,curated_unsure:I,unsure_rate:nullable({type:"number"}),agreement:nullable(O),precision:nullable(O),recall:nullable({type:"number"}),recall_reason:S}))}))},
  [`${base}/ingestions`]:{post:op("Идемпотентное наполнение очереди",obj({id:S,inserted:I,duplicates:I,cursor:O}),[],obj({id:str(100,1),source_version:str(200,1),tasks:{...arr(ref("AnnotationTaskInput")),maxItems:100},source_associations:{...arr(obj({object_key:str(200,1),sha256:sha},undefined,true)),maxItems:1000},cursor:O,inventory:O},["id","source_version","tasks"],true))},
  [`${base}/reviews`]:{get:op("Очередь независимого разбора",obj({tasks:arr(obj({id:S,parameter:S,name:S,review_count:I,labels:I,answers:I,unsure:B}))}))},
  [`${base}/tasks/{id}/review`]:{post:op("Взять независимый разбор",assignment,[path("id")])},
  [`${base}/tasks/{id}/adjudications`]:{post:op("Сохранить разбор куратора",obj({id:I,saved:B}),[path("id")],obj({assignment_id:str(100),token:str(100,20),answer,corrected_value:nullable(str(2000)),comment:str(2000,1)},["assignment_id","token","answer","comment"],true))},
  [`${base}/datasets/release`]:{post:op("Зафиксировать версию проверенного набора",obj({id:S,manifest:obj({schema:S,count:I,digest:sha,type:S,split_method:S}),replay:B}))},
  [`${base}/datasets/{id}/items`]:{get:op("Выгрузить зафиксированные примеры",obj({manifest:O,items:arr(O),limit:I,offset:I}),[path("id"),{name:"limit",in:"query",schema:{...I,minimum:1,maximum:500}},{name:"offset",in:"query",schema:{...I,minimum:0,maximum:1000000}}])},
  "/api/v1/admin/verifiers":{post:op("Создать учётную запись верификатора",obj({id:S,login:S,name:S,role:en(["verifier"])}),[],obj({login:{...str(80,3),pattern:"^[a-zA-Z0-9._-]{3,80}$"},name:str(100,1),password:str(200,12)},undefined,true))},
};
