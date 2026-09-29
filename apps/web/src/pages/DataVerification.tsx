import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, session } from "../lib/api";
import { canAnnotate, canManageAnnotations } from "../lib/access";
import { AnnotationDocument, type AnnotationSide } from "../components/AnnotationDocument";
type Answer="YES"|"NO"|"UNSURE";
type Assignment={id:string;purpose:"annotation"|"review";token:string;expires_at:string;task:{id:string;parameter:string;name:string;question:string;operation:string;sides:AnnotationSide[]}};
const answers:Answer[]=["YES","NO","UNSURE"], captions={YES:"Да",NO:"Нет",UNSURE:"Не уверен"};
export function DataVerification(){
  const role=session()?.user.role;
  const [assignment,setAssignment]=useState<Assignment|null>(null),[started,setStarted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[answer,setAnswer]=useState<Answer|null>(null),[comment,setComment]=useState(""),[correction,setCorrection]=useState(""),[textMode,setTextMode]=useState(false),[saved,setSaved]=useState(0),[ready,setReady]=useState<Record<number,boolean>>({}),[expired,setExpired]=useState(false);
  const [buffer,setBuffer]=useState<Assignment[]>([]);
  const [,refreshPreparation]=useState(0);
  const prepared=useRef<Record<string,Record<number,boolean>>>({});
  const commentRef=useRef<HTMLTextAreaElement>(null),guard=useRef(false),key=useRef(crypto.randomUUID());
  const reset=(a:Assignment|null)=>{setAssignment(a);setAnswer(null);setComment("");setCorrection("");setTextMode(false);setReady(a?prepared.current[a.id]??{}:{});setExpired(false);key.current=crypto.randomUUID();};
  const next=useCallback(async()=>{if(guard.current)return;guard.current=true;setBusy(true);setError("");try{const r=await api<{assignment:Assignment|null}>("/api/v1/verification/assignments/next",{method:"POST"});reset(r.assignment);setStarted(true);}catch(e:any){setError(e.message);}finally{guard.current=false;setBusy(false);}},[]);
  useEffect(()=>{
    if(!assignment||assignment.purpose!=='annotation'){setBuffer([]);return;}
    let alive=true;
    void api<{assignments:Assignment[]}>("/api/v1/verification/assignments/prefetch",{method:"POST"}).then(r=>{
      if(!alive)return;const rows=r.assignments.filter(a=>a.id!==assignment.id);setBuffer(rows);
      const keep=new Set([assignment.id,...rows.map(a=>a.id)]);for(const id of Object.keys(prepared.current))if(!keep.has(id))delete prepared.current[id];
    }).catch(()=>{if(alive)setBuffer([]);});
    return()=>{alive=false;};
  },[assignment?.id]);
  useEffect(()=>{if(!assignment)return;const timer=setInterval(()=>{void api(`/api/v1/verification/assignments/${assignment.id}/heartbeat`,{body:{token:assignment.token}}).catch(e=>{if(e instanceof ApiError&&e.status===409){setExpired(true);setError(e.message);}});},60000);return()=>clearInterval(timer);},[assignment]);
  useEffect(()=>{void api<{saved:number}>("/api/v1/verification/me/stats").then(r=>setSaved(r.saved)).catch(()=>{});},[]);
  const submit=useCallback(async()=>{
    if(!assignment||!answer||guard.current||expired)return;
    guard.current=true;setBusy(true);setError("");
    try{
      if(assignment.purpose==="review") {
        if(!comment.trim()){setError("Для независимого разбора укажите основание");return;}
        await api(`/api/v1/verification/tasks/${assignment.task.id}/adjudications`,{body:{assignment_id:assignment.id,token:assignment.token,answer,comment,corrected_value:correction||null}});
        reset(null);setStarted(false);
      }else{
        await api(`/api/v1/verification/assignments/${assignment.id}/labels`,{body:{token:assignment.token,idempotency_key:key.current,answer,comment,corrected_value:correction||null}});
        setSaved(n=>n+1);
        // The previous answer is durable before any request for the next card.
        try { const r=await api<{assignment:Assignment|null}>("/api/v1/verification/assignments/next",{method:"POST"});reset(r.assignment); } catch(e:any) { reset(null);setError(`Ответ сохранён. Не удалось получить следующее задание: ${e.message}`);setStarted(false); }
      }
    }catch(e:any){setError(e.message);if(e instanceof ApiError&&e.status===409)setExpired(true);}finally{guard.current=false;setBusy(false);}
  },[assignment,answer,comment,correction,expired]);
  const select=useCallback((a:Answer)=>{if(busy||expired)return;if(a!=="UNSURE"&&assignment?.task.sides.some((_,i)=>!ready[i])){setError("Дождитесь источника или выберите «Не уверен»");return;}setError("");setAnswer(a);if(a!=="NO")setCorrection("");setTextMode(false);setTimeout(()=>commentRef.current?.focus(),0);},[busy,expired,assignment,ready]);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{
    if(!assignment||busy||expired||e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;
    if(e.repeat){if(!comment.length)e.preventDefault();return;}
    const target=e.target as HTMLElement;
    if(target.tagName==="INPUT"||target.tagName==="SELECT"||target.closest(".annotation-management"))return;
    if(e.key==="Enter"&&answer&&!e.shiftKey){e.preventDefault();void submit();return;}
    const digit=Number(e.key);if(!Number.isInteger(digit)||digit<1||digit>3)return;
    if(target.tagName==="TEXTAREA"&&(comment.length>0||textMode||answers[digit-1]!==answer))return;
    e.preventDefault();const a=answers[digit-1];if(a===answer&&!comment.length)void submit();else select(a);
  };window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);},[assignment,busy,expired,answer,comment,textMode,submit,select]);
  if(!canAnnotate(role))return <div className="page"><h1>Разметка данных</h1><p>Этой роли недоступна выдача заданий.</p></div>;
  return <div className="page annotation-page"><div className="row" style={{justifyContent:"space-between"}}><h1>Разметка данных</h1><span className="mute">Сохранено ответов: <b data-testid="annotation-saved">{saved}</b></span></div>
    <p className="mute">Проверьте только то, что видно в документе. Если фрагмент неоднозначен, выберите «Не уверен».</p>
    {error&&<p role="alert" className="annotation-error">{error}</p>}
    {!assignment&&<div className="card annotation-start"><h2>{started?"Доступных заданий пока нет":"Готовы заступить на смену?"}</h2><p>Один вопрос, один или два фрагмента, три варианта ответа.</p><button className="btn primary" disabled={busy} onClick={()=>void next()}>{busy?"Получаю…":"Получить задание"}</button></div>}
    {assignment&&<div className="annotation-workspace"><div className="annotation-evidence">{[assignment,...buffer.filter(b=>b.id!==assignment.id)].map(card=><div key={card.id} data-assignment-id={card.id} className={`annotation-sources ${card.task.sides.length===1?"single":""}`} style={{display:card.id===assignment.id?undefined:"none"}}>{card.task.sides.map((s,i)=><AnnotationDocument key={s.content_url} side={s} background={card.id!==assignment.id} onReady={v=>{
      const row=prepared.current[card.id]??(prepared.current[card.id]={});if(row[i]===v)return;row[i]=v;
      if(card.id===assignment.id)setReady(r=>({...r,[i]:v}));else refreshPreparation(n=>n+1);
    }}/>)}</div>)}</div><aside className="annotation-review"><div className="annotation-question"><div className="small mute">{assignment.task.parameter} · {assignment.task.name}{assignment.purpose==="review"?" · независимый разбор":""}</div><h2>{assignment.task.question}</h2></div><div className="annotation-answer"><p className="small mute" role="status">{busy?"Сохраняю ответ…":answer?`Выбрано: ${captions[answer]}. Enter — сохранить`:"1 / 2 / 3 — выбрать ответ"}</p>{buffer.length>0&&<p className="small mute" data-testid="annotation-prefetched">Готово заранее: {buffer.filter(b=>b.task.sides.every((_,i)=>prepared.current[b.id]?.[i])).length} из {buffer.length}</p>}<div className="row">{answers.map((a,i)=><button key={a} className={`btn ${answer===a?"primary":""}`} disabled={busy||expired} onClick={()=>{if(answer===a&&!comment.length&&!textMode)void submit();else select(a);}}><kbd>{i+1}</kbd> {captions[a]}</button>)}</div>
    {answer&&<div className="stack"><label>Комментарий — по желанию<textarea ref={commentRef} className="input" value={comment} maxLength={2000} rows={2} onChange={e=>setComment(e.target.value)} placeholder="Комментарий или Enter, чтобы отправить" disabled={busy||expired}/></label><div className="row"><button className="btn" onClick={()=>{setTextMode(true);commentRef.current?.focus();}}>Вводить текст, включая цифры</button><span className="small mute">Enter — отправить · Shift+Enter — новая строка · повтор цифры — без комментария</span></div>{answer==="NO"&&assignment.task.operation==="reading"&&<label>Правильное значение — если видно<input className="input" value={correction} maxLength={2000} onChange={e=>setCorrection(e.target.value)} disabled={busy||expired}/></label>}<button className="btn primary" disabled={busy||expired} onClick={()=>void submit()}>{busy?"Сохраняю…":"Сохранить и продолжить"}</button></div>}
    {expired&&<button className="btn" disabled={busy} onClick={()=>void next()}>Получить действующее задание</button>}</div></aside></div>}
    {canManageAnnotations(role)&&<AnnotationManagement onClaim={a=>{reset(a);setStarted(true);}} active={Boolean(assignment)}/>}
  </div>;
}
function AnnotationManagement({onClaim,active}:{onClaim:(a:Assignment)=>void;active:boolean}){
  const [coverage,setCoverage]=useState<any>(null),[reviews,setReviews]=useState<any[]>([]),[open,setOpen]=useState(false),[error,setError]=useState(""),[released,setReleased]=useState(""),[account,setAccount]=useState({login:"",name:"",password:""});
  const load=async()=>{try{const [c,r]=await Promise.all([api("/api/v1/verification/coverage"),api("/api/v1/verification/reviews")]);setCoverage(c);setReviews(r.tasks);}catch(e:any){setError(e.message);}};
  return <section className="annotation-management"><button className="btn" onClick={()=>{setOpen(v=>!v);void load();}}>Управление разметкой</button>{open&&<><h2>Покрытие и независимый разбор</h2>{error&&<p role="alert">{error}</p>}<button className="btn" onClick={()=>void load()}>Обновить</button><AnnotationQualityDownload/><div className="annotation-coverage"><table><thead><tr><th>Параметр</th><th>В очереди</th><th>Ответов</th><th>Да / нет / не уверен</th></tr></thead><tbody>{coverage?.parameters.map((r:any)=><tr key={r.parameter}><td>{r.parameter} · {r.name}</td><td>{r.ready||"Нет кандидатов"}</td><td>{r.answered}</td><td>{r.yes} / {r.no} / {r.unsure}</td></tr>)}</tbody></table></div><h3>Независимый разбор</h3>{reviews.map(r=><div className="row" key={r.id}><span>{r.parameter} · {r.name} · {r.unsure?"Есть сомнение":r.answers>1?"Ответы расходятся":"Контрольный разбор"}</span><button className="btn" disabled={active} onClick={()=>{void api<{assignment:Assignment}>(`/api/v1/verification/tasks/${r.id}/review`,{method:"POST"}).then(v=>onClaim(v.assignment)).catch(e=>setError(e.message));}}>Разобрать</button></div>)}{!reviews.length&&<p>Примеров для независимого разбора пока нет.</p>}<button className="btn" onClick={()=>{void api("/api/v1/verification/datasets/release",{method:"POST"}).then(r=>setReleased(r.id)).catch(e=>setError(e.message));}}>Зафиксировать проверенный набор</button>{released&&<p>Версия: {released}</p>}{session()?.user.role==="admin"&&<form onSubmit={e=>{e.preventDefault();void api("/api/v1/admin/verifiers",{body:account}).then(()=>{setAccount({login:"",name:"",password:""});setError("Верификатор создан");}).catch(e=>setError(e.message));}}><h3>Новый верификатор</h3><input className="input" required placeholder="Логин" value={account.login} onChange={e=>setAccount({...account,login:e.target.value})}/><input className="input" required placeholder="Имя" value={account.name} onChange={e=>setAccount({...account,name:e.target.value})}/><input className="input" required type="password" minLength={12} placeholder="Пароль, минимум 12 символов" autoComplete="new-password" value={account.password} onChange={e=>setAccount({...account,password:e.target.value})}/><button className="btn">Создать</button></form>}</>}</section>;
}
function AnnotationQualityDownload(){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const download=async()=>{
    setBusy(true);setError("");
    try{
      const report=await api("/api/v1/verification/quality");
      const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.href=url;link.download="annotation-quality.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  return <div><button className="btn" disabled={busy} onClick={()=>void download()}>{busy?"Готовлю отчёт…":"Скачать отчёт о качестве"}</button>{error&&<p role="alert">{error}</p>}<p className="small mute">Точность появляется после независимого разбора. Без проверки пропусков полнота не рассчитывается.</p></div>;
}
