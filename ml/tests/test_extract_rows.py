"""OS-INSP-2.2.10, 2.2.11: строка — одному из соперников; строковое значение — весь хвост строки."""

from __future__ import annotations

import pytest

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word


def doc(*texts: str, source: str = "text") -> ParsedDoc:
    lines = []
    for i, t in enumerate(texts):
        ws, x = [], 0.05
        for tok in t.split():
            ws.append(Word(text=tok, bbox=(x, 0.1 + i * 0.03, x + 0.04, 0.115 + i * 0.03)))
            x += 0.05
        lines.append(Line(text=t, words=ws))
    return ParsedDoc(sha256="x", kind="pdf", engine="pdfium", pages=[Page(page=1, width=595, height=842, source=source, ocr_confidence=90 if source == "ocr" else None, lines=lines)])


V = ParamSpec(code="M-004", anchors=["Строительный объем"], data_type="number")
UNDER = ParamSpec(code="M-005", anchors=["Строительный объем (Подземный)"], data_type="number")
OVER = ParamSpec(code="M-006", anchors=["Строительный объем (Надземный)"], data_type="number")


@pytest.mark.l6_adversarial
def test_rival_anchor_does_not_steal_row():
    # в документе нет строки «Надземный» — M-006 не должен забрать строку «Подземный», M-004 — тоже
    got = {e.code: e.raw for e in extract(doc("Строительный объем м3 39 309", "Строительный объем (Подземный) м3 84 802"), [V, UNDER, OVER])}
    assert got == {"M-004": "39 309", "M-005": "84 802"}


@pytest.mark.l1_functional
def test_stamp_fields_on_one_line_are_not_rivals():
    specs = [
        ParamSpec(code="code", anchors=["Шифр"], regex_pattern=r"^[\s:]*\S+"),
        ParamSpec(code="stage", anchors=["Стадия"], regex_pattern=r"^[\s:]*(?:ИД|П|P)(?=[\s.,;]|$)"),
    ]
    got = {e.code for e in extract(doc("Шифр: АБ1-П-ПЗ Стадия: П Ред.: 1"), specs)}
    assert got == {"code", "stage"}


@pytest.mark.l1_functional
def test_string_value_is_whole_tail():
    s = ParamSpec(code="M-016", anchors=["Тип фундамента"], data_type="string", compare_kind="equal")
    (e,) = extract(doc("Тип фундамента: по типовому решению"), [s])
    assert e.raw == "по типовому решению"
    assert e.value_num is None


@pytest.mark.l6_adversarial
def test_ocr_page_rival_by_lower_threshold():
    # на скане порог якоря ниже: «коридора» нечётко совпадает с «выхода» — строка должна достаться M-041
    corridor = ParamSpec(code="M-040", anchors=["Ширина эвакуационного коридора"], data_type="number")
    exit_ = ParamSpec(code="M-041", anchors=["Ширина эвакуационного выхода"], data_type="number")
    got = {e.code: e.raw for e in extract(doc("Ширина эвакуационного выхода м 0,85", source="ocr"), [corridor, exit_])}
    assert got == {"M-041": "0,85"}


@pytest.mark.l1_functional
def test_enum_without_pattern_is_whole_tail_too():
    # M-109 «Пожарная маркировка кабелей» — перечисление без шаблона и шкалы: значение — текст, не число
    s = ParamSpec(code="M-109", anchors=["Пожарная маркировка кабелей систем ПЗ (СПЗ)"], data_type="enum", compare_kind="equal")
    (e,) = extract(doc("Пожарная маркировка кабелей систем ПЗ (СПЗ) нг(А)-FRLS"), [s])
    assert e.raw == "нг(А)-FRLS"


@pytest.mark.l6_adversarial
def test_fuzzy_anchor_end_does_not_leak_label_digits_into_value():
    # на скане подпись прочитана с опечаткой; в подписи есть цифры «Т1, Т2» — значение берётся после подписи
    s = ParamSpec(code="M-076", anchors=["Диаметры магистралей и стояков отопления (Т1, Т2)"], data_type="number")
    (e,) = extract(doc("| Диаметры магистралеи и стояков отоплення (Т1, Т2) мм 125", source="ocr"), [s])
    assert (e.raw, e.value_num) == ("125", 125.0)


@pytest.mark.l6_adversarial
def test_fuzzy_anchor_string_value_excludes_label_remnant():
    s = ParamSpec(code="M-091", anchors=["Методы и технологическая последовательность демонтажа"], data_type="string", compare_kind="equal")
    (e,) = extract(doc("| Методы и технологическая последоватeльность демонтажа вариант А", source="ocr"), [s])
    assert e.raw == "вариант А"


@pytest.mark.l6_adversarial
def test_scan_speck_before_string_value_is_stripped():
    s = ParamSpec(code="M-091", anchors=["Методы и технологическая последовательность демонтажа"], data_type="string", compare_kind="equal")
    (e,) = extract(doc("Методы и технологическая последовательность демонтажа . исполнение 1", source="ocr"), [s])
    assert e.raw == "исполнение 1"


@pytest.mark.l3_boundary
def test_ocr_threshold_lower_than_text_layer():
    # «Этажностъ» (OCR: «ъ» вместо «ь») — сходство между 82 и 90: на скане берётся, в текстовом слое — нет
    s = ParamSpec(code="M-007", anchors=["Этажность здания"], data_type="number")
    line = "Этажностъ зданйя эт. 12"
    assert [e.raw for e in extract(doc(line, source="ocr"), [s])] == ["12"]
    assert extract(doc(line), [s]) == []


@pytest.mark.l1_functional
def test_class_regex_case_insensitive_and_first_anchor_occurrence():
    concrete = ParamSpec(code="M-055", anchors=["Класс бетона"], data_type="enum", regex_pattern=r"B\s?\d{1,2}(?:[.,]5)?")
    (e,) = extract(doc("Класс бетона b30"), [concrete])  # строчная латиница — класс всё равно найден
    assert e.raw == "b30"
    floors = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    (e,) = extract(doc("Этажность эт. 12 (Этажность подземная 2)"), [floors])
    assert e.raw == "12"  # после первого вхождения якоря, не последнего


@pytest.mark.l1_functional
def test_string_value_bbox_is_the_value_words_only():
    s = ParamSpec(code="M-016", anchors=["Тип фундамента"], data_type="string", compare_kind="equal")
    d = doc("Тип фундамента : по типовому решению")
    (e,) = extract(d, [s])
    words = d.pages[0].lines[0].words
    assert e.raw == "по типовому решению"
    assert e.bbox == (words[3].bbox[0], words[3].bbox[1], words[5].bbox[2], words[5].bbox[3])
    assert e.anchor_bbox[0] == words[0].bbox[0] and e.anchor_bbox[2] <= words[2].bbox[2]


@pytest.mark.l3_boundary
def test_anchor_score_edges():
    from inspector_ml.extract import anchor_score

    assert anchor_score("", "текст") == 0.0 and anchor_score("якорь", "") == 0.0
    assert anchor_score("Этажность", "Этажность эт. 12") == 100.0
    assert anchor_score("Этажность", "совсем другое") < 90


@pytest.mark.l6_adversarial
def test_short_ocr_noise_line_does_not_match_every_anchor():
    # корпус: короткая строка-соринка OCR («о», «2», «по») целиком входит в любой якорь — partial_ratio давал 100
    from inspector_ml.extract import anchor_score

    for noise in ("о", "по", "2", "м 11,66", "Т1 2"):
        assert anchor_score("Итоговая стоимость по ССР", noise) < 82, noise
    floors = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    area = ParamSpec(code="M-132", anchors=["Итоговая стоимость по ССР"], data_type="number")
    got = {e.code: e.raw for e in extract(doc("Т1 2", "Этажность эт. 12", source="ocr"), [floors, area])}
    assert got == {"M-007": "12"}  # строка «Т1 2» не стала стоимостью по ССР
