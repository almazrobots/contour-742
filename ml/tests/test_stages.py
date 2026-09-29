"""Этапы конвейера на маке (T-130, NFR-ML-HOST) и сервис разбора с читателями сканов — без моделей: модель подменяется.

Эшелоны: L1 этапы и сведение в сервисе · L3 границы (--limit, потолок памяти MLX) · L4 отказы (битый файл, нет VLM) ·
L7 дисциплина (одна модель — один процесс: сервис не грузит читателей; ревизия и ключ кэша меняются с прочтениями)."""

from __future__ import annotations

import hashlib
import importlib
import json
import io

from reportlab.pdfgen import canvas

import pytest

from inspector_ml import readers, stages, vlm
from inspector_ml.model import Line, Page, ParsedDoc, Word

def _synthetic_pdf(text="Synthetic page for reader checkpoint tests"):
    output = io.BytesIO()
    document = canvas.Canvas(output, pagesize=(595, 842), invariant=1)
    document.drawString(40, 700, text)
    document.showPage()
    document.save()
    return output.getvalue()


PDF = _synthetic_pdf()
SHA = hashlib.sha256(PDF).hexdigest()
C1 = "Класс конструктивной пожарной опасности – С1."


def scan_doc(sha: str = SHA) -> ParsedDoc:
    ws = [
        Word(text=t, bbox=(0.1 + 0.05 * i, 0.6, 0.14 + 0.05 * i, 0.612))
        for i, t in enumerate(C1.split())
    ]
    return ParsedDoc(
        sha256=sha,
        kind="pdf",
        engine="pdfium+tesseract",
        pages=[
            Page(
                page=1,
                width=595,
                height=842,
                source="ocr",
                ocr_confidence=80.0,
                lines=[Line(text=C1, words=ws)],
            )
        ],
    )


@pytest.fixture()
def env(tmp_path, monkeypatch):
    (tmp_path / "blobs").mkdir()
    (tmp_path / "blobs" / SHA).write_bytes(PDF)
    (tmp_path / "blobs" / ("f" * 64)).write_bytes(
        b"not a pdf at all"
    )  # не PDF — этапы его пропускают
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_READER_CACHE", str(tmp_path / "readers"))
    return tmp_path


@pytest.mark.l1_functional
def test_class_specs_from_passports_like_api():
    (sp,) = [s for s in stages.class_specs() if s.code == "M-023"]
    ext = sp.extractor
    assert ext["kind"] == "class_mentions" and ext["scale"] == ["С3", "С2", "С1", "С0"]
    assert "не ниже" in ext["constraint_markers"]


@pytest.mark.l1_functional
def test_parse_stage_parses_pdf_once_and_respects_limit(env, monkeypatch, capsys):
    import inspector_ml.docstore as ds

    calls = []
    monkeypatch.setattr(
        ds, "parse_file", lambda path, sha: calls.append(sha) or scan_doc(sha)
    )
    assert stages.run_parse(limit=0)["done"] == 0, "--limit 0 — ничего"
    assert stages.run_parse(limit=10)["done"] == 1
    assert stages.run_parse(limit=10)["done"] == 0, (
        "разобранное повторно не разбирается"
    )
    assert calls == [SHA]
    line = json.loads(capsys.readouterr().out.strip().splitlines()[0])
    assert line["stage"] == "parse" and line["scans"] == 1 and "rss_gb" in line


@pytest.mark.l4_fault
def test_parse_stage_reports_broken_file_and_goes_on(env, monkeypatch, capsys):
    import inspector_ml.docstore as ds
    from inspector_ml.parse import CorruptedFile

    def boom(path, sha):
        raise CorruptedFile("повреждённый PDF")

    monkeypatch.setattr(ds, "parse_file", boom)
    assert stages.run_parse(limit=None)["done"] == 1
    assert "повреждённый PDF" in capsys.readouterr().out


@pytest.mark.l1_functional
def test_reader2_stage_asks_exactly_the_boxes_service_will_look_up(env, monkeypatch):
    import inspector_ml.docstore as ds

    monkeypatch.setattr(ds, "parse_file", lambda path, sha: scan_doc(sha))
    stages.run_parse(limit=None)
    rc = stages.reader_cache()
    rc.put_page(
        SHA,
        1,
        vlm.READER,
        [
            readers.Band(
                y0,
                y1,
                "Класс конструктивной пожарной опасности – С0"
                if y0 <= 0.6 <= y1 and y0 > 0.4
                else "",
            )
            for y0, y1 in readers.band_ranges()
        ],
        5,
    )
    cache = stages._cache()
    todo = stages.reader2_targets(cache, rc, stages.class_specs())
    assert len(todo) == 1, (
        "спор ансамбля (С1) и читателя (С0) — одно место для второго читателя"
    )
    _, _, page, box = todo[0]
    rc.put_crop(SHA, page, box, vlm.READER2, "С0", 5)
    assert stages.reader2_targets(cache, rc, stages.class_specs()) == [], (
        "прочитанное повторно не спрашивается"
    )
    # сервис при сведении берёт именно эту рамку из кэша: 2 из 3 за читателя
    doc = stages.cached_doc(cache, SHA)
    from inspector_ml.class_mentions import extract_class_mentions

    specs = stages.class_specs()
    out = readers.merge_doc(
        SHA,
        doc,
        [e for s in specs for e in extract_class_mentions(doc, s)],
        specs,
        rc,
        readers.Models("ансамбль", vlm.READER, vlm.READER2),
    )
    assert [(e.value_text, e.meta["reader_outcome"]) for e in out] == [
        ("С0", "majority-reader")
    ]


@pytest.mark.l4_fault
def test_reader_stages_refuse_without_vlm(monkeypatch, capsys):
    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    assert stages.main(["reader", "--limit", "1"]) == 2
    assert "INSPECTOR_VLM_BACKEND" in capsys.readouterr().err


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "raw,gb", [("10", 10), ("1", 2), ("100", 16), ("мусор", 10), ("8.5", 8.5)]
)
def test_mlx_memory_limit_is_clamped(raw, gb):
    assert vlm.memory_limit_bytes({"INSPECTOR_MLX_MEMORY_GB": raw}) == int(gb * 1024**3)


@pytest.mark.l1_functional
def test_short_model_names_for_inspector_card():
    assert vlm.short_name("mlx-community/PaddleOCR-VL-1.5-bf16") == "PaddleOCR-VL-1.5"
    assert vlm.short_name("mlx-community/Qwen3.5-9B-MLX-4bit") == "Qwen3.5-9B"
    assert vlm.short_name("mlx-community/GLM-OCR-bf16") == "GLM-OCR"


@pytest.mark.l7_discipline
def test_service_with_reader_cache_changes_revision_and_cache_key_and_never_loads_readers(
    env, monkeypatch
):
    from fastapi.testclient import TestClient

    import inspector_ml.app as app_mod
    import inspector_ml.docstore as ds

    monkeypatch.setenv("INSPECTOR_VLM_BACKEND", "none")
    app_mod = importlib.reload(app_mod)
    monkeypatch.setattr(ds, "parse_file", lambda path, sha: scan_doc(sha))
    monkeypatch.setattr(
        vlm,
        "generate",
        lambda *a, **k: pytest.fail("сервис не должен звать модели читателей"),
    )
    assert "-rd:" in app_mod.ml_revision(), (
        "прочтения читателей — часть версии интеллектуальной части (OS-INSP-2.1.12)"
    )
    (spec,) = [s for s in stages.class_specs() if s.code == "M-023"]  # С1 — шкала М-023
    body = {"sha256": SHA, "params": [spec.model_dump()]}
    req = app_mod.AnalyzeRequest(**body)
    k0 = app_mod._cache_key(req)
    (e,) = TestClient(app_mod.app).post("/analyze", json=body).json()["extractions"]
    assert (
        e["meta"]["text_source"] == "scan-ocr" and "reader_outcome" not in e["meta"]
    ), "прочтений нет — как было"
    app_mod.READER_CACHE.put_page(
        SHA,
        1,
        vlm.READER,
        [readers.Band(y0, y1, C1) for y0, y1 in readers.band_ranges()],
        5,
    )
    k1 = app_mod._cache_key(req)
    assert k1 != k0, "новое прочтение — новый ключ кэша, а не старый ответ"
    (e,) = TestClient(app_mod.app).post("/analyze", json=body).json()["extractions"]
    assert e["meta"]["reader_outcome"] == "agree"
    monkeypatch.delenv("INSPECTOR_READER_CACHE")
    importlib.reload(app_mod)


@pytest.mark.l1_functional
def test_reader_targets_put_traced_pages_first_and_sha_filter(env, monkeypatch):
    import inspector_ml.docstore as ds

    other_pdf = _synthetic_pdf("Other synthetic page")
    other = hashlib.sha256(other_pdf).hexdigest()
    (env / "blobs" / other).write_bytes(other_pdf)
    low = ParsedDoc(sha256=other, kind="pdf", engine="t", pages=[Page(page=1, width=1, height=1, source="ocr", quality="LOW_QUALITY", lines=[])])
    monkeypatch.setattr(ds, "parse_file", lambda path, sha: scan_doc(sha) if sha == SHA else low)
    stages.run_parse(limit=None)
    cache, specs = stages._cache(), stages.class_specs()
    got = [(sha, n) for sha, _, n in stages.reader_targets(cache, specs)]
    assert got[0] == (SHA, 1), "страница со следом оборота — первой"
    assert (other, 1) in got, "неуверенная страница без следа — тоже, но после"
    monkeypatch.setattr(stages, "ONLY", (other[:12],))
    assert [(sha, n) for sha, _, n in stages.reader_targets(cache, specs)] == [(other, 1)]


@pytest.mark.l4_fault
def test_stage_reader_rejects_invalid_whole_checkpoint(env):
    from inspector_ml.docstore import InvalidCheckpoint, parsed_key

    cache = stages._cache()
    cache.set(parsed_key(SHA), scan_doc().model_copy(update={"pages": []}).model_dump_json())
    with pytest.raises(InvalidCheckpoint):
        stages.cached_doc(cache, SHA)
