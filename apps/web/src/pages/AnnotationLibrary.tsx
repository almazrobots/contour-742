import {useEffect,useState} from 'react';
import {api,session} from '../lib/api';
import {canAnnotate} from '../lib/access';
import {AnnotationDocument,type AnnotationSide} from '../components/AnnotationDocument';
type Item={id:string;answer:'YES'|'NO'|'UNSURE';comment:string;comment_censored:boolean;corrected_value:string|null;created_at:string;author_name:string;starred:boolean;task:{parameter:string;name:string;question:string;operation:string;sides:AnnotationSide[]}};
type Page={items:Item[];total:number;next_cursor:string|null;scope:'all'|'mine'};
const captions={YES:'Да',NO:'Нет',UNSURE:'Не уверен'};
export function AnnotationLibrary(){
 const [items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState<string|null>(null),[total,setTotal]=useState(0),[cursor,setCursor]=useState<string|null>(null),[scope,setScope]=useState('mine');
 const [starred,setStarred]=useState(false),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[marking,setMarking]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let alive=true;setLoading(true);setError('');
  void api<Page>(`/api/v1/verification/library?starred=${starred}`).then(r=>{
   if(!alive)return;setItems(r.items);setSelected(r.items[0]?.id??null);setTotal(r.total);setCursor(r.next_cursor);setScope(r.scope);
  }).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false;};
 },[starred,refresh]);
 if(!canAnnotate(session()?.user.role))return <p>Этот раздел недоступен вашей роли.</p>;
 const item=items.find(i=>i.id===selected);
 const more=async()=>{
  if(!cursor||loading)return;setLoading(true);setError('');
  try{const r=await api<Page>(`/api/v1/verification/library?starred=${starred}&cursor=${cursor}`);setItems(old=>[...old,...r.items.filter(i=>!old.some(o=>o.id===i.id))]);setTotal(r.total);setCursor(r.next_cursor);}catch(e:any){setError(e.message);}finally{setLoading(false);}
 };
 const mark=async()=>{
  if(!item||marking)return;setMarking(true);setError('');
  try{
   const result=await api<{starred:boolean}>(`/api/v1/verification/library/${item.id}/mark`,{body:{starred:!item.starred}});
   setItems(old=>old.map(i=>i.id===item.id?{...i,starred:result.starred}:i));
   if(starred&&!result.starred)setRefresh(n=>n+1);
  }catch(e:any){setError(e.message);}finally{setMarking(false);}
 };
 return <div className="annotation-page annotation-library">
  <div className="row between"><h1>Витрина разметки</h1><span className="mute" data-testid="library-total">{scope==='mine'?'Мои ответы':'Ответы операторов'}: {total}</span></div>
  <p className="mute">Сохранённые ответы, комментарии и оригиналы. «Хороший пример» — личная отметка для отбора, она не заменяет независимую проверку.</p>
  <div className="row library-toolbar"><button className={`btn ${!starred?'primary':''}`} onClick={()=>setStarred(false)}>Все ответы</button><button className={`btn ${starred?'primary':''}`} onClick={()=>setStarred(true)}>Хорошие примеры</button><button className="btn" disabled={loading} onClick={()=>setRefresh(n=>n+1)}>Обновить</button></div>
  {error&&<p role="alert" className="annotation-error">{error}</p>}
  {loading&&!items.length&&<p role="status">Открываю сохранённые ответы…</p>}
  {!loading&&!items.length&&!error&&<p>{starred?'Отмеченных примеров пока нет.':'Сохранённых ответов пока нет.'}</p>}
  {!!items.length&&<div className="annotation-library-workspace"><aside className="annotation-library-list" aria-label="Сохранённые ответы">
   {items.map(i=><button key={i.id} className={`library-entry ${i.id===selected?'selected':''}`} onClick={()=>setSelected(i.id)} data-label-id={i.id}>
    <div className="row between"><b>{i.task.parameter} · {captions[i.answer]}</b><span>{i.starred?'★':''}</span></div>
    <span>{i.task.name}</span><small>{new Date(i.created_at).toLocaleString('ru-RU')} · {i.author_name}</small>
    <span className="library-comment-preview">{i.comment||'Без комментария'}</span>
   </button>)}
   {cursor&&<button className="btn" disabled={loading} onClick={()=>void more()}>{loading?'Загружаю…':'Показать ещё'}</button>}
  </aside>{item&&<section className="annotation-library-detail" data-testid="library-detail">
   <div className="annotation-question"><div className="row between"><b>{item.task.parameter} · {item.task.name}</b><button className={`btn ${item.starred?'primary':''}`} aria-pressed={item.starred} disabled={marking} onClick={()=>void mark()}>{marking?'Сохраняю…':item.starred?'★ Хороший пример':'☆ Отметить хороший пример'}</button></div>
    <h2>{item.task.question}</h2><p><b>Ответ: {captions[item.answer]}</b>{item.corrected_value&&<> · Исправленное значение: <strong>{item.corrected_value}</strong></>}</p>
    <div className="library-comment" data-testid="library-comment">{item.comment||'Комментарий не указан'}</div>{item.comment_censored&&<p className="small mute">Нецензурные слова скрыты.</p>}
   </div>
   <div className={`annotation-sources ${item.task.sides.length===1?'single':''}`}>{item.task.sides.map(s=><AnnotationDocument key={s.content_url} side={s} onReady={()=>{}}/>)}</div>
  </section>}</div>}
 </div>;
}
