"""T-236: полная публикация PDF и отказы через реальный HTTP-контракт ML."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from inspector_ml.cache import FileCache
from inspector_ml.docstore import load_parsed, parsed_key, part_key
from inspector_ml.parse import parse_pdf
from tests.test_parse_parts import text_pdf, sha


@pytest.fixture
def service(tmp_path, monkeypatch):
    import inspector_ml.app as module

    blobs = tmp_path / "blobs"
    blobs.mkdir()
    source = text_pdf(tmp_path / "five.pdf", 5)
    digest = sha(source)
    path = blobs / digest
    path.write_bytes(source.read_bytes())
    cache = FileCache(tmp_path / "cache")
    monkeypatch.setattr(module, "BLOBS", blobs)
    monkeypatch.setattr(module, "CACHE", cache)
    return TestClient(module.app), module, cache, path, digest


@pytest.mark.l2_differential
def test_http_complete_document_matches_full_parse(service):
    client, _, cache, path, digest = service
    body = {"sha256": digest}
    assert client.post("/parse/pages", json=body).json() == {"pages": 5, "parsed": False}
    for first, last in [(2, 5), (0, 2)]:
        response = client.post("/parse/part", json={**body, "first": first, "last": last})
        assert response.status_code == 200
        assert response.json()["pages"] == last - first
        assert cache.get(parsed_key(digest)) is None
    response = client.post("/parse/assemble", json={**body, "ranges": [[2, 5], [0, 2]]})
    assert response.status_code == 200 and response.json() == {"pages": 5}
    doc, hit = load_parsed(cache, path, digest)
    assert hit and doc == parse_pdf(path, digest)
    assert client.post("/parse/pages", json=body).json() == {"pages": None, "parsed": True}
    assert client.post("/parse/assemble", json={**body, "ranges": [[0, 5]]}).status_code == 200
    assert client.post("/parse/part", json={**body, "first": 1, "last": 3}).json()["cached"] is True


@pytest.mark.l4_fault
def test_http_incomplete_tail_and_missing_checkpoint_do_not_publish(service):
    client, _, cache, _, digest = service
    body = {"sha256": digest}
    assert client.post("/parse/part", json={**body, "first": 0, "last": 2}).status_code == 200
    assert client.post("/parse/assemble", json={**body, "ranges": [[0, 2]]}).status_code == 400
    assert client.post("/parse/assemble", json={**body, "ranges": [[0, 2], [2, 5]]}).status_code == 409
    assert cache.get(parsed_key(digest)) is None


@pytest.mark.l4_fault
@pytest.mark.parametrize("damage", ["missing", "sha", "json", "boolean_page"])
def test_http_corrupt_whole_is_rejected_on_all_read_paths(service, damage):
    import json

    client, module, cache, path, digest = service
    doc = parse_pdf(path, digest).model_dump()
    if damage == "missing":
        doc["pages"] = doc["pages"][:2]
    elif damage == "sha":
        doc["sha256"] = "f" * 64
    elif damage == "boolean_page":
        doc["pages"][0]["page"] = True
    cache.set(parsed_key(digest), "{" if damage == "json" else json.dumps(doc))
    body = {"sha256": digest}
    for endpoint, extra in [("pages", {}), ("part", {"first": 0, "last": 2}),
                            ("assemble", {"ranges": [[0, 5]]})]:
        assert client.post("/parse/" + endpoint, json={**body, **extra}).status_code == 409
    assert client.post("/analyze", json={**body, "params": []}).status_code == 409
    with pytest.raises(HTTPException) as exc:
        module._load_doc(digest)
    assert exc.value.status_code == 409


@pytest.mark.l6_adversarial
@pytest.mark.parametrize("source_state,status", [("missing", 404), ("changed", 409)])
def test_http_assemble_checks_source_even_on_whole_hit(service, source_state, status):
    client, _, cache, path, digest = service
    cache.set(parsed_key(digest), parse_pdf(path, digest).model_dump_json())
    if source_state == "missing":
        path.unlink()
    else:
        path.write_bytes(b"%PDF-corrupted")
    assert client.post("/parse/assemble", json={"sha256": digest, "ranges": [[0, 5]]}).status_code == status


@pytest.mark.l3_boundary
@pytest.mark.parametrize("ranges", [[[0, 2]], [[0, 6]], [[0, 0], [0, 5]], [[0, 3], [2, 5]]])
def test_http_bad_ranges_rejected_even_with_valid_whole(service, ranges):
    client, _, cache, path, digest = service
    cache.set(parsed_key(digest), parse_pdf(path, digest).model_dump_json())
    assert client.post("/parse/assemble", json={"sha256": digest, "ranges": ranges}).status_code == 400


@pytest.mark.l4_fault
def test_http_foreign_part_is_conflict_without_publication(service):
    client, _, cache, path, digest = service
    foreign = parse_pdf(path, digest).model_copy(update={"sha256": "f" * 64})
    cache.set(part_key(digest, 0, 5), foreign.model_dump_json())
    assert client.post("/parse/assemble", json={"sha256": digest, "ranges": [[0, 5]]}).status_code == 409
    assert cache.get(parsed_key(digest)) is None


@pytest.mark.l2_differential
@pytest.mark.parametrize("kind", ["docx", "xml"])
def test_non_pdf_whole_cache_remains_supported(service, tmp_path, kind):
    client, module, cache, _, _ = service
    source = tmp_path / ("document." + kind)
    if kind == "docx":
        from docx import Document
        doc = Document()
        doc.add_paragraph("Ширина двери 900 мм")
        doc.save(source)
    else:
        source.write_text('<?xml version="1.0"?><document><text>Ширина двери 900 мм</text></document>')
    digest = sha(source)
    path = module.BLOBS / digest
    path.write_bytes(source.read_bytes())
    body = {"sha256": digest}
    assert client.post("/parse/pages", json=body).json() == {"pages": None, "parsed": False}
    fresh, hit = load_parsed(cache, path, digest)
    assert not hit and fresh.kind == kind
    warmed, hit = load_parsed(cache, path, digest)
    assert hit and warmed == fresh
    assert client.post("/parse/pages", json=body).json() == {"pages": None, "parsed": True}
    assert client.post("/parse/part", json={**body, "first": 0, "last": 1}).status_code == 415


@pytest.mark.l3_boundary
@pytest.mark.parametrize("value", [True, "1", 1.5])
def test_http_ranges_require_integer_json_values(service, value):
    client, _, _, _, digest = service
    assert client.post("/parse/part", json={"sha256": digest, "first": value, "last": 5}).status_code == 422
    assert client.post("/parse/assemble", json={"sha256": digest, "ranges": [[0, value]]}).status_code == 422
