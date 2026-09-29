"""OS-INSP-2.2.150–2.2.151 (T-213): документы ИД по перечню паспорта и сечения элементов расчленения — М-096.

Только синтетические строки (ADR-0002). Конфигурация — из паспорта M-096.json так же, как её собирает API
(passport.ts: extractorSpec — перечень документов едет вместе с экстрактором).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.doc_requirements import (
    extract_doc_requirements,
    is_doc_requirements,
    sections_in,
)
from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
PP = json.loads((ROOT / "data/seed/passports/M-096.json").read_text("utf-8"))


def spec() -> ParamSpec:
    ext = {
        **PP["extractor"],
        "docs": [{"id": d["id"], "pattern": d["pattern"]} for d in PP["value"]["docs"]],
    }
    return ParamSpec(code="M-096", anchors=[PP["title"]], extractor=ext)


def mk_doc(*pages: list[str]) -> ParsedDoc:
    ps = []
    for n, lines in enumerate(pages, 1):
        out = []
        for li, text in enumerate(lines):
            ws, x = [], 0.02
            for t in text.split(" "):
                ws.append(
                    Word(
                        text=t,
                        bbox=(
                            round(x, 4),
                            0.05 + 0.03 * li,
                            round(x + 0.03, 4),
                            0.07 + 0.03 * li,
                        ),
                    )
                )
                x = min(x + 0.035, 0.95)
            out.append(Line(text=text, words=ws))
        ps.append(Page(page=n, width=595, height=842, source="text", lines=out))
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=ps)


def docs_of(*pages: list[str]) -> list[tuple[str | None, int]]:
    return [
        (e.value_text, e.page)
        for e in extract_doc_requirements(mk_doc(*pages), spec())
        if e.meta["kind"] == "doc"
    ]


def secs_of(*pages: list[str]) -> list[tuple[str | None, str, list[float]]]:
    return [
        (e.value_text, e.meta["profile"], e.meta["dims"])
        for e in extract_doc_requirements(mk_doc(*pages), spec())
        if e.meta["kind"] == "section"
    ]


@pytest.mark.l1_functional
def test_required_id_documents_found_by_passport_list_with_page_and_quote():
    got = docs_of(["Акт № 44 освидетельствования ответственных конструкций.", "Смонтированы временные стойки по узлу Р-2."])
    assert got == [("AOSR_SUPPORTS", 1)]
    (e,) = [x for x in extract_doc_requirements(mk_doc(["АОСР № 9: монтаж временных распорок"]), spec()) if x.meta["kind"] == "doc"]
    assert e.meta["doc"] == "AOSR_SUPPORTS" and e.bbox is not None and e.meta["quote"].startswith("АОСР") and "ENT-22" in e.meta["ops"]


@pytest.mark.l6_adversarial
def test_absent_or_negated_document_is_not_recorded_and_other_acts_do_not_count():
    # АОСР на другие работы (и «демонтаж» — не «монтаж») и отрицание — не акт монтажа креплений
    assert docs_of(["Акт освидетельствования скрытых работ: армирование плиты. Исполнительная схема свайного поля."]) == []
    assert docs_of(["АОСР № 3 (демонтаж кровли). Акт на временные крепления — не представлен."]) == []


@pytest.mark.l1_functional
def test_requisite_gaps_and_act_before_work_dates():
    got = extract_doc_requirements(
        mk_doc(["Акт № 2 от 03.04: монтаж временных стоек. Подписи: подрядчик — подп.; технадзор — ___ . Ссылка на проект: — ."]),
        spec(),
    )
    assert sorted(e.meta["label"] for e in got if e.meta["kind"] == "requisite_gap") == ["ссылка на проект", "технадзор"]
    dates = extract_doc_requirements(mk_doc(["Журнал работ: монтаж подкосов Р-5 — 10.06. Акт монтажа подкосов Р-5 № 4 — дата 08.06."]), spec())
    assert [(e.meta["kind"], e.meta["node"], e.meta["date"]) for e in dates if e.meta["kind"].endswith("_date")] == [("work_date", "Р-5", "-06-10"), ("act_date", "Р-5", "-06-08")]
    # без акта в документе пустые поля не ищутся
    assert [e for e in extract_doc_requirements(mk_doc(["Подрядчик: —."]), spec()) if e.meta["kind"] == "requisite_gap"] == []


@pytest.mark.l1_functional
def test_sections_of_temporary_elements_normalized():
    got = secs_of(["Узел временного расчленения: стойки из двутавра 30Б1, распорки уголок 100х8, подкос труба Ø159x6"])
    assert got == [("двутавр 30Б1", "ibeam", [30.0]), ("уголок 100×8", "angle", [100.0, 8.0]), ("труба 159×6", "pipe", [159.0, 6.0])]
    assert [(k, d) for k, d, *_ in sections_in("[16П и L63x5, I20")] == [("channel", [16.0]), ("angle", [63.0, 5.0]), ("ibeam", [20.0])]
    # сокращения «дв.», «тр.»; марка подкоса «ПК-2» — элемент крепления; строка спецификации ниже узла — его элемент
    assert secs_of(["Подпорка — дв. 25Б1"]) == [("двутавр 25Б1", "ibeam", [25.0])]
    assert secs_of(["ПК-2 — 4шт., тр.133x5"]) == [("труба 133×5", "pipe", [133.0, 5.0])]
    assert secs_of(["Временное раскрепление фасада.", "Марка | Сечение", "С-1 | Труба 89х4"]) == [("труба 89×4", "pipe", [89.0, 4.0])]


@pytest.mark.l6_adversarial
def test_profiles_of_main_frame_or_excavation_are_not_partition_sections():
    # двутавр основного каркаса без элемента временного крепления — не элемент расчленения
    assert secs_of(["Балки перекрытия из двутавра 40Б1, колонны труба 325x10"]) == []
    # распорки котлована — другой элемент: сохраняется отсеянным с причиной
    (e,) = [x for x in extract_doc_requirements(mk_doc(["Распорки котлована — труба 426х8"]), spec()) if x.meta["kind"] == "section"]
    assert e.meta["excluded"] == "OTHER_ELEMENT" and "котлован" in e.meta["excluded_why"]


@pytest.mark.l6_adversarial
def test_unreadable_section_and_not_applicable():
    got = extract_doc_requirements(mk_doc(["Подкос тр. 1?3х5"]), spec())
    assert [e.meta["kind"] for e in got] == ["section_unreadable"]
    assert [e.meta["kind"] for e in extract_doc_requirements(mk_doc(["Объект сносится полностью, сохраняемых конструкций нет."]), spec())] == ["not_applicable"]


@pytest.mark.l8_regression
def test_extract_routes_doc_requirements_param():
    sp = spec()
    assert is_doc_requirements(sp)
    other = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    out = extract(mk_doc(["Акт монтажа временных подкосов № 1", "Этажность 5"]), [sp, other])
    assert [(e.value_text, e.meta["kind"]) for e in out if e.code == "M-096"] == [("AOSR_SUPPORTS", "doc")]
    assert [e.value_num for e in out if e.code == "M-007"] == [5.0]


@pytest.mark.l6_adversarial
def test_reference_or_negated_mention_is_not_the_document():
    # W3-11: ссылка («см. акт …»), требование («акт … оформляется») и отрицание («не оформлялся», «нет акта») — не документ
    assert docs_of(["См. акт монтажа временных подкосов в приложении."]) == []
    assert docs_of(["Акт монтажа временных подкосов оформляется по форме приложения 3."]) == []
    assert docs_of(["Акт монтажа временных стоек не оформлялся."]) == []
    assert docs_of(["Нет акта монтажа временных подкосов."]) == []
    assert docs_of(["Акт монтажа временных подкосов № 5 от 02.03."]) == [("AOSR_SUPPORTS", 1)]


@pytest.mark.l4_fault
@pytest.mark.performance
def test_huge_page_is_cut_and_parses_fast():
    import time

    t0 = time.perf_counter()
    got = extract_doc_requirements(mk_doc(["Подкос " + "1" * 30000 + "х6 " + "труба " * 3000]), spec())
    assert time.perf_counter() - t0 < 2.0
    assert all(len(e.meta["quote"]) <= 160 for e in got)
