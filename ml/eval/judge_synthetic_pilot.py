"""Four labelled synthetic Judge probes; explicit finite owner admission, no retries.

Preparation uses a CPU-only offline pinned processor container. The call mode
does not start or stop models; run only inside the owner's drained Judge window.
This is development evidence, not an independent acceptance benchmark.
"""
import base64
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont
from inspector_ml.paths import repo_root
from inspector_ml.vlm import JUDGE_PROMPT, parse_judgement
from inspector_ml.vlm_response import completed_text

MODEL = 'Qwen/Qwen3.5-9B'
REV = 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'
IMAGE = 'vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(root):
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    font = ImageFont.truetype(str(repo_root()/'assets/fonts/NotoSans.ttf'), 34)
    cases = [
        ('object-c0', 'Проектируемое здание.\nКласс конструктивной пожарной опасности С0.', 'С0', 'object'),
        ('object-c1', 'Реконструируемое здание.\nКласс конструктивной пожарной опасности С1.', 'С1', 'object'),
        ('neighbor', 'Соседнее здание.\nКласс конструктивной пожарной опасности С2.', 'С2', 'neighbor'),
        ('absent', 'Проектируемое здание.\nВысота 15 м. Ширина двери 900 мм.', None, None),
    ]
    rows = []
    for name, text, value, subject in cases:
        with Image.new('RGB', (1600, 260), 'white') as image:
            ImageDraw.Draw(image).multiline_text((25, 35), text, font=font, fill='black', spacing=20)
            image.save(root/f'{name}.png')
        rows.append({'name': name, 'sha256': sha(root/f'{name}.png'), 'expected_value': value,
                     'expected_subject': subject, 'text': text})
    (root/'prompt.txt').write_text(JUDGE_PROMPT)
    (root/'cases.json').write_text(json.dumps(rows, ensure_ascii=False))
    code = '''import json
from pathlib import Path
from transformers import AutoProcessor
p=AutoProcessor.from_pretrained('/hf/hub/models--Qwen--Qwen3.5-9B/snapshots/REV',local_files_only=True)
counts=[]
for row in json.loads(Path('/batch/cases.json').read_text()):
 messages=[{'role':'user','content':[{'type':'image','image':'/batch/'+row['name']+'.png'},{'type':'text','text':Path('/batch/prompt.txt').read_text()}]}]
 x=p.apply_chat_template(messages,tokenize=True,add_generation_prompt=True,return_dict=True,return_tensors='pt',enable_thinking=False)
 counts.append(int(x['input_ids'].shape[-1]))
Path('/batch/tokens.json').write_text(json.dumps(counts))
'''.replace('REV', REV)
    (root/'count.py').write_text(code)
    with (root/'processor.log').open('wb') as log:
        subprocess.run(['docker','run','--rm','--network','none','--cpus','2','--memory','4g',
            '--memory-swap','4g','--pids-limit','128','--cpuset-cpus',','.join(map(str,sorted(os.sched_getaffinity(0)))),
            '-e','HF_HUB_OFFLINE=1','-e','TRANSFORMERS_OFFLINE=1','-v','/opt/hf:/hf:ro',
            '-v',f'{root}:/batch','--entrypoint','python3',IMAGE,'/batch/count.py'],
            stdout=log,stderr=log,check=True,timeout=180)
    counts = json.loads((root/'tokens.json').read_text())
    for row,count in zip(rows,counts,strict=True):
        assert type(count) is int and 0 < count <= 8192
        row['input_tokens'] = count
    manifest = {'role':'synthetic_development','model':MODEL,'revision':REV,'image':IMAGE,
                'prompt_sha256':sha(root/'prompt.txt'),'kwargs':{'enable_thinking':False},'cases':rows}
    (root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    print(json.dumps({'manifest_sha256':sha(root/'manifest.json'),'cases':len(rows),'tokens':counts,'gpu_calls':0}))


def call(root, digest, admission):
    assert admission and sha(root/'manifest.json') == digest
    container=json.loads(subprocess.check_output(['docker','inspect','m022-judge-pilot']))[0]
    assert container['State']['Running'] and not container['State']['OOMKilled']
    assert container['Config']['Labels']['m022.admission']==admission and container['Config']['Image']==IMAGE
    manifest = json.loads((root/'manifest.json').read_text())
    assert manifest['model']==MODEL and manifest['revision']==REV and manifest['image']==IMAGE
    assert manifest['kwargs']=={'enable_thinking':False} and len(manifest['cases'])==4
    assert manifest['prompt_sha256']==sha(root/'prompt.txt')
    for row in manifest['cases']:
        assert row['name'] in ('object-c0','object-c1','neighbor','absent')
        assert sha(root/f"{row['name']}.png")==row['sha256'] and 0<row['input_tokens']<=8192
        with Image.open(root/f"{row['name']}.png") as image:
            assert image.format=='PNG' and max(image.size)<=2048 and image.width*image.height<=2_000_000
    os.umask(0o077)
    output=root/'calls'; output.mkdir(mode=0o700,exist_ok=False)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):
            return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    results=[]
    for row in manifest['cases']:
        body={'model':MODEL,'chat_template_kwargs':manifest['kwargs'],'temperature':0,'max_tokens':160,'stream':False,
              'messages':[{'role':'user','content':[
                  {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode((root/f"{row['name']}.png").read_bytes()).decode()}},
                  {'type':'text','text':(root/'prompt.txt').read_text()}]}]}
        entry={'name':row['name'],'admission':admission,'started':time.time(),'status':'started','retries':0}
        results.append(entry)
        (output/'results.json').write_text(json.dumps(results))
        try:
            request=urllib.request.Request('http://127.0.0.1:8001/v1/chat/completions',data=json.dumps(body).encode(),
                                           headers={'Content-Type':'application/json'},method='POST')
            with opener.open(request,timeout=60) as response:
                raw=response.read(1_048_577)
            assert len(raw)<=1_048_576
            (output/f"{row['name']}.json").write_bytes(raw)
            reply=json.loads(raw); judgement=parse_judgement(completed_text(reply))
            quote_ok=not judgement.quote or judgement.quote in row['text'].replace('\n',' ')
            passed=judgement.value==row['expected_value'] and (row['expected_subject'] is None or judgement.subject==row['expected_subject'])
            if judgement.value is not None:
                passed=passed and bool(judgement.quote) and quote_ok
            entry.update(status='completed',passed=passed,judgement=asdict(judgement),usage=reply.get('usage'),
                         response_sha256=hashlib.sha256(raw).hexdigest())
        except Exception as error:
            entry.update(status='failed',error=type(error).__name__)
            raise
        finally:
            entry['seconds']=time.time()-entry['started']
            (output/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print(json.dumps({'calls':len(results),'passed':sum(r['passed'] for r in results),'retries':0}))


if __name__=='__main__':
    if sys.argv[1]=='prepare': prepare(Path(sys.argv[2]))
    elif sys.argv[1]=='call': call(Path(sys.argv[2]),sys.argv[3],os.environ['JUDGE_ADMISSION_ID'])
    else: raise ValueError('prepare or call required')
