import importlib.util,json,sqlite3,collections,difflib
from pathlib import Path
spec=importlib.util.spec_from_file_location('structured',Path(__file__).with_name('verification-structured.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path('/opt/w1-gate/eval/verification/t244-096ba1028e71b2294600e7c340b42b03808bd032');db=sqlite3.connect(f'file:{root/"candidates.sqlite"}?mode=ro',uri=True)
counts=collections.Counter();examples={}
for payload,kind in db.execute("select c.payload,s.kind from candidates c join sources s on s.sha=c.sha where s.kind in ('xlsx','docx','xml') order by c.rowid"):
 c=json.loads(payload);sheet=m.original('/opt/corpus/blobs/'+c['source_sha256'],c['source_sha256'],kind)[int(c['page'])-1];needle=m.norm(c['extraction']['line_text']);rows=[m.norm(' '.join(v for v in row if v)) for row in sheet['rows']]
 category='exact' if needle in rows else 'substring' if any(needle in row or row and row in needle for row in rows) else 'absent'
 counts[kind+':'+category]+=1
 if category!='exact' and kind not in examples:
  nearest=max(rows,key=lambda r:difflib.SequenceMatcher(None,needle,r).ratio())
  examples[kind]={'candidate':c,'nearest_original_line':nearest,'needle_length':len(needle),'nearest_length':len(nearest),'ratio':difflib.SequenceMatcher(None,needle,nearest).ratio()}
p=root/'structured-diagnostic.json';p.write_text(json.dumps(examples,ensure_ascii=False));p.chmod(0o600)
print(json.dumps({'match_types':dict(counts),'private_examples':str(p),'lengths':{k:{x:v[x] for x in ['needle_length','nearest_length','ratio']} for k,v in examples.items()}}))
