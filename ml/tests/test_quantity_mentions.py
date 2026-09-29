"""OS-INSP-2.2.22–2.2.25 (T-132): упоминания количественного показателя по паспорту — М-001 «Площадь застройки».

Только синтетические строки (ADR-0002). Формы строк повторяют ловушки текстового слоя, найденные на пакетах корпуса:
верхний индекс м² отдельной цифрой, номер следующей строки таблицы, «до/после реконструкции», две колонки подряд,
число, приклеенное к единице, шапка ведомости, разбитая по ячейкам. Конфигурация — из паспорта M-001.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.extract import EXTRACT_REV, extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.quantity_mentions import (
    extract_quantity_mentions,
    is_quantity_mentions,
    to_number,
)

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
PASSPORT = json.loads((ROOT / "data/seed/passports/M-001.json").read_text("utf-8"))


def spec() -> ParamSpec:
    return ParamSpec(
        code="M-001",
        anchors=["Площадь застройки"],
        data_type="number",
        extractor=PASSPORT["extractor"],
    )


def mk_page(
    lines: list[str],
    n: int = 1,
    source: str = "text",
    disputed: frozenset[str] = frozenset(),
) -> Page:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = 0.05 + 0.03 * li
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.02),
                    disputed=t in disputed,
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return Page(
        page=n,
        width=595,
        height=842,
        source=source,
        ocr_confidence=80 if source == "ocr" else None,
        lines=out,
    )


def mk_doc(*pages: list[str] | Page) -> ParsedDoc:
    ps = [p if isinstance(p, Page) else mk_page(p, i + 1) for i, p in enumerate(pages)]
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=ps)


def found(*lines: str) -> list[tuple[float | None, str | None]]:
    return [
        (e.value_num, e.meta["excluded"])
        for e in extract_quantity_mentions(mk_doc(list(lines)), spec())
    ]


@pytest.mark.l1_functional
def test_superscript_of_unit_before_value_is_not_the_value():
    # «Площадь застройки объекта 2 3009.4 м» — «2» это м², а не площадь (в интерфейсе стояло «2», T-132)
    assert found(
        "Площадь застройки объекта 2 3009.4 м", "Суммарная поэтажная площадь 2 6016,5 м"
    ) == [(3009.4, None)]


@pytest.mark.l1_functional
def test_superscript_after_value_and_next_row_number_ignored():
    assert found("Площадь застройки 3009,4 2 м Строительный объем 37076,0 3 м") == [
        (3009.4, None)
    ]
    assert found(
        "3 Площадь застройки (после реконструкции) м2 2909,5 4 Процент застройки % 31"
    ) == [(2909.5, None)]


@pytest.mark.l1_functional
def test_existing_state_excluded_with_reason_and_does_not_leak_to_next_row():
    got = found(
        "2 Площадь застройки (до реконструкции) м2 1562,6 Взам. 3 Площадь застройки (после реконструкции) м2 2909,5"
    )
    assert got == [(1562.6, "EXISTING"), (2909.5, None)]
    ex = extract_quantity_mentions(
        mk_doc(["Площадь застройки существующего здания 812,0 м2"]), spec()
    )[0]
    assert ex.meta["excluded"] == "EXISTING" and "существующ" in ex.meta["excluded_why"]


@pytest.mark.l1_functional
def test_two_values_in_a_row_are_columns_not_a_value():
    ex = extract_quantity_mentions(
        mk_doc(["3 Площадь застройки 2362,5 3009.4 32 блочная канализация"]), spec()
    )
    assert [(e.meta["excluded"], e.meta["values"]) for e in ex] == [
        ("MULTI_VALUE", [2362.5, 3009.4])
    ]


@pytest.mark.l1_functional
def test_value_glued_to_unit_and_short_qualifier_before_value():
    assert found("Площадь застройки 943,0м2 3 Количество этажей 11") == [(943.0, None)]
    assert found(
        "2. Площадь застройки кв.м. Жилого корпуса 943.0 4. Площадь твердых покрытий"
    ) == [(943.0, None)]
    # длинное уточнение — уже другой показатель («…подземной части, выходящей за абрис проекции здания 2226,0»)
    assert (
        found(
            "Площадь застройки подземной части, выходящей за абрис проекции здания 2226,0м2"
        )
        == []
    )


@pytest.mark.l1_functional
def test_not_a_mention_same_root_other_meaning():
    assert found("гидрогеологического режима на площадке застройки 12 м") == []
    assert found("Процент застройки 31 %") == []
    # «;» — конец фразы: число дальше — номер пункта, а не значение
    assert found("произвести их вынос из пятна застройки; 3. Заключить договор") == []
    assert found("Площадь застройки определяется по СП 54.13330") == []


@pytest.mark.l1_functional
def test_every_mention_kept_with_page_quote_bbox_and_source():
    doc = mk_doc(
        ["Площадь застройки 3009,40"],
        ["Таблица ТЭП", "Площадь застройки объекта 2 3009.4 м"],
    )
    ex = extract_quantity_mentions(doc, spec())
    assert [(e.page, e.value_num) for e in ex] == [(1, 3009.4), (2, 3009.4)]
    for e in ex:
        assert e.bbox is not None and "Площадь застройки" in e.meta["quote"]
        assert e.meta["text_source"] == "pdf-text" and "ENT-15" in e.meta["ops"]
    assert ex[0].raw == "3009,40"


@pytest.mark.l1_functional
def test_number_normalization():
    assert to_number("3 009,40") == 3009.4
    assert to_number("943.0") == 943.0
    assert found("Площадь застройки 1 471,13 м2") == [(1471.13, None)]


def column_page() -> Page:
    """Шапка ведомости зданий генплана: «Площадь, м²» над «застройки», значение — строкой ниже в той же колонке."""
    W = lambda t, x, y: Word(text=t, bbox=(x, y, x + 0.02, y + 0.008))  # noqa: E731
    rows = [
        [W("ВЕДОМОСТЬ", 0.445, 0.020), W("ЗДАНИЙ", 0.569, 0.020)],
        [W("Площадь,", 0.576, 0.044), W("Количество", 0.501, 0.044)],
        [W("застройки", 0.553, 0.067), W("квартир", 0.513, 0.067)],
        [
            W("1", 0.396, 0.114),
            W("Жилое", 0.407, 0.113),
            W("здание,", 0.425, 0.113),
            W("корпус", 0.447, 0.114),
            W("17", 0.467, 0.113),
            W("13,20", 0.476, 0.113),
            W("248", 0.511, 0.114),
        ],
        [W("1471,13", 0.546, 0.123), W("22141,82", 0.594, 0.123)],
    ]
    return Page(
        page=3,
        width=2384,
        height=1684,
        source="text",
        lines=[Line(text=" ".join(w.text for w in r), words=r) for r in rows],
    )


@pytest.mark.l1_functional
def test_table_column_under_split_header():
    ex = extract_quantity_mentions(
        ParsedDoc(sha256="1" * 64, kind="pdf", engine="pdfium", pages=[column_page()]),
        spec(),
    )
    assert [(e.page, e.value_num, e.meta["table"]) for e in ex] == [
        (3, 1471.13, "column")
    ]
    assert (
        "Жилое здание, корпус 17" in ex[0].meta["quote"]
        and "13,20" not in ex[0].meta["quote"]
    )
    assert ex[0].bbox[1] == pytest.approx(0.123)


@pytest.mark.l1_functional
def test_column_header_without_area_above_is_ignored():
    p = column_page()
    p.lines = [ln for ln in p.lines if not ln.text.startswith("Площадь")]
    assert (
        extract_quantity_mentions(
            ParsedDoc(sha256="1" * 64, kind="pdf", engine="pdfium", pages=[p]), spec()
        )
        == []
    )


@pytest.mark.l1_functional
def test_disputed_ocr_word_lowers_confidence():
    doc = mk_doc(
        mk_page(
            ["Площадь застройки 3009,4 м2"],
            source="ocr",
            disputed=frozenset({"3009,4"}),
        )
    )
    (e,) = extract_quantity_mentions(doc, spec())
    assert (
        e.confidence == pytest.approx(0.8 * 0.6) and e.meta["text_source"] == "scan-ocr"
    )


@pytest.mark.l8_regression
def test_extract_routes_passport_param_and_bumps_revision():
    sp = spec()
    assert is_quantity_mentions(sp) and EXTRACT_REV >= 8
    other = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    out = extract(
        mk_doc(["Площадь застройки объекта 2 3009.4 м", "Этажность 5"]), [sp, other]
    )
    m001 = [e for e in out if e.code == "M-001"]
    assert [(e.value_num, e.meta is not None) for e in m001] == [(3009.4, True)]
    assert [e.value_num for e in out if e.code == "M-007"] == [5.0]


@pytest.mark.l8_regression
def test_scan_reader_stages_take_only_class_passports():
    # этапы читателей сканов (T-130) строят спецификации из всех паспортов: количественный паспорт М-001 без поля
    # value в экстракторе уронил бы extract_class_mentions — в этапы он попадать не должен
    from inspector_ml.stages import class_specs

    codes = [s.code for s in class_specs(ROOT / "data/seed/passports")]
    assert "M-001" not in codes and "M-023" in codes


def spec_of(code: str) -> ParamSpec:
    pp = json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))
    return ParamSpec(code=code, anchors=[pp["title"]], data_type="number", extractor=pp["extractor"])


def found_by(code: str, *lines: str) -> list[tuple[float | None, str | None]]:
    return [(e.value_num, e.meta["excluded"]) for e in extract_quantity_mentions(mk_doc(list(lines)), spec_of(code))]


@pytest.mark.l1_functional
def test_m002_total_area_repeated_in_next_column_and_change_note():
    # «всего» и «наземная часть» с тем же значением — не колонки с разными значениями
    assert found_by("M-002", "Общая площадь объекта, в т.ч.: 2 5825.8 м 2 5825,8 - наземная часть м") == [(5825.8, None)]
    assert found_by("M-002", "показателях – общая площадь здания: было 11744,50м2, стало 11691,90м2.") == [(11744.5, "CHANGE_NOTE")]
    assert found_by("M-002", "Общая площадь квартир 5592,0 м2") == []


@pytest.mark.l1_functional
def test_constraint_from_norm_is_not_object_value():
    # «не более 35000 м3», «объемом до 35000 м3» — ограничение из норм, а не объём здания
    assert found_by("M-004", "Строительный объем здания не более 35000 м3 степень огнестойкости") == []
    assert found_by("M-004", "Общий строительный объем зданий, в т.ч.: 3 37 076,0 м 3 37 076,0 - наземная часть м") == [(37076.0, None)]
    assert found_by("M-004", "8 Строительный объем здания выше отм. +0.000 м3 34754") == [(0.0, "ABOVE_GROUND")]
    assert found_by("M-003", "на 1 м2 расчетной площади где общественного здания ( Aр ), 2 Вт/ м") == []


@pytest.mark.l1_functional
def test_m005_underground_volume_only_right_after_its_label():
    line = "Строительный объём 47374,10м³ в том числе: 7 подземной части 14945,60м³ наземной части 32428,5м³"
    assert found_by("M-005", line) == [(14945.6, None)]
    assert found_by("M-004", line) == [(47374.1, None)]
    # площадь подземной части — не объём: «площадь» между оборотами обрывает связь
    assert found_by("M-005", "Строительный объем 37076,0 3 м Общая площадь здания 5825.8 2 м -подземная часть 0") == []
    # между «подземной частью» и числом — другая строка таблицы: значение не берётся
    assert found_by("M-005", "Общий строительный объем, в т.ч.: 3 0 - подземная часть м Верхняя отметка 12,5") == []


@pytest.mark.l1_functional
def test_column_value_in_merged_cell_names_every_row():
    # ГП1 «Полярная 17»: ячейка площади объединяет строки «Жилое здание» и «Пандус въезда-выезда» (перенос подписи
    # на вторую строку с номером позиции); счётчики правее этажности — не подпись
    W = lambda t, x, y: Word(text=t, bbox=(x, y, x + 0.02, y + 0.008))  # noqa: E731
    p = column_page()
    p.lines += [
        Line(text="Пандус въезда-выезда в", words=[W("Пандус", 0.407, 0.128), W("въезда-выезда", 0.425, 0.128), W("в", 0.46, 0.128)]),
        Line(text="2 подземную автостоянку 1 1", words=[W("2", 0.396, 0.135), W("подземную", 0.407, 0.135), W("автостоянку", 0.43, 0.135), W("1", 0.498, 0.135), W("1", 0.511, 0.135)]),
    ]
    (e,) = extract_quantity_mentions(ParsedDoc(sha256="1" * 64, kind="pdf", engine="pdfium", pages=[p]), spec())
    assert e.meta["rows"] == ["1 Жилое здание, корпус 17", "Пандус въезда-выезда в подземную автостоянку"]
    assert "объединённая ячейка" in e.meta["quote"]


def _W(t: str, x: float, y: float, disputed: bool = False) -> Word:
    return Word(text=t, bbox=(x, y, x + 0.02, y + 0.008), disputed=disputed)


def col_page(value_xy=(0.546, 0.123), over_xy=(0.576, 0.044), head_xy=(0.553, 0.067), label=("Жилое", "здание"), source="text", disputed=False) -> Page:
    rows = [
        [_W("Площадь,", *over_xy)],
        [_W("застройки", *head_xy)],
        [_W(label[0], 0.407, value_xy[1] - 0.01), _W(label[1], 0.425, value_xy[1] - 0.01), _W("13,20", 0.476, value_xy[1] - 0.01)],
        [_W("1471,13", *value_xy, disputed=disputed)],
    ]
    return Page(page=3, width=2384, height=1684, source=source, ocr_confidence=70 if source == "ocr" else None, lines=[Line(text=" ".join(w.text for w in r), words=r) for r in rows])


def col(page: Page, sp: ParamSpec | None = None):
    return extract_quantity_mentions(ParsedDoc(sha256="2" * 64, kind="pdf", engine="pdfium", pages=[page]), sp or spec())


@pytest.mark.l3_boundary
def test_column_geometry_boundaries():
    assert [e.value_num for e in col(col_page())] == [1471.13]
    # «Площадь» выше «застройки» больше чем на 4 % высоты — не одна шапка
    assert col(col_page(over_xy=(0.576, 0.010))) == []
    # «Площадь» сбоку дальше чем на 5 % ширины — не шапка этой колонки
    assert col(col_page(over_xy=(0.70, 0.044))) == []
    # значение в соседней колонке (дальше 3 % ширины) и ниже шапки больше 12 % высоты — не значение
    assert col(col_page(value_xy=(0.62, 0.123))) == []
    assert col(col_page(value_xy=(0.546, 0.30))) == []
    # значение выше заголовка — не значение колонки
    assert col(col_page(value_xy=(0.546, 0.050))) == []


@pytest.mark.l1_functional
def test_column_mention_fields_bbox_anchor_confidence_source():
    (e,) = col(col_page())
    assert e.raw == "1471,13" and e.page == 3
    assert e.bbox == pytest.approx((0.546, 0.123, 0.566, 0.131))
    assert e.anchor_bbox is not None and e.anchor_bbox[1] == pytest.approx(0.044)
    assert e.confidence == pytest.approx(0.9)
    assert e.meta["text_source"] == "pdf-text" and e.meta["table"] == "column" and e.meta["values"] == [1471.13]
    assert e.meta["quote"] == "Площадь, застройки: 1471,13 — строка «Жилое здание»"
    assert e.meta["excluded"] is None and e.meta["qualifier"] is None and "ENT-15" in e.meta["ops"]
    (o,) = col(col_page(source="ocr", disputed=True))
    assert o.meta["text_source"] == "scan-ocr"
    assert o.confidence == pytest.approx(0.9 * 0.7 * 0.6)


@pytest.mark.l1_functional
def test_column_row_label_can_exclude_existing_building():
    (e,) = col(col_page(label=("Существующее", "здание")))
    assert e.meta["excluded"] == "EXISTING"


@pytest.mark.l1_functional
def test_column_value_already_found_inline_is_not_duplicated():
    p = col_page()
    # та же строка ТЭП оборотом: «Площадь застройки 1471,13» в тех же координатах, что и значение колонки
    p.lines.append(Line(text="Площадь застройки 1471,13", words=[_W("Площадь", 0.40, 0.123), _W("застройки", 0.43, 0.123), _W("1471,13", 0.546, 0.123)]))
    got = col(p)
    assert len([e for e in got if e.value_num == 1471.13]) == 1


@pytest.mark.l1_functional
def test_no_column_config_means_inline_only():
    sp = ParamSpec(code="M-001", anchors=["x"], data_type="number", extractor={k: v for k, v in PASSPORT["extractor"].items() if k != "column"})
    assert col(col_page(), sp) == []


@pytest.mark.l3_boundary
def test_row_number_and_superscript_boundaries():
    # номер строки — целое меньше 100; 100 и дробное — уже второе значение (колонки)
    assert found("Площадь застройки 2909,5 99 Процент") == [(2909.5, None)]
    assert found("Площадь застройки 2909,5 100 Процент")[0][1] == "MULTI_VALUE"
    assert found("Площадь застройки 2909,5 4,5 Процент")[0][1] == "MULTI_VALUE"
    # одиночная «2» без следующего числа — это значение, а не индекс
    assert found("Площадь застройки 2 м2") == [(2.0, None)]
    # «3» не индекс для площади (паспорт М-001 — только «2»)
    assert found("Площадь застройки 3 3009,4") [0][1] == "MULTI_VALUE"


@pytest.mark.l1_functional
def test_window_and_next_anchor_limits():
    far = "Площадь застройки" + " —" * 50 + " 3009,4"
    assert found(far) == []  # значение дальше окна 80 знаков
    # значение следующего оборота — не наше
    assert found("Площадь застройки Площадь застройки 3009,4") == [(3009.4, None)]


@pytest.mark.l1_functional
def test_excluded_rule_scope_between_only_checks_anchor_to_value():
    got = found_by("M-004", "Строительный объем здания 37076,0 м3 надземная часть 30000,0")
    assert got == [(37076.0, None)]
