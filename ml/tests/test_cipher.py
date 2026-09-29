"""OS-INSP-2.2.6: гомоглифы в шифре исправляются по реестру и только однозначно."""

from __future__ import annotations

import pytest

from inspector_ml.cipher import canon, fix_code

REG = ["СК2-Р-АР", "СК2-ИД-ПАСП-ДВ", "ПК115-ИД-ЖБР", "СК5-ИД-ОЖР"]


@pytest.mark.l1_functional
@pytest.mark.parametrize(
    "read,want",
    [
        ("CK2-P-AP", "СК2-Р-АР"),  # латиница вместо кириллицы
        ("ПК115-ИД-ЖБР", "ПК115-ИД-ЖБР"),
        ("ПКl15-ИД-ЖБР", "ПК115-ИД-ЖБР"),  # «l» вместо «1»
        ("СК5 - ИД - ОЖР", "СК5-ИД-ОЖР"),  # пробелы вокруг дефиса
        ("ск2-ид-пасп-дв", "СК2-ИД-ПАСП-ДВ"),  # регистр
    ],
)
def test_homoglyphs_corrected_to_registry(read, want):
    f = fix_code(read, REG)
    assert f.value == want
    assert f.corrected == (read != want)
    assert f.read == read


@pytest.mark.l1_functional
def test_digit_and_letter_confusion_3_Z_0_O_6_B():
    reg = ["ОБ3-06-К"]
    assert fix_code("OБЗ-О6-K", reg).value == "ОБ3-06-К"
    assert fix_code("063-06-K", reg).value == "ОБ3-06-К"


@pytest.mark.l6_adversarial
def test_ambiguous_match_not_corrected():
    # «ЗО» и «30» неразличимы — если в реестре оба, выбирать нельзя
    f = fix_code("3O-1", ["30-1", "ЗО-1"])
    assert (f.value, f.corrected) == ("3O-1", False)


@pytest.mark.l6_adversarial
def test_real_difference_not_hidden():
    # другая цифра — не гомоглиф: СК2 ≠ СК5, исправлять нельзя
    assert fix_code("СК5-Р-АР", ["СК2-Р-АР"]) == fix_code("СК5-Р-АР", [])
    assert fix_code("СК5-Р-АР", ["СК2-Р-АР"]).corrected is False
    # лишний знак — тоже не гомоглиф
    assert fix_code("СК2-Р-АР-1", ["СК2-Р-АР"]).corrected is False


@pytest.mark.l3_boundary
def test_empty_read_and_empty_registry():
    assert fix_code("", REG).value == ""
    assert fix_code("СК2", []).corrected is False
    assert canon("  ск2 . р / ар ") == canon("СК2.Р/АР")


@pytest.mark.l1_functional
def test_multichar_zh_and_unknown_char():
    assert fix_code("PE92-P-K)K", ["РЕ92-Р-КЖ"]).value == "РЕ92-Р-КЖ"  # «Ж» прочитана как «)K»
    assert fix_code("БЕ?1-ИД-ЖБР", ["БЕ21-ИД-ЖБР", "БЕ21-Р-АР"]).value == "БЕ21-ИД-ЖБР"  # «?» — один любой знак


@pytest.mark.l6_adversarial
def test_unknown_char_ambiguous_or_wrong_length_not_corrected():
    assert fix_code("БЕ?1", ["БЕ21", "БЕ31"]).corrected is False  # «?» подходит к двум записям
    assert fix_code("БЕ?1", ["БЕ221"]).corrected is False  # «?» — ровно один знак, не два
    assert fix_code("ПГЛ1-Р-АР", ["ПГ11-Р-АР"]).corrected is False  # «Л» — настоящая буква, не гомоглиф
