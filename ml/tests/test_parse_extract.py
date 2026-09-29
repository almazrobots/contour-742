"""Тесты ML-модуля. Имя теста — то, на что ссылается трасса (docs/gera/inspector/model.yaml → impl)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas

from inspector_ml.extract import extract
from inspector_ml.model import ParamSpec
from inspector_ml.normalize import latinize_code, parse_number
from inspector_ml.parse import CorruptedFile, UnsupportedFormat, parse_file

# Корень репозитория ищется вверх: тесты запускаются и из песочницы mutmut (ml/mutants/tests)
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "data/seed/matrix.json").exists())
SYNTH = ROOT / "data/synth"
MATRIX = json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
SPECS = [
    ParamSpec(
        code=p["code"],
        anchors=p["anchors"],
        data_type=p["data_type"],
        regex_pattern=p.get("regex_pattern"),
    )
    for p in MATRIX
]


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def parsed(obj: str, name: str):
    p = SYNTH / obj / name
    return parse_file(p, sha(p))


def by_code(ex):
    return {e.code: e for e in ex}


def ml_client(tmp_path, monkeypatch):
    """ML-сервис с временными кэшем и хранилищем; в хранилище лежит один синтетический файл."""
    import importlib
    import shutil

    import inspector_ml.app as app_mod

    f = SYNTH / "OBJ-SEV-2" / "SEV-PD-PZ-1.pdf"
    blobs = tmp_path / "blobs"
    blobs.mkdir(exist_ok=True)
    shutil.copy(f, blobs / sha(f))
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(blobs))
    importlib.reload(app_mod)
    return TestClient(app_mod.app), f


# ─────────────────────────────── OS-INSP-2.1 распознавание


@pytest.mark.l1_functional
def test_text_layer_first_ocr_only_without_layer():
    """OS-INSP-2.1.1: текстовый слой берётся как есть, OCR — только для страницы без слоя."""
    text_doc = parsed("OBJ-SEV-2", "SEV-PD-PZ-1.pdf")
    assert {p.source for p in text_doc.pages} == {"text"}
    scan = parsed("OBJ-SEV-2", "SEV-ID-DOOR-1.pdf")
    assert [p.source for p in scan.pages] == ["ocr"]
    assert "tesseract" in scan.engine


@pytest.mark.l6_adversarial
def test_noise_page_marked_low_quality(tmp_path):
    """OS-INSP-2.1.2: страница без читаемого текста получает LOW_QUALITY, а не пустой «OK»."""
    p = tmp_path / "noise.pdf"
    c = canvas.Canvas(str(p))
    for i in range(0, 600, 7):
        c.line(i, 0, 600 - i, 800)
    c.showPage()
    c.save()
    doc = parse_file(p, sha(p))
    assert doc.pages[0].quality in ("LOW_QUALITY", "ABSTAIN")


@pytest.mark.l1_functional
def test_analyze_cached_by_sha256(tmp_path, monkeypatch):
    """OS-INSP-2.1.3: повторный разбор того же файла берётся из кэша по SHA-256."""
    client, f = ml_client(tmp_path, monkeypatch)
    body = {"sha256": sha(f), "params": [SPECS[1].model_dump()]}
    first = client.post("/analyze", json=body).json()
    second = client.post("/analyze", json=body).json()
    assert first["cached"] is False and second["cached"] is True
    assert first["extractions"] == second["extractions"]


@pytest.mark.l1_functional
def test_analyze_and_health_report_ml_revision(tmp_path, monkeypatch):
    """OS-INSP-2.1.12: ответ и /health несут версию разбора и извлечения — и из кэша тоже."""
    from inspector_ml import app as app_mod
    from inspector_ml.extract import EXTRACT_REV

    client, f = ml_client(tmp_path, monkeypatch)
    body = {"sha256": sha(f), "params": [SPECS[1].model_dump()]}
    want = f"r{app_mod.PARSER_REV}-x{EXTRACT_REV}"
    assert client.post("/analyze", json=body).json()["ml_revision"].startswith(want)
    assert client.post("/analyze", json=body).json()["ml_revision"].startswith(want)  # из кэша
    assert client.get("/health").json()["ml_revision"].startswith(want)


@pytest.mark.l6_adversarial
def test_analyze_rejects_paths_and_bad_hashes(tmp_path, monkeypatch):
    """Файл адресуется только хешем внутри хранилища: путь и «../» не принимаются."""
    client, f = ml_client(tmp_path, monkeypatch)
    for bad in ("../../etc/passwd", "0" * 63, "Z" * 64, sha(f) + "/.."):
        assert client.post("/analyze", json={"sha256": bad, "params": []}).status_code == 422
    assert client.post("/analyze", json={"path": "/etc/passwd", "sha256": "0" * 64, "params": []}).status_code == 404
    (tmp_path / "blobs" / ("1" * 64)).write_bytes(f.read_bytes())
    assert client.post("/analyze", json={"sha256": "1" * 64, "params": []}).status_code == 409


# ─────────────────────────────── ошибки формата (ML-сторона OS-INSP-1.2.1, 1.2.4)


@pytest.mark.l6_adversarial
def test_corrupted_pdf_rejected(tmp_path):
    p = tmp_path / "bad.pdf"
    p.write_bytes(b"%PDF-1.7\n" + b"\x00garbage" * 50)
    with pytest.raises(CorruptedFile):
        parse_file(p, sha(p))


@pytest.mark.l6_adversarial
def test_unsupported_format_rejected(tmp_path):
    # PNG с T-036 принимается (OS-INSP-1.2.9); GIF — по-прежнему нет
    p = tmp_path / "x.gif"
    p.write_bytes(b"GIF89a" + b"0" * 20)
    with pytest.raises(UnsupportedFormat):
        parse_file(p, sha(p))


@pytest.mark.l6_adversarial
def test_xml_entity_expansion_rejected(tmp_path):
    """Файлы от внешних сторон — недоверенные: XXE и «billion laughs» отвергаются."""
    p = tmp_path / "evil.xml"
    p.write_text(
        '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "xx"><!ENTITY y "&x;&x;">]><a>&y;</a>',
        "utf-8",
    )
    with pytest.raises(CorruptedFile):
        parse_file(p, sha(p))


# ─────────────────────────────── OS-INSP-2.2 извлечение


@pytest.mark.l1_functional
def test_extraction_keeps_page_and_bbox():
    """OS-INSP-2.2.1: значение хранится со страницей и bbox."""
    ex = by_code(extract(parsed("OBJ-SEV-2", "SEV-PD-PZ-1.pdf"), SPECS))
    e = ex["M-002"]
    assert e.value_num == 12450.0 and e.page == 2
    assert e.bbox is not None and e.line_text.startswith("Общая площадь здания")


@pytest.mark.l3_boundary
def test_bbox_normalized_on_rotated_page():
    """OS-INSP-2.2.2: bbox в [0;1] видимой области; на листе с /Rotate 90 координаты повёрнуты."""
    doc = parsed("OBJ-SEV-2", "SEV-PD-KR-1.pdf")
    assert doc.pages[1].rotation == 90
    e = by_code(extract(doc, SPECS))["M-055"]
    x0, y0, x1, y1 = e.bbox
    assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
    # в неповёрнутом листе значение справа вверху; после поворота на 90° — справа внизу
    assert x0 > 0.5 and y0 > 0.5
    unrotated = by_code(extract(parsed("OBJ-SEV-2", "SEV-RD-KZH-1.pdf"), SPECS))[
        "M-055"
    ]
    assert unrotated.bbox[0] > 0.5 and unrotated.bbox[1] < 0.5


@pytest.mark.l1_functional
def test_missing_value_not_invented():
    """OS-INSP-2.2.3: параметра нет в документе — извлечения нет."""
    ex = by_code(extract(parsed("OBJ-SEV-2", "SEV-ID-JBR-1.pdf"), SPECS))
    assert "M-002" not in ex and "M-001" not in ex


@pytest.mark.l2_differential
def test_extraction_matches_answer_values():
    """Независимая сверка с исходными данными генератора синтетики."""
    cases = {
        ("OBJ-SEV-2", "SEV-RD-AR-B.pdf"): {
            "M-002": 12710.0,
            "M-041": 0.85,
            "M-007": 12.0,
        },
        ("OBJ-SEV-2", "SEV-ID-TP-1.xml"): {"M-002": 12705.0, "M-001": 2140.0},
        ("OBJ-SEV-2", "SEV-ID-AOSR-7.docx"): {"M-058": 800.0},
    }
    for (obj, name), want in cases.items():
        ex = by_code(extract(parsed(obj, name), SPECS))
        assert {k: ex[k].value_num for k in want} == want, name
    enums = by_code(extract(parsed("OBJ-SEV-2", "SEV-PD-KR-1.pdf"), SPECS))
    assert enums["M-057"].value_text == "A500C"
    assert (
        by_code(extract(parsed("OBJ-SEV-2", "SEV-ID-DOOR-1.pdf"), SPECS))[
            "M-103"
        ].value_text
        == "EI30"
    )


# ─────────────────────────────── нормализация


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "raw,want",
    [
        ("12 450,0", 12450.0),
        ("0,85", 0.85),
        ("48 900", 48900.0),
        ("39.6", 39.6),
        ("1 250", 1250.0),
        ("нет", None),
        ("-3", -3.0),
    ],
)
def test_parse_number(raw, want):
    assert parse_number(raw) == want


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "raw,want", [("В30", "B30"), ("А500С", "A500C"), ("ЕI 60", "EI60"), ("B 25", "B25")]
)
def test_latinize_code(raw, want):
    assert latinize_code(raw) == want


# ─────────────────────────────── регрессии (L8) и отказы (L4)


@pytest.mark.l8_regression
def test_room_numbers_with_dots_stay_whole():
    """Регрессия 2026-09-24: у точки крошечная рамка — «1.18» рвалось на «1 .18» и давало ложный SEMANTIC_DISSONANCE."""
    from inspector_ml.extract import rooms

    got = [(r.number, r.name) for r in rooms(parsed("OBJ-POL-115", "POL-PD-PZ-1.pdf"))]
    assert got == [("0.12", "Техническое помещение"), ("1.05", "Регистратура"), ("1.18", "Кабинет врача")]


@pytest.mark.l4_fault
def test_concurrent_pdf_parsing_does_not_crash():
    """Регрессия 2026-09-24: pdfium не потокобезопасен — параллельный разбор ронял ML-процесс (SIGSEGV)."""
    from concurrent.futures import ThreadPoolExecutor

    names = ["SEV-PD-PZ-1.pdf", "SEV-PD-KR-1.pdf", "SEV-RD-AR-B.pdf", "SEV-RD-KZH-1.pdf"] * 3
    with ThreadPoolExecutor(max_workers=6) as ex:
        docs = list(ex.map(lambda n: parsed("OBJ-SEV-2", n), names))
    assert [len(d.pages) for d in docs] == [3, 3, 3, 4] * 3  # в РД КЖ — лист «Перечень скрытых работ» (T-038)


@pytest.mark.l7_discipline
def test_health_reports_image_revision(monkeypatch):
    # T-060, стандарт Q3: гейт запускает образ ML и сверяет ревизию с git sha сборки
    from inspector_ml import app as app_mod

    c = TestClient(app_mod.app)
    monkeypatch.setenv("INSPECTOR_REVISION", " 96550f0 ")
    assert c.get("/health").json()["revision"] == "96550f0"
    monkeypatch.setenv("INSPECTOR_REVISION", " ")
    assert c.get("/health").json()["revision"] is None
