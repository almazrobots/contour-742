// T-263/T-266: allowlisted static files with private backup; no DB/runtime changes.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,renameSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const stage=process.argv[2],root='/opt/nadzorium/var/docs';
if(!/^\/opt\/nadzorium\/var\/material-stage-[\w-]+$/.test(stage??''))throw Error('Invalid stage');
function assertDirectoryChain(path){for(let p=path;p!=='/';p=dirname(p)){if(existsSync(p)&&(!lstatSync(p).isDirectory()||lstatSync(p).isSymbolicLink()))throw Error('Unsafe directory chain')}}
assertDirectoryChain(stage);assertDirectoryChain(root);
const release=JSON.parse(readFileSync(join(stage,'release.json'),'utf8'));
if(release.schema!=='docs-material-release.v1'||!Array.isArray(release.artifacts)||release.artifacts.length<20)throw Error('Invalid release');
const allowed=/^(?:gera\/(?:ARCHITECTURE|PIPELINE)\.html|design\/design-system\.html|bi\/dashboard\.html|index\.html|publication\.json|assets\/doc\.css|(?:method|approach|results|plans)\/[a-z0-9-]+\.html|guide\/(?:[a-z-]+\.(?:html|css|js|json)|(?:screens|media)\/[a-z-]+\.(?:png|webm|vtt|json)))$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=new Set(),contents=new Map();
for(const artifact of release.artifacts){
 if(!allowed.test(artifact.path)||paths.has(artifact.path))throw Error('Unexpected or duplicate file');paths.add(artifact.path);
 const p=join(stage,artifact.path);assertDirectoryChain(dirname(p));if(!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink())throw Error('Unsafe source file');const bytes=readFileSync(p);if(sha(bytes)!==artifact.sha256)throw Error('Artifact digest mismatch');contents.set(artifact.path,bytes);
 let parent=dirname(join(root,artifact.path));while(parent!==root){if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error('Target parent symlink');parent=dirname(parent)}
 const target=join(root,artifact.path);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw Error('Target symlink');
}
if(!paths.has('index.html')||!paths.has('publication.json'))throw Error('Required artifacts missing');
const original=readFileSync(join(root,'publication.json'));
if(sha(original)!==release.previous_publication_sha256)throw Error('Publication changed concurrently; rebuild required');
const before=JSON.parse(original),after=JSON.parse(contents.get('publication.json').toString('utf8'));
for(const key of new Set([...Object.keys(before),...Object.keys(after)])){if(['site_revision','docs_published_at'].includes(key))continue;if(JSON.stringify(before[key])!==JSON.stringify(after[key]))throw Error('Source-data metadata changed: '+key)}
const history='/opt/nadzorium/var/material-history/'+stage.split('material-stage-')[1];mkdirSync(history,{recursive:true,mode:0o700});
// T-255: these pages are owned by the trace publication; never overwrite them from a materials branch.
const traceOwned=new Set(['gera/ARCHITECTURE.html','gera/PIPELINE.html','approach/c4.html','method/01-survey.html']);
const applied=[];
try{
 for(const {path}of release.artifacts){
  if(traceOwned.has(path))continue;
  const target=join(root,path),backup=join(history,path),existed=existsSync(target);mkdirSync(dirname(target),{recursive:true,mode:0o755});
  if(existed){mkdirSync(dirname(backup),{recursive:true,mode:0o700});copyFileSync(target,backup)}
  const temp=target+'.release-'+randomUUID();try{writeFileSync(temp,contents.get(path),{mode:0o644,flag:'wx'});renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp)}applied.push({target,backup,existed});
 }
 writeFileSync(join(history,'release.json'),JSON.stringify(release,null,2),{mode:0o600});
 console.log(JSON.stringify({published:true,files:applied.length,revision:release.revision,backup:history,database_changes:0,trace_map:'preserved'}));
}catch(error){for(const {target,backup,existed}of applied.reverse()){if(existed)copyFileSync(backup,target);else unlinkSync(target)}throw error}
