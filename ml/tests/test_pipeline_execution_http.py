"""T-238: real HTTP execution envelopes, replay and delayed-request fencing.

Synthetic PDF from the existing service fixture; the parser runs locally on the
remote test runner. No GPU model is required by this contract test.
"""
import copy
from uuid import uuid4

import pytest

from tests.test_parse_parts_http import service
from tests.test_pipeline_execution import MemoryCache

PREFIX = "/pipeline/v1/executions/"


@pytest.fixture
def execution_service(service, tmp_path, monkeypatch):
    client, module, _, path, sha = service
    cache = MemoryCache()
    journal_dir = tmp_path / "execution-journal"
    monkeypatch.setattr(module, "CACHE", cache)
    monkeypatch.setenv("INSPECTOR_PIPELINE_EXECUTIONS_DIR", str(journal_dir))
    return client, module, cache, path, sha, journal_dir


def preflight(sha):
    return {"job_id": str(uuid4()), "epoch": 1, "stage": "preflight",
            "body": {"run_id": str(uuid4()), "request": {"sha256": sha, "params": []}}}


def post(client, action, body, status=200):
    response = client.post(PREFIX + action, json=body)
    assert response.status_code == status, response.text
    return response.json()


def no_execution(*args, **kwargs):
    raise AssertionError("duplicate HTTP request entered pipeline execution")


def test_http_preflight_parse_replay_and_probe_never_reenter_parser(execution_service, monkeypatch):
    from inspector_ml import pipeline
    client, module, _, _, sha, _ = execution_service
    request = preflight(sha)
    planned = post(client, "start", request)
    assert planned["status"] == "DONE" and planned["reply"]["regions"]
    assert planned["job_id"] == request["job_id"] and planned["epoch"] == 1
    assert not planned["requires_remote_quiescence"]
    assert post(client, "start", request) == planned
    assert post(client, "probe", request) == planned
    plan = planned["reply"]
    parse = {"job_id": str(uuid4()), "epoch": 1, "stage": "parse", "body": {
        "context": plan["context"], "plan": plan["artifact"], "region_id": plan["regions"][0]["id"]}}
    calls = []
    original = pipeline.parse_pdf_part

    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(pipeline, "parse_pdf_part", counted)
    parsed = post(client, "start", parse)
    assert parsed["status"] == "DONE", parsed
    assert parsed["reply"]["receipt"]["stage"] == "parse"
    assert calls == [1]
    # The whole callable is fenced, not merely a parse-cache hit inside it.
    monkeypatch.setattr(pipeline.Pipeline, "execute", no_execution)
    assert post(client, "start", parse) == parsed
    assert post(client, "probe", parse) == parsed
    assert calls == [1]
    # JSON defaults normalize identically for all three HTTP operations.
    explicit = {**parse, "body": module.StepRequest.model_validate(parse["body"]).model_dump(mode="json")}
    assert post(client, "start", explicit) == parsed
    assert post(client, "probe", explicit) == parsed
    assert post(client, "cancel-unstarted", explicit) == parsed


def test_http_absent_is_not_cancelled_but_tombstone_rejects_late_post(execution_service, monkeypatch):
    from inspector_ml import pipeline
    client, module, _, _, sha, _ = execution_service
    request = preflight(sha)
    absent = post(client, "probe", request)
    assert absent["status"] == "ABSENT" and absent["reply"] is None
    assert absent["request_digest"] is None
    sealed = post(client, "cancel-unstarted", request)
    assert sealed["status"] == "CANCELLED" and sealed["reason"] == "sealed_unstarted"
    assert sealed["request_digest"] and not sealed["requires_remote_quiescence"]
    monkeypatch.setattr(pipeline.Pipeline, "preflight", no_execution)
    normalized = {**request, "body": module.PreflightRequest.model_validate(request["body"]).model_dump(mode="json")}
    assert post(client, "start", normalized) == sealed
    assert post(client, "probe", request) == sealed
    assert post(client, "cancel-unstarted", request) == sealed


@pytest.mark.parametrize("action", ["start", "probe", "cancel-unstarted"])
def test_http_foreign_request_cannot_rebind_job_epoch(execution_service, action):
    client, _, _, _, sha, _ = execution_service
    request = preflight(sha)
    completed = post(client, "start", request)
    assert completed["status"] == "DONE"
    foreign = copy.deepcopy(request)
    foreign["body"]["run_id"] = str(uuid4())
    error = post(client, action, foreign, 409)
    assert "different request digest" in error["detail"]
    assert post(client, "probe", request) == completed


@pytest.mark.parametrize("action", ["start", "probe", "cancel-unstarted"])
def test_http_execution_disabled_is_explicit_503(execution_service, monkeypatch, action):
    client, _, _, _, sha, _ = execution_service
    monkeypatch.delenv("INSPECTOR_PIPELINE_EXECUTIONS_DIR")
    error = post(client, action, preflight(sha), 503)
    assert "not configured" in error["detail"]


@pytest.mark.parametrize("damage", ["boolean_epoch", "zero_epoch", "large_epoch", "uuid", "stage", "body", "source"])
def test_http_invalid_execution_envelope_rejected_before_journal(execution_service, damage):
    client, _, _, _, sha, journal_dir = execution_service
    request = preflight(sha)
    if damage == "boolean_epoch":
        request["epoch"] = True
    elif damage == "zero_epoch":
        request["epoch"] = 0
    elif damage == "large_epoch":
        request["epoch"] = 11
    elif damage == "uuid":
        request["job_id"] = "-" * 36  # passes shallow regex, must fail canonical UUID check
    elif damage == "stage":
        request["stage"] = "unrecognized"
    elif damage == "body":
        request["body"] = {}
    else:
        request["body"]["request"]["sha256"] = "../../document"
    post(client, "start", request, 422)
    assert not journal_dir.exists() or not list(journal_dir.iterdir())


@pytest.mark.l4_fault
def test_http_transient_redis_outage_recovers_same_reply_without_reexecution(execution_service, monkeypatch):
    from inspector_ml import pipeline
    client, _, cache, _, sha, journal_dir = execution_service
    request = preflight(sha)
    completed = post(client, "start", request)
    assert completed["status"] == "DONE"
    metadata = journal_dir / f"{request['job_id']}.1.json"
    committed = metadata.read_bytes()
    healthy_get = cache.get

    def unavailable(key):
        raise ConnectionError("synthetic Redis unavailable")

    monkeypatch.setattr(cache, "get", unavailable)
    monkeypatch.setattr(pipeline.Pipeline, "preflight", no_execution)
    for action in ["probe", "start"]:
        observed = post(client, action, request)
        assert observed["status"] == "FAILED" and observed["reason"] == "result_unavailable"
        assert observed["reply"] is None and observed["requires_remote_quiescence"]
        assert metadata.read_bytes() == committed
    monkeypatch.setattr(cache, "get", healthy_get)
    assert post(client, "probe", request) == completed
    assert post(client, "start", request) == completed


@pytest.mark.l4_fault
def test_http_corrupt_journal_is_503_without_reexecution(execution_service, monkeypatch):
    from inspector_ml import pipeline
    client, _, _, _, sha, journal_dir = execution_service
    request = preflight(sha)
    assert post(client, "start", request)["status"] == "DONE"
    metadata = journal_dir / f"{request['job_id']}.1.json"
    metadata.write_text("{corrupt")
    monkeypatch.setattr(pipeline.Pipeline, "preflight", no_execution)
    for action in ["probe", "start", "cancel-unstarted"]:
        assert "unavailable or corrupt" in post(client, action, request, 503)["detail"]
    assert metadata.read_text() == "{corrupt"


def test_proxy_identity_change_cannot_adopt_preexisting_untracked_attempt(execution_service, monkeypatch):
    client, module, _, _, sha, _ = execution_service
    request = preflight(sha)
    post(client, "cancel-unstarted", request)
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_IDENTITY", str(uuid4()))
    monkeypatch.setenv("INSPECTOR_EXECUTION_PROXY_NAMESPACE", "new-proxy")
    post(client, "quiescence", request, status=409)


@pytest.mark.parametrize("status", ["RUNNING", "ABSENT", "DONE", "CANCELLED"])
def test_quiescence_does_not_seal_live_or_unverified_local_execution(execution_service, monkeypatch, status):
    from types import SimpleNamespace
    from inspector_ml.pipeline_execution import ExecutionSnapshot
    from inspector_ml import execution_scope
    client, module, _, _, sha, _ = execution_service
    request = preflight(sha)
    monkeypatch.setattr(module, "_execution_journal", lambda: SimpleNamespace(probe=lambda *args:
        ExecutionSnapshot(request["job_id"], 1, status, None)))
    monkeypatch.setattr(execution_scope, "seal_external", no_execution)
    assert not post(client, "quiescence", request)["quiescent"]


def test_quiescence_uses_external_proof_only_after_local_owner_stopped(execution_service, monkeypatch):
    from types import SimpleNamespace
    from inspector_ml.pipeline_execution import ExecutionSnapshot
    from inspector_ml import execution_scope
    client, module, _, _, sha, _ = execution_service
    request = preflight(sha)
    monkeypatch.setattr(module, "_execution_journal", lambda: SimpleNamespace(probe=lambda *args:
        ExecutionSnapshot(request["job_id"], 1, "INTERRUPTED", "a" * 64, reason="owner_disappeared")))
    calls = []
    def seal(job, epoch):
        calls.append((job, epoch))
        return {"job_id": job, "epoch": epoch, "quiescent": True, "journal_identity": "test"}
    monkeypatch.setattr(execution_scope, "seal_external", seal)
    assert post(client, "quiescence", request)["quiescent"]
    assert calls == [(request["job_id"], 1)]
