"""OS-INSP-2.2.60, 2.2.61 (T-175, CMP-07): упоминания счётных параметров по паспорту — М-007 этажность, М-010 количество
квартир. Извлечение — общий экстрактор quantity_mentions; целое число и источник подсчёта проверяет API (count-param.ts).

Только синтетические строки (ADR-0002). Ловушки: этажность с подземными этажами и подвалом, предел по норме,
число квартир одного типа (квартирография М-011), колонка таблицы.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.count_mentions import extract_count_mentions, fold, word_number
from tests.test_quantity_mentions import mk_doc

ROOT = Path(__file__).resolve().parents[2]

pytestmark = [pytest.mark.l1_functional, pytest.mark.l6_adversarial]


def passport_path(code: str) -> Path:
    """М-010 — черновик (draft/: загрузчик не видит): на HOLDOUT-2 точность ниже лексического пути main (T-175)."""
    d = ROOT / "data/seed/passports"
    return d / f"{code}.json" if (d / f"{code}.json").exists() else d / "draft" / f"{code}.json"


def spec_of(code: str):
    from inspector_ml.model import ParamSpec

    pp = json.loads(passport_path(code).read_text("utf-8"))
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="number", extractor=pp["extractor"]
    )


def found(code: str, *lines: str) -> list[tuple[float | None, str | None]]:
    return [
        (e.value_num, e.meta["excluded"])
        for e in extract_count_mentions(mk_doc(list(lines)), spec_of(code))
    ]


def test_m007_floors_from_tep_line():
    assert found("M-007", "Этажность — 17 эт.") == [(17.0, None)]
    assert found("M-007", "Количество надземных этажей: 17") == [(17.0, None)]
    assert found("M-007", "Количество этажей 25 этажей") == [(25.0, None)]


def test_m007_underground_and_basement_are_other_indicator():
    for line in (
        "Этажность с учетом подвала — 18",
        "Количество этажей, включая подвал — 18",
        "Количество подземных этажей — 2",
    ):
        assert [x for x in found("M-007", line) if x[1] is None] == [], line


def test_m007_norm_limit_is_not_object_value():
    assert [
        x
        for x in found("M-007", "Этажность не более 25 этажей по ГПЗУ")
        if x[1] is None
    ] == []


def test_m007_fraction_is_passed_on_for_api_to_drop():
    # «16,5» — не количество, но экстрактор общий: целое проверяет API (OS-INSP-2.2.60), здесь число доходит как есть
    assert found("M-007", "Этажность — 16,5") == [(16.5, None)]


def test_m010_total_apartments():
    assert found("M-010", "Количество квартир — 240 шт.") == [(240.0, None)]
    assert found("M-010", "Общее количество квартир: 240") == [(240.0, None)]
    assert found("M-010", "Всего квартир 312") == [(312.0, None)]


def test_m010_one_room_type_is_composition_not_total():
    for line in (
        "Количество квартир однокомнатных — 40",
        "Количество квартир-студий — 36",
        "Количество квартир 2-комнатных — 80",
    ):
        assert [x for x in found("M-010", line) if x[1] is None] == [], line


def test_m010_existing_state_excluded():
    assert found("M-010", "Количество квартир в существующем здании — 60") == [
        (60.0, "EXISTING")
    ]


def test_passports_are_count_kind_with_quantity_extractor():
    for code in ("M-007", "M-010"):
        pp = json.loads(passport_path(code).read_text("utf-8"))
        assert pp["value"]["kind"] == "count"
        assert pp["extractor"]["kind"] == "count_mentions"  # вид из реестра (T-186): в ML — разбор чисел quantity_mentions


def test_existing_right_before_anchor_still_excluded_but_not_from_previous_line():
    # ревью безопасности T-175: сужение EXISTING до «между оборотом и числом» не должно пропускать «существующее здание: этажность»
    assert [x for x in found("M-007", "Существующее здание: этажность — 5 эт.") if x[1] is None] == []
    assert [x for x in found("M-010", "Сносимый дом: количество квартир — 51") if x[1] is None] == []
    # а соседняя строка про существующую застройку проектное значение не глушит
    # T-187: «2-этажные» теперь находится как упоминание, но отсеивается как существующее — в выбор идёт только 27
    assert found("M-007", "Существующая застройка — 2-этажные жилые дома.", "Этажность проектируемого жилого дома — 27 эт.") == [
        (27.0, None),
        (2.0, "EXISTING"),
    ]


def ok(code: str, *lines: str) -> list[float | None]:
    return [v for v, ex in found(code, *lines) if ex is None]


def test_t187_latin_lookalikes_folded_in_russian_words_only():
    assert fold("Этажнocть B25 количecтво") == "Этажность B25 количество"
    assert len(fold("квapтиp")) == len("квapтиp")
    assert ok("M-007", "2 | Этажнocть | эт. | 10") == [10.0]


def test_t187_number_before_word_forms():
    assert ok("M-007", "Здание имеет 12 надземных этажей и подвал для прокладки коммуникаций.") == [12.0]
    assert ok("M-007", "Надземных этажей — 18 (восемнадцать), подземный — 1 (один).") == [18.0]
    assert ok("M-007", "Корп. 3: эт-ть надз. — 20; подз. — 1; техн. чердак.") == [20.0]
    assert ok("M-007", "Здание 20-этажное (+ подвал), высота до парапета 62,1 м,") == [20.0]
    assert ok("M-007", "Проектируемый жилой дом — четырнадцатиэтажный, односекционный.") == [14.0]


def test_t187_word_numbers():
    assert (word_number("одно"), word_number("двадцатидвух"), word_number("тридцати")) == (1, 22, 30)
    assert word_number("много") is None


def test_digit_declension_floor_description_preserves_subject_exclusions():
    assert ok("M-007", "Проектируемая секция 2 — 11-ти этажная.") == [11.0]
    assert ok("M-007", "Проектируемое здание 12-ти-этажное.") == [12.0]
    assert ok("M-007", "Соседний 5-ти этажный дом сохраняется.") == []
    assert ok("M-007", "Существующее 3-ти этажное здание сносится.") == []
    assert ok("M-007", "Секция 11: подземный этаж — 1.") == []


def test_direction_across_driveway_is_neighbor_not_next_project_sentence():
    assert ok('M-007', 'На севере: через проезд расположен 14-ти этажный дом.') == []
    assert ok('M-007', 'С юга: через внутриквартальный проезд расположен 14-ти этажный дом.') == []
    assert ok('M-007', 'На севере участка проектируется 12-ти этажный дом.') == [12.0]
    assert ok('M-007', 'На севере: через проезд расположен 14-ти этажный дом. '
              'Проектируемый объект представляет собой 13-ти этажное здание.') == [13.0]


@pytest.mark.parametrize('header_x, expected', [(0.65, 'EXISTING_HEADER'), (0.05, None)])
def test_floor_table_subject_is_scoped_to_value_column(header_x, expected):
    from inspector_ml.model import Page, Line, Word
    page = Page(page=1, width=600, height=800, source='text', lines=[
        Line(text='Существующий жилой дом', words=[
            Word(text='Существующий жилой дом', bbox=(header_x, .05, header_x+.3, .08))]),
        Line(text='Отметка пола первого этажа 150.25', words=[
            Word(text='Отметка пола первого этажа', bbox=(.1, .12, .4, .14)),
            Word(text='150.25', bbox=(.8, .12, .87, .14))]),
        Line(text='Этажность 5', words=[
            Word(text='Этажность', bbox=(.1, .18, .25, .20)),
            Word(text='5', bbox=(.8, .18, .82, .20))]),
    ])
    values = extract_count_mentions(mk_doc(page), spec_of('M-007'))
    assert len(values) == 1
    assert values[0].value_num == 5
    assert values[0].meta['excluded'] == expected


def test_t187_sentence_excludes_demolished_neighbor_and_old_value():
    assert ok(
        "M-007",
        "На участке расположено одноэтажное нежилое здание склада, подлежащее сносу.",
        "На его месте размещается проектируемый 23-этажный жилой дом.",
    ) == [23.0]
    assert ok("M-007", "Этажность здания изменена: было 12 надземных этажей, стало 11.") == [11.0]
    assert ok("M-007", "Соседние 5-этажные дома сохраняются.") == []


def test_demolition_list_subject_reaches_table_but_not_new_project():
    assert ok("M-007", "Проектом предусмотрен демонтаж следующих объектов:",
              "Жилой дом. Год возведения 1965.",
              "Здание выполнено 5-ти этажным с чердаком.") == []
    assert ok("M-007", "Проектом предусмотрен демонтаж следующих объектов:",
              "Жилой дом. Здание выполнено 5-ти этажным.",
              "Проектируемое здание выполнено 12-ти этажным.") == [12.0]
    assert ok("M-007", "Проект организации сноса согласован.",
              "Здание выполнено 12-ти этажным.") == [12.0]


def test_t187_floors_count_row_yields_to_etazhnost_on_same_page():
    assert ok("M-007", "2 | Этажность | эт. | 17", "3 | Количество этажей | эт. | 19") == [17.0]
    assert ok("M-007", "3 | Количество этажей | эт. | 19") == [19.0]  # одна строка — берётся


def test_t187_apartments_forms_and_subsets():
    assert ok("M-010", "Кол-во квартир, всего | шт. | 259") == [259.0]
    assert ok("M-010", "В жилом доме запроектировано 386 (триста восемьдесят шесть) квартир") == [386.0]
    assert ok("M-010", "Количество жилых помещений (квартир)  124", "Количество нежилых помещений  3") == [124.0]
    assert ok(
        "M-010", "Для инвалидов-колясочников предусмотрено 5 квартир на 1-м этаже", "из общего числа 376 квартир жилого дома."
    ) == [376.0]
    # число следующей строки — чужой показатель, а не значение оборота (same_line)
    assert ok(
        "M-010", "198 — количество квартир (жилая часть),", "9 — количество встроенных нежилых помещений общественного назначения."
    ) == [198.0]
