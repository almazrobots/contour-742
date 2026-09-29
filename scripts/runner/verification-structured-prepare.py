#!/usr/bin/env python3
"""Read-only real corpus QA, private source descriptors; stdout only aggregate counts."""
import argparse,importlib.util,json,sqlite3,collections,os
from pathlib import Path
spec=importlib.util.spec_from_file_location('structured',Path(__file__).with_name('verification-structured.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=argparse.ArgumentParser();p.add_argument('--staging',required=True);p.add_argument('--corpus',default='/opt/corpus/blobs');a=p.parse_args()
root=Path(a.staging);db=sqlite3.connect(f'file:{root / "candidates.sqlite"}?mode=ro',uri=True)
good=collections.Counter();bad=collections.Counter();samples={};failures=[]
for payload,kind in db.execute("select c.payload,s.kind from candidates c join sources s on s.sha=c.sha where s.kind in ('xlsx','docx','xml') order by c.rowid"):
 c=json.loads(payload)
 try:
  preview=m.preview(c,kind,root,a.corpus);good[kind]+=1
  if kind not in samples:
   refs=[json.loads(r[0]) for r in db.execute('select payload from refs where sha=?',(c['source_sha256'],))]
   samples[kind]={'candidate':c,'preview':preview,'refs':refs}
 except Exception as e:
  reason=str(e) if isinstance(e,ValueError) else type(e).__name__;bad[reason]+=1;failures.append({'id':c['id'],'reason':reason})
out=root/'structured-qa.json';out.write_text(json.dumps({'ready':dict(good),'failures_by_reason':dict(bad),'samples':samples,'failures':failures},ensure_ascii=False));out.chmod(0o600)
print(json.dumps({'ready':dict(good),'failures_by_reason':dict(bad),'private_report':str(out)}));db.close()
