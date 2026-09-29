from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from PIL import Image
from inspector_ml import execution_scope as S, vlm


def config(monkeypatch):
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_URL", "http://127.0.0.1:47813")
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_NAMESPACE", "test-scope")
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_IDENTITY", "pinned-identity")


def test_scope_survives_nested_pool_and_never_leaks():
    job = str(uuid4())
    with ThreadPoolExecutor(2) as pool:
        with S.execution_scope(job, 1):
            def nested():
                with ThreadPoolExecutor(2) as inner:
                    return S.scoped_submit(inner, S.current_scope).result()
            assert S.scoped_submit(pool, nested).result() == {"job_id": job, "epoch": 1}
        assert S.scoped_submit(pool, S.current_scope).result() is None
    assert S.current_scope() is None


@pytest.mark.parametrize("namespace", ["a", "test-scope_2", "a" * 64, "A", "1scope", "_scope", "a" * 65, "", "scope\n"])
def test_namespace_contract_matches_proxy(monkeypatch, namespace):
    from pydantic import ValidationError
    from inspector_ml.execution_proxy import Scope
    config(monkeypatch)
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_NAMESPACE", namespace)
    try:
        Scope(namespace=namespace, job_id=str(uuid4()), epoch=1)
    except ValidationError:
        with pytest.raises(RuntimeError):
            S._config()
    else:
        assert S._config()[1] == namespace


def test_durable_vlm_cannot_bypass_missing_proxy(monkeypatch):
    monkeypatch.setenv("INSPECTOR_VLM_URL", "http://127.0.0.1:9/v1")
    monkeypatch.delenv("INSPECTOR_EXECUTION_PROXY_URL", raising=False)
    with S.execution_scope(str(uuid4()), 1), pytest.raises(ValueError):
        vlm._openai_generate("model", Image.new("RGB", (2, 2)), "text", 10)


def test_polling_preserves_identity_and_request(monkeypatch):
    config(monkeypatch)
    calls = []
    def post(url, payload, timeout):
        calls.append(payload)
        return {**{k: payload[k] for k in ("namespace", "job_id", "epoch")},
                "journal_identity": "pinned-identity", "request_digest": S.digest(payload["request"]),
                "status": "RUNNING" if len(calls) == 1 else "COMPLETED",
                "response": {"choices": [{"finish_reason": "stop", "message": {"content": " result "}}]}}
    monkeypatch.setattr(S, "_post", post)
    with S.execution_scope(str(uuid4()), 1):
        assert S.generate_scoped({"model": "synthetic"}, 1) == "result"
    assert len(calls) == 2 and calls[0] == calls[1]


@pytest.mark.parametrize("damage", ["identity", "scope", "pending", "unsealed", "false"])
def test_quiescence_rejects_foreign_or_incomplete_proofs(monkeypatch, damage):
    config(monkeypatch)
    def post(url, payload, timeout):
        result = {**payload, "journal_identity": "pinned-identity", "sealed": True, "quiescent": True,
                  "requests": [{"request_digest": "a" * 64, "status": "COMPLETED"}]}
        if damage == "identity": result["journal_identity"] = "other"
        if damage == "scope": result["epoch"] = 2
        if damage == "pending": result["requests"][0]["status"] = "UNKNOWN"
        if damage == "unsealed": result["sealed"] = False
        if damage == "false": result["quiescent"] = False
        return result
    monkeypatch.setattr(S, "_post", post)
    if damage in {"identity", "scope"}:
        with pytest.raises(RuntimeError): S.seal_external(str(uuid4()), 1)
    else:
        assert not S.seal_external(str(uuid4()), 1)["quiescent"]
