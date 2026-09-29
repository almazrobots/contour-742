"""Propagate durable attempt identity to every external VLM request, including CPU pools."""
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
import json
import os
import re
import time
import urllib.request
from uuid import UUID

from .pipeline_contract import digest

_SCOPE: ContextVar[dict | None] = ContextVar("pipeline_execution_scope", default=None)


@contextmanager
def execution_scope(job_id: str, epoch: int):
    if str(UUID(job_id)) != job_id or type(epoch) is not int or not 1 <= epoch <= 10:
        raise ValueError("invalid execution scope")
    token = _SCOPE.set({"job_id": job_id, "epoch": epoch})
    try:
        yield
    finally:
        _SCOPE.reset(token)


def scoped_submit(executor, fn, *args):
    # A fresh Context per task: the same Context cannot be entered concurrently.
    return executor.submit(copy_context().run, fn, *args)


def current_scope():
    scope = _SCOPE.get()
    return dict(scope) if scope else None


def _config():
    from .vlm import check_vlm_url
    url = check_vlm_url(os.environ.get("INSPECTOR_EXECUTION_PROXY_URL", ""))
    namespace = os.environ.get("INSPECTOR_EXECUTION_PROXY_NAMESPACE", "")
    identity = os.environ.get("INSPECTOR_EXECUTION_PROXY_IDENTITY", "")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", namespace) or not identity:
        raise RuntimeError("external execution proxy identity is not configured")
    return url, namespace, identity


def _post(url, payload, timeout):
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise RuntimeError("external execution response too large")
    return json.loads(raw)


def _check_scope(response, scope, identity):
    if not isinstance(response, dict) or any(response.get(key) != value for key, value in scope.items()) or response.get("journal_identity") != identity:
        raise RuntimeError("external execution response identity mismatch")


def generate_scoped(body: dict, timeout: float) -> str:
    local = current_scope()
    if local is None:
        raise RuntimeError("durable VLM call has no attempt identity")
    url, namespace, identity = _config()
    scope = {"namespace": namespace, **local}
    until = time.monotonic() + timeout
    expected = digest(body)
    while True:
        remaining = until - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("external execution still pending; no new request authorized")
        result = _post(url + "/executions/request", {**scope, "request": body}, min(remaining, 5))
        _check_scope(result, scope, identity)
        if result.get("request_digest") != expected:
            raise RuntimeError("external execution request digest mismatch")
        if result.get("status") == "COMPLETED":
            from .vlm_response import completed_text
            return completed_text(result.get("response"))
        if result.get("status") != "RUNNING":
            raise RuntimeError("external execution unavailable or sealed")
        time.sleep(min(0.1, max(0, until - time.monotonic())))


def seal_external(job_id: str, epoch: int) -> dict:
    url, namespace, identity = _config()
    scope = {"namespace": namespace, "job_id": job_id, "epoch": epoch}
    result = _post(url + "/executions/seal", scope, 3)
    _check_scope(result, scope, identity)
    requests = result.get("requests")
    if not isinstance(requests, list) or any(not isinstance(item, dict) or not re.fullmatch(r"[0-9a-f]{64}", item.get("request_digest", "")) for item in requests):
        raise RuntimeError("invalid external execution proof")
    safe = result.get("sealed") is True and result.get("quiescent") is True and all(item.get("status") == "COMPLETED" for item in requests)
    return {"job_id": job_id, "epoch": epoch, "quiescent": safe, "journal_identity": identity}
