// Build only an explicit publication set; standalone interactive pages remain unchanged.
import {request} from 'playwright';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';


import {SECTIONS} from './demo-docs.mjs';
const stage='out/material-release',built='out/docs';
mkdirSync('out',{recursive:true});
const transport=await request.newContext({ignoreHTTPSErrors:true});
try{
 const response=await transport.get('https://127.0.0.1:55892/docs/publication.json');if(!response.ok())throw Error('Published source metadata unavailable');
 const bytes=await response.body();JSON.parse(bytes.toString());writeFileSync('out/previous-publication.json',bytes);
 execFileSync('node',['scripts/demo-docs.mjs',built,'0','0','','','out/previous-publication.json'],{stdio:'inherit'});
 rmSync(stage,{recursive:true,force:true});mkdirSync(stage,{recursive:true});
 const paths=['index.html','assets/doc.css','publication.json','design/design-system.html','bi/dashboard.html',...SECTIONS.flatMap(s=>s.items.filter(i=>i[2]?.endsWith('.md')&&!['approach/c4.html','method/01-survey.html'].includes(i[0])).map(i=>i[0]))];
 function guide(dir,prefix){for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory())guide(join(dir,entry.name),prefix+entry.name+'/');else paths.push(prefix+entry.name)}}
 guide(join(built,'guide'),'guide/');
 const artifacts=paths.map(path=>{const content=readFileSync(join(built,path));mkdirSync(dirname(join(stage,path)),{recursive:true});copyFileSync(join(built,path),join(stage,path));return {path,sha256:createHash('sha256').update(content).digest('hex')}});
 writeFileSync(join(stage,'release.json'),JSON.stringify({schema:'docs-material-release.v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),previous_publication_sha256:createHash('sha256').update(bytes).digest('hex'),artifacts},null,2)+'\n');
 console.log(JSON.stringify({artifacts:artifacts.length,standalone_pages:'design system and BI updated; trace-owned pages preserved',database:'untouched'}));
}finally{await transport.dispose()}
