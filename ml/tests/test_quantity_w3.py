"""OS-INSP-2.2.130–2.2.134 (T-211): извлечение по паспортам М-033 (уклоны дорог и проездов, ‰) и М-048 (ступени: число,
высота подступенка, проступь) — приведение к единице паспорта, отсев чужого контекста, двух колонок, разных значений на
листе, дробного счёта, неправдоподобного значения; нет упоминания — нет значения.

Паспорта берутся как есть из data/seed/passports; строки только синтетические (ADR-0002).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import extract_quantity_mentions

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)


def passport(code: str) -> dict:
    f = ROOT / f"data/seed/passports/{code}.json"
    if not f.exists():  # паспорт без цифр замера — в draft/ (T-233)
        f = ROOT / f"data/seed/passports/draft/{code}.json"
    return json.loads(f.read_text("utf-8"))


def mk_page(n: int, lines: list[str]) -> Page:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(
                        round(x, 5),
                        0.05 + 0.03 * li,
                        round(min(x + w, 1.0), 5),
                        0.07 + 0.03 * li,
                    ),
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return Page(page=n, width=595, height=842, source="text", lines=out)


def run(code: str, *pages: list[str]) -> list:
    doc = ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[mk_page(i + 1, p) for i, p in enumerate(pages)],
    )
    pp = passport(code)
    return extract_quantity_mentions(
        doc,
        ParamSpec(
            code=code, anchors=["x"], data_type="string", extractor=pp["extractor"]
        ),
    )


def vals(ms: list, **flt) -> list:
    return [
        (e.value_num, e.meta["excluded"])
        for e in ms
        if all(e.meta.get(k) == v for k, v in flt.items())
    ]


def one(code: str, line: str):
    ms = run(code, [line])
    assert len(ms) == 1, [(e.value_num, e.meta) for e in ms]
    return ms[0]


# ------------------------------------------------------------------ М-033: уклоны к ‰ (OS-INSP-2.2.130)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "unit"),
    [
        ("Уклон проезда 20‰", "‰"),
        ("Продольный уклон проезда 20 ‰", "‰"),
        ("Уклон 2 %", "%"),
        ("Уклон проезжей части 2%", "%"),
        ("i = 0,020", None),
        ("i=0,020", None),
        ("Уклон по оси проезда 0.02", None),
        ("Уклон 20 промилле", "промилле"),
    ],
)
def test_m033_slope_forms_become_permille(line: str, unit: str | None):
    e = one("M-033", line)
    assert (e.value_num, e.meta["excluded"], e.meta["unit"]) == (20.0, None, unit)


@pytest.mark.l1_functional
def test_m033_kind_of_slope_is_variant_and_both_kept_on_one_sheet():
    ms = run("M-033", ["Продольный уклон 20‰, поперечный уклон 15‰"])
    assert [(e.value_num, e.meta["variant"], e.meta["excluded"]) for e in ms] == [
        (20.0, "long", None),
        (15.0, "cross", None),
    ]


@pytest.mark.l3_boundary
def test_m033_unitless_fraction_only_up_to_0_2():
    assert vals(run("M-033", ["Уклон проезда 0,2"])) == [(200.0, None)]
    # целое без единицы — ‰ или %? не угадывается (OS-INSP-2.2.131)
    assert vals(run("M-033", ["Уклон проезда 5"])) == [(5.0, "NO_UNIT")]
    assert vals(run("M-033", ["Уклон проезда 0,5"])) == [(0.5, "NO_UNIT")]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    ("line", "code"),
    [
        ("Существующий уклон проезда 15‰", "EXISTING"),
        ("Уклон естественного рельефа 12‰", "EXISTING"),
        ("Уклон кровли 2 %", "OTHER_OBJECT"),
        ("Канализация К1 Ø200 L=45,0 i=0,005", "OTHER_OBJECT"),
        ("Уклон тротуара 15‰", "OTHER_OBJECT"),
        ("Уклон пандуса 50‰", "OTHER_OBJECT"),
        ("Участок ПК0+00 уклон 25‰", "PICKET"),
        ("Наибольший продольный уклон 80‰", "NORM_TEXT"),
        ("Было: уклон 20‰", "CHANGE_NOTE"),
        ("Прод. уклон: было 20‰", "CHANGE_NOTE"),
    ],
)
def test_m033_foreign_context_is_dropped_with_reason(line: str, code: str):
    ms = run("M-033", [line])
    assert [e.meta["excluded"] for e in ms] == [code]
    assert all(e.meta["excluded_why"] for e in ms)


@pytest.mark.l6_adversarial
def test_m033_two_columns_are_dropped_not_guessed():
    # малое целое за значением уклона — второе значение, а не номер строки таблицы (row_numbers: false)
    assert vals(run("M-033", ["Уклон 20 ‰ 15 ‰"])) == [(20.0, "MULTI_VALUE")]
    assert vals(run("M-033", ["Уклон проезда 20 15"])) == [(20.0, "MULTI_VALUE")]


@pytest.mark.l6_adversarial
def test_m033_different_slopes_on_one_sheet_all_dropped_same_value_kept():
    ms = run("M-033", ["Уклон проезда 20‰", "Уклон проезда 30‰"], ["Уклон проезда 25‰"])
    assert [(e.page, e.value_num, e.meta["excluded"]) for e in ms] == [
        (1, 20.0, "MULTI_VALUE"),
        (1, 30.0, "MULTI_VALUE"),
        (2, 25.0, None),
    ]
    assert "несколько разных значений" in ms[0].meta["excluded_why"]
    same = run("M-033", ["Уклон проезда 20‰", "Уклон проезда 20 ‰"])
    assert vals(same) == [(20.0, None), (20.0, None)]


@pytest.mark.l6_adversarial
def test_m033_excluded_mention_does_not_make_sheet_multi():
    ms = run("M-033", ["Существующий уклон 15‰.", "Проектный уклон проезда 20‰"])
    assert vals(ms) == [(15.0, "EXISTING"), (20.0, None)]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "line",
    [
        "Уклоны дорог и проездов приняты не более 80 ‰",
        "Уклоны дорог и проездов",
        "План организации рельефа. Вертикальная планировка проездов.",
        "Уклон принимается согласно СП 42.13330",
    ],
)
def test_m033_no_value_no_mention(line: str):
    # OS-INSP-2.2.134: оборот без значения, норма «не более» — упоминания нет, у стадии нет значения
    assert run("M-033", [line]) == []


# ------------------------------------------------------------------ М-048: ступени (OS-INSP-2.2.132)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "value"),
    [
        ("Количество ступеней в марше — 12", 12.0),
        ("Число подъёмов 12 шт.", 12.0),
        ("Количество ступеней: 12", 12.0),
    ],
)
def test_m048_step_count(line: str, value: float):
    e = one("M-048", line)
    assert (e.value_num, e.meta["aspect"], e.meta["excluded"]) == (value, None, None)


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "aspect", "value", "unit"),
    [
        ("Высота подступенка 150 мм", "riser", 150.0, "мм"),
        ("Высота ступени 15 см", "riser", 150.0, "см"),
        ("Высота ступени 0,15 м", "riser", 150.0, "м"),
        ("Подступенок 0,165", "riser", 165.0, None),
        ("Высота подъёма ступени 170", "riser", 170.0, None),
        ("Ширина проступи 300 мм", "tread", 300.0, "мм"),
        ("Проступь 30 см", "tread", 300.0, "см"),
        ("Глубина ступени 280 мм", "tread", 280.0, "мм"),
    ],
)
def test_m048_riser_and_tread_are_aspects_in_mm(line, aspect, value, unit):
    e = one("M-048", line)
    assert (e.meta["aspect"], e.value_num, e.meta["unit"], e.meta["excluded"]) == (
        aspect,
        value,
        unit,
        None,
    )


@pytest.mark.l3_boundary
def test_m048_count_integer_and_size_not_integer_rule():
    assert vals(run("M-048", ["Количество ступеней 12,5"])) == [(12.5, "NOT_INTEGER")]
    assert vals(run("M-048", ["Количество ступеней 12,0"])) == [(12.0, None)]
    # размер ступени дробным быть может: счёт у аспекта не наследуется
    assert vals(run("M-048", ["Высота подступенка 157,5 мм"])) == [(157.5, None)]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    ("line", "code"),
    [
        ("Проступь 30", "IMPLAUSIBLE"),
        ("Высота ступени 1500 мм", "IMPLAUSIBLE"),
        ("Количество ступеней 0", "IMPLAUSIBLE"),
        ("Пожарная лестница: количество ступеней 20", "LADDER"),
        ("Стремянка, количество ступеней 8", "LADDER"),
        ("Максимальная высота ступени 150 мм", "NORM_TEXT"),
        ("Минимальная ширина проступи 300 мм", "NORM_TEXT"),
        ("Существующая лестница: количество ступеней 14", "EXISTING"),
    ],
)
def test_m048_foreign_or_implausible_is_dropped(line: str, code: str):
    ms = run("M-048", [line])
    assert [e.meta["excluded"] for e in ms] == [code]


@pytest.mark.l6_adversarial
def test_m048_two_flights_on_sheet_and_two_columns_dropped():
    ms = run(
        "M-048",
        ["Марш 1: количество ступеней 12", "Марш 2: количество ступеней 10"],
    )
    assert vals(ms) == [(12.0, "MULTI_VALUE"), (10.0, "MULTI_VALUE")]
    assert vals(run("M-048", ["Количество ступеней 12 10"])) == [(12.0, "MULTI_VALUE")]


@pytest.mark.l1_functional
def test_m048_count_riser_tread_on_one_sheet_are_separate_groups():
    ms = run(
        "M-048",
        [
            "Количество ступеней в марше 12",
            "Высота подступенка 150 мм",
            "Ширина проступи 300 мм",
        ],
    )
    assert sorted(
        (e.meta["aspect"] or "", e.value_num, e.meta["excluded"]) for e in ms
    ) == [
        ("", 12.0, None),
        ("riser", 150.0, None),
        ("tread", 300.0, None),
    ]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(
    "line",
    [
        "Высота подступенка не более 150 мм",
        "Количество ступеней в марше должно быть не менее 3",
        "Лестница Л1. Марши сборные железобетонные.",
        "Количество и параметры лестничных маршей и ступеней",
    ],
)
def test_m048_no_value_no_mention(line: str):
    assert run("M-048", [line]) == []


# ------------------------------------------------------------------ М-048: число перед словом «ступеней», пара «150×300»


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "value"),
    [
        ("3 марша по 12 ступеней", 12.0),
        ("Лестница Л1: 12 ступеней, марши сборные", 12.0),
        ("В марше 16 подъёмов", 16.0),
        ("Марш из 12ступеней", 12.0),
    ],
)
def test_m048_count_before_word(line: str, value: float):
    ms = run("M-048", [line])
    assert vals(ms, aspect=None) == [(value, None)]


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    ("line", "code"),
    [
        ("См. п. 12 ступени лестниц", "ITEM_NUMBER"),
        ("Таблица 3 ступени и площадки", "ITEM_NUMBER"),
        ("В марше не более 18 ступеней", "NORM_TEXT"),
        ("Марш — от 3 до 18 ступеней", "NORM_TEXT"),
    ],
)
def test_m048_count_before_word_refusals(line: str, code: str):
    ms = run("M-048", [line])
    assert [e.meta["excluded"] for e in ms if e.meta["aspect"] is None][-1:] == [code]
    assert all(e.meta["excluded"] for e in ms)


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "line",
    [
        "12 ступеней по СП 1.13130",
        "Фильтр — 2 ступени очистки",
        "Регулятор давления, 2 ступени регулирования",
        "Лист 12, ступени 3",
    ],
)
def test_m048_other_meaning_of_steps_no_count(line: str):
    assert vals(run("M-048", [line]), aspect=None) == []


@pytest.mark.l1_functional
@pytest.mark.parametrize("sep", ["×", "*"])
def test_m048_riser_by_tread_pair(sep: str):
    ms = run("M-048", [f"12 ступеней 150{sep}300, ступень 160{sep}290"])
    got = sorted((e.meta["aspect"] or "", e.value_num, e.meta["excluded"]) for e in ms)
    # на одном листе две пары — разные значения подступенка и проступи: отсев, а не выбор
    assert got == [
        ("", 12.0, None),
        ("riser", 150.0, "MULTI_VALUE"),
        ("riser", 160.0, "MULTI_VALUE"),
        ("tread", 290.0, "MULTI_VALUE"),
        ("tread", 300.0, "MULTI_VALUE"),
    ]
    one_pair = run("M-048", [f"Ступень 150{sep}300"])
    assert sorted((e.meta["aspect"], e.value_num, e.meta["excluded"]) for e in one_pair) == [
        ("riser", 150.0, None),
        ("tread", 300.0, None),
    ]


# ------------------------------------------------------------------ настройка на dev (T-211): формы записи, таблицы, объекты


def rows(ms: list) -> list:
    return [
        (e.meta.get("aspect"), e.value_num, e.meta.get("variant"), e.meta["excluded"], e.meta.get("object"))
        for e in ms
    ]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "value", "variant"),
    [
        ("Съезд: прод. укл. 18‰.", 18.0, "long"),
        ("Попер. уклон покрытия 15 ‰", 15.0, "cross"),
        # число перед подписью: вид уклона стоит за следующим оборотом — вариант не определяется (сравнение условное)
        ("Проезд А: 18 промилле — продольный уклон дороги", 18.0, None),
        ("Продольный ук- лон проезда 18 ‰", 18.0, "long"),
        ("Уклон проезда: 18 ‰", 18.0, None),
    ],
)
def test_m033_abbreviations_hyphen_value_before_and_label_colon(line, value, variant):
    e = one("M-033", line)
    assert (e.value_num, e.meta["variant"], e.meta["excluded"]) == (value, variant, None)


@pytest.mark.l1_functional
def test_m033_second_kind_without_word_slope_after_comma():
    ms = run("M-033", ["Продольный уклон дороги принят 18‰, поперечный — 25‰. 4. Бортовой камень"])
    assert [(e.value_num, e.meta["variant"], e.meta["excluded"]) for e in ms] == [
        (18.0, "long", None),
        (25.0, "cross", None),
    ]


@pytest.mark.l6_adversarial
def test_m033_bare_kind_word_needs_number_right_after():
    # «продольный профиль» — не уклон; «поперечный — 25» без единицы — отсев, а не 25 ‰
    assert run("M-033", ["Продольный профиль дороги ДР-2 лист 5"]) == []
    assert vals(run("M-033", ["поперечный — 25"])) == [(25.0, "NO_UNIT")]


@pytest.mark.l1_functional
def test_m033_ocr_split_digits_before_unit():
    assert vals(run("M-033", ["Прод. уклон 3 5 ‰"])) == [(35.0, None)]
    # разрыв без единицы вплотную — не склеивается: два числа подряд
    assert vals(run("M-033", ["Прод. уклон 3 5 шт"])) == [(3.0, "MULTI_VALUE")]


@pytest.mark.l1_functional
def test_m033_mark_of_object_is_skipped_and_kept_as_object():
    (e,) = run("M-033", ["Продольный уклон дороги Д-4 — 35‰"])
    assert (e.value_num, e.meta["object"], e.meta["excluded"]) == (35.0, "д-4", None)
    (f,) = run("M-033", ["Д-4: прод. уклон 35‰."])
    assert f.meta["object"] == "д-4"
    # марка прошлой фразы — не объект этой
    ms = run("M-033", ["Дорога Д-4 асфальтобетонная. Продольный уклон 35‰"])
    assert [e.meta["object"] for e in ms] == [None]


@pytest.mark.l1_functional
def test_m033_pipe_table_column_unit_in_header_object_is_row_label():
    ms = run(
        "M-033",
        [
            "Ведомость дорог",
            "№ | Дорога | Длина, м | Прод. уклон, ‰ | Попер. уклон, %",
            "1 | Дорога вдоль корпуса | 120 | 18 | 2",
            "2 | Дорога к КПП | 40 | 22 | 2",
            "Итого: 160 м",
        ],
    )
    assert sorted(rows(ms), key=str) == sorted(
        [
            (None, 18.0, "long", None, "дорога вдоль корпуса"),
            (None, 22.0, "long", None, "дорога к кпп"),
            (None, 20.0, "cross", None, "дорога вдоль корпуса"),
            (None, 20.0, "cross", None, "дорога к кпп"),
        ],
        key=str,
    )


@pytest.mark.l6_adversarial
def test_m033_pipe_table_foreign_row_and_non_number_cell_dropped():
    ms = run(
        "M-033",
        [
            "Покрытие | Уклон",
            "Асфальтобетон дороги | 18‰",
            "Плитка тротуара | 12‰",
            "Газон | по рельефу",
        ],
    )
    assert rows(ms) == [
        (None, 18.0, None, None, "асфальтобетон дороги"),
        (None, 12.0, None, "OTHER_OBJECT", "плитка тротуара"),
    ]


@pytest.mark.l3_boundary
def test_pipe_row_with_number_is_not_header():
    # «Число ступеней | шт. | 12» — строка значения: читается подписью, а не шапкой колонки
    ms = run("M-048", ["Показатель | Ед. | Значение", "Число ступеней | шт. | 12", "Высота подступенка | мм | 160"])
    assert sorted((e.meta["aspect"] or "", e.value_num, e.meta["excluded"]) for e in ms) == [("", 12.0, None), ("riser", 160.0, None)]


@pytest.mark.l1_functional
def test_m048_pipe_table_spec_columns():
    ms = run("M-048", ["Марка | Кол-во ступ. | Подступенок, мм | Проступь, см", "ЛМ-3 | 11 | 160 | 29"])
    assert sorted(rows(ms), key=str) == sorted(
        [(None, 11.0, None, None, "лм-3"), ("riser", 160.0, None, None, "лм-3"), ("tread", 290.0, None, None, "лм-3")], key=str
    )


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    ("line", "count"),
    [
        ("Марш ЛМ-3: 11 ступ.", 11.0),
        ("Кол-во подъёмов — 14", 14.0),
        ("Ступени по 160 мм, 11 шт. в марше", 11.0),
        ("В марше одиннадцать ступеней", 11.0),
        ("ЛМ-3  1О ступ.", 10.0),
    ],
)
def test_m048_count_forms(line, count):
    assert vals(run("M-048", [line]), aspect=None) == [(count, None)]


@pytest.mark.l6_adversarial
def test_m048_number_words_only_whole_words():
    # «двухмаршевая» — не «два»; «две ступени очистки» — другой смысл
    assert vals(run("M-048", ["Лестница двухмаршевая"]), aspect=None) == []
    assert vals(run("M-048", ["Фильтр — две ступени очистки"]), aspect=None) == []


@pytest.mark.l1_functional
@pytest.mark.parametrize("sep", ["×", "x", "х", "*"])
def test_m048_pair_any_separator_and_ocr_zero(sep):
    ms = run("M-048", [f"Ступ. 16O{sep}29O"])
    assert sorted((e.meta["aspect"], e.value_num) for e in ms) == [("riser", 160.0), ("tread", 290.0)]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "line",
    ["Ступени: проступь × подступенок = 290 × 160 мм", "Ступени: подступенок × проступь = 160 × 290 мм"],
)
def test_m048_labelled_pair_either_order(line):
    ms = run("M-048", [line])
    assert sorted((e.meta["aspect"], e.value_num, e.meta["excluded"]) for e in ms) == [("riser", 160.0, None), ("tread", 290.0, None)]


@pytest.mark.l1_functional
def test_m048_h_b_and_comma_ends_value():
    ms = run("M-048", ["Марш: h=160 мм, b=290 мм, 11 ступеней"])
    assert sorted((e.meta["aspect"] or "", e.value_num, e.meta["excluded"]) for e in ms) == [("", 11.0, None), ("riser", 160.0, None), ("tread", 290.0, None)]
    # «h=2700» — высота этажа, не подступенок
    assert vals(run("M-048", ["Этаж h=2700"]), aspect="riser") == [(2700.0, "IMPLAUSIBLE")]


@pytest.mark.l6_adversarial
def test_m048_porch_steps_are_other_element():
    ms = run("M-048", ["Крыльцо: 4 ступени 150х350"])
    assert ms and all(e.meta["excluded"] == "OTHER_STAIR" for e in ms)


# ------------------------------------------------------------------ запись изменения: «было» отменено, «стало» действует


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("Изм. 1. Марш ЛМ-2: было 12 ступеней, стало 11 ступеней", [(12.0, "CHANGE_NOTE"), (11.0, None)]),
        ("Изм. 2: было двенадцать ступеней, стало одиннадцать ступеней", [(12.0, "CHANGE_NOTE"), (11.0, None)]),
        ("Количество ступеней было 14, стало 12", [(14.0, "CHANGE_NOTE")]),
        ("Марш: 11 ступеней (было 12)", [(11.0, None)]),
        ("Было 12 ступ. Стало 11 ступ.", [(12.0, "CHANGE_NOTE"), (11.0, None)]),
    ],
)
def test_m048_change_note_was_value_dropped_on_every_path(line, expected):
    assert vals(run("M-048", [line]), aspect=None) == expected


@pytest.mark.l6_adversarial
def test_m048_change_note_on_aspects_and_pairs():
    ms = run("M-048", ["Изм. 3: было — ступени 170х280; стало — ступени 150х300"])
    assert sorted((e.meta["aspect"], e.value_num, e.meta["excluded"]) for e in ms) == [
        ("riser", 150.0, None),
        ("riser", 170.0, "CHANGE_NOTE"),
        ("tread", 280.0, "CHANGE_NOTE"),
        ("tread", 300.0, None),
    ]
    assert vals(run("M-048", ["Высота подступенка было 170 мм"]), aspect="riser") == [(170.0, "CHANGE_NOTE")]
    # «уточнённое значение» — действующее, не отсев
    assert vals(run("M-048", ["Уточнённая высота подступенка 160 мм"]), aspect="riser") == [(160.0, None)]


# ------------------------------------------------------------------ OWASP W3-01, W3-05: время и переполнение


def _best_of_3(fn) -> float:
    import time

    best = float("inf")
    for _ in range(3):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


@pytest.mark.l4_fault
@pytest.mark.performance
def test_ocr_digit_normalization_is_linear():
    from inspector_ml.quantity_mentions import _normalize

    cfg = {"ocr_digits": True}
    small = "1" + "о" * 1_000
    big = "1" + "о" * 10_000
    assert _normalize(big, cfg) == "1" + "0" * 10_000
    # 10× длиннее — не больше 30× дольше (линейно, с запасом на шум), и само по себе быстро
    t_small, t_big = _best_of_3(lambda: _normalize(small, cfg)), _best_of_3(lambda: _normalize(big, cfg))
    assert t_big < 0.05 and t_big < 30 * max(t_small, 1e-4)
    # отказ рядом: буква «о» не у цифры — не трогается
    assert _normalize("Стоимость 10 ор", cfg) == "Стоимость 10 ор"


@pytest.mark.l4_fault
def test_huge_number_does_not_crash_table_or_inline():
    huge = "9" * 400
    ms = run("M-048", ["Марка | Кол-во ступ. | Подступенок, мм", f"ЛМ-1 | {huge} | 160"])
    assert all(e.value_num is None or e.value_num < 1e15 for e in ms)
    assert vals(ms, aspect="riser") == [(160.0, None)]
    assert vals(run("M-048", [f"Количество ступеней {huge}"]), aspect=None) == []
    assert run("M-033", [f"Уклон проезда {huge} ‰"]) == []


def test_bbox_covers_value_with_its_unit():
    """T-233: единица сразу за числом — часть значения: рамка «20 ‰», а не «20» (инспектор видит запись целиком)."""
    e = one("M-033", "Продольный уклон проездов 20 ‰")
    words = {w.text: w.bbox for w in mk_page(1, ["Продольный уклон проездов 20 ‰"]).lines[0].words}
    assert e.bbox[0] == pytest.approx(words["20"][0]) and e.bbox[2] == pytest.approx(words["‰"][2])
    assert e.raw == "20"  # сырое значение — число без единицы, как прежде
