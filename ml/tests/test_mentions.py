"""T-178 L3: общий интерфейс упоминания — ENT-15 (строки ТЭП через L2) и ENT-16 (характеристики из текста),
адаптеры class_mentions / quantity_mentions. Только синтетика (ADR-0002)."""

from __future__ import annotations

import pytest

from inspector_ml import mentions as M
from inspector_ml import table_reader as R
from inspector_ml.model import Extraction, Line, Page, ParsedDoc, Word

from test_table_reader import TEP, mk


def text_doc(*texts: str, source="text") -> ParsedDoc:
    pages = []
    for n, text in enumerate(texts, 1):
        lines = []
        for i, ln in enumerate(text.split("\n")):
            ws, x = [], 0.05
            for part in ln.split():
                ws.append(
                    Word(
                        text=part,
                        bbox=(
                            round(x, 4),
                            0.1 + i * 0.02,
                            round(x + 0.01 * len(part), 4),
                            0.115 + i * 0.02,
                        ),
                    )
                )
                x += 0.01 * len(part) + 0.005
            lines.append(Line(text=" ".join(ln.split()), words=ws))
        pages.append(Page(page=n, width=595, height=842, source=source, lines=lines))
    return ParsedDoc(sha256="0" * 64, kind="pdf", pages=pages, engine="t")


# ─────────────────────────────── ENT-15


@pytest.mark.l1_functional
def test_tep_mentions_keys_values_units_and_parent_qualifier():
    ms = M.tep_mentions(R.read_table(mk(TEP)))
    got = [(m.key, m.value_num, m.unit) for m in ms]
    assert got == [
        ("building_area", 1234.5, "м²"),
        ("total_area", 12345.6, "м²"),
        ("construction_volume", 45000, "м³"),
        ("construction_volume_above", 40000, "м³"),
        ("construction_volume_below", 5000, "м³"),
        ("floors", 9, "эт"),
    ]  # «Класс энергоэффективности B+» — не число, упоминания ENT-15 нет
    m = ms[0]
    assert (m.entity, m.source, m.method, m.column, m.page, m.confidence) == (
        "ENT-15",
        "table",
        "table_reader",
        "Значение",
        1,
        1.0,
    )
    assert (
        m.quote == "1 | Площадь застройки | м² | 1 234,5"
        and m.bbox is not None
        and m.anchor_bbox is not None
    )
    assert m.excluded is None


@pytest.mark.parametrize(
    "name, key",
    [
        ("Пятно застройки", "building_area"),
        ("Площадь застройки здания", "building_area"),
        ("Общая площадь квартир", "apartments_area"),
        ("Общая площадь", "total_area"),
        ("Строительный объём", "construction_volume"),
        ("Количество машино-мест", "parking"),
        ("Коэффициент использования территории", "kit"),
        ("Процент застройки", "kz"),
        ("Расчетная электрическая мощность", "power"),
        ("Высота этажа", "height"),
        ("Благоустройство", None),
    ],
)
@pytest.mark.l1_functional
def test_match_key_synonyms_most_specific(name, key):
    assert M.match_key(name)[0] == key


@pytest.mark.l3_boundary
def test_tep_unknown_row_unit_mismatch_and_text_strategy_confidence():
    t = mk(
        [
            ["Наименование показателя", "Ед. изм.", "Значение"],
            ["Площадь застройки", "м³", "10"],
            ["Благоустройство", "", "5"],
        ],
        strategy="text",
    )
    a, b = M.tep_mentions(R.read_table(t))
    assert (a.key, a.excluded, a.confidence) == ("building_area", "unit_mismatch", 0.7)
    assert "единица" in a.excluded_why
    assert (b.key, b.excluded, b.unit, b.confidence) == (
        None,
        None,
        None,
        round(0.7 * 0.5 * 0.8, 3),
    )
    assert (
        M._unit_mismatch("capacity", "шт", M.TEP_LEXICON) is False
    )  # у вместимости единицы не заданы
    assert (
        M._unit_mismatch("x", "м", M.TEP_LEXICON) is False
        and M._unit_mismatch(None, "м", M.TEP_LEXICON) is False
    )


@pytest.mark.l3_boundary
def test_tep_range_value_and_subrow_with_own_key():
    t = mk(
        [
            ["Наименование", "Ед. изм.", "Значение"],
            ["Высота здания", "м", "30-32"],
            ["в т.ч. площадь застройки", "м²", "7"],
        ]
    )
    a, b = M.tep_mentions(R.read_table(t))
    assert a.value_range == (30, 32) and a.value_num is None and a.key == "height"
    assert b.key == "building_area"


# ─────────────────────────────── ENT-16


@pytest.mark.parametrize(
    "text, key, value",
    [
        ("Бетон класса B25 W6 F150.", "concrete_class", "B25"),
        ("Класс бетона по прочности на сжатие В30", "concrete_class", "B30"),
        ("Арматура класса А500С по ГОСТ 34028", "rebar_class", "A500C"),
        ("класс рабочей арматуры A240", "rebar_class", "A240"),
        ("Сталь марки С245", "steel_grade", "C245"),
        ("марка стали C355-1", "steel_grade", "C3551"),
        ("Степень огнестойкости здания — II", "fire_resistance", "II"),
        ("Здание II степени огнестойкости", "fire_resistance", "II"),
        ("Класс конструктивной пожарной опасности С0", "kpo_class", "С0"),
        ("Класс энергетической эффективности здания — В+", "energy_class", "B+"),
        (
            "Потребители относятся ко II категории надежности электроснабжения",
            "reliability_category",
            "II",
        ),
        ("Категория надежности электроснабжения — 1", "reliability_category", "I"),
    ],
)
@pytest.mark.l1_functional
def test_text_mentions_class_values(text, key, value):
    ms = [m for m in M.text_mentions(text_doc(text)) if m.key == key]
    assert len(ms) == 1
    m = ms[0]
    assert (m.value_text, m.entity, m.source, m.method, m.excluded) == (
        value,
        "ENT-16",
        "text",
        "regex",
        None,
    )
    assert (
        m.bbox is not None
        and m.anchor_bbox is not None
        and m.quote.startswith(m.name[:3]) or m.quote.endswith(m.name[-3:])
    )


@pytest.mark.l1_functional
def test_zero_mark_and_design_power_numbers():
    d = text_doc(
        "За относительную отметку 0,000 принята абсолютная отметка 152,35. Расчетная мощность — 1 250 кВт."
    )
    by = {m.key: m for m in M.text_mentions(d)}
    assert (by["zero_mark"].value_num, by["zero_mark"].unit) == (152.35, "м")
    assert (by["design_power"].value_num, by["design_power"].unit) == (1250, "квт")
    d = text_doc(
        "Отметка 0.000 соответствует абсолютной отметке 98.500; расчетная электрическая нагрузка 2,5 МВт"
    )
    by = {m.key: m for m in M.text_mentions(d)}
    assert by["zero_mark"].value_num == 98.5 and (
        by["design_power"].value_num,
        by["design_power"].unit,
    ) == (2.5, "мвт")


@pytest.mark.l1_functional
def test_qualifiers_and_exclusions():
    ms = M.text_mentions(
        text_doc("Бетон класса не ниже B25. Класс бетона не более В40")
    )
    assert [(m.value_text, m.qualifier) for m in ms] == [("B25", "min"), ("B40", "max")]
    ms = M.text_mentions(
        text_doc(
            "Существующий корпус: бетон класса B15. Новый корпус: бетон класса B30"
        )
    )
    assert [(m.value_text, m.excluded) for m in ms] == [
        ("B15", "existing"),
        ("B30", None),
    ]
    ms = M.text_mentions(text_doc("По СП 63 допускается бетон класса B20"))
    assert ms[0].excluded == "norm" and "нормативное" in ms[0].excluded_why


@pytest.mark.l3_boundary
def test_value_in_next_sentence_or_far_is_not_taken():
    assert M.text_mentions(text_doc("Бетон класса. B25 в другом месте")) == []
    assert M.text_mentions(text_doc("Степень огнестойкости " + "x " * 40 + "II")) == []
    assert M.text_mentions(text_doc("Класс энергетической эффективности высокий")) == []


@pytest.mark.l3_boundary
def test_ocr_page_confidence_and_custom_patterns():
    ms = M.text_mentions(text_doc("Степень огнестойкости III", source="ocr"))
    assert ms[0].confidence == 0.8 and ms[0].value_text == "III"
    ms = M.text_mentions(
        text_doc("Шифр ПД-12"), patterns={"code": (r"шифр", r"ПД-\d+")}
    )
    assert ms[0].value_text == "ПД-12" and ms[0].key == "code"


@pytest.mark.l3_boundary
def test_value_before_anchor_needs_adjacency():
    assert M.text_mentions(text_doc("II этаж, а степени огнестойкости нет")) == []
    ms = M.text_mentions(text_doc("здание III-й степени огнестойкости"))
    assert ms[0].value_text == "III"


# ─────────────────────────────── адаптеры


@pytest.mark.l1_functional
def test_from_extraction_keeps_exclusion_and_to_extraction_roundtrip():
    e = Extraction(
        code="M-023",
        raw="С1",
        value_text="С1",
        page=3,
        bbox=(0.1, 0.1, 0.2, 0.2),
        anchor_bbox=(0, 0.1, 0.1, 0.2),
        line_text="класс С1",
        confidence=0.9,
        meta={
            "quote": "класс конструктивной пожарной опасности С1",
            "qualifier": "min",
            "excluded": "neighbor",
            "excluded_why": "соседнее здание",
        },
    )
    m = M.from_extraction(e, "ENT-16", key="kpo_class")
    assert (
        m.entity,
        m.key,
        m.value_text,
        m.qualifier,
        m.excluded,
        m.excluded_why,
        m.param_code,
        m.method,
        m.source,
    ) == (
        "ENT-16",
        "kpo_class",
        "С1",
        "min",
        "neighbor",
        "соседнее здание",
        "M-023",
        "class_mentions",
        "text",
    )
    assert m.quote.startswith("класс конструктивной")
    q = M.from_extraction(
        Extraction(
            code="M-001",
            raw="10",
            value_num=10,
            page=1,
            bbox=None,
            line_text="Площадь 10",
            confidence=1,
            match="table",
        ),
        "ENT-15",
    )
    assert (q.source, q.method, q.quote, q.excluded) == (
        "table",
        "quantity_mentions",
        "Площадь 10",
        None,
    )
    back = M.to_extraction(m, "M-023")
    assert (back.code, back.raw, back.value_text, back.page, back.match) == (
        "M-023",
        "С1",
        "С1",
        3,
        "lexical",
    )
    assert (
        back.meta["excluded"] == "neighbor"
        and back.meta["entity"] == "ENT-16"
        and back.meta["ops"] == ["ENT-16"]
    )
    t = M.to_extraction(M.tep_mentions(R.read_table(mk(TEP)))[0], "M-001")
    assert (t.raw, t.value_num, t.match, t.meta["ops"], t.meta["unit"]) == (
        "1234.5",
        1234.5,
        "table",
        ["ENT-15", "NRM-06"],
        "м²",
    )
    empty = M.to_extraction(
        q.model_copy(update={"value_num": None, "value_text": None}), "M-001"
    )
    assert empty.raw == ""
