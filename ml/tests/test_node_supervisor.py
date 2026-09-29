"""Admission-to-dispatch contract; synthetic requests and protected fake cache."""
import asyncio
from dataclasses import asdict
import json
from uuid import uuid4

import pytest

from inspector_ml.node_supervisor import Supervisor, open_admission, encoded
from inspector_ml.resource_admission import Resources, Telemetry


class Cache:
    def __init__(self):
        self.values = {}
    def get(self, key):
        return self.values.get(key)
    def set(self, key, value):
        self.values[key] = value


def test_dispatch_cache_full_seals_unstarted_epoch_before_releasing(tmp_path, monkeypatch):
    from inspector_ml import node_supervisor as module
    from inspector_ml.pipeline import PreflightRequest
    from inspector_ml.pipeline_execution import ExecutionJournal, request_digest
    from inspector_ml.resource_telemetry import ProcessIdentity
    import base64
    async def run():
        s = setup(tmp_path)
        s.worker_identity = ProcessIdentity(1, 1, str(uuid4()))
        journal = ExecutionJournal(tmp_path/'executions', s.cache)
        monkeypatch.setenv('INSPECTOR_PIPELINE_EXECUTIONS_DIR', str(journal.root))
        monkeypatch.setenv('INSPECTOR_PIPELINE_JOURNAL_IDENTITY', str(uuid4()))
        monkeypatch.delenv('INSPECTOR_EXECUTION_PROXY_IDENTITY', raising=False)
        monkeypatch.setattr(module, 'ExecutionJournal', lambda *args, **kwargs: journal)
        job = str(uuid4())
        body = {'run_id':str(uuid4()),'request':{'sha256':'a'*64,'params':[]}}
        raw = encoded({'job_id':job,'epoch':1,'stage':'preflight','body':body})
        waiter = asyncio.create_task(s.submit('/pipeline/v1/executions/start', raw))
        await asyncio.sleep(0)
        reservation = s.admission.reserve_next(Telemetry(1, Resources()), now=1).reservation
        def full(*args): raise RuntimeError('cache full')
        monkeypatch.setattr(s.cache, 'set', full)
        async def forbidden(*args, **kwargs): raise AssertionError('dispatch must not happen')
        s.forward = forbidden
        sealed = []
        async def seal(record):
            sealed.append(journal.probe(job,1).status)
            return True
        s.seal = seal
        await s.execute(reservation)
        assert not waiter.done() and len(s.admission.snapshot())==1
        await s.recover(reservation)
        reply = json.loads(base64.b64decode((await waiter)['body']))
        assert reply['status']=='CANCELLED' and sealed==['CANCELLED']
        assert not s.admission.snapshot()
        envelope={'stage':'preflight','body':PreflightRequest.model_validate(body).model_dump(mode='json')}
        assert journal.probe(job,1,request_digest(envelope)).status=='CANCELLED'
        assert journal.execute(job,1,envelope,lambda: pytest.fail('late replay')).status=='CANCELLED'
        s.admission.close()
    asyncio.run(run())


def setup(tmp_path, *, heartbeat_ttl=30, queue_limit=4):
    p = dict(journal_dir=str(tmp_path / "admission"), journal_identity=str(uuid4()),
        node_id="node", policy_id="policy", capacity=Resources(cpu=4000, ram=1000, vram=1000,pixels=1000,tokens=1000),
        resident=Resources(ram=100,vram=100),job_budget=Resources(cpu=1000,ram=100,vram=100,pixels=100,tokens=100),
        queue_limit=queue_limit,telemetry_ttl=5,heartbeat_ttl=heartbeat_ttl,proc="/proc")
    admission = open_admission(p, initialize=True)
    supervisor = Supervisor(p, admission, Cache())
    supervisor.oom_events = lambda: {"identity": [1, 1], "counters": [0, 0]}
    return supervisor


def test_http_interactive_backlog_bounded_queue_and_batch_progress(tmp_path):
    async def run():
        import httpx
        from inspector_ml.node_supervisor import create_app
        from inspector_ml.resource_telemetry import ProcessIdentity
        s = setup(tmp_path, queue_limit=6)
        s.worker_identity = ProcessIdentity(1, 1, str(uuid4()))
        dispatched = []
        async def forward(path, raw, **kwargs):
            assert len(s.admission.snapshot()) == 1
            dispatched.append(json.loads(raw)['label'])
            return {'status': 200, 'content_type': 'application/json', 'body': 'e30='}
        async def seal(record):
            return True
        s.forward, s.seal = forward, seal
        tasks = []
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(s)), base_url='http://test') as client:
                for label, path in [('b1', '/parse/pages'), ('b2', '/parse/pages'),
                                    ('i1', '/advise'), ('i2', '/measure'),
                                    ('i3', '/diff'), ('i4', '/vlm/claim')]:
                    tasks.append(asyncio.create_task(client.post(path, json={'label': label})))
                    for _ in range(100):
                        if len(s.admission.queued()) == len(tasks):
                            break
                        await asyncio.sleep(0)
                    assert len(s.admission.queued()) == len(tasks)
                refused = await client.post('/measure', json={'label': 'overflow'})
                assert refused.status_code == 429 and refused.json()['detail'] == 'queue_full'
                assert not dispatched
                for _ in range(6):
                    reservation = s.admission.reserve_next(Telemetry(1, Resources()), now=1).reservation
                    assert reservation
                    await s.execute(reservation)
                    assert not s.admission.snapshot()
                responses = await asyncio.gather(*tasks)
                assert all(r.status_code == 200 for r in responses)
                assert dispatched == ['i1', 'i2', 'i3', 'b1', 'i4', 'b2']
                assert not s.admission.queued()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            s.admission.close()
    asyncio.run(run())


def test_http_boundary_rejects_unlisted_methods_and_oversize_before_admission(tmp_path):
    async def run():
        import httpx
        from inspector_ml.node_supervisor import create_app
        s = setup(tmp_path)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(s)), base_url='http://test') as client:
                assert (await client.post('/unlisted-gpu-route', json={})).status_code == 404
                assert (await client.get('/analyze')).status_code == 405
                assert (await client.post('/analyze', content=b'x'*(1024*1024+1))).status_code == 413
                assert not s.admission.queued()
                assert not s.admission.snapshot()
                assert not s.cache.values
        finally:
            s.admission.close()
    asyncio.run(run())


def test_private_worker_rejects_missing_capability_before_handler(monkeypatch):
    async def run():
        import httpx
        from inspector_ml import app as app_module
        from inspector_ml.node_supervisor import build_worker
        called = []
        async def forbidden(scope, receive, send):
            called.append(scope['path'])
            raise AssertionError('Untrusted request reached worker')
        monkeypatch.setattr(app_module, 'app', forbidden)
        monkeypatch.setenv('INSPECTOR_NODE_CAPABILITY', 'private-capability')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=build_worker()), base_url='http://test') as client:
            for path in ('/health', '/analyze', '/pipeline/v1/executions/start'):
                assert (await client.post(path, json={})).status_code == 403
            assert (await client.post('/analyze', json={}, headers={'x-node-capability': 'private-capability'})).status_code == 403
        assert not called
    asyncio.run(run())


def test_reservation_committed_before_dispatch_and_release_requires_seal(tmp_path):
    async def run():
        s = setup(tmp_path)
        s.worker_identity = type("Identity", (), {})()  # replaced with proper dataclass below
        from inspector_ml.resource_telemetry import ProcessIdentity
        s.worker_identity = ProcessIdentity(1, 1, str(uuid4()))
        seen = []
        async def forward(path, raw, **kwargs):
            assert len(s.admission.snapshot()) == 1
            record = s.record(s.admission.snapshot()[0].job.job_id)
            assert record["worker_identity"] == asdict(s.worker_identity)
            seen.append(path)
            return {"status": 200, "content_type": "application/json", "body": "e30="}
        async def seal(record):
            return False
        s.forward, s.seal = forward, seal
        waiter = asyncio.create_task(s.submit("/measure", "{}"))
        await asyncio.sleep(0)
        decision = s.admission.reserve_next(Telemetry(1, Resources()), now=1)
        await s.execute(decision.reservation)
        assert (await waiter)["status"] == 200
        assert seen == ["/measure"]
        assert len(s.admission.snapshot()) == 1  # HTTP completion cannot release an unsealed Reader.
        async def sealed(record):
            return True
        s.seal = sealed
        await s.recover(s.admission.snapshot()[0])
        assert not s.admission.snapshot()
        s.admission.close()
    asyncio.run(run())


def test_client_timeout_does_not_cancel_existing_queue_or_duplicate_dispatch(tmp_path):
    async def run():
        s = setup(tmp_path)
        raw = encoded({"job_id": str(uuid4()), "epoch": 1, "stage": "parse", "body": {}})
        first = asyncio.create_task(s.submit("/pipeline/v1/executions/start", raw))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        second = asyncio.create_task(s.submit("/pipeline/v1/executions/start", raw))
        await asyncio.sleep(0)
        assert len(s.admission.queued()) == 1
        assert len(s.pending) == 1
        second.cancel()
        await asyncio.gather(second, return_exceptions=True)
        s.admission.close()
    asyncio.run(run())


def test_missing_protected_request_never_rebinds_existing_job(tmp_path):
    async def run():
        s = setup(tmp_path)
        raw = encoded({"job_id": str(uuid4()), "epoch": 1, "stage": "parse", "body": {}})
        waiter = asyncio.create_task(s.submit("/pipeline/v1/executions/start", raw))
        await asyncio.sleep(0)
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        s.cache.values.clear()
        with pytest.raises(RuntimeError, match="lost its protected request"):
            await s.submit("/pipeline/v1/executions/start", raw)
        assert len(s.admission.queued()) == 1
        s.admission.close()
    asyncio.run(run())


def test_worker_scope_stays_open_until_actual_asgi_handler_finishes(monkeypatch):
    import sys
    import types
    from inspector_ml.node_supervisor import build_worker
    from inspector_ml.resource_scope import require_render_pixels
    from inspector_ml.execution_scope import current_scope
    import base64
    seen = []
    async def app(scope, receive, send):
        require_render_pixels(2, 2, 1)
        await asyncio.sleep(0)
        require_render_pixels(2, 2, 1)
        assert current_scope()["job_id"] == job
        seen.append("finished")
    monkeypatch.setitem(sys.modules, "inspector_ml.app", types.SimpleNamespace(app=app))
    monkeypatch.setenv("INSPECTOR_NODE_CAPABILITY", "private")
    job = str(uuid4())
    headers = [(b"x-node-capability", b"private"), (b"x-node-job", job.encode()),
        (b"x-node-epoch", b"1"), (b"x-node-budget", base64.b64encode(encoded(asdict(Resources(pixels=4))).encode()))]
    async def run():
        await build_worker()({"type":"http","path":"/pipeline/v1/executions/start","headers":headers}, None, None)
        assert current_scope() is None
    asyncio.run(run())
    assert seen == ["finished"]


def test_queued_accessor_restores_references_without_payloads(tmp_path):
    s = setup(tmp_path)
    from inspector_ml.resource_admission import JobRef
    s.admission.enqueue(JobRef("ref", "policy", s.p["job_budget"]))
    s.admission.close()
    reopened = open_admission(s.p)
    assert reopened.queued()[0].job_id == "ref"
    assert not hasattr(reopened.queued()[0], "body")
    reopened.close()


def test_reader_unknown_reservation_prevents_probe_start_and_identity_refresh(tmp_path):
    async def run():
        s = setup(tmp_path)
        from inspector_ml.resource_admission import JobRef
        s.p.update(reader_lifecycle={"socket": "/private/reader.sock", "policy_identity": str(uuid4())},
                   reader_processes=())
        s.admission.enqueue(JobRef("ref", "policy", s.p["job_budget"]))
        s.admission.reserve_next(Telemetry(1, Resources()), now=1)
        s.admission.close()
        s.admission = open_admission(s.p)  # restored reservation is UNKNOWN
        async def forbidden(operation):
            pytest.fail("UNKNOWN must not contact the lifecycle actuator")
        s.reader_action = forbidden
        assert await s.ensure_reader() is False
        assert s.p["reader_processes"] == ()
        assert len(s.admission.snapshot()) == 1
        s.admission.close()
    asyncio.run(run())


@pytest.mark.parametrize("stopped,ready,expected", [(True, False, ["probe", "start"]),
                                                  (False, False, ["probe"]), (False, True, ["probe"])])
def test_reader_start_requires_confirmed_stopped(tmp_path, monkeypatch, stopped, ready, expected):
    async def run():
        s = setup(tmp_path)
        from inspector_ml.resource_telemetry import ProcessIdentity
        identity = ProcessIdentity(12, 123, str(uuid4()))
        s.p.update(reader_lifecycle={"socket": "/private/reader.sock", "policy_identity": str(uuid4())},
                   reader_processes=())
        actions = []
        async def action(operation):
            actions.append(operation)
            return ({"stopped": stopped if operation == "probe" else False,
                     "ready": ready if operation == "probe" else True}, (identity,))
        s.reader_action = action
        s.telemetry = lambda: Telemetry(1, Resources())
        monkeypatch.setattr("inspector_ml.node_supervisor.process_identity", lambda *args: identity)
        assert await s.ensure_reader() is (stopped or ready)
        assert actions == expected
        assert s.p["reader_processes"] == ((identity,) if stopped or ready else ())
        s.admission.close()
    asyncio.run(run())


def test_reader_failed_probe_retains_pinned_identity(tmp_path):
    async def run():
        s = setup(tmp_path)
        s.p.update(reader_lifecycle={"socket": "/private/reader.sock", "policy_identity": str(uuid4())},
                   reader_processes=("pinned",))
        async def unavailable(operation):
            raise RuntimeError("UNKNOWN")
        s.reader_action = unavailable
        with pytest.raises(RuntimeError, match="UNKNOWN"):
            await s.ensure_reader()
        assert s.p["reader_processes"] == ("pinned",)
        s.admission.close()
    asyncio.run(run())


def test_runtime_oom_quarantines_configuration_after_sealed_recovery(tmp_path):
    async def run():
        s = setup(tmp_path)
        from inspector_ml.resource_admission import JobRef
        job = JobRef("ref", "policy", s.p["job_budget"])
        s.admission.enqueue(job)
        reservation = s.admission.reserve_next(Telemetry(1, Resources()), now=1).reservation
        s.save({"job_ref": "ref", "local_complete": True, "scope_job": str(uuid4()), "scope_epoch": 1,
                "oom_events": {"identity": [1, 1], "counters": [0, 0]}})
        s.oom_events = lambda: {"identity": [1, 1], "counters": [1, 1]}
        async def sealed(record):
            return True
        s.seal = sealed
        await s.recover(reservation)
        assert not s.admission.snapshot()
        assert s.admission.enqueue(job).reason == "oom_configuration"
        s.admission.close()
        s.admission = open_admission(s.p)
        assert s.admission.configuration_blocked("policy")
        await s.start_worker()  # Must return before probing or loading models.
        assert s.child is None
        s.admission.close()
    asyncio.run(run())


def test_missing_oom_evidence_conservatively_quarantines_configuration(tmp_path):
    s = setup(tmp_path)
    s.oom_events = lambda: {"identity": [1, 2], "counters": [0, 0]}
    assert s.had_oom({"oom_events": {"identity": [1, 1], "counters": [0, 0]}})
    s.admission.close()


def test_host_parent_preserves_oom_evidence_across_child_recreation(tmp_path, monkeypatch):
    s = setup(tmp_path)
    del s.oom_events  # Exercise the real filesystem reader, not setup's stub.
    parent = tmp_path / "host-parent"
    parent.mkdir()
    events = parent / "memory.events"
    events.write_text("oom 0\noom_kill 0\n")
    monkeypatch.setenv("INSPECTOR_NODE_OOM_CGROUP", str(parent))
    before = s.oom_events()
    s.cgroup = lambda: tmp_path / "removed-container-cgroup"
    assert not s.had_oom({"oom_events": before})
    events.write_text("oom 1\noom_kill 1\n")
    assert s.had_oom({"oom_events": before})
    s.admission.close()


def test_persisted_shutdown_oom_evidence_survives_cgroup_recreation(tmp_path):
    s = setup(tmp_path)
    identity = {"pid": 123, "start_ticks": 45, "boot_id": str(uuid4())}
    s.oom_events = lambda: {"identity": [2, 2], "counters": [0, 0]}
    record = {"worker_identity": identity, "oom_events": {"identity": [1, 1], "counters": [0, 0]},
              "worker_stop_evidence": {"identity": identity, "oom": False}}
    assert not s.had_oom(record)
    record["worker_stop_evidence"]["identity"] = dict(identity, pid=124)
    assert s.had_oom(record)
    s.admission.close()


def test_reader_admission_checks_current_code_configuration(tmp_path):
    async def run():
        s = setup(tmp_path)
        s.p['reader_lifecycle'] = {'socket': '/unused', 'policy_identity': str(uuid4())}
        s.admission.block_configuration('policy')
        s.config_id = 'policy:corrected-code'
        async def probe(operation):
            return {'stopped': False, 'ready': True}, ()
        s.reader_action = probe
        assert await s.ensure_reader()
        s.admission.block_configuration(s.config_id)
        assert not await s.ensure_reader()
        s.admission.close()
    asyncio.run(run())


def test_foreign_cancel_body_cannot_remove_queued_execution(tmp_path):
    async def run():
        s = setup(tmp_path)
        request = {"job_id": str(uuid4()), "epoch": 1, "stage": "preflight", "body": {"original": True}}
        waiter = asyncio.create_task(s.submit("/pipeline/v1/executions/start", encoded(request)))
        await asyncio.sleep(0)
        foreign = dict(request, body={"original": False})
        with pytest.raises(ValueError, match="identity mismatch"):
            await s.control_execution("/pipeline/v1/executions/cancel-unstarted", encoded(foreign))
        assert len(s.admission.queued()) == 1
        assert not waiter.done()
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        s.admission.close()
    asyncio.run(run())


def test_frozen_live_child_expires_heartbeat_without_release_or_replacement(tmp_path):
    import subprocess
    import sys
    import signal
    import time
    import httpx
    from inspector_ml.resource_admission import JobRef
    async def run():
        s = setup(tmp_path, heartbeat_ttl=0.15)
        socket = str(tmp_path / "worker.sock")
        program = """
import socket, sys
server = socket.socket(socket.AF_UNIX)
server.bind(sys.argv[1]); server.listen()
while True:
    client, _ = server.accept()
    client.recv(8192)
    client.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}')
    client.close()
"""
        s.child = subprocess.Popen([sys.executable, "-c", program, socket])
        s.client = httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=socket), base_url="http://worker")
        try:
            for _ in range(100):
                if (tmp_path / "worker.sock").exists():
                    break
                await asyncio.sleep(0.01)
            s.admission.enqueue(JobRef("ref", "policy", s.p["job_budget"]))
            s.admission.reserve_next(Telemetry(time.monotonic(), Resources()), now=time.monotonic())
            await s.refresh_heartbeats()
            assert s.admission.snapshot()[0].state != "UNKNOWN"
            s.child.send_signal(signal.SIGSTOP)
            await asyncio.sleep(0.16)
            await s.refresh_heartbeats()
            assert s.child.poll() is None  # alive but cannot answer health
            assert s.admission.snapshot()[0].state == "UNKNOWN"
            original = s.child.pid
            await s.start_worker()
            assert s.child.pid == original
            s.child.send_signal(signal.SIGCONT)
            await s.refresh_heartbeats()
            assert s.admission.snapshot()[0].state == "UNKNOWN"  # health cannot clear UNKNOWN
        finally:
            s.child.kill()
            s.child.wait()
            await s.client.aclose()
            s.admission.close()
    asyncio.run(run())


def test_reader_oom_response_quarantines_without_start(tmp_path, monkeypatch):
    import httpx
    import time
    async def run():
        s = setup(tmp_path)
        policy_id = str(uuid4())
        s.p.update(reader_lifecycle={"socket": "/private/reader.sock", "policy_identity": policy_id},
                   gpu_uuid="GPU-pinned", reader_processes=())
        value = {"policy_identity": policy_id, "gpu_uuid": "GPU-pinned", "container_id": "a" * 64,
                 "running": False, "ready": False, "stopped": True, "processes": [], "gpu_processes": [],
                 "oom_killed": True, "gpu_observation": {"gpu_uuid": "GPU-pinned", "total_bytes": 1024 * 1024,
                    "used_bytes": 0, "observed_at": time.monotonic(), "processes": []}}
        paths = []
        def handler(request):
            paths.append(request.url.path)
            return httpx.Response(200, json=value)
        monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(handler))
        assert await s.ensure_reader() is False
        assert paths == ["/probe"]
        assert s.admission.configuration_blocked("policy")
        s.admission.close()
        s.admission = open_admission(s.p)
        assert s.admission.configuration_blocked("policy")
        s.admission.close()
    asyncio.run(run())


def test_health_reports_bounded_admission_state_without_request_payload(tmp_path):
    import httpx
    from inspector_ml.node_supervisor import create_app
    from inspector_ml.resource_admission import JobRef
    async def run():
        s = setup(tmp_path)
        s.admission.enqueue(JobRef("private-job-ref", "policy", s.p["job_budget"]))
        s.error = "TelemetryUnavailable"
        s.last_decision = {"action": "wait", "reason": "capacity"}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(s)), base_url="http://parent") as client:
            response = await client.get("/health")
        assert response.status_code == 503
        status = response.json()["node_admission"]
        assert status["queued"] == 1
        assert status["error"] == "TelemetryUnavailable"
        assert status["decision"] == {"action": "wait", "reason": "capacity"}
        assert "private-job-ref" not in response.text
        s.admission.close()
    asyncio.run(run())


def test_helper_gpu_telemetry_uses_host_pids_and_original_timestamp(tmp_path, monkeypatch):
    import time
    from types import SimpleNamespace
    from inspector_ml.resource_telemetry import ProcessIdentity
    s = setup(tmp_path)
    host_identity = ProcessIdentity(2358808, 17, str(uuid4()))
    sampled = time.monotonic() - 1
    s.p.update(reader_lifecycle={"socket": "/private/reader.sock", "policy_identity": str(uuid4())},
               gpu_uuid="GPU-pinned", reader_processes=(), cgroup="/cgroup", cgroup_root="/cgroup", spool="/spool")
    s.worker_identity = host_identity
    s.gpu_observation = {"gpu_uuid": "GPU-pinned", "total_bytes": 1024 * 1024 * 100,
                         "used_bytes": 1024 * 1024, "observed_at": sampled, "processes": (host_identity,)}
    monkeypatch.setattr("inspector_ml.node_supervisor.process_identity", lambda pid, proc: host_identity)
    def observation(**kwargs):
        assert kwargs["smi"](["--query-compute-apps=gpu_uuid,pid"]) == "GPU-pinned,2358808\n"
        assert kwargs["smi"](["--query-gpu=uuid,memory.total,memory.used"]) == "GPU-pinned,100,1\n"
        assert kwargs["allowed_gpu_processes"] == frozenset({host_identity})
        return SimpleNamespace(telemetry=Telemetry(time.monotonic(), Resources()))
    s.observation = observation
    assert s.telemetry().observed_at == sampled
    s.gpu_observation["observed_at"] = time.monotonic() - 6
    with pytest.raises(RuntimeError, match="stale"):
        s.telemetry()
    s.gpu_observation["observed_at"] = time.monotonic()
    monkeypatch.setattr("inspector_ml.node_supervisor.process_identity", lambda pid, proc: ProcessIdentity(pid, 18, host_identity.boot_id))
    with pytest.raises(RuntimeError, match="identity changed"):
        s.telemetry()
    s.admission.close()


def test_real_http_worker_keeps_consecutive_and_pipelined_scopes_independent(tmp_path):
    import subprocess
    import sys
    import httpx
    import base64
    program = """
import asyncio, os, sys, types, uvicorn
from inspector_ml.resource_scope import is_supervised, require_render_pixels, supervised_resources, ResourceBudgetExceeded
from inspector_ml.resource_admission import Resources
from inspector_ml.node_supervisor import build_worker
from inspector_ml.execution_scope import current_scope
async def app(scope, receive, send):
    assert is_supervised()
    require_render_pixels(2, 2, 1)
    identity = current_scope()
    try:
        with supervised_resources(Resources(pixels=4)):
            raise AssertionError('nested guard bypassed')
    except ResourceBudgetExceeded:
        pass
    body = identity['job_id'].encode()
    await send({'type':'http.response.start','status':200,'headers':[(b'content-length',str(len(body)).encode())]})
    await send({'type':'http.response.body','body':body})
    await asyncio.sleep(0.03)
    assert current_scope() == identity
    require_render_pixels(2, 2, 1)
sys.modules['inspector_ml.app'] = types.SimpleNamespace(app=app)
os.environ['INSPECTOR_NODE_CAPABILITY'] = 'private'
uvicorn.run(build_worker(), uds=sys.argv[1], lifespan='off', log_level='warning', http='h11')
"""
    async def run():
        socket = str(tmp_path / "contract.sock")
        log = (tmp_path / "worker.log").open("w+")
        child = subprocess.Popen([sys.executable, "-c", program, socket], stdout=log, stderr=log)
        budget = base64.b64encode(encoded(asdict(Resources(pixels=4))).encode()).decode()
        def headers(job):
            return {"x-node-capability": "private", "x-node-job": job, "x-node-epoch": "1", "x-node-budget": budget}
        try:
            for _ in range(200):
                if (tmp_path / "contract.sock").exists():
                    break
                assert child.poll() is None
                await asyncio.sleep(0.01)
            async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=socket), base_url="http://worker") as client:
                for _ in range(3):
                    job = str(uuid4())
                    response = await client.post("/measure", headers=headers(job), content="{}")
                    assert response.status_code == 200, response.text
                    assert response.text == job
            reader, writer = await asyncio.open_unix_connection(socket)
            jobs = [str(uuid4()), str(uuid4())]
            for job in jobs:
                raw = "POST /measure HTTP/1.1\r\nHost: worker\r\nContent-Length: 0\r\n"
                raw += "".join(f"{key}: {value}\r\n" for key, value in headers(job).items()) + "\r\n"
                writer.write(raw.encode())
            await writer.drain()
            for job in jobs:
                response_headers = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=3)
                assert response_headers.startswith(b"HTTP/1.1 200"), response_headers
                assert (await asyncio.wait_for(reader.readexactly(36), timeout=3)).decode() == job
            writer.close()
            await writer.wait_closed()
        finally:
            child.terminate()
            child.wait(timeout=5)
            log.seek(0)
            output = log.read()
            log.close()
            assert "Traceback" not in output, output
    asyncio.run(run())
