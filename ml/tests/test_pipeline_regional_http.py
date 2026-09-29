"""Regional checkpoints through the actual HTTP/archive/extraction contract."""
import uuid
import json
import pytest

from inspector_ml.model import Line, Page, ParsedDoc, Word
from inspector_ml.pipeline_contract import digest
from tests.test_parse_parts_http import service
from tests.test_pipeline_http import step


@pytest.mark.parametrize('unlocated', [False, True])
def test_regional_run_keeps_physical_pages_and_restorable_region_checkpoints(service, monkeypatch, unlocated):
    import inspector_ml.pipeline as pipeline
    client, app, _, _, sha = service
    if unlocated:
        from inspector_ml.model import AnalyzeResponse,Extraction
        def extract(request,path,doc):
            return AnalyzeResponse(sha256=sha,kind='pdf',engine='test',
                pages=[{'page':p.page} for p in doc.pages],
                extractions=[Extraction(code='TEST',raw='unlocated',page=1,bbox=None,
                    line_text='unlocated',confidence=.1) for _ in range(100)],facts=[],rooms=[])
        monkeypatch.setattr(app,'analyze_document',extract)
    response = client.post('/pipeline/v1/preflight', json={
        'run_id': str(uuid.uuid4()), 'policy': 'regional-v1',
        'request': {'sha256': sha, 'params': []}})
    assert response.status_code == 200, response.text
    plan = response.json()
    assert len(plan['regions']) > 5
    assert plan['context']['policy']['coverage'] == 'regional-full-coverage'
    calls = []

    def parse(path, sha, region, dpi, **kwargs):
        calls.append(region.id)
        box = region.bbox
        # A stable synthetic reading at the centre of each actual planned tile.
        line = Line(text='WIDTH 120 mm', words=[Word(text='WIDTH',bbox=box), Word(text='120',bbox=box),Word(text='mm',bbox=box)])
        page = Page(page=region.page,width=region.geometry.width,height=region.geometry.height,
                    rotation=region.geometry.rotation,source='ocr',
                    engines=plan['context']['policy']['required_ocr_engines'], lines=[line])
        return ParsedDoc(sha256=sha,kind='pdf',engine='test',pages=[page]), [], (1,0,0,1,0,0)

    monkeypatch.setattr(pipeline,'parse_region',parse)
    refs = []
    archives = []
    for region in plan['regions']:
        response = step(client,plan,'parse',region=region['id'])
        assert response.status_code == 200, response.text
        refs.append(response.json()['artifact'])
    warm = step(client,plan,'parse',region=plan['regions'][0]['id'])
    assert warm.json()['receipt']['cached'] and len(calls)==len(refs)
    for stage in ['merge','extract','aggregate']:
        response = step(client,plan,stage,refs)
        assert response.status_code == 200, response.text
        reply=response.json()
        exported=client.post('/pipeline/v1/artifacts/export',json={
            'context':plan['context'],'reference':reply['artifact'],'stage':stage})
        assert exported.status_code==200,exported.text
        archives.append(exported.json())
        refs=[reply['artifact']]
    assert [p['page'] for p in reply['result']['pages']]==[1,2,3,4,5]
    assert len(reply['trace']['pages'])==len(plan['regions'])
    assert reply['trace']['completeness']['coverage_scope']=='regional-full-coverage'
    if unlocated:
        for e in reply['result']['extractions']:
            provenance=e['meta']['pipeline']
            assert provenance['region_ids']==[] and provenance['region_id'] is None
            assert provenance['line_binding']=='source_page'
            assert len(json.dumps(provenance))<1000
    for archive in archives:
        restored=client.post('/pipeline/v1/artifacts/restore',json=archive)
        assert restored.status_code==200,restored.text
    # Even a newly hashed archive cannot claim a merged reading unsupported by
    # its own immutable source-region documents.
    archive=archives[0]
    archive['artifact']['payload']['doc']['pages'][0]['lines'][0]['text']='FORGED'
    archive['reference']=digest(archive['artifact'])
    assert client.post('/pipeline/v1/artifacts/restore',json=archive).status_code==409


def test_regional_policy_cannot_replace_a_frozen_legacy_run(service):
    client,_,_,_,sha=service
    request={'run_id':str(uuid.uuid4()),'request':{'sha256':sha,'params':[]}}
    assert client.post('/pipeline/v1/preflight',json=request).status_code==200
    assert client.post('/pipeline/v1/preflight',json={**request,'policy':'regional-v1'}).status_code==409


def test_regional_document_limit_is_checked_before_creating_jobs(service,monkeypatch):
    import inspector_ml.pipeline as pipeline
    client,_,_,_,sha=service
    monkeypatch.setattr(pipeline,'regional_plan',lambda page,**_: [page]*5001)
    response=client.post('/pipeline/v1/preflight',json={'run_id':str(uuid.uuid4()),
        'request':{'sha256':sha,'params':[]},'policy':'regional-v1'})
    assert response.status_code==409 and 'regional plan limit' in response.text
