// T-254: CPU publication only. Existing materials, publication metadata, DB and runtimes stay intact.
import {readFileSync,writeFileSync,renameSync,rmSync,readdirSync,lstatSync,cpSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const stage=process.argv[2],docs='/opt/nadzorium/var/docs';
if(!/^\/opt\/nadzorium\/var\/guide-stage-[\w-]+$/.test(stage??''))throw Error('Invalid staging path');
const metadata=JSON.parse(readFileSync(join(stage,'build.json'),'utf8'));
if(metadata.schema!=='nadzorium-user-guide.v1'||metadata.pages<10)throw Error('Invalid build');
function validate(dir){for(const item of readdirSync(dir)){const p=join(dir,item),s=lstatSync(p);if(s.isSymbolicLink())throw Error('No symlinks');if(s.isDirectory()){if(!['screens','media'].includes(item))throw Error('Unexpected directory');validate(p)}else if(!/^[a-z-]+\.(html|css|js|json|png|mjs|webm|vtt)$/.test(item))throw Error('Unexpected artifact')}}
validate(stage);
const map=join(docs,'gera/TRACE-MAP.html'),index=join(docs,'index.html');
const originals=[map,index].map(p=>({p,text:readFileSync(p,'utf8')}));
const mapText=originals[0].text.includes('href="../guide/index.html"')?originals[0].text:originals[0].text.replace('<a class="navlink" href="PIPELINE.html">','<a class="navlink" href="../guide/index.html">Руководство пользователя</a>\n      <a class="navlink" href="PIPELINE.html">');
if(!mapText.includes('href="../guide/index.html"'))throw Error('Trace Map anchor missing');
const card='<section id="platform-user-guide" class="sec"><h2>Руководство пользователя</h2><p>Начало работы, проверки, разметка и сопровождение.</p><div class="cards"><a href="guide/index.html"><b>База знаний Надзориума</b><span>Инструкции по задачам, поиск и ответы на частые вопросы</span></a></div></section>';
const indexText=originals[1].text.includes('href="guide/index.html"')?originals[1].text:originals[1].text.replace('<div class="sec">',card+'<div class="sec">');
if(!indexText.includes('href="guide/index.html"'))throw Error('Materials anchor missing');
const suffix=stage.split('guide-stage-')[1],history='/opt/nadzorium/var/guide-history/'+suffix;
mkdirSync(history,{recursive:true,mode:0o700});
const backup=history+'/guide';
const target=join(docs,'guide');let old=false,published=false;
rmSync(join(stage,'publish-user-guide.mjs'));
try{
 for(const {p}of originals)cpSync(p,join(history,p===map?'TRACE-MAP.html':'index.html'));
 try{renameSync(target,backup);old=true}catch(e){if(e.code!=='ENOENT')throw e}
 renameSync(stage,target);published=true;
 for(const [p,text]of [[map,mapText],[index,indexText]]){writeFileSync(p+'.guide-tmp',text,{mode:0o644});renameSync(p+'.guide-tmp',p)}
 console.log(JSON.stringify({published:true,pages:metadata.pages,path:'/docs/guide/index.html',previous_guide:old?backup:null,existing_publication_metadata:'unchanged'}));
}catch(e){
 for(const {p,text}of originals)writeFileSync(p,text,{mode:0o644});
 if(published)renameSync(target,stage);if(old)renameSync(backup,target);throw e;
}
