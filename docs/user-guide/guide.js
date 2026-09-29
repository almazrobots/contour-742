// T-258: local search; native links retain Tab/Enter behavior.
(()=>{
 const input=document.getElementById('search'),results=document.getElementById('search-results'),status=document.getElementById('search-status');
 if(!input||!results||!status)return;
 input.setAttribute('aria-controls','search-results');
 results.setAttribute('role','navigation');results.setAttribute('aria-label','Результаты поиска');
 const normalize=s=>String(s??'').toLocaleLowerCase('ru').replaceAll('ё','е');
 let pending,timer,generation=0,failed=false,returnFocus;
 document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&document.activeElement!==input&&!results.contains(document.activeElement))returnFocus=document.activeElement;
 },true);
 const links=()=>[...results.querySelectorAll('a')];
 const clear=()=>{clearTimeout(timer);generation++;failed=false;results.replaceChildren();status.textContent='';results.setAttribute('aria-busy','false')};
 const load=()=>{
  if(!pending){
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
   pending=fetch(input.dataset.index||'search.json',{signal:controller.signal})
    .then(r=>{if(!r.ok)throw Error('Search unavailable');return r.json()})
    .then(pages=>{if(!Array.isArray(pages))throw Error('Invalid search index');return pages})
    .catch(e=>{pending=undefined;throw e}).finally(()=>clearTimeout(timeout));
  }
  return pending;
 };
 input.addEventListener('input',()=>{
  clear();const current=generation;
  const words=normalize(input.value.trim()).split(/\s+/).filter(Boolean);
  if(!words.length)return;
  results.setAttribute('aria-busy','true');status.textContent='Ищем статьи…';
  timer=setTimeout(async()=>{
   try{
    const pages=await load();if(current!==generation)return;
    const base=new URL(input.dataset.base||'./',location.href);
    const matches=pages.flatMap(p=>{
     if(!p||typeof p.href!=='string'||typeof p.title!=='string')return [];
     let url;try{url=new URL(p.href,base)}catch{return []}
     if(url.origin!==location.origin||!url.pathname.startsWith(base.pathname))return [];
     const title=normalize(p.title),text=normalize(p.title+' '+(p.description||'')+' '+(p.text||''));
     if(!words.every(w=>text.includes(w)))return [];
     return [{...p,url,score:words.reduce((n,w)=>n+(title.includes(w)?10:1),0)}];
    }).sort((a,b)=>b.score-a.score);
    status.textContent=matches.length?'Найдено статей: '+matches.length+(matches.length>10?'. Показаны первые 10.':'')+' Стрелка вниз — выбрать, Enter — открыть.':'Ничего не найдено. Попробуйте другое слово или список разделов.';
    for(const p of matches.slice(0,10)){
     const a=document.createElement('a');a.href=p.url.href;a.textContent=p.title;
     const small=document.createElement('small');small.textContent=p.description||'';a.append(small);results.append(a);
    }
   }catch{if(current===generation){failed=true;status.textContent='Поиск недоступен. Enter — повторить; можно использовать список разделов.'}}
   finally{if(current===generation)results.setAttribute('aria-busy','false')}
  },160);
 });
 input.addEventListener('keydown',e=>{
  if(e.isComposing)return;
  const items=links();
  if((e.key==='ArrowDown'||e.key==='ArrowUp')&&items.length){e.preventDefault();items[e.key==='ArrowDown'?0:items.length-1].focus()}
  else if(e.key==='Enter'&&!e.isComposing){if(items.length){e.preventDefault();items[0].click()}else if(failed){e.preventDefault();input.dispatchEvent(new Event('input'))}}
  else if(e.key==='Escape'){e.preventDefault();const hadQuery=!!input.value;input.value='';clear();if(!hadQuery&&returnFocus?.isConnected)returnFocus.focus()}
 });
 results.addEventListener('keydown',e=>{
  const items=links(),at=items.indexOf(document.activeElement);if(at<0)return;
  if(e.key==='Escape'){e.preventDefault();input.value='';clear();input.focus()}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
   e.preventDefault();
   if(e.key==='ArrowUp'&&at===0){input.focus();return}
   const next=e.key==='Home'?0:e.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,at+(e.key==='ArrowDown'?1:-1)));
   items[next].focus();
  }
 });
 if(input.value.trim())input.dispatchEvent(new Event('input'));
})();
const guideNavigation=document.getElementById('navigation');
if(guideNavigation&&matchMedia('(max-width:900px)').matches)guideNavigation.open=false;
// T-258: клавиатурный поиск и оглавление отмечают текущий раздел статьи.
(()=>{
 const toggle=document.getElementById('sidebar-toggle');
 const content=document.getElementById('sidebar-content');
 const mobile=matchMedia('(max-width:900px)');
 const setExpanded=value=>{toggle.setAttribute('aria-expanded',String(value));content.inert=mobile.matches&&!value};
 setExpanded(!mobile.matches);
 toggle.addEventListener('click',()=>setExpanded(toggle.getAttribute('aria-expanded')!=='true'));
 mobile.addEventListener('change',()=>setExpanded(!mobile.matches));
 document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
   event.preventDefault();setExpanded(true);document.getElementById('search').focus();
  }
 });
 const links=[...document.querySelectorAll('.toc a')];
 const sections=links.map(link=>document.getElementById(link.hash.slice(1))).filter(Boolean);
 function update(){
  let active=sections[0];
  for(const section of sections){if(section.getBoundingClientRect().top<=130)active=section;else break}
  for(const link of links){if(link.hash==='#'+active?.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')}
 }
 let queued=false;
 addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;update()})}},{passive:true});
 update();
})();
// Главы работают с клавиатуры и не запускают воспроизведение без выбора пользователя.
document.querySelectorAll('[data-video-seek]').forEach(button=>button.addEventListener('click',()=>{
 const video=document.getElementById(button.dataset.videoTarget);
 const at=Number(button.dataset.videoSeek);
 if(video&&Number.isFinite(at)&&at>=0){video.currentTime=at;video.focus();}
}));
