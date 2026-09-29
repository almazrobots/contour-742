"""OS-INSP-2.2.62 (T-175, CMP-08, CMP-11): состав по типам — квартирография М-011. Экстрактор composition_mentions
находит тип (студия, 1к…4к) и целое количество рядом; площадь типа (дробное число) количеством не считается.

Только синтетические строки (ADR-0002).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.composition_mentions import (
    extract_composition_mentions,
    is_composition_mentions,
)
from inspector_ml.model import ParamSpec
from tests.test_quantity_mentions import mk_doc

ROOT = Path(__file__).resolve().parents[2]
# паспорт — черновик (draft/, загрузчик не видит): P на HOLDOUT-2 ниже порога включения (T-175, решение 5e)
PP = json.loads((ROOT / "data/seed/passports/draft/M-011.json").read_text("utf-8"))

pytestmark = [pytest.mark.l1_functional, pytest.mark.l6_adversarial]


def spec() -> ParamSpec:
    return ParamSpec(
        code="M-011", anchors=[PP["title"]], data_type="text", extractor=PP["extractor"]
    )


def found(*lines: str) -> list[tuple[str | None, float | None]]:
    return [
        (e.value_text, e.value_num)
        for e in extract_composition_mentions(mk_doc(list(lines)), spec())
        if not e.meta["excluded"]
    ]


def test_type_then_count_in_text():
    assert found("Однокомнатные квартиры — 40 шт.") == [("1к", 40.0)]
    assert found("Квартиры-студии: 36") == [("студия", 36.0)]
    assert found("3-комнатных квартир — 24") == [("3к", 24.0)]


def test_count_then_type():
    assert found("40 однокомнатных квартир, 80 двухкомнатных") == [
        ("1к", 40.0),
        ("2к", 80.0),
    ]


def test_table_row_with_several_types():
    assert found("1-комнатные 40 2-комнатные 80 3-комнатные 40") == [
        ("1к", 40.0),
        ("2к", 80.0),
        ("3к", 40.0),
    ]


def test_area_of_type_is_not_count():
    assert found("Площадь однокомнатной квартиры — 38,5 м2") == []
    assert found("Однокомнатные квартиры площадью 38,5 м2") == []


def test_mention_has_type_quote_bbox_and_source():
    [e] = extract_composition_mentions(
        mk_doc(["Двухкомнатные квартиры — 80 шт."]), spec()
    )
    assert e.code == "M-011" and e.value_text == "2к" and e.value_num == 80
    assert e.bbox is not None and e.anchor_bbox is not None and e.page == 1
    assert (
        e.meta["type"] == "2к"
        and e.meta["count_source"] == "text"
        and "80" in e.meta["quote"]
    )


def test_routing():
    assert is_composition_mentions(spec())
    assert not is_composition_mentions(
        ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    )


def test_table_type_area_count_row_skips_area():
    assert found("Тип | Площадь, м2 | Кол-во", "1-комнатные | 55.9 | 55", "2-комнатные | 62,9 | 150") == [("1к", 55.0), ("2к", 150.0)]


def test_slash_header_and_numbers_next_line():
    assert found("Квартирография (Ст/1-комн./2-комн.):", "155 / 111 / 83 шт.") == [("студия", 155.0), ("1к", 111.0), ("2к", 83.0)]


def test_column_type_then_number_next_line():
    assert found("1-комнатные", "159", "2-комнатные", "49") == [("1к", 159.0), ("2к", 49.0)]


def test_percent_share_and_demolished_house_are_not_composition():
    assert found("студии — 10 %", "1-комн. — 28 %") == []
    assert found("В сносимом доме: однокомнатных — 6, двухкомнатных — 13 кв.") == []


def test_st_abbreviation_and_four_plus_subtypes_kept_apart():
    ms = extract_composition_mentions(mk_doc(["Ст — 49 шт., четырехкомнатные: 3 кв., пятикомнатные: 12 кв."]), spec())
    assert [(e.value_text, e.value_num, e.meta["sub"]) for e in ms if not e.meta["excluded"]] == [("студия", 49.0, ""), ("4к+", 3.0, "4"), ("4к+", 12.0, "5")]


def test_euro_2e_is_own_type_not_2k():
    # «2Е» (евро) — отдельный тип E2 до решения владельца (T-175): ни 1к, ни 2к
    assert found("2Е — 40 шт., 2-комнатные — 80 шт.") == [("E2", 40.0), ("2к", 80.0)]
    assert found("Евродвушки — 12") == [("E2", 12.0)]


def test_t187_heading_above_types_says_whose_composition():
    assert found("Площади квартир по типам, м²", "однокомнатные — 1 505,1", "двухкомнатные — 3 269,4") == []
    assert found("Типовой этаж (2–19-й)", "На этаже: 1-комн. — 1, 2-комн. — 1, 3-комн. — 1.") == []
    assert found("Секция 3. Экспликация квартир (для данной секции)", "1-комн. — 27; 2-комн. — 12; 3-комн. — 10") == []
    assert found("Расселяемый жилой фонд (дом под снос)", "1-комн. — 2, 2-комн. — 10, 3-комн. — 1.") == []
    assert found("Встроенные помещения 1-го этажа", "Офис 1 — 2 комнаты, 85,7 м²; офис 2 — 3 комнаты;") == []
    # название объекта с «нежилыми помещениями» и строка-показатель с площадью — не заголовок над составом
    assert found(
        "Многоэтажный жилой дом со встроенными нежилыми помещениями", "Общая площадь здания  13356,3  кв. м", "студии: 148 кв."
    ) == [("студия", 148.0)]


def test_t187_horizontal_table_and_total_column():
    assert found(
        "Показатель | Студ. | 1-к | 2-к | 3-к | 4-к | Всего", "Количество, шт. | 9 | 33 | 61 | 23 | 1 | 127"
    ) == [("студия", 9.0), ("1к", 33.0), ("2к", 61.0), ("3к", 23.0), ("4к+", 1.0)]
    assert found("Тип | Секция 1 | Секция 2 | Всего по дому", "1-комн. | 93 | 50 | 143", "2-комн. | 37 | 46 | 83") == [
        ("1к", 143.0),
        ("2к", 83.0),
    ]


def test_t187_nested_studios_subtracted_and_six_rooms_in_four_plus():
    assert found("однокомнатные — 42 (в том числе студии — 5);") == [("1к", 37.0), ("студия", 5.0)]
    ms = extract_composition_mentions(mk_doc(["4-комн. — 3; 5-комн. — 3; 6-комн. (пентхаус) — 2."]), spec())
    assert [(e.value_text, e.value_num, e.meta["sub"]) for e in ms] == [("4к+", 3.0, "4"), ("4к+", 3.0, "5"), ("4к+", 2.0, "6")]


def test_t187_euro_in_parentheses_is_explanation_not_second_type():
    assert found("2Е (двухкомнатные евро) — 44 шт.") == [("E2", 44.0)]
