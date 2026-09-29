"""OS-INSP-2.2.9: строковый параметр с числовым правилом — текст и главное число; без числа — только текст."""

from __future__ import annotations

import pytest

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word


def doc(text: str) -> ParsedDoc:
    ws, x = [], 0.05
    for t in text.split():
        ws.append(Word(text=t, bbox=(x, 0.3, x + 0.04, 0.32)))
        x += 0.05
    page = Page(page=1, width=595, height=842, source="text", lines=[Line(text=text, words=ws)])
    return ParsedDoc(sha256="x", kind="pdf", engine="pdfium", pages=[page])


def spec(kind: str | None) -> ParamSpec:
    return ParamSpec(code="M-048", anchors=["Количество лестничных маршей"], data_type="string", compare_kind=kind)


@pytest.mark.l1_functional
@pytest.mark.parametrize("kind", ["decrease", "increase", "delta_pct", "min", "max"])
def test_string_with_numeric_rule_gets_number_and_text(kind):
    (e,) = extract(doc("Количество лестничных маршей 3 марша по 12 ступеней"), [spec(kind)])
    assert e.value_num == 3.0
    assert e.value_text  # текст сохраняется для карточки доказательства


@pytest.mark.l6_adversarial
def test_string_equal_rule_stays_text_only_and_no_number_stays_none():
    (e,) = extract(doc("Количество лестничных маршей 3 марша"), [spec("equal")])
    assert e.value_num is None  # правило «равно» сравнивает текст — число не подменяет его
    # числа нет — либо значения нет вовсе, либо оно без числа; выдуманного числа не бывает
    assert all(e2.value_num is None for e2 in extract(doc("Количество лестничных маршей по проекту"), [spec("decrease")]))


@pytest.mark.l3_boundary
def test_without_compare_kind_behaviour_unchanged():
    (e,) = extract(doc("Количество лестничных маршей 3 марша"), [spec(None)])
    assert e.value_num is None
