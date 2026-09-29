"""OS-INSP-2.2.7: вид документа по заголовку и шапке спецификации."""

from __future__ import annotations

import pytest

from inspector_ml.doctype import classify
from inspector_ml.model import Line, Page, ParsedDoc, Word


def doc(*rows: tuple[str, float], page2: list[tuple[str, float]] | None = None) -> ParsedDoc:
    def mk(rs):
        out = []
        for text, y in rs:
            ws, x = [], 0.05
            for t in text.split():
                ws.append(Word(text=t, bbox=(x, y, x + 0.04, y + 0.015)))
                x += 0.05
            out.append(Line(text=text, words=ws))
        return out

    pages = [Page(page=1, width=595, height=842, rotation=0, source="text", quality="OK", lines=mk(rows))]
    if page2:
        pages.append(Page(page=2, width=595, height=842, rotation=0, source="text", quality="OK", lines=mk(page2)))
    return ParsedDoc(sha256="x", kind="pdf", engine="pdfium", pages=pages)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "title,kind",
    [
        ("Спецификация оборудования, изделий и материалов", "specification"),
        ("Ведомость ТЭП", "statement"),
        ("Архитектурные решения. Общие данные", "general_data"),
        ("Локальный сметный расчёт № 02-01-01", "estimate"),  # смета, хотя есть слово «расчёт»
        ("Опросный лист на насосную станцию", "questionnaire"),
        ("Расчёт несущей способности свай", "calculation"),
        ("Исполнительный чертёж фундаментной плиты", "drawing"),
        ("Пояснительная записка", "other"),
    ],
)
def test_kind_by_title(title, kind):
    r = classify(doc((title, 0.08), ("Прочий текст документа", 0.5)))
    assert r.kind == kind
    if kind != "other":
        assert r.page == 1 and r.bbox is not None and r.evidence == title


@pytest.mark.l1_functional
def test_specification_by_gost_header_without_title_word():
    r = classify(doc(("Раздел КЖ", 0.08), page2=[("Поз. Обозначение Наименование Кол. Масса ед. Примечание", 0.2)]))
    assert (r.kind, r.page) == ("specification", 2)


@pytest.mark.l6_adversarial
def test_title_word_low_on_page_is_not_title():
    # «смета» в примечании внизу листа не делает документ сметой
    r = classify(doc(("Архитектурные решения", 0.08), ("Стоимость работ — по смете заказчика", 0.9)))
    assert r.kind == "other"


@pytest.mark.l3_boundary
def test_three_header_columns_are_not_enough_and_empty_doc():
    assert classify(doc(("Наименование Кол. Примечание", 0.2))).kind == "other"
    assert classify(ParsedDoc(sha256="x", kind="pdf", engine="pdfium", pages=[])).kind == "other"
