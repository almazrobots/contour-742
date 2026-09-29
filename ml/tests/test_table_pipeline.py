"""Таблицы в боевом конвейере (T-135): значение из строки таблицы с наименованием и единицей (OS-INSP-2.2.5) и выбор между
строкой текста и строкой таблицы (OS-INSP-2.2.30). Только синтетика reportlab (ADR-0002).

Эшелоны: L1 (таблица даёт значение; выбор по уверенности), L3 (листы без шапки не читаются; потолок листов),
L7 (параметры с паспортом и нечисловые не трогаются; след в извлечении), L2 (без таблиц результат прежний)."""

from __future__ import annotations

import pytest

from inspector_ml import tables as T
from inspector_ml.extract import extract
from inspector_ml.model import Extraction, Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.parse import parse_file
from inspector_ml.reread import extract_refined
from tests.test_tables import MATRIX, TEP, draw_table, make_pdf

SPECS = [
    ParamSpec(
        code=p["code"],
        anchors=p["anchors"],
        data_type=p["data_type"],
        regex_pattern=p.get("regex_pattern"),
        unit=p["unit"],
    )
    for p in MATRIX
]
BY = {s.code: s for s in SPECS}
AREA = next(
    s
    for s in SPECS
    if s.anchors and s.anchors[0].lower().startswith("площадь застройки")
)


def _sha(path):
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def tep(tmp_path_factory):
    return make_pdf(
        tmp_path_factory.mktemp("tp") / "tep.pdf", lambda c: draw_table(c, TEP)
    )


def run(path, specs=SPECS):
    doc = parse_file(path, _sha(path))
    return doc, extract_refined(path, doc, specs)


@pytest.mark.l1_functional
def test_table_row_value_reaches_pipeline_with_name_unit_and_cell(tep):
    doc, out = run(tep)
    e = next(x for x in out if x.code == AREA.code)
    assert e.value_num == 1234.5
    assert e.match == "table", (
        "значение пришло из строки таблицы, а не из строки текста"
    )
    assert "Площадь застройки" in e.line_text and "м2" in e.line_text.replace("²", "2")
    assert e.bbox is not None and e.anchor_bbox is not None, (
        "ячейка значения и ячейка наименования — на листе"
    )


@pytest.mark.l1_functional
def test_choice_between_text_line_and_table_row_by_confidence():
    """OS-INSP-2.2.30: более уверенное; при равной уверенности — табличное."""
    t = T.TableCandidate(
        param_code="M-X",
        value_raw="100",
        value_num=100.0,
        unit="м2",
        unit_doc="м2",
        page=1,
        bbox_cell=(0.5, 0.1, 0.6, 0.12),
        bbox_row=(0.1, 0.1, 0.6, 0.12),
        bbox_name=(0.1, 0.1, 0.4, 0.12),
        name_text="Площадь",
        strategy="lines",
        confidence=0.9,
    )
    line = lambda conf: Extraction(
        code="M-X",
        raw="90",
        value_num=90.0,
        page=1,
        bbox=None,
        line_text="Площадь 90 м2",
        confidence=conf,
    )
    assert T.choose(line(0.95), t).value_num == 90.0, "строка текста увереннее — она"
    assert T.choose(line(0.9), t).value_num == 100.0, "равная уверенность — таблица"
    assert T.choose(line(0.5), t).match == "table"
    assert T.choose(None, t).match == "table", "в тексте не нашлось — таблица"


@pytest.mark.l3_boundary
def test_pages_without_table_header_are_not_read(tmp_path, monkeypatch):
    """Таблица ищется только на листах с шапкой: остальной пакет pdfplumber не читает (время разбора)."""
    pdf = make_pdf(
        tmp_path / "plain.pdf",
        lambda c: (
            c.setFont("Noto", 10),
            c.drawString(60, 760, "Пояснительная записка. Общие сведения"),
        ),
    )
    called = []
    monkeypatch.setattr(
        T, "table_candidates", lambda *a, **k: called.append(k.get("pages")) or []
    )
    run(pdf)
    assert called == [] or called == [[]], (
        "без шапки таблицы — ни одного листа на чтение"
    )


@pytest.mark.l3_boundary
def test_table_pages_capped_and_ranked():
    head = Line(
        text="Наименование показателя Ед. изм. Значение",
        words=[Word(text="Наименование")],
    )
    plain = Line(text="Общие указания", words=[Word(text="Общие")])
    pages = [
        Page(
            page=i + 1,
            width=1,
            height=1,
            source="text",
            lines=[head] if i % 2 else [plain],
        )
        for i in range(200)
    ]
    pages.append(
        Page(page=201, width=1, height=1, source="ocr", lines=[head])
    )  # скан — pdfplumber текста не видит
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=pages)
    got = T.table_pages(doc)
    assert len(got) == T.TABLE_PAGE_CAP
    assert all(n % 2 == 0 for n in got) and 201 not in got


@pytest.mark.l7_discipline
def test_passport_and_non_numeric_params_untouched(tep):
    """Параметры с паспортом (класс, количество) — у своих извлекателей; строковые — у extract.py."""
    spec = AREA.model_copy(update={"extractor": {"kind": "passport-owned"}})
    doc, out = run(tep, [spec])
    assert all(e.match != "table" for e in out)
    enum = AREA.model_copy(update={"data_type": "enum"})
    doc, out = run(tep, [enum])
    assert all(e.match != "table" for e in out)


@pytest.mark.l2_differential
def test_docx_and_scans_unchanged():
    """Не PDF с текстовым слоем — результат ровно как без таблиц."""
    doc = ParsedDoc(
        sha256="0" * 64,
        kind="docx",
        engine="python-docx",
        pages=[
            Page(
                page=1,
                width=0,
                height=0,
                source="structured",
                lines=[
                    Line(text="Площадь застройки 100 м2", words=[Word(text="Площадь")])
                ],
            )
        ],
    )
    base = extract(doc, SPECS)
    assert T.merge_tables(None, doc, SPECS, base) == base


@pytest.mark.l3_boundary
def test_header_without_unit_column_is_not_a_table_page():
    """«Наименование» и «Количество» без колонки единицы — штамп или спецификация, а не таблица показателей (T-135, «Алтуфьево»)."""
    stamp = Line(text="Наименование", words=[Word(text="Наименование")])
    qty = Line(text="Количество", words=[Word(text="Количество")])
    unit = Line(text="Ед. изм.", words=[Word(text="Ед.")])
    doc = ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=[
        Page(page=1, width=1, height=1, source="text", lines=[stamp, qty]),
        Page(page=2, width=1, height=1, source="text", lines=[stamp, unit, qty]),
        Page(page=3, width=1, height=1, source="text", lines=[unit]),
    ])
    assert T.table_pages(doc) == [2, 3], "полная шапка — первой; без колонки единицы — не читается"
