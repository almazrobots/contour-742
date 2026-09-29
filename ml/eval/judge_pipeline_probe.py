"""Owner-admitted real Judge and mandatory ML pipeline fault probe on synthetic PDF.

Exercises production ML functions and file checkpoints; API coordinator/SQL
publication are not part of this probe. Fault relays are loopback-only, serial,
and drain upstream requests before releasing the GPU window.
"""
import argparse
import base64
from datetime import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
from uuid import uuid4


def setup(root):
    os.environ.update(INSPECTOR_PROFILE='dev', INSPECTOR_OCR_ENGINES='tesseract',
        INSPECTOR_VLM_BACKEND='openai', INSPECTOR_JUDGE_PHASE='on',
        INSPECTOR_VLM_JUDGE='Qwen/Qwen3.5-9B',
        INSPECTOR_VLM_JUDGE_REVISION='c202236235762e1c871ad0ccb60c8ee5ba337b9a',
        INSPECTOR_BLOB_DIR=str(root/'blobs'), INSPECTOR_ML_CACHE=str(root/'cache'),
        INSPECTOR_VLM_URL='http://127.0.0.1:8001/v1')
    os.environ.pop('INSPECTOR_READER_CACHE', None)


def request(root):
    from inspector_ml.model import AnalyzeRequest, ParamSpec
    from inspector_ml.paths import repo_root
    passport=json.loads((repo_root()/'data/seed/passports/M-023.json').read_text())
    cfg=passport['extractor'] | {k:passport['value'][k] for k in ('scale','constraint_markers')}
    return AnalyzeRequest(sha256=json.loads((root/'source.json').read_text())['sha256'],
        params=[ParamSpec(code='M-023',anchors=['Класс конструктивной пожарной опасности'],extractor=cfg)])


def prepare(root):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from inspector_ml.paths import repo_root
    from inspector_ml.parse import parse_file
    from inspector_ml.class_mentions import extract_class_mentions
    from inspector_ml.vlm_verify import mention_box
    from inspector_ml import vlm
    root.mkdir(mode=0o700,parents=True,exist_ok=False);(root/'blobs').mkdir()
    pdfmetrics.registerFont(TTFont('ProbeNoto',str(repo_root()/'assets/fonts/NotoSans.ttf')))
    path=root/'source.pdf';c=canvas.Canvas(str(path),pagesize=(500,180));c.setFont('ProbeNoto',15)
    c.drawString(20,140,'Проектируемое здание.');c.drawString(20,105,'Класс конструктивной пожарной опасности С0.')
    c.showPage();c.save();sha=hashlib.sha256(path.read_bytes()).hexdigest()
    (root/'source.json').write_text(json.dumps({'sha256':sha,'role':'synthetic_development'}))
    (root/'blobs'/sha).write_bytes(path.read_bytes())
    req=request(root);doc=parse_file(path,sha);assert all(p.source=='text' for p in doc.pages)
    mentions=extract_class_mentions(doc,req.params[0]);assert len(mentions)==1
    with vlm.render_page(path,1) as image:
        with vlm.crop_box(image,mention_box(mentions[0])) as crop:
            assert crop.width*crop.height<=2_000_000 and max(crop.size)<=2048
            crop.save(root/'crop.png')
    (root/'prompt.txt').write_text(vlm.JUDGE_PROMPT)
    # The same pinned processor and kwargs as the real request; CPU-only.
    code="""from transformers import AutoProcessor
from pathlib import Path
import json
p=AutoProcessor.from_pretrained('/hf/hub/models--Qwen--Qwen3.5-9B/snapshots/c202236235762e1c871ad0ccb60c8ee5ba337b9a',local_files_only=True)
m=[{'role':'user','content':[{'type':'image','image':'/probe/crop.png'},{'type':'text','text':Path('/probe/prompt.txt').read_text()}]}]
x=p.apply_chat_template(m,tokenize=True,add_generation_prompt=True,return_dict=True,return_tensors='pt',enable_thinking=False)
Path('/probe/tokens.json').write_text(json.dumps({'input_tokens':int(x['input_ids'].shape[-1])}))
"""
    (root/'tokens.py').write_text(code)
    image='vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90'
    with (root/'processor.log').open('wb') as log:
        subprocess.run(['docker','run','--rm','--network','none','--cpus','2','--memory','4g','--memory-swap','4g',
            '-e','HF_HUB_OFFLINE=1','-e','TRANSFORMERS_OFFLINE=1','-v','/opt/hf:/hf:ro','-v',f'{root}:/probe',
            '--entrypoint','python3',image,'/probe/tokens.py'],stdout=log,stderr=log,check=True,timeout=180)
    tokens=json.loads((root/'tokens.json').read_text())['input_tokens'];assert 0<tokens<=8192
    print(json.dumps({'prepared':True,'input_tokens':tokens,'gpu_calls':0}))


def probe(root, admission, deadline):
    cutoff=datetime.fromisoformat(deadline)
    assert cutoff.tzinfo is not None and cutoff.timestamp()>time.time()+60
    container=json.loads(subprocess.check_output(['docker','inspect','m022-judge-pilot']))[0]
    assert admission and container['State']['Running'] and container['Config']['Labels']['m022.admission']==admission
    assert 0<json.loads((root/'tokens.json').read_text())['input_tokens']<=8192
    from inspector_ml import app as service
    from inspector_ml.pipeline import PreflightRequest, StepRequest
    req=request(root);out=root/'results';out.mkdir(mode=0o700,exist_ok=False)
    report=[]
    for mode in ('success','unavailable','incomplete','timeout'):
        assert time.time()+60<cutoff.timestamp(), 'not enough time for a bounded request'
        calls=[]
        class Relay(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                entry={'started':time.time()};calls.append(entry)
                try:
                    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    assert body['chat_template_kwargs']=={'enable_thinking':False} and body['max_tokens']==160
                    assert body['model']=='Qwen/Qwen3.5-9B'
                    content=body['messages'][0]['content']
                    assert content[1]['text']==(root/'prompt.txt').read_text()
                    image_bytes=base64.b64decode(content[0]['image_url']['url'].split(',',1)[1])
                    assert hashlib.sha256(image_bytes).digest()==hashlib.sha256((root/'crop.png').read_bytes()).digest()
                    assert time.time()+60<cutoff.timestamp(), 'owner deadline too close'
                    if mode=='unavailable':
                        self.send_error(503);return
                    if mode=='incomplete': body['max_tokens']=1
                    upstream=urllib.request.Request('http://127.0.0.1:8001/v1/chat/completions',
                        data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
                    with urllib.request.urlopen(upstream,timeout=60) as response: raw=response.read(1_048_577)
                    assert len(raw)<=1_048_576
                    entry['finish_reason']=json.loads(raw)['choices'][0]['finish_reason']
                    (out/f'{mode}-{len(calls)}.json').write_bytes(raw)
                    if mode=='timeout': time.sleep(2)
                    self.send_response(200);self.end_headers();self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError): entry['client_disconnected']=True
                finally: entry['finished']=time.time()
        server=ThreadingHTTPServer(('127.0.0.1',0),Relay)
        worker=threading.Thread(target=server.serve_forever);worker.start()
        os.environ['INSPECTOR_VLM_URL']=f'http://127.0.0.1:{server.server_port}/v1'
        os.environ['INSPECTOR_JUDGE_TIMEOUT_S']='1' if mode=='timeout' else '60'
        try:
            pipeline=service._pipeline();plan=pipeline.preflight(PreflightRequest(run_id=str(uuid4()),request=req))
            assert plan.context.policy.require_judge
            refs=[pipeline.execute('parse',StepRequest(context=plan.context,plan=plan.artifact,region_id=r.id)).artifact for r in plan.regions]
            for stage in ('merge','extract','aggregate'):
                result=pipeline.execute(stage,StepRequest(context=plan.context,plan=plan.artifact,inputs=refs));refs=[result.artifact]
            expected=mode=='success'
            assert result.trace.completeness.publishable==expected and (result.result is not None)==expected
            if not expected: assert any(x.startswith('missing_judge:') for x in result.trace.completeness.reasons)
            first=service.analyze(req);second=service.analyze(req)
            assert not first.cached and second.cached==expected
            assert len(calls)==(2 if expected else 3), 'unexpected cache hit or retry'
            (out/f'{mode}-trace.json').write_text(result.model_dump_json())
        finally:
            server.shutdown();worker.join();server.server_close()  # waits for delayed upstream calls too
        assert all('finished' in c for c in calls)
        report.append({'mode':mode,'passed':True,'http_calls':len(calls),'calls':calls,
            'publishable':result.trace.completeness.publishable,'configuration':plan.context.configuration_fingerprint})
        (out/'status.json').write_text(json.dumps({'admission':admission,'cases':report},indent=2))
    print(json.dumps({'passed':True,'cases':len(report),'http_calls':sum(x['http_calls'] for x in report)}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','probe']);p.add_argument('root',type=Path)
    p.add_argument('--deadline-utc')
    a=p.parse_args();os.umask(0o077);setup(a.root)
    if a.mode=='prepare': prepare(a.root)
    else:
        assert a.deadline_utc, 'explicit owner deadline required'
        probe(a.root,os.environ.get('JUDGE_ADMISSION_ID',''),a.deadline_utc)
