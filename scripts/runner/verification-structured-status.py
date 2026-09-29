"""Aggregated live status. No names, SHA, payload or credentials on stdout."""
import json,subprocess
from pathlib import Path
sql="""select json_build_object(
 'tasks',(select count(*) from inspector.verification_tasks),
 'parameters',(select count(distinct parameter) from inspector.verification_tasks),
 'human_labels',(select count(*) from inspector.verification_labels),
 'structured_tasks',(select count(*) from inspector.verification_tasks where source_version='corpus-t244-structured-original-v1'),
 'structured_kinds',(select json_agg(r) from (select snapshot_json::jsonb->'sides'->0->>'kind' kind,count(*) tasks from inspector.verification_tasks where source_version='corpus-t244-structured-original-v1' group by 1) r));"""
data=json.loads(subprocess.check_output(['docker','exec','-u','postgres','nadzorium-verification-postgres-1','psql','-d','inspector','-Atc',sql],text=True))
rows=json.loads(subprocess.check_output(['docker','exec','-u','postgres','nadzorium-verification-postgres-1','psql','-d','inspector','-Atc',"select json_agg(r) from (select distinct on(snapshot_json::jsonb->'sides'->0->>'kind') snapshot_json::jsonb->'sides'->0 side from inspector.verification_tasks where source_version='corpus-t244-structured-original-v1') r"],text=True))
assert len(rows)==3,'structured original kinds missing from durable queue'
check="""import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';
let input='';for await(const c of process.stdin)input+=c;
for(const {side:s} of JSON.parse(input))for(const [path,expected] of [['/private/staging/structured/'+s.preview.key+'.json',s.preview.sha256],['/private/corpus/'+s.sha256,s.sha256]]){const hash=createHash('sha256');for await(const c of createReadStream(path))hash.update(c);if(hash.digest('hex')!==expected)throw Error('mounted source digest mismatch');}
console.log('mounted originals and fragments verified');"""
subprocess.run(['docker','exec','-i','nadzorium-verification-api-1','node','--input-type=module','-e',check],input=json.dumps(rows),text=True,stdout=subprocess.DEVNULL,check=True)
data['api_user_mounted_originals_verified']=3
data['services']={u:subprocess.run(['systemctl','is-active','--quiet',u]).returncode==0 for u in ['verification-corpus-t244','verification-import-reading-t244','verification-import-pairs-t244','verification-import-structured-t244']}
p=Path('/opt/w1-gate/eval/verification/import-review/structured-checkpoint.json')
if p.exists():data['structured_import']=json.loads(p.read_text())
out=Path('/opt/w1-gate/eval/verification/structured-browser/live-status.json');out.write_text(json.dumps(data));out.chmod(0o600)
print(json.dumps(data))
