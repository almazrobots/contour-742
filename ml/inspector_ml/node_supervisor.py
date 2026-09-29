"""T-239: sole admission parent, private ML child, durable reservations before IO.

The protected cache holds request/response bodies; the on-disk admission ledger
contains references only. A failed probe/seal never releases resources.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import Context
from dataclasses import asdict, replace
import base64
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .cache import make_cache
from .node_admission import NodeAdmission, NodeAdmissionError
from .pipeline_execution import ExecutionJournal, request_digest
from .resource_admission import JobRef, Resources, StopProof
from .resource_telemetry import ProcessIdentity, observe, process_identity

CONTROL = frozenset({"/health", "/pipeline/v1/artifacts/export", "/pipeline/v1/artifacts/restore",
                     "/pipeline/v1/executions/probe", "/pipeline/v1/executions/quiescence",
                     "/pipeline/v1/executions/cancel-unstarted"})
HEAVY = frozenset({"/analyze", "/parse/pages", "/parse/part", "/parse/assemble", "/advise",
                   "/norms/search", "/diff", "/measure", "/vlm/claim", "/render/pdf", "/render/docx",
                   "/pipeline/v1/preflight", "/pipeline/v1/parse", "/pipeline/v1/merge",
                   "/pipeline/v1/extract", "/pipeline/v1/aggregate", "/pipeline/v1/executions/start"})


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def policy(path):
    from .node_admission import _read
    value = _read(Path(path))
    keys = {"schema", "node_id", "policy_id", "journal_identity", "journal_dir", "worker_socket",
            "gpu_uuid", "capacity", "resident", "job_budget", "proc", "cgroup", "cgroup_root", "spool",
            "reader_processes", "queue_limit", "telemetry_ttl", "heartbeat_ttl"}
    if not isinstance(value, dict) or set(value) - {"reader_lifecycle"} != keys or value["schema"] != "node-supervisor.v1":
        raise ValueError("invalid node supervisor policy")
    if "reader_lifecycle" in value:
        helper = value["reader_lifecycle"]
        if (not isinstance(helper, dict) or set(helper) != {"socket", "policy_identity"}
                or not isinstance(helper["socket"], str) or not Path(helper["socket"]).is_absolute()
                or str(UUID(helper["policy_identity"])) != helper["policy_identity"]):
            raise ValueError("invalid Reader lifecycle policy")
    for key in ("capacity", "resident", "job_budget"):
        if set(value[key]) != {"cpu", "ram", "vram", "pixels", "spool", "tokens"}:
            raise ValueError("incomplete resource policy")
        value[key] = Resources(**value[key])
    if (value["resident"] + value["job_budget"]).exceeds(value["capacity"]):
        raise ValueError("job group does not fit policy")
    if min(value["job_budget"].pixels, value["job_budget"].tokens, value["job_budget"].ram) <= 0:
        raise ValueError("positive worker budgets required")
    value["reader_processes"] = tuple(ProcessIdentity(**p) for p in value["reader_processes"])
    return value


def open_admission(p, *, initialize=False):
    return NodeAdmission(Path(p["journal_dir"]), journal_identity=p["journal_identity"],
        node_id=p["node_id"], policy_id=p["policy_id"], capacity=p["capacity"], resident=p["resident"],
        queue_limit=p["queue_limit"], telemetry_ttl=p["telemetry_ttl"], heartbeat_ttl=p["heartbeat_ttl"],
        initialize=initialize)


def parent_death(expected_parent):
    # Executed in child before exec: check the race between fork and prctl.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL) != 0:
        os._exit(126)
    if os.getppid() != expected_parent:
        os._exit(125)


def host_pid(local_pid, proc):
    namespace = os.readlink(f"/proc/{local_pid}/ns/pid")
    for directory in Path(proc).iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if os.readlink(directory / "ns/pid") != namespace:
                continue
            for line in (directory / "status").read_text().splitlines():
                if line.startswith("NSpid:") and int(line.split()[-1]) == local_pid:
                    return int(directory.name)
        except (OSError, ValueError):
            continue
    raise RuntimeError("worker host identity unavailable")


class Supervisor:
    def __init__(self, p, admission, cache, *, observation=observe):
        self.p, self.admission, self.cache, self.observation = p, admission, cache, observation
        self.child = None
        self.worker_identity = None
        self.capability = secrets.token_hex(32)
        self.client = None
        self.pending = {}
        self.tasks = set()
        self.closed = False
        self.error = None
        self.reader_container = None
        self.worker_oom_events = None
        self.last_decision = None
        self.gpu_observation = None
        # Code is part of the executable configuration. A docs-only deploy must
        # not reopen a configuration quarantined by OOM.
        revision = hashlib.sha256()
        for source in sorted(Path(__file__).parent.glob("*.py")):
            revision.update(source.name.encode())
            revision.update(source.read_bytes())
        self.config_id = (p["policy_id"] + ":" + revision.hexdigest()[:16]
                          if os.environ.get("INSPECTOR_NODE_POLICY") else p["policy_id"])

    def status(self):
        reservations = self.admission.snapshot()
        return {"queued": len(self.admission.queued()), "reserved": len(reservations),
                "unknown": sum(r.state == "UNKNOWN" for r in reservations),
                "worker_running": bool(self.child and self.child.poll() is None),
                "configuration_blocked": self.admission.configuration_blocked(self.config_id),
                "error": self.error, "decision": self.last_decision}

    async def reader_action(self, operation):
        helper = self.p["reader_lifecycle"]
        started = time.monotonic()
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=helper["socket"]),
                                     base_url="http://reader-lifecycle", timeout=60) as client:
            response = await client.post("/" + operation, json={"policy_identity": helper["policy_identity"]})
            response.raise_for_status()
            value = response.json()
        if (value["policy_identity"] != helper["policy_identity"] or value["gpu_uuid"] != self.p["gpu_uuid"]
                or any(type(value[k]) is not bool for k in ("running", "ready", "stopped", "oom_killed"))
                or not isinstance(value["container_id"], str) or len(value["container_id"]) != 64
                or (self.reader_container and value["container_id"] != self.reader_container)):
            raise RuntimeError("Reader lifecycle identity unavailable")
        processes = tuple(ProcessIdentity(**p) for p in value["processes"])
        gpu = tuple(ProcessIdentity(**p) for p in value["gpu_processes"])
        if (not set(gpu).issubset(processes) or (value["stopped"] and (value["running"] or processes or gpu))
                or (value["ready"] and (not value["running"] or not gpu))):
            raise RuntimeError("Reader lifecycle state inconsistent")
        self.reader_container = value["container_id"]
        gpu_observation = value["gpu_observation"]
        if (gpu_observation["gpu_uuid"] != self.p["gpu_uuid"]
                or type(gpu_observation["observed_at"]) not in (int, float)
                or not math.isfinite(gpu_observation["observed_at"])
                or not 0 <= gpu_observation["observed_at"] <= time.monotonic()
                or any(type(gpu_observation[k]) is not int or gpu_observation[k] < 0
                       or gpu_observation[k] % (1024 * 1024) for k in ("total_bytes", "used_bytes"))
                or gpu_observation["used_bytes"] > gpu_observation["total_bytes"]):
            raise RuntimeError("host GPU observation malformed")
        gpu_observation = dict(gpu_observation, observed_at=min(started, gpu_observation["observed_at"]))
        gpu_observation["processes"] = tuple(ProcessIdentity(**p) for p in gpu_observation["processes"])
        self.gpu_observation = gpu_observation
        if value["oom_killed"]:
            self.admission.block_configuration(self.config_id)
        return value, processes

    async def reader_safe(self):
        if self.p.get("reader_lifecycle"):
            await self.reader_action("probe")

    async def refresh_heartbeats(self):
        # A live parent task says nothing about a stopped or frozen child.
        healthy = False
        if self.client and self.child and self.child.poll() is None:
            try:
                response = await asyncio.wait_for(self.client.get("/health", headers={
                    "x-node-capability": self.capability}), timeout=min(1.0, self.p["heartbeat_ttl"] / 3))
                healthy = response.status_code == 200
            except (TimeoutError, httpx.TransportError):
                pass
        now = time.monotonic()
        self.admission.expire(now=now)
        if healthy:
            for reservation in self.admission.snapshot():
                self.admission.heartbeat(reservation.job.job_id, reservation.token, now=now)

    async def ensure_reader(self):
        if not self.p.get("reader_lifecycle"):
            return True
        # Never replace pinned identities or start a model while prior work is UNKNOWN.
        if self.admission.snapshot():
            return False
        value, processes = await self.reader_action("probe")
        if self.admission.configuration_blocked(self.config_id):
            return False
        if value["stopped"]:
            # With Reader stopped, all observed GPU processes still require known ownership.
            previous = self.p["reader_processes"]
            self.p["reader_processes"] = ()
            try:
                telemetry = self.telemetry()
            finally:
                self.p["reader_processes"] = previous
            if not telemetry.gpu_safe or (self.p["resident"] + telemetry.external).exceeds(self.p["capacity"]):
                return False
            value, processes = await self.reader_action("start")
            if self.admission.configuration_blocked(self.config_id):
                return False
        if not value["ready"]:
            return False
        # Validate host identities before atomically adopting the helper's new set.
        for identity in processes:
            if process_identity(identity.pid, Path(self.p["proc"])) != identity:
                raise RuntimeError("Reader process changed during lifecycle observation")
        self.p["reader_processes"] = processes
        return True

    def key(self, job_id):
        return "node-supervisor-v1-" + self.p["journal_identity"] + "-" + job_id

    def record(self, job_id):
        raw = self.cache.get(self.key(job_id))
        if raw is None:
            raise RuntimeError("protected request record unavailable")
        record = json.loads(raw)
        if record["job_ref"] != job_id:
            raise RuntimeError("request reference mismatch")
        return record

    def save(self, record):
        raw = encoded(record)
        self.cache.set(self.key(record["job_ref"]), raw)
        if self.cache.get(self.key(record["job_ref"])) != raw:
            raise RuntimeError("protected request write not retained")

    def telemetry(self):
        p = self.p
        allowed = set(p["reader_processes"])
        for identity in allowed:
            if process_identity(identity.pid, Path(p["proc"])) != identity:
                raise RuntimeError("resident Reader identity changed")
        if self.worker_identity:
            allowed.add(self.worker_identity)
        cgroup = self.cgroup()
        options = {}
        sampled = None
        if p.get("reader_lifecycle"):
            snapshot = self.gpu_observation
            if snapshot is None or not 0 <= time.monotonic() - snapshot["observed_at"] <= p["telemetry_ttl"]:
                raise RuntimeError("host GPU observation stale or unavailable")
            for identity in snapshot["processes"]:
                if process_identity(identity.pid, Path(p["proc"])) != identity:
                    raise RuntimeError("host GPU process identity changed")
            def host_smi(arguments):
                if arguments == ["--query-gpu=uuid,memory.total,memory.used"]:
                    return f'{snapshot["gpu_uuid"]},{snapshot["total_bytes"] // (1024 * 1024)},{snapshot["used_bytes"] // (1024 * 1024)}\n'
                if arguments == ["--query-compute-apps=gpu_uuid,pid"]:
                    return "".join(f'{snapshot["gpu_uuid"]},{identity.pid}\n' for identity in snapshot["processes"])
                raise RuntimeError("unsupported host GPU query")
            options["smi"] = host_smi
            sampled = snapshot["observed_at"]
        result = self.observation(gpu_uuid=p["gpu_uuid"], capacity=p["capacity"], resident=p["resident"],
            allowed_gpu_processes=frozenset(allowed), spool=Path(p["spool"]), cgroup=Path(cgroup),
            proc=Path(p["proc"]), cgroup_root=Path(p["cgroup_root"]), **options).telemetry
        return replace(result, observed_at=sampled) if sampled is not None else result

    def cgroup(self):
        p = self.p
        cgroup = p["cgroup"]
        if cgroup == "self":
            pid = host_pid(os.getpid(), p["proc"])
            line = next(s for s in (Path(p["proc"]) / str(pid) / "cgroup").read_text().splitlines() if s.startswith("0::"))
            cgroup = str(Path(p["cgroup_root"]) / line[3:].lstrip("/"))
        return Path(cgroup)

    def oom_events(self):
        # A dedicated host parent survives Docker child cgroup recreation. Its
        # hierarchical counters retain OOM evidence across supervisor SIGKILL.
        # Missing/changed parent still fails closed in had_oom.
        parent = os.environ.get("INSPECTOR_NODE_OOM_CGROUP")
        directory = Path(parent) if parent else self.cgroup()
        stat = directory.stat()
        values = dict(line.split() for line in (directory / "memory.events").read_text().splitlines())
        counters = [int(values[k]) for k in ("oom", "oom_kill")]
        if min(counters) < 0:
            raise RuntimeError("invalid cgroup OOM counters")
        return {"identity": [stat.st_dev, stat.st_ino], "counters": counters}

    def had_oom(self, record):
        stopped = record.get("worker_stop_evidence")
        if stopped and stopped.get("identity") == record.get("worker_identity") and type(stopped.get("oom")) is bool:
            return stopped["oom"]
        before = record.get("oom_events")
        if before is None:
            return False  # Existing records predate runtime OOM accounting.
        after = self.oom_events()
        if before["identity"] != after["identity"] or any(a < b for a, b in zip(after["counters"], before["counters"])):
            # Lost counters cannot prove no OOM. Quarantine this configuration,
            # but only release after independent local-stop AND external seal.
            return True
        return after["counters"] != before["counters"]

    async def start_worker(self):
        # Recovered UNKNOWN must be settled before loading another model process.
        if self.admission.snapshot():
            return
        if self.admission.configuration_blocked(self.config_id):
            return
        if not await self.ensure_reader():
            return
        telemetry = self.telemetry()
        if not telemetry.gpu_safe or (self.p["resident"] + telemetry.external).exceeds(self.p["capacity"]):
            return
        socket = Path(self.p["worker_socket"])
        socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if socket.exists():
            socket.unlink()
        env = dict(os.environ, INSPECTOR_NODE_CAPABILITY=self.capability,
                   INSPECTOR_OCR_WORKERS="1", INSPECTOR_RENDER_PROCS="0")
        parent = os.getpid()
        self.worker_oom_events = self.oom_events()
        self.child = subprocess.Popen([sys.executable, "-m", "uvicorn", "inspector_ml.node_supervisor:build_worker",
            "--factory", "--uds", str(socket), "--workers", "1", "--log-level", "warning"], env=env,
            preexec_fn=lambda: parent_death(parent), start_new_session=True)
        self.worker_identity = process_identity(host_pid(self.child.pid, self.p["proc"]), Path(self.p["proc"]))
        self.client = httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(socket)),
                                       base_url="http://private-worker", timeout=600)
        for _ in range(600):
            if self.child.poll() is not None:
                raise RuntimeError("private worker exited during startup")
            try:
                response = await self.client.get("/health", headers={"x-node-capability": self.capability})
                if response.status_code == 200:
                    return
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.1)
        raise RuntimeError("private worker startup timed out")

    async def forward(self, path, raw, *, record=None, method="POST"):
        if not self.client or not self.child or self.child.poll() is not None:
            raise RuntimeError("private worker unavailable")
        headers = {"content-type": "application/json", "x-node-capability": self.capability}
        if record:
            headers.update({"x-node-job": record["scope_job"], "x-node-epoch": str(record["scope_epoch"]),
                "x-node-budget": base64.b64encode(encoded(asdict(self.p["job_budget"])).encode()).decode()})
        response = await self.client.request(method, path, content=raw, headers=headers)
        return {"status": response.status_code, "content_type": response.headers.get("content-type", "application/json"),
                "body": base64.b64encode(response.content).decode()}

    async def seal(self, record):
        from .execution_scope import seal_external
        proof = await asyncio.to_thread(seal_external, record["scope_job"], record["scope_epoch"])
        return proof.get("quiescent") is True

    async def control_execution(self, path, raw):
        """Probe/cancel remain available even when UNKNOWN prevents child launch."""
        from .pipeline import PreflightRequest, StepRequest
        request = json.loads(raw)
        job, epoch = str(UUID(request["job_id"])), request["epoch"]
        if type(epoch) is not int or not 1 <= epoch <= 10:
            raise ValueError("invalid execution epoch")
        ref = f"{job}:{epoch}"
        queued = any(j.job_id == ref for j in self.admission.queued())
        if queued:
            record = self.record(ref)
            if json.loads(record["raw"]) != request:
                raise ValueError("execution request identity mismatch")
        body = (PreflightRequest if request["stage"] == "preflight" else StepRequest).model_validate(request["body"])
        envelope = {"stage": request["stage"], "body": body.model_dump(mode="json")}
        identity = os.environ.get("INSPECTOR_EXECUTION_PROXY_IDENTITY")
        if identity:
            envelope["external_execution"] = {"journal_identity": identity,
                "namespace": os.environ.get("INSPECTOR_EXECUTION_PROXY_NAMESPACE")}
        digest = request_digest(envelope)
        journal = ExecutionJournal(Path(os.environ["INSPECTOR_PIPELINE_EXECUTIONS_DIR"]), self.cache,
            journal_identity=os.environ["INSPECTOR_PIPELINE_JOURNAL_IDENTITY"])
        if path.endswith("cancel-unstarted"):
            snapshot = journal.cancel_unstarted(job, epoch, digest)
            if snapshot.status == "CANCELLED":
                self.admission.cancel_queued(ref)
                future = self.pending.pop(ref, None)
                if future and not future.done():
                    future.set_result({"status": 200, "content_type": "application/json",
                        "body": base64.b64encode(encoded(snapshot.to_dict()).encode()).decode()})
            return snapshot.to_dict()
        if queued and path.endswith("probe"):
            return {"job_id": job, "epoch": epoch, "status": "RUNNING", "request_digest": digest,
                    "reply": None, "reason": None, "requires_remote_quiescence": True}
        snapshot = journal.probe(job, epoch, digest)
        if path.endswith("quiescence"):
            if snapshot.status not in {"FAILED", "INTERRUPTED"} or snapshot.reason == "result_unavailable":
                return {"job_id": job, "epoch": epoch, "quiescent": False, "journal_identity": None}
            from .execution_scope import seal_external
            return await asyncio.to_thread(seal_external, job, epoch)
        return snapshot.to_dict()

    async def execute(self, reservation):
        try:
            record = self.record(reservation.job.job_id)
            record["worker_identity"] = asdict(self.worker_identity)
            record["oom_events"] = self.oom_events()
            self.save(record)  # Before the first byte can reach the worker.
            reply = await self.forward(record["path"], record["raw"].encode(), record=record)
            record["reply"] = reply
            terminal = True
            if record["durable"]:
                value = json.loads(base64.b64decode(reply["body"]))
                terminal = value.get("status") in {"DONE", "FAILED", "INTERRUPTED", "CANCELLED"}
            record["local_complete"] = terminal
            self.save(record)
            await self.reader_safe()
            if terminal and await self.seal(record):
                self.admission.release(record["job_ref"], StopProof(reservation.token, True, True), oom=self.had_oom(record))
            future = self.pending.pop(record["job_ref"], None)
            if future and not future.done():
                future.set_result(reply)
        except Exception as exc:
            self.error = type(exc).__name__
            # Request timeout is not proof of worker termination. Reconciler owns recovery.
        finally:
            self.tasks.discard(asyncio.current_task())

    async def recover(self, reservation):
        record = self.record(reservation.job.job_id)
        await self.reader_safe()
        local_complete = record.get("local_complete") is True
        if not local_complete and record.get("durable"):
            journal = ExecutionJournal(Path(os.environ["INSPECTOR_PIPELINE_EXECUTIONS_DIR"]), self.cache,
                journal_identity=os.environ["INSPECTOR_PIPELINE_JOURNAL_IDENTITY"])
            snapshot = journal.probe(record["scope_job"], record["scope_epoch"])
            if snapshot.status == "ABSENT":
                # The protected dispatch write may have failed before forwarding
                # (e.g. Redis noeviction). Seal the original epoch against a late
                # request; absence alone is never evidence that it cannot start.
                stopped = await self.control_execution("/pipeline/v1/executions/cancel-unstarted", record["raw"].encode())
                if stopped["status"] == "CANCELLED":
                    local_complete = True
                    record["reply"] = {"status": 200, "content_type": "application/json",
                        "body": base64.b64encode(encoded(stopped).encode()).decode()}
            local_complete = local_complete or snapshot.status in {"DONE", "FAILED", "INTERRUPTED", "CANCELLED"}
            if snapshot.status == "DONE":
                record["reply"] = {"status": 200, "content_type": "application/json",
                    "body": base64.b64encode(encoded(snapshot.to_dict()).encode()).decode()}
                self.save(record)
        if not local_complete and record.get("worker_identity"):
            old = ProcessIdentity(**record["worker_identity"])
            try:
                local_complete = process_identity(old.pid, Path(self.p["proc"])) != old
            except FileNotFoundError:
                local_complete = True
        if local_complete and await self.seal(record):
            self.admission.release(record["job_ref"], StopProof(reservation.token, True, True), oom=self.had_oom(record))
            future = self.pending.pop(record["job_ref"], None)
            if future and not future.done():
                if record.get("reply"):
                    future.set_result(record["reply"])
                else:
                    future.set_exception(RuntimeError("execution interrupted; reconcile original attempt"))

    async def loop(self):
        while not self.closed:
            try:
                if self.child and self.child.poll() is not None and not self.tasks:
                    if self.had_oom({"oom_events": self.worker_oom_events}):
                        self.admission.block_configuration(self.config_id)
                    if self.client:
                        await self.client.aclose()
                    self.client, self.child, self.worker_identity = None, None, None
                if self.tasks:
                    await self.refresh_heartbeats()
                else:
                    for reservation in self.admission.snapshot():
                        await self.recover(reservation)
                if not self.child:
                    await self.start_worker()
                if self.client and not self.tasks:
                    if not await self.ensure_reader():
                        await asyncio.sleep(0.25)
                        continue
                    decision = self.admission.reserve_next(self.telemetry(), now=time.monotonic())
                    self.last_decision = {"action": decision.action, "reason": decision.reason}
                    if decision.action == "admit":
                        task = asyncio.create_task(self.execute(decision.reservation))
                        self.tasks.add(task)
                self.error = None
            except Exception as exc:
                self.error = type(exc).__name__
            await asyncio.sleep(0.25)

    async def submit(self, path, raw):
        body = json.loads(raw)
        durable = path == "/pipeline/v1/executions/start"
        scope_job = str(UUID(body["job_id"])) if durable else str(uuid4())
        epoch = body["epoch"] if durable else 1
        if type(epoch) is not int or not 1 <= epoch <= 10:
            raise ValueError("invalid execution epoch")
        ref = f"{scope_job}:{epoch}"
        existing = self.cache.get(self.key(ref))
        if existing:
            record = json.loads(existing)
            if record["raw"] != raw or record["path"] != path:
                raise ValueError("execution request identity conflict")
            if record.get("reply"):
                return record["reply"]
        else:
            if any(r.job.job_id == ref for r in self.admission.snapshot()) or any(j.job_id == ref for j in self.admission.queued()):
                raise RuntimeError("existing reservation lost its protected request")
            record = {"job_ref": ref, "scope_job": scope_job, "scope_epoch": epoch,
                      "raw": raw, "path": path, "durable": durable, "local_complete": False}
        decision = self.admission.enqueue(JobRef(ref, self.config_id, self.p["job_budget"],
            priority="interactive" if path in {"/advise", "/measure", "/diff", "/vlm/claim"} else "batch"))
        if decision.action == "reject":
            return {"status": 429, "content_type": "application/json",
                    "body": base64.b64encode(encoded({"detail": decision.reason}).encode()).decode()}
        if not existing:
            try:
                self.save(record)
            except Exception:
                # No await/dispatch has occurred since enqueue; no worker can own it.
                self.admission.cancel_queued(ref)
                raise
        future = self.pending.setdefault(ref, asyncio.get_running_loop().create_future())
        return await asyncio.shield(future)

    async def close(self):
        self.closed = True
        if self.child and self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGKILL)
            await asyncio.to_thread(self.child.wait)
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.child and self.child.poll() is not None and self.worker_identity:
            for reservation in self.admission.snapshot():
                record = self.record(reservation.job.job_id)
                if record.get("worker_identity") == asdict(self.worker_identity):
                    record["worker_stop_evidence"] = {
                        "identity": asdict(self.worker_identity), "oom": self.had_oom(record)}
                    self.save(record)
        if self.client:
            await self.client.aclose()
        # Stop local work, but leave reservations durable until external proof.
        self.admission.close()


def create_app(supervisor):
    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(supervisor.loop())
        try:
            yield
        finally:
            supervisor.closed = True
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await supervisor.close()

    app = FastAPI(lifespan=lifespan)

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def request(path: str, request: Request):
        path = "/" + path
        if path not in CONTROL | HEAVY:
            return JSONResponse({"detail": "route not admitted by node policy"}, status_code=404)
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > (16 * 1024 * 1024 if path in CONTROL else 1024 * 1024):
                return JSONResponse({"detail": "request exceeds bounded spool"}, status_code=413)
        try:
            if path in CONTROL:
                if path == "/health":
                    status = supervisor.status()
                    try:
                        reply = await asyncio.wait_for(supervisor.forward(path, bytes(raw), method=request.method), timeout=2)
                        body = json.loads(base64.b64decode(reply["body"]))
                        body["node_admission"] = status
                        return JSONResponse(body, status_code=reply["status"])
                    except Exception:
                        return JSONResponse({"status": "unavailable", "node_admission": status}, status_code=503)
                if path.startswith("/pipeline/v1/executions/"):
                    return JSONResponse(await supervisor.control_execution(path, bytes(raw)))
                reply = await supervisor.forward(path, bytes(raw), method=request.method)
            else:
                if request.method != "POST":
                    return JSONResponse({"detail": "POST required"}, status_code=405)
                reply = await supervisor.submit(path, raw.decode())
            return Response(base64.b64decode(reply["body"]), status_code=reply["status"], media_type=reply["content_type"])
        except ValueError:
            return JSONResponse({"detail": "invalid execution request"}, status_code=422)
        except Exception:
            return JSONResponse({"detail": "node admission or worker unavailable"}, status_code=503)

    return app


def build_worker():
    """Private ASGI capability boundary; no standalone public worker socket."""
    from .app import app
    from .execution_scope import execution_scope
    from .resource_scope import supervised_resources
    capability = os.environ["INSPECTOR_NODE_CAPABILITY"]

    async def request(scope, receive, send):
        headers = dict(scope["headers"])
        if not secrets.compare_digest(headers.get(b"x-node-capability", b""), capability.encode()):
            return await JSONResponse({"detail": "private worker"}, status_code=403)(scope, receive, send)
        if scope["path"] in CONTROL:
            return await app(scope, receive, send)
        try:
            job = headers[b"x-node-job"].decode()
            epoch = int(headers[b"x-node-epoch"])
            budget = Resources(**json.loads(base64.b64decode(headers[b"x-node-budget"], validate=True)))
            with execution_scope(job, epoch), supervised_resources(budget):
                return await app(scope, receive, send)
        except (ValueError, KeyError):
            return await JSONResponse({"detail": "missing or invalid reservation"}, status_code=403)(scope, receive, send)

    async def guarded(scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        # h11 may spawn a pipelined request from response completion while the
        # previous handler's scope is still active. Each trusted ASGI entry gets
        # its own context; nested scopes *within* that request still fail closed.
        return await asyncio.create_task(request(scope, receive, send), context=Context())
    return guarded


def build_from_env():
    p = policy(os.environ["INSPECTOR_NODE_POLICY"])
    cache = make_cache("gpu", Path("/unused"))
    return create_app(Supervisor(p, open_admission(p), cache))


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "provision":
        raise SystemExit("usage: python -m inspector_ml.node_supervisor provision POLICY.json")
    p = policy(sys.argv[2])
    with open_admission(p, initialize=True):
        pass


if __name__ == "__main__":
    main()
