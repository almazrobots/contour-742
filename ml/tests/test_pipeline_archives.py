"""T-238: loss of volatile cache must not require rereading committed pages."""
import copy

import pytest

from inspector_ml.cache import FileCache
from inspector_ml.pipeline_contract import digest
from tests.test_parse_parts_http import service
from tests.test_pipeline_http import start, step


def export(client, context, reply):
    response = client.post("/pipeline/v1/artifacts/export", json={"context": context,
        "reference": reply["artifact"], "stage": reply["receipt"]["stage"]})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.l4_fault
def test_restore_after_cache_loss_never_reparses_committed_pages(service, tmp_path, monkeypatch):
    from inspector_ml import pipeline
    client, module, _, _, sha = service
    plan = start(client, sha)
    archives = [export(client, plan["context"], plan)]
    refs = []
    for region in plan["regions"]:
        parsed = step(client, plan, "parse", region=region["id"])
        assert parsed.status_code == 200, parsed.text
        refs.append(parsed.json()["artifact"])
        archives.append(export(client, plan["context"], parsed.json()))

    def no_reparse(*args):
        raise AssertionError("committed page was parsed again")

    monkeypatch.setattr(pipeline, "parse_pdf_part", no_reparse)
    # Simulate losing Redis/restarting ML at each downstream boundary.
    for stage in ["merge", "extract", "aggregate"]:
        monkeypatch.setattr(module, "CACHE", FileCache(tmp_path / stage))
        assert step(client, plan, stage, refs).status_code == 409
        for archive in archives:
            restored = client.post("/pipeline/v1/artifacts/restore", json=archive)
            assert restored.status_code == 200, restored.text
        warm = step(client, plan, "parse", region=plan["regions"][0]["id"])
        assert warm.status_code == 200 and warm.json()["receipt"]["cached"]
        response = step(client, plan, stage, refs)
        assert response.status_code == 200, response.text
        out = response.json()
        archives.append(export(client, plan["context"], out))
        refs = [out["artifact"]]
    assert out["trace"]["completeness"]["publishable"]
    assert out["result"]["extractions"]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("damage", ["checksum", "run", "stage", "payload", "foreign_source"])
def test_restore_rejects_corrupt_or_foreign_archive(service, tmp_path, monkeypatch, damage):
    client, module, _, _, sha = service
    plan = start(client, sha)
    parsed = step(client, plan, "parse", region=plan["regions"][0]["id"]).json()
    good = export(client, plan["context"], parsed)
    archive = copy.deepcopy(good)
    if damage == "checksum":
        archive["reference"] = "f" * 64
    elif damage == "run":
        archive["context"]["run_id"] = "12345678-1234-1234-1234-123456789abc"
    elif damage == "stage":
        archive["stage"] = "merge"
    else:
        if damage == "payload":
            archive["artifact"]["payload"]["pages"] = []
        else:
            archive["artifact"]["payload"]["doc"]["sha256"] = "e" * 64
        # Even a valid checksum cannot legitimize an invalid payload.
        archive["reference"] = digest(archive["artifact"])
    monkeypatch.setattr(module, "CACHE", FileCache(tmp_path / "empty"))
    response = client.post("/pipeline/v1/artifacts/restore", json=archive)
    assert response.status_code == 409, response.text
    request = {k: good[k] for k in ["context", "reference", "stage"]}
    assert client.post("/pipeline/v1/artifacts/export", json=request).status_code == 409


@pytest.mark.l4_fault
def test_archive_restore_rejects_changed_runtime(service, monkeypatch):
    client, _, _, _, sha = service
    plan = start(client, sha)
    archive = export(client, plan["context"], plan)
    monkeypatch.setenv("INSPECTOR_PPOCR_DET_LIMIT", "1234")
    assert client.post("/pipeline/v1/artifacts/restore", json=archive).status_code == 409
