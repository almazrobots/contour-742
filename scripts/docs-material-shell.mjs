// Pure HTML renderer. Callers own sources, publication, Mermaid and release verification.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textOnly = value => String(value).replace(/<[^>]*>/g, '');
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..');

/** sections use demo-docs SECTIONS tuples [destination, title, source, description].
 * metadata is optional: {path, description, status, ui_revision, last_verified,
 * owner, searchIndex, searchBase}. Status and dates are caller-provided evidence.
 */
export function renderMaterialShell({title, body, depth = 1, sections = [], metadata = {}}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new Error('Invalid material depth');
  const up = '../'.repeat(depth);
  const guide = `${up}guide/`;
  const headings = [];
  const ids = new Set([...String(body).matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  let counter = 0;
  const hiddenBlocks=[];
  const visibleBody=String(body).replace(/<details\b[\s\S]*?<\/details>/g,block=>{const token='MATERIALDETAILSTOKEN'+hiddenBlocks.length+'END';hiddenBlocks.push({token,block});return token});
  let article = visibleBody.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (_, level, attrs, label) => {
    let id = attrs.match(/\bid=["']([^"']+)["']/)?.[1];
    if (!id) {
      do { id = `material-section-${++counter}`; } while (ids.has(id));
      ids.add(id);
      attrs += ` id="${id}"`;
    }
    headings.push({id, level, label: textOnly(label)});
    return `<h${level}${attrs}>${label}</h${level}>`;
  });
  for(const {token,block}of hiddenBlocks)article=article.replaceAll(token,block);
  const firstTitle=article.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0]??`<h1>${esc(title)}</h1>`;
  article=article.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i,'');
  const nav = sections.map(section => `<section><h2>${esc(section.title)}</h2>${(section.items ?? []).map(item => {
    const [destination, label] = item;
    if (!safePath(destination)) throw new Error('Invalid material navigation destination');
    return `<a href="${esc(up + destination)}"${metadata.path === destination ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  }).join('')}</section>`).join('');
  const fields = [
    ['Статус материала', metadata.status],
    ['Версия UI', metadata.ui_revision===false?null:(metadata.ui_revision || 'не подтверждена')],
    ['Проверено', metadata.last_verified],
    ['Ответственный', metadata.owner],
  ].filter(([, value]) => value);
  const toc = headings.map(h => `<a href="#${esc(h.id)}" class="level-${h.level}">${esc(h.label)}</a>`).join('');
  const index = metadata.searchIndex ?? `${guide}search.json`;
  const base = metadata.searchBase ?? guide;
  // URLs are encoded in HTML attributes, never interpolated into script source.
  const script = `<script>
(()=>{
 const input=document.getElementById('material-search'),results=document.getElementById('search-results'),status=document.getElementById('search-status');
 const toggle=document.getElementById('sidebar-toggle'),content=document.getElementById('sidebar-content'),mobile=matchMedia('(max-width:900px)');
 const expand=value=>{toggle.setAttribute('aria-expanded',String(value));content.inert=mobile.matches&&!value};
 expand(!mobile.matches);toggle.addEventListener('click',()=>expand(toggle.getAttribute('aria-expanded')!=='true'));mobile.addEventListener('change',()=>expand(!mobile.matches));
 document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();expand(true);input.focus()}});
(()=>{
 const input=document.getElementById('material-search'),results=document.getElementById('search-results'),status=document.getElementById('search-status');
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
  const words=normalize(input.value.trim()).split(/\\s+/).filter(Boolean);
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
 const links=[...document.querySelectorAll('.toc a')],targets=links.map(a=>document.getElementById(a.hash.slice(1))).filter(Boolean);
 const update=()=>{let active=targets[0];for(const target of targets){if(target.getBoundingClientRect().top<=130)active=target;else break}for(const link of links){if(active&&link.hash==='#'+active.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')}};
 let queued=false;addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;update()})}},{passive:true});update();
})();
</script>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Надзориум</title>${metadata.description ? `<meta name="description" content="${esc(metadata.description)}">` : ''}<link rel="stylesheet" href="${esc(up)}assets/doc.css"><link rel="stylesheet" href="${esc(guide)}guide.css"></head><body>
<a class="skip" href="#article">К материалу</a><div class="layout"><aside class="sidebar"><header class="site-header"><a class="brand" href="${esc(guide)}index.html">Надзориум <span>База знаний</span></a><nav aria-label="Сайт"><a href="${esc(up)}index.html"${depth === 0 ? ' aria-current="page"' : ''}>Все материалы</a><a href="${esc(up)}gera/TRACE-MAP.html">Trace Map</a></nav></header><button id="sidebar-toggle" type="button" aria-controls="sidebar-content" aria-expanded="true">Разделы</button><div id="sidebar-content" class="sidebar-content"><label for="material-search">Поиск по руководству</label><input id="material-search" type="search" placeholder="Название или действие" data-index="${esc(index)}" data-base="${esc(base)}" autocomplete="off"><p id="search-status" role="status" aria-live="polite"></p><div id="search-results"></div><nav aria-label="Материалы">${nav}</nav></div></aside>
<main id="article" tabindex="-1">${firstTitle}${metadata.description ? `<p class="description">${esc(metadata.description)}</p>` : ''}<div class="article-meta">${fields.map(([label, value]) => `<span>${esc(label)}: ${esc(value)}</span>`).join('')}</div><article class="material-body">${article}</article><footer>Материалы базы знаний. Актуальность определяется проверкой источника и соответствующей версии интерфейса.</footer></main><aside class="toc">${headings.length ? `<b>На этой странице</b><nav aria-label="Оглавление материала">${toc}</nav>` : ''}</aside></div>${script}</body></html>`;
}
