"""T-233: число из обозначения — не значение объекта. Случаи — ложные выводы полного прогона Полярной 17, проверенные
глазами на страницах-источниках: М-041 «ширина двери 7,1313 м» из «СП 7.13130.2013», М-040 «коридор 2000» из
«Усилитель ЮРМ 2000», М-058 «плита 2,5» из «шагом 2,5…6,0 м»."""

from __future__ import annotations

import pytest

from inspector_ml.quantity_mentions import _designation, _read_value

CFG = {
    "units": ["м", "мм", "кв.м"],
    "superscripts": ["2", "3"],
    "fillers": ["не", "менее", "шагом"],
    "stop": [],
    "exclude": [],
}


def first_value(text: str) -> str | None:
    got = _read_value(text, 0, len(text), CFG)
    return got[0][0][0] if got else None


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "text",
    [
        " в соответствии с требованиями п.7.8 СП 7.13130.2013.",
        " ГОСТ 21.101-2020 ",
        " Усилитель ЮРМ 2000",
        " шагом 2,5…6,0 м",
        " шагом 2,5 – 3,0 м",
    ],
)
def test_designation_is_not_a_value(text):
    assert first_value(text) is None


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "text,want",
    [
        (" 943.0 кв.м", "943.0"),  # ТЭП участка: площадь застройки
        (" 1,2 м", "1,2"),
        (" не менее 0,9 м", "0,9"),
        (" 2000 мм", "2000"),  # толщина 2000 мм без марки перед ней — значение
    ],
)
def test_plain_value_kept(text, want):
    assert first_value(text) == want


@pytest.mark.l1_functional
def test_small_integer_after_caps_is_not_model():
    """«секция ОК 2»: малое целое после заглавного слова — номер, не марка оборудования (порог MODEL_MIN)."""
    assert _designation("ОК 2", 3, 4, "2") is False
    assert _designation("ЮРМ 2000", 4, 8, "2000") is True


def test_anchor_caps_do_not_hide_value_but_tail_model_still_does():
    text = "КИТ 240 мм"
    assert _read_value(text, 3, len(text), CFG)[0][0][0] == "240"
    text = "Ширина ЮРМ 2000 мм"
    assert _read_value(text, 6, len(text), CFG) is None
