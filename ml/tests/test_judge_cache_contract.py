"""Judge changes invalidate analysis; transient failures never become cache hits."""
import io
import json
from pathlib import Path

import pytest
from PIL import Image

from inspector_ml import app as service, vlm
from inspector_ml.cache import FileCache
from inspector_ml.model import AnalyzeRequest, AnalyzeResponse, Extraction


@pytest.mark.parametrize('change', ['model', 'revision', 'prompt', 'schema', 'endpoint'])
def test_judge_contract_changes_both_analysis_key_and_revision(monkeypatch, change):
    monkeypatch.setenv('INSPECTOR_VLM_BACKEND', 'openai')
    monkeypatch.setenv('INSPECTOR_JUDGE_PHASE', 'on')
    monkeypatch.setattr(service, 'get_embedder', lambda: None)
    request = AnalyzeRequest(sha256='a' * 64, params=[], facts=[])
    before = service._cache_key(request), service.ml_revision()
    if change == 'model': monkeypatch.setattr(vlm, 'JUDGE', 'different-model')
    elif change == 'revision': monkeypatch.setenv('INSPECTOR_VLM_JUDGE_REVISION', 'new-pinned-revision')
    elif change == 'prompt': monkeypatch.setattr(vlm, 'JUDGE_PROMPT', vlm.JUDGE_PROMPT + ' Changed.')
    elif change == 'schema': monkeypatch.setattr(vlm, 'JUDGE_SCHEMA_VERSION', vlm.JUDGE_SCHEMA_VERSION + 1)
    else: monkeypatch.setenv('INSPECTOR_VLM_URL', 'http://127.0.0.1:8001/v1')
    after = service._cache_key(request), service.ml_revision()
    assert all(a != b for a, b in zip(before, after))


@pytest.mark.parametrize('outcome', ['error', 'skipped', None])
def test_incomplete_judge_is_retried_and_only_complete_result_is_cached(monkeypatch, tmp_path, outcome):
    monkeypatch.setenv('INSPECTOR_VLM_BACKEND', 'openai')
    monkeypatch.setenv('INSPECTOR_JUDGE_PHASE', 'on')
    monkeypatch.setattr(service, 'get_embedder', lambda: None)
    monkeypatch.setattr(service, 'CACHE', FileCache(tmp_path))
    monkeypatch.setattr(service, '_blob', lambda _: Path('synthetic.pdf'))
    monkeypatch.setattr(service, 'load_parsed', lambda *args: (None, True))
    calls = []
    def analyze(*args):
        calls.append(1)
        meta = {'ops': ['ENT-16']}
        if len(calls) > 1: meta['vlm'] = {'outcome': 'confirmed'}
        elif outcome is not None: meta['vlm'] = {'outcome': outcome}
        return AnalyzeResponse(sha256='a'*64, kind='pdf', engine='synthetic', pages=[], facts=[], rooms=[],
            extractions=[Extraction(code='M-023', raw='С0', value_text='С0', page=1,
                bbox=None, line_text='Класс С0', confidence=1, meta=meta)])
    monkeypatch.setattr(service, 'analyze_document', analyze)
    request = AnalyzeRequest(sha256='a'*64, params=[], facts=[])
    assert not service.analyze(request).cached
    assert not service.analyze(request).cached
    assert service.analyze(request).cached
    assert len(calls) == 2


def test_actual_judge_http_request_disables_thinking(monkeypatch):
    monkeypatch.setenv('INSPECTOR_VLM_URL', 'http://127.0.0.1:8001/v1')
    bodies = []
    def urlopen(request, timeout):
        bodies.append(json.loads(request.data))
        return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop', 'message':{'content':'{}'}}]}).encode())
    monkeypatch.setattr('urllib.request.urlopen', urlopen)
    vlm._openai_generate(vlm.JUDGE, Image.new('RGB', (2,2)), vlm.JUDGE_PROMPT, 160)
    assert bodies[0]['chat_template_kwargs'] == {'enable_thinking': False}
    assert bodies[0]['max_tokens'] == 160


@pytest.mark.parametrize('value', ['0', '301', 'nan', 'inf', 'invalid'])
def test_judge_timeout_rejects_unbounded_or_invalid_configuration(monkeypatch, value):
    monkeypatch.setenv('INSPECTOR_JUDGE_TIMEOUT_S', value)
    with pytest.raises(ValueError): vlm.judge_timeout()


def test_judge_timeout_is_forwarded_and_changes_contract(monkeypatch):
    monkeypatch.setenv('INSPECTOR_JUDGE_TIMEOUT_S', '300')
    before=vlm.judge_fingerprint()
    monkeypatch.setenv('INSPECTOR_JUDGE_TIMEOUT_S', '1')
    calls=[]
    monkeypatch.setattr(vlm, 'generate', lambda *args, **kwargs: calls.append(kwargs) or '{}')
    vlm.judge_mention(Image.new('RGB',(2,2)))
    assert calls[0]['timeout']==1 and vlm.judge_fingerprint()!=before
