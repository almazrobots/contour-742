"""Real loopback HTTP contract, with a delayed synthetic Reader and no GPU."""
import asyncio
from contextlib import contextmanager
import socket
import sys
from threading import Event, Thread
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
import pytest
import uvicorn

from inspector_ml import execution_scope as S
from inspector_ml.execution_proxy import ProxyJournal, build_from_env
from tests.test_pipeline_execution import MemoryCache


@contextmanager
def serving(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    thread = Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started, "loopback server did not start"
        yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        server.should_exit = True
        thread.join(5)
        sock.close()
        assert not thread.is_alive(), "loopback server did not stop"


def test_client_timeout_does_not_duplicate_reader_over_real_http(tmp_path, monkeypatch):
    # Only response storage is in-memory; client, proxy, production upstream
    # adapter and Reader communicate through actual HTTP sockets.
    from inspector_ml import cache as cache_module
    cache = MemoryCache()
    monkeypatch.setitem(sys.modules, "redis", SimpleNamespace(Redis=SimpleNamespace(from_url=lambda *a, **kw: None)))
    monkeypatch.setattr(cache_module, "RedisCache", lambda connection: cache)
    identity, job = str(uuid4()), str(uuid4())
    root = tmp_path / "journal"
    ProxyJournal(root, cache, identity, initialize=True)
    for key, value in {
        "INSPECTOR_EXECUTION_PROXY_ROOT": str(root),
        "INSPECTOR_EXECUTION_PROXY_IDENTITY": identity,
        "INSPECTOR_EXECUTION_PROXY_NAMESPACE": "network-contract",
        "INSPECTOR_REDIS_URL": "redis://127.0.0.1:1",
    }.items():
        monkeypatch.setenv(key, value)
    reader = FastAPI()
    entered, release = Event(), Event()
    calls = []

    @reader.post("/v1/chat/completions")
    async def complete(body: dict):
        calls.append(body)
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "synthetic result"}}]}

    with serving(reader) as upstream:
        monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_UPSTREAM", upstream + "/v1/chat/completions")
        with serving(build_from_env()) as proxy:
            monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_URL", proxy)
            body = {"model": "synthetic", "messages": [{"role": "user", "content": "synthetic crop"}]}
            scope = {"namespace": "network-contract", "job_id": job, "epoch": 1}
            try:
                with S.execution_scope(job, 1), pytest.raises(TimeoutError):
                    S.generate_scoped(body, 0.3)
                assert entered.wait(2)
                assert calls == [body]
                assert not S.seal_external(job, 1)["quiescent"]
                release.set()
                with S.execution_scope(job, 1):
                    assert S.generate_scoped(body, 3) == "synthetic result"
                    assert S.generate_scoped(body, 3) == "synthetic result"
                assert S.seal_external(job, 1)["quiescent"]
                proof = S._post(proxy + "/executions/probe", scope, 2)
                assert proof["sealed"] and proof["quiescent"]
                assert calls == [body]
            finally:
                release.set()
