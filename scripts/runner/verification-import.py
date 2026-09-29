#!/usr/bin/env python3
"""Resumable private SQLite staging -> authenticated durable annotation queue.
Never modifies the staging DB. A checkpoint advances only after the API commits.
"""
import argparse, fcntl, hashlib, json, os, re, sqlite3, ssl, time, urllib.request, urllib.error
from pathlib import Path


def object_key(ref):
    authority=str(ref.get('object') or '')
    if not authority or authority.lower() in ('unknown','none','null'): authority=str(ref['archive'])
    return 'catalog:'+hashlib.sha256(authority.encode()).hexdigest()[:32]


def side(candidate, ref, kind, staging=None, structured=None):
    ex=candidate['extraction']; sha=candidate['source_sha256']
    if not re.fullmatch('[a-f0-9]{64}',sha): raise ValueError('invalid_sha')
    page=int(candidate['page'])
    if page<1: raise ValueError('invalid_page')
    name=str(ref['path'])
    provenance=candidate.get('provenance',{}).copy()
    provenance.update({'candidate_id':candidate['id'],'catalog_archive':ref['archive'],'catalog_path':name,
                       'catalog_object':ref.get('object'),'association_authority':'exact_catalog_entry',
                       'candidate_status':'machine_candidate'})
    crop=None
    crop_path=provenance.get('crop_path')
    # Exact filenames emitted by the Reader worker; do not infer a page from arbitrary text.
    if crop_path:
        match=re.fullmatch(re.escape(sha)+r'-p(\d+)-b([0-3])\.png',Path(crop_path).name)
        if not match or int(match[1])!=page: raise ValueError('invalid_crop')
        if staging is None:raise ValueError('crop_requires_private_staging')
        image=(Path(staging)/'reader'/Path(crop_path).name).resolve()
        if image.parent != (Path(staging)/'reader').resolve():raise ValueError('crop_outside_staging')
        if os.geteuid()==0:
            os.chown(image,-1,65532);image.chmod(image.stat().st_mode|0o040)
        with image.open('rb') as f: crop_sha=hashlib.file_digest(f,'sha256').hexdigest()
        crop={'page':page,'band':int(match[2]),'sha256':crop_sha}
    # Current CPU records may have no word boxes. Keep that explicit.
    box=ex.get('bbox');anchor=ex.get('anchor_bbox')
    def valid_box(b):
        return isinstance(b,list) and len(b)==4 and all(isinstance(x,(int,float)) and 0<=x<=1 for x in b) and b[0]<b[2] and b[1]<b[3]
    if not valid_box(box): box=None
    if not valid_box(anchor): anchor=None
    if structured:box=anchor=None
    return {'sha256':sha,'file_name':name,'kind':kind,'page':page,'bbox':box,'anchor_bbox':anchor,
            'value':str(ex.get('raw') or ex.get('value_text') or ex.get('value_num') or '')[:2000],
            'quote':str(ex.get('line_text') or '')[:4000],'object_key':object_key(ref),'stage':None,
            'file_id':None,'inspection_id':None,'revision':None,'artifact_sha256':candidate.get('artifact_sha256'),
            'geometry':'coarse_band' if crop else 'word' if box else 'none','crop':crop,**({'preview':structured} if structured else {}),'provenance':provenance}


def tasks_for(candidate, refs, kind, version, staging=None, structured=None):
    if not re.fullmatch(r'M-(?:00[1-9]|0[1-9]\d|1[0-2]\d|13[0-2])',candidate['parameter']):return []
    # Unsupported viewers are explicitly skipped until a faithful rendering exists.
    if kind not in ('pdf','image') and not(kind in ('docx','xlsx','xml') and structured):return []
    tasks=[];seen=set()
    for ref in refs:
        if 'archive' not in ref or 'path' not in ref:continue
        if not re.match(r'^(01_|1[0-8]_)',ref['archive']):continue
        s=side(candidate,ref,kind,staging,structured)
        identity=s['object_key']
        if identity in seen:continue
        seen.add(identity)
        tasks.append({'parameter':candidate['parameter'],'operation':'reading','sides':[s],
                      'source_version':version,'difficulty':'hard' if s['geometry']=='coarse_band' else 'ordinary'})
    return tasks


def prepare_pair_index(path):
    db=sqlite3.connect(path)
    db.execute('CREATE TABLE IF NOT EXISTS seeds(object_key TEXT,parameter TEXT,sha TEXT,side TEXT,PRIMARY KEY(object_key,parameter,sha))')
    db.commit()
    Path(path).chmod(0o600)
    return db


def pair_tasks(task, index):
    """One bounded star of documents per proven object/parameter, never a Cartesian join.
    The mixed archive 01 contains several objects without per-entry disambiguation;
    its broad catalog object value is not authority for a document pair.
    A human confirms field identity before the API creates a comparison task.
    """
    s=task['sides'][0];p=s['provenance'];obj=s['object_key'];parameter=task['parameter']
    if not re.match(r'^1[0-8]_',p.get('catalog_archive','')):return []
    authority=str(p.get('catalog_object') or '')
    if not authority or authority.lower() in ('unknown','none','null'):return []
    if not s['value'].strip():return []
    if index.execute('SELECT 1 FROM seeds WHERE object_key=? AND parameter=? AND sha=?',(obj,parameter,s['sha256'])).fetchone():return []
    anchor=index.execute('SELECT side FROM seeds WHERE object_key=? AND parameter=? ORDER BY rowid LIMIT 1',(obj,parameter)).fetchone()
    index.execute('INSERT INTO seeds VALUES(?,?,?,?)',(obj,parameter,s['sha256'],json.dumps(s,ensure_ascii=False)))
    if not anchor:return []
    first=json.loads(anchor[0])
    return [{'parameter':parameter,'operation':'field_match','sides':[first,s],
             'source_version':task['source_version'],
             'difficulty':'hard' if any(x['geometry']=='coarse_band' for x in (first,s)) else 'ordinary'}]


def request(endpoint,path,payload,token=None):
    raw=json.dumps(payload,ensure_ascii=False).encode()
    req=urllib.request.Request(endpoint+path,data=raw,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
    try:
        with urllib.request.urlopen(req,timeout=120,context=ssl.create_default_context(cafile=os.environ.get('VERIFICATION_CA_FILE'))) as r:return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            failure=json.load(e)
            fields=[{'path':d.get('path'),'keyword':d.get('keyword')} for d in failure.get('details',[])[:5]]
        except Exception: fields=[]
        raise RuntimeError(json.dumps({'http_status':e.code,'schema_fields':fields})) from None


def run(a):
    root=Path(a.staging).resolve(); checkpoint=Path(a.checkpoint).resolve()
    checkpoint.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=checkpoint.with_suffix('.lock').open('a');lock_path=checkpoint.with_suffix('.lock');lock_path.chmod(0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    db=sqlite3.connect(f'file:{root / "candidates.sqlite"}?mode=ro',uri=True,timeout=30)
    refs={}
    for sha,payload in db.execute('select sha,payload from refs'):
        refs.setdefault(sha,[]).append(json.loads(payload))
    state=json.loads(checkpoint.read_text()) if checkpoint.exists() else {'rowid':0,'inserted':0,'duplicates':0,'skipped':0,'source_version':a.source_version,'operation':a.operation}
    if state['source_version']!=a.source_version:raise ValueError('checkpoint_version_mismatch')
    if state.get('operation','reading')!=a.operation:raise ValueError('checkpoint_operation_mismatch')
    index=prepare_pair_index(checkpoint.with_suffix('.pairs.sqlite')) if a.operation=='pairs' else None
    auth=json.loads(Path(a.credentials).read_text()); token=None;auth_at=0
    batches=0
    while True:
        if a.max_batches and batches>=a.max_batches:break
        if token is None or time.monotonic()-auth_at>1800:
            token=request(a.endpoint,'/api/v1/auth/login',auth)['token'];auth_at=time.monotonic()
        if not state.get('source_associations_done'):
            members=sorted({(object_key(r),sha) for sha,rs in refs.items() for r in rs if 'archive' in r and re.match(r'^(01_|1[0-8]_)',r['archive'])})
            for start in range(0,len(members),1000):
                request(a.endpoint,'/api/v1/verification/ingestions',{'id':a.ingestion,'source_version':a.source_version,'tasks':[],
                    'source_associations':[{'object_key':obj,'sha256':sha} for obj,sha in members[start:start+1000]],
                    'cursor':{'candidate_rowid':state['rowid']},'inventory':{'source_memberships':len(members)}},token)
            state['source_associations_done']=True
        format_filter=" and s.kind in ('docx','xlsx','xml')" if a.formats=='structured' else ''
        rows=db.execute('select c.rowid,c.payload,s.kind from candidates c join sources s on s.sha=c.sha where c.rowid>?'+format_filter+' order by c.rowid limit 50',(state['rowid'],)).fetchall()
        if not rows:
            if a.once:break
            time.sleep(10);continue
        tasks=[];skipped=0
        if index:index.execute('BEGIN')
        # One API chunk may fan out to several exact catalog associations.
        for rowid,payload,kind in rows:
            c=json.loads(payload);structured=None
            if a.formats=='structured':
                if kind not in ('docx','xlsx','xml'):skipped+=1;continue
                from importlib.util import spec_from_file_location,module_from_spec
                if 'renderer' not in locals():
                    spec=spec_from_file_location('structured_preview',Path(__file__).with_name('verification-structured.py'));renderer=module_from_spec(spec);spec.loader.exec_module(renderer)
                try:structured=renderer.preview(c,kind,root,a.corpus)
                except Exception as error:
                    # Private accounting retains rejected candidate IDs, never payload in stdout.
                    reason=str(error) if isinstance(error,ValueError) else type(error).__name__
                    failures=state.setdefault('preview_failures',{});failures[reason]=failures.get(reason,0)+1
                    skipped+=1;continue
            made=tasks_for(c,refs.get(c['source_sha256'],[]),kind,a.source_version,root,structured)
            if index:made=[pair for task in made for pair in pair_tasks(task,index)]
            tasks.extend(made);skipped+=not bool(made)
        status=json.loads((root/'status.json').read_text())
        inventory={k:status.get(k) for k in ('sources','bands','coverage','candidates','updated_at','code_sha','phase')}
        inventory.update({('non_rendered_candidate_rows' if a.operation=='reading' else 'unpaired_candidate_rows'):state['skipped']+skipped,
                          'operation':a.operation,'pair_strategy':'first_distinct_source_per_proven_object_parameter' if index else None,
                          'pair_mixed_archive_excluded':bool(index),'staging_root_id':root.name,'viewer_supported':['docx','xlsx','xml'] if a.formats=='structured' else ['pdf','image'],
                          'preview_failures':state.get('preview_failures',{})})
        # Dedup handles a crash after one subchunk; final cursor commits only with the final subchunk.
        chunks=[tasks[i:i+100] for i in range(0,len(tasks),100)] or [[]]
        inserted=duplicates=0
        for i,chunk in enumerate(chunks):
            final=i==len(chunks)-1
            result=request(a.endpoint,'/api/v1/verification/ingestions',{'id':a.ingestion,'source_version':a.source_version,'tasks':chunk,
                         'cursor':{'candidate_rowid':rows[-1][0] if final else state['rowid']},'inventory':inventory},token)
            inserted+=result['inserted'];duplicates+=result['duplicates']
        # The pair seed index advances only after all API chunks are acknowledged.
        # If a process dies after this commit, API fingerprint dedup preserves its pairs.
        if index:index.commit()
        state.update(rowid=rows[-1][0],inserted=state['inserted']+inserted,duplicates=state['duplicates']+duplicates,skipped=state['skipped']+skipped)
        temporary=checkpoint.with_suffix('.tmp');temporary.write_text(json.dumps(state));temporary.chmod(0o600);os.replace(temporary,checkpoint)
        batches+=1
        print(json.dumps({'cursor':state['rowid'],'inserted':inserted,'duplicates':duplicates,'skipped':skipped}),flush=True)
    db.close()
    if index:index.close()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--staging',required=True);p.add_argument('--checkpoint',required=True);p.add_argument('--credentials',required=True)
    p.add_argument('--endpoint',default='https://127.0.0.1:48844');p.add_argument('--source-version',required=True);p.add_argument('--ingestion',default='working-corpus-t244');p.add_argument('--once',action='store_true');p.add_argument('--max-batches',type=int,default=0)
    p.add_argument('--operation',choices=('reading','pairs'),default='reading')
    p.add_argument('--formats',choices=('raster','structured'),default='raster');p.add_argument('--corpus',default='/opt/corpus/blobs')
    a=p.parse_args()
    if not re.fullmatch(r'https?://(?:127\.0\.0\.1|localhost):\d+',a.endpoint):p.error('endpoint must be loopback')
    try:run(a)
    except RuntimeError as e:
        # Invalid contracts/credentials need a correction, not a restart loop.
        try:code=json.loads(str(e)).get('http_status')
        except (ValueError,TypeError):code=None
        if code and 400<=code<500 and code!=429:
            print(str(e),flush=True);raise SystemExit(65)
        raise
