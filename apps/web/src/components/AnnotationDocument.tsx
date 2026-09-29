import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { session } from "../lib/api";
import {backgroundRenderSlot} from "../lib/annotation-render-queue";
import {apiUrl} from '../lib/verification-mode';
pdfjs.GlobalWorkerOptions.workerSrc=worker;
export type AnnotationSide={file_name:string;kind:string;page:number;bbox:number[]|null;anchor_bbox:number[]|null;value:string;quote:string;stage:string|null;geometry:string;content_url:string;fragment_url:string|null;view_label?:string|null};
type DocumentProps={side:AnnotationSide;onReady:(ready:boolean)=>void;background?:boolean};
type StructuredView={schema:string;kind:string;label:string;note:string;first_row:number;target_row:number;target_rows?:number[];rows:string[][]};
function columnName(index:number){let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;}
function StructuredAnnotation({side,onReady}:DocumentProps){
  const [view,setView]=useState<StructuredView|null>(null),[error,setError]=useState(''),[zoom,setZoom]=useState(1),[downloading,setDownloading]=useState(false);
  const ready=useRef(onReady);ready.current=onReady;
  useEffect(()=>{const abort=new AbortController();setView(null);setError('');ready.current(false);
    const token=session()?.token;
    void fetch(apiUrl(side.fragment_url!),{headers:token?{authorization:`Bearer ${token}`}:{},signal:abort.signal}).then(async r=>{
      if(!r.ok)throw Error(`Фрагмент недоступен (${r.status})`);
      const data=await r.json() as StructuredView;
      if(data.schema!=='structured-original.v1'||data.kind!==side.kind||!Array.isArray(data.rows)||data.rows.length>40||!data.rows.every(row=>Array.isArray(row)&&row.length<=256&&row.every(v=>typeof v==='string')))throw Error('Некорректное представление оригинала');
      if(!abort.signal.aborted){setView(data);ready.current(true);}
    }).catch(e=>{if(!abort.signal.aborted){setError(e.message);ready.current(false);}});
    return()=>abort.abort();
  },[side.fragment_url,side.kind]);
  async function download(){setDownloading(true);try{
    const token=session()?.token,r=await fetch(apiUrl(side.content_url),{headers:token?{authorization:`Bearer ${token}`}:{}});
    if(!r.ok)throw Error(`Оригинал недоступен (${r.status})`);
    const url=URL.createObjectURL(await r.blob()),link=document.createElement('a');link.href=url;link.download=side.file_name.split('/').at(-1)||'original';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){setError(e instanceof Error?e.message:'Не удалось скачать оригинал');}finally{setDownloading(false);}}
  const columns=view?Math.max(0,...view.rows.map(r=>r.length)):0;
  return <section className="annotation-document">
    <header><div className="annotation-document-heading"><b>{side.view_label||side.kind.toUpperCase()}</b><span className="annotation-value"><span className="small mute">Значение</span> <strong>{side.value||'Не найдено'}</strong></span></div><div className="small annotation-file-name" title={side.file_name}>{side.file_name}</div></header>
    <div className="annotation-source-toolbar"><button className="btn" disabled={downloading} onClick={()=>void download()}>{downloading?'Скачиваю…':'Скачать оригинал'}</button><button className="btn" aria-label="Уменьшить" onClick={()=>setZoom(z=>Math.max(.75,z-.25))}>−</button><span>{Math.round(zoom*100)}%</span><button className="btn" aria-label="Увеличить" onClick={()=>setZoom(z=>Math.min(3,z+.25))}>+</button></div>
    {view&&<p className="small mute annotation-structured-note">{view.note} Подсвечена строка, в которой алгоритм нашёл значение.</p>}
    {!view&&!error&&<p role="status">Открываю источник…</p>}{error&&<p role="alert" className="annotation-error">{error}. Выберите «Не уверен», если проверить не получается.</p>}
    {view&&<div className="annotation-structured" style={{fontSize:`${zoom}em`}} data-testid="structured-original">
      {side.kind==='xlsx'?<table><thead><tr><th>Строка</th>{Array.from({length:columns},(_,i)=><th key={i}>{columnName(i)}</th>)}</tr></thead><tbody>{view.rows.map((row,i)=><tr key={i} className={(view.target_rows??[view.target_row]).includes(view.first_row+i)?'annotation-target-row':''}><th>{view.first_row+i}</th>{Array.from({length:columns},(_,j)=><td key={j}>{row[j]||''}</td>)}</tr>)}</tbody></table>:
      view.rows.map((row,i)=><div className={`annotation-text-row ${(view.target_rows??[view.target_row]).includes(view.first_row+i)?'annotation-target-row':''}`} key={i}><span className="mute">{view.first_row+i}</span><p>{row[0]}</p></div>)}
    </div>}
  </section>;
}
export function AnnotationDocument({side,onReady,background=false}:{side:AnnotationSide;onReady:(ready:boolean)=>void;background?:boolean}) {
  return ['xlsx','docx','xml'].includes(side.kind)?<StructuredAnnotation side={side} onReady={onReady} background={background}/>:<RasterAnnotation side={side} onReady={onReady} background={background}/>;
}
function RasterAnnotation({side,onReady,background=false}:DocumentProps) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const pdfJob=useRef<ReturnType<typeof pdfjs.getDocument>|undefined>(undefined);
  const renderedKey=useRef<string|null>(null);
  const imageBytes=useRef(new Map<string,Promise<Blob>>());
  const sourceAbort=useRef(new AbortController());
  const [hasImage,setHasImage]=useState(false);
  const [full,setFull]=useState(false),[zoom,setZoom]=useState(1),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const onReadyRef=useRef(onReady);onReadyRef.current=onReady;
  useEffect(()=>{const abort=new AbortController();sourceAbort.current=abort;setFull(false);setZoom(1);return()=>{abort.abort();const job=pdfJob.current;pdfJob.current=undefined;imageBytes.current.clear();if(job)void job.destroy().catch(()=>{});};},[side.content_url]);
  const sourceKey=JSON.stringify([side.content_url,side.fragment_url,side.kind,side.page,side.bbox,side.anchor_bbox]);
  useEffect(()=>{
    const drawKey=JSON.stringify([sourceKey,full,zoom]);
    // Promotion keeps the prepared canvas; only an unfinished draw is reprioritized.
    if(renderedKey.current===drawKey){setLoading(false);onReadyRef.current(true);return;}
    let alive=true;let job:ReturnType<typeof pdfjs.getDocument>|undefined;let render:pdfjs.RenderTask|undefined;
    setLoading(true);setError("");onReadyRef.current(false);
    const token=session()?.token;const headers:Record<string,string>=token?{authorization:`Bearer ${token}`} : {};
    const draw=async()=>{
      const c=canvas.current!;let width:number,height:number;
      const scratch=document.createElement("canvas");
      const box=!full&&!side.fragment_url?side.bbox:null;
      // Include the field label when it has a separate, proven anchor box.
      const anchor=box?side.anchor_bbox:null;
      const area=box?[Math.max(0,Math.min(box[0],anchor?.[0]??box[0])-.04),Math.max(0,Math.min(box[1],anchor?.[1]??box[1])-.07),Math.min(1,Math.max(box[2],anchor?.[2]??box[2])+.04),Math.min(1,Math.max(box[3],anchor?.[3]??box[3])+.07)]:[0,0,1,1];
      let renderedFragment=false;
      if(side.kind==="pdf" && (full||!side.fragment_url)) {
        job=pdfJob.current??(pdfJob.current=pdfjs.getDocument({url:apiUrl(side.content_url),httpHeaders:headers,withCredentials:false,disableStream:true,disableAutoFetch:true,rangeChunkSize:256*1024}));
        const pdf=await job.promise;if(!alive)return;const page=await pdf.getPage(side.page);if(!alive)return;
        const initial=page.getViewport({scale:1});
        const targetWidth=initial.width*(area[2]-area[0]),targetHeight=initial.height*(area[3]-area[1]);
        // Render the visible region at its own resolution. Rendering a whole A0 sheet
        // at 1600px and then enlarging a small value made the original unreadable.
        const pixels=Math.max(1200,(c.parentElement?.clientWidth??1000)*zoom*Math.min(2,window.devicePixelRatio||1));
        const scale=Math.min(pixels/targetWidth,Math.sqrt(16_000_000/(targetWidth*targetHeight)),10);
        const view=page.getViewport({scale});width=view.width;height=view.height;
        scratch.width=Math.max(1,Math.ceil(width*(area[2]-area[0])));scratch.height=Math.max(1,Math.ceil(height*(area[3]-area[1])));
        render=page.render({canvasContext:scratch.getContext("2d")!,viewport:view,transform:[1,0,0,1,-area[0]*width,-area[1]*height]});await render.promise;
        renderedFragment=true;
      } else {
        const url=!full&&side.fragment_url?side.fragment_url:side.content_url;
        let bytes=imageBytes.current.get(url);
        if(!bytes){bytes=fetch(apiUrl(url),{headers,signal:sourceAbort.current.signal}).then(async response=>{if(!response.ok)throw Error(`Источник недоступен (${response.status})`);return response.blob();});imageBytes.current.set(url,bytes);void bytes.catch(()=>imageBytes.current.delete(url));}
        const bitmap=await createImageBitmap(await bytes);if(!alive){bitmap.close();return;}
        width=bitmap.width;height=bitmap.height;scratch.width=width;scratch.height=height;scratch.getContext("2d")!.drawImage(bitmap,0,0);bitmap.close();
      }
      if(!alive)return;
      const x=area[0]*width,y=area[1]*height,w=(area[2]-area[0])*width,h=(area[3]-area[1])*height;
      c.width=Math.max(1,Math.ceil(w));c.height=Math.max(1,Math.ceil(h));const ctx=c.getContext("2d")!;
      if(renderedFragment)ctx.drawImage(scratch,0,0);else ctx.drawImage(scratch,x,y,w,h,0,0,c.width,c.height);
      if(side.bbox && !side.fragment_url){ctx.strokeStyle="#e9a600";ctx.lineWidth=3;ctx.strokeRect(side.bbox[0]*width-x,side.bbox[1]*height-y,(side.bbox[2]-side.bbox[0])*width,(side.bbox[3]-side.bbox[1])*height);}
      scratch.width=0;scratch.height=0;renderedKey.current=drawKey;setHasImage(true);setLoading(false);onReadyRef.current(true);
    };
    const scheduled=async()=>{const release=background?await backgroundRenderSlot():undefined;try{if(alive)await draw();}finally{release?.();}};
    void scheduled().catch(e=>{if(alive){setError(e.message||"Не удалось показать источник");setLoading(false);onReadyRef.current(false);}});
    return()=>{alive=false;render?.cancel();};
  },[sourceKey,full,zoom,background]);
  return <section className="annotation-document">
    <header><div className="annotation-document-heading"><b>{side.stage||"Документ"} · страница {side.page}</b><span className="annotation-value"><span className="small mute">Значение</span> <strong>{side.value||"Не найдено"}</strong></span></div><div className="small annotation-file-name" title={side.file_name}>{side.file_name}</div></header>
    <div className="annotation-source-toolbar"><button className="btn" onClick={()=>setFull(v=>!v)}>{full?"Фрагмент":"Вся страница"}</button><button className="btn" aria-label="Уменьшить" onClick={()=>setZoom(z=>Math.max(.5,z-.25))}>−</button><span>{Math.round(zoom*100)}%</span><button className="btn" aria-label="Увеличить" onClick={()=>setZoom(z=>Math.min(3,z+.25))}>+</button></div>
    {side.geometry==="coarse_band"&&<div className="small mute">Показана полоса страницы. Точное положение значения ещё не проверено.</div>}
    <div className="annotation-canvas-wrap">{loading&&<p role="status">{hasImage?"Уточняю детализацию…":"Открываю источник…"}</p>}{error&&<p role="alert" className="annotation-error">{error}. Выберите «Не уверен», если проверить не получается.</p>}<canvas ref={canvas} style={{width:`${zoom*100}%`,display:!hasImage||error?"none":"block"}} aria-label={`Исходный фрагмент: ${side.file_name}, страница ${side.page}`} /></div>
    {side.quote&&<footer><details><summary>Распознанный текст</summary><blockquote>{side.quote}</blockquote></details></footer>}
  </section>;
}
