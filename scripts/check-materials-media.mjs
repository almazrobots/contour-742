// Review a captured synthetic video without API calls; use on W1 where ffmpeg is bundled.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const dir=resolve('out/materials-media'),file=join(dir,'materials-walkthrough.webm'),bytes=readFileSync(file),provenancePath=join(dir,'provenance.json');
const provenance=JSON.parse(readFileSync(provenancePath,'utf8'));assert.equal(provenance.production_writes,0);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',route=>{
  if(route.request().url()!=='http://docs-media.invalid/video.webm')return route.abort();
  const m=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if(m){const from=Number(m[1]),to=m[2]?Math.min(Number(m[2]),bytes.length-1):bytes.length-1;return route.fulfill({status:206,contentType:'video/webm',headers:{'accept-ranges':'bytes','content-range':`bytes ${from}-${to}/${bytes.length}`},body:bytes.subarray(from,to+1)});}
  return route.fulfill({status:200,contentType:'video/webm',headers:{'accept-ranges':'bytes'},body:bytes});
 });
 const page=await context.newPage();await page.setContent('<video muted preload="auto" src="http://docs-media.invalid/video.webm"></video>');
 await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
 const info=await page.evaluate(()=>{const v=document.querySelector('video');return {duration:v.duration,width:v.videoWidth,height:v.videoHeight}});
 assert(Number.isFinite(info.duration)&&info.duration>provenance.chapters.at(-1).seconds+.3);assert.equal(info.width,1440);assert.equal(info.height,1000);
 await page.evaluate(async()=>{const v=document.querySelector('video');v.playbackRate=8;await v.play();});
 await page.waitForFunction(()=>document.querySelector('video').ended,{timeout:30000});
 assert.equal(await page.evaluate(()=>document.querySelector('video').error),null);
 info.playback='complete without decoder error';info.frames=[];
 const ffmpeg=process.env.DOCS_FFMPEG||'/opt/w1-gate/home/w1run/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux';
 const review=resolve('out/materials-review');mkdirSync(review,{recursive:true});
 for(const [n,chapter]of provenance.chapters.entries()){
  const seconds=Math.min(chapter.seconds+1,info.duration-.2),name=`decoded-${n}.png`,target=join(review,name);
  execFileSync(ffmpeg,['-v','error','-ss',String(seconds),'-i',file,'-frames:v','1','-y',target]);
  info.frames.push({seconds,file:name,sha256:createHash('sha256').update(readFileSync(target)).digest('hex')});
 }
 const stamp=t=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
 // Rebuild WebVTT from chapter start times so the final cue ends at actual decoded duration.
 const cues=provenance.chapters.map((c,i)=>{const end=Math.min(provenance.chapters[i+1]?.seconds??info.duration,info.duration);assert(end>c.seconds);return `${i+1}\n${stamp(c.seconds)} --> ${stamp(end)}\n${c.title}\n`;}).join('\n');
 writeFileSync(join(dir,'materials-walkthrough.vtt'),'WEBVTT\n\n'+cues);
 provenance.capture_wall_clock_seconds??=provenance.duration_seconds;provenance.duration_seconds=info.duration;provenance.video_review=info;
 writeFileSync(provenancePath,JSON.stringify(provenance,null,2)+'\n');writeFileSync(join(review,'video-review.json'),JSON.stringify(info,null,2)+'\n');
 console.log(JSON.stringify({reviewed:true,duration_seconds:info.duration,frames:info.frames.length,production_api_calls:0}));await context.close();
}finally{await browser.close();}
