"""Private deployed-API audit, aggregates only; never submits a label."""
import importlib.util,json,os
from pathlib import Path
spec=importlib.util.spec_from_file_location('bridge',Path(__file__).with_name('verification-import.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
os.environ['VERIFICATION_CA_FILE']='/opt/stand-gpu/tls/ca.crt'
endpoint='https://127.0.0.1:48844'
auth=json.loads(Path('/opt/w1-gate/eval/verification/import-review/credentials.json').read_text())
token=m.request(endpoint,'/api/v1/auth/login',auth)['token']
# request() is POST-only for imports; use a verified GET explicitly for the report.
import ssl,urllib.request,urllib.error
def get(token=None):
    req=urllib.request.Request(endpoint+'/api/v1/verification/quality',headers={'Authorization':'Bearer '+token} if token else {})
    with urllib.request.urlopen(req,context=ssl.create_default_context(cafile=os.environ['VERIFICATION_CA_FILE'])) as r:return json.load(r)
try:get()
except urllib.error.HTTPError as e:assert e.code==401
else:raise AssertionError('anonymous quality access')
report=get(token)
assert len(report['items'])==528
assert {r['parameter'] for r in report['items']}=={f'M-{i:03d}' for i in range(1,133)}
assert all(r['recall'] is None for r in report['items'])
assert all(r['precision'] is None for r in report['items'] if r['curated_yes']+r['curated_no']==0)
root=Path('/opt/w1-gate/eval/verification/quality-live');root.mkdir(mode=0o700,exist_ok=True)
path=root/'report.json';path.write_text(json.dumps(report,ensure_ascii=False));path.chmod(0o600)
print(json.dumps({'report_rows':len(report['items']),'tasks':sum(r['tasks'] for r in report['items']),
                 'human_labels':sum(r['labels'] for r in report['items']),
                 'anonymous_rejected':True,'recall_not_invented':True}))
