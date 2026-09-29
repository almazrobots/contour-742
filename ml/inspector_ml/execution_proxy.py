"""Attempt-scoped external execution fence (T-238), not a resource scheduler.

Bootstrap with initialize=True exactly once, explicitly, before dispatching any
attempt. Normal startup MUST use initialize=False and the pinned journal identity.
Lost storage never becomes an empty safe journal. Do not replace its mount while
workers live. Every proxy worker must share this directory and protected Redis.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from .cache import Cache, FileCache
from .pipeline_contract import digest


class Scope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    namespace: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    job_id: str
    epoch: StrictInt = Field(ge=1, le=10)

    @field_validator("job_id")
    @classmethod
    def canonical_uuid(cls, value):
        if str(UUID(value)) != value:
            raise ValueError("canonical UUID required")
        return value


class Request(Scope):
    request: dict


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def atomic(path: Path, value):
    tmp = path.with_name(f".{path.name}.{uuid4()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            stream.write(encoded(value)); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


class ProxyJournal:
    def __init__(self, root: Path, cache: Cache, identity: str, initialize=False):
        if isinstance(cache, FileCache):
            raise ValueError("proxy payloads require protected Redis")
        if str(UUID(identity)) != identity:
            raise ValueError("journal identity must be canonical UUID")
        self.root, self.cache, self.identity = Path(root), cache, identity
        if initialize:
            # Exclusive mkdir distinguishes explicit provisioning from reopening a journal.
            self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
            atomic(self.root / "identity.json", {"identity": identity, "schema": "execution-proxy.v1"})
        self.ready()

    def ready(self):
        try:
            actual = json.loads((self.root / "identity.json").read_text())
            if actual != {"identity": self.identity, "schema": "execution-proxy.v1"}:
                raise ValueError("identity mismatch")
        except (OSError, ValueError) as error:
            raise HTTPException(503, "execution proxy journal identity unavailable") from error

    def scope_key(self, scope: Scope):
        return digest(scope.model_dump(include={"namespace", "job_id", "epoch"}))

    @contextmanager
    def locked(self, key):
        self.ready()
        path = self.root / f"{key}.lock"
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
            fresh = True
        except FileExistsError:
            fd = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            fresh = False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.ready()
            if fresh and (self.root / f"{key}.json").exists():
                raise HTTPException(503, "execution proxy scope lock lost")
            if fresh:
                # A persistent lock inode marks an observed scope. Missing state later
                # is corruption, never a newly empty attempt.
                self.save(key, {"sealed": False, "requests": {}})
            elif not (self.root / f"{key}.json").exists():
                raise HTTPException(503, "execution proxy scope journal lost")
            yield
        finally:
            os.close(fd)

    def read(self, key):
        path = self.root / f"{key}.json"
        try:
            state = json.loads(path.read_text())
        except FileNotFoundError as error:
            raise HTTPException(503, "execution proxy scope journal lost") from error
        except (OSError, ValueError) as error:
            raise HTTPException(503, "execution proxy metadata corrupt") from error
        if (not isinstance(state, dict) or set(state) != {"sealed", "requests"} or
                type(state["sealed"]) is not bool or not isinstance(state["requests"], dict)):
            raise HTTPException(503, "execution proxy metadata corrupt")
        for ref, item in state["requests"].items():
            if (not isinstance(ref, str) or len(ref) != 64 or any(c not in "0123456789abcdef" for c in ref) or
                    not isinstance(item, dict) or set(item) != {"status", "response_digest"} or
                    item["status"] not in {"RUNNING", "COMPLETED", "UNKNOWN"}):
                raise HTTPException(503, "execution proxy metadata corrupt")
            checksum = item["response_digest"]
            if item["status"] == "COMPLETED":
                if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
                    raise HTTPException(503, "execution proxy completion metadata corrupt")
            elif checksum is not None:
                raise HTTPException(503, "execution proxy completion metadata corrupt")
        return state

    def save(self, key, state):
        self.ready()
        atomic(self.root / f"{key}.json", state)

    def reference(self, key, request_digest, kind):
        return f"execution-proxy-v1-{self.identity}-{key}-{request_digest}-{kind}"

    def base(self, scope):
        return {**scope.model_dump(include={"namespace", "job_id", "epoch"}), "journal_identity": self.identity}

    def owner_fd(self, key, ref):
        fd = os.open(self.root / f"{key}-{ref}.owner", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            os.close(fd)
            return None

    def reconcile(self, key, state):
        changed = False
        for ref, item in state["requests"].items():
            if item["status"] == "RUNNING":
                fd = self.owner_fd(key, ref)
                if fd is not None:
                    os.close(fd)
                    item["status"] = "UNKNOWN"
                    changed = True
        if changed:
            self.save(key, state)

    def snapshot(self, scope, *, seal=False):
        key = self.scope_key(scope)
        with self.locked(key):
            state = self.read(key)
            if seal and not state["sealed"]:
                state["sealed"] = True
                self.save(key, state)
            self.reconcile(key, state)
            return {**self.base(scope), "sealed": state["sealed"],
                    "quiescent": state["sealed"] and all(r["status"] == "COMPLETED" for r in state["requests"].values()),
                    "requests": [{"request_digest": ref, "status": item["status"]} for ref, item in sorted(state["requests"].items())]}


def complete_response(value):
    if not isinstance(value, dict) or not isinstance(value.get("choices"), list) or not value["choices"]:
        return False
    return all(isinstance(c, dict) and c.get("finish_reason") in {"stop", "length", "content_filter", "tool_calls"}
               and isinstance(c.get("message"), dict) for c in value["choices"])


def create_app(root: Path, cache: Cache, upstream: Callable[[dict], Awaitable[dict]], *,
               journal_identity: str, initialize: bool = False, namespace: str | None = None) -> FastAPI:
    journal = ProxyJournal(root, cache, journal_identity, initialize)
    app = FastAPI()
    tasks: set[asyncio.Task] = set()
    app.state.journal = journal
    app.state.tasks = tasks

    async def dispatch(scope, key, ref, request, owner):
        response_digest = None
        status = "UNKNOWN"
        try:
            response = await upstream(request)
            if complete_response(response):
                raw = encoded(response)
                result_key = journal.reference(key, ref, "response")
                cache.set(result_key, raw)
                if cache.get(result_key) != raw:
                    raise RuntimeError("response cache unavailable")
                response_digest = hashlib.sha256(raw.encode()).hexdigest()
                status = "COMPLETED"
        except BaseException:
            # Cancellation, timeout, EOF and failed HTTP responses never prove stop.
            status = "UNKNOWN"
        finally:
            try:
                with journal.locked(key):
                    state = journal.read(key)
                    if ref not in state["requests"]:
                        raise HTTPException(503, "execution proxy request journal lost")
                    state["requests"][ref] = {"status": status, "response_digest": response_digest}
                    journal.save(key, state)
            finally:
                os.close(owner)

    def authorized(scope):
        if namespace is not None and scope.namespace != namespace:
            raise HTTPException(403, "execution proxy namespace is not authorized")

    @app.get("/health")
    async def health():
        journal.ready()
        try:
            cache.get(f"execution-proxy-health-{journal.identity}")
        except Exception as exc:
            raise HTTPException(503, "execution proxy cache unavailable") from exc
        return {"status": "ok", "journal_identity": journal.identity}

    @app.post("/executions/request")
    async def request(body: Request):
        scope = Scope.model_validate(body.model_dump(exclude={"request"}))
        authorized(scope)
        if body.request.get("stream"):
            raise HTTPException(422, "execution proxy requires a complete non-streaming response")
        key, ref = journal.scope_key(scope), digest(body.request)
        with journal.locked(key):
            state = journal.read(key)
            journal.reconcile(key, state)
            item = state["requests"].get(ref)
            if item is None:
                if state["sealed"]:
                    return {**journal.base(scope), "status": "REJECTED", "request_digest": ref, "response": None, "reason": "attempt_sealed"}
                raw = encoded(body.request)
                if len(raw.encode()) > 32 * 1024 * 1024:
                    raise HTTPException(413, "execution proxy request too large")
                # Dispatch consumes this body from memory. Persisting the unused base64
                # payload would fill the bounded Redis cache without aiding recovery.
                owner = journal.owner_fd(key, ref)
                if owner is None:
                    raise HTTPException(503, "execution proxy owner state unavailable")
                try:
                    item = {"status": "RUNNING", "response_digest": None}
                    state["requests"][ref] = item
                    journal.save(key, state)
                    task = asyncio.create_task(dispatch(scope, key, ref, body.request, owner))
                    tasks.add(task)
                    def finished(task):
                        tasks.discard(task)
                        if not task.cancelled():
                            task.exception()  # retrieve failures without logging document payloads
                    task.add_done_callback(finished)
                except BaseException:
                    os.close(owner)
                    raise
            response, reason = None, None
            if item["status"] == "COMPLETED":
                try:
                    raw = cache.get(journal.reference(key, ref, "response"))
                    if raw is None or hashlib.sha256(raw.encode()).hexdigest() != item["response_digest"]:
                        raise ValueError("response missing or corrupt")
                    response = json.loads(raw)
                except Exception:
                    # Execution did complete, but no success response can be returned now.
                    return {**journal.base(scope), "status": "UNKNOWN", "request_digest": ref, "response": None, "reason": "response_unavailable"}
            return {**journal.base(scope), "status": item["status"], "request_digest": ref, "response": response, "reason": reason}

    @app.post("/executions/seal")
    async def seal(scope: Scope):
        authorized(scope)
        return journal.snapshot(scope, seal=True)

    @app.post("/executions/probe")
    async def probe(scope: Scope):
        authorized(scope)
        return journal.snapshot(scope)

    return app


def build_from_env() -> FastAPI:
    """uvicorn inspector_ml.execution_proxy:build_from_env --factory --host 127.0.0.1 --port 47813"""
    import urllib.request
    from .cache import RedisCache
    import redis
    from .vlm import check_vlm_url

    root = Path(os.environ["INSPECTOR_EXECUTION_PROXY_ROOT"])
    identity = os.environ["INSPECTOR_EXECUTION_PROXY_IDENTITY"]
    namespace = os.environ["INSPECTOR_EXECUTION_PROXY_NAMESPACE"]
    Scope(namespace=namespace, job_id=str(uuid4()), epoch=1)
    url = check_vlm_url(os.environ.get("INSPECTOR_EXECUTION_PROXY_UPSTREAM", "http://127.0.0.1:8000/v1/chat/completions"))
    cache = RedisCache(redis.Redis.from_url(os.environ["INSPECTOR_REDIS_URL"], socket_timeout=10, socket_connect_timeout=10))

    def generate(request):
        req = urllib.request.Request(url, data=encoded(request).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as response:  # trusted loopback/HTTPS configuration
            if response.status != 200:
                raise RuntimeError("upstream did not confirm completion")
            length = response.headers.get("content-length")
            raw = response.read(32 * 1024 * 1024 + 1)
            if length is not None and len(raw) != int(length):
                raise RuntimeError("upstream response incomplete")
            if len(raw) > 32 * 1024 * 1024:
                raise RuntimeError("upstream response too large")
            return json.loads(raw)

    async def upstream(request):
        return await asyncio.to_thread(generate, request)

    return create_app(root, cache, upstream, journal_identity=identity, namespace=namespace)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initialize", action="store_true", required=True,
                        help="Explicit one-time provisioning. Never use on normal startup or after storage loss.")
    parser.parse_args()
    # No payload is processed and no Redis connection is needed during explicit provisioning.
    class BootstrapCache:
        def get(self, key):
            raise RuntimeError("bootstrap only")
        def set(self, key, value):
            raise RuntimeError("bootstrap only")
    ProxyJournal(Path(os.environ["INSPECTOR_EXECUTION_PROXY_ROOT"]), BootstrapCache(),
                 os.environ["INSPECTOR_EXECUTION_PROXY_IDENTITY"], initialize=True)


if __name__ == "__main__":
    main()
