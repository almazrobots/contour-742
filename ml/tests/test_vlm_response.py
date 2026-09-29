import io
import json
from uuid import uuid4

import pytest
from PIL import Image
from inspector_ml import execution_scope as scope, vlm
from inspector_ml.vlm_response import completed_text


@pytest.mark.parametrize('reason', ['length', 'content_filter', 'tool_calls', None, 'unknown'])
@pytest.mark.parametrize('durable', [False, True])
def test_incomplete_generation_never_returns_partial_text(monkeypatch, reason, durable):
    reply = {'choices': [{'finish_reason': reason, 'message': {'content': '{"value":"С1"}'}}]}
    calls = []
    monkeypatch.setenv('INSPECTOR_VLM_URL', 'http://127.0.0.1:8000/v1')
    if durable:
        monkeypatch.setattr(scope, '_config', lambda: ('http://127.0.0.1:1', 'test', 'identity'))
        def post(url, payload, timeout):
            calls.append(payload)
            return {**{k: payload[k] for k in ('namespace', 'job_id', 'epoch')},
                    'journal_identity': 'identity', 'request_digest': scope.digest(payload['request']),
                    'status': 'COMPLETED', 'response': reply}
        monkeypatch.setattr(scope, '_post', post)
        with scope.execution_scope(str(uuid4()), 1), pytest.raises(RuntimeError, match='incomplete'):
            vlm._openai_generate('synthetic', Image.new('RGB', (2, 2)), 'OCR:', 16)
    else:
        def urlopen(request, timeout):
            calls.append(request)
            return io.BytesIO(json.dumps(reply).encode())
        monkeypatch.setattr('urllib.request.urlopen', urlopen)
        with pytest.raises(RuntimeError, match='incomplete'):
            vlm._openai_generate('synthetic', Image.new('RGB', (2, 2)), 'OCR:', 16)
    assert len(calls) == 1


@pytest.mark.parametrize('response', [None, {}, {'choices': []}, {'choices': [None]},
    {'choices': [{'finish_reason': 'stop', 'message': {'content': None}}]},
    {'choices': [{'finish_reason': 'stop', 'message': {'content': 'x', 'tool_calls': [{}]}}]}])
def test_malformed_response_is_not_success(response):
    with pytest.raises(RuntimeError):
        completed_text(response)


def test_empty_completed_transcription_is_allowed():
    assert completed_text({'choices': [{'finish_reason': 'stop', 'message': {'content': '  '}}]}) == ''
