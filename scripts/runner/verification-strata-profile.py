"""Read-only EXPLAIN of the exact queue-group query on the largest live stratum."""
import json, re, subprocess, time
from pathlib import Path

OUT=Path('/opt/w1-gate/eval/verification/strata-profile')
OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
def sql(text):
    return subprocess.run(['docker','exec','-i','-u','postgres','nadzorium-verification-postgres-1',
        'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d','inspector'],input=text,text=True,capture_output=True,check=True).stdout.strip()
def literal(value):
    return "'"+value.replace("'","''")+"'"
parameter,user=sql("select (select parameter from inspector.verification_coverage order by ready desc limit 1),(select id from inspector.users where login='curator');").split('|')
source=Path('apps/api/src/services/data-verification.ts').read_text()
query=re.search(r't\.all<any>\(`(with verified.*?)`,\[parameter,user\]\)',source,re.S).group(1)
query=query.replace('${hard ? "and v.difficulty in (\'hard\',\'control\')" : ""}','').replace('$1',literal(parameter)).replace('$2',literal(user))
if '${' in query:raise RuntimeError('unresolved query template')
plans=[]
for _ in range(10):
    raw=sql('begin read only; set local search_path=inspector; set local statement_timeout=\'10s\'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query+'; rollback;')
    plans.append(json.loads(raw)[0])
    time.sleep(.1)
(OUT/'plans.json').write_text(json.dumps(plans));(OUT/'plans.json').chmod(0o600)
ms=sorted(p['Execution Time'] for p in plans)
result={'query':'live-object-operation-groups','parameter':parameter,'samples':len(ms),'execution_ms_p95':ms[-1],
        'execution_ms_min':ms[0],'groups':plans[-1]['Plan']['Actual Rows'],'read_only':True,'labels_submitted':0}
(OUT/'status.json').write_text(json.dumps(result));(OUT/'status.json').chmod(0o600)
print(json.dumps(result))
