#!/usr/bin/env node
import { DOC_NAV_CSS, renderDocNav } from "./doc-nav.mjs";
// T-254: статическая база знаний. Только явный список статей и изображений, без обхода корпуса.
import {readFileSync, writeFileSync, mkdirSync, cpSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {md2html} from './demo-docs.mjs';
const root=resolve(new URL('..',import.meta.url).pathname);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function buildGuide(out, {standalone=false}={}) {
 const source=join(root,'docs/user-guide');
 const pages=JSON.parse(readFileSync(join(source,'navigation.json'),'utf8'));
 const slugs=new Set(pages.map(p=>p.slug));
 if(slugs.size!==pages.length||!slugs.has('index')) throw Error('Invalid guide navigation');
 mkdirSync(out,{recursive:true});
 const search=[];
 const compatibility=existsSync(join(source,'compatibility.json'))?JSON.parse(readFileSync(join(source,'compatibility.json'),'utf8')):{articles:[]};
 const applicability=new Map(compatibility.articles.map(a=>[a.slug,a]));
 const mediaCatalog=existsSync(join(source,'media/catalog.json'))?JSON.parse(readFileSync(join(source,'media/catalog.json'),'utf8')):{};
 const revision=process.env.INSPECTOR_BUILD_REVISION || (existsSync(join(root,'SOURCE_REVISION')) ? readFileSync(join(root,'SOURCE_REVISION'),'utf8').trim() : execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());
 for(const [position,page] of pages.entries()) {
  if(!/^[a-z][a-z-]*$/.test(page.slug))throw Error('Invalid guide slug');
  const markdown=readFileSync(join(source,page.slug+'.md'),'utf8');
  const links=[],media=[];
  const withVideos=markdown.replace(/\{\{video:([a-z-]+)\}\}/g,(_,id)=>{
   const item=mediaCatalog[id];if(!item)throw Error('Unknown video '+id);
   for(const [key,extension]of [['file','webm'],['captions','vtt'],['poster','png'],...(item.provenance?[['provenance','json']]:[])]){
    if(!new RegExp('^[a-z-]+\\.'+extension+'$').test(item[key]))throw Error('Invalid video '+key);
    const path=join(source,'media',item[key]);if(!existsSync(path))throw Error('Missing media '+path);
    mkdirSync(join(out,'media'),{recursive:true});cpSync(path,join(out,'media',item[key]));
   }
   const token='GUIDEMEDIATOKEN'+media.length+'END',player='video-'+id+'-'+media.length;
   const chapters=item.chapters.map(c=>`<li><button type="button" data-video-seek="${esc(c.seconds)}" data-video-target="${player}">${Math.floor(c.seconds/60)}:${String(Math.floor(c.seconds)%60).padStart(2,'0')} — ${esc(c.title)}</button></li>`).join('');
   media.push({token,html:`<section class="video-card" aria-label="${esc(item.title)}"><h3>${esc(item.title)}</h3><p>${esc(item.description)}</p><video id="${player}" controls playsinline preload="metadata" poster="media/${esc(item.poster)}" aria-label="${esc(item.title)}"><source src="media/${esc(item.file)}" type="video/webm"><track kind="subtitles" src="media/${esc(item.captions)}" srclang="ru" label="Русские подписи" default>Ваш браузер не поддерживает видео. <a href="media/${esc(item.file)}">Скачать ролик</a></video><p class="media-caption">${esc(item.context)} · ${esc(item.duration)} · ${esc(item.version)}</p><details><summary>Главы и текстовая инструкция</summary><ol class="video-chapters">${chapters}</ol><p><a href="media/${esc(item.file)}" download>Скачать видео</a> · <a href="media/${esc(item.captions)}">Русские подписи</a></p></details></section>`});return token;
  });
  const withMedia=withVideos.replace(/!\[([^\]]+)\]\((screens\/[a-z-]+\.png)(?:\s+"([^"]*)")?\)/g,(_,alt,href,caption)=>{
   if(!alt||!caption)throw Error('Image needs alt and caption: '+page.slug);
   const path=join(source,href);if(!existsSync(path))throw Error('Missing image '+href);
   mkdirSync(join(out,'screens'),{recursive:true});cpSync(path,join(out,href));
   const token='GUIDEMEDIATOKEN'+media.length+'END';
   media.push({token,html:`<figure><a href="${esc(href)}" target="_blank" rel="noopener"><img src="${esc(href)}" alt="${esc(alt)}" loading="lazy" decoding="async"></a><figcaption>${esc(caption)}</figcaption></figure>`});return token;
  });
  if(/!\[/.test(withMedia))throw Error('Unsupported image in '+page.slug);
  const masked=withMedia.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(m,label,href)=>{
   if(!/^(https:\/\/|\.\.\/|[a-z][a-z-]*\.html(?:#|$))/.test(href)) throw Error('Invalid article link: '+href);
   if(!href.startsWith('https:')&&!href.startsWith('../')&&!slugs.has(href.split('.html')[0]))throw Error('Unknown article: '+href);
   if(standalone&&href.startsWith('../')&&href!=='../index.html')return label+' (материал не входит в автономный пакет)';
   const token='GUIDELINKTOKEN'+links.length+'END'; links.push({token,label,href});return token;
  });
  let body=md2html(masked).html;
  for(const {token,label,href}of links)body=body.replaceAll(token,`<a href="${esc(href)}">${esc(label)}</a>`);
  for(const {token,html}of media)body=body.replaceAll(`<p>${token}</p>`,html);
  let articleApplicability='';
  body=body.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g,(_,content)=>{
   if(/^(?:<p>)?Применимость:/.test(content.trim())){articleApplicability=content;return '';}
   const type=/Предупреждение:|Не подтверждайте|не подтверждайте/.test(content)?'warning':'info';
   return `<aside class="callout ${type}" aria-label="${type==='warning'?'Предупреждение':'Обратите внимание'}">${content}</aside>`;
  });
  const headings=[];
  body=body.replace(/<h([23])>(.*?)<\/h\1>/g,(_,level,text)=>{
   const id='section-'+(headings.length+1);headings.push({id,text,level});
   return `<h${level} id="${id}">${text}</h${level}>`;
  });
  const screenshot=page.screenshot;
  if(screenshot){
   if(!/^[a-z-]+\.png$/.test(screenshot.file)||!screenshot.alt||!screenshot.caption)throw Error('Invalid screenshot metadata');
   const path=join(source,'screens',screenshot.file);if(!existsSync(path))throw Error('Missing screenshot '+path);
   mkdirSync(join(out,'screens'),{recursive:true});cpSync(path,join(out,'screens',screenshot.file));
   const figure=`<figure><a href="screens/${esc(screenshot.file)}" target="_blank" rel="noopener"><img src="screens/${esc(screenshot.file)}" alt="${esc(screenshot.alt)}" loading="lazy"></a><figcaption>${esc(screenshot.caption)}</figcaption></figure>`;
   // Image sits after the first explanatory step, adjacent to the related instruction.
   const secondHeading=/<h2 id="section-2">/;
   body=secondHeading.test(body)?body.replace(secondHeading,figure+'<h2 id="section-2">'):body+figure;
  }
  const nav=[...new Set(pages.map(p=>p.group))].map(group=>`<section><h2>${esc(group)}</h2>${pages.filter(p=>p.group===group).map(p=>`<a ${p.slug===page.slug?'aria-current="page"':''} href="${p.slug}.html">${esc(p.title)}</a>`).join('')}</section>`).join('');
  const neighbor=(p,label)=>p?`<a href="${p.slug}.html"><small>${label}</small>${esc(p.title)}</a>`:'';
  const toc=headings.map(h=>`<a href="#${h.id}" class="level-${h.level}">${h.text}</a>`).join('');
  const checked=applicability.get(page.slug);
  const evidenceLabel=checked?.verification_kind.includes('isolated')||checked?.verified_scenarios.length?'Учебный сценарий проверен':'Сверено по исходникам';
  const evidenceDetails=checked?`<details class="version-details"><summary>Применимость и проверка</summary><p>${checked.verified_scenarios.length?'Подтверждён конкретный учебный сценарий; это не проверка всех операций раздела.':'Действия сверены с исходниками. Проверка полного сценария на опубликованном приложении ещё не завершена.'} ${checked.pending_scenarios.length?'Остальные сценарии этой статьи ещё требуют проверки.':''}</p>${articleApplicability}<p><a href="release.html">Версии и актуальность</a></p></details>`:'';
  const standNote=['index','materials','release','videos','glossary','documentation'].includes(page.slug)?'':`<aside class="callout info"><b>Выберите свой стенд</b><p>На CPU-демо доступен просмотр. Инструкции по изменению данных относятся к рабочему стенду. Набор экранов зависит от его версии и вашей роли.</p></aside>`;
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(page.description)}"><title>${esc(page.title)} · Надзориум</title><link rel="stylesheet" href="guide.css"><script src="guide.js" defer></script><style>${DOC_NAV_CSS}
.technical-nav{margin-top:20px}.technical-nav summary{font-size:13px}.technical-nav .doc-nav{position:static;display:block;padding:0;border:0;box-shadow:none;background:transparent}.technical-nav .doc-nav .brand{display:none}.technical-nav .doc-nav .links{display:grid;overflow:visible}.technical-nav .doc-nav a{white-space:normal;font-weight:400}</style></head><body>
<a class="skip" href="#article">К статье</a>
<div class="layout"><aside class="sidebar"><header class="site-header"><a class="brand" href="index.html">Надзориум<span>База знаний</span></a></header><button id="sidebar-toggle" type="button" aria-expanded="true" aria-controls="sidebar-content">Меню и поиск</button><div id="sidebar-content" class="sidebar-content"><label for="search">Поиск по базе знаний</label><div class="search-field"><input id="search" type="search" placeholder="Найти инструкцию…" autocomplete="off" aria-keyshortcuts="Control+k Meta+k"></div><p id="search-status" role="status" aria-live="polite"></p><div id="search-results"></div><details id="navigation" open><summary>Разделы руководства</summary><nav aria-label="Разделы">${nav}</nav></details><nav class="service-links" aria-label="Сайт"><a href="../index.html">Все материалы</a>${standalone?'':'<a href="../gera/TRACE-MAP.html">Trace Map</a>'}<a href="/">В приложение ↗</a></nav><details class="technical-nav"><summary>Техническая документация</summary>${standalone?"":renderDocNav("guide", { base: "../gera/", guideHref: "index.html" })}</details></div></aside>
<main id="article" tabindex="-1"><div class="eyebrow">${esc(page.group)}</div><h1>${esc(page.title)}</h1><p class="description">${esc(page.description)}</p><div class="article-meta"><span>Обновлено 29 сентября 2026</span><span>${esc(evidenceLabel)}</span></div>${evidenceDetails}${standNote}<article>${body}</article><nav class="neighbors" aria-label="Продолжить чтение">${neighbor(pages[position-1],'Предыдущая статья')}${neighbor(pages[position+1],'Следующая статья')}</nav><footer>Руководство по доступным сценариям · 29 сентября 2026. Состав меню зависит от роли и версии стенда.</footer></main>
<aside class="toc"><b>На этой странице</b><nav aria-label="Оглавление статьи">${toc}</nav></aside></div></body></html>`;
  writeFileSync(join(out,page.slug+'.html'),html);
  search.push({title:page.title,description:page.description,href:page.slug+'.html',text:(markdown+' '+[...markdown.matchAll(/\{\{video:([a-z-]+)\}\}/g)].map(m=>mediaCatalog[m[1]].chapters.map(c=>c.title).join(' ')).join(' ')).replace(/^---\n[\s\S]*?\n---\n/,'').replace(/[#*>|`]/g,'')});
 }
 cpSync(join(source,'guide.css'),join(out,'guide.css'));cpSync(join(source,'guide.js'),join(out,'guide.js'));
 if(compatibility.articles.length)writeFileSync(join(out,'compatibility.json'),JSON.stringify(compatibility,null,2)+'\n');
 writeFileSync(join(out,'search.json'),JSON.stringify(search));
 writeFileSync(join(out,'build.json'),JSON.stringify({schema:'nadzorium-user-guide.v1',pages:pages.length,revision,built_at:new Date().toISOString(),reference:'BankImpulse: content/docs; Fumadocs presentation adapted to static Nadzorium docs'},null,2)+'\n');
 if(standalone){
  writeFileSync(join(out,'../index.html'),'<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>База знаний Надзориума</title><main><h1>База знаний Надзориума</h1><p>Автономный пакет содержит руководство пользователя и эксплуатационные инструкции.</p><p><a href="guide/index.html">Открыть руководство</a> · <a href="guide/deployment.html">Развёртывание и доступ</a></p><p>Trace Map, архитектурные публикации, BI-макет и отчёты исторического стенда не входят в этот пакет. Их наличие проверяется отдельно в материалах передачи; страница приложения не является заменой документа.</p></main></html>');
 }
 console.log('user-guide: '+pages.length+' articles → '+out);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)buildGuide(resolve(process.argv[2]||'out/user-guide'),{standalone:process.argv.includes('--standalone')});
