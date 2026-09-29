"""T-237: actual versioned HTTP operations, legacy parity and failure paths."""

import uuid
import json
import subprocess

import pytest

from tests.test_parse_parts_http import service  # shared isolated cache/blob fixture


def start(client, digest, run_id=None):
    response = client.post("/pipeline/v1/preflight", json={"run_id": run_id or str(uuid.uuid4()),
        "request": {"sha256": digest, "params": [{"code": "FIRE", "anchors": ["fire resistance degree"], "data_type": "string"}]}})
    assert response.status_code == 200, response.text
    return response.json()


def test_preflight_commits_deterministic_pagekind_profiles(service):
    client, _, _, _, sha = service
    run_id = str(uuid.uuid4())
    plan = start(client, sha, run_id)
    response = client.post('/pipeline/v1/artifacts/export', json={
        'context': plan['context'], 'reference': plan['artifact'], 'stage': 'preflight'})
    assert response.status_code == 200
    profiles = response.json()['artifact']['payload']['page_profiles']
    assert len(profiles) == len(plan['regions']) == 5
    assert {p['page_id'] for p in profiles} == {r['page_id'] for r in plan['regions']}
    assert all(p['features']['text_chars'] > 0 for p in profiles)
    assert start(client, sha, run_id)['artifact'] == plan['artifact']


def step(client, plan, stage, inputs=None, region=None):
    return client.post("/pipeline/v1/" + stage, json={"context": plan["context"], "plan": plan["artifact"],
        "inputs": inputs or [], "region_id": region})


def finish(client, plan):
    parts = [step(client, plan, "parse", region=r["id"]).json()["artifact"] for r in plan["regions"]]
    for stage in ["merge", "extract", "aggregate"]:
        response = step(client, plan, stage, parts)
        assert response.status_code == 200, response.text
        out = response.json()
        parts = [out["artifact"]]
    return out


@pytest.mark.l2_differential
def test_real_stages_keep_legacy_values_and_add_source_trace(service):
    client, _, _, _, digest = service
    plan = start(client, digest)
    out = finish(client, plan)
    assert out["trace"]["completeness"]["publishable"]
    assert len(out["trace"]["pages"]) == 5
    assert [r["stage"] for r in out["trace"]["receipts"]] == ["preflight", *["parse"] * 5, "merge", "extract", "aggregate"]
    legacy = client.post("/analyze", json={"sha256": digest,
        "params": [{"code": "FIRE", "anchors": ["fire resistance degree"], "data_type": "string"}]}).json()
    result = out["result"]
    assert result["extractions"]
    for e in result["extractions"]:
        trace = e["meta"].pop("pipeline")
        assert trace["run_id"] == plan["context"]["run_id"]
        assert trace["line_ids"]
        if not e["meta"]:
            e["meta"] = None
    result.pop("param_ms")
    legacy.pop("param_ms")
    assert result == legacy
    warm = step(client, plan, "parse", region=plan["regions"][0]["id"])
    assert warm.json()["receipt"]["cached"]


@pytest.mark.l2_differential
def test_context_survives_actual_node_json_round_trip(service):
    client, _, _, _, digest = service
    plan = start(client, digest)
    # The production coordinator is Node: JSON.stringify removes integral .0.
    wire = subprocess.run(["node", "-e",
        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))));"],
        input=json.dumps(plan), text=True, capture_output=True, check=True, timeout=10)
    out = finish(client, json.loads(wire.stdout))
    assert out["trace"]["completeness"]["publishable"]


@pytest.mark.l4_fault
def test_incomplete_or_duplicate_parts_never_reach_extract(service):
    client, _, _, _, digest = service
    plan = start(client, digest)
    part = step(client, plan, "parse", region=plan["regions"][0]["id"]).json()["artifact"]
    for refs in [[], [part], [part] * 5]:
        assert step(client, plan, "merge", refs).status_code == 409
    assert step(client, plan, "extract", [part]).status_code == 409


@pytest.mark.l6_adversarial
def test_changed_runtime_or_foreign_run_rejected(service, monkeypatch):
    client, module, _, _, digest = service
    plan = start(client, digest)
    another = start(client, digest)
    part = step(client, plan, "parse", region=plan["regions"][0]["id"]).json()["artifact"]
    assert step(client, another, "merge", [part]).status_code == 409
    monkeypatch.setenv("INSPECTOR_PPOCR_DET_LIMIT", "2048")
    assert step(client, plan, "parse", region=plan["regions"][0]["id"]).status_code == 409
    request = {"run_id": plan["context"]["run_id"], "request": {"sha256": digest, "params": []}}
    assert client.post("/pipeline/v1/preflight", json=request).status_code == 409


@pytest.mark.l4_fault
def test_missing_reader_does_not_publish_result(service, monkeypatch):
    from inspector_ml import pipeline
    client, _, _, _, digest = service
    original = pipeline.parse_pdf_part

    def incomplete(*args):
        doc = original(*args)
        for p in doc.pages:
            p.source = "ocr"
            p.engines = []
            p.agreement = 1
        return doc

    monkeypatch.setattr(pipeline, "parse_pdf_part", incomplete)
    out = finish(client, start(client, digest))
    assert out["result"] is None
    assert not out["trace"]["completeness"]["publishable"]
    assert any(r.startswith("missing_ocr:") for r in out["trace"]["completeness"]["reasons"])


@pytest.mark.l2_differential
@pytest.mark.parametrize("kind", ["docx", "xml"])
def test_structured_documents_keep_existing_route(service, tmp_path, kind):
    from tests.test_parse_parts import sha
    client, module, _, _, _ = service
    path = tmp_path / f"source.{kind}"
    if kind == "docx":
        from docx import Document
        document = Document()
        document.add_paragraph("fire resistance degree II")
        document.save(path)
    else:
        path.write_text("<doc><text>fire resistance degree II</text></doc>")
    digest = sha(path)
    (module.BLOBS / digest).write_bytes(path.read_bytes())
    out = finish(client, start(client, digest))
    assert out["result"]["kind"] == kind
    assert out["trace"]["pages"][0]["region"]["geometry"] is None
