"""Показатель степени единицы, отвалившийся в отдельное число (OS-INSP-2.2.31, T-135; находка учителя T-076 на «Алтуфьевском 79Б»,
ПЗ стр. 10, таблица ТЭП): «Площадь застройки объекта 2 3009.4» — «м²» дал в текстовом слое одиночное «2», и значение
бралось 2 вместо 3009,4. У М-001…М-005 значение берёт путь количества по паспорту (T-132, OS-INSP-2.2.23),
правило — для остальных параметров в м²/м³ (М-006, М-024…М-028, …) и колонки единицы в таблицах. Синтетика; строки повторяют раскладку реального листа (обезличено).

Эшелоны: L1 (правило), L3 (границы: «2» без числа правее, единица не м²/м³, «2» не сразу после подписи), L8 (регрессия листа)."""

from __future__ import annotations

import pytest

from inspector_ml import tables as T
from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

AREA = ParamSpec(
    code="M-025", anchors=["Общая площадь здания"], data_type="number", unit="м²"
)
VOL = ParamSpec(
    code="M-006", anchors=["Строительный объем"], data_type="number", unit="м³"
)
FLOORS = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number", unit="шт.")


def doc(*lines: str) -> ParsedDoc:
    ls = [
        Line(
            text=t,
            words=[
                Word(
                    text=w,
                    bbox=(
                        0.1 + 0.02 * i,
                        0.1 + 0.03 * n,
                        0.12 + 0.02 * i,
                        0.12 + 0.03 * n,
                    ),
                )
                for i, w in enumerate(t.split())
            ],
        )
        for n, t in enumerate(lines)
    ]
    return ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=10, width=595, height=842, source="text", lines=ls)],
    )


def value(spec, *lines):
    out = [e for e in extract(doc(*lines), [spec]) if e.code == spec.code]
    return out[0].value_num if out else None


@pytest.mark.l8_regression
def test_altufyevo_tep_superscript_split_from_unit():
    assert value(AREA, "Общая площадь здания, в т.ч.: 2 5825.8") == 5825.8
    assert value(VOL, "Строительный объем зданий, в т.ч.: 3 37 076,0") == 37076.0


@pytest.mark.l1_functional
def test_power_mark_only_for_area_and_volume_units():
    assert value(FLOORS, "Этажность шт 2") == 2, (
        "у этажности «2» — значение, а не показатель степени"
    )
    assert value(FLOORS, "Этажность 2 3") == 2, "единица не м²/м³ — первое число"


@pytest.mark.l3_boundary
def test_lone_mark_without_following_number_is_value():
    assert value(AREA, "Общая площадь здания 2") == 2, (
        "правее числа нет — «2» и есть значение (не выдумываем)"
    )
    assert value(VOL, "Строительный объем 3 м3") == 3
    assert value(AREA, "Общая площадь здания 25 3009.4") == 25, (
        "не одиночная цифра — не показатель степени"
    )
    assert value(AREA, "Общая площадь здания 3 3009.4") == 3, (
        "у площади показатель — «2», «3» — это значение"
    )


@pytest.mark.l1_functional
def test_table_unit_column_lone_digit_is_square_or_cubic_meter():
    assert T.column_unit("2") == "м²"
    assert T.column_unit("3") == "м³"
    assert T.column_unit("м2") == "м²"
    assert T.column_unit("шт") == "шт"
    assert T.column_unit("") is None
