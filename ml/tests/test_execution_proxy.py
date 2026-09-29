"""Synthetic external-execution proxy faults. No GPU or model processes."""
import asyncio
import multiprocessing
from pathlib import Path
import shutil
from threading import Event
import time
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from inspector_ml.cache import FileCache
from inspector_ml.execution_proxy import ProxyJournal, Scope, create_app
from inspector_ml.pipeline_contract import digest
from tests.test_pipeline_execution import MemoryCache

BODY = {"model": "synthetic", "messages": [{"role": "user", "content": "PRIVATE_CROP_AND_TEXT"}], "max_tokens": 7}
REPLY = {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "PRIVATE_REPLY"}}]}


def scope():
    return {"namespace": "test-session", "job_id": str(uuid4()), "epoch": 1}


def poll(client, body, status):
    until = time.monotonic() + 10
    while time.monotonic() < until:
        response = client.post("/executions/request", json=body)
        assert response.status_code == 200, response.text
        if response.json()["status"] == status:
            return response.json()
        time.sleep(0.01)
    raise AssertionError(f"proxy did not reach {status}")


def test_seal_waits_for_registered_upstream_and_rejects_late_post(tmp_path):
    entered, release = Event(), Event()
    calls = []
    async def upstream(body):
        calls.append(body); entered.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return REPLY
    root, cache, identity = tmp_path / "journal", MemoryCache(), str(uuid4())
    app = create_app(root, cache, upstream, journal_identity=identity, initialize=True, namespace="test-session")
    request = {**scope(), "request": BODY}
    with TestClient(app) as client:
        response = client.post("/executions/request", json=request)
        assert response.json()["status"] == "RUNNING"
        response.close()  # The initiating request has ended, external work must continue.
        assert entered.wait(5)
        assert client.post("/executions/request", json=request).json()["status"] == "RUNNING"
        sealed = client.post("/executions/seal", json={k: request[k] for k in scope()}).json()
        assert sealed["sealed"] and not sealed["quiescent"]
        assert sealed["journal_identity"] == identity
        late = {**request, "request": {**BODY, "max_tokens": 8}}
        assert client.post("/executions/request", json=late).json()["status"] == "REJECTED"
        release.set()
        completed = poll(client, request, "COMPLETED")
        assert completed["response"] == REPLY and completed["request_digest"] == digest(BODY)
        assert client.post("/executions/probe", json={k: request[k] for k in scope()}).json()["quiescent"]
        assert client.post("/executions/request", json=request).json() == completed
    assert calls == [BODY]
    disk = b"".join(p.read_bytes() for p in root.iterdir())
    assert b"PRIVATE_CROP_AND_TEXT" not in disk and b"PRIVATE_REPLY" not in disk
    # Restart preserves terminal metadata and Redis response, never submits upstream again.
    with TestClient(create_app(root, cache, upstream, journal_identity=identity)) as client:
        assert client.post("/executions/request", json=request).json() == completed
    assert calls == [BODY]


def test_empty_seal_fences_prepared_but_not_sent_request(tmp_path):
    calls = []
    async def upstream(body):
        calls.append(body); return REPLY
    app = create_app(tmp_path / "journal", MemoryCache(), upstream, journal_identity=str(uuid4()), initialize=True)
    sc = scope()
    with TestClient(app) as client:
        assert not client.post("/executions/probe", json=sc).json()["quiescent"]
        sealed = client.post("/executions/seal", json=sc).json()
        assert sealed["sealed"] and sealed["quiescent"] and sealed["requests"] == []
        assert client.post("/executions/request", json={**sc, "request": BODY}).json()["status"] == "REJECTED"
    assert calls == []


@pytest.mark.parametrize("failure", ["timeout", "eof", "incomplete"])
def test_ambiguous_upstream_never_confirms_quiescence_or_retries(tmp_path, failure):
    calls = []
    async def upstream(body):
        calls.append(body)
        if failure == "timeout":
            raise TimeoutError()
        if failure == "eof":
            raise EOFError()
        return {"choices": [{"message": {"content": "partial"}, "finish_reason": None}]}
    app = create_app(tmp_path / "journal", MemoryCache(), upstream, journal_identity=str(uuid4()), initialize=True)
    sc = scope(); request = {**sc, "request": BODY}
    with TestClient(app) as client:
        assert poll(client, request, "UNKNOWN")["response"] is None
        sealed = client.post("/executions/seal", json=sc).json()
        assert sealed["sealed"] and not sealed["quiescent"]
        assert client.post("/executions/request", json=request).json()["status"] == "UNKNOWN"
    assert calls == [BODY]


def child_proxy(root, identity, sc, entered):
    async def upstream(body):
        entered.set()
        await asyncio.Event().wait()
    app = create_app(Path(root), MemoryCache(), upstream, journal_identity=identity)
    with TestClient(app) as client:
        client.post("/executions/request", json={**sc, "request": BODY})
        time.sleep(30)


def test_real_proxy_process_death_is_unknown_after_restart(tmp_path):
    root, identity, cache, sc = tmp_path / "journal", str(uuid4()), MemoryCache(), scope()
    ProxyJournal(root, cache, identity, initialize=True)
    ctx = multiprocessing.get_context("spawn"); entered = ctx.Event()
    process = ctx.Process(target=child_proxy, args=(str(root), identity, sc, entered))
    process.start()
    try:
        assert entered.wait(15)
        journal = ProxyJournal(root, cache, identity)
        assert journal.snapshot(Scope(**sc))["requests"][0]["status"] == "RUNNING"
    finally:
        process.kill(); process.join(10)
    assert not process.is_alive()
    async def forbidden(body):
        raise AssertionError("must not redispatch")
    with TestClient(create_app(root, cache, forbidden, journal_identity=identity)) as client:
        observed = client.post("/executions/seal", json=sc).json()
        assert observed["requests"][0]["status"] == "UNKNOWN" and not observed["quiescent"]
        assert client.post("/executions/request", json={**sc, "request": BODY}).json()["status"] == "UNKNOWN"


def test_missing_identity_or_scope_is_not_safe_empty_and_bootstrap_is_explicit(tmp_path):
    root, cache, identity, sc = tmp_path / "journal", MemoryCache(), str(uuid4()), scope()
    with pytest.raises(HTTPException):
        ProxyJournal(root, cache, identity)
    assert not root.exists()
    journal = ProxyJournal(root, cache, identity, initialize=True)
    with pytest.raises(FileExistsError):
        ProxyJournal(root, cache, identity, initialize=True)
    journal.snapshot(Scope(**sc), seal=True)
    (root / f"{journal.scope_key(Scope(**sc))}.json").unlink()
    with pytest.raises(HTTPException):
        journal.snapshot(Scope(**sc), seal=True)
    with pytest.raises(HTTPException):
        ProxyJournal(root, cache, str(uuid4()))
    shutil.rmtree(root)
    with pytest.raises(HTTPException):
        journal.snapshot(Scope(**sc), seal=True)
    assert not root.exists()


def test_namespace_epoch_stream_and_plaintext_cache_rejected(tmp_path):
    async def upstream(body):
        return REPLY
    with pytest.raises(ValueError):
        create_app(tmp_path / "x", FileCache(tmp_path / "plain"), upstream, journal_identity=str(uuid4()), initialize=True)
    app = create_app(tmp_path / "journal", MemoryCache(), upstream, journal_identity=str(uuid4()), initialize=True, namespace="test-session")
    with TestClient(app) as client:
        sc = scope()
        assert client.post("/executions/seal", json={**sc, "namespace": "other-session"}).status_code == 403
        assert client.post("/executions/seal", json={**sc, "epoch": True}).status_code == 422
        assert client.post("/executions/seal", json={**sc, "epoch": 11}).status_code == 422
        assert client.post("/executions/request", json={**sc, "request": {**BODY, "stream": True}}).status_code == 422


def test_response_cache_outage_does_not_repeat_upstream(tmp_path, monkeypatch):
    calls = []
    async def upstream(body):
        calls.append(body); return REPLY
    cache = MemoryCache()
    app = create_app(tmp_path / "journal", cache, upstream, journal_identity=str(uuid4()), initialize=True)
    request = {**scope(), "request": BODY}
    with TestClient(app) as client:
        completed = poll(client, request, "COMPLETED")
        healthy = cache.get
        def down(key):
            raise ConnectionError()
        monkeypatch.setattr(cache, "get", down)
        unavailable = client.post("/executions/request", json=request).json()
        assert unavailable["status"] == "UNKNOWN" and unavailable["reason"] == "response_unavailable"
        monkeypatch.setattr(cache, "get", healthy)
        assert client.post("/executions/request", json=request).json() == completed
    assert calls == [BODY]


def test_partial_completion_metadata_does_not_authorize_quiescence(tmp_path):
    import json
    root, cache, identity, sc = tmp_path / "journal", MemoryCache(), str(uuid4()), scope()
    journal = ProxyJournal(root, cache, identity, initialize=True)
    journal.snapshot(Scope(**sc), seal=True)
    path = root / f"{journal.scope_key(Scope(**sc))}.json"
    path.write_text(json.dumps({"sealed": True, "requests": {digest(BODY): {"status": "COMPLETED", "response_digest": None}}}))
    with pytest.raises(HTTPException):
        journal.snapshot(Scope(**sc))


def test_never_retains_unused_request_payload_and_health_checks_journal(tmp_path):
    written = []
    class RecordingCache(MemoryCache):
        def set(self, key, value):
            written.append((key, value))
            super().set(key, value)
    async def upstream(body):
        return REPLY
    root = tmp_path / "journal"
    app = create_app(root, RecordingCache(), upstream, journal_identity=str(uuid4()), initialize=True)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        poll(client, {**scope(), "request": BODY}, "COMPLETED")
        assert written and all(key.endswith("-response") for key, _ in written)
        assert all("PRIVATE_CROP_AND_TEXT" not in value for _, value in written)
        (root / "identity.json").unlink()
        assert client.get("/health").status_code == 503
